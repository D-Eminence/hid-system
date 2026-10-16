#!/usr/bin/env node
// The patient record release (owner decision 4 of 2026-10-16, D7) over HTTP:
// the real EHR AppModule as hid_ehr_api_runtime in this process, authorizing
// every patient read through the real Identity AppModule (as
// hid_identity_api_runtime, in a child process) with the patient's browser
// cookie, on a disposable copy of the owned synthetic rehearsal database.
// Only the document object store is replaced, by a recording fake: no
// object is stored or signed for real.
//
// With every category flag on (a development deployment profile, where Lab
// may run), GET /ehr/me/records releases exactly the final uncorrected
// vitals, confirmed diagnoses (without the clinician's notes), active, on-hold
// and completed prescriptions, the latest released Lab result revisions and
// the clean PHI documents of completed encounters, and withholds lab
// requests; the patient document download answers one 404 for every document
// it does not release, checks the exact stored object after the audit
// commits, and signs a 60 s attachment URL. A staff session is refused both
// routes before a facility is bound, Identity refuses the patient-self
// authorization to lab-api (D17), and lab-api serves no patient route. The
// database follows the flags: in the EHR's own patient-self transaction, with
// Identity's real authorization, a transaction that names no category (as an
// EHR build from before the release would run it) reads nothing new, and one
// bound by PatientRecordRelease reads only the configured categories. A
// second EHR boot with only vitals on releases only vitals, and a third with
// every flag off answers exactly as before the release.
// Synthetic accounts and records only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { childOutboxLine, enrollmentCodeOutbox, fetchTransport, readChildOutbox, staffClient,
  SYNTHETIC_STAFF_MFA_KEY_B64 } from '../../identity-api/scripts/staff-session-client.mjs';

const ORIGIN = 'https://staging.healthidentitydirectory.com';
// EHR's local-secret workload credential, generated for this run only.
const ehrWorkloadCredential = `${randomUUID()}${randomUUID()}`;
const identityService = resolve(import.meta.dirname, '../../identity-api');
const RELEASE_FLAGS = ['EHR_PATIENT_RELEASE_VITALS', 'EHR_PATIENT_RELEASE_DIAGNOSES',
  'EHR_PATIENT_RELEASE_PRESCRIPTIONS', 'EHR_PATIENT_RELEASE_LAB_RESULTS', 'EHR_PATIENT_RELEASE_DOCUMENTS'];

/**
 * A copy of the owned synthetic rehearsal database, on the rehearsal's private
 * socket-only cluster, dropped by close(). `url(role)` connects as the
 * rehearsal admin and starts every session as `role` (the libpq startup
 * option), as a login of that role would.
 */
async function disposableDatabase(require) {
  const socket = process.env.PGHOST;
  assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
    && process.env.PGDATABASE === 'hid_rehearsal' && process.env.PGUSER,
  'Only the owned synthetic rehearsal is supported');
  const { Client, Pool } = require('pg');
  const admin = process.env.PGUSER;
  const name = `hid_rehearsal_release_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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

/**
 * The service's real AppModule, loaded with ts-node and served on 127.0.0.1
 * with its main.ts request pipeline (global prefix, caching headers, cookie
 * and JSON body parsers, validation pipe, problem filter). CORS and helmet
 * only set browser response headers and are left out.
 */
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

/** The document object store, recording each call; `integrity` changes what the stored object reports. */
function recordingStorage(stored) {
  const calls = [];
  const state = { integrity: {} };
  return { calls, state, provider: {
    bucket: () => 'synthetic-release-bucket',
    checkReadiness: async () => undefined,
    createUpload: async () => { throw new Error('No upload in the release verifier'); },
    inspect: async () => { throw new Error('No upload completion in the release verifier'); },
    inspectVersion: async (key, versionId) => {
      calls.push(['inspectVersion', key, versionId]);
      const object = stored.get(key);
      assert(object, `inspectVersion of an object the fixture does not hold: ${key}`);
      return { versionId, sizeBytes: object.sizeBytes, mediaType: object.mediaType, sha256Hex: object.sha256Hex,
        ...state.integrity };
    },
    createDownload: async (key, versionId, attachment) => {
      calls.push(['createDownload', key, versionId, attachment]);
      return { url: `https://signed.example.invalid/${encodeURIComponent(key)}?version=${encodeURIComponent(versionId)}`,
        expiresInSeconds: 60 };
    },
  } };
}

if (process.argv[2] === '--identity-child') {
  // Child: the Identity API, alone in its process so its environment is its own.
  // A staff enrolment code (MFA-1) is reported on stdout instead of being sent.
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
    const password = 'Synthetic-Release-Password-2026';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const id = () => randomUUID();
    const ids = { org: id(), facility: id(), doctorAccount: id(), doctor: id(), membership: id(), patientAccount: id(),
      patient: id(), otherAccount: id(), other: id(), completed: id(), open: id(), otherEncounter: id() };
    const doctorEmail = `release-doctor-${ids.doctorAccount}@example.invalid`;
    const patientEmail = `release-patient-${ids.patientAccount}@example.invalid`;
    const { owner } = database;
    await owner.query("insert into identity.organizations(id,name,slug) values($1,'Release Rehearsal Org',$2)",
      [ids.org, `release-${ids.org}`]);
    await owner.query(`insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
      values($1,$2,'Release Rehearsal Hospital',$3,'Africa/Lagos',true,'verified')`,
    [ids.facility, ids.org, `REL-${ids.facility.slice(0, 6)}`]);
    await owner.query(`insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm)
      values($1,$2,$3,'Synthetic release doctor','active',$4,'argon2id')`,
    [ids.doctorAccount, `synthetic:release-doctor:${ids.doctorAccount}`, doctorEmail, passwordHash]);
    await owner.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
      values($1,$2,'Synthetic release doctor',$3,'verified','doctor')`, [ids.doctor, ids.doctorAccount, doctorEmail]);
    await owner.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,
      membership_role,app_role,is_primary,active) values($1,$2,$3,$4,$5,'doctor','doctor',true,true)`,
    [ids.membership, ids.doctor, ids.doctorAccount, ids.org, ids.facility]);
    await owner.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
      values($1,$2,'doctor','facility',$3,$4,'Synthetic rehearsal role')`,
    [id(), ids.doctorAccount, ids.membership, ids.facility]);
    for (const [account, patientId, email, hid, name] of [
      [ids.patientAccount, ids.patient, patientEmail, 'HID-RELEASEA', 'Ada Release'],
      [ids.otherAccount, ids.other, `release-other-${ids.otherAccount}@example.invalid`, 'HID-RELEASEB', 'Bayo Release']]) {
      await owner.query(`insert into auth.accounts(id,subject,email,display_name,status,password_hash,password_algorithm)
        values($1,$2,$3,$4,'active',$5,'argon2id')`, [account, `synthetic:release-patient:${account}`, email, name,
        passwordHash]);
      await owner.query(`insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
        values($1,$2,$3,$4,'Release',$5,'active')`, [patientId, account, hid, name.split(' ')[0], name]);
    }

    // Records: a completed and an open encounter of the patient and a
    // completed encounter of another patient; vitals, diagnoses,
    // prescriptions, documents and Lab results in released and withheld
    // states (patient-record-release.integration.sql holds every state).
    const r = { vital: id(), correctedVital: id(), openVital: id(), confirmed: id(), provisional: id(), active: id(),
      draft: id(), clean: id(), rejected: id(), restricted: id(), otherDocument: id(), released: id(),
      correctionPending: id(), invalidated: id() };
    const stored = new Map();
    await database.fixture(async (client) => {
      const staff = [ids.doctorAccount, ids.membership];
      await client.query(`insert into ehr.encounters(id,patient_id,facility_id,created_by,created_by_membership_id,
        encounter_type,status,started_at,ended_at) values
        ($1,$4,$5,$6,$7,'ambulatory','completed',clock_timestamp()-interval '3 hours',clock_timestamp()-interval '2 hours'),
        ($2,$4,$5,$6,$7,'ambulatory','in_progress',clock_timestamp()-interval '1 hour',null),
        ($3,$8,$5,$6,$7,'ambulatory','completed',clock_timestamp()-interval '3 hours',clock_timestamp()-interval '2 hours')`,
      [ids.completed, ids.open, ids.otherEncounter, ids.patient, ids.facility, ...staff, ids.other]);
      await client.query(`insert into ehr.vitals(id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
        recorded_at,systolic_mmhg,diastolic_mmhg,pulse_bpm,temperature_c,current_correction_no) values
        ($1,$4,$6,$7,$8,$9,clock_timestamp()-interval '150 minutes',118,76,64,36.6,0),
        ($2,$4,$6,$7,$8,$9,clock_timestamp()-interval '149 minutes',200,100,90,37.0,1),
        ($3,$5,$6,$7,$8,$9,clock_timestamp()-interval '30 minutes',120,80,70,36.8,0)`,
      [r.vital, r.correctedVital, r.openVital, ids.completed, ids.open, ids.patient, ids.facility, ...staff]);
      await client.query(`insert into ehr.diagnoses(id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
        code_system,code,display,clinical_status,verification_status,notes) values
        ($1,$3,$4,$5,$6,$7,'http://hl7.org/fhir/sid/icd-10','E11','Type 2 diabetes mellitus','active','confirmed',
          'Synthetic clinician note that must stay withheld'),
        ($2,$3,$4,$5,$6,$7,'http://hl7.org/fhir/sid/icd-10','I10','Essential hypertension','active','provisional',null)`,
      [r.confirmed, r.provisional, ids.completed, ids.patient, ids.facility, ...staff]);
      await client.query(`insert into ehr.prescriptions(id,encounter_id,patient_id,facility_id,created_by,
        created_by_membership_id,medication_display,dose_quantity,dose_unit,frequency,instructions,status) values
        ($1,$3,$4,$5,$6,$7,'Metformin 500 mg tablet',1,'tablet','Twice daily','Take with food','active'),
        ($2,$3,$4,$5,$6,$7,'Synthetic draft medication',null,null,'Once daily','Synthetic draft','draft')`,
      [r.active, r.draft, ids.completed, ids.patient, ids.facility, ...staff]);
      const documents = [[r.clean, ids.patient, 'phi', 'clean', '1'], [r.rejected, ids.patient, 'phi', 'rejected', '2'],
        [r.restricted, ids.patient, 'restricted', 'clean', '3'], [r.otherDocument, ids.other, 'phi', 'clean', '4']];
      for (const [documentId, patientId, classification, scan, digit] of documents) {
        const key = `synthetic/release-${documentId}.pdf`;
        stored.set(key, { sizeBytes: 2048, mediaType: 'application/pdf', sha256Hex: digit.repeat(64) });
        await client.query(`insert into ehr.documents(id,encounter_id,patient_id,facility_id,created_by,
          created_by_membership_id,original_file_name,storage_bucket,storage_key,object_version_id,declared_media_type,
          size_bytes,sha256_hex,classification,status,retention_class)
          values($1,$2,$3,$4,$5,$6,$7,'synthetic-release-bucket',$8,$9,'application/pdf',2048,$10,$11,'uploaded',
            'clinical_record')`,
        [documentId, patientId === ids.patient ? ids.completed : ids.otherEncounter, patientId, ids.facility, ...staff,
          `Discharge summary ${digit}.pdf`, key, `release-v-${documentId}`, digit.repeat(64), classification]);
        await client.query(`insert into ehr.document_scan_events(document_id,patient_id,facility_id,created_by,event_type,
          detected_media_type,reason_code,scanner_engine,scanner_version,idempotency_key,correlation_id,object_version_id,
          object_sha256_hex,created_at)
          values($1,$2,$3,$4,$5,$6,$7,'synthetic-scanner','1.0',$8,'release-runtime-scan',$9,$10,
            clock_timestamp()-interval '5 minutes')`,
        [documentId, patientId, ids.facility, ids.doctorAccount, scan, scan === 'clean' ? 'application/pdf' : null,
          scan === 'rejected' ? 'MALWARE_DETECTED' : null, `release-scan-${documentId}`, `release-v-${documentId}`,
          digit.repeat(64)]);
      }
      // Lab: one released revision; a released v1 with an unreleased v2; and a
      // released v1 that was then invalidated.
      const lab = [[r.released, [1], [1], []], [r.correctionPending, [1, 2], [1], []], [r.invalidated, [1], [1], [1]]];
      for (const [index, [resultId, revisions, released, invalidated]] of lab.entries()) {
        const order = id(); const workItem = id(); const test = id(); const execution = id();
        await client.query(`insert into ehr.lab_requests(id,encounter_id,patient_id,facility_id,created_by,
          created_by_membership_id,test_code_system,test_code,test_display,status)
          values($1,$2,$3,$4,$5,$6,'http://loinc.org','2345-7','Glucose','active')`,
        [order, ids.completed, ids.patient, ids.facility, ...staff]);
        await client.query(`insert into lab.work_items(id,patient_id,facility_id,ordering_facility_id,source_ehr_order_id,
          source_ehr_order_version,source_encounter_id,priority,test_code_system,test_code,test_name,clinical_indication,
          requested_by,requested_at,accepted_by,accepted_by_membership_id,idempotency_key,request_sha256,correlation_id)
          values($1,$2,$3,$3,$4,1,$5,'routine','http://loinc.org','2345-7','Glucose','Synthetic indication',$6,
            clock_timestamp()-interval '150 minutes',$6,$7,$8,repeat('a',64),'release-runtime-lab')`,
        [workItem, ids.patient, ids.facility, order, ids.completed, ...staff, `release-work-item-${index}-000000`]);
        await client.query(`insert into lab.work_item_requested_tests(id,work_item_id,facility_id,patient_id,"ordinal",
          code_system,code,name) values($1,$2,$3,$4,1,'http://loinc.org','2345-7','Glucose')`,
        [test, workItem, ids.facility, ids.patient]);
        await client.query(`insert into lab.test_executions(id,accession_id,specimen_id,requested_test_id,patient_id,
          facility_id,status,started_by,started_by_membership_id,started_at,completed_by,completed_by_membership_id,
          completed_at,idempotency_key,request_sha256,correlation_id)
          values($1,$2,$3,$4,$5,$6,'completed',$7,$8,clock_timestamp()-interval '140 minutes',$7,$8,
            clock_timestamp()-interval '130 minutes',$9,repeat('b',64),'release-runtime-lab')`,
        [execution, id(), id(), test, ids.patient, ids.facility, ...staff, `release-execution-${index}-000000`]);
        await client.query(`insert into lab.results(id,execution_id,patient_id,facility_id,current_version,created_by,
          created_by_membership_id) values($1,$2,$3,$4,$5,$6,$7)`,
        [resultId, execution, ids.patient, ids.facility, revisions.length, ...staff]);
        for (const version of revisions) {
          await client.query(`insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,
            result_type,numeric_value,unit,reference_range,abnormal_flag,entered_by,entered_by_membership_id,
            correction_reason,idempotency_key,request_sha256,correlation_id,revision_kind,supersedes_version)
            values($1,$2,$3,$4,$5,'numeric',$6,'mmol/L','3.9-5.5',$7,$8,$9,$10,$11,repeat('c',64),'release-runtime-lab',
              $12,$13)`,
          [resultId, execution, ids.patient, ids.facility, version, version === 1 ? 6.1 : 9.4,
            version === 1 ? 'high' : 'critical_candidate', ...staff, version === 1 ? null : 'Synthetic correction reason',
            `release-revision-${index}-${version}-0000`, version === 1 ? 'original' : 'correction',
            version === 1 ? null : version - 1]);
        }
        for (const version of released) {
          const verification = id();
          await client.query(`insert into lab.result_verifications(id,result_id,execution_id,patient_id,facility_id,
            result_version,verified_by,verified_by_membership_id,verified_at,reason,idempotency_key,request_sha256,
            correlation_id) values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()-interval '120 minutes','Synthetic verification',
            $9,repeat('d',64),'release-runtime-lab')`,
          [verification, resultId, execution, ids.patient, ids.facility, version, ...staff,
            `release-verify-${index}-${version}-00000`]);
          await client.query(`insert into lab.result_releases(verification_id,result_id,execution_id,patient_id,facility_id,
            result_version,released_by,released_by_membership_id,released_at,reason,idempotency_key,request_sha256,
            correlation_id) values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()-interval '110 minutes'+$9*interval '1 minute',
            'Synthetic release reason',$10,repeat('e',64),'release-runtime-lab')`,
          [verification, resultId, execution, ids.patient, ids.facility, version, ...staff, index,
            `release-release-${index}-${version}-00000`]);
        }
        for (const version of invalidated) {
          await client.query(`insert into lab.result_invalidations(result_id,execution_id,patient_id,facility_id,
            result_version,disposition,actor_id,actor_membership_id,reason,idempotency_key,request_sha256,correlation_id)
            values($1,$2,$3,$4,$5,'entered_in_error',$6,$7,'Synthetic invalidation reason',$8,repeat('f',64),
              'release-runtime-lab')`,
          [resultId, execution, ids.patient, ids.facility, version, ...staff, `release-invalidate-${index}-${version}-000`]);
        }
      }
    });

    // Identity in its own process, as its runtime role.
    const shared = { NODE_ENV: 'test', PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8', TZ: 'UTC',
      ...(process.env.PGPORT ? { PGPORT: process.env.PGPORT } : {}),
      CORS_ORIGINS: ORIGIN, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: ehrWorkloadCredential };
    identity = spawn(process.execPath, [import.meta.filename, '--identity-child'], { stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...shared, DATABASE_URL: database.url('hid_identity_api_runtime'), AUTH_MODE: 'local',
        AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET, AUTH_LOGIN_PEPPER: process.env.AUTH_LOGIN_PEPPER,
        OTP_HMAC_KEY_B64: process.env.OTP_HMAC_KEY_B64, AUTH_COOKIE_SECURE: 'true', HID_DEPLOYMENT_ENV: 'staging',
        NIN_PROVIDER_MODE: 'deferred', TURNSTILE_MODE: 'disabled',
        MFA_SECRET_KEY_B64: SYNTHETIC_STAFF_MFA_KEY_B64, MFA_KEY_VERSION: 'release-runtime-v1' } });
    const identityLines = createInterface({ input: identity.stdout });
    const staffEnrollmentCodes = enrollmentCodeOutbox();
    const started = await new Promise((resolveStart, reject) => {
      identityLines.once('line', (line) => resolveStart(JSON.parse(line)));
      identity.once('exit', (code) => reject(new Error(`Identity exited before listening (${code})`)));
    });
    readChildOutbox(identityLines, staffEnrollmentCodes);
    const identityUrl = `${started.url}/api/v1`;

    // EHR in this process, as its runtime role, delegating to that Identity,
    // with every release flag on and the object store replaced.
    const storage = recordingStorage(stored);
    const bootEhr = async (flags) => {
      for (const flag of RELEASE_FLAGS) delete process.env[flag];
      Object.assign(process.env, { ...shared, DATABASE_URL: database.url('hid_ehr_api_runtime'),
        IDENTITY_API_URL: started.url, STORAGE_MODE: 's3', S3_BUCKET: 'synthetic-release-bucket',
        HID_DEPLOYMENT_ENV: 'development', ...Object.fromEntries(flags.map((flag) => [flag, 'true'])) });
      require(join(service, 'src', 'config', 'environment.ts')).resetEnvironmentForTests();
      const booted = await startService({ require, service, override: (builder, load) => builder
        .overrideProvider(load('storage/storage.types.ts').STORAGE_PROVIDER).useValue(storage.provider) });
      const { rows } = await booted.database.query('select current_user as role');
      assert.equal(rows[0].role, 'hid_ehr_api_runtime');
      return { ...booted, base: `${(await booted.app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1` };
    };
    ehr = await bootEhr(RELEASE_FLAGS);

    const call = async (base, method, path, headers = {}, body) => {
      const response = await fetch(`${base}${path}`, { method, headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
    };
    const checks = [];
    // The released relations one patient-self transaction of the EHR reads,
    // under Identity's real patient-self authorization for this cookie; `bind`
    // says whether PatientRecordRelease tells the database its release set.
    const releasedRows = async (booted, cookie, bind) => {
      const identityApi = booted.module.get(booted.load('integrations/identity-api.service.ts').IdentityApiService);
      const release = booted.module.get(booted.load('ehr/patient-records/patient-release.ts').PatientRecordRelease);
      const headers = { cookie, origin: ORIGIN };
      const authorization = await identityApi.authorizeSelf({ correlationId: `release-binding-${randomUUID()}`,
        header: (name) => headers[name.toLowerCase()] });
      return booted.database.withPatientTransaction(authorization, `release-binding-${randomUUID()}`, async (client) => {
        if (bind) await release.bind(client);
        const { rows } = await client.query(`select
            (select count(*)::int from ehr.encounters) as encounters,
            (select count(*)::int from ehr.vitals) as vitals,
            (select count(*)::int from ehr.diagnoses) as diagnoses,
            (select count(*)::int from ehr.prescriptions) as prescriptions,
            (select count(*)::int from ehr.patient_released_lab_results) as lab_results,
            (select count(*)::int from ehr.documents) as documents,
            (select count(*)::int from ehr.document_scan_events) as scan_events,
            current_user as role`);
        return rows[0];
      });
    };
    const signInPatient = async () => {
      const response = await call(identityUrl, 'POST', '/auth/patient/login', { origin: ORIGIN },
        { email: patientEmail, password, turnstileAction: 'patient-login' });
      assert.equal(response.status, 200, `patient sign-in: ${JSON.stringify(response.body)}`);
      return { cookie: response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') };
    };
    const patient = await signInPatient();

    // 1. The patient's own summary with every category released.
    const own = await call(ehr.base, 'GET', '/ehr/me/records', { cookie: patient.cookie });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.deepEqual({ released: own.body.released, withheld: own.body.withheld }, {
      released: ['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'labResults', 'documents'],
      withheld: ['labRequests'] }, 'GET /ehr/me/records does not release exactly the configured categories');
    assert.deepEqual(own.body.encounters.map((item) => item.id), [ids.completed]);
    assert.deepEqual(own.body.vitals.map((item) => item.id), [r.vital],
      'a corrected vital, or a vital of an open encounter, was released (D8, D7)');
    assert.deepEqual(own.body.diagnoses.map((item) => [item.id, item.verificationStatus]), [[r.confirmed, 'confirmed']]);
    assert.equal(Object.hasOwn(own.body.diagnoses[0], 'notes'), false, 'the clinician\'s diagnosis notes reached the patient');
    assert.deepEqual(own.body.prescriptions.map((item) => [item.id, item.status]), [[r.active, 'active']]);
    // sizeBytes is a JSON integer, as on every document answer (A15); pg reads the bigint as text.
    assert.deepEqual(own.body.documents.map((item) => [item.id, item.status, item.scanStatus, item.classification,
      item.sizeBytes]), [[r.clean, 'available', 'clean', 'phi', 2048]],
    'GET /ehr/me/records does not release exactly the clean PHI document, with sizeBytes as an integer (A15)');
    assert.equal(JSON.stringify(own.body.documents).includes('synthetic/release-'), false,
      'the document storage key reached the patient');
    assert.deepEqual(own.body.labResults.map((item) => [item.id, item.version, item.revisionKind, item.numericValue,
      item.abnormalFlag]).sort(), [[r.correctionPending, 1, 'original', 6.1, 'high'], [r.released, 1, 'original', 6.1, 'high']]
      .sort(), 'the released Lab results are not the latest released, not invalidated revisions');
    assert.deepEqual(own.body.labResults[0].test, { codeSystem: 'http://loinc.org', code: '2345-7', name: 'Glucose' });
    assert.equal(JSON.stringify(own.body.labResults).includes('Synthetic correction reason'), false);
    assert.deepEqual(own.body.labRequests, [], 'a lab request reached the patient');
    const summaryAudit = await owner.query(`select details from audit.events
      where action='ehr.patient.self.records.read' and outcome='success' and patient_id=$1`, [ids.patient]);
    assert.deepEqual(summaryAudit.rows.map((row) => row.details), [{ encounterCount: 1, noteCount: 0, vitalCount: 1,
      diagnosisCount: 1, prescriptionCount: 1, labResultCount: 2, documentCount: 1, withheldCategories: ['labRequests'] }]);
    checks.push('with every category flag on, GET /ehr/me/records releases exactly the final uncorrected vital, the confirmed diagnosis without its clinician notes, the active prescription, the latest released and not invalidated Lab result revisions and the clean PHI document of the completed encounter (its sizeBytes an integer, A15), withholds lab requests, and audits counts only');

    // 2. The document download: the released document only, the audit before
    //    the URL, the exact object checked, an attachment signed.
    const downloadPath = (documentId) => `/ehr/me/documents/${documentId}/download`;
    const download = await call(ehr.base, 'GET', downloadPath(r.clean), { cookie: patient.cookie });
    assert.equal(download.status, 200, JSON.stringify(download.body));
    assert.equal(download.body.expiresInSeconds, 60);
    assert.match(download.body.url, /^https:\/\/signed\.example\.invalid\//);
    assert.equal(download.headers.get('cache-control'), 'private, no-store');
    const cleanKey = `synthetic/release-${r.clean}.pdf`;
    assert.deepEqual(storage.calls, [['inspectVersion', cleanKey, `release-v-${r.clean}`],
      ['createDownload', cleanKey, `release-v-${r.clean}`, { fileName: 'Discharge summary 1.pdf', mediaType: 'application/pdf' }]]);
    const downloadAudit = await owner.query(`select resource_type, resource_id::text, purpose_of_use, details from audit.events
      where action='ehr.patient.self.document.download' and outcome='success' and patient_id=$1`, [ids.patient]);
    assert.deepEqual(downloadAudit.rows, [{ resource_type: 'document', resource_id: r.clean, purpose_of_use: 'patient-self',
      details: { mediaType: 'application/pdf', sizeBytes: 2048 } }]);
    storage.calls.length = 0;
    for (const [label, documentId] of [['a rejected document', r.rejected], ['a restricted document', r.restricted],
      ['another patient\'s document', r.otherDocument], ['an unknown document', randomUUID()]]) {
      const refused = await call(ehr.base, 'GET', downloadPath(documentId), { cookie: patient.cookie });
      assert.deepEqual([refused.status, refused.body?.code], [404, 'DOCUMENT_NOT_AVAILABLE'],
        `the download of ${label}: ${JSON.stringify(refused.body)}`);
    }
    assert.deepEqual(storage.calls, [], 'a refused download reached the object store');
    storage.state.integrity = { sha256Hex: '9'.repeat(64) };
    const tampered = await call(ehr.base, 'GET', downloadPath(r.clean), { cookie: patient.cookie });
    assert.deepEqual([tampered.status, tampered.body?.code], [503, 'DOCUMENT_INTEGRITY_UNAVAILABLE']);
    assert.deepEqual(storage.calls.map(([operation]) => operation), ['inspectVersion'],
      'a URL was signed for an object whose checksum differs');
    storage.state.integrity = {};
    storage.calls.length = 0;
    checks.push('GET /ehr/me/documents/:id/download signs a 60 s attachment URL for the released document only after its audit row (counts and identifiers only) and a check of the exact stored version, answers one 404 DOCUMENT_NOT_AVAILABLE for a rejected, restricted, another patient\'s or unknown document without reaching the object store, and signs nothing when the stored checksum differs (503 DOCUMENT_INTEGRITY_UNAVAILABLE)');

    // 3. A staff session is refused both patient routes before a facility is bound.
    const staff = staffClient({ send: fetchTransport(identityUrl), origin: ORIGIN, password, outbox: staffEnrollmentCodes });
    const doctor = await staff.signIn(doctorEmail, { action: 'staff-login' });
    for (const path of ['/ehr/me/records', downloadPath(r.clean)]) {
      const refused = await call(ehr.base, 'GET', path, { cookie: doctor.cookie, 'x-facility-id': ids.facility });
      assert.deepEqual([refused.status, refused.body?.code], [403, 'PATIENT_SESSION_REQUIRED'],
        `a staff session on ${path}: ${JSON.stringify(refused.body)}`);
    }
    assert.deepEqual(storage.calls, []);
    checks.push('an MFA-verified staff session is refused GET /ehr/me/records and the patient document download with 403 PATIENT_SESSION_REQUIRED');

    // 4. D17: Identity's patient-self authorization is for ehr-api only, and
    //    the patient-self context and the view stay out of Lab's reach.
    const asLab = await call(identityUrl, 'GET', '/identity/service/patient-self-authorization', {
      cookie: patient.cookie, 'x-hid-internal-caller': 'lab-api', 'x-hid-service-token': ehrWorkloadCredential });
    assert.deepEqual([asLab.status, asLab.body?.code], [403, 'WORKLOAD_AUTHENTICATION_REQUIRED']);
    const privileges = (await owner.query(`select
        has_function_privilege('hid_lab_api_runtime', 'ehr.patient_self_context(uuid)', 'EXECUTE') as lab_self,
        has_table_privilege('hid_lab_api_runtime', 'ehr.patient_released_lab_results', 'SELECT') as lab_view,
        has_schema_privilege('hid_lab_api_runtime', 'ehr', 'USAGE') as lab_ehr,
        has_table_privilege('hid_ehr_api_runtime', 'ehr.patient_released_lab_results', 'SELECT') as ehr_view,
        (select relowner::regrole::text from pg_class where oid = 'ehr.patient_released_lab_results'::regclass) as owner`))
      .rows[0];
    assert.deepEqual(privileges, { lab_self: false, lab_view: false, lab_ehr: false, ehr_view: true,
      owner: 'hid_lab_release_reader' });
    checks.push('Identity refuses the patient-self authorization to lab-api (403 WORKLOAD_AUTHENTICATION_REQUIRED); the Lab runtime cannot execute ehr.patient_self_context, read the released-results view or use schema ehr, and the view belongs to hid_lab_release_reader');

    // 5. The database follows the flags. Every flag is on in this boot: a
    //    patient-self transaction that names no category reads only the
    //    completed encounter (the binding is live), one bound by
    //    PatientRecordRelease reads every released relation.
    assert.deepEqual(await releasedRows(ehr, patient.cookie, false), { encounters: 1, vitals: 0, diagnoses: 0,
      prescriptions: 0, lab_results: 0, documents: 0, scan_events: 0, role: 'hid_ehr_api_runtime' },
    'a patient-self transaction that names no release category read a released relation');
    assert.deepEqual(await releasedRows(ehr, patient.cookie, true), { encounters: 1, vitals: 1, diagnoses: 1,
      prescriptions: 1, lab_results: 2, documents: 2, scan_events: 2, role: 'hid_ehr_api_runtime' });
    await ehr.close();
    ehr = await bootEhr(['EHR_PATIENT_RELEASE_VITALS']);
    const vitalsOnly = await call(ehr.base, 'GET', '/ehr/me/records', { cookie: patient.cookie });
    assert.equal(vitalsOnly.status, 200, JSON.stringify(vitalsOnly.body));
    assert.deepEqual({ released: vitalsOnly.body.released, withheld: vitalsOnly.body.withheld,
      vitals: vitalsOnly.body.vitals.map((item) => item.id) }, { released: ['encounters', 'notes', 'vitals'],
      withheld: ['diagnoses', 'prescriptions', 'labRequests', 'documents'], vitals: [r.vital] });
    assert.deepEqual(await releasedRows(ehr, patient.cookie, true), { encounters: 1, vitals: 1, diagnoses: 0,
      prescriptions: 0, lab_results: 0, documents: 0, scan_events: 0, role: 'hid_ehr_api_runtime' },
    'the database admitted a category whose flag is off');
    checks.push('the database follows the release flags: in the EHR\'s own patient-self transaction under Identity\'s real authorization, a transaction that names no category (as an EHR build from before the release runs it) reads only the completed encounter, one bound by PatientRecordRelease with every flag on reads every released relation, and with only vitals on GET /ehr/me/records releases only the vital and the database admits no other category');

    // 6. Every flag off: exactly the earlier contract.
    await ehr.close();
    ehr = await bootEhr([]);
    const before = await call(ehr.base, 'GET', '/ehr/me/records', { cookie: patient.cookie });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual(Object.keys(before.body), ['encounters', 'notes', 'vitals', 'diagnoses', 'prescriptions', 'labRequests',
      'documents', 'released', 'withheld', 'limits', 'truncated', 'limit']);
    assert.deepEqual({ released: before.body.released, withheld: before.body.withheld, limits: before.body.limits },
      { released: ['encounters', 'notes'], withheld: ['vitals', 'diagnoses', 'prescriptions', 'labRequests', 'documents'],
        limits: { encounters: 50, notes: 50 } });
    for (const category of ['vitals', 'diagnoses', 'prescriptions', 'labRequests', 'documents']) {
      assert.deepEqual(before.body[category], [], `${category} was released with its flag off`);
    }
    const offDownload = await call(ehr.base, 'GET', downloadPath(r.clean), { cookie: patient.cookie });
    assert.deepEqual([offDownload.status, offDownload.body?.code], [404, 'DOCUMENT_NOT_AVAILABLE']);
    assert.deepEqual(storage.calls, []);
    const offAudit = await owner.query(`select details from audit.events where action='ehr.patient.self.records.read'
      and outcome='success' and patient_id=$1 order by occurred_at desc limit 1`, [ids.patient]);
    assert.deepEqual(offAudit.rows[0].details, { encounterCount: 1, noteCount: 0,
      withheldCategories: ['vitals', 'diagnoses', 'prescriptions', 'labRequests', 'documents'] });
    assert.deepEqual(await releasedRows(ehr, patient.cookie, true), { encounters: 1, vitals: 0, diagnoses: 0,
      prescriptions: 0, lab_results: 0, documents: 0, scan_events: 0, role: 'hid_ehr_api_runtime' },
    'with every flag off the database admitted a released category');
    checks.push('with every flag off, GET /ehr/me/records answers and audits exactly as before the release (encounters and notes; the five categories withheld; no Lab results key), the download answers 404 DOCUMENT_NOT_AVAILABLE, and the database admits no released category to the patient-self transaction');

    process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'local-synthetic-only',
      roles: ['hid_ehr_api_runtime', 'hid_identity_api_runtime'], checks })}\n`);
  } finally {
    await ehr?.close();
    if (identity) {
      identity.stdin.end();
      await new Promise((resolveExit) => identity.exitCode !== null ? resolveExit() : identity.once('exit', resolveExit));
    }
    await database.close();
  }
}
