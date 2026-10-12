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
  jobs: Array.from({ length: 9 }, () => ({ job: id(), extraction: id() })) };
f.a.subject = `synthetic:ocr-verifier-a:${f.a.account}`;
f.c.subject = `synthetic:ocr-verifier-c:${f.c.account}`;

// One fake for Identity, EHR and Lab, routed by path.
const actors = new Map();
const decisions = new Map();
const labImports = [];
const labRejections = [];
let labUnavailable = false;
let labRejects = false;
// The next Lab import calls refused as an owning service refuses OCR's workload
// credential (every JWT failure, a JWKS fetch failure included).
let labWorkloadRefusals = 0;
// Settles as `promise` does, or rejects with `message` after `ms`. The timer is
// cleared once the race settles, so none outlives it.
const within = (promise, message, ms = 10_000) => {
  let timer;
  const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
// Holds the next upstream call that `matches` until released, so a race can
// start while the OCR API has no transaction open.
let pause;
const pauseAt = (matches) => {
  let arrived;
  let release;
  const reached = new Promise((resolve) => { arrived = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const held = { matches, arrived, gate };
  pause = held;
  // Waits for the held call. The call arrives within milliseconds; if `request`
  // answers or fails first, or the call does not come within `ms`, the run
  // fails, and the pause is cleared and the gate opened so that a late call
  // passes and the cleanup can finish.
  const arrival = async (label, request, ms = 30_000) => {
    const answered = request.then(
      (response) => { throw new Error(`${label}: the request answered ${response.status} ${response.body?.code ?? ''} before the held call`); },
      (error) => { throw new Error(`${label}: the request failed before the held call: ${error?.message}`); });
    try {
      await within(Promise.race([reached, answered]), `${label}: the held call did not come within ${ms / 1000} s`, ms);
    } catch (error) {
      if (pause === held) pause = undefined;
      release();
      throw error;
    }
  };
  return { release, arrival };
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
    if (labWorkloadRefusals > 0) {
      labWorkloadRefusals -= 1;
      return [401, { code: 'INVALID_WORKLOAD_IDENTITY', detail: 'Synthetic workload refusal' }];
    }
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

  // A read takes its purpose from X-Purpose-Of-Use, which the guard does not
  // check: a missing or unknown purpose is the client's error, not a 500.
  for (const [purpose, label] of [[undefined, 'without X-Purpose-Of-Use'], ['treatment', 'with an unknown purpose']]) {
    const read = await ocr.request('GET', `/ocr/jobs/${j1.job}`, { headers: { authorization: 'Bearer token-a',
      'x-facility-id': f.facility, ...(purpose ? { 'x-purpose-of-use': purpose } : {}) } });
    assert.equal(expectStatus(read, 400, `a job read ${label}`).code, 'PURPOSE_OF_USE_REQUIRED');
  }
  assert.deepEqual(await job(j1.job), { status: 'awaiting_validation', version: 1 });
  check('read: a job read without X-Purpose-Of-Use or with an unknown purpose answers 400 PURPOSE_OF_USE_REQUIRED, not 500');

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
  // Publication refuses these candidates as terminal and a validated job cannot
  // be validated again, so validation refuses them before writing anything.
  for (const [overrides, code] of [
    [{ targetDomain: 'EHR', candidateType: 'clinical_note', acceptedFields: {} }, 'OCR_INVALID_CLINICAL_NOTE'],
    [{ targetDomain: 'LAB', candidateType: 'lab_document', acceptedFields: { observations: [{ testName: 'Sodium' }] } },
      'OCR_INVALID_LAB_EVIDENCE'],
  ]) {
    assert.equal(expectStatus(await send(`/jobs/${j1.job}/validation`, validationBody(j1.extraction, overrides),
      { key: key('unpublishable') }), 400, `validate an unpublishable ${overrides.targetDomain} candidate`).code, code);
  }
  assert.deepEqual([await job(j1.job), await count('select count(*) from ocr.validations where job_id=$1', [j1.job])],
    [{ status: 'awaiting_validation', version: 1 }, 0]);
  check('validate: a candidate its publication would refuse (EHR clinical note, Lab observation) 400, nothing written');
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

  // A replay while a publish transaction holds the publication row: the
  // replay, which holds the job, must not wait for that row.
  let replaySettled = false;
  const { pending: pendingReplay } = await holdingRow('select id from ocr.publications where id=$1 for update', [replayed.id],
    async ({ waitedFor }) => {
      const pending = send(`/validations/${v1}/publications`, publicationBody, { key: publishKey, purpose: 'direct-care' })
        .finally(() => { replaySettled = true; });
      await waitedFor(() => replaySettled);
      assert(replaySettled, 'the replay, holding the job, waited for the publication row');
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
  await atEvidence.arrival('the publish race', publishing);
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
  const failRequest = [`/validations/${failValidated.validationId}/publications`, { ...publicationBody,
    patientConfirmationId: failConfirmed.id, targetOperation: 'create_imported_lab_evidence' }, { key: key('race-fail'), purpose: 'direct-care' }];
  const failing = send(...failRequest);
  await atLab.arrival('the failure race', failing);
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
    [failValidated.validationId])).rows, [{ status: 'failed', failure_code: 'OWNING_SERVICE_UNAVAILABLE' }]);
  check('publish: while another request holds the job, the failure transaction waits for it before taking the publication row (no deadlock), then records the retryable failure');

  // Every Lab import request the fake received, held and refused calls
  // included, and those of one publication.
  const labCalls = () => upstream.calls.filter(({ method, path }) => method === 'POST' && path === '/api/v1/lab/imports/from-ocr');
  const labCallsFor = (publicationId) => labCalls().filter(({ body }) => body?.publicationId === publicationId);
  const failedRow = async () => (await database.owner.query(`select id::text, status, failure_code, failure_summary, attempt_count,
      row_version::text, failed_at::text, next_attempt_at::text, processing_token::text
    from ocr.publications where validation_id=$1`, [failValidated.validationId])).rows;
  const [failedBefore] = await failedRow();
  // Two today: the Lab client asks once more after a 503 when it sends a key.
  const outageCalls = labCallsFor(failedBefore.id).length;
  assert(outageCalls >= 1, 'the failed attempt did not reach the Lab API');

  // Before its retry time the same request answers 409 in progress: the stored
  // failure is retryable, so not terminal, and the claim requires
  // next_attempt_at <= clock_timestamp(). The request asks the Lab API nothing,
  // changes neither the publication nor the job, and writes only its request
  // audit. The failure transaction set next_attempt_at 15 s after failed_at;
  // the check requires more than 5 s of it left, so the resend cannot cross it.
  const [{ backoff, remaining }] = (await database.owner.query(`select
      extract(epoch from next_attempt_at - failed_at)::float8 as backoff,
      extract(epoch from next_attempt_at - clock_timestamp())::float8 as remaining
    from ocr.publications where validation_id=$1`, [failValidated.validationId])).rows;
  assert(Math.abs(backoff - 15) < 0.5, `the retry backoff is ${backoff} s, not 15 s`);
  assert(remaining > 5, `only ${remaining} s of the retry backoff were left for the early resend`);
  const [callsBeforeEarly, importsBeforeEarly, jobBeforeEarly] = [labCalls().length, labImports.length, await job(j5.job)];
  const early = `verifier-early-retry-${id()}`;
  assert.equal(expectStatus(await send(failRequest[0], failRequest[1], { ...failRequest[2], correlationId: early }),
    409, 'a resent publication before its retry time').code, 'OCR_PUBLICATION_IN_PROGRESS');
  assert.deepEqual([labCalls().length, labImports.length], [callsBeforeEarly, importsBeforeEarly],
    'the Lab API was asked before the retry time');
  assert.deepEqual(await failedRow(), [failedBefore], 'the early resend changed the publication');
  assert.deepEqual(await job(j5.job), jobBeforeEarly, 'the early resend changed the job');
  assert.deepEqual((await database.owner.query('select action, outcome from audit.events where correlation_id=$1', [early])).rows,
    [{ action: 'api.ocr.publication.create.request', outcome: 'failure' }]);
  assert.equal(await count('select count(*) from ocr.outbox_events where correlation_id=$1', [early]), 0);
  check('publish: before its retry time the same request answers 409 in progress, asks the Lab API nothing and changes neither the publication nor the job');

  // The Lab API is back. Once the retry time has come (moved forward here, with
  // triggers off as for fixtures), the same request claims the publication
  // again and publishes it; a replay of the published publication does not ask
  // the Lab API again (Phase 4 Stage 9 review).
  await database.fixture((client) => client.query(
    'update ocr.publications set next_attempt_at = clock_timestamp() where validation_id=$1', [failValidated.validationId]));
  const importsBeforeRetry = labImports.length;
  assert.equal(expectStatus(await send(...failRequest), 201, 'the resent publication after the Lab outage').status, 'published');
  assert.equal(labCallsFor(failedBefore.id).length, outageCalls + 1, 'the retry did not ask the Lab API exactly once');
  assert.equal(expectStatus(await send(...failRequest), 201, 'a replay of the published publication').status, 'published');
  assert.equal(labCallsFor(failedBefore.id).length, outageCalls + 1, 'the replay asked the Lab API');
  const retriedPublication = (await database.owner.query(
    'select id::text, status, failure_code, attempt_count from ocr.publications where validation_id=$1',
    [failValidated.validationId])).rows;
  assert.deepEqual(retriedPublication.map(({ id: publicationId, status, failure_code, attempt_count }) =>
    ({ publicationId, status, failure_code, attempt_count })),
  [{ publicationId: failedBefore.id, status: 'published', failure_code: null, attempt_count: 2 }]);
  assert.equal(labImports.length, importsBeforeRetry + 1, 'the Lab API imported the retried publication once');
  assert.equal(labImports.at(-1)?.publicationId, retriedPublication[0].id, 'the Lab API imported another publication');
  // Every Lab call of the publication, refused or not, sent its own key and the same body.
  const sentToLab = labCallsFor(failedBefore.id);
  assert.deepEqual([...new Set(sentToLab.map(({ headers }) => headers['idempotency-key']))],
    [`ocr-publication:${failedBefore.id}`], 'a Lab call of the publication sent another idempotency key');
  for (const call of sentToLab) assert.deepEqual(call.body, sentToLab[0].body, 'a Lab call of the publication sent another body');
  check('publish: after a Lab outage the same request publishes on retry, once, every Lab call with the publication\'s own key and body, and a replay does not ask the Lab API again');

  // A resent request whose snapshot predates a terminal failure. It waits for
  // the job, here behind a key share like the failure transaction's own, while
  // the Lab API rejects the first request; its replay read then still shows the
  // publication processing, and the claim must refuse the terminal failure.
  const [, , , , , j6] = f.jobs;
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
  await atRejection.arrival('the terminal race', rejected);
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

  // A stale attempt after its claim expired. The first request's Lab call is
  // held while its claim is moved into the past (triggers off, as for
  // fixtures); a resend then claims the publication again with a new token,
  // and its own Lab call is held. The stale attempt gets its Lab answer first:
  // its publish update and its failure update each require its own processing
  // token, so it answers 409 OCR_PUBLICATION_CLAIM_LOST and changes nothing.
  // The resend then publishes once. Without the token in the failure update the
  // stale attempt would mark the resend's claim failed and emit
  // OcrPublicationFailed; without it in the publish update it would publish
  // under the resend's claim. The fake Lab API does not deduplicate, so it
  // records both imports; the Lab API replays a publication's import by its key.
  const [, , , , , , j7] = f.jobs;
  const staleValidated = expectStatus(await send(`/jobs/${j7.job}/validation`, validationBody(j7.extraction, { targetDomain: 'LAB',
    candidateType: 'lab_document', acceptedFields: { observations: [{ testName: 'Sodium', value: '140', unit: 'mmol/L' }] } }),
  { key: key('stale-validate') }), 201, 'validate the stale claim job');
  const staleConfirmed = expectStatus(await send(`/jobs/${j7.job}/patient-confirmation`, confirmBody(), { key: key('stale-confirm') }),
    201, 'confirm the stale claim job');
  const staleRequest = [`/validations/${staleValidated.validationId}/publications`, { ...publicationBody,
    patientConfirmationId: staleConfirmed.id, targetOperation: 'create_imported_lab_evidence' },
  { key: key('stale-publish'), purpose: 'direct-care' }];
  const staleCorrelation = `verifier-stale-first-${id()}`;
  const freshCorrelation = `verifier-stale-second-${id()}`;
  const labCallOf = (correlationId) => ({ method, path, headers }) => method === 'POST'
    && path === '/api/v1/lab/imports/from-ocr' && headers['x-correlation-id'] === correlationId;
  const staleRow = async () => (await database.owner.query(`select id::text, status, attempt_count, row_version::text,
      processing_token::text, processing_expires_at::text, failure_code, target_resource_id::text
    from ocr.publications where validation_id=$1`, [staleValidated.validationId])).rows;
  const atStale = pauseAt(labCallOf(staleCorrelation));
  let atFresh;
  try {
    const stale = send(staleRequest[0], staleRequest[1], { ...staleRequest[2], correlationId: staleCorrelation });
    await atStale.arrival('the stale attempt', stale);
    const [claimedByStale] = await staleRow();
    assert.deepEqual([claimedByStale.status, claimedByStale.attempt_count], ['processing', 1]);
    assert.equal((await database.fixture((client) => client.query(`update ocr.publications
      set processing_expires_at = clock_timestamp() - interval '1 second' where id=$1 and status='processing'`,
    [claimedByStale.id]))).rowCount, 1);
    atFresh = pauseAt(labCallOf(freshCorrelation));
    const fresh = send(staleRequest[0], staleRequest[1], { ...staleRequest[2], correlationId: freshCorrelation });
    await atFresh.arrival('the resend of the expired attempt', fresh);
    const [claimedByFresh] = await staleRow();
    assert.deepEqual([claimedByFresh.status, claimedByFresh.attempt_count], ['processing', 2],
      'the resend did not claim the expired attempt');
    assert.notEqual(claimedByFresh.processing_token, claimedByStale.processing_token);

    atStale.release();
    assert.equal(expectStatus(await within(stale, 'the stale attempt did not answer'), 409,
      'the stale attempt after the resend claimed the publication').code, 'OCR_PUBLICATION_CLAIM_LOST');
    assert.deepEqual(await staleRow(), [claimedByFresh], 'the stale attempt changed the publication the resend owns');

    atFresh.release();
    const published = expectStatus(await within(fresh, 'the resend did not answer'), 201, 'the resend of the expired attempt');
    assert.deepEqual([published.status, published.attemptCount], ['published', 2]);
    const [final] = await staleRow();
    assert.deepEqual([final.status, final.attempt_count, final.processing_token, final.failure_code, final.target_resource_id],
      ['published', 2, null, null, published.targetResourceId]);
    assert.deepEqual((await database.owner.query(`select event_type, count(*)::int as count from ocr.outbox_events
      where aggregate_id=$1 and event_type like 'OcrPublication%' group by event_type order by event_type`, [j7.job])).rows,
    [{ event_type: 'OcrPublicationRequested', count: 1 }, { event_type: 'OcrPublicationSucceeded', count: 1 }]);
    assert.deepEqual((await database.owner.query(`select action, correlation_id from audit.events
      where correlation_id = any($1::text[]) and action like 'ocr.publication.%' order by action`,
    [[staleCorrelation, freshCorrelation]])).rows,
    [{ action: 'ocr.publication.request', correlation_id: staleCorrelation },
      { action: 'ocr.publication.succeed', correlation_id: freshCorrelation }]);
    const sentToLabForStale = labCallsFor(final.id);
    assert.deepEqual(sentToLabForStale.map(({ headers }) => [headers['x-correlation-id'], headers['idempotency-key']]),
      [[staleCorrelation, `ocr-publication:${final.id}`], [freshCorrelation, `ocr-publication:${final.id}`]]);
  } finally {
    // A held call is let through, so the API can close, whatever failed above.
    pause = undefined;
    atStale.release();
    atFresh?.release();
  }
  check('publish: a stale attempt whose claim expired and was claimed again answers 409 claim lost, changes nothing and emits no failure; the resend publishes once');

  // Retry exhaustion. A Lab outage fails one publication on every permitted
  // attempt; between attempts its retry time is moved forward (triggers off, as
  // for fixtures). The claim takes a failed publication again only while
  // attempt_count < max_attempts, so the failure events of every attempt but the
  // last say retryable: true, and the last one's say retryable: false; the last
  // failure has no backoff. A resend afterwards, with the Lab API back, answers
  // 409 in progress, asks the Lab API nothing and changes nothing.
  const [, , , , , , , j8] = f.jobs;
  const exhaustValidated = expectStatus(await send(`/jobs/${j8.job}/validation`, validationBody(j8.extraction, { targetDomain: 'LAB',
    candidateType: 'lab_document', acceptedFields: { observations: [{ testName: 'Potassium', value: '4.1', unit: 'mmol/L' }] } }),
  { key: key('exhaust-validate') }), 201, 'validate the retry exhaustion job');
  const exhaustConfirmed = expectStatus(await send(`/jobs/${j8.job}/patient-confirmation`, confirmBody(), { key: key('exhaust-confirm') }),
    201, 'confirm the retry exhaustion job');
  const exhaustRequest = [`/validations/${exhaustValidated.validationId}/publications`, { ...publicationBody,
    patientConfirmationId: exhaustConfirmed.id, targetOperation: 'create_imported_lab_evidence' },
  { key: key('exhaust-publish'), purpose: 'direct-care' }];
  const exhaustRow = async () => (await database.owner.query(`select id::text, status, failure_code, attempt_count, max_attempts,
      row_version::text, failed_at::text, next_attempt_at::text,
      extract(epoch from next_attempt_at - failed_at)::float8 as backoff
    from ocr.publications where validation_id=$1`, [exhaustValidated.validationId])).rows;
  const failureEvents = async (correlationId) => ({
    audit: (await database.owner.query(`select details->>'publicationId' as "publicationId",
        details->>'failureCode' as "failureCode", details->>'ownerFailureCode' as "ownerFailureCode",
        (details->>'retryable')::boolean as retryable,
        (select array_agg(name order by name) from jsonb_object_keys(details) as name) as keys
      from audit.events where correlation_id=$1 and action='ocr.publication.fail'`, [correlationId])).rows,
    outbox: (await database.owner.query(`select payload from ocr.outbox_events
      where correlation_id=$1 and event_type='OcrPublicationFailed'`, [correlationId])).rows.map(({ payload }) => payload),
  });
  let exhausted;
  labUnavailable = true;
  try {
    for (let attempt = 1; !exhausted; attempt += 1) {
      const correlationId = `verifier-exhaust-${attempt}-${id()}`;
      const callsBefore = labCalls().length;
      assert.equal(expectStatus(await send(exhaustRequest[0], exhaustRequest[1], { ...exhaustRequest[2], correlationId }),
        503, `attempt ${attempt} of the publication during the Lab outage`).code, 'LAB_IMPORT_UNAVAILABLE');
      assert(labCalls().length > callsBefore, `attempt ${attempt} did not reach the Lab API`);
      const [row] = await exhaustRow();
      assert.equal(row.max_attempts, 3, 'the publication does not have the default budget of three attempts');
      assert.deepEqual([row.status, row.failure_code, row.attempt_count], ['failed', 'OWNING_SERVICE_UNAVAILABLE', attempt],
        `attempt ${attempt} did not store a retryable failure`);
      const last = attempt === row.max_attempts;
      assert.deepEqual(await failureEvents(correlationId), {
        audit: [{ publicationId: row.id, failureCode: 'OWNING_SERVICE_UNAVAILABLE', ownerFailureCode: 'LAB_IMPORT_UNAVAILABLE',
          retryable: !last, keys: ['failureCode', 'ownerFailureCode', 'publicationId', 'retryable'] }],
        outbox: [{ jobId: j8.job, publicationId: row.id, failureCode: 'OWNING_SERVICE_UNAVAILABLE', retryable: !last }],
      }, `the failure events of attempt ${attempt} of ${row.max_attempts}`);
      if (last) {
        assert(row.backoff < 0.5, `the last attempt set its retry time ${row.backoff} s after its failure`);
        exhausted = row;
      } else {
        assert(Math.abs(row.backoff - 15) < 0.5, `attempt ${attempt} set a retry backoff of ${row.backoff} s, not 15 s`);
        assert.equal((await database.fixture((client) => client.query(
          'update ocr.publications set next_attempt_at = clock_timestamp() where id=$1', [row.id]))).rowCount, 1);
      }
    }
  } finally {
    labUnavailable = false;
  }
  const exhaustedCalls = labCallsFor(exhausted.id);
  assert.deepEqual([...new Set(exhaustedCalls.map(({ headers }) => headers['idempotency-key']))],
    [`ocr-publication:${exhausted.id}`], 'a Lab call of the exhausted publication sent another idempotency key');
  for (const call of exhaustedCalls) assert.deepEqual(call.body, exhaustedCalls[0].body, 'a Lab call of the exhausted publication sent another body');
  // Its retry time has passed, so only the attempt budget refuses the resend.
  assert.equal((await database.owner.query('select next_attempt_at <= clock_timestamp() as due from ocr.publications where id=$1',
    [exhausted.id])).rows[0].due, true, 'the exhausted publication is not past its retry time');
  const [callsBeforeResend, importsBeforeResend, jobBeforeResend] = [labCalls().length, labImports.length, await job(j8.job)];
  const exhaustedResend = `verifier-exhausted-resend-${id()}`;
  assert.equal(expectStatus(await send(exhaustRequest[0], exhaustRequest[1], { ...exhaustRequest[2], correlationId: exhaustedResend }),
    409, 'a resend after the last permitted attempt failed').code, 'OCR_PUBLICATION_IN_PROGRESS');
  assert.deepEqual([labCalls().length, labImports.length], [callsBeforeResend, importsBeforeResend],
    'the resend after the last permitted attempt asked the Lab API');
  assert.deepEqual(await exhaustRow(), [exhausted], 'the resend after the last permitted attempt changed the publication');
  assert.deepEqual(await job(j8.job), jobBeforeResend, 'the resend after the last permitted attempt changed the job');
  assert.deepEqual((await database.owner.query('select action, outcome from audit.events where correlation_id=$1', [exhaustedResend])).rows,
    [{ action: 'api.ocr.publication.create.request', outcome: 'failure' }]);
  assert.equal(await count('select count(*) from ocr.outbox_events where correlation_id=$1', [exhaustedResend]), 0);
  check('publish: during a Lab outage the failure events of every attempt but the last say retryable: true and the last one\'s say retryable: false, with no backoff; a later resend answers 409 in progress, asks the Lab API nothing and changes nothing');

  // A Lab refusal of OCR's workload credential is a fault between services, not
  // a rejection of the publication: OCR answers 503 LAB_SERVICE_AUTH_UNAVAILABLE
  // (not the 401 that makes a browser refresh its session) and stores the
  // failure as retryable, so the same request publishes once the Lab API
  // accepts the workload again.
  const [, , , , , , , , j9] = f.jobs;
  const workloadValidated = expectStatus(await send(`/jobs/${j9.job}/validation`, validationBody(j9.extraction, { targetDomain: 'LAB',
    candidateType: 'lab_document', acceptedFields: { observations: [{ testName: 'Chloride', value: '101', unit: 'mmol/L' }] } }),
  { key: key('workload-validate') }), 201, 'validate the workload refusal job');
  const workloadConfirmed = expectStatus(await send(`/jobs/${j9.job}/patient-confirmation`, confirmBody(), { key: key('workload-confirm') }),
    201, 'confirm the workload refusal job');
  const workloadRequest = [`/validations/${workloadValidated.validationId}/publications`, { ...publicationBody,
    patientConfirmationId: workloadConfirmed.id, targetOperation: 'create_imported_lab_evidence' },
  { key: key('workload-publish'), purpose: 'direct-care' }];
  const workloadCorrelation = `verifier-workload-refusal-${id()}`;
  labWorkloadRefusals = 1;
  try {
    assert.equal(expectStatus(await send(workloadRequest[0], workloadRequest[1], { ...workloadRequest[2], correlationId: workloadCorrelation }),
      503, 'a publication whose OCR workload the Lab API refused').code, 'LAB_SERVICE_AUTH_UNAVAILABLE');
  } finally {
    labWorkloadRefusals = 0;
  }
  const [workloadFailed] = (await database.owner.query(`select id::text, status, failure_code, attempt_count,
      extract(epoch from next_attempt_at - failed_at)::float8 as backoff
    from ocr.publications where validation_id=$1`, [workloadValidated.validationId])).rows;
  assert.deepEqual([workloadFailed.status, workloadFailed.failure_code, workloadFailed.attempt_count],
    ['failed', 'OWNING_SERVICE_UNAVAILABLE', 1], 'the Lab workload refusal was not stored as a retryable failure');
  assert(Math.abs(workloadFailed.backoff - 15) < 0.5, `the Lab workload refusal set a retry backoff of ${workloadFailed.backoff} s, not 15 s`);
  assert.deepEqual(await failureEvents(workloadCorrelation), {
    audit: [{ publicationId: workloadFailed.id, failureCode: 'OWNING_SERVICE_UNAVAILABLE',
      ownerFailureCode: 'LAB_SERVICE_AUTH_UNAVAILABLE', retryable: true,
      keys: ['failureCode', 'ownerFailureCode', 'publicationId', 'retryable'] }],
    outbox: [{ jobId: j9.job, publicationId: workloadFailed.id, failureCode: 'OWNING_SERVICE_UNAVAILABLE', retryable: true }],
  }, 'the failure events of the Lab workload refusal');
  assert.equal(labCallsFor(workloadFailed.id).length, 1, 'the refused attempt did not ask the Lab API exactly once');
  await database.fixture((client) => client.query(
    'update ocr.publications set next_attempt_at = clock_timestamp() where id=$1', [workloadFailed.id]));
  const importsBeforeWorkloadRetry = labImports.length;
  assert.equal(expectStatus(await send(...workloadRequest), 201, 'the resent publication after the Lab workload refusal').status,
    'published');
  assert.equal(labImports.length, importsBeforeWorkloadRetry + 1, 'the Lab API did not import the retried publication once');
  assert.deepEqual((await database.owner.query('select status, failure_code, attempt_count from ocr.publications where id=$1',
    [workloadFailed.id])).rows, [{ status: 'published', failure_code: null, attempt_count: 2 }]);
  assert.deepEqual(labCallsFor(workloadFailed.id).map(({ headers }) => headers['idempotency-key']),
    [`ocr-publication:${workloadFailed.id}`, `ocr-publication:${workloadFailed.id}`],
    'a Lab call of the publication sent another idempotency key');
  check('publish: a Lab refusal of the OCR workload credential answers 503 LAB_SERVICE_AUTH_UNAVAILABLE and is stored as retryable; the same request then publishes once with the publication\'s own key');

  // A Lab publication through the fake Lab API: concurrent requests import once.
  const labValidation = validationBody(j4.extraction, { targetDomain: 'LAB', candidateType: 'lab_document',
    acceptedFields: { observations: [{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL' }] } });
  const labValidated = expectStatus(await send(`/jobs/${j4.job}/validation`, labValidation, { key: key('lab-validate') }), 201, 'validate a Lab report');
  const labConfirmed = expectStatus(await send(`/jobs/${j4.job}/patient-confirmation`, confirmBody(), { key: key('lab-confirm') }), 201, 'confirm the Lab report');
  const labKey = key('lab-publish');
  const importsBeforeConcurrent = labImports.length;
  const labPublications = await together(3, () => send(`/validations/${labValidated.validationId}/publications`,
    { ...publicationBody, patientConfirmationId: labConfirmed.id, targetOperation: 'create_imported_lab_evidence' },
    { key: labKey, purpose: 'direct-care' }));
  assert(labPublications.some((response) => response.status === 201) && labPublications.every((response) => response.status === 201
    || response.body?.code === 'OCR_PUBLICATION_IN_PROGRESS'), JSON.stringify(labPublications.map((r) => [r.status, r.body?.code, r.sqlstate])));
  assert.equal(labImports.length - importsBeforeConcurrent, 1, 'the Lab import is requested once');
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
