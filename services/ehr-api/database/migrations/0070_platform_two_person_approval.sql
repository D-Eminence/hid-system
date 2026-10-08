-- Phase 4 Stage 2A: two-person approval for Super Admin elevation and MFA reset.
--
-- * Granting platform_super_admin is a two-step command: an authorized
--   administrator with a fresh MFA step-up requests it, and a different active
--   Super Admin with a fresh step-up approves it within 24 hours. The grant runs
--   exactly once, inside the approval. The one-step role command refuses it.
-- * Resetting another administrator's lost MFA factor uses the same request /
--   approval flow. No email OTP, recovery flow or self-service path can reset
--   an active factor.
-- * A Super Admin is "reachable" when the account can open a platform session:
--   active, not suspended, holding the role, with a password credential. Admin
--   sign-in no longer depends on a staff facility membership (0069), so the
--   membership join of 0027/0068 is replaced in the account and role commands.
--
-- Super Admin revocation remains a one-step command (step-up enforced by the
-- Identity API); whether it also needs two-person approval is an open policy
-- decision recorded in docs/PHASE_4_STAGE_2A_BACKEND_SECURITY.md.

create function auth.other_reachable_super_admins(excluded_account uuid, excluded_role text)
returns bigint
language sql
stable
security definer
set search_path = auth, pg_temp
as $$
  select count(distinct account_row.id)
  from auth.accounts account_row
  join auth.account_roles assignment
    on assignment.account_id = account_row.id
   and assignment.scope_type = 'platform'
   and assignment.revoked_at is null
   and assignment.role_code in ('platform_super_admin', 'platform_admin')
  join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
  where account_row.status = 'active'
    and (account_row.disabled_until is null or account_row.disabled_until <= clock_timestamp())
    and account_row.password_hash is not null
    and not (account_row.id = excluded_account
      and (excluded_role is null or assignment.role_code = excluded_role))
$$;
revoke all on function auth.other_reachable_super_admins(uuid, text) from public;

-- 0068's account command with the platform-session reachability rule.
create or replace function auth.admin_transition_account(
  requested_account_id uuid,
  expected_version bigint,
  requested_status text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (account_id uuid, account_status text, row_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  prior auth.admin_command_idempotency%rowtype;
  current_row auth.accounts%rowtype;
  next_status text;
  response jsonb;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.principal.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_account_id = actor_account then
    raise exception using errcode = '42501', message = 'ADMIN_SELF_CHANGE_DENIED';
  end if;
  if requested_status not in ('active', 'disabled')
     or requested_reason is null or length(btrim(requested_reason)) < 8 then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_ACCOUNT_TRANSITION';
  end if;
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'account.status.transition'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'accountId')::uuid,
      prior.response->>'status', (prior.response->>'version')::bigint, true;
    return;
  end if;
  select * into current_row from auth.accounts where id = requested_account_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ADMIN_ACCOUNT_NOT_FOUND'; end if;
  if current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if current_row.status not in ('active', 'pending_reset', 'locked', 'disabled') then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_ACCOUNT_TRANSITION';
  end if;
  if current_row.status = requested_status then
    raise exception using errcode = '23514', message = 'ADMIN_NO_STATE_CHANGE';
  end if;
  if requested_status = 'active' and current_row.status <> 'disabled' then
    raise exception using errcode = '23514', message = 'ADMIN_ACCOUNT_RECOVERY_REQUIRED';
  end if;
  if requested_status = 'disabled' and exists (
    select 1 from auth.account_roles assignment
    where assignment.account_id = current_row.id and assignment.scope_type = 'platform'
      and assignment.revoked_at is null
      and assignment.role_code in ('platform_super_admin', 'platform_admin')
  ) then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('hid.platform.last-super-admin', 0)
    );
    if auth.other_reachable_super_admins(current_row.id, null) < 1 then
      raise exception using errcode = '23514', message = 'ADMIN_LAST_SUPER_ADMIN';
    end if;
  end if;
  if requested_status = 'disabled' then
    update auth.accounts as account_row
    set status = 'disabled',
        disabled_from_status = current_row.status,
        disabled_until = null,
        token_version = account_row.token_version + 1,
        row_version = account_row.row_version + 1,
        updated_at = clock_timestamp()
    where account_row.id = current_row.id returning account_row.* into current_row;
    update auth.sessions as session_row
    set revoked_at = coalesce(session_row.revoked_at, clock_timestamp()),
        revocation_reason = coalesce(session_row.revocation_reason, 'account_suspended_by_platform_admin'),
        row_version = session_row.row_version + 1
    where session_row.account_id = current_row.id and session_row.revoked_at is null;
  else
    next_status := case current_row.disabled_from_status
      when 'active' then 'active'
      when 'locked' then 'locked'
      else 'pending_reset'
    end;
    update auth.accounts as account_row
    set status = next_status,
        disabled_from_status = null,
        token_version = account_row.token_version + 1,
        row_version = account_row.row_version + 1,
        updated_at = clock_timestamp()
    where account_row.id = current_row.id returning account_row.* into current_row;
  end if;
  response := jsonb_build_object('accountId', current_row.id,
    'status', current_row.status, 'version', current_row.row_version);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'account.status.transition', requested_idempotency_key,
    requested_sha256, response);
  return query select current_row.id, current_row.status, current_row.row_version, false;
end
$$;

-- 0068's role command. Granting platform_super_admin is refused here: it is
-- available only through the two-person approval below. Revocation keeps the
-- last-Super-Admin protection with the platform-session reachability rule.
create or replace function auth.admin_change_platform_role(
  requested_account_id uuid,
  expected_account_version bigint,
  requested_role_code text,
  requested_action text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (account_id uuid, role_code text, active boolean, account_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  prior auth.admin_command_idempotency%rowtype;
  target auth.accounts%rowtype;
  assignment_id uuid;
  response jsonb;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.role.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_account_id = actor_account then
    raise exception using errcode = '42501', message = 'ADMIN_SELF_CHANGE_DENIED';
  end if;
  if requested_role_code not in ('platform_super_admin', 'platform_operations_admin',
      'identity_review_admin', 'facility_review_admin', 'security_auditor', 'support_admin')
     or requested_action not in ('grant', 'revoke')
     or requested_reason is null or length(btrim(requested_reason)) < 8 then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_ROLE_COMMAND';
  end if;
  if requested_action = 'grant' and requested_role_code = 'platform_super_admin' then
    raise exception using errcode = '42501', message = 'ADMIN_APPROVAL_REQUIRED';
  end if;
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'platform.role.change'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'accountId')::uuid, prior.response->>'roleCode',
      (prior.response->>'active')::boolean, (prior.response->>'version')::bigint, true;
    return;
  end if;
  select * into target from auth.accounts where id = requested_account_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ADMIN_ACCOUNT_NOT_FOUND'; end if;
  if target.row_version <> expected_account_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if requested_action = 'grant' then
    if exists (select 1 from auth.account_roles assignment where assignment.account_id = target.id
        and assignment.role_code = requested_role_code and assignment.scope_type = 'platform'
        and assignment.revoked_at is null) then
      raise exception using errcode = '23505', message = 'ADMIN_ROLE_ALREADY_ACTIVE';
    end if;
    insert into auth.account_roles (
      id, account_id, role_code, scope_type, granted_by, grant_reason
    ) values (
      gen_random_uuid(), target.id, requested_role_code, 'platform', actor_account, btrim(requested_reason)
    );
  else
    if requested_role_code = 'platform_super_admin' then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('hid.platform.last-super-admin', 0)
      );
      if auth.other_reachable_super_admins(target.id, requested_role_code) < 1 then
        raise exception using errcode = '23514', message = 'ADMIN_LAST_SUPER_ADMIN';
      end if;
    end if;
    update auth.account_roles as assignment
    set revoked_at = clock_timestamp(), revoked_by = actor_account,
        revocation_reason = btrim(requested_reason), row_version = assignment.row_version + 1
    where assignment.account_id = target.id and assignment.role_code = requested_role_code
      and assignment.scope_type = 'platform' and assignment.revoked_at is null
    returning assignment.id into assignment_id;
    if assignment_id is null then
      raise exception using errcode = 'P0002', message = 'ADMIN_ROLE_NOT_ACTIVE';
    end if;
  end if;
  update auth.accounts as account_row
  set row_version = account_row.row_version + 1, updated_at = clock_timestamp()
  where account_row.id = target.id returning account_row.* into target;
  response := jsonb_build_object('accountId', target.id, 'roleCode', requested_role_code,
    'active', requested_action = 'grant', 'version', target.row_version);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'platform.role.change', requested_idempotency_key,
    requested_sha256, response);
  return query select target.id, requested_role_code, requested_action = 'grant',
    target.row_version, false;
end
$$;

-- Two-person approval requests. A request is decided once; a decided,
-- cancelled or expired request is immutable.
create table auth.admin_approval_requests (
  id uuid primary key,
  action text not null check (action in ('platform_role.grant', 'mfa.reset')),
  target_account_id uuid not null references auth.accounts(id) on delete restrict,
  role_code text references auth.roles(code) on delete restrict,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  requested_by uuid not null references auth.accounts(id) on delete restrict,
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  decided_by uuid references auth.accounts(id) on delete restrict,
  decided_at timestamptz,
  decision_reason text check (decision_reason is null or length(btrim(decision_reason)) between 8 and 500),
  executed_at timestamptz,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  row_version bigint not null default 1 check (row_version > 0),
  constraint admin_approval_requests_action_role_check check (
    (action = 'platform_role.grant' and role_code = 'platform_super_admin')
    or (action = 'mfa.reset' and role_code is null)
  ),
  constraint admin_approval_requests_window_check
    check (extract(epoch from (expires_at - requested_at)) between 1 and 86400),
  constraint admin_approval_requests_not_self check (requested_by <> target_account_id),
  constraint admin_approval_requests_state_check check (
    (status = 'pending' and decided_by is null and decided_at is null and executed_at is null
      and decision_reason is null)
    or (status = 'approved' and decided_by is not null and decided_at is not null
      and executed_at is not null and decision_reason is not null
      and decided_by <> requested_by and decided_by <> target_account_id)
    or (status = 'rejected' and decided_by is not null and decided_at is not null
      and executed_at is null and decision_reason is not null
      and decided_by <> requested_by and decided_by <> target_account_id)
    or (status = 'cancelled' and decided_by = requested_by and decided_at is not null
      and executed_at is null and decision_reason is not null)
    or (status = 'expired' and decided_by is null and decided_at is not null and executed_at is null)
  )
);
create unique index admin_approval_requests_one_pending_idx
  on auth.admin_approval_requests (action, target_account_id) where status = 'pending';
create index admin_approval_requests_status_idx
  on auth.admin_approval_requests (status, requested_at desc, id);

create function auth.guard_admin_approval_request_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' or old.status <> 'pending' then
    raise exception using errcode = '55000', message = 'ADMIN_APPROVAL_IMMUTABLE';
  end if;
  if new.id <> old.id or new.action <> old.action or new.target_account_id <> old.target_account_id
     or new.role_code is distinct from old.role_code or new.reason <> old.reason
     or new.requested_by <> old.requested_by or new.requested_at <> old.requested_at
     or new.expires_at <> old.expires_at or new.correlation_id <> old.correlation_id
     or new.row_version <> old.row_version + 1 then
    raise exception using errcode = '55000', message = 'ADMIN_APPROVAL_IMMUTABLE';
  end if;
  -- Only an unexpired request can be approved.
  if new.status = 'approved' and old.expires_at <= clock_timestamp() then
    raise exception using errcode = '23514', message = 'ADMIN_APPROVAL_EXPIRED';
  end if;
  return new;
end
$$;
revoke all on function auth.guard_admin_approval_request_change() from public;
create trigger admin_approval_requests_guard
  before update or delete on auth.admin_approval_requests
  for each row execute function auth.guard_admin_approval_request_change();

create function auth.admin_request_approval(
  requested_action text,
  requested_account_id uuid,
  requested_role_code text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (request_id uuid, request_status text, expires_at timestamptz, row_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  required_permission text := case requested_action
    when 'platform_role.grant' then 'platform.role.manage'
    when 'mfa.reset' then 'platform.mfa.reset' end;
  prior auth.admin_command_idempotency%rowtype;
  target auth.accounts%rowtype;
  created auth.admin_approval_requests%rowtype;
  started_at timestamptz := clock_timestamp();
  response jsonb;
begin
  if required_permission is null then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_APPROVAL_REQUEST';
  end if;
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, required_permission) then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_account_id = actor_account then
    raise exception using errcode = '42501', message = 'ADMIN_SELF_CHANGE_DENIED';
  end if;
  if requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
     or (requested_action = 'platform_role.grant'
       and requested_role_code is distinct from 'platform_super_admin')
     or (requested_action = 'mfa.reset' and requested_role_code is not null) then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_APPROVAL_REQUEST';
  end if;
  if not auth.account_has_active_mfa(actor_account) then
    raise exception using errcode = '42501', message = 'ADMIN_MFA_REQUIRED';
  end if;
  perform auth.require_platform_step_up(actor_account);
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'approval.request'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'requestId')::uuid, prior.response->>'status',
      (prior.response->>'expiresAt')::timestamptz, (prior.response->>'version')::bigint, true;
    return;
  end if;
  select * into target from auth.accounts where id = requested_account_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ADMIN_ACCOUNT_NOT_FOUND'; end if;
  if requested_action = 'platform_role.grant' then
    if target.status <> 'active'
       or (target.disabled_until is not null and target.disabled_until > clock_timestamp()) then
      raise exception using errcode = '23514', message = 'ADMIN_TARGET_INELIGIBLE';
    end if;
    if exists (select 1 from auth.account_roles assignment where assignment.account_id = target.id
        and assignment.role_code = 'platform_super_admin' and assignment.scope_type = 'platform'
        and assignment.revoked_at is null) then
      raise exception using errcode = '23505', message = 'ADMIN_ROLE_ALREADY_ACTIVE';
    end if;
  elsif not exists (select 1 from auth.mfa_factors factor
      where factor.account_id = target.id and factor.status in ('active', 'pending')) then
    raise exception using errcode = '23514', message = 'ADMIN_MFA_NOT_ENROLLED';
  end if;
  -- A pending request past its window no longer blocks a new one.
  update auth.admin_approval_requests as request_row
  set status = 'expired', decided_at = clock_timestamp(), row_version = request_row.row_version + 1
  where request_row.action = requested_action and request_row.target_account_id = target.id
    and request_row.status = 'pending' and request_row.expires_at <= clock_timestamp();
  begin
    insert into auth.admin_approval_requests (
      id, action, target_account_id, role_code, reason, requested_by, requested_at, expires_at,
      correlation_id
    ) values (
      gen_random_uuid(), requested_action, target.id, requested_role_code, btrim(requested_reason),
      actor_account, started_at, started_at + interval '24 hours', platform.current_correlation_id()
    ) returning * into created;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'ADMIN_APPROVAL_ALREADY_PENDING';
  end;
  response := jsonb_build_object('requestId', created.id, 'status', created.status,
    'expiresAt', created.expires_at, 'version', created.row_version);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'approval.request', requested_idempotency_key, requested_sha256, response);
  return query select created.id, created.status, created.expires_at, created.row_version, false;
end
$$;
revoke all on function auth.admin_request_approval(text, uuid, text, text, text, character) from public;

create function auth.admin_decide_approval(
  requested_request_id uuid,
  expected_version bigint,
  requested_decision text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (request_id uuid, request_status text, action text, target_account_id uuid,
  executed boolean, row_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  prior auth.admin_command_idempotency%rowtype;
  request_row auth.admin_approval_requests%rowtype;
  target auth.accounts%rowtype;
  revoked_sessions integer;
  response jsonb;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_decision not in ('approve', 'reject', 'cancel')
     or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_APPROVAL_DECISION';
  end if;
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'approval.decide'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'requestId')::uuid, prior.response->>'status',
      prior.response->>'action', (prior.response->>'targetAccountId')::uuid,
      (prior.response->>'executed')::boolean, (prior.response->>'version')::bigint, true;
    return;
  end if;
  -- The row lock serializes concurrent decisions: the second decider sees the
  -- first decision and is refused, so an approval executes exactly once.
  select * into request_row from auth.admin_approval_requests where id = requested_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ADMIN_APPROVAL_NOT_FOUND'; end if;
  if request_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if request_row.status <> 'pending' then
    raise exception using errcode = '23514', message = 'ADMIN_APPROVAL_NOT_PENDING';
  end if;
  if requested_decision = 'cancel' then
    if actor_account <> request_row.requested_by then
      raise exception using errcode = '42501', message = 'ADMIN_APPROVAL_CANCEL_DENIED';
    end if;
  else
    if actor_account = request_row.requested_by or actor_account = request_row.target_account_id then
      raise exception using errcode = '42501', message = 'ADMIN_SELF_APPROVAL_DENIED';
    end if;
    -- Only an active, MFA-enrolled Super Admin may decide.
    if not exists (
      select 1 from auth.accounts account_row
      join auth.account_roles assignment on assignment.account_id = account_row.id
       and assignment.scope_type = 'platform' and assignment.revoked_at is null
       and assignment.role_code = 'platform_super_admin'
      join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
      where account_row.id = actor_account and account_row.status = 'active'
        and (account_row.disabled_until is null or account_row.disabled_until <= clock_timestamp())
    ) or not auth.account_has_active_mfa(actor_account) then
      raise exception using errcode = '42501', message = 'ADMIN_APPROVER_INELIGIBLE';
    end if;
  end if;
  perform auth.require_platform_step_up(actor_account);
  if request_row.expires_at <= clock_timestamp() then
    update auth.admin_approval_requests as expiring
    set status = 'expired', decided_at = clock_timestamp(), row_version = expiring.row_version + 1
    where expiring.id = request_row.id returning * into request_row;
    return query select request_row.id, request_row.status, request_row.action,
      request_row.target_account_id, false, request_row.row_version, false;
    return;
  end if;

  if requested_decision = 'approve' then
    select * into target from auth.accounts where id = request_row.target_account_id for update;
    if request_row.action = 'platform_role.grant' then
      if target.status <> 'active'
         or (target.disabled_until is not null and target.disabled_until > clock_timestamp()) then
        raise exception using errcode = '23514', message = 'ADMIN_TARGET_INELIGIBLE';
      end if;
      if exists (select 1 from auth.account_roles assignment where assignment.account_id = target.id
          and assignment.role_code = 'platform_super_admin' and assignment.scope_type = 'platform'
          and assignment.revoked_at is null) then
        raise exception using errcode = '23505', message = 'ADMIN_ROLE_ALREADY_ACTIVE';
      end if;
      insert into auth.account_roles (id, account_id, role_code, scope_type, granted_by, grant_reason)
      values (gen_random_uuid(), target.id, 'platform_super_admin', 'platform', actor_account,
        request_row.reason);
      update auth.accounts as account_row
      set row_version = account_row.row_version + 1, updated_at = clock_timestamp()
      where account_row.id = target.id;
    else
      update auth.mfa_factors as factor
      set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = actor_account,
          revocation_reason = 'admin_reset', row_version = factor.row_version + 1
      where factor.account_id = target.id and factor.status in ('active', 'pending');
      update auth.mfa_recovery_codes as code
      set invalidated_at = clock_timestamp(), invalidation_reason = 'factor_revoked'
      where code.account_id = target.id and code.used_at is null and code.invalidated_at is null;
      update auth.sessions as session_row
      set revoked_at = clock_timestamp(), revocation_reason = 'mfa_reset',
          row_version = session_row.row_version + 1
      where session_row.account_id = target.id and session_row.revoked_at is null;
      get diagnostics revoked_sessions = row_count;
      update auth.accounts as account_row
      set token_version = account_row.token_version + 1, row_version = account_row.row_version + 1,
          updated_at = clock_timestamp()
      where account_row.id = target.id;
      insert into auth.session_events (account_id, event_type, outcome, correlation_id, details)
      values (target.id, 'mfa_reset', 'success', platform.current_correlation_id(),
        jsonb_build_object('approvalRequestId', request_row.id, 'requestedBy', request_row.requested_by,
          'approvedBy', actor_account, 'revokedSessions', revoked_sessions));
    end if;
    update auth.admin_approval_requests as deciding
    set status = 'approved', decided_by = actor_account, decided_at = clock_timestamp(),
        executed_at = clock_timestamp(), decision_reason = btrim(requested_reason),
        row_version = deciding.row_version + 1
    where deciding.id = request_row.id returning * into request_row;
  else
    update auth.admin_approval_requests as deciding
    set status = case requested_decision when 'reject' then 'rejected' else 'cancelled' end,
        decided_by = actor_account, decided_at = clock_timestamp(),
        decision_reason = btrim(requested_reason), row_version = deciding.row_version + 1
    where deciding.id = request_row.id returning * into request_row;
  end if;
  response := jsonb_build_object('requestId', request_row.id, 'status', request_row.status,
    'action', request_row.action, 'targetAccountId', request_row.target_account_id,
    'executed', request_row.executed_at is not null, 'version', request_row.row_version);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'approval.decide', requested_idempotency_key, requested_sha256, response);
  return query select request_row.id, request_row.status, request_row.action,
    request_row.target_account_id, request_row.executed_at is not null, request_row.row_version, false;
end
$$;
revoke all on function auth.admin_decide_approval(uuid, bigint, text, text, text, character) from public;
