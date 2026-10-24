\set ON_ERROR_STOP on
-- Support's release of a fraudulent self sign-up, and the organization CAC
-- lookup of an unreviewed self-signed-up organization (0086, review fixes R2
-- and R7). Rollback-only. Every command runs as the exact Identity API
-- runtime role.
--
--   1. R7 (CRITIC C13): the administrator of a self-signed-up organization
--      that support has not reviewed cannot charge an organization CAC lookup
--      (42501 QOREID_QUOTA_SELF_SERVICE_REVIEW_REQUIRED, nothing charged);
--      once support has reviewed it, the 0049 quota applies as before;
--   2. R2: identity.admin_release_self_service_facility refuses, in order,
--      42501 (no platform.facility.manage), 22023 (reason), P0002 (not an
--      activated self-service application), 40001 (version) and 23514 while
--      the facility is active or the administrator's account is not disabled;
--   3. after the existing commands suspend the facility and disable the
--      account, the release closes the application (rejected, release time,
--      reviewer and reason; activated_at kept), removes the CAC binding,
--      suspends the product, deactivates and renames the organization,
--      revokes the facility role, ends the membership, deactivates the staff
--      record and audits admin.self-service-facility.release as the platform
--      administrator; a second release answers 23505; the support list shows
--      it as handled ('reviewed' and 'all', not 'unreviewed');
--   4. the released email and network cannot reopen the CAC and product for
--      7 days; the real company, with its own email and network, signs up
--      for the same CAC and product and is activated with the legal name.
-- See provider-self-enrollment.integration.sql for why FORCE is lifted on
-- the control table when its owner cannot bypass row-level security.
begin;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

insert into auth.accounts (id, subject, email, status) values
  ('c8b00000-0000-4000-8000-000000000001', 'synthetic:release:super', 'super@release.invalid', 'active'),
  ('c8b00000-0000-4000-8000-000000000002', 'synthetic:release:identity-reviewer', 'reviewer@release.invalid', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c8b10000-0000-4000-8000-000000000001', 'c8b00000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', 'Release suite super admin'),
  ('c8b10000-0000-4000-8000-000000000002', 'c8b00000-0000-4000-8000-000000000002',
   'identity_review_admin', 'platform', 'Release suite identity reviewer');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:release:super', true),
  set_config('app.correlation_id', 'self-service-release-open', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Release suite opens facility sign-up');

-- An impostor signs up a real company's CAC with its own email.
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-release-impostor', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  application_id uuid;
  current_application record;
  activated record;
begin
  application_id := identity.submit_self_service_organization_application('ehr', 'hospital', 'RC9900069001',
    'Impostor', 'impostor@release.invalid', encode(sha256('impostor-network'::bytea), 'hex'));
  select * into current_application from identity.public_get_organization_application(
    'RC9900069001', 'impostor@release.invalid', 'ehr');
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
    'verified', '9900069001', 'RC9900069001', 'Release Company Ltd',
    'Private Company Limited by Shares', '2015-02-01', '1 Release Road, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment('RC9900069001', 'impostor@release.invalid', 'ehr',
    'c8b90000-0000-4000-8000-000000000001', encode(sha256('release-otp-1'::bytea), 'hex'), 'Impostor', 'hospital');
  perform identity.verify_organization_profile_completion_challenge('c8b90000-0000-4000-8000-000000000001',
    encode(sha256('release-otp-1'::bytea), 'hex'), encode(sha256('release-session-1'::bytea), 'hex'));
  if identity.prepare_self_service_provider_activation(encode(sha256('release-session-1'::bytea), 'hex')) <> 'ready' then
    raise exception 'The impostor''s session is not ready';
  end if;
  select * into activated from identity.activate_self_service_provider_enrollment(
    encode(sha256('release-session-1'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform set_config('hid.test.application', application_id::text, true);
  perform set_config('hid.test.organization', activated.organization_id::text, true);
  perform set_config('hid.test.facility', activated.facility_id::text, true);
  perform set_config('hid.test.account', activated.account_id::text, true);
  perform set_config('hid.test.subject', activated.hid_subject, true);
end $$;
reset role;
select set_config('hid.test.membership', (select membership.id::text from identity.staff_facility_memberships membership
  where membership.account_id = current_setting('hid.test.account')::uuid), true);

-- 1. R7: the impostor, signed in with its facility selected, cannot charge a
-- CAC lookup to the organization quota until support has reviewed it.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', current_setting('hid.test.subject'), true),
  set_config('app.correlation_id', 'self-service-release-lookup-1', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', current_setting('hid.test.facility'), true),
  set_config('app.membership_id', current_setting('hid.test.membership'), true);
do $$ begin
  perform platform.consume_qoreid_quota('existing_cac', current_setting('hid.test.organization')::uuid, null, null, null);
  raise exception 'An unreviewed self-signed-up organization charged a CAC lookup';
exception when insufficient_privilege then
  if sqlerrm <> 'QOREID_QUOTA_SELF_SERVICE_REVIEW_REQUIRED' then raise; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from platform.qoreid_quota_counters where operation = 'existing_cac') then
    raise exception 'A refused lookup was charged';
  end if;
end $$;

-- Support reviews it (a reviewed facility can still be released later).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:release:super', true),
  set_config('app.correlation_id', 'self-service-release-review', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select set_config('hid.test.version', (select result.row_version::text
  from identity.admin_review_self_service_facility(current_setting('hid.test.application')::uuid,
    (select item.row_version from identity.admin_list_self_service_facilities('all') item
      where item.application_id = current_setting('hid.test.application')::uuid),
    'Looked plausible at first review') result), true);
select set_config('app.actor_subject', current_setting('hid.test.subject'), true),
  set_config('app.correlation_id', 'self-service-release-lookup-2', true),
  set_config('app.facility_id', current_setting('hid.test.facility'), true),
  set_config('app.membership_id', current_setting('hid.test.membership'), true);
select platform.consume_qoreid_quota('existing_cac', current_setting('hid.test.organization')::uuid, null, null, null);
reset role;
do $$ begin
  if (select count(*) from platform.qoreid_quota_counters where operation = 'existing_cac'
       and scope_id = current_setting('hid.test.organization')::uuid and scope_type = 'target') <> 1 then
    raise exception 'A reviewed organization''s lookup was not charged to the 0049 quota';
  end if;
end $$;

-- 2. The release's refusals.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:release:super', true),
  set_config('app.correlation_id', 'self-service-release-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
do $$
declare
  application uuid := current_setting('hid.test.application')::uuid;
  version bigint := current_setting('hid.test.version')::bigint;
  refused record;
  pending uuid;
begin
  perform set_config('app.actor_subject', 'system:auth', true);
  perform set_config('app.purpose_of_use', '', true);
  pending := identity.submit_self_service_organization_application('ehr', 'clinic', 'RC9900069002',
    'Pending Admin', 'pending@release.invalid', encode(sha256('pending-network'::bytea), 'hex'));
  perform set_config('app.purpose_of_use', 'healthcare-operations', true);
  perform set_config('app.actor_subject', 'synthetic:release:identity-reviewer', true);
  begin
    perform identity.admin_release_self_service_facility(application, version, 'Impostor confirmed by support');
    raise exception 'An identity reviewer released a facility';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
  end;
  perform set_config('app.actor_subject', 'synthetic:release:super', true);
  for refused in select * from (values
      (1, application, version, ' short ', '22023'),
      (2, application, null::bigint, 'Impostor confirmed by support', '22023'),
      (3, pending, 1::bigint, 'Impostor confirmed by support', 'P0002'),
      (4, 'c8b40000-0000-4000-8000-0000000000ff'::uuid, 1::bigint, 'Impostor confirmed by support', 'P0002'),
      (5, application, version - 1, 'Impostor confirmed by support', '40001'),
      -- The facility is still active and the account still enabled.
      (6, application, version, 'Impostor confirmed by support', '23514')
    ) as rows(n, target, expected_version, reason, expected) order by n loop
    begin
      perform identity.admin_release_self_service_facility(refused.target, refused.expected_version, refused.reason);
      raise exception 'Release refusal % was accepted', refused.n;
    exception when others then
      if sqlstate <> refused.expected then
        raise exception 'Release refusal % raised % (%) instead of %', refused.n, sqlstate, sqlerrm, refused.expected;
      end if;
      if refused.n = 6 and sqlerrm <> 'SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION' then raise; end if;
    end;
  end loop;
  -- Support suspends the facility; the account is still enabled.
  perform identity.admin_transition_facility(current_setting('hid.test.facility')::uuid, 1, 'suspended',
    'Impostor confirmed by support', 'release-suite-suspend', repeat('a', 64));
  begin
    perform identity.admin_release_self_service_facility(application, version, 'Impostor confirmed by support');
    raise exception 'A facility was released while its administrator could still sign in';
  exception when check_violation then
    if sqlerrm <> 'SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION' then raise; end if;
  end;
  perform auth.admin_transition_account(current_setting('hid.test.account')::uuid, 1,
    'disabled', 'Impostor confirmed by support', 'release-suite-disable', repeat('b', 64));
end $$;
reset role;
do $$ begin
  if exists (select 1 from audit.events where action = 'admin.self-service-facility.release') then
    raise exception 'A refused release was audited';
  end if;
end $$;

-- 3. The release.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:release:super', true),
  set_config('app.correlation_id', 'self-service-release-0002', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare
  application uuid := current_setting('hid.test.application')::uuid;
  version bigint := current_setting('hid.test.version')::bigint;
  result record;
  listed record;
begin
  select * into result from identity.admin_release_self_service_facility(application, version,
    '  Impostor confirmed: the email is not the company''s  ');
  if result.application_id is distinct from application or result.released_at is null
     or result.row_version <> version + 1 then
    raise exception 'The release did not return the new version: %', row_to_json(result);
  end if;
  perform set_config('hid.test.released_version', result.row_version::text, true);
  begin
    perform identity.admin_release_self_service_facility(application, result.row_version, 'A second release attempt');
    raise exception 'A released facility was released again';
  exception when unique_violation then
    if sqlerrm <> 'SELF_SERVICE_FACILITY_ALREADY_RELEASED' then raise; end if;
  end;
  begin
    perform identity.admin_review_self_service_facility(application, result.row_version, 'A review after the release');
    raise exception 'A released facility was reviewed';
  exception when no_data_found then null;
  end;
  if exists (select 1 from identity.admin_list_self_service_facilities('unreviewed') item
              where item.application_id = application) then
    raise exception 'A released facility is listed as unreviewed';
  end if;
  select * into listed from identity.admin_list_self_service_facilities('reviewed') item
   where item.application_id = application;
  if listed.released_at is distinct from result.released_at
     or listed.released_by_account_id is distinct from 'c8b00000-0000-4000-8000-000000000001'
     or listed.release_reason is distinct from 'Impostor confirmed: the email is not the company''s'
     or listed.review_note is distinct from 'Looked plausible at first review'
     or listed.organization_name is distinct from 'Release Company Ltd'
     or listed.facility_lifecycle_status is distinct from 'suspended'
     or listed.administrator_account_status is distinct from 'disabled'
     or listed.row_version <> result.row_version
     or not exists (select 1 from identity.admin_list_self_service_facilities('all') item
                     where item.application_id = application) then
    raise exception 'The list does not show the release: %', row_to_json(listed);
  end if;
end $$;
reset role;
do $$
declare
  application identity.organization_applications%rowtype;
  event record;
begin
  select * into application from identity.organization_applications
   where id = current_setting('hid.test.application')::uuid;
  if application.status <> 'rejected' or application.reviewed_by_account_id is not null
     or application.reviewed_at is null
     or application.review_reason <> 'Self-service sign-up released by platform support'
     or application.self_service_released_by_account_id <> 'c8b00000-0000-4000-8000-000000000001'
     or application.self_service_release_reason <> 'Impostor confirmed: the email is not the company''s'
     or application.organization_id <> current_setting('hid.test.organization')::uuid
     or application.verified_organization_name <> 'Release Company Ltd' then
    raise exception 'The application was not closed exactly: %', row_to_json(application);
  end if;
  if exists (select 1 from identity.organization_cac_registrations where cac_registration_number = 'RC9900069001')
     or exists (select 1 from identity.organization_products
                 where organization_id = application.organization_id and status <> 'suspended')
     or not exists (select 1 from identity.organizations organization
                     where organization.id = application.organization_id and not organization.active
                       and organization.name = 'Released self sign-up ' || replace(organization.id::text, '-', ''))
     or exists (select 1 from auth.account_roles assignment
                 where assignment.account_id = application.first_admin_account_id
                   and (assignment.revoked_at is null or assignment.revoked_by <> 'c8b00000-0000-4000-8000-000000000001'))
     or exists (select 1 from identity.staff_facility_memberships membership
                 where membership.organization_id = application.organization_id and membership.active)
     or exists (select 1 from identity.staff staff
                 where staff.account_id = application.first_admin_account_id and staff.active) then
    raise exception 'The release did not free the CAC and the legal name, or left a role, membership or staff record active';
  end if;
  select * into event from audit.events where action = 'admin.self-service-facility.release';
  if (select count(*) from audit.events where action = 'admin.self-service-facility.release') <> 1
     or event.actor_type <> 'platform' or event.actor_account_id <> 'c8b00000-0000-4000-8000-000000000001'
     or event.facility_id is not null or event.organization_id is not null or event.actor_membership_id is not null
     or event.correlation_id <> 'self-service-release-0002' or event.outcome <> 'success'
     or event.reason <> 'Impostor confirmed: the email is not the company''s'
     or event.resource_uuid <> application.id
     or event.details ->> 'organizationId' <> application.organization_id::text
     or event.details ->> 'facilityId' <> application.facility_id::text
     or (event.details ->> 'version')::bigint <> application.row_version
     or event.details::text ~ 'RC9900069001|release\.invalid' then
    raise exception 'The release audit row is wrong: %', row_to_json(event);
  end if;
end $$;

-- 4. The impostor cannot reopen the CAC and product for 7 days, by its
-- email or from its network; the real company signs up.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-release-0003', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  attempt record;
  application_id uuid;
  current_application record;
  activated record;
begin
  for attempt in select * from (values
      ('impostor@release.invalid', encode(sha256('other-network'::bytea), 'hex')),
      ('impostor.two@release.invalid', encode(sha256('impostor-network'::bytea), 'hex'))
    ) as rows(email, network) loop
    begin
      perform identity.submit_self_service_organization_application('ehr', 'hospital', 'RC9900069001',
        'Impostor', attempt.email, attempt.network);
      raise exception 'The released email or network reopened the CAC (%)', attempt.email;
    exception when check_violation then
      if sqlerrm <> 'This organization application requires manual resolution' then raise; end if;
    end;
  end loop;

  application_id := identity.submit_self_service_organization_application('ehr', 'hospital', 'RC9900069001',
    'Real Administrator', 'admin@releasecompany.invalid', encode(sha256('company-network'::bytea), 'hex'));
  select * into current_application from identity.public_get_organization_application(
    'RC9900069001', 'admin@releasecompany.invalid', 'ehr');
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
    'verified', '9900069001', 'RC9900069001', 'Release Company Ltd',
    'Private Company Limited by Shares', '2015-02-01', '1 Release Road, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment('RC9900069001', 'admin@releasecompany.invalid', 'ehr',
    'c8b90000-0000-4000-8000-000000000002', encode(sha256('release-otp-2'::bytea), 'hex'),
    'Real Administrator', 'hospital');
  perform identity.verify_organization_profile_completion_challenge('c8b90000-0000-4000-8000-000000000002',
    encode(sha256('release-otp-2'::bytea), 'hex'), encode(sha256('release-session-2'::bytea), 'hex'));
  if identity.prepare_self_service_provider_activation(encode(sha256('release-session-2'::bytea), 'hex')) <> 'ready' then
    raise exception 'The real company''s activation is still blocked';
  end if;
  select * into activated from identity.activate_self_service_provider_enrollment(
    encode(sha256('release-session-2'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform set_config('hid.test.real_organization', activated.organization_id::text, true);
end $$;
reset role;
do $$ begin
  if not exists (select 1 from identity.organizations organization
                  where organization.id = current_setting('hid.test.real_organization')::uuid
                    and organization.name = 'Release Company Ltd' and organization.active)
     or (select binding.organization_id from identity.organization_cac_registrations binding
          where binding.cac_registration_number = 'RC9900069001')
        is distinct from current_setting('hid.test.real_organization')::uuid then
    raise exception 'The real company was not registered with its CAC and legal name';
  end if;
end $$;

rollback;
