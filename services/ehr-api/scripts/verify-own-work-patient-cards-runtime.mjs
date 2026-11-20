#!/usr/bin/env node
// Patient details on this facility's own lab and pharmacy work (0124,
// docs/INTERFACE_CONTRACT.md section 45) end to end, over HTTP, with the
// setting on: Identity, EHR, Lab and Pharmacy each booted from its own source
// (its own main.ts) in its own process, each connected as its exact runtime
// role, Lab and Pharmacy with OWN_WORK_PATIENT_CARD_ENABLED=true, the
// services calling each other over loopback with local-secret workload
// identity. Only the outbound boundaries are local stubs: QoreID (for
// facility sign-up) and notification-api's OTP and staff-invitation routes,
// on one loopback server; a preload refuses every other non-loopback request.
// All values are synthetic. It runs only against the owned disposable
// synthetic rehearsal or, with
// HID_OWN_WORK_PATIENT_CARDS_RUNTIME_LOCAL_CLUSTER=loopback, a disposable
// copy of a database on a loopback test cluster.
//
// Why it exists: lab-api and pharmacy-api read lab.work_item_patient_cards
// and pharmacy.work_item_patient_cards in a savepoint and answer without the
// patient whatever goes wrong (a missing EXECUTE, a schema without 0124, a
// setting left off), so an HTTP 200 without `patient` is a silent failure.
// The unit tests mock the database; this calls the real functions through
// the real services as hid_lab_api_runtime and hid_pharmacy_api_runtime, and
// fails loudly when an own work item the member may read comes back without
// `patient`.
//
// The flow: a hospital, a laboratory and a pharmacy sign up (P4) and support
// reviews them (P4b); the hospital invites two laboratory members and two
// pharmacists (P4b). The patient approves, in the app, the doctor's access
// and one laboratory member's and one pharmacist's (the other two hold no
// consent), and the laboratory's and the pharmacy's administrators' at their
// own facilities. The doctor's active lab request is handed to the hospital's
// own Lab, and the doctor's active prescription goes to the hospital's own
// pharmacy by itself (0133, ORD-2): own work. Checked: every own work item on
// the consented members' lists, and each one read by id, carries the patient
// (name, sex, date of birth, Health ID ending), and each list wrote one
// `basis: consent` audit row naming the patient and the work items (ids only),
// and their reads by id are consent rows (no basis); since 0133 the members
// without consent, the facility's own lab and pharmacy staff, see the same
// work and patient, and their list and read rows carry `basis: own-work`
// (ORD-2: this facility's own work, never the chart), while the pharmacy's
// pharmacist and the laboratory's lab member, who hold the same permissions
// at their own facility, list none of it, cannot read it by id and cannot
// claim the hospital as their session's facility. Route-backed
// work (a lab request sent to the laboratory, a prescription sent to the
// pharmacy, each accepted at the counter) keeps its patient from the route
// card only: while the route allows a read the card's patient and a
// `basis: order-route` row, never a `basis: consent` row; after the route's
// windows close (owner SQL ages them) the administrators, who hold the
// patient's consent at their facility and still read the work on it, get
// the card's `access: none` and no patient. Last, the doctor sends the
// hospital's own prescription, still undispensed, to the pharmacy (0133 D14,
// owner's Q121 A): the hospital's pharmacists no longer list its item there,
// the pharmacist without consent still reads it by id on the own-work basis
// (`withdrawnReason: sent_elsewhere`, audited with the patient), and Dispense
// answers 409. Owner SQL is used only for what
// no route does: the platform administrator's and the patient's accounts (as
// the other runtime verifiers seed them), QoreID switched on, ageing routes
// past their windows (the services' clock cannot be moved) and reading what
// the database holds.
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
const loopback = process.env.HID_OWN_WORK_PATIENT_CARDS_RUNTIME_LOCAL_CLUSTER === 'loopback'
  && ['127.0.0.1', '::1', 'localhost'].includes(socket ?? '')
  && /^[a-z][a-z0-9_]{0,40}$/.test(process.env.PGDATABASE ?? '');
assert(process.env.NODE_ENV === 'test' && (rehearsal || loopback),
  'Only the owned synthetic rehearsal or an explicitly named loopback test cluster is supported');
assert(process.env.OTP_HMAC_KEY_B64, 'The rehearsal OTP HMAC key is required');
assert(process.env.AUTH_SIGNING_SECRET && process.env.AUTH_LOGIN_PEPPER, 'Synthetic session keys are required');
const port = Number(process.env.PGPORT ?? 5432);
const pgUser = process.env.PGUSER ?? 'postgres';
const isolated = `${rehearsal ? 'hid_rehearsal' : process.env.PGDATABASE}_owncards_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const databaseUrl = role => {
  const options = `options=${encodeURIComponent(`-c role=${role}`)}`;
  return rehearsal
    ? `postgresql://${pgUser}@localhost:${port}/${isolated}?host=${encodeURIComponent(socket)}&${options}`
    : `postgresql://${pgUser}@${socket === '::1' ? '[::1]' : socket}:${port}/${isolated}?${options}`;
};
// The setting under test, as lab-api and pharmacy-api read it.
const OWN_WORK_PATIENT_CARD_ENABLED = 'true';

const appOrigin = 'https://app.healthidentitydirectory.com';
const ehrOrigin = 'https://ehr.healthidentitydirectory.com';
const labOrigin = 'https://lab.healthidentitydirectory.com';
const pharmacyOrigin = 'https://pharmacy.healthidentitydirectory.com';
const adminOrigin = 'https://admin.healthidentitydirectory.com';
const CORS = [appOrigin, ehrOrigin, labOrigin, pharmacyOrigin, adminOrigin, 'https://healthidentitydirectory.com'].join(',');
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
    departments: ['general_outpatient', 'laboratory'], servicesOffered: 'Synthetic outpatient and laboratory care',
    smohLicenceNumber: 'LSMOH/VERIFIER/0001', hasRegistryId: false, registryId: null,
    hasNhiaAccreditation: false, nhiaAccreditationNumber: null, medicalDirectorName: 'Dr Verifier Example',
    medicalDirectorMdcn: 'MDCN/00001', expectedStaff: 5, migratingRecords: false, needsInteroperability: false,
  },
});
const collectedFieldsKey = randomBytes(32).toString('base64');
const temporary = await mkdtemp(join(tmpdir(), 'hid-own-work-patient-cards-'));
const evidence = { setting: { OWN_WORK_PATIENT_CARD_ENABLED, services: ['lab-api', 'pharmacy-api'] }, steps };
const startedAt = Date.now();
let failure;
try {
  // The database holds 0124's two readers (their grants are what this run proves over HTTP, not read here).
  const readers = await all(`select proc.oid::regprocedure::text as name from pg_proc proc
    where proc.proname = 'work_item_patient_cards' and proc.pronamespace in ('lab'::regnamespace, 'pharmacy'::regnamespace)
    order by 1`);
  assert.deepEqual(readers.map(row => row.name), ['lab.work_item_patient_cards(uuid[])',
    'pharmacy.work_item_patient_cards(uuid[])'], 'a database with 0124');
  evidence.database = { readers: readers.map(row => row.name) };
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
  evidence.runtimeRoles = Object.keys(runtimeRoles);

  const [identityPort, ehrPort, labPort, pharmacyPort] = await Promise.all([1, 2, 3, 4].map(() => freePort()));
  const common = { HID_VERIFIER_PRELOAD: preload, HID_VERIFIER_STUB_URL: stubUrl, CORS_ORIGINS: CORS,
    TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128' };
  const local = value => `http://127.0.0.1:${value}`;
  const [identity, ehr, lab, pharmacy] = await Promise.all([
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
      LAB_API_URL: local(labPort), LAB_INTERNAL_SERVICE_TOKEN: tokens.lab, PHARMACY_API_URL: local(pharmacyPort),
      PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy, EHR_INTERNAL_SERVICE_TOKEN: tokens.ehr }, ehrPort),
    boot('lab-api', join(services, 'lab-api'), { ...common, DATABASE_URL: databaseUrl('hid_lab_api_runtime'),
      IDENTITY_API_URL: local(identityPort), IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: tokens.identityLab,
      LAB_INTERNAL_SERVICE_TOKEN: tokens.lab, OWN_WORK_PATIENT_CARD_ENABLED }, labPort),
    boot('pharmacy-api', join(services, 'pharmacy-api'), { ...common, DATABASE_URL: databaseUrl('hid_pharmacy_api_runtime'),
      IDENTITY_API_URL: local(identityPort), IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.identityPharmacy,
      PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy, OWN_WORK_PATIENT_CARD_ENABLED }, pharmacyPort),
  ]);
  step(`four services booted from their own code; lab-api and pharmacy-api with OWN_WORK_PATIENT_CARD_ENABLED=${OWN_WORK_PATIENT_CARD_ENABLED}`);

  // ── Support, the facilities (P4 sign-up, P4b review) and the hospital's own Lab and Pharmacy staff (P4b) ──
  const password = 'Synthetic-Own-Work-Card-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const synthetic = label => `owncards-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const signInStaff = async (email, host, facilityId, name) => {
    const response = await http(identity, 'POST', '/auth/login', { origin: host.origin,
      body: { email, password, turnstileAction: host.action } });
    expectStatus(response, 200, `sign-in ${email}`);
    return { email, name, origin: host.origin, facilityId, accountId: response.body.actor.accountId,
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
    values ($1, $2, 'platform_super_admin', 'platform', 'Synthetic platform administrator for the own-work patient verifier')`,
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
      reason: `Own-work patient verifier: ${controlKey} ${enabled ? 'on' : 'off'}` }, { ifMatch: control.version }), 201,
    `control ${controlKey}`);
  };
  await setControl('provider_self_service_enabled', true);
  await setControl('staff_invitations_enabled', true);
  await setControl('cross_facility_orders_enabled', true);

  let signUps = 0;
  const signUp = async ({ label, organizationType, productCode, administratorName }) => {
    signUps += 1;
    const cac = `RC99200${String(88000 + signUps)}`;
    companies.set(cac, { name: `Verifier ${label} ${cac} Ltd`, address: `${signUps} Synthetic Own Work Road, Ikeja, Lagos` });
    const email = synthetic(`admin-${signUps}`);
    const started = await http(identity, 'POST', '/identity/provider-enrollments', { origin: appOrigin,
      forwardedFor: `198.51.170.${signUps}`, body: { cacRegistrationNumber: cac, administratorEmail: email, organizationType,
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
  const laboratory = await signUp({ label: 'Laboratory', organizationType: 'laboratory', productCode: 'laboratory',
    administratorName: 'Bello Musa' });
  const pharmacyFacility = await signUp({ label: 'Pharmacy', organizationType: 'pharmacy', productCode: 'pharmacy',
    administratorName: 'Chioma Eze' });
  await review(hospital, 'doctor', { body: 'MDCN', number: 'MDCN/72011' });
  await review(laboratory, 'lab', { body: 'MLSCN', number: 'MLSCN/72022' });
  await review(pharmacyFacility, 'pharmacist', { body: 'PCN', number: 'PCN/72033' });
  const doctor = await signInStaff(hospital.email, HOSTS.ehr, hospital.facilityId, hospital.administratorName);
  const labAdmin = await signInStaff(laboratory.email, HOSTS.lab, laboratory.facilityId, laboratory.administratorName);
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
    expectStatus(await openInvitation(`198.51.171.${invitations}`), 200, 'open invitation');
    const opened = await openInvitation(`198.51.172.${invitations}`);
    expectStatus(await http(identity, 'POST', '/identity/staff-invitations/accept', { origin: appOrigin,
      cookie: opened.cookies.find(value => value.startsWith('hid_staff_invitation=')), body: { password } }), 200,
    'accept invitation');
    return signInStaff(person.email, host, facilityId, person.name);
  };
  const labMember = await invited(doctor, HOSTS.lab, hospital.facilityId, { name: 'Kemi Ownlab',
    email: synthetic('lab-member'), role: 'lab', licenceBody: 'MLSCN', licenceNumber: 'MLSCN/82011' });
  const labMemberWithoutConsent = await invited(doctor, HOSTS.lab, hospital.facilityId, { name: 'Lanre Noconsent',
    email: synthetic('lab-no-consent'), role: 'lab', licenceBody: 'MLSCN', licenceNumber: 'MLSCN/82022' });
  const ownPharmacist = await invited(doctor, HOSTS.pharmacy, hospital.facilityId, { name: 'Musa Ownpharm',
    email: synthetic('pharmacist'), role: 'pharmacist', licenceBody: 'PCN', licenceNumber: 'PCN/82033' });
  const pharmacistWithoutConsent = await invited(doctor, HOSTS.pharmacy, hospital.facilityId, { name: 'Ngozi Noconsent',
    email: synthetic('pharmacist-no-consent'), role: 'pharmacist', licenceBody: 'PCN', licenceNumber: 'PCN/82044' });
  step('a hospital, a laboratory and a pharmacy signed up and reviewed; two lab members and two pharmacists invited at the hospital');

  // ── The patient: an app account; access approved in the app for five members, two left without consent ──
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const healthIdOf = () => `HID-${Array.from(randomBytes(10), byte => alphabet[byte % alphabet.length]).join('')}`;
  const patientAccount = randomUUID();
  const patient = { id: randomUUID(), hid: healthIdOf(), email: synthetic('patient'), fullName: 'Amaka Verifier-Owncard',
    sex: 'female', dob: '1984-06-21' };
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
    values ($1, $2, $3, $4, $5, 'argon2id', 'active')`,
  [patientAccount, `synthetic:patient:${patientAccount}`, patient.email, patient.fullName, passwordHash]);
  await owner.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob,
      status) values ($1, $2, $3, 'Amaka', 'Verifier-Owncard', $4, $5, $6, 'active')`,
  [patient.id, patientAccount, patient.hid, patient.fullName, patient.sex, patient.dob]);
  const expectedPatient = { fullName: patient.fullName, sex: patient.sex, dateOfBirth: patient.dob,
    healthIdLast4: patient.hid.slice(-4) };
  const loggedIn = await http(identity, 'POST', '/auth/patient/login', { origin: appOrigin,
    body: { email: patient.email, password, turnstileAction: 'patient-login' } });
  expectStatus(loggedIn, 200, 'patient sign-in');
  const patientSession = { cookie: loggedIn.cookies.join('; '), csrf: loggedIn.headers.get('x-csrf-token') };
  const patientCall = (method, path, body) => http(identity, method, path, { cookie: patientSession.cookie,
    ...(method === 'GET' ? {} : { origin: appOrigin, csrf: patientSession.csrf }), body });
  const approvedAccess = async (who, scope) => {
    const requested = expectStatus(await call(identity, who, 'POST', '/identity/access-requests',
      { hid: patient.hid, scope, reason: 'Synthetic visit for the own-work patient verifier', durationMinutes: 1440 }),
    201, `access request ${who.name} ${scope}`);
    const approved = expectStatus(await patientCall('POST', `/identity/access-requests/${requested.accessRequestId}/approve`),
      200, `approve ${who.name} ${scope}`);
    assert.equal(approved.status, 'approved');
  };
  await approvedAccess(doctor, 'write_records');
  await approvedAccess(labMember, 'read_records');
  await approvedAccess(ownPharmacist, 'write_records');
  await approvedAccess(labAdmin, 'read_records');
  await approvedAccess(pharmacist, 'read_records');
  const grantsOf = async who => (await one(`select count(*)::int as n from identity.consent_grants grant_row
    join identity.staff_facility_memberships membership on membership.id = grant_row.membership_id
    where membership.account_id = $1 and grant_row.patient_id = $2`, [who.accountId, patient.id])).n;
  assert.deepEqual([await grantsOf(labMemberWithoutConsent), await grantsOf(pharmacistWithoutConsent)], [0, 0],
    'the members left without consent hold no grant for the patient');
  step('the patient approved the doctor, one lab member, one pharmacist and the two receiving administrators in the app');

  // ── Own work: a lab request handed to the hospital's own Lab, a prescription pulled by its own pharmacist ──
  const ehrCall = (who, method, path, body, extra) => call(ehr, who, method, `/ehr/patients/${patient.id}${path}`, body, extra);
  const labCall = (who, method, path, body, extra) => call(lab, who, method, `/lab${path}`, body, extra);
  const pharmacyCall = (who, method, path, body, extra) => call(pharmacy, who, method, `/pharmacy${path}`, body, extra);
  const encounter = expectStatus(await ehrCall(doctor, 'POST', '/encounters', { encounterType: 'ambulatory',
    status: 'in_progress', startedAt: new Date().toISOString(), chiefComplaint: 'Synthetic chief complaint' },
  { key: freshKey('encounter') }), 201, 'encounter');
  const enc = `/encounters/${encounter.id}`;
  const newLabRequest = async status => expectStatus(await ehrCall(doctor, 'POST', `${enc}/lab-requests`,
    { testCodeSystem: 'http://loinc.org', testCode: '4548-4', testDisplay: 'Synthetic HbA1c panel', priority: 'routine',
      status, specimenTypeCode: 'blood', clinicalInformation: 'Synthetic clinical note' }, { key: freshKey('lab-request') }),
  201, 'lab request');
  const newPrescription = async status => expectStatus(await ehrCall(doctor, 'POST', `${enc}/prescriptions`,
    { medicationCodeSystem: 'http://snomed.info/sct', medicationCode: '325072002',
      medicationDisplay: 'Synthetic metformin 500 mg tablet', doseQuantity: 1, doseUnit: 'tablet', routeCode: 'oral',
      frequency: 'twice daily', instructions: 'Synthetic instructions: take with food', status },
  { key: freshKey('prescription') }), 201, 'prescription');
  const ownLabRequest = await newLabRequest('active');
  // 0133: the hospital has pharmacists, so the doctor's active prescription goes to its own pharmacy by itself.
  const ownPrescription = await newPrescription('active');
  assert.deepEqual(ownPrescription.pharmacyHandoff, { status: 'sent', message: 'Sent to this hospital\'s pharmacy.' },
    `the automatic send: ${JSON.stringify(ownPrescription.pharmacyHandoff)}`);
  step('own work: the active lab request handed to the hospital\'s Lab; the active prescription sent to its pharmacy by itself');

  // Fails loudly: an own work item the member may read (it is on their list) without its patient. The service's
  // own warning, if it logged one, names the SQLSTATE (42501: no EXECUTE; 42883: no 0124).
  const readerWarning = name => {
    const log = (childLogs.get(name) ?? []).join('').replace(/\x1b\[[0-9;]*m/g, '');
    const at = log.lastIndexOf('Patients on own work could not be read');
    if (at < 0) return 'it logged no reader warning';
    const sqlState = /sqlState:\s*'([0-9A-Z]{5}|unknown)'/.exec(log.slice(at, at + 300))?.[1] ?? 'unknown';
    return `it logged 'Patients on own work could not be read', SQLSTATE ${sqlState}`;
  };
  const requirePatient = (item, service, reader, role, who) => {
    assert(item.patient !== undefined, `${service} answered own work item ${item.id}, which ${who.name} may read, `
      + `without 'patient': ${reader} through ${role} gave nothing or was not called (OWN_WORK_PATIENT_CARD_ENABLED=`
      + `${OWN_WORK_PATIENT_CARD_ENABLED}; the service answers 200 whatever the reader does; ${readerWarning(service)})`);
    assert.deepEqual(item.patient, expectedPatient, `${service}: the patient on own work item ${item.id}`);
  };
  const listAudit = (action, facilityId, who) => all(`select patient_id, resource_id, details from audit.events
    where action = $1 and facility_id = $2 and actor_account_id = $3 and details ? 'basis' order by sequence_id`,
  [action, facilityId, who.accountId]);
  // A read by id: the basis it was recorded with (none for a consent row).
  const readBases = (action, facilityId, who, workItemId) => all(`select coalesce(details->>'basis', 'consent (no basis)') as basis,
      patient_id from audit.events where action = $1 and facility_id = $2 and actor_account_id = $3 and resource_id = $4
    order by sequence_id`, [action, facilityId, who.accountId, workItemId]);
  const noIdentityIn = (value, label) => {
    const text = JSON.stringify(value);
    for (const item of [patient.fullName, patient.dob, patient.hid, patient.hid.slice(-4)]) {
      assert(!text.includes(item), `${label} carries ${item}`);
    }
  };

  // ── Lab: the consented member reads the patient on own work, through lab.work_item_patient_cards ──
  const ownLabList = expectStatus(await labCall(labMember, 'GET', '/work-items'), 200, 'own Lab list');
  const ownLabItem = ownLabList.items.find(item => item.sourceEhrOrderId === ownLabRequest.id);
  assert(ownLabItem, `the hand-off did not reach the hospital's Lab: ${JSON.stringify({ labWorkItem: ownLabRequest.labWorkItem,
    labHandoff: ownLabRequest.labHandoff })}`);
  assert.equal(ownLabItem.orderRoute, undefined);
  const ownLabRows = ownLabList.items.filter(item => item.orderRoute === undefined);
  for (const item of ownLabRows) {
    assert.equal(item.patientId, patient.id);
    requirePatient(item, 'lab-api', 'lab.work_item_patient_cards', 'hid_lab_api_runtime', labMember);
  }
  const ownLabRead = expectStatus(await labCall(labMember, 'GET', `/work-items/${ownLabItem.id}`), 200, 'own Lab item');
  requirePatient(ownLabRead, 'lab-api', 'lab.work_item_patient_cards', 'hid_lab_api_runtime', labMember);
  const labAudit = await listAudit('lab.work-item.list', hospital.facilityId, labMember);
  assert.deepEqual(labAudit.map(row => [row.patient_id, row.resource_id, row.details]),
    [[patient.id, ownLabItem.id, { basis: 'consent', workItemIds: ownLabRows.map(item => item.id) }]],
    `the Lab list's audit: ${JSON.stringify(labAudit)}`);
  noIdentityIn(labAudit, 'the Lab list audit');
  assert.deepEqual(await readBases('lab.work-item.read', hospital.facilityId, labMember, ownLabItem.id),
    [{ basis: 'consent (no basis)', patient_id: patient.id }], 'the consented member\'s read is a consent row');
  // 0133: the facility's own lab member without consent works on this facility's own work: the same items and
  // patient, every list and read recorded with basis own-work and the patient.
  const labNoConsent = expectStatus(await labCall(labMemberWithoutConsent, 'GET', '/work-items'), 200, 'Lab list without consent');
  const labOwnWorkRows = labNoConsent.items.filter(item => item.orderRoute === undefined);
  assert.deepEqual(labOwnWorkRows.map(item => item.id), ownLabRows.map(item => item.id),
    'the facility\'s own Lab work listed to its lab member without consent (0133)');
  for (const item of labOwnWorkRows) {
    requirePatient(item, 'lab-api', 'lab.work_item_patient_cards', 'hid_lab_api_runtime', labMemberWithoutConsent);
  }
  const labNoConsentRead = expectStatus(await labCall(labMemberWithoutConsent, 'GET', `/work-items/${ownLabItem.id}`), 200,
    'own Lab item read on the own-work basis');
  requirePatient(labNoConsentRead, 'lab-api', 'lab.work_item_patient_cards', 'hid_lab_api_runtime', labMemberWithoutConsent);
  const labOwnWorkAudit = await listAudit('lab.work-item.list', hospital.facilityId, labMemberWithoutConsent);
  assert.deepEqual(labOwnWorkAudit.map(row => [row.patient_id, row.resource_id, row.details]),
    [[patient.id, ownLabRows[0].id, { basis: 'own-work', workItemIds: ownLabRows.map(item => item.id) }]],
    `the own-work Lab list's audit: ${JSON.stringify(labOwnWorkAudit)}`);
  assert.deepEqual(await readBases('lab.work-item.read', hospital.facilityId, labMemberWithoutConsent, ownLabItem.id),
    [{ basis: 'own-work', patient_id: patient.id }], 'the own-work read is recorded with its basis and the patient');
  noIdentityIn(labOwnWorkAudit, 'the own-work Lab list audit');
  evidence.lab = { ownItemsListed: ownLabRows.length, withPatient: ownLabRows.length, readById: 'patient',
    audit: { rows: labAudit.length, basis: 'consent', idsOnly: true, readById: 'consent row (no basis)' },
    ownWorkWithoutConsent: { listed: labOwnWorkRows.length, patients: labOwnWorkRows.length, read: 200,
      audit: { list: 'own-work, ids only', read: 'own-work' } } };
  step('Lab: own work carries the patient on the list and by id, audited with basis consent; the facility\'s lab member '
    + 'without consent sees the same on the own-work basis (0133)');

  // ── Pharmacy: the same through pharmacy.work_item_patient_cards ──
  const ownRxList = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, 'own Pharmacy list');
  const ownRxItem = ownRxList.items.find(item => item.sourceEhrPrescriptionId === ownPrescription.id);
  assert(ownRxItem, `the automatic send did not reach the hospital's Pharmacy: ${JSON.stringify(ownPrescription.pharmacyHandoff)}`);
  assert.equal(ownRxItem.orderRoute, undefined);
  const ownRxRows = ownRxList.items.filter(item => item.orderRoute === undefined);
  for (const item of ownRxRows) {
    assert.equal(item.patientId, patient.id);
    requirePatient(item, 'pharmacy-api', 'pharmacy.work_item_patient_cards', 'hid_pharmacy_api_runtime', ownPharmacist);
  }
  const ownRxRead = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${ownRxItem.id}`), 200,
    'own Pharmacy item');
  requirePatient(ownRxRead, 'pharmacy-api', 'pharmacy.work_item_patient_cards', 'hid_pharmacy_api_runtime', ownPharmacist);
  const rxAudit = await listAudit('pharmacy.work-item.list', hospital.facilityId, ownPharmacist);
  assert.deepEqual(rxAudit.map(row => [row.patient_id, row.resource_id, row.details]),
    [[patient.id, ownRxItem.id, { basis: 'consent', workItemIds: ownRxRows.map(item => item.id) }]],
    `the Pharmacy list's audit: ${JSON.stringify(rxAudit)}`);
  noIdentityIn(rxAudit, 'the Pharmacy list audit');
  assert.deepEqual(await readBases('pharmacy.work-item.read', hospital.facilityId, ownPharmacist, ownRxItem.id),
    [{ basis: 'consent (no basis)', patient_id: patient.id }], 'the consented pharmacist\'s read is a consent row');
  // 0133: the facility's own pharmacist without consent: the same items and patient, on the own-work basis.
  const rxNoConsent = expectStatus(await pharmacyCall(pharmacistWithoutConsent, 'GET', '/work-items'), 200,
    'Pharmacy list without consent');
  const rxOwnWorkRows = rxNoConsent.items.filter(item => item.orderRoute === undefined);
  assert.deepEqual(rxOwnWorkRows.map(item => item.id), ownRxRows.map(item => item.id),
    'the facility\'s own Pharmacy work listed to its pharmacist without consent (0133)');
  for (const item of rxOwnWorkRows) {
    requirePatient(item, 'pharmacy-api', 'pharmacy.work_item_patient_cards', 'hid_pharmacy_api_runtime',
      pharmacistWithoutConsent);
  }
  const rxNoConsentRead = expectStatus(await pharmacyCall(pharmacistWithoutConsent, 'GET', `/work-items/${ownRxItem.id}`), 200,
    'own Pharmacy item read on the own-work basis');
  requirePatient(rxNoConsentRead, 'pharmacy-api', 'pharmacy.work_item_patient_cards', 'hid_pharmacy_api_runtime',
    pharmacistWithoutConsent);
  const rxOwnWorkAudit = await listAudit('pharmacy.work-item.list', hospital.facilityId, pharmacistWithoutConsent);
  assert.deepEqual(rxOwnWorkAudit.map(row => [row.patient_id, row.resource_id, row.details]),
    [[patient.id, ownRxRows[0].id, { basis: 'own-work', workItemIds: ownRxRows.map(item => item.id) }]],
    `the own-work Pharmacy list's audit: ${JSON.stringify(rxOwnWorkAudit)}`);
  assert.deepEqual(await readBases('pharmacy.work-item.read', hospital.facilityId, pharmacistWithoutConsent, ownRxItem.id),
    [{ basis: 'own-work', patient_id: patient.id }], 'the own-work read is recorded with its basis and the patient');
  noIdentityIn(rxOwnWorkAudit, 'the own-work Pharmacy list audit');
  evidence.pharmacy = { ownItemsListed: ownRxRows.length, withPatient: ownRxRows.length, readById: 'patient',
    audit: { rows: rxAudit.length, basis: 'consent', idsOnly: true, readById: 'consent row (no basis)' },
    ownWorkWithoutConsent: { listed: rxOwnWorkRows.length, patients: rxOwnWorkRows.length, read: 200,
      audit: { list: 'own-work, ids only', read: 'own-work' } } };
  step('Pharmacy: own work carries the patient on the list and by id, audited with basis consent; the facility\'s '
    + 'pharmacist without consent sees the same on the own-work basis (0133)');

  // ── Another facility's pharmacist and lab member: never the hospital's own work ──
  // 0133 gives own work to the facility's own pharmacy and lab staff only (the row's facility must be the session's).
  // The pharmacy's pharmacist and the laboratory's lab member hold the same two permissions at their own facility,
  // so only that rule keeps the hospital's items from them: none listed, none read by id, no list row naming a
  // patient, and the hospital refused as their session's facility (no membership there).
  const outsiders = [['the pharmacy\'s pharmacist', pharmacist, pharmacyCall, ownRxItem, 'pharmacy.work-item.list'],
    ['the laboratory\'s lab member', labAdmin, labCall, ownLabItem, 'lab.work-item.list']];
  for (const [label, who, callAs, ownItem, listAction] of outsiders) {
    const listed = expectStatus(await callAs(who, 'GET', '/work-items'), 200, `${label}'s list`);
    assert(!listed.items.some(item => item.id === ownItem.id || item.patientId === patient.id),
      `the hospital's own work listed to ${label}: ${JSON.stringify(listed.items.map(item => item.id))}`);
    const byId = await callAs(who, 'GET', `/work-items/${ownItem.id}`);
    assert([403, 404].includes(byId.status), `${label} read the hospital's own item: ${byId.status}`);
    assert.equal(JSON.stringify(byId.body ?? '').includes(patient.fullName), false);
    assert.deepEqual(await listAudit(listAction, who.facilityId, who), [], `${label}: a list row names a patient`);
    const claimed = await callAs({ ...who, facilityId: hospital.facilityId }, 'GET', '/work-items');
    assert([401, 403].includes(claimed.status), `${label} with the hospital as the session's facility: ${claimed.status}`);
    assert.equal(JSON.stringify(claimed.body ?? '').includes(patient.fullName), false);
  }
  evidence.otherFacilities = { pharmacist: { listed: 0, readById: 'refused', claimHospital: 'refused' },
    labMember: { listed: 0, readById: 'refused', claimHospital: 'refused' } };
  step('another facility\'s pharmacist and lab member see none of the hospital\'s own work, by list or by id (0133)');

  // ── Route-backed work keeps its patient from the route card only ──
  const attestationVersion = async kind => expectStatus(await call(ehr, doctor, 'GET', `/ehr/order-route-attestation?kind=${kind}`),
    200, `attestation ${kind}`).version;
  const send = async (kind, order, receivingFacilityId) => expectStatus(await ehrCall(doctor, 'POST',
    `${enc}/${kind === 'lab_request' ? 'lab-requests' : 'prescriptions'}/${order.id}/order-routes`,
    { expectedRowVersion: Number(order.rowVersion), receivingFacilityId, patientAgreed: true,
      attestationTextVersion: await attestationVersion(kind) }, { key: freshKey('send') }), 201, `send ${kind}`).route;
  const labRoute = await send('lab_request', await newLabRequest('draft'), laboratory.facilityId);
  const labAccepted = expectStatus(await call(lab, labAdmin, 'POST', `/lab/order-routes/${labRoute.id}/accept`,
    { expectedVersion: 1, patientIdentifier: { kind: 'health_id', value: patient.hid } }, { key: freshKey('accept') }), 201,
  'laboratory accepts');
  // 0133: an active prescription goes to the hospital's own pharmacy by itself, and sending it elsewhere withdraws
  // that own item (D14, checked last below), so for a route-backed item alone the doctor sends a draft, which the
  // order-route send activates and which never reaches the hospital's pharmacy.
  const rxRoute = await send('prescription', await newPrescription('draft'), pharmacyFacility.facilityId);
  const rxAccepted = expectStatus(await call(pharmacy, pharmacist, 'POST', `/pharmacy/order-routes/${rxRoute.id}/accept`,
    { expectedVersion: 1, patientIdentifier: { kind: 'date_of_birth', value: patient.dob },
      reason: 'Synthetic acceptance with the patient at the counter' }, { key: freshKey('accept') }), 201, 'pharmacy accepts');
  const routedItem = async (base, path, who, workItemId) => {
    const list = expectStatus(await call(base, who, 'GET', path), 200, `${who.name}'s list`);
    const item = list.items.find(entry => entry.id === workItemId);
    assert(item, `route-backed work item ${workItemId} not on ${who.name}'s list: ${JSON.stringify(list.items.map(entry => entry.id))}`);
    return item;
  };
  const consentRowsNaming = async (action, facilityId, who, workItemId) => (await listAudit(action, facilityId, who))
    .filter(row => row.details.basis === 'consent' && row.details.workItemIds?.includes(workItemId)).length;
  const labRouted = await routedItem(lab, '/lab/work-items', labAdmin, labAccepted.workItemId);
  const rxRouted = await routedItem(pharmacy, '/pharmacy/work-items', pharmacist, rxAccepted.workItemId);
  assert.deepEqual([labRouted.orderRoute?.access, labRouted.patient], ['work', expectedPatient], 'the laboratory\'s route card');
  assert.deepEqual([rxRouted.orderRoute?.access, rxRouted.patient], ['work', expectedPatient], 'the pharmacy\'s route card');
  const routeBasis = async (action, facilityId, who, workItemId) => (await listAudit(action, facilityId, who))
    .filter(row => row.details.basis === 'order-route' && row.details.workItemIds?.includes(workItemId)).length;
  assert.deepEqual([await routeBasis('lab.work-item.list', laboratory.facilityId, labAdmin, labAccepted.workItemId),
    await routeBasis('pharmacy.work-item.list', pharmacyFacility.facilityId, pharmacist, rxAccepted.workItemId)], [1, 1],
  'route-backed rows are audited on the order-route basis');
  // The routes' windows close (owner SQL; the services' clock cannot be moved). The administrators hold the
  // patient's consent at their facility, so they still read the work, and the own-work reader, which would
  // answer for a consented own row, must give a route-backed row nothing: the card says access none, no patient.
  await owner.query('set session_replication_role = replica');
  try {
    await owner.query(`update ehr.order_routes set writes_end_at = clock_timestamp() - interval '1 minute',
        access_ends_at = clock_timestamp() - interval '1 minute' where id = any($1::uuid[])`, [[labRoute.id, rxRoute.id]]);
  } finally { await owner.query('set session_replication_role = origin'); }
  const labAfter = await routedItem(lab, '/lab/work-items', labAdmin, labAccepted.workItemId);
  const rxAfter = await routedItem(pharmacy, '/pharmacy/work-items', pharmacist, rxAccepted.workItemId);
  assert.deepEqual([labAfter.orderRoute?.access, labAfter.patient], ['none', undefined],
    `lab-api gave a route-backed work item a patient after its route closed: ${JSON.stringify(labAfter.patient)}`);
  assert.deepEqual([rxAfter.orderRoute?.access, rxAfter.patient], ['none', undefined],
    `pharmacy-api gave a route-backed work item a patient after its route closed: ${JSON.stringify(rxAfter.patient)}`);
  const labAfterRead = expectStatus(await call(lab, labAdmin, 'GET', `/lab/work-items/${labAccepted.workItemId}`), 200,
    'route-backed Lab item on consent');
  const rxAfterRead = expectStatus(await call(pharmacy, pharmacist, 'GET', `/pharmacy/work-items/${rxAccepted.workItemId}`), 200,
    'route-backed Pharmacy item on consent');
  assert.deepEqual([labAfterRead.patient, rxAfterRead.patient], [undefined, undefined], 'a route-backed item read by id');
  assert.deepEqual([await consentRowsNaming('lab.work-item.list', laboratory.facilityId, labAdmin, labAccepted.workItemId),
    await consentRowsNaming('pharmacy.work-item.list', pharmacyFacility.facilityId, pharmacist, rxAccepted.workItemId)], [0, 0],
  'a route-backed row was audited as shown on the consent basis');
  evidence.routeBacked = { whileOpen: { access: 'work', patient: 'from the route card', audit: 'order-route basis' },
    afterWindows: { lab: { listed: true, access: 'none', patient: 'none', readById: 'none' },
      pharmacy: { listed: true, access: 'none', patient: 'none', readById: 'none' }, readerOnConsentHolder: 'none' },
    consentBasisRows: 0 };
  step('route-backed work: the card\'s patient while the route is open, none after it closes, though its reader holds consent');

  // ── Sent elsewhere before dispensing (0133 D14, owner's Q121 A) ──
  // The hospital's own prescription is still undispensed, so the doctor can send it to the pharmacy. The send
  // withdraws the hospital's item ("sent elsewhere"): neither of the hospital's pharmacists lists it any more; the
  // one without consent still reads it by id on the own-work basis, marked, audited with the patient; and the
  // database refuses its dispensing.
  const elsewhereRoute = await send('prescription', ownPrescription, pharmacyFacility.facilityId);
  for (const who of [pharmacistWithoutConsent, ownPharmacist]) {
    const listed = expectStatus(await pharmacyCall(who, 'GET', '/work-items'), 200, `${who.name}'s list after the send elsewhere`);
    assert(!listed.items.some(item => item.id === ownRxItem.id),
      `${who.name} still lists the item sent elsewhere: ${JSON.stringify(listed.items.map(item => item.id))}`);
  }
  const elsewhereRead = expectStatus(await pharmacyCall(pharmacistWithoutConsent, 'GET', `/work-items/${ownRxItem.id}`), 200,
    'the item sent elsewhere, by id, on the own-work basis');
  assert.deepEqual([elsewhereRead.id, elsewhereRead.withdrawn, elsewhereRead.withdrawnReason],
    [ownRxItem.id, true, 'sent_elsewhere'], JSON.stringify(elsewhereRead));
  assert.deepEqual(await readBases('pharmacy.work-item.read', hospital.facilityId, pharmacistWithoutConsent, ownRxItem.id),
    [{ basis: 'own-work', patient_id: patient.id }, { basis: 'own-work', patient_id: patient.id }],
    'the read of the item sent elsewhere is recorded with basis own-work and the patient');
  const elsewhereDispense = await pharmacyCall(pharmacistWithoutConsent, 'POST', `/work-items/${ownRxItem.id}/dispensings`,
    { expectedWorkItemVersion: Number(ownRxItem.version), quantityDispensed: 60, quantityUnit: 'tablet',
      reason: 'Synthetic dispensing after the send elsewhere' }, { key: freshKey('dispense') });
  assert.deepEqual([elsewhereDispense.status, elsewhereDispense.body?.code, elsewhereDispense.body?.withdrawnReason],
    [409, 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE', 'sent_elsewhere'], JSON.stringify(elsewhereDispense.body));
  assert.equal((await one('select count(*)::int as n from pharmacy.dispensings where work_item_id = $1', [ownRxItem.id])).n, 0,
    'the item sent elsewhere has no dispensing');
  evidence.sentElsewhere = { route: elsewhereRoute.effectiveState, hospitalLists: 'left out (both pharmacists)',
    readById: { status: 200, withdrawnReason: 'sent_elsewhere', audit: 'own-work, with the patient' },
    dispense: `409 ${elsewhereDispense.body?.code}` };
  step('sent elsewhere before dispensing: off the hospital\'s lists, read by id as sent_elsewhere on the own-work basis, '
    + 'not dispensable');

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
