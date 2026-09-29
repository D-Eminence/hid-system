-- Patient-controlled approval and denial for standard provider access requests.
-- Uses the canonical patient account binding and existing consent tables.
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
  grant_id_value uuid;
  expires_at_value timestamptz;
  replayed boolean := false;
begin
  if actor_account_id is null or actor_correlation_id is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  select id into patient_id_value
    from identity.patients
   where account_id = actor_account_id
     and status = 'active'
   limit 1;
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  select * into request_row
    from identity.access_requests
   where id = request_id
     and patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The access request is unavailable';
  end if;

  if request_row.status = 'approved' then
    select id, expires_at into grant_id_value, expires_at_value
      from identity.consent_grants
     where request_id = request_row.id
       and patient_id = patient_id_value
       and status = 'active'
     order by created_at desc
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

  expires_at_value := clock_timestamp() + make_interval(mins => request_row.requested_duration_minutes);
  grant_id_value := gen_random_uuid();

  update identity.access_requests
     set status = 'approved',
         approved_by_patient_id = patient_id_value,
         approved_at = clock_timestamp(),
         updated_at = clock_timestamp(),
         row_version = row_version + 1
   where id = request_row.id
     and status = 'pending';

  if not found then
    raise exception using errcode = '55000', message = 'The access request changed before approval';
  end if;

  insert into identity.consent_grants (
    id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
    scope, status, granted_by_patient_id, reason, starts_at, expires_at,
    break_glass, correlation_id
  ) values (
    grant_id_value, request_row.id, patient_id_value, request_row.staff_id,
    (select account_id from identity.staff_facility_memberships
      where id = request_row.membership_id and facility_id = request_row.facility_id),
    request_row.membership_id, request_row.facility_id, request_row.scope,
    'active', patient_id_value, request_row.reason, clock_timestamp(),
    expires_at_value, false, actor_correlation_id
  );

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'patient', actor_subject, actor_account_id, patient_id_value,
    request_row.facility_id, 'identity.access-request.approve', 'success',
    'access-request', request_row.id::text, 'direct-care',
    request_row.reason, 'application', 'identity-api',
    jsonb_build_object('consent_grant_id', grant_id_value,
      'scope', request_row.scope, 'expires_at', expires_at_value)
  );

  return query select request_row.id, grant_id_value, patient_id_value,
    'approved'::text, expires_at_value, false;
end;
$$;

create or replace function identity.deny_access_request(request_id uuid, requested_reason text)
returns table (
  access_request_id uuid,
  patient_id uuid,
  status text,
  denied_at timestamptz,
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
  denied_at_value timestamptz;
begin
  if actor_account_id is null or actor_correlation_id is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;
  if length(btrim(coalesce(requested_reason, ''))) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'A denial reason is required';
  end if;

  select id into patient_id_value
    from identity.patients
   where account_id = actor_account_id
     and status = 'active'
   limit 1;
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  select * into request_row
    from identity.access_requests
   where id = request_id
     and patient_id = patient_id_value
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
  update identity.access_requests
     set status = 'denied',
         denied_at = denied_at_value,
         denied_reason = btrim(requested_reason),
         updated_at = denied_at_value,
         row_version = row_version + 1
   where id = request_row.id
     and status = 'pending';
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
    'access-request', request_row.id::text, 'direct-care',
    btrim(requested_reason), 'application', 'identity-api',
    jsonb_build_object('scope', request_row.scope)
  );

  return query select request_row.id, patient_id_value, 'denied'::text,
    denied_at_value, false;
end;
$$;

revoke all on function identity.approve_access_request(uuid) from public;
revoke all on function identity.deny_access_request(uuid, text) from public;
