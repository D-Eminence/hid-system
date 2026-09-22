-- Complete verified recovery through a narrow command, never a generic account
-- UPDATE grant. Historical challenges stay unbound and cannot authorize recovery.
alter table auth.otp_challenges
  add column account_token_version bigint check (account_token_version >= 1);

create function auth.complete_recovery_otp(
  requested_challenge_id uuid,
  requested_purpose text,
  supplied_completion_hmac text,
  new_password_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, auth, identity, audit, platform, pg_temp
as $$
declare
  target_account_id uuid;
  account_row auth.accounts%rowtype;
  challenge_row auth.otp_challenges%rowtype;
  request_correlation text := platform.current_correlation_id();
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or request_correlation is null then
    raise exception using errcode = '42501', message = 'Verified recovery context is required';
  end if;
  if requested_challenge_id is null
     or requested_purpose is null
     or requested_purpose not in ('PASSWORD_RESET', 'LEGACY_ACCOUNT_RECOVERY', 'LEGACY_SESSION_FALLBACK')
     or supplied_completion_hmac is null or supplied_completion_hmac !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  if length(coalesce(new_password_hash, '')) not between 64 and 512
     or new_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$' then
    raise exception using errcode = '22023', message = 'Invalid Argon2id password hash policy';
  end if;

  select challenge.account_id into target_account_id
    from auth.otp_challenges challenge where challenge.id = requested_challenge_id;
  if target_account_id is null then return false; end if;
  -- Match administrative account commands' lock order. Recheck the challenge
  -- after locking the account so concurrent disables/recovery cannot be lost.
  select * into account_row from auth.accounts
    where id = target_account_id for update;
  if not found or account_row.status not in ('active', 'pending_reset')
     or account_row.disabled_until > clock_timestamp() then return false; end if;
  select * into challenge_row from auth.otp_challenges
    where id = requested_challenge_id and account_id = target_account_id for update;
  if not found
     or challenge_row.purpose is distinct from requested_purpose
     or challenge_row.account_token_version is distinct from account_row.token_version
     or challenge_row.verified_at is null
     or challenge_row.consumed_at is not null or challenge_row.invalidated_at is not null
     or challenge_row.failed_attempts >= challenge_row.max_attempts
     or challenge_row.completion_expires_at is null
     or challenge_row.completion_expires_at <= clock_timestamp()
     or challenge_row.completion_token_hmac is distinct from supplied_completion_hmac then
    return false;
  end if;

  update auth.accounts set password_hash = new_password_hash,
    password_algorithm = 'argon2id', password_changed_at = clock_timestamp(),
    status = case when status = 'pending_reset' then 'active' else status end,
    token_version = token_version + 1, row_version = row_version + 1,
    updated_at = clock_timestamp() where id = target_account_id;
  update auth.sessions set revoked_at = clock_timestamp(),
    revocation_reason = 'password_recovered_with_otp', row_version = row_version + 1
    where account_id = target_account_id and revoked_at is null;
  update auth.otp_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
    where id = requested_challenge_id;
  update auth.otp_challenges set invalidated_at = clock_timestamp(),
    invalidation_reason = 'completed', row_version = row_version + 1
    where account_id = target_account_id and id <> requested_challenge_id
      and purpose in ('PASSWORD_RESET', 'LEGACY_ACCOUNT_RECOVERY', 'LEGACY_SESSION_FALLBACK')
      and consumed_at is null and invalidated_at is null;
  insert into identity.patient_assurance_states (
    patient_id, account_id, state, source_system, contact_verified_at
  ) select patient.id, account_row.id, 'CONTACT_VERIFIED', account_row.source_system, clock_timestamp()
    from identity.patients patient where patient.account_id = account_row.id
  on conflict (patient_id) do update set
    state = case when identity.patient_assurance_states.state = 'NIN_VERIFIED'
      then 'NIN_VERIFIED' else 'CONTACT_VERIFIED' end,
    contact_verified_at = clock_timestamp(), updated_at = clock_timestamp(),
    row_version = identity.patient_assurance_states.row_version + 1;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, action,
    resource_type, resource_id, outcome, provenance, source_system, details
  ) values (request_correlation, 'system', null, target_account_id,
    'auth.otp.recovery.completed', 'account', target_account_id::text,
    'success', 'application', 'identity-api', jsonb_build_object('purpose', requested_purpose));
  return true;
end;
$$;

revoke all on function auth.complete_recovery_otp(uuid, text, text, text) from public;
comment on function auth.complete_recovery_otp(uuid, text, text, text) is
  'Atomic one-time verified OTP recovery bound to current account token version; cannot enable disabled accounts. No OTP/token/password plaintext is persisted or audited.';
