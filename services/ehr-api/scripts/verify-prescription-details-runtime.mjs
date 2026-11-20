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
// and its list says dispensingDetails: true) and one without any; the
// hospital's own pharmacist pulls both: own work. Checked: the own work item
// of the first, on the pharmacist's list and read by id, carries exactly the
// prescriber's priority, strength, form, duration and quantity; the second
// carries none of them; the pharmacist without consent sees neither the work
// nor any detail. Route-backed work (a prescription with all seven details
// sent to the pharmacy and accepted at its counter) carries no detail, on the
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

  // ── Own work: both prescriptions pulled by the hospital's own pharmacist ──
  const pull = async prescription => expectStatus(await call(ehr, ownPharmacist, 'POST',
    `/ehr/patients/${patient.id}${enc}/prescriptions/${prescription.id}/pharmacy-work-item`,
    { expectedRowVersion: Number(prescription.rowVersion), reason: 'Synthetic same-facility hand-off' },
  { key: freshKey('pull') }), 201, 'own pharmacist pull');
  const pulledWith = await pull(withDetails);
  const pulledWithout = await pull(withoutDetails);
  step('own work: both prescriptions pulled by the hospital\'s own pharmacist');

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
  assert(ownWith && ownWithout, `the pulls did not reach the hospital's Pharmacy: ${JSON.stringify([pulledWith, pulledWithout])}`);
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
  // The pharmacist without consent: the work is not shown, nor any detail.
  const noConsent = expectStatus(await pharmacyCall(pharmacistWithoutConsent, 'GET', '/work-items'), 200,
    'Pharmacy list without consent');
  assert(!noConsent.items.some(item => [ownWith.id, ownWithout.id].includes(item.id)),
    'own Pharmacy work shown to a pharmacist without consent');
  assert(!noConsent.items.some(item => Object.keys(detailsOf(item)).length > 0),
    'prescription details shown to a pharmacist without consent');
  const noConsentRead = await pharmacyCall(pharmacistWithoutConsent, 'GET', `/work-items/${ownWith.id}`);
  assert([403, 404].includes(noConsentRead.status), `Pharmacy item read without consent: ${noConsentRead.status}`);
  assert.equal(JSON.stringify(noConsentRead.body ?? '').includes('500 mg'), false, 'a detail in the refusal');
  evidence.own = { listed: 2, withDetails: { onList: expectedDetails, readById: 'the same' },
    withoutDetails: { onList: 'none', readById: 'none' },
    withoutConsent: { listed: 0, details: 0, read: noConsentRead.status } };
  step('own work carries the prescriber\'s details on the list and by id; none without them; none for a pharmacist without consent');

  // ── Route-backed work carries none, though its reader holds the patient's consent at that facility ──
  const attestationVersion = async kind => expectStatus(await call(ehr, doctor, 'GET', `/ehr/order-route-attestation?kind=${kind}`),
    200, `attestation ${kind}`).version;
  const routed = await newPrescription('active', written);
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
