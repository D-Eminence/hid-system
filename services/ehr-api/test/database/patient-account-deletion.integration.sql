\set ON_ERROR_STOP on
-- Delete my account (0096, B5; ported from main's
-- database/tests/patient-account-deletion.integration.sql, because
-- database/tests is immutable on this branch). Deletion must close the login
-- while preserving patient identity, NIN binding, clinical records,
-- break-glass access and audit evidence. Added on this branch: 0093's
-- workforce test (an unrevoked role blocks, a revoked one does not), the
-- closures of this branch's patient-owned items (emergency contacts, open
-- share invitations, pending contact changes, pending records-opened emails),
-- 0095's shares revoked with the other patient-granted access, the inbox
-- notices, the durable deletion emails (claim, recipient, outcome), the login
-- refused at scheduled_for, and the terminal-account trigger.
-- Rollback-only. Synthetic values only; uuid prefixes d and 96d.
begin;
set constraints all deferred;

insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm) values
  ('d1000000-0000-4000-8000-000000000001', 'synthetic:delete:1', 'Delete-1@Example.invalid', 'Delete One', 'active',
   '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43), 'argon2id'),
  ('d1000000-0000-4000-8000-000000000002', 'synthetic:delete:2', 'delete-2@example.invalid', 'Delete Two', 'active', null, null),
  ('d1000000-0000-4000-8000-000000000003', 'synthetic:delete:doctor', 'delete-doctor@example.invalid', 'Delete Doctor', 'active', null, null),
  ('d1000000-0000-4000-8000-000000000004', 'synthetic:delete:shared', 'delete-shared@example.invalid', 'Shared Login', 'active', null, null);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, nin_last4, nin_hash) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'HID-DELABC', 'Delete', 'One', 'Delete One', 'active', '1234', repeat('e', 64)),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'HID-DELDEF', 'Delete', 'Two', 'Delete Two', 'active', null, null),
  ('d2000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000004', 'HID-DELGHJ', 'Shared', 'Login', 'Shared Login', 'active', null, null);
update auth.accounts set email_verified_at = clock_timestamp() where id = 'd1000000-0000-4000-8000-000000000001';
-- Two more patients (0093's workforce test): one whose only workforce tie is
-- a revoked platform role, one with an unrevoked platform role.
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at) values
  ('96d10000-0000-4000-8000-000000000005', 'synthetic:delete:former-admin', 'delete-former@example.invalid',
   'Former Admin', 'active', null),
  ('96d10000-0000-4000-8000-000000000006', 'synthetic:delete:admin', 'delete-admin@example.invalid',
   'Current Admin', 'active', clock_timestamp());
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('96d20000-0000-4000-8000-000000000005', '96d10000-0000-4000-8000-000000000005', 'HID-DELFMR', 'Former', 'Admin', 'Former Admin', 'active'),
  ('96d20000-0000-4000-8000-000000000006', '96d10000-0000-4000-8000-000000000006', 'HID-DELADM', 'Current', 'Admin', 'Current Admin', 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('96d30000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('96d10000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('96d30000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  md5('delete96' || n) || md5('session96' || n), gen_random_uuid(), 1, 'password', clock_timestamp(),
  clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
  ('96d20000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
from unnest(array[5, 6]) n;
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason, granted_at, revoked_at,
  revoked_by, revocation_reason) values
  ('96d80000-0000-4000-8000-000000000005', '96d10000-0000-4000-8000-000000000005', 'support_admin', 'platform',
   'Deletion fixture former role', clock_timestamp() - interval '1 day', clock_timestamp(),
   '96d10000-0000-4000-8000-000000000006', 'Deletion fixture role ended'),
  ('96d80000-0000-4000-8000-000000000006', '96d10000-0000-4000-8000-000000000006', 'support_admin', 'platform',
   'Deletion fixture current role', clock_timestamp() - interval '1 day', null, null, null);
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
   'Other patient fixture', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour', false, null),
  -- Workforce treatment authorization that the patient did not grant; deleting
  -- the login must not disable it.
  ('da000000-0000-4000-8000-000000000005', null, 'd2000000-0000-4000-8000-000000000001',
   'd6000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000001',
   'd5000000-0000-4000-8000-000000000002', 'write_records', 'direct-care', 'active', null,
   'Treating clinician fixture', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour', false, null);
select set_config('app.actor_subject', 'synthetic:delete:doctor', true),
  set_config('app.membership_id', 'd7000000-0000-4000-8000-000000000001', true),
  set_config('app.facility_id', 'd5000000-0000-4000-8000-000000000002', true),
  set_config('app.purpose_of_use', 'direct-care', true),
  set_config('app.correlation_id', 'patient-deletion-fixture-0001', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status, started_at, ended_at)
values ('db000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003',
  'd7000000-0000-4000-8000-000000000001', 'ambulatory', 'completed', clock_timestamp() - interval '1 hour', clock_timestamp());

-- This branch's patient-owned items for patient one: a verified and an
-- already removed emergency contact (0084), a pending, an accepted and a
-- cancelled share invitation (0095), a grant from a patient share (0095), a
-- pending email change (0094), a pending and a delivered records-opened
-- email (0095); and patient two's pending invitation, which must stay.
insert into identity.patient_emergency_contacts (id, patient_id, created_by_account_id, relationship, channel,
  contact_ciphertext, contact_key_version, destination_hmac, status, verified_at) values
  ('96da0000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
   'sibling', 'email', decode(repeat('ab', 40), 'hex'), 'local-v1', repeat('1', 64), 'verified', clock_timestamp());
insert into identity.patient_emergency_contacts (id, patient_id, created_by_account_id, relationship, channel,
  status, deactivated_at, deactivation_reason) values
  ('96da0000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
   'friend', 'sms', 'deactivated', clock_timestamp() - interval '1 day', 'patient_removed');
insert into identity.patient_share_invitations (id, reference, patient_id, invitee_email, level, duration_preset, status,
  expires_at, accepted_at, accepted_membership_id, accepted_account_id, cancelled_at, delivery_outcome,
  idempotency_key, request_sha256) values
  ('96db0000-0000-4000-8000-000000000001', 'DELPEND2', 'd2000000-0000-4000-8000-000000000001', 'invitee-a@example.invalid',
   'view_only', '7d', 'pending', clock_timestamp() + interval '29 days', null, null, null, null, 'sent',
   'deletion-invite-key-0001', repeat('a', 64)),
  ('96db0000-0000-4000-8000-000000000002', 'DELACCP2', 'd2000000-0000-4000-8000-000000000001', 'delete-doctor@example.invalid',
   'clinical_review', '30d', 'accepted', clock_timestamp() + interval '29 days', clock_timestamp(),
   'd7000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', null, 'sent',
   'deletion-invite-key-0002', repeat('b', 64)),
  ('96db0000-0000-4000-8000-000000000003', 'DELCANC2', 'd2000000-0000-4000-8000-000000000001', 'invitee-c@example.invalid',
   'view_only', '24h', 'cancelled', clock_timestamp() + interval '29 days', null, null, null,
   clock_timestamp() - interval '1 hour', 'sent', 'deletion-invite-key-0003', repeat('c', 64)),
  ('96db0000-0000-4000-8000-000000000004', 'DELOTHR2', 'd2000000-0000-4000-8000-000000000002', 'invitee-d@example.invalid',
   'view_only', '24h', 'pending', clock_timestamp() + interval '29 days', null, null, null, null, 'sent',
   'deletion-invite-key-0004', repeat('d', 64));
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass) values
  ('96dc0000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001',
   'd6000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000001',
   'd5000000-0000-4000-8000-000000000002', 'write_records', 'direct-care', 'active', 'd2000000-0000-4000-8000-000000000001',
   'Shared by the patient', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '7 days', false);
insert into identity.patient_consent_shares (consent_grant_id, patient_id, membership_id, level, duration_preset,
  created_via, idempotency_key, request_sha256) values
  ('96dc0000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001',
   'clinical_collaboration', '7d', 'search', 'deletion-share-key-0001', repeat('e', 64));
insert into identity.patient_contact_changes (id, patient_id, account_id, channel, state, new_lookup_hmac,
  new_ciphertext, key_version, verifier_hmac, verifier_key_version, expires_at, max_attempts, delivery_outcome) values
  ('96dd0000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
   'email', 'pending', repeat('2', 64), decode(repeat('cd', 40), 'hex'), 'local-v1', repeat('3', 64), 'local-v1',
   clock_timestamp() + interval '10 minutes', 5, 'accepted');
insert into identity.record_access_notices (id, patient_id, facility_id, membership_id, consent_grant_id, notice_day,
  access_kind, first_access_at, email_status, next_attempt_at) values
  ('96de0000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002',
   'd7000000-0000-4000-8000-000000000001', 'da000000-0000-4000-8000-000000000001',
   (clock_timestamp() at time zone 'Africa/Lagos')::date, 'standard', clock_timestamp(), 'pending', clock_timestamp()),
  ('96de0000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002',
   'd7000000-0000-4000-8000-000000000001', 'da000000-0000-4000-8000-000000000001',
   (clock_timestamp() at time zone 'Africa/Lagos')::date - 1, 'standard', clock_timestamp() - interval '1 day',
   'delivered', null);

create temporary table deletion_audit_baseline on commit drop as
  select count(*)::bigint as n from audit.events;
grant select on deletion_audit_baseline to public;

-- Runtime roles never read or write lifecycle, policy, or hold tables directly
-- and cannot invoke internal completion or retention evaluation.
do $$
begin
  if has_table_privilege('hid_identity_runtime', 'identity.patient_account_deletion_requests', 'SELECT')
     or has_table_privilege('hid_identity_runtime', 'platform.legal_holds', 'INSERT')
     or has_table_privilege('hid_identity_runtime', 'platform.record_class_retention_policies', 'UPDATE')
     or has_function_privilege('hid_identity_runtime', 'identity.complete_patient_account_deletion(uuid,text)', 'EXECUTE')
     or has_function_privilege('hid_identity_runtime', 'platform.evaluate_patient_account_deletion(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('hid_identity_runtime', 'identity.patient_account_deletion_due(uuid)', 'EXECUTE')
     or has_function_privilege('hid_identity_runtime', 'identity.account_deletion_audit(text,text,uuid,uuid,text,text,text,uuid,jsonb)', 'EXECUTE')
     or has_table_privilege('hid_identity_runtime', 'identity.patient_account_deletion_notices', 'SELECT')
     or has_table_privilege('hid_identity_runtime', 'platform.patient_account_deletion_settings', 'SELECT')
     or has_function_privilege('hid_ehr_runtime', 'identity.finalize_due_patient_account_deletions(integer)', 'EXECUTE')
     or has_function_privilege('hid_ehr_runtime', 'identity.claim_account_deletion_notices(text,integer,integer)', 'EXECUTE')
     or not has_function_privilege('hid_identity_runtime', 'identity.my_account_deletion_status(text,uuid)', 'EXECUTE')
     or not has_function_privilege('hid_identity_runtime', 'identity.confirm_my_account_deletion(text,uuid,uuid,text,text)', 'EXECUTE')
     or not has_function_privilege('hid_identity_runtime', 'identity.cancel_my_account_deletion(text,uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('hid_identity_runtime', 'identity.finalize_due_patient_account_deletions(integer)', 'EXECUTE')
     or not has_function_privilege('hid_identity_runtime', 'identity.claim_account_deletion_notices(text,integer,integer)', 'EXECUTE')
     or not has_function_privilege('hid_identity_runtime', 'identity.record_account_deletion_notice_outcome(uuid,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('hid_schema_test_runtime', 'identity.request_my_account_deletion(text,uuid,text)', 'EXECUTE')
     or has_function_privilege('hid_ehr_runtime', 'identity.request_my_account_deletion(text,uuid,text)', 'EXECUTE')
     or not has_function_privilege('hid_identity_runtime', 'identity.request_my_account_deletion(text,uuid,text)', 'EXECUTE') then
    raise exception 'Account deletion privileges are broader or narrower than the governed boundary';
  end if;
  if exists (select 1 from platform.record_class_retention_policies
              where disposition <> 'retain' or automatic_purge) then
    raise exception 'A non-retain disposition or automatic purge exists without an approved policy';
  end if;
end
$$;

set local role hid_identity_runtime;
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
set local role hid_identity_runtime;
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
set local role hid_identity_runtime;
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
set local role hid_identity_runtime;
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

-- Confirmation wrote the scheduled email and inbox notice; cancelling the
-- scheduled deletion wrote the cancelled ones (0096, D11).
do $$
begin
  if (select count(*) from identity.patient_account_deletion_notices notice
        join identity.patient_account_deletion_requests request_row on request_row.id = notice.request_id
       where request_row.account_id = 'd1000000-0000-4000-8000-000000000001' and request_row.state = 'cancelled'
         and notice.status = 'pending' and notice.kind in ('scheduled', 'cancelled')) <> 2
     or (select count(*) from notification.inbox_items item
          where item.account_id = 'd1000000-0000-4000-8000-000000000001'
            and item.notification_code = 'ACCOUNT_DELETION_SCHEDULED' and item.resource_type = 'account-deletion'
            and item.metadata ? 'scheduledFor') <> 1
     or (select count(*) from notification.inbox_items item
          where item.account_id = 'd1000000-0000-4000-8000-000000000001'
            and item.notification_code = 'ACCOUNT_DELETION_CANCELLED' and item.metadata = '{}'::jsonb) <> 1
     or (select count(*) from notification.inbox_items item
          where item.account_id = 'd1000000-0000-4000-8000-000000000001'
            and item.notification_code = 'ACCOUNT_DELETION_BLOCKED' and item.metadata->>'reasonCode' = 'LEGAL_HOLD') <> 1
     or (select count(*) from notification.inbox_items item
          where item.account_id = 'd1000000-0000-4000-8000-000000000004'
            and item.notification_code = 'ACCOUNT_DELETION_BLOCKED'
            and item.metadata->>'reasonCode' = 'WORKFORCE_ACCOUNT') <> 1 then
    raise exception 'The scheduled, cancelled or blocked notices are not as 0096 writes them';
  end if;
end
$$;

-- 0093's workforce test: an unrevoked platform role blocks; a revoked one
-- does not. Cancelling before confirmation writes no email and no notice.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:delete:admin', true);
do $$
declare requested record; confirmed record;
begin
  select * into requested from identity.request_my_account_deletion('synthetic:delete:admin',
    '96d30000-0000-4000-8000-000000000006', encode(sha256('token-admin'::bytea), 'hex'));
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:admin',
    '96d30000-0000-4000-8000-000000000006', requested.request_id,
    encode(sha256('token-admin'::bytea), 'hex'), 'Delete my account');
  if confirmed.outcome <> 'blocked' or confirmed.blocked_reason_code <> 'WORKFORCE_ACCOUNT' then
    raise exception 'An unrevoked platform role did not block deletion: %', confirmed;
  end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:delete:former-admin', true);
do $$
declare requested record; confirmed record; cancelled record;
begin
  select * into requested from identity.request_my_account_deletion('synthetic:delete:former-admin',
    '96d30000-0000-4000-8000-000000000005', encode(sha256('token-former-1'::bytea), 'hex'));
  select * into cancelled from identity.cancel_my_account_deletion('synthetic:delete:former-admin',
    '96d30000-0000-4000-8000-000000000005', requested.request_id);
  if cancelled.request_state <> 'cancelled' then raise exception 'An unconfirmed deletion was not cancelled'; end if;
  perform set_config('hid.test.request_former_unconfirmed', requested.request_id::text, true);
  select * into requested from identity.request_my_account_deletion('synthetic:delete:former-admin',
    '96d30000-0000-4000-8000-000000000005', encode(sha256('token-former-2'::bytea), 'hex'));
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:former-admin',
    '96d30000-0000-4000-8000-000000000005', requested.request_id,
    encode(sha256('token-former-2'::bytea), 'hex'), 'DELETE MY ACCOUNT');
  if confirmed.outcome <> 'pending' then
    raise exception 'A revoked platform role blocked deletion: %', confirmed;
  end if;
  select * into cancelled from identity.cancel_my_account_deletion('synthetic:delete:former-admin',
    '96d30000-0000-4000-8000-000000000005', requested.request_id);
  perform set_config('hid.test.request_former', requested.request_id::text, true);
end
$$;
reset role;
do $$
begin
  if exists (select 1 from identity.patient_account_deletion_notices
              where request_id = current_setting('hid.test.request_former_unconfirmed')::uuid)
     or exists (select 1 from notification.inbox_items
                 where resource_id = current_setting('hid.test.request_former_unconfirmed')::uuid)
     or (select count(*) from identity.patient_account_deletion_notices
          where request_id = current_setting('hid.test.request_former')::uuid) <> 2
     or not exists (select 1 from audit.events where action = 'identity.patient-account-deletion.blocked'
                      and details->>'reasonCode' = 'WORKFORCE_ACCOUNT'
                      and actor_subject = 'synthetic:delete:admin') then
    raise exception 'Cancelling before confirmation was told, or a scheduled cancel was not';
  end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:delete:1', true);

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
set local role hid_identity_runtime;
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
set local role hid_identity_runtime;
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
set local role hid_identity_runtime;
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

set local role hid_identity_runtime;
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
     or not exists (select 1 from identity.consent_grants where id = 'da000000-0000-4000-8000-000000000005' and status = 'active')
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

-- This branch's closures (0096, D11): emergency contacts deactivated and
-- erased, open share invitations cancelled (another patient's untouched), the
-- grant from a patient share revoked, the pending email change invalidated
-- and erased, the pending records-opened email suppressed; the completed
-- email row written; no inbox notice for the deleted login.
do $$
declare summary jsonb;
begin
  if not exists (select 1 from identity.patient_emergency_contacts where id = '96da0000-0000-4000-8000-000000000001'
                   and status = 'deactivated' and deactivation_reason = 'account_deleted'
                   and contact_ciphertext is null and contact_key_version is null and destination_hmac is null)
     or not exists (select 1 from identity.patient_emergency_contacts where id = '96da0000-0000-4000-8000-000000000002'
                      and deactivation_reason = 'patient_removed') then
    raise exception 'Emergency contacts were not closed as 0084 requires';
  end if;
  if (select count(*) from identity.patient_share_invitations
       where patient_id = 'd2000000-0000-4000-8000-000000000001' and status = 'cancelled') <> 3
     or not exists (select 1 from identity.patient_share_invitations
                     where id = '96db0000-0000-4000-8000-000000000004' and status = 'pending') then
    raise exception 'Open share invitations were not cancelled exactly';
  end if;
  if not exists (select 1 from identity.consent_grants where id = '96dc0000-0000-4000-8000-000000000001'
                   and status = 'revoked' and revoked_reason = 'The patient login was deleted') then
    raise exception 'A grant from a patient share survived deletion';
  end if;
  if not exists (select 1 from identity.patient_contact_changes where id = '96dd0000-0000-4000-8000-000000000001'
                   and state = 'invalidated' and invalidation_reason = 'contact_unavailable' and new_ciphertext is null) then
    raise exception 'A pending contact change survived deletion';
  end if;
  if not exists (select 1 from identity.record_access_notices where id = '96de0000-0000-4000-8000-000000000001'
                   and email_status = 'suppressed' and safe_code = 'account_deleted')
     or not exists (select 1 from identity.record_access_notices where id = '96de0000-0000-4000-8000-000000000002'
                      and email_status = 'delivered') then
    raise exception 'Records-opened emails were not suppressed exactly';
  end if;
  select completion_summary into summary from identity.patient_account_deletion_requests
   where id = current_setting('hid.test.request_final')::uuid;
  if (summary->>'emergencyContactsDeactivated')::integer <> 1 or (summary->>'shareInvitationsCancelled')::integer <> 2
     or (summary->>'contactChangesInvalidated')::integer <> 1 or (summary->>'recordAccessEmailsSuppressed')::integer <> 1
     or (summary->>'patientGrantsRevoked')::integer <> 3 or (summary->>'sessionsRevoked')::integer <> 2 then
    raise exception 'The completion summary is wrong: %', summary;
  end if;
  if not exists (select 1 from identity.patient_account_deletion_notices
                  where request_id = current_setting('hid.test.request_final')::uuid and kind = 'completed'
                    and status = 'pending')
     or exists (select 1 from notification.inbox_items where account_id = 'd1000000-0000-4000-8000-000000000001'
                  and resource_id = current_setting('hid.test.request_final')::uuid
                  and notification_code <> 'ACCOUNT_DELETION_SCHEDULED') then
    raise exception 'The completed email row is missing, or the deleted login got a notice';
  end if;
  -- A deleted login's other columns may still change; only the terminal facts are guarded.
  update auth.accounts set display_name = 'Deleted One' where id = 'd1000000-0000-4000-8000-000000000001';
  begin
    update auth.accounts set token_version = 1 where id = 'd1000000-0000-4000-8000-000000000001';
    raise exception 'A deleted login''s token version went back';
  exception when object_not_in_prerequisite_state then null;
  end;
  -- Audit rows carry ids, codes and counts only: never an address or a token digest.
  if exists (select 1 from audit.events where action like 'identity.patient-account-deletion.%'
              and (details::text like '%@%' or details::text like '%' || encode(sha256('token-final'::bytea), 'hex') || '%')) then
    raise exception 'A deletion audit row carries an address or a token digest';
  end if;
end
$$;

-- Deleted login is unusable through every patient resolution path.
set local role hid_identity_runtime;
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

-- A legal hold placed during the waiting period blocks finalization.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:delete:2', true),
  set_config('app.correlation_id', 'patient-deletion-held-final-01', true);
do $$
declare requested record; confirmed record;
begin
  select * into requested from identity.request_my_account_deletion('synthetic:delete:2',
    'd3000000-0000-4000-8000-000000000002', encode(sha256('token-held-final'::bytea), 'hex'));
  select * into confirmed from identity.confirm_my_account_deletion('synthetic:delete:2',
    'd3000000-0000-4000-8000-000000000002', requested.request_id,
    encode(sha256('token-held-final'::bytea), 'hex'), 'DELETE MY ACCOUNT');
  if confirmed.outcome <> 'pending' then raise exception 'Held-finalization fixture was not scheduled: %', confirmed; end if;
  perform set_config('hid.test.request_held_final', requested.request_id::text, true);
end
$$;
reset role;
update identity.patient_account_deletion_requests
   set scheduled_for = clock_timestamp() - interval '1 second'
 where id = current_setting('hid.test.request_held_final')::uuid;
insert into platform.legal_holds (id, subject_type, subject_id, reason, reference) values
  ('dc000000-0000-4000-8000-000000000002', 'account', 'd1000000-0000-4000-8000-000000000002',
   'Synthetic hold placed during the waiting period', 'TEST-HOLD-2');
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'patient-deletion-held-final-02', true);
do $$
declare finalized record;
begin
  select * into finalized from identity.finalize_due_patient_account_deletions(10);
  if finalized.request_id is distinct from current_setting('hid.test.request_held_final')::uuid
     or finalized.outcome is distinct from 'blocked' then
    raise exception 'A hold placed during the waiting period did not block finalization: %', finalized;
  end if;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patient_account_deletion_requests
                  where id = current_setting('hid.test.request_held_final')::uuid
                    and state = 'blocked' and blocked_reason_code = 'LEGAL_HOLD')
     or not exists (select 1 from auth.accounts where id = 'd1000000-0000-4000-8000-000000000002' and status = 'active')
     or exists (select 1 from auth.sessions where account_id = 'd1000000-0000-4000-8000-000000000002'
                  and revoked_at is not null)
     or not exists (select 1 from audit.events where action = 'identity.patient-account-deletion.blocked'
                      and resource_id = current_setting('hid.test.request_held_final')
                      and details ->> 'stage' = 'finalization' and details ->> 'reasonCode' = 'LEGAL_HOLD') then
    raise exception 'Finalization under a legal hold changed the login or was not audited';
  end if;
end
$$;
update platform.legal_holds set released_at = clock_timestamp(), release_reason = 'Synthetic hold released'
 where id = 'dc000000-0000-4000-8000-000000000002';

-- A zero waiting period completes inside the confirmation transaction.
update platform.patient_account_deletion_settings set waiting_period = interval '0';
set local role hid_identity_runtime;
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

-- The deletion emails (0096): system:auth only; the recipient is the
-- verified account email whatever the account's status; a scheduled email
-- whose request is no longer pending, and any email without a verified
-- address, is not sent; the outcome is recorded under the lease.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:delete:admin', true),
  set_config('app.correlation_id', 'patient-deletion-notices-0001', true);
do $$
begin
  begin
    perform identity.claim_account_deletion_notices('deletion-test-worker', 10, 60);
    raise exception 'A patient context claimed deletion emails';
  exception when insufficient_privilege then null;
  end;
end
$$;
select set_config('app.actor_subject', 'system:auth', true);
create temporary table deletion_claimed on commit drop as
  select * from identity.claim_account_deletion_notices('deletion-test-worker', 50, 60);
do $$
begin
  begin
    perform identity.claim_account_deletion_notices('bad worker', 10, 60);
    raise exception 'An invalid worker claimed deletion emails';
  exception when invalid_parameter_value then null;
  end;
end
$$;
reset role;
do $$
declare claimed_count integer;
begin
  select count(*) into claimed_count from deletion_claimed;
  -- Leased: patient one's cancelled and completed emails (the deleted
  -- login's verified address, lowercased); the current admin has no email.
  if claimed_count <> 2
     or exists (select 1 from deletion_claimed where recipient <> 'delete-1@example.invalid' or attempt_count <> 1)
     or (select array_agg(kind order by kind) from deletion_claimed) <> array['cancelled', 'completed']
     or exists (select 1 from deletion_claimed where kind = 'scheduled') then
    raise exception 'Deletion emails were not claimed as 0096 defines: %',
      (select jsonb_agg(to_jsonb(claimed) - 'recipient') from deletion_claimed claimed);
  end if;
  -- Not sent: the scheduled emails whose request was cancelled or completed,
  -- and the former admin's emails (no verified address).
  if exists (select 1 from identity.patient_account_deletion_notices notice
              where notice.status = 'pending' and notice.lease_owner is null)
     or (select count(*) from identity.patient_account_deletion_notices
          where status = 'not_sent' and safe_code = 'request_closed') < 2
     or (select count(*) from identity.patient_account_deletion_notices
          where status = 'not_sent' and safe_code = 'no_recipient') < 2 then
    raise exception 'Unsendable deletion emails were not closed';
  end if;
end
$$;
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'patient-deletion-notices-0002', true);
do $$
declare cancelled_notice uuid; completed_notice uuid;
begin
  select notice_id into cancelled_notice from deletion_claimed where kind = 'cancelled';
  select notice_id into completed_notice from deletion_claimed where kind = 'completed';
  if identity.record_account_deletion_notice_outcome(cancelled_notice, 'deletion-test-worker', 'accepted', 'brevo', null)
       <> 'delivered'
     or identity.record_account_deletion_notice_outcome(completed_notice, 'deletion-test-worker', 'unknown', null,
          'provider_timeout') <> 'pending'
     or identity.record_account_deletion_notice_outcome(completed_notice, 'deletion-test-worker', 'accepted', null, null)
          <> 'stale_lease' then
    raise exception 'Deletion email outcomes were not recorded under the lease';
  end if;
  begin
    perform identity.record_account_deletion_notice_outcome(completed_notice, 'deletion-test-worker', 'sent', null, null);
    raise exception 'An unknown outcome was accepted';
  exception when invalid_parameter_value then null;
  end;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patient_account_deletion_notices where status = 'delivered' and provider = 'brevo')
     or not exists (select 1 from identity.patient_account_deletion_notices
                     where kind = 'completed' and status = 'pending' and next_attempt_at > clock_timestamp()
                       and lease_owner is null and safe_code = 'provider_timeout')
     or not exists (select 1 from audit.events where action = 'identity.patient-account-deletion.email.delivered'
                      and actor_type = 'system' and actor_subject is null)
     or exists (select 1 from audit.events where action like 'identity.patient-account-deletion.email.%'
                 and details::text like '%@%') then
    raise exception 'Deletion email outcomes or their audit are wrong';
  end if;
  begin
    delete from identity.patient_account_deletion_notices;
    raise exception 'Deletion email rows were deleted';
  exception when object_not_in_prerequisite_state then null;
  end;
end
$$;

rollback;
