#!/usr/bin/env node
// Phase 4 Stage 9: OCR validation, patient confirmation and publication through
// the real OCR API (guard, controllers, service, DatabaseService, audit) as
// hid_ocr_api_runtime, on a disposable copy of the owned synthetic rehearsal.
// Before Stage 9 all three failed with 42501: their replay lookups locked
// insert-only validations and confirmations, and a publication request locked
// its validation, rows the runtime role cannot update. The commands now lock
// only the OCR job, which the role updates. The Identity, EHR and Lab APIs are
// replaced by local fakes (the document source, authorization decisions and the
// Lab import of a publication); every database check (row-level security, the
// 0076/0077 guards, immutability triggers, unique constraints) is real. The
// OCR worker is not run: each job starts with its extraction already stored.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { disposableDatabase, expectStatus, fakeService, startService } from '../../../scripts/service-runtime-harness.mjs';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const RUNTIME_ROLE = 'hid_ocr_api_runtime';
const TOKENS = { identity: 'public-synthetic-identity-ocr-token-000001', ehr: 'public-synthetic-ehr-ocr-token-0000000001',
  lab: 'public-synthetic-lab-ocr-token-0000000001', pharmacy: 'public-synthetic-pharmacy-ocr-token-00001' };
const evidence = { runAs: RUNTIME_ROLE, database: 'disposable copy of hid_rehearsal', checks: [] };
const check = (name) => evidence.checks.push(name);

const id = () => randomUUID();
const f = { org: id(), facility: id(), otherFacility: id(), patient: id(), otherPatient: id(), document: id(),
  a: { account: id(), staff: id(), membership: id() }, c: { account: id(), staff: id(), membership: id() },
  jobs: Array.from({ length: 6 }, () => ({ job: id(), extraction: id() })) };
f.a.subject = `synthetic:ocr-verifier-a:${f.a.account}`;
f.c.subject = `synthetic:ocr-verifier-c:${f.c.account}`;

// One fake for Identity, EHR and Lab, routed by path.
const actors = new Map();
const decisions = new Map();
const labImports = [];
const labRejections = [];
let labUnavailable = false;
let labRejects = false;
// Holds the next upstream call that `matches` until released, so a race can
// start while the OCR API has no transaction open.
let pause;
const pauseAt = (matches) => {
  let arrived;
  let release;
  const reached = new Promise((resolve) => { arrived = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  pause = { matches, arrived, gate };
  return { reached, release };
};
const upstream = await fakeService(async (call) => {
  const { method, path, headers, body } = call;
  if (pause?.matches(call)) {
    const held = pause;
    pause = undefined;
    held.arrived();
    await held.gate;
  }
  if (path.startsWith('/api/v1/auth/') || path.startsWith('/api/v1/identity/')) {
    if (headers['x-hid-internal-caller'] !== 'ocr-api' || headers['x-hid-service-token'] !== TOKENS.identity) {
      return [401, { code: 'WORKLOAD_AUTHENTICATION_REQUIRED', detail: 'Synthetic Identity refused the workload' }];
    }
    const actor = actors.get(String(headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!actor) return [401, { code: 'AUTHENTICATION_REQUIRED', detail: 'Unknown synthetic session' }];
    if (path === '/api/v1/auth/service-session') return [200, { actor }];
    if (path === '/api/v1/identity/service/authorization/check') {
      const facilityId = headers['x-facility-id'];
      const rule = decisions.get(`${actor.accountId}:${body.patientId}:${body.scope}`) ?? { allowed: false, breakGlass: false };
      return [200, { allowed: rule.allowed, patientId: body.patientId, facilityId,
        membershipId: actor.facilities.find((item) => item.id === facilityId)?.membershipId ?? '',
        scope: body.scope, purpose: body.purpose, breakGlass: rule.breakGlass }];
    }
  }
  if (method === 'GET' && path === `/api/v1/ehr/internal/ocr/documents/${f.document}/source`) {
    if (headers['x-hid-service-token'] !== TOKENS.ehr) return [401, { code: 'INTERNAL_SERVICE_AUTH_REQUIRED' }];
    return [200, { id: f.document, patientId: f.patient, facilityId: f.facility, objectVersionId: 'ocr-verifier-v1',
      sha256Hex: '1'.repeat(64), status: 'uploaded', scanStatus: 'clean' }];
  }
  if (method === 'POST' && path === '/api/v1/lab/imports/from-ocr') {
    if (headers['x-hid-service-token'] !== TOKENS.lab) return [401, { code: 'INTERNAL_SERVICE_AUTH_REQUIRED' }];
    if (labUnavailable) return [503, { code: 'LAB_IMPORT_UNAVAILABLE', detail: 'Synthetic Lab outage' }];
    if (labRejects) {
      labRejections.push(body);
      return [422, { code: 'LAB_IMPORT_REJECTED', detail: 'Synthetic Lab rejection' }];
    }
    labImports.push(body);
    return [201, { id: `00000000-0000-4000-8000-${String(labImports.length).padStart(12, '0')}`, status: 'created', version: 1 }];
  }
  return [404, { code: 'NOT_FOUND' }];
});

const database = await disposableDatabase(require, 'ocr');
for (const key of Object.keys(process.env)) if (/^(OCR|IDENTITY|EHR|LAB|PHARMACY)_/.test(key)) delete process.env[key];
Object.assign(process.env, { DATABASE_URL: database.url(RUNTIME_ROLE), DATABASE_POOL_MAX: '8',
  IDENTITY_API_URL: upstream.url, EHR_API_URL: upstream.url, LAB_API_URL: upstream.url, PHARMACY_API_URL: upstream.url,
  IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', EHR_SERVICE_IDENTITY_MODE: 'local-secret',
  LAB_SERVICE_IDENTITY_MODE: 'local-secret', PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: TOKENS.identity, EHR_INTERNAL_SERVICE_TOKEN: TOKENS.ehr,
  LAB_INTERNAL_SERVICE_TOKEN: TOKENS.lab, PHARMACY_INTERNAL_SERVICE_TOKEN: TOKENS.pharmacy });
let ocr;
try {
  await database.fixture(async (client) => {
    await client.query('insert into identity.organizations (id,name,slug) values ($1,$2,$3)',
      [f.org, 'OCR Verifier Org', `ocr-verifier-${f.org.slice(0, 8)}`]);
    for (const [facility, code] of [[f.facility, 'OV1'], [f.otherFacility, 'OV2']]) {
      await client.query(`insert into identity.facilities (id,organization_id,name,code,timezone,active,lifecycle_status)
        values ($1,$2,$3,$4,'Africa/Lagos',true,'verified')`, [facility, f.org, `OCR Verifier ${code}`, `${code}-${facility.slice(0, 8)}`]);
    }
    for (const [name, member, facility] of [['a', f.a, f.facility], ['c', f.c, f.otherFacility]]) {
      await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,$4,'active')`,
        [member.account, member.subject, `ocr-verifier-${name}-${member.account}@example.invalid`, `OCR Verifier ${name}`]);
      await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
        values ($1,$2,$3,$4,'verified','doctor')`, [member.staff, member.account, `OCR Verifier ${name}`,
        `ocr-verifier-${name}-${member.account}@example.invalid`]);
      await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
        membership_role,app_role) values ($1,$2,$3,$4,$5,'doctor','doctor')`, [member.membership, member.staff, member.account, f.org, facility]);
    }
    for (const [patient, hid] of [[f.patient, 'HID-CRVRFYAA'], [f.otherPatient, 'HID-CRVRFYBB']]) {
      await client.query(`insert into identity.patients (id,hid_code,first_name,last_name,full_name,status)
        values ($1,$2,'Verifier','Patient','Verifier Patient','active')`, [patient, hid]);
    }
    await client.query(`insert into ehr.documents (id,patient_id,facility_id,created_by,created_by_membership_id,original_file_name,
      storage_bucket,storage_key,object_version_id,declared_media_type,size_bytes,sha256_hex,status,retention_class)
      values ($1,$2,$3,$4,$5,'ocr-verifier.pdf','synthetic-bucket','synthetic/ocr-verifier.pdf','ocr-verifier-v1',
      'application/pdf',1024,repeat('1',64),'uploaded','clinical_record')`, [f.document, f.patient, f.facility, f.a.account, f.a.membership]);
    await client.query(`insert into ehr.document_scan_events (document_id,patient_id,facility_id,created_by,event_type,
      detected_media_type,scanner_engine,scanner_version,idempotency_key,correlation_id,object_version_id,object_sha256_hex,created_at)
      values ($1,$2,$3,$4,'clean','application/pdf','synthetic-scanner','1.0',$5,'ocr-verifier-scan','ocr-verifier-v1',
      repeat('1',64),clock_timestamp()-interval '5 minutes')`, [f.document, f.patient, f.facility, f.a.account, `ocr-verifier-scan-${f.document}`]);
    // Every job awaits validation, with its extraction stored by the worker.
    for (const [index, item] of f.jobs.entries()) {
      await client.query(`insert into ocr.jobs (id,facility_id,document_id,source_object_version_id,source_sha256_hex,idempotency_key,
        request_sha256,provider,max_attempts,created_by,created_by_membership_id,correlation_id,status,attempt_count)
        values ($1,$2,$3,'ocr-verifier-v1',repeat('1',64),$4,repeat('a',64),'synthetic-provider',3,$5,$6,'ocr-verifier-fixture',
        'awaiting_validation',1)`, [item.job, f.facility, f.document, `ocr-verifier-job-${index}-${item.job}`, f.a.account, f.a.membership]);
      await client.query(`insert into ocr.extractions (id,job_id,facility_id,document_id,extraction_version,attempt_no,provider,
        provider_model,provider_result_key,content_sha256,source_object_version_id,source_sha256_hex,provenance)
        values ($1,$2,$3,$4,1,1,'synthetic-provider','synthetic-model',$5,repeat('c',64),'ocr-verifier-v1',repeat('1',64),'{}'::jsonb)`,
      [item.extraction, item.job, f.facility, f.document, `ocr-verifier-result-${item.extraction}`]);
    }
  });
  const permissions = ['ocr.job.read', 'ocr.job.write', 'ocr.validation.write', 'ocr.patient.confirm', 'ocr.publication.write'];
  const actor = (member, facility, granted) => ({ id: member.account, subject: member.subject, accountId: member.account,
    sessionId: id(), roles: [], permissions: [], facilityIds: [facility], authenticationMethod: 'local',
    facilities: [{ id: facility, membershipId: member.membership, organizationId: f.org, name: 'OCR Verifier',
      roles: ['doctor'], permissions: granted, isPrimary: true }] });
  actors.set('token-a', actor(f.a, f.facility, permissions));
  actors.set('token-a-read-only', actor(f.a, f.facility, ['ocr.job.read']));
  actors.set('token-c', actor(f.c, f.otherFacility, permissions));
  const decide = (member, patient, scope, rule) => decisions.set(`${member.account}:${patient}:${scope}`, rule);
  for (const member of [f.a, f.c]) for (const scope of ['read_records', 'write_records']) {
    decide(member, f.patient, scope, { allowed: true, breakGlass: false });
  }

  ocr = await startService({ require, service });
  assert.deepEqual((await ocr.database.query('select current_user as role')).rows[0], { role: RUNTIME_ROLE });
  check('the API runs as hid_ocr_api_runtime');
  const send = (path, body, { token = 'token-a', key, purpose = 'healthcare-operations', facility = f.facility, correlationId } = {}) =>
    ocr.request('POST', `/ocr${path}`, { body, correlationId, headers: { authorization: `Bearer ${token}`, 'x-facility-id': facility,
      'x-purpose-of-use': purpose, ...(key ? { 'idempotency-key': key } : {}) } });
  const key = (label) => `verifier-${label}-${id()}`;
  const count = (sql, values) => database.count(sql, values);
  const together = (size, request) => Promise.all(Array.from({ length: size }, request));
  const job = async (jobId) => (await database.owner.query('select status, row_version::int as version from ocr.jobs where id=$1', [jobId])).rows[0];
  const validationBody = (extractionId, overrides = {}) => ({ extractionId, expectedVersion: 1, validatedPayload: { note: 'Synthetic' },
    disposition: 'validated', targetDomain: 'DOCUMENT_ONLY', candidateType: 'document_only', acceptedFields: {},
    rejectedFields: [], corrections: [], reason: 'Synthetic reviewer validated the document', purpose: 'healthcare-operations', ...overrides });
  const [j1, j2, j3, j4] = f.jobs;

  // Validate an extraction.
  assert.equal(expectStatus(await send(`/jobs/${j1.job}/validation`, validationBody(j1.extraction), { token: 'token-a-read-only', key: key('validate') }),
    403, 'validate without the permission').code, 'PERMISSION_DENIED');
  assert.equal(expectStatus(await send(`/jobs/${j1.job}/validation`, validationBody(j1.extraction), { token: 'token-c', facility: f.otherFacility,
    key: key('validate') }), 404, 'validate from another facility').code, 'OCR_JOB_NOT_FOUND');
  decide(f.a, f.patient, 'write_records', { allowed: false, breakGlass: false });
  assert.equal(expectStatus(await send(`/jobs/${j1.job}/validation`, validationBody(j1.extraction), { key: key('validate') }),
    404, 'validate refused by Identity').code, 'OCR_JOB_NOT_FOUND');
  decide(f.a, f.patient, 'write_records', { allowed: true, breakGlass: false });
  assert.equal(expectStatus(await send(`/jobs/${j1.job}/validation`, validationBody(j1.extraction, { expectedVersion: 2 }), { key: key('validate') }),
    412, 'validate at a stale version').code, 'OCR_VERSION_CONFLICT');
  assert.deepEqual([await job(j1.job), await count('select count(*) from ocr.validations where job_id=$1', [j1.job])],
    [{ status: 'awaiting_validation', version: 1 }, 0]);
  check('validate: missing permission 403, other facility 404 (row-level security), Identity denial 404, stale version 412, nothing written');
  const validateKey = key('validate');
  const validations = await together(4, () => send(`/jobs/${j1.job}/validation`, validationBody(j1.extraction), { key: validateKey }));
  for (const response of validations) expectStatus(response, 201, 'four concurrent identical validations');
  assert.equal(new Set(validations.map((response) => response.body.validationId ?? response.body.id)).size, 1,
    JSON.stringify(validations.map((response) => response.body)));
  const validationId = (await database.owner.query('select id::text from ocr.validations where job_id=$1', [j1.job])).rows.map((row) => row.id);
  assert.equal(validationId.length, 1);
  assert.deepEqual(await job(j1.job), { status: 'validated', version: 2 });
  assert.equal(await count("select count(*) from ocr.job_events where job_id=$1 and to_status='validated'", [j1.job]), 1);
  expectStatus(await send(`/jobs/${j1.job}/validation`, validationBody(j1.extraction), { key: validateKey }), 201, 'validation replay');
  assert.equal(expectStatus(await send(`/jobs/${j1.job}/validation`, validationBody(j1.extraction, { reason: 'A different synthetic review' }),
    { key: validateKey }), 409, 'validation key reuse').code, 'IDEMPOTENCY_CONFLICT');
  const rivals = await Promise.all(['First rival review', 'Second rival review'].map((reason) =>
    send(`/jobs/${j2.job}/validation`, validationBody(j2.extraction, { reason }), { key: key('rival') })));
  assert.deepEqual(rivals.map((response) => response.status).sort(), [201, 412],
    JSON.stringify(rivals.map((response) => [response.status, response.body?.code, response.sqlstate])));
  assert.equal(await count('select count(*) from ocr.validations where job_id=$1', [j2.job]), 1);
  check('validate: four concurrent identical requests validate once and all return it; replay 201; key reuse 409; two different reviews 201 and 412');

  // Rollback: the job event written by the job update fails after the validation insert.
  await database.owner.query(`create function public.verifier_fail_job_event() returns trigger language plpgsql security definer as $f$
    begin if new.correlation_id = 'verifier-rollback-ocr-0001' then
      raise exception using errcode = 'P0001', message = 'Synthetic job event failure'; end if; return new; end $f$`);
  await database.owner.query(`create trigger verifier_fail_job_event before insert on ocr.job_events
    for each row execute function public.verifier_fail_job_event()`);
  const rollbackKey = key('rollback');
  const failed = await send(`/jobs/${j3.job}/validation`, validationBody(j3.extraction), { key: rollbackKey, correlationId: 'verifier-rollback-ocr-0001' });
  expectStatus(failed, 500, 'validation with a failing job event');
  assert.equal(failed.sqlstate, 'P0001');
  assert.deepEqual([await job(j3.job), await count('select count(*) from ocr.validations where job_id=$1', [j3.job]),
    await count("select count(*) from audit.events where correlation_id='verifier-rollback-ocr-0001' and action='ocr.validation.accept'")],
  [{ status: 'awaiting_validation', version: 1 }, 0, 0]);
  expectStatus(await send(`/jobs/${j3.job}/validation`, validationBody(j3.extraction), { key: rollbackKey }), 201, 'validation after the failure');
  check('validate: a failure after the validation insert rolls back the validation, job update and audit; the same key then succeeds');

  // Confirm the patient of a validated job.
  const confirmBody = (overrides = {}) => ({ patientId: f.patient, expectedJobVersion: 2, method: 'source_document',
    reason: 'Confirmed against the governed source document', purpose: 'healthcare-operations', ...overrides });
  assert.equal(expectStatus(await send(`/jobs/${j1.job}/patient-confirmation`, confirmBody({ patientId: f.otherPatient }), { key: key('confirm') }),
    409, 'confirm another patient').code, 'OCR_PATIENT_MISMATCH');
  assert.equal(expectStatus(await send(`/jobs/${j1.job}/patient-confirmation`, confirmBody({ expectedJobVersion: 1 }), { key: key('confirm') }),
    412, 'confirm at a stale job version').code, 'OCR_VERSION_CONFLICT');
  assert.equal(expectStatus(await send(`/jobs/${j1.job}/patient-confirmation`, confirmBody(), { token: 'token-c', facility: f.otherFacility,
    key: key('confirm') }), 404, 'confirm from another facility').code, 'OCR_JOB_NOT_FOUND');
  assert.equal(await count('select count(*) from ocr.patient_confirmations where job_id=$1', [j1.job]), 0);
  check('confirm: another patient 409, stale job version 412, other facility 404, nothing written');
  const confirmKey = key('confirm');
  const confirmations = await together(4, () => send(`/jobs/${j1.job}/patient-confirmation`, confirmBody(), { key: confirmKey }));
  for (const response of confirmations) expectStatus(response, 201, 'four concurrent identical confirmations');
  assert.equal(new Set(confirmations.map((response) => response.body.id)).size, 1);
  const confirmationId = confirmations[0].body.id;
  assert.deepEqual(await Promise.all([count('select count(*) from ocr.patient_confirmations where job_id=$1', [j1.job]),
    count("select count(*) from ocr.outbox_events where aggregate_id=$1 and event_type='OcrPatientConfirmed'", [j1.job])]), [1, 1]);
  assert.equal(expectStatus(await send(`/jobs/${j1.job}/patient-confirmation`, confirmBody({ reason: 'A second synthetic confirmation' }),
    { key: key('confirm') }), 409, 'a second confirmation of one job version').code, 'OCR_PATIENT_ALREADY_CONFIRMED');
  check('confirm: four concurrent identical requests confirm once (one outbox event) and all return it; a second confirmation 409');

  // Publish the validated document: concurrent requests publish it once.
  const publicationBody = { validationVersion: 1, patientConfirmationId: confirmationId, targetOperation: 'retain_validated_document',
    purpose: 'direct-care' };
  const v1 = validationId[0];
  assert.equal(expectStatus(await send(`/validations/${v1}/publications`, publicationBody, { token: 'token-a-read-only', key: key('publish'),
    purpose: 'direct-care' }), 403, 'publish without the permission').code, 'PERMISSION_DENIED');
  assert.equal(expectStatus(await send(`/validations/${v1}/publications`, { ...publicationBody, validationVersion: 2 },
    { key: key('publish'), purpose: 'direct-care' }), 412, 'publish a stale validation version').code, 'OCR_VALIDATION_VERSION_CONFLICT');
  assert.equal(expectStatus(await send(`/validations/${v1}/publications`, { ...publicationBody, patientConfirmationId: id() },
    { key: key('publish'), purpose: 'direct-care' }), 409, 'publish without a current confirmation').code, 'OCR_PATIENT_UNCONFIRMED');
  assert.equal(await count('select count(*) from ocr.publications where validation_id=$1', [v1]), 0);
  check('publish: missing permission 403, stale validation version 412, no current confirmation 409, nothing written');
  const publishKey = key('publish');
  const publications = await together(4, () => send(`/validations/${v1}/publications`, publicationBody, { key: publishKey, purpose: 'direct-care' }));
  const published = publications.filter((response) => [200, 201].includes(response.status));
  assert(published.length >= 1 && publications.every((response) => [200, 201].includes(response.status)
    || response.body?.code === 'OCR_PUBLICATION_IN_PROGRESS'), JSON.stringify(publications.map((r) => [r.status, r.body?.code, r.sqlstate])));
  assert.equal(new Set(published.map((response) => response.body.id)).size, 1);
  assert.deepEqual(await Promise.all([count('select count(*) from ocr.publications where validation_id=$1', [v1]),
    count("select count(*) from ocr.publications where validation_id=$1 and status='published'", [v1])]), [1, 1]);
  const replayed = expectStatus(await send(`/validations/${v1}/publications`, publicationBody, { key: publishKey, purpose: 'direct-care' }),
    201, 'publication replay');
  assert.equal(replayed.status, 'published');
  assert.equal(expectStatus(await send(`/validations/${v1}/publications`, publicationBody, { key: key('publish'), purpose: 'direct-care' }),
    409, 'a second publication of one validation').code, 'OCR_ALREADY_PUBLISHED');
  check('publish: four concurrent identical requests create one publication and publish it once (the others replay or answer in progress); replay published; a second publication 409');

  // Lock order (Phase 4 Stage 9). createPublication locks the job, then reaches
  // the publication row: its replay read, or the unique index of its insert
  // when its snapshot predates a concurrent request's publication. The publish
  // and failure transactions of executePublication take the job's key share for
  // their outbox insert. Each check holds one row on a second connection, as the
  // other transaction would, and probes the other row with a lock timeout below
  // PostgreSQL's deadlock timeout: a wait there is the deadlock it would become.
  const holdingRow = async (lockSql, values, race) => {
    const holder = await database.owner.connect();
    const observer = await database.owner.connect();
    try {
      await holder.query('begin');
      await holder.query(lockSql, values);
      const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid;
      const waitedFor = async (settled) => {
        for (let waited = 0; !settled() && waited < 10_000; waited += 50) {
          const blocked = await observer.query('select count(*)::int as count from pg_stat_activity where $1 = any(pg_blocking_pids(pid))', [pid]);
          if (blocked.rows[0].count > 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      };
      const probe = async (sql, probeValues, cycle) => {
        await holder.query("set local lock_timeout = '500ms'");
        await holder.query(sql, probeValues).catch((error) => {
          assert.notEqual(error.code, '55P03', cycle);
          throw error;
        });
      };
      return await race({ waitedFor, probe });
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      observer.release();
    }
  };

  // A replay while a publish transaction holds the publication row.
  let replaySettled = false;
  const { pending: pendingReplay } = await holdingRow('select id from ocr.publications where id=$1 for update', [replayed.id],
    async ({ waitedFor, probe }) => {
      const pending = send(`/validations/${v1}/publications`, publicationBody, { key: publishKey, purpose: 'direct-care' })
        .finally(() => { replaySettled = true; });
      await waitedFor(() => replaySettled);
      assert(replaySettled, 'the replay, holding the job, waited for the publication row');
      await probe('select id from ocr.jobs where id=$1 for key share', [j1.job],
        'the outbox foreign-key lock on the job waited for the replay');
      return { pending };
    });
  assert.equal(expectStatus(await pendingReplay, 201, 'a replay while the publication row is held').status, 'published');
  check('publish: a replay while a publish transaction holds the publication row answers without waiting for it (no deadlock)');

  // A publish transaction while createPublication holds the job: it must wait
  // for the job before it takes the publication row.
  const [, , , , j5] = f.jobs;
  const raceValidation = (await database.owner.query('select id::text from ocr.validations where job_id=$1', [j2.job])).rows[0].id;
  const raceConfirmed = expectStatus(await send(`/jobs/${j2.job}/patient-confirmation`, confirmBody(), { key: key('race-confirm') }),
    201, 'confirm the publish race job');
  let sourceReads = 0;
  const atEvidence = pauseAt(({ method, path }) => method === 'GET' && path.endsWith('/source') && ++sourceReads === 2);
  const publishing = send(`/validations/${raceValidation}/publications`, { ...publicationBody, patientConfirmationId: raceConfirmed.id },
    { key: key('race-publish'), purpose: 'direct-care' });
  await atEvidence.reached;
  const { pending: pendingPublish } = await holdingRow('select id from ocr.jobs where id=$1 for update', [j2.job],
    async ({ waitedFor, probe }) => {
      atEvidence.release();
      assert(await waitedFor(() => false), 'the publish transaction did not wait for the job');
      await probe('select id from ocr.publications where validation_id=$1 for update', [raceValidation],
        'the publish transaction held the publication row while it waited for the job');
      return { pending: publishing };
    });
  assert.equal(expectStatus(await pendingPublish, 201, 'a publication published after the job lock').status, 'published');
  check('publish: while another request holds the job, the publish transaction waits for it before taking the publication row (no deadlock), then publishes');

  // A failure transaction while createPublication holds the job.
  const failValidated = expectStatus(await send(`/jobs/${j5.job}/validation`, validationBody(j5.extraction, { targetDomain: 'LAB',
    candidateType: 'lab_document', acceptedFields: { observations: [{ testName: 'Platelets', value: '250', unit: '10^9/L' }] } }),
  { key: key('race-validate') }), 201, 'validate the failure race job');
  const failConfirmed = expectStatus(await send(`/jobs/${j5.job}/patient-confirmation`, confirmBody(), { key: key('race-confirm') }),
    201, 'confirm the failure race job');
  labUnavailable = true;
  const atLab = pauseAt(({ method, path }) => method === 'POST' && path === '/api/v1/lab/imports/from-ocr');
  const failing = send(`/validations/${failValidated.validationId}/publications`, { ...publicationBody,
    patientConfirmationId: failConfirmed.id, targetOperation: 'create_imported_lab_evidence' }, { key: key('race-fail'), purpose: 'direct-care' });
  await atLab.reached;
  const { pending: pendingFailure } = await holdingRow('select id from ocr.jobs where id=$1 for update', [j5.job],
    async ({ waitedFor, probe }) => {
      atLab.release();
      assert(await waitedFor(() => false), 'the failure transaction did not wait for the job');
      await probe('select id from ocr.publications where validation_id=$1 for update', [failValidated.validationId],
        'the failure transaction held the publication row while it waited for the job');
      return { pending: failing };
    });
  labUnavailable = false;
  assert.equal(expectStatus(await pendingFailure, 503, 'a publication the Lab API refused').code, 'LAB_IMPORT_UNAVAILABLE');
  assert.deepEqual((await database.owner.query('select status, failure_code from ocr.publications where validation_id=$1',
    [failValidated.validationId])).rows, [{ status: 'failed', failure_code: 'LAB_IMPORT_UNAVAILABLE' }]);
  check('publish: while another request holds the job, the failure transaction waits for it before taking the publication row (no deadlock), then records the retryable failure');

  // A resent request whose snapshot predates a terminal failure. It waits for
  // the job, here behind a key share like the failure transaction's own, while
  // the Lab API rejects the first request; its replay read then still shows the
  // publication processing, and the claim must refuse the terminal failure.
  const [, , , , , j6] = f.jobs;
  const within = (promise, message) => Promise.race([promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(message)), 10_000).unref())]);
  const terminalValidated = expectStatus(await send(`/jobs/${j6.job}/validation`, validationBody(j6.extraction, { targetDomain: 'LAB',
    candidateType: 'lab_document', acceptedFields: { observations: [{ testName: 'Glucose', value: '5.4', unit: 'mmol/L' }] } }),
  { key: key('terminal-validate') }), 201, 'validate the terminal race job');
  const terminalConfirmed = expectStatus(await send(`/jobs/${j6.job}/patient-confirmation`, confirmBody(), { key: key('terminal-confirm') }),
    201, 'confirm the terminal race job');
  const terminalRequest = [`/validations/${terminalValidated.validationId}/publications`, { ...publicationBody,
    patientConfirmationId: terminalConfirmed.id, targetOperation: 'create_imported_lab_evidence' },
  { key: key('terminal-publish'), purpose: 'direct-care' }];
  labRejects = true;
  const atRejection = pauseAt(({ method, path }) => method === 'POST' && path === '/api/v1/lab/imports/from-ocr');
  const rejected = send(...terminalRequest);
  await atRejection.reached;
  let resentSettled = false;
  const { resent } = await holdingRow('select id from ocr.jobs where id=$1 for key share', [j6.job],
    async ({ waitedFor }) => {
      const resent = send(...terminalRequest).finally(() => { resentSettled = true; });
      assert(await waitedFor(() => resentSettled), 'the resent request did not wait for the job');
      atRejection.release();
      assert.equal(expectStatus(await within(rejected, 'the failure transaction waited for the job'), 422,
        'a publication the Lab API rejected').code, 'LAB_IMPORT_REJECTED');
      return { resent };
    });
  const resentResponse = await resent;
  labRejects = false;
  assert.equal(expectStatus(resentResponse, 409, 'a resent request after the terminal failure').code, 'OCR_PUBLICATION_TERMINAL');
  assert.equal(labRejections.length, 1, 'the Lab API was asked again after a terminal failure');
  assert.deepEqual((await database.owner.query('select status, failure_code, attempt_count from ocr.publications where validation_id=$1',
    [terminalValidated.validationId])).rows, [{ status: 'failed', failure_code: 'LAB_IMPORT_REJECTED', attempt_count: 1 }]);
  check('publish: a resent request that waited for the job while the Lab API rejected the first one answers 409 terminal and is not sent to the Lab API again');

  // A Lab publication through the fake Lab API: concurrent requests import once.
  const labValidation = validationBody(j4.extraction, { targetDomain: 'LAB', candidateType: 'lab_document',
    acceptedFields: { observations: [{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL' }] } });
  const labValidated = expectStatus(await send(`/jobs/${j4.job}/validation`, labValidation, { key: key('lab-validate') }), 201, 'validate a Lab report');
  const labConfirmed = expectStatus(await send(`/jobs/${j4.job}/patient-confirmation`, confirmBody(), { key: key('lab-confirm') }), 201, 'confirm the Lab report');
  const labKey = key('lab-publish');
  const labPublications = await together(3, () => send(`/validations/${labValidated.validationId}/publications`,
    { ...publicationBody, patientConfirmationId: labConfirmed.id, targetOperation: 'create_imported_lab_evidence' },
    { key: labKey, purpose: 'direct-care' }));
  assert(labPublications.some((response) => response.status === 201) && labPublications.every((response) => response.status === 201
    || response.body?.code === 'OCR_PUBLICATION_IN_PROGRESS'), JSON.stringify(labPublications.map((r) => [r.status, r.body?.code, r.sqlstate])));
  assert.equal(labImports.length, 1, 'the Lab import is requested once');
  assert.equal(await count("select count(*) from ocr.publications where validation_id=$1 and status='published'", [labValidated.validationId]), 1);
  check('publish to Lab: three concurrent identical requests publish once and call the Lab API once');
  await ocr.close();
  ocr = undefined;
  assert.equal(await database.deadlocks(), 0, 'PostgreSQL detected a deadlock during the run');
  check('no deadlock: pg_stat_database reports none for the run, retried commands included');
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...evidence })}\n`);
} finally {
  await ocr?.close();
  await database.close();
  await upstream.close();
}
