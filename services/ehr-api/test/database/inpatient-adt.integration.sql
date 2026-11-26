\set ON_ERROR_STOP on
-- 0170-0173 (ADT-1, Release D; owner decisions of 25 November 2026 at the
-- recommended options): wards and beds, admissions, transfers, discharge,
-- bands, the death record (off), admission charges and ward-team access
-- (off). Rollback-only. The inpatient
-- functions run as ehr-api's login role (hid_ehr_api_runtime) and route 23 as
-- identity-api's (hid_identity_api_runtime), each in the context its
-- service's transactions set. Needs 0001-0151, BILL-1's 0162-0167, ED-1's
-- 0168-0169 and 0170-0173 applied and the runtime roles bootstrapped.
-- Fictional people, places and identifiers only; ids start a170.
--
--   1. ward setup: wards, beds, overflow spaces and staff lists by facility
--      admins only; names unique among active (any case); a ward with a
--      patient cannot change type or close, an occupied bed cannot close;
--      bed status by hand (the design's three actions), never occupied;
--   2. the request from each source (direct, consultation, the waiting list,
--      the emergency board): chart write access needed, one open admission
--      per patient, the responsible doctor, the planned encounter;
--   3. admit: one patient per bed (the bed's lock and its unique index; two
--      sessions at once are in inpatient.pg.spec.ts),
--      the sex check, the encounter in progress; the ED record closes by
--      itself (closed_via admission) and its waiting-list row finishes; a
--      waiting-list row finishes; cancel sends the ED record back to waiting
--      for admission;
--   4. transfer into and out of ICU; the old bed to cleaning; the handover
--      needs chart access to give and to read;
--   5. prepare and discharge: each outcome, the prepare-first rule, diedAt,
--      dischargedAt limits, the summary as a signed note, the encounter
--      completed; the discharge summary print;
--   6. names on ward lists: hidden while the switch is off unless the member
--      can read the chart, shown when it is on, never with a deny directive;
--      the reason hidden from members without ehr.admission.read;
--   7. bands: content, the allergy alert, reprint reasons, the newborn band
--      and pair code; no Health ID in any audit or print row;
--   8. the death record refuses while off and no role holds the code;
--      with the switch on in this test only, it works;
--   9. ward-team access: refused while off; with the switch on in this test
--      only: the ward team gets it, others are refused, it ends 2 hours after
--      a transfer and at discharge, the patient sees and can end it;
--  10. charges (BILL-1): the admission bill, bed-days at midnight (Lagos), one
--      per day under a second sweep, a stay with no midnight, the ward at
--      midnight sets the rate, the admission fee, a deposit and the credit,
--      the interim statement, outstanding after discharge; **a discharge with
--      an unpaid bill succeeds**, and a facility with no payment settings gets
--      no bill;
--  11. census, version conflicts, idempotent replays, a reused key, another
--      facility, the runtime cannot read the tables or run the helpers;
--  12. the waiting list and the emergency board (ED-1's 0168): a patient
--      requested from the waiting list and then put on the board while
--      waiting for a bed is admitted; 0171 names the row in 0168's marker
--      (hid.ed_board_closing), the row finishes, the ED record closes via
--      admission with one admitted event, the mirror stays out and the marker
--      is cleared; a waiting-list admission with no board row touches no ED
--      record; the guard still refuses an unmarked change of a board row (a
--      marker naming anything else, the ED record's id included, opens
--      nothing);
--  13. audit: every write's rows; no name, date of birth, Health ID, reason,
--      handover, summary or cause in any inpatient audit row.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.

begin;

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'adt-test'),
  ('healthcare-operations', 'Healthcare operations', 'adt-test')
  on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('a1700000-0000-4000-8000-000000000001', 'Ward Group A', 'ward-group-a'),
  ('a1700000-0000-4000-8000-000000000011', 'Ward Group B', 'ward-group-b');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'Ward Hospital A',
   'WARD-A', 'Africa/Lagos', true, 'verified'),
  ('a1700000-0000-4000-8000-000000000012', 'a1700000-0000-4000-8000-000000000011', 'Ward Hospital B',
   'WARD-B', 'Africa/Lagos', true, 'verified');
create temporary table w_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into w_members values
  (1, 'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'nurse', 'Ngozi Wardnurse'),
  (2, 'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'doctor', 'Dami Warddoctor'),
  (3, 'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'clinician', 'Chuka Wardclin'),
  (4, 'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'admin', 'Ade Wardadmin'),
  (5, 'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'receptionist', 'Remi Warddesk'),
  (6, 'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'lab', 'Lola Wardlab'),
  (7, 'a1700000-0000-4000-8000-000000000012', 'a1700000-0000-4000-8000-000000000011', 'doctor', 'Bisi Otherdoctor'),
  (8, 'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'nurse', 'Nkem Floatnurse'),
  (9, 'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'org_admin', 'Ope Wardowner'),
  (10, 'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'cashier', 'Kunle Wardcash'),
  (11, 'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001', 'billing_officer', 'Tobi Wardbill');
insert into auth.accounts (id, subject, email, display_name, status)
select ('a1700100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:ward-member-' || n,
  'ward-member-' || n || '@example.invalid', name, 'active' from w_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('a1700200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('a1700100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'ward-member-' || n || '@example.invalid', 'verified', role_code from w_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('a1700300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('a1700200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('a1700100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, organization, facility, role_code, role_code,
  true, true
from w_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('a1700100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
  ('a1700300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, facility, 'Synthetic ward suite role'
from w_members;

-- Patients: p1-p10 standard (odd male, even female), p11 an unknown record made at A, p12 a sealed demo patient,
-- p13 with a deny directive for A, p14 the mother of p15 (a newborn).
create temporary table w_patients (n integer primary key, hid text, first text, last text, sex text) on commit drop;
insert into w_patients
select n, 'HID-WD' || translate(lpad(n::text, 2, '0'), '0123456789', 'ABCDEFGHJK') || 'QQ', 'Pat',
  'Wardperson' || n, case when n % 2 = 0 then 'female' else 'male' end
from generate_series(1, 15) n;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
select ('a1700400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, hid, first, last, first || ' ' || last,
  sex, date '1970-01-01' + n * 400, 'active', 'hid' from w_patients;
update identity.patients set first_name = 'Unknown', last_name = 'U-0009', full_name = 'Unknown patient U-0009',
  source_system = 'hid-unknown-patient' where id = 'a1700400-0000-4000-8000-000000000011';
insert into identity.unknown_patients (patient_id, facility_id, label_number, unknown_reason, created_by_account_id,
  created_by_membership_id, idempotency_key, request_sha256)
values ('a1700400-0000-4000-8000-000000000011', 'a1700000-0000-4000-8000-000000000002', 9, 'unconscious',
  'a1700100-0000-4000-8000-000000000005', 'a1700300-0000-4000-8000-000000000005', 'ward-unknown-key-0009',
  repeat('0', 64));
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('patient', 'a1700400-0000-4000-8000-000000000012');
-- p13: deny directive for facility A (all actions and purposes, everyone).
insert into identity.consent_directives (id, patient_id, current_version)
values ('a1700600-0000-4000-8000-000000000013', 'a1700400-0000-4000-8000-000000000013', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, facility_id, purposes, actions, starts_at, source_reference, reason, content_sha256)
values (gen_random_uuid(), 'a1700600-0000-4000-8000-000000000013', 'a1700400-0000-4000-8000-000000000013', 1, 'active',
  'deny', 'all', null, 'a1700000-0000-4000-8000-000000000002', array[]::text[], array[]::text[],
  now() - interval '1 day', 'ward-suite', 'Synthetic deny directive', repeat('0', 64));
-- Chart grants (write, direct care, an hour): the doctor (2) and the clinician (3) for p1-p15 except p12, p13
-- (the deny directive refuses them anyway); the nurse (1) for p1 and p2 only. Nurse 8 has none.
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass)
select gen_random_uuid(), null, ('a1700400-0000-4000-8000-0000000000' || lpad(p::text, 2, '0'))::uuid,
  ('a1700200-0000-4000-8000-0000000000' || lpad(m::text, 2, '0'))::uuid,
  ('a1700100-0000-4000-8000-0000000000' || lpad(m::text, 2, '0'))::uuid,
  ('a1700300-0000-4000-8000-0000000000' || lpad(m::text, 2, '0'))::uuid, 'a1700000-0000-4000-8000-000000000002',
  'write_records', 'direct-care', 'active', 'Synthetic ward suite grant', now() - interval '5 minutes',
  now() + interval '1 hour', false
from (select p, m from generate_series(1, 15) p cross join (values (2), (3)) member(m) where p not in (12)
      union all select p, 1 from generate_series(1, 2) p) granted;
-- A visit of p3 at A (the consultation source), a waiting-list row of p4, an ED record of p5 decided
-- admit_requested (ED-1) with its waiting-list row, a prescription and a diagnosis on p1's future stay later.
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, created_at) values
  ('a1700800-0000-4000-8000-000000000003', 'a1700400-0000-4000-8000-000000000003', 'a1700000-0000-4000-8000-000000000002',
   'a1700100-0000-4000-8000-000000000002', 'a1700300-0000-4000-8000-000000000002', 'ambulatory', 'in_progress',
   now() - interval '1 hour', now() - interval '1 hour');
insert into ehr.visit_queue (id, facility_id, patient_id, queue_day, stage, check_in_basis, checked_in_by_account_id,
  checked_in_by_membership_id, checked_in_at, stage_changed_at, updated_by_membership_id, updated_at) values
  ('a1700900-0000-4000-8000-000000000004', 'a1700000-0000-4000-8000-000000000002', 'a1700400-0000-4000-8000-000000000004',
   (clock_timestamp() at time zone 'Africa/Lagos')::date, 'with_clinician', 'search', 'a1700100-0000-4000-8000-000000000005',
   'a1700300-0000-4000-8000-000000000005', clock_timestamp(), clock_timestamp(), 'a1700300-0000-4000-8000-000000000005',
   clock_timestamp()),
  ('a1700900-0000-4000-8000-000000000005', 'a1700000-0000-4000-8000-000000000002', 'a1700400-0000-4000-8000-000000000005',
   (clock_timestamp() at time zone 'Africa/Lagos')::date, 'with_clinician', 'search', 'a1700100-0000-4000-8000-000000000005',
   'a1700300-0000-4000-8000-000000000005', clock_timestamp(), clock_timestamp(), 'a1700300-0000-4000-8000-000000000005',
   clock_timestamp());
insert into ehr.ed_attendances (id, facility_id, organization_id, patient_id, visit_queue_entry_id, arrival_basis,
  arrival_mode, arrived_at, arrival_day, status, disposition_outcome, admit_to_department_code, admitting_membership_id,
  decided_at, decided_by_membership_id, arrived_by_account_id, arrived_by_membership_id, updated_by_membership_id)
values ('a1700a00-0000-4000-8000-000000000005', 'a1700000-0000-4000-8000-000000000002',
  'a1700000-0000-4000-8000-000000000001', 'a1700400-0000-4000-8000-000000000005', 'a1700900-0000-4000-8000-000000000005',
  'search', 'ambulance', clock_timestamp() - interval '2 hours', (clock_timestamp() at time zone 'Africa/Lagos')::date,
  'decided', 'admit_requested', 'inpatient', 'a1700300-0000-4000-8000-000000000003', clock_timestamp(),
  'a1700300-0000-4000-8000-000000000002', 'a1700100-0000-4000-8000-000000000005', 'a1700300-0000-4000-8000-000000000005',
  'a1700300-0000-4000-8000-000000000002');
-- Section 12: p9's waiting-list row is on the emergency board (an open ED record moved from the waiting list), with
-- no admission; p10 waits on the waiting list (its ED record is made in section 12, after the request).
insert into ehr.visit_queue (id, facility_id, patient_id, queue_day, stage, check_in_basis, checked_in_by_account_id,
  checked_in_by_membership_id, checked_in_at, stage_changed_at, updated_by_membership_id, updated_at) values
  ('a1700900-0000-4000-8000-000000000009', 'a1700000-0000-4000-8000-000000000002', 'a1700400-0000-4000-8000-000000000009',
   (clock_timestamp() at time zone 'Africa/Lagos')::date, 'waiting', 'search', 'a1700100-0000-4000-8000-000000000005',
   'a1700300-0000-4000-8000-000000000005', clock_timestamp(), clock_timestamp(), 'a1700300-0000-4000-8000-000000000005',
   clock_timestamp()),
  ('a1700900-0000-4000-8000-000000000010', 'a1700000-0000-4000-8000-000000000002', 'a1700400-0000-4000-8000-000000000010',
   (clock_timestamp() at time zone 'Africa/Lagos')::date, 'waiting', 'search', 'a1700100-0000-4000-8000-000000000005',
   'a1700300-0000-4000-8000-000000000005', clock_timestamp(), clock_timestamp(), 'a1700300-0000-4000-8000-000000000005',
   clock_timestamp());
insert into ehr.ed_attendances (id, facility_id, organization_id, patient_id, visit_queue_entry_id, arrival_basis,
  arrival_mode, arrived_at, arrival_day, moved_from_waiting_list, moved_from_stage, moved_from_stage_changed_at, status,
  arrived_by_account_id, arrived_by_membership_id, updated_by_membership_id)
values ('a1700a00-0000-4000-8000-000000000009', 'a1700000-0000-4000-8000-000000000002',
  'a1700000-0000-4000-8000-000000000001', 'a1700400-0000-4000-8000-000000000009', 'a1700900-0000-4000-8000-000000000009',
  'own_facility', 'walk_in', now() - interval '30 minutes',
  ((now() - interval '30 minutes') at time zone 'Africa/Lagos')::date, true, 'waiting',
  now() - interval '40 minutes', 'open', 'a1700100-0000-4000-8000-000000000001',
  'a1700300-0000-4000-8000-000000000001', 'a1700300-0000-4000-8000-000000000001');
-- p14 has an active allergy recorded.
insert into ehr.recorded_allergies (patient_id, facility_id, created_by, created_by_membership_id, substance, severity)
values ('a1700400-0000-4000-8000-000000000014', 'a1700000-0000-4000-8000-000000000002',
  'a1700100-0000-4000-8000-000000000002', 'a1700300-0000-4000-8000-000000000002', 'Penicillin (fictional)', 'severe');
-- A's profile (address and phone for the print).
insert into identity.facility_profiles (facility_id, trading_name, ownership, care_level, address_line, city, state_code,
  lga, gps_latitude, gps_longitude, phone_e164, email, bed_count, operating_hours, emergency_24h, departments,
  services_offered, smoh_licence_number, has_registry_id, has_nhia_accreditation, medical_director_name,
  medical_director_mdcn, expected_staff, migrating_records, needs_interoperability, source)
values ('a1700000-0000-4000-8000-000000000002', 'Ward Hospital A', 'private', 'secondary', '2 Synthetic Close', 'Yaba',
  'LA', 'Yaba', 6.5, 3.38, '+2348000000002', 'ward-a@example.invalid', 40, '24 hours', true,
  array['general_outpatient', 'emergency', 'inpatient', 'icu'], 'Fictional services', 'SYN-LIC-2', false, false,
  'Synthetic Director', 'SYN-MDCN-2', 30, false, false, 'facility_administrator');
-- p4's patient login and live session, for the patient's side of ward-team access.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('a1700100-0000-4000-8000-000000000099', 'synthetic:ward-patient-4', 'ward-patient-4@example.invalid', 'Ward Patient',
   'active');
update identity.patients set account_id = 'a1700100-0000-4000-8000-000000000099'
 where id = 'a1700400-0000-4000-8000-000000000004';
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('a1700c00-0000-4000-8000-000000000004', 'a1700100-0000-4000-8000-000000000099',
   'a1700c00-0000-4000-8000-000000000004', md5('ward-patient') || md5('ward-patient'), gen_random_uuid(), 1,
   'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
   'patient', 'a1700400-0000-4000-8000-000000000004');
set local session_replication_role = origin;

create temporary table w_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
create temporary table w_refs (name text primary key, value text) on commit drop;
grant select, insert on pg_temp.w_outcomes to hid_ehr_api_runtime, hid_identity_api_runtime;
grant usage on sequence pg_temp.w_outcomes_seq_seq to hid_ehr_api_runtime, hid_identity_api_runtime;
grant select, insert, update on pg_temp.w_refs to hid_ehr_api_runtime, hid_identity_api_runtime;
grant select on pg_temp.w_members to hid_ehr_api_runtime, hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.w_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.member(n integer) returns uuid language sql immutable as $f$
  select ('a1700300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.patient(n integer) returns uuid language sql immutable as $f$
  select ('a1700400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.as_member(n integer, purpose text default 'direct-care') returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:ward-member-' || n, true),
    set_config('app.membership_id', pg_temp.member(n)::text, true),
    set_config('app.facility_id', (select facility::text from pg_temp.w_members where w_members.n = as_member.n), true),
    set_config('app.correlation_id', 'ward-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;
create function pg_temp.key(label text) returns text language sql immutable as $f$
  select 'ward-suite-key-' || label
$f$;
create function pg_temp.sha(label text) returns text language sql immutable as $f$
  select encode(sha256(convert_to(label, 'UTF8')), 'hex')
$f$;
create function pg_temp.remember(ref_name text, ref_value text) returns text language sql as $f$
  insert into pg_temp.w_refs (name, value) values (ref_name, ref_value)
    on conflict (name) do update set value = excluded.value returning value
$f$;
create function pg_temp.ref(ref_name text) returns text language sql as $f$
  select value from pg_temp.w_refs where name = ref_name
$f$;
-- Runs a statement as member n (the session context ehr-api sets) and answers its jsonb, or the error.
create function pg_temp.run(n integer, statement text, purpose text default 'direct-care') returns jsonb
language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n, purpose);
  execute statement into answer;
  return answer;
exception when others then
  return jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
end
$f$;
create function pg_temp.o(answer jsonb) returns text language sql immutable as $f$
  select coalesce(answer->>'error', (case when (answer->>'replayed')::boolean then 'replayed:' else '' end)
    || coalesce(answer->>'outcome', '(none)'))
$f$;
-- (The suite's own lookups read the tables as the suite's owner, not as a runtime.)
create function pg_temp.ward(ward_name text) returns uuid language sql security definer as $f$
  select id from ehr.wards where name = ward_name and facility_id = 'a1700000-0000-4000-8000-000000000002' and active
$f$;
create function pg_temp.bed(ward_name text, bed_name text) returns uuid language sql security definer as $f$
  select bed.id from ehr.beds bed join ehr.wards ward on ward.id = bed.ward_id
   where ward.name = ward_name and bed.name = bed_name and ward.facility_id = 'a1700000-0000-4000-8000-000000000002'
$f$;
create function pg_temp.bed_status(ward_name text, bed_name text) returns text language sql security definer as $f$
  select status from ehr.beds where id = pg_temp.bed(ward_name, bed_name)
$f$;
create function pg_temp.bed_version(ward_name text, bed_name text) returns bigint language sql security definer as $f$
  select row_version from ehr.beds where id = pg_temp.bed(ward_name, bed_name)
$f$;
create function pg_temp.ward_version(ward_name text) returns bigint language sql security definer as $f$
  select row_version from ehr.wards where id = pg_temp.ward(ward_name)
$f$;
create function pg_temp.adm(p integer) returns uuid language sql security definer as $f$
  select id from ehr.admissions where patient_id = pg_temp.patient(p) order by requested_at desc, id desc limit 1
$f$;
create function pg_temp.adm_version(p integer) returns bigint language sql security definer as $f$
  select row_version from ehr.admissions where id = pg_temp.adm(p)
$f$;
create function pg_temp.adm_state(p integer) returns text language sql security definer as $f$
  select admission.status || '/' || coalesce(ward.name, '-') || '/' || coalesce(bed.name, '-') || '/' || encounter.status
    from ehr.admissions admission
    join ehr.encounters encounter on encounter.id = admission.encounter_id
    left join ehr.wards ward on ward.id = admission.ward_id
    left join ehr.beds bed on bed.id = admission.bed_id
   where admission.id = pg_temp.adm(p)
$f$;
create function pg_temp.queue_state(entry uuid) returns text language sql security definer as $f$
  select stage || '/' || (closed_at is not null)::text from ehr.visit_queue where id = entry
$f$;
create function pg_temp.handover_movement(p integer) returns uuid language sql security definer as $f$
  select id from ehr.admission_movements where admission_id = pg_temp.adm(p) and handover is not null
$f$;
create function pg_temp.summary_state(p integer) returns text language sql security definer as $f$
  select note.status || '/' || note.note_type || '/' || note.current_revision_no from ehr.admissions admission
    join ehr.clinical_notes note on note.id = admission.summary_note_id where admission.id = pg_temp.adm(p)
$f$;
create function pg_temp.bill_of(p integer) returns uuid language sql security definer as $f$
  select id from commercial.bills where admission_id = pg_temp.adm(p)
$f$;
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate;
end
$f$;

-- 1. Ward setup.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 a nurse cannot set up wards', '42501 WARD_SETUP_NOT_ALLOWED',
  pg_temp.o(pg_temp.run(1, $s$select ehr.ward_create('Female Medical Ward', 'general', 'female',
    pg_temp.key('w-nurse'), pg_temp.sha('w-nurse'))$s$, 'healthcare-operations')));
select pg_temp.check_case('1 setup is healthcare operations', '22023 INPATIENT_PURPOSE_REQUIRED',
  pg_temp.o(pg_temp.run(4, $s$select ehr.ward_create('Female Medical Ward', 'general', 'female',
    pg_temp.key('w-purpose'), pg_temp.sha('w-purpose'))$s$)));
select pg_temp.check_case('1 an admin creates a ward', 'created',
  pg_temp.o(pg_temp.run(4, $s$select ehr.ward_create('Female Medical Ward', 'general', 'female',
    pg_temp.key('w-fmw'), pg_temp.sha('w-fmw'))$s$, 'healthcare-operations')));
select pg_temp.check_case('1 the same key and body replays', 'replayed:created',
  pg_temp.o(pg_temp.run(4, $s$select ehr.ward_create('Female Medical Ward', 'general', 'female',
    pg_temp.key('w-fmw'), pg_temp.sha('w-fmw'))$s$, 'healthcare-operations')));
select pg_temp.check_case('1 the same key with another body is reused', 'key_reused',
  pg_temp.o(pg_temp.run(4, $s$select ehr.ward_create('Another Ward', 'general', 'any',
    pg_temp.key('w-fmw'), pg_temp.sha('w-other'))$s$, 'healthcare-operations')));
select pg_temp.check_case('1 a name already used (any case)', 'name_taken',
  pg_temp.o(pg_temp.run(9, $s$select ehr.ward_create('female medical ward', 'general', 'any',
    pg_temp.key('w-dup'), pg_temp.sha('w-dup'))$s$, 'healthcare-operations')));
select pg_temp.check_case('1 the owner creates the ICU', 'created',
  pg_temp.o(pg_temp.run(9, $s$select ehr.ward_create('ICU', 'icu', 'any', pg_temp.key('w-icu'),
    pg_temp.sha('w-icu'))$s$, 'healthcare-operations')));
select pg_temp.check_case('1 a male ward', 'created',
  pg_temp.o(pg_temp.run(4, $s$select ehr.ward_create('Male Medical Ward', 'general', 'male', pg_temp.key('w-mmw'),
    pg_temp.sha('w-mmw'))$s$, 'healthcare-operations')));
select pg_temp.check_case('1 an invalid ward type', '22023 INPATIENT_INVALID',
  pg_temp.o(pg_temp.run(4, $s$select ehr.ward_create('Odd Ward', 'surgical', 'any', pg_temp.key('w-odd'),
    pg_temp.sha('w-odd'))$s$, 'healthcare-operations')));
select pg_temp.check_case('1 beds and overflow spaces', 'created,created,created,created,created,created,created,created,created,created,created,created,created,created',
  (select string_agg(pg_temp.o(pg_temp.run(4, format($s$select ehr.bed_create(%L, %L, %L, %L, %L)$s$,
     pg_temp.ward(ward_name), bed_name, kind, pg_temp.key('b-' || ord), pg_temp.sha('b-' || ord)),
     'healthcare-operations')), ',' order by ord)
     from (values (1, 'Female Medical Ward', 'Bed 1', 'bed'), (2, 'Female Medical Ward', 'Bed 2', 'bed'),
                  (3, 'Female Medical Ward', 'Extra mattress 1', 'overflow'), (4, 'ICU', 'ICU Bed 1', 'bed'),
                  (5, 'ICU', 'ICU Bed 2', 'bed'), (6, 'Male Medical Ward', 'Bed 1', 'bed'),
                  (7, 'Male Medical Ward', 'Bed 2', 'bed'), (8, 'Female Medical Ward', 'Bed 3', 'bed'),
                  (9, 'Female Medical Ward', 'Bed 4', 'bed'), (10, 'ICU', 'ICU Bed 3', 'bed'),
                  (11, 'Male Medical Ward', 'Bed 3', 'bed'), (12, 'Male Medical Ward', 'Bed 4', 'bed'),
                  (13, 'ICU', 'ICU Bed 4', 'bed'), (14, 'Female Medical Ward', 'Bed 5', 'bed'))
          beds(ord, ward_name, bed_name, kind)));
select pg_temp.check_case('1 a bed name already used in the ward', 'name_taken',
  pg_temp.o(pg_temp.run(4, format($s$select ehr.bed_create(%L, 'BED 1', 'bed', %L, %L)$s$,
    pg_temp.ward('Female Medical Ward'), pg_temp.key('b-dup'), pg_temp.sha('b-dup')), 'healthcare-operations')));
select pg_temp.check_case('1 the same bed name in another ward is fine', 'created',
  pg_temp.o(pg_temp.run(4, format($s$select ehr.bed_create(%L, 'Bed 1', 'bed', %L, %L)$s$,
    pg_temp.ward('ICU'), pg_temp.key('b-icu-bed1'), pg_temp.sha('b-icu-bed1')), 'healthcare-operations')));
select pg_temp.check_case('1 the staff list takes nurses, clinicians and doctors only', 'staff_invalid',
  pg_temp.o(pg_temp.run(4, format($s$select ehr.ward_staff_set(%L, %s, array[%L, %L]::uuid[], %L, %L)$s$,
    pg_temp.ward('Female Medical Ward'), pg_temp.ward_version('Female Medical Ward'), pg_temp.member(1),
    pg_temp.member(5), pg_temp.key('s-bad'), pg_temp.sha('s-bad')), 'healthcare-operations')));
select pg_temp.check_case('1 another facility''s member is refused too', 'staff_invalid',
  pg_temp.o(pg_temp.run(4, format($s$select ehr.ward_staff_set(%L, %s, array[%L]::uuid[], %L, %L)$s$,
    pg_temp.ward('Female Medical Ward'), pg_temp.ward_version('Female Medical Ward'), pg_temp.member(7),
    pg_temp.key('s-other'), pg_temp.sha('s-other')), 'healthcare-operations')));
select pg_temp.check_case('1 the female ward''s staff: nurse 1 and doctor 2', 'updated/2',
  (select pg_temp.o(answer) || '/' || (answer->'ward'->>'staffCount')
     from pg_temp.run(4, format($s$select ehr.ward_staff_set(%L, %s, array[%L, %L]::uuid[], %L, %L)$s$,
       pg_temp.ward('Female Medical Ward'), pg_temp.ward_version('Female Medical Ward'), pg_temp.member(1),
       pg_temp.member(2), pg_temp.key('s-fmw'), pg_temp.sha('s-fmw')), 'healthcare-operations') answer));
select pg_temp.check_case('1 a stale version', 'changed',
  pg_temp.o(pg_temp.run(4, format($s$select ehr.ward_staff_set(%L, 1, array[]::uuid[], %L, %L)$s$,
    pg_temp.ward('Female Medical Ward'), pg_temp.key('s-stale'), pg_temp.sha('s-stale')), 'healthcare-operations')));
select pg_temp.check_case('1 the ward list for a nurse: three wards, counts only', '3/5/0',
  (select jsonb_array_length(answer->'items') || '/' || (answer->'items'->0->>'bedCount') || '/'
          || (answer->'items'->0->>'occupied')
     from pg_temp.run(1, $s$select ehr.ward_list(false, false)$s$) answer));
select pg_temp.check_case('1 a receptionist has no wards', '42501 INPATIENT_NOT_ALLOWED',
  pg_temp.o(pg_temp.run(5, $s$select ehr.ward_list(false, false)$s$)));
select pg_temp.check_case('1 bed status: place in maintenance needs a reason', 'note_required',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.bed_set_status(%L, %s, 'maintenance', 'short', %L, %L)$s$,
    pg_temp.bed('Female Medical Ward', 'Bed 2'), pg_temp.bed_version('Female Medical Ward', 'Bed 2'),
    pg_temp.key('st-1'), pg_temp.sha('st-1')))));
select pg_temp.check_case('1 bed status: maintenance, then release, then cleaning, then turnover',
  'updated,updated,updated,updated/available',
  (select string_agg(pg_temp.o(pg_temp.run(1, format($s$select ehr.bed_set_status(%L, %s, %L, %L, %L, %L)$s$,
      pg_temp.bed('Female Medical Ward', 'Bed 2'), pg_temp.bed_version('Female Medical Ward', 'Bed 2'), status, note,
      pg_temp.key('st-' || ord + 1), pg_temp.sha('st-' || ord + 1)))), ',' order by ord)
     from (values (1, 'maintenance', 'Broken bed rail (fictional)'), (2, 'available', null), (3, 'cleaning', null),
                  (4, 'available', 'Cleaned and made up')) steps(ord, status, note))
   || '/' || pg_temp.bed_status('Female Medical Ward', 'Bed 2'));
select pg_temp.check_case('1 occupied is never set by hand', '22023 INPATIENT_INVALID',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.bed_set_status(%L, %s, 'occupied', null, %L, %L)$s$,
    pg_temp.bed('Female Medical Ward', 'Bed 2'), pg_temp.bed_version('Female Medical Ward', 'Bed 2'),
    pg_temp.key('st-occ'), pg_temp.sha('st-occ')))));
select pg_temp.check_case('1 a receptionist cannot set a bed''s status', '42501 BED_ALLOCATE_NOT_ALLOWED',
  pg_temp.o(pg_temp.run(5, format($s$select ehr.bed_set_status(%L, %s, 'cleaning', null, %L, %L)$s$,
    pg_temp.bed('Female Medical Ward', 'Bed 2'), pg_temp.bed_version('Female Medical Ward', 'Bed 2'),
    pg_temp.key('st-desk'), pg_temp.sha('st-desk')))));
reset role;

-- 2. Requests.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 a nurse cannot request an admission', '42501 ADMISSION_DECIDE_NOT_ALLOWED',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
    'Community-acquired pneumonia (fictional)', null, %L, null, null, %L, %L)$s$, pg_temp.patient(1), pg_temp.member(2),
    pg_temp.key('r-nurse'), pg_temp.sha('r-nurse')))));
select pg_temp.check_case('2 a doctor requests p2 directly (female ward wanted)', 'created/requested/planned',
  (select pg_temp.o(answer) || '/' || (answer->'admission'->>'status') || '/'
          || (select split_part(pg_temp.adm_state(2), '/', 4))
     from pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
       'Community-acquired pneumonia (fictional)', 'Medical team A', %L, %L, null, %L, %L)$s$, pg_temp.patient(2),
       pg_temp.member(2), pg_temp.ward('Female Medical Ward'), pg_temp.key('r-p2'), pg_temp.sha('r-p2'))) answer));
select pg_temp.check_case('2 the admission number', 'true',
  (select ((answer->'admission'->>'admissionNumber') ~ '^A-[0-9]{4}-000001$')::text
     from pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
       'Community-acquired pneumonia (fictional)', 'Medical team A', %L, %L, null, %L, %L)$s$, pg_temp.patient(2),
       pg_temp.member(2), pg_temp.ward('Female Medical Ward'), pg_temp.key('r-p2'), pg_temp.sha('r-p2'))) answer));
select pg_temp.check_case('2 a second request for the same patient', 'already_open/true',
  (select pg_temp.o(answer) || '/' || ((answer->>'openAdmissionId')::uuid = pg_temp.adm(2))::text
     from pg_temp.run(3, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
       'Something else (fictional)', null, %L, null, null, %L, %L)$s$, pg_temp.patient(2), pg_temp.member(3),
       pg_temp.key('r-p2-again'), pg_temp.sha('r-p2-again'))) answer));
select pg_temp.check_case('2 without chart write access (sealed demo patient)', 'chart_access_required',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null, 'Fever (fictional)',
    null, %L, null, null, %L, %L)$s$, pg_temp.patient(12), pg_temp.member(2), pg_temp.key('r-p12'),
    pg_temp.sha('r-p12')))));
select pg_temp.check_case('2 the deny directive refuses the chart', 'chart_access_required',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null, 'Fever (fictional)',
    null, %L, null, null, %L, %L)$s$, pg_temp.patient(13), pg_temp.member(2), pg_temp.key('r-p13'),
    pg_temp.sha('r-p13')))));
select pg_temp.check_case('2 the responsible doctor must be a doctor or clinician here', 'responsible_invalid',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null, 'Fever (fictional)',
    null, %L, null, null, %L, %L)$s$, pg_temp.patient(1), pg_temp.member(1), pg_temp.key('r-p1-bad'),
    pg_temp.sha('r-p1-bad')))));
select pg_temp.check_case('2 a source without its id', '22023 ADMISSION_SOURCE_INVALID',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'consultation', null, null, null,
    'Fever (fictional)', null, %L, null, null, %L, %L)$s$, pg_temp.patient(1), pg_temp.member(2),
    pg_temp.key('r-p1-src'), pg_temp.sha('r-p1-src')))));
select pg_temp.check_case('2 a consultation of another patient', 'source_invalid',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'consultation', %L, null, null,
    'Fever (fictional)', null, %L, null, null, %L, %L)$s$, pg_temp.patient(1), 'a1700800-0000-4000-8000-000000000003',
    pg_temp.member(2), pg_temp.key('r-p1-other'), pg_temp.sha('r-p1-other')))));
select pg_temp.check_case('2 p1 directly to the male ward', 'created',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
    'Cellulitis of the leg (fictional)', null, %L, %L, null, %L, %L)$s$, pg_temp.patient(1), pg_temp.member(2),
    pg_temp.ward('Male Medical Ward'), pg_temp.key('r-p1'), pg_temp.sha('r-p1')))));
select pg_temp.check_case('2 p3 from a consultation', 'created/consultation',
  (select pg_temp.o(answer) || '/' || (answer->'admission'->>'source')
     from pg_temp.run(3, format($s$select ehr.admission_request(%L, 'consultation', %L, null, null,
       'Asthma attack (fictional)', null, %L, null, null, %L, %L)$s$, pg_temp.patient(3),
       'a1700800-0000-4000-8000-000000000003', pg_temp.member(3), pg_temp.key('r-p3'), pg_temp.sha('r-p3'))) answer));
select pg_temp.check_case('2 p4 from the waiting list', 'created/waiting_list',
  (select pg_temp.o(answer) || '/' || (answer->'admission'->>'source')
     from pg_temp.run(2, format($s$select ehr.admission_request(%L, 'waiting_list', null, null, %L,
       'Severe malaria (fictional)', null, %L, %L, null, %L, %L)$s$, pg_temp.patient(4),
       'a1700900-0000-4000-8000-000000000004', pg_temp.member(2), pg_temp.ward('Female Medical Ward'),
       pg_temp.key('r-p4'), pg_temp.sha('r-p4'))) answer));
select pg_temp.check_case('2 p5 from the emergency board: the ED record''s admitting clinician is responsible',
  'created/ed/true',
  (select pg_temp.o(answer) || '/' || (answer->'admission'->>'source') || '/'
          || ((answer->'admission'->>'responsibleMembershipId')::uuid = pg_temp.member(3))::text
     from pg_temp.run(2, format($s$select ehr.admission_request(%L, 'ed', null, %L, null,
       'Head injury, observation (fictional)', null, null, null, null, %L, %L)$s$, pg_temp.patient(5),
       'a1700a00-0000-4000-8000-000000000005', pg_temp.key('r-p5'), pg_temp.sha('r-p5'))) answer));
select pg_temp.check_case('2 p11, the unknown record, from the board ward', 'created/Unknown patient U-0009/true',
  (select pg_temp.o(answer) || '/' || (answer->'admission'->>'fullName') || '/'
          || (answer->'admission'->>'dateOfBirthEstimated')
     from pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
       'Found unconscious (fictional)', null, %L, %L, null, %L, %L)$s$, pg_temp.patient(11), pg_temp.member(2),
       pg_temp.ward('ICU'), pg_temp.key('r-p11'), pg_temp.sha('r-p11'))) answer));
select pg_temp.check_case('2 the mother p14 and her newborn p15', 'created/created',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
    'Postpartum care (fictional)', null, %L, %L, null, %L, %L)$s$, pg_temp.patient(14), pg_temp.member(2),
    pg_temp.ward('Female Medical Ward'), pg_temp.key('r-p14'), pg_temp.sha('r-p14'))))
  || '/' || pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
    'Newborn observation (fictional)', null, %L, %L, %L, %L, %L)$s$, pg_temp.patient(15), pg_temp.member(2),
    pg_temp.ward('Female Medical Ward'), pg_temp.adm(14), pg_temp.key('r-p15'), pg_temp.sha('r-p15')))));
reset role;

-- 3. Admit.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 a receptionist cannot give a bed', '42501 BED_ALLOCATE_NOT_ALLOWED',
  pg_temp.o(pg_temp.run(5, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(2),
    pg_temp.adm_version(2), pg_temp.bed('Female Medical Ward', 'Bed 1'), pg_temp.key('a-desk'), pg_temp.sha('a-desk')))));
select pg_temp.check_case('3 nurse 8 (no chart grant) gives p2 a bed', 'updated/admitted/Female Medical Ward/Bed 1/in_progress',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(2),
    pg_temp.adm_version(2), pg_temp.bed('Female Medical Ward', 'Bed 1'), pg_temp.key('a-p2'), pg_temp.sha('a-p2'))))
  || '/' || pg_temp.adm_state(2));
select pg_temp.check_case('3 the bed is occupied', 'occupied', pg_temp.bed_status('Female Medical Ward', 'Bed 1'));
select pg_temp.check_case('3 an occupied bed is not available', 'bed_not_available',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(4),
    pg_temp.adm_version(4), pg_temp.bed('Female Medical Ward', 'Bed 1'), pg_temp.key('a-p4-taken'),
    pg_temp.sha('a-p4-taken')))));
select pg_temp.check_case('3 a stale version', 'changed',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, 99, %L, false, %L, %L)$s$, pg_temp.adm(4),
    pg_temp.bed('Female Medical Ward', 'Bed 2'), pg_temp.key('a-p4-stale'), pg_temp.sha('a-p4-stale')))));
select pg_temp.check_case('3 a man into the female ward needs the confirmation', 'sex_mismatch',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(1),
    pg_temp.adm_version(1), pg_temp.bed('Female Medical Ward', 'Bed 2'), pg_temp.key('a-p1-sex'),
    pg_temp.sha('a-p1-sex')))));
select pg_temp.check_case('3 p1 into the male ward', 'updated',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(1),
    pg_temp.adm_version(1), pg_temp.bed('Male Medical Ward', 'Bed 1'), pg_temp.key('a-p1'), pg_temp.sha('a-p1')))));
select pg_temp.check_case('3 the replay answers the first answer', 'replayed:updated',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(1),
    1, pg_temp.bed('Male Medical Ward', 'Bed 1'), pg_temp.key('a-p1'), pg_temp.sha('a-p1')))));
select pg_temp.check_case('3 p4 (from the waiting list) into the overflow space; its row finishes',
  'updated/finished/true',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(4),
    pg_temp.adm_version(4), pg_temp.bed('Female Medical Ward', 'Extra mattress 1'), pg_temp.key('a-p4'),
    pg_temp.sha('a-p4'))))
  || '/' || pg_temp.queue_state('a1700900-0000-4000-8000-000000000004'));
reset role;
-- p5 (from the ED) waits; cancel it first: the ED record stays decided (Waiting for admission).
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 cancel needs a reason of 8 characters', '22023 INPATIENT_REASON_REQUIRED',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_cancel(%L, %s, 'short', %L, %L)$s$, pg_temp.adm(5),
    pg_temp.adm_version(5), pg_temp.key('c-p5-short'), pg_temp.sha('c-p5-short')))));
select pg_temp.check_case('3 cancel the ED request', 'updated/cancelled/-/-/cancelled',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_cancel(%L, %s, 'Family chose another hospital', %L, %L)$s$,
    pg_temp.adm(5), pg_temp.adm_version(5), pg_temp.key('c-p5'), pg_temp.sha('c-p5'))))
  || '/' || pg_temp.adm_state(5));
reset role;
select pg_temp.check_case('3 the ED record is back to waiting for admission', 'decided/admit_requested',
  (select status || '/' || disposition_outcome from ehr.ed_attendances where id = 'a1700a00-0000-4000-8000-000000000005'));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 a new ED request, then a bed: the ED record closes by itself', 'created/updated',
  pg_temp.o(pg_temp.run(3, format($s$select ehr.admission_request(%L, 'ed', null, %L, null,
    'Head injury, observation (fictional)', null, null, %L, null, %L, %L)$s$, pg_temp.patient(5),
    'a1700a00-0000-4000-8000-000000000005', pg_temp.ward('ICU'), pg_temp.key('r-p5-again'),
    pg_temp.sha('r-p5-again'))))
  || '/' || pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$,
    pg_temp.adm(5), pg_temp.adm_version(5), pg_temp.bed('ICU', 'ICU Bed 1'), pg_temp.key('a-p5'), pg_temp.sha('a-p5')))));
reset role;
select pg_temp.check_case('3 the ED record closed via admission, its row finished, one admitted event',
  'closed/admission/finished/true/1',
  (select attendance.status || '/' || attendance.closed_via || '/' || entry.stage || '/'
          || (entry.closed_at is not null)::text || '/'
          || (select count(*) from ehr.ed_attendance_events event where event.attendance_id = attendance.id
               and event.kind = 'admitted')
     from ehr.ed_attendances attendance join ehr.visit_queue entry on entry.id = attendance.visit_queue_entry_id
    where attendance.id = 'a1700a00-0000-4000-8000-000000000005'));
-- One patient per bed: the bed's row lock and the one-open-admission-per-bed index (two sessions at once are in
-- inpatient.pg.spec.ts, on committed rows).
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 one patient per bed: the first admit wins, the second finds the bed taken',
  'updated/bed_not_available',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(14),
    pg_temp.adm_version(14), pg_temp.bed('Female Medical Ward', 'Bed 2'), pg_temp.key('a-p14'), pg_temp.sha('a-p14'))))
  || '/' || pg_temp.o(pg_temp.run(3, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$,
    pg_temp.adm(3), pg_temp.adm_version(3), pg_temp.bed('Female Medical Ward', 'Bed 2'), pg_temp.key('a-p3-race'),
    pg_temp.sha('a-p3-race')))));
reset role;
select pg_temp.check_case('3 the bed index refuses a second open admission on one bed', '23505',
  pg_temp.try(format($s$update ehr.admissions set status = 'admitted', admitted_at = now(),
    admitted_by_membership_id = %L, ward_id = %L, bed_id = %L where id = %L$s$, pg_temp.member(1),
    pg_temp.ward('Female Medical Ward'), pg_temp.bed('Female Medical Ward', 'Bed 2'), pg_temp.adm(3))));
select pg_temp.check_case('3 the open-patient index refuses a second open admission', '23505',
  pg_temp.try(format($s$insert into ehr.admissions (facility_id, organization_id, patient_id, encounter_id,
    admission_number, source, reason, responsible_membership_id, requested_at, requested_by_membership_id,
    updated_by_membership_id) select facility_id, organization_id, patient_id, 'a1700800-0000-4000-8000-000000000003',
    'A-2099-999999', 'direct', 'x', responsible_membership_id, now(), requested_by_membership_id,
    updated_by_membership_id from ehr.admissions where id = %L$s$, pg_temp.adm(2))));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 p3 into the second male bed; the newborn (a boy) into the female ward with confirmation',
  'updated/updated',
  pg_temp.o(pg_temp.run(3, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(3),
    pg_temp.adm_version(3), pg_temp.bed('Male Medical Ward', 'Bed 2'), pg_temp.key('a-p3'), pg_temp.sha('a-p3'))))
  || '/' || pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, true, %L, %L)$s$,
    pg_temp.adm(15), pg_temp.adm_version(15), pg_temp.bed('Female Medical Ward', 'Bed 4'), pg_temp.key('a-p15'),
    pg_temp.sha('a-p15')))));
reset role;

-- 4. Transfers.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('4 a handover needs chart access (nurse 8 has none)', 'chart_access_required',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.admission_transfer(%L, %s, %L, 'Stable overnight, on oxygen (fictional)',
    false, %L, %L)$s$, pg_temp.adm(2), pg_temp.adm_version(2), pg_temp.bed('ICU', 'Bed 1'), pg_temp.key('t-p2-8'),
    pg_temp.sha('t-p2-8')))));
select pg_temp.check_case('4 nurse 1 (chart grant) moves p2 into ICU with a handover; the old bed goes to cleaning',
  'updated/admitted/ICU/Bed 1/in_progress/cleaning/occupied',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_transfer(%L, %s, %L,
    'Stable overnight, on oxygen (fictional)', false, %L, %L)$s$, pg_temp.adm(2), pg_temp.adm_version(2),
    pg_temp.bed('ICU', 'Bed 1'), pg_temp.key('t-p2'), pg_temp.sha('t-p2'))))
  || '/' || pg_temp.adm_state(2) || '/' || pg_temp.bed_status('Female Medical Ward', 'Bed 1') || '/'
  || pg_temp.bed_status('ICU', 'Bed 1'));
select pg_temp.check_case('4 nurse 8 moves p2 back out of ICU (a step-down) without a handover', 'updated',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.admission_transfer(%L, %s, %L, null, false, %L, %L)$s$,
    pg_temp.adm(2), pg_temp.adm_version(2), pg_temp.bed('Female Medical Ward', 'Bed 5'), pg_temp.key('t-p2-back'),
    pg_temp.sha('t-p2-back')))));
select pg_temp.check_case('4 a bed under cleaning is not free', 'bed_not_available',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.admission_transfer(%L, %s, %L, null, false, %L, %L)$s$,
    pg_temp.adm(1), pg_temp.adm_version(1), pg_temp.bed('ICU', 'Bed 1'), pg_temp.key('t-p1-clean'),
    pg_temp.sha('t-p1-clean')))));
select pg_temp.check_case('4 the movements show a handover was recorded, never its text', 'true/false',
  (select (count(*) filter (where (movement->>'handoverRecorded')::boolean) = 1)::text || '/'
          || (answer::text like '%oxygen%')::text
     from pg_temp.run(8, format($s$select ehr.admission_read(%L)$s$, pg_temp.adm(2))) answer,
          jsonb_array_elements(answer->'movements') movement group by answer));
select pg_temp.check_case('4 the handover text: refused without chart access, read with it',
  'chart_access_required/Stable overnight, on oxygen (fictional)',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.admission_handover_read(%L, %L)$s$, pg_temp.adm(2),
    pg_temp.handover_movement(2))))
  || '/' || ((pg_temp.run(2, format($s$select ehr.admission_handover_read(%L, %L)$s$, pg_temp.adm(2),
    pg_temp.handover_movement(2))))->>'handover'));
reset role;

-- 5. Prepare and discharge.
-- A prescription on p2's stay, written by the doctor (the suite's owner writes it in the doctor's context).
select pg_temp.as_member(2);
insert into ehr.prescriptions (encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status, medication_strength, medication_dose_form, dose_quantity,
  dose_unit, duration_value, duration_unit)
select encounter_id, patient_id, facility_id, 'a1700100-0000-4000-8000-000000000002',
  'a1700300-0000-4000-8000-000000000002', 'Amoxicillin', 'three times a day', 'After food', 'active', '500 mg',
  'capsule', 1, 'capsule', 5, 'day' from ehr.admissions where id = pg_temp.adm(2);
select pg_temp.remember('rx-p2', (select id::text from ehr.prescriptions where patient_id = pg_temp.patient(2)));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('5 a routine discharge needs "Prepare discharge" first', 'not_prepared',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'routine', null,
    '{"presentingProblem": "Cough and fever", "courseInHospital": "Improved on antibiotics"}'::jsonb, null, null,
    'SIGN', %L, %L)$s$, pg_temp.adm(2), pg_temp.adm_version(2), pg_temp.key('d-p2-early'), pg_temp.sha('d-p2-early')))));
select pg_temp.check_case('5 a nurse cannot prepare a discharge', '42501 ADMISSION_DECIDE_NOT_ALLOWED',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_prepare_discharge(%L, %s, 'Clinic in two weeks', null,
    array[]::uuid[], %L, %L)$s$, pg_temp.adm(2), pg_temp.adm_version(2), pg_temp.key('p-nurse'), pg_temp.sha('p-nurse')))));
select pg_temp.check_case('5 a medicine not on the stay', 'medicines_invalid',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_prepare_discharge(%L, %s, 'Clinic in two weeks', null,
    array[%L]::uuid[], %L, %L)$s$, pg_temp.adm(2), pg_temp.adm_version(2), gen_random_uuid(), pg_temp.key('p-bad'),
    pg_temp.sha('p-bad')))));
select pg_temp.check_case('5 prepare p2''s discharge with its medicine', 'updated/discharge_ready',
  (select pg_temp.o(answer) || '/' || (answer->'admission'->>'status')
     from pg_temp.run(2, format($s$select ehr.admission_prepare_discharge(%L, %s, 'Clinic in two weeks (fictional)',
       (clock_timestamp() at time zone 'Africa/Lagos')::date + 2, array[%L]::uuid[], %L, %L)$s$, pg_temp.adm(2),
       pg_temp.adm_version(2), pg_temp.ref('rx-p2'), pg_temp.key('p-p2'), pg_temp.sha('p-p2'))) answer));
select pg_temp.check_case('5 the summary is required for a routine discharge', '22023 DISCHARGE_SUMMARY_REQUIRED',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'routine', null, null, null, null,
    'SIGN', %L, %L)$s$, pg_temp.adm(2), pg_temp.adm_version(2), pg_temp.key('d-p2-nosum'), pg_temp.sha('d-p2-nosum')))));
select pg_temp.check_case('5 the typed word SIGN', '22023 SIGNATURE_REQUIRED',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'routine', null,
    '{"presentingProblem": "Cough and fever", "courseInHospital": "Improved"}'::jsonb, null, null, 'ok', %L, %L)$s$,
    pg_temp.adm(2), pg_temp.adm_version(2), pg_temp.key('d-p2-sign'), pg_temp.sha('d-p2-sign')))));
select pg_temp.check_case('5 a discharge time in the future', 'time_invalid',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'routine', now() + interval '1 hour',
    '{"presentingProblem": "Cough and fever", "courseInHospital": "Improved"}'::jsonb, null, null, 'SIGN', %L, %L)$s$,
    pg_temp.adm(2), pg_temp.adm_version(2), pg_temp.key('d-p2-future'), pg_temp.sha('d-p2-future')))));
select pg_temp.check_case('5 discharge p2 routinely: bed to cleaning, encounter completed, a signed summary note',
  'updated/discharged/-/-/completed/cleaning/signed/Discharge summary/1',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'routine', null,
    '{"presentingProblem": "Cough and fever (fictional)", "courseInHospital": "Improved on oral antibiotics (fictional)",
      "conditionAtDischarge": "improved", "patientAdvice": "Finish the medicine (fictional)"}'::jsonb, null, null,
    'SIGN', %L, %L)$s$, pg_temp.adm(2), pg_temp.adm_version(2), pg_temp.key('d-p2'), pg_temp.sha('d-p2'))))
  || '/' || pg_temp.adm_state(2) || '/' || pg_temp.bed_status('Female Medical Ward', 'Bed 5') || '/'
  || pg_temp.summary_state(2));
select pg_temp.check_case('5 the print: summary as signed, medicines, wards, last 4 of the Health ID only',
  'found/Amoxicillin/500 mg/2/null/improved/Dami Warddoctor/Female Medical Ward,ICU',
  (select pg_temp.o(answer) || '/' || (answer->'print'->'medicinesOnDischarge'->0->>'medicationDisplay') || '/'
          || (answer->'print'->'medicinesOnDischarge'->0->>'strength') || '/'
          || jsonb_array_length(answer->'print'->'wards') || '/'
          || coalesce(answer->'print'->'patient'->>'healthId', 'null') || '/'
          || (answer->'print'->'summary'->>'conditionAtDischarge') || '/' || (answer->'print'->>'signedBy') || '/'
          || (select string_agg(value, ',' order by ord) from jsonb_array_elements_text(answer->'print'->'wards')
                with ordinality ward(value, ord))
     from pg_temp.run(2, format($s$select ehr.discharge_summary_print(%L)$s$, pg_temp.adm(2))) answer));
select pg_temp.check_case('5 the print needs chart access', 'chart_access_required',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.discharge_summary_print(%L)$s$, pg_temp.adm(2)))));
select pg_temp.check_case('5 DAMA from admitted (no prepare), with a summary', 'updated',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'dama', null,
    '{"presentingProblem": "Leg swelling (fictional)", "courseInHospital": "Left against advice (fictional)"}'::jsonb,
    null, null, 'SIGN', %L, %L)$s$, pg_temp.adm(1), pg_temp.adm_version(1), pg_temp.key('d-p1'), pg_temp.sha('d-p1')))));
select pg_temp.check_case('5 died needs the time of death', '22023 DIED_AT_REQUIRED',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'died', null, null, null, null, 'SIGN',
    %L, %L)$s$, pg_temp.adm(5), pg_temp.adm_version(5), pg_temp.key('d-p5-noat'), pg_temp.sha('d-p5-noat')))));
select pg_temp.check_case('5 died before admission is refused', 'time_invalid',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'died', null, null, null,
    now() - interval '3 days', 'SIGN', %L, %L)$s$, pg_temp.adm(5), pg_temp.adm_version(5), pg_temp.key('d-p5-early'),
    pg_temp.sha('d-p5-early')))));
select pg_temp.check_case('5 died from admitted, no summary: outcome and time only', 'updated/died/true/null',
  (select pg_temp.o(answer) || '/' || (answer->'admission'->'discharge'->>'outcome') || '/'
          || ((answer->'admission'->'discharge'->>'diedAt') is not null)::text || '/'
          || coalesce(answer->>'summaryNoteId', 'null')
     from pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'died', null, null, null,
       clock_timestamp(), 'SIGN', %L, %L)$s$, pg_temp.adm(5), pg_temp.adm_version(5), pg_temp.key('d-p5'),
       pg_temp.sha('d-p5'))) answer));
select pg_temp.check_case('5 referred out needs the facility name', '22023 INPATIENT_INVALID',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'referred_out', null,
    '{"presentingProblem": "Asthma", "courseInHospital": "Needs a specialist"}'::jsonb, null, null, 'SIGN', %L, %L)$s$,
    pg_temp.adm(3), pg_temp.adm_version(3), pg_temp.key('d-p3-ref'), pg_temp.sha('d-p3-ref')))));
select pg_temp.check_case('5 absconded from admitted, no summary', 'updated/absconded',
  (select pg_temp.o(answer) || '/' || (answer->'admission'->'discharge'->>'outcome')
     from pg_temp.run(3, format($s$select ehr.admission_discharge(%L, %s, 'absconded', null, null, null, null, 'SIGN',
       %L, %L)$s$, pg_temp.adm(3), pg_temp.adm_version(3), pg_temp.key('d-p3'), pg_temp.sha('d-p3'))) answer));
select pg_temp.check_case('5 a discharged admission cannot move again', 'state_invalid',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_transfer(%L, %s, %L, null, false, %L, %L)$s$,
    pg_temp.adm(3), pg_temp.adm_version(3), pg_temp.bed('Male Medical Ward', 'Bed 1'), pg_temp.key('t-p3-late'),
    pg_temp.sha('t-p3-late')))));
reset role;

-- 6. Names and reasons on ward lists.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('6 nurse 8 (no grant) sees initials, sex and age, not the name', 'true/null/P W/true',
  (select (card->>'nameHidden') || '/' || coalesce(card->>'fullName', 'null') || '/' || (card->>'initials') || '/'
          || ((card->>'ageYears') is not null)::text
     from pg_temp.run(8, format($s$select ehr.admission_read(%L)$s$, pg_temp.adm(4))) answer,
          lateral (select answer->'admission' as card) carded));
select pg_temp.check_case('6 the doctor (grant) sees the name', 'false/Pat Wardperson4',
  (select (answer->'admission'->>'nameHidden') || '/' || (answer->'admission'->>'fullName')
     from pg_temp.run(2, format($s$select ehr.admission_read(%L)$s$, pg_temp.adm(4))) answer));
select pg_temp.check_case('6 the board for nurse 8: names hidden for every patient here', 'found/3/0',
  (select pg_temp.o(answer) || '/'
          || (select count(*) from jsonb_array_elements(answer->'wards'->0->'beds') bed
               where jsonb_typeof(bed->'patient') = 'object') || '/'
          || (select count(*) from jsonb_array_elements(answer->'wards'->0->'beds') bed
               where (bed->'patient'->>'nameHidden') = 'false')
     from pg_temp.run(8, format($s$select ehr.bed_board(%L, null)$s$, pg_temp.ward('Female Medical Ward'))) answer));
reset role;
update ehr.inpatient_switches set enabled = true where key = 'board_names_for_ward_staff';
set local role hid_ehr_api_runtime;
select pg_temp.check_case('6 with the switch on (test only): every ward member sees names', 'false/Pat Wardperson4',
  (select (answer->'admission'->>'nameHidden') || '/' || (answer->'admission'->>'fullName')
     from pg_temp.run(8, format($s$select ehr.admission_read(%L)$s$, pg_temp.adm(4))) answer));
reset role;
update ehr.inpatient_switches set enabled = false where key = 'board_names_for_ward_staff';
delete from auth.role_permissions where role_code = 'nurse' and permission_code = 'ehr.admission.read';
set local role hid_ehr_api_runtime;
select pg_temp.check_case('6 the reason is hidden without ehr.admission.read', 'true/null',
  (select (answer->'admission'->>'reasonHidden') || '/' || coalesce(answer->'admission'->>'reason', 'null')
     from pg_temp.run(8, format($s$select ehr.admission_read(%L)$s$, pg_temp.adm(4))) answer));
reset role;
insert into auth.role_permissions (role_code, permission_code) values ('nurse', 'ehr.admission.read');
set local role hid_ehr_api_runtime;
select pg_temp.check_case('6 and shown with it', 'false/Severe malaria (fictional)',
  (select (answer->'admission'->>'reasonHidden') || '/' || (answer->'admission'->>'reason')
     from pg_temp.run(8, format($s$select ehr.admission_read(%L)$s$, pg_temp.adm(4))) answer));
reset role;
-- p13 (deny directive): admitted by the suite's owner to see the board card.
select pg_temp.check_case('6 a deny directive: initials only and chartBlocked, even with the switch on', 'true/true',
  (select (card->>'nameHidden') || '/' || (card->>'chartBlocked')
     from (select pg_temp.as_member(8)) ctx,
          lateral (select set_config('hid.dummy', '1', true)) d,
          lateral (select card.card from ehr.admission_cards(array[(select id from ehr.admissions limit 0)]::uuid[], true) card
                   union all select jsonb_build_object('nameHidden', not ehr.ward_patient_name_visible(pg_temp.member(8),
                     pg_temp.patient(13)), 'chartBlocked', ehr.inpatient_chart_blocked(pg_temp.patient(13),
                     'a1700000-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000001',
                     'a1700200-0000-4000-8000-000000000008'))) carded(card)));

-- 7. Bands.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('7 the first band: name, Health ID for printing, admission number, ward',
  'printed/Pat Wardperson4/HID-WDAEQQ/true/Female Medical Ward/1/false',
  (select pg_temp.o(answer) || '/' || (answer->'band'->>'fullName') || '/' || (answer->'band'->>'healthId') || '/'
          || ((answer->'band'->>'barcode') = (answer->'band'->>'admissionNumber'))::text || '/'
          || (answer->'band'->>'wardName') || '/' || (answer->'band'->>'printNumber') || '/'
          || (answer->'band'->>'allergyAlert')
     from pg_temp.run(8, format($s$select ehr.wristband_print(%L, null, %L, %L)$s$, pg_temp.adm(4),
       pg_temp.key('band-p4'), pg_temp.sha('band-p4'))) answer));
select pg_temp.check_case('7 a reprint needs a reason', 'reprint_reason_required',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.wristband_print(%L, null, %L, %L)$s$, pg_temp.adm(4),
    pg_temp.key('band-p4-again'), pg_temp.sha('band-p4-again')))));
select pg_temp.check_case('7 a reprint (lost)', 'printed/2',
  (select pg_temp.o(answer) || '/' || (answer->'band'->>'printNumber')
     from pg_temp.run(8, format($s$select ehr.wristband_print(%L, 'lost', %L, %L)$s$, pg_temp.adm(4),
       pg_temp.key('band-p4-lost'), pg_temp.sha('band-p4-lost'))) answer));
reset role;
-- p11 (unknown) gets a bed so its band can print.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('7 the unknown record gets a bed and a band', 'updated/null/Unknown patient U-0009/true',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(11),
    pg_temp.adm_version(11), pg_temp.bed('ICU', 'ICU Bed 4'), pg_temp.key('a-p11'), pg_temp.sha('a-p11'))))
  || '/' || (select coalesce(answer->'band'->>'fullName', 'null') || '/' || (answer->'band'->>'unknownLabel') || '/'
          || (answer->'band'->>'ageEstimated')
     from pg_temp.run(1, format($s$select ehr.wristband_print(%L, null, %L, %L)$s$, pg_temp.adm(11),
       pg_temp.key('band-p11'), pg_temp.sha('band-p11'))) answer));
select pg_temp.check_case('7 the newborn band carries the pair code and the mother', 'printed/B1/Pat Wardperson14/true',
  (select pg_temp.o(answer) || '/' || split_part(answer->'band'->>'pairCode', ' / ', 2) || '/'
          || (answer->'band'->>'motherName') || '/'
          || ((answer->'band'->>'pairCode') like (answer->'band'->>'motherAdmissionNumber') || ' / B1')::text
     from pg_temp.run(1, format($s$select ehr.newborn_band_print(%L, null, %L, %L)$s$, pg_temp.adm(15),
       pg_temp.key('band-p15'), pg_temp.sha('band-p15'))) answer));
select pg_temp.check_case('7 the mother''s band reprinted with the same pair code', 'printed/true',
  (select pg_temp.o(answer) || '/' || ((answer->'band'->>'pairCode') like '% / B1')::text
     from pg_temp.run(1, format($s$select ehr.wristband_print(%L, null, %L, %L)$s$, pg_temp.adm(14),
       pg_temp.key('band-p14'), pg_temp.sha('band-p14'))) answer));
select pg_temp.check_case('7 a newborn band for an admission with no mother', 'mother_invalid',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.newborn_band_print(%L, null, %L, %L)$s$, pg_temp.adm(4),
    pg_temp.key('band-p4-nb'), pg_temp.sha('band-p4-nb')))));
select pg_temp.check_case('7 the allergy alert: true for the mother (an allergy recorded), false for p4; never the name',
  'true/false/false',
  (select (answer->'band'->>'allergyAlert') || '/' || (answer::text like '%Penicillin%')::text
     from pg_temp.run(1, format($s$select ehr.wristband_print(%L, 'damaged', %L, %L)$s$, pg_temp.adm(14),
       pg_temp.key('band-p14-again'), pg_temp.sha('band-p14-again'))) answer)
  || '/' || (select answer->'band'->>'allergyAlert' from pg_temp.run(8, format(
     $s$select ehr.wristband_print(%L, 'damaged', %L, %L)$s$, pg_temp.adm(4), pg_temp.key('band-p4-dmg'),
     pg_temp.sha('band-p4-dmg'))) answer));
reset role;
select pg_temp.check_case('7 no Health ID in any band print row', '0',
  (select count(*)::text from ehr.wristband_prints where to_jsonb(wristband_prints)::text like '%HID-%'));

-- 8. The death record (off).
set local role hid_ehr_api_runtime;
select pg_temp.check_case('8 the death record is switched off', '55000 DEATH_RECORD_NOT_AVAILABLE',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.death_record_write(%L, %L::jsonb)$s$, pg_temp.adm(5),
    '{"causes": [{"line": "a", "text": "Head injury (fictional)"}], "manner": "accident", "autopsy": "not_requested", "signature": "SIGN"}'))));
select pg_temp.check_case('8 and its read and print', '55000 DEATH_RECORD_NOT_AVAILABLE/55000 DEATH_RECORD_NOT_AVAILABLE',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.death_record_read(%L)$s$, pg_temp.adm(5)))) || '/'
  || pg_temp.o(pg_temp.run(2, format($s$select ehr.death_record_print(%L, 'certificate')$s$, pg_temp.adm(5)))));
reset role;
select pg_temp.check_case('8 no role holds ehr.death-record.write', '0',
  (select count(*)::text from auth.role_permissions where permission_code = 'ehr.death-record.write'));
update ehr.inpatient_switches set enabled = true where key = 'death_record';
set local role hid_ehr_api_runtime;
select pg_temp.check_case('8 switch on (test only), still no role holds the code', '42501 INPATIENT_NOT_ALLOWED',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.death_record_write(%L, %L::jsonb)$s$, pg_temp.adm(5),
    '{"causes": [{"line": "a", "text": "Head injury (fictional)"}], "manner": "accident", "autopsy": "not_requested", "signature": "SIGN"}'))));
reset role;
insert into auth.role_permissions (role_code, permission_code) values ('doctor', 'ehr.death-record.write');
set local role hid_ehr_api_runtime;
select pg_temp.check_case('8 with the code (test only): write, read, amend, print', 'created/found/updated/found',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.death_record_write(%L, %L::jsonb)$s$, pg_temp.adm(5),
    '{"causes": [{"line": "a", "text": "Head injury (fictional)", "interval": "2 days"}, {"line": "b", "text": "Road traffic accident (fictional)"}], "manner": "accident", "autopsy": "not_requested", "signature": "SIGN"}')))
  || '/' || pg_temp.o(pg_temp.run(2, format($s$select ehr.death_record_read(%L)$s$, pg_temp.adm(5))))
  || '/' || pg_temp.o(pg_temp.run(2, format($s$select ehr.death_record_amend(%L, %L::jsonb, 'Corrected the interval')$s$,
    pg_temp.adm(5), '{"causes": [{"line": "a", "text": "Head injury (fictional)", "interval": "3 days"}], "manner": "accident", "autopsy": "requested", "signature": "SIGN"}')))
  || '/' || pg_temp.o(pg_temp.run(2, format($s$select ehr.death_record_print(%L, 'registration-notice')$s$,
    pg_temp.adm(5)))));
select pg_temp.check_case('8 only for an admission discharged as died', 'state_invalid',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.death_record_write(%L, %L::jsonb)$s$, pg_temp.adm(1),
    '{"causes": [{"line": "a", "text": "x"}], "manner": "natural", "autopsy": "not_requested", "signature": "SIGN"}'))));
reset role;
delete from auth.role_permissions where role_code = 'doctor' and permission_code = 'ehr.death-record.write';
update ehr.inpatient_switches set enabled = false where key = 'death_record';
select pg_temp.check_case('8 the death record changed nothing on the patient', 'active',
  (select status from identity.patients where id = pg_temp.patient(5)));

-- 9. Ward-team access (off; on in this test only).
set local role hid_identity_api_runtime;
select pg_temp.check_case('9 ward-team access is switched off', '55000 WARD_STAY_ACCESS_NOT_AVAILABLE',
  (select coalesce(answer->>'error', answer->>'outcome') from pg_temp.run(8, format(
     $s$select to_jsonb(opened) from identity.open_ward_stay(%L) opened$s$, pg_temp.adm(4))) answer));
reset role;
update ehr.inpatient_switches set enabled = true where key = 'ward_stay_access';
set local role hid_identity_api_runtime;
select pg_temp.check_case('9 nurse 8 is not on the female ward''s staff list', 'refused',
  (select coalesce(answer->>'error', answer->>'outcome') from pg_temp.run(8, format(
     $s$select to_jsonb(opened) from identity.open_ward_stay(%L) opened$s$, pg_temp.adm(4))) answer));
select pg_temp.check_case('9 nurse 1 (on the list) gets the grant, reused the second time', 'opened/false/opened/true',
  (select coalesce(answer->>'error', answer->>'outcome') || '/' || (answer->>'existing_grant')
     from pg_temp.run(1, format($s$select to_jsonb(opened) from identity.open_ward_stay(%L) opened$s$,
       pg_temp.adm(4))) answer)
  || '/' || (select coalesce(answer->>'error', answer->>'outcome') || '/' || (answer->>'existing_grant')
     from pg_temp.run(1, format($s$select to_jsonb(opened) from identity.open_ward_stay(%L) opened$s$,
       pg_temp.adm(4))) answer));
reset role;
select pg_temp.check_case('9 the grant opens the chart for direct care', 'true',
  (select ehr.context_allows(pg_temp.patient(4), 'a1700000-0000-4000-8000-000000000002', 'write_records')::text
     from (select pg_temp.as_member(1)) ctx));
select pg_temp.check_case('9 the opening is noted for the patient', 'noted',
  (select identity.note_record_access((select id from identity.consent_grants where authorization_method = 'ward_stay'
     and admission_id = pg_temp.adm(4))) from (select pg_temp.as_member(1)) ctx));
select pg_temp.check_case('9 as a ward-stay notice ("Your records were opened")', 'ward_stay',
  (select access_kind from identity.record_access_notices where patient_id = pg_temp.patient(4)));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('9 a transfer to ICU (nurse 1 is not on its list)', 'updated',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.admission_transfer(%L, %s, %L, null, false, %L, %L)$s$,
    pg_temp.adm(4), pg_temp.adm_version(4), pg_temp.bed('ICU', 'ICU Bed 3'), pg_temp.key('t-p4-icu'),
    pg_temp.sha('t-p4-icu')))));
reset role;
select pg_temp.check_case('9 the grant now ends 2 hours later', 'true',
  (select (expires_at between now() + interval '119 minutes' and now() + interval '121 minutes')::text
     from identity.consent_grants
    where authorization_method = 'ward_stay' and admission_id = pg_temp.adm(4)));
select pg_temp.check_case('9 the patient sees it in the access history as ward-stay, revocable', 'ward-stay/true',
  (select format('%s/%s', item ->> 'basis', item ->> 'revocableByPatient')
     from (select set_config('app.actor_subject', 'synthetic:ward-patient-4', true),
                  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
                  set_config('app.correlation_id', 'ward-suite-patient-4', true),
                  set_config('app.purpose_of_use', '', true)) ctx,
          jsonb_array_elements(identity.patient_self_access_history('synthetic:ward-patient-4',
            'a1700c00-0000-4000-8000-000000000004') -> 'items') item
    where item ->> 'consentGrantId' = (select id::text from identity.consent_grants
                                        where authorization_method = 'ward_stay' and admission_id = pg_temp.adm(4))));
select pg_temp.check_case('9 the patient can end it', 'revoked/false',
  (select format('%s/%s', grant_status, replayed::text) from identity.revoke_my_consent_grant('synthetic:ward-patient-4',
    'a1700c00-0000-4000-8000-000000000004', (select id from identity.consent_grants
      where authorization_method = 'ward_stay' and admission_id = pg_temp.adm(4)), 'I did not agree to this')));
set local role hid_identity_api_runtime;
select pg_temp.check_case('9 the ward team opens again after a revocation (a new grant)', 'refused',
  (select coalesce(answer->>'error', answer->>'outcome') from pg_temp.run(1, format(
     $s$select to_jsonb(opened) from identity.open_ward_stay(%L) opened$s$, pg_temp.adm(4))) answer));
reset role;
-- (Nurse 1 is no longer on the ward team of the ICU bed; the responsible doctor 2 opens it.)
set local role hid_identity_api_runtime;
select pg_temp.check_case('9 the responsible doctor is on the ward team wherever the patient is', 'opened',
  (select coalesce(answer->>'error', answer->>'outcome') from pg_temp.run(2, format(
     $s$select to_jsonb(opened) from identity.open_ward_stay(%L) opened$s$, pg_temp.adm(4))) answer));
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.check_case('9 discharge ends the grant at once', 'updated',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'dama', null,
    '{"presentingProblem": "Fever (fictional)", "courseInHospital": "Left against advice (fictional)"}'::jsonb, null,
    null, 'SIGN', %L, %L)$s$, pg_temp.adm(4), pg_temp.adm_version(4), pg_temp.key('d-p4'), pg_temp.sha('d-p4')))));
reset role;
select pg_temp.check_case('9 the doctor''s grant expired at discharge; the revoked one stays revoked; one end row per change',
  'expired,revoked/2',
  (select string_agg(status, ',' order by status) from identity.consent_grants where authorization_method = 'ward_stay'
     and admission_id = pg_temp.adm(4)) || '/'
  || (select count(*)::text from audit.events where action = 'identity.ward-stay.end'
       and details->>'admissionId' = pg_temp.adm(4)::text));
update ehr.inpatient_switches set enabled = false where key = 'ward_stay_access';

-- 10. Charges (BILL-1). Facility A uses billing: settings, a bed-day item and an admission fee item.
set local session_replication_role = replica;
insert into commercial.payment_settings (facility_id, updated_by_membership_id, idempotency_key, request_sha256,
  allow_deferred_for)
values ('a1700000-0000-4000-8000-000000000002', 'a1700300-0000-4000-8000-000000000011', 'ward-suite-settings-key-1',
  repeat('0', 64), array['emergency']);
insert into commercial.catalogue_items (id, facility_id, kind, name, active, created_by_membership_id,
  updated_by_membership_id, idempotency_key, request_sha256) values
  ('a1700b00-0000-4000-8000-000000000001', 'a1700000-0000-4000-8000-000000000002', 'other', 'Bed-day, general ward',
   true, 'a1700300-0000-4000-8000-000000000011', 'a1700300-0000-4000-8000-000000000011', 'ward-suite-item-key-001',
   repeat('0', 64)),
  ('a1700b00-0000-4000-8000-000000000002', 'a1700000-0000-4000-8000-000000000002', 'other', 'Bed-day, ICU',
   true, 'a1700300-0000-4000-8000-000000000011', 'a1700300-0000-4000-8000-000000000011', 'ward-suite-item-key-002',
   repeat('0', 64)),
  ('a1700b00-0000-4000-8000-000000000003', 'a1700000-0000-4000-8000-000000000002', 'other', 'Admission fee',
   true, 'a1700300-0000-4000-8000-000000000011', 'a1700300-0000-4000-8000-000000000011', 'ward-suite-item-key-003',
   repeat('0', 64));
insert into commercial.catalogue_item_prices (facility_id, catalogue_item_id, hmo_id, amount_kobo, active) values
  ('a1700000-0000-4000-8000-000000000002', 'a1700b00-0000-4000-8000-000000000001', null, 500000, true),
  ('a1700000-0000-4000-8000-000000000002', 'a1700b00-0000-4000-8000-000000000002', null, 2000000, true),
  ('a1700000-0000-4000-8000-000000000002', 'a1700b00-0000-4000-8000-000000000003', null, 300000, true);
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.check_case('10 ward charges by the billing officer', 'ok/ok/ok',
  (select string_agg(case when answer ? 'error' then answer->>'error' else 'ok' end, '/' order by ord)
     from (values (1, 'Female Medical Ward', 'a1700b00-0000-4000-8000-000000000001'),
                  (2, 'Male Medical Ward', 'a1700b00-0000-4000-8000-000000000001'),
                  (3, 'ICU', 'a1700b00-0000-4000-8000-000000000002')) charged(ord, ward_name, item),
          lateral pg_temp.run(11, format($s$select commercial.ward_charges_set(%L, 0, %L,
            'a1700b00-0000-4000-8000-000000000003')$s$, pg_temp.ward(ward_name), item), 'healthcare-operations') answer));
select pg_temp.check_case('10 a nurse cannot set ward charges', 'HB403 BILLING_NOT_ALLOWED',
  pg_temp.o(pg_temp.run(1, format($s$select commercial.ward_charges_set(%L, 1, null, null)$s$,
    pg_temp.ward('ICU')))));
select pg_temp.check_case('10 a request opens the admission bill', 'created',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
    'Pyelonephritis (fictional)', null, %L, null, null, %L, %L)$s$, pg_temp.patient(6), pg_temp.member(2),
    pg_temp.key('r-p6'), pg_temp.sha('r-p6')))));
reset role;
select pg_temp.check_case('10 one admission bill, source admission, unpaid', 'admission/unpaid/0',
  (select source || '/' || status || '/' || total_kobo from commercial.bills where admission_id = pg_temp.adm(6)));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('10 the bed is given: the admission fee', 'updated/1/300000',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(6),
    pg_temp.adm_version(6), pg_temp.bed('Female Medical Ward', 'Bed 3'), pg_temp.key('a-p6'), pg_temp.sha('a-p6')))));
reset role;
update pg_temp.w_outcomes set actual = actual || '/' || (select count(*) || '/' || sum(line.total_kobo)
  from commercial.bill_lines line join commercial.bills bill on bill.id = line.bill_id
 where bill.admission_id = pg_temp.adm(6) and line.origin = 'admission') where name = '10 the bed is given: the admission fee';
-- Three days ago in the female ward, moved to ICU yesterday morning (the suite moves the clock back on the rows).
update ehr.admissions set admitted_at = date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'
  - interval '3 days' + interval '10 hours', requested_at = date_trunc('day', now() at time zone 'Africa/Lagos')
  at time zone 'Africa/Lagos' - interval '3 days' + interval '9 hours' where id = pg_temp.adm(6);
alter table ehr.admission_movements disable trigger admission_movements_immutable;
update ehr.admission_movements set at = (select admitted_at from ehr.admissions where id = pg_temp.adm(6))
 where admission_id = pg_temp.adm(6) and kind = 'admitted';
insert into ehr.admission_movements (admission_id, facility_id, patient_id, kind, at, by_account_id, by_membership_id,
  from_ward_id, to_ward_id, idempotency_key, request_sha256)
select pg_temp.adm(6), 'a1700000-0000-4000-8000-000000000002', pg_temp.patient(6), 'transferred',
  date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos' - interval '1 day' + interval '8 hours',
  'a1700100-0000-4000-8000-000000000001', pg_temp.member(1), pg_temp.ward('Female Medical Ward'), pg_temp.ward('ICU'),
  pg_temp.key('suite-move-p6'), pg_temp.sha('suite-move-p6');
alter table ehr.admission_movements enable trigger admission_movements_immutable;
select pg_temp.check_case('10 bed-days: three midnights', '3',
  (select commercial.accrue_bed_days(pg_temp.adm(6))::text from (select pg_temp.as_member(11)) ctx));
select pg_temp.check_case('10 the ward at each midnight sets the rate (two general, one ICU)', '3000000',
  (select sum(line.total_kobo)::text from commercial.bill_lines line join commercial.bills bill on bill.id = line.bill_id
       where bill.admission_id = pg_temp.adm(6) and line.origin = 'bed_day'));
select pg_temp.check_case('10 a second sweep adds none', '0',
  (select commercial.accrue_bed_days(pg_temp.adm(6))::text from (select pg_temp.as_member(11)) ctx));
select pg_temp.check_case('10 one charge per day', '3',
  (select count(*)::text from commercial.bed_day_charges where admission_id = pg_temp.adm(6)));
select pg_temp.check_case('10 the line name', 'true',
  (select bool_and(name ~ '^Bed-day: (Female Medical Ward|ICU) \([0-9]{1,2} [A-Z][a-z]{2} [0-9]{4}\)$')::text
     from commercial.bill_lines line join commercial.bills bill on bill.id = line.bill_id
    where bill.admission_id = pg_temp.adm(6) and line.origin = 'bed_day'));
set local role hid_ehr_api_runtime;
reset role;
select pg_temp.check_case('10 discharge with an unpaid admission bill succeeds', 'updated/discharged',
  (select pg_temp.o(answer) || '/' || (answer->'admission'->>'status')
     from (select pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'dama', null,
       '{"presentingProblem": "Flank pain (fictional)", "courseInHospital": "Left against advice (fictional)"}'::jsonb,
       null, null, 'SIGN', %L, %L)$s$, pg_temp.adm(6), pg_temp.adm_version(6), pg_temp.key('d-p6'),
       pg_temp.sha('d-p6'))) as answer) discharged));
select pg_temp.check_case('10 the bill stays open after discharge, with a balance', 'true/true',
  (select (due_kobo > 0)::text || '/' || (commercial.bill_json(id)->'admission'->>'dischargedWithBalance')
     from commercial.bills where admission_id = pg_temp.adm(6)));
select pg_temp.check_case('10 the bill agrees with its lines', 'true',
  (select commercial.bill_totals_agree(id)::text from (select pg_temp.as_member(11)) ctx, commercial.bills
    where admission_id = pg_temp.adm(6)));
select pg_temp.check_case('10 no admission function reads the commercial schema', '0',
  (select count(*)::text from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'ehr' and proc.proname like 'admission\_%' and proc.prosrc ~* 'commercial'));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('10 the interim statement: a number and the bill', 'true/true',
  (select ((answer->>'statementNumber') ~ '^I-[0-9]{4}-000001$')::text || '/' || ((answer->>'dueKobo')::bigint > 0)::text
     from pg_temp.run(11, format($s$select commercial.interim_statement(%L)$s$,
       pg_temp.bill_of(6)), 'healthcare-operations') answer));
select pg_temp.check_case('10 p7 is requested and given a bed (a second admission bill)', 'created/updated',
  pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
    'Fracture, awaiting surgery (fictional)', null, %L, null, null, %L, %L)$s$, pg_temp.patient(7), pg_temp.member(2),
    pg_temp.key('r-p7'), pg_temp.sha('r-p7'))))
  || '/' || pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$,
    pg_temp.adm(7), pg_temp.adm_version(7), pg_temp.bed('Male Medical Ward', 'Bed 3'), pg_temp.key('a-p7'),
    pg_temp.sha('a-p7')))));
select pg_temp.check_case('10 the cashier opens the till day', 'ok',
  (select case when answer ? 'error' then answer->>'error' else 'ok' end
     from pg_temp.run(10, $s$select commercial.day_open(null, 0, 'ward-suite-day-key-0001', repeat('1', 64))$s$,
       'healthcare-operations') answer));
select pg_temp.check_case('10 a deposit beyond what is due: the credit', 'ok/0/true',
  (select case when answer ? 'error' then answer->>'error' else 'ok' end || '/' || (answer->>'dueKobo') || '/'
          || ((answer->>'creditKobo')::bigint > 0)::text
     from pg_temp.run(10, format($s$select commercial.payment_record(%L,
       '{"method": "cash", "kind": "deposit", "amountKobo": 9000000}'::jsonb, null, 'ward-suite-dep-key-0001',
       repeat('2', 64))$s$, pg_temp.bill_of(7)),
       'healthcare-operations') answer));
select pg_temp.check_case('10 a payment beyond what is due is still refused', 'HB409 OVERPAYMENT',
  pg_temp.o(pg_temp.run(10, format($s$select commercial.payment_record(%L,
    '{"method": "cash", "amountKobo": 100}'::jsonb, null, 'ward-suite-pay-key-0001', repeat('3', 64))$s$,
    pg_temp.bill_of(7)), 'healthcare-operations')));
reset role;
select pg_temp.check_case('10 the credit is the admission bill''s own (BILL-1 bd427a88''s money over is for other bills): no refund due or cover over, the totals agree',
  'admission/0/0/true/true',
  (select bill.source || '/' || bill.refund_due_kobo || '/' || bill.cover_over_kobo || '/'
          || (bill.credit_kobo = bill.paid_kobo + bill.pending_check_kobo + bill.waived_kobo + bill.hmo_covered_kobo
                                 - bill.total_kobo and bill.credit_kobo > 0)::text || '/'
          || commercial.bill_totals_agree(bill.id)::text
     from commercial.bills bill where bill.id = pg_temp.bill_of(7)));
select pg_temp.check_case('10 BILL-1''s money-over CHECK, as 0172 leaves it, refuses a credit on any other bill', '23514',
  pg_temp.try($s$update commercial.bills set credit_kobo = 1
    where id = (select id from commercial.bills where source <> 'admission' limit 1)
       or id = (select id from commercial.bills where source = 'admission' and credit_kobo = 0 limit 1)$s$));
-- A facility with no payment settings gets no bill (B).
select pg_temp.check_case('10 no bill at a facility without billing', '0',
  (select count(*)::text from commercial.bills where facility_id = 'a1700000-0000-4000-8000-000000000012'));

-- 11. Census, other facilities, privileges.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('11 the census today: counts only, no patient', 'true/false',
  (select ((answer->'facility'->>'beds')::integer >= 8)::text || '/' || (answer::text like '%Wardperson%')::text
     from pg_temp.run(1, $s$select ehr.inpatient_census(null)$s$) answer));
select pg_temp.check_case('11 another facility''s doctor sees none of A''s admissions', 'not_found',
  pg_temp.o(pg_temp.run(7, format($s$select ehr.admission_read(%L)$s$, pg_temp.adm(4)))));
select pg_temp.check_case('11 the runtime cannot read the tables', '42501',
  pg_temp.try($s$select count(*) from ehr.admissions$s$));
select pg_temp.check_case('11 nor run the helpers', '42501',
  pg_temp.try($s$select ehr.admission_cards(array[]::uuid[], true)$s$));
select pg_temp.check_case('11 nor read the switches', '42501',
  pg_temp.try($s$select count(*) from ehr.inpatient_switches$s$));
select pg_temp.check_case('11 the admissions list', 'true',
  (select (jsonb_array_length(answer->'items') >= 3)::text from pg_temp.run(1, $s$select ehr.admission_list(null, null, null)$s$) answer));
select pg_temp.check_case('11 the ICU page: the ICU ward, its occupied beds, and who waits for it', 'found/1/true',
  (select pg_temp.o(answer) || '/' || jsonb_array_length(answer->'wards') || '/'
          || ((select count(*) from jsonb_array_elements(answer->'wards'->0->'beds') bed
                where jsonb_typeof(bed->'patient') = 'object') >= 1)::text
     from pg_temp.run(1, $s$select ehr.bed_board(null, 'icu')$s$) answer));
reset role;

-- 12. The waiting list and the emergency board (ED-1's 0168). p10 is requested from the waiting list, then put on
-- the board while waiting for a bed (its row gets an open ED record, as 0168's arrival from the waiting list leaves
-- it); 0168's guard now refuses any change of the row the board's marker does not name.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('12 p10 requested from the waiting list (no board row yet)', 'created/waiting_list',
  (select pg_temp.o(answer) || '/' || (answer->'admission'->>'source')
     from pg_temp.run(2, format($s$select ehr.admission_request(%L, 'waiting_list', null, null, %L,
       'Sickle cell crisis (fictional)', null, %L, %L, null, %L, %L)$s$, pg_temp.patient(10),
       'a1700900-0000-4000-8000-000000000010', pg_temp.member(2), pg_temp.ward('ICU'), pg_temp.key('r-p10'),
       pg_temp.sha('r-p10'))) answer));
reset role;
insert into ehr.ed_attendances (id, facility_id, organization_id, patient_id, visit_queue_entry_id, arrival_basis,
  arrival_mode, arrived_at, arrival_day, moved_from_waiting_list, moved_from_stage, moved_from_stage_changed_at, status,
  arrived_by_account_id, arrived_by_membership_id, updated_by_membership_id)
values ('a1700a00-0000-4000-8000-000000000010', 'a1700000-0000-4000-8000-000000000002',
  'a1700000-0000-4000-8000-000000000001', 'a1700400-0000-4000-8000-000000000010', 'a1700900-0000-4000-8000-000000000010',
  'own_facility', 'walk_in', now(), (now() at time zone 'Africa/Lagos')::date, true, 'waiting',
  now() - interval '10 minutes', 'open', 'a1700100-0000-4000-8000-000000000001',
  'a1700300-0000-4000-8000-000000000001', 'a1700300-0000-4000-8000-000000000001');
select pg_temp.check_case('12 the guard refuses an unmarked change of p10''s board row', '55000',
  pg_temp.try($s$update ehr.visit_queue set stage = 'finished', closed_at = clock_timestamp()
    where id = 'a1700900-0000-4000-8000-000000000010'$s$));
select pg_temp.check_case('12 a marker naming the ED record (not the row) opens nothing', '55000',
  pg_temp.try($s$update ehr.visit_queue set stage = 'finished', closed_at = clock_timestamp()
    where id = 'a1700900-0000-4000-8000-000000000010'
      and set_config('hid.ed_board_closing', 'a1700a00-0000-4000-8000-000000000010', true) is not null$s$));
select pg_temp.check_case('12 a marker naming another row opens nothing', '55000',
  pg_temp.try($s$update ehr.visit_queue set stage = 'ready'
    where id = 'a1700900-0000-4000-8000-000000000010'
      and set_config('hid.ed_board_closing', 'a1700900-0000-4000-8000-000000000009', true) is not null$s$));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('12 nurse 8 (no chart grant) admits p10 from the waiting list while on the board',
  'updated/admitted/ICU/ICU Bed 2/in_progress',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.admission_admit(%L, %s, %L, false, %L, %L)$s$, pg_temp.adm(10),
    pg_temp.adm_version(10), pg_temp.bed('ICU', 'ICU Bed 2'), pg_temp.key('a-p10'), pg_temp.sha('a-p10'))))
  || '/' || pg_temp.adm_state(10));
reset role;
select pg_temp.check_case('12 p10''s row finished and its ED record closed via admission, versions raised',
  'finished/true/closed/admission/true/2/2',
  (select entry.stage || '/' || (entry.closed_at is not null)::text || '/' || attendance.status || '/'
          || attendance.closed_via || '/' || (attendance.left_at = entry.closed_at)::text || '/' || entry.row_version
          || '/' || attendance.row_version
     from ehr.ed_attendances attendance join ehr.visit_queue entry on entry.id = attendance.visit_queue_entry_id
    where attendance.id = 'a1700a00-0000-4000-8000-000000000010'));
select pg_temp.check_case('12 one admitted event (waiting to finished, the admit''s key), no mirrored close',
  '1/waiting/finished/true/0',
  (select count(*) filter (where event.kind = 'admitted') || '/'
          || max(event.from_stage) filter (where event.kind = 'admitted') || '/'
          || max(event.to_stage) filter (where event.kind = 'admitted') || '/'
          || (max(event.idempotency_key) filter (where event.kind = 'admitted') = pg_temp.key('a-p10'))::text || '/'
          || count(*) filter (where event.kind = 'closed_on_waiting_list')
     from ehr.ed_attendance_events event where event.attendance_id = 'a1700a00-0000-4000-8000-000000000010'));
select pg_temp.check_case('12 the mirror wrote no audit row for p10', '0',
  (select count(*)::text from audit.events
    where action = 'ehr.ed.closed-on-waiting-list' and patient_id = pg_temp.patient(10)));
select pg_temp.check_case('12 the marker is cleared after the admission', '(empty)',
  coalesce(nullif(current_setting('hid.ed_board_closing', true), ''), '(empty)'));
select pg_temp.check_case('12 without a board row (p4, section 3): its row finished and no ED record was made', 'finished/true/0',
  pg_temp.queue_state('a1700900-0000-4000-8000-000000000004') || '/'
  || (select count(*) from ehr.ed_attendances where visit_queue_entry_id = 'a1700900-0000-4000-8000-000000000004'));
select pg_temp.check_case('12 the guard still refuses an unmarked change of p9''s board row (stage, close, triage)',
  '55000/55000/55000/waiting/false/false/1',
  pg_temp.try($s$update ehr.visit_queue set stage = 'ready' where id = 'a1700900-0000-4000-8000-000000000009'$s$)
  || '/' || pg_temp.try($s$update ehr.visit_queue set stage = 'finished', closed_at = clock_timestamp()
    where id = 'a1700900-0000-4000-8000-000000000009'$s$)
  || '/' || pg_temp.try($s$update ehr.visit_queue set triage_level = 2 where id = 'a1700900-0000-4000-8000-000000000009'$s$)
  || '/' || pg_temp.queue_state('a1700900-0000-4000-8000-000000000009')
  || '/' || (select status <> 'open' from ehr.ed_attendances where id = 'a1700a00-0000-4000-8000-000000000009')::text
  || '/' || (select row_version from ehr.visit_queue where id = 'a1700900-0000-4000-8000-000000000009'));

-- 13. Audit.
select pg_temp.check_case('13 every board and list read has a collection row and a row per patient shown', 'true',
  (select (count(*) filter (where action = 'ehr.bed-board.shown')
           = coalesce(sum((details->>'resultCount')::integer) filter (where action = 'ehr.bed-board'), 0))::text
     from audit.events where action in ('ehr.bed-board', 'ehr.bed-board.shown')
       and facility_id = 'a1700000-0000-4000-8000-000000000002'));
select pg_temp.check_case('13 a sex mismatch confirmation is audited', '1',
  (select count(*)::text from audit.events where action = 'ehr.admission.sex-mismatch-confirmed'));
select pg_temp.check_case('13 no name, date of birth, Health ID, reason, handover, summary or cause in an inpatient audit row', '0',
  (select count(*)::text from audit.events
    where (action like 'ehr.ward%' or action like 'ehr.bed%' or action like 'ehr.admission%' or action like 'ehr.census%'
           or action like 'ehr.discharge%' or action like 'ehr.wristband%' or action like 'ehr.newborn%'
           or action like 'ehr.death-record%' or action like 'identity.ward-stay%' or action like 'commercial.bed-day%')
      and (details::text ~* 'wardperson|ngozi|dami|HID-WD|19[78][0-9]-|pneumonia|malaria|cellulitis|oxygen|cough|antibiotic|head injury|traffic|another hospital|fictional'
           or coalesce(reason, '') <> '')));
select pg_temp.check_case('13 every write was audited', 'true',
  (select (count(*) > 40)::text from audit.events where action like 'ehr.admission.%' or action like 'ehr.ward.%'
     or action like 'ehr.bed.%'));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.w_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0170-0173 inpatient ADT:\n%', mismatch;
  end if;
  raise notice '0170-0173 inpatient ADT: % cases passed', (select count(*) from pg_temp.w_outcomes);
end $$;

rollback;
