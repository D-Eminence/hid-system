-- One governed organization application path for EHR, Migrate, Laboratory,
-- and Pharmacy. The CAC number is retained only in this restricted intake and
-- binding data so reviewers can verify and deduplicate the legal entity. It
-- never enters verification_evidence, audit details, or public API responses.

create table identity.organization_applications (
  id uuid primary key default gen_random_uuid(),
  product_code text not null check (product_code in ('ehr', 'migrate', 'laboratory', 'pharmacy')),
  organization_name text not null check (length(btrim(organization_name)) between 2 and 200),
  organization_type text not null check (organization_type in
    ('clinic', 'hospital', 'laboratory', 'pharmacy', 'other')),
  cac_registration_number text not null check (cac_registration_number ~ '^(RC|BN|IT)[0-9]{4,20}$'),
  administrator_name text not null check (length(btrim(administrator_name)) between 2 and 200),
  administrator_email text not null check (
    length(administrator_email) between 3 and 254
    and administrator_email = lower(btrim(administrator_email))
    and administrator_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  status text not null default 'pending_verification'
    check (status in ('pending_verification', 'ready_for_review', 'approved', 'rejected')),
  verification_result text check (verification_result in
    ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')),
  verification_failure_category text check (verification_failure_category in (
    'not_verified', 'incomplete', 'provider_authentication', 'provider_unavailable',
    'timeout', 'network', 'malformed_response', 'unexpected_response', 'disabled'
  )),
  provider_reference text check (provider_reference is null or (
    length(provider_reference) between 1 and 255
    and provider_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  )),
  verified_at timestamptz,
  organization_id uuid references identity.organizations(id) on delete restrict,
  facility_id uuid references identity.facilities(id) on delete restrict,
  first_admin_account_id uuid references auth.accounts(id) on delete restrict,
  reviewed_by_account_id uuid references auth.accounts(id) on delete restrict,
  review_reason text,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  check (status not in ('ready_for_review', 'approved')
    or (verification_result = 'verified' and verified_at is not null)),
  check (status <> 'approved' or (organization_id is not null and facility_id is not null)),
  check (status not in ('approved', 'rejected') or (reviewed_by_account_id is not null
    and reviewed_at is not null and length(btrim(review_reason)) >= 8)),
  check (verification_result is distinct from 'verified' or verification_failure_category is null),
  check (verification_result is distinct from 'not_verified' or verification_failure_category = 'not_verified'),
  check (verification_result is distinct from 'incomplete' or verification_failure_category = 'incomplete')
);

create unique index organization_applications_open_cac_product_uq
  on identity.organization_applications (cac_registration_number, product_code)
  where status <> 'rejected';
create index organization_applications_review_idx
  on identity.organization_applications (status, created_at desc, id);

create table identity.organization_cac_registrations (
  cac_registration_number text primary key check (cac_registration_number ~ '^(RC|BN|IT)[0-9]{4,20}$'),
  organization_id uuid not null unique references identity.organizations(id) on delete restrict,
  primary_facility_id uuid not null,
  source_application_id uuid not null references identity.organization_applications(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (primary_facility_id, organization_id)
    references identity.facilities(id, organization_id) on delete restrict
);

create table identity.organization_products (
  organization_id uuid not null references identity.organizations(id) on delete restrict,
  product_code text not null check (product_code in ('ehr', 'migrate', 'laboratory', 'pharmacy')),
  facility_id uuid not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  source_application_id uuid not null unique references identity.organization_applications(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, product_code),
  foreign key (facility_id, organization_id)
    references identity.facilities(id, organization_id) on delete restrict
);

-- The API runtime receives EXECUTE on the narrow commands below, not direct
-- INSERT/UPDATE/SELECT on onboarding, organization, or account tables.
create function identity.organization_application_admin_account(requested_permission text)
returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not identity.has_active_membership(
       platform.current_actor_subject(), platform.current_membership_id(), platform.current_facility_id()
     )
     or not auth.account_has_platform_permission(actor_account, requested_permission) then
    raise exception using errcode = '42501', message = 'Organization onboarding administration is required';
  end if;
  return actor_account;
end;
$$;

create function identity.submit_organization_application(
  requested_product text,
  requested_organization_name text,
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
  if requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy')
     or length(btrim(coalesce(requested_organization_name, ''))) not between 2 and 200
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
    product_code, organization_name, organization_type, cac_registration_number,
    administrator_name, administrator_email
  ) values (
    requested_product, btrim(requested_organization_name), requested_organization_type, normalized_cac,
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
  application_status text, verification_result text, row_version bigint,
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
      application.status, application.verification_result, application.row_version,
      application.created_at, application.verified_at, application.reviewed_at
    from identity.organization_applications application
    where requested_status is null or application.status = requested_status
    order by application.created_at desc, application.id desc
    limit 100;
end;
$$;

create function identity.admin_get_organization_application(requested_application_id uuid)
returns table (
  application_id uuid, product_code text, cac_registration_number text,
  application_status text, row_version bigint
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
begin
  perform identity.organization_application_admin_account('platform.facility.manage');
  return query
    select application.id, application.product_code, application.cac_registration_number,
      application.status, application.row_version
    from identity.organization_applications application
    where application.id = requested_application_id;
end;
$$;

create function identity.admin_record_organization_cac_result(
  requested_application_id uuid,
  expected_version bigint,
  requested_result text,
  requested_provider_reference text,
  requested_failure_category text
) returns table (application_status text, row_version bigint)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.organization_application_admin_account('platform.facility.manage');
  application identity.organization_applications%rowtype;
begin
  if requested_result not in ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')
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
  update identity.organization_applications row
     set status = case when requested_result = 'verified' then 'ready_for_review' else 'pending_verification' end,
         verification_result = requested_result,
         verification_failure_category = requested_failure_category,
         provider_reference = requested_provider_reference,
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

create function identity.admin_approve_organization_application(
  requested_application_id uuid,
  expected_version bigint,
  requested_existing_organization_id uuid,
  requested_existing_facility_id uuid,
  requested_reason text
) returns table (
  organization_id uuid, facility_id uuid, first_admin_account_id uuid,
  row_version bigint, organization_reused boolean
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.organization_application_admin_account('platform.facility.manage');
  application identity.organization_applications%rowtype;
  registration identity.organization_cac_registrations%rowtype;
  new_organization_id uuid;
  new_facility_id uuid;
  new_account_id uuid;
  new_staff_id uuid;
  new_membership_id uuid;
  reused boolean := false;
  product_status text;
begin
  if not auth.account_has_platform_permission(actor_account, 'platform.principal.manage')
     or not auth.account_has_platform_permission(actor_account, 'platform.role.manage') then
    raise exception using errcode = '42501', message = 'Organization administrator provisioning is not authorized';
  end if;
  if length(btrim(coalesce(requested_reason, ''))) < 8
     or (requested_existing_organization_id is null) <> (requested_existing_facility_id is null) then
    raise exception using errcode = '22023', message = 'Invalid organization approval';
  end if;
  select * into application from identity.organization_applications row
   where row.id = requested_application_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Organization application not found'; end if;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;
  if application.status <> 'ready_for_review' or application.verification_result <> 'verified'
     or application.verified_at is null then
    raise exception using errcode = '23514', message = 'Verified CAC and pending review are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('org-cac:' || application.cac_registration_number, 0));
  select * into registration from identity.organization_cac_registrations row
   where row.cac_registration_number = application.cac_registration_number for update;
  if found then
    new_organization_id := registration.organization_id;
    new_facility_id := registration.primary_facility_id;
    reused := true;
    if requested_existing_organization_id is null
       or requested_existing_organization_id <> new_organization_id
       or requested_existing_facility_id <> new_facility_id then
      raise exception using errcode = '23514', message = 'Existing organization requires explicit review';
    end if;
  elsif requested_existing_organization_id is not null then
    new_organization_id := requested_existing_organization_id;
    new_facility_id := requested_existing_facility_id;
    reused := true;
    if exists (select 1 from identity.organization_cac_registrations row
      where row.organization_id = new_organization_id) then
      raise exception using errcode = '23514', message = 'Organization already has a different CAC binding';
    end if;
  else
    if exists (select 1 from identity.organizations row
      where lower(row.name) = lower(application.organization_name)) then
      raise exception using errcode = '23514', message = 'Existing organization must be reviewed and linked';
    end if;
    new_organization_id := gen_random_uuid();
    new_facility_id := gen_random_uuid();
    insert into identity.organizations (id, name, slug, active, source_system)
      values (new_organization_id, application.organization_name,
        'org-' || replace(new_organization_id::text, '-', ''), true, 'hid');
    insert into identity.facilities (
      id, organization_id, name, code, active, lifecycle_status, timezone, source_system
    ) values (
      new_facility_id, new_organization_id, application.organization_name,
      'ORG-' || replace(new_facility_id::text, '-', ''), true, 'verified', 'Africa/Lagos', 'hid'
    );
  end if;

  if not exists (
    select 1 from identity.organizations organization
    join identity.facilities facility
      on facility.organization_id = organization.id
    where organization.id = new_organization_id and organization.active
      and facility.id = new_facility_id and facility.active
      and facility.lifecycle_status = 'verified'
  ) then
    raise exception using errcode = '23514', message = 'Active verified organization facility is required';
  end if;
  if registration.cac_registration_number is null then
    insert into identity.organization_cac_registrations (
      cac_registration_number, organization_id, primary_facility_id, source_application_id
    ) values (
      application.cac_registration_number, new_organization_id, new_facility_id, application.id
    );
  end if;

  select product.status into product_status from identity.organization_products product
    where product.organization_id = new_organization_id and product.product_code = application.product_code;
  if product_status = 'suspended' then
    raise exception using errcode = '23514', message = 'Suspended product enrollment requires separate review';
  end if;
  if product_status is null then
    insert into identity.organization_products (
      organization_id, product_code, facility_id, source_application_id
    ) values (new_organization_id, application.product_code, new_facility_id, application.id);
  end if;

  if reused then
    -- A CAC lookup proves registry status, not this applicant's authority to
    -- administer an existing HID organization. Reuse requires an already
    -- active organization administrator with the submitted contact email.
    select account.id into new_account_id
      from auth.accounts account
      join identity.staff staff on staff.account_id = account.id
      join identity.staff_facility_memberships membership
        on membership.staff_id = staff.id and membership.account_id = account.id
      join auth.account_roles assignment
        on assignment.account_id = account.id
       and assignment.membership_id = membership.id
       and assignment.facility_id = membership.facility_id
       and assignment.role_code = 'org_admin'
       and assignment.revoked_at is null
     where lower(account.email) = application.administrator_email
       and account.status = 'active' and staff.active and membership.active
       and membership.organization_id = new_organization_id
       and membership.facility_id = new_facility_id
     limit 1;
    if new_account_id is null then
      raise exception using errcode = '23514',
        message = 'Existing organization administrator requires manual resolution';
    end if;
  else
    if exists (select 1 from auth.accounts account
        where lower(account.email) = application.administrator_email and account.status <> 'deleted')
       or exists (select 1 from identity.staff staff
        where lower(staff.email) = application.administrator_email) then
      raise exception using errcode = '23505', message = 'First administrator email requires manual resolution';
    end if;
    new_account_id := gen_random_uuid();
    new_staff_id := gen_random_uuid();
    new_membership_id := gen_random_uuid();
    insert into auth.accounts (
      id, subject, email, display_name, status, source_system
    ) values (
      new_account_id, 'org-onboarding:' || new_account_id::text,
      application.administrator_email, application.administrator_name, 'pending_reset', 'hid'
    );
    insert into identity.staff (
      id, account_id, full_name, email, verification_status, default_role, active, source_system
    ) values (
      new_staff_id, new_account_id, application.administrator_name,
      application.administrator_email, 'verified', 'org_admin', true, 'hid'
    );
    insert into identity.staff_facility_memberships (
      id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active, source_system
    ) values (
      new_membership_id, new_staff_id, new_account_id, new_organization_id, new_facility_id,
      'org_admin', 'org_admin', true, true, 'hid'
    );
    insert into auth.account_roles (
      id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason
    ) values (
      gen_random_uuid(), new_account_id, 'org_admin', 'facility', new_membership_id,
      new_facility_id, actor_account, 'Approved verified organization application'
    );
  end if;

  update identity.organization_applications row
     set status = 'approved', organization_id = new_organization_id,
         facility_id = new_facility_id, first_admin_account_id = new_account_id,
         reviewed_by_account_id = actor_account, review_reason = btrim(requested_reason),
         reviewed_at = clock_timestamp(), updated_at = clock_timestamp(),
         row_version = row.row_version + 1
   where row.id = application.id returning row.* into application;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor_account,
    platform.current_membership_id(), new_organization_id, platform.current_facility_id(),
    'identity.organization.application.approve', 'success',
    'organization-application', application.id::text, 'healthcare-operations',
    btrim(requested_reason), 'application', 'identity-api', jsonb_build_object(
      'productCode', application.product_code, 'organizationReused', reused,
      'firstAdminPendingEmailOtp', not reused
    )
  );
  return query select new_organization_id, new_facility_id, new_account_id,
    application.row_version, reused;
end;
$$;

create function identity.admin_reject_organization_application(
  requested_application_id uuid,
  expected_version bigint,
  requested_reason text
) returns table (application_status text, row_version bigint)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.organization_application_admin_account('platform.facility.manage');
  application identity.organization_applications%rowtype;
begin
  if length(btrim(coalesce(requested_reason, ''))) < 8 then
    raise exception using errcode = '22023', message = 'Review reason is required';
  end if;
  select * into application from identity.organization_applications row
    where row.id = requested_application_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Organization application not found'; end if;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;
  if application.status not in ('pending_verification', 'ready_for_review') then
    raise exception using errcode = '23514', message = 'Organization application is closed';
  end if;
  update identity.organization_applications row
     set status = 'rejected', reviewed_by_account_id = actor_account,
         review_reason = btrim(requested_reason), reviewed_at = clock_timestamp(),
         updated_at = clock_timestamp(), row_version = row.row_version + 1
   where row.id = application.id returning row.* into application;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor_account,
    platform.current_membership_id(), platform.current_facility_id(),
    'identity.organization.application.reject', 'denied', 'organization-application',
    application.id::text, 'healthcare-operations', btrim(requested_reason),
    'application', 'identity-api', jsonb_build_object('productCode', application.product_code)
  );
  return query select application.status, application.row_version;
end;
$$;

revoke all on identity.organization_applications,
  identity.organization_cac_registrations, identity.organization_products from public;
revoke all on function identity.organization_application_admin_account(text) from public;
revoke all on function identity.submit_organization_application(text,text,text,text,text,text) from public;
revoke all on function identity.admin_list_organization_applications(text) from public;
revoke all on function identity.admin_get_organization_application(uuid) from public;
revoke all on function identity.admin_record_organization_cac_result(uuid,bigint,text,text,text) from public;
revoke all on function identity.admin_approve_organization_application(uuid,bigint,uuid,uuid,text) from public;
revoke all on function identity.admin_reject_organization_application(uuid,bigint,text) from public;
