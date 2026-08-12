-- Governed consent commands and facility-scoped audit reads.
--
-- These security-definer functions are the database authorization boundary for
-- consent state transitions. They revalidate the exact request context and
-- append the semantic audit event in the same transaction as the state change.

insert into auth.permissions (code, description) values
  ('identity.break-glass.write', 'Activate a time-limited emergency access grant');

insert into auth.role_permissions (role_code, permission_code)
select mapping.role_code, mapping.permission_code
from (values
  ('doctor', 'identity.consent.write'),
  ('clinician', 'identity.consent.write'),
  ('nurse', 'identity.consent.write'),
  ('lab', 'identity.consent.write'),
  ('pharmacist', 'identity.consent.write'),
  ('receptionist', 'identity.consent.write'),
  ('doctor', 'identity.break-glass.write'),
  ('clinician', 'identity.break-glass.write'),
  ('nurse', 'identity.break-glass.write')
) as mapping(role_code, permission_code);

create or replace function auth.membership_has_permission(
  request_subject text,
  request_membership_id uuid,
  request_facility_id uuid,
  requested_permission text
)
returns boolean
language sql
stable
security definer
set search_path = auth, identity, pg_temp
as $$
  select
    identity.has_active_membership(request_subject, request_membership_id, request_facility_id)
    and exists (
      select 1
      from auth.accounts account_row
      join identity.staff_facility_memberships membership
        on membership.account_id = account_row.id
       and membership.id = request_membership_id
       and membership.facility_id = request_facility_id
      join auth.account_roles assignment
        on assignment.account_id = account_row.id
       and assignment.membership_id = membership.id
       and assignment.facility_id = membership.facility_id
       and assignment.scope_type = 'facility'
       and assignment.revoked_at is null
      join auth.roles role_row
        on role_row.code = assignment.role_code
       and role_row.active
      join auth.role_permissions role_permission
        on role_permission.role_code = role_row.code
       and role_permission.permission_code = requested_permission
      join auth.permissions permission_row
        on permission_row.code = role_permission.permission_code
       and permission_row.active
      where account_row.subject = request_subject
        and account_row.status = 'active'
        and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
    )
$$;

create or replace function identity.create_access_request(
  requested_hid text,
  requested_scope text,
  requested_reason text,
  requested_duration_minutes integer
)
returns table (
  access_request_id uuid,
  subject_patient_id uuid,
  request_status text,
  request_scope text,
  request_purpose text,
  duration_minutes integer,
  requested_at timestamptz,
  existing_request boolean
)
language plpgsql
security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_staff_id uuid;
  actor_organization_id uuid;
  patient_id_value uuid;
  request_id_value uuid;
  request_created_at timestamptz;
  request_duration_value integer;
  replayed boolean := false;
begin
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.consent.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized consent command context is required';
  end if;
  if actor_purpose not in ('direct-care', 'healthcare-operations')
     or not exists (
       select 1 from identity.purpose_of_use_codes purpose
       where purpose.code = actor_purpose and purpose.active
     ) then
    raise exception using errcode = '22023', message = 'Invalid purpose for a standard access request';
  end if;
  if requested_scope not in ('read_records', 'write_records') then
    raise exception using errcode = '22023', message = 'Invalid access request scope';
  end if;
  if requested_duration_minutes not between 5 and 1440 then
    raise exception using errcode = '22023', message = 'Invalid access request duration';
  end if;
  if length(coalesce(btrim(requested_reason), '')) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'Invalid access request reason';
  end if;

  select membership.staff_id, membership.organization_id
    into actor_staff_id, actor_organization_id
  from identity.staff_facility_memberships membership
  where membership.id = actor_membership_id
    and membership.account_id = actor_account_id
    and membership.facility_id = actor_facility_id;
  if actor_staff_id is null then
    raise exception using errcode = '42501', message = 'Exact staff membership is required';
  end if;

  select patient_row.id
    into patient_id_value
  from identity.patients patient_row
  where upper(patient_row.hid_code) = upper(btrim(requested_hid))
    and patient_row.status = 'active'
  limit 1;
  if patient_id_value is null then
    raise exception using errcode = 'P0002', message = 'Patient is not available';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    patient_id_value::text || ':' || actor_membership_id::text || ':' || requested_scope || ':' || actor_purpose, 0
  ));

  select request_row.id, request_row.created_at, request_row.requested_duration_minutes
    into request_id_value, request_created_at, request_duration_value
  from identity.access_requests request_row
  where request_row.patient_id = patient_id_value
    and request_row.membership_id = actor_membership_id
    and request_row.facility_id = actor_facility_id
    and request_row.scope = requested_scope
    and request_row.purpose_of_use = actor_purpose
    and request_row.status = 'pending'
    and not request_row.break_glass
    and request_row.migration_hold_reason is null
  order by request_row.created_at desc
  limit 1;

  if request_id_value is null then
    request_id_value := gen_random_uuid();
    request_duration_value := requested_duration_minutes;
    insert into identity.access_requests (
      id, patient_id, staff_id, membership_id, facility_id, scope,
      purpose_of_use, reason, status, requested_duration_minutes,
      break_glass, correlation_id
    ) values (
      request_id_value, patient_id_value, actor_staff_id, actor_membership_id,
      actor_facility_id, requested_scope, actor_purpose, btrim(requested_reason),
      'pending', requested_duration_minutes, false, actor_correlation_id
    )
    returning created_at into request_created_at;
  else
    replayed := true;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id,
    actor_membership_id, actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.access-request.replay' else 'identity.access-request.create' end,
    'success', 'access-request', request_id_value::text, actor_purpose,
    btrim(requested_reason), 'application', 'ehr-api',
    jsonb_build_object(
      'scope', requested_scope,
      'duration_minutes', request_duration_value,
      'existing_request', replayed
    )
  );

  return query select
    request_id_value, patient_id_value, 'pending'::text, requested_scope,
    actor_purpose, request_duration_value, request_created_at, replayed;
end;
$$;

create or replace function identity.activate_break_glass(
  requested_hid text,
  requested_reason text,
  requested_duration_minutes integer
)
returns table (
  access_request_id uuid,
  consent_grant_id uuid,
  subject_patient_id uuid,
  grant_status text,
  expires_at timestamptz,
  existing_grant boolean
)
language plpgsql
security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_staff_id uuid;
  actor_organization_id uuid;
  patient_id_value uuid;
  request_id_value uuid;
  grant_id_value uuid;
  grant_expires_at timestamptz;
  replayed boolean := false;
begin
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.break-glass.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized break-glass context is required';
  end if;
  if actor_purpose <> 'emergency'
     or not exists (
       select 1 from identity.purpose_of_use_codes purpose
       where purpose.code = 'emergency' and purpose.active
     ) then
    raise exception using errcode = '22023', message = 'Break-glass requires the emergency purpose of use';
  end if;
  if requested_duration_minutes not between 5 and 240 then
    raise exception using errcode = '22023', message = 'Invalid break-glass duration';
  end if;
  if length(coalesce(btrim(requested_reason), '')) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'An explicit break-glass reason is required';
  end if;

  select membership.staff_id, membership.organization_id
    into actor_staff_id, actor_organization_id
  from identity.staff_facility_memberships membership
  where membership.id = actor_membership_id
    and membership.account_id = actor_account_id
    and membership.facility_id = actor_facility_id;
  if actor_staff_id is null then
    raise exception using errcode = '42501', message = 'Exact staff membership is required';
  end if;

  select patient_row.id
    into patient_id_value
  from identity.patients patient_row
  where upper(patient_row.hid_code) = upper(btrim(requested_hid))
    and patient_row.status = 'active'
  limit 1;
  if patient_id_value is null then
    raise exception using errcode = 'P0002', message = 'Patient is not available';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    patient_id_value::text || ':' || actor_membership_id::text || ':break-glass', 0
  ));

  select grant_row.request_id, grant_row.id, grant_row.expires_at
    into request_id_value, grant_id_value, grant_expires_at
  from identity.consent_grants grant_row
  where grant_row.patient_id = patient_id_value
    and grant_row.account_id = actor_account_id
    and grant_row.membership_id = actor_membership_id
    and grant_row.facility_id = actor_facility_id
    and grant_row.scope = 'break_glass'
    and grant_row.purpose_of_use = 'emergency'
    and grant_row.status = 'active'
    and grant_row.expires_at > clock_timestamp()
    and grant_row.migration_hold_reason is null
  order by grant_row.expires_at desc
  limit 1;

  if grant_id_value is null then
    request_id_value := gen_random_uuid();
    grant_id_value := gen_random_uuid();
    grant_expires_at := clock_timestamp() + make_interval(mins => requested_duration_minutes);

    insert into identity.access_requests (
      id, patient_id, staff_id, membership_id, facility_id, scope,
      purpose_of_use, reason, status, requested_duration_minutes,
      break_glass, approved_at, correlation_id
    ) values (
      request_id_value, patient_id_value, actor_staff_id, actor_membership_id,
      actor_facility_id, 'break_glass', 'emergency', btrim(requested_reason),
      'approved', requested_duration_minutes, true, clock_timestamp(), actor_correlation_id
    );

    insert into identity.consent_grants (
      id, request_id, patient_id, staff_id, account_id, membership_id,
      facility_id, scope, purpose_of_use, status, reason, starts_at,
      expires_at, break_glass, correlation_id
    ) values (
      grant_id_value, request_id_value, patient_id_value, actor_staff_id,
      actor_account_id, actor_membership_id, actor_facility_id, 'break_glass',
      'emergency', 'active', btrim(requested_reason), clock_timestamp(),
      grant_expires_at, true, actor_correlation_id
    );
  else
    replayed := true;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id,
    actor_membership_id, actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.break-glass.replay' else 'identity.break-glass.activate' end,
    'success', 'consent-grant', grant_id_value::text, 'emergency',
    btrim(requested_reason), 'application', 'ehr-api',
    jsonb_build_object(
      'access_request_id', request_id_value,
      'duration_minutes', requested_duration_minutes,
      'expires_at', grant_expires_at,
      'existing_grant', replayed,
      'review_required', true
    )
  );

  return query select
    request_id_value, grant_id_value, patient_id_value, 'active'::text,
    grant_expires_at, replayed;
end;
$$;

create or replace function identity.close_own_consent_grant(
  requested_grant_id uuid,
  requested_reason text
)
returns table (
  consent_grant_id uuid,
  subject_patient_id uuid,
  grant_status text,
  closed_at timestamptz,
  already_closed boolean
)
language plpgsql
security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_organization_id uuid;
  patient_id_value uuid;
  current_status text;
  revoked_at_value timestamptz;
  prior_revoker uuid;
  replayed boolean := false;
begin
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.consent.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized consent command context is required';
  end if;
  if actor_purpose is null
     or not exists (
       select 1 from identity.purpose_of_use_codes purpose
       where purpose.code = actor_purpose and purpose.active
     ) then
    raise exception using errcode = '22023', message = 'A governed purpose of use is required';
  end if;
  if length(coalesce(btrim(requested_reason), '')) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'Invalid grant closure reason';
  end if;

  select grant_row.patient_id, grant_row.status, grant_row.revoked_at,
         grant_row.revoked_by, membership.organization_id
    into patient_id_value, current_status, revoked_at_value,
         prior_revoker, actor_organization_id
  from identity.consent_grants grant_row
  join identity.staff_facility_memberships membership
    on membership.id = grant_row.membership_id
   and membership.facility_id = grant_row.facility_id
   and membership.account_id = grant_row.account_id
  where grant_row.id = requested_grant_id
    and grant_row.account_id = actor_account_id
    and grant_row.membership_id = actor_membership_id
    and grant_row.facility_id = actor_facility_id
  for update of grant_row;
  if patient_id_value is null then
    raise exception using errcode = 'P0002', message = 'Consent grant is not available';
  end if;

  if current_status = 'active' then
    update identity.consent_grants
       set status = 'revoked',
           revoked_at = clock_timestamp(),
           revoked_by = actor_account_id,
           revoked_reason = btrim(requested_reason),
           updated_at = clock_timestamp(),
           row_version = row_version + 1
     where id = requested_grant_id
     returning revoked_at into revoked_at_value;
  elsif current_status = 'revoked' and prior_revoker = actor_account_id then
    replayed := true;
  else
    raise exception using errcode = '55000', message = 'Only an active grant owned by the current staff member can be closed';
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id,
    actor_membership_id, actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.consent-grant.close.replay' else 'identity.consent-grant.close' end,
    'success', 'consent-grant', requested_grant_id::text, actor_purpose,
    btrim(requested_reason), 'application', 'ehr-api',
    jsonb_build_object('existing_closure', replayed)
  );

  return query select
    requested_grant_id, patient_id_value, 'revoked'::text,
    revoked_at_value, replayed;
end;
$$;

create or replace function audit.list_facility_events(
  requested_limit integer default 50,
  before_sequence_id bigint default null
)
returns table (
  sequence_id bigint,
  event_id uuid,
  occurred_at timestamptz,
  correlation_id text,
  actor_type text,
  actor_subject text,
  patient_id uuid,
  action text,
  outcome text,
  resource_type text,
  resource_id text,
  purpose_of_use text,
  reason text,
  source_system text,
  details jsonb
)
language plpgsql
stable
security definer
set search_path = audit, auth, identity, platform, pg_temp
as $$
declare
  actor_subject_value text := platform.current_actor_subject();
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  safe_limit integer := greatest(1, least(coalesce(requested_limit, 50), 200));
begin
  if actor_subject_value is null
     or actor_membership_id is null
     or actor_facility_id is null
     or not auth.membership_has_permission(
       actor_subject_value, actor_membership_id, actor_facility_id, 'audit.read'
     ) then
    raise exception using errcode = '42501', message = 'Authorized audit read context is required';
  end if;

  return query
  select event_row.sequence_id, event_row.event_id, event_row.occurred_at,
         event_row.correlation_id, event_row.actor_type, event_row.actor_subject,
         event_row.patient_id, event_row.action, event_row.outcome,
         event_row.resource_type, event_row.resource_id, event_row.purpose_of_use,
         event_row.reason, event_row.source_system, event_row.details
  from audit.events event_row
  where event_row.facility_id = actor_facility_id
    and (before_sequence_id is null or event_row.sequence_id < before_sequence_id)
  order by event_row.sequence_id desc
  limit safe_limit;
end;
$$;

-- Emergency access overrides an applicable patient deny only for the exact
-- active emergency break-glass grant. Normal grants remain subject to denies.
create or replace function identity.has_active_consent_grant(
  request_patient_id uuid,
  request_subject text,
  request_membership_id uuid,
  request_facility_id uuid,
  request_action text,
  request_purpose text,
  at_time timestamptz default current_timestamp
)
returns boolean
language sql
stable
security definer
set search_path = identity, auth, pg_temp
as $$
  select
    request_purpose is not null
    and length(btrim(request_purpose)) > 0
    and exists (
      select 1
      from identity.purpose_of_use_codes purpose
      where purpose.code = request_purpose and purpose.active
    )
    and identity.has_active_membership(request_subject, request_membership_id, request_facility_id)
    and exists (
      select 1
      from identity.consent_grants grant_row
      join auth.accounts account_row on account_row.id = grant_row.account_id
      where grant_row.patient_id = request_patient_id
        and grant_row.membership_id = request_membership_id
        and grant_row.facility_id = request_facility_id
        and grant_row.purpose_of_use = request_purpose
        and account_row.subject = request_subject
        and account_row.status = 'active'
        and (account_row.disabled_until is null or account_row.disabled_until <= at_time)
        and grant_row.status = 'active'
        and grant_row.migration_hold_reason is null
        and grant_row.starts_at <= at_time
        and grant_row.expires_at > at_time
        and (
          grant_row.scope = 'break_glass'
          or grant_row.scope = request_action
          or (request_action = 'read_records' and grant_row.scope = 'write_records')
        )
    )
    and (
      exists (
        select 1
        from identity.consent_grants emergency_grant
        join auth.accounts emergency_account on emergency_account.id = emergency_grant.account_id
        where emergency_grant.patient_id = request_patient_id
          and emergency_grant.membership_id = request_membership_id
          and emergency_grant.facility_id = request_facility_id
          and emergency_grant.purpose_of_use = 'emergency'
          and request_purpose = 'emergency'
          and emergency_account.subject = request_subject
          and emergency_account.status = 'active'
          and (emergency_account.disabled_until is null or emergency_account.disabled_until <= at_time)
          and emergency_grant.scope = 'break_glass'
          and emergency_grant.break_glass
          and emergency_grant.status = 'active'
          and emergency_grant.migration_hold_reason is null
          and emergency_grant.starts_at <= at_time
          and emergency_grant.expires_at > at_time
      )
      or not exists (
        select 1
        from identity.consent_directives directive
        join identity.consent_directive_versions directive_version
          on directive_version.directive_id = directive.id
         and directive_version.version_no = directive.current_version
        join identity.staff_facility_memberships membership
          on membership.id = request_membership_id
         and membership.facility_id = request_facility_id
        where directive.patient_id = request_patient_id
          and directive_version.status = 'active'
          and directive_version.provision_type = 'deny'
          and directive_version.starts_at <= at_time
          and (directive_version.expires_at is null or directive_version.expires_at > at_time)
          and (directive_version.facility_id is null or directive_version.facility_id = request_facility_id)
          and (cardinality(directive_version.actions) = 0 or request_action = any(directive_version.actions))
          and (cardinality(directive_version.purposes) = 0 or request_purpose = any(directive_version.purposes))
          and (
            directive_version.grantee_type = 'all'
            or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = request_facility_id)
            or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = membership.organization_id)
            or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = membership.staff_id)
          )
      )
    )
$$;

revoke all on function auth.membership_has_permission(text, uuid, uuid, text) from public;
revoke all on function identity.create_access_request(text, text, text, integer) from public;
revoke all on function identity.activate_break_glass(text, text, integer) from public;
revoke all on function identity.close_own_consent_grant(uuid, text) from public;
revoke all on function audit.list_facility_events(integer, bigint) from public;

comment on function identity.create_access_request(text, text, text, integer) is
  'Creates or reuses an exact-HID pending request after revalidating the current staff membership and permission.';
comment on function identity.activate_break_glass(text, text, integer) is
  'Atomically creates an emergency request, active grant, and audit event with a maximum duration of 240 minutes.';
comment on function identity.close_own_consent_grant(uuid, text) is
  'Allows staff to revoke only a grant bound to their exact account, membership, and facility.';
comment on function audit.list_facility_events(integer, bigint) is
  'Returns at most 200 append-only audit events for the caller current authorized facility.';
