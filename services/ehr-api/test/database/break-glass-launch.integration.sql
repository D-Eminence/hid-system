\set ON_ERROR_STOP on
-- Break-glass in production (0085; main 0097 section 2 with 0c4de59 and
-- 17abba5, D-Eminence/hid-system; owner decision of 2026-10-24, "Enable
-- break-glass now"). Rollback-only.
--
-- 0085 seeds the active 'emergency' purpose of use that
-- identity.activate_break_glass (0031) requires, and changes no control and no
-- permission. Identity checks platform.require_control_enabled
-- ('break_glass_enabled') (0040) inside the activation transaction, before the
-- command, with the staff member's context, as these cases do through the
-- exact Identity runtime role:
--   1. the 'emergency' row is active after 0085, which also left the control
--      and the identity.break-glass.write holders as they were (this case runs
--      before any fixture, since other suites insert 'emergency' themselves,
--      so the suite fails on a database built only to 0084);
--   2. a doctor with an active facility membership and the permission, but
--      without platform.control.read, passes the control check and activates
--      break-glass; the grant, its approved request, its audit row and the
--      EmergencyAccessActivated outbox row are written;
--   3. with one verified contact with alerts on (and one with alerts off and
--      one unverified), 0084's trigger creates exactly one notification
--      intent;
--   4. with the control set off through the audited admin command,
--      require_control_enabled raises 55000
--      PLATFORM_CONTROL_DISABLED:break_glass_enabled and the activation that
--      would follow it in Identity's transaction writes nothing;
--   5. with the 'emergency' row deactivated (as an operator would), activation
--      raises 22023 "Break-glass requires the emergency purpose of use", the
--      grant from case 2 no longer authorizes the emergency read (0012), and
--      running 0085 again (the migration file itself) does not reactivate the
--      row or change it in any way.
--
-- require_control_enabled and control_enabled are SECURITY DEFINER, so they
-- read platform.control_settings (FORCE ROW LEVEL SECURITY, read policy
-- platform.control.read) as their owner, and the runtime role needs no
-- privilege on the table (it has none). An owner that bypasses row-level
-- security (a superuser, as here and as production's control reads require)
-- sees the row under any context. An owner that does not (the rehearsal's
-- synthetic NOBYPASSRLS owner) sees it only for an actor holding
-- platform.control.read, so under a staff context the check raises 55000
-- PLATFORM_CONTROL_UNAVAILABLE (Identity answers 503), exactly as Identity's
-- guard's portal check, platform.control_enabled('provider_portal_enabled'),
-- does on every staff request; the cases below record both outcomes.
begin;

-- 1. 0085's row, before any fixture.
do $$
begin
  if not exists (select 1 from identity.purpose_of_use_codes
                  where code = 'emergency' and active and display = 'Emergency treatment' and source_system = 'hid') then
    raise exception 'The active emergency purpose of use that 0085 seeds is missing: %',
      (select row_to_json(purpose) from identity.purpose_of_use_codes purpose where code = 'emergency');
  end if;
  if not exists (select 1 from migration.schema_migrations where version = '0085_emergency_purpose_of_use.sql') then
    raise exception '0085_emergency_purpose_of_use.sql is not applied';
  end if;
  -- 0085 changes no permission: 0010's three holders keep break-glass.
  if (select array_agg(role_code::text order by role_code) from auth.role_permissions
       where permission_code = 'identity.break-glass.write') is distinct from array['clinician', 'doctor', 'nurse'] then
    raise exception 'identity.break-glass.write is not held by exactly clinician, doctor and nurse';
  end if;
  -- Nor any control: 0039 seeded break_glass_enabled on, and no migration
  -- writes it.
  if not exists (select 1 from platform.control_settings
                  where control_key = 'break_glass_enabled' and enabled and updated_by is null) then
    raise exception 'break_glass_enabled is not as 0039 seeded it';
  end if;
  if has_table_privilege('hid_identity_api_runtime', 'platform.control_settings', 'SELECT')
     or not has_function_privilege('hid_identity_api_runtime', 'platform.require_control_enabled(text)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime', 'identity.activate_break_glass(text,text,integer)', 'EXECUTE') then
    raise exception 'The Identity runtime privileges on the control or break-glass differ from the governed boundary';
  end if;
  if not (select prosecdef from pg_proc where oid = 'platform.require_control_enabled(text)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure) then
    raise exception 'The control functions are no longer SECURITY DEFINER';
  end if;
end
$$;

-- Fixtures: a doctor (facility role, no platform role), a platform super
-- administrator for the control, and two patients.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('bb100000-0000-4000-8000-000000000001', 'staff:bg-launch-doctor', 'bg-launch-doctor@example.invalid', 'Launch Doctor', 'active'),
  ('bb100000-0000-4000-8000-000000000002', 'synthetic:bg-launch:patient-1', 'bg-launch-patient-1@example.invalid', 'Launch Patient One', 'active'),
  ('bb100000-0000-4000-8000-000000000003', 'synthetic:bg-launch:patient-2', 'bg-launch-patient-2@example.invalid', 'Launch Patient Two', 'active'),
  ('bb100000-0000-4000-8000-000000000004', 'synthetic:bg-launch:super', 'bg-launch-super@example.invalid', 'Launch Super Admin', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('bb200000-0000-4000-8000-000000000001', 'bb100000-0000-4000-8000-000000000002', 'HID-BGLNCHA', 'Ada', 'Launch', 'Ada Launch', 'active'),
  ('bb200000-0000-4000-8000-000000000002', 'bb100000-0000-4000-8000-000000000003', 'HID-BGLNCHB', 'Bola', 'Launch', 'Bola Launch', 'active');
insert into identity.organizations (id, name, slug) values
  ('bb300000-0000-4000-8000-000000000001', 'Break-glass Launch Organization', 'break-glass-launch-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('bb300000-0000-4000-8000-000000000002', 'bb300000-0000-4000-8000-000000000001', 'Break-glass Launch Hospital',
   'BGL-A', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('bb400000-0000-4000-8000-000000000001', 'bb100000-0000-4000-8000-000000000001', 'Launch Doctor',
   'bg-launch-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('bb500000-0000-4000-8000-000000000001', 'bb400000-0000-4000-8000-000000000001',
   'bb100000-0000-4000-8000-000000000001', 'bb300000-0000-4000-8000-000000000001',
   'bb300000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('bb600000-0000-4000-8000-000000000001', 'bb100000-0000-4000-8000-000000000001', 'doctor', 'facility',
   'bb500000-0000-4000-8000-000000000001', 'bb300000-0000-4000-8000-000000000002', 'Break-glass launch doctor');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('bb600000-0000-4000-8000-000000000002', 'bb100000-0000-4000-8000-000000000004', 'platform_super_admin', 'platform',
   'Break-glass launch control operator');
-- Patient one's contacts: verified with alerts on (the one recipient),
-- verified with alerts off, and unverified.
insert into identity.patient_emergency_contacts (id, patient_id, created_by_account_id, relationship, channel,
  contact_ciphertext, contact_key_version, destination_hmac, notify_on_emergency_access, status, verified_at) values
  ('bb700000-0000-4000-8000-000000000001', 'bb200000-0000-4000-8000-000000000001', 'bb100000-0000-4000-8000-000000000002',
   'sibling', 'email', '\x01'::bytea || decode(repeat('ab', 40), 'hex'), 'local-v1',
   encode(sha256('bg-launch-contact-1'::bytea), 'hex'), true, 'verified', clock_timestamp()),
  ('bb700000-0000-4000-8000-000000000002', 'bb200000-0000-4000-8000-000000000001', 'bb100000-0000-4000-8000-000000000002',
   'parent', 'sms', '\x01'::bytea || decode(repeat('cd', 40), 'hex'), 'local-v1',
   encode(sha256('bg-launch-contact-2'::bytea), 'hex'), false, 'verified', clock_timestamp()),
  ('bb700000-0000-4000-8000-000000000003', 'bb200000-0000-4000-8000-000000000001', 'bb100000-0000-4000-8000-000000000002',
   'friend', 'email', '\x01'::bytea || decode(repeat('ef', 40), 'hex'), 'local-v1',
   encode(sha256('bg-launch-contact-3'::bytea), 'hex'), true, 'unverified', null);

do $$
begin
  if auth.account_has_platform_permission('bb100000-0000-4000-8000-000000000001', 'platform.control.read')
     or not auth.account_has_platform_permission('bb100000-0000-4000-8000-000000000004', 'platform.control.read')
     or not auth.account_has_platform_permission('bb100000-0000-4000-8000-000000000004', 'platform.control.manage')
     or not auth.membership_has_permission('staff:bg-launch-doctor', 'bb500000-0000-4000-8000-000000000001',
       'bb300000-0000-4000-8000-000000000002', 'identity.break-glass.write') then
    raise exception 'Fixture: the doctor must hold break-glass without platform.control.read, the operator both control permissions';
  end if;
end
$$;

-- Whether the control functions' owner bypasses row-level security decides
-- what a staff context sees (header).
select set_config('hid.test.control_owner_bypasses_rls',
  (select (r.rolsuper or r.rolbypassrls)::text from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'platform.control_enabled(text)'::regprocedure), true);

-- 2. and 3. The doctor's activation, as Identity runs it: the five context
-- settings, the control check, then the command, in one transaction.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:bg-launch-doctor', true),
  set_config('app.facility_id', 'bb300000-0000-4000-8000-000000000002', true),
  set_config('app.correlation_id', 'break-glass-launch-0001', true),
  set_config('app.membership_id', 'bb500000-0000-4000-8000-000000000001', true),
  set_config('app.purpose_of_use', 'emergency', true);
do $$
declare
  bypasses boolean := current_setting('hid.test.control_owner_bypasses_rls')::boolean;
  state text;
  message text;
begin
  -- The runtime cannot read the control row itself.
  begin
    perform 1 from platform.control_settings;
    raise exception 'The Identity runtime read platform.control_settings directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform platform.require_control_enabled('break_glass_enabled');
    state := 'enabled';
  exception when sqlstate '55000' then
    get stacked diagnostics message = message_text;
    state := message;
  end;
  if bypasses and state <> 'enabled' then
    raise exception 'A staff context without platform.control.read failed the enabled control check: %', state;
  end if;
  if not bypasses and state <> 'PLATFORM_CONTROL_UNAVAILABLE' then
    raise exception 'Under an owner that does not bypass RLS a staff context must get PLATFORM_CONTROL_UNAVAILABLE, got %', state;
  end if;
  -- Identity's guard reads the portal control the same way on every staff
  -- request, so the activation check fails only where every staff request
  -- already does.
  begin
    perform platform.control_enabled('provider_portal_enabled');
    message := 'readable';
  exception when sqlstate '55000' then
    get stacked diagnostics message = message_text;
  end;
  if message is distinct from (case when bypasses then 'readable' else 'PLATFORM_CONTROL_UNAVAILABLE' end) then
    raise exception 'The guard''s portal control read differs from the break-glass control read: %', message;
  end if;
end
$$;
select set_config('hid.test.grant',
  (select consent_grant_id::text from identity.activate_break_glass('HID-BGLNCHA', 'Unconscious patient in the emergency room', 30)),
  true);
reset role;

do $$
declare
  grant_id uuid := current_setting('hid.test.grant')::uuid;
  grant_row identity.consent_grants%rowtype;
  request_row identity.access_requests%rowtype;
begin
  select * into grant_row from identity.consent_grants where id = grant_id;
  if not found or not grant_row.break_glass or grant_row.scope <> 'break_glass' or grant_row.purpose_of_use <> 'emergency'
     or grant_row.status <> 'active' or grant_row.patient_id <> 'bb200000-0000-4000-8000-000000000001'
     or grant_row.facility_id <> 'bb300000-0000-4000-8000-000000000002'
     or grant_row.membership_id <> 'bb500000-0000-4000-8000-000000000001'
     or grant_row.account_id <> 'bb100000-0000-4000-8000-000000000001'
     or grant_row.expires_at > clock_timestamp() + interval '30 minutes' then
    raise exception 'The break-glass grant is not the bounded emergency grant: %', row_to_json(grant_row);
  end if;
  select * into request_row from identity.access_requests where id = grant_row.request_id;
  if not found or request_row.status <> 'approved' or not request_row.break_glass
     or request_row.purpose_of_use <> 'emergency' or request_row.scope <> 'break_glass' then
    raise exception 'The break-glass access request is missing or not approved: %', row_to_json(request_row);
  end if;
  if (select count(*) from audit.events where action = 'identity.break-glass.activate' and outcome = 'success'
       and resource_id = grant_id::text and purpose_of_use = 'emergency'
       and correlation_id = 'break-glass-launch-0001') <> 1 then
    raise exception 'The break-glass activation was not audited once';
  end if;
  if (select count(*) from identity.outbox_events where event_type = 'EmergencyAccessActivated'
       and aggregate_id = grant_id and patient_id = 'bb200000-0000-4000-8000-000000000001'
       and facility_id = 'bb300000-0000-4000-8000-000000000002'
       and payload = jsonb_build_object('consentGrantId', grant_id, 'reviewRequired', true)) <> 1 then
    raise exception 'The EmergencyAccessActivated outbox row was not written once';
  end if;
  -- 3. Exactly one intent, for the verified contact with alerts on.
  if (select array_agg(contact_id::text || ':' || channel || ':' || status)
        from identity.emergency_contact_notifications where consent_grant_id = grant_id)
     is distinct from array['bb700000-0000-4000-8000-000000000001:email:pending'] then
    raise exception 'The trigger did not create exactly one intent for the one eligible contact: %',
      (select array_agg(contact_id) from identity.emergency_contact_notifications where consent_grant_id = grant_id);
  end if;
  if (select count(*) from audit.events
       where action = 'identity.emergency-contact.notification.intent-created'
         and details ->> 'consentGrantId' = grant_id::text) <> 1 then
    raise exception 'The intent was not audited once';
  end if;
  -- The grant authorizes the emergency read (0012) while 'emergency' is active
  -- (at the current time: the grant starts after this transaction did).
  if not identity.has_active_consent_grant('bb200000-0000-4000-8000-000000000001', 'staff:bg-launch-doctor',
       'bb500000-0000-4000-8000-000000000001', 'bb300000-0000-4000-8000-000000000002', 'read_records', 'emergency',
       clock_timestamp()) then
    raise exception 'The break-glass grant does not authorize the emergency read';
  end if;
end
$$;

-- 4. The operator turns the control off with the audited admin command.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:bg-launch:super', true),
  set_config('app.correlation_id', 'break-glass-launch-0002', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
do $$
declare
  current_version bigint;
  result record;
  message text;
begin
  select c.row_version into current_version from platform.admin_list_controls() c where c.control_key = 'break_glass_enabled';
  select * into result from platform.admin_set_control('break_glass_enabled', false, current_version,
    'Break-glass launch suite turns emergency access off');
  if result.enabled or result.replayed then
    raise exception 'The control was not turned off: %', row_to_json(result);
  end if;
  -- An actor holding platform.control.read sees the row under either owner.
  begin
    perform platform.require_control_enabled('break_glass_enabled');
    raise exception 'require_control_enabled passed with break_glass_enabled off';
  exception when sqlstate '55000' then
    get stacked diagnostics message = message_text;
    if message <> 'PLATFORM_CONTROL_DISABLED:break_glass_enabled' then raise; end if;
  end;
end
$$;
-- The doctor's activation, as Identity runs it, with the control off.
select set_config('app.actor_subject', 'staff:bg-launch-doctor', true),
  set_config('app.facility_id', 'bb300000-0000-4000-8000-000000000002', true),
  set_config('app.correlation_id', 'break-glass-launch-0003', true),
  set_config('app.membership_id', 'bb500000-0000-4000-8000-000000000001', true),
  set_config('app.purpose_of_use', 'emergency', true);
do $$
declare
  bypasses boolean := current_setting('hid.test.control_owner_bypasses_rls')::boolean;
  state text;
  message text;
begin
  begin
    perform platform.require_control_enabled('break_glass_enabled');
    perform identity.activate_break_glass('HID-BGLNCHB', 'Unconscious patient in the emergency room', 30);
    state := 'activated';
  exception when sqlstate '55000' then
    get stacked diagnostics message = message_text;
    state := message;
  end;
  if state is distinct from (case when bypasses then 'PLATFORM_CONTROL_DISABLED:break_glass_enabled'
                                 else 'PLATFORM_CONTROL_UNAVAILABLE' end) then
    raise exception 'With the control off the staff check answered %', state;
  end if;
end
$$;
reset role;
do $$
begin
  if exists (select 1 from identity.consent_grants where patient_id = 'bb200000-0000-4000-8000-000000000002')
     or exists (select 1 from identity.access_requests where patient_id = 'bb200000-0000-4000-8000-000000000002')
     or exists (select 1 from audit.events where correlation_id = 'break-glass-launch-0003')
     or exists (select 1 from identity.outbox_events where correlation_id = 'break-glass-launch-0003') then
    raise exception 'A refused activation wrote a grant, request, audit row or outbox row';
  end if;
  if (select count(*) from platform.control_events where control_key = 'break_glass_enabled'
       and not enabled and correlation_id = 'break-glass-launch-0002') <> 1 then
    raise exception 'Turning the control off was not recorded as one control event';
  end if;
end
$$;
-- The control on again, so that only the purpose refuses below.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:bg-launch:super', true),
  set_config('app.correlation_id', 'break-glass-launch-0004', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('break_glass_enabled', true,
  (select c.row_version from platform.admin_list_controls() c where c.control_key = 'break_glass_enabled'),
  'Break-glass launch suite turns emergency access on again');
select platform.require_control_enabled('break_glass_enabled');
reset role;

-- 5. An operator deactivates 'emergency' (and relabels it, to show that 0085
-- keeps the row exactly as it is).
update identity.purpose_of_use_codes set active = false, display = 'Emergency treatment (operator hold)'
 where code = 'emergency';
create temporary table bg_launch_operator_row on commit drop as
  select * from identity.purpose_of_use_codes where code = 'emergency';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:bg-launch-doctor', true),
  set_config('app.facility_id', 'bb300000-0000-4000-8000-000000000002', true),
  set_config('app.correlation_id', 'break-glass-launch-0005', true),
  set_config('app.membership_id', 'bb500000-0000-4000-8000-000000000001', true),
  set_config('app.purpose_of_use', 'emergency', true);
do $$
declare message text;
begin
  begin
    perform identity.activate_break_glass('HID-BGLNCHB', 'Unconscious patient in the emergency room', 30);
    raise exception 'Break-glass activated with the emergency purpose deactivated';
  exception when sqlstate '22023' then
    get stacked diagnostics message = message_text;
    if message <> 'Break-glass requires the emergency purpose of use' then raise; end if;
  end;
end
$$;
reset role;
do $$
begin
  if identity.has_active_consent_grant('bb200000-0000-4000-8000-000000000001', 'staff:bg-launch-doctor',
       'bb500000-0000-4000-8000-000000000001', 'bb300000-0000-4000-8000-000000000002', 'read_records', 'emergency',
       clock_timestamp()) then
    raise exception 'A break-glass grant authorized the emergency read while the purpose is deactivated';
  end if;
end
$$;

-- 0085 again, as the migration runner would run the file.
\ir ../../database/migrations/0085_emergency_purpose_of_use.sql
do $$
begin
  if (select count(*) from identity.purpose_of_use_codes where code = 'emergency') <> 1
     or exists (select 1 from identity.purpose_of_use_codes current_row
                  join bg_launch_operator_row kept on kept.code = current_row.code
                 where row(current_row.*) is distinct from row(kept.*))
     or exists (select 1 from identity.purpose_of_use_codes where code = 'emergency' and active) then
    raise exception 'Running 0085 again changed or reactivated the operator''s emergency row: %',
      (select row_to_json(purpose) from identity.purpose_of_use_codes purpose where code = 'emergency');
  end if;
end
$$;
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'break-glass-launch-0006', true);
do $$
begin
  begin
    perform identity.activate_break_glass('HID-BGLNCHB', 'Unconscious patient in the emergency room', 30);
    raise exception 'Break-glass activated after 0085 ran again over a deactivated emergency purpose';
  exception when sqlstate '22023' then null;
  end;
end
$$;
reset role;
do $$
begin
  if exists (select 1 from identity.consent_grants where patient_id = 'bb200000-0000-4000-8000-000000000002') then
    raise exception 'A refused activation wrote a grant';
  end if;
end
$$;

rollback;
