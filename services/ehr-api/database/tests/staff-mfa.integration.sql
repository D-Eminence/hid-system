\set ON_ERROR_STOP on
-- Staff MFA (launch blocker MFA-1, decision D14, migration 0088). Rollback-only;
-- synthetic data only. Every command runs as hid_identity_api_runtime, the
-- role the Identity API uses, so a missing runtime grant fails here.
--
-- 1. A staff session family may hold MFA assurance, but only on a factor
--    that records a staff enrolment proof. A factor a platform first
--    enrolment created on the password alone never verifies a staff session
--    (it still verifies a platform one); a patient session never holds
--    assurance.
-- 2. Second-factor challenges carry their sign-in kind; a staff enrolment
--    challenge is consumed only once it records a verified fresh proof, and a
--    verified proof is final. The database records that the proof was
--    verified; it cannot check the emailed code itself, which Identity does.
-- 3. A factor records a staff enrolment proof only when it names a live
--    staff enrolment challenge of the same account whose proof of that method
--    is verified, and the record never changes.
-- 4. OTP password recovery (auth.complete_recovery_otp) ends every session
--    and leaves the account's factor and recovery codes as they are, so for
--    an account with a factor a mailbox alone never yields an MFA-verified
--    staff session. (An account without one enrols on a code sent to that
--    same mailbox: see INTERFACE_CONTRACT.md, staff sign-in.)
-- 5. The governed two-person MFA reset (0070) accepts a staff target: it
--    revokes the factor, the recovery codes and every staff session, and
--    changes the token version.
begin;

do $$ begin
  if exists (select 1 from auth.account_roles assignment
    where assignment.scope_type = 'platform' and assignment.revoked_at is null
      and assignment.role_code in ('platform_super_admin', 'platform_admin')) then
    raise exception 'staff-mfa suite requires a database with no existing platform Super Admin';
  end if;
end $$;

-- Accounts: d1 a doctor, d2 a patient, d3 and d4 two Super Admins (reset
-- requester and approver), d5 a nurse reset below, d6 a platform security
-- auditor who is also a doctor, d7 a nurse without a factor.
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm) values
  ('d8200000-0000-4000-8000-000000000001', 'synthetic:staff-mfa:doctor', 'doctor@staff-mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('d8200000-0000-4000-8000-000000000002', 'synthetic:staff-mfa:patient', 'patient@staff-mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('d8200000-0000-4000-8000-000000000003', 'synthetic:staff-mfa:super-one', 'one@staff-mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('d8200000-0000-4000-8000-000000000004', 'synthetic:staff-mfa:super-two', 'two@staff-mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('d8200000-0000-4000-8000-000000000005', 'synthetic:staff-mfa:nurse', 'nurse@staff-mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('d8200000-0000-4000-8000-000000000006', 'synthetic:staff-mfa:dual', 'dual@staff-mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('d8200000-0000-4000-8000-000000000007', 'synthetic:staff-mfa:new-nurse', 'new-nurse@staff-mfa.invalid', 'active', 'synthetic-hash', 'argon2id');
insert into identity.organizations (id, name, slug) values
  ('d8300000-0000-4000-8000-000000000001', 'Staff MFA Suite Organization', 'staff-mfa-suite');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('d8300000-0000-4000-8000-000000000002', 'd8300000-0000-4000-8000-000000000001', 'Staff MFA Suite Hospital',
   'SMFA-SUITE', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('d8400000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000001', 'Synthetic Doctor', 'doctor@staff-mfa.invalid', 'verified', 'doctor'),
  ('d8400000-0000-4000-8000-000000000005', 'd8200000-0000-4000-8000-000000000005', 'Synthetic Nurse', 'nurse@staff-mfa.invalid', 'verified', 'nurse'),
  ('d8400000-0000-4000-8000-000000000006', 'd8200000-0000-4000-8000-000000000006', 'Synthetic Dual', 'dual@staff-mfa.invalid', 'verified', 'doctor'),
  ('d8400000-0000-4000-8000-000000000007', 'd8200000-0000-4000-8000-000000000007', 'Synthetic New Nurse', 'new-nurse@staff-mfa.invalid', 'verified', 'nurse');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active) values
  ('d8500000-0000-4000-8000-000000000001', 'd8400000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000001',
   'd8300000-0000-4000-8000-000000000001', 'd8300000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true),
  ('d8500000-0000-4000-8000-000000000005', 'd8400000-0000-4000-8000-000000000005', 'd8200000-0000-4000-8000-000000000005',
   'd8300000-0000-4000-8000-000000000001', 'd8300000-0000-4000-8000-000000000002', 'nurse', 'nurse', true, true),
  ('d8500000-0000-4000-8000-000000000006', 'd8400000-0000-4000-8000-000000000006', 'd8200000-0000-4000-8000-000000000006',
   'd8300000-0000-4000-8000-000000000001', 'd8300000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true),
  ('d8500000-0000-4000-8000-000000000007', 'd8400000-0000-4000-8000-000000000007', 'd8200000-0000-4000-8000-000000000007',
   'd8300000-0000-4000-8000-000000000001', 'd8300000-0000-4000-8000-000000000002', 'nurse', 'nurse', true, true);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name) values
  ('d8600000-0000-4000-8000-000000000002', 'd8200000-0000-4000-8000-000000000002', 'HID-SMFAPTNT', 'Synthetic', 'Patient', 'Synthetic Patient');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d8700000-0000-4000-8000-000000000003', 'd8200000-0000-4000-8000-000000000003', 'platform_super_admin', 'platform', 'Synthetic staff MFA suite role'),
  ('d8700000-0000-4000-8000-000000000004', 'd8200000-0000-4000-8000-000000000004', 'platform_super_admin', 'platform', 'Synthetic staff MFA suite role'),
  ('d8700000-0000-4000-8000-000000000006', 'd8200000-0000-4000-8000-000000000006', 'security_auditor', 'platform', 'Synthetic staff MFA suite role');

-- The staff enrolment challenges d1 and d5 enrolled on: opened by provider
-- activation, so they carry a verified proof.
insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
    expires_at, max_attempts, session_kind, proof_method, proof_verified_at)
select ('d8b00000-0000-4000-8000-0000000000e' || suffix)::uuid, ('d8200000-0000-4000-8000-00000000000' || suffix)::uuid,
  'enroll', repeat(suffix, 63) || 'e', 1, clock_timestamp(), clock_timestamp() + interval '10 minutes', 5, 'staff',
  'provider_activation', clock_timestamp()
from unnest(array['1', '5']) as suffix;

-- Active factors: d1 and d5 enrolled by staff sign-in (each records its
-- proof); d3, d4 and d6 by platform sign-in (no staff proof). d2 (the patient)
-- and d7 have none.
insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, activated_at, last_used_step,
    enrollment_proof, enrollment_challenge_id)
select ('d8800000-0000-4000-8000-00000000000' || suffix)::uuid, ('d8200000-0000-4000-8000-00000000000' || suffix)::uuid,
  'active', gen_random_bytes(49), 'suite-v1', now(), 1,
  case when suffix in ('1', '5') then 'provider_activation' end,
  case when suffix in ('1', '5') then ('d8b00000-0000-4000-8000-0000000000e' || suffix)::uuid end
from unnest(array['1', '3', '4', '5', '6']) as suffix;
insert into auth.mfa_recovery_codes (id, account_id, factor_id, batch_id, code_hmac, key_version) values
  ('d8900000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000001', 'd8800000-0000-4000-8000-000000000001',
   'd8900000-0000-4000-8000-0000000000b1', repeat('1', 64), 'suite-v1'),
  ('d8900000-0000-4000-8000-000000000002', 'd8200000-0000-4000-8000-000000000001', 'd8800000-0000-4000-8000-000000000001',
   'd8900000-0000-4000-8000-0000000000b1', repeat('2', 64), 'suite-v1'),
  ('d8900000-0000-4000-8000-000000000005', 'd8200000-0000-4000-8000-000000000005', 'd8800000-0000-4000-8000-000000000005',
   'd8900000-0000-4000-8000-0000000000b5', repeat('5', 64), 'suite-v1');

-- Sessions: staff sessions of d1 (a1, a2), d5 (a5), d6 (a6) and d7 (a7), a
-- patient session of d2 (a3), platform sessions of the two Super Admins (b3,
-- b4) and of d6 (b6).
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('d8a00000-0000-4000-8000-0000000000a1', 'd8200000-0000-4000-8000-000000000001', 'd8a00000-0000-4000-8000-0000000000a1',
   repeat('a', 64), gen_random_uuid(), 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours', 'staff', null),
  ('d8a00000-0000-4000-8000-0000000000a2', 'd8200000-0000-4000-8000-000000000001', 'd8a00000-0000-4000-8000-0000000000a2',
   repeat('b', 64), gen_random_uuid(), 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours', 'staff', null),
  ('d8a00000-0000-4000-8000-0000000000a3', 'd8200000-0000-4000-8000-000000000002', 'd8a00000-0000-4000-8000-0000000000a3',
   repeat('c', 64), gen_random_uuid(), 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours', 'patient',
   'd8600000-0000-4000-8000-000000000002'),
  ('d8a00000-0000-4000-8000-0000000000a5', 'd8200000-0000-4000-8000-000000000005', 'd8a00000-0000-4000-8000-0000000000a5',
   repeat('d', 64), gen_random_uuid(), 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours', 'staff', null),
  ('d8a00000-0000-4000-8000-0000000000b3', 'd8200000-0000-4000-8000-000000000003', 'd8a00000-0000-4000-8000-0000000000b3',
   repeat('e', 64), gen_random_uuid(), 1, 'password', now(), now() + interval '15 minutes', now() + interval '8 hours', 'platform', null),
  ('d8a00000-0000-4000-8000-0000000000b4', 'd8200000-0000-4000-8000-000000000004', 'd8a00000-0000-4000-8000-0000000000b4',
   repeat('f', 64), gen_random_uuid(), 1, 'password', now(), now() + interval '15 minutes', now() + interval '8 hours', 'platform', null),
  ('d8a00000-0000-4000-8000-0000000000a6', 'd8200000-0000-4000-8000-000000000006', 'd8a00000-0000-4000-8000-0000000000a6',
   repeat('0', 63) || '6', gen_random_uuid(), 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours', 'staff', null),
  ('d8a00000-0000-4000-8000-0000000000b6', 'd8200000-0000-4000-8000-000000000006', 'd8a00000-0000-4000-8000-0000000000b6',
   repeat('1', 63) || '6', gen_random_uuid(), 1, 'password', now(), now() + interval '15 minutes', now() + interval '8 hours', 'platform', null),
  ('d8a00000-0000-4000-8000-0000000000a7', 'd8200000-0000-4000-8000-000000000007', 'd8a00000-0000-4000-8000-0000000000a7',
   repeat('2', 63) || '7', gen_random_uuid(), 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours', 'staff', null);

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
select set_config('app.correlation_id', 'staff-mfa-suite-0001', true);

-- 1. Session assurance: a staff session family may hold it on a factor with a
-- staff proof (0088); a patient session, an inactive factor or a factor
-- enrolled without a staff proof never.
insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at) values
  ('d8a00000-0000-4000-8000-0000000000a1', 'd8200000-0000-4000-8000-000000000001',
   'd8800000-0000-4000-8000-000000000001', 'totp', clock_timestamp()),
  ('d8a00000-0000-4000-8000-0000000000a5', 'd8200000-0000-4000-8000-000000000005',
   'd8800000-0000-4000-8000-000000000005', 'recovery_code', clock_timestamp()),
  ('d8a00000-0000-4000-8000-0000000000b3', 'd8200000-0000-4000-8000-000000000003',
   'd8800000-0000-4000-8000-000000000003', 'totp', clock_timestamp()),
  ('d8a00000-0000-4000-8000-0000000000b4', 'd8200000-0000-4000-8000-000000000004',
   'd8800000-0000-4000-8000-000000000004', 'totp', clock_timestamp());
do $$ begin
  begin
    insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
    values ('d8a00000-0000-4000-8000-0000000000a3', 'd8200000-0000-4000-8000-000000000002',
      'd8800000-0000-4000-8000-000000000001', 'totp', clock_timestamp());
    raise exception 'a patient session received MFA assurance';
  exception when check_violation then
    if sqlerrm <> 'SESSION_ASSURANCE_INVALID' then raise; end if;
  end;
  -- Another account's factor never verifies a staff session.
  begin
    insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
    values ('d8a00000-0000-4000-8000-0000000000a2', 'd8200000-0000-4000-8000-000000000001',
      'd8800000-0000-4000-8000-000000000005', 'totp', clock_timestamp());
    raise exception 'a staff session was verified by another account''s factor';
  exception when check_violation or foreign_key_violation then null;
  end;
  -- A staff session with step-up evidence at issue is refused, as a platform one is.
  begin
    insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at, step_up_at)
    values ('d8a00000-0000-4000-8000-0000000000a2', 'd8200000-0000-4000-8000-000000000001',
      'd8800000-0000-4000-8000-000000000001', 'totp', clock_timestamp(), clock_timestamp());
    raise exception 'a staff assurance row was born stepped up';
  exception when check_violation then
    if sqlerrm <> 'SESSION_ASSURANCE_INVALID' then raise; end if;
  end;
  -- A factor enrolled by platform sign-in, on the password alone, never
  -- verifies a staff session of its account, which holds an eligible staff
  -- membership; it still verifies the platform session.
  begin
    insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
    values ('d8a00000-0000-4000-8000-0000000000a6', 'd8200000-0000-4000-8000-000000000006',
      'd8800000-0000-4000-8000-000000000006', 'totp', clock_timestamp());
    raise exception 'a factor enrolled without a staff proof verified a staff session';
  exception when check_violation then
    if sqlerrm <> 'STAFF_MFA_FACTOR_UNPROVEN' then raise; end if;
  end;
  insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
  values ('d8a00000-0000-4000-8000-0000000000b6', 'd8200000-0000-4000-8000-000000000006',
    'd8800000-0000-4000-8000-000000000006', 'totp', clock_timestamp());
  -- Staff assurance is evidence of this session family only: it is never step-up evidence.
  perform set_config('app.actor_subject', 'synthetic:staff-mfa:doctor', true);
  perform set_config('app.session_id', 'd8a00000-0000-4000-8000-0000000000a1', true);
  if auth.platform_step_up_is_fresh('d8200000-0000-4000-8000-000000000001') then
    raise exception 'a staff session satisfied platform step-up';
  end if;
  perform set_config('app.session_id', '', true);
  perform set_config('app.actor_subject', 'system:auth', true);
end $$;

-- 2. Second-factor challenges of each kind.
insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
    expires_at, max_attempts) values
  ('d8b00000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000003', 'verify', repeat('1', 64), 1,
   clock_timestamp(), clock_timestamp() + interval '5 minutes', 5);
insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
    expires_at, max_attempts, session_kind) values
  ('d8b00000-0000-4000-8000-000000000002', 'd8200000-0000-4000-8000-000000000005', 'enroll', repeat('2', 64), 1,
   clock_timestamp(), clock_timestamp() + interval '10 minutes', 5, 'staff'),
  ('d8b00000-0000-4000-8000-000000000003', 'd8200000-0000-4000-8000-000000000001', 'verify', repeat('3', 64), 1,
   clock_timestamp(), clock_timestamp() + interval '5 minutes', 5, 'staff');
insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
    expires_at, max_attempts, session_kind, proof_method, proof_verified_at) values
  ('d8b00000-0000-4000-8000-000000000004', 'd8200000-0000-4000-8000-000000000005', 'enroll', repeat('4', 64), 1,
   clock_timestamp(), clock_timestamp() + interval '10 minutes', 5, 'staff', 'provider_activation', clock_timestamp());
do $$
declare
  rejected text;
begin
  -- Existing and older-build rows are platform challenges.
  if (select session_kind from auth.mfa_login_challenges where id = 'd8b00000-0000-4000-8000-000000000001') <> 'platform' then
    raise exception 'a challenge without a kind is not a platform challenge';
  end if;
  foreach rejected in array array['kind', 'platform-proof', 'verify-proof', 'unsent-code', 'activation-unverified',
    'activation-with-code', 'bad-digest'] loop
    begin
      insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
          expires_at, max_attempts, session_kind, proof_method, proof_verifier_hmac, proof_key_version, proof_sent_at,
          proof_verified_at)
      values (gen_random_uuid(), 'd8200000-0000-4000-8000-000000000001',
        case when rejected = 'verify-proof' then 'verify' else 'enroll' end,
        md5(rejected) || md5(rejected || 'x'), 1, clock_timestamp(), clock_timestamp() + interval '10 minutes', 5,
        case rejected when 'kind' then 'patient' when 'platform-proof' then 'platform' else 'staff' end,
        case when rejected like 'activation%' then 'provider_activation' when rejected = 'kind' then null
          else 'email_code' end,
        case when rejected in ('unsent-code') then null when rejected = 'bad-digest' then repeat('Z', 64)
          when rejected = 'activation-unverified' or rejected = 'kind' then null else repeat('a', 64) end,
        case when rejected in ('unsent-code', 'activation-unverified', 'kind') then null else 'suite-v1' end,
        case when rejected in ('unsent-code', 'activation-unverified', 'kind') then null else clock_timestamp() end,
        case when rejected = 'activation-with-code' then clock_timestamp() else null end);
      raise exception 'challenge shape % was accepted', rejected;
    exception when check_violation then null;
    end;
  end loop;

  -- A staff enrolment challenge is never consumed on the password alone.
  begin
    update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
    where id = 'd8b00000-0000-4000-8000-000000000002';
    raise exception 'a staff enrolment was completed without a proof';
  exception when check_violation then
    if sqlerrm <> 'MFA_ENROLLMENT_PROOF_REQUIRED' then raise; end if;
  end;
  -- The code is sent: still not consumable until it is verified.
  update auth.mfa_login_challenges set proof_method = 'email_code', proof_verifier_hmac = repeat('a', 64),
      proof_key_version = 'suite-v1', proof_sent_at = clock_timestamp(), row_version = row_version + 1
  where id = 'd8b00000-0000-4000-8000-000000000002';
  begin
    update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
    where id = 'd8b00000-0000-4000-8000-000000000002';
    raise exception 'a staff enrolment was completed with an unverified code';
  exception when check_violation then
    if sqlerrm <> 'MFA_ENROLLMENT_PROOF_REQUIRED' then raise; end if;
  end;
  -- A resend replaces an unverified code.
  update auth.mfa_login_challenges set proof_verifier_hmac = repeat('b', 64), proof_sent_at = clock_timestamp(),
      row_version = row_version + 1
  where id = 'd8b00000-0000-4000-8000-000000000002';
  update auth.mfa_login_challenges set proof_verified_at = clock_timestamp(), row_version = row_version + 1
  where id = 'd8b00000-0000-4000-8000-000000000002';
  -- A verified proof is final: neither replaced, unset nor moved to another kind.
  foreach rejected in array array['replace', 'unset', 'method', 'kind'] loop
    begin
      update auth.mfa_login_challenges
        set proof_verifier_hmac = case when rejected = 'replace' then repeat('c', 64) else proof_verifier_hmac end,
            proof_verified_at = case when rejected = 'unset' then null else proof_verified_at end,
            proof_method = case when rejected = 'method' then 'provider_activation' else proof_method end,
            session_kind = case when rejected = 'kind' then 'platform' else session_kind end,
            row_version = row_version + 1
      where id = 'd8b00000-0000-4000-8000-000000000002';
      raise exception 'a verified enrolment proof changed (%)', rejected;
    exception when object_not_in_prerequisite_state or check_violation then null;
    end;
  end loop;
  update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
  where id = 'd8b00000-0000-4000-8000-000000000002';
  -- An enrolment opened by provider activation carries its proof.
  update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
  where id = 'd8b00000-0000-4000-8000-000000000004';
  -- A staff verify challenge needs no proof; its kind cannot change.
  begin
    update auth.mfa_login_challenges set session_kind = 'platform', row_version = row_version + 1
    where id = 'd8b00000-0000-4000-8000-000000000003';
    raise exception 'a staff challenge became a platform challenge';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'MFA_CHALLENGE_IMMUTABLE' then raise; end if;
  end;
  update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
  where id = 'd8b00000-0000-4000-8000-000000000003';
end $$;

-- 3. A factor's staff proof names a live staff enrolment challenge of its own
-- account whose proof of that method is verified, and never changes. f1 is
-- proven by an emailed code; f2's code was sent but not verified; f3 is a
-- platform enrolment; f4 was proven and then consumed.
insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
    expires_at, max_attempts, session_kind, proof_method, proof_verifier_hmac, proof_key_version, proof_sent_at,
    proof_verified_at) values
  ('d8b00000-0000-4000-8000-0000000000f1', 'd8200000-0000-4000-8000-000000000007', 'enroll', repeat('5', 64), 1,
   clock_timestamp(), clock_timestamp() + interval '10 minutes', 5, 'staff', 'email_code', repeat('a', 64), 'suite-v1',
   now(), clock_timestamp()),
  ('d8b00000-0000-4000-8000-0000000000f2', 'd8200000-0000-4000-8000-000000000007', 'enroll', repeat('6', 64), 1,
   clock_timestamp(), clock_timestamp() + interval '10 minutes', 5, 'staff', 'email_code', repeat('b', 64), 'suite-v1',
   now(), null),
  ('d8b00000-0000-4000-8000-0000000000f3', 'd8200000-0000-4000-8000-000000000007', 'enroll', repeat('7', 64), 1,
   clock_timestamp(), clock_timestamp() + interval '10 minutes', 5, 'platform', null, null, null, null, null),
  ('d8b00000-0000-4000-8000-0000000000f4', 'd8200000-0000-4000-8000-000000000007', 'enroll', repeat('8', 64), 1,
   clock_timestamp(), clock_timestamp() + interval '10 minutes', 5, 'staff', 'email_code', repeat('c', 64), 'suite-v1',
   now(), clock_timestamp());
update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
where id = 'd8b00000-0000-4000-8000-0000000000f4';
do $$
declare
  shape text;
begin
  foreach shape in array array['unverified', 'platform', 'other-account', 'method', 'consumed', 'missing'] loop
    begin
      insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, enrollment_expires_at,
          enrollment_proof, enrollment_challenge_id)
      values (gen_random_uuid(), 'd8200000-0000-4000-8000-000000000007', 'pending', gen_random_bytes(49), 'suite-v1',
        clock_timestamp() + interval '5 minutes',
        case when shape in ('method', 'other-account') then 'provider_activation' else 'email_code' end,
        case shape when 'unverified' then 'd8b00000-0000-4000-8000-0000000000f2'::uuid
          when 'platform' then 'd8b00000-0000-4000-8000-0000000000f3'::uuid
          when 'other-account' then 'd8b00000-0000-4000-8000-0000000000e1'::uuid
          when 'method' then 'd8b00000-0000-4000-8000-0000000000f1'::uuid
          when 'consumed' then 'd8b00000-0000-4000-8000-0000000000f4'::uuid
          else gen_random_uuid() end);
      raise exception 'a factor recorded a staff proof it does not have (%)', shape;
    exception when check_violation then
      if sqlerrm <> 'MFA_ENROLLMENT_PROOF_REQUIRED' then raise; end if;
    end;
  end loop;
  -- A proof without its challenge, a challenge without its proof, or an
  -- unknown method is refused by the row's own check.
  foreach shape in array array['no-challenge', 'no-proof', 'unknown-method'] loop
    begin
      insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, enrollment_expires_at,
          enrollment_proof, enrollment_challenge_id)
      values (gen_random_uuid(), 'd8200000-0000-4000-8000-000000000007', 'pending', gen_random_bytes(49), 'suite-v1',
        clock_timestamp() + interval '5 minutes',
        case shape when 'no-proof' then null when 'unknown-method' then 'password' else 'email_code' end,
        case when shape = 'no-challenge' then null else 'd8b00000-0000-4000-8000-0000000000f1'::uuid end);
      raise exception 'a factor with an inconsistent staff proof was accepted (%)', shape;
    exception when check_violation then null;
    end;
  end loop;
  -- The proven challenge f1: accepted, and the record is then final.
  insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, enrollment_expires_at,
      enrollment_proof, enrollment_challenge_id)
  values ('d8800000-0000-4000-8000-000000000007', 'd8200000-0000-4000-8000-000000000007', 'pending',
    gen_random_bytes(49), 'suite-v1', clock_timestamp() + interval '5 minutes', 'email_code',
    'd8b00000-0000-4000-8000-0000000000f1');
  foreach shape in array array['unset', 'other-challenge', 'other-method'] loop
    begin
      update auth.mfa_factors
        set enrollment_proof = case shape when 'unset' then null when 'other-method' then 'provider_activation'
              else enrollment_proof end,
            enrollment_challenge_id = case shape when 'unset' then null
              when 'other-challenge' then 'd8b00000-0000-4000-8000-0000000000f4'::uuid else enrollment_challenge_id end,
            row_version = row_version + 1
      where id = 'd8800000-0000-4000-8000-000000000007';
      raise exception 'a factor''s staff proof changed (%)', shape;
    exception when object_not_in_prerequisite_state then
      if sqlerrm <> 'MFA_FACTOR_IMMUTABLE' then raise; end if;
    end;
  end loop;
  -- Activated, it keeps its proof and verifies the account's staff session.
  update auth.mfa_factors set status = 'active', activated_at = clock_timestamp(), last_used_step = 1,
      row_version = row_version + 1
  where id = 'd8800000-0000-4000-8000-000000000007';
  update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
  where id = 'd8b00000-0000-4000-8000-0000000000f1';
  insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
  values ('d8a00000-0000-4000-8000-0000000000a7', 'd8200000-0000-4000-8000-000000000007',
    'd8800000-0000-4000-8000-000000000007', 'totp', clock_timestamp());
  if (select enrollment_proof from auth.mfa_factors where id = 'd8800000-0000-4000-8000-000000000007') <> 'email_code' then
    raise exception 'activation changed the factor''s staff proof';
  end if;
end $$;

-- 4. OTP recovery of the doctor's password keeps the factor and recovery codes
-- (the second factor survives a mailbox) and ends every session.
insert into auth.otp_challenges (id, account_id, recipient_hmac, purpose, channel, verifier_hmac, verifier_key_version,
    expires_at, max_attempts, verified_at, completion_token_hmac, completion_expires_at, account_token_version) values
  ('d8c00000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000001', repeat('9', 64), 'PASSWORD_RESET',
   'email', repeat('8', 64), 'synthetic', clock_timestamp() + interval '5 minutes', 5, clock_timestamp(),
   repeat('7', 64), clock_timestamp() + interval '5 minutes', 1);
do $$
declare
  factor_before auth.mfa_factors%rowtype;
begin
  select * into factor_before from auth.mfa_factors where id = 'd8800000-0000-4000-8000-000000000001';
  if not auth.complete_recovery_otp('d8c00000-0000-4000-8000-000000000001', 'PASSWORD_RESET', repeat('7', 64),
      '$argon2id$v=19$m=65536,t=3,p=1$synthetic-salt$synthetic-password-digest-not-an-operational-secret') then
    raise exception 'the staff OTP recovery did not complete';
  end if;
  if (select to_jsonb(factor) from auth.mfa_factors factor where factor.id = factor_before.id)
       is distinct from to_jsonb(factor_before) then
    raise exception 'OTP recovery changed the staff MFA factor';
  end if;
  if (select count(*) from auth.mfa_recovery_codes
        where account_id = 'd8200000-0000-4000-8000-000000000001' and used_at is null and invalidated_at is null) <> 2 then
    raise exception 'OTP recovery used or invalidated the staff recovery codes';
  end if;
  if exists (select 1 from auth.sessions where account_id = 'd8200000-0000-4000-8000-000000000001' and revoked_at is null)
     or (select token_version from auth.accounts where id = 'd8200000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'OTP recovery did not end the staff sessions';
  end if;
  -- The ended session's assurance cannot carry over: a new sign-in needs the factor again.
  if not auth.account_has_active_mfa('d8200000-0000-4000-8000-000000000001') then
    raise exception 'the recovered staff account lost its second factor';
  end if;
end $$;

-- 5. Governed MFA reset of a staff target (0070): requested by one Super
-- Admin, approved by another, each with a fresh step-up.
update auth.session_assurance set step_up_at = clock_timestamp(), step_up_count = step_up_count + 1,
    row_version = row_version + 1
where family_id in ('d8a00000-0000-4000-8000-0000000000b3', 'd8a00000-0000-4000-8000-0000000000b4');
select set_config('app.actor_subject', 'synthetic:staff-mfa:super-one', true);
select set_config('app.session_id', 'd8a00000-0000-4000-8000-0000000000b3', true);
do $$
declare
  requested record;
begin
  select * into requested from auth.admin_request_approval('mfa.reset', 'd8200000-0000-4000-8000-000000000005', null,
    'Nurse lost their authenticator phone', 'staff-mfa-reset-0001', repeat('1', 64)::character(64));
  perform set_config('suite.reset', requested.request_id::text, true);
  perform set_config('suite.reset_version', requested.row_version::text, true);
end $$;
select set_config('app.actor_subject', 'synthetic:staff-mfa:super-two', true);
select set_config('app.session_id', 'd8a00000-0000-4000-8000-0000000000b4', true);
do $$
declare
  decided record;
begin
  select * into decided from auth.admin_decide_approval(current_setting('suite.reset')::uuid,
    current_setting('suite.reset_version')::bigint, 'approve', 'Identity confirmed in person by the facility',
    'staff-mfa-decide-0001', repeat('2', 64)::character(64));
  if decided.request_status <> 'approved' or not decided.executed then
    raise exception 'the approved staff MFA reset did not execute';
  end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from auth.mfa_factors where account_id = 'd8200000-0000-4000-8000-000000000005' and status <> 'revoked')
     or (select revocation_reason from auth.mfa_factors where id = 'd8800000-0000-4000-8000-000000000005') <> 'admin_reset'
     or exists (select 1 from auth.mfa_recovery_codes where account_id = 'd8200000-0000-4000-8000-000000000005'
       and used_at is null and invalidated_at is null)
     or (select revocation_reason from auth.sessions where id = 'd8a00000-0000-4000-8000-0000000000a5') <> 'mfa_reset'
     or (select token_version from auth.accounts where id = 'd8200000-0000-4000-8000-000000000005') <> 2
     or not exists (select 1 from auth.session_events where account_id = 'd8200000-0000-4000-8000-000000000005'
       and event_type = 'mfa_reset') then
    raise exception 'the staff MFA reset did not revoke the factor, recovery codes and staff sessions';
  end if;
  -- The staff session's assurance names a factor that is no longer active, so
  -- no assurance of the account is live any more.
  if exists (select 1 from auth.session_assurance assurance
      join auth.mfa_factors factor on factor.id = assurance.mfa_factor_id and factor.status = 'active'
      where assurance.account_id = 'd8200000-0000-4000-8000-000000000005') then
    raise exception 'a reset staff factor still verifies a session family';
  end if;
  if (select description from auth.permissions where code = 'platform.mfa.reset') not like '%staff%' then
    raise exception 'platform.mfa.reset does not describe staff targets';
  end if;
end $$;

rollback;
