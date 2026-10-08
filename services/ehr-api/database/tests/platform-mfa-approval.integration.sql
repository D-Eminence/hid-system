\set ON_ERROR_STOP on
-- Platform MFA, platform sessions and step-up (0069) and two-person approval
-- with platform-session reachability (0070). Rollback-only; requires a
-- synthetic database with no other platform Super Admin.
begin;

do $$ begin
  if exists (select 1 from auth.account_roles assignment
    where assignment.scope_type = 'platform' and assignment.revoked_at is null
      and assignment.role_code in ('platform_super_admin', 'platform_admin')) then
    raise exception 'platform-mfa-approval suite requires a database with no existing platform Super Admin';
  end if;
end $$;

-- Accounts. None has a staff membership: platform administration no longer
-- depends on one. 'nomfa' is a Super Admin without an MFA factor; 'legacy'
-- holds the legacy platform_admin role but has no password (unreachable).
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm) values
  ('c7200000-0000-4000-8000-000000000001', 'synthetic:mfa:super-one', 'one@mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7200000-0000-4000-8000-000000000002', 'synthetic:mfa:super-two', 'two@mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7200000-0000-4000-8000-000000000003', 'synthetic:mfa:nomfa', 'nomfa@mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7200000-0000-4000-8000-000000000004', 'synthetic:mfa:operations', 'ops@mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7200000-0000-4000-8000-000000000005', 'synthetic:mfa:target', 'target@mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7200000-0000-4000-8000-000000000006', 'synthetic:mfa:support', 'support@mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7200000-0000-4000-8000-000000000007', 'synthetic:mfa:auditor', 'auditor@mfa.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7200000-0000-4000-8000-000000000008', 'synthetic:mfa:legacy', 'legacy@mfa.invalid', 'active', null, null),
  ('c7200000-0000-4000-8000-000000000009', 'synthetic:mfa:disabled', 'disabled@mfa.invalid', 'disabled', 'synthetic-hash', 'argon2id');

insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c7300000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform', 'Synthetic MFA suite role'),
  ('c7300000-0000-4000-8000-000000000002', 'c7200000-0000-4000-8000-000000000002', 'platform_super_admin', 'platform', 'Synthetic MFA suite role'),
  ('c7300000-0000-4000-8000-000000000003', 'c7200000-0000-4000-8000-000000000003', 'platform_super_admin', 'platform', 'Synthetic MFA suite role'),
  ('c7300000-0000-4000-8000-000000000004', 'c7200000-0000-4000-8000-000000000004', 'platform_operations_admin', 'platform', 'Synthetic MFA suite role'),
  ('c7300000-0000-4000-8000-000000000006', 'c7200000-0000-4000-8000-000000000006', 'support_admin', 'platform', 'Synthetic MFA suite role'),
  ('c7300000-0000-4000-8000-000000000007', 'c7200000-0000-4000-8000-000000000007', 'security_auditor', 'platform', 'Synthetic MFA suite role'),
  ('c7300000-0000-4000-8000-000000000008', 'c7200000-0000-4000-8000-000000000008', 'platform_admin', 'platform', 'Synthetic MFA suite role');

-- Active TOTP factors (ciphertext is opaque to the database).
insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version,
    activated_at, last_used_step) values
  ('c7400000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000001', 'active', gen_random_bytes(49), 'suite-v1', now(), 1),
  ('c7400000-0000-4000-8000-000000000002', 'c7200000-0000-4000-8000-000000000002', 'active', gen_random_bytes(49), 'suite-v1', now(), 1),
  ('c7400000-0000-4000-8000-000000000004', 'c7200000-0000-4000-8000-000000000004', 'active', gen_random_bytes(49), 'suite-v1', now(), 1),
  ('c7400000-0000-4000-8000-000000000006', 'c7200000-0000-4000-8000-000000000006', 'active', gen_random_bytes(49), 'suite-v1', now(), 1),
  ('c7400000-0000-4000-8000-000000000007', 'c7200000-0000-4000-8000-000000000007', 'active', gen_random_bytes(49), 'suite-v1', now(), 1);

insert into auth.mfa_recovery_codes (id, account_id, factor_id, batch_id, code_hmac, key_version) values
  ('c7500000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000007',
   'c7400000-0000-4000-8000-000000000007', 'c7500000-0000-4000-8000-0000000000b1', repeat('a', 64), 'suite-v1'),
  ('c7500000-0000-4000-8000-000000000002', 'c7200000-0000-4000-8000-000000000007',
   'c7400000-0000-4000-8000-000000000007', 'c7500000-0000-4000-8000-0000000000b1', repeat('b', 64), 'suite-v1');

-- Platform sessions (one per administrator) and one staff session.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti,
    account_token_version, authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
select ('c7600000-0000-4000-8000-00000000000' || suffix)::uuid, ('c7200000-0000-4000-8000-00000000000' || suffix)::uuid,
  ('c7600000-0000-4000-8000-00000000000' || suffix)::uuid, repeat(suffix, 64), gen_random_uuid(), 1, 'password',
  now(), now() + interval '15 minutes', now() + interval '8 hours', 'platform'
from unnest(array['1', '2', '4', '6', '7']) as suffix;
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti,
    account_token_version, authentication_method, issued_at, expires_at, absolute_expires_at, session_kind) values
  ('c7600000-0000-4000-8000-0000000000a1', 'c7200000-0000-4000-8000-000000000001',
   'c7600000-0000-4000-8000-0000000000a1', repeat('e', 64), gen_random_uuid(), 1, 'password',
   now(), now() + interval '8 hours', now() + interval '24 hours', 'staff'),
  ('c7600000-0000-4000-8000-0000000000a5', 'c7200000-0000-4000-8000-000000000005',
   'c7600000-0000-4000-8000-0000000000a5', repeat('f', 64), gen_random_uuid(), 1, 'password',
   now(), now() + interval '8 hours', now() + interval '24 hours', 'staff');

insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
select ('c7600000-0000-4000-8000-00000000000' || suffix)::uuid, ('c7200000-0000-4000-8000-00000000000' || suffix)::uuid,
  ('c7400000-0000-4000-8000-00000000000' || suffix)::uuid, 'totp', now() - interval '1 hour'
from unnest(array['1', '2', '4', '6', '7']) as suffix;

-- 1. Platform session shape and lifetime ceilings.
do $$
declare
  rejected text;
begin
  foreach rejected in array array['idle', 'absolute', 'oidc', 'kind'] loop
    begin
      insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti,
          account_token_version, authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
      values (gen_random_uuid(), 'c7200000-0000-4000-8000-000000000001', gen_random_uuid(),
        md5(rejected) || md5(rejected || 'x'), gen_random_uuid(), 1,
        case when rejected = 'oidc' then 'oidc' else 'password' end, now(),
        now() + case when rejected = 'idle' then interval '16 minutes' else interval '15 minutes' end,
        now() + case when rejected = 'absolute' then interval '9 hours' else interval '8 hours' end,
        case when rejected = 'kind' then 'administrator' else 'platform' end);
      raise exception 'platform session ceiling % was not enforced', rejected;
    exception when check_violation then null;
    end;
  end loop;
end $$;

-- 2. New session event types, rate-limit scopes and assurance methods.
insert into auth.session_events (account_id, event_type, outcome, correlation_id)
select 'c7200000-0000-4000-8000-000000000001', event_type, 'success', 'mfa-suite-events-0001'
from unnest(array['mfa_challenge_issued', 'mfa_verified', 'mfa_failed', 'mfa_enrollment_started',
  'mfa_enrolled', 'mfa_recovery_code_used', 'mfa_recovery_codes_regenerated', 'mfa_reset',
  'step_up_verified', 'step_up_failed', 'mfa_rate_limited']) as event_type;
insert into auth.otp_rate_limits (scope, bucket_hmac, window_started_at, request_count)
select scope, repeat('c', 64), now(), 1
from unnest(array['mfa_failure_account', 'mfa_failure_ip', 'mfa_request_account']) as scope;
do $$ begin
  begin
    insert into auth.session_events (account_id, event_type, outcome, correlation_id)
    values ('c7200000-0000-4000-8000-000000000001', 'email_otp_mfa', 'success', 'mfa-suite-events-0002');
    raise exception 'an unknown session event type was accepted';
  exception when check_violation then null;
  end;
  -- Email OTP never counts as administrator MFA.
  begin
    update auth.session_assurance set mfa_method = 'email_otp'
    where family_id = 'c7600000-0000-4000-8000-000000000001';
    raise exception 'email OTP was accepted as an MFA method';
  exception when check_violation or object_not_in_prerequisite_state then null;
  end;
  begin
    insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
    values ('c7600000-0000-4000-8000-0000000000a1', 'c7200000-0000-4000-8000-000000000001',
      'c7400000-0000-4000-8000-000000000001', 'totp', now());
    raise exception 'a staff session received platform assurance';
  exception when check_violation then
    if sqlerrm <> 'SESSION_ASSURANCE_INVALID' then raise; end if;
  end;
end $$;

-- 3. Factor invariants.
do $$ begin
  begin
    insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version,
      activated_at, last_used_step)
    values (gen_random_uuid(), 'c7200000-0000-4000-8000-000000000001', 'active', gen_random_bytes(49),
      'suite-v1', now(), 1);
    raise exception 'a second active factor was accepted';
  exception when unique_violation then null;
  end;
  begin
    update auth.mfa_factors set secret_ciphertext = gen_random_bytes(49)
    where id = 'c7400000-0000-4000-8000-000000000001';
    raise exception 'an active factor secret was replaced';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'MFA_FACTOR_IMMUTABLE' then raise; end if;
  end;
  begin
    update auth.mfa_factors set last_used_step = 0
    where id = 'c7400000-0000-4000-8000-000000000001';
    raise exception 'a used time step was rolled back';
  exception when check_violation then null;
  end;
  update auth.mfa_factors set last_used_step = 100, row_version = row_version + 1
  where id = 'c7400000-0000-4000-8000-000000000001';
  begin
    update auth.mfa_factors set last_used_step = 99
    where id = 'c7400000-0000-4000-8000-000000000001';
    raise exception 'a used time step was rolled back';
  exception when check_violation then
    if sqlerrm <> 'MFA_FACTOR_STEP_REGRESSION' then raise; end if;
  end;
  begin
    update auth.mfa_factors set status = 'revoked', revoked_at = clock_timestamp(),
      revocation_reason = 'enrollment_replaced'
    where id = 'c7400000-0000-4000-8000-000000000001';
    raise exception 'an active factor was revoked outside the governed reset';
  exception when check_violation then
    if sqlerrm <> 'MFA_FACTOR_INVALID_TRANSITION' then raise; end if;
  end;
  begin
    delete from auth.mfa_factors where id = 'c7400000-0000-4000-8000-000000000001';
    raise exception 'a factor was deleted';
  exception when object_not_in_prerequisite_state then null;
  end;
  -- An expired pending enrollment cannot be activated.
  insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version,
    created_at, enrollment_expires_at)
  values ('c7400000-0000-4000-8000-000000000003', 'c7200000-0000-4000-8000-000000000003', 'pending',
    gen_random_bytes(49), 'suite-v1', now() - interval '20 minutes', now() - interval '11 minutes');
  begin
    update auth.mfa_factors set status = 'active', activated_at = clock_timestamp(), last_used_step = 5
    where id = 'c7400000-0000-4000-8000-000000000003';
    raise exception 'an expired enrollment was activated';
  exception when check_violation then
    if sqlerrm <> 'MFA_ENROLLMENT_EXPIRED' then raise; end if;
  end;
  update auth.mfa_factors set status = 'revoked', revoked_at = clock_timestamp(),
    revocation_reason = 'enrollment_expired'
  where id = 'c7400000-0000-4000-8000-000000000003';
  begin
    update auth.mfa_factors set last_used_at = clock_timestamp()
    where id = 'c7400000-0000-4000-8000-000000000003';
    raise exception 'a revoked factor changed';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;

-- 4. Recovery codes are one-time and immutable; challenges are single-use.
do $$ begin
  update auth.mfa_recovery_codes set used_at = clock_timestamp()
  where id = 'c7500000-0000-4000-8000-000000000001' and used_at is null and invalidated_at is null;
  begin
    update auth.mfa_recovery_codes set used_at = clock_timestamp()
    where id = 'c7500000-0000-4000-8000-000000000001';
    raise exception 'a recovery code was used twice';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'MFA_RECOVERY_CODE_IMMUTABLE' then raise; end if;
  end;
  begin
    update auth.mfa_recovery_codes set code_hmac = repeat('d', 64)
    where id = 'c7500000-0000-4000-8000-000000000002';
    raise exception 'a recovery code digest changed';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from auth.mfa_recovery_codes where id = 'c7500000-0000-4000-8000-000000000002';
    raise exception 'a recovery code was deleted';
  exception when object_not_in_prerequisite_state then null;
  end;
  insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version,
    created_at, expires_at)
  values ('c7700000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000001', 'verify',
    repeat('1', 64), 1, clock_timestamp(), clock_timestamp() + interval '5 minutes');
  begin
    insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version,
      created_at, expires_at)
    values (gen_random_uuid(), 'c7200000-0000-4000-8000-000000000001', 'verify',
      repeat('2', 64), 1, clock_timestamp(), clock_timestamp() + interval '11 minutes');
    raise exception 'a challenge longer than ten minutes was accepted';
  exception when check_violation then null;
  end;
  update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
  where id = 'c7700000-0000-4000-8000-000000000001';
  begin
    update auth.mfa_login_challenges set failed_attempts = 1
    where id = 'c7700000-0000-4000-8000-000000000001';
    raise exception 'a consumed challenge changed';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;

-- 5. Runtime privileges.
do $$ begin
  if not has_table_privilege('hid_identity_api_runtime', 'auth.mfa_factors', 'SELECT,INSERT,UPDATE')
     or has_table_privilege('hid_identity_api_runtime', 'auth.mfa_factors', 'DELETE')
     or has_table_privilege('hid_identity_api_runtime', 'auth.mfa_recovery_codes', 'DELETE')
     or has_table_privilege('hid_identity_api_runtime', 'auth.session_assurance', 'DELETE')
     or not has_table_privilege('hid_identity_api_runtime', 'auth.admin_approval_requests', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'auth.admin_approval_requests', 'INSERT')
     or has_table_privilege('hid_identity_api_runtime', 'auth.admin_approval_requests', 'UPDATE')
     or has_function_privilege('public', 'auth.admin_request_approval(text,uuid,text,text,text,character)', 'EXECUTE')
     or has_function_privilege('public', 'auth.admin_decide_approval(uuid,bigint,text,text,text,character)', 'EXECUTE')
     or has_function_privilege('public', 'auth.admin_revoke_session_family(uuid,uuid,boolean,text,text,character)', 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', 'auth.require_platform_step_up(uuid)', 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', 'auth.other_reachable_super_admins(uuid,text)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime', 'auth.admin_decide_approval(uuid,bigint,text,text,text,character)', 'EXECUTE') then
    raise exception 'platform MFA runtime privileges are inconsistent';
  end if;
  -- MFA state changes only in the 0069/0070 functions and guards: no OTP,
  -- recovery or patient command touches a factor.
  if exists (
    select 1 from pg_proc proc join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname in ('auth', 'identity', 'platform')
      and proc.prosrc ilike '%mfa_factors%'
      and proc.proname not in ('guard_mfa_factor_change', 'guard_session_assurance_change',
        'account_has_active_mfa', 'platform_step_up_is_fresh', 'admin_request_approval',
        'admin_decide_approval')
  ) then
    raise exception 'an unexpected database function references MFA factors';
  end if;
end $$;

-- 6. Step-up evidence comes from the server-side session, not from the caller.
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'mfa-suite-correlation-0001', true);
select set_config('app.actor_subject', 'synthetic:mfa:super-one', true);
do $$ begin
  if auth.platform_step_up_is_fresh('c7200000-0000-4000-8000-000000000001') then
    raise exception 'step-up passed without a session';
  end if;
  perform set_config('app.session_id', 'c7600000-0000-4000-8000-000000000001', true);
  if auth.platform_step_up_is_fresh('c7200000-0000-4000-8000-000000000001') then
    raise exception 'step-up passed without a TOTP step-up';
  end if;
  update auth.session_assurance set step_up_at = clock_timestamp() - interval '6 minutes',
    step_up_count = step_up_count + 1, row_version = row_version + 1
  where family_id = 'c7600000-0000-4000-8000-000000000001';
  if auth.platform_step_up_is_fresh('c7200000-0000-4000-8000-000000000001') then
    raise exception 'a stale step-up was accepted';
  end if;
  begin
    update auth.session_assurance set step_up_at = clock_timestamp() - interval '1 hour'
    where family_id = 'c7600000-0000-4000-8000-000000000001';
    raise exception 'step-up evidence moved backwards';
  exception when object_not_in_prerequisite_state then null;
  end;
  update auth.session_assurance set step_up_at = clock_timestamp(),
    step_up_count = step_up_count + 1, row_version = row_version + 1
  where family_id = 'c7600000-0000-4000-8000-000000000001';
  if not auth.platform_step_up_is_fresh('c7200000-0000-4000-8000-000000000001') then
    raise exception 'a fresh step-up was refused';
  end if;
  -- Another account's session, or a staff session, never proves step-up.
  if auth.platform_step_up_is_fresh('c7200000-0000-4000-8000-000000000002') then
    raise exception 'step-up of one administrator proved another';
  end if;
  perform set_config('app.session_id', 'c7600000-0000-4000-8000-0000000000a1', true);
  if auth.platform_step_up_is_fresh('c7200000-0000-4000-8000-000000000001') then
    raise exception 'a staff session satisfied platform step-up';
  end if;
  perform set_config('app.session_id', 'c7600000-0000-4000-8000-000000000001', true);
end $$;

-- 7. Super Admin cannot be granted in one step.
do $$
declare
  role_result record;
begin
  begin
    perform auth.admin_change_platform_role('c7200000-0000-4000-8000-000000000005', 1,
      'platform_super_admin', 'grant', 'Direct Super Admin grant attempt', 'mfa-role-0001',
      repeat('0', 64)::character(64));
    raise exception 'platform_super_admin was granted without approval';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_APPROVAL_REQUIRED' then raise; end if;
  end;
  select * into role_result from auth.admin_change_platform_role('c7200000-0000-4000-8000-000000000005', 1,
    'support_admin', 'grant', 'Ordinary platform role grant', 'mfa-role-0002', repeat('1', 64)::character(64));
  if role_result.replayed or not role_result.active then
    raise exception 'an ordinary platform role grant failed';
  end if;
end $$;

-- 8. Two-person Super Admin elevation.
do $$
declare
  requested record;
  replay record;
begin
  begin
    perform auth.admin_request_approval('platform_role.grant', 'c7200000-0000-4000-8000-000000000001',
      'platform_super_admin', 'Self elevation request', 'mfa-approval-0001', repeat('1', 64)::character(64));
    raise exception 'an administrator requested their own elevation';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_SELF_CHANGE_DENIED' then raise; end if;
  end;
  begin
    perform auth.admin_request_approval('platform_role.grant', 'c7200000-0000-4000-8000-000000000009',
      'platform_super_admin', 'Disabled target request', 'mfa-approval-0002', repeat('2', 64)::character(64));
    raise exception 'a disabled account was nominated';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_TARGET_INELIGIBLE' then raise; end if;
  end;
  select * into requested from auth.admin_request_approval('platform_role.grant',
    'c7200000-0000-4000-8000-000000000005', 'platform_super_admin', 'Elevate the synthetic target',
    'mfa-approval-0003', repeat('3', 64)::character(64));
  if requested.replayed or requested.request_status <> 'pending'
     or requested.expires_at > clock_timestamp() + interval '24 hours' then
    raise exception 'elevation request was not created as pending for 24 hours';
  end if;
  select * into replay from auth.admin_request_approval('platform_role.grant',
    'c7200000-0000-4000-8000-000000000005', 'platform_super_admin', 'Elevate the synthetic target',
    'mfa-approval-0003', repeat('3', 64)::character(64));
  if not replay.replayed or replay.request_id <> requested.request_id then
    raise exception 'elevation request replay was not idempotent';
  end if;
  begin
    perform auth.admin_request_approval('platform_role.grant', 'c7200000-0000-4000-8000-000000000005',
      'platform_super_admin', 'Duplicate elevation request', 'mfa-approval-0004', repeat('4', 64)::character(64));
    raise exception 'a duplicate pending request was accepted';
  exception when unique_violation then
    if sqlerrm <> 'ADMIN_APPROVAL_ALREADY_PENDING' then raise; end if;
  end;
  perform set_config('suite.elevation', requested.request_id::text, true);
  perform set_config('suite.elevation_version', requested.row_version::text, true);
  -- The requester cannot approve their own request.
  begin
    perform auth.admin_decide_approval(requested.request_id, requested.row_version, 'approve',
      'Self approval attempt', 'mfa-decide-0001', repeat('1', 64)::character(64));
    raise exception 'a requester approved their own request';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_SELF_APPROVAL_DENIED' then raise; end if;
  end;
end $$;

-- Without step-up the requester is refused before anything is recorded.
select set_config('app.session_id', '', true);
do $$ begin
  perform auth.admin_request_approval('platform_role.grant', 'c7200000-0000-4000-8000-000000000007',
    'platform_super_admin', 'Request without step-up', 'mfa-approval-0005', repeat('5', 64)::character(64));
  raise exception 'an elevation request was accepted without step-up';
exception when insufficient_privilege then
  if sqlerrm <> 'ADMIN_STEP_UP_REQUIRED' then raise; end if;
end $$;

-- A non-Super Admin approver is ineligible; so is a Super Admin without MFA.
select set_config('app.actor_subject', 'synthetic:mfa:operations', true);
select set_config('app.session_id', 'c7600000-0000-4000-8000-000000000004', true);
do $$ begin
  perform auth.admin_decide_approval(current_setting('suite.elevation')::uuid,
    current_setting('suite.elevation_version')::bigint, 'approve', 'Operations approval attempt',
    'mfa-decide-0002', repeat('2', 64)::character(64));
  raise exception 'a non-Super Admin approved an elevation';
exception when insufficient_privilege then
  if sqlerrm <> 'ADMIN_APPROVER_INELIGIBLE' then raise; end if;
end $$;
select set_config('app.actor_subject', 'synthetic:mfa:nomfa', true);
select set_config('app.session_id', '', true);
do $$ begin
  perform auth.admin_decide_approval(current_setting('suite.elevation')::uuid,
    current_setting('suite.elevation_version')::bigint, 'approve', 'No MFA approval attempt',
    'mfa-decide-0003', repeat('3', 64)::character(64));
  raise exception 'a Super Admin without MFA approved an elevation';
exception when insufficient_privilege then
  if sqlerrm <> 'ADMIN_APPROVER_INELIGIBLE' then raise; end if;
end $$;

-- An eligible second Super Admin still needs a fresh step-up.
select set_config('app.actor_subject', 'synthetic:mfa:super-two', true);
select set_config('app.session_id', 'c7600000-0000-4000-8000-000000000002', true);
do $$ begin
  perform auth.admin_decide_approval(current_setting('suite.elevation')::uuid,
    current_setting('suite.elevation_version')::bigint, 'approve', 'Approval without step-up',
    'mfa-decide-0004', repeat('4', 64)::character(64));
  raise exception 'an elevation was approved without step-up';
exception when insufficient_privilege then
  if sqlerrm <> 'ADMIN_STEP_UP_REQUIRED' then raise; end if;
end $$;
update auth.session_assurance set step_up_at = clock_timestamp(), step_up_count = step_up_count + 1,
  row_version = row_version + 1
where family_id in ('c7600000-0000-4000-8000-000000000002', 'c7600000-0000-4000-8000-000000000004',
  'c7600000-0000-4000-8000-000000000006');
do $$
declare
  decided record;
begin
  select * into decided from auth.admin_decide_approval(current_setting('suite.elevation')::uuid,
    current_setting('suite.elevation_version')::bigint, 'approve', 'Second Super Admin approval',
    'mfa-decide-0005', repeat('5', 64)::character(64));
  if decided.replayed or decided.request_status <> 'approved' or not decided.executed then
    raise exception 'the eligible approval did not execute';
  end if;
  if (select count(*) from auth.account_roles where account_id = 'c7200000-0000-4000-8000-000000000005'
      and role_code = 'platform_super_admin' and revoked_at is null) <> 1
     or (select granted_by from auth.account_roles where account_id = 'c7200000-0000-4000-8000-000000000005'
      and role_code = 'platform_super_admin' and revoked_at is null) <> 'c7200000-0000-4000-8000-000000000002' then
    raise exception 'the approved elevation was not granted exactly once by the approver';
  end if;
  -- A second decision is refused: the grant happens exactly once.
  begin
    perform auth.admin_decide_approval(decided.request_id, decided.row_version, 'approve',
      'Repeated approval attempt', 'mfa-decide-0006', repeat('6', 64)::character(64));
    raise exception 'an approved request was decided again';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_APPROVAL_NOT_PENDING' then raise; end if;
  end;
end $$;

-- 9. Expiry, rejection and cancellation.
reset role;
insert into auth.admin_approval_requests (id, action, target_account_id, role_code, reason, requested_by,
  requested_at, expires_at, correlation_id) values
  ('c7800000-0000-4000-8000-000000000001', 'platform_role.grant', 'c7200000-0000-4000-8000-000000000007',
   'platform_super_admin', 'Expired synthetic elevation', 'c7200000-0000-4000-8000-000000000001',
   now() - interval '25 hours', now() - interval '1 hour', 'mfa-suite-expired-0001');
do $$ begin
  update auth.admin_approval_requests set status = 'approved', decided_by = 'c7200000-0000-4000-8000-000000000002',
    decided_at = clock_timestamp(), executed_at = clock_timestamp(), decision_reason = 'Direct approval attempt',
    row_version = row_version + 1
  where id = 'c7800000-0000-4000-8000-000000000001';
  raise exception 'an expired request was approved directly';
exception when check_violation then
  if sqlerrm <> 'ADMIN_APPROVAL_EXPIRED' then raise; end if;
end $$;
set local role hid_identity_api_runtime;
do $$
declare
  decided record;
begin
  select * into decided from auth.admin_decide_approval('c7800000-0000-4000-8000-000000000001', 1, 'approve',
    'Late approval attempt', 'mfa-decide-0007', repeat('7', 64)::character(64));
  if decided.request_status <> 'expired' or decided.executed
     or exists (select 1 from auth.account_roles where account_id = 'c7200000-0000-4000-8000-000000000007'
       and role_code = 'platform_super_admin' and revoked_at is null) then
    raise exception 'an expired elevation was executed';
  end if;
end $$;

select set_config('app.actor_subject', 'synthetic:mfa:super-one', true);
select set_config('app.session_id', 'c7600000-0000-4000-8000-000000000001', true);
do $$
declare
  first_request record;
  second_request record;
  decided record;
begin
  select * into first_request from auth.admin_request_approval('platform_role.grant',
    'c7200000-0000-4000-8000-000000000007', 'platform_super_admin', 'Elevation to be rejected',
    'mfa-approval-0006', repeat('6', 64)::character(64));
  perform set_config('suite.rejected', first_request.request_id::text, true);
  perform set_config('suite.rejected_version', first_request.row_version::text, true);
  select * into second_request from auth.admin_request_approval('platform_role.grant',
    'c7200000-0000-4000-8000-000000000006', 'platform_super_admin', 'Elevation to be cancelled',
    'mfa-approval-0007', repeat('7', 64)::character(64));
  perform set_config('suite.cancelled', second_request.request_id::text, true);
  perform set_config('suite.cancelled_version', second_request.row_version::text, true);
  select * into decided from auth.admin_decide_approval(second_request.request_id, second_request.row_version,
    'cancel', 'Requester withdraws the request', 'mfa-decide-0008', repeat('8', 64)::character(64));
  if decided.request_status <> 'cancelled' or decided.executed then
    raise exception 'the requester could not cancel';
  end if;
end $$;
select set_config('app.actor_subject', 'synthetic:mfa:super-two', true);
select set_config('app.session_id', 'c7600000-0000-4000-8000-000000000002', true);
do $$
declare
  decided record;
begin
  begin
    perform auth.admin_decide_approval(current_setting('suite.rejected')::uuid,
      current_setting('suite.rejected_version')::bigint, 'cancel', 'Cancel by a non-requester',
      'mfa-decide-0009', repeat('9', 64)::character(64));
    raise exception 'a non-requester cancelled a request';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_APPROVAL_CANCEL_DENIED' then raise; end if;
  end;
  select * into decided from auth.admin_decide_approval(current_setting('suite.rejected')::uuid,
    current_setting('suite.rejected_version')::bigint, 'reject', 'Second Super Admin rejects',
    'mfa-decide-0010', repeat('a', 64)::character(64));
  if decided.request_status <> 'rejected' or decided.executed
     or exists (select 1 from auth.account_roles where account_id = 'c7200000-0000-4000-8000-000000000007'
       and role_code = 'platform_super_admin' and revoked_at is null) then
    raise exception 'a rejected elevation changed roles';
  end if;
end $$;

-- 10. Governed MFA reset: requested by one Super Admin, approved by another.
select set_config('app.actor_subject', 'synthetic:mfa:operations', true);
select set_config('app.session_id', 'c7600000-0000-4000-8000-000000000004', true);
do $$ begin
  perform auth.admin_request_approval('mfa.reset', 'c7200000-0000-4000-8000-000000000007', null,
    'Operations MFA reset attempt', 'mfa-reset-0001', repeat('1', 64)::character(64));
  raise exception 'an administrator without platform.mfa.reset requested a reset';
exception when insufficient_privilege then
  if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
end $$;
select set_config('app.actor_subject', 'synthetic:mfa:super-one', true);
select set_config('app.session_id', 'c7600000-0000-4000-8000-000000000001', true);
do $$
declare
  requested record;
begin
  begin
    perform auth.admin_request_approval('mfa.reset', 'c7200000-0000-4000-8000-000000000005', null,
      'Reset for an account without MFA', 'mfa-reset-0002', repeat('2', 64)::character(64));
    raise exception 'a reset was requested for an account without MFA';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_MFA_NOT_ENROLLED' then raise; end if;
  end;
  select * into requested from auth.admin_request_approval('mfa.reset', 'c7200000-0000-4000-8000-000000000007',
    null, 'Auditor lost their authenticator', 'mfa-reset-0003', repeat('3', 64)::character(64));
  perform set_config('suite.reset', requested.request_id::text, true);
  perform set_config('suite.reset_version', requested.row_version::text, true);
end $$;
select set_config('app.actor_subject', 'synthetic:mfa:super-two', true);
select set_config('app.session_id', 'c7600000-0000-4000-8000-000000000002', true);
do $$
declare
  decided record;
begin
  select * into decided from auth.admin_decide_approval(current_setting('suite.reset')::uuid,
    current_setting('suite.reset_version')::bigint, 'approve', 'Identity confirmed out of band',
    'mfa-decide-0011', repeat('b', 64)::character(64));
  if decided.request_status <> 'approved' or not decided.executed then
    raise exception 'the approved MFA reset did not execute';
  end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from auth.mfa_factors where account_id = 'c7200000-0000-4000-8000-000000000007'
      and status <> 'revoked')
     or (select revocation_reason from auth.mfa_factors where id = 'c7400000-0000-4000-8000-000000000007') <> 'admin_reset'
     or exists (select 1 from auth.mfa_recovery_codes where account_id = 'c7200000-0000-4000-8000-000000000007'
      and used_at is null and invalidated_at is null)
     or exists (select 1 from auth.sessions where account_id = 'c7200000-0000-4000-8000-000000000007'
      and revoked_at is null)
     or (select token_version from auth.accounts where id = 'c7200000-0000-4000-8000-000000000007') <> 2
     or not exists (select 1 from auth.session_events where account_id = 'c7200000-0000-4000-8000-000000000007'
      and event_type = 'mfa_reset') then
    raise exception 'MFA reset did not revoke the factor, recovery codes and sessions';
  end if;
  -- The used recovery code stays used; only unused codes are invalidated.
  if (select used_at is null from auth.mfa_recovery_codes where id = 'c7500000-0000-4000-8000-000000000001') then
    raise exception 'MFA reset rewrote a used recovery code';
  end if;
end $$;

-- 11. Session family revocation by an authorized administrator.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:mfa:support', true);
select set_config('app.session_id', 'c7600000-0000-4000-8000-000000000006', true);
do $$
declare
  revoked record;
begin
  begin
    perform auth.admin_revoke_session_family('c7200000-0000-4000-8000-000000000006',
      'c7600000-0000-4000-8000-000000000006', false, 'Own session through admin command',
      'mfa-session-0001', repeat('1', 64)::character(64));
    raise exception 'the administrator revoked their own session through the admin command';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_SELF_CHANGE_DENIED' then raise; end if;
  end;
  select * into revoked from auth.admin_revoke_session_family('c7200000-0000-4000-8000-000000000005',
    'c7600000-0000-4000-8000-0000000000a5', true, 'Reported compromised session',
    'mfa-session-0002', repeat('2', 64)::character(64));
  if revoked.replayed or revoked.revoked_count <> 1 then
    raise exception 'the compromised session was not revoked';
  end if;
end $$;
select set_config('app.session_id', '', true);
do $$ begin
  perform auth.admin_revoke_session_family('c7200000-0000-4000-8000-000000000001',
    'c7600000-0000-4000-8000-000000000001', false, 'Revocation without step-up',
    'mfa-session-0003', repeat('3', 64)::character(64));
  raise exception 'a session was revoked without step-up';
exception when insufficient_privilege then
  if sqlerrm <> 'ADMIN_STEP_UP_REQUIRED' then raise; end if;
end $$;
reset role;
do $$ begin
  if (select revocation_reason from auth.sessions where id = 'c7600000-0000-4000-8000-0000000000a5')
       <> 'platform_admin_compromised_session'
     or not exists (select 1 from auth.session_events where session_id = 'c7600000-0000-4000-8000-0000000000a5'
       and event_type = 'revoked' and details->>'compromised' = 'true') then
    raise exception 'compromised-session revocation was not recorded';
  end if;
end $$;

-- 12. Reachability no longer depends on a staff membership. None of these
-- Super Admins has one; under 0068 every disable below would be refused.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:mfa:super-one', true);
do $$
declare
  result record;
begin
  select * into result from auth.admin_transition_account('c7200000-0000-4000-8000-000000000003',
    (select row_version from auth.accounts where id = 'c7200000-0000-4000-8000-000000000003'),
    'disabled', 'Disable a platform-only Super Admin', 'mfa-account-0001', repeat('1', 64)::character(64));
  if result.account_status <> 'disabled' then raise exception 'reachable platform-only admins were not counted'; end if;
  select * into result from auth.admin_change_platform_role('c7200000-0000-4000-8000-000000000005',
    (select row_version from auth.accounts where id = 'c7200000-0000-4000-8000-000000000005'),
    'platform_super_admin', 'revoke', 'Revoke the approved elevation', 'mfa-role-0003', repeat('3', 64)::character(64));
  if result.active then raise exception 'Super Admin revocation failed'; end if;
end $$;
-- Super-two is now the only other reachable Super Admin; the legacy
-- administrator has no password and does not count.
select set_config('app.actor_subject', 'synthetic:mfa:legacy', true);
do $$ begin
  perform auth.admin_transition_account('c7200000-0000-4000-8000-000000000002',
    (select row_version from auth.accounts where id = 'c7200000-0000-4000-8000-000000000002'),
    'disabled', 'Disable while another Super Admin remains', 'mfa-account-0002', repeat('2', 64)::character(64));
  begin
    perform auth.admin_transition_account('c7200000-0000-4000-8000-000000000001',
      (select row_version from auth.accounts where id = 'c7200000-0000-4000-8000-000000000001'),
      'disabled', 'Disable the last reachable Super Admin', 'mfa-account-0003', repeat('3', 64)::character(64));
    raise exception 'the last reachable Super Admin was disabled';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_LAST_SUPER_ADMIN' then raise; end if;
  end;
  begin
    perform auth.admin_change_platform_role('c7200000-0000-4000-8000-000000000001',
      (select row_version from auth.accounts where id = 'c7200000-0000-4000-8000-000000000001'),
      'platform_super_admin', 'revoke', 'Revoke the last reachable Super Admin', 'mfa-role-0004',
      repeat('4', 64)::character(64));
    raise exception 'the last reachable Super Admin role was revoked';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_LAST_SUPER_ADMIN' then raise; end if;
  end;
end $$;
reset role;

rollback;
