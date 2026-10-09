-- QoreID can verify a CAC lookup while omitting the legal-entity fields needed
-- for an authoritative organization. Keep that provider result and reference
-- distinct from a complete registry binding; approval remains fail-closed.
alter table identity.organization_applications
  drop constraint organization_applications_verification_result_check;
alter table identity.organization_applications
  add constraint organization_applications_verification_result_check check (
    verification_result in (
      'verified', 'verified_incomplete', 'not_verified', 'incomplete', 'provider_error', 'disabled'
    )
  ),
  add constraint organization_applications_verified_incomplete_ck check (
    verification_result is distinct from 'verified_incomplete' or (
      status in ('pending_verification', 'rejected')
      and verification_failure_category is not distinct from 'incomplete'
      and provider_reference is not null
      and provider_reference ~ '^[0-9]+$'
      and verified_at is not null
      and organization_name is null
      and verified_organization_name is null
      and verified_entity_type is null
      and verified_registration_date is null
      and verified_address is null
      and verified_registry_status is null
    )
  );

create or replace function identity.admin_record_organization_cac_result(
  requested_application_id uuid,
  expected_version bigint,
  requested_result text,
  requested_provider_reference text,
  requested_failure_category text,
  requested_verified_registration_number text,
  requested_verified_organization_name text,
  requested_verified_entity_type text,
  requested_verified_registration_date text,
  requested_verified_address text,
  requested_verified_registry_status text
) returns table (application_status text, row_version bigint)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.organization_application_admin_account('platform.facility.manage');
  application identity.organization_applications%rowtype;
  registration_date date;
begin
  if requested_result is null
     or requested_result not in ('verified', 'verified_incomplete', 'not_verified', 'incomplete', 'provider_error', 'disabled')
     or requested_provider_reference is not null and (
       length(requested_provider_reference) not between 1 and 255
       or requested_provider_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
     )
     or (requested_result = 'verified' and requested_failure_category is not null)
     or (requested_result = 'verified_incomplete' and (
       requested_failure_category is distinct from 'incomplete'
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
    if requested_provider_reference is null
       or requested_verified_registration_number is distinct from application.cac_registration_number
       or length(btrim(coalesce(requested_verified_organization_name, ''))) not between 2 and 200
       or requested_verified_organization_name ~ '[[:cntrl:]]'
       or length(btrim(coalesce(requested_verified_entity_type, ''))) not between 2 and 120
       or requested_verified_entity_type ~ '[[:cntrl:]]'
       or requested_verified_registration_date is null
       or requested_verified_registration_date !~ '^\d{4}-\d{2}-\d{2}$'
       or length(btrim(coalesce(requested_verified_address, ''))) not between 5 and 1000
       or requested_verified_address ~ '[[:cntrl:]]'
       or requested_verified_registry_status is distinct from 'active' then
      raise exception using errcode = '22023', message = 'Complete active CAC registry identity is required';
    end if;
    begin
      registration_date := requested_verified_registration_date::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Invalid CAC registration date';
    end;
    if registration_date::text <> requested_verified_registration_date
       or registration_date < date '1800-01-01' or registration_date > current_date then
      raise exception using errcode = '22023', message = 'Invalid CAC registration date';
    end if;
  elsif requested_verified_registration_number is not null
     or requested_verified_organization_name is not null
     or requested_verified_entity_type is not null
     or requested_verified_registration_date is not null
     or requested_verified_address is not null
     or requested_verified_registry_status is not null then
    raise exception using errcode = '22023', message = 'Incomplete result cannot carry registry identity';
  end if;
  update identity.organization_applications row
     set status = case when requested_result = 'verified' then 'ready_for_review' else 'pending_verification' end,
         verification_result = requested_result,
         verification_failure_category = requested_failure_category,
         provider_reference = requested_provider_reference,
         organization_name = case when requested_result = 'verified'
           then btrim(requested_verified_organization_name) else null end,
         verified_organization_name = case when requested_result = 'verified'
           then btrim(requested_verified_organization_name) else null end,
         verified_entity_type = case when requested_result = 'verified'
           then btrim(requested_verified_entity_type) else null end,
         verified_registration_date = case when requested_result = 'verified'
           then registration_date else null end,
         verified_address = case when requested_result = 'verified'
           then btrim(requested_verified_address) else null end,
         verified_registry_status = case when requested_result = 'verified'
           then requested_verified_registry_status else null end,
         verified_at = case when requested_result in ('verified', 'verified_incomplete')
           then clock_timestamp() else null end,
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
    case when requested_result in ('verified', 'verified_incomplete') then 'success'
      when requested_result in ('not_verified', 'incomplete') then 'denied' else 'failure' end,
    'organization-application', application.id::text, 'healthcare-operations',
    'application', 'identity-api', jsonb_build_object(
      'productCode', application.product_code, 'result', requested_result,
      'failureCategory', requested_failure_category
    )
  );
  return query select application.status, application.row_version;
end;
$$;

revoke all on function identity.admin_record_organization_cac_result(
  uuid,bigint,text,text,text,text,text,text,text,text,text) from public;
