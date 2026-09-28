\set ON_ERROR_STOP on
-- Synthetic rollback-only coverage for the Supabase-compatible patient access
-- PIN command. The fixture hash is generated with pgcrypto bcrypt, matching
-- the legacy `crypt(..., gen_salt('bf'))` envelope without using a real PIN.
begin;
set constraints all deferred;

insert into auth.accounts (id, subject, email, display_name, status) values
  ('b2000000-0000-4000-8000-000000000001', 'staff:pin-integration',
   'pin-clinician@example.invalid', 'PIN Integration Clinician', 'active'),
  ('b2000000-0000-4000-8000-000000000002', 'patient:pin-integration',
   'pin-patient@example.invalid', 'PIN Integration Patient', 'active'),
  ('b2000000-0000-4000-8000-000000000003', 'patient:pin-audit-failure',
   'pin-audit-patient@example.invalid', 'PIN Audit Failure Patient', 'active');

insert into identity.organizations (id, name, slug) values
  ('e1000000-0000-4000-8000-000000000001', 'PIN Integration Organization', 'pin-integration-org');
insert into identity.facilities (
  id, organization_id, name, code, timezone, active, lifecycle_status
) values (
  'b1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001',
  'PIN Integration Facility', 'PIN-INT', 'Africa/Lagos', true, 'verified'
);
insert into identity.staff (
  id, account_id, full_name, email, verification_status, default_role
) values (
  'b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
  'PIN Integration Clinician', 'pin-clinician@example.invalid', 'verified', 'doctor'
);
insert into identity.staff_facility_memberships (
  id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active
) values (
  'b4000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true
);
insert into auth.account_roles (
  id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason
) values (
  'b6000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
  'doctor', 'facility', 'b4000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002', 'PIN integration fixture role'
);
insert into identity.patients (
  id, account_id, hid_code, first_name, last_name, full_name, status
) values
  ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002',
   'HID-PNACCE55', 'PIN', 'Patient', 'PIN Integration Patient', 'active'),
  ('b5000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000003',
   'HID-PNABCD66', 'PIN', 'Audit', 'PIN Audit Failure Patient', 'active');
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'patient-access-pin-test')
on conflict (code) do nothing;

insert into identity.patient_access_pins (
  patient_id, pin_hash, source_system, source_record_id, source_created_at, source_updated_at
) values
  -- pgcrypto's historic default is cost 06. Use its `$2b$` spelling here so
  -- the command proves both source-default work padding and non-`$2a$`
  -- envelope compatibility without modifying the imported verifier.
  ('b5000000-0000-4000-8000-000000000001', '$2b$' || substring(crypt('2468', gen_salt('bf')) from 5),
   'supabase', 'legacy-pin-1', clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day'),
  ('b5000000-0000-4000-8000-000000000002', crypt('1357', gen_salt('bf', 12)),
   'supabase', 'legacy-pin-2', clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day');

-- The command must fail closed if its semantic audit event cannot be written;
-- no grant, attempt evidence, or notification intent may survive the error.
create function pg_temp.reject_pin_audit() returns trigger language plpgsql as $$
begin
  if new.action = 'identity.patient-access-pin.verify'
     and new.patient_id = 'b5000000-0000-4000-8000-000000000002'::uuid then
    raise exception using errcode = 'P0996', message = 'Synthetic PIN audit outage';
  end if;
  return new;
end
$$;
create trigger patient_access_pin_audit_failure before insert on audit.events
for each row execute function pg_temp.reject_pin_audit();

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:pin-integration', true);
select set_config('app.membership_id', 'b4000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', 'b1000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'pin-integration-audit-failure', true);
select set_config('app.purpose_of_use', 'direct-care', true);
do $$
begin
  if has_table_privilege(current_user, 'identity.patient_access_pins', 'SELECT')
     or has_table_privilege(current_user, 'identity.patient_access_pins', 'INSERT')
     or has_table_privilege(current_user, 'identity.patient_access_pin_actor_limits', 'SELECT') then
    raise exception 'Identity runtime received direct PIN secret or rate-limit access';
  end if;
  begin
    perform identity.access_patient_with_pin('HID-PNABCD66', '1357', 15);
    raise exception 'PIN grant survived a primary audit outage';
  exception when sqlstate 'P0996' then null;
  end;
end
$$;
reset role;
do $$
begin
  if exists (select 1 from identity.consent_grants
      where patient_id = 'b5000000-0000-4000-8000-000000000002')
     or exists (select 1 from identity.patient_access_pin_attempts
      where patient_id = 'b5000000-0000-4000-8000-000000000002')
     or exists (select 1 from identity.outbox_events
      where event_type = 'PatientAccessPinVerified'
        and patient_id = 'b5000000-0000-4000-8000-000000000002') then
    raise exception 'PIN audit failure leaked durable access state';
  end if;
end
$$;
drop trigger patient_access_pin_audit_failure on audit.events;
-- The second synthetic patient carried a PIN solely to prove that a primary
-- audit failure rolls back every access side effect. Remove that fixture-only
-- secret before exercising the distinct no-enabled-PIN denial path below.
delete from identity.patient_access_pins
 where patient_id = 'b5000000-0000-4000-8000-000000000002';

set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'pin-integration-valid-0001', true);
do $$
declare granted record;
begin
  select * into granted from identity.access_patient_with_pin('HID-PNACCE55', '24 68', 15);
  if not granted.verified or granted.existing_grant or granted.grant_status <> 'active'
     or granted.subject_patient_id <> 'b5000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'Valid legacy bcrypt PIN did not produce the expected read grant';
  end if;
  if not identity.has_active_consent_grant(
      granted.subject_patient_id, 'staff:pin-integration',
      'b4000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000002', 'read_records', 'direct-care'
    ) then
    raise exception 'PIN grant did not authorize its exact read context';
  end if;
  if identity.has_active_consent_grant(
      granted.subject_patient_id, 'staff:pin-integration',
      'b4000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000002', 'write_records', 'direct-care'
    ) or identity.has_active_consent_grant(
      granted.subject_patient_id, 'staff:pin-integration',
      'b4000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000099', 'read_records', 'direct-care'
    ) then
    raise exception 'PIN grant escaped write or exact-facility scope';
  end if;
end
$$;
reset role;
do $$
begin
  if not exists (
    select 1 from identity.patient_access_pins
     where patient_id = 'b5000000-0000-4000-8000-000000000001'::uuid
       and pin_hash like '$2b$06$%'
  ) then
    raise exception 'PIN verification rewrote the imported $2b$ hash envelope';
  end if;
end
$$;

-- A `$2y$` source envelope has the same ASCII-PIN bcrypt behavior as `$2b$`.
-- Store it unchanged and verify through the same public command; the replay
-- must retain the existing short-lived grant rather than create a new one.
update identity.patient_access_pins
   set pin_hash = '$2y$' || substring(pin_hash from 5), updated_at = clock_timestamp()
 where patient_id = 'b5000000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$
declare replay record;
begin
  select * into replay from identity.access_patient_with_pin('HID-PNACCE55', '2468', 60);
  if not replay.verified or not replay.existing_grant or replay.grant_status <> 'active' then
    raise exception 'Legacy `$2y$` PIN replay did not retain the existing grant';
  end if;
end
$$;
reset role;
do $$
begin
  if not exists (
    select 1 from identity.patient_access_pins
     where patient_id = 'b5000000-0000-4000-8000-000000000001'::uuid
       and pin_hash like '$2y$06$%'
  ) then
    raise exception 'PIN verification rewrote the imported $2y$ hash envelope';
  end if;
end
$$;

-- Wrong PINs, unknown/no-PIN patients, disabled PINs, and revoked PINs must
-- all use the same false result and materialize neither new grant nor access.
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'pin-integration-denied-0001', true);
do $$
declare result record;
begin
  select * into result from identity.access_patient_with_pin('HID-PNACCE55', '9999', 15);
  if result.verified then raise exception 'Wrong PIN was accepted'; end if;
  select * into result from identity.access_patient_with_pin('HID-PNABCD66', '1357', 15);
  if result.verified then raise exception 'Patient without an enabled PIN was accepted'; end if;
end
$$;
reset role;

update identity.patient_access_pins
   set status = 'disabled', disabled_at = clock_timestamp(), disabled_reason = 'Synthetic disabled PIN test', updated_at = clock_timestamp()
 where patient_id = 'b5000000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$ declare result record; begin
  select * into result from identity.access_patient_with_pin('HID-PNACCE55', '2468', 15);
  if result.verified then raise exception 'Disabled PIN was accepted'; end if;
end $$;
reset role;
update identity.patient_access_pins
   set status = 'active', disabled_at = null, disabled_reason = null, updated_at = clock_timestamp()
 where patient_id = 'b5000000-0000-4000-8000-000000000001';

update identity.patient_access_pins
   set status = 'revoked', disabled_at = clock_timestamp(), disabled_reason = 'Synthetic revoked PIN test', updated_at = clock_timestamp()
 where patient_id = 'b5000000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$ declare result record; begin
  select * into result from identity.access_patient_with_pin('HID-PNACCE55', '2468', 15);
  if result.verified then raise exception 'Revoked PIN was accepted'; end if;
end $$;
reset role;
update identity.patient_access_pins
   set status = 'active', disabled_at = null, disabled_reason = null, updated_at = clock_timestamp()
 where patient_id = 'b5000000-0000-4000-8000-000000000001';

-- A current deny directive wins even after the PIN hash verifies.
savepoint before_pin_directive;
insert into identity.consent_directives (id, patient_id, current_version) values
  ('b9000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 1);
insert into identity.consent_directive_versions (
  id, directive_id, patient_id, version_no, status, provision_type, grantee_type,
  actions, purposes, starts_at, source_reference, reason, content_sha256
) values (
  'b9000000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-000000000001',
  'b5000000-0000-4000-8000-000000000001', 1, 'active', 'deny', 'all',
  array['read_records'], array['direct-care'], clock_timestamp() - interval '1 minute',
  'patient-access-pin-test', 'Synthetic PIN directive denial', repeat('d', 64)
);
set local role hid_identity_api_runtime;
do $$ declare result record; begin
  select * into result from identity.access_patient_with_pin('HID-PNACCE55', '2468', 15);
  if result.verified then raise exception 'PIN bypassed active patient deny directive'; end if;
end $$;
reset role;
rollback to savepoint before_pin_directive;

-- Reset earlier denial state, then prove that five failures lock the actor and
-- that a correct PIN cannot bypass the active lock.
delete from identity.patient_access_pin_target_limits;
delete from identity.patient_access_pin_actor_limits;
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'pin-integration-rate-limit', true);
do $$
declare result record; attempt integer;
begin
  for attempt in 1..5 loop
    select * into result from identity.access_patient_with_pin('HID-PNACCE55', '9999', 15);
    if result.verified then raise exception 'Invalid PIN unexpectedly verified during rate-limit test'; end if;
  end loop;
  select * into result from identity.access_patient_with_pin('HID-PNACCE55', '2468', 15);
  if result.verified then raise exception 'Rate-limited actor bypassed the lock with a correct PIN'; end if;
end
$$;
reset role;

do $$
begin
  if not exists (
      select 1 from identity.patient_access_pin_actor_limits
       where actor_account_id = 'b2000000-0000-4000-8000-000000000001'
         and facility_id = 'b1000000-0000-4000-8000-000000000002'
         and failure_count = 5 and locked_until > clock_timestamp()
    ) then
    raise exception 'PIN actor rate limit did not lock after five failures';
  end if;
  -- The actor-level lock is evaluated before HID lookup, so it intentionally
  -- records no patient identifier and cannot become a patient-existence oracle.
  if (select count(*) from identity.patient_access_pin_attempts
       where actor_account_id = 'b2000000-0000-4000-8000-000000000001'
         and facility_id = 'b1000000-0000-4000-8000-000000000002'
         and patient_id is null and outcome = 'locked') <> 1 then
    raise exception 'PIN actor-lock evidence is missing or leaked a patient identifier';
  end if;
  if not exists (
      select 1 from identity.consent_grants
       where patient_id = 'b5000000-0000-4000-8000-000000000001'
         and authorization_method = 'patient_access_pin'
         and scope = 'read_records' and purpose_of_use = 'direct-care'
         and status = 'active'
    ) then
    raise exception 'Valid PIN grant was not recorded with narrow authorization metadata';
  end if;
  if (select count(*) from identity.outbox_events where event_type = 'PatientAccessPinVerified') <> 1
     or exists (
       select 1 from identity.outbox_events
        where event_type = 'PatientAccessPinVerified'
          and (registration_case_id is not null
            or patient_access_pin_grant_id <> aggregate_id
            or payload <> jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true))
     ) then
    raise exception 'PIN notification intent is missing or exceeds the minimum-necessary envelope';
  end if;
  if (select count(*) from audit.events where action = 'identity.patient-access-pin.verify'
       and outcome = 'success') <> 1
     or (select count(*) from audit.events where action = 'identity.patient-access-pin.replay'
       and outcome = 'success') <> 1
     or not exists (select 1 from audit.events
       where action = 'identity.patient-access-pin.verify-denied' and outcome = 'denied') then
    raise exception 'PIN success, replay, or denial audit evidence is missing';
  end if;
end
$$;

rollback;
