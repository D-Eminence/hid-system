#!/usr/bin/env node
// This facility's own pharmacy and lab work and the automatic send to the
// hospital's own pharmacy (0133, docs/INTERFACE_CONTRACT.md ORD-2) end to end,
// over HTTP: Identity, EHR, Lab and Pharmacy each booted from its own source
// (its own main.ts) in its own process, each connected as its exact runtime
// role, the services calling each other over loopback with local-secret
// workload identity, Lab and Pharmacy with OWN_WORK_PATIENT_CARD_ENABLED left
// off (the default: 0133 records every own row whether or not its card is
// shown). Only the outbound boundaries are local stubs: QoreID (for facility
// sign-up) and notification-api's OTP and staff-invitation routes, on one
// loopback server; a preload refuses every other non-loopback request. All
// values are synthetic. It runs only against the owned disposable synthetic
// rehearsal or, with HID_OWN_FACILITY_WORK_RUNTIME_LOCAL_CLUSTER=loopback, a
// disposable copy of a database on a loopback test cluster.
//
// Why it exists: the database suite proves 0133's functions and policies
// through the runtime roles in hand-set sessions; this proves what the
// deployed services do with them. ehr-api sends in a savepoint and answers
// without pharmacyHandoff on any failure it cannot name, and lab-api and
// pharmacy-api fall back to Identity's consent when 0133's check fails, so a
// missing EXECUTE or a wrong column would pass every unit test and still
// leave the pharmacist with "To dispense 0".
//
// The flow: a hospital signs up (P4) and support reviews it (P4b); its
// administrator, a doctor, invites a pharmacist and a lab scientist (P4b),
// for whom the patient approves nothing. The patient approves the doctor's
// access in the app. Checked: the doctor's active prescription, and a draft
// activated later, go to the hospital's own pharmacy by themselves
// (pharmacyHandoff sent; the work item accepted by the doctor with the fixed
// reason); the pharmacist without a grant lists them (one list audit row
// naming the patient, basis own-work, ids only), reads one and dispenses it
// (rows with basis own-work); a hold withdraws the other (the list marks it
// withdrawn and dispensing it answers 409); an edit of a third answers the
// "earlier version" hand-off (reason superseded), its ownProgress reads
// withdrawn and "Send to pharmacy" answers the same row; an edit of the
// dispensed one answers no hand-off, "Send to pharmacy" then answers that the
// pharmacy already has it (not the earlier-version row), its item is not
// marked withdrawn and its ownProgress stays dispensed; the list carries
// ownPharmacyStaffed;
// the lab scientist without a grant lists,
// reads and accessions the doctor's lab request handed to the hospital's
// Lab, takes and receives the sample, starts the test and reads the execution
// and the specimen's executions (each read audited with the patient and basis
// own-work); neither reads anything of the chart, each probed with a chart
// read its role does permit (encounters for both, prescriptions for the
// pharmacist, the lab request for the lab scientist), so the patient's
// consent, not a missing permission, refuses it (403 CONSENT_REQUIRED); the
// patient's access log shows both as views. Owner SQL is used only for what no route does: the
// platform administrator's and the patient's accounts (as the other runtime
// verifiers seed them), QoreID switched on, and reading what the database
// holds.
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
const loopback = process.env.HID_OWN_FACILITY_WORK_RUNTIME_LOCAL_CLUSTER === 'loopback'
  && ['127.0.0.1', '::1', 'localhost'].includes(socket ?? '')
  && /^[a-z][a-z0-9_]{0,40}$/.test(process.env.PGDATABASE ?? '');
assert(process.env.NODE_ENV === 'test' && (rehearsal || loopback),
  'Only the owned synthetic rehearsal or an explicitly named loopback test cluster is supported');
assert(process.env.OTP_HMAC_KEY_B64, 'The rehearsal OTP HMAC key is required');
assert(process.env.AUTH_SIGNING_SECRET && process.env.AUTH_LOGIN_PEPPER, 'Synthetic session keys are required');
const port = Number(process.env.PGPORT ?? 5432);
const pgUser = process.env.PGUSER ?? 'postgres';
const isolated = `${rehearsal ? 'hid_rehearsal' : process.env.PGDATABASE}_ownwork_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const databaseUrl = role => {
  const options = `options=${encodeURIComponent(`-c role=${role}`)}`;
  return rehearsal
    ? `postgresql://${pgUser}@localhost:${port}/${isolated}?host=${encodeURIComponent(socket)}&${options}`
    : `postgresql://${pgUser}@${socket === '::1' ? '[::1]' : socket}:${port}/${isolated}?${options}`;
};
// 0124's setting, left at its default (off): 0133's audit rows do not depend on it.
const OWN_WORK_PATIENT_CARD_ENABLED = 'false';

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
const temporary = await mkdtemp(join(tmpdir(), 'hid-own-facility-work-'));
const evidence = { migration: '0133', setting: { OWN_WORK_PATIENT_CARD_ENABLED }, steps };
const startedAt = Date.now();
let failure;
try {
  // The database holds 0133 (its functions' grants are what this run proves over HTTP, not read here).
  const functions = await all(`select proc.oid::regprocedure::text as name from pg_proc proc
    where (proc.pronamespace, proc.proname) in (('ehr'::regnamespace, 'send_prescription_to_own_pharmacy'),
      ('pharmacy'::regnamespace, 'own_work_access_for'), ('lab'::regnamespace, 'own_work_access_for'))
    order by 1`);
  assert.deepEqual(functions.map(row => row.name), ['ehr.send_prescription_to_own_pharmacy(uuid,bigint)',
    'lab.own_work_access_for(text,uuid,text)', 'pharmacy.own_work_access_for(text,uuid,text)'], 'a database with 0133');
  evidence.database = { functions: functions.map(row => row.name) };
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

  // ── Support, the hospital (P4 sign-up, P4b review) and its own pharmacist and lab scientist (P4b) ──
  const password = 'Synthetic-Own-Facility-Work-Password-2026';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const synthetic = label => `ownwork-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
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
    values ($1, $2, 'platform_super_admin', 'platform', 'Synthetic platform administrator for the own facility work verifier')`,
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
      reason: `Own facility work verifier: ${controlKey} ${enabled ? 'on' : 'off'}` }, { ifMatch: control.version }), 201,
    `control ${controlKey}`);
  };
  await setControl('provider_self_service_enabled', true);
  await setControl('staff_invitations_enabled', true);

  const cac = 'RC99300088001';
  companies.set(cac, { name: `Verifier Own Work Hospital ${cac} Ltd`, address: '1 Synthetic Own Work Road, Ikeja, Lagos' });
  const administratorEmail = synthetic('admin');
  const started = await http(identity, 'POST', '/identity/provider-enrollments', { origin: appOrigin,
    forwardedFor: '198.51.180.1', body: { cacRegistrationNumber: cac, administratorEmail, organizationType: 'hospital',
      productCode: 'ehr', administratorName: 'Adaeze Ownwork', turnstileAction: 'provider-enrollment',
      turnstileToken: 'disabled-in-this-run', ...signupCollectedFields('Hospital') } });
  expectStatus(started, 200, 'sign-up start');
  const deadline = Date.now() + 15_000;
  while (!otpCodes.has(started.body.challengeId)) {
    assert(Date.now() < deadline, 'no sign-up code');
    await new Promise(done => setTimeout(done, 100));
  }
  const verifiedResponse = await http(identity, 'POST', '/identity/provider-enrollments/verify', { origin: appOrigin,
    body: { challengeId: started.body.challengeId, code: otpCodes.get(started.body.challengeId) } });
  expectStatus(verifiedResponse, 200, 'sign-up verify');
  const enrolmentCookie = verifiedResponse.cookies.find(value => value.startsWith('hid_provider_enrollment='));
  const activated = expectStatus(await http(identity, 'POST', '/identity/provider-enrollments/activate', { origin: appOrigin,
    cookie: enrolmentCookie, body: { password } }), 200, 'sign-up activation');
  const hospital = { facilityId: activated.facilityId, applicationId: (await one(`select application.id as application_id
      from identity.facilities facility join identity.organization_applications application
        on application.organization_id = facility.organization_id where facility.id=$1`, [activated.facilityId])).application_id };
  const listed = expectStatus(await adminCall('GET', '/admin/self-service-facilities?state=all'), 200, 'support list');
  const pending = listed.items.find(entry => entry.applicationId === hospital.applicationId);
  assert(pending, 'the hospital is not in support\'s list');
  expectStatus(await adminCall('POST', `/admin/self-service-facilities/${hospital.applicationId}/review`,
    { note: 'Checked the administrator against the company record and the register', grantedRole: 'doctor',
      verificationMethod: 'regulator_register', administratorLicence: { body: 'MDCN', number: 'MDCN/73011' } },
    { ifMatch: pending.version }), 200, 'review the hospital');
  const doctor = await signInStaff(administratorEmail, HOSTS.ehr, hospital.facilityId, 'Adaeze Ownwork');
  const call = (base, who, method, path, body, extra = {}) => http(base, method, path, { cookie: who.cookie,
    facility: who.facilityId, purpose: 'direct-care', ...(method === 'GET' ? {} : { origin: who.origin, csrf: who.csrf }),
    body, ...extra });
  const freshKey = label => `verifier-${label}-${randomUUID()}`;
  let invitations = 0;
  const invited = async (host, person) => {
    invitations += 1;
    const before = invitationEmails.length;
    const answer = expectStatus(await call(identity, doctor, 'POST', '/identity/staff-invitations',
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
    return signInStaff(person.email, host, hospital.facilityId, person.name);
  };
  const ownPharmacist = await invited(HOSTS.pharmacy, { name: 'Musa Ownwork', email: synthetic('pharmacist'),
    role: 'pharmacist', licenceBody: 'PCN', licenceNumber: 'PCN/83011' });
  const ownScientist = await invited(HOSTS.lab, { name: 'Kemi Ownwork', email: synthetic('lab'), role: 'lab',
    licenceBody: 'MLSCN', licenceNumber: 'MLSCN/83022' });
  step('a hospital signed up and reviewed; its administrator (a doctor) invited a pharmacist and a lab scientist');

  // ── The patient approves the doctor only ──
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const patientAccount = randomUUID();
  const patient = { id: randomUUID(), hid: `HID-${Array.from(randomBytes(10), byte => alphabet[byte % alphabet.length]).join('')}`,
    email: synthetic('patient'), fullName: 'Bisi Verifier-Ownwork', sex: 'female', dob: '1987-03-14' };
  await owner.query(`insert into auth.accounts (id, subject, email, display_name, password_hash, password_algorithm, status)
    values ($1, $2, $3, $4, $5, 'argon2id', 'active')`,
  [patientAccount, `synthetic:patient:${patientAccount}`, patient.email, patient.fullName, passwordHash]);
  await owner.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob,
      status) values ($1, $2, $3, 'Bisi', 'Verifier-Ownwork', $4, $5, $6, 'active')`,
  [patient.id, patientAccount, patient.hid, patient.fullName, patient.sex, patient.dob]);
  const loggedIn = await http(identity, 'POST', '/auth/patient/login', { origin: appOrigin,
    body: { email: patient.email, password, turnstileAction: 'patient-login' } });
  expectStatus(loggedIn, 200, 'patient sign-in');
  const patientSession = { cookie: loggedIn.cookies.join('; '), csrf: loggedIn.headers.get('x-csrf-token') };
  const patientCall = (method, path, body) => http(identity, method, path, { cookie: patientSession.cookie,
    ...(method === 'GET' ? {} : { origin: appOrigin, csrf: patientSession.csrf }), body });
  const requested = expectStatus(await call(identity, doctor, 'POST', '/identity/access-requests',
    { hid: patient.hid, scope: 'write_records', reason: 'Synthetic visit for the own facility work verifier',
      durationMinutes: 1440 }), 201, 'the doctor\'s access request');
  assert.equal(expectStatus(await patientCall('POST', `/identity/access-requests/${requested.accessRequestId}/approve`), 200,
    'approve the doctor').status, 'approved');
  const grantsOf = async who => (await one(`select count(*)::int as n from identity.consent_grants grant_row
    join identity.staff_facility_memberships membership on membership.id = grant_row.membership_id
    where membership.account_id = $1 and grant_row.patient_id = $2`, [who.accountId, patient.id])).n;
  assert.deepEqual([await grantsOf(ownPharmacist), await grantsOf(ownScientist)], [0, 0],
    'the pharmacist and the lab scientist hold no grant for the patient');
  step('the patient approved the doctor in the app; the pharmacist and the lab scientist hold no grant');

  // ── The automatic send ──
  const ehrCall = (who, method, path, body, extra) => call(ehr, who, method, `/ehr/patients/${patient.id}${path}`, body, extra);
  const pharmacyCall = (who, method, path, body, extra) => call(pharmacy, who, method, `/pharmacy${path}`, body, extra);
  const labCall = (who, method, path, body, extra) => call(lab, who, method, `/lab${path}`, body, extra);
  const encounter = expectStatus(await ehrCall(doctor, 'POST', '/encounters', { encounterType: 'ambulatory',
    status: 'in_progress', startedAt: new Date().toISOString(), chiefComplaint: 'Synthetic chief complaint' },
  { key: freshKey('encounter') }), 201, 'encounter');
  const enc = `/encounters/${encounter.id}`;
  const newPrescription = async (status, display) => expectStatus(await ehrCall(doctor, 'POST', `${enc}/prescriptions`,
    { medicationCodeSystem: 'http://snomed.info/sct', medicationCode: '325072002', medicationDisplay: display,
      doseQuantity: 1, doseUnit: 'tablet', routeCode: 'oral', frequency: 'twice daily',
      instructions: 'Synthetic instructions: take with food', status }, { key: freshKey('prescription') }), 201,
  `prescription ${display}`);
  const SENT = { status: 'sent', message: 'Sent to this hospital\'s pharmacy.' };
  const ALREADY = { status: 'sent', message: 'This hospital\'s pharmacy already has this prescription.' };
  const EARLIER = { status: 'not_sent', reason: 'superseded',
    message: 'Not sent: this hospital\'s pharmacy has an earlier version of this prescription, which it can no longer dispense.' };
  const rx1 = await newPrescription('active', 'Synthetic metformin 500 mg tablet');
  assert.deepEqual(rx1.pharmacyHandoff, SENT, `rx1's hand-off: ${JSON.stringify(rx1.pharmacyHandoff)}`);
  const rx2Draft = await newPrescription('draft', 'Synthetic amlodipine 5 mg tablet');
  assert.equal(rx2Draft.pharmacyHandoff, undefined, 'a draft answers no hand-off');
  const rx2 = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rx2Draft.id}`,
    { expectedRowVersion: Number(rx2Draft.rowVersion), status: 'active' }), 200, 'activate rx2');
  assert.deepEqual(rx2.pharmacyHandoff, SENT, `rx2's hand-off on activation: ${JSON.stringify(rx2.pharmacyHandoff)}`);
  const rx3 = await newPrescription('active', 'Synthetic lisinopril 10 mg tablet');
  assert.deepEqual(rx3.pharmacyHandoff, SENT);
  const sentItems = await all(`select source_ehr_prescription_id::text as rx, source_ehr_prescription_version::text as version,
      accepted_by::text as accepted_by, acceptance_reason, order_route_id
    from pharmacy.work_items where patient_id = $1 order by created_at`, [patient.id]);
  assert.deepEqual(sentItems.map(row => [row.rx, row.accepted_by, row.acceptance_reason, row.order_route_id]),
    [rx1, rx2, rx3].map(rx => [rx.id, doctor.accountId, 'Sent automatically when the prescription was activated', null]),
    `the work items the sends wrote: ${JSON.stringify(sentItems)}`);
  evidence.send = { createdActive: 'sent', activatedDraft: 'sent', draft: 'no hand-off',
    workItems: { acceptedBy: 'the prescriber', reason: 'fixed', route: 'none' } };
  step('the doctor\'s active prescription, and a draft when activated, went to the hospital\'s own pharmacy by themselves');

  // ── The pharmacist without a grant ──
  const auditRows = (who, action) => all(`select patient_id::text, resource_id::text, details from audit.events
    where actor_account_id = $1 and action = $2 order by sequence_id`, [who.accountId, action]);
  const rxList = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, 'the pharmacist\'s list');
  const itemOf = rx => rxList.items.find(item => item.sourceEhrPrescriptionId === rx.id);
  const [item1, item2, item3] = [rx1, rx2, rx3].map(itemOf);
  assert(item1 && item2 && item3, `the pharmacist's list: ${JSON.stringify(rxList.items.map(item => item.sourceEhrPrescriptionId))}`);
  assert.deepEqual([item1, item2, item3].map(item => [item.orderRoute, item.withdrawn, item.patientId]),
    [[undefined, undefined, patient.id], [undefined, undefined, patient.id], [undefined, undefined, patient.id]]);
  const rxListAudit = await auditRows(ownPharmacist, 'pharmacy.work-item.list');
  const ownRows = rxList.items.filter(item => item.orderRoute === undefined).map(item => item.id);
  assert.deepEqual(rxListAudit.filter(row => row.patient_id).map(row => [row.patient_id, row.details]),
    [[patient.id, { basis: 'own-work', workItemIds: ownRows }]], `the list's audit: ${JSON.stringify(rxListAudit)}`);
  const read1 = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${item1.id}`), 200, 'read rx1\'s item');
  assert.equal(read1.id, item1.id);
  expectStatus(await pharmacyCall(ownPharmacist, 'POST', `/work-items/${item1.id}/dispensings`,
    { expectedWorkItemVersion: Number(item1.version), quantityDispensed: 60, quantityUnit: 'tablet',
      reason: 'Synthetic own-work dispensing' }, { key: freshKey('dispense') }), 201, 'dispense rx1 without a grant');
  assert.deepEqual((await auditRows(ownPharmacist, 'pharmacy.work-item.read')).map(row => [row.patient_id, row.details.basis]),
    [[patient.id, 'own-work']], 'the read is recorded with its basis');
  assert.deepEqual((await auditRows(ownPharmacist, 'pharmacy.dispensing.create')).map(row => [row.patient_id,
    row.details.basis]), [[patient.id, 'own-work']], 'the dispensing is recorded with its basis');
  evidence.pharmacist = { grants: 0, listed: ownRows.length, listAudit: 'one row, the patient, own-work, ids only',
    read: 200, dispensed: 201, rowsBasis: 'own-work' };
  step('the pharmacist without a grant lists, reads and dispenses the hospital\'s own work, each audited with basis own-work');

  // ── Stopping and changing after the send ──
  const held = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rx2.id}`,
    { expectedRowVersion: Number(rx2.rowVersion), status: 'on_hold', changeReason: 'Synthetic hold pending review' }), 200,
  'hold rx2');
  assert.equal(held.pharmacyHandoff, undefined, 'a hold answers no hand-off');
  const afterHold = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, 'the list after the hold');
  assert.equal(afterHold.items.find(item => item.id === item2.id)?.withdrawn, true, 'the held prescription\'s item is withdrawn');
  const refused = await pharmacyCall(ownPharmacist, 'POST', `/work-items/${item2.id}/dispensings`,
    { expectedWorkItemVersion: Number(item2.version), quantityDispensed: 30, quantityUnit: 'tablet',
      reason: 'Synthetic dispensing after a hold' }, { key: freshKey('dispense') });
  assert.deepEqual([refused.status, refused.body?.code], [409, 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE'],
    `dispensing a withdrawn item: ${JSON.stringify(refused.body)}`);
  const edited = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rx3.id}`,
    { expectedRowVersion: Number(rx3.rowVersion), frequency: 'once daily', changeReason: 'Synthetic change of frequency' }), 200,
  'edit rx3');
  assert.deepEqual(edited.pharmacyHandoff, EARLIER, `the edit's hand-off: ${JSON.stringify(edited.pharmacyHandoff)}`);
  const sendAgain = expectStatus(await ehrCall(doctor, 'POST', `${enc}/prescriptions/${rx3.id}/own-pharmacy-send`,
    { expectedRowVersion: Number(edited.rowVersion) }), 200, 'Send to pharmacy after the edit');
  assert.deepEqual(sendAgain.pharmacyHandoff, EARLIER, 'Send to pharmacy answers the earlier-version row');
  // A change after the dispensing: recorded on the send, reported nowhere (what was sent was dispensed).
  const editedAfterDispensing = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rx1.id}`,
    { expectedRowVersion: Number(rx1.rowVersion), frequency: 'three times daily',
      changeReason: 'Synthetic change after dispensing' }), 200, 'edit rx1 after its dispensing');
  assert.equal(editedAfterDispensing.pharmacyHandoff, undefined,
    `an edit after the dispensing answers no hand-off: ${JSON.stringify(editedAfterDispensing.pharmacyHandoff)}`);
  const sendAfterDispensing = expectStatus(await ehrCall(doctor, 'POST', `${enc}/prescriptions/${rx1.id}/own-pharmacy-send`,
    { expectedRowVersion: Number(editedAfterDispensing.rowVersion) }), 200, 'Send to pharmacy after the dispensing and edit');
  assert.deepEqual(sendAfterDispensing.pharmacyHandoff, ALREADY,
    `Send to pharmacy after the dispensing: ${JSON.stringify(sendAfterDispensing.pharmacyHandoff)}`);
  const afterEdits = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, 'the list after the edits');
  assert.deepEqual([item1, item2, item3].map(item => afterEdits.items.find(row => row.id === item.id)?.withdrawn),
    [undefined, true, true], 'withdrawn on the list: the held and the edited items, never the dispensed one');
  // ORD-3 through ehr-api, the doctor's cookie only: dispensed (also after its edit), withdrawn (held and edited);
  // and the list's ownPharmacyStaffed (the hospital has a pharmacist).
  const progressList = expectStatus(await http(ehr, 'GET', `/ehr/patients/${patient.id}${enc}/prescriptions`,
    { cookie: doctor.cookie, facility: hospital.facilityId, purpose: 'direct-care' }), 200, 'the doctor\'s prescriptions');
  const progressOf = rx => progressList.items.find(item => item.id === rx.id)?.ownProgress?.status;
  assert.deepEqual([progressOf(rx1), progressOf(rx2), progressOf(rx3)], ['dispensed', 'withdrawn', 'withdrawn'],
    `ownProgress: ${JSON.stringify(progressList.items.map(item => [item.id, item.ownProgress]))}`);
  assert(progressList.items.length > 0 && progressList.items.every(item => item.ownPharmacyStaffed === true),
    `ownPharmacyStaffed: ${JSON.stringify(progressList.items.map(item => [item.id, item.ownPharmacyStaffed]))}`);
  const sends = await all(`select prescription_id::text as rx, state, prescription_version::text as version,
      withdrawn_at is not null as withdrawn from pharmacy.own_prescription_sends where patient_id = $1
    order by created_at`, [patient.id]);
  assert.deepEqual(sends.map(row => [row.rx, row.state, row.withdrawn]),
    [[rx1.id, 'sent', true], [rx2.id, 'sent', true], [rx3.id, 'sent', true]], `the sends: ${JSON.stringify(sends)}`);
  evidence.afterTheSend = { hold: { handoff: 'none', list: 'withdrawn', dispense: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE' },
    edit: { handoff: 'earlier version (superseded)', sendToPharmacy: 'earlier version (superseded)' },
    editAfterDispensing: { handoff: 'none', sendToPharmacy: 'already has it', list: 'not withdrawn', ownProgress: 'dispensed',
      send: 'change recorded' },
    ownProgress: { dispensed: 'dispensed', held: 'withdrawn', edited: 'withdrawn' }, ownPharmacyStaffed: true };
  step('a hold withdraws the send (Dispense refused); an edit answers the earlier-version hand-off; ownProgress reads '
    + 'withdrawn; an edit after the dispensing reports nothing');

  // ── The lab scientist without a grant ──
  const labRequest = expectStatus(await ehrCall(doctor, 'POST', `${enc}/lab-requests`,
    { testCodeSystem: 'http://loinc.org', testCode: '4548-4', testDisplay: 'Synthetic HbA1c panel', priority: 'routine',
      status: 'active', specimenTypeCode: 'blood', clinicalInformation: 'Synthetic clinical note' },
  { key: freshKey('lab-request') }), 201, 'lab request');
  const now = () => new Date().toISOString();
  const labList = expectStatus(await labCall(ownScientist, 'GET', '/work-items'), 200, 'the lab scientist\'s list');
  const labItem = labList.items.find(item => item.sourceEhrOrderId === labRequest.id);
  assert(labItem, `the hand-off to the hospital's Lab: ${JSON.stringify({ labWorkItem: labRequest.labWorkItem,
    labHandoff: labRequest.labHandoff })}`);
  assert.equal(labItem.orderRoute, undefined);
  expectStatus(await labCall(ownScientist, 'GET', `/work-items/${labItem.id}`), 200, 'read the lab work item');
  const accession = expectStatus(await labCall(ownScientist, 'POST', `/work-items/${labItem.id}/accession`,
    { requirements: [{ specimenType: 'blood' }], reason: 'Synthetic own-work accession' }, { key: freshKey('accession') }),
  201, 'accession without a grant');
  let specimen = accession.specimens[0];
  specimen = expectStatus(await labCall(ownScientist, 'POST', `/accessions/${accession.id}/specimens/${specimen.id}/collect`,
    { expectedVersion: specimen.version, collectedAt: now() }, { key: freshKey('collect') }), 201, 'collect');
  specimen = expectStatus(await labCall(ownScientist, 'POST', `/accessions/${accession.id}/specimens/${specimen.id}/receive`,
    { expectedVersion: specimen.version, receivedAt: now() }, { key: freshKey('receive') }), 201, 'receive');
  const execution = expectStatus(await labCall(ownScientist, 'POST', `/specimens/${specimen.id}/executions`,
    { expectedSpecimenVersion: specimen.version, startedAt: now(), reason: 'Synthetic own-work run' },
  { key: freshKey('execution') }), 201, 'start the test');
  expectStatus(await labCall(ownScientist, 'GET', `/executions/${execution.id}`), 200, 'read the execution');
  expectStatus(await labCall(ownScientist, 'GET', `/specimens/${specimen.id}/executions`), 200, 'the specimen\'s executions');
  const labRows = await all(`select action, patient_id::text, details->>'basis' as basis from audit.events
    where actor_account_id = $1 and action like 'lab.%' and action <> 'api.lab.request' order by sequence_id`,
  [ownScientist.accountId]);
  const labActions = labRows.filter(row => row.patient_id).map(row => row.action);
  for (const action of ['lab.work-item.list', 'lab.work-item.read', 'lab.accession.create', 'lab.execution.start',
    'lab.execution.read', 'lab.execution.list']) {
    assert(labActions.includes(action), `no ${action} row naming the patient: ${JSON.stringify(labRows)}`);
  }
  assert(labRows.filter(row => row.patient_id).every(row => row.patient_id === patient.id && row.basis === 'own-work'),
    `the lab scientist's rows: ${JSON.stringify(labRows)}`);
  evidence.labScientist = { grants: 0, listed: true, chain: ['read', 'accession', 'collect', 'receive', 'start',
    'read the execution', 'list the specimen\'s executions'], rowsBasis: 'own-work', executionReadsAudited: true };
  step('the lab scientist without a grant works the hospital\'s own lab request; every row, the execution reads included, '
    + 'names the patient with basis own-work');

  // ── Never the chart ──
  // Each probe is a chart read the member's role permits (0006: both hold ehr.encounter.read; the pharmacist
  // ehr.prescription.read, the lab scientist ehr.lab-request.read), so the refusal is the patient's consent
  // (403 CONSENT_REQUIRED), never a missing permission (403 PERMISSION_DENIED).
  const chartProbes = [[ownPharmacist, `/ehr/patients/${patient.id}${enc}`],
    [ownPharmacist, `/ehr/patients/${patient.id}${enc}/prescriptions`],
    [ownPharmacist, `/ehr/patients/${patient.id}${enc}/prescriptions/${rx1.id}`],
    [ownScientist, `/ehr/patients/${patient.id}${enc}`],
    [ownScientist, `/ehr/patients/${patient.id}${enc}/lab-requests/${labRequest.id}`]];
  for (const [who, path] of chartProbes) {
    const chart = await call(ehr, who, 'GET', path);
    assert.deepEqual([chart.status, chart.body?.code], [403, 'CONSENT_REQUIRED'], `${who.name} GET ${path}: ${chart.status} `
      + JSON.stringify(chart.body));
    assert.equal(JSON.stringify(chart.body ?? '').includes(patient.fullName), false);
  }
  const log = expectStatus(await patientCall('GET', '/identity/me/access-log?limit=100'), 200, 'the patient\'s access log');
  const viewers = new Set(log.events.filter(event => event.action === 'viewed').map(event => event.actorName));
  assert(viewers.has(ownPharmacist.name) && viewers.has(ownScientist.name),
    `the patient's access log: ${JSON.stringify(log.events.map(event => [event.action, event.actorName]))}`);
  evidence.chart = { pharmacist: 'CONSENT_REQUIRED (encounter, prescriptions, a prescription)',
    labScientist: 'CONSENT_REQUIRED (encounter, the lab request)', patientAccessLog: 'both shown as views' };
  step('neither reads the chart; the patient\'s access log shows both as views');

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
