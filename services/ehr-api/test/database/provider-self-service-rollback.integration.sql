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
--     completion start, invalidate, verify, current and complete;
--   services/identity-api/src/identity/qoreid-verification.service.ts
--     the existing-organization CAC binding match, here for an administrator
--     who signed up through 0086 before the rollback;
--   services/identity-api/src/admin/admin.service.ts and auth/security.guard.ts
--     the platform control list, change and reads.
--
-- What it shows: governed applications default to admin_review; governed
-- approvals and rejections name a reviewer and a reason, so the replaced
-- review check admits them; the replaced governed submit and prune keep their
-- answers; the control list carries the seventh key and the six old keys
-- answer as before. The previous Identity calls no 0086 command.
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
  perform identity.begin_organization_profile_completion('RC9900067004', 'self.signed@rollback.invalid', 'ehr',
    'c8990000-0000-4000-8000-000000000004', encode(sha256('rollback-otp-4'::bytea), 'hex'));
  perform identity.verify_organization_profile_completion_challenge('c8990000-0000-4000-8000-000000000004',
    encode(sha256('rollback-otp-4'::bytea), 'hex'), encode(sha256('rollback-session-4'::bytea), 'hex'));
  select * into activated from identity.activate_self_service_provider_enrollment(
    encode(sha256('rollback-session-4'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform set_config('hid.test.rollback_self_account', activated.account_id::text, true);
  perform set_config('hid.test.rollback_self_facility', activated.facility_id::text, true);
end $$;
reset role;
select set_config('hid.test.rollback_self_membership',
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.rollback_self_account')::uuid), true);
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.rollback_self_account'), true),
  set_config('app.facility_id', current_setting('hid.test.rollback_self_facility'), true),
  set_config('app.membership_id', current_setting('hid.test.rollback_self_membership'), true),
  set_config('app.correlation_id', 'rollback-binding-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare matched boolean;
begin
  execute 'select identity.current_organization_cac_binding_matches($1,$2,$3,$4,$5,$6,$7) as matched'
    using 'hospital'::text, 'RC9900067004'::text, 'Self Signed Hospital Ltd'::text,
      'Private Company Limited by Shares'::text, '2014-04-04'::text, '4 Rollback Road, Lagos'::text, 'active'::text
    into matched;
  if matched is not true then
    raise exception 'The previous Identity does not recognise a self-signed-up organization''s CAC binding';
  end if;
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
  if cardinality(listed) <> 7 or not listed @> array['provider_self_service_enabled'] then
    raise exception 'The previous admin console does not list the seventh control: %', listed;
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

rollback;
