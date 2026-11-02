\set ON_ERROR_STOP on
-- 0103: a platform administrator (no facility, no membership) lists, reads,
-- checks the CAC of, approves and rejects organization applications, and the
-- audit rows are platform rows 0064 accepts. A facility-scoped administrator
-- behaves exactly as before; a platform account without
-- platform.admin.access, a platform role without the requested permission, a
-- disabled account and a staff session that names a facility without an
-- active membership there are refused. Runs as the Identity API's runtime
-- role with the session settings DatabaseService sets.
begin;

-- Accounts. Super admin: platform_super_admin, no facility membership (the
-- production platform administrator). Facility admin: the same role plus an
-- active admin membership (today's facility-scoped path). No-access: a
-- synthetic platform role with every permission the routes ask for except
-- platform.admin.access. Reviewer: identity_review_admin (list only).
-- Lapsed: platform_super_admin and an inactive membership. Disabled:
-- platform_super_admin on a disabled account.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('c5100000-0000-4000-8000-000000000001', 'staff:platform-org-super', 'platform-org-super@example.invalid', 'Platform Super', 'active'),
  ('c5100000-0000-4000-8000-000000000002', 'staff:platform-org-facility-admin', 'platform-org-facility@example.invalid', 'Facility Admin', 'active'),
  ('c5100000-0000-4000-8000-000000000003', 'staff:platform-org-no-access', 'platform-org-no-access@example.invalid', 'No Admin Access', 'active'),
  ('c5100000-0000-4000-8000-000000000004', 'staff:platform-org-reviewer', 'platform-org-reviewer@example.invalid', 'Identity Reviewer', 'active'),
  ('c5100000-0000-4000-8000-000000000005', 'staff:platform-org-lapsed', 'platform-org-lapsed@example.invalid', 'Lapsed Member', 'active'),
  ('c5100000-0000-4000-8000-000000000006', 'staff:platform-org-disabled', 'platform-org-disabled@example.invalid', 'Disabled Super', 'disabled');
insert into identity.organizations (id, name, slug)
values ('c5110000-0000-4000-8000-000000000001', 'Platform Review Office', 'platform-review-office');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
values ('c5120000-0000-4000-8000-000000000001', 'c5110000-0000-4000-8000-000000000001',
  'Platform Review Office', 'PLATFORM-REVIEW', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('c5130000-0000-4000-8000-000000000002', 'c5100000-0000-4000-8000-000000000002', 'Facility Admin',
   'platform-org-facility@example.invalid', 'verified', 'admin'),
  ('c5130000-0000-4000-8000-000000000005', 'c5100000-0000-4000-8000-000000000005', 'Lapsed Member',
   'platform-org-lapsed@example.invalid', 'verified', 'admin');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active) values
  ('c5140000-0000-4000-8000-000000000002', 'c5130000-0000-4000-8000-000000000002',
   'c5100000-0000-4000-8000-000000000002', 'c5110000-0000-4000-8000-000000000001',
   'c5120000-0000-4000-8000-000000000001', 'admin', 'admin', true, true),
  ('c5140000-0000-4000-8000-000000000005', 'c5130000-0000-4000-8000-000000000005',
   'c5100000-0000-4000-8000-000000000005', 'c5110000-0000-4000-8000-000000000001',
   'c5120000-0000-4000-8000-000000000001', 'admin', 'admin', true, false);
insert into auth.roles (code, description)
values ('synthetic_no_admin_access', 'Synthetic platform role without platform.admin.access');
insert into auth.role_permissions (role_code, permission_code) values
  ('synthetic_no_admin_access', 'platform.identity-review.read'),
  ('synthetic_no_admin_access', 'platform.facility.manage'),
  ('synthetic_no_admin_access', 'platform.principal.manage'),
  ('synthetic_no_admin_access', 'platform.role.manage');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c5150000-0000-4000-8000-000000000001', 'c5100000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform', 'Synthetic platform review test'),
  ('c5150000-0000-4000-8000-000000000002', 'c5100000-0000-4000-8000-000000000002', 'platform_super_admin', 'platform', 'Synthetic platform review test'),
  ('c5150000-0000-4000-8000-000000000003', 'c5100000-0000-4000-8000-000000000003', 'synthetic_no_admin_access', 'platform', 'Synthetic platform review test'),
  ('c5150000-0000-4000-8000-000000000004', 'c5100000-0000-4000-8000-000000000004', 'identity_review_admin', 'platform', 'Synthetic platform review test'),
  ('c5150000-0000-4000-8000-000000000005', 'c5100000-0000-4000-8000-000000000005', 'platform_super_admin', 'platform', 'Synthetic platform review test'),
  ('c5150000-0000-4000-8000-000000000006', 'c5100000-0000-4000-8000-000000000006', 'platform_super_admin', 'platform', 'Synthetic platform review test');

-- A session as DatabaseService sets it: withPlatformTransaction sends '' for
-- a missing facility and membership.
create function pg_temp.platform_org_session(subject text, facility text, membership text,
  correlation text default 'platform-org-applications-0001', purpose text default 'healthcare-operations')
returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', facility, true),
    set_config('app.membership_id', membership, true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', purpose, true);
$$;
grant execute on function pg_temp.platform_org_session(text, text, text, text, text) to public;

set local role hid_identity_api_runtime;

-- Five public applications (system context, as the public route sends them).
select set_config('app.actor_subject', 'system:auth', true);
select set_config('app.correlation_id', 'platform-org-applications-submit', true);
do $$
begin
  perform identity.submit_organization_application('ehr', 'clinic',
    'RC5100001', 'Platform Approve Applicant', 'platform-approve@example.invalid');
  perform identity.submit_organization_application('laboratory', 'laboratory',
    'RC5100002', 'Platform Reject Applicant', 'platform-reject@example.invalid');
  perform identity.submit_organization_application('pharmacy', 'pharmacy',
    'RC5100003', 'Facility Approve Applicant', 'facility-approve@example.invalid');
  perform identity.submit_organization_application('migrate', 'clinic',
    'RC5100004', 'Refusal Applicant', 'refusal-applicant@example.invalid');
  perform identity.submit_organization_application('ehr', 'hospital',
    'RC5100005', 'Facility Reject Applicant', 'facility-reject@example.invalid');
end $$;
reset role;
select set_config('test.refusal_target', (select id::text from identity.organization_applications
  where cac_registration_number = 'RC5100004'), true);
set local role hid_identity_api_runtime;

-- 1. Refusals. Each is 42501 and changes nothing.
do $$
declare
  target uuid;
  attempt record;
begin
  target := current_setting('test.refusal_target')::uuid;
  -- (subject, facility, membership, correlation, purpose, what): every call
  -- below must be refused for each of these sessions.
  for attempt in select * from (values
    -- a platform account without platform.admin.access (holds every other
    -- permission the routes ask for)
    ('staff:platform-org-no-access', '', '', 'platform-org-applications-0001', 'healthcare-operations', 'no admin access'),
    -- a disabled platform super admin
    ('staff:platform-org-disabled', '', '', 'platform-org-applications-0001', 'healthcare-operations', 'disabled account'),
    -- a staff session that names a facility without an active membership
    -- there (inactive membership), although it holds platform_super_admin
    ('staff:platform-org-lapsed', 'c5120000-0000-4000-8000-000000000001', 'c5140000-0000-4000-8000-000000000005',
     'platform-org-applications-0001', 'healthcare-operations', 'inactive membership'),
    -- the super admin naming a facility it has no membership of
    ('staff:platform-org-super', 'c5120000-0000-4000-8000-000000000001', 'c5140000-0000-4000-8000-000000000002',
     'platform-org-applications-0001', 'healthcare-operations', 'another account''s membership'),
    -- a facility but no membership, and a membership but no facility
    ('staff:platform-org-super', 'c5120000-0000-4000-8000-000000000001', '',
     'platform-org-applications-0001', 'healthcare-operations', 'facility without membership'),
    ('staff:platform-org-super', '', 'c5140000-0000-4000-8000-000000000002',
     'platform-org-applications-0001', 'healthcare-operations', 'membership without facility'),
    -- correlation id and purpose rules unchanged for a platform call
    ('staff:platform-org-super', '', '', '', 'healthcare-operations', 'no correlation id'),
    ('staff:platform-org-super', '', '', 'platform-org-applications-0001', 'treatment', 'another purpose'),
    ('staff:platform-org-super', '', '', 'platform-org-applications-0001', '', 'no purpose'),
    -- no account
    ('staff:platform-org-unknown', '', '', 'platform-org-applications-0001', 'healthcare-operations', 'unknown subject'))
      s(subject, facility, membership, correlation, purpose, what)
  loop
    perform pg_temp.platform_org_session(attempt.subject, attempt.facility, attempt.membership,
      attempt.correlation, attempt.purpose);
    begin
      perform identity.admin_list_organization_applications(null);
      raise exception 'List was allowed: %', attempt.what;
    exception when insufficient_privilege then null;
    end;
    begin
      perform identity.admin_get_organization_application(target);
      raise exception 'Read was allowed: %', attempt.what;
    exception when insufficient_privilege then null;
    end;
    begin
      perform identity.admin_record_organization_cac_result(target, 1, 'verified', '86511', null,
        'RC5100004', 'Refusal Legal Limited', 'Private Limited Company', '2015-01-01', '4 Refusal Road, Lagos', 'active');
      raise exception 'CAC check was allowed: %', attempt.what;
    exception when insufficient_privilege then null;
    end;
    begin
      perform identity.admin_approve_organization_application(target, 1, null, null, 'Synthetic refused approval');
      raise exception 'Approval was allowed: %', attempt.what;
    exception when insufficient_privilege then null;
    end;
    begin
      perform identity.admin_reject_organization_application(target, 1, 'Synthetic refused rejection');
      raise exception 'Rejection was allowed: %', attempt.what;
    exception when insufficient_privilege then null;
    end;
    if attempt.correlation <> '' then
      begin
        perform platform.consume_qoreid_quota('application_cac', target, null, null, null);
        raise exception 'CAC quota was allowed: %', attempt.what;
      exception when insufficient_privilege then null;
      end;
    end if;
  end loop;

  -- The identity reviewer may list and read in platform scope, but the
  -- requested permission is still required: no CAC check, approval or
  -- rejection.
  perform pg_temp.platform_org_session('staff:platform-org-reviewer', '', '');
  if not exists (select 1 from identity.admin_list_organization_applications('pending_verification') item
                  where item.application_id = target) then
    raise exception 'Identity reviewer could not list in platform scope';
  end if;
  begin
    perform identity.admin_get_organization_application(target);
    raise exception 'Identity reviewer read an application without platform.facility.manage';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.admin_record_organization_cac_result(target, 1, 'not_verified', null, 'not_verified',
      null, null, null, null, null, null);
    raise exception 'Identity reviewer checked a CAC without platform.facility.manage';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.admin_reject_organization_application(target, 1, 'Synthetic reviewer rejection');
    raise exception 'Identity reviewer rejected without platform.facility.manage';
  exception when insufficient_privilege then null;
  end;
  begin
    perform platform.consume_qoreid_quota('application_cac', target, null, null, null);
    raise exception 'Identity reviewer reserved CAC quota without platform.facility.manage';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.organization_applications
              where cac_registration_number = 'RC5100004' and (status <> 'pending_verification' or row_version <> 1))
     or exists (select 1 from audit.events where correlation_id = 'platform-org-applications-0001')
     or exists (select 1 from platform.qoreid_quota_counters counter
                  join identity.organization_applications application on application.id = counter.scope_id
                 where application.cac_registration_number = 'RC5100004') then
    raise exception 'A refused call changed an application, wrote audit or reserved quota';
  end if;
end $$;

-- 2. The platform super admin (no facility, no membership): list, read,
-- reserve CAC quota, record a failed and a passed CAC check, approve one
-- application and reject another.
set local role hid_identity_api_runtime;
do $$
declare
  approve_id uuid;
  reject_id uuid;
  changed record;
  approved record;
  secret record;
begin
  perform pg_temp.platform_org_session('staff:platform-org-super', '', '', 'platform-org-applications-0002');
  select application_id into approve_id from identity.admin_list_organization_applications('pending_verification')
   where cac_hint = 'RC*****01' and product_code = 'ehr';
  select application_id into reject_id from identity.admin_list_organization_applications(null)
   where cac_hint = 'RC*****02' and product_code = 'laboratory';
  if approve_id is null or reject_id is null then
    raise exception 'Platform super admin list omitted pending applications';
  end if;
  select * into secret from identity.admin_get_organization_application(approve_id);
  if not found then raise exception 'Platform super admin could not read an application'; end if;
  perform platform.consume_qoreid_quota('application_cac', approve_id, null, null, null);

  select * into changed from identity.admin_record_organization_cac_result(
    approve_id, 1, 'not_verified', null, 'not_verified', null, null, null, null, null, null);
  if changed.application_status <> 'pending_verification' or changed.row_version <> 2 then
    raise exception 'Platform failed CAC check did not record';
  end if;
  select * into changed from identity.admin_record_organization_cac_result(
    approve_id, 2, 'verified', '86512', null,
    'RC5100001', 'Platform Approve Legal Limited', 'Private Limited Company',
    '2016-03-04', '1 Platform Road, Lagos', 'active');
  if changed.application_status <> 'ready_for_review' or changed.row_version <> 3 then
    raise exception 'Platform passed CAC check did not move the application to review';
  end if;
  begin
    perform identity.admin_approve_organization_application(approve_id, 2, null, null, 'Synthetic stale approval');
    raise exception 'Platform stale approval was accepted';
  exception when serialization_failure then null;
  end;
  select * into approved from identity.admin_approve_organization_application(
    approve_id, 3, null, null, 'Synthetic platform approval');
  if approved.organization_reused or approved.row_version <> 4 or approved.organization_id is null
     or approved.facility_id is null or approved.first_admin_account_id is null then
    raise exception 'Platform approval did not provision organization, facility and first admin';
  end if;
  begin
    perform identity.admin_reject_organization_application(reject_id, 1, 'short');
    raise exception 'Platform rejection without a reason was accepted';
  exception when invalid_parameter_value then null;
  end;
  select * into changed from identity.admin_reject_organization_application(
    reject_id, 1, 'Synthetic platform rejection');
  if changed.application_status <> 'rejected' or changed.row_version <> 2 then
    raise exception 'Platform rejection did not close the application';
  end if;
  if not exists (select 1 from identity.admin_list_organization_applications('approved') where application_id = approve_id)
     or not exists (select 1 from identity.admin_list_organization_applications('rejected') where application_id = reject_id) then
    raise exception 'Platform list does not show the closed applications';
  end if;
end $$;
reset role;

-- The platform rows: actor_type platform, admin.* actions, no facility,
-- membership or organization; the reviewer recorded on the application.
do $$
declare
  approved_application identity.organization_applications%rowtype;
begin
  select * into approved_application from identity.organization_applications where cac_registration_number = 'RC5100001';
  if approved_application.reviewed_by_account_id <> 'c5100000-0000-4000-8000-000000000001'
     or (select reviewed_by_account_id from identity.organization_applications where cac_registration_number = 'RC5100002')
        <> 'c5100000-0000-4000-8000-000000000001' then
    raise exception 'The platform reviewer was not recorded on the applications';
  end if;
  if (select count(*) from audit.events event
       where event.correlation_id = 'platform-org-applications-0002'
         and event.actor_type = 'platform'
         and event.actor_subject = 'staff:platform-org-super'
         and event.actor_account_id = 'c5100000-0000-4000-8000-000000000001'
         and event.actor_membership_id is null and event.facility_id is null
         and event.organization_id is null and event.patient_id is null
         and event.purpose_of_use = 'healthcare-operations'
         and event.resource_type = 'organization-application') <> 4
     or (select string_agg(event.action || ':' || event.outcome, ',' order by event.sequence_id)
           from audit.events event where event.correlation_id = 'platform-org-applications-0002')
        <> 'admin.organization-application.cac-verify:denied,admin.organization-application.cac-verify:success,'
           || 'admin.organization-application.approve:success,admin.organization-application.reject:denied' then
    raise exception 'Platform audit rows are not the expected platform rows: %',
      (select string_agg(event.actor_type || '/' || event.action || '/' || event.outcome, ', ')
         from audit.events event where event.correlation_id = 'platform-org-applications-0002');
  end if;
  if not exists (select 1 from audit.events event
                  where event.correlation_id = 'platform-org-applications-0002'
                    and event.action = 'admin.organization-application.approve'
                    and event.resource_id = approved_application.id::text
                    and event.details ->> 'organizationId' = approved_application.organization_id::text
                    and event.details ->> 'productCode' = 'ehr'
                    and (event.details ->> 'organizationReused')::boolean is false) then
    raise exception 'Platform approval audit lost the organization in details';
  end if;
  if not exists (select 1 from identity.organization_products product
                  where product.organization_id = approved_application.organization_id and product.product_code = 'ehr') then
    raise exception 'Platform approval did not enable the product';
  end if;
end $$;

-- 3. The facility-scoped administrator: exactly today's behaviour and rows.
set local role hid_identity_api_runtime;
do $$
declare
  target uuid;
  changed record;
  approved record;
begin
  perform pg_temp.platform_org_session('staff:platform-org-facility-admin',
    'c5120000-0000-4000-8000-000000000001', 'c5140000-0000-4000-8000-000000000002',
    'platform-org-applications-0003');
  select application_id into target from identity.admin_list_organization_applications('pending_verification')
   where cac_hint = 'RC*****03' and product_code = 'pharmacy';
  if target is null then raise exception 'Facility admin list omitted the pending application'; end if;
  perform platform.consume_qoreid_quota('application_cac', target, null, null, null);
  select * into changed from identity.admin_record_organization_cac_result(
    target, 1, 'verified', '86513', null,
    'RC5100003', 'Facility Approve Legal Limited', 'Private Limited Company',
    '2017-05-06', '3 Facility Road, Lagos', 'active');
  if changed.application_status <> 'ready_for_review' or changed.row_version <> 2 then
    raise exception 'Facility admin CAC check did not move the application to review';
  end if;
  select * into approved from identity.admin_approve_organization_application(
    target, 2, null, null, 'Synthetic facility approval');
  if approved.row_version <> 3 or approved.organization_id is null then
    raise exception 'Facility admin approval failed';
  end if;
end $$;
reset role;
do $$
declare
  new_organization uuid := (select organization_id from identity.organization_applications
                             where cac_registration_number = 'RC5100003');
begin
  if (select string_agg(format('%s|%s|%s|%s|%s|%s', event.actor_type, event.action, event.outcome,
            event.facility_id, event.actor_membership_id, coalesce(event.organization_id::text, '-')),
            ',' order by event.sequence_id)
        from audit.events event where event.correlation_id = 'platform-org-applications-0003')
     <> format('staff|identity.organization.application.cac-verify|success|%s|%s|-,'
               || 'staff|identity.organization.application.approve|success|%s|%s|%s',
               'c5120000-0000-4000-8000-000000000001', 'c5140000-0000-4000-8000-000000000002',
               'c5120000-0000-4000-8000-000000000001', 'c5140000-0000-4000-8000-000000000002', new_organization) then
    raise exception 'Facility-scoped audit rows changed';
  end if;
  if exists (select 1 from audit.events event where event.correlation_id = 'platform-org-applications-0003'
              and event.details ? 'organizationId') then
    raise exception 'Facility-scoped approval details changed';
  end if;
end $$;

-- A facility-scoped rejection keeps today's row too.
set local role hid_identity_api_runtime;
do $$
declare
  target uuid;
  changed record;
begin
  perform pg_temp.platform_org_session('staff:platform-org-facility-admin',
    'c5120000-0000-4000-8000-000000000001', 'c5140000-0000-4000-8000-000000000002',
    'platform-org-applications-0004');
  select application_id into target from identity.admin_list_organization_applications(null)
   where cac_hint = 'RC*****05';
  select * into changed from identity.admin_reject_organization_application(target, 1, 'Synthetic facility rejection');
  if changed.application_status <> 'rejected' then raise exception 'Facility admin rejection failed'; end if;
end $$;
reset role;
do $$ begin
  if (select string_agg(format('%s|%s|%s|%s|%s|%s', event.actor_type, event.action, event.outcome,
            event.facility_id, event.actor_membership_id, coalesce(event.organization_id::text, '-')), ',')
        from audit.events event where event.correlation_id = 'platform-org-applications-0004')
     is distinct from 'staff|identity.organization.application.reject|denied|c5120000-0000-4000-8000-000000000001|'
                      || 'c5140000-0000-4000-8000-000000000002|-' then
    raise exception 'Facility-scoped rejection audit row changed';
  end if;
end $$;

rollback;
