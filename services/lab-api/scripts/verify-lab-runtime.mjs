#!/usr/bin/env node
// Phase 4 Stage 9: the Lab create commands through the real Lab API (guard,
// controllers, services, DatabaseService, audit) as hid_lab_api_runtime, on a
// disposable copy of the owned synthetic rehearsal. Before Stage 9 EHR-order
// acceptance, accession, and Lab evidence import (external and from OCR)
// failed with 42501: their replay lookups locked insert-only rows (work items,
// accessions, imported evidence) that the runtime role cannot update. With no
// accession, no specimen, execution or result could exist; the verifier then
// follows one specimen through receipt, execution start and completion, and
// one result through entry, verification and release, whose FOR UPDATE locks
// fall on lab.specimens, lab.test_executions and lab.results, rows the role may
// update. A doctor then reads the released result by the EHR order and by
// result while a correction awaits verification, and receives only the
// released version. Only the Identity API is replaced, by a local fake; every
// database check (row-level security, the 0077 guards, immutability triggers,
// unique constraints) is real. Only EHR-order acceptance maps its own database
// refusals (lab-work-items.service.ts, fix/ehr-lab-handoff-resend): its guard's
// refusal of a stale or changed order 409 LAB_ORDER_NOT_CURRENT and row-level
// security 403 LAB_ACCESS_DENIED, where both were 500; it answers a later
// version of an order Lab already holds 409 LAB_ORDER_ALREADY_ACCEPTED and an
// earlier one 409 LAB_ORDER_NOT_CURRENT without reaching the database guard.
// Every other command still answers a database refusal 500 (a known limit);
// for the OCR import that 500 is what OCR stores as the retryable
// OWNING_SERVICE_UNAVAILABLE. The harness records the SQLSTATE behind each.
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
    c: { account: id(), staff: id(), membership: id() }, d: { account: id(), staff: id(), membership: id() },
    // E, a doctor of the facility; X, a doctor of another facility of the organization.
    e: { account: id(), staff: id(), membership: id() }, x: { account: id(), staff: id(), membership: id() },
    otherFacility: id(), orders: [id(), id(), id()], work: [id(), id(), id()], workOrders: [id(), id(), id()], microOrder: id(),
    ocr: { job: id(), extraction: id(), validation: id(), confirmation: id(), publication: id() } };
  const members = [['a', f.a], ['b', f.b], ['c', f.c], ['d', f.d]];
  const doctors = [['e', f.e, f.facility], ['x', f.x, f.otherFacility]];
  for (const [name, member] of [...members, ...doctors]) member.subject = `synthetic:lab-verifier-${name}:${member.account}`;
  const requestedAt = '2026-10-01T09:00:00.000Z';
  await database.fixture(async (client) => {
    await client.query('insert into identity.organizations (id,name,slug) values ($1,$2,$3)',
      [f.org, 'Lab Verifier Org', `lab-verifier-${f.org.slice(0, 8)}`]);
    await client.query(`insert into identity.facilities (id,organization_id,name,code,timezone,active,lifecycle_status)
      values ($1,$2,'Lab Verifier Clinic',$3,'Africa/Lagos',true,'verified')`, [f.facility, f.org, `LV-${f.facility.slice(0, 8)}`]);
    await client.query(`insert into identity.facilities (id,organization_id,name,code,timezone,active,lifecycle_status)
      values ($1,$2,'Lab Verifier Annex',$3,'Africa/Lagos',true,'verified')`, [f.otherFacility, f.org, `LV-${f.otherFacility.slice(0, 8)}`]);
    for (const [name, member] of members) {
      await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,$4,'active')`,
        [member.account, member.subject, `lab-verifier-${name}-${member.account}@example.invalid`, `Lab Verifier ${name}`]);
      await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
        values ($1,$2,$3,$4,'verified','lab')`, [member.staff, member.account, `Lab Verifier ${name}`,
        `lab-verifier-${name}-${member.account}@example.invalid`]);
      await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
        membership_role,app_role,active) values ($1,$2,$3,$4,$5,'lab','lab',true)`,
      [member.membership, member.staff, member.account, f.org, f.facility]);
    }
    // The doctors hold a database read consent at their own facility.
    for (const [name, member, facility] of doctors) {
      await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,$4,'active')`,
        [member.account, member.subject, `lab-verifier-${name}-${member.account}@example.invalid`, `Lab Verifier ${name}`]);
      await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
        values ($1,$2,$3,$4,'verified','doctor')`, [member.staff, member.account, `Lab Verifier ${name}`,
        `lab-verifier-${name}-${member.account}@example.invalid`]);
      await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
        membership_role,app_role,active) values ($1,$2,$3,$4,$5,'doctor','doctor',true)`,
      [member.membership, member.staff, member.account, f.org, facility]);
    }
    await client.query(`insert into identity.patients (id,hid_code,first_name,last_name,full_name,status)
      values ($1,'HID-LBVRFYAA','Verifier','Patient','Verifier Patient','active')`, [f.patient]);
    await client.query(`insert into identity.purpose_of_use_codes (code,display,source_system)
      values ('direct-care','Direct patient care','lab-verifier') on conflict (code) do nothing`);
    // A, and the result verifiers C and D, hold a database consent grant; B is
    // allowed by the fake Identity only.
    for (const member of [f.a, f.c, f.d]) {
      await client.query(`insert into identity.consent_grants (id,patient_id,staff_id,account_id,membership_id,facility_id,scope,
        purpose_of_use,status,reason,starts_at,expires_at) values ($1,$2,$3,$4,$5,$6,'write_records','direct-care','active',
        'Synthetic Lab verifier consent',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days')`,
      [id(), f.patient, member.staff, member.account, member.membership, f.facility]);
    }
    for (const [, member, facility] of doctors) {
      await client.query(`insert into identity.consent_grants (id,patient_id,staff_id,account_id,membership_id,facility_id,scope,
        purpose_of_use,status,reason,starts_at,expires_at) values ($1,$2,$3,$4,$5,$6,'read_records','direct-care','active',
        'Synthetic Lab verifier read consent',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days')`,
      [id(), f.patient, member.staff, member.account, member.membership, facility]);
    }
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
    // An order whose created_at has microseconds, as clock_timestamp() gives (ehr.lab_requests, 0004).
    await client.query(`insert into ehr.lab_requests (id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
      test_code_system,test_code,test_display,priority,status,clinical_information,created_at) values ($1,$2,$3,$4,$5,$6,
      'http://loinc.org','718-7','Haemoglobin','routine','active','Synthetic Lab verifier order',$7)`,
    [f.microOrder, f.encounter, f.patient, f.facility, f.a.account, f.a.membership, '2026-10-01T09:00:00.123456Z']);
    // Work items accepted earlier by A, without accessions, each with the one
    // requested test acceptance records (execution start requires exactly one).
    for (const [index, work] of f.work.entries()) {
      const order = f.workOrders[index];
      await client.query(`insert into lab.work_items (id,patient_id,facility_id,ordering_facility_id,source_ehr_order_id,
        source_ehr_order_version,source_encounter_id,priority,test_code_system,test_code,test_name,clinical_indication,
        requested_by,requested_at,accepted_by,accepted_by_membership_id,idempotency_key,request_sha256,correlation_id)
        values ($1,$2,$3,$3,$4,1,$5,'routine','http://loinc.org','718-7','Haemoglobin','Synthetic Lab verifier order',
        $6,$7,$6,$8,$9,repeat('a',64),'lab-verifier-fixture')`,
      [work, f.patient, f.facility, order, f.encounter, f.a.account, requestedAt, f.a.membership, `lab-verifier-work-${index}-${work}`]);
      await client.query(`insert into lab.work_item_requested_tests (work_item_id,facility_id,patient_id,"ordinal",code_system,code,name)
        values ($1,$2,$3,1,'http://loinc.org','718-7','Haemoglobin')`, [work, f.facility, f.patient]);
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
    'lab.specimen.collect', 'lab.specimen.receive', 'lab.execution.start', 'lab.execution.complete', 'lab.result.enter',
    'lab.result.verify', 'lab.result.release', 'lab.import.write', 'lab.import.read'];
  const actor = (member, granted, facility = f.facility, role = 'lab') => ({ id: member.account, subject: member.subject,
    accountId: member.account, sessionId: id(), roles: [], permissions: [], facilityIds: [facility], authenticationMethod: 'local',
    facilities: [{ id: facility, membershipId: member.membership, organizationId: f.org, name: 'Lab Verifier Clinic',
      roles: [role], permissions: granted, isPrimary: true }] });
  actors.set('token-a', actor(f.a, permissions));
  actors.set('token-b', actor(f.b, permissions));
  actors.set('token-c', actor(f.c, permissions));
  actors.set('token-d', actor(f.d, permissions));
  actors.set('token-a-read-only', actor(f.a, ['lab.work-item.read', 'lab.accession.read', 'lab.import.read']));
  // A corrects a released result and reads its full history, as Lab staff.
  actors.set('token-a-corrector', actor(f.a, [...permissions, 'lab.result.correct', 'lab.result.revise-released',
    'lab.execution.read', 'lab.result.released.read']));
  // The doctor role's Lab permissions (0017, 0018, 0021): no execution or accession read.
  const doctorPermissions = ['lab.import.read', 'lab.import.write', 'lab.work-item.read', 'lab.work-item.accept', 'lab.result.released.read'];
  actors.set('token-e', actor(f.e, doctorPermissions, f.facility, 'doctor'));
  actors.set('token-e-without-results', actor(f.e, doctorPermissions.filter((permission) => permission !== 'lab.result.released.read'),
    f.facility, 'doctor'));
  actors.set('token-x', actor(f.x, doctorPermissions, f.otherFacility, 'doctor'));
  const decide = (member, scope, rule) => decisions.set(`${member.account}:${f.patient}:${scope}`, rule);
  for (const member of [f.a, f.b, f.c, f.d]) for (const scope of ['read_records', 'write_records']) decide(member, scope, { allowed: true, breakGlass: false });
  for (const member of [f.e, f.x]) decide(member, 'read_records', { allowed: true, breakGlass: false });

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
  // Row-level security refuses an actor without a database consent (42501). Lab answers it 500, as any database
  // refusal, except EHR-order acceptance, which answers its own 403 LAB_ACCESS_DENIED.
  const refusedByDatabase = (response, label, { status = 500, code = 'INTERNAL_ERROR' } = {}) => {
    assert.equal(expectStatus(response, status, label).code, code, `${label}: code`);
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
    'accept without a database consent', { status: 403, code: 'LAB_ACCESS_DENIED' });
  assert.deepEqual(await Promise.all([workItemsOf(order1), workItemsOf(order3)]), [0, 0]);
  check('accept: no EHR caller 401, Identity denial 403, missing permission 403, no database consent refused by row-level security (42501) with 403 LAB_ACCESS_DENIED, nothing written');
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
  // Lab holds one work item per EHR order, ever (unique source_ehr_order_id, 0018). EHR changes the order (every
  // change takes the next row_version) and sends the new version: Lab refuses it, naming the version it holds.
  await database.fixture((client) => client.query(
    "update ehr.lab_requests set row_version = 2, priority = 'stat' where id = $1", [order1]));
  const reaccepted = await send('/work-items/accept-ehr-order', { ...orderBody(order1), sourceEhrOrderVersion: 2, priority: 'stat' },
    { key: key('accept'), internal: 'ehr-api' });
  assert.equal(expectStatus(reaccepted, 409, 'accept of the next version of an accepted order').code, 'LAB_ORDER_ALREADY_ACCEPTED',
    JSON.stringify([reaccepted.body?.code, reaccepted.sqlstate]));
  assert.deepEqual(await Promise.all([workItemsOf(order1),
    count('select count(*) from lab.work_items where source_ehr_order_id=$1 and source_ehr_order_version=1', [order1])]), [1, 1]);
  check('accept: version 2 of an order Lab accepted at version 1 is 409 LAB_ORDER_ALREADY_ACCEPTED; the version 1 work item stays the only one');
  // Lab accepts an EHR order only when requested_at equals the order's created_at exactly (0077). EHR sends the
  // database's microsecond text (lab-requests.service.ts); the millisecond text of a JavaScript Date is refused.
  const truncated = await send('/work-items/accept-ehr-order', { ...orderBody(f.microOrder), requestedAt: '2026-10-01T09:00:00.123Z' },
    { key: key('accept'), internal: 'ehr-api' });
  // lab.validate_work_item refuses it (23514), and Lab answers 409 LAB_ORDER_NOT_CURRENT.
  assert.equal(expectStatus(truncated, 409, 'accept with the millisecond requestedAt').code, 'LAB_ORDER_NOT_CURRENT');
  assert.equal(truncated.sqlstate, '23514', 'millisecond requestedAt: refused by lab.validate_work_item');
  assert.equal(truncated.message, 'Lab work item does not match the exact active EHR order version and actor context');
  assert.equal(await workItemsOf(f.microOrder), 0);
  expectStatus(await send('/work-items/accept-ehr-order', { ...orderBody(f.microOrder), requestedAt: '2026-10-01T09:00:00.123456Z' },
    { key: key('accept'), internal: 'ehr-api' }), 201, 'accept with the microsecond requestedAt');
  assert.equal(await workItemsOf(f.microOrder), 1);
  check('accept: an order created at .123456 is refused for requestedAt .123Z by the database guard (23514) with 409 LAB_ORDER_NOT_CURRENT and creates no work item; .123456Z is accepted (201)');
  // An EHR order changed after the version EHR sends (row_version 2, version 1 sent) is not the current order.
  await database.fixture((client) => client.query('update ehr.lab_requests set row_version = 2 where id = $1', [order3]));
  const stale = await send('/work-items/accept-ehr-order', orderBody(order3), { key: key('accept'), internal: 'ehr-api' });
  assert.equal(expectStatus(stale, 409, 'accept of a stale order version').code, 'LAB_ORDER_NOT_CURRENT');
  assert.equal(stale.sqlstate, '23514', 'stale version: refused by lab.validate_work_item');
  assert.equal(stale.message, 'Lab work item does not match the exact active EHR order version and actor context');
  assert.equal(await workItemsOf(order3), 0);
  expectStatus(await send('/work-items/accept-ehr-order', { ...orderBody(order3), sourceEhrOrderVersion: 2 },
    { key: key('accept'), internal: 'ehr-api' }), 201, 'accept of the current order version');
  assert.equal(await workItemsOf(order3), 1);
  check('accept: version 1 of an order now at version 2 is refused by the database guard (23514) with 409 LAB_ORDER_NOT_CURRENT and creates no work item; version 2 is accepted (201)');
  // A call for version 1 arriving after Lab accepted version 2 (two EHR updates, the later call first) is stale:
  // Lab answers it from the work item it holds, without reaching the guard, and never says it holds an earlier version.
  const late = await send('/work-items/accept-ehr-order', orderBody(order3), { key: key('accept'), internal: 'ehr-api' });
  assert.equal(expectStatus(late, 409, 'accept of version 1 when Lab holds version 2').code, 'LAB_ORDER_NOT_CURRENT',
    'accept of version 1 when Lab holds version 2 is not answered LAB_ORDER_NOT_CURRENT');
  assert.equal(late.sqlstate, undefined, 'accept of version 1 when Lab holds version 2 reached the database guard');
  assert.deepEqual(await Promise.all([workItemsOf(order3),
    count('select count(*) from lab.work_items where source_ehr_order_id=$1 and source_ehr_order_version=2', [order3])]), [1, 1],
  'accept of version 1 when Lab holds version 2 changed the work items');
  check('accept: version 1 of an order Lab holds at version 2 is 409 LAB_ORDER_NOT_CURRENT from the work item Lab holds, not the guard; the version 2 work item stays the only one');

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

  // Receive the collected specimen (FOR UPDATE on lab.specimens).
  const outboxOf = (aggregate, type) => count('select count(*) from lab.outbox_events where aggregate_id=$1 and event_type=$2', [aggregate, type]);
  const receiveBody = { expectedVersion: collected.version, receivedAt: '2026-10-02T09:00:00.000Z', condition: 'Synthetic specimen intact' };
  const received = expectStatus(await send(`/accessions/${accession.id}/specimens/${specimen.id}/receive`, receiveBody,
    { key: key('receive') }), 201, 'receive the collected specimen');
  assert.deepEqual([received.status, received.version], ['received', collected.version + 1]);
  assert.equal(expectStatus(await send(`/accessions/${accession.id}/specimens/${specimen.id}/receive`, receiveBody,
    { key: key('receive') }), 412, 'receive at a stale version').code, 'VERSION_CONFLICT');
  assert.deepEqual(await Promise.all([
    count("select count(*) from lab.specimens where id=$1 and status='received' and received_by=$2", [specimen.id, f.a.account]),
    count("select count(*) from lab.specimen_command_idempotency where specimen_id=$1 and operation='receive'", [specimen.id]),
    count("select count(*) from lab.specimen_events where specimen_id=$1 and event_type='specimen_received'", [specimen.id]),
    outboxOf(specimen.id, 'LabSpecimenReceived')]), [1, 1, 1, 1]);
  check('specimen receive (FOR UPDATE on specimens): 201 moves the collected specimen to received at the next version; the same receipt at the stale version 412; one receipt command row, event and outbox row');

  // Start the execution of the received specimen (FOR UPDATE on lab.specimens).
  const startBody = { expectedSpecimenVersion: received.version, startedAt: '2026-10-02T10:00:00.000Z',
    method: 'Synthetic photometry', reason: 'Synthetic analytical run started' };
  const startKey = key('start');
  const start = (body) => send(`/specimens/${specimen.id}/executions`, body, { key: startKey });
  const execution = sameResult(await together(4, () => start(startBody)), 'four concurrent identical execution starts');
  assert.deepEqual([execution.status, execution.version, execution.specimenId], ['in_progress', 1, specimen.id]);
  assert.deepEqual(await Promise.all([count('select count(*) from lab.test_executions where specimen_id=$1', [specimen.id]),
    count("select count(*) from lab.execution_events where execution_id=$1 and event_type='execution_started'", [execution.id]),
    outboxOf(execution.id, 'LabTestExecutionStarted')]), [1, 1, 1]);
  assert.equal(expectStatus(await start(startBody), 201, 'execution start replay').id, execution.id);
  assert.equal(expectStatus(await start({ ...startBody, reason: 'A different synthetic start reason' }), 409,
    'execution start key reuse').code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await count('select count(*) from lab.test_executions where specimen_id=$1', [specimen.id]), 1);
  check('execution start (FOR UPDATE on specimens): four concurrent identical requests start one execution, event and outbox row and all return it; replay 201; key reuse with a different body 409');

  // Complete the execution (FOR UPDATE on lab.test_executions).
  const completeBody = { expectedVersion: execution.version, completedAt: '2026-10-02T11:00:00.000Z', notes: 'Synthetic run completed' };
  const completeKey = key('complete');
  const completed = expectStatus(await send(`/executions/${execution.id}/complete`, completeBody, { key: completeKey }), 201,
    'complete the execution');
  assert.deepEqual([completed.id, completed.status, completed.version], [execution.id, 'completed', execution.version + 1]);
  assert.equal(expectStatus(await send(`/executions/${execution.id}/complete`, completeBody, { key: completeKey }), 201,
    'execution complete replay').version, completed.version);
  assert.equal(expectStatus(await send(`/executions/${execution.id}/complete`, completeBody, { key: key('complete') }), 412,
    'complete at a stale version').code, 'VERSION_CONFLICT');
  assert.deepEqual(await Promise.all([
    count("select count(*) from lab.test_executions where id=$1 and status='completed' and row_version=$2", [execution.id, completed.version]),
    count("select count(*) from lab.execution_events where execution_id=$1 and event_type='execution_completed'", [execution.id]),
    outboxOf(execution.id, 'LabTestExecutionCompleted')]), [1, 1, 1]);
  check('execution complete (FOR UPDATE on test_executions): 201 completes it at the next version; replay 201; the same completion at the stale version under a new key 412; one completion event and outbox row');

  // Enter a manual numeric result (FOR UPDATE on lab.test_executions).
  const resultBody = { expectedExecutionVersion: completed.version, resultType: 'numeric', numericValue: 13.4, unit: 'g/dL',
    referenceRange: '12.0-15.5', abnormalFlag: 'normal' };
  const enterKey = key('result');
  const enter = (body) => send(`/executions/${execution.id}/results`, body, { key: enterKey });
  const result = sameResult(await together(4, () => enter(resultBody)), 'four concurrent identical result entries');
  assert.deepEqual([result.status, result.currentVersion, result.revisions.length, result.revisions[0].numericValue],
    ['entered_unverified', 1, 1, 13.4]);
  assert.deepEqual(await Promise.all([count('select count(*) from lab.results where execution_id=$1', [execution.id]),
    count('select count(*) from lab.result_revisions where result_id=$1 and entered_by=$2', [result.id, f.a.account]),
    count("select count(*) from lab.result_events where result_id=$1 and event_type='result_entered'", [result.id]),
    outboxOf(result.id, 'LabResultEntered')]), [1, 1, 1, 1]);
  assert.equal(expectStatus(await enter(resultBody), 201, 'result entry replay').id, result.id);
  assert.equal(expectStatus(await enter({ ...resultBody, numericValue: 13.5 }), 409, 'result entry key reuse').code, 'IDEMPOTENCY_CONFLICT');
  check('result enter (FOR UPDATE on test_executions): four concurrent identical entries create one result, revision 1 by A, event and outbox row and all return it; replay 201; key reuse with a different value 409');

  // Verify the result. The database refuses a verifier who entered the result.
  const governBody = (occurredAt, reason, expectedResultVersion = result.currentVersion) => ({ expectedResultVersion, occurredAt, reason });
  const verificationsOf = () => count('select count(*) from lab.result_verifications where result_id=$1', [result.id]);
  const selfCorrelation = 'verifier-self-verification-lab-0001';
  const selfVerified = await send(`/results/${result.id}/verify`, governBody('2026-10-02T12:00:00.000Z', 'Synthetic self verification'),
    { key: key('verify'), correlationId: selfCorrelation });
  expectStatus(selfVerified, 500, 'verification by the member who entered the result');
  assert.equal(selfVerified.sqlstate, '23514', 'the database guard refuses the verification');
  assert.match(selfVerified.message, /^Result verifier must be independent/);
  assert.deepEqual(await Promise.all([verificationsOf(), outboxOf(result.id, 'LabResultVerified'),
    count("select count(*) from audit.events where correlation_id=$1 and action='lab.result.verify'", [selfCorrelation])]), [0, 0, 0]);
  check('result verify by the member who entered the result: the database guard refuses it (23514, Result verifier must be independent), no verification, outbox or audit row is written; the API answers 500 because the service has no mapping for it (a known limit)');

  // Two independent members, C and D, verify the same result version at once.
  assert.equal(expectStatus(await send(`/results/${result.id}/verify`,
    governBody('2026-10-02T12:00:00.000Z', 'Synthetic stale verification', result.currentVersion + 1), { token: 'token-c', key: key('verify') }),
  412, 'verification of a version that is not current').code, 'VERSION_CONFLICT');
  assert.equal(await verificationsOf(), 0);
  const verifiers = [['token-c', f.c], ['token-d', f.d]].map(([token, member]) => ({ token, member, key: key('verify'),
    body: governBody('2026-10-02T12:30:00.000Z', `Synthetic independent verification by ${token}`) }));
  const verifications = await Promise.all(verifiers.map(({ token, key: verifyKey, body }) =>
    send(`/results/${result.id}/verify`, body, { token, key: verifyKey })));
  const outcome = JSON.stringify(verifications.map((response) => [response.status, response.body?.code, response.sqlstate]));
  assert.deepEqual(verifications.map((response) => response.status).sort(), [201, 500], outcome);
  const winner = verifiers[verifications.findIndex((response) => response.status === 201)];
  const verified = verifications.find((response) => response.status === 201).body;
  // The loser's insert meets unique(result_id,result_version); DatabaseService
  // reruns it once and the second unique violation is not mapped to a 4xx.
  assert.equal(verifications.find((response) => response.status === 500).sqlstate, '23505', outcome);
  assert.deepEqual([verified.id, verified.status, verified.verificationStatus], [result.id, 'verified_not_released', 'verified']);
  assert.deepEqual(await Promise.all([verificationsOf(),
    count('select count(*) from lab.result_verifications where result_id=$1 and result_version=1 and verified_by=$2', [result.id, winner.member.account]),
    outboxOf(result.id, 'LabResultVerified')]), [1, 1, 1]);
  assert.equal(expectStatus(await send(`/results/${result.id}/verify`, winner.body, { token: winner.token, key: winner.key }), 201,
    'verification replay').status, 'verified_not_released');
  assert.equal(expectStatus(await send(`/results/${result.id}/verify`, { ...winner.body, reason: 'A different synthetic verification' },
    { token: winner.token, key: winner.key }), 409, 'verification key reuse').code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await verificationsOf(), 1);
  check('result verify by independent members (FOR UPDATE on results): a version that is not current 412, nothing written; two concurrent verifications of version 1 by C and D: one 201 writes one verification and outbox row, the other is refused by unique(result_id,result_version) and the API answers 500 (23505, no mapping; a known limit); the winner\'s replay 201 and key reuse 409');

  // Release the verified result (FOR UPDATE on lab.results).
  const releaseKey = key('release');
  const releaseBody = governBody('2026-10-02T13:00:00.000Z', 'Synthetic release attestation');
  const release = (body) => send(`/results/${result.id}/release`, body, { token: 'token-c', key: releaseKey });
  const released = sameResult(await together(4, () => release(releaseBody)), 'four concurrent identical releases');
  assert.deepEqual([released.status, released.currentReleasedVersion, released.revisions[0].releaseStatus], ['released', 1, 'released']);
  assert.deepEqual(await Promise.all([count('select count(*) from lab.result_releases where result_id=$1 and result_version=1 and released_by=$2',
    [result.id, f.c.account]), outboxOf(result.id, 'LabResultReleased')]), [1, 1]);
  assert.equal(expectStatus(await release(releaseBody), 201, 'release replay').status, 'released');
  assert.equal(expectStatus(await release({ ...releaseBody, reason: 'A different synthetic release' }), 409, 'release key reuse').code,
    'IDEMPOTENCY_CONFLICT');
  assert.equal(await count('select count(*) from lab.result_releases where result_id=$1', [result.id]), 1);
  check('result release (FOR UPDATE on results): four concurrent identical releases of the verified version release it once (one release and outbox row) and all return it released; replay 201; key reuse with a different body 409');

  // Released results for clinicians. Lab staff (A) correct the released result;
  // version 2 is entered and neither verified nor released. The doctor E holds
  // the doctor role's Lab permissions, which include no execution or accession
  // read, and reads the result by the EHR order of its work item and by result.
  const read = (path, { token = 'token-e', facility = f.facility, correlationId } = {}) => lab.request('GET', `/lab${path}`,
    { correlationId, headers: { authorization: `Bearer ${token}`, 'x-facility-id': facility, 'x-purpose-of-use': 'direct-care' } });
  const releasedResultsOf = (order) => `/ehr-orders/${order}/released-results`;
  const historyOf = `/results/${result.id}/history`;
  const [w1Order] = f.workOrders;
  const CORRECTION_REASON = 'Synthetic transcription correction';
  const numericValuesIn = (node) => (Array.isArray(node) ? node.flatMap(numericValuesIn)
    : node && typeof node === 'object' ? Object.entries(node).flatMap(([name, value]) => (name === 'numericValue' ? [value] : numericValuesIn(value))) : []);
  const releasedReadAudits = (correlationId, resourceType, resourceId) => count(`select count(*) from audit.events where correlation_id=$1
    and action='lab.result.released.read' and resource_type=$2 and resource_id=$3 and patient_id=$4 and actor_account_id=$5`,
  [correlationId, resourceType, resourceId, f.patient, f.e.account]);
  const corrected = expectStatus(await send(`/executions/${execution.id}/results/${result.id}/corrections`, {
    expectedExecutionVersion: completed.version, expectedResultVersion: 1, resultType: 'numeric', numericValue: 7.1, unit: 'g/dL',
    referenceRange: '12.0-15.5', abnormalFlag: 'low', reason: CORRECTION_REASON, revisionKind: 'correction' },
  { token: 'token-a-corrector', key: key('correct') }), 201, 'correct the released result');
  assert.deepEqual([corrected.currentVersion, corrected.currentReleasedVersion, corrected.revisions.map((revision) => revision.releaseStatus)],
    [2, 1, ['released', 'not_released']]);
  const staffHistory = expectStatus(await read(historyOf, { token: 'token-a-corrector' }), 200, 'Lab staff read the full history');
  assert.deepEqual(staffHistory.revisions.map((revision) => [revision.version, revision.numericValue, revision.releaseStatus]),
    [[1, 13.4, 'released'], [2, 7.1, 'not_released']]);
  check('result correct after release (lab.result.revise-released): 201 appends version 2, entered and unreleased; Lab staff holding lab.execution.read still read both versions in the history');

  // The released-only history returns the released version alone.
  const historyCorrelation = 'verifier-released-history-lab-0001';
  const history = expectStatus(await read(historyOf, { correlationId: historyCorrelation }), 200, 'the doctor reads the released history');
  assert.deepEqual([history.status, history.currentVersion, history.currentReleasedVersion, history.revisions.map((revision) => revision.version)],
    ['released', 1, 1, [1]], 'released-only history after an unreleased correction returns version 1 only');
  assert.deepEqual(numericValuesIn(history), [13.4], 'the released-only history returns no value of the unreleased correction');
  assert(!JSON.stringify(history).includes(CORRECTION_REASON) && !/unreleased/i.test(JSON.stringify(history)),
    'the released-only history gives no sign of the unreleased correction');
  assert.equal(await releasedReadAudits(historyCorrelation, 'lab-result', result.id), 1, 'the released history read is audited with its patient');
  check('released-only history (doctor role, no lab.execution.read) after an unreleased correction: 200 with version 1 only, current version 1, no value, reason or flag of version 2; one patient-linked lab.result.released.read audit row');

  // The doctor reads the released results of the EHR order.
  const orderCorrelation = 'verifier-released-order-lab-0001';
  const byOrder = expectStatus(await read(releasedResultsOf(w1Order), { correlationId: orderCorrelation }), 200,
    'the doctor reads the released results of the EHR order');
  assert.deepEqual([byOrder.workItemId, byOrder.sourceEhrOrderId, byOrder.patientId, byOrder.results.map((item) => item.id)],
    [w1, w1Order, f.patient, [result.id]]);
  assert.deepEqual([byOrder.results[0].status, byOrder.results[0].currentVersion, byOrder.results[0].revisions.map((revision) =>
    [revision.version, revision.numericValue, revision.releaseStatus])], ['released', 1, [[1, 13.4, 'released']]],
  'released results by order after an unreleased correction return version 1 only');
  assert.deepEqual(numericValuesIn(byOrder), [13.4], 'the released results by order return no value of the unreleased correction');
  assert(!JSON.stringify(byOrder).includes(CORRECTION_REASON) && !/unreleased/i.test(JSON.stringify(byOrder)),
    'the released results by order give no sign of the unreleased correction');
  assert.equal(await releasedReadAudits(orderCorrelation, 'lab-work-item', w1), 1, 'the released results read is audited with its patient');
  assert.deepEqual(expectStatus(await read(releasedResultsOf(order1)), 200, 'released results of an order with nothing released').results, []);
  check('released results by EHR order (doctor role): 200 with the released version 1 of the order\'s result only, no value, reason or flag of the unreleased version 2; one patient-linked lab.result.released.read audit row; an accepted order with nothing released answers 200 with no results');

  // Refusals: no permission, a facility the doctor does not belong to, a doctor
  // of another facility (row-level security), Identity, and an unknown order.
  const refused = [];
  const refuse = async (path, options, status, code, label) => {
    const correlationId = `verifier-released-refusal-${refused.length}-${id()}`;
    refused.push(correlationId);
    assert.equal(expectStatus(await read(path, { ...options, correlationId }), status, label).code, code, label);
  };
  await refuse(releasedResultsOf(w1Order), { token: 'token-e-without-results' }, 403, 'PERMISSION_DENIED', 'released results without lab.result.released.read');
  await refuse(releasedResultsOf(w1Order), { facility: f.otherFacility }, 403, 'FACILITY_ACCESS_DENIED', 'released results at a facility of no membership');
  await refuse(releasedResultsOf(w1Order), { token: 'token-x', facility: f.otherFacility }, 404, 'LAB_WORK_ITEM_NOT_FOUND',
    'released results for a doctor of another facility');
  await refuse(historyOf, { token: 'token-x', facility: f.otherFacility }, 404, 'LAB_RESULT_NOT_FOUND', 'released history for a doctor of another facility');
  decide(f.e, 'read_records', { allowed: false, breakGlass: false });
  await refuse(releasedResultsOf(w1Order), {}, 403, 'LAB_EXECUTION_ACCESS_DENIED', 'released results refused by Identity');
  await refuse(historyOf, {}, 403, 'LAB_EXECUTION_ACCESS_DENIED', 'released history refused by Identity');
  decide(f.e, 'read_records', { allowed: true, breakGlass: false });
  await refuse(releasedResultsOf(id()), {}, 404, 'LAB_WORK_ITEM_NOT_FOUND', 'released results of an order with no work item');
  assert.equal(await count(`select count(*) from audit.events where correlation_id = any($1::text[]) and action like 'lab.result.%'`, [refused]), 0,
    'a refused released-result read writes no read audit');
  check('released results refused: no lab.result.released.read 403 PERMISSION_DENIED; a facility without membership 403 FACILITY_ACCESS_DENIED; a doctor of another facility 404 by row-level security (by order and by result); Identity denial 403 LAB_EXECUTION_ACCESS_DENIED (by order and by result); an order without a work item 404; no read audit row for any refusal');

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
  // OCR stores a Lab 5xx as the retryable OWNING_SERVICE_UNAVAILABLE and a Lab 4xx as a terminal refusal of the reviewed
  // publication (ocr-api ocr.service.ts), so the OCR import keeps answering a database refusal 500.
  const ocrCorrelation = 'verifier-ocr-import-without-consent-0001';
  refusedByDatabase(await send('/imports/from-ocr', ocrBody, { token: 'token-b', key: key('ocr'), internal: 'ocr-api',
    correlationId: ocrCorrelation }), 'OCR import without a database consent');
  assert.deepEqual(await Promise.all([count('select count(*) from lab.imported_evidence where publication_id=$1', [f.ocr.publication]),
    count("select count(*) from audit.events where correlation_id=$1 and action='lab.import.create'", [ocrCorrelation])]), [0, 0],
  'OCR import without a database consent wrote imported evidence or its audit event');
  check('import from OCR: no database consent refused by row-level security (42501) still answers 500 INTERNAL_ERROR, which OCR stores as the retryable OWNING_SERVICE_UNAVAILABLE, not a terminal 4xx; nothing written');
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
