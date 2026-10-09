// Admin console end-to-end harness (Phase 4 Stage 5), part 2 of 2: drives the
// Health-id platform admin console (built and served by its `vite preview`, which
// proxies /api/v1 to server.mjs) in Chromium. Run as the same non-root user as
// server.mjs, after it reports ready. Each numbered check is independent: a
// failure is recorded with screenshots and the remaining checks still run.
//
// Environment:
//   HID_E2E_SOCKET, HID_E2E_DB_SUPERUSER, HID_E2E_WORKDIR  as for server.mjs (fixtures.json is read there)
//   HID_E2E_CONSOLE_URL   console origin (default http://127.0.0.1:3200)
//   HID_E2E_CONTROL_URL   server.mjs control port (default http://127.0.0.1:4011)
//   HID_E2E_PLAYWRIGHT    Playwright module to import (default 'playwright'; not a repository dependency)
//   HID_E2E_EVIDENCE      evidence JSON path (default <workdir>/evidence.json)
//   HID_BACKEND_SHA, HID_FRONTEND_SHA  recorded in the evidence
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = (name) => process.env[name] || (() => { throw new Error(`${name} is required`); })();
const dir = required('HID_E2E_WORKDIR');
const { chromium } = await import(process.env.HID_E2E_PLAYWRIGHT || 'playwright');
const fixtures = JSON.parse(readFileSync(join(dir, 'fixtures.json'), 'utf8'));
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'));
const { Pool } = require('pg');
const db = new Pool({ host: required('HID_E2E_SOCKET'), user: process.env.HID_E2E_DB_SUPERUSER || 'hid_rehearsal_admin',
  database: fixtures.database, max: 2 });
const base = process.env.HID_E2E_CONSOLE_URL || 'http://127.0.0.1:3200';
const control = process.env.HID_E2E_CONTROL_URL || 'http://127.0.0.1:4011';
const code = async (secret) => (await fetch(`${control}/code?secret=${encodeURIComponent(secret)}`)).text();
const quiet = (promise) => promise.then(() => true, () => false);
const results = [];
const EXPIRED = 'Your platform session expired after 15 minutes without activity or at its 8-hour limit. Sign in again to continue.';
const REVOKED = /^Your platform session was ended before it expired/;
const browser = await chromium.launch();

async function context(label) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const problems = [];
  page.on('pageerror', (error) => problems.push(`${label} page error: ${error.message}`));
  page.on('console', (message) => {
    // Refused requests (401/403/409) are expected in these flows and logged by the browser.
    if (message.type() === 'error' && !/status of (40[0-9]|409|428)/.test(message.text())) problems.push(`${label} console: ${message.text()}`);
  });
  return { ctx, page, problems };
}

async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, status: 'passed', ms: Date.now() - started, detail: detail ?? null });
  } catch (error) {
    const shot = join(dir, `failure-${results.length + 1}.png`);
    await quiet(A.page.screenshot({ path: shot, fullPage: true }));
    await quiet(B.page.screenshot({ path: shot.replace('.png', '-b.png'), fullPage: true }));
    results.push({ name, status: 'failed', ms: Date.now() - started, detail: String(error?.stack ?? error).slice(0, 1500), screenshot: shot });
  }
}

const main = (page) => page.locator('main');

async function enroll(page, email) {
  await page.goto(`${base}/admin`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(fixtures.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Begin setup' }).click();
  const secret = (await page.getByLabel('Setup key').textContent()).replace(/\s+/g, '');
  await page.getByLabel('Authenticator code').fill(await code(secret));
  await page.getByRole('button', { name: 'Activate authenticator' }).click();
  await page.getByLabel('I have stored these recovery codes somewhere safe').check();
  await page.getByRole('button', { name: 'Continue to platform administration' }).click();
  await page.getByRole('heading', { name: 'Overview', level: 1 }).waitFor();
  return secret;
}

async function signIn(page, email, secret) {
  if (!new URL(page.url()).pathname.startsWith('/admin')) await page.goto(`${base}/admin`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(fixtures.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(await code(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  // Signing in again reopens the page the console was on (a deep link), so wait for the workspace, not Overview.
  await page.getByRole('button', { name: 'Sign out' }).first().waitFor();
  await page.getByRole('heading', { name: 'Administration sign in' }).waitFor({ state: 'detached' });
}

/** Confirms the server's step-up request; returns whether the dialog said the last confirmation was too old. */
async function confirmStepUp(page, secret, outcome) {
  const dialog = page.getByRole('dialog');
  await Promise.race([quiet(dialog.waitFor()), quiet(outcome.waitFor())]);
  if (!(await dialog.isVisible())) return { dialog: false };
  const expiredNote = await dialog.getByText('Your last confirmation in this session is more than 5 minutes old.').isVisible();
  await dialog.getByLabel('Authenticator code').fill(await code(secret));
  await dialog.getByRole('button', { name: 'Confirm and continue' }).click();
  await dialog.waitFor({ state: 'detached' });
  await outcome.waitFor();
  return { dialog: true, expiredNote };
}

const currentPlatformSession = async (accountId) => (await db.query(`select id, family_id from auth.sessions
  where account_id = $1 and session_kind = 'platform' and revoked_at is null order by issued_at desc limit 1`, [accountId])).rows[0];

async function ageStepUp(accountId) {
  const session = await currentPlatformSession(accountId);
  const client = await db.connect();
  try {
    await client.query('set session_replication_role = replica');
    // As the runtime verifier does: step_up_at may not precede mfa_verified_at (session_assurance_step_up_check).
    const updated = await client.query(`update auth.session_assurance set mfa_verified_at = mfa_verified_at - interval '6 minutes',
        step_up_at = step_up_at - interval '6 minutes' where family_id = $1 and step_up_at is not null`, [session.family_id]);
    assert.equal(updated.rowCount, 1, 'the session had a step-up to age');
  } finally {
    await client.query('reset session_replication_role');
    client.release();
  }
}

/** Ends the idle window of the account's current platform session (as 15 idle minutes would). */
async function lapseSession(accountId) {
  const session = await currentPlatformSession(accountId);
  // As the runtime verifier does: sessions_check keeps issued_at before both expiries.
  await db.query(`update auth.sessions set issued_at = now() - interval '16 minutes', expires_at = now() - interval '1 minute',
    absolute_expires_at = now() - interval '16 minutes' + interval '8 hours' where id = $1`, [session.id]);
  return session.id;
}

async function changeFacilityStatus(page, secret, value, reason) {
  const status = main(page).locator('details', { has: page.locator('summary', { hasText: 'Change facility status' }) });
  if (!(await status.evaluate((element) => element.open))) await status.locator('summary').click();
  await status.getByLabel('New value').selectOption(value);
  await status.getByLabel('Reason for this change').fill(reason);
  await status.getByRole('button', { name: 'Confirm change' }).click();
  return confirmStepUp(page, secret, status.getByText('Saved. Current information is being refreshed.'));
}

async function revokeAllSessionsAs(page, secret, email, reason) {
  await page.goto(`${base}/admin/principals`);
  await page.getByLabel('Search users').fill(email);
  await main(page).getByRole('button', { name: 'Search' }).click();
  const row = main(page).locator('tbody tr', { hasText: email });
  await row.waitFor();
  const form = row.locator('details', { has: page.locator('summary', { hasText: 'Revoke all sessions' }) });
  await form.locator('summary').click();
  await form.getByLabel('Reason for this change').fill(reason);
  await form.getByRole('button', { name: 'Confirm change' }).click();
  return confirmStepUp(page, secret, form.getByText('Saved. Current information is being refreshed.'));
}

const A = await context('superA');
const B = await context('superB');
let secretA;
let secretB;

await check('1. Platform sign-in: first-time MFA enrolment, sign-out, then password + TOTP sign-in', async () => {
  secretA = await enroll(A.page, fixtures.superA.email);
  secretB = await enroll(B.page, fixtures.superB.email);
  await A.page.getByRole('button', { name: 'Sign out' }).first().click();
  await A.page.getByText('You have signed out of platform administration.').waitFor();
  await signIn(A.page, fixtures.superA.email, secretA);
  const events = (await db.query(`select event_type, outcome from auth.session_events where account_id = $1 order by id`,
    [fixtures.superA.id])).rows.map((row) => `${row.event_type}:${row.outcome}`);
  for (const expected of ['mfa_enrolled:success', 'logout:success', 'mfa_verified:success']) {
    assert(events.includes(expected), `missing session event ${expected} (${events.join(', ')})`);
  }
  return { enrolled: ['superA', 'superB'], signIn: 'password + TOTP', events: [...new Set(events)] };
});

await check('2. STEP_UP_REQUIRED: facility suspension with step-up, shown under platform changes', async () => {
  const page = A.page;
  await page.goto(`${base}/admin/facilities/${fixtures.facilities.ikeja}`);
  await page.getByRole('heading', { name: 'Synthetic Ikeja Clinic', level: 1 }).waitFor();
  const step = await changeFacilityStatus(page, secretA, 'suspended', 'Synthetic suspension: licence inspection pending');
  assert.deepEqual(step, { dialog: true, expiredNote: false }, 'the first high-risk action asks for step-up (STEP_UP_REQUIRED)');
  await main(page).locator('dd').getByText('Suspended', { exact: true }).waitFor();
  const changes = main(page).getByRole('region', { name: 'Platform changes to this facility' });
  await changes.getByText('Synthetic suspension: licence inspection pending').waitFor();
  const row = (await db.query('select lifecycle_status, status_reason from identity.facilities where id = $1', [fixtures.facilities.ikeja])).rows[0];
  assert.equal(row.lifecycle_status, 'suspended');
  const audit = (await db.query(`select action, outcome, reason from audit.events where resource_type = 'facility'
    and resource_uuid = $1 and outcome = 'success' order by sequence_id`, [fixtures.facilities.ikeja])).rows;
  assert(audit.some((event) => event.reason === 'Synthetic suspension: licence inspection pending'), 'the suspension is audited by target');
  return { stepUp: 'STEP_UP_REQUIRED dialog, no expiry note', status: row.lifecycle_status, auditByTarget: audit.length };
});

await check('3. STEP_UP_EXPIRED: facility restoration after the step-up aged past 5 minutes', async () => {
  const page = A.page;
  await ageStepUp(fixtures.superA.id);
  const step = await changeFacilityStatus(page, secretA, 'verified', 'Synthetic restoration: inspection passed');
  assert.deepEqual(step, { dialog: true, expiredNote: true }, 'an aged step-up asks again and says why (STEP_UP_EXPIRED)');
  await main(page).locator('dd').getByText('Verified', { exact: true }).waitFor();
  const changes = main(page).getByRole('region', { name: 'Platform changes to this facility' });
  await changes.getByText('Synthetic restoration: inspection passed').waitFor();
  await changes.getByText('Synthetic suspension: licence inspection pending').waitFor();
  const row = (await db.query('select lifecycle_status from identity.facilities where id = $1', [fixtures.facilities.ikeja])).rows[0];
  assert.equal(row.lifecycle_status, 'verified');
  await page.reload();
  await main(page).getByRole('region', { name: 'Platform changes to this facility' })
    .getByText('Synthetic restoration: inspection passed').waitFor();
  return { stepUp: 'STEP_UP_EXPIRED dialog with the expiry note', status: row.lifecycle_status, history: 'both changes listed, also after reload' };
});

await check('4. Approvals: cursor paging across two pages with no duplicates', async () => {
  const page = A.page;
  await page.goto(`${base}/admin/approvals`);
  await main(page).getByText('Showing 50 requests, newest first; more are available').waitFor();
  const cards = main(page).locator('article');
  assert.equal(await cards.count(), 50);
  assert.match(await cards.first().textContent(), /Synthetic paging request 01/);
  await main(page).getByRole('button', { name: 'Load more requests' }).click();
  await main(page).getByText('Showing 55 requests, newest first').waitFor();
  assert.equal(await cards.count(), 55);
  const reasons = await cards.evaluateAll((items) => items.map((item) => /Synthetic paging request (\d+)/.exec(item.textContent)?.[1]));
  assert.equal(new Set(reasons).size, 55, 'every request appears exactly once');
  assert.deepEqual(reasons, Array.from({ length: 55 }, (_, index) => String(index + 1).padStart(2, '0')), 'newest first');
  assert.equal(await main(page).getByRole('button', { name: 'Load more requests' }).count(), 0);
  return { pages: 2, rows: 55, order: 'newest first', duplicates: 0 };
});

await check('5. Demo requests: cursor paging per filter, restarting on a filter change', async () => {
  const page = A.page;
  await page.goto(`${base}/admin/demos?status=new`);
  await main(page).getByText('Showing 50 requests, newest first; more are available').waitFor();
  await main(page).getByRole('button', { name: 'Load more requests' }).click();
  await main(page).getByText('Showing 55 requests, newest first').waitFor();
  const names = await main(page).locator('tbody tr strong').allTextContents();
  assert.equal(new Set(names).size, 55);
  assert(!names.includes('Synthetic Demo Contacted'), 'the status filter applies to every page');
  await main(page).getByLabel('Status').selectOption('');
  await main(page).getByText('Showing 50 requests, newest first; more are available').waitFor();
  await main(page).getByRole('button', { name: 'Load more requests' }).click();
  await main(page).getByText('Showing 56 requests, newest first').waitFor();
  return { new_filter: { pages: 2, rows: 55 }, any_status: { pages: 2, rows: 56 }, restart_on_filter_change: true };
});

await check('6. MFA reset is offered only for administrators with mfaEnrolled true', async () => {
  const page = A.page;
  await page.goto(`${base}/admin/principals`);
  const lookup = async (email) => {
    await page.getByLabel('Search users').fill(email);
    await main(page).getByRole('button', { name: 'Search' }).click();
    const row = main(page).locator('tbody tr', { hasText: email });
    await row.waitFor();
    return row;
  };
  const enrolled = await lookup(fixtures.superB.email);
  await enrolled.getByText('Enrolled', { exact: true }).waitFor();
  assert.equal(await enrolled.getByText('Request authenticator reset').count(), 1, 'reset offered for an enrolled administrator');
  for (const email of [fixtures.support.email, fixtures.target.email]) {
    const row = await lookup(email);
    await row.getByText('Not set up', { exact: true }).waitFor();
    assert.equal(await row.getByText('Request authenticator reset').count(), 0, `no reset offered for ${email}`);
  }
  const flags = (await db.query(`select account.email, exists (select 1 from auth.mfa_factors factor
    where factor.account_id = account.id and factor.status = 'active') as enrolled from auth.accounts account
    where account.id = any($1::uuid[]) order by account.email`, [[fixtures.superB.id, fixtures.support.id, fixtures.target.id]])).rows;
  return { superB: 'Enrolled + reset offered', support: 'Not set up, no reset', target: 'Not set up, no reset', database: flags };
});

await check('7. Revoked session notice, in session (another Super Admin revokes all sessions)', async () => {
  const step = await revokeAllSessionsAs(B.page, secretB, fixtures.superA.email, 'Synthetic revocation: suspected device loss');
  assert.equal(step.dialog, true, 'revoking sessions asks Super Admin B for step-up');
  await A.page.getByRole('link', { name: 'Audit' }).first().click();
  await A.page.getByText(REVOKED).waitFor();
  await A.page.getByRole('heading', { name: 'Administration sign in' }).waitFor();
  return { notice: 'revoked', trigger: 'next request after revocation' };
});

await check('8. Revoked session notice after a reload', async () => {
  await signIn(A.page, fixtures.superA.email, secretA);
  await revokeAllSessionsAs(B.page, secretB, fixtures.superA.email, 'Synthetic revocation: second device report');
  await A.page.reload();
  await A.page.getByText(REVOKED).waitFor();
  await A.page.getByRole('heading', { name: 'Administration sign in' }).waitFor();
  return { notice: 'revoked', trigger: 'reload' };
});

await check('9. Expired session notice, in session (idle window ended)', async () => {
  await signIn(A.page, fixtures.superA.email, secretA);
  await lapseSession(fixtures.superA.id);
  await A.page.getByRole('link', { name: 'Facilities' }).first().click();
  await A.page.getByText(EXPIRED, { exact: true }).waitFor();
  return { notice: 'expired', trigger: 'next request after the idle window' };
});

await check('10. Expired session notice after a reload', async () => {
  await signIn(A.page, fixtures.superA.email, secretA);
  await lapseSession(fixtures.superA.id);
  await A.page.reload();
  await A.page.getByText(EXPIRED, { exact: true }).waitFor();
  return { notice: 'expired', trigger: 'reload' };
});

await check('11. Stage 5 backend: ended sessions refreshed by the console are denied refreshes, not token reuse', async () => {
  const events = (await db.query(`select event_type, details->>'revocation_reason' as reason, count(*)::int as n
    from auth.session_events where account_id = $1 and event_type in ('refresh', 'reuse_detected')
    group by 1, 2 order by 1, 2`, [fixtures.superA.id])).rows;
  assert(!events.some((event) => event.event_type === 'reuse_detected'), `reuse recorded: ${JSON.stringify(events)}`);
  assert(events.some((event) => event.event_type === 'refresh'), 'the console refreshed an ended session');
  const reused = (await db.query(`select count(*)::int as n from auth.sessions where account_id = $1
    and revocation_reason = 'refresh_token_reuse'`, [fixtures.superA.id])).rows[0].n;
  assert.equal(reused, 0);
  return { denied_refresh_events: events, reuse_detected: 0 };
});

await check('12. No unexpected browser errors', async () => {
  const problems = [...A.problems, ...B.problems];
  assert.deepEqual(problems, []);
  return { page_errors: 0, console_errors: 0 };
});

await browser.close();
await db.end();
const summary = { run: 'admin-console-e2e', backend: process.env.HID_BACKEND_SHA, frontend: process.env.HID_FRONTEND_SHA,
  database: fixtures.database, browser: 'chromium (playwright 1.56.1, headless)', user: process.env.USER ?? process.getuid?.(),
  passed: results.filter((result) => result.status === 'passed').length, failed: results.filter((result) => result.status === 'failed').length,
  results };
writeFileSync(process.env.HID_E2E_EVIDENCE || join(dir, 'evidence.json'), JSON.stringify(summary, null, 2));
for (const result of results) console.log(`${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.name} (${result.ms} ms)${result.status === 'failed' ? `\n  ${result.detail.split('\n')[0]}` : ''}`);
console.log(`${summary.passed} passed, ${summary.failed} failed`);
process.exit(summary.failed ? 1 : 0);
