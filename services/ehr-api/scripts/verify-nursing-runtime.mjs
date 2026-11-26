#!/usr/bin/env node
// NUR-1 (0174-0177; Release D, the owner's sprint approval of 25 November 2026): nursing on the ward. ehr-api's own
// NursingService (and ADT-1's InpatientService for the stay), every statement run as hid_ehr_api_runtime in the
// context ehr-api's transactions set: a reading with the observation chart's new fields and the chart (no score), a
// scheduled inpatient order written as the prescription create writes it, a dose of each outcome on the medicine
// round, a task started and completed with its record, a fluid entry and the fluid day, a clinical shift, the ward's
// assignments, and a handover note given. The chart grants are fixtures written as 0131 writes an own-facility
// opening. Executes only against the owned disposable synthetic rehearsal. No delivery or cloud calls; fictional
// people, places and identifiers only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
Object.assign(process.env, { INPATIENT_ENABLED: 'true', NURSING_ENABLED: 'true', STORAGE_MODE: 'disabled' });
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const { Pool } = require('pg');
const { InpatientService } = require(join(service, 'src/ehr/inpatient/inpatient.service.ts'));
const { NursingService } = require(join(service, 'src/ehr/nursing/nursing.service.ts'));

const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 5 });
const run = randomUUID().slice(0, 8);
const id = (n) => `${run}-a174-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  organization: id(1), facility: id(2),
  adminAccount: id(11), adminStaff: id(12), admin: id(13),
  nurseAccount: id(21), nurseStaff: id(22), nurse: id(23),
  doctorAccount: id(31), doctorStaff: id(32), doctor: id(33),
  p1: id(41),
};
const subjects = { admin: `synthetic:nursing-admin-${run}`, nurse: `synthetic:nursing-nurse-${run}`,
  doctor: `synthetic:nursing-doctor-${run}` };
const letters = run.slice(0, 4).toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, 'K');

/** A runtime transaction as the service sets it. */
async function asRole(role, settings, operation) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    for (const [name, value] of Object.entries(settings)) await client.query('select set_config($1, $2, true)', [name, value]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
const staffSettings = (context) => ({ 'app.actor_subject': context.actor.subject, 'app.facility_id': context.facilityId,
  'app.correlation_id': context.correlationId, 'app.membership_id': context.membershipId,
  'app.purpose_of_use': context.purposeOfUse, 'app.vitals_status': '0142' });
const database = {
  withTransaction: (context, operation) => asRole('hid_ehr_api_runtime', staffSettings(context), operation),
};
const inpatient = new InpatientService(database);
const nursing = new NursingService(database);
const context = (who, purposeOfUse = 'direct-care') => ({ correlationId: `nursing-runtime-${who}-${randomUUID()}`,
  facilityId: ids.facility, membershipId: ids[who], purposeOfUse, actor: { subject: subjects[who] } });
const key = (label) => `nursing-runtime-${run}-${label}`.replace(/[^A-Za-z0-9._:-]/g, '-');
const refused = (code) => (error) => { assert.equal(error.code, code); return true; };
const lagosClock = (at) => new Date(at.getTime() + 60 * 60_000).toISOString().slice(11, 16);

try {
  // Fixtures, as the rehearsal's owner, triggers off (the suites' way).
  const seed = await pool.connect();
  try {
    await seed.query('begin');
    await seed.query('set local session_replication_role = replica');
    await seed.query(`insert into identity.purpose_of_use_codes (code, display, source_system)
      values ('direct-care', 'Direct patient care', 'nursing-runtime'),
        ('healthcare-operations', 'Healthcare operations', 'nursing-runtime')
      on conflict (code) do update set active = true`);
    await seed.query('insert into identity.organizations (id, name, slug) values ($1, $2, $3)',
      [ids.organization, `Synthetic Nursing Group ${run}`, `synthetic-nursing-${run}`]);
    await seed.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
      values ($1, $2, $3, $4, 'Africa/Lagos', true, 'verified')`, [ids.facility, ids.organization,
      `Synthetic Nursing Hospital ${run}`, `SYN-NUR-${run}`.toUpperCase()]);
    for (const [who, role, name] of [['admin', 'admin', 'Sola Synthadmin'], ['nurse', 'nurse', 'Ifeoma Synthnurse'],
      ['doctor', 'doctor', 'Tunde Synthdoctor']]) {
      await seed.query("insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, $4, 'active')",
        [ids[`${who}Account`], subjects[who], `${who}-${run}@example.invalid`, name]);
      await seed.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
        values ($1, $2, $3, $4, 'verified', $5)`, [ids[`${who}Staff`], ids[`${who}Account`], name,
        `${who}-${run}@example.invalid`, role]);
      await seed.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
        membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
        [ids[who], ids[`${who}Staff`], ids[`${who}Account`], ids.organization, ids.facility, role]);
      await seed.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
        grant_reason) values (gen_random_uuid(), $1, $2, 'facility', $3, $4, 'Synthetic nursing runtime role')`,
        [ids[`${who}Account`], role, ids[who], ids.facility]);
    }
    await seed.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status,
      source_system) values ($1, $2, 'Pat', $3, $4, 'female', date '1975-05-05', 'active', 'hid')`,
    [ids.p1, `HID-N${letters}A2`, `Synthnurse${run}`, `Pat Synthnurse${run}`]);
    for (const who of ['doctor', 'nurse']) {
      // Chart access, as 0131 writes an own-facility opening (24 hours of write access, direct care).
      await seed.query(`insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
        scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, authorization_method)
        values (gen_random_uuid(), $1, $2, $3, $4, $5, 'write_records', 'direct-care', 'active',
          'Opened as this facility''s patient', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day',
          false, 'own_facility')`, [ids.p1, ids[`${who}Staff`], ids[`${who}Account`], ids[who], ids.facility]);
    }
    await seed.query('commit');
  } finally {
    seed.release();
  }

  // The stay (ADT-1): an ICU ward, a bed, a request and a bed.
  const setup = context('admin', 'healthcare-operations');
  const icu = (await inpatient.createWard(setup, { name: `ICU ${run}`, wardType: 'icu' }, key('ward'))).ward;
  const bed = (await inpatient.createBed(setup, icu.wardId, { name: 'ICU Bed 1' }, key('bed'))).bedId;
  const requested = (await inpatient.request(context('doctor'), { patientId: ids.p1, source: 'direct',
    reason: 'Synthetic sepsis', responsibleMembershipId: ids.doctor, requestedWardId: icu.wardId }, key('request'))).admission;
  const stay = (await inpatient.admit(context('nurse'), requested.admissionId, { expectedRowVersion: requested.rowVersion,
    bedId: bed }, key('admit'))).admission;

  // Route 1: a reading with the new fields, as the vitals create writes it.
  const nurse = context('nurse');
  await database.withTransaction(nurse, (client) => client.query(`insert into ehr.vitals (encounter_id, patient_id,
    facility_id, created_by, created_by_membership_id, recorded_at, pulse_bpm, oxygen_saturation_percent, pain_score, avpu,
    blood_glucose_mmol_l, oxygen_device, oxygen_flow_l_per_min, gcs_eye, gcs_verbal, gcs_verbal_not_testable, gcs_motor)
    values ($1, $2, $3, $4, $5, clock_timestamp() - interval '5 minutes', 128, 93, 5, 'voice', 8.4, 'nasal_cannula', 2,
      3, null, true, 5)`, [stay.encounterId, ids.p1, ids.facility, ids.nurseAccount, ids.nurse]));
  await assert.rejects(database.withTransaction(nurse, (client) => client.query(`insert into ehr.vitals (encounter_id,
    patient_id, facility_id, created_by, created_by_membership_id, recorded_at, oxygen_device, oxygen_flow_l_per_min)
    values ($1, $2, $3, $4, $5, clock_timestamp(), 'room_air', 2)`, [stay.encounterId, ids.p1, ids.facility,
    ids.nurseAccount, ids.nurse])), (error) => error.code === '23514');
  const chart = await nursing.observationChart(nurse, stay.admissionId, undefined, undefined, undefined);
  assert.equal(chart.score, null);
  assert.equal(chart.wardType, 'icu');
  assert(Array.isArray(chart.hours) && chart.hours.length >= 24, 'the ICU chart is the hourly grid by default');
  assert.deepEqual([chart.readings[0].values.avpu, chart.readings[0].values.gcsVerbalNotTestable,
    chart.readings[0].flags.map((flag) => flag.measure).includes('pulseBpm')], ['voice', true, true]);

  // Route 3: an order with five set times over the last five hours, as the prescription create writes it.
  const now = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const slots = [5, 4, 3, 2, 0].map((hours) => new Date(now.getTime() - hours * 60 * 60_000));
  const times = [...new Set(slots.map(lagosClock))].sort();
  const order = await database.withTransaction(context('doctor'), async (client) => (await client.query(`insert into
    ehr.prescriptions (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, medication_display,
    dose_quantity, dose_unit, route_code, frequency, instructions, status, schedule_kind, scheduled_times, first_due_at)
    values ($1, $2, $3, $4, $5, 'Synthetic Med A', 1, 'g', 'IV', $6, 'Synthetic', 'active', 'regular', $7::text[],
      clock_timestamp() - interval '1 day') returning id`, [stay.encounterId, ids.p1, ids.facility, ids.doctorAccount,
    ids.doctor, times.join(', '), times])).rows[0].id);
  await assert.rejects(database.withTransaction(context('doctor'), (client) => client.query(`update ehr.prescriptions
    set scheduled_times = array['01:00'] where id = $1`, [order])), (error) => error.message === 'INPATIENT_SCHEDULE_IMMUTABLE');

  // Routes 4-7: a dose of each outcome; one record per scheduled dose; entered in error frees it.
  const outcomes = [['given', {}], ['held', { reasonCode: 'clinical_decision', reasonText: 'Synthetic low pressure' }],
    ['refused', { reasonCode: 'patient_refused' }], ['omitted', { reasonCode: 'patient_away' }],
    ['not_available', { reasonCode: 'not_in_stock' }]];
  const recorded = [];
  for (const [index, [outcome, reason]] of outcomes.entries()) {
    const answer = await nursing.recordDose(nurse, stay.admissionId, { prescriptionId: order,
      scheduledFor: slots[index].toISOString(), outcome, givenAt: new Date().toISOString(),
      ...(outcome === 'given' ? { dose: { quantity: 1, unit: 'g' }, route: 'IV', supplySource: 'ward_stock' } : reason) },
    key(`dose-${outcome}`));
    recorded.push(answer.administration);
    if (outcome === 'given') assert.deepEqual(answer.warnings, ['late', 'before_dispensing']);
  }
  await assert.rejects(nursing.recordDose(nurse, stay.admissionId, { prescriptionId: order,
    scheduledFor: slots[0].toISOString(), outcome: 'omitted', reasonCode: 'no_access', givenAt: new Date().toISOString() },
  key('dose-again')), refused('DOSE_ALREADY_RECORDED'));
  await nursing.doseEnteredInError(nurse, recorded[4].administrationId, { expectedRowVersion: 1,
    reason: 'Synthetic wrong order' }, key('dose-error'));
  const round = await nursing.medicineRound(nurse, stay.admissionId, undefined, undefined);
  assert.equal(round.orders[0].pharmacyState, 'not_sent');
  assert.equal(round.administrations.filter((entry) => entry.status === 'recorded').length, 4);
  const ward = await nursing.wardRound(nurse, icu.wardId, 'now');
  assert.equal(ward.items[0].admissionId, stay.admissionId);

  // Routes 8-10: a task started and completed with its record (chart content).
  const task = (await nursing.createTask(nurse, stay.admissionId, { name: 'Synthetic hourly observations',
    dueAt: new Date().toISOString(), repeatEveryHours: 1 }, key('task'))).task;
  const started = (await nursing.startTask(nurse, task.taskId, task.rowVersion, key('task-start'))).task;
  const completed = await nursing.completeTask(nurse, task.taskId, { expectedRowVersion: started.rowVersion,
    completionRecord: 'Synthetic observations done' }, key('task-done'));
  assert.equal(completed.task.status, 'completed');
  assert.match(String(completed.nextTaskId), /^[0-9a-f-]{36}$/);

  // Routes 11-13: fluid balance.
  await nursing.recordFluid(nurse, stay.admissionId, { direction: 'in', kind: 'iv', volumeMl: 250,
    recordedAt: new Date().toISOString() }, key('fluid-in'));
  await nursing.recordFluid(nurse, stay.admissionId, { direction: 'out', kind: 'urine', notMeasured: true,
    recordedAt: new Date().toISOString() }, key('fluid-out'));
  const fluid = await nursing.fluidDay(nurse, stay.admissionId, undefined);
  assert.deepEqual([fluid.totals.intakeMl, fluid.totals.unmeasuredOutputCount], [250, 1]);

  // Routes 14-18: a shift around now, the ward's list, a handover note given.
  const startsAt = lagosClock(new Date(now.getTime() - 60 * 60_000)).slice(0, 2) + ':00';
  const endsAt = lagosClock(new Date(now.getTime() + 2 * 60 * 60_000)).slice(0, 2) + ':00';
  const shift = await nursing.createShift(setup, { name: `Synthetic shift ${run}`, startsAt, endsAt }, key('shift'));
  await assert.rejects(nursing.createShift(context('nurse', 'healthcare-operations'), { name: 'No', startsAt: '01:00',
    endsAt: '02:00' }, key('shift-nurse')), refused('SHIFT_SETUP_NOT_ALLOWED'));
  // The shift began within the last two hours, on the Lagos date of an hour ago (Lagos is UTC+1, no summer time).
  const shiftDate = now.toISOString().slice(0, 10);
  const list = await nursing.setAssignments(nurse, { date: shiftDate, shiftId: shift.shiftId, wardId: icu.wardId,
    expectedVersion: 0, assignments: [{ membershipId: ids.nurse, duty: 'nurse_in_charge', admissionIds: [stay.admissionId] },
      { membershipId: ids.doctor, duty: 'on_call_doctor' }] }, key('assign'));
  assert.equal(list.list.version, 1);
  const note = await nursing.handoverNote(nurse, null, stay.admissionId, { wardId: icu.wardId, date: shiftDate,
    shiftId: shift.shiftId, note: 'Synthetic: stable, watch the fever', watch: true }, key('handover-note'));
  const sheet = await nursing.handover(nurse, icu.wardId, shiftDate, shift.shiftId);
  assert.equal(sheet.handoverId, note.handoverId);
  assert.equal(sheet.patients[0].handoverNote, 'Synthetic: stable, watch the fever');
  assert(!JSON.stringify(sheet).includes('shiftReadings'));
  const given = await nursing.handoverStep(nurse, note.handoverId, 'give', sheet.rowVersion, key('handover-give'));
  assert.equal(given.handover.status, 'given');

  // Audit: no name, Health ID, medicine, dose, value, note text, task name or reason text in any nursing row.
  const leaked = (await pool.query(`select count(*)::integer as n from audit.events
    where facility_id = $1 and (action like 'ehr.mar%' or action like 'ehr.nursing-task%' or action like 'ehr.fluid-balance%'
      or action like 'ehr.clinical-shift%' or action like 'ehr.shift-assignment%' or action like 'ehr.handover%'
      or action like 'ehr.observation-chart%')
      and (details::text ~* $2 or coalesce(reason, '') <> '')`,
  [ids.facility, 'synthnurse|HID-N|synthetic|med a|fever|"quantity"'])).rows[0].n;
  assert.equal(leaked, 0);
  process.stdout.write(JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', roles: ['hid_ehr_api_runtime'],
    observation_fields_and_chart: true, no_score: true, icu_hourly_grid: true, scheduled_order: true,
    dose_outcomes: outcomes.map(([outcome]) => outcome), one_record_per_dose: true, dose_entered_in_error: true,
    task_with_record_and_repeat: true, fluid_balance: true, clinical_shift: true, assignments: true, handover_given: true,
    audit_without_personal_text: true }) + '\n');
} finally {
  await pool.end();
}
