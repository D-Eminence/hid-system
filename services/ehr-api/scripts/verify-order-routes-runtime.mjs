#!/usr/bin/env node
// Cross-facility lab requests and prescriptions (P4c, SPEC-FINAL §15) end to
// end, over HTTP, with Identity, EHR, Lab and Pharmacy each booted from its
// own source (its own main.ts: global pipes, filters, guards and controllers
// as deployed) in its own process, each connected as its exact runtime role
// (hid_identity_api_runtime, hid_ehr_api_runtime, hid_lab_api_runtime,
// hid_pharmacy_api_runtime), the services calling each other over loopback
// with local-secret workload identity. Only the outbound boundaries are local
// stubs: the QoreID HTTP API (redirected to a loopback stub by a preload that
// also refuses every other non-loopback request) and notification-api's OTP
// and staff-invitation routes. All values are synthetic. It runs only against
// the owned disposable synthetic rehearsal or, with
// HID_ORDER_ROUTES_RUNTIME_LOCAL_CLUSTER=loopback, a disposable copy of a
// database on a loopback test cluster.
//
// Fixtures come through the real flows: facilities sign up through P4's
// public routes and are reviewed by support through P4b's console route; the
// second laboratory member, a second doctor and the hospital's own Lab and
// Pharmacy staff are invited through P4b's staff invitations; the patient
// approves each clinician's access request in the app. Owner SQL is used only
// for what no route does: the platform administrator's and the two patients'
// accounts (as the other runtime verifiers seed them), QoreID switched on, a
// newer attestation text (the DPO's next wording, to prove the current one is
// required), reading what the database holds, ageing routes past their
// windows (the services' clock cannot be moved), one row the laboratory
// could not write itself (its own same-facility work item for the same
// patient, to prove a route never opens another row of that patient), and,
// for the wrong-patient report (item 3), a laboratory role that may receive
// lab requests but not mark results entered in error (no standard role is
// one: the lab role holds both permissions). Item 4 (0089)'s contract fields
// are checked on the answers the run already reads: receives and routesHere
// on the Lab and Pharmacy work lists and Incoming, support's Find's
// accessEndsAt and closable, the facility summary's destination, and a
// laboratory unlisted after orders were sent to it.
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
const loopback = process.env.HID_ORDER_ROUTES_RUNTIME_LOCAL_CLUSTER === 'loopback'
  && ['127.0.0.1', '::1', 'localhost'].includes(socket ?? '')
  && /^[a-z][a-z0-9_]{0,40}$/.test(process.env.PGDATABASE ?? '');
assert(process.env.NODE_ENV === 'test' && (rehearsal || loopback),
  'Only the owned synthetic rehearsal or an explicitly named loopback test cluster is supported');
assert(process.env.OTP_HMAC_KEY_B64, 'The rehearsal OTP HMAC key is required');
assert(process.env.AUTH_SIGNING_SECRET && process.env.AUTH_LOGIN_PEPPER, 'Synthetic session keys are required');
const port = Number(process.env.PGPORT ?? 5432);
const pgUser = process.env.PGUSER ?? 'postgres';
const isolated = `${rehearsal ? 'hid_rehearsal' : process.env.PGDATABASE}_routes_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const databaseUrl = role => {
  const options = `options=${encodeURIComponent(`-c role=${role}`)}`;
  return rehearsal
    ? `postgresql://${pgUser}@localhost:${port}/${isolated}?host=${encodeURIComponent(socket)}&${options}`
    : `postgresql://${pgUser}@${socket === '::1' ? '[::1]' : socket}:${port}/${isolated}?${options}`;
};

// Production hosts: the portal (app.*) runs sign-up, invitations and the
// patient's app; staff sign in on their product's host; support on admin.*.
const appOrigin = 'https://app.healthidentitydirectory.com';
const ehrOrigin = 'https://ehr.healthidentitydirectory.com';
const labOrigin = 'https://lab.healthidentitydirectory.com';
const pharmacyOrigin = 'https://pharmacy.healthidentitydirectory.com';
const adminOrigin = 'https://admin.healthidentitydirectory.com';
const CORS = [appOrigin, ehrOrigin, labOrigin, pharmacyOrigin, adminOrigin, 'https://healthidentitydirectory.com'].join(',');
const tokens = {
  identityEhr: `synthetic-identity-ehr-${randomBytes(16).toString('hex')}`,
  identityLab: `synthetic-identity-lab-${randomBytes(16).toString('hex')}`,
  identityPharmacy: `synthetic-identity-pharmacy-${randomBytes(16).toString('hex')}`,
  lab: `synthetic-lab-workload-${randomBytes(16).toString('hex')}`,
  pharmacy: `synthetic-pharmacy-workload-${randomBytes(16).toString('hex')}`,
  ehr: `synthetic-ehr-workload-${randomBytes(16).toString('hex')}`,
  notification: `synthetic-notification-workload-${randomBytes(16).toString('hex')}`,
};

const freePort = () => new Promise((done, fail) => {
  const server = createNetServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => { const { port: chosen } = server.address(); server.close(() => done(chosen)); });
});
const steps = [];
const step = (name, value = true) => { steps.push(name); return value; };

// ── Stubs: QoreID and notification-api's routes, on one loopback server ──
const otpCodes = new Map();
const invitationEmails = [];
const qoreidLookups = [];
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
        assert.equal(req.headers.authorization, 'Bearer synthetic-qoreid-token');
        const { regNumber } = JSON.parse(raw);
        qoreidLookups.push(regNumber);
        const company = companies.get(regNumber);
        assert(company, `Unexpected CAC lookup ${regNumber}`);
        answer(200, { id: 980000 + qoreidLookups.length, summary: { cac_check: 'verified' },
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
        const challengeId = String(req.headers['idempotency-key']).replace(/^otp:/, '');
        otpCodes.set(challengeId, body.code);
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
  return response.body;
};

const answerOf = response => `${response.status} ${response.body?.code ?? ''}`.trim();
const maintenance = new Pool({ host: socket, port, user: pgUser, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
const owner = new Pool({ host: socket, port, user: pgUser, database: isolated, max: 3 });
const one = async (sql, values = []) => (await owner.query(sql, values)).rows[0];
const all = async (sql, values = []) => (await owner.query(sql, values)).rows;
const temporary = await mkdtemp(join(tmpdir(), 'hid-order-routes-'));
const evidence = { steps };
const startedAt = Date.now();
let failure;
try {
  await new Promise(done => stub.listen(0, '127.0.0.1', done));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const preload = join(temporary, 'loopback-only.cjs');
  await writeFile(preload, preloadSource);
  // Fixture: the platform has enabled QoreID CAC verification (an admin action).
  await owner.query("update platform.integration_providers set enabled=true, row_version=row_version+1 where provider='qoreid'");

  // Each runtime URL sets its role; the same URL proves it.
  const runtimeRoles = {};
  for (const role of ['hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime']) {
    const client = new Client({ connectionString: databaseUrl(role) });
    await client.connect();
    runtimeRoles[role] = (await client.query('select current_user as role')).rows[0].role;
    await client.end();
    assert.equal(runtimeRoles[role], role);
  }
  evidence.runtimeRoles = runtimeRoles;

  const [identityPort, ehrPort, labPort, pharmacyPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const common = { HID_VERIFIER_PRELOAD: preload, HID_VERIFIER_STUB_URL: stubUrl, CORS_ORIGINS: CORS,
    TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128' };
  const [identity, ehr, lab, pharmacy] = await Promise.all([
    boot('identity-api', join(services, 'identity-api'), { ...common, DATABASE_URL: databaseUrl('hid_identity_api_runtime'),
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET, AUTH_LOGIN_PEPPER: process.env.AUTH_LOGIN_PEPPER,
      OTP_HMAC_KEY_B64: process.env.OTP_HMAC_KEY_B64, AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'production',
      NIN_PROVIDER_MODE: 'unavailable', TURNSTILE_MODE: 'disabled', QOREID_ENABLED: 'true',
      QOREID_CLIENT_ID: 'example-qoreid-client', QOREID_CLIENT_SECRET: 'example-qoreid-secret',
      IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: tokens.identityEhr,
      IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: tokens.identityLab, IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.identityPharmacy,
      NOTIFICATION_API_URL: stubUrl, NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret',
      NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: tokens.notification, PATIENT_LIFECYCLE_SWEEP_SECONDS: '0' }, identityPort),
    boot('ehr-api', join(services, 'ehr-api'), { ...common, DATABASE_URL: databaseUrl('hid_ehr_api_runtime'),
      STORAGE_MODE: 'disabled', IDENTITY_API_URL: `http://127.0.0.1:${identityPort}`,
      IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: tokens.identityEhr, LAB_API_URL: `http://127.0.0.1:${labPort}`,
      LAB_INTERNAL_SERVICE_TOKEN: tokens.lab, PHARMACY_API_URL: `http://127.0.0.1:${pharmacyPort}`,
      PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy, EHR_INTERNAL_SERVICE_TOKEN: tokens.ehr }, ehrPort),
    boot('lab-api', join(services, 'lab-api'), { ...common, DATABASE_URL: databaseUrl('hid_lab_api_runtime'),
      IDENTITY_API_URL: `http://127.0.0.1:${identityPort}`, IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: tokens.identityLab,
      LAB_INTERNAL_SERVICE_TOKEN: tokens.lab }, labPort),
    boot('pharmacy-api', join(services, 'pharmacy-api'), { ...common, DATABASE_URL: databaseUrl('hid_pharmacy_api_runtime'),
      IDENTITY_API_URL: `http://127.0.0.1:${identityPort}`, IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.identityPharmacy,
      PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy }, pharmacyPort),
  ]);
  step('four services booted from their own code');

  // ── Support and the controls ──
  const password = 'Synthetic-Order-Route-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const synthetic = label => `routes-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const signInStaff = async (email, host, facilityId, extra = {}) => {
    const response = await http(identity, 'POST', '/auth/login', { origin: host.origin,
      body: { email, password, turnstileAction: host.action } });
    expectStatus(response, 200, `sign-in ${email}`);
    return { email, origin: host.origin, facilityId, accountId: response.body.actor.accountId,
      csrf: response.headers.get('x-csrf-token'), cookie: response.cookies.join('; '), ...extra };
  };
  const HOSTS = { ehr: { origin: ehrOrigin, action: 'staff-login' }, lab: { origin: labOrigin, action: 'lab-login' },
    pharmacy: { origin: pharmacyOrigin, action: 'pharmacy-login' }, admin: { origin: adminOrigin, action: 'admin-login' } };
  const accountId = randomUUID();
  const supportEmail = synthetic('support');
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
    values ($1, $2, $3, 'Synthetic Support', $4, 'argon2id', 'active')`,
  [accountId, `synthetic:platform-admin:${accountId}`, supportEmail, passwordHash]);
  await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values ($1, $2, 'platform_super_admin', 'platform', 'Synthetic platform administrator for the order-route verifier')`,
  [randomUUID(), accountId]);
  const support = await signInStaff(supportEmail, HOSTS.admin, undefined);
  const adminCall = (method, path, body, extra = {}) => http(identity, method, path, { cookie: support.cookie,
    ...(method === 'GET' ? {} : { origin: adminOrigin, csrf: support.csrf }), body, ...extra });
  const setControl = async (controlKey, enabled) => {
    const list = expectStatus(await adminCall('GET', '/admin/controls'), 200, 'controls');
    const control = list.find(item => item.controlKey === controlKey);
    assert(control, `control ${controlKey} missing`);
    if (control.enabled === enabled) return control;
    const changed = await adminCall('POST', '/admin/controls', { controlKey, enabled,
      reason: `Order-route verifier: ${controlKey} ${enabled ? 'on' : 'off'}` }, { ifMatch: control.version });
    return expectStatus(changed, 201, `control ${controlKey}`);
  };
  const controlsAtStart = Object.fromEntries((expectStatus(await adminCall('GET', '/admin/controls'), 200, 'controls'))
    .map(control => [control.controlKey, control.enabled]));
  evidence.controlsAtStart = controlsAtStart;
  assert.equal(controlsAtStart.cross_facility_orders_enabled, false, 'Orders between facilities must ship off');
  assert.equal(controlsAtStart.cross_facility_route_access_enabled, true, 'Route access must ship on');
  await setControl('provider_self_service_enabled', true);
  await setControl('staff_invitations_enabled', true);

  // ── Facilities through P4's sign-up and P4b's review ──
  let signUps = 0;
  const signUp = async ({ label, organizationType, productCode, administratorName }) => {
    signUps += 1;
    const cac = `RC99000${String(66000 + signUps)}`;
    const name = `Verifier ${label} ${cac} Ltd`;
    companies.set(cac, { name, address: `${signUps} Synthetic Registry Road, Ikeja, Lagos` });
    const email = synthetic(`admin-${signUps}`);
    const network = `198.51.140.${signUps}`;
    const started = await http(identity, 'POST', '/identity/provider-enrollments', { origin: appOrigin, forwardedFor: network,
      body: { cacRegistrationNumber: cac, administratorEmail: email, organizationType, productCode, administratorName,
        turnstileAction: 'provider-enrollment', turnstileToken: 'disabled-in-this-run' } });
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
    return { label, email, organizationType, productCode, cac, name: facility.name, address: companies.get(cac).address,
      administratorName, organizationId: activated.body.organizationId, facilityId: activated.body.facilityId,
      accountId: activated.body.accountId, applicationId: facility.application_id };
  };
  const review = async (target, grantedRole, licence, verificationMethod = 'regulator_register') => {
    const listed = expectStatus(await adminCall('GET', '/admin/self-service-facilities?state=all'), 200, 'support list');
    const item = listed.items.find(entry => entry.applicationId === target.applicationId);
    assert(item, `${target.label} is not in support's list`);
    const reviewed = await adminCall('POST', `/admin/self-service-facilities/${target.applicationId}/review`,
      { note: 'Checked the administrator against the company record and the register', grantedRole, verificationMethod,
        ...(licence ? { administratorLicence: licence } : {}) }, { ifMatch: item.version });
    return expectStatus(reviewed, 200, `review ${target.label}`);
  };
  const hospital = await signUp({ label: 'Hospital', organizationType: 'hospital', productCode: 'ehr',
    administratorName: 'Adaeze Okafor' });
  const laboratory = await signUp({ label: 'Laboratory', organizationType: 'laboratory', productCode: 'laboratory',
    administratorName: 'Bello Musa' });
  const pharmacyFacility = await signUp({ label: 'Pharmacy', organizationType: 'pharmacy', productCode: 'pharmacy',
    administratorName: 'Chioma Eze' });
  const otherLab = await signUp({ label: 'Laboratory', organizationType: 'laboratory', productCode: 'laboratory',
    administratorName: 'Dauda Yusuf' });
  const pendingLab = await signUp({ label: 'Laboratory', organizationType: 'laboratory', productCode: 'laboratory',
    administratorName: 'Efe Ojo' });
  const thirdHospital = await signUp({ label: 'Clinic', organizationType: 'hospital', productCode: 'ehr',
    administratorName: 'Funke Ade' });
  await review(hospital, 'doctor', { body: 'MDCN', number: 'MDCN/70011' });
  await review(laboratory, 'lab', { body: 'MLSCN', number: 'MLSCN/70022' });
  await review(pharmacyFacility, 'pharmacist', { body: 'PCN', number: 'PCN/70033' });
  await review(otherLab, 'lab', { body: 'MLSCN', number: 'MLSCN/70044' }, 'other');
  await review(thirdHospital, 'doctor', { body: 'MDCN', number: 'MDCN/70055' });
  step('facilities signed up (P4) and reviewed by support (P4b); one laboratory left pending');

  const doctor = await signInStaff(hospital.email, HOSTS.ehr, hospital.facilityId, { name: hospital.administratorName });
  const labAdmin = await signInStaff(laboratory.email, HOSTS.lab, laboratory.facilityId);
  const pharmacist = await signInStaff(pharmacyFacility.email, HOSTS.pharmacy, pharmacyFacility.facilityId);
  const otherLabAdmin = await signInStaff(otherLab.email, HOSTS.lab, otherLab.facilityId);
  const pendingLabAdmin = await signInStaff(pendingLab.email, HOSTS.lab, pendingLab.facilityId);
  const thirdDoctor = await signInStaff(thirdHospital.email, HOSTS.ehr, thirdHospital.facilityId);
  const call = (base, who, method, path, body, extra = {}) => http(base, method, path, { cookie: who.cookie,
    facility: who.facilityId, purpose: 'direct-care', ...(method === 'GET' ? {} : { origin: who.origin, csrf: who.csrf }),
    body, ...extra });
  const freshKey = label => `verifier-${label}-${randomUUID()}`;

  // ── The patient: an app account, and the doctor's write access approved in the app ──
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const healthIdOf = () => `HID-${Array.from(randomBytes(10), byte => alphabet[byte % alphabet.length]).join('')}`;
  const patientEmail = synthetic('patient');
  const patientAccount = randomUUID();
  const patient = { id: randomUUID(), hid: healthIdOf(), fullName: 'Ngozi Verifier-Patient', dob: '1987-03-14',
    sex: 'female' };
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
    values ($1, $2, $3, $4, $5, 'argon2id', 'active')`,
  [patientAccount, `synthetic:patient:${patientAccount}`, patientEmail, patient.fullName, passwordHash]);
  await owner.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob,
      status) values ($1, $2, $3, 'Ngozi', 'Verifier-Patient', $4, $5, $6, 'active')`,
  [patient.id, patientAccount, patient.hid, patient.fullName, patient.sex, patient.dob]);
  // A second patient with an app account, never part of these orders.
  const otherPatient = { id: randomUUID(), hid: healthIdOf(), account: randomUUID(), email: synthetic('patient-q') };
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
    values ($1, $2, $3, 'Other Verifier-Patient', $4, 'argon2id', 'active')`,
  [otherPatient.account, `synthetic:patient:${otherPatient.account}`, otherPatient.email, passwordHash]);
  await owner.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob,
      status) values ($1, $2, $3, 'Other', 'Verifier-Patient', 'Other Verifier-Patient', 'male', '1979-11-02', 'active')`,
  [otherPatient.id, otherPatient.account, otherPatient.hid]);
  const patientLogin = expectStatus(await http(identity, 'POST', '/auth/patient/login', { origin: appOrigin,
    body: { email: patientEmail, password, turnstileAction: 'patient-login' } }), 200, 'patient sign-in');
  const loggedIn = await http(identity, 'POST', '/auth/patient/login', { origin: appOrigin,
    body: { email: patientEmail, password, turnstileAction: 'patient-login' } });
  const patientSession = { cookie: loggedIn.cookies.join('; '), csrf: loggedIn.headers.get('x-csrf-token'), origin: appOrigin };
  assert(patientLogin && patientSession.csrf, 'patient session');
  // As the patient app calls: the session cookie, CSRF and Origin on writes, no facility and no purpose header.
  const patientCall = (base, method, path, body) => http(base, method, path, { cookie: patientSession.cookie,
    ...(method === 'GET' ? {} : { origin: appOrigin, csrf: patientSession.csrf }), body });
  const approvedAccess = async (who, scope) => {
    const requested = expectStatus(await call(identity, who, 'POST', '/identity/access-requests',
      { hid: patient.hid, scope, reason: 'Synthetic consultation for the order-route verifier', durationMinutes: 1440 }),
    201, `access request ${scope}`);
    const requestId = requested.accessRequestId;
    assert(requestId, `access request answer: ${JSON.stringify(requested)}`);
    const pending = expectStatus(await patientCall(identity, 'GET', '/identity/me/access-requests'), 200, 'my access requests');
    assert(pending.some(item => item.accessRequestId === requestId && item.status === 'pending'), 'the request in the app');
    const approved = expectStatus(await patientCall(identity, 'POST', `/identity/access-requests/${requestId}/approve`), 200,
      `approve ${scope}`);
    assert.equal(approved.status, 'approved');
    return requestId;
  };
  // The approval's guards, as main's (REC-NOTIFY): refused for 24 hours after an OTP account recovery,
  // and from a session family first issued more than 10 minutes ago. Owner SQL seeds a consumed
  // recovery challenge, then ages the patient's session families; the request stays pending each time.
  const guarded = expectStatus(await call(identity, doctor, 'POST', '/identity/access-requests',
    { hid: patient.hid, scope: 'read_records', reason: 'Synthetic consultation for the approval guards', durationMinutes: 60 }),
  201, 'access request for the guards').accessRequestId;
  const recovery = randomUUID();
  await owner.query(`insert into auth.otp_challenges (id, account_id, recipient_hmac, purpose, channel, verifier_hmac,
      verifier_key_version, expires_at, max_attempts, created_at, verified_at, completion_token_hmac, completion_expires_at,
      consumed_at)
    values ($1, $2, repeat('a', 64), 'PASSWORD_RESET', 'email', repeat('b', 64), 'verifier-v1',
      clock_timestamp() + interval '5 minutes', 5, clock_timestamp() - interval '6 minutes', clock_timestamp() - interval '5 minutes',
      repeat('c', 64), clock_timestamp() + interval '5 minutes', clock_timestamp() - interval '5 minutes')`, [recovery, patientAccount]);
  const held = expectProblem(await patientCall(identity, 'POST', `/identity/access-requests/${guarded}/approve`), 403,
    'PATIENT_RECENT_RECOVERY_HOLD');
  await owner.query('delete from auth.otp_challenges where id = $1', [recovery]);
  await owner.query(`update auth.sessions set issued_at = issued_at - interval '11 minutes'
    where account_id = $1 and revoked_at is null`, [patientAccount]);
  const stale = expectProblem(await patientCall(identity, 'POST', `/identity/access-requests/${guarded}/approve`), 403,
    'PATIENT_RECENT_AUTH_REQUIRED');
  assert.equal(stale.detail ?? stale.message ?? stale.title, 'For your security, sign out, sign in again, and approve within 10 minutes.',
    JSON.stringify(stale));
  await owner.query(`update auth.sessions set issued_at = issued_at + interval '11 minutes'
    where account_id = $1 and revoked_at is null`, [patientAccount]);
  assert.equal((await one('select status from identity.access_requests where id = $1', [guarded])).status, 'pending');
  const deniedGuarded = expectStatus(await patientCall(identity, 'POST', `/identity/access-requests/${guarded}/deny`,
    { reason: 'Not needed for the verifier' }), 200, 'deny is not held');
  assert.equal(deniedGuarded.status, 'denied');
  evidence.approvalGuards = { afterRecovery: { status: 403, code: held.code }, staleSession: { status: 403, code: stale.code },
    requestStayedPending: true, denyUnguarded: 200 };
  await approvedAccess(doctor, 'write_records');
  step('the patient approved the doctor\'s write access in the app, after the recovery hold and fresh sign-in checks');

  // ── The doctor's records at the hospital ──
  const ehrCall = (who, method, path, body, extra) => call(ehr, who, method, `/ehr/patients/${patient.id}${path}`, body, extra);
  const encounter = expectStatus(await ehrCall(doctor, 'POST', '/encounters', { encounterType: 'ambulatory',
    status: 'in_progress', startedAt: new Date().toISOString(), chiefComplaint: 'Synthetic chief complaint' },
  { key: freshKey('encounter') }), 201, 'encounter');
  const enc = `/encounters/${encounter.id}`;
  const labTest = { testCodeSystem: 'http://loinc.org', testCode: '4548-4', testDisplay: 'Synthetic HbA1c panel' };
  const clinicalNote = 'Synthetic clinical note: thirst and tiredness for two weeks';
  const newLabRequest = async (status = 'draft', extra = {}) => expectStatus(await ehrCall(doctor, 'POST', `${enc}/lab-requests`,
    { ...labTest, priority: 'routine', status, specimenTypeCode: 'blood', clinicalInformation: clinicalNote, ...extra },
    { key: freshKey('lab-request') }), 201, 'lab request');
  const medicine = { medicationCodeSystem: 'http://snomed.info/sct', medicationCode: '325072002',
    medicationDisplay: 'Synthetic metformin 500 mg tablet', doseQuantity: 1, doseUnit: 'tablet', routeCode: 'oral',
    frequency: 'twice daily', instructions: 'Synthetic instructions: take with food' };
  const newPrescription = async (status = 'draft') => expectStatus(await ehrCall(doctor, 'POST', `${enc}/prescriptions`,
    { ...medicine, status, startsOn: '2026-10-25', endsOn: '2026-11-24' }, { key: freshKey('prescription') }), 201,
  'prescription');
  const lr1 = await newLabRequest();
  assert.equal(lr1.status, 'draft');

  // ── 1. Closed: orders between facilities ship off ──
  const labAttestation = { kind: 'lab_request' };
  const routesPath = (kind, orderId) => `${enc}/${kind === 'lab_request' ? 'lab-requests' : 'prescriptions'}/${orderId}/order-routes`;
  const send = (who, kind, order, receivingFacilityId, version, extra = {}) => ehrCall(who, 'POST', routesPath(kind, order.id),
    { expectedRowVersion: Number(order.rowVersion), receivingFacilityId, patientAgreed: true, attestationTextVersion: version,
      ...(extra.body ?? {}) }, { key: extra.key ?? freshKey('send'), ...(extra.purpose ? { purpose: extra.purpose } : {}) });
  const closed = {};
  closed.directory = expectProblem(await call(identity, doctor, 'GET', '/identity/order-destinations?kind=laboratory&query=Verifier'),
    423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE').code;
  closed.attestation = expectProblem(await call(ehr, doctor, 'GET', '/ehr/order-route-attestation?kind=lab_request'), 423,
    'CROSS_FACILITY_ORDERS_UNAVAILABLE').code;
  closed.send = expectProblem(await send(doctor, 'lab_request', lr1, laboratory.facilityId, 'order-route-lab-attestation-v1'),
    423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE').code;
  closed.accept = expectProblem(await call(lab, labAdmin, 'POST', `/lab/order-routes/${randomUUID()}/accept`,
    { expectedVersion: 1, patientIdentifier: { kind: 'health_id', value: patient.hid } }, { key: freshKey('accept') }),
  423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE').code;
  const closedIncoming = expectStatus(await call(lab, labAdmin, 'GET', '/lab/order-routes?view=incoming'), 200, 'closed incoming');
  // Item 4 (0089): the reviewed, listed laboratory receives whatever the switch says; nothing waits or is held there yet.
  assert.deepEqual(closedIncoming, { items: [], receives: true, routesHere: { waiting: false, held: false },
    crossFacilityOrders: false, crossFacilityWork: true });
  closed.incoming = closedIncoming;
  const closedWorkList = expectStatus(await call(lab, labAdmin, 'GET', '/lab/work-items'), 200, 'closed work list');
  assert.deepEqual([closedWorkList.receives, closedWorkList.routesHere, closedWorkList.crossFacilityOrders],
    [true, { waiting: false, held: false }, false]);
  const closedList = expectStatus(await ehrCall(doctor, 'GET', `${enc}/lab-requests`), 200, 'closed list');
  assert.equal(closedList.crossFacilityOrders, false);
  closed.labRequestList = { crossFacilityOrders: false, orderRoute: closedList.items[0].orderRoute };
  const closedAvailability = expectStatus(await http(identity, 'GET', '/identity/provider-enrollments/availability'), 200,
    'availability');
  assert.deepEqual(closedAvailability, { open: true, crossFacilityOrders: false });
  closed.availability = closedAvailability;
  evidence.closed = closed;
  step('closed: directory, attestation, send and accept 423; Incoming empty with crossFacilityOrders false');

  // ── 2. Support opens orders between facilities ──
  await setControl('cross_facility_orders_enabled', true);
  assert.deepEqual(expectStatus(await http(identity, 'GET', '/identity/provider-enrollments/availability'), 200, 'availability'),
    { open: true, crossFacilityOrders: true });
  step('opened by support through POST /admin/controls');

  // ── 3. Directory ──
  const search = (who, kind, query) => call(identity, who, 'GET',
    `/identity/order-destinations?kind=${kind}&query=${encodeURIComponent(query)}`);
  const found = expectStatus(await search(doctor, 'laboratory', 'Verifier Laboratory'), 200, 'directory').items;
  assert.deepEqual(found.map(item => item.facilityId), [laboratory.facilityId],
    'Only the reviewed, listed laboratory may be found (not the pending one, nor the one checked as Other)');
  assert.deepEqual(Object.keys(found[0]).sort(), ['facilityId', 'facilityName', 'newOnHealthId', 'organizationName',
    'registeredAddress']);
  assert.equal(found[0].registeredAddress, laboratory.address);
  assert.equal(found[0].newOnHealthId, true);
  assert.deepEqual(expectStatus(await search(doctor, 'laboratory', 'Verifier Hospital'), 200, 'hospital search').items, []);
  assert.deepEqual(expectStatus(await search(doctor, 'pharmacy', 'Verifier Pharmacy'), 200, 'pharmacy search').items
    .map(item => item.facilityId), [pharmacyFacility.facilityId]);
  expectProblem(await search(doctor, 'laboratory', 'Ve'), 400, 'ORDER_DESTINATION_QUERY_INVALID');
  expectProblem(await search(labAdmin, 'laboratory', 'Verifier'), 403, 'PERMISSION_DENIED');
  // Support lists the laboratory checked as Other, then unlists it again.
  const listOther = listed => adminCall('POST', `/admin/facilities/${otherLab.facilityId}/order-destination`,
    { listed, reason: listed ? 'Checked the laboratory by phone with its registered contact' : 'Listing withdrawn for the verifier' });
  const summaryOther = expectStatus(await adminCall('GET', `/admin/facilities/${otherLab.facilityId}/order-route-summary`), 200,
    'summary');
  assert.deepEqual(summaryOther.listed, { value: false, byDefault: true, reason: null, setAt: null });
  // Item 4 (0089): what the facility is as a destination, beside the listing (D6), with no verification method (D7).
  assert.deepEqual(summaryOther.destination, { receivingTypes: ['laboratory'], review: 'reviewed' });
  assert.deepEqual(Object.keys(summaryOther).sort(), ['counterparts', 'destination', 'facilityId', 'listed',
    'receivedAcceptedLifetime', 'receivedPatientsLifetime']);
  const destinationOf = async target => expectStatus(await adminCall('GET',
    `/admin/facilities/${target.facilityId}/order-route-summary`), 200, `summary ${target.label}`).destination;
  const destinations = { laboratory: await destinationOf(laboratory), pharmacy: await destinationOf(pharmacyFacility),
    hospital: await destinationOf(hospital), pendingLaboratory: await destinationOf(pendingLab), checkedAsOther: summaryOther.destination };
  assert.deepEqual(destinations, { laboratory: { receivingTypes: ['laboratory'], review: 'reviewed' },
    pharmacy: { receivingTypes: ['pharmacy'], review: 'reviewed' }, hospital: { receivingTypes: [], review: 'reviewed' },
    pendingLaboratory: { receivingTypes: ['laboratory'], review: 'pending' },
    checkedAsOther: { receivingTypes: ['laboratory'], review: 'reviewed' } });
  // Whether the laboratory checked as Other receives (B1): not until support lists it, and not after it unlists it,
  // on its work list and Incoming alike, whatever the switches say; nothing waits or is held there.
  const receivingAtOther = async label => {
    const workList = expectStatus(await call(lab, otherLabAdmin, 'GET', '/lab/work-items'), 200, `other work list ${label}`);
    const incomingList = expectStatus(await call(lab, otherLabAdmin, 'GET', '/lab/order-routes?view=incoming'), 200,
      `other incoming ${label}`);
    assert.deepEqual(workList.routesHere, { waiting: false, held: false }, label);
    assert.deepEqual(incomingList.routesHere, { waiting: false, held: false }, label);
    assert.equal(workList.receives, incomingList.receives, label);
    return workList.receives;
  };
  const otherReceives = { unlistedByDefault: await receivingAtOther('before listing') };
  // The pending laboratory's administrator may not read the work list or Incoming yet (the guard refuses the
  // missing permission), so neither says anything.
  const pendingWorkList = expectProblem(await call(lab, pendingLabAdmin, 'GET', '/lab/work-items'), 403, 'PERMISSION_DENIED',
    'pending laboratory work list');
  const pendingIncoming = expectProblem(await call(lab, pendingLabAdmin, 'GET', '/lab/order-routes?view=incoming'), 403,
    'PERMISSION_DENIED');
  for (const refusal of [pendingWorkList, pendingIncoming]) {
    assert(!('receives' in refusal) && !('routesHere' in refusal), JSON.stringify(refusal));
  }
  assert.equal(expectStatus(await listOther(true), 200, 'list other').listed, true);
  otherReceives.listedBySupport = await receivingAtOther('listed');
  assert.deepEqual(expectStatus(await search(doctor, 'laboratory', 'Verifier Laboratory'), 200, 'directory').items
    .map(item => item.facilityId).sort(), [laboratory.facilityId, otherLab.facilityId].sort());
  expectProblem(await listOther(true), 409, 'ORDER_ROUTE_DESTINATION_UNCHANGED');
  assert.equal(expectStatus(await listOther(false), 200, 'unlist other').listed, false);
  otherReceives.unlistedBySupport = await receivingAtOther('unlisted');
  assert.deepEqual(otherReceives, { unlistedByDefault: false, listedBySupport: true, unlistedBySupport: false });
  const summaryOtherAfter = expectStatus(await adminCall('GET', `/admin/facilities/${otherLab.facilityId}/order-route-summary`),
    200, 'summary after');
  assert.deepEqual([summaryOtherAfter.listed.value, summaryOtherAfter.listed.byDefault, summaryOtherAfter.destination],
    [false, false, { receivingTypes: ['laboratory'], review: 'reviewed' }]);
  assert.deepEqual(expectStatus(await search(doctor, 'laboratory', 'Verifier Laboratory'), 200, 'directory').items
    .map(item => item.facilityId), [laboratory.facilityId]);
  expectProblem(await adminCall('POST', `/admin/facilities/${hospital.facilityId}/order-destination`,
    { listed: true, reason: 'A hospital is not a destination' }), 404, 'ADMIN_FACILITY_NOT_FOUND');
  evidence.directory = { found: 'reviewed listed laboratory only', notFound: ['pending laboratory', 'laboratory checked as Other',
    'hospital'], registeredAddress: true, newOnHealthId: true, supportListed: 'found', supportUnlisted: 'gone',
    unchanged: 409, hospital: 404, queryTooShort: 400, labMember: 403 };
  evidence.contractFields = { destinations, receivesAtLaboratoryCheckedAsOther: otherReceives,
    pendingLaboratory: { workList: `403 ${pendingWorkList.code}`, incoming: `403 ${pendingIncoming.code}`, fields: 'none' },
    closedIncoming: { receives: true, routesHere: { waiting: false, held: false }, crossFacilityOrders: false } };
  step('directory: only reviewed, listed laboratories and pharmacies; support lists and unlists');

  // Synthetic values that must never reach a receiver before acceptance, a third facility or an audit row.
  const clinicalOnly = [clinicalNote, medicine.instructions];
  const identityValues = [patient.fullName, patient.hid, patient.id, patient.dob];
  const assertNone = (value, forbidden, label) => {
    const text = JSON.stringify(value);
    for (const item of forbidden) assert(!text.includes(item), `${label} carries ${item}`);
  };
  // A Health ID in the URL of a lookup GET (CODEX §26) is refused before the service does anything: 400
  // HEALTH_ID_NOT_ACCEPTED_IN_URL naming the POST, the value never repeated, nothing listed, and no service (nor
  // Identity, which the guard would ask) wrote a row for the request.
  const refusedInUrl = async (send, searchPath, label) => {
    const correlationId = `verifier-hid-in-url-${randomUUID()}`;
    const response = await send({ headers: { 'x-correlation-id': correlationId } });
    const problem = expectProblem(response, 400, 'HEALTH_ID_NOT_ACCEPTED_IN_URL', label);
    assert.equal(problem.correlationId, correlationId, label);
    assert(problem.detail.includes(`POST /api/v1/${searchPath}`), `${label}: ${problem.detail}`);
    assert(!('items' in problem), `${label} listed`);
    assertNone([problem, [...response.headers]], [patient.hid, patient.hid.toLowerCase(), patient.hid.slice(4)], label);
    assert.deepEqual(await one(`select (select count(*)::int from audit.events where correlation_id = $1) as audit,
      (select count(*)::int from auth.session_events where correlation_id = $1) as sessions`, [correlationId]),
    { audit: 0, sessions: 0 }, `${label} wrote rows`);
    return 'HEALTH_ID_NOT_ACCEPTED_IN_URL';
  };

  // ── 4. Send, with the clinician's attestation ──
  const attestation = expectStatus(await call(ehr, doctor, 'GET', '/ehr/order-route-attestation?kind=lab_request'), 200,
    'attestation text');
  assert.deepEqual(Object.keys(attestation).sort(), ['kind', 'text', 'version']);
  assert.equal(attestation.version, 'order-route-lab-attestation-v1');
  for (const slot of ['{patient}', '{orderingFacility}', '{receivingFacility}']) assert(attestation.text.includes(slot));
  assert.equal(await one(`select count(*)::int n from audit.events where action='ehr.order-route.attestation-text.read'
    and facility_id=$1 and patient_id is null`, [hospital.facilityId]).then(row => row.n), 1);
  // The DPO's new wording: the clinician must confirm the current text.
  await owner.query(`insert into ehr.order_route_attestation_texts (version, kind, text) select
      'order-route-lab-attestation-v2', 'lab_request', text || ' (verifier wording v2)'
    from ehr.order_route_attestation_texts where version='order-route-lab-attestation-v1'`);
  const sendProblems = {};
  sendProblems.outdated = expectProblem(await send(doctor, 'lab_request', lr1, laboratory.facilityId,
    'order-route-lab-attestation-v1'), 409, 'ORDER_ROUTE_ATTESTATION_OUTDATED').code;
  const labVersion = expectStatus(await call(ehr, doctor, 'GET', '/ehr/order-route-attestation?kind=lab_request'), 200,
    'attestation text').version;
  assert.equal(labVersion, 'order-route-lab-attestation-v2');
  sendProblems.otherKindText = expectProblem(await send(doctor, 'lab_request', lr1, laboratory.facilityId,
    'order-route-prescription-attestation-v1'), 400, 'ORDER_ROUTE_INVALID').code;
  sendProblems.notAgreed = expectProblem(await send(doctor, 'lab_request', lr1, laboratory.facilityId, labVersion,
    { body: { patientAgreed: false } }), 400, 'VALIDATION_FAILED').code;
  sendProblems.emergency = expectProblem(await send(doctor, 'lab_request', lr1, laboratory.facilityId, labVersion,
    { purpose: 'emergency' }), 403, 'PERMISSION_DENIED').code;
  for (const [label, target] of [['pendingLaboratory', pendingLab], ['laboratoryCheckedAsOther', otherLab],
    ['ownFacility', hospital], ['pharmacyForALabRequest', pharmacyFacility]]) {
    sendProblems[label] = expectProblem(await send(doctor, 'lab_request', lr1, target.facilityId, labVersion), 409,
      'ORDER_ROUTE_DESTINATION_INELIGIBLE', label).code;
  }
  assert.equal((await one('select count(*)::int n from ehr.order_routes')).n, 0, 'A refused send wrote a route');
  const sendKey = freshKey('send-lr1');
  const sent = expectStatus(await send(doctor, 'lab_request', lr1, laboratory.facilityId, labVersion, { key: sendKey }), 201,
    'send lab request');
  const route1 = sent.route;
  assert.equal(route1.effectiveState, 'sent');
  assert.deepEqual(route1.receivingFacility, { id: laboratory.facilityId, name: laboratory.name, available: true });
  assert.equal(Date.parse(route1.respondBy) - Date.parse(route1.createdAt), 7 * 24 * 3600 * 1000);
  assert.deepEqual(sent.order, { id: lr1.id, status: 'active', rowVersion: 2 });
  assert.equal(sent.replayed, false);
  assert.match(route1.reference, /^[0-9A-F]{8}$/);
  const replay = expectStatus(await send(doctor, 'lab_request', lr1, laboratory.facilityId, labVersion, { key: sendKey }), 201,
    'replay');
  assert.deepEqual([replay.route.id, replay.replayed], [route1.id, true]);
  sendProblems.keyReused = expectProblem(await send(doctor, 'lab_request', { ...lr1, rowVersion: 2 },
    pharmacyFacility.facilityId, labVersion, { key: sendKey }), 409, 'IDEMPOTENCY_KEY_REUSED').code;
  sendProblems.again = expectProblem(await send(doctor, 'lab_request', { ...lr1, rowVersion: 2 }, laboratory.facilityId,
    labVersion), 409, 'ORDER_ROUTE_ALREADY_SENT').code;
  sendProblems.thisFacilitysLab = expectProblem(await ehrCall(doctor, 'POST', `${enc}/lab-requests/${lr1.id}/lab-work-item`,
    { expectedRowVersion: 2 }, { key: freshKey('send-to-lab') }), 409, 'LAB_REQUEST_ROUTED').code;
  const stored = await one(`select state, patient_agreement, attestation_text_version, attested_by_name,
      attested_receiving_facility_name, orderer_licence_body, orderer_licence_number, clinical_information,
      respond_by - created_at as respond_window from ehr.order_routes where id=$1`, [route1.id]);
  assert.deepEqual({ ...stored, respond_window: undefined }, { state: 'sent', patient_agreement: 'clinician_attested',
    attestation_text_version: labVersion, attested_by_name: hospital.administratorName,
    attested_receiving_facility_name: laboratory.name, orderer_licence_body: 'MDCN', orderer_licence_number: 'MDCN/70011',
    clinical_information: clinicalNote, respond_window: undefined });
  // The send and its replay, each audited at A with the patient and the attestation.
  const sendAudit = await all(`select facility_id, patient_id, details from audit.events where action='ehr.order-route.send'
    and resource_id=$1 order by sequence_id`, [route1.id]);
  assert.deepEqual(sendAudit.map(row => [row.facility_id, row.patient_id, row.details.replayed]),
    [[hospital.facilityId, patient.id, false], [hospital.facilityId, patient.id, true]]);
  assert.deepEqual({ ...sendAudit[0].details, routeId: undefined }, { kind: 'lab_request', receivingFacilityId: laboratory.facilityId,
    attestationTextVersion: labVersion, patientAgreement: 'clinician_attested', replayed: false, routeId: undefined });
  const receivedAudit = await all(`select actor_type, facility_id, patient_id from audit.events
    where action='ehr.order-route.received' and resource_id=$1`, [route1.id]);
  assert.deepEqual(receivedAudit, [{ actor_type: 'system', facility_id: laboratory.facilityId, patient_id: null }]);
  const listed = expectStatus(await ehrCall(doctor, 'GET', `${enc}/lab-requests`), 200, 'lab requests');
  assert.equal(listed.crossFacilityOrders, true);
  // Item 3: this backend serves the wrong-patient report, so the website may ask the clinician to have an order ended
  // at the receiver before changing it (an earlier backend sends no such field).
  assert.equal(listed.wrongPatientReports, true);
  assert.equal(listed.items.find(item => item.id === lr1.id).orderRoute.effectiveState, 'sent');
  evidence.send = { attestation: { read: 200, audited: 'no patient', outdated: 'ORDER_ROUTE_ATTESTATION_OUTDATED' },
    refusals: sendProblems, sent: { status: 201, state: 'sent', respondByDays: 7, draftActivated: true, replay: 'same route' },
    stored: { patientAgreement: 'clinician_attested', attestedBy: 'the sending doctor', receivingFacilityName: true },
    audit: { send: 'A, with the patient and the attestation', received: 'B, system, no patient' } };
  step('send: attestation required and current; ineligible destinations refused; sent at once');

  // What B sees at once: a preview, without the patient or the clinical information.
  const incoming = expectStatus(await call(lab, labAdmin, 'GET', '/lab/order-routes?view=incoming'), 200, 'incoming');
  assert.deepEqual([incoming.crossFacilityOrders, incoming.crossFacilityWork, incoming.items.length], [true, true, 1]);
  // Item 4: the laboratory receives, and an order waits there.
  assert.deepEqual([incoming.receives, incoming.routesHere], [true, { waiting: true, held: false }]);
  const preview = incoming.items[0];
  assert.deepEqual(Object.keys(preview).sort(), ['acceptLocked', 'attemptsLeft', 'effectiveState', 'id', 'orderer',
    'orderingFacilityName', 'priority', 'reference', 'respondBy', 'sentAt', 'specimenTypeCode', 'test', 'version']);
  assert.deepEqual([preview.id, preview.effectiveState, preview.orderingFacilityName, preview.attemptsLeft, preview.acceptLocked],
    [route1.id, 'sent', hospital.name, 5, false]);
  assert.deepEqual(preview.orderer, { name: hospital.administratorName, licenceBody: 'MDCN' });
  assert.deepEqual(preview.test, { codeSystem: labTest.testCodeSystem, code: labTest.testCode, name: labTest.testDisplay });
  assertNone(incoming, [...identityValues, ...clinicalOnly, 'MDCN/70011', lr1.id, encounter.id], 'Incoming');
  const previewDetail = expectStatus(await call(lab, labAdmin, 'GET', `/lab/order-routes/${route1.id}`), 200, 'route preview');
  assertNone(previewDetail, [...identityValues, ...clinicalOnly, 'MDCN/70011', lr1.id, encounter.id], 'route preview');
  assert.equal(previewDetail.patient, undefined);
  expectProblem(await call(lab, otherLabAdmin, 'GET', `/lab/order-routes/${route1.id}`), 404, 'ORDER_ROUTE_NOT_FOUND');
  expectProblem(await call(lab, pendingLabAdmin, 'GET', '/lab/order-routes?view=incoming'), 403, 'PERMISSION_DENIED');
  assert.deepEqual(expectStatus(await call(lab, otherLabAdmin, 'GET', '/lab/order-routes?view=incoming'), 200, 'other').items, []);
  evidence.preview = { keys: Object.keys(preview).sort(), patient: 'absent', clinicalInformation: 'absent',
    licenceNumber: 'absent', sourceIds: 'absent', otherLaboratory: 404, pendingLaboratory: 403 };
  step('B sees the preview at once, without the patient or the clinical information');

  // ── 5. The patient: the inbox (through Identity's runtime) and the sent-orders list ──
  const inbox = expectStatus(await patientCall(identity, 'GET', '/identity/me/notifications'), 200, 'inbox');
  const sentNotice = inbox.find(item => item.notificationCode === 'ORDER_ROUTE_SENT' && item.resourceId === route1.id);
  assert(sentNotice, `inbox: ${JSON.stringify(inbox)}`);
  assert.deepEqual([sentNotice.resourceType, sentNotice.metadata], ['order-route', { routeId: route1.id, kind: 'lab_request',
    orderingFacilityName: hospital.name, receivingFacilityName: laboratory.name }]);
  const read = expectStatus(await patientCall(identity, 'POST', `/identity/me/notifications/${sentNotice.id}/read`), 200, 'read');
  assert(read.readAt, 'read');
  const myRoutes = expectStatus(await patientCall(ehr, 'GET', '/ehr/me/order-routes'), 200, 'my routes');
  const myRoute = myRoutes.items.find(item => item.id === route1.id);
  assert(myRoute, JSON.stringify(myRoutes));
  const v2Text = (await one(`select text from ehr.order_route_attestation_texts where version=$1`, [labVersion])).text;
  assert.deepEqual([myRoute.effectiveState, myRoute.attestationTextVersion, myRoute.attestationText, myRoute.attestedByName,
    myRoute.orderingFacilityName, myRoute.receivingFacilityName, myRoute.receivingRegisteredAddress, myRoute.actions],
  ['sent', labVersion, v2Text, hospital.administratorName, hospital.name, laboratory.name, laboratory.address, ['withdraw']]);
  assert.deepEqual(myRoute.content, { testCodeSystem: labTest.testCodeSystem, testCode: labTest.testCode,
    testDisplay: labTest.testDisplay, priority: 'routine', specimenTypeCode: 'blood', clinicalInformation: clinicalNote,
    requestedAt: myRoute.content.requestedAt, ordererName: hospital.administratorName, ordererLicenceBody: 'MDCN',
    ordererLicenceNumber: 'MDCN/70011' });
  for (const action of ['approve', 'decline', 'accept']) {
    expectProblem(await patientCall(ehr, 'POST', `/ehr/me/order-routes/${route1.id}/${action}`, { expectedVersion: 1 }), 404);
  }
  evidence.patient = { inbox: { code: 'ORDER_ROUTE_SENT', names: 'ordering and receiving facility', markRead: 200,
    runtime: 'hid_identity_api_runtime' }, sentOrders: { attestationText: 'stored version', attestedBy: true,
    content: 'every field sent', actions: ['withdraw'] }, otherPatientActions: 404 };
  step('the patient is told in the inbox and sees the sent order with the attestation');

  // ── 6. Receive: identification at the counter ──
  const accept = (who, base, routeId, version, identifier, extra = {}) => call(base, who, 'POST',
    `/${base === lab ? 'lab' : 'pharmacy'}/order-routes/${routeId}/accept`,
    { expectedVersion: version, patientIdentifier: identifier, ...(extra.body ?? {}) }, { key: extra.key ?? freshKey('accept') });
  // A date of birth alone names no order (the counter may have picked another patient's row): it keeps the
  // order's 5 tries. With the order's reference it names this order and counts; another order's reference is
  // refused and counts nothing.
  const unnamed = expectProblem(await accept(labAdmin, lab, route1.id, 1, { kind: 'date_of_birth', value: '1990-01-01' }),
    409, 'ORDER_ROUTE_PATIENT_MISMATCH');
  assert.equal(unnamed.attemptsLeft, 5);
  expectProblem(await accept(labAdmin, lab, route1.id, 1, { kind: 'date_of_birth', value: '1990-01-01' },
    { body: { reference: 'FFFFFFFF' === route1.reference ? 'EEEEEEEE' : 'FFFFFFFF' } }), 409, 'ORDER_ROUTE_REFERENCE_MISMATCH');
  const mismatch = expectProblem(await accept(labAdmin, lab, route1.id, 1, { kind: 'date_of_birth', value: '1990-01-01' },
    { body: { reference: route1.reference.toLowerCase() } }), 409, 'ORDER_ROUTE_PATIENT_MISMATCH');
  assert.equal(mismatch.attemptsLeft, 4);
  assert.deepEqual(await all(`select outcome, identifies_route from ehr.order_route_accept_attempts where route_id = $1
    order by attempted_at`, [route1.id]), [{ outcome: 'mismatch', identifies_route: false },
    { outcome: 'mismatch', identifies_route: true }]);
  // Find by Health ID with the Health ID in the body (CODEX §26); a healthId in the GET's URL is refused.
  const byHealthId = expectStatus(await call(lab, labAdmin, 'POST', '/lab/order-routes/search',
    { view: 'incoming', healthId: patient.hid.toLowerCase() }), 200, 'by Health ID');
  assert.deepEqual(byHealthId.items.map(item => [item.id, item.attemptsLeft]), [[route1.id, 4]]);
  assert.deepEqual(expectStatus(await call(lab, labAdmin, 'POST', '/lab/order-routes/search',
    { view: 'incoming', healthId: healthIdOf() }), 200, 'other Health ID').items, []);
  expectProblem(await call(lab, labAdmin, 'POST', '/lab/order-routes/search', { view: 'incoming' }), 400, 'VALIDATION_FAILED');
  const labUrlRefusal = await refusedInUrl(extra => call(lab, labAdmin, 'GET',
    `/lab/order-routes?view=incoming&healthId=${patient.hid.toLowerCase()}`, undefined, extra), 'lab/order-routes/search',
  'Lab GET with a Health ID');
  await refusedInUrl(extra => call(lab, labAdmin, 'GET', '/lab/order-routes?healthId=', undefined, extra),
    'lab/order-routes/search', 'Lab GET with an empty healthId');
  expectProblem(await accept(labAdmin, lab, route1.id, 1, { kind: 'date_of_birth', value: '1987-02-30' }), 400,
    'ORDER_ROUTE_INVALID');
  const acceptKey = freshKey('accept-lr1');
  const accepted = expectStatus(await accept(labAdmin, lab, route1.id, 1,
    { kind: 'health_id', value: `  ${patient.hid.toLowerCase()} ` }, { key: acceptKey }), 201, 'accept');
  assert.deepEqual(accepted.patient, { fullName: patient.fullName, sex: patient.sex, dateOfBirth: patient.dob,
    healthIdLast4: patient.hid.slice(-4) });
  assert.deepEqual([accepted.route.effectiveState, accepted.clinicalInformation, accepted.orderer, accepted.replayed],
    ['accepted', clinicalNote, { licenceBody: 'MDCN', licenceNumber: 'MDCN/70011' }, false]);
  assertNone(accepted, [patient.hid, patient.id, lr1.id, encounter.id], 'acceptance');
  const acceptedAgain = expectStatus(await accept(labAdmin, lab, route1.id, 1,
    { kind: 'health_id', value: `  ${patient.hid.toLowerCase()} ` }, { key: acceptKey }), 201, 'accept replay');
  assert.deepEqual([acceptedAgain.workItemId, acceptedAgain.replayed], [accepted.workItemId, true]);
  expectProblem(await accept(labAdmin, lab, route1.id, 2, { kind: 'health_id', value: patient.hid }), 409,
    'ORDER_ROUTE_NOT_PENDING');
  const fullDetail = expectStatus(await call(lab, labAdmin, 'GET', `/lab/order-routes/${route1.id}`), 200, 'route detail');
  assert.deepEqual([fullDetail.clinicalInformation, fullDetail.patient?.healthIdLast4, fullDetail.workItemId],
    [clinicalNote, patient.hid.slice(-4), accepted.workItemId]);
  assert.deepEqual(await all(`select facility_id, patient_id from audit.events where action='ehr.order-route.accepted'
    and resource_id=$1`, [route1.id]), [{ facility_id: hospital.facilityId, patient_id: patient.id }]);
  assert.deepEqual(await all(`select outcome, patient_id from audit.events where action='lab.order-route.accept'
    and resource_id=$1 order by occurred_at, sequence_id`, [route1.id]),
  [{ outcome: 'denied', patient_id: null }, { outcome: 'denied', patient_id: null },
    { outcome: 'success', patient_id: patient.id }, { outcome: 'success', patient_id: patient.id }]);
  evidence.receive = { wrongDateOfBirthAlone: { status: 409, attemptsLeft: 5 },
    wrongDateOfBirthWithReference: { status: 409, attemptsLeft: 4 }, otherReference: 'ORDER_ROUTE_REFERENCE_MISMATCH',
    findByHealthId: 'POST search (body)', healthIdInGetUrl: labUrlRefusal,
    invalidDate: 400, accepted: { status: 201, patient: 'name, sex, date of birth, Health ID last 4',
      clinicalInformation: 'after acceptance', licenceNumber: 'after acceptance' }, replay: 'same work item',
    acceptedAgain: 'ORDER_ROUTE_NOT_PENDING', audit: { mismatch: 'denied, no patient', accepted: 'with the patient' } };
  step('accept: the right Health ID or date of birth, a work item bound to the route');

  // ── A second laboratory member, invited through P4b; no consent grant for the patient ──
  let invitations = 0;
  const invited = async (admin, host, facilityId, person) => {
    invitations += 1;
    const before = invitationEmails.length;
    const answer = expectStatus(await call(identity, admin, 'POST', '/identity/staff-invitations',
      { ...person, attested: true, currentPassword: password }, { key: freshKey('invite') }), 201, `invite ${person.email}`);
    assert.equal(answer.deliveryOutcome, 'accepted');
    const sentEmail = invitationEmails[before];
    assert(sentEmail, 'invitation email');
    const opened = expectStatus(await http(identity, 'POST', '/identity/staff-invitations/open', { origin: appOrigin,
      forwardedFor: `198.51.150.${invitations}`, body: { invitationId: sentEmail.invitationId, token: sentEmail.token,
        turnstileAction: 'staff-invitation' } }), 200, 'open invitation');
    assert.equal(opened.accountCase, 'new');
    const response = await http(identity, 'POST', '/identity/staff-invitations/open', { origin: appOrigin,
      forwardedFor: `198.51.151.${invitations}`, body: { invitationId: sentEmail.invitationId, token: sentEmail.token,
        turnstileAction: 'staff-invitation' } });
    const invitationCookie = response.cookies.find(value => value.startsWith('hid_staff_invitation='));
    expectStatus(await http(identity, 'POST', '/identity/staff-invitations/accept', { origin: appOrigin, cookie: invitationCookie,
      body: { password } }), 200, 'accept invitation');
    return signInStaff(person.email, host, facilityId, { name: person.name });
  };
  const labMember = await invited(labAdmin, HOSTS.lab, laboratory.facilityId, { name: 'Gbenga Labmember',
    email: synthetic('lab-member'), role: 'lab', licenceBody: 'MLSCN', licenceNumber: 'MLSCN/80011' });
  assert.equal((await one(`select count(*)::int n from identity.consent_grants grant_row
    join identity.staff_facility_memberships membership on membership.id = grant_row.membership_id
    where membership.account_id=$1`, [labMember.accountId])).n, 0, 'the invited member holds no consent grant');

  // ── 6b. Work at B under the route alone ──
  const labCall = (who, method, path, body, extra) => call(lab, who, method, `/lab${path}`, body, extra);
  const now = () => new Date().toISOString();
  const workList = expectStatus(await labCall(labMember, 'GET', '/work-items'), 200, 'work list');
  assert.deepEqual([workList.crossFacilityOrders, workList.crossFacilityWork], [true, true]);
  // Item 4: the accepted order is held here; none waits.
  assert.deepEqual([workList.receives, workList.routesHere], [true, { waiting: false, held: true }]);
  evidence.contractFields.atTheLaboratory = { incomingAfterSend: incoming.routesHere, workListAfterAcceptance: workList.routesHere };
  const routedItem = workList.items.find(item => item.id === accepted.workItemId);
  assert(routedItem, `work list: ${JSON.stringify(workList)}`);
  assert.equal('sourceEhrOrderId' in routedItem, false, 'a routed row must not carry the other facility\'s order id');
  // Item 3: the card carries the route's version as a number (the wrong-patient report's expectedVersion) and
  // endedKind, null while the route is live.
  assert.deepEqual(routedItem.orderRoute, { id: route1.id, reference: route1.reference, effectiveState: 'accepted',
    access: 'work', version: accepted.route.version, endedKind: null, orderingFacilityName: hospital.name,
    ordererName: hospital.administratorName, ordererLicence: { body: 'MDCN', number: 'MDCN/70011' } });
  assert.equal(typeof routedItem.orderRoute.version, 'number');
  assert.deepEqual(routedItem.patient, { fullName: patient.fullName, sex: patient.sex, dateOfBirth: patient.dob,
    healthIdLast4: patient.hid.slice(-4) });
  assertNone(routedItem, [patient.hid, lr1.id, encounter.id], 'routed work row');
  // The list showed the patient's identity, so it names the patient in the audit (ids only, basis order-route).
  const listRows = await all(`select patient_id, actor_account_id, resource_type, details from audit.events
    where action = 'lab.work-item.list' and facility_id = $1 and actor_account_id = $2`,
  [laboratory.facilityId, labMember.accountId]);
  assert.deepEqual(listRows.map(row => [row.patient_id, row.resource_type, row.details.basis, row.details.orderRouteIds]),
    [[patient.id, 'lab-work-item', 'order-route', [route1.id]]], JSON.stringify(listRows));
  assertNone(listRows, [patient.fullName, patient.dob, patient.hid], 'work-list audit');
  evidence.workListAudit = { rowsNamingThePatient: listRows.length, basis: 'order-route', idsOnly: true };
  expectStatus(await labCall(labMember, 'GET', `/work-items/${accepted.workItemId}`), 200, 'routed item');
  const accession = expectStatus(await labCall(labMember, 'POST', `/work-items/${accepted.workItemId}/accession`,
    { requirements: [{ specimenType: 'blood' }], reason: 'Synthetic accession of an order from another facility' },
  { key: freshKey('accession') }), 201, 'accession');
  let specimen = accession.specimens[0];
  specimen = expectStatus(await labCall(labMember, 'POST', `/accessions/${accession.id}/specimens/${specimen.id}/collect`,
    { expectedVersion: specimen.version, collectedAt: now() }, { key: freshKey('collect') }), 201, 'collect');
  specimen = expectStatus(await labCall(labMember, 'POST', `/accessions/${accession.id}/specimens/${specimen.id}/receive`,
    { expectedVersion: specimen.version, receivedAt: now() }, { key: freshKey('receive') }), 201, 'receive');
  let execution = expectStatus(await labCall(labMember, 'POST', `/specimens/${specimen.id}/executions`,
    { expectedSpecimenVersion: specimen.version, startedAt: now(), reason: 'Synthetic run of a routed order' },
  { key: freshKey('execution') }), 201, 'execution');
  execution = expectStatus(await labCall(labMember, 'POST', `/executions/${execution.id}/complete`,
    { expectedVersion: execution.version, completedAt: now() }, { key: freshKey('complete') }), 201, 'complete');
  const entered = expectStatus(await labCall(labMember, 'POST', `/executions/${execution.id}/results`,
    { expectedExecutionVersion: execution.version, resultType: 'numeric', numericValue: 6.8, unit: '%',
      referenceRange: '4.0-5.6', abnormalFlag: 'high' }, { key: freshKey('result') }), 201, 'result');
  const resultId = entered.id ?? entered.result?.id;
  assert(resultId, `result answer: ${JSON.stringify(entered)}`);
  expectStatus(await labCall(labAdmin, 'POST', `/results/${resultId}/verify`, { expectedResultVersion: 1, occurredAt: now(),
    reason: 'Verified by a second laboratory member' }, { key: freshKey('verify') }), 201, 'verify');
  expectStatus(await labCall(labAdmin, 'POST', `/results/${resultId}/release`, { expectedResultVersion: 1, occurredAt: now(),
    reason: 'Released to the ordering facility' }, { key: freshKey('release') }), 201, 'release');
  // Each row's route: orderRouteId on a command's row, orderRouteIds on the work list's row naming the patient.
  const basisRows = await all(`select action, details->>'basis' as basis,
      coalesce(details->>'orderRouteId', case when jsonb_array_length(details->'orderRouteIds') = 1
        then details->'orderRouteIds'->>0 end) as route_id
    from audit.events where actor_account_id=$1 and facility_id=$2 and action like 'lab.%' and action not like 'lab.order-route.%'
    order by sequence_id`, [labMember.accountId, laboratory.facilityId]);
  assert(basisRows.length >= 5 && basisRows.every(row => row.basis === 'order-route' && row.route_id === route1.id),
    `basis rows: ${JSON.stringify(basisRows)}`);
  evidence.work = { member: 'invited lab, no consent grant', workList: { card: 'route, access work, orderer licence',
    patient: 'name, sex, date of birth, Health ID last 4', sourceEhrOrderId: 'absent' },
  chain: ['accession', 'collect', 'receive', 'execution', 'complete', 'result', 'verify (administrator)', 'release (administrator)'],
  auditBasis: `order-route on ${basisRows.length} rows` };
  step('B works the order under the route alone, by a member without a consent grant');

  // ── 6c. Never beyond the order: another row of the same patient at B is not opened by the route ──
  const ownItem = randomUUID();
  await owner.query('set session_replication_role = replica');
  try {
    await owner.query(`insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
        source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
        clinical_indication, requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key,
        request_sha256, correlation_id)
      select $1, item.patient_id, item.facility_id, item.facility_id, gen_random_uuid(), 1, gen_random_uuid(), 'accepted',
        'routine', 'http://loinc.org', '2345-7', 'Synthetic own glucose test', null, item.accepted_by, clock_timestamp(),
        item.accepted_by, item.accepted_by_membership_id, $3, repeat('a', 64), item.correlation_id
        from lab.work_items item where item.id=$2`, [ownItem, accepted.workItemId, `verifier-own-${ownItem}`]);
  } finally {
    await owner.query('set session_replication_role = origin');
  }
  const ownList = expectStatus(await labCall(labMember, 'GET', '/work-items'), 200, 'work list');
  assert(!ownList.items.some(item => item.id === ownItem), 'a same-patient row without a route is listed to a member without consent');
  const refused = response => [403, 404].includes(response.status);
  const ownRead = await labCall(labMember, 'GET', `/work-items/${ownItem}`);
  assert(refused(ownRead), `own item read: ${JSON.stringify(ownRead.body)}`);
  const ownAccession = await labCall(labMember, 'POST', `/work-items/${ownItem}/accession`,
    { requirements: [{ specimenType: 'blood' }], reason: 'Synthetic attempt beyond the order' }, { key: freshKey('accession') });
  assert(refused(ownAccession), `own item accession: ${JSON.stringify(ownAccession.body)}`);
  // With the patient's consent the administrator works it; the member still cannot reach its chain.
  await approvedAccess(labAdmin, 'write_records');
  const ownByAdmin = expectStatus(await labCall(labAdmin, 'POST', `/work-items/${ownItem}/accession`,
    { requirements: [{ specimenType: 'blood' }], reason: 'Synthetic own accession under consent' }, { key: freshKey('accession') }),
  201, 'own accession under consent');
  const ownSpecimen = ownByAdmin.specimens[0];
  const answer = response => `${response.status} ${response.body?.code ?? ''}`.trim();
  const beyondResponses = {
    workItem: ownRead, accession: ownAccession,
    accessionRead: await labCall(labMember, 'GET', `/accessions/${ownByAdmin.id}`),
    specimens: await labCall(labMember, 'GET', `/accessions/${ownByAdmin.id}/specimens`),
    collect: await labCall(labMember, 'POST', `/accessions/${ownByAdmin.id}/specimens/${ownSpecimen.id}/collect`,
      { expectedVersion: ownSpecimen.version, collectedAt: now() }, { key: freshKey('collect') }),
    executions: await labCall(labMember, 'GET', `/specimens/${ownSpecimen.id}/executions`),
  };
  for (const [name, response] of Object.entries(beyondResponses)) assert(refused(response), `${name}: ${answer(response)}`);
  const beyond = Object.fromEntries(Object.entries(beyondResponses).map(([name, response]) => [name, answer(response)]));
  assert.equal((await one('select status from lab.specimens where id=$1', [ownSpecimen.id])).status, 'required',
    'the refused collect changed the specimen');
  // The laboratory reads nothing of the ordering facility's record.
  const labReadsEhr = await call(ehr, labAdmin, 'GET', `/ehr/patients/${patient.id}${enc}/lab-requests/${lr1.id}`);
  assert([403, 404].includes(labReadsEhr.status), `B read A's lab request: ${labReadsEhr.status}`);
  evidence.beyondTheOrder = { ...beyond, listedToMember: false, ehrRecordOfA: labReadsEhr.status };
  step('a receiver never reaches another row of the patient, nor the ordering facility\'s record');

  // ── 7. The result comes back to the ordering record ──
  const routeViews = expectStatus(await ehrCall(doctor, 'GET', routesPath('lab_request', lr1.id)), 200, 'order routes');
  const view = routeViews.items[0];
  assert.equal(view.effectiveState, 'completed');
  assert.deepEqual(view.results.map(item => [item.kind, Number(item.numericValue), item.unit, item.abnormalFlag,
    item.referenceRange, item.test.code]), [['released', 6.8, '%', 'high', '4.0-5.6', labTest.testCode]]);
  assert.deepEqual(view.attestation, { textVersion: labVersion, attestedByName: hospital.administratorName,
    attestedAt: route1.createdAt, receivingFacilityName: laboratory.name });
  assert.deepEqual(view.events.map(event => event.type), ['created', 'accepted', 'completed']);
  assertNone(view, [labMember.name, 'Gbenga', labMember.accountId], 'the ordering view');
  const windows = await one(`select (writes_end_at = access_ends_at) as same, access_ends_at = least(completed_at + interval '14 days',
      accepted_at + interval '45 days') as shortened from ehr.order_routes where id=$1`, [route1.id]);
  assert.deepEqual(windows, { same: true, shortened: true });
  const returnedAudit = await all(`select facility_id, patient_id from audit.events where action='ehr.order-route.result-returned'
    and resource_id=$1`, [route1.id]);
  assert.deepEqual(returnedAudit, [{ facility_id: hospital.facilityId, patient_id: patient.id }]);
  const releasedHere = await call(lab, doctor, 'GET', `/lab/ehr-orders/${lr1.id}/released-results`);
  assert.equal(releasedHere.status, 404, `released results at A: ${releasedHere.status}`);
  const thirdView = await call(ehr, thirdDoctor, 'GET', `/ehr/patients/${patient.id}${routesPath('lab_request', lr1.id)}`);
  assert([403, 404].includes(thirdView.status), `third facility: ${thirdView.status}`);
  const labViewsRoutes = await call(ehr, labAdmin, 'GET', `/ehr/patients/${patient.id}${routesPath('lab_request', lr1.id)}`);
  assert([403, 404].includes(labViewsRoutes.status), `B reads A's routes: ${labViewsRoutes.status}`);
  evidence.returned = { ordering: { state: 'completed', results: 1, attestation: true, events: ['created', 'accepted', 'completed'] },
    windows: 'least(completed + 14 days, accepted + 45 days)', auditAtA: 'result-returned with the patient',
    sameFacilityReleasedResults: 404, thirdFacility: thirdView.status, receiverReadsOrderingRoutes: labViewsRoutes.status };
  step('the result comes back to the ordering record; no one else reads it');

  // ── 8. Prescriptions ──
  const prescriptionVersion = expectStatus(await call(ehr, doctor, 'GET', '/ehr/order-route-attestation?kind=prescription'), 200,
    'prescription attestation').version;
  assert.equal(prescriptionVersion, 'order-route-prescription-attestation-v1');
  const pharmacyCall = (who, method, path, body, extra) => call(pharmacy, who, method, `/pharmacy${path}`, body, extra);
  const sendPrescription = async rx => expectStatus(await send(doctor, 'prescription', rx, pharmacyFacility.facilityId,
    prescriptionVersion), 201, 'send prescription').route;
  const acceptPrescription = (routeId, version, identifier) => accept(pharmacist, pharmacy, routeId, version, identifier,
    { body: { reason: 'Synthetic acceptance with the patient at the counter' } });
  const rx1 = await newPrescription('active');
  const rxRoute1 = await sendPrescription(rx1);
  const rxIncoming = expectStatus(await pharmacyCall(pharmacist, 'GET', '/order-routes?view=incoming'), 200, 'pharmacy incoming');
  const pharmacyUrlRefusal = await refusedInUrl(extra => pharmacyCall(pharmacist, 'GET',
    `/order-routes?view=incoming&healthId=${patient.hid}`, undefined, extra), 'pharmacy/order-routes/search',
  'Pharmacy GET with a Health ID');
  assert.deepEqual([rxIncoming.receives, rxIncoming.routesHere], [true, { waiting: true, held: false }]);
  const rxPreview = rxIncoming.items.find(item => item.id === rxRoute1.id);
  assert.deepEqual(rxPreview.medication, { codeSystem: medicine.medicationCodeSystem, code: medicine.medicationCode,
    display: medicine.medicationDisplay });
  assertNone(rxIncoming, [...identityValues, medicine.instructions, 'MDCN/70011', rx1.id, encounter.id], 'pharmacy Incoming');
  expectProblem(await accept(pharmacist, pharmacy, rxRoute1.id, 1, { kind: 'date_of_birth', value: patient.dob }), 400,
    'VALIDATION_FAILED', 'a pharmacy acceptance without its reason');
  const rxAccepted = expectStatus(await acceptPrescription(rxRoute1.id, 1, { kind: 'date_of_birth', value: patient.dob }), 201,
    'pharmacy accept');
  assert.deepEqual([rxAccepted.instructions, rxAccepted.patient.healthIdLast4], [medicine.instructions, patient.hid.slice(-4)]);
  const rxWorkList = expectStatus(await pharmacyCall(pharmacist, 'GET', '/work-items'), 200, 'pharmacy work list');
  assert.deepEqual([rxWorkList.receives, rxWorkList.routesHere], [true, { waiting: false, held: true }]);
  evidence.contractFields.atThePharmacy = { incomingAfterSend: rxIncoming.routesHere, workListAfterAcceptance: rxWorkList.routesHere };
  const rxItem = expectStatus(await pharmacyCall(pharmacist, 'GET', `/work-items/${rxAccepted.workItemId}`), 200, 'rx item');
  assert.equal(rxItem.orderRoute.access, 'work');
  assert.equal('sourceEhrPrescriptionId' in rxItem || 'sourceEncounterId' in rxItem, false);
  // The doctor changes the prescription after acceptance: the route is cancelled, dispensing refused, reads kept 7 days.
  const rxNow = expectStatus(await ehrCall(doctor, 'GET', `${enc}/prescriptions/${rx1.id}`), 200, 'rx read');
  assert.equal(rxNow.orderRoute.effectiveState, 'accepted');
  expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rx1.id}`, { expectedRowVersion: Number(rxNow.rowVersion),
    changeReason: 'Synthetic change of frequency', frequency: 'once daily' }), 200, 'rx change');
  const rxAfterChange = expectStatus(await ehrCall(doctor, 'GET', routesPath('prescription', rx1.id)), 200, 'rx routes').items[0];
  assert.deepEqual([rxAfterChange.effectiveState, rxAfterChange.endedKind], ['cancelled', 'order_changed']);
  const rxRefused = await pharmacyCall(pharmacist, 'POST', `/work-items/${rxAccepted.workItemId}/dispensings`,
    { expectedWorkItemVersion: Number(rxItem.version), quantityDispensed: 60, quantityUnit: 'tablet',
      reason: 'Synthetic dispensing at the counter' }, { key: freshKey('dispense') });
  assert.equal(rxRefused.status, 409, `dispensing a cancelled route: ${JSON.stringify(rxRefused.body)}`);
  assert(['ORDER_ROUTE_CLOSED', 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE'].includes(rxRefused.body.code), rxRefused.body.code);
  const rxCancelledRead = expectStatus(await pharmacyCall(pharmacist, 'GET', `/work-items/${rxAccepted.workItemId}`), 200,
    'cancelled read');
  assert.deepEqual([rxCancelledRead.orderRoute.effectiveState, rxCancelledRead.orderRoute.access], ['cancelled', 'read']);
  const cancelledWindow = await one(`select writes_end_at <= clock_timestamp() as writes_closed,
      access_ends_at between clock_timestamp() + interval '6 days 23 hours' and clock_timestamp() + interval '7 days' as reads_7_days
    from ehr.order_routes where id=$1`, [rxRoute1.id]);
  assert.deepEqual(cancelledWindow, { writes_closed: true, reads_7_days: true });
  // A second prescription: accepted, dispensed and reversed; both come back.
  const rx2 = await newPrescription('active');
  const rxRoute2 = await sendPrescription(rx2);
  const rx2Accepted = expectStatus(await acceptPrescription(rxRoute2.id, 1, { kind: 'health_id', value: patient.hid }), 201,
    'accept rx2');
  const rx2Item = expectStatus(await pharmacyCall(pharmacist, 'GET', `/work-items/${rx2Accepted.workItemId}`), 200, 'rx2 item');
  const dispensed = expectStatus(await pharmacyCall(pharmacist, 'POST', `/work-items/${rx2Accepted.workItemId}/dispensings`,
    { expectedWorkItemVersion: Number(rx2Item.version), quantityDispensed: 60, quantityUnit: 'tablet',
      reason: 'Synthetic dispensing at the counter' }, { key: freshKey('dispense') }), 201, 'dispense');
  const reversed = expectStatus(await pharmacyCall(pharmacist, 'POST', `/dispensings/${dispensed.id}/reversals`,
    { expectedDispensingVersion: Number(dispensed.version), reason: 'Synthetic reversal: wrong strength handed over' },
  { key: freshKey('reverse') }), 201, 'reverse');
  assert(reversed);
  const rx2View = expectStatus(await ehrCall(doctor, 'GET', routesPath('prescription', rx2.id)), 200, 'rx2 routes').items[0];
  assert.equal(rx2View.effectiveState, 'completed');
  assert.deepEqual(rx2View.dispensings.map(item => [item.kind, Number(item.quantityDispensed), item.quantityUnit,
    item.medication.display]), [['dispensed', 60, 'tablet', medicine.medicationDisplay],
    ['reversed', 60, 'tablet', medicine.medicationDisplay]]);
  // Same-facility pull of a routed prescription is refused (the pharmacist role holds the permission).
  evidence.prescriptions = { preview: 'medicine, no patient or instructions', healthIdInGetUrl: pharmacyUrlRefusal,
    acceptNeedsReason: 400,
    accepted: 'date of birth; instructions after acceptance', changedAfterAcceptance: 'cancelled (order_changed)',
    dispensingAfterCancel: `409 ${rxRefused.body.code}`, readsKept: '7 days, access read', dispensedAndReversed: 'both reports',
    completed: true };
  const bothKinds = expectStatus(await patientCall(ehr, 'GET', '/ehr/me/order-routes'), 200, 'my routes').items;
  assert.deepEqual([...new Set(bothKinds.map(item => item.kind))].sort(), ['lab_request', 'prescription']);
  const rxMine = bothKinds.find(item => item.id === rxRoute2.id);
  assert.deepEqual([rxMine.receivingFacilityName, rxMine.attestationTextVersion, rxMine.content.medicationDisplay,
    rxMine.content.instructions], [pharmacyFacility.name, prescriptionVersion, medicine.medicationDisplay, medicine.instructions]);
  const sentNotices = expectStatus(await patientCall(identity, 'GET', '/identity/me/notifications?limit=100'), 200, 'inbox')
    .filter(item => item.notificationCode === 'ORDER_ROUTE_SENT').map(item => item.metadata.kind);
  assert(sentNotices.includes('lab_request') && sentNotices.includes('prescription'), 'the inbox lacks a kind');
  evidence.prescriptions.patientSeesBoth = { list: ['lab_request', 'prescription'], inbox: 'ORDER_ROUTE_SENT for each' };
  step('prescriptions: accepted, changed (cancelled, not dispensable), dispensed and reversed back to the ordering record');

  // ── 9. Decline, withdraw (a doctor with no consent), the patient's Stop, expiry, the lock ──
  const lr2 = await newLabRequest();
  const route2 = expectStatus(await send(doctor, 'lab_request', lr2, laboratory.facilityId, labVersion), 201, 'send lr2').route;
  expectStatus(await labCall(labAdmin, 'POST', `/order-routes/${route2.id}/decline`,
    { expectedVersion: 1, reason: 'test_not_offered' }), 200, 'decline');
  const declinedView = expectStatus(await ehrCall(doctor, 'GET', routesPath('lab_request', lr2.id)), 200, 'declined').items[0];
  assert.deepEqual([declinedView.effectiveState, declinedView.declineReason, declinedView.resendAllowed],
    ['declined', 'test_not_offered', true]);
  const route2b = expectStatus(await send(doctor, 'lab_request', { ...lr2, rowVersion: 2 }, laboratory.facilityId, labVersion),
    201, 'resend after decline').route;
  // A second doctor at the hospital, invited through P4b, holds no consent grant for the patient.
  const secondDoctor = await invited(doctor, HOSTS.ehr, hospital.facilityId, { name: 'Ibrahim Second', email: synthetic('doctor-2'),
    role: 'doctor', licenceBody: 'MDCN', licenceNumber: 'MDCN/80022' });
  const lr3 = await newLabRequest();
  const route3 = expectStatus(await send(doctor, 'lab_request', lr3, laboratory.facilityId, labVersion), 201, 'send lr3').route;
  expectProblem(await call(ehr, secondDoctor, 'GET', `/ehr/patients/${patient.id}${routesPath('lab_request', lr3.id)}`), 403,
    'CONSENT_REQUIRED');
  const otherPatientPath = `/ehr/patients/${otherPatient.id}${routesPath('lab_request', lr3.id)}/${route3.id}/withdraw`;
  expectProblem(await call(ehr, secondDoctor, 'POST', otherPatientPath, { expectedVersion: 1, reason: 'sent_in_error' }), 404,
    'ORDER_ROUTE_NOT_FOUND');
  assert.equal((await one('select state from ehr.order_routes where id=$1', [route3.id])).state, 'sent',
    'a withdrawal naming another patient changed the route');
  const withdrawn = expectStatus(await call(ehr, secondDoctor, 'POST',
    `/ehr/patients/${patient.id}${routesPath('lab_request', lr3.id)}/${route3.id}/withdraw`,
    { expectedVersion: 1, reason: 'sent_in_error' }), 200, 'withdraw');
  assert.deepEqual([withdrawn.route.effectiveState, withdrawn.route.endedKind], ['withdrawn', 'orderer']);
  assert.deepEqual(await all(`select patient_id from audit.events where action='ehr.order-route.withdraw' and resource_id=$1`,
    [route3.id]), [{ patient_id: patient.id }]);
  // The patient stops one before acceptance.
  const lr4 = await newLabRequest();
  const route4 = expectStatus(await send(doctor, 'lab_request', lr4, laboratory.facilityId, labVersion), 201, 'send lr4').route;
  const otherLogin = await http(identity, 'POST', '/auth/patient/login', { origin: appOrigin,
    body: { email: otherPatient.email, password, turnstileAction: 'patient-login' } });
  expectStatus(otherLogin, 200, 'other patient sign-in');
  expectProblem(await http(ehr, 'POST', `/ehr/me/order-routes/${route4.id}/withdraw`, { cookie: otherLogin.cookies.join('; '),
    origin: appOrigin, csrf: otherLogin.headers.get('x-csrf-token'), body: { expectedVersion: 1 } }), 404,
  'ORDER_ROUTE_NOT_FOUND', 'another patient\'s Stop');
  assert.deepEqual(expectStatus(await http(ehr, 'GET', '/ehr/me/order-routes', { cookie: otherLogin.cookies.join('; ') }), 200,
    'other patient list').items, [], 'another patient sees these orders');
  const stopped = expectStatus(await patientCall(ehr, 'POST', `/ehr/me/order-routes/${route4.id}/withdraw`, { expectedVersion: 1 }),
    200, 'Stop');
  assert.deepEqual([stopped.route.effectiveState, stopped.route.actions], ['withdrawn', []]);
  expectProblem(await patientCall(ehr, 'POST', `/ehr/me/order-routes/${route4.id}/withdraw`, { expectedVersion: 2 }), 409,
    'ORDER_ROUTE_NOT_PENDING');
  expectProblem(await accept(labAdmin, lab, route4.id, 2, { kind: 'health_id', value: patient.hid }), 409, 'ORDER_ROUTE_NOT_PENDING');
  expectProblem(await patientCall(ehr, 'POST', `/ehr/me/order-routes/${route1.id}/withdraw`, { expectedVersion: 3 }), 409,
    'ORDER_ROUTE_NOT_PENDING');
  assert.equal(expectStatus(await ehrCall(doctor, 'GET', routesPath('lab_request', lr4.id)), 200, 'stopped').items[0].endedKind,
    'patient');
  // Expiry: owner SQL moves a sent route 8 days back (the services' clock cannot be moved).
  const lr5 = await newLabRequest();
  const route5 = expectStatus(await send(doctor, 'lab_request', lr5, laboratory.facilityId, labVersion), 201, 'send lr5').route;
  const age = async (sql, values) => {
    await owner.query('set session_replication_role = replica');
    try { await owner.query(sql, values); } finally { await owner.query('set session_replication_role = origin'); }
  };
  await age(`update ehr.order_routes set created_at = created_at - interval '8 days', respond_by = respond_by - interval '8 days'
    where id=$1`, [route5.id]);
  assert(!expectStatus(await labCall(labAdmin, 'GET', '/order-routes?view=incoming'), 200, 'incoming').items
    .some(item => item.id === route5.id), 'an expired route is still in Incoming');
  expectProblem(await accept(labAdmin, lab, route5.id, 1, { kind: 'health_id', value: patient.hid }), 409, 'ORDER_ROUTE_EXPIRED');
  const myExpired = expectStatus(await patientCall(ehr, 'GET', '/ehr/me/order-routes'), 200, 'my routes').items
    .find(item => item.id === route5.id);
  assert.deepEqual([myExpired.effectiveState, myExpired.actions], ['expired', []]);
  const expiredView = expectStatus(await ehrCall(doctor, 'GET', routesPath('lab_request', lr5.id)), 200, 'expired').items[0];
  assert.deepEqual([expiredView.effectiveState, expiredView.resendAllowed], ['expired', true]);
  // Five wrong tries that name the order (a date of birth with its reference) lock that order there.
  const lr6 = await newLabRequest();
  const route6 = expectStatus(await send(doctor, 'lab_request', lr6, laboratory.facilityId, labVersion), 201, 'send lr6').route;
  const countdown = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const wrong = await accept(labAdmin, lab, route6.id, 1, { kind: 'date_of_birth', value: `1991-01-0${attempt}` },
      { body: { reference: route6.reference } });
    assert.equal(wrong.status, 409);
    countdown.push(`${wrong.body.code}:${wrong.body.attemptsLeft}`);
  }
  assert.deepEqual(countdown, ['ORDER_ROUTE_PATIENT_MISMATCH:4', 'ORDER_ROUTE_PATIENT_MISMATCH:3', 'ORDER_ROUTE_PATIENT_MISMATCH:2',
    'ORDER_ROUTE_PATIENT_MISMATCH:1', 'ORDER_ROUTE_ACCEPT_LOCKED:0']);
  expectProblem(await accept(labAdmin, lab, route6.id, 2, { kind: 'health_id', value: patient.hid }), 409,
    'ORDER_ROUTE_ACCEPT_LOCKED');
  const lockedView = expectStatus(await ehrCall(doctor, 'GET', routesPath('lab_request', lr6.id)), 200, 'locked').items[0];
  assert.deepEqual([lockedView.effectiveState, lockedView.acceptLocked], ['sent', true]);
  assert.deepEqual(await all(`select facility_id, patient_id from audit.events where action='ehr.order-route.accept-locked'
    and resource_id=$1`, [route6.id]), [{ facility_id: hospital.facilityId, patient_id: patient.id }]);
  // The patient's deny directive is checked again at acceptance (SPEC-FINAL P15.1): one naming the laboratory,
  // written after the send (owner SQL; no route writes directives), refuses the acceptance and writes nothing;
  // a superseding inactive version ends it (directives are append-only).
  const lrDeny = await newLabRequest();
  const routeDeny = expectStatus(await send(doctor, 'lab_request', lrDeny, laboratory.facilityId, labVersion), 201, 'send lrDeny').route;
  const directive = randomUUID();
  // One statement each (the directive's current-version key is checked at the statement's end).
  await owner.query(`with directive as (insert into identity.consent_directives (id, patient_id, current_version)
      values ($2, $3, 1) returning id)
    insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status,
      provision_type, grantee_type, grantee_id, starts_at, source_reference, reason, content_sha256)
    select $1, directive.id, $3, 1, 'active', 'deny', 'facility', $4, clock_timestamp() - interval '1 minute',
      'order-route-verifier', 'The patient asked not to use this laboratory', repeat('5', 64) from directive`,
  [randomUUID(), directive, patient.id, laboratory.facilityId]);
  expectProblem(await accept(labAdmin, lab, routeDeny.id, 1, { kind: 'health_id', value: patient.hid }), 409,
    'ORDER_ROUTE_PATIENT_DENIED');
  assert.deepEqual(await one(`select route.state, route.row_version::int as version,
      (select count(*)::int from ehr.order_route_accept_attempts attempt where attempt.route_id = route.id) as attempts
    from ehr.order_routes route where route.id = $1`, [routeDeny.id]), { state: 'sent', version: 1, attempts: 0 });
  await owner.query(`with superseding as (insert into identity.consent_directive_versions (id, directive_id, patient_id,
      version_no, status, provision_type, grantee_type, grantee_id, starts_at, source_reference, reason, content_sha256,
      supersedes_version)
    values ($1, $2, $3, 2, 'inactive', 'deny', 'facility', $4, clock_timestamp() - interval '1 minute', 'order-route-verifier',
      'The patient lifted the refusal', repeat('6', 64), 1) returning directive_id)
    update identity.consent_directives set current_version = 2 where id = (select directive_id from superseding)`,
  [randomUUID(), directive, patient.id, laboratory.facilityId]);
  expectStatus(await ehrCall(doctor, 'POST', `${routesPath('lab_request', lrDeny.id)}/${routeDeny.id}/withdraw`,
    { expectedVersion: 1, reason: 'sent_in_error' }), 200, 'withdraw the refused route');
  // An order marked entered in error (it may be another patient's): the patient keeps the route as the record of
  // what went where, without its content, the attestation text or the attesting clinician.
  const lrError = await newLabRequest();
  const routeError = expectStatus(await send(doctor, 'lab_request', lrError, laboratory.facilityId, labVersion), 201,
    'send lrError').route;
  const lrErrorNow = await one('select row_version::int as version from ehr.lab_requests where id = $1', [lrError.id]);
  expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/lab-requests/${lrError.id}`, { expectedRowVersion: lrErrorNow.version,
    changeReason: 'Written in the wrong patient\'s chart', status: 'entered_in_error' }), 200, 'entered in error');
  const myError = expectStatus(await patientCall(ehr, 'GET', '/ehr/me/order-routes'), 200, 'my routes').items
    .find(item => item.id === routeError.id);
  assert.deepEqual([myError.effectiveState, myError.endedKind, myError.enteredInError, myError.attestationText,
    myError.attestedByName, myError.actions], ['withdrawn', 'entered_in_error', true, null, null, []], JSON.stringify(myError));
  assert(Object.values(myError.content).every(value => value === null), JSON.stringify(myError.content));
  assertNone(myError, [clinicalNote, hospital.administratorName, 'MDCN/70011'], 'entered-in-error route');
  assert(expectStatus(await patientCall(ehr, 'GET', '/ehr/me/order-routes'), 200, 'my routes').items
    .filter(item => item.id !== routeError.id).every(item => item.enteredInError === false), 'only that route is redacted');
  evidence.directiveAtAcceptance = { refused: 'ORDER_ROUTE_PATIENT_DENIED', written: 'nothing' };
  evidence.enteredInError = { patientSees: 'reference, state and facilities only', enteredInError: true };
  const codes = expectStatus(await patientCall(identity, 'GET', '/identity/me/notifications?limit=100'), 200, 'inbox')
    .map(item => item.notificationCode);
  for (const code of ['ORDER_ROUTE_SENT', 'ORDER_ROUTE_ACCEPTED', 'ORDER_ROUTE_DECLINED', 'ORDER_ROUTE_WITHDRAWN',
    'ORDER_ROUTE_ACCEPT_LOCKED', 'ORDER_ROUTE_CANCELLED']) assert(codes.includes(code), `inbox lacks ${code}`);
  evidence.lifecycle = { declined: { reason: 'test_not_offered', resendAllowed: true, resent: 'sent' },
    withdrawByDoctorWithoutConsent: { routesRead: 'CONSENT_REQUIRED', withdraw: 200, endedKind: 'orderer',
      anotherPatientInPath: '404, nothing changed', auditPatient: 'the route\'s' },
    patientStop: { anotherPatient: 404, anotherPatientsList: 'empty', status: 200, again: 'ORDER_ROUTE_NOT_PENDING', acceptAfter: 'ORDER_ROUTE_NOT_PENDING',
      afterAcceptance: 'ORDER_ROUTE_NOT_PENDING' },
    expiry: { incoming: 'gone', accept: 'ORDER_ROUTE_EXPIRED', patient: 'expired, no Stop', resendAllowed: true },
    lock: { countdown, afterLock: 'ORDER_ROUTE_ACCEPT_LOCKED', orderingView: 'acceptLocked', auditAtA: true },
    inbox: ['SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'ACCEPT_LOCKED', 'CANCELLED'] };
  step('decline, withdraw without consent, the patient\'s Stop, expiry, the five-try lock, a directive at acceptance and an order entered in error');

  // ── 9b. Windows close access ──
  await age(`update ehr.order_routes set writes_end_at = clock_timestamp() - interval '1 minute',
      access_ends_at = clock_timestamp() - interval '1 minute' where id=$1`, [route1.id]);
  const afterWindow = expectStatus(await labCall(labMember, 'GET', '/work-items'), 200, 'work list after the window');
  assert(!afterWindow.items.some(item => item.id === accepted.workItemId), 'the routed item is still listed after its window');
  const afterWindowRead = await labCall(labMember, 'GET', `/work-items/${accepted.workItemId}`);
  assert([403, 404].includes(afterWindowRead.status), `read after the window: ${afterWindowRead.status}`);
  const afterWindowAccession = await labCall(labMember, 'GET', `/accessions/${accession.id}`);
  assert([403, 404].includes(afterWindowAccession.status), `accession after the window: ${afterWindowAccession.status}`);
  // The administrator, who now holds the patient's consent at B, still reads it on that basis; the card says the route is over.
  const adminAfter = expectStatus(await labCall(labAdmin, 'GET', '/work-items'), 200, 'administrator list').items
    .find(item => item.id === accepted.workItemId);
  assert.deepEqual([adminAfter.orderRoute.access, adminAfter.patient], ['none', undefined]);
  await age(`update ehr.order_routes set writes_end_at = least(writes_end_at, clock_timestamp() - interval '1 minute'),
      access_ends_at = least(writes_end_at, clock_timestamp() - interval '1 minute') where id=$1`, [rxRoute1.id]);
  const rxAfterWindow = await pharmacyCall(pharmacist, 'GET', `/work-items/${rxAccepted.workItemId}`);
  assert([403, 404].includes(rxAfterWindow.status), `cancelled route read after its 7 days: ${rxAfterWindow.status}`);
  evidence.windows = { completedRouteAfterWindow: { list: 'gone', item: afterWindowRead.status,
    accession: afterWindowAccession.status, consentHolder: 'reads on consent; card access none, no patient' },
  cancelledRouteAfterReads: rxAfterWindow.status };
  step('windows close access: after them only the patient\'s consent opens anything');

  // ── 10. The hospital's own Lab and Pharmacy: the same-facility paths ──
  const hospitalLab1 = await invited(doctor, HOSTS.lab, hospital.facilityId, { name: 'Kemi Hospitallab',
    email: synthetic('hospital-lab-1'), role: 'lab', licenceBody: 'MLSCN', licenceNumber: 'MLSCN/80033' });
  const hospitalLab2 = await invited(doctor, HOSTS.lab, hospital.facilityId, { name: 'Lanre Hospitallab',
    email: synthetic('hospital-lab-2'), role: 'lab', licenceBody: 'MLSCN', licenceNumber: 'MLSCN/80044' });
  const hospitalPharmacist = await invited(doctor, HOSTS.pharmacy, hospital.facilityId, { name: 'Musa Hospitalpharm',
    email: synthetic('hospital-pharmacist'), role: 'pharmacist', licenceBody: 'PCN', licenceNumber: 'PCN/80055' });
  for (const member of [hospitalLab1, hospitalLab2, hospitalPharmacist]) await approvedAccess(member, 'write_records');
  const lr7 = await newLabRequest('active');
  const handedOff = { labWorkItem: Boolean(lr7.labWorkItem), labHandoff: lr7.labHandoff };
  const ownLabList = expectStatus(await labCall(hospitalLab1, 'GET', '/work-items'), 200, 'hospital lab list');
  // Item 4: a hospital's own laboratory staff are told the hospital receives no lab requests from other facilities.
  assert.deepEqual([ownLabList.receives, ownLabList.routesHere], [false, { waiting: false, held: false }]);
  const ownLabItem = ownLabList.items.find(item => item.sourceEhrOrderId === lr7.id);
  assert(ownLabItem, `hand-off: ${JSON.stringify({ handedOff, items: ownLabList.items })}`);
  assert.equal(ownLabItem.orderRoute, undefined);
  assert.equal(ownLabItem.patient, undefined);
  let ownAcc = expectStatus(await labCall(hospitalLab1, 'POST', `/work-items/${ownLabItem.id}/accession`,
    { requirements: [{ specimenType: 'blood' }], reason: 'Synthetic same-facility accession' }, { key: freshKey('accession') }),
  201, 'same-facility accession');
  let ownSpec = ownAcc.specimens[0];
  ownSpec = expectStatus(await labCall(hospitalLab1, 'POST', `/accessions/${ownAcc.id}/specimens/${ownSpec.id}/collect`,
    { expectedVersion: ownSpec.version, collectedAt: now() }, { key: freshKey('collect') }), 201, 'collect');
  ownSpec = expectStatus(await labCall(hospitalLab1, 'POST', `/accessions/${ownAcc.id}/specimens/${ownSpec.id}/receive`,
    { expectedVersion: ownSpec.version, receivedAt: now() }, { key: freshKey('receive') }), 201, 'receive');
  let ownRun = expectStatus(await labCall(hospitalLab1, 'POST', `/specimens/${ownSpec.id}/executions`,
    { expectedSpecimenVersion: ownSpec.version, startedAt: now(), reason: 'Synthetic same-facility run' },
  { key: freshKey('execution') }), 201, 'execution');
  ownRun = expectStatus(await labCall(hospitalLab1, 'POST', `/executions/${ownRun.id}/complete`,
    { expectedVersion: ownRun.version, completedAt: now() }, { key: freshKey('complete') }), 201, 'complete');
  const ownResult = expectStatus(await labCall(hospitalLab1, 'POST', `/executions/${ownRun.id}/results`,
    { expectedExecutionVersion: ownRun.version, resultType: 'numeric', numericValue: 5.1, unit: '%', referenceRange: '4.0-5.6',
      abnormalFlag: 'normal' }, { key: freshKey('result') }), 201, 'result');
  expectStatus(await labCall(hospitalLab2, 'POST', `/results/${ownResult.id}/verify`, { expectedResultVersion: 1, occurredAt: now(),
    reason: 'Verified by a second laboratory member' }, { key: freshKey('verify') }), 201, 'verify');
  expectStatus(await labCall(hospitalLab2, 'POST', `/results/${ownResult.id}/release`, { expectedResultVersion: 1, occurredAt: now(),
    reason: 'Released to the ordering clinician' }, { key: freshKey('release') }), 201, 'release');
  const ownReleased = expectStatus(await call(lab, doctor, 'GET', `/lab/ehr-orders/${lr7.id}/released-results`), 200,
    'released results');
  assert.equal(JSON.stringify(ownReleased).includes('5.1'), true, `released results: ${JSON.stringify(ownReleased)}`);
  const ownBasis = await all(`select count(*)::int n, count(*) filter (where details ? 'basis')::int with_basis from audit.events
    where facility_id=$1 and actor_account_id = any($2::uuid[]) and action like 'lab.%'`,
  [hospital.facilityId, [hospitalLab1.accountId, hospitalLab2.accountId]]);
  assert(ownBasis[0].n >= 5 && ownBasis[0].with_basis === 0, `same-facility audit rows carry a route basis: ${JSON.stringify(ownBasis)}`);
  const lr7Row = expectStatus(await ehrCall(doctor, 'GET', `${enc}/lab-requests/${lr7.id}`), 200, 'lr7');
  assert.equal(lr7Row.orderRoute, null);
  // The pharmacist's pull of an unrouted prescription works; of a routed one, it is refused.
  const rx7 = await newPrescription('active');
  const pulled = expectStatus(await call(ehr, hospitalPharmacist, 'POST',
    `/ehr/patients/${patient.id}${enc}/prescriptions/${rx7.id}/pharmacy-work-item`,
    { expectedRowVersion: Number(rx7.rowVersion), reason: 'Synthetic same-facility hand-off' }, { key: freshKey('pull') }), 201,
  'same-facility pull');
  const pulledItemId = pulled.workItem?.id ?? pulled.pharmacyWorkItem?.id ?? pulled.id;
  const ownRxList = expectStatus(await pharmacyCall(hospitalPharmacist, 'GET', '/work-items'), 200, 'hospital pharmacy list');
  assert.deepEqual([ownRxList.receives, ownRxList.routesHere], [false, { waiting: false, held: false }]);
  evidence.contractFields.hospitalsOwnStaff = { lab: { receives: false }, pharmacy: { receives: false } };
  const ownRxItem = ownRxList.items.find(item => item.sourceEhrPrescriptionId === rx7.id);
  assert(ownRxItem, `pull: ${JSON.stringify(pulled)}`);
  assert.equal(ownRxItem.orderRoute, undefined);
  expectStatus(await pharmacyCall(hospitalPharmacist, 'POST', `/work-items/${ownRxItem.id}/dispensings`,
    { expectedWorkItemVersion: Number(ownRxItem.version), quantityDispensed: 30, quantityUnit: 'tablet',
      reason: 'Synthetic same-facility dispensing' }, { key: freshKey('dispense') }), 201, 'same-facility dispensing');
  const rx2Now = expectStatus(await ehrCall(doctor, 'GET', `${enc}/prescriptions/${rx2.id}`), 200, 'rx2');
  expectProblem(await call(ehr, hospitalPharmacist, 'POST', `/ehr/patients/${patient.id}${enc}/prescriptions/${rx2.id}/pharmacy-work-item`,
    { expectedRowVersion: Number(rx2Now.rowVersion), reason: 'Synthetic pull of a routed prescription' }, { key: freshKey('pull') }),
  409, 'PRESCRIPTION_ROUTED');
  // A routed lab request changed by its doctor is withdrawn there and never handed to this facility's Lab.
  const lr8 = await newLabRequest();
  const route8 = expectStatus(await send(doctor, 'lab_request', lr8, laboratory.facilityId, labVersion), 201, 'send lr8').route;
  const lr8Changed = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/lab-requests/${lr8.id}`, { expectedRowVersion: 2,
    changeReason: 'Synthetic change of priority', priority: 'urgent' }), 200, 'lr8 change');
  assert.deepEqual(lr8Changed.labHandoff, { state: 'not_sent', code: 'ORDER_ROUTED' });
  assert.deepEqual([lr8Changed.orderRoute.id, lr8Changed.orderRoute.effectiveState, lr8Changed.orderRoute.endedKind],
    [route8.id, 'withdrawn', 'order_changed']);
  assert(!(await labCall(hospitalLab1, 'GET', '/work-items')).body.items.some(item => item.sourceEhrOrderId === lr8.id),
    'a routed request reached this facility\'s Lab');
  evidence.sameFacility = { labHandOff: { ...handedOff, workItem: 'listed at the hospital, no route card, patient masked' },
    chain: 'accession to release under consent, no route basis in audit', releasedResultsAtA: 200, orderRoute: null,
    pharmacistPull: 201, dispensing: 201, routedPull: 'PRESCRIPTION_ROUTED', routedSendToLab: 'LAB_REQUEST_ROUTED',
    routedUpdate: { labHandoff: 'not_sent ORDER_ROUTED', route: 'withdrawn (order_changed)' } };
  step('same-facility paths: hand-off, Lab chain and release, pharmacist pull and dispensing as before; routed orders refused');

  // ── 11. The switches ──
  const rx4 = await newPrescription('active');
  const rxRoute4 = await sendPrescription(rx4);
  const rx4Accepted = expectStatus(await acceptPrescription(rxRoute4.id, 1, { kind: 'health_id', value: patient.hid }), 201,
    'accept rx4');
  const rx6 = await newPrescription('active');
  const rxRoute6 = await sendPrescription(rx6);
  await setControl('cross_facility_orders_enabled', false);
  const ordersOff = {
    send: expectProblem(await send(doctor, 'prescription', await newPrescription('active'), pharmacyFacility.facilityId,
      prescriptionVersion), 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE').code,
    directory: expectProblem(await search(doctor, 'pharmacy', 'Verifier Pharmacy'), 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE').code,
    accept: expectProblem(await acceptPrescription(rxRoute6.id, 1, { kind: 'health_id', value: patient.hid }), 423,
      'CROSS_FACILITY_ORDERS_UNAVAILABLE').code,
  };
  const pausedIncoming = expectStatus(await pharmacyCall(pharmacist, 'GET', '/order-routes?view=incoming'), 200, 'paused incoming');
  const pausedPreview = pausedIncoming.items.find(item => item.id === rxRoute6.id);
  assert.equal(pausedIncoming.crossFacilityOrders, false);
  assert(pausedPreview && pausedPreview.medication?.display == null && pausedPreview.orderer?.name == null,
    `metadata only while orders are off: ${JSON.stringify(pausedPreview)}`);
  const rx4Item = expectStatus(await pharmacyCall(pharmacist, 'GET', `/work-items/${rx4Accepted.workItemId}`), 200, 'rx4 item');
  expectStatus(await pharmacyCall(pharmacist, 'POST', `/work-items/${rx4Accepted.workItemId}/dispensings`,
    { expectedWorkItemVersion: Number(rx4Item.version), quantityDispensed: 30, quantityUnit: 'tablet',
      reason: 'Synthetic dispensing while sends are off' }, { key: freshKey('dispense') }), 201, 'accepted work goes on');
  ordersOff.acceptedWork = 'dispensed (201)';
  ordersOff.incoming = 'metadata only, crossFacilityOrders false';
  await setControl('cross_facility_route_access_enabled', false);
  const accessOff = {
    itemRead: expectProblem(await pharmacyCall(pharmacist, 'GET', `/work-items/${rx4Accepted.workItemId}`), 423,
      'CROSS_FACILITY_ORDERS_UNAVAILABLE').code,
    dispense: expectProblem(await pharmacyCall(pharmacist, 'POST', `/work-items/${rx4Accepted.workItemId}/dispensings`,
      { expectedWorkItemVersion: Number(rx4Item.version) + 1, quantityDispensed: 30, quantityUnit: 'tablet',
        reason: 'Synthetic dispensing while route access is off' }, { key: freshKey('dispense') }), 423,
    'CROSS_FACILITY_ORDERS_UNAVAILABLE').code,
    // A chain row (a dispensing) is found only through rows the session can read, so it is refused, not "paused".
    chainRead: answerOf(await pharmacyCall(pharmacist, 'GET', `/dispensings/${dispensed.id}`)),
    incoming: await pharmacyCall(pharmacist, 'GET', '/order-routes?view=incoming'),
  };
  // Item 4: Incoming answers 423 as before and says nothing more; the work list, which that switch never refuses, says
  // the pharmacy receives and holds accepted work (the paused notice), and that one order still waits.
  expectProblem(accessOff.incoming, 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE', 'incoming while route access is off');
  assert(!('receives' in accessOff.incoming.body) && !('routesHere' in accessOff.incoming.body), JSON.stringify(accessOff.incoming.body));
  accessOff.incoming = answerOf(accessOff.incoming);
  assert([403, 404].includes(Number(accessOff.chainRead.split(' ')[0])), `chain read while off: ${accessOff.chainRead}`);
  const pausedList = expectStatus(await pharmacyCall(pharmacist, 'GET', '/work-items'), 200, 'paused list');
  assert.equal(pausedList.crossFacilityWork, false);
  assert.deepEqual([pausedList.receives, pausedList.routesHere, pausedList.crossFacilityOrders],
    [true, { waiting: true, held: true }, false]);
  evidence.contractFields.routeAccessOff = { incoming: '423, no fields', workList: { receives: true,
    routesHere: pausedList.routesHere, crossFacilityWork: false } };
  assert(!pausedList.items.some(item => item.id === rx4Accepted.workItemId), 'a routed item is listed while route access is off');
  accessOff.list = 'routed rows hidden, crossFacilityWork false';
  accessOff.orderingView = expectStatus(await ehrCall(doctor, 'GET', routesPath('prescription', rx4.id)), 200, 'ordering view')
    .items[0].effectiveState;
  await setControl('cross_facility_route_access_enabled', true);
  await setControl('cross_facility_orders_enabled', true);
  expectStatus(await pharmacyCall(pharmacist, 'GET', `/work-items/${rx4Accepted.workItemId}`), 200, 'back on');
  evidence.switches = { ordersOff, routeAccessOff: accessOff, bothBackOn: 'work resumes' };
  step('switches: orders off stops sends and acceptance while accepted work goes on; route access off stops it all');

  // ── 12. Support: find and close; the directory's hourly budget ──
  const rx3 = await newPrescription('active');
  const rxRoute3 = await sendPrescription(rx3);
  const foundByReference = expectStatus(await adminCall('GET', `/admin/order-routes?reference=${rxRoute3.reference.toLowerCase()}`),
    200, 'find by reference');
  // Item 3: support's Close form may send support to the receiver first (an earlier Identity sends no such field).
  assert.equal(foundByReference.wrongPatientReports, true);
  const byReference = foundByReference.items;
  assert.deepEqual(byReference.map(item => [item.routeId, item.effectiveState, item.receivingFacilityName]),
    [[rxRoute3.id, 'sent', pharmacyFacility.name]]);
  assertNone(byReference, [...identityValues, ...clinicalOnly, medicine.medicationDisplay], 'support\'s lookup');
  // Item 4 (0089): when the receiving facility's access ends (none before acceptance) and whether Close acts now.
  assert.deepEqual([byReference[0].accessEndsAt, byReference[0].closable], [null, true]);
  // The Health ID in the body (CODEX §26); one in the GET's URL is refused, with or without a reference.
  const byHealthIdSupport = expectStatus(await adminCall('POST', '/admin/order-routes/search', { healthId: patient.hid }), 200,
    'find by HID').items;
  assert(byHealthIdSupport.some(item => item.routeId === rxRoute3.id) && byHealthIdSupport.length <= 20);
  const supportUrlRefusal = await refusedInUrl(extra => adminCall('GET', `/admin/order-routes?healthId=${patient.hid}`,
    undefined, extra), 'admin/order-routes/search', 'support GET with a Health ID');
  await refusedInUrl(extra => adminCall('GET', `/admin/order-routes?reference=${rxRoute3.reference}&healthId=${patient.hid}`,
    undefined, extra), 'admin/order-routes/search', 'support GET with a reference and a Health ID');
  expectProblem(await adminCall('POST', '/admin/order-routes/search', { reference: rxRoute3.reference, healthId: patient.hid }),
    400, 'ORDER_ROUTE_LOOKUP_INVALID');
  expectProblem(await adminCall('GET', '/admin/order-routes'), 400, 'ORDER_ROUTE_LOOKUP_INVALID');
  const closePath = `/admin/order-routes/${rxRoute3.id}/close`;
  const closeReason = { reason: 'Patient reported the pharmacy is the wrong one' };
  expectProblem(await adminCall('POST', closePath, closeReason), 428);
  expectProblem(await adminCall('POST', closePath, closeReason, { ifMatch: 7 }), 409, 'VERSION_CONFLICT');
  const closedBySupport = expectStatus(await adminCall('POST', closePath, closeReason, { ifMatch: 1 }), 200, 'support close');
  assert.deepEqual(closedBySupport, { routeId: rxRoute3.id, version: 2, effectiveState: 'withdrawn' });
  expectProblem(await adminCall('POST', closePath, closeReason, { ifMatch: 2 }), 409, 'ORDER_ROUTE_ALREADY_CLOSED');
  assert.equal(expectStatus(await ehrCall(doctor, 'GET', routesPath('prescription', rx3.id)), 200, 'closed').items[0].endedKind,
    'support');
  // Item 4 (0089): Find answers what Close would do now, at the database clock. Closed by support: no longer closable.
  const findRoute = async route => expectStatus(await adminCall('GET', `/admin/order-routes?reference=${route.reference}`), 200,
    `find ${route.reference}`).items.find(item => item.routeId === route.id);
  const afterClose = await findRoute(rxRoute3);
  assert.deepEqual([afterClose.effectiveState, afterClose.accessEndsAt, afterClose.closable], ['withdrawn', null, false]);
  // A completed prescription inside its window: Close acts; access ends exactly when the database says.
  const completedOpen = await findRoute(rxRoute2);
  const storedEnd = (await one('select access_ends_at from ehr.order_routes where id=$1', [rxRoute2.id])).access_ends_at;
  assert.deepEqual([completedOpen.effectiveState, completedOpen.closable, completedOpen.accessEndsAt],
    ['completed', true, storedEnd.toISOString()]);
  assert(Date.parse(completedOpen.accessEndsAt) > Date.now(), completedOpen.accessEndsAt);
  // The first lab request, completed and moved past its access (9b): Find says Close would not act, and Close refuses.
  const completedEnded = await findRoute(route1);
  assert.deepEqual([completedEnded.effectiveState, completedEnded.endedAt, completedEnded.closable], ['completed', null, false]);
  assert(Date.parse(completedEnded.accessEndsAt) < Date.now(), completedEnded.accessEndsAt);
  expectProblem(await adminCall('POST', `/admin/order-routes/${route1.id}/close`, closeReason,
    { ifMatch: completedEnded.version }), 409, 'ORDER_ROUTE_ALREADY_CLOSED');
  assert.deepEqual(await one('select state, ended_at from ehr.order_routes where id=$1', [route1.id]),
    { state: 'completed', ended_at: null });
  evidence.contractFields.support = { sent: { accessEndsAt: null, closable: true }, closedBySupport: { closable: false },
    completedInWindow: { closable: true, accessEndsAt: 'the stored access_ends_at' },
    completedPastAccess: { closable: false, close: 'ORDER_ROUTE_ALREADY_CLOSED' } };
  assert.deepEqual(await all(`select actor_type, facility_id, patient_id from audit.events where action='admin.order-route.close'
    and resource_id=$1`, [rxRoute3.id]), [{ actor_type: 'platform', facility_id: null, patient_id: null }]);
  // The directory: 60 searches an hour per member; the 61st is refused.
  let searchStatuses = [];
  for (let index = 0; index < 61; index += 1) searchStatuses.push((await search(thirdDoctor, 'laboratory', 'Verifier')).status);
  assert.deepEqual([searchStatuses.slice(0, 60).every(code => code === 200), searchStatuses[60]], [true, 429]);
  expectProblem(await search(thirdDoctor, 'laboratory', 'Verifier'), 429, 'ORDER_DESTINATION_SEARCH_LIMITED');
  assert.equal(expectStatus(await search(doctor, 'laboratory', 'Verifier Laboratory'), 200, 'another member').items.length, 1);
  assert.equal((await one(`select count(*)::int n from audit.events where action='identity.order-destinations.search'
    and (details::text like '%Verifier%' or details ? 'query')`)).n, 0, 'a search row names the query');
  evidence.support = { findByReference: 'one, no patient or content', findByHealthId: true,
    healthIdInGetUrl: supportUrlRefusal, lookupInvalid: 400,
    close: { withoutIfMatch: 428, stale: 'VERSION_CONFLICT', closed: 'withdrawn (support)', again: 'ORDER_ROUTE_ALREADY_CLOSED',
      platformRow: 'admin.order-route.close' }, directoryBudget: { first60: 200, sixtyFirst: 429, otherMember: 200,
      queryInAudit: 0 } };
  step('support finds and closes a route; the directory allows 60 searches an hour per member');

  // ── 12b. Wrong patient (item 3): a receiver ends an order it accepted for someone who was not the patient ──
  // A laboratory signed up for this block (so the first laboratory's counts stay as asserted below), its
  // administrator, a scientist invited through P4b, and an invited member whose role (owner SQL: no standard
  // role is one) may receive lab requests but not mark results entered in error. The pharmacy is the one above.
  const wpLab = await signUp({ label: 'Wrong-patient Laboratory', organizationType: 'laboratory', productCode: 'laboratory',
    administratorName: 'Ifeoma Nwosu' });
  await review(wpLab, 'lab', { body: 'MLSCN', number: 'MLSCN/70066' });
  const wpLabAdmin = await signInStaff(wpLab.email, HOSTS.lab, wpLab.facilityId, { name: wpLab.administratorName });
  const wpLabMember = await invited(wpLabAdmin, HOSTS.lab, wpLab.facilityId, { name: 'Jide Wrongpatient',
    email: synthetic('wp-lab-member'), role: 'lab', licenceBody: 'MLSCN', licenceNumber: 'MLSCN/80066' });
  const wpReceiver = await invited(wpLabAdmin, HOSTS.lab, wpLab.facilityId, { name: 'Kunle Receiveronly',
    email: synthetic('wp-lab-receiver'), role: 'lab', licenceBody: 'MLSCN', licenceNumber: 'MLSCN/80077' });
  await owner.query(`insert into auth.roles (code, description) values ('verifier_lab_receiver_only',
    'Order-route verifier: receives lab requests, cannot mark results entered in error') on conflict do nothing`);
  await owner.query(`insert into auth.role_permissions (role_code, permission_code)
    values ('verifier_lab_receiver_only', 'lab.order-route.receive') on conflict do nothing`);
  await age(`with old as (update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = $2,
        revocation_reason = 'Order-route verifier: a receive-only member'
      where account_id = $1 and role_code = 'lab' and scope_type = 'facility' and revoked_at is null
      returning membership_id, facility_id)
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    select gen_random_uuid(), $1, 'verifier_lab_receiver_only', 'facility', membership_id, facility_id,
      'Order-route verifier: a receive-only member' from old`, [wpReceiver.accountId, wpLabAdmin.accountId]);
  const wpNotes = {
    lab: 'He gave his cousin\'s Health ID at the counter; noticed when he asked for his own result',
    labAccepted: 'Wrong row picked at the counter; the person left before any sample',
    pharmacy: 'She collected it with another woman\'s date of birth; we think she was pretending',
  };
  const wpPath = (base, routeId) => `/${base === lab ? 'lab' : 'pharmacy'}/order-routes/${routeId}/wrong-patient`;
  const reportWrong = (who, base, routeId, body, key = freshKey('wrong-patient')) => call(base, who, 'POST', wpPath(base, routeId),
    body, key === null ? {} : { key });
  const routeVersion = async (who, base, routeId) => expectStatus(await call(base, who, 'GET',
    `/${base === lab ? 'lab' : 'pharmacy'}/order-routes/${routeId}`), 200, 'route').version;
  const myLabResults = async () => expectStatus(await http(lab, 'GET', '/lab/internal/me/released-results', {
    cookie: patientSession.cookie, headers: { 'x-hid-internal-caller': 'ehr-api', 'x-hid-service-token': tokens.lab } }), 200,
  'the patient\'s released results').records.map(record => record.id);
  const wpCounts = async routeId => one(`select
      (select count(*)::int from ehr.order_route_wrong_patient_reports where route_id = $1) as reports,
      (select state from ehr.order_routes where id = $1) as state,
      (select ended_kind from ehr.order_routes where id = $1) as ended_kind`, [routeId]);
  const wp = {};

  // Lab, completed: sent, refused while not accepted, accepted, worked and released, then reported.
  const lrW1 = await newLabRequest();
  const routeW1 = expectStatus(await send(doctor, 'lab_request', lrW1, wpLab.facilityId, labVersion), 201, 'send lrW1').route;
  wp.notAccepted = expectProblem(await reportWrong(wpLabAdmin, lab, routeW1.id, { expectedVersion: 1, reason: 'other',
    note: wpNotes.lab }), 409, 'ORDER_ROUTE_NOT_ACCEPTED').code;
  const acceptedW1 = expectStatus(await accept(wpLabAdmin, lab, routeW1.id, 1, { kind: 'date_of_birth', value: patient.dob },
    { body: { reference: routeW1.reference } }), 201, 'accept lrW1');
  const wpItem = expectStatus(await labCall(wpLabMember, 'GET', '/work-items'), 200, 'work list').items
    .find(item => item.id === acceptedW1.workItemId);
  assert(wpItem && typeof wpItem.orderRoute.version === 'number' && wpItem.orderRoute.endedKind === null,
    `card: ${JSON.stringify(wpItem?.orderRoute)}`);
  const wpAccession = expectStatus(await labCall(wpLabMember, 'POST', `/work-items/${acceptedW1.workItemId}/accession`,
    { requirements: [{ specimenType: 'blood' }], reason: 'Synthetic accession of an order from another facility' },
  { key: freshKey('accession') }), 201, 'accession W1');
  let wpSpecimen = wpAccession.specimens[0];
  wpSpecimen = expectStatus(await labCall(wpLabMember, 'POST', `/accessions/${wpAccession.id}/specimens/${wpSpecimen.id}/collect`,
    { expectedVersion: wpSpecimen.version, collectedAt: now() }, { key: freshKey('collect') }), 201, 'collect W1');
  wpSpecimen = expectStatus(await labCall(wpLabMember, 'POST', `/accessions/${wpAccession.id}/specimens/${wpSpecimen.id}/receive`,
    { expectedVersion: wpSpecimen.version, receivedAt: now() }, { key: freshKey('receive') }), 201, 'receive W1');
  let wpRun = expectStatus(await labCall(wpLabMember, 'POST', `/specimens/${wpSpecimen.id}/executions`,
    { expectedSpecimenVersion: wpSpecimen.version, startedAt: now(), reason: 'Synthetic run of a routed order' },
  { key: freshKey('execution') }), 201, 'execution W1');
  wpRun = expectStatus(await labCall(wpLabMember, 'POST', `/executions/${wpRun.id}/complete`,
    { expectedVersion: wpRun.version, completedAt: now() }, { key: freshKey('complete') }), 201, 'complete W1');
  const wpResult = expectStatus(await labCall(wpLabMember, 'POST', `/executions/${wpRun.id}/results`,
    { expectedExecutionVersion: wpRun.version, resultType: 'numeric', numericValue: 9.4, unit: '%', referenceRange: '4.0-5.6',
      abnormalFlag: 'high' }, { key: freshKey('result') }), 201, 'result W1');
  const wpResultId = wpResult.id ?? wpResult.result?.id;
  expectStatus(await labCall(wpLabAdmin, 'POST', `/results/${wpResultId}/verify`, { expectedResultVersion: 1, occurredAt: now(),
    reason: 'Verified by a second laboratory member' }, { key: freshKey('verify') }), 201, 'verify W1');
  expectStatus(await labCall(wpLabAdmin, 'POST', `/results/${wpResultId}/release`, { expectedResultVersion: 1, occurredAt: now(),
    reason: 'Released to the ordering facility' }, { key: freshKey('release') }), 201, 'release W1');
  assert(await myLabResults().then(ids => ids.includes(wpResultId)), 'the released result is not in the patient\'s record');
  // Refusals, each writing nothing: a stale version (the release moved it), the receive-only member with a
  // result to withdraw, no Idempotency-Key, a note too short once trimmed, another laboratory.
  const releasedVersion = await routeVersion(wpLabMember, lab, routeW1.id);
  assert(releasedVersion > acceptedW1.route.version, 'the release did not move the route version');
  wp.staleVersion = expectProblem(await reportWrong(wpLabMember, lab, routeW1.id, { expectedVersion: acceptedW1.route.version,
    reason: 'someone_elses_details', note: wpNotes.lab }), 412, 'VERSION_CONFLICT').code;
  const withoutPermission = expectProblem(await reportWrong(wpReceiver, lab, routeW1.id, { expectedVersion: releasedVersion,
    reason: 'someone_elses_details', note: wpNotes.lab }), 403, 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED');
  assert.equal(withoutPermission.permission, 'lab.result.entered-in-error');
  wp.correctionPermissionRequired = `403 ${withoutPermission.code} (${withoutPermission.permission})`;
  wp.withoutKey = expectProblem(await reportWrong(wpLabMember, lab, routeW1.id, { expectedVersion: releasedVersion,
    reason: 'someone_elses_details', note: wpNotes.lab }, null), 400, 'IDEMPOTENCY_KEY_REQUIRED').code;
  wp.shortNote = expectProblem(await reportWrong(wpLabMember, lab, routeW1.id, { expectedVersion: releasedVersion,
    reason: 'other', note: '   Not him    ' }), 400, 'ORDER_ROUTE_INVALID').code;
  wp.badReason = expectProblem(await reportWrong(wpLabMember, lab, routeW1.id, { expectedVersion: releasedVersion,
    reason: 'cannot_complete', note: wpNotes.lab }), 400, 'VALIDATION_FAILED').code;
  wp.otherLaboratory = expectProblem(await reportWrong(labAdmin, lab, routeW1.id, { expectedVersion: releasedVersion,
    reason: 'other', note: wpNotes.lab }), 404, 'ORDER_ROUTE_NOT_FOUND').code;
  assert.deepEqual(await wpCounts(routeW1.id), { reports: 0, state: 'completed', ended_kind: null }, 'a refusal wrote');
  // The scientist (not the acceptor) reports it: the result is withdrawn, access ends, the patient is told.
  const wpKey = freshKey('wrong-patient-w1');
  const wpBody = { expectedVersion: releasedVersion, reason: 'someone_elses_details', note: `  ${wpNotes.lab}  ` };
  const endedW1 = expectStatus(await reportWrong(wpLabMember, lab, routeW1.id, wpBody, wpKey), 200, 'wrong patient (lab)');
  assert.deepEqual(endedW1, { route: { id: routeW1.id, version: endedW1.route.version, effectiveState: 'completed',
    endedKind: 'wrong_patient' }, resultsVoided: 1, resultReportsMarked: 1, dispensingReversed: false, replayed: false });
  assert(endedW1.route.version > releasedVersion);
  const replayW1 = expectStatus(await reportWrong(wpLabMember, lab, routeW1.id, wpBody, wpKey), 200, 'replay');
  assert.deepEqual(replayW1, { ...endedW1, replayed: true });
  wp.anotherKey = expectProblem(await reportWrong(wpLabMember, lab, routeW1.id, { ...wpBody,
    expectedVersion: endedW1.route.version }), 409, 'ORDER_ROUTE_ALREADY_ENDED').code;
  // State before version: the old version is refused as already ended, not as a version conflict.
  wp.oldVersionAfterEnd = expectProblem(await reportWrong(wpLabAdmin, lab, routeW1.id, { ...wpBody,
    expectedVersion: releasedVersion }), 409, 'ORDER_ROUTE_ALREADY_ENDED').code;
  // B: the route is metadata, the item leaves the work list, and nothing more can be recorded on it.
  const routeAtB = expectStatus(await call(lab, wpLabMember, 'GET', `/lab/order-routes/${routeW1.id}`), 200, 'route at B');
  assert.deepEqual([routeAtB.patient, routeAtB.clinicalInformation, routeAtB.effectiveState], [undefined, undefined, 'completed']);
  assert(!expectStatus(await labCall(wpLabMember, 'GET', '/work-items'), 200, 'work list').items
    .some(item => item.id === acceptedW1.workItemId), 'the reported item is still on the work list');
  const itemAfter = await labCall(wpLabMember, 'GET', `/work-items/${acceptedW1.workItemId}`);
  const writeAfter = await labCall(wpLabAdmin, 'POST', `/executions/${wpRun.id}/results`, { expectedExecutionVersion: wpRun.version,
    resultType: 'numeric', numericValue: 9.5, unit: '%' }, { key: freshKey('result') });
  assert([403, 404].includes(itemAfter.status), `item after the report: ${answerOf(itemAfter)}`);
  assert([403, 404, 409].includes(writeAfter.status), `a result after the report: ${answerOf(writeAfter)}`);
  if (writeAfter.status === 409) assert.equal(writeAfter.body.code, 'ORDER_ROUTE_CLOSED');
  // A member holding the patient's own consent at B still reads the item on that basis: the card says how the
  // route ended, with no patient, and any write answers 409 ORDER_ROUTE_CLOSED, consent or not.
  await approvedAccess(wpLabAdmin, 'write_records');
  const consentCard = expectStatus(await labCall(wpLabAdmin, 'GET', '/work-items'), 200, 'consent holder\'s list').items
    .find(item => item.id === acceptedW1.workItemId);
  assert.deepEqual([consentCard?.orderRoute.access, consentCard?.orderRoute.endedKind, typeof consentCard?.orderRoute.version,
    consentCard?.patient], ['none', 'wrong_patient', 'number', undefined], JSON.stringify(consentCard));
  const closedWrite = expectProblem(await labCall(wpLabAdmin, 'POST', `/executions/${wpRun.id}/results`,
    { expectedExecutionVersion: wpRun.version, resultType: 'numeric', numericValue: 9.5, unit: '%' }, { key: freshKey('result') }),
  409, 'ORDER_ROUTE_CLOSED').code;
  // A: the status, the released row beside its entered-in-error row (no value), the receiving side's events.
  const viewW1 = expectStatus(await ehrCall(doctor, 'GET', routesPath('lab_request', lrW1.id)), 200, 'A\'s view').items[0];
  assert.deepEqual([viewW1.effectiveState, viewW1.endedKind, viewW1.resendAllowed, Boolean(viewW1.endedAt)],
    ['completed', 'wrong_patient', false, true]);
  assert.deepEqual(viewW1.results.map(item => [item.kind, item.resultId, item.numericValue === null ? null : Number(item.numericValue)]),
    [['released', wpResultId, 9.4], ['entered_in_error', wpResultId, null]]);
  const endedEvent = viewW1.events.find(event => event.type === 'access_ended');
  assert.deepEqual([endedEvent?.side, endedEvent?.reasonCode], ['receiving', 'wrong_patient']);
  assert(viewW1.events.some(event => event.type === 'result_marked_in_error'));
  assertNone(viewW1, [wpNotes.lab, wpLabMember.name, wpLabMember.accountId], 'A\'s view');
  // P: the order in full, no Stop, the new inbox notice; the result has left the record.
  const myW1 = expectStatus(await patientCall(ehr, 'GET', '/ehr/me/order-routes'), 200, 'my routes').items
    .find(item => item.id === routeW1.id);
  assert.deepEqual([myW1.effectiveState, myW1.endedKind, myW1.actions, myW1.enteredInError, myW1.content.testDisplay,
    myW1.content.clinicalInformation], ['completed', 'wrong_patient', [], false, labTest.testDisplay, clinicalNote]);
  const wpInbox = expectStatus(await patientCall(identity, 'GET', '/identity/me/notifications?limit=100'), 200, 'inbox')
    .filter(item => item.notificationCode === 'ORDER_ROUTE_WRONG_PATIENT');
  const noticeW1 = wpInbox.find(item => item.resourceId === routeW1.id);
  assert.deepEqual([noticeW1?.resourceType, noticeW1?.metadata], ['order-route', { routeId: routeW1.id, kind: 'lab_request',
    orderingFacilityName: hospital.name, receivingFacilityName: wpLab.name }], JSON.stringify(wpInbox));
  const resultsAfter = await myLabResults();
  assert(!resultsAfter.includes(wpResultId), 'the withdrawn result is still in the patient\'s record');
  assert(resultsAfter.includes(resultId), 'another result left the patient\'s record');
  // What the database holds: one report, the invalidation's event for delivery, B's own audit row (no note).
  assert.deepEqual(await one(`select (select count(*)::int from lab.result_invalidations where result_id = $1) as invalidations,
      (select count(*)::int from lab.outbox_events where event_type = 'LabResultEnteredInError' and aggregate_id = $1
        and patient_id = $2 and facility_id = $3) as outbox`, [wpResultId, patient.id, wpLab.facilityId]),
  { invalidations: 1, outbox: 1 });
  const bRows = await all(`select patient_id, details from audit.events where action = 'lab.order-route.wrong-patient'
    and resource_id = $1 order by sequence_id`, [routeW1.id]);
  assert.deepEqual(bRows.map(row => [row.patient_id, row.details.replayed, row.details.reasonCode, row.details.resultsVoided]),
    [[patient.id, false, 'someone_elses_details', 1], [patient.id, true, 'someone_elses_details', 1]]);
  assert.deepEqual(await all(`select facility_id from audit.events where action = 'ehr.order-route.wrong-patient'
    and resource_id = $1 order by facility_id`, [routeW1.id]), [hospital.facilityId, wpLab.facilityId].sort()
    .map(facility_id => ({ facility_id })));
  wp.labCompleted = { answer: { effectiveState: 'completed', endedKind: 'wrong_patient', resultsVoided: 1,
    resultReportsMarked: 1 }, replay: 'replayed true', reportedBy: 'a scientist, not the acceptor',
  receiver: { routeRead: 'no patient', workList: 'item gone', itemRead: itemAfter.status, resultWrite: answerOf(writeAfter),
    consentHolder: { card: 'access none, endedKind wrong_patient, no patient', resultWrite: closedWrite } },
  ordering: { results: ['released', 'entered_in_error (no value)'], event: 'access_ended (receiving, wrong_patient)',
    resendAllowed: false }, patient: { route: 'full content, no Stop', inbox: 'ORDER_ROUTE_WRONG_PATIENT',
    labRecord: 'result gone, the earlier result kept' }, audit: 'B with the patient (and the replay), A and B system rows' };

  // Lab, accepted, nothing returned: the receive-only member may end it (nothing to withdraw); no resend (D5).
  const lrW2 = await newLabRequest();
  const routeW2 = expectStatus(await send(doctor, 'lab_request', lrW2, wpLab.facilityId, labVersion), 201, 'send lrW2').route;
  const acceptedW2 = expectStatus(await accept(wpLabAdmin, lab, routeW2.id, 1, { kind: 'health_id', value: patient.hid }), 201,
    'accept lrW2');
  const endedW2 = expectStatus(await reportWrong(wpReceiver, lab, routeW2.id, { expectedVersion: acceptedW2.route.version,
    reason: 'other', note: wpNotes.labAccepted }), 200, 'wrong patient, nothing returned');
  assert.deepEqual(endedW2, { route: { id: routeW2.id, version: endedW2.route.version, effectiveState: 'cancelled',
    endedKind: 'wrong_patient' }, resultsVoided: 0, resultReportsMarked: 0, dispensingReversed: false, replayed: false });
  const viewW2 = expectStatus(await ehrCall(doctor, 'GET', routesPath('lab_request', lrW2.id)), 200, 'A\'s view W2').items[0];
  assert.deepEqual([viewW2.effectiveState, viewW2.endedKind, viewW2.results, viewW2.resendAllowed],
    ['cancelled', 'wrong_patient', [], false]);
  const lrW2Now = expectStatus(await ehrCall(doctor, 'GET', `${enc}/lab-requests/${lrW2.id}`), 200, 'lrW2');
  wp.resend = expectProblem(await send(doctor, 'lab_request', lrW2Now, wpLab.facilityId, labVersion), 409,
    'ORDER_ROUTE_ORDER_IN_WORK').code;
  wp.labAccepted = { reportedBy: 'a member who may receive but not mark results in error', answer: 'cancelled, nothing withdrawn',
    ordering: 'cancelled (wrong_patient), no results', resend: wp.resend };

  // Lab, accepted and past B's window: already ended (the window is aged by owner SQL).
  const lrW3 = await newLabRequest();
  const routeW3 = expectStatus(await send(doctor, 'lab_request', lrW3, wpLab.facilityId, labVersion), 201, 'send lrW3').route;
  const acceptedW3 = expectStatus(await accept(wpLabAdmin, lab, routeW3.id, 1, { kind: 'health_id', value: patient.hid }), 201,
    'accept lrW3');
  await age(`update ehr.order_routes set writes_end_at = clock_timestamp() - interval '1 minute',
      access_ends_at = clock_timestamp() - interval '1 minute' where id = $1`, [routeW3.id]);
  wp.outsideWindow = expectProblem(await reportWrong(wpLabAdmin, lab, routeW3.id, { expectedVersion: acceptedW3.route.version,
    reason: 'other', note: wpNotes.labAccepted }), 409, 'ORDER_ROUTE_ALREADY_ENDED').code;
  assert.deepEqual(await wpCounts(routeW3.id), { reports: 0, state: 'accepted', ended_kind: null });

  // Pharmacy, dispensed: the dispensing is reversed and the prescription ends.
  const rxW1 = await newPrescription('active');
  const rxRouteW1 = await sendPrescription(rxW1);
  const rxAcceptedW1 = expectStatus(await acceptPrescription(rxRouteW1.id, 1, { kind: 'health_id', value: patient.hid }), 201,
    'accept rxW1');
  const rxItemW1 = expectStatus(await pharmacyCall(pharmacist, 'GET', `/work-items/${rxAcceptedW1.workItemId}`), 200, 'rxW1 item');
  assert(typeof rxItemW1.orderRoute.version === 'number' && rxItemW1.orderRoute.endedKind === null);
  expectStatus(await pharmacyCall(pharmacist, 'POST', `/work-items/${rxAcceptedW1.workItemId}/dispensings`,
    { expectedWorkItemVersion: Number(rxItemW1.version), quantityDispensed: 60, quantityUnit: 'tablet',
      reason: 'Synthetic dispensing at the counter' }, { key: freshKey('dispense') }), 201, 'dispense rxW1');
  const rxVersion = await routeVersion(pharmacist, pharmacy, rxRouteW1.id);
  const endedRx = expectStatus(await reportWrong(pharmacist, pharmacy, rxRouteW1.id, { expectedVersion: rxVersion,
    reason: 'suspected_misuse', note: wpNotes.pharmacy }), 200, 'wrong patient (pharmacy)');
  assert.deepEqual(endedRx, { route: { id: rxRouteW1.id, version: endedRx.route.version, effectiveState: 'completed',
    endedKind: 'wrong_patient' }, resultsVoided: 0, resultReportsMarked: 0, dispensingReversed: true, replayed: false });
  wp.pharmacyAgain = expectProblem(await reportWrong(pharmacist, pharmacy, rxRouteW1.id, { expectedVersion: endedRx.route.version,
    reason: 'suspected_misuse', note: wpNotes.pharmacy }), 409, 'ORDER_ROUTE_ALREADY_ENDED').code;
  const rxViewW1 = expectStatus(await ehrCall(doctor, 'GET', routesPath('prescription', rxW1.id)), 200, 'A\'s rx view').items[0];
  assert.deepEqual([rxViewW1.effectiveState, rxViewW1.endedKind, rxViewW1.dispensings.map(item => item.kind)],
    ['completed', 'wrong_patient', ['dispensed', 'reversed']]);
  assert.equal((await one(`select count(*)::int as n from pharmacy.outbox_events where event_type = 'MedicationDispensingReversed'
    and aggregate_type = 'medication-dispensing-reversal' and patient_id = $1 and facility_id = $2
    and payload->>'workItemId' = $3`, [patient.id, pharmacyFacility.facilityId, rxAcceptedW1.workItemId])).n, 1);
  const rxNotice = expectStatus(await patientCall(identity, 'GET', '/identity/me/notifications?limit=100'), 200, 'inbox')
    .find(item => item.notificationCode === 'ORDER_ROUTE_WRONG_PATIENT' && item.resourceId === rxRouteW1.id);
  assert.deepEqual(rxNotice?.metadata, { routeId: rxRouteW1.id, kind: 'prescription', orderingFacilityName: hospital.name,
    receivingFacilityName: pharmacyFacility.name });
  wp.pharmacyDispensed = { answer: 'completed, dispensing reversed', again: wp.pharmacyAgain,
    ordering: ['dispensed', 'reversed'], outbox: 'MedicationDispensingReversed', patientNotice: 'ORDER_ROUTE_WRONG_PATIENT' };

  // The ordering facility's Overview card (D10's alternative (a)): the sender sees their own orders in full; a
  // colleague a count and the references; another facility nothing; a member without ehr.order-route.send 403.
  const overview = who => call(ehr, who, 'GET', '/ehr/order-routes/wrong-patient');
  const wpReferences = [routeW1.reference, routeW2.reference, rxRouteW1.reference];
  const own = expectStatus(await overview(doctor), 200, 'Overview (sender)');
  assert.equal(own.windowDays, 30);
  assert.deepEqual(own.others, { count: 0, references: [] });
  assert.deepEqual(own.items.map(item => item.routeId).sort(), [routeW1.id, routeW2.id, rxRouteW1.id].sort());
  const ownW1 = own.items.find(item => item.routeId === routeW1.id);
  assert.deepEqual({ ...ownW1, endedAt: undefined }, { routeId: routeW1.id, reference: routeW1.reference, kind: 'lab_request',
    receivingFacility: { id: wpLab.facilityId, name: wpLab.name }, patient: { name: patient.fullName }, endedAt: undefined,
    resultsWithdrawn: 1, dispensingReversed: false,
    link: { patientId: patient.id, encounterId: encounter.id, kind: 'lab_request', orderId: lrW1.id } });
  assert(Number.isFinite(Date.parse(ownW1.endedAt)));
  assert.deepEqual(own.items.filter(item => item.routeId !== routeW1.id).map(item => [item.kind, item.resultsWithdrawn,
    item.dispensingReversed]).sort(), [['lab_request', 0, false], ['prescription', 0, true]]);
  const overviewRows = await all(`select action, patient_id, details from audit.events
    where action like 'ehr.order-route.wrong-patient-overview%' and actor_account_id = $1 order by sequence_id`, [doctor.accountId]);
  assert.deepEqual(overviewRows.map(row => [row.action, row.patient_id]), [['ehr.order-route.wrong-patient-overview', null],
    ...own.items.map(() => ['ehr.order-route.wrong-patient-overview.item', patient.id])]);
  assert.deepEqual(overviewRows[0].details, { itemCount: 3, otherCount: 0 });
  assertNone(overviewRows, [patient.fullName, ...wpReferences], 'the Overview audit rows');
  // The report usually comes days after the order, once the grant it was sent under has expired: the sender still
  // sees their orders in full (D10's rule as the owner gave it). Owner SQL expires the sender's grants for the patient
  // (triggers off), then puts them back as they were.
  const grants = await all(`select id, starts_at, expires_at from identity.consent_grants
    where account_id = $1 and patient_id = $2 and status = 'active' and expires_at > now()`, [doctor.accountId, patient.id]);
  assert(grants.length > 0, 'the sender holds a live grant for the patient before it is expired');
  const grantsOwner = async (sql, values) => {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(sql, values);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  };
  await grantsOwner(`update identity.consent_grants set starts_at = now() - interval '3 days',
    expires_at = now() - interval '2 days' where id = any($1::uuid[])`, [grants.map(grant => grant.id)]);
  let expiredOverview;
  try {
    expiredOverview = expectStatus(await overview(doctor), 200, 'Overview (sender, grant expired)');
  } finally {
    await grantsOwner(`update identity.consent_grants grant_row set starts_at = kept.starts_at, expires_at = kept.expires_at
      from unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) kept(id, starts_at, expires_at) where grant_row.id = kept.id`,
    [grants.map(grant => grant.id), grants.map(grant => grant.starts_at), grants.map(grant => grant.expires_at)]);
  }
  assert.deepEqual(expiredOverview.items.map(item => [item.routeId, item.patient.name]).sort(),
    own.items.map(item => [item.routeId, item.patient.name]).sort());
  assert(expiredOverview.items.every(item => item.patient.name === patient.fullName));
  assert.deepEqual(expiredOverview.others, { count: 0, references: [] });
  const colleague = expectStatus(await overview(secondDoctor), 200, 'Overview (colleague)');
  assert.deepEqual([colleague.items, colleague.others.count, [...colleague.others.references].sort()], [[], 3, [...wpReferences].sort()]);
  assertNone(colleague, [patient.fullName, patient.id, lrW1.id, encounter.id], 'the colleague\'s Overview');
  assert.deepEqual(expectStatus(await overview(thirdDoctor), 200, 'Overview (other facility)'),
    { windowDays: 30, items: [], others: { count: 0, references: [] } });
  // A hospital laboratory member holds no ehr.order-route.send: refused before the database is read.
  const noSendResponse = await overview(hospitalLab1);
  expectProblem(noSendResponse, 403);
  const noSend = answerOf(noSendResponse);
  const emergencyOverview = expectProblem(await call(ehr, doctor, 'GET', '/ehr/order-routes/wrong-patient', undefined,
    { purpose: 'emergency' }), 403, 'PERMISSION_DENIED').code;
  wp.overview = { sender: { items: 3, others: 0, patientName: true, link: 'patient, encounter, kind, order',
    audit: 'one read row (no patient) and one row per item naming the patient',
    afterGrantExpired: 'the same three in full, with the patient\'s name' },
  colleague: { items: 0, count: 3, references: 'the three, no patient' }, otherFacility: 'empty',
  withoutSendPermission: noSend, emergency: emergencyOverview };

  // Support: the reports (unreviewed, flagged first), the facility filter, the review (once, If-Match), the tile.
  const unreviewed = expectStatus(await adminCall('GET', '/admin/wrong-patient-reports?status=unreviewed'), 200,
    'support\'s reports').items;
  const reportOf = routeId => unreviewed.find(item => item.routeId === routeId);
  assert.deepEqual(unreviewed.map(item => item.routeId).sort(), [routeW1.id, routeW2.id, rxRouteW1.id].sort());
  const reportW1 = reportOf(routeW1.id);
  assert.deepEqual({ reference: reportW1.reference, kind: reportW1.kind, receiving: reportW1.receivingFacility,
    ordering: reportW1.orderingFacility, reportedBy: reportW1.reportedBy.accountId, acceptedBy: reportW1.acceptedBy.accountId,
    sameMember: reportW1.sameMember, acceptedWith: reportW1.acceptedWith, reason: reportW1.reason, note: reportW1.note,
    stateBefore: reportW1.stateBefore, resultsVoided: reportW1.resultsVoided, resultReportsMarked: reportW1.resultReportsMarked,
    specimensCollected: reportW1.specimensCollected, reporterRecordedWork: reportW1.reporterRecordedWork, flags: reportW1.flags,
    facility30: reportW1.facilityReportsLast30Days, review: reportW1.review },
  { reference: routeW1.reference, kind: 'lab_request', receiving: { id: wpLab.facilityId, name: wpLab.name },
    ordering: { id: hospital.facilityId, name: hospital.name }, reportedBy: wpLabMember.accountId,
    acceptedBy: wpLabAdmin.accountId, sameMember: false, acceptedWith: 'date_of_birth_with_reference',
    reason: 'someone_elses_details', note: wpNotes.lab, stateBefore: 'completed', resultsVoided: 1, resultReportsMarked: 1,
    specimensCollected: 1, reporterRecordedWork: true, flags: ['something_came_back', 'reporter_recorded_work'], facility30: 2,
    review: null });
  assert.deepEqual(reportW1.recordedBy.map(entry => entry.accountId).sort(), [wpLabAdmin.accountId, wpLabMember.accountId].sort());
  assert.deepEqual([reportOf(routeW2.id).flags, reportOf(routeW2.id).acceptedWith, reportOf(routeW2.id).reporterRecordedWork],
    [['other_reason_nothing_recorded'], 'health_id', false]);
  assert.deepEqual(reportOf(rxRouteW1.id).flags, ['something_came_back', 'reporter_recorded_work', 'suspected_misuse']);
  assertNone(unreviewed, [patient.fullName, patient.hid, patient.id, labTest.testDisplay, medicine.medicationDisplay, clinicalNote],
    'support\'s reports');
  const tileBefore = unreviewed.length;
  const ofLab = expectStatus(await adminCall('GET', `/admin/wrong-patient-reports?status=recent&facilityId=${wpLab.facilityId}`), 200,
    'reports of one facility').items;
  assert.deepEqual(ofLab.map(item => item.routeId).sort(), [routeW1.id, routeW2.id].sort());
  wp.unknownFacility = expectProblem(await adminCall('GET', `/admin/wrong-patient-reports?status=recent&facilityId=${randomUUID()}`),
    404, 'ADMIN_FACILITY_NOT_FOUND').code;
  const reviewPath = `/admin/wrong-patient-reports/${reportW1.reportId}/review`;
  const reviewBody = { actions: ['ordering_facility_told', 'referred_to_dpo'],
    note: 'Phoned the hospital the same day and referred it to the DPO', removeNote: true };
  wp.reviewWithoutIfMatch = expectProblem(await adminCall('POST', reviewPath, reviewBody), 428, 'IF_MATCH_REQUIRED').code;
  wp.reviewStale = expectProblem(await adminCall('POST', reviewPath, reviewBody, { ifMatch: reportW1.version + 6 }), 409,
    'VERSION_CONFLICT').code;
  wp.reviewMixed = expectProblem(await adminCall('POST', `/admin/wrong-patient-reports/${reportOf(routeW2.id).reportId}/review`,
    { actions: ['no_further_action', 'facility_contacted'], note: 'Phoned the laboratory manager' },
    { ifMatch: reportOf(routeW2.id).version }), 400, 'WRONG_PATIENT_REVIEW_INVALID').code;
  const reviewedW1 = expectStatus(await adminCall('POST', reviewPath, reviewBody, { ifMatch: reportW1.version }), 200, 'review');
  assert.deepEqual({ ...reviewedW1, reviewedAt: undefined }, { reportId: reportW1.reportId, version: reportW1.version + 1,
    reviewedAt: undefined, actions: ['ordering_facility_told', 'referred_to_dpo'], noteRemoved: true });
  wp.reviewAgain = expectProblem(await adminCall('POST', reviewPath, reviewBody, { ifMatch: reviewedW1.version }), 409,
    'WRONG_PATIENT_REPORT_ALREADY_REVIEWED').code;
  const afterReview = expectStatus(await adminCall('GET', '/admin/wrong-patient-reports?status=unreviewed'), 200, 'unreviewed').items;
  assert.deepEqual(afterReview.map(item => item.routeId).sort(), [routeW2.id, rxRouteW1.id].sort());
  const recentW1 = expectStatus(await adminCall('GET', '/admin/wrong-patient-reports?status=recent'), 200, 'recent').items
    .find(item => item.routeId === routeW1.id);
  assert.deepEqual([recentW1.note, recentW1.noteRemoved, recentW1.review?.actions, recentW1.review?.note,
    recentW1.review?.reviewedBy?.accountId], ['Removed by Health ID support at review.', true,
    ['ordering_facility_told', 'referred_to_dpo'], reviewBody.note, support.accountId]);
  assert.deepEqual(await all(`select actor_type, reason, details from audit.events where action = 'admin.wrong-patient-report.review'
    and resource_id = $1`, [reportW1.reportId]), [{ actor_type: 'platform', reason: reviewBody.note,
    details: { reportId: reportW1.reportId, routeId: routeW1.id, actions: reviewBody.actions, noteRemoved: true,
      version: reviewedW1.version } }]);
  assert(await one(`select count(*)::int as n from audit.events where action = 'api.admin.wrong-patient-reports.list'
    and outcome = 'success'`).then(row => row.n) >= 4, 'support\'s list reads are audited');
  wp.support = { unreviewed: tileBefore, tile: `${tileBefore} to review, then ${afterReview.length}`,
    flags: { labCompleted: reportW1.flags, labAccepted: reportOf(routeW2.id).flags, pharmacy: reportOf(rxRouteW1.id).flags },
    facilityFilter: 'the laboratory\'s two', unknownFacility: wp.unknownFacility,
    review: { withoutIfMatch: wp.reviewWithoutIfMatch, stale: wp.reviewStale, mixedActions: wp.reviewMixed, reviewed: 200,
      noteRemoved: 'fixed text', again: wp.reviewAgain, platformRow: 'admin.wrong-patient-report.review, the review note as reason' } };

  // The reporters' notes reach support's list only: no audit row, inbox item or service log carries one.
  const noteValues = Object.values(wpNotes);
  const noteRows = await all(`select action from audit.events where ${noteValues.map((_, index) =>
    `strpos(coalesce(details::text, '') || coalesce(reason, ''), $${index + 1}) > 0`).join(' or ')}`, noteValues);
  assert.deepEqual(noteRows, [], `a note reached an audit row: ${JSON.stringify(noteRows)}`);
  const noteNotices = await all(`select notification_code from notification.inbox_items
    where ${noteValues.map((_, index) => `strpos(metadata::text, $${index + 1}) > 0`).join(' or ')}`, noteValues);
  assert.deepEqual(noteNotices, []);
  for (const [name, log] of childLogs) {
    const text = log.join('');
    for (const note of noteValues) assert(!text.includes(note) && !text.includes(note.slice(0, 24)), `${name} logged a note`);
  }
  wp.notes = { auditRows: 0, inbox: 0, serviceLogs: 0, onlyIn: 'support\'s list' };
  evidence.wrongPatient = wp;
  step('wrong patient: lab (result withdrawn), nothing returned, outside the window, pharmacy (reversed); Overview card; support\'s list and review');

  // ── 12c. Item 4 (0089, D4): a laboratory unlisted after orders were sent to it still sees them ──
  // Support lists the laboratory checked as Other; the doctor sends it two lab requests and it accepts one; support
  // unlists it again. Its work list and Incoming then say it does not receive, and that one order is held there and
  // one waits: the website keeps the paused notice for the accepted work and shows the waiting one for Decline.
  assert.equal(expectStatus(await listOther(true), 200, 'list other again').listed, true);
  const lrHeld = await newLabRequest();
  const routeHeld = expectStatus(await send(doctor, 'lab_request', lrHeld, otherLab.facilityId, labVersion), 201,
    'send to the laboratory checked as Other').route;
  const lrWaiting = await newLabRequest();
  const routeWaiting = expectStatus(await send(doctor, 'lab_request', lrWaiting, otherLab.facilityId, labVersion), 201,
    'send to the laboratory checked as Other (2)').route;
  const heldAccepted = expectStatus(await accept(otherLabAdmin, lab, routeHeld.id, 1, { kind: 'health_id', value: patient.hid }),
    201, 'accept at the laboratory checked as Other');
  assert.equal(expectStatus(await listOther(false), 200, 'unlist other again').listed, false);
  const unlistedIncoming = expectStatus(await call(lab, otherLabAdmin, 'GET', '/lab/order-routes?view=incoming'), 200,
    'Incoming once unlisted');
  assert.deepEqual([unlistedIncoming.receives, unlistedIncoming.routesHere, unlistedIncoming.items.map(item => item.id)],
    [false, { waiting: true, held: true }, [routeWaiting.id]]);
  const unlistedWork = expectStatus(await call(lab, otherLabAdmin, 'GET', '/lab/work-items'), 200, 'work list once unlisted');
  assert.deepEqual([unlistedWork.receives, unlistedWork.routesHere], [false, { waiting: true, held: true }]);
  assert(unlistedWork.items.some(item => item.id === heldAccepted.workItemId), 'the accepted order left the work list');
  const unlistedAccept = expectProblem(await accept(otherLabAdmin, lab, routeWaiting.id, 1,
    { kind: 'health_id', value: patient.hid }), 409, 'ORDER_ROUTE_DESTINATION_INELIGIBLE').code;
  expectStatus(await call(lab, otherLabAdmin, 'POST', `/lab/order-routes/${routeWaiting.id}/decline`,
    { expectedVersion: 1, reason: 'test_not_offered' }), 200, 'decline once unlisted');
  const afterDecline = expectStatus(await call(lab, otherLabAdmin, 'GET', '/lab/order-routes?view=incoming'), 200,
    'Incoming after the decline');
  assert.deepEqual([afterDecline.receives, afterDecline.routesHere, afterDecline.items], [false, { waiting: false, held: true }, []]);
  evidence.contractFields.unlistedAfterOrders = { incoming: { receives: false, routesHere: unlistedIncoming.routesHere,
    listed: 'the waiting order' }, workList: { receives: false, routesHere: unlistedWork.routesHere, accepted: 'listed' },
    accept: unlistedAccept, decline: 200, afterDecline: afterDecline.routesHere };
  step('contract fields (item 4): receives and routesHere on every list, Find\'s accessEndsAt and closable, the summary\'s destination');

  // ── Timing (p95 of 25 calls each, with this run's routes and work) ──
  const p95 = async request => {
    const samples = [];
    for (let index = 0; index < 25; index += 1) {
      const started = process.hrtime.bigint();
      const response = await request();
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(response.status, 200);
    }
    samples.sort((left, right) => left - right);
    return Number(samples[Math.ceil(samples.length * 0.95) - 1].toFixed(2));
  };
  evidence.timingMs = {
    labWorkListAtTheReceiver: await p95(() => labCall(labAdmin, 'GET', '/work-items')),
    labIncoming: await p95(() => labCall(labAdmin, 'GET', '/order-routes?view=incoming')),
    labRecent: await p95(() => labCall(labAdmin, 'GET', '/order-routes?view=recent')),
    sameFacilityLabWorkList: await p95(() => labCall(hospitalLab1, 'GET', '/work-items')),
    orderingLabRequestList: await p95(() => ehrCall(doctor, 'GET', `${enc}/lab-requests`)),
  };

  // ── 13. Release: a reviewed sign-up released by support closes its routes both ways ──
  await approvedAccess(thirdDoctor, 'write_records');
  const thirdEncounter = expectStatus(await call(ehr, thirdDoctor, 'POST', `/ehr/patients/${patient.id}/encounters`,
    { encounterType: 'ambulatory', status: 'in_progress', startedAt: new Date().toISOString() }, { key: freshKey('encounter') }),
  201, 'third encounter');
  const thirdRx = expectStatus(await call(ehr, thirdDoctor, 'POST',
    `/ehr/patients/${patient.id}/encounters/${thirdEncounter.id}/prescriptions`, { ...medicine, status: 'active' },
    { key: freshKey('prescription') }), 201, 'third prescription');
  const thirdRoute = expectStatus(await call(ehr, thirdDoctor, 'POST',
    `/ehr/patients/${patient.id}/encounters/${thirdEncounter.id}/prescriptions/${thirdRx.id}/order-routes`,
    { expectedRowVersion: Number(thirdRx.rowVersion), receivingFacilityId: pharmacyFacility.facilityId, patientAgreed: true,
      attestationTextVersion: prescriptionVersion }, { key: freshKey('send') }), 201, 'third send').route;
  const summaryBefore = expectStatus(await adminCall('GET', `/admin/facilities/${laboratory.facilityId}/order-route-summary`), 200,
    'summary');
  assert.deepEqual([summaryBefore.receivedAcceptedLifetime, summaryBefore.receivedPatientsLifetime], [1, 1]);
  assert(summaryBefore.counterparts.some(item => item.direction === 'received' && item.facilityId === hospital.facilityId));
  assertNone(summaryBefore, [...identityValues, ...clinicalOnly], 'support\'s summary');
  const releaseFacility = async (target, adminAccount) => {
    const facilityVersion = (await one('select row_version from identity.facilities where id=$1', [target.facilityId])).row_version;
    const suspended = await adminCall('POST', `/admin/facilities/${target.facilityId}/status`,
      { status: 'suspended', reason: 'Order-route verifier releases this sign-up' },
      { ifMatch: facilityVersion, key: freshKey('suspend') });
    assert([200, 201].includes(suspended.status), `suspend: ${JSON.stringify(suspended.body)}`);
    const accountVersion = (await one('select row_version from auth.accounts where id=$1', [adminAccount])).row_version;
    const disabled = await adminCall('POST', `/admin/principals/${adminAccount}/status`,
      { status: 'disabled', reason: 'Order-route verifier releases this sign-up' },
      { ifMatch: accountVersion, key: freshKey('disable') });
    assert([200, 201].includes(disabled.status), `disable: ${JSON.stringify(disabled.body)}`);
    const applicationVersion = (await one('select row_version from identity.organization_applications where id=$1',
      [target.applicationId])).row_version;
    return expectStatus(await adminCall('POST', `/admin/self-service-facilities/${target.applicationId}/release`,
      { reason: 'Order-route verifier releases this sign-up' }, { ifMatch: applicationVersion }), 200, `release ${target.label}`);
  };
  await releaseFacility(laboratory, laboratory.accountId);
  // Item 4: a released sign-up is no destination (the release suspends its products).
  const releasedDestination = await destinationOf(laboratory);
  assert.deepEqual(releasedDestination, { receivingTypes: [], review: 'released' });
  evidence.contractFields.releasedDestination = releasedDestination;
  const released = await all(`select id, state, ended_kind, access_ends_at <= clock_timestamp() as access_ended
    from ehr.order_routes where id = any($1::uuid[]) order by created_at`, [[route1.id, route2b.id, route6.id]]);
  assert.deepEqual(released.map(row => [row.state, row.ended_kind]), [['completed', 'receiving_released'],
    ['withdrawn', 'receiving_released'], ['withdrawn', 'receiving_released']]);
  const releaseRow = await one(`select actor_type, facility_id, patient_id, details from audit.events
    where action='admin.self-service-facility.release-order-routes' and resource_id=$1`, [laboratory.applicationId])
    ?? await one(`select actor_type, facility_id, patient_id, details from audit.events
      where action='admin.self-service-facility.release-order-routes' order by sequence_id desc limit 1`);
  assert.deepEqual([releaseRow.actor_type, releaseRow.facility_id, releaseRow.patient_id], ['platform', null, null]);
  assert.deepEqual({ withdrawn: releaseRow.details.withdrawn, accessEnded: releaseRow.details.accessEnded,
    acceptedLifetime: releaseRow.details.acceptedLifetime, patientsLifetime: releaseRow.details.patientsLifetime },
  { withdrawn: 2, accessEnded: 1, acceptedLifetime: 1, patientsLifetime: 1 });
  expectProblem(await send(doctor, 'lab_request', await newLabRequest(), laboratory.facilityId, labVersion), 409,
    'ORDER_ROUTE_DESTINATION_INELIGIBLE');
  await releaseFacility(thirdHospital, thirdHospital.accountId);
  assert.deepEqual(await one('select state, ended_kind from ehr.order_routes where id=$1', [thirdRoute.id]),
    { state: 'withdrawn', ended_kind: 'ordering_released' });
  const cancelledNotices = (expectStatus(await patientCall(identity, 'GET', '/identity/me/notifications?limit=100'), 200, 'inbox'))
    .filter(item => item.notificationCode === 'ORDER_ROUTE_CANCELLED').map(item => item.resourceId);
  for (const routeId of [route2b.id, route6.id, thirdRoute.id]) assert(cancelledNotices.includes(routeId), `no notice for ${routeId}`);
  evidence.release = { receiving: { completed: 'access ended', sent: 'withdrawn (receiving_released)', platformRow:
    { withdrawn: 2, accessEnded: 1, acceptedLifetime: 1, patientsLifetime: 1 }, sendAfter: 'ORDER_ROUTE_DESTINATION_INELIGIBLE' },
  ordering: 'withdrawn (ordering_released)', patientsTold: 'ORDER_ROUTE_CANCELLED for each' };
  step('release closes the released facility\'s routes both ways and tells the patients');

  // ── 14. Audit: what each facility's rows carry ──
  const routes = await all('select id, accepted_at, ordering_facility_id, receiving_facility_id from ehr.order_routes');
  const neverAccepted = routes.filter(route => route.accepted_at === null);
  const leakedPatient = await all(`select event.action, event.resource_id from audit.events event
    join ehr.order_routes route on route.id::text = event.resource_id
    where route.accepted_at is null and event.facility_id = route.receiving_facility_id and event.patient_id is not null`);
  assert.deepEqual(leakedPatient, [], 'a row at B about a route it never accepted names the patient');
  const systemActors = await all(`select action from audit.events where action like 'ehr.order-route.%' and actor_type='system'
    and (actor_account_id is not null or actor_membership_id is not null)`);
  assert.deepEqual(systemActors, [], 'a cross-facility system row carries an actor');
  const staffIds = (await all(`select id::text from auth.accounts where subject not like 'synthetic:platform-admin:%'`))
    .map(row => row.id);
  const crossRows = await all(`select details::text as details from audit.events where action like 'ehr.order-route.%'
    and actor_type='system'`);
  for (const row of crossRows) for (const id of staffIds) assert(!row.details.includes(id), 'a system row names a member');
  const sensitive = [...identityValues, otherPatient.hid, clinicalNote, medicine.instructions, medicine.medicationDisplay,
    labTest.testDisplay, 'Synthetic own glucose test', '6.8', '9.4', 'MDCN/70011', 'MDCN/80022', 'MLSCN/70022', 'MLSCN/80011',
    'MLSCN/80066', 'PCN/70033', patientEmail, ...Object.values(wpNotes)];
  const scanned = await all(`select action, details::text as details from audit.events
    where action like '%order-route%' or action like '%order-destination%' or details ? 'orderRouteId'`);
  const leaks = scanned.filter(row => sensitive.some(value => row.details.includes(value)))
    .map(row => `${row.action}: ${sensitive.find(value => row.details.includes(value))}`);
  assert.deepEqual(leaks, []);
  // Item 4: nothing new is audited; no row carries the new fields.
  const contractFieldRows = await all(`select action from audit.events
    where coalesce(details::text, '') ~ '"(receives|routesHere|closable|accessEndsAt|receivingTypes)"'`);
  assert.deepEqual(contractFieldRows, [], `a row carries a contract field: ${JSON.stringify(contractFieldRows)}`);
  evidence.audit = { routes: routes.length, neverAccepted: neverAccepted.length, rowsScanned: scanned.length,
    sensitiveValues: sensitive.length, leaks: 0, patientOnBRowsBeforeAcceptance: 0, actorsOnSystemRows: 0,
    contractFieldRows: 0 };
  step('audit: no patient at B before acceptance, no actor on cross-facility rows, no content or identifier in any row');
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
