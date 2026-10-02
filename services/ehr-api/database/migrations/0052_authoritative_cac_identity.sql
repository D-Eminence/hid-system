-- Public applicants provide a registration identifier and an administrator
-- contact. Registry identity is populated only by the reviewed QoreID result.
-- Previously approved organizations remain usable, but their historical
-- name-only evidence is not silently upgraded to a complete registry binding.

update identity.organization_applications
   set status = 'pending_verification', verification_result = null,
       verification_failure_category = null, provider_reference = null,
       verified_organization_name = null, verified_at = null,
       row_version = row_version + 1, updated_at = clock_timestamp()
 where status = 'ready_for_review';

alter table identity.organization_applications alter column organization_name drop not null;
update identity.organization_applications
   set organization_name = case when status = 'approved' then verified_organization_name else null end;

alter table identity.organization_applications
  add column verified_entity_type text check (verified_entity_type is null or (
    length(btrim(verified_entity_type)) between 2 and 120
    and verified_entity_type !~ '[[:cntrl:]]')),
  add column verified_registration_date date check (
    verified_registration_date is null or verified_registration_date between date '1800-01-01' and current_date),
  add column verified_address text check (verified_address is null or (
    length(btrim(verified_address)) between 5 and 1000
    and verified_address !~ '[[:cntrl:]]')),
  add column verified_registry_status text check (
    verified_registry_status is null or verified_registry_status = 'active'),
  add constraint organization_applications_complete_cac_ck check (
    status <> 'ready_for_review' or (
      verification_result = 'verified' and provider_reference is not null
      and verified_organization_name is not null and verified_entity_type is not null
      and verified_registration_date is not null and verified_address is not null
      and verified_registry_status = 'active'
    ));

alter table identity.organization_cac_registrations
  add column verified_organization_name text,
  add column verified_entity_type text,
  add column verified_registration_date date,
  add column verified_address text,
  add column verified_registry_status text,
  add constraint organization_cac_registrations_complete_ck check (
    (verified_organization_name is null and verified_entity_type is null
      and verified_registration_date is null and verified_address is null
      and verified_registry_status is null)
    or (verified_organization_name is not null and verified_entity_type is not null
      and verified_registration_date is not null and verified_address is not null
      and verified_registry_status = 'active')
  );

-- A new registration binding carries the complete, already verified source
-- snapshot. A legacy registration has all new fields null and needs separate
-- reconciliation before it can enroll another product.
create function identity.populate_organization_cac_registry_binding()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, identity, pg_temp
as $$
declare application identity.organization_applications%rowtype;
begin
  select * into application from identity.organization_applications row
    where row.id = new.source_application_id;
  if not found or application.cac_registration_number <> new.cac_registration_number
     or application.status <> 'ready_for_review' or application.verification_result <> 'verified'
     or application.provider_reference is null
     or application.verified_organization_name is null
     or application.verified_entity_type is null
     or application.verified_registration_date is null
     or application.verified_address is null
     or application.verified_registry_status <> 'active' then
    raise exception using errcode = '23514', message = 'Complete registry binding is required';
  end if;
  new.verified_organization_name := application.verified_organization_name;
  new.verified_entity_type := application.verified_entity_type;
  new.verified_registration_date := application.verified_registration_date;
  new.verified_address := application.verified_address;
  new.verified_registry_status := application.verified_registry_status;
  return new;
end;
$$;
create trigger organization_cac_registry_binding_insert
before insert on identity.organization_cac_registrations
for each row execute function identity.populate_organization_cac_registry_binding();

create function identity.require_complete_organization_approval_binding()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, identity, pg_temp
as $$
declare binding identity.organization_cac_registrations%rowtype;
begin
  if new.status <> 'approved' or old.status = 'approved' then return new; end if;
  select * into binding from identity.organization_cac_registrations row
    where row.cac_registration_number = new.cac_registration_number;
  if new.verification_result <> 'verified' or new.provider_reference is null
     or new.verified_organization_name is null or new.verified_entity_type is null
     or new.verified_registration_date is null or new.verified_address is null
     or new.verified_registry_status <> 'active' or not found
     or binding.organization_id is distinct from new.organization_id
     or binding.primary_facility_id is distinct from new.facility_id
     or binding.verified_organization_name is distinct from new.verified_organization_name
     or binding.verified_entity_type is distinct from new.verified_entity_type
     or binding.verified_registration_date is distinct from new.verified_registration_date
     or binding.verified_address is distinct from new.verified_address
     or binding.verified_registry_status is distinct from new.verified_registry_status then
    raise exception using errcode = '23514', message = 'Complete matching registry binding is required';
  end if;
  return new;
end;
$$;
create trigger organization_application_complete_binding_approval
before update of status on identity.organization_applications
for each row execute function identity.require_complete_organization_approval_binding();

-- Remove the older public intake and name-only review commands. Their
-- signatures must not remain executable beside the new narrow commands.
drop function identity.submit_organization_application(text,text,text,text,text,text);
drop function identity.admin_list_organization_applications(text);
drop function identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text);

create function identity.submit_organization_application(
  requested_product text,
  requested_organization_type text,
  requested_cac_number text,
  requested_administrator_name text,
  requested_administrator_email text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  normalized_cac text := upper(regexp_replace(coalesce(requested_cac_number, ''), '[[:space:]]+', '', 'g'));
  normalized_email text := lower(btrim(coalesce(requested_administrator_email, '')));
  application_id_value uuid;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Organization application context is required';
  end if;
  if requested_product is null
     or requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy')
     or requested_organization_type is null
     or requested_organization_type not in ('clinic', 'hospital', 'laboratory', 'pharmacy', 'other')
     or normalized_cac !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or length(btrim(coalesce(requested_administrator_name, ''))) not between 2 and 200
     or length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'Invalid organization application';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('org-application:' || normalized_cac || ':' || requested_product, 0));
  select application.id into application_id_value
    from identity.organization_applications application
   where application.cac_registration_number = normalized_cac
     and application.product_code = requested_product
     and application.status <> 'rejected';
  if application_id_value is not null then return application_id_value; end if;

  insert into identity.organization_applications (
    product_code, organization_type, cac_registration_number,
    administrator_name, administrator_email
  ) values (
    requested_product, requested_organization_type, normalized_cac,
    btrim(requested_administrator_name), normalized_email
  ) returning id into application_id_value;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system', 'identity.organization.application.submit',
    'success', 'organization-application', application_id_value::text,
    'application', 'identity-api', jsonb_build_object(
      'productCode', requested_product, 'organizationType', requested_organization_type)
  );
  return application_id_value;
end;
$$;

create function identity.admin_list_organization_applications(requested_status text)
returns table (
  application_id uuid, product_code text, organization_name text, organization_type text,
  cac_hint text, administrator_name text, administrator_email text,
  application_status text, verification_result text, verified_organization_name text,
  verified_entity_type text, verified_registration_date text, verified_address text,
  verified_registry_status text, row_version bigint,
  created_at timestamptz, verified_at timestamptz, reviewed_at timestamptz
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
      application.created_at, application.verified_at, application.reviewed_at
    from identity.organization_applications application
    where requested_status is null or application.status = requested_status
    order by application.created_at desc, application.id desc
    limit 100;
end;
$$;

create function identity.admin_record_organization_cac_result(
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
     or requested_result not in ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')
     or requested_provider_reference is not null and (
       length(requested_provider_reference) not between 1 and 255
       or requested_provider_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
     )
     or (requested_result = 'verified' and requested_failure_category is not null)
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
    raise exception using errcode = '22023', message = 'Unverified result cannot carry registry identity';
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
      'failureCategory', requested_failure_category
    )
  );
  return query select application.status, application.row_version;
end;
$$;

revoke all on function identity.populate_organization_cac_registry_binding(),
  identity.require_complete_organization_approval_binding(),
  identity.submit_organization_application(text,text,text,text,text),
  identity.admin_list_organization_applications(text),
  identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text,text)
  from public;
