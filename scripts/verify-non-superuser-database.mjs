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
// - the platform-control-owner and function-parameter-settings suites.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

  for (const name of ['platform-control-owner.integration.sql', 'function-parameter-settings.integration.sql']) {
    suite(name, superuser);
  }
  evidence.steps.suites = ['platform-control-owner.integration.sql', 'function-parameter-settings.integration.sql'];
  evidence.status = 'passed';
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
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
