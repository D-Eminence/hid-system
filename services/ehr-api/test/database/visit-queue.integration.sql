\set ON_ERROR_STOP on
-- 0135 (EHR-C7; owner decisions of 18 November 2026): the waiting list.
-- Rollback-only. The waiting-list commands run as ehr-api's login role
-- (hid_ehr_api_runtime) and the patient searches that hand out matchRefs as
-- identity-api's (hid_identity_api_runtime), each in the context its
-- service's transactions set. Needs 0130, 0131 and 0132 applied with 0135.
-- Fictional people, places and identifiers only; ids start e1350.
--
--   1. check-in by matchRef: a desk search's matchRef checks the patient in
--      (basis search, stage waiting, the card); a second check-in answers
--      already_open with the same row; the matchRef of another member, of
--      another facility, an expired one, an emergency search's, and a made-up
--      one are refused; a malformed one, both and neither are invalid;
--   2. check-in by patient id: only a patient already this facility's own
--      (registered at this desk, or a consented visit here) checks in; a
--      patient found by search but not ours, an inactive or sealed patient
--      and an unknown id are refused, all with the same answer;
--   3. who may: front desk, nurse, clinician and doctor; lab, pharmacy and
--      administrator staff are refused (no encounter read and write);
--      direct care only;
--   4. the list: this facility's cards (name, sex, date of birth, last 4 of
--      the Health ID), never another facility's; the deny-directive patient
--      listed and marked chart_blocked; the clinical tables still refuse the
--      desk; the runtime cannot read the table or call the card helper;
--   5. a check-in is not an ID-4 basis: no visit is written, and 0131's
--      own_facility_basis stays null for a patient checked in by search;
--   6. stage, triage level and assignee: updated, changed (row version),
--      assignee_invalid (the desk, another facility's doctor), closed,
--      not_found (another facility's member), invalid input; most urgent
--      first; a closed row leaves the open list, shows with closed today,
--      and the patient can be checked in again;
--   7. at most 200 cards, has_more, and 200 shown rows audited;
--   8. audit rows: check-in, list (one collection row and one row per
--      patient shown) and update, with their outcomes.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.
begin;

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'visit-queue-test'),
  ('emergency', 'Emergency care', 'visit-queue-test')
  on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1350000-0000-4000-8000-000000000001', 'Queue Group A', 'queue-group-a'),
  ('e1350000-0000-4000-8000-000000000011', 'Queue Group B', 'queue-group-b'),
  ('e1350000-0000-4000-8000-000000000021', 'Queue Group C', 'queue-group-c');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000001', 'Queue Clinic A',
   'QUEUE-A', 'Africa/Lagos', true, 'verified'),
  ('e1350000-0000-4000-8000-000000000012', 'e1350000-0000-4000-8000-000000000011', 'Queue Clinic B',
   'QUEUE-B', 'Africa/Lagos', true, 'verified'),
  ('e1350000-0000-4000-8000-000000000022', 'e1350000-0000-4000-8000-000000000021', 'Queue Clinic C',
   'QUEUE-C', 'Africa/Lagos', true, 'verified');
create temporary table q_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into q_members values
  (1, 'e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000001', 'receptionist', 'Ada Desk'),
  (2, 'e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000001', 'nurse', 'Bola Nurse'),
  (3, 'e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000001', 'doctor', 'Chidi Doctor'),
  (4, 'e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000001', 'lab', 'Dayo Lab'),
  (5, 'e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000001', 'pharmacist', 'Efe Pharmacist'),
  (6, 'e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000001', 'clinician', 'Femi Clinician'),
  (7, 'e1350000-0000-4000-8000-000000000012', 'e1350000-0000-4000-8000-000000000011', 'receptionist', 'Gbenga Desk'),
  (8, 'e1350000-0000-4000-8000-000000000012', 'e1350000-0000-4000-8000-000000000011', 'doctor', 'Hauwa Doctor'),
  (9, 'e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000001', 'admin', 'Ife Admin'),
  (10, 'e1350000-0000-4000-8000-000000000022', 'e1350000-0000-4000-8000-000000000021', 'receptionist', 'Jide Desk');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1350100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:queue-member-' || n,
  'queue-member-' || n || '@example.invalid', name, 'active' from q_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1350200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1350100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'queue-member-' || n || '@example.invalid', 'verified', role_code from q_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1350300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1350200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1350100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, organization, facility, role_code, role_code,
  true, true
from q_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('e1350100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
  ('e1350300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, facility, 'Synthetic waiting-list suite role'
from q_members;

-- Patients (Health IDs HID-QW + two letters): p1 found by search, not ours; p2 registered at A's desk without a
-- NIN; p3 found by search, with a deny directive; p4 inactive; p5 sealed demo; p6 a consented visit at A;
-- p7 found by search, checked in again after leaving.
create temporary table q_patients (n integer primary key, hid text, first text, last text, sex text, status text,
  source text) on commit drop;
insert into q_patients values
  (1, 'HID-QWAA22', 'Amaka', 'Queueone', 'female', 'active', 'hid'),
  (2, 'HID-QWAB22', 'Bayo', 'Queuetwo', 'male', 'active', 'hid-desk-registration'),
  (3, 'HID-QWAC22', 'Chiamaka', 'Queuethree', 'female', 'active', 'hid'),
  (4, 'HID-QWAD22', 'Dele', 'Queuefour', 'male', 'inactive', 'hid'),
  (5, 'HID-QWAE22', 'Ebere', 'Queuefive', 'female', 'active', 'hid'),
  (6, 'HID-QWAF22', 'Funmi', 'Queuesix', 'female', 'active', 'hid'),
  (7, 'HID-QWAG22', 'Gozie', 'Queueseven', 'male', 'active', 'hid');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
select ('e1350400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, hid, first, last, first || ' ' || last,
  sex, date '1990-01-01' + n, status, source from q_patients;
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('patient', 'e1350400-0000-4000-8000-000000000005');
-- p2: registered at A's desk without a NIN (0130), which created the record.
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, idempotency_key, request_sha256,
  resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id,
  review_reason, created_at, updated_at)
values ('e1350500-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000002',
  'e1350100-0000-4000-8000-000000000001', 'e1350300-0000-4000-8000-000000000001', 'approved_new_identity',
  'Bayo', 'Queuetwo', 'Bayo Queuetwo', date '1990-01-03', 'none', 'no_nin', 'queue-case-key-000002', repeat('0', 64),
  'e1350400-0000-4000-8000-000000000002', 'queue-review-key-000002', repeat('0', 64),
  'e1350100-0000-4000-8000-000000000001', 'e1350300-0000-4000-8000-000000000001', 'Checked at the desk',
  clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days');
-- p6: a visit at A a month ago that doctor 3 started under the patient's approval.
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass, created_at) values
  ('e1350700-0000-4000-8000-000000000006', null, 'e1350400-0000-4000-8000-000000000006',
   'e1350200-0000-4000-8000-000000000003', 'e1350100-0000-4000-8000-000000000003',
   'e1350300-0000-4000-8000-000000000003', 'e1350000-0000-4000-8000-000000000002', 'write_records', 'direct-care',
   'expired', 'e1350400-0000-4000-8000-000000000006', 'Fixture grant', clock_timestamp() - interval '31 days',
   clock_timestamp() - interval '30 days', false, clock_timestamp() - interval '31 days');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, ended_at, chief_complaint, created_at) values
  ('e1350800-0000-4000-8000-000000000006', 'e1350400-0000-4000-8000-000000000006',
   'e1350000-0000-4000-8000-000000000002', 'e1350100-0000-4000-8000-000000000003',
   'e1350300-0000-4000-8000-000000000003', 'ambulatory', 'completed', clock_timestamp() - interval '30 days' - interval '1 hour',
   clock_timestamp() - interval '30 days', 'Fixture visit', clock_timestamp() - interval '30 days' - interval '1 hour');
-- p3: a deny directive for every action and purpose.
insert into identity.consent_directives (id, patient_id, current_version)
values ('e1350900-0000-4000-8000-000000000001', 'e1350400-0000-4000-8000-000000000003', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  starts_at, grantee_type, actions, purposes, source_reference, reason, content_sha256)
values ('e1350900-0000-4000-8000-000000000002', 'e1350900-0000-4000-8000-000000000001',
  'e1350400-0000-4000-8000-000000000003', 1, 'active', 'deny', clock_timestamp() - interval '1 day', 'all',
  array[]::text[], array[]::text[], 'visit-queue-suite', 'The patient refuses all access', repeat('0', 64));
-- Facility C: 205 fictional patients already on its open list (checked in by member 10), for the 200 cap.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
select ('e1350410-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'HID-QX' || translate(lpad(n::text, 4, '0'), '0123456789', 'ABCDEFGHJK'),
  'Cap', 'Person' || n, 'Cap Person' || n, 'male', date '1970-01-01' + n, 'active', 'hid'
from generate_series(1, 205) n;
insert into ehr.visit_queue (facility_id, patient_id, queue_day, check_in_basis, checked_in_by_account_id,
  checked_in_by_membership_id, checked_in_at, stage_changed_at, updated_by_membership_id)
select 'e1350000-0000-4000-8000-000000000022', ('e1350410-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ((clock_timestamp() - make_interval(secs => n)) at time zone 'Africa/Lagos')::date, 'search',
  'e1350100-0000-4000-8000-000000000010', 'e1350300-0000-4000-8000-000000000010',
  clock_timestamp() - make_interval(secs => n), clock_timestamp() - make_interval(secs => n),
  'e1350300-0000-4000-8000-000000000010'
from generate_series(1, 205) n;
set local session_replication_role = origin;

create temporary table q_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
grant select, insert on pg_temp.q_outcomes to hid_ehr_api_runtime, hid_identity_api_runtime;
grant usage on sequence pg_temp.q_outcomes_seq_seq to hid_ehr_api_runtime, hid_identity_api_runtime;
grant select on pg_temp.q_members to hid_ehr_api_runtime, hid_identity_api_runtime;
create temporary table q_refs (name text primary key, ref text) on commit drop;
grant select, insert, update on pg_temp.q_refs to hid_ehr_api_runtime, hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.q_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.as_member(n integer, purpose text default 'direct-care') returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:queue-member-' || n, true),
    set_config('app.membership_id', 'e1350300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'), true),
    set_config('app.facility_id', (select facility::text from pg_temp.q_members where q_members.n = as_member.n), true),
    set_config('app.correlation_id', 'queue-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;
-- A standard search (first name, last name, date of birth) by member n, as identity-api; keeps the first card's
-- matchRef under ref_name and answers the outcome.
create function pg_temp.search(n integer, first text, last text, dob date, ref_name text) returns text
language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from identity.staff_patient_search('standard', first, last, dob, null, null, null, null) limit 1;
  insert into pg_temp.q_refs (name, ref) values (ref_name, answer.match_ref)
    on conflict (name) do update set ref = excluded.ref;
  return answer.outcome;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.ref(ref_name text) returns text language sql as $f$
  select ref from pg_temp.q_refs where name = ref_name
$f$;
-- One check-in: outcome/basis/stage/name/sex/dob/last4, or the refusal's code and message.
create function pg_temp.check_in(n integer, match_ref text, patient uuid, purpose text default 'direct-care')
returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n, purpose);
  select * into answer from ehr.visit_queue_check_in(match_ref, patient);
  perform set_config('queue_test.last_entry', coalesce(answer.entry_id::text, ''), true);
  perform set_config('queue_test.last_version', coalesce(answer.row_version::text, ''), true);
  if answer.outcome = 'refused' then
    return format('refused/%s', coalesce(answer.entry_id::text, '-'));
  end if;
  return format('%s/%s/%s/%s/%s/%s/%s', answer.outcome, answer.check_in_basis, answer.stage, answer.full_name,
    answer.sex, answer.date_of_birth, answer.health_id_last4);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- One update: outcome/stage/triage/assignee-member-number/closed, or the code and message.
create function pg_temp.update_entry(n integer, entry uuid, version bigint, stage text, triage smallint,
  clear_triage boolean, assignee integer, clear_assignee boolean) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.visit_queue_update(entry, version, stage, triage, clear_triage,
    case when assignee is null then null
         else ('e1350300-0000-4000-8000-0000000000' || lpad(assignee::text, 2, '0'))::uuid end, clear_assignee);
  perform set_config('queue_test.last_version', coalesce(answer.row_version::text, ''), true);
  return format('%s/%s/%s/%s/%s', answer.outcome, coalesce(answer.stage, '-'), coalesce(answer.triage_level::text, '-'),
    coalesce(right(answer.assigned_membership_id::text, 2), '-'), (answer.closed_at is not null)::text);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The list as member n: patient last names in order (a deny-directive patient marked !), and has_more.
create function pg_temp.list(n integer, include_closed boolean default false, purpose text default 'direct-care')
returns text language plpgsql as $f$
declare
  answer text;
begin
  perform pg_temp.as_member(n, purpose);
  select coalesce(string_agg(split_part(listed.full_name, ' ', 2) || case when listed.chart_blocked then '!' else '' end,
           ',' order by listed.ord), '(empty)') || '/' || coalesce(bool_or(listed.has_more), false)::text
    into answer from ehr.visit_queue_list(include_closed) listed;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- (The suite's own lookups read the table as the suite's owner, not as a runtime.)
create function pg_temp.entry_of(patient integer) returns uuid language sql security definer as $f$
  select id from ehr.visit_queue
   where patient_id = ('e1350400-0000-4000-8000-0000000000' || lpad(patient::text, 2, '0'))::uuid
   order by checked_in_at desc limit 1
$f$;
create function pg_temp.version_of(patient integer) returns bigint language sql security definer as $f$
  select row_version from ehr.visit_queue
   where patient_id = ('e1350400-0000-4000-8000-0000000000' || lpad(patient::text, 2, '0'))::uuid
   order by checked_in_at desc limit 1
$f$;

-- 1. Check-in by matchRef.
set local role hid_identity_api_runtime;
select pg_temp.check_case('1 the desk finds p1', 'found', pg_temp.search(1, 'Amaka', 'Queueone', date '1990-01-02', 'p1'));
select pg_temp.check_case('1 the desk finds p3', 'found', pg_temp.search(1, 'Chiamaka', 'Queuethree', date '1990-01-04', 'p3'));
select pg_temp.check_case('1 the desk finds p7', 'found', pg_temp.search(1, 'Gozie', 'Queueseven', date '1990-01-08', 'p7'));
select pg_temp.check_case('1 the nurse finds p1', 'found', pg_temp.search(2, 'Amaka', 'Queueone', date '1990-01-02', 'p1-nurse'));
select pg_temp.check_case('1 B''s desk finds p1', 'found', pg_temp.search(7, 'Amaka', 'Queueone', date '1990-01-02', 'p1-b'));
select pg_temp.check_case('1 the desk finds p1 again (to expire)', 'found',
  pg_temp.search(1, 'Amaka', 'Queueone', date '1990-01-02', 'p1-old'));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 another member''s matchRef', 'refused/-', pg_temp.check_in(1, pg_temp.ref('p1-nurse'), null));
select pg_temp.check_case('1 another facility''s matchRef', 'refused/-', pg_temp.check_in(1, pg_temp.ref('p1-b'), null));
select pg_temp.check_case('1 a made-up matchRef', 'refused/-',
  pg_temp.check_in(1, 'psr_' || repeat('A', 43), null));
select pg_temp.check_case('1 a malformed matchRef', '22023 VISIT_QUEUE_CHECK_IN_INVALID',
  pg_temp.check_in(1, 'psr bad ref', null));
select pg_temp.check_case('1 both', '22023 VISIT_QUEUE_CHECK_IN_INVALID',
  pg_temp.check_in(1, pg_temp.ref('p1'), 'e1350400-0000-4000-8000-000000000001'));
select pg_temp.check_case('1 neither', '22023 VISIT_QUEUE_CHECK_IN_INVALID', pg_temp.check_in(1, null, null));
select pg_temp.check_case('1 an empty matchRef is neither', '22023 VISIT_QUEUE_CHECK_IN_INVALID',
  pg_temp.check_in(1, '  ', null));
reset role;
-- The 'p1-old' matchRef made 11 minutes ago; an emergency search's matchRef for p1 (written as 0132 writes one).
update identity.patient_search_refs
   set created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes'
 where token_sha256 = encode(sha256(convert_to(pg_temp.ref('p1-old'), 'UTF8')), 'hex');
insert into pg_temp.q_refs values ('p1-emergency', 'psr_' || repeat('E', 43));
insert into identity.patient_search_refs (token_sha256, patient_id, account_id, membership_id, facility_id,
  purpose_of_use, search_mode, created_at, expires_at)
values (encode(sha256(convert_to('psr_' || repeat('E', 43), 'UTF8')), 'hex'), 'e1350400-0000-4000-8000-000000000001',
  'e1350100-0000-4000-8000-000000000001', 'e1350300-0000-4000-8000-000000000001',
  'e1350000-0000-4000-8000-000000000002', 'emergency', 'emergency', clock_timestamp(),
  clock_timestamp() + interval '10 minutes');
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 an expired matchRef', 'refused/-', pg_temp.check_in(1, pg_temp.ref('p1-old'), null));
select pg_temp.check_case('1 an emergency search''s matchRef', 'refused/-',
  pg_temp.check_in(1, pg_temp.ref('p1-emergency'), null));
select pg_temp.check_case('1 an emergency search''s matchRef in an emergency session', '22023 VISIT_QUEUE_DIRECT_CARE_ONLY',
  pg_temp.check_in(1, pg_temp.ref('p1-emergency'), null, 'emergency'));
select pg_temp.check_case('1 p1 checked in by matchRef', 'checked_in/search/waiting/Amaka Queueone/female/1990-01-02/AA22',
  pg_temp.check_in(1, pg_temp.ref('p1'), null));
select set_config('queue_test.p1_entry', current_setting('queue_test.last_entry'), true);
select pg_temp.check_case('1 again: already on the list', 'already_open/search/waiting/Amaka Queueone/female/1990-01-02/AA22',
  pg_temp.check_in(1, pg_temp.ref('p1'), null));
select pg_temp.check_case('1 the same row', 'true',
  (current_setting('queue_test.last_entry') = current_setting('queue_test.p1_entry'))::text);
select pg_temp.check_case('1 p3 checked in by matchRef (deny directive)',
  'checked_in/search/waiting/Chiamaka Queuethree/female/1990-01-04/AC22', pg_temp.check_in(1, pg_temp.ref('p3'), null));
select pg_temp.check_case('1 p7 checked in by matchRef', 'checked_in/search/waiting/Gozie Queueseven/male/1990-01-08/AG22',
  pg_temp.check_in(1, pg_temp.ref('p7'), null));

-- 2. Check-in by patient id: only this facility's own patients.
select pg_temp.check_case('2 p2 registered at this desk', 'checked_in/own_facility/waiting/Bayo Queuetwo/male/1990-01-03/AB22',
  pg_temp.check_in(1, null, 'e1350400-0000-4000-8000-000000000002'));
select pg_temp.check_case('2 p6 a consented visit here', 'checked_in/own_facility/waiting/Funmi Queuesix/female/1990-01-07/AF22',
  pg_temp.check_in(2, null, 'e1350400-0000-4000-8000-000000000006'));
select pg_temp.check_case('2 a bare id of a patient found by search', 'refused/-',
  pg_temp.check_in(7, null, 'e1350400-0000-4000-8000-000000000001'));
select pg_temp.check_case('2 a bare id of a patient never seen here', 'refused/-',
  pg_temp.check_in(1, null, 'e1350400-0000-4000-8000-000000000007'));
select pg_temp.check_case('2 p2 at another facility', 'refused/-',
  pg_temp.check_in(7, null, 'e1350400-0000-4000-8000-000000000002'));
select pg_temp.check_case('2 inactive', 'refused/-', pg_temp.check_in(1, null, 'e1350400-0000-4000-8000-000000000004'));
select pg_temp.check_case('2 sealed', 'refused/-', pg_temp.check_in(1, null, 'e1350400-0000-4000-8000-000000000005'));
select pg_temp.check_case('2 unknown id', 'refused/-', pg_temp.check_in(1, null, 'e1350400-0000-4000-8000-000000000099'));

-- 3. Who may.
select pg_temp.check_case('3 clinician', 'already_open/own_facility/waiting/Bayo Queuetwo/male/1990-01-03/AB22',
  pg_temp.check_in(6, null, 'e1350400-0000-4000-8000-000000000002'));
select pg_temp.check_case('3 doctor', 'already_open/own_facility/waiting/Funmi Queuesix/female/1990-01-07/AF22',
  pg_temp.check_in(3, null, 'e1350400-0000-4000-8000-000000000006'));
select pg_temp.check_case('3 lab check-in', '42501 VISIT_QUEUE_NOT_PERMITTED',
  pg_temp.check_in(4, null, 'e1350400-0000-4000-8000-000000000002'));
select pg_temp.check_case('3 pharmacy check-in', '42501 VISIT_QUEUE_NOT_PERMITTED',
  pg_temp.check_in(5, null, 'e1350400-0000-4000-8000-000000000002'));
select pg_temp.check_case('3 administrator check-in', '42501 VISIT_QUEUE_NOT_PERMITTED',
  pg_temp.check_in(9, null, 'e1350400-0000-4000-8000-000000000002'));
select pg_temp.check_case('3 lab list', '42501 VISIT_QUEUE_NOT_PERMITTED', pg_temp.list(4));
select pg_temp.check_case('3 pharmacy list', '42501 VISIT_QUEUE_NOT_PERMITTED', pg_temp.list(5));
select pg_temp.check_case('3 administrator list', '42501 VISIT_QUEUE_NOT_PERMITTED', pg_temp.list(9));
select pg_temp.check_case('3 emergency purpose list', '22023 VISIT_QUEUE_DIRECT_CARE_ONLY', pg_temp.list(1, false, 'emergency'));
select pg_temp.check_case('3 lab update', '42501 VISIT_QUEUE_NOT_PERMITTED',
  pg_temp.update_entry(4, current_setting('queue_test.p1_entry')::uuid, 1, 'triage', null, null, null, null));

-- 4. The list.
select pg_temp.check_case('4 the desk''s list', 'Queueone,Queuethree!,Queueseven,Queuetwo,Queuesix/false', pg_temp.list(1));
select pg_temp.check_case('4 the nurse''s list', 'Queueone,Queuethree!,Queueseven,Queuetwo,Queuesix/false', pg_temp.list(2));
select pg_temp.check_case('4 the doctor''s list', 'Queueone,Queuethree!,Queueseven,Queuetwo,Queuesix/false', pg_temp.list(3));
select pg_temp.check_case('4 another facility''s list', '(empty)/false', pg_temp.list(7));
select pg_temp.as_member(1);
select pg_temp.check_case('4 the card columns', 'Amaka Queueone/female/1990-01-02/AA22/waiting/search/f',
  (select format('%s/%s/%s/%s/%s/%s/%s', full_name, sex, date_of_birth, health_id_last4, stage, check_in_basis, chart_blocked)
     from ehr.visit_queue_list(false) where patient_id = 'e1350400-0000-4000-8000-000000000001'));
select pg_temp.check_case('4 the clinical tables still refuse the desk', '0',
  (select count(*)::text from ehr.encounters where patient_id in ('e1350400-0000-4000-8000-000000000001',
     'e1350400-0000-4000-8000-000000000006')));
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'allowed';
exception when others then
  return sqlstate;
end
$f$;
select pg_temp.check_case('4 no read of the table', '42501', pg_temp.try('select count(*) from ehr.visit_queue'));
select pg_temp.check_case('4 no write of the table', '42501',
  pg_temp.try('update ehr.visit_queue set stage = ''left'''));
select pg_temp.check_case('4 no card helper', '42501',
  pg_temp.try('select * from ehr.visit_queue_cards(array[]::uuid[], null, null, null)'));
reset role;
select pg_temp.check_case('4 EXECUTE on the commands', 'hid_ehr_runtime',
  (select string_agg(distinct grantee.rolname, ',')
     from pg_proc proc, lateral aclexplode(proc.proacl) acl join pg_roles grantee on grantee.oid = acl.grantee
    where proc.oid in ('ehr.visit_queue_check_in(text, uuid)'::regprocedure, 'ehr.visit_queue_list(boolean)'::regprocedure,
                       'ehr.visit_queue_update(uuid, bigint, text, smallint, boolean, uuid, boolean)'::regprocedure)
      and acl.grantee <> proc.proowner));
select pg_temp.check_case('4 identity runtime cannot check in', 'false',
  has_function_privilege('hid_identity_api_runtime', 'ehr.visit_queue_check_in(text, uuid)', 'execute')::text);
select pg_temp.check_case('4 lab runtime cannot list', 'false',
  has_function_privilege('hid_lab_api_runtime', 'ehr.visit_queue_list(boolean)', 'execute')::text);

-- 5. A check-in is not an ID-4 basis.
select pg_temp.check_case('5 p1 is not this facility''s own after check-in', '(null)',
  identity.own_facility_basis('e1350400-0000-4000-8000-000000000001', 'e1350000-0000-4000-8000-000000000002'));
select pg_temp.check_case('5 p7 neither', '(null)',
  identity.own_facility_basis('e1350400-0000-4000-8000-000000000007', 'e1350000-0000-4000-8000-000000000002'));
select pg_temp.check_case('5 no visit written by check-in', '1',
  (select count(*)::text from ehr.encounters where patient_id in (select id from identity.patients
     where hid_code like 'HID-QW%')));
select pg_temp.check_case('5 the doctor still cannot open p1 without a PIN', 'refused',
  (select outcome from (select pg_temp.as_member(3)) context, identity.open_own_facility_patient('HID-QWAA22', null)));

-- 6. Stage, triage level and assignee.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('6 the nurse takes p7 to triage, level 2', 'updated/triage/2/-/false',
  pg_temp.update_entry(2, pg_temp.entry_of(7), 1, 'triage', 2::smallint, null, null, null));
select pg_temp.check_case('6 an old row version', 'changed/triage/2/-/false',
  pg_temp.update_entry(2, pg_temp.entry_of(7), 1, 'ready', null, null, null, null));
select pg_temp.check_case('6 assigned to the doctor', 'updated/ready/2/03/false',
  pg_temp.update_entry(2, pg_temp.entry_of(7), 2, 'ready', null, null, 3, null));
select pg_temp.check_case('6 assigned to the desk', 'assignee_invalid/ready/2/03/false',
  pg_temp.update_entry(2, pg_temp.entry_of(7), 3, null, null, null, 1, null));
select pg_temp.check_case('6 assigned to another facility''s doctor', 'assignee_invalid/ready/2/03/false',
  pg_temp.update_entry(2, pg_temp.entry_of(7), 3, null, null, null, 8, null));
select pg_temp.check_case('6 assigned to the lab', 'assignee_invalid/ready/2/03/false',
  pg_temp.update_entry(2, pg_temp.entry_of(7), 3, null, null, null, 4, null));
select pg_temp.check_case('6 nothing to change', '22023 VISIT_QUEUE_UPDATE_INVALID',
  pg_temp.update_entry(2, pg_temp.entry_of(7), 3, null, null, null, null, null));
select pg_temp.check_case('6 level 6', '22023 VISIT_QUEUE_UPDATE_INVALID',
  pg_temp.update_entry(2, pg_temp.entry_of(7), 3, null, 6::smallint, null, null, null));
select pg_temp.check_case('6 an unknown stage', '22023 VISIT_QUEUE_UPDATE_INVALID',
  pg_temp.update_entry(2, pg_temp.entry_of(7), 3, 'admitted', null, null, null, null));
select pg_temp.check_case('6 set and clear the level at once', '22023 VISIT_QUEUE_UPDATE_INVALID',
  pg_temp.update_entry(2, pg_temp.entry_of(7), 3, null, 1::smallint, true, null, null));
select pg_temp.check_case('6 another facility''s member', 'not_found/-/-/-/false',
  pg_temp.update_entry(7, pg_temp.entry_of(7), 3, 'left', null, null, null, null));
select pg_temp.check_case('6 most urgent first', 'Queueseven,Queueone,Queuethree!,Queuetwo,Queuesix/false', pg_temp.list(1));
select pg_temp.check_case('6 the doctor sees p7', 'updated/with_clinician/2/03/false',
  pg_temp.update_entry(3, pg_temp.entry_of(7), 3, 'with_clinician', null, null, null, null));
select pg_temp.check_case('6 the level and assignee cleared', 'updated/with_clinician/-/-/false',
  pg_temp.update_entry(3, pg_temp.entry_of(7), 4, null, null, true, null, true));
select pg_temp.check_case('6 finished', 'updated/finished/-/-/true',
  pg_temp.update_entry(3, pg_temp.entry_of(7), 5, 'finished', null, null, null, null));
select pg_temp.check_case('6 a closed row', 'closed/finished/-/-/true',
  pg_temp.update_entry(3, pg_temp.entry_of(7), 6, 'waiting', null, null, null, null));
select pg_temp.check_case('6 the open list', 'Queueone,Queuethree!,Queuetwo,Queuesix/false', pg_temp.list(1));
select pg_temp.check_case('6 with closed today', 'Queueone,Queuethree!,Queuetwo,Queuesix,Queueseven/false',
  pg_temp.list(1, true));
reset role;
set local role hid_identity_api_runtime;
select pg_temp.check_case('6 p7 found again', 'found', pg_temp.search(1, 'Gozie', 'Queueseven', date '1990-01-08', 'p7-again'));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('6 p7 checked in again', 'checked_in/search/waiting/Gozie Queueseven/male/1990-01-08/AG22',
  pg_temp.check_in(1, pg_temp.ref('p7-again'), null));
select pg_temp.check_case('6 p1 left', 'updated/left/-/-/true',
  pg_temp.update_entry(1, current_setting('queue_test.p1_entry')::uuid, 1, 'left', null, null, null, null));
reset role;
select pg_temp.check_case('6 one open row per patient per facility', '23505',
  pg_temp.try($s$insert into ehr.visit_queue (facility_id, patient_id, queue_day, check_in_basis, checked_in_by_account_id,
    checked_in_by_membership_id, updated_by_membership_id) values ('e1350000-0000-4000-8000-000000000002',
    'e1350400-0000-4000-8000-000000000002', (clock_timestamp() at time zone 'Africa/Lagos')::date, 'own_facility',
    'e1350100-0000-4000-8000-000000000001', 'e1350300-0000-4000-8000-000000000001',
    'e1350300-0000-4000-8000-000000000001')$s$));
select pg_temp.check_case('6 a closed stage needs closed_at', '23514',
  pg_temp.try($s$update ehr.visit_queue set stage = 'left' where patient_id = 'e1350400-0000-4000-8000-000000000002'$s$));

-- 7. At most 200 cards.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(10);
select pg_temp.check_case('7 200 cards and has_more', '200/t/Person205/Person6',
  (select format('%s/%s/%s/%s', count(*), bool_and(has_more),
     split_part((array_agg(full_name order by ord))[1], ' ', 2), split_part((array_agg(full_name order by ord))[200], ' ', 2))
     from ehr.visit_queue_list(false)));
reset role;
select pg_temp.check_case('7 200 shown rows and one collection row', '200/1/200/t',
  (select format('%s/%s/%s/%s',
     count(*) filter (where action = 'ehr.visit-queue.list.shown'),
     count(*) filter (where action = 'ehr.visit-queue.list'),
     max((details ->> 'resultCount')::integer) filter (where action = 'ehr.visit-queue.list'),
     bool_or((details ->> 'hasMore')::boolean) filter (where action = 'ehr.visit-queue.list'))
     from audit.events where facility_id = 'e1350000-0000-4000-8000-000000000022'));

-- 8. Audit rows at facilities A and B.
select pg_temp.check_case('8 check-in rows', 'denied:11/success:9',
  (select string_agg(format('%s:%s', outcome, count), '/' order by outcome)
     from (select outcome, count(*) from audit.events
            where action = 'ehr.visit-queue.check-in'
              and facility_id in ('e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000012')
            group by outcome) counted));
select pg_temp.check_case('8 check-in refusal kinds', 'match_ref_not_valid:5/not_own_facility_patient:3/patient_not_available:3',
  (select string_agg(format('%s:%s', kind, count), '/' order by kind)
     from (select details ->> 'refusal' as kind, count(*) from audit.events
            where action = 'ehr.visit-queue.check-in' and outcome = 'denied'
              and facility_id in ('e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000012')
            group by 1) counted));
select pg_temp.check_case('8 a not-ours refusal names the patient, an unknown one does not', '3/0',
  (select format('%s/%s', count(*) filter (where details ->> 'refusal' = 'not_own_facility_patient' and patient_id is not null),
     count(*) filter (where details ->> 'refusal' <> 'not_own_facility_patient' and patient_id is not null))
     from audit.events where action = 'ehr.visit-queue.check-in' and outcome = 'denied'
      and facility_id in ('e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000012')));
select pg_temp.check_case('8 list rows at A: collection and per patient', '7/34',
  (select format('%s/%s', count(*) filter (where action = 'ehr.visit-queue.list'),
     count(*) filter (where action = 'ehr.visit-queue.list.shown'))
     from audit.events where facility_id = 'e1350000-0000-4000-8000-000000000002'));
select pg_temp.check_case('8 every shown row names its patient', '0',
  (select count(*)::text from audit.events where action = 'ehr.visit-queue.list.shown' and patient_id is null));
select pg_temp.check_case('8 update rows', 'denied:5/failure:1/success:6',
  (select string_agg(format('%s:%s', outcome, count), '/' order by outcome)
     from (select outcome, count(*) from audit.events
            where action = 'ehr.visit-queue.update'
              and facility_id in ('e1350000-0000-4000-8000-000000000002', 'e1350000-0000-4000-8000-000000000012')
            group by outcome) counted));
select pg_temp.check_case('8 no name, date of birth or Health ID in any waiting-list audit row', '0',
  (select count(*)::text from audit.events
    where action like 'ehr.visit-queue%'
      and (details::text ~* 'queue(one|two|three|six|seven)|amaka|HID-QW|1990-01'
           or coalesce(reason, '') <> '')));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.q_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0135 waiting list:\n%', mismatch;
  end if;
  raise notice '0135 waiting list: % cases passed', (select count(*) from pg_temp.q_outcomes);
end $$;

rollback;
