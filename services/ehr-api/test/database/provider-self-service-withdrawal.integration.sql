\set ON_ERROR_STOP on
-- Facility self sign-up: the applicant withdraws its own open application
-- (0086, P4b, the port register's R18, "This isn't my organization").
-- Rollback-only. Every command runs as the exact Identity API runtime role in
-- Identity's accountless system context.
--
--   1. identity.withdraw_self_service_provider_enrollment raises 42501 for a
--      context other than Identity's accountless one, no correlation id, or a
--      session digest that is not 64 lowercase hex characters;
--   2. it answers 'session_invalid' and changes nothing for no live session
--      (unknown, expired or already ended), and for a live session whose
--      application is no longer open (closed, activated or governed) it
--      answers 'session_invalid' and ends that session;
--   3. a closed control raises 55000 PLATFORM_CONTROL_DISABLED even for a
--      live session, and nothing changes;
--   4. 'withdrawn' closes the application (rejected, no reviewer, the
--      applicant's reason, no refusal, its version bumped), ends every code
--      and session of it, and is audited
--      identity.organization.self-service.withdraw as a system event whose
--      details carry no email, name or network; the same session then
--      answers 'session_invalid', and the current-enrollment read no longer
--      finds it;
--   5. no 7-day refusal: the same email (and the same network) can open a
--      new application for the same CAC number and product at once, opened
--      without a hold; another email and network then lapse it at once and
--      get a hold; a withdrawal more than 7 days old no longer drops the hold;
--   6. the command is SECURITY DEFINER with a fixed search_path, executable by
--      the Identity runtime and the schema test runtime and not by PUBLIC.
-- See provider-self-enrollment.integration.sql for why FORCE is lifted on the
-- control table when its owner cannot bypass row-level security.
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
  ('d7a00000-0000-4000-8000-000000000001', 'synthetic:withdrawal:super', 'super@withdrawal.invalid', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d7a10000-0000-4000-8000-000000000001', 'd7a00000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', 'Withdrawal suite super admin');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:withdrawal:super', true),
  set_config('app.correlation_id', 'self-service-withdrawal-open', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Withdrawal suite opens facility sign-up');

-- Verified applications, each with a live completion session, opened through
-- the real commands: w (withdrawn), c (closed by support before the
-- withdrawal), a (activated), g (governed), x (control closed).
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-withdrawal-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  signup record;
  application_id uuid;
  current_application record;
begin
  for signup in select * from (values
      ('w', 'ehr', 'clinic', 'RC9900069001', 'Wrong Company Admin', 'mistyped@withdrawal.invalid', 'Somebody Else Ltd'),
      ('c', 'ehr', 'clinic', 'RC9900069002', 'Closed Admin', 'closed@withdrawal.invalid', 'Closed Withdrawal Ltd'),
      ('a', 'laboratory', 'laboratory', 'RC9900069003', 'Activated Admin', 'activated@withdrawal.invalid',
        'Activated Withdrawal Lab Ltd'),
      ('g', 'ehr', 'hospital', 'RC9900069004', 'Governed Admin', 'governed@withdrawal.invalid', 'Governed Withdrawal Ltd'),
      ('x', 'pharmacy', 'pharmacy', 'RC9900069005', 'Control Admin', 'control@withdrawal.invalid',
        'Control Withdrawal Pharmacy Ltd')
    ) as rows(label, product, kind, cac, admin_name, admin_email, legal_name) loop
    application_id := identity.submit_self_service_organization_application(signup.product, signup.kind,
      signup.cac, signup.admin_name, signup.admin_email, encode(sha256(('wd-network-' || signup.label)::bytea), 'hex'));
    select * into current_application from identity.public_get_organization_application(
      signup.cac, signup.admin_email, signup.product);
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', substr(signup.cac, 3), signup.cac, signup.legal_name,
      'Private Company Limited by Shares', '2019-03-01', '9 Withdrawal Road, Lagos', 'active');
    if identity.begin_self_service_provider_enrollment(signup.cac, signup.admin_email, signup.product,
         ('d7a9' || lpad(ascii(signup.label)::text, 4, '0') || '-0000-4000-8000-000000000001')::uuid,
         encode(sha256(('wd-otp-' || signup.label)::bytea), 'hex'), signup.admin_name, signup.kind)
       is distinct from signup.admin_email then
      raise exception 'No code for case %', signup.label;
    end if;
    if not identity.verify_organization_profile_completion_challenge(
        ('d7a9' || lpad(ascii(signup.label)::text, 4, '0') || '-0000-4000-8000-000000000001')::uuid,
        encode(sha256(('wd-otp-' || signup.label)::bytea), 'hex'),
        encode(sha256(('wd-session-' || signup.label)::bytea), 'hex')) then
      raise exception 'Case % did not verify', signup.label;
    end if;
    perform set_config('hid.test.app_' || signup.label, application_id::text, true);
  end loop;
end $$;
reset role;
-- Case w also has a second live session and an unused code; case g stands for
-- a governed application's completion session; case c is closed by support.
insert into identity.organization_profile_completion_challenges
  (id, application_id, code_hmac, expires_at, consumed_at, session_hmac, session_expires_at) values
  ('d7a90119-0000-4000-8000-000000000002', current_setting('hid.test.app_w')::uuid,
   encode(sha256('wd-otp-w2'::bytea), 'hex'), clock_timestamp() + interval '10 minutes', clock_timestamp(),
   encode(sha256('wd-session-w2'::bytea), 'hex'), clock_timestamp() + interval '1 hour'),
  ('d7a90119-0000-4000-8000-000000000004', current_setting('hid.test.app_w')::uuid,
   encode(sha256('wd-otp-w4'::bytea), 'hex'), clock_timestamp() + interval '10 minutes', clock_timestamp(),
   encode(sha256('wd-session-w4'::bytea), 'hex'), clock_timestamp() - interval '1 minute');
insert into identity.organization_profile_completion_challenges (id, application_id, code_hmac, expires_at) values
  ('d7a90119-0000-4000-8000-000000000003', current_setting('hid.test.app_w')::uuid,
   encode(sha256('wd-otp-w3'::bytea), 'hex'), clock_timestamp() + interval '10 minutes');
update identity.organization_applications set approval_mode = 'admin_review'
 where id = current_setting('hid.test.app_g')::uuid;
update identity.organization_applications
   set status = 'rejected', reviewed_at = clock_timestamp(),
       review_reason = 'Closed by support before the applicant withdrew', row_version = row_version + 1
 where id = current_setting('hid.test.app_c')::uuid;

-- 1. The context.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-withdrawal-0002', true);
do $$
declare
  session_w char(64) := encode(sha256('wd-session-w'::bytea), 'hex');
begin
  begin
    perform identity.withdraw_self_service_provider_enrollment(upper(session_w));
    raise exception 'An upper-case session digest was accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'Self-service enrollment context is required' then raise; end if;
  end;
  begin
    perform identity.withdraw_self_service_provider_enrollment(null);
    raise exception 'A null session digest was accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'Self-service enrollment context is required' then raise; end if;
  end;
  perform set_config('app.correlation_id', '', true);
  begin
    perform identity.withdraw_self_service_provider_enrollment(session_w);
    raise exception 'A withdrawal without a correlation id was accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'Self-service enrollment context is required' then raise; end if;
  end;
  perform set_config('app.correlation_id', 'self-service-withdrawal-0002', true);
end $$;
do $$
declare
  subject text;
begin
  foreach subject in array array['synthetic:withdrawal:super', 'system:notification', 'org-onboarding:x', ''] loop
    perform set_config('app.actor_subject', subject, true);
    begin
      perform identity.withdraw_self_service_provider_enrollment(encode(sha256('wd-session-w'::bytea), 'hex'));
      raise exception 'The actor % withdrew an application', subject;
    exception when insufficient_privilege then
      if sqlerrm <> 'Self-service enrollment context is required' then raise; end if;
    end;
  end loop;
  perform set_config('app.actor_subject', 'system:auth', true);
end $$;

-- 2. No live session, or a session whose application is no longer open.
reset role;
create temporary table withdrawal_before on commit drop as
  select application.id, application.status, application.row_version, application.reviewed_at
    from identity.organization_applications application
   where application.cac_registration_number like 'RC99000690%';
create temporary table withdrawal_challenges_before on commit drop as
  select challenge.id, challenge.invalidated_at
    from identity.organization_profile_completion_challenges challenge
    join identity.organization_applications application on application.id = challenge.application_id
   where application.cac_registration_number like 'RC99000690%';
grant select on withdrawal_before, withdrawal_challenges_before to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-withdrawal-0003', true);
do $$ begin
  if identity.withdraw_self_service_provider_enrollment(repeat('f', 64)) <> 'session_invalid' then
    raise exception 'An unknown session was not refused as invalid';
  end if;
  -- The expired second session of case w.
  if identity.withdraw_self_service_provider_enrollment(encode(sha256('wd-session-w4'::bytea), 'hex'))
       <> 'session_invalid' then
    raise exception 'An expired session was not refused as invalid';
  end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.organization_applications application
               join withdrawal_before before using (id)
              where (application.status, application.row_version, application.reviewed_at)
                    is distinct from (before.status, before.row_version, before.reviewed_at))
     or exists (select 1 from identity.organization_profile_completion_challenges challenge
                  join withdrawal_challenges_before before using (id)
                 where challenge.invalidated_at is distinct from before.invalidated_at)
     or exists (select 1 from audit.events event where event.action = 'identity.organization.self-service.withdraw') then
    raise exception 'A refused withdrawal without a live session changed something';
  end if;
end $$;

-- Case a activates; a later live session of it, the governed session and the
-- closed application's session are refused as invalid and ended.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-withdrawal-0004', true);
do $$
declare activated record;
begin
  if identity.prepare_self_service_provider_activation(encode(sha256('wd-session-a'::bytea), 'hex')) <> 'ready' then
    raise exception 'Case a is not ready';
  end if;
  select * into activated from identity.activate_self_service_provider_enrollment(
    encode(sha256('wd-session-a'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  if activated.account_id is null then raise exception 'Case a did not activate'; end if;
end $$;
reset role;
insert into identity.organization_profile_completion_challenges
  (id, application_id, code_hmac, expires_at, consumed_at, session_hmac, session_expires_at)
values ('d7a90097-0000-4000-8000-000000000005', current_setting('hid.test.app_a')::uuid,
  encode(sha256('wd-otp-a2'::bytea), 'hex'), clock_timestamp() + interval '10 minutes',
  clock_timestamp(), encode(sha256('wd-session-a2'::bytea), 'hex'), clock_timestamp() + interval '1 hour');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-withdrawal-0005', true);
do $$
declare label text;
begin
  foreach label in array array['a', 'a2', 'g', 'c'] loop
    if identity.withdraw_self_service_provider_enrollment(encode(sha256(('wd-session-' || label)::bytea), 'hex'))
         <> 'session_invalid' then
      raise exception 'The session of case % was not refused as invalid', label;
    end if;
  end loop;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.organization_profile_completion_challenges challenge
              where challenge.session_hmac in (encode(sha256('wd-session-a2'::bytea), 'hex'),
                      encode(sha256('wd-session-g'::bytea), 'hex'), encode(sha256('wd-session-c'::bytea), 'hex'))
                and challenge.invalidated_at is null) then
    raise exception 'A session of an application that is no longer open was not ended';
  end if;
  if (select application.status from identity.organization_applications application
       where application.id = current_setting('hid.test.app_a')::uuid) <> 'approved'
     or (select application.status from identity.organization_applications application
          where application.id = current_setting('hid.test.app_g')::uuid) <> 'ready_for_review'
     or (select application.review_reason from identity.organization_applications application
          where application.id = current_setting('hid.test.app_c')::uuid)
        <> 'Closed by support before the applicant withdrew'
     or exists (select 1 from audit.events event where event.action = 'identity.organization.self-service.withdraw') then
    raise exception 'A refused withdrawal changed an application or was audited';
  end if;
end $$;

-- 3. A closed control refuses even a live session and changes nothing.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:withdrawal:super', true),
  set_config('app.correlation_id', 'self-service-withdrawal-close', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Withdrawal suite closes facility sign-up');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-withdrawal-0006', true),
  set_config('app.purpose_of_use', '', true);
do $$ begin
  perform identity.withdraw_self_service_provider_enrollment(encode(sha256('wd-session-x'::bytea), 'hex'));
  raise exception 'A closed control did not refuse the withdrawal';
exception when object_not_in_prerequisite_state then
  if sqlerrm <> 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled' then raise; end if;
end $$;
reset role;
do $$ begin
  if (select application.status from identity.organization_applications application
       where application.id = current_setting('hid.test.app_x')::uuid) <> 'ready_for_review'
     or exists (select 1 from identity.organization_profile_completion_challenges challenge
                 where challenge.application_id = current_setting('hid.test.app_x')::uuid
                   and challenge.invalidated_at is not null) then
    raise exception 'A withdrawal refused by the control changed something';
  end if;
end $$;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:withdrawal:super', true),
  set_config('app.correlation_id', 'self-service-withdrawal-reopen', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Withdrawal suite reopens facility sign-up');

-- 4. The applicant withdraws case w.
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-withdrawal-0007', true),
  set_config('app.purpose_of_use', '', true);
do $$ begin
  if not exists (select 1 from identity.current_self_service_provider_enrollment(
                   encode(sha256('wd-session-w'::bytea), 'hex'))) then
    raise exception 'The live session of case w is not found before the withdrawal';
  end if;
  if identity.withdraw_self_service_provider_enrollment(encode(sha256('wd-session-w'::bytea), 'hex'))
       <> 'withdrawn' then
    raise exception 'Case w was not withdrawn';
  end if;
  if identity.withdraw_self_service_provider_enrollment(encode(sha256('wd-session-w'::bytea), 'hex'))
       <> 'session_invalid'
     or identity.withdraw_self_service_provider_enrollment(encode(sha256('wd-session-w2'::bytea), 'hex'))
       <> 'session_invalid' then
    raise exception 'A session of a withdrawn application was not refused as invalid';
  end if;
  if exists (select 1 from identity.current_self_service_provider_enrollment(
               encode(sha256('wd-session-w'::bytea), 'hex'))) then
    raise exception 'The current-enrollment read still finds a withdrawn session';
  end if;
end $$;
reset role;
do $$
declare
  application identity.organization_applications%rowtype;
  got record;
begin
  select * into application from identity.organization_applications row
   where row.id = current_setting('hid.test.app_w')::uuid;
  if application.status <> 'rejected'
     or application.review_reason <> 'Self-service application withdrawn by its applicant'
     or application.reviewed_at is null
     or application.reviewed_by_account_id is not null
     or application.self_service_refusal_ends_at is not null
     or application.self_service_reviewed_at is not null
     or application.organization_id is not null
     or application.row_version <> (select before.row_version + 1 from withdrawal_before before
                                     where before.id = application.id) then
    raise exception 'The withdrawn application is not closed as the applicant''s withdrawal: %', row_to_json(application);
  end if;
  if exists (select 1 from identity.organization_profile_completion_challenges challenge
              where challenge.application_id = application.id and challenge.invalidated_at is null) then
    raise exception 'A code or session of the withdrawn application was not ended';
  end if;
  select count(*) as total, min(audit_row.actor_type) as actor_type, min(audit_row.actor_subject) as actor_subject,
         min(audit_row.resource_type) as resource_type, min(audit_row.resource_id) as resource_id,
         min(audit_row.outcome) as outcome, min(audit_row.correlation_id) as correlation_id,
         min(audit_row.details::text) as details, bool_or(audit_row.organization_id is not null
           or audit_row.facility_id is not null or audit_row.patient_id is not null) as scoped
    into got
    from audit.events audit_row
   where audit_row.action = 'identity.organization.self-service.withdraw';
  if got.total <> 1 or got.actor_type <> 'system' or got.actor_subject is not null
     or got.resource_type <> 'organization-application' or got.resource_id <> application.id::text
     or got.outcome <> 'success' or got.correlation_id <> 'self-service-withdrawal-0007'
     or got.details::jsonb <> '{"productCode": "ehr", "previousStatus": "ready_for_review"}'::jsonb
     or got.scoped then
    raise exception 'The withdrawal is not audited as expected: %', row_to_json(got);
  end if;
end $$;

-- 5. No 7-day refusal. The same email, from the same network, opens a new
-- application for the CAC number at once, without a hold.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-withdrawal-0008', true);
do $$
declare
  again uuid;
  other uuid;
begin
  again := identity.submit_self_service_organization_application('ehr', 'clinic', 'RC9900069001',
    'Wrong Company Admin', 'mistyped@withdrawal.invalid', encode(sha256('wd-network-w'::bytea), 'hex'));
  if again is null or again = current_setting('hid.test.app_w')::uuid then
    raise exception 'The applicant could not open a new application after withdrawing';
  end if;
  perform set_config('hid.test.app_w_again', again::text, true);
  -- Another email from another network lapses it at once and gets a hold.
  other := identity.submit_self_service_organization_application('ehr', 'clinic', 'RC9900069001',
    'Real Company Admin', 'owner@withdrawal.invalid', encode(sha256('wd-network-owner'::bytea), 'hex'));
  perform set_config('hid.test.app_w_owner', other::text, true);
end $$;
reset role;
do $$ begin
  if not (select application.self_service_without_hold from identity.organization_applications application
           where application.id = current_setting('hid.test.app_w_again')::uuid)
     or (select application.status from identity.organization_applications application
          where application.id = current_setting('hid.test.app_w_again')::uuid) <> 'rejected'
     or (select application.self_service_without_hold from identity.organization_applications application
          where application.id = current_setting('hid.test.app_w_owner')::uuid)
     or (select application.status from identity.organization_applications application
          where application.id = current_setting('hid.test.app_w_owner')::uuid) <> 'pending_verification' then
    raise exception 'The withdrawal did not leave only the 7-day loss of hold';
  end if;
end $$;
-- A withdrawal more than 7 days old no longer drops the hold: case w's
-- closures are moved back 8 days and the owner's application is closed.
update identity.organization_applications
   set reviewed_at = reviewed_at - interval '8 days', created_at = created_at - interval '8 days'
 where cac_registration_number = 'RC9900069001' and status = 'rejected';
update identity.organization_applications
   set status = 'rejected', reviewed_at = clock_timestamp() - interval '8 days',
       review_reason = 'Closed for the suite', row_version = row_version + 1
 where id = current_setting('hid.test.app_w_owner')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-withdrawal-0009', true);
do $$
declare later uuid;
begin
  later := identity.submit_self_service_organization_application('ehr', 'clinic', 'RC9900069001',
    'Wrong Company Admin', 'mistyped@withdrawal.invalid', encode(sha256('wd-network-w'::bytea), 'hex'));
  perform set_config('hid.test.app_w_later', later::text, true);
end $$;
reset role;
do $$ begin
  if (select application.self_service_without_hold from identity.organization_applications application
       where application.id = current_setting('hid.test.app_w_later')::uuid) then
    raise exception 'A withdrawal more than 7 days old still dropped the hold';
  end if;
end $$;

-- 6. The command's privileges.
do $$ begin
  if not (select proc.prosecdef from pg_proc proc
           where proc.oid = 'identity.withdraw_self_service_provider_enrollment(char)'::regprocedure)
     or (select proc.proconfig from pg_proc proc
          where proc.oid = 'identity.withdraw_self_service_provider_enrollment(char)'::regprocedure)
        is distinct from array['search_path=pg_catalog, identity, audit, platform, pg_temp']
     or not has_function_privilege('hid_identity_api_runtime',
       'identity.withdraw_self_service_provider_enrollment(char)', 'execute')
     or (exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime')
       and not has_function_privilege('hid_schema_test_runtime',
         'identity.withdraw_self_service_provider_enrollment(char)', 'execute'))
     or exists (select 1 from pg_proc proc, aclexplode(proc.proacl) privilege
                 where proc.oid = 'identity.withdraw_self_service_provider_enrollment(char)'::regprocedure
                   and privilege.grantee = 0) then
    raise exception 'The withdrawal command''s definer, search_path or grants are not as specified';
  end if;
  if exists (select 1 from pg_roles role_row
              where role_row.rolname in ('hid_ehr_runtime', 'hid_notification_runtime', 'hid_api_runtime', 'hid_outreach_runtime',
                  'hid_lab_runtime', 'hid_pharmacy_runtime', 'hid_ocr_runtime')
                and has_function_privilege(role_row.oid,
                  'identity.withdraw_self_service_provider_enrollment(char)', 'execute')) then
    raise exception 'Another runtime can withdraw an application';
  end if;
end $$;

rollback;
