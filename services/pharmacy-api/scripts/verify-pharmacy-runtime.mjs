#!/usr/bin/env node
// Phase 4 Stage 9: every Pharmacy write command through the real Pharmacy API
// (guard, controller, service, DatabaseService, audit) as hid_pharmacy_api_runtime,
// on a disposable copy of the owned synthetic rehearsal. Before Stage 9 each of
// them failed with 42501: the commands locked insert-only rows (work items,
// dispensings, reversals, imports) that the runtime role cannot update. Only
// the Identity API is replaced, by a local fake that answers its service
// session and authorization calls; every database check (row-level security,
// the 0077 guards, the immutability triggers, unique constraints) is real.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { disposableDatabase, expectStatus, fakeService, startService } from '../../../scripts/service-runtime-harness.mjs';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const RUNTIME_ROLE = 'hid_pharmacy_api_runtime';
const PHARMACY_TOKEN = 'public-synthetic-pharmacy-internal-token-0001';
const IDENTITY_TOKEN = 'public-synthetic-identity-pharmacy-token-0001';
const evidence = { runAs: RUNTIME_ROLE, database: 'disposable copy of hid_rehearsal', checks: [] };
const check = (name) => evidence.checks.push(name);

// The fake Identity API: bearer token -> actor, and per account, patient and
// scope authorization decisions.
const actors = new Map();
const decisions = new Map();
const identity = await fakeService(({ path, headers, body }) => {
  if (headers['x-hid-internal-caller'] !== 'pharmacy-api' || headers['x-hid-service-token'] !== IDENTITY_TOKEN) {
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

const database = await disposableDatabase(require, 'pharmacy');
for (const key of Object.keys(process.env)) if (/^(PHARMACY|IDENTITY)_/.test(key)) delete process.env[key];
Object.assign(process.env, { DATABASE_URL: database.url(RUNTIME_ROLE), DATABASE_POOL_MAX: '8',
  IDENTITY_API_URL: identity.url, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: IDENTITY_TOKEN, PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret',
  PHARMACY_INTERNAL_SERVICE_TOKEN: PHARMACY_TOKEN });
let pharmacy;
try {
  const id = () => randomUUID();
  const f = { org: id(), facility: id(), patient: id(), encounter: id(), prescriber: id(),
    a: { account: id(), staff: id(), membership: id() }, b: { account: id(), staff: id(), membership: id() },
    work: Array.from({ length: 5 }, () => ({ id: id(), prescription: id() })), dispensing: id() };
  f.a.subject = `synthetic:pharmacy-verifier-a:${f.a.account}`;
  f.b.subject = `synthetic:pharmacy-verifier-b:${f.b.account}`;
  const insertWorkItem = (client, work) => client.query(`insert into pharmacy.work_items (id,patient_id,facility_id,
      ordering_facility_id,source_ehr_prescription_id,source_ehr_prescription_version,source_encounter_id,source_status,
      medication_code_system,medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
      prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,acceptance_reason,idempotency_key,request_sha256,
      correlation_id) values ($1,$2,$3,$3,$4,1,$5,'active','urn:synthetic:medication','amoxicillin-500mg','Amoxicillin 500 mg',
      1,'tablet','oral','Every 8 hours','Take after food',$6,'2026-10-01 08:00:00+00',$7,$8,'Synthetic prescription accepted',
      $9,repeat('a',64),'pharmacy-verifier-fixture')`,
  [work.id, f.patient, f.facility, work.prescription, f.encounter, f.prescriber, f.a.account, f.a.membership,
    `verifier-accept-${work.id}`]);
  await database.fixture(async (client) => {
    await client.query('insert into identity.organizations (id,name,slug) values ($1,$2,$3)',
      [f.org, 'Pharmacy Verifier Org', `pharmacy-verifier-${f.org.slice(0, 8)}`]);
    await client.query(`insert into identity.facilities (id,organization_id,name,code,timezone,active,lifecycle_status)
      values ($1,$2,'Pharmacy Verifier Clinic',$3,'Africa/Lagos',true,'verified')`, [f.facility, f.org, `PV-${f.facility.slice(0, 8)}`]);
    for (const [name, member] of [['a', f.a], ['b', f.b]]) {
      await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,$4,'active')`,
        [member.account, member.subject, `pharmacy-verifier-${name}-${member.account}@example.invalid`, `Pharmacy Verifier ${name}`]);
      await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
        values ($1,$2,$3,$4,'verified','pharmacist')`, [member.staff, member.account, `Pharmacy Verifier ${name}`,
        `pharmacy-verifier-${name}-${member.account}@example.invalid`]);
      await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
        membership_role,app_role) values ($1,$2,$3,$4,$5,'pharmacist','pharmacist')`,
      [member.membership, member.staff, member.account, f.org, f.facility]);
    }
    await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,'Verifier prescriber','active')`,
      [f.prescriber, `synthetic:pharmacy-verifier-prescriber:${f.prescriber}`, `prescriber-${f.prescriber}@example.invalid`]);
    await client.query(`insert into identity.patients (id,hid_code,first_name,last_name,full_name,status)
      values ($1,'HID-PHVRFYAA','Verifier','Patient','Verifier Patient','active')`, [f.patient]);
    await client.query(`insert into identity.purpose_of_use_codes (code,display,source_system)
      values ('direct-care','Direct patient care','pharmacy-verifier') on conflict (code) do nothing`);
    // Only A holds a database consent grant. B is allowed by the fake Identity
    // but not by the database, so row-level security must hide the rows from B.
    await client.query(`insert into identity.consent_grants (id,patient_id,staff_id,account_id,membership_id,facility_id,scope,
      purpose_of_use,status,reason,starts_at,expires_at) values ($1,$2,$3,$4,$5,$6,'write_records','direct-care','active',
      'Synthetic Pharmacy verifier consent',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days')`,
    [id(), f.patient, f.a.staff, f.a.account, f.a.membership, f.facility]);
    for (const work of f.work) await insertWorkItem(client, work);
    await client.query(`insert into pharmacy.dispensings (id,work_item_id,work_item_version,patient_id,facility_id,
      medication_code_system,medication_code,medication_display,quantity_dispensed,quantity_unit,dispensed_by,
      dispensed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id) values ($1,$2,1,$3,$4,
      'urn:synthetic:medication','amoxicillin-500mg','Amoxicillin 500 mg',21,'tablet',$5,$6,'Synthetic medication supplied',
      $7,repeat('b',64),'pharmacy-verifier-fixture')`,
    [f.dispensing, f.work[4].id, f.patient, f.facility, f.a.account, f.a.membership, `verifier-dispense-${f.dispensing}`]);
  });
  const permissions = ['pharmacy.work-item.accept', 'pharmacy.work-item.read', 'pharmacy.dispensing.create',
    'pharmacy.dispensing.read', 'pharmacy.dispensing.reverse', 'pharmacy.import.write', 'pharmacy.import.read'];
  const actor = (member, granted) => ({ id: member.account, subject: member.subject, accountId: member.account,
    sessionId: id(), roles: [], permissions: [], facilityIds: [f.facility], authenticationMethod: 'local',
    facilities: [{ id: f.facility, membershipId: member.membership, organizationId: f.org, name: 'Pharmacy Verifier Clinic',
      roles: ['pharmacist'], permissions: granted, isPrimary: true }] });
  actors.set('token-a', actor(f.a, permissions));
  actors.set('token-b', actor(f.b, permissions));
  actors.set('token-a-read-only', actor(f.a, ['pharmacy.work-item.read', 'pharmacy.dispensing.read']));
  const decide = (member, scope, rule) => decisions.set(`${member.account}:${f.patient}:${scope}`, rule);
  for (const member of [f.a, f.b]) for (const scope of ['read_records', 'write_records']) decide(member, scope, { allowed: true, breakGlass: false });

  pharmacy = await startService({ require, service });
  assert.deepEqual((await pharmacy.database.query('select current_user as role')).rows[0], { role: RUNTIME_ROLE });
  check('the API runs as hid_pharmacy_api_runtime');
  const send = (path, body, { token = 'token-a', key, internal, correlationId } = {}) => pharmacy.request('POST', `/pharmacy${path}`, {
    body, correlationId, headers: { authorization: `Bearer ${token}`, 'x-facility-id': f.facility, 'x-purpose-of-use': 'direct-care',
      ...(key ? { 'idempotency-key': key } : {}),
      ...(internal ? { 'x-hid-internal-caller': internal, 'x-hid-service-token': PHARMACY_TOKEN } : {}) } });
  const read = (path, token = 'token-a') => pharmacy.request('GET', `/pharmacy${path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-facility-id': f.facility, 'x-purpose-of-use': 'direct-care' } });
  const key = (label) => `verifier-${label}-${id()}`;
  const count = (sql, values) => database.count(sql, values);
  const together = (size, request) => Promise.all(Array.from({ length: size }, request));
  const sameResult = (responses, label) => {
    for (const response of responses) expectStatus(response, 201, label);
    assert.equal(new Set(responses.map((response) => response.body.id)).size, 1, `${label}: one result`);
    return responses[0].body;
  };

  // Accept an EHR prescription (internal caller ehr-api).
  const acceptBody = (prescription = id()) => ({ sourceEhrPrescriptionId: prescription, sourceEhrPrescriptionVersion: 1,
    sourceEncounterId: f.encounter, patientId: f.patient, orderingFacilityId: f.facility, sourceStatus: 'active',
    medicationDisplay: 'Amoxicillin 500 mg', frequency: 'Every 8 hours', instructions: 'Take after food',
    prescribedBy: f.prescriber, prescribedAt: '2026-10-01T08:00:00.000Z', acceptanceReason: 'Synthetic prescription accepted' });
  const prescription = acceptBody();
  expectStatus(await send('/work-items/accept-ehr-prescription', prescription, { key: key('accept') }), 401, 'accept without the EHR caller');
  decide(f.a, 'write_records', { allowed: false, breakGlass: false });
  assert.equal(expectStatus(await send('/work-items/accept-ehr-prescription', prescription, { key: key('accept'), internal: 'ehr-api' }),
    403, 'accept refused by Identity').code, 'PHARMACY_ACCESS_DENIED');
  decide(f.a, 'write_records', { allowed: true, breakGlass: false });
  assert.equal(await count('select count(*) from pharmacy.work_items where source_ehr_prescription_id=$1', [prescription.sourceEhrPrescriptionId]), 0);
  check('accept: no EHR caller 401, Identity denial 403, nothing written');
  const acceptKey = key('accept');
  const accepted = sameResult(await together(4, () => send('/work-items/accept-ehr-prescription', prescription,
    { key: acceptKey, internal: 'ehr-api' })), 'four concurrent identical accepts');
  assert.deepEqual(await Promise.all([
    count('select count(*) from pharmacy.work_items where source_ehr_prescription_id=$1', [prescription.sourceEhrPrescriptionId]),
    count('select count(*) from pharmacy.work_item_events where work_item_id=$1', [accepted.id]),
    count('select count(*) from pharmacy.outbox_events where aggregate_id=$1', [accepted.id])]), [1, 1, 1]);
  assert.equal(expectStatus(await send('/work-items/accept-ehr-prescription', prescription, { key: acceptKey, internal: 'ehr-api' }),
    201, 'accept replay').id, accepted.id);
  assert.equal(expectStatus(await send('/work-items/accept-ehr-prescription', { ...prescription, instructions: 'Take before food' },
    { key: acceptKey, internal: 'ehr-api' }), 409, 'accept key reuse').code, 'IDEMPOTENCY_CONFLICT');
  const fresh = acceptBody();
  sameResult(await Promise.all(['one', 'two', 'three'].map((label) => send('/work-items/accept-ehr-prescription', fresh,
    { key: key(`accept-${label}`), internal: 'ehr-api' }))), 'three concurrent accepts of one prescription with different keys');
  assert.equal(await count('select count(*) from pharmacy.work_items where source_ehr_prescription_id=$1', [fresh.sourceEhrPrescriptionId]), 1);
  check('accept: four concurrent identical and three concurrent different-key accepts each create one work item; replay 201; key reuse 409');

  // Dispense a work item.
  const [w1, w2, w3] = f.work.map((work) => work.id);
  const dispenseBody = { expectedWorkItemVersion: 1, quantityDispensed: 21, quantityUnit: 'tablet', reason: 'Synthetic medication supplied' };
  assert.equal(expectStatus(await send(`/work-items/${w1}/dispensings`, dispenseBody, { token: 'token-a-read-only', key: key('dispense') }),
    403, 'dispense without the permission').code, 'PERMISSION_DENIED');
  assert.equal(expectStatus(await send(`/work-items/${w1}/dispensings`, dispenseBody, { token: 'token-b', key: key('dispense') }),
    404, 'dispense without a database consent').code, 'PHARMACY_WORK_ITEM_NOT_FOUND');
  decide(f.a, 'write_records', { allowed: true, breakGlass: true });
  assert.equal(expectStatus(await send(`/work-items/${w1}/dispensings`, dispenseBody, { key: key('dispense') }),
    403, 'dispense under break-glass').code, 'PHARMACY_ACCESS_DENIED');
  decide(f.a, 'write_records', { allowed: true, breakGlass: false });
  assert.equal(expectStatus(await send(`/work-items/${w1}/dispensings`, { ...dispenseBody, expectedWorkItemVersion: 2 }, { key: key('dispense') }),
    412, 'dispense at a stale version').code, 'PHARMACY_WORK_ITEM_VERSION_CONFLICT');
  assert.equal(await count('select count(*) from pharmacy.dispensings where work_item_id=$1', [w1]), 0);
  check('dispense: missing permission 403, no database consent 404 (row-level security), break-glass 403, stale version 412, nothing written');
  const dispenseKey = key('dispense');
  const dispensed = sameResult(await together(6, () => send(`/work-items/${w1}/dispensings`, dispenseBody, { key: dispenseKey })),
    'six concurrent identical dispenses');
  assert.deepEqual(await Promise.all([count('select count(*) from pharmacy.dispensings where work_item_id=$1', [w1]),
    count('select count(*) from pharmacy.outbox_events where aggregate_id=$1', [dispensed.id]),
    count("select count(*) from audit.events where resource_id=$1 and action='pharmacy.dispensing.create'", [dispensed.id])]), [1, 1, 1]);
  assert.equal(expectStatus(await send(`/work-items/${w1}/dispensings`, dispenseBody, { key: dispenseKey }), 201, 'dispense replay').id, dispensed.id);
  assert.equal(expectStatus(await send(`/work-items/${w1}/dispensings`, { ...dispenseBody, quantityDispensed: 20 }, { key: dispenseKey }),
    409, 'dispense key reuse').code, 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED');
  const rivals = await Promise.all([21, 14].map((quantity) => send(`/work-items/${w2}/dispensings`,
    { ...dispenseBody, quantityDispensed: quantity }, { key: key(`rival-${quantity}`) })));
  assert.deepEqual(rivals.map((response) => response.status).sort(), [201, 409], JSON.stringify(rivals.map((r) => r.body)));
  assert.equal(rivals.find((response) => response.status === 409).body.code, 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED');
  assert.equal(await count('select count(*) from pharmacy.dispensings where work_item_id=$1', [w2]), 1);
  check('dispense: six concurrent identical requests dispense once and all return it; two different concurrent dispenses: 201 and 409');

  // Rollback: the outbox insert of one request fails after its dispensing insert.
  await database.owner.query(`create function public.verifier_fail_outbox() returns trigger language plpgsql security definer as $f$
    begin if new.correlation_id = 'verifier-rollback-pharmacy-0001' then
      raise exception using errcode = 'P0001', message = 'Synthetic outbox failure'; end if; return new; end $f$`);
  await database.owner.query(`create trigger verifier_fail_outbox before insert on pharmacy.outbox_events
    for each row execute function public.verifier_fail_outbox()`);
  const rollbackKey = key('rollback');
  const failed = await send(`/work-items/${w3}/dispensings`, dispenseBody, { key: rollbackKey, correlationId: 'verifier-rollback-pharmacy-0001' });
  expectStatus(failed, 500, 'dispense with a failing outbox insert');
  assert.equal(failed.sqlstate, 'P0001');
  assert.deepEqual(await Promise.all([count('select count(*) from pharmacy.dispensings where work_item_id=$1', [w3]),
    count("select count(*) from audit.events where correlation_id='verifier-rollback-pharmacy-0001'")]), [0, 0]);
  const recovered = expectStatus(await send(`/work-items/${w3}/dispensings`, dispenseBody, { key: rollbackKey }), 201, 'dispense after the failure');
  assert.equal(await count('select count(*) from pharmacy.dispensings where work_item_id=$1', [w3]), 1);
  check('dispense: a failure after the dispensing insert rolls back the dispensing and its audit; the same key then succeeds');

  // Reverse a dispensing.
  const reverseBody = { expectedDispensingVersion: 1, reason: 'Synthetic dispensing reversed' };
  assert.equal(expectStatus(await send(`/dispensings/${f.dispensing}/reversals`, reverseBody, { token: 'token-b', key: key('reverse') }),
    404, 'reverse without a database consent').code, 'PHARMACY_DISPENSING_NOT_FOUND');
  assert.equal(expectStatus(await send(`/dispensings/${f.dispensing}/reversals`, reverseBody, { token: 'token-a-read-only', key: key('reverse') }),
    403, 'reverse without the permission').code, 'PERMISSION_DENIED');
  assert.equal(expectStatus(await send(`/dispensings/${f.dispensing}/reversals`, { ...reverseBody, expectedDispensingVersion: 2 },
    { key: key('reverse') }), 412, 'reverse at a stale version').code, 'PHARMACY_DISPENSING_VERSION_CONFLICT');
  const reverseKey = key('reverse');
  const reversal = sameResult(await together(4, () => send(`/dispensings/${f.dispensing}/reversals`, reverseBody, { key: reverseKey })),
    'four concurrent identical reversals');
  assert.equal(await count('select count(*) from pharmacy.dispensing_reversals where dispensing_id=$1', [f.dispensing]), 1);
  assert.equal(expectStatus(await send(`/dispensings/${f.dispensing}/reversals`, reverseBody, { key: reverseKey }), 201, 'reverse replay').id, reversal.id);
  assert.equal(expectStatus(await send(`/dispensings/${f.dispensing}/reversals`, { ...reverseBody, reason: 'A different synthetic reason' },
    { key: key('reverse') }), 409, 'second reversal').code, 'PHARMACY_DISPENSING_ALREADY_REVERSED');
  assert.equal(expectStatus(await read(`/dispensings/${f.dispensing}`), 200, 'read the reversed dispensing').effectiveStatus, 'reversed');
  const recoveredReversal = await Promise.all([send(`/dispensings/${recovered.id}/reversals`, reverseBody, { key: key('rival-a') }),
    send(`/dispensings/${recovered.id}/reversals`, { ...reverseBody, reason: 'A rival synthetic reversal' }, { key: key('rival-b') })]);
  assert.deepEqual(recoveredReversal.map((response) => response.status).sort(), [201, 409]);
  check('reverse: no consent 404, missing permission 403, stale version 412; four concurrent identical reversals reverse once; rivals 201 and 409');

  // Import OCR medication evidence (internal caller ocr-api).
  const importBody = { patientId: f.patient, sourceDocumentId: id(), ocrJobId: id(), extractionId: id(), validationId: id(),
    validationVersion: 1, publicationId: id(), reviewedBy: f.a.account, medicationText: 'Amoxicillin 500 mg' };
  const importKey = `ocr-publication:${importBody.publicationId}`;
  expectStatus(await send('/imports/from-ocr', importBody, { key: importKey }), 401, 'import without the OCR caller');
  decide(f.a, 'write_records', { allowed: false, breakGlass: false });
  expectStatus(await send('/imports/from-ocr', importBody, { key: importKey, internal: 'ocr-api' }), 403, 'import refused by Identity');
  decide(f.a, 'write_records', { allowed: true, breakGlass: false });
  const imported = sameResult(await together(4, () => send('/imports/from-ocr', importBody, { key: importKey, internal: 'ocr-api' })),
    'four concurrent identical imports');
  assert.equal(await count('select count(*) from pharmacy.imported_medication_evidence where publication_id=$1', [importBody.publicationId]), 1);
  assert.equal(expectStatus(await send('/imports/from-ocr', importBody, { key: importKey, internal: 'ocr-api' }), 201, 'import replay').id, imported.id);
  assert.equal(expectStatus(await send('/imports/from-ocr', { ...importBody, medicationText: 'Paracetamol 500 mg' },
    { key: key('import'), internal: 'ocr-api' }), 409, 'second import of one publication').code, 'IDEMPOTENCY_CONFLICT');
  // B is allowed by Identity but holds no consent: row-level security refuses
  // the insert itself (42501), which the API reports as a 5xx, and nothing is written.
  const unconsented = { ...importBody, publicationId: id() };
  const refused = await send('/imports/from-ocr', unconsented, { token: 'token-b', key: key('import'), internal: 'ocr-api' });
  expectStatus(refused, 500, 'import without a database consent');
  assert.equal(refused.sqlstate, '42501');
  assert.equal(await count('select count(*) from pharmacy.imported_medication_evidence where publication_id=$1', [unconsented.publicationId]), 0);
  check('import: no OCR caller 401, Identity denial 403, no database consent refused by row-level security (42501, nothing written); four concurrent identical imports import once; replay 201; second import 409');
  await pharmacy.close();
  pharmacy = undefined;
  assert.equal(await database.deadlocks(), 0, 'PostgreSQL detected a deadlock during the run');
  check('no deadlock: pg_stat_database reports none for the run, retried commands included');
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...evidence })}\n`);
} finally {
  await pharmacy?.close();
  await database.close();
  await identity.close();
}
