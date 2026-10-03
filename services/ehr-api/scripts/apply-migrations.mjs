#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  environmentWithLocalFiles,
  loadLocalEnvironment,
} from '../../../scripts/local-environment.mjs';
import { databaseOptions, managedDatabaseUrl } from './database-options.mjs';
import { orderMigrations } from './migration-order.mjs';

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(scriptDirectory, '..');
const repositoryDirectory = path.resolve(serverDirectory, '../..');
const localEnvironmentFiles = [
  path.join(repositoryDirectory, '.env.local'),
  path.join(serverDirectory, '.env.local'),
];
const configuredNodeEnvironment = process.env.NODE_ENV
  ?? environmentWithLocalFiles(localEnvironmentFiles, {}).NODE_ENV;
if (configuredNodeEnvironment !== 'production') loadLocalEnvironment(localEnvironmentFiles);
if (process.env.HID_TEST_MIGRATION_DIRECTORY && process.env.NODE_ENV !== 'test') {
  throw new Error('The migration directory override is test-only');
}
const migrationDirectory = process.env.HID_TEST_MIGRATION_DIRECTORY
  ? path.resolve(process.env.HID_TEST_MIGRATION_DIRECTORY)
  : path.resolve(scriptDirectory, '../database/migrations');
const rdsCompatibilityDirectory = path.resolve(scriptDirectory, '../database/rds-compat');
const dryRun = process.argv.includes('--dry-run');
const planOnly = process.argv.includes('--plan');
const databaseUrl = process.env.DATABASE_URL || managedDatabaseUrl();

if (!databaseUrl) {
  throw new Error('Set DATABASE_URL or DATABASE_HOST, DATABASE_USERNAME, and DATABASE_PASSWORD');
}

const bootstrapSql = `
  create schema if not exists migration;
  revoke all on schema migration from public;
  create table if not exists migration.schema_migrations (
    version text primary key,
    checksum_sha256 char(64) not null,
    applied_at timestamptz not null default clock_timestamp(),
    applied_by text not null default current_user,
    execution_ms integer not null check (execution_ms >= 0)
  );
  alter table migration.schema_migrations
    add column if not exists effective_checksum_sha256 char(64)
`;

function checksum(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function loadMigrations() {
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (names.length === 0) throw new Error('No migration files were found');
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(migrationDirectory, name), 'utf8');
    const effectiveSql = process.env.MIGRATION_TARGET === 'rds'
      && name === '0015_ocr_claim_column_resolution.sql'
      ? await readFile(path.join(rdsCompatibilityDirectory, name), 'utf8')
      : sql;
    return {
      version: name,
      checksum: checksum(sql),
      effectiveSql,
      effectiveChecksum: checksum(effectiveSql),
    };
  }));
}

async function appliedMigrations(client) {
  const result = await client.query(
    'select version, checksum_sha256, effective_checksum_sha256 from migration.schema_migrations order by version',
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}

async function main() {
  const migrations = await loadMigrations();
  const client = new Client(databaseOptions(databaseUrl, 'hid-schema-migrator'));
  await client.connect();

  try {
    await client.query("select pg_advisory_lock(hashtextextended('hid-schema-migrations', 0))");

    if (dryRun || planOnly) await client.query('begin');
    await client.query(bootstrapSql);
    const applied = await appliedMigrations(client);

    const available = new Set(migrations.map((migration) => migration.version));
    for (const version of applied.keys()) {
      if (!available.has(version)) throw new Error(`Applied migration is missing from this release: ${version}`);
    }

    for (const migration of migrations) {
      const recorded = applied.get(migration.version);
      if (recorded && recorded.checksum_sha256.trim() !== migration.checksum) {
        throw new Error(`Checksum mismatch for already-applied migration ${migration.version}`);
      }
      if (recorded?.effective_checksum_sha256
        && recorded.effective_checksum_sha256.trim() !== migration.effectiveChecksum) {
        throw new Error(`Effective SQL checksum mismatch for ${migration.version}`);
      }
    }

    const pending = orderMigrations(migrations).filter((migration) => !applied.has(migration.version));
    process.stdout.write(`${pending.length} pending migration(s)\n`);
    for (const migration of pending) {
      process.stdout.write(`${migration.version} ${migration.checksum}\n`);
      if (migration.effectiveChecksum !== migration.checksum) {
        process.stdout.write(`  RDS compatibility SQL ${migration.effectiveChecksum}\n`);
      }
    }

    if (planOnly) {
      await client.query('rollback');
      return;
    }

    if (dryRun) {
      await client.query("set local lock_timeout = '5s'");
      await client.query("set local statement_timeout = '120s'");
      for (const migration of pending) {
        try {
          await client.query(migration.effectiveSql);
        } catch (error) {
          throw new Error(`Migration ${migration.version}: ${error.message}`);
        }
      }
      await client.query('rollback');
      process.stdout.write('Dry run succeeded; all changes were rolled back\n');
      return;
    }

    for (const migration of pending) {
      const startedAt = Date.now();
      try {
        await client.query('begin');
        await client.query("set local lock_timeout = '5s'");
        await client.query("set local statement_timeout = '120s'");
        await client.query(migration.effectiveSql);
        await client.query(
          `insert into migration.schema_migrations
             (version, checksum_sha256, effective_checksum_sha256, execution_ms)
           values ($1, $2, $3, $4)`,
          [migration.version, migration.checksum, migration.effectiveChecksum, Date.now() - startedAt],
        );
        await client.query('commit');
        process.stdout.write(`Applied ${migration.version}\n`);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtextextended('hid-schema-migrations', 0))").catch(() => undefined);
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
