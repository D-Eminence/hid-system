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

-- 0062 regression: the generated-name reviewer check from 0046 and the named
-- check from 0061 are both replaced, so only the self-service-aware check remains.
do $$
declare review_checks text[]; violated_constraint text;
begin
  select array_agg(constraint_row.conname order by constraint_row.conname)
    into review_checks
    from pg_constraint constraint_row
   where constraint_row.conrelid = 'identity.organization_applications'::regclass
     and constraint_row.contype = 'c'
     and pg_get_constraintdef(constraint_row.oid) like '%reviewed_by_account_id%';
  if review_checks is distinct from array['organization_applications_review_check_self_service']::text[] then
    raise exception 'Unexpected organization application review checks: %', review_checks;
  end if;

  insert into identity.organization_applications (
    product_code, organization_name, organization_type, cac_registration_number,
    administrator_name, administrator_email, status, verification_result, verified_at,
    verified_organization_name, organization_id, facility_id, review_reason, reviewed_at, approval_mode
  ) values (
    'ehr', 'Self Service Constraint Clinic', 'clinic', 'RC9900062001',
    'Self Service Admin', 'self-service-0062@example.invalid', 'approved', 'verified', now(),
    'SELF SERVICE CONSTRAINT CLINIC LTD',
    'c4610000-0000-4000-8000-000000000001', 'c4620000-0000-4000-8000-000000000001',
    'CAC verified automatically', now(), 'self_service'
  );

  begin
    insert into identity.organization_applications (
      product_code, organization_name, organization_type, cac_registration_number,
      administrator_name, administrator_email, status, verification_result, verified_at,
      verified_organization_name, organization_id, facility_id, review_reason, reviewed_at, approval_mode
    ) values (
      'ehr', 'Admin Review Constraint Clinic', 'clinic', 'RC9900062002',
      'Admin Review Admin', 'admin-review-0062@example.invalid', 'approved', 'verified', now(),
      'ADMIN REVIEW CONSTRAINT CLINIC LTD',
      'c4610000-0000-4000-8000-000000000001', 'c4620000-0000-4000-8000-000000000001',
      'Approved without a reviewer', now(), 'admin_review'
    );
    raise exception 'Administrator-reviewed application was approved without a reviewer';
  exception when check_violation then
    get stacked diagnostics violated_constraint = constraint_name;
    if violated_constraint <> 'organization_applications_review_check_self_service' then
      raise exception 'Unexpected constraint rejected the unreviewed approval: %', violated_constraint;
    end if;
  end;

  delete from identity.organization_applications
   where cac_registration_number = 'RC9900062001';
end $$;

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
      application_id_value, 2, 'verified', '86411', null,
      null, null, null, null, null, null);
    raise exception 'Status-only CAC result was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      application_id_value, 2, 'verified', '86411', null,
      'RC9999999', 'Unrelated Company Limited', 'Private Limited Company',
      '2014-05-26', '10 Test Avenue, Lagos', 'active');
    raise exception 'Mismatched CAC registration number was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      application_id_value, 2, 'verified', '86411', null,
      'RC1234567', 'Verified Migrate Legal Limited', 'x',
      '2014-05-26', '10 Test Avenue, Lagos', 'active');
    raise exception 'CAC result with a malformed entity type was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      application_id_value, 2, 'verified', '86411', null,
      'RC1234567', 'Verified Migrate Legal Limited', 'Private Limited Company',
      '2014-05-26', '10 Test Avenue, Lagos', '');
    raise exception 'Empty CAC registry status was accepted';
  exception when invalid_parameter_value then null;
  end;
  select * into changed from identity.admin_record_organization_cac_result(
    application_id_value, 2, 'verified', '86411', null,
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

-- Sparse RC/BN provider checks succeed, retain the queried identifier, and
-- preserve the provider address. Applicant completion requires email proof.
set local role hid_identity_api_runtime;
do $$
declare
  rc_application uuid;
  bn_application uuid;
  it_application uuid;
  changed record;
begin
  perform set_config('app.actor_subject', 'system:auth', true);
  select identity.submit_organization_application('ehr', 'clinic',
    'RC1111111', 'Incomplete RC Applicant', 'incomplete-rc@example.invalid') into rc_application;
  select identity.submit_organization_application('laboratory', 'laboratory',
    'BN2222222', 'Incomplete BN Applicant', 'incomplete-bn@example.invalid') into bn_application;
  select identity.submit_organization_application('pharmacy', 'pharmacy',
    'IT3333333', 'Inactive IT Applicant', 'inactive-it@example.invalid') into it_application;
  perform set_config('app.actor_subject', 'staff:organization-onboarding-admin', true);
  begin
    perform identity.admin_record_organization_cac_result(
      rc_application, 1, 'verified', null, null,
      'RC1111111', null, null, null, '11 Synthetic Provider Road', null);
    raise exception 'Provider-verified incomplete result without reference was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      rc_application, 1, 'verified', 'not-a-numeric-id', null,
      'RC1111111', null, null, null, '11 Synthetic Provider Road', null);
    raise exception 'Provider-verified incomplete result with nonnumeric reference was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(
      rc_application, 1, 'verified', '86421', null,
      'BN1111111', null, null, null, '11 Synthetic Provider Road', null);
    raise exception 'Mismatched submitted registration was accepted';
  exception when invalid_parameter_value then null;
  end;
  select * into changed from identity.admin_record_organization_cac_result(
    rc_application, 1, 'verified', '86421', null,
    'RC1111111', null, null, null, '11 Synthetic Provider Road', null);
  if changed.application_status <> 'pending_verification' or changed.row_version <> 2 then
    raise exception 'Sparse verified RC profile moved into organization review';
  end if;
  select * into changed from identity.admin_record_organization_cac_result(
    bn_application, 1, 'verified', '86422', null,
    'BN2222222', null, null, null, '22 Synthetic Provider Road', null);
  if changed.application_status <> 'pending_verification' or changed.row_version <> 2 then
    raise exception 'Sparse verified BN profile moved into organization review';
  end if;
  select * into changed from identity.admin_record_organization_cac_result(
    it_application, 1, 'verified', '86423', null,
    'IT3333333', 'Synthetic Trustee', 'Incorporated Trustee', '2019-02-01',
    '33 Synthetic Provider Road', 'inactive');
  if changed.application_status <> 'pending_verification' or changed.row_version <> 2 then
    raise exception 'Verified inactive CAC lookup moved into organization review';
  end if;
  if not exists (select 1 from identity.admin_list_organization_applications('pending_verification') item
      where item.application_id = it_application and item.verification_result = 'verified'
        and item.profile_state = 'incomplete' and item.qoreid_registry_status = 'inactive'
        and item.verified_registry_status = 'inactive'
        and item.registry_status_source = 'qoreid') then
    raise exception 'Verified inactive registry status was not preserved as provider data';
  end if;
  if (select count(*) from identity.admin_list_organization_applications('pending_verification') item
      where item.application_id in (rc_application, bn_application)
        and item.verification_result = 'verified'
        and item.profile_state = 'incomplete'
        and item.verified_at is not null
        and item.organization_name is null
        and item.verified_organization_name is null
        and item.verified_entity_type is null
        and item.verified_registration_date is null
        and item.verified_address is not null
        and item.address_source = 'qoreid'
        and item.verified_registry_status is null) <> 2 then
    raise exception 'Admin list lost verified sparse provider field provenance';
  end if;
  begin
    perform identity.admin_approve_organization_application(
      rc_application, 2, null, null, 'Synthetic incomplete profile approval');
    raise exception 'Incomplete provider profile was approved';
  exception when check_violation then null;
  end;
  begin
    perform identity.admin_approve_organization_application(
      it_application, 2, null, null, 'Synthetic inactive registry approval');
    raise exception 'Inactive provider registry status was approved';
  exception when check_violation then null;
  end;
end $$;
reset role;

do $$
begin
  if (select count(*) from identity.organization_applications application
      where application.cac_registration_number in ('RC1111111', 'BN2222222')
        and application.status = 'pending_verification'
        and application.verification_result = 'verified'
        and application.profile_state = 'incomplete'
        and application.provider_verified_registration_number = application.cac_registration_number
        and application.provider_reference ~ '^[0-9]+$'
        and application.verified_at is not null
        and application.organization_name is null
        and application.verified_organization_name is null
        and application.verified_address = application.qoreid_address
        and application.address_source = 'qoreid') <> 2 then
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
  begin
    update identity.organization_applications
       set qoreid_address = null
     where cac_registration_number = 'RC1111111';
    raise exception 'Provider source label survived deletion of provider evidence';
  exception when check_violation then null;
  end;
end $$;

-- A code delivered to the recorded administrator email yields a short-lived
-- completion session. Only missing fields can be supplied by that applicant.
set local role hid_identity_api_runtime;
do $$
declare
  recipient text;
  changed record;
  approved record;
begin
  perform set_config('app.actor_subject', 'system:auth', true);
  select identity.begin_organization_profile_completion(
    'RC1111111', 'incomplete-rc@example.invalid', 'ehr',
    '10000000-0000-4000-8000-000000000011', repeat('a', 64)) into recipient;
  if recipient <> 'incomplete-rc@example.invalid' then
    raise exception 'Verified sparse application was not eligible for contact proof';
  end if;
  if identity.verify_organization_profile_completion_challenge(
    '10000000-0000-4000-8000-000000000011', repeat('b', 64), repeat('c', 64)) then
    raise exception 'Incorrect email code opened a completion session';
  end if;
  if not identity.verify_organization_profile_completion_challenge(
    '10000000-0000-4000-8000-000000000011', repeat('a', 64), repeat('c', 64)) then
    raise exception 'Correct email code did not open a completion session';
  end if;
  begin
    perform identity.complete_organization_profile(repeat('c', 64), 2,
      'Applicant Clinic Limited', 'Private Limited', '2018-06-12',
      'Applicant address must not replace QoreID address', 'active');
    raise exception 'Applicant replaced a QoreID address';
  exception when invalid_parameter_value then null;
  end;
  select * into changed from identity.complete_organization_profile(repeat('c', 64), 2,
    'Applicant Clinic Limited', 'Private Limited', '2018-06-12', null, 'active');
  if changed.application_status <> 'ready_for_review' or changed.profile_state <> 'complete'
     or changed.row_version <> 3 or changed.profile_address <> '11 Synthetic Provider Road'
     or changed.profile_address_source <> 'qoreid'
     or changed.profile_organization_name_source <> 'user_provided' then
    raise exception 'Applicant completion lost exact field sources or review readiness';
  end if;
  select identity.begin_organization_profile_completion(
    'IT3333333', 'inactive-it@example.invalid', 'pharmacy',
    '10000000-0000-4000-8000-000000000012', repeat('d', 64)) into recipient;
  if recipient <> 'inactive-it@example.invalid'
     or not identity.verify_organization_profile_completion_challenge(
       '10000000-0000-4000-8000-000000000012', repeat('d', 64), repeat('e', 64)) then
    raise exception 'Verified inactive lookup did not allow applicant access';
  end if;
  begin
    perform identity.complete_organization_profile(repeat('e', 64), 2,
      null, null, null, null, 'active');
    raise exception 'Applicant replaced a QoreID inactive registry status';
  exception when invalid_parameter_value then null;
  end;
  perform set_config('app.actor_subject', 'staff:organization-onboarding-admin', true);
  select item.application_id into approved
    from identity.admin_list_organization_applications('ready_for_review') item
    where item.cac_hint = 'RC*****11' and item.product_code = 'ehr';
  if approved.application_id is null then raise exception 'Completed RC application is not review-ready'; end if;
  select * into approved from identity.admin_approve_organization_application(
    approved.application_id, 3, null, null, 'Reviewed applicant-sourced fields and CAC lookup');
  if approved.organization_id is null or approved.facility_id is null then
    raise exception 'Reviewed completed organization did not activate';
  end if;
end $$;
reset role;

do $$
begin
  if not exists (select 1 from identity.organization_applications application
      join identity.organization_cac_registrations binding
        on binding.cac_registration_number = application.cac_registration_number
      where application.cac_registration_number = 'RC1111111'
        and application.status = 'approved'
        and application.verification_result = 'verified'
        and application.verification_failure_category is null
        and application.provider_reference = '86421'
        and application.organization_name = 'Applicant Clinic Limited'
        and application.qoreid_organization_name is null
        and application.organization_name_source = 'user_provided'
        and binding.organization_name_source = 'user_provided'
        and application.verified_entity_type = 'Private Limited'
        and application.entity_type_source = 'user_provided'
        and application.verified_registration_date = date '2018-06-12'
        and application.verified_address = '11 Synthetic Provider Road'
        and application.address_source = 'qoreid'
        and binding.address_source = 'qoreid'
        and application.verified_registry_status = 'active'
        and application.registry_status_source = 'user_provided') then
    raise exception 'Approved sparse CAC profile lost provider/applicant provenance';
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
    second_application, 1, 'verified', '86412', null,
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
    rogue_application, 1, 'verified', '86413', null,
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
    changed_registry_application, 1, 'verified', '86415', null,
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
    conflicting_application, 1, 'verified', '86414', null,
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

-- Closed pre-0052 approvals carried a legal name without a complete CAC
-- snapshot. Migration 0056 must not mislabel that historical name as QoreID
-- profile evidence or fail while retaining the old closed record.
update identity.organization_applications
   set provider_reference = 'legacy-lookup', profile_state = null,
       provider_verified_registration_number = null,
       qoreid_organization_name = null, qoreid_entity_type = null,
       qoreid_registration_date = null, qoreid_address = null,
       qoreid_registry_status = null,
       verified_entity_type = null, verified_registration_date = null,
       verified_address = null, verified_registry_status = null,
       organization_name_source = null, entity_type_source = null,
       registration_date_source = null, address_source = null,
       registry_status_source = null
 where cac_registration_number = 'RC1234567' and product_code = 'migrate'
   and status = 'approved';
do $$ begin
  if not exists (select 1 from identity.organization_applications application
      where application.cac_registration_number = 'RC1234567'
        and application.product_code = 'migrate' and application.status = 'approved'
        and application.profile_state is null and application.provider_reference = 'legacy-lookup'
        and application.verified_organization_name = 'Verified Migrate Legal Limited'
        and application.organization_name_source is null) then
    raise exception 'Historical closed CAC record was promoted or rejected by provenance guard';
  end if;
end $$;

rollback;
