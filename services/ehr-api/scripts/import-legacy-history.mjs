#!/usr/bin/env node
// Imports the legacy medical history (owner decision 3 of 2026-10-16,
// ADR-065) from main's sealed staging pipeline, through
// ehr.import_legacy_medical_history and nothing else:
//
//   1. stage-legacy-identity.mjs, promote-legacy-identity.mjs and
//      reconcile-legacy-identity.mjs stage, promote and verify the legacy
//      identity source (the parent run, MIGRATION_PARENT_RUN_ID);
//   2. stage-legacy-identity.mjs --scope=imported-history seals the legacy
//      medical history of the same source snapshot in its own run
//      (MIGRATION_HISTORY_RUN_ID);
//   3. this command checks both runs and every row against its seal and the
//      parent's identity rows, then runs the import as hid_migration_admin:
//      a dry run that rolls back (the default) or, with --apply, a commit.
//
// It runs on staging, or on an owned disposable rehearsal database, never in
// production, and only after the DPO and the owner have signed off the import
// (release checklist P36). It prints counts and the receipt id only: never an
// identifier of a patient, a record or any content. Synthetic fixtures only
// in every test and rehearsal.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';
import { IMPORTED_HISTORY_ENTITY_TYPES, ImportRefusal, prepareImportedHistory, withImportTransaction }
  from './imported-history-import.mjs';

const { Client } = pg;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATIONS = ['medical-records'];
const PARENT_IDENTITY_TYPES = ['accounts', 'user_profiles', 'patients', 'staff'];

/** Staging, or an owned disposable rehearsal (NODE_ENV test on a local Unix-socket cluster). */
function requireStagingOrRehearsal() {
  const deployment = process.env.HID_DEPLOYMENT_ENV ?? '';
  if (deployment === 'production') throw new Error('The legacy history import is refused in production (ADR-065)');
  if (deployment === 'staging') return;
  let socket;
  try {
    socket = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).searchParams.get('host') : null;
  } catch {
    socket = null;
  }
  if (deployment === '' && process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/')) return;
  throw new Error('The legacy history import runs only on staging or an owned rehearsal database');
}

function parseArguments(argv) {
  let operation;
  let apply = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--operation') {
      operation = argv[index + 1];
      index += 1;
    } else if (argument === '--apply') apply = true;
    else if (argument === '--dry-run') dryRun = true;
    else throw new Error('Use --operation medical-records with --dry-run or --apply only');
  }
  if (!OPERATIONS.includes(operation)) throw new Error('--operation must be medical-records');
  if (apply && dryRun) throw new Error('Choose --dry-run or --apply, not both');
  return { operation, apply };
}

function configuration() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (the migration administrator)');
  const parentRunId = process.env.MIGRATION_PARENT_RUN_ID ?? '';
  const historyRunId = process.env.MIGRATION_HISTORY_RUN_ID ?? '';
  if (!UUID.test(parentRunId)) throw new Error('MIGRATION_PARENT_RUN_ID must be the verified legacy identity run id');
  if (!UUID.test(historyRunId) || historyRunId === parentRunId) {
    throw new Error('MIGRATION_HISTORY_RUN_ID must be the sealed history staging run id');
  }
  const parentChecksum = (process.env.MIGRATION_PARENT_SOURCE_CHECKSUM ?? '').trim();
  if (!/^[0-9a-f]{64}$/.test(parentChecksum)) {
    throw new Error('MIGRATION_PARENT_SOURCE_CHECKSUM must be the parent run\'s sealed source checksum');
  }
  const operator = (process.env.MIGRATION_OPERATOR ?? '').trim();
  if (operator.length < 3 || operator.length > 200) throw new Error('MIGRATION_OPERATOR is required');
  return { databaseUrl, parentRunId, historyRunId, parentChecksum, operator };
}

async function readRun(client, id) {
  return (await client.query(`select run.id, run.source_system, run.source_snapshot, run.mode, run.status,
      run.source_counts, trim(run.source_checksum_sha256) as source_checksum_sha256,
      (select count(*)::int from migration.conflicts conflict where conflict.run_id = run.id) as conflicts
    from migration.runs run where run.id = $1`, [id])).rows[0];
}

async function main() {
  requireStagingOrRehearsal();
  const { operation, apply } = parseArguments(process.argv.slice(2));
  const { databaseUrl, parentRunId, historyRunId, parentChecksum, operator } = configuration();
  const client = new Client(databaseOptions(databaseUrl, 'hid-legacy-history-import'));
  await client.connect();
  try {
    const parent = await readRun(client, parentRunId);
    const history = await readRun(client, historyRunId);
    const parentRows = (await client.query(`select entity_type, source_pk, payload from migration.source_rows
      where run_id = $1 and entity_type = any($2::text[]) order by entity_type, source_pk`,
    [parentRunId, PARENT_IDENTITY_TYPES])).rows;
    const historyRows = (await client.query(`select entity_type, source_pk, payload, trim(payload_sha256) as payload_sha256
      from migration.source_rows where run_id = $1 order by entity_type, source_pk`, [historyRunId])).rows;
    const prepared = prepareImportedHistory({ parent, history, parentChecksum, parentRows, historyRows });
    const result = await withImportTransaction(client, { apply }, async () => (await client.query(
      'select ehr.import_legacy_medical_history($1,$2,$3,$4::jsonb) as result',
      [parentRunId, historyRunId, operator, JSON.stringify(prepared.rows)])).rows[0].result);
    const counts = Object.fromEntries(IMPORTED_HISTORY_ENTITY_TYPES.map((type) => [type, Number(result.counts[type])]));
    const inserted = Object.fromEntries(IMPORTED_HISTORY_ENTITY_TYPES.map((type) => [type, Number(result.inserted[type])]));
    process.stdout.write(`${JSON.stringify({ operation, mode: apply ? 'applied' : 'dry-run', counts, inserted,
      receipt: apply ? result.receipt : null })}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    // A refusal is its code; the command's refusal is its code too (0096
    // raises 55000 or 22023 with a code as its message); any other database
    // error is its SQLSTATE only, since its text may name a row.
    const message = typeof error?.message === 'string' ? error.message : String(error);
    const reason = error instanceof ImportRefusal ? error.code
      : /^IMPORTED_HISTORY_[A-Z_]+$/.test(message) ? message
        : typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? `database error ${error.code}`
          : message;
    process.stderr.write(`Legacy history import refused: ${reason}\n`);
    process.exitCode = 1;
  });
}
