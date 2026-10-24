\set ON_ERROR_STOP on
-- Open self-service applications: support's list and rejection, and the
-- 7-day refusal to reopen a closed application's CAC and product for its
-- email or network (0086, review fix R3). Rollback-only. Every command runs
-- as the exact Identity API runtime role.
--
--   1. identity.admin_list_open_self_service_applications lists every
--      pending or verified self-service application, oldest first, with the
--      CAC masked, whether its email was confirmed, and when it lapses; not
--      activated, rejected or governed ones; it needs
--      platform.identity-review.read and no facility membership;
--   2. identity.admin_reject_self_service_application refuses, in order,
--      42501, 22023, P0002 (not an open self-service application) and 40001;
--      it closes the application (reviewer, reason, time), ends its codes and
--      sessions (the session can no longer activate) and audits
--      admin.self-service-application.reject as the platform administrator;
--   3. after a rejection, the same email or the same network cannot reopen
--      the CAC and product for 7 days; another email from another network
--      can; after 7 days the same email can;
--   4. after a lapse, the lapsed application's network cannot take the CAC
--      over with a new email (the attempt changes nothing: the stale
--      application stays open), while another network and email can;
--   5. a submit without a network (NULL) is still accepted, and a malformed
--      network digest raises 22023.
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
  ('c8c00000-0000-4000-8000-000000000001', 'synthetic:open:super', 'super@open.invalid', 'active'),
  ('c8c00000-0000-4000-8000-000000000002', 'synthetic:open:identity-reviewer', 'reviewer@open.invalid', 'active'),
  ('c8c00000-0000-4000-8000-000000000003', 'synthetic:open:facility-reviewer', 'facility@open.invalid', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c8c10000-0000-4000-8000-000000000001', 'c8c00000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', 'Open applications suite super admin'),
  ('c8c10000-0000-4000-8000-000000000002', 'c8c00000-0000-4000-8000-000000000002',
   'identity_review_admin', 'platform', 'Open applications suite identity reviewer'),
  ('c8c10000-0000-4000-8000-000000000003', 'c8c00000-0000-4000-8000-000000000003',
   'facility_review_admin', 'platform', 'Open applications suite facility reviewer');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:open:super', true),
  set_config('app.correlation_id', 'self-service-open-control', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Open applications suite opens facility sign-up');

-- Applications: a squat that verified its email (s), a pending one (p), an
-- activated one (a), and a governed one (g).
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  squat uuid; pending uuid; activated_application uuid; current_application record;
begin
  squat := identity.submit_self_service_organization_application('ehr', 'hospital', 'RC9900070001',
    'Squatter', 'squatter@open.invalid', encode(sha256('squatter-network'::bytea), 'hex'));
  select * into current_application from identity.public_get_organization_application(
    'RC9900070001', 'squatter@open.invalid', 'ehr');
  perform identity.public_record_organization_cac_result(squat, current_application.row_version,
    'verified', '9900070001', 'RC9900070001', 'Open Hospital Ltd',
    'Private Company Limited by Shares', '2016-01-01', '1 Open Road, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment('RC9900070001', 'squatter@open.invalid', 'ehr',
    'c8c90000-0000-4000-8000-000000000001', encode(sha256('open-otp-1'::bytea), 'hex'), 'Squatter', 'hospital');
  perform identity.verify_organization_profile_completion_challenge('c8c90000-0000-4000-8000-000000000001',
    encode(sha256('open-otp-1'::bytea), 'hex'), encode(sha256('open-session-1'::bytea), 'hex'));
  pending := identity.submit_self_service_organization_application('laboratory', 'laboratory', 'RC9900070002',
    'Pending Admin', 'pending@open.invalid', encode(sha256('pending-network'::bytea), 'hex'));
  activated_application := identity.submit_self_service_organization_application('pharmacy', 'pharmacy',
    'RC9900070003', 'Activated Admin', 'activated@open.invalid', encode(sha256('activated-network'::bytea), 'hex'));
  select * into current_application from identity.public_get_organization_application(
    'RC9900070003', 'activated@open.invalid', 'pharmacy');
  perform identity.public_record_organization_cac_result(activated_application, current_application.row_version,
    'verified', '9900070003', 'RC9900070003', 'Open Pharmacy Ltd',
    'Private Company Limited by Shares', '2016-01-03', '3 Open Road, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment('RC9900070003', 'activated@open.invalid', 'pharmacy',
    'c8c90000-0000-4000-8000-000000000003', encode(sha256('open-otp-3'::bytea), 'hex'), 'Activated Admin', 'pharmacy');
  perform identity.verify_organization_profile_completion_challenge('c8c90000-0000-4000-8000-000000000003',
    encode(sha256('open-otp-3'::bytea), 'hex'), encode(sha256('open-session-3'::bytea), 'hex'));
  perform identity.prepare_self_service_provider_activation(encode(sha256('open-session-3'::bytea), 'hex'));
  perform identity.activate_self_service_provider_enrollment(encode(sha256('open-session-3'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform identity.submit_organization_application('migrate', 'clinic', 'RC9900070004',
    'Governed Admin', 'governed@open.invalid');
  perform set_config('hid.test.squat', squat::text, true);
  perform set_config('hid.test.pending', pending::text, true);
end $$;
reset role;
update identity.organization_applications set created_at = created_at - interval '2 hours'
 where id = current_setting('hid.test.squat')::uuid;
select set_config('hid.test.activated', (select id::text from identity.organization_applications
    where cac_registration_number = 'RC9900070003'), true),
  set_config('hid.test.governed', (select id::text from identity.organization_applications
    where cac_registration_number = 'RC9900070004'), true);

-- 1. The list.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:open:identity-reviewer', true),
  set_config('app.correlation_id', 'self-service-open-0002', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare listed record; ids uuid[];
begin
  select array_agg(item.application_id order by ordinality) into ids
    from identity.admin_list_open_self_service_applications() with ordinality item;
  if ids is distinct from array[current_setting('hid.test.squat')::uuid, current_setting('hid.test.pending')::uuid] then
    raise exception 'The open list is not the two open self-service applications, oldest first: %', ids;
  end if;
  select * into listed from identity.admin_list_open_self_service_applications() item
   where item.application_id = current_setting('hid.test.squat')::uuid;
  if listed.product_code <> 'ehr' or listed.organization_type <> 'hospital' or listed.cac_hint <> 'RC********01'
     or listed.organization_name <> 'Open Hospital Ltd' or listed.administrator_name <> 'Squatter'
     or listed.administrator_email <> 'squatter@open.invalid' or listed.application_status <> 'ready_for_review'
     or listed.verification_result <> 'verified' or not listed.email_verified
     or listed.lapses_at <> listed.submitted_at + interval '24 hours' or listed.row_version is null then
    raise exception 'The listed open application is wrong: %', row_to_json(listed);
  end if;
  select * into listed from identity.admin_list_open_self_service_applications() item
   where item.application_id = current_setting('hid.test.pending')::uuid;
  if listed.email_verified or listed.organization_name is not null
     or listed.application_status <> 'pending_verification' then
    raise exception 'The pending application is listed wrongly: %', row_to_json(listed);
  end if;
  perform set_config('hid.test.squat_version', (select item.row_version::text
    from identity.admin_list_open_self_service_applications() item
   where item.application_id = current_setting('hid.test.squat')::uuid), true);
  perform set_config('app.correlation_id', '', true);
  begin
    perform identity.admin_list_open_self_service_applications();
    raise exception 'The open list ran without a correlation ID';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.correlation_id', 'self-service-open-0002', true);
  perform set_config('app.actor_subject', 'synthetic:open:facility-reviewer', true);
  begin
    perform identity.admin_list_open_self_service_applications();
    raise exception 'A facility reviewer without identity-review read listed open applications';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
  end;
end $$;

-- 2. The rejection.
do $$
declare
  squat uuid := current_setting('hid.test.squat')::uuid;
  version bigint := current_setting('hid.test.squat_version')::bigint;
  refused record;
  result record;
begin
  perform set_config('app.actor_subject', 'synthetic:open:identity-reviewer', true);
  begin
    perform identity.admin_reject_self_service_application(squat, version, 'Squat on a real company');
    raise exception 'An identity reviewer rejected an application';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
  end;
  perform set_config('app.actor_subject', 'synthetic:open:facility-reviewer', true);
  for refused in select * from (values
      (1, squat, version, 'short', '22023'),
      (2, squat, null::bigint, 'Squat on a real company', '22023'),
      (3, current_setting('hid.test.activated')::uuid, 1::bigint, 'Squat on a real company', 'P0002'),
      (4, current_setting('hid.test.governed')::uuid, 1::bigint, 'Squat on a real company', 'P0002'),
      (5, 'c8c40000-0000-4000-8000-0000000000ff'::uuid, 1::bigint, 'Squat on a real company', 'P0002'),
      (6, squat, version + 1, 'Squat on a real company', '40001')
    ) as rows(n, target, expected_version, reason, expected) order by n loop
    begin
      perform identity.admin_reject_self_service_application(refused.target, refused.expected_version, refused.reason);
      raise exception 'Rejection refusal % was accepted', refused.n;
    exception when others then
      if sqlstate <> refused.expected then
        raise exception 'Rejection refusal % raised % (%) instead of %', refused.n, sqlstate, sqlerrm, refused.expected;
      end if;
    end;
  end loop;
  select * into result from identity.admin_reject_self_service_application(squat, version,
    '  Squat on a real company: not its email  ');
  if result.application_id <> squat or result.rejected_at is null or result.row_version <> version + 1 then
    raise exception 'The rejection did not return the new version: %', row_to_json(result);
  end if;
  perform set_config('app.actor_subject', 'synthetic:open:identity-reviewer', true);
  if exists (select 1 from identity.admin_list_open_self_service_applications() item
              where item.application_id = squat) then
    raise exception 'A rejected application is still listed as open';
  end if;
end $$;
reset role;
do $$
declare application identity.organization_applications%rowtype; event record;
begin
  select * into application from identity.organization_applications where id = current_setting('hid.test.squat')::uuid;
  if application.status <> 'rejected' or application.reviewed_by_account_id <> 'c8c00000-0000-4000-8000-000000000003'
     or application.review_reason <> 'Squat on a real company: not its email' or application.reviewed_at is null
     or exists (select 1 from identity.organization_profile_completion_challenges challenge
                 where challenge.application_id = application.id and challenge.invalidated_at is null) then
    raise exception 'The rejection did not close the application and its sessions: %', row_to_json(application);
  end if;
  select * into event from audit.events where action = 'admin.self-service-application.reject';
  if (select count(*) from audit.events where action = 'admin.self-service-application.reject') <> 1
     or event.actor_type <> 'platform' or event.actor_account_id <> 'c8c00000-0000-4000-8000-000000000003'
     or event.facility_id is not null or event.organization_id is not null
     or event.reason <> 'Squat on a real company: not its email' or event.resource_uuid <> application.id
     or event.details ->> 'previousStatus' <> 'ready_for_review'
     or (event.details ->> 'version')::bigint <> application.row_version
     or event.details::text ~ 'RC9900070001|open\.invalid' then
    raise exception 'The rejection audit row is wrong: %', row_to_json(event);
  end if;
end $$;

-- The rejected application's session can no longer activate.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0003', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare attempt record; reopened uuid;
begin
  if identity.prepare_self_service_provider_activation(encode(sha256('open-session-1'::bytea), 'hex')) <> 'session_invalid' then
    raise exception 'A rejected application''s session is still live';
  end if;
  -- 3. The rejected email, or its network, cannot reopen the CAC and product.
  for attempt in select * from (values
      ('squatter@open.invalid', encode(sha256('another-network'::bytea), 'hex')),
      ('squatter.two@open.invalid', encode(sha256('squatter-network'::bytea), 'hex'))
    ) as rows(email, network) loop
    begin
      perform identity.submit_self_service_organization_application('ehr', 'hospital', 'RC9900070001',
        'Squatter', attempt.email, attempt.network);
      raise exception 'A rejected email or network reopened the CAC (%)', attempt.email;
    exception when check_violation then
      if sqlerrm <> 'This organization application requires manual resolution' then raise; end if;
    end;
  end loop;
  -- Another product for the same CAC is a different application.
  perform identity.submit_self_service_organization_application('migrate', 'hospital', 'RC9900070001',
    'Squatter', 'squatter@open.invalid', encode(sha256('squatter-network'::bytea), 'hex'));
  -- The real company, from its own network.
  reopened := identity.submit_self_service_organization_application('ehr', 'hospital', 'RC9900070001',
    'Real Administrator', 'admin@openhospital.invalid', encode(sha256('company-network'::bytea), 'hex'));
  if reopened = current_setting('hid.test.squat')::uuid then
    raise exception 'The rejected application was reopened';
  end if;
end $$;
reset role;
-- After 7 days the rejected email may submit again. (The real company's
-- application is closed here only to free the CAC and product.)
update identity.organization_applications set status = 'rejected', reviewed_at = clock_timestamp(),
  reviewed_by_account_id = 'c8c00000-0000-4000-8000-000000000001', review_reason = 'Withdrawn by the suite'
 where cac_registration_number = 'RC9900070001' and product_code = 'ehr'
   and administrator_email = 'admin@openhospital.invalid';
update identity.organization_applications set reviewed_at = clock_timestamp() - interval '8 days'
 where cac_registration_number = 'RC9900070001' and product_code = 'ehr' and status = 'rejected';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0004', true);
do $$ begin
  perform identity.submit_self_service_organization_application('ehr', 'hospital', 'RC9900070001',
    'Squatter', 'squatter@open.invalid', encode(sha256('squatter-network'::bytea), 'hex'));
end $$;
reset role;

-- 4. After a lapse, the lapsed application's network cannot take the CAC over
-- with a new email; another network can.
update identity.organization_applications set created_at = created_at - interval '25 hours'
 where id = current_setting('hid.test.pending')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0005', true);
do $$
declare taken uuid;
begin
  begin
    perform identity.submit_self_service_organization_application('laboratory', 'laboratory', 'RC9900070002',
      'Pending Admin', 'pending.two@open.invalid', encode(sha256('pending-network'::bytea), 'hex'));
    raise exception 'The stale application''s own network took it over with another email';
  exception when check_violation then
    if sqlerrm <> 'This organization application requires manual resolution' then raise; end if;
  end;
  if (select application.application_status from identity.public_get_organization_application(
        'RC9900070002', 'pending@open.invalid', 'laboratory') application) <> 'pending_verification' then
    raise exception 'The refused takeover changed the stale application';
  end if;
  taken := identity.submit_self_service_organization_application('laboratory', 'laboratory', 'RC9900070002',
    'Real Lab Admin', 'admin@openlab.invalid', encode(sha256('lab-company-network'::bytea), 'hex'));
  if taken = current_setting('hid.test.pending')::uuid then
    raise exception 'Another network did not take over the stale application';
  end if;

  -- 5. No network, and a malformed one.
  perform identity.submit_self_service_organization_application('ehr', 'clinic', 'RC9900070005',
    'No Network Admin', 'nonetwork@open.invalid');
  begin
    perform identity.submit_self_service_organization_application('ehr', 'clinic', 'RC9900070006',
      'Bad Network Admin', 'badnetwork@open.invalid', repeat('Z', 64));
    raise exception 'A malformed network digest was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'Invalid provider enrollment' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if (select submitter_network_digest from identity.organization_applications
       where administrator_email = 'admin@openlab.invalid') <> encode(sha256('lab-company-network'::bytea), 'hex')
     or (select submitter_network_digest from identity.organization_applications
          where administrator_email = 'nonetwork@open.invalid') is not null then
    raise exception 'The submitting network was not kept on the application';
  end if;
end $$;

rollback;
