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
// withdrawn, withdrawnReason changed, and dispensing it answers 409); an edit
// of a third answers the "earlier version" hand-off (reason superseded), its
// ownProgress reads withdrawn and "Send to pharmacy" answers the same row; an
// edit of the dispensed one answers no hand-off, "Send to pharmacy" then
// answers that the pharmacy already has it (not the earlier-version row), its
// item is not marked withdrawn and its ownProgress stays dispensed; a fourth,
// sent and still open, lists first, and the two withdrawn items list with the
// done work, newest first (0133 D14: they can never be dispensed); the list
// carries ownPharmacyStaffed;
// the lab runtime, asking the row's half directly in the lab scientist's
// session, is told false for the patient, who has own pharmacy work there but
// no own lab work yet (D15, owner's Q122 A), and true once the lab request is
// the hospital's Lab's; it may not ask the pharmacy body at all (42501);
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
//
// ORD-4 (a pharmacist accepts a prescription before dispensing it, owner's
// Q125 B): every item sent by itself lists as pharmacyStep received, with no
// pharmacist's acceptance; the first dispensing of a received item accepts
// it first (acceptedWith dispensing, by the dispensing pharmacist with the
// dispensing's key, one pharmacist_accepted event of version 2, and
// acceptedWithDispensing on the dispensing's audit row); the pharmacist,
// still without a grant, accepts the open item on the own-work basis (201,
// then 200 alreadyAccepted for the same call and for a new key, each audited
// with the patient, its outcome, acceptedWith and basis own-work), and the
// list then shows pharmacyStep accepted while status and acceptedAt keep
// their Release A meaning; the doctor's ownProgress reads accepted with
// acceptedAt, then dispensed (acceptedAt kept) once it is dispensed, which
// records no second acceptance; pharmacy-api, asked as ehr-api with only
// X-HID-Own-Progress: 0133 (a Release A ehr-api), answers received for the
// accepted item with no acceptedAt, and the same with only ORD-4's header,
// accepted only with both; an accepted item put on hold reads withdrawn,
// keeps its acceptance (Accept answers it again, 200) and cannot be
// dispensed (409); an item held before anyone accepted it cannot be accepted
// (409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE, withdrawnReason changed); and
// Accept on the item a dispensing accepted answers that acceptance (200).
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
  // The database holds 0133 (its functions' grants are what this run proves over HTTP, not read here), with
  // D14's reader and D1's row's half split by kind.
  const functions = await all(`select proc.oid::regprocedure::text as name from pg_proc proc
    where (proc.pronamespace, proc.proname) in (('ehr'::regnamespace, 'send_prescription_to_own_pharmacy'),
      ('pharmacy'::regnamespace, 'own_work_access_for'), ('lab'::regnamespace, 'own_work_access_for'),
      ('pharmacy'::regnamespace, 'own_withdrawn_work_items'), ('identity'::regnamespace, 'lab_work_patient_allows'),
      ('identity'::regnamespace, 'pharmacy_work_patient_allows'))`);
  assert.deepEqual(functions.map(row => row.name).sort(), ['ehr.send_prescription_to_own_pharmacy(uuid,bigint)',
    'identity.lab_work_patient_allows(uuid,uuid,uuid,text)', 'identity.pharmacy_work_patient_allows(uuid,uuid,uuid,text)',
    'lab.own_work_access_for(text,uuid,text)', 'pharmacy.own_withdrawn_work_items()',
    'pharmacy.own_work_access_for(text,uuid,text)'].sort(), 'a database with 0133');
  evidence.database = { functions: functions.map(row => row.name) };
  // ORD-4: the acceptance table, its insert check and the steps reader the work list, a read, Accept and the
  // progress read ask (an image on a database without them answers no pharmacyStep and never 'accepted').
  const ord4 = await one(`select to_regclass('pharmacy.work_item_acceptances')::text as acceptances,
      to_regprocedure('pharmacy.validate_work_item_acceptance()')::text as acceptance_check,
      to_regprocedure('pharmacy.own_work_item_steps(uuid[])')::text as steps`);
  assert.deepEqual(ord4, { acceptances: 'pharmacy.work_item_acceptances',
    acceptance_check: 'pharmacy.validate_work_item_acceptance()', steps: 'pharmacy.own_work_item_steps(uuid[])' },
  `a database with ORD-4: ${JSON.stringify(ord4)}`);
  evidence.database.ord4 = Object.values(ord4);
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
  // A fourth, sent and left open: it lists before the withdrawn items below, which count as done work.
  const rx4 = await newPrescription('active', 'Synthetic atorvastatin 20 mg tablet');
  assert.deepEqual(rx4.pharmacyHandoff, SENT, `rx4's hand-off: ${JSON.stringify(rx4.pharmacyHandoff)}`);
  evidence.send = { createdActive: 'sent', activatedDraft: 'sent', draft: 'no hand-off',
    workItems: { acceptedBy: 'the prescriber', reason: 'fixed', route: 'none' } };
  step('the doctor\'s active prescriptions, and a draft when activated, went to the hospital\'s own pharmacy by themselves');

  // ── The pharmacist without a grant ──
  const auditRows = (who, action) => all(`select patient_id::text, resource_id::text, details from audit.events
    where actor_account_id = $1 and action = $2 order by sequence_id`, [who.accountId, action]);
  const rxList = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, 'the pharmacist\'s list');
  const itemOf = rx => rxList.items.find(item => item.sourceEhrPrescriptionId === rx.id);
  const [item1, item2, item3, item4] = [rx1, rx2, rx3, rx4].map(itemOf);
  assert(item1 && item2 && item3 && item4,
    `the pharmacist's list: ${JSON.stringify(rxList.items.map(item => item.sourceEhrPrescriptionId))}`);
  assert.deepEqual([item1, item2, item3, item4].map(item => [item.orderRoute, item.withdrawn, item.withdrawnReason,
    item.patientId]), [item1, item2, item3, item4].map(() => [undefined, undefined, undefined, patient.id]));
  // ORD-4: each was sent by itself and no pharmacist has accepted it yet (received, no acceptance); `status`
  // stays 'accepted' (the pharmacy has it), as on Release A.
  assert.deepEqual([item1, item2, item3, item4].map(item => [item.status, item.pharmacyStep, item.pharmacistAcceptance]),
    [item1, item2, item3, item4].map(() => ['accepted', 'received', null]),
    `the steps on the list: ${JSON.stringify([item1, item2, item3, item4].map(item => [item.id, item.pharmacyStep,
      item.pharmacistAcceptance]))}`);
  const pharmacistMembership = (await one(`select id::text as id from identity.staff_facility_memberships
    where account_id = $1 and facility_id = $2`, [ownPharmacist.accountId, hospital.facilityId])).id;
  const rxListAudit = await auditRows(ownPharmacist, 'pharmacy.work-item.list');
  const ownRows = rxList.items.filter(item => item.orderRoute === undefined).map(item => item.id);
  assert.deepEqual(rxListAudit.filter(row => row.patient_id).map(row => [row.patient_id, row.details]),
    [[patient.id, { basis: 'own-work', workItemIds: ownRows }]], `the list's audit: ${JSON.stringify(rxListAudit)}`);
  const read1 = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${item1.id}`), 200, 'read rx1\'s item');
  assert.equal(read1.id, item1.id);
  const dispenseKey1 = freshKey('dispense');
  expectStatus(await pharmacyCall(ownPharmacist, 'POST', `/work-items/${item1.id}/dispensings`,
    { expectedWorkItemVersion: Number(item1.version), quantityDispensed: 60, quantityUnit: 'tablet',
      reason: 'Synthetic own-work dispensing' }, { key: dispenseKey1 }), 201, 'dispense rx1 without a grant');
  assert.deepEqual((await auditRows(ownPharmacist, 'pharmacy.work-item.read')).map(row => [row.patient_id, row.details.basis]),
    [[patient.id, 'own-work']], 'the read is recorded with its basis');
  // ORD-4: rx1's item was received, so its dispensing accepted it first and says so on its audit row.
  assert.deepEqual((await auditRows(ownPharmacist, 'pharmacy.dispensing.create')).map(row => [row.patient_id,
    row.details.basis, row.details.acceptedWithDispensing]), [[patient.id, 'own-work', true]],
  'the dispensing is recorded with its basis, and that it accepted the item');
  evidence.pharmacist = { grants: 0, listed: ownRows.length, listAudit: 'one row, the patient, own-work, ids only',
    read: 200, dispensed: 201, rowsBasis: 'own-work' };
  step('the pharmacist without a grant lists, reads and dispenses the hospital\'s own work, each audited with basis own-work');

  // ── ORD-4: dispensing a received item accepted it first ──
  // In the dispensing's transaction, by the dispensing pharmacist, with the dispensing's key; the item's history
  // gained one pharmacist_accepted event (version 2) beside the send's prescription_accepted (version 1).
  const acceptancesOf = async () => (await all(`select work_item_id::text as work_item_id, accepted_by::text as accepted_by,
      accepted_by_membership_id::text as membership_id, accepted_with, idempotency_key, accepted_at
    from pharmacy.work_item_acceptances where patient_id = $1 order by accepted_at, id`, [patient.id]))
    .map(row => ({ ...row, accepted_at: row.accepted_at.toISOString() }));
  const workItemEvents = item => all(`select event_version, event_type, actor_id::text as actor_id,
      actor_membership_id::text as membership_id from pharmacy.work_item_events where work_item_id = $1
    order by event_version`, [item.id]);
  const byDispensing = await acceptancesOf();
  assert.deepEqual(byDispensing.map(row => [row.work_item_id, row.accepted_by, row.membership_id, row.accepted_with,
    row.idempotency_key]), [[item1.id, ownPharmacist.accountId, pharmacistMembership, 'dispensing', dispenseKey1]],
  `the acceptance the dispensing recorded: ${JSON.stringify(byDispensing)}`);
  const acceptance1 = { acceptedAt: byDispensing[0].accepted_at, acceptedByMembershipId: pharmacistMembership,
    acceptedWith: 'dispensing' };
  const events1 = await workItemEvents(item1);
  assert.deepEqual(events1.map(row => [row.event_version, row.event_type]),
    [[1, 'prescription_accepted'], [2, 'pharmacist_accepted']], `rx1's item's history: ${JSON.stringify(events1)}`);
  assert.deepEqual([events1[1].actor_id, events1[1].membership_id], [ownPharmacist.accountId, pharmacistMembership],
    'the pharmacist_accepted event names the dispensing pharmacist');
  const read1Dispensed = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${item1.id}`), 200,
    'read rx1\'s item after its dispensing');
  assert.deepEqual([read1Dispensed.status, read1Dispensed.acceptedAt, read1Dispensed.pharmacyStep,
    read1Dispensed.pharmacistAcceptance], ['accepted', item1.acceptedAt, 'dispensed', acceptance1],
  `rx1's item after its dispensing: ${JSON.stringify(read1Dispensed)}`);
  evidence.ord4 = { listedSentBySelf: 'received, no acceptance',
    dispensingOfAReceivedItem: { acceptedWith: 'dispensing', key: 'the dispensing\'s', event: 'pharmacist_accepted v2',
      audit: 'acceptedWithDispensing: true', read: 'pharmacyStep dispensed' } };
  step('ORD-4: items sent by themselves list as received; dispensing a received item accepted it first '
    + '(acceptedWith dispensing, one pharmacist_accepted event, acceptedWithDispensing on the audit row)');

  // ── Stopping and changing after the send ──
  const held = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rx2.id}`,
    { expectedRowVersion: Number(rx2.rowVersion), status: 'on_hold', changeReason: 'Synthetic hold pending review' }), 200,
  'hold rx2');
  assert.equal(held.pharmacyHandoff, undefined, 'a hold answers no hand-off');
  const afterHold = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, 'the list after the hold');
  const heldItem = afterHold.items.find(item => item.id === item2.id);
  assert.deepEqual([heldItem?.withdrawn, heldItem?.withdrawnReason], [true, 'changed'],
    `the held prescription's item is withdrawn as changed: ${JSON.stringify(heldItem)}`);
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
  assert.deepEqual([item1, item2, item3, item4].map(item => {
    const row = afterEdits.items.find(entry => entry.id === item.id);
    return [row?.withdrawn, row?.withdrawnReason];
  }), [[undefined, undefined], [true, 'changed'], [true, 'changed'], [undefined, undefined]],
  'withdrawn on the list (changed): the held and the edited items, never the dispensed or the open one');
  // 0133 D14: open work first (rx4's item); a withdrawn item can never be dispensed, so it lists with the done
  // work, newest first, beside the dispensed one: item3, item2, item1 by acceptance.
  const ownOrder = afterEdits.items.filter(item => item.orderRoute === undefined).map(item => item.id);
  assert.deepEqual(ownOrder, [item4.id, item3.id, item2.id, item1.id],
    `the list's order: ${JSON.stringify(afterEdits.items.map(item => [item.id, item.withdrawnReason ?? null,
      item.dispensing ? 'dispensed' : 'open']))}`);
  // ORD-3 through ehr-api, the doctor's cookie only: dispensed (also after its edit), withdrawn (held and edited);
  // and the list's ownPharmacyStaffed (the hospital has a pharmacist).
  const progressList = expectStatus(await http(ehr, 'GET', `/ehr/patients/${patient.id}${enc}/prescriptions`,
    { cookie: doctor.cookie, facility: hospital.facilityId, purpose: 'direct-care' }), 200, 'the doctor\'s prescriptions');
  const progressOf = rx => progressList.items.find(item => item.id === rx.id)?.ownProgress?.status;
  assert.deepEqual([progressOf(rx1), progressOf(rx2), progressOf(rx3), progressOf(rx4)],
    ['dispensed', 'withdrawn', 'withdrawn', 'received'],
    `ownProgress: ${JSON.stringify(progressList.items.map(item => [item.id, item.ownProgress]))}`);
  assert(progressList.items.length > 0 && progressList.items.every(item => item.ownPharmacyStaffed === true),
    `ownPharmacyStaffed: ${JSON.stringify(progressList.items.map(item => [item.id, item.ownPharmacyStaffed]))}`);
  const sends = await all(`select prescription_id::text as rx, state, prescription_version::text as version,
      withdrawn_at is not null as withdrawn from pharmacy.own_prescription_sends where patient_id = $1
    order by created_at`, [patient.id]);
  assert.deepEqual(sends.map(row => [row.rx, row.state, row.withdrawn]),
    [[rx1.id, 'sent', true], [rx2.id, 'sent', true], [rx3.id, 'sent', true], [rx4.id, 'sent', false]],
    `the sends: ${JSON.stringify(sends)}`);
  evidence.afterTheSend = { hold: { handoff: 'none', list: 'withdrawn (changed)',
    dispense: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE' },
    edit: { handoff: 'earlier version (superseded)', sendToPharmacy: 'earlier version (superseded)' },
    editAfterDispensing: { handoff: 'none', sendToPharmacy: 'already has it', list: 'not withdrawn', ownProgress: 'dispensed',
      send: 'change recorded' },
    listOrder: 'the open item first, then the withdrawn and dispensed ones, newest first',
    ownProgress: { dispensed: 'dispensed', held: 'withdrawn', edited: 'withdrawn', open: 'received' },
    ownPharmacyStaffed: true };
  step('a hold withdraws the send (Dispense refused); an edit answers the earlier-version hand-off; ownProgress reads '
    + 'withdrawn; withdrawn items list with the done work, after the open one; an edit after the dispensing reports nothing');

  // ── ORD-4: the pharmacist accepts before dispensing ──
  // The pharmacist, still without a grant, accepts rx4's item (sent by itself, still open) on the own-work basis:
  // 201 with the acceptance; the same call again, and a call with a new key, answer 200 with the stored one. Each
  // call writes its audit row naming the patient; nothing else is written after the first.
  assert.equal(await grantsOf(ownPharmacist), 0, 'the pharmacist still holds no grant for the patient');
  const accept = (item, key = freshKey('accept')) => pharmacyCall(ownPharmacist, 'POST', `/work-items/${item.id}/accept`,
    { expectedWorkItemVersion: Number(item.version) }, { key });
  const acceptKey4 = freshKey('accept');
  const accepted4 = expectStatus(await accept(item4, acceptKey4), 201, 'accept rx4\'s item without a grant');
  const acceptance4 = accepted4.pharmacistAcceptance;
  assert(Number.isFinite(Date.parse(acceptance4?.acceptedAt)), `the acceptance's time: ${JSON.stringify(accepted4)}`);
  assert.deepEqual(accepted4, { workItemId: item4.id, pharmacyStep: 'accepted', pharmacistAcceptance: {
    acceptedAt: acceptance4.acceptedAt, acceptedByMembershipId: pharmacistMembership, acceptedWith: 'accept' },
  alreadyAccepted: false }, `the accept's answer: ${JSON.stringify(accepted4)}`);
  const acceptedAgain = { workItemId: item4.id, pharmacyStep: 'accepted', pharmacistAcceptance: acceptance4,
    alreadyAccepted: true };
  assert.deepEqual(expectStatus(await accept(item4, acceptKey4), 200, 'the same accept again'), acceptedAgain);
  assert.deepEqual(expectStatus(await accept(item4), 200, 'accept again with a new key'), acceptedAgain);
  const acceptances4 = (await acceptancesOf()).filter(row => row.work_item_id === item4.id);
  assert.deepEqual(acceptances4.map(row => [row.accepted_by, row.membership_id, row.accepted_with, row.idempotency_key,
    row.accepted_at]), [[ownPharmacist.accountId, pharmacistMembership, 'accept', acceptKey4, acceptance4.acceptedAt]],
  `one acceptance for rx4's item: ${JSON.stringify(acceptances4)}`);
  const doctorMembership = (await one(`select id::text as id from identity.staff_facility_memberships
    where account_id = $1 and facility_id = $2`, [doctor.accountId, hospital.facilityId])).id;
  assert.deepEqual((await workItemEvents(item4)).map(row => [row.event_version, row.event_type, row.actor_id,
    row.membership_id]), [[1, 'prescription_accepted', doctor.accountId, doctorMembership],
    [2, 'pharmacist_accepted', ownPharmacist.accountId, pharmacistMembership]],
  'rx4\'s item\'s history: the send by the doctor, then the pharmacist\'s acceptance');
  const acceptAuditOf = async item => (await auditRows(ownPharmacist, 'pharmacy.work-item.pharmacist-accept'))
    .filter(row => row.resource_id === item.id)
    .map(row => [row.patient_id, row.details.outcome, row.details.acceptedWith, row.details.basis]);
  assert.deepEqual(await acceptAuditOf(item4), [[patient.id, 'accepted', 'accept', 'own-work'],
    [patient.id, 'already_accepted', 'accept', 'own-work'], [patient.id, 'already_accepted', 'accept', 'own-work']],
  'each accept is audited with the patient, its outcome, how it was accepted and basis own-work');
  // The list: pharmacyStep accepted with the acceptance; status, acceptedAt and the version keep their Release A
  // meaning (the pharmacy has it, when it arrived; dispensing still binds to version 1); still open work, first.
  const afterAccept = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, 'the list after the accept');
  const listed4 = afterAccept.items.find(entry => entry.id === item4.id);
  assert.deepEqual([listed4?.status, listed4?.acceptedAt, listed4?.version, listed4?.withdrawn, listed4?.pharmacyStep,
    listed4?.pharmacistAcceptance], ['accepted', item4.acceptedAt, item4.version, undefined, 'accepted', acceptance4],
  `rx4's item on the list after the accept: ${JSON.stringify(listed4)}`);
  assert.equal(afterAccept.items.filter(item => item.orderRoute === undefined)[0]?.id, item4.id,
    'the accepted item is still open work, listed first');

  // The doctor's ownProgress (ORD-3 through ehr-api, the doctor's cookie only): accepted, with acceptedAt.
  const ownProgressOf = async rx => expectStatus(await ehrCall(doctor, 'GET', `${enc}/prescriptions/${rx.id}`), 200,
    `the doctor's prescription ${rx.id}`).ownProgress;
  const accepted4Progress = await ownProgressOf(rx4);
  assert.deepEqual(accepted4Progress, { status: 'accepted', receivedAt: item4.acceptedAt, acceptedAt: acceptance4.acceptedAt,
    dispensedAt: null, reversedAt: null }, `rx4's ownProgress after the accept: ${JSON.stringify(accepted4Progress)}`);
  // rx1's, accepted by its dispensing: dispensed, with that acceptance's time.
  const dispensed1Progress = await ownProgressOf(rx1);
  assert.deepEqual([dispensed1Progress?.status, dispensed1Progress?.acceptedAt], ['dispensed', acceptance1.acceptedAt],
    `rx1's ownProgress: ${JSON.stringify(dispensed1Progress)}`);

  // pharmacy-api asked as ehr-api with the doctor's cookie, by the headers it sends: only X-HID-Own-Progress: 0133
  // (a Release A ehr-api, which would read 'accepted' as unknown) is answered received with no acceptedAt; only
  // ORD-4's header the same; both, accepted with acceptedAt.
  const progressAsEhr = async (label, versionHeaders) => expectStatus(await http(pharmacy, 'POST',
    '/pharmacy/work-items/progress', { cookie: doctor.cookie, facility: hospital.facilityId, purpose: 'direct-care',
    body: { patientId: patient.id, sourceEhrPrescriptionIds: [rx4.id] },
    headers: { 'x-hid-internal-caller': 'ehr-api', 'x-hid-service-token': tokens.pharmacy, ...versionHeaders } }), 200,
  `pharmacy progress ${label}`).items;
  const asReceived = [{ sourceEhrPrescriptionId: rx4.id, status: 'received', receivedAt: item4.acceptedAt,
    dispensedAt: null, reversedAt: null }];
  const headerMatrix = {
    releaseA: await progressAsEhr('with only the 0133 header', { 'x-hid-own-progress': '0133' }),
    ord4Only: await progressAsEhr('with only the ORD-4 header', { 'x-hid-own-progress-accepted': 'ord4' }),
    both: await progressAsEhr('with both headers', { 'x-hid-own-progress': '0133',
      'x-hid-own-progress-accepted': 'ord4' }),
  };
  assert.deepEqual(headerMatrix, { releaseA: asReceived, ord4Only: asReceived,
    both: [{ ...asReceived[0], status: 'accepted', acceptedAt: acceptance4.acceptedAt }] },
  `the progress answers by header: ${JSON.stringify(headerMatrix)}`);

  // Dispensing the accepted item: dispensed, acceptedAt kept, and no second acceptance (its audit row says none).
  expectStatus(await pharmacyCall(ownPharmacist, 'POST', `/work-items/${item4.id}/dispensings`,
    { expectedWorkItemVersion: Number(item4.version), quantityDispensed: 30, quantityUnit: 'tablet',
      reason: 'Synthetic own-work dispensing after the acceptance' }, { key: freshKey('dispense') }), 201,
  'dispense rx4 after its acceptance');
  const dispensedAt4 = (await one('select dispensed_at from pharmacy.dispensings where work_item_id = $1',
    [item4.id])).dispensed_at.toISOString();
  const dispensed4Progress = await ownProgressOf(rx4);
  assert.deepEqual(dispensed4Progress, { status: 'dispensed', receivedAt: item4.acceptedAt,
    acceptedAt: acceptance4.acceptedAt, dispensedAt: dispensedAt4, reversedAt: null },
  `rx4's ownProgress after its dispensing: ${JSON.stringify(dispensed4Progress)}`);
  assert.deepEqual((await acceptancesOf()).map(row => [row.work_item_id, row.accepted_with]),
    [[item1.id, 'dispensing'], [item4.id, 'accept']], 'the dispensing of an accepted item records no second acceptance');
  assert.deepEqual((await auditRows(ownPharmacist, 'pharmacy.dispensing.create')).map(row => [row.details.workItemId,
    row.details.acceptedWithDispensing ?? null]), [[item1.id, true], [item4.id, null]],
  'only the dispensing that accepted its item says so');

  // A hold after an acceptance: a fifth prescription, sent by itself, accepted, then held. ownProgress reads
  // withdrawn (acceptedAt kept); the list marks it withdrawn (changed) and keeps its acceptance; Accept answers that
  // acceptance again (200); Dispense is refused (409).
  const rx5 = await newPrescription('active', 'Synthetic omeprazole 20 mg tablet');
  assert.deepEqual(rx5.pharmacyHandoff, SENT, `rx5's hand-off: ${JSON.stringify(rx5.pharmacyHandoff)}`);
  const item5 = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, 'the list with rx5')
    .items.find(item => item.sourceEhrPrescriptionId === rx5.id);
  assert.deepEqual([item5?.pharmacyStep, item5?.pharmacistAcceptance], ['received', null],
    `rx5's item before the accept: ${JSON.stringify(item5)}`);
  const acceptance5 = expectStatus(await accept(item5), 201, 'accept rx5\'s item').pharmacistAcceptance;
  assert.equal((await ownProgressOf(rx5))?.status, 'accepted', 'rx5 reads accepted before the hold');
  expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rx5.id}`,
    { expectedRowVersion: Number(rx5.rowVersion), status: 'on_hold', changeReason: 'Synthetic hold after the acceptance' }),
  200, 'hold rx5 after its acceptance');
  const held5Progress = await ownProgressOf(rx5);
  assert.deepEqual(held5Progress, { status: 'withdrawn', receivedAt: item5.acceptedAt, acceptedAt: acceptance5.acceptedAt,
    dispensedAt: null, reversedAt: null }, `rx5's ownProgress after the hold: ${JSON.stringify(held5Progress)}`);
  const held5 = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${item5.id}`), 200,
    'read rx5\'s item after the hold');
  assert.deepEqual([held5.withdrawn, held5.withdrawnReason, held5.pharmacyStep, held5.pharmacistAcceptance],
    [true, 'changed', 'accepted', acceptance5], `rx5's item after the hold: ${JSON.stringify(held5)}`);
  assert.deepEqual(expectStatus(await accept(item5), 200, 'accept rx5\'s item after the hold'),
    { workItemId: item5.id, pharmacyStep: 'accepted', pharmacistAcceptance: acceptance5, alreadyAccepted: true });
  const refused5 = await pharmacyCall(ownPharmacist, 'POST', `/work-items/${item5.id}/dispensings`,
    { expectedWorkItemVersion: Number(item5.version), quantityDispensed: 14, quantityUnit: 'tablet',
      reason: 'Synthetic dispensing after a hold' }, { key: freshKey('dispense') });
  assert.deepEqual([refused5.status, refused5.body?.code], [409, 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE'],
    `dispensing an accepted item after a hold: ${JSON.stringify(refused5.body)}`);

  // An item held before anyone accepted it (rx2's) cannot be accepted, and nothing is written for it; the item a
  // dispensing accepted (rx1's) answers that acceptance.
  const refused2 = await accept(item2);
  assert.deepEqual([refused2.status, refused2.body?.code, refused2.body?.withdrawnReason],
    [409, 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE', 'changed'], `accepting a held item: ${JSON.stringify(refused2.body)}`);
  assert.deepEqual(expectStatus(await accept(item1), 200, 'accept rx1\'s item, accepted by its dispensing'),
    { workItemId: item1.id, pharmacyStep: 'dispensed', pharmacistAcceptance: acceptance1, alreadyAccepted: true });
  assert.deepEqual((await acceptancesOf()).map(row => [row.work_item_id, row.accepted_with]),
    [[item1.id, 'dispensing'], [item4.id, 'accept'], [item5.id, 'accept']],
  'one acceptance per accepted item, none for the item held before an acceptance');
  assert.deepEqual(await acceptAuditOf(item1), [[patient.id, 'already_accepted', 'dispensing', 'own-work']],
    'the accept on the item its dispensing accepted is audited as already accepted');
  evidence.ord4 = { ...evidence.ord4, pharmacistGrants: 0,
    accept: { first: 201, sameCallAgain: '200 alreadyAccepted', newKey: '200 alreadyAccepted', basis: 'own-work',
      event: 'pharmacist_accepted v2', audit: 'one row per call: accepted, then already_accepted' },
    list: 'pharmacyStep accepted; status, acceptedAt and version unchanged; still open work',
    ownProgress: { accepted: 'accepted with acceptedAt', afterDispensing: 'dispensed, acceptedAt kept',
      heldAfterAcceptance: 'withdrawn, acceptedAt kept' },
    progressHeaders: { only0133: 'received, no acceptedAt', onlyOrd4: 'received, no acceptedAt',
      both: 'accepted with acceptedAt' },
    heldAfterAcceptance: { list: 'withdrawn (changed), acceptance kept', accept: '200 alreadyAccepted',
      dispense: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE' },
    heldBeforeAcceptance: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE (changed), nothing written',
    acceptOnDispensingAccepted: '200 alreadyAccepted, acceptedWith dispensing' };
  step('ORD-4: the pharmacist without a grant accepts on the own-work basis (201, then 200 alreadyAccepted); the doctor\'s '
    + 'ownProgress reads accepted, then dispensed; a Release A ehr-api is answered received; a hold after the acceptance '
    + 'reads withdrawn');

  // ── The row's half, asked directly by the lab runtime (0133 D1 with D15, owner's Q122 A) ──
  // In the lab scientist's own session, as lab-api's role. The patient has own pharmacy work here and no own lab
  // work yet, so the lab body answers false; the pharmacy body is the pharmacy runtime's alone (42501), so the lab
  // runtime cannot learn whether the patient has pharmacy work here.
  const scientistSession = await one(`select membership.id::text as membership_id, account.subject
      from identity.staff_facility_memberships membership join auth.accounts account on account.id = membership.account_id
     where membership.account_id = $1 and membership.facility_id = $2`, [ownScientist.accountId, hospital.facilityId]);
  const askAsLabRuntime = async kind => {
    const client = new Client({ connectionString: databaseUrl('hid_lab_api_runtime') });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.actor_subject', $1, true), set_config('app.facility_id', $2, true),
          set_config('app.membership_id', $3, true), set_config('app.purpose_of_use', 'direct-care', true),
          set_config('app.correlation_id', 'own-facility-work-verifier', true), set_config('app.own_facility_work', '0133', true)`,
      [scientistSession.subject, hospital.facilityId, scientistSession.membership_id]);
      const answer = await client.query(`select identity.${kind}_work_patient_allows($1::uuid, $2::uuid, $3::uuid,
          'read_records') as allowed`, [scientistSession.membership_id, patient.id, hospital.facilityId]);
      return answer.rows[0].allowed;
    } catch (error) {
      return `refused ${error.code}`;
    } finally {
      await client.query('rollback').catch(() => {});
      await client.end();
    }
  };
  const rowHalf = { labBeforeLabWork: await askAsLabRuntime('lab'), pharmacyBody: await askAsLabRuntime('pharmacy') };
  assert.deepEqual(rowHalf, { labBeforeLabWork: false, pharmacyBody: 'refused 42501' },
    `the row's half asked by the lab runtime: ${JSON.stringify(rowHalf)}`);

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
  // The same direct question, now that the patient has own lab work here: true (the session above was right).
  rowHalf.labWithLabWork = await askAsLabRuntime('lab');
  assert.equal(rowHalf.labWithLabWork, true, `the row's half once the patient has own lab work: ${JSON.stringify(rowHalf)}`);
  evidence.rowHalf = { lab: { noOwnLabWork: false, ownLabWork: true }, pharmacyBodyAsLabRuntime: '42501' };
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
  // Each probe is a chart read. Where the member's role permits it (0006: both held ehr.encounter.read; the
  // pharmacist holds ehr.prescription.read, the lab scientist ehr.lab-request.read), the refusal is the patient's
  // consent (403 CONSENT_REQUIRED), never a missing permission. Where the role no longer permits it (Release A's
  // 0136, Q103 A: laboratory staff lose visits, ehr.encounter.read), the refusal is the missing permission (403
  // PERMISSION_DENIED), read from the role table, so this verifier holds with 0133 alone and with 0136 after it.
  const chartProbes = [[ownPharmacist, 'pharmacist', 'ehr.encounter.read', `/ehr/patients/${patient.id}${enc}`],
    [ownPharmacist, 'pharmacist', 'ehr.prescription.read', `/ehr/patients/${patient.id}${enc}/prescriptions`],
    [ownPharmacist, 'pharmacist', 'ehr.prescription.read', `/ehr/patients/${patient.id}${enc}/prescriptions/${rx1.id}`],
    [ownScientist, 'lab', 'ehr.encounter.read', `/ehr/patients/${patient.id}${enc}`],
    [ownScientist, 'lab', 'ehr.lab-request.read', `/ehr/patients/${patient.id}${enc}/lab-requests/${labRequest.id}`]];
  for (const [who, role, permission, path] of chartProbes) {
    const permitted = (await one(`select exists (select 1 from auth.role_permissions
                                    where role_code = $1 and permission_code = $2) as permitted`,
      [role, permission])).permitted;
    const chart = await call(ehr, who, 'GET', path);
    assert.deepEqual([chart.status, chart.body?.code], [403, permitted ? 'CONSENT_REQUIRED' : 'PERMISSION_DENIED'],
      `${who.name} GET ${path} (${role} ${permitted ? 'holds' : 'lacks'} ${permission}): ${chart.status} `
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
