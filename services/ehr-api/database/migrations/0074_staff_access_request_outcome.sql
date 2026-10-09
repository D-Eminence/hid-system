-- Phase 4 governed access: the clinician's own access-request list reports
-- what became of each approval. A request stays 'approved' after its grant
-- expires, is revoked by the patient or is closed by the clinician, so the
-- list alone could not tell a clinician whether access still exists.
--
-- identity.list_my_staff_access_requests keeps its argument, caller checks,
-- order and 100-row limit, and gains:
-- * consent_grant_id, grant_expires_at: the grant made from the request
--   (patient approval or patient access PIN), if any;
-- * effective_status: the request's status, except for an approved request
--   with a grant, which reports whichever ended it first: 'active' (current),
--   'expired' (lapsed, whether or not a sweep marked it, and also when it was
--   revoked only after it had lapsed, for example by a later PIN change),
--   'closed' (revoked by the requesting clinician before it lapsed) or
--   'revoked' (by anyone else before it lapsed). Who revoked it is not
--   returned, and nothing done after a grant lapsed changes its outcome;
-- * authorization_method: 'patient_access_pin' or 'patient_approval'.
-- Pending requests never expire on their own; their effective status stays
-- 'pending'.
-- The status filter now matches either the request status or the effective
-- status, so 'approved' still returns every approval and 'active', 'expired',
-- 'closed' and 'revoked' return the approvals with that outcome.
--
-- The result type changes, so the function is dropped and recreated. Its
-- EXECUTE grant returns only with the role bootstrap (runtime-grants.sql):
-- until then every Identity build is refused the clinician list (403), so run
-- the bootstrap immediately after the migrations, as for 0072. After it,
-- earlier builds keep working (they select columns by name and send only the
-- request statuses), and an Identity build that reads the new columns may
-- start.
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
     and requested_status not in ('pending', 'approved', 'denied', 'revoked', 'expired', 'active', 'closed') then
    raise exception using errcode = '22023', message = 'Invalid access request status';
  end if;

  return query
  select outcome.request_id, outcome.request_patient_id, outcome.request_scope, outcome.request_purpose,
         outcome.request_reason, outcome.request_status, outcome.request_duration, outcome.request_created_at,
         outcome.request_approved_at, outcome.request_denied_at, outcome.request_denied_reason,
         outcome.grant_id, outcome.grant_expiry, outcome.outcome_status, outcome.grant_method
    from (
      select request_row.id as request_id,
             request_row.patient_id as request_patient_id,
             request_row.scope as request_scope,
             request_row.purpose_of_use as request_purpose,
             request_row.reason as request_reason,
             request_row.status as request_status,
             request_row.requested_duration_minutes as request_duration,
             request_row.created_at as request_created_at,
             request_row.approved_at as request_approved_at,
             request_row.denied_at as request_denied_at,
             request_row.denied_reason as request_denied_reason,
             grant_row.id as grant_id,
             grant_row.expires_at as grant_expiry,
             case
               when request_row.status <> 'approved' or grant_row.id is null then request_row.status
               when grant_row.status = 'active' and grant_row.expires_at > clock_timestamp() then 'active'
               -- Only a revocation before the grant lapsed ends it; a later sweep
               -- (a PIN change, account deletion) does not change its outcome.
               when grant_row.status = 'revoked' and grant_row.revoked_at < grant_row.expires_at
                    and grant_row.revoked_by = grant_row.account_id then 'closed'
               when grant_row.status = 'revoked' and grant_row.revoked_at < grant_row.expires_at then 'revoked'
               else 'expired'
             end as outcome_status,
             case
               when grant_row.id is null then null
               when grant_row.authorization_method = 'patient_access_pin' then 'patient_access_pin'
               else 'patient_approval'
             end as grant_method
        from identity.access_requests request_row
        left join lateral (
          select candidate.id, candidate.status, candidate.expires_at, candidate.revoked_at,
                 candidate.revoked_by, candidate.account_id, candidate.authorization_method
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
    ) outcome
   where requested_status is null
      or outcome.request_status = requested_status
      or outcome.outcome_status = requested_status
   order by outcome.request_created_at desc, outcome.request_id desc
   limit 100;
end;
$$;

revoke all on function identity.list_my_staff_access_requests(text) from public;
comment on function identity.list_my_staff_access_requests(text) is
  'The calling clinician''s own non-break-glass access requests at the current facility, with the outcome of each approval (0074).';
