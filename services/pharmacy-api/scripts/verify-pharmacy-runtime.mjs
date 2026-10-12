#!/usr/bin/env node
// Phase 4 Stage 9: every Pharmacy write command through the real Pharmacy API
// (guard, controller, service, DatabaseService, audit) as hid_pharmacy_api_runtime,
// on a disposable copy of the owned synthetic rehearsal. Before Stage 9 each of
// them failed with 42501: the commands locked insert-only rows (work items,
// dispensings, reversals, imports) that the runtime role cannot update. Only
// the Identity API is replaced, by a local fake that answers its service
// session and authorization calls; every database check (row-level security,
// the 0077 guards, the immutability triggers, unique constraints) is real.
//
// Pharmacy work is bound to its EHR prescription (0080): the fixture holds a
// real ehr.prescriptions row for every work item and acceptance, accepted with
// its created_at at the microsecond as the EHR sends it. An acceptance that is
// not the exact active prescription version, and a dispensing whose
// prescription is no longer active at the accepted version, are refused with
// 409, including when the EHR cancels the prescription while the dispensing
// runs. The acceptance does not compare the prescription time or dates in this
// release, so the millisecond, and the day-early dates of a process east of
// UTC, that an earlier EHR build sends are still accepted. The EHR's
// cancel is played by the database owner: it locks the row and sets status and
// row_version as the EHR's update does, with triggers off.
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
// Milliseconds the fake takes to answer an authorization check, as a real
// Identity API does; dispense and reverse make that call inside their
// SERIALIZABLE transaction.
let authorizationLatency = () => 0;
// Runs before each authorization answer: a dispense has taken its snapshot by
// then and has not yet inserted, so a step run here lands between the two.
let beforeAuthorization = async () => undefined;
const identity = await fakeService(async ({ path, headers, body }) => {
  if (headers['x-hid-internal-caller'] !== 'pharmacy-api' || headers['x-hid-service-token'] !== IDENTITY_TOKEN) {
    return [401, { code: 'WORKLOAD_AUTHENTICATION_REQUIRED', detail: 'Synthetic Identity refused the workload' }];
  }
  const actor = actors.get(String(headers.authorization ?? '').replace(/^Bearer /, ''));
  if (!actor) return [401, { code: 'AUTHENTICATION_REQUIRED', detail: 'Unknown synthetic session' }];
  if (path === '/api/v1/auth/service-session') return [200, { actor }];
  if (path === '/api/v1/identity/service/authorization/check') {
    await new Promise((resolve) => setTimeout(resolve, authorizationLatency()));
    await beforeAuthorization(body);
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
  const workItem = () => ({ id: id(), prescription: id() });
  const f = { org: id(), facility: id(), patient: id(), encounter: id(),
    prescriber: { account: id(), staff: id(), membership: id() },
    a: { account: id(), staff: id(), membership: id() }, b: { account: id(), staff: id(), membership: id() },
    work: Array.from({ length: 5 }, workItem), dispensing: id(),
    parallel: Array.from({ length: 8 }, workItem),
    // Work items whose prescription the EHR cancels around a dispense.
    source: { cancelled: workItem(), racing: workItem(), waiting: workItem(), rolledBack: workItem(), holding: workItem() },
    // Prescriptions not accepted yet: the exact snapshot is accepted; one is
    // cancelled after the EHR's eligibility check, one is offered with its time
    // truncated to the millisecond and one with its start date a day early.
    accept: { exact: id(), fresh: id(), cancelled: id(), millisecond: id(), dayEarly: id() } };
  f.a.subject = `synthetic:pharmacy-verifier-a:${f.a.account}`;
  f.b.subject = `synthetic:pharmacy-verifier-b:${f.b.account}`;
  // The acceptance snapshot of every unaccepted prescription: what the EHR sends
  // (prescriptions.service.ts), created_at at the microsecond and dates as text.
  const snapshot = { medicationCodeSystem: 'urn:synthetic:medication', medicationCode: 'amoxicillin-500mg',
    medicationDisplay: 'Amoxicillin 500 mg', doseQuantity: 1, doseUnit: 'tablet', routeCode: 'oral',
    frequency: 'Every 8 hours', instructions: 'Take after food', startsOn: '2026-10-01', endsOn: '2026-10-08',
    prescribedAt: '2026-10-01T09:30:00.654321Z' };
  const insertPrescription = (client, prescription, { status = 'active', version = 1, accepted = true } = {}) => client.query(
    `insert into ehr.prescriptions (id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
      medication_code_system,medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
      starts_on,ends_on,status,row_version,created_at) values ($1,$2,$3,$4,$5,$6,'urn:synthetic:medication','amoxicillin-500mg',
      'Amoxicillin 500 mg',1,'tablet','oral','Every 8 hours','Take after food',$7,$8,$9,$10,$11)`,
    [prescription, f.encounter, f.patient, f.facility, f.prescriber.account, f.prescriber.membership,
      accepted ? null : snapshot.startsOn, accepted ? null : snapshot.endsOn, status, version,
      accepted ? '2026-10-01 08:00:00+00' : snapshot.prescribedAt]);
  const insertWorkItem = (client, work) => client.query(`insert into pharmacy.work_items (id,patient_id,facility_id,
      ordering_facility_id,source_ehr_prescription_id,source_ehr_prescription_version,source_encounter_id,source_status,
      medication_code_system,medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
      prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,acceptance_reason,idempotency_key,request_sha256,
      correlation_id) values ($1,$2,$3,$3,$4,1,$5,'active','urn:synthetic:medication','amoxicillin-500mg','Amoxicillin 500 mg',
      1,'tablet','oral','Every 8 hours','Take after food',$6,'2026-10-01 08:00:00+00',$7,$8,'Synthetic prescription accepted',
      $9,repeat('a',64),'pharmacy-verifier-fixture')`,
  [work.id, f.patient, f.facility, work.prescription, f.encounter, f.prescriber.account, f.a.account, f.a.membership,
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
      [f.prescriber.account, `synthetic:pharmacy-verifier-prescriber:${f.prescriber.account}`,
        `prescriber-${f.prescriber.account}@example.invalid`]);
    await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
      values ($1,$2,'Verifier prescriber',$3,'verified','doctor')`, [f.prescriber.staff, f.prescriber.account,
      `prescriber-${f.prescriber.account}@example.invalid`]);
    await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
      membership_role,app_role) values ($1,$2,$3,$4,$5,'doctor','doctor')`,
    [f.prescriber.membership, f.prescriber.staff, f.prescriber.account, f.org, f.facility]);
    await client.query(`insert into identity.patients (id,hid_code,first_name,last_name,full_name,status)
      values ($1,'HID-PHVRFYAA','Verifier','Patient','Verifier Patient','active')`, [f.patient]);
    await client.query(`insert into ehr.encounters (id,patient_id,facility_id,created_by,created_by_membership_id,
      encounter_type,status,started_at) values ($1,$2,$3,$4,$5,'ambulatory','in_progress','2026-10-01 07:30:00+00')`,
    [f.encounter, f.patient, f.facility, f.prescriber.account, f.prescriber.membership]);
    await client.query(`insert into identity.purpose_of_use_codes (code,display,source_system)
      values ('direct-care','Direct patient care','pharmacy-verifier') on conflict (code) do nothing`);
    // Only A holds a database consent grant. B is allowed by the fake Identity
    // but not by the database, so row-level security must hide the rows from B.
    await client.query(`insert into identity.consent_grants (id,patient_id,staff_id,account_id,membership_id,facility_id,scope,
      purpose_of_use,status,reason,starts_at,expires_at) values ($1,$2,$3,$4,$5,$6,'write_records','direct-care','active',
      'Synthetic Pharmacy verifier consent',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days')`,
    [id(), f.patient, f.a.staff, f.a.account, f.a.membership, f.facility]);
    // Each accepted work item's prescription, active at the version it accepted.
    const accepted = [...f.work, ...f.parallel, ...Object.values(f.source)];
    for (const work of accepted) await insertPrescription(client, work.prescription);
    for (const work of accepted) await insertWorkItem(client, work);
    await insertPrescription(client, f.accept.exact, { accepted: false });
    await insertPrescription(client, f.accept.fresh, { accepted: false });
    await insertPrescription(client, f.accept.millisecond, { accepted: false });
    await insertPrescription(client, f.accept.dayEarly, { accepted: false });
    // Cancelled after the EHR checked it at version 1: the EHR's update moved it to version 2.
    await insertPrescription(client, f.accept.cancelled, { accepted: false, status: 'cancelled', version: 2 });
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

  // The EHR's cancel of a prescription, played by the owner: the EHR locks the
  // row and its update moves the prescription to its next version.
  const cancelPrescription = (prescription) => database.fixture(async (client) => {
    await client.query('select id from ehr.prescriptions where id=$1 for update', [prescription]);
    await client.query(`update ehr.prescriptions set status='cancelled',row_version=row_version+1,updated_at=clock_timestamp()
      where id=$1`, [prescription]);
  });
  const workItemsOf = (prescription) => count('select count(*) from pharmacy.work_items where source_ehr_prescription_id=$1',
    [prescription]);

  // Accept an EHR prescription (internal caller ehr-api): the exact snapshot the
  // EHR sends at the version it checked.
  const acceptBody = (prescription) => ({ sourceEhrPrescriptionId: prescription, sourceEhrPrescriptionVersion: 1,
    sourceEncounterId: f.encounter, patientId: f.patient, orderingFacilityId: f.facility, sourceStatus: 'active',
    ...snapshot, prescribedBy: f.prescriber.account, acceptanceReason: 'Synthetic prescription accepted' });
  const prescription = acceptBody(f.accept.exact);
  expectStatus(await send('/work-items/accept-ehr-prescription', prescription, { key: key('accept') }), 401, 'accept without the EHR caller');
  decide(f.a, 'write_records', { allowed: false, breakGlass: false });
  assert.equal(expectStatus(await send('/work-items/accept-ehr-prescription', prescription, { key: key('accept'), internal: 'ehr-api' }),
    403, 'accept refused by Identity').code, 'PHARMACY_ACCESS_DENIED');
  decide(f.a, 'write_records', { allowed: true, breakGlass: false });
  assert.equal(await count('select count(*) from pharmacy.work_items where source_ehr_prescription_id=$1', [prescription.sourceEhrPrescriptionId]), 0);
  check('accept: no EHR caller 401, Identity denial 403, nothing written');
  // Pharmacy accepts only the exact active EHR prescription version (0080).
  // Before 0080 each of these created a work item (201).
  const ineligible = async (body, label) => {
    const correlationId = `verifier-ineligible-${id()}`;
    assert.equal(expectStatus(await send('/work-items/accept-ehr-prescription', body,
      { key: key('accept-ineligible'), internal: 'ehr-api', correlationId }), 409, label).code,
    'PHARMACY_PRESCRIPTION_NOT_ELIGIBLE', label);
    assert.deepEqual(await Promise.all([workItemsOf(body.sourceEhrPrescriptionId),
      count('select count(*) from pharmacy.outbox_events where correlation_id=$1', [correlationId]),
      count('select count(*) from audit.events where correlation_id=$1', [correlationId])]), [0, 0, 0], `${label}: nothing written`);
  };
  await ineligible(acceptBody(id()), 'accept a prescription that does not exist');
  await ineligible(acceptBody(f.accept.cancelled), 'accept a prescription cancelled after the EHR checked it');
  check('accept: a prescription that does not exist and one cancelled after the EHR checked it are each refused 409 PHARMACY_PRESCRIPTION_NOT_ELIGIBLE; nothing written');
  // An EHR build before this change sends created_at through a JavaScript Date,
  // which keeps the millisecond. The acceptance does not compare the time in
  // this release, so such a build can still hand off (deployed after 0080, or
  // rolled back to).
  const millisecond = { ...acceptBody(f.accept.millisecond), prescribedAt: '2026-10-01T09:30:00.654Z' };
  const millisecondAccepted = expectStatus(await send('/work-items/accept-ehr-prescription', millisecond,
    { key: key('accept-millisecond'), internal: 'ehr-api' }), 201, 'accept with the prescription time truncated to the millisecond');
  assert.equal(millisecondAccepted.status, 'accepted');
  assert.equal(await workItemsOf(f.accept.millisecond), 1);
  check('accept: the exact snapshot with the prescription time truncated to the millisecond, as an earlier EHR build sends it, is accepted (201)');
  // Such a build also sends the dates as node-postgres local-midnight Dates,
  // which a process east of UTC renders a day early. The acceptance does not
  // compare the dates in this release either.
  const dayEarly = { ...acceptBody(f.accept.dayEarly), startsOn: '2026-09-30' };
  const dayEarlyAccepted = expectStatus(await send('/work-items/accept-ehr-prescription', dayEarly,
    { key: key('accept-day-early'), internal: 'ehr-api' }), 201, 'accept with the start date a day early');
  assert.equal(dayEarlyAccepted.status, 'accepted');
  assert.equal(await workItemsOf(f.accept.dayEarly), 1);
  check('accept: the exact snapshot with the start date a day early, as an earlier EHR build east of UTC sends it, is accepted (201)');
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
  const fresh = acceptBody(f.accept.fresh);
  sameResult(await Promise.all(['one', 'two', 'three'].map((label) => send('/work-items/accept-ehr-prescription', fresh,
    { key: key(`accept-${label}`), internal: 'ehr-api' }))), 'three concurrent accepts of one prescription with different keys');
  assert.equal(await count('select count(*) from pharmacy.work_items where source_ehr_prescription_id=$1', [fresh.sourceEhrPrescriptionId]), 1);
  check('accept: four concurrent identical and three concurrent different-key accepts each create one work item; replay 201; key reuse 409');
  // An acceptance replayed after the EHR cancelled its prescription returns the
  // work item Pharmacy already holds: the replay is answered before the insert.
  await cancelPrescription(f.accept.exact);
  assert.equal(expectStatus(await send('/work-items/accept-ehr-prescription', prescription, { key: acceptKey, internal: 'ehr-api' }),
    201, 'accept replay after the EHR cancelled the prescription').id, accepted.id);
  assert.equal(await workItemsOf(f.accept.exact), 1);
  check('accept: an identical replay after the EHR cancelled the prescription returns the accepted work item (201)');

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

  // Unrelated concurrent writes. SERIALIZABLE tracks the replay reads by index
  // page, so on small tables transactions on different work items conflict and
  // PostgreSQL cancels all but one of each overlapping group (40001); the
  // authorization call inside the transaction widens the overlap. The retry
  // must still let every request through.
  authorizationLatency = () => 20 + Math.floor(Math.random() * 21);
  const parallelDispensed = await Promise.all(f.parallel.map((work) => send(`/work-items/${work.id}/dispensings`, dispenseBody,
    { key: key('parallel-dispense') })));
  for (const response of parallelDispensed) expectStatus(response, 201, 'eight concurrent dispenses of different work items');
  const parallelReversed = await Promise.all(parallelDispensed.map((response) => send(`/dispensings/${response.body.id}/reversals`,
    reverseBody, { key: key('parallel-reverse') })));
  for (const response of parallelReversed) expectStatus(response, 201, 'eight concurrent reversals of different dispensings');
  authorizationLatency = () => 0;
  assert.deepEqual(await Promise.all([
    count('select count(*) from pharmacy.dispensings where work_item_id = any($1::uuid[])', [f.parallel.map((work) => work.id)]),
    count('select count(*) from pharmacy.dispensing_reversals where dispensing_id = any($1::uuid[])',
      [parallelDispensed.map((response) => response.body.id)])]), [8, 8]);
  check('dispense and reverse: eight concurrent requests on different work items, with 20-40 ms Identity latency inside the transaction, all succeed once');

  // Pharmacy dispenses only while the EHR prescription is active at the version
  // it accepted (0080): pharmacy.validate_dispensing reads the prescription with
  // a share lock. Before 0080 each of these dispensings was recorded (201).
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dispensingsOf = (work) => count('select count(*) from pharmacy.dispensings where work_item_id=$1', [work.id]);
  const notDispensable = (response, label) => assert.equal(expectStatus(response, 409, label).code,
    'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE', label);
  // Waits until the request's statement waits as named in pg_stat_activity,
  // failing if the request answers first.
  const untilWaiting = async (pending, waitEventType, statement, label) => {
    let answered = false;
    pending.then(() => { answered = true; }, () => { answered = true; });
    for (let waited = 0; ; waited += 20) {
      if (await count(`select count(*) from pg_stat_activity where datname = current_database()
        and wait_event_type = $1 and query ilike $2`, [waitEventType, `%${statement}%`]) > 0) return;
      assert(!answered, `${label}: the request answered before it waited (${waitEventType})`);
      assert(waited < 10_000, `${label}: the request never waited (${waitEventType})`);
      await sleep(20);
    }
  };
  // The EHR cancelled the prescription before the dispense.
  const { cancelled, racing, waiting, rolledBack, holding } = f.source;
  await cancelPrescription(cancelled.prescription);
  const cancelledCorrelation = `verifier-cancelled-${id()}`;
  notDispensable(await send(`/work-items/${cancelled.id}/dispensings`, dispenseBody,
    { key: key('dispense-cancelled'), correlationId: cancelledCorrelation }), 'dispense after the EHR cancelled the prescription');
  assert.deepEqual(await Promise.all([dispensingsOf(cancelled),
    count('select count(*) from pharmacy.outbox_events where correlation_id=$1', [cancelledCorrelation]),
    count('select count(*) from audit.events where correlation_id=$1', [cancelledCorrelation])]), [0, 0, 0]);
  check('dispense: after the EHR cancelled the prescription, 409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE; no dispensing, outbox or audit row');
  // A dispensing recorded before the cancel is still replayed, and can still be reversed.
  await cancelPrescription(f.work[0].prescription);
  assert.equal(expectStatus(await send(`/work-items/${w1}/dispensings`, dispenseBody, { key: dispenseKey }), 201,
    'dispense replay after the EHR cancelled the prescription').id, dispensed.id);
  assert.equal(expectStatus(await send(`/dispensings/${dispensed.id}/reversals`, reverseBody, { key: key('reverse-cancelled') }),
    201, 'reverse a dispensing whose prescription the EHR cancelled since').status, 'reversed');
  check('dispense: a dispensing recorded before the EHR cancel is replayed (201) and can be reversed (201)');
  // The EHR cancel commits after the dispense took its snapshot and before its
  // insert: the share lock finds the row changed (40001), and the retry reads
  // the cancel. A plain read would dispense against the snapshot.
  let racingAuthorizations = 0;
  beforeAuthorization = async () => {
    racingAuthorizations += 1;
    if (racingAuthorizations === 1) await cancelPrescription(racing.prescription);
  };
  try {
    notDispensable(await send(`/work-items/${racing.id}/dispensings`, dispenseBody, { key: key('dispense-racing') }),
      'dispense while the EHR cancel commits');
  } finally { beforeAuthorization = async () => undefined; }
  assert.equal(racingAuthorizations, 2, 'the dispense ran a second time after the serialization failure');
  assert.equal(await dispensingsOf(racing), 0);
  check('dispense: an EHR cancel committed after the dispense took its snapshot is refused 409 on the retry after 40001; no dispensing');
  // The EHR's cancel is in progress and holds the row lock: the dispense waits
  // for it, then is refused once it commits, or goes through if it rolls back.
  for (const [work, outcome] of [[waiting, 'commit'], [rolledBack, 'rollback']]) {
    const ehr = await database.owner.connect();
    let open = false;
    try {
      await ehr.query('begin');
      open = true;
      await ehr.query('set local session_replication_role = replica');
      await ehr.query('select id from ehr.prescriptions where id=$1 for update', [work.prescription]);
      await ehr.query(`update ehr.prescriptions set status='cancelled',row_version=row_version+1,updated_at=clock_timestamp()
        where id=$1`, [work.prescription]);
      const pending = send(`/work-items/${work.id}/dispensings`, dispenseBody, { key: key(`dispense-${outcome}`) });
      await untilWaiting(pending, 'Lock', 'insert into pharmacy.dispensings', `dispense during an EHR cancel that ends in ${outcome}`);
      await ehr.query(outcome);
      open = false;
      const response = await pending;
      if (outcome === 'commit') notDispensable(response, 'dispense during an EHR cancel that commits');
      else expectStatus(response, 201, 'dispense during an EHR cancel that rolls back');
    } finally {
      if (open) await ehr.query('rollback').catch(() => undefined);
      ehr.release();
    }
  }
  assert.deepEqual(await Promise.all([dispensingsOf(waiting), dispensingsOf(rolledBack)]), [0, 1]);
  check('dispense: waits for an EHR cancel in progress; refused 409 when it commits, recorded (201) when it rolls back');
  // A dispensing in progress holds its share lock until it commits: the EHR
  // cannot lock the prescription meanwhile, and its cancel goes through after.
  await database.owner.query(`create function public.verifier_pause_outbox() returns trigger language plpgsql security definer as $f$
    begin if new.correlation_id = 'verifier-pause-pharmacy-0001' then perform pg_sleep(2); end if; return new; end $f$`);
  await database.owner.query(`create trigger verifier_pause_outbox before insert on pharmacy.outbox_events
    for each row execute function public.verifier_pause_outbox()`);
  const paused = send(`/work-items/${holding.id}/dispensings`, dispenseBody,
    { key: key('dispense-holding'), correlationId: 'verifier-pause-pharmacy-0001' });
  await untilWaiting(paused, 'Timeout', 'insert into pharmacy.outbox_events', 'dispense paused after its dispensing insert');
  await assert.rejects(database.owner.query('select id from ehr.prescriptions where id=$1 for update nowait', [holding.prescription]),
    (error) => error.code === '55P03', 'the EHR locked a prescription that a dispense in progress had share-locked');
  expectStatus(await paused, 201, 'dispense paused after its dispensing insert');
  await cancelPrescription(holding.prescription);
  assert.equal(await count(`select count(*) from ehr.prescriptions where id=$1 and status='cancelled' and row_version=2`,
    [holding.prescription]), 1);
  check('dispense: an EHR row lock on the prescription is refused (55P03) while a dispense holds its share lock; the cancel goes through after the commit');

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
