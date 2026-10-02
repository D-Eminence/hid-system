-- A successful CAC lookup verifies the submitted identifier even if the
-- sandbox omits legal fields. Store the provider snapshot and each field's
-- source separately; email-proven applicants may supply only missing fields.
-- The existing approval command, unique CAC binding, and platform RBAC stay.

alter table identity.organization_applications
  add column profile_state text check (profile_state in ('incomplete', 'complete')),
  add column provider_verified_registration_number text
    check (provider_verified_registration_number is null or
      provider_verified_registration_number ~ '^(RC|BN|IT)[0-9]{4,20}$'),
  add column qoreid_organization_name text,
  add column qoreid_entity_type text,
  add column qoreid_registration_date date,
  add column qoreid_address text,
  add column qoreid_registry_status text,
  add column organization_name_source text check (organization_name_source in ('qoreid', 'user_provided')),
  add column entity_type_source text check (entity_type_source in ('qoreid', 'user_provided')),
  add column registration_date_source text check (registration_date_source in ('qoreid', 'user_provided')),
  add column address_source text check (address_source in ('qoreid', 'user_provided')),
  add column registry_status_source text check (registry_status_source in ('qoreid', 'user_provided'));

-- A verified lookup can report an inactive registry status. Preserve that
-- provider fact while keeping review readiness restricted to active entities.
alter table identity.organization_applications
  drop constraint organization_applications_verified_registry_status_check;
alter table identity.organization_applications
  add constraint organization_applications_verified_registry_status_check check (
    verified_registry_status is null or (
      length(btrim(verified_registry_status)) between 1 and 40
      and verified_registry_status !~ '[[:cntrl:]]'
    )
  );

-- The old verified_* names now represent the review profile, with explicit
-- source columns. qoreid_* retains only fields actually supplied by QoreID.
update identity.organization_applications
   set profile_state = 'complete',
       provider_verified_registration_number = cac_registration_number,
       qoreid_organization_name = verified_organization_name,
       qoreid_entity_type = verified_entity_type,
       qoreid_registration_date = verified_registration_date,
       qoreid_address = verified_address,
       qoreid_registry_status = verified_registry_status,
       organization_name_source = case when verified_organization_name is not null then 'qoreid' end,
       entity_type_source = case when verified_entity_type is not null then 'qoreid' end,
       registration_date_source = case when verified_registration_date is not null then 'qoreid' end,
       address_source = case when verified_address is not null then 'qoreid' end,
       registry_status_source = case when verified_registry_status is not null then 'qoreid' end
 where verification_result = 'verified'
   and provider_reference ~ '^[0-9]+$'
   and verified_organization_name is not null
   and verified_entity_type is not null
   and verified_registration_date is not null
   and verified_address is not null
   and verified_registry_status = 'active';

-- 0055 stored no partial provider fields, so their provenance cannot be
-- recovered. Keep the verified lookup/reference and request completion.
update identity.organization_applications
   set verification_result = 'verified', verification_failure_category = null,
       profile_state = 'incomplete',
       provider_verified_registration_number = cac_registration_number,
       row_version = row_version + 1, updated_at = clock_timestamp()
 where verification_result = 'verified_incomplete';

alter table identity.organization_applications
  add constraint organization_applications_profile_provenance_ck check (
    -- Historical closed, name-only approvals predate complete CAC evidence.
    -- Keep them usable without falsely promoting their fields to QoreID data.
    (status in ('approved', 'rejected') and profile_state is null
      and provider_verified_registration_number is null
      and qoreid_organization_name is null and qoreid_entity_type is null
      and qoreid_registration_date is null and qoreid_address is null
      and qoreid_registry_status is null and organization_name_source is null
      and entity_type_source is null and registration_date_source is null
      and address_source is null and registry_status_source is null)
    or (
    (verification_result <> 'verified' or (
      provider_reference ~ '^[0-9]+$'
      and verified_at is not null
      and provider_verified_registration_number = cac_registration_number
      and profile_state is not null
    ))
    and (qoreid_organization_name is null or
      (verified_organization_name is not distinct from qoreid_organization_name
        and organization_name_source is not distinct from 'qoreid'))
    and (qoreid_entity_type is null or
      (verified_entity_type is not distinct from qoreid_entity_type
        and entity_type_source is not distinct from 'qoreid'))
    and (qoreid_registration_date is null or
      (verified_registration_date is not distinct from qoreid_registration_date
        and registration_date_source is not distinct from 'qoreid'))
    and (qoreid_address is null or
      (verified_address is not distinct from qoreid_address
        and address_source is not distinct from 'qoreid'))
    and (qoreid_registry_status is null or
      (verified_registry_status is not distinct from qoreid_registry_status
        and registry_status_source is not distinct from 'qoreid'))
    and (organization_name_source is distinct from 'qoreid' or qoreid_organization_name is not null)
    and (entity_type_source is distinct from 'qoreid' or qoreid_entity_type is not null)
    and (registration_date_source is distinct from 'qoreid' or qoreid_registration_date is not null)
    and (address_source is distinct from 'qoreid' or qoreid_address is not null)
    and (registry_status_source is distinct from 'qoreid' or qoreid_registry_status is not null)
    and ((verified_organization_name is null) = (organization_name_source is null))
    and ((verified_entity_type is null) = (entity_type_source is null))
    and ((verified_registration_date is null) = (registration_date_source is null))
    and ((verified_address is null) = (address_source is null))
    and ((verified_registry_status is null) = (registry_status_source is null))
    and (profile_state <> 'complete' or (
      verification_result = 'verified'
      and verified_organization_name is not null
      and verified_entity_type is not null
      and verified_registration_date is not null
      and verified_address is not null
      and verified_registry_status = 'active'
    ))
    and (status not in ('ready_for_review', 'approved') or profile_state = 'complete')
    )
  );

alter table identity.organization_cac_registrations
  add column organization_name_source text check (organization_name_source in ('qoreid', 'user_provided')),
  add column entity_type_source text check (entity_type_source in ('qoreid', 'user_provided')),
  add column registration_date_source text check (registration_date_source in ('qoreid', 'user_provided')),
  add column address_source text check (address_source in ('qoreid', 'user_provided')),
  add column registry_status_source text check (registry_status_source in ('qoreid', 'user_provided'));

update identity.organization_cac_registrations binding
   set organization_name_source = application.organization_name_source,
       entity_type_source = application.entity_type_source,
       registration_date_source = application.registration_date_source,
       address_source = application.address_source,
       registry_status_source = application.registry_status_source
  from identity.organization_applications application
 where application.id = binding.source_application_id
   and binding.verified_organization_name is not null;

create or replace function identity.populate_organization_cac_registry_binding()
returns trigger language plpgsql security definer
set search_path = pg_catalog, identity, pg_temp
as $$
declare application identity.organization_applications%rowtype;
begin
  select * into application from identity.organization_applications row
    where row.id = new.source_application_id;
  if not found or application.cac_registration_number <> new.cac_registration_number
     or application.status <> 'ready_for_review' or application.verification_result <> 'verified'
     or application.profile_state <> 'complete'
     or application.provider_verified_registration_number <> new.cac_registration_number
     or application.provider_reference is null
     or application.verified_organization_name is null or application.organization_name_source is null
     or application.verified_entity_type is null or application.entity_type_source is null
     or application.verified_registration_date is null or application.registration_date_source is null
     or application.verified_address is null or application.address_source is null
     or application.verified_registry_status <> 'active' or application.registry_status_source is null then
    raise exception using errcode = '23514', message = 'Complete sourced CAC binding is required';
  end if;
  new.verified_organization_name := application.verified_organization_name;
  new.verified_entity_type := application.verified_entity_type;
  new.verified_registration_date := application.verified_registration_date;
  new.verified_address := application.verified_address;
  new.verified_registry_status := application.verified_registry_status;
  new.organization_name_source := application.organization_name_source;
  new.entity_type_source := application.entity_type_source;
  new.registration_date_source := application.registration_date_source;
  new.address_source := application.address_source;
  new.registry_status_source := application.registry_status_source;
  return new;
end;
$$;

create or replace function identity.require_complete_organization_approval_binding()
returns trigger language plpgsql security definer
set search_path = pg_catalog, identity, pg_temp
as $$
declare binding identity.organization_cac_registrations%rowtype;
begin
  if new.status <> 'approved' or old.status = 'approved' then return new; end if;
  select * into binding from identity.organization_cac_registrations row
    where row.cac_registration_number = new.cac_registration_number;
  if new.verification_result <> 'verified' or new.profile_state <> 'complete'
     or new.provider_verified_registration_number <> new.cac_registration_number
     or new.provider_reference is null or new.verified_organization_name is null
     or new.verified_entity_type is null or new.verified_registration_date is null
     or new.verified_address is null or new.verified_registry_status <> 'active' or not found
     or binding.organization_id is distinct from new.organization_id
     or binding.primary_facility_id is distinct from new.facility_id
     or binding.verified_organization_name is distinct from new.verified_organization_name
     or binding.verified_entity_type is distinct from new.verified_entity_type
     or binding.verified_registration_date is distinct from new.verified_registration_date
     or binding.verified_address is distinct from new.verified_address
     or binding.verified_registry_status is distinct from new.verified_registry_status
     or binding.organization_name_source is distinct from new.organization_name_source
     or binding.entity_type_source is distinct from new.entity_type_source
     or binding.registration_date_source is distinct from new.registration_date_source
     or binding.address_source is distinct from new.address_source
     or binding.registry_status_source is distinct from new.registry_status_source then
    raise exception using errcode = '23514', message = 'Complete matching sourced CAC binding is required';
  end if;
  return new;
end;
$$;

create or replace function identity.admin_record_organization_cac_result(
  requested_application_id uuid, expected_version bigint, requested_result text,
  requested_provider_reference text, requested_failure_category text,
  requested_verified_registration_number text, requested_verified_organization_name text,
  requested_verified_entity_type text, requested_verified_registration_date text,
  requested_verified_address text, requested_verified_registry_status text
) returns table (application_status text, row_version bigint)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.organization_application_admin_account('platform.facility.manage');
  application identity.organization_applications%rowtype;
  provider_date date;
  provider_name text;
  provider_type text;
  provider_address text;
  provider_status text;
  merged_name text;
  merged_type text;
  merged_date date;
  merged_address text;
  merged_status text;
  name_source text;
  type_source text;
  date_source text;
  address_source_value text;
  status_source text;
  completion_state text;
begin
  if requested_result is null
     or requested_result not in ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')
     or requested_provider_reference is not null and (
       length(requested_provider_reference) not between 1 and 255
       or requested_provider_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
     )
     or (requested_result = 'verified' and (
       requested_failure_category is not null
       or requested_provider_reference is null
       or requested_provider_reference !~ '^[0-9]+$'
     ))
     or (requested_result = 'not_verified' and requested_failure_category is distinct from 'not_verified')
     or (requested_result = 'incomplete' and requested_failure_category is distinct from 'incomplete')
     or (requested_result = 'disabled' and requested_failure_category is distinct from 'disabled')
     or (requested_result = 'provider_error' and (requested_failure_category is null
       or requested_failure_category not in (
         'provider_authentication', 'provider_unavailable', 'timeout', 'network',
         'malformed_response', 'unexpected_response'
       ))) then
    raise exception using errcode = '22023', message = 'Invalid CAC verification result';
  end if;
  select * into application from identity.organization_applications row
   where row.id = requested_application_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Organization application not found'; end if;
  if application.status not in ('pending_verification', 'ready_for_review') then
    raise exception using errcode = '23514', message = 'Organization application is closed';
  end if;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;

  if requested_result = 'verified' then
    if requested_verified_registration_number is distinct from application.cac_registration_number
       or (requested_verified_organization_name is not null and (
         length(btrim(requested_verified_organization_name)) not between 2 and 200
         or requested_verified_organization_name ~ '[[:cntrl:]]'))
       or (requested_verified_entity_type is not null and (
         length(btrim(requested_verified_entity_type)) not between 2 and 120
         or requested_verified_entity_type ~ '[[:cntrl:]]'))
       or (requested_verified_address is not null and (
         length(btrim(requested_verified_address)) not between 5 and 1000
         or requested_verified_address ~ '[[:cntrl:]]'))
       or (requested_verified_registry_status is not null and (
         length(btrim(requested_verified_registry_status)) not between 1 and 40
         or requested_verified_registry_status ~ '[[:cntrl:]]'))
       or (requested_verified_registration_date is not null
         and requested_verified_registration_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
      raise exception using errcode = '22023', message = 'Invalid provider CAC profile';
    end if;
    if requested_verified_registration_date is not null then
      begin
        provider_date := requested_verified_registration_date::date;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception using errcode = '22023', message = 'Invalid CAC registration date';
      end;
      if provider_date::text <> requested_verified_registration_date
         or provider_date < date '1800-01-01' or provider_date > current_date then
        raise exception using errcode = '22023', message = 'Invalid CAC registration date';
      end if;
    end if;
    provider_name := coalesce(btrim(requested_verified_organization_name),
      case when application.verification_result = 'verified' then application.qoreid_organization_name end);
    provider_type := coalesce(btrim(requested_verified_entity_type),
      case when application.verification_result = 'verified' then application.qoreid_entity_type end);
    provider_date := coalesce(provider_date,
      case when application.verification_result = 'verified' then application.qoreid_registration_date end);
    provider_address := coalesce(btrim(requested_verified_address),
      case when application.verification_result = 'verified' then application.qoreid_address end);
    provider_status := coalesce(requested_verified_registry_status,
      case when application.verification_result = 'verified' then application.qoreid_registry_status end);
    merged_name := coalesce(provider_name,
      case when application.verification_result = 'verified'
        and application.organization_name_source = 'user_provided' then application.verified_organization_name end);
    merged_type := coalesce(provider_type,
      case when application.verification_result = 'verified'
        and application.entity_type_source = 'user_provided' then application.verified_entity_type end);
    merged_date := coalesce(provider_date,
      case when application.verification_result = 'verified'
        and application.registration_date_source = 'user_provided' then application.verified_registration_date end);
    merged_address := coalesce(provider_address,
      case when application.verification_result = 'verified'
        and application.address_source = 'user_provided' then application.verified_address end);
    merged_status := coalesce(provider_status,
      case when application.verification_result = 'verified'
        and application.registry_status_source = 'user_provided' then application.verified_registry_status end);
    name_source := case when provider_name is not null then 'qoreid'
      when merged_name is not null then 'user_provided' end;
    type_source := case when provider_type is not null then 'qoreid'
      when merged_type is not null then 'user_provided' end;
    date_source := case when provider_date is not null then 'qoreid'
      when merged_date is not null then 'user_provided' end;
    address_source_value := case when provider_address is not null then 'qoreid'
      when merged_address is not null then 'user_provided' end;
    status_source := case when provider_status is not null then 'qoreid'
      when merged_status is not null then 'user_provided' end;
    completion_state := case when merged_name is not null and merged_type is not null
      and merged_date is not null and merged_address is not null and merged_status = 'active'
      then 'complete' else 'incomplete' end;
  elsif requested_verified_registration_number is not null
     or requested_verified_organization_name is not null
     or requested_verified_entity_type is not null
     or requested_verified_registration_date is not null
     or requested_verified_address is not null
     or requested_verified_registry_status is not null then
    raise exception using errcode = '22023', message = 'Unverified CAC result cannot carry registry identity';
  end if;

  update identity.organization_applications row
     set status = case when requested_result = 'verified' and completion_state = 'complete'
           then 'ready_for_review' else 'pending_verification' end,
         verification_result = requested_result,
         verification_failure_category = requested_failure_category,
         provider_reference = requested_provider_reference,
         provider_verified_registration_number = case when requested_result = 'verified'
           then requested_verified_registration_number else null end,
         profile_state = completion_state,
         qoreid_organization_name = provider_name,
         qoreid_entity_type = provider_type,
         qoreid_registration_date = provider_date,
         qoreid_address = provider_address,
         qoreid_registry_status = provider_status,
         organization_name = merged_name,
         verified_organization_name = merged_name,
         verified_entity_type = merged_type,
         verified_registration_date = merged_date,
         verified_address = merged_address,
         verified_registry_status = merged_status,
         organization_name_source = name_source,
         entity_type_source = type_source,
         registration_date_source = date_source,
         address_source = address_source_value,
         registry_status_source = status_source,
         verified_at = case when requested_result = 'verified' then clock_timestamp() else null end,
         updated_at = clock_timestamp(), row_version = row.row_version + 1
   where row.id = requested_application_id
   returning row.* into application;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor_account,
    platform.current_membership_id(), platform.current_facility_id(),
    'identity.organization.application.cac-verify',
    case when requested_result = 'verified' then 'success'
      when requested_result in ('not_verified', 'incomplete') then 'denied' else 'failure' end,
    'organization-application', application.id::text, 'healthcare-operations',
    'application', 'identity-api', jsonb_build_object(
      'productCode', application.product_code, 'result', requested_result,
      'profileState', application.profile_state, 'failureCategory', requested_failure_category
    )
  );
  return query select application.status, application.row_version;
end;
$$;

drop function identity.admin_list_organization_applications(text);
create function identity.admin_list_organization_applications(requested_status text)
returns table (
  application_id uuid, product_code text, organization_name text, organization_type text,
  cac_hint text, administrator_name text, administrator_email text,
  application_status text, verification_result text, verified_organization_name text,
  verified_entity_type text, verified_registration_date text, verified_address text,
  verified_registry_status text, row_version bigint,
  created_at timestamptz, verified_at timestamptz, reviewed_at timestamptz,
  profile_state text,
  qoreid_organization_name text, qoreid_entity_type text,
  qoreid_registration_date text, qoreid_address text, qoreid_registry_status text,
  organization_name_source text, entity_type_source text,
  registration_date_source text, address_source text, registry_status_source text
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
begin
  perform identity.organization_application_admin_account('platform.identity-review.read');
  if requested_status is not null and requested_status not in
    ('pending_verification', 'ready_for_review', 'approved', 'rejected') then
    raise exception using errcode = '22023', message = 'Invalid application status filter';
  end if;
  return query
    select application.id, application.product_code, application.organization_name,
      application.organization_type,
      left(application.cac_registration_number, 2)
        || repeat('*', length(application.cac_registration_number) - 4)
        || right(application.cac_registration_number, 2),
      application.administrator_name, application.administrator_email,
      application.status, application.verification_result, application.verified_organization_name,
      application.verified_entity_type, application.verified_registration_date::text,
      application.verified_address, application.verified_registry_status, application.row_version,
      application.created_at, application.verified_at, application.reviewed_at,
      application.profile_state,
      application.qoreid_organization_name, application.qoreid_entity_type,
      application.qoreid_registration_date::text, application.qoreid_address,
      application.qoreid_registry_status, application.organization_name_source,
      application.entity_type_source, application.registration_date_source,
      application.address_source, application.registry_status_source
    from identity.organization_applications application
    where requested_status is null or application.status = requested_status
    order by application.created_at desc, application.id desc
    limit 100;
end;
$$;

create table identity.organization_profile_completion_challenges (
  id uuid primary key,
  application_id uuid not null references identity.organization_applications(id) on delete restrict,
  code_hmac char(64) not null check (code_hmac ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  session_hmac char(64) unique check (session_hmac is null or session_hmac ~ '^[a-f0-9]{64}$'),
  session_expires_at timestamptz,
  check ((session_hmac is null) = (session_expires_at is null))
);
create index organization_profile_completion_expiry_idx
  on identity.organization_profile_completion_challenges (expires_at);
create index organization_profile_completion_application_idx
  on identity.organization_profile_completion_challenges (application_id, created_at desc);
revoke all on identity.organization_profile_completion_challenges from public;

create function identity.begin_organization_profile_completion(
  requested_cac_number text, requested_email text, requested_product text,
  requested_challenge_id uuid, requested_code_hmac char(64)
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  application identity.organization_applications%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_challenge_id is null
     or requested_code_hmac is null or requested_code_hmac !~ '^[a-f0-9]{64}$'
     or requested_cac_number !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or requested_email is null or requested_product not in
       ('ehr', 'migrate', 'laboratory', 'pharmacy') then
    raise exception using errcode = '22023', message = 'Invalid completion request';
  end if;
  select * into application from identity.organization_applications row
    where row.cac_registration_number = requested_cac_number
      and row.product_code = requested_product
      and row.administrator_email = lower(btrim(requested_email))
      and row.status in ('pending_verification', 'ready_for_review')
      and row.verification_result = 'verified'
      and row.provider_verified_registration_number = row.cac_registration_number
      and row.provider_reference ~ '^[0-9]+$'
    for update;
  if not found then return null; end if;
  delete from identity.organization_profile_completion_challenges old
   where old.id in (
     select stale.id from identity.organization_profile_completion_challenges stale
      where stale.expires_at < clock_timestamp() - interval '48 hours'
        and (stale.session_expires_at is null
          or stale.session_expires_at < clock_timestamp() - interval '48 hours')
      order by stale.expires_at limit 100
   );
  if exists (select 1 from identity.organization_profile_completion_challenges prior
      where prior.application_id = application.id
        and prior.created_at > clock_timestamp() - interval '60 seconds')
     or (select count(*) from identity.organization_profile_completion_challenges prior
       where prior.application_id = application.id
         and prior.created_at > clock_timestamp() - interval '1 hour') >= 5
     or (select count(*) from identity.organization_profile_completion_challenges prior
       where prior.application_id = application.id
         and prior.created_at > clock_timestamp() - interval '1 day') >= 15 then
    return null;
  end if;
  update identity.organization_profile_completion_challenges challenge
     set invalidated_at = clock_timestamp()
   where challenge.application_id = application.id and challenge.invalidated_at is null
     and challenge.session_hmac is null;
  insert into identity.organization_profile_completion_challenges
    (id, application_id, code_hmac, expires_at)
  values (requested_challenge_id, application.id, requested_code_hmac,
    clock_timestamp() + interval '10 minutes');
  return application.administrator_email;
end;
$$;

create function identity.invalidate_organization_profile_completion_challenge(
  requested_challenge_id uuid
) returns void
language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Completion authorization is required';
  end if;
  update identity.organization_profile_completion_challenges
     set invalidated_at = clock_timestamp()
   where id = requested_challenge_id and consumed_at is null;
end;
$$;

create function identity.verify_organization_profile_completion_challenge(
  requested_challenge_id uuid, requested_code_hmac char(64), requested_session_hmac char(64)
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
declare challenge identity.organization_profile_completion_challenges%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_code_hmac is null or requested_code_hmac !~ '^[a-f0-9]{64}$'
     or requested_session_hmac is null or requested_session_hmac !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'Completion authorization is required';
  end if;
  select * into challenge from identity.organization_profile_completion_challenges row
    where row.id = requested_challenge_id for update;
  if not found or challenge.expires_at <= clock_timestamp()
     or challenge.invalidated_at is not null or challenge.consumed_at is not null
     or challenge.failed_attempts >= 5 then return false; end if;
  if challenge.code_hmac is distinct from requested_code_hmac then
    update identity.organization_profile_completion_challenges
       set failed_attempts = failed_attempts + 1,
           invalidated_at = case when failed_attempts + 1 >= 5
             then clock_timestamp() else invalidated_at end
     where id = requested_challenge_id;
    return false;
  end if;
  if not exists (select 1 from identity.organization_applications application
      where application.id = challenge.application_id and application.verification_result = 'verified'
        and application.status in ('pending_verification', 'ready_for_review')
        and application.provider_verified_registration_number = application.cac_registration_number) then
    return false;
  end if;
  update identity.organization_profile_completion_challenges
     set consumed_at = clock_timestamp(), session_hmac = requested_session_hmac,
         session_expires_at = clock_timestamp() + interval '1 hour'
   where id = requested_challenge_id;
  return true;
end;
$$;

create function identity.current_organization_profile_completion(requested_session_hmac char(64))
returns table (
  application_status text, profile_state text, row_version bigint, product_code text,
  cac_registration_number text, profile_organization_name text,
  profile_organization_name_source text, profile_entity_type text,
  profile_entity_type_source text, profile_registration_date text,
  profile_registration_date_source text, profile_address text,
  profile_address_source text, profile_registry_status text,
  profile_registry_status_source text
)
language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_session_hmac is null or requested_session_hmac !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'Completion authorization is required';
  end if;
  return query
    select application.status, application.profile_state, application.row_version,
      application.product_code, application.cac_registration_number,
      application.verified_organization_name, application.organization_name_source,
      application.verified_entity_type, application.entity_type_source,
      application.verified_registration_date::text, application.registration_date_source,
      application.verified_address, application.address_source,
      application.verified_registry_status, application.registry_status_source
    from identity.organization_profile_completion_challenges challenge
    join identity.organization_applications application on application.id = challenge.application_id
    where challenge.session_hmac = requested_session_hmac
      and challenge.consumed_at is not null and challenge.invalidated_at is null
      and challenge.session_expires_at > clock_timestamp()
      and application.status in ('pending_verification', 'ready_for_review')
      and application.verification_result = 'verified'
      and application.provider_verified_registration_number = application.cac_registration_number
    limit 1;
end;
$$;

create function identity.complete_organization_profile(
  requested_session_hmac char(64), expected_version bigint,
  requested_organization_name text, requested_entity_type text,
  requested_registration_date text, requested_address text, requested_registry_status text
) returns table (
  application_status text, profile_state text, row_version bigint, product_code text,
  cac_registration_number text, profile_organization_name text,
  profile_organization_name_source text, profile_entity_type text,
  profile_entity_type_source text, profile_registration_date text,
  profile_registration_date_source text, profile_address text,
  profile_address_source text, profile_registry_status text,
  profile_registry_status_source text
)
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  application identity.organization_applications%rowtype;
  challenge identity.organization_profile_completion_challenges%rowtype;
  supplied_date date;
  merged_name text;
  merged_type text;
  merged_date date;
  merged_address text;
  merged_status text;
  completion_state text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_session_hmac is null or requested_session_hmac !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'Completion authorization is required';
  end if;
  select * into challenge from identity.organization_profile_completion_challenges row
    where row.session_hmac = requested_session_hmac and row.consumed_at is not null
      and row.invalidated_at is null and row.session_expires_at > clock_timestamp();
  if not found then raise exception using errcode = '42501', message = 'Completion session is invalid'; end if;
  select * into application from identity.organization_applications row
    where row.id = challenge.application_id for update;
  if not found or application.status not in ('pending_verification', 'ready_for_review')
     or application.verification_result <> 'verified'
     or application.provider_verified_registration_number <> application.cac_registration_number then
    raise exception using errcode = '23514', message = 'Verified CAC completion is unavailable';
  end if;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;
  if requested_organization_name is null and requested_entity_type is null
     and requested_registration_date is null and requested_address is null
     and requested_registry_status is null then
    raise exception using errcode = '22023', message = 'No profile fields were supplied';
  end if;
  if (requested_organization_name is not null and (
       application.qoreid_organization_name is not null
       or length(btrim(requested_organization_name)) not between 2 and 200
       or requested_organization_name ~ '[[:cntrl:]]'))
     or (requested_entity_type is not null and (
       application.qoreid_entity_type is not null
       or length(btrim(requested_entity_type)) not between 2 and 120
       or requested_entity_type ~ '[[:cntrl:]]'))
     or (requested_registration_date is not null and (
       application.qoreid_registration_date is not null
       or requested_registration_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
     or (requested_address is not null and (
       application.qoreid_address is not null
       or length(btrim(requested_address)) not between 5 and 1000
       or requested_address ~ '[[:cntrl:]]'))
     or (requested_registry_status is not null and (
       application.qoreid_registry_status is not null
       or requested_registry_status <> 'active')) then
    raise exception using errcode = '22023', message = 'Invalid or provider-owned profile field';
  end if;
  if requested_registration_date is not null then
    begin
      supplied_date := requested_registration_date::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Invalid CAC registration date';
    end;
    if supplied_date::text <> requested_registration_date
       or supplied_date < date '1800-01-01' or supplied_date > current_date then
      raise exception using errcode = '22023', message = 'Invalid CAC registration date';
    end if;
  end if;
  merged_name := coalesce(btrim(requested_organization_name), application.verified_organization_name);
  merged_type := coalesce(btrim(requested_entity_type), application.verified_entity_type);
  merged_date := coalesce(supplied_date, application.verified_registration_date);
  merged_address := coalesce(btrim(requested_address), application.verified_address);
  merged_status := coalesce(requested_registry_status, application.verified_registry_status);
  completion_state := case when merged_name is not null and merged_type is not null
    and merged_date is not null and merged_address is not null and merged_status = 'active'
    then 'complete' else 'incomplete' end;
  update identity.organization_applications row
     set organization_name = merged_name,
         verified_organization_name = merged_name,
         verified_entity_type = merged_type,
         verified_registration_date = merged_date,
         verified_address = merged_address,
         verified_registry_status = merged_status,
         organization_name_source = case when requested_organization_name is not null
           then 'user_provided' else row.organization_name_source end,
         entity_type_source = case when requested_entity_type is not null
           then 'user_provided' else row.entity_type_source end,
         registration_date_source = case when requested_registration_date is not null
           then 'user_provided' else row.registration_date_source end,
         address_source = case when requested_address is not null
           then 'user_provided' else row.address_source end,
         registry_status_source = case when requested_registry_status is not null
           then 'user_provided' else row.registry_status_source end,
         profile_state = completion_state,
         status = case when completion_state = 'complete' then 'ready_for_review'
           else 'pending_verification' end,
         row_version = row.row_version + 1, updated_at = clock_timestamp()
   where row.id = application.id;
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system', 'identity.organization.application.profile-complete',
    'success', 'organization-application', application.id::text,
    'application', 'identity-api', jsonb_build_object(
      'productCode', application.product_code, 'profileState', completion_state,
      'fieldSources', jsonb_build_object(
        'companyName', case when requested_organization_name is not null then 'user_provided' end,
        'entityType', case when requested_entity_type is not null then 'user_provided' end,
        'registrationDate', case when requested_registration_date is not null then 'user_provided' end,
        'address', case when requested_address is not null then 'user_provided' end,
        'registryStatus', case when requested_registry_status is not null then 'user_provided' end
      )
    )
  );
  return query select * from identity.current_organization_profile_completion(requested_session_hmac);
end;
$$;

revoke all on function identity.admin_list_organization_applications(text),
  identity.begin_organization_profile_completion(text,text,text,uuid,char),
  identity.invalidate_organization_profile_completion_challenge(uuid),
  identity.verify_organization_profile_completion_challenge(uuid,char,char),
  identity.current_organization_profile_completion(char),
  identity.complete_organization_profile(char,bigint,text,text,text,text,text)
  from public;
