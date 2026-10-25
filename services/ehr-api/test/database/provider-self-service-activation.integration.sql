\set ON_ERROR_STOP on
-- Facility self sign-up's activation pre-check, its emailed code and the
-- administrator details the activated account keeps (0086, review fixes R1,
-- R5 and R6). Rollback-only. Every command runs as the exact Identity API
-- runtime role in Identity's accountless system context.
--
--   1. R6: the account, the staff record and the application take the
--      administrator name and organization type sent with the request whose
--      emailed code opened the activating session, not those of the request
--      that opened the application, nor those of a later request; P4b: the
--      administrator holds only the restricted role, the organization is
--      pending;
--   2. R1: identity.prepare_self_service_provider_activation answers
--      'session_invalid' for no live session and changes nothing, and for a
--      live session of an application no longer open (ending it); 'ready'
--      charges one of the session's 5 attempts; the 6th answers
--      'attempts_exceeded' and ends the session; an activation that can never
--      succeed ('email_registered', 'cac_bound', 'name_exists', 'not_ready')
--      is answered at once and ends the session without charging it;
--      'email_registered' also closes the application (R15: rejected, no
--      reviewer, its reason, no refusal, its other session and code ended,
--      audited), the others leave it open; a closed control raises 55000 even
--      for a live session; a wrong context raises 42501;
--   3. R5: at most 10 emailed codes a day reach one administrator email
--      across every self-service application; past that no code is sent
--      (null, no challenge), another email is not affected, and a day later
--      codes flow again; a governed application gets no code through the
--      self-service command; invalid details raise 22023.
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
  ('c8a00000-0000-4000-8000-000000000001', 'synthetic:activation:super', 'super@activation.invalid', 'active'),
  ('c8a00000-0000-4000-8000-000000000002', 'synthetic:activation:taken', 'taken@activation.invalid', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c8a10000-0000-4000-8000-000000000001', 'c8a00000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', 'Activation suite super admin');
-- An organization that already holds the legal name of case 2's 'name_exists'.
insert into identity.organizations (id, name, slug)
values ('c8a20000-0000-4000-8000-000000000001', 'Activation Name Taken Ltd', 'activation-name-taken');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:activation:super', true),
  set_config('app.correlation_id', 'self-service-activation-open', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Activation suite opens facility sign-up');

-- Verified applications for every case, opened through the real commands.
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-activation-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  signup record;
  application_id uuid;
  current_application record;
begin
  for signup in select * from (values
      ('n', 'ehr', 'other', 'RC9900068001', 'Unknown Person', 'admin@ada.invalid', 'Ada Activation Hospital Ltd'),
      ('b', 'ehr', 'clinic', 'RC9900068002', 'Budget Admin', 'budget@activation.invalid', 'Budget Activation Clinic Ltd'),
      ('e', 'laboratory', 'laboratory', 'RC9900068003', 'Taken Admin', 'taken@activation.invalid', 'Taken Activation Lab Ltd'),
      ('c', 'pharmacy', 'pharmacy', 'RC9900068001', 'Second Product Admin', 'second@activation.invalid', 'Ada Activation Hospital Ltd'),
      ('x', 'migrate', 'clinic', 'RC9900068004', 'Name Admin', 'name@activation.invalid', 'Activation Name Taken Ltd'),
      ('g', 'ehr', 'hospital', 'RC9900068005', 'Governed Admin', 'governed@activation.invalid', 'Governed Activation Ltd')
    ) as rows(label, product, kind, cac, admin_name, admin_email, legal_name) loop
    application_id := identity.submit_self_service_organization_application(signup.product, signup.kind,
      signup.cac, signup.admin_name, signup.admin_email, encode(sha256(('network-' || signup.label)::bytea), 'hex'));
    select * into current_application from identity.public_get_organization_application(
      signup.cac, signup.admin_email, signup.product);
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', substr(signup.cac, 3), signup.cac, signup.legal_name,
      'Private Company Limited by Shares', '2020-06-01', '8 Activation Road, Lagos', 'active');
    perform set_config('hid.test.app_' || signup.label, application_id::text, true);
  end loop;
end $$;

-- 1. R6. The first code goes out with the name and type of whoever opened
-- the application ("Unknown Person", other).
do $$
begin
  if identity.begin_self_service_provider_enrollment('RC9900068001', 'admin@ada.invalid', 'ehr',
       'c8a90000-0000-4000-8000-000000000001', encode(sha256('act-otp-1'::bytea), 'hex'),
       'Unknown Person', 'other') is distinct from 'admin@ada.invalid' then
    raise exception 'The first code was not sent';
  end if;
end $$;
reset role;
update identity.organization_profile_completion_challenges
   set created_at = created_at - interval '2 minutes'
 where application_id = current_setting('hid.test.app_n')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-activation-0002', true);
-- The mailbox's owner asks for a code with her own name and type and confirms it.
do $$
begin
  if identity.begin_self_service_provider_enrollment('RC9900068001', 'Admin@Ada.invalid ', 'ehr',
       'c8a90000-0000-4000-8000-000000000002', encode(sha256('act-otp-2'::bytea), 'hex'),
       '  Dr Ada Obi  ', 'hospital') is distinct from 'admin@ada.invalid' then
    raise exception 'The owner''s code was not sent';
  end if;
  if not identity.verify_organization_profile_completion_challenge('c8a90000-0000-4000-8000-000000000002',
      encode(sha256('act-otp-2'::bytea), 'hex'), encode(sha256('act-session-2'::bytea), 'hex')) then
    raise exception 'The owner''s code did not verify';
  end if;
end $$;
reset role;
update identity.organization_profile_completion_challenges
   set created_at = created_at - interval '2 minutes'
 where application_id = current_setting('hid.test.app_n')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-activation-0003', true);
-- A stranger asks again after she confirmed, then she activates.
do $$
declare activated record;
begin
  if identity.begin_self_service_provider_enrollment('RC9900068001', 'admin@ada.invalid', 'ehr',
       'c8a90000-0000-4000-8000-000000000003', encode(sha256('act-otp-3'::bytea), 'hex'),
       'Unknown Person', 'other') is distinct from 'admin@ada.invalid' then
    raise exception 'The later code was not sent';
  end if;
  if identity.prepare_self_service_provider_activation(encode(sha256('act-session-2'::bytea), 'hex')) <> 'ready' then
    raise exception 'The owner''s session is not ready';
  end if;
  select * into activated from identity.activate_self_service_provider_enrollment(
    encode(sha256('act-session-2'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform set_config('hid.test.ada_account', activated.account_id::text, true);
end $$;
reset role;
do $$ begin
  if (select array_agg(row(challenge.requested_administrator_name, challenge.requested_organization_type)::text
        order by challenge.id)
        from identity.organization_profile_completion_challenges challenge
       where challenge.application_id = current_setting('hid.test.app_n')::uuid)
     is distinct from array['("Unknown Person",other)', '("Dr Ada Obi",hospital)', '("Unknown Person",other)'] then
    raise exception 'The codes did not store the details they were requested with';
  end if;
  if not exists (select 1 from auth.accounts account
                  where account.id = current_setting('hid.test.ada_account')::uuid
                    and account.display_name = 'Dr Ada Obi')
     or not exists (select 1 from identity.staff staff
                     where staff.account_id = current_setting('hid.test.ada_account')::uuid
                       and staff.full_name = 'Dr Ada Obi')
     or not exists (select 1 from identity.organization_applications application
                     where application.id = current_setting('hid.test.app_n')::uuid
                       and application.status = 'approved'
                       and application.administrator_name = 'Dr Ada Obi'
                       and application.organization_type = 'hospital') then
    raise exception 'The activated account did not keep the details of the code that proved the mailbox';
  end if;
  -- P4b: the activation records the approval before the administrator's role
  -- row (the review gate would refuse the restricted role at an organization
  -- that is not yet pending), and the role is the restricted one, granted by
  -- no one, with the membership still named org_admin.
  if (select array_agg(assignment.role_code || ':' || coalesce(assignment.granted_by::text, 'none'))
        from auth.account_roles assignment
       where assignment.account_id = current_setting('hid.test.ada_account')::uuid and assignment.revoked_at is null)
     is distinct from array['org_admin_awaiting_review:none']
     or not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.account_id = current_setting('hid.test.ada_account')::uuid
                       and membership.membership_role = 'org_admin' and membership.app_role = 'org_admin')
     or (select state.review_state from identity.organization_applications application,
           lateral identity.organization_self_service_state(application.organization_id) state
          where application.id = current_setting('hid.test.app_n')::uuid) is distinct from 'pending' then
    raise exception 'The activation did not grant only the restricted role at a pending organization';
  end if;
end $$;
-- Another live session of the now activated application is ended as invalid.
insert into identity.organization_profile_completion_challenges
  (id, application_id, code_hmac, expires_at, consumed_at, session_hmac, session_expires_at)
values ('c8a90000-0000-4000-8000-000000000098', current_setting('hid.test.app_n')::uuid,
  encode(sha256('act-otp-other'::bytea), 'hex'), clock_timestamp() + interval '10 minutes',
  clock_timestamp(), encode(sha256('act-session-other'::bytea), 'hex'), clock_timestamp() + interval '1 hour');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-activation-0003b', true);
do $$ begin
  if identity.prepare_self_service_provider_activation(encode(sha256('act-session-other'::bytea), 'hex'))
       <> 'session_invalid' then
    raise exception 'A session of an activated application was not refused as invalid';
  end if;
end $$;
reset role;
do $$ begin
  if (select invalidated_at from identity.organization_profile_completion_challenges
       where id = 'c8a90000-0000-4000-8000-000000000098') is null then
    raise exception 'A session of an activated application was not ended';
  end if;
end $$;

-- 2. R1. Each case gets a verified session through the self-service code.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-activation-0004', true);
do $$
declare
  signup record;
begin
  for signup in select * from (values
      ('b', 'ehr', 'RC9900068002', 'budget@activation.invalid', 'Budget Admin', 'clinic'),
      ('e', 'laboratory', 'RC9900068003', 'taken@activation.invalid', 'Taken Admin', 'laboratory'),
      ('c', 'pharmacy', 'RC9900068001', 'second@activation.invalid', 'Second Product Admin', 'pharmacy'),
      ('x', 'migrate', 'RC9900068004', 'name@activation.invalid', 'Name Admin', 'clinic'),
      ('g', 'ehr', 'RC9900068005', 'governed@activation.invalid', 'Governed Admin', 'hospital')
    ) as rows(label, product, cac, admin_email, admin_name, kind) loop
    if identity.begin_self_service_provider_enrollment(signup.cac, signup.admin_email, signup.product,
         ('c8a9' || lpad(ascii(signup.label)::text, 4, '0') || '-0000-4000-8000-000000000010')::uuid,
         encode(sha256(('act-otp-' || signup.label)::bytea), 'hex'), signup.admin_name, signup.kind)
       is distinct from signup.admin_email then
      raise exception 'No code for case %', signup.label;
    end if;
    if not identity.verify_organization_profile_completion_challenge(
        ('c8a9' || lpad(ascii(signup.label)::text, 4, '0') || '-0000-4000-8000-000000000010')::uuid,
        encode(sha256(('act-otp-' || signup.label)::bytea), 'hex'),
        encode(sha256(('act-session-' || signup.label)::bytea), 'hex')) then
      raise exception 'Case % did not verify', signup.label;
    end if;
  end loop;
end $$;
reset role;
-- Case g stands for a governed application's completion session.
update identity.organization_applications set approval_mode = 'admin_review'
 where id = current_setting('hid.test.app_g')::uuid;
-- Case e also has a second live session and an unused code.
insert into identity.organization_profile_completion_challenges
  (id, application_id, code_hmac, expires_at, consumed_at, session_hmac, session_expires_at) values
  ('c8a90101-0000-4000-8000-000000000011', current_setting('hid.test.app_e')::uuid,
   encode(sha256('act-otp-e2'::bytea), 'hex'), clock_timestamp() + interval '10 minutes', clock_timestamp(),
   encode(sha256('act-session-e2'::bytea), 'hex'), clock_timestamp() + interval '1 hour');
insert into identity.organization_profile_completion_challenges (id, application_id, code_hmac, expires_at) values
  ('c8a90101-0000-4000-8000-000000000012', current_setting('hid.test.app_e')::uuid,
   encode(sha256('act-otp-e3'::bytea), 'hex'), clock_timestamp() + interval '10 minutes');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-activation-0005', true);
do $$
declare
  attempt integer;
  answer text;
  refused record;
  session_b char(64) := encode(sha256('act-session-b'::bytea), 'hex');
begin
  -- No live session: nothing to charge or end.
  if identity.prepare_self_service_provider_activation(repeat('f', 64)) <> 'session_invalid' then
    raise exception 'An unknown session was not refused';
  end if;
  -- The budget: 5 ready attempts, then the session ends.
  for attempt in 1..5 loop
    answer := identity.prepare_self_service_provider_activation(session_b);
    if answer <> 'ready' then raise exception 'Attempt % answered %', attempt, answer; end if;
  end loop;
  if identity.prepare_self_service_provider_activation(session_b) <> 'attempts_exceeded'
     or identity.prepare_self_service_provider_activation(session_b) <> 'session_invalid' then
    raise exception 'The sixth attempt did not end the session';
  end if;
  begin
    perform identity.activate_self_service_provider_enrollment(session_b,
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    raise exception 'A session past its budget activated';
  exception when insufficient_privilege then
    if sqlerrm <> 'Organization enrollment session is invalid' then raise; end if;
  end;
  -- Activations that can never succeed are answered at once, and end the session.
  for refused in select * from (values
      ('e', 'email_registered'), ('c', 'cac_bound'), ('x', 'name_exists'), ('g', 'not_ready')
    ) as rows(label, expected) loop
    answer := identity.prepare_self_service_provider_activation(
      encode(sha256(('act-session-' || refused.label)::bytea), 'hex'));
    if answer <> refused.expected then
      raise exception 'Case % answered % instead of %', refused.label, answer, refused.expected;
    end if;
    if identity.prepare_self_service_provider_activation(
         encode(sha256(('act-session-' || refused.label)::bytea), 'hex')) <> 'session_invalid' then
      raise exception 'Case % did not end its session', refused.label;
    end if;
  end loop;
  begin
    perform identity.prepare_self_service_provider_activation('not-a-session-hmac');
    raise exception 'A malformed session was accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'Self-service activation context is required' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if (select challenge.activation_attempts from identity.organization_profile_completion_challenges challenge
       where challenge.application_id = current_setting('hid.test.app_b')::uuid
         and challenge.session_hmac is not null) <> 5
     or exists (select 1 from identity.organization_profile_completion_challenges challenge
                 where challenge.application_id in (current_setting('hid.test.app_e')::uuid,
                   current_setting('hid.test.app_c')::uuid, current_setting('hid.test.app_x')::uuid,
                   current_setting('hid.test.app_g')::uuid)
                   and challenge.session_hmac is not null
                   and (challenge.activation_attempts <> 0 or challenge.invalidated_at is null)) then
    raise exception 'The attempts were not charged or the sessions not ended exactly';
  end if;
  if (select count(*) from identity.organizations) <> 2
     or exists (select 1 from identity.organization_applications
                 where id in (current_setting('hid.test.app_b')::uuid,
                   current_setting('hid.test.app_c')::uuid, current_setting('hid.test.app_x')::uuid,
                   current_setting('hid.test.app_g')::uuid) and status <> 'ready_for_review') then
    raise exception 'A refused pre-check created or closed something';
  end if;
  -- R15: the registered email's application is closed, so another email can
  -- start again at once; nothing refuses its email or network.
  if not exists (select 1 from identity.organization_applications
                  where id = current_setting('hid.test.app_e')::uuid and status = 'rejected'
                    and reviewed_at is not null and reviewed_by_account_id is null
                    and review_reason = 'Self-service application closed: its administrator email already belongs to an account'
                    and self_service_refusal_ends_at is null)
     or exists (select 1 from identity.organization_profile_completion_challenges
                 where application_id = current_setting('hid.test.app_e')::uuid and invalidated_at is null)
     or (select count(*) from audit.events where action = 'identity.organization.self-service.close'
           and resource_uuid = current_setting('hid.test.app_e')::uuid
           and correlation_id = 'self-service-activation-0005'
           and details = '{"productCode": "laboratory", "closeReason": "administrator_email_registered"}'::jsonb) <> 1
     or exists (select 1 from audit.events where action = 'identity.organization.self-service.close'
                 and resource_uuid <> current_setting('hid.test.app_e')::uuid) then
    raise exception 'The registered email''s application was not closed exactly';
  end if;
end $$;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-activation-0006', true);
do $$ begin
  if identity.prepare_self_service_provider_activation(encode(sha256('act-session-e2'::bytea), 'hex'))
       <> 'session_invalid' then
    raise exception 'The closed application''s other session is still live';
  end if;
  if identity.submit_self_service_organization_application('laboratory', 'laboratory', 'RC9900068003',
       'Taken Admin', 'work.taken@activation.invalid') = current_setting('hid.test.app_e')::uuid then
    raise exception 'Another email did not open a new application after the closure';
  end if;
end $$;
reset role;

-- A closed control refuses a live session, after the session's lock, and
-- charges nothing.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:activation:super', true),
  set_config('app.correlation_id', 'self-service-activation-close', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Activation suite closes facility sign-up');
reset role;
-- A fresh live session for case x's application.
insert into identity.organization_profile_completion_challenges
  (id, application_id, code_hmac, expires_at, consumed_at, session_hmac, session_expires_at)
values ('c8a90000-0000-4000-8000-000000000099', current_setting('hid.test.app_x')::uuid,
  encode(sha256('act-otp-closed'::bytea), 'hex'), clock_timestamp() + interval '10 minutes',
  clock_timestamp(), encode(sha256('act-session-closed'::bytea), 'hex'), clock_timestamp() + interval '1 hour');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-activation-0007', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare message text;
begin
  foreach message in array array[encode(sha256('act-session-closed'::bytea), 'hex'), repeat('f', 64)] loop
    begin
      perform identity.prepare_self_service_provider_activation(message);
      raise exception 'A closed self sign-up answered the pre-check';
    exception when object_not_in_prerequisite_state then
      if sqlerrm <> 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled' then raise; end if;
    end;
  end loop;
end $$;
select set_config('app.actor_subject', 'synthetic:activation:super', true),
  set_config('app.correlation_id', 'self-service-activation-reopen', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Activation suite reopens facility sign-up');
reset role;
do $$ begin
  if (select activation_attempts from identity.organization_profile_completion_challenges
       where id = 'c8a90000-0000-4000-8000-000000000099') <> 0 then
    raise exception 'A closed pre-check charged an attempt';
  end if;
end $$;
-- A wrong context.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:activation:super', true),
  set_config('app.correlation_id', 'self-service-activation-0008', true);
do $$ begin
  perform identity.prepare_self_service_provider_activation(encode(sha256('act-session-closed'::bytea), 'hex'));
  raise exception 'A platform administrator''s context ran the pre-check';
exception when insufficient_privilege then
  if sqlerrm <> 'Self-service activation context is required' then raise; end if;
end $$;
reset role;

-- 3. R5. Eleven verified applications for one administrator email.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-activation-0009', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  n integer;
  cac text;
  application_id uuid;
  current_application record;
  recipient text;
begin
  for n in 1..12 loop
    cac := 'RC99000681' || lpad(n::text, 2, '0');
    application_id := identity.submit_self_service_organization_application('ehr', 'clinic', cac,
      'Recipient Admin', case when n = 12 then 'other@recipient.invalid' else 'victim@recipient.invalid' end,
      encode(sha256(('recipient-network-' || n)::bytea), 'hex'));
    select * into current_application from identity.public_get_organization_application(cac,
      case when n = 12 then 'other@recipient.invalid' else 'victim@recipient.invalid' end, 'ehr');
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', substr(cac, 3), cac, 'Recipient Clinic ' || n || ' Ltd',
      'Private Company Limited by Shares', '2020-06-01', '9 Recipient Road, Lagos', 'active');
    recipient := identity.begin_self_service_provider_enrollment(cac,
      case when n = 12 then 'other@recipient.invalid' else 'victim@recipient.invalid' end, 'ehr',
      ('c8ab0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      encode(sha256(('recipient-otp-' || n)::bytea), 'hex'), 'Recipient Admin', 'clinic');
    if n <= 10 and recipient is distinct from 'victim@recipient.invalid' then
      raise exception 'Code % to the recipient was not sent', n;
    end if;
    if n = 11 and recipient is not null then
      raise exception 'An eleventh code in a day reached one recipient';
    end if;
    if n = 12 and recipient is distinct from 'other@recipient.invalid' then
      raise exception 'Another recipient was limited';
    end if;
  end loop;
  -- A governed application gets no code through the self-service command.
  if identity.begin_self_service_provider_enrollment('RC9900068005', 'governed@activation.invalid', 'ehr',
       'c8ab0000-0000-4000-8000-000000000099', encode(sha256('recipient-otp-g'::bytea), 'hex'),
       'Governed Admin', 'hospital') is not null then
    raise exception 'A governed application got a code through the self-service command';
  end if;
  begin
    perform identity.begin_self_service_provider_enrollment('RC9900068111', 'victim@recipient.invalid', 'ehr',
      'c8ab0000-0000-4000-8000-000000000098', encode(sha256('recipient-otp-x'::bytea), 'hex'), 'X', 'clinic');
    raise exception 'A one-character administrator name was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.begin_self_service_provider_enrollment('RC9900068111', 'victim@recipient.invalid', 'ehr',
      'c8ab0000-0000-4000-8000-000000000098', encode(sha256('recipient-otp-x'::bytea), 'hex'),
      'Recipient Admin', 'hotel');
    raise exception 'An unknown organization type was accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.organization_profile_completion_challenges
              where id = 'c8ab0000-0000-4000-8000-000000000011')
     or (select count(*) from identity.organization_profile_completion_challenges challenge
          join identity.organization_applications application on application.id = challenge.application_id
         where application.administrator_email = 'victim@recipient.invalid') <> 10 then
    raise exception 'The eleventh code was stored, or the ten were not';
  end if;
end $$;
-- A day later the recipient gets codes again.
update identity.organization_profile_completion_challenges challenge
   set created_at = challenge.created_at - interval '1 day 1 minute'
  from identity.organization_applications application
 where application.id = challenge.application_id
   and application.administrator_email = 'victim@recipient.invalid';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-activation-0010', true);
do $$ begin
  if identity.begin_self_service_provider_enrollment('RC9900068111', 'victim@recipient.invalid', 'ehr',
       'c8ab0000-0000-4000-8000-000000000011', encode(sha256('recipient-otp-11'::bytea), 'hex'),
       'Recipient Admin', 'clinic') is distinct from 'victim@recipient.invalid' then
    raise exception 'The recipient got no code a day later';
  end if;
end $$;
reset role;

rollback;
