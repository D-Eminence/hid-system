#!/usr/bin/env node
// Clinical records follow their encounter's status (0084, CLIN-EIE), through
// the real EHR API (AppModule, as hid_ehr_api_runtime, in this process) on a
// disposable copy of the owned synthetic rehearsal database. Only Identity is
// replaced, by a local fake that authorizes one doctor; every database check
// (row-level security, the clinical version trigger, the 0084 encounter
// guards) is real.
//
// Marking an encounter entered in error used to change the encounter row only:
// its notes, diagnoses and open orders kept their status, a completed
// encounter could not be retracted at all, and records could still be added to
// an encounter that was cancelled or entered in error. Now the retraction
// marks every open record of the encounter entered in error in the same
// transaction, under the encounter's row lock; a child create or an order
// activation takes a share lock on the encounter first, so it either commits
// before the retraction (which then retracts it too) or sees the retracted
// encounter and is refused.
//
// Since 0090 (BRANCH:launch/ehr-retraction-integrity) the retraction also
// requires the write permission of every record it changes: a nurse cannot
// retract a doctor's diagnosis or prescription through the encounter (403
// ENCOUNTER_RETRACTION_NOT_PERMITTED, nothing changed, the refusal audited),
// while she may still retract an encounter holding only notes and vitals. The
// retraction now also covers vitals, completed orders and linked documents,
// and returns what it changed; a vital can be entered in error on its own; a
// closed prescription and a closed encounter take no further change; and a
// staff session on the patient's own records route is refused, and audited,
// as 403 PATIENT_SESSION_REQUIRED instead of 503.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { disposableDatabase, expectStatus, fakeService, startService } from '../../../scripts/service-runtime-harness.mjs';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const tokens = { 'ehr-api': `ehr-identity-${randomUUID()}` };
const evidence = { runAs: ['hid_ehr_api_runtime'], database: 'disposable copy of hid_rehearsal', checks: [] };
const check = (name) => evidence.checks.push(name);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const actors = new Map();
const identity = await fakeService(({ path, headers, body }) => {
  const caller = headers['x-hid-internal-caller'];
  if (!Object.hasOwn(tokens, caller) || headers['x-hid-service-token'] !== tokens[caller]) {
    return [401, { code: 'WORKLOAD_AUTHENTICATION_REQUIRED', detail: 'Synthetic Identity refused the workload' }];
  }
  const actor = actors.get(String(headers.authorization ?? '').replace(/^Bearer /, ''));
  if (!actor) return [401, { code: 'AUTHENTICATION_REQUIRED', detail: 'Unknown synthetic session' }];
  if (path === '/api/v1/auth/service-session') return [200, { actor }];
  if (path === '/api/v1/identity/service/authorization/check') {
    const facilityId = headers['x-facility-id'];
    return [200, { allowed: true, patientId: body.patientId, facilityId,
      membershipId: actor.facilities.find((item) => item.id === facilityId)?.membershipId ?? '',
      scope: body.scope, purpose: body.purpose, breakGlass: false }];
  }
  return [404, { code: 'NOT_FOUND' }];
});

const database = await disposableDatabase(require, 'lifecycle');
let ehr;
const { Client } = require('pg');
const side = new Client({ connectionString: database.url('hid_ehr_api_runtime') });
try {
  const id = () => randomUUID();
  const f = { org: id(), facility: id(), patient: id(), doctor: { account: id(), staff: id(), membership: id() },
    nurse: { account: id(), staff: id(), membership: id() } };
  f.doctor.subject = `synthetic:encounter-lifecycle-doctor:${f.doctor.account}`;
  f.nurse.subject = `synthetic:encounter-lifecycle-nurse:${f.nurse.account}`;
  const encounter = { retracted: id(), cancelled: id(), waiting: id(), nurseRefused: id(), nurseAllowed: id(),
    vitalOpen: id() };
  const races = Array.from({ length: 8 }, () => ({ encounter: id(), prescription: id() }));
  // A doctor and a nurse, each holding the seeded role of that name at one
  // clinic and a database consent to write the patient's records there, and
  // the patient's encounters, all in progress. Inserted as the owner with
  // triggers and foreign keys off, as in the SQL suites.
  //
  // The doctor's Identity session below has always carried
  // ehr.lab-request.write, so this verifier exercises lab requests as when
  // Lab ordering is enabled again. Since 0090 the database checks that
  // permission when a retraction changes a lab request, so the copy's doctor
  // role holds it too. At launch no role does (0084), and an encounter holding
  // a lab request cannot be retracted: encounter-retraction.integration.sql
  // covers that state.
  await database.fixture(async (client) => {
    await client.query('insert into identity.organizations (id,name,slug) values ($1,$2,$3)',
      [f.org, 'Encounter Lifecycle Org', `encounter-lifecycle-${f.org.slice(0, 8)}`]);
    await client.query(`insert into identity.facilities (id,organization_id,name,code,timezone,active,lifecycle_status)
      values ($1,$2,'Encounter Lifecycle Clinic',$3,'Africa/Lagos',true,'verified')`, [f.facility, f.org, `ELC-${f.facility.slice(0, 8)}`]);
    await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,'Lifecycle Doctor','active')`,
      [f.doctor.account, f.doctor.subject, `encounter-lifecycle-${f.doctor.account}@example.invalid`]);
    await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
      values ($1,$2,'Lifecycle Doctor',$3,'verified','doctor')`,
    [f.doctor.staff, f.doctor.account, `encounter-lifecycle-${f.doctor.account}@example.invalid`]);
    await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
      membership_role,app_role,active) values ($1,$2,$3,$4,$5,'doctor','doctor',true)`,
    [f.doctor.membership, f.doctor.staff, f.doctor.account, f.org, f.facility]);
    await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,'Lifecycle Nurse','active')`,
      [f.nurse.account, f.nurse.subject, `encounter-lifecycle-${f.nurse.account}@example.invalid`]);
    await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
      values ($1,$2,'Lifecycle Nurse',$3,'verified','nurse')`,
    [f.nurse.staff, f.nurse.account, `encounter-lifecycle-${f.nurse.account}@example.invalid`]);
    await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
      membership_role,app_role,active) values ($1,$2,$3,$4,$5,'nurse','nurse',true)`,
    [f.nurse.membership, f.nurse.staff, f.nurse.account, f.org, f.facility]);
    for (const [actor, role] of [[f.doctor, 'doctor'], [f.nurse, 'nurse']]) {
      await client.query(`insert into auth.account_roles (id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
        values ($1,$2,$3,'facility',$4,$5,'Synthetic encounter lifecycle role')`, [id(), actor.account, role, actor.membership, f.facility]);
    }
    await client.query(`insert into auth.role_permissions (role_code,permission_code) values ('doctor','ehr.lab-request.write')
      on conflict do nothing`);
    await client.query(`insert into identity.patients (id,hid_code,first_name,last_name,full_name,status)
      values ($1,'HID-ENCLFCYC','Lifecycle','Patient','Lifecycle Patient','active')`, [f.patient]);
    await client.query(`insert into identity.purpose_of_use_codes (code,display,source_system)
      values ('direct-care','Direct patient care','encounter-lifecycle-verifier') on conflict (code) do nothing`);
    for (const actor of [f.doctor, f.nurse]) {
      await client.query(`insert into identity.consent_grants (id,patient_id,staff_id,account_id,membership_id,facility_id,scope,
        purpose_of_use,status,reason,starts_at,expires_at) values ($1,$2,$3,$4,$5,$6,'write_records','direct-care','active',
        'Synthetic encounter lifecycle consent',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days')`,
      [id(), f.patient, actor.staff, actor.account, actor.membership, f.facility]);
    }
    for (const encounterId of [...Object.values(encounter), ...races.map((race) => race.encounter)]) {
      await client.query(`insert into ehr.encounters (id,patient_id,facility_id,created_by,created_by_membership_id,encounter_type,
        status,started_at) values ($1,$2,$3,$4,$5,'ambulatory','in_progress',clock_timestamp()-interval '1 hour')`,
      [encounterId, f.patient, f.facility, f.doctor.account, f.doctor.membership]);
    }
    for (const race of races) {
      await client.query(`insert into ehr.prescriptions (id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
        medication_display,frequency,instructions,status) values ($1,$2,$3,$4,$5,$6,'Amoxicillin 500 mg','Every 8 hours',
        'Take after food','draft')`, [race.prescription, race.encounter, f.patient, f.facility, f.doctor.account, f.doctor.membership]);
    }
  });
  actors.set('token-doctor', { id: f.doctor.account, subject: f.doctor.subject, accountId: f.doctor.account, sessionId: id(),
    roles: [], permissions: [], facilityIds: [f.facility], authenticationMethod: 'local',
    facilities: [{ id: f.facility, membershipId: f.doctor.membership, organizationId: f.org, name: 'Encounter Lifecycle Clinic',
      roles: ['doctor'], permissions: ['ehr.encounter.read', 'ehr.encounter.write', 'ehr.note.read', 'ehr.note.write',
        'ehr.vital.read', 'ehr.vital.write', 'ehr.diagnosis.read', 'ehr.diagnosis.write', 'ehr.prescription.read',
        'ehr.prescription.write', 'ehr.lab-request.read', 'ehr.lab-request.write'],
      isPrimary: true }] });
  // The seeded nurse role (0006): no diagnosis, prescription or lab-request write.
  actors.set('token-nurse', { id: f.nurse.account, subject: f.nurse.subject, accountId: f.nurse.account, sessionId: id(),
    roles: [], permissions: [], facilityIds: [f.facility], authenticationMethod: 'local',
    facilities: [{ id: f.facility, membershipId: f.nurse.membership, organizationId: f.org, name: 'Encounter Lifecycle Clinic',
      roles: ['nurse'], permissions: ['ehr.encounter.read', 'ehr.encounter.write', 'ehr.note.read', 'ehr.note.write',
        'ehr.vital.read', 'ehr.vital.write', 'ehr.diagnosis.read', 'ehr.prescription.read', 'ehr.lab-request.read',
        'ehr.document.read', 'ehr.document.write'],
      isPrimary: true }] });

  Object.assign(process.env, { NODE_ENV: 'test', CORS_ORIGINS: 'http://127.0.0.1', DATABASE_URL: database.url('hid_ehr_api_runtime'),
    DATABASE_POOL_MAX: '8', STORAGE_MODE: 'disabled', IDENTITY_API_URL: identity.url, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
    IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: tokens['ehr-api'] });
  ehr = await startService({ require, service });
  assert.deepEqual((await ehr.database.query('select current_user as role')).rows[0], { role: 'hid_ehr_api_runtime' });
  check('EHR runs as hid_ehr_api_runtime, with Identity faked');

  const headers = (key, token = 'token-doctor') => ({ authorization: `Bearer ${token}`, 'x-facility-id': f.facility,
    'x-purpose-of-use': 'direct-care', ...(key ? { 'idempotency-key': `verifier-${key}-${id()}` } : {}) });
  const encounterPath = (encounterId) => `/ehr/patients/${f.patient}/encounters/${encounterId}`;
  const post = (encounterId, child, body) => ehr.request('POST', `${encounterPath(encounterId)}/${child}`,
    { headers: headers(child), body });
  const patch = (path, body, correlationId, token) => ehr.request('PATCH', path, { headers: headers(undefined, token), body,
    correlationId });
  const records = {
    // Created as drafts and signed with PATCH, as Health-id does.
    'clinical-notes': { noteType: 'progress', title: 'Synthetic note', status: 'draft', content: 'Synthetic content' },
    vitals: { recordedAt: new Date().toISOString(), pulseBpm: 72, source: 'manual' },
    diagnoses: { codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'J18.9', display: 'Pneumonia, unspecified',
      clinicalStatus: 'active', verificationStatus: 'confirmed' },
    prescriptions: { medicationDisplay: 'Amoxicillin 500 mg', frequency: 'Every 8 hours', instructions: 'Take after food',
      status: 'active' },
    'lab-requests': { testCodeSystem: 'http://loinc.org', testCode: '718-7', testDisplay: 'Haemoglobin', priority: 'routine',
      status: 'draft' },
  };
  const statusOf = async (table, rowId) => (await database.owner.query(
    `select ${table === 'diagnoses' ? 'verification_status' : 'status'} as status from ehr.${table} where id = $1`, [rowId])).rows[0]?.status;
  const encounterVersion = async (encounterId) => Number((await database.owner.query(
    'select row_version from ehr.encounters where id = $1', [encounterId])).rows[0].row_version);
  const childCount = async (table, encounterId) => database.count(
    `select count(*) from ehr.${table} where encounter_id = $1`, [encounterId]);
  const rowVersion = async (table, rowId) => Number((await database.owner.query(
    `select row_version from ehr.${table} where id = $1`, [rowId])).rows[0].row_version);
  const auditRows = async (correlationId) => (await database.owner.query(`select action, outcome, details from audit.events
    where correlation_id = $1 order by sequence_id`, [correlationId])).rows;

  // 1. Records of an open encounter, then its completion: late documentation
  //    stays possible, a new order does not.
  const created = {};
  for (const [child, body] of Object.entries(records)) {
    created[child] = expectStatus(await post(encounter.retracted, child, body), 201, `create ${child} on an open encounter`).id;
  }
  expectStatus(await patch(`${encounterPath(encounter.retracted)}/clinical-notes/${created['clinical-notes']}`,
    { status: 'signed', expectedRowVersion: 1, changeReason: 'Reviewed and signed' }), 200, 'sign the note');
  // A prescription completed before the encounter is (ENC-RETRACT-2: completed orders are retracted too).
  const completedPrescription = expectStatus(await post(encounter.retracted, 'prescriptions', records.prescriptions), 201,
    'second prescription').id;
  expectStatus(await patch(`${encounterPath(encounter.retracted)}/prescriptions/${completedPrescription}`,
    { status: 'completed', expectedRowVersion: 1, changeReason: 'Course finished' }), 200, 'complete the prescription');
  expectStatus(await patch(encounterPath(encounter.retracted), { status: 'completed', endedAt: new Date().toISOString(),
    expectedRowVersion: await encounterVersion(encounter.retracted), changeReason: 'Consultation finished' }), 200,
  'complete the encounter');
  for (const child of ['prescriptions', 'lab-requests']) {
    const table = child.replace('-', '_');
    const before = await childCount(table, encounter.retracted);
    const refused = await post(encounter.retracted, child, records[child]);
    assert.deepEqual([refused.status, refused.body?.code], [409, 'ENCOUNTER_NOT_OPEN'], JSON.stringify(refused.body));
    assert.equal(await childCount(table, encounter.retracted), before, `a refused ${child} create stored a row`);
  }
  const lateNote = expectStatus(await post(encounter.retracted, 'clinical-notes', records['clinical-notes']), 201,
    'late note on a completed encounter').id;
  const lateDiagnosis = expectStatus(await post(encounter.retracted, 'diagnoses', records.diagnoses), 201,
    'late diagnosis on a completed encounter').id;
  check('on a completed encounter a new prescription or lab request is 409 ENCOUNTER_NOT_OPEN with no row written, while a late note and diagnosis are still recorded');

  // 2. The completed encounter is marked entered in error: every open record
  //    of it is retracted in the same transaction, versioned with the reason,
  //    and the audit names the retracted ids.
  const reason = 'Documented on the wrong patient';
  const retractCorrelation = `verifier-retract-${id()}`;
  const retracted = expectStatus(await patch(encounterPath(encounter.retracted), { status: 'entered_in_error',
    expectedRowVersion: await encounterVersion(encounter.retracted), changeReason: reason }, retractCorrelation), 200,
  'mark the completed encounter entered in error');
  assert.equal(retracted.status, 'entered_in_error');
  const expected = { clinical_notes: [created['clinical-notes'], lateNote], diagnoses: [created.diagnoses, lateDiagnosis],
    vitals: [created.vitals], prescriptions: [created.prescriptions, completedPrescription],
    lab_requests: [created['lab-requests']] };
  for (const [table, rowIds] of Object.entries(expected)) {
    for (const rowId of rowIds) assert.equal(await statusOf(table, rowId), 'entered_in_error', `${table} ${rowId} was not retracted`);
  }
  const versions = (await database.owner.query(`select resource_type, resource_id, change_reason from ehr.record_versions
    where correlation_id = $1 and resource_type <> 'encounters' order by resource_type, resource_id`, [retractCorrelation])).rows;
  assert.deepEqual(versions.map((row) => [row.resource_type, row.resource_id, row.change_reason]).sort(),
    Object.entries(expected).flatMap(([table, rowIds]) => rowIds.map((rowId) => [table, rowId, reason])).sort(),
    'each retracted record must have a version with the retraction reason and correlation');
  const audit = (await database.owner.query(`select details from audit.events where action = 'ehr.encounter.update'
    and outcome = 'success' and correlation_id = $1`, [retractCorrelation])).rows;
  assert.equal(audit.length, 1);
  const cascade = { status: 'entered_in_error',
    clinicalNoteIds: expected.clinical_notes.slice().sort(), diagnosisIds: expected.diagnoses.slice().sort(),
    vitalIds: expected.vitals, prescriptionIds: expected.prescriptions.slice().sort(), labRequestIds: expected.lab_requests,
    documentIds: [] };
  assert.deepEqual(audit[0].details.cascade, cascade);
  assert.deepEqual(retracted.cascade, cascade, 'the response must return what the retraction changed');
  check('marking a completed encounter entered in error retracts its signed and late draft notes, diagnoses (verification status), vital, active and completed prescriptions and draft lab request in the same request, each with a version carrying the reason and correlation; the audit and the response list their ids');

  // 3. Nothing is added to an encounter entered in error, and its diagnoses stay retracted.
  for (const child of Object.keys(records)) {
    const table = child.replace('-', '_');
    const before = await childCount(table, encounter.retracted);
    const refused = await post(encounter.retracted, child, records[child]);
    assert.deepEqual([refused.status, refused.body?.code], [409, 'ENCOUNTER_NOT_OPEN'], `${child}: ${JSON.stringify(refused.body)}`);
    assert.equal(await childCount(table, encounter.retracted), before, `a refused ${child} create stored a row`);
  }
  const diagnosisVersion = Number((await database.owner.query('select row_version from ehr.diagnoses where id = $1',
    [created.diagnoses])).rows[0].row_version);
  const reverted = await patch(`${encounterPath(encounter.retracted)}/diagnoses/${created.diagnoses}`,
    { verificationStatus: 'confirmed', expectedRowVersion: diagnosisVersion, changeReason: 'Synthetic revert attempt' });
  assert.deepEqual([reverted.status, reverted.body?.code], [409, 'DIAGNOSIS_NOT_AMENDABLE'], JSON.stringify(reverted.body));
  assert.equal(await statusOf('diagnoses', created.diagnoses), 'entered_in_error');
  check('on an encounter entered in error every child create is 409 ENCOUNTER_NOT_OPEN with no row written, and a retracted diagnosis cannot be confirmed again (409 DIAGNOSIS_NOT_AMENDABLE)');

  // 4. Cancelling an encounter cancels its open orders and leaves its notes.
  const cancelledNote = expectStatus(await post(encounter.cancelled, 'clinical-notes', records['clinical-notes']), 201, 'note').id;
  const cancelledPrescription = expectStatus(await post(encounter.cancelled, 'prescriptions', records.prescriptions), 201, 'rx').id;
  const cancelledLabRequest = expectStatus(await post(encounter.cancelled, 'lab-requests', records['lab-requests']), 201, 'lab').id;
  expectStatus(await patch(encounterPath(encounter.cancelled), { status: 'cancelled',
    expectedRowVersion: await encounterVersion(encounter.cancelled), changeReason: 'Patient left before review' }), 200,
  'cancel the encounter');
  assert.deepEqual([await statusOf('clinical_notes', cancelledNote), await statusOf('prescriptions', cancelledPrescription),
    await statusOf('lab_requests', cancelledLabRequest)], ['draft', 'cancelled', 'cancelled']);
  check('cancelling an encounter cancels its active prescription and draft lab request and leaves its note');

  // 5. A child create in flight holds the encounter: the retraction waits for
  //    it and then retracts it as well.
  await side.connect();
  await side.query('begin');
  await side.query(`select set_config('app.actor_subject',$1,true), set_config('app.facility_id',$2,true),
    set_config('app.correlation_id','verifier-side-transaction',true), set_config('app.membership_id',$3,true),
    set_config('app.purpose_of_use','direct-care',true)`, [f.doctor.subject, f.facility, f.doctor.membership]);
  const sideNote = id();
  await side.query(`insert into ehr.clinical_notes (id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
    note_type,title,status) values ($1,$2,$3,$4,$5,$6,'progress','Synthetic note in flight','draft')`,
  [sideNote, encounter.waiting, f.patient, f.facility, f.doctor.account, f.doctor.membership]);
  await side.query(`insert into ehr.clinical_note_revisions (clinical_note_id,patient_id,facility_id,revision_no,content,
    change_reason,created_by,created_by_membership_id) values ($1,$2,$3,1,'Synthetic content','initial clinical note',$4,$5)`,
  [sideNote, f.patient, f.facility, f.doctor.account, f.doctor.membership]);
  let settled = false;
  const waiting = patch(encounterPath(encounter.waiting), { status: 'entered_in_error',
    expectedRowVersion: await encounterVersion(encounter.waiting), changeReason: reason }).finally(() => { settled = true; });
  await sleep(750);
  assert.equal(settled, false, 'the retraction did not wait for the child create holding the encounter');
  await side.query('commit');
  const afterWait = expectStatus(await waiting, 200, 'retraction after the child create committed');
  assert.equal(afterWait.status, 'entered_in_error');
  assert.equal(await statusOf('clinical_notes', sideNote), 'entered_in_error',
    'the retraction missed a note committed while it waited');
  check('a retraction waits for a child create that holds the encounter\'s share lock, then retracts that record too');

  // 6. Concurrent activation of a draft prescription and retraction of its
  //    encounter: either order is safe, neither deadlocks, and the
  //    prescription always ends entered in error.
  const outcomes = [];
  for (const race of races) {
    const [activation, retraction] = await Promise.all([
      patch(`${encounterPath(race.encounter)}/prescriptions/${race.prescription}`,
        { status: 'active', expectedRowVersion: 1, changeReason: 'Synthetic activation' }),
      patch(encounterPath(race.encounter), { status: 'entered_in_error', expectedRowVersion: 1, changeReason: reason }),
    ]);
    expectStatus(retraction, 200, 'retraction racing an activation');
    assert(activation.status === 200 || (activation.status === 409
      && ['ENCOUNTER_NOT_OPEN', 'INVALID_PRESCRIPTION_TRANSITION'].includes(activation.body?.code)),
    `activation racing a retraction: ${activation.status} ${JSON.stringify(activation.body)} ${activation.sqlstate ?? ''}`);
    assert.equal(await statusOf('prescriptions', race.prescription), 'entered_in_error');
    outcomes.push(activation.status);
  }
  check(`${races.length} concurrent activations racing their encounter's retraction answered ${[...new Set(outcomes)].sort().join(' or ')}, never 5xx, and every prescription ended entered in error`);

  // 7. A nurse cannot retract a doctor's diagnosis or prescription through the
  //    encounter (ENC-RETRACT-1): 403, nothing changed, the refusal audited
  //    with the permissions she lacks. An encounter holding only what she may
  //    write (notes, vitals) she may still retract.
  const doctorDiagnosis = expectStatus(await post(encounter.nurseRefused, 'diagnoses', records.diagnoses), 201, 'diagnosis').id;
  const doctorPrescription = expectStatus(await post(encounter.nurseRefused, 'prescriptions',
    { ...records.prescriptions, status: 'draft' }), 201, 'draft prescription').id;
  const before = { encounter: await encounterVersion(encounter.nurseRefused),
    diagnosis: await rowVersion('diagnoses', doctorDiagnosis), prescription: await rowVersion('prescriptions', doctorPrescription) };
  const refusedCorrelation = `verifier-nurse-retract-${id()}`;
  const refused = await patch(encounterPath(encounter.nurseRefused), { status: 'entered_in_error',
    expectedRowVersion: before.encounter, changeReason: 'Documented on the wrong patient' }, refusedCorrelation, 'token-nurse');
  assert.deepEqual([refused.status, refused.body?.code], [403, 'ENCOUNTER_RETRACTION_NOT_PERMITTED'], JSON.stringify(refused.body));
  // The response does not say which kinds of record the encounter holds; the
  // missing permissions go to the audit row only.
  assert.equal(refused.body?.detail, 'Cancelling or retracting this encounter changes records you may not write',
    JSON.stringify(refused.body));
  assert.deepEqual([await statusOf('encounters', encounter.nurseRefused), await statusOf('diagnoses', doctorDiagnosis),
    await statusOf('prescriptions', doctorPrescription)], ['in_progress', 'confirmed', 'draft']);
  assert.deepEqual({ encounter: await encounterVersion(encounter.nurseRefused),
    diagnosis: await rowVersion('diagnoses', doctorDiagnosis), prescription: await rowVersion('prescriptions', doctorPrescription) },
  before, 'a refused retraction changed a row');
  assert.equal(await database.count('select count(*) from ehr.record_versions where correlation_id = $1', [refusedCorrelation]), 0);
  const refusedAudit = await auditRows(refusedCorrelation);
  assert.deepEqual(refusedAudit.filter((row) => row.action === 'ehr.encounter.update'), [{ action: 'ehr.encounter.update',
    outcome: 'denied', details: { status: 403, code: 'ENCOUNTER_RETRACTION_NOT_PERMITTED',
      missingPermissions: ['ehr.diagnosis.write', 'ehr.prescription.write'] } }]);
  assert(refusedAudit.some((row) => row.action.startsWith('api.patch.') && row.outcome === 'denied'
    && row.details.status === 403 && row.details.code === 'ENCOUNTER_RETRACTION_NOT_PERMITTED'), JSON.stringify(refusedAudit));
  const nurseNote = expectStatus(await ehr.request('POST', `${encounterPath(encounter.nurseAllowed)}/clinical-notes`,
    { headers: headers('clinical-notes', 'token-nurse'), body: records['clinical-notes'] }), 201, 'nurse note').id;
  const nurseVital = expectStatus(await ehr.request('POST', `${encounterPath(encounter.nurseAllowed)}/vitals`,
    { headers: headers('vitals', 'token-nurse'), body: records.vitals }), 201, 'nurse vital').id;
  const nurseRetraction = expectStatus(await patch(encounterPath(encounter.nurseAllowed), { status: 'entered_in_error',
    expectedRowVersion: await encounterVersion(encounter.nurseAllowed), changeReason: 'Documented on the wrong patient' },
  undefined, 'token-nurse'), 200, 'nurse retracts notes and vitals');
  assert.deepEqual([nurseRetraction.cascade.clinicalNoteIds, nurseRetraction.cascade.vitalIds], [[nurseNote], [nurseVital]]);
  check('a nurse marking entered in error an encounter with a doctor\'s diagnosis and prescription is 403 ENCOUNTER_RETRACTION_NOT_PERMITTED with a fixed detail, no row or version changed and a denied ehr.encounter.update audit naming the missing permissions; she still retracts an encounter holding only her notes and vitals');

  // 8. A vital is entered in error on its own (ENC-RETRACT-2), versioned and
  //    audited, and is then neither corrected nor retracted again.
  const lonelyVital = expectStatus(await post(encounter.vitalOpen, 'vitals', records.vitals), 201, 'vital').id;
  const vitalPath = `${encounterPath(encounter.vitalOpen)}/vitals/${lonelyVital}`;
  const vitalCorrelation = `verifier-vital-retract-${id()}`;
  const retractedVital = expectStatus(await ehr.request('POST', `${vitalPath}/entered-in-error`, { headers: headers(),
    body: { expectedRowVersion: 1, changeReason: 'Recorded on the wrong patient' }, correlationId: vitalCorrelation }), 200,
  'mark the vital entered in error');
  assert.deepEqual([retractedVital.status, retractedVital.rowVersion, retractedVital.pulseBpm], ['entered_in_error', '2', 72]);
  assert.deepEqual((await database.owner.query(`select change_reason from ehr.record_versions where correlation_id = $1`,
    [vitalCorrelation])).rows, [{ change_reason: 'Recorded on the wrong patient' }]);
  assert((await auditRows(vitalCorrelation)).some((row) => row.action === 'ehr.vital.entered-in-error' && row.outcome === 'success'));
  const listed = expectStatus(await ehr.request('GET', `${encounterPath(encounter.vitalOpen)}/vitals`, { headers: headers() }), 200,
    'list vitals');
  assert.equal(listed.items.find((item) => item.id === lonelyVital)?.status, 'entered_in_error');
  const correction = await ehr.request('POST', `${vitalPath}/corrections`, { headers: headers('correction'),
    body: { expectedRowVersion: 2, changeReason: 'Corrected pulse', replacementValues: { pulseBpm: 70 } } });
  assert.deepEqual([correction.status, correction.body?.code], [409, 'VITAL_NOT_AMENDABLE'], JSON.stringify(correction.body));
  const again = await ehr.request('POST', `${vitalPath}/entered-in-error`, { headers: headers(),
    body: { expectedRowVersion: 2, changeReason: 'Recorded on the wrong patient' } });
  assert.deepEqual([again.status, again.body?.code], [409, 'VITAL_NOT_AMENDABLE'], JSON.stringify(again.body));
  assert.equal(await database.count('select count(*) from ehr.vital_corrections where vital_id = $1', [lonelyVital]), 0);
  check('POST .../vitals/:vitalId/entered-in-error marks a vital entered in error with a version carrying the reason and a success audit, the list shows its status, and a later correction or retraction is 409 VITAL_NOT_AMENDABLE with nothing written');

  // 9. Closed orders and closed encounters take no further change
  //    (RX-FINAL, ORDER-CLOSED-EDIT), and the refusal is audited.
  const finalCorrelation = `verifier-closed-prescription-${id()}`;
  const finalVersion = await rowVersion('prescriptions', cancelledPrescription);
  const rewritten = await patch(`${encounterPath(encounter.cancelled)}/prescriptions/${cancelledPrescription}`,
    { instructions: 'Rewritten instructions', expectedRowVersion: finalVersion, changeReason: 'Synthetic rewrite' }, finalCorrelation);
  assert.deepEqual([rewritten.status, rewritten.body?.code], [409, 'PRESCRIPTION_NOT_AMENDABLE'], JSON.stringify(rewritten.body));
  assert.equal(await rowVersion('prescriptions', cancelledPrescription), finalVersion);
  assert.deepEqual((await auditRows(finalCorrelation)).filter((row) => row.action === 'ehr.prescription.update'),
    [{ action: 'ehr.prescription.update', outcome: 'denied', details: { status: 409, code: 'PRESCRIPTION_NOT_AMENDABLE' } }]);
  const closedVersion = await encounterVersion(encounter.cancelled);
  const header = await patch(encounterPath(encounter.cancelled), { chiefComplaint: 'Rewritten complaint',
    expectedRowVersion: closedVersion, changeReason: 'Synthetic rewrite' });
  assert.deepEqual([header.status, header.body?.code], [409, 'ENCOUNTER_NOT_OPEN'], JSON.stringify(header.body));
  assert.equal(await encounterVersion(encounter.cancelled), closedVersion);
  check('a cancelled prescription\'s instructions are 409 PRESCRIPTION_NOT_AMENDABLE and a cancelled encounter\'s chief complaint is 409 ENCOUNTER_NOT_OPEN, nothing written, and the prescription refusal is a denied ehr.prescription.update audit');

  // 10. A staff session on the patient's own records route is refused before
  //     any handler and audited, not answered 503 (A9-EHR).
  const staffOnPatientCorrelation = `verifier-staff-me-records-${id()}`;
  const staffOnPatient = await ehr.request('GET', '/ehr/me/records', { headers: { authorization: 'Bearer token-doctor' },
    correlationId: staffOnPatientCorrelation });
  assert.deepEqual([staffOnPatient.status, staffOnPatient.body?.code], [403, 'PATIENT_SESSION_REQUIRED'],
    JSON.stringify(staffOnPatient.body));
  assert.deepEqual(await auditRows(staffOnPatientCorrelation), [{ action: 'auth.authorization.denied', outcome: 'denied',
    details: { method: 'GET', route: '/api/v1/ehr/me/records', status: 403, code: 'PATIENT_SESSION_REQUIRED' } }]);
  check('a staff session on GET /ehr/me/records is 403 PATIENT_SESSION_REQUIRED with one auth.authorization.denied audit row');

  await ehr.close();
  ehr = undefined;
  await side.end();
  assert.equal(await database.deadlocks(), 0, 'PostgreSQL detected a deadlock during the run');
  check('no deadlock: pg_stat_database reports none for the run');
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...evidence })}\n`);
} finally {
  await ehr?.close();
  await side.end().catch(() => undefined);
  await database.close();
  await identity.close();
}
