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
    CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 0x44).toString('base64'),
    // Every source in this rehearsal is a locally generated fixture, whose
    // stage run records a `fixture:` transaction marker. Keep production's
    // 39/6/4/2 cutover expectations intact while making this deliberately
    // minimal fixture's empty optional categories explicit to the gate.
    CUTOVER_EXPECTED_PIN_COUNT: '0',
    CUTOVER_EXPECTED_GOOGLE_COUNT: '0',
    CUTOVER_EXPECTED_PLANNED_CAMPAIGN_COUNT: '0',
    CUTOVER_EXPECTED_QUEUED_ENCOUNTER_COUNT: '0',
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

// An additive nullable column on a historical table changes the row JSON but
// not the historical content. Compare those rows without the added columns and
// require the added columns to be null on every historical row.
async function withoutAddedColumns(db, name, columns) {
  const [schema, table] = name.split('.');
  return withClient(db, async (client) => {
    await client.query("set timezone = 'UTC'");
    const rows = (await client.query(`select (to_jsonb(t) - $1::text[])::text as value,
        (${columns.map((column) => `${quote(column)} is not null`).join(' or ')}) as populated
      from ${quote(schema)}.${quote(table)} t order by (to_jsonb(t) - $1::text[])::text collate "C"`, [columns])).rows;
    assert(rows.every((row) => !row.populated), `Upgrade populated ${columns.join(', ')} on historical ${name}`);
    return { rows: rows.length, sha256: sha256(rows.map((row) => row.value).join('\n')) };
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
    assert.deepEqual((await client.query(`select code, active from auth.permissions
      where code='identity.patient-access-pin.verify'`)).rows,
    [{ code:'identity.patient-access-pin.verify', active:true }]);
    assert.deepEqual((await client.query(`select role_code, permission_code from auth.role_permissions
      where permission_code='identity.patient-access-pin.verify' order by role_code`)).rows,
    [
      { role_code:'clinician', permission_code:'identity.patient-access-pin.verify' },
      { role_code:'doctor', permission_code:'identity.patient-access-pin.verify' },
      { role_code:'nurse', permission_code:'identity.patient-access-pin.verify' },
    ]);
    // 0084 (launch module set) withdraws the EHR lab-ordering, Lab and
    // Pharmacy write permissions the baseline roles held from every role.
    assert.deepEqual((await client.query(`select role_code, permission_code from auth.role_permissions
      where permission_code = any($1::text[])`, [['ehr.lab-request.write', 'lab.work-item.accept',
      'lab.accession.create', 'pharmacy.work-item.accept', 'pharmacy.dispensing.create']])).rows, [],
    'Upgrade must leave no role holding a launch-withdrawn write permission');
    // 0091 (launch module set, ADR-058) withdraws every Lab, Pharmacy, OCR and
    // Outreach permission, break-glass and document upload from every role.
    assert.deepEqual((await client.query(`select role_code, permission_code from auth.role_permissions
      where permission_code ~ '^(lab|pharmacy|ocr|outreach)\\.'
         or permission_code = 'ehr.document.write'`)).rows, [],
    'Upgrade must leave no role holding a permission of a module that is off at launch');
    // 0097 (break-glass at launch with limits, D9) grants break-glass again to
    // exactly the roles 0010 granted it to, and to no other role.
    assert.deepEqual((await client.query(`select role_code from auth.role_permissions
      where permission_code = 'identity.break-glass.write' order by role_code`)).rows.map((row) => row.role_code),
    ['clinician', 'doctor', 'nurse'], 'Upgrade must grant break-glass to exactly doctor, clinician and nurse');
    // The 0028 baseline holds no purpose-of-use code; 0082 seeds direct-care
    // and 0097 emergency (healthcare-operations awaits decision N3).
    assert.deepEqual((await client.query(`select code, display, active, source_system
      from identity.purpose_of_use_codes order by code`)).rows,
    [{ code:'direct-care', display:'Direct patient care', active:true, source_system:'hid' },
      { code:'emergency', display:'Emergency treatment', active:true, source_system:'hid' }],
    'Upgrade must seed exactly the active direct-care and emergency purposes of use');
    // 0097 leaves the platform control to an operator: break-glass stays off.
    assert.equal((await client.query(`select platform.control_enabled('break_glass_enabled') as enabled`)).rows[0].enabled,
      false, 'Upgrade must leave break_glass_enabled off for the operator');
    // 0090 (D-Eminence/hid-system#74) adds the retraction,
    // closed-encounter, closed-order, retracted-vital-correction and
    // retracted-document guards and the vital status, and the upgraded role
    // bootstrap lets the EHR runtime ask the membership permission decision
    // the retraction guard uses. It changes no row.
    assert.equal((await client.query(`select string_agg(tgname, ',' order by tgname) as triggers from pg_trigger
      where not tgisinternal and tgname = any($1::name[])`, [['encounters_closed_final', 'encounters_retraction_permission',
      'prescriptions_closed_final', 'lab_requests_closed_final', 'vital_corrections_vital_final',
      'documents_retracted_final']])).rows[0].triggers,
    'documents_retracted_final,encounters_closed_final,encounters_retraction_permission,lab_requests_closed_final,'
      + 'prescriptions_closed_final,vital_corrections_vital_final',
    'Upgrade must install the 0090 retraction and closed-record guards');
    assert.deepEqual((await client.query(`select column_default, is_nullable from information_schema.columns
      where table_schema = 'ehr' and table_name = 'vitals' and column_name = 'status'`)).rows,
    [{ column_default: "'final'::text", is_nullable: 'NO' }], 'Upgrade must give every vital a final status');
    assert.equal((await client.query(`select has_function_privilege('hid_ehr_runtime',
      'auth.membership_has_permission(text, uuid, uuid, text)', 'execute') as allowed`)).rows[0].allowed, true,
    'The upgraded role bootstrap must let the EHR runtime ask the retraction permission decision');
    // 0092 (ADR-061) drops the 7-argument activation command and creates it
    // again with the two self-reported profile arguments. A dropped function
    // loses its grants: as after 0058, the upgraded role bootstrap must give
    // the Identity runtime EXECUTE on the new signature, and no one else.
    assert.deepEqual((await client.query(`select
        to_regprocedure('identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char)') is null
          as seven_argument_dropped,
        has_function_privilege('hid_identity_runtime',
          'identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char,date,text)', 'execute')
          as identity_runtime,
        has_function_privilege('public',
          'identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char,date,text)', 'execute')
          as public_execute`)).rows[0],
    { seven_argument_dropped: true, identity_runtime: true, public_execute: false },
    'The upgraded role bootstrap must grant only the Identity runtime the 0092 activation command');
    // 0093 (ADR-062): the holder commands run for the Identity runtime only.
    // The runtime cannot write the holder columns, insert a state or read the
    // holder events; a new enrollment starts at verify_holder.
    assert.deepEqual((await client.query(`select
        has_function_privilege('hid_identity_runtime',
          'identity.record_public_patient_holder_proof(uuid,char,text,uuid,uuid,char,integer)', 'execute') as proof,
        has_function_privilege('hid_identity_runtime',
          'identity.record_public_patient_holder_send(uuid,char,char,integer,integer,integer)', 'execute') as send,
        has_function_privilege('hid_identity_runtime',
          'identity.record_public_patient_holder_failure(uuid,char,uuid,char,integer,integer)', 'execute') as failure,
        has_function_privilege('public',
          'identity.record_public_patient_holder_proof(uuid,char,text,uuid,uuid,char,integer)', 'execute') as public_proof,
        has_table_privilege('hid_identity_runtime', 'identity.public_patient_holder_events',
          'select,insert,update,delete') as holder_events,
        has_table_privilege('hid_identity_runtime', 'identity.public_patient_enrollments', 'insert,update') as table_write,
        has_column_privilege('hid_identity_runtime', 'identity.public_patient_enrollments', 'holder_method', 'update')
          as holder_update,
        has_column_privilege('hid_identity_runtime', 'identity.public_patient_enrollments', 'state', 'insert')
          as state_insert,
        (select column_default from information_schema.columns where table_schema = 'identity'
          and table_name = 'public_patient_enrollments' and column_name = 'state') as state_default`)).rows[0],
    { proof: true, send: true, failure: true, public_proof: false, holder_events: false, table_write: false,
      holder_update: false, state_insert: false, state_default: "'verify_holder'::text" },
    'The upgraded role bootstrap must give the Identity runtime the 0093 holder commands and no holder column');
    // 0094 (ADR-063): the facility-assisted commands run for the Identity
    // runtime only; their helpers for no runtime role; no runtime role reaches
    // the designations, their events or the in-person checks; doctor,
    // clinician and nurse hold the permission.
    assert.deepEqual((await client.query(`select
        has_function_privilege('hid_identity_runtime', 'identity.record_assisted_verification(uuid,char,char,text,text,'
          || 'text,text,text,text,char,char,integer,integer)', 'execute') as record,
        has_function_privilege('hid_identity_runtime', 'identity.list_participating_facilities()', 'execute') as list,
        has_function_privilege('hid_identity_runtime', 'identity.admin_set_facility_assisted_registration(uuid,bigint,'
          || 'text,text,text,text,text,text,text,text,char)', 'execute') as designate,
        has_function_privilege('hid_identity_runtime', 'identity.admin_facility_assisted_registration(uuid)', 'execute')
          as designation_read,
        has_function_privilege('public', 'identity.record_assisted_verification(uuid,char,char,text,text,text,text,text,'
          || 'text,char,char,integer,integer)', 'execute') as public_record,
        has_function_privilege('hid_identity_runtime', 'auth.staff_session_is_mfa()', 'execute') as staff_mfa,
        has_function_privilege('hid_identity_runtime', 'identity.assisted_registration_actor_attested(text,uuid,uuid)',
          'execute') as attested,
        has_function_privilege('hid_identity_runtime', 'identity.facility_assisted_registration_participating(uuid)',
          'execute') as participating,
        has_table_privilege('hid_identity_runtime', 'identity.assisted_registration_verifications',
          'select,insert,update,delete') as checks,
        has_table_privilege('hid_identity_runtime', 'identity.facility_assisted_registration',
          'select,insert,update,delete') as designations,
        has_table_privilege('hid_identity_runtime', 'identity.facility_assisted_registration_events',
          'select,insert,update,delete') as designation_events,
        (select array_agg(role_code::text order by role_code) from auth.role_permissions
          where permission_code = 'identity.patient.assisted_registration') as holders`)).rows[0],
    { record: true, list: true, designate: true, designation_read: true, public_record: false, staff_mfa: false,
      attested: false, participating: false, checks: false, designations: false, designation_events: false,
      holders: ['clinician', 'doctor', 'nurse'] },
    'The upgraded role bootstrap must give the Identity runtime the 0094 commands and no assisted-registration table');
    // Patient record release (owner decision 4 of 2026-10-16, D7): the
    // released Lab results view belongs to its technical owner and only the
    // EHR runtime may read it; Lab gains neither the view nor the
    // patient-self context, whose EXECUTE stays with the EHR runtime and the
    // test role (PSELF-RLS, D17).
    assert.deepEqual((await client.query(`select
        (select relowner::regrole::text from pg_class where oid = 'ehr.patient_released_lab_results'::regclass) as owner,
        has_table_privilege('hid_ehr_runtime', 'ehr.patient_released_lab_results', 'SELECT') as ehr_view,
        has_table_privilege('hid_lab_runtime', 'ehr.patient_released_lab_results', 'SELECT') as lab_view,
        has_table_privilege('hid_lab_api_runtime', 'ehr.patient_released_lab_results', 'SELECT') as lab_api_view,
        has_function_privilege('hid_lab_runtime', 'ehr.patient_self_context(uuid)', 'EXECUTE') as lab_self,
        has_function_privilege('hid_lab_release_reader', 'ehr.patient_self_context(uuid)', 'EXECUTE') as reader_self,
        has_schema_privilege('hid_lab_runtime', 'ehr', 'USAGE') as lab_ehr,
        (select array_agg(privilege.grantee::regrole::text order by privilege.grantee::regrole::text)
           from pg_proc proc, aclexplode(proc.proacl) privilege
          where proc.oid = 'ehr.patient_self_context(uuid)'::regprocedure and privilege.grantee <> proc.proowner)
          as self_holders`)).rows[0],
    { owner: 'hid_lab_release_reader', ehr_view: true, lab_view: false, lab_api_view: false, lab_self: false,
      reader_self: false, lab_ehr: false, self_holders: ['hid_ehr_runtime', 'hid_schema_test_runtime'] },
    'The upgraded role bootstrap must give the released Lab results view to its technical owner and the EHR runtime only');
    // Patient record chat (owner decision 1): the EHR runtime reads, writes
    // and deletes the patient's history but never updates it, runs the two
    // limit commands and the legal hold check and reaches no limit table; the
    // kill switch is off, and clinician self sign-up's control (0098), whose
    // key the record chat migration keeps in the control check, is still off.
    assert.deepEqual((await client.query(`select
        has_table_privilege('hid_ehr_runtime', 'ehr.patient_chat_messages', 'SELECT,INSERT,DELETE') as history,
        has_table_privilege('hid_ehr_runtime', 'ehr.patient_chat_messages', 'UPDATE') as history_update,
        has_table_privilege('hid_ehr_runtime', 'ehr.record_chat_reservations', 'SELECT') as limits,
        has_function_privilege('hid_ehr_runtime', 'ehr.reserve_record_chat(text,uuid,integer,bigint)', 'EXECUTE')
          as reserve,
        has_function_privilege('public', 'ehr.reserve_record_chat(text,uuid,integer,bigint)', 'EXECUTE') as public_reserve,
        has_function_privilege('hid_ehr_runtime', 'ehr.record_chat_history_on_hold(uuid)', 'EXECUTE') as hold,
        has_function_privilege('public', 'ehr.record_chat_history_on_hold(uuid)', 'EXECUTE') as public_hold,
        has_table_privilege('hid_identity_runtime', 'ehr.patient_chat_messages', 'SELECT') as identity_history,
        platform.control_enabled('record_chat_enabled') as control,
        platform.control_enabled('clinician_signup_enabled') as clinician_control`)).rows[0],
    { history: true, history_update: false, limits: false, reserve: true, public_reserve: false, hold: true,
      public_hold: false, identity_history: false, control: false, clinician_control: false },
    'The upgraded role bootstrap must give the EHR runtime the record chat history and commands only');
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
  // identity.purpose_of_use_codes gains 0082's and 0097's seeds, and
  // auth.role_permissions loses 0084's and 0091's launch-withdrawn permissions
  // and regains 0097's break-glass rows, all checked above.
  const expectedChanged = new Set([
    'migration.schema_migrations', 'auth.sessions', 'auth.otp_challenges', 'identity.outbox_events',
    'auth.permissions', 'auth.role_permissions', 'identity.purpose_of_use_codes',
  ]);
  // 0067 and 0068 add nullable columns to historical audit and account rows.
  const addedHistoricalColumns = { 'audit.events': ['access_scope'], 'auth.accounts': ['disabled_from_status'] };
  for (const [name, value] of Object.entries(upgradeBefore)) {
    if (expectedChanged.has(name)) continue;
    const added = addedHistoricalColumns[name];
    assert.deepEqual(added ? await withoutAddedColumns('hid_upgrade', name, added) : upgradeAfter[name], value,
      `Upgrade changed historical ${name}`);
  }
  restore('hid_upgrade_restored', upgradeBackup);
  assert.deepEqual(await snapshot('hid_upgrade_restored'), upgradeBefore, 'Pre-schema backup must restore the exact 0028 state');
  evidence.checks.existing_schema_upgrade = {from:'0028',to:latestSchema,dry_run_unchanged:true,
    historical_tables_preserved:true,old_sessions_remain_staff:true,unbound_old_otp_denied:true,
    purpose_of_use_seeded:['direct-care','emergency'],launch_write_permissions_withdrawn:true,retraction_guards_installed:true,
    launch_module_permissions_withdrawn:true,patient_activation_command_regranted:true,
    break_glass_granted_to:['clinician','doctor','nurse'],break_glass_control_left_off:true,
    holder_commands_runtime_only:true,holder_columns_not_runtime_writable:true,
    assisted_registration_commands_runtime_only:true,patient_record_release_grants:true,record_chat_grants:true,
    registration_outbox_reference_preserved:true,pre_schema_backup_restore_equal:true,
    integrity:await integrity('hid_upgrade')};
  // 0099 (ADR-067) refuses a database that holds the PR #8 branch's imported
  // history objects (its 0061 and 0062): staging must be rebuilt first. The
  // refused migration rolls back whole and leaves the branch object as it was.
  command('create synthetic 0098 database with a branch-era imported table', join(pgBindir, 'createdb'),
    ['hid_upgrade_imported']);
  migration('schema apply through 0098', 'apply-migrations.mjs', 'hid_upgrade_imported', {}, 0,
    ['--through=0098_clinician_self_signup.sql']);
  await withClient('hid_upgrade_imported', (client) => client.query(`create table ehr.imported_medical_records (
    id uuid primary key, patient_id uuid not null, source_payload jsonb not null)`));
  migration('0099 refuses a branch-shaped database', 'apply-migrations.mjs', 'hid_upgrade_imported', {}, 'failure');
  assert.match(logs.at(-1).stderr + logs.at(-1).stdout, /IMPORTED_HISTORY_BRANCH_OBJECTS_PRESENT/);
  assert.deepEqual(await withClient('hid_upgrade_imported', async (client) => (await client.query(`select
      (select max(version) from migration.schema_migrations) as latest,
      to_regclass('identity.imported_history_sharing') is null as sharing_absent,
      (select count(*)::int from information_schema.columns where table_schema = 'ehr'
        and table_name = 'imported_medical_records') as branch_columns`)).rows[0]),
  { latest: '0098_clinician_self_signup.sql', sharing_absent: true, branch_columns: 3 });
  command('drop synthetic 0098 database', join(pgBindir, 'dropdb'), ['hid_upgrade_imported']);
  evidence.checks.imported_history_branch_precondition = { from: '0098', refused: 'IMPORTED_HISTORY_BRANCH_OBJECTS_PRESENT',
    unchanged: true };
  // 0093 (ADR-062) on a database at 0092 that holds public enrollments in
  // every state: the rollback-only upgrade suite seeds them, applies 0093
  // itself and checks the backfill, then rolls everything back.
  command('create synthetic 0092 database', join(pgBindir, 'createdb'), ['hid_upgrade_holder']);
  migration('schema apply through 0092', 'apply-migrations.mjs', 'hid_upgrade_holder', {}, 0,
    ['--through=0092_patient_self_reported_enrollment_profile.sql']);
  command('0092 to 0093 public enrollment holder backfill (rollback-only)', join(pgBindir, 'psql'),
    ['-X', '-d', 'hid_upgrade_holder', '-v', 'ON_ERROR_STOP=1',
      '-f', join(service, 'database/tests/upgrade/0093-public-patient-holder-backfill.sql')]);
  command('drop synthetic 0092 database', join(pgBindir, 'dropdb'), ['hid_upgrade_holder']);
  evidence.checks.holder_backfill_upgrade = { from: '0092', to: '0093',
    suite: 'upgrade/0093-public-patient-holder-backfill.sql', seeded_states: ['verify_contact', 'set_password', 'active'],
    rolled_back: true };
  command('create synthetic database', join(pgBindir, 'createdb'), [database]);
  migration('schema dry run', 'apply-migrations.mjs', database, {}, 0, ['--dry-run']);
  const rolledBack = await withClient(database, async (client) =>
    (await client.query("select to_regclass('migration.schema_migrations') as table_name")).rows[0].table_name);
  assert.equal(rolledBack, null, 'Schema dry run must roll back its bootstrap and tables');
  migration('schema apply', 'apply-migrations.mjs');
  migration('bootstrap runtime roles', 'bootstrap-database-roles.mjs');
  assert.match(migration('schema rerun', 'apply-migrations.mjs'), /^0 pending migration\(s\)/);
  // Every service row lock must be one its runtime role can take, and the
  // static privilege replay CI relies on must match this catalogue (Stage 9).
  evidence.checks.runtime_locking_privileges = JSON.parse(command('runtime row locks against the role bootstrap and catalogue',
    process.execPath, [join(repository, 'scripts/verify-runtime-locking-privileges.mjs'), '--catalog', database,
      '--psql', join(pgBindir, 'psql')]));
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
  evidence.checks.patient_enrollment_runtime = JSON.parse(command(
    'exact-role patient enrollment to sign-in HTTP lifecycle', process.execPath,
    [join(repository, 'services/identity-api/scripts/verify-patient-enrollment-runtime.mjs')], workflowEnvironment));
  // ADR-063 (0094): the facility-assisted registration journey over HTTP.
  evidence.checks.assisted_registration_runtime = JSON.parse(command(
    'exact-role facility-assisted registration: designation, desk code, staff check, activation and sign-in over HTTP',
    process.execPath, [join(repository, 'services/identity-api/scripts/verify-assisted-registration-runtime.mjs')],
    workflowEnvironment));
  evidence.checks.patient_safety_runtime = JSON.parse(command('exact-role patient safety HTTP workflow', process.execPath,
    [join(repository, 'services/identity-api/scripts/verify-patient-safety-runtime.mjs')], workflowEnvironment));
  evidence.checks.delegated_cookie_read_runtime = JSON.parse(command(
    'exact-role EHR read delegated to Identity with a browser cookie session', process.execPath,
    [join(repository, 'services/ehr-api/scripts/verify-delegated-cookie-read-runtime.mjs')], workflowEnvironment));
  // Patient record release (owner decision 4, D7): the released categories,
  // the patient document download, staff and Lab refused, flags off unchanged.
  evidence.checks.patient_record_release_runtime = JSON.parse(command(
    'exact-role patient record release and document download through the patient-self path', process.execPath,
    [join(repository, 'services/ehr-api/scripts/verify-patient-record-release-runtime.mjs')], workflowEnvironment));
  // Imported legacy history (owner decision 3, ADR-067): the patient's own
  // read, the sharing choice, the staff direct-care read, break-glass excluded.
  evidence.checks.imported_history_runtime = JSON.parse(command(
    'exact-role imported legacy history: patient-self read, sharing choice, staff direct-care read, break-glass excluded',
    process.execPath, [join(repository, 'services/ehr-api/scripts/verify-imported-history-runtime.mjs')],
    workflowEnvironment));
  // Patient record chat (owner decision 1): the patient's question answered
  // from the released records through a local fake Messages API, with the
  // kill switch, quotas, history, idempotency, minimisation and audit rows.
  evidence.checks.record_chat_runtime = JSON.parse(command(
    'exact-role patient record chat against a local fake model endpoint', process.execPath,
    [join(repository, 'services/ehr-api/scripts/verify-record-chat-runtime.mjs')], workflowEnvironment));
  // Staff record chat (ADR-069, 0101): a doctor's question about one patient, authorized through Identity with a
  // staff cookie session, answered from what the doctor may read at the facility, through the same fake endpoint.
  evidence.checks.staff_record_chat_runtime = JSON.parse(command(
    'exact-role staff record chat against a local fake model endpoint', process.execPath,
    [join(repository, 'services/ehr-api/scripts/verify-staff-record-chat-runtime.mjs')], workflowEnvironment));
  evidence.checks.outreach_cookie_read_runtime = JSON.parse(command(
    'exact-role Outreach reads and writes authorized through Identity with a browser cookie session', process.execPath,
    [join(repository, 'services/outreach-api/scripts/verify-outreach-cookie-read-runtime.mjs')], workflowEnvironment));
  evidence.checks.provider_enrollment_runtime = JSON.parse(command('exact-role provider self-enrollment HTTP workflow',
    process.execPath, [join(repository, 'services/identity-api/scripts/verify-provider-enrollment-runtime.mjs')],
    workflowEnvironment));
  evidence.checks.platform_admin_runtime = JSON.parse(command('exact-role platform admin HTTP boundaries',
    process.execPath, [join(repository, 'services/identity-api/scripts/verify-platform-admin-runtime.mjs')],
    workflowEnvironment));
  // N5 (0087): the legacy promotion's duplicate facility membership check against the real schema.
  evidence.checks.membership_duplicates_runtime = JSON.parse(command('legacy promotion duplicate membership check',
    process.execPath, [join(repository, 'services/ehr-api/scripts/verify-membership-duplicates-runtime.mjs')],
    workflowEnvironment));
  evidence.checks.session_sign_out_runtime = JSON.parse(command('exact-role sign-out by refresh cookie and client-kind refresh',
    process.execPath, [join(repository, 'services/identity-api/scripts/verify-session-sign-out-runtime.mjs')],
    workflowEnvironment));
  evidence.checks.facility_selection_runtime = JSON.parse(command(
    'exact-role staff facility selection kept per sign-in across reload and refresh (0089)', process.execPath,
    [join(repository, 'services/identity-api/scripts/verify-facility-selection-runtime.mjs')], workflowEnvironment));
  evidence.checks.platform_security_runtime = JSON.parse(command(
    'exact-role platform MFA, step-up, approval and export HTTP workflow', process.execPath,
    [join(repository, 'services/identity-api/scripts/verify-platform-security-runtime.mjs')], workflowEnvironment));
  // Launch blocker MFA-1 (0088): staff sign-in is password then authenticator,
  // a first enrolment needs an emailed code, and an unassured staff session is
  // refused everywhere and ended on refresh.
  evidence.checks.staff_mfa_runtime = JSON.parse(command(
    'exact-role staff MFA sign-in, enrolment proof, unassured-session refusal, recovery and reset HTTP workflow',
    process.execPath, [join(repository, 'services/identity-api/scripts/verify-staff-mfa-runtime.mjs')],
    workflowEnvironment));
  // Owner decision 2 (ADR-066, 0098): clinician self sign-up with the
  // authenticator before review and two different Super Admins; nothing the
  // applicant's browser holds works at /auth/mfa/*.
  evidence.checks.clinician_application_runtime = JSON.parse(command(
    'exact-role clinician self sign-up, authenticator before review, two-admin approval and first staff sign-in HTTP workflow',
    process.execPath, [join(repository, 'services/identity-api/scripts/verify-clinician-application-runtime.mjs')],
    workflowEnvironment));
  // Phase 4 Stage 9: the commands whose row locks their runtime roles could not
  // take, each through its real API as its runtime role, with concurrency,
  // replay, denial and rollback cases.
  evidence.checks.registration_review_runtime = JSON.parse(command('exact-role NIN registration review HTTP workflow',
    process.execPath, [join(repository, 'services/identity-api/scripts/verify-registration-review-runtime.mjs')],
    workflowEnvironment));
  // Launch blocker PSEARCH-1 (0086): one 404 for every refused lookup, access
  // requests that never name the patient, and per-actor and per-facility budgets.
  evidence.checks.patient_search_runtime = JSON.parse(command('exact-role staff patient search and access-request HTTP workflow',
    process.execPath, [join(repository, 'services/identity-api/scripts/verify-patient-search-runtime.mjs')],
    workflowEnvironment));
  for (const [name, script] of [['pharmacy_runtime', 'services/pharmacy-api/scripts/verify-pharmacy-runtime.mjs'],
    ['lab_runtime', 'services/lab-api/scripts/verify-lab-runtime.mjs'],
    ['ehr_lab_handoff_runtime', 'services/ehr-api/scripts/verify-ehr-lab-handoff-runtime.mjs'],
    ['encounter_lifecycle_runtime', 'services/ehr-api/scripts/verify-encounter-lifecycle-runtime.mjs'],
    ['ocr_runtime', 'services/ocr-api/scripts/verify-ocr-runtime.mjs'],
    ['outreach_runtime', 'services/outreach-api/scripts/verify-outreach-runtime.mjs']]) {
    evidence.checks[name] = JSON.parse(command(`exact-role ${name.replace('_runtime', '')} HTTP write commands`,
      process.execPath, [join(repository, script)], workflowEnvironment));
  }
  // ADR-064 (0095): the notification worker's subscriber email sync, as
  // hid_notification_worker against a fake Novu: flag off is main's trigger
  // alone; a failed subscriber call never holds back the in-app trigger; an
  // opt-out or a deleted login clears an email synced earlier first.
  evidence.checks.notification_worker_runtime = JSON.parse(command(
    'exact-role notification worker: claim-bound recipient lookup, Novu subscriber email sync and the in-app trigger',
    process.execPath, [join(repository, 'services/notification-worker/scripts/verify-notification-worker-runtime.mjs')],
    workflowEnvironment));
  // Imported legacy history (ADR-067): main's stage, promote and reconcile of
  // a synthetic identity source, a sealed history run of the same snapshot and
  // the importer's dry run, apply, repeat and refusals, on a database of its own.
  command('create imported history database', join(pgBindir, 'createdb'), ['hid_imported_history']);
  migration('schema apply (imported history)', 'apply-migrations.mjs', 'hid_imported_history');
  migration('bootstrap runtime roles (imported history)', 'bootstrap-database-roles.mjs', 'hid_imported_history');
  evidence.checks.imported_history_import = JSON.parse(migration(
    'imported history import: dry run, apply, idempotent repeat, changed and tampered rows refused',
    'rehearse-imported-history-import.mjs', 'hid_imported_history'));
  assert.equal(evidence.checks.imported_history_import.status, 'passed');
  command('drop imported history database', join(pgBindir, 'dropdb'), ['hid_imported_history']);
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
        'authorize_patient_self','patient_self_access_history','activate_break_glass','enroll_registered_patient',
        'patient_self_context')
        and p.prosecdef and r.rolname=$1`, [owner])).rows[0].n,9);
  });
  for (const name of additionalSuites) command(`non-superuser definer ownership integration ${name}`, join(pgBindir, 'psql'),
    ['-X', '-d', 'hid_owner_check', '-v', 'ON_ERROR_STOP=1', '-f', join(service, 'database/tests', name)]);
  evidence.checks.non_superuser_definer_owner = {role:'hid_synthetic_schema_owner',login:false,superuser:false,
    bypass_rls:false,definer_commands_checked:9,runtime_callers:'exact service roles',suites:additionalSuites};
  // As RDS runs it, on a second disposable cluster whose roles a non-superuser
  // creates: a NOSUPERUSER NOBYPASSRLS CREATEROLE administrator migrates 0001
  // to the latest migration (SET ON PARAMETER held only for that run), runs the
  // role bootstrap twice and db:verify-roles, and the runtime logins it creates
  // pass db:verify-logins and read the platform controls.
  evidence.checks.non_superuser_database = JSON.parse(command('non-superuser migration, role bootstrap, logins and controls',
    process.execPath, [join(repository, 'scripts/verify-non-superuser-database.mjs'), '--pg-bindir', pgBindir]));
  assert.equal(evidence.checks.non_superuser_database.status, 'passed');
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

  // `patient_assurance_states.state` belongs to the runtime assurance ladder and
  // legitimately advances after promotion, so reconciliation compares only the
  // migration-owned provenance (patient, account, source_system, source_reference).
  // These three cases pin both halves of that contract: an advanced state is
  // tolerated, a re-promotion of an advanced patient succeeds, and a missing
  // assurance row still fails closed.

  // A: advanced assurance state must reconcile cleanly, with no conflict.
  restore('hid_assurance_advanced', backupPath);
  migration('stage advanced-assurance fixture', 'stage-legacy-identity.mjs', 'hid_assurance_advanced');
  migration('promote advanced-assurance fixture', 'promote-legacy-identity.mjs', 'hid_assurance_advanced');
  await withClient('hid_assurance_advanced', async (client) => {
    const before = (await client.query(`select state from identity.patient_assurance_states
      where patient_id=$1`, [ids.patient])).rows[0];
    assert.equal(before.state, 'LEGACY_MIGRATED', 'Promotion must still create the LEGACY_MIGRATED starting state');
    await client.query(`update identity.patient_assurance_states
         set state='NIN_VERIFIED', verified_provider='qoreid', nin_verified_at=clock_timestamp()
       where patient_id=$1`, [ids.patient]);
  });
  migration('reconcile advanced assurance state', 'reconcile-legacy-identity.mjs', 'hid_assurance_advanced');
  const advancedReconcile = await withClient('hid_assurance_advanced', async (client) => {
    assert.equal((await client.query(`select status from migration.runs where id=$1`, [runId])).rows[0].status,
      'verified', 'Advanced assurance state must not block reconciliation');
    const conflicts = (await client.query('select count(*)::integer as n from migration.conflicts')).rows[0].n;
    assert.equal(conflicts, 0, 'Advanced assurance state must not record a conflict');
    const row = (await client.query(`select patient_id, account_id, source_system, source_reference, state
      from identity.patient_assurance_states where patient_id=$1`, [ids.patient])).rows[0];
    assert.equal(row.state, 'NIN_VERIFIED', 'Reconciliation must not rewrite an advanced lifecycle state');
    assert.equal(row.account_id, ids.account);
    assert.equal(row.source_system, 'legacy_identity');
    assert.equal(row.source_reference, ids.patient);
    return { status: 'verified', conflicts, state_after: row.state };
  });

  // B: re-promoting a patient whose assurance already advanced must not be read
  // as a target content mismatch, and must leave provenance correct.
  restore('hid_assurance_repromote', backupPath);
  migration('stage re-promotion fixture', 'stage-legacy-identity.mjs', 'hid_assurance_repromote');
  migration('promote re-promotion fixture', 'promote-legacy-identity.mjs', 'hid_assurance_repromote');
  await withClient('hid_assurance_repromote', async (client) => {
    await client.query(`update identity.patient_assurance_states
         set state='NIN_VERIFIED', verified_provider='qoreid', nin_verified_at=clock_timestamp()
       where patient_id=$1`, [ids.patient]);
  });
  migration('re-promote after assurance advanced', 'promote-legacy-identity.mjs', 'hid_assurance_repromote');
  const advancedRepromote = await withClient('hid_assurance_repromote', async (client) => {
    assert.equal((await client.query(`select status from migration.runs where id=$1`, [runId])).rows[0].status,
      'staged', 'A successful retry must not block the run');
    const row = (await client.query(`select account_id, source_system, source_reference, state
      from identity.patient_assurance_states where patient_id=$1`, [ids.patient])).rows[0];
    assert.equal(row.state, 'NIN_VERIFIED', 'Re-promotion must not reset an advanced lifecycle state');
    assert.equal(row.account_id, ids.account, 'Provenance must remain correct after re-promotion');
    assert.equal(row.source_system, 'legacy_identity');
    assert.equal(row.source_reference, ids.patient);
    return { retried: true, state_after: row.state, provenance_preserved: true };
  });

  // C: a missing assurance row is a real preservation failure and must still
  // block. This is what stops the provenance-only comparison becoming "ignore
  // the assurance row entirely".
  restore('hid_assurance_missing', backupPath);
  migration('stage missing-assurance fixture', 'stage-legacy-identity.mjs', 'hid_assurance_missing');
  migration('promote missing-assurance fixture', 'promote-legacy-identity.mjs', 'hid_assurance_missing');
  await withClient('hid_assurance_missing', async (client) => {
    await client.query('delete from identity.patient_assurance_states where patient_id=$1', [ids.patient]);
    assert.equal((await client.query(`select count(*)::integer as n from identity.patient_assurance_states
      where patient_id=$1`, [ids.patient])).rows[0].n, 0);
  });
  migration('reject reconciliation of missing assurance row', 'reconcile-legacy-identity.mjs',
    'hid_assurance_missing', {}, 'failure');
  const missingAssurance = await withClient('hid_assurance_missing', async (client) => {
    assert.equal((await client.query(`select status from migration.runs where id=$1`, [runId])).rows[0].status,
      'blocked', 'A missing assurance row must block reconciliation');
    const conflict = (await client.query(`select entity_type, source_pk, details from migration.conflicts
      where entity_type='patient_assurance_states'`)).rows[0];
    assert.ok(conflict, 'A missing assurance row must record a conflict');
    assert.equal(conflict.details.table, 'identity.patient_assurance_states');
    assert.equal(conflict.source_pk, ids.patient);
    return { blocked: true, conflict_entity_type: conflict.entity_type };
  });
  evidence.checks.assurance_reconciliation = { ...advancedReconcile, ...advancedRepromote, ...missingAssurance,
    invariant: 'migration-owned provenance only: patient_id, account_id, source_system, source_reference',
    lifecycle_state: 'runtime-owned; may advance from LEGACY_MIGRATED without blocking reconciliation' };

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
