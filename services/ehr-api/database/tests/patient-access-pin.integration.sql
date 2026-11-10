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
  -- 0121: at most 1440 minutes (24 hours); 1441 is refused before any check.
  begin
    perform identity.access_patient_with_pin('HID-PNACCE55', '2468', 1441);
    raise exception 'A PIN grant longer than 24 hours was accepted';
  exception when sqlstate '22023' then null;
  end;
  select * into granted from identity.access_patient_with_pin('HID-PNACCE55', '24 68', 1440);
  if not granted.verified or granted.existing_grant or granted.grant_status <> 'active'
     or granted.subject_patient_id <> 'b5000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'Valid legacy bcrypt PIN did not produce the expected grant';
  end if;
  perform set_config('pin_test.grant', granted.consent_grant_id::text, true);
  if not identity.has_active_consent_grant(
      granted.subject_patient_id, 'staff:pin-integration',
      'b4000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000002', 'read_records', 'direct-care'
    ) then
    raise exception 'PIN grant did not authorize its exact read context';
  end if;
  -- 0121: the PIN grant also lets the staff member add to the record.
  if not identity.has_active_consent_grant(
      granted.subject_patient_id, 'staff:pin-integration',
      'b4000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000002', 'write_records', 'direct-care'
    ) then
    raise exception 'PIN grant did not authorize its exact write context';
  end if;
  if identity.has_active_consent_grant(
      granted.subject_patient_id, 'staff:pin-integration',
      'b4000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000099', 'read_records', 'direct-care'
    ) or identity.has_active_consent_grant(
      granted.subject_patient_id, 'staff:pin-integration',
      'b4000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000099', 'write_records', 'direct-care'
    ) then
    raise exception 'PIN grant escaped exact-facility scope';
  end if;
end
$$;
reset role;
-- 0121: the grant and its request are write_records, direct care, by PIN, and
-- last exactly the 1440 minutes asked (24 hours).
do $$
begin
  if not exists (
      select 1 from identity.consent_grants grant_row
        join identity.access_requests request_row on request_row.id = grant_row.request_id
       where grant_row.id = current_setting('pin_test.grant')::uuid
         and grant_row.scope = 'write_records' and request_row.scope = 'write_records'
         and grant_row.purpose_of_use = 'direct-care' and request_row.purpose_of_use = 'direct-care'
         and grant_row.authorization_method = 'patient_access_pin'
         and request_row.authorization_method = 'patient_access_pin'
         and not grant_row.break_glass and not request_row.break_glass
         and request_row.requested_duration_minutes = 1440
         and grant_row.expires_at - grant_row.starts_at = interval '24 hours'
         and grant_row.status = 'active' and request_row.status = 'approved') then
    raise exception 'The PIN grant is not a 24-hour write_records grant';
  end if;
  if (select details from audit.events where action = 'identity.patient-access-pin.verify'
        and resource_id = current_setting('pin_test.grant')) ->> 'scope' is distinct from 'write_records'
     or (select details from audit.events where action = 'identity.patient-access-pin.verify'
        and resource_id = current_setting('pin_test.grant')) ->> 'duration_minutes' is distinct from '1440' then
    raise exception 'The PIN audit row does not carry its scope and duration';
  end if;
  if (select payload from identity.outbox_events where event_type = 'PatientAccessPinVerified'
        and aggregate_id = current_setting('pin_test.grant')::uuid)
     is distinct from jsonb_build_object('consentGrantId', current_setting('pin_test.grant')::uuid,
       'reviewRequired', true, 'scope', 'write_records') then
    raise exception 'The PIN notice does not carry its scope';
  end if;
end
$$;
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
-- must return the existing 24-hour write grant rather than create a new one.
update identity.patient_access_pins
   set pin_hash = '$2y$' || substring(pin_hash from 5), updated_at = clock_timestamp()
 where patient_id = 'b5000000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$
declare replay record;
begin
  select * into replay from identity.access_patient_with_pin('HID-PNACCE55', '2468', 60);
  if not replay.verified or not replay.existing_grant or replay.grant_status <> 'active'
     or replay.consent_grant_id <> current_setting('pin_test.grant')::uuid then
    raise exception 'Legacy `$2y$` PIN replay did not retain the existing grant';
  end if;
end
$$;
reset role;
-- 0121: the replay returns the same write grant, keeps its 24 hours and
-- audits its scope.
do $$
begin
  if (select count(*) from identity.consent_grants
       where patient_id = 'b5000000-0000-4000-8000-000000000001'
         and authorization_method = 'patient_access_pin') <> 1
     or (select details ->> 'scope' from audit.events where action = 'identity.patient-access-pin.replay') <> 'write_records'
     or (select expires_at - starts_at from identity.consent_grants
          where id = current_setting('pin_test.grant')::uuid) <> interval '24 hours' then
    raise exception 'The PIN replay did not return the existing write grant';
  end if;
end
$$;
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

-- 0121: a deny of writing only, and a deny of every action, stop the PIN too
-- (the grant is write_records). A deny for another purpose does not.
create function pg_temp.pin_directive(directive_no integer, denied_actions text[], denied_purposes text[])
returns void language sql as $f$
  insert into identity.consent_directives (id, patient_id, current_version) values
    (format('b9000000-0000-4000-8000-0000000001%s', lpad(directive_no::text, 2, '0'))::uuid,
     'b5000000-0000-4000-8000-000000000001', 1);
  insert into identity.consent_directive_versions (
    id, directive_id, patient_id, version_no, status, provision_type, grantee_type,
    actions, purposes, starts_at, source_reference, reason, content_sha256
  ) values (
    format('b9000000-0000-4000-8000-0000000002%s', lpad(directive_no::text, 2, '0'))::uuid,
    format('b9000000-0000-4000-8000-0000000001%s', lpad(directive_no::text, 2, '0'))::uuid,
    'b5000000-0000-4000-8000-000000000001', 1, 'active', 'deny', 'all',
    denied_actions, denied_purposes, clock_timestamp() - interval '1 minute',
    'patient-access-pin-test', 'Synthetic PIN directive', repeat('e', 64)
  );
$f$;
savepoint before_pin_write_directive;
select pg_temp.pin_directive(1, array['write_records'], array['direct-care']);
set local role hid_identity_api_runtime;
do $$ declare result record; begin
  select * into result from identity.access_patient_with_pin('HID-PNACCE55', '2468', 1440);
  if result.verified then raise exception 'PIN bypassed an active deny of writing'; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from audit.events
       where action = 'identity.patient-access-pin.authorization-denied'
         and patient_id = 'b5000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'The deny of writing left no authorization-denied audit row';
  end if;
end $$;
rollback to savepoint before_pin_write_directive;
select pg_temp.pin_directive(2, '{}', array['direct-care']);
set local role hid_identity_api_runtime;
do $$ declare result record; begin
  select * into result from identity.access_patient_with_pin('HID-PNACCE55', '2468', 1440);
  if result.verified then raise exception 'PIN bypassed an active deny of every action'; end if;
end $$;
reset role;
rollback to savepoint before_pin_write_directive;
select pg_temp.pin_directive(3, array['write_records'], array['healthcare-operations']);
set local role hid_identity_api_runtime;
do $$ declare result record; begin
  select * into result from identity.access_patient_with_pin('HID-PNACCE55', '2468', 1440);
  if not result.verified or not result.existing_grant then
    raise exception 'A deny for another purpose stopped the PIN';
  end if;
end $$;
reset role;
rollback to savepoint before_pin_write_directive;

-- 0121: a 60-minute read_records PIN grant made before 0121 is not reused;
-- the next correct PIN makes a new write_records grant and the old one runs
-- out by itself.
savepoint before_pin_old_read_grant;
insert into identity.patient_access_pins (
  patient_id, pin_hash, source_system, source_record_id, source_created_at, source_updated_at
) values ('b5000000-0000-4000-8000-000000000002', crypt('1357', gen_salt('bf', 12)),
   'supabase', 'legacy-pin-old-read', clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day');
insert into identity.access_requests (
  id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
  reason, status, requested_duration_minutes, break_glass, approved_at,
  correlation_id, authorization_method
) values (
  'b7000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002',
  'b3000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002', 'read_records', 'direct-care', 'Patient access PIN verification',
  'approved', 60, false, current_timestamp, 'pin-integration-old-read', 'patient_access_pin'
);
insert into identity.consent_grants (
  id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass,
  correlation_id, authorization_method
) values (
  'b8000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001',
  'b5000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002', 'read_records', 'direct-care', 'active',
  'Patient access PIN verification', current_timestamp, current_timestamp + interval '60 minutes', false,
  'pin-integration-old-read', 'patient_access_pin'
);
delete from identity.patient_access_pin_target_limits;
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'pin-integration-old-read-0001', true);
do $$ declare result record; begin
  select * into result from identity.access_patient_with_pin('HID-PNABCD66', '1357', 1440);
  if not result.verified or result.existing_grant
     or result.consent_grant_id = 'b8000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'An old read_records PIN grant was reused';
  end if;
  perform set_config('pin_test.new_grant', result.consent_grant_id::text, true);
end $$;
reset role;
do $$ begin
  if (select scope from identity.consent_grants where id = current_setting('pin_test.new_grant')::uuid)
       <> 'write_records'
     or (select status from identity.consent_grants where id = 'b8000000-0000-4000-8000-000000000001') <> 'active' then
    raise exception 'The new PIN grant is not write_records, or the old read grant was touched';
  end if;
end $$;
rollback to savepoint before_pin_old_read_grant;

-- 0121: the constraints admit a PIN row of read_records or write_records only,
-- still direct care and never break-glass; the PIN notice's payload is the two
-- keys, or the two keys and a read_records or write_records scope.
do $$
declare
  failed text;
  broken text;
begin
  for broken in select unnest(array[
    $q$update identity.consent_grants set scope = 'break_glass', break_glass = true
        where id = current_setting('pin_test.grant')::uuid$q$,
    $q$update identity.consent_grants set purpose_of_use = 'healthcare-operations'
        where id = current_setting('pin_test.grant')::uuid$q$,
    $q$update identity.access_requests set scope = 'break_glass', break_glass = true
        where id = (select request_id from identity.consent_grants where id = current_setting('pin_test.grant')::uuid)$q$,
    $q$update identity.access_requests set purpose_of_use = 'healthcare-operations'
        where id = (select request_id from identity.consent_grants where id = current_setting('pin_test.grant')::uuid)$q$])
  loop
    begin
      execute broken;
      raise exception 'A PIN row outside read_records or write_records direct care was accepted: %', broken;
    exception when check_violation then
      get stacked diagnostics failed = constraint_name;
      if failed not in ('consent_grants_pin_scope_ck', 'access_requests_pin_scope_ck',
                        'consent_grants_check3') then
        raise exception 'Refused by % instead of the PIN scope constraint: %', failed, broken;
      end if;
    end;
  end loop;
  for broken in select unnest(array[
    jsonb_build_object('scope', 'break_glass'), jsonb_build_object('scope', 'read'),
    jsonb_build_object('scope', 'write_records', 'extra', true)])
  loop
    begin
      insert into identity.outbox_events (
        event_type, aggregate_id, aggregate_version, facility_id, patient_id, correlation_id, payload
      ) values (
        'PatientAccessPinVerified', current_setting('pin_test.grant')::uuid, 1,
        'b1000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000001',
        'pin-integration-outbox-shape',
        jsonb_build_object('consentGrantId', current_setting('pin_test.grant')::uuid, 'reviewRequired', true)
          || broken::jsonb
      );
      raise exception 'A PIN notice payload outside the minimum was accepted: %', broken;
    exception when check_violation then
      get stacked diagnostics failed = constraint_name;
      if failed <> 'identity_outbox_minimum_necessary' then
        raise exception 'Refused by % instead of the outbox minimum: %', failed, broken;
      end if;
    end;
  end loop;
end
$$;

-- 0121: through the insert policy a PIN notice must name its grant's own
-- scope; a read_records payload for a write grant is refused.
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'pin-integration-policy-0001', true);
do $$
begin
  begin
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id, correlation_id, payload
    ) values (
      'PatientAccessPinVerified', current_setting('pin_test.grant')::uuid, 1,
      'b1000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000001',
      'pin-integration-policy-0001',
      jsonb_build_object('consentGrantId', current_setting('pin_test.grant')::uuid, 'reviewRequired', true,
        'scope', 'read_records')
    );
    raise exception 'A PIN notice naming another scope passed the insert policy';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

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
         and scope = 'write_records' and purpose_of_use = 'direct-care'
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
            or payload <> jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true,
                 'scope', 'write_records'))
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

-- Exercise both sides of standard consent using the actual production runtime
-- role, rather than the migration owner or a broadly privileged test role.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','staff:pin-integration',true),
 set_config('app.membership_id','b4000000-0000-4000-8000-000000000001',true),
 set_config('app.facility_id','b1000000-0000-4000-8000-000000000002',true),
 set_config('app.correlation_id','standard-consent-runtime-regression',true),
 set_config('app.purpose_of_use','direct-care',true);
do $$
declare requested record; approved record; denied record; count_rows integer;
begin
 if current_user<>'hid_identity_api_runtime' then raise exception 'Actual Identity runtime role required'; end if;
 select * into requested from identity.create_access_request('HID-PNABCD66','read_records','Synthetic runtime consent test',15);
 if requested.request_status<>'pending' then raise exception 'Expected pending patient approval'; end if;
 select count(*) into count_rows from identity.list_my_staff_access_requests('pending')
  where access_request_id=requested.access_request_id;
 if count_rows<>1 then raise exception 'Staff request list is unavailable'; end if;
 begin
  perform identity.approve_access_request(requested.access_request_id);
  raise exception 'Staff approved their own patient request';
 exception when insufficient_privilege then null; end;
 perform set_config('app.actor_subject','patient:pin-integration',true);
 perform set_config('app.membership_id','',true);perform set_config('app.facility_id','',true);
 select count(*) into count_rows from identity.list_my_access_requests()
  where access_request_id=requested.access_request_id;
 if count_rows<>0 then raise exception 'Another patient saw this access request'; end if;
 begin
  perform identity.approve_access_request(requested.access_request_id);
  raise exception 'Another patient approved this access request';
 exception when no_data_found then null; end;
 perform set_config('app.actor_subject','patient:pin-audit-failure',true);
 select count(*) into count_rows from identity.list_my_access_requests()
  where access_request_id=requested.access_request_id;
 if count_rows<>1 then raise exception 'Patient cannot see own access request'; end if;
 select * into approved from identity.approve_access_request(requested.access_request_id);
 if approved.status<>'approved' or approved.replayed then raise exception 'Patient approval failed'; end if;
 if not identity.has_active_consent_grant('b5000000-0000-4000-8000-000000000002','staff:pin-integration',
  'b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002','read_records','direct-care',clock_timestamp()) then
  raise exception 'Patient-approved grant did not authorize the exact direct-care context';
 end if;
 select * into approved from identity.approve_access_request(requested.access_request_id);
 if not approved.replayed then raise exception 'Approval replay is not idempotent'; end if;
 perform set_config('app.actor_subject','staff:pin-integration',true);
 perform set_config('app.membership_id','b4000000-0000-4000-8000-000000000001',true);
 perform set_config('app.facility_id','b1000000-0000-4000-8000-000000000002',true);
 perform identity.close_own_consent_grant(approved.consent_grant_id,'Synthetic clinician closed access');
 if identity.has_active_consent_grant('b5000000-0000-4000-8000-000000000002','staff:pin-integration',
  'b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002','read_records','direct-care',clock_timestamp()) then
  raise exception 'Closed consent remained usable';
 end if;
 select * into requested from identity.create_access_request('HID-PNABCD66','read_records','Synthetic runtime denial test',15);
 perform set_config('app.actor_subject','patient:pin-audit-failure',true);
 perform set_config('app.membership_id','',true);perform set_config('app.facility_id','',true);
 select * into denied from identity.deny_access_request(requested.access_request_id,'Synthetic patient denial');
 if denied.status<>'denied' or denied.replayed then raise exception 'Patient denial failed'; end if;
 select * into denied from identity.deny_access_request(requested.access_request_id,'Synthetic patient denial');
 if not denied.replayed then raise exception 'Denial replay is not idempotent'; end if;
end;
$$;
reset role;

rollback;
