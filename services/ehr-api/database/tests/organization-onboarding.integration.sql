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
  select identity.submit_organization_application('migrate', 'Synthetic Migrate Clinic', 'clinic',
    'RC1234567', 'Migrate Administrator', 'Migrate.Admin@Example.Invalid') into first_id;
  select identity.submit_organization_application('migrate', 'Synthetic Migrate Clinic', 'clinic',
    'RC1234567', 'Migrate Administrator', 'Migrate.Admin@Example.Invalid') into repeated_id;
  if first_id <> repeated_id then raise exception 'Public retry created a second organization application'; end if;
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
  select * into changed from identity.admin_record_organization_cac_result(
    application_id_value, 1, 'not_verified', null, 'not_verified');
  if changed.application_status <> 'pending_verification' or changed.row_version <> 2 then
    raise exception 'Nonverified CAC moved the application to review';
  end if;
  begin
    perform identity.admin_approve_organization_application(
      application_id_value, 2, null, null, 'Synthetic governed approval');
    raise exception 'Unverified CAC was approved';
  exception when check_violation then null;
  end;
  select * into changed from identity.admin_record_organization_cac_result(
    application_id_value, 2, 'verified', 'qoreid-test-0001', null);
  if changed.application_status <> 'ready_for_review' or changed.row_version <> 3 then
    raise exception 'Verified CAC did not move the application to review';
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
  second_approval record;
begin
  perform set_config('app.actor_subject', 'system:auth', true);
  select identity.submit_organization_application('pharmacy', 'Synthetic Migrate Clinic', 'clinic',
    'RC1234567', 'Migrate Administrator', 'Migrate.Admin@Example.Invalid')
    into second_application;
  perform set_config('app.actor_subject', 'staff:organization-onboarding-admin', true);
  perform identity.admin_record_organization_cac_result(
    second_application, 1, 'verified', 'qoreid-test-0002', null);
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
  select identity.submit_organization_application('laboratory', 'Synthetic Migrate Clinic', 'clinic',
    'RC1234567', 'Unrelated Applicant', 'unrelated@example.invalid')
    into rogue_application;
  perform set_config('app.actor_subject', 'staff:organization-onboarding-admin', true);
  perform identity.admin_record_organization_cac_result(
    rogue_application, 1, 'verified', 'qoreid-test-0003', null);
  begin
    perform identity.admin_approve_organization_application(
      rogue_application, 2, current_setting('test.onboarding_organization_id')::uuid, current_setting('test.onboarding_facility_id')::uuid,
      'Synthetic unproven administrator');
    raise exception 'Unrelated applicant captured an existing organization';
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

rollback;
