\set ON_ERROR_STOP on
begin;

insert into auth.accounts (id, subject, email, display_name, status)
values ('c4600000-0000-4000-8000-000000000001', 'staff:organization-onboarding-admin',
  'onboarding-admin@example.invalid', 'Onboarding Admin', 'active');
insert into identity.organizations (id, name, slug)
values ('c4610000-0000-4000-8000-000000000001', 'Onboarding Review Office', 'onboarding-review-office');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
values ('c4620000-0000-4000-8000-000000000001',
  'c4610000-0000-4000-8000-000000000001', 'Onboarding Review Office', 'ONBOARD-REVIEW',
  'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
values ('c4630000-0000-4000-8000-000000000001',
  'c4600000-0000-4000-8000-000000000001', 'Onboarding Admin',
  'onboarding-admin@example.invalid', 'verified', 'admin');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('c4640000-0000-4000-8000-000000000001',
  'c4630000-0000-4000-8000-000000000001',
  'c4600000-0000-4000-8000-000000000001',
  'c4610000-0000-4000-8000-000000000001',
  'c4620000-0000-4000-8000-000000000001', 'admin', 'admin', true, true);
insert into auth.account_roles
  (id, account_id, role_code, scope_type, grant_reason)
values ('c4650000-0000-4000-8000-000000000001',
  'c4600000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
  'Synthetic onboarding review test');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
select set_config('app.correlation_id', 'organization-onboarding-test-0001', true);

do $$
declare first_id uuid; repeated_id uuid;
begin
  select identity.submit_organization_application('migrate', 'clinic',
    'RC1234567', 'Migrate Administrator', 'Migrate.Admin@Example.Invalid') into first_id;
  select identity.submit_organization_application('migrate', 'clinic',
    'RC1234567', 'Migrate Administrator', 'Migrate.Admin@Example.Invalid') into repeated_id;
  if first_id <> repeated_id then raise exception 'Public retry created a second organization application'; end if;
  if to_regprocedure('identity.submit_organization_application(text,text,text,text,text,text)') is not null
     or to_regprocedure('identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text)') is not null then
    raise exception 'Superseded applicant-name or name-only CAC command remains executable';
  end if;
  begin
    perform 1 from identity.organization_applications;
    raise exception 'Runtime directly read restricted organization intake';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.admin_list_organization_applications(null);
    raise exception 'Public submit context read admin applications';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('app.actor_subject', 'staff:organization-onboarding-admin', true);
select set_config('app.facility_id', 'c4620000-0000-4000-8000-000000000001', true);
select set_config('app.membership_id', 'c4640000-0000-4000-8000-000000000001', true);
select set_config('app.purpose_of_use', 'healthcare-operations', true);

do $$
declare
  application_id_value uuid;
  changed record;
  approved record;
begin
  select application_id into application_id_value
    from identity.admin_list_organization_applications('pending_verification')
    where product_code = 'migrate' and cac_hint = 'RC*****67';
  if application_id_value is null then raise exception 'Admin list omitted the pending Migrate application'; end if;
  if exists (select 1 from identity.admin_list_organization_applications('pending_verification') item
    where item.application_id = application_id_value and (
      item.organization_name is not null or item.verified_organization_name is not null
      or item.verified_entity_type is not null or item.verified_registration_date is not null
      or item.verified_address is not null or item.verified_registry_status is not null)) then
    raise exception 'Public applicant populated registry identity before verification';
  end if;
  select * into changed from identity.admin_record_organization_cac_result(
    application_id_value, 1, 'not_verified', null, 'not_verified', null, null, null, null, null, null);
  if changed.application_status <> 'pending_verification' or changed.row_version <> 2 then
    raise exception 'Nonverified CAC moved the application to review';
  end if;
  begin
    perform identity.admin_approve_organization_application(
      application_id_value, 2, null, null, 'Synthetic governed approval');
    raise exception 'Unverified CAC was approved';
  exception when check_violation then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      application_id_value, 2, 'verified', 'qoreid-test-0001', null,
      null, null, null, null, null, null);
    raise exception 'Status-only CAC result was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      application_id_value, 2, 'verified', 'qoreid-test-0001', null,
      'RC9999999', 'Unrelated Company Limited', 'Private Limited Company',
      '2014-05-26', '10 Test Avenue, Lagos', 'active');
    raise exception 'Mismatched CAC registration number was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      application_id_value, 2, 'verified', 'qoreid-test-0001', null,
      'RC1234567', 'Verified Migrate Legal Limited', null,
      '2014-05-26', '10 Test Avenue, Lagos', 'active');
    raise exception 'CAC result with a missing entity type was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      application_id_value, 2, 'verified', 'qoreid-test-0001', null,
      'RC1234567', 'Verified Migrate Legal Limited', 'Private Limited Company',
      '2014-05-26', '10 Test Avenue, Lagos', 'inactive');
    raise exception 'Inactive CAC result was accepted';
  exception when invalid_parameter_value then null;
  end;
  select * into changed from identity.admin_record_organization_cac_result(
    application_id_value, 2, 'verified', 'qoreid-test-0001', null,
    'RC1234567', 'Verified Migrate Legal Limited', 'Private Limited Company',
    '2014-05-26', '10 Test Avenue, Lagos', 'active');
  if changed.application_status <> 'ready_for_review' or changed.row_version <> 3 then
    raise exception 'Verified CAC did not move the application to review';
  end if;
  if not exists (select 1 from identity.admin_list_organization_applications('ready_for_review') item
    where item.application_id = application_id_value
      and item.organization_name = 'Verified Migrate Legal Limited'
      and item.verified_organization_name = 'Verified Migrate Legal Limited'
      and item.verified_entity_type = 'Private Limited Company'
      and item.verified_registration_date = '2014-05-26'
      and item.verified_address = '10 Test Avenue, Lagos'
      and item.verified_registry_status = 'active') then
    raise exception 'Admin review omitted authoritative registry identity';
  end if;
  begin
    perform identity.admin_approve_organization_application(
      application_id_value, 2, null, null, 'Synthetic stale approval');
    raise exception 'Stale review version was accepted';
  exception when serialization_failure then null;
  end;
  select * into approved from identity.admin_approve_organization_application(
    application_id_value, 3, null, null, 'Synthetic governed approval');
  if approved.organization_reused or approved.row_version <> 4
     or approved.organization_id is null or approved.facility_id is null
     or approved.first_admin_account_id is null then
    raise exception 'Approved application did not provision organization, facility, and first admin';
  end if;
end $$;
reset role;

-- A verified provider response can still lack the legal-entity snapshot needed
-- for organization binding. Keep the provider evidence without creating one.
set local role hid_identity_api_runtime;
do $$
declare
  rc_application uuid;
  bn_application uuid;
  changed record;
begin
  perform set_config('app.actor_subject', 'system:auth', true);
  select identity.submit_organization_application('ehr', 'clinic',
    'RC1111111', 'Incomplete RC Applicant', 'incomplete-rc@example.invalid') into rc_application;
  select identity.submit_organization_application('laboratory', 'laboratory',
    'BN2222222', 'Incomplete BN Applicant', 'incomplete-bn@example.invalid') into bn_application;
  perform set_config('app.actor_subject', 'staff:organization-onboarding-admin', true);
  begin
    perform identity.admin_record_organization_cac_result(
      rc_application, 1, 'verified_incomplete', null, 'incomplete',
      null, null, null, null, null, null);
    raise exception 'Provider-verified incomplete result without reference was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      rc_application, 1, 'verified_incomplete', 'not-a-numeric-id', 'incomplete',
      null, null, null, null, null, null);
    raise exception 'Provider-verified incomplete result with nonnumeric reference was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      rc_application, 1, 'verified_incomplete', '86421', 'incomplete',
      'RC1111111', 'Applicant Claimed Company', null, null, null, null);
    raise exception 'Partial or applicant-supplied legal profile became provider identity';
  exception when invalid_parameter_value then null;
  end;
  select * into changed from identity.admin_record_organization_cac_result(
    rc_application, 1, 'verified_incomplete', '86421', 'incomplete',
    null, null, null, null, null, null);
  if changed.application_status <> 'pending_verification' or changed.row_version <> 2 then
    raise exception 'Incomplete RC profile moved into organization review';
  end if;
  select * into changed from identity.admin_record_organization_cac_result(
    bn_application, 1, 'verified_incomplete', '86422', 'incomplete',
    null, null, null, null, null, null);
  if changed.application_status <> 'pending_verification' or changed.row_version <> 2 then
    raise exception 'Incomplete BN profile moved into organization review';
  end if;
  if (select count(*) from identity.admin_list_organization_applications('pending_verification') item
      where item.application_id in (rc_application, bn_application)
        and item.verification_result = 'verified_incomplete'
        and item.verified_at is not null
        and item.organization_name is null
        and item.verified_organization_name is null
        and item.verified_entity_type is null
        and item.verified_registration_date is null
        and item.verified_address is null
        and item.verified_registry_status is null) <> 2 then
    raise exception 'Admin list did not distinguish verified but incomplete profiles';
  end if;
  begin
    perform identity.admin_approve_organization_application(
      rc_application, 2, null, null, 'Synthetic incomplete profile approval');
    raise exception 'Incomplete provider profile was approved';
  exception when check_violation then null;
  end;
end $$;
reset role;

do $$
begin
  if (select count(*) from identity.organization_applications application
      where application.cac_registration_number in ('RC1111111', 'BN2222222')
        and application.status = 'pending_verification'
        and application.verification_result = 'verified_incomplete'
        and application.verification_failure_category = 'incomplete'
        and application.provider_reference ~ '^[0-9]+$'
        and application.verified_at is not null
        and application.organization_name is null
        and application.verified_organization_name is null) <> 2 then
    raise exception 'Verified provider lookup or incomplete profile was not persisted accurately';
  end if;
  if exists (select 1 from identity.organization_cac_registrations binding
      where binding.cac_registration_number in ('RC1111111', 'BN2222222'))
     or exists (select 1 from identity.organization_products product
      join identity.organization_applications application on application.id = product.source_application_id
      where application.cac_registration_number in ('RC1111111', 'BN2222222')) then
    raise exception 'Incomplete provider profile created a legal registration or product binding';
  end if;
  begin
    update identity.organization_applications
       set status = 'ready_for_review'
     where cac_registration_number = 'RC1111111';
    raise exception 'Incomplete provider profile bypassed the review constraint';
  exception when check_violation then null;
  end;
end $$;

-- A later complete provider result may advance the same BN application, but
-- only with a new exact registry snapshot supplied through the governed call.
set local role hid_identity_api_runtime;
do $$
declare
  bn_application uuid;
  changed record;
begin
  select item.application_id into bn_application
    from identity.admin_list_organization_applications('pending_verification') item
    where item.cac_hint = 'BN*****22' and item.product_code = 'laboratory'
      and item.verification_result = 'verified_incomplete';
  if bn_application is null then raise exception 'Incomplete BN application was not available for retry'; end if;
  select * into changed from identity.admin_record_organization_cac_result(
    bn_application, 2, 'verified', '86423', null,
    'BN2222222', 'Verified BN Registry Limited', 'Business Name',
    '2018-06-12', '12 Synthetic Avenue, Abuja', 'active');
  if changed.application_status <> 'ready_for_review' or changed.row_version <> 3 then
    raise exception 'Complete provider retry did not advance BN application to review';
  end if;
  if not exists (select 1 from identity.admin_list_organization_applications('ready_for_review') item
    where item.application_id = bn_application
      and item.organization_name = 'Verified BN Registry Limited'
      and item.verified_organization_name = 'Verified BN Registry Limited'
      and item.verified_entity_type = 'Business Name'
      and item.verified_registration_date = '2018-06-12'
      and item.verified_address = '12 Synthetic Avenue, Abuja'
      and item.verified_registry_status = 'active') then
    raise exception 'Complete provider retry did not replace incomplete evidence with legal identity';
  end if;
end $$;
reset role;

do $$
begin
  if not exists (select 1 from identity.organization_applications application
      where application.cac_registration_number = 'BN2222222'
        and application.status = 'ready_for_review'
        and application.verification_result = 'verified'
        and application.verification_failure_category is null
        and application.provider_reference = '86423'
        and application.organization_name = 'Verified BN Registry Limited'
        and application.verified_organization_name = application.organization_name
        and application.verified_entity_type = 'Business Name'
        and application.verified_registration_date = date '2018-06-12'
        and application.verified_address = '12 Synthetic Avenue, Abuja'
        and application.verified_registry_status = 'active') then
    raise exception 'Complete BN retry retained incomplete or applicant-derived legal identity';
  end if;
end $$;

do $$ begin
  if not exists (select 1 from identity.organization_applications application
    join identity.organizations organization on organization.id = application.organization_id
    join identity.facilities facility on facility.id = application.facility_id
    where application.cac_registration_number = 'RC1234567'
      and application.product_code = 'migrate'
      and application.organization_name = 'Verified Migrate Legal Limited'
      and application.verified_organization_name = 'Verified Migrate Legal Limited'
      and application.verified_entity_type = 'Private Limited Company'
      and application.verified_registration_date = date '2014-05-26'
      and application.verified_address = '10 Test Avenue, Lagos'
      and application.verified_registry_status = 'active'
      and organization.name = application.verified_organization_name
      and facility.name = application.verified_organization_name) then
    raise exception 'Applicant-supplied name overrode verified legal name';
  end if;
  if not exists (select 1 from identity.organization_cac_registrations binding
    where binding.cac_registration_number = 'RC1234567'
      and binding.verified_organization_name = 'Verified Migrate Legal Limited'
      and binding.verified_entity_type = 'Private Limited Company'
      and binding.verified_registration_date = date '2014-05-26'
      and binding.verified_address = '10 Test Avenue, Lagos'
      and binding.verified_registry_status = 'active') then
    raise exception 'Approved CAC binding omitted authoritative registry fields';
  end if;
end $$;

-- The first admin must complete the existing OTP password setup before an
-- additional product can reuse the organization. Simulate that completion.
do $$ begin
  if (select count(*) from auth.accounts where email = 'migrate.admin@example.invalid'
      and status = 'pending_reset') <> 1 then
    raise exception 'First administrator did not start pending credential setup';
  end if;
end $$;
update auth.accounts set status = 'active'
where email = 'migrate.admin@example.invalid';
insert into auth.account_roles
  (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('c4650000-0000-4000-8000-000000000002',
  'c4600000-0000-4000-8000-000000000001', 'org_admin', 'facility',
  'c4640000-0000-4000-8000-000000000001',
  'c4620000-0000-4000-8000-000000000001', 'Synthetic existing organization authority');
select set_config('test.onboarding_organization_id', organization_id::text, true),
  set_config('test.onboarding_facility_id', facility_id::text, true),
  set_config('test.onboarding_first_admin_id', first_admin_account_id::text, true)
from identity.organization_applications
where cac_registration_number = 'RC1234567' and product_code = 'migrate';

set local role hid_identity_api_runtime;
do $$
declare
  second_application uuid;
  rogue_application uuid;
  changed_registry_application uuid;
  conflicting_application uuid;
  second_approval record;
begin
  perform set_config('app.actor_subject', 'system:auth', true);
  select identity.submit_organization_application('pharmacy', 'clinic',
    'RC1234567', 'Migrate Administrator', 'Migrate.Admin@Example.Invalid')
    into second_application;
  perform set_config('app.actor_subject', 'staff:organization-onboarding-admin', true);
  perform identity.admin_record_organization_cac_result(
    second_application, 1, 'verified', 'qoreid-test-0002', null,
    'RC1234567', 'Verified Migrate Legal Limited', 'Private Limited Company',
    '2014-05-26', '10 Test Avenue, Lagos', 'active');
  select * into second_approval from identity.admin_approve_organization_application(
    second_application, 2, current_setting('test.onboarding_organization_id')::uuid, current_setting('test.onboarding_facility_id')::uuid,
    'Synthetic existing organization review');
  if not second_approval.organization_reused
     or second_approval.organization_id <> current_setting('test.onboarding_organization_id')::uuid
     or second_approval.facility_id <> current_setting('test.onboarding_facility_id')::uuid
     or second_approval.first_admin_account_id <> current_setting('test.onboarding_first_admin_id')::uuid then
    raise exception 'Second product duplicated or captured the existing organization';
  end if;

  perform set_config('app.actor_subject', 'system:auth', true);
  select identity.submit_organization_application('laboratory', 'clinic',
    'RC1234567', 'Unrelated Applicant', 'unrelated@example.invalid')
    into rogue_application;
  perform set_config('app.actor_subject', 'staff:organization-onboarding-admin', true);
  perform identity.admin_record_organization_cac_result(
    rogue_application, 1, 'verified', 'qoreid-test-0003', null,
    'RC1234567', 'Verified Migrate Legal Limited', 'Private Limited Company',
    '2014-05-26', '10 Test Avenue, Lagos', 'active');
  begin
    perform identity.admin_approve_organization_application(
      rogue_application, 2, current_setting('test.onboarding_organization_id')::uuid, current_setting('test.onboarding_facility_id')::uuid,
      'Synthetic unproven administrator');
    raise exception 'Unrelated applicant captured an existing organization';
  exception when check_violation then null;
  end;

  perform set_config('app.actor_subject', 'system:auth', true);
  select identity.submit_organization_application('ehr', 'clinic',
    'RC1234567', 'Migrate Administrator', 'Migrate.Admin@Example.Invalid')
    into changed_registry_application;
  perform set_config('app.actor_subject', 'staff:organization-onboarding-admin', true);
  perform identity.admin_record_organization_cac_result(
    changed_registry_application, 1, 'verified', 'qoreid-test-0005', null,
    'RC1234567', 'Verified Migrate Legal Limited', 'Private Limited Company',
    '2014-05-26', 'Changed Address, Lagos', 'active');
  begin
    perform identity.admin_approve_organization_application(
      changed_registry_application, 2,
      current_setting('test.onboarding_organization_id')::uuid,
      current_setting('test.onboarding_facility_id')::uuid,
      'Synthetic changed registry identity');
    raise exception 'Changed registry identity silently reused an organization';
  exception when check_violation then null;
  end;

  perform set_config('app.actor_subject', 'system:auth', true);
  select identity.submit_organization_application('ehr', 'clinic',
    'RC7654321', 'Onboarding Admin', 'onboarding-admin@example.invalid')
    into conflicting_application;
  perform set_config('app.actor_subject', 'staff:organization-onboarding-admin', true);
  perform identity.admin_record_organization_cac_result(
    conflicting_application, 1, 'verified', 'qoreid-test-0004', null,
    'RC7654321', 'Other Legal Company Limited', 'Private Limited Company',
    '2016-06-09', '19 Example Road, Abuja', 'active');
  begin
    perform identity.admin_approve_organization_application(
      conflicting_application, 2, 'c4610000-0000-4000-8000-000000000001',
      'c4620000-0000-4000-8000-000000000001', 'Synthetic mismatched legal identity');
    raise exception 'A CAC for one legal entity was bound to another organization';
  exception when check_violation then null;
  end;

end $$;
reset role;

do $$
begin
  if (select count(*) from identity.organization_products where product_code in ('migrate', 'pharmacy')
      and source_application_id in (select id from identity.organization_applications
        where cac_registration_number = 'RC1234567')) <> 2 then
    raise exception 'Migrate enrollment was not bound to the governed organization';
  end if;
  if (select count(*) from auth.accounts where subject like 'org-onboarding:%'
      and status = 'active') <> 1 then
    raise exception 'First administrator could not complete secure credential setup';
  end if;
  if exists (select 1 from audit.events where details::text like '%RC1234567%') then
    raise exception 'Raw CAC leaked into semantic audit details';
  end if;
end $$;

select set_config('app.actor_subject', account.subject, true),
  set_config('app.facility_id', membership.facility_id::text, true),
  set_config('app.membership_id', membership.id::text, true)
from auth.accounts account
join identity.staff_facility_memberships membership on membership.account_id = account.id
where account.id = current_setting('test.onboarding_first_admin_id')::uuid;
select set_config('app.purpose_of_use', 'healthcare-operations', true);
set local role hid_identity_api_runtime;
do $$
begin
  if not identity.current_organization_cac_binding_matches(
    'pharmacy', 'RC1234567', 'Verified Migrate Legal Limited',
    'Private Limited Company', '2014-05-26', '10 Test Avenue, Lagos', 'active') then
    raise exception 'Approved product CAC binding was not recognized';
  end if;
  if to_regprocedure('identity.current_organization_cac_binding_matches(text,text,text)') is not null then
    raise exception 'Name-only CAC evidence command remains executable';
  end if;
  if identity.current_organization_cac_binding_matches(
    'pharmacy', 'RC9999999', 'Verified Migrate Legal Limited',
    'Private Limited Company', '2014-05-26', '10 Test Avenue, Lagos', 'active')
     or identity.current_organization_cac_binding_matches(
       'pharmacy', 'RC1234567', 'Unrelated Company Limited',
       'Private Limited Company', '2014-05-26', '10 Test Avenue, Lagos', 'active')
     or identity.current_organization_cac_binding_matches(
       'laboratory', 'RC1234567', 'Verified Migrate Legal Limited',
       'Private Limited Company', '2014-05-26', '10 Test Avenue, Lagos', 'active') then
    raise exception 'Unbound CAC number, name, or product was accepted';
  end if;
  if identity.current_organization_cac_binding_matches(
       'pharmacy', 'RC1234567', 'Verified Migrate Legal Limited',
       'Different Entity Type', '2014-05-26', '10 Test Avenue, Lagos', 'active')
     or identity.current_organization_cac_binding_matches(
       'pharmacy', 'RC1234567', 'Verified Migrate Legal Limited',
       'Private Limited Company', '2014-05-27', '10 Test Avenue, Lagos', 'active')
     or identity.current_organization_cac_binding_matches(
       'pharmacy', 'RC1234567', 'Verified Migrate Legal Limited',
       'Private Limited Company', '2014-05-26', 'Changed Address, Lagos', 'active')
     or identity.current_organization_cac_binding_matches(
       'pharmacy', 'RC1234567', 'Verified Migrate Legal Limited',
       'Private Limited Company', '2014-05-26', '10 Test Avenue, Lagos', 'inactive') then
    raise exception 'Changed registry identity was accepted as existing CAC evidence';
  end if;
end $$;
reset role;

-- A pre-0052 name-only registration must fail closed even if its legal name
-- still matches a fresh provider response.
update identity.organization_cac_registrations
   set verified_organization_name = null, verified_entity_type = null,
       verified_registration_date = null, verified_address = null,
       verified_registry_status = null
 where cac_registration_number = 'RC1234567';
set local role hid_identity_api_runtime;
do $$
begin
  if identity.current_organization_cac_binding_matches(
    'pharmacy', 'RC1234567', 'Verified Migrate Legal Limited',
    'Private Limited Company', '2014-05-26', '10 Test Avenue, Lagos', 'active') then
    raise exception 'Legacy incomplete binding became verified CAC evidence';
  end if;
end $$;
reset role;

rollback;
