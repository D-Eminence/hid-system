// 0154's busy refusal for pharmacy.dispensing_reversals, live, through this runner (Rahman's review of #331, 25
// November 2026, finding 1). Section 3 prints the reversals' policies (pg_get_expr opens the table it prints for), so
// section 2 takes ACCESS SHARE NOWAIT on the reversals with the other tables it reads, before the two ACCESS EXCLUSIVE
// locks. Before that fix, behind another session's ACCESS EXCLUSIVE on the reversals (an ALTER, VACUUM FULL, TRUNCATE
// or LOCK), the apply waited the runner's 5 s lock_timeout while it held ACCESS EXCLUSIVE on ehr.prescriptions and
// pharmacy.dispensings (a plain read of either, started 1.5 s in, took 3.6-4.2 s), then failed with the server's
// "canceling statement due to lock timeout", which the dry run does not retry.
//
// Runs only when HID_BUSY_CASE_ADMIN_URL names a superuser of a disposable PostgreSQL 16 with pgvector (skipped
// otherwise, so a run without a database is unchanged). It makes its own database and NOSUPERUSER NOBYPASSRLS
// migrator there, applies 0001-0153 with this runner (a copy of the migration folder without 0154 and later files),
// and drops both at the end. Fictional data only: the database has none.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(scripts, '../database/migrations');
const adminUrl = process.env.HID_BUSY_CASE_ADMIN_URL;
const FILE = '0154_prescription_refills.sql';
const TABLES = 'pharmacy.dispensings, ehr.prescriptions or a table 0154 reads (the Pharmacy work items, the order '
  + 'routes, 0133\'s claims or the dispensing reversals)';
const QUIETER = 'nothing applied; run the release again at a quieter time';

function runner(url, directory, args = [], extra = {}) {
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: 'false',
    MIGRATION_TARGET: 'rds', ...(directory ? { HID_TEST_MIGRATION_DIRECTORY: directory } : {}), ...extra };
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(scripts, 'apply-migrations.mjs'), ...args], { env, timeout: 600_000 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr, ms: Date.now() - started }));
  });
}

test('0154 refuses with its own words, at once per attempt and holding nothing, while the dispensing reversals are '
  + 'busy', { skip: adminUrl ? false : 'HID_BUSY_CASE_ADMIN_URL is not set' }, async () => {
  const suffix = randomBytes(5).toString('hex');
  const database = `hid_busy_0154_${suffix}`;
  const migrator = `hid_busy_migrator_${suffix}`;
  const password = randomBytes(18).toString('hex');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const before = await mkdtemp(path.join(tmpdir(), 'hid-0154-busy-'));
  const clients = [];
  const connect = async (user, secret) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = secret;
    url.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: url.href });
    client.on('error', () => {});
    await client.connect();
    clients.push(client);
    return { client, url: url.href };
  };
  try {
    assert.equal((await admin.query('select rolsuper from pg_roles where rolname = current_user')).rows[0].rolsuper, true);
    await admin.query(`create role ${migrator} login nosuperuser nobypassrls createrole password '${password}'`);
    await admin.query(`create database ${database} owner ${migrator}`);
    const { client: setup } = await connect(new URL(adminUrl).username, decodeURIComponent(new URL(adminUrl).password));
    await setup.query('create extension vector with schema public; create extension pgcrypto with schema public; '
      + 'create extension "uuid-ossp" with schema public');
    const files = (await readdir(migrations)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && name < FILE);
    for (const name of files) await copyFile(path.join(migrations, name), path.join(before, name));
    const { client: owner, url } = await connect(migrator, password);
    const base = await runner(url, before);
    assert.ok(base.ok, base.stderr);
    const ledger = async () => (await owner.query('select count(*)::int as n from migration.schema_migrations'))
      .rows[0].n;
    const applied = await ledger();
    assert.equal(applied, files.length);

    // Another session holds ACCESS EXCLUSIVE on the reversals, as an ALTER, VACUUM FULL, TRUNCATE or LOCK would.
    const { client: holder } = await connect(migrator, password);
    await holder.query('begin');
    await holder.query('lock table pharmacy.dispensing_reversals in access exclusive mode');

    // The apply: the file's own 55P03 after about 5 s, nothing applied. A plain read of pharmacy.dispensings started
    // 1.5 s in is not held up, because no attempt ever holds the strong locks (the ACCESS SHARE statement, which names
    // the reversals, comes first and fails at once).
    const { client: reader } = await connect(migrator, password);
    const applying = runner(url, undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const readStarted = Date.now();
    await reader.query('select count(*) from pharmacy.dispensings');
    const readMs = Date.now() - readStarted;
    const apply = await applying;
    assert.equal(apply.ok, false);
    assert.match(apply.stderr, new RegExp(`^Migration failed: 0154: ${TABLES.replace(/[().]/g, '\\$&')} stayed busy for `
      + `5 seconds; ${QUIETER}$`, 'm'));
    assert.doesNotMatch(apply.stderr, /lock timeout/);
    assert.ok(apply.ms >= 4_500 && apply.ms < 30_000, `the apply took ${apply.ms} ms`);
    assert.ok(readMs < 1_000, `a read of pharmacy.dispensings during the apply took ${readMs} ms`);
    assert.equal(await ledger(), applied);
    assert.equal((await owner.query(`select count(*)::int as n from pg_attribute
      where attrelid = 'pharmacy.dispensings'::regclass and attname = 'fill_number'`)).rows[0].n, 0);

    // The dry run: the same refusal is one the runner retries (its attempt lines), then its last words.
    const dry = await runner(url, undefined, ['--dry-run'],
      { HID_TEST_DRY_RUN_ATTEMPTS: '2', HID_TEST_DRY_RUN_PAUSE_MS: '100' });
    assert.equal(dry.ok, false);
    assert.deepEqual(dry.stdout.split('\n').filter((line) => /^Dry run attempt /.test(line)), [
      `Dry run attempt 1 of 2: ${FILE} was busy; rolled back, trying again in 100 ms`,
      `Dry run attempt 2 of 2: ${FILE} was busy; no attempt left`]);
    assert.match(dry.stderr, /stayed busy for 5 seconds; nothing applied; run the release again at a quieter time/);
    assert.equal(await ledger(), applied);

    // The holder leaves: the next run applies 0154, and a re-run finds nothing pending.
    await holder.query('rollback');
    const after = await runner(url, undefined);
    assert.ok(after.ok, after.stderr);
    assert.match(after.stdout, new RegExp(`Applied ${FILE}`));
    assert.match((await runner(url, undefined, ['--plan'])).stdout, /^0 pending migration\(s\)/);
    process.stdout.write(`# 0154 busy case: apply refused after ${apply.ms} ms; a read of pharmacy.dispensings 1.5 s in `
      + `took ${readMs} ms; dry run refused after 2 attempts (${dry.ms} ms); applied once the holder left\n`);
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await admin.query(`drop database if exists ${database} with (force)`).catch(() => {});
    await admin.query(`drop role if exists ${migrator}`).catch(() => {});
    await admin.end();
    await rm(before, { recursive: true, force: true });
  }
});
