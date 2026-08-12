-- Governed HID platform-administration foundation.
-- Platform administration remains Identity-owned, capability-based, audited,
-- idempotent, and separate from clinical authority and break-glass.

insert into auth.roles (code, description) values
  ('platform_super_admin', 'Broad platform administration through governed APIs; never clinical authority'),
  ('platform_operations_admin', 'Read-only platform service and event-delivery operations'),
  ('identity_review_admin', 'Read-only Identity registration and duplicate-review oversight'),
  ('facility_review_admin', 'Governed facility review and lifecycle administration'),
  ('security_auditor', 'Read-only platform security and semantic-audit review'),
  ('support_admin', 'Constrained principal, membership, and session support')
on conflict (code) do update
  set description = excluded.description, active = true;

insert into auth.permissions (code, description) values
  ('platform.admin.access', 'Open the authenticated platform administration surface'),
  ('platform.facility.read', 'Read bounded facility administration views'),
  ('platform.facility.manage', 'Perform governed facility lifecycle transitions'),
  ('platform.principal.read', 'Read bounded principal and membership administration views'),
  ('platform.principal.manage', 'Suspend or reactivate authentication principals'),
  ('platform.session.revoke', 'Revoke active sessions for a selected principal'),
  ('platform.role.manage', 'Grant or revoke explicit platform administrative roles'),
  ('platform.identity-review.read', 'Read bounded Identity registration-review evidence'),
  ('platform.audit.read', 'Read immutable platform semantic-audit evidence'),
  ('platform.operations.read', 'Read safe service and event-delivery operational state')
on conflict (code) do update
  set description = excluded.description, active = true;

insert into auth.role_permissions (role_code, permission_code)
select mapping.role_code, mapping.permission_code
from (values
  ('platform_admin', 'platform.admin.access'),
  ('platform_admin', 'platform.facility.read'),
  ('platform_admin', 'platform.facility.manage'),
  ('platform_admin', 'platform.principal.read'),
  ('platform_admin', 'platform.principal.manage'),
  ('platform_admin', 'platform.session.revoke'),
  ('platform_admin', 'platform.role.manage'),
  ('platform_admin', 'platform.identity-review.read'),
  ('platform_admin', 'platform.audit.read'),
  ('platform_admin', 'platform.operations.read'),

  ('platform_super_admin', 'platform.admin.access'),
  ('platform_super_admin', 'platform.facility.read'),
  ('platform_super_admin', 'platform.facility.manage'),
  ('platform_super_admin', 'platform.principal.read'),
  ('platform_super_admin', 'platform.principal.manage'),
  ('platform_super_admin', 'platform.session.revoke'),
  ('platform_super_admin', 'platform.role.manage'),
  ('platform_super_admin', 'platform.identity-review.read'),
  ('platform_super_admin', 'platform.audit.read'),
  ('platform_super_admin', 'platform.operations.read'),

  ('platform_operations_admin', 'platform.admin.access'),
  ('platform_operations_admin', 'platform.operations.read'),
  ('identity_review_admin', 'platform.admin.access'),
  ('identity_review_admin', 'platform.identity-review.read'),
  ('facility_review_admin', 'platform.admin.access'),
  ('facility_review_admin', 'platform.facility.read'),
  ('facility_review_admin', 'platform.facility.manage'),
  ('security_auditor', 'platform.admin.access'),
  ('security_auditor', 'platform.audit.read'),
  ('security_auditor', 'platform.operations.read'),
  ('support_admin', 'platform.admin.access'),
  ('support_admin', 'platform.principal.read'),
  ('support_admin', 'platform.session.revoke')
) as mapping(role_code, permission_code)
on conflict (role_code, permission_code) do nothing;

alter table identity.facilities
  add column lifecycle_status text,
  add column status_reason text,
  add column status_changed_at timestamptz,
  add column status_changed_by uuid references auth.accounts(id) on delete restrict;

update identity.facilities
set lifecycle_status = case when active then 'verified' else 'suspended' end,
    status_reason = 'Migrated from the pre-foundation active flag',
    status_changed_at = coalesce(updated_at, created_at);

alter table identity.facilities
  alter column lifecycle_status set not null,
  alter column lifecycle_status set default 'pending',
  alter column active set default false,
  add constraint facilities_lifecycle_status_ck
    check (lifecycle_status in ('pending', 'verified', 'rejected', 'suspended')),
  add constraint facilities_status_reason_ck
    check (status_reason is null or length(btrim(status_reason)) between 8 and 500),
  add constraint facilities_active_status_ck
    check (active = (lifecycle_status = 'verified'));

create index facilities_admin_status_idx
  on identity.facilities (lifecycle_status, updated_at desc, id);

create table identity.facility_status_events (
  event_id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  from_status text not null check (from_status in ('pending', 'verified', 'rejected', 'suspended')),
  to_status text not null check (to_status in ('pending', 'verified', 'rejected', 'suspended')),
  facility_version bigint not null check (facility_version > 1),
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  occurred_at timestamptz not null default clock_timestamp(),
  unique (facility_id, facility_version)
);

create trigger facility_status_events_no_mutation
  before update or delete on identity.facility_status_events
  for each row execute function platform.reject_mutation();

alter table auth.account_roles
  add column grant_reason text,
  add column revoked_by uuid references auth.accounts(id) on delete restrict,
  add column revocation_reason text,
  add column row_version bigint not null default 1 check (row_version > 0);

update auth.account_roles
set grant_reason = 'Legacy assignment retained during governed administration migration'
where grant_reason is null;

-- Preserve historical revocations while making all rows satisfy the new
-- governance invariant. Older assignments did not record a revoking actor;
-- the original granting principal (or the affected principal as the final
-- fallback) is retained as provenance rather than inventing a platform admin.
update auth.account_roles
set revoked_by = coalesce(revoked_by, granted_by, account_id),
    revocation_reason = coalesce(
      revocation_reason,
      'Legacy revocation retained during governed administration migration'
    )
where revoked_at is not null
  and (revoked_by is null or revocation_reason is null);

alter table auth.account_roles
  alter column grant_reason set not null,
  add constraint account_roles_grant_reason_ck
    check (length(btrim(grant_reason)) between 8 and 500),
  add constraint account_roles_revocation_reason_ck
    check (
      (revoked_at is null and revoked_by is null and revocation_reason is null)
      or
      (revoked_at is not null and revoked_by is not null
        and length(btrim(revocation_reason)) between 8 and 500)
    );

create table auth.admin_command_idempotency (
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  operation text not null check (length(operation) between 3 and 100),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  request_sha256 char(64) not null,
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (actor_account_id, operation, idempotency_key),
  check (octet_length(response::text) <= 16384)
);

create trigger admin_command_idempotency_no_mutation
  before update or delete on auth.admin_command_idempotency
  for each row execute function platform.reject_mutation();

create or replace function auth.account_has_platform_permission(
  requested_account_id uuid,
  requested_permission text
) returns boolean
language sql
stable
security definer
set search_path = auth, pg_temp
as $$
  select exists (
    select 1
    from auth.accounts account_row
    join auth.account_roles assignment
      on assignment.account_id = account_row.id
     and assignment.scope_type = 'platform'
     and assignment.revoked_at is null
    join auth.roles role_row
      on role_row.code = assignment.role_code
     and role_row.active
    join auth.role_permissions role_permission
      on role_permission.role_code = role_row.code
    join auth.permissions permission
      on permission.code = role_permission.permission_code
     and permission.active
    where account_row.id = requested_account_id
      and account_row.status = 'active'
      and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
      and permission.code = requested_permission
  )
$$;

-- Platform review reads are still mediated by the request-scoped database
-- context. These policies add no mutation path and grant no clinical
-- permission.
create policy registration_cases_platform_review_read on identity.registration_cases
  for select using (
    auth.account_has_platform_permission(
      platform.current_account_id(), 'platform.identity-review.read'
    )
  );

create or replace function identity.admin_platform_overview()
returns table (
  registered_patients bigint,
  facilities bigint,
  verified_facilities bigint,
  suspended_facilities bigint,
  active_memberships bigint,
  pending_identity_reviews bigint
)
language plpgsql
stable
security definer
set search_path = identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return query select
    (select count(*) from identity.patients patient where patient.status <> 'deleted'),
    (select count(*) from identity.facilities),
    (select count(*) from identity.facilities facility where facility.lifecycle_status = 'verified'),
    (select count(*) from identity.facilities facility where facility.lifecycle_status = 'suspended'),
    (select count(*) from identity.staff_facility_memberships membership
      where membership.active and membership.migration_hold_reason is null),
    (select count(*) from identity.registration_cases registration
      where registration.status in ('pending_new_identity_approval', 'review_required'));
end
$$;

create policy registration_candidates_platform_review_read
  on identity.registration_case_candidates
  for select using (
    auth.account_has_platform_permission(
      platform.current_account_id(), 'platform.identity-review.read'
    )
  );

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
  other_reachable_super_admins bigint;
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
    ) then
      select count(distinct account_row.id) into other_reachable_super_admins
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
        and account_row.status = 'active'
        and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
        and staff_row.active
        and lower(staff_row.verification_status) in ('verified', 'approved', 'active')
        and membership.facility_id <> requested_facility_id
        and membership.active and membership.migration_hold_reason is null
        and facility.active and facility.lifecycle_status = 'verified'
        and organization_row.active;
      if other_reachable_super_admins < 1 then
        raise exception using errcode = '23514', message = 'ADMIN_LAST_SUPER_ADMIN';
      end if;
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

create or replace function audit.list_platform_events(
  requested_limit integer,
  before_sequence bigint default null,
  requested_actor text default null,
  requested_facility uuid default null,
  requested_action text default null,
  requested_correlation text default null,
  requested_outcome text default null,
  requested_from timestamptz default null,
  requested_to timestamptz default null
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
set search_path = audit, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.audit.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_PAGE_SIZE';
  end if;
  return query
  select event.sequence_id, event.event_id, event.occurred_at,
    event.correlation_id, event.actor_type, event.actor_subject,
    event.facility_id, event.action, event.outcome,
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
  order by event.sequence_id desc
  limit requested_limit;
end
$$;

create or replace function integration.list_terminal_event_failures(requested_limit integer)
returns table (
  event_id uuid,
  event_type text,
  producer text,
  attempt_count integer,
  error_code text,
  error_summary text,
  failed_at timestamptz,
  next_attempt_at timestamptz,
  correlation_id text
)
language sql
stable
security definer
set search_path = integration, pg_temp
as $$
  select state.event_id, envelope.event_type, state.producer,
    state.attempt_count, state.last_error_code, state.last_error_summary,
    state.failed_at, state.next_attempt_at, envelope.correlation_id
  from integration.outbox_delivery_state state
  join integration.outbox_envelopes envelope
    on envelope.producer = state.producer and envelope.event_id = state.event_id
  where state.state = 'failed_terminal'
  order by state.failed_at desc nulls last, state.event_id
  limit least(greatest(requested_limit, 1), 100)
$$;

revoke all on function auth.account_has_platform_permission(uuid, text) from public;
revoke all on function identity.admin_platform_overview() from public;
revoke all on function identity.admin_transition_facility(uuid, bigint, text, text, text, char) from public;
revoke all on function auth.admin_transition_account(uuid, bigint, text, text, text, char) from public;
revoke all on function auth.admin_change_platform_role(uuid, bigint, text, text, text, text, char) from public;
revoke all on function auth.admin_revoke_account_sessions(uuid, text, text, char) from public;
revoke all on function audit.list_platform_events(integer, bigint, text, uuid, text, text, text, timestamptz, timestamptz) from public;
revoke all on function integration.list_terminal_event_failures(integer) from public;

comment on table auth.admin_command_idempotency is
  'Identity-owned immutable replay evidence for sensitive platform administration commands.';
comment on function auth.account_has_platform_permission(uuid, text) is
  'Evaluates only explicit active platform-scoped assignments; it grants no clinical or break-glass authority.';
comment on function integration.list_terminal_event_failures(integer) is
  'Minimum-necessary terminal delivery evidence; event payloads and patient/facility context are intentionally absent.';
