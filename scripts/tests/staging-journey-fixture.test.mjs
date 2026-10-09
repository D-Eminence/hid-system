import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { generateJourneyFixture, prepareJourneyFixture, validateJourneyInput } from '../prepare-staging-journey-fixture.mjs';

const run = promisify(execFile);
const repository = resolve(import.meta.dirname, '../..');
const template = JSON.parse(await readFile(resolve(repository, 'release/config/staging-journey-input.template.json'), 'utf8'));
function input() {
  return { ...structuredClone(template), controlled_test_recipients_confirmed: true,
    patient_email: 'Controlled-Patient@example.invalid', staff_email: 'Controlled-Staff@example.invalid' };
}
async function files(t) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'hid-staging-journey-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = resolve(temporary, 'release/local');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const inputPath = resolve(root, 'operator-input.json'), output = resolve(root, 'staging-journey-test');
  await writeFile(inputPath, JSON.stringify(input()), { mode: 0o600 });
  return { temporary, root, inputPath, output };
}

test('unfilled template, unconfirmed contacts, production scope and extra credential fields are rejected', () => {
  assert.throws(() => validateJourneyInput(template));
  for (const change of [
    value => { value.controlled_test_recipients_confirmed = false; },
    value => { value.environment = 'production'; },
    value => { value.expected_target.aws_account_id = '111122223333'; },
    value => { value.expected_target.aws_region = 'us-east-1'; },
    value => { value.expected_target.rds_instance_identifier = 'hid-production-postgres'; },
    value => { value.expected_target.database_name = 'production'; },
    value => { value.expected_target.target_verified = true; },
    value => { value.password = 'PRIVATE_SENTINEL'; },
    value => { value.nin = 'PRIVATE_SENTINEL'; },
    value => { value.patient_email = 'bad\nPRIVATE_SENTINEL@example.invalid'; },
    value => { value.staff_email = value.patient_email.toLowerCase(); },
  ]) {
    const value = input(); change(value);
    assert.throws(() => validateJourneyInput(value), error => !error.message.includes('PRIVATE_SENTINEL'));
  }
});

test('synthetic data preserves independent patient/account/workforce links with no preverified credentials, NIN or clinical access', () => {
  const { fixtureBytes, manifest } = generateJourneyFixture(input());
  const fixture = JSON.parse(fixtureBytes);
  const ids = manifest.ids;
  assert.equal(new Set(Object.values(ids)).size, 7);
  assert.equal(fixture.patients[0].payload.auth_user_id, ids.account);
  assert.equal(fixture.patients[0].payload.id, ids.patient);
  assert.notEqual(ids.patient, ids.account);
  assert.equal(fixture.staff[0].payload.auth_user_id, ids.staffAccount);
  assert.equal(fixture.staff[0].payload.role, 'doctor');
  assert.equal(fixture.memberships[0].payload.staff_account_id, ids.staff);
  assert.equal(fixture.memberships[0].payload.facility_id, ids.facility);
  assert.equal(fixture.memberships[0].payload.organization_id, ids.organization);
  assert.equal(fixture.memberships[0].payload.app_role, 'doctor');
  assert.equal(fixture.staff.some(row => row.payload.auth_user_id === ids.account), false);
  for (const row of fixture.accounts) {
    assert.equal(row.payload.encrypted_password, null);
    assert.equal(row.payload.email_confirmed_at, null);
  }
  assert.equal(fixture.accounts.find(row => row.source_pk === ids.account).payload.email, fixture.patients[0].payload.email);
  assert.equal(fixture.accounts.find(row => row.source_pk === ids.staffAccount).payload.email, fixture.staff[0].payload.email);
  assert.match(manifest.hid, /^HID-[A-HJ-NP-Z2-9]{16}$/);
  for (const entity of ['patient_identifiers', 'access_requests', 'consent_grants', 'audit_events']) assert.deepEqual(fixture[entity], []);
  assert.doesNotMatch(fixtureBytes.toString(), /nin|blood_group|medical_notes|phone_e164|password_hash|session|platform_admin/i);
  for (const [entity, rows] of Object.entries(fixture)) for (const row of rows) {
    assert.equal(row.source_pk, row.payload.id, entity);
    assert.equal(row.source_updated_at, row.payload.updated_at, entity);
  }
  for (const rows of Object.values(fixture)) assert.deepEqual(rows.map(row => row.source_pk), rows.map(row => row.source_pk).sort());
  assert.equal(manifest.expected_imported_account_status, 'pending_reset');
});

test('manifest contains no contacts, remains unverified and does not invent database references', () => {
  const { manifest } = generateJourneyFixture(input());
  assert.doesNotMatch(JSON.stringify(manifest), /@|Controlled-Patient|Controlled-Staff/i);
  assert.equal(manifest.expected_target.rds_instance_identifier, null);
  assert.equal(manifest.expected_target.database_name, null);
  for (const field of ['target_verified', 'database_imported', 'staging_import_authorized', 'deployment_authorized',
    'contacts_verified', 'nin_verified', 'clinical_records_seeded']) assert.equal(manifest[field], false);
  assert.equal(manifest.synthetic_staff_assignment.professional_credentials_verified, false);
  assert.equal(manifest.migration.source_is_actual_legacy_export, false);
  const value = input();
  value.expected_target.rds_instance_identifier = 'hid-staging-postgres';
  value.expected_target.database_name = 'hid';
  const supplied = generateJourneyFixture(value).manifest;
  assert.equal(supplied.expected_target.database_name, 'hid');
  assert.equal(supplied.target_verified, false);
});

test('new private output persists one UUID/HID set and refuses rerun or overwrite', async t => {
  const { root, inputPath, output } = await files(t);
  const result = await prepareJourneyFixture(inputPath, output, { root });
  const fixturePath = resolve(output, 'fixture.json'), manifestPath = resolve(output, 'manifest.json');
  const fixtureBefore = await readFile(fixturePath), manifestBefore = await readFile(manifestPath);
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  for (const path of [fixturePath, manifestPath]) assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(manifestBefore).ids.patient, result.ids.patient);
  assert.equal(JSON.parse(fixtureBefore).patients[0].payload.hid_code, result.hid);
  await assert.rejects(prepareJourneyFixture(inputPath, output, { root }));
  assert.deepEqual(await readFile(fixturePath), fixtureBefore);
  assert.deepEqual(await readFile(manifestPath), manifestBefore);
  const next = await prepareJourneyFixture(inputPath, resolve(root, 'staging-journey-next'), { root });
  assert.notEqual(next.ids.patient, result.ids.patient);
  assert.notEqual(next.hid, result.hid);
});

test('unsafe paths, output symlinks, permissive input permissions and duplicate JSON are rejected', async t => {
  const { temporary, root, inputPath, output } = await files(t);
  for (const path of [resolve(temporary, 'staging-journey-outside'), resolve(root, 'production'), resolve(root, 'nested/staging-journey-nested')]) {
    await assert.rejects(prepareJourneyFixture(inputPath, path, { root }));
  }
  const linked = resolve(root, 'linked-input.json');
  await symlink(inputPath, linked);
  await assert.rejects(prepareJourneyFixture(linked, output, { root }));
  await symlink(temporary, output);
  await assert.rejects(prepareJourneyFixture(inputPath, output, { root }));
  assert.equal((await lstat(output)).isSymbolicLink(), true);
  await rm(output);
  await chmod(inputPath, 0o644);
  await assert.rejects(prepareJourneyFixture(inputPath, output, { root }));
  await chmod(inputPath, 0o600);
  await writeFile(inputPath, JSON.stringify(input()).replace('"environment":"staging"', '"environment":"production","environment":"staging"'));
  await assert.rejects(prepareJourneyFixture(inputPath, output, { root }));
  await writeFile(inputPath, ' '.repeat(8193));
  await assert.rejects(prepareJourneyFixture(inputPath, output, { root }));
  assert.equal((await readdir(root)).some(name => name.startsWith('staging-journey-')), false);
});

test('the existing fixture importer validates generated row maps offline without a database', async t => {
  const { root, inputPath, output } = await files(t);
  const prepared = await prepareJourneyFixture(inputPath, output, { root });
  const result = await run(process.execPath, [resolve(repository, 'services/ehr-api/scripts/stage-legacy-identity.mjs'), '--dry-run'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', MIGRATION_FIXTURE_PATH: resolve(output, 'fixture.json'),
      MIGRATION_SNAPSHOT_ID: prepared.migration.snapshot_id, MIGRATION_OPERATOR: 'local-synthetic-test',
      MIGRATION_RUN_ID: prepared.migration.run_id },
  });
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /@|Controlled-Patient|Controlled-Staff/i);
  assert.match(result.stdout, /accounts|patients/);
});

test('CLI refuses external input/output and emits only a generic error', async t => {
  const { inputPath, output } = await files(t);
  await assert.rejects(run(process.execPath, [resolve(repository, 'scripts/prepare-staging-journey-fixture.mjs'), inputPath, output]), error => {
    assert.equal(error.code, 1);
    assert.doesNotMatch(`${error.stdout}${error.stderr}`, /@|Controlled-Patient|Controlled-Staff|operator-input.json/i);
    return true;
  });
});
