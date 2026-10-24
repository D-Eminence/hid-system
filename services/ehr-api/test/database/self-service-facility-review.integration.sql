\set ON_ERROR_STOP on
-- Support's review of self-signed-up facilities (0086, section 4; owner
-- decision of 2026-10-24, "alert + daily review"). Rollback-only. Every
-- command runs as the exact Identity API runtime role.
--
--   1. identity.admin_list_self_service_facilities lists one row per
--      activated self-service application (approved by the activation
--      command, with no human reviewer), newest activation first, at most 200,
--      filtered by 'unreviewed', 'reviewed' or 'all', with the CAC masked as
--      the governed application list masks it and the facility's and
--      account's current status; pending, lapsed, governed and
--      administrator-approved applications are not listed;
--   2. identity.admin_review_self_service_facility records the review once,
--      at the expected version, and audits it as the platform administrator;
--      its refusals: 22023 (note or arguments), P0002 (not an activated
--      self-service application), 23505 (already reviewed, checked before the
--      version), 40001 (version conflict);
--   3. both work for a standalone platform administrator without any facility
--      membership, as Identity's administrators sign in (and for one with a
--      facility selected, still audited without it), and refuse an
--      account without the permission (42501): listing needs
--      platform.identity-review.read, reviewing platform.facility.manage and
--      platform.admin.access, both a correlation ID and the
--      healthcare-operations purpose of use;
--   4. only the Identity runtimes may execute them;
--   5. the review columns are all set together and only on an approved
--      self-service application;
--   6. suspending the facility and disabling the account with the existing
--      commands shows in the list.
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

insert into auth.accounts (id, subject, email, display_name, status) values
  ('c8700000-0000-4000-8000-000000000001', 'synthetic:ssr:super', 'super@ssr.invalid', 'Standalone Super Admin', 'active'),
  ('c8700000-0000-4000-8000-000000000002', 'synthetic:ssr:identity-reviewer', 'identity-reviewer@ssr.invalid', 'Identity Reviewer', 'active'),
  ('c8700000-0000-4000-8000-000000000003', 'synthetic:ssr:facility-reviewer', 'facility-reviewer@ssr.invalid', 'Facility Reviewer', 'active'),
  ('c8700000-0000-4000-8000-000000000004', 'synthetic:ssr:auditor', 'auditor@ssr.invalid', 'Security Auditor', 'active'),
  ('c8700000-0000-4000-8000-000000000005', 'synthetic:ssr:disabled', 'disabled@ssr.invalid', 'Disabled Super Admin', 'disabled');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c8710000-0000-4000-8000-000000000001', 'c8700000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform', 'Review suite standalone super admin'),
  ('c8710000-0000-4000-8000-000000000002', 'c8700000-0000-4000-8000-000000000002', 'identity_review_admin', 'platform', 'Review suite identity reviewer'),
  ('c8710000-0000-4000-8000-000000000003', 'c8700000-0000-4000-8000-000000000003', 'facility_review_admin', 'platform', 'Review suite facility reviewer'),
  ('c8710000-0000-4000-8000-000000000004', 'c8700000-0000-4000-8000-000000000004', 'security_auditor', 'platform', 'Review suite auditor'),
  ('c8710000-0000-4000-8000-000000000005', 'c8700000-0000-4000-8000-000000000005', 'platform_super_admin', 'platform', 'Review suite disabled admin');
do $$ begin
  if exists (select 1 from identity.staff_facility_memberships membership
              where membership.account_id = 'c8700000-0000-4000-8000-000000000001') then
    raise exception 'The standalone administrator fixture has a facility membership';
  end if;
end $$;

-- An organization that hosts the applications approved outside self-service.
insert into identity.organizations (id, name, slug)
values ('c8720000-0000-4000-8000-000000000001', 'Review Suite Governed Org', 'review-suite-governed-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
values ('c8730000-0000-4000-8000-000000000001', 'c8720000-0000-4000-8000-000000000001',
  'Review Suite Governed Facility', 'REVIEW-GOVERNED', 'Africa/Lagos', true, 'verified');

-- 0. Two facilities sign themselves up through the real commands.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:ssr:super', true),
  set_config('app.correlation_id', 'self-service-review-open', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Review suite opens facility sign-up');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-review-signup', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  signup record;
  application_id uuid;
  current_application record;
  activated record;
  challenge_id uuid;
  code_hmac char(64);
  session_hmac char(64);
begin
  for signup in select * from (values
      (1, 'ehr', 'hospital', 'RC9900064001', 'Ada Hospital Admin', 'ada.admin@hospital.invalid', 'Ada Hospital Ltd'),
      (2, 'pharmacy', 'pharmacy', 'BN9900064002', 'Bola Pharmacy Admin', 'bola.admin@pharmacy.invalid', 'Bola Pharmacy Ltd')
    ) as rows(n, product, kind, cac, admin_name, admin_email, legal_name) order by n loop
    application_id := identity.submit_self_service_organization_application(signup.product, signup.kind,
      signup.cac, signup.admin_name, signup.admin_email);
    select * into current_application from identity.public_get_organization_application(
      signup.cac, signup.admin_email, signup.product);
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', '99000640' || signup.n, signup.cac, signup.legal_name,
      'Private Company Limited by Shares', '2020-03-0' || signup.n, signup.n || ' Review Suite Road, Lagos', 'active');
    challenge_id := ('c8790000-0000-4000-8000-00000000000' || signup.n)::uuid;
    code_hmac := encode(sha256(('review-suite-otp-' || signup.n)::bytea), 'hex');
    session_hmac := encode(sha256(('review-suite-session-' || signup.n)::bytea), 'hex');
    perform identity.begin_organization_profile_completion(signup.cac, signup.admin_email,
      signup.product, challenge_id, code_hmac);
    if not identity.verify_organization_profile_completion_challenge(challenge_id, code_hmac, session_hmac) then
      raise exception 'Review suite sign-up % was not verified', signup.n;
    end if;
    select * into activated from identity.activate_self_service_provider_enrollment(session_hmac,
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    perform set_config('hid.test.ssr_application_' || signup.n, application_id::text, true);
    perform set_config('hid.test.ssr_facility_' || signup.n, activated.facility_id::text, true);
    perform set_config('hid.test.ssr_account_' || signup.n, activated.account_id::text, true);
    perform set_config('hid.test.ssr_organization_' || signup.n, activated.organization_id::text, true);
  end loop;
  -- A self-service application that is still pending.
  perform set_config('hid.test.ssr_pending', identity.submit_self_service_organization_application(
    'ehr', 'clinic', 'RC9900064003', 'Pending Admin', 'pending.admin@clinic.invalid')::text, true);
end $$;
reset role;

-- Applications that are not activated self-service facilities: approved
-- through governed review, a self-service row an administrator approved by
-- hand (it names the reviewer), and a lapsed self-service row.
insert into identity.organization_applications (
  id, product_code, organization_name, organization_type, cac_registration_number,
  administrator_name, administrator_email, status, verification_result, verified_at,
  verified_organization_name, organization_id, facility_id, reviewed_by_account_id,
  review_reason, reviewed_at, approval_mode
) values
  ('c8740000-0000-4000-8000-000000000004', 'ehr', 'Governed Approved Clinic', 'clinic', 'RC9900064004',
   'Governed Admin', 'governed.admin@clinic.invalid', 'approved', 'verified', now(),
   'Governed Approved Clinic Ltd', 'c8720000-0000-4000-8000-000000000001', 'c8730000-0000-4000-8000-000000000001',
   'c8700000-0000-4000-8000-000000000001', 'Reviewed by the governed path', now(), 'admin_review'),
  ('c8740000-0000-4000-8000-000000000005', 'migrate', 'Hand Approved Clinic', 'clinic', 'RC9900064005',
   'Hand Admin', 'hand.admin@clinic.invalid', 'approved', 'verified', now(),
   'Hand Approved Clinic Ltd', 'c8720000-0000-4000-8000-000000000001', 'c8730000-0000-4000-8000-000000000001',
   'c8700000-0000-4000-8000-000000000001', 'Approved by an administrator by hand', now(), 'self_service');
insert into identity.organization_applications (
  id, product_code, organization_name, organization_type, cac_registration_number,
  administrator_name, administrator_email, status, review_reason, reviewed_at, approval_mode
) values ('c8740000-0000-4000-8000-000000000006', 'laboratory', 'Pending CAC verification', 'laboratory',
  'RC9900064006', 'Lapsed Admin', 'lapsed.admin@lab.invalid', 'rejected',
  'Self-service application lapsed: not activated within 24 hours of submission', now(), 'self_service');

-- 1. The list, as a standalone platform administrator.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:ssr:super', true),
  set_config('app.correlation_id', 'self-service-review-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare
  listed uuid[];
  first_row record;
  first_application uuid := current_setting('hid.test.ssr_application_1')::uuid;
  second_application uuid := current_setting('hid.test.ssr_application_2')::uuid;
begin
  select array_agg(item.application_id order by ordinality) into listed
    from identity.admin_list_self_service_facilities('unreviewed') with ordinality item;
  if listed is distinct from array[second_application, first_application] then
    raise exception 'The unreviewed list is not the two activated facilities, newest first: %', listed;
  end if;
  if (select array_agg(item.application_id order by ordinality)
        from identity.admin_list_self_service_facilities('all') with ordinality item) is distinct from listed
     or exists (select 1 from identity.admin_list_self_service_facilities('reviewed')) then
    raise exception 'The all and reviewed lists are wrong before any review';
  end if;
  select * into first_row from identity.admin_list_self_service_facilities('all') item
   where item.application_id = first_application;
  if first_row.organization_id is distinct from current_setting('hid.test.ssr_organization_1')::uuid
     or first_row.organization_name is distinct from 'Ada Hospital Ltd'
     or first_row.facility_id is distinct from current_setting('hid.test.ssr_facility_1')::uuid
     or first_row.facility_name is distinct from 'Ada Hospital Ltd'
     or first_row.facility_lifecycle_status is distinct from 'verified'
     or first_row.product_code is distinct from 'ehr'
     or first_row.organization_type is distinct from 'hospital'
     or first_row.cac_hint is distinct from 'RC********01'
     or first_row.administrator_name is distinct from 'Ada Hospital Admin'
     or first_row.administrator_email is distinct from 'ada.admin@hospital.invalid'
     or first_row.administrator_account_id is distinct from current_setting('hid.test.ssr_account_1')::uuid
     or first_row.administrator_account_status is distinct from 'active'
     or first_row.activated_at is null
     or first_row.row_version is null
     or first_row.reviewed_at is not null or first_row.reviewed_by_account_id is not null
     or first_row.review_note is not null then
    raise exception 'The listed facility is wrong: %', row_to_json(first_row);
  end if;
  perform set_config('hid.test.ssr_activated_1', first_row.activated_at::text, true);
  begin
    perform identity.admin_list_self_service_facilities('pending');
    raise exception 'An unknown list state was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'SELF_SERVICE_FACILITY_STATE_INVALID' then raise; end if;
  end;
  begin
    perform identity.admin_list_self_service_facilities(null);
    raise exception 'A missing list state was accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;
do $$ begin
  -- activated_at is the time the activation command approved the application.
  if not exists (select 1 from identity.organization_applications application
                  where application.id = current_setting('hid.test.ssr_application_1')::uuid
                    and application.reviewed_at = current_setting('hid.test.ssr_activated_1')::timestamptz) then
    raise exception 'activated_at is not the activation time';
  end if;
end $$;

-- 2. The review command's refusals, then one review.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:ssr:super', true),
  set_config('app.correlation_id', 'self-service-review-0002', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare
  first_application uuid := current_setting('hid.test.ssr_application_1')::uuid;
  current_version bigint;
  result record;
  refused record;
begin
  select item.row_version into current_version from identity.admin_list_self_service_facilities('all') item
   where item.application_id = first_application;
  for refused in select * from (values
      (1, first_application, current_version, '  short  ', '22023'),
      (2, first_application, current_version, repeat('x', 501), '22023'),
      (3, first_application, null::bigint, 'A sufficient note', '22023'),
      (4, null::uuid, current_version, 'A sufficient note', '22023'),
      (5, 'c8740000-0000-4000-8000-0000000000ff'::uuid, 1::bigint, 'A sufficient note', 'P0002'),
      (6, current_setting('hid.test.ssr_pending')::uuid, 1::bigint, 'A sufficient note', 'P0002'),
      (7, 'c8740000-0000-4000-8000-000000000004'::uuid, 1::bigint, 'A sufficient note', 'P0002'),
      (8, 'c8740000-0000-4000-8000-000000000005'::uuid, 1::bigint, 'A sufficient note', 'P0002'),
      (9, 'c8740000-0000-4000-8000-000000000006'::uuid, 1::bigint, 'A sufficient note', 'P0002'),
      (10, first_application, current_version - 1, 'A sufficient note', '40001')
    ) as rows(n, target, version, note, expected) order by n loop
    begin
      perform identity.admin_review_self_service_facility(refused.target, refused.version, refused.note);
      raise exception 'Refusal case % was accepted', refused.n;
    exception when others then
      if sqlstate <> refused.expected then
        raise exception 'Refusal case % raised % (%) instead of %', refused.n, sqlstate, sqlerrm, refused.expected;
      end if;
    end;
  end loop;

  select * into result from identity.admin_review_self_service_facility(first_application, current_version,
    '  Checked the email domain against the company  ');
  if result.application_id is distinct from first_application or result.reviewed_at is null
     or result.row_version <> current_version + 1 then
    raise exception 'The review did not return the new version: %', row_to_json(result);
  end if;
  perform set_config('hid.test.ssr_reviewed_version', result.row_version::text, true);

  -- Already reviewed: 23505 at the current version and at the stale one.
  begin
    perform identity.admin_review_self_service_facility(first_application, result.row_version, 'A second review note');
    raise exception 'A reviewed facility was reviewed again';
  exception when unique_violation then
    if sqlerrm <> 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED' then raise; end if;
  end;
  begin
    perform identity.admin_review_self_service_facility(first_application, current_version, 'A stale second review');
    raise exception 'A reviewed facility was reviewed again at a stale version';
  exception when unique_violation then null;
  end;

  if (select array_agg(item.application_id) from identity.admin_list_self_service_facilities('reviewed') item)
       is distinct from array[first_application]
     or (select array_agg(item.application_id) from identity.admin_list_self_service_facilities('unreviewed') item)
       is distinct from array[current_setting('hid.test.ssr_application_2')::uuid]
     or not exists (select 1 from identity.admin_list_self_service_facilities('reviewed') item
                     where item.review_note = 'Checked the email domain against the company'
                       and item.reviewed_by_account_id = 'c8700000-0000-4000-8000-000000000001'
                       and item.reviewed_at = result.reviewed_at
                       and item.row_version = result.row_version) then
    raise exception 'The lists do not show the review';
  end if;
end $$;
reset role;

do $$
declare event record;
begin
  if (select count(*) from audit.events where action = 'admin.self-service-facility.review') <> 1 then
    raise exception 'The review was not audited exactly once';
  end if;
  select * into event from audit.events where action = 'admin.self-service-facility.review';
  if event.actor_type <> 'platform' or event.actor_subject <> 'synthetic:ssr:super'
     or event.actor_account_id <> 'c8700000-0000-4000-8000-000000000001'
     or event.actor_membership_id is not null or event.facility_id is not null or event.organization_id is not null
     or event.outcome <> 'success' or event.purpose_of_use <> 'healthcare-operations'
     or event.correlation_id <> 'self-service-review-0002'
     or event.resource_type <> 'organization-application'
     or event.resource_uuid <> current_setting('hid.test.ssr_application_1')::uuid
     or event.reason <> 'Checked the email domain against the company'
     or event.details ->> 'facilityId' <> current_setting('hid.test.ssr_facility_1')
     or event.details ->> 'organizationId' <> current_setting('hid.test.ssr_organization_1')
     or event.details ->> 'administratorAccountId' <> current_setting('hid.test.ssr_account_1')
     or (event.details ->> 'version')::bigint <> current_setting('hid.test.ssr_reviewed_version')::bigint
     or event.details::text ~ 'RC9900064001|hospital\.invalid' then
    raise exception 'The review audit row is wrong: %', row_to_json(event);
  end if;
  if not exists (select 1 from identity.organization_applications application
                  where application.id = current_setting('hid.test.ssr_application_1')::uuid
                    and application.status = 'approved' and application.reviewed_by_account_id is null
                    and application.review_reason = 'Automated CAC and administrator-email verification'
                    and application.self_service_reviewed_by_account_id = 'c8700000-0000-4000-8000-000000000001') then
    raise exception 'The review changed the activation''s own review fields';
  end if;
end $$;

-- 3. Permission and context.
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'self-service-review-0003', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare
  second_application uuid := current_setting('hid.test.ssr_application_2')::uuid;
  second_version bigint;
  attempt record;
  result record;
begin
  perform set_config('app.actor_subject', 'synthetic:ssr:super', true);
  select item.row_version into second_version from identity.admin_list_self_service_facilities('all') item
   where item.application_id = second_application;
  for attempt in select * from (values
      (1, 'synthetic:ssr:auditor', 'list', 'healthcare-operations', 'self-service-review-0003'),
      (2, 'synthetic:ssr:auditor', 'review', 'healthcare-operations', 'self-service-review-0003'),
      (3, 'synthetic:ssr:identity-reviewer', 'review', 'healthcare-operations', 'self-service-review-0003'),
      (4, 'synthetic:ssr:facility-reviewer', 'list', 'healthcare-operations', 'self-service-review-0003'),
      (5, 'synthetic:ssr:disabled', 'list', 'healthcare-operations', 'self-service-review-0003'),
      (6, 'synthetic:ssr:disabled', 'review', 'healthcare-operations', 'self-service-review-0003'),
      (7, 'synthetic:ssr:super', 'list', '', 'self-service-review-0003'),
      (8, 'synthetic:ssr:super', 'review', 'direct-care', 'self-service-review-0003'),
      (9, 'synthetic:ssr:super', 'list', 'healthcare-operations', ''),
      (10, 'synthetic:ssr:super', 'review', 'healthcare-operations', ''),
      (11, 'system:auth', 'list', 'healthcare-operations', 'self-service-review-0003'),
      (12, 'system:auth', 'review', 'healthcare-operations', 'self-service-review-0003'),
      (13, '', 'list', 'healthcare-operations', 'self-service-review-0003')
    ) as rows(n, subject, command, purpose, correlation) order by n loop
    perform set_config('app.actor_subject', attempt.subject, true);
    perform set_config('app.purpose_of_use', attempt.purpose, true);
    perform set_config('app.correlation_id', attempt.correlation, true);
    begin
      if attempt.command = 'list' then
        perform identity.admin_list_self_service_facilities('all');
      else
        perform identity.admin_review_self_service_facility(second_application, second_version,
          'Unauthorized review attempt');
      end if;
      raise exception 'Permission case % was accepted', attempt.n;
    exception when insufficient_privilege then
      if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
    end;
  end loop;
  perform set_config('app.correlation_id', 'self-service-review-0004', true);
  perform set_config('app.purpose_of_use', 'healthcare-operations', true);
  -- An identity reviewer lists; a facility reviewer reviews.
  perform set_config('app.actor_subject', 'synthetic:ssr:identity-reviewer', true);
  if (select count(*) from identity.admin_list_self_service_facilities('all')) <> 2 then
    raise exception 'An identity reviewer could not list the facilities';
  end if;
  perform set_config('app.actor_subject', 'synthetic:ssr:facility-reviewer', true);
  select * into result from identity.admin_review_self_service_facility(second_application, second_version,
    'Facility reviewer checked the pharmacy licence');
  if result.row_version <> second_version + 1 then
    raise exception 'A facility reviewer could not review: %', row_to_json(result);
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from audit.events where action = 'admin.self-service-facility.review') <> 2
     or exists (select 1 from audit.events where correlation_id = 'self-service-review-0003')
     or not exists (select 1 from audit.events where action = 'admin.self-service-facility.review'
                     and actor_subject = 'synthetic:ssr:facility-reviewer' and actor_type = 'platform') then
    raise exception 'A refused review wrote an audit row, or the facility reviewer''s review was not audited';
  end if;
end $$;

-- 4. Grants: the Identity runtimes only.
do $$
declare runtime_role text; signature text;
begin
  foreach signature in array array['identity.admin_list_self_service_facilities(text)',
      'identity.admin_review_self_service_facility(uuid,bigint,text)'] loop
    foreach runtime_role in array array['hid_identity_runtime', 'hid_identity_api_runtime'] loop
      if not has_function_privilege(runtime_role, signature, 'EXECUTE') then
        raise exception '% cannot execute %', runtime_role, signature;
      end if;
    end loop;
    foreach runtime_role in array array['hid_schema_test_runtime', 'hid_ehr_runtime', 'hid_ehr_api_runtime',
        'hid_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime',
        'hid_ocr_api_runtime', 'hid_notification_api_runtime'] loop
      if has_function_privilege(runtime_role, signature, 'EXECUTE') then
        raise exception '% can execute %', runtime_role, signature;
      end if;
    end loop;
    if exists (select 1 from pg_proc proc,
                 lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                where proc.oid = signature::regprocedure and acl.grantee = 0) then
      raise exception 'PUBLIC can execute %', signature;
    end if;
  end loop;
end $$;

-- 5. The review columns are set together, only on an approved self-service application.
do $$
declare violated text; attempt integer;
begin
  for attempt in 1..4 loop
    begin
      if attempt = 1 then
        update identity.organization_applications set self_service_reviewed_at = now(),
          self_service_reviewed_by_account_id = 'c8700000-0000-4000-8000-000000000001',
          self_service_review_note = 'A review of a pending row'
         where id = current_setting('hid.test.ssr_pending')::uuid;
      elsif attempt = 2 then
        update identity.organization_applications set self_service_reviewed_at = now(),
          self_service_reviewed_by_account_id = 'c8700000-0000-4000-8000-000000000001',
          self_service_review_note = 'A review of a governed row'
         where id = 'c8740000-0000-4000-8000-000000000004';
      elsif attempt = 3 then
        update identity.organization_applications set self_service_review_note = null
         where id = current_setting('hid.test.ssr_application_1')::uuid;
      else
        update identity.organization_applications set self_service_review_note = '7 chars'
         where id = current_setting('hid.test.ssr_application_1')::uuid;
      end if;
      raise exception 'Review column case % was admitted', attempt;
    exception when check_violation then
      get stacked diagnostics violated = constraint_name;
      if violated <> 'organization_applications_self_service_review_ck' then
        raise exception 'Review column case % violated % instead', attempt, violated;
      end if;
    end;
  end loop;
end $$;

-- 6. Support's playbook: the existing commands suspend the facility and
-- disable the account, and the list shows both.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:ssr:super', true),
  set_config('app.correlation_id', 'self-service-review-0005', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare listed record;
begin
  perform identity.admin_transition_facility(current_setting('hid.test.ssr_facility_1')::uuid,
    1, 'suspended', 'Self sign-up did not match the company', 'review-suite-suspend-0001', repeat('a', 64));
  perform auth.admin_transition_account(current_setting('hid.test.ssr_account_1')::uuid,
    1, 'disabled', 'Self sign-up did not match the company', 'review-suite-disable-0001', repeat('b', 64));
  select * into listed from identity.admin_list_self_service_facilities('reviewed') item
   where item.application_id = current_setting('hid.test.ssr_application_1')::uuid;
  if listed.facility_lifecycle_status is distinct from 'suspended'
     or listed.administrator_account_status is distinct from 'disabled' then
    raise exception 'The list does not show the suspended facility and disabled account: %', row_to_json(listed);
  end if;
end $$;
reset role;

-- 1 (limit). At most 200 rows, newest activation first.
insert into identity.organizations (id, name, slug)
select ('c8750000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Bulk Org ' || n, 'bulk-org-' || n
  from generate_series(1, 205) n;
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
select ('c8760000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('c8750000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Bulk Facility ' || n, 'BULK-' || n,
  'Africa/Lagos', true, 'verified'
  from generate_series(1, 205) n;
insert into identity.organization_applications (
  id, product_code, organization_name, organization_type, cac_registration_number,
  administrator_name, administrator_email, status, verification_result, verified_at,
  verified_organization_name, organization_id, facility_id, review_reason, reviewed_at, approval_mode
)
select ('c8770000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'ehr', 'Bulk Org ' || n, 'clinic',
  'RC99000650' || lpad(n::text, 3, '0'), 'Bulk Admin ' || n, 'bulk-' || n || '@bulk.invalid',
  'approved', 'verified', now(), 'Bulk Org ' || n || ' Ltd',
  ('c8750000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('c8760000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'Automated CAC and administrator-email verification', now() + n * interval '1 minute', 'self_service'
  from generate_series(1, 205) n;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:ssr:super', true),
  set_config('app.correlation_id', 'self-service-review-0006', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare listed uuid[];
begin
  select array_agg(item.application_id order by ordinality) into listed
    from identity.admin_list_self_service_facilities('all') with ordinality item;
  if cardinality(listed) <> 200
     or listed[1] <> 'c8770000-0000-4000-8000-000000000205'
     or listed[200] <> 'c8770000-0000-4000-8000-000000000006' then
    raise exception 'The list is not the newest 200 activations: % rows, first %, last %',
      cardinality(listed), listed[1], listed[200];
  end if;
  if (select count(*) from identity.admin_list_self_service_facilities('unreviewed')) <> 200
     or (select count(*) from identity.admin_list_self_service_facilities('reviewed')) <> 2 then
    raise exception 'The state filters do not apply before the limit';
  end if;
end $$;
reset role;

-- An administrator signed in with a facility selected works the same way, and
-- the review is still audited as platform administration, without the facility.
insert into auth.accounts (id, subject, email, display_name, status)
values ('c8700000-0000-4000-8000-000000000006', 'synthetic:ssr:member-admin', 'member-admin@ssr.invalid',
  'Member Super Admin', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
values ('c8780000-0000-4000-8000-000000000006', 'c8700000-0000-4000-8000-000000000006', 'Member Super Admin',
  'member-admin@ssr.invalid', 'verified', 'admin');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('c8790000-0000-4000-8000-000000000106', 'c8780000-0000-4000-8000-000000000006',
  'c8700000-0000-4000-8000-000000000006', 'c8720000-0000-4000-8000-000000000001',
  'c8730000-0000-4000-8000-000000000001', 'admin', 'admin', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
values ('c8710000-0000-4000-8000-000000000006', 'c8700000-0000-4000-8000-000000000006',
  'platform_super_admin', 'platform', 'Review suite member super admin');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:ssr:member-admin', true),
  set_config('app.facility_id', 'c8730000-0000-4000-8000-000000000001', true),
  set_config('app.membership_id', 'c8790000-0000-4000-8000-000000000106', true),
  set_config('app.correlation_id', 'self-service-review-0007', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare result record;
begin
  if (select count(*) from identity.admin_list_self_service_facilities('all')) <> 200 then
    raise exception 'An administrator with a facility selected could not list';
  end if;
  select * into result from identity.admin_review_self_service_facility(
    'c8770000-0000-4000-8000-000000000001', 1, 'Reviewed with a facility selected');
  if result.row_version <> 2 then
    raise exception 'An administrator with a facility selected could not review: %', row_to_json(result);
  end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from audit.events where correlation_id = 'self-service-review-0007'
                  and action = 'admin.self-service-facility.review' and actor_type = 'platform'
                  and facility_id is null and actor_membership_id is null and organization_id is null
                  and actor_account_id = 'c8700000-0000-4000-8000-000000000006') then
    raise exception 'The review with a facility selected was not audited as platform administration';
  end if;
end $$;

rollback;
