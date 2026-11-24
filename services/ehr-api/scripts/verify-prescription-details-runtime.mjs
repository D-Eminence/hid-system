#!/usr/bin/env node
// The prescriber's priority, strength, dose form, duration and quantity to
// dispense on this facility's own pharmacy work (0125,
// docs/INTERFACE_CONTRACT.md section 46) end to end, over HTTP, with the
// setting on: Identity, EHR and Pharmacy each booted from its own source (its
// own main.ts) in its own process, each connected as its exact runtime role,
// EHR and Pharmacy with PRESCRIPTION_DISPENSING_DETAILS_ENABLED=true, the
// services calling each other over loopback with local-secret workload
// identity. Only the outbound boundaries are local stubs: QoreID (for
// facility sign-up) and notification-api's OTP and staff-invitation routes,
// on one loopback server; a preload refuses every other non-loopback request.
// All values are synthetic. It runs only against the owned disposable
// synthetic rehearsal or, with
// HID_PRESCRIPTION_DETAILS_RUNTIME_LOCAL_CLUSTER=loopback, a disposable copy
// of a database on a loopback test cluster.
//
// Why it exists: pharmacy-api reads pharmacy.work_item_prescription_details
// in a savepoint and answers without the details whatever goes wrong (a
// missing EXECUTE, a schema without 0125, a setting left off), so an HTTP 200
// without them is a silent failure. The unit tests mock the database; this
// calls the real function through the real service as
// hid_pharmacy_api_runtime, and fails loudly when an own work item the
// pharmacist may read comes back without the details its prescription was
// written with.
//
// The flow: a hospital and a pharmacy sign up (P4) and support reviews them
// (P4b); the hospital invites two pharmacists (P4b). The patient approves, in
// the app, the doctor's access, one pharmacist's (the other holds no consent)
// and the pharmacy's administrator's at the pharmacy. The doctor writes,
// through ehr-api, a prescription with all seven details (the EHR echoes them
// and its list says dispensingDetails: true) and one without any, both active,
// so each goes to the hospital's own pharmacy by itself (0133, ORD-2): own
// work. Checked: the own work item of the first, on the pharmacist's list and
// read by id, carries exactly the prescriber's priority, strength, form,
// duration and quantity; the second carries none of them; the pharmacist
// without consent, the facility's own pharmacy staff, sees the work since
// 0133 (ORD-2) but no detail, on the list or by id (0125's details still need
// the member's consent). Route-backed work (a prescription with all seven details
// sent to the pharmacy as a draft, which the send activates, and accepted at
// its counter) carries no detail, on the
// list and by id, though its reader holds the patient's consent at that
// facility (its details would come from the sending facility's route: item
// 4b, later). Owner SQL is used only for what no route does: the platform
// administrator's and the patient's accounts (as the other runtime verifiers
// seed them), QoreID switched on, and reading what the database holds.
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
const loopback = process.env.HID_PRESCRIPTION_DETAILS_RUNTIME_LOCAL_CLUSTER === 'loopback'
  && ['127.0.0.1', '::1', 'localhost'].includes(socket ?? '')
  && /^[a-z][a-z0-9_]{0,40}$/.test(process.env.PGDATABASE ?? '');
assert(process.env.NODE_ENV === 'test' && (rehearsal || loopback),
  'Only the owned synthetic rehearsal or an explicitly named loopback test cluster is supported');
assert(process.env.OTP_HMAC_KEY_B64, 'The rehearsal OTP HMAC key is required');
assert(process.env.AUTH_SIGNING_SECRET && process.env.AUTH_LOGIN_PEPPER, 'Synthetic session keys are required');
const port = Number(process.env.PGPORT ?? 5432);
const pgUser = process.env.PGUSER ?? 'postgres';
const isolated = `${rehearsal ? 'hid_rehearsal' : process.env.PGDATABASE}_rxdetails_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const databaseUrl = role => {
  const options = `options=${encodeURIComponent(`-c role=${role}`)}`;
  return rehearsal
    ? `postgresql://${pgUser}@localhost:${port}/${isolated}?host=${encodeURIComponent(socket)}&${options}`
    : `postgresql://${pgUser}@${socket === '::1' ? '[::1]' : socket}:${port}/${isolated}?${options}`;
};
// The setting under test, as ehr-api and pharmacy-api read it.
const PRESCRIPTION_DISPENSING_DETAILS_ENABLED = 'true';

const appOrigin = 'https://app.healthidentitydirectory.com';
const ehrOrigin = 'https://ehr.healthidentitydirectory.com';
const pharmacyOrigin = 'https://pharmacy.healthidentitydirectory.com';
const adminOrigin = 'https://admin.healthidentitydirectory.com';
const CORS = [appOrigin, ehrOrigin, pharmacyOrigin, adminOrigin, 'https://healthidentitydirectory.com'].join(',');
const secret = label => `synthetic-${label}-${randomBytes(16).toString('hex')}`;
const tokens = { identityEhr: secret('identity-ehr'), identityLab: secret('identity-lab'),
  identityPharmacy: secret('identity-pharmacy'), lab: secret('lab-workload'), pharmacy: secret('pharmacy-workload'),
  ehr: secret('ehr-workload'), notification: secret('notification-workload') };

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
        answer(200, { id: 995000 + companies.size, summary: { cac_check: 'verified' },
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

const maintenance = new Pool({ host: socket, port, user: pgUser, database: 'postgres', max: 1 });
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
const owner = new Pool({ host: socket, port, user: pgUser, database: isolated, max: 3 });
const one = async (sql, values = []) => (await owner.query(sql, values)).rows[0];
const all = async (sql, values = []) => (await owner.query(sql, values)).rows;
// 0114: the sign-up fields Health ID collects (fictional values), and the
// synthetic key Identity encrypts the applicant's phone with in this run.
const signupCollectedFields = (label) => ({
  administratorRole: 'owner',
  administratorPhone: '+2348000000101',
  facilityProfile: {
    tradingName: `Verifier ${label} Clinic`, ownership: 'private', careLevel: 'secondary',
    addressLine: '1 Synthetic Site Road, Ikeja', city: 'Lagos', stateCode: 'LA', lga: 'Ikeja',
    gpsLatitude: 6.6018, gpsLongitude: 3.3515, phone: '+2348000000102', email: 'front.desk@verifier.invalid',
    bedCount: 10, operatingHours: 'Mon-Sun 24 hours', emergency24h: true,
    departments: ['general_outpatient', 'pharmacy'], servicesOffered: 'Synthetic outpatient and pharmacy care',
    smohLicenceNumber: 'LSMOH/VERIFIER/0001', hasRegistryId: false, registryId: null,
    hasNhiaAccreditation: false, nhiaAccreditationNumber: null, medicalDirectorName: 'Dr Verifier Example',
    medicalDirectorMdcn: 'MDCN/00001', expectedStaff: 5, migratingRecords: false, needsInteroperability: false,
  },
});
const collectedFieldsKey = randomBytes(32).toString('base64');
const temporary = await mkdtemp(join(tmpdir(), 'hid-prescription-details-'));
const evidence = { setting: { PRESCRIPTION_DISPENSING_DETAILS_ENABLED, services: ['ehr-api', 'pharmacy-api'] }, steps };
const startedAt = Date.now();
let failure;
try {
  // The database holds 0125's reader and its seven columns (its grants are what this run proves over HTTP, not read here).
  const reader = await all(`select proc.oid::regprocedure::text as name from pg_proc proc
    where proc.proname = 'work_item_prescription_details' and proc.pronamespace = 'pharmacy'::regnamespace`);
  assert.deepEqual(reader.map(row => row.name), ['pharmacy.work_item_prescription_details(uuid[])'], 'a database with 0125');
  const columns = await one(`select count(*)::int as n from pg_attribute where attrelid = 'ehr.prescriptions'::regclass
    and not attisdropped and attname in ('priority', 'medication_strength', 'medication_dose_form', 'duration_value',
      'duration_unit', 'quantity_to_dispense', 'quantity_unit')`);
  assert.equal(columns.n, 7, 'ehr.prescriptions with 0125\'s seven columns');
  evidence.database = { reader: reader[0].name, prescriptionColumns: columns.n };
  await new Promise(done => stub.listen(0, '127.0.0.1', done));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const preload = join(temporary, 'loopback-only.cjs');
  await writeFile(preload, preloadSource);
  // Fixture: the platform has enabled QoreID CAC verification (an admin action).
  await owner.query("update platform.integration_providers set enabled=true, row_version=row_version+1 where provider='qoreid'");

  // Each runtime URL sets its role; the same URL proves it.
  const runtimeRoles = {};
  for (const role of ['hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_pharmacy_api_runtime']) {
    const client = new Client({ connectionString: databaseUrl(role) });
    await client.connect();
    runtimeRoles[role] = (await client.query('select current_user as role')).rows[0].role;
    await client.end();
    assert.equal(runtimeRoles[role], role);
  }
  evidence.runtimeRoles = Object.keys(runtimeRoles);

  // No Lab: nothing here hands work to it, so ehr-api is given a loopback port nothing listens on.
  const [identityPort, ehrPort, pharmacyPort, unusedLabPort] = await Promise.all([1, 2, 3, 4].map(() => freePort()));
  const common = { HID_VERIFIER_PRELOAD: preload, HID_VERIFIER_STUB_URL: stubUrl, CORS_ORIGINS: CORS,
    TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128' };
  const local = value => `http://127.0.0.1:${value}`;
  const [identity, ehr, pharmacy] = await Promise.all([
    boot('identity-api', join(services, 'identity-api'), { ...common, DATABASE_URL: databaseUrl('hid_identity_api_runtime'),
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET, AUTH_LOGIN_PEPPER: process.env.AUTH_LOGIN_PEPPER,
      OTP_HMAC_KEY_B64: process.env.OTP_HMAC_KEY_B64, AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'production',
      NIN_ENCRYPTION_KEY_B64: collectedFieldsKey, NIN_KEY_VERSION: 'verifier-v1',
      NIN_PROVIDER_MODE: 'unavailable', TURNSTILE_MODE: 'disabled', QOREID_ENABLED: 'true',
      QOREID_CLIENT_ID: 'example-qoreid-client', QOREID_CLIENT_SECRET: 'example-qoreid-secret',
      IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: tokens.identityEhr,
      IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: tokens.identityLab, IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.identityPharmacy,
      NOTIFICATION_API_URL: stubUrl, NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret',
      NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: tokens.notification, PATIENT_LIFECYCLE_SWEEP_SECONDS: '0' }, identityPort),
    boot('ehr-api', join(services, 'ehr-api'), { ...common, DATABASE_URL: databaseUrl('hid_ehr_api_runtime'),
      STORAGE_MODE: 'disabled', IDENTITY_API_URL: local(identityPort), IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: tokens.identityEhr,
      LAB_API_URL: local(unusedLabPort), LAB_INTERNAL_SERVICE_TOKEN: tokens.lab, PHARMACY_API_URL: local(pharmacyPort),
      PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy, EHR_INTERNAL_SERVICE_TOKEN: tokens.ehr,
      PRESCRIPTION_DISPENSING_DETAILS_ENABLED }, ehrPort),
    boot('pharmacy-api', join(services, 'pharmacy-api'), { ...common, DATABASE_URL: databaseUrl('hid_pharmacy_api_runtime'),
      IDENTITY_API_URL: local(identityPort), IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.identityPharmacy,
      PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy, PRESCRIPTION_DISPENSING_DETAILS_ENABLED }, pharmacyPort),
  ]);
  step(`three services booted from their own code; ehr-api and pharmacy-api with PRESCRIPTION_DISPENSING_DETAILS_ENABLED=${PRESCRIPTION_DISPENSING_DETAILS_ENABLED}`);

  // ── Support, the facilities (P4 sign-up, P4b review) and the hospital's own pharmacists (P4b) ──
  const password = 'Synthetic-Prescription-Details-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const synthetic = label => `rxdetails-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const signInStaff = async (email, host, facilityId, name) => {
    const response = await http(identity, 'POST', '/auth/login', { origin: host.origin,
      body: { email, password, turnstileAction: host.action } });
    expectStatus(response, 200, `sign-in ${email}`);
    return { email, name, origin: host.origin, facilityId, accountId: response.body.actor.accountId,
      csrf: response.headers.get('x-csrf-token'), cookie: response.cookies.join('; ') };
  };
  const HOSTS = { ehr: { origin: ehrOrigin, action: 'staff-login' },
    pharmacy: { origin: pharmacyOrigin, action: 'pharmacy-login' }, admin: { origin: adminOrigin, action: 'admin-login' } };
  const supportAccount = randomUUID();
  const supportEmail = synthetic('support');
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
    values ($1, $2, $3, 'Synthetic Support', $4, 'argon2id', 'active')`,
  [supportAccount, `synthetic:platform-admin:${supportAccount}`, supportEmail, passwordHash]);
  await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
    values ($1, $2, 'platform_super_admin', 'platform', 'Synthetic platform administrator for the prescription details verifier')`,
  [randomUUID(), supportAccount]);
  const support = await signInStaff(supportEmail, HOSTS.admin, undefined, 'Synthetic Support');
  const adminCall = (method, path, body, extra = {}) => http(identity, method, path, { cookie: support.cookie,
    ...(method === 'GET' ? {} : { origin: adminOrigin, csrf: support.csrf }), body, ...extra });
  const setControl = async (controlKey, enabled) => {
    const list = expectStatus(await adminCall('GET', '/admin/controls'), 200, 'controls');
    const control = list.find(item => item.controlKey === controlKey);
    assert(control, `control ${controlKey} missing`);
    if (control.enabled === enabled) return;
    expectStatus(await adminCall('POST', '/admin/controls', { controlKey, enabled,
      reason: `Prescription details verifier: ${controlKey} ${enabled ? 'on' : 'off'}` }, { ifMatch: control.version }), 201,
    `control ${controlKey}`);
  };
  await setControl('provider_self_service_enabled', true);
  await setControl('staff_invitations_enabled', true);
  await setControl('cross_facility_orders_enabled', true);

  let signUps = 0;
  const signUp = async ({ label, organizationType, productCode, administratorName }) => {
    signUps += 1;
    const cac = `RC99300${String(88000 + signUps)}`;
    companies.set(cac, { name: `Verifier ${label} ${cac} Ltd`, address: `${signUps} Synthetic Prescription Road, Ikeja, Lagos` });
    const email = synthetic(`admin-${signUps}`);
    const started = await http(identity, 'POST', '/identity/provider-enrollments', { origin: appOrigin,
      forwardedFor: `198.51.180.${signUps}`, body: { cacRegistrationNumber: cac, administratorEmail: email, organizationType,
        productCode, administratorName, turnstileAction: 'provider-enrollment', turnstileToken: 'disabled-in-this-run',
        ...signupCollectedFields(label) } });
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
    return { label, email, administratorName, name: facility.name, facilityId: activated.body.facilityId,
      applicationId: facility.application_id };
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
  const pharmacyFacility = await signUp({ label: 'Pharmacy', organizationType: 'pharmacy', productCode: 'pharmacy',
    administratorName: 'Chioma Eze' });
  await review(hospital, 'doctor', { body: 'MDCN', number: 'MDCN/73011' });
  await review(pharmacyFacility, 'pharmacist', { body: 'PCN', number: 'PCN/73033' });
  const doctor = await signInStaff(hospital.email, HOSTS.ehr, hospital.facilityId, hospital.administratorName);
  const pharmacist = await signInStaff(pharmacyFacility.email, HOSTS.pharmacy, pharmacyFacility.facilityId,
    pharmacyFacility.administratorName);
  const call = (base, who, method, path, body, extra = {}) => http(base, method, path, { cookie: who.cookie,
    facility: who.facilityId, purpose: 'direct-care', ...(method === 'GET' ? {} : { origin: who.origin, csrf: who.csrf }),
    body, ...extra });
  const freshKey = label => `verifier-${label}-${randomUUID()}`;
  let invitations = 0;
  const invited = async (admin, host, facilityId, person) => {
    invitations += 1;
    const before = invitationEmails.length;
    const answer = expectStatus(await call(identity, admin, 'POST', '/identity/staff-invitations',
      { ...person, attested: true, currentPassword: password }, { key: freshKey('invite') }), 201, `invite ${person.email}`);
    assert.equal(answer.deliveryOutcome, 'accepted');
    const sentEmail = invitationEmails[before];
    assert(sentEmail, 'invitation email');
    const openInvitation = forwardedFor => http(identity, 'POST', '/identity/staff-invitations/open', { origin: appOrigin,
      forwardedFor, body: { invitationId: sentEmail.invitationId, token: sentEmail.token, turnstileAction: 'staff-invitation' } });
    expectStatus(await openInvitation(`198.51.181.${invitations}`), 200, 'open invitation');
    const opened = await openInvitation(`198.51.182.${invitations}`);
    expectStatus(await http(identity, 'POST', '/identity/staff-invitations/accept', { origin: appOrigin,
      cookie: opened.cookies.find(value => value.startsWith('hid_staff_invitation=')), body: { password } }), 200,
    'accept invitation');
    return signInStaff(person.email, host, facilityId, person.name);
  };
  const ownPharmacist = await invited(doctor, HOSTS.pharmacy, hospital.facilityId, { name: 'Musa Ownpharm',
    email: synthetic('pharmacist'), role: 'pharmacist', licenceBody: 'PCN', licenceNumber: 'PCN/83033' });
  const pharmacistWithoutConsent = await invited(doctor, HOSTS.pharmacy, hospital.facilityId, { name: 'Ngozi Noconsent',
    email: synthetic('pharmacist-no-consent'), role: 'pharmacist', licenceBody: 'PCN', licenceNumber: 'PCN/83044' });
  step('a hospital and a pharmacy signed up and reviewed; two pharmacists invited at the hospital');

  // ── The patient: an app account; access approved in the app for three members, one pharmacist left without consent ──
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const healthIdOf = () => `HID-${Array.from(randomBytes(10), byte => alphabet[byte % alphabet.length]).join('')}`;
  const patientAccount = randomUUID();
  const patient = { id: randomUUID(), hid: healthIdOf(), email: synthetic('patient'), fullName: 'Bisi Verifier-Rxdetails',
    sex: 'female', dob: '1979-03-14' };
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
    values ($1, $2, $3, $4, $5, 'argon2id', 'active')`,
  [patientAccount, `synthetic:patient:${patientAccount}`, patient.email, patient.fullName, passwordHash]);
  await owner.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob,
      status) values ($1, $2, $3, 'Bisi', 'Verifier-Rxdetails', $4, $5, $6, 'active')`,
  [patient.id, patientAccount, patient.hid, patient.fullName, patient.sex, patient.dob]);
  const loggedIn = await http(identity, 'POST', '/auth/patient/login', { origin: appOrigin,
    body: { email: patient.email, password, turnstileAction: 'patient-login' } });
  expectStatus(loggedIn, 200, 'patient sign-in');
  const patientSession = { cookie: loggedIn.cookies.join('; '), csrf: loggedIn.headers.get('x-csrf-token') };
  const patientCall = (method, path, body) => http(identity, method, path, { cookie: patientSession.cookie,
    ...(method === 'GET' ? {} : { origin: appOrigin, csrf: patientSession.csrf }), body });
  const approvedAccess = async (who, scope) => {
    const requested = expectStatus(await call(identity, who, 'POST', '/identity/access-requests',
      { hid: patient.hid, scope, reason: 'Synthetic visit for the prescription details verifier', durationMinutes: 1440 }),
    201, `access request ${who.name} ${scope}`);
    const approved = expectStatus(await patientCall('POST', `/identity/access-requests/${requested.accessRequestId}/approve`),
      200, `approve ${who.name} ${scope}`);
    assert.equal(approved.status, 'approved');
  };
  await approvedAccess(doctor, 'write_records');
  await approvedAccess(ownPharmacist, 'write_records');
  await approvedAccess(pharmacist, 'read_records');
  const grantsOf = async who => (await one(`select count(*)::int as n from identity.consent_grants grant_row
    join identity.staff_facility_memberships membership on membership.id = grant_row.membership_id
    where membership.account_id = $1 and grant_row.patient_id = $2`, [who.accountId, patient.id])).n;
  assert.equal(await grantsOf(pharmacistWithoutConsent), 0, 'the pharmacist left without consent holds no grant for the patient');
  step('the patient approved the doctor, one own pharmacist and the receiving pharmacy\'s administrator in the app');

  // ── The prescriptions, through ehr-api with the setting on ──
  const ehrCall = (who, method, path, body, extra) => call(ehr, who, method, `/ehr/patients/${patient.id}${path}`, body, extra);
  const pharmacyCall = (who, method, path, body, extra) => call(pharmacy, who, method, `/pharmacy${path}`, body, extra);
  const encounter = expectStatus(await ehrCall(doctor, 'POST', '/encounters', { encounterType: 'ambulatory',
    status: 'in_progress', startedAt: new Date().toISOString(), chiefComplaint: 'Synthetic chief complaint' },
  { key: freshKey('encounter') }), 201, 'encounter');
  const enc = `/encounters/${encounter.id}`;
  // The seven values as the prescriber writes them, and as Pharmacy must answer them.
  const written = { priority: 'urgent', strength: '500 mg', doseForm: 'capsule', durationValue: 7, durationUnit: 'day',
    quantityToDispense: 21, quantityUnit: 'capsule' };
  const expectedDetails = { priority: 'urgent', strength: '500 mg', doseForm: 'capsule', duration: { value: 7, unit: 'day' },
    quantityToDispense: 21, quantityUnit: 'capsule' };
  const newPrescription = async (status, details) => {
    const response = await ehrCall(doctor, 'POST', `${enc}/prescriptions`,
      { medicationCodeSystem: 'http://snomed.info/sct', medicationCode: '27658006',
        medicationDisplay: 'Synthetic amoxicillin 500 mg capsule', doseQuantity: 1, doseUnit: 'capsule', routeCode: 'oral',
        frequency: 'three times daily', instructions: 'Synthetic instructions: finish the course', status, ...details },
      { key: freshKey('prescription') });
    assert.notEqual(response.status, 400, `ehr-api refused the prescription's details, so it did not take them `
      + `(PRESCRIPTION_DISPENSING_DETAILS_ENABLED=${PRESCRIPTION_DISPENSING_DETAILS_ENABLED}): ${JSON.stringify(response.body)}`);
    return expectStatus(response, 201, 'prescription');
  };
  const pick = (body, keys) => Object.fromEntries(keys.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  const detailKeys = Object.keys(written);
  const withDetails = await newPrescription('active', written);
  assert.deepEqual(pick(withDetails, detailKeys), written, 'ehr-api echoes the seven details it stored');
  const withoutDetails = await newPrescription('active', {});
  assert.deepEqual(pick(withoutDetails, detailKeys), {}, 'a prescription written without details answers none');
  const prescriptionList = expectStatus(await ehrCall(doctor, 'GET', `${enc}/prescriptions`), 200, 'prescription list');
  assert.equal(prescriptionList.dispensingDetails, true, 'ehr-api\'s prescription list says a create may carry the details');
  const stored = await one(`select priority, medication_strength, medication_dose_form, duration_value, duration_unit,
      quantity_to_dispense::text as quantity_to_dispense, quantity_unit from ehr.prescriptions where id = $1`, [withDetails.id]);
  assert.deepEqual(stored, { priority: 'urgent', medication_strength: '500 mg', medication_dose_form: 'capsule',
    duration_value: 7, duration_unit: 'day', quantity_to_dispense: '21.0000', quantity_unit: 'capsule' },
  'ehr.prescriptions holds the seven values');
  evidence.ehr = { created: { withDetails: Object.keys(pick(withDetails, detailKeys)).length, withoutDetails: 0 },
    listSays: { dispensingDetails: true }, stored: 'the seven columns' };
  step('ehr-api took and echoed the seven details on a new prescription, stored them, and says so on its list');

  // ── Own work: both active prescriptions went to the hospital's own pharmacy by themselves (0133) ──
  assert.deepEqual([withDetails.pharmacyHandoff, withoutDetails.pharmacyHandoff],
    [{ status: 'sent', message: 'Sent to this hospital\'s pharmacy.' }, { status: 'sent', message: 'Sent to this hospital\'s pharmacy.' }],
    `the automatic sends: ${JSON.stringify([withDetails.pharmacyHandoff, withoutDetails.pharmacyHandoff])}`);
  step('own work: both active prescriptions sent to the hospital\'s own pharmacy by themselves');

  // Fails loudly: an own work item the pharmacist may read (it is on their list) without the details its
  // prescription was written with. The service's own warning, if it logged one, names the SQLSTATE
  // (42501: no EXECUTE; 42883: no 0125).
  const readerWarning = () => {
    const log = (childLogs.get('pharmacy-api') ?? []).join('').replace(/\x1b\[[0-9;]*m/g, '');
    const at = log.lastIndexOf('Prescription details on own work could not be read');
    if (at < 0) return 'it logged no reader warning';
    const sqlState = /sqlState:\s*'([0-9A-Z]{5}|unknown)'/.exec(log.slice(at, at + 300))?.[1] ?? 'unknown';
    return `it logged 'Prescription details on own work could not be read', SQLSTATE ${sqlState}`;
  };
  const detailsOf = item => ({
    ...(item.priority === undefined ? {} : { priority: item.priority }),
    ...(item.medication?.strength === undefined ? {} : { strength: item.medication.strength }),
    ...(item.medication?.doseForm === undefined ? {} : { doseForm: item.medication.doseForm }),
    ...(item.duration === undefined ? {} : { duration: item.duration }),
    ...(item.quantityToDispense === undefined ? {} : { quantityToDispense: item.quantityToDispense }),
    ...(item.quantityUnit === undefined ? {} : { quantityUnit: item.quantityUnit }),
  });
  const requireDetails = (item, how) => {
    const shown = detailsOf(item);
    assert(Object.keys(shown).length > 0, `pharmacy-api answered own work item ${item.id} (${how}), which `
      + `${ownPharmacist.name} may read, without the prescriber's details: pharmacy.work_item_prescription_details through `
      + `hid_pharmacy_api_runtime gave nothing or was not called (PRESCRIPTION_DISPENSING_DETAILS_ENABLED=`
      + `${PRESCRIPTION_DISPENSING_DETAILS_ENABLED}; the service answers 200 whatever the reader does; ${readerWarning()})`);
    assert.deepEqual(shown, expectedDetails, `pharmacy-api: the details on own work item ${item.id} (${how})`);
  };
  const ownList = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, 'own Pharmacy list');
  const ownWith = ownList.items.find(item => item.sourceEhrPrescriptionId === withDetails.id);
  const ownWithout = ownList.items.find(item => item.sourceEhrPrescriptionId === withoutDetails.id);
  assert(ownWith && ownWithout, `the automatic sends did not reach the hospital's Pharmacy: ${JSON.stringify(ownList.items.map(item => item.sourceEhrPrescriptionId))}`);
  assert.deepEqual([ownWith.orderRoute, ownWithout.orderRoute], [undefined, undefined], 'own work has no route');
  assert.deepEqual([ownWith.patientId, ownWithout.patientId], [patient.id, patient.id]);
  requireDetails(ownWith, 'on the list');
  const ownWithRead = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${ownWith.id}`), 200,
    'own Pharmacy item');
  requireDetails(ownWithRead, 'read by id');
  assert.deepEqual(detailsOf(ownWithout), {}, `own work item ${ownWithout.id} without details on its prescription shows some`);
  const ownWithoutRead = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${ownWithout.id}`), 200,
    'own Pharmacy item without details');
  assert.deepEqual(detailsOf(ownWithoutRead), {}, 'own work item without details, read by id');
  // The pharmacist without consent (0133: the facility's own pharmacy staff) sees the work, never a detail: 0125's
  // details still need the member's consent.
  const answerKeys = ['priority', 'strength', 'doseForm', 'duration', 'quantityToDispense', 'quantityUnit'];
  const keysIn = value => JSON.stringify(value ?? '').match(new RegExp(`"(${answerKeys.join('|')})":`, 'g')) ?? [];
  const noConsent = expectStatus(await pharmacyCall(pharmacistWithoutConsent, 'GET', '/work-items'), 200,
    'Pharmacy list without consent');
  assert.deepEqual(noConsent.items.filter(item => [ownWith.id, ownWithout.id].includes(item.id)).map(item => item.id).sort(),
    [ownWith.id, ownWithout.id].sort(), 'the facility\'s own Pharmacy work listed to its pharmacist without consent (0133)');
  assert.deepEqual(keysIn(noConsent.items), [], 'prescription details shown to a pharmacist without consent');
  const noConsentRead = expectStatus(await pharmacyCall(pharmacistWithoutConsent, 'GET', `/work-items/${ownWith.id}`), 200,
    'own Pharmacy item read without consent (own-work basis)');
  assert.deepEqual(keysIn(noConsentRead), [], `a detail in the own-work read: ${JSON.stringify(detailsOf(noConsentRead))}`);
  evidence.own = { listed: 2, withDetails: { onList: expectedDetails, readById: 'the same' },
    withoutDetails: { onList: 'none', readById: 'none' },
    ownWorkWithoutConsent: { listed: 2, details: 0, read: 200, readDetails: 0 } };
  step('own work carries the prescriber\'s details on the list and by id; none without them; the facility\'s pharmacist '
    + 'without consent sees the work and no detail (0133)');

  // ── Route-backed work carries none, though its reader holds the patient's consent at that facility ──
  const attestationVersion = async kind => expectStatus(await call(ehr, doctor, 'GET', `/ehr/order-route-attestation?kind=${kind}`),
    200, `attestation ${kind}`).version;
  // 0133: an active one would have gone to the hospital's own pharmacy by itself; a draft is activated by the send.
  const routed = await newPrescription('draft', written);
  const route = expectStatus(await ehrCall(doctor, 'POST', `${enc}/prescriptions/${routed.id}/order-routes`,
    { expectedRowVersion: Number(routed.rowVersion), receivingFacilityId: pharmacyFacility.facilityId, patientAgreed: true,
      attestationTextVersion: await attestationVersion('prescription') }, { key: freshKey('send') }), 201,
  'send prescription').route;
  const accepted = expectStatus(await call(pharmacy, pharmacist, 'POST', `/pharmacy/order-routes/${route.id}/accept`,
    { expectedVersion: 1, patientIdentifier: { kind: 'date_of_birth', value: patient.dob },
      reason: 'Synthetic acceptance with the patient at the counter' }, { key: freshKey('accept') }), 201, 'pharmacy accepts');
  const routedList = expectStatus(await pharmacyCall(pharmacist, 'GET', '/work-items'), 200, 'receiving Pharmacy list');
  const routedItem = routedList.items.find(item => item.id === accepted.workItemId);
  assert(routedItem, `route-backed work item ${accepted.workItemId} not on the receiving pharmacy's list`);
  assert.equal(routedItem.orderRoute?.access, 'work', 'the receiving pharmacy\'s route card');
  assert.deepEqual(detailsOf(routedItem), {},
    `pharmacy-api gave route-backed work item ${routedItem.id} details: ${JSON.stringify(detailsOf(routedItem))}`);
  const routedRead = expectStatus(await pharmacyCall(pharmacist, 'GET', `/work-items/${accepted.workItemId}`), 200,
    'route-backed Pharmacy item');
  assert.deepEqual(detailsOf(routedRead), {}, 'a route-backed item read by id carries no details');
  assert.equal(await grantsOf(pharmacist) > 0, true, 'the receiving administrator holds the patient\'s consent');
  evidence.routeBacked = { listed: true, access: 'work', details: 'none', readById: 'none',
    readerHoldsConsentAtItsFacility: true };
  step('route-backed work carries no details, on the list and by id, though its reader holds consent');

  // ── ORD-7 (0149), first slice: the national lists' status and search ──
  // No X-Purpose-Of-Use (the lists hold no patient), so these calls send none.
  const catalogGet = (who, path) => http(ehr, 'GET', `/ehr/catalog${path}`, { cookie: who.cookie, facility: who.facilityId });
  const notLoaded = { available: false, version: null, approvedAt: null, fileSha256: null };
  const statusBefore = await catalogGet(doctor, '/status');
  assert.deepEqual(expectStatus(statusBefore, 200, 'catalogue status before a list is loaded'), {
    medicines: notLoaded, labTests: notLoaded, diagnoses: { available: false, release: null, fileSha256: null },
    labTestNameOnly: false, diagnosisNameOnly: false, classDuplicateCheck: false, attribution: [] },
  'before a signed list is loaded nothing is available');
  assert.equal(statusBefore.headers.get('cache-control'), 'private, max-age=60',
    'the catalogue answers may be kept a minute by this user\'s browser (the route header wins over the global no-store)');
  assert.deepEqual(expectStatus(await catalogGet(doctor, '/medicines?q=amox'), 200, 'medicine search before a list'),
    { listVersion: null, more: false, items: [] }, 'a search before a list is loaded answers nothing');
  step('ORD-7: before a signed list is loaded the status says not available and a search answers nothing, '
    + 'with no purpose of use, kept a minute by the browser');

  // A list loaded as the governed loader of a later slice will (owner SQL: no route loads a list): the versions
  // (still loading), their rows, then the switch, which seals them. Synthetic rows.
  const loincNotice = 'Synthetic notice: this material contains content from LOINC (http://loinc.org).';
  const [medicineVersion, labVersion] = [randomUUID(), randomUUID()];
  await owner.query(`insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference,
      approvals_sha256, approved_at, attribution) values
    ($1, 'medicine', '2026.1', repeat('a', 64), 'synthetic sign-off reference', repeat('1', 64),
     '2026-12-01T09:00:00+01:00', '{}'),
    ($2, 'lab_test', '2026.1', repeat('b', 64), 'synthetic sign-off reference', repeat('1', 64),
     '2026-12-01T09:00:00+01:00', $3)`,
  [medicineVersion, labVersion, [loincNotice]]);
  await owner.query(`insert into ehr.catalog_medicines (version_id, list_id, generic_name, other_names, strength,
      dose_form, dose_form_text, routes, atc_code, common_adult_dose, source) values
    ($1, 'MED-00001', 'amoxicillin', 'Amoxil', '500 mg', 'capsule', 'Capsule', '{oral}', 'J01CA04',
     'Synthetic hint: 500 mg every 8 hours', 'nigeria-eml-8'),
    ($1, 'MED-00002', 'amoxicillin + clavulanic acid', 'co-amoxiclav', '625 mg', 'tablet', 'Tablet', '{oral}', null,
     null, 'nigeria-eml-8'),
    ($1, 'MED-00003', 'paracetamol', 'acetaminophen', '500 mg', 'tablet', 'Tablet', '{oral}', null, null, 'who-eml-24')`,
  [medicineVersion]);
  await owner.query(`insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display, other_names,
      specimen, category, source) values ($1, 'LAB-0001', 'LOINC', '57021-8', 'Full blood count', 'FBC; CBC',
      'Blood (EDTA)', 'haematology', 'hid-common-tests')`, [labVersion]);
  await owner.query('update ehr.catalog_versions set active = true where id = any($1::uuid[])',
    [[medicineVersion, labVersion]]);
  const loaded = seed => ({ available: true, version: '2026.1', approvedAt: '2026-12-01', fileSha256: seed.repeat(64) });
  assert.deepEqual(expectStatus(await catalogGet(ownPharmacist, '/status'), 200, 'catalogue status after a list'),
    { medicines: loaded('a'), labTests: loaded('b'), diagnoses: { available: false, release: null, fileSha256: null }, labTestNameOnly: false,
      diagnosisNameOnly: false, classDuplicateCheck: false, attribution: [loincNotice] },
  'a loaded list is available with its version, its sign-off day (Lagos), its seed file and its sources\' notices');
  const firstAmox = expectStatus(await catalogGet(doctor, '/medicines?q=Amox&limit=1'), 200, 'doctor searches medicines');
  assert.deepEqual(firstAmox, { listVersion: '2026.1', more: true, items: [{ codeSystem: 'HID-MED', code: 'MED-00001',
    display: 'Amoxicillin 500 mg capsule', genericName: 'amoxicillin', strength: '500 mg', doseForm: 'capsule',
    doseFormText: 'Capsule', routes: ['oral'], atcCode: null, commonAdultDose: 'Synthetic hint: 500 mg every 8 hours',
    matchedName: null, scope: 'national', source: 'nigeria-eml-8' }] },
  'the prescriber finds a medicine by the start of its name; no ATC code until its terms are settled');
  const coAmox = expectStatus(await catalogGet(ownPharmacist, '/medicines?q=co-amox&doseForm=tablet&route=Oral'), 200,
    'pharmacist searches medicines');
  assert.deepEqual(coAmox.items.map(item => [item.code, item.matchedName]), [['MED-00002', 'co-amoxiclav']],
    'the pharmacist finds a medicine by another name, with the dose form and route filters');
  const fbc = expectStatus(await catalogGet(doctor, '/lab-tests?q=fbc'), 200, 'doctor searches lab tests');
  assert.deepEqual(fbc, { listVersion: '2026.1', more: false, items: [{ codeSystem: 'LOINC', code: '57021-8',
    display: 'Full blood count', otherNames: ['FBC', 'CBC'], specimen: 'Blood (EDTA)', category: 'haematology',
    matchedName: 'FBC', scope: 'national' }] }, 'the requester finds a lab test by its short name');
  step('ORD-7: a loaded list is available; the prescriber and the pharmacist find medicines and the requester lab '
    + 'tests by the start of a name or another name');

  const refused = async (who, path, status, code, label) => {
    const response = await catalogGet(who, path);
    assert.equal(response.status, status, `${label}: ${response.status} ${JSON.stringify(response.body)}`);
    assert.equal(response.body?.code, code, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store', `${label}: a refusal is never kept`);
  };
  await refused(doctor, '/medicines?q=a', 400, 'CATALOG_SEARCH_TEXT_TOO_SHORT', 'q of 1 letter');
  await refused(doctor, `/medicines?q=${encodeURIComponent(patient.hid)}`, 400, 'CATALOG_SEARCH_TEXT_NOT_ALLOWED',
    'a Health ID as q');
  await refused(doctor, '/lab-tests?q=123%204567%208901', 400, 'CATALOG_SEARCH_TEXT_NOT_ALLOWED', 'an 11-digit NIN as q');
  await refused(doctor, '/medicines?q=amox&doseForm=pessary', 400, 'VALIDATION_FAILED', 'an unknown dose form');
  await refused(pharmacistWithoutConsent, '/lab-tests?q=fbc', 403, 'PERMISSION_DENIED',
    'a pharmacist with no lab permission searches lab tests');
  const asPatient = await http(ehr, 'GET', '/ehr/catalog/status', { cookie: patientSession.cookie,
    facility: hospital.facilityId });
  assert([401, 403].includes(asPatient.status), `a patient's session is refused: ${asPatient.status}`);
  const catalogAudit = await all(`select outcome, action, details::text as details, coalesce(resource_id, '') as resource_id
    from audit.events where action like '%catalog%' or details->>'route' like '%catalog%'`);
  assert.equal(catalogAudit.filter(row => row.outcome === 'success').length, 0, 'a search that answers writes no audit row');
  assert(catalogAudit.length >= 5, `the refusals are audited: ${catalogAudit.length} rows`);
  // A search text counts only as a whole word, in any case. A random id can hold the same letters inside a word:
  // the uuid 493ba984-81a2-4f1a-bf96-7b0b8318fbcb holds fbc, and each group of a uuid is 4 to 12 hex digits, so
  // fbc is never a whole word there. An escape that stands for a separator counts as one: a percent escape (%3D,
  // %20), so a route kept URL-encoded (q%3Dfbc) is still found, and a JSON escape (\n, \t, \u0009), so a text after
  // a line break is too. The database (~*) and this script (flag i) use the same pattern. The Health ID and the NIN
  // below stay plain substrings: too long to turn up by chance, and found even when joined to other text.
  const wordStart = String.raw`^|[^A-Za-z0-9_]|%[0-9A-Fa-f]{2}|\\[bfnrt]|\\u[0-9A-Fa-f]{4}`;
  const wholeWord = words => `(${wordStart})(${words})($|[^A-Za-z0-9_])`;
  assert.deepEqual(await all('select action, details::text as details from audit.events where details::text ~* $1',
    [wholeWord('amox|fbc')]), [], 'no audit row anywhere holds a search text');
  const audited = JSON.stringify(catalogAudit);
  for (const typed of ['amox', 'fbc']) {
    assert(!new RegExp(wholeWord(typed), 'i').test(audited), `the search text ${typed} reached an audit row`);
  }
  for (const typed of [patient.hid, '12345678901', '4567 8901', '4567%208901']) {
    assert(!audited.includes(typed), `the search text ${typed} reached an audit row`);
  }
  evidence.catalog = { before: 'not available, empty search', loaded: { medicines: 3, labTests: 1 },
    searched: ['doctor: medicines, lab tests', 'pharmacist: medicines'], refused: ['short', 'Health ID', 'NIN',
      'dose form', 'no permission', 'patient'], auditRows: { success: 0, refusals: catalogAudit.length, searchText: 0 } };
  step('ORD-7: short text, a Health ID, a NIN, an unknown form, a missing permission and a patient are refused and '
    + 'never kept; only refusals are audited, never with the search text');

  // ── ORD-9 (0150), first slice: the ICD-11 diagnosis search ──
  // Loaded as the governed loader loads it: the release (still loading, with the approvals file's sha256), its
  // entries, then the switch, which seals it (0149, 0150).
  const icdNotice = 'Synthetic notice: ICD-11, World Health Organization, CC BY-ND 3.0 IGO.';
  const diagnosisVersion = randomUUID();
  await owner.query(`insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference,
      approvals_sha256, approved_at, attribution) values ($1, 'diagnosis', '2026-01', repeat('d', 64),
      'synthetic sign-off reference', repeat('1', 64), '2026-12-01T09:00:00+01:00', $2)`, [diagnosisVersion, [icdNotice]]);
  await owner.query(`insert into ehr.catalog_diagnoses (version_id, code, title, other_names, chapter, residual) values
    ($1, '1F40', 'Malaria due to Plasmodium falciparum', 'falciparum malaria', '01', false),
    ($1, 'KA64.20', 'Congenital falciparum malaria', '', '19', false),
    ($1, '1A07', 'Typhoid fever', 'enteric fever; typhoid', '01', false)`, [diagnosisVersion]);
  await owner.query('update ehr.catalog_versions set active = true where id = $1', [diagnosisVersion]);
  const terminologyGet = (who, path) => http(ehr, 'GET', `/ehr/terminology${path}`, { cookie: who.cookie,
    facility: who.facilityId });
  const falciparum = await terminologyGet(doctor, '/diagnoses?q=falciparum&limit=5');
  assert.deepEqual(expectStatus(falciparum, 200, 'doctor searches diagnoses'), { release: 'ICD-11 MMS 2026-01',
    more: false, typedIcd10: null, results: [
      { codeSystem: 'ICD-11', code: '1F40', display: 'Malaria due to Plasmodium falciparum', matchedName: 'falciparum malaria' },
      { codeSystem: 'ICD-11', code: 'KA64.20', display: 'Congenital falciparum malaria', matchedName: null }] },
  'the doctor finds 1F40 first, named by our other name, then the shorter title');
  assert.equal(falciparum.headers.get('cache-control'), 'private, max-age=60', 'a diagnosis answer is kept a minute');
  assert.deepEqual(expectStatus(await terminologyGet(doctor, '/diagnoses?q=B50.9'), 200, 'an ICD-10 code typed'),
    { release: null, more: false, results: [], typedIcd10: { codeSystem: 'ICD-10', code: 'B50.9' } },
  'an ICD-10 code typed is named back as ICD-10, with no title');
  const healthIdAsDiagnosis = await terminologyGet(doctor, `/diagnoses?q=${encodeURIComponent(patient.hid)}`);
  assert.deepEqual([healthIdAsDiagnosis.status, healthIdAsDiagnosis.body?.code, healthIdAsDiagnosis.headers.get('cache-control')],
    [400, 'CATALOG_SEARCH_TEXT_NOT_ALLOWED', 'private, no-store'], 'a Health ID as a diagnosis search is refused, never kept');
  const noDiagnosisPermission = await terminologyGet(ownPharmacist, '/diagnoses?q=malaria');
  assert.equal(noDiagnosisPermission.status, 403, `a pharmacist who records no diagnosis is refused: ${noDiagnosisPermission.status}`);
  const statusWithDiagnoses = expectStatus(await catalogGet(doctor, '/status'), 200, 'status with a diagnosis release');
  assert.deepEqual(statusWithDiagnoses.diagnoses, { available: true, release: 'ICD-11 MMS 2026-01', fileSha256: 'd'.repeat(64) },
    'the status names the loaded ICD-11 release');
  assert.ok(statusWithDiagnoses.attribution.includes(icdNotice), 'the ICD-11 notice is shown with the others');
  evidence.diagnoses = { searched: ['falciparum: 1F40 first, by our other name', 'B50.9: typed ICD-10'],
    refused: ['Health ID', 'no ehr.diagnosis.write'], status: 'ICD-11 MMS 2026-01' };
  step('ORD-9: the doctor finds a diagnosis by a word or our other name, an ICD-10 code typed is named back, a Health ID '
    + 'and a member without the permission are refused; the status names the release');

  // ── ORD-9 (0151): the doctor's recent diagnoses ──
  // Written by ehr-api in each diagnosis save's transaction; read with no X-Purpose-Of-Use (no patient).
  const recentGet = (who, query = '') => terminologyGet(who, `/diagnoses/recent${query}`);
  const recentBefore = await recentGet(doctor);
  assert.deepEqual(expectStatus(recentBefore, 200, 'recent diagnoses before any pick'), { items: [] },
    'before any diagnosis is saved the recent list is empty');
  assert.equal(recentBefore.headers.get('cache-control'), 'private, no-store', 'the recent list is never kept');
  const saveDiagnosis = (code, display, key = freshKey('diagnosis')) => ehrCall(doctor, 'POST', `${enc}/diagnoses`,
    { codeSystem: 'ICD-11', code, display, clinicalStatus: 'active', verificationStatus: 'provisional' }, { key });
  const malariaKey = freshKey('diagnosis');
  expectStatus(await saveDiagnosis('1F40', 'Malaria due to Plasmodium falciparum', malariaKey), 201, 'first diagnosis');
  expectStatus(await saveDiagnosis('1A07', 'Typhoid fever'), 201, 'second diagnosis');
  expectStatus(await saveDiagnosis('1F40', 'Malaria due to Plasmodium falciparum'), 201, 'the first again');
  const replay = await saveDiagnosis('1F40', 'Malaria due to Plasmodium falciparum', malariaKey);
  assert([200, 201].includes(replay.status), `a replayed save answers from its key: ${replay.status}`);
  const recentAfter = expectStatus(await recentGet(doctor), 200, 'recent diagnoses after three picks');
  assert.deepEqual(recentAfter.items.map(item => [item.codeSystem, item.code, item.display, item.useCount]), [
    ['ICD-11', '1F40', 'Malaria due to Plasmodium falciparum', 2], ['ICD-11', '1A07', 'Typhoid fever', 1]],
  'newest first, the same pick counted twice, the replay not counted');
  assert.ok(recentAfter.items.every(item => !Number.isNaN(Date.parse(item.lastUsedAt))), 'each pick says when');
  assert.deepEqual(expectStatus(await recentGet(doctor, '?limit=1'), 200, 'limit 1').items.map(item => item.code),
    ['1F40'], 'limit 1 gives the newest pick');
  const badLimit = await recentGet(doctor, '?limit=51');
  assert.deepEqual([badLimit.status, badLimit.body?.code], [400, 'VALIDATION_FAILED'], 'limit 51 is refused');
  const pharmacistRecent = await recentGet(ownPharmacist);
  assert.equal(pharmacistRecent.status, 403, `a member who records no diagnosis is refused: ${pharmacistRecent.status}`);
  const recentRows = await all(`select membership_id::text as membership_id, code from ehr.clinician_recent_diagnoses
    order by code`);
  assert.deepEqual(recentRows.map(row => row.code), ['1A07', '1F40'], 'two picks are held');
  assert.equal(new Set(recentRows.map(row => row.membership_id)).size, 1, 'all for the doctor\'s one membership');
  const recentColumns = await all(`select column_name from information_schema.columns
    where table_schema = 'ehr' and table_name = 'clinician_recent_diagnoses' and column_name like '%patient%'`);
  assert.deepEqual(recentColumns, [], 'the recent list holds no patient');
  const recentAudit = await all(`select details from audit.events where action = 'ehr.terminology.recent-read'
    and outcome = 'success' order by occurred_at, sequence_id`);
  assert.deepEqual(recentAudit.map(row => row.details), [{ resultCount: 0 }, { resultCount: 2 }, { resultCount: 1 }],
    'each read is audited with the count only');
  assert.equal(Number((await one(`select count(*) from audit.events where action = 'ehr.terminology.recent-read'
    and (details::text like '%1F40%' or details::text like '%Malaria%')`)).count), 0, 'no audit row holds a pick');
  evidence.recentDiagnoses = { picks: ['1F40 x2', '1A07 x1'], replayCounted: false, limitOne: '1F40',
    refused: ['limit 51', 'no ehr.diagnosis.write'], auditRows: recentAudit.length };
  step('ORD-9: each diagnosis the doctor saves joins their recent list (newest first, counted, a replay not), read '
    + 'with no purpose of use and never kept; audited with the count only; a member without the permission is refused');

  // ── ORD-9 (0151): the record never waits, with two sessions ──
  // Two connections as ehr-api connects (its runtime URL and role), each with the doctor's settings as a
  // diagnosis save sets them. Session A records 1F40, a pick the doctor already has, and keeps its transaction
  // open. Checked: A then holds the membership's recording lock (in pg_locks) and 1F40's row (the owner's
  // FOR UPDATE NOWAIT on that row is refused with 55P03). Session B, with lock_timeout 1500 ms, then records for
  // the same membership, each in a transaction of its own, first the same pick, 1F40, then a different one,
  // KA64.20, which has no row yet: each must come back in under 500 ms, record nothing and raise nothing. Once
  // A commits, B records both in one transaction and both are kept.
  // B recording A's pick first is what catches a record that waits on A's row: a FOR UPDATE row lock on the
  // pick, or on all the membership's picks, taken before the try, or the try's result ignored (the upsert then
  // waits for A's row), raises 55P03 after about 1500 ms here; so does a blocking "pg_advisory_xact_lock" on
  // the membership's key taken before the try. KA64.20 catches a record that ignores the try's result and
  // skips only a pick whose row is locked: it records KA64.20 while A is open.
  const doctorMember = await one(`select account.subject, membership.id::text as membership_id
    from auth.accounts account join identity.staff_facility_memberships membership on membership.account_id = account.id
    where account.id = $1 and membership.facility_id = $2 and membership.active`, [doctor.accountId, hospital.facilityId]);
  assert.equal(doctorMember?.membership_id, recentRows[0].membership_id, 'the picks are the doctor\'s membership\'s');
  const picksHeld = async () => Object.fromEntries((await all(`select code, use_count from ehr.clinician_recent_diagnoses
    where membership_id = $1 order by code`, [doctorMember.membership_id])).map(row => [row.code, row.use_count]));
  const asDoctorInSave = client => client.query(`select set_config('app.actor_subject', $1, true),
      set_config('app.facility_id', $2, true), set_config('app.correlation_id', $3, true),
      set_config('app.membership_id', $4, true), set_config('app.purpose_of_use', 'direct-care', true)`,
  [doctorMember.subject, hospital.facilityId, `verifier-recent-${randomUUID()}`, doctorMember.membership_id]);
  const recordPick = (client, code, display) => client.query('select ehr.record_recent_diagnosis($1, $2, $3)',
    ['ICD-11', code, display]);
  const rowLockRefusal = async code => {
    try {
      await one(`select 1 from ehr.clinician_recent_diagnoses where membership_id = $1 and code_system = 'ICD-11'
        and code = $2 for update nowait`, [doctorMember.membership_id, code]);
      return 'none';
    } catch (error) {
      return error.code;
    }
  };
  const sessionA = new Client({ connectionString: databaseUrl('hid_ehr_api_runtime'), query_timeout: 15_000 });
  const sessionB = new Client({ connectionString: databaseUrl('hid_ehr_api_runtime'), query_timeout: 15_000 });
  // B records one pick in a transaction of its own while A is open: at once, nothing recorded, no error.
  const recordAsBWhileAOpen = async (code, display) => {
    await sessionB.query('begin');
    await asDoctorInSave(sessionB);
    const started = performance.now();
    let failed;
    try {
      await recordPick(sessionB, code, display);
    } catch (error) {
      failed = error;
    }
    const tookMs = Math.round(performance.now() - started);
    await sessionB.query(failed ? 'rollback' : 'commit');
    assert.equal(failed, undefined, `while A is open, B's record of ${code} raised ${failed?.code} after ${tookMs} ms `
      + `(${failed?.message}): the record waited for A`);
    assert(tookMs < 500, `while A is open, B's record of ${code} took ${tookMs} ms: the record waited for A`);
    assert.deepEqual(await picksHeld(), { '1A07': 1, '1F40': 2 },
      `B recorded nothing of ${code} while A held the lock`);
    return { code, returnedAfterMs: tookMs, error: null, recorded: false };
  };
  try {
    await sessionA.connect();
    await sessionB.connect();
    const roleA = (await sessionA.query('select current_user as role, pg_backend_pid() as pid')).rows[0];
    const roleB = (await sessionB.query('select current_user as role')).rows[0];
    assert.deepEqual([roleA.role, roleB.role], ['hid_ehr_api_runtime', 'hid_ehr_api_runtime'], 'both as the EHR runtime');
    await sessionB.query("select set_config('lock_timeout', '1500ms', false)");
    assert.equal((await sessionB.query('show lock_timeout')).rows[0].lock_timeout, '1500ms', 'B waits at most 1500 ms');
    assert.deepEqual(await picksHeld(), { '1A07': 1, '1F40': 2 }, 'the picks before the two sessions');

    await sessionA.query('begin');
    await asDoctorInSave(sessionA);
    await recordPick(sessionA, '1F40', 'Malaria due to Plasmodium falciparum');
    const heldByA = await one(`select count(*)::int as n from pg_locks lock_row where lock_row.pid = $1
      and lock_row.locktype = 'advisory' and lock_row.granted and lock_row.classid = 7409 and lock_row.objsubid = 2
      and lock_row.objid::bigint = (hashtext($2)::bigint & 4294967295)`, [roleA.pid, doctorMember.membership_id]);
    assert.equal(heldByA.n, 1, 'session A, still open, holds the membership\'s recording lock');
    assert.equal(await rowLockRefusal('1F40'), '55P03', 'session A, still open, holds 1F40\'s row');

    const samePick = await recordAsBWhileAOpen('1F40', 'Malaria due to Plasmodium falciparum');
    const otherPick = await recordAsBWhileAOpen('KA64.20', 'Congenital falciparum malaria');

    await sessionA.query('commit');
    assert.deepEqual(await picksHeld(), { '1A07': 1, '1F40': 3 }, 'A\'s pick is kept once A commits');
    await sessionB.query('begin');
    await asDoctorInSave(sessionB);
    await recordPick(sessionB, '1F40', 'Malaria due to Plasmodium falciparum');
    await recordPick(sessionB, 'KA64.20', 'Congenital falciparum malaria');
    await sessionB.query('commit');
    assert.deepEqual(await picksHeld(), { '1A07': 1, '1F40': 4, 'KA64.20': 1 },
      'after A commits, B\'s records of the same pick and the other are kept');
    evidence.recentNeverWaits = { sessions: 'two, as hid_ehr_api_runtime', lockTimeoutMs: 1500,
      heldByA: ['recording lock', '1F40 row'], whileAOpen: [samePick, otherPick],
      afterACommits: { recorded: ['1F40', 'KA64.20'] } };
  } finally {
    await sessionA.end().catch(() => {});
    await sessionB.end().catch(() => {});
  }
  const [samePickMs, otherPickMs] = evidence.recentNeverWaits.whileAOpen.map(pick => pick.returnedAfterMs);
  step(`ORD-9: the record never waits: while one save of the doctor's holds the recording lock and the row of the `
    + `pick it recorded, another records that same pick (${samePickMs} ms) and then a different one `
    + `(${otherPickMs} ms) for the same membership at once (lock_timeout 1500 ms), without recording and without `
    + 'an error; once the first commits, both are kept');

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
  // pg-pool's end() resolves before its connections finish closing, so the
  // forced drop below can terminate one of them (57P01) once the checks are
  // over (as identity-api's verify-provider-enrollment-runtime.mjs notes).
  // Only that is expected here; any other pool error still fails the run.
  owner.on('error', (error) => { if (error.code !== '57P01') throw error; });
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
