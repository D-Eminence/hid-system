-- Provider-side visibility for the governed standard access-request lifecycle.
-- The caller may see only requests created by the exact authenticated staff
-- account, membership, and facility context.

create or replace function identity.list_my_staff_access_requests(
  requested_status text default null
)
returns table (
  access_request_id uuid,
  patient_id uuid,
  scope text,
  purpose_of_use text,
  reason text,
  status text,
  requested_duration_minutes integer,
  requested_at timestamptz,
  approved_at timestamptz,
  denied_at timestamptz,
  denied_reason text
)
language plpgsql
security definer
set search_path = identity, auth, platform, pg_catalog, pg_temp
as $$
declare
  actor_subject_value text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject_value);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
begin
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or not auth.membership_has_permission(
       actor_subject_value, actor_membership_id, actor_facility_id, 'identity.consent.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized consent read context is required';
  end if;

  if requested_status is not null
     and requested_status not in ('pending', 'approved', 'denied', 'revoked', 'expired') then
    raise exception using errcode = '22023', message = 'Invalid access request status';
  end if;

  return query
  select request_row.id,
         request_row.patient_id,
         request_row.scope,
         request_row.purpose_of_use,
         request_row.reason,
         request_row.status,
         request_row.requested_duration_minutes,
         request_row.created_at,
         request_row.approved_at,
         request_row.denied_at,
         request_row.denied_reason
    from identity.access_requests request_row
   where request_row.staff_id = (
           select membership.staff_id
             from identity.staff_facility_memberships membership
            where membership.id = actor_membership_id
              and membership.account_id = actor_account_id
              and membership.facility_id = actor_facility_id
         )
     and request_row.membership_id = actor_membership_id
     and request_row.facility_id = actor_facility_id
     and request_row.break_glass = false
     and request_row.migration_hold_reason is null
     and (requested_status is null or request_row.status = requested_status)
   order by request_row.created_at desc, request_row.id desc
   limit 100;
end;
$$;

revoke all on function identity.list_my_staff_access_requests(text) from public;
