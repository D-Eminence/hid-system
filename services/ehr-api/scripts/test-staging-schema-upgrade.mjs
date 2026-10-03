#!/usr/bin/env node
// Disposable synthetic rehearsal. This does not connect to AWS or import PHI.
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
const migrationDirectory = path.resolve(scripts, '../database/migrations');
const baselineDirectory = await mkdtemp(path.join(tmpdir(), 'hid-baseline-'));
const container = `hid-schema-rehearsal-${randomUUID()}`;
const password = randomBytes(24).toString('hex');
const image = process.env.HID_REHEARSAL_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg16';
let started = false;
const clients = new Set();
function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
}
function run(url, args = [], directory) {
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: url,
    DATABASE_SSL: 'false', MIGRATION_TARGET: 'rds' };
  delete env.DATABASE_SSL_ROOT_CERT_BASE64;
  delete env.HID_TEST_MIGRATION_DIRECTORY;
  if (directory) env.HID_TEST_MIGRATION_DIRECTORY = directory;
  try {
    return execFileSync(process.execPath, [path.join(scripts, 'apply-migrations.mjs'), ...args], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
    });
  } catch (error) {
    throw new Error(`Schema rehearsal failed: ${String(error.stderr ?? '').trim()}`);
  }
}
async function connect(user, database, port) {
  const client = new pg.Client({ host: '127.0.0.1', port, user, password, database });
  // A first-boot PostgreSQL image stops its bootstrap server once. Handle
  // connection errors explicitly instead of hiding the rehearsal result.
  client.on('error', () => {});
  try { await client.connect(); } catch (error) { await client.end().catch(() => {}); throw error; }
  clients.add(client);
  return client;
}
try {
  for (const name of await readdir(migrationDirectory)) {
    if (/^00(?:0[1-9]|[12][0-9]|3[0-2])_.*\.sql$/.test(name)
      || ['0033_patient_record_embeddings.sql', '0034_legacy_patient_access_secret_preservation.sql'].includes(name)) {
      await copyFile(path.join(migrationDirectory, name), path.join(baselineDirectory, name));
    }
  }
  assert.equal((await readdir(baselineDirectory)).length, 34);
  docker('run', '-d', '--name', container, '--label', 'hid.purpose=disposable-schema-rehearsal',
    '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', image);
  started = true;
  const port = Number(docker('port', container, '5432/tcp').trim().split(':').at(-1));
  let admin;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { admin = await connect('postgres', 'postgres', port); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!admin) throw new Error('Disposable PostgreSQL did not become ready');
  await admin.query(`create role rehearsal_migrator login nosuperuser nobypassrls createrole password '${password}'`);
  for (const database of ['hid_upgrade', 'hid_clean']) {
    await admin.query(`create database ${database} owner rehearsal_migrator`);
    const setup = await connect('postgres', database, port);
    try {
      await setup.query('create extension vector with schema public');
      await setup.query('create extension pgcrypto with schema public');
      await setup.query('create extension "uuid-ossp" with schema public');
    } finally { await setup.end(); }
  }
  await admin.end();
  const url = database => {
    const connection = new URL('postgresql://127.0.0.1');
    connection.username = 'rehearsal_migrator';
    connection.password = password;
    connection.port = String(port);
    connection.pathname = `/${database}`;
    return connection.href;
  };
  run(url('hid_upgrade'), [], baselineDirectory);
  const upgrade = await connect('rehearsal_migrator', 'hid_upgrade', port);
  const before = (await upgrade.query('select version, checksum_sha256, effective_checksum_sha256 from migration.schema_migrations order by version')).rows;
  assert.equal(before.length, 34);
  run(url('hid_upgrade'), ['--dry-run']);
  assert.equal((await upgrade.query('select count(*)::int as n from migration.schema_migrations')).rows[0].n, 34);
  run(url('hid_upgrade'));
  const after = (await upgrade.query('select version, checksum_sha256, effective_checksum_sha256 from migration.schema_migrations order by version')).rows;
  assert.equal(after.length, 64);
  for (const recorded of before) assert.deepEqual(after.find(row => row.version === recorded.version), recorded);
  assert.match(run(url('hid_upgrade'), ['--plan']), /0 pending migration\(s\)/);
  // Runtime group-role provisioning is a separate security-administrator job,
  // not a capability granted to the schema migration login.
  const securityAdmin = await connect('postgres', 'hid_upgrade', port);
  await securityAdmin.query(await readFile(path.resolve(scripts, '../database/runtime-grants.sql'), 'utf8'));
  await securityAdmin.query(await readFile(path.resolve(scripts, '../database/tests/runtime-roles.integration.sql'), 'utf8'));
  await securityAdmin.end();
  await upgrade.end();
  run(url('hid_clean'), ['--dry-run']);
  run(url('hid_clean'));
  assert.match(run(url('hid_clean'), ['--plan']), /0 pending migration\(s\)/);
  const bridgeClient = await connect('rehearsal_migrator', 'hid_clean', port);
  const additions = await rehearseStagingAdditions(bridgeClient, url('hid_clean'));
  const medicalAdmin = await connect('postgres','hid_clean',port);
  await medicalAdmin.query(await readFile(path.resolve(scripts,'../database/runtime-grants.sql'),'utf8'));
  const medicalImport = await rehearseMedicalImport(bridgeClient,medicalAdmin);
  await medicalAdmin.end();
  await bridgeClient.end();
  process.stdout.write(JSON.stringify({ status: 'passed', baseline: 34, integrated: 64,
    upgradeDryRunRolledBack: true, appliedChecksumsPreserved: true, cleanInstall: true,
    migratorSuperuser: false, runtimeGrants: 'passed with separate local security administrator', source: 'synthetic-empty-baseline',
    additiveBridge: additions, medicalImport, liveStagingCopyRehearsal: 'still required' }) + '\n');
} finally {
  for (const client of clients) await client.end().catch(() => {});
  if (started) docker('rm', '-f', container);
  // mkdtemp returned this exact disposable directory, never a customer path.
  assert.ok(path.resolve(baselineDirectory).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(baselineDirectory, { recursive: true, force: true });
}
