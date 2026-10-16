#!/usr/bin/env node

// Launch (I3, P8-BOOTSTRAP, P8-CONTROL, DB-LOGIN-VERIFY): the whole database
// chain as RDS runs it, where no role is a PostgreSQL superuser. This creates
// its own disposable Unix-socket cluster, prints its evidence as JSON and
// removes the cluster. It has no database URL, cloud, credential or production
// mode. The rehearsal (tuf-staging-migration-rehearsal.mjs) runs it.
//
// The cluster superuser acts only where the RDS master would: it creates the
// migration administrator (LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE
// NOCREATEDB) and a database that administrator owns, and grants SET ON
// PARAMETER plpgsql.variable_conflict for the migration run and revokes it
// afterwards. Everything else runs as the administrator or as the runtime
// logins it creates:
// - 0001 to the latest migration (0015 first refused without the grant);
// - the role bootstrap twice, each while a second connection holds a lock on
//   platform.control_settings and then takes the lock of an
//   identity.outbox_events insert, as an Identity break-glass activation does,
//   then db:verify-roles;
// - db:verify-roles' refusal of an ADMIN OPTION membership of a runtime group
//   role in a technical owner;
// - db:verify-logins for one login per runtime credential, and its refusal of
//   the administrator's URL and of a login with an extra role;
// - platform.control_enabled as the Identity, EHR and Outreach logins, and
//   ocr.claim_worker_job as the OCR worker login without the SET grant;
// - the notification worker's claim-bound recipient lookup (0095, ADR-064) as
//   the worker login, which reads no patient or login table, and its refusal
//   for the Identity and dispatcher logins;
// - the release checklist's read-only P10, P11 and P35 checks, taken from
//   docs/PHASE_4_STAGE_5_RELEASE_READINESS.md, as the administrator, as an
//   operator runs them on RDS;
// - the daily reviews of P37 (break-glass use and in-person checks by
//   accounts approved through a clinician application), taken from
//   docs/MIGRATION_RUNBOOK.md §6, as the administrator;
// - break-glass's migration (0097) run again as the administrator in
//   rolled-back transactions: refused while break_glass_enabled is on, a
//   no-op while it is off;
// - the imported legacy history import (ADR-067) as the administrator: main's
//   stage, promote and reconcile of a synthetic source, a sealed history run,
//   and the importer's in-transaction membership in hid_migration_admin;
// - the upgrade path of clinician self sign-up (ADR-066): a second database
//   migrated through the migration before it, where the previous release's
//   bootstrap statements for platform.control_enabled (P8-CONTROL) give the
//   function its technical owner, then that
//   migration applied as the administrator without SET ON PARAMETER (it
//   replaces the function under a membership it takes and revokes in its own
//   transaction), the bootstrap again and db:verify-roles; the function keeps
//   its owner, the administrator keeps no INHERIT or SET membership, and the
//   guards' logins read the new control as off; before that, the same
//   migration run on that database, in a rolled-back transaction, as an
//   administrator whose name needs quoting and which still owns the function
//   (a chain migrated before its first bootstrap);
// - admin:bootstrap seeding two or three distinct first Super Admins in one
//   audited transaction, and refusing a repeated, ineligible (no password, or
//   no email address, as platform sign-in is by email) or fourth account, both
//   forms at once, the one-account form with NODE_ENV=production, and any run
//   once a Super Admin is active;
// - the email form of admin:bootstrap (owner decision 2026-10-16,
//   SUPERADMIN-ACCOUNTS), on a copy of the main database taken before its
//   first Super Admin: it creates two or three platform-only accounts with no
//   password and grants each Super Admin; it refuses an address an account
//   already has, and any rerun of either form while those accounts are still
//   pending; PLATFORM_ADMIN_REPLACE_PENDING=1 replaces an unused set and is
//   refused once one of them has set a password. As the Identity runtime
//   LOGIN, the recovery start lookup of otp.service.ts reaches the account
//   from the admin page only, and over HTTP the admin reset sets the person's
//   own password and the first platform sign-in enrols an authenticator
//   (verify-platform-admin-email-bootstrap-runtime.mjs); after it the platform
//   sign-in lookup of local-auth.provider.ts and the platform permission
//   accept the account, which has no staff or patient record;
// - the platform-control-owner and function-parameter-settings suites;
// - the database provisioning task's script (provision-database-logins.mjs,
//   MIGRATION_RUNBOOK.md §6.1 and §6.3) on a second cluster laid out as a new
//   RDS instance: a NOSUPERUSER CREATEROLE CREATEDB master owns the database
//   and creates the migration administrator (refusing one named after a HID
//   group role, such as hid_migration_admin), the provisioned roles sign in
//   with SCRAM-SHA-256 passwords, the chain migrates and bootstraps as that
//   administrator, and the administrator creates the ten runtime LOGINs from
//   their URLs' passwords and verifies them; refusals change nothing.
//   The cluster superuser stands in for the master only for the SET ON
//   PARAMETER grant and revoke, which no other local role can make.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repository = resolve(import.meta.dirname, '..');
const service = join(repository, 'services/ehr-api');
const { Client } = createRequire(join(service, 'package.json'))('pg');
const bindirIndex = process.argv.indexOf('--pg-bindir');
assert(process.argv.length === 2 || (process.argv.length === 4 && bindirIndex === 2),
  'Usage: node scripts/verify-non-superuser-database.mjs [--pg-bindir DIRECTORY]');
assert.notEqual(process.getuid?.(), 0, 'Run the disposable PostgreSQL check as a non-root user');

const superuser = 'cluster_superuser';
const admin = 'hid_rds_like_admin';
const database = 'hid_non_superuser';
const logins = {
  'identity-api': ['hid_rds_like_identity', 'hid_identity_api_runtime'],
  'ehr-api': ['hid_rds_like_ehr', 'hid_ehr_api_runtime'],
  'ehr-api-scanner': ['hid_rds_like_scanner', 'hid_document_scanner'],
  'lab-api': ['hid_rds_like_lab', 'hid_lab_api_runtime'],
  'pharmacy-api': ['hid_rds_like_pharmacy', 'hid_pharmacy_api_runtime'],
  'ocr-api': ['hid_rds_like_ocr_api', 'hid_ocr_api_runtime'],
  'ocr-worker': ['hid_rds_like_ocr_worker', 'hid_ocr_worker'],
  'outreach-api': ['hid_rds_like_outreach', 'hid_outreach_api_runtime'],
  'event-dispatcher': ['hid_rds_like_dispatcher', 'hid_event_dispatcher'],
  'notification-worker': ['hid_rds_like_notification', 'hid_notification_worker'],
};
const temporary = await mkdtemp('/tmp/hid-non-superuser.');
const data = join(temporary, 'data');
let pgBindir;
let started = false;
// The provisioning stage's cluster: same socket directory, its own port.
const provisioningData = join(temporary, 'provisioning-data');
const provisioningPort = 5433;
let provisioningStarted = false;
const evidence = { scope: 'local-synthetic-only', status: 'failed', administrator: {}, steps: {} };

// Only what each step needs: no inherited PG* or DATABASE_* variable.
function stepEnvironment(environment = {}) {
  return { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test',
    DATABASE_SSL: 'false', DATABASE_SSL_ROOT_CERT_BASE64: '', PGSSLMODE: 'disable', ...environment };
}

function run(label, executable, args, environment = {}, expected = 0) {
  const result = spawnSync(executable, args, {
    cwd: repository, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    env: stepEnvironment(environment),
  });
  assert.ifError(result.error);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expected === 'failure') assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  else assert.equal(result.status, expected, `${label} failed: ${output.slice(-1800)}`);
  return { stdout: result.stdout ?? '', output };
}

function url(user, db = database) {
  return `postgresql://${user}@localhost/${db}?host=${encodeURIComponent(temporary)}`;
}

function psql(label, user, sql, expected = 0, db = database) {
  return run(label, join(pgBindir, 'psql'),
    ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', temporary, '-U', user, '-d', db, '-c', sql], {}, expected);
}

function suite(name, user) {
  run(`${name} as ${user}`, join(pgBindir, 'psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', temporary,
    '-U', user, '-d', database, '-f', join(service, 'database/tests', name)]);
}

function migrate(label, expected = 0, db = database, flags = []) {
  return run(label, process.execPath, [join(service, 'scripts/apply-migrations.mjs'), ...flags],
    { DATABASE_URL: url(admin, db) }, expected);
}

function bootstrap(label, flags = [], db = database) {
  return run(label, process.execPath, [join(service, 'scripts/bootstrap-database-roles.mjs'), ...flags],
    { DATABASE_ADMIN_URL: url(admin, db) }).stdout.trim();
}

function verifyLogins(label, urls, expected = 0, flags = []) {
  const environment = { DATABASE_FORBIDDEN_LOGINS: `${admin},${superuser}` };
  for (const [credential, user] of Object.entries(urls)) {
    environment[`DATABASE_LOGIN_URL_${credential.toUpperCase().replaceAll('-', '_')}`] = url(user);
  }
  const { stdout } = run(label, process.execPath, [join(service, 'scripts/verify-runtime-logins.mjs'), ...flags],
    environment, expected);
  return JSON.parse(stdout);
}

// An Identity break-glass activation reads platform.control_settings
// (platform.require_control_enabled) and then inserts into
// identity.outbox_events, in one transaction. A second connection does the
// same around a bootstrap run: it holds `mode` on platform.control_settings,
// waits until the bootstrap has finished or waits for a lock, records that
// wait and the application tables the bootstrap holds, then takes the lock of
// the outbox insert (3 s at most) and commits. If the bootstrap held a lock on
// identity.outbox_events while it waited for platform.control_settings, the
// two would deadlock.
async function bootstrapWhileControlsHeld(label, mode) {
  const holder = new Client({ host: temporary, user: admin, database });
  const observer = new Client({ host: temporary, user: admin, database });
  holder.on('error', () => undefined);
  observer.on('error', () => undefined);
  await holder.connect();
  await observer.connect();
  try {
    await holder.query('begin');
    await holder.query(`lock table platform.control_settings in ${mode} mode`);
    const child = spawn(process.execPath, [join(service, 'scripts/bootstrap-database-roles.mjs')], {
      cwd: repository, env: stepEnvironment({ DATABASE_ADMIN_URL: url(admin) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let status;
    const exited = new Promise((resolveExit) => child.on('close', (code) => { status = code; resolveExit(code); }));
    let waited = null;
    const deadline = Date.now() + 60_000;
    while (status === undefined && waited === null && Date.now() < deadline) {
      const { rows } = await observer.query(`select lock_row.pid, lock_row.locktype,
          lock_row.relation::regclass::text as relation, lock_row.mode
        from pg_stat_activity activity join pg_locks lock_row on lock_row.pid = activity.pid
       where activity.application_name = 'hid-role-bootstrap' and not lock_row.granted`);
      if (rows.length > 0) waited = rows[0];
      else await delay(10);
    }
    const held = waited === null ? [] : (await observer.query(`select distinct relation.oid::regclass::text as relation
        from pg_locks lock_row
        join pg_class relation on relation.oid = lock_row.relation
        join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
       where lock_row.pid = $1 and lock_row.granted and lock_row.locktype = 'relation'
         and namespace_row.nspname in ('platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab',
             'pharmacy', 'outreach', 'integration', 'notification', 'migration')
       order by 1`, [waited.pid])).rows.map(({ relation }) => relation);
    const finishedBeforeOutboxLock = status !== undefined;
    let outboxLock = 'granted';
    try {
      await holder.query("set local lock_timeout = '3s'");
      await holder.query('lock table identity.outbox_events in row exclusive mode');
      await holder.query('commit');
    } catch (error) {
      outboxLock = error.code ?? String(error);
      await holder.query('rollback').catch(() => undefined);
    }
    await Promise.race([exited, delay(60_000, undefined, { ref: false })]);
    if (status === undefined) child.kill('SIGTERM');
    return {
      label,
      status,
      output: output.trim(),
      locks: {
        waited_for: waited && { relation: waited.relation ?? waited.locktype, mode: waited.mode },
        held_application_locks: held,
        finished_before_outbox_lock: finishedBeforeOutboxLock,
        outbox_insert_lock: outboxLock,
      },
    };
  } finally {
    await holder.end().catch(() => undefined);
    await observer.end().catch(() => undefined);
  }
}

// Gap 5: a new RDS instance has only its master; the provisioning task's
// script creates the migration administrator, makes and revokes the 0015
// parameter grant, and creates the ten runtime LOGINs from the passwords in
// their secrets. This runs it as the task would, on a second cluster.
async function provisioningStage() {
  const master = 'hid_rds_like_master';
  const administrator = 'hid_provisioned_admin';
  const target = 'hid';
  // Built with URL setters so no credential appears inline (verify-secret-readiness).
  const at = (user, secret, db = target) => {
    const url = new URL(`postgresql://localhost:${provisioningPort}/${db}?host=${encodeURIComponent(temporary)}`);
    url.username = encodeURIComponent(user);
    url.password = encodeURIComponent(secret);
    return url.toString();
  };
  const sql = (label, user, statements, expected = 0, db = target, environment = {}) => run(label, join(pgBindir, 'psql'),
    ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', temporary, '-p', String(provisioningPort), '-U', user, '-d', db,
      ...[statements].flat().flatMap((statement) => ['-c', statement])], environment, expected);
  const passwords = { admin: 'Provisioned-Admin-Password-0001' };
  const adminUrl = at(administrator, passwords.admin);
  const provision = (label, command, environment, expected = 0) => {
    const result = run(label, process.execPath, [join(service, 'scripts/provision-database-logins.mjs'), command],
      environment, expected);
    return { ...result, summary: expected === 0 ? JSON.parse(result.stdout) : null };
  };
  const asMaster = (masterUser = master) => ({ DATABASE_ADMIN_URL: adminUrl, DATABASE_MASTER_USERNAME: masterUser,
    DATABASE_MASTER_PASSWORD: 'unused-on-the-trusted-socket' });
  const loginName = (credential) => `hid_provisioned_${credential.replaceAll('-', '_')}`;
  const loginPassword = (credential, round = 1) => `Provisioned-${credential}-Password-${String(round).padStart(4, '0')}`;
  const runtimeUrls = (overrides = {}) => Object.fromEntries(Object.keys(logins).map((credential) => [
    `DATABASE_LOGIN_URL_${credential.toUpperCase().replaceAll('-', '_')}`,
    overrides[credential] ?? at(loginName(credential), loginPassword(credential))]));
  const provisionedRoles = () => sql('provisioned runtime roles', superuser,
    `select count(*) from pg_roles where rolname like 'hid\\_provisioned\\_%' and rolname <> '${administrator}'`)
    .stdout.trim();
  const steps = {};

  run('initialize the provisioning cluster', join(pgBindir, 'initdb'),
    ['-D', provisioningData, '-U', superuser, '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8',
      '--no-sync']);
  // The provisioned roles sign in with their passwords; the master and the
  // cluster superuser stay trusted on the private socket.
  const hba = join(provisioningData, 'pg_hba.conf');
  await writeFile(hba, `local all /^hid_provisioned_ scram-sha-256\n${await readFile(hba, 'utf8')}`);
  run('start the provisioning cluster', join(pgBindir, 'pg_ctl'), ['-D', provisioningData, '-l',
    join(temporary, 'provisioning.log'), '-o', `-h '' -k ${temporary} -p ${provisioningPort} `
      + '-c unix_socket_permissions=0700 -c fsync=off', '-w', 'start']);
  provisioningStarted = true;
  sql('create the RDS-like master and the database it owns', superuser,
    [`create role ${master} login nosuperuser nobypassrls createrole createdb noreplication`,
      `create database ${target} owner ${master}`], 0, 'postgres');

  // An administrator named after a HID group role (hid_migration_admin is one)
  // would own the whole chain and then stop the role bootstrap, which skips an
  // existing role and needs ADMIN OPTION on it; the script refuses the name
  // before it connects.
  const groupRoleAdministrator = provision('--administrator refuses a HID group role name', '--administrator',
    { ...asMaster(), DATABASE_ADMIN_URL: at('hid_migration_admin', passwords.admin) }, 'failure');
  assert.match(groupRoleAdministrator.output, /DATABASE_ADMIN_URL names the HID group role hid_migration_admin; /);
  assert.equal(sql('no role for the refused administrator name', superuser,
    "select count(*) from pg_roles where rolname = 'hid_migration_admin'", 0, 'postgres').stdout.trim(), '0');

  // The master creates the migration administrator with the password in its
  // URL (sent only as a SCRAM verifier) and CREATE on the database; a rerun
  // only sets the password again.
  const created = provision('--administrator as the master', '--administrator', asMaster()).summary;
  assert.equal(created.status, 'passed');
  assert.equal(created.administrator, administrator);
  assert.equal(created.created, true);
  assert.equal(provision('--administrator again', '--administrator', asMaster()).summary.created, false);
  assert.equal(sql('administrator attributes and CREATE', superuser,
    `select rolsuper || ',' || rolbypassrls || ',' || rolcreaterole || ',' || rolcreatedb || ',' || rolreplication
        || ',' || has_database_privilege(oid, '${target}', 'CREATE') || ',' || (rolpassword like 'SCRAM-SHA-256$4096:%')
       from pg_authid where rolname = '${administrator}'`).stdout.trim(), 'false,false,true,false,false,true,true');
  assert.equal(sql('the administrator signs in with its password', administrator, 'select current_user', 0, target,
    { PGPASSWORD: passwords.admin }).stdout.trim(), administrator);
  assert.match(sql('the administrator is refused another password', administrator, 'select 1', 'failure', target,
    { PGPASSWORD: 'example-wrong-password-0000' }).output, /password authentication failed/);
  steps.administrator = { created_by: master, attributes: 'NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION',
    create_on_database: target, password: 'SCRAM-SHA-256 verifier; signs in with it, refused another',
    refused_group_role_name: 'hid_migration_admin' };

  // 0015: the grant before the run, refused once 0015 is applied, and the revoke.
  assert.equal(provision('--grant-variable-conflict', '--grant-variable-conflict', asMaster(superuser)).summary.granted, true);
  assert.equal(sql('parameter privilege granted', superuser,
    `select has_parameter_privilege('${administrator}', 'plpgsql.variable_conflict', 'SET')`).stdout.trim(), 't');
  run('migrate as the provisioned administrator', process.execPath, [join(service, 'scripts/apply-migrations.mjs')],
    { DATABASE_URL: adminUrl });
  const revoked = provision('--revoke-variable-conflict', '--revoke-variable-conflict', asMaster(superuser)).summary;
  assert.equal(revoked.revoked, true);
  assert.equal(sql('parameter privilege revoked', superuser,
    `select has_parameter_privilege('${administrator}', 'plpgsql.variable_conflict', 'SET')`).stdout.trim(), 'f');
  const skipped = provision('--grant-variable-conflict after 0015', '--grant-variable-conflict', asMaster(superuser)).summary;
  assert.equal(skipped.granted, false);
  assert.equal(sql('parameter privilege still revoked', superuser,
    `select has_parameter_privilege('${administrator}', 'plpgsql.variable_conflict', 'SET')`).stdout.trim(), 'f');
  run('role bootstrap as the provisioned administrator', process.execPath,
    [join(service, 'scripts/bootstrap-database-roles.mjs')], { DATABASE_ADMIN_URL: adminUrl });
  steps.variable_conflict = { granted_before_migrations: true, revoked_after: revoked.ledger?.latest ?? null,
    not_granted_once_0015_applied: true };

  // Refusals: nothing is created or changed. A NOLOGIN role that is no HID
  // group role stands for a role created by hand with other attributes.
  sql('an existing NOLOGIN role that is no HID group role', master, 'create role hid_rds_like_nologin nologin');
  const refusals = {
    'shared login': [{ 'lab-api': at(loginName('identity-api'), loginPassword('identity-api')) },
      /share the LOGIN hid_provisioned_identity_api/],
    'administrator': [{ 'ehr-api': adminUrl }, /names the migration administrator or the RDS master/],
    'group role': [{ 'ehr-api': at('hid_ehr_api_runtime', loginPassword('ehr-api')) }, /names a HID group role/],
    'technical owner role': [{ 'notification-worker': at('hid_platform_control_reader', loginPassword('notification-worker')) },
      /DATABASE_LOGIN_URL_NOTIFICATION_WORKER names a HID group role/],
    'other database': [{ 'ocr-api': at(loginName('ocr-api'), loginPassword('ocr-api'), 'postgres') },
      /must point to the migration administrator's database/],
    'short password': [{ 'ocr-worker': at(loginName('ocr-worker'), 'Short-0001') }, /16 to 1024 printable ASCII/],
    'existing NOLOGIN role': [{ 'notification-worker': at('hid_rds_like_nologin', loginPassword('notification-worker')) },
      /role hid_rds_like_nologin exists with other attributes/],
  };
  for (const [label, [overrides, message]] of Object.entries(refusals)) {
    const refused = provision(`--runtime-logins refuses ${label}`, '--runtime-logins',
      { ...asMaster(), ...runtimeUrls(overrides) }, 'failure');
    assert.match(refused.output, message, label);
    assert.ok(!refused.output.includes('Password-0001') && !refused.output.includes('postgresql://'), label);
    assert.equal(provisionedRoles(), '0', `${label}: a refused run created no LOGIN`);
  }

  // The ten LOGINs, verified with their own passwords; a rerun changes nothing.
  const first = provision('--runtime-logins', '--runtime-logins', { ...asMaster(), ...runtimeUrls() }).summary;
  assert.equal(first.status, 'passed');
  assert.equal(first.logins.filter((login) => login.created).length, 10);
  assert.equal(first.verification.status, 'passed');
  assert.equal(first.verification.verified.length, 10);
  assert.deepEqual(first.verification.verified.map(({ credential, expected_role: role, login }) => [credential, role, login]),
    Object.entries(logins).map(([credential, [, role]]) => [credential, role, loginName(credential)]));
  assert.ok(!JSON.stringify(first).includes('Password-') && !JSON.stringify(first).includes('postgresql://'));
  assert.equal(provisionedRoles(), '10');
  const again = provision('--runtime-logins again', '--runtime-logins', { ...asMaster(), ...runtimeUrls() }).summary;
  assert.equal(again.logins.filter((login) => login.created).length, 0);
  assert.equal(again.verification.status, 'passed');

  // A rotated secret: the rerun sets the new password and the old one stops working.
  const rotated = at(loginName('identity-api'), loginPassword('identity-api', 2));
  assert.equal(provision('--runtime-logins after a rotation', '--runtime-logins',
    { ...asMaster(), ...runtimeUrls({ 'identity-api': rotated }) }).summary.verification.status, 'passed');
  assert.match(sql('the old identity password is refused', loginName('identity-api'), 'select 1', 'failure', target,
    { PGPASSWORD: loginPassword('identity-api') }).output, /password authentication failed/);
  assert.equal(sql('the new identity password signs in', loginName('identity-api'), 'select current_user', 0, target,
    { PGPASSWORD: loginPassword('identity-api', 2) }).stdout.trim(), loginName('identity-api'));

  // The task's default command verifies only, with the master and the
  // administrator forbidden.
  const verified = provision('--verify-logins', '--verify-logins',
    { ...asMaster(), ...runtimeUrls({ 'identity-api': rotated }) }).summary;
  assert.equal(verified.verification.status, 'passed');
  const forbidden = provision('--verify-logins refuses the administrator URL', '--verify-logins',
    { ...asMaster(), ...runtimeUrls({ 'identity-api': rotated, 'lab-api': adminUrl }) }, 'failure');
  assert.match(forbidden.output, /is the RDS master or the migration administrator/);
  steps.runtime_logins = { created: 10, verified: first.verification.verified.length, rerun_created: 0,
    rotation: 'new password set, old refused', refused: Object.keys(refusals), verify_only: 'passed; refuses the administrator URL' };
  return steps;
}

try {
  pgBindir = bindirIndex === 2 ? process.argv[3] : run('PostgreSQL bindir', 'pg_config', ['--bindir']).stdout.trim();
  evidence.postgresql = run('PostgreSQL version', join(pgBindir, 'postgres'), ['--version']).stdout.trim();
  const files = (await readdir(join(service, 'database/migrations'))).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  run('initialize private cluster', join(pgBindir, 'initdb'),
    ['-D', data, '-U', superuser, '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8', '--no-sync']);
  run('start socket-only cluster', join(pgBindir, 'pg_ctl'), ['-D', data, '-l', join(temporary, 'postgres.log'),
    '-o', `-h '' -k ${temporary} -c unix_socket_permissions=0700 -c fsync=off`, '-w', 'start']);
  started = true;

  run('create the migration administrator and its database', join(pgBindir, 'psql'),
    ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', temporary, '-U', superuser, '-d', 'postgres',
      '-c', `create role ${admin} login nosuperuser nobypassrls createrole nocreatedb noreplication`,
      '-c', `create database ${database} owner ${admin}`]);
  evidence.administrator = JSON.parse(psql('administrator attributes', superuser,
    `select row_to_json(r) from (select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
       from pg_roles where rolname = '${admin}') r`).stdout);
  assert.deepEqual(evidence.administrator, { rolsuper: false, rolbypassrls: false, rolcreaterole: true,
    rolcreatedb: false, rolreplication: false });

  // I3: without the parameter privilege the chain stops at 0015, after 0014 committed.
  const refused = migrate('migrate without SET ON PARAMETER', 'failure');
  assert.match(refused.output, /permission denied to set parameter "plpgsql\.variable_conflict"/);
  assert.equal(psql('applied before the grant', admin,
    'select count(*) || \':\' || max(version) from migration.schema_migrations').stdout.trim(),
  '14:0014_ocr_worker_leases.sql');
  psql('grant SET ON PARAMETER for the migration run', superuser,
    `grant set on parameter plpgsql.variable_conflict to ${admin}`);
  migrate('migrate 0015 to the latest migration');
  psql('revoke SET ON PARAMETER after the migration run', superuser,
    `revoke set on parameter plpgsql.variable_conflict from ${admin}`);
  assert.equal(psql('parameter privilege revoked', superuser,
    `select has_parameter_privilege('${admin}', 'plpgsql.variable_conflict', 'SET')`).stdout.trim(), 'f');
  assert.match(migrate('migration rerun').stdout, /^0 pending migration\(s\)/);
  assert.equal(psql('latest migration applied', admin,
    'select count(*) || \':\' || max(version) from migration.schema_migrations').stdout.trim(),
  `${files.length}:${files.at(-1)}`);
  evidence.steps.migrations = { refused_at: '0015_ocr_claim_column_resolution.sql', applied_before_grant: 14,
    applied: files.length, latest: files.at(-1), set_on_parameter: 'granted for the run, then revoked' };
  // Before the first bootstrap the administrator cannot read a control: the
  // table's forced row-level security hides the row from platform.control_enabled,
  // which it still owns. Break-glass's migration read the control this way
  // above and, finding it unreadable, applied (its precondition below).
  assert.match(psql('control read before the first bootstrap', admin,
    `select platform.control_enabled('break_glass_enabled')`, 'failure').output, /PLATFORM_CONTROL_UNAVAILABLE/);

  // P8-BOOTSTRAP: the role bootstrap and its assertions, twice, then verify-only.
  // Each run overlaps a transaction that holds a lock on platform.control_settings
  // and then locks identity.outbox_events, as a break-glass activation does (an
  // ACCESS SHARE read) or a control change (ROW EXCLUSIVE). The first run creates
  // the control policy, so it waits for platform.control_settings, before it
  // locks any other application table; the second run finds the policy and takes
  // no lock on that table. Neither may deadlock with the transaction.
  const firstRun = await bootstrapWhileControlsHeld('role bootstrap (first run)', 'access share');
  const secondRun = await bootstrapWhileControlsHeld('role bootstrap (second run)', 'row exclusive');
  evidence.steps.bootstrap_lock_order = { first_run: firstRun.locks, second_run: secondRun.locks };
  assert.deepEqual(firstRun.locks.held_application_locks, [],
    'the first bootstrap held application table locks while it waited for platform.control_settings');
  assert.deepEqual(firstRun.locks.waited_for, { relation: 'platform.control_settings', mode: 'AccessExclusiveLock' });
  assert.deepEqual(secondRun.locks.waited_for, null, 'the second bootstrap waited for a lock');
  assert.equal(secondRun.locks.finished_before_outbox_lock, true);
  for (const { label, status, output, locks } of [firstRun, secondRun]) {
    assert.equal(status, 0, `${label} failed: ${output.slice(-1800)}`);
    assert.equal(locks.outbox_insert_lock, 'granted', `${label}: the outbox insert lock was refused`);
  }
  evidence.steps.bootstrap = [firstRun.output, secondRun.output, bootstrap('db:verify-roles', ['--verify-only'])];
  assert.deepEqual(evidence.steps.bootstrap, ['Runtime database roles provisioned and verified',
    'Runtime database roles provisioned and verified', 'Runtime database role verification passed']);

  // A runtime group role must hold no ADMIN OPTION in a technical owner, even
  // without INHERIT or SET: it could grant the owner to its own login and
  // SET ROLE to it. Only the administrator's own creator row is allowed.
  psql('grant a runtime role ADMIN OPTION in a technical owner', admin,
    'grant hid_ocr_queue_metrics to hid_ocr_worker with admin true, inherit false, set false');
  const misgrant = run('db:verify-roles refuses an ADMIN OPTION membership of a runtime role', process.execPath,
    [join(service, 'scripts/bootstrap-database-roles.mjs'), '--verify-only'], { DATABASE_ADMIN_URL: url(admin) },
    'failure');
  assert.match(misgrant.output, /technical owner hid_ocr_queue_metrics has a member, a membership or schema CREATE privilege/);
  psql('revoke the runtime role\'s ADMIN OPTION', admin, 'revoke hid_ocr_queue_metrics from hid_ocr_worker');
  assert.equal(bootstrap('db:verify-roles after the revoke', ['--verify-only']), 'Runtime database role verification passed');
  evidence.steps.technical_owner_membership = { refused: 'ADMIN OPTION of hid_ocr_worker in hid_ocr_queue_metrics' };
  assert.equal(psql('no temporary membership left', superuser,
    `select count(*) from pg_auth_members m join pg_roles r on r.oid = m.roleid
      where r.rolname like 'hid\\_%' and m.member = '${admin}'::regrole
        and (m.inherit_option or m.set_option)`).stdout.trim(), '0');

  // DB-LOGIN-VERIFY: one LOGIN per runtime credential, created by the administrator.
  psql('create the runtime logins', admin, Object.values(logins)
    .map(([login, role]) => `create role ${login} login; grant ${role} to ${login};`).join(' '));
  const loginUrls = Object.fromEntries(Object.entries(logins).map(([credential, [login]]) => [credential, login]));
  const passed = verifyLogins('db:verify-logins for every runtime credential', loginUrls);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.verified.length, 10);
  const asAdministrator = verifyLogins('db:verify-logins refuses the administrator URL',
    { 'identity-api': admin }, 'failure', ['--partial']);
  assert.match(asAdministrator.failures[0].failure, /is the RDS master or the migration administrator/);
  psql('create a login with an extra role', admin,
    'create role hid_rds_like_extra login; grant hid_identity_api_runtime, hid_schema_test_runtime to hid_rds_like_extra');
  const extra = verifyLogins('db:verify-logins refuses an extra role', { 'identity-api': 'hid_rds_like_extra' },
    'failure', ['--partial']);
  assert.match(extra.failures[0].failure, /reaches roles its aggregate does not: hid_schema_test_runtime/);
  const other = verifyLogins('db:verify-logins refuses another service\'s login',
    { 'ehr-api': 'hid_rds_like_identity' }, 'failure', ['--partial']);
  assert.match(other.failures[0].failure, /must be a direct member of hid_ehr_api_runtime only/);
  evidence.steps.logins = { verified: passed.verified.map(({ credential, expected_role }) =>
    ({ credential, expected_role })), refused: ['administrator URL', 'extra role', 'another service login'] };

  // P8-CONTROL: the guards' control reads, as each guard's runtime login. The
  // last three are the launch controls 0091 turns off where 0039 left them
  // seeded: the administrator owns platform.control_settings, whose forced
  // row-level security hides every row from it, so the migration's update
  // reaches the rows only with forced security lifted for its transaction.
  const controls = {};
  for (const credential of ['identity-api', 'ehr-api', 'outreach-api']) {
    controls[credential] = psql(`platform controls as ${credential}`, logins[credential][0],
      `select platform.control_enabled('patient_portal_enabled') || ',' || platform.control_enabled('provider_portal_enabled')
         || ',' || platform.control_enabled('maintenance_mode') || ',' || platform.control_enabled('uploads_enabled')
         || ',' || platform.control_enabled('outreach_portal_enabled') || ',' || platform.control_enabled('break_glass_enabled')
         || ',' || platform.control_enabled('clinician_signup_enabled');
       select platform.require_control_enabled('patient_portal_enabled')`)
      .stdout.trim().split('\n')[0];
    assert.equal(controls[credential], 'true,true,false,false,false,false,false');
  }
  evidence.steps.platform_controls = { read_as: controls, owner: psql('control owner', superuser,
    `select proowner::regrole from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure`).stdout.trim() };
  assert.equal(evidence.steps.platform_controls.owner, 'hid_platform_control_reader');

  // P10 and P11 as the operator runs them: the release checklist's read-only
  // SQL, as the migration administrator. That administrator owns
  // platform.control_settings but is subject to its forced row-level security
  // (NOBYPASSRLS), so a check that read the table directly would fail here.
  const checklist = await readFile(join(repository, 'docs/PHASE_4_STAGE_5_RELEASE_READINESS.md'), 'utf8');
  const checklistCheck = async (heading) => {
    const start = checklist.indexOf(`\n${heading}`);
    assert.notEqual(start, -1, `the release checklist has no "${heading}"`);
    const block = /\n```sql\n([\s\S]*?)\n```/.exec(checklist.slice(start));
    assert(block, `the release checklist has no SQL block after "${heading}"`);
    const file = join(temporary, `${heading.split(' ')[0].toLowerCase()}-check.sql`);
    await writeFile(file, `${block[1]}\n`, { mode: 0o600 });
    return run(`release checklist ${heading} as the migration administrator`, join(pgBindir, 'psql'),
      ['-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-h', temporary, '-U', admin, '-d', database, '-f', file])
      .stdout.trim().split('\n').filter(Boolean);
  };
  const p10 = await checklistCheck('P10 check (read-only)');
  assert.deepEqual(p10.map((line) => line.split('|').slice(0, 4).join('|')),
    ['break_glass_enabled|f', 'direct-care|Direct patient care|t|hid', 'emergency|Emergency treatment|t|hid'],
    `P10 check: ${p10.join('; ')}`);
  // After 0097, clinician self sign-up's migration and the bootstrap: the four
  // launch controls off (break-glass until the operator turns it on, P11;
  // clinician sign-up until P37), no healthcare-operations purpose, no
  // permission 0084 or 0091 withdrew, break-glass granted to exactly the three
  // roles 0097 names, and no control event.
  const p11 = await checklistCheck('P11 check (read-only)');
  assert.deepEqual(p11, ['break_glass_enabled|f', 'clinician_signup_enabled|f', 'outreach_portal_enabled|f',
    'uploads_enabled|f',
    'clinician|identity.break-glass.write', 'doctor|identity.break-glass.write', 'nurse|identity.break-glass.write'],
  `P11 check: ${p11.join('; ')}`);
  // P35 (ADR-064): the owners and the only executors of 0095's two functions.
  const p35 = await checklistCheck('P35 check (read-only)');
  assert.deepEqual(p35, [`integration.notification_recipient_state(uuid)|${admin}|t|hid_event_delivery_commands`,
    'integration.notification_recipient_for_claim(uuid,uuid,uuid)|hid_event_delivery_commands|t|hid_notification_worker'],
  `P35 check: ${p35.join('; ')}`);
  evidence.steps.release_checklist_checks = { run_as: admin, p10: p10.map((line) => line.split('|').slice(0, 4).join('|')),
    p11, p35 };

  // 0095 (ADR-064): the worker login claims an Identity event and learns the
  // patient's verified login email through the claim, as the real login of
  // its aggregate (session_user binding, no superuser). The superuser only
  // seeds the synthetic rows, as a test fixture (replica mode: no triggers or
  // foreign keys behind the outbox rows).
  const recipientFixture = {
    verified: { account: 'e9b00000-0000-4000-8000-000000000001', patient: 'e9c00000-0000-4000-8000-000000000001',
      event: 'e9d00000-0000-4000-8000-000000000001', email: 'rds-like-recipient@example.invalid' },
    phoneOnly: { account: 'e9b00000-0000-4000-8000-000000000002', patient: 'e9c00000-0000-4000-8000-000000000002',
      event: 'e9d00000-0000-4000-8000-000000000002' },
  };
  psql('seed synthetic notification recipients', superuser, `begin; set local session_replication_role = replica;
    insert into auth.accounts (id, subject, email, status, email_verified_at) values
      ('${recipientFixture.verified.account}', 'synthetic:rds-like:recipient:1', '${recipientFixture.verified.email}', 'active', clock_timestamp()),
      ('${recipientFixture.phoneOnly.account}', 'synthetic:rds-like:recipient:2', null, 'active', null);
    insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name) values
      ('${recipientFixture.verified.patient}', '${recipientFixture.verified.account}', 'HID-RDSNVA', 'Synthetic', 'Verified', 'Synthetic Verified'),
      ('${recipientFixture.phoneOnly.patient}', '${recipientFixture.phoneOnly.account}', 'HID-RDSNVB', 'Synthetic', 'Phone', 'Synthetic Phone');
    insert into identity.outbox_events (event_id, event_type, aggregate_id, aggregate_version, facility_id, patient_id,
      correlation_id, payload) values
      ('${recipientFixture.verified.event}', 'PatientRegistered', gen_random_uuid(), 1, gen_random_uuid(),
       '${recipientFixture.verified.patient}', 'rds-like-recipient-0001', '{}'),
      ('${recipientFixture.phoneOnly.event}', 'PatientRegistered', gen_random_uuid(), 1, gen_random_uuid(),
       '${recipientFixture.phoneOnly.patient}', 'rds-like-recipient-0002', '{}');
    commit;`);
  const worker = logins['notification-worker'][0];
  const recipients = {};
  for (const [name, fixture] of Object.entries(recipientFixture)) {
    const token = psql(`claim the ${name} event as the worker login`, worker,
      `select claim_token from integration.claim_inbox_message('notification-worker-v1', '${fixture.event}', 'identity',
         'PatientRegistered', 1, 'rds-like-recipient-000${name === 'verified' ? 1 : 2}', repeat('a', 64)::character(64),
         'notification-worker-rds-like', 60)`).stdout.trim();
    assert.match(token, /^[0-9a-f-]{36}$/);
    recipients[name] = psql(`recipient for the ${name} claim as the worker login`, worker,
      `select delivery || '|' || coalesce(email, '') from integration.notification_recipient_for_claim(
         '${fixture.event}', '${token}', '${fixture.patient}')`).stdout.trim();
  }
  assert.deepEqual(recipients, { verified: `email|${recipientFixture.verified.email}`, phoneOnly: 'withhold|' });
  const workerDirect = psql('the worker login reads no patient row', worker,
    'select count(*) from identity.patients', 'failure');
  assert.match(workerDirect.output, /permission denied for (schema identity|table patients)/);
  const refusedLogins = {};
  for (const credential of ['identity-api', 'event-dispatcher']) {
    const refused = psql(`the recipient lookup as the ${credential} login`, logins[credential][0],
      `select * from integration.notification_recipient_for_claim('${recipientFixture.verified.event}',
         gen_random_uuid(), '${recipientFixture.verified.patient}')`, 'failure');
    const refusal = /permission denied for (schema integration|function notification_recipient_for_claim)/.exec(refused.output);
    assert(refusal, `the ${credential} login was not refused the recipient lookup: ${refused.output.slice(-400)}`);
    refusedLogins[credential] = refusal[0];
  }
  evidence.steps.notification_recipient = { run_as: worker, answers: { verified: 'email', phone_only: 'withhold' },
    direct_patient_read: /permission denied for \S+ \S+/.exec(workerDirect.output)[0], refused: refusedLogins };

  // P37's daily reviews of recent clinician approvals (ADR-066), as the
  // operator runs them: MIGRATION_RUNBOOK.md §6's read-only SQL, as the
  // migration administrator. The in-person checks force row-level security,
  // so a review that set row_security off would fail here; the administrator
  // reads them as the system actor. No application is approved on this
  // database, so each review answers no rows.
  const runbook = await readFile(join(repository, 'docs/MIGRATION_RUNBOOK.md'), 'utf8');
  const runbookCheck = async (name, lead) => {
    const start = runbook.search(new RegExp(lead.split(' ')
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')));
    assert.notEqual(start, -1, `MIGRATION_RUNBOOK.md has no "${lead}"`);
    const block = /\n```sql\n([\s\S]*?)\n```/.exec(runbook.slice(start));
    assert(block, `MIGRATION_RUNBOOK.md has no SQL block after "${lead}"`);
    const file = join(temporary, `${name}-review.sql`);
    await writeFile(file, `${block[1]}\n`, { mode: 0o600 });
    return run(`runbook ${name} review as the migration administrator`, join(pgBindir, 'psql'),
      ['-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-h', temporary, '-U', admin, '-d', database, '-f', file])
      .stdout.trim().split('\n').filter((line) => line && line !== 'system:auth');
  };
  const breakGlassReview = await runbookCheck('break-glass', 'review daily (P37) the break-glass activations');
  const inPersonReview = await runbookCheck('in-person', 'review daily (P37) the in-person checks');
  assert.deepEqual([breakGlassReview, inPersonReview], [[], []],
    `P37 reviews: ${JSON.stringify({ breakGlassReview, inPersonReview })}`);
  evidence.steps.runbook_recent_approval_reviews = { run_as: admin, break_glass_rows: 0, in_person_check_rows: 0 };

  // Break-glass's migration (0097, D9, ADR-058 addendum) refuses to run while
  // break_glass_enabled is on: 0091 turned the control off only where 0039's
  // seed was untouched, and granting the permission with the control on would
  // make break-glass live at the migration's commit, before staff MFA ships
  // and the P11 operator step. Its SQL runs again here as the administrator,
  // now that platform.control_enabled has its technical owner, each time in a
  // transaction that is rolled back. The cluster superuser turns the control
  // on in the first (an operator would use POST /admin/controls).
  const breakGlassMigration = files.find((name) => /^\d{4}_break_glass_launch_with_limits\.sql$/.test(name));
  assert(breakGlassMigration, 'the break-glass migration is missing');
  const breakGlassSql = await readFile(join(service, 'database/migrations', breakGlassMigration), 'utf8');
  const rerunBreakGlassMigration = async (controlOn) => {
    const client = new Client({ host: temporary, user: superuser, database });
    await client.connect();
    try {
      await client.query('begin');
      if (controlOn) {
        await client.query(`update platform.control_settings set enabled = true, row_version = row_version + 1
          where control_key = 'break_glass_enabled'`);
      }
      await client.query(`set local role ${admin}`);
      await client.query(breakGlassSql);
      return { applied: true };
    } catch (error) {
      return { applied: false, code: error.code, message: error.message };
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  };
  const withControlOn = await rerunBreakGlassMigration(true);
  assert.deepEqual([withControlOn.applied, withControlOn.code], [false, '55000'],
    `break-glass's migration ran with break_glass_enabled on: ${JSON.stringify(withControlOn)}`);
  assert.match(withControlOn.message, /^BREAK_GLASS_CONTROL_ON: /);
  const withControlOff = await rerunBreakGlassMigration(false);
  assert.deepEqual(withControlOff, { applied: true }, `break-glass's migration with the control off: ${JSON.stringify(withControlOff)}`);
  assert.equal(psql('break-glass control after the reruns', admin,
    `select platform.control_enabled('break_glass_enabled')`).stdout.trim(), 'f');
  evidence.steps.break_glass_migration_precondition = { migration: breakGlassMigration, run_as: admin,
    before_first_bootstrap: 'control unreadable (PLATFORM_CONTROL_UNAVAILABLE), applied',
    control_on: `refused ${withControlOn.code} ${withControlOn.message.split(':')[0]}`, control_off: 'applied, rolled back' };

  // I3 at call time: the claim runs its body without the parameter privilege.
  const claim = psql('OCR claim without a workload context', logins['ocr-worker'][0],
    `select * from ocr.claim_worker_job('synthetic-provider', 300)`, 'failure');
  assert.match(claim.output, /Authorized OCR workload context is required/);
  assert.doesNotMatch(claim.output, /permission denied to set parameter/);
  evidence.steps.ocr_claim = { refused_by: 'body authorization check', parameter_privilege_needed: false };

  // ADR-067: the importer as the administrator, who is not a superuser: its
  // in-transaction membership in hid_migration_admin (held through the ADMIN
  // OPTION of the roles it created) runs the import command, and is gone after.
  const imported = JSON.parse(run('imported history import as the administrator', process.execPath,
    [join(service, 'scripts/rehearse-imported-history-import.mjs')], {
      DATABASE_URL: url(admin), MIGRATION_FIELD_KEY_REFERENCE: 'public-synthetic-test-vector-v1',
      // Public test vectors, never operational secrets.
      MIGRATION_FIELD_ENCRYPTION_KEY_B64: Buffer.alloc(32, 0x11).toString('base64'),
      MIGRATION_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 0x22).toString('base64'),
      CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 0x44).toString('base64'),
      CUTOVER_EXPECTED_PIN_COUNT: '0', CUTOVER_EXPECTED_GOOGLE_COUNT: '0',
      CUTOVER_EXPECTED_PLANNED_CAMPAIGN_COUNT: '0', CUTOVER_EXPECTED_QUEUED_ENCOUNTER_COUNT: '0' }).stdout);
  assert.equal(imported.status, 'passed', `imported history import: ${imported.failure}`);
  assert.equal(imported.steps.import.administrator_superuser, false);
  assert.equal(psql('no imported history membership left', superuser,
    `select count(*) from pg_auth_members m where m.roleid = 'hid_migration_admin'::regrole
      and m.member = '${admin}'::regrole and (m.inherit_option or m.set_option)`).stdout.trim(), '0');
  evidence.steps.imported_history_import = imported.steps;

  // The upgrade path of clinician self sign-up (ADR-066, P1 of its design): on
  // RDS platform.control_enabled already belongs to hid_platform_control_reader
  // when the migration runs, and the administrator holds only the creator's
  // ADMIN OPTION in that role. The main database above was migrated whole
  // before its first bootstrap, when the administrator still owned the
  // function, so it never exercised that path.
  const signupMigration = files.find((name) => /^\d{4}_clinician_self_signup\.sql$/.test(name));
  assert(signupMigration, 'the clinician self sign-up migration is missing');
  const previousHead = files[files.indexOf(signupMigration) - 1];
  const upgrade = 'hid_non_superuser_upgrade';
  run('create the upgrade database', join(pgBindir, 'psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', temporary,
    '-U', superuser, '-d', 'postgres', '-c', `create database ${upgrade} owner ${admin}`]);
  psql('grant SET ON PARAMETER for the run through the previous head', superuser,
    `grant set on parameter plpgsql.variable_conflict to ${admin}`);
  migrate(`migrate the upgrade database through ${previousHead}`, 0, upgrade, ['--through', previousHead]);
  psql('revoke SET ON PARAMETER before the upgrade', superuser,
    `revoke set on parameter plpgsql.variable_conflict from ${admin}`);
  assert.equal(psql('upgrade database before the upgrade', admin,
    'select count(*) || \':\' || max(version) from migration.schema_migrations', 0, upgrade).stdout.trim(),
  `${files.indexOf(signupMigration)}:${previousHead}`);
  // A chain migrated before its first role bootstrap: the migration
  // administrator still owns platform.control_enabled when this migration
  // runs, and nothing requires that administrator's name to be lower case. The
  // migration must take the owner-is-current-user path with a name that needs
  // quoting (a regrole cast would quote it, so the owner would not compare
  // equal and the membership probe would name a role that does not exist). It
  // runs here as such an administrator, which owns the function and holds the
  // administrator's privileges, in a transaction that is rolled back.
  const quotedAdministrator = 'HidAdmin';
  const signupSql = await readFile(join(service, 'database/migrations', signupMigration), 'utf8');
  const quotedRun = await (async () => {
    const client = new Client({ host: temporary, user: superuser, database: upgrade });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`create role "${quotedAdministrator}" nologin nosuperuser nobypassrls`);
      await client.query(`grant ${admin} to "${quotedAdministrator}" with inherit true`);
      await client.query(`alter function platform.control_enabled(text) owner to "${quotedAdministrator}"`);
      await client.query(`set local role "${quotedAdministrator}"`);
      await client.query(signupSql);
      const owner = (await client.query(`select pg_get_userbyid(proowner) as owner from pg_proc
        where oid = 'platform.control_enabled(text)'::regprocedure`)).rows[0].owner;
      const memberships = Number((await client.query(`select count(*) as n from pg_auth_members
        where member = (select oid from pg_roles where rolname = $1) and roleid <> (select oid from pg_roles
          where rolname = $2)`, [quotedAdministrator, admin])).rows[0].n);
      return { applied: true, owner, memberships };
    } catch (error) {
      return { applied: false, code: error.code, message: error.message };
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  })();
  assert.deepEqual(quotedRun, { applied: true, owner: quotedAdministrator, memberships: 0 },
    `${signupMigration} as an administrator whose name needs quoting: ${JSON.stringify(quotedRun)}`);
  assert.equal(psql('the quoted administrator was rolled back', superuser,
    `select count(*) from pg_roles where rolname = '${quotedAdministrator}'`, 0, upgrade).stdout.trim(), '0');
  evidence.steps.clinician_signup_quoted_owner = { database: upgrade, migrated_through: previousHead,
    run_as: quotedAdministrator, owner_before: quotedAdministrator, applied: 'rolled back',
    owner_after: quotedRun.owner, temporary_memberships_left: quotedRun.memberships };
  // The previous release's bootstrap left platform.control_enabled to its
  // technical owner. This release's bootstrap cannot run before this
  // migration (it grants the new commands), so the previous one's P8-CONTROL
  // statements, which this release does not change, run here as it ran them:
  // in one transaction, under a temporary membership revoked at its end.
  const grantsSql = await readFile(join(service, 'database/runtime-grants.sql'), 'utf8');
  const controlStart = grantsSql.indexOf('-- Launch (P8-CONTROL)');
  const controlEndMarker = 'revoke create on schema platform from hid_platform_control_reader;';
  const controlEnd = grantsSql.indexOf(controlEndMarker, controlStart);
  assert(controlStart > 0 && controlEnd > controlStart, 'runtime-grants.sql has no P8-CONTROL block');
  const previousBootstrap = join(temporary, 'previous-control-bootstrap.sql');
  await writeFile(previousBootstrap, ["set createrole_self_grant = '';",
    'grant hid_platform_control_reader to current_user with inherit true, set true;',
    grantsSql.slice(controlStart, controlEnd + controlEndMarker.length),
    'revoke hid_platform_control_reader from current_user;', ''].join('\n'), { mode: 0o600 });
  run('the previous bootstrap of platform.control_enabled', join(pgBindir, 'psql'), ['-X', '-q', '-1', '-v',
    'ON_ERROR_STOP=1', '-h', temporary, '-U', admin, '-d', upgrade, '-f', previousBootstrap]);
  const ownerBefore = psql('control owner before the upgrade', superuser,
    `select proowner::regrole from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure`, 0, upgrade).stdout.trim();
  assert.equal(ownerBefore, 'hid_platform_control_reader');
  assert.equal(psql('the administrator lacks the owner\'s privileges', superuser,
    `select pg_has_role('${admin}', 'hid_platform_control_reader', 'USAGE') || ',' ||
       pg_has_role('${admin}', 'hid_platform_control_reader', 'MEMBER WITH ADMIN OPTION')`, 0, upgrade).stdout.trim(),
  'false,true');
  const upgraded = migrate(`apply ${signupMigration} as the administrator`, 0, upgrade);
  assert.match(upgraded.stdout, new RegExp(`Applied ${signupMigration.replace('.', '\\.')}`));
  assert.equal(bootstrap('role bootstrap after the upgrade', [], upgrade), 'Runtime database roles provisioned and verified');
  assert.equal(bootstrap('db:verify-roles after the upgrade', ['--verify-only'], upgrade),
    'Runtime database role verification passed');
  const ownerAfter = psql('control owner after the upgrade', superuser,
    `select proowner::regrole from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure`, 0, upgrade).stdout.trim();
  assert.equal(ownerAfter, 'hid_platform_control_reader');
  assert.equal(psql('no membership left after the upgrade', superuser,
    `select count(*) from pg_auth_members m join pg_roles r on r.oid = m.roleid
      where r.rolname like 'hid\\_%' and m.member = '${admin}'::regrole
        and (m.inherit_option or m.set_option)`).stdout.trim(), '0');
  const upgradeReads = {};
  for (const credential of ['identity-api', 'ehr-api', 'outreach-api']) {
    upgradeReads[credential] = psql(`clinician sign-up control as ${credential} after the upgrade`, logins[credential][0],
      `select platform.control_enabled('clinician_signup_enabled') || ',' || platform.control_enabled('provider_portal_enabled')`,
      0, upgrade).stdout.trim();
    assert.equal(upgradeReads[credential], 'false,true');
  }
  evidence.steps.clinician_signup_upgrade_path = { database: upgrade, migrated_through: previousHead,
    applied: signupMigration, run_as: admin, set_on_parameter: 'not held for the upgrade',
    before_upgrade: 'the previous bootstrap\'s P8-CONTROL statements (owner transfer, reader policy and column grant)',
    control_owner: { before: ownerBefore, after: ownerAfter },
    administrator_inherit_or_set_memberships_after: 0, control_read_as: upgradeReads };

  // Owner decision 2026-10-16 (SUPERADMIN-ACCOUNTS, "By email, own password"):
  // on a new database admin:bootstrap takes two or three email addresses
  // (PLATFORM_ADMIN_EMAILS), creates a platform-only account for each, with no
  // password, pending_reset, and grants each Super Admin in one audited
  // transaction; each person then sets their own password with the admin
  // reset and enrols an authenticator at the first platform sign-in. The
  // whole path runs here on a copy of the main database taken before its first
  // Super Admin (the cluster superuser makes the copy; that is scaffolding,
  // not a step RDS runs). The bootstrap runs as the migration administrator;
  // the recovery and the sign-in run as the Identity runtime LOGIN, in SQL
  // taken from the Identity source and then over HTTP through the real
  // controllers (verify-platform-admin-email-bootstrap-runtime.mjs).
  const emailDatabase = 'hid_non_superuser_email';
  run('copy the main database before its first Super Admin', join(pgBindir, 'psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-h', temporary, '-U', superuser, '-d', 'postgres', '-c', `create database ${emailDatabase} template ${database} owner ${admin}`]);
  const emailSql = (label, sql, expected = 0) => psql(label, admin, sql, expected, emailDatabase).stdout.trim();
  const emailBootstrap = (label, environment, expected = 0) => run(label, process.execPath,
    [join(service, 'scripts/bootstrap-platform-admin.mjs')], { DATABASE_ADMIN_URL: url(admin, emailDatabase),
      PLATFORM_ADMIN_BOOTSTRAP_REASON: 'Initial platform governance set by email (synthetic)', ...environment }, expected);
  const emailState = () => emailSql('platform accounts and Super Admin grants',
    `select (select count(*) from auth.accounts where subject like 'platform:%') || ':'
        || (select count(*) from auth.accounts where subject like 'platform:%' and status <> 'deleted') || ':'
        || (select count(*) from auth.account_roles where role_code = 'platform_super_admin' and revoked_at is null)`);
  const ownedAddress = 'example-existing-account@example.invalid';
  const [adminOne, adminTwo, adminThree, mistyped] = ['one', 'two', 'three', 'twoo']
    .map((label) => `example-platform-admin-${label}@example.invalid`);
  const existingIds = [randomUUID(), randomUUID()];
  emailSql('an existing account with a password, and two more for the account ID form', existingIds.map((id, index) =>
    `insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
       values ('${id}', 'synthetic:platform-email-bootstrap:existing-${index}',
         ${index === 0 ? `'${ownedAddress}'` : `'example-existing-${index}@example.invalid'`},
         'Existing Account ${index}', 'active', 'synthetic-hash', 'argon2id');`).join(' ')
    + ` insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
       values ('${randomUUID()}', 'synthetic:platform-email-bootstrap:existing-2', 'example-existing-2@example.invalid',
         'Existing Account 2', 'active', 'synthetic-hash', 'argon2id')`);
  const idsIn = (text) => text.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) ?? [];

  // Refusals change nothing and never print an address.
  const emailRefusals = {
    'an address that already belongs to an account': [{ PLATFORM_ADMIN_EMAILS: `${adminOne},${ownedAddress.toUpperCase()}` },
      /Bootstrap refused: PLATFORM_ADMIN_EMAILS entry 2 already belongs to an account; name existing accounts in PLATFORM_ADMIN_ACCOUNT_IDS/],
    'replace-pending with nothing to replace': [{ PLATFORM_ADMIN_EMAILS: `${adminOne},${adminTwo}`, PLATFORM_ADMIN_REPLACE_PENDING: '1' },
      /PLATFORM_ADMIN_REPLACE_PENDING=1 but no Super Admin exists to replace/],
    'one address': [{ PLATFORM_ADMIN_EMAILS: adminOne }, /PLATFORM_ADMIN_EMAILS must list two or three/],
    'a display name': [{ PLATFORM_ADMIN_EMAILS: `Example Admin <${adminOne}>,${adminTwo}` }, /not a single plain email address/],
  };
  for (const [label, [environment, message]] of Object.entries(emailRefusals)) {
    const refused = emailBootstrap(`admin:bootstrap by email refuses ${label}`, environment, 'failure');
    assert.match(refused.output, message, label);
    assert.ok(!/@example\.invalid/i.test(refused.output), `${label}: the refusal printed an address`);
    assert.equal(emailState(), '0:0:0', `${label}: a refused bootstrap created or granted nothing`);
  }

  // The first run, with a mistyped second address.
  const firstEmailRun = emailBootstrap('admin:bootstrap seeds three Super Admins by email',
    { PLATFORM_ADMIN_EMAILS: `${adminOne} ${mistyped} ${adminThree}` });
  assert.match(firstEmailRun.stdout, /Platform Super Admin bootstrap created 3 platform-only accounts without a password/);
  assert.ok(!firstEmailRun.output.includes('@'), 'the bootstrap printed an address');
  const firstIds = idsIn(firstEmailRun.stdout);
  assert.equal(new Set(firstIds).size, 3);
  assert.equal(emailState(), '3:3:3');
  const seededAccount = (id, address) => [id, `platform:${id}`, address, 'true', 'pending_reset', 'true', 'true', 'hid',
    '0', '0', 'platform_super_admin', 'true', '1'].join('|');
  // Each account's row, with one audit event naming the whole set it was seeded with.
  const accountRows = (ids, set = ids) => emailSql('the email-seeded accounts, grants and audit', `select account.id || '|' || account.subject
      || '|' || account.email || '|' || (account.display_name is null) || '|' || account.status || '|'
      || (account.password_hash is null and account.password_algorithm is null) || '|' || (account.email_verified_at is null)
      || '|' || account.source_system
      || '|' || (select count(*) from identity.staff staff_row where staff_row.account_id = account.id)
      || '|' || (select count(*) from identity.patients patient_row where patient_row.account_id = account.id)
      || '|' || (select string_agg(assignment.role_code, ',') from auth.account_roles assignment
                  where assignment.account_id = account.id and assignment.revoked_at is null
                    and assignment.scope_type = 'platform')
      || '|' || (select bool_and(assignment.granted_by is null) from auth.account_roles assignment
                  where assignment.account_id = account.id)
      || '|' || (select count(*) from audit.events event where event.action = 'admin.platform-role.bootstrap'
                  and event.resource_id = account.id::text and event.actor_type = 'system'
                  and event.details->>'method' = 'email' and event.details->>'accountCreated' = 'true'
                  and event.details->'bootstrapAccounts' = to_jsonb(array[${set.map((id) => `'${id}'`).join(', ')}]::text[])
                  and position('@' in event.details::text) = 0)
     from auth.accounts account where account.id = any(array[${ids.map((id) => `'${id}'`).join(', ')}]::uuid[])
     order by array_position(array[${ids.map((id) => `'${id}'`).join(', ')}]::uuid[], account.id)`).split('\n');
  assert.deepEqual(accountRows(firstIds), [[firstIds[0], adminOne], [firstIds[1], mistyped], [firstIds[2], adminThree]]
    .map(([id, address]) => seededAccount(id, address)));

  // A rerun of either form is refused while those accounts still wait for a
  // password: the check counts every non-deleted holder, whatever its status.
  for (const [label, environment] of [['by email again', { PLATFORM_ADMIN_EMAILS: `${adminOne},${adminTwo}` }],
    ['by account ID', { PLATFORM_ADMIN_ACCOUNT_IDS: existingIds.join(',') }]]) {
    assert.match(emailBootstrap(`admin:bootstrap refuses a rerun ${label} while pending Super Admins exist`, environment,
      'failure').output, /Bootstrap refused: a platform Super Admin already exists, in any status but deleted/);
    assert.equal(emailState(), '3:3:3');
  }

  // The mistyped address, replaced while nobody has used any of the accounts.
  const replaced = emailBootstrap('admin:bootstrap replaces an unused email-seeded set',
    { PLATFORM_ADMIN_EMAILS: `${adminOne},${adminTwo},${adminThree}`, PLATFORM_ADMIN_REPLACE_PENDING: '1' });
  assert.match(replaced.stdout, /replaced 3 unused email-seeded accounts/);
  const newIds = idsIn(replaced.stdout).filter((id) => !firstIds.includes(id));
  assert.equal(new Set(newIds).size, 3);
  assert.deepEqual(idsIn(replaced.stdout).filter((id) => firstIds.includes(id)).sort(), [...firstIds].sort());
  assert.equal(emailState(), '6:3:3');
  assert.deepEqual(accountRows(newIds), [[newIds[0], adminOne], [newIds[1], adminTwo], [newIds[2], adminThree]]
    .map(([id, address]) => seededAccount(id, address)));
  assert.deepEqual(emailSql('the replaced accounts', `select account.id || '|' || account.status || '|' || account.token_version
        || '|' || (select count(*) from auth.account_roles assignment where assignment.account_id = account.id
                    and assignment.revoked_at is not null and assignment.revoked_by = account.id
                    and assignment.revocation_reason = 'Initial platform governance set by email (synthetic)')
        || '|' || (select count(*) from auth.account_roles assignment where assignment.account_id = account.id
                    and assignment.revoked_at is null)
        || '|' || (select count(*) from audit.events event where event.action = 'admin.platform-role.bootstrap.replaced'
                    and event.resource_id = account.id::text and event.details->>'accountStatus' = 'deleted'
                    and event.details->'replacedBy' = to_jsonb(array[${newIds.map((id) => `'${id}'`).join(', ')}]::text[]))
      from auth.accounts account where account.id = any(array[${firstIds.map((id) => `'${id}'`).join(', ')}]::uuid[])
      order by account.id`).split('\n'), [...firstIds].sort().map((id) => `${id}|deleted|2|1|0|1`));

  // Before the reset, as the Identity runtime LOGIN: the admin page's
  // recovery start reaches the account (otp.service.ts's own lookup), the
  // staff and patient pages do not, and neither platform sign-in nor the
  // platform permission accepts it yet.
  const [adminOneId] = newIds;
  const identitySource = await readFile(join(repository, 'services/identity-api/src/auth/otp.service.ts'), 'utf8');
  const startLookup = /client\.query<AccountRow>\(\s*`([\s\S]*?)`,\s*\[identifier, input\.audience\],/.exec(identitySource)?.[1];
  assert(startLookup, 'otp.service.ts has no recovery start lookup');
  const localAuthSource = await readFile(join(repository, 'services/identity-api/src/auth/local-auth.provider.ts'), 'utf8');
  const loginTemplate = /const accountSql = `([\s\S]*?)`;/.exec(localAuthSource)?.[1];
  assert(loginTemplate, 'local-auth.provider.ts has no account lookup');
  const loginLookup = loginTemplate.replace(/\$\{hidLogin[\s\S]*?: '(lower\(account\.email\) = lower\(\$1\))'\}/, '$1');
  assert.ok(!loginLookup.includes('${') && loginLookup.includes('lower(account.email) = lower($1)'),
    'the platform sign-in lookup by email');
  const asIdentity = async (operation) => {
    const client = new Client({ host: temporary, user: logins['identity-api'][0], database: emailDatabase });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.actor_subject', 'system:auth', true),
        set_config('app.correlation_id', 'example-email-bootstrap-check', true)`);
      return await operation(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  };
  const identityView = (address, id) => asIdentity(async (client) => {
    const audience = (await client.query(`select auth.recovery_account_audience($1, 'platform') as platform,
        auth.recovery_account_audience($1, 'staff') as staff, auth.recovery_account_audience($1, 'patient') as patient,
        auth.account_has_platform_permission($1, 'platform.admin.access') as admin_access`, [id])).rows[0];
    const start = {};
    for (const page of ['platform', 'staff', 'patient']) {
      const row = (await client.query(startLookup, [address.toUpperCase(), page])).rows[0];
      start[page] = row ? `${row.id}|${row.email}|${row.audience_matches}` : 'none';
    }
    const signIn = (await client.query(loginLookup, [address])).rows.map((row) => `${row.id}|${row.password_algorithm}`);
    return { audience, start, signIn };
  });
  const beforeReset = await identityView(adminOne, adminOneId);
  assert.deepEqual(beforeReset, {
    audience: { platform: true, staff: false, patient: false, admin_access: false },
    start: { platform: `${adminOneId}|${adminOne}|true`, staff: `${adminOneId}|${adminOne}|false`,
      patient: `${adminOneId}|${adminOne}|false` },
    signIn: [],
  });

  // The person's own reset and first sign-in over HTTP, as the Identity runtime LOGIN.
  const journey = JSON.parse(run('the admin reset and first platform sign-in over HTTP as the Identity LOGIN',
    process.execPath, [join(repository, 'services/identity-api/scripts/verify-platform-admin-email-bootstrap-runtime.mjs')],
    { PGHOST: temporary, PGDATABASE: emailDatabase, IDENTITY_LOGIN: logins['identity-api'][0],
      PLATFORM_ADMIN_EMAIL: adminOne }).stdout.trim().split('\n').at(-1));
  assert.equal(journey.status, 'passed');
  assert.equal(journey.account_id, adminOneId);

  // After it: active with the person's own Argon2id password, an
  // authenticator and a platform session; platform sign-in finds it and the
  // platform permission holds; still no staff or patient record.
  const afterReset = await identityView(adminOne, adminOneId);
  assert.deepEqual(afterReset, {
    audience: { platform: true, staff: false, patient: false, admin_access: true },
    start: beforeReset.start,
    signIn: [`${adminOneId}|argon2id`],
  });
  assert.equal(emailSql('the reset account', `select account.status || '|' || (account.password_hash like '$argon2id$%')
      || '|' || (account.password_changed_at is not null) || '|' || account.token_version
      || '|' || (select count(*) from auth.mfa_factors factor where factor.account_id = account.id and factor.status = 'active')
      || '|' || (select count(*) from auth.sessions session_row where session_row.account_id = account.id
                  and session_row.revoked_at is null)
      || '|' || (select count(*) from audit.events event where event.action = 'auth.otp.recovery.completed'
                  and event.actor_account_id = account.id)
      || '|' || (select count(*) from identity.staff staff_row where staff_row.account_id = account.id)
      || '|' || (select count(*) from identity.staff_facility_memberships membership where membership.account_id = account.id)
      || '|' || (select count(*) from identity.patients patient_row where patient_row.account_id = account.id)
     from auth.accounts account where account.id = '${adminOneId}'`), 'active|true|true|2|1|1|1|0|0|0');

  // Once one of them has set a password, no run replaces or adds anything.
  const usedRefusals = {
    'replace-pending': [{ PLATFORM_ADMIN_EMAILS: `${adminOne},${adminTwo},${adminThree}`, PLATFORM_ADMIN_REPLACE_PENDING: '1' },
      /PLATFORM_ADMIN_REPLACE_PENDING=1 replaces only Super Admins the email bootstrap created that nobody has used yet[^]*1 of 3 is not/],
    'another email run': [{ PLATFORM_ADMIN_EMAILS: `${adminTwo},example-platform-admin-four@example.invalid` },
      /a platform Super Admin already exists, in any status but deleted/],
    'an account ID run': [{ PLATFORM_ADMIN_ACCOUNT_IDS: existingIds.join(',') },
      /a platform Super Admin already exists, in any status but deleted/],
  };
  for (const [label, [environment, message]] of Object.entries(usedRefusals)) {
    assert.match(emailBootstrap(`admin:bootstrap refuses ${label} once a Super Admin has set a password`, environment,
      'failure').output, message, label);
    assert.equal(emailState(), '6:3:3', `${label}: a refused run changed nothing`);
  }
  assert.deepEqual(accountRows(newIds.slice(1), newIds), [[newIds[1], adminTwo], [newIds[2], adminThree]]
    .map(([id, address]) => seededAccount(id, address)));
  evidence.steps.platform_admin_email_bootstrap = { database: emailDatabase, bootstrap_run_as: admin,
    recovery_run_as: logins['identity-api'][0], seeded: 3, status_after_seed: 'pending_reset, no password',
    replaced: { accounts: 3, status: 'deleted', assignments_revoked: 3, reseeded: 3 },
    before_reset: beforeReset, after_reset: { platform_admin_access: true, sign_in_lookup: 'argon2id', staff_records: 0 },
    http: journey,
    refused: [...Object.keys(emailRefusals), 'rerun by email while pending', 'account ID run while pending',
      ...Object.keys(usedRefusals).map((label) => `${label} after a password was set`)] };

  // P6, P37(2) (admin:bootstrap): the first Super Admins, as RDS runs the
  // bootstrap, as the migration administrator, on the main database, where no
  // Super Admin exists yet. A Super Admin grant needs a second Super Admin's
  // decision (0070) and a clinician application a second Super Admin's
  // approval (0098), so the one-time bootstrap seeds two or three distinct
  // accounts in one audited transaction. It refuses a repeated, ineligible or
  // fourth account and both forms at once, granting nothing, and every run
  // once a Super Admin is active. Platform sign-in is by email and password,
  // so an account with a password and no email (a phone-only patient's) or a
  // blank one is ineligible too.
  const bootstrapAccounts = Object.fromEntries(['a', 'b', 'c', 'd', 'none', 'noemail', 'blankemail']
    .map((label) => [label, randomUUID()]));
  const bootstrapEmail = (label) => ({ noemail: 'null', blankemail: "'  '" })[label]
    ?? `'platform-bootstrap-${label}@example.invalid'`;
  psql('create the synthetic bootstrap accounts', admin, Object.entries(bootstrapAccounts).map(([label, id]) =>
    `insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm)
       values ('${id}', 'synthetic:platform-bootstrap:${label}', ${bootstrapEmail(label)},
         'Platform Bootstrap ${label}', 'active', ${label === 'none' ? 'null, null' : "'synthetic-hash', 'argon2id'"});`)
    .join(' '));
  const adminBootstrap = (label, environment, expected = 0) => run(label, process.execPath,
    [join(service, 'scripts/bootstrap-platform-admin.mjs')], { DATABASE_ADMIN_URL: url(admin),
      PLATFORM_ADMIN_BOOTSTRAP_REASON: 'Initial platform governance set (synthetic)', ...environment }, expected);
  const superAdminGrants = () => psql('active Super Admin grants', admin,
    `select count(*) || ':' || count(distinct account_id) from auth.account_roles
      where role_code = 'platform_super_admin' and scope_type = 'platform' and revoked_at is null`).stdout.trim();
  const { a, b, c, d, none, noemail, blankemail } = bootstrapAccounts;
  const ineligibleAccount = (id) => new RegExp(`account ${id} is not active or has no email address and password credential`);
  const bootstrapRefusals = {
    repeated: [`${a},${a}`, /two or three distinct accounts/],
    fourth: [`${a},${b},${c},${d}`, /two or three/],
    ineligible: [`${a},${none}`, ineligibleAccount(none)],
    'no-email': [`${a},${b},${noemail}`, ineligibleAccount(noemail)],
    'blank-email': [`${a},${blankemail}`, ineligibleAccount(blankemail)],
  };
  for (const [label, [ids, message]] of Object.entries(bootstrapRefusals)) {
    assert.match(adminBootstrap(`admin:bootstrap refuses a ${label} account`, { PLATFORM_ADMIN_ACCOUNT_IDS: ids },
      'failure').output, message);
    assert.equal(superAdminGrants(), '0:0', `a refused bootstrap (${label}) granted nothing`);
  }
  assert.match(adminBootstrap('admin:bootstrap refuses both forms', { PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${b}`,
    PLATFORM_ADMIN_ACCOUNT_ID: c }, 'failure').output, /not both/);
  // The migration task runs with NODE_ENV=production: one Super Admin alone
  // could never add a second or approve a clinician application.
  assert.match(adminBootstrap('admin:bootstrap refuses one account in production', { NODE_ENV: 'production',
    PLATFORM_ADMIN_ACCOUNT_ID: a }, 'failure').output,
  /In production name two or three accounts in PLATFORM_ADMIN_ACCOUNT_IDS; PLATFORM_ADMIN_ACCOUNT_ID is for development only/);
  assert.equal(superAdminGrants(), '0:0', 'a refused bootstrap (one account in production) granted nothing');
  const seeded = adminBootstrap('admin:bootstrap seeds three Super Admins', { PLATFORM_ADMIN_ACCOUNT_IDS: `${a},${b},${c}` });
  assert.match(seeded.stdout, new RegExp(`Platform Super Admin bootstrap completed for accounts ${a}, ${b}, ${c}`));
  assert.equal(superAdminGrants(), '3:3');
  const seededRows = psql('the seeded grants, their audit and the clinician approval permission', admin,
    `select assignment.account_id || '|' || (assignment.granted_by is null) || '|' || assignment.grant_reason || '|'
        || auth.account_has_platform_permission(assignment.account_id, 'platform.workforce.manage') || '|'
        || (select count(*) from audit.events event where event.action = 'admin.platform-role.bootstrap'
              and event.resource_id = assignment.account_id::text and event.actor_type = 'system'
              and event.details->>'roleCode' = 'platform_super_admin'
              and event.details->'bootstrapAccounts' = to_jsonb(array['${a}', '${b}', '${c}']::text[]))
       from auth.account_roles assignment
      where assignment.role_code = 'platform_super_admin' and assignment.revoked_at is null
      order by assignment.account_id`).stdout.trim().split('\n');
  assert.deepEqual(seededRows, [a, b, c].sort().map((id) =>
    `${id}|true|Initial platform governance set (synthetic)|true|1`));
  for (const [label, environment] of [['one more account', { PLATFORM_ADMIN_ACCOUNT_ID: d }],
    ['another set', { PLATFORM_ADMIN_ACCOUNT_IDS: `${d},${b}` }]]) {
    assert.match(adminBootstrap(`admin:bootstrap refuses ${label} once Super Admins are active`, environment,
      'failure').output, /Bootstrap refused: a platform Super Admin already exists, in any status but deleted/);
  }
  assert.equal(superAdminGrants(), '3:3');
  evidence.steps.platform_admin_bootstrap = { run_as: admin, seeded: 3, distinct: 3,
    each_holds: 'platform.workforce.manage', audit_events: 3,
    refused: [...Object.keys(bootstrapRefusals), 'both forms', 'one account in production', 'one more account',
      'another set'] };

  for (const name of ['platform-control-owner.integration.sql', 'function-parameter-settings.integration.sql']) {
    suite(name, superuser);
  }
  evidence.steps.suites = ['platform-control-owner.integration.sql', 'function-parameter-settings.integration.sql'];
  evidence.steps.database_provisioning = await provisioningStage();
  evidence.status = 'passed';
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (provisioningStarted) {
    const stopped = spawnSync(join(pgBindir, 'pg_ctl'), ['-D', provisioningData, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8' });
    if (stopped.status !== 0) { evidence.cleanup_failure = 'pg_ctl stop failed'; evidence.status = 'failed'; process.exitCode = 1; }
  }
  if (started) {
    const stopped = spawnSync(join(pgBindir, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8' });
    if (stopped.status !== 0) { evidence.cleanup_failure = 'pg_ctl stop failed'; evidence.status = 'failed'; process.exitCode = 1; }
  }
  if (!evidence.cleanup_failure) {
    await rm(temporary, { recursive: true, force: true });
    evidence.temporary_cluster_removed = true;
  }
  evidence.cluster = basename(temporary);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}
