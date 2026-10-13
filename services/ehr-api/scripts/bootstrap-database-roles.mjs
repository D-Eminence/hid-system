#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';
import { loadLocalEnvironment } from '../../../scripts/local-environment.mjs';

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(scriptDirectory, '..');
const repositoryDirectory = path.resolve(serverDirectory, '../..');

const localDevelopmentAdmin = process.argv.includes('--local-development-admin');
if (localDevelopmentAdmin) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('--local-development-admin is forbidden in production');
  }
  loadLocalEnvironment([
    path.join(repositoryDirectory, '.env.local'),
    path.join(serverDirectory, '.env.local'),
  ]);
}
const databaseAdminUrl = process.env.DATABASE_ADMIN_URL
  ?? (localDevelopmentAdmin ? process.env.DATABASE_URL : undefined);
const verifyOnly = process.argv.includes('--verify-only');
const grantsPath = path.join(serverDirectory, 'database/runtime-grants.sql');
const assertionsPath = path.join(serverDirectory, 'database/tests/runtime-roles.integration.sql');

async function main() {
  if (!databaseAdminUrl) {
    throw new Error(
      'DATABASE_ADMIN_URL is required and must identify the migration or database security administrator',
    );
  }
  const [grantSql, assertionSql] = await Promise.all([
    readFile(grantsPath, 'utf8'),
    readFile(assertionsPath, 'utf8'),
  ]);
  const client = new Client(databaseOptions(databaseAdminUrl, 'hid-role-bootstrap'));
  await client.connect();

  try {
    await client.query("select pg_advisory_lock(hashtextextended('hid-runtime-role-bootstrap', 0))");
    if (!verifyOnly) {
      // client.query(grantSql) has no parameters, so it sends the whole file
      // as one simple-query batch, which PostgreSQL runs as one implicit
      // transaction. runtime-grants.sql relies on that: its temporary SET and
      // INHERIT memberships in the technical owners and their schema CREATE
      // grants never become visible to another session, and a failed run
      // leaves none of them behind. Never split the file into separate
      // statements or run it in autocommit (with psql, only `psql -1`).
      // The SQL is idempotent, the advisory lock serializes concurrent runs,
      // and a failed run rolls back completely and can be retried after the
      // reported error is corrected. lock_timeout applies to each statement
      // of this session only; locks taken are held until the batch commits.
      await client.query("set lock_timeout = '5s'");
      await client.query("set statement_timeout = '120s'");
      await client.query(grantSql);
      await client.query(assertionSql);
      process.stdout.write('Runtime database roles provisioned and verified\n');
      return;
    }

    await client.query(assertionSql);
    process.stdout.write('Runtime database role verification passed\n');
  } finally {
    await client.query(
      "select pg_advisory_unlock(hashtextextended('hid-runtime-role-bootstrap', 0))",
    ).catch(() => undefined);
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(
    `Database role bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
