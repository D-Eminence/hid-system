-- Platform administration is platform-scoped, not facility-scoped.
--
-- Platform Admin routes act on the whole platform. Before this migration the
-- Identity API borrowed the administrator's own facility membership to satisfy
-- audit rules written for facility work. Without that borrowed facility, a
-- successful admin request failed its audit write.
--
-- This migration records platform scope explicitly and keeps facility-scoped
-- audit rules unchanged:
--   * audit.events.access_scope = 'platform' marks a staff action with no
--     facility. Only that marker relaxes the facility requirement.
--   * A trigger checks every platform-scoped row when it is written. The actor
--     must be a staff account; facility and membership must be null; a
--     successful row requires an active platform.admin.access grant. Denied and
--     failed attempts stay recordable as evidence.
--   * SQL commands running in a platform-scoped transaction
--     (app.access_scope = 'platform') get their facility-less staff rows
--     marked as platform scope by that trigger.
--   * The organization application admin gate no longer requires a facility
--     membership in platform scope; it still requires the platform permission.
--   * audit.list_platform_events returns the patient_id its contract declares.
--     The 0027 query omitted it, so every call failed.

create function platform.current_access_scope()
returns text
language plpgsql
stable
as $$
declare
  value text := nullif(current_setting('app.access_scope', true), '');
begin
  if value is null then
    return null;
  end if;
  if value not in ('facility', 'platform') then
    raise exception using errcode = '22023', message = 'Invalid access scope request context';
  end if;
  return value;
end;
$$;
revoke all on function platform.current_access_scope() from public;

alter table audit.events add column access_scope text
  check (access_scope is null or access_scope in ('facility', 'platform'));
comment on column audit.events.access_scope is
  'platform marks a facility-less staff action taken under platform administration authority; null keeps the per-actor rules from 0003.';

-- Replace the two staff rules that demanded a facility so that an explicit
-- platform scope is the only new exception. Their generated names are not a
-- stable contract, so they are matched by definition. The exception is written
-- with IS NOT DISTINCT FROM: a plain "access_scope = 'platform'" is NULL for
-- ordinary rows and would make the whole CHECK pass.
do $$
declare
  matching_constraint record;
  replaced integer := 0;
begin
  for matching_constraint in
    select existing_constraint.conname
      from pg_constraint existing_constraint
     where existing_constraint.conrelid = 'audit.events'::regclass
       and existing_constraint.contype = 'c'
       and pg_get_constraintdef(existing_constraint.oid) like '%facility_id IS NOT NULL%'
       and pg_get_constraintdef(existing_constraint.oid) not like '%access_scope%'
  loop
    execute format('alter table audit.events drop constraint %I', matching_constraint.conname);
    replaced := replaced + 1;
  end loop;
  if replaced <> 2 then
    raise exception 'Expected to replace the 2 staff facility audit checks, found %', replaced;
  end if;
end
$$;

alter table audit.events add constraint events_staff_facility_scope_check check (
  facility_id is not null
  or actor_type in ('patient', 'workload', 'system', 'legacy')
  or (actor_type = 'staff' and action like 'auth.%' and resource_type in ('authentication', 'session'))
  or access_scope is not distinct from 'platform'
) not valid;
alter table audit.events add constraint events_staff_membership_scope_check check (
  actor_type <> 'staff'
  or action like 'auth.%'
  or (actor_account_id is not null and actor_membership_id is not null and facility_id is not null)
  or access_scope is not distinct from 'platform'
) not valid;
alter table audit.events add constraint events_platform_scope_shape_check check (
  access_scope is distinct from 'platform'
  or (actor_type = 'staff' and actor_subject is not null and actor_account_id is not null
    and actor_membership_id is null and facility_id is null)
) not valid;
alter table audit.events validate constraint events_staff_facility_scope_check;
alter table audit.events validate constraint events_staff_membership_scope_check;
alter table audit.events validate constraint events_platform_scope_shape_check;

create function audit.enforce_platform_access_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, audit, auth, platform, pg_temp
as $$
begin
  if new.access_scope is null
     and new.actor_type = 'staff'
     and new.facility_id is null
     and new.actor_membership_id is null
     and platform.current_access_scope() = 'platform' then
    new.access_scope := 'platform';
  end if;
  if new.access_scope = 'platform' then
    if new.actor_type <> 'staff' or new.actor_account_id is null
       or new.facility_id is not null or new.actor_membership_id is not null then
      raise exception using errcode = '23514', message = 'AUDIT_PLATFORM_SCOPE_INVALID';
    end if;
    if new.outcome = 'success'
       and not auth.account_has_platform_permission(new.actor_account_id, 'platform.admin.access') then
      raise exception using errcode = '42501', message = 'AUDIT_PLATFORM_SCOPE_DENIED';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function audit.enforce_platform_access_scope() from public;

create trigger audit_events_platform_scope
  before insert on audit.events
  for each row execute function audit.enforce_platform_access_scope();

comment on table audit.events is
  'Append-only semantic audit. Staff clinical/identity actions require a facility; facility-less staff rows are limited to auth lifecycle actions and to platform-scoped administration (access_scope = platform).';

-- Same signature, result columns, authorization, filters and ordering as 0027.
-- The query now also selects patient_id, which the declared result includes.
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
  order by event.sequence_id desc
  limit requested_limit;
end
$$;

-- The onboarding gate keeps its 0046 checks for facility-scoped callers. A
-- platform-scoped call is authorized by the platform permission alone, which
-- already requires an active, unsuspended account.
create or replace function identity.organization_application_admin_account(requested_permission text)
returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or (platform.current_access_scope() is distinct from 'platform'
       and not identity.has_active_membership(
         platform.current_actor_subject(), platform.current_membership_id(), platform.current_facility_id()
       ))
     or not auth.account_has_platform_permission(actor_account, requested_permission) then
    raise exception using errcode = '42501', message = 'Organization onboarding administration is required';
  end if;
  return actor_account;
end;
$$;
revoke all on function identity.organization_application_admin_account(text) from public;
