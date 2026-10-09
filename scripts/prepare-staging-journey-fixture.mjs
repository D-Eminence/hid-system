#!/usr/bin/env node
// Local, synthetic migration input only. No database, cloud, delivery or NIN calls.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ids as sourceIds, syntheticFixture } from '../release/migration/synthetic-fixture.mjs';

const require = createRequire(new URL('../release/package.json', import.meta.url));
const duplicateKeyJson = require('json-dup-key-validator');
const localRoot = resolve(import.meta.dirname, '../release/local');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const account = '659225405023', region = 'eu-west-1';
const uuidNames = ['account', 'staffAccount', 'organization', 'facility', 'patient', 'staff', 'membership'];
function check(value) { if (!value) throw new Error('Staging journey input or output rejected'); }
function exact(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...keys].sort().join());
}
function controlledEmail(value) {
  check(typeof value === 'string' && value.length <= 254
    && /^[A-Za-z0-9][A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value)
    && !value.includes('..'));
  return value.toLowerCase();
}

export function validateJourneyInput(value) {
  exact(value, ['schema_version', 'environment', 'controlled_test_recipients_confirmed', 'patient_email', 'staff_email', 'expected_target']);
  check(value.schema_version === 'hid.staging-journey-input/v1' && value.environment === 'staging'
    && value.controlled_test_recipients_confirmed === true);
  const patientEmail = controlledEmail(value.patient_email), staffEmail = controlledEmail(value.staff_email);
  check(patientEmail !== staffEmail);
  exact(value.expected_target, ['aws_account_id', 'aws_region', 'rds_instance_identifier', 'database_name']);
  const target = value.expected_target;
  check(target.aws_account_id === account && target.aws_region === region);
  check(target.rds_instance_identifier === null || (typeof target.rds_instance_identifier === 'string'
    && /^hid-staging-[a-z0-9](?:[a-z0-9-]{0,45}[a-z0-9])?$/.test(target.rds_instance_identifier)
    && !target.rds_instance_identifier.includes('production')));
  check(target.database_name === null || (typeof target.database_name === 'string'
    && /^[a-z][a-z0-9_]{0,62}$/.test(target.database_name) && !/prod/i.test(target.database_name)));
  return { patientEmail, staffEmail, target: { ...target } };
}

export function generateJourneyFixture(input) {
  const { patientEmail, staffEmail, target } = validateJourneyInput(input);
  const source = syntheticFixture();
  const ids = Object.fromEntries(uuidNames.map(name => [name, randomUUID()]));
  check(new Set(Object.values(ids)).size === uuidNames.length);
  const replacements = new Map(uuidNames.map(name => [sourceIds[name], ids[name]]));
  const now = new Date().toISOString();
  const hidAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hid = `HID-${[...randomBytes(16)].map(byte => hidAlphabet[byte % hidAlphabet.length]).join('')}`;
  function row(entity, sourceId, fields, overrides = {}) {
    const old = source[entity].find(item => item.source_pk === sourceId);
    check(old && fields.every(field => Object.hasOwn(old.payload, field)));
    const payload = Object.fromEntries(fields.map(field => [field, replacements.get(old.payload[field]) ?? old.payload[field]]));
    Object.assign(payload, overrides, { created_at: now, updated_at: now });
    return { source_pk: replacements.get(sourceId), source_updated_at: now, payload };
  }
  const fixture = {
    accounts: [
      row('accounts', sourceIds.account, ['id'], { email: patientEmail, encrypted_password: null, email_confirmed_at: null }),
      row('accounts', sourceIds.staffAccount, ['id'], { email: staffEmail, encrypted_password: null, email_confirmed_at: null }),
    ],
    user_profiles: [],
    organizations: [row('organizations', sourceIds.organization, ['id', 'active'],
      { name: 'Synthetic staging journey organization', slug: `synthetic-staging-${ids.organization}` })],
    facilities: [row('facilities', sourceIds.facility, ['id', 'organization_id', 'active'],
      { name: 'Synthetic staging journey facility', code: `STG-${ids.facility}` })],
    patients: [row('patients', sourceIds.patient, ['id', 'auth_user_id'],
      { hid_code: hid, first_name: 'Synthetic', last_name: 'Patient', full_name: 'Synthetic staging journey patient', email: patientEmail })],
    patient_identifiers: [],
    staff: [row('staff', sourceIds.staff, ['id', 'auth_user_id', 'verification_status', 'role', 'active'],
      { full_name: 'Synthetic staging journey clinician', email: staffEmail })],
    memberships: [row('memberships', sourceIds.membership,
      ['id', 'staff_account_id', 'organization_id', 'facility_id', 'membership_role', 'app_role', 'is_primary', 'active'])],
    access_requests: [], consent_grants: [], audit_events: [],
  };
  check(fixture.staff[0].payload.role === 'doctor'
    && fixture.memberships[0].payload.membership_role === 'doctor'
    && fixture.memberships[0].payload.app_role === 'doctor');
  // The existing scanner requires each entity's source primary keys in order.
  for (const rows of Object.values(fixture)) rows.sort((left, right) => left.source_pk.localeCompare(right.source_pk));
  const fixtureBytes = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`);
  const manifest = {
    schema_version: 'hid.staging-journey-fixture/v1', environment: 'staging', scope: 'synthetic-only',
    status: 'PREPARED_LOCAL_ONLY', prepared_at: now, fixture_sha256: hash(fixtureBytes),
    expected_target: target, target_verified: false, database_imported: false,
    staging_import_authorized: false, deployment_authorized: false,
    contacts_verified: false, nin_verified: false, clinical_records_seeded: false,
    ids, hid, entity_counts: Object.fromEntries(Object.entries(fixture).map(([entity, rows]) => [entity, rows.length])),
    migration: { run_id: randomUUID(), snapshot_id: `synthetic-staging-journey-${ids.patient}`,
      facility_timezones: { [ids.facility]: 'Africa/Lagos' }, importer_source_label: 'legacy_identity',
      source_is_actual_legacy_export: false },
    expected_imported_account_status: 'pending_reset',
    synthetic_staff_assignment: { role: 'doctor', scope: 'facility', professional_credentials_verified: false },
    remaining_checks: ['confirm exact staging account, region, RDS instance, database and operator authority',
      'approve fixture checksum, identifiers and synthetic workforce assignment; reject destination collisions',
      'run existing stage, promote and reconciliation with migration-only credentials and verified TLS',
      'complete normal delivered OTP recovery for each controlled account',
      'exercise patient self-service and governed staff emergency access with current runtime controls'],
  };
  return { fixtureBytes, manifest };
}

async function privateDirectory(path) {
  const stat = await lstat(path);
  check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700
    && stat.uid === process.getuid() && await realpath(path) === path);
}
async function inputFromFile(path, root) {
  check(isAbsolute(path) && resolve(path) === path && dirname(path) === root && await realpath(path) === path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size <= 8192);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      check(bytesRead > 0); offset += bytesRead;
    }
    check((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead === 0);
    return duplicateKeyJson.parse(bytes.toString('utf8'), false);
  } finally { await handle.close(); }
}
async function writePrivate(path, bytes) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

// root is injected by tests only. CLI always uses this checkout's ignored release/local.
export async function prepareJourneyFixture(inputPath, outputDirectory, { root = localRoot } = {}) {
  check(isAbsolute(root) && resolve(root) === root && root.endsWith(`${sep}release${sep}local`));
  await privateDirectory(root);
  check(isAbsolute(outputDirectory) && resolve(outputDirectory) === outputDirectory
    && dirname(outputDirectory) === root && /^staging-journey-[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(basename(outputDirectory)));
  const generated = generateJourneyFixture(await inputFromFile(inputPath, root));
  // Exclusive directory creation makes repeated execution fail before any write.
  await mkdir(outputDirectory, { mode: 0o700 });
  try {
    await privateDirectory(outputDirectory);
    await writePrivate(resolve(outputDirectory, 'fixture.json'), generated.fixtureBytes);
    await writePrivate(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(generated.manifest, null, 2)}\n`);
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
  return generated.manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 4);
    process.stdout.write(`${JSON.stringify(await prepareJourneyFixture(process.argv[2], process.argv[3]), null, 2)}\n`);
  } catch {
    // Never echo operator input, file contents, paths, provider errors or emails.
    process.stderr.write('Staging journey preparation rejected; use controlled recipient input and new private paths under release/local.\n');
    process.exitCode = 1;
  }
}
