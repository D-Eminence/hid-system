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
import { databaseOptions } from './database-options.mjs';

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
const migrationDirectory = path.resolve(scriptDirectory, '../database/migrations');
const dryRun = process.argv.includes('--dry-run');
const planOnly = process.argv.includes('--plan');
// `--through <file>` plans, dry-runs or applies the pending migrations up to
// and including that migration, in the usual order, and nothing after it (an
// upgrade rehearsal, e.g. verify-non-superuser-database.mjs). Without the flag
// every pending migration is taken, as before.
const throughIndex = process.argv.indexOf('--through');
const through = throughIndex === -1 ? undefined : process.argv[throughIndex + 1];
const databaseUrl = process.env.DATABASE_URL;

if (throughIndex !== -1 && (!through || !/^\d{4}_[a-z0-9_]+\.sql$/.test(through))) {
  throw new Error('--through needs a migration file name such as 0093_break_glass_launch_with_limits.sql');
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
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
  )
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
    return { version: name, sql, checksum: checksum(sql) };
  }));
}

function orderMigrations(migrations) {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const prerequisites = new Map([
    // 0038 is an accepted immutable migration. Its campaign_members
    // foreign key requires the unique key introduced by 0042, so the
    // prerequisite must run first on a clean database.
    ['0038_outreach_campaign_workspaces.sql', ['0042_outreach_campaign_membership_key.sql']],
  ]);
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(version) {
    if (visited.has(version)) return;
    if (visiting.has(version)) throw new Error(`Migration prerequisite cycle detected at ${version}`);
    const migration = byVersion.get(version);
    if (!migration) throw new Error(`Migration prerequisite references missing migration ${version}`);

    visiting.add(version);
    for (const prerequisite of prerequisites.get(version) ?? []) visit(prerequisite);
    visiting.delete(version);
    visited.add(version);
    ordered.push(migration);
  }

  for (const migration of migrations) visit(migration.version);
  return ordered;
}

async function appliedMigrations(client) {
  const result = await client.query(
    'select version, checksum_sha256 from migration.schema_migrations order by version',
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum_sha256.trim()]));
}

async function main() {
  const migrations = await loadMigrations();
  // Refused before connecting, so an unknown name changes nothing.
  if (through !== undefined && !migrations.some((migration) => migration.version === through)) {
    throw new Error(`--through names no migration file: ${through}`);
  }
  const client = new Client(databaseOptions(databaseUrl, 'hid-schema-migrator'));
  await client.connect();

  try {
    await client.query("select pg_advisory_lock(hashtextextended('hid-schema-migrations', 0))");

    if (dryRun || planOnly) await client.query('begin');
    await client.query(bootstrapSql);
    const applied = await appliedMigrations(client);

    for (const migration of migrations) {
      const recordedChecksum = applied.get(migration.version);
      if (recordedChecksum && recordedChecksum !== migration.checksum) {
        throw new Error(`Checksum mismatch for already-applied migration ${migration.version}`);
      }
    }

    const ordered = orderMigrations(migrations);
    const last = through === undefined ? ordered.length - 1 : ordered.findIndex((migration) => migration.version === through);
    const pending = ordered.slice(0, last + 1).filter((migration) => !applied.has(migration.version));
    process.stdout.write(`${pending.length} pending migration(s)\n`);
    for (const migration of pending) {
      process.stdout.write(`${migration.version} ${migration.checksum}\n`);
    }

    if (planOnly) {
      await client.query('rollback');
      return;
    }

    if (dryRun) {
      await client.query("set local lock_timeout = '5s'");
      await client.query("set local statement_timeout = '120s'");
      for (const migration of pending) await client.query(migration.sql);
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
        await client.query(migration.sql);
        await client.query(
          `insert into migration.schema_migrations (version, checksum_sha256, execution_ms)
           values ($1, $2, $3)`,
          [migration.version, migration.checksum, Date.now() - startedAt],
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
