#!/usr/bin/env node
// ADT-1 (0170-0173; Release D, the owner's sprint approval of 25 November 2026): inpatient admission, wards and
// beds. ehr-api's own InpatientService, every statement run as hid_ehr_api_runtime in the context ehr-api's
// transactions set: ward setup by a facility admin (a ward, an ICU ward, beds, an overflow space, the staff list),
// a request by a doctor with chart access, a bed by a nurse with none (the name hidden on her board), a transfer into
// ICU, "Prepare discharge" and a routine discharge with its signed summary and print, the band, DAMA, absconded and
// died, the census, a reprint, the death record switched off, and, when BILL-1 is applied (0172), the admission bill,
// the admission fee, the bed-day sweep, a discharge with an unpaid bill and the interim statement. The chart grants
// are fixtures written as 0131 writes an own-facility opening. Executes only against the owned disposable synthetic
// rehearsal. No delivery or cloud calls; fictional people, places and identifiers only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
Object.assign(process.env, { INPATIENT_ENABLED: 'true', STORAGE_MODE: 'disabled' });
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const { Pool } = require('pg');
const { InpatientService, InpatientBedDaySweeper } = require(join(service, 'src/ehr/inpatient/inpatient.service.ts'));

const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 5 });
const run = randomUUID().slice(0, 8);
const id = (n) => `${run}-a170-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  organization: id(1), facility: id(2),
  adminAccount: id(11), adminStaff: id(12), admin: id(13),
  nurseAccount: id(21), nurseStaff: id(22), nurse: id(23),
  doctorAccount: id(31), doctorStaff: id(32), doctor: id(33),
  billingAccount: id(71), billingStaff: id(72), billing: id(73),
  p1: id(41), p2: id(42), p3: id(43), p4: id(44), p5: id(45), p6: id(46),
};
const subjects = { admin: `synthetic:inpatient-admin-${run}`, nurse: `synthetic:inpatient-nurse-${run}`,
  doctor: `synthetic:inpatient-doctor-${run}`, billing: `synthetic:inpatient-billing-${run}` };
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
const database = {
  withTransaction: (context, operation) => asRole('hid_ehr_api_runtime', staffSettings(context), operation),
  withSystemTransaction: (correlation, operation) => asRole('hid_ehr_api_runtime',
    { 'app.actor_subject': 'system:auth', 'app.correlation_id': correlation }, operation),
};
const inpatient = new InpatientService(database);
const context = (who, purposeOfUse = 'direct-care') => ({ correlationId: `inpatient-runtime-${who}-${randomUUID()}`,
  facilityId: ids.facility, membershipId: ids[who], purposeOfUse, actor: { subject: subjects[who] } });
const key = (label) => `inpatient-runtime-${run}-${label}`;
const refused = (code) => (error) => { assert.equal(error.code, code); return true; };

try {
  const billing = (await pool.query("select to_regprocedure('commercial.ward_charges_set(uuid, bigint, uuid, uuid)') is not null as present")).rows[0].present;
  // Fixtures, as the rehearsal's owner, triggers off (the suites' way).
  const seed = await pool.connect();
  try {
    await seed.query('begin');
    await seed.query('set local session_replication_role = replica');
    await seed.query(`insert into identity.purpose_of_use_codes (code, display, source_system)
      values ('direct-care', 'Direct patient care', 'inpatient-runtime'),
        ('healthcare-operations', 'Healthcare operations', 'inpatient-runtime')
      on conflict (code) do update set active = true`);
    await seed.query('insert into identity.organizations (id, name, slug) values ($1, $2, $3)',
      [ids.organization, `Synthetic Ward Group ${run}`, `synthetic-ward-${run}`]);
    await seed.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
      values ($1, $2, $3, $4, 'Africa/Lagos', true, 'verified')`, [ids.facility, ids.organization,
      `Synthetic Ward Hospital ${run}`, `SYN-ADT-${run}`.toUpperCase()]);
    const members = [['admin', 'admin', 'Ade Synthadmin'], ['nurse', 'nurse', 'Ngozi Synthnurse'],
      ['doctor', 'doctor', 'Dami Synthdoctor']];
    if (billing) members.push(['billing', 'billing_officer', 'Tobi Synthbilling']);
    for (const [who, role, name] of members) {
      await seed.query("insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, $4, 'active')",
        [ids[`${who}Account`], subjects[who], `${who}-${run}@example.invalid`, name]);
      await seed.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
        values ($1, $2, $3, $4, 'verified', $5)`, [ids[`${who}Staff`], ids[`${who}Account`], name,
        `${who}-${run}@example.invalid`, role]);
      await seed.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
        membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
        [ids[who], ids[`${who}Staff`], ids[`${who}Account`], ids.organization, ids.facility, role]);
      await seed.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
        grant_reason) values (gen_random_uuid(), $1, $2, 'facility', $3, $4, 'Synthetic inpatient runtime role')`,
        [ids[`${who}Account`], role, ids[who], ids.facility]);
    }
    for (const [index, who] of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].entries()) {
      await seed.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status,
        source_system) values ($1, $2, 'Pat', $3, $4, $5, date '1970-01-01' + $6::integer * 400, 'active', 'hid')`,
      [ids[who], `HID-W${letters}${'ABCDEF'[index]}2`, `Synthward${index + 1}${run}`, `Pat Synthward${index + 1}${run}`,
        index % 2 === 0 ? 'female' : 'male', index]);
      // The doctor's chart access, as 0131 writes an own-facility opening (24 hours of write access, direct care).
      await seed.query(`insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
        scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, authorization_method)
        values (gen_random_uuid(), $1, $2, $3, $4, $5, 'write_records', 'direct-care', 'active',
          'Opened as this facility''s patient', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day',
          false, 'own_facility')`, [ids[who], ids.doctorStaff, ids.doctorAccount, ids.doctor, ids.facility]);
    }
    if (billing) {
      await seed.query(`insert into commercial.payment_settings (facility_id, updated_by_membership_id, idempotency_key,
        request_sha256) values ($1, $2, $3, repeat('0', 64))`, [ids.facility, ids.billing, key('settings')]);
      for (const [n, name, kobo] of [[81, 'Synthetic bed-day', 500000], [82, 'Synthetic admission fee', 300000]]) {
        await seed.query(`insert into commercial.catalogue_items (id, facility_id, kind, name, active, created_by_membership_id,
          updated_by_membership_id, idempotency_key, request_sha256) values ($1, $2, 'other', $3, true, $4, $4, $5,
          repeat('0', 64))`, [id(n), ids.facility, name, ids.billing, key(`item-${n}`)]);
        await seed.query(`insert into commercial.catalogue_item_prices (facility_id, catalogue_item_id, hmo_id, amount_kobo,
          active) values ($1, $2, null, $3, true)`, [ids.facility, id(n), kobo]);
      }
    }
    await seed.query('commit');
  } finally {
    seed.release();
  }

  // Ward setup (Q191 A): facility admins, for healthcare operations.
  const setup = context('admin', 'healthcare-operations');
  const general = (await inpatient.createWard(setup, { name: `Female Ward ${run}`, wardType: 'general', takes: 'female' },
    key('ward-general'))).ward;
  const icu = (await inpatient.createWard(setup, { name: `ICU ${run}`, wardType: 'icu' }, key('ward-icu'))).ward;
  const beds = {};
  for (const [ward, name, kind] of [[general, 'Bed 1', 'bed'], [general, 'Bed 2', 'bed'], [general, 'Bed 3', 'bed'],
    [general, 'Extra mattress 1', 'overflow'], [icu, 'ICU Bed 1', 'bed'], [icu, 'ICU Bed 2', 'bed']]) {
    beds[name] = (await inpatient.createBed(setup, ward.wardId, { name, kind }, key(`bed-${name}`))).bedId;
  }
  const staffed = (await inpatient.setWardStaff(setup, general.wardId, { expectedRowVersion: 5,
    membershipIds: [ids.nurse, ids.doctor] }, key('staff'))).ward;
  assert.deepEqual([staffed.bedCount, staffed.overflowCount, staffed.staffCount], [3, 1, 2]);
  await assert.rejects(inpatient.createWard(context('nurse', 'healthcare-operations'), { name: 'No', wardType: 'other' },
    key('ward-nurse')), refused('WARD_SETUP_NOT_ALLOWED'));
  if (billing) {
    for (const ward of [general, icu]) {
      await inpatient.setWardCharges(context('billing', 'healthcare-operations'), ward.wardId,
        { expectedVersion: 0, bedDayItemId: id(81), admissionFeeItemId: id(82) });
    }
  }

  // A request (Q184 A): the planned stay at once; a bed by the nurse (no chart access, Q-ADT-11 A).
  const requested = (await inpatient.request(context('doctor'), { patientId: ids.p1, source: 'direct',
    reason: 'Synthetic pneumonia', responsibleMembershipId: ids.doctor, requestedWardId: general.wardId },
  key('request-1'))).admission;
  assert.equal(requested.status, 'requested');
  assert.equal((await inpatient.request(context('doctor'), { patientId: ids.p1, source: 'direct',
    reason: 'Synthetic pneumonia', responsibleMembershipId: ids.doctor, requestedWardId: general.wardId },
  key('request-1'))).replayed, true);
  await assert.rejects(inpatient.request(context('nurse'), { patientId: ids.p2, source: 'direct', reason: 'Synthetic',
    responsibleMembershipId: ids.doctor }, key('request-nurse')), refused('ADMISSION_DECIDE_NOT_ALLOWED'));
  let card = (await inpatient.admit(context('nurse'), requested.admissionId,
    { expectedRowVersion: requested.rowVersion, bedId: beds['Bed 1'] }, key('admit-1'))).admission;
  assert.deepEqual([card.status, card.bedName], ['admitted', 'Bed 1']);
  if (billing) assert.match(String(card.billId), /^[0-9a-f-]{36}$/);
  const board = await inpatient.bedBoard(context('nurse'), general.wardId, undefined);
  const occupied = board.wards[0].beds.find((bed) => bed.name === 'Bed 1');
  assert.deepEqual([occupied.status, occupied.patient.nameHidden, occupied.patient.fullName], ['occupied', true, null]);
  assert(!JSON.stringify(board).includes('HID-'));
  const band = await inpatient.wristband(context('nurse'), requested.admissionId, {}, key('band-1'), false);
  assert.match(band.healthId, /^HID-W/);
  assert.equal(band.printNumber, 1);
  await assert.rejects(inpatient.wristband(context('nurse'), requested.admissionId, {}, key('band-1b'), false),
    refused('REPRINT_REASON_REQUIRED'));

  // Into ICU, then a routine discharge after "Prepare discharge", with its signed summary and print.
  card = (await inpatient.transfer(context('nurse'), card.admissionId, { expectedRowVersion: card.rowVersion,
    bedId: beds['ICU Bed 1'] }, key('transfer-1'))).admission;
  assert.equal(card.bedName, 'ICU Bed 1');
  await assert.rejects(inpatient.discharge(context('doctor'), card.admissionId, { expectedRowVersion: card.rowVersion,
    outcome: 'routine', signature: 'SIGN', summary: { presentingProblem: 'Synthetic cough', courseInHospital: 'Better' } },
  key('discharge-early')), refused('DISCHARGE_NOT_PREPARED'));
  card = (await inpatient.prepareDischarge(context('doctor'), card.admissionId, { expectedRowVersion: card.rowVersion,
    followUpPlan: 'Synthetic clinic in two weeks' }, key('prepare-1'))).admission;
  assert.equal(card.status, 'discharge_ready');
  const discharged = await inpatient.discharge(context('doctor'), card.admissionId, { expectedRowVersion: card.rowVersion,
    outcome: 'routine', signature: 'SIGN', summary: { presentingProblem: 'Synthetic cough',
      courseInHospital: 'Synthetic recovery', conditionAtDischarge: 'improved' } }, key('discharge-1'));
  assert.equal(discharged.admission.status, 'discharged');
  const summary = await inpatient.dischargeSummary(context('doctor'), card.admissionId);
  assert.deepEqual([summary.outcome, summary.patient.healthId, summary.summary.conditionAtDischarge],
    ['routine', null, 'improved']);

  // DAMA and died from admitted; absconded; the census.
  for (const [who, outcome, bed] of [['p3', 'dama', 'Bed 2'], ['p5', 'died', 'Bed 3']]) {
    const asked = (await inpatient.request(context('doctor'), { patientId: ids[who], source: 'direct',
      reason: 'Synthetic', responsibleMembershipId: ids.doctor }, key(`request-${who}`))).admission;
    const given = (await inpatient.admit(context('nurse'), asked.admissionId, { expectedRowVersion: asked.rowVersion,
      bedId: beds[bed] }, key(`admit-${who}`))).admission;
    const done = await inpatient.discharge(context('doctor'), given.admissionId, { expectedRowVersion: given.rowVersion,
      outcome, signature: 'SIGN',
      ...(outcome === 'died' ? { diedAt: new Date().toISOString() }
        : { summary: { presentingProblem: 'Synthetic fever', courseInHospital: 'Synthetic' } }) }, key(`discharge-${who}`));
    assert.equal(done.admission.discharge.outcome, outcome);
  }
  await assert.rejects(inpatient.deathRecordRead(context('doctor'), discharged.admission.admissionId),
    refused('DEATH_RECORD_NOT_AVAILABLE'));
  const census = await inpatient.census(context('nurse'), undefined);
  assert.deepEqual([census.facility.beds, census.facility.admitted, census.facility.discharged, census.facility.died],
    [6, 3, 2, 1]);
  assert(!JSON.stringify(census).includes('Synthward'));

  // Charges (BILL-1 and 0172): a discharge with an unpaid bill, then the interim statement.
  let charges = null;
  if (billing) {
    const asked = (await inpatient.request(context('doctor'), { patientId: ids.p6, source: 'direct', reason: 'Synthetic',
      responsibleMembershipId: ids.doctor }, key('request-p6'))).admission;
    const given = (await inpatient.admit(context('nurse'), asked.admissionId, { expectedRowVersion: asked.rowVersion,
      bedId: beds['ICU Bed 2'] }, key('admit-p6'))).admission;
    const swept = await new InpatientBedDaySweeper(database).sweep();
    const out = await inpatient.discharge(context('doctor'), given.admissionId, { expectedRowVersion: given.rowVersion,
      outcome: 'absconded', signature: 'SIGN' }, key('discharge-p6'));
    assert.equal(out.admission.status, 'discharged');
    const statement = await inpatient.interimStatement(context('billing', 'healthcare-operations'), given.billId);
    assert.match(statement.statementNumber, /^I-\d{4}-\d{6}$/);
    assert(statement.dueKobo > 0, 'the bill stays open after discharge');
    charges = { admission_bill: true, admission_fee: true, sweep_added: swept, discharged_with_balance: true,
      interim_statement: true };
  }

  // Audit: no name, Health ID, reason or summary text in any inpatient row of this run.
  const leaked = (await pool.query(`select count(*)::integer as n from audit.events
    where facility_id = $1 and (action like 'ehr.ward%' or action like 'ehr.bed%' or action like 'ehr.admission%'
      or action like 'ehr.discharge%' or action like 'ehr.wristband%' or action like 'ehr.census%')
      and (details::text ~* $2 or coalesce(reason, '') <> '')`,
  [ids.facility, 'synthward|HID-W|pneumonia|cough|recovery|fever'])).rows[0].n;
  assert.equal(leaked, 0);
  process.stdout.write(JSON.stringify({ status: 'passed', scope: 'local-synthetic-only', roles: ['hid_ehr_api_runtime'],
    ward_setup: true, request_admit_transfer: true, name_hidden_without_grant: true, band: true,
    outcomes: ['routine', 'dama', 'died', ...(billing ? ['absconded'] : [])], discharge_summary_print: true,
    death_record_switched_off: true, census: true, charges, audit_without_personal_text: true }) + '\n');
} finally {
  await pool.end();
}
