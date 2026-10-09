-- Close the PR #5 status-only CAC approval gap. The provider result must bind
-- the submitted registration number to an active registered legal name. Existing
-- unreviewed status-only evidence is reset; an already approved legacy row
-- requires explicit migration review instead of silent grandfathering.
do $$
begin
  if exists (select 1 from identity.organization_applications where status = 'approved') then
    raise exception 'Previously approved CAC applications need explicit legal-entity binding review';
  end if;
end $$;

update identity.organization_applications
   set status = 'pending_verification', verification_result = null,
       verification_failure_category = null, provider_reference = null,
       verified_at = null, row_version = row_version + 1, updated_at = clock_timestamp()
 where status = 'ready_for_review';

alter table identity.organization_applications
  add column verified_organization_name text
    check (verified_organization_name is null or (
      length(btrim(verified_organization_name)) between 2 and 200
      and verified_organization_name !~ '[[:cntrl:]]'
    ));
alter table identity.organization_applications
  add constraint organization_applications_verified_legal_name_ck
    check (status not in ('ready_for_review', 'approved')
      or (verification_result = 'verified' and verified_at is not null
        and verified_organization_name is not null));

-- Remove old signatures: leaving either command executable would permit a
-- five-argument status-only result to become an approved organization.
drop function identity.admin_list_organization_applications(text);
drop function identity.admin_record_organization_cac_result(uuid,bigint,text,text,text);

create function identity.admin_list_organization_applications(requested_status text)
returns table (
  application_id uuid, product_code text, organization_name text, organization_type text,
  cac_hint text, administrator_name text, administrator_email text,
  application_status text, verification_result text, verified_organization_name text, row_version bigint,
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
      application.status, application.verification_result, application.verified_organization_name, application.row_version,
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
  requested_verified_organization_name text
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
  if requested_result = 'verified' then
    if requested_verified_registration_number is distinct from application.cac_registration_number
       or length(btrim(coalesce(requested_verified_organization_name, ''))) not between 2 and 200
       or requested_verified_organization_name ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'Verified legal-entity binding is required';
    end if;
  elsif requested_verified_registration_number is not null
     or requested_verified_organization_name is not null then
    raise exception using errcode = '22023', message = 'Unverified result cannot carry a legal-entity binding';
  end if;
  update identity.organization_applications row
     set status = case when requested_result = 'verified' then 'ready_for_review' else 'pending_verification' end,
         verification_result = requested_result,
         verification_failure_category = requested_failure_category,
         provider_reference = requested_provider_reference,
         verified_organization_name = case when requested_result = 'verified'
           then btrim(requested_verified_organization_name) else null end,
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

create or replace function identity.admin_approve_organization_application(
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
     or application.verified_at is null or application.verified_organization_name is null then
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
      where lower(row.name) = lower(application.verified_organization_name)) then
      raise exception using errcode = '23514', message = 'Existing organization must be reviewed and linked';
    end if;
    new_organization_id := gen_random_uuid();
    new_facility_id := gen_random_uuid();
    insert into identity.organizations (id, name, slug, active, source_system)
      values (new_organization_id, application.verified_organization_name,
        'org-' || replace(new_organization_id::text, '-', ''), true, 'hid');
    insert into identity.facilities (
      id, organization_id, name, code, active, lifecycle_status, timezone, source_system
    ) values (
      new_facility_id, new_organization_id, application.verified_organization_name,
      'ORG-' || replace(new_facility_id::text, '-', ''), true, 'verified', 'Africa/Lagos', 'hid'
    );
  end if;

  -- A registry result for one legal entity must never be attached to a
  -- different legacy organization merely because the same administrator can
  -- access it. A name change needs a separate evidence-backed reconciliation.
  if reused and not exists (
    select 1 from identity.organizations organization
    where organization.id = new_organization_id
      and lower(btrim(organization.name)) = lower(btrim(application.verified_organization_name))
  ) then
    raise exception using errcode = '23514', message = 'Existing organization legal name requires separate review';
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

-- Existing-organization CAC checks must refer to the exact legal identity
-- already bound during onboarding. No registration number or name is returned.
create function identity.current_organization_cac_binding_matches(
  requested_context text,
  requested_registration_number text,
  requested_legal_name text
) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_subject_value text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject_value);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  expected_product text;
begin
  if actor_account_id is null or actor_membership_id is null or actor_facility_id is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.membership_has_permission(
       actor_subject_value, actor_membership_id, actor_facility_id, 'organization.manage'
     ) then
    raise exception using errcode = '42501', message = 'Organization CAC binding authorization is required';
  end if;
  expected_product := case requested_context when 'hospital' then 'ehr'
    when 'laboratory' then 'laboratory' when 'pharmacy' then 'pharmacy' else null end;
  if expected_product is null
     or requested_registration_number !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or length(btrim(coalesce(requested_legal_name, ''))) not between 2 and 200
     or requested_legal_name ~ '[[:cntrl:]]' then
    return false;
  end if;
  return exists (
    select 1
    from identity.staff_facility_memberships membership
    join identity.facilities facility on facility.id = membership.facility_id
    join identity.organizations organization_row on organization_row.id = facility.organization_id
    join identity.organization_cac_registrations binding
      on binding.organization_id = organization_row.id
    join identity.organization_applications application
      on application.id = binding.source_application_id
    join identity.organization_products product
      on product.organization_id = organization_row.id and product.facility_id = facility.id
    where membership.id = actor_membership_id and membership.account_id = actor_account_id
      and membership.facility_id = actor_facility_id
      and membership.organization_id = organization_row.id and membership.active
      and facility.active and facility.lifecycle_status = 'verified' and organization_row.active
      and product.product_code = expected_product and product.status = 'active'
      and binding.cac_registration_number = requested_registration_number
      and application.cac_registration_number = binding.cac_registration_number
      and application.organization_id = organization_row.id
      and application.status = 'approved' and application.verification_result = 'verified'
      and application.verified_organization_name is not null
      and regexp_replace(lower(btrim(application.verified_organization_name)), '[[:space:]]+', ' ', 'g')
        = regexp_replace(lower(btrim(requested_legal_name)), '[[:space:]]+', ' ', 'g')
  );
end;
$$;

revoke all on function identity.admin_list_organization_applications(text) from public;
revoke all on function identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text) from public;
revoke all on function identity.current_organization_cac_binding_matches(text,text,text) from public;
