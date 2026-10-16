#!/usr/bin/env node

// admin:bootstrap: seeds the first platform Super Admins, once. In production
// name two or three distinct accounts in PLATFORM_ADMIN_ACCOUNT_IDS: after
// this run no command can add a Super Admin without a second one's decision
// (platform-admin-bootstrap.mjs).
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';
import { bootstrapInput, bootstrapPlatformAdmins } from './platform-admin-bootstrap.mjs';
import { loadLocalEnvironment } from '../../../scripts/local-environment.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, '../../..');
if (process.env.NODE_ENV !== 'production') {
  loadLocalEnvironment([
    path.join(repositoryDirectory, '.env.local'),
    path.join(scriptDirectory, '../.env.local'),
  ]);
}

async function main() {
  const databaseAdminUrl = process.env.DATABASE_ADMIN_URL;
  if (!databaseAdminUrl) throw new Error('DATABASE_ADMIN_URL is required');
  const input = bootstrapInput(process.env);

  const client = new Client(databaseOptions(databaseAdminUrl, 'hid-platform-admin-bootstrap'));
  await client.connect();
  try {
    const granted = await bootstrapPlatformAdmins(client, input);
    process.stdout.write(`Platform Super Admin bootstrap completed for account${granted.length === 1 ? '' : 's'} `
      + `${granted.join(', ')}\n`);
    if (granted.length === 1) {
      process.stderr.write('Only one Super Admin: a second can be added only by a two-person approval, and a '
        + 'clinician application approved only by a second Super Admin. Seed two or three at once with '
        + 'PLATFORM_ADMIN_ACCOUNT_IDS.\n');
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Platform Super Admin bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
