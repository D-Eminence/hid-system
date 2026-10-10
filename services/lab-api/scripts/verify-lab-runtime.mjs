#!/usr/bin/env node
// Phase 4 Stage 9: the Lab create commands through the real Lab API (guard,
// controllers, services, DatabaseService, audit) as hid_lab_api_runtime, on a
// disposable copy of the owned synthetic rehearsal. Before Stage 9 EHR-order
// acceptance, accession, and Lab evidence import (external and from OCR)
// failed with 42501: their replay lookups locked insert-only rows (work items,
// accessions, imported evidence) that the runtime role cannot update. Only the
// Identity API is replaced, by a local fake; every database check (row-level
// security, the 0077 guards, immutability triggers, unique constraints) is real.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { disposableDatabase, expectStatus, fakeService, startService } from '../../../scripts/service-runtime-harness.mjs';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const RUNTIME_ROLE = 'hid_lab_api_runtime';
const LAB_TOKEN = 'public-synthetic-lab-internal-token-000001';
const IDENTITY_TOKEN = 'public-synthetic-identity-lab-token-000001';
const evidence = { runAs: RUNTIME_ROLE, database: 'disposable copy of hid_rehearsal', checks: [] };
const check = (name) => evidence.checks.push(name);

const actors = new Map();
const decisions = new Map();
const identity = await fakeService(({ path, headers, body }) => {
  if (headers['x-hid-internal-caller'] !== 'lab-api' || headers['x-hid-service-token'] !== IDENTITY_TOKEN) {
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
  return [404, { code: 'NOT_FOUND' }];
});

const database = await disposableDatabase(require, 'lab');
for (const key of Object.keys(process.env)) if (/^(LAB|IDENTITY)_/.test(key)) delete process.env[key];
Object.assign(process.env, { DATABASE_URL: database.url(RUNTIME_ROLE), DATABASE_POOL_MAX: '8',
  IDENTITY_API_URL: identity.url, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: IDENTITY_TOKEN, LAB_SERVICE_IDENTITY_MODE: 'local-secret',
  LAB_INTERNAL_SERVICE_TOKEN: LAB_TOKEN });
let lab;
try {
  const id = () => randomUUID();
  const f = { org: id(), facility: id(), patient: id(), encounter: id(), document: id(),
    a: { account: id(), staff: id(), membership: id() }, b: { account: id(), staff: id(), membership: id() },
    orders: [id(), id(), id()], work: [id(), id(), id()],
    ocr: { job: id(), extraction: id(), validation: id(), confirmation: id(), publication: id() } };
  f.a.subject = `synthetic:lab-verifier-a:${f.a.account}`;
  f.b.subject = `synthetic:lab-verifier-b:${f.b.account}`;
  const requestedAt = '2026-10-01T09:00:00.000Z';
  await database.fixture(async (client) => {
    await client.query('insert into identity.organizations (id,name,slug) values ($1,$2,$3)',
      [f.org, 'Lab Verifier Org', `lab-verifier-${f.org.slice(0, 8)}`]);
    await client.query(`insert into identity.facilities (id,organization_id,name,code,timezone,active,lifecycle_status)
      values ($1,$2,'Lab Verifier Clinic',$3,'Africa/Lagos',true,'verified')`, [f.facility, f.org, `LV-${f.facility.slice(0, 8)}`]);
    for (const [name, member] of [['a', f.a], ['b', f.b]]) {
      await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,$4,'active')`,
        [member.account, member.subject, `lab-verifier-${name}-${member.account}@example.invalid`, `Lab Verifier ${name}`]);
      await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
        values ($1,$2,$3,$4,'verified','lab')`, [member.staff, member.account, `Lab Verifier ${name}`,
        `lab-verifier-${name}-${member.account}@example.invalid`]);
      await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
        membership_role,app_role,active) values ($1,$2,$3,$4,$5,'lab','lab',true)`,
      [member.membership, member.staff, member.account, f.org, f.facility]);
    }
    await client.query(`insert into identity.patients (id,hid_code,first_name,last_name,full_name,status)
      values ($1,'HID-LBVRFYAA','Verifier','Patient','Verifier Patient','active')`, [f.patient]);
    await client.query(`insert into identity.purpose_of_use_codes (code,display,source_system)
      values ('direct-care','Direct patient care','lab-verifier') on conflict (code) do nothing`);
    // Only A holds a database consent grant; B is allowed by the fake Identity only.
    await client.query(`insert into identity.consent_grants (id,patient_id,staff_id,account_id,membership_id,facility_id,scope,
      purpose_of_use,status,reason,starts_at,expires_at) values ($1,$2,$3,$4,$5,$6,'write_records','direct-care','active',
      'Synthetic Lab verifier consent',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days')`,
    [id(), f.patient, f.a.staff, f.a.account, f.a.membership, f.facility]);
    await client.query(`insert into ehr.encounters (id,patient_id,facility_id,created_by,created_by_membership_id,encounter_type,
      status,started_at) values ($1,$2,$3,$4,$5,'ambulatory','in_progress',clock_timestamp())`,
    [f.encounter, f.patient, f.facility, f.a.account, f.a.membership]);
    await client.query(`insert into ehr.documents (id,patient_id,facility_id,created_by,created_by_membership_id,original_file_name,
      storage_bucket,storage_key,object_version_id,declared_media_type,size_bytes,sha256_hex,status,retention_class)
      values ($1,$2,$3,$4,$5,'lab-verifier.pdf','synthetic-bucket','synthetic/lab-verifier.pdf','lab-verifier-v1',
      'application/pdf',1024,repeat('1',64),'uploaded','clinical_record')`, [f.document, f.patient, f.facility, f.a.account, f.a.membership]);
    for (const order of f.orders) {
      await client.query(`insert into ehr.lab_requests (id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
        test_code_system,test_code,test_display,priority,status,clinical_information,created_at) values ($1,$2,$3,$4,$5,$6,
        'http://loinc.org','718-7','Haemoglobin','routine','active','Synthetic Lab verifier order',$7)`,
      [order, f.encounter, f.patient, f.facility, f.a.account, f.a.membership, requestedAt]);
    }
    // Work items accepted earlier by A, without accessions.
    for (const [index, work] of f.work.entries()) {
      const order = id();
      await client.query(`insert into lab.work_items (id,patient_id,facility_id,ordering_facility_id,source_ehr_order_id,
        source_ehr_order_version,source_encounter_id,priority,test_code_system,test_code,test_name,clinical_indication,
        requested_by,requested_at,accepted_by,accepted_by_membership_id,idempotency_key,request_sha256,correlation_id)
        values ($1,$2,$3,$3,$4,1,$5,'routine','http://loinc.org','718-7','Haemoglobin','Synthetic Lab verifier order',
        $6,$7,$6,$8,$9,repeat('a',64),'lab-verifier-fixture')`,
      [work, f.patient, f.facility, order, f.encounter, f.a.account, requestedAt, f.a.membership, `lab-verifier-work-${index}-${work}`]);
    }
    // A governed OCR publication for Lab, validated by A and being processed.
    const o = f.ocr;
    await client.query(`insert into ocr.jobs (id,facility_id,document_id,patient_id,source_object_version_id,source_sha256_hex,
      idempotency_key,request_sha256,provider,max_attempts,created_by,created_by_membership_id,correlation_id,status,
      attempt_count,completed_at) values ($1,$2,$3,$4,'lab-verifier-v1',repeat('1',64),$5,repeat('a',64),'synthetic-provider',
      3,$6,$7,'lab-verifier-fixture','validated',1,clock_timestamp())`,
    [o.job, f.facility, f.document, f.patient, `lab-verifier-ocr-job-${o.job}`, f.a.account, f.a.membership]);
    await client.query(`insert into ocr.extractions (id,job_id,facility_id,document_id,extraction_version,attempt_no,provider,
      provider_model,provider_result_key,content_sha256,source_object_version_id,source_sha256_hex,provenance)
      values ($1,$2,$3,$4,1,1,'synthetic-provider','synthetic-model',$5,repeat('c',64),'lab-verifier-v1',repeat('1',64),'{}'::jsonb)`,
    [o.extraction, o.job, f.facility, f.document, `lab-verifier-result-${o.extraction}`]);
    await client.query(`insert into ocr.validations (id,job_id,facility_id,extraction_id,validation_version,validated_payload,reason,
      validated_by,validated_by_membership_id,disposition,target_domain,candidate_type) values ($1,$2,$3,$4,1,'{}'::jsonb,
      'Synthetic reviewer validated the Lab report',$5,$6,'validated','LAB','lab_document')`,
    [o.validation, o.job, f.facility, o.extraction, f.a.account, f.a.membership]);
    await client.query(`insert into ocr.patient_confirmations (id,job_id,facility_id,patient_id,confirmation_version,method,reason,
      confirmed_by,confirmed_by_membership_id,idempotency_key,request_sha256) values ($1,$2,$3,$4,1,'source_document',
      'Confirmed against the governed source document',$5,$6,$7,repeat('a',64))`,
    [o.confirmation, o.job, f.facility, f.patient, f.a.account, f.a.membership, `lab-verifier-confirmation-${o.confirmation}`]);
    await client.query(`insert into ocr.publications (id,job_id,validation_id,validation_version,patient_confirmation_id,facility_id,
      patient_id,target_domain,target_operation,idempotency_key,request_sha256,requested_by,requested_by_membership_id,
      correlation_id,status,processing_token,processing_expires_at,attempt_count) values ($1,$2,$3,1,$4,$5,$6,'LAB',
      'create_imported_lab_evidence',$7,repeat('a',64),$8,$9,'lab-verifier-fixture','processing',gen_random_uuid(),
      clock_timestamp()+interval '1 hour',1)`,
    [o.publication, o.job, o.validation, o.confirmation, f.facility, f.patient, `lab-verifier-publication-${o.publication}`,
      f.a.account, f.a.membership]);
  });
  const permissions = ['lab.work-item.accept', 'lab.work-item.read', 'lab.accession.create', 'lab.accession.read',
    'lab.specimen.collect', 'lab.import.write', 'lab.import.read'];
  const actor = (member, granted) => ({ id: member.account, subject: member.subject, accountId: member.account,
    sessionId: id(), roles: [], permissions: [], facilityIds: [f.facility], authenticationMethod: 'local',
    facilities: [{ id: f.facility, membershipId: member.membership, organizationId: f.org, name: 'Lab Verifier Clinic',
      roles: ['lab'], permissions: granted, isPrimary: true }] });
  actors.set('token-a', actor(f.a, permissions));
  actors.set('token-b', actor(f.b, permissions));
  actors.set('token-a-read-only', actor(f.a, ['lab.work-item.read', 'lab.accession.read', 'lab.import.read']));
  const decide = (member, scope, rule) => decisions.set(`${member.account}:${f.patient}:${scope}`, rule);
  for (const member of [f.a, f.b]) for (const scope of ['read_records', 'write_records']) decide(member, scope, { allowed: true, breakGlass: false });

  lab = await startService({ require, service });
  assert.deepEqual((await lab.database.query('select current_user as role')).rows[0], { role: RUNTIME_ROLE });
  check('the API runs as hid_lab_api_runtime');
  const send = (path, body, { token = 'token-a', key, internal, correlationId } = {}) => lab.request('POST', `/lab${path}`, {
    body, correlationId, headers: { authorization: `Bearer ${token}`, 'x-facility-id': f.facility, 'x-purpose-of-use': 'direct-care',
      ...(key ? { 'idempotency-key': key } : {}),
      ...(internal ? { 'x-hid-internal-caller': internal, 'x-hid-service-token': LAB_TOKEN } : {}) } });
  const key = (label) => `verifier-${label}-${id()}`;
  const count = (sql, values) => database.count(sql, values);
  const together = (size, request) => Promise.all(Array.from({ length: size }, request));
  const sameResult = (responses, label) => {
    for (const response of responses) expectStatus(response, 201, label);
    assert.equal(new Set(responses.map((response) => response.body.id)).size, 1, `${label}: one result`);
    return responses[0].body;
  };
  const refusedByDatabase = (response, label) => {
    expectStatus(response, 500, label);
    assert.equal(response.sqlstate, '42501', `${label}: refused by row-level security`);
  };

  // Accept an EHR laboratory order (internal caller ehr-api).
  const orderBody = (order) => ({ sourceEhrOrderId: order, sourceEhrOrderVersion: 1, sourceEncounterId: f.encounter,
    patientId: f.patient, orderingFacilityId: f.facility, testCodeSystem: 'http://loinc.org', testCode: '718-7',
    testName: 'Haemoglobin', priority: 'routine', clinicalIndication: 'Synthetic Lab verifier order',
    requestedBy: f.a.account, requestedAt });
  const workItemsOf = (order) => count('select count(*) from lab.work_items where source_ehr_order_id=$1', [order]);
  const [order1, order2, order3] = f.orders;
  expectStatus(await send('/work-items/accept-ehr-order', orderBody(order1), { key: key('accept') }), 401, 'accept without the EHR caller');
  decide(f.a, 'write_records', { allowed: false, breakGlass: false });
  expectStatus(await send('/work-items/accept-ehr-order', orderBody(order1), { key: key('accept'), internal: 'ehr-api' }), 403,
    'accept refused by Identity');
  decide(f.a, 'write_records', { allowed: true, breakGlass: false });
  expectStatus(await send('/work-items/accept-ehr-order', orderBody(order1), { token: 'token-a-read-only', key: key('accept'), internal: 'ehr-api' }),
    403, 'accept without the permission');
  refusedByDatabase(await send('/work-items/accept-ehr-order', orderBody(order3), { token: 'token-b', key: key('accept'), internal: 'ehr-api' }),
    'accept without a database consent');
  assert.deepEqual(await Promise.all([workItemsOf(order1), workItemsOf(order3)]), [0, 0]);
  check('accept: no EHR caller 401, Identity denial 403, missing permission 403, no database consent refused by row-level security (42501), nothing written');
  const workItem = sameResult(await together(4, () => send('/work-items/accept-ehr-order', orderBody(order1),
    { key: key('accept'), internal: 'ehr-api' })), 'four concurrent accepts of one EHR order');
  assert.deepEqual(await Promise.all([workItemsOf(order1),
    count('select count(*) from lab.work_item_requested_tests where work_item_id=$1', [workItem.id]),
    count('select count(*) from lab.work_item_events where work_item_id=$1', [workItem.id]),
    count('select count(*) from lab.outbox_events where aggregate_id=$1', [workItem.id])]), [1, 1, 1, 1]);
  assert.equal(expectStatus(await send('/work-items/accept-ehr-order', orderBody(order1), { key: key('accept'), internal: 'ehr-api' }),
    201, 'accept replay').id, workItem.id);
  // Any other body for the same order is refused: the stored acceptance does not match it.
  assert.equal(expectStatus(await send('/work-items/accept-ehr-order', { ...orderBody(order1), priority: 'urgent' },
    { key: key('accept'), internal: 'ehr-api' }), 409, 'accept of one order with a different body').code, 'IDEMPOTENCY_CONFLICT');
  sameResult(await together(3, () => send('/work-items/accept-ehr-order', orderBody(order2), { key: key('accept'), internal: 'ehr-api' })),
    'three concurrent accepts of a second order');
  assert.equal(await workItemsOf(order2), 1);
  check('accept: concurrent accepts of one order create one work item, test, event and outbox row; replay 201; a different body 409');

  // Accession a work item.
  const [w1, w2, w3] = f.work;
  const accessionBody = { requirements: [{ specimenType: 'whole blood', containerType: 'EDTA' }], reason: 'Synthetic accession created' };
  const accessionsOf = (work) => count('select count(*) from lab.accessions where work_item_id=$1', [work]);
  expectStatus(await send(`/work-items/${w1}/accession`, accessionBody, { token: 'token-a-read-only', key: key('accession') }), 403,
    'accession without the permission');
  assert.equal(expectStatus(await send(`/work-items/${w1}/accession`, accessionBody, { token: 'token-b', key: key('accession') }), 404,
    'accession without a database consent').code, 'LAB_WORK_ITEM_NOT_FOUND');
  decide(f.a, 'write_records', { allowed: false, breakGlass: false });
  expectStatus(await send(`/work-items/${w1}/accession`, accessionBody, { key: key('accession') }), 403, 'accession refused by Identity');
  decide(f.a, 'write_records', { allowed: true, breakGlass: false });
  assert.equal(await accessionsOf(w1), 0);
  check('accession: missing permission 403, no database consent 404 (row-level security), Identity denial 403, nothing written');
  const accessionKey = key('accession');
  const accession = sameResult(await together(4, () => send(`/work-items/${w1}/accession`, accessionBody, { key: accessionKey })),
    'four concurrent identical accessions');
  assert.deepEqual(await Promise.all([accessionsOf(w1),
    count('select count(*) from lab.specimens where accession_id=$1', [accession.id]),
    count('select count(*) from lab.accession_events where accession_id=$1', [accession.id])]), [1, 1, 1]);
  assert.equal(expectStatus(await send(`/work-items/${w1}/accession`, accessionBody, { key: accessionKey }), 201, 'accession replay').id, accession.id);
  assert.equal(expectStatus(await send(`/work-items/${w1}/accession`, { ...accessionBody, reason: 'A different synthetic reason' },
    { key: accessionKey }), 409, 'accession key reuse').code, 'IDEMPOTENCY_CONFLICT');
  const accessionRivals = await Promise.all(['Rival accession one', 'Rival accession two'].map((reason) =>
    send(`/work-items/${w2}/accession`, { ...accessionBody, reason }, { key: key('accession') })));
  assert.deepEqual(accessionRivals.map((response) => response.status).sort(), [201, 409],
    JSON.stringify(accessionRivals.map((response) => [response.status, response.body?.code, response.sqlstate])));
  assert.equal(await accessionsOf(w2), 1);
  check('accession: four concurrent identical requests accession once and all return it; replay 201; key reuse 409; rivals 201 and 409');

  // Rollback: the outbox insert of one accession fails after its accession,
  // requirement, specimen and events.
  await database.owner.query(`create function public.verifier_fail_lab_outbox() returns trigger language plpgsql security definer as $f$
    begin if new.correlation_id = 'verifier-rollback-lab-0001' then
      raise exception using errcode = 'P0001', message = 'Synthetic outbox failure'; end if; return new; end $f$`);
  await database.owner.query(`create trigger verifier_fail_lab_outbox before insert on lab.outbox_events
    for each row execute function public.verifier_fail_lab_outbox()`);
  const rollbackKey = key('rollback');
  const failed = await send(`/work-items/${w3}/accession`, accessionBody, { key: rollbackKey, correlationId: 'verifier-rollback-lab-0001' });
  expectStatus(failed, 500, 'accession with a failing outbox insert');
  assert.equal(failed.sqlstate, 'P0001');
  // The authorization check and the failed request are audited outside the
  // transaction; nothing the transaction wrote, its own audit row included, remains.
  assert.deepEqual(await Promise.all([accessionsOf(w3), count('select count(*) from lab.specimens s join lab.accessions a on a.id=s.accession_id where a.work_item_id=$1', [w3]),
    count("select count(*) from audit.events where correlation_id='verifier-rollback-lab-0001' and action='lab.accession.create'")]), [0, 0, 0]);
  assert(await count("select count(*) from audit.events where correlation_id='verifier-rollback-lab-0001' and outcome = 'failure'") > 0,
    'the failed accession is audited');
  expectStatus(await send(`/work-items/${w3}/accession`, accessionBody, { key: rollbackKey }), 201, 'accession after the failure');
  check('accession: a failure after the accession inserts rolls back the accession, specimens and audit; the same key then succeeds');

  // The retained specimen lock (UPDATE granted) works as the runtime role.
  const specimen = accession.specimens[0];
  const collectKey = key('collect');
  const collected = expectStatus(await send(`/accessions/${accession.id}/specimens/${specimen.id}/collect`,
    { expectedVersion: specimen.version, collectedAt: '2026-10-02T08:00:00.000Z' }, { key: collectKey }), 201, 'collect a specimen');
  assert.equal(collected.status, 'collected');
  assert.equal(expectStatus(await send(`/accessions/${accession.id}/specimens/${specimen.id}/collect`,
    { expectedVersion: specimen.version, collectedAt: '2026-10-02T08:00:00.000Z' }, { key: key('collect') }), 412,
  'collect at a stale version').code, 'VERSION_CONFLICT');
  check('specimen collect (FOR UPDATE on specimens, which the role may update): 201, then stale version 412');

  // Import external Lab evidence, and Lab evidence published by OCR.
  const observations = [{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL', abnormalFlag: 'normal' }];
  const externalBody = { patientId: f.patient, sourceDocumentId: f.document, externalLabName: 'Synthetic Reference Lab',
    externalReference: 'SRL-0001', reason: 'Synthetic external report', purpose: 'direct-care', observations };
  decide(f.a, 'write_records', { allowed: false, breakGlass: false });
  expectStatus(await send('/imports', externalBody, { key: key('import') }), 403, 'import refused by Identity');
  decide(f.a, 'write_records', { allowed: true, breakGlass: false });
  const importKey = key('import');
  const imported = sameResult(await together(4, () => send('/imports', externalBody, { key: importKey })), 'four concurrent identical imports');
  assert.deepEqual(await Promise.all([count("select count(*) from lab.imported_evidence where idempotency_key=$1", [importKey]),
    count('select count(*) from lab.imported_observations where import_id=$1', [imported.id])]), [1, 1]);
  assert.equal(expectStatus(await send('/imports', externalBody, { key: importKey }), 201, 'import replay').id, imported.id);
  assert.equal(expectStatus(await send('/imports', { ...externalBody, externalReference: 'SRL-0002' }, { key: importKey }), 409,
    'import key reuse').code, 'IDEMPOTENCY_CONFLICT');
  const unconsented = key('import');
  refusedByDatabase(await send('/imports', externalBody, { token: 'token-b', key: unconsented }), 'import without a database consent');
  assert.equal(await count('select count(*) from lab.imported_evidence where idempotency_key=$1', [unconsented]), 0);
  const ocrBody = { patientId: f.patient, sourceDocumentId: f.document, ocrJobId: f.ocr.job, extractionId: f.ocr.extraction,
    validationId: f.ocr.validation, validationVersion: 1, publicationId: f.ocr.publication, reviewedBy: f.a.account, observations };
  expectStatus(await send('/imports/from-ocr', ocrBody, { key: key('ocr') }), 401, 'OCR import without the OCR caller');
  const fromOcr = sameResult(await together(4, () => send('/imports/from-ocr', ocrBody, { key: key('ocr'), internal: 'ocr-api' })),
    'four concurrent imports of one OCR publication');
  assert.equal(await count('select count(*) from lab.imported_evidence where publication_id=$1', [f.ocr.publication]), 1);
  assert.equal(expectStatus(await send('/imports/from-ocr', ocrBody, { key: key('ocr'), internal: 'ocr-api' }), 201, 'OCR import replay').id,
    fromOcr.id);
  assert.equal(expectStatus(await send('/imports/from-ocr', { ...ocrBody, observations: [{ ...observations[0], value: '13.1' }] },
    { key: key('ocr'), internal: 'ocr-api' }), 409, 'a different OCR import of one publication').code, 'IDEMPOTENCY_CONFLICT');
  check('import: Identity denial 403, no database consent refused by row-level security (42501, nothing written); four concurrent identical external imports and four concurrent imports of one OCR publication each import once; replay 201; conflicting requests 409');
  await lab.close();
  lab = undefined;
  assert.equal(await database.deadlocks(), 0, 'PostgreSQL detected a deadlock during the run');
  check('no deadlock: pg_stat_database reports none for the run, retried commands included');
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...evidence })}\n`);
} finally {
  await lab?.close();
  await database.close();
  await identity.close();
}
