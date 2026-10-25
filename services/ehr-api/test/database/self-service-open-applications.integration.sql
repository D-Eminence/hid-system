\set ON_ERROR_STOP on
-- Open self-service applications: support's list and rejection, the 7-day
-- refusal support sets, its waiver, and how a hold is (not) renewed (0086,
-- review fixes R3, R15 and R16). Rollback-only. Every command runs as the
-- exact Identity API runtime role.
--
--   1. identity.admin_list_open_self_service_applications lists every
--      pending or verified self-service application, with the CAC masked,
--      whether its email was confirmed, when it lapses, whether it holds its
--      CAC now and the total; not activated, rejected or governed ones; it
--      needs platform.identity-review.read and no facility membership;
--   2. identity.admin_reject_self_service_application refuses, in order,
--      42501, 22023, P0002 (not an open self-service application) and 40001;
--      it closes the application (reviewer, reason, time, a refusal ending 7
--      days later), ends its codes and sessions (the session can no longer
--      activate) and audits admin.self-service-application.reject as the
--      platform administrator;
--   3. while that refusal is in force, the same email or the same network
--      cannot open the CAC and product again; another email from another
--      network can, with a hold; once the refusal has ended the same email
--      can, without a hold for 7 days after the closure, then with one;
--   4. R15, a lapse refuses no one:
--      a. a mistyped email corrected from the same network after 24 hours is
--         accepted: the typo application lapses and the corrected one is
--         opened without a hold (anyone else's submit lapses it at once);
--      b. a squatter that resubmits from its own network with a new email
--         gains no hold: the real company's next submit lapses it at once and
--         gets the hold;
--      c. a stranger that lapses the real administrator's stale application
--         holds the CAC for 24 hours; after that the real administrator's own
--         email and network are accepted (without a hold);
--   5. R15, support's remedies: a rejection that lets the applicant retry
--      sets no refusal, and the same email and network start again at once;
--      identity.admin_waive_self_service_refusals lifts every refusal in
--      force for a CAC number and product (each audited), refusing, in
--      order, 42501, 22023 and P0002 (none in force);
--   6. R16: with more than 200 open applications, the one that holds a CAC
--      now and is verified comes first, the total counts them all, and the
--      exact CAC number search finds it; a malformed search raises 22023;
--   7. a submit without a network (NULL) is still accepted, and a malformed
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
    raise exception 'The open list is not the two open self-service applications, verified first: %', ids;
  end if;
  select * into listed from identity.admin_list_open_self_service_applications() item
   where item.application_id = current_setting('hid.test.squat')::uuid;
  if listed.product_code <> 'ehr' or listed.organization_type <> 'hospital' or listed.cac_hint <> 'RC********01'
     or listed.organization_name <> 'Open Hospital Ltd' or listed.administrator_name <> 'Squatter'
     or listed.administrator_email <> 'squatter@open.invalid' or listed.application_status <> 'ready_for_review'
     or listed.verification_result <> 'verified' or not listed.email_verified
     or listed.lapses_at <> listed.submitted_at + interval '24 hours' or listed.row_version is null
     or not listed.holds_cac or listed.total_count <> 2 then
    raise exception 'The listed open application is wrong: %', row_to_json(listed);
  end if;
  select * into listed from identity.admin_list_open_self_service_applications() item
   where item.application_id = current_setting('hid.test.pending')::uuid;
  if listed.email_verified or listed.organization_name is not null
     or listed.application_status <> 'pending_verification' or not listed.holds_cac then
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
      (1, squat, version, 'short', false, '22023'),
      (2, squat, null::bigint, 'Squat on a real company', false, '22023'),
      (3, squat, version, 'Squat on a real company', null::boolean, '22023'),
      (4, current_setting('hid.test.activated')::uuid, 1::bigint, 'Squat on a real company', false, 'P0002'),
      (5, current_setting('hid.test.governed')::uuid, 1::bigint, 'Squat on a real company', false, 'P0002'),
      (6, 'c8c40000-0000-4000-8000-0000000000ff'::uuid, 1::bigint, 'Squat on a real company', false, 'P0002'),
      (7, squat, version + 1, 'Squat on a real company', false, '40001')
    ) as rows(n, target, expected_version, reason, allow_retry, expected) order by n loop
    begin
      perform identity.admin_reject_self_service_application(refused.target, refused.expected_version, refused.reason,
        refused.allow_retry);
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
     or application.self_service_refusal_ends_at is distinct from application.reviewed_at + interval '7 days'
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
     or event.details -> 'allowRetry' <> 'false'::jsonb
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
  -- 3. While the refusal is in force, the rejected email, or its network,
  -- cannot open the CAC and product again.
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
  -- The real company, from its own network, with a hold.
  reopened := identity.submit_self_service_organization_application('ehr', 'hospital', 'RC9900070001',
    'Real Administrator', 'admin@openhospital.invalid', encode(sha256('company-network'::bytea), 'hex'));
  if reopened = current_setting('hid.test.squat')::uuid then
    raise exception 'The rejected application was reopened';
  end if;
  perform set_config('hid.test.reopened', reopened::text, true);
end $$;
reset role;
do $$ begin
  if (select self_service_without_hold from identity.organization_applications
       where id = current_setting('hid.test.reopened')::uuid) then
    raise exception 'The real company''s application was opened without a hold';
  end if;
end $$;
-- Once the refusal has ended the rejected email may submit again, here from
-- another network: without a hold while the closure is under 7 days old (the
-- email alone matches), then with one. (The real company's application is
-- closed here only to free the CAC and product.)
update identity.organization_applications set status = 'rejected', reviewed_at = clock_timestamp(),
  reviewed_by_account_id = 'c8c00000-0000-4000-8000-000000000001', review_reason = 'Withdrawn by the suite'
 where id = current_setting('hid.test.reopened')::uuid;
update identity.organization_applications set self_service_refusal_ends_at = clock_timestamp() - interval '1 second'
 where id = current_setting('hid.test.squat')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0004', true);
select set_config('hid.test.after_refusal', identity.submit_self_service_organization_application('ehr', 'hospital',
  'RC9900070001', 'Squatter', 'squatter@open.invalid', encode(sha256('squatter-mobile'::bytea), 'hex'))::text, true);
reset role;
do $$ begin
  if not (select self_service_without_hold from identity.organization_applications
           where id = current_setting('hid.test.after_refusal')::uuid) then
    raise exception 'An email whose application closed under 7 days ago was given a hold';
  end if;
end $$;
update identity.organization_applications set status = 'rejected', reviewed_at = clock_timestamp(),
  reviewed_by_account_id = 'c8c00000-0000-4000-8000-000000000001', review_reason = 'Withdrawn by the suite'
 where id = current_setting('hid.test.after_refusal')::uuid;
update identity.organization_applications set reviewed_at = clock_timestamp() - interval '8 days'
 where cac_registration_number = 'RC9900070001' and product_code = 'ehr' and status = 'rejected';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0005', true);
select set_config('hid.test.after_week', identity.submit_self_service_organization_application('ehr', 'hospital',
  'RC9900070001', 'Squatter', 'squatter@open.invalid', encode(sha256('squatter-network'::bytea), 'hex'))::text, true);
reset role;
do $$ begin
  if (select self_service_without_hold from identity.organization_applications
       where id = current_setting('hid.test.after_week')::uuid) then
    raise exception 'An email whose application closed over 7 days ago was not given a hold';
  end if;
end $$;

-- 4a. R15: a mistyped email corrected from the same network after 24 hours.
-- The pending laboratory application (pending@open.invalid) stands for the
-- typo; its network is the office's.
update identity.organization_applications set created_at = created_at - interval '25 hours'
 where id = current_setting('hid.test.pending')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0006', true);
do $$
declare corrected uuid; real_company uuid;
begin
  corrected := identity.submit_self_service_organization_application('laboratory', 'laboratory', 'RC9900070002',
    'Pending Admin', 'pending.two@open.invalid', encode(sha256('pending-network'::bytea), 'hex'));
  if corrected = current_setting('hid.test.pending')::uuid then
    raise exception 'The corrected email resumed the typo application';
  end if;
  perform set_config('hid.test.corrected', corrected::text, true);
  -- The corrected application holds nothing: anyone else's submit lapses it
  -- at once (here a squatter from elsewhere, which then holds the CAC).
  perform set_config('app.actor_subject', 'synthetic:open:identity-reviewer', true);
  perform set_config('app.purpose_of_use', 'healthcare-operations', true);
  if exists (select 1 from identity.admin_list_open_self_service_applications('RC9900070002') item
              where item.application_id = corrected and (item.holds_cac or item.lapses_at <> item.submitted_at)) then
    raise exception 'The corrected application is listed as holding its CAC';
  end if;
  perform set_config('app.actor_subject', 'system:auth', true);
  perform set_config('app.purpose_of_use', '', true);
  -- 4b. A squatter that resubmits from its own network with a new email gains
  -- no hold: the real company's next submit lapses it.
  real_company := identity.submit_self_service_organization_application('laboratory', 'laboratory', 'RC9900070002',
    'Real Lab Admin', 'admin@openlab.invalid', encode(sha256('lab-company-network'::bytea), 'hex'));
  if real_company = corrected then
    raise exception 'Another email and network did not lapse the holdless application';
  end if;
  perform set_config('hid.test.real_lab', real_company::text, true);
  begin
    perform identity.submit_self_service_organization_application('laboratory', 'laboratory', 'RC9900070002',
      'Squatter Again', 'pending.three@open.invalid', encode(sha256('pending-network'::bytea), 'hex'));
    raise exception 'The real company''s fresh application was taken over';
  exception when check_violation then
    if sqlerrm <> 'This organization application requires manual resolution' then raise; end if;
  end;
end $$;
reset role;
do $$
declare typo identity.organization_applications%rowtype; corrected identity.organization_applications%rowtype;
begin
  select * into typo from identity.organization_applications where id = current_setting('hid.test.pending')::uuid;
  select * into corrected from identity.organization_applications where id = current_setting('hid.test.corrected')::uuid;
  if typo.status <> 'rejected' or typo.self_service_refusal_ends_at is not null
     or typo.review_reason <> 'Self-service application lapsed: not activated within 24 hours of submission'
     or not corrected.self_service_without_hold or corrected.status <> 'rejected'
     or corrected.self_service_refusal_ends_at is not null
     or corrected.review_reason <> 'Self-service application lapsed: opened without a hold and replaced by another sign-up'
     or (select self_service_without_hold from identity.organization_applications
          where id = current_setting('hid.test.real_lab')::uuid) then
    raise exception 'The typo, the corrected and the real company''s applications are wrong: % / %',
      row_to_json(typo), row_to_json(corrected);
  end if;
  if (select array_agg((details ->> 'withoutHold') order by sequence_id) from audit.events
       where action = 'identity.organization.self-service.lapse' and correlation_id = 'self-service-open-0006')
     is distinct from array['false', 'true'] then
    raise exception 'The two lapses were not audited with their hold';
  end if;
end $$;

-- 4c. A stranger lapses the real administrator's stale application. After the
-- stranger's 24 hours, the real administrator's own email and network are
-- accepted, without a hold.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0007', true);
select set_config('hid.test.victim', identity.submit_self_service_organization_application('pharmacy', 'pharmacy',
  'RC9900070007', 'Victim Admin', 'admin@victim.invalid', encode(sha256('victim-network'::bytea), 'hex'))::text, true);
reset role;
update identity.organization_applications set created_at = created_at - interval '25 hours'
 where id = current_setting('hid.test.victim')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0008', true);
do $$
declare stranger uuid;
begin
  stranger := identity.submit_self_service_organization_application('pharmacy', 'pharmacy', 'RC9900070007',
    'Stranger', 'stranger@elsewhere.invalid', encode(sha256('stranger-network'::bytea), 'hex'));
  perform set_config('hid.test.stranger', stranger::text, true);
  begin
    perform identity.submit_self_service_organization_application('pharmacy', 'pharmacy', 'RC9900070007',
      'Victim Admin', 'admin@victim.invalid', encode(sha256('victim-network'::bytea), 'hex'));
    raise exception 'The stranger''s fresh application did not hold the CAC';
  exception when check_violation then
    if sqlerrm <> 'This organization application requires manual resolution' then raise; end if;
  end;
end $$;
reset role;
update identity.organization_applications set created_at = created_at - interval '25 hours'
 where id = current_setting('hid.test.stranger')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0009', true);
select set_config('hid.test.victim_back', identity.submit_self_service_organization_application('pharmacy', 'pharmacy',
  'RC9900070007', 'Victim Admin', 'admin@victim.invalid', encode(sha256('victim-network'::bytea), 'hex'))::text, true);
reset role;
do $$ begin
  if current_setting('hid.test.victim_back')::uuid in (current_setting('hid.test.victim')::uuid,
       current_setting('hid.test.stranger')::uuid)
     or (select status from identity.organization_applications where id = current_setting('hid.test.stranger')::uuid)
        <> 'rejected'
     or not (select self_service_without_hold from identity.organization_applications
              where id = current_setting('hid.test.victim_back')::uuid) then
    raise exception 'The real administrator did not get back in after the stranger''s 24 hours';
  end if;
end $$;

-- 5. Support's remedies. A rejection that lets the applicant retry sets no
-- refusal: the same email and network start again at once.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0010', true),
  set_config('app.purpose_of_use', '', true);
select set_config('hid.test.retry', identity.submit_self_service_organization_application('ehr', 'clinic',
  'RC9900070008', 'Typo Admin', 'admin@typo.invalid', encode(sha256('typo-network'::bytea), 'hex'))::text, true);
reset role;
select set_config('hid.test.retry_version', (select row_version::text from identity.organization_applications
  where id = current_setting('hid.test.retry')::uuid), true);
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:open:facility-reviewer', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select application_id from identity.admin_reject_self_service_application(current_setting('hid.test.retry')::uuid,
  current_setting('hid.test.retry_version')::bigint, 'The applicant mistyped the email', true);
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.purpose_of_use', '', true);
do $$ begin
  perform identity.submit_self_service_organization_application('ehr', 'clinic', 'RC9900070008',
    'Typo Admin', 'admin@company-typo.invalid', encode(sha256('typo-network'::bytea), 'hex'));
end $$;
reset role;
do $$ begin
  if (select self_service_refusal_ends_at from identity.organization_applications
       where id = current_setting('hid.test.retry')::uuid) is not null
     or (select details -> 'allowRetry' from audit.events where action = 'admin.self-service-application.reject'
          and resource_uuid = current_setting('hid.test.retry')::uuid) <> 'true'::jsonb then
    raise exception 'A rejection that lets the applicant retry set a refusal';
  end if;
end $$;

-- The waiver: a rejection refuses an employee's office network; support
-- lifts it for the CAC number and product, and the office starts again.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0011', true);
select set_config('hid.test.employee', identity.submit_self_service_organization_application('migrate', 'clinic',
  'RC9900070009', 'Employee', 'employee@office.invalid', encode(sha256('office-network'::bytea), 'hex'))::text, true);
reset role;
select set_config('hid.test.employee_version', (select row_version::text from identity.organization_applications
  where id = current_setting('hid.test.employee')::uuid), true);
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:open:facility-reviewer', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select set_config('hid.test.employee_version', row_version::text, true)
  from identity.admin_reject_self_service_application(current_setting('hid.test.employee')::uuid,
  current_setting('hid.test.employee_version')::bigint, 'Not authorised by the company');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.purpose_of_use', '', true);
do $$ begin
  perform identity.submit_self_service_organization_application('migrate', 'clinic', 'RC9900070009',
    'Office Admin', 'admin@office.invalid', encode(sha256('office-network'::bytea), 'hex'));
  raise exception 'The refused office network opened the CAC';
exception when check_violation then
  if sqlerrm <> 'This organization application requires manual resolution' then raise; end if;
end $$;
select set_config('app.correlation_id', 'self-service-open-0012', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare refused record; waived record; version bigint := current_setting('hid.test.employee_version')::bigint;
begin
  perform set_config('app.actor_subject', 'synthetic:open:identity-reviewer', true);
  begin
    perform identity.admin_waive_self_service_refusals('RC9900070009', 'migrate', 'The company confirmed the office');
    raise exception 'An identity reviewer waived a refusal';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
  end;
  perform set_config('app.actor_subject', 'synthetic:open:facility-reviewer', true);
  for refused in select * from (values
      (1, 'RC99', 'migrate', 'The company confirmed the office', '22023'),
      (2, 'RC9900070009', 'dental', 'The company confirmed the office', '22023'),
      (3, 'RC9900070009', null, 'The company confirmed the office', '22023'),
      (4, 'RC9900070009', 'migrate', ' short ', '22023'),
      (5, 'RC9900070009', 'ehr', 'The company confirmed the office', 'P0002'),
      (6, 'RC9900070010', 'migrate', 'The company confirmed the office', 'P0002')
    ) as rows(n, cac, product, reason, expected) order by n loop
    begin
      perform identity.admin_waive_self_service_refusals(refused.cac, refused.product, refused.reason);
      raise exception 'Waiver refusal % was accepted', refused.n;
    exception when others then
      if sqlstate <> refused.expected then
        raise exception 'Waiver refusal % raised % (%) instead of %', refused.n, sqlstate, sqlerrm, refused.expected;
      end if;
    end;
  end loop;
  select * into waived from identity.admin_waive_self_service_refusals(' rc 9900070009 ', 'migrate',
    '  The company confirmed the office network  ');
  if waived.application_id <> current_setting('hid.test.employee')::uuid or waived.waived_at is null
     or waived.row_version <> version + 1 then
    raise exception 'The waiver did not return the waived application: %', row_to_json(waived);
  end if;
  begin
    perform identity.admin_waive_self_service_refusals('RC9900070009', 'migrate', 'The company confirmed again');
    raise exception 'A waived refusal was waived again';
  exception when no_data_found then
    if sqlerrm <> 'SELF_SERVICE_REFUSAL_NOT_FOUND' then raise; end if;
  end;
  perform set_config('app.actor_subject', 'system:auth', true);
  perform set_config('app.purpose_of_use', '', true);
  perform identity.submit_self_service_organization_application('migrate', 'clinic', 'RC9900070009',
    'Office Admin', 'admin@office.invalid', encode(sha256('office-network'::bytea), 'hex'));
end $$;
reset role;
do $$
declare event record;
begin
  if (select self_service_refusal_ends_at from identity.organization_applications
       where id = current_setting('hid.test.employee')::uuid) is not null then
    raise exception 'The waiver did not lift the refusal';
  end if;
  select * into event from audit.events where action = 'admin.self-service-application.refusal-waive';
  if (select count(*) from audit.events where action = 'admin.self-service-application.refusal-waive') <> 1
     or event.actor_type <> 'platform' or event.actor_account_id <> 'c8c00000-0000-4000-8000-000000000003'
     or event.facility_id is not null or event.organization_id is not null
     or event.reason <> 'The company confirmed the office network'
     or event.resource_uuid <> current_setting('hid.test.employee')::uuid
     or event.correlation_id <> 'self-service-open-0012'
     or event.details::text ~ 'RC9900070009|office\.invalid' then
    raise exception 'The waiver audit row is wrong: %', row_to_json(event);
  end if;
end $$;

-- 6. R16: 210 stale applications with made-up CAC numbers, older than any
-- other, and a stale verified one, cannot hide a live, verified squat on a
-- real CAC number; every application holding a CAC comes before every stale
-- one, verified or not.
insert into identity.organization_applications (product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, approval_mode, verification_result,
  created_at)
select 'ehr', 'Pending CAC verification', 'clinic', 'RC88' || lpad(n::text, 8, '0'), 'Junk Admin',
  'junk' || n || '@junk.invalid', 'self_service', 'not_verified', clock_timestamp() - interval '9 days' + n * interval '1 minute'
  from generate_series(1, 210) n;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0013', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare squat uuid; current_application record;
begin
  squat := identity.submit_self_service_organization_application('laboratory', 'laboratory', 'RC9900070011',
    'Live Squatter', 'live.squatter@open.invalid', encode(sha256('live-squat-network'::bytea), 'hex'));
  select * into current_application from identity.public_get_organization_application(
    'RC9900070011', 'live.squatter@open.invalid', 'laboratory');
  perform identity.public_record_organization_cac_result(squat, current_application.row_version,
    'verified', '9900070011', 'RC9900070011', 'Live Laboratory Ltd',
    'Private Company Limited by Shares', '2016-01-11', '11 Open Road, Lagos', 'active');
  perform set_config('hid.test.live_squat', squat::text, true);
  squat := identity.submit_self_service_organization_application('ehr', 'clinic', 'RC9900070013',
    'Stale Admin', 'stale@open.invalid', encode(sha256('stale-network'::bytea), 'hex'));
  select * into current_application from identity.public_get_organization_application(
    'RC9900070013', 'stale@open.invalid', 'ehr');
  perform identity.public_record_organization_cac_result(squat, current_application.row_version,
    'verified', '9900070013', 'RC9900070013', 'Stale Verified Ltd',
    'Private Company Limited by Shares', '2016-01-13', '13 Open Road, Lagos', 'active');
  perform set_config('hid.test.stale_verified', squat::text, true);
end $$;
reset role;
update identity.organization_applications set created_at = created_at - interval '2 hours'
 where id = current_setting('hid.test.live_squat')::uuid;
update identity.organization_applications set created_at = created_at - interval '3 days'
 where id = current_setting('hid.test.stale_verified')::uuid;
select set_config('hid.test.open_rows', (select count(*)::text from identity.organization_applications
  where approval_mode = 'self_service' and status in ('pending_verification', 'ready_for_review')), true);
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:open:identity-reviewer', true),
  set_config('app.correlation_id', 'self-service-open-0014', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare
  listed record; shown bigint; first_stale integer; last_holding integer;
  open_rows bigint := current_setting('hid.test.open_rows')::bigint;
begin
  select count(*), min(ordinality) filter (where not item.holds_cac), max(ordinality) filter (where item.holds_cac)
    into shown, first_stale, last_holding
    from identity.admin_list_open_self_service_applications() with ordinality item;
  select * into listed from identity.admin_list_open_self_service_applications() with ordinality item
   where ordinality = 1;
  if shown <> 200 or open_rows <= 200 or listed.application_id <> current_setting('hid.test.live_squat')::uuid
     or not listed.holds_cac or listed.total_count <> open_rows or last_holding > first_stale then
    raise exception 'The live squat is not first, or the list is not ranked or counted: % shown, % open, first %',
      shown, open_rows, row_to_json(listed);
  end if;
  select count(*) into shown from identity.admin_list_open_self_service_applications(' rc9900070011 ') item
   where item.application_id = current_setting('hid.test.live_squat')::uuid and item.total_count = 1;
  if shown <> 1 or exists (select 1 from identity.admin_list_open_self_service_applications('RC9900070011') item
                            where item.application_id <> current_setting('hid.test.live_squat')::uuid) then
    raise exception 'The CAC number search did not find exactly the live squat';
  end if;
  if exists (select 1 from identity.admin_list_open_self_service_applications('RC9900070012')) then
    raise exception 'The CAC number search listed another CAC number';
  end if;
  begin
    perform identity.admin_list_open_self_service_applications('RC12');
    raise exception 'A malformed CAC number search was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'SELF_SERVICE_APPLICATION_FILTER_INVALID' then raise; end if;
  end;
end $$;
reset role;

-- 7. No network, and a malformed one.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-open-0015', true),
  set_config('app.purpose_of_use', '', true);
do $$
begin
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
