\set ON_ERROR_STOP on
-- 0161 (APPT-1, Release D; decisions at the recommended options Q-APPT-3 A and
-- Q-APPT-7 A): the patient's notices, the reminder sweep, the email and SMS
-- outboxes, the portal's "My appointments" and the printable call list.
-- Rollback-only. Bookings run as ehr-api's login role (hid_ehr_api_runtime),
-- the email and SMS senders and the call list as identity-api's
-- (hid_identity_api_runtime), each in the context its service sets.
-- Fictional people, places and identifiers only; ids start e1610.
--
--   1. notices: a booking, a reschedule and a cancel each write one inbox item
--      (APPOINTMENT_BOOKED, _RESCHEDULED, _CANCELLED; resource appointment;
--      metadata facilityName and startsAt only) and one email outbox row in
--      the same transaction; check-in and no-show write none; a patient with
--      no account gets nothing;
--   2. the control: appointment_sms_reminders_enabled exists, is off, and
--      platform.control_enabled answers it; 12 controls;
--   3. the reminder sweep: system:auth only; only between 07:00 and 21:00
--      Lagos (otherwise 0, and the rest of 3 is skipped); exactly the booked
--      appointments within 24 hours, without a reminder, booked at least 12
--      hours before their start; inbox, email and audit; a second run sends
--      nothing; no SMS row while the control is off; with it on, an SMS row
--      only for a patient with a phone this facility recorded; a reschedule
--      with it on keeps one unsent SMS row and the sweep goes on for every
--      facility, and after a sent one the moved appointment gets a new row;
--      with it on, no SMS row for a deceased patient or one who turned
--      notices off (the email's rule);
--   4. the SMS sender: nothing claimed while the control is off; a queued SMS
--      whose patient has since died or turned notices off is closed unsent
--      (PATIENT_NOT_REACHABLE) and never claimed; claim and record (sent,
--      stale) with one audit row; system:auth only;
--   5. the email sender: a patient without a verified email is skipped;
--      rows without a recipient are never leased, however many wait beyond
--      one claim's limit (unverified email, notices turned off); claim and
--      record (delivered, stale) with one audit row; system:auth only;
--   6. "My appointments": only in the patient's own live session; upcoming
--      and past; every facility; no staff id or booking basis; audited;
--   7. the call list: the session facility's booked appointments of one day,
--      the facility's own recorded phone ciphertext (or none); the nurse and
--      another facility's desk see nothing of it; audited per patient;
--   8. privileges: the runtimes read no outbox and call only their own
--      functions;
--   9. audit rows hold no name, Health ID, phone, reason text or clinic name.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.
begin;

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'appointment-notices-test')
  on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1610000-0000-4000-8000-000000000001', 'Reminder Group A', 'reminder-group-a'),
  ('e1610000-0000-4000-8000-000000000011', 'Reminder Group B', 'reminder-group-b');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1610000-0000-4000-8000-000000000002', 'e1610000-0000-4000-8000-000000000001', 'Reminder Clinic A',
   'REMIND-A', 'Africa/Lagos', true, 'verified'),
  ('e1610000-0000-4000-8000-000000000012', 'e1610000-0000-4000-8000-000000000011', 'Reminder Clinic B',
   'REMIND-B', 'Africa/Lagos', true, 'verified');
create temporary table n_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into n_members values
  (1, 'e1610000-0000-4000-8000-000000000002', 'e1610000-0000-4000-8000-000000000001', 'receptionist', 'Ada Remind'),
  (2, 'e1610000-0000-4000-8000-000000000002', 'e1610000-0000-4000-8000-000000000001', 'nurse', 'Bola Remind'),
  (3, 'e1610000-0000-4000-8000-000000000012', 'e1610000-0000-4000-8000-000000000011', 'receptionist', 'Chidi Remind');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1610100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:reminder-member-' || n,
  'reminder-member-' || n || '@example.invalid', name, 'active' from n_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1610200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1610100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'reminder-member-' || n || '@example.invalid', 'verified', role_code from n_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1610300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1610200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1610100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, organization, facility, role_code, role_code,
  true, true
from n_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('e1610100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
  ('e1610300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, facility, 'Synthetic appointment notices role'
from n_members;

-- Patients, all registered at a desk (this facility's own, 0131): p1 at A with an account, a verified email and a
-- phone A recorded; p2 at A with no account; p3 at A with an account whose email is not verified; p4 at B with an
-- account and a verified email.
create temporary table n_patients (n integer primary key, hid text, first text, last text, facility uuid,
  member integer, has_account boolean, verified boolean) on commit drop;
insert into n_patients values
  (1, 'HID-RMAA33', 'Ngozi', 'Remindone', 'e1610000-0000-4000-8000-000000000002', 1, true, true),
  (2, 'HID-RMAB33', 'Obi', 'Remindtwo', 'e1610000-0000-4000-8000-000000000002', 1, false, false),
  (3, 'HID-RMAC33', 'Peju', 'Remindthree', 'e1610000-0000-4000-8000-000000000002', 1, true, false),
  (4, 'HID-RMAD33', 'Remi', 'Remindfour', 'e1610000-0000-4000-8000-000000000012', 3, true, true);
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at)
select ('e1610600-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:reminder-patient-' || n,
  'reminder-patient-' || n || '@example.invalid', first || ' ' || last, 'active',
  case when verified then clock_timestamp() - interval '10 days' end
  from n_patients where has_account;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system,
  account_id)
select ('e1610400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, hid, first, last, first || ' ' || last,
  'female', date '1985-02-01' + n, 'active', 'hid-desk-registration',
  case when has_account then ('e1610600-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid end
  from n_patients;
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, idempotency_key, request_sha256,
  resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id,
  review_reason, created_at, updated_at)
select ('e1610500-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, facility,
  ('e1610100-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
  ('e1610300-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid, 'approved_new_identity',
  first, last, first || ' ' || last, date '1985-02-01' + n, 'none', 'no_nin', 'reminder-case-key-0000' || n,
  repeat('0', 64), ('e1610400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  'reminder-review-key-00' || n, repeat('0', 64),
  ('e1610100-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
  ('e1610300-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid, 'Checked at the desk',
  clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days'
  from n_patients;
-- An older registration case of p1 at A, whose contact was erased.
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, idempotency_key, request_sha256,
  resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id,
  review_reason, created_at, updated_at)
values ('e1610500-0000-4000-8000-000000000011', 'e1610000-0000-4000-8000-000000000002',
  'e1610100-0000-4000-8000-000000000001', 'e1610300-0000-4000-8000-000000000001', 'approved_new_identity',
  'Ngozi', 'Remindone', 'Ngozi Remindone', date '1985-02-02', 'none', 'no_nin', 'reminder-case-key-00011',
  repeat('0', 64), 'e1610400-0000-4000-8000-000000000001', 'reminder-review-key-011', repeat('0', 64),
  'e1610100-0000-4000-8000-000000000001', 'e1610300-0000-4000-8000-000000000001', 'Checked at the desk',
  clock_timestamp() - interval '40 days', clock_timestamp() - interval '40 days');
-- p1's phone as facility A recorded it (an older one erased, a newer one current); p4's at B.
-- The cases' own contact rows (0130), which the facility contacts reference.
insert into identity.registration_case_contacts (registration_case_id, facility_id, phone_ciphertext, address_ciphertext,
  key_version, created_by_account_id, created_by_membership_id, erased_at, erasure_reason)
values
  ('e1610500-0000-4000-8000-000000000011', 'e1610000-0000-4000-8000-000000000002', null, null, null,
   'e1610100-0000-4000-8000-000000000001', 'e1610300-0000-4000-8000-000000000001', clock_timestamp() - interval '5 days',
   'erasure_request'),
  ('e1610500-0000-4000-8000-000000000001', 'e1610000-0000-4000-8000-000000000002', decode(repeat('02', 32), 'hex'),
   decode(repeat('a2', 40), 'hex'), 'v1', 'e1610100-0000-4000-8000-000000000001', 'e1610300-0000-4000-8000-000000000001',
   null, null),
  ('e1610500-0000-4000-8000-000000000004', 'e1610000-0000-4000-8000-000000000012', decode(repeat('04', 32), 'hex'),
   decode(repeat('a4', 40), 'hex'), 'v1', 'e1610100-0000-4000-8000-000000000003', 'e1610300-0000-4000-8000-000000000003',
   null, null);
insert into identity.patient_facility_contacts (id, patient_id, facility_id, registration_case_id, phone_ciphertext,
  address_ciphertext, key_version, created_by_account_id, created_by_membership_id, created_at, erased_at, erasure_reason)
values
  ('e1610700-0000-4000-8000-000000000001', 'e1610400-0000-4000-8000-000000000001', 'e1610000-0000-4000-8000-000000000002',
   'e1610500-0000-4000-8000-000000000011', null, null, null, 'e1610100-0000-4000-8000-000000000001',
   'e1610300-0000-4000-8000-000000000001', clock_timestamp() - interval '20 days', clock_timestamp() - interval '5 days',
   'erasure_request'),
  ('e1610700-0000-4000-8000-000000000002', 'e1610400-0000-4000-8000-000000000001', 'e1610000-0000-4000-8000-000000000002',
   'e1610500-0000-4000-8000-000000000001', decode(repeat('02', 32), 'hex'), decode(repeat('a2', 40), 'hex'), 'v1', 'e1610100-0000-4000-8000-000000000001',
   'e1610300-0000-4000-8000-000000000001', clock_timestamp() - interval '10 days', null, null),
  ('e1610700-0000-4000-8000-000000000004', 'e1610400-0000-4000-8000-000000000004', 'e1610000-0000-4000-8000-000000000012',
   'e1610500-0000-4000-8000-000000000004', decode(repeat('04', 32), 'hex'), decode(repeat('a4', 40), 'hex'), 'v1', 'e1610100-0000-4000-8000-000000000003',
   'e1610300-0000-4000-8000-000000000003', clock_timestamp() - interval '10 days', null, null);
-- p1's live patient session (for "My appointments").
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('e1610800-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1610600-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('e1610800-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  md5('reminder-session-' || n) || md5('reminder-refresh-' || n), gen_random_uuid(),
  (select token_version from auth.accounts where id = ('e1610600-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid),
  'password', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day',
  clock_timestamp() + interval '7 days', 'patient', ('e1610400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
  from n_patients where n in (1, 4);
set local session_replication_role = origin;

create temporary table n_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
grant select, insert on pg_temp.n_outcomes to hid_ehr_api_runtime, hid_identity_api_runtime;
grant usage on sequence pg_temp.n_outcomes_seq_seq to hid_ehr_api_runtime, hid_identity_api_runtime;
grant select on pg_temp.n_members to hid_ehr_api_runtime, hid_identity_api_runtime;
create temporary table n_ids (name text primary key, id uuid, version bigint) on commit drop;
grant select, insert, update on pg_temp.n_ids to hid_ehr_api_runtime, hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.n_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.member(n integer) returns uuid language sql immutable as $f$
  select ('e1610300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.patient(n integer) returns uuid language sql immutable as $f$
  select ('e1610400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.as_member(n integer) returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:reminder-member-' || n, true),
    set_config('app.membership_id', pg_temp.member(n)::text, true),
    set_config('app.facility_id', (select facility::text from pg_temp.n_members where n_members.n = as_member.n), true),
    set_config('app.correlation_id', 'reminder-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', 'direct-care', true),
    set_config('app.patient_id', '', true), set_config('app.account_id', '', true),
    set_config('app.session_id', '', true), set_config('app.self_authorized_until', '', true);
$f$;
create function pg_temp.as_system() returns void language sql as $f$
  select set_config('app.actor_subject', 'system:auth', true),
    set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'reminder-suite-system-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', '', true), set_config('app.patient_id', '', true),
    set_config('app.account_id', '', true), set_config('app.session_id', '', true),
    set_config('app.self_authorized_until', '', true);
$f$;
create function pg_temp.as_patient(n integer) returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:reminder-patient-' || n, true),
    set_config('app.account_id', ('e1610600-0000-4000-8000-0000000000' || lpad(n::text, 2, '0')), true),
    set_config('app.session_id', ('e1610800-0000-4000-8000-0000000000' || lpad(n::text, 2, '0')), true),
    set_config('app.patient_id', pg_temp.patient(n)::text, true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '1 minute')::text, true),
    set_config('app.correlation_id', 'reminder-suite-patient-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', 'patient-self', true),
    set_config('app.membership_id', '', true), set_config('app.facility_id', '', true);
$f$;
create function pg_temp.slot(minutes integer) returns timestamptz language sql as $f$
  select to_timestamp(floor(extract(epoch from clock_timestamp()) / 300) * 300) + make_interval(mins => minutes)
$f$;
-- A booking for today (Lagos): the step before the current one, or midnight in the first minutes of the day. Always
-- today and already begun (at most 10 minutes back), whatever the hour the suite runs.
create function pg_temp.today_slot() returns timestamptz language sql as $f$
  select greatest(pg_temp.slot(-5),
    ((clock_timestamp() at time zone 'Africa/Lagos')::date + time '00:00') at time zone 'Africa/Lagos')
$f$;
create function pg_temp.key(label text) returns text language sql immutable as $f$
  select 'reminder-suite-key-' || label
$f$;
create function pg_temp.sha(label text) returns text language sql immutable as $f$
  select encode(sha256(convert_to(label, 'UTF8')), 'hex')
$f$;
create function pg_temp.id(label text) returns uuid language sql as $f$
  select id from pg_temp.n_ids where name = label
$f$;
create function pg_temp.version(label text) returns bigint language sql as $f$
  select version from pg_temp.n_ids where name = label
$f$;
create function pg_temp.remember(label text, appointment uuid, row_version bigint) returns void language sql as $f$
  insert into pg_temp.n_ids values (label, appointment, row_version)
    on conflict (name) do update set id = coalesce(excluded.id, n_ids.id), version = coalesce(excluded.version, n_ids.version)
$f$;
-- A booking of this facility's own patient by member n.
create function pg_temp.book(n integer, label text, patient integer, starts timestamptz, reason text default null)
returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_book(null, pg_temp.patient(patient), 'general_outpatient', null, null,
    starts, 30, 'follow_up', reason, pg_temp.key(label), pg_temp.sha(label));
  if answer.appointment_id is not null then
    perform pg_temp.remember(label, answer.appointment_id, answer.row_version);
  end if;
  return answer.outcome;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.reschedule(n integer, label text, starts timestamptz) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_reschedule(pg_temp.id(label), pg_temp.version(label), starts, null, null,
    false, 'The clinic moved the session', pg_temp.key(label || '-moved'), pg_temp.sha(label || '-moved'));
  perform pg_temp.remember(label, null, answer.row_version);
  return answer.outcome;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.cancel(n integer, label text) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_cancel(pg_temp.id(label), pg_temp.version(label),
    'The patient called to cancel', pg_temp.key(label || '-cancel'), pg_temp.sha(label || '-cancel'));
  perform pg_temp.remember(label, null, answer.row_version);
  return answer.outcome;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.check_in(n integer, label text) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_check_in(pg_temp.id(label), pg_temp.version(label), true, null,
    pg_temp.key(label || '-in'), pg_temp.sha(label || '-in'));
  perform pg_temp.remember(label, null, answer.row_version);
  return answer.outcome;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- Inbox items for a patient: code:metadata keys, oldest first. Read as the owner (definer).
create function pg_temp.inbox(patient integer) returns text language sql security definer as $f$
  select coalesce(string_agg(item.notification_code || ':' || item.resource_type || ':'
           || (select string_agg(key, '+' order by key) from jsonb_object_keys(item.metadata) key),
           ',' order by item.created_at, item.id), '(none)')
    from notification.inbox_items item where item.patient_id = pg_temp.patient(patient)
$f$;
create function pg_temp.emails(patient integer) returns text language sql security definer as $f$
  select coalesce(string_agg(email.notice_code || ':' || email.state, ',' order by email.created_at, email.id), '(none)')
    from ehr.appointment_email_outbox email where email.patient_id = pg_temp.patient(patient)
$f$;
create function pg_temp.sms(patient integer) returns text language sql security definer as $f$
  select coalesce(string_agg(sms.state || ':' || right(sms.contact_id::text, 2), ',' order by sms.created_at), '(none)')
    from ehr.appointment_sms_outbox sms where sms.patient_id = pg_temp.patient(patient)
$f$;
create function pg_temp.sweep(batch integer) returns text language plpgsql as $f$
begin
  perform pg_temp.as_system();
  return ehr.appointment_send_reminders(batch)::text;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ran';
exception when others then
  return sqlstate;
end
$f$;
-- Moves a booking's start and booked time (as the owner) so the reminder window can be tested at any hour.
create function pg_temp.place(label text, starts timestamptz, booked timestamptz) returns void language sql
security definer as $f$
  update ehr.appointments set starts_at = starts, ends_at = starts + make_interval(mins => length_minutes),
    appointment_day = (starts at time zone 'Africa/Lagos')::date, booked_at = booked
   where id = pg_temp.id(label)
$f$;
grant execute on function pg_temp.inbox(integer), pg_temp.emails(integer), pg_temp.sms(integer)
  to hid_ehr_api_runtime, hid_identity_api_runtime;

-- 1. Notices.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 p1 booked in two days', 'booked', pg_temp.book(1, 'p1-later', 1, pg_temp.slot(48 * 60),
  'Blood pressure review'));
select pg_temp.check_case('1 one inbox item, metadata facilityName and startsAt only',
  'APPOINTMENT_BOOKED:appointment:facilityName+startsAt', pg_temp.inbox(1));
reset role;
select pg_temp.check_case('1 its metadata: the facility and the start time, never the reason',
  'Reminder Clinic A/' || to_char(pg_temp.slot(48 * 60) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  (select metadata ->> 'facilityName' || '/' || (metadata ->> 'startsAt') from notification.inbox_items
    where patient_id = pg_temp.patient(1) and resource_id = pg_temp.id('p1-later')));
select pg_temp.check_case('1 one email outbox row', 'APPOINTMENT_BOOKED:pending', pg_temp.emails(1));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 rescheduled', 'updated', pg_temp.reschedule(1, 'p1-later', pg_temp.slot(50 * 60)));
select pg_temp.check_case('1 cancelled', 'updated', pg_temp.cancel(1, 'p1-later'));
select pg_temp.check_case('1 three inbox items',
  'APPOINTMENT_BOOKED:appointment:facilityName+startsAt,APPOINTMENT_RESCHEDULED:appointment:facilityName+startsAt,'
  || 'APPOINTMENT_CANCELLED:appointment:facilityName+startsAt', pg_temp.inbox(1));
reset role;
select pg_temp.check_case('1 the cancel notice names the start that was cancelled',
  to_char(pg_temp.slot(50 * 60) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  (select metadata ->> 'startsAt' from notification.inbox_items
    where patient_id = pg_temp.patient(1) and notification_code = 'APPOINTMENT_CANCELLED'));
select pg_temp.check_case('1 three email rows', 'APPOINTMENT_BOOKED:pending,APPOINTMENT_RESCHEDULED:pending,APPOINTMENT_CANCELLED:pending',
  pg_temp.emails(1));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 p1 booked for today', 'booked', pg_temp.book(1, 'p1-today', 1, pg_temp.today_slot()));
select pg_temp.check_case('1 checked in', 'checked_in', pg_temp.check_in(1, 'p1-today'));
reset role;
select pg_temp.check_case('1 a check-in writes no notice', '4 inbox, 4 email',
  (select count(*) from notification.inbox_items where patient_id = pg_temp.patient(1)) || ' inbox, '
  || (select count(*) from ehr.appointment_email_outbox where patient_id = pg_temp.patient(1)) || ' email');
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 p2 (no account) booked', 'booked', pg_temp.book(1, 'p2-later', 2, pg_temp.slot(52 * 60)));
select pg_temp.check_case('1 a patient with no account gets nothing', '(none)/(none)',
  pg_temp.inbox(2) || '/' || pg_temp.emails(2));
reset role;
select pg_temp.check_case('1 the notice helper and its trigger are no runtime''s',
  'false/false/false/false',
  has_function_privilege('hid_ehr_api_runtime', 'ehr.appointment_notice(uuid, text, timestamptz)', 'execute')::text
  || '/' || has_function_privilege('hid_identity_api_runtime', 'ehr.appointment_notice(uuid, text, timestamptz)', 'execute')::text
  || '/' || has_function_privilege('hid_ehr_api_runtime', 'ehr.appointment_events_notify()', 'execute')::text
  || '/' || has_function_privilege('public', 'ehr.appointment_notice(uuid, text, timestamptz)', 'execute')::text);

-- 2. The control. platform.control_enabled is SECURITY DEFINER and reads platform.control_settings (FORCE ROW LEVEL
-- SECURITY) as its owner: an owner that bypasses row-level security (production's) reads the row under any
-- context; a NOBYPASSRLS owner (this build's migrator) reads it only for a platform administrator, so the call
-- raises 55000 PLATFORM_CONTROL_UNAVAILABLE, which the sweep and the SMS sender count as off (fail closed). The
-- case records the answer the owner gives; from 3 on, FORCE is lifted for this transaction so the cases see the
-- control as production does.
select (select rolsuper or rolbypassrls from pg_roles
         where oid = (select proowner from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure))
       as n161_owner_bypasses \gset
create function pg_temp.control_answer() returns text language plpgsql as $f$
begin
  return platform.control_enabled('appointment_sms_reminders_enabled')::text;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select pg_temp.check_case('2 the SMS control is seeded off, one of 12', 'false/12/1',
  (select enabled::text from platform.control_settings where control_key = 'appointment_sms_reminders_enabled')
  || '/' || (select count(*) from platform.control_settings)
  || '/' || (select count(*) from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure
              and prosrc like '%''appointment_sms_reminders_enabled''%'));
select pg_temp.check_case('2 platform.control_enabled answers it (off; unreadable to a NOBYPASSRLS owner: off too)',
  case when :'n161_owner_bypasses'::boolean then 'false' else '55000 PLATFORM_CONTROL_UNAVAILABLE' end,
  pg_temp.control_answer());
select pg_temp.check_case('2 an unknown control is still refused', '22023',
  pg_temp.try('select platform.control_enabled(''appointment_sms_reminders'')'));
alter table platform.control_settings no force row level security;
select pg_temp.check_case('2 read as production reads it: off', 'false', pg_temp.control_answer());

-- 3. Reminders. Bookings made now, then placed (start and booked time) as each case needs.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 r1 booked', 'booked', pg_temp.book(1, 'r1', 1, pg_temp.slot(60 * 24 * 5)));
select pg_temp.check_case('3 r2 booked', 'booked', pg_temp.book(1, 'r2', 3, pg_temp.slot(60 * 24 * 5)));
select pg_temp.check_case('3 r3 booked', 'booked', pg_temp.book(1, 'r3', 3, pg_temp.slot(60 * 24 * 6)));
select pg_temp.check_case('3 r4 booked', 'booked', pg_temp.book(1, 'r4', 2, pg_temp.slot(60 * 24 * 7)));
select pg_temp.check_case('3 r5 booked', 'booked', pg_temp.book(1, 'r5', 3, pg_temp.slot(60 * 24 * 8)));
select pg_temp.check_case('3 r5 cancelled', 'updated', pg_temp.cancel(1, 'r5'));
reset role;
-- r1 (p1): in 20 hours, booked 30 hours ago: due. r2 (p3): in 6 hours, booked 20 hours ago: due. r3 (p3): in 5
-- hours, booked 1 hour ago (6 hours ahead, under 12): not due. r4 (p2): in 30 hours: not yet. r5 (p3): cancelled.
select pg_temp.place('r1', pg_temp.slot(20 * 60), clock_timestamp() - interval '30 hours');
select pg_temp.place('r2', pg_temp.slot(6 * 60), clock_timestamp() - interval '20 hours');
select pg_temp.place('r3', pg_temp.slot(5 * 60), clock_timestamp() - interval '1 hour');
select pg_temp.place('r4', pg_temp.slot(30 * 60), clock_timestamp() - interval '40 hours');
select pg_temp.place('r5', pg_temp.slot(7 * 60), clock_timestamp() - interval '40 hours');
select extract(hour from (clock_timestamp() at time zone 'Africa/Lagos'))::integer between 7 and 20 as n161_in_window \gset
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.check_case('3 a staff session cannot run the sweep', '42501',
  pg_temp.try('select ehr.appointment_send_reminders(10)'));
select pg_temp.check_case('3 a batch outside 1-500 is refused', '22023 APPOINTMENT_INVALID', pg_temp.sweep(0));
\if :n161_in_window
select pg_temp.check_case('3 the sweep sends the two due reminders', '2', pg_temp.sweep(50));
reset role;
select pg_temp.check_case('3 which: r1 and r2, each with its time set', 'r1,r2',
  (select string_agg(ids.name, ',' order by ids.name) from pg_temp.n_ids ids
     join ehr.appointments appointment on appointment.id = ids.id
    where appointment.reminder_sent_at is not null));
select pg_temp.check_case('3 p1''s reminder: inbox and email',
  'APPOINTMENT_REMINDER:appointment:facilityName+startsAt/APPOINTMENT_REMINDER:pending',
  (select notification_code || ':' || resource_type || ':'
          || (select string_agg(key, '+' order by key) from jsonb_object_keys(metadata) key)
     from notification.inbox_items where resource_id = pg_temp.id('r1') and notification_code = 'APPOINTMENT_REMINDER')
  || '/' || (select notice_code || ':' || state from ehr.appointment_email_outbox
              where appointment_id = pg_temp.id('r1') and notice_code = 'APPOINTMENT_REMINDER'));
select pg_temp.check_case('3 one system audit row each, naming the channels', '["inbox", "email"]/["inbox", "email"]',
  (select string_agg(details ->> 'channels', '/' order by resource_id) from audit.events
    where action = 'ehr.appointment.reminder' and actor_type = 'system'
      and resource_id in (pg_temp.id('r1')::text, pg_temp.id('r2')::text)));
select pg_temp.check_case('3 no SMS row while the control is off', '0',
  (select count(*)::text from ehr.appointment_sms_outbox));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 a second run sends nothing', '0', pg_temp.sweep(50));
reset role;
-- The control on (as an administrator would, through Platform), and two more due bookings: r6 for p1 (a phone A
-- recorded) and r7 for p2 (no phone, no account).
update platform.control_settings set enabled = true where control_key = 'appointment_sms_reminders_enabled';
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 r6 booked', 'booked', pg_temp.book(1, 'r6', 1, pg_temp.slot(60 * 24 * 9)));
select pg_temp.check_case('3 r7 booked', 'booked', pg_temp.book(1, 'r7', 2, pg_temp.slot(60 * 24 * 9)));
reset role;
select pg_temp.place('r6', pg_temp.slot(21 * 60), clock_timestamp() - interval '30 hours');
select pg_temp.place('r7', pg_temp.slot(8 * 60), clock_timestamp() - interval '30 hours');
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 with SMS on: two more reminders', '2', pg_temp.sweep(50));
reset role;
select pg_temp.check_case('3 an SMS row only for p1, with A''s current phone', 'pending:02/(none)',
  pg_temp.sms(1) || '/' || pg_temp.sms(2));
select pg_temp.check_case('3 the channels: p1 inbox, email and sms; p2 none',
  '["inbox", "email", "sms"]/[]',
  (select details ->> 'channels' from audit.events where action = 'ehr.appointment.reminder'
    and resource_id = pg_temp.id('r6')::text)
  || '/' || (select details ->> 'channels' from audit.events where action = 'ehr.appointment.reminder'
    and resource_id = pg_temp.id('r7')::text));
-- A reschedule with SMS on (rolled back after, so 4 sees the state above). r6 already has its SMS row (pending). The
-- desk moves it within the window, and r8 (p3, Clinic A, no recorded phone) is due too: the next sweep sends both,
-- and r6 keeps one unsent SMS row (never a second, never an error that stops the sweep for every facility). Once
-- that SMS is sent, a second move gets a new one.
create function pg_temp.move(n integer, label text, starts timestamptz, tag text) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.appointment_reschedule(pg_temp.id(label), pg_temp.version(label), starts, null, null,
    false, 'The clinic moved the session', pg_temp.key(label || '-' || tag), pg_temp.sha(label || '-' || tag));
  perform pg_temp.remember(label, null, answer.row_version);
  return answer.outcome;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
savepoint n161_sms_reschedule;
set local role hid_ehr_api_runtime;
select pg_temp.move(1, 'r6', pg_temp.slot(22 * 60), 'sms-on-1') as n161_move_1,
       pg_temp.book(1, 'r8', 3, pg_temp.slot(60 * 24 * 11)) as n161_r8_booked \gset
reset role;
select pg_temp.place('r8', pg_temp.slot(23 * 60), clock_timestamp() - interval '30 hours');
set local role hid_ehr_api_runtime;
select pg_temp.sweep(50) as n161_sweep_moved \gset
reset role;
select pg_temp.sms(1) as n161_sms_moved,
       (select (reminder_sent_at is not null)::text from ehr.appointments where id = pg_temp.id('r8')) as n161_r8_reminded \gset
update ehr.appointment_sms_outbox set state = 'sent', sent_at = clock_timestamp()
 where appointment_id = pg_temp.id('r6') and state = 'pending';
set local role hid_ehr_api_runtime;
select pg_temp.move(1, 'r6', pg_temp.slot(23 * 60 + 30), 'sms-on-2') as n161_move_2 \gset
select pg_temp.sweep(50) as n161_sweep_moved_again \gset
reset role;
select pg_temp.sms(1) as n161_sms_moved_again \gset
rollback to savepoint n161_sms_reschedule;
select pg_temp.check_case('3 SMS on: r6 moved and r8 booked', 'updated/booked', :'n161_move_1' || '/' || :'n161_r8_booked');
select pg_temp.check_case('3 SMS on: the sweep after the move sends r6 again and r8', '2', :'n161_sweep_moved');
select pg_temp.check_case('3 SMS on: r6 keeps its one unsent SMS; r8''s reminder is sent', 'pending:02/true',
  :'n161_sms_moved' || '/' || :'n161_r8_reminded');
select pg_temp.check_case('3 SMS on: moved again after that SMS was sent', 'updated', :'n161_move_2');
select pg_temp.check_case('3 SMS on: the next sweep queues a new SMS beside the sent one', '1/sent:02,pending:02',
  :'n161_sweep_moved_again' || '/' || :'n161_sms_moved_again');
-- The patient rule with SMS on (each rolled back after, so 4 sees the state above): r9, p1's (a phone A recorded),
-- is due. Once p1 has died the sweep still sets its reminder, but writes no inbox item (0037), no email and no SMS;
-- with p1 active but notices turned off, the inbox item and the email row (skipped when claimed, 0063) and no SMS.
savepoint n161_sms_patient_rule;
set local role hid_ehr_api_runtime;
select pg_temp.book(1, 'r9', 1, pg_temp.slot(60 * 24 * 13)) as n161_r9_booked \gset
reset role;
select pg_temp.place('r9', pg_temp.slot(19 * 60), clock_timestamp() - interval '30 hours');
update identity.patients set status = 'deceased' where id = pg_temp.patient(1);
set local role hid_ehr_api_runtime;
select pg_temp.sweep(50) as n161_sweep_deceased \gset
reset role;
select (select count(*) from ehr.appointment_sms_outbox where appointment_id = pg_temp.id('r9')) || '/'
       || (select details ->> 'channels' from audit.events where action = 'ehr.appointment.reminder'
            and resource_id = pg_temp.id('r9')::text) as n161_r9_deceased \gset
rollback to savepoint n161_sms_patient_rule;
set local role hid_ehr_api_runtime;
select pg_temp.book(1, 'r9', 1, pg_temp.slot(60 * 24 * 13)) as n161_r9_booked_again \gset
reset role;
select pg_temp.place('r9', pg_temp.slot(19 * 60), clock_timestamp() - interval '30 hours');
update identity.patients set notifications_enabled = false where id = pg_temp.patient(1);
set local role hid_ehr_api_runtime;
select pg_temp.sweep(50) as n161_sweep_notices_off \gset
reset role;
select (select count(*) from ehr.appointment_sms_outbox where appointment_id = pg_temp.id('r9')) || '/'
       || (select details ->> 'channels' from audit.events where action = 'ehr.appointment.reminder'
            and resource_id = pg_temp.id('r9')::text) as n161_r9_notices_off \gset
rollback to savepoint n161_sms_patient_rule;
select pg_temp.check_case('3 SMS on: r9 booked (twice, each rolled back)', 'booked/booked',
  :'n161_r9_booked' || '/' || :'n161_r9_booked_again');
select pg_temp.check_case('3 SMS on, p1 deceased: the reminder is set, with no channel and no SMS row', '1/0/[]',
  :'n161_sweep_deceased' || '/' || :'n161_r9_deceased');
select pg_temp.check_case('3 SMS on, p1''s notices off: inbox and email, no SMS row', '1/0/["inbox", "email"]',
  :'n161_sweep_notices_off' || '/' || :'n161_r9_notices_off');
\else
select pg_temp.check_case('3 outside 07:00-21:00 Lagos the sweep sends nothing', '0', pg_temp.sweep(50));
reset role;
\echo 'appointment notices suite: outside 07:00-21:00 Lagos, so the reminder cases of 3 are skipped (the sweep answered 0)'
-- For 4: one SMS row as the sweep writes it while the control is on.
update platform.control_settings set enabled = true where control_key = 'appointment_sms_reminders_enabled';
insert into ehr.appointment_sms_outbox (appointment_id, facility_id, patient_id, contact_id)
values (pg_temp.id('r1'), 'e1610000-0000-4000-8000-000000000002', pg_temp.patient(1), 'e1610700-0000-4000-8000-000000000002');
\endif

-- 4. The SMS sender.
update platform.control_settings set enabled = false where control_key = 'appointment_sms_reminders_enabled';
create function pg_temp.sms_claim(batch integer) returns text language plpgsql as $f$
declare
  claimed text;
begin
  perform pg_temp.as_system();
  select string_agg(claim.facility_name || ':' || left(encode(claim.phone_ciphertext, 'hex'), 4) || ':' || claim.key_version
           || ':' || right(claim.registration_case_id::text, 2), ',')
    into claimed from identity.appointment_sms_claim(batch) claim;
  return coalesce(claimed, '(none)');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.sms_record(outcome text) returns text language plpgsql as $f$
begin
  perform pg_temp.as_system();
  perform identity.appointment_sms_record((select id from ehr.appointment_sms_outbox where appointment_id <> pg_temp.id('r5') limit 1), outcome, null);
  return 'recorded';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
alter function pg_temp.sms_record(text) security definer;
-- A reminder queued for an appointment that was cancelled since (r5): closed unsent at the next claim.
insert into ehr.appointment_sms_outbox (appointment_id, facility_id, patient_id, contact_id, created_at)
values (pg_temp.id('r5'), 'e1610000-0000-4000-8000-000000000002', pg_temp.patient(3),
  'e1610700-0000-4000-8000-000000000002', clock_timestamp() - interval '1 hour');
set local role hid_identity_api_runtime;
select pg_temp.check_case('4 nothing is claimed while the control is off', '(none)', pg_temp.sms_claim(10));
reset role;
update platform.control_settings set enabled = true where control_key = 'appointment_sms_reminders_enabled';
-- p1's queued SMS, once p1 has died or turned notices off since (each rolled back after): closed unsent at the
-- next claim, never claimed.
create function pg_temp.sms_states(patient integer) returns text language sql security definer as $f$
  select coalesce(string_agg(sms.state || ':' || coalesce(sms.last_error_code, '-'), ',' order by sms.created_at), '(none)')
    from ehr.appointment_sms_outbox sms where sms.patient_id = pg_temp.patient(patient)
$f$;
savepoint n161_sms_claim_patient_rule;
update identity.patients set status = 'deceased' where id = pg_temp.patient(1);
set local role hid_identity_api_runtime;
select pg_temp.sms_claim(10) as n161_claim_deceased \gset
reset role;
select pg_temp.sms_states(1) as n161_sms_deceased \gset
rollback to savepoint n161_sms_claim_patient_rule;
update identity.patients set notifications_enabled = false where id = pg_temp.patient(1);
set local role hid_identity_api_runtime;
select pg_temp.sms_claim(10) as n161_claim_notices_off \gset
reset role;
select pg_temp.sms_states(1) as n161_sms_notices_off \gset
rollback to savepoint n161_sms_claim_patient_rule;
select pg_temp.check_case('4 p1 deceased: nothing claimed; p1''s SMS closed unsent', '(none)/failed:PATIENT_NOT_REACHABLE',
  :'n161_claim_deceased' || '/' || :'n161_sms_deceased');
select pg_temp.check_case('4 p1''s notices off: nothing claimed; p1''s SMS closed unsent', '(none)/failed:PATIENT_NOT_REACHABLE',
  :'n161_claim_notices_off' || '/' || :'n161_sms_notices_off');
set local role hid_identity_api_runtime;
select pg_temp.check_case('4 the control on: the SMS with the facility name and A''s phone ciphertext',
  'Reminder Clinic A:0202:v1:01', pg_temp.sms_claim(10));
reset role;
select pg_temp.check_case('4 the cancelled appointment''s reminder was closed unsent', 'failed:APPOINTMENT_NOT_BOOKED',
  (select state || ':' || last_error_code from ehr.appointment_sms_outbox where appointment_id = pg_temp.id('r5')));
set local role hid_identity_api_runtime;
select pg_temp.as_member(1);
select pg_temp.check_case('4 a staff session cannot claim', '42501', pg_temp.try('select * from identity.appointment_sms_claim(10)'));
reset role;
select pg_temp.check_case('4 recorded as sent', 'recorded', pg_temp.sms_record('sent'));
select pg_temp.check_case('4 a second record is stale', '55000 APPOINTMENT_SMS_CLAIM_STALE', pg_temp.sms_record('sent'));
select pg_temp.check_case('4 one audit row, without the phone', 'success/{"attempt": 1, "outcome": "sent", "errorCode": null}',
  (select string_agg(outcome || '/' || details::text, ',') from audit.events where action = 'notification.appointment-sms.send'));
update platform.control_settings set enabled = false where control_key = 'appointment_sms_reminders_enabled';

-- 5. The email sender.
create function pg_temp.email_claim() returns text language plpgsql as $f$
declare
  claimed text;
begin
  perform pg_temp.as_system();
  with claim as (select * from identity.appointment_email_claim('reminder-suite-worker', 50, 60))
  select string_agg(claim.recipient || ':' || claim.notice_code, ',' order by claim.recipient, claim.notice_code)
    into claimed from claim;
  return coalesce(claimed, '(none)');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.email_record(patient integer, outcome text, worker text default 'reminder-suite-worker')
returns text language plpgsql as $f$
begin
  perform pg_temp.as_system();
  return identity.appointment_email_record((select email.id from ehr.appointment_email_outbox email
    where email.patient_id = pg_temp.patient(patient) and email.notice_code = 'APPOINTMENT_BOOKED'
    order by email.created_at limit 1), worker, outcome, null);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
alter function pg_temp.email_record(integer, text, text) security definer;
-- More rows without a recipient than one claim's limit (rolled back after each, so the cases below see the state
-- above): none is ever leased. A: p3's unverified rows are the oldest and outnumber the limit (2); the claim leases
-- only p1's rows. B: p1 has turned notices off; a claim of 1 leases nothing.
create function pg_temp.email_claim_limited(claim_limit integer) returns text language plpgsql as $f$
declare
  claimed text;
begin
  perform pg_temp.as_system();
  with claim as (select * from identity.appointment_email_claim('reminder-suite-worker', claim_limit, 60))
  select string_agg(claim.recipient, ',' order by claim.recipient) into claimed from claim;
  return coalesce(claimed, '(none)');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
savepoint n161_email_limit;
update ehr.appointment_email_outbox set created_at = clock_timestamp() + interval '1 hour'
 where patient_id <> pg_temp.patient(3) and state = 'pending';
select (count(*) > 2)::text as n161_p3_waiting from ehr.appointment_email_outbox
 where patient_id = pg_temp.patient(3) and state = 'pending' \gset
set local role hid_identity_api_runtime;
select pg_temp.email_claim_limited(2) as n161_claim_past_skips \gset
reset role;
select count(*)::text as n161_p3_leased from ehr.appointment_email_outbox
 where patient_id = pg_temp.patient(3) and state = 'claimed' \gset
rollback to savepoint n161_email_limit;
savepoint n161_email_notices_off;
update identity.patients set notifications_enabled = false where id = pg_temp.patient(1);
set local role hid_identity_api_runtime;
select pg_temp.email_claim_limited(1) as n161_claim_notices_off \gset
reset role;
rollback to savepoint n161_email_notices_off;
select pg_temp.check_case('5 more than the limit of p3''s unverified rows wait first', 'true', :'n161_p3_waiting');
select pg_temp.check_case('5 a claim past them leases only verified recipients',
  'reminder-patient-1@example.invalid,reminder-patient-1@example.invalid/0',
  :'n161_claim_past_skips' || '/' || :'n161_p3_leased');
select pg_temp.check_case('5 notices turned off: nothing is leased, whatever the limit', '(none)', :'n161_claim_notices_off');
select string_agg('reminder-patient-1@example.invalid:' || notice_code, ',' order by notice_code) as n161_p1_emails
  from ehr.appointment_email_outbox where patient_id = pg_temp.patient(1) \gset
set local role hid_identity_api_runtime;
select pg_temp.as_member(1);
select pg_temp.check_case('5 a staff session cannot claim emails', '42501',
  pg_temp.try('select * from identity.appointment_email_claim(''reminder-suite-worker'', 5, 60)'));
select pg_temp.check_case('5 claimed: p1''s rows to the verified email; p3''s (not verified) are skipped',
  :'n161_p1_emails', pg_temp.email_claim());
reset role;
select pg_temp.check_case('5 p3''s rows closed as skipped (no verified email)', 'skipped',
  (select string_agg(distinct state || coalesce(':' || nullif(last_error_code, 'no_verified_recipient'), ''), ',')
     from ehr.appointment_email_outbox where patient_id = pg_temp.patient(3)));
select pg_temp.check_case('5 p1''s booking email delivered', 'delivered', pg_temp.email_record(1, 'delivered'));
select pg_temp.check_case('5 recorded again: stale', 'stale', pg_temp.email_record(1, 'delivered'));
select pg_temp.check_case('5 another worker''s lease: stale', 'stale', pg_temp.email_record(1, 'retry', 'another-worker'));
select pg_temp.check_case('5 one audit row, without the address', 'success:APPOINTMENT_BOOKED:sent',
  (select string_agg(outcome || ':' || (details ->> 'notice') || ':' || (details ->> 'state'), ',')
     from audit.events where action = 'notification.appointment-email.send'));

-- 6. "My appointments". p4 booked at B, p1 at A (several).
set local role hid_ehr_api_runtime;
select pg_temp.check_case('6 p1 booked at B? no: not B''s patient', 'needs_search', pg_temp.book(3, 'p1-at-b', 1, pg_temp.slot(60 * 24 * 10)));
select pg_temp.check_case('6 p4 booked at B', 'booked', pg_temp.book(3, 'p4-b', 4, pg_temp.slot(60 * 24 * 10)));
reset role;
select string_agg('Reminder Clinic A:' || appointment.status, ',' order by appointment.starts_at) || '/false'
       as n161_p1_upcoming
  from ehr.appointments appointment
 where appointment.patient_id = pg_temp.patient(1)
   and appointment.appointment_day >= (clock_timestamp() at time zone 'Africa/Lagos')::date \gset
set local role hid_ehr_api_runtime;
create function pg_temp.my_list(n integer, as_patient_n integer, kind text, page_limit integer default 50) returns text
language plpgsql as $f$
begin
  perform pg_temp.as_patient(as_patient_n);
  return (select coalesce(string_agg(listed.facility_name || ':' || listed.status, ',' order by listed.starts_at), '(none)')
            || '/' || coalesce(bool_or(listed.has_more), false)::text
            from ehr.appointment_my_list(pg_temp.patient(n), kind, page_limit, null, null) listed);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select pg_temp.check_case('6 p1 upcoming: every booking from today on, cancelled included',
  :'n161_p1_upcoming', pg_temp.my_list(1, 1, 'upcoming'));
select pg_temp.check_case('6 p1 upcoming, one a page: has more', 'true',
  split_part(pg_temp.my_list(1, 1, 'upcoming', 1), '/', 2));
select pg_temp.check_case('6 p1 past: none yet', '(none)/false', pg_temp.my_list(1, 1, 'past'));
select pg_temp.check_case('6 p4 sees B''s booking', 'Reminder Clinic B:booked/false', pg_temp.my_list(4, 4, 'upcoming'));
select pg_temp.check_case('6 p1''s session cannot read p4''s list', '42501 PATIENT_SESSION_REQUIRED',
  pg_temp.my_list(4, 1, 'upcoming'));
select pg_temp.as_member(1);
select pg_temp.check_case('6 a staff session cannot read it', '42501',
  pg_temp.try(format('select * from ehr.appointment_my_list(%L, ''upcoming'', 10, null, null)', pg_temp.patient(1))));
select pg_temp.check_case('6 a bad "when" is refused', '22023 APPOINTMENT_INVALID', pg_temp.my_list(1, 1, 'soon'));
select pg_temp.check_case('6 the answer has no staff id and no booking basis', '0',
  (select count(*)::text from pg_proc proc, unnest(proc.proargnames) argument_name
    where proc.oid = 'ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid)'::regprocedure
      and (argument_name like '%membership%' or argument_name like '%basis%')));
reset role;
select pg_temp.check_case('6 each read audited as the patient', 'patient:patient-self:3',
  (select actor_type || ':' || purpose_of_use || ':' || count(*) from audit.events
    where action = 'ehr.appointment.patient-read' and patient_id = pg_temp.patient(1) and outcome = 'success'
    group by actor_type, purpose_of_use));

-- 7. The call list (identity runtime).
create function pg_temp.call_list(n integer, day date, purpose text default 'direct-care') returns text
language plpgsql as $f$
begin
  perform pg_temp.as_member(n);
  perform set_config('app.purpose_of_use', purpose, true);
  return (select coalesce(string_agg(listed.full_name || ':' || listed.health_id_last4 || ':'
            || coalesce(left(encode(listed.phone_ciphertext, 'hex'), 4), '-'), ',' order by listed.starts_at), '(none)')
            from identity.appointment_call_list(day, null, null) listed);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.check_case('7 p1 booked on day 12', 'booked', pg_temp.book(1, 'c1', 1, pg_temp.slot(60 * 24 * 12)));
select pg_temp.check_case('7 p2 booked on day 12, later', 'booked', pg_temp.book(1, 'c2', 2, pg_temp.slot(60 * 24 * 12 + 60)));
select pg_temp.check_case('7 p3 booked on day 12, then cancelled', 'booked', pg_temp.book(1, 'c3', 3, pg_temp.slot(60 * 24 * 12 + 120)));
select pg_temp.check_case('7 c3 cancelled', 'updated', pg_temp.cancel(1, 'c3'));
reset role;
select (pg_temp.slot(60 * 24 * 12) at time zone 'Africa/Lagos')::date as n161_day \gset
set local role hid_identity_api_runtime;
select pg_temp.check_case('7 the desk''s call list: booked only, A''s current phone or none',
  case when (pg_temp.slot(60 * 24 * 12 + 60) at time zone 'Africa/Lagos')::date = :'n161_day'::date
       then 'Ngozi Remindone:AA33:0202,Obi Remindtwo:AB33:-' else 'Ngozi Remindone:AA33:0202' end,
  pg_temp.call_list(1, :'n161_day'));
select pg_temp.check_case('7 the nurse (read only) has no call list', '42501 APPOINTMENT_NOT_ALLOWED',
  pg_temp.call_list(2, :'n161_day'));
select pg_temp.check_case('7 B''s desk sees nothing of A''s', '(none)', pg_temp.call_list(3, :'n161_day'));
select pg_temp.check_case('7 direct care only', '22023 APPOINTMENT_DIRECT_CARE_ONLY',
  pg_temp.call_list(1, :'n161_day', 'healthcare-operations'));
reset role;
select pg_temp.check_case('7 audited: one read row for the desk''s list and one shown row per patient',
  'identity.appointment-call-list.read:1,identity.appointment-call-list.shown:'
  || case when (pg_temp.slot(60 * 24 * 12 + 60) at time zone 'Africa/Lagos')::date = :'n161_day'::date then 2 else 1 end,
  (select string_agg(action || ':' || count, ',' order by action)
     from (select action, count(*) from audit.events where action like 'identity.appointment-call-list.%'
            and facility_id = 'e1610000-0000-4000-8000-000000000002' group by action) counted));

-- 8. Privileges.
select pg_temp.check_case('8 no runtime reads or writes an outbox', 'false/false/false/false',
  has_table_privilege('hid_ehr_api_runtime', 'ehr.appointment_email_outbox', 'select')::text || '/'
  || has_table_privilege('hid_identity_api_runtime', 'ehr.appointment_email_outbox', 'select')::text || '/'
  || has_table_privilege('hid_ehr_api_runtime', 'ehr.appointment_sms_outbox', 'insert')::text || '/'
  || has_table_privilege('hid_identity_api_runtime', 'ehr.appointment_sms_outbox', 'select')::text);
select pg_temp.check_case('8 each runtime calls only its own functions', 'true/true/false/false/false/true',
  has_function_privilege('hid_ehr_api_runtime', 'ehr.appointment_send_reminders(integer)', 'execute')::text || '/'
  || has_function_privilege('hid_ehr_api_runtime', 'ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid)', 'execute')::text || '/'
  || has_function_privilege('hid_ehr_api_runtime', 'identity.appointment_call_list(date, uuid, uuid)', 'execute')::text || '/'
  || has_function_privilege('hid_identity_api_runtime', 'ehr.appointment_send_reminders(integer)', 'execute')::text || '/'
  || has_function_privilege('hid_ehr_api_runtime', 'identity.appointment_email_claim(text, integer, integer)', 'execute')::text || '/'
  || has_function_privilege('hid_identity_api_runtime', 'identity.appointment_email_record(uuid, text, text, text)', 'execute')::text);
select pg_temp.check_case('8 nothing for public', '0',
  (select count(*)::text from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
    where proc.oid in ('ehr.appointment_send_reminders(integer)'::regprocedure,
                       'ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid)'::regprocedure,
                       'identity.appointment_call_list(date, uuid, uuid)'::regprocedure,
                       'identity.appointment_sms_claim(integer)'::regprocedure,
                       'identity.appointment_sms_record(uuid, text, text)'::regprocedure,
                       'identity.appointment_email_claim(text, integer, integer)'::regprocedure,
                       'identity.appointment_email_record(uuid, text, text, text)'::regprocedure,
                       'ehr.appointment_notice(uuid, text, timestamptz)'::regprocedure)
      and acl.grantee = 0));

-- 9. Audit.
select pg_temp.check_case('9 no name, Health ID, phone, reason text, address or clinic name in any 0161 audit row', '0',
  (select count(*)::text from audit.events
    where (action in ('ehr.appointment.reminder', 'ehr.appointment.patient-read', 'notification.appointment-sms.send',
                      'notification.appointment-email.send')
           or action like 'identity.appointment-call-list.%')
      and (details::text ~* 'remind(one|two|three|four)|ngozi|obi |peju|remi |HID-RM|0202|blood pressure|moved|called|example\.invalid|Reminder Clinic'
           or coalesce(reason, '') <> '')));
select pg_temp.check_case('9 the apply row of 0161', 'platform.control.add:system:appointment_sms_reminders_enabled',
  (select action || ':' || actor_type || ':' || resource_id from audit.events
    where correlation_id = '0161-appointment-notices-appt1'));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.n_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0161 appointment notices:\n%', mismatch;
  end if;
  raise notice '0161 appointment notices: % cases passed', (select count(*) from pg_temp.n_outcomes);
end $$;

rollback;
