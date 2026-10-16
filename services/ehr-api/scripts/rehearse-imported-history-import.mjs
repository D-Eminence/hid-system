#!/usr/bin/env node
// Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-065):
// the import, end to end, on an owned disposable database migrated to the
// latest migration and bootstrapped, as its migration administrator (a
// PostgreSQL superuser in the rehearsal, a NOSUPERUSER NOBYPASSRLS CREATEROLE
// administrator in scripts/verify-non-superuser-database.mjs, as on RDS).
// Synthetic fixtures only: main's stager stages a synthetic legacy identity
// source, main's promoter and reconciler verify it, the stager's
// imported-history scope stages a synthetic history of the same source
// snapshot, and the importer then runs as an operator would: a dry run that
// rolls back, an apply, a repeated apply that changes nothing, a history run
// whose record differs from the imported one (refused), and rows that differ
// from their seal (refused). Afterwards the imported tables still force
// row-level security, the administrator holds no membership in
// hid_migration_admin, and no runtime role can run the import. Prints its
// evidence as JSON.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ids, syntheticFixture } from '../../../release/migration/synthetic-fixture.mjs';
import { historyIds, identityFixtureWithProfiles, syntheticHistoryFixture } from './imported-history-fixture.mjs';
import { withImportTransaction } from './imported-history-import.mjs';

const service = resolve(import.meta.dirname, '..');
const { Client } = createRequire(join(service, 'package.json'))('pg');
const databaseUrl = process.env.DATABASE_URL;
assert(process.env.NODE_ENV === 'test' && databaseUrl, 'Only an owned disposable test database is supported');
const socket = new URL(databaseUrl).searchParams.get('host');
assert(socket?.startsWith('/tmp/'), 'Only an owned disposable Unix-socket cluster is supported');

const snapshot = 'synthetic-imported-history-v1';
const operator = 'local-synthetic-imported-history-rehearsal';
const directory = mkdtempSync(join(tmpdir(), 'hid-imported-history-'));
const evidence = { scope: 'local-synthetic-only', status: 'failed', steps: {} };

function run(label, script, environment, args = [], expected = 0) {
  const result = spawnSync(process.execPath, [join(service, 'scripts', script), ...args], {
    encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, HID_DEPLOYMENT_ENV: '', ...environment },
  });
  assert.ifError(result.error);
  if (expected === 'failure') assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  else assert.equal(result.status, expected, `${label} failed: ${(result.stderr || result.stdout || '').slice(-1800)}`);
  return result;
}

const client = new Client({ connectionString: databaseUrl, application_name: 'hid-imported-history-rehearsal' });
await client.connect();
const count = async (sql, values = []) => Number((await client.query(sql, values)).rows[0].n);
/**
 * Reads the imported tables for this rehearsal's evidence. They force
 * row-level security on their owner too, and their patient and staff policies
 * call functions no administrator may execute, so the evidence is read as the
 * importer's technical owner, whose own read policy admits every row: through
 * a SET-only membership in a transaction that is rolled back, as
 * runtime-grants.sql takes one, so none is left behind.
 */
const asImporter = async (sql, values = []) => {
  await client.query('begin');
  try {
    await client.query('grant hid_imported_history_importer to current_user with inherit false, set true');
    await client.query('set local role hid_imported_history_importer');
    return (await client.query(sql, values)).rows;
  } finally {
    await client.query('rollback');
  }
};
const importedCounts = async () => ({
  ...(await asImporter(`select (select count(*)::int from ehr.imported_medical_records) as records,
    (select count(*)::int from ehr.imported_medical_record_versions) as versions,
    (select count(*)::int from ehr.imported_medical_record_files) as files`))[0],
  receipts: await count("select count(*) n from migration.runs where source_system = 'legacy_imported_history'"),
});
const importedSnapshot = async () => ({
  ...(await asImporter(`select
    (select coalesce(md5(string_agg(to_jsonb(t)::text, ',' order by id)), '') from ehr.imported_medical_records t) records,
    (select coalesce(md5(string_agg(to_jsonb(t)::text, ',' order by id)), '') from ehr.imported_medical_record_versions t) versions,
    (select coalesce(md5(string_agg(to_jsonb(t)::text, ',' order by id)), '') from ehr.imported_medical_record_files t) files`))[0],
  receipts: (await client.query(`select coalesce(md5(string_agg(to_jsonb(t)::text, ',' order by id)), '') receipts
    from migration.runs t where source_system = 'legacy_imported_history'`)).rows[0].receipts,
});
try {
  const identityPath = join(directory, 'identity.json');
  const historyPath = join(directory, 'history.json');
  const tamperedPath = join(directory, 'tampered.json');
  const people = { patient: ids.patient, staff: ids.staff };
  writeFileSync(identityPath, JSON.stringify(identityFixtureWithProfiles(syntheticFixture(),
    { patientAccount: ids.account, staffAccount: ids.staffAccount })), { mode: 0o600 });
  writeFileSync(historyPath, JSON.stringify(syntheticHistoryFixture(people)), { mode: 0o600 });
  writeFileSync(tamperedPath, JSON.stringify(syntheticHistoryFixture(people, { title: 'Synthetic changed history' })),
    { mode: 0o600 });
  const legacy = { DATABASE_URL: databaseUrl, MIGRATION_SNAPSHOT_ID: snapshot, MIGRATION_OPERATOR: operator,
    MIGRATION_FIXTURE_PATH: identityPath, MIGRATION_RUN_ID: historyIds.parentRun,
    MIGRATION_FACILITY_TIMEZONES_JSON: JSON.stringify({ [ids.facility]: 'Africa/Lagos' }) };

  // Main's pipeline: stage, promote and reconcile the synthetic identity source.
  run('stage the synthetic identity source', 'stage-legacy-identity.mjs', legacy);
  run('promote the synthetic identity source', 'promote-legacy-identity.mjs', legacy);
  run('reconcile the synthetic identity source', 'reconcile-legacy-identity.mjs', legacy);
  const parent = (await client.query(`select mode, status, source_checksum_sha256 from migration.runs where id = $1`,
    [historyIds.parentRun])).rows[0];
  assert.deepEqual([parent.mode, parent.status], ['reconcile', 'verified']);
  // The history of the same source snapshot, in its own sealed run.
  run('stage the synthetic history', 'stage-legacy-identity.mjs', { ...legacy, MIGRATION_FIXTURE_PATH: historyPath,
    MIGRATION_RUN_ID: historyIds.historyRun }, ['--scope=imported-history']);
  const history = (await client.query(`select mode, status, source_counts from migration.runs where id = $1`,
    [historyIds.historyRun])).rows[0];
  assert.deepEqual([history.mode, history.status, history.source_counts], ['stage', 'staged',
    { medical_records: 3, medical_record_versions: 4, medical_record_files: 1 }]);
  // Main's promoter refuses the history run: it is never an identity run.
  run('promotion refuses the history run', 'promote-legacy-identity.mjs', { ...legacy,
    MIGRATION_RUN_ID: historyIds.historyRun }, [], 'failure');
  evidence.steps.pipeline = { parent: 'staged, promoted and reconciled (verified)', history: 'staged and sealed',
    promotion_of_history_run: 'refused' };
  // The promoter's refusal blocked that run; a fresh history run of the same snapshot is staged.
  const freshHistoryRun = 'e7000000-0000-4000-8000-000000000004';
  run('stage the synthetic history again', 'stage-legacy-identity.mjs', { ...legacy, MIGRATION_FIXTURE_PATH: historyPath,
    MIGRATION_RUN_ID: freshHistoryRun }, ['--scope=imported-history']);

  const importer = { DATABASE_URL: databaseUrl, MIGRATION_PARENT_RUN_ID: historyIds.parentRun,
    MIGRATION_HISTORY_RUN_ID: freshHistoryRun, MIGRATION_PARENT_SOURCE_CHECKSUM: parent.source_checksum_sha256.trim(),
    MIGRATION_OPERATOR: operator };
  const operation = ['--operation', 'medical-records'];
  const before = await importedCounts();
  assert.deepEqual(before, { records: 0, versions: 0, files: 0, receipts: 0 });

  // 1. The dry run is the default and rolls back.
  const dry = JSON.parse(run('import dry run', 'import-legacy-history.mjs', importer, operation).stdout);
  assert.deepEqual([dry.operation, dry.mode, dry.counts], ['medical-records', 'dry-run',
    { medical_records: 3, medical_record_versions: 4, medical_record_files: 1 }]);
  assert.doesNotMatch(JSON.stringify(dry), /Synthetic|Invented|synthetic-history/);
  assert.deepEqual(await importedCounts(), before, 'the dry run changed the database');

  // 2. The apply writes the history and its receipt.
  const applied = JSON.parse(run('import apply', 'import-legacy-history.mjs', importer, [...operation, '--apply']).stdout);
  assert.deepEqual([applied.mode, applied.counts, applied.inserted], ['applied',
    { medical_records: 3, medical_record_versions: 4, medical_record_files: 1 },
    { medical_records: 3, medical_record_versions: 4, medical_record_files: 1 }]);
  assert.deepEqual(await importedCounts(), { records: 3, versions: 4, files: 1, receipts: 1 });
  const origins = await asImporter(`select origin, count(*)::int n from ehr.imported_medical_records
    where patient_id = $1 group by origin order by origin`, [ids.patient]);
  assert.deepEqual(origins, [{ origin: 'patient-provided', n: 2 }, { origin: 'provider-authored', n: 1 }]);
  const afterApply = await importedSnapshot();

  // 3. A repeated apply changes nothing.
  const repeated = JSON.parse(run('import apply again', 'import-legacy-history.mjs', importer, [...operation, '--apply']).stdout);
  assert.deepEqual([repeated.mode, repeated.inserted], ['applied',
    { medical_records: 0, medical_record_versions: 0, medical_record_files: 0 }]);
  assert.deepEqual(await importedSnapshot(), afterApply, 'a repeated apply changed the imported history');

  // 4. A later history run whose record differs from the imported one is
  //    refused, and nothing changes.
  run('stage a changed history', 'stage-legacy-identity.mjs', { ...legacy, MIGRATION_FIXTURE_PATH: tamperedPath,
    MIGRATION_RUN_ID: historyIds.tamperedRun }, ['--scope=imported-history']);
  const differs = run('import of a changed history', 'import-legacy-history.mjs', { ...importer,
    MIGRATION_HISTORY_RUN_ID: historyIds.tamperedRun }, [...operation, '--apply'], 'failure');
  assert.match(differs.stderr, /IMPORTED_HISTORY_DIFFERS/);
  assert.doesNotMatch(differs.stderr, /Synthetic|Invented/);
  assert.deepEqual(await importedSnapshot(), afterApply, 'a refused import changed the imported history');

  // 5. Rows that differ from their seal are refused by the command itself,
  //    whatever the importer was given.
  const sealed = (await client.query(`select entity_type as "entityType", source_pk as "sourcePk", payload,
    trim(payload_sha256) as "payloadSha256" from migration.source_rows where run_id = $1 order by entity_type, source_pk`,
  [freshHistoryRun])).rows;
  const commandRefusal = async (rows) => {
    try {
      await withImportTransaction(client, { apply: false }, () => client.query(
        'select ehr.import_legacy_medical_history($1,$2,$3,$4::jsonb) as result',
        [historyIds.parentRun, freshHistoryRun, operator, JSON.stringify(rows)]));
      return 'accepted';
    } catch (error) { return `${error.code}:${error.message}`; }
  };
  const tampered = structuredClone(sealed);
  tampered[0].payload.title = 'Synthetic forged title';
  const refusals = {
    altered_payload: await commandRefusal(tampered),
    missing_row: await commandRefusal(sealed.slice(1)),
    duplicated_row: await commandRefusal([...sealed, sealed[0]]),
    altered_checksum: await commandRefusal(sealed.map((item, index) => index ? item : { ...item, payloadSha256: 'f'.repeat(64) })),
  };
  for (const [name, outcome] of Object.entries(refusals)) {
    assert.match(outcome, /^55000:IMPORTED_HISTORY_ROWS_DIFFER$/, name);
  }
  const unverified = await (async () => {
    try {
      await withImportTransaction(client, { apply: false }, () => client.query(
        'select ehr.import_legacy_medical_history($1,$2,$3,$4::jsonb)', [freshHistoryRun, freshHistoryRun, operator,
          JSON.stringify(sealed)]));
      return 'accepted';
    } catch (error) { return `${error.code}:${error.message}`; }
  })();
  assert.equal(unverified, '55000:IMPORTED_HISTORY_PARENT_NOT_VERIFIED');
  assert.deepEqual(await importedSnapshot(), afterApply);

  // 6. Afterwards: forced row-level security, no membership left, no runtime import.
  const state = (await client.query(`select
      (select bool_and(relforcerowsecurity) from pg_class where oid in ('ehr.imported_medical_records'::regclass,
        'ehr.imported_medical_record_versions'::regclass, 'ehr.imported_medical_record_files'::regclass)) as forced,
      (select count(*)::int from pg_auth_members where roleid in ('hid_migration_admin'::regrole,
        'hid_imported_history_importer'::regrole)
        and member = (select oid from pg_roles where rolname = current_user) and (inherit_option or set_option)) as memberships,
      (select count(*)::int from pg_roles runtime where runtime.rolname like 'hid\\_%' and runtime.rolname <> 'hid_migration_admin'
        and runtime.oid <> (select proowner from pg_proc
          where oid = 'ehr.import_legacy_medical_history(uuid,uuid,text,jsonb)'::regprocedure)
        and has_function_privilege(runtime.oid, 'ehr.import_legacy_medical_history(uuid,uuid,text,jsonb)', 'EXECUTE'))
        as runtime_importers,
      (select rolsuper from pg_roles where rolname = current_user) as superuser`)).rows[0];
  assert.deepEqual([state.forced, state.memberships, state.runtime_importers], [true, 0, 0]);
  evidence.steps.import = { dry_run: 'rolled back', apply: applied.counts, repeated_apply: 'unchanged',
    changed_history: 'refused (IMPORTED_HISTORY_DIFFERS)', command_refusals: Object.keys(refusals),
    unverified_parent: 'refused', force_row_level_security: state.forced, administrator_memberships_left: 0,
    runtime_roles_that_can_import: 0, administrator_superuser: state.superuser };
  evidence.status = 'passed';
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
  evidence.temporary_files_removed = true;
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}
