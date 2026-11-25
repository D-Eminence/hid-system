#!/usr/bin/env node
// APPT-1 (0160, 0161; Release D, built at the recommended options Q-APPT-1 A to Q-APPT-7 A): appointments with
// check-in to the waiting list, the portal's "My appointments" and the printable call list. ehr-api's own
// AppointmentsService (every staff statement run as hid_ehr_api_runtime in the context ehr-api's transactions set,
// the patient's as the same role in the patient-self context) and identity-api's AppointmentCallListService and staff
// patient search (as hid_identity_api_runtime): book by a search's matchRef and by this facility's own patient, the
// clinician clash, reschedule, cancel, no-show too early, check-in with the appointment as the basis and with a fresh
// search, the patient's own list, and the call list with the phone this facility recorded. Executes only against the
// owned disposable synthetic rehearsal. No delivery or cloud calls; fictional people, places and identifiers only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const identityService = resolve(service, '../identity-api');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
// Synthetic settings for this disposable run only: the flag on, and the desk contact key.
Object.assign(process.env, { APPOINTMENTS_ENABLED: 'true', STORAGE_MODE: 'disabled',
  NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 0x52).toString('base64'), NIN_KEY_VERSION: 'synthetic-appointments-v1' });
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const { Pool } = require('pg');
const { AppointmentsService } = require(join(service, 'src/ehr/appointments/appointments.service.ts'));
const { CollectedFieldProtector, registrationCaseContactLabel } =
  require(join(identityService, 'src/identity/collected-field-protector.ts'));
const { AppointmentCallListService } = require(join(identityService, 'src/appointments/appointment-call-list.service.ts'));

const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 5 });
const run = randomUUID().slice(0, 8);
const id = (n) => `${run}-a100-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  organization: id(1), facility: id(2),
  deskAccount: id(11), deskStaff: id(12), desk: id(13),
  doctorAccount: id(21), doctorStaff: id(22), doctor: id(23),
  p1: id(31), p1Account: id(32), p1Session: id(33), p2: id(41), p2Case: id(42), p2Contact: id(43),
};
const subjects = { desk: `synthetic:appointments-desk-${run}`, doctor: `synthetic:appointments-doctor-${run}`,
  p1: `synthetic:appointments-patient-${run}` };

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
  'app.purpose_of_use': context.purposeOfUse });
const ehrDatabase = {
  withTransaction: (context, operation) => asRole('hid_ehr_api_runtime', staffSettings(context), operation),
  withPatientTransaction: (authorization, correlationId, operation) => asRole('hid_ehr_api_runtime', {
    'app.actor_subject': authorization.subject, 'app.account_id': authorization.accountId,
    'app.session_id': authorization.sessionId, 'app.patient_id': authorization.patientId,
    'app.correlation_id': correlationId, 'app.self_authorized_until': authorization.expiresAt,
    'app.purpose_of_use': 'patient-self', 'app.facility_id': '', 'app.membership_id': '' }, operation),
  withSystemTransaction: (correlationId, operation) => asRole('hid_ehr_api_runtime', {
    'app.actor_subject': 'system:auth', 'app.correlation_id': correlationId }, operation),
};
const identityDatabase = {
  withTransaction: (context, operation) => asRole('hid_identity_api_runtime', staffSettings(context), operation),
};
const identityApi = { authorizeSelf: async () => ({ patientId: ids.p1, accountId: ids.p1Account, subject: subjects.p1,
  sessionId: ids.p1Session, expiresAt: new Date(Date.now() + 30_000).toISOString() }) };
const appointments = new AppointmentsService(ehrDatabase, identityApi);
const callList = new AppointmentCallListService(identityDatabase);
const context = (who) => ({ correlationId: `appointments-runtime-${who}-${randomUUID()}`, facilityId: ids.facility,
  membershipId: ids[who], purposeOfUse: 'direct-care', actor: { subject: subjects[who] } });
const key = (label) => `appointments-runtime-${run}-${label}`;
const slot = (minutes) => new Date(Math.floor(Date.now() / 300_000) * 300_000 + minutes * 60_000).toISOString();
const lagosDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit',
  day: '2-digit' }).format(new Date(iso));
const refused = (code) => (error) => { assert.equal(error.code, code); return true; };

async function search(first, last, dob) {
  return asRole('hid_identity_api_runtime', staffSettings(context('desk')), async (client) =>
    (await client.query(`select outcome, match_ref from identity.staff_patient_search('standard', $1, $2, $3::date, null,
      null, null, null)`, [first, last, dob])).rows[0]);
}

try {
  // Fixtures, as the rehearsal's owner, triggers off (the suites' way).
  const phone = new CollectedFieldProtector().encrypt(registrationCaseContactLabel(ids.p2Case, 'phone'), '+2348030000009');
  const address = new CollectedFieldProtector().encrypt(registrationCaseContactLabel(ids.p2Case, 'address'), 'Synthetic address');
  const seed = await pool.connect();
  try {
    await seed.query('begin');
    await seed.query('set local session_replication_role = replica');
    await seed.query(`insert into identity.purpose_of_use_codes (code, display, source_system)
      values ('direct-care', 'Direct patient care', 'appointments-runtime') on conflict (code) do update set active = true`);
    await seed.query('insert into identity.organizations (id, name, slug) values ($1, $2, $3)',
      [ids.organization, `Synthetic Booking Group ${run}`, `synthetic-booking-${run}`]);
    await seed.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
      values ($1, $2, $3, $4, 'Africa/Lagos', true, 'verified')`, [ids.facility, ids.organization, `Synthetic Clinic ${run}`,
      `SYN-APPT-${run}`.toUpperCase()]);
    for (const [who, role, name] of [['desk', 'receptionist', 'Ada Synthdesk'], ['doctor', 'doctor', 'Chidi Synthdoctor']]) {
      await seed.query("insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, $4, 'active')",
        [ids[`${who}Account`], subjects[who], `${who}-${run}@example.invalid`, name]);
      await seed.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
        values ($1, $2, $3, $4, 'verified', $5)`, [ids[`${who}Staff`], ids[`${who}Account`], name,
        `${who}-${run}@example.invalid`, role]);
      await seed.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
        membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
        [ids[who], ids[`${who}Staff`], ids[`${who}Account`], ids.organization, ids.facility, role]);
      await seed.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
        grant_reason) values (gen_random_uuid(), $1, $2, 'facility', $3, $4, 'Synthetic appointments runtime role')`,
        [ids[`${who}Account`], role, ids[who], ids.facility]);
    }
    await seed.query("insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, 'Amaka Synthone', 'active')",
      [ids.p1Account, subjects.p1, `patient-${run}@example.invalid`]);
    await seed.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status,
      source_system, account_id) values ($1, $2, 'Amaka', $3, $4, 'female', date '1991-03-04', 'active', 'hid', $5)`,
      [ids.p1, `HID-SA${run.slice(0, 4).toUpperCase().replace(/[^A-Z2-9]/g, 'K')}22`, `Synthone${run}`,
       `Amaka Synthone${run}`, ids.p1Account]);
    await seed.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status,
      source_system) values ($1, $2, 'Bayo', $3, $4, 'male', date '1988-07-09', 'active', 'hid-desk-registration')`,
      [ids.p2, `HID-SB${run.slice(0, 4).toUpperCase().replace(/[^A-Z2-9]/g, 'K')}33`, `Synthtwo${run}`, `Bayo Synthtwo${run}`]);
    await seed.query(`insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id,
      status, first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, idempotency_key, request_sha256,
      resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id,
      review_reason, created_at, updated_at)
      values ($1, $2, $3, $4, 'approved_new_identity', 'Bayo', $5, $6, date '1988-07-09', 'none', 'no_nin', $7, $8, $9, $10,
        $8, $3, $4, 'Checked at the desk', clock_timestamp() - interval '3 days', clock_timestamp() - interval '3 days')`,
      [ids.p2Case, ids.facility, ids.deskAccount, ids.desk, `Synthtwo${run}`, `Bayo Synthtwo${run}`, key('case'),
       '0'.repeat(64), ids.p2, key('review')]);
    await seed.query(`insert into identity.registration_case_contacts (registration_case_id, facility_id, phone_ciphertext,
      address_ciphertext, key_version, created_by_account_id, created_by_membership_id)
      values ($1, $2, $3, $4, 'synthetic-appointments-v1', $5, $6)`,
      [ids.p2Case, ids.facility, phone, address, ids.deskAccount, ids.desk]);
    await seed.query(`insert into identity.patient_facility_contacts (id, patient_id, facility_id, registration_case_id,
      phone_ciphertext, address_ciphertext, key_version, created_by_account_id, created_by_membership_id)
      values ($1, $2, $3, $4, $5, $6, 'synthetic-appointments-v1', $7, $8)`,
      [ids.p2Contact, ids.p2, ids.facility, ids.p2Case, phone, address, ids.deskAccount, ids.desk]);
    await seed.query(`insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti,
      account_token_version, authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
      values ($1, $2, $1, $3, gen_random_uuid(), (select token_version from auth.accounts where id = $2), 'password',
        clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day', clock_timestamp() + interval '7 days',
        'patient', $4)`, [ids.p1Session, ids.p1Account, createHash('sha256').update(run).digest('hex'), ids.p1]);
    await seed.query('commit');
  } finally {
    seed.release();
  }

  // Book: p1 from the desk's search (basis search), with the doctor, in an hour.
  const found = await search('Amaka', `Synthone${run}`, '1991-03-04');
  assert.equal(found.outcome, 'found');
  const startOne = slot(60);
  const one = await appointments.book(context('desk'), { matchRef: found.match_ref, departmentCode: 'general_outpatient',
    clinicianMembershipId: ids.doctor, startsAt: startOne, visitType: 'follow_up', reason: 'Blood pressure review' },
    key('book-1'));
  assert.equal(one.appointment.bookingBasis, 'search');
  assert.equal(one.appointment.lengthMinutes, 30);
  assert.equal(one.replayed, false);
  const replay = await appointments.book(context('desk'), { matchRef: found.match_ref, departmentCode: 'general_outpatient',
    clinicianMembershipId: ids.doctor, startsAt: startOne, visitType: 'follow_up', reason: 'Blood pressure review' },
    key('book-1'));
  assert.equal(replay.replayed, true);
  assert.equal(replay.appointment.appointmentId, one.appointment.appointmentId);
  // The same doctor at the same time: the clash.
  await assert.rejects(appointments.book(context('desk'), { patientId: ids.p2, departmentCode: 'general_outpatient',
    clinicianMembershipId: ids.doctor, startsAt: startOne, visitType: 'new_visit' }, key('book-clash')),
  refused('APPOINTMENT_CLINICIAN_CLASH'));
  // p2, this facility's own (registered at the desk), in two hours, no clinician; then rescheduled.
  const two = await appointments.book(context('desk'), { patientId: ids.p2, departmentCode: 'general_outpatient',
    startsAt: slot(120), lengthMinutes: 20, visitType: 'new_visit' }, key('book-2'));
  assert.equal(two.appointment.bookingBasis, 'own-facility');
  const moved = await appointments.reschedule(context('doctor'), two.appointment.appointmentId,
    { expectedRowVersion: 1, startsAt: slot(180), reason: 'The clinic moved the session' }, key('move-2'));
  assert.equal(moved.appointment.rowVersion, 2);
  await assert.rejects(appointments.reschedule(context('doctor'), two.appointment.appointmentId,
    { expectedRowVersion: 1, startsAt: slot(185), reason: 'The clinic moved the session again' }, key('move-2-stale')),
  refused('APPOINTMENT_VERSION_CONFLICT'));
  // No-show before the start time is refused.
  await assert.rejects(appointments.markNoShow(context('desk'), one.appointment.appointmentId, { expectedRowVersion: 1 },
    key('noshow-1')), refused('APPOINTMENT_NO_SHOW_TOO_EARLY'));
  // A booking for two days on, cancelled; one more for that day stays booked (the call list).
  const later = slot(48 * 60);
  const three = await appointments.book(context('desk'), { patientId: ids.p2, departmentCode: 'general_outpatient',
    startsAt: later, visitType: 'follow_up' }, key('book-3'));
  const cancelled = await appointments.cancel(context('desk'), three.appointment.appointmentId,
    { expectedRowVersion: 1, reason: 'The patient called to cancel' }, key('cancel-3'));
  assert.equal(cancelled.appointment.status, 'cancelled');
  await appointments.book(context('desk'), { patientId: ids.p2, departmentCode: 'general_outpatient', startsAt: slot(48 * 60 + 60),
    visitType: 'follow_up' }, key('book-4'));
  // Check-in (Q-APPT-6 A): p1 with the appointment as the basis; identity must be confirmed.
  await assert.rejects(appointments.checkIn(context('desk'), one.appointment.appointmentId,
    { expectedRowVersion: 1, identityConfirmed: false }, key('in-1-unconfirmed')), refused('APPOINTMENT_IDENTITY_NOT_CONFIRMED'));
  const sameDay = lagosDay(startOne) === lagosDay(new Date().toISOString())
    && lagosDay(slot(180)) === lagosDay(new Date().toISOString());
  let checkIns = 'skipped: the bookings cross midnight in Lagos';
  if (sameDay) {
    const inOne = await appointments.checkIn(context('desk'), one.appointment.appointmentId,
      { expectedRowVersion: 1, identityConfirmed: true }, key('in-1'));
    assert.equal(inOne.outcome, 'checked_in');
    assert.equal(inOne.entry.checkInBasis, 'appointment');
    assert.equal(inOne.appointment.visitQueueEntryId, inOne.entry.entryId);
    // p2 with a fresh search (basis search, through 0135's own check-in).
    const foundTwo = await search('Bayo', `Synthtwo${run}`, '1988-07-09');
    assert.equal(foundTwo.outcome, 'found');
    const inTwo = await appointments.checkIn(context('desk'), two.appointment.appointmentId,
      { expectedRowVersion: 2, identityConfirmed: true, matchRef: foundTwo.match_ref }, key('in-2'));
    assert.equal(inTwo.entry.checkInBasis, 'search');
    // A check-in is never an own-facility basis for the chart: p1 is still not this facility's own.
    const own = (await pool.query('select identity.own_facility_basis($1, $2) as basis', [ids.p1, ids.facility])).rows[0];
    assert.equal(own.basis, null);
    checkIns = 'appointment and search';
  }
  // The day list and the patient's own list.
  const day = await appointments.list(context('desk'), { day: lagosDay(startOne) });
  assert(day.items.some((item) => item.appointmentId === one.appointment.appointmentId));
  assert(!JSON.stringify(day).includes('HID-'));
  const mine = await appointments.mine({ correlationId: `appointments-runtime-patient-${run}`,
    actor: { kind: 'patient', patientId: ids.p1, accountId: ids.p1Account, subject: subjects.p1, sessionId: ids.p1Session } },
  { when: 'upcoming' });
  assert.deepEqual(mine.items.map((item) => item.appointmentId), [one.appointment.appointmentId]);
  assert.equal(mine.items[0].clinicianName, 'Chidi Synthdoctor');
  assert(!/membership|basis/i.test(JSON.stringify(mine)));
  // The call list (identity runtime): the booked appointment with the phone this facility recorded; not the cancelled.
  const calls = await callList.list({ correlationId: `appointments-runtime-calls-${run}`, facilityId: ids.facility,
    membershipId: ids.desk, purposeOfUse: 'direct-care', actor: { subject: subjects.desk } }, lagosDay(later), null, null);
  const ours = calls.items.filter((item) => item.fullName === `Bayo Synthtwo${run}`);
  assert.equal(ours.length, 1);
  assert.deepEqual([ours[0].phone, ours[0].phoneSource], ['+2348030000009', 'facility_contact']);
  // Audit: no name, Health ID, phone or reason text in any appointment row of this run.
  const leaked = (await pool.query(`select count(*)::integer as n from audit.events
    where facility_id = $1 and (action like 'ehr.appointment.%' or action like 'identity.appointment-call-list.%')
      and (details::text ~* $2 or coalesce(reason, '') <> '')`,
  [ids.facility, `synth(one|two)|amaka|bayo|HID-|2348030000009|blood pressure|called to cancel`])).rows[0].n;
  assert.equal(leaked, 0);
  process.stdout.write(JSON.stringify({ status: 'passed', scope: 'local-synthetic-only',
    roles: ['hid_ehr_api_runtime', 'hid_identity_api_runtime'], booked_by_search_and_own_facility: true,
    replay: true, clinician_clash: true, reschedule_and_stale_version: true, cancel: true, no_show_too_early: true,
    check_in: checkIns, day_list: day.items.length, my_appointments: mine.items.length, call_list_phone: 'facility_contact',
    audit_without_personal_text: true }) + '\n');
} finally {
  await pool.end();
}
