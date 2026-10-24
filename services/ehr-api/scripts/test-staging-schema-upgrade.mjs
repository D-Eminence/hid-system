#!/usr/bin/env node
// Disposable synthetic rehearsal. This does not connect to AWS or import PHI.
//
// It rehearses a production schema release in production's order. Production's
// runtime roles were bootstrapped long ago; every release since applies only
// the pending migrations, as the non-superuser, NOBYPASSRLS migration login,
// after a dry run of all of them in one transaction, and never re-applies
// runtime-grants.sql. A release may apply exactly the migrations declared in
// config/production-schema-compatibility.json. So, as a NOSUPERUSER
// NOBYPASSRLS migrator:
//   1. hid_upgrade gets every migration except the declared ones, then a role
//      bootstrap with the runtime-grants.sql of that baseline (the parent of
//      the commit that added the first declared migration, or the file named
//      by HID_BASELINE_RUNTIME_GRANTS) and the runtime-roles suite;
//   2. the declared migrations are dry-run (all pending in one transaction,
//      which must change nothing) and applied; recorded checksums are kept;
//   3. without re-running runtime-grants.sql, a role bootstrap with this
//      commit's runtime-grants.sql must not change any runtime role's function,
//      table or schema privilege: whatever the file grants, the migrations
//      already granted. Then the bootstrap and the runtime-roles suite run;
//   4. hid_clean is installed from scratch and rehearses the synthetic
//      additions, the patient-self suite and the medical import, as before.
// It runs in a disposable Docker PostgreSQL (HID_REHEARSAL_POSTGRES_IMAGE,
// pgvector/pgvector:pg16 by default) or, when HID_REHEARSAL_ADMIN_URL names a
// superuser of a disposable local PostgreSQL 16 with pgvector, in uniquely
// named databases and a migrator role there, which it drops at the end.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { rehearseStagingAdditions } from './rehearse-staging-additions.mjs';
import { rehearseMedicalImport } from './rehearse-medical-import.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(scripts, '../../..');
const migrationDirectory = path.resolve(scripts, '../database/migrations');
const runtimeGrantsPath = path.resolve(scripts, '../database/runtime-grants.sql');
const runtimeRolesPath = path.resolve(scripts, '../database/tests/runtime-roles.integration.sql');
const baselineDirectory = await mkdtemp(path.join(tmpdir(), 'hid-baseline-'));
const runId = randomBytes(6).toString('hex');
const container = `hid-schema-rehearsal-${randomUUID()}`;
const password = randomBytes(24).toString('hex');
const image = process.env.HID_REHEARSAL_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg16';
const localAdminUrl = process.env.HID_REHEARSAL_ADMIN_URL;
const migrator = localAdminUrl ? `hid_rehearsal_migrator_${runId}` : 'rehearsal_migrator';
const upgradeDatabase = localAdminUrl ? `hid_rehearsal_${runId}_upgrade` : 'hid_upgrade';
const cleanDatabase = localAdminUrl ? `hid_rehearsal_${runId}_clean` : 'hid_clean';
const applicationSchemas = ['platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab', 'pharmacy',
  'outreach', 'integration', 'migration'];
let started = false;
let localCreated = false;
let server;
const clients = new Set();
function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
}
function git(...args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function run(url, args = [], directory) {
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: url,
    DATABASE_SSL: 'false', MIGRATION_TARGET: 'rds' };
  delete env.DATABASE_SSL_ROOT_CERT_BASE64;
  delete env.HID_TEST_MIGRATION_DIRECTORY;
  delete env.HID_REHEARSAL_ADMIN_URL;
  if (directory) env.HID_TEST_MIGRATION_DIRECTORY = directory;
  try {
    return execFileSync(process.execPath, [path.join(scripts, 'apply-migrations.mjs'), ...args], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
    });
  } catch (error) {
    throw new Error(`Schema rehearsal failed: ${String(error.stderr ?? '').trim()}`);
  }
}
function serverUrl(user, database, secret) {
  const connection = new URL(server.base);
  connection.username = user;
  connection.password = secret ?? '';
  connection.pathname = `/${database}`;
  return connection.href;
}
async function connect(user, database) {
  const isAdmin = user === server.admin;
  const client = new pg.Client({ connectionString: serverUrl(user, database, isAdmin ? server.adminPassword : password) });
  // A first-boot PostgreSQL image stops its bootstrap server once. Handle
  // connection errors explicitly instead of hiding the rehearsal result.
  client.on('error', () => {});
  try { await client.connect(); } catch (error) { await client.end().catch(() => {}); throw error; }
  clients.add(client);
  return client;
}
async function close(client) { clients.delete(client); await client.end(); }
// Every runtime role's EXECUTE, table, sequence and schema privileges in the
// application schemas, other than those it holds as the object's owner
// (runtime-grants.sql hands the delivery commands to hid_event_delivery_commands
// and, when re-applied, revokes that owner's own EXECUTE, which nothing needs).
async function runtimePrivileges(client) {
  const roles = `select oid, rolname from pg_roles where rolname ~ '^hid_' and rolname <> $2 and not rolsuper`;
  const result = await client.query(`
    with runtime as (${roles})
    select runtime.rolname || ' execute ' || proc.oid::regprocedure::text as privilege
      from runtime cross join pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
     where namespace.nspname = any($1) and proc.prokind in ('f', 'p')
       and not pg_has_role(runtime.oid, proc.proowner, 'MEMBER')
       and has_function_privilege(runtime.oid, proc.oid, 'EXECUTE')
    union all
    select runtime.rolname || ' ' || privilege_type || ' ' || relation.oid::regclass::text
      from runtime cross join pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege_type
     where namespace.nspname = any($1) and relation.relkind in ('r', 'p', 'v', 'm')
       and not pg_has_role(runtime.oid, relation.relowner, 'MEMBER')
       and has_table_privilege(runtime.oid, relation.oid, privilege_type)
    union all
    select runtime.rolname || ' ' || privilege_type || ' ' || sequence.oid::regclass::text
      from runtime cross join pg_class sequence join pg_namespace namespace on namespace.oid = sequence.relnamespace
      cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) privilege_type
     where namespace.nspname = any($1) and sequence.relkind = 'S'
       and not pg_has_role(runtime.oid, sequence.relowner, 'MEMBER')
       and has_sequence_privilege(runtime.oid, sequence.oid, privilege_type)
    union all
    select runtime.rolname || ' ' || privilege_type || ' schema ' || namespace.nspname
      from runtime cross join pg_namespace namespace cross join unnest(array['USAGE', 'CREATE']) privilege_type
     where namespace.nspname = any($1) and not pg_has_role(runtime.oid, namespace.nspowner, 'MEMBER')
       and has_schema_privilege(runtime.oid, namespace.oid, privilege_type)
    order by 1`, [applicationSchemas, migrator]);
  return result.rows.map(row => row.privilege);
}
try {
  const declaration = JSON.parse(await readFile(path.join(repository, 'config/production-schema-compatibility.json'), 'utf8'));
  const declared = Object.keys(declaration.files ?? {})
    .filter(name => name.startsWith('services/ehr-api/database/migrations/'))
    .map(name => path.basename(name)).sort();
  assert.ok(declared.length > 0, 'The schema declaration names no migration');
  const files = (await readdir(migrationDirectory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const baseline = files.filter(name => !declared.includes(name));
  assert.deepEqual(files.slice(baseline.length), declared,
    'The declared migrations must be the newest migration files');
  for (const name of baseline) await copyFile(path.join(migrationDirectory, name), path.join(baselineDirectory, name));
  assert.equal((await readdir(baselineDirectory)).length, baseline.length);
  let baselineRevision = 'file';
  let baselineGrants;
  if (process.env.HID_BASELINE_RUNTIME_GRANTS) {
    baselineGrants = await readFile(process.env.HID_BASELINE_RUNTIME_GRANTS, 'utf8');
  } else {
    const declaredPath = `services/ehr-api/database/migrations/${declared[0]}`;
    const addedBy = git('log', '--diff-filter=A', '--format=%H', '--', declaredPath).trim().split('\n').filter(Boolean).at(-1);
    baselineRevision = addedBy ? `${addedBy}^` : 'HEAD';
    baselineGrants = git('show', `${baselineRevision}:services/ehr-api/database/runtime-grants.sql`);
  }

  if (localAdminUrl) {
    const admin = new URL(localAdminUrl);
    server = { base: `postgresql://${admin.host}`, admin: decodeURIComponent(admin.username),
      adminPassword: decodeURIComponent(admin.password), adminDatabase: admin.pathname.slice(1) || 'postgres' };
  } else {
    docker('run', '-d', '--name', container, '--label', 'hid.purpose=disposable-schema-rehearsal',
      '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', image);
    started = true;
    const port = Number(docker('port', container, '5432/tcp').trim().split(':').at(-1));
    server = { base: `postgresql://127.0.0.1:${port}`, admin: 'postgres', adminPassword: password, adminDatabase: 'postgres' };
  }
  let admin;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { admin = await connect(server.admin, server.adminDatabase); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!admin) throw new Error('Disposable PostgreSQL did not become ready');
  assert.equal((await admin.query('select rolsuper from pg_roles where rolname = current_user')).rows[0].rolsuper, true,
    'The rehearsal administrator must be a superuser of a disposable server');
  await admin.query(`create role ${migrator} login nosuperuser nobypassrls createrole password '${password}'`);
  localCreated = true;
  for (const database of [upgradeDatabase, cleanDatabase]) {
    await admin.query(`create database ${database} owner ${migrator}`);
    const setup = await connect(server.admin, database);
    try {
      await setup.query('create extension vector with schema public');
      await setup.query('create extension pgcrypto with schema public');
      await setup.query('create extension "uuid-ossp" with schema public');
    } finally { await close(setup); }
  }
  await close(admin);
  const url = database => serverUrl(migrator, database, password);

  // 1. The baseline, then the role bootstrap production had before this release.
  run(url(upgradeDatabase), [], baselineDirectory);
  const upgrade = await connect(migrator, upgradeDatabase);
  const before = (await upgrade.query('select version, checksum_sha256, effective_checksum_sha256 from migration.schema_migrations order by version')).rows;
  assert.equal(before.length, baseline.length);
  // Runtime group-role provisioning is a separate security-administrator job,
  // not a capability granted to the schema migration login.
  const securityAdmin = await connect(server.admin, upgradeDatabase);
  await securityAdmin.query(baselineGrants);
  await securityAdmin.query(await readFile(runtimeRolesPath, 'utf8'));

  // 2. The release: a dry run of every pending migration in one transaction, then the migrations.
  const plan = run(url(upgradeDatabase), ['--plan']);
  assert.match(plan, new RegExp(`^${declared.length} pending migration\\(s\\)`));
  for (const name of declared) assert.ok(plan.includes(name), `The plan does not list ${name}`);
  const privilegesBeforeRelease = await runtimePrivileges(securityAdmin);
  run(url(upgradeDatabase), ['--dry-run']);
  assert.equal((await upgrade.query('select count(*)::int as n from migration.schema_migrations')).rows[0].n, baseline.length);
  assert.deepEqual(await runtimePrivileges(securityAdmin), privilegesBeforeRelease, 'The dry run changed a runtime privilege');
  run(url(upgradeDatabase));
  const after = (await upgrade.query('select version, checksum_sha256, effective_checksum_sha256 from migration.schema_migrations order by version')).rows;
  assert.equal(after.length, files.length);
  for (const recorded of before) assert.deepEqual(after.find(row => row.version === recorded.version), recorded);
  assert.match(run(url(upgradeDatabase), ['--plan']), /0 pending migration\(s\)/);

  // 3. The migrations granted what this commit's runtime-grants.sql grants.
  const privilegesAfterRelease = await runtimePrivileges(securityAdmin);
  await securityAdmin.query(await readFile(runtimeGrantsPath, 'utf8'));
  const privilegesAfterBootstrap = await runtimePrivileges(securityAdmin);
  const missing = privilegesAfterBootstrap.filter(privilege => !privilegesAfterRelease.includes(privilege));
  const extra = privilegesAfterRelease.filter(privilege => !privilegesAfterBootstrap.includes(privilege));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
    'A role bootstrap after the release would change runtime privileges: the migrations and runtime-grants.sql disagree');
  await securityAdmin.query(await readFile(runtimeRolesPath, 'utf8'));
  await close(securityAdmin);
  await close(upgrade);

  // 4. A new installation.
  run(url(cleanDatabase), ['--dry-run']);
  run(url(cleanDatabase));
  assert.match(run(url(cleanDatabase), ['--plan']), /0 pending migration\(s\)/);
  const bridgeClient = await connect(migrator, cleanDatabase);
  const additions = await rehearseStagingAdditions(bridgeClient, url(cleanDatabase));
  const medicalAdmin = await connect(server.admin, cleanDatabase);
  await medicalAdmin.query(await readFile(runtimeGrantsPath, 'utf8'));
  const patientSelfSql = (await readFile(path.resolve(scripts,'../database/tests/patient-self.integration.sql'),'utf8'))
    .replace(/^\\set ON_ERROR_STOP on\r?\n/, '');
  await medicalAdmin.query(patientSelfSql);
  const medicalImport = await rehearseMedicalImport(bridgeClient,medicalAdmin);
  await close(medicalAdmin);
  await close(bridgeClient);
  process.stdout.write(JSON.stringify({ status: 'passed', baseline: baseline.length, integrated: files.length,
    declared, baselineRuntimeGrants: baselineRevision,
    releaseOrder: 'baseline, role bootstrap, dry run of all pending migrations, migrations',
    upgradeDryRunRolledBack: true, appliedChecksumsPreserved: true,
    migrationGrantsMatchRuntimeGrants: privilegesAfterRelease.length, cleanInstall: true,
    migratorSuperuser: false, migratorBypassRls: false,
    runtimeGrants: 'passed with separate local security administrator', source: 'synthetic-empty-baseline',
    additiveBridge: additions, medicalImport, liveStagingCopyRehearsal: 'still required' }) + '\n');
} finally {
  for (const client of clients) await client.end().catch(() => {});
  if (started) docker('rm', '-f', container);
  if (localAdminUrl && localCreated) {
    const cleanup = new pg.Client({ connectionString: localAdminUrl });
    await cleanup.connect();
    try {
      for (const database of [upgradeDatabase, cleanDatabase]) {
        await cleanup.query(`drop database if exists ${database} with (force)`);
      }
      await cleanup.query(`drop role if exists ${migrator}`);
    } finally { await cleanup.end(); }
  }
  // mkdtemp returned this exact disposable directory, never a customer path.
  assert.ok(path.resolve(baselineDirectory).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(baselineDirectory, { recursive: true, force: true });
}
