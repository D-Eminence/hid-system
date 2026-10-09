-- Phase 4 Stage 5B: serialize session revocation with refresh rotation.
--
-- A refresh inserts the new session (S2), then marks the old one (S1)
-- 'rotated', in one transaction. Under READ COMMITTED, an administrator's
-- family or account revocation that ran its UPDATE after S1 was marked but
-- before the refresh committed waited for S1, skipped it as already revoked,
-- and never saw the uncommitted S2. S2 then stayed live for up to the
-- session's lifetime, even after a revocation marked compromised.
--
-- The rotation's INSERT already takes FOR KEY SHARE on the account row (the
-- auth.sessions -> auth.accounts foreign key). A revocation now takes FOR
-- UPDATE on that row first, which conflicts with it:
-- * if a rotation is in flight, the revocation waits for it to commit, and
--   its UPDATE (a new statement, so a new snapshot) then sees and revokes S2;
-- * if the revocation locks first, the rotation's INSERT waits; its update of
--   S1 then finds S1 revoked and the refresh rolls back without a session.
-- Account actions that change the token version (suspension, MFA reset,
-- password recovery, deletion) already invalidate such a session and are not
-- changed.
--
-- * auth.admin_revoke_account_sessions (0027) and
--   auth.admin_revoke_session_family (0069): same signatures, permissions,
--   checks, idempotency and results; only the lock is added. CREATE OR
--   REPLACE keeps their owner and grants.
-- * auth.lock_account_sessions(uuid): takes the same lock for the Identity
--   API's own revocations (refresh-token reuse, an administrator revoking one
--   of their own sessions, sign-out and expiry), whose runtime role cannot lock
--   auth.accounts itself. Sign-out and expiry end one session but take the
--   lock first too: every revocation then locks the account before its
--   sessions, so none can deadlock with another. Granted to the Identity
--   runtime only.

create or replace function auth.lock_account_sessions(target_account uuid)
returns void
language plpgsql
security definer
set search_path = auth, pg_temp
as $$
begin
  perform 1 from auth.accounts account_row where account_row.id = target_account for update;
end
$$;
revoke all on function auth.lock_account_sessions(uuid) from public;
comment on function auth.lock_account_sessions(uuid) is
  'Serializes a family or account session revocation with refresh rotation (0073). Call before the revoking UPDATE, in the same transaction.';

create or replace function auth.admin_revoke_account_sessions(
  requested_account_id uuid,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (account_id uuid, revoked_count integer, replayed boolean)
language plpgsql
security definer
set search_path = auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  prior auth.admin_command_idempotency%rowtype;
  affected integer;
  response jsonb;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.session.revoke') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_reason is null or length(btrim(requested_reason)) < 8 then
    raise exception using errcode = '22023', message = 'ADMIN_REASON_REQUIRED';
  end if;
  if not exists (select 1 from auth.accounts where id = requested_account_id) then
    raise exception using errcode = 'P0002', message = 'ADMIN_ACCOUNT_NOT_FOUND';
  end if;
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'account.sessions.revoke'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'accountId')::uuid,
      (prior.response->>'revokedCount')::integer, true;
    return;
  end if;
  -- 0073: wait for any refresh in flight, so a session it creates is revoked too.
  perform auth.lock_account_sessions(requested_account_id);
  update auth.sessions as session_row
  set revoked_at = clock_timestamp(), revocation_reason = 'platform_admin_revocation',
      row_version = session_row.row_version + 1
  where session_row.account_id = requested_account_id and session_row.revoked_at is null;
  get diagnostics affected = row_count;
  response := jsonb_build_object('accountId', requested_account_id, 'revokedCount', affected);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'account.sessions.revoke', requested_idempotency_key,
    requested_sha256, response);
  return query select requested_account_id, affected, false;
end
$$;

create or replace function auth.admin_revoke_session_family(
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
  -- 0073: wait for any refresh in flight, so a session it creates is revoked too.
  perform auth.lock_account_sessions(requested_account_id);
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
