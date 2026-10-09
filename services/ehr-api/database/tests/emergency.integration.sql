\set ON_ERROR_STOP on
-- Synthetic rollback-only exact Identity role checks.
begin;
set constraints all deferred;

insert into auth.accounts (
  id, subject, email, display_name, status, password_hash, password_algorithm
) values
  (
    '20000000-0000-4000-8000-000000000001', 'staff:test-clinician',
    'clinician@test.invalid', 'Schema Test Clinician', 'active',
    '$2b$12$C5UqoLY4dzh793px/LPNXeivTi5Z1q6uMC9AZF0woY.hZ6S/kPnf6', 'bcrypt_legacy'
  ),
  ('20000000-0000-4000-8000-000000000002', 'patient:test-person', 'patient@test.invalid', 'Schema Test Patient', 'active', null, null),
  ('20000000-0000-4000-8000-000000000003', 'workload:test-scanner', null, 'Schema Test Scanner', 'active', null, null),
  ('20000000-0000-4000-8000-000000000004', 'workload:test-ocr', null, 'Schema Test OCR Worker', 'active', null, null);

insert into identity.organizations (id, name, slug) values
  ('10000000-0000-4000-8000-000000000001', 'Schema Test Organization', 'schema-test-organization');

insert into identity.facilities (
  id, organization_id, name, code, timezone, active, lifecycle_status
) values
  ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Schema Test Facility A', 'SCHEMA-A', 'Africa/Lagos', true, 'verified'),
  ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Schema Test Facility B', 'SCHEMA-B', 'Africa/Lagos', true, 'verified');

insert into identity.staff (
  id, account_id, full_name, email, verification_status, default_role
) values (
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'Schema Test Clinician',
  'clinician@test.invalid',
  'verified',
  'doctor'
);

insert into identity.staff_facility_memberships (
  id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active
) values
  (
    '40000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'doctor', 'doctor', true, true
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000003',
    'doctor', 'doctor', false, true
  );

insert into auth.account_roles (
  id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason
) values
  (
    '60000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'doctor', 'facility',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002', 'Schema fixture role assignment'
  ),
  (
    '60000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',
    'document_scanner', 'platform', null, null, 'Schema fixture role assignment'
  ),
  (
    '60000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000001',
    'admin', 'facility',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002', 'Schema fixture role assignment'
  ),
  (
    '60000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000004',
    'ocr_worker', 'platform', null, null, 'Schema fixture role assignment'
  );

insert into identity.patients (
  id, account_id, hid_code, first_name, last_name, full_name, status
) values (
  '50000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'HID-ABCDEFGH',
  'Schema', 'Patient', 'Schema Patient', 'active'
);

insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'schema-test'),
  ('emergency', 'Emergency treatment', 'schema-test'),
  ('healthcare-operations', 'Healthcare operations', 'schema-test');


create function pg_temp.reject_emergency_audit() returns trigger language plpgsql as $$
begin
  if new.action = 'identity.break-glass.activate' then
    raise exception using errcode = 'P0998', message = 'Synthetic audit outage';
  end if;
  return new;
end $$;
create trigger emergency_audit_failure before insert on audit.events
for each row execute function pg_temp.reject_emergency_audit();

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'emergency-integration-0001', true);
select set_config('app.purpose_of_use', '', true);
do $$ begin
  begin
    perform identity.activate_break_glass('HID-ABCDEFGH', 'Emergency missing purpose test', 15);
    raise exception 'Missing purpose was accepted';
  exception when sqlstate '22023' then null; end;
end $$;
select set_config('app.purpose_of_use', 'emergency', true);
do $$ begin
  begin
    perform identity.activate_break_glass('HID-ABCDEFGH', 'Emergency missing duration test', null);
    raise exception 'Missing duration was accepted';
  exception when sqlstate '22023' then null; end;
end $$;
do $$ begin
  begin
    perform identity.activate_break_glass('HID-ABCDEFGH', 'Urgent treatment with audit unavailable', 15);
    raise exception 'Emergency grant survived an audit outage';
  exception when sqlstate 'P0998' then null; end;
end $$;
reset role;
do $$ begin
  if exists(select 1 from identity.consent_grants where patient_id='50000000-0000-4000-8000-000000000001')
     or exists(select 1 from identity.outbox_events where event_type='EmergencyAccessActivated') then
    raise exception 'Audit outage leaked a grant or notification intent';
  end if;
end $$;
drop trigger emergency_audit_failure on audit.events;

create function pg_temp.reject_emergency_notification() returns trigger language plpgsql as $$
begin
  if new.event_type='EmergencyAccessActivated' then
    raise exception using errcode='P0999', message='Synthetic notification intent outage';
  end if;
  return new;
end $$;
create trigger emergency_notification_failure before insert on identity.outbox_events
for each row execute function pg_temp.reject_emergency_notification();
set local role hid_identity_api_runtime;
do $$ begin
  begin
    perform identity.activate_break_glass('HID-ABCDEFGH', 'Urgent treatment with outbox unavailable', 15);
    raise exception 'Emergency grant survived an outbox outage';
  exception when sqlstate 'P0999' then null; end;
end $$;
reset role;
do $$ begin
  if exists(select 1 from identity.consent_grants where patient_id='50000000-0000-4000-8000-000000000001')
     or exists(select 1 from audit.events where action='identity.break-glass.activate') then
    raise exception 'Notification intent outage did not roll back grant and audit';
  end if;
end $$;
drop trigger emergency_notification_failure on identity.outbox_events;

set local role hid_identity_api_runtime;
do $$ declare first_grant record; replay record;
begin
  select * into first_grant from identity.activate_break_glass('HID-ABCDEFGH', 'Urgent treatment requires access', 15);
  select * into replay from identity.activate_break_glass('HID-ABCDEFGH', 'Retry the same emergency access', 240);
  if replay.consent_grant_id<>first_grant.consent_grant_id or not replay.existing_grant
     or replay.expires_at<>first_grant.expires_at then
    raise exception 'Replay changed the grant identity or extended expiry';
  end if;
  perform identity.close_own_consent_grant(first_grant.consent_grant_id, 'Emergency read completed');
  for i in 2..10 loop
    select * into first_grant from identity.activate_break_glass('HID-ABCDEFGH', 'Another urgent treatment episode', 5);
    perform identity.close_own_consent_grant(first_grant.consent_grant_id, 'Emergency read completed');
  end loop;
  begin
    perform identity.activate_break_glass('HID-ABCDEFGH', 'Exceeded rolling emergency window', 5);
    raise exception 'Emergency abuse window did not stop the eleventh activation';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'Emergency activation rate limit reached' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if (select count(*) from identity.outbox_events where event_type='EmergencyAccessActivated')<>10 then
    raise exception 'Replays or denied commands duplicated notification intent';
  end if;
  if exists(select 1 from identity.outbox_events where event_type='EmergencyAccessActivated'
      and (registration_case_id is not null or emergency_grant_id<>aggregate_id
        or payload <> jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true))) then
    raise exception 'Emergency notification payload or aggregate identity is invalid';
  end if;
  if (select count(*) from audit.events where action='identity.break-glass.activate'
      and details->>'review_required'='true')<>10 then
    raise exception 'Required emergency review audit missing';
  end if;
  if (select count(*) from integration.outbox_envelopes where event_type='EmergencyAccessActivated'
      and aggregate_type='identity-consent-grant')<>10 then
    raise exception 'Emergency intents are not available to the established dispatcher';
  end if;
end $$;
rollback;
