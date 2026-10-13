#!/usr/bin/env node

// db:verify-logins (launch, DB-LOGIN-VERIFY). Connects with each service
// credential's own URL and runs database/runtime-login-assertions.sql on that
// connection, so a secret that holds the migration administrator's or the RDS
// master's URL, or a login with extra roles or owner privileges, fails here.
// db:verify-roles checks only the NOLOGIN group roles.
//
// Each credential's URL is read from DATABASE_LOGIN_URL_<CREDENTIAL>, for
// example DATABASE_LOGIN_URL_IDENTITY_API for identity-api and
// DATABASE_LOGIN_URL_EHR_API_SCANNER for the EHR scanner pool's
// WORKLOAD_DATABASE_URL. Every credential is required unless --partial is
// given (for example after rotating one secret). DATABASE_FORBIDDEN_LOGINS
// names the RDS master and the migration administrator, comma-separated.
// TLS follows DATABASE_SSL and DATABASE_SSL_ROOT_CERT_BASE64, as for the
// other database scripts. URLs and passwords are never printed.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const assertionsPath = path.resolve(scriptDirectory, '../database/runtime-login-assertions.sql');

/** Each runtime credential and the aggregate role its LOGIN must be a member of. */
export const RUNTIME_CREDENTIALS = Object.freeze({
  'identity-api': 'hid_identity_api_runtime',
  'ehr-api': 'hid_ehr_api_runtime',
  'ehr-api-scanner': 'hid_document_scanner',
  'lab-api': 'hid_lab_api_runtime',
  'pharmacy-api': 'hid_pharmacy_api_runtime',
  'ocr-api': 'hid_ocr_api_runtime',
  'ocr-worker': 'hid_ocr_worker',
  'outreach-api': 'hid_outreach_api_runtime',
  'event-dispatcher': 'hid_event_dispatcher',
  'notification-worker': 'hid_notification_worker',
});

export function credentialVariable(credential) {
  return `DATABASE_LOGIN_URL_${credential.toUpperCase().replaceAll('-', '_')}`;
}

/** The credentials to verify, in a fixed order. Throws when one is missing unless partial. */
export function selectedCredentials(environment, { partial = false } = {}) {
  const selected = [];
  const missing = [];
  for (const [credential, role] of Object.entries(RUNTIME_CREDENTIALS)) {
    const url = environment[credentialVariable(credential)];
    if (url) selected.push({ credential, role, url });
    else missing.push(credential);
  }
  if (selected.length === 0) {
    throw new Error(`No runtime credential URL is set; set ${credentialVariable('identity-api')} and the others`);
  }
  if (missing.length > 0 && !partial) {
    throw new Error(`Runtime credential URLs are missing for ${missing.join(', ')}; pass --partial to verify only some`);
  }
  return { selected, missing };
}

/** Role names that no runtime credential may authenticate as. */
export function forbiddenLogins(environment) {
  const names = (environment.DATABASE_FORBIDDEN_LOGINS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(name)) {
      throw new Error('DATABASE_FORBIDDEN_LOGINS must list role names separated by commas');
    }
  }
  return names;
}

/** A failure message that cannot carry a URL or password: SQL assertions only. */
export function safeFailure(error) {
  if (error && typeof error === 'object' && error.code === 'P0001' && typeof error.message === 'string') {
    return error.message;
  }
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'unknown';
  return `connection or query failed (code ${code})`;
}

async function verifyCredential({ credential, role, url }, assertions, forbidden) {
  const client = new Client(databaseOptions(url, 'hid-login-verification'));
  await client.connect();
  try {
    await client.query(
      'select set_config($1, $2, false), set_config($3, $4, false)',
      ['hid_verify.expected_role', role, 'hid_verify.forbidden_logins', forbidden.join(',')],
    );
    await client.query(assertions);
    const { rows } = await client.query('select current_user as login');
    return { credential, expected_role: role, login: rows[0].login };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function verifyRuntimeLogins(environment, { partial = false } = {}) {
  const { selected, missing } = selectedCredentials(environment, { partial });
  const forbidden = forbiddenLogins(environment);
  const assertions = await readFile(assertionsPath, 'utf8');
  const verified = [];
  const failures = [];
  for (const target of selected) {
    try {
      verified.push(await verifyCredential(target, assertions, forbidden));
    } catch (error) {
      failures.push({ credential: target.credential, expected_role: target.role, failure: safeFailure(error) });
    }
  }
  // Each service has its own LOGIN; two credentials may not share one.
  const byLogin = new Map();
  for (const result of verified) {
    byLogin.set(result.login, [...(byLogin.get(result.login) ?? []), result.credential]);
  }
  for (const [login, credentials] of byLogin) {
    if (credentials.length > 1) {
      failures.push({ credential: credentials.join(', '), failure: `credentials share the LOGIN ${login}` });
    }
  }
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    verified,
    failures,
    not_checked: missing,
  };
}

async function main() {
  const summary = await verifyRuntimeLogins(process.env, { partial: process.argv.includes('--partial') });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== 'passed') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`Runtime login verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
