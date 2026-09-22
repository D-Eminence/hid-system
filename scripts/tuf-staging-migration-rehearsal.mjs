#!/usr/bin/env node

// This command can only create its own disposable Unix-socket PostgreSQL cluster.
// It intentionally has no database URL, cloud, credential, or production mode.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { baselineSql, ids, syntheticFixture } from '../release/migration/synthetic-fixture.mjs';
import { generateJourneyFixture } from './prepare-staging-journey-fixture.mjs';

const repository = resolve(import.meta.dirname, '..');
const service = join(repository, 'services/ehr-api');
const require = createRequire(join(service, 'package.json'));
const { Client } = require('pg');
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--evidence-dir'),
  'Usage: node scripts/tuf-staging-migration-rehearsal.mjs [--evidence-dir NEW_DIRECTORY]');
assert.notEqual(process.getuid?.(), 0, 'Run the disposable PostgreSQL rehearsal as a non-root user');
const evidenceDirectory = args.length
  ? resolve(args[1]) : await mkdtemp('/tmp/hid-tuf-migration-evidence.');
if (args.length) await mkdir(evidenceDirectory, { mode: 0o700 });
const temporary = await mkdtemp('/tmp/hid-tuf-migration.');
const data = join(temporary, 'data');
const admin = 'hid_rehearsal_admin';
const database = 'hid_rehearsal';
const runId = 'c0000000-0000-4000-8000-000000000001';
const logs = [];
const baseEnvironment = {
  PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test',
  DATABASE_SSL: 'false', DATABASE_SSL_ROOT_CERT_BASE64: '',
  PGHOST: temporary, PGPORT: '5432', PGUSER: admin, PGSSLMODE: 'disable',
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const evidence = {
  schema_version: 1, scope: 'local-synthetic-only', status: 'failed', staging_accepted: false,
  started_at: new Date().toISOString(), checks: {}, artifacts: [],
  actual_staging_gates: ['protected CI', 'authorized staging database and backup',
    'restored staging application HTTP validation', 'TUF forward-version operational rollback',
    'DNS/CDN and monitoring validation'],
};
let pgBindir;
let started = false;

function command(label, executable, commandArgs, extraEnvironment = {}, expected = 0) {
  const result = spawnSync(executable, commandArgs, {
    cwd: repository, env: { ...baseEnvironment, ...extraEnvironment },
    encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  // Environment values are deliberately excluded from retained logs.
  logs.push({ label, executable: basename(executable), args: commandArgs,
    status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  assert.ifError(result.error);
  if (expected === 'failure') assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  else assert.equal(result.status, expected,
    `${label} failed: ${(result.stderr || result.stdout || '').slice(-1800)}`);
  return result.stdout;
}

function url(db) {
  assert(/^hid_[a-z_]+$/.test(db));
  return `postgresql://${admin}@localhost/${db}?host=${encodeURIComponent(temporary)}`;
}

function migration(label, script, db = database, extra = {}, expected = 0, flags = []) {
  return command(label, process.execPath, [join(service, 'scripts', script), ...flags], {
    DATABASE_URL: url(db), DATABASE_ADMIN_URL: url(db),
    MIGRATION_RUN_ID: runId, MIGRATION_SNAPSHOT_ID: 'synthetic-fixture-v1',
    MIGRATION_OPERATOR: 'local-synthetic-rehearsal',
    MIGRATION_FIXTURE_PATH: join(temporary, 'fixture.json'),
    MIGRATION_FACILITY_TIMEZONES_JSON: JSON.stringify({ [ids.facility]: 'Africa/Lagos' }),
    MIGRATION_FIELD_KEY_REFERENCE: 'public-synthetic-test-vector-v1',
    // Public test vectors, never operational secrets; not retained as key files.
    MIGRATION_FIELD_ENCRYPTION_KEY_B64: Buffer.alloc(32, 0x11).toString('base64'),
    MIGRATION_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 0x22).toString('base64'),
    ...extra,
  }, expected);
}

async function withClient(db, callback) {
  const client = new Client({ host: temporary, port: 5432, user: admin, database: db });
  await client.connect();
  try { return await callback(client); } finally { await client.end(); }
}

function quote(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function snapshot(db) {
  return withClient(db, async (client) => {
    await client.query("set timezone = 'UTC'");
    const tables = (await client.query(`select schemaname, tablename from pg_tables
      where schemaname not in ('pg_catalog', 'information_schema') order by schemaname, tablename`)).rows;
    const result = {};
    for (const table of tables) {
      const name = `${table.schemaname}.${table.tablename}`;
      const rows = (await client.query(`select to_jsonb(t)::text as value from
        ${quote(table.schemaname)}.${quote(table.tablename)} t order by to_jsonb(t)::text collate "C"`)).rows;
      result[name] = { rows: rows.length, sha256: sha256(rows.map((row) => row.value).join('\n')) };
    }
    const sequences = (await client.query(`select schemaname, sequencename from pg_sequences
      where schemaname not in ('pg_catalog', 'information_schema') order by schemaname, sequencename`)).rows;
    for (const sequence of sequences) {
      const name = `${sequence.schemaname}.${sequence.sequencename}`;
      const row = (await client.query(`select last_value::text, is_called from
        ${quote(sequence.schemaname)}.${quote(sequence.sequencename)}`)).rows[0];
      result[`sequence:${name}`] = row;
    }
    return result;
  });
}

async function integrity(db) {
  return withClient(db, async (client) => {
    assert.equal((await client.query('show server_encoding')).rows[0].server_encoding, 'UTF8');
    const unvalidated = (await client.query(`select count(*)::integer as n from pg_constraint c
      join pg_namespace n on n.oid=c.connamespace where n.nspname not in ('pg_catalog','information_schema')
      and not c.convalidated`)).rows[0].n;
    assert.equal(unvalidated, 0, 'All constraints must remain validated');
    const foreignKeys = (await client.query(`select c.conname, c.conrelid::regclass::text as source,
      c.confrelid::regclass::text as target,
      array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum, position)
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum order by k.position) as source_keys,
      array(select a.attname::text from unnest(c.confkey) with ordinality k(attnum, position)
        join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum order by k.position) as target_keys
      from pg_constraint c join pg_namespace n on n.oid=c.connamespace
      where c.contype='f' and n.nspname not in ('pg_catalog','information_schema')`)).rows;
    for (const fk of foreignKeys) {
      const joinSql = fk.source_keys.map((key, index) => `s.${quote(key)}=t.${quote(fk.target_keys[index])}`).join(' and ');
      const nonnull = fk.source_keys.map((key) => `s.${quote(key)} is not null`).join(' and ');
      const count = (await client.query(`select count(*)::integer as n from ${fk.source} s where
        ${nonnull} and not exists(select 1 from ${fk.target} t where ${joinSql})`)).rows[0].n;
      assert.equal(count, 0, `Orphan rows violate ${fk.conname}`);
    }
    return { foreign_keys_checked: foreignKeys.length, orphan_rows: 0, unvalidated_constraints: 0, encoding: 'UTF8' };
  });
}

async function artifact(name) {
  const bytes = await readFile(join(evidenceDirectory, name));
  const record = { name, bytes: bytes.length, sha256: sha256(bytes) };
  evidence.artifacts.push(record);
  return record;
}

function restore(db, archive) {
  command(`create ${db}`, join(pgBindir, 'createdb'), [db]);
  command(`restore ${db}`, join(pgBindir, 'pg_restore'),
    ['--exit-on-error', '--single-transaction', '--dbname', db, archive]);
}

try {
  evidence.source_sha = command('source SHA', 'git', ['rev-parse', 'HEAD']).trim();
  evidence.worktree_dirty = command('worktree status', 'git', ['status', '--porcelain']).length > 0;
  pgBindir = command('PostgreSQL bindir', 'pg_config', ['--bindir']).trim();
  evidence.postgresql = command('PostgreSQL version', join(pgBindir, 'postgres'), ['--version']).trim();
  command('immutable migration ledger', process.execPath, ['scripts/verify-migration-ledger.mjs']);
  const files = (await readdir(join(service, 'database/migrations'))).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  evidence.migration_ledger = await Promise.all(files.map(async (name) => ({
    name, sha256: sha256(await readFile(join(service, 'database/migrations', name))),
  })));
  evidence.migration_ledger_sha256 = sha256(JSON.stringify(evidence.migration_ledger));
  const latestSchema = files.at(-1).slice(0, 4);
  evidence.source_schema = { bootstrap: 'empty', data_rehearsal: latestSchema, external_legacy_schema: 'unverified' };
  evidence.destination_schema = latestSchema;
  await writeFile(join(temporary, 'fixture.json'), JSON.stringify(syntheticFixture(), null, 2));
  evidence.fixture_sha256 = sha256(await readFile(join(temporary, 'fixture.json')));
  command('initialize private cluster', join(pgBindir, 'initdb'),
    ['-D', data, '-U', admin, '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
  command('start socket-only cluster', join(pgBindir, 'pg_ctl'), ['-D', data, '-l', join(temporary, 'postgres.log'),
    '-o', `-h '' -k ${temporary} -c unix_socket_permissions=0700`, '-w', 'start']);
  started = true;
  // Exercise the additive upgrade with persisted historical rows separately
  // from the empty-schema bootstrap. Only accepted, checksum-verified files
  // are applied, and the normal migration runner performs the actual upgrade.
  command('create synthetic baseline upgrade database', join(pgBindir, 'createdb'), ['hid_upgrade']);
  await withClient('hid_upgrade', async client => {
    for (const name of files.filter(name => name.slice(0, 4) <= '0028')) {
      const source = await readFile(join(service, 'database/migrations', name), 'utf8');
      await client.query('begin');
      try {
        await client.query(source);
        await client.query(`insert into migration.schema_migrations(version,checksum_sha256,execution_ms)
          values($1,$2,0)`, [name, sha256(source)]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
    }
    await client.query(baselineSql);
    await client.query(`begin;
      insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,
        account_token_version,authentication_method,issued_at,expires_at,absolute_expires_at)
      values ('c1000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
        'c1000000-0000-4000-8000-000000000001',repeat('a',64),'c1000000-0000-4000-8000-000000000002',
        1,'password',clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours');
      insert into auth.otp_challenges(id,account_id,recipient_hmac,purpose,channel,verifier_hmac,
        verifier_key_version,expires_at,max_attempts,verified_at,completion_token_hmac,completion_expires_at)
      values ('c2000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
        repeat('b',64),'PASSWORD_RESET','email',repeat('c',64),'synthetic',clock_timestamp()+interval '5 minutes',
        5,clock_timestamp(),repeat('d',64),clock_timestamp()+interval '5 minutes');
      insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
      values ('c4000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','admin','facility',
        'b6000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','Synthetic upgrade role');
      select set_config('app.actor_subject','synthetic:baseline',true);
      select set_config('app.membership_id','b6000000-0000-4000-8000-000000000001',true);
      select set_config('app.facility_id','b2000000-0000-4000-8000-000000000001',true);
      select set_config('app.correlation_id','synthetic-upgrade-case-001',true);
      select set_config('app.purpose_of_use','healthcare-operations',true);
      insert into identity.registration_cases(id,facility_id,created_by_account_id,created_by_membership_id,
        status,first_name,last_name,full_name,dob,nin_ciphertext,nin_lookup_hmac,nin_last4,nin_key_version,
        verification_provider,verification_reference,verified_at,idempotency_key,request_sha256,resolved_patient_id)
      values ('c3000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001',
        'b0000000-0000-4000-8000-000000000001','b6000000-0000-4000-8000-000000000001',
        'resolved_existing_identity','Baseline','Synthetic','Baseline Synthetic',date '1991-02-03',
        decode(repeat('ab',32),'hex'),repeat('e',64),'1234','synthetic','synthetic-provider',
        'synthetic-upgrade-ref',clock_timestamp(),'synthetic-upgrade-case-key',repeat('f',64),
        'b3000000-0000-4000-8000-000000000001');
      insert into identity.outbox_events(event_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload)
      values ('PatientIdentityResolved','c3000000-0000-4000-8000-000000000001',1,
        'b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',
        'synthetic-upgrade-case-001','{}');
      commit;`);
  });
  const upgradeBefore = await snapshot('hid_upgrade');
  const upgradeBackup = join(evidenceDirectory, 'pre-schema-upgrade.dump');
  command('backup synthetic schema 0028 before upgrade', join(pgBindir, 'pg_dump'),
    ['--format=custom', '--file', upgradeBackup, 'hid_upgrade']);
  await artifact('pre-schema-upgrade.dump');
  migration('existing baseline schema upgrade dry run', 'apply-migrations.mjs', 'hid_upgrade', {}, 0, ['--dry-run']);
  assert.deepEqual(await snapshot('hid_upgrade'), upgradeBefore, 'Upgrade dry run must preserve all historical rows');
  migration('existing baseline schema upgrade', 'apply-migrations.mjs', 'hid_upgrade');
  migration('upgraded baseline role bootstrap', 'bootstrap-database-roles.mjs', 'hid_upgrade');
  assert.match(migration('upgraded baseline rerun', 'apply-migrations.mjs', 'hid_upgrade'), /^0 pending migration\(s\)/);
  await withClient('hid_upgrade', async client => {
    assert.deepEqual((await client.query(`select session_kind,patient_id from auth.sessions
      where id='c1000000-0000-4000-8000-000000000001'`)).rows[0], {session_kind:'staff',patient_id:null});
    assert.deepEqual((await client.query(`select registration_case_id,emergency_grant_id from identity.outbox_events
      where aggregate_id='c3000000-0000-4000-8000-000000000001'`)).rows[0],
      {registration_case_id:'c3000000-0000-4000-8000-000000000001',emergency_grant_id:null});
    await client.query('begin');
    try {
      await client.query('set local role hid_identity_api_runtime');
      await client.query(`select set_config('app.actor_subject','system:auth',true),
        set_config('app.correlation_id','synthetic-upgrade-recovery-001',true)`);
      assert.equal((await client.query(`select auth.complete_recovery_otp(
        'c2000000-0000-4000-8000-000000000001','PASSWORD_RESET',repeat('d',64),
        '$argon2id$v=19$m=65536,t=3,p=1$synthetic-salt$synthetic-password-digest-not-an-operational-secret') as completed`)).rows[0].completed,
        false, 'Historical unbound completion credentials must fail closed');
    } finally { await client.query('rollback'); }
  });
  const upgradeAfter = await snapshot('hid_upgrade');
  const expectedChanged = new Set(['migration.schema_migrations','auth.sessions','auth.otp_challenges','identity.outbox_events']);
  for (const [name, value] of Object.entries(upgradeBefore)) {
    if (!expectedChanged.has(name)) assert.deepEqual(upgradeAfter[name], value, `Upgrade changed historical ${name}`);
  }
  restore('hid_upgrade_restored', upgradeBackup);
  assert.deepEqual(await snapshot('hid_upgrade_restored'), upgradeBefore, 'Pre-schema backup must restore the exact 0028 state');
  evidence.checks.existing_schema_upgrade = {from:'0028',to:latestSchema,dry_run_unchanged:true,
    historical_tables_preserved:true,old_sessions_remain_staff:true,unbound_old_otp_denied:true,
    registration_outbox_reference_preserved:true,pre_schema_backup_restore_equal:true,
    integrity:await integrity('hid_upgrade')};
  command('create synthetic database', join(pgBindir, 'createdb'), [database]);
  migration('schema dry run', 'apply-migrations.mjs', database, {}, 0, ['--dry-run']);
  const rolledBack = await withClient(database, async (client) =>
    (await client.query("select to_regclass('migration.schema_migrations') as table_name")).rows[0].table_name);
  assert.equal(rolledBack, null, 'Schema dry run must roll back its bootstrap and tables');
  migration('schema apply', 'apply-migrations.mjs');
  migration('bootstrap runtime roles', 'bootstrap-database-roles.mjs');
  assert.match(migration('schema rerun', 'apply-migrations.mjs'), /^0 pending migration\(s\)/);
  command('full rollback-only schema integration', join(pgBindir, 'psql'),
    ['-X', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', join(service, 'database/tests/schema.integration.sql')]);
  const additionalSuites = (await readdir(join(service, 'database/tests')))
    .filter(name => name.endsWith('.integration.sql') && !['schema.integration.sql', 'runtime-roles.integration.sql'].includes(name)).sort();
  for (const name of additionalSuites) {
    command(`additional rollback-only integration ${name}`, join(pgBindir, 'psql'),
      ['-X', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', join(service, 'database/tests', name)]);
  }
  evidence.checks.additional_schema_suites = additionalSuites;
  const workflowEnvironment = {
    PGDATABASE: database, DATABASE_URL: url(database), CORS_ORIGINS: 'http://127.0.0.1', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: randomBytes(32).toString('base64url'),
    AUTH_LOGIN_PEPPER: randomBytes(32).toString('base64url'),
    OTP_HMAC_KEY_B64: Buffer.alloc(32, 0x33).toString('base64'),
  };
  evidence.checks.otp_runtime = JSON.parse(command('exact-role OTP workflow and concurrency', process.execPath,
    [join(repository, 'services/identity-api/scripts/verify-otp-recovery-runtime.mjs')], workflowEnvironment));
  evidence.checks.patient_runtime = JSON.parse(command('exact-role patient HTTP workflow and sessions', process.execPath,
    [join(repository, 'services/identity-api/scripts/verify-patient-runtime.mjs')], workflowEnvironment));
  await withClient(database, (client) => client.query(baselineSql));
  evidence.checks.schema = { dry_run_rolled_back: true, applied: files.length, rerun_pending: 0, schema_rls_suite: 'passed' };
  const before = await snapshot(database);
  const beforeIntegrity = await integrity(database);
  const backupPath = join(evidenceDirectory, 'pre-migration.dump');
  evidence.backup_started_at = new Date().toISOString();
  command('pre-migration backup', join(pgBindir, 'pg_dump'), ['--format=custom', '--file', backupPath, database]);
  command('inspect backup archive', join(pgBindir, 'pg_restore'), ['--list', backupPath]);
  evidence.backup = await artifact('pre-migration.dump');
  evidence.backup_completed_at = new Date().toISOString();
  evidence.checks.pre_migration_integrity = beforeIntegrity;
  // PostgreSQL superuser ownership can hide FORCE RLS mistakes inside definer
  // commands. Recreate the schema-migrator ownership boundary on an independent
  // restored synthetic database; runtime callers retain their exact grants.
  restore('hid_owner_check', backupPath);
  await withClient('hid_owner_check', async client => {
    const owner = 'hid_synthetic_schema_owner';
    await client.query(`create role ${owner} nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls`);
    const schemas = (await client.query(`select nspname from pg_namespace
      where nspname not like 'pg_%' and nspname not in ('information_schema','public')`)).rows;
    for (const {nspname} of schemas) {
      await client.query(`alter schema ${quote(nspname)} owner to ${owner}`);
      const tables = (await client.query(`select c.relname,c.relkind from pg_class c
        join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
        where n.nspname=$1 and r.rolname=$2 and c.relkind in ('r','p','v','m','S')
        order by case when c.relkind='S' then 1 else 0 end,c.relname`, [nspname,admin])).rows;
      for (const {relname,relkind} of tables) {
        const kind = relkind==='v' ? 'view' : relkind==='m' ? 'materialized view' : relkind==='S' ? 'sequence' : 'table';
        await client.query(`alter ${kind} ${quote(nspname)}.${quote(relname)} owner to ${owner}`);
      }
      const functions = (await client.query(`select p.oid::regprocedure::text as signature from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
        where n.nspname=$1 and r.rolname=$2 and p.prokind='f'`, [nspname,admin])).rows;
      for (const {signature} of functions) await client.query(`alter function ${signature} owner to ${owner}`);
    }
    assert.deepEqual((await client.query(`select rolsuper,rolbypassrls,rolcanlogin from pg_roles where rolname=$1`, [owner])).rows[0],
      {rolsuper:false,rolbypassrls:false,rolcanlogin:false});
    assert.equal((await client.query(`select count(*)::integer n from pg_proc p join pg_roles r on r.oid=p.proowner
      where p.proname in ('complete_recovery_otp','current_patient_account','patient_self_session','patient_self_profile',
        'authorize_patient_self','patient_self_access_history','activate_break_glass','enroll_registered_patient')
        and r.rolname=$1`, [owner])).rows[0].n,8);
  });
  for (const name of additionalSuites) command(`non-superuser definer ownership integration ${name}`, join(pgBindir, 'psql'),
    ['-X', '-d', 'hid_owner_check', '-v', 'ON_ERROR_STOP=1', '-f', join(service, 'database/tests', name)]);
  evidence.checks.non_superuser_definer_owner = {role:'hid_synthetic_schema_owner',login:false,superuser:false,
    bypass_rls:false,definer_commands_checked:8,runtime_callers:'exact service roles',suites:additionalSuites};
  await writeFile(join(evidenceDirectory, 'before-counts-checksums.json'), JSON.stringify(before, null, 2) + '\n');
  await artifact('before-counts-checksums.json');
  process.stdout.write('Synthetic schema, baseline records, and pre-migration backup verified.\n');

  const dryA = migration('source scan A', 'stage-legacy-identity.mjs', database, {}, 0, ['--dry-run']);
  const dryB = migration('source scan B', 'stage-legacy-identity.mjs', database, {}, 0, ['--dry-run']);
  assert.equal(dryA, dryB, 'Synthetic source checksums must reproduce');
  migration('stage synthetic source', 'stage-legacy-identity.mjs');
  migration('promote synthetic source', 'promote-legacy-identity.mjs');
  const promoted = await snapshot(database);
  migration('idempotent promotion retry', 'promote-legacy-identity.mjs');
  const retried = await snapshot(database);
  for (const [name, value] of Object.entries(promoted)) {
    if (name.startsWith('migration.') || name.startsWith('sequence:')) continue;
    assert.deepEqual(retried[name], value, `Promotion retry changed ${name}`);
  }
  migration('reconcile synthetic source', 'reconcile-legacy-identity.mjs');
  evidence.checks.migration = await withClient(database, async (client) => {
    const run = (await client.query(`select status, mode, source_counts, target_counts,
      source_checksum_sha256, target_checksum_sha256 from migration.runs where id=$1`, [runId])).rows[0];
    assert.equal(run.status, 'verified');
    const patient = (await client.query(`select id, account_id, hid_code, full_name,
      dob::text, created_at, updated_at from identity.patients where id=$1`, [ids.patient])).rows[0];
    assert.equal(patient.account_id, ids.account);
    assert.equal(patient.hid_code, 'HID-JKLMNPQR');
    assert.equal(patient.full_name, 'Àdá Synthetic 患者');
    assert.equal(patient.dob, '2000-02-29');
    assert.equal(patient.created_at.toISOString(), '2025-01-01T00:00:00.000Z');
    assert.equal(patient.updated_at.toISOString(), '2026-01-01T00:00:00.000Z');
    const request = (await client.query('select migration_hold_reason from identity.access_requests where id=$1', [ids.request])).rows[0];
    assert.equal(request.migration_hold_reason, 'legacy_request_purpose_unmapped');
    const grant = (await client.query('select migration_hold_reason from identity.consent_grants where id=$1', [ids.consent])).rows[0];
    assert.equal(grant.migration_hold_reason, 'legacy_grant_purpose_unmapped');
    assert.equal((await client.query('select outcome from audit.events where event_id=$1', [ids.audit])).rows[0].outcome, 'denied');
    assert.equal((await client.query('select count(*)::integer as n from migration.conflicts')).rows[0].n, 0);
    return { ...run, source_scan_reproducible: true, promotion_retry: 'unchanged application tables',
      ids_hid_accounts_unicode_timestamps: 'passed', legacy_consent_hold: 'preserved' };
  });
  evidence.checks.post_migration_integrity = await integrity(database);
  const after = await snapshot(database);
  await writeFile(join(evidenceDirectory, 'after-counts-checksums.json'), JSON.stringify(after, null, 2) + '\n');
  await artifact('after-counts-checksums.json');

  const restoreStarted = performance.now();
  restore('hid_restored', backupPath);
  evidence.restore = { destination: 'disposable Unix-socket database hid_restored',
    duration_ms: Math.round(performance.now() - restoreStarted), backup_sha256: evidence.backup.sha256 };
  assert.equal(sha256(await readFile(backupPath)), evidence.backup.sha256);
  assert.deepEqual(await snapshot('hid_restored'), before, 'Restore must reproduce every table and sequence');
  evidence.checks.restore_integrity = await integrity('hid_restored');
  migration('verify restored runtime grants', 'bootstrap-database-roles.mjs', 'hid_restored', {}, 0, ['--verify-only']);
  command('restored schema and authorization integration', join(pgBindir, 'psql'),
    ['-X', '-d', 'hid_restored', '-v', 'ON_ERROR_STOP=1', '-f', join(service, 'database/tests/schema.integration.sql')]);
  for (const name of additionalSuites) {
    command(`restored rollback-only integration ${name}`, join(pgBindir, 'psql'),
      ['-X', '-d', 'hid_restored', '-v', 'ON_ERROR_STOP=1', '-f', join(service, 'database/tests', name)]);
  }
  evidence.checks.restore = { all_table_checksums_and_sequences_match: true, runtime_roles: 'passed',
    schema_authorization_suite: 'passed', application_http: 'not executed' };
  process.stdout.write('Synthetic promotion, reconciliation, retry, and exact pre-migration restore verified.\n');

  // Real SQL constraint denials run inside rollback-only transactions.
  await withClient('hid_restored', async (client) => {
    const denials = [
      ['23505', `insert into identity.patients (id,hid_code,first_name,last_name,full_name) values ('d0000000-0000-4000-8000-000000000001','HID-STUVWXYZ','S','S','S')`],
      ['23502', `insert into identity.patients (id,hid_code,first_name,last_name,full_name) values ('d0000000-0000-4000-8000-000000000001','HID-ABCDEFGH',null,'S','S')`],
      ['23503', `insert into identity.patients (id,account_id,hid_code,first_name,last_name,full_name) values ('d0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002','HID-ABCDEFGH','S','S','S')`],
      ['23514', `insert into identity.patients (id,hid_code,first_name,last_name,full_name,status) values ('d0000000-0000-4000-8000-000000000001','HID-ABCDEFGH','S','S','S','invalid')`],
    ];
    for (const [code, sql] of denials) {
      await client.query('begin');
      await assert.rejects(client.query(sql), (error) => error.code === code);
      await client.query('rollback');
    }
  });
  evidence.checks.constraint_denials = ['unique HID', 'not null', 'foreign key', 'enum/check'];

  restore('hid_tamper', backupPath);
  const suspended = syntheticFixture();
  suspended.facilities[0].payload.active = false;
  suspended.memberships[0].payload.active = false;
  const suspendedPath = join(temporary, 'suspended-fixture.json');
  await writeFile(suspendedPath, JSON.stringify(suspended));
  migration('stage suspended facility', 'stage-legacy-identity.mjs', 'hid_tamper', { MIGRATION_FIXTURE_PATH: suspendedPath });
  migration('promote suspended facility', 'promote-legacy-identity.mjs', 'hid_tamper');
  migration('retry suspended facility', 'promote-legacy-identity.mjs', 'hid_tamper');
  await withClient('hid_tamper', async (client) => {
    const facility = (await client.query('select active,lifecycle_status from identity.facilities where id=$1', [ids.facility])).rows[0];
    assert.deepEqual(facility, { active: false, lifecycle_status: 'suspended' });
    const roles = (await client.query('select revoked_at,revoked_by,revocation_reason from auth.account_roles where membership_id=$1', [ids.membership])).rows;
    assert.ok(roles.length > 0);
    for (const role of roles) {
      assert.equal(role.revoked_at.toISOString(), '2026-01-01T00:00:00.000Z');
      assert.equal(role.revoked_by, ids.staffAccount);
      assert.equal(role.revocation_reason, 'Legacy revocation retained during governed administration migration');
    }
    await client.query("update identity.patients set full_name='Changed synthetic destination' where id=$1", [ids.patient]);
  });
  migration('reject same-key changed destination on retry', 'promote-legacy-identity.mjs', 'hid_tamper', {}, 'failure');
  await withClient('hid_tamper', async (client) => {
    assert.equal((await client.query('select status from migration.runs where id=$1', [runId])).rows[0].status, 'blocked');
    assert.equal((await client.query('select full_name from identity.patients where id=$1', [ids.patient])).rows[0].full_name,
      'Changed synthetic destination', 'Conflicting destination must never be overwritten');
  });
  evidence.checks.retry_conflict = { inactive_facility_suspended: true, exact_retry_passed: true,
    inactive_membership_roles_revoked_with_provenance: true,
    changed_destination_rejected: true, changed_destination_preserved: true };

  restore('hid_conflict', backupPath);
  const invalid = syntheticFixture();
  invalid.patients[0].payload.auth_user_id = 'd0000000-0000-4000-8000-000000000002';
  const invalidPath = join(temporary, 'orphan-fixture.json');
  await writeFile(invalidPath, JSON.stringify(invalid));
  migration('stage orphan fixture', 'stage-legacy-identity.mjs', 'hid_conflict', { MIGRATION_FIXTURE_PATH: invalidPath });
  migration('reject orphan and partial promotion', 'promote-legacy-identity.mjs', 'hid_conflict', {}, 'failure');
  await withClient('hid_conflict', async (client) => {
    assert.equal((await client.query('select status from migration.runs where id=$1', [runId])).rows[0].status, 'blocked');
    assert.equal((await client.query('select count(*)::integer as n from identity.patients where id=$1', [ids.patient])).rows[0].n, 0);
    assert.equal((await client.query('select count(*)::integer as n from auth.accounts where id=$1', [ids.account])).rows[0].n, 1,
      'Earlier committed batches remain present and require controlled recovery');
  });
  migration('reject blocked promotion retry', 'promote-legacy-identity.mjs', 'hid_conflict', {}, 'failure');
  evidence.checks.partial_failure = { orphan_rejected: true, run_blocked: true,
    earlier_batches_preserved: true, blocked_retry_rejected: true,
    recovery: 'restore pre-migration backup to a new isolated destination; reconcile writes before switching' };

  // Independent disposable database: do not alter the established baseline,
  // snapshot counts, restore comparisons, or NIN registration integration tests.
  // These public .invalid contacts cannot deliver mail and are never operator input.
  const deferredDatabase = 'hid_nin_deferred';
  const deferred = generateJourneyFixture({
    schema_version: 'hid.staging-journey-input/v1', environment: 'staging',
    controlled_test_recipients_confirmed: true,
    patient_email: 'patient@synthetic.invalid', staff_email: 'clinician@synthetic.invalid',
    expected_target: { aws_account_id: '659225405023', aws_region: 'eu-west-1',
      rds_instance_identifier: null, database_name: null },
  });
  const deferredIds = deferred.manifest.ids;
  const deferredFixturePath = join(temporary, 'nin-deferred-fixture.json');
  await writeFile(deferredFixturePath, deferred.fixtureBytes, { mode: 0o600 });
  await writeFile(join(evidenceDirectory, 'nin-deferred-fixture-manifest.json'),
    JSON.stringify(deferred.manifest, null, 2) + '\n', { mode: 0o600 });
  await artifact('nin-deferred-fixture-manifest.json');
  const deferredEnvironment = {
    MIGRATION_FIXTURE_PATH: deferredFixturePath,
    MIGRATION_RUN_ID: deferred.manifest.migration.run_id,
    MIGRATION_SNAPSHOT_ID: deferred.manifest.migration.snapshot_id,
    MIGRATION_FACILITY_TIMEZONES_JSON: JSON.stringify(deferred.manifest.migration.facility_timezones),
  };
  command('create isolated NIN-deferred fixture database', join(pgBindir, 'createdb'), [deferredDatabase]);
  migration('apply NIN-deferred fixture schema', 'apply-migrations.mjs', deferredDatabase);
  migration('bootstrap NIN-deferred fixture roles', 'bootstrap-database-roles.mjs', deferredDatabase);
  migration('stage NIN-deferred fixture', 'stage-legacy-identity.mjs', deferredDatabase, deferredEnvironment);
  migration('promote NIN-deferred fixture', 'promote-legacy-identity.mjs', deferredDatabase, deferredEnvironment);
  migration('reconcile NIN-deferred fixture', 'reconcile-legacy-identity.mjs', deferredDatabase, deferredEnvironment);
  evidence.checks.nin_deferred_fixture = await withClient(deferredDatabase, async client => {
    const accounts = (await client.query(`select id, status, password_hash, password_algorithm,
      email_verified_at from auth.accounts order by id`)).rows;
    assert.equal(accounts.length, 2);
    assert.deepEqual(accounts.map(row => row.id), [deferredIds.account, deferredIds.staffAccount].sort());
    for (const account of accounts) {
      assert.equal(account.status, 'pending_reset');
      assert.equal(account.password_hash, null);
      assert.equal(account.password_algorithm, null);
      assert.equal(account.email_verified_at, null);
    }
    const patients = (await client.query(`select id, account_id, hid_code, nin_last4, nin_hash,
      nin_ciphertext from identity.patients`)).rows;
    assert.deepEqual(patients, [{ id: deferredIds.patient, account_id: deferredIds.account,
      hid_code: deferred.manifest.hid, nin_last4: null, nin_hash: null, nin_ciphertext: null }]);
    assert.notEqual(patients[0].id, patients[0].account_id);
    for (const table of ['identity.patient_identifiers', 'identity.registration_cases',
      'identity.access_requests', 'identity.consent_grants', 'auth.sessions', 'ehr.clinical_notes']) {
      assert.equal((await client.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} must remain empty`);
    }
    const roles = (await client.query(`select account_id, role_code, scope_type, facility_id,
      membership_id, revoked_at from auth.account_roles`)).rows;
    assert.deepEqual(roles, [{ account_id: deferredIds.staffAccount, role_code: 'doctor',
      scope_type: 'facility', facility_id: deferredIds.facility,
      membership_id: deferredIds.membership, revoked_at: null }]);
    const memberships = (await client.query(`select id, staff_id, account_id, organization_id,
      facility_id, membership_role, app_role, active, migration_hold_reason
      from identity.staff_facility_memberships`)).rows;
    assert.deepEqual(memberships, [{ id: deferredIds.membership, staff_id: deferredIds.staff,
      account_id: deferredIds.staffAccount, organization_id: deferredIds.organization,
      facility_id: deferredIds.facility, membership_role: 'doctor', app_role: 'doctor',
      active: true, migration_hold_reason: null }]);
    assert.equal((await client.query('select count(*)::integer as n from identity.staff where account_id=$1', [deferredIds.account])).rows[0].n, 0);
    assert.equal((await client.query('select status from migration.runs where id=$1',
      [deferred.manifest.migration.run_id])).rows[0].status, 'verified');
    assert.equal((await client.query('select count(*)::integer as n from migration.conflicts')).rows[0].n, 0);
    await client.query('begin');
    try {
      await client.query('set local role hid_identity_api_runtime');
      assert.equal((await client.query('select * from identity.current_patient_account($1)',
        [deferredIds.account])).rowCount, 0, 'Pending recovery must not become patient login authority');
    } finally { await client.query('rollback'); }
    return { scope: 'owned-disposable-unix-socket-only', database: deferredDatabase,
      fixture_sha256: deferred.manifest.fixture_sha256, generated_ids: deferredIds,
      promoted_and_reconciled: true, account_patient_link_preserved: true,
      passwords_absent: true, accounts_pending_reset: true, contacts_unverified: true,
      nin_fields_and_identifiers_absent: true, patient_workforce_authority_absent: true,
      clinician_exact_facility_doctor_role: true, clinical_grants_and_sessions_absent: true,
      pending_patient_runtime_access_denied: true, live_staging_import: false };
  });
  evidence.status = 'passed';
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  if (started) {
    try { evidence.synthetic_conflicts = await withClient(database, async client =>
      (await client.query('select entity_type, conflict_type, details from migration.conflicts')).rows); }
    catch { /* Failure may precede schema creation. */ }
  }
  process.exitCode = 1;
} finally {
  if (started) {
    try { command('stop disposable cluster', join(pgBindir, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']); }
    catch (error) { evidence.cleanup_failure = error.message; evidence.status = 'failed'; process.exitCode = 1; }
  }
  if (!evidence.cleanup_failure) {
    await rm(temporary, { recursive: true, force: true });
    evidence.temporary_cluster_removed = true;
  }
  evidence.completed_at = new Date().toISOString();
  await writeFile(join(evidenceDirectory, 'commands.json'), JSON.stringify(logs, null, 2) + '\n', { mode: 0o600 });
  await artifact('commands.json');
  await writeFile(join(evidenceDirectory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: evidence.status, scope: evidence.scope,
    evidence: join(evidenceDirectory, 'evidence.json'),
    evidence_sha256: sha256(await readFile(join(evidenceDirectory, 'evidence.json'))),
    ...(evidence.failure ? { failure: evidence.failure } : {}), staging_accepted: false }) + '\n');
}
