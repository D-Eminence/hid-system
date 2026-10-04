-- Repair approval against the existing exact-request purpose constraint and
-- add patient-owned revocation and context reads. Historical SQL is unchanged.
create or replace function identity.approve_access_request(request_id uuid)
returns table (
  access_request_id uuid,
  consent_grant_id uuid,
  patient_id uuid,
  status text,
  expires_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = identity, auth, audit, platform, pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_correlation_id text := platform.current_correlation_id();
  patient_id_value uuid;
  request_row identity.access_requests%rowtype;
  requester_account_id uuid;
  requester_subject text;
  grant_id_value uuid;
  expires_at_value timestamptz;
  replayed boolean := false;
begin
  if actor_account_id is null or actor_correlation_id is null
     or platform.current_purpose_of_use() is distinct from 'direct-care' then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  select patient_row.id into patient_id_value
    from identity.patients patient_row
   where patient_row.account_id = actor_account_id
     and patient_row.status = 'active'
   limit 1;
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  select request_value.* into request_row
    from identity.access_requests request_value
   where request_value.id = request_id
     and request_value.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The access request is unavailable';
  end if;

  if request_row.status = 'approved' then
    select grant_value.id, grant_value.expires_at into grant_id_value, expires_at_value
      from identity.consent_grants grant_value
     where grant_value.request_id = request_row.id
       and grant_value.patient_id = patient_id_value
       and grant_value.status = 'active'
       and grant_value.expires_at > clock_timestamp()
     order by grant_value.created_at desc
     limit 1;
    if grant_id_value is not null then
      replayed := true;
      return query select request_row.id, grant_id_value, patient_id_value,
        'approved'::text, expires_at_value, replayed;
      return;
    end if;
  end if;

  if request_row.status <> 'pending' or request_row.break_glass then
    raise exception using errcode = '55000', message = 'The access request is no longer pending';
  end if;

  if request_row.facility_id is null or request_row.migration_hold_reason is not null then
    raise exception using errcode = '55000', message = 'The access request is not eligible for approval';
  end if;

  select membership.account_id, account_row.subject
    into requester_account_id, requester_subject
    from identity.staff_facility_memberships membership
    join auth.accounts account_row on account_row.id = membership.account_id
   where membership.id = request_row.membership_id
     and membership.staff_id = request_row.staff_id
     and membership.facility_id = request_row.facility_id;
  if requester_account_id is null or not identity.has_active_membership(
    requester_subject, request_row.membership_id, request_row.facility_id
  ) then
    raise exception using errcode = '55000', message = 'The requesting staff membership is unavailable';
  end if;

  expires_at_value := clock_timestamp() + make_interval(mins => request_row.requested_duration_minutes);
  grant_id_value := gen_random_uuid();

  update identity.access_requests request_value
     set status = 'approved',
         approved_by_patient_id = patient_id_value,
         approved_at = clock_timestamp(),
         updated_at = clock_timestamp(),
         row_version = row_version + 1
   where request_value.id = request_row.id
     and request_value.status = 'pending';

  if not found then
    raise exception using errcode = '55000', message = 'The access request changed before approval';
  end if;

  insert into identity.consent_grants (
    id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
    scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at,
    break_glass, correlation_id
  ) values (
    grant_id_value, request_row.id, patient_id_value, request_row.staff_id,
    requester_account_id,
    request_row.membership_id, request_row.facility_id, request_row.scope,
    request_row.purpose_of_use, 'active', patient_id_value, request_row.reason, clock_timestamp(),
    expires_at_value, false, actor_correlation_id
  );

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'patient', actor_subject, actor_account_id, patient_id_value,
    request_row.facility_id, 'identity.access-request.approve', 'success',
    'access-request', request_row.id::text, request_row.purpose_of_use,
    request_row.reason, 'application', 'identity-api',
    jsonb_build_object('consent_grant_id', grant_id_value,
      'scope', request_row.scope, 'expires_at', expires_at_value)
  );

  return query select request_row.id, grant_id_value, patient_id_value,
    'approved'::text, expires_at_value, false;
end;
$$;

-- The accepted 0035 denial command also used unqualified columns that clash
-- with RETURNS TABLE output names. Keep its patient-owned transition and
-- idempotent replay, with exact purpose and a qualified patient lookup.
create or replace function identity.deny_access_request(request_id uuid, requested_reason text)
returns table (
  access_request_id uuid, patient_id uuid, status text,
  denied_at timestamptz, replayed boolean
)
language plpgsql security definer
set search_path = identity, auth, audit, platform, pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_correlation_id text := platform.current_correlation_id();
  patient_id_value uuid;
  request_row identity.access_requests%rowtype;
  denied_at_value timestamptz;
begin
  if actor_account_id is null or actor_correlation_id is null
     or platform.current_purpose_of_use() is distinct from 'direct-care' then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;
  if length(btrim(coalesce(requested_reason, ''))) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'A denial reason is required';
  end if;

  select patient_row.id into patient_id_value
    from identity.patients patient_row
   where patient_row.account_id = actor_account_id and patient_row.status = 'active'
   limit 1;
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  select request_value.* into request_row
    from identity.access_requests request_value
   where request_value.id = request_id and request_value.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The access request is unavailable';
  end if;
  if request_row.status = 'denied' then
    return query select request_row.id, patient_id_value, 'denied'::text,
      request_row.denied_at, true;
    return;
  end if;
  if request_row.status <> 'pending' or request_row.break_glass then
    raise exception using errcode = '55000', message = 'The access request is no longer pending';
  end if;

  denied_at_value := clock_timestamp();
  update identity.access_requests request_value
     set status = 'denied', denied_at = denied_at_value,
         denied_reason = btrim(requested_reason), updated_at = denied_at_value,
         row_version = row_version + 1
   where request_value.id = request_row.id and request_value.status = 'pending';
  if not found then
    raise exception using errcode = '55000', message = 'The access request changed before denial';
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'patient', actor_subject, actor_account_id, patient_id_value,
    request_row.facility_id, 'identity.access-request.deny', 'success',
    'access-request', request_row.id::text, request_row.purpose_of_use,
    btrim(requested_reason), 'application', 'identity-api',
    jsonb_build_object('scope', request_row.scope)
  );
  return query select request_row.id, patient_id_value, 'denied'::text,
    denied_at_value, false;
end;
$$;

create function identity.list_my_access_request_context()
returns table (
  access_request_id uuid, patient_id uuid,
  organization_id uuid, organization_name text,
  facility_id uuid, facility_name text,
  staff_id uuid, staff_name text,
  purpose_of_use text, scope text, reason text, status text,
  requested_duration_minutes integer, requested_at timestamptz,
  approved_at timestamptz, denied_at timestamptz, denied_reason text,
  consent_grant_id uuid, expires_at timestamptz
)
language plpgsql security definer
set search_path = identity, auth, platform, pg_catalog, pg_temp
as $$
declare
  actor_account_id uuid := auth.account_id_for_subject(platform.current_actor_subject());
  patient_id_value uuid;
begin
  if actor_account_id is null or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'direct-care' then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;
  select patient_row.id into patient_id_value
    from identity.patients patient_row
   where patient_row.account_id = actor_account_id and patient_row.status = 'active';
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  return query
  select request_row.id, request_row.patient_id,
         organization_row.id, organization_row.name,
         facility.id, facility.name, staff_row.id, staff_row.full_name,
         request_row.purpose_of_use, request_row.scope, request_row.reason,
         case when request_row.status = 'approved' and grant_row.status = 'revoked' then 'revoked'
              when request_row.status = 'approved' and grant_row.expires_at <= clock_timestamp() then 'expired'
              else request_row.status end,
         request_row.requested_duration_minutes, request_row.created_at,
         request_row.approved_at, request_row.denied_at, request_row.denied_reason,
         grant_row.id, grant_row.expires_at
    from identity.access_requests request_row
    join identity.staff staff_row on staff_row.id = request_row.staff_id
    join identity.staff_facility_memberships membership
      on membership.id = request_row.membership_id
     and membership.staff_id = staff_row.id
     and membership.facility_id = request_row.facility_id
    join identity.facilities facility on facility.id = request_row.facility_id
     and facility.organization_id = membership.organization_id
    join identity.organizations organization_row on organization_row.id = facility.organization_id
    left join lateral (
      select grant_value.id, grant_value.status, grant_value.expires_at
        from identity.consent_grants grant_value
       where grant_value.request_id = request_row.id
         and grant_value.patient_id = request_row.patient_id
       order by grant_value.created_at desc, grant_value.id desc
       limit 1
    ) grant_row on true
   where request_row.patient_id = patient_id_value
     and not request_row.break_glass
     and request_row.migration_hold_reason is null
   order by request_row.created_at desc, request_row.id desc
   limit 100;
end;
$$;

create function identity.revoke_my_consent_grant(
  requested_grant_id uuid, requested_reason text
)
returns table (
  consent_grant_id uuid, subject_patient_id uuid, grant_status text,
  closed_at timestamptz, already_closed boolean
)
language plpgsql security definer
set search_path = identity, auth, audit, platform, pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_correlation_id text := platform.current_correlation_id();
  patient_id_value uuid;
  grant_row identity.consent_grants%rowtype;
  closed_at_value timestamptz;
  replayed boolean := false;
begin
  if actor_account_id is null or actor_correlation_id is null
     or platform.current_purpose_of_use() is distinct from 'direct-care' then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;
  if length(coalesce(btrim(requested_reason), '')) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'A grant revocation reason is required';
  end if;
  select patient_row.id into patient_id_value
    from identity.patients patient_row
   where patient_row.account_id = actor_account_id and patient_row.status = 'active';
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  select * into grant_row from identity.consent_grants
   where id = requested_grant_id and patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Consent grant is not available';
  end if;
  if grant_row.status = 'active' then
    closed_at_value := clock_timestamp();
    update identity.consent_grants
       set status = 'revoked', revoked_at = closed_at_value,
           revoked_by = actor_account_id, revoked_reason = btrim(requested_reason),
           updated_at = closed_at_value, row_version = row_version + 1
     where id = requested_grant_id and patient_id = patient_id_value and status = 'active';
  elsif grant_row.status = 'revoked' and grant_row.revoked_by = actor_account_id then
    closed_at_value := grant_row.revoked_at;
    replayed := true;
  else
    raise exception using errcode = '55000', message = 'The consent grant is not active';
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    patient_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'patient', actor_subject, actor_account_id,
    patient_id_value, grant_row.facility_id,
    case when replayed then 'identity.patient.consent-grant.revoke.replay'
         else 'identity.patient.consent-grant.revoke' end,
    'success', 'consent-grant', requested_grant_id::text,
    grant_row.purpose_of_use, btrim(requested_reason),
    'application', 'identity-api',
    jsonb_build_object('access_request_id', grant_row.request_id, 'already_closed', replayed)
  );

  return query select requested_grant_id, patient_id_value, 'revoked'::text,
    closed_at_value, replayed;
end;
$$;

revoke all on function identity.list_my_access_request_context() from public;
revoke all on function identity.revoke_my_consent_grant(uuid, text) from public;
