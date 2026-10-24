\set ON_ERROR_STOP on
-- Facility self sign-up's two read-only commands for the website's second
-- contract (0086, R13 and R14). Rollback-only. Every command runs as the exact
-- Identity API runtime role in Identity's accountless system context.
--
--   1. R13: identity.current_self_service_provider_enrollment answers a live
--      completion session of a verified self-service application ready for
--      activation with the verified legal name, the CAC number as entered,
--      the product, and the organization type and administrator name of the
--      code that opened the session, with the administrator email; it changes
--      nothing (no attempt charged, no session ended, no version bumped); it
--      returns no row for an unknown, expired, ended or used-up session, a
--      governed application's session or an activated application's; a
--      closed control raises 55000; a malformed session or another context
--      raises 42501;
--   2. R14: identity.self_service_provider_code_state answers whether the
--      CAC number, product and email name an open verified self-service
--      application, the code in force (newest, unused, not invalidated, not
--      expired, under 5 wrong tries) and the seconds until a start can send
--      a new code, for 0056's 60 seconds, 5 an hour and 15 a day and R5's 10 a
--      day per administrator email, each agreeing with whether
--      begin_self_service_provider_enrollment then sends one; it changes
--      nothing; another context raises 42501.
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
  ('c8c00000-0000-4000-8000-000000000001', 'synthetic:confirmation:super', 'super@confirmation.invalid', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c8c10000-0000-4000-8000-000000000001', 'c8c00000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', 'Confirmation suite super admin');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:confirmation:super', true),
  set_config('app.correlation_id', 'self-service-confirmation-open', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Confirmation suite opens facility sign-up');

-- Verified applications, opened through the real commands: a (the
-- confirmation read), g (a governed application's session), s (the code
-- state), and r1-r10 for one recipient (R5's limit).
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-confirmation-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  signup record;
  application_id uuid;
  current_application record;
begin
  for signup in select * from (values
      ('a', 'ehr', 'clinic', 'RC9900071001', 'First Submitter', 'admin@confirm.invalid', 'Confirm Hospital Ltd'),
      ('g', 'ehr', 'hospital', 'RC9900071002', 'Governed Admin', 'governed@confirm.invalid', 'Governed Confirm Ltd'),
      ('s', 'laboratory', 'laboratory', 'RC9900071003', 'State Admin', 'state@confirm.invalid', 'State Confirm Lab Ltd')
    ) as rows(label, product, kind, cac, admin_name, admin_email, legal_name) loop
    application_id := identity.submit_self_service_organization_application(signup.product, signup.kind,
      signup.cac, signup.admin_name, signup.admin_email, encode(sha256(('confirm-network-' || signup.label)::bytea), 'hex'));
    select * into current_application from identity.public_get_organization_application(
      signup.cac, signup.admin_email, signup.product);
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', substr(signup.cac, 3), signup.cac, signup.legal_name,
      'Private Company Limited by Shares', '2020-06-01', '8 Confirmation Road, Lagos', 'active');
    perform set_config('hid.test.app_' || signup.label, application_id::text, true);
  end loop;
end $$;

-- 1. R13. The owner of the mailbox asks for a code with her own name and type
-- (R6), and confirms it.
do $$
begin
  if identity.begin_self_service_provider_enrollment('RC9900071001', 'admin@confirm.invalid', 'ehr',
       'c8c90000-0000-4000-8000-000000000001', encode(sha256('confirm-otp-a'::bytea), 'hex'),
       'Dr Ada Obi', 'hospital') is distinct from 'admin@confirm.invalid'
     or not identity.verify_organization_profile_completion_challenge('c8c90000-0000-4000-8000-000000000001',
       encode(sha256('confirm-otp-a'::bytea), 'hex'), encode(sha256('confirm-session-a'::bytea), 'hex')) then
    raise exception 'The confirmation session was not opened';
  end if;
  if identity.begin_self_service_provider_enrollment('RC9900071002', 'governed@confirm.invalid', 'ehr',
       'c8c90000-0000-4000-8000-000000000002', encode(sha256('confirm-otp-g'::bytea), 'hex'),
       'Governed Admin', 'hospital') is distinct from 'governed@confirm.invalid'
     or not identity.verify_organization_profile_completion_challenge('c8c90000-0000-4000-8000-000000000002',
       encode(sha256('confirm-otp-g'::bytea), 'hex'), encode(sha256('confirm-session-g'::bytea), 'hex')) then
    raise exception 'The governed session was not opened';
  end if;
end $$;
reset role;
-- Case g stands for a governed application's completion session.
update identity.organization_applications set approval_mode = 'admin_review'
 where id = current_setting('hid.test.app_g')::uuid;
select set_config('hid.test.a_version', (select row_version::text from identity.organization_applications
  where id = current_setting('hid.test.app_a')::uuid), true);

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-confirmation-0002', true);
do $$
declare
  shown record;
  rows_seen integer;
begin
  select count(*) into rows_seen
    from identity.current_self_service_provider_enrollment(encode(sha256('confirm-session-a'::bytea), 'hex'));
  select * into shown
    from identity.current_self_service_provider_enrollment(encode(sha256('confirm-session-a'::bytea), 'hex'));
  if rows_seen <> 1
     or shown.organization_name is distinct from 'Confirm Hospital Ltd'
     or shown.cac_registration_number is distinct from 'RC9900071001'
     or shown.product_code is distinct from 'ehr'
     or shown.organization_type is distinct from 'hospital'
     or shown.administrator_name is distinct from 'Dr Ada Obi'
     or shown.administrator_email is distinct from 'admin@confirm.invalid' then
    raise exception 'The confirmation read answered % row(s): %', rows_seen, shown;
  end if;
  -- Read twice: still the same, and still nothing charged.
  if (select count(*) from identity.current_self_service_provider_enrollment(
        encode(sha256('confirm-session-a'::bytea), 'hex'))) <> 1 then
    raise exception 'A second confirmation read lost the session';
  end if;
  -- No row for an unknown session, or a governed application's.
  if exists (select 1 from identity.current_self_service_provider_enrollment(repeat('f', 64)))
     or exists (select 1 from identity.current_self_service_provider_enrollment(
       encode(sha256('confirm-session-g'::bytea), 'hex'))) then
    raise exception 'The confirmation read answered an unknown or governed session';
  end if;
  -- A malformed or missing session is a wrong context.
  begin
    perform identity.current_self_service_provider_enrollment('not-a-session-hmac');
    raise exception 'A malformed session was accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'Self-service enrollment context is required' then raise; end if;
  end;
  begin
    perform identity.current_self_service_provider_enrollment(null);
    raise exception 'A missing session was accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'Self-service enrollment context is required' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.organization_profile_completion_challenges
              where id = 'c8c90000-0000-4000-8000-000000000001'
                and (activation_attempts <> 0 or invalidated_at is not null))
     or (select row_version::text from identity.organization_applications
          where id = current_setting('hid.test.app_a')::uuid) <> current_setting('hid.test.a_version') then
    raise exception 'The confirmation read charged an attempt, ended the session or changed the application';
  end if;
end $$;

-- An expired, an ended and a used-up session show nothing; each is restored after.
do $$
declare
  change record;
  seen integer;
begin
  for change in select * from (values
      ('session_expires_at = clock_timestamp() - interval ''1 second''', 'session_expires_at = clock_timestamp() + interval ''1 hour'''),
      ('invalidated_at = clock_timestamp()', 'invalidated_at = null')
    ) as rows(spoil, restore) loop
    execute 'update identity.organization_profile_completion_challenges set ' || change.spoil
      || ' where id = ''c8c90000-0000-4000-8000-000000000001''';
    execute 'set local role hid_identity_api_runtime';
    select count(*) into seen from identity.current_self_service_provider_enrollment(
      encode(sha256('confirm-session-a'::bytea), 'hex'));
    execute 'reset role';
    if seen <> 0 then raise exception 'A spoiled session (%) was shown', change.spoil; end if;
    execute 'update identity.organization_profile_completion_challenges set ' || change.restore
      || ' where id = ''c8c90000-0000-4000-8000-000000000001''';
  end loop;
end $$;

-- Another context, and a closed control.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:confirmation:super', true),
  set_config('app.correlation_id', 'self-service-confirmation-0003', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$ begin
  perform identity.current_self_service_provider_enrollment(encode(sha256('confirm-session-a'::bytea), 'hex'));
  raise exception 'A platform administrator''s context read the confirmation';
exception when insufficient_privilege then
  if sqlerrm <> 'Self-service enrollment context is required' then raise; end if;
end $$;
select platform.admin_set_control('provider_self_service_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Confirmation suite closes facility sign-up');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-confirmation-0004', true),
  set_config('app.purpose_of_use', '', true);
do $$ begin
  perform identity.current_self_service_provider_enrollment(encode(sha256('confirm-session-a'::bytea), 'hex'));
  raise exception 'A closed self sign-up answered the confirmation read';
exception when object_not_in_prerequisite_state then
  if sqlerrm <> 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled' then raise; end if;
end $$;
select set_config('app.actor_subject', 'synthetic:confirmation:super', true),
  set_config('app.correlation_id', 'self-service-confirmation-reopen', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Confirmation suite reopens facility sign-up');

-- After the activation the session shows nothing.
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-confirmation-0005', true),
  set_config('app.purpose_of_use', '', true);
do $$ begin
  if identity.prepare_self_service_provider_activation(encode(sha256('confirm-session-a'::bytea), 'hex')) <> 'ready' then
    raise exception 'The confirmed session is not ready';
  end if;
  perform identity.activate_self_service_provider_enrollment(encode(sha256('confirm-session-a'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  if exists (select 1 from identity.current_self_service_provider_enrollment(
       encode(sha256('confirm-session-a'::bytea), 'hex'))) then
    raise exception 'An activated session still shows the confirmation';
  end if;
  if not exists (select 1 from identity.organizations where name = 'Confirm Hospital Ltd') then
    raise exception 'The activation did not register the name the confirmation showed';
  end if;
end $$;
reset role;
-- Another live session of the activated application shows nothing either.
insert into identity.organization_profile_completion_challenges
  (id, application_id, code_hmac, expires_at, consumed_at, session_hmac, session_expires_at)
values ('c8c90000-0000-4000-8000-000000000098', current_setting('hid.test.app_a')::uuid,
  encode(sha256('confirm-otp-other'::bytea), 'hex'), clock_timestamp() + interval '10 minutes',
  clock_timestamp(), encode(sha256('confirm-session-other'::bytea), 'hex'), clock_timestamp() + interval '1 hour');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-confirmation-0005b', true);
do $$ begin
  if exists (select 1 from identity.current_self_service_provider_enrollment(
       encode(sha256('confirm-session-other'::bytea), 'hex'))) then
    raise exception 'A live session of an activated application shows the confirmation';
  end if;
end $$;
reset role;

-- 2. R14. The code state agrees with whether a code goes out.
reset role;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-confirmation-0006', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  before_code record;
  first record;
  later record;
  sent text;
  again text;
begin
  execute 'set local role hid_identity_api_runtime';
  select * into before_code
    from identity.self_service_provider_code_state('RC9900071003', 'state@confirm.invalid', 'laboratory');
  sent := identity.begin_self_service_provider_enrollment('RC9900071003', 'State@Confirm.invalid ', 'laboratory',
    'c8ca0000-0000-4000-8000-000000000001', encode(sha256('state-otp-1'::bytea), 'hex'), 'State Admin', 'laboratory');
  select * into first
    from identity.self_service_provider_code_state('RC9900071003', 'State@Confirm.invalid ', 'laboratory');
  -- At once a second start sends none (0056's 60 seconds).
  again := identity.begin_self_service_provider_enrollment('RC9900071003', 'state@confirm.invalid', 'laboratory',
    'c8ca0000-0000-4000-8000-000000000002', encode(sha256('state-otp-2'::bytea), 'hex'), 'State Admin', 'laboratory');
  select * into later
    from identity.self_service_provider_code_state('RC9900071003', 'state@confirm.invalid', 'laboratory');
  execute 'reset role';
  if before_code.application_open is distinct from true or before_code.challenge_id is not null
     or before_code.expires_in_seconds is not null or before_code.resend_after_seconds is distinct from 0 then
    raise exception 'The state before any code was %', before_code;
  end if;
  if sent is distinct from 'state@confirm.invalid' or first.application_open is distinct from true
     or first.challenge_id is distinct from 'c8ca0000-0000-4000-8000-000000000001'
     or first.expires_in_seconds not between 590 and 600 or first.resend_after_seconds not between 55 and 60 then
    raise exception 'The state after the first code (%) was %', sent, first;
  end if;
  if again is not null or exists (select 1 from identity.organization_profile_completion_challenges
                                   where id = 'c8ca0000-0000-4000-8000-000000000002') then
    raise exception 'A code went out within 60 seconds of the last';
  end if;
  if later.challenge_id is distinct from first.challenge_id or later.resend_after_seconds not between 1 and 60 then
    raise exception 'Within the 60 seconds the state was %', later;
  end if;
end $$;

-- 5 an hour: four more codes, each past the 60 seconds, then none until the
-- 5th newest code of the hour is an hour old; the code in force is the
-- newest, which the page keeps.
do $$
declare
  n integer;
  sent text;
  seen record;
  expected integer;
begin
  for n in 2..5 loop
    update identity.organization_profile_completion_challenges
       set created_at = created_at - interval '61 seconds'
     where application_id = current_setting('hid.test.app_s')::uuid;
    execute 'set local role hid_identity_api_runtime';
    sent := identity.begin_self_service_provider_enrollment('RC9900071003', 'state@confirm.invalid', 'laboratory',
      ('c8ca0000-0000-4000-8000-0000000000' || (10 + n)::text)::uuid,
      encode(sha256(('state-otp-h' || n)::bytea), 'hex'), 'State Admin', 'laboratory');
    execute 'reset role';
    if sent is distinct from 'state@confirm.invalid' then raise exception 'Code % of the hour was not sent', n; end if;
  end loop;
  update identity.organization_profile_completion_challenges
     set created_at = created_at - interval '61 seconds'
   where application_id = current_setting('hid.test.app_s')::uuid;
  execute 'set local role hid_identity_api_runtime';
  sent := identity.begin_self_service_provider_enrollment('RC9900071003', 'state@confirm.invalid', 'laboratory',
    'c8ca0000-0000-4000-8000-000000000016', encode(sha256('state-otp-h6'::bytea), 'hex'), 'State Admin', 'laboratory');
  select * into seen from identity.self_service_provider_code_state('RC9900071003', 'state@confirm.invalid', 'laboratory');
  execute 'reset role';
  if sent is not null then raise exception 'A sixth code in an hour was sent'; end if;
  select ceil(extract(epoch from created_at + interval '1 hour' - clock_timestamp()))::integer into expected
    from identity.organization_profile_completion_challenges
   where application_id = current_setting('hid.test.app_s')::uuid
   order by created_at desc offset 4 limit 1;
  if seen.challenge_id is distinct from 'c8ca0000-0000-4000-8000-000000000015'
     or seen.expires_in_seconds not between 1 and 600
     or abs(seen.resend_after_seconds - expected) > 1 or seen.resend_after_seconds < 3000 then
    raise exception 'At the hourly limit the state was % (expected a wait of about %)', seen, expected;
  end if;
  -- Once that code is an hour old a code goes out again, as the state says beforehand.
  update identity.organization_profile_completion_challenges
     set created_at = created_at - make_interval(secs => seen.resend_after_seconds)
   where application_id = current_setting('hid.test.app_s')::uuid;
  execute 'set local role hid_identity_api_runtime';
  select * into seen from identity.self_service_provider_code_state('RC9900071003', 'state@confirm.invalid', 'laboratory');
  sent := identity.begin_self_service_provider_enrollment('RC9900071003', 'state@confirm.invalid', 'laboratory',
    'c8ca0000-0000-4000-8000-000000000017', encode(sha256('state-otp-h7'::bytea), 'hex'), 'State Admin', 'laboratory');
  execute 'reset role';
  if seen.resend_after_seconds is distinct from 0 or sent is distinct from 'state@confirm.invalid' then
    raise exception 'After the hour the state was % and the code %', seen, coalesce(sent, 'not sent');
  end if;
end $$;

-- A day: with 15 codes in the last day and none in the last hour, none is
-- sent. All of an application's codes go to its one email, so R5's 10 a day
-- per email always ends after 0056's 15 a day per application: the wait is
-- until the 10th newest is a day old.
delete from identity.organization_profile_completion_challenges
 where application_id = current_setting('hid.test.app_s')::uuid;
insert into identity.organization_profile_completion_challenges (id, application_id, code_hmac, created_at, expires_at)
select ('c8cb0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, current_setting('hid.test.app_s')::uuid,
  encode(sha256(('state-day-' || n)::bytea), 'hex'),
  clock_timestamp() - make_interval(hours => 2, mins => n),
  clock_timestamp() - make_interval(hours => 2, mins => n) + interval '10 minutes'
  from generate_series(1, 15) n;
do $$
declare
  seen record;
  sent text;
  expected integer;
begin
  execute 'set local role hid_identity_api_runtime';
  select * into seen from identity.self_service_provider_code_state('RC9900071003', 'state@confirm.invalid', 'laboratory');
  sent := identity.begin_self_service_provider_enrollment('RC9900071003', 'state@confirm.invalid', 'laboratory',
    'c8ca0000-0000-4000-8000-000000000021', encode(sha256('state-otp-d'::bytea), 'hex'), 'State Admin', 'laboratory');
  execute 'reset role';
  select ceil(extract(epoch from created_at + interval '1 day' - clock_timestamp()))::integer into expected
    from identity.organization_profile_completion_challenges
   where application_id = current_setting('hid.test.app_s')::uuid
   order by created_at desc offset 9 limit 1;
  if sent is not null or seen.challenge_id is not null or seen.expires_in_seconds is not null
     or abs(seen.resend_after_seconds - expected) > 1 or seen.resend_after_seconds < 70000 then
    raise exception 'At the daily limit the state was % (expected about %), the code %', seen, expected,
      coalesce(sent, 'not sent');
  end if;
end $$;

-- R5 across applications: ten codes reached this email through other
-- self-service applications in the last day; this application has none, and
-- none is sent until the 10th newest of those is a day old.
delete from identity.organization_profile_completion_challenges
 where application_id = current_setting('hid.test.app_s')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-confirmation-0008', true);
do $$
declare
  n integer;
  cac text;
  application_id uuid;
  current_application record;
begin
  for n in 1..10 loop
    cac := 'RC99000712' || lpad(n::text, 2, '0');
    application_id := identity.submit_self_service_organization_application('laboratory', 'laboratory', cac,
      'State Admin', 'state@confirm.invalid', encode(sha256(('state-network-' || n)::bytea), 'hex'));
    select * into current_application from identity.public_get_organization_application(cac,
      'state@confirm.invalid', 'laboratory');
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', substr(cac, 3), cac, 'State Recipient Lab ' || n || ' Ltd',
      'Private Company Limited by Shares', '2020-06-01', '9 Confirmation Road, Lagos', 'active');
    if identity.begin_self_service_provider_enrollment(cac, 'state@confirm.invalid', 'laboratory',
         ('c8cc0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         encode(sha256(('state-recipient-' || n)::bytea), 'hex'), 'State Admin', 'laboratory')
       is distinct from 'state@confirm.invalid' then
      raise exception 'Recipient code % was not sent', n;
    end if;
  end loop;
end $$;
reset role;
update identity.organization_profile_completion_challenges
   set created_at = clock_timestamp() - make_interval(hours => 3, mins => right(id::text, 2)::integer)
 where id::text like 'c8cc0000-%';
do $$
declare
  seen record;
  sent text;
  expected integer;
  versions text;
  challenges text;
begin
  select string_agg(id::text || ':' || row_version::text, ',' order by id) into versions
    from identity.organization_applications where administrator_email = 'state@confirm.invalid';
  select string_agg(id::text || ':' || created_at::text || ':' || coalesce(invalidated_at::text, '-'), ',' order by id)
    into challenges from identity.organization_profile_completion_challenges where id::text like 'c8cc0000-%';
  execute 'set local role hid_identity_api_runtime';
  select * into seen from identity.self_service_provider_code_state('RC9900071003', 'state@confirm.invalid', 'laboratory');
  execute 'reset role';
  -- The state reads only.
  if (select string_agg(id::text || ':' || row_version::text, ',' order by id)
        from identity.organization_applications where administrator_email = 'state@confirm.invalid')
       is distinct from versions
     or (select string_agg(id::text || ':' || created_at::text || ':' || coalesce(invalidated_at::text, '-'), ','
           order by id) from identity.organization_profile_completion_challenges where id::text like 'c8cc0000-%')
       is distinct from challenges then
    raise exception 'The code state changed an application or a code';
  end if;
  execute 'set local role hid_identity_api_runtime';
  sent := identity.begin_self_service_provider_enrollment('RC9900071003', 'state@confirm.invalid', 'laboratory',
    'c8ca0000-0000-4000-8000-000000000031', encode(sha256('state-otp-r'::bytea), 'hex'), 'State Admin', 'laboratory');
  execute 'reset role';
  select ceil(extract(epoch from created_at + interval '1 day' - clock_timestamp()))::integer into expected
    from identity.organization_profile_completion_challenges
   where id::text like 'c8cc0000-%' order by created_at desc offset 9 limit 1;
  if sent is not null or seen.application_open is distinct from true or seen.challenge_id is not null
     or abs(seen.resend_after_seconds - expected) > 1 or seen.resend_after_seconds < 70000 then
    raise exception 'At the recipient''s limit the state was % (expected about %), the code %', seen,
      expected, coalesce(sent, 'not sent');
  end if;
end $$;

-- The code in force is the newest code that can still be entered: newer
-- used, expired, 5-wrong-tries and invalidated codes are not. (Codes 1, 2, 4,
-- 5 and 6 are in the last hour, so 0056's hourly limit holds the next code
-- until code 1 is an hour old; invalidated codes still count, as in 0056.)
delete from identity.organization_profile_completion_challenges where id::text like 'c8cc0000-%';
insert into identity.organization_profile_completion_challenges
  (id, application_id, code_hmac, created_at, expires_at, failed_attempts, consumed_at, invalidated_at,
   session_hmac, session_expires_at)
values
  ('c8cd0000-0000-4000-8000-000000000001', current_setting('hid.test.app_s')::uuid,
   encode(sha256('force-1'::bytea), 'hex'), clock_timestamp() - interval '9 minutes',
   clock_timestamp() + interval '1 minute', 0, null, null, null, null),
  ('c8cd0000-0000-4000-8000-000000000002', current_setting('hid.test.app_s')::uuid,
   encode(sha256('force-2'::bytea), 'hex'), clock_timestamp() - interval '8 minutes',
   clock_timestamp() + interval '2 minutes', 0, clock_timestamp(), null,
   encode(sha256('force-session-2'::bytea), 'hex'), clock_timestamp() + interval '1 hour'),
  ('c8cd0000-0000-4000-8000-000000000003', current_setting('hid.test.app_s')::uuid,
   encode(sha256('force-3'::bytea), 'hex'), clock_timestamp() - interval '61 minutes',
   clock_timestamp() + interval '3 minutes', 0, null, clock_timestamp(), null, null),
  ('c8cd0000-0000-4000-8000-000000000004', current_setting('hid.test.app_s')::uuid,
   encode(sha256('force-4'::bytea), 'hex'), clock_timestamp() - interval '6 minutes',
   clock_timestamp() - interval '1 second', 0, null, null, null, null),
  ('c8cd0000-0000-4000-8000-000000000005', current_setting('hid.test.app_s')::uuid,
   encode(sha256('force-5'::bytea), 'hex'), clock_timestamp() - interval '5 minutes',
   clock_timestamp() + interval '5 minutes', 5, null, null, null, null),
  ('c8cd0000-0000-4000-8000-000000000006', current_setting('hid.test.app_s')::uuid,
   encode(sha256('force-6'::bytea), 'hex'), clock_timestamp() - interval '3 minutes',
   clock_timestamp() + interval '7 minutes', 0, null, null, null, null);
do $$
declare
  seen record;
  expected integer;
begin
  select ceil(extract(epoch from created_at + interval '1 hour' - clock_timestamp()))::integer into expected
    from identity.organization_profile_completion_challenges where id = 'c8cd0000-0000-4000-8000-000000000001';
  execute 'set local role hid_identity_api_runtime';
  select * into seen from identity.self_service_provider_code_state('RC9900071003', 'state@confirm.invalid', 'laboratory');
  execute 'reset role';
  if seen.challenge_id is distinct from 'c8cd0000-0000-4000-8000-000000000006'
     or seen.expires_in_seconds not between 410 and 420 or abs(seen.resend_after_seconds - expected) > 1 then
    raise exception 'With two codes in force the state was % (expected a wait of about %)', seen, expected;
  end if;
  update identity.organization_profile_completion_challenges set invalidated_at = clock_timestamp()
   where id = 'c8cd0000-0000-4000-8000-000000000006';
  execute 'set local role hid_identity_api_runtime';
  select * into seen from identity.self_service_provider_code_state('RC9900071003', 'state@confirm.invalid', 'laboratory');
  execute 'reset role';
  if seen.challenge_id is distinct from 'c8cd0000-0000-4000-8000-000000000001'
     or seen.expires_in_seconds not between 50 and 60 or abs(seen.resend_after_seconds - expected) > 1 then
    raise exception 'The code in force was %', seen;
  end if;
  update identity.organization_profile_completion_challenges set invalidated_at = clock_timestamp()
   where id = 'c8cd0000-0000-4000-8000-000000000001';
  execute 'set local role hid_identity_api_runtime';
  select * into seen from identity.self_service_provider_code_state('RC9900071003', 'state@confirm.invalid', 'laboratory');
  execute 'reset role';
  if seen.challenge_id is not null or seen.expires_in_seconds is not null
     or seen.application_open is distinct from true or abs(seen.resend_after_seconds - expected) > 1 then
    raise exception 'With no code in force the state was %', seen;
  end if;
end $$;

-- No open verified self-service application: another email, an unknown CAC
-- number, another product, a governed application, an activated one and a
-- rejected one; a wrong context.
update identity.organization_applications set status = 'rejected', reviewed_at = clock_timestamp(),
  review_reason = 'Confirmation suite closes the application'
 where id = current_setting('hid.test.app_s')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-confirmation-0009', true);
do $$
declare
  probe record;
  seen record;
begin
  for probe in select * from (values
      ('RC9900071201', 'other@confirm.invalid', 'laboratory'),
      ('RC9900071999', 'state@confirm.invalid', 'laboratory'),
      ('RC9900071201', 'state@confirm.invalid', 'ehr'),
      ('RC9900071002', 'governed@confirm.invalid', 'ehr'),
      ('RC9900071001', 'admin@confirm.invalid', 'ehr'),
      ('RC9900071003', 'state@confirm.invalid', 'laboratory')
    ) as rows(cac, email, product) loop
    select * into seen from identity.self_service_provider_code_state(probe.cac, probe.email, probe.product);
    if seen.application_open is distinct from false or seen.challenge_id is not null
       or seen.expires_in_seconds is not null or seen.resend_after_seconds is not null then
      raise exception 'The state of % % % was %', probe.cac, probe.email, probe.product, seen;
    end if;
  end loop;
end $$;
select set_config('app.actor_subject', 'synthetic:confirmation:super', true),
  set_config('app.correlation_id', 'self-service-confirmation-0010', true);
do $$ begin
  perform identity.self_service_provider_code_state('RC9900071201', 'state@confirm.invalid', 'laboratory');
  raise exception 'A platform administrator''s context read the code state';
exception when insufficient_privilege then
  if sqlerrm <> 'Self-service enrollment context is required' then raise; end if;
end $$;
reset role;

rollback;
