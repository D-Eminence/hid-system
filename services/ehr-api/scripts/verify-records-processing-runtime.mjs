#!/usr/bin/env node
// Records processing, Stage 1 (0104, owner decisions of 2026-10-31) end to
// end, over HTTP, with Identity, EHR, Lab, Pharmacy and OCR each booted from
// its own source (its own main.ts) in its own process, each connected as its
// exact runtime role, the services calling each other over loopback with
// local-secret workload identity. Only the outbound boundaries are local
// stubs: QoreID (for facility sign-up) and notification-api's OTP and
// staff-invitation routes, on one loopback server; a preload refuses every
// other non-loopback request. All values are synthetic. It runs only against
// the owned disposable synthetic rehearsal or, with
// HID_RECORDS_PROCESSING_RUNTIME_LOCAL_CLUSTER=loopback, a disposable copy of
// a database on a loopback test cluster.
//
// The flow: a hospital, a laboratory and a pharmacy sign up (P4) and support
// reviews them (P4b); the hospital invites a receptionist. The doctor asks the
// patient for records processing (X-Purpose-Of-Use healthcare-operations,
// write_records, 1440 minutes); the pharmacist and the receptionist are
// refused, and so is any request for a patient under 18 or without a date of
// birth. The patient sees the purpose in the app and approves. With the grant
// OCR creates and reads a job on the patient's document and EHR shows it the
// document; a direct-care grant does not; the chart (imported records, an
// imported attachment, the reported health profile, the encounters), Lab and
// Pharmacy refuse the purpose. Since owner decision 34(1) the second patient's
// approval of the doctor's direct-care request, and then that patient's Access
// PIN, each cover OCR for the doctor (not another staff member) until the
// patient revokes the grant or turns the PIN off. The kill switch refuses new
// requests and every grant until it is on again; the patient's revocation
// ends access.
//
// HID_RECORDS_PROCESSING_STAGE proves the release order on the same flow:
// "after-0104" (the default) is this branch on a database with 0104;
// "before-0104" is this branch's services on a database without 0104 (every
// request 400 INVALID_CONSENT_COMMAND, no purpose on the patient's list, OCR
// 404, the fences already on), and stops after those answers; "old-identity"
// is the database with 0104 and an Identity from before 0104, which answers
// both refusals 403 CONSENT_COMMAND_DENIED, lists no purpose and answers the
// care approval's cover as not allowed (OCR 403 ACCESS_DENIED).
// HID_RECORDS_PROCESSING_IDENTITY_DIR boots Identity from that source instead
// of this branch's (required for "old-identity"); with "before-0104" it is
// today's Identity on today's database, as the website meets it.
// Owner SQL is used only for what no route does: the platform administrator's
// and the patients' accounts (as the other runtime verifiers seed them),
// QoreID switched on, the scanned-clean document (uploads need S3 and the
// scanner), the kill switch (an operator's update) and reading what the
// database holds.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ehrService = resolve(import.meta.dirname, '..');
const services = resolve(ehrService, '..');
const require = createRequire(join(ehrService, 'package.json'));
const { Pool, Client } = require('pg');
const argon2 = require(createRequire(join(services, 'identity-api/package.json')).resolve('argon2'));

const socket = process.env.PGHOST;
const rehearsal = Boolean(socket?.startsWith('/tmp/hid-tuf-migration.')) && process.env.PGDATABASE === 'hid_rehearsal';
const loopback = process.env.HID_RECORDS_PROCESSING_RUNTIME_LOCAL_CLUSTER === 'loopback'
  && ['127.0.0.1', '::1', 'localhost'].includes(socket ?? '')
  && /^[a-z][a-z0-9_]{0,40}$/.test(process.env.PGDATABASE ?? '');
assert(process.env.NODE_ENV === 'test' && (rehearsal || loopback),
  'Only the owned synthetic rehearsal or an explicitly named loopback test cluster is supported');
assert(process.env.OTP_HMAC_KEY_B64, 'The rehearsal OTP HMAC key is required');
assert(process.env.AUTH_SIGNING_SECRET && process.env.AUTH_LOGIN_PEPPER, 'Synthetic session keys are required');
const stage = process.env.HID_RECORDS_PROCESSING_STAGE ?? 'after-0104';
assert(['after-0104', 'before-0104', 'old-identity'].includes(stage), `Unknown stage ${stage}`);
const identityDirectory = process.env.HID_RECORDS_PROCESSING_IDENTITY_DIR
  ? resolve(process.env.HID_RECORDS_PROCESSING_IDENTITY_DIR) : join(services, 'identity-api');
assert(stage !== 'old-identity' || process.env.HID_RECORDS_PROCESSING_IDENTITY_DIR, 'The earlier Identity source is required');
const port = Number(process.env.PGPORT ?? 5432);
const pgUser = process.env.PGUSER ?? 'postgres';
const isolated = `${rehearsal ? 'hid_rehearsal' : process.env.PGDATABASE}_records_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const databaseUrl = role => {
  const options = `options=${encodeURIComponent(`-c role=${role}`)}`;
  return rehearsal
    ? `postgresql://${pgUser}@localhost:${port}/${isolated}?host=${encodeURIComponent(socket)}&${options}`
    : `postgresql://${pgUser}@${socket === '::1' ? '[::1]' : socket}:${port}/${isolated}?${options}`;
};

const appOrigin = 'https://app.healthidentitydirectory.com';
const ehrOrigin = 'https://ehr.healthidentitydirectory.com';
const labOrigin = 'https://lab.healthidentitydirectory.com';
const pharmacyOrigin = 'https://pharmacy.healthidentitydirectory.com';
const adminOrigin = 'https://admin.healthidentitydirectory.com';
const CORS = [appOrigin, ehrOrigin, labOrigin, pharmacyOrigin, adminOrigin, 'https://healthidentitydirectory.com'].join(',');
const secret = label => `synthetic-${label}-${randomBytes(16).toString('hex')}`;
const tokens = { identityEhr: secret('identity-ehr'), identityLab: secret('identity-lab'),
  identityPharmacy: secret('identity-pharmacy'), identityOcr: secret('identity-ocr'), lab: secret('lab-workload'),
  pharmacy: secret('pharmacy-workload'), ehr: secret('ehr-workload'), notification: secret('notification-workload') };

const freePort = () => new Promise((done, fail) => {
  const server = createNetServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => { const { port: chosen } = server.address(); server.close(() => done(chosen)); });
});
const steps = [];
const step = name => { steps.push(name); };

// ── Stubs: QoreID and notification-api's routes, on one loopback server ──
const otpCodes = new Map();
const invitationEmails = [];
const companies = new Map();
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const answer = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url, 'http://stub').pathname;
      if (path === '/qoreid/token') {
        answer(200, { accessToken: 'synthetic-qoreid-token', expiresIn: 7200, tokenType: 'Bearer' });
        return;
      }
      if (path === '/qoreid/v2/ng/identities/cac-basic') {
        const { regNumber } = JSON.parse(raw);
        const company = companies.get(regNumber);
        assert(company, `Unexpected CAC lookup ${regNumber}`);
        answer(200, { id: 990000 + companies.size, summary: { cac_check: 'verified' },
          status: { state: 'complete', status: 'verified' },
          cac: { rcNumber: regNumber.replace(/^(RC|BN|IT)/, ''), companyName: company.name,
            companyType: 'Private Company Limited by Shares', registrationDate: '01-Jan-21',
            headOfficeAddress: company.address, status: 'Active' } });
        return;
      }
      assert.equal(req.headers['x-hid-internal-caller'], 'identity-api');
      assert.equal(req.headers['x-hid-service-token'], tokens.notification);
      const body = JSON.parse(raw);
      if (path === '/api/v1/notifications/otp') {
        otpCodes.set(String(req.headers['idempotency-key']).replace(/^otp:/, ''), body.code);
        answer(202, { requestId: randomUUID(), outcome: 'accepted', primary: { provider: 'ses', outcome: 'accepted' } });
        return;
      }
      if (path === '/api/v1/notifications/staff-invitation') {
        invitationEmails.push(body);
        answer(202, { requestId: randomUUID(), outcome: 'accepted', primary: { provider: 'ses', outcome: 'accepted' } });
        return;
      }
      answer(404, { code: 'NOT_FOUND' });
    } catch (error) {
      answer(500, { code: 'VERIFIER_STUB_REFUSED', detail: String(error?.message ?? error) });
    }
  });
});

// Every service process loads this first: QoreID calls go to the loopback
// stub, and any other request off this machine fails.
const preloadSource = `'use strict';
const realFetch = globalThis.fetch;
const stub = process.env.HID_VERIFIER_STUB_URL;
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.qoreid.com/')) return realFetch(stub + '/qoreid' + url.slice('https://api.qoreid.com'.length), init);
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    return Promise.reject(new Error('runtime verifier: outbound request refused to ' + new URL(url).origin));
  }
  return realFetch(input, init);
};
`;

const children = [];
const childLogs = new Map();
async function boot(name, directory, environment, listenPort) {
  const child = spawn(process.execPath,
    ['-r', join(directory, 'node_modules/ts-node/register/transpile-only'), '-r', environment.HID_VERIFIER_PRELOAD,
      join(directory, 'src/main.ts')],
    { cwd: directory, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test', PORT: String(listenPort),
      TS_NODE_PROJECT: join(directory, 'tsconfig.json'), DATABASE_SSL: 'false', DATABASE_POOL_MAX: '4', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const log = [];
  childLogs.set(name, log);
  const keep = chunk => { log.push(String(chunk)); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  const base = `http://127.0.0.1:${listenPort}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${name} exited during boot: ${log.join('').slice(-3000)}`);
    try {
      const response = await fetch(`${base}/api/v1/health/live`);
      if (response.status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`${name} did not start: ${log.join('').slice(-3000)}`);
    await new Promise(done => setTimeout(done, 250));
  }
  return base;
}

// ── HTTP ──
const parseCookies = response => (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]);
async function http(base, method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  if (options.csrf) headers['x-csrf-token'] = options.csrf;
  if (options.facility) headers['x-facility-id'] = options.facility;
  if (options.purpose) headers['x-purpose-of-use'] = options.purpose;
  if (options.key) headers['idempotency-key'] = options.key;
  if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
  if (options.forwardedFor) headers['x-forwarded-for'] = options.forwardedFor;
  let body;
  if (options.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.body); }
  const response = await fetch(`${base}/api/v1${path}`, { method, headers, body, redirect: 'manual' });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers, cookies: parseCookies(response) };
}
const expectStatus = (response, status, label) => {
  assert.equal(response.status, status, `${label}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
};
const expectProblem = (response, status, code, label = code) => {
  assert.equal(response.status, status, `${label}: ${response.status} ${JSON.stringify(response.body)}`);
  if (code) assert.equal(response.body?.code, code, `${label}: ${JSON.stringify(response.body)}`);
  return `${response.status} ${response.body?.code ?? ''}`.trim();
};

const maintenance = new Pool({ host: socket, port, user: pgUser, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
const owner = new Pool({ host: socket, port, user: pgUser, database: isolated, max: 3 });
const one = async (sql, values = []) => (await owner.query(sql, values)).rows[0];
const temporary = await mkdtemp(join(tmpdir(), 'hid-records-processing-'));
const evidence = { stage, steps };
const startedAt = Date.now();
let failure;
try {
  const code = await one(`select active from identity.purpose_of_use_codes where code = 'healthcare-operations'`);
  const listColumns = (await one(`select count(*)::int as n from pg_proc proc, unnest(proc.proargmodes) mode
    where proc.oid = 'identity.list_my_access_requests()'::regprocedure and mode = 't'`)).n;
  if (stage === 'before-0104') assert.deepEqual([code, listColumns], [undefined, 11], 'a database without 0104');
  else assert.deepEqual([code?.active, listColumns], [true, 12], 'a database with 0104');
  evidence.database = { recordsProcessingCode: code ? (code.active ? 'active' : 'inactive') : 'absent', listColumns };
  await new Promise(done => stub.listen(0, '127.0.0.1', done));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const preload = join(temporary, 'loopback-only.cjs');
  await writeFile(preload, preloadSource);
  // Fixture: the platform has enabled QoreID CAC verification (an admin action).
  await owner.query("update platform.integration_providers set enabled=true, row_version=row_version+1 where provider='qoreid'");

  const runtimeRoles = {};
  for (const role of ['hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime',
    'hid_ocr_api_runtime']) {
    const client = new Client({ connectionString: databaseUrl(role) });
    await client.connect();
    runtimeRoles[role] = (await client.query('select current_user as role')).rows[0].role;
    await client.end();
    assert.equal(runtimeRoles[role], role);
  }
  evidence.runtimeRoles = Object.keys(runtimeRoles);

  const [identityPort, ehrPort, labPort, pharmacyPort, ocrPort] = await Promise.all([1, 2, 3, 4, 5].map(() => freePort()));
  const common = { HID_VERIFIER_PRELOAD: preload, HID_VERIFIER_STUB_URL: stubUrl, CORS_ORIGINS: CORS,
    TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128' };
  const local = value => `http://127.0.0.1:${value}`;
  const [identity, ehr, lab, pharmacy, ocr] = await Promise.all([
    boot('identity-api', identityDirectory, { ...common, DATABASE_URL: databaseUrl('hid_identity_api_runtime'),
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET, AUTH_LOGIN_PEPPER: process.env.AUTH_LOGIN_PEPPER,
      OTP_HMAC_KEY_B64: process.env.OTP_HMAC_KEY_B64, AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'production',
      NIN_PROVIDER_MODE: 'unavailable', TURNSTILE_MODE: 'disabled', QOREID_ENABLED: 'true',
      QOREID_CLIENT_ID: 'example-qoreid-client', QOREID_CLIENT_SECRET: 'example-qoreid-secret',
      IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: tokens.identityEhr,
      IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: tokens.identityLab, IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.identityPharmacy,
      IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: tokens.identityOcr,
      NOTIFICATION_API_URL: stubUrl, NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret',
      NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: tokens.notification, PATIENT_LIFECYCLE_SWEEP_SECONDS: '0' }, identityPort),
    boot('ehr-api', join(services, 'ehr-api'), { ...common, DATABASE_URL: databaseUrl('hid_ehr_api_runtime'),
      STORAGE_MODE: 'disabled', IDENTITY_API_URL: local(identityPort), IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: tokens.identityEhr,
      LAB_API_URL: local(labPort), LAB_INTERNAL_SERVICE_TOKEN: tokens.lab, PHARMACY_API_URL: local(pharmacyPort),
      PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy, EHR_INTERNAL_SERVICE_TOKEN: tokens.ehr }, ehrPort),
    boot('lab-api', join(services, 'lab-api'), { ...common, DATABASE_URL: databaseUrl('hid_lab_api_runtime'),
      IDENTITY_API_URL: local(identityPort), IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: tokens.identityLab,
      LAB_INTERNAL_SERVICE_TOKEN: tokens.lab }, labPort),
    boot('pharmacy-api', join(services, 'pharmacy-api'), { ...common, DATABASE_URL: databaseUrl('hid_pharmacy_api_runtime'),
      IDENTITY_API_URL: local(identityPort), IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.identityPharmacy,
      PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy }, pharmacyPort),
    boot('ocr-api', join(services, 'ocr-api'), { ...common, DATABASE_URL: databaseUrl('hid_ocr_api_runtime'),
      IDENTITY_API_URL: local(identityPort), IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: tokens.identityOcr,
      EHR_API_URL: local(ehrPort), EHR_INTERNAL_SERVICE_TOKEN: tokens.ehr, LAB_API_URL: local(labPort),
      LAB_INTERNAL_SERVICE_TOKEN: tokens.lab, PHARMACY_API_URL: local(pharmacyPort),
      PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy }, ocrPort),
  ]);
  step(`five services booted from their own code${process.env.HID_RECORDS_PROCESSING_IDENTITY_DIR
    ? ' (Identity from another source)' : ''}`);

  // ── Support, the facilities (P4 sign-up, P4b review) and a receptionist (P4b invitation) ──
  const password = 'Synthetic-Records-Processing-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const synthetic = label => `records-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const signInStaff = async (email, host, facilityId) => {
    const response = await http(identity, 'POST', '/auth/login', { origin: host.origin,
      body: { email, password, turnstileAction: host.action } });
    expectStatus(response, 200, `sign-in ${email}`);
    return { email, origin: host.origin, facilityId, accountId: response.body.actor.accountId,
      csrf: response.headers.get('x-csrf-token'), cookie: response.cookies.join('; ') };
  };
  const HOSTS = { ehr: { origin: ehrOrigin, action: 'staff-login' }, lab: { origin: labOrigin, action: 'lab-login' },
    pharmacy: { origin: pharmacyOrigin, action: 'pharmacy-login' }, admin: { origin: adminOrigin, action: 'admin-login' } };
  const supportAccount = randomUUID();
  const supportEmail = synthetic('support');
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
    values ($1, $2, $3, 'Synthetic Support', $4, 'argon2id', 'active')`,
  [supportAccount, `synthetic:platform-admin:${supportAccount}`, supportEmail, passwordHash]);
  await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values ($1, $2, 'platform_super_admin', 'platform', 'Synthetic platform administrator for the records-processing verifier')`,
  [randomUUID(), supportAccount]);
  const support = await signInStaff(supportEmail, HOSTS.admin, undefined);
  const adminCall = (method, path, body, extra = {}) => http(identity, method, path, { cookie: support.cookie,
    ...(method === 'GET' ? {} : { origin: adminOrigin, csrf: support.csrf }), body, ...extra });
  const setControl = async (controlKey, enabled) => {
    const list = expectStatus(await adminCall('GET', '/admin/controls'), 200, 'controls');
    const control = list.find(item => item.controlKey === controlKey);
    assert(control, `control ${controlKey} missing`);
    if (control.enabled === enabled) return;
    expectStatus(await adminCall('POST', '/admin/controls', { controlKey, enabled,
      reason: `Records-processing verifier: ${controlKey} ${enabled ? 'on' : 'off'}` }, { ifMatch: control.version }), 201,
    `control ${controlKey}`);
  };
  await setControl('provider_self_service_enabled', true);
  await setControl('staff_invitations_enabled', true);

  let signUps = 0;
  const signUp = async ({ label, organizationType, productCode, administratorName }) => {
    signUps += 1;
    const cac = `RC99100${String(77000 + signUps)}`;
    companies.set(cac, { name: `Verifier ${label} ${cac} Ltd`, address: `${signUps} Synthetic Records Road, Ikeja, Lagos` });
    const email = synthetic(`admin-${signUps}`);
    const started = await http(identity, 'POST', '/identity/provider-enrollments', { origin: appOrigin,
      forwardedFor: `198.51.160.${signUps}`, body: { cacRegistrationNumber: cac, administratorEmail: email, organizationType,
        productCode, administratorName, turnstileAction: 'provider-enrollment', turnstileToken: 'disabled-in-this-run' } });
    expectStatus(started, 200, `sign-up start ${label}`);
    const deadline = Date.now() + 15_000;
    while (!otpCodes.has(started.body.challengeId)) {
      assert(Date.now() < deadline, `no code for ${label}`);
      await new Promise(done => setTimeout(done, 100));
    }
    const verified = await http(identity, 'POST', '/identity/provider-enrollments/verify', { origin: appOrigin,
      body: { challengeId: started.body.challengeId, code: otpCodes.get(started.body.challengeId) } });
    expectStatus(verified, 200, `sign-up verify ${label}`);
    const activated = await http(identity, 'POST', '/identity/provider-enrollments/activate', { origin: appOrigin,
      cookie: verified.cookies.find(value => value.startsWith('hid_provider_enrollment=')), body: { password } });
    expectStatus(activated, 200, `sign-up activation ${label}`);
    const facility = await one(`select facility.name, application.id as application_id
      from identity.facilities facility join identity.organization_applications application
        on application.organization_id = facility.organization_id where facility.id=$1`, [activated.body.facilityId]);
    return { label, email, name: facility.name, facilityId: activated.body.facilityId, applicationId: facility.application_id };
  };
  const review = async (target, grantedRole, licence) => {
    const listed = expectStatus(await adminCall('GET', '/admin/self-service-facilities?state=all'), 200, 'support list');
    const item = listed.items.find(entry => entry.applicationId === target.applicationId);
    assert(item, `${target.label} is not in support's list`);
    expectStatus(await adminCall('POST', `/admin/self-service-facilities/${target.applicationId}/review`,
      { note: 'Checked the administrator against the company record and the register', grantedRole,
        verificationMethod: 'regulator_register', administratorLicence: licence }, { ifMatch: item.version }), 200,
    `review ${target.label}`);
  };
  const hospital = await signUp({ label: 'Hospital', organizationType: 'hospital', productCode: 'ehr',
    administratorName: 'Adaeze Okafor' });
  const laboratory = await signUp({ label: 'Laboratory', organizationType: 'laboratory', productCode: 'laboratory',
    administratorName: 'Bello Musa' });
  const pharmacyFacility = await signUp({ label: 'Pharmacy', organizationType: 'pharmacy', productCode: 'pharmacy',
    administratorName: 'Chioma Eze' });
  await review(hospital, 'doctor', { body: 'MDCN', number: 'MDCN/71011' });
  await review(laboratory, 'lab', { body: 'MLSCN', number: 'MLSCN/71022' });
  await review(pharmacyFacility, 'pharmacist', { body: 'PCN', number: 'PCN/71033' });
  const doctor = await signInStaff(hospital.email, HOSTS.ehr, hospital.facilityId);
  const labStaff = await signInStaff(laboratory.email, HOSTS.lab, laboratory.facilityId);
  const pharmacist = await signInStaff(pharmacyFacility.email, HOSTS.pharmacy, pharmacyFacility.facilityId);
  const call = (base, who, method, path, body, extra = {}) => http(base, method, path, { cookie: who.cookie,
    facility: who.facilityId, purpose: 'direct-care', ...(method === 'GET' ? {} : { origin: who.origin, csrf: who.csrf }),
    body, ...extra });
  const freshKey = label => `verifier-${label}-${randomUUID()}`;
  const invitedEmail = synthetic('receptionist');
  expectStatus(await call(identity, doctor, 'POST', '/identity/staff-invitations', { name: 'Dupe Receptionist',
    email: invitedEmail, role: 'receptionist', attested: true, currentPassword: password }, { key: freshKey('invite') }), 201,
  'invite the receptionist');
  const invitation = invitationEmails.at(-1);
  const openInvitation = forwardedFor => http(identity, 'POST', '/identity/staff-invitations/open', { origin: appOrigin,
    forwardedFor, body: { invitationId: invitation.invitationId, token: invitation.token, turnstileAction: 'staff-invitation' } });
  expectStatus(await openInvitation('198.51.161.1'), 200, 'open invitation');
  const opened = await openInvitation('198.51.161.2');
  expectStatus(await http(identity, 'POST', '/identity/staff-invitations/accept', { origin: appOrigin,
    cookie: opened.cookies.find(value => value.startsWith('hid_staff_invitation=')), body: { password } }), 200,
  'accept invitation');
  const receptionist = await signInStaff(invitedEmail, HOSTS.ehr, hospital.facilityId);
  step('a hospital (doctor), a laboratory (lab) and a pharmacy (pharmacist) signed up and reviewed; a receptionist invited');

  // ── Patients: an adult with an app account; one aged 17; one with no date of birth ──
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const healthIdOf = () => `HID-${Array.from(randomBytes(10), byte => alphabet[byte % alphabet.length]).join('')}`;
  const lagosToday = (await one(`select (clock_timestamp() at time zone 'Africa/Lagos')::date::text as day`)).day;
  const yearsAgo = years => `${Number(lagosToday.slice(0, 4)) - years}${lagosToday.slice(4)}`.replace(/-02-29$/, '-02-28');
  const addPatient = async (label, dob, withAccount) => {
    const patient = { id: randomUUID(), hid: healthIdOf(), email: synthetic(`patient-${label}`), account: randomUUID(), dob };
    if (withAccount) {
      await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
        values ($1, $2, $3, $4, $5, 'argon2id', 'active')`,
      [patient.account, `synthetic:patient:${patient.account}`, patient.email, `Records ${label}`, passwordHash]);
    }
    await owner.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob,
        status) values ($1, $2, $3, 'Records', $4, $5, 'female', $6, 'active')`,
    [patient.id, withAccount ? patient.account : null, patient.hid, label, `Records ${label}`, dob]);
    return patient;
  };
  const patient = await addPatient('Adult', yearsAgo(40), true);
  const carePatient = await addPatient('Care', yearsAgo(52), true);
  const minor = await addPatient('Minor', yearsAgo(17), false);
  const undated = await addPatient('Undated', null, false);
  const patientSession = async who => {
    const loggedIn = await http(identity, 'POST', '/auth/patient/login', { origin: appOrigin,
      body: { email: who.email, password, turnstileAction: 'patient-login' } });
    expectStatus(loggedIn, 200, 'patient sign-in');
    const session = { cookie: loggedIn.cookies.join('; '), csrf: loggedIn.headers.get('x-csrf-token') };
    return (method, path, body) => http(identity, method, path, { cookie: session.cookie,
      ...(method === 'GET' ? {} : { origin: appOrigin, csrf: session.csrf }), body });
  };
  const patientCall = await patientSession(patient);
  const careCall = await patientSession(carePatient);

  // ── The request ──
  const RECORDS = 'healthcare-operations';
  const reason = `Turn paper records into the digital record at ${hospital.name} (OCR)`;
  const ask = (who, target, extra = {}) => call(identity, who, 'POST', '/identity/access-requests',
    { hid: target.hid, scope: 'write_records', reason, durationMinutes: 1440, ...extra }, { purpose: RECORDS });
  const refusals = {};
  if (stage === 'before-0104') {
    for (const [label, who, target] of [['doctor', doctor, patient], ['lab', labStaff, patient], ['pharmacist', pharmacist, patient],
      ['receptionist', receptionist, patient], ['minor', doctor, minor], ['undated', doctor, undated]]) {
      refusals[label] = expectProblem(await ask(who, target), 400, 'INVALID_CONSENT_COMMAND', `before 0104: ${label}`);
    }
  } else {
    const denied = stage === 'old-identity' ? [403, 'CONSENT_COMMAND_DENIED'] : [403, 'RECORDS_PROCESSING_NOT_ALLOWED'];
    const minorRefusal = stage === 'old-identity' ? [403, 'CONSENT_COMMAND_DENIED'] : [422, 'RECORDS_PROCESSING_MINOR'];
    refusals.pharmacist = expectProblem(await ask(pharmacist, patient), ...denied, 'pharmacist');
    refusals.receptionist = expectProblem(await ask(receptionist, patient), ...denied, 'receptionist');
    refusals.minor = expectProblem(await ask(doctor, minor), ...minorRefusal, 'minor');
    refusals.undated = expectProblem(await ask(doctor, undated), ...minorRefusal, 'no date of birth');
    refusals.pharmacistForMinor = expectProblem(await ask(pharmacist, minor), ...denied, 'pharmacist asking for a minor');
    refusals.longer = expectProblem(await ask(doctor, patient, { durationMinutes: 1441 }), 400, null, 'more than 1440 minutes');
    const rows = await one(`select count(*)::int as n from identity.access_requests where purpose_of_use = $1
      and patient_id = any($2::uuid[])`, [RECORDS, [minor.id, undated.id]]);
    assert.equal(rows.n, 0, 'a refused request was written');
  }
  evidence.refusals = refusals;

  const statusOf = async (who, target, purpose) => expectStatus(await call(identity, who, 'POST', '/identity/consent-status',
    { patientId: target.id, purpose }, { purpose }), 201, `consent status ${purpose}`);
  const listed = async (call_) => expectStatus(await call_('GET', '/identity/me/access-requests'), 200, 'my access requests');

  // ── OCR and EHR before any grant ──
  const membershipOf = async who => (await one(`select id from identity.staff_facility_memberships
    where account_id = $1 and facility_id = $2`, [who.accountId, who.facilityId])).id;
  const addDocument = async (target, who) => {
    const id = randomUUID();
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(`insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id,
          original_file_name, storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex,
          status, retention_class)
        values ($1, $2, $3, $4, $5, 'paper-record.pdf', 'synthetic-bucket', $6, 'records-v1', 'application/pdf', 2048,
          repeat('b', 64), 'uploaded', 'clinical_record')`,
      [id, target.id, who.facilityId, who.accountId, await membershipOf(who), `synthetic/${id}.pdf`]);
      await client.query(`insert into ehr.document_scan_events (document_id, patient_id, facility_id, created_by, event_type,
          detected_media_type, scanner_engine, scanner_version, idempotency_key, correlation_id, object_version_id,
          object_sha256_hex)
        values ($1, $2, $3, $4, 'clean', 'application/pdf', 'synthetic-scanner', '1.0', $5, 'records-verifier-scan',
          'records-v1', repeat('b', 64))`, [id, target.id, who.facilityId, who.accountId, `records-scan-${id}`]);
      await client.query('commit');
    } finally { client.release(); }
    return id;
  };
  const document = await addDocument(patient, doctor);
  const careDocument = await addDocument(carePatient, doctor);
  const createJob = (who, documentId) => call(ocr, who, 'POST', '/ocr/jobs',
    { documentId, provider: 'synthetic-provider', purpose: RECORDS }, { purpose: RECORDS, key: freshKey('ocr-job') });
  const download = (who, documentId, purpose) => call(ehr, who, 'GET', `/ehr/documents/${documentId}/download`, undefined,
    { purpose });
  const noGrant = {
    ocrCreate: expectProblem(await createJob(doctor, document), 404, null, 'OCR create without a grant'),
    documentDownload: expectProblem(await download(doctor, document, RECORDS), 404, null, 'EHR document without a grant'),
    consentStatus: await statusOf(doctor, patient, RECORDS),
  };
  assert.deepEqual([noGrant.consentStatus.readAllowed, noGrant.consentStatus.writeAllowed], [false, false]);
  evidence.withoutGrant = { ocrCreate: noGrant.ocrCreate, documentDownload: noGrant.documentDownload, consentStatus: 'none' };

  // ── The fence does not depend on 0104 ──
  const chart = (who, path, purpose) => call(ehr, who, 'GET', `/ehr/patients/${patient.id}${path}`, undefined, { purpose });
  const fence = async () => ({
    importedRecords: expectProblem(await chart(doctor, '/imported-records', RECORDS), 400, 'PURPOSE_OF_USE_REQUIRED', 'imported records'),
    importedAttachment: expectProblem(await chart(doctor, `/imported-attachments/${randomUUID()}/download`, RECORDS), 400,
      'PURPOSE_OF_USE_REQUIRED', 'imported attachment'),
    reportedHealthProfile: expectProblem(await chart(doctor, '/reported-health-profile', RECORDS), 400,
      'PURPOSE_OF_USE_REQUIRED', 'reported health profile'),
    encounters: expectProblem(await chart(doctor, '/encounters', RECORDS), 400, 'PURPOSE_OF_USE_REQUIRED', 'encounters'),
    // Since 0113 the internal OCR note import takes records processing, but only as a draft in the imported paper
    // records: naming a visit is refused before anything is read or written (INTERFACE_CONTRACT section 42).
    ocrNoteImport: await (async () => {
      const publicationId = randomUUID();
      return expectProblem(await http(ehr, 'POST', `/ehr/internal/ocr/patients/${patient.id}/clinical-notes`, {
        cookie: doctor.cookie, origin: doctor.origin, csrf: doctor.csrf, facility: doctor.facilityId, purpose: RECORDS,
        key: `ocr-publication:${publicationId}`, headers: { 'x-hid-internal-caller': 'ocr-api', 'x-hid-service-token': tokens.ehr },
        body: { encounterId: randomUUID(), noteType: 'imported', title: 'Synthetic imported note', content: 'Synthetic content',
          publicationId, documentId: document, ocrJobId: randomUUID(), extractionId: randomUUID(), validationId: randomUUID(),
          validationVersion: 1, reviewedBy: 'Synthetic reviewer' } }), 400, 'OCR_DRAFT_ENCOUNTER_NOT_CHOSEN',
        'OCR note import into a chosen visit');
    })(),
    labWorkItems: expectProblem(await call(lab, labStaff, 'GET', '/lab/work-items', undefined, { purpose: RECORDS }), 400,
      'PURPOSE_OF_USE_REQUIRED', 'lab work items'),
    pharmacyWorkItems: expectProblem(await call(pharmacy, pharmacist, 'GET', '/pharmacy/work-items', undefined,
      { purpose: RECORDS }), 400, 'PURPOSE_OF_USE_REQUIRED', 'pharmacy work items'),
  });
  if (stage === 'before-0104') {
    evidence.fence = await fence();
    // A care request still lists, without a purpose.
    const careAsked = expectStatus(await call(identity, doctor, 'POST', '/identity/access-requests',
      { hid: patient.hid, scope: 'read_records', reason: 'Synthetic consultation for the verifier', durationMinutes: 60 }),
    201, 'a direct-care request');
    const list = await listed(patientCall);
    assert(list.some(item => item.accessRequestId === careAsked.accessRequestId), 'the care request in the app');
    assert(list.every(item => !('purpose' in item)), 'no purpose on a database without 0104');
    evidence.patientList = 'the care request, no purpose field';
    // The website's check for a waiting request: the staff list read under the purpose answers, with purposeOfUse.
    const staffList = expectStatus(await call(identity, doctor, 'GET', '/identity/access-requests?status=pending', undefined,
      { purpose: RECORDS }), 200, 'staff pending list');
    assert(staffList.some(item => item.accessRequestId === careAsked.accessRequestId && item.purposeOfUse === 'direct-care'));
    evidence.staffList = 'read under healthcare-operations, purposeOfUse on each request';
    step('before 0104: every records-processing request 400 INVALID_CONSENT_COMMAND, OCR 404, the fences on');
  } else {
    // ── The doctor asks; the patient sees the purpose and approves ──
    const asked = expectStatus(await ask(doctor, patient), 201, 'the doctor asks');
    assert.equal(asked.purpose ?? asked.purposeOfUse, RECORDS, JSON.stringify(asked));
    const replay = expectStatus(await ask(doctor, patient), 201, 'asked again');
    assert.equal(replay.accessRequestId, asked.accessRequestId);
    const pending = (await listed(patientCall)).find(item => item.accessRequestId === asked.accessRequestId);
    assert(pending, 'the request in the app');
    if (stage === 'old-identity') assert(!('purpose' in pending), 'an earlier Identity names no purpose');
    else assert.equal(pending.purpose, RECORDS, JSON.stringify(pending));
    // The inbox item the website titles by its purpose (0037's metadata).
    const inbox = expectStatus(await patientCall('GET', '/identity/me/notifications'), 200, 'the patient\'s inbox');
    const inboxItems = Array.isArray(inbox) ? inbox : inbox.items;
    assert(inboxItems.some(item => item.notificationCode === 'ACCESS_REQUEST_RECEIVED'
      && item.metadata?.purposeOfUse === RECORDS), `no records-processing inbox item: ${JSON.stringify(inboxItems)}`);
    const staffPending = expectStatus(await call(identity, doctor, 'GET', '/identity/access-requests?status=pending',
      undefined, { purpose: RECORDS }), 200, 'staff pending list');
    assert(staffPending.some(item => item.accessRequestId === asked.accessRequestId && item.purposeOfUse === RECORDS));
    const approved = expectStatus(await patientCall('POST', `/identity/access-requests/${asked.accessRequestId}/approve`), 200,
      'the patient approves');
    const grant = await one(`select purpose_of_use, scope, granted_by_patient_id, membership_id,
        round(extract(epoch from expires_at - starts_at) / 60)::int as minutes
      from identity.consent_grants where id = $1`, [approved.consentGrantId]);
    assert.deepEqual(grant, { purpose_of_use: RECORDS, scope: 'write_records', granted_by_patient_id: patient.id,
      membership_id: await membershipOf(doctor), minutes: 1440 });
    const history = expectStatus(await patientCall('GET', '/identity/me/access-history'), 200, 'access history').items
      .find(item => item.consentGrantId === approved.consentGrantId);
    assert.deepEqual([history.purpose, history.patientRevocable], [RECORDS, true]);
    evidence.request = { asked: 201, replay: 'the same pending request', patientList: stage === 'old-identity' ? 'no purpose'
      : `purpose ${RECORDS}`, inbox: `ACCESS_REQUEST_RECEIVED, metadata.purposeOfUse ${RECORDS}`, staffList: 'purposeOfUse', approval: 200, grant: { ...grant, granted_by_patient_id: 'the patient',
      membership_id: 'the doctor' }, history: { purpose: history.purpose, revocable: true } };
    step('the doctor asked for records processing and the patient approved it in the app');

    // ── With the grant: OCR and the document; never the chart, Lab or Pharmacy ──
    const active = await statusOf(doctor, patient, RECORDS);
    assert.deepEqual([active.readAllowed, active.writeAllowed], [true, true]);
    const care = await statusOf(doctor, patient, 'direct-care');
    assert.deepEqual([care.readAllowed, care.writeAllowed], [false, false], 'records processing is not care');
    const job = expectStatus(await createJob(doctor, document), 201, 'OCR create with the grant');
    const readJob = (who = doctor) => call(ocr, who, 'GET', `/ocr/jobs/${job.id}`, undefined, { purpose: RECORDS });
    expectStatus(await readJob(), 200, 'OCR job read');
    const downloadAnswer = expectProblem(await download(doctor, document, RECORDS), 503, null, 'EHR document with the grant');
    const chartFence = await fence();
    evidence.withGrant = { consentStatus: { recordsProcessing: 'read and write', directCare: 'none' },
      ocrCreate: 201, ocrRead: 200, documentDownload: `${downloadAnswer} (past the read and the authorization; storage is off here)`,
      fence: chartFence };
    step('with the grant OCR created and read the job and EHR passed the document; the chart, Lab and Pharmacy refused it');

    // ── Decision 34(1): the patient's approval of a direct-care request, or the Access PIN, also covers
    // records processing for that staff member at that facility; since 0108 (D-a) for as long as the grant
    // lasts, so the cover ends at the grant's expires_at; the patient ends it by revoking the grant or
    // turning the PIN off ──
    const careAsked = expectStatus(await call(identity, doctor, 'POST', '/identity/access-requests',
      { hid: carePatient.hid, scope: 'read_records', reason: 'Synthetic consultation for the verifier', durationMinutes: 60 }),
    201, 'a direct-care request');
    const careApproved = expectStatus(await careCall('POST', `/identity/access-requests/${careAsked.accessRequestId}/approve`),
      200, 'care approval');
    assert.equal((await listed(careCall)).find(item => item.accessRequestId === careAsked.accessRequestId).purpose,
      stage === 'old-identity' ? undefined : 'direct-care');
    const coverEnd = async grantId => (await one(`select expires_at as until
      from identity.consent_grants where id = $1`, [grantId])).until.toISOString();
    if (stage === 'old-identity') {
      // An Identity from before 0104 looks for a records-processing grant of its own, so it answers the cover as not
      // allowed: the database already shows OCR the document, and OCR refuses on Identity's answer (fail closed).
      evidence.careGrant = { ocrCreate: expectProblem(await createJob(doctor, careDocument), 403, 'ACCESS_DENIED',
        'OCR with a care grant, an earlier Identity'),
        consentStatus: (await statusOf(doctor, carePatient, RECORDS)).readAllowed ? 'allowed' : 'none' };
      assert.equal(evidence.careGrant.consentStatus, 'none');
    } else {
      const covered = await statusOf(doctor, carePatient, RECORDS);
      assert.deepEqual([covered.readAllowed, covered.writeAllowed, covered.expiresAt],
        [true, true, await coverEnd(careApproved.consentGrantId)], `the care approval covers records processing: ${JSON.stringify(covered)}`);
      const careCare = await statusOf(doctor, carePatient, 'direct-care');
      assert.deepEqual([careCare.readAllowed, careCare.writeAllowed], [true, false], 'direct care stays read only');
      const careJob = expectStatus(await createJob(doctor, careDocument), 201, 'OCR create under the care approval');
      const readCareJob = () => call(ocr, doctor, 'GET', `/ocr/jobs/${careJob.id}`, undefined, { purpose: RECORDS });
      expectStatus(await readCareJob(), 200, 'OCR read under the care approval');
      const otherStaff = await statusOf(labStaff, carePatient, RECORDS);
      assert.deepEqual([otherStaff.readAllowed, otherStaff.writeAllowed], [false, false], 'another staff member is not covered');
      // Identity's check is recorded as today: success, this purpose, naming the grant that covered it.
      const named = await one(`select count(*)::int as n from audit.events where action = 'identity.authorization.check'
        and outcome = 'success' and purpose_of_use = $1 and details->>'consentGrantId' = $2`,
      [RECORDS, careApproved.consentGrantId]);
      assert(named.n > 0, 'no authorization audit row names the covering care grant');
      expectStatus(await careCall('POST', `/identity/me/consent-grants/${careApproved.consentGrantId}/revoke`,
        { reason: 'Not my paper records today' }), 200, 'revoke the care grant');
      const afterRevoke = { ocrRead: expectProblem(await readCareJob(), 404, 'OCR_JOB_NOT_FOUND', 'OCR read after the care revocation'),
        ocrCreate: expectProblem(await createJob(doctor, careDocument), 404, null, 'OCR create after the care revocation'),
        consentStatus: (await statusOf(doctor, carePatient, RECORDS)).readAllowed ? 'allowed' : 'none' };
      assert.equal(afterRevoke.consentStatus, 'none');
      // The Access PIN: the patient sets one, the doctor opens the record with it (direct care, read only).
      expectStatus(await careCall('POST', '/identity/me/access-pin', { pin: '246813' }), 200, 'the patient sets an Access PIN');
      const pinned = expectStatus(await call(identity, doctor, 'POST', '/identity/standard-access/pin',
        { hid: carePatient.hid, pin: '246813', durationMinutes: 30 }, { purpose: 'direct-care' }), 200, 'the doctor uses the PIN');
      const pinCovered = await statusOf(doctor, carePatient, RECORDS);
      assert.deepEqual([pinCovered.readAllowed, pinCovered.writeAllowed, pinCovered.expiresAt],
        [true, true, await coverEnd(pinned.consentGrantId)], `the PIN covers records processing: ${JSON.stringify(pinCovered)}`);
      const pinJob = expectStatus(await createJob(doctor, careDocument), 201, 'OCR create under the PIN');
      const readPinJob = () => call(ocr, doctor, 'GET', `/ocr/jobs/${pinJob.id}`, undefined, { purpose: RECORDS });
      expectStatus(await readPinJob(), 200, 'OCR read under the PIN');
      expectStatus(await careCall('DELETE', '/identity/me/access-pin'), 200, 'the patient turns the PIN off');
      const afterPinOff = { ocrRead: expectProblem(await readPinJob(), 404, 'OCR_JOB_NOT_FOUND', 'OCR read after the PIN is off'),
        consentStatus: (await statusOf(doctor, carePatient, RECORDS)).readAllowed ? 'allowed' : 'none' };
      assert.equal(afterPinOff.consentStatus, 'none');
      evidence.careGrant = { consentStatus: { recordsProcessing: 'read and write until the cover ends', directCare: 'read' },
        ocrCreate: 201, ocrRead: 200, otherStaff: 'none', audit: 'the authorization check names the care grant',
        afterRevoke, pin: { ocrCreate: 201, ocrRead: 200, afterPinOff } };
      step('the care approval and the Access PIN each covered OCR for the doctor; the patient\'s revocation and turning the PIN off ended it');
    }

    // ── The laboratory may ask (it holds ocr.job.write), and Lab still refuses the purpose ──
    const labAsked = expectStatus(await ask(labStaff, patient), 201, 'the laboratory asks');
    expectStatus(await patientCall('POST', `/identity/access-requests/${labAsked.accessRequestId}/approve`), 200, 'lab approval');
    evidence.laboratory = { asked: 201, labWorkItemsWithGrant: expectProblem(await call(lab, labStaff, 'GET', '/lab/work-items',
      undefined, { purpose: RECORDS }), 400, 'PURPOSE_OF_USE_REQUIRED', 'lab with a grant') };

    // ── The kill switch: an operator turns the code off, then on again ──
    await owner.query(`update identity.purpose_of_use_codes set active = false where code = $1`, [RECORDS]);
    const off = { request: expectProblem(await ask(doctor, carePatient), 400, 'INVALID_CONSENT_COMMAND', 'switched off'),
      ocrRead: expectProblem(await readJob(), 404, 'OCR_JOB_NOT_FOUND', 'OCR read switched off'),
      consentStatus: (await statusOf(doctor, patient, RECORDS)).readAllowed ? 'allowed' : 'none' };
    assert.equal(off.consentStatus, 'none');
    await owner.query(`update identity.purpose_of_use_codes set active = true where code = $1`, [RECORDS]);
    expectStatus(await readJob(), 200, 'OCR read switched on again');
    evidence.killSwitch = { ...off, onAgain: 'the unexpired grant works again' };
    step('the kill switch refused the request and the grant, and on again the grant works');

    // ── The patient revokes ──
    expectStatus(await patientCall('POST', `/identity/me/consent-grants/${approved.consentGrantId}/revoke`,
      { reason: 'I no longer want my paper records processed' }), 200, 'revoke');
    evidence.revoked = { ocrRead: expectProblem(await readJob(), 404, 'OCR_JOB_NOT_FOUND', 'OCR read after revocation'),
      ocrCreate: expectProblem(await createJob(doctor, document), 404, null, 'OCR create after revocation'),
      documentDownload: expectProblem(await download(doctor, document, RECORDS), 404, null, 'EHR document after revocation'),
      consentStatus: (await statusOf(doctor, patient, RECORDS)).readAllowed ? 'allowed' : 'none' };
    assert.equal(evidence.revoked.consentStatus, 'none');
    step('the patient revoked the grant and OCR and the document closed');
  }

  // ── Audit: the request rows carry the purpose; no row holds the reason or a Health ID ──
  const auditRows = await owner.query(`select action, purpose_of_use, details::text as details from audit.events
    where source_system = 'identity-api' and action like 'identity.access-request%' and purpose_of_use = $1`, [RECORDS]);
  if (stage !== 'before-0104') assert(auditRows.rows.length > 0, 'no records-processing audit row');
  const leaked = auditRows.rows.filter(row => [patient.hid, minor.hid, undated.hid].some(value => row.details.includes(value)));
  assert.deepEqual(leaked, [], 'an audit row names a Health ID');
  evidence.audit = { recordsProcessingRows: auditRows.rows.length, healthIdsInDetails: 0 };
  evidence.elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  evidence.status = 'passed';
  console.log(JSON.stringify(evidence));
} catch (error) {
  failure = error;
} finally {
  for (const child of children) child.kill('SIGTERM');
  await new Promise(done => setTimeout(done, 300));
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  stub.close();
  await owner.end().catch(() => {});
  if (failure && loopback && process.env.HID_VERIFIER_KEEP_DATABASE === '1') console.error(`kept ${isolated}`);
  else await maintenance.query(`drop database if exists ${isolated} with (force)`).catch(() => {});
  await maintenance.end().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
if (failure) {
  for (const [name, log] of childLogs) {
    const lines = log.join('').split('\n');
    const tail = (process.env.HID_VERIFIER_FULL_LOGS ? lines.slice(-80)
      : lines.filter(line => /error|Error|ERROR|warn/.test(line)).slice(-15)).join('\n');
    if (tail) console.error(`--- ${name} ---\n${tail}`);
  }
  console.error(failure);
  process.exit(1);
}
