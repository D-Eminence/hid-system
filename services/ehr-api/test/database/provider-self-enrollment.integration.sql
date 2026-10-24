\set ON_ERROR_STOP on
-- Facility self sign-up (0086; main 0061-0062 with db49a0d and 46a173f,
-- main's organization-onboarding suite :4-27, :30-79 and :671-797; owner
-- decision D14). Rollback-only. Every self-service command runs as the exact
-- Identity API runtime role in the accountless system context Identity uses.
--
--   1. only the self-service-aware review check remains; a self-service
--      approval without a reviewer is admitted and a governed (admin_review)
--      approval without one is refused by that check;
--   2. both Identity runtimes may execute the six public commands and the
--      quota command; nobody may execute the owner-only activation or the
--      lapse helper; the self-service commands take the governed path's
--      advisory-lock keys (A11);
--   3. with provider_self_service_enabled off, as 0086 seeds it, submit and
--      activation raise 55000 PLATFORM_CONTROL_DISABLED:provider_self_service_enabled
--      and write nothing;
--   4. once a platform administrator opens it through the audited command,
--      submit, read, verified CAC evidence, the email code and activation
--      create the organization, verified facility, CAC binding, product,
--      active account (email_verified_at and password_changed_at set, A10),
--      verified org_admin staff, membership and role, and the activation
--      returns the login email; a consumed session cannot activate again and
--      the registered CAC cannot be submitted again;
--   5. main's #81 answers: another email for an open CAC needs manual
--      resolution, and an administrator email that already has an account is
--      refused with the exact message Identity maps;
--   6. closing the control again refuses a verified session's activation and
--      writes nothing.
--
-- The control functions are SECURITY DEFINER and platform.control_settings
-- forces row-level security, so a system context reads the control only
-- through an owner that bypasses row-level security, as production's control
-- reads do. Under the rehearsal's NOBYPASSRLS synthetic owner the gate stays
-- closed (55000 PLATFORM_CONTROL_UNAVAILABLE, proved in
-- provider-self-service-control.integration.sql); this suite tests what lies
-- behind the gate, so in that case it lifts FORCE on that one table for its
-- own rolled-back transaction.
begin;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

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

-- 1. db49a0d: the 0046 reviewer check is replaced, so only the self-service
-- aware check remains. (The column test excludes 0086's
-- self_service_reviewed_by_account_id, whose name contains the reviewer column's.)
do $$
declare review_checks text[]; violated_constraint text;
begin
  select array_agg(constraint_row.conname order by constraint_row.conname)
    into review_checks
    from pg_constraint constraint_row
   where constraint_row.conrelid = 'identity.organization_applications'::regclass
     and constraint_row.contype = 'c'
     and pg_get_constraintdef(constraint_row.oid) ~ '(^|[^_])reviewed_by_account_id';
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

  -- A closed application without a review reason is refused (0086's
  -- precondition refuses to run while one exists).
  begin
    insert into identity.organization_applications (
      product_code, organization_name, organization_type, cac_registration_number,
      administrator_name, administrator_email, status, reviewed_by_account_id, reviewed_at, approval_mode
    ) values (
      'ehr', 'Reasonless Rejection Clinic', 'clinic', 'RC9900062003',
      'Reasonless Admin', 'reasonless-0062@example.invalid', 'rejected',
      'c4600000-0000-4000-8000-000000000001', now(), 'admin_review'
    );
    raise exception 'A rejection without a review reason was admitted';
  exception when check_violation then
    get stacked diagnostics violated_constraint = constraint_name;
    if violated_constraint <> 'organization_applications_review_check_self_service' then
      raise exception 'Unexpected constraint rejected the reasonless rejection: %', violated_constraint;
    end if;
  end;

  if (select column_default from information_schema.columns
       where table_schema = 'identity' and table_name = 'organization_applications'
         and column_name = 'approval_mode') is distinct from '''admin_review''::text' then
    raise exception 'Governed applications no longer default to admin_review';
  end if;

  delete from identity.organization_applications
   where cac_registration_number = 'RC9900062001';
end $$;

-- 2. Grants and lock keys.
do $$
declare
  runtime_role text;
  signature text;
begin
  foreach runtime_role in array array['hid_identity_runtime', 'hid_identity_api_runtime', 'hid_schema_test_runtime'] loop
    foreach signature in array array[
      'identity.submit_self_service_organization_application(text,text,text,text,text,char)',
      'identity.public_get_organization_application(text,text,text)',
      'identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text)',
      'identity.begin_self_service_provider_enrollment(text,text,text,uuid,char,text,text)',
      'identity.prepare_self_service_provider_activation(char)',
      'identity.activate_self_service_provider_enrollment(char,text)',
      'platform.consume_self_service_cac_quota(uuid,char,integer)'
    ] loop
      if not has_function_privilege(runtime_role, signature, 'EXECUTE') then
        raise exception 'Provider self-enrollment command % is not executable by %', signature, runtime_role;
      end if;
    end loop;
  end loop;
  foreach runtime_role in array array['hid_identity_runtime', 'hid_identity_api_runtime', 'hid_schema_test_runtime',
      'hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_api_runtime', 'hid_lab_api_runtime',
      'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_ocr_api_runtime'] loop
    foreach signature in array array[
      'identity.activate_self_service_organization_application(char,text)',
      'identity.lapse_stale_self_service_organization_application(text,text,text)'
    ] loop
      if has_function_privilege(runtime_role, signature, 'EXECUTE') then
        raise exception 'The owner-only command % is executable by %', signature, runtime_role;
      end if;
    end loop;
  end loop;
  foreach runtime_role in array array['hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_api_runtime',
      'hid_lab_api_runtime', 'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_ocr_api_runtime'] loop
    foreach signature in array array[
      'identity.submit_self_service_organization_application(text,text,text,text,text,char)',
      'identity.public_get_organization_application(text,text,text)',
      'identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text)',
      'identity.begin_self_service_provider_enrollment(text,text,text,uuid,char,text,text)',
      'identity.prepare_self_service_provider_activation(char)',
      'identity.activate_self_service_provider_enrollment(char,text)'
    ] loop
      if has_function_privilege(runtime_role, signature, 'EXECUTE') then
        raise exception 'A non-Identity runtime % can execute %', runtime_role, signature;
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in (
                'identity.submit_self_service_organization_application(text,text,text,text,text,char)'::regprocedure,
                'identity.public_get_organization_application(text,text,text)'::regprocedure,
                'identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text)'::regprocedure,
                'identity.activate_self_service_organization_application(char,text)'::regprocedure,
                'identity.lapse_stale_self_service_organization_application(text,text,text)'::regprocedure,
                'identity.begin_self_service_provider_enrollment(text,text,text,uuid,char,text,text)'::regprocedure,
                'identity.prepare_self_service_provider_activation(char)'::regprocedure,
                'identity.activate_self_service_provider_enrollment(char,text)'::regprocedure,
                'platform.consume_self_service_cac_quota(uuid,char,integer)'::regprocedure)
                and acl.grantee = 0) then
    raise exception 'A provider self-enrollment command is executable by PUBLIC';
  end if;
  -- A11: the governed path's lock keys, so both paths serialize on one CAC.
  if (select prosrc from pg_proc where oid = 'identity.submit_self_service_organization_application(text,text,text,text,text,char)'::regprocedure)
       not like '%''org-application:'' || normalized_cac || '':'' || requested_product%'
     or (select prosrc from pg_proc where oid = 'identity.activate_self_service_organization_application(char,text)'::regprocedure)
       not like '%''org-cac:'' || application.cac_registration_number%'
     or exists (select 1 from pg_proc where pronamespace = 'identity'::regnamespace and prosrc like '%self-service-org-%') then
    raise exception 'The self-service commands do not take the governed advisory-lock keys';
  end if;
end $$;

-- 3. 0086 seeds the control off: nothing can be submitted or activated.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'provider-self-enrollment-closed-0001', true);
do $$
declare message text;
begin
  begin
    perform identity.submit_self_service_organization_application('ehr', 'clinic',
      'RC9900062101', 'Runtime Provider Admin', 'runtime.provider@example.invalid');
    raise exception 'A closed self sign-up accepted a submission';
  exception when object_not_in_prerequisite_state then
    get stacked diagnostics message = message_text;
    if message <> 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled' then raise; end if;
  end;
  begin
    perform identity.activate_self_service_provider_enrollment(repeat('a', 64),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    raise exception 'A closed self sign-up reached activation';
  exception when object_not_in_prerequisite_state then
    get stacked diagnostics message = message_text;
    if message <> 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.organization_applications where cac_registration_number = 'RC9900062101')
     or exists (select 1 from audit.events where correlation_id = 'provider-self-enrollment-closed-0001') then
    raise exception 'A closed self sign-up wrote an application or audit row';
  end if;
end $$;

-- 4. A platform administrator opens self sign-up with the audited command.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:organization-onboarding-admin', true),
  set_config('app.correlation_id', 'provider-self-enrollment-open-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare current_version bigint; result record;
begin
  select control.row_version into current_version from platform.admin_list_controls() control
   where control.control_key = 'provider_self_service_enabled';
  select * into result from platform.admin_set_control('provider_self_service_enabled', true,
    current_version, 'Provider self-enrollment suite opens facility sign-up');
  if not result.enabled or result.replayed then
    raise exception 'The control was not opened: %', row_to_json(result);
  end if;
end $$;

select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'provider-self-enrollment-runtime-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  application_id uuid; current_application record; recorded record; activated record;
  recipient text; verified boolean;
  challenge_id uuid := 'c4690000-0000-4000-8000-000000000001';
  code_hmac char(64) := encode(sha256('provider-runtime-otp'::bytea), 'hex');
  session_hmac char(64) := encode(sha256('provider-runtime-session'::bytea), 'hex');
begin
  application_id := identity.submit_self_service_organization_application('ehr', 'clinic',
    'RC9900062101', 'Runtime Provider Admin', 'runtime.provider@example.invalid');
  -- A resubmission by the same administrator resumes the same application.
  if identity.submit_self_service_organization_application('ehr', 'clinic',
       ' rc9900062101 ', 'Runtime Provider Admin', 'Runtime.Provider@example.invalid ') is distinct from application_id then
    raise exception 'A resubmission did not resume the open application';
  end if;
  select * into current_application from identity.public_get_organization_application(
    'RC9900062101', 'runtime.provider@example.invalid', 'ehr');
  if current_application.application_id is distinct from application_id
     or current_application.application_status <> 'pending_verification' then
    raise exception 'Runtime role could not read its submitted application: %', current_application;
  end if;
  select * into recorded from identity.public_record_organization_cac_result(application_id,
    current_application.row_version, 'verified', '9900062101', 'RC9900062101',
    'Runtime Provider Clinic Ltd', 'Private Company Limited by Shares', '2019-04-01',
    '1 Synthetic Registry Road, Lagos', 'ACTIVE');
  if recorded.application_status <> 'ready_for_review' then
    raise exception 'Verified CAC evidence was not recorded: %', recorded;
  end if;

  recipient := identity.begin_organization_profile_completion('RC9900062101',
    'runtime.provider@example.invalid', 'ehr', challenge_id, code_hmac);
  if recipient is distinct from 'runtime.provider@example.invalid' then
    raise exception 'Email challenge was not issued to the stored administrator';
  end if;
  verified := identity.verify_organization_profile_completion_challenge(challenge_id,
    encode(sha256('wrong-provider-runtime-otp'::bytea), 'hex'), session_hmac);
  if verified then raise exception 'A wrong OTP verified the provider email'; end if;
  verified := identity.verify_organization_profile_completion_challenge(challenge_id, code_hmac, session_hmac);
  if not verified then raise exception 'The correct OTP did not verify the provider email'; end if;
  -- A9 and R1: Identity checks the session, and charges the attempt, before
  -- argon2 with this command, in its own committed transaction.
  if identity.prepare_self_service_provider_activation(session_hmac) is distinct from 'ready' then
    raise exception 'The verified completion session is not ready before activation';
  end if;

  begin
    perform identity.activate_self_service_organization_application(session_hmac,
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    raise exception 'The runtime role called the owner-only activation command';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.lapse_stale_self_service_organization_application('RC9900062101', 'ehr', null);
    raise exception 'The runtime role called the owner-only lapse helper';
  exception when insufficient_privilege then null;
  end;

  select * into activated from identity.activate_self_service_provider_enrollment(session_hmac,
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  if activated.account_email is distinct from 'runtime.provider@example.invalid'
     or activated.organization_id is null or activated.facility_id is null or activated.account_id is null
     or activated.hid_subject is distinct from 'org-onboarding:' || activated.account_id::text then
    raise exception 'Activation did not return the login email in the same transaction: %', activated;
  end if;
  perform set_config('hid.test.provider_account', activated.account_id::text, true);
  perform set_config('hid.test.provider_organization', activated.organization_id::text, true);
  perform set_config('hid.test.provider_facility', activated.facility_id::text, true);
  perform set_config('hid.test.provider_application', application_id::text, true);

  begin
    perform identity.activate_self_service_provider_enrollment(session_hmac,
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    raise exception 'A consumed enrollment session activated a second time';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from identity.current_organization_profile_completion(session_hmac))
     or identity.prepare_self_service_provider_activation(session_hmac) <> 'session_invalid' then
    raise exception 'The consumed session still reads as a live completion';
  end if;
  begin
    perform identity.submit_self_service_organization_application('ehr', 'clinic',
      'RC9900062101', 'Runtime Provider Admin', 'runtime.provider@example.invalid');
    raise exception 'An already registered CAC was accepted for a new enrollment';
  exception when check_violation then
    if sqlerrm <> 'This CAC is already registered with HID' then raise; end if;
  end;
  -- Evidence is recorded only on an open self-service application: not on the
  -- approved one, and not on a governed (admin_review) application.
  begin
    perform identity.public_record_organization_cac_result(application_id, 1,
      'verified', '9900062101', 'RC9900062101', 'Runtime Provider Clinic Ltd',
      'Private Company Limited by Shares', '2019-04-01', '1 Synthetic Registry Road, Lagos', 'active');
    raise exception 'CAC evidence was recorded on an approved application';
  exception when no_data_found then null;
  end;
  application_id := identity.submit_organization_application('pharmacy', 'pharmacy', 'RC9900062109',
    'Governed Applicant', 'governed.applicant@example.invalid');
  begin
    perform identity.public_record_organization_cac_result(application_id, 1,
      'verified', '9900062109', 'RC9900062109', 'Governed Pharmacy Ltd',
      'Private Company Limited by Shares', '2019-04-01', '9 Synthetic Registry Road, Lagos', 'active');
    raise exception 'CAC evidence was recorded on a governed application through the self-service command';
  exception when no_data_found then null;
  end;
end $$;
reset role;

do $$
declare
  provider_account uuid := current_setting('hid.test.provider_account')::uuid;
  provider_organization uuid := current_setting('hid.test.provider_organization')::uuid;
  provider_facility uuid := current_setting('hid.test.provider_facility')::uuid;
  provider_application uuid := current_setting('hid.test.provider_application')::uuid;
begin
  if not exists (select 1 from identity.organizations o where o.id = provider_organization
                   and o.name = 'Runtime Provider Clinic Ltd' and o.active)
     or not exists (select 1 from identity.facilities f where f.id = provider_facility
                      and f.organization_id = provider_organization and f.lifecycle_status = 'verified')
     or not exists (select 1 from identity.organization_cac_registrations r
                      where r.cac_registration_number = 'RC9900062101' and r.organization_id = provider_organization
                        and r.verified_organization_name = 'Runtime Provider Clinic Ltd'
                        and r.organization_name_source = 'qoreid')
     or not exists (select 1 from identity.organization_products p
                      where p.organization_id = provider_organization and p.product_code = 'ehr' and p.facility_id = provider_facility)
     or not exists (select 1 from auth.accounts a where a.id = provider_account
                      and a.email = 'runtime.provider@example.invalid' and a.status = 'active'
                      and a.password_algorithm = 'argon2id'
                      and a.email_verified_at is not null and a.password_changed_at is not null)
     or not exists (select 1 from identity.staff s
                      join identity.staff_facility_memberships m on m.staff_id = s.id
                     where s.account_id = provider_account and s.default_role = 'org_admin'
                       and s.verification_status = 'verified'
                       and m.facility_id = provider_facility and m.membership_role = 'org_admin' and m.active)
     or not exists (select 1 from auth.account_roles r where r.account_id = provider_account
                      and r.role_code = 'org_admin' and r.facility_id = provider_facility and r.revoked_at is null)
     or not exists (select 1 from identity.organization_applications a
                      where a.id = provider_application and a.status = 'approved' and a.approval_mode = 'self_service'
                        and a.first_admin_account_id = provider_account and a.reviewed_by_account_id is null
                        and a.reviewed_at is not null
                        and a.review_reason = 'Automated CAC and administrator-email verification'
                        and a.self_service_reviewed_at is null)
     or not exists (select 1 from audit.events e where e.action = 'identity.organization.self-service.activate'
                      and e.organization_id = provider_organization and e.actor_type = 'system')
     or (select array_agg(e.action order by e.sequence_id) from audit.events e
          where e.correlation_id = 'provider-self-enrollment-runtime-0001')
        is distinct from array['identity.organization.self-service.submit',
          'identity.organization.self-service.cac-verify', 'identity.organization.self-service.activate',
          'identity.organization.application.submit'] then
    raise exception 'Runtime-role provider activation did not create the complete organization';
  end if;
  if (select application.approval_mode from identity.organization_applications application
        where application.cac_registration_number = 'RC9900062109') is distinct from 'admin_review' then
    raise exception 'A governed submission was not stored as admin_review';
  end if;
  -- The new administrator's staff context resolves (Identity's staff session).
  if not identity.has_active_membership('org-onboarding:' || provider_account::text,
      (select m.id from identity.staff_facility_memberships m where m.account_id = provider_account),
      provider_facility) then
    raise exception 'The activated administrator has no active membership';
  end if;
end $$;

-- 5. #81: another email for an open CAC needs manual resolution, and an
-- administrator email that already has an account is refused at activation.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'provider-self-enrollment-runtime-0002', true);
do $$
declare
  application_id uuid; current_application record;
  challenge_id uuid := 'c4690000-0000-4000-8000-000000000002';
  code_hmac char(64) := encode(sha256('provider-runtime-otp-2'::bytea), 'hex');
  session_hmac char(64) := encode(sha256('provider-runtime-session-2'::bytea), 'hex');
begin
  application_id := identity.submit_self_service_organization_application('laboratory', 'laboratory',
    'RC9900062102', 'Existing Account Admin', 'onboarding-admin@example.invalid');
  begin
    perform identity.submit_self_service_organization_application('laboratory', 'laboratory',
      'RC9900062102', 'Someone Else', 'someone.else@example.invalid');
    raise exception 'Another email took over an open self-service application';
  exception when check_violation then
    if sqlerrm <> 'This organization application requires manual resolution' then raise; end if;
  end;
  select * into current_application from identity.public_get_organization_application(
    'RC9900062102', 'onboarding-admin@example.invalid', 'laboratory');
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
    'verified', '9900062102', 'RC9900062102', 'Existing Account Laboratory Ltd',
    'Private Company Limited by Shares', '2018-02-01', '2 Synthetic Registry Road, Lagos', 'active');
  perform identity.begin_organization_profile_completion('RC9900062102',
    'onboarding-admin@example.invalid', 'laboratory', challenge_id, code_hmac);
  if not identity.verify_organization_profile_completion_challenge(challenge_id, code_hmac, session_hmac) then
    raise exception 'The second application email was not verified';
  end if;
  begin
    perform identity.activate_self_service_provider_enrollment(session_hmac,
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    raise exception 'An administrator email that already has an account was activated';
  exception when unique_violation then
    if sqlerrm <> 'Administrator email already belongs to an account' then raise; end if;
  end;
  perform set_config('hid.test.second_session', session_hmac, true);
  -- R1: Identity's pre-check answers it before any hash and ends the session.
  if identity.prepare_self_service_provider_activation(session_hmac) <> 'email_registered'
     or identity.prepare_self_service_provider_activation(session_hmac) <> 'session_invalid' then
    raise exception 'The activation pre-check did not refuse the registered email once and end the session';
  end if;
end $$;

-- 6. Closing the control again refuses activation of a verified session and
-- writes nothing.
select set_config('app.actor_subject', 'staff:organization-onboarding-admin', true),
  set_config('app.correlation_id', 'provider-self-enrollment-close-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare current_version bigint;
begin
  select control.row_version into current_version from platform.admin_list_controls() control
   where control.control_key = 'provider_self_service_enabled';
  perform platform.admin_set_control('provider_self_service_enabled', false,
    current_version, 'Provider self-enrollment suite closes facility sign-up');
end $$;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'provider-self-enrollment-closed-0002', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare message text;
begin
  begin
    perform identity.activate_self_service_provider_enrollment(current_setting('hid.test.second_session'),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    raise exception 'A closed self sign-up activated a verified session';
  exception when object_not_in_prerequisite_state then
    get stacked diagnostics message = message_text;
    if message <> 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if exists (select 1 from audit.events where correlation_id = 'provider-self-enrollment-closed-0002')
     or exists (select 1 from identity.organization_cac_registrations where cac_registration_number = 'RC9900062102')
     or (select count(*) from platform.control_events where control_key = 'provider_self_service_enabled'
           and actor_account_id = 'c4600000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'A closed activation wrote something, or the two control changes were not recorded';
  end if;
end $$;

rollback;
