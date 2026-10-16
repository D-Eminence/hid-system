#!/usr/bin/env node

// db:provision: provisions a new RDS database from the secrets of the
// one-shot provisioning task (MIGRATION_RUNBOOK.md §6.1 and §6.3,
// AWS_DEPLOYMENT_RUNBOOK.md §4). Exactly one command per run:
//
//   --administrator             as the RDS master: create the migration
//                               administrator (or set its password) and grant
//                               it CREATE on the database
//   --grant-variable-conflict   as the RDS master, before 0015 is applied:
//                               GRANT SET ON PARAMETER plpgsql.variable_conflict
//   --revoke-variable-conflict  as the RDS master, once 0083 is applied: revoke it
//   --runtime-logins            as the migration administrator: create the ten
//                               runtime LOGINs (or set their passwords), grant
//                               each its aggregate, then db:verify-logins
//   --verify-logins             db:verify-logins only (the task's default)
//
// It reads DATABASE_ADMIN_URL, DATABASE_MASTER_USERNAME,
// DATABASE_MASTER_PASSWORD (the master's commands only) and the ten
// DATABASE_LOGIN_URL_* variables; TLS follows DATABASE_SSL and
// DATABASE_SSL_ROOT_CERT_BASE64. The administrator never carries the name of
// a HID group role. Verification forbids the master and the administrator as
// runtime logins. It prints role names only, never a URL or password, and
// exits 1 on any refusal or failed check.
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';
import {
  administratorFromUrl, grantVariableConflict, masterConnectionUrl, parseCommand, provisionAdministrator,
  provisionRuntimeLogins, revokeVariableConflict, roleNameFromUrl, runtimeLoginPlan, verificationEnvironment,
} from './database-login-provisioning.mjs';
import { verifyRuntimeLogins } from './verify-runtime-logins.mjs';

const { Client } = pg;

async function withClient(url, applicationName, work) {
  const client = new Client(databaseOptions(url, applicationName));
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function masterUser(environment) {
  const user = environment.DATABASE_MASTER_USERNAME?.trim();
  if (!user || !/^[a-z_][a-z0-9_]{0,62}$/.test(user)) {
    throw new Error('DATABASE_MASTER_USERNAME must name the RDS master role');
  }
  return user;
}

async function verify(environment, administratorUser) {
  return verifyRuntimeLogins(verificationEnvironment(environment, masterUser(environment), administratorUser));
}

async function run(command, environment) {
  const adminUrl = environment.DATABASE_ADMIN_URL;
  if (command === '--verify-logins') {
    const verification = await verify(environment, roleNameFromUrl(adminUrl, 'DATABASE_ADMIN_URL'));
    return { status: verification.status, verification };
  }
  // Every changing command refuses an administrator named after a HID group
  // role here, before it connects.
  const administrator = administratorFromUrl(adminUrl);
  if (command === '--runtime-logins') {
    const plan = runtimeLoginPlan(environment, administrator, masterUser(environment));
    const logins = await withClient(adminUrl, 'hid-database-provisioning', (admin) => provisionRuntimeLogins(admin, plan));
    const verification = await verify(environment, administrator.user);
    return { status: verification.status, logins, verification };
  }
  const master = masterConnectionUrl(adminUrl, environment);
  return withClient(master.url, 'hid-database-provisioning', async (masterClient) => {
    if (command === '--administrator') {
      return { status: 'passed', ...await provisionAdministrator(masterClient, administrator, master.user) };
    }
    return withClient(adminUrl, 'hid-database-provisioning', async (admin) => ({ status: 'passed',
      ...(command === '--grant-variable-conflict'
        ? await grantVariableConflict(masterClient, admin, administrator)
        : await revokeVariableConflict(masterClient, admin, administrator)) }));
  });
}

/** A failure message that names no URL or password: our own refusals, or a PostgreSQL code and message. */
function safeMessage(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
    return `PostgreSQL ${error.code}: ${error.message}`;
  }
  if (error instanceof Error && !/postgres(?:ql)?:\/\//i.test(error.message)) return error.message;
  return 'connection or query failed';
}

async function main() {
  const command = parseCommand(process.argv.slice(2));
  const summary = await run(command, process.env);
  process.stdout.write(`${JSON.stringify({ command, ...summary }, null, 2)}\n`);
  if (summary.status !== 'passed') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Database provisioning failed: ${safeMessage(error)}\n`);
  process.exitCode = 1;
});
