\set ON_ERROR_STOP on
-- "Your records were opened" (0095, B4 D9): one notice per patient, facility
-- and Africa/Lagos day; at most 10 a day per patient; the inbox item names the
-- facility and the access kind (standard, share, pin); break-glass, another
-- membership's grant and an ended grant are not applicable; the email's
-- claim (system:auth, 0063's recipient rule, lease), outcome, retry and
-- 24-hour window.
-- Rollback-only. Synthetic values only; uuid prefix 95c.
set plpgsql.variable_conflict = error;
begin;

-- 1. Fixtures: one doctor account with memberships at 12 facilities, a
-- second doctor at facility 1; P1 (verified email, notifications on), P2
-- (no verified email).
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'notice-test'), ('emergency', 'Emergency treatment', 'notice-test')
  on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at) values
  ('95c10000-0000-4000-8000-000000000001', 'synthetic:notice:doctor', 'notice-doctor@example.invalid', 'Notice Doctor', 'active', clock_timestamp()),
  ('95c10000-0000-4000-8000-000000000002', 'synthetic:notice:doctor2', 'notice-doctor2@example.invalid', 'Notice Doctor 2', 'active', clock_timestamp()),
  ('95c10000-0000-4000-8000-000000000003', 'synthetic:notice:p1', 'Notice-P1@Example.invalid', 'Notice P1', 'active', clock_timestamp()),
  ('95c10000-0000-4000-8000-000000000004', 'synthetic:notice:p2', 'notice-p2@example.invalid', 'Notice P2', 'active', null);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('95c20000-0000-4000-8000-000000000001', '95c10000-0000-4000-8000-000000000003', 'HID-NTCPAA', 'Ngozi', 'Notice', 'Ngozi Notice', 'active'),
  ('95c20000-0000-4000-8000-000000000002', '95c10000-0000-4000-8000-000000000004', 'HID-NTCPBB', 'Tunde', 'Notice', 'Tunde Notice', 'active');
insert into identity.organizations (id, name, slug) values
  ('95c40000-0000-4000-8000-000000000001', 'Notice Org', 'notice-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
select ('95c41000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, '95c40000-0000-4000-8000-000000000001',
  'Notice Clinic ' || n, 'NTC-' || n, 'Africa/Lagos', true, 'verified' from generate_series(1, 12) n;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('95c50000-0000-4000-8000-000000000001', '95c10000-0000-4000-8000-000000000001', 'Doctor Notice One', 'notice-doctor@example.invalid', 'verified', 'doctor'),
  ('95c50000-0000-4000-8000-000000000002', '95c10000-0000-4000-8000-000000000002', 'Doctor Notice Two', 'notice-doctor2@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('95c60000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, '95c50000-0000-4000-8000-000000000001',
  '95c10000-0000-4000-8000-000000000001', '95c40000-0000-4000-8000-000000000001',
  ('95c41000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'doctor', 'doctor', n = 1, true
from generate_series(1, 12) n;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('95c60000-0000-4000-8000-000000000099', '95c50000-0000-4000-8000-000000000002', '95c10000-0000-4000-8000-000000000002',
   '95c40000-0000-4000-8000-000000000001', '95c41000-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true);
-- Grants (as the owner): P1 at each of the 12 facilities (standard); at
-- facility 1 also a PIN grant for P2, a break-glass grant for P2, an expired
-- grant; doctor 2's grant for P1 at facility 1.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, granted_by_patient_id)
select ('95c80000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, '95c20000-0000-4000-8000-000000000001',
  '95c50000-0000-4000-8000-000000000001', '95c10000-0000-4000-8000-000000000001',
  ('95c60000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('95c41000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'read_records', 'direct-care', 'active',
  'Approved by the patient', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour', false,
  'notice-grant-' || n, '95c20000-0000-4000-8000-000000000001'
from generate_series(1, 12) n;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, granted_by_patient_id,
  authorization_method) values
  ('95c81000-0000-4000-8000-000000000001', '95c20000-0000-4000-8000-000000000002', '95c50000-0000-4000-8000-000000000001',
   '95c10000-0000-4000-8000-000000000001', '95c60000-0000-4000-8000-000000000001', '95c41000-0000-4000-8000-000000000001',
   'read_records', 'direct-care', 'active', 'Patient access PIN', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '15 minutes', false, 'notice-pin-01', null, 'patient_access_pin'),
  ('95c81000-0000-4000-8000-000000000002', '95c20000-0000-4000-8000-000000000002', '95c50000-0000-4000-8000-000000000001',
   '95c10000-0000-4000-8000-000000000001', '95c60000-0000-4000-8000-000000000001', '95c41000-0000-4000-8000-000000000001',
   'break_glass', 'emergency', 'active', 'Unconscious patient in the emergency room', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '30 minutes', true, 'notice-bg-01', null, null),
  ('95c81000-0000-4000-8000-000000000003', '95c20000-0000-4000-8000-000000000002', '95c50000-0000-4000-8000-000000000001',
   '95c10000-0000-4000-8000-000000000001', '95c60000-0000-4000-8000-000000000001', '95c41000-0000-4000-8000-000000000001',
   'read_records', 'direct-care', 'active', 'Ended approval', clock_timestamp() - interval '2 hours',
   clock_timestamp() - interval '1 hour', false, 'notice-exp-01', '95c20000-0000-4000-8000-000000000002', null),
  ('95c81000-0000-4000-8000-000000000004', '95c20000-0000-4000-8000-000000000001', '95c50000-0000-4000-8000-000000000002',
   '95c10000-0000-4000-8000-000000000002', '95c60000-0000-4000-8000-000000000099', '95c41000-0000-4000-8000-000000000001',
   'read_records', 'direct-care', 'active', 'Approved by the patient', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'notice-d2-01', '95c20000-0000-4000-8000-000000000001', null);
-- P1's grant at facility 2 came from a patient share.
insert into identity.patient_consent_shares (consent_grant_id, patient_id, membership_id, level, duration_preset,
  created_via, idempotency_key, request_sha256) values
  ('95c80000-0000-4000-8000-000000000002', '95c20000-0000-4000-8000-000000000001', '95c60000-0000-4000-8000-000000000002',
   'view_only', '24h', 'search', 'notice-share-key-0001', repeat('a', 64));

create function pg_temp.as_staff(subject text, membership text, facility integer, correlation text) returns void
language sql as $$
  select set_config('app.actor_subject', subject, true),
    set_config('app.facility_id', '95c41000-0000-4000-8000-0000000000' || lpad(facility::text, 2, '0'), true),
    set_config('app.membership_id', membership, true),
    set_config('app.purpose_of_use', 'direct-care', true), set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.note(facility integer, grant_id text) returns text language plpgsql as $$
begin
  perform pg_temp.as_staff('synthetic:notice:doctor', '95c60000-0000-4000-8000-0000000000' || lpad(facility::text, 2, '0'),
    facility, 'notice-note-' || facility);
  return identity.note_record_access(grant_id::uuid);
exception when others then
  return format('%s %s', sqlstate, sqlerrm);
end $$;
create function pg_temp.try(statement text) returns text language plpgsql as $$
declare answer text;
begin
  execute statement into answer;
  return 'ok ' || coalesce(answer, '');
exception when others then
  return format('%s %s', sqlstate, sqlerrm);
end $$;
grant execute on function pg_temp.as_staff(text, text, integer, text), pg_temp.note(integer, text), pg_temp.try(text)
  to public;

-- 2. Notes, as the Identity API runtime.
set local role hid_identity_api_runtime;
do $$
declare answer text;
begin
  if pg_temp.note(1, '95c80000-0000-4000-8000-000000000001') <> 'noted'
     or pg_temp.note(1, '95c80000-0000-4000-8000-000000000001') <> 'already_noted'
     or pg_temp.note(2, '95c80000-0000-4000-8000-000000000002') <> 'noted' then
    raise exception 'One notice per facility and day';
  end if;
  -- Facilities 3-10 reach 10 notices for P1; facility 11 is capped.
  for n in 3..10 loop
    answer := pg_temp.note(n, '95c80000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'));
    if answer <> 'noted' then raise exception 'Facility %: %', n, answer; end if;
  end loop;
  if pg_temp.note(11, '95c80000-0000-4000-8000-000000000011') <> 'capped' then
    raise exception 'The 11th facility in a day must be capped';
  end if;
  -- Break-glass, an ended grant, another facility's grant: not applicable.
  if pg_temp.note(1, '95c81000-0000-4000-8000-000000000002') <> 'not_applicable'
     or pg_temp.note(1, '95c81000-0000-4000-8000-000000000003') <> 'not_applicable'
     or pg_temp.note(12, '95c80000-0000-4000-8000-000000000001') <> 'not_applicable'
     or pg_temp.note(1, '95c81000-0000-4000-8000-000000000004') <> 'not_applicable' then
    raise exception 'Break-glass, ended and other grants must not be noted';
  end if;
  -- The PIN read of P2 (no verified email): noted, kind pin, no email.
  if pg_temp.note(1, '95c81000-0000-4000-8000-000000000001') <> 'noted' then
    raise exception 'A PIN read must be noted';
  end if;
  -- Doctor 2 at facility 1, the same day: already noted for that facility.
  perform pg_temp.as_staff('synthetic:notice:doctor2', '95c60000-0000-4000-8000-000000000099', 1, 'notice-note-d2');
  if identity.note_record_access('95c81000-0000-4000-8000-000000000004') <> 'already_noted' then
    raise exception 'A second clinician at the same facility the same day is the same notice';
  end if;
end $$;
reset role;
do $$
declare mismatch text;
begin
  if (select count(*) from identity.record_access_notices where patient_id = '95c20000-0000-4000-8000-000000000001') <> 10
     or exists (select 1 from identity.record_access_notices
                 where notice_day <> (clock_timestamp() at time zone 'Africa/Lagos')::date) then
    raise exception 'P1 must have exactly 10 notices, each on the Lagos day';
  end if;
  select string_agg(format('%s/%s/%s', f.name, n.access_kind, n.email_status), ', ') into mismatch
    from identity.record_access_notices n join identity.facilities f on f.id = n.facility_id
   where (n.facility_id = '95c41000-0000-4000-8000-000000000001' and n.patient_id = '95c20000-0000-4000-8000-000000000001'
          and (n.access_kind, n.email_status) <> ('standard', 'pending'))
      or (n.facility_id = '95c41000-0000-4000-8000-000000000002' and (n.access_kind, n.email_status) <> ('share', 'pending'))
      or (n.patient_id = '95c20000-0000-4000-8000-000000000002' and (n.access_kind, n.email_status) <> ('pin', 'not_sent'));
  if mismatch is not null then raise exception 'Notice kinds and email states: %', mismatch; end if;
  if (select count(*) from notification.inbox_items where notification_code = 'RECORDS_OPENED'
       and resource_type = 'record-access') <> 11
     or not exists (select 1 from notification.inbox_items item join identity.record_access_notices n on n.id = item.resource_id
                     where item.notification_code = 'RECORDS_OPENED' and n.inbox_item_id = item.id
                       and item.metadata = '{"accessKind": "share", "facilityName": "Notice Clinic 2"}'::jsonb) then
    raise exception 'RECORDS_OPENED items must name the facility and the kind only';
  end if;
  if exists (select 1 from audit.events where action = 'identity.record-access-notice.note' and outcome = 'success'
              and details <> '{"accessKind": "standard"}'::jsonb and details <> '{"accessKind": "share"}'::jsonb
              and details <> '{"accessKind": "pin"}'::jsonb)
     or (select count(*) from audit.events where action = 'identity.record-access-notice.note' and outcome = 'denied') <> 4 then
    raise exception 'Note audit rows';
  end if;
end $$;

-- 3. The email: claim, outcome, retry, window.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:notice:doctor', true), set_config('app.correlation_id', 'notice-claim-00', true);
do $$
begin
  if pg_temp.try($q$select count(*)::text from identity.claim_record_access_alerts('worker-a', 5, 60)$q$) not like '42501 %'
     or pg_temp.try($q$select identity.record_record_access_alert_outcome('95c80000-0000-4000-8000-000000000001', 'worker-a', 'accepted', null, null)$q$) not like '42501 %' then
    raise exception 'Claim and outcome are system:auth only';
  end if;
end $$;
select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', 'notice-claim-01', true);
do $$
declare
  claimed record;
  total integer := 0;
  first_notice uuid;
  second_notice uuid;
begin
  if pg_temp.try($q$select count(*)::text from identity.claim_record_access_alerts('worker-a', 5, 5)$q$) not like '22023 %' then
    raise exception 'A lease under 15 s must be refused';
  end if;
  for claimed in select * from identity.claim_record_access_alerts('worker-a', 3, 60) loop
    total := total + 1;
    if claimed.recipient <> 'notice-p1@example.invalid' or claimed.attempt_count <> 1 then
      raise exception 'Claimed: %', claimed;
    end if;
    if first_notice is null then first_notice := claimed.notice_id; else second_notice := claimed.notice_id; end if;
  end loop;
  if total <> 3 then raise exception 'The claim must lease 3: %', total; end if;
  -- Leased notices are not claimed again.
  if (select count(*) from identity.claim_record_access_alerts('worker-b', 50, 60)) <> 7 then
    raise exception 'The second worker must lease the 7 others';
  end if;
  if identity.record_record_access_alert_outcome(first_notice, 'worker-b', 'accepted', null, null) <> 'stale_lease'
     or identity.record_record_access_alert_outcome(first_notice, 'worker-a', 'accepted', 'novu', null) <> 'delivered'
     or identity.record_record_access_alert_outcome(second_notice, 'worker-a', 'unknown', null, 'transport_error') <> 'pending' then
    raise exception 'Outcomes';
  end if;
  perform set_config('hid.retry_notice', second_notice::text, true);
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.record_access_notices where id = current_setting('hid.retry_notice')::uuid
                  and email_status = 'pending' and next_attempt_at > clock_timestamp() + interval '1 minute'
                  and lease_owner is null and attempt_count = 1 and safe_code = 'transport_error') then
    raise exception 'unknown schedules a retry with backoff';
  end if;
  -- A notice whose access was 25 hours ago is closed at claim (window), one
  -- at its fifth attempt is closed on unknown.
  update identity.record_access_notices set first_access_at = clock_timestamp() - interval '25 hours',
    next_attempt_at = clock_timestamp() - interval '1 second' where id = current_setting('hid.retry_notice')::uuid;
end $$;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', 'notice-claim-02', true);
do $$
begin
  if exists (select 1 from identity.claim_record_access_alerts('worker-c', 50, 60) c
              where c.notice_id = current_setting('hid.retry_notice')::uuid) then
    raise exception 'A notice past its 24-hour window must not be leased';
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.record_access_notices where id = current_setting('hid.retry_notice')::uuid
                  and email_status = 'failed' and safe_code = 'window_elapsed') then
    raise exception 'The window closes the notice';
  end if;
  -- P1 turns notifications off: a pending notice is not sent.
  update identity.patients set notifications_enabled = false where id = '95c20000-0000-4000-8000-000000000001';
  update identity.record_access_notices set lease_owner = null, lease_expires_at = null
   where patient_id = '95c20000-0000-4000-8000-000000000001' and email_status = 'pending';
end $$;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', 'notice-claim-03', true);
do $$
begin
  if (select count(*) from identity.claim_record_access_alerts('worker-d', 50, 60)) <> 0 then
    raise exception 'No recipient: nothing is leased';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.record_access_notices where email_status = 'pending')
     or (select count(*) from identity.record_access_notices where email_status = 'not_sent' and safe_code = 'no_recipient') <> 8 then
    raise exception 'Without a recipient the notices are not_sent';
  end if;
  begin
    delete from identity.record_access_notices where patient_id = '95c20000-0000-4000-8000-000000000002';
    raise exception 'guard missed';
  exception when others then
    if sqlerrm = 'guard missed' then raise; end if;
  end;
end $$;

rollback;
