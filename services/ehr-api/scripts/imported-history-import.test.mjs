// The imported legacy history import (owner decision 3 of 2026-10-16,
// ADR-065), without a database: the importer takes only rows of a sealed
// legacy staging run whose identity parent run is verified, checks every
// row against its seal and the parent's identity rows, refuses anything
// else with a code (never an identifier or any content), and its command line
// refuses production before it connects. The stager's history scope seals
// what the importer checks, and its identity scope is unchanged.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { historyIds, identityFixtureWithProfiles, stagedRows, syntheticHistoryFixture } from './imported-history-fixture.mjs';
import { IMPORTED_HISTORY_ENTITY_TYPES, ImportRefusal, prepareImportedHistory, sealSummary } from './imported-history-import.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const identity = { patient: '30000000-0000-4000-8000-000000000001', patientAccount: '20000000-0000-4000-8000-000000000001',
  staff: '50000000-0000-4000-8000-000000000001', staffAccount: '20000000-0000-4000-8000-000000000002' };
const identityTypes = ['accounts', 'user_profiles', 'patients', 'staff'];
const snapshot = 'synthetic-fixture-v1';

/** The identity rows main's stager staged and main's promoter and reconciler verified. */
function identityFixture() {
  const row = (payload) => ({ source_pk: payload.id, source_updated_at: '2026-01-01T00:00:00.000Z', payload });
  return identityFixtureWithProfiles({
    accounts: [row({ id: identity.patientAccount, email: 'synthetic-0@example.invalid' }),
      row({ id: identity.staffAccount, email: 'synthetic-1@example.invalid' })],
    user_profiles: [],
    patients: [row({ id: identity.patient, auth_user_id: identity.patientAccount, hid_code: 'HID-JKLMNPQR' })],
    staff: [row({ id: identity.staff, auth_user_id: identity.staffAccount, full_name: 'Synthetic Clinician' })],
  }, identity);
}

function input({ history = syntheticHistoryFixture(identity), parentChanges = {}, historyChanges = {},
  mutateRows } = {}) {
  const parentSeal = stagedRows(identityFixture(), identityTypes);
  const historySeal = stagedRows(history, IMPORTED_HISTORY_ENTITY_TYPES);
  const historyRows = historySeal.rows.map((item) => ({ ...item, payload: structuredClone(item.payload) }));
  mutateRows?.(historyRows);
  return {
    parent: { id: historyIds.parentRun, source_system: 'legacy_identity', mode: 'reconcile', status: 'verified',
      source_snapshot: snapshot, source_checksum_sha256: parentSeal.overallChecksum,
      target_checksum_sha256: 'f'.repeat(64), conflicts: 0, ...parentChanges },
    history: { id: historyIds.historyRun, source_system: 'legacy_identity', mode: 'stage', status: 'staged',
      source_snapshot: snapshot, source_counts: historySeal.counts, source_checksum_sha256: historySeal.overallChecksum,
      conflicts: 0, ...historyChanges },
    parentChecksum: parentSeal.overallChecksum,
    parentRows: parentSeal.rows,
    historyRows,
  };
}

/** Asserts a refusal by its code, and that its message names no identifier and no content. */
function refuses(run, code) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof ImportRefusal, `expected an import refusal, got ${error}`);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /[0-9a-f]{8}-[0-9a-f]{4}-|Synthetic|Invented|synthetic-history/);
    return true;
  });
}

test('prepares the sealed history: every record, version and file, with its author and origin', () => {
  const prepared = prepareImportedHistory(input());
  assert.deepEqual(prepared.counts, { medical_records: 3, medical_record_versions: 4, medical_record_files: 1 });
  assert.deepEqual(prepared.records.map((record) => record.origin),
    ['patient-provided', 'patient-provided', 'provider-authored']);
  assert.deepEqual(prepared.records.map((record) => record.authorAccountId),
    [identity.patientAccount, identity.patientAccount, identity.staffAccount]);
  assert.deepEqual(prepared.files.map((file) => file.uploaderAccountId), [identity.patientAccount]);
  // What the command receives is exactly the sealed rows: type, key, payload and checksum.
  assert.deepEqual(prepared.rows, stagedRows(syntheticHistoryFixture(identity), IMPORTED_HISTORY_ENTITY_TYPES).rows
    .map((item) => ({ entityType: item.entity_type, sourcePk: item.source_pk, payload: item.payload,
      payloadSha256: item.payload_sha256 })));
  assert.equal(prepared.historyChecksum, input().history.source_checksum_sha256);
});

test('seals exactly as the stager does', () => {
  const sealed = stagedRows(syntheticHistoryFixture(identity), IMPORTED_HISTORY_ENTITY_TYPES);
  assert.deepEqual(sealSummary(sealed.rows), { counts: sealed.counts, checksums: sealed.checksums,
    overallChecksum: sealed.overallChecksum });
});

test('refuses a parent run that is not the verified, reconciled legacy identity run', () => {
  for (const changes of [{ mode: 'promote' }, { status: 'staged' }, { status: 'blocked' },
    { source_system: 'other' }, { conflicts: 1 }]) {
    refuses(() => prepareImportedHistory(input({ parentChanges: changes })), 'IMPORTED_HISTORY_PARENT_NOT_VERIFIED');
  }
  const changed = input();
  changed.parentChecksum = 'a'.repeat(64);
  refuses(() => prepareImportedHistory(changed), 'IMPORTED_HISTORY_PARENT_SEAL_MISMATCH');
});

test('refuses a history run that is not a sealed staging run of the same source snapshot', () => {
  for (const [changes, code] of [[{ mode: 'promote' }, 'IMPORTED_HISTORY_RUN_NOT_SEALED'],
    [{ status: 'running' }, 'IMPORTED_HISTORY_RUN_NOT_SEALED'], [{ source_checksum_sha256: null }, 'IMPORTED_HISTORY_RUN_NOT_SEALED'],
    [{ conflicts: 2 }, 'IMPORTED_HISTORY_RUN_NOT_SEALED'], [{ source_snapshot: 'another-snapshot' }, 'IMPORTED_HISTORY_SNAPSHOT_MISMATCH'],
    [{ source_checksum_sha256: 'b'.repeat(64) }, 'IMPORTED_HISTORY_SEAL_MISMATCH']]) {
    refuses(() => prepareImportedHistory(input({ historyChanges: changes })), code);
  }
  refuses(() => prepareImportedHistory(input({ historyChanges: { source_counts: { medical_records: 3,
    medical_record_versions: 4 } } })), 'IMPORTED_HISTORY_CATEGORY_MISMATCH');
  refuses(() => prepareImportedHistory(input({ historyChanges: { source_counts: { medical_records: 3,
    medical_record_versions: 4, medical_record_files: 1, patients: 1 } } })), 'IMPORTED_HISTORY_CATEGORY_MISMATCH');
});

test('refuses altered bytes, a row the seal does not hold and a row of another category', () => {
  refuses(() => prepareImportedHistory(input({ mutateRows: (rows) => { rows[0].payload.title = 'changed'; } })),
    'IMPORTED_HISTORY_ROW_TAMPERED');
  refuses(() => prepareImportedHistory(input({ mutateRows: (rows) => { rows.pop(); } })),
    'IMPORTED_HISTORY_SEAL_MISMATCH');
  refuses(() => prepareImportedHistory(input({ mutateRows: (rows) => { rows.push({ ...rows[0], entity_type: 'patients' }); } })),
    'IMPORTED_HISTORY_CATEGORY_MISMATCH');
});

test('refuses a record bound to the wrong patient, version or author', () => {
  const cases = [
    ['a record of a patient the parent run never staged', (history) => {
      history.medical_records[0].payload.patient_id = '30000000-0000-4000-8000-000000000099'; },
    'IMPORTED_HISTORY_BINDING_DIFFERS'],
    ['a current version of another record', (history) => {
      history.medical_records[0].payload.current_version_id = historyIds.versions[2]; }, 'IMPORTED_HISTORY_BINDING_DIFFERS'],
    ['a file of another patient', (history) => {
      history.medical_record_files[0].payload.patient_id = '30000000-0000-4000-8000-000000000099'; },
    'IMPORTED_HISTORY_BINDING_DIFFERS'],
    ['a file of a version of another record', (history) => {
      history.medical_record_files[0].payload.record_version_id = historyIds.versions[3]; },
    'IMPORTED_HISTORY_BINDING_DIFFERS'],
    ['an author profile the parent run never staged', (history) => {
      history.medical_records[0].payload.created_by_user_profile_id = '30000000-0000-4000-8000-000000000098'; },
    'IMPORTED_HISTORY_AUTHOR_UNRESOLVED'],
    ['a clinician record naming a staff member the parent run never staged', (history) => {
      history.medical_records[2].payload.created_by_staff_account_id = '50000000-0000-4000-8000-000000000099'; },
    'IMPORTED_HISTORY_AUTHOR_UNRESOLVED'],
    ['a patient-authored record naming a staff member', (history) => {
      history.medical_records[0].payload.created_by_staff_account_id = identity.staff; },
    'IMPORTED_HISTORY_AUTHOR_UNRESOLVED'],
    ['a version number of zero', (history) => { history.medical_record_versions[0].payload.version_no = 0; },
      'IMPORTED_HISTORY_VERSION_INVALID'],
    ['a duplicate version number', (history) => { history.medical_record_versions[1].payload.version_no = 1; },
      'IMPORTED_HISTORY_VERSION_INVALID'],
    ['a version without content', (history) => {
      Object.assign(history.medical_record_versions[0].payload, { record: ' ', notes: null, transcription_text: null,
        structured_data: {} }); }, 'IMPORTED_HISTORY_VERSION_INVALID'],
    ['a record without a timestamp', (history) => { history.medical_records[1].payload.created_at = 'not a time'; },
      'IMPORTED_HISTORY_RECORD_INVALID'],
    ['a non-UUID record id', (history) => {
      history.medical_records[1].payload.id = 'legacy-17';
      history.medical_records[1].source_pk = 'legacy-17'; }, 'IMPORTED_HISTORY_RECORD_INVALID'],
    ['a file with a negative size', (history) => { history.medical_record_files[0].payload.size_bytes = -1; },
      'IMPORTED_HISTORY_FILE_INVALID'],
  ];
  for (const [label, mutate, code] of cases) {
    const history = syntheticHistoryFixture(identity);
    mutate(history);
    assert.doesNotThrow(() => stagedRows(history, IMPORTED_HISTORY_ENTITY_TYPES), label);
    refuses(() => prepareImportedHistory(input({ history })), code);
  }
});

test('the stager seals the history scope as the importer recomputes it, and leaves the identity scope unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hid-imported-history-test-'));
  try {
    const historyPath = join(directory, 'history.json');
    const history = syntheticHistoryFixture(identity);
    writeFileSync(historyPath, JSON.stringify(history), { mode: 0o600 });
    const environment = { PATH: process.env.PATH, MIGRATION_FIXTURE_PATH: historyPath,
      MIGRATION_SNAPSHOT_ID: snapshot, MIGRATION_OPERATOR: 'imported-history-test' };
    const output = execFileSync(process.execPath, [join(here, 'stage-legacy-identity.mjs'), '--dry-run',
      '--scope=imported-history'], { env: environment, encoding: 'utf8' });
    const sealed = stagedRows(history, IMPORTED_HISTORY_ENTITY_TYPES);
    assert.deepEqual(output.trim().split('\n'), [
      ...IMPORTED_HISTORY_ENTITY_TYPES.map((type) => `${type}: ${sealed.counts[type]} ${sealed.checksums[type]}`),
      `Dry-run source scan complete: ${sealed.overallChecksum}`]);
    // A history fixture without one of its categories is refused.
    const partial = { ...history };
    delete partial.medical_record_files;
    writeFileSync(historyPath, JSON.stringify(partial), { mode: 0o600 });
    const refused = spawnSync(process.execPath, [join(here, 'stage-legacy-identity.mjs'), '--dry-run',
      '--scope=imported-history'], { env: environment, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Fixture is missing medical_record_files rows/);
    // An unknown scope is refused before anything is read.
    const unknown = spawnSync(process.execPath, [join(here, 'stage-legacy-identity.mjs'), '--dry-run', '--scope=all'],
      { env: environment, encoding: 'utf8' });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /--scope must be identity or imported-history/);
    // The identity scope stages exactly the categories it always did, and
    // never a history category, so main's promotion and reconciliation see
    // the same sealed run as before.
    const identityOutput = execFileSync(process.execPath, [join(here, 'stage-legacy-identity.mjs'), '--dry-run'], {
      env: { ...environment, MIGRATION_FIXTURE_PATH: join(here, '../test/fixtures/legacy-identity.sample.json') },
      encoding: 'utf8' });
    assert.deepEqual(identityOutput.trim().split('\n').slice(0, -1).map((line) => line.split(':')[0]), ['accounts',
      'google_identities', 'patient_access_pins', 'user_profiles', 'organizations', 'facilities', 'patients',
      'patient_identifiers', 'staff', 'memberships', 'access_requests', 'consent_grants', 'audit_events',
      'outreach_campaigns', 'outreach_workers', 'outreach_encounters', 'outreach_sync_queue', 'outreach_referrals',
      'outreach_vaccinations', 'outreach_mobile_lab_samples', 'outreach_invites']);
    // Main's cutover input gate, which every promotion runs first, refuses a
    // history run: promote and reconcile can never take it for an identity run.
    writeFileSync(historyPath, JSON.stringify(history), { mode: 0o600 });
    const gate = spawnSync(process.execPath, [join(here, 'verify-supabase-cutover-input.mjs')], {
      env: { PATH: process.env.PATH, MIGRATION_FIXTURE_PATH: historyPath }, encoding: 'utf8' });
    assert.notEqual(gate.status, 0);
    assert.match(`${gate.stdout}${gate.stderr}`, /unexpected entity category/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the command line refuses production, unknown operations and conflicting modes before it connects', () => {
  const script = join(here, 'import-legacy-history.mjs');
  // Nothing listens here: a connection attempt would fail with a different error.
  const base = { PATH: process.env.PATH, DATABASE_URL: 'postgresql://nobody@127.0.0.1:9/none',
    MIGRATION_PARENT_RUN_ID: historyIds.parentRun, MIGRATION_HISTORY_RUN_ID: historyIds.historyRun,
    MIGRATION_PARENT_SOURCE_CHECKSUM: 'a'.repeat(64), MIGRATION_OPERATOR: 'imported-history-test' };
  for (const [label, environment, args, message] of [
    ['production', { ...base, HID_DEPLOYMENT_ENV: 'production' }, ['--operation', 'medical-records'], /refused in production/],
    ['no deployment profile', base, ['--operation', 'medical-records'], /staging or an owned rehearsal/],
    ['a development profile outside a rehearsal', { ...base, HID_DEPLOYMENT_ENV: 'development' },
      ['--operation', 'medical-records'], /staging or an owned rehearsal/],
    ['both modes', { ...base, HID_DEPLOYMENT_ENV: 'staging' }, ['--operation', 'medical-records', '--dry-run', '--apply'],
      /Choose --dry-run or --apply/],
    ['an unknown operation', { ...base, HID_DEPLOYMENT_ENV: 'staging' }, ['--operation', 'customer-configuration'],
      /--operation must be medical-records/],
    ['no operation', { ...base, HID_DEPLOYMENT_ENV: 'staging' }, [], /--operation must be medical-records/],
    ['a parent run id that is not a UUID', { ...base, HID_DEPLOYMENT_ENV: 'staging', MIGRATION_PARENT_RUN_ID: 'x' },
      ['--operation', 'medical-records'], /MIGRATION_PARENT_RUN_ID/],
    ['no parent seal', { ...base, HID_DEPLOYMENT_ENV: 'staging', MIGRATION_PARENT_SOURCE_CHECKSUM: '' },
      ['--operation', 'medical-records'], /MIGRATION_PARENT_SOURCE_CHECKSUM/],
    ['no operator', { ...base, HID_DEPLOYMENT_ENV: 'staging', MIGRATION_OPERATOR: '' },
      ['--operation', 'medical-records'], /MIGRATION_OPERATOR/],
    ['a managed database URL variable instead of DATABASE_URL', { ...base, HID_DEPLOYMENT_ENV: 'staging',
      DATABASE_URL: '', DATABASE_ADMIN_URL: 'postgresql://nobody@127.0.0.1:9/none' }, ['--operation', 'medical-records'],
    /DATABASE_URL is required/],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { env: environment, encoding: 'utf8' });
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, message, label);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|connect/, `${label} tried to connect`);
  }
});
