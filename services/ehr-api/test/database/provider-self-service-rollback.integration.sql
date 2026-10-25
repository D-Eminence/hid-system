\set ON_ERROR_STOP on
-- Rollback compatibility of 0086 (facility self sign-up) with the previous
-- Identity (57a94db). Rollback-only. A backend rollback returns the previous
-- images and keeps the schema, so the previous Identity must keep working on
-- it. Each statement below is the previous Identity's own SQL text, run with
-- EXECUTE ... USING as the exact Identity API runtime role in the context its
-- transaction helpers set (withSystemTransaction, withPlatformTransaction,
-- and the security guard's context-free pool query):
--
--   services/identity-api/src/identity/organization-applications.service.ts
--     public submit, admin list, get, CAC record, approve and reject;
--   services/identity-api/src/integrations/integration-runtime.service.ts
--     consume_qoreid_quota ('application_cac') and prune_verification_quotas;
--   services/identity-api/src/identity/organization-profile-completion.service.ts
--     completion start, invalidate, verify, current and complete; its
--     completion start sends no code for a self-service application, with the
--     control on or off (review fix R17), so a rolled-back Identity cannot
--     bypass R5 or R6 either;
--   services/identity-api/src/identity/qoreid-verification.service.ts
--     the existing-organization CAC binding match, here for an administrator
--     who signed up through 0086 before the rollback, and its quota charge
--     (consume_qoreid_quota 'existing_cac'): before support's review the
--     administrator holds only the restricted role (P4b), which lacks
--     organization.manage, so both are refused with 42501 (the previous
--     Identity's 403 PERMISSION_DENIED); after the review both work; R7's
--     own refusal (QOREID_QUOTA_SELF_SERVICE_REVIEW_REQUIRED) is shown on a
--     reviewed administrator whose review columns owner SQL clears;
--   services/identity-api/src/auth/current-staff-context.service.ts
--     the staff context, for a governed administrator (unchanged) and for the
--     self-signed-up administrator before review (the restricted role's six
--     permissions) and after it (org_admin's), resolved as before;
--   services/identity-api/src/admin/admin.service.ts and auth/security.guard.ts
--     the platform control list, change and reads;
--   services/ehr-api/src/ehr/lab-requests/lab-requests.service.ts (P4c,
--     section 8 below): a lab request's create, lock and update under the
--     new route-mirror triggers;
--   services/lab-api/src/lab/lab-work-items.service.ts and
--   services/pharmacy-api/src/pharmacy/pharmacy.service.ts (section 8): the
--     same-facility acceptance, the work list and the per-item read, as the
--     exact Lab and Pharmacy API runtimes, on the work lists' new strict
--     policies and the new order_route_id column.
--
-- What it shows: governed applications default to admin_review; governed
-- approvals and rejections name a reviewer and a reason, so the replaced
-- review check admits them; the replaced governed submit and prune keep their
-- answers; the control list carries the four new keys (P4b's two off, P4c's
-- orders off and route access on) and the six old keys answer as before. The
-- previous Identity calls no 0086 command; the previous Lab and Pharmacy
-- call none either, and keep accepting, listing and reading same-facility
-- work.
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
values ('c8900000-0000-4000-8000-000000000001', 'staff:rollback-admin',
  'rollback-admin@example.invalid', 'Rollback Admin', 'active');
insert into identity.organizations (id, name, slug)
values ('c8910000-0000-4000-8000-000000000001', 'Rollback Review Office', 'rollback-review-office');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
values ('c8920000-0000-4000-8000-000000000001', 'c8910000-0000-4000-8000-000000000001',
  'Rollback Review Office', 'ROLLBACK-REVIEW', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
values ('c8930000-0000-4000-8000-000000000001', 'c8900000-0000-4000-8000-000000000001',
  'Rollback Admin', 'rollback-admin@example.invalid', 'verified', 'admin');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('c8940000-0000-4000-8000-000000000001', 'c8930000-0000-4000-8000-000000000001',
  'c8900000-0000-4000-8000-000000000001', 'c8910000-0000-4000-8000-000000000001',
  'c8920000-0000-4000-8000-000000000001', 'admin', 'admin', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
values ('c8950000-0000-4000-8000-000000000001', 'c8900000-0000-4000-8000-000000000001',
  'platform_super_admin', 'platform', 'Rollback suite reviewer');

-- 1. Public governed intake (withSystemTransaction).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'rollback-intake-0001', true);
do $$
declare
  cac text;
  product text;
begin
  for cac, product in select * from (values ('RC9900067001', 'ehr'), ('RC9900067002', 'laboratory'),
      ('RC9900067003', 'pharmacy')) as rows(cac, product) loop
    execute 'select platform.consume_public_application_quota($1)' using repeat('7', 64);
    execute 'select identity.submit_organization_application($1,$2,$3,$4,$5)'
      using product, 'clinic', cac, 'Rollback Applicant', lower(cac) || '@rollback.invalid';
  end loop;
end $$;
reset role;
do $$ begin
  if (select count(*) from identity.organization_applications
       where cac_registration_number like 'RC99000670%' and approval_mode = 'admin_review'
         and self_service_reviewed_at is null and self_service_reviewed_by_account_id is null
         and self_service_review_note is null and status = 'pending_verification') <> 3 then
    raise exception 'The previous Identity''s governed submissions are not admin_review applications';
  end if;
end $$;

-- 2. Governed review (withPlatformTransaction with the reviewer's facility membership).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:rollback-admin', true),
  set_config('app.facility_id', 'c8920000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'rollback-review-0001', true),
  set_config('app.membership_id', 'c8940000-0000-4000-8000-000000000001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare
  listed record;
  approved_id uuid; rejected_id uuid; completed_id uuid;
  found_row record;
  version bigint;
  result record;
begin
  for listed in execute 'select * from identity.admin_list_organization_applications($1)' using null::text loop
    case listed.product_code
      when 'ehr' then approved_id := listed.application_id;
      when 'laboratory' then rejected_id := listed.application_id;
      when 'pharmacy' then completed_id := listed.application_id;
      else null;
    end case;
  end loop;
  if approved_id is null or rejected_id is null or completed_id is null then
    raise exception 'The governed list did not return the three applications';
  end if;
  execute 'select * from identity.admin_list_organization_applications($1)' using 'pending_verification'::text into found_row;
  execute 'select * from identity.admin_get_organization_application($1)' using approved_id into found_row;
  if found_row.cac_registration_number <> 'RC9900067001' then
    raise exception 'admin_get_organization_application returned %', row_to_json(found_row);
  end if;
  version := found_row.row_version;

  execute 'select platform.consume_qoreid_quota($1,$2,$3,$4,$5)'
    using 'application_cac'::text, approved_id, null::uuid, null::char(64), null::char(64);
  execute 'select * from identity.admin_record_organization_cac_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)'
    using approved_id, version, 'verified'::text, '7001'::text, null::text, 'RC9900067001'::text,
      'Rollback Clinic Ltd'::text, 'Private Company Limited by Shares'::text, '2016-01-01'::text,
      '7 Rollback Road, Lagos'::text, 'active'::text
    into result;
  if result.application_status <> 'ready_for_review' then
    raise exception 'The governed CAC result was not recorded: %', row_to_json(result);
  end if;
  execute 'select * from identity.admin_approve_organization_application($1,$2,$3,$4,$5)'
    using approved_id, result.row_version, null::uuid, null::uuid, 'Approved by the previous Identity'::text
    into result;
  if result.organization_id is null or result.organization_reused then
    raise exception 'The governed approval did not create the organization: %', row_to_json(result);
  end if;

  execute 'select * from identity.admin_get_organization_application($1)' using rejected_id into found_row;
  execute 'select * from identity.admin_reject_organization_application($1,$2,$3)'
    using rejected_id, found_row.row_version, 'Rejected by the previous Identity'::text into result;
  if result.application_status <> 'rejected' then
    raise exception 'The governed rejection failed: %', row_to_json(result);
  end if;

  -- A verified CAC with a sparse registry record waits for the applicant.
  execute 'select * from identity.admin_get_organization_application($1)' using completed_id into found_row;
  execute 'select * from identity.admin_record_organization_cac_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)'
    using completed_id, found_row.row_version, 'verified'::text, '7003'::text, null::text, 'RC9900067003'::text,
      'Rollback Pharmacy Ltd'::text, null::text, null::text, null::text, null::text
    into result;
  if result.application_status <> 'pending_verification' then
    raise exception 'The sparse CAC result was not left for completion: %', row_to_json(result);
  end if;
  perform set_config('hid.test.rollback_completed', completed_id::text, true);
end $$;

-- 3. The applicant completes the sparse profile (withSystemTransaction).
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'rollback-completion-0001', true),
  set_config('app.membership_id', '', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  recipient text; verified boolean; current_profile record; completed record;
  session_hmac char(64) := encode(sha256('rollback-session'::bytea), 'hex');
begin
  execute 'select platform.consume_public_application_quota($1)' using repeat('7', 64);
  execute 'select identity.begin_organization_profile_completion($1,$2,$3,$4,$5) as recipient_email'
    using 'RC9900067003'::text, 'rc9900067003@rollback.invalid'::text, 'pharmacy'::text,
      'c8990000-0000-4000-8000-000000000001'::uuid, encode(sha256('rollback-otp'::bytea), 'hex')
    into recipient;
  if recipient is distinct from 'rc9900067003@rollback.invalid' then
    raise exception 'The completion code was not issued: %', recipient;
  end if;
  execute 'select identity.invalidate_organization_profile_completion_challenge($1)'
    using 'c8990000-0000-4000-8000-0000000000ff'::uuid;
  execute 'select identity.verify_organization_profile_completion_challenge($1,$2,$3) as verified'
    using 'c8990000-0000-4000-8000-000000000001'::uuid, encode(sha256('rollback-otp'::bytea), 'hex'), session_hmac
    into verified;
  if not verified then raise exception 'The completion code did not verify'; end if;
  execute 'select * from identity.current_organization_profile_completion($1)' using session_hmac into current_profile;
  execute 'select * from identity.complete_organization_profile($1,$2,$3,$4,$5,$6,$7)'
    using session_hmac, current_profile.row_version, null::text, 'Private Company Limited by Shares'::text,
      '2015-06-01'::text, '3 Rollback Road, Lagos'::text, 'active'::text
    into completed;
  if completed.application_status <> 'ready_for_review' or completed.profile_state <> 'complete' then
    raise exception 'The applicant could not complete the profile: %', row_to_json(completed);
  end if;
end $$;

-- 4. The completed application is approved (withPlatformTransaction).
select set_config('app.actor_subject', 'staff:rollback-admin', true),
  set_config('app.facility_id', 'c8920000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'rollback-review-0002', true),
  set_config('app.membership_id', 'c8940000-0000-4000-8000-000000000001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare found_row record; result record;
begin
  execute 'select * from identity.admin_get_organization_application($1)'
    using current_setting('hid.test.rollback_completed')::uuid into found_row;
  execute 'select * from identity.admin_approve_organization_application($1,$2,$3,$4,$5)'
    using found_row.application_id, found_row.row_version, null::uuid, null::uuid,
      'Approved after applicant completion'::text
    into result;
  if result.organization_id is null then
    raise exception 'The completed application was not approved';
  end if;
end $$;
reset role;

do $$ begin
  if (select array_agg(status || ':' || approval_mode || ':' || (reviewed_by_account_id is not null)::text
                       order by cac_registration_number)
        from identity.organization_applications where cac_registration_number like 'RC99000670%')
     is distinct from array['approved:admin_review:true', 'rejected:admin_review:true', 'approved:admin_review:true'] then
    raise exception 'The previous Identity''s governed review did not close the applications';
  end if;
  if (select count(*) from audit.events where correlation_id like 'rollback-review-%'
       and action in ('identity.organization.application.cac-verify', 'identity.organization.application.approve',
         'identity.organization.application.reject')) <> 5 then
    raise exception 'The previous Identity''s governed review was not audited';
  end if;
end $$;

-- 5. A facility that signed itself up before the rollback keeps working with
-- the previous Identity: its administrator's staff membership resolves and the
-- existing-organization CAC binding match (qoreid-verification.service.ts)
-- recognises its own CAC. The sign-up itself runs the 0086 commands, as the
-- new Identity did.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:rollback-admin', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true),
  set_config('app.correlation_id', 'rollback-signup-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Rollback suite opens facility sign-up');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare application_id uuid; current_application record; activated record;
begin
  application_id := identity.submit_self_service_organization_application('ehr', 'hospital',
    'RC9900067004', 'Self Signed Admin', 'self.signed@rollback.invalid');
  select * into current_application from identity.public_get_organization_application(
    'RC9900067004', 'self.signed@rollback.invalid', 'ehr');
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
    'verified', '7004', 'RC9900067004', 'Self Signed Hospital Ltd',
    'Private Company Limited by Shares', '2014-04-04', '4 Rollback Road, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment('RC9900067004', 'self.signed@rollback.invalid', 'ehr',
    'c8990000-0000-4000-8000-000000000004', encode(sha256('rollback-otp-4'::bytea), 'hex'), 'Self Signed Admin',
    'hospital');
  perform identity.verify_organization_profile_completion_challenge('c8990000-0000-4000-8000-000000000004',
    encode(sha256('rollback-otp-4'::bytea), 'hex'), encode(sha256('rollback-session-4'::bytea), 'hex'));
  select * into activated from identity.activate_self_service_provider_enrollment(
    encode(sha256('rollback-session-4'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform set_config('hid.test.rollback_self_account', activated.account_id::text, true);
  perform set_config('hid.test.rollback_self_facility', activated.facility_id::text, true);
  perform set_config('hid.test.rollback_self_organization', activated.organization_id::text, true);
  -- An open, verified self-service application that the previous Identity's
  -- completion start must not send a code for (R17).
  application_id := identity.submit_self_service_organization_application('laboratory', 'laboratory',
    'RC9900067005', 'Open Self Signed Admin', 'open.self.signed@rollback.invalid');
  select * into current_application from identity.public_get_organization_application(
    'RC9900067005', 'open.self.signed@rollback.invalid', 'laboratory');
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
    'verified', '7005', 'RC9900067005', 'Open Self Signed Laboratory Ltd',
    'Private Company Limited by Shares', '2014-05-05', '5 Rollback Road, Lagos', 'active');
end $$;
create function pg_temp.previous_completion_start(challenge uuid) returns text language plpgsql as $f$
declare recipient text;
begin
  execute 'select platform.consume_public_application_quota($1)' using repeat('8', 64);
  execute 'select identity.begin_organization_profile_completion($1,$2,$3,$4,$5) as recipient_email'
    using 'RC9900067005'::text, 'open.self.signed@rollback.invalid'::text, 'laboratory'::text,
      challenge, encode(sha256('rollback-otp-5'::bytea), 'hex')
    into recipient;
  return recipient;
end $f$;
grant execute on function pg_temp.previous_completion_start(uuid) to hid_identity_api_runtime;
do $$ begin
  if pg_temp.previous_completion_start('c8990000-0000-4000-8000-000000000005') is not null then
    raise exception 'The previous Identity''s completion start sent a code for a self-service application';
  end if;
end $$;
select set_config('app.actor_subject', 'staff:rollback-admin', true),
  set_config('app.correlation_id', 'rollback-signup-0002', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Rollback suite closes facility sign-up');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.purpose_of_use', '', true);
do $$ begin
  if pg_temp.previous_completion_start('c8990000-0000-4000-8000-000000000006') is not null then
    raise exception 'With the control off, the previous Identity''s completion start sent a code for a self-service application';
  end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.organization_profile_completion_challenges challenge
              join identity.organization_applications application on application.id = challenge.application_id
             where application.cac_registration_number = 'RC9900067005') then
    raise exception 'The previous Identity''s completion start stored a challenge for a self-service application';
  end if;
end $$;
select set_config('hid.test.rollback_self_membership',
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.rollback_self_account')::uuid), true);
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.rollback_self_account'), true),
  set_config('app.facility_id', current_setting('hid.test.rollback_self_facility'), true),
  set_config('app.membership_id', current_setting('hid.test.rollback_self_membership'), true),
  set_config('app.correlation_id', 'rollback-binding-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
create function pg_temp.previous_staff_context(target_subject text) returns jsonb language plpgsql as $f$
declare answer jsonb;
begin
  -- The previous Identity's own query text (current-staff-context.service.ts).
  execute $q$select coalesce(jsonb_agg(to_jsonb(context)), '[]'::jsonb) from (
     select account.id::text as account_id,
              account.subject,
              account.email,
              account.display_name,
              membership.facility_id::text,
              membership.id::text as membership_id,
              membership.organization_id::text,
              facility.name as facility_name,
              facility.code as facility_code,
              array_remove(array[membership.membership_role, membership.app_role], null) as roles,
              coalesce(array_agg(distinct permission.code) filter (where permission.code is not null), array[]::text[]) as permissions,
              membership.is_primary
         from auth.accounts account
         join identity.staff_facility_memberships membership
           on membership.account_id = account.id
          and membership.active
          and membership.migration_hold_reason is null
         join identity.staff staff
           on staff.id = membership.staff_id
          and staff.account_id = account.id
          and staff.active
          and lower(btrim(staff.verification_status)) = any($2::text[])
         join identity.organizations organization
           on organization.id = membership.organization_id
          and organization.active
         join identity.facilities facility
           on facility.id = membership.facility_id
          and facility.organization_id = membership.organization_id
          and facility.active
         left join auth.account_roles account_role
           on account_role.account_id = account.id
          and account_role.scope_type = 'facility'
          and account_role.membership_id = membership.id
          and account_role.facility_id = membership.facility_id
          and account_role.revoked_at is null
         left join auth.roles role
           on role.code = account_role.role_code
          and role.active
         left join auth.role_permissions role_permission on role_permission.role_code = role.code
         left join auth.permissions permission
           on permission.code = role_permission.permission_code
          and permission.active
        where account.subject = $1
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
        group by account.id, account.subject, account.email, account.display_name,
                 membership.id, membership.facility_id, membership.organization_id,
                 membership.membership_role, membership.app_role, membership.is_primary,
                 facility.name, facility.code
        order by membership.is_primary desc, facility.name, membership.facility_id) context$q$
    using target_subject, array['verified', 'approved', 'active'] into answer;
  return answer;
end $f$;
grant execute on function pg_temp.previous_staff_context(text) to hid_identity_api_runtime;
do $$
declare
  matched boolean;
  context jsonb;
begin
  -- Before support's review: the restricted role.
  context := pg_temp.previous_staff_context('org-onboarding:' || current_setting('hid.test.rollback_self_account'));
  if jsonb_array_length(context) <> 1
     or (select array_agg(value order by value) from jsonb_array_elements_text(context -> 0 -> 'permissions'))
       is distinct from array['audit.read', 'outreach.campaign.read', 'outreach.campaign.write',
         'outreach.registration.read', 'outreach.registration.write', 'workforce.manage'] then
    raise exception 'The previous Identity resolves the pending administrator as %', context;
  end if;
  if jsonb_array_length(pg_temp.previous_staff_context('staff:rollback-admin')) <> 1 then
    raise exception 'The previous Identity does not resolve the governed administrator';
  end if;
  begin
    execute 'select identity.current_organization_cac_binding_matches($1,$2,$3,$4,$5,$6,$7) as matched'
      using 'hospital'::text, 'RC9900067004'::text, 'Self Signed Hospital Ltd'::text,
        'Private Company Limited by Shares'::text, '2014-04-04'::text, '4 Rollback Road, Lagos'::text, 'active'::text
      into matched;
    raise exception 'The pending administrator matched the CAC binding without organization.manage';
  exception when insufficient_privilege then null;
  end;
  begin
    execute 'select platform.consume_qoreid_quota($1,$2,$3,$4,$5)'
      using 'existing_cac'::text, current_setting('hid.test.rollback_self_organization')::uuid,
        null::uuid, null::char(64), null::char(64);
    raise exception 'An unreviewed self-signed-up organization charged a CAC lookup through the previous Identity';
  exception when insufficient_privilege then
    if sqlerrm <> 'QOREID_QUOTA_PERMISSION_DENIED' then raise; end if;
  end;
end $$;
-- Support reviews the facility (the new Identity's command); the previous
-- Identity then resolves org_admin and recognises the binding.
select set_config('app.actor_subject', 'staff:rollback-admin', true),
  set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
  set_config('app.correlation_id', 'rollback-review-self', true);
select granted_role from identity.admin_review_self_service_facility(
  (select item.application_id from identity.admin_list_self_service_facilities('unreviewed') item
    where item.administrator_account_id = current_setting('hid.test.rollback_self_account')::uuid),
  (select item.row_version from identity.admin_list_self_service_facilities('unreviewed') item
    where item.administrator_account_id = current_setting('hid.test.rollback_self_account')::uuid),
  'Checked before the rollback', 'none', 'cac_registered_contact', null, null);
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.rollback_self_account'), true),
  set_config('app.facility_id', current_setting('hid.test.rollback_self_facility'), true),
  set_config('app.membership_id', current_setting('hid.test.rollback_self_membership'), true),
  set_config('app.correlation_id', 'rollback-binding-0002', true);
do $$
declare matched boolean; context jsonb;
begin
  context := pg_temp.previous_staff_context('org-onboarding:' || current_setting('hid.test.rollback_self_account'));
  if not (context -> 0 -> 'permissions') ? 'organization.manage' then
    raise exception 'The previous Identity does not resolve the reviewed administrator as org_admin: %', context;
  end if;
  execute 'select identity.current_organization_cac_binding_matches($1,$2,$3,$4,$5,$6,$7) as matched'
    using 'hospital'::text, 'RC9900067004'::text, 'Self Signed Hospital Ltd'::text,
      'Private Company Limited by Shares'::text, '2014-04-04'::text, '4 Rollback Road, Lagos'::text, 'active'::text
    into matched;
  if matched is not true then
    raise exception 'The previous Identity does not recognise a self-signed-up organization''s CAC binding';
  end if;
  execute 'select platform.consume_qoreid_quota($1,$2,$3,$4,$5)'
    using 'existing_cac'::text, current_setting('hid.test.rollback_self_organization')::uuid,
      null::uuid, null::char(64), null::char(64);
end $$;
reset role;
-- R7: the review columns cleared by owner SQL; the lookup is refused by R7.
update identity.organization_applications set self_service_reviewed_at = null, self_service_reviewed_by_account_id = null,
  self_service_review_note = null, self_service_granted_role = null, self_service_verification_method = null
 where organization_id = current_setting('hid.test.rollback_self_organization')::uuid;
set local role hid_identity_api_runtime;
do $$ begin
  execute 'select platform.consume_qoreid_quota($1,$2,$3,$4,$5)'
    using 'existing_cac'::text, current_setting('hid.test.rollback_self_organization')::uuid,
      null::uuid, null::char(64), null::char(64);
  raise exception 'An organization without a recorded review charged a CAC lookup through the previous Identity';
exception when insufficient_privilege then
  if sqlerrm <> 'QOREID_QUOTA_SELF_SERVICE_REVIEW_REQUIRED' then raise; end if;
end $$;
reset role;

-- 6. Platform controls: the admin console (withPlatformTransaction without a
-- facility) and the security guard's context-free reads.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:rollback-admin', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true),
  set_config('app.correlation_id', 'rollback-controls-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare
  listed text[];
  outreach record;
  result record;
begin
  execute 'select array_agg(control_key order by control_key) from platform.admin_list_controls()' into listed;
  if cardinality(listed) <> 10 or not listed @> array['provider_self_service_enabled', 'staff_invitations_enabled',
      'cross_facility_orders_enabled', 'cross_facility_route_access_enabled'] then
    raise exception 'The previous admin console does not list the four new controls: %', listed;
  end if;
  for outreach in execute 'select * from platform.admin_list_controls()' loop
    if outreach.control_key = 'outreach_portal_enabled' then
      execute 'select * from platform.admin_set_control($1,$2,$3,$4)'
        using outreach.control_key, not outreach.enabled, outreach.row_version, 'Rollback suite flips outreach'::text
        into result;
      execute 'select * from platform.admin_set_control($1,$2,$3,$4)'
        using outreach.control_key, outreach.enabled, result.row_version, 'Rollback suite restores outreach'::text
        into result;
      if result.enabled is distinct from outreach.enabled or result.replayed then
        raise exception 'The previous admin console could not change an old control';
      end if;
    end if;
  end loop;
end $$;
select set_config('app.actor_subject', '', true),
  set_config('app.correlation_id', '', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  bypasses boolean := (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
    join pg_roles role_row on role_row.oid = proc.proowner
    where proc.oid = 'platform.control_enabled(text)'::regprocedure)
    or (select not relforcerowsecurity from pg_class where oid = 'platform.control_settings'::regclass);
  key text;
  enabled boolean;
begin
  if not bypasses then
    raise exception 'The suite expected the control table to be readable by its owner here';
  end if;
  foreach key in array array['patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
      'maintenance_mode', 'uploads_enabled', 'break_glass_enabled'] loop
    execute 'select platform.control_enabled($1) as enabled' using key into enabled;
    if enabled is null then
      raise exception 'The security guard''s read of % returned nothing', key;
    end if;
  end loop;
end $$;

-- 7. The hourly prune (withSystemTransaction).
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'rollback-prune-0001', true);
do $$
declare pruned integer;
begin
  execute 'select platform.prune_verification_quotas()' into pruned;
  if pruned is null or pruned < 0 then
    raise exception 'The previous Identity''s prune returned %', pruned;
  end if;
end $$;
reset role;

-- 8. The previous Lab and Pharmacy (57a94db) on the new work lists (P4c):
-- a hospital's own Lab and Pharmacy accept its orders, list their work and
-- read one item, each with the previous service's SQL text through the exact
-- API runtime in the context DatabaseService.withTransaction sets. Owner SQL
-- writes the hospital, its staff, the patient's consents and the orders.
insert into identity.organizations (id, name, slug)
values ('c8a10000-0000-4000-8000-000000000001', 'Rollback Clinic Ltd', 'rollback-clinic');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
values ('c8a20000-0000-4000-8000-000000000001', 'c8a10000-0000-4000-8000-000000000001', 'Rollback Clinic',
  'ROLLBACK-CLINIC', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
select ('c8a00000-0000-4000-8000-00000000000' || s.n)::uuid, 'staff:rollback-' || s.code,
  'rollback-' || s.code || '@example.invalid', s.full_name, 'active'
  from (values (1, 'doctor', 'Rollback Doctor'), (2, 'lab', 'Rollback Scientist'),
               (3, 'pharmacist', 'Rollback Pharmacist'), (4, 'patient', 'Rollback Patient')) s(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('c8a30000-0000-4000-8000-00000000000' || s.n)::uuid, ('c8a00000-0000-4000-8000-00000000000' || s.n)::uuid,
  s.full_name, 'rollback-' || s.role || '@example.invalid', 'verified', s.role
  from (values (1, 'doctor', 'Rollback Doctor'), (2, 'lab', 'Rollback Scientist'),
               (3, 'pharmacist', 'Rollback Pharmacist')) s(n, role, full_name);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('c8a40000-0000-4000-8000-00000000000' || s.n)::uuid, ('c8a30000-0000-4000-8000-00000000000' || s.n)::uuid,
  ('c8a00000-0000-4000-8000-00000000000' || s.n)::uuid, 'c8a10000-0000-4000-8000-000000000001',
  'c8a20000-0000-4000-8000-000000000001', s.role, s.role, true, true
  from (values (1, 'doctor'), (2, 'lab'), (3, 'pharmacist')) s(n, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('c8a50000-0000-4000-8000-00000000000' || s.n)::uuid, ('c8a00000-0000-4000-8000-00000000000' || s.n)::uuid,
  s.role, 'facility', ('c8a40000-0000-4000-8000-00000000000' || s.n)::uuid, 'c8a20000-0000-4000-8000-000000000001',
  'Rollback suite role'
  from (values (1, 'doctor'), (2, 'lab'), (3, 'pharmacist')) s(n, role);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status)
values ('c8a60000-0000-4000-8000-000000000001', 'c8a00000-0000-4000-8000-000000000004', 'HID-RBACKPAT',
  'Rollback', 'Patient', 'Rollback Patient', 'female', '1991-02-03', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), 'c8a60000-0000-4000-8000-000000000001', ('c8a30000-0000-4000-8000-00000000000' || n)::uuid,
  ('c8a00000-0000-4000-8000-00000000000' || n)::uuid, ('c8a40000-0000-4000-8000-00000000000' || n)::uuid,
  'c8a20000-0000-4000-8000-000000000001', 'write_records', 'active', 'Rollback suite consent',
  clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day', false, 'direct-care'
  from generate_series(1, 3) n;
select set_config('app.actor_subject', 'staff:rollback-doctor', true),
  set_config('app.membership_id', 'c8a40000-0000-4000-8000-000000000001', true),
  set_config('app.facility_id', 'c8a20000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'rollback-orders-0001', true),
  set_config('app.purpose_of_use', 'direct-care', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('c8a70000-0000-4000-8000-000000000001', 'c8a60000-0000-4000-8000-000000000001',
  'c8a20000-0000-4000-8000-000000000001', 'c8a00000-0000-4000-8000-000000000001',
  'c8a40000-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
values ('c8a80000-0000-4000-8000-000000000001', 'c8a70000-0000-4000-8000-000000000001',
  'c8a60000-0000-4000-8000-000000000001', 'c8a20000-0000-4000-8000-000000000001',
  'c8a00000-0000-4000-8000-000000000001', 'c8a40000-0000-4000-8000-000000000001', 'http://loinc.org', '718-7',
  'Haemoglobin', 'routine', 'active', 'whole-blood', 'Rollback suite request');
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
  instructions, starts_on, status)
values ('c8a90000-0000-4000-8000-000000000001', 'c8a70000-0000-4000-8000-000000000001',
  'c8a60000-0000-4000-8000-000000000001', 'c8a20000-0000-4000-8000-000000000001',
  'c8a00000-0000-4000-8000-000000000001', 'c8a40000-0000-4000-8000-000000000001', 'urn:rollback:medication',
  'paracetamol-500', 'Paracetamol 500 mg', 1, 'tablet', 'oral', 'Every 6 hours', 'Take with water', current_date, 'active');

-- The previous EHR (lab-requests.service.ts create, lock and update): the
-- order tables' new triggers (the route mirror) leave its writes unchanged.
set local role hid_ehr_api_runtime;
select set_config('app.actor_subject', 'staff:rollback-doctor', true),
  set_config('app.facility_id', 'c8a20000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'rollback-ehr-0001', true),
  set_config('app.membership_id', 'c8a40000-0000-4000-8000-000000000001', true),
  set_config('app.purpose_of_use', 'direct-care', true);
do $$
declare
  columns text := 'id, encounter_id as "encounterId", patient_id as "patientId", facility_id as "facilityId",
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  test_code_system as "testCodeSystem", test_code as "testCode", test_display as "testDisplay",
  priority, status, specimen_type_code as "specimenTypeCode", clinical_information as "clinicalInformation",
  external_order_reference as "externalOrderReference", row_version as "rowVersion",
  created_at as "createdAt", updated_at as "updatedAt"';
  created record;
  locked record;
  updated record;
begin
  execute 'insert into ehr.lab_requests (
               encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
               test_code_system, test_code, test_display, priority, status,
               specimen_type_code, clinical_information, external_order_reference
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             returning ' || columns
    using 'c8a70000-0000-4000-8000-000000000001'::uuid, 'c8a60000-0000-4000-8000-000000000001'::uuid,
      'c8a20000-0000-4000-8000-000000000001'::uuid, 'c8a00000-0000-4000-8000-000000000001'::uuid,
      'c8a40000-0000-4000-8000-000000000001'::uuid, 'http://loinc.org', '2345-7', 'Glucose', 'routine', 'draft',
      'serum', 'Rollback suite second request', null::text
    into created;
  execute 'select ' || columns || ' from ehr.lab_requests
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4 for update'
    using created.id, created."encounterId", created."patientId", created."facilityId" into locked;
  perform set_config('app.change_reason', 'Raised after review', true);
  execute 'update ehr.lab_requests set
             priority = coalesce($1, priority), status = coalesce($2, status),
             clinical_information = coalesce($3, clinical_information)
           where id = $4 and encounter_id = $5 and patient_id = $6 and facility_id = $7 and row_version = $8
           returning ' || columns
    using 'urgent'::text, 'active'::text, null::text, created.id, created."encounterId", created."patientId",
      created."facilityId", locked."rowVersion"
    into updated;
  if updated."rowVersion" is distinct from 2 or updated.status <> 'active' or updated.priority <> 'urgent' then
    raise exception 'The previous EHR could not update its lab request: %', row_to_json(updated);
  end if;
end $$;
reset role;
create temp table rollback_orders as
  select lab_request.id, lab_request.patient_id, lab_request.facility_id, lab_request.row_version,
    lab_request.encounter_id, lab_request.priority, lab_request.test_code_system, lab_request.test_code,
    lab_request.test_display, lab_request.clinical_information, lab_request.created_by, lab_request.created_at
    from ehr.lab_requests lab_request where lab_request.id = 'c8a80000-0000-4000-8000-000000000001';
create temp table rollback_prescriptions as
  select prescription.* from ehr.prescriptions prescription
   where prescription.id = 'c8a90000-0000-4000-8000-000000000001';
grant select on rollback_orders to hid_lab_api_runtime;
grant select on rollback_prescriptions to hid_pharmacy_api_runtime;

-- The previous Lab (lab-work-items.service.ts acceptEhrOrder, get, list).
set local role hid_lab_api_runtime;
select set_config('app.actor_subject', 'staff:rollback-lab', true),
  set_config('app.facility_id', 'c8a20000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'rollback-lab-0001', true),
  set_config('app.membership_id', 'c8a40000-0000-4000-8000-000000000002', true),
  set_config('app.purpose_of_use', 'direct-care', true);
do $$
declare
  source_order record;
  existing record;
  accepted record;
  item_id uuid := gen_random_uuid();
  read_back record;
  listed integer;
begin
  select * into source_order from rollback_orders;
  execute 'select id::text,patient_id::text,facility_id::text,ordering_facility_id::text,
        source_ehr_order_id::text,source_ehr_order_version::text,source_encounter_id::text,status,
        priority,accepted_by::text,accepted_at,row_version::text,created_at,request_sha256
       from lab.work_items where (facility_id=$1 and accepted_by=$2 and idempotency_key=$3)
         or source_ehr_order_id=$4'
    using 'c8a20000-0000-4000-8000-000000000001'::uuid, 'c8a00000-0000-4000-8000-000000000002'::uuid,
      'ehr-lab-order:' || source_order.id || ':v' || source_order.row_version, source_order.id
    into existing;
  if existing.id is not null then
    raise exception 'The previous Lab found work before accepting';
  end if;
  execute 'insert into lab.work_items(id,patient_id,facility_id,ordering_facility_id,source_ehr_order_id,
        source_ehr_order_version,source_encounter_id,status,priority,test_code_system,test_code,
        test_name,clinical_indication,requested_by,requested_at,accepted_by,
        accepted_by_membership_id,idempotency_key,request_sha256,correlation_id)
       values ($1,$2,$3,$4,$5,$6,$7,''accepted'',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       returning *'
    using item_id, source_order.patient_id, 'c8a20000-0000-4000-8000-000000000001'::uuid,
      source_order.facility_id, source_order.id, source_order.row_version, source_order.encounter_id,
      source_order.priority, source_order.test_code_system, source_order.test_code, source_order.test_display,
      source_order.clinical_information, source_order.created_by, source_order.created_at,
      'c8a00000-0000-4000-8000-000000000002'::uuid, 'c8a40000-0000-4000-8000-000000000002'::uuid,
      'ehr-lab-order:' || source_order.id || ':v' || source_order.row_version, repeat('7', 64), 'rollback-lab-0001'
    into accepted;
  execute 'insert into lab.work_item_requested_tests(work_item_id,facility_id,patient_id,"ordinal",code_system,code,name)
       values ($1,$2,$3,1,$4,$5,$6)'
    using accepted.id, accepted.facility_id, accepted.patient_id, source_order.test_code_system, source_order.test_code,
      source_order.test_display;
  execute 'insert into lab.work_item_events(work_item_id,facility_id,patient_id,event_version,event_type,
        actor_id,actor_membership_id,reason,correlation_id)
       values ($1,$2,$3,1,''accepted'',$4,$5,''Accepted exact EHR laboratory order version'',$6)'
    using accepted.id, accepted.facility_id, accepted.patient_id, 'c8a00000-0000-4000-8000-000000000002'::uuid,
      'c8a40000-0000-4000-8000-000000000002'::uuid, 'rollback-lab-0001';
  if accepted.order_route_id is not null then
    raise exception 'The previous Lab''s same-facility work item carries a route';
  end if;
  execute 'select id::text,patient_id::text,facility_id::text,ordering_facility_id::text,
  source_ehr_order_id::text,source_ehr_order_version::text,source_encounter_id::text,status,priority,
  accepted_by::text,accepted_at,row_version::text,created_at from lab.work_items where id=$1'
    using item_id into read_back;
  if read_back.id is distinct from item_id::text then
    raise exception 'The previous Lab could not read its work item';
  end if;
  execute 'select count(*) from (select w.id::text,w.patient_id::text,w.facility_id::text,w.ordering_facility_id::text,
        w.source_ehr_order_id::text,w.source_ehr_order_version::text,w.source_encounter_id::text,w.status,w.priority,
        w.accepted_by::text,w.accepted_at,w.row_version::text,w.created_at,w.test_name,a.id::text as accession_id,
        a.accession_number,array_remove(array_agg(s.status order by s.created_at),null) as specimen_statuses from lab.work_items w
        left join lab.accessions a on a.work_item_id=w.id left join lab.specimens s on s.accession_id=a.id
        group by w.id,a.id,a.accession_number order by w.accepted_at asc,w.id asc limit 200) listed'
    into listed;
  if listed <> 1 then
    raise exception 'The previous Lab listed % work items, not its one', listed;
  end if;
end $$;
reset role;

-- The previous Pharmacy (pharmacy.service.ts acceptPrescription, getWorkItem,
-- listWorkItems).
set local role hid_pharmacy_api_runtime;
select set_config('app.actor_subject', 'staff:rollback-pharmacist', true),
  set_config('app.facility_id', 'c8a20000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'rollback-pharmacy-0001', true),
  set_config('app.membership_id', 'c8a40000-0000-4000-8000-000000000003', true),
  set_config('app.purpose_of_use', 'direct-care', true);
do $$
declare
  source_prescription record;
  existing record;
  accepted record;
  item_id uuid := gen_random_uuid();
  read_back record;
  listed integer;
  work_item_select text := 'select w.*,d.id::text as dispensing_id,d.status as dispensing_status,
  r.id::text as reversal_id from pharmacy.work_items w
  left join pharmacy.dispensings d on d.work_item_id=w.id
  left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id';
begin
  select * into source_prescription from rollback_prescriptions;
  execute work_item_select || '
        where (w.facility_id=$1 and w.accepted_by=$2 and w.idempotency_key=$3)
          or w.source_ehr_prescription_id=$4'
    using 'c8a20000-0000-4000-8000-000000000001'::uuid, 'c8a00000-0000-4000-8000-000000000003'::uuid,
      'rollback-pharmacy-accept-0001', source_prescription.id
    into existing;
  if existing.id is not null then
    raise exception 'The previous Pharmacy found work before accepting';
  end if;
  execute 'insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values ($1,$2,$3,$4,$5,$6,$7,''active'',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      returning *'
    using item_id, source_prescription.patient_id, 'c8a20000-0000-4000-8000-000000000001'::uuid,
      source_prescription.facility_id, source_prescription.id, source_prescription.row_version,
      source_prescription.encounter_id, source_prescription.medication_code_system, source_prescription.medication_code,
      source_prescription.medication_display, source_prescription.dose_quantity, source_prescription.dose_unit,
      source_prescription.route_code, source_prescription.frequency, source_prescription.instructions,
      source_prescription.starts_on, source_prescription.ends_on, source_prescription.created_by,
      source_prescription.created_at, 'c8a00000-0000-4000-8000-000000000003'::uuid,
      'c8a40000-0000-4000-8000-000000000003'::uuid, 'Collected at the hospital pharmacy',
      'rollback-pharmacy-accept-0001', repeat('8', 64), 'rollback-pharmacy-0001'
    into accepted;
  execute 'insert into pharmacy.work_item_events (
        work_item_id,patient_id,facility_id,event_version,event_type,actor_id,actor_membership_id,reason,correlation_id
      ) values ($1,$2,$3,1,''prescription_accepted'',$4,$5,$6,$7)'
    using accepted.id, accepted.patient_id, accepted.facility_id, 'c8a00000-0000-4000-8000-000000000003'::uuid,
      'c8a40000-0000-4000-8000-000000000003'::uuid, 'Collected at the hospital pharmacy', 'rollback-pharmacy-0001';
  execute work_item_select || ' where w.id=$1' using item_id into read_back;
  if read_back.id is distinct from item_id or read_back.dispensing_id is not null then
    raise exception 'The previous Pharmacy could not read its work item';
  end if;
  execute 'select count(*) from (' || work_item_select || '
        order by w.accepted_at asc,w.id asc limit 200) listed' into listed;
  if listed <> 1 then
    raise exception 'The previous Pharmacy listed % work items, not its one', listed;
  end if;
end $$;
reset role;

rollback;
