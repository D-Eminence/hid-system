#!/usr/bin/env node

// admin:bootstrap: seeds the first platform Super Admins, once. In production
// name two or three people: on a new database by email address in
// PLATFORM_ADMIN_EMAILS (owner decision 2026-10-16: the run creates their
// platform-only accounts with no password, and each person sets their own
// with the admin password reset), or two or three existing accounts in
// PLATFORM_ADMIN_ACCOUNT_IDS. The one-account form is refused when NODE_ENV
// is production. After this run no command can add a Super Admin without a
// second one's decision (platform-admin-bootstrap.mjs).
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';
import { bootstrapInput, bootstrapPlatformAdmins, bootstrapPlatformAdminsByEmail } from './platform-admin-bootstrap.mjs';
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
    if (input.emails) {
      // The new account IDs, never the addresses.
      const { accountIds, replacedAccountIds } = await bootstrapPlatformAdminsByEmail(client, input);
      process.stdout.write(`Platform Super Admin bootstrap created ${accountIds.length} platform-only accounts without `
        + `a password, in the order of PLATFORM_ADMIN_EMAILS, and granted each Super Admin: ${accountIds.join(', ')}\n`);
      if (replacedAccountIds.length > 0) {
        process.stdout.write(`It replaced ${replacedAccountIds.length} unused email-seeded accounts, now deleted and `
          + `their Super Admin assignments revoked: ${replacedAccountIds.join(', ')}\n`);
      }
      process.stdout.write('Next, each person opens the admin password reset (Forgot your password? on the admin '
        + 'sign-in page, /admin/recover), sets their own password from the emailed code, signs in to the admin site and '
        + 'enrols an authenticator app.\n');
      return;
    }
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
