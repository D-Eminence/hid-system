\set ON_ERROR_STOP on
-- An unactivated self-service application lapses 24 hours after it was
-- submitted (0086, A8 with CRITIC C9). Rollback-only. Every command runs as
-- the exact Identity API runtime role in Identity's accountless system context.
--
--   1. within 24 hours an open self-service application holds its CAC and
--      product: another email needs manual resolution (main's 23514);
--   2. after 24 hours the next self-service submit for that CAC and product
--      by another email rejects it (reviewed_at set, the lapse reason, no
--      reviewer, row_version bumped), invalidates every email challenge and
--      completion session it had, audits identity.organization.self-service.lapse
--      without CAC or email, and opens a new application; the old session can
--      no longer activate, and a verified (ready_for_review) application lapses
--      the same way; its own email resumes it instead, without renewing it
--      (review fix R3), so its holder cannot extend the hold;
--   3. an activated (approved) self-service application never lapses: the CAC
--      stays registered; a governed (admin_review) application never lapses;
--   4. the governed submit lapses a stale self-service application too and
--      opens a governed one (C9); a fresh one is still returned to it, as before.
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
  ('c8800000-0000-4000-8000-000000000001', 'synthetic:lapse:super', 'super@lapse.invalid', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c8810000-0000-4000-8000-000000000001', 'c8800000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', 'Lapse suite super admin');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:lapse:super', true),
  set_config('app.correlation_id', 'self-service-lapse-open', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'Lapse suite opens facility sign-up');

-- A squatter verifies the CAC and its email, then never activates. A second
-- application is left pending, a third is activated.
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-lapse-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  squatted uuid; pending uuid; activated_application uuid; current_application record;
begin
  squatted := identity.submit_self_service_organization_application('ehr', 'hospital',
    'RC9900066001', 'Squatter', 'squatter@lapse.invalid');
  select * into current_application from identity.public_get_organization_application(
    'RC9900066001', 'squatter@lapse.invalid', 'ehr');
  perform identity.public_record_organization_cac_result(squatted, current_application.row_version,
    'verified', '9900066001', 'RC9900066001', 'Lapse Hospital Ltd',
    'Private Company Limited by Shares', '2017-05-01', '1 Lapse Road, Lagos', 'active');
  perform identity.begin_organization_profile_completion('RC9900066001', 'squatter@lapse.invalid', 'ehr',
    'c8890000-0000-4000-8000-000000000001', encode(sha256('lapse-otp-1'::bytea), 'hex'));
  if not identity.verify_organization_profile_completion_challenge('c8890000-0000-4000-8000-000000000001',
      encode(sha256('lapse-otp-1'::bytea), 'hex'), encode(sha256('lapse-session-1'::bytea), 'hex')) then
    raise exception 'The squatter''s email was not verified';
  end if;
  pending := identity.submit_self_service_organization_application('laboratory', 'laboratory',
    'RC9900066002', 'Pending Lab Admin', 'pending@lapse.invalid');

  activated_application := identity.submit_self_service_organization_application('pharmacy', 'pharmacy',
    'RC9900066003', 'Activated Admin', 'activated@lapse.invalid');
  select * into current_application from identity.public_get_organization_application(
    'RC9900066003', 'activated@lapse.invalid', 'pharmacy');
  perform identity.public_record_organization_cac_result(activated_application, current_application.row_version,
    'verified', '9900066003', 'RC9900066003', 'Lapse Pharmacy Ltd',
    'Private Company Limited by Shares', '2017-05-03', '3 Lapse Road, Lagos', 'active');
  perform identity.begin_organization_profile_completion('RC9900066003', 'activated@lapse.invalid', 'pharmacy',
    'c8890000-0000-4000-8000-000000000003', encode(sha256('lapse-otp-3'::bytea), 'hex'));
  perform identity.verify_organization_profile_completion_challenge('c8890000-0000-4000-8000-000000000003',
    encode(sha256('lapse-otp-3'::bytea), 'hex'), encode(sha256('lapse-session-3'::bytea), 'hex'));
  perform identity.activate_self_service_provider_enrollment(encode(sha256('lapse-session-3'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  -- A second, unconsumed challenge for the squatted application.
  perform set_config('hid.test.squatted', squatted::text, true);
  perform set_config('hid.test.pending', pending::text, true);
  perform set_config('hid.test.activated', activated_application::text, true);

  -- 1. Within 24 hours the squatter's application holds the CAC.
  begin
    perform identity.submit_self_service_organization_application('ehr', 'hospital',
      'RC9900066001', 'Real Administrator', 'real.admin@lapse.invalid');
    raise exception 'Another email took over a fresh self-service application';
  exception when check_violation then
    if sqlerrm <> 'This organization application requires manual resolution' then raise; end if;
  end;
end $$;
reset role;

-- A governed application older than 24 hours, an unconsumed challenge on the
-- squatted application, and 23 hours 59 minutes of age everywhere.
insert into identity.organization_applications (
  id, product_code, organization_type, cac_registration_number, administrator_name, administrator_email,
  created_at
) values ('c8840000-0000-4000-8000-000000000004', 'ehr', 'clinic', 'RC9900066004', 'Governed Admin',
  'governed@lapse.invalid', clock_timestamp() - interval '30 hours');
insert into identity.organization_profile_completion_challenges (id, application_id, code_hmac, expires_at)
values ('c8890000-0000-4000-8000-000000000002', current_setting('hid.test.squatted')::uuid,
  encode(sha256('lapse-otp-2'::bytea), 'hex'), clock_timestamp() + interval '10 minutes');
update identity.organization_applications
   set created_at = clock_timestamp() - interval '23 hours 59 minutes'
 where id in (current_setting('hid.test.squatted')::uuid, current_setting('hid.test.pending')::uuid);
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-lapse-0002', true);
do $$
begin
  perform identity.submit_self_service_organization_application('ehr', 'hospital',
    'RC9900066001', 'Real Administrator', 'real.admin@lapse.invalid');
  raise exception 'An application younger than 24 hours lapsed';
exception when check_violation then
  if sqlerrm <> 'This organization application requires manual resolution' then raise; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from audit.events where action = 'identity.organization.self-service.lapse') then
    raise exception 'A lapse was audited before 24 hours';
  end if;
end $$;

-- 2. After 24 hours.
update identity.organization_applications
   set created_at = clock_timestamp() - interval '24 hours 1 minute'
 where id in (current_setting('hid.test.squatted')::uuid, current_setting('hid.test.pending')::uuid,
   current_setting('hid.test.activated')::uuid);
select set_config('hid.test.squatted_version',
  (select row_version::text from identity.organization_applications where id = current_setting('hid.test.squatted')::uuid), true);
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-lapse-0003', true);
do $$
declare replacement uuid; current_application record; message text;
begin
  replacement := identity.submit_self_service_organization_application('ehr', 'hospital',
    'RC9900066001', 'Real Administrator', 'real.admin@lapse.invalid');
  if replacement = current_setting('hid.test.squatted')::uuid then
    raise exception 'The stale application was returned instead of lapsing';
  end if;
  perform set_config('hid.test.replacement', replacement::text, true);
  select * into current_application from identity.public_get_organization_application(
    'RC9900066001', 'squatter@lapse.invalid', 'ehr');
  if current_application.application_id is not null then
    raise exception 'The lapsed application is still readable as open';
  end if;
  select * into current_application from identity.public_get_organization_application(
    'RC9900066001', 'real.admin@lapse.invalid', 'ehr');
  if current_application.application_id is distinct from replacement
     or current_application.application_status <> 'pending_verification' then
    raise exception 'The new application is not open: %', row_to_json(current_application);
  end if;
  -- The squatter's verified session can no longer activate.
  if exists (select 1 from identity.current_organization_profile_completion(encode(sha256('lapse-session-1'::bytea), 'hex'))) then
    raise exception 'The lapsed application''s session is still live';
  end if;
  begin
    perform identity.activate_self_service_provider_enrollment(encode(sha256('lapse-session-1'::bytea), 'hex'),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    raise exception 'A lapsed application was activated';
  exception when insufficient_privilege then
    if sqlerrm <> 'Organization enrollment session is invalid' then raise; end if;
  end;
  -- Its unconsumed email code no longer verifies either.
  if identity.verify_organization_profile_completion_challenge('c8890000-0000-4000-8000-000000000002',
      encode(sha256('lapse-otp-2'::bytea), 'hex'), encode(sha256('lapse-session-2'::bytea), 'hex')) then
    raise exception 'A lapsed application''s email code verified';
  end if;

  -- R3: the stale application's own email resumes it and renews nothing;
  -- another email then lapses it.
  if identity.submit_self_service_organization_application('laboratory', 'laboratory',
       'RC9900066002', 'Pending Lab Admin', 'pending@lapse.invalid') <> current_setting('hid.test.pending')::uuid
     or (select application.application_status from identity.public_get_organization_application(
           'RC9900066002', 'pending@lapse.invalid', 'laboratory') application) <> 'pending_verification' then
    raise exception 'A stale application was not resumed by its own email';
  end if;
  if identity.submit_self_service_organization_application('laboratory', 'laboratory',
       'RC9900066002', 'Other Lab Admin', 'other.lab@lapse.invalid') = current_setting('hid.test.pending')::uuid then
    raise exception 'Another email did not lapse a stale application its own email had resumed';
  end if;

  -- 3. An activated application is never lapsed; a governed one neither.
  begin
    perform identity.submit_self_service_organization_application('pharmacy', 'pharmacy',
      'RC9900066003', 'Someone Else', 'someone.else@lapse.invalid');
    raise exception 'An activated application was replaced';
  exception when check_violation then
    get stacked diagnostics message = message_text;
    if message <> 'This organization application requires manual resolution' then raise; end if;
  end;
  begin
    perform identity.submit_self_service_organization_application('pharmacy', 'pharmacy',
      'RC9900066003', 'Activated Admin', 'activated@lapse.invalid');
    raise exception 'An activated application''s CAC was submitted again';
  exception when check_violation then
    if sqlerrm <> 'This CAC is already registered with HID' then raise; end if;
  end;
  begin
    perform identity.submit_self_service_organization_application('ehr', 'clinic',
      'RC9900066004', 'Governed Admin', 'governed@lapse.invalid');
    raise exception 'A governed application was taken over by self-service';
  exception when check_violation then
    if sqlerrm <> 'This organization application requires manual resolution' then raise; end if;
  end;
end $$;
reset role;

do $$
declare lapsed record;
begin
  select * into lapsed from identity.organization_applications
   where id = current_setting('hid.test.squatted')::uuid;
  if lapsed.status <> 'rejected' or lapsed.approval_mode <> 'self_service'
     or lapsed.reviewed_at is null or lapsed.reviewed_by_account_id is not null
     or lapsed.review_reason <> 'Self-service application lapsed: not activated within 24 hours of submission'
     or lapsed.row_version <> current_setting('hid.test.squatted_version')::bigint + 1
     or lapsed.verification_result <> 'verified' or lapsed.profile_state <> 'complete'
     or lapsed.self_service_reviewed_at is not null then
    raise exception 'The squatted application did not lapse exactly: %', row_to_json(lapsed);
  end if;
  if exists (select 1 from identity.organization_profile_completion_challenges challenge
              where challenge.application_id = lapsed.id and challenge.invalidated_at is null)
     or (select count(*) from identity.organization_profile_completion_challenges challenge
          where challenge.application_id = lapsed.id) <> 2 then
    raise exception 'The lapsed application''s challenges were not all invalidated';
  end if;
  if not exists (select 1 from identity.organization_applications application
                  where application.id = current_setting('hid.test.pending')::uuid and application.status = 'rejected')
     or not exists (select 1 from identity.organization_applications application
                     where application.id = current_setting('hid.test.activated')::uuid and application.status = 'approved')
     or not exists (select 1 from identity.organization_applications application
                     where application.id = 'c8840000-0000-4000-8000-000000000004'
                       and application.status = 'pending_verification')
     or (select count(*) from identity.organization_applications application
          where application.cac_registration_number in ('RC9900066001', 'RC9900066002')
            and application.status <> 'rejected' and application.approval_mode = 'self_service'
            and application.created_at > clock_timestamp() - interval '1 hour') <> 2 then
    raise exception 'The applications around the lapse are wrong';
  end if;
  if (select array_agg(event.resource_uuid order by event.sequence_id) from audit.events event
       where event.action = 'identity.organization.self-service.lapse')
       is distinct from array[lapsed.id, current_setting('hid.test.pending')::uuid]
     or exists (select 1 from audit.events event
                 where event.action = 'identity.organization.self-service.lapse'
                   and (event.actor_type <> 'system' or event.outcome <> 'success'
                     or event.resource_type <> 'organization-application'
                     or event.correlation_id <> 'self-service-lapse-0003'
                     or event.details ->> 'lapseAfterHours' <> '24'
                     or event.details ->> 'previousStatus' not in ('pending_verification', 'ready_for_review')
                     or event.details::text ~ 'RC99000660|lapse\.invalid')) then
    raise exception 'The lapses were not audited exactly';
  end if;
  if (select details ->> 'previousStatus' from audit.events
       where action = 'identity.organization.self-service.lapse' and resource_uuid = lapsed.id) <> 'ready_for_review' then
    raise exception 'The verified application''s lapse did not record its previous status';
  end if;
end $$;

-- 4. C9: the governed submit lapses a stale self-service application and
-- opens a governed one; a fresh self-service application is still returned.
update identity.organization_applications
   set created_at = clock_timestamp() - interval '25 hours'
 where id = current_setting('hid.test.replacement')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'self-service-lapse-0004', true);
do $$
declare governed uuid; fresh uuid;
begin
  governed := identity.submit_organization_application('ehr', 'hospital', 'RC9900066001',
    'Governed Applicant', 'governed.applicant@lapse.invalid');
  if governed = current_setting('hid.test.replacement')::uuid then
    raise exception 'The governed submit returned a stale self-service application';
  end if;
  perform set_config('hid.test.governed', governed::text, true);
  fresh := identity.submit_self_service_organization_application('migrate', 'clinic', 'RC9900066005',
    'Fresh Admin', 'fresh@lapse.invalid');
  if identity.submit_organization_application('migrate', 'clinic', 'RC9900066005',
       'Governed Applicant', 'governed.applicant@lapse.invalid') <> fresh then
    raise exception 'The governed submit no longer returns a fresh open application';
  end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from identity.organization_applications application
                  where application.id = current_setting('hid.test.governed')::uuid
                    and application.approval_mode = 'admin_review' and application.status = 'pending_verification'
                    and application.administrator_email = 'governed.applicant@lapse.invalid')
     or not exists (select 1 from identity.organization_applications application
                     where application.id = current_setting('hid.test.replacement')::uuid
                       and application.status = 'rejected')
     or (select count(*) from audit.events where action = 'identity.organization.self-service.lapse'
          and correlation_id = 'self-service-lapse-0004') <> 1 then
    raise exception 'The governed submit did not lapse the stale self-service application';
  end if;
end $$;

rollback;
