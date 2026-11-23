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
// - a seed that breaks 0149's rules, or an HID-LAB code that is not Wave 0's
//   with its name (catalog-seed.mjs's seedProblems);
// - a seed file whose sha256 is not signed off for its kind and version
//   (Q124 A: the clinical lead approves every change), or a medicine sign-off
//   without the licence answers it needs (the Nigeria EML 8th edition
//   confirmation; the WHOCC answer when the file holds ATC codes);
// and, in its transaction (catalog-load.mjs):
// - a schema without 0149, or a version of that kind already loaded;
// - an id of the active version that the seed drops: one it holds back
//   ("<id> is in the live list but held back in this seed; fix the row, do
//   not retire it"), or one it does not list in its retired ids;
// - a lock still busy after 5 seconds ("...; run the release again at a
//   quieter time");
// - 0149's own refusals, with the database's message: a retired id, an id
//   whose medicine or test changed, a lab code another id held, a sealed
//   version (its triggers and guard, SQLSTATE 55000: CATALOG_ID_RETIRED,
//   CATALOG_ID_CHANGED, CATALOG_VERSION_SEALED), or a table check (23514).
//   The whole load rolls back.
// Anything else (no database, a dropped connection) is a failure: exit 1,
// one line "load-catalog: ...; nothing loaded". Either way the line is the
// last one the loader prints, which the deploy tool shows.
//
// --dry-run does all of it and rolls back. Old versions are kept, so old
// prescriptions keep their meaning. Prints one JSON line: what was loaded,
// the seed's and the approvals file's sha256, and which version it replaced.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoadRefusal, loadSeed, prepareLoad, refusalLine } from './catalog-load.mjs';
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
const databaseUrl = process.env.DATABASE_URL || managedDatabaseUrl();
if (!databaseUrl) refuse(new LoadRefusal('set DATABASE_URL or DATABASE_HOST, DATABASE_USERNAME and DATABASE_PASSWORD'));

const { default: pg } = await import('pg');
let client;
let outcome;
try {
  client = new pg.Client(databaseOptions(databaseUrl, 'hid-catalog-loader'));
  await client.connect();
  outcome = await loadSeed(client, { ...prepared, dryRun: process.argv.includes('--dry-run') });
} catch (error) {
  await client?.end().catch(() => {});
  if (error instanceof LoadRefusal) refuse(error);
  fail(error);
}
await client.end();
console.log(JSON.stringify(outcome));
