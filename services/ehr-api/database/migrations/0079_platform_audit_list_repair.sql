-- The admin console's Audit page works.
--
-- 0027 declared audit.list_platform_events with fifteen result columns, the
-- eighth being patient_id, but its query selected fourteen and left patient_id
-- out. So every call failed with "structure of query does not match function
-- result type" before returning a row, and GET /admin/audit/events could not
-- work. This selects patient_id in its declared position and keeps the
-- signature, permission check, page-size check and newest-first keyset (main
-- 0067, D-Eminence/hid-system#18; only this function, since Novu 0064 replaced
-- the rest of that migration's platform scope model). CREATE OR REPLACE keeps
-- the owner and the grants from runtime-grants.sql. Applied migrations 0001
-- through 0078 are immutable.
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
