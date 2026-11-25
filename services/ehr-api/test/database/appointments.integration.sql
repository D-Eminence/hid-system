\set ON_ERROR_STOP on
-- 0160 (APPT-1, Release D; decisions at the recommended options Q-APPT-1 A,
-- Q-APPT-2 A, Q-APPT-5 A and Q-APPT-6 A): appointments, clinics and check-in
-- to the waiting list. Rollback-only, apart from the dblink extension (created
-- before the transaction when the server has it, dropped at the end).
-- Appointment commands run as ehr-api's login role (hid_ehr_api_runtime) and
-- the patient searches that hand out matchRefs as identity-api's
-- (hid_identity_api_runtime), each in the context its service sets.
-- Fictional people, places and identifiers only; ids start e1600.
--
--   1. clinics and the default length: the administrator (organization.manage)
--      creates and changes clinics and the default length, replays answer the
--      first answer, a key reused with another body is refused; the front desk
--      reads them but cannot change them; a name taken (ignoring case) and a
--      department the facility profile does not list are refused;
--   2. booking: by a desk search's matchRef (basis search) and by this
--      facility's own patient (basis own_facility); a bare id of a patient who
--      is not ours, another member's matchRef, an inactive or sealed patient
--      all answer needs_search; time rules (5-minute steps, 15 minutes back, a
--      year ahead); clinic and clinician rules; lengths from the clinic, the
--      facility and 30; the Idempotency-Key replay and reuse;
--   3. clashes: the same clinician overlapping (booked or checked in), the
--      same patient overlapping here, back-to-back allowed, a clinic booking
--      with no clinician has no clinician clash; the booking waits for the
--      clinician's and the patient's advisory locks (a second session holds
--      each), so two parallel bookings are decided one after the other;
--   4. reschedule, cancel and no-show: row versions, statuses, reasons, the
--      reminder reset, no-show only after the start time;
--   5. check-in (Q-APPT-6 A): today's booked appointment without a matchRef
--      opens a waiting-list row with basis appointment; a patient already on
--      the list is linked (already_on_list); another day, identity not
--      confirmed, the nurse (read only), an inactive patient, a matchRef
--      naming another patient are refused; a matchRef naming the patient goes
--      through 0135 (basis search); a no-show of today is undone and recorded;
--      the check-in waits for 0135's per-patient lock (a second session holds
--      it); a check-in is never an own-facility basis (0131 stays null);
--   6. the day list, one appointment with its history, one patient's list,
--      bookable staff; another facility sees nothing of ours;
--   7. who may: front desk, clinician and doctor write; the nurse reads; lab,
--      pharmacy and administrator have no appointment code; direct care only;
--      the runtime reads no table, cannot call the helpers and cannot read or
--      advance the history's sequence (no runtime role holds a privilege on
--      it after runtime-grants.sql); the history cannot be updated or
--      truncated, even by its owner;
--   8. audit rows, and no name, date of birth, Health ID, reason text or
--      clinic name in any of them.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.
select exists (select 1 from pg_available_extensions where name = 'dblink') as a160_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as a160_dblink_create \gset
\if :a160_dblink_available
\if :a160_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'appointments-test'),
  ('emergency', 'Emergency care', 'appointments-test')
  on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1600000-0000-4000-8000-000000000001', 'Booking Group A', 'booking-group-a'),
  ('e1600000-0000-4000-8000-000000000011', 'Booking Group B', 'booking-group-b');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000001', 'Booking Clinic A',
   'BOOK-A', 'Africa/Lagos', true, 'verified'),
  ('e1600000-0000-4000-8000-000000000012', 'e1600000-0000-4000-8000-000000000011', 'Booking Clinic B',
   'BOOK-B', 'Africa/Lagos', true, 'verified');
create temporary table a_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into a_members values
  (1, 'e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000001', 'receptionist', 'Ada Desk'),
  (2, 'e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000001', 'nurse', 'Bola Nurse'),
  (3, 'e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000001', 'doctor', 'Chidi Doctor'),
  (4, 'e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000001', 'lab', 'Dayo Lab'),
  (5, 'e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000001', 'pharmacist', 'Efe Pharmacist'),
  (6, 'e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000001', 'clinician', 'Femi Clinician'),
  (7, 'e1600000-0000-4000-8000-000000000012', 'e1600000-0000-4000-8000-000000000011', 'receptionist', 'Gbenga Desk'),
  (8, 'e1600000-0000-4000-8000-000000000012', 'e1600000-0000-4000-8000-000000000011', 'doctor', 'Hauwa Doctor'),
  (9, 'e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000001', 'admin', 'Ife Admin'),
  (10, 'e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000001', 'doctor', 'Jide Doctor'),
  (11, 'e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000001', 'doctor', 'Kemi Doctor');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1600100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:booking-member-' || n,
  'booking-member-' || n || '@example.invalid', name, 'active' from a_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1600200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1600100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'booking-member-' || n || '@example.invalid', 'verified', role_code from a_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1600300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1600200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1600100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, organization, facility, role_code, role_code,
  true, true
from a_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('e1600100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
  ('e1600300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, facility, 'Synthetic appointments suite role'
from a_members;

-- Patients (Health IDs HID-BK + two letters): p1 found by search, not ours; p2 registered at A's desk without a
-- NIN (ours); p3 found by search, with a deny directive; p4 inactive; p5 sealed demo; p6 found by search, made
-- inactive after booking; p7 found by search, already on A's waiting list.
create temporary table a_patients (n integer primary key, hid text, first text, last text, sex text, status text,
  source text) on commit drop;
insert into a_patients values
  (1, 'HID-BKAA22', 'Amaka', 'Bookone', 'female', 'active', 'hid'),
  (2, 'HID-BKAB22', 'Bayo', 'Booktwo', 'male', 'active', 'hid-desk-registration'),
  (3, 'HID-BKAC22', 'Chiamaka', 'Bookthree', 'female', 'active', 'hid'),
  (4, 'HID-BKAD22', 'Dele', 'Bookfour', 'male', 'inactive', 'hid'),
  (5, 'HID-BKAE22', 'Ebere', 'Bookfive', 'female', 'active', 'hid'),
  (6, 'HID-BKAF22', 'Funmi', 'Booksix', 'female', 'active', 'hid'),
  (7, 'HID-BKAG22', 'Gozie', 'Bookseven', 'male', 'active', 'hid'),
  (8, 'HID-BKAH22', 'Hadiza', 'Bookeight', 'female', 'active', 'hid');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
select ('e1600400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, hid, first, last, first || ' ' || last,
  sex, date '1990-01-01' + n, status, source from a_patients;
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('patient', 'e1600400-0000-4000-8000-000000000005');
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, idempotency_key, request_sha256,
  resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id,
  review_reason, created_at, updated_at)
values ('e1600500-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000002',
  'e1600100-0000-4000-8000-000000000001', 'e1600300-0000-4000-8000-000000000001', 'approved_new_identity',
  'Bayo', 'Booktwo', 'Bayo Booktwo', date '1990-01-03', 'none', 'no_nin', 'booking-case-key-000002', repeat('0', 64),
  'e1600400-0000-4000-8000-000000000002', 'booking-review-key-0002', repeat('0', 64),
  'e1600100-0000-4000-8000-000000000001', 'e1600300-0000-4000-8000-000000000001', 'Checked at the desk',
  clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days');
insert into identity.consent_directives (id, patient_id, current_version)
values ('e1600900-0000-4000-8000-000000000001', 'e1600400-0000-4000-8000-000000000003', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  starts_at, grantee_type, actions, purposes, source_reference, reason, content_sha256)
values ('e1600900-0000-4000-8000-000000000002', 'e1600900-0000-4000-8000-000000000001',
  'e1600400-0000-4000-8000-000000000003', 1, 'active', 'deny', clock_timestamp() - interval '1 day', 'all',
  array[]::text[], array[]::text[], 'appointments-suite', 'The patient refuses all access', repeat('0', 64));
set local session_replication_role = origin;

create temporary table a_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
grant select, insert on pg_temp.a_outcomes to hid_ehr_api_runtime, hid_identity_api_runtime;
grant usage on sequence pg_temp.a_outcomes_seq_seq to hid_ehr_api_runtime, hid_identity_api_runtime;
grant select on pg_temp.a_members to hid_ehr_api_runtime, hid_identity_api_runtime;
create temporary table a_refs (name text primary key, ref text) on commit drop;
grant select, insert, update on pg_temp.a_refs to hid_ehr_api_runtime, hid_identity_api_runtime;
create temporary table a_ids (name text primary key, id uuid, version bigint) on commit drop;
grant select, insert, update on pg_temp.a_ids to hid_ehr_api_runtime, hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.a_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.member(n integer) returns uuid language sql immutable as $f$
  select ('e1600300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.patient(n integer) returns uuid language sql immutable as $f$
  select ('e1600400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.as_member(n integer, purpose text default 'direct-care') returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:booking-member-' || n, true),
    set_config('app.membership_id', pg_temp.member(n)::text, true),
    set_config('app.facility_id', (select facility::text from pg_temp.a_members where a_members.n = as_member.n), true),
    set_config('app.correlation_id', 'booking-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;
-- A 5-minute step: today's (Lagos) step at or before now, moved by the given minutes.
create function pg_temp.slot(minutes integer) returns timestamptz language sql as $f$
  select to_timestamp(floor(extract(epoch from clock_timestamp()) / 300) * 300) + make_interval(mins => minutes)
$f$;
create function pg_temp.key(label text) returns text language sql immutable as $f$
  select 'booking-suite-key-' || label
$f$;
create function pg_temp.sha(label text) returns text language sql immutable as $f$
  select encode(sha256(convert_to(label, 'UTF8')), 'hex')
$f$;
create function pg_temp.search(n integer, first text, last text, dob date, ref_name text) returns text
language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from identity.staff_patient_search('standard', first, last, dob, null, null, null, null) limit 1;
  insert into pg_temp.a_refs (name, ref) values (ref_name, answer.match_ref)
    on conflict (name) do update set ref = excluded.ref;
  return answer.outcome;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.ref(ref_name text) returns text language sql as $f$
  select ref from pg_temp.a_refs where name = ref_name
$f$;
create function pg_temp.id(label text) returns uuid language sql as $f$
  select id from pg_temp.a_ids where name = label
$f$;
create function pg_temp.version(label text) returns bigint language sql as $f$
  select version from pg_temp.a_ids where name = label
$f$;
create function pg_temp.remember(label text, appointment uuid, row_version bigint) returns void language sql as $f$
  insert into pg_temp.a_ids values (label, appointment, row_version)
    on conflict (name) do update set id = coalesce(excluded.id, a_ids.id), version = coalesce(excluded.version, a_ids.version)
$f$;
-- One booking: outcome/replayed/basis/status/name/last4/length/clinic name, or the code and message.
create function pg_temp.book(n integer, label text, match_ref text, patient uuid, department text, clinic uuid,
  clinician integer, starts timestamptz, length_minutes integer, visit text, reason text, key_label text,
  body_label text default null, purpose text default 'direct-care') returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n, purpose);
  select * into answer from ehr.appointment_book(match_ref, patient, department, clinic,
    case when clinician is null then null else pg_temp.member(clinician) end, starts, length_minutes, visit, reason,
    pg_temp.key(key_label), pg_temp.sha(coalesce(body_label, key_label)));
  if answer.appointment_id is not null and label is not null then
    perform pg_temp.remember(label, answer.appointment_id, answer.row_version);
  end if;
  if answer.appointment_id is null then
    return answer.outcome;
  end if;
  return format('%s/%s/%s/%s/%s/%s/%s/%s', answer.outcome, answer.replayed::text, answer.booking_basis, answer.status,
    answer.full_name, answer.health_id_last4, answer.length_minutes, coalesce(answer.clinic_name, '-'));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.reschedule(n integer, label text, version bigint, starts timestamptz, length_minutes integer,
  clinician integer, clear_clinician boolean, reason text, key_label text, body_label text default null) returns text
language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_reschedule(pg_temp.id(label), version, starts, length_minutes,
    case when clinician is null then null else pg_temp.member(clinician) end, clear_clinician, reason,
    pg_temp.key(key_label), pg_temp.sha(coalesce(body_label, key_label)));
  if answer.outcome = 'updated' then
    perform pg_temp.remember(label, null, answer.row_version);
  end if;
  return format('%s/%s/%s/%s/%s', answer.outcome, coalesce(answer.replayed::text, '-'), coalesce(answer.status, '-'),
    coalesce(answer.row_version::text, '-'), coalesce(right(answer.clinician_membership_id::text, 2), '-'));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.cancel(n integer, label text, version bigint, reason text, key_label text) returns text
language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_cancel(pg_temp.id(label), version, reason, pg_temp.key(key_label),
    pg_temp.sha(key_label));
  if answer.outcome = 'updated' then
    perform pg_temp.remember(label, null, answer.row_version);
  end if;
  return format('%s/%s/%s', answer.outcome, coalesce(answer.replayed::text, '-'), coalesce(answer.status, '-'));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.no_show(n integer, label text, version bigint, key_label text) returns text
language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_mark_no_show(pg_temp.id(label), version, pg_temp.key(key_label),
    pg_temp.sha(key_label));
  if answer.outcome = 'updated' then
    perform pg_temp.remember(label, null, answer.row_version);
  end if;
  return format('%s/%s', answer.outcome, coalesce(answer.status, '-'));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- One check-in: outcome/replayed/status/the waiting-list row's basis and stage, or the code and message.
create function pg_temp.check_in(n integer, label text, version bigint, confirmed boolean, match_ref text,
  key_label text) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_check_in(pg_temp.id(label), version, confirmed, match_ref,
    pg_temp.key(key_label), pg_temp.sha(key_label));
  if answer.outcome in ('checked_in', 'already_on_list') then
    perform pg_temp.remember(label, null, answer.row_version);
  end if;
  return format('%s/%s/%s/%s/%s', answer.outcome, coalesce(answer.replayed::text, '-'), coalesce(answer.status, '-'),
    coalesce(answer.entry ->> 'check_in_basis', '-'), coalesce(answer.entry ->> 'stage', '-'));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.clinic(n integer, clinic uuid, version bigint, name text, department text, length_minutes integer,
  clear_length boolean, active boolean, key_label text, body_label text default null) returns text
language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_clinic_save(clinic, version, name, department, length_minutes, clear_length,
    active, pg_temp.key(key_label), pg_temp.sha(coalesce(body_label, key_label)));
  if answer.clinic_id is not null and name is not null then
    perform pg_temp.remember('clinic:' || name, answer.clinic_id, answer.row_version);
  end if;
  return format('%s/%s/%s/%s/%s/%s', answer.outcome, coalesce(answer.replayed::text, '-'), coalesce(answer.name, '-'),
    coalesce(answer.default_length_minutes::text, '-'), coalesce(answer.active::text, '-'),
    coalesce(answer.row_version::text, '-'));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The day list as member n: last names in order (deny directive !), status initials, has_more.
create function pg_temp.day_list(n integer, day date, clinic uuid, clinician integer, statuses text[],
  page_limit integer default 200) returns text language plpgsql as $f$
declare
  answer text;
begin
  perform pg_temp.as_member(n);
  select coalesce(string_agg(split_part(listed.full_name, ' ', 2) || case when listed.chart_blocked then '!' else '' end
           || ':' || listed.status, ',' order by listed.ord), '(empty)') || '/' || coalesce(bool_or(listed.has_more), false)::text
    into answer
    from ehr.appointment_list(day, clinic, case when clinician is null then null else pg_temp.member(clinician) end,
      statuses, page_limit, null, null, null) listed;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.queue_basis(patient integer) returns text language sql security definer as $f$
  select coalesce(string_agg(check_in_basis || ':' || stage, ',' order by checked_in_at), '(none)') from ehr.visit_queue
   where patient_id = pg_temp.patient(patient) and closed_at is null
$f$;

create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ran';
exception when others then
  return sqlstate;
end
$f$;
create function pg_temp.clinic_list(n integer) returns text language plpgsql as $f$
begin
  perform pg_temp.as_member(n);
  return (select coalesce(string_agg(name, ',' order by name), '(none)') from ehr.appointment_clinic_list(false));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.settings_save(n integer, version bigint, length_minutes integer, key_label text,
  body_label text default null) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_settings_save(version, length_minutes, pg_temp.key(key_label),
    pg_temp.sha(coalesce(body_label, key_label)));
  return format('%s/%s/%s/%s', answer.outcome, answer.replayed::text, coalesce(answer.default_length_minutes::text, '-'),
    coalesce(answer.row_version::text, '-'));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

-- 1. Clinics and the default length.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 the desk reads the default length (never set)', '30/0',
  (select format('%s/%s', default_length_minutes, row_version) from (select pg_temp.as_member(1)) setting,
     ehr.appointment_settings_read()));
select pg_temp.check_case('1 the desk cannot set it', '42501 APPOINTMENT_NOT_ALLOWED',
  pg_temp.settings_save(1, 0, 20, 'settings-desk'));
select pg_temp.check_case('1 the administrator sets 20 minutes', 'saved/false/20/1',
  pg_temp.settings_save(9, 0, 20, 'settings-admin'));
select pg_temp.check_case('1 the same key and body: the first answer', 'saved/true/20/1',
  pg_temp.settings_save(9, 0, 20, 'settings-admin'));
select pg_temp.check_case('1 the same key, another body', 'key_reused/false/-/-',
  pg_temp.settings_save(9, 0, 25, 'settings-admin', 'settings-admin-other'));
select pg_temp.check_case('1 a stale version', 'changed/false/-/-', pg_temp.settings_save(9, 0, 25, 'settings-admin-2'));
select pg_temp.check_case('1 a length off the 5-minute step', '22023 APPOINTMENT_INVALID',
  pg_temp.settings_save(9, 1, 22, 'settings-admin-3'));
select pg_temp.check_case('1 the administrator creates a clinic', 'saved/false/Medical outpatients/-/true/1',
  pg_temp.clinic(9, null, null, 'Medical outpatients', 'general_outpatient', null, null, null, 'clinic-1'));
select pg_temp.check_case('1 replayed', 'saved/true/Medical outpatients/-/true/1',
  pg_temp.clinic(9, null, null, 'Medical outpatients', 'general_outpatient', null, null, null, 'clinic-1'));
select pg_temp.check_case('1 a second clinic with its own length', 'saved/false/Antenatal clinic/45/true/1',
  pg_temp.clinic(9, null, null, 'Antenatal clinic', 'maternity', 45, null, null, 'clinic-2'));
select pg_temp.check_case('1 a name taken, ignoring case', 'name_taken/false/-/-/-/-',
  pg_temp.clinic(9, null, null, 'MEDICAL OUTPATIENTS', 'general_outpatient', null, null, null, 'clinic-3'));
select pg_temp.check_case('1 an unknown department', '22023 APPOINTMENT_INVALID',
  pg_temp.clinic(9, null, null, 'Odd clinic', 'not_a_department', null, null, null, 'clinic-4'));
select pg_temp.check_case('1 the desk cannot create one', '42501 APPOINTMENT_NOT_ALLOWED',
  pg_temp.clinic(1, null, null, 'Desk clinic', 'general_outpatient', null, null, null, 'clinic-5'));
select pg_temp.check_case('1 a third clinic', 'saved/false/Dental clinic/-/true/1',
  pg_temp.clinic(9, null, null, 'Dental clinic', 'dental', null, null, null, 'clinic-6'));
select pg_temp.check_case('1 made inactive (kept, never deleted)', 'saved/false/Dental clinic/-/false/2',
  pg_temp.clinic(9, pg_temp.id('clinic:Dental clinic'), 1, null, null, null, null, false, 'clinic-7'));
select pg_temp.check_case('1 its department cannot change', '22023 APPOINTMENT_INVALID',
  pg_temp.clinic(9, pg_temp.id('clinic:Dental clinic'), 2, null, 'general_outpatient', null, null, null, 'clinic-7b'));
select pg_temp.check_case('1 a stale clinic version', 'changed/false/-/-/-/-',
  pg_temp.clinic(9, pg_temp.id('clinic:Dental clinic'), 1, 'Dental surgery', null, null, null, null, 'clinic-8'));
select pg_temp.check_case('1 the desk lists the active clinics', 'Antenatal clinic,Medical outpatients',
  (select string_agg(name, ',' order by name) from (select pg_temp.as_member(1)) setting,
     ehr.appointment_clinic_list(false)));
select pg_temp.check_case('1 the administrator lists all clinics', 'Antenatal clinic,Dental clinic,Medical outpatients',
  (select string_agg(name, ',' order by name) from (select pg_temp.as_member(9)) setting,
     ehr.appointment_clinic_list(true)));
select pg_temp.check_case('1 B''s desk sees none of A''s clinics', '(none)',
  (select coalesce(string_agg(name, ','), '(none)') from (select pg_temp.as_member(7)) setting,
     ehr.appointment_clinic_list(true)));
select pg_temp.check_case('1 the lab member reads no clinic', '42501 APPOINTMENT_NOT_ALLOWED', pg_temp.clinic_list(4));

-- 2. Booking.
set local role hid_identity_api_runtime;
select pg_temp.check_case('2 the desk finds p1', 'found', pg_temp.search(1, 'Amaka', 'Bookone', date '1990-01-02', 'p1'));
select pg_temp.check_case('2 the desk finds p3', 'found', pg_temp.search(1, 'Chiamaka', 'Bookthree', date '1990-01-04', 'p3'));
select pg_temp.check_case('2 the desk finds p6', 'found', pg_temp.search(1, 'Funmi', 'Booksix', date '1990-01-07', 'p6'));
select pg_temp.check_case('2 the desk finds p7', 'found', pg_temp.search(1, 'Gozie', 'Bookseven', date '1990-01-08', 'p7'));
select pg_temp.check_case('2 the nurse finds p1', 'found', pg_temp.search(2, 'Amaka', 'Bookone', date '1990-01-02', 'p1-nurse'));
select pg_temp.check_case('2 the doctor finds p1', 'found', pg_temp.search(3, 'Amaka', 'Bookone', date '1990-01-02', 'p1-doctor'));
select pg_temp.check_case('2 the desk finds p8', 'found', pg_temp.search(1, 'Hadiza', 'Bookeight', date '1990-01-09', 'p8'));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 p1 tomorrow by matchRef, with doctor 3, in a clinic: the facility''s 20 minutes',
  'booked/false/search/booked/Amaka Bookone/AA22/20/Medical outpatients',
  pg_temp.book(1, 'p1-tomorrow', pg_temp.ref('p1'), null, 'general_outpatient', pg_temp.id('clinic:Medical outpatients'),
    3, pg_temp.slot(24 * 60), null, 'follow_up', 'Blood pressure review', 'book-1'));
select pg_temp.check_case('2 the same key and body: the first answer', 'booked/true/search/booked/Amaka Bookone/AA22/20/Medical outpatients',
  pg_temp.book(1, null, pg_temp.ref('p1'), null, 'general_outpatient', pg_temp.id('clinic:Medical outpatients'),
    3, pg_temp.slot(24 * 60), null, 'follow_up', 'Blood pressure review', 'book-1'));
select pg_temp.check_case('2 the same key, another body', 'key_reused',
  pg_temp.book(1, null, pg_temp.ref('p1'), null, 'general_outpatient', null, null, pg_temp.slot(25 * 60), 30,
    'follow_up', null, 'book-1', 'book-1-other'));
select pg_temp.check_case('2 the antenatal clinic''s own 45 minutes', 'booked/false/own_facility/booked/Bayo Booktwo/AB22/45/Antenatal clinic',
  pg_temp.book(1, 'p2-antenatal', null, pg_temp.patient(2), 'maternity', pg_temp.id('clinic:Antenatal clinic'), null,
    pg_temp.slot(3 * 24 * 60), null, 'antenatal', null, 'book-2'));
select pg_temp.check_case('2 an explicit length', 'booked/false/own_facility/booked/Bayo Booktwo/AB22/15/-',
  pg_temp.book(1, 'p2-short', null, pg_temp.patient(2), 'general_outpatient', null, null, pg_temp.slot(4 * 24 * 60), 15,
    'results_review', '', 'book-3'));
select pg_temp.check_case('2 a bare id of a patient found by search but not ours', 'needs_search',
  pg_temp.book(1, null, null, pg_temp.patient(1), 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'new_visit', null, 'book-4'));
select pg_temp.check_case('2 another member''s matchRef', 'needs_search',
  pg_temp.book(1, null, pg_temp.ref('p1-nurse'), null, 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'new_visit', null, 'book-5'));
select pg_temp.check_case('2 a made-up matchRef', 'needs_search',
  pg_temp.book(1, null, 'psr_' || repeat('A', 43), null, 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'new_visit', null, 'book-6'));
select pg_temp.check_case('2 an inactive patient', 'needs_search',
  pg_temp.book(1, null, null, pg_temp.patient(4), 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'new_visit', null, 'book-7'));
select pg_temp.check_case('2 a sealed demo patient', 'needs_search',
  pg_temp.book(1, null, null, pg_temp.patient(5), 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'new_visit', null, 'book-8'));
select pg_temp.check_case('2 an unknown id', 'needs_search',
  pg_temp.book(1, null, null, 'e1600400-0000-4000-8000-000000000099', 'general_outpatient', null, null,
    pg_temp.slot(5 * 24 * 60), null, 'new_visit', null, 'book-9'));
select pg_temp.check_case('2 both a matchRef and a patient', '22023 APPOINTMENT_NEEDS_ONE_PATIENT',
  pg_temp.book(1, null, pg_temp.ref('p1'), pg_temp.patient(2), 'general_outpatient', null, null,
    pg_temp.slot(5 * 24 * 60), null, 'new_visit', null, 'book-10'));
select pg_temp.check_case('2 neither', '22023 APPOINTMENT_NEEDS_ONE_PATIENT',
  pg_temp.book(1, null, null, null, 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null, 'new_visit', null,
    'book-11'));
select pg_temp.check_case('2 a time off the 5-minute step', 'time_invalid',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'general_outpatient', null, null,
    pg_temp.slot(5 * 24 * 60) + interval '2 minutes', null, 'new_visit', null, 'book-12'));
select pg_temp.check_case('2 more than 15 minutes ago', 'time_invalid',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'general_outpatient', null, null, pg_temp.slot(-20), null,
    'new_visit', null, 'book-13'));
select pg_temp.check_case('2 more than a year ahead', 'time_invalid',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'general_outpatient', null, null, pg_temp.slot(367 * 24 * 60), null,
    'new_visit', null, 'book-14'));
select pg_temp.check_case('2 an unknown visit type', '22023 APPOINTMENT_INVALID',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'checkup', null, 'book-15'));
select pg_temp.check_case('2 a reason over 200 characters', '22023 APPOINTMENT_INVALID',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'other', repeat('x', 201), 'book-16'));
select pg_temp.check_case('2 a length of 7 minutes', '22023 APPOINTMENT_INVALID',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), 7,
    'other', null, 'book-17'));
select pg_temp.check_case('2 a clinic of another department', 'clinic_invalid',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'general_outpatient', pg_temp.id('clinic:Antenatal clinic'), null,
    pg_temp.slot(5 * 24 * 60), null, 'other', null, 'book-18'));
select pg_temp.check_case('2 an inactive clinic', 'clinic_invalid',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'dental', pg_temp.id('clinic:Dental clinic'), null,
    pg_temp.slot(5 * 24 * 60), null, 'other', null, 'book-19'));
select pg_temp.check_case('2 the front desk as the clinician', 'clinician_invalid',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'general_outpatient', null, 1, pg_temp.slot(5 * 24 * 60), null,
    'other', null, 'book-20'));
select pg_temp.check_case('2 another facility''s doctor', 'clinician_invalid',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'general_outpatient', null, 8, pg_temp.slot(5 * 24 * 60), null,
    'other', null, 'book-21'));
select pg_temp.check_case('2 the nurse cannot book', '42501 APPOINTMENT_NOT_ALLOWED',
  pg_temp.book(2, null, pg_temp.ref('p1-nurse'), null, 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'other', null, 'book-22'));
select pg_temp.check_case('2 the doctor books with his own search', 'booked/false/search/booked/Amaka Bookone/AA22/20/-',
  pg_temp.book(3, 'p1-doctor', pg_temp.ref('p1-doctor'), null, 'general_outpatient', null, 3, pg_temp.slot(6 * 24 * 60),
    null, 'follow_up', null, 'book-23'));
select pg_temp.check_case('2 emergency purpose', '22023 APPOINTMENT_DIRECT_CARE_ONLY',
  pg_temp.book(1, null, null, pg_temp.patient(2), 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'other', null, 'book-24', null, 'emergency'));
select pg_temp.check_case('2 the lab member cannot book', '42501 APPOINTMENT_NOT_ALLOWED',
  pg_temp.book(4, null, null, pg_temp.patient(2), 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'other', null, 'book-25'));
select pg_temp.check_case('2 the administrator cannot book', '42501 APPOINTMENT_NOT_ALLOWED',
  pg_temp.book(9, null, null, pg_temp.patient(2), 'general_outpatient', null, null, pg_temp.slot(5 * 24 * 60), null,
    'other', null, 'book-26'));

-- 3. Clashes.
select pg_temp.check_case('3 doctor 3 again at the same time', 'clinician_clash',
  pg_temp.book(1, null, pg_temp.ref('p3'), null, 'general_outpatient', null, 3, pg_temp.slot(24 * 60 + 10), 30,
    'new_visit', null, 'clash-1'));
select pg_temp.check_case('3 doctor 3 right after (back to back)', 'booked/false/search/booked/Chiamaka Bookthree/AC22/30/-',
  pg_temp.book(1, 'p3-tomorrow', pg_temp.ref('p3'), null, 'general_outpatient', null, 3, pg_temp.slot(24 * 60 + 20), 30,
    'new_visit', null, 'clash-2'));
select pg_temp.check_case('3 p1 again at the same time with another clinician', 'patient_clash',
  pg_temp.book(1, null, pg_temp.ref('p1'), null, 'general_outpatient', null, 10, pg_temp.slot(24 * 60 + 5), 30,
    'new_visit', null, 'clash-3'));
select pg_temp.check_case('3 p1 at the same time at another facility is no clash here', 'needs_search',
  pg_temp.book(7, null, null, pg_temp.patient(1), 'general_outpatient', null, null, pg_temp.slot(24 * 60), 30,
    'new_visit', null, 'clash-4'));
select pg_temp.check_case('3 a clinic booking with no clinician: no clinician clash', 'booked/false/search/booked/Gozie Bookseven/AG22/20/Medical outpatients',
  pg_temp.book(1, 'p7-tomorrow', pg_temp.ref('p7'), null, 'general_outpatient', pg_temp.id('clinic:Medical outpatients'),
    null, pg_temp.slot(24 * 60), null, 'new_visit', null, 'clash-5'));
\if :a160_dblink_available
reset role;
-- Two bookings in parallel: a second session holds doctor 11's advisory lock (as another booking does until it
-- commits); a booking for doctor 11 waits for it, so it decides only after the other booking.
select public.dblink_connect('a160_other',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select public.dblink_exec('a160_other', 'begin') as began \gset
select public.dblink_exec('a160_other', format('do $d$ begin perform pg_advisory_xact_lock(hashtextextended(%L, 0)); end $d$',
  'appointment-clinician:e1600000-0000-4000-8000-000000000002:' || pg_temp.member(11))) as locked \gset
set local role hid_ehr_api_runtime;
set local lock_timeout = '300ms';
select pg_temp.check_case('3 a parallel booking for the same clinician waits for the first', '55P03 canceling statement due to lock timeout',
  pg_temp.book(1, null, pg_temp.ref('p8'), null, 'general_outpatient', null, 11, pg_temp.slot(2 * 24 * 60), 30,
    'new_visit', null, 'clash-6'));
reset role;
select public.dblink_exec('a160_other', 'rollback') as ended \gset
select public.dblink_exec('a160_other', 'begin') as began \gset
select public.dblink_exec('a160_other', format('do $d$ begin perform pg_advisory_xact_lock(hashtextextended(%L, 0)); end $d$',
  'appointment-patient:e1600000-0000-4000-8000-000000000002:' || pg_temp.patient(8))) as locked \gset
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 a parallel booking for the same patient waits for the first', '55P03 canceling statement due to lock timeout',
  pg_temp.book(1, null, pg_temp.ref('p8'), null, 'general_outpatient', null, null, pg_temp.slot(2 * 24 * 60), 30,
    'new_visit', null, 'clash-7'));
reset role;
select public.dblink_exec('a160_other', 'rollback') as ended \gset
set local lock_timeout = '0';
set local role hid_ehr_api_runtime;
\else
\echo 'appointments suite: dblink is not available on this server, so the parallel cases of 3 and 5 are skipped'
\endif

-- 4. Reschedule, cancel, no-show.
select pg_temp.check_case('4 p1 moved by 2 hours to doctor 10', 'updated/false/booked/2/10',
  pg_temp.reschedule(1, 'p1-tomorrow', 1, pg_temp.slot(24 * 60 + 120), null, 10, false, 'Clinic moved to afternoon',
    'move-1'));
select pg_temp.check_case('4 replayed', 'updated/true/booked/2/10',
  pg_temp.reschedule(1, 'p1-tomorrow', 1, pg_temp.slot(24 * 60 + 120), null, 10, false, 'Clinic moved to afternoon',
    'move-1'));
select pg_temp.check_case('4 a stale version', 'changed/false/booked/2/10',
  pg_temp.reschedule(1, 'p1-tomorrow', 1, pg_temp.slot(24 * 60 + 180), null, null, false, 'Another move again', 'move-2'));
select pg_temp.check_case('4 a reason under 8 characters', '22023 APPOINTMENT_INVALID',
  pg_temp.reschedule(1, 'p1-tomorrow', 2, pg_temp.slot(24 * 60 + 180), null, null, false, 'short', 'move-3'));
select pg_temp.check_case('4 onto doctor 3''s other patient', 'clinician_clash/false/booked/2/10',
  pg_temp.reschedule(1, 'p1-tomorrow', 2, pg_temp.slot(24 * 60 + 20), null, 3, false, 'Back to doctor three', 'move-4'));
select pg_temp.check_case('4 the clinician taken away', 'updated/false/booked/3/-',
  pg_temp.reschedule(1, 'p1-tomorrow', 2, pg_temp.slot(24 * 60 + 120), null, null, true, 'Any clinician will do', 'move-5'));
reset role;
update ehr.appointments set reminder_sent_at = clock_timestamp() where id = pg_temp.id('p1-tomorrow');
set local role hid_ehr_api_runtime;
select pg_temp.check_case('4 a move after the reminder', 'updated/false/booked/4/-',
  pg_temp.reschedule(1, 'p1-tomorrow', 3, pg_temp.slot(24 * 60 + 125), null, null, false, 'Five minutes later please', 'move-7'));
reset role;
select pg_temp.check_case('4 the reminder is reset', 'true',
  (select (reminder_sent_at is null)::text from ehr.appointments where id = pg_temp.id('p1-tomorrow')));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('4 cancel p2''s short visit', 'updated/false/cancelled',
  pg_temp.cancel(1, 'p2-short', 1, 'Patient called to cancel', 'cancel-1'));
select pg_temp.check_case('4 cancel replayed', 'updated/true/cancelled',
  pg_temp.cancel(1, 'p2-short', 1, 'Patient called to cancel', 'cancel-1'));
select pg_temp.check_case('4 cancel again', 'not_booked/false/cancelled',
  pg_temp.cancel(1, 'p2-short', 2, 'Patient called to cancel', 'cancel-2'));
select pg_temp.check_case('4 a cancelled one cannot be moved', 'not_booked/false/cancelled/2/-',
  pg_temp.reschedule(1, 'p2-short', 2, pg_temp.slot(4 * 24 * 60 + 60), null, null, false, 'Bring it back again', 'move-6'));
select pg_temp.check_case('4 no-show before the start', 'too_early/booked',
  pg_temp.no_show(1, 'p2-antenatal', 1, 'no-show-1'));
select pg_temp.check_case('4 B''s desk cannot touch A''s appointment', 'not_found/false/-',
  pg_temp.cancel(7, 'p2-antenatal', 1, 'Wrong facility cancel', 'cancel-3'));

-- 5. Check-in.
-- p6: booked for 5 minutes before the current 5-minute step today, then made inactive; p2: booked today and on
-- nobody's list; p7: today, and already on A's waiting list (checked in by search through 0135); p3: today.
select pg_temp.check_case('5 p2 today', 'booked/false/own_facility/booked/Bayo Booktwo/AB22/20/-',
  pg_temp.book(1, 'p2-today', null, pg_temp.patient(2), 'general_outpatient', null, null, pg_temp.slot(-5), null,
    'follow_up', null, 'today-2'));
select pg_temp.check_case('5 p6 today', 'booked/false/search/booked/Funmi Booksix/AF22/20/-',
  pg_temp.book(1, 'p6-today', pg_temp.ref('p6'), null, 'general_outpatient', null, null, pg_temp.slot(-5), null,
    'follow_up', null, 'today-6'));
select pg_temp.check_case('5 p7 today', 'booked/false/search/booked/Gozie Bookseven/AG22/20/-',
  pg_temp.book(1, 'p7-today', pg_temp.ref('p7'), null, 'general_outpatient', null, null, pg_temp.slot(-5), null,
    'follow_up', null, 'today-7'));
select pg_temp.check_case('5 p3 today (no-show first)', 'booked/false/search/booked/Chiamaka Bookthree/AC22/20/-',
  pg_temp.book(1, 'p3-today', pg_temp.ref('p3'), null, 'general_outpatient', null, null, pg_temp.slot(-5), null,
    'follow_up', null, 'today-3'));
select pg_temp.check_case('5 p7 checked in by 0135 already', 'checked_in',
  (select outcome from (select pg_temp.as_member(1)) setting, ehr.visit_queue_check_in(pg_temp.ref('p7'), null)));
select pg_temp.check_case('5 identity not confirmed', '22023 APPOINTMENT_IDENTITY_NOT_CONFIRMED',
  pg_temp.check_in(1, 'p2-today', 1, false, null, 'in-0'));
select pg_temp.check_case('5 the nurse (read only)', '42501 APPOINTMENT_NOT_ALLOWED',
  pg_temp.check_in(2, 'p2-today', 1, true, null, 'in-nurse'));
select pg_temp.check_case('5 another day', 'wrong_day/false/booked/-/-',
  pg_temp.check_in(1, 'p1-tomorrow', pg_temp.version('p1-tomorrow'), true, null, 'in-1'));
select pg_temp.check_case('5 a stale version', 'changed/false/booked/-/-',
  pg_temp.check_in(1, 'p2-today', 7, true, null, 'in-2'));
\if :a160_dblink_available
reset role;
select public.dblink_exec('a160_other', 'begin') as began \gset
select public.dblink_exec('a160_other', format('do $d$ begin perform pg_advisory_xact_lock(hashtextextended(%L, 0)); end $d$',
  'visit-queue:e1600000-0000-4000-8000-000000000002:' || pg_temp.patient(2))) as locked \gset
set local role hid_ehr_api_runtime;
set local lock_timeout = '300ms';
select pg_temp.check_case('5 the check-in waits for 0135''s per-patient lock', '55P03 canceling statement due to lock timeout',
  pg_temp.check_in(1, 'p2-today', 1, true, null, 'in-locked'));
reset role;
select public.dblink_exec('a160_other', 'rollback') as ended \gset
select public.dblink_disconnect('a160_other') as disconnected \gset
set local lock_timeout = '0';
set local role hid_ehr_api_runtime;
\endif
select pg_temp.check_case('5 p2 checked in on the appointment (basis appointment)', 'checked_in/false/checked_in/appointment/waiting',
  pg_temp.check_in(1, 'p2-today', 1, true, null, 'in-3'));
select pg_temp.check_case('5 replayed', 'checked_in/true/checked_in/appointment/waiting',
  pg_temp.check_in(1, 'p2-today', 1, true, null, 'in-3'));
select pg_temp.check_case('5 a second check-in of the same appointment', 'not_booked/false/checked_in/-/-',
  pg_temp.check_in(1, 'p2-today', 2, true, null, 'in-4'));
select pg_temp.check_case('5 p7 already on the list: linked', 'already_on_list/false/checked_in/search/waiting',
  pg_temp.check_in(1, 'p7-today', 1, true, null, 'in-5'));
select pg_temp.check_case('5 p7 still has one open row', 'search:waiting', pg_temp.queue_basis(7));
reset role;
update identity.patients set status = 'inactive' where id = pg_temp.patient(6);
set local role hid_ehr_api_runtime;
select pg_temp.check_case('5 an inactive patient needs a search', 'needs_search/false/booked/-/-',
  pg_temp.check_in(1, 'p6-today', 1, true, null, 'in-6'));
select pg_temp.check_case('5 a matchRef naming another patient', 'needs_search/false/booked/-/-',
  pg_temp.check_in(1, 'p3-today', 1, true, pg_temp.ref('p1'), 'in-7'));
select pg_temp.check_case('5 p3 marked no-show (start passed)', 'updated/no_show',
  pg_temp.no_show(1, 'p3-today', 1, 'no-show-2'));
select pg_temp.check_case('5 p3 arrives: checked in by a fresh search (0135, basis search), no-show undone', 'checked_in/false/checked_in/search/waiting',
  pg_temp.check_in(1, 'p3-today', 2, true, pg_temp.ref('p3'), 'in-8'));
reset role;
select pg_temp.check_case('5 p3''s history', 'booked,no_show,no_show_undone,checked_in',
  (select string_agg(kind, ',' order by sequence_no) from ehr.appointment_events where appointment_id = pg_temp.id('p3-today')));
select pg_temp.check_case('5 the waiting-list rows'' bases', 'appointment:waiting/search:waiting/search:waiting',
  pg_temp.queue_basis(2) || '/' || pg_temp.queue_basis(3) || '/' || pg_temp.queue_basis(7));
select pg_temp.check_case('5 a check-in is not an own-facility basis (0131 null for p3 and p7)', 'null/null',
  coalesce(identity.own_facility_basis(pg_temp.patient(3), 'e1600000-0000-4000-8000-000000000002'), 'null') || '/'
    || coalesce(identity.own_facility_basis(pg_temp.patient(7), 'e1600000-0000-4000-8000-000000000002'), 'null'));
select pg_temp.check_case('5 no visit is written', '0',
  (select count(*)::text from ehr.encounters where patient_id in (pg_temp.patient(2), pg_temp.patient(3), pg_temp.patient(7))));
select pg_temp.check_case('5 the appointment names its waiting-list row', 'true/true',
  (select format('%s/%s', bool_and(appointment.visit_queue_entry_id = entry.id)::text, (count(*) = 3)::text)
     from ehr.appointments appointment
     join ehr.visit_queue entry on entry.patient_id = appointment.patient_id and entry.closed_at is null
    where appointment.status = 'checked_in'));
set local role hid_ehr_api_runtime;

-- 6. Lists and reads.
select pg_temp.check_case('6 today''s list at A', 'Booktwo:checked_in,Booksix:booked,Bookseven:checked_in,Bookthree!:checked_in/false',
  pg_temp.day_list(1, (clock_timestamp() at time zone 'Africa/Lagos')::date, null, null, null));
select pg_temp.check_case('6 tomorrow''s list at A, booked only', 'Bookseven:booked,Bookthree!:booked,Bookone:booked/false',
  pg_temp.day_list(2, ((clock_timestamp() + interval '1 day') at time zone 'Africa/Lagos')::date, null, null, array['booked']));
select pg_temp.check_case('6 tomorrow, doctor 3''s', 'Bookthree!:booked/false',
  pg_temp.day_list(1, ((clock_timestamp() + interval '1 day') at time zone 'Africa/Lagos')::date, null, 3, null));
select pg_temp.check_case('6 tomorrow, the clinic''s', 'Bookseven:booked,Bookone:booked/false',
  pg_temp.day_list(1, ((clock_timestamp() + interval '1 day') at time zone 'Africa/Lagos')::date,
    pg_temp.id('clinic:Medical outpatients'), null, null));
select pg_temp.check_case('6 one a page, has_more', 'Bookseven:booked/true',
  pg_temp.day_list(1, ((clock_timestamp() + interval '1 day') at time zone 'Africa/Lagos')::date, null, null, null, 1));
select pg_temp.check_case('6 B''s desk sees nothing of A''s', '(empty)/false',
  pg_temp.day_list(7, ((clock_timestamp() + interval '1 day') at time zone 'Africa/Lagos')::date, null, null, null));
select pg_temp.check_case('6 the lab member cannot list', '42501 APPOINTMENT_NOT_ALLOWED',
  pg_temp.day_list(4, (clock_timestamp() at time zone 'Africa/Lagos')::date, null, null, null));
select pg_temp.check_case('6 an unknown status', '22023 APPOINTMENT_INVALID',
  pg_temp.day_list(1, (clock_timestamp() at time zone 'Africa/Lagos')::date, null, null, array['late']));
select pg_temp.check_case('6 p1''s appointment with its history', 'found/booked/booked,rescheduled,rescheduled,rescheduled',
  (select format('%s/%s/%s', outcome, status, (select string_agg(item ->> 'kind', ',') from jsonb_array_elements(history) item))
     from (select pg_temp.as_member(2)) setting, ehr.appointment_read(pg_temp.id('p1-tomorrow'))));
select pg_temp.check_case('6 B''s desk reads A''s appointment', 'not_found/-',
  (select format('%s/%s', outcome, coalesce(full_name, '-'))
     from (select pg_temp.as_member(7)) setting, ehr.appointment_read(pg_temp.id('p1-tomorrow'))));
select pg_temp.check_case('6 p2''s appointments at A', 'checked_in,booked,cancelled',
  (select string_agg(status, ',' order by ord)
     from (select pg_temp.as_member(1)) setting, ehr.appointment_patient_list(pg_temp.patient(2))));
select pg_temp.check_case('6 p2''s appointments at B', '(none)',
  (select coalesce(string_agg(status, ','), '(none)')
     from (select pg_temp.as_member(7)) setting, ehr.appointment_patient_list(pg_temp.patient(2))));
select pg_temp.check_case('6 bookable staff at A: the nurse, the clinician and the three doctors', '02,03,06,10,11',
  (select string_agg(right(membership_id::text, 2), ',' order by membership_id)
     from (select pg_temp.as_member(1)) setting, ehr.appointment_bookable_staff()));

-- 7. Who may, and what the runtime cannot do.
select pg_temp.check_case('7 the runtime reads no appointment table', '42501',
  pg_temp.try('select count(*) from ehr.appointments'));
select pg_temp.check_case('7 nor the history', '42501', pg_temp.try('select count(*) from ehr.appointment_events'));
select pg_temp.check_case('7 nor calls the card helper', '42501',
  pg_temp.try('select * from ehr.appointment_cards(array[]::uuid[], null, null, null)'));
select pg_temp.check_case('7 nor the caller helper', '42501', pg_temp.try('select * from ehr.appointment_caller(null, null)'));
select pg_temp.check_case('7 nor the history''s sequence (its last_value counts every facility''s appointment events)',
  '42501', pg_temp.try('select last_value from ehr.appointment_events_sequence_no_seq'));
select pg_temp.check_case('7 nor takes a number from it', '42501',
  pg_temp.try('select nextval(''ehr.appointment_events_sequence_no_seq'')'));
reset role;
select pg_temp.check_case('7 the history cannot be changed', '55000',
  pg_temp.try('update ehr.appointment_events set reason = reason'));
select pg_temp.check_case('7 nor emptied, even by its owner', '55000', pg_temp.try('truncate ehr.appointment_events'));
select pg_temp.check_case('7 no runtime role holds any privilege on the history''s sequence (runtime-grants.sql)', '(none)',
  (select coalesce(string_agg(role_row.rolname || ' ' || privilege.name, ', ' order by role_row.rolname, privilege.name),
                   '(none)')
     from pg_roles role_row
     cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) privilege(name)
    where role_row.rolname ~ '^hid_' and not role_row.rolsuper
      and not pg_has_role(role_row.oid, (select relowner from pg_class
                                          where oid = 'ehr.appointment_events_sequence_no_seq'::regclass), 'MEMBER')
      and has_sequence_privilege(role_row.oid, 'ehr.appointment_events_sequence_no_seq'::regclass, privilege.name)));
select pg_temp.check_case('7 the role table', 'clinician:read,write/doctor:read,write/nurse:read/receptionist:read,write',
  (select string_agg(role_code || ':' || codes, '/' order by role_code)
     from (select role_code, string_agg(split_part(permission_code, '.', 3), ',' order by permission_code) as codes
             from auth.role_permissions where permission_code like 'ehr.appointment.%' group by role_code) grouped));

-- 8. Audit.
select pg_temp.check_case('8 booking rows', 'denied:17/success:11',
  (select string_agg(format('%s:%s', outcome, count), '/' order by outcome)
     from (select outcome, count(*) from audit.events
            where action = 'ehr.appointment.book'
              and facility_id in ('e1600000-0000-4000-8000-000000000002', 'e1600000-0000-4000-8000-000000000012')
            group by outcome) counted));
select pg_temp.check_case('8 check-in rows (appointment and waiting list)', 'check-in denied:5/check-in success:4/visit-queue success:2',
  (select string_agg(format('%s %s:%s', kind, outcome, count), '/' order by kind, outcome)
     from (select case when action = 'ehr.appointment.check-in' then 'check-in' else 'visit-queue' end as kind, outcome,
                  count(*)
             from audit.events
            where (action = 'ehr.appointment.check-in'
                   or (action = 'ehr.visit-queue.check-in' and details ->> 'by' = 'appointment'))
              and facility_id = 'e1600000-0000-4000-8000-000000000002'
            group by 1, 2) counted));
select pg_temp.check_case('8 every list.shown row names its patient', '0',
  (select count(*)::text from audit.events where action like 'ehr.appointment.%shown' and patient_id is null));
select pg_temp.check_case('8 no name, date of birth, Health ID, reason text or clinic name in any appointment audit row', '0',
  (select count(*)::text from audit.events
    where (action like 'ehr.appointment.%' or (action = 'ehr.visit-queue.check-in' and details ->> 'by' = 'appointment'))
      and (details::text ~* 'book(one|two|three|five|six|seven)|amaka|bayo|HID-BK|1990-01|blood pressure|clinic moved|outpatients|antenatal clinic|dental|patient called'
           or coalesce(reason, '') <> '')));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.a_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0160 appointments:\n%', mismatch;
  end if;
  raise notice '0160 appointments: % cases passed', (select count(*) from pg_temp.a_outcomes);
end $$;

rollback;

\if :a160_dblink_available
\if :a160_dblink_create
drop extension dblink;
\endif
\endif
