#!/usr/bin/env node
// ED-1 (0168, 0169; Release D, built at the recommended options Q-ED-1 A to Q-ED-7 A): the emergency department
// board. ehr-api's own EdBoardService and VisitQueueService (every statement run as hid_ehr_api_runtime in the
// context ehr-api's transactions set) and identity-api's staff patient search (as hid_identity_api_runtime): arrival
// by each basis (a desk search's matchRef, this facility's own patient, an emergency search's matchRef with the
// member's own break-glass grant), triage, start care, the visit link, each kind of disposition, "Left the
// department", cancel, the waiting-list helper, the waiting list's guard and, with ED_BOARD_ENABLED switched off
// after use (the kill switch), the waiting list finishing a board patient's row. The emergency search's
// matchRef and the break-glass grant are fixtures written as 0132 and 0031 write them (ID-5's own verifier covers
// the activation). Executes only against the owned disposable synthetic rehearsal. No delivery or cloud calls;
// fictional people, places and identifiers only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
// The waiting list reads ED_BOARD_ENABLED through ehr-api's configuration, which needs these to parse; no
// connection is made with DATABASE_URL (the pool below uses the rehearsal's socket).
Object.assign(process.env, { ED_BOARD_ENABLED: 'true', STORAGE_MODE: 'disabled',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://unused@localhost/unused',
  CORS_ORIGINS: process.env.CORS_ORIGINS ?? 'http://localhost:3000' });
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const { Pool } = require('pg');
const { EdBoardService } = require(join(service, 'src/ehr/ed-board/ed-board.service.ts'));
const { VisitQueueService } = require(join(service, 'src/ehr/worklist/visit-queue.service.ts'));
const { resetEnvironmentForTests } = require(join(service, 'src/config/environment.ts'));

const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 5 });
const run = randomUUID().slice(0, 8);
const id = (n) => `${run}-e168-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  organization: id(1), facility: id(2),
  deskAccount: id(11), deskStaff: id(12), desk: id(13),
  nurseAccount: id(21), nurseStaff: id(22), nurse: id(23),
  doctorAccount: id(31), doctorStaff: id(32), doctor: id(33),
  p1: id(41), p2: id(42), p3: id(43), p4: id(44), p5: id(45), visit: id(51), grant: id(61),
};
const subjects = { desk: `synthetic:ed-board-desk-${run}`, nurse: `synthetic:ed-board-nurse-${run}`,
  doctor: `synthetic:ed-board-doctor-${run}` };
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
  'app.purpose_of_use': context.purposeOfUse });
const ehrDatabase = { withTransaction: (context, operation) => asRole('hid_ehr_api_runtime', staffSettings(context), operation) };
const board = new EdBoardService(ehrDatabase);
const queue = new VisitQueueService(ehrDatabase);
const context = (who, purposeOfUse = 'direct-care') => ({ correlationId: `ed-board-runtime-${who}-${randomUUID()}`,
  facilityId: ids.facility, membershipId: ids[who], purposeOfUse, actor: { subject: subjects[who] } });
const key = (label) => `ed-board-runtime-${run}-${label}`;
const refused = (code) => (error) => { assert.equal(error.code, code); return true; };

try {
  // Fixtures, as the rehearsal's owner, triggers off (the suites' way).
  const emergencyRef = `psr_${createHash('sha256').update(`ed-board-${run}`).digest('base64url').slice(0, 43)}`;
  const seed = await pool.connect();
  try {
    await seed.query('begin');
    await seed.query('set local session_replication_role = replica');
    await seed.query(`insert into identity.purpose_of_use_codes (code, display, source_system)
      values ('direct-care', 'Direct patient care', 'ed-board-runtime'), ('emergency', 'Emergency care', 'ed-board-runtime')
      on conflict (code) do update set active = true`);
    await seed.query('insert into identity.organizations (id, name, slug) values ($1, $2, $3)',
      [ids.organization, `Synthetic Emergency Group ${run}`, `synthetic-emergency-${run}`]);
    await seed.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
      values ($1, $2, $3, $4, 'Africa/Lagos', true, 'verified')`, [ids.facility, ids.organization,
      `Synthetic Emergency Clinic ${run}`, `SYN-ED-${run}`.toUpperCase()]);
    for (const [who, role, name] of [['desk', 'receptionist', 'Ada Synthdesk'], ['nurse', 'nurse', 'Bola Synthnurse'],
      ['doctor', 'doctor', 'Chidi Synthdoctor']]) {
      await seed.query("insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, $4, 'active')",
        [ids[`${who}Account`], subjects[who], `${who}-${run}@example.invalid`, name]);
      await seed.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
        values ($1, $2, $3, $4, 'verified', $5)`, [ids[`${who}Staff`], ids[`${who}Account`], name,
        `${who}-${run}@example.invalid`, role]);
      await seed.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
        membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
        [ids[who], ids[`${who}Staff`], ids[`${who}Account`], ids.organization, ids.facility, role]);
      await seed.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
        grant_reason) values (gen_random_uuid(), $1, $2, 'facility', $3, $4, 'Synthetic emergency board runtime role')`,
        [ids[`${who}Account`], role, ids[who], ids.facility]);
    }
    const patients = [['p1', 'Amaka', 'Synthed', 'hid'], ['p2', 'Bayo', 'Synthown', 'hid-desk-registration'],
      ['p3', 'Chika', 'Synthurgent', 'hid'], ['p4', 'Dayo', 'Synthmistake', 'hid-desk-registration'],
      ['p5', 'Efe', 'Synthqueue', 'hid-desk-registration']];
    for (const [index, [who, first, last, source]] of patients.entries()) {
      await seed.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status,
        source_system) values ($1, $2, $3, $4, $5, 'female', date '1990-01-01' + $6::integer, 'active', $7)`,
      [ids[who], `HID-E${letters}${'ABCDE'[index]}2`, first, `${last}${run}`, `${first} ${last}${run}`, index, source]);
      if (source === 'hid-desk-registration') {
        await seed.query(`insert into identity.registration_cases (id, facility_id, created_by_account_id,
          created_by_membership_id, status, first_name, last_name, full_name, dob, identity_evidence, no_nin_reason,
          idempotency_key, request_sha256, resolved_patient_id, review_idempotency_key, review_request_sha256,
          reviewed_by_account_id, reviewed_by_membership_id, review_reason, created_at, updated_at)
          values (gen_random_uuid(), $1, $2, $3, 'approved_new_identity', $4, $5, $6, date '1990-01-01' + $7::integer,
            'none', 'no_nin', $8, $9, $10, $11, $9, $2, $3, 'Checked at the desk', clock_timestamp() - interval '3 days',
            clock_timestamp() - interval '3 days')`,
        [ids.facility, ids.deskAccount, ids.desk, first, `${last}${run}`, `${first} ${last}${run}`, index,
          key(`case-${who}`), '0'.repeat(64), ids[who], key(`review-${who}`)]);
      }
    }
    // p3: the doctor's emergency search (0132) and the doctor's break-glass grant (0031), as those write them.
    await seed.query(`insert into identity.patient_search_refs (token_sha256, patient_id, account_id, membership_id,
      facility_id, purpose_of_use, search_mode, created_at, expires_at)
      values ($1, $2, $3, $4, $5, 'emergency', 'emergency', statement_timestamp(), statement_timestamp() + interval '10 minutes')`,
    [createHash('sha256').update(emergencyRef).digest('hex'), ids.p3, ids.doctorAccount, ids.doctor, ids.facility]);
    await seed.query(`insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, created_at)
      values ($1, $2, $3, $4, $5, $6, 'break_glass', 'emergency', 'active', 'Unconscious on arrival, synthetic',
        clock_timestamp() - interval '1 minute', clock_timestamp() + interval '59 minutes', true, clock_timestamp())`,
    [ids.grant, ids.p3, ids.doctorStaff, ids.doctorAccount, ids.doctor, ids.facility]);
    // p1's emergency visit (EHR-C1), started now by the doctor.
    await seed.query(`insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id,
      encounter_type, status, started_at, chief_complaint, created_at)
      values ($1, $2, $3, $4, $5, 'emergency', 'in_progress', clock_timestamp(), 'Synthetic emergency visit', clock_timestamp())`,
    [ids.visit, ids.p1, ids.facility, ids.doctorAccount, ids.doctor]);
    await seed.query('commit');
  } finally {
    seed.release();
  }

  // Arrival by each basis.
  const found = await asRole('hid_identity_api_runtime', staffSettings(context('desk')), async (client) =>
    (await client.query(`select outcome, match_ref from identity.staff_patient_search('standard', 'Amaka', $1,
      date '1990-01-01', null, null, null, null)`, [`Synthed${run}`])).rows[0]);
  assert.equal(found.outcome, 'found');
  const one = await board.arrive(context('desk'), { matchRef: found.match_ref, arrivalMode: 'ambulance' }, key('arrive-1'));
  assert.deepEqual([one.outcome, one.attendance.arrivalBasis, one.attendance.column, one.attendance.complaintHidden],
    ['arrived', 'search', 'waiting', true]);
  const replay = await board.arrive(context('desk'), { matchRef: found.match_ref, arrivalMode: 'ambulance' }, key('arrive-1'));
  assert.equal(replay.replayed, true);
  const two = await board.arrive(context('nurse'), { patientId: ids.p2, arrivalMode: 'walk_in', triageLevel: 3,
    presentingComplaint: 'Synthetic abdominal pain' }, key('arrive-2'));
  assert.deepEqual([two.attendance.arrivalBasis, two.attendance.stage, two.attendance.triageLevel],
    ['own-facility', 'ready', 3]);
  const three = await board.arrive(context('doctor', 'emergency'), { matchRef: emergencyRef, arrivalMode: 'brought_by_public',
    triageLevel: 1 }, key('arrive-3'));
  assert.equal(three.attendance.arrivalBasis, 'emergency');
  await assert.rejects(board.arrive(context('desk'), { patientId: ids.p3, arrivalMode: 'walk_in' }, key('arrive-3-desk')),
    refused('ED_ARRIVAL_NEEDS_SEARCH'));
  await assert.rejects(board.arrive(context('desk'), { patientId: ids.p4, arrivalMode: 'walk_in', triageLevel: 2 },
    key('arrive-4-desk-triage')), refused('ED_TRIAGE_NOT_ALLOWED'));

  // Triage, start care, the visit link, the admission request, then "Left the department".
  let card = (await board.triage(context('nurse'), one.attendance.attendanceId,
    { expectedRowVersion: one.attendance.rowVersion, triageLevel: 2, presentingComplaint: 'Synthetic chest pain' },
    key('triage-1'))).attendance;
  assert.deepEqual([card.triageLevel, card.stage], [2, 'ready']);
  card = (await board.move(context('doctor'), card.attendanceId, { expectedRowVersion: card.rowVersion,
    stage: 'with_clinician', assignedMembershipId: ids.doctor }, key('start-1'))).attendance;
  assert.equal(card.column, 'being_seen');
  card = (await board.linkVisit(context('doctor'), card.attendanceId, { expectedRowVersion: card.rowVersion,
    encounterId: ids.visit }, key('visit-1'))).attendance;
  assert.equal(card.encounterId, ids.visit);
  await assert.rejects(board.disposition(context('nurse'), card.attendanceId, { expectedRowVersion: card.rowVersion,
    outcome: 'discharged' }, key('nurse-decides')), refused('ED_DISPOSITION_NOT_ALLOWED'));
  card = (await board.disposition(context('doctor'), card.attendanceId, { expectedRowVersion: card.rowVersion,
    outcome: 'admit_requested', admitToDepartmentCode: 'inpatient' }, key('admit-1'))).attendance;
  assert.deepEqual([card.column, card.disposition?.outcome], ['disposition', 'admit_requested']);
  card = (await board.leave(context('nurse'), card.attendanceId, { expectedRowVersion: card.rowVersion },
    key('leave-1'))).attendance;
  assert.deepEqual([card.status, card.stage], ['closed', 'finished']);

  // Sent to outpatients: the ED record closes, the waiting-list row is back to waiting with its level.
  const sent = (await board.disposition(context('doctor'), two.attendance.attendanceId,
    { expectedRowVersion: two.attendance.rowVersion, outcome: 'sent_to_outpatients' }, key('outpatients-2'))).attendance;
  assert.deepEqual([sent.status, sent.stage, sent.triageLevel], ['closed', 'waiting', 3]);
  // Left before being seen: both close.
  const gone = (await board.disposition(context('doctor'), three.attendance.attendanceId,
    { expectedRowVersion: three.attendance.rowVersion, outcome: 'left_before_seen' }, key('lbs-3'))).attendance;
  assert.deepEqual([gone.status, gone.stage], ['closed', 'left']);
  // Cancel an arrival made in error: only the ED record closes; the waiting-list row the arrival made stays open,
  // back to waiting (an outpatient check-in may have claimed it since), for the desk to cancel there if need be.
  const four = await board.arrive(context('desk'), { patientId: ids.p4, arrivalMode: 'walk_in' }, key('arrive-4'));
  const cancelled = (await board.cancel(context('desk'), four.attendance.attendanceId,
    { expectedRowVersion: four.attendance.rowVersion, reason: 'Added to the board by mistake' }, key('cancel-4'))).attendance;
  assert.deepEqual([cancelled.status, cancelled.stage], ['closed', 'waiting']);
  const kept = (await queue.list(context('desk'), false)).items.find((item) => item.patientId === ids.p4);
  assert.deepEqual([kept?.stage, kept?.closedAt ?? null, kept?.edAttendanceId ?? null], ['waiting', null, null]);
  // The waiting list marks an open board patient, and refuses to change its row (the guard): the stage, the triage
  // level and who sees the patient belong to the board. The board then closes it.
  const five = await board.arrive(context('desk'), { patientId: ids.p5, arrivalMode: 'police' }, key('arrive-5'));
  const waiting = await queue.list(context('desk'), false);
  const row = waiting.items.find((item) => item.patientId === ids.p5);
  assert.equal(row?.edAttendanceId, five.attendance.attendanceId);
  assert.equal(waiting.items.find((item) => item.patientId === ids.p2)?.edAttendanceId, null);
  for (const change of [{ stage: 'left' }, { triageLevel: 1 }]) {
    await assert.rejects(queue.update(context('nurse'), row.entryId, { expectedRowVersion: row.rowVersion, ...change }),
      (error) => error.code === 'VISIT_QUEUE_ON_ED_BOARD' && error.getStatus() === 409);
  }
  const guarded = await board.read(context('desk'), five.attendance.attendanceId);
  assert.equal(guarded.attendance.status, 'open');
  assert.equal(guarded.attendance.rowVersion, five.attendance.rowVersion);
  // The kill switch: with ED_BOARD_ENABLED off after use, the row is an ordinary waiting-list row and the desk can
  // finish it; the ED record closes with it (closed_on_waiting_list, one audit row with boardOff).
  process.env.ED_BOARD_ENABLED = 'false';
  resetEnvironmentForTests();
  let finished;
  try {
    const plain = (await queue.list(context('desk'), false)).items.find((item) => item.patientId === ids.p5);
    assert.equal(plain?.edAttendanceId, null);
    finished = await queue.update(context('desk'), plain.entryId, { expectedRowVersion: plain.rowVersion, stage: 'finished' });
  } finally {
    process.env.ED_BOARD_ENABLED = 'true';
    resetEnvironmentForTests();
  }
  assert.deepEqual([finished.stage, finished.closedAt !== null], ['finished', true]);
  const released = await board.read(context('desk'), five.attendance.attendanceId);
  assert.equal(released.attendance.status, 'closed');
  assert.deepEqual(released.history.map((entry) => entry.kind), ['arrived', 'closed_on_waiting_list']);
  const boardOffAudit = (await pool.query(`select count(*)::integer as n from audit.events
    where action = 'ehr.ed.closed-on-waiting-list' and resource_id = $1 and details ->> 'boardOff' = 'true'`,
  [five.attendance.attendanceId])).rows[0].n;
  assert.equal(boardOffAudit, 1);
  // The board now: nobody open; with closed today, all five.
  const shown = await board.board(context('desk'), true);
  assert.deepEqual(shown.counts, { waiting: 0, beingSeen: 0, disposition: 0 });
  assert.equal(shown.items.filter((item) => item.status === 'closed').length, 5);
  assert(!JSON.stringify(shown).includes('HID-'));
  assert(shown.items.every((item) => item.complaintHidden && item.presentingComplaint === null));
  // Audit: no name, Health ID, complaint or reason text in any row of this run.
  const leaked = (await pool.query(`select count(*)::integer as n from audit.events
    where facility_id = $1 and (action like 'ehr.ed.%' or action like 'ehr.visit-queue.%')
      and (details::text ~* $2 or coalesce(reason, '') <> '')`,
  [ids.facility, `synth(ed|own|urgent|mistake|queue)|amaka|bayo|chika|HID-E|abdominal|chest pain|by mistake`])).rows[0].n;
  assert.equal(leaked, 0);
  process.stdout.write(JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', roles: ['hid_ehr_api_runtime',
    'hid_identity_api_runtime'], arrival_bases: ['search', 'own-facility', 'emergency'], replay: true,
    triage_move_visit: true, dispositions: ['admit_requested', 'sent_to_outpatients', 'left_before_seen'],
    leave: true, cancel: true, waiting_list_helper: true, waiting_list_guard: true, board_off_waiting_list: true,
    complaint_hidden_from_desk: true,
    audit_without_personal_text: true }) + '\n');
} finally {
  await pool.end();
}
