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
// - the platform-control-owner and function-parameter-settings suites.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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

function url(user) {
  return `postgresql://${user}@localhost/${database}?host=${encodeURIComponent(temporary)}`;
}

function psql(label, user, sql, expected = 0) {
  return run(label, join(pgBindir, 'psql'),
    ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', temporary, '-U', user, '-d', database, '-c', sql], {}, expected);
}

function suite(name, user) {
  run(`${name} as ${user}`, join(pgBindir, 'psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', temporary,
    '-U', user, '-d', database, '-f', join(service, 'database/tests', name)]);
}

function migrate(label, expected = 0) {
  return run(label, process.execPath, [join(service, 'scripts/apply-migrations.mjs')],
    { DATABASE_URL: url(admin) }, expected);
}

function bootstrap(label, flags = []) {
  return run(label, process.execPath, [join(service, 'scripts/bootstrap-database-roles.mjs'), ...flags],
    { DATABASE_ADMIN_URL: url(admin) }).stdout.trim();
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
         || ',' || platform.control_enabled('outreach_portal_enabled') || ',' || platform.control_enabled('break_glass_enabled');
       select platform.require_control_enabled('patient_portal_enabled')`)
      .stdout.trim().split('\n')[0];
    assert.equal(controls[credential], 'true,true,false,false,false,false');
  }
  evidence.steps.platform_controls = { read_as: controls, owner: psql('control owner', superuser,
    `select proowner::regrole from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure`).stdout.trim() };
  assert.equal(evidence.steps.platform_controls.owner, 'hid_platform_control_reader');

  // I3 at call time: the claim runs its body without the parameter privilege.
  const claim = psql('OCR claim without a workload context', logins['ocr-worker'][0],
    `select * from ocr.claim_worker_job('synthetic-provider', 300)`, 'failure');
  assert.match(claim.output, /Authorized OCR workload context is required/);
  assert.doesNotMatch(claim.output, /permission denied to set parameter/);
  evidence.steps.ocr_claim = { refused_by: 'body authorization check', parameter_privilege_needed: false };

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
