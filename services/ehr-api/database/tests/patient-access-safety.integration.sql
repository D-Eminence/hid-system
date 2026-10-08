\set ON_ERROR_STOP on
-- Synthetic rollback-only regression coverage for the Phase 3 focused
-- patient-safety fixes: inbox runtime permission, session-bound access-request
-- decisions, patient-owned grant revocation, and access-history labelling.
begin;
set constraints all deferred;

insert into auth.accounts (id, subject, email, display_name, status) values
  ('f1100000-0000-4000-8000-000000000001', 'synthetic:safety:1', 'safety-1@example.invalid', 'Safety One', 'active'),
  ('f1100000-0000-4000-8000-000000000002', 'synthetic:safety:2', 'safety-2@example.invalid', 'Safety Two', 'active'),
  ('f1100000-0000-4000-8000-000000000003', 'staff:safety-clinician', 'safety-clinician@example.invalid', 'Safety Clinician', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('f1200000-0000-4000-8000-000000000001', 'f1100000-0000-4000-8000-000000000001', 'HID-SAFEAA', 'Safety', 'One', 'Safety One', 'active'),
  ('f1200000-0000-4000-8000-000000000002', 'f1100000-0000-4000-8000-000000000002', 'HID-SAFEBB', 'Safety', 'Two', 'Safety Two', 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('f1300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('f1100000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('f1300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  md5('safety' || n) || md5('session' || n), gen_random_uuid(), 1, 'password', clock_timestamp(),
  clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
  ('f1200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
from generate_series(1, 2) n;
insert into identity.organizations (id, name, slug) values
  ('f1400000-0000-4000-8000-000000000001', 'Safety Test Organization', 'safety-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f1400000-0000-4000-8000-000000000002', 'f1400000-0000-4000-8000-000000000001', 'Safety Test Clinic',
   'SAFE-A', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('f1500000-0000-4000-8000-000000000001', 'f1100000-0000-4000-8000-000000000003', 'Safety Clinician',
   'safety-clinician@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('f1600000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000001',
   'f1100000-0000-4000-8000-000000000003', 'f1400000-0000-4000-8000-000000000001',
   'f1400000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct care', 'safety-test'), ('emergency', 'Emergency', 'safety-test')
on conflict (code) do nothing;
-- Inserting pending requests fires the existing inbox trigger.
insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
  reason, status, requested_duration_minutes) values
  ('f1700000-0000-4000-8000-000000000001', 'f1200000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000001',
   'f1600000-0000-4000-8000-000000000001', 'f1400000-0000-4000-8000-000000000002', 'read_records', 'direct-care',
   'Follow-up consultation', 'pending', 60),
  ('f1700000-0000-4000-8000-000000000002', 'f1200000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000001',
   'f1600000-0000-4000-8000-000000000001', 'f1400000-0000-4000-8000-000000000002', 'read_records', 'direct-care',
   'Second opinion review', 'pending', 60),
  ('f1700000-0000-4000-8000-000000000003', 'f1200000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000001',
   'f1600000-0000-4000-8000-000000000001', 'f1400000-0000-4000-8000-000000000002', 'read_records', 'direct-care',
   'Other patient request', 'pending', 60);
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass) values
  ('f1800000-0000-4000-8000-000000000001', 'f1200000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000001',
   'f1100000-0000-4000-8000-000000000003', 'f1600000-0000-4000-8000-000000000001', 'f1400000-0000-4000-8000-000000000002',
   'break_glass', 'emergency', 'active', null, 'Break-glass fixture', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '30 minutes', true),
  ('f1800000-0000-4000-8000-000000000002', 'f1200000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000001',
   'f1100000-0000-4000-8000-000000000003', 'f1600000-0000-4000-8000-000000000001', 'f1400000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', null, 'Workforce fixture grant without patient approval',
   clock_timestamp() - interval '1 minute', clock_timestamp() + interval '30 minutes', false);

-- The least-privilege Identity runtime can serve the patient inbox and the
-- session-bound wrappers, but not the unbound legacy decision commands.
do $$
begin
  if not has_function_privilege('hid_identity_api_runtime', 'identity.list_my_notification_inbox(integer)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime', 'identity.mark_my_notification_read(uuid)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime', 'identity.approve_my_access_request(text,uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime', 'identity.revoke_my_consent_grant(text,uuid,uuid,text)', 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', 'identity.approve_access_request(uuid)', 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', 'identity.deny_access_request(uuid,text)', 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', 'identity.list_my_access_requests()', 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime', 'identity.list_my_notification_inbox(integer)', 'EXECUTE')
     or has_function_privilege('hid_notification_worker', 'identity.list_my_notification_inbox(integer)', 'EXECUTE') then
    raise exception 'Patient inbox/access-request privileges are not exactly governed';
  end if;
end
$$;

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:safety:1', true),
  set_config('app.correlation_id', 'patient-safety-integration-01', true);
do $$
declare inbox_item uuid; decision record;
begin
  -- Regression: the inbox previously failed with 42501 under the runtime role.
  if (select count(*) from identity.list_my_notification_inbox(50)) <> 2 then
    raise exception 'Patient inbox did not list the access-request notifications';
  end if;
  select id into inbox_item from identity.list_my_notification_inbox(50) limit 1;
  if (select read_at from identity.mark_my_notification_read(inbox_item)) is null then
    raise exception 'Patient inbox item could not be marked read';
  end if;
  if (select count(*) from identity.list_my_patient_access_requests('synthetic:safety:1',
       'f1300000-0000-4000-8000-000000000001')) <> 2 then
    raise exception 'Session-bound access-request list is wrong';
  end if;
  begin
    perform identity.list_my_patient_access_requests('synthetic:safety:1', 'f1300000-0000-4000-8000-000000000002');
    raise exception 'Access requests were listed with another patient session';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.approve_my_access_request('synthetic:safety:1', 'f1300000-0000-4000-8000-000000000001',
      'f1700000-0000-4000-8000-000000000003');
    raise exception 'A patient approved another patient request';
  exception when no_data_found then null;
  end;
  select * into decision from identity.approve_my_access_request('synthetic:safety:1',
    'f1300000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001');
  if decision.status <> 'approved' or decision.consent_grant_id is null or decision.replayed then
    raise exception 'Patient approval did not create a grant';
  end if;
  perform set_config('hid.test.approved_grant', decision.consent_grant_id::text, true);
  select * into decision from identity.approve_my_access_request('synthetic:safety:1',
    'f1300000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001');
  if not decision.replayed then raise exception 'Approval replay was not idempotent'; end if;
  select * into decision from identity.deny_my_access_request('synthetic:safety:1',
    'f1300000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000002', 'Not my clinician');
  if decision.status <> 'denied' then raise exception 'Patient denial failed'; end if;
end
$$;

-- Patient-owned revocation: approved grants only; never break-glass.
do $$
declare revoked record; history jsonb; item jsonb;
begin
  history := identity.patient_self_access_history('synthetic:safety:1', 'f1300000-0000-4000-8000-000000000001');
  for item in select * from jsonb_array_elements(history->'items') loop
    if (item->>'consentGrantId')::uuid = current_setting('hid.test.approved_grant')::uuid
       and not (item->>'patientRevocable')::boolean then
      raise exception 'Patient-approved grant was not marked revocable';
    end if;
    if (item->>'consentGrantId')::uuid = 'f1800000-0000-4000-8000-000000000001'::uuid
       and (not (item->>'breakGlass')::boolean or (item->>'patientRevocable')::boolean) then
      raise exception 'Break-glass grant was not labelled or was offered for patient revocation';
    end if;
  end loop;
  begin
    perform identity.revoke_my_consent_grant('synthetic:safety:1', 'f1300000-0000-4000-8000-000000000001',
      'f1800000-0000-4000-8000-000000000001', 'I do not want this');
    raise exception 'A patient revoked a break-glass grant';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform identity.revoke_my_consent_grant('synthetic:safety:1', 'f1300000-0000-4000-8000-000000000001',
      'f1800000-0000-4000-8000-000000000002', 'I do not want this');
    raise exception 'A patient revoked access they did not grant';
  exception when object_not_in_prerequisite_state then null;
  end;
  select * into revoked from identity.revoke_my_consent_grant('synthetic:safety:1',
    'f1300000-0000-4000-8000-000000000001', current_setting('hid.test.approved_grant')::uuid, 'No longer needed');
  if revoked.grant_status <> 'revoked' or revoked.replayed then raise exception 'Patient revocation failed'; end if;
  select * into revoked from identity.revoke_my_consent_grant('synthetic:safety:1',
    'f1300000-0000-4000-8000-000000000001', current_setting('hid.test.approved_grant')::uuid, 'No longer needed');
  if not revoked.replayed then raise exception 'Patient revocation replay was not idempotent'; end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:safety:2', true);
do $$
begin
  if exists (select 1 from identity.list_my_notification_inbox(50)
              where resource_id in ('f1700000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000002')) then
    raise exception 'Another patient read a foreign inbox item';
  end if;
  begin
    perform identity.revoke_my_consent_grant('synthetic:safety:2', 'f1300000-0000-4000-8000-000000000002',
      current_setting('hid.test.approved_grant')::uuid, 'Not mine');
    raise exception 'Another patient revoked a foreign grant';
  exception when no_data_found then null;
  end;
end
$$;
reset role;

do $$
begin
  if not exists (select 1 from identity.consent_grants where id = 'f1800000-0000-4000-8000-000000000001' and status = 'active')
     or not exists (select 1 from audit.events where action = 'identity.consent-grant.patient-revoke'
                      and resource_id = current_setting('hid.test.approved_grant') and actor_type = 'patient')
     or not exists (select 1 from audit.events where action = 'identity.access-request.approve' and actor_type = 'patient')
     or not exists (select 1 from audit.events where action = 'identity.access-request.deny' and actor_type = 'patient') then
    raise exception 'Patient decisions were not audited or break-glass changed';
  end if;
end
$$;

-- A deleted login receives no new inbox items; the patient record is retained.
update auth.accounts set status = 'deleted' where id = 'f1100000-0000-4000-8000-000000000002';
do $$
begin
  if notification.enqueue_patient_inbox_item('f1200000-0000-4000-8000-000000000002', 'ACCESS_REQUEST_RECEIVED',
       'access-request', 'f1700000-0000-4000-8000-000000000003', '{}'::jsonb) is not null then
    raise exception 'A deleted login received a new inbox item';
  end if;
  if notification.enqueue_patient_inbox_item('f1200000-0000-4000-8000-000000000001', 'ACCESS_REQUEST_RECEIVED',
       'access-request', 'f1700000-0000-4000-8000-000000000001', '{}'::jsonb) is null then
    raise exception 'An active login stopped receiving inbox items';
  end if;
end
$$;

rollback;
