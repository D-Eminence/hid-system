\set ON_ERROR_STOP on
-- 0168 and 0169 (ED-1, Release D; built at the recommended options Q-ED-1 A to
-- Q-ED-7 A, not yet answered by the owner): the emergency department board.
-- Rollback-only. The board's functions run as ehr-api's login role
-- (hid_ehr_api_runtime) and the patient search that hands out a matchRef as
-- identity-api's (hid_identity_api_runtime), each in the context its
-- service's transactions set. Needs 0001-0151 with 0168 and 0169 applied and
-- the runtime roles bootstrapped. Fictional people, places and identifiers
-- only; ids start e168.
--
--   1. arrival by each basis: a desk search's matchRef (search), this
--      facility's own patient (own_facility), an emergency search's matchRef
--      with the member's own active break-glass grant (emergency); an
--      emergency matchRef without a grant, with another member's grant, with
--      an expired grant, a stranger by id, a sealed demo patient and an
--      inactive patient are all needs_search; a patient on the outpatient
--      waiting list moves to the board (moved_from_waiting_list), a second
--      arrival answers already_on_board (its triage fields not applied), and
--      0135's check-in then answers already_open with the same row;
--   2. who may: the front desk arrives but cannot triage, record a complaint
--      or a disposition; a nurse triages but cannot record a disposition;
--      lab and administrator staff have no board; the board is direct care
--      only, arrival with an emergency matchRef is the one exception;
--   3. the unknown patient (0145) arrives by patient id, shows "Unknown
--      patient U-0007", its label and an estimated age; once identified its
--      real name shows by itself;
--   4. the board: columns, most urgent first, counts, the complaint hidden
--      from the front desk on every answer and shown to nurses, clinicians and
--      doctors; another facility sees nothing;
--   5. triage, move, start care, the assignee rule, the visit link (another
--      patient's visit, another facility's visit, a cancelled visit and one
--      started long before the arrival are all visit_invalid);
--   6. each disposition outcome with its waiting-list stage: discharged,
--      admit_requested (department rules), referred_out stay decided until
--      "Left the department"; left_before_seen and left_against_advice close
--      both (left); died closes both (finished); sent_to_outpatients closes
--      the ED record only and puts the row back to waiting, with nobody down
--      to see the patient; changing a decision needs a reason;
--   7. cancel: only open with no visit; only the ED record closes, the
--      waiting-list row stays open in both orders: a row moved from the
--      outpatient waiting list is put back as it was before the move (stage,
--      level, assignee); the row the arrival made goes back to waiting with no
--      level and nobody down, so an outpatient check-in that claimed it after
--      the arrival (0135's already_open, the same row) is not undone;
--   8. the guard and the mirror: while a row has an open or decided ED
--      record, 0135's waiting-list update is refused for it (stage, close,
--      triage level, clearing it, assignee; front desk, nurse and doctor
--      alike), so a board save from the record's version cannot overwrite a
--      change made elsewhere; a row of a patient whose record is no longer
--      active (0145's cancel) still closes (any other change of it is still
--      refused), and the mirror closes its ED
--      record once (closed_on_waiting_list, one audit row); an ED close does
--      not run it; "left today" is the Lagos day the record left, whenever
--      it arrived;
--   9. version conflicts, idempotent replays and a reused key;
--  10. the history (its free-text reasons, a cancel's and a changed
--      disposition's, only for members holding ehr.ed.triage: the front desk
--      reads reason null, as it reads no complaint), the waiting-list helper,
--      the runtime cannot read the
--      tables or call the helpers, nor read or advance the history's
--      sequence (no runtime role holds any privilege on it after
--      runtime-grants.sql); the history cannot be updated, deleted or
--      emptied (TRUNCATE), even by its owner;
--  11. audit: every row's outcome, and no name, date of birth, Health ID,
--      complaint, referral facility name or reason text in any ED audit row;
--  12. the board switched off after use (ED_BOARD_ENABLED off: ehr-api sends
--      the waiting list's changes through ehr.visit_queue_ed_board_off_update):
--      a board patient's row can be finished, cancelled (a decided record
--      too) or changed (triage level) on the waiting list; each closes its ED
--      record once (closed_via waiting_list, one closed_on_waiting_list event,
--      one audit row with boardOff true as the waiting-list action's actor);
--      a stale version, a role without the waiting list and another
--      facility's member change nothing; a row with no ED record is 0135's
--      update; the marker is cleared afterwards, so 0135's own update is
--      still refused for another board patient's row (the guard stays in
--      force while the flag is on);
--  13. the board's marker as a later file uses it (ADT-1's 0171 admits a
--      patient from the board this way): the owner's own close of a board
--      patient's waiting-list row is refused without it; with
--      hid.ed_board_closing naming the row (its id as text, transaction-local)
--      the close goes through and the mirror stays out, so the ED record is
--      still open until the caller closes it; once the marker is cleared the
--      guard is back for the row; a marker naming the ED record's id instead
--      opens nothing;
--  14. what the clinical lead's checklist and the DPO's Q-ED-3 item ask about
--      (Rahman, #337 7175564791): the front desk may cancel an arrival a nurse
--      triaged at level 1, and the level then leaves the outpatient row; a
--      cancelled emergency-basis arrival's row stays open on the facility's
--      outpatient waiting list, where the desk sees the patient by name.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.
begin;

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'ed-board-test'),
  ('emergency', 'Emergency care', 'ed-board-test')
  on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1680000-0000-4000-8000-000000000001', 'Board Group A', 'board-group-a'),
  ('e1680000-0000-4000-8000-000000000011', 'Board Group B', 'board-group-b');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1680000-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000001', 'Board Clinic A',
   'BOARD-A', 'Africa/Lagos', true, 'verified'),
  ('e1680000-0000-4000-8000-000000000012', 'e1680000-0000-4000-8000-000000000011', 'Board Clinic B',
   'BOARD-B', 'Africa/Lagos', true, 'verified');
create temporary table b_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into b_members values
  (1, 'e1680000-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000001', 'receptionist', 'Ada Desk'),
  (2, 'e1680000-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000001', 'nurse', 'Bola Nurse'),
  (3, 'e1680000-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000001', 'doctor', 'Chidi Doctor'),
  (4, 'e1680000-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000001', 'clinician', 'Dupe Clinician'),
  (5, 'e1680000-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000001', 'lab', 'Efe Lab'),
  (6, 'e1680000-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000001', 'admin', 'Femi Admin'),
  (7, 'e1680000-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000001', 'doctor', 'Gbenga Doctor'),
  (8, 'e1680000-0000-4000-8000-000000000012', 'e1680000-0000-4000-8000-000000000011', 'doctor', 'Hauwa Doctor'),
  (9, 'e1680000-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000001', 'pharmacist', 'Ife Pharmacist');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1680100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:board-member-' || n,
  'board-member-' || n || '@example.invalid', name, 'active' from b_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1680200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1680100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'board-member-' || n || '@example.invalid', 'verified', role_code from b_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1680300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1680200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1680100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, organization, facility, role_code, role_code,
  true, true
from b_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('e1680100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
  ('e1680300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, facility, 'Synthetic board suite role'
from b_members;

-- Patients (Health IDs HID-ED + two letters): p1 found by the desk's search; p3 and p4 found by the doctor's
-- emergency search (p3 with the doctor's break-glass grant, p4 with another member's and an expired one); p6 an
-- unknown record made at A; p7 sealed demo; p9 inactive; p10 a stranger; p2, p5 and p11-p25 registered at A's desk.
create temporary table b_patients (n integer primary key, hid text, first text, last text, sex text, status text,
  source text) on commit drop;
insert into b_patients values
  (1, 'HID-EDAA22', 'Amaka', 'Edone', 'female', 'active', 'hid'),
  (2, 'HID-EDAB22', 'Bayo', 'Edtwo', 'male', 'active', 'hid-desk-registration'),
  (3, 'HID-EDAC22', 'Chika', 'Edthree', 'female', 'active', 'hid'),
  (4, 'HID-EDAD22', 'Dayo', 'Edfour', 'male', 'active', 'hid'),
  (5, 'HID-EDAE22', 'Ebere', 'Edfive', 'female', 'active', 'hid-desk-registration'),
  (7, 'HID-EDAG22', 'Gozie', 'Edseven', 'male', 'active', 'hid'),
  (9, 'HID-EDAJ22', 'Jide', 'Ednine', 'male', 'inactive', 'hid-desk-registration'),
  (10, 'HID-EDAK22', 'Kemi', 'Edten', 'female', 'active', 'hid');
insert into b_patients
select n, 'HID-EDB' || translate(lpad(n::text, 2, '0'), '0123456789', 'ABCDEFGHJK') || '2', 'Ola', 'Edperson' || n,
  case when n % 2 = 0 then 'female' else 'male' end, 'active', 'hid-desk-registration'
from generate_series(11, 25) n;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
select ('e1680400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, hid, first, last, first || ' ' || last,
  sex, date '1980-01-01' + n, status, source from b_patients;
-- p6: an unknown record made at A's desk (0145), with an estimated date of birth.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
values ('e1680400-0000-4000-8000-000000000006', 'HID-EDAF22', 'Unknown', 'U-0007', 'Unknown patient U-0007', 'male',
  date '1986-01-01', 'active', 'hid-unknown-patient');
insert into identity.unknown_patients (patient_id, facility_id, label_number, unknown_reason, created_by_account_id,
  created_by_membership_id, idempotency_key, request_sha256)
values ('e1680400-0000-4000-8000-000000000006', 'e1680000-0000-4000-8000-000000000002', 7, 'unconscious',
  'e1680100-0000-4000-8000-000000000001', 'e1680300-0000-4000-8000-000000000001', 'board-unknown-key-0007',
  repeat('0', 64));
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('patient', 'e1680400-0000-4000-8000-000000000007');
-- Registered at A's desk without a NIN (0130), which created the record: p2, p5, p9, p11-p25.
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, idempotency_key, request_sha256,
  resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id,
  review_reason, created_at, updated_at)
select ('e1680500-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'e1680000-0000-4000-8000-000000000002',
  'e1680100-0000-4000-8000-000000000001', 'e1680300-0000-4000-8000-000000000001', 'approved_new_identity',
  first, last, first || ' ' || last, date '1980-01-01' + n, 'none', 'no_nin', 'board-case-key-0000' || lpad(n::text, 2, '0'),
  repeat('0', 64), ('e1680400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  'board-review-key-000' || lpad(n::text, 2, '0'), repeat('0', 64), 'e1680100-0000-4000-8000-000000000001',
  'e1680300-0000-4000-8000-000000000001', 'Checked at the desk', clock_timestamp() - interval '30 days',
  clock_timestamp() - interval '30 days'
from b_patients where source = 'hid-desk-registration';
-- Break-glass grants: doctor 3 for p3 (active), doctor 7 for p4 (active, another member's), doctor 3 for p4
-- (expired).
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass, created_at) values
  ('e1680700-0000-4000-8000-000000000001', null, 'e1680400-0000-4000-8000-000000000003',
   'e1680200-0000-4000-8000-000000000003', 'e1680100-0000-4000-8000-000000000003',
   'e1680300-0000-4000-8000-000000000003', 'e1680000-0000-4000-8000-000000000002', 'break_glass', 'emergency',
   'active', null, 'Unconscious on arrival, no relatives', clock_timestamp() - interval '5 minutes',
   clock_timestamp() + interval '55 minutes', true, clock_timestamp() - interval '5 minutes'),
  ('e1680700-0000-4000-8000-000000000002', null, 'e1680400-0000-4000-8000-000000000004',
   'e1680200-0000-4000-8000-000000000007', 'e1680100-0000-4000-8000-000000000007',
   'e1680300-0000-4000-8000-000000000007', 'e1680000-0000-4000-8000-000000000002', 'break_glass', 'emergency',
   'active', null, 'Unconscious on arrival, no relatives', clock_timestamp() - interval '5 minutes',
   clock_timestamp() + interval '55 minutes', true, clock_timestamp() - interval '5 minutes'),
  ('e1680700-0000-4000-8000-000000000003', null, 'e1680400-0000-4000-8000-000000000004',
   'e1680200-0000-4000-8000-000000000003', 'e1680100-0000-4000-8000-000000000003',
   'e1680300-0000-4000-8000-000000000003', 'e1680000-0000-4000-8000-000000000002', 'break_glass', 'emergency',
   'expired', null, 'Unconscious on arrival, no relatives', clock_timestamp() - interval '3 hours',
   clock_timestamp() - interval '2 hours', true, clock_timestamp() - interval '3 hours');
-- Visits: p1 at A now (e1), p1 at A two hours ago and completed (e2, too early), p1 at A cancelled (e3), p2 at A
-- (e4, another patient's), p1 at B (e5, another facility's), p14 at A now (e6), p17 at A still open from earlier
-- today (e7: an outpatient visit before the move to the board; at most 3 hours ago, never before Lagos midnight),
-- p17 at A still open from yesterday (e8).
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, chief_complaint, created_at) values
  ('e1680800-0000-4000-8000-000000000001', 'e1680400-0000-4000-8000-000000000001', 'e1680000-0000-4000-8000-000000000002',
   'e1680100-0000-4000-8000-000000000003', 'e1680300-0000-4000-8000-000000000003', 'emergency', 'in_progress',
   clock_timestamp(), 'Fixture emergency visit', clock_timestamp()),
  ('e1680800-0000-4000-8000-000000000002', 'e1680400-0000-4000-8000-000000000001', 'e1680000-0000-4000-8000-000000000002',
   'e1680100-0000-4000-8000-000000000003', 'e1680300-0000-4000-8000-000000000003', 'ambulatory', 'in_progress',
   clock_timestamp() - interval '2 hours', 'Fixture early visit', clock_timestamp() - interval '2 hours'),
  ('e1680800-0000-4000-8000-000000000003', 'e1680400-0000-4000-8000-000000000001', 'e1680000-0000-4000-8000-000000000002',
   'e1680100-0000-4000-8000-000000000003', 'e1680300-0000-4000-8000-000000000003', 'emergency', 'cancelled',
   clock_timestamp(), 'Fixture cancelled visit', clock_timestamp()),
  ('e1680800-0000-4000-8000-000000000004', 'e1680400-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000002',
   'e1680100-0000-4000-8000-000000000003', 'e1680300-0000-4000-8000-000000000003', 'emergency', 'in_progress',
   clock_timestamp(), 'Fixture other patient visit', clock_timestamp()),
  ('e1680800-0000-4000-8000-000000000005', 'e1680400-0000-4000-8000-000000000001', 'e1680000-0000-4000-8000-000000000012',
   'e1680100-0000-4000-8000-000000000008', 'e1680300-0000-4000-8000-000000000008', 'emergency', 'in_progress',
   clock_timestamp(), 'Fixture other facility visit', clock_timestamp()),
  ('e1680800-0000-4000-8000-000000000006', 'e1680400-0000-4000-8000-000000000014', 'e1680000-0000-4000-8000-000000000002',
   'e1680100-0000-4000-8000-000000000003', 'e1680300-0000-4000-8000-000000000003', 'emergency', 'in_progress',
   clock_timestamp(), 'Fixture emergency visit', clock_timestamp()),
  ('e1680800-0000-4000-8000-000000000007', 'e1680400-0000-4000-8000-000000000017', 'e1680000-0000-4000-8000-000000000002',
   'e1680100-0000-4000-8000-000000000003', 'e1680300-0000-4000-8000-000000000003', 'ambulatory', 'in_progress',
   greatest(clock_timestamp() - interval '3 hours',
            (((clock_timestamp() at time zone 'Africa/Lagos')::date)::timestamp at time zone 'Africa/Lagos')),
   'Fixture outpatient visit', clock_timestamp() - interval '3 hours'),
  ('e1680800-0000-4000-8000-000000000008', 'e1680400-0000-4000-8000-000000000017', 'e1680000-0000-4000-8000-000000000002',
   'e1680100-0000-4000-8000-000000000003', 'e1680300-0000-4000-8000-000000000003', 'ambulatory', 'in_progress',
   clock_timestamp() - interval '1 day', 'Fixture yesterday visit', clock_timestamp() - interval '1 day');
update ehr.encounters set status = 'completed', ended_at = clock_timestamp() - interval '1 hour'
 where id = 'e1680800-0000-4000-8000-000000000002';
-- A's profile departments (0114 codes): no dental here.
insert into identity.facility_profiles (facility_id, trading_name, ownership, care_level, address_line, city, state_code,
  lga, gps_latitude, gps_longitude, phone_e164, email, bed_count, operating_hours, emergency_24h, departments,
  services_offered, smoh_licence_number, has_registry_id, has_nhia_accreditation, medical_director_name,
  medical_director_mdcn, expected_staff, migrating_records, needs_interoperability, source)
values ('e1680000-0000-4000-8000-000000000002', 'Board Clinic A', 'private', 'secondary', '1 Synthetic Road', 'Ikeja',
  'LA', 'Ikeja', 6.6, 3.35, '+2348000000001', 'board-a@example.invalid', 20, '24 hours', true,
  array['general_outpatient', 'emergency', 'inpatient', 'maternity'], 'Fictional services', 'SYN-LIC-1', false, false,
  'Synthetic Director', 'SYN-MDCN-1', 10, false, false, 'facility_administrator');
set local session_replication_role = origin;

create temporary table b_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
grant select, insert on pg_temp.b_outcomes to hid_ehr_api_runtime, hid_identity_api_runtime;
grant usage on sequence pg_temp.b_outcomes_seq_seq to hid_ehr_api_runtime, hid_identity_api_runtime;
grant select on pg_temp.b_members to hid_ehr_api_runtime, hid_identity_api_runtime;
create temporary table b_refs (name text primary key, ref text) on commit drop;
grant select, insert, update on pg_temp.b_refs to hid_ehr_api_runtime, hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.b_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.member(n integer) returns uuid language sql immutable as $f$
  select ('e1680300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.patient(n integer) returns uuid language sql immutable as $f$
  select ('e1680400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.visit(n integer) returns uuid language sql immutable as $f$
  select ('e1680800-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.as_member(n integer, purpose text default 'direct-care') returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:board-member-' || n, true),
    set_config('app.membership_id', pg_temp.member(n)::text, true),
    set_config('app.facility_id', (select facility::text from pg_temp.b_members where b_members.n = as_member.n), true),
    set_config('app.correlation_id', 'board-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;
create function pg_temp.key(label text) returns text language sql immutable as $f$
  select 'board-suite-key-' || label
$f$;
create function pg_temp.sha(label text) returns text language sql immutable as $f$
  select encode(sha256(convert_to(label, 'UTF8')), 'hex')
$f$;
-- A matchRef written as 0132 writes one: member n's, for a patient, with the purpose (standard or emergency).
create function pg_temp.make_ref(ref_name text, n integer, patient integer, purpose text) returns text
language plpgsql security definer as $f$
declare
  token text := 'psr_' || rpad(translate(encode(sha256(convert_to(ref_name, 'UTF8')), 'base64'), '+/=', '-_A'), 43, 'A');
begin
  token := substr(token, 1, 47);
  insert into identity.patient_search_refs (token_sha256, patient_id, account_id, membership_id, facility_id,
    purpose_of_use, search_mode, created_at, expires_at)
  values (encode(sha256(convert_to(token, 'UTF8')), 'hex'), pg_temp.patient(patient),
    ('e1680100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.member(n),
    (select facility from pg_temp.b_members where b_members.n = make_ref.n), purpose,
    case when purpose = 'emergency' then 'emergency' else 'standard' end, statement_timestamp(),
    statement_timestamp() + interval '10 minutes');
  insert into pg_temp.b_refs (name, ref) values (ref_name, token) on conflict (name) do update set ref = excluded.ref;
  return token;
end
$f$;
create function pg_temp.ref(ref_name text) returns text language sql as $f$
  select ref from pg_temp.b_refs where name = ref_name
$f$;
-- A standard search (first name, last name, date of birth) by member n, as identity-api.
create function pg_temp.search(n integer, first text, last text, dob date, ref_name text) returns text
language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from identity.staff_patient_search('standard', first, last, dob, null, null, null, null) limit 1;
  insert into pg_temp.b_refs (name, ref) values (ref_name, answer.match_ref)
    on conflict (name) do update set ref = excluded.ref;
  return answer.outcome;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- (The suite's own lookups read the tables as the suite's owner, not as a runtime.)
create function pg_temp.att(patient integer) returns uuid language sql security definer as $f$
  select id from ehr.ed_attendances where patient_id = pg_temp.patient(patient) order by arrived_at desc, id desc limit 1
$f$;
create function pg_temp.ver(patient integer) returns bigint language sql security definer as $f$
  select row_version from ehr.ed_attendances where id = pg_temp.att(patient)
$f$;
create function pg_temp.queue_of(patient integer) returns text language sql security definer as $f$
  select entry.stage || '/' || (entry.closed_at is not null)::text || '/' || coalesce(entry.triage_level::text, '-')
         || '/' || entry.check_in_basis
    from ehr.visit_queue entry where entry.patient_id = pg_temp.patient(patient)
   order by entry.checked_in_at desc, entry.id desc limit 1
$f$;
create function pg_temp.queue_assignee(patient integer) returns text language sql security definer as $f$
  select coalesce(right(entry.assigned_membership_id::text, 2), '-')
    from ehr.visit_queue entry where entry.patient_id = pg_temp.patient(patient)
   order by entry.checked_in_at desc, entry.id desc limit 1
$f$;
create function pg_temp.stage_time(patient integer) returns timestamptz language sql security definer as $f$
  select entry.stage_changed_at from ehr.visit_queue entry where entry.patient_id = pg_temp.patient(patient)
   order by entry.checked_in_at desc, entry.id desc limit 1
$f$;
create function pg_temp.events_of(patient integer) returns setof ehr.ed_attendance_events language sql security definer as $f$
  select * from ehr.ed_attendance_events where attendance_id = pg_temp.att(patient)
$f$;
create function pg_temp.queue_entry(patient integer) returns uuid language sql security definer as $f$
  select entry.id from ehr.visit_queue entry where entry.patient_id = pg_temp.patient(patient)
   order by entry.checked_in_at desc, entry.id desc limit 1
$f$;
create function pg_temp.queue_version(patient integer) returns bigint language sql security definer as $f$
  select entry.row_version from ehr.visit_queue entry where entry.id = pg_temp.queue_entry(patient)
$f$;
-- A card in one line: outcome/basis/column/stage/level/complaint (HIDDEN when hidden)/name/kind/label/status.
create function pg_temp.card_line(outcome text, card record) returns text language plpgsql as $f$
begin
  return format('%s/%s/%s/%s/%s/%s/%s/%s/%s/%s', outcome, card.arrival_basis, card.board_column, card.stage,
    coalesce(card.triage_level::text, '-'),
    case when card.complaint_hidden then 'HIDDEN' else coalesce(card.presenting_complaint, '-') end,
    card.full_name, card.record_kind, coalesce(card.unknown_label, '-'), card.status);
end
$f$;
create function pg_temp.arrive(n integer, match_ref text, patient integer, mode text, label text,
  level smallint default null, complaint text default null, purpose text default 'direct-care',
  arrived timestamptz default null, sha_label text default null) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n, purpose);
  select * into answer from ehr.ed_arrive(match_ref, case when patient is null then null else pg_temp.patient(patient) end,
    mode, arrived, level, complaint, pg_temp.key(label), pg_temp.sha(coalesce(sha_label, label)));
  if answer.attendance_id is null then
    return answer.outcome;
  end if;
  return case when answer.replayed then 'replayed:' else '' end || pg_temp.card_line(answer.outcome, answer);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.answer_line(answer record) returns text language plpgsql as $f$
begin
  return case when answer.attendance_id is null then answer.outcome
              else case when answer.replayed then 'replayed:' else '' end || pg_temp.card_line(answer.outcome, answer) end;
end
$f$;
create function pg_temp.triage(n integer, patient integer, label text, level smallint, complaint text default null,
  set_complaint boolean default false, version bigint default null) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.ed_triage(pg_temp.att(patient), coalesce(version, pg_temp.ver(patient)), level,
    complaint, set_complaint, pg_temp.key(label), pg_temp.sha(label));
  return pg_temp.answer_line(answer);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.move(n integer, patient integer, label text, stage text, assignee integer default null,
  clear_assignee boolean default false, version bigint default null) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.ed_move(pg_temp.att(patient), coalesce(version, pg_temp.ver(patient)), stage,
    case when assignee is null then null else pg_temp.member(assignee) end, clear_assignee, pg_temp.key(label),
    pg_temp.sha(label));
  if answer.attendance_id is null then
    return answer.outcome;
  end if;
  return pg_temp.answer_line(answer) || '/' || coalesce(right(answer.assigned_membership_id::text, 2), '-');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.link(n integer, patient integer, label text, visit integer) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.ed_link_visit(pg_temp.att(patient), pg_temp.ver(patient), pg_temp.visit(visit),
    pg_temp.key(label), pg_temp.sha(label));
  if answer.attendance_id is null then
    return answer.outcome;
  end if;
  return pg_temp.answer_line(answer) || '/' || coalesce(right(answer.encounter_id::text, 2), '-');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.dispose(n integer, patient integer, label text, outcome_value text, department text default null,
  admitting integer default null, referral text default null, reason text default null) returns text
language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.ed_record_disposition(pg_temp.att(patient), pg_temp.ver(patient), outcome_value,
    department, case when admitting is null then null else pg_temp.member(admitting) end, referral, reason,
    pg_temp.key(label), pg_temp.sha(label));
  if answer.attendance_id is null then
    return answer.outcome;
  end if;
  return pg_temp.answer_line(answer) || '/' || coalesce(answer.disposition_outcome, '-') || '/'
    || coalesce(answer.admit_to_department_code, '-') || '/' || coalesce(answer.referred_to_facility_name, '-');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.leave(n integer, patient integer, label text) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.ed_leave(pg_temp.att(patient), pg_temp.ver(patient), pg_temp.key(label),
    pg_temp.sha(label));
  return pg_temp.answer_line(answer);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.cancel(n integer, patient integer, label text, reason text) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.ed_cancel(pg_temp.att(patient), pg_temp.ver(patient), reason, pg_temp.key(label),
    pg_temp.sha(label));
  return pg_temp.answer_line(answer);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The board as member n: last names with their column and level (complaint shown as + when present, ? when
-- hidden), and has_more and the counts.
create function pg_temp.board(n integer, include_closed boolean default false, purpose text default 'direct-care')
returns text language plpgsql as $f$
declare
  answer text;
begin
  perform pg_temp.as_member(n, purpose);
  select coalesce(string_agg(split_part(listed.full_name, ' ', 2) || ':' || listed.board_column || ':'
           || coalesce(listed.triage_level::text, '-')
           || case when listed.complaint_hidden then '?' when listed.presenting_complaint is not null then '+' else '' end,
           ',' order by listed.ord), '(empty)')
         || '/' || coalesce(bool_or(listed.has_more), false)::text
         || '/' || coalesce(max(listed.waiting_count), 0) || '-' || coalesce(max(listed.being_seen_count), 0) || '-'
         || coalesce(max(listed.disposition_count), 0)
    into answer from ehr.ed_board(include_closed) listed;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.history(n integer, patient integer) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.ed_read(pg_temp.att(patient));
  if answer.outcome <> 'found' then
    return answer.outcome;
  end if;
  return (select string_agg(entry.value ->> 'kind', ',' order by entry.ordinality)
            from jsonb_array_elements(answer.history) with ordinality entry);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The history's reasons as member n reads them: one per entry, - when null.
create function pg_temp.history_reasons(n integer, patient integer) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.ed_read(pg_temp.att(patient));
  if answer.outcome <> 'found' then
    return answer.outcome;
  end if;
  return (select string_agg(coalesce(entry.value ->> 'reason', '-'), ',' order by entry.ordinality)
            from jsonb_array_elements(answer.history) with ordinality entry);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- 0135's waiting-list update as member n, on the patient's latest row: the outcome, or the refusal.
create function pg_temp.queue_update(n integer, patient integer, stage text, level smallint default null,
  clear_level boolean default null, assignee integer default null) returns text language plpgsql as $f$
begin
  perform pg_temp.as_member(n);
  return (select outcome from ehr.visit_queue_update(pg_temp.queue_entry(patient), pg_temp.queue_version(patient),
    stage, level, clear_level, case when assignee is null then null else pg_temp.member(assignee) end, null));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- 12: the waiting list's update while the board is off (ehr-api's call with the flag off).
create function pg_temp.board_off_update(n integer, patient integer, stage text, level smallint default null,
  version bigint default null) returns text language plpgsql as $f$
begin
  perform pg_temp.as_member(n);
  return (select outcome || '/' || coalesce(answer.stage, '-') || '/' || (answer.closed_at is not null)::text || '/'
                 || coalesce(answer.triage_level::text, '-')
            from ehr.visit_queue_ed_board_off_update(pg_temp.queue_entry(patient),
                   coalesce(version, pg_temp.queue_version(patient)), stage, level, null, null, null) answer);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.ed_state(patient integer) returns text language sql security definer as $f$
  select format('%s/%s/%s/%s', attendance.status, coalesce(attendance.closed_via, '-'),
           coalesce(attendance.disposition_outcome, '-'), (attendance.left_at is not null)::text)
    from ehr.ed_attendances attendance where attendance.id = pg_temp.att(patient)
$f$;
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'allowed';
exception when others then
  return sqlstate;
end
$f$;

-- 1. Arrival by each basis.
set local role hid_identity_api_runtime;
select pg_temp.check_case('1 the desk finds p1', 'found', pg_temp.search(1, 'Amaka', 'Edone', date '1980-01-02', 'p1'));
reset role;
select pg_temp.make_ref('p3-emergency', 3, 3, 'emergency') is not null as made \gset
select pg_temp.make_ref('p4-emergency', 3, 4, 'emergency') is not null as made \gset
select pg_temp.make_ref('p3-emergency-desk', 1, 3, 'emergency') is not null as made \gset
select pg_temp.make_ref('p3-standard-doctor', 3, 3, 'direct-care') is not null as made \gset
select pg_temp.make_ref('p1-nurse', 2, 1, 'direct-care') is not null as made \gset
select pg_temp.make_ref('p7-sealed', 1, 7, 'direct-care') is not null as made \gset
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 p1 by the desk''s matchRef (ambulance)',
  'arrived/search/waiting/waiting/-/HIDDEN/Amaka Edone/standard/-/open',
  pg_temp.arrive(1, pg_temp.ref('p1'), null, 'ambulance', 'arrive-p1'));
select pg_temp.check_case('1 the same key and body: the first answer, replayed',
  'replayed:arrived/search/waiting/waiting/-/HIDDEN/Amaka Edone/standard/-/open',
  pg_temp.arrive(1, pg_temp.ref('p1'), null, 'ambulance', 'arrive-p1'));
select pg_temp.check_case('1 the same key, another body', 'key_reused',
  pg_temp.arrive(1, pg_temp.ref('p1'), null, 'walk_in', 'arrive-p1', sha_label => 'arrive-p1-other'));
select pg_temp.check_case('1 p1 again: already on the board', 'already_on_board/search/waiting/waiting/-/HIDDEN/Amaka Edone/standard/-/open',
  pg_temp.arrive(1, pg_temp.ref('p1'), null, 'walk_in', 'arrive-p1-again'));
select pg_temp.check_case('1 p2 this facility''s own (nurse, level 2, complaint)',
  'arrived/own_facility/waiting/ready/2/Fall from motorcycle, left leg pain/Bayo Edtwo/standard/-/open',
  pg_temp.arrive(2, null, 2, 'walk_in', 'arrive-p2', 2::smallint, '  Fall from motorcycle, left leg pain  '));
select pg_temp.check_case('1 p3 by the doctor''s emergency search with the doctor''s break-glass grant',
  'arrived/emergency/waiting/ready/1/Unresponsive/Chika Edthree/standard/-/open',
  pg_temp.arrive(3, pg_temp.ref('p3-emergency'), null, 'brought_by_public', 'arrive-p3', 1::smallint, 'Unresponsive',
    'emergency'));
select pg_temp.check_case('1 p3''s waiting-list row has basis emergency, level 1, ready', 'ready/false/1/emergency',
  pg_temp.queue_of(3));
select pg_temp.check_case('1 an emergency matchRef with another member''s grant only', 'needs_search',
  pg_temp.arrive(3, pg_temp.ref('p4-emergency'), null, 'ambulance', 'arrive-p4', purpose => 'emergency'));
select pg_temp.check_case('1 an emergency matchRef sent for direct care', 'needs_search',
  pg_temp.arrive(3, pg_temp.ref('p4-emergency'), null, 'ambulance', 'arrive-p4-dc'));
select pg_temp.check_case('1 a direct-care matchRef sent for emergency', 'needs_search',
  pg_temp.arrive(3, pg_temp.ref('p3-standard-doctor'), null, 'ambulance', 'arrive-p3-std', purpose => 'emergency'));
select pg_temp.check_case('1 another member''s matchRef', 'needs_search',
  pg_temp.arrive(1, pg_temp.ref('p1-nurse'), null, 'ambulance', 'arrive-p1-nurse-ref'));
select pg_temp.check_case('1 the desk''s emergency matchRef (no grant)', 'needs_search',
  pg_temp.arrive(1, pg_temp.ref('p3-emergency-desk'), null, 'ambulance', 'arrive-p3-desk', purpose => 'emergency'));
select pg_temp.check_case('1 a patient id in an emergency session', '22023 ED_DIRECT_CARE_ONLY',
  pg_temp.arrive(3, null, 2, 'ambulance', 'arrive-p2-emergency', purpose => 'emergency'));
select pg_temp.check_case('1 a stranger by id', 'needs_search', pg_temp.arrive(1, null, 10, 'walk_in', 'arrive-p10'));
select pg_temp.check_case('1 a sealed demo patient by id', 'needs_search', pg_temp.arrive(1, null, 7, 'walk_in', 'arrive-p7'));
select pg_temp.check_case('1 a sealed demo patient by matchRef', 'needs_search',
  pg_temp.arrive(1, pg_temp.ref('p7-sealed'), null, 'walk_in', 'arrive-p7-ref'));
select pg_temp.check_case('1 an inactive patient by id', 'needs_search', pg_temp.arrive(1, null, 9, 'walk_in', 'arrive-p9'));
select pg_temp.check_case('1 both', '22023 ED_ARRIVAL_NEEDS_ONE_PATIENT',
  pg_temp.arrive(1, pg_temp.ref('p1'), 2, 'walk_in', 'arrive-both'));
select pg_temp.check_case('1 neither', '22023 ED_ARRIVAL_NEEDS_ONE_PATIENT', pg_temp.arrive(1, null, null, 'walk_in', 'arrive-neither'));
select pg_temp.check_case('1 an unknown arrival mode', '22023 ED_INVALID', pg_temp.arrive(1, null, 2, 'helicopter', 'arrive-mode'));
select pg_temp.check_case('1 a complaint of 121 characters', '22023 ED_INVALID',
  pg_temp.arrive(2, null, 12, 'walk_in', 'arrive-long', null, repeat('x', 121)));
select pg_temp.check_case('1 a blank complaint', '22023 ED_INVALID',
  pg_temp.arrive(2, null, 12, 'walk_in', 'arrive-blank', null, '   '));
select pg_temp.check_case('1 level 6', '22023 ED_TRIAGE_INVALID',
  pg_temp.arrive(2, null, 12, 'walk_in', 'arrive-level6', 6::smallint));
select pg_temp.check_case('1 an arrival 7 hours ago', 'time_invalid',
  pg_temp.arrive(1, null, 12, 'walk_in', 'arrive-old', arrived => clock_timestamp() - interval '7 hours'));
select pg_temp.check_case('1 an arrival 10 minutes ahead', 'time_invalid',
  pg_temp.arrive(1, null, 12, 'walk_in', 'arrive-future', arrived => clock_timestamp() + interval '10 minutes'));
select pg_temp.check_case('1 a short key', '22023 ED_IDEMPOTENCY_KEY_INVALID',
  (select pg_temp.try($s$select pg_temp.as_member(1); select * from ehr.ed_arrive(null,
     'e1680400-0000-4000-8000-000000000012', 'walk_in', null, null, null, 'short', repeat('a', 64))$s$)) || ' ED_IDEMPOTENCY_KEY_INVALID');
-- p5: already on the outpatient waiting list (0135's check-in by the desk), then moved to the board with a level.
select pg_temp.as_member(1);
select pg_temp.check_case('1 p5 checked in on the waiting list', 'checked_in',
  (select outcome from ehr.visit_queue_check_in(null, pg_temp.patient(5))));
select pg_temp.check_case('1 p5 moved from the waiting list (nurse, level 3)',
  'moved_from_waiting_list/own_facility/waiting/ready/3/-/Ebere Edfive/standard/-/open',
  pg_temp.arrive(2, null, 5, 'walk_in', 'arrive-p5', 3::smallint));
select pg_temp.check_case('1 p5 keeps its one waiting-list row (own_facility basis kept)', 'ready/false/3/own_facility',
  pg_temp.queue_of(5));
select pg_temp.as_member(1);
select pg_temp.check_case('1 0135''s check-in after the arrival: the same open row', 'already_open/true',
  (select outcome || '/' || (entry_id = pg_temp.queue_entry(2))::text
     from ehr.visit_queue_check_in(null, pg_temp.patient(2))));
select pg_temp.check_case('1 already on the board: triage fields not applied', 'already_on_board/own_facility/waiting/ready/2/Fall from motorcycle, left leg pain/Bayo Edtwo/standard/-/open',
  pg_temp.arrive(3, null, 2, 'walk_in', 'arrive-p2-again', 5::smallint, 'Something else'));
-- An arrival up to 6 hours ago, and one up to 2 minutes ahead (taken as now).
select pg_temp.check_case('1 p11 arrived 5 hours ago', 'arrived/own_facility/waiting/waiting/-/HIDDEN/Ola Edperson11/standard/-/open',
  pg_temp.arrive(1, null, 11, 'police', 'arrive-p11', arrived => clock_timestamp() - interval '5 hours'));
reset role;
select pg_temp.check_case('1 p11''s arrival day and minutes in the department', 't/t',
  (select format('%s/%s', arrival_day = ((clock_timestamp() - interval '5 hours') at time zone 'Africa/Lagos')::date,
     arrived_at < clock_timestamp() - interval '299 minutes') from ehr.ed_attendances where id = pg_temp.att(11)));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 p12 arrived a minute ahead: taken as now', 'arrived/own_facility/waiting/waiting/-/HIDDEN/Ola Edperson12/standard/-/open',
  pg_temp.arrive(1, null, 12, 'referred', 'arrive-p12', arrived => clock_timestamp() + interval '1 minute'));

-- 2. Who may.
select pg_temp.check_case('2 the desk cannot triage on arrival', '42501 ED_TRIAGE_NOT_ALLOWED',
  pg_temp.arrive(1, null, 13, 'walk_in', 'arrive-p13-desk', 3::smallint));
select pg_temp.check_case('2 the desk cannot record a complaint on arrival', '42501 ED_TRIAGE_NOT_ALLOWED',
  pg_temp.arrive(1, null, 13, 'walk_in', 'arrive-p13-desk-c', null, 'Chest pain'));
select pg_temp.check_case('2 the desk cannot triage', '42501 ED_TRIAGE_NOT_ALLOWED',
  pg_temp.triage(1, 1, 'triage-desk', 2::smallint));
select pg_temp.check_case('2 the desk cannot move', '42501 ED_TRIAGE_NOT_ALLOWED',
  pg_temp.move(1, 1, 'move-desk', 'triage'));
select pg_temp.check_case('2 the nurse cannot record a disposition', '42501 ED_DISPOSITION_NOT_ALLOWED',
  pg_temp.dispose(2, 1, 'dispose-nurse', 'discharged'));
select pg_temp.check_case('2 lab has no board', '42501 ED_BOARD_NOT_ALLOWED', pg_temp.board(5));
select pg_temp.check_case('2 an administrator has no board', '42501 ED_BOARD_NOT_ALLOWED', pg_temp.board(6));
select pg_temp.check_case('2 a pharmacist has no board', '42501 ED_BOARD_NOT_ALLOWED', pg_temp.board(9));
select pg_temp.check_case('2 an administrator cannot put a patient on it', '42501 ED_BOARD_NOT_ALLOWED',
  pg_temp.arrive(6, null, 13, 'walk_in', 'arrive-p13-admin'));
select pg_temp.check_case('2 the board in an emergency session', '22023 ED_DIRECT_CARE_ONLY', pg_temp.board(3, false, 'emergency'));
select pg_temp.check_case('2 triage in an emergency session', '22023 ED_DIRECT_CARE_ONLY',
  (select pg_temp.try($s$select pg_temp.as_member(2, 'emergency'); select * from ehr.ed_triage(pg_temp.att(1), 1, 2::smallint,
     null, false, pg_temp.key('triage-emergency'), pg_temp.sha('triage-emergency'))$s$)) || ' ED_DIRECT_CARE_ONLY');

-- 3. The unknown patient (0145).
select pg_temp.check_case('3 the unknown record arrives by id (created here)',
  'arrived/own_facility/waiting/waiting/-/HIDDEN/Unknown patient U-0007/unknown/U-0007/open',
  pg_temp.arrive(1, null, 6, 'ambulance', 'arrive-p6'));
select pg_temp.as_member(2);
select pg_temp.check_case('3 the card: estimated age, no real name', 'unknown/U-0007/t/1986-01-01',
  (select format('%s/%s/%s/%s', record_kind, unknown_label, dob_estimated, date_of_birth) from ehr.ed_board(false)
    where patient_id = pg_temp.patient(6)));
reset role;
update identity.unknown_patients set status = 'identified', identified_at = clock_timestamp(),
  identified_by_account_id = 'e1680100-0000-4000-8000-000000000001',
  identified_by_membership_id = 'e1680300-0000-4000-8000-000000000001'
 where patient_id = 'e1680400-0000-4000-8000-000000000006';
update identity.patients set first_name = 'Tunde', last_name = 'Edsix', full_name = 'Tunde Edsix'
 where id = 'e1680400-0000-4000-8000-000000000006';
set local role hid_ehr_api_runtime;
select pg_temp.as_member(2);
select pg_temp.check_case('3 once identified, the real name shows by itself', 'Tunde Edsix/standard/-/f',
  (select format('%s/%s/%s/%s', full_name, record_kind, coalesce(unknown_label, '-'), dob_estimated)
     from ehr.ed_board(false) where patient_id = pg_temp.patient(6)));

-- 4. The board.
select pg_temp.check_case('4 the nurse''s board: waiting, most urgent first, complaints shown',
  'Edthree:waiting:1+,Edtwo:waiting:2+,Edfive:waiting:3,Edperson11:waiting:-,Edone:waiting:-,Edperson12:waiting:-,Edsix:waiting:-/false/7-0-0',
  pg_temp.board(2));
select pg_temp.check_case('4 the desk''s board: the complaint hidden on every card',
  'Edthree:waiting:1?,Edtwo:waiting:2?,Edfive:waiting:3?,Edperson11:waiting:-?,Edone:waiting:-?,Edperson12:waiting:-?,Edsix:waiting:-?/false/7-0-0',
  pg_temp.board(1));
select pg_temp.check_case('4 another facility''s board', '(empty)/false/0-0-0', pg_temp.board(8));
select pg_temp.check_case('4 another facility''s member cannot read a record', 'not_found', pg_temp.history(8, 1));
select pg_temp.as_member(1);
select pg_temp.check_case('4 the desk''s record read: complaint hidden', 't/-',
  (select format('%s/%s', complaint_hidden, coalesce(presenting_complaint, '-')) from ehr.ed_read(pg_temp.att(2))));
select pg_temp.check_case('4 the desk''s arrival answer of a triaged patient: complaint hidden', 'already_on_board/HIDDEN',
  (select split_part(pg_temp.arrive(1, null, 2, 'walk_in', 'arrive-p2-desk'), '/', 1) || '/'
     || split_part(pg_temp.arrive(1, null, 2, 'walk_in', 'arrive-p2-desk'), '/', 6)));

-- 5. Triage, move, start care, the visit link.
select pg_temp.check_case('5 the nurse triages p1 (level 2, complaint)',
  'updated/search/waiting/ready/2/Chest pain since morning/Amaka Edone/standard/-/open',
  pg_temp.triage(2, 1, 'triage-p1', 2::smallint, 'Chest pain since morning', true));
select pg_temp.check_case('5 an old row version', 'changed',
  pg_temp.triage(2, 1, 'triage-p1-stale', 3::smallint, null, false, 1));
select pg_temp.check_case('5 triage again: level 1, the complaint cleared',
  'updated/search/waiting/ready/1/-/Amaka Edone/standard/-/open',
  pg_temp.triage(2, 1, 'triage-p1-again', 1::smallint, null, true));
select pg_temp.check_case('5 triage level 0', '22023 ED_TRIAGE_INVALID', pg_temp.triage(2, 1, 'triage-p1-0', 0::smallint));
select pg_temp.check_case('5 nothing to change', '22023 ED_NOTHING_TO_CHANGE', pg_temp.move(2, 1, 'move-nothing', null));
select pg_temp.check_case('5 an unknown stage', '22023 ED_INVALID', pg_temp.move(2, 1, 'move-unknown', 'finished'));
select pg_temp.check_case('5 assigned to the desk', 'assignee_invalid', pg_temp.move(2, 1, 'move-desk-assignee', null, 1));
select pg_temp.check_case('5 assigned to another facility''s doctor', 'assignee_invalid',
  pg_temp.move(2, 1, 'move-b-assignee', null, 8));
select pg_temp.check_case('5 the doctor starts care', 'updated/search/being_seen/with_clinician/1/-/Amaka Edone/standard/-/open/03',
  pg_temp.move(3, 1, 'move-start-care', 'with_clinician', 3));
select pg_temp.check_case('5 the waiting-list row moved with it', 'with_clinician/false/1/search', pg_temp.queue_of(1));
select pg_temp.check_case('5 another patient''s visit', 'visit_invalid', pg_temp.link(3, 1, 'link-other-patient', 4));
select pg_temp.check_case('5 another facility''s visit', 'visit_invalid', pg_temp.link(3, 1, 'link-other-facility', 5));
select pg_temp.check_case('5 a cancelled visit', 'visit_invalid', pg_temp.link(3, 1, 'link-cancelled', 3));
select pg_temp.check_case('5 a finished visit started two hours before the arrival', 'visit_invalid', pg_temp.link(3, 1, 'link-early', 2));
select pg_temp.check_case('5 the nurse links p1''s emergency visit', 'updated/search/being_seen/with_clinician/1/-/Amaka Edone/standard/-/open/01',
  pg_temp.link(2, 1, 'link-p1', 1));
select pg_temp.check_case('5 the board''s columns and counts',
  'Edthree:waiting:1+,Edtwo:waiting:2+,Edfive:waiting:3,Edperson11:waiting:-,Edperson12:waiting:-,Edsix:waiting:-,Edone:being_seen:1/false/6-1-0',
  pg_temp.board(4));

-- 6. Dispositions.
select pg_temp.check_case('6 admission to emergency itself', 'admit_department_invalid',
  pg_temp.dispose(3, 1, 'dispose-p1-emergency', 'admit_requested', 'emergency'));
select pg_temp.check_case('6 admission to a department this facility does not have', 'admit_department_invalid',
  pg_temp.dispose(3, 1, 'dispose-p1-dental', 'admit_requested', 'dental'));
select pg_temp.check_case('6 admission without a department', 'admit_department_invalid',
  pg_temp.dispose(3, 1, 'dispose-p1-nodept', 'admit_requested'));
select pg_temp.check_case('6 a department with another outcome', '22023 ED_INVALID',
  pg_temp.dispose(3, 1, 'dispose-p1-dept-home', 'discharged', 'inpatient'));
select pg_temp.check_case('6 the admitting member is the nurse', 'admitting_invalid',
  pg_temp.dispose(3, 1, 'dispose-p1-nurse-admits', 'admit_requested', 'inpatient', 2));
select pg_temp.check_case('6 p1 admission requested to inpatient, doctor 7 admitting',
  'updated/search/disposition/with_clinician/1/-/Amaka Edone/standard/-/decided/admit_requested/inpatient/-',
  pg_temp.dispose(3, 1, 'dispose-p1', 'admit_requested', 'inpatient', 7));
select pg_temp.check_case('6 the waiting-list row stays open', 'with_clinician/false/1/search', pg_temp.queue_of(1));
select pg_temp.check_case('6 triage after the decision', 'decided', pg_temp.triage(2, 1, 'triage-p1-decided', 2::smallint));
select pg_temp.check_case('6 move after the decision', 'decided', pg_temp.move(2, 1, 'move-p1-decided', 'ready'));
select pg_temp.check_case('6 changing the decision needs a reason', 'reason_required',
  pg_temp.dispose(4, 1, 'dispose-p1-change-noreason', 'referred_out'));
select pg_temp.check_case('6 a reason of 5 characters', '22023 ED_REASON_REQUIRED',
  pg_temp.dispose(4, 1, 'dispose-p1-change-short', 'referred_out', reason => 'Short'));
select pg_temp.check_case('6 changed to referred out, with the facility''s name',
  'updated/search/disposition/with_clinician/1/-/Amaka Edone/standard/-/decided/referred_out/-/Lagos Teaching Hospital',
  pg_temp.dispose(4, 1, 'dispose-p1-change', 'referred_out', referral => 'Lagos Teaching Hospital',
    reason => 'No inpatient bed tonight; transferred'));
reset role;
select pg_temp.check_case('6 a linked visit stays when the decision changes', 'true',
  (select (encounter_id = pg_temp.visit(1))::text from ehr.ed_attendances where id = pg_temp.att(1)));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('6 the cancel of a decided record', 'cancel_not_allowed',
  pg_temp.cancel(1, 1, 'cancel-p1', 'Added by mistake'));
select pg_temp.check_case('6 left the department', 'updated/search/closed/finished/1/-/Amaka Edone/standard/-/closed',
  pg_temp.leave(2, 1, 'leave-p1'));
select pg_temp.check_case('6 its waiting-list row is finished', 'finished/true/1/search', pg_temp.queue_of(1));
select pg_temp.check_case('6 left again', 'closed', pg_temp.leave(2, 1, 'leave-p1-again'));
select pg_temp.check_case('6 leave before a decision', 'not_decided', pg_temp.leave(2, 2, 'leave-p2-open'));
select pg_temp.check_case('6 p2 discharged', 'updated/own_facility/disposition/ready/2/Fall from motorcycle, left leg pain/Bayo Edtwo/standard/-/decided/discharged/-/-',
  pg_temp.dispose(3, 2, 'dispose-p2', 'discharged'));
select pg_temp.check_case('6 p3 left before being seen: closed, row left', 'updated/emergency/closed/left/1/Unresponsive/Chika Edthree/standard/-/closed/left_before_seen/-/-',
  pg_temp.dispose(3, 3, 'dispose-p3', 'left_before_seen'));
select pg_temp.check_case('6 p3''s row', 'left/true/1/emergency', pg_temp.queue_of(3));
select pg_temp.check_case('6 p11 left against advice', 'updated/own_facility/closed/left/-/-/Ola Edperson11/standard/-/closed/left_against_advice/-/-',
  pg_temp.dispose(4, 11, 'dispose-p11', 'left_against_advice'));
select pg_temp.check_case('6 p12 died: closed, row finished', 'updated/own_facility/closed/finished/-/-/Ola Edperson12/standard/-/closed/died/-/-',
  pg_temp.dispose(3, 12, 'dispose-p12', 'died'));
select pg_temp.check_case('6 p12''s row', 'finished/true/-/own_facility', pg_temp.queue_of(12));
select pg_temp.check_case('6 p5 sent to outpatients: the ED record closes', 'updated/own_facility/closed/waiting/3/-/Ebere Edfive/standard/-/closed/sent_to_outpatients/-/-',
  pg_temp.dispose(3, 5, 'dispose-p5', 'sent_to_outpatients'));
select pg_temp.check_case('6 p5''s row is back on the waiting list, with its level', 'waiting/false/3/own_facility',
  pg_temp.queue_of(5));
select pg_temp.check_case('6 p19 arrives (nurse, level 2) and the doctor starts care', 'arrived|updated/03',
  (select split_part(pg_temp.arrive(2, null, 19, 'walk_in', 'arrive-p19', 2::smallint), '/', 1) || '|'
     || split_part(pg_temp.move(3, 19, 'move-p19', 'with_clinician', 3), '/', 1) || '/'
     || pg_temp.queue_assignee(19)));
select pg_temp.check_case('6 p19 sent to outpatients', 'updated/own_facility/closed/waiting/2/-/Ola Edperson19/standard/-/closed/sent_to_outpatients/-/-',
  pg_temp.dispose(3, 19, 'dispose-p19', 'sent_to_outpatients'));
select pg_temp.check_case('6 p19''s row is back to waiting with nobody down to see them (the ED doctor handed over)',
  'waiting/false/2/own_facility/-', pg_temp.queue_of(19) || '/' || pg_temp.queue_assignee(19));
select pg_temp.as_member(1);
select pg_temp.check_case('6 p5 on the outpatient waiting list again', 'true',
  (select bool_or(patient_id = pg_temp.patient(5))::text from ehr.visit_queue_list(false)));
select pg_temp.check_case('6 p5 back on the board: the same row', 'moved_from_waiting_list/own_facility/waiting/waiting/3/HIDDEN/Ebere Edfive/standard/-/open',
  pg_temp.arrive(1, null, 5, 'walk_in', 'arrive-p5-again'));
select pg_temp.check_case('6 p2 admission changed to died (reason)', 'updated/own_facility/closed/finished/2/Fall from motorcycle, left leg pain/Bayo Edtwo/standard/-/closed/died/-/-',
  pg_temp.dispose(3, 2, 'dispose-p2-died', 'died', reason => 'Arrested in the department'));

-- 7. Cancel.
select pg_temp.check_case('7 p13 arrives', 'arrived/own_facility/waiting/waiting/-/HIDDEN/Ola Edperson13/standard/-/open',
  pg_temp.arrive(1, null, 13, 'walk_in', 'arrive-p13'));
select pg_temp.check_case('7 cancel without a reason', '22023 ED_REASON_REQUIRED', pg_temp.cancel(1, 13, 'cancel-p13-none', null));
select pg_temp.check_case('7 the nurse cancels the arrival (she holds ehr.ed.arrive), with a reason', 'updated/own_facility/closed/waiting/-/-/Ola Edperson13/standard/-/closed',
  pg_temp.cancel(2, 13, 'cancel-p13', 'Added to the board by mistake'));
select pg_temp.check_case('7 the row the arrival made stays open, back to waiting, no level, nobody down', 'waiting/false/-/own_facility/-',
  pg_temp.queue_of(13) || '/' || pg_temp.queue_assignee(13));
select pg_temp.check_case('7 p5 (moved from the waiting list) cancelled', 'updated/own_facility/closed/waiting/3/HIDDEN/Ebere Edfive/standard/-/closed',
  pg_temp.cancel(1, 5, 'cancel-p5', 'Sent to the board by mistake'));
select pg_temp.check_case('7 its row stays open as it was', 'waiting/false/3/own_facility', pg_temp.queue_of(5));
-- p18: on the outpatient waiting list (waiting, no level, doctor 7 down to see them), picked in New arrival by
-- mistake with level 1 and a complaint, then cancelled: the outpatient row goes back exactly as it was.
select pg_temp.as_member(1);
select pg_temp.check_case('7 p18 checked in on the waiting list', 'checked_in',
  (select outcome from ehr.visit_queue_check_in(null, pg_temp.patient(18))));
select pg_temp.check_case('7 p18 down to see doctor 7 on the waiting list', 'updated',
  pg_temp.queue_update(1, 18, null, assignee => 7));
reset role;
select pg_temp.stage_time(18) as p18_stage_time \gset
set local role hid_ehr_api_runtime;
select pg_temp.check_case('7 p18 moved to the board by mistake (nurse, level 1, complaint)',
  'moved_from_waiting_list/own_facility/waiting/ready/1/Chest pain/Ola Edperson18/standard/-/open',
  pg_temp.arrive(2, null, 18, 'walk_in', 'arrive-p18', 1::smallint, 'Chest pain'));
select pg_temp.check_case('7 p18''s outpatient row now ready at level 1', 'ready/false/1/own_facility/07',
  pg_temp.queue_of(18) || '/' || pg_temp.queue_assignee(18));
select pg_temp.check_case('7 the doctor starts care on p18 (the assignee changes on the board)', 'updated/03',
  split_part(pg_temp.move(3, 18, 'move-p18', 'with_clinician', 3), '/', 1) || '/' || pg_temp.queue_assignee(18));
select pg_temp.check_case('7 p18''s arrival cancelled, with a reason', 'updated/own_facility/closed/waiting/-/Chest pain/Ola Edperson18/standard/-/closed',
  pg_temp.cancel(2, 18, 'cancel-p18', 'Added to the wrong board in error'));
select pg_temp.check_case('7 p18''s outpatient row is back as it was: waiting, no level, doctor 7, the same stage time',
  'waiting/false/-/own_facility/07/t', pg_temp.queue_of(18) || '/' || pg_temp.queue_assignee(18) || '/'
    || (pg_temp.stage_time(18) = :'p18_stage_time'::timestamptz)::text::char(1));
select pg_temp.check_case('7 p18''s cancel event goes back to the stage before the move', 'with_clinician/waiting',
  (select from_stage || '/' || to_stage from pg_temp.events_of(18) where kind = 'cancelled'));
select pg_temp.check_case('7 p14 arrives, the visit is linked, cancel refused', 'arrived|updated|cancel_not_allowed',
  (select split_part(pg_temp.arrive(2, null, 14, 'walk_in', 'arrive-p14'), '/', 1) || '|'
     || split_part(pg_temp.link(2, 14, 'link-p14', 6), '/', 1) || '|'
     || pg_temp.cancel(1, 14, 'cancel-p14', 'Added by mistake')));
-- p24, the other order (Rahman, #337 7175564791, should-fix 1): put on the board by mistake (a new waiting-list row,
-- level 2), then checked in at the outpatient desk, where 0135's check-in answers already_open with that same row.
-- The arrival's cancel must not take the patient off the outpatient waiting list.
select pg_temp.check_case('7 p24 put on the board by mistake (nurse, level 2): a new waiting-list row',
  'arrived/own_facility/waiting/ready/2/-/Ola Edperson24/standard/-/open',
  pg_temp.arrive(2, null, 24, 'walk_in', 'arrive-p24', 2::smallint));
select pg_temp.as_member(1);
select pg_temp.check_case('7 the desk then checks p24 in for outpatients: already_open, the same row', 'already_open/true',
  (select outcome || '/' || (entry_id = pg_temp.queue_entry(24))::text
     from ehr.visit_queue_check_in(null, pg_temp.patient(24))));
select pg_temp.check_case('7 p24''s arrival cancelled: only the ED record closes',
  'updated/own_facility/closed/waiting/-/-/Ola Edperson24/standard/-/closed',
  pg_temp.cancel(2, 24, 'cancel-p24', 'Put on the emergency board by mistake'));
select pg_temp.check_case('7 p24 is still on the outpatient waiting list: open, waiting, no level, nobody down',
  'waiting/false/-/own_facility/-', pg_temp.queue_of(24) || '/' || pg_temp.queue_assignee(24));
select pg_temp.check_case('7 p24''s cancel event: from ready back to waiting', 'ready/waiting',
  (select from_stage || '/' || to_stage from pg_temp.events_of(24) where kind = 'cancelled'));
select pg_temp.check_case('7 the row is the waiting list''s again (0135''s update)', 'updated',
  pg_temp.queue_update(1, 24, 'triage'));

-- 8. The guard and the mirror.
select pg_temp.check_case('8 p15 arrives', 'arrived', split_part(pg_temp.arrive(1, null, 15, 'walk_in', 'arrive-p15'), '/', 1));
select pg_temp.check_case('8 p16 arrives and is discharged', 'arrived|updated',
  (select split_part(pg_temp.arrive(2, null, 16, 'walk_in', 'arrive-p16'), '/', 1) || '|'
     || split_part(pg_temp.dispose(3, 16, 'dispose-p16', 'discharged'), '/', 1)));
select pg_temp.check_case('8 the nurse triages p15 on the board (level 4)', 'updated/4',
  (select split_part(answer, '/', 1) || '/' || split_part(answer, '/', 5)
     from pg_temp.triage(2, 15, 'triage-p15', 4::smallint) answer));
select pg_temp.ver(15) as p15_version \gset
select pg_temp.check_case('8 the desk closes p15''s row on the waiting list (left): refused', '55000 VISIT_QUEUE_ON_ED_BOARD',
  pg_temp.queue_update(1, 15, 'left'));
select pg_temp.check_case('8 the desk finishes p16 (decided) on the waiting list: refused', '55000 VISIT_QUEUE_ON_ED_BOARD',
  pg_temp.queue_update(1, 16, 'finished'));
select pg_temp.check_case('8 the desk cancels p15 on the waiting list: refused', '55000 VISIT_QUEUE_ON_ED_BOARD',
  pg_temp.queue_update(1, 15, 'cancelled'));
select pg_temp.check_case('8 the desk sets a level on the waiting list: refused', '55000 VISIT_QUEUE_ON_ED_BOARD',
  pg_temp.queue_update(1, 15, null, 5::smallint));
select pg_temp.check_case('8 the desk clears the level on the waiting list: refused', '55000 VISIT_QUEUE_ON_ED_BOARD',
  pg_temp.queue_update(1, 15, null, null, true));
select pg_temp.check_case('8 a nurse re-triages on the waiting list (level 1): refused', '55000 VISIT_QUEUE_ON_ED_BOARD',
  pg_temp.queue_update(2, 15, null, 1::smallint));
select pg_temp.check_case('8 a doctor moves the stage on the waiting list: refused', '55000 VISIT_QUEUE_ON_ED_BOARD',
  pg_temp.queue_update(3, 15, 'with_clinician'));
select pg_temp.check_case('8 a doctor takes the patient on the waiting list: refused', '55000 VISIT_QUEUE_ON_ED_BOARD',
  pg_temp.queue_update(3, 15, null, assignee => 3));
select pg_temp.check_case('8 another row''s marker does not open the guard', '55000 VISIT_QUEUE_ON_ED_BOARD',
  (select pg_temp.queue_update(2, 15, null, 1::smallint)
     from (select set_config('hid.ed_board_closing', pg_temp.queue_entry(16)::text, true)) marker));
select set_config('hid.ed_board_closing', '', true);
select pg_temp.check_case('8 p15''s row unchanged: still the board''s level, and the ED record''s version still current',
  'ready/false/4/own_facility/-/t', pg_temp.queue_of(15) || '/' || pg_temp.queue_assignee(15) || '/'
    || (pg_temp.ver(15) = :p15_version)::text::char(1));
select pg_temp.check_case('8 the board''s triage still shows who triaged on the board', 'updated/3/02',
  (select split_part(pg_temp.answer_line(answer), '/', 1) || '/' || answer.triage_level || '/'
          || right(answer.triaged_by_membership_id::text, 2)
     from (select pg_temp.as_member(2)) context,
          ehr.ed_triage(pg_temp.att(15), :p15_version, 3::smallint, null, false, pg_temp.key('triage-p15-again'),
            pg_temp.sha('triage-p15-again')) answer));
select pg_temp.check_case('8 an ED patient''s waiting-list row no longer on the board: the waiting list works again', 'updated',
  pg_temp.queue_update(1, 19, 'triage'));
-- 0145's cancel of an unknown record makes the patient inactive, then cancels the open row: the guard lets that
-- close through, and the mirror closes the ED record. (Here the two patients are made inactive directly.)
reset role;
update identity.patients set status = 'inactive'
 where id in ('e1680400-0000-4000-8000-000000000015', 'e1680400-0000-4000-8000-000000000016');
select pg_temp.check_case('8 an inactive patient''s board row: a change that does not close it is still refused', '55000',
  pg_temp.try($s$update ehr.visit_queue entry set triage_level = 2 where entry.id = pg_temp.queue_entry(15)$s$));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('8 p15''s row (patient no longer active) closed on the waiting list', 'updated',
  pg_temp.queue_update(1, 15, 'cancelled'));
select pg_temp.check_case('8 p16''s row (patient no longer active) closed on the waiting list', 'updated',
  pg_temp.queue_update(1, 16, 'cancelled'));
reset role;
select pg_temp.check_case('8 both ED records closed by the mirror, the disposition kept',
  'closed/waiting_list/-|closed/waiting_list/discharged',
  (select string_agg(format('%s/%s/%s', status, closed_via, coalesce(disposition_outcome, '-')), '|' order by patient_id)
     from ehr.ed_attendances where patient_id in (pg_temp.patient(15), pg_temp.patient(16))));
select pg_temp.check_case('8 one closed_on_waiting_list event each', '2',
  (select count(*)::text from ehr.ed_attendance_events where kind = 'closed_on_waiting_list'
    and patient_id in (pg_temp.patient(15), pg_temp.patient(16))));
select pg_temp.check_case('8 one mirror audit row each, as the waiting-list action''s actor', '2/staff/1',
  (select format('%s/%s/%s', count(*), min(actor_type), count(distinct actor_membership_id)) from audit.events
    where action = 'ehr.ed.closed-on-waiting-list' and facility_id = 'e1680000-0000-4000-8000-000000000002'));
select pg_temp.check_case('8 an ED close does not run the mirror', '0',
  (select count(*)::text from ehr.ed_attendance_events
    where kind = 'closed_on_waiting_list' and patient_id not in (pg_temp.patient(15), pg_temp.patient(16))));
select pg_temp.check_case('8 a closed record''s row closed again changes nothing', 'closed',
  (select status from ehr.ed_attendances where id = pg_temp.att(15)));
-- "Left the department today" is the Lagos day the record left. p13 (cancelled today) is moved to have arrived
-- yesterday; p3 (left before being seen) to have arrived and left yesterday.
update ehr.ed_attendances set arrived_at = arrived_at - interval '1 day',
       arrival_day = ((arrived_at - interval '1 day') at time zone 'Africa/Lagos')::date
 where id = pg_temp.att(13);
update ehr.ed_attendances set arrived_at = arrived_at - interval '1 day',
       arrival_day = ((arrived_at - interval '1 day') at time zone 'Africa/Lagos')::date,
       left_at = left_at - interval '1 day', decided_at = decided_at - interval '1 day'
 where id = pg_temp.att(3);
set local role hid_ehr_api_runtime;
select pg_temp.check_case('8 left today: p13 (arrived yesterday, left today) shown, p3 (left yesterday) not', 't/f',
  (select format('%s/%s', bool_or(listed.patient_id = pg_temp.patient(13)), bool_or(listed.patient_id = pg_temp.patient(3)))
     from (select pg_temp.as_member(2)) context, ehr.ed_board(true) listed where listed.board_column = 'closed'));
select pg_temp.check_case('8 without "left today" no closed record is shown', '0',
  (select count(*)::text from (select pg_temp.as_member(2)) context, ehr.ed_board(false) listed
    where listed.board_column = 'closed'));

-- 9. Replays and keys on the writes.
select pg_temp.check_case('9 p17 arrives', 'arrived', split_part(pg_temp.arrive(2, null, 17, 'walk_in', 'arrive-p17'), '/', 1));
select pg_temp.check_case('9 p17''s visit still open from yesterday', 'visit_invalid', pg_temp.link(2, 17, 'link-p17-yesterday', 8));
select pg_temp.check_case('9 p17''s outpatient visit still open from earlier today (EHR-C1''s open visit of the day)', 'updated/07',
  (select split_part(answer, '/', 1) || '/' || right(answer, 2) from pg_temp.link(2, 17, 'link-p17-today', 7) answer));
select pg_temp.check_case('9 triage p17', 'updated', split_part(pg_temp.triage(2, 17, 'triage-p17', 4::smallint), '/', 1));
select pg_temp.check_case('9 the same triage again: replayed (version not checked again)', 'replayed:updated',
  split_part(pg_temp.triage(2, 17, 'triage-p17', 4::smallint, null, false, 1), '/', 1));
select pg_temp.check_case('9 the same key, another body', 'key_reused',
  (select pg_temp.answer_line(answer) from (select pg_temp.as_member(2)) context,
     ehr.ed_triage(pg_temp.att(17), pg_temp.ver(17), 5::smallint, null, false, pg_temp.key('triage-p17'),
       pg_temp.sha('triage-p17-other')) answer));
select pg_temp.check_case('9 the key of another record', 'key_reused',
  (select pg_temp.answer_line(answer) from (select pg_temp.as_member(2)) context,
     ehr.ed_triage(pg_temp.att(2), 1, 4::smallint, null, false, pg_temp.key('triage-p17'), pg_temp.sha('triage-p17')) answer));
select pg_temp.check_case('9 a record of another facility (member B)', 'not_found',
  (select pg_temp.answer_line(answer) from (select pg_temp.as_member(8)) context,
     ehr.ed_triage(pg_temp.att(17), 1, 4::smallint, null, false, pg_temp.key('triage-p17-b'), pg_temp.sha('x')) answer));

-- 10. The history, the helper, privileges.
select pg_temp.check_case('10 p1''s history (the complaint''s text never in it)',
  'arrived,triaged,triaged,moved,visit_linked,disposition,disposition_changed,left',
  pg_temp.history(1, 1));
select pg_temp.check_case('10 p5''s second record: moved from the waiting list, then cancelled',
  'moved_from_waiting_list,cancelled', pg_temp.history(1, 5));
-- The free-text reasons, as the complaint, only for members holding ehr.ed.triage (Rahman, #337 7175564791, nits,
-- "The front desk"): the desk read a clinician's reason for a changed disposition before.
select pg_temp.check_case('10 the desk reads p1''s history with no reason (the changed disposition''s is hidden)',
  '-,-,-,-,-,-,-,-', pg_temp.history_reasons(1, 1));
select pg_temp.check_case('10 the nurse reads the changed disposition''s reason',
  '-,-,-,-,-,-,No inpatient bed tonight; transferred,-', pg_temp.history_reasons(2, 1));
select pg_temp.check_case('10 the doctor too', '-,-,-,-,-,-,No inpatient bed tonight; transferred,-',
  pg_temp.history_reasons(3, 1));
select pg_temp.check_case('10 the desk reads no cancel reason either, not even its own (p5)', '-,-',
  pg_temp.history_reasons(1, 5));
select pg_temp.check_case('10 the nurse reads p5''s cancel reason', '-,Sent to the board by mistake',
  pg_temp.history_reasons(2, 5));
select pg_temp.as_member(1);
select pg_temp.check_case('10 the desk''s read of p1: the complaint and the reasons hidden alike', 'true/-',
  (select complaint_hidden::text || '/' || coalesce(presenting_complaint, '-') from ehr.ed_read(pg_temp.att(1))));
reset role;
select pg_temp.check_case('10 no complaint text and no name in any history row', '0',
  (select count(*)::text from ehr.ed_attendance_events event
    where to_jsonb(event)::text ~* 'chest pain|motorcycle|unresponsive|amaka|edone|edtwo'));
select pg_temp.check_case('10 complaint changes recorded as yes or no', 'false,true,true',
  (select string_agg(coalesce(complaint_changed::text, '-'), ',' order by sequence_no)
     from ehr.ed_attendance_events where attendance_id = pg_temp.att(1) and kind in ('arrived', 'triaged')));
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.check_case('10 the waiting-list helper: p17 open on the board, p15 not', 't/f',
  (select format('%s/%s', bool_or(entry_id = pg_temp.queue_entry(17)), bool_or(entry_id = pg_temp.queue_entry(15)))
     from ehr.visit_queue_ed_attendances(array[pg_temp.queue_entry(17), pg_temp.queue_entry(15)])));
select pg_temp.check_case('10 the helper for lab staff', '42501',
  pg_temp.try($s$select pg_temp.as_member(5); select * from ehr.visit_queue_ed_attendances(array[]::uuid[])$s$));
select pg_temp.check_case('10 no read of the records', '42501', pg_temp.try('select count(*) from ehr.ed_attendances'));
select pg_temp.check_case('10 no read of the history', '42501', pg_temp.try('select count(*) from ehr.ed_attendance_events'));
select pg_temp.check_case('10 no card helper', '42501',
  pg_temp.try('select * from ehr.ed_cards(array[]::uuid[], null, null, null, true)'));
select pg_temp.check_case('10 no caller helper', '42501', pg_temp.try($s$select * from ehr.ed_caller('ehr.ed.read', array['direct-care'])$s$));
reset role;
select pg_temp.check_case('10 the history is append only', '55000',
  pg_temp.try('update ehr.ed_attendance_events set reason = null'));
select pg_temp.check_case('10 the history cannot be emptied either (TRUNCATE), even by its owner', '55000',
  pg_temp.try('truncate ehr.ed_attendance_events'));
select pg_temp.check_case('10 the history''s sequence: no privilege for any runtime role (after runtime-grants.sql)', '0',
  (select count(*)::text from pg_roles runtime_role
    cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) privilege_type
    where runtime_role.rolname ~ '^hid_' and not runtime_role.rolsuper
      and not pg_has_role(runtime_role.oid, (select relowner from pg_class
                                             where oid = 'ehr.ed_attendance_events_sequence_no_seq'::regclass), 'MEMBER')
      and has_sequence_privilege(runtime_role.oid, 'ehr.ed_attendance_events_sequence_no_seq', privilege_type)));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('10 ehr-api cannot read the history''s sequence (a count of every facility''s ED events)', '42501',
  pg_temp.try('select last_value from ehr.ed_attendance_events_sequence_no_seq'));
select pg_temp.check_case('10 nor advance it', '42501',
  pg_temp.try($s$select nextval('ehr.ed_attendance_events_sequence_no_seq')$s$));
reset role;
select pg_temp.check_case('10 EXECUTE on the commands', 'hid_ehr_runtime',
  (select string_agg(distinct grantee.rolname, ',')
     from pg_proc proc
     join pg_namespace namespace on namespace.oid = proc.pronamespace,
     lateral aclexplode(proc.proacl) acl join pg_roles grantee on grantee.oid = acl.grantee
    where namespace.nspname = 'ehr' and (proc.proname like 'ed\_%' or proc.proname like 'visit\_queue\_ed\_%')
      and acl.grantee <> proc.proowner));
select pg_temp.check_case('10 identity runtime cannot arrive', 'false',
  has_function_privilege('hid_identity_api_runtime', 'ehr.ed_arrive(text, uuid, text, timestamptz, smallint, text, text, text)',
    'execute')::text);
select pg_temp.check_case('10 an arrival is not an own-facility basis (p1 found by search)', '(null)',
  identity.own_facility_basis('e1680400-0000-4000-8000-000000000001', 'e1680000-0000-4000-8000-000000000002'));
select pg_temp.check_case('10 an emergency arrival is not either (p3)', '(null)',
  identity.own_facility_basis('e1680400-0000-4000-8000-000000000003', 'e1680000-0000-4000-8000-000000000002'));
select pg_temp.check_case('10 one open record per patient per facility', '23505',
  pg_temp.try($s$insert into ehr.ed_attendances (facility_id, organization_id, patient_id, visit_queue_entry_id,
    arrival_basis, arrival_mode, arrived_at, arrival_day, arrived_by_account_id, arrived_by_membership_id,
    updated_by_membership_id) select facility_id, organization_id, patient_id, visit_queue_entry_id, arrival_basis,
    arrival_mode, arrived_at, arrival_day, arrived_by_account_id, arrived_by_membership_id, updated_by_membership_id
    from ehr.ed_attendances where id = pg_temp.att(17)$s$));
select pg_temp.check_case('10 a decided record needs its disposition', '23514',
  pg_temp.try($s$update ehr.ed_attendances set status = 'decided' where id = pg_temp.att(17)$s$));

-- 11. Audit.
select pg_temp.check_case('11 arrival rows', 'denied:12/success:21',
  (select string_agg(format('%s:%s', outcome, count), '/' order by outcome)
     from (select outcome, count(*) from audit.events where action = 'ehr.ed.arrive'
             and facility_id = 'e1680000-0000-4000-8000-000000000002' group by outcome) counted));
select pg_temp.check_case('11 arrival refusal kinds',
  'key_reused:1/match_ref_not_valid:4/no_break_glass:2/not_own_facility_patient:1/patient_not_available:2/time_invalid:2',
  (select string_agg(format('%s:%s', kind, count), '/' order by kind)
     from (select details ->> 'refusal' as kind, count(*) from audit.events
            where action = 'ehr.ed.arrive' and outcome = 'denied'
              and facility_id = 'e1680000-0000-4000-8000-000000000002' group by 1) counted));
select pg_temp.check_case('11 0135''s check-in rows by the emergency department', '13',
  (select count(*)::text from audit.events where action = 'ehr.visit-queue.check-in'
     and details ->> 'by' = 'emergency_department' and facility_id = 'e1680000-0000-4000-8000-000000000002'));
select pg_temp.check_case('11 every write''s outcomes',
  'ehr.ed.cancel:denied:2,ehr.ed.cancel:success:4,ehr.ed.disposition:denied:5,ehr.ed.disposition:success:10,ehr.ed.leave:denied:2,ehr.ed.leave:success:1,ehr.ed.link-visit:denied:5,ehr.ed.link-visit:success:3,ehr.ed.move:denied:3,ehr.ed.move:success:3,ehr.ed.triage:denied:4,ehr.ed.triage:failure:1,ehr.ed.triage:success:6',
  (select string_agg(format('%s:%s:%s', action, outcome, count), ',' order by action, outcome)
     from (select action, outcome, count(*) from audit.events
            where action in ('ehr.ed.triage', 'ehr.ed.move', 'ehr.ed.link-visit', 'ehr.ed.disposition', 'ehr.ed.leave',
                             'ehr.ed.cancel')
              and facility_id in ('e1680000-0000-4000-8000-000000000002', 'e1680000-0000-4000-8000-000000000012')
            group by action, outcome) counted));
select pg_temp.check_case('11 every board read has a collection row and a row per patient shown', 'true',
  (select (count(*) filter (where action = 'ehr.ed.board.shown')
           = sum(coalesce((details ->> 'resultCount')::integer, 0)) filter (where action = 'ehr.ed.board'))::text
     from audit.events where action in ('ehr.ed.board', 'ehr.ed.board.shown')));
select pg_temp.check_case('11 every shown row names its patient', '0',
  (select count(*)::text from audit.events where action = 'ehr.ed.board.shown' and patient_id is null));
select pg_temp.check_case('11 no name, date of birth, Health ID, complaint, referral name or reason in any ED audit row', '0',
  (select count(*)::text from audit.events
    where (action like 'ehr.ed.%' or (action = 'ehr.visit-queue.check-in' and details ->> 'by' = 'emergency_department'))
      and (details::text ~* 'ed(one|two|three|four|five|six|seven|person)|amaka|bayo|chika|tunde|HID-ED|1980-|1986-|chest pain|motorcycle|unresponsive|teaching hospital|mistake|arrested|no inpatient bed'
           or coalesce(reason, '') <> '')));

select pg_temp.check_case('11 every cancel kept its waiting-list row (waitingListRowKept), moved or made by the arrival',
  'false:2/true:2',
  (select string_agg(format('%s:%s', moved, count), '/' order by moved)
     from (select details ->> 'movedFromWaitingList' as moved, count(*) from audit.events
            where action = 'ehr.ed.cancel' and outcome = 'success' and details ->> 'waitingListRowKept' = 'true'
              and facility_id = 'e1680000-0000-4000-8000-000000000002' group by 1) counted));
select pg_temp.check_case('11 the emergency arrival names the break-glass grant it relied on; no other arrival names one',
  'e1680700-0000-4000-8000-000000000001|0',
  (select string_agg(distinct details ->> 'consentGrantId', ',') from audit.events
    where action = 'ehr.ed.arrive' and outcome = 'success' and details ->> 'basis' = 'emergency'
      and facility_id = 'e1680000-0000-4000-8000-000000000002') || '|'
  || (select count(*) from audit.events where action = 'ehr.ed.arrive' and details ? 'consentGrantId'
        and details ->> 'basis' is distinct from 'emergency'));

-- 12. The board switched off after use (the kill switch).
set local role hid_ehr_api_runtime;
select pg_temp.check_case('12 p20, p21, p22 and p23 arrive; p20 triaged on the board; p21 discharged (decided)',
  'arrived|arrived|arrived|arrived|updated|updated',
  (select split_part(pg_temp.arrive(2, null, 20, 'walk_in', 'arrive-p20'), '/', 1) || '|'
     || split_part(pg_temp.arrive(2, null, 21, 'walk_in', 'arrive-p21'), '/', 1) || '|'
     || split_part(pg_temp.arrive(2, null, 22, 'walk_in', 'arrive-p22'), '/', 1) || '|'
     || split_part(pg_temp.arrive(2, null, 23, 'walk_in', 'arrive-p23'), '/', 1) || '|'
     || split_part(pg_temp.triage(2, 20, 'triage-p20', 2::smallint), '/', 1) || '|'
     || split_part(pg_temp.dispose(3, 21, 'dispose-p21', 'discharged'), '/', 1)));
select pg_temp.check_case('12 with the board on, 0135''s update of p20''s row is still refused', '55000 VISIT_QUEUE_ON_ED_BOARD',
  pg_temp.queue_update(1, 20, 'finished'));
select pg_temp.check_case('12 board off: a stale version changes nothing', 'changed/ready/false/2',
  pg_temp.board_off_update(1, 20, 'finished', version => 1));
select pg_temp.check_case('12 board off: lab staff have no waiting list', '42501 VISIT_QUEUE_NOT_PERMITTED',
  pg_temp.board_off_update(5, 20, 'finished'));
select pg_temp.check_case('12 board off: another facility''s member does not find the row', 'not_found/-/false/-',
  pg_temp.board_off_update(8, 20, 'finished', version => 1));
select pg_temp.check_case('12 board off: p20''s ED record is still open after those', 'open/-/-/false', pg_temp.ed_state(20));
select pg_temp.check_case('12 board off: the desk finishes p20 on the waiting list', 'updated/finished/true/2',
  pg_temp.board_off_update(1, 20, 'finished'));
select pg_temp.check_case('12 board off: the desk cancels p21 (decided) on the waiting list', 'updated/cancelled/true/-',
  pg_temp.board_off_update(1, 21, 'cancelled'));
select pg_temp.check_case('12 board off: a nurse sets p22''s level on the waiting list, the row stays open',
  'updated/waiting/false/1', pg_temp.board_off_update(2, 22, null, 1::smallint));
select pg_temp.check_case('12 the marker is cleared after the call', '',
  coalesce(current_setting('hid.ed_board_closing', true), ''));
select pg_temp.check_case('12 0135''s own update is still refused for p23 (still on the board)', '55000 VISIT_QUEUE_ON_ED_BOARD',
  pg_temp.queue_update(2, 23, null, 1::smallint));
select pg_temp.check_case('12 board off: a row with no ED record is 0135''s update', 'updated/triage/false/2',
  pg_temp.board_off_update(1, 19, 'triage'));
select pg_temp.check_case('12 p22''s row is the waiting list''s again: 0135''s own update works', 'updated',
  pg_temp.queue_update(3, 22, 'with_clinician'));
reset role;
select pg_temp.check_case('12 p20, p21 and p22''s ED records closed on the waiting list (p21''s disposition kept), p23 open',
  'closed/waiting_list/-/true|closed/waiting_list/discharged/true|closed/waiting_list/-/true|open/-/-/false',
  pg_temp.ed_state(20) || '|' || pg_temp.ed_state(21) || '|' || pg_temp.ed_state(22) || '|' || pg_temp.ed_state(23));
select pg_temp.check_case('12 p20 left when the row was finished', 't',
  (select (attendance.left_at = entry.closed_at)::text::char(1) from ehr.ed_attendances attendance
     join ehr.visit_queue entry on entry.id = attendance.visit_queue_entry_id where attendance.id = pg_temp.att(20)));
select pg_temp.check_case('12 one closed_on_waiting_list event each, from the stage before to the stage after, by the waiting-list member',
  '20:ready>finished:01|21:waiting>cancelled:01|22:waiting>waiting:02',
  (select string_agg(format('%s:%s>%s:%s', right(patient_id::text, 2), from_stage, to_stage, right(by_membership_id::text, 2)),
            '|' order by patient_id)
     from ehr.ed_attendance_events where kind = 'closed_on_waiting_list'
      and patient_id in (pg_temp.patient(20), pg_temp.patient(21), pg_temp.patient(22), pg_temp.patient(23))));
select pg_temp.check_case('12 one audit row each with boardOff, as the waiting-list action''s actor, for direct care',
  '3/staff/direct-care/2/3',
  (select format('%s/%s/%s/%s/%s', count(*), min(actor_type), min(purpose_of_use), count(distinct actor_membership_id),
            count(distinct resource_id))
     from audit.events where action = 'ehr.ed.closed-on-waiting-list' and details ->> 'boardOff' = 'true'));
select pg_temp.check_case('12 0135''s own audit row for each waiting-list change (p22''s two)', '4',
  (select count(*)::text from audit.events where action = 'ehr.visit-queue.update' and outcome = 'success'
     and patient_id in (pg_temp.patient(20), pg_temp.patient(21), pg_temp.patient(22))));
select pg_temp.check_case('12 the ED records'' versions went up once for the close', '20:3|21:3|22:2',
  (select string_agg(format('%s:%s', right(patient_id::text, 2), row_version), '|' order by patient_id)
     from ehr.ed_attendances where id in (pg_temp.att(20), pg_temp.att(21), pg_temp.att(22))));
select pg_temp.check_case('12 EXECUTE on the board-off update: the EHR runtime only', 't/f/f',
  format('%s/%s/%s',
    has_function_privilege('hid_ehr_runtime',
      'ehr.visit_queue_ed_board_off_update(uuid, bigint, text, smallint, boolean, uuid, boolean)', 'execute'),
    has_function_privilege('hid_identity_api_runtime',
      'ehr.visit_queue_ed_board_off_update(uuid, bigint, text, smallint, boolean, uuid, boolean)', 'execute'),
    has_function_privilege('public',
      'ehr.visit_queue_ed_board_off_update(uuid, bigint, text, smallint, boolean, uuid, boolean)', 'execute')));

-- 13. The board's marker as a later file uses it (ADT-1's 0171 admits a patient from the board this way). p19 is
-- back on the outpatient waiting list (8) and arrives on the board again.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('13 p19 moved to the board again', 'moved_from_waiting_list',
  split_part(pg_temp.arrive(2, null, 19, 'walk_in', 'arrive-p19-again'), '/', 1));
reset role;
select pg_temp.check_case('13 the owner''s own close of p19''s row without the marker: refused', '55000',
  pg_temp.try($s$update ehr.visit_queue entry
     set stage = 'finished', stage_changed_at = clock_timestamp(), closed_at = clock_timestamp(),
         updated_by_membership_id = pg_temp.member(3), updated_at = clock_timestamp(), row_version = entry.row_version + 1
   where entry.id = pg_temp.queue_entry(19)$s$));
select pg_temp.check_case('13 a marker naming the ED record''s id instead of the row''s opens nothing', '55000',
  pg_temp.try($s$select set_config('hid.ed_board_closing', pg_temp.att(19)::text, true);
    update ehr.visit_queue entry set triage_level = 1 where entry.id = pg_temp.queue_entry(19)$s$));
select set_config('hid.ed_board_closing', pg_temp.queue_entry(19)::text, true) is not null as marked \gset
select pg_temp.check_case('13 with hid.ed_board_closing naming the row (its id as text): the close goes through', 'allowed',
  pg_temp.try($s$update ehr.visit_queue entry
     set stage = 'finished', stage_changed_at = clock_timestamp(), closed_at = clock_timestamp(),
         updated_by_membership_id = pg_temp.member(3), updated_at = clock_timestamp(), row_version = entry.row_version + 1
   where entry.id = pg_temp.queue_entry(19)$s$));
select set_config('hid.ed_board_closing', '', true) is not null as cleared \gset
select pg_temp.check_case('13 the mirror stayed out: the ED record is still open, no closed_on_waiting_list event',
  'finished/true|open|0',
  (select split_part(pg_temp.queue_of(19), '/', 1) || '/' || split_part(pg_temp.queue_of(19), '/', 2) || '|'
          || (select status from ehr.ed_attendances where id = pg_temp.att(19)) || '|'
          || (select count(*) from ehr.ed_attendance_events
               where attendance_id = pg_temp.att(19) and kind = 'closed_on_waiting_list')));
select pg_temp.check_case('13 the marker cleared: the guard is back for the row', '55000',
  pg_temp.try($s$update ehr.visit_queue entry set triage_level = 1 where entry.id = pg_temp.queue_entry(19)$s$));
-- The caller closes the ED record itself (0171 with closed_via 'admission' and an 'admitted' event, which its own
-- CHECKs add; here the closed_via 0168 knows).
update ehr.ed_attendances attendance
   set status = 'closed', left_at = clock_timestamp(), closed_via = 'waiting_list',
       updated_by_membership_id = pg_temp.member(3), updated_at = clock_timestamp(), row_version = attendance.row_version + 1
 where attendance.id = pg_temp.att(19);
select pg_temp.check_case('13 then closed by the caller, the row is the waiting list''s again', 'allowed',
  pg_temp.try($s$update ehr.visit_queue entry set triage_level = 1 where entry.id = pg_temp.queue_entry(19)$s$));

-- 14. What the clinical lead's checklist and the DPO's Q-ED-3 item ask about (Rahman, #337 7175564791: the nit "The
-- front desk", and his second condition for Q-ED-3 A). These cases hold the behaviour the two lists describe, so a
-- change of either shows here. After 11, so its counts are unchanged.
select pg_temp.make_ref('p3-emergency-again', 3, 3, 'emergency') is not null as made \gset
set local role hid_ehr_api_runtime;
select pg_temp.check_case('14 p25 put on the board at the desk', 'arrived/own_facility/waiting/waiting/-/HIDDEN/Ola Edperson25/standard/-/open',
  pg_temp.arrive(1, null, 25, 'walk_in', 'arrive-p25'));
select pg_temp.check_case('14 a nurse triages p25 at level 1', 'updated/own_facility/waiting/ready/1/-/Ola Edperson25/standard/-/open',
  pg_temp.triage(2, 25, 'triage-p25', 1::smallint));
select pg_temp.check_case('14 p25''s outpatient row: ready, level 1', 'ready/false/1/own_facility', pg_temp.queue_of(25));
select pg_temp.check_case('14 the desk may cancel that triaged level-1 arrival (it holds ehr.ed.arrive; clinical lead item)',
  'updated/own_facility/closed/waiting/-/HIDDEN/Ola Edperson25/standard/-/closed',
  pg_temp.cancel(1, 25, 'cancel-p25', 'Put on the emergency board by mistake'));
select pg_temp.check_case('14 the level leaves p25''s outpatient row: open, waiting, no level, nobody down',
  'waiting/false/-/own_facility/-', pg_temp.queue_of(25) || '/' || pg_temp.queue_assignee(25));
select pg_temp.check_case('14 p3 back by the doctor''s emergency search, with the doctor''s break-glass grant (level 1)',
  'arrived/emergency/waiting/ready/1/-/Chika Edthree/standard/-/open',
  pg_temp.arrive(3, pg_temp.ref('p3-emergency-again'), null, 'ambulance', 'arrive-p3-again', 1::smallint,
    purpose => 'emergency'));
select pg_temp.check_case('14 the doctor cancels p3''s arrival as made in error',
  'updated/emergency/closed/waiting/-/-/Chika Edthree/standard/-/closed',
  pg_temp.cancel(3, 3, 'cancel-p3-again', 'Wrong patient picked from the emergency search'));
select pg_temp.check_case('14 p3''s ED record is closed by the cancel', 'closed/cancel/-/true', pg_temp.ed_state(3));
select pg_temp.check_case('14 p3''s emergency-basis row stays open on the outpatient waiting list (DPO, Q-ED-3)',
  'waiting/false/-/emergency', pg_temp.queue_of(3));
select pg_temp.as_member(1);
select pg_temp.check_case('14 the desk sees p3 there by name, though p3 is not this facility''s own patient',
  'Chika Edthree/emergency',
  (select string_agg(listed.full_name || '/' || listed.check_in_basis, ',') from ehr.visit_queue_list(false) listed
    where listed.patient_id = pg_temp.patient(3)));
reset role;

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.b_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0168-0169 emergency board:\n%', mismatch;
  end if;
  raise notice '0168-0169 emergency board: % cases passed', (select count(*) from pg_temp.b_outcomes);
end $$;

rollback;
