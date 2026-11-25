\set ON_ERROR_STOP on
-- 0197 and 0198 (QUAL-1, Release D; owner decisions Q248 A-Q253 A of 25
-- November 2026, built at the recommended options Q-QUAL-1 A to Q-QUAL-8 A,
-- not yet answered by the owner): quality and safety reporting, incidents and
-- near misses. Rollback-only. The quality functions run as ehr-api's login
-- role (hid_ehr_api_runtime), in the context its transactions set (purpose
-- healthcare-operations). Needs 0001-0153 with 0197 and 0198 applied and the
-- runtime roles bootstrapped. Fictional people, places and identifiers only;
-- ids start e197.
--
--   1. route 2's field rules: the time window (up to a year ago, up to 2
--      minutes ahead taken as now), the place (a department of this
--      facility's profile, a place in words, or both), the lists (category and
--      harm level of the active list), "patient or family told" for moderate
--      harm, severe harm and death, the text rules; the incident number per
--      facility;
--   2. who sees what: the reporter, a manager by role (admin, org_admin),
--      another member, another facility's member; a member without the code,
--      a held membership, an inactive one, another purpose; route 1 for each;
--   3. the patient link: off (not available, nothing saved), then on: each
--      basis (registered_here, created_here for an unknown record made here,
--      recent_visit, recent_check_in) and each refusal (a visit or check-in
--      91 days ago, a cancelled visit or check-in, a sealed demo patient here,
--      an inactive patient, a stranger, another facility's patient), all the
--      same answer, none saved; sealed demo and QA isolation both ways; the manager
--      sees the patient, the reporter and reviewer only that one is linked;
--   4. the workflow: assign, reassign (the earlier reviewer loses sight), the
--      same reviewer, invalid reviewers; investigation and amendment;
--      actions (add, owner and due date rules, done, back to open, cancel
--      with a note, overdue, the limit of 20, another incident's action);
--      resolve refused with open actions, resolve; every write refused while
--      resolved; the reporter's view of a resolved incident; reopen;
--   5. corrections (manager): category, harm level with the told rule,
--      department and place with the place rule, the patient link set,
--      changed, refused and cleared (cleared while the switch is off); the
--      report as filed unchanged;
--   6. the guards: history and list items append only; no delete or truncate
--      on any of the seven tables; the report as filed, the row version step,
--      an action's fixed fields and a lead's end once;
--   7. idempotent replays, a reused key and version conflicts;
--   8. the monthly counts at the Lagos month's edges, another facility's
--      incidents left out, the month rules;
--   9. quality leads: name, a lead's manager rights (and no naming), exists,
--      invalid members, the limit of 10, end (rights lost at once), ended,
--      another facility's lead, a replay;
--  10. audit: every row healthcare-operations as the staff member; no text,
--      place in words, reason, name, date of birth or Health ID in any quality
--      audit row; refused links name no patient;
--  11. row-level security and privileges: the runtimes cannot read the seven
--      tables or call the helpers; forced on all seven; the owner sees only
--      the session facility's rows.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.
begin;

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('healthcare-operations', 'Healthcare operations', 'quality-test')
  on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1970000-0000-4000-8000-000000000001', 'Quality Group A', 'quality-group-a'),
  ('e1970000-0000-4000-8000-000000000011', 'Quality Group B', 'quality-group-b'),
  ('e1970000-0000-4000-8000-000000000021', 'Quality Demo Group', 'quality-demo-group'),
  ('e1970000-0000-4000-8000-000000000031', 'Quality QA Group', 'quality-qa-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'Quality Clinic A',
   'QUALITY-A', 'Africa/Lagos', true, 'verified'),
  ('e1970000-0000-4000-8000-000000000012', 'e1970000-0000-4000-8000-000000000011', 'Quality Clinic B',
   'QUALITY-B', 'Africa/Lagos', true, 'verified'),
  ('e1970000-0000-4000-8000-000000000022', 'e1970000-0000-4000-8000-000000000021', 'Quality Demo Clinic',
   'QUALITY-D', 'Africa/Lagos', true, 'verified'),
  ('e1970000-0000-4000-8000-000000000032', 'e1970000-0000-4000-8000-000000000031', 'Quality QA Clinic',
   'QUALITY-Q', 'Africa/Lagos', true, 'verified');
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('facility', 'e1970000-0000-4000-8000-000000000032');
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('facility', 'e1970000-0000-4000-8000-000000000022');
create temporary table q_members (n integer primary key, facility uuid, organization uuid, role_code text, name text,
  active boolean default true, hold text) on commit drop;
insert into q_members (n, facility, organization, role_code, name, active, hold) values
  (1, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'receptionist', 'Ada Desk', true, null),
  (2, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'nurse', 'Bola Nurse', true, null),
  (3, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'doctor', 'Chidi Doctor', true, null),
  (4, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'admin', 'Dupe Admin', true, null),
  (5, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'lab', 'Efe Lab', true, null),
  (6, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'pharmacist', 'Femi Pharmacist', true, null),
  (7, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'org_admin', 'Gbenga Owner', true, null),
  (8, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'doctor', 'Hauwa Doctor', true, null),
  (9, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'clinician', 'Ife Clinician', true, null),
  (10, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'nurse', 'Jide Heldnurse', true,
   'Held for the cutover (fictional)'),
  (11, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'work_list_reader', 'Kemi Reader', true, null),
  (12, 'e1970000-0000-4000-8000-000000000012', 'e1970000-0000-4000-8000-000000000011', 'doctor', 'Lola Doctorb', true, null),
  (13, 'e1970000-0000-4000-8000-000000000012', 'e1970000-0000-4000-8000-000000000011', 'admin', 'Musa Adminb', true, null),
  (14, 'e1970000-0000-4000-8000-000000000022', 'e1970000-0000-4000-8000-000000000021', 'admin', 'Nneka Demoadmin', true, null),
  (15, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'nurse', 'Ola Formernurse', false, null),
  (16, 'e1970000-0000-4000-8000-000000000032', 'e1970000-0000-4000-8000-000000000031', 'admin', 'Pelumi Qaadmin', true, null);
insert into q_members (n, facility, organization, role_code, name)
select n, 'e1970000-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000001', 'nurse', 'Nurse Lead' || n
  from generate_series(20, 30) n;
insert into identity.sealed_demo_members (member_kind, member_id)
select 'account', ('e1970100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid from q_members where n = 14;
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1970100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:qual-member-' || n,
  'qual-member-' || n || '@example.invalid', name, 'active' from q_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1970200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1970100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'qual-member-' || n || '@example.invalid', 'verified', role_code from q_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active, migration_hold_reason)
select ('e1970300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1970200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1970100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, organization, facility, role_code, role_code,
  true, active, hold
from q_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('e1970100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
  ('e1970300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, facility, 'Synthetic quality suite role'
from q_members;

-- Patients (Health IDs HID-QL + two letters): p1 registered at A's desk; p2 an unknown record made at A; p3 a visit
-- at A 30 days ago; p4 a check-in at A 20 days ago; p5 a visit at A 91 days ago; p6 a check-in at A 91 days ago; p7
-- a sealed demo patient registered at A; p8 inactive, registered at A; p9 a stranger; p10 registered at B; p11 a
-- sealed demo patient registered at the demo clinic; p12 a cancelled check-in at A 5 days ago; p13 a cancelled
-- visit at A 5 days ago.
create temporary table q_patients (n integer primary key, hid text, first text, last text, sex text, status text,
  source text) on commit drop;
insert into q_patients values
  (1, 'HID-QLAA22', 'Amaka', 'Qualone', 'female', 'active', 'hid-desk-registration'),
  (3, 'HID-QLAC22', 'Chika', 'Qualthree', 'female', 'active', 'hid'),
  (4, 'HID-QLAD22', 'Dayo', 'Qualfour', 'male', 'active', 'hid'),
  (5, 'HID-QLAE22', 'Ebere', 'Qualfive', 'female', 'active', 'hid'),
  (6, 'HID-QLAF22', 'Femi', 'Qualsix', 'male', 'active', 'hid'),
  (7, 'HID-QLAG22', 'Gozie', 'Qualseven', 'male', 'active', 'hid-desk-registration'),
  (8, 'HID-QLAH22', 'Halima', 'Qualeight', 'female', 'inactive', 'hid-desk-registration'),
  (9, 'HID-QLAJ22', 'Jide', 'Qualnine', 'male', 'active', 'hid'),
  (10, 'HID-QLAK22', 'Kemi', 'Qualten', 'female', 'active', 'hid-desk-registration'),
  (11, 'HID-QLAL22', 'Lami', 'Qualeleven', 'female', 'active', 'hid-desk-registration'),
  (12, 'HID-QLAM22', 'Musa', 'Qualtwelve', 'male', 'active', 'hid'),
  (13, 'HID-QLAN22', 'Ngozi', 'Qualthirteen', 'female', 'active', 'hid'),
  (14, 'HID-QLAP22', 'Ope', 'Qualfourteen', 'male', 'active', 'hid-desk-registration');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
select ('e1970400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, hid, first, last, first || ' ' || last,
  sex, date '1980-01-01' + n, status, source from q_patients;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
values ('e1970400-0000-4000-8000-000000000002', 'HID-QLAB22', 'Unknown', 'U-0007', 'Unknown patient U-0007', 'male',
  date '1986-01-01', 'active', 'hid-unknown-patient');
insert into identity.unknown_patients (patient_id, facility_id, label_number, unknown_reason, created_by_account_id,
  created_by_membership_id, idempotency_key, request_sha256)
values ('e1970400-0000-4000-8000-000000000002', 'e1970000-0000-4000-8000-000000000002', 7, 'unconscious',
  'e1970100-0000-4000-8000-000000000001', 'e1970300-0000-4000-8000-000000000001', 'qual-unknown-key-0007',
  repeat('0', 64));
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('patient', 'e1970400-0000-4000-8000-000000000007'), ('patient', 'e1970400-0000-4000-8000-000000000011');
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('patient', 'e1970400-0000-4000-8000-000000000014');
-- Registered without a NIN (0130), which created the record: p1, p7, p8 at A; p10 at B; p11 at the demo clinic;
-- p14 at the QA clinic.
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, idempotency_key, request_sha256,
  resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id,
  review_reason, created_at, updated_at)
select ('e1970500-0000-4000-8000-0000000000' || lpad(patient.n::text, 2, '0'))::uuid, member.facility,
  ('e1970100-0000-4000-8000-0000000000' || lpad(member.n::text, 2, '0'))::uuid,
  ('e1970300-0000-4000-8000-0000000000' || lpad(member.n::text, 2, '0'))::uuid, 'approved_new_identity',
  patient.first, patient.last, patient.first || ' ' || patient.last, date '1980-01-01' + patient.n, 'none', 'no_nin',
  'qual-case-key-00000' || lpad(patient.n::text, 2, '0'), repeat('0', 64),
  ('e1970400-0000-4000-8000-0000000000' || lpad(patient.n::text, 2, '0'))::uuid,
  'qual-review-key-0000' || lpad(patient.n::text, 2, '0'), repeat('0', 64),
  ('e1970100-0000-4000-8000-0000000000' || lpad(member.n::text, 2, '0'))::uuid,
  ('e1970300-0000-4000-8000-0000000000' || lpad(member.n::text, 2, '0'))::uuid, 'Checked at the desk',
  clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days'
from q_patients patient
join q_members member on member.n = case patient.n when 10 then 12 when 11 then 14 when 14 then 16 else 1 end
where patient.n in (1, 7, 8, 10, 11, 14);
-- Visits at A (no grant, so not 0131's visit_here): p3 30 days ago, p5 91 days ago, p13 5 days ago and cancelled.
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, chief_complaint, created_at) values
  ('e1970800-0000-4000-8000-000000000003', 'e1970400-0000-4000-8000-000000000003', 'e1970000-0000-4000-8000-000000000002',
   'e1970100-0000-4000-8000-000000000003', 'e1970300-0000-4000-8000-000000000003', 'ambulatory', 'in_progress',
   clock_timestamp() - interval '30 days', 'Fixture visit', clock_timestamp() - interval '30 days'),
  ('e1970800-0000-4000-8000-000000000005', 'e1970400-0000-4000-8000-000000000005', 'e1970000-0000-4000-8000-000000000002',
   'e1970100-0000-4000-8000-000000000003', 'e1970300-0000-4000-8000-000000000003', 'ambulatory', 'in_progress',
   clock_timestamp() - interval '91 days', 'Fixture old visit', clock_timestamp() - interval '91 days'),
  ('e1970800-0000-4000-8000-000000000013', 'e1970400-0000-4000-8000-000000000013', 'e1970000-0000-4000-8000-000000000002',
   'e1970100-0000-4000-8000-000000000003', 'e1970300-0000-4000-8000-000000000003', 'ambulatory', 'cancelled',
   clock_timestamp() - interval '5 days', 'Fixture cancelled visit', clock_timestamp() - interval '5 days');
-- Waiting-list check-ins at A: p4 20 days ago (finished), p6 91 days ago (finished), p12 5 days ago (cancelled).
insert into ehr.visit_queue (facility_id, patient_id, queue_day, stage, check_in_basis, checked_in_by_account_id,
  checked_in_by_membership_id, checked_in_at, stage_changed_at, closed_at, updated_by_membership_id, updated_at)
select 'e1970000-0000-4000-8000-000000000002', ('e1970400-0000-4000-8000-0000000000' || lpad(entry.n::text, 2, '0'))::uuid,
  ((clock_timestamp() - entry.ago) at time zone 'Africa/Lagos')::date, entry.stage, 'search',
  'e1970100-0000-4000-8000-000000000001', 'e1970300-0000-4000-8000-000000000001', clock_timestamp() - entry.ago,
  clock_timestamp() - entry.ago, clock_timestamp() - entry.ago, 'e1970300-0000-4000-8000-000000000001',
  clock_timestamp() - entry.ago
from (values (4, interval '20 days', 'finished'), (6, interval '91 days', 'finished'),
             (12, interval '5 days', 'cancelled')) entry(n, ago, stage);
-- A's profile departments (0114 codes): no dental here. B and the demo clinic have no profile (all fifteen).
insert into identity.facility_profiles (facility_id, trading_name, ownership, care_level, address_line, city, state_code,
  lga, gps_latitude, gps_longitude, phone_e164, email, bed_count, operating_hours, emergency_24h, departments,
  services_offered, smoh_licence_number, has_registry_id, has_nhia_accreditation, medical_director_name,
  medical_director_mdcn, expected_staff, migrating_records, needs_interoperability, source)
values ('e1970000-0000-4000-8000-000000000002', 'Quality Clinic A', 'private', 'secondary', '1 Synthetic Road', 'Ikeja',
  'LA', 'Ikeja', 6.6, 3.35, '+2348000000001', 'quality-a@example.invalid', 20, '24 hours', true,
  array['general_outpatient', 'emergency', 'pharmacy', 'inpatient'], 'Fictional services', 'SYN-LIC-1', false, false,
  'Synthetic Director', 'SYN-MDCN-1', 10, false, false, 'facility_administrator');
set local session_replication_role = origin;

create temporary table q_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
create temporary table q_results (seq serial, name text primary key, result jsonb) on commit drop;
-- (Section 11 also runs as the tables' owner, so these rollback-only tables are open to every role.)
grant select, insert, update on pg_temp.q_outcomes, pg_temp.q_results to public;
grant usage on sequence pg_temp.q_outcomes_seq_seq, pg_temp.q_results_seq_seq to public;
grant select on pg_temp.q_members to public;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.q_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.member(n integer) returns uuid language sql immutable as $f$
  select ('e1970300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.patient(n integer) returns uuid language sql immutable as $f$
  select ('e1970400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.short(value text) returns text language sql immutable as $f$
  select case when value is null then '-' else right(value, 2) end
$f$;
create function pg_temp.as_member(n integer, purpose text default 'healthcare-operations') returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:qual-member-' || n, true),
    set_config('app.membership_id', pg_temp.member(n)::text, true),
    set_config('app.facility_id', (select facility::text from pg_temp.q_members where q_members.n = as_member.n), true),
    set_config('app.correlation_id', 'qual-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;
create function pg_temp.key(label text) returns text language sql immutable as $f$
  select 'qual-suite-key-' || label
$f$;
create function pg_temp.sha(label text) returns text language sql immutable as $f$
  select encode(sha256(convert_to(label, 'UTF8')), 'hex')
$f$;
create function pg_temp.keep(label text, result jsonb) returns text language plpgsql as $f$
begin
  insert into pg_temp.q_results (name, result) values (label, result)
    on conflict (name) do update set result = excluded.result;
  return coalesce(result ->> 'error', result ->> 'outcome');
end
$f$;
create function pg_temp.res(label text) returns jsonb language sql as $f$
  select result from pg_temp.q_results where name = label
$f$;
create function pg_temp.card(label text) returns jsonb language sql as $f$
  select result -> 'body' -> 'incident' from pg_temp.q_results where name = label
$f$;
create function pg_temp.inc(label text) returns uuid language sql as $f$
  select (result -> 'body' -> 'incident' ->> 'incidentId')::uuid from pg_temp.q_results where name = label
$f$;
-- (The suite's own lookups read the tables as the suite's owner, not as a runtime.)
create function pg_temp.cur_ver(incident uuid) returns bigint language sql security definer as $f$
  select row_version from ehr.quality_incidents where id = incident
$f$;
create function pg_temp.count_at(facility_n integer) returns bigint language sql security definer as $f$
  select count(*) from ehr.quality_incidents
   where facility_id = (select facility from pg_temp.q_members where n = facility_n)
$f$;

create function pg_temp.w_me(label text, n integer, purpose text default 'healthcare-operations') returns text
language plpgsql as $f$
begin
  perform pg_temp.as_member(n, purpose);
  return pg_temp.keep(label, jsonb_build_object('outcome', 'ok', 'body', ehr.quality_me()));
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_report(label text, n integer, title text, occurred timestamptz, dept text, place text,
  category text, harm text, told text default null, patient integer default null,
  description text default 'Fictional: what happened, in enough words.', immediate text default null,
  key_label text default null, sha_label text default null, purpose text default 'healthcare-operations')
returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n, purpose);
  select to_jsonb(row_value) into answer
    from ehr.quality_incident_report(title, description, occurred, dept, place, category, harm, immediate, told,
      case when patient is null then null else pg_temp.patient(patient) end, pg_temp.key(coalesce(key_label, label)),
      pg_temp.sha(coalesce(sha_label, label))) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_read(label text, n integer, incident uuid) returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  select to_jsonb(row_value) into answer from ehr.quality_incident_read(incident) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_list(label text, n integer, status text default null, category text default null,
  harm text default null, dept text default null, occurred_from date default null, occurred_to date default null,
  mine text default null, page integer default null, cursor_at timestamptz default null, cursor_id uuid default null)
returns text language plpgsql as $f$
begin
  perform pg_temp.as_member(n);
  return pg_temp.keep(label, jsonb_build_object('outcome', 'ok', 'body',
    ehr.quality_incident_list(status, category, harm, dept, occurred_from, occurred_to, mine, page, cursor_at,
      cursor_id)));
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_assign(label text, n integer, incident uuid, reviewer integer, version bigint default null,
  key_label text default null, sha_label text default null) returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  select to_jsonb(row_value) into answer
    from ehr.quality_incident_assign(incident, coalesce(version, pg_temp.cur_ver(incident)),
      case when reviewer is null then null else pg_temp.member(reviewer) end, pg_temp.key(coalesce(key_label, label)),
      pg_temp.sha(coalesce(sha_label, label))) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_investigate(label text, n integer, incident uuid, findings text, version bigint default null)
returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  select to_jsonb(row_value) into answer
    from ehr.quality_incident_investigate(incident, coalesce(version, pg_temp.cur_ver(incident)), findings,
      pg_temp.key(label), pg_temp.sha(label)) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_action_add(label text, n integer, incident uuid, description text, owner_n integer,
  due date, version bigint default null) returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  select to_jsonb(row_value) into answer
    from ehr.quality_incident_action_add(incident, coalesce(version, pg_temp.cur_ver(incident)), description,
      pg_temp.member(owner_n), due, pg_temp.key(label), pg_temp.sha(label)) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_action_update(label text, n integer, incident uuid, action uuid, status text,
  note text default null, owner_n integer default null, due date default null, version bigint default null)
returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  select to_jsonb(row_value) into answer
    from ehr.quality_incident_action_update(incident, action, coalesce(version, pg_temp.cur_ver(incident)), status,
      note, case when owner_n is null then null else pg_temp.member(owner_n) end, due, pg_temp.key(label),
      pg_temp.sha(label)) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_resolve(label text, n integer, incident uuid, resolution text, version bigint default null)
returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  select to_jsonb(row_value) into answer
    from ehr.quality_incident_resolve(incident, coalesce(version, pg_temp.cur_ver(incident)), resolution,
      pg_temp.key(label), pg_temp.sha(label)) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_reopen(label text, n integer, incident uuid, reason text, version bigint default null)
returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  select to_jsonb(row_value) into answer
    from ehr.quality_incident_reopen(incident, coalesce(version, pg_temp.cur_ver(incident)), reason,
      pg_temp.key(label), pg_temp.sha(label)) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_correct(label text, n integer, incident uuid, reason text, fields text[],
  category text default null, harm text default null, dept text default null, place text default null,
  told text default null, patient integer default null, version bigint default null) returns text
language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  select to_jsonb(row_value) into answer
    from ehr.quality_incident_correct(incident, coalesce(version, pg_temp.cur_ver(incident)), reason, fields,
      category, harm, dept, place, told, case when patient is null then null else pg_temp.patient(patient) end,
      pg_temp.key(label), pg_temp.sha(label)) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_counts(label text, n integer, month text, format text default 'json') returns text
language plpgsql as $f$
begin
  perform pg_temp.as_member(n);
  return pg_temp.keep(label, jsonb_build_object('outcome', 'ok', 'body', ehr.quality_incident_counts(month, format)));
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_lead_list(label text, n integer) returns text language plpgsql as $f$
begin
  perform pg_temp.as_member(n);
  return pg_temp.keep(label, jsonb_build_object('outcome', 'ok', 'body', ehr.quality_lead_list()));
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_lead_name(label text, n integer, lead_n integer) returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  select to_jsonb(row_value) into answer
    from ehr.quality_lead_name(pg_temp.member(lead_n), pg_temp.key(label), pg_temp.sha(label)) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
create function pg_temp.w_lead_end(label text, n integer, lead uuid, reason text) returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  select to_jsonb(row_value) into answer
    from ehr.quality_lead_end(lead, reason, pg_temp.key(label), pg_temp.sha(label)) row_value;
  return pg_temp.keep(label, answer);
exception when others then
  return pg_temp.keep(label, jsonb_build_object('error', sqlstate || ' ' || sqlerrm));
end
$f$;
-- A guard: the SQL raises with this message, or 'allowed'.
create function pg_temp.refused(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'allowed';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

-- 1. Route 2's field rules (Ada, front desk, at A).
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 a report: ok', 'ok', pg_temp.w_report('r-ok', 1, 'Wet floor near pharmacy (fictional)',
  clock_timestamp() - interval '1 hour', 'pharmacy', 'Corridor B', 'facility_environment', 'near_miss'));
select pg_temp.check_case('1 the reporter''s card',
  'reporter/1/reported/true/-/false/false/-/QS-DRAFT-1/true',
  concat_ws('/', pg_temp.card('r-ok') ->> 'view', pg_temp.card('r-ok') ->> 'incidentNumber',
    pg_temp.card('r-ok') ->> 'status', pg_temp.card('r-ok') ->> 'reportedByMe',
    pg_temp.short(pg_temp.card('r-ok') ->> 'reporterMembershipId'), pg_temp.card('r-ok') ->> 'reporterHidden',
    pg_temp.card('r-ok') ->> 'patientLinked', coalesce(pg_temp.card('r-ok') ->> 'openActions', '-'),
    pg_temp.card('r-ok') ->> 'listVersion',
    ((pg_temp.card('r-ok') ->> 'occurredDay')
     = to_char(((clock_timestamp() - interval '1 hour') at time zone 'Africa/Lagos')::date, 'YYYY-MM-DD'))::text));
select pg_temp.check_case('1 the reporter''s history: reported only, no actor', 'reported/-/reported/1',
  concat_ws('/', pg_temp.res('r-ok') -> 'body' -> 'history' -> 0 ->> 'kind',
    coalesce(pg_temp.res('r-ok') -> 'body' -> 'history' -> 0 ->> 'byMembershipId', '-'),
    pg_temp.res('r-ok') -> 'body' -> 'history' -> 0 ->> 'toStatus',
    jsonb_array_length(pg_temp.res('r-ok') -> 'body' -> 'history')));
select pg_temp.check_case('1 more than 2 minutes ahead', '22023 QUALITY_TIME_INVALID', pg_temp.w_report('r-future', 1,
  'Future report (fictional)', clock_timestamp() + interval '5 minutes', 'pharmacy', null, 'other', 'no_harm'));
select pg_temp.check_case('1 up to 2 minutes ahead is taken as now', 'ok/true', pg_temp.w_report('r-soon', 1,
  'Clock difference (fictional)', clock_timestamp() + interval '1 minute', 'pharmacy', null, 'other', 'no_harm')
  || '/' || ((pg_temp.card('r-soon') ->> 'occurredAt') <= (pg_temp.card('r-soon') ->> 'reportedAt'))::text);
select pg_temp.check_case('1 more than a year ago', '22023 QUALITY_TIME_INVALID', pg_temp.w_report('r-old', 1,
  'Old report (fictional)', clock_timestamp() - interval '366 days', 'pharmacy', null, 'other', 'no_harm'));
select pg_temp.check_case('1 just under a year ago', 'ok', pg_temp.w_report('r-year', 1, 'Year-old report (fictional)',
  clock_timestamp() - interval '364 days', 'pharmacy', null, 'other', 'no_harm'));
select pg_temp.check_case('1 no place', '22023 QUALITY_LOCATION_REQUIRED', pg_temp.w_report('r-noplace', 1,
  'Nowhere (fictional)', clock_timestamp() - interval '1 hour', null, null, 'other', 'no_harm'));
select pg_temp.check_case('1 a place in words only', 'ok/-/Car park', pg_temp.w_report('r-place', 1,
  'Car park fall (fictional)', clock_timestamp() - interval '1 hour', null, '  Car park ', 'patient_fall', 'mild')
  || '/' || coalesce(pg_temp.card('r-place') ->> 'departmentCode', '-') || '/' || (pg_temp.card('r-place') ->> 'locationText'));
select pg_temp.check_case('1 a department this facility''s profile does not list', '22023 QUALITY_DEPARTMENT_INVALID',
  pg_temp.w_report('r-dental', 1, 'Dental (fictional)', clock_timestamp() - interval '1 hour', 'dental', null, 'other',
    'no_harm'));
select pg_temp.check_case('1 a category not in the list', '22023 QUALITY_CATEGORY_INVALID', pg_temp.w_report('r-cat', 1,
  'Category (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null, 'falls', 'no_harm'));
select pg_temp.check_case('1 a harm level not in the list', '22023 QUALITY_HARM_LEVEL_INVALID', pg_temp.w_report('r-harm',
  1, 'Harm (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null, 'other', 'catastrophic'));
select pg_temp.check_case('1 moderate harm without "told"', '22023 QUALITY_TOLD_REQUIRED', pg_temp.w_report('r-modno', 1,
  'Moderate (fictional)', clock_timestamp() - interval '1 hour', 'emergency', null, 'medication', 'moderate'));
select pg_temp.check_case('1 severe harm without "told"', '22023 QUALITY_TOLD_REQUIRED', pg_temp.w_report('r-sevno', 1,
  'Severe (fictional)', clock_timestamp() - interval '1 hour', 'emergency', null, 'medication', 'severe'));
select pg_temp.check_case('1 moderate harm with "told"', 'ok/yes', pg_temp.w_report('r-mod', 1,
  'Wrong strength dispensed (fictional)', clock_timestamp() - interval '2 hours', 'emergency', null, 'medication',
  'moderate', 'yes') || '/' || (pg_temp.card('r-mod') ->> 'patientOrFamilyTold'));
select pg_temp.check_case('1 death with "not applicable"', 'ok', pg_temp.w_report('r-death', 1, 'Death (fictional)',
  clock_timestamp() - interval '3 hours', 'inpatient', null, 'procedure_treatment', 'death', 'not_applicable'));
select pg_temp.check_case('1 near miss with "told" given is kept', 'ok/no', pg_temp.w_report('r-nmtold', 1,
  'Near miss told (fictional)', clock_timestamp() - interval '3 hours', 'inpatient', null, 'equipment_device',
  'near_miss', 'no') || '/' || (pg_temp.card('r-nmtold') ->> 'patientOrFamilyTold'));
select pg_temp.check_case('1 "told" outside the three answers', '22023 QUALITY_INVALID', pg_temp.w_report('r-toldbad', 1,
  'Told (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null, 'other', 'no_harm', 'maybe'));
select pg_temp.check_case('1 a title of 2 characters', '22023 QUALITY_INVALID', pg_temp.w_report('r-short', 1, 'ab',
  clock_timestamp() - interval '1 hour', 'pharmacy', null, 'other', 'no_harm'));
select pg_temp.check_case('1 a title with a control character', '22023 QUALITY_INVALID', pg_temp.w_report('r-ctrl', 1,
  E'Bad\x01title', clock_timestamp() - interval '1 hour', 'pharmacy', null, 'other', 'no_harm'));
select pg_temp.check_case('1 what happened in 9 characters', '22023 QUALITY_INVALID', pg_temp.w_report('r-desc', 1,
  'Short text (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null, 'other', 'no_harm', null, null,
  'Too short'));
select pg_temp.check_case('1 what happened on several lines, and the immediate action', 'ok/true/Area closed off',
  pg_temp.w_report('r-lines', 1, 'Lines (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null,
    'infection_control', 'no_harm', null, null, E'First line of what happened.\nSecond line.', 'Area closed off')
  || '/' || ((pg_temp.card('r-lines') ->> 'description') like E'%\n%')::text
  || '/' || (pg_temp.card('r-lines') ->> 'immediateAction'));
select pg_temp.check_case('1 another facility (no profile) takes any 0114 code, numbered from 1', 'ok/1/dental',
  pg_temp.w_report('r-b', 12, 'Clinic B report (fictional)', clock_timestamp() - interval '1 hour', 'dental', null,
    'safety_security', 'mild') || '/' || (pg_temp.card('r-b') ->> 'incidentNumber') || '/'
  || (pg_temp.card('r-b') ->> 'departmentCode'));
reset role;
select pg_temp.check_case('1 incident numbers at A, one per report saved', '1,2,3,4,5,6,7,8',
  (select string_agg(incident_number::text, ',' order by incident_number) from ehr.quality_incidents
    where facility_id = 'e1970000-0000-4000-8000-000000000002'));

-- 2. Who sees what.
set local role hid_ehr_api_runtime;
select pg_temp.w_me('me-desk', 1);
select pg_temp.check_case('2 route 1 for the front desk',
  'true/false/-/false/false/draft/QS-DRAFT-1/10/6/general_outpatient,emergency,inpatient,pharmacy',
  concat_ws('/', pg_temp.res('me-desk') -> 'body' ->> 'canReport', pg_temp.res('me-desk') -> 'body' ->> 'isManager',
    coalesce(pg_temp.res('me-desk') -> 'body' ->> 'managerBasis', '-'), pg_temp.res('me-desk') -> 'body' ->> 'canNameLeads',
    pg_temp.res('me-desk') -> 'body' ->> 'patientLinkAvailable', pg_temp.res('me-desk') -> 'body' -> 'lists' ->> 'listStatus',
    pg_temp.res('me-desk') -> 'body' -> 'lists' ->> 'listVersion',
    jsonb_array_length(pg_temp.res('me-desk') -> 'body' -> 'lists' -> 'categories'),
    jsonb_array_length(pg_temp.res('me-desk') -> 'body' -> 'lists' -> 'harmLevels'),
    (select string_agg(value, ',' order by ord) from jsonb_array_elements_text(pg_temp.res('me-desk') -> 'body'
      -> 'departmentCodes') with ordinality item(value, ord))));
select pg_temp.check_case('2 the harm levels and "told" for each', 'near_miss:false,no_harm:false,mild:false,moderate:true,severe:true,death:true',
  (select string_agg(item ->> 'code' || ':' || (item ->> 'toldRequired'), ',' order by ord)
     from jsonb_array_elements(pg_temp.res('me-desk') -> 'body' -> 'lists' -> 'harmLevels') with ordinality list(item, ord)));
select pg_temp.check_case('2 the categories in order, medication first', 'medication,patient_fall,identification_documentation,procedure_treatment,infection_control,equipment_device,blood_transfusion,safety_security,facility_environment,other',
  (select string_agg(item ->> 'code', ',' order by ord)
     from jsonb_array_elements(pg_temp.res('me-desk') -> 'body' -> 'lists' -> 'categories') with ordinality list(item, ord)));
select pg_temp.w_me('me-admin', 4);
select pg_temp.w_me('me-owner', 7);
select pg_temp.w_me('me-b', 12);
select pg_temp.check_case('2 route 1 for the administrator, the owner and a member of B (no profile: fifteen codes)',
  'true/role/true|true/role/true|false/-/false/15',
  concat_ws('/', pg_temp.res('me-admin') -> 'body' ->> 'isManager', pg_temp.res('me-admin') -> 'body' ->> 'managerBasis',
    pg_temp.res('me-admin') -> 'body' ->> 'canNameLeads') || '|'
  || concat_ws('/', pg_temp.res('me-owner') -> 'body' ->> 'isManager', pg_temp.res('me-owner') -> 'body' ->> 'managerBasis',
    pg_temp.res('me-owner') -> 'body' ->> 'canNameLeads') || '|'
  || concat_ws('/', pg_temp.res('me-b') -> 'body' ->> 'isManager', coalesce(pg_temp.res('me-b') -> 'body' ->> 'managerBasis', '-'),
    pg_temp.res('me-b') -> 'body' ->> 'canNameLeads', jsonb_array_length(pg_temp.res('me-b') -> 'body' -> 'departmentCodes')));
select pg_temp.check_case('2 a member without the code (a narrow role only)', '42501 QUALITY_NOT_ALLOWED',
  pg_temp.w_me('me-narrow', 11));
select pg_temp.check_case('2 a membership held by the cutover', '42501 QUALITY_NOT_ALLOWED', pg_temp.w_me('me-held', 10));
select pg_temp.check_case('2 an ended membership', '42501 QUALITY_NOT_ALLOWED', pg_temp.w_me('me-ended', 15));
select pg_temp.check_case('2 direct care is not this purpose', '22023 QUALITY_PURPOSE_REQUIRED',
  pg_temp.w_me('me-direct', 1, 'direct-care'));
select pg_temp.check_case('2 no purpose', '22023 QUALITY_PURPOSE_REQUIRED', pg_temp.w_me('me-nopurpose', 1, ''));
select pg_temp.check_case('2 a report needs the purpose too', '22023 QUALITY_PURPOSE_REQUIRED', pg_temp.w_report(
  'r-direct', 1, 'Direct care (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null, 'other', 'no_harm',
  null, null, 'Fictional: what happened, in enough words.', null, null, null, 'direct-care'));
select pg_temp.check_case('2 a member without the code cannot report', '42501 QUALITY_NOT_ALLOWED', pg_temp.w_report(
  'r-narrow', 11, 'Narrow (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null, 'other', 'no_harm'));
select pg_temp.check_case('2 the reporter reads their own: reporter view', 'ok/reporter/-/false',
  pg_temp.w_read('read-desk', 1, pg_temp.inc('r-ok')) || '/' || (pg_temp.card('read-desk') ->> 'view') || '/'
  || pg_temp.short(pg_temp.card('read-desk') ->> 'reporterMembershipId') || '/' || (pg_temp.card('read-desk') ->> 'reporterHidden'));
select pg_temp.check_case('2 the administrator reads it: manager view with the reporter', 'ok/manager/01/false/0/0',
  pg_temp.w_read('read-admin', 4, pg_temp.inc('r-ok')) || '/' || (pg_temp.card('read-admin') ->> 'view') || '/'
  || pg_temp.short(pg_temp.card('read-admin') ->> 'reporterMembershipId') || '/' || (pg_temp.card('read-admin') ->> 'reportedByMe')
  || '/' || (pg_temp.card('read-admin') ->> 'openActions') || '/' || (pg_temp.card('read-admin') ->> 'overdueActions'));
select pg_temp.check_case('2 the owner reads it: manager view', 'ok/manager', pg_temp.w_read('read-owner', 7,
  pg_temp.inc('r-ok')) || '/' || (pg_temp.card('read-owner') ->> 'view'));
select pg_temp.check_case('2 another member of A: not found', 'not_found', pg_temp.w_read('read-nurse', 2, pg_temp.inc('r-ok')));
select pg_temp.check_case('2 a doctor of A: not found (doctors do not manage, Q251 A)', 'not_found',
  pg_temp.w_read('read-doctor', 3, pg_temp.inc('r-ok')));
select pg_temp.check_case('2 a member of B: not found', 'not_found', pg_temp.w_read('read-b', 12, pg_temp.inc('r-ok')));
select pg_temp.check_case('2 an administrator of B: not found', 'not_found', pg_temp.w_read('read-badmin', 13, pg_temp.inc('r-ok')));
select pg_temp.check_case('2 no such incident: not found', 'not_found',
  pg_temp.w_read('read-none', 4, 'e1979999-0000-4000-8000-000000000001'));
select pg_temp.w_list('list-desk', 1);
select pg_temp.w_list('list-nurse', 2);
select pg_temp.w_list('list-admin', 4);
select pg_temp.w_list('list-b', 12);
select pg_temp.check_case('2 the list: the reporter their 8, a nurse none, the administrator all 8 with counts, B its one',
  '8/-|0/-|8/8:0:0:0|1/-',
  (select jsonb_array_length(pg_temp.res('list-desk') -> 'body' -> 'items') || '/'
          || coalesce((pg_temp.res('list-desk') -> 'body' ->> 'counts'), '-')) || '|'
  || (select jsonb_array_length(pg_temp.res('list-nurse') -> 'body' -> 'items') || '/'
          || coalesce((pg_temp.res('list-nurse') -> 'body' ->> 'counts'), '-')) || '|'
  || (select jsonb_array_length(pg_temp.res('list-admin') -> 'body' -> 'items') || '/'
          || concat_ws(':', pg_temp.res('list-admin') -> 'body' -> 'counts' ->> 'reported',
               pg_temp.res('list-admin') -> 'body' -> 'counts' ->> 'assigned',
               pg_temp.res('list-admin') -> 'body' -> 'counts' ->> 'investigated',
               pg_temp.res('list-admin') -> 'body' -> 'counts' ->> 'resolved')) || '|'
  || (select jsonb_array_length(pg_temp.res('list-b') -> 'body' -> 'items') || '/'
          || coalesce((pg_temp.res('list-b') -> 'body' ->> 'counts'), '-')));
select pg_temp.check_case('2 a list item carries no reporter, patient or text but the title', 'assignedToMe,category,departmentCode,harmLevel,incidentId,incidentNumber,occurredAt,openActions,overdueActions,patientLinked,reportedAt,reportedByMe,reviewerMembershipId,rowVersion,status,title',
  (select string_agg(key, ',' order by key) from jsonb_object_keys(pg_temp.res('list-admin') -> 'body' -> 'items' -> 0) key));
select pg_temp.check_case('2 newest report first; the reporter''s items show no actions', 'true/-/-',
  ((pg_temp.res('list-admin') -> 'body' -> 'items' -> 0 ->> 'reportedAt')
   >= (pg_temp.res('list-admin') -> 'body' -> 'items' -> 7 ->> 'reportedAt'))::text || '/'
  || coalesce(pg_temp.res('list-desk') -> 'body' -> 'items' -> 0 ->> 'openActions', '-') || '/'
  || coalesce(pg_temp.res('list-desk') -> 'body' -> 'items' -> 0 ->> 'reviewerMembershipId', '-'));
select pg_temp.w_list('list-page1', 4, null, null, null, null, null, null, null, 3);
select pg_temp.w_list('list-page2', 4, null, null, null, null, null, null, null, 3,
  (pg_temp.res('list-page1') -> 'body' -> 'next' ->> 'reportedAt')::timestamptz,
  (pg_temp.res('list-page1') -> 'body' -> 'next' ->> 'incidentId')::uuid);
select pg_temp.check_case('2 keyset pages of 3: no overlap, more after each', '3/true/3/true/0',
  jsonb_array_length(pg_temp.res('list-page1') -> 'body' -> 'items') || '/' || (pg_temp.res('list-page1') -> 'body' ->> 'hasMore')
  || '/' || jsonb_array_length(pg_temp.res('list-page2') -> 'body' -> 'items') || '/'
  || (pg_temp.res('list-page2') -> 'body' ->> 'hasMore') || '/'
  || (select count(*) from jsonb_array_elements(pg_temp.res('list-page1') -> 'body' -> 'items') first_page
       join jsonb_array_elements(pg_temp.res('list-page2') -> 'body' -> 'items') second_page
         on first_page ->> 'incidentId' = second_page ->> 'incidentId'));
select pg_temp.w_list('list-filter', 4, 'open', 'medication', 'moderate', 'emergency',
  ((clock_timestamp() at time zone 'Africa/Lagos')::date - 1), ((clock_timestamp() at time zone 'Africa/Lagos')::date));
select pg_temp.check_case('2 filters: open, category, harm level, department, days', '1/Wrong strength dispensed (fictional)',
  jsonb_array_length(pg_temp.res('list-filter') -> 'body' -> 'items') || '/'
  || (pg_temp.res('list-filter') -> 'body' -> 'items' -> 0 ->> 'title'));
select pg_temp.check_case('2 a page of 101', '22023 QUALITY_INVALID',
  pg_temp.w_list('list-big', 4, null, null, null, null, null, null, null, 101));
select pg_temp.check_case('2 days more than 366 apart', '22023 QUALITY_INVALID',
  pg_temp.w_list('list-days', 4, null, null, null, null, date '2025-01-01', date '2026-01-03'));
select pg_temp.check_case('2 a cursor with half its parts', '22023 QUALITY_LIST_CURSOR_INVALID',
  pg_temp.w_list('list-cursor', 4, null, null, null, null, null, null, null, null, clock_timestamp(), null));
select pg_temp.check_case('2 a status the list does not know', '22023 QUALITY_INVALID', pg_temp.w_list('list-status', 4, 'closed'));
select pg_temp.check_case('2 manager steps refused for the front desk', '42501 QUALITY_MANAGER_ONLY|42501 QUALITY_MANAGER_ONLY|42501 QUALITY_MANAGER_ONLY',
  pg_temp.w_assign('a-desk', 1, pg_temp.inc('r-ok'), 2) || '|' || pg_temp.w_counts('c-desk', 1, '2025-11') || '|'
  || pg_temp.w_lead_list('l-desk', 1));
select pg_temp.check_case('2 naming a lead refused for a doctor', '42501 QUALITY_LEADS_ADMIN_ONLY',
  pg_temp.w_lead_name('ln-doctor', 3, 8));
reset role;

-- 3. The patient link.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 switched off: not available, nothing saved', 'patient_link_not_available/8',
  pg_temp.w_report('p-off', 1, 'Patient link off (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null,
    'medication', 'no_harm', null, 1) || '/' || pg_temp.count_at(1));
reset role;
-- A signed migration turns the switch on after the DPO's review (here, the suite as the table's owner would).
update ehr.quality_switches set enabled = true, changed_by_migration = '9997', changed_at = clock_timestamp()
 where key = 'patient_link';
set local role hid_ehr_api_runtime;
select pg_temp.w_me('me-on', 1);
select pg_temp.check_case('3 route 1 says the link is available', 'true',
  pg_temp.res('me-on') -> 'body' ->> 'patientLinkAvailable');
select pg_temp.check_case('3 registered at this desk', 'ok/true/true/-',
  pg_temp.w_report('p-registered', 1, 'Linked registered (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy',
    null, 'medication', 'no_harm', null, 1)
  || '/' || (pg_temp.card('p-registered') ->> 'patientLinked') || '/' || (pg_temp.card('p-registered') ->> 'patientHidden')
  || '/' || coalesce(pg_temp.card('p-registered') ->> 'patient', '-'));
select pg_temp.check_case('3 an unknown record made here', 'ok', pg_temp.w_report('p-unknown', 1,
  'Linked unknown (fictional)', clock_timestamp() - interval '1 hour', 'emergency', null, 'identification_documentation',
  'no_harm', null, 2));
select pg_temp.check_case('3 a visit here 30 days ago', 'ok', pg_temp.w_report('p-visit', 1, 'Linked visit (fictional)',
  clock_timestamp() - interval '1 hour', 'general_outpatient', null, 'patient_fall', 'mild', null, 3));
select pg_temp.check_case('3 a check-in here 20 days ago', 'ok', pg_temp.w_report('p-checkin', 1,
  'Linked check-in (fictional)', clock_timestamp() - interval '1 hour', 'general_outpatient', null, 'other', 'no_harm',
  null, 4));
select pg_temp.check_case('3 each refusal is the same answer, and nothing is saved',
  'patient_link_refused,patient_link_refused,patient_link_refused,patient_link_refused,patient_link_refused,patient_link_refused,patient_link_refused,patient_link_refused/12',
  concat_ws(',',
    pg_temp.w_report('p-visit91', 1, 'Refused (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null,
      'other', 'no_harm', null, 5),
    pg_temp.w_report('p-checkin91', 1, 'Refused (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null,
      'other', 'no_harm', null, 6),
    pg_temp.w_report('p-sealed', 1, 'Refused (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null,
      'other', 'no_harm', null, 7),
    pg_temp.w_report('p-inactive', 1, 'Refused (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null,
      'other', 'no_harm', null, 8),
    pg_temp.w_report('p-stranger', 1, 'Refused (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null,
      'other', 'no_harm', null, 9),
    pg_temp.w_report('p-otherplace', 1, 'Refused (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null,
      'other', 'no_harm', null, 10),
    pg_temp.w_report('p-cancelledcheckin', 1, 'Refused (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy',
      null, 'other', 'no_harm', null, 12),
    pg_temp.w_report('p-cancelledvisit', 1, 'Refused (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy',
      null, 'other', 'no_harm', null, 13))
  || '/' || pg_temp.count_at(1));
select pg_temp.check_case('3 B links its own registered patient', 'ok', pg_temp.w_report('p-b', 12,
  'Clinic B linked (fictional)', clock_timestamp() - interval '1 hour', 'dental', null, 'other', 'no_harm', null, 10));
select pg_temp.check_case('3 the demo clinic links its own sealed patient, not a real one', 'ok/patient_link_refused',
  pg_temp.w_report('p-demo', 14, 'Demo linked (fictional)', clock_timestamp() - interval '1 hour', 'emergency', null,
    'other', 'no_harm', null, 11)
  || '/' || pg_temp.w_report('p-demoreal', 14, 'Demo refused (fictional)', clock_timestamp() - interval '1 hour',
    'emergency', null, 'other', 'no_harm', null, 1));
select pg_temp.check_case('3 the QA clinic links its own sealed patient, not a real one; A never a QA patient',
  'ok/patient_link_refused/patient_link_refused',
  pg_temp.w_report('p-qa', 16, 'QA linked (fictional)', clock_timestamp() - interval '1 hour', 'emergency', null,
    'other', 'no_harm', null, 14)
  || '/' || pg_temp.w_report('p-qareal', 16, 'QA refused (fictional)', clock_timestamp() - interval '1 hour',
    'emergency', null, 'other', 'no_harm', null, 1)
  || '/' || pg_temp.w_report('p-aqa', 1, 'A refused QA (fictional)', clock_timestamp() - interval '1 hour',
    'pharmacy', null, 'other', 'no_harm', null, 14));
select pg_temp.check_case('3 the manager sees the patient: name, sex, date of birth, last 4 of the Health ID',
  'ok/Amaka Qualone/standard/-/female/1980-01-02/AA22/false',
  pg_temp.w_read('p-read-admin', 4, pg_temp.inc('p-registered')) || '/'
  || concat_ws('/', pg_temp.card('p-read-admin') -> 'patient' ->> 'fullName',
       pg_temp.card('p-read-admin') -> 'patient' ->> 'recordKind',
       coalesce(pg_temp.card('p-read-admin') -> 'patient' ->> 'unknownLabel', '-'),
       pg_temp.card('p-read-admin') -> 'patient' ->> 'sex', pg_temp.card('p-read-admin') -> 'patient' ->> 'dateOfBirth',
       pg_temp.card('p-read-admin') -> 'patient' ->> 'healthIdLast4', pg_temp.card('p-read-admin') ->> 'patientHidden'));
select pg_temp.check_case('3 an unknown record shows its label', 'ok/Unknown patient U-0007/unknown/U-0007',
  pg_temp.w_read('p-read-unknown', 4, pg_temp.inc('p-unknown')) || '/'
  || concat_ws('/', pg_temp.card('p-read-unknown') -> 'patient' ->> 'fullName',
       pg_temp.card('p-read-unknown') -> 'patient' ->> 'recordKind',
       pg_temp.card('p-read-unknown') -> 'patient' ->> 'unknownLabel'));
select pg_temp.check_case('3 the history says linked, never the patient', 'reported:01,patient_linked:01/{"patientLink": "set"}',
  (select string_agg((entry ->> 'kind') || ':' || pg_temp.short(entry ->> 'byMembershipId'), ',' order by ord)
     from jsonb_array_elements(pg_temp.res('p-read-admin') -> 'body' -> 'history') with ordinality list(entry, ord))
  || '/' || (pg_temp.res('p-read-admin') -> 'body' -> 'history' -> 1 -> 'changes')::text);
reset role;
select pg_temp.check_case('3 link audit rows: the patient and basis when linked; none named when refused',
  'linked:registered_here:true,linked:created_here:true,linked:recent_visit:true,linked:recent_check_in:true|refused:11:0|not_available:1:0',
  (select string_agg((details ->> 'outcome') || ':' || (details ->> 'basis') || ':' || (patient_id is not null)::text, ','
                     order by sequence_id)
     from audit.events where action = 'quality.incident.patient-link' and outcome = 'success'
      and facility_id = 'e1970000-0000-4000-8000-000000000002')
  || '|' || (select 'refused:' || count(*) || ':' || count(patient_id) from audit.events
              where action = 'quality.incident.patient-link' and outcome = 'denied' and details ->> 'refusal' = 'refused')
  || '|' || (select 'not_available:' || count(*) || ':' || count(patient_id) from audit.events
              where action = 'quality.incident.patient-link' and outcome = 'denied'
                and details ->> 'refusal' = 'not_available'));

-- 4. The workflow, on r-ok (Ada's wet floor) and p-registered (linked to p1).
set local role hid_ehr_api_runtime;
select pg_temp.check_case('4 assign the nurse', 'ok/assigned/02', pg_temp.w_assign('a-nurse', 4, pg_temp.inc('r-ok'), 2)
  || '/' || (pg_temp.card('a-nurse') ->> 'status') || '/' || pg_temp.short(pg_temp.card('a-nurse') ->> 'reviewerMembershipId'));
select pg_temp.check_case('4 the history entry with the reviewer before and after', 'assigned/reported/assigned/-/02',
  (select concat_ws('/', entry ->> 'kind', entry ->> 'fromStatus', entry ->> 'toStatus',
            pg_temp.short(entry -> 'changes' -> 'reviewerMembershipId' ->> 'from'),
            pg_temp.short(entry -> 'changes' -> 'reviewerMembershipId' ->> 'to'))
     from jsonb_array_elements(pg_temp.res('a-nurse') -> 'body' -> 'history') entry where entry ->> 'kind' = 'assigned'));
select pg_temp.check_case('4 the reviewer''s view: no reporter, the history''s report entry without an actor',
  'ok/reviewer/-/true/false/-',
  pg_temp.w_read('rv-nurse', 2, pg_temp.inc('r-ok')) || '/' || (pg_temp.card('rv-nurse') ->> 'view') || '/'
  || pg_temp.short(pg_temp.card('rv-nurse') ->> 'reporterMembershipId') || '/' || (pg_temp.card('rv-nurse') ->> 'reporterHidden')
  || '/' || (pg_temp.card('rv-nurse') ->> 'reportedByMe') || '/'
  || pg_temp.short(pg_temp.res('rv-nurse') -> 'body' -> 'history' -> 0 ->> 'byMembershipId'));
select pg_temp.w_list('list-nurse-assigned', 2, null, null, null, null, null, null, 'assigned');
select pg_temp.check_case('4 the nurse''s list: assigned to me', '1/true/02/0',
  jsonb_array_length(pg_temp.res('list-nurse-assigned') -> 'body' -> 'items')::text || '/'
  || (pg_temp.res('list-nurse-assigned') -> 'body' -> 'items' -> 0 ->> 'assignedToMe') || '/'
  || pg_temp.short(pg_temp.res('list-nurse-assigned') -> 'body' -> 'items' -> 0 ->> 'reviewerMembershipId') || '/'
  || (pg_temp.res('list-nurse-assigned') -> 'body' -> 'items' -> 0 ->> 'openActions'));
select pg_temp.check_case('4 the same reviewer again', 'nothing_to_change', pg_temp.w_assign('a-same', 4,
  pg_temp.inc('r-ok'), 2));
select pg_temp.check_case('4 reviewers who cannot be: no code, another facility, held, ended',
  'reviewer_invalid,reviewer_invalid,reviewer_invalid,reviewer_invalid',
  concat_ws(',', pg_temp.w_assign('a-narrow', 4, pg_temp.inc('r-ok'), 11),
    pg_temp.w_assign('a-b', 4, pg_temp.inc('r-ok'), 12), pg_temp.w_assign('a-held', 4, pg_temp.inc('r-ok'), 10),
    pg_temp.w_assign('a-ended', 4, pg_temp.inc('r-ok'), 15)));
select pg_temp.check_case('4 reassign to the doctor: reassigned, status kept', 'ok/assigned/03/reassigned',
  pg_temp.w_assign('a-doctor', 4, pg_temp.inc('r-ok'), 3) || '/' || (pg_temp.card('a-doctor') ->> 'status') || '/'
  || pg_temp.short(pg_temp.card('a-doctor') ->> 'reviewerMembershipId') || '/'
  || (pg_temp.res('a-doctor') -> 'body' -> 'history' -> -1 ->> 'kind'));
select pg_temp.w_list('list-nurse-gone', 2);
select pg_temp.check_case('4 the earlier reviewer loses sight at once', 'not_found/0',
  pg_temp.w_read('rv-nurse-gone', 2, pg_temp.inc('r-ok')) || '/'
  || jsonb_array_length(pg_temp.res('list-nurse-gone') -> 'body' -> 'items'));
select pg_temp.check_case('4 investigation by the earlier reviewer: not found; by the reporter: reviewer only',
  'not_found/reviewer_only',
  pg_temp.w_investigate('i-nurse', 2, pg_temp.inc('r-ok'), 'Findings by the wrong person (fictional).') || '/'
  || pg_temp.w_investigate('i-desk', 1, pg_temp.inc('r-ok'), 'Findings by the reporter (fictional).'));
select pg_temp.check_case('4 investigation on a stale version', 'changed', pg_temp.w_investigate('i-stale', 3,
  pg_temp.inc('r-ok'), 'Findings on an old version (fictional).', 1));
select pg_temp.check_case('4 findings too short', '22023 QUALITY_INVALID', pg_temp.w_investigate('i-short', 3,
  pg_temp.inc('r-ok'), 'Too short'));
select pg_temp.check_case('4 the reviewer records the investigation', 'ok/investigated/03',
  pg_temp.w_investigate('i-doctor', 3, pg_temp.inc('r-ok'), 'The mop bucket leaked; no sign was put out (fictional).')
  || '/' || (pg_temp.card('i-doctor') ->> 'status') || '/'
  || pg_temp.short(pg_temp.card('i-doctor') -> 'investigation' ->> 'recordedByMembershipId'));
select pg_temp.check_case('4 and amends it; both texts stay in the history', 'ok/investigated/investigation_recorded,investigation_amended/2',
  pg_temp.w_investigate('i-amend', 3, pg_temp.inc('r-ok'), 'The mop bucket leaked; a sign was not available (fictional).')
  || '/' || (pg_temp.card('i-amend') ->> 'status') || '/'
  || (select string_agg(entry ->> 'kind', ',' order by ord) from jsonb_array_elements(pg_temp.res('i-amend') -> 'body'
       -> 'history') with ordinality list(entry, ord) where entry ->> 'kind' like 'investigation%') || '/'
  || (select count(distinct entry ->> 'text') from jsonb_array_elements(pg_temp.res('i-amend') -> 'body' -> 'history') entry
       where entry ->> 'kind' like 'investigation%'));
select pg_temp.check_case('4 an investigation before a reviewer', 'assign_first', pg_temp.w_investigate('i-reported', 4,
  pg_temp.inc('r-soon'), 'Findings before assignment (fictional).'));
select pg_temp.check_case('4 an action by the reviewer: owner the pharmacist, due in a week', 'ok/1/1/open/06/false',
  pg_temp.w_action_add('act-1', 3, pg_temp.inc('r-ok'), 'Put out a wet-floor sign (fictional)', 6,
    (clock_timestamp() at time zone 'Africa/Lagos')::date + 7)
  || '/' || (pg_temp.card('act-1') ->> 'openActions') || '/' || jsonb_array_length(pg_temp.res('act-1') -> 'body' -> 'actions')
  || '/' || (pg_temp.res('act-1') -> 'body' -> 'actions' -> 0 ->> 'status') || '/'
  || pg_temp.short(pg_temp.res('act-1') -> 'body' -> 'actions' -> 0 ->> 'ownerMembershipId') || '/'
  || (pg_temp.res('act-1') -> 'body' -> 'actions' -> 0 ->> 'overdue'));
select pg_temp.check_case('4 owners who cannot be', 'action_owner_invalid,action_owner_invalid,action_owner_invalid',
  concat_ws(',', pg_temp.w_action_add('act-narrow', 3, pg_temp.inc('r-ok'), 'Owner without the code (fictional)', 11,
      (clock_timestamp() at time zone 'Africa/Lagos')::date + 7),
    pg_temp.w_action_add('act-b', 3, pg_temp.inc('r-ok'), 'Owner at B (fictional)', 12,
      (clock_timestamp() at time zone 'Africa/Lagos')::date + 7),
    pg_temp.w_action_add('act-held', 3, pg_temp.inc('r-ok'), 'Owner held (fictional)', 10,
      (clock_timestamp() at time zone 'Africa/Lagos')::date + 7)));
select pg_temp.check_case('4 due dates: yesterday and a year and a day ahead refused; a year ahead taken',
  '22023 QUALITY_DUE_DATE_INVALID,22023 QUALITY_DUE_DATE_INVALID,ok',
  concat_ws(',', pg_temp.w_action_add('act-yesterday', 3, pg_temp.inc('r-ok'), 'Due yesterday (fictional)', 6,
      (clock_timestamp() at time zone 'Africa/Lagos')::date - 1),
    pg_temp.w_action_add('act-366', 3, pg_temp.inc('r-ok'), 'Due too late (fictional)', 6,
      (clock_timestamp() at time zone 'Africa/Lagos')::date + 366),
    pg_temp.w_action_add('act-2', 3, pg_temp.inc('r-ok'), 'Review cleaning rota (fictional)', 2,
      (clock_timestamp() at time zone 'Africa/Lagos')::date + 365)));
select pg_temp.check_case('4 an action by the reporter', 'reviewer_only', pg_temp.w_action_add('act-desk', 1,
  pg_temp.inc('r-ok'), 'By the reporter (fictional)', 6, (clock_timestamp() at time zone 'Africa/Lagos')::date + 7));
select pg_temp.check_case('4 an action before a reviewer', 'assign_first', pg_temp.w_action_add('act-reported', 4,
  pg_temp.inc('r-soon'), 'Before assignment (fictional)', 6, (clock_timestamp() at time zone 'Africa/Lagos')::date + 7));
select pg_temp.check_case('4 resolve with open actions', 'actions_open', pg_temp.w_resolve('res-open', 4,
  pg_temp.inc('r-ok'), 'Signs are now kept at every station (fictional).'));
select pg_temp.check_case('4 action done sets the completion time; back to open clears it', 'ok/done/true|ok/open/true',
  pg_temp.w_action_update('upd-done', 3, pg_temp.inc('r-ok'), (pg_temp.res('act-1') -> 'body' -> 'actions' -> 0 ->> 'actionId')::uuid, 'done')
  || '/' || (pg_temp.res('upd-done') -> 'body' -> 'actions' -> 0 ->> 'status') || '/'
  || ((pg_temp.res('upd-done') -> 'body' -> 'actions' -> 0 ->> 'completedAt') is not null)::text || '|'
  || pg_temp.w_action_update('upd-open', 3, pg_temp.inc('r-ok'), (pg_temp.res('act-1') -> 'body' -> 'actions' -> 0 ->> 'actionId')::uuid, 'open')
  || '/' || (pg_temp.res('upd-open') -> 'body' -> 'actions' -> 0 ->> 'status') || '/'
  || ((pg_temp.res('upd-open') -> 'body' -> 'actions' -> 0 ->> 'completedAt') is null)::text);
select pg_temp.check_case('4 cancel without a note; nothing given; no change', '22023 QUALITY_REASON_REQUIRED|22023 QUALITY_NOTHING_TO_CHANGE|nothing_to_change',
  pg_temp.w_action_update('upd-cancel-nonote', 3, pg_temp.inc('r-ok'), (pg_temp.res('act-2') -> 'body' -> 'actions' -> 1 ->> 'actionId')::uuid, 'cancelled')
  || '|' || pg_temp.w_action_update('upd-nothing', 3, pg_temp.inc('r-ok'), (pg_temp.res('act-2') -> 'body' -> 'actions' -> 1 ->> 'actionId')::uuid, null)
  || '|' || pg_temp.w_action_update('upd-same', 3, pg_temp.inc('r-ok'), (pg_temp.res('act-2') -> 'body' -> 'actions' -> 1 ->> 'actionId')::uuid, 'open'));
select pg_temp.check_case('4 cancel with a note; change the owner and due date of the other', 'ok/cancelled/Rota already covers it|ok/09',
  pg_temp.w_action_update('upd-cancel', 3, pg_temp.inc('r-ok'), (pg_temp.res('act-2') -> 'body' -> 'actions' -> 1 ->> 'actionId')::uuid,
    'cancelled', 'Rota already covers it')
  || '/' || (pg_temp.res('upd-cancel') -> 'body' -> 'actions' -> 1 ->> 'status') || '/'
  || (pg_temp.res('upd-cancel') -> 'body' -> 'actions' -> 1 ->> 'note') || '|'
  || pg_temp.w_action_update('upd-owner', 4, pg_temp.inc('r-ok'), (pg_temp.res('act-1') -> 'body' -> 'actions' -> 0 ->> 'actionId')::uuid,
    null, null, 9, (clock_timestamp() at time zone 'Africa/Lagos')::date + 14)
  || '/' || pg_temp.short(pg_temp.res('upd-owner') -> 'body' -> 'actions' -> 0 ->> 'ownerMembershipId'));
select pg_temp.check_case('4 an owner who cannot be', 'action_owner_invalid', pg_temp.w_action_update('upd-badowner', 3,
  pg_temp.inc('r-ok'), (pg_temp.res('act-1') -> 'body' -> 'actions' -> 0 ->> 'actionId')::uuid, null, null, 11));
select pg_temp.check_case('4 another incident''s action', 'action_not_found', pg_temp.w_action_update('upd-other', 4,
  pg_temp.inc('r-mod'), (pg_temp.res('act-1') -> 'body' -> 'actions' -> 0 ->> 'actionId')::uuid, 'done'));
select pg_temp.check_case('4 the first action done, then resolve', 'ok|ok/resolved/0',
  pg_temp.w_action_update('upd-done2', 3, pg_temp.inc('r-ok'), (pg_temp.res('act-1') -> 'body' -> 'actions' -> 0 ->> 'actionId')::uuid, 'done')
  || '|' || pg_temp.w_resolve('res-ok', 4, pg_temp.inc('r-ok'), 'Signs are now kept at every station (fictional).')
  || '/' || (pg_temp.card('res-ok') ->> 'status') || '/' || (pg_temp.card('res-ok') ->> 'openActions'));
select pg_temp.check_case('4 every write but reopen is refused while resolved',
  'resolved,resolved,resolved,resolved,resolved,resolved',
  concat_ws(',', pg_temp.w_assign('a-resolved', 4, pg_temp.inc('r-ok'), 2),
    pg_temp.w_investigate('i-resolved', 4, pg_temp.inc('r-ok'), 'Findings after resolution (fictional).'),
    pg_temp.w_action_add('act-resolved', 4, pg_temp.inc('r-ok'), 'After resolution (fictional)', 6,
      (clock_timestamp() at time zone 'Africa/Lagos')::date + 7),
    pg_temp.w_action_update('upd-resolved', 4, pg_temp.inc('r-ok'), (pg_temp.res('act-1') -> 'body' -> 'actions' -> 0 ->> 'actionId')::uuid, 'open'),
    pg_temp.w_resolve('res-again', 4, pg_temp.inc('r-ok'), 'Resolved twice (fictional) text.'),
    pg_temp.w_correct('c-resolved', 4, pg_temp.inc('r-ok'), 'Corrected after resolution', array['category'], 'other')));
select pg_temp.check_case('4 the reviewer of a resolved incident no longer sees it', 'not_found',
  pg_temp.w_read('rv-resolved', 3, pg_temp.inc('r-ok')));
select pg_temp.check_case('4 the reporter sees status and dates, not the investigation, actions or resolution',
  'ok/reporter/resolved/-/-/-/-/0/reported,assigned,investigation_recorded,resolved/-',
  pg_temp.w_read('rp-resolved', 1, pg_temp.inc('r-ok')) || '/'
  || concat_ws('/', pg_temp.card('rp-resolved') ->> 'view', pg_temp.card('rp-resolved') ->> 'status',
       coalesce(pg_temp.card('rp-resolved') ->> 'investigation', '-'), coalesce(pg_temp.card('rp-resolved') ->> 'resolution', '-'),
       pg_temp.short(pg_temp.card('rp-resolved') ->> 'reviewerMembershipId'),
       coalesce(pg_temp.card('rp-resolved') ->> 'openActions', '-'),
       jsonb_array_length(pg_temp.res('rp-resolved') -> 'body' -> 'actions'),
       (select string_agg(entry ->> 'kind', ',' order by ord)
          from jsonb_array_elements(pg_temp.res('rp-resolved') -> 'body' -> 'history') with ordinality list(entry, ord)),
       coalesce((select string_agg(entry ->> 'text', ',') from jsonb_array_elements(pg_temp.res('rp-resolved') -> 'body'
         -> 'history') entry where entry ->> 'text' is not null), '-')));
select pg_temp.check_case('4 reopen needs a reason of 8 characters', '22023 QUALITY_REASON_REQUIRED',
  pg_temp.w_reopen('ro-short', 4, pg_temp.inc('r-ok'), 'Short'));
select pg_temp.check_case('4 reopen: assigned, the same reviewer, findings and actions kept, the resolution in the history',
  'ok/assigned/03/1/-/true/2/Signs are now kept at every station (fictional).',
  pg_temp.w_reopen('ro-ok', 4, pg_temp.inc('r-ok'), 'Another wet floor the next day') || '/'
  || concat_ws('/', pg_temp.card('ro-ok') ->> 'status', pg_temp.short(pg_temp.card('ro-ok') ->> 'reviewerMembershipId'),
       pg_temp.card('ro-ok') ->> 'reopenedCount', coalesce(pg_temp.card('ro-ok') ->> 'resolution', '-'),
       ((pg_temp.card('ro-ok') -> 'investigation') is not null)::text,
       jsonb_array_length(pg_temp.res('ro-ok') -> 'body' -> 'actions'),
       (select entry ->> 'text' from jsonb_array_elements(pg_temp.res('ro-ok') -> 'body' -> 'history') entry
         where entry ->> 'kind' = 'resolved')));
select pg_temp.check_case('4 reopen of an incident that is not resolved; resolve before an investigation',
  'not_resolved/investigate_first',
  pg_temp.w_reopen('ro-notresolved', 4, pg_temp.inc('r-ok'), 'Reopen while assigned') || '/'
  || pg_temp.w_resolve('res-assigned', 4, pg_temp.inc('r-ok'), 'Resolved without investigation (fictional).'));
-- The reviewer's view of a linked incident (p-registered, linked to p1): neither reporter nor patient.
select pg_temp.check_case('4 the reviewer of a linked incident sees that a patient is linked, not who',
  'ok/ok/reviewer/true/true/-/-,-',
  pg_temp.w_assign('a-linked', 4, pg_temp.inc('p-registered'), 2) || '/'
  || pg_temp.w_read('rv-linked', 2, pg_temp.inc('p-registered')) || '/'
  || concat_ws('/', pg_temp.card('rv-linked') ->> 'view', pg_temp.card('rv-linked') ->> 'patientLinked',
       pg_temp.card('rv-linked') ->> 'patientHidden', coalesce(pg_temp.card('rv-linked') ->> 'patient', '-'),
       (select string_agg(pg_temp.short(entry ->> 'byMembershipId'), ',' order by ord)
          from jsonb_array_elements(pg_temp.res('rv-linked') -> 'body' -> 'history') with ordinality list(entry, ord)
         where entry ->> 'kind' in ('reported', 'patient_linked'))));
select pg_temp.check_case('4 a member who is both reporter and reviewer gets the reviewer''s view', 'ok/ok/reviewer/true/false',
  pg_temp.w_assign('a-self', 4, pg_temp.inc('r-mod'), 1) || '/' || pg_temp.w_read('rv-self', 1, pg_temp.inc('r-mod')) || '/'
  || concat_ws('/', pg_temp.card('rv-self') ->> 'view', pg_temp.card('rv-self') ->> 'reportedByMe',
       pg_temp.card('rv-self') ->> 'reporterHidden'));
reset role;
-- Overdue: an action due yesterday (written as the table's owner would, a day earlier).
set local session_replication_role = replica;
insert into ehr.quality_incident_actions (incident_id, facility_id, description, owner_membership_id, due_date, status,
  created_at, created_by_membership_id, updated_at, updated_by_membership_id)
values (pg_temp.inc('r-mod'), 'e1970000-0000-4000-8000-000000000002', 'Due yesterday (fictional)',
  pg_temp.member(6), (clock_timestamp() at time zone 'Africa/Lagos')::date - 1, 'open', clock_timestamp() - interval '2 days',
  pg_temp.member(4), clock_timestamp() - interval '2 days', pg_temp.member(4));
-- And nineteen more actions on r-mod, so it holds twenty.
insert into ehr.quality_incident_actions (incident_id, facility_id, description, owner_membership_id, due_date, status,
  created_at, created_by_membership_id, updated_at, updated_by_membership_id)
select pg_temp.inc('r-mod'), 'e1970000-0000-4000-8000-000000000002', 'Filler action ' || n || ' (fictional)',
  pg_temp.member(6), (clock_timestamp() at time zone 'Africa/Lagos')::date + 30, 'open', clock_timestamp(), pg_temp.member(4),
  clock_timestamp(), pg_temp.member(4)
from generate_series(1, 19) n;
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.check_case('4 overdue: open and due before today (Lagos)', 'ok/20/1/true',
  pg_temp.w_read('rd-overdue', 4, pg_temp.inc('r-mod')) || '/' || (pg_temp.card('rd-overdue') ->> 'openActions') || '/'
  || (pg_temp.card('rd-overdue') ->> 'overdueActions') || '/'
  || (pg_temp.res('rd-overdue') -> 'body' -> 'actions' -> 0 ->> 'overdue'));
select pg_temp.check_case('4 the twenty-first action', 'action_limit/false', pg_temp.w_action_add('act-21', 1,
  pg_temp.inc('r-mod'), 'One too many (fictional)', 6, (clock_timestamp() at time zone 'Africa/Lagos')::date + 7)
  || '/' || (pg_temp.card('rd-overdue') -> 'can' ->> 'addAction'));
reset role;

-- 5. Corrections (manager), on r-death (death, told not_applicable, inpatient).
set local role hid_ehr_api_runtime;
select pg_temp.check_case('5 the front desk cannot correct', '42501 QUALITY_MANAGER_ONLY', pg_temp.w_correct('c-desk', 1,
  pg_temp.inc('r-death'), 'Wrong category chosen', array['category'], 'medication'));
select pg_temp.check_case('5 the category, with a reason', 'ok/medication/corrected:procedure_treatment>medication',
  pg_temp.w_correct('c-cat', 4, pg_temp.inc('r-death'), 'Wrong category chosen', array['category'], 'medication') || '/'
  || (pg_temp.card('c-cat') ->> 'category') || '/'
  || (select (entry ->> 'kind') || ':' || (entry -> 'changes' -> 'category' ->> 'from') || '>'
             || (entry -> 'changes' -> 'category' ->> 'to')
        from jsonb_array_elements(pg_temp.res('c-cat') -> 'body' -> 'history') entry where entry ->> 'kind' = 'corrected'));
select pg_temp.check_case('5 "told" cleared at death', '22023 QUALITY_TOLD_REQUIRED', pg_temp.w_correct('c-told', 4,
  pg_temp.inc('r-death'), 'Not told after all', array['told'], null, null, null, null, null));
select pg_temp.check_case('5 harm level mild and "told" cleared', 'ok/mild/-', pg_temp.w_correct('c-harm', 4,
  pg_temp.inc('r-death'), 'Harm was overstated', array['harm_level', 'told'], null, 'mild', null, null, null) || '/'
  || (pg_temp.card('c-harm') ->> 'harmLevel') || '/' || coalesce(pg_temp.card('c-harm') ->> 'patientOrFamilyTold', '-'));
select pg_temp.check_case('5 the department cleared with no place', '22023 QUALITY_LOCATION_REQUIRED',
  pg_temp.w_correct('c-noplace', 4, pg_temp.inc('r-death'), 'Department was wrong', array['department_code']));
select pg_temp.check_case('5 a place instead of the department', 'ok/-/Ward 3 side room',
  pg_temp.w_correct('c-place', 4, pg_temp.inc('r-death'), 'Department was wrong', array['department_code', 'location_text'],
    null, null, null, 'Ward 3 side room') || '/' || coalesce(pg_temp.card('c-place') ->> 'departmentCode', '-') || '/'
  || (pg_temp.card('c-place') ->> 'locationText'));
select pg_temp.check_case('5 a department this facility does not have', '22023 QUALITY_DEPARTMENT_INVALID',
  pg_temp.w_correct('c-dental', 4, pg_temp.inc('r-death'), 'Department was wrong', array['department_code'], null, null,
    'dental'));
select pg_temp.check_case('5 the same values again; no field; a short reason',
  'nothing_to_change|22023 QUALITY_NOTHING_TO_CHANGE|22023 QUALITY_REASON_REQUIRED',
  pg_temp.w_correct('c-same', 4, pg_temp.inc('r-death'), 'Same value again', array['category'], 'medication') || '|'
  || pg_temp.w_correct('c-none', 4, pg_temp.inc('r-death'), 'Nothing given here', array[]::text[]) || '|'
  || pg_temp.w_correct('c-shortreason', 4, pg_temp.inc('r-death'), 'Short', array['category'], 'other'));
select pg_temp.check_case('5 link a patient of this facility', 'ok/true/AA22/patient_link_changed:{"patientLink": "set"}',
  pg_temp.w_correct('c-link', 4, pg_temp.inc('r-death'), 'The patient was known', array['patient_id'], null, null, null,
    null, null, 1) || '/' || (pg_temp.card('c-link') ->> 'patientLinked') || '/'
  || (pg_temp.card('c-link') -> 'patient' ->> 'healthIdLast4') || '/'
  || (select (entry ->> 'kind') || ':' || (entry -> 'changes')::text
        from jsonb_array_elements(pg_temp.res('c-link') -> 'body' -> 'history') entry
       where entry ->> 'kind' = 'patient_link_changed'));
select pg_temp.check_case('5 a stranger instead: refused', 'patient_link_refused',
  pg_temp.w_correct('c-stranger', 4, pg_temp.inc('r-death'), 'Another patient it was', array['patient_id'], null, null,
    null, null, null, 9));
select pg_temp.w_read('rd-afterstranger', 4, pg_temp.inc('r-death'));
select pg_temp.check_case('5 and the link kept', 'AA22',
  pg_temp.card('rd-afterstranger') -> 'patient' ->> 'healthIdLast4');
select pg_temp.check_case('5 changed to the unknown record made here', 'ok/AB22',
  pg_temp.w_correct('c-change', 4, pg_temp.inc('r-death'), 'Another patient it was', array['patient_id'], null, null, null,
    null, null, 2) || '/' || (pg_temp.card('c-change') -> 'patient' ->> 'healthIdLast4'));
reset role;
update ehr.quality_switches set enabled = false, changed_by_migration = '9998', changed_at = clock_timestamp()
 where key = 'patient_link';
set local role hid_ehr_api_runtime;
select pg_temp.check_case('5 switched off: a new link not available, clearing still works',
  'patient_link_not_available|ok/false/-',
  pg_temp.w_correct('c-linkoff', 4, pg_temp.inc('r-death'), 'Another patient it was', array['patient_id'], null, null, null,
    null, null, 1) || '|'
  || pg_temp.w_correct('c-clear', 4, pg_temp.inc('r-death'), 'No patient was involved', array['patient_id'], null, null,
    null, null, null, null) || '/' || (pg_temp.card('c-clear') ->> 'patientLinked') || '/'
  || coalesce(pg_temp.card('c-clear') ->> 'patient', '-'));
select pg_temp.check_case('5 the report as filed is unchanged', 'Death (fictional)/Fictional: what happened, in enough words./01',
  (pg_temp.card('c-clear') ->> 'title') || '/' || (pg_temp.card('c-clear') ->> 'description') || '/'
  || pg_temp.short(pg_temp.card('c-clear') ->> 'reporterMembershipId'));
reset role;
select pg_temp.check_case('5 the patient-link audit rows of the corrections', 'linked:01:registered_here,changed:02:created_here,cleared:02:-',
  (select string_agg((details ->> 'outcome') || ':' || pg_temp.short(patient_id::text) || ':' || coalesce(details ->> 'basis', '-'), ','
                     order by sequence_id)
     from audit.events where action = 'quality.incident.patient-link' and outcome = 'success'
      and details ->> 'step' = 'correction'));
select pg_temp.check_case('5 the correction audit rows name the fields by code', '["category"]|["harmLevel", "patientOrFamilyTold"]',
  (select string_agg((details -> 'fieldsChanged')::text, '|' order by sequence_id)
     from audit.events where action = 'quality.incident.correct' and outcome = 'success'
      and resource_id = pg_temp.inc('r-death')::text and details ->> 'fieldsChanged' not like '%patientLink%'
      and details ->> 'fieldsChanged' not like '%locationText%'));

-- 6. The guards (as the suite's owner, with every trigger on).
select pg_temp.check_case('6 the history is append only',
  '55000 ehr.quality_incident_events is append-only|55000 ehr.quality_incident_events is append-only|55000 ehr.quality_incident_events is append-only',
  pg_temp.refused('update ehr.quality_incident_events set reason = null where kind = ''reopened''') || '|'
  || pg_temp.refused('delete from ehr.quality_incident_events') || '|'
  || pg_temp.refused('truncate ehr.quality_incident_events'));
select pg_temp.check_case('6 the list items are append only',
  '55000 ehr.quality_list_items is append-only|55000 ehr.quality_list_items is append-only|55000 ehr.quality_list_items is append-only',
  pg_temp.refused('update ehr.quality_list_items set label = ''Changed'' where code = ''other''') || '|'
  || pg_temp.refused('delete from ehr.quality_list_items') || '|'
  || pg_temp.refused('truncate ehr.quality_list_items cascade'));
select pg_temp.check_case('6 no delete on four of the other five (leads in 9)',
  '55000 ehr.quality_incidents is append-only|55000 ehr.quality_incident_actions is append-only|55000 ehr.quality_list_versions is append-only|55000 ehr.quality_switches is append-only',
  pg_temp.refused('delete from ehr.quality_incidents') || '|' || pg_temp.refused('delete from ehr.quality_incident_actions')
  || '|' || pg_temp.refused('delete from ehr.quality_list_versions') || '|' || pg_temp.refused('delete from ehr.quality_switches'));
select pg_temp.check_case('6 no truncate on the other five',
  '55000 ehr.quality_incidents is append-only|55000 ehr.quality_incident_actions is append-only|55000 ehr.quality_leads is append-only|55000 ehr.quality_list_versions is append-only|55000 ehr.quality_switches is append-only',
  pg_temp.refused('truncate ehr.quality_incidents cascade') || '|' || pg_temp.refused('truncate ehr.quality_incident_actions cascade')
  || '|' || pg_temp.refused('truncate ehr.quality_leads') || '|' || pg_temp.refused('truncate ehr.quality_list_versions cascade')
  || '|' || pg_temp.refused('truncate ehr.quality_switches'));
select pg_temp.check_case('6 the report as filed never changes; every update raises the version by one',
  '55000 QUALITY_REPORT_AS_FILED_IS_FIXED|55000 QUALITY_REPORT_AS_FILED_IS_FIXED|55000 QUALITY_ROW_VERSION_STEP',
  pg_temp.refused(format('update ehr.quality_incidents set title = ''Changed title'', row_version = row_version + 1 where id = %L',
    pg_temp.inc('r-ok'))) || '|'
  || pg_temp.refused(format('update ehr.quality_incidents set reported_by_membership_id = %L, row_version = row_version + 1 where id = %L',
    pg_temp.member(2), pg_temp.inc('r-ok'))) || '|'
  || pg_temp.refused(format('update ehr.quality_incidents set category = ''other'' where id = %L', pg_temp.inc('r-ok'))));
select pg_temp.check_case('6 an action''s incident and text never change', '55000 QUALITY_ACTION_FIXED|55000 QUALITY_ACTION_FIXED',
  pg_temp.refused(format('update ehr.quality_incident_actions set incident_id = %L where incident_id = %L',
    pg_temp.inc('r-death'), pg_temp.inc('r-ok'))) || '|'
  || pg_temp.refused(format('update ehr.quality_incident_actions set description = ''Changed text here'' where incident_id = %L',
    pg_temp.inc('r-ok'))));
select pg_temp.check_case('6 the database refuses a place-less, "told"-less or out-of-window row on its own',
  '23514|23514|23514|23514',
  split_part(pg_temp.refused(format('update ehr.quality_incidents set department_code = null, location_text = null, row_version = row_version + 1 where id = %L',
    pg_temp.inc('r-ok'))), ' ', 1) || '|'
  || split_part(pg_temp.refused(format('update ehr.quality_incidents set harm_level = ''severe'', patient_or_family_told = null, row_version = row_version + 1 where id = %L',
    pg_temp.inc('r-ok'))), ' ', 1) || '|'
  || split_part(pg_temp.refused(format('update ehr.quality_incidents set department_code = ''not_a_department'', row_version = row_version + 1 where id = %L',
    pg_temp.inc('r-ok'))), ' ', 1) || '|'
  || split_part(pg_temp.refused('insert into ehr.quality_list_items (list_version, list_kind, code, position, label, hint, told_required) values (''QS-DRAFT-1'', ''harm_level'', ''mild'', 9, ''Mild'', '''', true)'), ' ', 1));

-- 7. Idempotent replays, a reused key, version conflicts.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('7 the same report again: the first answer, replayed, nothing new', 'ok/true/same/' || pg_temp.count_at(1),
  pg_temp.w_report('r-ok-again', 1, 'Wet floor near pharmacy (fictional)', clock_timestamp() - interval '1 hour',
    'pharmacy', 'Corridor B', 'facility_environment', 'near_miss', null, null,
    'Fictional: what happened, in enough words.', null, 'r-ok', 'r-ok')
  || '/' || (pg_temp.res('r-ok-again') ->> 'replayed') || '/'
  || case when pg_temp.inc('r-ok-again') = pg_temp.inc('r-ok') then 'same' else 'different' end || '/' || pg_temp.count_at(1));
select pg_temp.check_case('7 the same key with another body', 'key_reused', pg_temp.w_report('r-ok-other', 1,
  'Another body (fictional)', clock_timestamp() - interval '1 hour', 'pharmacy', null, 'other', 'no_harm', null, null,
  'Fictional: what happened, in enough words.', null, 'r-ok', 'r-ok-other'));
select pg_temp.check_case('7 an assignment replayed', 'ok/true', pg_temp.w_assign('a-nurse-again', 4, pg_temp.inc('r-ok'), 2,
  1, 'a-nurse', 'a-nurse') || '/' || (pg_temp.res('a-nurse-again') ->> 'replayed'));
select pg_temp.check_case('7 a stale version', 'changed', pg_temp.w_assign('a-stale', 4, pg_temp.inc('r-year'), 2, 7));
select pg_temp.check_case('7 a malformed key', '22023 QUALITY_IDEMPOTENCY_KEY_INVALID', pg_temp.w_assign('a b', 4,
  pg_temp.inc('r-year'), 2));
reset role;

-- 8. The monthly counts at the Lagos month's edges (rows written as the table's owner, in a past year).
set local session_replication_role = replica;
insert into ehr.quality_incidents (facility_id, incident_number, title, description, occurred_at, occurred_day,
  reported_by_membership_id, reported_at, list_version, category, harm_level, department_code, location_text,
  patient_or_family_told, updated_by_membership_id, updated_at)
select edge.facility, edge.number, 'Counted incident (fictional)', 'Fictional: what happened, in enough words.',
  edge.occurred, (edge.occurred at time zone 'Africa/Lagos')::date, edge.reporter, edge.occurred + interval '1 hour',
  'QS-DRAFT-1', edge.category, edge.harm, edge.department, edge.place,
  case when edge.harm in ('moderate', 'severe', 'death') then 'yes' end, edge.reporter, edge.occurred + interval '1 hour'
from (values
  -- 31 Oct 2024 23:30 Lagos: October.
  ('e1970000-0000-4000-8000-000000000002'::uuid, 901, timestamptz '2024-10-31 22:30:00+00', pg_temp.member(1), 'medication', 'no_harm', 'pharmacy', null::text),
  -- 1 Nov 2024 00:30 Lagos: November.
  ('e1970000-0000-4000-8000-000000000002', 902, timestamptz '2024-10-31 23:30:00+00', pg_temp.member(1), 'medication', 'no_harm', 'pharmacy', null),
  ('e1970000-0000-4000-8000-000000000002', 903, timestamptz '2024-11-15 12:00:00+00', pg_temp.member(2), 'medication', 'no_harm', 'pharmacy', null),
  -- 30 Nov 2024 23:59:59 Lagos: November.
  ('e1970000-0000-4000-8000-000000000002', 904, timestamptz '2024-11-30 22:59:59+00', pg_temp.member(2), 'patient_fall', 'mild', null, 'Ward 2 corridor'),
  -- 1 Dec 2024 00:00 Lagos: December.
  ('e1970000-0000-4000-8000-000000000002', 905, timestamptz '2024-11-30 23:00:00+00', pg_temp.member(2), 'patient_fall', 'mild', null, 'Ward 2 corridor'),
  ('e1970000-0000-4000-8000-000000000002', 906, timestamptz '2024-11-20 09:00:00+00', pg_temp.member(3), 'blood_transfusion', 'moderate', 'inpatient', null),
  -- Another facility's, in November: never counted at A.
  ('e1970000-0000-4000-8000-000000000012', 907, timestamptz '2024-11-10 09:00:00+00', pg_temp.member(12), 'medication', 'no_harm', 'pharmacy', null))
  edge(facility, number, occurred, reporter, category, harm, department, place);
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.check_case('8 November 2024 (Lagos): three rows, in the lists'' order, no department last',
  'ok/2024-11/occurred/QS-DRAFT-1/draft/4/medication:no_harm:pharmacy:2,patient_fall:mild:-:1,blood_transfusion:moderate:inpatient:1',
  pg_temp.w_counts('cnt-nov', 4, '2024-11') || '/'
  || concat_ws('/', pg_temp.res('cnt-nov') -> 'body' ->> 'month', pg_temp.res('cnt-nov') -> 'body' ->> 'basis',
       pg_temp.res('cnt-nov') -> 'body' ->> 'listVersion', pg_temp.res('cnt-nov') -> 'body' ->> 'listStatus',
       pg_temp.res('cnt-nov') -> 'body' ->> 'total',
       (select string_agg(concat_ws(':', item ->> 'category', item ->> 'harmLevel', coalesce(item ->> 'departmentCode', '-'),
                                   item ->> 'count'), ',' order by ord)
          from jsonb_array_elements(pg_temp.res('cnt-nov') -> 'body' -> 'rows') with ordinality list(item, ord))));
select pg_temp.check_case('8 October and December 2024 take the edges', 'ok/1|ok/1',
  pg_temp.w_counts('cnt-oct', 4, '2024-10') || '/' || (pg_temp.res('cnt-oct') -> 'body' ->> 'total') || '|'
  || pg_temp.w_counts('cnt-dec', 4, '2024-12', 'csv') || '/' || (pg_temp.res('cnt-dec') -> 'body' ->> 'total'));
select pg_temp.check_case('8 the rows carry the words and nothing else', 'category,categoryLabel,count,departmentCode,harmLevel,harmLevelLabel/Medication/No harm',
  (select string_agg(key, ',' order by key) from jsonb_object_keys(pg_temp.res('cnt-nov') -> 'body' -> 'rows' -> 0) key)
  || '/' || (pg_temp.res('cnt-nov') -> 'body' -> 'rows' -> 0 ->> 'categoryLabel') || '/'
  || (pg_temp.res('cnt-nov') -> 'body' -> 'rows' -> 0 ->> 'harmLevelLabel'));
select pg_temp.check_case('8 B''s November is its own', 'ok/1', pg_temp.w_counts('cnt-b', 13, '2024-11') || '/'
  || (pg_temp.res('cnt-b') -> 'body' ->> 'total'));
select pg_temp.check_case('8 a month that has not started, a thirteenth month, another format',
  '22023 QUALITY_MONTH_INVALID|22023 QUALITY_MONTH_INVALID|22023 QUALITY_INVALID',
  pg_temp.w_counts('cnt-future', 4, to_char((clock_timestamp() at time zone 'Africa/Lagos')::date + interval '1 month', 'YYYY-MM'))
  || '|' || pg_temp.w_counts('cnt-13', 4, '2025-13') || '|' || pg_temp.w_counts('cnt-xml', 4, '2024-11', 'xml'));
select pg_temp.check_case('8 this month has started', 'ok', pg_temp.w_counts('cnt-now', 4,
  to_char((clock_timestamp() at time zone 'Africa/Lagos')::date, 'YYYY-MM')));
reset role;
select pg_temp.check_case('8 the export audit rows: month, total, format', '2024-11:4:json,2024-10:1:json,2024-12:1:csv',
  (select string_agg(concat_ws(':', details ->> 'month', details ->> 'total', details ->> 'format'), ',' order by sequence_id)
     from audit.events where action = 'quality.incident.counts-export' and actor_membership_id = pg_temp.member(4)
      and details ->> 'month' like '2024-%'));

-- 9. Quality leads.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('9 the administrator names a doctor', 'ok/08/-', pg_temp.w_lead_name('lead-8', 4, 8) || '/'
  || pg_temp.short(pg_temp.res('lead-8') -> 'body' -> 'lead' ->> 'membershipId') || '/'
  || coalesce(pg_temp.res('lead-8') -> 'body' -> 'lead' ->> 'endedAt', '-'));
select pg_temp.w_me('me-lead', 8);
select pg_temp.check_case('9 the lead: a manager by the list, not a namer of leads', 'true/quality_lead/false',
  concat_ws('/', pg_temp.res('me-lead') -> 'body' ->> 'isManager', pg_temp.res('me-lead') -> 'body' ->> 'managerBasis',
    pg_temp.res('me-lead') -> 'body' ->> 'canNameLeads'));
select pg_temp.check_case('9 the lead sees every incident and the reporter', 'ok/manager/01',
  pg_temp.w_read('rd-lead', 8, pg_temp.inc('r-place')) || '/' || (pg_temp.card('rd-lead') ->> 'view') || '/'
  || pg_temp.short(pg_temp.card('rd-lead') ->> 'reporterMembershipId'));
select pg_temp.check_case('9 the lead assigns', 'ok', pg_temp.w_assign('a-lead', 8, pg_temp.inc('r-place'), 9));
select pg_temp.check_case('9 the lead lists the leads but cannot name one', 'ok|42501 QUALITY_LEADS_ADMIN_ONLY',
  pg_temp.w_lead_list('ll-lead', 8) || '|' || pg_temp.w_lead_name('lead-by-lead', 8, 20));
select pg_temp.check_case('9 already a lead; members who cannot be', 'lead_exists,lead_invalid,lead_invalid,lead_invalid,lead_invalid',
  concat_ws(',', pg_temp.w_lead_name('lead-8-again', 4, 8), pg_temp.w_lead_name('lead-narrow', 4, 11),
    pg_temp.w_lead_name('lead-b', 4, 12), pg_temp.w_lead_name('lead-held', 4, 10), pg_temp.w_lead_name('lead-ended', 4, 15)));
select pg_temp.check_case('9 nine more by the owner', 'ok,ok,ok,ok,ok,ok,ok,ok,ok',
  (select string_agg(outcome, ',' order by n)
     from (select n, pg_temp.w_lead_name('lead-' || n, 7, n) as outcome from generate_series(20, 28) n) named));
select pg_temp.check_case('9 then the limit of 10', 'lead_limit', pg_temp.w_lead_name('lead-29', 4, 29));
select pg_temp.w_lead_list('ll-admin', 4);
select pg_temp.check_case('9 ten active leads listed', '10', jsonb_array_length(pg_temp.res('ll-admin') -> 'body' -> 'leads')::text);
select pg_temp.check_case('9 a replayed naming', 'ok/true', pg_temp.w_lead_name('lead-20', 7, 20) || '/'
  || (pg_temp.res('lead-20') ->> 'replayed'));
select pg_temp.check_case('9 end needs a reason; end', '22023 QUALITY_REASON_REQUIRED|ok/04',
  pg_temp.w_lead_end('end-short', 4, (pg_temp.res('lead-8') -> 'body' -> 'lead' ->> 'leadId')::uuid, 'Short') || '|'
  || pg_temp.w_lead_end('end-8', 4, (pg_temp.res('lead-8') -> 'body' -> 'lead' ->> 'leadId')::uuid, 'Moved to another unit')
  || '/' || pg_temp.short(pg_temp.res('end-8') -> 'body' -> 'lead' ->> 'endedByMembershipId'));
select pg_temp.w_me('me-lead-ended', 8);
select pg_temp.check_case('9 the ended lead loses manager rights at once', 'false|42501 QUALITY_MANAGER_ONLY',
  (pg_temp.res('me-lead-ended') -> 'body' ->> 'isManager') || '|'
  || pg_temp.w_assign('a-lead-ended', 8, pg_temp.inc('r-place'), 2));
select pg_temp.check_case('9 ended again; another facility''s administrator; then room for one more',
  'lead_ended|lead_not_found|ok',
  pg_temp.w_lead_end('end-8-again', 4, (pg_temp.res('lead-8') -> 'body' -> 'lead' ->> 'leadId')::uuid, 'Moved to another unit')
  || '|' || pg_temp.w_lead_end('end-by-b', 13, (pg_temp.res('lead-20') -> 'body' -> 'lead' ->> 'leadId')::uuid,
    'Not our lead to end') || '|' || pg_temp.w_lead_name('lead-29b', 4, 29));
reset role;
select pg_temp.check_case('9 no delete of a lead row', '55000 ehr.quality_leads is append-only',
  pg_temp.refused('delete from ehr.quality_leads'));
select pg_temp.check_case('9 the ended lead''s row is kept', '1/Moved to another unit',
  (select count(*) || '/' || min(end_reason) from ehr.quality_leads where membership_id = pg_temp.member(8)));
select pg_temp.check_case('9 the lead audit rows', 'quality.lead.end:success:1,quality.lead.name:success:11',
  (select string_agg(action || ':' || outcome || ':' || n, ',' order by action, outcome)
     from (select action, outcome, count(*) as n from audit.events
            where action like 'quality.lead.%' and action <> 'quality.lead.list' and outcome = 'success'
              and coalesce(details ->> 'replayed', 'false') = 'false'
            group by action, outcome) grouped));

-- 10. Audit: as the staff member, for healthcare-operations; no text, place, reason, name, date of birth or
-- Health ID in any quality audit row.
select pg_temp.check_case('10 every quality audit row', 'staff/healthcare-operations/ehr-api/application/0',
  (select concat_ws('/', min(actor_type), min(purpose_of_use), min(source_system), min(provenance), count(reason))
     from audit.events where action like 'quality.%'));
select pg_temp.check_case('10 no free text, name, date of birth or Health ID in any quality audit row', '0',
  (select count(*)::text from audit.events event_row
     join (select title as value from ehr.quality_incidents union select description from ehr.quality_incidents
           union select location_text from ehr.quality_incidents where location_text is not null
           union select immediate_action from ehr.quality_incidents where immediate_action is not null
           union select text_value from ehr.quality_incident_events where text_value is not null
           union select reason from ehr.quality_incident_events where reason is not null
           union select description from ehr.quality_incident_actions
           union select note from ehr.quality_incident_actions where note is not null
           union select end_reason from ehr.quality_leads where end_reason is not null
           union select full_name from identity.patients where id::text like 'e1970400-%'
           union select hid_code from identity.patients where id::text like 'e1970400-%'
           union select to_char(dob, 'YYYY-MM-DD') from identity.patients where id::text like 'e1970400-%') secret
       on event_row.details::text like '%' || secret.value || '%' or event_row.resource_id = secret.value
    where event_row.action like 'quality.%'));
select pg_temp.check_case('10 a read shows the patient column only when a manager was shown the patient', 'manager:true,reviewer:false',
  (select string_agg(view_name || ':' || shown, ',' order by view_name)
     from (select details ->> 'view' as view_name, bool_or(patient_id is not null)::text as shown from audit.events
            where action = 'quality.incident.read' and outcome = 'success'
              and resource_id = pg_temp.inc('p-registered')::text group by 1) grouped));
select pg_temp.check_case('10 a list row: the count, ids and the kinds of filter used', 'manager/["status", "category", "harmLevel", "departmentCode", "occurredFrom", "occurredTo"]/1',
  (select concat_ws('/', details ->> 'view', details -> 'filters', jsonb_array_length(details -> 'incidentIds'))
     from audit.events where action = 'quality.incident.list' and details ->> 'resultCount' = '1'
      and details -> 'filters' ? 'category' and actor_membership_id = pg_temp.member(4)));

-- 11. Row-level security and privileges.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('11 the EHR runtime cannot read the seven tables',
  '42501,42501,42501,42501,42501,42501,42501',
  concat_ws(',', split_part(pg_temp.refused('select 1 from ehr.quality_list_versions'), ' ', 1),
    split_part(pg_temp.refused('select 1 from ehr.quality_list_items'), ' ', 1),
    split_part(pg_temp.refused('select 1 from ehr.quality_switches'), ' ', 1),
    split_part(pg_temp.refused('select 1 from ehr.quality_leads'), ' ', 1),
    split_part(pg_temp.refused('select 1 from ehr.quality_incidents'), ' ', 1),
    split_part(pg_temp.refused('select 1 from ehr.quality_incident_actions'), ' ', 1),
    split_part(pg_temp.refused('select 1 from ehr.quality_incident_events'), ' ', 1)));
select pg_temp.check_case('11 nor call a helper', '42501',
  split_part(pg_temp.refused('select ehr.quality_patient_of_facility(''e1970400-0000-4000-8000-000000000001'', ''e1970000-0000-4000-8000-000000000002'')'), ' ', 1));
reset role;
select pg_temp.check_case('11 EXECUTE: the EHR runtime on the fifteen, nobody on the helpers', '15/0/0/0',
  (select count(*) from pg_proc where pronamespace = 'ehr'::regnamespace and proname like 'quality\_%'
      and has_function_privilege('hid_ehr_runtime', oid, 'execute')) || '/'
  || (select count(*) from pg_proc where pronamespace = 'ehr'::regnamespace and proname like 'quality\_%'
      and has_function_privilege('hid_identity_api_runtime', oid, 'execute')) || '/'
  || (select count(*) from pg_proc where pronamespace = 'ehr'::regnamespace and proname like 'quality\_%'
      and not prosecdef and has_function_privilege('hid_ehr_runtime', oid, 'execute')) || '/'
  || (select count(*) from pg_class where relnamespace = 'ehr'::regnamespace and relname like 'quality\_%'
      and (has_table_privilege('hid_ehr_runtime', oid, 'select') or has_table_privilege('public', oid, 'select'))));
select pg_temp.check_case('11 forced on all seven, one owner policy each', '7/7',
  (select count(*) from pg_class where relnamespace = 'ehr'::regnamespace and relname like 'quality\_%' and relkind = 'r'
      and relrowsecurity and relforcerowsecurity) || '/'
  || (select count(*) from pg_policy where polrelid in (select oid from pg_class
       where relnamespace = 'ehr'::regnamespace and relname like 'quality\_%')));
-- The owner sees only the session facility's rows (the suite takes the owner's role).
do $$
begin
  execute format('set local role %I', (select pg_get_userbyid(proowner) from pg_proc
    where oid = 'ehr.quality_me()'::regprocedure));
end $$;
select set_config('app.facility_id', 'e1970000-0000-4000-8000-000000000012', true);
select pg_temp.check_case('11 the owner at B''s session sees B''s incidents only, and the lists', '3/0/16/1',
  (select count(*) from ehr.quality_incidents) || '/'
  || (select count(*) from ehr.quality_incidents where facility_id = 'e1970000-0000-4000-8000-000000000002') || '/'
  || (select count(*) from ehr.quality_list_items) || '/' || (select count(*) from ehr.quality_switches));
select set_config('app.facility_id', '', true);
select pg_temp.check_case('11 the owner with no session facility sees no incident, event, action or lead', '0/0/0/0',
  (select count(*) from ehr.quality_incidents) || '/' || (select count(*) from ehr.quality_incident_events) || '/'
  || (select count(*) from ehr.quality_incident_actions) || '/' || (select count(*) from ehr.quality_leads));
reset role;

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.q_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0197-0198 quality and safety reporting:\n%', mismatch;
  end if;
  raise notice '0197-0198 quality and safety reporting: % cases passed', (select count(*) from pg_temp.q_outcomes);
end $$;

rollback;
