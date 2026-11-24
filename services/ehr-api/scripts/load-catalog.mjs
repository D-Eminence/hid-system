#!/usr/bin/env node
// ORD-7: the governed loader of the national medicine and lab-test lists
// (planned contract, "Who keeps the lists"). It runs after the migrations,
// never inside one, as the schema owner (the same connection as
// apply-migrations.mjs). In production it runs only in the migration image,
// as the deploy tool's opt-in catalogue phase (scripts/production_deployment.py,
// CATALOG_LOAD), which carries the approvals file, the Wave 0 codes and the
// signed seed files under /app/docs/codes:
//
//   DATABASE_URL=... node scripts/load-catalog.mjs --seed <hid-medicines.json|hid-lab-tests.json>
//     [--approvals <file>, never under NODE_ENV=production] [--dry-run]
//
// It refuses (exit 2, nothing written), before it connects:
// - --approvals under NODE_ENV=production: only the deployed
//   docs/codes/catalog-approvals.json signs a load;
// - a seed, approvals or Wave 0 codes file that cannot be read or is not JSON;
// - a seed that breaks 0149's rules, an HID-LAB code that is not Wave 0's
//   with its name, or an id the seed holds back and also lists as retired
//   ("<id> is held back in this seed and also listed as retired; fix the
//   row, do not retire it") (catalog-seed.mjs's seedProblems);
// - a seed file whose sha256 is not signed off for its kind and version
//   (Q124 A: the clinical lead approves every change), or a medicine sign-off
//   without the licence answers it needs (the Nigeria EML 8th edition
//   confirmation; the WHOCC answer when the file holds ATC codes);
// and, in its transaction (catalog-load.mjs):
// - a schema without 0149 (or, for the ICD-11 diagnosis list, 0150), or a
//   version of that kind already loaded;
// - an id of the active version that the seed drops: one it holds back
//   ("<id> is in the live list but held back in this seed; fix the row, do
//   not retire it"), or one it does not list in its retired ids (medicines
//   and lab tests; a diagnosis list retires no id);
// - a lock still busy after 5 seconds ("...; run the release again at a
//   quieter time");
// - 0149's own refusals, with the database's message: a retired id, an id
//   whose medicine or test changed, a lab code another id held, a sealed
//   version (its triggers and guard, SQLSTATE 55000: CATALOG_ID_RETIRED,
//   CATALOG_ID_CHANGED, CATALOG_VERSION_SEALED), or a table check (23514);
//   for a diagnosis list, 0150's the same ways (a sealed version, a table
//   check). The whole load rolls back.
// Anything else is a failure: exit 1, one line "load-catalog: ...; nothing
// loaded", never a stack trace. That covers an error before it connects (a
// DATABASE_HOST that makes no address, a bad TLS setting), no database, and a
// connection dropped mid-load (a terminated backend, a failover: the client's
// 'error' event is listened for, so it is never an unhandled one), before the
// load's COMMIT is sent. Once COMMIT is sent, a connection lost (or a fatal
// error) before its reply may follow a commit (a backend terminated while its
// commit waits for a synchronous standby has committed locally), so the loader
// ends instead with its own exit code, 3, and the line "load-catalog: the
// connection was lost during commit, so the load may have committed; ask for
// the same load again to settle it (it loads, or is refused as already
// loaded)". Exit 3 is never "nothing loaded": the deploy tool records that
// seed's outcome as unknown from the exit code alone, before it reads the
// log, so an unreadable log cannot turn it into a plain failure. An ERROR
// reply to COMMIT means the load rolled back, so that stays a refusal or a
// failure, nothing loaded. Either way the line is the last one the loader
// prints, which the deploy tool shows.
//
// Exit codes: 0 loaded (or a dry run rolled back); 1 failed, nothing loaded;
// 2 refused, nothing loaded; 3 the connection was lost during commit, so the
// load may have committed (outcome unknown).
//
// --dry-run does all of it and rolls back. Old versions are kept, so old
// prescriptions keep their meaning. Prints one JSON line: what was loaded,
// the seed's and the approvals file's sha256, and which version it replaced.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMIT_UNKNOWN_EXIT, COMMIT_UNKNOWN_LINE, CommitOutcomeUnknown, LoadRefusal, loadSeed, prepareLoad, refusalLine,
} from './catalog-load.mjs';
import { databaseOptions, managedDatabaseUrl } from './database-options.mjs';

const codes = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/codes');
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const refuse = (refusal) => {
  console.error(refusalLine(refusal));
  process.exit(2);
};
// A failure, not a refusal: one plain line too, never a stack trace.
const fail = (error) => {
  const code = error?.code ? ` (${error.code})` : '';
  console.error(`load-catalog: ${error?.message ?? error}${code}; nothing loaded`);
  process.exit(1);
};
// COMMIT sent and no reply: the version may have committed, so never "nothing loaded", and never exit 1 (which the
// deploy tool reads as nothing loaded): exit 3, which it reads as outcome unknown without needing the log.
const unknown = () => {
  console.error(COMMIT_UNKNOWN_LINE);
  process.exit(COMMIT_UNKNOWN_EXIT);
};

let prepared;
try {
  const seedPath = option('seed');
  if (!seedPath) throw new LoadRefusal('--seed is required');
  prepared = prepareLoad({ seedPath, approvalsPath: option('approvals') ?? path.join(codes, 'catalog-approvals.json'),
    approvalsGiven: process.argv.includes('--approvals'), waveZeroPath: path.join(codes, 'hid-lab-codes.json') });
} catch (error) {
  if (error instanceof LoadRefusal) refuse(error);
  fail(error);
}
let client;
let lost;
let outcome;
try {
  let databaseUrl;
  try {
    databaseUrl = process.env.DATABASE_URL || managedDatabaseUrl();
  } catch (error) {
    throw Object.assign(new Error(`DATABASE_HOST does not make a database address: ${error?.message ?? error}`),
      { code: error?.code });
  }
  if (!databaseUrl) throw new LoadRefusal('set DATABASE_URL or DATABASE_HOST, DATABASE_USERNAME and DATABASE_PASSWORD');
  const { default: pg } = await import('pg');
  client = new pg.Client(databaseOptions(databaseUrl, 'hid-catalog-loader'));
  // A connection that drops (a terminated backend, a failover) is also an 'error' event on the client, which with no
  // listener ends Node with "Unhandled 'error' event" and a stack trace. Keep it: the statement in hand, or the next
  // one, fails, so a load cut off before its commit leaves nothing, and the loader ends with its one line. Cut off
  // once its COMMIT is sent, loadSeed throws CommitOutcomeUnknown instead.
  client.on('error', (error) => { lost ??= error; });
  await client.connect();
  outcome = await loadSeed(client, { ...prepared, dryRun: process.argv.includes('--dry-run') });
} catch (error) {
  await client?.end().catch(() => {});
  if (error instanceof LoadRefusal) refuse(error);
  if (error instanceof CommitOutcomeUnknown) unknown();
  // The server's own message (with its SQLSTATE, such as 57P01 for a terminated backend) says most; a statement that
  // failed only because the connection was already gone says less than the error that dropped it.
  fail((error?.code || !lost) ? error : lost);
}
await client.end();
console.log(JSON.stringify(outcome));
