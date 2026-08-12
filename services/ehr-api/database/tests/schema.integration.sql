\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    raise exception 'hid_schema_test_runtime is missing; apply the reviewed runtime role bootstrap first';
  end if;
end
$$;

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

insert into migration.runs (
  id, source_system, source_snapshot, mode, status, started_by
) values (
  '7a000000-0000-4000-8000-000000000001', 'hid-1.0',
  'offline-schema-fixture-v1', 'stage', 'staged', 'schema-test'
);

insert into migration.legacy_identity_mappings (
  id, run_id, source_system, source_auth_user_id, source_patient_id,
  legacy_hid_code, canonical_patient_id, canonical_account_id,
  migration_status, source_checksum_sha256, source_version,
  reconciliation_result
) values (
  '7b000000-0000-4000-8000-000000000001',
  '7a000000-0000-4000-8000-000000000001', 'hid-1.0',
  'legacy-auth-0001', 'legacy-patient-0001', 'HID-ABCDEFGH',
  '50000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002', 'staged',
  repeat('7', 64)::character(64), 'source-etag-0001', 'pending'
);

do $$
begin
  begin
    insert into migration.legacy_identity_mappings (
      run_id, source_system, source_auth_user_id, source_patient_id,
      legacy_hid_code, canonical_patient_id, canonical_account_id,
      migration_status, source_checksum_sha256, source_version
    ) values (
      '7a000000-0000-4000-8000-000000000001', 'hid-1.0',
      'legacy-auth-0001', 'duplicate-source-patient', 'HID-ZYXWVUTS',
      '50000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002', 'staged',
      repeat('8', 64)::character(64), 'source-etag-0002'
    );
    raise exception 'duplicate legacy principal mapping was accepted';
  exception when unique_violation then null;
  end;
end
$$;

insert into identity.access_requests (
  id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
  reason, status, requested_duration_minutes, approved_by_patient_id, approved_at
) values (
  '71000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  'write_records', 'direct-care', 'Schema integration access request',
  'approved', 60, '50000000-0000-4000-8000-000000000001', clock_timestamp()
);

insert into identity.consent_grants (
  id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass
) values (
  '70000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  'write_records', 'direct-care', 'active', 'Schema integration consent',
  clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '1 hour',
  false
);

set role hid_schema_test_runtime;
select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'schema-test-nin-correlation-0001', true);
select set_config('app.purpose_of_use', 'healthcare-operations', true);

insert into identity.patient_assurance_states (
  patient_id, account_id, state, source_system, source_reference
) values (
  '50000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'LEGACY_MIGRATED', 'hid-1.0', 'legacy-patient-0001'
);

insert into auth.otp_challenges (
  id, account_id, recipient_hmac, purpose, channel, verifier_hmac,
  verifier_key_version, expires_at, max_attempts, request_ip_hmac
) values (
  '7c000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002', repeat('1', 64)::character(64),
  'LEGACY_ACCOUNT_RECOVERY', 'email', repeat('2', 64)::character(64),
  'schema-v1', clock_timestamp() + interval '5 minutes', 5,
  repeat('3', 64)::character(64)
);

do $$
begin
  begin
    insert into auth.otp_challenges (
      account_id, recipient_hmac, purpose, channel, verifier_hmac,
      verifier_key_version, expires_at, max_attempts
    ) values (
      '20000000-0000-4000-8000-000000000002', repeat('1', 64)::character(64),
      'LEGACY_ACCOUNT_RECOVERY', 'email', repeat('4', 64)::character(64),
      'schema-v1', clock_timestamp() + interval '5 minutes', 5
    );
    raise exception 'a second active OTP challenge was accepted';
  exception when unique_violation then null;
  end;
end
$$;

update auth.otp_challenges
set invalidated_at = clock_timestamp(), invalidation_reason = 'resend', row_version = row_version + 1
where id = '7c000000-0000-4000-8000-000000000001';

insert into auth.otp_challenges (
  id, account_id, recipient_hmac, purpose, channel, verifier_hmac,
  verifier_key_version, expires_at, max_attempts
) values (
  '7c000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002', repeat('1', 64)::character(64),
  'LEGACY_ACCOUNT_RECOVERY', 'email', repeat('4', 64)::character(64),
  'schema-v1', clock_timestamp() + interval '5 minutes', 5
);

insert into notification.device_registrations (
  id, account_id, platform, token_ciphertext, token_lookup_hmac,
  encryption_key_version
) values (
  '7d000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002', 'web', decode(repeat('ab', 32), 'hex'),
  repeat('5', 64)::character(64), 'schema-v1'
);

insert into notification.delivery_attempts (
  event_id, idempotency_key, workflow_id, channel, provider, outcome,
  provider_message_id, correlation_id
) values (
  '7e000000-0000-4000-8000-000000000001', repeat('6', 64)::character(64),
  'patient-update-v1', 'push', 'novu', 'accepted', 'provider-safe-0001',
  'schema-notification-correlation-0001'
);

do $$
begin
  begin
    update notification.delivery_attempts set outcome = 'unknown'
    where event_id = '7e000000-0000-4000-8000-000000000001';
    raise exception 'append-only notification attempt was mutated';
  exception when object_not_in_prerequisite_state then null;
  end;
end
$$;

insert into auth.sessions (
  id, account_id, family_id, refresh_token_sha256, access_jti,
  account_token_version, authentication_method, issued_at, expires_at,
  absolute_expires_at
) values (
  '61000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '62000000-0000-4000-8000-000000000001', repeat('9', 64)::character(64),
  '63000000-0000-4000-8000-000000000001', 1, 'password',
  clock_timestamp(), clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '2 hours'
);

do $$
declare
  registration_id uuid := 'a1000000-0000-4000-8000-000000000001';
  registration_patient_id uuid := '50000000-0000-4000-8000-000000000002';
  lookup_hmac constant text := 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  request_hash constant text := 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  review_key constant text := 'schema-nin-review-idempotency-0001';
  review_hash constant text := 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
begin
  insert into identity.registration_cases (
    id, facility_id, created_by_account_id, created_by_membership_id,
    status, first_name, last_name, full_name, dob, gender,
    nin_ciphertext, nin_lookup_hmac, nin_last4, nin_key_version,
    verification_provider, verification_reference, verified_at,
    idempotency_key, request_sha256
  ) values (
    registration_id, '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'pending_new_identity_approval', 'Nin', 'Registration', 'Nin Registration',
    date '1991-02-03', 'female', decode(repeat('ab', 32), 'hex'), lookup_hmac,
    '8901', 'test-v1', 'schema-test-provider', 'schema-ref-0001', clock_timestamp(),
    'schema-nin-resolution-idempotency-0001', request_hash
  );

  insert into identity.patients (
    id, hid_code, first_name, last_name, full_name, dob, gender, status, source_system
  ) values (
    registration_patient_id, 'HID-BCDEFGHJ', 'Nin', 'Registration', 'Nin Registration',
    date '1991-02-03', 'female', 'active', 'hid-nin-registration'
  );

  begin
    insert into identity.patient_identifiers (
      id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
      encryption_key_version, display_hint, verified, verified_at,
      verification_provider, verification_reference
    ) values (
      'b1000000-0000-4000-8000-000000000001', registration_patient_id, 'nin',
      decode(repeat('cd', 32), 'hex'), lookup_hmac, 'test-v1', '****8901', true,
      clock_timestamp(), 'schema-test-provider', 'schema-ref-0001'
    );
    raise exception 'NIN identifier without a registration case unexpectedly succeeded';
  exception when others then
    if sqlstate not in ('42501', '23514') then raise; end if;
  end;

  insert into identity.patient_identifiers (
    id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
    encryption_key_version, display_hint, verified, verified_at,
    verification_provider, verification_reference, registration_case_id
  ) values (
    'b1000000-0000-4000-8000-000000000002', registration_patient_id, 'nin',
    decode(repeat('cd', 32), 'hex'), lookup_hmac, 'test-v1', '****8901', true,
    clock_timestamp(), 'schema-test-provider', 'schema-ref-0001', registration_id
  );

  update identity.registration_cases
     set status = 'approved_new_identity', resolved_patient_id = registration_patient_id,
         reviewed_by_account_id = '20000000-0000-4000-8000-000000000001',
         reviewed_by_membership_id = '40000000-0000-4000-8000-000000000001',
         review_reason = 'Schema test approved new identity',
         review_idempotency_key = review_key,
         review_request_sha256 = review_hash,
         row_version = 2,
         updated_at = clock_timestamp()
   where id = registration_id;

  insert into identity.registration_case_events (
    case_id, event_type, actor_account_id, actor_membership_id,
    facility_id, patient_id, reason
  ) values (
    registration_id, 'approved_new_identity',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002', registration_patient_id,
    'Schema test approved new identity'
  );

  insert into identity.outbox_events (
    event_type, aggregate_id, aggregate_version, facility_id,
    patient_id, correlation_id, payload
  ) values
    (
      'PatientRegistered', registration_id, 2,
      '10000000-0000-4000-8000-000000000002', registration_patient_id,
      'schema-test-nin-correlation-0001',
      jsonb_build_object('source', 'governed-nin-registration')
    ),
    (
      'PatientIdentifierAdded', registration_id, 2,
      '10000000-0000-4000-8000-000000000002', registration_patient_id,
      'schema-test-nin-correlation-0001',
      jsonb_build_object('identifierType', 'nin', 'verified', true)
    );

  if not exists (
    select 1 from identity.registration_cases
    where id = registration_id
      and status = 'approved_new_identity'
      and resolved_patient_id = registration_patient_id
      and review_idempotency_key = review_key
  ) then
    raise exception 'governed NIN approval did not persist the reviewed transition';
  end if;
  if (select count(*) from identity.registration_case_events where case_id = registration_id) <> 1 then
    raise exception 'governed NIN approval did not append exactly one registration event';
  end if;
  if (select count(*) from identity.outbox_events where aggregate_id = registration_id) <> 2 then
    raise exception 'governed NIN approval did not atomically append minimum Identity outbox events';
  end if;
  begin
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id,
      patient_id, correlation_id, payload
    ) values (
      'PatientIdentityResolved', registration_id, 2,
      '10000000-0000-4000-8000-000000000002', registration_patient_id,
      'schema-test-nin-correlation-0001', jsonb_build_object('rawNin', '12345678901')
    );
    raise exception 'Identity outbox accepted a raw identifier payload';
  exception when check_violation then null;
  end;
end
$$;

reset role;

set role hid_schema_test_runtime;
select set_config('app.actor_subject', 'system:auth', true);
select set_config('app.correlation_id', 'schema-test-auth-correlation-0001', true);

do $$
declare
  policy_hash constant text := '$argon2id$v=19$m=65536,t=3,p=1$Fj53hN+tmL950dibsFTZCg$wuBfvu+1WnnxUoYE76vyNTAVXCqRCaamZa4Xwhsc9vs';
  upgraded boolean;
  stale_upgrade boolean;
  stored_algorithm text;
  stored_hash text;
  stored_version bigint;
  changed_at timestamptz;
begin
  upgraded := auth.upgrade_legacy_password(
    '20000000-0000-4000-8000-000000000001',
    'staff:test-clinician',
    1,
    policy_hash
  );
  if not upgraded then
    raise exception 'expected bcrypt_legacy password upgrade to succeed';
  end if;

  select password_algorithm, password_hash, row_version, password_changed_at
    into stored_algorithm, stored_hash, stored_version, changed_at
    from auth.accounts
   where id = '20000000-0000-4000-8000-000000000001';
  if stored_algorithm <> 'argon2id'
     or stored_hash <> policy_hash
     or stored_version <> 2
     or changed_at is null then
    raise exception 'password upgrade did not persist the expected algorithm, hash, version, and timestamp';
  end if;

  stale_upgrade := auth.upgrade_legacy_password(
    '20000000-0000-4000-8000-000000000001',
    'staff:test-clinician',
    1,
    policy_hash
  );
  if stale_upgrade then
    raise exception 'stale password compare-and-swap unexpectedly succeeded';
  end if;

  perform set_config('app.actor_subject', 'staff:test-clinician', true);
  begin
    perform auth.upgrade_legacy_password(
      '20000000-0000-4000-8000-000000000001',
      'staff:test-clinician',
      2,
      policy_hash
    );
    raise exception 'password upgrade unexpectedly accepted a non-system actor';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;

select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'schema-test-correlation-0001', true);
select set_config('app.purpose_of_use', 'direct-care', true);

do $$
declare
  command_row record;
begin
  select * into command_row
  from identity.create_access_request(
    'HID-ABCDEFGH', 'read_records', 'Schema test standard access request', 30
  );
  if command_row.request_status <> 'pending'
     or command_row.request_scope <> 'read_records'
     or command_row.existing_request then
    raise exception 'standard access request command returned an invalid result';
  end if;

  select * into command_row
  from identity.create_access_request(
    'HID-ABCDEFGH', 'read_records', 'Schema test standard access replay', 45
  );
  if not command_row.existing_request or command_row.duration_minutes <> 30 then
    raise exception 'standard access request replay did not preserve the original request';
  end if;
end
$$;

select set_config('app.purpose_of_use', 'emergency', true);
do $$
declare
  command_row record;
  grant_row record;
  evaluation_time timestamptz;
  expected_reason constant text := 'Emergency treatment required for schema test';
begin
  select * into command_row
  from identity.activate_break_glass(
    'HID-ABCDEFGH', expected_reason, 15
  );
  if command_row.grant_status <> 'active' or command_row.existing_grant then
    raise exception 'break-glass command did not create an active grant';
  end if;

  evaluation_time := clock_timestamp();
  select * into grant_row
  from identity.consent_grants
  where id = command_row.consent_grant_id;
  if grant_row.id is null
     or grant_row.account_id <> '20000000-0000-4000-8000-000000000001'
     or grant_row.staff_id <> '30000000-0000-4000-8000-000000000001'
     or grant_row.membership_id <> '40000000-0000-4000-8000-000000000001'
     or grant_row.patient_id <> command_row.subject_patient_id
     or grant_row.facility_id <> '10000000-0000-4000-8000-000000000002'
     or grant_row.scope <> 'break_glass'
     or grant_row.purpose_of_use <> 'emergency'
     or grant_row.status <> 'active'
     or grant_row.reason <> expected_reason
     or grant_row.starts_at is null
     or grant_row.starts_at > evaluation_time
     or grant_row.expires_at <> command_row.expires_at
     or grant_row.expires_at <= evaluation_time
     or not grant_row.break_glass
     or grant_row.migration_hold_reason is not null then
    raise exception 'break-glass command did not persist the exact governed grant tuple';
  end if;

  if not identity.has_active_consent_grant(
    command_row.subject_patient_id,
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'read_records',
    'emergency',
    evaluation_time
  ) then
    raise exception 'active break-glass grant did not authorize emergency read access';
  end if;

  if identity.has_active_consent_grant(
    command_row.subject_patient_id,
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'read_records',
    'emergency',
    grant_row.expires_at
  ) then
    raise exception 'expired break-glass grant authorized emergency read access';
  end if;

  if identity.has_active_consent_grant(
    '50000000-0000-4000-8000-000000000002',
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'read_records',
    'emergency',
    evaluation_time
  ) then
    raise exception 'break-glass grant authorized the wrong patient';
  end if;

  if identity.has_active_consent_grant(
    command_row.subject_patient_id,
    'staff:wrong-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'read_records',
    'emergency',
    evaluation_time
  ) then
    raise exception 'break-glass grant authorized the wrong actor';
  end if;

  if identity.has_active_consent_grant(
    command_row.subject_patient_id,
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    'read_records',
    'emergency',
    evaluation_time
  ) then
    raise exception 'break-glass grant crossed into another active facility membership';
  end if;

  if identity.has_active_consent_grant(
    command_row.subject_patient_id,
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000003',
    'read_records',
    'emergency',
    evaluation_time
  ) then
    raise exception 'break-glass grant authorized a mismatched membership facility';
  end if;

  if identity.has_active_consent_grant(
    command_row.subject_patient_id,
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'write_records',
    'emergency',
    evaluation_time
  ) then
    raise exception 'break-glass grant authorized clinical write access';
  end if;

  if identity.has_active_consent_grant(
    command_row.subject_patient_id,
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'administer_permissions',
    'emergency',
    evaluation_time
  ) then
    raise exception 'break-glass grant authorized an arbitrary administrative action';
  end if;

  if identity.has_active_consent_grant(
    command_row.subject_patient_id,
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'read_records',
    null,
    evaluation_time
  ) then
    raise exception 'break-glass grant authorized access without purpose context';
  end if;

  select * into command_row
  from identity.close_own_consent_grant(
    command_row.consent_grant_id, 'Emergency access episode has ended'
  );
  if command_row.grant_status <> 'revoked' or command_row.already_closed then
    raise exception 'grant closure command did not revoke the active grant';
  end if;
  if identity.has_active_consent_grant(
    command_row.subject_patient_id,
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'read_records',
    'emergency',
    clock_timestamp()
  ) then
    raise exception 'revoked break-glass grant retained emergency read access';
  end if;
end
$$;

reset role;
insert into identity.consent_grants (
  id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass
) values (
  '70000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  'break_glass', 'emergency', 'active', 'N/A',
  clock_timestamp() - interval '1 minute',
  clock_timestamp() + interval '15 minutes', true
);

set role hid_schema_test_runtime;
select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.purpose_of_use', 'emergency', true);
do $$
begin
  if identity.has_active_consent_grant(
    '50000000-0000-4000-8000-000000000001',
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'read_records',
    'emergency',
    clock_timestamp()
  ) then
    raise exception 'break-glass grant authorized access without an adequate emergency reason';
  end if;
end
$$;

select set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
begin
  if (select count(*) from audit.list_facility_events(200, null)) < 3 then
    raise exception 'authorized facility audit read did not return consent command evidence';
  end if;
  if exists (
    select 1 from audit.list_facility_events(200, null)
    where patient_id = '50000000-0000-4000-8000-000000000001'
      and action not like 'identity.%'
  ) then
    raise exception 'unexpected pre-clinical patient event appeared in consent audit history';
  end if;
end
$$;

select set_config('app.purpose_of_use', 'direct-care', true);

do $$
begin
  if not identity.has_active_consent_grant(
    '50000000-0000-4000-8000-000000000001',
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'write_records',
    'direct-care'
  ) then
    raise exception 'expected exact facility consent to authorize';
  end if;
end
$$;

reset role;
do $$
begin
  begin
    insert into identity.consent_grants (
      id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass
    ) values (
      '70000000-0000-4000-8000-000000000099',
      '71000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      'read_records', 'direct-care', 'active', 'Mismatched request must fail',
      clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour', false
    );
    raise exception 'mismatched grant/request authorization tuple unexpectedly succeeded';
  exception when foreign_key_violation then
    null;
  end;
end
$$;

update auth.accounts
   set disabled_until = clock_timestamp() + interval '1 hour'
 where id = '20000000-0000-4000-8000-000000000001';
set role hid_schema_test_runtime;
do $$
begin
  if identity.has_active_consent_grant(
    '50000000-0000-4000-8000-000000000001',
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'write_records',
    'direct-care'
  ) then
    raise exception 'temporarily disabled account retained consent authorization';
  end if;
end
$$;
reset role;
update auth.accounts
   set disabled_until = null
 where id = '20000000-0000-4000-8000-000000000001';

update identity.organizations
   set active = false
 where id = '10000000-0000-4000-8000-000000000001';
set role hid_schema_test_runtime;
do $$
begin
  if identity.has_active_consent_grant(
    '50000000-0000-4000-8000-000000000001',
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'write_records',
    'direct-care'
  ) then
    raise exception 'inactive organization retained consent authorization';
  end if;
end
$$;
reset role;
update identity.organizations
   set active = true
 where id = '10000000-0000-4000-8000-000000000001';

update identity.facilities
   set active = false, lifecycle_status = 'suspended',
       status_reason = 'Schema inactive-facility authorization check'
 where id = '10000000-0000-4000-8000-000000000002';
set role hid_schema_test_runtime;
do $$
begin
  if identity.has_active_membership(
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002'
  ) then
    raise exception 'inactive facility retained membership authorization';
  end if;
end
$$;
reset role;
update identity.facilities
   set active = true, lifecycle_status = 'verified',
       status_reason = 'Schema facility authorization restored'
 where id = '10000000-0000-4000-8000-000000000002';

update identity.staff
   set verification_status = 'pending'
 where id = '30000000-0000-4000-8000-000000000001';
set role hid_schema_test_runtime;
do $$
begin
  if identity.has_active_membership(
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002'
  ) then
    raise exception 'unverified staff retained membership authorization';
  end if;
end
$$;
reset role;
update identity.staff
   set verification_status = 'verified'
 where id = '30000000-0000-4000-8000-000000000001';

set role hid_schema_test_runtime;
select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'schema-test-correlation-0001', true);
select set_config('app.purpose_of_use', 'direct-care', true);

insert into ehr.encounters (
  id, patient_id, facility_id, created_by, created_by_membership_id,
  encounter_type, status, started_at, chief_complaint
) values (
  '80000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'ambulatory', 'in_progress', clock_timestamp(), 'Schema validation'
);

do $$
begin
  if (select count(*) from ehr.record_versions
      where resource_type = 'encounters'
        and resource_id = '80000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'encounter create did not produce exactly one record version';
  end if;
end
$$;

insert into audit.events (
  correlation_id, actor_type, actor_subject, actor_account_id,
  actor_membership_id, organization_id, facility_id, patient_id,
  action, outcome, resource_type, resource_id, purpose_of_use,
  provenance, source_system
) values (
  'schema-test-correlation-0001', 'staff', 'staff:test-clinician',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000001',
  'ehr.encounter.create', 'success', 'encounter',
  '80000000-0000-4000-8000-000000000001', 'direct-care',
  'application', 'schema-integration-test'
);

select set_config('app.membership_id', '40000000-0000-4000-8000-000000000002', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000003', true);

do $$
begin
  if exists (
    select 1 from ehr.encounters
    where id = '80000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'cross-facility encounter became visible';
  end if;
end
$$;

select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);

insert into ehr.documents (
  id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  original_file_name, storage_bucket, storage_key, object_version_id,
  declared_media_type, size_bytes, sha256_hex, classification, status, retention_class
) values (
  '90000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'schema-test.pdf', 'hid-test', 'documents/90000000-0000-4000-8000-000000000001',
  'test-version-1', 'application/pdf', 128,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'phi', 'uploaded', 'clinical-10y'
);

reset role;
do $$
begin
  begin
    delete from ehr.encounters where id = '80000000-0000-4000-8000-000000000001';
    raise exception 'encounter delete unexpectedly succeeded';
  exception when sqlstate '55000' then
    null;
  end;

  begin
    update audit.events
       set action = 'tampered'
     where correlation_id = 'schema-test-correlation-0001';
    raise exception 'audit update unexpectedly succeeded';
  exception when sqlstate '55000' then
    null;
  end;

  begin
    update ehr.documents
       set object_version_id = 'tampered-version'
     where id = '90000000-0000-4000-8000-000000000001';
    raise exception 'document object version rebinding unexpectedly succeeded';
  exception when sqlstate '55000' then
    null;
  end;
end
$$;

set role hid_document_scanner;
select set_config('app.actor_subject', 'workload:test-scanner', true);
select set_config('app.correlation_id', 'schema-test-scan-correlation-0001', true);

do $$
declare
  first_event uuid;
  replayed_event uuid;
begin
  begin
    perform ehr.append_document_scan_event(
      '90000000-0000-4000-8000-000000000001',
      'stale-version',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'clean', 'application/pdf', 'schema-scanner', '1.0', null,
      'schema-scan-idempotency-stale-version', 'schema-test-scan-correlation-0001'
    );
    raise exception 'stale object version unexpectedly received a clean scan';
  exception when sqlstate '55000' then
    null;
  end;

  begin
    perform ehr.append_document_scan_event(
      '90000000-0000-4000-8000-000000000001',
      'test-version-1',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'clean', 'application/pdf', 'schema-scanner', '1.0', null,
      'schema-scan-idempotency-stale-hash', 'schema-test-scan-correlation-0001'
    );
    raise exception 'mismatched object checksum unexpectedly received a clean scan';
  exception when sqlstate '55000' then
    null;
  end;

  first_event := ehr.append_document_scan_event(
    '90000000-0000-4000-8000-000000000001',
    'test-version-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'clean', 'application/pdf', 'schema-scanner', '1.0', null,
    'schema-scan-idempotency-0001', 'schema-test-scan-correlation-0001'
  );
  replayed_event := ehr.append_document_scan_event(
    '90000000-0000-4000-8000-000000000001',
    'test-version-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'clean', 'application/pdf', 'schema-scanner', '1.0', null,
    'schema-scan-idempotency-0001', 'schema-test-scan-correlation-0001'
  );
  if first_event <> replayed_event then
    raise exception 'scanner idempotent replay returned a different event';
  end if;
end
$$;

set role hid_schema_test_runtime;
select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'schema-test-correlation-0002', true);
select set_config('app.purpose_of_use', 'direct-care', true);

do $$
begin
  if not exists (
    select 1 from ehr.documents_effective
    where id = '90000000-0000-4000-8000-000000000001'
      and status = 'available'
      and scan_status = 'clean'
  ) then
    raise exception 'clean scan did not produce derived document availability';
  end if;
end
$$;

insert into ocr.jobs (
  id, facility_id, document_id, patient_id, source_object_version_id,
  source_sha256_hex, idempotency_key, request_sha256, provider, max_attempts,
  created_by, created_by_membership_id, correlation_id
) values (
  'd0000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000001', null, 'test-version-1',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'schema-ocr-idempotency-0001',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'schema-provider-success', 3,
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'schema-test-ocr-correlation-0001'
);

insert into ocr.jobs (
  id, facility_id, document_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, max_attempts,
  created_by, created_by_membership_id, correlation_id
) values (
  'd0000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000001', 'test-version-1',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'schema-ocr-idempotency-0002',
  'abababababababababababababababababababababababababababababababab',
  'schema-provider-failure', 2,
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'schema-test-ocr-correlation-0002'
);

do $$
begin
  begin
    insert into ocr.jobs (
      facility_id, document_id, patient_id, source_object_version_id,
      source_sha256_hex, idempotency_key, request_sha256, provider,
      created_by, created_by_membership_id, correlation_id
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '90000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002', 'test-version-1',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'schema-ocr-wrong-patient-01',
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      'schema-provider-success',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'schema-test-ocr-correlation-0001'
    );
    raise exception 'OCR accepted the wrong canonical patient association';
  exception when check_violation then null;
  end;

  begin
    insert into ocr.jobs (
      facility_id, document_id, source_object_version_id, source_sha256_hex,
      idempotency_key, request_sha256, provider,
      created_by, created_by_membership_id, correlation_id
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '90000000-0000-4000-8000-000000000001', 'test-version-1',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'schema-ocr-idempotency-0001',
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      'different-provider',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'schema-test-ocr-correlation-0001'
    );
    raise exception 'OCR duplicate idempotency scope created another job';
  exception when unique_violation then null;
  end;
end
$$;

select set_config('app.facility_id', '10000000-0000-4000-8000-000000000003', true);
do $$
begin
  if exists (select 1 from ocr.jobs where id = 'd0000000-0000-4000-8000-000000000001') then
    raise exception 'Facility B read a Facility A OCR job';
  end if;
end
$$;

reset role;
set role hid_ocr_worker;
select set_config('app.actor_subject', 'workload:test-ocr', true);
select set_config('app.correlation_id', 'schema-test-ocr-worker-0001', true);

do $$
declare claimed record; failed_claim record;
  extraction_id uuid; replay_id uuid;
begin
  select * into claimed from ocr.claim_worker_job('schema-provider-success', 300);
  if claimed.job_id <> 'd0000000-0000-4000-8000-000000000001'
     or claimed.attempt_no <> 1 or claimed.claim_token is null then
    raise exception 'OCR worker did not atomically claim the expected job';
  end if;
  if exists (select 1 from ocr.claim_worker_job('schema-provider-success', 300)) then
    raise exception 'OCR worker concurrently reclaimed an active job';
  end if;
  extraction_id := ocr.complete_worker_job(
    claimed.job_id, claimed.claim_token, 'provider-result-0001',
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'schema-model-1', 'provider-request-1', 'Original OCR model output',
    '{"candidate":"original"}'::jsonb, 0.92, '{"engine":"schema"}'::jsonb,
    'schema-test-ocr-worker-0001'
  );
  replay_id := ocr.complete_worker_job(
    claimed.job_id, claimed.claim_token, 'provider-result-0001',
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'schema-model-1', 'provider-request-1', 'Original OCR model output',
    '{"candidate":"original"}'::jsonb, 0.92, '{"engine":"schema"}'::jsonb,
    'schema-test-ocr-worker-0001'
  );
  if replay_id <> extraction_id then
    raise exception 'OCR provider callback replay created duplicate extraction';
  end if;
  select * into failed_claim from ocr.claim_worker_job('schema-provider-failure', 300);
  perform ocr.fail_worker_job(
    failed_claim.job_id, failed_claim.claim_token, 'PROVIDER_UNAVAILABLE', 'Provider request failed safely',
    true, 0, 'schema-test-ocr-worker-0001'
  );
end
$$;

set role hid_schema_test_runtime;
select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'schema-test-ocr-validation-0001', true);
select set_config('app.purpose_of_use', 'healthcare-operations', true);

do $$
begin
  if not exists (
    select 1 from ocr.jobs
     where id = 'd0000000-0000-4000-8000-000000000002'
       and status = 'queued' and attempt_count = 1
       and last_error_code = 'PROVIDER_UNAVAILABLE'
       and last_error_summary = 'Provider request failed safely'
  ) then
    raise exception 'OCR retryable failure was not safely recorded and requeued';
  end if;
end
$$;

reset role;
set role hid_ocr_worker;
select set_config('app.actor_subject', 'workload:test-ocr', true);
select set_config('app.correlation_id', 'schema-test-ocr-worker-0002', true);
do $$
declare claimed record;
begin
  select * into claimed from ocr.claim_worker_job('schema-provider-failure', 300);
  if claimed.job_id <> 'd0000000-0000-4000-8000-000000000002' or claimed.attempt_no <> 2 then
    raise exception 'OCR retry did not preserve and increment attempt state';
  end if;
  perform ocr.fail_worker_job(
    claimed.job_id, claimed.claim_token, 'UNSUPPORTED_DOCUMENT', 'Document could not be processed',
    false, 0, 'schema-test-ocr-worker-0002'
  );
end
$$;

set role hid_schema_test_runtime;
select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'schema-test-ocr-validation-0001', true);
select set_config('app.purpose_of_use', 'healthcare-operations', true);

do $$
declare extraction_id uuid; validation_id uuid; confirmation_id uuid; publication_id uuid;
  original_payload jsonb;
begin
  select id, structured_payload into extraction_id, original_payload
    from ocr.extractions where job_id = 'd0000000-0000-4000-8000-000000000001';
  insert into ocr.validations (
    job_id, facility_id, extraction_id, validation_version, validated_payload,
    corrections, reason, validated_by, validated_by_membership_id,
    disposition, target_domain, candidate_type, accepted_fields, rejected_fields,
    provenance, idempotency_key, request_sha256
  ) values (
    'd0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002', extraction_id, 1,
    '{"candidate":"human-validated"}'::jsonb,
    '[{"field":"candidate","reason":"verified against source"}]'::jsonb,
    'Human reviewer verified the source document',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'validated', 'DOCUMENT_ONLY', 'document_only',
    '{"retention":"source-document"}'::jsonb, '[]'::jsonb,
    '{"review":"source-comparison"}'::jsonb, 'schema-validation-0001',
    '1212121212121212121212121212121212121212121212121212121212121212'
  ) returning id into validation_id;
  update ocr.jobs set status = 'validated', completed_at = clock_timestamp(),
         correlation_id = 'schema-test-ocr-validation-0001', row_version = row_version + 1
   where id = 'd0000000-0000-4000-8000-000000000001';
  if (select structured_payload from ocr.extractions where id = extraction_id) <> original_payload then
    raise exception 'human validation overwrote original OCR extraction';
  end if;
  begin
    update ocr.extractions set structured_payload = '{"tampered":true}'::jsonb where id = extraction_id;
    raise exception 'immutable OCR extraction update unexpectedly succeeded';
  exception when sqlstate '55000' or insufficient_privilege then null;
  end;
  if (select status from ocr.jobs where id = 'd0000000-0000-4000-8000-000000000001') <> 'validated' then
    raise exception 'OCR validation did not transition the job';
  end if;
  insert into ocr.patient_confirmations (
    job_id,facility_id,patient_id,confirmation_version,method,reason,
    confirmed_by,confirmed_by_membership_id,idempotency_key,request_sha256
  ) values (
    'd0000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',1,'source_document',
    'Confirmed against the governed source document',
    '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
    'schema-confirmation-0001','1313131313131313131313131313131313131313131313131313131313131313'
  ) returning id into confirmation_id;
  begin
    insert into ocr.patient_confirmations (
      job_id,facility_id,patient_id,confirmation_version,method,reason,
      confirmed_by,confirmed_by_membership_id,idempotency_key,request_sha256
    ) values (
      'd0000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000002',2,'reviewed_candidate',
      'Wrong patient negative confirmation test',
      '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
      'schema-confirmation-0002','1414141414141414141414141414141414141414141414141414141414141414'
    );
    raise exception 'wrong-patient OCR confirmation unexpectedly succeeded';
  exception when check_violation then null;
  end;
  insert into ocr.publications (
    job_id,validation_id,validation_version,patient_confirmation_id,facility_id,
    patient_id,target_domain,target_operation,idempotency_key,request_sha256,
    requested_by,requested_by_membership_id,correlation_id
  ) values (
    'd0000000-0000-4000-8000-000000000001',validation_id,1,confirmation_id,
    '10000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001',
    'DOCUMENT_ONLY','retain_validated_document','schema-publication-0001',
    '1515151515151515151515151515151515151515151515151515151515151515',
    '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
    'schema-test-ocr-publication-0001'
  ) returning id into publication_id;
  update ocr.publications set status='processing',processing_token=gen_random_uuid(),
    processing_expires_at=clock_timestamp()+interval '1 minute',attempt_count=1,
    row_version=row_version+1 where id=publication_id;
  update ocr.publications set status='published',completed_at=clock_timestamp(),
    processing_token=null,processing_expires_at=null,target_resource_type='document',
    target_resource_id='90000000-0000-4000-8000-000000000001',row_version=row_version+1
    where id=publication_id;
  if not exists (select 1 from ocr.publications where id=publication_id
      and status='published' and validation_version=1) then
    raise exception 'document-only OCR publication did not preserve explicit validation version';
  end if;
  if (select count(*) from ocr.outbox_events where aggregate_id = 'd0000000-0000-4000-8000-000000000001') <> 5 then
    raise exception 'OCR lifecycle did not atomically append minimum-necessary outbox events';
  end if;
end
$$;

select set_config('app.purpose_of_use', 'direct-care', true);
select set_config('app.correlation_id', 'schema-test-lab-import-0001', true);
do $$
declare evidence_id uuid := 'f0000000-0000-4000-8000-000000000001';
begin
  insert into lab.imported_evidence (
    id,patient_id,facility_id,external_lab_name,external_reference,source_document_id,
    reviewed_by,created_by,created_by_membership_id,idempotency_key,request_sha256,correlation_id
  ) values (
    evidence_id,'50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
    'External Reference Laboratory','EXT-RESULT-1','90000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001','schema-lab-import-key-0001',
    '1616161616161616161616161616161616161616161616161616161616161616',
    'schema-test-lab-import-0001'
  );
  insert into lab.imported_observations (
    import_id,facility_id,patient_id,"ordinal",test_name,value,unit,abnormal_flag
  ) values (
    evidence_id,'10000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001',
    1,'Haemoglobin','12.5','g/dL','unknown'
  );
  insert into lab.outbox_events (
    event_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload
  ) values (
    'LabImportedEvidenceCreated',evidence_id,1,'10000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001','schema-test-lab-import-0001',
    jsonb_build_object('importId',evidence_id,'sourceType','IMPORTED_EXTERNAL')
  );
  if not exists (select 1 from lab.imported_evidence where id=evidence_id
      and source_type='IMPORTED_EXTERNAL' and status='accepted')
     or (select count(*) from lab.imported_observations where import_id=evidence_id)<>1
     or (select count(*) from lab.outbox_events where aggregate_id=evidence_id)<>1 then
    raise exception 'Lab imported evidence did not persist atomically with observation and outbox evidence';
  end if;
  begin
    update lab.imported_observations set value='13.0' where import_id=evidence_id;
    raise exception 'immutable imported Lab observation update unexpectedly succeeded';
  exception when sqlstate '55000' or insufficient_privilege then null;
  end;
  perform set_config('app.facility_id','10000000-0000-4000-8000-000000000003',true);
  perform set_config('app.membership_id','40000000-0000-4000-8000-000000000002',true);
  if exists (select 1 from lab.imported_evidence where id=evidence_id) then
    raise exception 'Facility B read Facility A imported Lab evidence';
  end if;
  perform set_config('app.facility_id','10000000-0000-4000-8000-000000000002',true);
  perform set_config('app.membership_id','40000000-0000-4000-8000-000000000001',true);
end
$$;


-- Lab accession/specimen foundation: exact work ownership, generated identifiers,
-- legal custody transitions, immutable history, RLS, and no execution/result state.
select set_config('app.correlation_id', 'schema-test-lab-accession-0001', true);
insert into ehr.lab_requests (
  id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
  test_code_system,test_code,test_display,priority,status,specimen_type_code,clinical_information
) values (
  'f1000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
  'http://loinc.org','718-7','Haemoglobin','routine','active','blood','Schema accession request'
);
insert into lab.work_items (
  id,patient_id,facility_id,ordering_facility_id,source_ehr_order_id,source_ehr_order_version,
  source_encounter_id,priority,test_code_system,test_code,test_name,clinical_indication,requested_by,
  requested_at,accepted_by,accepted_by_membership_id,idempotency_key,request_sha256,correlation_id
)
select 'f1000000-0000-4000-8000-000000000002',patient_id,facility_id,facility_id,id,row_version,
  encounter_id,priority,test_code_system,test_code,test_display,clinical_information,created_by,created_at,
  '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
  'schema-work-item-key-0001','1717171717171717171717171717171717171717171717171717171717171717',
  'schema-test-lab-accession-0001'
from ehr.lab_requests where id='f1000000-0000-4000-8000-000000000001';
insert into lab.work_item_requested_tests(id,work_item_id,facility_id,patient_id,ordinal,code_system,code,name)
values('f1000000-0000-4000-8000-000000000006','f1000000-0000-4000-8000-000000000002',
 '10000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001',1,
 'http://loinc.org','718-7','Haemoglobin');

do $$
declare accession_id uuid := 'f1000000-0000-4000-8000-000000000003';
  requirement_id uuid := 'f1000000-0000-4000-8000-000000000004';
  specimen_id uuid := 'f1000000-0000-4000-8000-000000000005';
  accession_label text; specimen_label text;
begin
  insert into lab.accessions(id,work_item_id,patient_id,facility_id,priority,created_by,
    created_by_membership_id,idempotency_key,request_sha256,correlation_id)
  values(accession_id,'f1000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002','routine','20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001','schema-accession-key-0001',
    '1818181818181818181818181818181818181818181818181818181818181818','schema-test-lab-accession-0001')
  returning accession_number into accession_label;
  if accession_label !~ '^LAB-[0-9]{8}-[0-9]{10}$' then raise exception 'unsafe accession identifier: %',accession_label; end if;
  insert into lab.specimen_requirements(id,accession_id,patient_id,facility_id,ordinal,specimen_type,container_type)
  values(requirement_id,accession_id,'50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',1,'whole blood','EDTA tube');
  insert into lab.specimens(id,requirement_id,accession_id,patient_id,facility_id,specimen_type,container_type)
  values(specimen_id,requirement_id,accession_id,'50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002','whole blood','EDTA tube') returning specimen_identifier into specimen_label;
  if specimen_label !~ '^SPC-[0-9]{8}-[0-9]{10}$' then raise exception 'unsafe specimen identifier: %',specimen_label; end if;
  insert into lab.accession_events(accession_id,work_item_id,patient_id,facility_id,event_version,event_type,
    actor_id,actor_membership_id,reason,correlation_id) values(accession_id,'f1000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',1,'accession_created',
    '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','Accession created','schema-test-lab-accession-0001');
  insert into lab.specimen_events(specimen_id,accession_id,patient_id,facility_id,event_version,event_type,
    actor_id,actor_membership_id,reason,correlation_id) values(specimen_id,accession_id,
    '50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',1,'specimen_required',
    '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','Specimen required','schema-test-lab-accession-0001');
  begin
    update lab.specimens set status='received',row_version=2 where id=specimen_id;
    raise exception 'required specimen skipped collection';
  exception when check_violation then null; end;
  update lab.specimens set status='collected',collected_at=clock_timestamp(),
    collected_by='20000000-0000-4000-8000-000000000001',
    collected_by_membership_id='40000000-0000-4000-8000-000000000001',row_version=2 where id=specimen_id;
  insert into lab.specimen_events(specimen_id,accession_id,patient_id,facility_id,event_version,event_type,
    actor_id,actor_membership_id,reason,correlation_id) values(specimen_id,accession_id,
    '50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',2,'specimen_collected',
    '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','Specimen collected','schema-test-lab-accession-0001');
  update lab.specimens set status='received',received_at=clock_timestamp(),
    received_by='20000000-0000-4000-8000-000000000001',
    received_by_membership_id='40000000-0000-4000-8000-000000000001',row_version=3 where id=specimen_id;
  begin
    update lab.specimens set status='rejected',rejected_at=clock_timestamp(),rejected_by='20000000-0000-4000-8000-000000000001',
      rejected_by_membership_id='40000000-0000-4000-8000-000000000001',rejection_reason='late rejection',row_version=4 where id=specimen_id;
    raise exception 'received specimen was rejected';
  exception when check_violation then null; end;
  if (select count(*) from lab.specimen_events e where e.specimen_id='f1000000-0000-4000-8000-000000000005')<>2 then
    raise exception 'specimen lifecycle history was not preserved';
  end if;
  perform set_config('app.facility_id','10000000-0000-4000-8000-000000000003',true);
  perform set_config('app.membership_id','40000000-0000-4000-8000-000000000002',true);
  if exists(select 1 from lab.accessions where id=accession_id) or exists(select 1 from lab.specimens where id=specimen_id) then
    raise exception 'Facility B read Facility A Lab operations';
  end if;
  perform set_config('app.facility_id','10000000-0000-4000-8000-000000000002',true);
  perform set_config('app.membership_id','40000000-0000-4000-8000-000000000001',true);
end $$;

do $$
declare execution_id uuid := 'f2000000-0000-4000-8000-000000000001';
 result_id uuid := 'f2000000-0000-4000-8000-000000000002';
begin
 insert into lab.specimen_requirements(id,accession_id,patient_id,facility_id,ordinal,specimen_type)
 values('f2000000-0000-4000-8000-000000000003','f1000000-0000-4000-8000-000000000003',
  '50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',2,'whole blood');
 insert into lab.specimens(id,requirement_id,accession_id,patient_id,facility_id,specimen_type)
 values('f2000000-0000-4000-8000-000000000004','f2000000-0000-4000-8000-000000000003',
  'f1000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002','whole blood');
 insert into lab.test_executions(id,accession_id,specimen_id,requested_test_id,patient_id,facility_id,method,
  started_by,started_by_membership_id,started_at,idempotency_key,request_sha256,correlation_id)
 values(execution_id,'f1000000-0000-4000-8000-000000000003','f1000000-0000-4000-8000-000000000005',
  'f1000000-0000-4000-8000-000000000006','50000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',null,'20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',clock_timestamp(),'schema-execution-key-0001',
  '1919191919191919191919191919191919191919191919191919191919191919','schema-test-lab-execution-0001');
 insert into lab.execution_events(execution_id,patient_id,facility_id,event_version,event_type,actor_id,
  actor_membership_id,reason,correlation_id) values(execution_id,'50000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',1,'execution_started','20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001','Execution started','schema-test-lab-execution-0001');
 update lab.test_executions set status='completed',completed_at=clock_timestamp(),
  completed_by='20000000-0000-4000-8000-000000000001',completed_by_membership_id='40000000-0000-4000-8000-000000000001',
  completed_idempotency_key='schema-completion-key-0001',completed_request_sha256=repeat('2',64),row_version=2 where id=execution_id;
 insert into lab.results(id,execution_id,patient_id,facility_id,created_by,created_by_membership_id)
 values(result_id,execution_id,'50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
 '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001');
 insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,result_type,numeric_value,unit,
  abnormal_flag,entered_by,entered_by_membership_id,idempotency_key,request_sha256,correlation_id)
 values(result_id,execution_id,'50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  1,'numeric',12.5,'g/dL','unknown','20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
  'schema-result-key-0001',repeat('3',64),'schema-test-lab-result-0001');
 update lab.results set current_version=2 where id=result_id and current_version=1;
 insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,result_type,numeric_value,unit,
  abnormal_flag,entered_by,entered_by_membership_id,correction_reason,idempotency_key,request_sha256,correlation_id)
 values(result_id,execution_id,'50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  2,'numeric',12.7,'g/dL','normal','20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
  'Corrected transcription','schema-result-key-0002',repeat('4',64),'schema-test-lab-result-0002');
 if (select count(*) from lab.result_revisions r where r.result_id='f2000000-0000-4000-8000-000000000002')<>2
   or exists(select 1 from lab.result_revisions r where r.result_id='f2000000-0000-4000-8000-000000000002' and r.verification_status<>'unverified') then
  raise exception 'unverified result history was not preserved'; end if;
 begin
  insert into lab.test_executions(accession_id,specimen_id,requested_test_id,patient_id,facility_id,started_by,
   started_by_membership_id,started_at,idempotency_key,request_sha256,correlation_id)
  select accession_id,id,'f1000000-0000-4000-8000-000000000006',patient_id,facility_id,
   '20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',clock_timestamp(),
   'schema-execution-bad-0001',repeat('5',64),'schema-test-lab-execution-bad' from lab.specimens where id='f2000000-0000-4000-8000-000000000004';
  raise exception 'non-received specimen started execution';
 exception when check_violation then null; end;
 perform set_config('app.facility_id','10000000-0000-4000-8000-000000000003',true);
 perform set_config('app.membership_id','40000000-0000-4000-8000-000000000002',true);
 if exists(select 1 from lab.test_executions e where e.id='f2000000-0000-4000-8000-000000000001')
   or exists(select 1 from lab.results r where r.id='f2000000-0000-4000-8000-000000000002') then
  raise exception 'Facility B read Facility A execution/result'; end if;
 perform set_config('app.facility_id','10000000-0000-4000-8000-000000000002',true);
 perform set_config('app.membership_id','40000000-0000-4000-8000-000000000001',true);
end $$;


-- Pharmacy foundation: exact EHR prescription snapshot acceptance, explicit
-- dispensing, preserved reversal, separate imported evidence, and forced RLS.
select set_config('app.correlation_id', 'schema-test-pharmacy-0001', true);
insert into ehr.prescriptions (
  id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_code_system, medication_code, medication_display, dose_quantity,
  dose_unit, route_code, frequency, instructions, starts_on, status
) values (
  'f3000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'urn:hid:test-medication', 'amoxicillin-500mg', 'Amoxicillin 500 mg',
  1, 'tablet', 'oral', 'Every 8 hours', 'Take after food', current_date, 'active'
);

do $$
declare
  work_id uuid := 'f3000000-0000-4000-8000-000000000002';
  dispensing_id uuid := 'f3000000-0000-4000-8000-000000000003';
  reversal_id uuid := 'f3000000-0000-4000-8000-000000000004';
  import_id uuid := 'f3000000-0000-4000-8000-000000000005';
begin
  insert into pharmacy.work_items (
    id, patient_id, facility_id, ordering_facility_id,
    source_ehr_prescription_id, source_ehr_prescription_version,
    source_encounter_id, source_status, medication_code_system, medication_code,
    medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, prescribed_by, prescribed_at, accepted_by,
    accepted_by_membership_id, acceptance_reason, idempotency_key,
    request_sha256, correlation_id
  ) select
    work_id, patient_id, facility_id, facility_id, id, row_version,
    encounter_id, status, medication_code_system, medication_code,
    medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, created_by, created_at,
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'Prescription accepted for dispensing', 'schema-pharmacy-accept-0001',
    repeat('6', 64), 'schema-test-pharmacy-0001'
  from ehr.prescriptions where id = 'f3000000-0000-4000-8000-000000000001';

  insert into pharmacy.work_item_events (
    work_item_id, patient_id, facility_id, event_version, event_type,
    actor_id, actor_membership_id, reason, correlation_id
  ) values (
    work_id, '50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002', 1,
    'prescription_accepted', '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'Prescription accepted for dispensing', 'schema-test-pharmacy-0001'
  );
  insert into pharmacy.outbox_events (
    event_type, aggregate_type, aggregate_id, aggregate_version,
    facility_id, patient_id, correlation_id, payload
  ) values (
    'PharmacyWorkItemCreated', 'pharmacy-work-item', work_id, 1,
    '10000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',
    'schema-test-pharmacy-0001',
    jsonb_build_object('workItemId', work_id,
      'sourcePrescriptionId', 'f3000000-0000-4000-8000-000000000001',
      'sourcePrescriptionVersion', 1)
  );
  if exists(select 1 from pharmacy.dispensings where work_item_id = work_id)
     or not exists(select 1 from pharmacy.work_items where id = work_id and status = 'accepted') then
    raise exception 'Pharmacy acceptance incorrectly implied dispensing';
  end if;

  begin
    insert into pharmacy.work_items (
      patient_id, facility_id, ordering_facility_id,
      source_ehr_prescription_id, source_ehr_prescription_version,
      source_encounter_id, source_status, medication_display, frequency,
      instructions, prescribed_by, prescribed_at, accepted_by,
      accepted_by_membership_id, acceptance_reason, idempotency_key,
      request_sha256, correlation_id
    ) values (
      '50000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000002',
      'f3000000-0000-4000-8000-000000000001', 2,
      '80000000-0000-4000-8000-000000000001', 'active',
      'Amoxicillin 500 mg', 'Every 8 hours', 'Take after food',
      '20000000-0000-4000-8000-000000000001', clock_timestamp(),
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'Duplicate prescription acceptance', 'schema-pharmacy-accept-0002',
      repeat('7', 64), 'schema-test-pharmacy-0002'
    );
    raise exception 'Duplicate active Pharmacy work was created';
  exception when unique_violation then null;
  end;

  begin
    insert into pharmacy.work_items (
      patient_id, facility_id, ordering_facility_id,
      source_ehr_prescription_id, source_ehr_prescription_version,
      source_encounter_id, source_status, medication_display, frequency,
      instructions, prescribed_by, prescribed_at, accepted_by,
      accepted_by_membership_id, acceptance_reason, idempotency_key,
      request_sha256, correlation_id
    ) values (
      '50000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000002',
      'f3000000-0000-4000-8000-000000000099', 1,
      '80000000-0000-4000-8000-000000000001', 'draft',
      'Unissued medicine', 'Once', 'Do not dispense',
      '20000000-0000-4000-8000-000000000001', clock_timestamp(),
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'Attempted draft acceptance', 'schema-pharmacy-draft-0001',
      repeat('8', 64), 'schema-test-pharmacy-draft'
    );
    raise exception 'Draft prescription entered Pharmacy work';
  exception when check_violation then null;
  end;

  insert into pharmacy.dispensings (
    id, work_item_id, work_item_version, patient_id, facility_id,
    medication_code_system, medication_code, medication_display,
    quantity_dispensed, quantity_unit, dispensed_by,
    dispensed_by_membership_id, reason, idempotency_key,
    request_sha256, correlation_id
  ) values (
    dispensing_id, work_id, 1,
    '50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'urn:hid:test-medication', 'amoxicillin-500mg', 'Amoxicillin 500 mg',
    21, 'tablet', '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'Medication supplied to patient', 'schema-pharmacy-dispense-0001',
    repeat('9', 64), 'schema-test-pharmacy-dispense'
  );
  insert into pharmacy.outbox_events (
    event_type, aggregate_type, aggregate_id, aggregate_version,
    facility_id, patient_id, correlation_id, payload
  ) values (
    'MedicationDispensed', 'medication-dispensing', dispensing_id, 1,
    '10000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',
    'schema-test-pharmacy-dispense',
    jsonb_build_object('dispensingId', dispensing_id, 'workItemId', work_id)
  );
  if not exists(select 1 from pharmacy.work_items where id = work_id and status = 'accepted')
     or not exists(select 1 from pharmacy.dispensings where id = dispensing_id and status = 'dispensed') then
    raise exception 'Explicit dispensing did not preserve accepted work separately';
  end if;

  begin
    insert into pharmacy.dispensings (
      work_item_id, work_item_version, patient_id, facility_id,
      medication_code_system, medication_code, medication_display,
      quantity_dispensed, quantity_unit,
      dispensed_by, dispensed_by_membership_id, reason,
      idempotency_key, request_sha256, correlation_id
    ) values (
      work_id, 1, '50000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      'urn:hid:test-medication', 'amoxicillin-500mg', 'Amoxicillin 500 mg',
      1, 'tablet', '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001', 'Duplicate dispense',
      'schema-pharmacy-dispense-0002', repeat('a', 64),
      'schema-test-pharmacy-dispense-2'
    );
    raise exception 'Second/partial dispensing was silently created';
  exception when unique_violation then null;
  end;

  insert into pharmacy.dispensing_reversals (
    id, dispensing_id, dispensing_version, work_item_id, patient_id,
    facility_id, reversed_by, reversed_by_membership_id, reason,
    idempotency_key, request_sha256, correlation_id
  ) values (
    reversal_id, dispensing_id, 1, work_id,
    '50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'Dispensing entered against wrong quantity',
    'schema-pharmacy-reverse-0001', repeat('b', 64),
    'schema-test-pharmacy-reverse'
  );
  insert into pharmacy.outbox_events (
    event_type, aggregate_type, aggregate_id, aggregate_version,
    facility_id, patient_id, correlation_id, payload
  ) values (
    'MedicationDispensingReversed', 'medication-dispensing-reversal',
    reversal_id, 1, '10000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',
    'schema-test-pharmacy-reverse',
    jsonb_build_object('reversalId', reversal_id,
      'dispensingId', dispensing_id, 'workItemId', work_id)
  );
  if not exists(select 1 from pharmacy.dispensings where id = dispensing_id)
     or not exists(select 1 from pharmacy.dispensing_reversals where id = reversal_id) then
    raise exception 'Dispensing reversal erased original evidence';
  end if;
  begin
    update pharmacy.dispensings set quantity_dispensed = 20 where id = dispensing_id;
    raise exception 'Dispensing evidence was silently overwritten';
  exception when sqlstate '55000' or insufficient_privilege then null;
  end;

  insert into pharmacy.imported_medication_evidence (
    id, patient_id, facility_id, source_document_id, ocr_job_id,
    extraction_id, validation_id, validation_version, publication_id,
    medication_text, strength_text, dose_text, frequency_text,
    historical_context, reviewed_by, created_by,
    created_by_membership_id, idempotency_key, request_sha256,
    correlation_id
  ) values (
    import_id, '50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '90000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000002',
    'd0000000-0000-4000-8000-000000000003', 1,
    'd0000000-0000-4000-8000-000000000006',
    'Metformin', '500 mg', 'one tablet', 'twice daily',
    'Medication listed in historical source document',
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'schema-pharmacy-import-0001', repeat('c', 64),
    'schema-test-pharmacy-import'
  );
  insert into pharmacy.outbox_events (
    event_type, aggregate_type, aggregate_id, aggregate_version,
    facility_id, patient_id, correlation_id, payload
  ) values (
    'PharmacyImportedMedicationEvidenceCreated',
    'imported-medication-evidence', import_id, 1,
    '10000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',
    'schema-test-pharmacy-import',
    jsonb_build_object('importId', import_id,
      'sourceType', 'IMPORTED_MEDICATION_EVIDENCE')
  );
  if not exists(select 1 from pharmacy.imported_medication_evidence
      where id = import_id and activity_status = 'unknown')
     or exists(select 1 from pharmacy.dispensings where id = import_id)
     or exists(select 1 from pharmacy.work_items where id = import_id) then
    raise exception 'Imported medication evidence became prescription or dispensing truth';
  end if;

  perform set_config('app.purpose_of_use', 'emergency', true);
  if pharmacy.context_allows(
    '50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002', 'write_records'
  ) then
    raise exception 'Break-glass authorized Pharmacy mutation';
  end if;
  perform set_config('app.purpose_of_use', 'direct-care', true);

  perform set_config('app.facility_id', '10000000-0000-4000-8000-000000000003', true);
  perform set_config('app.membership_id', '40000000-0000-4000-8000-000000000002', true);
  if exists(select 1 from pharmacy.work_items where id = work_id)
     or exists(select 1 from pharmacy.dispensings where id = dispensing_id)
     or exists(select 1 from pharmacy.imported_medication_evidence where id = import_id) then
    raise exception 'Facility B read Facility A Pharmacy evidence';
  end if;
  perform set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
  perform set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
end
$$;


-- Outreach owns temporary field-registration intake only. Identity remains the
-- sole canonical patient authority, and reconciliation is append-only.
select set_config('app.correlation_id', 'schema-test-outreach-create-0001', true);
do $$
declare
  registration_id uuid := 'f4000000-0000-4000-8000-000000000001';
  temporary_id text := 'tmp_f4000000-0000-4000-8000-000000000002';
begin
  insert into outreach.registration_cases (
    id, facility_id, created_by_account_id, created_by_membership_id,
    local_command_id, temporary_patient_id, full_name, sex, age_years,
    phone, operational_notes
  ) values (
    registration_id, '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'f4000000-0000-4000-8000-000000000003', temporary_id,
    'Temporary Field Person', 'unknown', 40, null, 'Awaiting Identity resolution'
  );
  insert into outreach.registration_case_events (
    registration_case_id, event_type, facility_id, temporary_patient_id,
    actor_account_id, actor_membership_id
  ) values (
    registration_id, 'registration_case_received',
    '10000000-0000-4000-8000-000000000002', temporary_id,
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001'
  );
  insert into outreach.command_idempotency (
    requester_account_id, requester_membership_id, facility_id, operation,
    idempotency_key, request_sha256, registration_case_id
  ) values (
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002', 'registration_case_create',
    'schema-outreach-create-0001', repeat('d', 64), registration_id
  );
  insert into outreach.outbox_events (
    event_type, aggregate_id, aggregate_version, facility_id,
    correlation_id, payload
  ) values (
    'OutreachRegistrationCaseCreated', registration_id, 1,
    '10000000-0000-4000-8000-000000000002',
    'schema-test-outreach-create-0001',
    jsonb_build_object('registrationCaseId', registration_id,
      'temporaryPatientId', temporary_id, 'status', 'identity_resolution_pending')
  );
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, action,
    resource_type, resource_id, outcome, purpose_of_use,
    details, provenance, source_system
  ) values (
    'schema-test-outreach-create-0001', 'staff', 'staff:test-clinician',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'outreach.registration-case.received', 'outreach-registration-case',
    registration_id::text, 'success', 'direct-care', '{}'::jsonb,
    'application', 'outreach-api'
  );
  if not exists (
    select 1 from outreach.registration_cases
    where id = registration_id and status = 'identity_resolution_pending'
      and resolved_patient_id is null and temporary_patient_id = temporary_id
  ) then
    raise exception 'Outreach intake did not remain explicitly unresolved';
  end if;

  insert into outreach.patient_mappings (
    registration_case_id, facility_id, temporary_patient_id,
    canonical_patient_id, resolution_kind, resolved_by_account_id,
    resolved_by_membership_id, reason
  ) values (
    registration_id, '10000000-0000-4000-8000-000000000002', temporary_id,
    '50000000-0000-4000-8000-000000000001', 'linked_existing',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'Exact existing Identity patient was authorized'
  );
  update outreach.registration_cases
     set status = 'identity_resolved',
         resolved_patient_id = '50000000-0000-4000-8000-000000000001',
         resolution_kind = 'linked_existing',
         resolved_by_account_id = '20000000-0000-4000-8000-000000000001',
         resolved_by_membership_id = '40000000-0000-4000-8000-000000000001',
         resolution_reason = 'Exact existing Identity patient was authorized',
         resolved_at = clock_timestamp(), row_version = 2
   where id = registration_id;
  insert into outreach.registration_case_events (
    registration_case_id, event_type, facility_id, temporary_patient_id,
    canonical_patient_id, actor_account_id, actor_membership_id, reason
  ) values (
    registration_id, 'existing_patient_linked',
    '10000000-0000-4000-8000-000000000002', temporary_id,
    '50000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'Exact existing Identity patient was authorized'
  );
  insert into outreach.outbox_events (
    event_type, aggregate_id, aggregate_version, facility_id, patient_id,
    correlation_id, payload
  ) values (
    'OutreachPatientResolved', registration_id, 2,
    '10000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',
    'schema-test-outreach-resolve-0001',
    jsonb_build_object('registrationCaseId', registration_id,
      'temporaryPatientId', temporary_id,
      'canonicalPatientId', '50000000-0000-4000-8000-000000000001')
  );
  if not exists (
    select 1 from outreach.registration_cases registration
    join outreach.patient_mappings mapping on mapping.registration_case_id = registration.id
    where registration.id = registration_id and registration.status = 'identity_resolved'
      and registration.temporary_patient_id = temporary_id
      and mapping.temporary_patient_id = temporary_id
      and mapping.canonical_patient_id = registration.resolved_patient_id
  ) then
    raise exception 'Outreach resolution did not preserve its temporary ID and exact mapping';
  end if;

  begin
    update outreach.registration_case_events set reason = 'overwritten'
      where registration_case_id = registration_id;
    raise exception 'Outreach history was mutable';
  exception when sqlstate '55000' or insufficient_privilege then null;
  end;
  begin
    update outreach.patient_mappings set reason = 'overwritten evidence'
      where registration_case_id = registration_id;
    raise exception 'Outreach patient mapping was mutable';
  exception when sqlstate '55000' or insufficient_privilege then null;
  end;

  perform set_config('app.purpose_of_use', 'emergency', true);
  if outreach.context_allows(
    '10000000-0000-4000-8000-000000000002', 'outreach.registration.write'
  ) then
    raise exception 'Break-glass authorized an Outreach mutation';
  end if;
  perform set_config('app.purpose_of_use', 'direct-care', true);

  perform set_config('app.facility_id', '10000000-0000-4000-8000-000000000003', true);
  perform set_config('app.membership_id', '40000000-0000-4000-8000-000000000002', true);
  if exists (select 1 from outreach.registration_cases where id = registration_id)
     or exists (select 1 from outreach.patient_mappings where registration_case_id = registration_id) then
    raise exception 'Facility B read Facility A Outreach evidence';
  end if;
  perform set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
  perform set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
end
$$;

set constraints all immediate;
set constraints all deferred;


reset role;
insert into identity.consent_directives (
  id, patient_id, current_version
) values (
  'a0000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  1
);

insert into identity.consent_directive_versions (
  id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, purposes, actions, starts_at, source_reference, reason,
  content_sha256
) values (
  'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  1, 'active', 'deny', 'all', array['direct-care'],
  array['read_records', 'write_records'], clock_timestamp() - interval '1 minute',
  'schema-test', 'Schema deny validation',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
);

set role hid_schema_test_runtime;
select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'schema-test-correlation-0003', true);
select set_config('app.purpose_of_use', 'direct-care', true);

do $$
begin
  if identity.has_active_consent_grant(
    '50000000-0000-4000-8000-000000000001',
    'staff:test-clinician',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'read_records',
    'direct-care'
  ) then
    raise exception 'active deny directive did not override the grant';
  end if;
end
$$;

-- Transactional event delivery: immutable source envelopes, exclusive leases,
-- stable redelivery after the publish/mark crash window, bounded failure, and
-- per-consumer inbox deduplication with consumer-effect atomicity.
insert into integration.inbox_consumers (consumer_name, database_role)
values
  ('schema-consumer-a', 'hid_schema_test_runtime'),
  ('schema-consumer-b', 'hid_schema_test_runtime');

do $$
begin
  begin
    update identity.outbox_events
       set payload = payload || jsonb_build_object('mutated', true)
     where event_id = (
       select event_id from identity.outbox_events order by event_id limit 1
     );
    if found then
      raise exception 'Identity source outbox envelope was mutable';
    end if;
    if not exists (
      select 1 from pg_trigger
       where tgrelid = 'identity.outbox_events'::regclass
         and tgname = 'identity_outbox_event_immutable' and tgenabled <> 'D'
    ) then
      raise exception 'Identity immutable outbox trigger is absent or disabled';
    end if;
  exception when sqlstate '55000' then null;
  end;

  begin
    insert into lab.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id,
      correlation_id, payload
    ) values (
      'LabWorkItemCreated', 'f0000000-0000-4000-8000-000000000001', 99,
      '10000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001',
      'schema-test-wrong-lab-aggregate',
      jsonb_build_object('workItemId', 'f0000000-0000-4000-8000-000000000001')
    );
    raise exception 'Lab outbox accepted an aggregate from the wrong Lab relation';
  exception when foreign_key_violation then null;
  end;
end
$$;

create temporary table delivery_claim_one on commit drop as
select * from integration.claim_outbox_events('schema-dispatcher-a', 100, 5, 3);

do $$
begin
  if (select count(*) from delivery_claim_one) < 2 then
    raise exception 'event dispatcher did not discover the active producer outboxes';
  end if;
  if exists (
    select 1 from integration.claim_outbox_events('schema-dispatcher-b', 100, 5, 3)
  ) then
    raise exception 'concurrent dispatcher claimed an event with an active lease';
  end if;
  if exists (
    select 1 from delivery_claim_one
    where event_version <> 1 or event_id is null or correlation_id is null
      or aggregate_type is null or payload is null
  ) then
    raise exception 'normalized event envelope omitted a stable versioned field';
  end if;
end
$$;

-- Model transport acceptance followed by process death before the database
-- mark. The expired lease must expose the exact same stable event for delivery.
update integration.outbox_delivery_state state
   set claimed_at = clock_timestamp() - interval '2 seconds',
       claim_expires_at = clock_timestamp() - interval '1 second'
  from delivery_claim_one claimed
 where state.producer = claimed.producer and state.event_id = claimed.event_id;

create temporary table delivery_claim_two on commit drop as
select * from integration.claim_outbox_events('schema-dispatcher-b', 100, 5, 3);

do $$
declare
  first_claim delivery_claim_one%rowtype;
  second_claim delivery_claim_two%rowtype;
begin
  if (select count(*) from delivery_claim_two) <> (select count(*) from delivery_claim_one) then
    raise exception 'expired dispatcher leases did not make every unmarked event reclaimable';
  end if;
  if exists (
    select 1
      from delivery_claim_one original
      full join delivery_claim_two retry using (producer, event_id)
     where original.event_id is null or retry.event_id is null
       or original.event_type <> retry.event_type
       or original.event_version <> retry.event_version
       or original.aggregate_type <> retry.aggregate_type
       or original.aggregate_id <> retry.aggregate_id
       or original.aggregate_version <> retry.aggregate_version
       or original.correlation_id <> retry.correlation_id
       or original.payload <> retry.payload
       or original.claim_token = retry.claim_token
       or retry.attempt_count <> original.attempt_count + 1
  ) then
    raise exception 'redelivery changed the stable event envelope or reused its lease token';
  end if;
  if exists (
    select 1 from integration.outbox_delivery_state
     where envelope_sha256::text !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'event delivery state omitted an immutable envelope digest';
  end if;

  select * into first_claim from delivery_claim_one order by occurred_at, producer, event_id limit 1;
  select * into second_claim from delivery_claim_two
   where producer = first_claim.producer and event_id = first_claim.event_id;
  begin
    perform integration.record_outbox_delivered(
      first_claim.producer, first_claim.event_id, first_claim.claim_token,
      'test', 'stale-acceptance-id'
    );
    raise exception 'a stale dispatcher token completed a reclaimed event';
  exception when sqlstate '55000' then null;
  end;
  perform integration.record_outbox_delivered(
    second_claim.producer, second_claim.event_id, second_claim.claim_token,
    'test', 'accepted-after-reclaim'
  );
end
$$;

-- A different reclaimed event follows one scheduled retry and then reaches a
-- terminal outcome at the configured maximum attempt count.
do $$
declare
  retry_claim delivery_claim_two%rowtype;
  completed_id uuid;
  completed_producer text;
  outcome text;
begin
  select event_id, producer into completed_id, completed_producer
    from integration.outbox_delivery_state where state = 'delivered' limit 1;
  select * into retry_claim from delivery_claim_two
   where (producer, event_id) <> (completed_producer, completed_id)
   order by occurred_at, producer, event_id limit 1;
  outcome := integration.record_outbox_failure(
    retry_claim.producer, retry_claim.event_id, retry_claim.claim_token,
    'test', 'TRANSIENT_TEST_FAILURE', 'Deterministic transient transport failure',
    true, clock_timestamp() + interval '1 second', 3
  );
  if outcome <> 'retry_scheduled' then
    raise exception 'retryable delivery failure did not schedule a bounded retry';
  end if;
  update integration.outbox_delivery_state set next_attempt_at = clock_timestamp() - interval '1 second'
   where producer = retry_claim.producer and event_id = retry_claim.event_id;
end
$$;

create temporary table delivery_claim_three on commit drop as
select * from integration.claim_outbox_events('schema-dispatcher-c', 100, 5, 3);

do $$
declare
  terminal_claim delivery_claim_three%rowtype;
  outcome text;
begin
  if (select count(*) from delivery_claim_three) <> 1 then
    raise exception 'scheduled delivery retry was not exclusively reclaimable';
  end if;
  select * into terminal_claim from delivery_claim_three;
  outcome := integration.record_outbox_failure(
    terminal_claim.producer, terminal_claim.event_id, terminal_claim.claim_token,
    'test', 'TRANSIENT_TEST_FAILURE', 'Maximum transport attempts exhausted',
    true, clock_timestamp() + interval '1 second', 3
  );
  if outcome <> 'failed_terminal' or not exists (
    select 1 from integration.outbox_delivery_state
     where producer = terminal_claim.producer and event_id = terminal_claim.event_id
       and state = 'failed_terminal' and attempt_count = 3
  ) then
    raise exception 'maximum delivery attempts did not produce terminal evidence';
  end if;
  if (select dispatch_success_count from integration.event_delivery_status()) < 1
     or (select dispatch_failure_count from integration.event_delivery_status()) < 1 then
    raise exception 'delivery status omitted success or failure attempt evidence';
  end if;
end
$$;

create temporary table event_consumer_effects (
  consumer_name text not null,
  event_id uuid not null,
  primary key (consumer_name, event_id)
) on commit drop;

create temporary table inbox_claim_a on commit drop as
select * from integration.claim_inbox_message(
  'schema-consumer-a', 'ab000000-0000-4000-8000-000000000001',
  'identity', 'PatientRegistered', 1, 'schema-inbox-correlation-0001',
  repeat('a', 64)::character(64), 'schema-consumer-worker-a', 30
);

do $$
declare duplicate_status text;
begin
  select claim_status into duplicate_status from integration.claim_inbox_message(
    'schema-consumer-a', 'ab000000-0000-4000-8000-000000000001',
    'identity', 'PatientRegistered', 1, 'schema-inbox-correlation-0001',
    repeat('a', 64)::character(64), 'schema-consumer-worker-a2', 30
  );
  if duplicate_status <> 'busy' then
    raise exception 'duplicate delivery bypassed an active inbox claim';
  end if;
end
$$;

insert into event_consumer_effects values
  ('schema-consumer-a', 'ab000000-0000-4000-8000-000000000001');
select integration.complete_inbox_message(
  'schema-consumer-a', 'ab000000-0000-4000-8000-000000000001',
  (select claim_token from inbox_claim_a)
);

do $$
declare duplicate_status text;
begin
  select claim_status into duplicate_status from integration.claim_inbox_message(
    'schema-consumer-a', 'ab000000-0000-4000-8000-000000000001',
    'identity', 'PatientRegistered', 1, 'schema-inbox-correlation-0001',
    repeat('a', 64)::character(64), 'schema-consumer-worker-a3', 30
  );
  if duplicate_status <> 'already_processed' then
    raise exception 'processed inbox event was not durably deduplicated';
  end if;
end
$$;

create temporary table inbox_claim_b on commit drop as
select * from integration.claim_inbox_message(
  'schema-consumer-b', 'ab000000-0000-4000-8000-000000000001',
  'identity', 'PatientRegistered', 1, 'schema-inbox-correlation-0001',
  repeat('a', 64)::character(64), 'schema-consumer-worker-b', 30
);
insert into event_consumer_effects values
  ('schema-consumer-b', 'ab000000-0000-4000-8000-000000000001');
select integration.complete_inbox_message(
  'schema-consumer-b', 'ab000000-0000-4000-8000-000000000001',
  (select claim_token from inbox_claim_b)
);

create temporary table inbox_crash_claim (
  claim_status text, claim_token uuid, attempt_count integer
) on commit drop;
savepoint inbox_consumer_crash;
insert into inbox_crash_claim select * from integration.claim_inbox_message(
  'schema-consumer-a', 'ab000000-0000-4000-8000-000000000002',
  'identity', 'PatientIdentifierAdded', 1, 'schema-inbox-correlation-0002',
  repeat('b', 64)::character(64), 'schema-consumer-worker-a', 30
);
insert into event_consumer_effects values
  ('schema-consumer-a', 'ab000000-0000-4000-8000-000000000002');
select integration.complete_inbox_message(
  'schema-consumer-a', 'ab000000-0000-4000-8000-000000000002',
  (select claim_token from inbox_crash_claim)
);
rollback to savepoint inbox_consumer_crash;

do $$
begin
  if exists (
    select 1 from integration.inbox_messages
     where consumer_name = 'schema-consumer-a'
       and event_id = 'ab000000-0000-4000-8000-000000000002'
  ) or exists (
    select 1 from event_consumer_effects
     where consumer_name = 'schema-consumer-a'
       and event_id = 'ab000000-0000-4000-8000-000000000002'
  ) then
    raise exception 'consumer crash rollback separated its effect from the inbox marker';
  end if;
  if (select count(*) from event_consumer_effects
       where event_id = 'ab000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'inbox deduplication was not independent per consumer';
  end if;
end
$$;

insert into inbox_crash_claim select * from integration.claim_inbox_message(
  'schema-consumer-a', 'ab000000-0000-4000-8000-000000000002',
  'identity', 'PatientIdentifierAdded', 1, 'schema-inbox-correlation-0002',
  repeat('b', 64)::character(64), 'schema-consumer-worker-a', 30
);
insert into event_consumer_effects values
  ('schema-consumer-a', 'ab000000-0000-4000-8000-000000000002');
select integration.complete_inbox_message(
  'schema-consumer-a', 'ab000000-0000-4000-8000-000000000002',
  (select claim_token from inbox_crash_claim)
);

-- Platform administration remains capability-only, versioned, idempotent,
-- last-admin safe, and separate from clinical authority.
select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'schema-admin-denial-0001', true);

do $$
begin
  begin
    perform auth.admin_change_platform_role(
      '20000000-0000-4000-8000-000000000001',
      (select row_version from auth.accounts
       where id = '20000000-0000-4000-8000-000000000001'),
      'platform_operations_admin', 'grant', 'Schema facility-admin escalation denial',
      'schema-admin-role-denial-0001', repeat('0', 64)::character(64)
    );
    raise exception 'ordinary facility administrator granted a platform role';
  exception when insufficient_privilege then null;
  end;
end
$$;

insert into auth.account_roles (
  id, account_id, role_code, scope_type, grant_reason
) values (
  '60000000-0000-4000-8000-000000000005',
  '20000000-0000-4000-8000-000000000001',
  'platform_super_admin', 'platform', 'Schema governed administration assignment'
);

select set_config('app.actor_subject', 'staff:test-clinician', true);
select set_config('app.membership_id', '40000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', '10000000-0000-4000-8000-000000000002', true);
select set_config('app.correlation_id', 'schema-admin-correlation-0001', true);
select set_config('app.purpose_of_use', 'healthcare-operations', true);

do $$
declare
  facility_version bigint;
  command_result record;
begin
  if exists (
    select 1 from auth.role_permissions mapping
    where mapping.role_code in (
      'platform_super_admin', 'platform_operations_admin', 'identity_review_admin',
      'facility_review_admin', 'security_auditor', 'support_admin'
    )
      and mapping.permission_code not like 'platform.%'
  ) then
    raise exception 'platform administration role inherited non-platform or clinical authority';
  end if;
  if not auth.account_has_platform_permission(
    '20000000-0000-4000-8000-000000000001', 'platform.facility.manage'
  ) then
    raise exception 'platform Super Admin capability was not resolvable';
  end if;

  select row_version into facility_version from identity.facilities
    where id = '10000000-0000-4000-8000-000000000003';
  select * into command_result from identity.admin_transition_facility(
    '10000000-0000-4000-8000-000000000003', facility_version, 'suspended',
    'Schema verified facility suspension', 'schema-admin-facility-command-0001',
    repeat('c', 64)::character(64)
  );
  if command_result.replayed or command_result.lifecycle_status <> 'suspended'
     or not exists (
       select 1 from identity.facility_status_events status_event
       where status_event.facility_id = command_result.facility_id
         and status_event.facility_version = command_result.row_version
     ) then
    raise exception 'facility administration command omitted governed evidence';
  end if;

  select * into command_result from identity.admin_transition_facility(
    '10000000-0000-4000-8000-000000000003', facility_version, 'suspended',
    'Schema verified facility suspension', 'schema-admin-facility-command-0001',
    repeat('c', 64)::character(64)
  );
  if not command_result.replayed then
    raise exception 'facility administration replay was not recognized';
  end if;

  begin
    perform identity.admin_transition_facility(
      '10000000-0000-4000-8000-000000000003', facility_version, 'suspended',
      'Schema verified facility suspension', 'schema-admin-facility-command-0001',
      repeat('d', 64)::character(64)
    );
    raise exception 'idempotency key accepted a different command digest';
  exception when unique_violation then null;
  end;

  begin
    perform identity.admin_transition_facility(
      '10000000-0000-4000-8000-000000000002',
      (select row_version + 1 from identity.facilities
        where id = '10000000-0000-4000-8000-000000000002'),
      'suspended', 'Schema stale-version suspension check',
      'schema-admin-facility-command-0002', repeat('e', 64)::character(64)
    );
    raise exception 'stale facility version was accepted';
  exception when serialization_failure then null;
  end;

  begin
    perform identity.admin_transition_facility(
      '10000000-0000-4000-8000-000000000002',
      (select row_version from identity.facilities
        where id = '10000000-0000-4000-8000-000000000002'),
      'suspended', 'Schema last reachable administrator facility check',
      'schema-admin-facility-command-0003', repeat('3', 64)::character(64)
    );
    raise exception 'last reachable platform Super Admin facility was suspended';
  exception when check_violation then null;
  end;

  begin
    perform auth.admin_change_platform_role(
      '20000000-0000-4000-8000-000000000001',
      (select row_version from auth.accounts
        where id = '20000000-0000-4000-8000-000000000001'),
      'platform_super_admin', 'revoke', 'Schema last-admin revocation check',
      'schema-admin-role-command-0001', repeat('f', 64)::character(64)
    );
    raise exception 'last platform Super Admin role was revoked';
  exception when check_violation then null;
  end;

  begin
    perform auth.admin_transition_account(
      '20000000-0000-4000-8000-000000000001',
      (select row_version from auth.accounts
        where id = '20000000-0000-4000-8000-000000000001'),
      'disabled', 'Schema last-admin suspension check',
      'schema-admin-account-command-0001', repeat('a', 64)::character(64)
    );
    raise exception 'last platform Super Admin account was suspended';
  exception when check_violation then null;
  end;

  select * into command_result from auth.admin_transition_account(
    '20000000-0000-4000-8000-000000000002',
    (select row_version from auth.accounts
      where id = '20000000-0000-4000-8000-000000000002'),
    'disabled', 'Schema governed account suspension',
    'schema-admin-account-command-0002', repeat('1', 64)::character(64)
  );
  if command_result.replayed or command_result.account_status <> 'disabled'
     or not exists (
       select 1 from auth.sessions session_row
       where session_row.account_id = command_result.account_id
         and session_row.revoked_at is not null
         and session_row.revocation_reason = 'account_suspended_by_platform_admin'
     ) or (select token_version from auth.accounts
       where id = command_result.account_id) <> 2 then
    raise exception 'account suspension did not centrally invalidate tokens and sessions';
  end if;
end
$$;

insert into auth.account_roles (
  id, account_id, role_code, scope_type, grant_reason
) values
  (
    '60000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000003',
    'support_admin', 'platform', 'Schema constrained support assignment'
  ),
  (
    '60000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000003',
    'security_auditor', 'platform', 'Schema read-only auditor assignment'
  );
select set_config('app.actor_subject', 'workload:test-scanner', true);

do $$
begin
  begin
    perform auth.admin_change_platform_role(
      '20000000-0000-4000-8000-000000000003',
      (select row_version from auth.accounts
       where id = '20000000-0000-4000-8000-000000000003'),
      'platform_operations_admin', 'grant', 'Schema denied support escalation',
      'schema-admin-role-command-0002', repeat('b', 64)::character(64)
    );
    raise exception 'constrained support role escalated platform authority';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.admin_transition_facility(
      '10000000-0000-4000-8000-000000000002',
      (select row_version from identity.facilities
       where id = '10000000-0000-4000-8000-000000000002'),
      'suspended', 'Schema auditor mutation denial',
      'schema-admin-facility-denial-0001', repeat('2', 64)::character(64)
    );
    raise exception 'Security Auditor performed a facility mutation';
  exception when insufficient_privilege then null;
  end;
end
$$;

reset role;
rollback;
