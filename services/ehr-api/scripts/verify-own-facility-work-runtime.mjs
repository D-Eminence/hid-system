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
// their Release A meaning, and still lists the item as open work (before a
// newer item that is still received); the doctor's ownProgress reads
// accepted with acceptedAt, then dispensed (acceptedAt kept) once it is
// dispensed, which records no second acceptance; pharmacy-api, asked as
// ehr-api with only
// X-HID-Own-Progress: 0133 (a Release A ehr-api), answers received for the
// accepted item with no acceptedAt, and the same with only ORD-4's header,
// accepted only with both; an accepted item put on hold reads withdrawn,
// keeps its acceptance (Accept answers it again, 200) and cannot be
// dispensed (409); an item held before anyone accepted it cannot be accepted
// (409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE, withdrawnReason changed); and
// Accept on the item a dispensing accepted answers that acceptance (200).
// Q132 A (0148): an edit and then a hold of a dispensed prescription show
// on the pharmacist's item (edited, 1; on_hold, 2), not on the prescriber's
// side; a hand-off item (a prescription written on hold and resumed, which
// 0133 does not send by itself, handed in through the EHR by a second
// pharmacist holding the patient's grant) dispensed by the pharmacist
// without a grant and then cancelled reads cancelled, 1, and is never
// flagged withdrawn; a PATCH racing a dispensing in flight is recorded
// once, after the dispensing.
// ORD-12 (refills, 0152; owner decision Q131 A, with the clinical owner's
// answers to Rahman's review on #258 and her decisions of 24 November 2026):
// ehr-api and pharmacy-api, the two services that read
// PRESCRIPTION_REFILLS_ENABLED, boot with it on, so every step above also runs
// with refills on; pharmacy-api answers ready (GET /health/ready, which needs
// 0152's fill_number). The doctor writes active prescriptions with refills
// (0-11: 12 is refused, and a PATCH cannot set them); refills need a duration
// (400 REFILLS_NEED_DURATION without one), which a create carries only with
// 0125's details on, so ehr-api is booted again with those on. The
// pharmacist without a grant records fills 1, 2 and 3 of the one with 2
// refills and 10 days, each naming its fillNumber, on the one work item, each
// refill from its day: the Lagos day of the latest fill not reversed plus 8
// (3/4 of 10, rounded up). Before that day the item reads refills not_yet
// with nextFillOn, lists as done work, and a refill is refused (409
// PHARMACY_REFILL_TOO_SOON with refillOpensOn); the clock is moved on as the
// owner moves the fill back 8 days (replica mode; a fixture), and on its day
// the refill is open and open work. A 4th is refused (409
// PHARMACY_NO_REFILLS_LEFT, 0152's NO_REFILLS_LEFT mapped); a fill number
// already recorded, asked again with a new key and another body, is refused
// (409 PHARMACY_FILL_NUMBER_CHANGED), as is a skipped number, and a key used
// for another fill (409 IDEMPOTENCY_CONFLICT); the same key and body replays
// (201, nothing written), and so does a new key with the same body (the
// replay is on the item, the fill number and the request); two presses of
// one fill at once record it once. The item reads refills { allowed 2,
// recorded 3, open false, closedReason none_left } and is one row on the list
// (with a refill open it lists after the items waiting for a first fill);
// every fill writes MedicationDispensed (fillNumber on refills only) and only
// the first accepts the item; the prescriber's ownProgress keeps the first
// fill's time. Reversing fill 2 is refused (409
// PHARMACY_DISPENSING_NOT_LATEST_FILL); fill 3 is reversed, and the
// prescriber still reads dispensed (fills 1 and 2 stand). An edit after
// fill 1 of another prescription closes its refills (changed) and shows
// 0148's notice (edited, 1); a hold closes them (stopped; on_hold, 1); each
// refused refill is 409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE. Every item's
// refills carry endsOn, the refills' last day (0152's
// ehr.prescription_refills_end_on, the clinical owner's decision D9 of 24
// November 2026: the earliest of the end date, the Lagos day written plus
// (refills + 2) fills' durations, and that day plus 365), whatever its state.
// The expiry: a prescription with 1 refill and a 1-day duration, filled once,
// reads endsOn 3 days after the day it was written; once that day has passed
// (the clock moved on as the owner moves its writing and its fill back 4
// days, in replica mode, a fixture, which records no version and no change),
// it reads closed ended with that day, lists as done work (0152's open
// refills leave it out), and its refill is refused (409
// PHARMACY_REFILL_PRESCRIPTION_ENDED with refillsEndedOn, the same day,
// which is the database's own day for it). Then both
// services restart with the setting off (and ehr-api's details off again):
// the item with three fills is still one row (its latest fill); a second
// dispensing of an item with a refill open is refused exactly as before
// (409 PHARMACY_WORK_ITEM_ALREADY_DISPENSED, and fillNumber 400 as an
// unknown field), the same request replays as before, and the item lists as
// done work; no answer carries refills, fillNumber, lastFilledAt or
// refillsAllowed, and refillsAllowed is refused on create.
// With PRESCRIPTION_REFILLS_ENABLED=false in the verifier's environment,
// both services boot with it off from the start: every step before ORD-12's
// runs unchanged, and ORD-12's steps check that no answer carries anything
// of refills, that fillNumber and refillsAllowed are unknown fields and that
// a second dispensing is refused as before.
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
// ORD-12's setting (0152), on in ehr-api and pharmacy-api, the two services that read it; the last steps restart both
// with it off. PRESCRIPTION_REFILLS_ENABLED=false in the verifier's own environment boots both with it off from the
// start: every step before ORD-12's must then pass unchanged, and ORD-12's steps check that nothing of refills shows.
assert([undefined, 'true', 'false'].includes(process.env.PRESCRIPTION_REFILLS_ENABLED),
  'PRESCRIPTION_REFILLS_ENABLED, when set, is true or false');
const PRESCRIPTION_REFILLS_ENABLED = process.env.PRESCRIPTION_REFILLS_ENABLED ?? 'true';

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
const childByName = new Map();
async function boot(name, directory, environment, listenPort) {
  const child = spawn(process.execPath,
    ['-r', join(directory, 'node_modules/ts-node/register/transpile-only'), '-r', environment.HID_VERIFIER_PRELOAD,
      join(directory, 'src/main.ts')],
    { cwd: directory, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test', PORT: String(listenPort),
      TS_NODE_PROJECT: join(directory, 'tsconfig.json'), DATABASE_SSL: 'false', DATABASE_POOL_MAX: '4', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  childByName.set(name, child);
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
// Stops a booted service and waits until its process has exited (its port is free again).
async function stopService(name) {
  const child = childByName.get(name);
  assert(child, `no service ${name}`);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(done => child.once('exit', done));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(timer);
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
const evidence = { migration: '0133', setting: { OWN_WORK_PATIENT_CARD_ENABLED, PRESCRIPTION_REFILLS_ENABLED }, steps };
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
  // Q132 A: the changes table, its recorder and the reader the work list and a read ask (an image on a database
  // without them answers no changedAfterDispensing).
  const q132 = await one(`select to_regclass('pharmacy.prescription_changes_after_dispensing')::text as changes,
      to_regprocedure('pharmacy.prescription_change_after_dispensing()')::text as recorder,
      to_regprocedure('pharmacy.work_item_changes_after_dispensing(uuid[])')::text as reader`);
  assert.deepEqual(q132, { changes: 'pharmacy.prescription_changes_after_dispensing',
    recorder: 'pharmacy.prescription_change_after_dispensing()',
    reader: 'pharmacy.work_item_changes_after_dispensing(uuid[])' }, `a database with Q132 A: ${JSON.stringify(q132)}`);
  evidence.database.q132 = Object.values(q132);
  // ORD-12: 0152's two columns, its key on (work item, fill number) in place of 0023's, and the two refills readers
  // pharmacy-api asks (an image on a database without them could not record a refill or say one is open).
  const ord12 = await one(`select to_regprocedure('pharmacy.work_item_refills(uuid[])')::text as reader,
      to_regprocedure('pharmacy.open_refill_work_items()')::text as open_reader,
      (select count(*)::int from pg_attribute where not attisdropped and (attrelid, attname) in
        (('ehr.prescriptions'::regclass, 'refills_allowed'), ('pharmacy.dispensings'::regclass, 'fill_number'))) as columns,
      (select string_agg(pg_get_constraintdef(oid), '; ' order by conname) from pg_constraint
        where conrelid = 'pharmacy.dispensings'::regclass and contype = 'u') as keys`);
  assert.deepEqual(ord12, { reader: 'pharmacy.work_item_refills(uuid[])', open_reader: 'pharmacy.open_refill_work_items()',
    columns: 2,
    keys: 'UNIQUE (facility_id, dispensed_by, idempotency_key); UNIQUE (work_item_id, fill_number)' },
  `a database with ORD-12 (0152): ${JSON.stringify(ord12)}`);
  evidence.database.ord12 = [ord12.reader, ord12.open_reader, 'ehr.prescriptions.refills_allowed',
    'pharmacy.dispensings.fill_number', 'UNIQUE (work_item_id, fill_number)'];
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
  // ehr-api's and pharmacy-api's settings, kept so that the last steps can boot them again with refills off.
  const ehrEnvironment = { ...common, DATABASE_URL: databaseUrl('hid_ehr_api_runtime'),
    STORAGE_MODE: 'disabled', IDENTITY_API_URL: local(identityPort), IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: tokens.identityEhr,
    LAB_API_URL: local(labPort), LAB_INTERNAL_SERVICE_TOKEN: tokens.lab, PHARMACY_API_URL: local(pharmacyPort),
    PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy, EHR_INTERNAL_SERVICE_TOKEN: tokens.ehr, PRESCRIPTION_REFILLS_ENABLED };
  const pharmacyEnvironment = { ...common, DATABASE_URL: databaseUrl('hid_pharmacy_api_runtime'),
    IDENTITY_API_URL: local(identityPort), IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.identityPharmacy,
    PHARMACY_INTERNAL_SERVICE_TOKEN: tokens.pharmacy, OWN_WORK_PATIENT_CARD_ENABLED, PRESCRIPTION_REFILLS_ENABLED };
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
    boot('ehr-api', join(services, 'ehr-api'), ehrEnvironment, ehrPort),
    boot('lab-api', join(services, 'lab-api'), { ...common, DATABASE_URL: databaseUrl('hid_lab_api_runtime'),
      IDENTITY_API_URL: local(identityPort), IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: tokens.identityLab,
      LAB_INTERNAL_SERVICE_TOKEN: tokens.lab, OWN_WORK_PATIENT_CARD_ENABLED }, labPort),
    boot('pharmacy-api', join(services, 'pharmacy-api'), pharmacyEnvironment, pharmacyPort),
  ]);
  // ORD-12: pharmacy-api is ready only on a database with 0152's pharmacy.dispensings.fill_number (GET /health/ready).
  expectStatus(await http(pharmacy, 'GET', '/health/ready'), 200, 'pharmacy-api ready on a database with 0152');
  step(`four services booted from their own code; lab-api and pharmacy-api with OWN_WORK_PATIENT_CARD_ENABLED=${OWN_WORK_PATIENT_CARD_ENABLED}; `
    + `ehr-api and pharmacy-api with PRESCRIPTION_REFILLS_ENABLED=${PRESCRIPTION_REFILLS_ENABLED}; pharmacy-api ready`);

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
  // `extra`: fields beyond these (ORD-12's refillsAllowed).
  const prescriptionBody = (status, display, extra = {}) => ({ medicationCodeSystem: 'http://snomed.info/sct',
    medicationCode: '325072002', medicationDisplay: display, doseQuantity: 1, doseUnit: 'tablet', routeCode: 'oral',
    frequency: 'twice daily', instructions: 'Synthetic instructions: take with food', status, ...extra });
  const newPrescription = async (status, display, extra = {}) => expectStatus(await ehrCall(doctor, 'POST',
    `${enc}/prescriptions`, prescriptionBody(status, display, extra), { key: freshKey('prescription') }), 201,
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
  // A change after the dispensing: shown on the pharmacy's item (Q132 A), not on the prescriber's side (no
  // hand-off, Send to pharmacy answers "already has it", ownProgress stays dispensed: what was sent was dispensed).
  const editedAfterDispensing = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rx1.id}`,
    { expectedRowVersion: Number(rx1.rowVersion), frequency: 'three times daily',
      changeReason: 'Synthetic change after dispensing' }), 200, 'edit rx1 after its dispensing');
  assert.equal(editedAfterDispensing.pharmacyHandoff, undefined,
    `an edit after the dispensing answers no hand-off: ${JSON.stringify(editedAfterDispensing.pharmacyHandoff)}`);
  const sendAfterDispensing = expectStatus(await ehrCall(doctor, 'POST', `${enc}/prescriptions/${rx1.id}/own-pharmacy-send`,
    { expectedRowVersion: Number(editedAfterDispensing.rowVersion) }), 200, 'Send to pharmacy after the dispensing and edit');
  assert.deepEqual(sendAfterDispensing.pharmacyHandoff, ALREADY,
    `Send to pharmacy after the dispensing: ${JSON.stringify(sendAfterDispensing.pharmacyHandoff)}`);
  // Q132 A: the pharmacist's list and read show the change on rx1's item: 'edited', once.
  const changeShown = (item, label) => {
    const notice = item?.changedAfterDispensing;
    assert(notice && notice.change === label.change && notice.changeCount === label.changeCount
      && typeof notice.changedAt === 'string' && !Number.isNaN(Date.parse(notice.changedAt))
      && Object.keys(notice).sort().join() === 'change,changeCount,changedAt',
    `item ${item?.id} should show ${JSON.stringify(label)}: ${JSON.stringify(notice)}`);
    return notice;
  };
  const editedList = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200,
    'the list after the edit after dispensing');
  const editedNotice = changeShown(editedList.items.find(item => item.id === item1.id), { change: 'edited', changeCount: 1 });
  changeShown(expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${item1.id}`), 200,
    'read rx1\'s item after its edit after dispensing'), { change: 'edited', changeCount: 1 });
  // No other item is dispensed yet, and pharmacy-api asks only for dispensed ones, so "no notice on another item" is
  // checked after rx4's dispensing below, on a dispensed item whose prescription did not change.
  // Then the doctor puts rx1 on hold: the pharmacy reads on_hold, two changes; the prescriber's side is unchanged
  // (no hand-off for the hold; ownProgress below still reads dispensed).
  const heldAfterDispensing = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rx1.id}`,
    { expectedRowVersion: Number(editedAfterDispensing.rowVersion), status: 'on_hold',
      changeReason: 'Synthetic hold after dispensing' }), 200, 'hold rx1 after its dispensing and edit');
  assert.equal(heldAfterDispensing.pharmacyHandoff, undefined,
    `a hold after the dispensing answers no hand-off: ${JSON.stringify(heldAfterDispensing.pharmacyHandoff)}`);
  const heldNotice = changeShown(expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${item1.id}`), 200,
    'read rx1\'s item after its hold after dispensing'), { change: 'on_hold', changeCount: 2 });
  assert(Date.parse(heldNotice.changedAt) >= Date.parse(editedNotice.changedAt),
    `the hold's time is the latest: ${editedNotice.changedAt} then ${heldNotice.changedAt}`);
  const afterEdits = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, 'the list after the edits');
  changeShown(afterEdits.items.find(item => item.id === item1.id), { change: 'on_hold', changeCount: 2 });
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
      send: 'change recorded', pharmacyItem: 'edited (1), then on_hold (2) after a hold' },
    listOrder: 'the open item first, then the withdrawn and dispensed ones, newest first',
    ownProgress: { dispensed: 'dispensed', held: 'withdrawn', edited: 'withdrawn', open: 'received' },
    ownPharmacyStaffed: true };
  step('a hold withdraws the send (Dispense refused); an edit answers the earlier-version hand-off; ownProgress reads '
    + 'withdrawn; withdrawn items list with the done work, after the open one; an edit and a hold after the dispensing are '
    + 'shown on the pharmacy\'s item (Q132 A), not on the prescriber\'s side');

  // ── ORD-4: the pharmacist accepts before dispensing ──
  // The pharmacist, still without a grant, accepts rx4's item (sent by itself, still open) on the own-work basis:
  // 201 with the acceptance; the same call again, and a call with a new key, answer 200 with the stored one. Each
  // call writes its audit row naming the patient; nothing else is written after the first.
  assert.equal(await grantsOf(ownPharmacist), 0, 'the pharmacist still holds no grant for the patient');
  // A fifth prescription, sent by itself and left received for now (it is accepted and held further down). It is
  // made here, before rx4's item is accepted, so that the list after the accept can tell open work from done work:
  // see the order check there.
  const rx5 = await newPrescription('active', 'Synthetic omeprazole 20 mg tablet');
  assert.deepEqual(rx5.pharmacyHandoff, SENT, `rx5's hand-off: ${JSON.stringify(rx5.pharmacyHandoff)}`);
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
  const item5 = afterAccept.items.find(item => item.sourceEhrPrescriptionId === rx5.id);
  assert.deepEqual([item5?.pharmacyStep, item5?.pharmacistAcceptance], ['received', null],
    `rx5's item before its accept: ${JSON.stringify(item5)}`);
  // Open work lists oldest first and done work newest first, both by when the pharmacy received the item
  // (acceptedAt). rx4's item arrived before rx5's, so it lists before the received (open) rx5 item only while it is
  // still open work itself: were an accepted item done work, rx5's item would list first and rx4's would lead the
  // done work after it. Without rx5's item, rx4's (the newest) would list first either way, which proved nothing.
  assert(Date.parse(item4.acceptedAt) < Date.parse(item5.acceptedAt),
    `rx4's item must arrive before rx5's for the order check: ${item4.acceptedAt}, ${item5.acceptedAt}`);
  assert.deepEqual(afterAccept.items.filter(item => item.orderRoute === undefined).map(item => item.id),
    [item4.id, item5.id, item3.id, item2.id, item1.id],
  `the accepted item is still open work, listed first (before the newer received one): ${JSON.stringify(
    afterAccept.items.map(item => [item.id, item.pharmacyStep ?? null, item.withdrawnReason ?? null]))}`);

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
  // ORD-12: with refills on, pharmacy-api's answer also carries lastFilledAt, null while nothing is dispensed (ehr-api
  // reads only the fields it knows, so ownProgress is unchanged); with them off, today's fields only.
  const asReceived = [{ sourceEhrPrescriptionId: rx4.id, status: 'received', receivedAt: item4.acceptedAt,
    dispensedAt: null, reversedAt: null, ...(PRESCRIPTION_REFILLS_ENABLED === 'true' ? { lastFilledAt: null } : {}) }];
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
  // Q132 A: rx4's item is now dispensed and its prescription never changed, so it carries no notice on the list or
  // its read, while rx1's (dispensed, then edited and held) still reads on_hold, 2 on the same list: the notice is
  // on the changed item only.
  const afterDispensing4 = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200,
    'the list after rx4\'s dispensing');
  const dispensed4Listed = afterDispensing4.items.find(item => item.id === item4.id);
  assert.deepEqual([dispensed4Listed?.dispensing?.status, dispensed4Listed?.changedAfterDispensing], ['dispensed', undefined],
    `a dispensed item whose prescription did not change shows no notice: ${JSON.stringify(dispensed4Listed)}`);
  changeShown(afterDispensing4.items.find(item => item.id === item1.id), { change: 'on_hold', changeCount: 2 });
  const dispensed4Read = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${item4.id}`), 200,
    'read rx4\'s item after its dispensing');
  assert.deepEqual([dispensed4Read.dispensing?.status, dispensed4Read.changedAfterDispensing], ['dispensed', undefined],
    `rx4's dispensed, unchanged item read by id: ${JSON.stringify(dispensed4Read)}`);
  const dispensed4Progress = await ownProgressOf(rx4);
  assert.deepEqual(dispensed4Progress, { status: 'dispensed', receivedAt: item4.acceptedAt,
    acceptedAt: acceptance4.acceptedAt, dispensedAt: dispensedAt4, reversedAt: null },
  `rx4's ownProgress after its dispensing: ${JSON.stringify(dispensed4Progress)}`);
  assert.deepEqual((await acceptancesOf()).map(row => [row.work_item_id, row.accepted_with]),
    [[item1.id, 'dispensing'], [item4.id, 'accept']], 'the dispensing of an accepted item records no second acceptance');
  assert.deepEqual((await auditRows(ownPharmacist, 'pharmacy.dispensing.create')).map(row => [row.details.workItemId,
    row.details.acceptedWithDispensing ?? null]), [[item1.id, true], [item4.id, null]],
  'only the dispensing that accepted its item says so');

  // A hold after an acceptance: the fifth prescription (sent by itself before rx4's item was accepted, still
  // received), accepted, then held. ownProgress reads withdrawn (acceptedAt kept); the list marks it withdrawn
  // (changed) and keeps its acceptance; Accept answers that acceptance again (200); Dispense is refused (409).
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
    list: 'pharmacyStep accepted; status, acceptedAt and version unchanged; still open work (before a newer received item)',
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

  // ── Q132 A: "after dispensing" is commit order (the own-item race) ──
  // A dispensing in flight holds 0101's FOR SHARE on its prescription until it commits. The doctor's PATCH,
  // through ehr-api, takes the prescription FOR UPDATE first, so it waits; once the dispensing commits it goes on,
  // and C2 (VOLATILE, READ COMMITTED) sees the committed claim and records the change: one row, a version above
  // the one dispensed, a time after dispensed_at. Session A is the Pharmacy runtime in the pharmacist's own-work
  // session (as pharmacy-api sets it); no fixed sleep: the wait is read from pg_stat_activity.
  const rxRace = await newPrescription('active', 'Synthetic amlodipine 5 mg tablet');
  assert.deepEqual(rxRace.pharmacyHandoff, SENT, `the race prescription's hand-off: ${JSON.stringify(rxRace.pharmacyHandoff)}`);
  const raceItem = await one(`select id::text as id, row_version as version, patient_id::text as patient_id, facility_id::text as facility_id,
      medication_code_system, medication_code, medication_display
    from pharmacy.work_items where source_ehr_prescription_id = $1`, [rxRace.id]);
  assert(raceItem, 'the race prescription reached the pharmacy');
  const pharmacistAccount = await one('select subject from auth.accounts where id = $1', [ownPharmacist.accountId]);
  const sessionA = new Client({ connectionString: databaseUrl('hid_pharmacy_api_runtime') });
  await sessionA.connect();
  let raceEdit;
  try {
    await sessionA.query('begin');
    await sessionA.query(`select set_config('app.actor_subject', $1, true), set_config('app.facility_id', $2, true),
        set_config('app.correlation_id', 'own-facility-work-verifier-race', true), set_config('app.membership_id', $3, true),
        set_config('app.purpose_of_use', 'direct-care', true), set_config('app.own_facility_work', '0133', true)`,
    [pharmacistAccount.subject, hospital.facilityId, pharmacistMembership]);
    await sessionA.query(`insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id,
        medication_code_system, medication_code, medication_display, quantity_dispensed, quantity_unit, dispensed_by,
        dispensed_by_membership_id, reason, idempotency_key, request_sha256, correlation_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8, 30, 'tablet', $9, $10, 'Synthetic dispensing in flight', $11, $12,
        'own-facility-work-verifier-race')`,
    [randomUUID(), raceItem.id, raceItem.version, raceItem.patient_id, raceItem.facility_id,
      raceItem.medication_code_system, raceItem.medication_code, raceItem.medication_display,
      ownPharmacist.accountId, pharmacistMembership, freshKey('race-dispense'), randomBytes(32).toString('hex')]);
    // B: the doctor's PATCH, through ehr-api; it must wait on the dispensing's lock.
    raceEdit = ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rxRace.id}`,
      { expectedRowVersion: Number(rxRace.rowVersion), frequency: 'once daily',
        changeReason: 'Synthetic change while a dispensing is in flight' });
    let waiting = false;
    for (let tries = 0; tries < 200 && !waiting; tries += 1) {
      // ehr-api's backend: its login is the runtime role, or (a local cluster) the superuser with the runtime role
      // set, so it is found by its application name too (ehr-api's pool names itself hid-ehr-...).
      waiting = (await one(`select count(*)::int as n from pg_stat_activity
          where (usename = 'hid_ehr_api_runtime' or application_name like 'hid-ehr-%')
            and wait_event_type = 'Lock' and state = 'active'`)).n > 0;
      if (!waiting) await new Promise(done => setTimeout(done, 25));
    }
    if (!waiting) {
      const early = await Promise.race([raceEdit, new Promise(done => setTimeout(() => done('still running'), 2000))]);
      assert.fail(`the PATCH never waited on the dispensing in flight: ${JSON.stringify(early?.status ?? early)} `
        + `${JSON.stringify(early?.body ?? '')}`);
    }
    await sessionA.query('commit');
  } catch (error) {
    await sessionA.query('rollback').catch(() => {});
    throw error;
  } finally {
    await sessionA.end();
  }
  const raceEdited = expectStatus(await raceEdit, 200, 'the PATCH after the dispensing in flight committed');
  const raceRows = await all(`select change_row.prescription_version::text as version, change_row.status_before,
      change_row.status_after, change_row.changed_at > claim.dispensed_at as after_dispensing
    from pharmacy.prescription_changes_after_dispensing change_row
    join pharmacy.prescription_item_claims claim on claim.work_item_id = change_row.work_item_id
   where change_row.work_item_id = $1`, [raceItem.id]);
  assert.deepEqual(raceRows, [{ version: String(raceEdited.rowVersion), status_before: 'active', status_after: 'active',
    after_dispensing: true }], `the race's recorded change: ${JSON.stringify(raceRows)}`);
  assert(Number(raceEdited.rowVersion) > Number(rxRace.rowVersion), 'the recorded version is above the one dispensed');
  changeShown(expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${raceItem.id}`), 200,
    'read the race item after the PATCH'), { change: 'edited', changeCount: 1 });
  evidence.q132 = { editAfterDispensing: 'edited (1), then on_hold (2)',
    unchangedDispensedItem: 'rx4\'s: no notice on the list or its read, beside rx1\'s on_hold (2)',
    race: { patchWaitedOnDispensing: true,
    rows: 1, versionAboveDispensed: true, changedAfterDispensedAt: true, shown: 'edited (1)' } };
  step('Q132 A: a PATCH racing a dispensing in flight waits for it, then is recorded once, after the dispensing');

  // ── Q132 A: a hand-off item, dispensed by the pharmacist without a grant, then cancelled ──
  // 0133 sends a prescription by itself only when it is written as active or a draft is activated. One written on
  // hold and then resumed is not sent, so a second pharmacist, signed in to the pharmacy site and holding the
  // patient's grant, hands it in through ehr-api (pharmacy-work-item, then accept-ehr-prescription: acceptedWith
  // hand_off). A second item handed in the same way and put on hold before any dispensing is not flagged withdrawn
  // (0133 D8 marks automatic sends only). The pharmacist without a grant then dispenses the first on the own-work
  // basis, and the doctor cancels its prescription: the item reads cancelled, 1.
  const handPharmacist = await invited(HOSTS.pharmacy, { name: 'Ngozi Ownwork', email: synthetic('hand-pharmacist'),
    role: 'pharmacist', licenceBody: 'PCN', licenceNumber: 'PCN/83033' });
  const handRequest = expectStatus(await call(identity, handPharmacist, 'POST', '/identity/access-requests',
    { hid: patient.hid, scope: 'write_records', reason: 'Synthetic hand-off for the own facility work verifier',
      durationMinutes: 1440 }), 201, 'the second pharmacist\'s access request');
  assert.equal(expectStatus(await patientCall('POST', `/identity/access-requests/${handRequest.accessRequestId}/approve`),
    200, 'approve the second pharmacist').status, 'approved');
  assert.deepEqual([await grantsOf(handPharmacist), await grantsOf(ownPharmacist)], [1, 0],
    'the second pharmacist holds a grant; the dispensing pharmacist still holds none');
  const rxHeldAtWriting = await newPrescription('on_hold', 'Synthetic ciprofloxacin 500 mg tablet');
  assert.equal(rxHeldAtWriting.pharmacyHandoff, undefined, 'a prescription written on hold is not sent');
  const rxHand = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rxHeldAtWriting.id}`,
    { expectedRowVersion: Number(rxHeldAtWriting.rowVersion), status: 'active',
      changeReason: 'Synthetic resume before the hand-off' }), 200, 'resume the prescription written on hold');
  assert.equal(rxHand.pharmacyHandoff, undefined, `a resume sends nothing by itself: ${JSON.stringify(rxHand.pharmacyHandoff)}`);
  assert.equal(Number((await one('select count(*) from pharmacy.work_items where source_ehr_prescription_id = $1',
    [rxHand.id])).count), 0, 'the resumed prescription has no pharmacy item yet');
  const handed = expectStatus(await ehrCall(handPharmacist, 'POST', `${enc}/prescriptions/${rxHand.id}/pharmacy-work-item`,
    { expectedRowVersion: Number(rxHand.rowVersion), reason: 'Synthetic hand-off at the counter' },
  { key: freshKey('hand-off') }), 201, 'the second pharmacist hands the prescription in');
  const handItem = await one(`select id::text as id, row_version::text as version, accepted_by::text as accepted_by,
      acceptance_reason, order_route_id from pharmacy.work_items where source_ehr_prescription_id = $1`, [rxHand.id]);
  assert.deepEqual([handItem?.id, handItem?.accepted_by, handItem?.acceptance_reason, handItem?.order_route_id],
    [handed.id, handPharmacist.accountId, 'Synthetic hand-off at the counter', null],
  `the hand-off item: ${JSON.stringify(handItem)}`);
  const handRead = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${handItem.id}`), 200,
    'the pharmacist without a grant reads the hand-off item');
  assert.equal(handRead.pharmacistAcceptance?.acceptedWith, 'hand_off',
    `the hand-off item reads acceptedWith hand_off: ${JSON.stringify(handRead.pharmacistAcceptance)}`);
  // A second hand-off item, put on hold before anyone dispenses it, is not flagged withdrawn: 0133 D8 marks
  // automatic sends only (rx2's item, sent by itself and held, reads withdrawn above). This is checked before any
  // dispensing, because 0133 D10 leaves withdrawn off every dispensed item, hand-off or not.
  const rxHeldAtWriting2 = await newPrescription('on_hold', 'Synthetic doxycycline 100 mg capsule');
  assert.equal(rxHeldAtWriting2.pharmacyHandoff, undefined, 'the second prescription written on hold is not sent');
  const rxHand2 = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rxHeldAtWriting2.id}`,
    { expectedRowVersion: Number(rxHeldAtWriting2.rowVersion), status: 'active',
      changeReason: 'Synthetic resume before the second hand-off' }), 200, 'resume the second prescription written on hold');
  const handed2 = expectStatus(await ehrCall(handPharmacist, 'POST', `${enc}/prescriptions/${rxHand2.id}/pharmacy-work-item`,
    { expectedRowVersion: Number(rxHand2.rowVersion), reason: 'Synthetic second hand-off at the counter' },
  { key: freshKey('hand-off') }), 201, 'the second pharmacist hands the second prescription in');
  expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rxHand2.id}`,
    { expectedRowVersion: Number(rxHand2.rowVersion), status: 'on_hold',
      changeReason: 'Synthetic hold before the hand-off item is dispensed' }), 200, 'hold the second handed-in prescription');
  const handHeld = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${handed2.id}`), 200,
    'read the second hand-off item after the hold');
  const handHeldListed = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200,
    'the list after the second hand-off item\'s hold').items.find(item => item.id === handed2.id);
  for (const [label, item] of [['read', handHeld], ['list', handHeldListed]]) {
    assert.deepEqual([item?.dispensing, item?.pharmacistAcceptance?.acceptedWith, item?.withdrawn, item?.withdrawnReason],
      [null, 'hand_off', undefined, undefined],
    `a hand-off item held before any dispensing is not flagged withdrawn (0133 D8), ${label}: ${JSON.stringify(item)}`);
  }
  expectStatus(await pharmacyCall(ownPharmacist, 'POST', `/work-items/${handItem.id}/dispensings`,
    { expectedWorkItemVersion: Number(handItem.version), quantityDispensed: 14, quantityUnit: 'tablet',
      reason: 'Synthetic own-work dispensing of a hand-off item' }, { key: freshKey('hand-dispense') }), 201,
  'the pharmacist without a grant dispenses the hand-off item');
  const handDispensed = expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${handItem.id}`), 200,
    'read the hand-off item after its dispensing');
  assert.equal(handDispensed.changedAfterDispensing, undefined, 'dispensed and not yet changed: nothing is shown');
  const handCancelled = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rxHand.id}`,
    { expectedRowVersion: Number(rxHand.rowVersion), status: 'cancelled',
      changeReason: 'Synthetic cancellation after the hand-off dispensing' }), 200, 'the doctor cancels the handed-in prescription');
  assert.equal(handCancelled.pharmacyHandoff, undefined, 'a cancellation answers no hand-off');
  const handAfter = changeShown(expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${handItem.id}`), 200,
    'read the hand-off item after the cancellation'), { change: 'cancelled', changeCount: 1 });
  const handListed = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200,
    'the list after the hand-off item\'s cancellation').items.find(item => item.id === handItem.id);
  changeShown(handListed, { change: 'cancelled', changeCount: 1 });
  evidence.q132.handOff = { item: 'written on hold, resumed, handed in by a pharmacist with a grant (hand_off)',
    dispensedBy: 'the pharmacist without a grant', shown: `${handAfter.change} (${handAfter.changeCount})`,
    heldBeforeDispensing: 'a second hand-off item, held before any dispensing: not flagged withdrawn' };
  step('Q132 A: a hand-off item held before any dispensing is not flagged withdrawn; a hand-off item dispensed by the '
    + 'pharmacist without a grant and then cancelled reads cancelled, 1');

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

  // ── ORD-12: refills (0152) ──
  // Helpers for both settings. The pharmacist's list and items; a fill and a reversal through pharmacy-api.
  // Each of these lists must have read its refills: pharmacy-api says refillsUnavailable only when the open refills or
  // the per-item reader could not be read (never while off).
  const ownList = async label => {
    const page = expectStatus(await pharmacyCall(ownPharmacist, 'GET', '/work-items'), 200, label);
    assert.equal(page.refillsUnavailable, undefined, `${label}: the list says refillsUnavailable`);
    return page.items;
  };
  const onlyRow = (items, rx, label) => {
    const rows = items.filter(item => item.sourceEhrPrescriptionId === rx.id);
    assert.equal(rows.length, 1, `${label}: one row for prescription ${rx.id}, not ${rows.length}`);
    return rows[0];
  };
  const oneRowEach = (items, label) => assert.equal(new Set(items.map(item => item.id)).size, items.length,
    `${label}: an item listed twice: ${JSON.stringify(items.map(item => item.id))}`);
  // The list's order (ORD-12): open work first, the items waiting for a first fill before those with a refill open,
  // then the done work (a refill not yet due is done work).
  const listClass = item => (item.dispensing === null && !item.withdrawn ? 0 : item.refills?.open === true ? 1 : 2);
  const assertListOrder = (items, label) => {
    const own = items.filter(item => item.orderRoute === undefined);
    const classes = own.map(listClass);
    assert(classes.every((value, index) => index === 0 || classes[index - 1] <= value),
      `${label}: first fills, then refills open, then done work: ${JSON.stringify(own.map((item, index) =>
        [item.id, classes[index]]))}`);
  };
  const fillsOf = async item => all(`select id::text as id, fill_number from pharmacy.dispensings where work_item_id = $1
    order by fill_number`, [item.id]);
  const fillBody = { quantityDispensed: 30, quantityUnit: 'tablet', reason: 'Synthetic own-work fill' };
  const dispenseFill = (item, extra = {}, key = freshKey('fill')) => pharmacyCall(ownPharmacist, 'POST',
    `/work-items/${item.id}/dispensings`, { expectedWorkItemVersion: Number(item.version), ...fillBody, ...extra }, { key });
  const readItem = async (item, label) => expectStatus(await pharmacyCall(ownPharmacist, 'GET', `/work-items/${item.id}`),
    200, label);
  const refusedWith = (response, status, code, label) => {
    assert.deepEqual([response.status, response.body?.code], [status, code],
      `${label}: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const fieldsRefused = (response, field, label) => assert.deepEqual([response.status, response.body?.code,
    response.body?.errors?.map(error => error.field)], [400, 'VALIDATION_FAILED', [field]],
  `${label}: ${response.status} ${JSON.stringify(response.body)}`);
  // pharmacy-api's progress answer, as ehr-api asks it (ORD-3 with 0133's and ORD-4's headers).
  const pharmacyProgress = async (ids, label) => expectStatus(await http(pharmacy, 'POST', '/pharmacy/work-items/progress',
    { cookie: doctor.cookie, facility: hospital.facilityId, purpose: 'direct-care',
      body: { patientId: patient.id, sourceEhrPrescriptionIds: ids },
      headers: { 'x-hid-internal-caller': 'ehr-api', 'x-hid-service-token': tokens.pharmacy, 'x-hid-own-progress': '0133',
        'x-hid-own-progress-accepted': 'ord4' } }), 200, label).items;
  // The Lagos day `offset` days from now (Africa/Lagos is UTC+1, no daylight saving), YYYY-MM-DD.
  const lagosDay = (offset = 0) => new Date(Date.now() + 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
  // A day (YYYY-MM-DD) plus `days`.
  const plusDay = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  // A fixture for the clinical owner's refill interval (24 November 2026: a refill opens on the Lagos day of the
  // latest fill not reversed plus 3/4 of the duration): the clock moved on, as the owner moves a fill `days` back.
  // Replica mode skips 0023's immutability guard (origin mode only); 0133's key guard fires only when the work item
  // changes. A first fill's claim moves with it (0133 D14 copies its time). Answers the fill's new time (ISO).
  const fillRecordedEarlier = async (fill, days) => {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      const moved = (await client.query(`update pharmacy.dispensings set dispensed_at = dispensed_at - make_interval(days => $2)
        where id = $1 returning dispensed_at, work_item_id, fill_number`, [fill.id, days])).rows[0];
      assert(moved, `the fill ${fill.id} to move`);
      if (moved.fill_number === 1) {
        await client.query(`update pharmacy.prescription_item_claims set dispensed_at = $2
          where work_item_id = $1 and dispensed_at is not null`, [moved.work_item_id, moved.dispensed_at]);
      }
      await client.query('commit');
      return moved.dispensed_at.toISOString();
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };

  // A fixture for the refills' last day (D9: counted from the Lagos day the prescription was written, created_at):
  // the clock moved on, as the owner moves the prescription's writing `days` back. Replica mode: no version is
  // written (0004's versioning is origin mode only), so the item's accepted version still matches and 0148 records no
  // change; R7's index is kept by PostgreSQL. Answers the new Lagos day written and the row version.
  const prescriptionWrittenEarlier = async (rx, days) => {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      const moved = (await client.query(`update ehr.prescriptions set created_at = created_at - make_interval(days => $2)
        where id = $1 returning to_char(created_at at time zone 'Africa/Lagos', 'YYYY-MM-DD') as written,
        row_version::text as version`, [rx.id, days])).rows[0];
      assert(moved, `the prescription ${rx.id} to move`);
      await client.query('commit');
      return moved;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };

  if (PRESCRIPTION_REFILLS_ENABLED === 'true') {
    // The prescriber: refillsAllowed (0-11) on create, answered on every read (none as 0); 12 is refused, and a PATCH
    // cannot set it. Refills above 0 need a duration (the clinical owner's rule, 24 November 2026): ehr-api refuses
    // them without one (400 REFILLS_NEED_DURATION), and a create carries a duration only with 0125's
    // PRESCRIPTION_DISPENSING_DETAILS_ENABLED on as well, so ehr-api is booted again with both on. Four active
    // prescriptions, each sent to the hospital's own pharmacy by itself: rxRefills (2 refills, 10 days: a refill
    // opens 8 days after the latest fill; fills 1-3 below), rxChanged (2: edited after fill 1), rxStopped (1: held
    // after fill 1) and rxOpen (1: a refill left open for the steps with the setting off).
    assert.equal(await grantsOf(ownPharmacist), 0, 'the pharmacist still holds no grant for the patient (refills)');
    const needsDuration = response => assert.deepEqual([response.status, response.body?.code],
      [400, 'REFILLS_NEED_DURATION'], `refills without a duration: ${response.status} ${JSON.stringify(response.body)}`);
    needsDuration(await ehrCall(doctor, 'POST', `${enc}/prescriptions`, prescriptionBody('active',
      'Synthetic amlodipine 5 mg tablet', { refillsAllowed: 2 }), { key: freshKey('prescription') }));
    await stopService('ehr-api');
    await boot('ehr-api (details on)', join(services, 'ehr-api'),
      { ...ehrEnvironment, PRESCRIPTION_DISPENSING_DETAILS_ENABLED: 'true' }, ehrPort);
    needsDuration(await ehrCall(doctor, 'POST', `${enc}/prescriptions`, prescriptionBody('active',
      'Synthetic amlodipine 5 mg tablet', { refillsAllowed: 2, strength: '5 mg' }), { key: freshKey('prescription') }));
    const tenDays = { durationValue: 10, durationUnit: 'day' };
    const rxRefills = await newPrescription('active', 'Synthetic amlodipine 10 mg tablet', { refillsAllowed: 2, ...tenDays });
    const rxChanged = await newPrescription('active', 'Synthetic losartan 50 mg tablet', { refillsAllowed: 2, ...tenDays });
    const rxStopped = await newPrescription('active', 'Synthetic simvastatin 20 mg tablet', { refillsAllowed: 1, ...tenDays });
    const rxOpen = await newPrescription('active', 'Synthetic metformin 850 mg tablet', { refillsAllowed: 1, ...tenDays });
    // The refills' last day (0152's ehr.prescription_refills_end_on, D9): with no end date and a 10-day fill, the
    // Lagos day written plus (refills + 2) x 10 days: 40 days with 2 refills, 30 with 1 (each under 365).
    const written = lagosDay(0);
    const endsOnFor = allowed => plusDay(written, (allowed + 2) * 10);
    assert.deepEqual([rxRefills, rxChanged, rxStopped, rxOpen].map(rx => [rx.refillsAllowed, rx.durationValue,
      rx.durationUnit, rx.pharmacyHandoff]), [[2, 10, 'day', SENT], [2, 10, 'day', SENT], [1, 10, 'day', SENT],
      [1, 10, 'day', SENT]], 'the prescriptions with refills are answered with them and their duration, and sent');
    fieldsRefused(await ehrCall(doctor, 'POST', `${enc}/prescriptions`, prescriptionBody('active',
      'Synthetic amlodipine 5 mg tablet', { refillsAllowed: 12, ...tenDays }), { key: freshKey('prescription') }),
    'refillsAllowed', '12 refills');
    fieldsRefused(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rxOpen.id}`, { expectedRowVersion:
      Number(rxOpen.rowVersion), refillsAllowed: 3, changeReason: 'Synthetic attempt to add refills' }), 'refillsAllowed',
    'refills on a PATCH');
    const storedRefills = await all(`select id::text as id, refills_allowed, row_version::text as version
      from ehr.prescriptions where id = any($1::uuid[])`, [[rxRefills.id, rxChanged.id, rxStopped.id, rxOpen.id, rx4.id]]);
    const storedOf = rx => storedRefills.find(row => row.id === rx.id);
    assert.deepEqual([rxRefills, rxChanged, rxStopped, rxOpen, rx4].map(rx => storedOf(rx)?.refills_allowed),
      [2, 2, 1, 1, null], `refills stored as written, none given stored as null: ${JSON.stringify(storedRefills)}`);
    assert.equal(storedOf(rxOpen).version, String(rxOpen.rowVersion), 'the refused PATCH changed nothing');
    const doctorRefillList = expectStatus(await ehrCall(doctor, 'GET', `${enc}/prescriptions`), 200,
      'the doctor\'s prescriptions with refills on');
    assert.deepEqual([doctorRefillList.refills, ...[rxRefills, rxOpen, rx4].map(rx => doctorRefillList.items
      .find(item => item.id === rx.id)?.refillsAllowed)], [true, 2, 1, 0],
    'the list says refills are taken, and carries refillsAllowed (none as 0)');
    assert.equal(expectStatus(await ehrCall(doctor, 'GET', `${enc}/prescriptions/${rxRefills.id}`), 200,
      'the doctor reads rxRefills').refillsAllowed, 2, 'a read carries refillsAllowed');
    step('ORD-12: the doctor writes prescriptions with refills (0-11, with a duration: without one 400 '
      + 'REFILLS_NEED_DURATION; 12 refused; a PATCH cannot set them), each answer carrying refillsAllowed (none as 0), '
      + 'and each is sent to the hospital\'s own pharmacy by itself');

    // The pharmacist without a grant: fills 1, 2 and 3 of rxRefills's one work item, each refill once its day comes.
    let refillList = await ownList('the list before any fill');
    oneRowEach(refillList, 'the list before any fill');
    const [itemR, itemChanged, itemStopped, itemOpen] = [rxRefills, rxChanged, rxStopped, rxOpen]
      .map(rx => onlyRow(refillList, rx, 'the list before any fill'));
    assert.deepEqual([itemR, itemChanged, itemStopped, itemOpen].map(item => [item.refills, item.dispensing,
      item.pharmacyStep]), [2, 2, 1, 1].map(allowed => [{ allowed, recorded: 0, open: false, closedReason: null,
      nextFillOn: null, endsOn: endsOnFor(allowed) }, null, 'received']),
    `the items before any fill: ${JSON.stringify([itemR, itemChanged, itemStopped, itemOpen])}`);
    assert.deepEqual(onlyRow(refillList, rx4, 'the list before any fill').refills,
      { allowed: 0, recorded: 1, open: false, closedReason: 'none_left', nextFillOn: null, endsOn: null },
      'a prescription without refills: one fill, no last day for refills');

    const key1 = freshKey('fill');
    const fill1 = expectStatus(await dispenseFill(itemR, { fillNumber: 1 }, key1), 201, 'fill 1 of 3');
    assert.equal(fill1.fillNumber, 1);
    let readR = await readItem(itemR, 'rxRefills\'s item after fill 1');
    assert.deepEqual([readR.refills, readR.dispensing, readR.lastFilledAt, readR.pharmacyStep],
      [{ allowed: 2, recorded: 1, open: false, closedReason: 'not_yet', nextFillOn: lagosDay(8), endsOn: endsOnFor(2) },
        { id: fill1.id, status: 'dispensed', reversed: false, fillNumber: 1 }, fill1.dispensedAt, 'dispensed'],
    `rxRefills's item after fill 1: the refill opens in 8 days: ${JSON.stringify(readR)}`);
    refillList = await ownList('the list after fill 1');
    oneRowEach(refillList, 'the list after fill 1');
    assert.equal(listClass(onlyRow(refillList, rxRefills, 'the list after fill 1')), 2, 'a refill not yet due is done work');
    const tooSoon = refusedWith(await dispenseFill(itemR, { fillNumber: 2 }), 409, 'PHARMACY_REFILL_TOO_SOON',
      'fill 2 on the day of fill 1');
    assert.equal(tooSoon.refillOpensOn, lagosDay(8), `the refusal says the day it opens: ${JSON.stringify(tooSoon)}`);
    assert.deepEqual((await fillsOf(itemR)).map(row => row.fill_number), [1], 'no refill recorded too soon');
    // Eight days on: fill 1 recorded 8 days earlier, so its refill opens today.
    const fill1At = await fillRecordedEarlier(fill1, 8);
    readR = await readItem(itemR, 'rxRefills\'s item 8 days after fill 1');
    assert.deepEqual(readR.refills, { allowed: 2, recorded: 1, open: true, closedReason: null, nextFillOn: lagosDay(0),
      endsOn: endsOnFor(2) }, `the refill opens on its day: ${JSON.stringify(readR.refills)}`);
    refillList = await ownList('the list on the day the refill opens');
    oneRowEach(refillList, 'the list on the day the refill opens');
    assert.equal(listClass(onlyRow(refillList, rxRefills, 'the list on the day the refill opens')), 1,
      'a refill open is open work');
    assertListOrder(refillList, 'the list on the day the refill opens');

    const key2 = freshKey('fill');
    const fill2 = expectStatus(await dispenseFill(itemR, { fillNumber: 2 }, key2), 201, 'fill 2 of 3');
    assert.deepEqual([fill2.fillNumber, fill2.id === fill1.id], [2, false]);
    assert.equal(expectStatus(await dispenseFill(itemR, { fillNumber: 2 }, key2), 201, 'fill 2 again, the same key and body')
      .id, fill2.id, 'the same key and body replay fill 2');
    assert.equal(expectStatus(await dispenseFill(itemR, { fillNumber: 2 }), 201, 'fill 2 again, a new key and the same body')
      .id, fill2.id, 'a new key with the same body replays fill 2 (the item, the fill number and the request)');
    const sameFillOtherBody = refusedWith(await dispenseFill(itemR, { fillNumber: 2, quantityDispensed: 28 }), 409,
      'PHARMACY_FILL_NUMBER_CHANGED', 'fill 2 again, a new key and another body');
    assert.equal(sameFillOtherBody.fillsRecorded, 2, 'the refusal says how many fills are recorded');
    refusedWith(await dispenseFill(itemR, { fillNumber: 4 }), 409, 'PHARMACY_FILL_NUMBER_CHANGED', 'fill 4 before fill 3');
    refusedWith(await dispenseFill(itemR, { fillNumber: 3 }, key2), 409, 'IDEMPOTENCY_CONFLICT', 'fill 3 under fill 2\'s key');
    // Fill 3 the same day as fill 2: too soon, it opens 8 days after fill 2.
    assert.equal(refusedWith(await dispenseFill(itemR, { fillNumber: 3 }), 409, 'PHARMACY_REFILL_TOO_SOON',
      'fill 3 on the day of fill 2').refillOpensOn, lagosDay(8), 'fill 3 opens 8 days after fill 2');
    assert.deepEqual((await fillsOf(itemR)).map(row => row.fill_number), [1, 2], 'two fills recorded, nothing more');
    await fillRecordedEarlier(fill2, 8);
    // Fill 3: two presses at once, each under its own key, with the same body. One records it; the other meets 0152's
    // key or a serialization failure, runs again and replays it (never a 500, never a second row).
    const presses = await Promise.all([dispenseFill(itemR, { fillNumber: 3 }), dispenseFill(itemR, { fillNumber: 3 })]);
    const [fill3, fill3Again] = presses.map((press, index) => expectStatus(press, 201,
      `fill 3, press ${index + 1} of 2 at once`));
    assert.deepEqual([fill3.fillNumber, fill3Again.id], [3, fill3.id], 'two presses of fill 3 at once record it once');
    refusedWith(await dispenseFill(itemR, { fillNumber: 4 }), 409, 'PHARMACY_NO_REFILLS_LEFT', 'fill 4 of 3');
    assert.deepEqual((await fillsOf(itemR)).map(row => [row.id, row.fill_number]),
      [[fill1.id, 1], [fill2.id, 2], [fill3.id, 3]], 'three fills on the one item');
    readR = await readItem(itemR, 'rxRefills\'s item after fill 3');
    assert.deepEqual([readR.refills, readR.dispensing, readR.lastFilledAt, readR.pharmacyStep],
      [{ allowed: 2, recorded: 3, open: false, closedReason: 'none_left', nextFillOn: null, endsOn: endsOnFor(2) },
        { id: fill3.id, status: 'dispensed', reversed: false, fillNumber: 3 }, fill3.dispensedAt, 'dispensed'],
    `rxRefills's item after fill 3: ${JSON.stringify(readR)}`);
    refillList = await ownList('the list after fill 3');
    oneRowEach(refillList, 'the list after fill 3');
    const listedR = onlyRow(refillList, rxRefills, 'the list after fill 3');
    assert.deepEqual([listedR.refills, listedR.dispensing, listedR.lastFilledAt, listClass(listedR)],
      [readR.refills, readR.dispensing, fill3.dispensedAt, 2], `rxRefills's row after fill 3: ${JSON.stringify(listedR)}`);
    assertListOrder(refillList, 'the list after fill 3');
    // Every fill wrote MedicationDispensed; only a refill names its number (a first fill's payload is today's).
    const dispensedEvents = await all(`select payload from pharmacy.outbox_events where event_type = 'MedicationDispensed'
      and payload->>'workItemId' = $1 order by occurred_at, id`, [itemR.id]);
    assert.deepEqual(dispensedEvents.map(row => [row.payload.dispensingId, row.payload.fillNumber ?? null,
      Object.keys(row.payload).sort().join()]), [[fill1.id, null, 'dispensingId,status,workItemId'],
      [fill2.id, 2, 'dispensingId,fillNumber,status,workItemId'], [fill3.id, 3, 'dispensingId,fillNumber,status,workItemId']],
    `the MedicationDispensed events: ${JSON.stringify(dispensedEvents)}`);
    const fillAudit = (await auditRows(ownPharmacist, 'pharmacy.dispensing.create'))
      .filter(row => row.details.workItemId === itemR.id)
      .map(row => [row.resource_id, row.details.fillNumber ?? null, row.details.acceptedWithDispensing ?? null,
        row.details.basis]);
    assert.deepEqual(fillAudit, [[fill1.id, null, true, 'own-work'], [fill2.id, 2, null, 'own-work'],
      [fill3.id, 3, null, 'own-work']], `one audit row per fill: ${JSON.stringify(fillAudit)}`);
    const acceptedR = (await acceptancesOf()).filter(row => row.work_item_id === itemR.id);
    assert.deepEqual(acceptedR.map(row => [row.accepted_with, row.idempotency_key]), [['dispensing', key1]],
      'fill 1 accepted the received item; no refill accepts it again');
    // The prescriber's ownProgress (through ehr-api) keeps the first fill's time (as moved above); pharmacy-api's own
    // answer adds the latest.
    const dispensedR = { status: 'dispensed', receivedAt: itemR.acceptedAt, acceptedAt: acceptedR[0].accepted_at,
      dispensedAt: fill1At, reversedAt: null };
    assert.deepEqual(await ownProgressOf(rxRefills), dispensedR, 'the prescriber reads dispensed, at the first fill\'s time');
    assert.deepEqual(await pharmacyProgress([rxRefills.id], 'progress after fill 3'), [{ sourceEhrPrescriptionId: rxRefills.id,
      ...dispensedR, lastFilledAt: fill3.dispensedAt }], 'one progress row: the first fill\'s time, and the latest');
    step('ORD-12: the pharmacist without a grant records fills 1-3 of a prescription with 2 refills on its one work item '
      + '(fillNumber each), each refill from its day (the latest fill\'s Lagos day + 8 for 10 days; before it 409 '
      + 'PHARMACY_REFILL_TOO_SOON with the day, and the item not_yet, done work); a 4th is refused '
      + '(PHARMACY_NO_REFILLS_LEFT), so are fill 2 again with another body, a skipped number and a key used for another '
      + 'fill; the same request replays, two presses at once record one fill; one row, refills {2, 3, closed none_left}; '
      + 'one MedicationDispensed per fill; ownProgress keeps the first fill\'s time');

    // Only the latest fill can be reversed.
    const reverseFill = (fill, key = freshKey('reverse')) => pharmacyCall(ownPharmacist, 'POST',
      `/dispensings/${fill.id}/reversals`, { expectedDispensingVersion: Number(fill.version),
        reason: 'Synthetic: returned unopened' }, { key });
    refusedWith(await reverseFill(fill2), 409, 'PHARMACY_DISPENSING_NOT_LATEST_FILL', 'reversing fill 2 of 3');
    expectStatus(await reverseFill(fill3), 201, 'reversing fill 3 of 3');
    assert.deepEqual((await all(`select dispensing_id::text as dispensing_id from pharmacy.dispensing_reversals
      where work_item_id = $1`, [itemR.id])).map(row => row.dispensing_id), [fill3.id], 'only fill 3 is reversed');
    readR = await readItem(itemR, 'rxRefills\'s item after fill 3 was reversed');
    assert.deepEqual([readR.dispensing, readR.pharmacyStep, readR.refills],
      [{ id: fill3.id, status: 'dispensed', reversed: true, fillNumber: 3 }, 'dispensing_reversed',
        { allowed: 2, recorded: 3, open: false, closedReason: 'none_left', nextFillOn: null, endsOn: endsOnFor(2) }],
    `rxRefills's item after the reversal: ${JSON.stringify(readR)}`);
    // Fills 1 and 2 stand, so the prescriber still reads dispensed, at the first fill's time, with no reversal (only an
    // item whose every fill is reversed reads dispensing_reversed); pharmacy-api's own answer says the same.
    assert.deepEqual(await ownProgressOf(rxRefills), dispensedR,
      'a reversed refill, earlier fills standing: the prescriber reads dispensed, the first fill\'s time');
    assert.deepEqual(await pharmacyProgress([rxRefills.id], 'progress after fill 3 was reversed'),
      [{ sourceEhrPrescriptionId: rxRefills.id, ...dispensedR, lastFilledAt: fill3.dispensedAt }],
    'pharmacy-api\'s progress after the reversal of fill 3: dispensed, no reversedAt');
    step('ORD-12: reversing fill 2 of 3 is refused (PHARMACY_DISPENSING_NOT_LATEST_FILL); fill 3 is reversed, and the '
      + 'prescriber still reads dispensed (fills 1 and 2 stand)');

    // An edit after fill 1 ends the refills (changed) and shows 0148's notice; so does a hold (stopped).
    const changedFill = expectStatus(await dispenseFill(itemChanged), 201, 'fill 1 of rxChanged, without fillNumber');
    assert.equal(changedFill.fillNumber, 1, 'a dispensing without fillNumber is fill 1');
    assert.deepEqual((await readItem(itemChanged, 'rxChanged\'s item after fill 1')).refills,
      { allowed: 2, recorded: 1, open: false, closedReason: 'not_yet', nextFillOn: lagosDay(8), endsOn: endsOnFor(2) },
      'a refill after fill 1, from its day');
    await fillRecordedEarlier(changedFill, 8);
    assert.deepEqual((await readItem(itemChanged, 'rxChanged\'s item 8 days after fill 1')).refills,
      { allowed: 2, recorded: 1, open: true, closedReason: null, nextFillOn: lagosDay(0), endsOn: endsOnFor(2) },
      'a refill open on its day');
    const editedAfterFill = expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rxChanged.id}`,
      { expectedRowVersion: Number(rxChanged.rowVersion), frequency: 'once daily',
        changeReason: 'Synthetic change after the first fill' }), 200, 'edit rxChanged after fill 1');
    assert.equal(editedAfterFill.pharmacyHandoff, undefined, 'an edit after the first fill answers no hand-off');
    const changedRead = await readItem(itemChanged, 'rxChanged\'s item after the edit');
    assert.deepEqual(changedRead.refills, { allowed: 2, recorded: 1, open: false, closedReason: 'changed', nextFillOn: null,
      endsOn: endsOnFor(2) }, `the edit closes the refills (the day they would have ended unmoved): `
      + JSON.stringify(changedRead));
    changeShown(changedRead, { change: 'edited', changeCount: 1 });
    refusedWith(await dispenseFill(itemChanged, { fillNumber: 2 }), 409, 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE',
      'a refill after the edit');
    const stoppedFill = expectStatus(await dispenseFill(itemStopped, { fillNumber: 1 }), 201, 'fill 1 of rxStopped');
    await fillRecordedEarlier(stoppedFill, 8);
    expectStatus(await ehrCall(doctor, 'PATCH', `${enc}/prescriptions/${rxStopped.id}`,
      { expectedRowVersion: Number(rxStopped.rowVersion), status: 'on_hold',
        changeReason: 'Synthetic hold after the first fill' }), 200, 'hold rxStopped after fill 1');
    const stoppedRead = await readItem(itemStopped, 'rxStopped\'s item after the hold');
    assert.deepEqual(stoppedRead.refills, { allowed: 1, recorded: 1, open: false, closedReason: 'stopped', nextFillOn: null,
      endsOn: endsOnFor(1) }, `the hold closes the refills: ${JSON.stringify(stoppedRead)}`);
    changeShown(stoppedRead, { change: 'on_hold', changeCount: 1 });
    refusedWith(await dispenseFill(itemStopped, { fillNumber: 2 }), 409, 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE',
      'a refill after the hold');
    assert.deepEqual([(await fillsOf(itemChanged)).length, (await fillsOf(itemStopped)).length], [1, 1],
      'no refill recorded after the change or the hold');
    const openFill = expectStatus(await dispenseFill(itemOpen), 201, 'fill 1 of rxOpen');
    const openFillAt = await fillRecordedEarlier(openFill, 8);
    refillList = await ownList('the list with a refill open');
    oneRowEach(refillList, 'the list with a refill open');
    assert.deepEqual([rxOpen, rxChanged, rxStopped].map(rx => {
      const row = onlyRow(refillList, rx, 'the list with a refill open');
      return [row.refills, listClass(row)];
    }), [[{ allowed: 1, recorded: 1, open: true, closedReason: null, nextFillOn: lagosDay(0), endsOn: endsOnFor(1) }, 1],
      [{ allowed: 2, recorded: 1, open: false, closedReason: 'changed', nextFillOn: null, endsOn: endsOnFor(2) }, 2],
      [{ allowed: 1, recorded: 1, open: false, closedReason: 'stopped', nextFillOn: null, endsOn: endsOnFor(1) }, 2]],
    'on the list: the refill open is open work; the changed and the held prescriptions\' items are done');
    assertListOrder(refillList, 'the list with a refill open');
    evidence.ord12 = { prescriber: { refillsAllowed: '0-11 on create, answered on reads (none as 0)', twelve: 400,
      patch: '400 (create only)', withoutDuration: '400 REFILLS_NEED_DURATION (details off, and on without a unit)' },
    interval: { rule: 'the latest fill not reversed, Lagos day, + ceil(3/4 x 10 days) = 8', beforeItsDay:
      'PHARMACY_REFILL_TOO_SOON with refillOpensOn; refills not_yet with nextFillOn; done work',
    onItsDay: 'open, open work (0152\'s open refills)' },
    fills: { recorded: 3, fillNumbers: [1, 2, 3], fourth: 'PHARMACY_NO_REFILLS_LEFT',
      sameFillNewKeyOtherBody: 'PHARMACY_FILL_NUMBER_CHANGED', skipped: 'PHARMACY_FILL_NUMBER_CHANGED',
      keyOfAnotherFill: 'IDEMPOTENCY_CONFLICT', sameKeySameBody: '201 replay', newKeySameBody: '201 replay',
      twoPressesAtOnce: 'one fill, both 201', events: 'MedicationDispensed per fill, fillNumber on refills only',
      acceptance: 'by fill 1 only' },
    item: { rows: 1, refills: { allowed: 2, recorded: 3, open: false, closedReason: 'none_left', nextFillOn: null,
      endsOn: 'the Lagos day written + 40 (2 refills of 10 days)' },
    dispensing: 'the latest fill', listOrder: 'first fills, then refills open, then done' },
    progress: { ownProgress: 'the first fill\'s time', pharmacy: 'lastFilledAt the latest' },
    reversal: { fill2: 'PHARMACY_DISPENSING_NOT_LATEST_FILL', fill3: 201,
      ownProgressAfter: 'dispensed (fills 1 and 2 stand), reversedAt null' },
    changedAfterFill1: { closedReason: 'changed', notice: 'edited (1)', refill: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE' },
    heldAfterFill1: { closedReason: 'stopped', notice: 'on_hold (1)', refill: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE' } };
    step('ORD-12: an edit after fill 1 closes the refills (changed) and shows 0148\'s notice (edited, 1); a hold closes '
      + 'them (stopped; on_hold, 1); a refill of either is refused; a refill open lists after the first fills');

    // The expiry (the clinical owner's D9, 24 November 2026): the refills end on the earliest of the end date, the
    // Lagos day written plus (refills + 2) x one fill's duration, and that day plus 365. rxEnds: 1 refill, a 1-day
    // duration, no end date, so its refills end 3 days after the day it was written (and a refill opens 1 day after
    // the latest fill). The clock is moved on 4 days as the owner moves its writing (created_at) and its fill back, in
    // replica mode (a fixture: it writes no version, so 0101's check still finds the prescription unchanged, and 0148
    // records no change).
    const rxEnds = await newPrescription('active', 'Synthetic amoxicillin 500 mg capsule',
      { refillsAllowed: 1, durationValue: 1, durationUnit: 'day' });
    assert.deepEqual(rxEnds.pharmacyHandoff, SENT, 'rxEnds is sent to the hospital\'s own pharmacy');
    const endsWritten = lagosDay(0);
    const itemEnds = onlyRow(await ownList('the list with rxEnds'), rxEnds, 'the list with rxEnds');
    assert.deepEqual(itemEnds.refills, { allowed: 1, recorded: 0, open: false, closedReason: null, nextFillOn: null,
      endsOn: plusDay(endsWritten, 3) }, `rxEnds before its first fill: ${JSON.stringify(itemEnds.refills)}`);
    const endsFill = expectStatus(await dispenseFill(itemEnds, { fillNumber: 1 }), 201, 'fill 1 of rxEnds');
    assert.deepEqual((await readItem(itemEnds, 'rxEnds\'s item after fill 1')).refills, { allowed: 1, recorded: 1,
      open: false, closedReason: 'not_yet', nextFillOn: lagosDay(1), endsOn: plusDay(endsWritten, 3) },
    'rxEnds after fill 1: its refill opens tomorrow and can be collected until 3 days after it was written');
    const movedBack = await prescriptionWrittenEarlier(rxEnds, 4);
    assert.deepEqual(movedBack, { written: plusDay(endsWritten, -4), version: String(rxEnds.rowVersion) },
      `rxEnds written 4 days earlier, its version unchanged: ${JSON.stringify(movedBack)}`);
    await fillRecordedEarlier(endsFill, 4);
    const endedOn = plusDay(endsWritten, -1);
    const dbDay = await one(`select to_char(ehr.prescription_refills_end_on(created_at, refills_allowed, duration_value,
        duration_unit, ends_on), 'YYYY-MM-DD') as day from ehr.prescriptions where id = $1`, [rxEnds.id]);
    assert.deepEqual([dbDay.day, endedOn], [lagosDay(-1), lagosDay(-1)], `the refills' last day was yesterday: ${dbDay.day}`);
    const endedRead = await readItem(itemEnds, 'rxEnds\'s item after its refills\' last day');
    assert.deepEqual(endedRead.refills, { allowed: 1, recorded: 1, open: false, closedReason: 'ended', nextFillOn: null,
      endsOn: endedOn }, `the refills ended: ${JSON.stringify(endedRead.refills)}`);
    assert.equal(endedRead.changedAfterDispensing, undefined, 'the fixture recorded no change after dispensing');
    const endedList = await ownList('the list after rxEnds\'s refills ended');
    oneRowEach(endedList, 'the list after rxEnds\'s refills ended');
    const endedRow = onlyRow(endedList, rxEnds, 'the list after rxEnds\'s refills ended');
    assert.deepEqual([endedRow.refills, listClass(endedRow)], [endedRead.refills, 2],
      'an item whose refills ended is done work (0152\'s open refills leave it out)');
    assertListOrder(endedList, 'the list after rxEnds\'s refills ended');
    const endedRefusal = refusedWith(await dispenseFill(itemEnds, { fillNumber: 2 }), 409,
      'PHARMACY_REFILL_PRESCRIPTION_ENDED', 'a refill after the refills\' last day');
    assert.equal(endedRefusal.refillsEndedOn, endedOn, `the refusal says the day they ended: ${JSON.stringify(endedRefusal)}`);
    assert.deepEqual((await fillsOf(itemEnds)).map(row => row.fill_number), [1], 'no refill recorded after the last day');
    evidence.ord12.expiry = { rule: 'the earliest of the end date, the Lagos day written + (refills + 2) x one fill, and + 365',
      oneRefillOneDay: 'endsOn = the day written + 3 (before and after fill 1)', afterTheLastDay: 'closed ended with endsOn; '
        + 'done work; refill 409 PHARMACY_REFILL_PRESCRIPTION_ENDED with refillsEndedOn (the database\'s own day)',
      fixture: 'created_at and fill 1 moved back 4 days as the owner in replica mode; version unchanged, no change recorded' };
    step('ORD-12: the refills\' last day (D9): every item\'s refills carry endsOn (the day written + (refills + 2) fills\' '
      + 'durations here); with 1 refill and a 1-day duration, once 3 days after the day written have passed, the item reads '
      + 'closed ended with endsOn, is done work, and its refill is refused (409 PHARMACY_REFILL_PRESCRIPTION_ENDED with '
      + 'refillsEndedOn, the database\'s own day)');

    // ── ORD-12 with the setting off: ehr-api and pharmacy-api booted again, PRESCRIPTION_REFILLS_ENABLED=false (and
    // ehr-api with 0125's details off again, as before this section) ──
    // The fills recorded while it was on stay. pharmacy-api still answers one row per item (the collapse does not
    // depend on the setting), with today's fields only; a second dispensing is refused as before.
    await Promise.all([stopService('ehr-api (details on)'), stopService('pharmacy-api')]);
    await Promise.all([
      boot('ehr-api (refills off)', join(services, 'ehr-api'), { ...ehrEnvironment, PRESCRIPTION_REFILLS_ENABLED: 'false' },
        ehrPort),
      boot('pharmacy-api (refills off)', join(services, 'pharmacy-api'),
        { ...pharmacyEnvironment, PRESCRIPTION_REFILLS_ENABLED: 'false' }, pharmacyPort)]);
    const offList = await ownList('the list with refills off');
    oneRowEach(offList, 'the list with refills off');
    assert.deepEqual(onlyRow(offList, rxRefills, 'the list with refills off').dispensing,
      { id: fill3.id, status: 'dispensed', reversed: true }, 'the item with three fills is one row: its latest fill');
    const ord12Keys = offList.filter(item => 'refills' in item || 'lastFilledAt' in item
      || (item.dispensing && 'fillNumber' in item.dispensing)).map(item => item.id);
    assert.deepEqual(ord12Keys, [], 'with refills off no item carries refills, lastFilledAt or a fill number');
    assert.equal(listClass(onlyRow(offList, rxOpen, 'the list with refills off')), 2,
      'with refills off an item with a refill left is done work, as before');
    assertListOrder(offList, 'the list with refills off');
    const offRead = await readItem(itemR, 'rxRefills\'s item with refills off');
    assert.deepEqual([offRead.dispensing, offRead.pharmacyStep, 'refills' in offRead, 'lastFilledAt' in offRead],
      [{ id: fill3.id, status: 'dispensed', reversed: true }, 'dispensing_reversed', false, false],
    `a read with refills off: ${JSON.stringify(offRead)}`);
    // A second dispensing, as Release B answers it: another request is 409 PHARMACY_WORK_ITEM_ALREADY_DISPENSED with
    // the same words (on the item with a refill left, and on the one with three fills); the first fill's request
    // replays it (201); fillNumber is an unknown field (400).
    const alreadyDispensed = [409, 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED',
      'A full dispensing is already recorded for this work item; partial dispensing is not supported', undefined];
    for (const [item, label] of [[itemOpen, 'rxOpen\'s item (a refill left)'], [itemR, 'rxRefills\'s item (three fills)']]) {
      const second = await dispenseFill(item, { quantityDispensed: 28 });
      assert.deepEqual([second.status, second.body?.code, second.body?.detail, second.body?.fillsRecorded], alreadyDispensed,
        `a second dispensing of ${label} with refills off: ${second.status} ${JSON.stringify(second.body)}`);
    }
    const offReplay = expectStatus(await dispenseFill(itemOpen), 201, 'rxOpen\'s first request again, a new key, refills off');
    assert.deepEqual([offReplay.id, 'fillNumber' in offReplay], [openFill.id, false], 'the first fill replayed, as before');
    fieldsRefused(await dispenseFill(itemOpen, { fillNumber: 2 }), 'fillNumber', 'fillNumber with refills off');
    assert.equal((await fillsOf(itemOpen)).length, 1, 'with refills off no refill is recorded');
    // ehr-api: refillsAllowed is an unknown field again, and no answer carries it; the progress is one row per item,
    // dispensed while any fill stands (that does not depend on the setting either).
    fieldsRefused(await ehrCall(doctor, 'POST', `${enc}/prescriptions`, prescriptionBody('active',
      'Synthetic amlodipine 5 mg tablet', { refillsAllowed: 1 }), { key: freshKey('prescription') }), 'refillsAllowed',
    'refills on create with refills off');
    const offDoctorList = expectStatus(await ehrCall(doctor, 'GET', `${enc}/prescriptions`), 200,
      'the doctor\'s prescriptions with refills off');
    assert.deepEqual(['refills' in offDoctorList, offDoctorList.items.filter(item => 'refillsAllowed' in item).length],
      [false, 0], 'with refills off the prescriptions carry no refills');
    assert.deepEqual(await ownProgressOf(rxRefills), dispensedR, 'with refills off the prescriber reads the same progress');
    const offProgress = await pharmacyProgress([rxRefills.id, rxOpen.id], 'progress with refills off');
    assert.deepEqual(offProgress.map(item => [item.sourceEhrPrescriptionId, item.status, item.dispensedAt,
      item.reversedAt, 'lastFilledAt' in item]), [[rxRefills.id, 'dispensed', fill1At, null, false],
      [rxOpen.id, 'dispensed', openFillAt, null, false]], `the progress with refills off: ${JSON.stringify(offProgress)}`);
    evidence.ord12.off = { list: 'one row per item, the latest fill, today\'s fields only',
      refillLeft: 'done work, as before', secondDispensing: 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED, as before',
      sameRequest: '201 replay of fill 1', fillNumber: 400, refillsAllowedOnCreate: 400,
      progress: 'one row per item, the first fill\'s time, dispensed while a fill stands' };
    step('ORD-12 with PRESCRIPTION_REFILLS_ENABLED off (both services booted again): one row per item (the latest fill), '
      + 'today\'s fields only; a second dispensing is refused as before (PHARMACY_WORK_ITEM_ALREADY_DISPENSED), fillNumber '
      + 'and refillsAllowed are unknown fields');
  } else {
    // ── ORD-12 with PRESCRIPTION_REFILLS_ENABLED off in every service from the start (the clinical owner's decision,
    // 24 November 2026): every step above ran with it off and passed unchanged. Here: on a database with 0152, no
    // answer carries refills, lastFilledAt, a fill number or refillsAllowed; refillsAllowed and fillNumber are unknown
    // fields (400); a second dispensing of a dispensed item is refused as Release B refuses it; one row per item. ──
    const offList = await ownList('the list with refills off from the start');
    oneRowEach(offList, 'the list with refills off from the start');
    const ord12Keys = offList.filter(item => 'refills' in item || 'lastFilledAt' in item
      || (item.dispensing && 'fillNumber' in item.dispensing)).map(item => item.id);
    assert.deepEqual(ord12Keys, [], 'with refills off no item carries refills, lastFilledAt or a fill number');
    assertListOrder(offList, 'the list with refills off from the start');
    const item4Off = onlyRow(offList, rx4, 'the list with refills off from the start');
    assert.notEqual(item4Off.dispensing, null, 'rx4\'s item was dispensed above');
    const second = await dispenseFill(item4Off, { quantityDispensed: 28 });
    assert.deepEqual([second.status, second.body?.code, second.body?.detail], [409, 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED',
      'A full dispensing is already recorded for this work item; partial dispensing is not supported'],
    `a second dispensing with refills off: ${second.status} ${JSON.stringify(second.body)}`);
    fieldsRefused(await dispenseFill(item4Off, { fillNumber: 2 }), 'fillNumber', 'fillNumber with refills off');
    assert.equal((await fillsOf(item4Off)).length, 1, 'with refills off no second fill is recorded');
    fieldsRefused(await ehrCall(doctor, 'POST', `${enc}/prescriptions`, prescriptionBody('active',
      'Synthetic amlodipine 5 mg tablet', { refillsAllowed: 1 }), { key: freshKey('prescription') }), 'refillsAllowed',
    'refills on create with refills off');
    const offDoctorList = expectStatus(await ehrCall(doctor, 'GET', `${enc}/prescriptions`), 200,
      'the doctor\'s prescriptions with refills off');
    assert.deepEqual(['refills' in offDoctorList, offDoctorList.items.filter(item => 'refillsAllowed' in item).length],
      [false, 0], 'with refills off the prescriptions carry no refills');
    const offProgress = await pharmacyProgress([rx4.id], 'progress with refills off');
    assert.deepEqual(offProgress.map(item => [item.sourceEhrPrescriptionId, 'lastFilledAt' in item]), [[rx4.id, false]],
      `the progress with refills off carries no lastFilledAt: ${JSON.stringify(offProgress)}`);
    evidence.ord12 = { offFromTheStart: { earlierSteps: 'passed unchanged', list: 'one row per item, today\'s fields only',
      secondDispensing: 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED, as before', fillNumber: 400, refillsAllowedOnCreate: 400 } };
    step('ORD-12 with PRESCRIPTION_REFILLS_ENABLED off in ehr-api and pharmacy-api from the start: every step above '
      + 'passed unchanged; no answer carries refills, lastFilledAt, a fill number or refillsAllowed; fillNumber and '
      + 'refillsAllowed are unknown fields; a second dispensing is refused as before');
  }

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
