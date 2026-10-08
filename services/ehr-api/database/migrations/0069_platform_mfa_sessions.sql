-- Phase 4 Stage 2A: platform administrator MFA, platform sessions and step-up.
--
-- Platform administration gets its own session kind. The Identity API issues a
-- platform session only after the password and then a TOTP code (or a one-time
-- recovery code) were verified. It carries no facility membership, expires 15
-- minutes after its last refresh, and ends 8 hours after sign-in. A step-up
-- timestamp on the session family records a fresh TOTP for high-risk commands.
--
-- Secrets: TOTP secrets are encrypted by the Identity API (AES-256-GCM) and
-- stored here only as ciphertext. Recovery codes are stored as keyed digests and
-- challenge tokens as SHA-256 digests. Email OTP is not an MFA method: nothing
-- in this migration accepts it, and session assurance records only 'totp' or
-- 'recovery_code'.

-- 1. Platform session kind and lifetime ceilings. The Identity API may use
-- shorter values; the database refuses anything longer.
alter table auth.sessions drop constraint sessions_session_kind_check;
alter table auth.sessions add constraint sessions_session_kind_check
  check (session_kind in ('staff', 'patient', 'platform'));
alter table auth.sessions add constraint sessions_platform_lifetime_check check (
  session_kind <> 'platform'
  or (authentication_method = 'password'
      and extract(epoch from (expires_at - issued_at)) <= 900
      and extract(epoch from (absolute_expires_at - issued_at)) <= 28800)
);

-- 2. Session events for MFA and step-up. Details never contain secrets or codes.
alter table auth.session_events drop constraint session_events_event_type_check;
alter table auth.session_events add constraint session_events_event_type_check check (event_type in (
  'login_succeeded', 'login_failed', 'refresh', 'rotated', 'revoked', 'logout', 'expired', 'reuse_detected',
  'mfa_challenge_issued', 'mfa_verified', 'mfa_failed', 'mfa_enrollment_started', 'mfa_enrolled',
  'mfa_recovery_code_used', 'mfa_recovery_codes_regenerated', 'mfa_reset',
  'step_up_verified', 'step_up_failed', 'mfa_rate_limited'
));

-- 3. MFA attempt limits reuse the keyed request-window table from 0028 and the
-- same consume/serialize algorithm as OTP recovery.
alter table auth.otp_rate_limits drop constraint otp_rate_limits_scope_check;
alter table auth.otp_rate_limits add constraint otp_rate_limits_scope_check check (scope in (
  'ip', 'account', 'recipient', 'mfa_failure_account', 'mfa_failure_ip', 'mfa_request_account'
));

-- 4. TOTP factors (RFC 6238: SHA-1, 6 digits, 30-second period). One pending
-- and one active factor per account at most.
create table auth.mfa_factors (
  id uuid primary key,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  factor_type text not null default 'totp' check (factor_type = 'totp'),
  status text not null check (status in ('pending', 'active', 'revoked')),
  secret_ciphertext bytea not null check (octet_length(secret_ciphertext) between 45 and 256),
  secret_key_version text not null check (length(secret_key_version) between 1 and 64),
  algorithm text not null default 'SHA1' check (algorithm = 'SHA1'),
  digits smallint not null default 6 check (digits = 6),
  period_seconds smallint not null default 30 check (period_seconds = 30),
  enrollment_expires_at timestamptz,
  -- Highest accepted time step. A code is accepted only for a later step, so
  -- a code can never be replayed, including across login and step-up.
  last_used_step bigint check (last_used_step is null or last_used_step > 0),
  last_used_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  activated_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.accounts(id) on delete restrict,
  revocation_reason text check (revocation_reason is null or revocation_reason in (
    'enrollment_replaced', 'enrollment_expired', 'admin_reset'
  )),
  row_version bigint not null default 1 check (row_version > 0),
  unique (id, account_id),
  constraint mfa_factors_state_check check (
    (status = 'pending' and activated_at is null and revoked_at is null and revocation_reason is null
      and enrollment_expires_at is not null and last_used_step is null)
    or (status = 'active' and activated_at is not null and revoked_at is null
      and revocation_reason is null and last_used_step is not null)
    or (status = 'revoked' and revoked_at is not null and revocation_reason is not null)
  ),
  constraint mfa_factors_enrollment_window_check check (
    enrollment_expires_at is null
    or extract(epoch from (enrollment_expires_at - created_at)) between 1 and 600
  )
);
create unique index mfa_factors_one_active_idx on auth.mfa_factors (account_id) where status = 'active';
create unique index mfa_factors_one_pending_idx on auth.mfa_factors (account_id) where status = 'pending';
comment on table auth.mfa_factors is
  'Platform administrator TOTP factors. secret_ciphertext is AES-256-GCM ciphertext; the plaintext secret is never stored or returned after enrollment.';

create function auth.guard_mfa_factor_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'MFA_FACTOR_IMMUTABLE';
  end if;
  if old.status = 'revoked' then
    raise exception using errcode = '55000', message = 'MFA_FACTOR_IMMUTABLE';
  end if;
  if new.id <> old.id or new.account_id <> old.account_id or new.factor_type <> old.factor_type
     or new.secret_ciphertext <> old.secret_ciphertext or new.secret_key_version <> old.secret_key_version
     or new.algorithm <> old.algorithm or new.digits <> old.digits
     or new.period_seconds <> old.period_seconds or new.created_at <> old.created_at
     or new.enrollment_expires_at is distinct from old.enrollment_expires_at
     or (old.status = 'active' and new.activated_at is distinct from old.activated_at) then
    raise exception using errcode = '55000', message = 'MFA_FACTOR_IMMUTABLE';
  end if;
  if (old.status = 'active' and new.status not in ('active', 'revoked'))
     or (old.status = 'pending' and new.status not in ('pending', 'active', 'revoked')) then
    raise exception using errcode = '23514', message = 'MFA_FACTOR_INVALID_TRANSITION';
  end if;
  if old.status = 'pending' and new.status = 'active' and old.enrollment_expires_at <= clock_timestamp() then
    raise exception using errcode = '23514', message = 'MFA_ENROLLMENT_EXPIRED';
  end if;
  -- An active factor is removed only by the governed reset; a pending one only
  -- by replacement or expiry.
  if new.status = 'revoked' and (
       (old.status = 'active' and new.revocation_reason <> 'admin_reset')
       or (old.status = 'pending' and new.revocation_reason = 'admin_reset' and new.revoked_by is null)) then
    raise exception using errcode = '23514', message = 'MFA_FACTOR_INVALID_TRANSITION';
  end if;
  if old.last_used_step is not null
     and (new.last_used_step is null or new.last_used_step < old.last_used_step) then
    raise exception using errcode = '23514', message = 'MFA_FACTOR_STEP_REGRESSION';
  end if;
  return new;
end
$$;
revoke all on function auth.guard_mfa_factor_change() from public;
create trigger mfa_factors_guard
  before update or delete on auth.mfa_factors
  for each row execute function auth.guard_mfa_factor_change();

-- 5. One-time recovery codes, stored as keyed digests. A code is either used
-- once or invalidated (regenerated or factor revoked); neither is reversible.
create table auth.mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.accounts(id) on delete restrict,
  factor_id uuid not null,
  batch_id uuid not null,
  code_hmac char(64) not null check (code_hmac ~ '^[0-9a-f]{64}$'),
  key_version text not null check (length(key_version) between 1 and 64),
  created_at timestamptz not null default clock_timestamp(),
  used_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text check (invalidation_reason is null
    or invalidation_reason in ('regenerated', 'factor_revoked')),
  foreign key (factor_id, account_id) references auth.mfa_factors(id, account_id) on delete restrict,
  constraint mfa_recovery_codes_unique_digest unique (account_id, code_hmac),
  constraint mfa_recovery_codes_state_check check (
    (invalidated_at is null) = (invalidation_reason is null)
    and not (used_at is not null and invalidated_at is not null)
  )
);
create index mfa_recovery_codes_open_idx on auth.mfa_recovery_codes (account_id)
  where used_at is null and invalidated_at is null;

create function auth.guard_mfa_recovery_code_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' or old.used_at is not null or old.invalidated_at is not null then
    raise exception using errcode = '55000', message = 'MFA_RECOVERY_CODE_IMMUTABLE';
  end if;
  if new.id <> old.id or new.account_id <> old.account_id or new.factor_id <> old.factor_id
     or new.batch_id <> old.batch_id or new.code_hmac <> old.code_hmac
     or new.key_version <> old.key_version or new.created_at <> old.created_at then
    raise exception using errcode = '55000', message = 'MFA_RECOVERY_CODE_IMMUTABLE';
  end if;
  return new;
end
$$;
revoke all on function auth.guard_mfa_recovery_code_change() from public;
create trigger mfa_recovery_codes_guard
  before update or delete on auth.mfa_recovery_codes
  for each row execute function auth.guard_mfa_recovery_code_change();

-- 6. Short-lived second-factor challenges between a verified password and a
-- platform session. The browser holds the token in an httpOnly cookie.
create table auth.mfa_login_challenges (
  id uuid primary key,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  purpose text not null check (purpose in ('verify', 'enroll')),
  token_sha256 char(64) not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  account_token_version bigint not null check (account_token_version > 0),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text check (invalidation_reason is null
    or invalidation_reason in ('superseded', 'expired', 'attempts_exhausted')),
  source_ip inet,
  user_agent_sha256 char(64),
  row_version bigint not null default 1 check (row_version > 0),
  constraint mfa_login_challenges_window_check
    check (extract(epoch from (expires_at - created_at)) between 1 and 600),
  constraint mfa_login_challenges_attempts_check check (failed_attempts <= max_attempts),
  constraint mfa_login_challenges_state_check check (
    (invalidated_at is null) = (invalidation_reason is null)
    and not (consumed_at is not null and invalidated_at is not null)
  )
);
create index mfa_login_challenges_open_idx on auth.mfa_login_challenges (account_id)
  where consumed_at is null and invalidated_at is null;

create function auth.guard_mfa_login_challenge_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' or old.consumed_at is not null or old.invalidated_at is not null then
    raise exception using errcode = '55000', message = 'MFA_CHALLENGE_IMMUTABLE';
  end if;
  if new.id <> old.id or new.account_id <> old.account_id or new.purpose <> old.purpose
     or new.token_sha256 <> old.token_sha256 or new.account_token_version <> old.account_token_version
     or new.created_at <> old.created_at or new.expires_at <> old.expires_at
     or new.max_attempts <> old.max_attempts or new.failed_attempts < old.failed_attempts then
    raise exception using errcode = '55000', message = 'MFA_CHALLENGE_IMMUTABLE';
  end if;
  if new.consumed_at is not null and old.expires_at <= clock_timestamp() then
    raise exception using errcode = '23514', message = 'MFA_CHALLENGE_EXPIRED';
  end if;
  return new;
end
$$;
revoke all on function auth.guard_mfa_login_challenge_change() from public;
create trigger mfa_login_challenges_guard
  before update or delete on auth.mfa_login_challenges
  for each row execute function auth.guard_mfa_login_challenge_change();

-- 7. Assurance of a platform session family. Refresh rotates the session row
-- but keeps the family, so MFA and step-up are recorded once per family.
create table auth.session_assurance (
  family_id uuid primary key references auth.sessions(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  mfa_factor_id uuid not null,
  mfa_method text not null check (mfa_method in ('totp', 'recovery_code')),
  mfa_verified_at timestamptz not null,
  step_up_at timestamptz,
  step_up_count integer not null default 0 check (step_up_count >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (mfa_factor_id, account_id) references auth.mfa_factors(id, account_id) on delete restrict,
  constraint session_assurance_step_up_check check (step_up_at is null or step_up_at >= mfa_verified_at)
);
comment on table auth.session_assurance is
  'Server-side MFA and step-up evidence for a platform session family. Clients cannot assert assurance.';

create function auth.guard_session_assurance_change()
returns trigger
language plpgsql
set search_path = auth, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'SESSION_ASSURANCE_IMMUTABLE';
  end if;
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from auth.sessions session_row
      where session_row.id = new.family_id and session_row.family_id = new.family_id
        and session_row.account_id = new.account_id and session_row.session_kind = 'platform'
    ) or not exists (
      select 1 from auth.mfa_factors factor
      where factor.id = new.mfa_factor_id and factor.account_id = new.account_id and factor.status = 'active'
    ) then
      raise exception using errcode = '23514', message = 'SESSION_ASSURANCE_INVALID';
    end if;
    if new.step_up_at is not null or new.step_up_count <> 0 then
      raise exception using errcode = '23514', message = 'SESSION_ASSURANCE_INVALID';
    end if;
    return new;
  end if;
  if new.family_id <> old.family_id or new.account_id <> old.account_id
     or new.mfa_factor_id <> old.mfa_factor_id or new.mfa_method <> old.mfa_method
     or new.mfa_verified_at <> old.mfa_verified_at
     or (old.step_up_at is not null and (new.step_up_at is null or new.step_up_at < old.step_up_at))
     or new.step_up_count < old.step_up_count then
    raise exception using errcode = '55000', message = 'SESSION_ASSURANCE_IMMUTABLE';
  end if;
  return new;
end
$$;
revoke all on function auth.guard_session_assurance_change() from public;
create trigger session_assurance_guard
  before insert or update or delete on auth.session_assurance
  for each row execute function auth.guard_session_assurance_change();

-- 8. New platform permissions. Principal export moves off principal.read, and
-- MFA reset requests are their own grant. Both go to platform_super_admin only.
insert into auth.permissions (code, description) values
  ('platform.principal.export', 'Export the bounded principal directory (step-up required)'),
  ('platform.mfa.reset', 'Request a governed reset of another administrator''s MFA (two-person approval)')
on conflict (code) do update set description = excluded.description, active = true;

insert into auth.role_permissions (role_code, permission_code) values
  ('platform_super_admin', 'platform.principal.export'),
  ('platform_super_admin', 'platform.mfa.reset')
on conflict (role_code, permission_code) do nothing;

-- 9. Server-side step-up evidence for SQL commands. The Identity API sets
-- app.session_id with the other request GUCs; the check below proves the
-- current request runs on an active platform session of the actor, verified by
-- an active factor, with a TOTP step-up in the last five minutes.
create function platform.current_session_id()
returns uuid
language plpgsql
stable
as $$
declare
  value text := nullif(current_setting('app.session_id', true), '');
begin
  if value is null then
    return null;
  end if;
  if value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'Invalid session request context';
  end if;
  return value::uuid;
end
$$;
revoke all on function platform.current_session_id() from public;

create function auth.account_has_active_mfa(requested_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = auth, pg_temp
as $$
  select exists (
    select 1 from auth.mfa_factors factor
    where factor.account_id = requested_account_id and factor.status = 'active'
  )
$$;
revoke all on function auth.account_has_active_mfa(uuid) from public;

create function auth.platform_step_up_is_fresh(requested_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = auth, platform, pg_temp
as $$
  select exists (
    select 1
    from auth.sessions session_row
    join auth.accounts account_row on account_row.id = session_row.account_id
    join auth.session_assurance assurance
      on assurance.family_id = session_row.family_id and assurance.account_id = session_row.account_id
    join auth.mfa_factors factor
      on factor.id = assurance.mfa_factor_id and factor.account_id = session_row.account_id
     and factor.status = 'active'
    where session_row.id = platform.current_session_id()
      and session_row.account_id = requested_account_id
      and session_row.session_kind = 'platform'
      and session_row.revoked_at is null
      and session_row.expires_at > clock_timestamp()
      and session_row.absolute_expires_at > clock_timestamp()
      and session_row.account_token_version = account_row.token_version
      and account_row.status = 'active'
      and (account_row.disabled_until is null or account_row.disabled_until <= clock_timestamp())
      and assurance.step_up_at > clock_timestamp() - interval '5 minutes'
  )
$$;
revoke all on function auth.platform_step_up_is_fresh(uuid) from public;

create function auth.require_platform_step_up(requested_account_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = auth, platform, pg_temp
as $$
begin
  if requested_account_id is null or not auth.platform_step_up_is_fresh(requested_account_id) then
    raise exception using errcode = '42501', message = 'ADMIN_STEP_UP_REQUIRED';
  end if;
end
$$;
revoke all on function auth.require_platform_step_up(uuid) from public;

-- 10. Revoke one session family of another account (for example a session the
-- owner reports as compromised). Same idempotency contract as 0027.
create function auth.admin_revoke_session_family(
  requested_account_id uuid,
  requested_session_id uuid,
  requested_compromised boolean,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (account_id uuid, family_id uuid, revoked_count integer, replayed boolean)
language plpgsql
security definer
set search_path = auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  prior auth.admin_command_idempotency%rowtype;
  target_family uuid;
  affected integer;
  response jsonb;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.session.revoke') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_account_id = actor_account then
    raise exception using errcode = '42501', message = 'ADMIN_SELF_CHANGE_DENIED';
  end if;
  if requested_reason is null or length(btrim(requested_reason)) < 8
     or requested_compromised is null then
    raise exception using errcode = '22023', message = 'ADMIN_REASON_REQUIRED';
  end if;
  perform auth.require_platform_step_up(actor_account);
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'account.session-family.revoke'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'accountId')::uuid, (prior.response->>'familyId')::uuid,
      (prior.response->>'revokedCount')::integer, true;
    return;
  end if;
  select session_row.family_id into target_family from auth.sessions session_row
  where session_row.id = requested_session_id and session_row.account_id = requested_account_id;
  if target_family is null then
    raise exception using errcode = 'P0002', message = 'ADMIN_SESSION_NOT_FOUND';
  end if;
  update auth.sessions as session_row
  set revoked_at = clock_timestamp(),
      revocation_reason = case when requested_compromised
        then 'platform_admin_compromised_session' else 'platform_admin_revocation' end,
      row_version = session_row.row_version + 1
  where session_row.family_id = target_family and session_row.revoked_at is null;
  get diagnostics affected = row_count;
  insert into auth.session_events (session_id, account_id, event_type, outcome, correlation_id, details)
  values (requested_session_id, requested_account_id, 'revoked', 'success', platform.current_correlation_id(),
    jsonb_build_object('revokedBy', actor_account, 'compromised', requested_compromised,
      'revokedCount', affected));
  response := jsonb_build_object('accountId', requested_account_id, 'familyId', target_family,
    'revokedCount', affected);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'account.session-family.revoke', requested_idempotency_key,
    requested_sha256, response);
  return query select requested_account_id, target_family, affected, false;
end
$$;
revoke all on function auth.admin_revoke_session_family(uuid, uuid, boolean, text, text, character) from public;
