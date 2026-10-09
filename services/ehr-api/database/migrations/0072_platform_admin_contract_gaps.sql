-- Phase 4 Stage 4A: platform administration contract gaps.
--
-- * audit.list_platform_events gains optional resource_type / resource_id
--   filters, so the console can show the history of one target (for example a
--   facility's platform changes). Adding parameters changes the signature, so
--   the 0067 function is dropped and recreated; runtime-grants.sql grants the
--   new signature. Both parameters default to null, so a call with the nine
--   earlier arguments resolves to the new function unchanged. Authorization,
--   result columns, the other filters and the newest-first sequence keyset are
--   the same as 0027/0067.
-- * A UUID-shaped resource id matches the canonical resource_uuid column, so
--   letter case cannot hide an event; any other id matches resource_id exactly.
--   A resource id without a resource type is refused.
-- * identity.admin_transition_facility (0027) refused to suspend a facility
--   unless another Super Admin was reachable through a staff membership at a
--   different verified facility. Platform sign-in has not depended on a staff
--   membership since 0069, so a facility status change never removes a
--   platform-session path. The guard now counts the same reachable set as the
--   account and role commands (0070): active, not suspended, holding the role,
--   with a password credential.
-- * auth.other_reachable_super_admins excluded every account when called with
--   a null excluded account (null comparison). A null now excludes nobody;
--   every existing caller passes a non-null account and is unaffected.

create or replace function auth.other_reachable_super_admins(excluded_account uuid, excluded_role text)
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
    and (excluded_account is null
      or not (account_row.id = excluded_account
        and (excluded_role is null or assignment.role_code = excluded_role)))
$$;
revoke all on function auth.other_reachable_super_admins(uuid, text) from public;

-- Same signature, result, checks, idempotency and evidence as 0027; only the
-- last-Super-Admin count changes.
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
  if previous_status = 'verified' and requested_status <> 'verified' then
    -- Serialize every mutation that can remove the final usable Super Admin
    -- path. Row locks alone are insufficient when two different accounts or
    -- facilities are changed concurrently.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('hid.platform.last-super-admin', 0)
    );
    -- A facility change removes no platform-session path, so nobody is
    -- excluded: the command is refused only while a Super Admin works here and
    -- no Super Admin at all can open a platform session.
    if exists (
      select 1
      from auth.accounts account_row
      join auth.account_roles assignment on assignment.account_id = account_row.id
      join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
      join identity.staff staff_row on staff_row.account_id = account_row.id
      join identity.staff_facility_memberships membership
        on membership.staff_id = staff_row.id and membership.account_id = account_row.id
      join identity.organizations organization_row on organization_row.id = membership.organization_id
      where assignment.scope_type = 'platform' and assignment.revoked_at is null
        and assignment.role_code in ('platform_super_admin', 'platform_admin')
        and account_row.status = 'active'
        and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
        and staff_row.active
        and lower(staff_row.verification_status) in ('verified', 'approved', 'active')
        and membership.facility_id = requested_facility_id
        and membership.active and membership.migration_hold_reason is null
        and organization_row.active
    ) and auth.other_reachable_super_admins(null, null) < 1 then
      raise exception using errcode = '23514', message = 'ADMIN_LAST_SUPER_ADMIN';
    end if;
  end if;
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
revoke all on function identity.admin_transition_facility(uuid, bigint, text, text, text, char) from public;

-- Newest-first history of one target: an equality match on the type and the
-- canonical UUID, read in sequence order without a sort. Non-UUID ids use the
-- existing audit_resource_text_idx.
create index audit_resource_uuid_sequence_idx
  on audit.events (resource_type, resource_uuid, sequence_id desc)
  where resource_uuid is not null;

drop function audit.list_platform_events(integer, bigint, text, uuid, text, text, text, timestamptz, timestamptz);

create function audit.list_platform_events(
  requested_limit integer,
  before_sequence bigint default null,
  requested_actor text default null,
  requested_facility uuid default null,
  requested_action text default null,
  requested_correlation text default null,
  requested_outcome text default null,
  requested_from timestamptz default null,
  requested_to timestamptz default null,
  requested_resource_type text default null,
  requested_resource_id text default null
) returns table (
  sequence_id bigint,
  event_id uuid,
  occurred_at timestamptz,
  correlation_id text,
  actor_type text,
  actor_subject text,
  facility_id uuid,
  patient_id uuid,
  action text,
  outcome text,
  resource_type text,
  resource_id text,
  purpose_of_use text,
  reason text,
  source_system text
)
language plpgsql
stable
security definer
-- Each call is planned for its own filters, so a target filter uses its index.
set plan_cache_mode = force_custom_plan
set search_path = audit, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  requested_uuid uuid;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.audit.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_PAGE_SIZE';
  end if;
  if (requested_resource_id is not null and requested_resource_type is null)
     or (requested_resource_type is not null and (length(requested_resource_type) > 80
       or requested_resource_type !~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'))
     or (requested_resource_id is not null and (length(requested_resource_id) > 255
       or requested_resource_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')) then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_AUDIT_FILTER';
  end if;
  if requested_resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    requested_uuid := requested_resource_id::uuid;
  end if;
  return query
  select event.sequence_id, event.event_id, event.occurred_at,
    event.correlation_id, event.actor_type, event.actor_subject,
    event.facility_id, event.patient_id, event.action, event.outcome,
    event.resource_type, event.resource_id, event.purpose_of_use,
    event.reason, event.source_system
  from audit.events event
  where (before_sequence is null or event.sequence_id < before_sequence)
    and (requested_actor is null or event.actor_subject = requested_actor)
    and (requested_facility is null or event.facility_id = requested_facility)
    and (requested_action is null or event.action = requested_action)
    and (requested_correlation is null or event.correlation_id = requested_correlation)
    and (requested_outcome is null or event.outcome = requested_outcome)
    and (requested_from is null or event.occurred_at >= requested_from)
    and (requested_to is null or event.occurred_at < requested_to)
    and (requested_resource_type is null or event.resource_type = requested_resource_type)
    and (requested_uuid is null or event.resource_uuid = requested_uuid)
    and (requested_resource_id is null or requested_uuid is not null
      or event.resource_id = requested_resource_id)
  order by event.sequence_id desc
  limit requested_limit;
end
$$;
revoke all on function audit.list_platform_events(
  integer, bigint, text, uuid, text, text, text, timestamptz, timestamptz, text, text
) from public;
