-- Standalone platform administration: no invented facility or clinical authority.
-- Existing staff clinical audit constraints and immutable history stay enforced.
do $$
declare item record; found_count integer := 0;
begin
  for item in select conname from pg_constraint
    where conrelid='audit.events'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%actor_type%'
      and pg_get_constraintdef(oid) like '%workload%'
      and pg_get_constraintdef(oid) like '%legacy%'
  loop
    found_count := found_count + 1;
    execute format('alter table audit.events drop constraint %I',item.conname);
  end loop;
  if found_count <> 2 then raise exception 'EXPECTED_AUDIT_CONSTRAINTS_REQUIRED'; end if;
end $$;

alter table audit.events
  add constraint audit_actor_type_ck check (actor_type in ('staff','platform','patient','workload','system','legacy')),
  add constraint audit_actor_facility_ck check (
    facility_id is not null or actor_type in ('platform','patient','workload','system','legacy')
    or (actor_type='staff' and action like 'auth.%' and resource_type in ('authentication','session'))
  ),
  add constraint audit_platform_scope_ck check (actor_type <> 'platform' or (
    actor_account_id is not null and actor_subject is not null
    and facility_id is null and actor_membership_id is null and organization_id is null and patient_id is null
    and (action like 'admin.%' or action like 'api.admin.%')
    and purpose_of_use is not null and purpose_of_use='healthcare-operations'
  ));

create function audit.authorize_platform_event() returns trigger
language plpgsql security definer set search_path = audit,auth,pg_temp as $$
begin
  if new.actor_type='platform' and (
    not auth.account_has_platform_permission(new.actor_account_id,'platform.admin.access')
    or not exists(select 1 from auth.accounts a where a.id=new.actor_account_id and a.subject=new.actor_subject)
  ) then raise exception using errcode='42501',message='PLATFORM_AUDIT_AUTHORITY_REQUIRED'; end if;
  return new;
end $$;
revoke all on function audit.authorize_platform_event() from public;
create trigger audit_platform_authority before insert on audit.events
  for each row execute function audit.authorize_platform_event();
comment on table audit.events is
  'Append-only semantic audit: clinical staff require a facility; standalone platform actors require current admin authority and administrative scope.';

-- Last-admin checks use active platform accounts and roles, independently of
-- hospital membership. Keep the shared advisory lock and command controls.
create or replace function identity.admin_transition_facility(
  requested_facility_id uuid,
  expected_version bigint,
  requested_status text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (facility_id uuid, lifecycle_status text, row_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  prior auth.admin_command_idempotency%rowtype;
  current_row identity.facilities%rowtype;
  previous_status text;
  response jsonb;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.facility.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_status not in ('verified', 'rejected', 'suspended')
     or requested_reason is null or length(btrim(requested_reason)) < 8 then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_FACILITY_TRANSITION';
  end if;
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'facility.status.transition'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'facilityId')::uuid,
      prior.response->>'status', (prior.response->>'version')::bigint, true;
    return;
  end if;
  select * into current_row from identity.facilities where id = requested_facility_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ADMIN_FACILITY_NOT_FOUND'; end if;
  if current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  previous_status := current_row.lifecycle_status;
  if previous_status = requested_status then
    raise exception using errcode = '22023', message = 'ADMIN_NO_STATE_CHANGE';
  end if;
  if previous_status = 'pending' and requested_status not in ('verified', 'rejected', 'suspended') then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_FACILITY_TRANSITION';
  end if;
  if previous_status in ('verified', 'rejected', 'suspended')
     and requested_status not in ('verified', 'suspended') then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_FACILITY_TRANSITION';
  end if;
  -- Platform authority does not depend on a hospital's eligibility.
  update identity.facilities as facility
  set lifecycle_status = requested_status, active = requested_status = 'verified',
      status_reason = btrim(requested_reason), status_changed_at = clock_timestamp(),
      status_changed_by = actor_account, updated_at = clock_timestamp(),
      row_version = facility.row_version + 1
  where facility.id = requested_facility_id returning facility.* into current_row;
  insert into identity.facility_status_events (
    facility_id, from_status, to_status, facility_version, actor_account_id, reason, correlation_id
  ) values (
    current_row.id, previous_status, current_row.lifecycle_status, current_row.row_version,
    actor_account, btrim(requested_reason), platform.current_correlation_id()
  );
  response := jsonb_build_object('facilityId', current_row.id,
    'status', current_row.lifecycle_status, 'version', current_row.row_version);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'facility.status.transition', requested_idempotency_key,
    requested_sha256, response);
  return query select current_row.id, current_row.lifecycle_status, current_row.row_version, false;
end
$$;

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
  response jsonb;
  other_super_admins bigint;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.principal.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
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
    where assignment.scope_type = 'platform' and assignment.revoked_at is null
      and assignment.role_code in ('platform_super_admin', 'platform_admin')
      and account_row.id <> current_row.id and account_row.status = 'active'
      and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
;
    if other_super_admins < 1 then
      raise exception using errcode = '23514', message = 'ADMIN_LAST_SUPER_ADMIN';
    end if;
  end if;
  update auth.accounts as account_row
  set status = requested_status,
      disabled_until = null,
      token_version = account_row.token_version + 1,
      row_version = account_row.row_version + 1,
      updated_at = clock_timestamp()
  where account_row.id = current_row.id returning account_row.* into current_row;
  if requested_status = 'disabled' then
    update auth.sessions as session_row
    set revoked_at = coalesce(session_row.revoked_at, clock_timestamp()),
        revocation_reason = coalesce(session_row.revocation_reason, 'account_suspended_by_platform_admin'),
        row_version = session_row.row_version + 1
    where session_row.account_id = current_row.id and session_row.revoked_at is null;
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
      where assignment.scope_type = 'platform' and assignment.revoked_at is null
        and assignment.role_code in ('platform_super_admin', 'platform_admin')
        and not (account_row.id = target.id and assignment.role_code = requested_role_code)
        and account_row.status = 'active'
        and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
  ;
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
