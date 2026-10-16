#!/usr/bin/env node
// Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-065)
// over HTTP: the real EHR AppModule as hid_ehr_api_runtime in this process,
// authorizing every read through the real Identity AppModule (as
// hid_identity_api_runtime, in a child process) with browser cookies, on a
// disposable copy of the owned synthetic rehearsal database. Imported rows
// are inserted as synthetic fixtures; nothing is imported from any source.
//
// The patient reads their own imported history through the patient-self
// path and the release set (its own flag), and needs no sharing choice. A
// clinician with an active direct-care consent at the selected facility
// sees `shared: false` and nothing until the patient turns sharing on (a
// cookie POST with Origin and CSRF, a recent sign-in), then the history; a
// purpose other than direct care is refused before Identity is asked; a
// break-glass grant opens the emergency summary, which holds no imported
// key, and never the imported history; a revoked consent is refused at the
// next request; staff sessions are refused the patient's routes; and with
// each flag off its routes answer 503 and the database admits no imported
// row to the patient. Synthetic accounts and records only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { childOutboxLine, enrollmentCodeOutbox, fetchTransport, readChildOutbox, staffClient,
  SYNTHETIC_STAFF_MFA_KEY_B64 } from '../../identity-api/scripts/staff-session-client.mjs';

const ORIGIN = 'https://staging.healthidentitydirectory.com';
const ehrWorkloadCredential = `${randomUUID()}${randomUUID()}`;
const identityService = resolve(import.meta.dirname, '../../identity-api');
const EHR_FLAGS = ['EHR_PATIENT_RELEASE_IMPORTED_HISTORY', 'EHR_STAFF_IMPORTED_HISTORY_ENABLED'];
// Fields of the stored rows that no response may carry.
const NEVER_DISCLOSED = /source_payload|sourcePayload|source_sha256|sourceSha256|source_run_id|sourceRunId|authorAccountId|author_account_id|uploaderAccountId|storage_path|storage_bucket|synthetic-private|sha256/;

/** A copy of the owned synthetic rehearsal database, dropped by close(). */
async function disposableDatabase(require) {
  const socket = process.env.PGHOST;
  assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
    && process.env.PGDATABASE === 'hid_rehearsal' && process.env.PGUSER,
  'Only the owned synthetic rehearsal is supported');
  const { Client, Pool } = require('pg');
  const admin = process.env.PGUSER;
  const name = `hid_rehearsal_imported_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const maintenance = new Client({ host: socket, user: admin, database: 'postgres' });
  await maintenance.connect();
  await maintenance.query(`create database ${name} template hid_rehearsal`);
  const owner = new Pool({ host: socket, user: admin, database: name, max: 4 });
  owner.on('error', () => undefined);
  return {
    owner,
    url: (role) => `postgresql://${encodeURIComponent(admin)}@localhost/${name}?host=${encodeURIComponent(socket)}`
      + `&options=${encodeURIComponent(`-c role=${role}`)}`,
    /** Fixture SQL as the owner in one transaction, triggers and foreign keys off as in the SQL suites. */
    fixture: async (build) => {
      const client = await owner.connect();
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        await build(client);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    },
    close: async () => {
      await owner.end();
      await maintenance.query(`drop database if exists ${name} with (force)`);
      await maintenance.end();
    },
  };
}

/** The service's real AppModule with its main.ts request pipeline, on 127.0.0.1. */
async function startService({ require, service, override }) {
  require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
  require('reflect-metadata');
  const load = (path) => require(join(service, 'src', path));
  const { Test } = require('@nestjs/testing');
  const { ValidationPipe } = require('@nestjs/common');
  const { AppModule } = load('app.module.ts');
  const { DatabaseService } = load('database/database.service.ts');
  const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
  const { preventResponseCaching } = load('common/response-security.middleware.ts');
  const builder = Test.createTestingModule({ imports: [AppModule] });
  const module = await (override ? override(builder, load) : builder).compile();
  const app = module.createNestApplication({ bodyParser: false, logger: false });
  app.setGlobalPrefix('api/v1');
  app.use(preventResponseCaching);
  app.use(require('cookie-parser')());
  app.useBodyParser('json', { limit: 256 * 1024, strict: true, type: ['application/json', 'application/*+json'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.listen(0, '127.0.0.1');
  return { app, load, module, database: module.get(DatabaseService), close: () => app.close() };
}

if (process.argv[2] === '--identity-child') {
  // Child: the Identity API, alone in its process so its environment is its own.
  const app = await startService({ require: createRequire(join(identityService, 'package.json')),
    service: identityService, override: (builder, load) => builder
      .overrideProvider(load('auth/notification-otp.client.ts').NotificationOtpClient).useValue({
        deliver: async (input) => {
          if (input.purpose !== 'LOGIN_STEP_UP') throw new Error(`Unexpected ${input.purpose} delivery`);
          process.stdout.write(childOutboxLine(input));
          return { outcome: 'accepted', provider: 'synthetic' };
        } }) });
  process.stdout.write(`${JSON.stringify({ url: (await app.app.getUrl()).replace('[::1]', '127.0.0.1') })}\n`);
  process.stdin.resume();
  process.stdin.on('end', async () => { await app.close(); process.exit(0); });
} else {
  const service = resolve(import.meta.dirname, '..');
  const require = createRequire(join(service, 'package.json'));
  const database = await disposableDatabase(require);
  let identity, ehr;
  try {
    const argon2 = require('argon2');
    const password = 'Synthetic-Imported-Password-2026';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const id = () => randomUUID();
    const ids = { org: id(), facility: id(), doctorAccount: id(), doctor: id(), membership: id(),
      patientAccount: id(), patient: id(), otherAccount: id(), other: id(), emergencyAccount: id(), emergency: id(),
      consent: id(), breakGlass: id(), run: id(), records: [id(), id(), id(), id()], versions: [id(), id(), id(), id(), id()],
      file: id() };
    const doctorEmail = `imported-doctor-${ids.doctorAccount}@example.invalid`;
    const patientEmail = `imported-patient-${ids.patientAccount}@example.invalid`;
    const { owner } = database;
    await owner.query("insert into identity.organizations(id,name,slug) values($1,'Imported Rehearsal Org',$2)",
      [ids.org, `imported-${ids.org}`]);
    await owner.query(`insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
      values($1,$2,'Imported Rehearsal Hospital',$3,'Africa/Lagos',true,'verified')`,
    [ids.facility, ids.org, `IMP-${ids.facility.slice(0, 6)}`]);
    await owner.query(`insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm)
      values($1,$2,$3,'Synthetic imported doctor','active',$4,'argon2id')`,
    [ids.doctorAccount, `synthetic:imported-doctor:${ids.doctorAccount}`, doctorEmail, passwordHash]);
    await owner.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
      values($1,$2,'Synthetic imported doctor',$3,'verified','doctor')`, [ids.doctor, ids.doctorAccount, doctorEmail]);
    await owner.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,
      membership_role,app_role,is_primary,active) values($1,$2,$3,$4,$5,'doctor','doctor',true,true)`,
    [ids.membership, ids.doctor, ids.doctorAccount, ids.org, ids.facility]);
    await owner.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
      values($1,$2,'doctor','facility',$3,$4,'Synthetic rehearsal role')`,
    [id(), ids.doctorAccount, ids.membership, ids.facility]);
    for (const [account, patientId, email, hid, name] of [
      [ids.patientAccount, ids.patient, patientEmail, 'HID-EMPXRTA', 'Ada Imported'],
      [ids.otherAccount, ids.other, `imported-other-${ids.otherAccount}@example.invalid`, 'HID-EMPXRTB', 'Bayo Imported'],
      [ids.emergencyAccount, ids.emergency, `imported-emergency-${ids.emergencyAccount}@example.invalid`, 'HID-EMPXRTC',
        'Chidi Imported']]) {
      await owner.query(`insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm)
        values($1,$2,$3,$4,'active',$5,'argon2id')`, [account, `synthetic:imported-patient:${account}`, email, name,
        passwordHash]);
      await owner.query(`insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
        values($1,$2,$3,$4,'Imported',$5,'active')`, [patientId, account, hid, name.split(' ')[0], name]);
    }

    // The imported rows (synthetic fixtures, as the import command would write
    // them): two records of the patient (the first with two versions and a
    // file), one of another patient and one of the break-glass patient; the
    // doctor's direct-care consent for the patient; a break-glass grant for
    // the third patient, who has chosen to share. The emergency purpose
    // exists only in this copy (break-glass is off at launch, D9).
    await database.fixture(async (client) => {
      await client.query(`insert into migration.runs(id,source_system,source_snapshot,mode,status,started_by)
        values($1,'legacy_identity','synthetic-imported-runtime','stage','staged','imported-history-runtime')`, [ids.run]);
      const records = [[ids.records[0], ids.patient, ids.patientAccount, 'patient-provided', ids.versions[1], 3],
        [ids.records[1], ids.patient, ids.doctorAccount, 'provider-authored', ids.versions[2], 2],
        [ids.records[2], ids.other, ids.otherAccount, 'patient-provided', ids.versions[3], 1],
        [ids.records[3], ids.emergency, ids.emergencyAccount, 'patient-provided', ids.versions[4], 1]];
      for (const [recordId, patientId, author, origin, current, days] of records) {
        await client.query(`insert into ehr.imported_medical_records(id,patient_id,author_account_id,origin,
          current_version_id,source_run_id,source_payload,source_sha256,source_created_at,source_updated_at)
          values($1,$2,$3,$4,$5,$6,$7,repeat('a',64),clock_timestamp()-$8*interval '1 day',clock_timestamp()-$8*interval '1 day')`,
        [recordId, patientId, author, origin, current, ids.run, { id: recordId, title: `Synthetic legacy history ${days}`,
          category: 'history', info_type: 'text', storage_path: 'synthetic-private/never-returned' }, days]);
      }
      const versions = [[ids.versions[0], ids.records[0], ids.patient, 1, ids.patientAccount, 'patient-provided'],
        [ids.versions[1], ids.records[0], ids.patient, 2, ids.patientAccount, 'patient-provided'],
        [ids.versions[2], ids.records[1], ids.patient, 1, ids.doctorAccount, 'provider-authored'],
        [ids.versions[3], ids.records[2], ids.other, 1, ids.otherAccount, 'patient-provided'],
        [ids.versions[4], ids.records[3], ids.emergency, 1, ids.emergencyAccount, 'patient-provided']];
      for (const [versionId, recordId, patientId, versionNo, author, origin] of versions) {
        await client.query(`insert into ehr.imported_medical_record_versions(id,record_id,patient_id,version_no,
          author_account_id,origin,source_payload,source_sha256,source_created_at)
          values($1,$2,$3,$4,$5,$6,$7,repeat('b',64),clock_timestamp()-interval '1 day')`,
        [versionId, recordId, patientId, versionNo, author, origin, { record: `Invented legacy text ${versionNo}`,
          notes: null, structured_data: { synthetic: true }, transcription_text: null }]);
      }
      await client.query(`insert into ehr.imported_medical_record_files(id,record_id,patient_id,record_version_id,
        uploader_account_id,source_payload,source_sha256,source_created_at)
        values($1,$2,$3,$4,$5,$6,repeat('c',64),clock_timestamp()-interval '1 day')`,
      [ids.file, ids.records[0], ids.patient, ids.versions[1], ids.patientAccount, { original_file_name: 'synthetic-history.txt',
        mime_type: 'text/plain', size_bytes: 19, storage_bucket: 'synthetic-private', storage_path: 'synthetic/history-1' }]);
      await client.query(`insert into identity.consent_grants(id,patient_id,staff_id,account_id,membership_id,facility_id,
        scope,purpose_of_use,status,reason,starts_at,expires_at)
        values($1,$2,$3,$4,$5,$6,'read_records','direct-care','active','Synthetic imported consent',
          clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days')`,
      [ids.consent, ids.patient, ids.doctor, ids.doctorAccount, ids.membership, ids.facility]);
      await client.query(`insert into identity.purpose_of_use_codes(code,display,source_system)
        values('emergency','Emergency treatment','imported-history-runtime') on conflict(code) do nothing`);
      await client.query(`insert into identity.consent_grants(id,patient_id,staff_id,account_id,membership_id,facility_id,
        scope,purpose_of_use,status,reason,starts_at,expires_at,break_glass)
        values($1,$2,$3,$4,$5,$6,'break_glass','emergency','active','Synthetic unconscious patient emergency',
          clock_timestamp()-interval '5 minutes',clock_timestamp()+interval '55 minutes',true)`,
      [ids.breakGlass, ids.emergency, ids.doctor, ids.doctorAccount, ids.membership, ids.facility]);
      await client.query(`insert into identity.imported_history_sharing(patient_id,shared,row_version,updated_at,
        updated_session_id) values($1,true,1,clock_timestamp(),$2)`, [ids.emergency, id()]);
    });

    // Identity in its own process, as its runtime role, with the sharing routes on.
    const shared = { NODE_ENV: 'test', PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8', TZ: 'UTC',
      ...(process.env.PGPORT ? { PGPORT: process.env.PGPORT } : {}),
      CORS_ORIGINS: ORIGIN, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: ehrWorkloadCredential };
    const staffEnrollmentCodes = enrollmentCodeOutbox();
    const startIdentity = async (sharing) => {
      const child = spawn(process.execPath, [import.meta.filename, '--identity-child'], { stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...shared, DATABASE_URL: database.url('hid_identity_api_runtime'), AUTH_MODE: 'local',
          AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET, AUTH_LOGIN_PEPPER: process.env.AUTH_LOGIN_PEPPER,
          OTP_HMAC_KEY_B64: process.env.OTP_HMAC_KEY_B64, AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
          NIN_PROVIDER_MODE: 'deferred', TURNSTILE_MODE: 'disabled', IMPORTED_HISTORY_SHARING_ENABLED: String(sharing),
          MFA_SECRET_KEY_B64: SYNTHETIC_STAFF_MFA_KEY_B64, MFA_KEY_VERSION: 'imported-runtime-v1' } });
      const lines = createInterface({ input: child.stdout });
      const started = await new Promise((resolveStart, reject) => {
        lines.once('line', (line) => resolveStart(JSON.parse(line)));
        child.once('exit', (code) => reject(new Error(`Identity exited before listening (${code})`)));
      });
      readChildOutbox(lines, staffEnrollmentCodes);
      return { child, url: started.url, base: `${started.url}/api/v1` };
    };
    const stopIdentity = async (running) => {
      running.child.stdin.end();
      await new Promise((resolveExit) => running.child.exitCode !== null ? resolveExit() : running.child.once('exit', resolveExit));
    };
    identity = await startIdentity(true);

    // EHR in this process, as its runtime role, delegating to that Identity.
    const bootEhr = async (flags) => {
      for (const flag of EHR_FLAGS) delete process.env[flag];
      Object.assign(process.env, { ...shared, DATABASE_URL: database.url('hid_ehr_api_runtime'),
        IDENTITY_API_URL: identity.url, STORAGE_MODE: 'disabled', HID_DEPLOYMENT_ENV: 'development',
        ...Object.fromEntries(flags.map((flag) => [flag, 'true'])) });
      require(join(service, 'src', 'config', 'environment.ts')).resetEnvironmentForTests();
      const booted = await startService({ require, service });
      const { rows } = await booted.database.query('select current_user as role');
      assert.equal(rows[0].role, 'hid_ehr_api_runtime');
      return { ...booted, base: `${(await booted.app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1` };
    };
    ehr = await bootEhr(EHR_FLAGS);

    const call = async (base, method, path, headers = {}, body) => {
      const response = await fetch(`${base}${path}`, { method, headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
    };
    const checks = [];
    const signInPatient = async () => {
      const response = await call(identity.base, 'POST', '/auth/patient/login', { origin: ORIGIN },
        { email: patientEmail, password, turnstileAction: 'patient-login' });
      assert.equal(response.status, 200, `patient sign-in: ${JSON.stringify(response.body)}`);
      return { cookie: response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; '),
        csrf: response.headers.get('x-csrf-token') };
    };
    const patient = await signInPatient();
    const staffSession = staffClient({ send: fetchTransport(identity.base), origin: ORIGIN, password,
      outbox: staffEnrollmentCodes });
    const doctor = await staffSession.signIn(doctorEmail, { action: 'staff-login' });
    const staffRead = (patientId, purpose = 'direct-care', base = ehr.base) => call(base, 'GET',
      `/ehr/patients/${patientId}/imported-history`, { cookie: doctor.cookie, 'x-facility-id': ids.facility,
        ...(purpose === undefined ? {} : { 'x-purpose-of-use': purpose }) });
    // The imported rows one patient-self transaction of the EHR reads, under
    // Identity's real authorization for this cookie; `bind` says whether
    // PatientRecordRelease tells the database its release set.
    const importedRows = async (booted, cookie, bind) => {
      const identityApi = booted.module.get(booted.load('integrations/identity-api.service.ts').IdentityApiService);
      const release = booted.module.get(booted.load('ehr/patient-records/patient-release.ts').PatientRecordRelease);
      const headers = { cookie, origin: ORIGIN };
      const authorization = await identityApi.authorizeSelf({ correlationId: `imported-binding-${randomUUID()}`,
        header: (name) => headers[name.toLowerCase()] });
      return booted.database.withPatientTransaction(authorization, `imported-binding-${randomUUID()}`, async (client) => {
        if (bind) await release.bind(client);
        const { rows } = await client.query(`select
            (select count(*)::int from ehr.imported_medical_records) as records,
            (select count(*)::int from ehr.imported_medical_record_versions) as versions,
            (select count(*)::int from ehr.imported_medical_record_files) as files,
            current_user as role`);
        return rows[0];
      });
    };

    // 1. The patient reads their own history, needing no sharing choice.
    const own = await call(ehr.base, 'GET', '/ehr/me/imported-history', { cookie: patient.cookie });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.match(own.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(Object.keys(own.body), ['records', 'healthProfile', 'limits', 'truncated', 'nextCursor', 'provenance']);
    assert.deepEqual(own.body.records.map((record) => [record.id, record.origin, record.title]), [
      [ids.records[1], 'provider-authored', 'Synthetic legacy history 2'],
      [ids.records[0], 'patient-provided', 'Synthetic legacy history 3']]);
    assert.deepEqual(own.body.records[1].versions.map((version) => [version.versionNo, version.record]),
      [[2, 'Invented legacy text 2'], [1, 'Invented legacy text 1']]);
    assert.deepEqual(own.body.records[1].files.map((file) => [file.id, file.fileName, file.mediaType, file.sizeBytes,
      file.accessStatus]), [[ids.file, 'synthetic-history.txt', 'text/plain', 19, 'pending-safety-verification']]);
    assert.deepEqual([own.body.healthProfile, own.body.truncated, own.body.nextCursor, own.body.provenance],
      [null, { records: false }, null, 'legacy-import']);
    assert.doesNotMatch(JSON.stringify(own.body), NEVER_DISCLOSED);
    const ownAudit = await owner.query(`select purpose_of_use, details from audit.events
      where action='ehr.patient.self.imported-history.read' and outcome='success' and patient_id=$1`, [ids.patient]);
    assert.deepEqual(ownAudit.rows, [{ purpose_of_use: 'patient-self', details: { recordCount: 2, versionCount: 3,
      fileCount: 1, healthProfile: false, truncated: false } }]);
    // The summary is unchanged with the imported history released: no imported key.
    const summary = await call(ehr.base, 'GET', '/ehr/me/records', { cookie: patient.cookie });
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.deepEqual(summary.body.released, ['encounters', 'notes']);
    assert.doesNotMatch(JSON.stringify(summary.body), /imported/i);
    checks.push('the patient reads their own imported history through the patient-self path (records, versions, files with pending safety status, no stored source fields, Cache-Control no-store), audited with counts only, without any sharing choice; GET /ehr/me/records keeps its keys and releases no imported key');

    // 2. Consent alone discloses nothing: the clinician sees shared: false.
    const unshared = await staffRead(ids.patient);
    assert.equal(unshared.status, 200, JSON.stringify(unshared.body));
    assert.deepEqual(unshared.body, { shared: false, records: [], healthProfile: null,
      limits: { records: 50, versionsPerRecord: 20, filesPerRecord: 20 }, truncated: { records: false }, nextCursor: null,
      provenance: 'legacy-import' });
    // The same answer for a patient with no imported history at all, and the
    // same for a patient whose history exists but is not shared.
    checks.push('a clinician with an active direct-care consent at the selected facility reads shared: false and nothing until the patient shares');

    // 3. The patient shares, through a cookie POST with Origin and CSRF.
    const sharingPath = '/identity/me/imported-history-sharing';
    assert.deepEqual((await call(identity.base, 'GET', sharingPath, { cookie: patient.cookie })).body,
      { shared: false, updatedAt: null });
    const noCsrf = await call(identity.base, 'POST', sharingPath, { cookie: patient.cookie, origin: ORIGIN },
      { shared: true });
    assert.equal(noCsrf.status, 403, `a cookie POST without CSRF: ${JSON.stringify(noCsrf.body)}`);
    const invalid = await call(identity.base, 'POST', sharingPath, { cookie: patient.cookie, origin: ORIGIN,
      'x-csrf-token': patient.csrf }, { shared: 'yes' });
    assert.deepEqual([invalid.status, invalid.body?.code], [400, 'VALIDATION_FAILED']);
    const turnedOn = await call(identity.base, 'POST', sharingPath, { cookie: patient.cookie, origin: ORIGIN,
      'x-csrf-token': patient.csrf }, { shared: true });
    assert.equal(turnedOn.status, 200, JSON.stringify(turnedOn.body));
    assert.deepEqual([turnedOn.body.shared, turnedOn.body.changed], [true, true]);
    const again = await call(identity.base, 'POST', sharingPath, { cookie: patient.cookie, origin: ORIGIN,
      'x-csrf-token': patient.csrf }, { shared: true });
    assert.deepEqual([again.status, again.body.shared, again.body.changed], [200, true, false]);
    const sharingAudit = await owner.query(`select action, details from audit.events
      where action like 'identity.patient.self.imported-history-sharing.%' and outcome='success' and patient_id=$1
      order by occurred_at, sequence_id`, [ids.patient]);
    assert.deepEqual(sharingAudit.rows.map((row) => [row.action, row.details]), [
      ['identity.patient.self.imported-history-sharing.read', { shared: false }],
      ['identity.patient.self.imported-history-sharing.change', { shared: true, changed: true }],
      ['identity.patient.self.imported-history-sharing.change', { shared: true, changed: false }]]);
    checks.push('the patient reads and turns on sharing through Identity\'s session-bound commands (a cookie POST without CSRF is refused, a malformed body answers 400 VALIDATION_FAILED, a repeat changes nothing), each audited with the choice only');

    // 4. Consent and the patient's choice: the clinician reads the history.
    const sharedRead = await staffRead(ids.patient);
    assert.equal(sharedRead.status, 200, JSON.stringify(sharedRead.body));
    assert.equal(sharedRead.body.shared, true);
    assert.deepEqual(sharedRead.body.records.map((record) => record.id), [ids.records[1], ids.records[0]]);
    assert.doesNotMatch(JSON.stringify(sharedRead.body), NEVER_DISCLOSED);
    const staffAudit = await owner.query(`select purpose_of_use, details from audit.events
      where action='ehr.imported-history.read' and outcome='success' and patient_id=$1 order by occurred_at, sequence_id`,
    [ids.patient]);
    assert.deepEqual(staffAudit.rows.map((row) => [row.purpose_of_use, row.details]), [
      ['direct-care', { shared: false, recordCount: 0, versionCount: 0, fileCount: 0, healthProfile: false, truncated: false }],
      ['direct-care', { shared: true, recordCount: 2, versionCount: 3, fileCount: 1, healthProfile: false, truncated: false }]]);
    // Another patient's history stays with them: no consent, no sharing.
    const otherRead = await staffRead(ids.other);
    assert.deepEqual([otherRead.status, otherRead.body?.code], [403, 'CONSENT_REQUIRED']);
    checks.push('with direct-care consent at the selected facility and the patient\'s sharing choice, the clinician reads the patient\'s whole imported history, audited with counts and the choice; another patient without consent is refused 403 CONSENT_REQUIRED');

    // 5. Direct care only, before Identity is asked.
    for (const purpose of ['emergency', 'healthcare-operations', undefined]) {
      const refused = await staffRead(ids.patient, purpose);
      assert.deepEqual([refused.status, refused.body?.code], [400, 'DIRECT_CARE_PURPOSE_REQUIRED'], `purpose ${purpose}`);
    }
    checks.push('any purpose but direct care, or none, answers 400 DIRECT_CARE_PURPOSE_REQUIRED');

    // 6. Break-glass: the emergency summary opens and holds no imported key;
    //    the imported history never does.
    const emergencySummary = await call(ehr.base, 'GET', `/ehr/patients/${ids.emergency}/emergency-records`, {
      cookie: doctor.cookie, 'x-facility-id': ids.facility, 'x-purpose-of-use': 'emergency' });
    assert.equal(emergencySummary.status, 200, JSON.stringify(emergencySummary.body));
    assert.deepEqual(Object.keys(emergencySummary.body), ['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions',
      'labRequests', 'documents', 'released', 'withheld', 'limits', 'truncated', 'limit']);
    assert.doesNotMatch(JSON.stringify(emergencySummary.body), /imported|Synthetic legacy|Invented legacy/i);
    const emergencyAudit = await owner.query(`select details from audit.events where action='ehr.emergency.records.read'
      and outcome='success' and patient_id=$1`, [ids.emergency]);
    assert.equal(emergencyAudit.rows.length, 1);
    assert.doesNotMatch(JSON.stringify(emergencyAudit.rows[0].details), /imported/i);
    const breakGlassDirect = await staffRead(ids.emergency);
    assert.deepEqual([breakGlassDirect.status, breakGlassDirect.body?.code], [403, 'CONSENT_REQUIRED']);
    const breakGlassEmergency = await staffRead(ids.emergency, 'emergency');
    assert.deepEqual([breakGlassEmergency.status, breakGlassEmergency.body?.code], [400, 'DIRECT_CARE_PURPOSE_REQUIRED']);
    checks.push('under an active break-glass grant for a patient who shares, the emergency summary answers its exact keys with no imported key or content (and an audit row without any), while the imported history answers 400 DIRECT_CARE_PURPOSE_REQUIRED for the emergency purpose and 403 CONSENT_REQUIRED for direct care');

    // 7. Staff sessions are refused the patient's routes.
    const staffOnOwn = await call(ehr.base, 'GET', '/ehr/me/imported-history', { cookie: doctor.cookie,
      'x-facility-id': ids.facility });
    assert.deepEqual([staffOnOwn.status, staffOnOwn.body?.code], [403, 'PATIENT_SESSION_REQUIRED']);
    const staffOnSharing = await call(identity.base, 'GET', sharingPath, { cookie: doctor.cookie });
    assert.deepEqual([staffOnSharing.status, staffOnSharing.body?.code], [403, 'PATIENT_SESSION_REQUIRED']);
    checks.push('a staff session is refused GET /ehr/me/imported-history and the sharing routes with 403 PATIENT_SESSION_REQUIRED');

    // 8. The database follows the flag: a patient-self transaction that names
    //    no category reads no imported row; one bound by PatientRecordRelease
    //    with the flag on reads the patient's own.
    assert.deepEqual(await importedRows(ehr, patient.cookie, false), { records: 0, versions: 0, files: 0,
      role: 'hid_ehr_api_runtime' }, 'an unbound patient-self transaction read an imported row');
    assert.deepEqual(await importedRows(ehr, patient.cookie, true), { records: 2, versions: 3, files: 1,
      role: 'hid_ehr_api_runtime' });
    checks.push('in the EHR\'s own patient-self transaction under Identity\'s real authorization, a transaction that names no release category reads no imported row and one bound by PatientRecordRelease reads only the patient\'s own');

    // 9. Revoking consent takes effect at the next request.
    await owner.query(`update identity.consent_grants set status='revoked', revoked_at=clock_timestamp(),
      revoked_reason='Synthetic revocation' where id=$1`, [ids.consent]);
    const revoked = await staffRead(ids.patient);
    assert.deepEqual([revoked.status, revoked.body?.code], [403, 'CONSENT_REQUIRED']);
    const deniedAudit = await owner.query(`select details from audit.events where action='ehr.imported-history.read'
      and outcome='denied' and patient_id=$1`, [ids.patient]);
    assert.deepEqual(deniedAudit.rows.map((row) => row.details), [{ reason: 'identity_authorization' }]);
    checks.push('a revoked consent is refused at the next request with 403 CONSENT_REQUIRED, audited denied');

    // 10. Every EHR flag off: both routes answer 503, the database admits no
    //     imported row to the patient, and the summary is as before.
    await ehr.close();
    ehr = await bootEhr([]);
    const offOwn = await call(ehr.base, 'GET', '/ehr/me/imported-history', { cookie: patient.cookie });
    assert.deepEqual([offOwn.status, offOwn.body?.code], [503, 'IMPORTED_HISTORY_DISABLED']);
    const offStaff = await staffRead(ids.patient);
    assert.deepEqual([offStaff.status, offStaff.body?.code], [503, 'IMPORTED_HISTORY_DISABLED']);
    assert.deepEqual(await importedRows(ehr, patient.cookie, true), { records: 0, versions: 0, files: 0,
      role: 'hid_ehr_api_runtime' }, 'with the flag off the database admitted an imported row');
    checks.push('with both EHR flags off, GET /ehr/me/imported-history and the staff route answer 503 IMPORTED_HISTORY_DISABLED and the release binding admits no imported row');

    // 11. The sharing switch off: Identity answers 503 before the body.
    await ehr.close();
    ehr = undefined;
    await stopIdentity(identity);
    identity = await startIdentity(false);
    const offSharing = await call(identity.base, 'GET', sharingPath, { cookie: patient.cookie });
    assert.deepEqual([offSharing.status, offSharing.body?.code], [503, 'IMPORTED_HISTORY_SHARING_DISABLED']);
    const offSet = await call(identity.base, 'POST', sharingPath, { cookie: patient.cookie, origin: ORIGIN,
      'x-csrf-token': patient.csrf }, { shared: false });
    assert.deepEqual([offSet.status, offSet.body?.code], [503, 'IMPORTED_HISTORY_SHARING_DISABLED']);
    checks.push('with the sharing switch off, both sharing routes answer 503 IMPORTED_HISTORY_SHARING_DISABLED');

    process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'local-synthetic-only',
      roles: ['hid_ehr_api_runtime', 'hid_identity_api_runtime'], checks })}\n`);
  } finally {
    await ehr?.close();
    if (identity) {
      identity.child.stdin.end();
      await new Promise((resolveExit) => identity.child.exitCode !== null ? resolveExit() : identity.child.once('exit', resolveExit));
    }
    await database.close();
  }
}
