-- Self-service provider onboarding after authoritative CAC verification.
-- This extends the existing organization application path without removing
-- administrator review for exceptions, existing organizations, or conflicts.

alter table identity.organization_applications
  add column if not exists approval_mode text not null default 'admin_review'
    check (approval_mode in ('admin_review', 'self_service'));

alter table identity.organization_applications
  drop constraint if exists organization_applications_status_check;

alter table identity.organization_applications
  add constraint organization_applications_status_check check (
    status in ('pending_verification', 'ready_for_review', 'approved', 'rejected')
  );

alter table identity.organization_applications
  drop constraint if exists organization_applications_review_check;

alter table identity.organization_applications
  add constraint organization_applications_review_check check (
    status not in ('approved', 'rejected')
    or (
      reviewed_at is not null
      and length(btrim(coalesce(review_reason, ''))) >= 8
      and (
        approval_mode = 'self_service'
        or reviewed_by_account_id is not null
      )
    )
  );

create index if not exists organization_applications_self_service_idx
  on identity.organization_applications (cac_registration_number, product_code, administrator_email)
  where approval_mode = 'self_service' and status in ('pending_verification', 'ready_for_review');

create function identity.public_get_organization_application(
  requested_cac_number text,
  requested_email text,
  requested_product text
) returns table (
  application_id uuid,
  application_status text,
  verification_result text,
  provider_verified_registration_number text,
  row_version bigint
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_cac_number !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or requested_email is null
     or requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy') then
    raise exception using errcode = '42501', message = 'Public organization enrollment context is required';
  end if;

  return query
    select application.id, application.status, application.verification_result,
      application.provider_verified_registration_number, application.row_version
    from identity.organization_applications application
    where application.cac_registration_number = upper(btrim(requested_cac_number))
      and application.administrator_email = lower(btrim(requested_email))
      and application.product_code = requested_product
      and application.status <> 'rejected'
    order by application.created_at desc
    limit 1;
end;
$$;

create function identity.public_record_organization_cac_result(
  requested_application_id uuid,
  expected_version bigint,
  requested_result text,
  requested_provider_reference text,
  requested_registration_number text,
  requested_organization_name text,
  requested_entity_type text,
  requested_registration_date text,
  requested_address text,
  requested_registry_status text
) returns table (
  application_status text,
  row_version bigint
)
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  application identity.organization_applications%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_result not in ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')
     or requested_application_id is null then
    raise exception using errcode = '42501', message = 'Public organization verification context is required';
  end if;

  select * into application
    from identity.organization_applications row
   where row.id = requested_application_id
     and row.approval_mode = 'self_service'
     and row.status in ('pending_verification', 'ready_for_review')
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Organization application not found';
  end if;

  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;

  if requested_result = 'verified' then
    if requested_registration_number is null
       or requested_registration_number <> application.cac_registration_number
       or length(btrim(coalesce(requested_organization_name, ''))) not between 2 and 200
       or length(btrim(coalesce(requested_entity_type, ''))) not between 2 and 120
       or requested_registration_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or length(btrim(coalesce(requested_address, ''))) not between 5 and 1000
       or lower(btrim(coalesce(requested_registry_status, ''))) <> 'active'
       or requested_provider_reference is null
       or requested_provider_reference !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message = 'Invalid CAC verification evidence';
    end if;
  end if;

  update identity.organization_applications row
     set approval_mode = 'self_service',
         verification_result = requested_result,
         verification_failure_category = case
           when requested_result = 'verified' then null
           when requested_result = 'not_verified' then 'not_verified'
           when requested_result = 'incomplete' then 'incomplete'
           when requested_result = 'disabled' then 'disabled'
           else 'unexpected_response'
         end,
         provider_reference = requested_provider_reference,
         provider_verified_registration_number = requested_registration_number,
         qoreid_organization_name = case when requested_result = 'verified'
           then btrim(requested_organization_name) else null end,
         qoreid_entity_type = case when requested_result = 'verified'
           then btrim(requested_entity_type) else null end,
         qoreid_registration_date = case when requested_result = 'verified'
           then requested_registration_date::date else null end,
         qoreid_address = case when requested_result = 'verified'
           then btrim(requested_address) else null end,
         qoreid_registry_status = case when requested_result = 'verified'
           then lower(btrim(requested_registry_status)) else null end,
         verified_organization_name = case when requested_result = 'verified'
           then btrim(requested_organization_name) else row.verified_organization_name end,
         verified_entity_type = case when requested_result = 'verified'
           then btrim(requested_entity_type) else row.verified_entity_type end,
         verified_registration_date = case when requested_result = 'verified'
           then requested_registration_date::date else row.verified_registration_date end,
         verified_address = case when requested_result = 'verified'
           then btrim(requested_address) else row.verified_address end,
         verified_registry_status = case when requested_result = 'verified'
           then lower(btrim(requested_registry_status)) else row.verified_registry_status end,
         organization_name = case when requested_result = 'verified'
           then btrim(requested_organization_name) else row.organization_name end,
         organization_name_source = case when requested_result = 'verified'
           then 'qoreid' else row.organization_name_source end,
         entity_type_source = case when requested_result = 'verified'
           then 'qoreid' else row.entity_type_source end,
         registration_date_source = case when requested_result = 'verified'
           then 'qoreid' else row.registration_date_source end,
         address_source = case when requested_result = 'verified'
           then 'qoreid' else row.address_source end,
         registry_status_source = case when requested_result = 'verified'
           then 'qoreid' else row.registry_status_source end,
         profile_state = case when requested_result = 'verified' then 'complete' else row.profile_state end,
         status = case when requested_result = 'verified' then 'ready_for_review'
           else 'pending_verification' end,
         verified_at = case when requested_result = 'verified' then clock_timestamp() else null end,
         updated_at = clock_timestamp(),
         row_version = row.row_version + 1
   where row.id = application.id
   returning row.* into application;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.cac-verify',
    case when requested_result = 'verified' then 'success' else 'denied' end,
    'organization-application', application.id::text,
    'application', 'identity-api',
    jsonb_build_object('productCode', application.product_code, 'result', requested_result)
  );

  return query select application.status, application.row_version;
end;
$$;

create function identity.activate_self_service_organization_application(
  requested_session_hmac char(64),
  requested_password_hash text
) returns table (
  organization_id uuid,
  facility_id uuid,
  account_id uuid,
  row_version bigint,
  hid_subject text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  challenge identity.organization_profile_completion_challenges%rowtype;
  application identity.organization_applications%rowtype;
  existing_registration identity.organization_cac_registrations%rowtype;
  new_organization_id uuid;
  new_facility_id uuid;
  new_account_id uuid;
  new_staff_id uuid;
  new_membership_id uuid;
  new_application identity.organization_applications%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_session_hmac is null
     or requested_session_hmac !~ '^[a-f0-9]{64}$'
     or requested_password_hash is null
     or length(requested_password_hash) < 20 then
    raise exception using errcode = '42501', message = 'Self-service activation context is required';
  end if;

  select * into challenge
    from identity.organization_profile_completion_challenges row
   where row.session_hmac = requested_session_hmac
     and row.consumed_at is not null
     and row.invalidated_at is null
     and row.session_expires_at > clock_timestamp()
   for update;

  if not found then
    raise exception using errcode = '42501', message = 'Organization enrollment session is invalid';
  end if;

  select * into application
    from identity.organization_applications row
   where row.id = challenge.application_id
   for update;

  if not found
     or application.approval_mode <> 'self_service'
     or application.status <> 'ready_for_review'
     or application.verification_result <> 'verified'
     or application.verified_at is null
     or application.provider_verified_registration_number <> application.cac_registration_number
     or application.qoreid_registry_status <> 'active'
     or application.qoreid_organization_name is null
     or application.qoreid_entity_type is null
     or application.qoreid_registration_date is null
     or application.qoreid_address is null then
    raise exception using errcode = '23514', message = 'Verified CAC enrollment is not ready for activation';
  end if;

  if lower(application.administrator_email) in (
    select lower(account.email) from auth.accounts account
    where account.email is not null and account.status <> 'deleted'
  ) or exists (
    select 1 from identity.staff staff
    where lower(staff.email) = lower(application.administrator_email)
  ) then
    raise exception using errcode = '23505', message = 'Administrator email already belongs to an account';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('self-service-org-cac:' || application.cac_registration_number, 0));

  select * into existing_registration
    from identity.organization_cac_registrations row
   where row.cac_registration_number = application.cac_registration_number
   for update;

  if found then
    raise exception using errcode = '23514', message = 'This CAC is already bound to an HID organization and requires manual resolution';
  end if;

  if exists (
    select 1 from identity.organizations row
    where lower(row.name) = lower(application.qoreid_organization_name)
  ) then
    raise exception using errcode = '23514', message = 'An organization with this verified name already exists and requires manual resolution';
  end if;

  new_organization_id := gen_random_uuid();
  new_facility_id := gen_random_uuid();
  new_account_id := gen_random_uuid();
  new_staff_id := gen_random_uuid();
  new_membership_id := gen_random_uuid();

  insert into identity.organizations (id, name, slug, active, source_system)
  values (
    new_organization_id, application.qoreid_organization_name,
    'org-' || replace(new_organization_id::text, '-', ''), true, 'hid'
  );

  insert into identity.facilities (
    id, organization_id, name, code, active, lifecycle_status, timezone, source_system
  ) values (
    new_facility_id, new_organization_id, application.qoreid_organization_name,
    'ORG-' || replace(new_facility_id::text, '-', ''), true, 'verified', 'Africa/Lagos', 'hid'
  );

  insert into identity.organization_cac_registrations (
    cac_registration_number, organization_id, primary_facility_id, source_application_id
  ) values (
    application.cac_registration_number, new_organization_id, new_facility_id, application.id
  );

  insert into identity.organization_products (
    organization_id, product_code, facility_id, source_application_id
  ) values (
    new_organization_id, application.product_code, new_facility_id, application.id
  );

  insert into auth.accounts (
    id, subject, email, display_name, password_hash, password_algorithm, status, source_system
  ) values (
    new_account_id, 'org-onboarding:' || new_account_id::text,
    lower(application.administrator_email), application.administrator_name,
    requested_password_hash, 'argon2id', 'active', 'hid'
  );

  insert into identity.staff (
    id, account_id, full_name, email, verification_status, default_role, active, source_system
  ) values (
    new_staff_id, new_account_id, application.administrator_name,
    lower(application.administrator_email), 'verified', 'org_admin', true, 'hid'
  );

  insert into identity.staff_facility_memberships (
    id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, source_system
  ) values (
    new_membership_id, new_staff_id, new_account_id, new_organization_id, new_facility_id,
    'org_admin', 'org_admin', true, true, 'hid'
  );

  insert into auth.account_roles (
    id, account_id, role_code, scope_type, membership_id, facility_id,
    granted_by, grant_reason
  ) values (
    gen_random_uuid(), new_account_id, 'org_admin', 'facility', new_membership_id,
    new_facility_id, null, 'Automated CAC and administrator-email self-service onboarding'
  );

  update identity.organization_applications row
     set status = 'approved',
         organization_id = new_organization_id,
         facility_id = new_facility_id,
         first_admin_account_id = new_account_id,
         reviewed_by_account_id = null,
         review_reason = 'Automated CAC and administrator-email verification',
         reviewed_at = clock_timestamp(),
         updated_at = clock_timestamp(),
         row_version = row.row_version + 1
   where row.id = application.id
   returning row.* into new_application;

  update identity.organization_profile_completion_challenges
     set invalidated_at = clock_timestamp()
   where id = challenge.id;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    organization_id, facility_id, purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.activate', 'success',
    'organization-application', application.id::text,
    new_organization_id, new_facility_id, 'healthcare-operations',
    'application', 'identity-api',
    jsonb_build_object(
      'productCode', application.product_code,
      'cacVerified', true,
      'emailVerified', true,
      'approvalMode', 'self_service'
    )
  );

  return query select new_organization_id, new_facility_id, new_account_id,
    new_application.row_version, 'org-onboarding:' || new_account_id::text;
end;
$$;

revoke all on function identity.public_get_organization_application(text,text,text),
  identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text),
  identity.activate_self_service_organization_application(char,text) from public;
