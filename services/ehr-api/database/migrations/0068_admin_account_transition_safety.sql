-- Platform account status commands cannot bypass account recovery.
--
-- 0027's generic admin status command could set any account to 'active'. That
-- included 'pending_reset' and 'locked' accounts, which skipped the
-- OTP-verified reset that 0029 requires (patient logins included). Disabling
-- and then re-enabling an account had the same effect. The command also let an
-- administrator change their own status, and the role command let them change
-- their own platform roles.
--
-- Minimum correction, without redesigning account management:
--   * an administrator cannot run either command on their own account;
--   * 'disabled' is accepted from active, pending_reset or locked, and records
--     the prior status;
--   * 'active' is accepted only from 'disabled' and restores the recorded prior
--     status. A pending_reset or locked account stays in that state and must
--     still complete its own recovery. A disabled account with no recorded
--     prior status (disabled before this migration) returns as pending_reset,
--     which requires the verified reset before sign-in;
--   * pending_reset and locked cannot become 'active' through this command;
--   * a request that changes nothing is rejected, and activation no longer
--     clears a timed suspension (disabled_until).
-- Signatures, idempotency, versioning, the last-Super-Admin protection and
-- session revocation are unchanged.

alter table auth.accounts add column disabled_from_status text
  check (disabled_from_status is null or disabled_from_status in ('active', 'pending_reset', 'locked'));
alter table auth.accounts add constraint accounts_disabled_from_status_requires_disabled
  check (disabled_from_status is null or status = 'disabled');
comment on column auth.accounts.disabled_from_status is
  'Status recorded when a platform administrator disabled the account; restored on re-enable.';

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
  other_super_admins bigint;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.principal.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  -- Administrators cannot change their own account status.
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
    -- pending_reset and locked accounts recover only through their own
    -- verified recovery path, never through this generic command.
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
    select count(distinct account_row.id) into other_super_admins
    from auth.accounts account_row
    join auth.account_roles assignment on assignment.account_id = account_row.id
    join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
    join identity.staff staff_row on staff_row.account_id = account_row.id
    join identity.staff_facility_memberships membership
      on membership.staff_id = staff_row.id and membership.account_id = account_row.id
    join identity.facilities facility on facility.id = membership.facility_id
    join identity.organizations organization_row on organization_row.id = membership.organization_id
    where assignment.scope_type = 'platform' and assignment.revoked_at is null
      and assignment.role_code in ('platform_super_admin', 'platform_admin')
      and account_row.id <> current_row.id and account_row.status = 'active'
      and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
      and staff_row.active
      and lower(staff_row.verification_status) in ('verified', 'approved', 'active')
      and membership.active and membership.migration_hold_reason is null
      and facility.active and facility.lifecycle_status = 'verified'
      and organization_row.active;
    if other_super_admins < 1 then
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

-- 0027's role command, unchanged except that an administrator cannot grant or
-- revoke their own platform roles.
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
  other_super_admins bigint;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.role.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  -- Administrators cannot grant or revoke their own platform roles.
  if requested_account_id = actor_account then
    raise exception using errcode = '42501', message = 'ADMIN_SELF_CHANGE_DENIED';
  end if;
  if requested_role_code not in ('platform_super_admin', 'platform_operations_admin',
      'identity_review_admin', 'facility_review_admin', 'security_auditor', 'support_admin')
     or requested_action not in ('grant', 'revoke')
     or requested_reason is null or length(btrim(requested_reason)) < 8 then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_ROLE_COMMAND';
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
      select count(distinct account_row.id) into other_super_admins
      from auth.accounts account_row
      join auth.account_roles assignment on assignment.account_id = account_row.id
      join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
      join identity.staff staff_row on staff_row.account_id = account_row.id
      join identity.staff_facility_memberships membership
        on membership.staff_id = staff_row.id and membership.account_id = account_row.id
      join identity.facilities facility on facility.id = membership.facility_id
      join identity.organizations organization_row on organization_row.id = membership.organization_id
      where assignment.scope_type = 'platform' and assignment.revoked_at is null
        and assignment.role_code in ('platform_super_admin', 'platform_admin')
        and not (account_row.id = target.id and assignment.role_code = requested_role_code)
        and account_row.status = 'active'
        and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
        and staff_row.active
        and lower(staff_row.verification_status) in ('verified', 'approved', 'active')
        and membership.active and membership.migration_hold_reason is null
        and facility.active and facility.lifecycle_status = 'verified'
        and organization_row.active;
      if other_super_admins < 1 then
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
