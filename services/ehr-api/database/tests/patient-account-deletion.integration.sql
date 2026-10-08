\set ON_ERROR_STOP on
-- Synthetic rollback-only coverage for patient login/account deletion.
-- Deletion must close the login while preserving patient identity, NIN
-- binding, clinical records, break-glass access, and audit evidence.
begin;
set constraints all deferred;

insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm) values
  ('d1000000-0000-4000-8000-000000000001', 'synthetic:delete:1', 'delete-1@example.invalid', 'Delete One', 'active',
   '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43), 'argon2id'),
  ('d1000000-0000-4000-8000-000000000002', 'synthetic:delete:2', 'delete-2@example.invalid', 'Delete Two', 'active', null, null),
  ('d1000000-0000-4000-8000-000000000003', 'synthetic:delete:doctor', 'delete-doctor@example.invalid', 'Delete Doctor', 'active', null, null),
  ('d1000000-0000-4000-8000-000000000004', 'synthetic:delete:shared', 'delete-shared@example.invalid', 'Shared Login', 'active', null, null);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, nin_last4, nin_hash) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'HID-DELABC', 'Delete', 'One', 'Delete One', 'active', '1234', repeat('e', 64)),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'HID-DELDEF', 'Delete', 'Two', 'Delete Two', 'active', null, null),
  ('d2000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000004', 'HID-DELGHJ', 'Shared', 'Login', 'Shared Login', 'active', null, null);
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('d3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('d1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('d3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  md5('delete' || n) || md5('session' || n), gen_random_uuid(), 1, 'password', clock_timestamp(),
  clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
  ('d2000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
from unnest(array[1, 2, 4]) n;
-- A second active session for patient one must also be revoked.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('d3000000-0000-4000-8000-000000000011', 'd1000000-0000-4000-8000-000000000001',
   'd3000000-0000-4000-8000-000000000011', md5('second') || md5('session'), gen_random_uuid(), 1, 'oidc',
   clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
   'patient', 'd2000000-0000-4000-8000-000000000001');
insert into auth.external_identities (id, account_id, issuer, subject, status) values
  ('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
   'https://accounts.google.com', 'synthetic-google-delete-1', 'active');
insert into identity.patient_access_pins (patient_id, pin_hash) values
  ('d2000000-0000-4000-8000-000000000001', crypt('2468', gen_salt('bf', 12)));
insert into notification.device_registrations (account_id, platform, token_ciphertext, token_lookup_hmac, encryption_key_version)
values ('d1000000-0000-4000-8000-000000000001', 'web', '\x01'::bytea, repeat('f', 64), 'local-v1');

-- Workforce fixture used for grants and clinical evidence.
insert into identity.organizations (id, name, slug) values
  ('d5000000-0000-4000-8000-000000000001', 'Deletion Test Organization', 'deletion-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('d5000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', 'Deletion Test Facility',
   'DEL-A', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('d6000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'Deletion Doctor',
   'delete-doctor@example.invalid', 'verified', 'doctor'),
  -- The shared login also carries a workforce identity.
  ('d6000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000004', 'Shared Login',
   'delete-shared@example.invalid', 'verified', 'nurse');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('d7000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000003', 'd5000000-0000-4000-8000-000000000001',
   'd5000000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('d8000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'doctor', 'facility',
   'd7000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002', 'Deletion fixture role');
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct care', 'deletion-test'), ('emergency', 'Emergency', 'deletion-test')
on conflict (code) do nothing;
insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
  reason, status, requested_duration_minutes, approved_by_patient_id, approved_at, break_glass) values
  ('d9000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001',
   'd7000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002', 'read_records', 'direct-care',
   'Patient-approved fixture', 'approved', 60, 'd2000000-0000-4000-8000-000000000001', clock_timestamp(), false),
  ('d9000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001',
   'd7000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002', 'read_records', 'direct-care',
   'Pending fixture request', 'pending', 60, null, null, false),
  ('d9000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000001',
   'd7000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002', 'read_records', 'direct-care',
   'Other patient fixture', 'approved', 60, 'd2000000-0000-4000-8000-000000000002', clock_timestamp(), false);
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass, authorization_method) values
  ('da000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001',
   'd6000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000001',
   'd5000000-0000-4000-8000-000000000002', 'read_records', 'direct-care', 'active', 'd2000000-0000-4000-8000-000000000001',
   'Patient-approved fixture', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour', false, null),
  ('da000000-0000-4000-8000-000000000002', null, 'd2000000-0000-4000-8000-000000000001',
   'd6000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000001',
   'd5000000-0000-4000-8000-000000000002', 'read_records', 'direct-care', 'active', null,
   'PIN-derived fixture', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '15 minutes', false, 'patient_access_pin'),
  ('da000000-0000-4000-8000-000000000003', null, 'd2000000-0000-4000-8000-000000000001',
   'd6000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000001',
   'd5000000-0000-4000-8000-000000000002', 'break_glass', 'emergency', 'active', null,
   'Break-glass fixture grant', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '30 minutes', true, null),
  ('da000000-0000-4000-8000-000000000004', 'd9000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000002',
   'd6000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000001',
   'd5000000-0000-4000-8000-000000000002', 'read_records', 'direct-care', 'active', 'd2000000-0000-4000-8000-000000000002',
   'Other patient fixture', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour', false, null);
select set_config('app.actor_subject', 'synthetic:delete:doctor', true),
  set_config('app.membership_id', 'd7000000-0000-4000-8000-000000000001', true),
  set_config('app.facility_id', 'd5000000-0000-4000-8000-000000000002', true),
  set_config('app.purpose_of_use', 'direct-care', true),
  set_config('app.correlation_id', 'patient-deletion-fixture-0001', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status, started_at, ended_at)
values ('db000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003',
  'd7000000-0000-4000-8000-000000000001', 'ambulatory', 'completed', clock_timestamp() - interval '1 hour', clock_timestamp());

create temporary table deletion_audit_baseline on commit drop as
  select count(*)::bigint as n from audit.events;
grant select on deletion_audit_baseline to public;

-- Runtime roles never read or write lifecycle, policy, or hold tables directly
-- and cannot invoke internal completion or retention evaluation.
do $$
begin
  if has_table_privilege('hid_identity_api_runtime', 'identity.patient_account_deletion_requests', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'platform.legal_holds', 'INSERT')
     or has_table_privilege('hid_identity_api_runtime', 'platform.record_class_retention_policies', 'UPDATE')
     or has_function_privilege('hid_identity_api_runtime', 'identity.complete_patient_account_deletion(uuid,text)', 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', 'platform.evaluate_patient_account_deletion(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime', 'identity.request_my_account_deletion(text,uuid,text)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime', 'identity.request_my_account_deletion(text,uuid,text)', 'EXECUTE') then
    raise exception 'Account deletion privileges are broader or narrower than the governed boundary';
  end if;
  if exists (select 1 from platform.record_class_retention_policies
              where disposition <> 'retain' or automatic_purge) then
    raise exception 'A non-retain disposition or automatic purge exists without an approved policy';
  end if;
end
$$;

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:delete:1', true),
  set_config('app.correlation_id', 'patient-deletion-integration-0001', true);
do $$
declare status_value jsonb;
begin
  -- Unauthenticated / substituted sessions are rejected before any state change.
  begin
    perform identity.request_my_account_deletion('synthetic:delete:1',
      'd3000000-0000-4000-8000-000000000002', encode(sha256('token-wrong-session'::bytea), 'hex'));
    raise exception 'Deletion accepted another patient session';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.request_my_account_deletion('synthetic:delete:2',
      'd3000000-0000-4000-8000-000000000002', encode(sha256('token-subject-swap'::bytea), 'hex'));
    raise exception 'Deletion accepted a subject that differs from the authenticated actor';
  exception when insufficient_privilege then null;
  end;
  status_value := identity.my_account_deletion_status('synthetic:delete:1', 'd3000000-0000-4000-8000-000000000001');
  if status_value->'request' <> 'null'::jsonb or (status_value->>'waitingPeriodSeconds')::bigint <> 1209600 then
    raise exception 'Initial deletion status or configured waiting period is wrong: %', status_value;
  end if;
end
$$;

-- Request, then prove invalid proof, replay, and cross-account use are rejected.
do $$
declare requested record; confirmed record;
begin
  select * into requested from identity.request_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', encode(sha256('token-alpha'::bytea), 'hex'));
  if requested.request_id is null or requested.confirmation_expires_at <= clock_timestamp()
     or requested.confirmation_expires_at > clock_timestamp() + interval '11 minutes' then
    raise exception 'Deletion request did not issue a short-lived confirmation';
  end if;
  perform set_config('hid.test.request_alpha', requested.request_id::text, true);

  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', requested.request_id,
    encode(sha256('token-wrong'::bytea), 'hex'), 'DELETE MY ACCOUNT');
  if confirmed.outcome <> 'invalid' then raise exception 'Wrong token was accepted'; end if;
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', requested.request_id,
    encode(sha256('token-alpha'::bytea), 'hex'), 'delete');
  if confirmed.outcome <> 'invalid' then raise exception 'Missing explicit confirmation was accepted'; end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:delete:2', true);
do $$
declare confirmed record;
begin
  -- Patient two cannot use patient one's request or token.
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:2',
    'd3000000-0000-4000-8000-000000000002', current_setting('hid.test.request_alpha')::uuid,
    encode(sha256('token-alpha'::bytea), 'hex'), 'DELETE MY ACCOUNT');
  if confirmed.outcome <> 'invalid' then raise exception 'Another patient confirmed a foreign deletion'; end if;
  begin
    perform identity.cancel_my_account_deletion('synthetic:delete:2',
      'd3000000-0000-4000-8000-000000000002', current_setting('hid.test.request_alpha')::uuid);
    raise exception 'Another patient cancelled a foreign deletion';
  exception when no_data_found then null;
  end;
end
$$;
reset role;

-- Expired confirmation tokens are rejected and close the request.
update identity.patient_account_deletion_requests
   set confirmation_expires_at = requested_at + interval '1 second'
 where id = current_setting('hid.test.request_alpha')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:delete:1', true);
do $$
declare confirmed record;
begin
  perform pg_sleep(1.1);
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', current_setting('hid.test.request_alpha')::uuid,
    encode(sha256('token-alpha'::bytea), 'hex'), 'DELETE MY ACCOUNT');
  if confirmed.outcome <> 'expired' then raise exception 'Expired confirmation was not rejected'; end if;
end
$$;
reset role;

-- A legal hold blocks completion and is preserved as immutable evidence.
insert into platform.legal_holds (id, subject_type, subject_id, reason, reference) values
  ('dc000000-0000-4000-8000-000000000001', 'patient', 'd2000000-0000-4000-8000-000000000001',
   'Synthetic litigation hold fixture', 'TEST-HOLD-1');
set local role hid_identity_api_runtime;
do $$
declare requested record; confirmed record;
begin
  select * into requested from identity.request_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', encode(sha256('token-held'::bytea), 'hex'));
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', requested.request_id,
    encode(sha256('token-held'::bytea), 'hex'), ' delete my   account ');
  if confirmed.outcome <> 'blocked' or confirmed.blocked_reason_code <> 'LEGAL_HOLD' then
    raise exception 'Legal hold did not block deletion: %', confirmed;
  end if;
end
$$;
reset role;
do $$
begin
  begin
    delete from platform.legal_holds where id = 'dc000000-0000-4000-8000-000000000001';
    raise exception 'A legal hold was deleted';
  exception when object_not_in_prerequisite_state then null;
  end;
  if exists (select 1 from auth.accounts where id = 'd1000000-0000-4000-8000-000000000001' and status <> 'active') then
    raise exception 'A blocked deletion changed the login';
  end if;
end
$$;
update platform.legal_holds set released_at = clock_timestamp(), release_reason = 'Synthetic hold released'
 where id = 'dc000000-0000-4000-8000-000000000001';

-- A login that is also a workforce identity is not closed from the portal.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:delete:shared', true);
do $$
declare requested record; confirmed record;
begin
  select * into requested from identity.request_my_account_deletion('synthetic:delete:shared',
    'd3000000-0000-4000-8000-000000000004', encode(sha256('token-shared'::bytea), 'hex'));
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:shared',
    'd3000000-0000-4000-8000-000000000004', requested.request_id,
    encode(sha256('token-shared'::bytea), 'hex'), 'DELETE MY ACCOUNT');
  if confirmed.outcome <> 'blocked' or confirmed.blocked_reason_code <> 'WORKFORCE_ACCOUNT' then
    raise exception 'Workforce login deletion was not blocked: %', confirmed;
  end if;
end
$$;

-- Eligible confirmation schedules a cancellable deletion; the token cannot be replayed.
select set_config('app.actor_subject', 'synthetic:delete:1', true);
do $$
declare requested record; confirmed record; cancelled record;
begin
  select * into requested from identity.request_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', encode(sha256('token-cancel'::bytea), 'hex'));
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', requested.request_id,
    encode(sha256('token-cancel'::bytea), 'hex'), 'DELETE MY ACCOUNT');
  if confirmed.outcome <> 'pending' or confirmed.scheduled_for < clock_timestamp() + interval '13 days' then
    raise exception 'Eligible deletion was not scheduled after the waiting period: %', confirmed;
  end if;
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', requested.request_id,
    encode(sha256('token-cancel'::bytea), 'hex'), 'DELETE MY ACCOUNT');
  if confirmed.outcome <> 'invalid' then raise exception 'Confirmation token replay was accepted'; end if;
  begin
    perform identity.request_my_account_deletion('synthetic:delete:1',
      'd3000000-0000-4000-8000-000000000001', encode(sha256('token-duplicate'::bytea), 'hex'));
    raise exception 'A duplicate deletion was accepted while one is pending';
  exception when object_not_in_prerequisite_state then null;
  end;
  if identity.patient_self_profile('synthetic:delete:1', 'd3000000-0000-4000-8000-000000000001') is null then
    raise exception 'Login became unusable before the waiting period elapsed';
  end if;
  select * into cancelled from identity.cancel_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', requested.request_id);
  if cancelled.request_state <> 'cancelled' or cancelled.replayed then raise exception 'Cancellation failed'; end if;
  select * into cancelled from identity.cancel_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', requested.request_id);
  if not cancelled.replayed then raise exception 'Repeated cancellation was not idempotent'; end if;
end
$$;
reset role;

-- The open-request index is the final duplicate guard.
do $$
begin
  begin
    insert into identity.patient_account_deletion_requests (account_id, patient_id, requested_session_id, state,
      confirmation_token_sha256, confirmation_expires_at, correlation_id) values
      ('d1000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001',
       'd3000000-0000-4000-8000-000000000001', 'awaiting_confirmation', encode(sha256('dup-1'::bytea), 'hex'),
       clock_timestamp() + interval '5 minutes', 'deletion-duplicate-guard'),
      ('d1000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001',
       'd3000000-0000-4000-8000-000000000001', 'awaiting_confirmation', encode(sha256('dup-2'::bytea), 'hex'),
       clock_timestamp() + interval '5 minutes', 'deletion-duplicate-guard');
    raise exception 'Two open deletion requests were stored for one login';
  exception when unique_violation then null;
  end;
end
$$;

-- Schedule a real deletion, then move its due time into the past.
set local role hid_identity_api_runtime;
do $$
declare requested record; confirmed record;
begin
  select * into requested from identity.request_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', encode(sha256('token-final'::bytea), 'hex'));
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:1',
    'd3000000-0000-4000-8000-000000000001', requested.request_id,
    encode(sha256('token-final'::bytea), 'hex'), 'DELETE MY ACCOUNT');
  if confirmed.outcome <> 'pending' then raise exception 'Final deletion was not scheduled'; end if;
  perform set_config('hid.test.request_final', requested.request_id::text, true);
end
$$;
reset role;
update identity.patient_account_deletion_requests
   set scheduled_for = clock_timestamp() - interval '1 second'
 where id = current_setting('hid.test.request_final')::uuid;
set local role hid_identity_api_runtime;
do $$
begin
  -- From the due time the login is unusable even before finalization.
  if exists (select 1 from identity.current_patient_account('synthetic:delete:1'))
     or identity.patient_self_profile('synthetic:delete:1', 'd3000000-0000-4000-8000-000000000001') is not null then
    raise exception 'A due deletion still authenticated the patient login';
  end if;
  -- A patient context cannot run the system finalizer.
  begin
    perform identity.finalize_due_patient_account_deletions(10);
    raise exception 'The finalizer ran outside the system lifecycle context';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

-- Audit failure fails closed: nothing is revoked if completion cannot be audited.
create function pg_temp.reject_deletion_audit() returns trigger language plpgsql as $$
begin
  if new.action = 'identity.patient-account-deletion.completed' then
    raise exception using errcode = 'P0995', message = 'Synthetic deletion audit outage';
  end if;
  return new;
end
$$;
create trigger patient_deletion_audit_failure before insert on audit.events
  for each row execute function pg_temp.reject_deletion_audit();
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'patient-deletion-finalize-0001', true);
do $$
begin
  begin
    perform identity.finalize_due_patient_account_deletions(10);
    raise exception 'Deletion completed without its completion audit';
  exception when sqlstate 'P0995' then null;
  end;
end
$$;
reset role;
drop trigger patient_deletion_audit_failure on audit.events;
do $$
begin
  if exists (select 1 from auth.accounts where id = 'd1000000-0000-4000-8000-000000000001' and status <> 'active')
     or exists (select 1 from auth.sessions where account_id = 'd1000000-0000-4000-8000-000000000001' and revoked_at is not null) then
    raise exception 'Failed completion audit leaked partial deletion side effects';
  end if;
end
$$;

set local role hid_identity_api_runtime;
do $$
declare finalized record;
begin
  select * into finalized from identity.finalize_due_patient_account_deletions(10);
  if finalized.request_id <> current_setting('hid.test.request_final')::uuid or finalized.outcome <> 'completed' then
    raise exception 'Due deletion was not completed: %', finalized;
  end if;
end
$$;
reset role;

do $$
begin
  -- Login closed: terminal status, no credential, sessions and federation revoked.
  if not exists (select 1 from auth.accounts where id = 'd1000000-0000-4000-8000-000000000001'
                   and status = 'deleted' and password_hash is null and token_version = 2) then
    raise exception 'Login was not closed with credentials removed';
  end if;
  if exists (select 1 from auth.sessions where account_id = 'd1000000-0000-4000-8000-000000000001' and revoked_at is null)
     or (select count(*) from auth.session_events where account_id = 'd1000000-0000-4000-8000-000000000001'
          and event_type = 'revoked' and details->>'reason' = 'patient_account_deleted') <> 2 then
    raise exception 'Active patient sessions were not all revoked with session evidence';
  end if;
  if exists (select 1 from auth.external_identities where account_id = 'd1000000-0000-4000-8000-000000000001' and status <> 'revoked')
     or exists (select 1 from identity.patient_access_pins where patient_id = 'd2000000-0000-4000-8000-000000000001' and status <> 'revoked')
     or exists (select 1 from notification.device_registrations where account_id = 'd1000000-0000-4000-8000-000000000001' and status = 'active') then
    raise exception 'Federated link, PIN, or notification registration survived deletion';
  end if;
  -- Provider access: patient-granted access closed, break-glass and other patients untouched.
  if exists (select 1 from identity.consent_grants where id in ('da000000-0000-4000-8000-000000000001',
               'da000000-0000-4000-8000-000000000002') and status <> 'revoked')
     or not exists (select 1 from identity.consent_grants where id = 'da000000-0000-4000-8000-000000000003' and status = 'active')
     or not exists (select 1 from identity.consent_grants where id = 'da000000-0000-4000-8000-000000000004' and status = 'active')
     or not exists (select 1 from identity.access_requests where id = 'd9000000-0000-4000-8000-000000000002' and status = 'expired') then
    raise exception 'Provider/break-glass access boundaries were not applied exactly';
  end if;
  -- Patient identity, NIN binding, and clinical record preserved.
  if not exists (select 1 from identity.patients where id = 'd2000000-0000-4000-8000-000000000001'
                   and status = 'active' and hid_code = 'HID-DELABC' and nin_last4 = '1234'
                   and nin_hash = repeat('e', 64) and account_id = 'd1000000-0000-4000-8000-000000000001')
     or not exists (select 1 from ehr.encounters where id = 'db000000-0000-4000-8000-000000000001') then
    raise exception 'Patient identity, NIN binding, or clinical record was not preserved';
  end if;
  -- Audit preserved and extended with the completion evidence.
  if (select count(*) from audit.events) <= (select n from deletion_audit_baseline)
     or not exists (select 1 from audit.events where action = 'identity.patient-account-deletion.completed'
                     and outcome = 'success' and patient_id = 'd2000000-0000-4000-8000-000000000001')
     or not exists (select 1 from audit.events where action = 'identity.patient-account-deletion.sessions-revoked')
     or not exists (select 1 from audit.events where action = 'identity.patient-account-deletion.access-revoked')
     or not exists (select 1 from audit.events where action = 'identity.patient-account-deletion.blocked'
                     and details->>'reasonCode' = 'LEGAL_HOLD')
     or not exists (select 1 from audit.events where action = 'identity.patient-account-deletion.confirmation-rejected'
                     and details->>'reason' = 'expired')
     or not exists (select 1 from audit.events where action = 'identity.patient-account-deletion.retention-evaluated') then
    raise exception 'Account deletion audit evidence is incomplete';
  end if;
  if not exists (select 1 from identity.patient_account_deletion_requests
                  where id = current_setting('hid.test.request_final')::uuid and state = 'completed'
                    and retention_decision->'recordClasses'->'clinical_record'->>'disposition' = 'retain'
                    and (completion_summary->>'patientIdentityRetained')::boolean) then
    raise exception 'Completion did not record the retention decision';
  end if;
  -- The deleted login is terminal and cannot regain a credential.
  begin
    update auth.accounts set status = 'active' where id = 'd1000000-0000-4000-8000-000000000001';
    raise exception 'A deleted login was reactivated';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    update auth.accounts set password_hash = '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('c', 22) || '$' || repeat('d', 43),
      password_algorithm = 'argon2id' where id = 'd1000000-0000-4000-8000-000000000001';
    raise exception 'A deleted login received a new credential';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from identity.patient_account_deletion_requests where id = current_setting('hid.test.request_final')::uuid;
    raise exception 'Deletion lifecycle evidence was deleted';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    update audit.events set outcome = 'failure' where action = 'identity.patient-account-deletion.completed';
    raise exception 'Deletion audit evidence was mutable';
  exception when object_not_in_prerequisite_state then null;
  end;
end
$$;

-- Deleted login is unusable through every patient resolution path.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:delete:1', true);
do $$
begin
  if exists (select 1 from identity.current_patient_account('synthetic:delete:1'))
     or identity.patient_self_profile('synthetic:delete:1', 'd3000000-0000-4000-8000-000000000001') is not null
     or identity.my_account_deletion_status('synthetic:delete:1', 'd3000000-0000-4000-8000-000000000001') is not null
     or exists (select 1 from auth.resolve_google_identity('synthetic-google-delete-1')) then
    raise exception 'Deleted login remained usable';
  end if;
end
$$;
reset role;

-- A zero waiting period completes inside the confirmation transaction.
update platform.patient_account_deletion_settings set waiting_period = interval '0';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:delete:2', true),
  set_config('app.correlation_id', 'patient-deletion-immediate-01', true);
do $$
declare requested record; confirmed record;
begin
  select * into requested from identity.request_my_account_deletion('synthetic:delete:2',
    'd3000000-0000-4000-8000-000000000002', encode(sha256('token-now'::bytea), 'hex'));
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:2',
    'd3000000-0000-4000-8000-000000000002', requested.request_id,
    encode(sha256('token-now'::bytea), 'hex'), 'DELETE MY ACCOUNT');
  if confirmed.outcome <> 'completed' then raise exception 'Zero waiting period did not complete: %', confirmed; end if;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from auth.accounts where id = 'd1000000-0000-4000-8000-000000000002' and status = 'deleted')
     or not exists (select 1 from audit.events where action = 'identity.patient-account-deletion.completed'
                      and actor_type = 'patient' and actor_subject = 'synthetic:delete:2') then
    raise exception 'Immediate completion did not close the login with patient-attributed audit';
  end if;
end
$$;

rollback;
