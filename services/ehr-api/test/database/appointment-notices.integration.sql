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
--   3. the reminder sweep: system:auth only; 0161's own sweep, run at the
--      hour the suite runs and undone, sends the due reminders between 07:00
--      and 21:00 Lagos and none outside; then, in this transaction only, a
--      copy of it whose one change is that the suite can set its Lagos hour
--      (create or replace: owner, grants, SECURITY DEFINER and search_path
--      kept): 0161's guard at its edges (none at 06 and 21, the due ones at
--      07 and 20), and the rest of 3 at noon Lagos, so every case of 3 runs
--      at any hour: exactly the booked appointments within 24 hours, without
--      a reminder, booked at least 12 hours before their start; inbox, email
--      and audit; a second run sends
--      nothing; no SMS row while the control is off; with it on, an SMS row
--      only for a patient with a phone this facility recorded; a reschedule
--      with it on keeps one unsent SMS row and the sweep goes on for every
--      facility, and after a sent one the moved appointment gets a new row;
--      with it on, no SMS row for a deceased patient or one who turned
--      notices off (the email's rule);
--   4. the SMS sender: nothing claimed while the control is off; 0161's own
--      claim, run at the hour the suite runs and undone, leases between 07:00
--      and 21:00 Lagos and none outside; then, in this transaction only, a
--      copy of it whose one change is the sweep's settable clock line (owner,
--      grants, SECURITY DEFINER and search_path kept): 0161's guard at its
--      edges (none at 06 and 21, the SMS at 07 and 20), and the rest of 4 at
--      noon Lagos; a queued SMS whose patient has since died or turned
--      notices off is closed unsent (PATIENT_NOT_REACHABLE) and never
--      claimed; claim and record under a sender's lease (another sender's
--      record and a second record are stale, a record without an outcome is
--      refused) with one audit row; system:auth only; a lease is always
--      answered: an erased phone closes the SMS (CONTACT_ERASED) and a new
--      phone and a move queue a new one, five lapsed leases close it
--      (ATTEMPTS_EXHAUSTED), a started appointment closes it
--      (APPOINTMENT_STARTED), an SMS kept by a move three days ahead waits
--      for the sweep, a move under a live lease leaves the appointment for the
--      next sweep (no notice, no SMS, no audit row), which then queues the new
--      time, and a move after a lapsed lease queues the SMS again (the late
--      record is stale);
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
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.check_case('3 a staff session cannot run the sweep', '42501',
  pg_temp.try('select ehr.appointment_send_reminders(10)'));
select pg_temp.check_case('3 a batch outside 1-500 is refused', '22023 APPOINTMENT_INVALID', pg_temp.sweep(0));
reset role;
-- The sweep's hour. 0161's own sweep runs first, at the hour the suite runs, and is undone: between 07:00 and 21:00
-- Lagos it sends the two due reminders, outside none. Then, for this transaction only, the function is replaced by a
-- copy of itself (create or replace, so its owner, grants, SECURITY DEFINER and search_path stay) whose one change is
-- its clock line: its Lagos hour is n161.lagos_hour when that is set, the clock's otherwise. 0161's guard is checked
-- in the copy at its edges, and the rest of 3 runs at noon Lagos, so every case of 3 runs whatever the hour.
-- A sweep of up to 50, at the Lagos hour given (or the clock's, when null), undone after: how many it sent.
create function pg_temp.sweep_undone(hour_in_lagos integer) returns text language plpgsql as $f$
declare
  answer text;
begin
  begin
    if hour_in_lagos is not null then
      perform set_config('n161.lagos_hour', hour_in_lagos::text, true);
    end if;
    answer := pg_temp.sweep(50);
    raise exception using errcode = 'P0001', message = 'appointment notices suite: undo the sweep';
  exception when sqlstate 'P0001' then
    return answer;
  end;
end
$f$;
create function pg_temp.sweep_attributes() returns text language sql as $f$
  select proowner::regrole::text || '/' || coalesce(proacl::text, '-') || '/' || prosecdef::text || '/'
         || coalesce(array_to_string(proconfig, ','), '-')
    from pg_proc where oid = 'ehr.appointment_send_reminders(integer)'::regprocedure
$f$;
-- Replaces the sweep by its copy when 0161's clock line is in it exactly once; answers how many times it is.
create function pg_temp.sweep_copy() returns text language plpgsql as $f$
declare
  clock_line constant text :=
    'lagos_hour integer := extract(hour from (clock_timestamp() at time zone ''Africa/Lagos''))::integer;';
  copy_line constant text :=
    'lagos_hour integer := coalesce(nullif(current_setting(''n161.lagos_hour'', true), '''')::integer, '
    || 'extract(hour from (clock_timestamp() at time zone ''Africa/Lagos''))::integer);';
  definition text := pg_get_functiondef('ehr.appointment_send_reminders(integer)'::regprocedure);
  found integer;
begin
  found := (length(definition) - length(replace(definition, clock_line, ''))) / length(clock_line);
  if found = 1 then
    execute replace(definition, clock_line, copy_line);
  end if;
  return found::text;
end
$f$;
set local role hid_ehr_api_runtime;
select extract(hour from (clock_timestamp() at time zone 'Africa/Lagos'))::integer between 7 and 20 as n161_in_window,
       pg_temp.sweep_undone(null) as n161_sweep_now \gset
select pg_temp.check_case('3 0161''s sweep, run now and undone: the two due between 07:00 and 21:00 Lagos, none outside',
  case when :'n161_in_window'::boolean then '2' else '0' end, :'n161_sweep_now');
reset role;
select pg_temp.sweep_attributes() as n161_sweep_attributes \gset
select pg_temp.check_case('3 the copy: 0161''s clock line found once, and replaced', '1', pg_temp.sweep_copy());
select pg_temp.check_case('3 the copy keeps the owner, the grants, SECURITY DEFINER and the search_path',
  :'n161_sweep_attributes', pg_temp.sweep_attributes());
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 0161''s guard, in the copy: none at 06 and 21 Lagos, the two due at 07 and 20', '0/2/2/0',
  pg_temp.sweep_undone(6) || '/' || pg_temp.sweep_undone(7) || '/' || pg_temp.sweep_undone(20) || '/'
  || pg_temp.sweep_undone(21));
-- From here on, noon in Lagos for the copy (the rest of 3).
select set_config('n161.lagos_hour', '12', true) as n161_lagos_hour \gset
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

-- 4. The SMS sender. Its claim has the sweep's clock line: 0161's own claim runs first, at the hour the suite runs,
-- and is undone (r6's SMS between 07:00 and 21:00 Lagos, none outside); then, for this transaction only, it is
-- replaced by a copy of itself whose one change is that line (n161.lagos_hour when set, noon from here on), as the
-- sweep was in 3, so every case of 4 runs whatever the hour.
update platform.control_settings set enabled = false where control_key = 'appointment_sms_reminders_enabled';
create function pg_temp.sms_claim(batch integer, worker text default 'reminder-suite-sms') returns text
language plpgsql as $f$
declare
  claimed text;
begin
  perform pg_temp.as_system();
  select string_agg(claim.facility_name || ':' || left(encode(claim.phone_ciphertext, 'hex'), 4) || ':' || claim.key_version
           || ':' || right(claim.registration_case_id::text, 2), ',')
    into claimed from identity.appointment_sms_claim(worker, batch) claim;
  return coalesce(claimed, '(none)');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The start times a claim answers (UTC, to the minute).
create function pg_temp.sms_claim_starts(worker text default 'reminder-suite-sms') returns text language plpgsql as $f$
declare
  claimed text;
begin
  perform pg_temp.as_system();
  select string_agg(to_char(claim.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), ',')
    into claimed from identity.appointment_sms_claim(worker, 10) claim;
  return coalesce(claimed, '(none)');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- Records the newest SMS row of an appointment for a sender.
create function pg_temp.sms_record(label text, outcome text, worker text default 'reminder-suite-sms') returns text
language plpgsql as $f$
begin
  perform pg_temp.as_system();
  return identity.appointment_sms_record((select sms.id from ehr.appointment_sms_outbox sms
    where sms.appointment_id = pg_temp.id(label) order by sms.created_at desc limit 1), worker, outcome, null);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
alter function pg_temp.sms_record(text, text, text) security definer;
-- An appointment's SMS rows, oldest first: state, error code and attempts.
create function pg_temp.sms_rows(label text) returns text language sql security definer as $f$
  select coalesce(string_agg(sms.state || ':' || coalesce(sms.last_error_code, '-') || ':' || sms.attempt_count,
           ',' order by sms.created_at, sms.id), '(none)')
    from ehr.appointment_sms_outbox sms where sms.appointment_id = pg_temp.id(label)
$f$;
-- A sender's lease that has lapsed (as the owner).
create function pg_temp.lapse(label text) returns void language sql security definer as $f$
  update ehr.appointment_sms_outbox set claimed_until = clock_timestamp() - interval '1 second'
   where appointment_id = pg_temp.id(label) and state = 'claimed'
$f$;
-- Claims as often as asked, the lease lapsing after each: what each claim answered.
create function pg_temp.claims_lapsing(label text, times integer) returns text language plpgsql as $f$
declare
  answers text[] := array[]::text[];
begin
  for attempt in 1..times loop
    answers := answers || pg_temp.sms_claim(10);
    perform pg_temp.lapse(label);
  end loop;
  return array_to_string(answers, '|');
end
$f$;
-- How many reminder audit rows an appointment has, and the channels of the newest.
create function pg_temp.reminded(label text) returns text language sql security definer as $f$
  select count(*) || '/' || coalesce((array_agg(details ->> 'channels' order by sequence_id desc))[1], '-')
    from audit.events where action = 'ehr.appointment.reminder' and resource_id = pg_temp.id(label)::text
$f$;
-- A booking of p1 by A's desk, placed due (starting in the hours given, booked 30 hours ago), then a sweep.
create function pg_temp.book_due(label text, hours integer) returns text language plpgsql as $f$
declare
  booked text;
begin
  booked := pg_temp.book(1, label, 1, pg_temp.slot(60 * 24 * 20 + hours * 60));
  perform pg_temp.place(label, pg_temp.slot(hours * 60), clock_timestamp() - interval '30 hours');
  return booked || '/' || pg_temp.sweep(50);
end
$f$;
grant execute on function pg_temp.place(text, timestamptz, timestamptz) to hid_ehr_api_runtime;
-- A reminder queued for an appointment that was cancelled since (r5): closed unsent at the next claim.
insert into ehr.appointment_sms_outbox (appointment_id, facility_id, patient_id, contact_id, created_at)
values (pg_temp.id('r5'), 'e1610000-0000-4000-8000-000000000002', pg_temp.patient(3),
  'e1610700-0000-4000-8000-000000000002', clock_timestamp() - interval '1 hour');
set local role hid_identity_api_runtime;
select pg_temp.check_case('4 nothing is claimed while the control is off', '(none)', pg_temp.sms_claim(10));
reset role;
update platform.control_settings set enabled = true where control_key = 'appointment_sms_reminders_enabled';
-- A claim of up to 10 at the Lagos hour given (or the clock's, when null), undone after: what it answered.
create function pg_temp.claim_undone(hour_in_lagos integer) returns text language plpgsql as $f$
declare
  answer text;
begin
  begin
    if hour_in_lagos is not null then
      perform set_config('n161.lagos_hour', hour_in_lagos::text, true);
    end if;
    answer := pg_temp.sms_claim(10);
    raise exception using errcode = 'P0001', message = 'appointment notices suite: undo the claim';
  exception when sqlstate 'P0001' then
    return answer;
  end;
end
$f$;
create function pg_temp.claim_attributes() returns text language sql as $f$
  select proowner::regrole::text || '/' || coalesce(proacl::text, '-') || '/' || prosecdef::text || '/'
         || coalesce(array_to_string(proconfig, ','), '-')
    from pg_proc where oid = 'identity.appointment_sms_claim(text, integer)'::regprocedure
$f$;
-- Replaces the claim by its copy when 0161's clock line is in it exactly once; answers how many times it is.
create function pg_temp.claim_copy() returns text language plpgsql as $f$
declare
  clock_line constant text :=
    'lagos_hour integer := extract(hour from (clock_timestamp() at time zone ''Africa/Lagos''))::integer;';
  copy_line constant text :=
    'lagos_hour integer := coalesce(nullif(current_setting(''n161.lagos_hour'', true), '''')::integer, '
    || 'extract(hour from (clock_timestamp() at time zone ''Africa/Lagos''))::integer);';
  definition text := pg_get_functiondef('identity.appointment_sms_claim(text, integer)'::regprocedure);
  found integer;
begin
  found := (length(definition) - length(replace(definition, clock_line, ''))) / length(clock_line);
  if found = 1 then
    execute replace(definition, clock_line, copy_line);
  end if;
  return found::text;
end
$f$;
-- 0161's own claim, now, and undone.
set local role hid_identity_api_runtime;
select extract(hour from (clock_timestamp() at time zone 'Africa/Lagos'))::integer between 7 and 20 as n161_claim_in_window,
       pg_temp.claim_undone(null) as n161_claim_now \gset
reset role;
select pg_temp.check_case('4 0161''s claim, run now and undone: r6''s SMS between 07:00 and 21:00 Lagos, none outside',
  case when :'n161_claim_in_window'::boolean then 'Reminder Clinic A:0202:v1:01' else '(none)' end, :'n161_claim_now');
select pg_temp.claim_attributes() as n161_claim_attributes \gset
select pg_temp.check_case('4 the copy: 0161''s clock line found once, and replaced', '1', pg_temp.claim_copy());
select pg_temp.check_case('4 the copy keeps the owner, the grants, SECURITY DEFINER and the search_path',
  :'n161_claim_attributes', pg_temp.claim_attributes());
set local role hid_identity_api_runtime;
select pg_temp.check_case('4 0161''s guard, in the copy: no SMS at 06 and 21 Lagos, r6''s at 07 and 20',
  '(none)/Reminder Clinic A:0202:v1:01/Reminder Clinic A:0202:v1:01/(none)',
  pg_temp.claim_undone(6) || '/' || pg_temp.claim_undone(7) || '/' || pg_temp.claim_undone(20) || '/'
  || pg_temp.claim_undone(21));
reset role;
-- From here on, noon in Lagos for the copies of the sweep and the claim (as set in 3).
select pg_temp.check_case('4 the copies run at noon Lagos from here on', '12', current_setting('n161.lagos_hour', true));
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
select pg_temp.check_case('4 a sender name outside 3-128 characters is refused', '22023 APPOINTMENT_INVALID',
  pg_temp.sms_claim(10, 'x'));
select pg_temp.check_case('4 the control on: the SMS with the facility name and A''s phone ciphertext',
  'Reminder Clinic A:0202:v1:01', pg_temp.sms_claim(10));
reset role;
select pg_temp.check_case('4 the cancelled appointment''s reminder was closed unsent', 'failed:APPOINTMENT_NOT_BOOKED',
  (select state || ':' || last_error_code from ehr.appointment_sms_outbox where appointment_id = pg_temp.id('r5')));
set local role hid_identity_api_runtime;
select pg_temp.as_member(1);
select pg_temp.check_case('4 a staff session cannot claim', '42501',
  pg_temp.try('select * from identity.appointment_sms_claim(''reminder-suite-sms'', 10)'));
reset role;
select pg_temp.check_case('4 another sender''s record: stale, and the lease stays as it was', 'stale/claimed:-:1',
  pg_temp.sms_record('r6', 'sent', 'another-sender') || '/' || pg_temp.sms_rows('r6'));
select pg_temp.check_case('4 a record without an outcome is refused', '22023 APPOINTMENT_INVALID',
  pg_temp.sms_record('r6', null));
select pg_temp.check_case('4 recorded as sent by the lease''s sender', 'sent', pg_temp.sms_record('r6', 'sent'));
select pg_temp.check_case('4 a second record is stale', 'stale', pg_temp.sms_record('r6', 'sent'));
select pg_temp.check_case('4 one audit row, without the phone',
  'success/{"state": "sent", "attempt": 1, "outcome": "sent", "errorCode": null}',
  (select string_agg(outcome || '/' || details::text, ',') from audit.events where action = 'notification.appointment-sms.send'));
-- A lease is always answered (each case below is rolled back after, so the sections below see the state above).
-- r10, p1's, is due and swept: its SMS is queued with A's current phone (02). A then erases that phone (0114's
-- erasure): the next claim closes the SMS unsent (CONTACT_ERASED) and answers nothing. The desk records a new phone
-- (03) and moves the appointment: the next sweep queues a new SMS with it (sms among the channels), and the next
-- claim answers it.
savepoint n161_sms_erased;
set local role hid_ehr_api_runtime;
select pg_temp.book_due('r10', 18) as n161_r10_due \gset
reset role;
update identity.patient_facility_contacts
   set phone_ciphertext = null, address_ciphertext = null, key_version = null, erased_at = clock_timestamp(),
       erasure_reason = 'erasure_request'
 where id = 'e1610700-0000-4000-8000-000000000002';
set local role hid_identity_api_runtime;
select pg_temp.sms_claim(10) as n161_claim_erased \gset
reset role;
select pg_temp.sms_rows('r10') as n161_r10_erased \gset
set local session_replication_role = replica;
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, idempotency_key, request_sha256,
  resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id,
  review_reason, created_at, updated_at)
values ('e1610500-0000-4000-8000-000000000012', 'e1610000-0000-4000-8000-000000000002',
  'e1610100-0000-4000-8000-000000000001', 'e1610300-0000-4000-8000-000000000001', 'approved_new_identity',
  'Ngozi', 'Remindone', 'Ngozi Remindone', date '1985-02-02', 'none', 'no_nin', 'reminder-case-key-00012',
  repeat('0', 64), 'e1610400-0000-4000-8000-000000000001', 'reminder-review-key-012', repeat('0', 64),
  'e1610100-0000-4000-8000-000000000001', 'e1610300-0000-4000-8000-000000000001', 'Checked at the desk',
  clock_timestamp(), clock_timestamp());
insert into identity.registration_case_contacts (registration_case_id, facility_id, phone_ciphertext, address_ciphertext,
  key_version, created_by_account_id, created_by_membership_id, erased_at, erasure_reason)
values ('e1610500-0000-4000-8000-000000000012', 'e1610000-0000-4000-8000-000000000002', decode(repeat('03', 32), 'hex'),
  decode(repeat('a3', 40), 'hex'), 'v1', 'e1610100-0000-4000-8000-000000000001', 'e1610300-0000-4000-8000-000000000001',
  null, null);
insert into identity.patient_facility_contacts (id, patient_id, facility_id, registration_case_id, phone_ciphertext,
  address_ciphertext, key_version, created_by_account_id, created_by_membership_id, created_at)
values ('e1610700-0000-4000-8000-000000000003', 'e1610400-0000-4000-8000-000000000001',
  'e1610000-0000-4000-8000-000000000002', 'e1610500-0000-4000-8000-000000000012', decode(repeat('03', 32), 'hex'),
  decode(repeat('a3', 40), 'hex'), 'v1', 'e1610100-0000-4000-8000-000000000001', 'e1610300-0000-4000-8000-000000000001',
  clock_timestamp());
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.move(1, 'r10', pg_temp.slot(19 * 60), 'erased') as n161_r10_moved, pg_temp.sweep(50) as n161_r10_swept \gset
reset role;
select pg_temp.reminded('r10') as n161_r10_reminded \gset
set local role hid_identity_api_runtime;
select pg_temp.sms_claim(10) as n161_claim_new_phone \gset
reset role;
select pg_temp.sms_rows('r10') as n161_r10_rows \gset
rollback to savepoint n161_sms_erased;
select pg_temp.check_case('4 r10 booked and swept: one reminder', 'booked/1', :'n161_r10_due');
select pg_temp.check_case('4 A erased p1''s phone: nothing claimed; r10''s SMS closed unsent (CONTACT_ERASED)',
  '(none)/failed:CONTACT_ERASED:0', :'n161_claim_erased' || '/' || :'n161_r10_erased');
select pg_temp.check_case('4 a new phone recorded and r10 moved: the sweep queues a new SMS with it',
  'updated/1/2/["inbox", "email", "sms"]', :'n161_r10_moved' || '/' || :'n161_r10_swept' || '/' || :'n161_r10_reminded');
select pg_temp.check_case('4 and the next claim answers it with the new phone',
  'Reminder Clinic A:0303:v1:12/failed:CONTACT_ERASED:0,claimed:-:1', :'n161_claim_new_phone' || '/' || :'n161_r10_rows');
-- r11: five claims, each lease lapsing unanswered, then a sixth: nothing more is claimed, and the SMS is closed
-- unsent (ATTEMPTS_EXHAUSTED) instead of staying claimed for good.
savepoint n161_sms_exhausted;
set local role hid_ehr_api_runtime;
select pg_temp.book_due('r11', 17) as n161_r11_due \gset
reset role;
set local role hid_identity_api_runtime;
select pg_temp.claims_lapsing('r11', 6) as n161_r11_claims \gset
reset role;
select pg_temp.sms_rows('r11') as n161_r11_rows \gset
rollback to savepoint n161_sms_exhausted;
select pg_temp.check_case('4 five lapsed leases, then a sixth claim: nothing more; r11''s SMS closed unsent',
  'booked/1 | ' || repeat('Reminder Clinic A:0202:v1:01|', 5) || '(none) | failed:ATTEMPTS_EXHAUSTED:5',
  :'n161_r11_due' || ' | ' || :'n161_r11_claims' || ' | ' || :'n161_r11_rows');
-- r12: its start passes before the SMS is claimed: closed unsent (APPOINTMENT_STARTED), never sent late.
savepoint n161_sms_started;
set local role hid_ehr_api_runtime;
select pg_temp.book_due('r12', 16) as n161_r12_due \gset
reset role;
select pg_temp.place('r12', pg_temp.slot(-10), clock_timestamp() - interval '30 hours');
set local role hid_identity_api_runtime;
select pg_temp.sms_claim(10) as n161_claim_started \gset
reset role;
select pg_temp.sms_rows('r12') as n161_r12_rows \gset
rollback to savepoint n161_sms_started;
select pg_temp.check_case('4 r12 started before its SMS went: nothing claimed, closed unsent (APPOINTMENT_STARTED)',
  'booked/1 | (none) | failed:APPOINTMENT_STARTED:0',
  :'n161_r12_due' || ' | ' || :'n161_claim_started' || ' | ' || :'n161_r12_rows');
-- r13: moved three days ahead with its SMS unsent: the SMS is kept and waits (not sent at once, days early); once the
-- appointment is due again it waits for the sweep, and then the claim answers it with the time it has then.
savepoint n161_sms_far;
set local role hid_ehr_api_runtime;
select pg_temp.book_due('r13', 15) as n161_r13_due \gset
select pg_temp.move(1, 'r13', pg_temp.slot(60 * 24 * 3 + 15 * 60), 'far') as n161_r13_moved \gset
reset role;
set local role hid_identity_api_runtime;
select pg_temp.sms_claim(10) as n161_claim_far \gset
reset role;
select pg_temp.sms_rows('r13') as n161_r13_waiting \gset
select pg_temp.place('r13', pg_temp.slot(14 * 60), clock_timestamp() - interval '30 hours');
set local role hid_identity_api_runtime;
select pg_temp.sms_claim(10) as n161_claim_not_swept \gset
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.sweep(50) as n161_r13_swept \gset
reset role;
set local role hid_identity_api_runtime;
select pg_temp.sms_claim_starts() as n161_claim_far_back \gset
reset role;
select (select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from ehr.appointments
         where id = pg_temp.id('r13')) as n161_r13_start,
       pg_temp.sms_rows('r13') as n161_r13_rows \gset
rollback to savepoint n161_sms_far;
select pg_temp.check_case('4 r13 moved three days ahead: its unsent SMS waits, not sent at once',
  'booked/1 | updated | (none) | pending:-:0', :'n161_r13_due' || ' | ' || :'n161_r13_moved' || ' | ' || :'n161_claim_far'
  || ' | ' || :'n161_r13_waiting');
select pg_temp.check_case('4 r13 due again: nothing until the sweep has reminded it, then the SMS with its time',
  '(none) | 1 | ' || :'n161_r13_start' || ' | claimed:-:1',
  :'n161_claim_not_swept' || ' | ' || :'n161_r13_swept' || ' | ' || :'n161_claim_far_back' || ' | ' || :'n161_r13_rows');
-- r14: moved while its SMS is under a live lease (the sender has read the old time). The sweep leaves r14 for later:
-- no notice, no reminder_sent_at, no audit row. Once the sender records the send, the next sweep reminds r14 and
-- queues a new SMS, which the claim answers with the new time.
savepoint n161_sms_live_lease;
set local role hid_ehr_api_runtime;
select pg_temp.book_due('r14', 13) as n161_r14_due \gset
reset role;
set local role hid_identity_api_runtime;
select pg_temp.sms_claim(10) as n161_r14_leased \gset
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.move(1, 'r14', pg_temp.slot(12 * 60), 'leased') as n161_r14_moved \gset
select pg_temp.sweep(50) as n161_r14_swept_leased \gset
reset role;
select pg_temp.reminded('r14') || ' | ' || (select coalesce(reminder_sent_at::text, 'not reminded') from ehr.appointments
         where id = pg_temp.id('r14')) || ' | ' || pg_temp.sms_rows('r14') as n161_r14_left \gset
select pg_temp.sms_record('r14', 'sent') as n161_r14_recorded \gset
set local role hid_ehr_api_runtime;
select pg_temp.sweep(50) as n161_r14_swept_after \gset
reset role;
select pg_temp.reminded('r14') as n161_r14_reminded \gset
set local role hid_identity_api_runtime;
select pg_temp.sms_claim_starts() as n161_r14_new_time \gset
reset role;
select (select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from ehr.appointments
         where id = pg_temp.id('r14')) as n161_r14_start,
       pg_temp.sms_rows('r14') as n161_r14_rows \gset
rollback to savepoint n161_sms_live_lease;
select pg_temp.check_case('4 r14 leased, then moved: the sweep leaves it for later (no notice, no SMS, no audit row)',
  'booked/1 | Reminder Clinic A:0202:v1:01 | updated | 0 | 1/["inbox", "email", "sms"] | not reminded | claimed:-:1',
  :'n161_r14_due' || ' | ' || :'n161_r14_leased' || ' | ' || :'n161_r14_moved' || ' | ' || :'n161_r14_swept_leased'
  || ' | ' || :'n161_r14_left');
select pg_temp.check_case('4 the lease answered: the next sweep reminds r14 with a new SMS, sent with the new time',
  'sent | 1 | 2/["inbox", "email", "sms"] | ' || :'n161_r14_start' || ' | sent:-:1,claimed:-:1',
  :'n161_r14_recorded' || ' | ' || :'n161_r14_swept_after' || ' | ' || :'n161_r14_reminded' || ' | '
  || :'n161_r14_new_time' || ' | ' || :'n161_r14_rows');
-- r15: moved after its lease lapsed unanswered: the sweep takes the SMS back into the queue (sms among the
-- channels), the late sender's record is stale, and another sender's claim answers it with the new time.
savepoint n161_sms_lapsed;
set local role hid_ehr_api_runtime;
select pg_temp.book_due('r15', 11) as n161_r15_due \gset
reset role;
set local role hid_identity_api_runtime;
select pg_temp.sms_claim(10) as n161_r15_leased \gset
reset role;
select pg_temp.lapse('r15');
set local role hid_ehr_api_runtime;
select pg_temp.move(1, 'r15', pg_temp.slot(10 * 60), 'lapsed') as n161_r15_moved \gset
select pg_temp.sweep(50) as n161_r15_swept \gset
reset role;
select pg_temp.reminded('r15') || ' | ' || pg_temp.sms_rows('r15') as n161_r15_queued \gset
select pg_temp.sms_record('r15', 'sent') as n161_r15_late \gset
set local role hid_identity_api_runtime;
select pg_temp.sms_claim_starts('reminder-suite-sms-2') as n161_r15_new_time \gset
reset role;
select (select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from ehr.appointments
         where id = pg_temp.id('r15')) as n161_r15_start,
       pg_temp.sms_rows('r15') as n161_r15_rows \gset
rollback to savepoint n161_sms_lapsed;
select pg_temp.check_case('4 r15''s lease lapsed, then moved: the sweep queues its SMS again; the late record is stale',
  'booked/1 | Reminder Clinic A:0202:v1:01 | updated | 1 | 2/["inbox", "email", "sms"] | pending:-:1 | stale',
  :'n161_r15_due' || ' | ' || :'n161_r15_leased' || ' | ' || :'n161_r15_moved' || ' | ' || :'n161_r15_swept' || ' | '
  || :'n161_r15_queued' || ' | ' || :'n161_r15_late');
select pg_temp.check_case('4 and another sender''s claim answers it with the new time',
  :'n161_r15_start' || ' | claimed:-:2', :'n161_r15_new_time' || ' | ' || :'n161_r15_rows');
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
                       'identity.appointment_sms_claim(text, integer)'::regprocedure,
                       'identity.appointment_sms_record(uuid, text, text, text)'::regprocedure,
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
