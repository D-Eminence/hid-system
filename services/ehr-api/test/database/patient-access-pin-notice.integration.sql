\set ON_ERROR_STOP on
-- PIN-use notice and named requester (0128). Rollback-only, synthetic values
-- only (uuid prefix 0128...). The PIN is used through identity-api's runtime
-- role (hid_identity_api_runtime) with the session it sets; the patient's list
-- is read through Identity's runtime role with the patient's subject.
--   1. Structure: the notice function and trigger, the list's fourteen
--      columns, and no runtime role able to call the notice function.
--   2. One PIN use: one PATIENT_ACCESS_PIN_USED item naming the clinician,
--      their role, the facility and the grant's scope.
--   3. A replay, a wrong PIN and a patient without an account: no new item.
--   4. An emergency event keeps only its own notice.
--   5. The patient's access requests name the requester and their role.
begin;
set constraints all deferred;

-- 1. Structure.
do $$
declare mismatch text;
begin
  if to_regprocedure('notification.on_identity_pin_outbox_created()') is null
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'identity.outbox_events'::regclass
                       and trigger_row.tgname = 'pin_use_notification_inbox' and trigger_row.tgenabled = 'O') then
    raise exception 'pin notice: the notice function or its trigger is missing';
  end if;
  if (select count(*) from pg_proc proc, unnest(proc.proargmodes) mode
       where proc.oid = 'identity.list_my_access_requests()'::regprocedure and mode = 't') <> 14
     or pg_get_function_result('identity.list_my_access_requests()'::regprocedure)
        not like '%purpose_of_use text, requester_name text, requester_role text)' then
    raise exception 'pin notice: identity.list_my_access_requests() is not 0128''s';
  end if;
  select string_agg(role_row.rolname, ', ' order by role_row.rolname) into mismatch
    from pg_roles role_row
   -- not a superuser (CI's rehearsal superuser is named hid_rehearsal_admin; no runtime role is one), nor the
   -- function's owner, the migration login, whatever its name (hid_synthetic_schema_owner on the rehearsal's copy)
   where role_row.rolname like 'hid\_%' and not role_row.rolsuper
     and ((role_row.oid <> (select p.proowner from pg_proc p
                             where p.oid = 'notification.on_identity_pin_outbox_created()'::regprocedure)
           and has_function_privilege(role_row.oid, 'notification.on_identity_pin_outbox_created()', 'EXECUTE'))
          or (role_row.oid <> (select p.proowner from pg_proc p
                                where p.oid = 'identity.list_my_access_requests()'::regprocedure)
              and has_function_privilege(role_row.oid, 'identity.list_my_access_requests()', 'EXECUTE')
              and role_row.rolname not in ('hid_identity_runtime', 'hid_identity_api_runtime')));
  if mismatch is not null then
    raise exception 'pin notice: unexpected EXECUTE for %', mismatch;
  end if;
  if not has_function_privilege('hid_identity_runtime', 'identity.list_my_access_requests()', 'EXECUTE') then
    raise exception 'pin notice: hid_identity_runtime lost EXECUTE on identity.list_my_access_requests()';
  end if;
end
$$;

-- Fixtures: organisation O, facilities F "Notice Clinic" and G "Notice Annex";
-- clinician C (doctor at F, nurse at G); patients P (account, PIN 2468) and
-- N (no account, PIN 1357).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('01280000-0000-4000-8000-000000000001', 'staff:pin-notice', 'pin-notice-clinician@example.invalid',
   'Account Display Name', 'active'),
  ('01280000-0000-4000-8000-000000000002', 'patient:pin-notice', 'pin-notice-patient@example.invalid',
   'PIN Notice Patient', 'active');
insert into identity.organizations (id, name, slug) values
  ('01280001-0000-4000-8000-000000000001', 'PIN Notice Organization', 'pin-notice-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('01280002-0000-4000-8000-000000000001', '01280001-0000-4000-8000-000000000001', 'Notice Clinic', 'PIN-NOT-F',
   'Africa/Lagos', true, 'verified'),
  ('01280002-0000-4000-8000-000000000002', '01280001-0000-4000-8000-000000000001', 'Notice Annex', 'PIN-NOT-G',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('01280003-0000-4000-8000-000000000001', '01280000-0000-4000-8000-000000000001', 'Dr Ada Notice',
   'pin-notice-clinician@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (
  id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active
) values
  ('01280004-0000-4000-8000-000000000001', '01280003-0000-4000-8000-000000000001',
   '01280000-0000-4000-8000-000000000001', '01280001-0000-4000-8000-000000000001',
   '01280002-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true),
  ('01280004-0000-4000-8000-000000000002', '01280003-0000-4000-8000-000000000001',
   '01280000-0000-4000-8000-000000000001', '01280001-0000-4000-8000-000000000001',
   '01280002-0000-4000-8000-000000000002', 'nurse', 'nurse', false, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('01280005-0000-4000-8000-000000000001', '01280000-0000-4000-8000-000000000001', 'doctor', 'facility',
   '01280004-0000-4000-8000-000000000001', '01280002-0000-4000-8000-000000000001', 'PIN notice fixture role');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('01280006-0000-4000-8000-000000000001', '01280000-0000-4000-8000-000000000002', 'HID-PNNTCE77', 'PIN', 'Notice',
   'PIN Notice Patient', 'active'),
  ('01280006-0000-4000-8000-000000000002', null, 'HID-PNNTCE88', 'PIN', 'Nobody', 'PIN Notice No Account', 'active');
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'pin-notice-test') on conflict (code) do nothing;
insert into identity.patient_access_pins (
  patient_id, pin_hash, source_system, source_record_id, source_created_at, source_updated_at
) values
  ('01280006-0000-4000-8000-000000000001', crypt('2468', gen_salt('bf')), 'supabase', 'pin-notice-1',
   clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day'),
  ('01280006-0000-4000-8000-000000000002', crypt('1357', gen_salt('bf')), 'supabase', 'pin-notice-2',
   clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day');

-- The PIN notices of a patient, as 'code|resource|metadata' rows.
create function pg_temp.pin_notices(patient uuid) returns text language sql as $$
  select coalesce(string_agg(item.notification_code || '|' || item.resource_type || '|' || item.metadata::text,
                             ' ; ' order by item.created_at, item.id), '')
    from notification.inbox_items item
   where item.patient_id = patient and item.notification_code = 'PATIENT_ACCESS_PIN_USED'
$$;
grant execute on function pg_temp.pin_notices(uuid) to public;

-- 2. One PIN use: one notice naming the clinician.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:pin-notice', true),
       set_config('app.membership_id', '01280004-0000-4000-8000-000000000001', true),
       set_config('app.facility_id', '01280002-0000-4000-8000-000000000001', true),
       set_config('app.correlation_id', 'pin-notice-use-0001', true),
       set_config('app.purpose_of_use', 'direct-care', true);
create temporary table pin_notice_grant on commit drop as
  select * from identity.access_patient_with_pin('HID-PNNTCE77', '2468', 15);
reset role;
do $$
declare
  granted record;
  item record;
begin
  select * into strict granted from pin_notice_grant;
  if not granted.verified or granted.existing_grant then
    raise exception 'pin notice: the PIN use did not create a grant';
  end if;
  select * into strict item from notification.inbox_items
   where patient_id = '01280006-0000-4000-8000-000000000001' and notification_code = 'PATIENT_ACCESS_PIN_USED';
  if item.account_id <> '01280000-0000-4000-8000-000000000002'::uuid
     or item.resource_type <> 'consent-grant' or item.resource_id <> granted.consent_grant_id
     or item.metadata <> jsonb_build_object(
          'consentGrantId', granted.consent_grant_id, 'reviewRequired', true,
          'scope', (select consent.scope from identity.consent_grants consent where consent.id = granted.consent_grant_id),
          'clinicianName', 'Dr Ada Notice', 'clinicianRole', 'doctor', 'facilityName', 'Notice Clinic') then
    raise exception 'pin notice: the notice is not as expected: % % %', item.resource_type, item.resource_id, item.metadata;
  end if;
  if (select consent.scope from identity.consent_grants consent where consent.id = granted.consent_grant_id)
     is distinct from item.metadata ->> 'scope' or item.metadata ->> 'scope' not in ('read_records', 'write_records') then
    raise exception 'pin notice: the notice does not carry the grant''s scope';
  end if;
  -- The account's display name is not used: the notice names the staff record.
  if item.metadata::text like '%Account Display Name%' then
    raise exception 'pin notice: the notice names the account display name, not the staff record';
  end if;
end
$$;

-- 3. A replay, a wrong PIN and a patient without an account add no notice.
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'pin-notice-use-0002', true);
do $$
declare replayed record;
begin
  select * into replayed from identity.access_patient_with_pin('HID-PNNTCE77', '2468', 15);
  if not replayed.verified or not replayed.existing_grant then
    raise exception 'pin notice: the second use was not a replay of the active grant';
  end if;
end
$$;
select set_config('app.correlation_id', 'pin-notice-use-0003', true);
do $$
declare wrong record;
begin
  select * into wrong from identity.access_patient_with_pin('HID-PNNTCE77', '9999', 15);
  if wrong.verified then
    raise exception 'pin notice: a wrong PIN verified';
  end if;
end
$$;
select set_config('app.correlation_id', 'pin-notice-use-0004', true);
do $$
declare no_account record;
begin
  select * into no_account from identity.access_patient_with_pin('HID-PNNTCE88', '1357', 15);
  if not no_account.verified then
    raise exception 'pin notice: the PIN of the patient without an account did not verify';
  end if;
end
$$;
reset role;
do $$
begin
  if (select count(*) from notification.inbox_items
       where patient_id = '01280006-0000-4000-8000-000000000001' and notification_code = 'PATIENT_ACCESS_PIN_USED') <> 1 then
    raise exception 'pin notice: a replay or a wrong PIN added a notice';
  end if;
  if (select count(*) from identity.outbox_events
       where event_type = 'PatientAccessPinVerified' and patient_id = '01280006-0000-4000-8000-000000000002') <> 1
     or exists (select 1 from notification.inbox_items where patient_id = '01280006-0000-4000-8000-000000000002') then
    raise exception 'pin notice: the patient without an account has an inbox item, or its PIN use left no event';
  end if;
end
$$;

-- 4. An emergency event keeps only 0037's own notice.
insert into identity.consent_grants (
  id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status, reason, starts_at, expires_at,
  break_glass, correlation_id, purpose_of_use
) values (
  '01280007-0000-4000-8000-000000000001', '01280006-0000-4000-8000-000000000001',
  '01280003-0000-4000-8000-000000000001', '01280000-0000-4000-8000-000000000001',
  '01280004-0000-4000-8000-000000000001', '01280002-0000-4000-8000-000000000001', 'break_glass', 'active',
  'Unconscious patient, synthetic', clock_timestamp(), clock_timestamp() + interval '1 hour', true,
  'pin-notice-emergency', 'emergency');
insert into identity.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, patient_id, correlation_id, payload)
values ('EmergencyAccessActivated', '01280007-0000-4000-8000-000000000001', 1, '01280002-0000-4000-8000-000000000001',
        '01280006-0000-4000-8000-000000000001', 'pin-notice-emergency',
        jsonb_build_object('consentGrantId', '01280007-0000-4000-8000-000000000001'::uuid, 'reviewRequired', true));
do $$
begin
  if (select count(*) from notification.inbox_items
       where patient_id = '01280006-0000-4000-8000-000000000001' and notification_code = 'PATIENT_ACCESS_PIN_USED') <> 1
     or (select count(*) from notification.inbox_items
          where patient_id = '01280006-0000-4000-8000-000000000001'
            and notification_code = 'EMERGENCY_ACCESS_ACTIVATED'
            and resource_id = '01280007-0000-4000-8000-000000000001') <> 1 then
    raise exception 'pin notice: an emergency event changed the PIN notices, or lost its own';
  end if;
end
$$;

-- 5. The patient's access requests name the requester and their role at the
-- request's facility: a request at F (doctor) and one at G (nurse); a request
-- whose membership is at another facility than the request's names no role.
set local session_replication_role = replica;
insert into identity.access_requests (
  id, patient_id, staff_id, membership_id, facility_id, scope, reason, status, requested_duration_minutes,
  break_glass, correlation_id, created_at, purpose_of_use
) values
  ('01280008-0000-4000-8000-000000000001', '01280006-0000-4000-8000-000000000001',
   '01280003-0000-4000-8000-000000000001', '01280004-0000-4000-8000-000000000001',
   '01280002-0000-4000-8000-000000000001', 'read_records', 'Follow-up visit', 'pending', 60, false,
   'pin-notice-request-1', clock_timestamp() - interval '3 minutes', 'direct-care'),
  ('01280008-0000-4000-8000-000000000002', '01280006-0000-4000-8000-000000000001',
   '01280003-0000-4000-8000-000000000001', '01280004-0000-4000-8000-000000000002',
   '01280002-0000-4000-8000-000000000002', 'read_records', 'Wound dressing', 'pending', 60, false,
   'pin-notice-request-2', clock_timestamp() - interval '2 minutes', 'direct-care'),
  ('01280008-0000-4000-8000-000000000003', '01280006-0000-4000-8000-000000000001',
   '01280003-0000-4000-8000-000000000001', '01280004-0000-4000-8000-000000000002',
   '01280002-0000-4000-8000-000000000001', 'read_records', 'Mismatched membership', 'pending', 60, false,
   'pin-notice-request-3', clock_timestamp() - interval '1 minute', 'direct-care');
set local session_replication_role = origin;
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'patient:pin-notice', true),
       set_config('app.membership_id', '', true), set_config('app.facility_id', '', true);
create temporary table pin_notice_requests on commit drop as
  select access_request_id, facility_name, purpose_of_use, requester_name, requester_role
    from identity.list_my_access_requests()
   where access_request_id::text like '01280008-%';
reset role;
do $$
declare got text;
begin
  select string_agg(right(access_request_id::text, 1) || ':' || facility_name || '/' || coalesce(requester_name, '-')
                    || '/' || coalesce(requester_role, '-') || '/' || purpose_of_use, ' ' order by access_request_id)
    into got from pin_notice_requests;
  if got is distinct from '1:Notice Clinic/Dr Ada Notice/doctor/direct-care 2:Notice Annex/Dr Ada Notice/nurse/direct-care '
                          || '3:Notice Clinic/Dr Ada Notice/-/direct-care' then
    raise exception 'pin notice: the request list is not as expected: %', got;
  end if;
end
$$;

do $$ begin raise notice 'PIN-use notice and named requester: all assertions passed'; end $$;
rollback;
