-- Phase 4 governed access: the clinician's own access-request list reports
-- what became of each approval. A request stays 'approved' after its grant
-- expires, is revoked by the patient or is closed by the clinician, so the
-- list alone could not tell a clinician whether access still exists.
--
-- identity.list_my_staff_access_requests keeps its argument, caller checks,
-- filter (on the request's own status), order and 100-row limit, and gains:
-- * consent_grant_id, grant_expires_at: the grant made from the request
--   (patient approval or patient access PIN), if any;
-- * effective_status: the request's status, except for an approved request,
--   which reports its grant: 'active' (current), 'expired' (lapsed, whether or
--   not a sweep has marked it), 'closed' (ended by the requesting clinician)
--   or 'revoked' (ended by anyone else, such as the patient). Who revoked it is
--   not returned;
-- * authorization_method: 'patient_access_pin' or 'patient_approval'.
-- Pending requests never expire on their own; their effective status stays
-- 'pending'.
--
-- The result type changes, so the function is dropped and recreated: its
-- EXECUTE grant returns with the role bootstrap (runtime-grants.sql), which
-- must run before an Identity build that reads the new columns. Earlier
-- builds select columns by name and keep working.
--
-- consent_grants_request_idx serves the per-request grant lookup. It is built
-- without CONCURRENTLY (inside the migration transaction) and holds a SHARE
-- lock on identity.consent_grants while it builds: new grants wait, reads
-- continue.

create index consent_grants_request_idx
  on identity.consent_grants (request_id, created_at desc)
  where request_id is not null;

drop function identity.list_my_staff_access_requests(text);

create function identity.list_my_staff_access_requests(
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
  denied_reason text,
  consent_grant_id uuid,
  grant_expires_at timestamptz,
  effective_status text,
  authorization_method text
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
         request_row.denied_reason,
         grant_row.id,
         grant_row.expires_at,
         case
           when request_row.status <> 'approved' or grant_row.id is null then request_row.status
           when grant_row.status = 'active' and grant_row.expires_at > clock_timestamp() then 'active'
           when grant_row.status = 'revoked' and grant_row.revoked_by = grant_row.account_id then 'closed'
           when grant_row.status = 'revoked' then 'revoked'
           else 'expired'
         end,
         case
           when grant_row.id is null then null
           when grant_row.authorization_method = 'patient_access_pin' then 'patient_access_pin'
           else 'patient_approval'
         end
    from identity.access_requests request_row
    left join lateral (
      select candidate.id, candidate.status, candidate.expires_at, candidate.revoked_by,
             candidate.account_id, candidate.authorization_method
        from identity.consent_grants candidate
       where candidate.request_id = request_row.id
       order by candidate.created_at desc
       limit 1
    ) grant_row on true
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
comment on function identity.list_my_staff_access_requests(text) is
  'The calling clinician''s own non-break-glass access requests at the current facility, with the outcome of each approval (0074).';
