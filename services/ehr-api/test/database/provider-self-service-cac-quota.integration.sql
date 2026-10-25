\set ON_ERROR_STOP on
-- Facility self sign-up's QoreID CAC lookup quota (0086; main 0063, 08c906f,
-- and main's provider-self-service-cac-quota suite, with A6's platform day).
-- Rollback-only. Accountless self-service charges each lookup to a keyed
-- client-network digest (5 an hour, 15 a day), to the application's 0049
-- daily CAC counter shared with the reviewed path (3 a day) and to one
-- platform-wide daily counter whose limit Identity passes (1-100000). A
-- denial returns false, is audited with the exhausted limit and changes no
-- counter. Every command below runs as the exact Identity API runtime role.
--
-- Submitting needs provider_self_service_enabled open, which a platform
-- administrator does through the audited command. See
-- provider-self-enrollment.integration.sql for why FORCE is lifted on the
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

insert into auth.accounts (id, subject, email, display_name, status)
values ('d6300000-0000-4000-8000-000000000001', 'staff:self-service-quota-reviewer',
  'self-service-quota-reviewer@example.invalid', 'Quota Reviewer', 'active');
insert into identity.organizations (id, name, slug)
values ('d6310000-0000-4000-8000-000000000001', 'Quota Review Office', 'quota-review-office');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
values ('d6320000-0000-4000-8000-000000000001', 'd6310000-0000-4000-8000-000000000001',
  'Quota Review Office', 'QUOTA-REVIEW', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
values ('d6330000-0000-4000-8000-000000000001', 'd6300000-0000-4000-8000-000000000001',
  'Quota Reviewer', 'self-service-quota-reviewer@example.invalid', 'verified', 'admin');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('d6340000-0000-4000-8000-000000000001', 'd6330000-0000-4000-8000-000000000001',
  'd6300000-0000-4000-8000-000000000001', 'd6310000-0000-4000-8000-000000000001',
  'd6320000-0000-4000-8000-000000000001', 'admin', 'admin', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
values ('d6350000-0000-4000-8000-000000000001', 'd6300000-0000-4000-8000-000000000001',
  'platform_super_admin', 'platform', 'Synthetic self-service CAC quota test');
-- An administrator-reviewed public application is outside the self-service path.
insert into identity.organization_applications (
  id, product_code, organization_name, organization_type, cac_registration_number,
  administrator_name, administrator_email, status
) values ('d6360000-0000-4000-8000-000000000001', 'ehr', 'Reviewed Intake Clinic', 'clinic',
  'RC9900063199', 'Reviewed Applicant', 'reviewed-intake@example.invalid', 'pending_verification');

do $$ begin
  if to_regprocedure('platform.consume_self_service_cac_quota(uuid,char)') is not null then
    raise exception 'main''s two-argument quota command exists beside the platform-capped one';
  end if;
  if not has_function_privilege('hid_identity_runtime',
       'platform.consume_self_service_cac_quota(uuid,char,integer)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime',
       'platform.consume_self_service_cac_quota(uuid,char,integer)', 'EXECUTE') then
    raise exception 'The Identity runtime cannot charge the self-service CAC quota';
  end if;
  if has_function_privilege('hid_ehr_runtime', 'platform.consume_self_service_cac_quota(uuid,char,integer)', 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime', 'platform.consume_self_service_cac_quota(uuid,char,integer)', 'EXECUTE')
     or has_function_privilege('hid_api_runtime', 'platform.consume_self_service_cac_quota(uuid,char,integer)', 'EXECUTE')
     or has_function_privilege('hid_lab_api_runtime', 'platform.consume_self_service_cac_quota(uuid,char,integer)', 'EXECUTE')
     or has_function_privilege('hid_outreach_api_runtime', 'platform.consume_self_service_cac_quota(uuid,char,integer)', 'EXECUTE') then
    raise exception 'A non-Identity runtime can charge the self-service CAC quota';
  end if;
  if has_table_privilege('hid_identity_api_runtime', 'platform.self_service_cac_quota_counters', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'platform.self_service_cac_quota_counters', 'INSERT')
     or has_table_privilege('hid_identity_api_runtime', 'platform.self_service_cac_quota_counters', 'UPDATE')
     or has_table_privilege('hid_identity_api_runtime', 'platform.self_service_cac_quota_counters', 'DELETE')
     or has_table_privilege('hid_schema_test_runtime', 'platform.self_service_cac_quota_counters', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'platform.self_service_cac_platform_quota_counters', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'platform.self_service_cac_platform_quota_counters', 'INSERT')
     or has_table_privilege('hid_identity_api_runtime', 'platform.self_service_cac_platform_quota_counters', 'UPDATE')
     or has_table_privilege('hid_identity_api_runtime', 'platform.self_service_cac_platform_quota_counters', 'DELETE')
     or has_table_privilege('hid_schema_test_runtime', 'platform.self_service_cac_platform_quota_counters', 'SELECT') then
    raise exception 'A runtime role received direct self-service quota table privilege';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'platform.self_service_cac_quota_counters'::regclass)
     or not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'platform.self_service_cac_platform_quota_counters'::regclass) then
    raise exception 'The self-service quota tables do not force row-level security';
  end if;
end $$;

-- Open facility self sign-up through the audited command.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:self-service-quota-reviewer', true),
  set_config('app.correlation_id', 'self-service-cac-quota-open', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'),
  'CAC quota suite opens facility sign-up');
select set_config('app.purpose_of_use', '', true);

-- Six accountless self-service applications from one client network.
select set_config('app.correlation_id', 'self-service-cac-quota-0001', true);
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare
  attempt integer;
  application uuid;
begin
  for attempt in 1..7 loop
    perform identity.submit_self_service_organization_application('ehr', 'clinic',
      'RC99000631' || lpad(attempt::text, 2, '0'), 'Quota Applicant',
      'quota-' || attempt || '@example.invalid');
  end loop;
  -- Five lookups an hour per network; new CACs and emails do not reset it.
  for attempt in 1..5 loop
    select application_id into application from identity.public_get_organization_application(
      'RC99000631' || lpad(attempt::text, 2, '0'), 'quota-' || attempt || '@example.invalid', 'ehr');
    if not platform.consume_self_service_cac_quota(application, repeat('1', 64)::char(64), 200) then
      raise exception 'Accountless CAC lookup % was refused below the hourly limit', attempt;
    end if;
  end loop;
  select application_id into application from identity.public_get_organization_application(
    'RC9900063106', 'quota-6@example.invalid', 'ehr');
  if platform.consume_self_service_cac_quota(application, repeat('1', 64)::char(64), 200) then
    raise exception 'A sixth hourly accountless CAC lookup from one network was admitted';
  end if;
  -- The platform limit is validated before any counter or audit row is written.
  begin
    perform platform.consume_self_service_cac_quota(application, repeat('1', 64)::char(64), 0);
    raise exception 'A platform limit of 0 was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'QOREID_QUOTA_LIMIT_INVALID' then raise; end if;
  end;
  begin
    perform platform.consume_self_service_cac_quota(application, repeat('1', 64)::char(64), 100001);
    raise exception 'A platform limit above 100000 was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform platform.consume_self_service_cac_quota(application, repeat('1', 64)::char(64), null);
    raise exception 'A missing platform limit was accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;

do $$ begin
  if (select attempt_count from platform.self_service_cac_quota_counters
      where network_digest = repeat('1', 64) and bucket_period = 'hour') <> 5
     or (select attempt_count from platform.self_service_cac_quota_counters
      where network_digest = repeat('1', 64) and bucket_period = 'day') <> 5
     or (select attempt_count from platform.self_service_cac_platform_quota_counters
      where bucket_start = date_trunc('day', statement_timestamp())) <> 5
     or (select count(*) from platform.self_service_cac_platform_quota_counters) <> 1
     or (select count(*) from platform.qoreid_quota_counters counter
      join identity.organization_applications application on application.id = counter.scope_id
      where counter.operation = 'application_cac' and counter.scope_type = 'target'
        and application.cac_registration_number like 'RC99000631%' and counter.attempt_count = 1) <> 5
     or exists (select 1 from platform.qoreid_quota_counters counter
      join identity.organization_applications application on application.id = counter.scope_id
      where application.cac_registration_number = 'RC9900063106') then
    raise exception 'The refused hourly lookup changed a counter';
  end if;
end $$;

-- The daily network limit (15) holds across hours.
update platform.self_service_cac_quota_counters
   set bucket_start = bucket_start - interval '1 hour'
 where bucket_period = 'hour' and bucket_start = date_trunc('hour', statement_timestamp());
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare
  attempt integer;
  application uuid;
begin
  for attempt in 1..5 loop
    select application_id into application from identity.public_get_organization_application(
      'RC99000631' || lpad(attempt::text, 2, '0'), 'quota-' || attempt || '@example.invalid', 'ehr');
    if not platform.consume_self_service_cac_quota(application, repeat('1', 64)::char(64), 200) then
      raise exception 'Second-hour lookup % was refused', attempt;
    end if;
  end loop;
end $$;
reset role;
update platform.self_service_cac_quota_counters
   set bucket_start = bucket_start - interval '2 hours'
 where bucket_period = 'hour' and bucket_start = date_trunc('hour', statement_timestamp());
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare
  attempt integer;
  application uuid;
begin
  for attempt in 1..5 loop
    select application_id into application from identity.public_get_organization_application(
      'RC99000631' || lpad(attempt::text, 2, '0'), 'quota-' || attempt || '@example.invalid', 'ehr');
    if not platform.consume_self_service_cac_quota(application, repeat('1', 64)::char(64), 200) then
      raise exception 'Third-hour lookup % was refused', attempt;
    end if;
  end loop;
end $$;
reset role;
update platform.self_service_cac_quota_counters
   set bucket_start = bucket_start - interval '3 hours'
 where bucket_period = 'hour' and bucket_start = date_trunc('hour', statement_timestamp());
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare application uuid;
begin
  select application_id into application from identity.public_get_organization_application(
    'RC9900063106', 'quota-6@example.invalid', 'ehr');
  if platform.consume_self_service_cac_quota(application, repeat('1', 64)::char(64), 200) then
    raise exception 'A sixteenth daily accountless CAC lookup from one network was admitted';
  end if;

  -- Another network cannot exceed one application's three lookups a day,
  -- and its refused attempt is not charged to that network.
  select application_id into application from identity.public_get_organization_application(
    'RC9900063101', 'quota-1@example.invalid', 'ehr');
  if platform.consume_self_service_cac_quota(application, repeat('2', 64)::char(64), 200) then
    raise exception 'A fourth daily lookup for one application was admitted';
  end if;
  select application_id into application from identity.public_get_organization_application(
    'RC9900063106', 'quota-6@example.invalid', 'ehr');
  if not platform.consume_self_service_cac_quota(application, repeat('2', 64)::char(64), 200) then
    raise exception 'A fresh network was refused for an application under its limit';
  end if;
end $$;
reset role;

do $$ begin
  if (select attempt_count from platform.self_service_cac_quota_counters
      where network_digest = repeat('1', 64) and bucket_period = 'day') <> 15
     or (select attempt_count from platform.self_service_cac_quota_counters
      where network_digest = repeat('2', 64) and bucket_period = 'hour') <> 1
     or (select attempt_count from platform.self_service_cac_quota_counters
      where network_digest = repeat('2', 64) and bucket_period = 'day') <> 1
     or (select attempt_count from platform.self_service_cac_platform_quota_counters) <> 16
     or (select max(counter.attempt_count) from platform.qoreid_quota_counters counter
      join identity.organization_applications application on application.id = counter.scope_id
      where application.cac_registration_number like 'RC99000631%') <> 3 then
    raise exception 'Network, application and platform counters are not exact after denials';
  end if;
end $$;

-- A6: the platform day. With 16 lookups made today, a limit of 16 refuses a
-- fresh network for a fresh application and changes no counter; 17 admits it.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare application uuid;
begin
  select application_id into application from identity.public_get_organization_application(
    'RC9900063107', 'quota-7@example.invalid', 'ehr');
  if platform.consume_self_service_cac_quota(application, repeat('4', 64)::char(64), 16) then
    raise exception 'A lookup over the platform daily limit was admitted';
  end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from platform.self_service_cac_quota_counters where network_digest = repeat('4', 64))
     or exists (select 1 from platform.qoreid_quota_counters counter
      join identity.organization_applications application on application.id = counter.scope_id
      where application.cac_registration_number = 'RC9900063107')
     or (select attempt_count from platform.self_service_cac_platform_quota_counters) <> 16 then
    raise exception 'The platform-day denial changed a counter';
  end if;
end $$;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare application uuid;
begin
  select application_id into application from identity.public_get_organization_application(
    'RC9900063107', 'quota-7@example.invalid', 'ehr');
  if not platform.consume_self_service_cac_quota(application, repeat('4', 64)::char(64), 17) then
    raise exception 'A lookup within a raised platform daily limit was refused';
  end if;
end $$;
reset role;
do $$ begin
  if (select attempt_count from platform.self_service_cac_platform_quota_counters) <> 17
     or (select attempt_count from platform.self_service_cac_quota_counters
      where network_digest = repeat('4', 64) and bucket_period = 'day') <> 1 then
    raise exception 'The admitted lookup was not charged to the platform day and its network';
  end if;
end $$;

-- Only the accountless system context, a valid digest, and a self-service
-- application awaiting CAC verification can charge this quota.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare application uuid;
begin
  select application_id into application from identity.public_get_organization_application(
    'RC9900063106', 'quota-6@example.invalid', 'ehr');
  begin
    perform platform.consume_self_service_cac_quota(application, repeat('A', 64)::char(64), 200);
    raise exception 'A malformed network digest was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform platform.consume_self_service_cac_quota(null, repeat('3', 64)::char(64), 200);
    raise exception 'A missing application was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform platform.consume_self_service_cac_quota(gen_random_uuid(), repeat('3', 64)::char(64), 200);
    raise exception 'An unknown application was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform platform.consume_self_service_cac_quota('d6360000-0000-4000-8000-000000000001', repeat('3', 64)::char(64), 200);
    raise exception 'An administrator-reviewed application used the self-service quota';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.correlation_id', '', true);
  begin
    perform platform.consume_self_service_cac_quota(application, repeat('3', 64)::char(64), 200);
    raise exception 'A lookup without a correlation ID was accepted';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.correlation_id', 'self-service-cac-quota-0001', true);
  -- The account-scoped application_cac path still refuses accountless callers.
  begin
    perform platform.consume_qoreid_quota('application_cac', application, null, null, null);
    raise exception 'The reviewer CAC quota admitted an accountless caller';
  exception when insufficient_privilege then null;
  end;
end $$;

-- An authenticated reviewer cannot use the accountless command, and keeps the
-- unchanged 0049 application_cac rules, sharing the per-application limit.
select set_config('app.actor_subject', 'staff:self-service-quota-reviewer', true);
select set_config('app.purpose_of_use', 'healthcare-operations', true);
select set_config('app.membership_id', 'd6340000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', 'd6320000-0000-4000-8000-000000000001', true);
do $$
declare
  exhausted uuid;
  available uuid;
begin
  perform set_config('app.actor_subject', 'system:auth', true);
  select application_id into exhausted from identity.public_get_organization_application(
    'RC9900063101', 'quota-1@example.invalid', 'ehr');
  select application_id into available from identity.public_get_organization_application(
    'RC9900063106', 'quota-6@example.invalid', 'ehr');
  perform set_config('app.actor_subject', 'staff:self-service-quota-reviewer', true);
  begin
    perform platform.consume_self_service_cac_quota(available, repeat('3', 64)::char(64), 200);
    raise exception 'An authenticated actor used the accountless CAC quota';
  exception when insufficient_privilege then null;
  end;
  begin
    perform platform.consume_qoreid_quota('application_cac', exhausted, null, null, null);
    raise exception 'The reviewer path exceeded the shared per-application limit';
  exception when sqlstate 'P4290' then null;
  end;
  perform platform.consume_qoreid_quota('application_cac', available, null, null, null);
end $$;
reset role;

do $$ begin
  if (select attempt_count from platform.qoreid_quota_counters
      where operation = 'application_cac' and scope_type = 'account'
        and scope_id = 'd6300000-0000-4000-8000-000000000001' and bucket_period = 'hour') <> 1
     or (select counter.attempt_count from platform.qoreid_quota_counters counter
      join identity.organization_applications application on application.id = counter.scope_id
      where application.cac_registration_number = 'RC9900063106') <> 2 then
    raise exception 'The reviewer application_cac counters changed shape';
  end if;
end $$;

-- Once the CAC is verified, no further accountless lookup can be charged.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
select set_config('app.purpose_of_use', '', true);
select set_config('app.membership_id', '', true);
select set_config('app.facility_id', '', true);
do $$
declare current_application record;
begin
  select * into current_application from identity.public_get_organization_application(
    'RC9900063105', 'quota-5@example.invalid', 'ehr');
  perform identity.public_record_organization_cac_result(current_application.application_id,
    current_application.row_version, 'verified', '990063', 'RC9900063105', 'Quota Verified Clinic Ltd',
    'Private Company Limited by Shares', '2021-01-01', '1 Synthetic Registry Road, Lagos', 'active');
  begin
    perform platform.consume_self_service_cac_quota(current_application.application_id, repeat('3', 64)::char(64), 200);
    raise exception 'A verified application was charged another accountless lookup';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Every decision is audited without CAC numbers, emails or raw addresses.
do $$ begin
  if (select count(*) from audit.events where action = 'identity.organization.self-service.cac-quota'
      and outcome = 'success') <> 17
     or (select array_agg(details ->> 'exhaustedLimit' order by sequence_id) from audit.events
      where action = 'identity.organization.self-service.cac-quota' and outcome = 'denied')
      is distinct from array['network_hour', 'network_day', 'application_day', 'platform_day']
     or (select details ->> 'platformDailyLimit' from audit.events
      where action = 'identity.organization.self-service.cac-quota' and outcome = 'denied'
        and details ->> 'exhaustedLimit' = 'platform_day') <> '16'
     or exists (select 1 from audit.events
      where action = 'identity.organization.self-service.cac-quota'
        and (actor_type <> 'system' or resource_type <> 'organization-application' or resource_uuid is null
          or details ->> 'operation' <> 'self_service_cac'
          or details ->> 'networkDigest' !~ '^[a-f0-9]{64}$'
          or details::text ~ 'RC99000631|example\.invalid')) then
    raise exception 'Self-service CAC quota decisions were not audited exactly';
  end if;
end $$;

-- Hourly retention also drains the network and platform counters.
update platform.self_service_cac_quota_counters set bucket_start = bucket_start - interval '3 days';
update platform.self_service_cac_platform_quota_counters set bucket_start = bucket_start - interval '3 days';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$ begin
  if platform.prune_verification_quotas() < 5 then
    raise exception 'Expired self-service quota rows were not pruned';
  end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from platform.self_service_cac_quota_counters)
     or exists (select 1 from platform.self_service_cac_platform_quota_counters) then
    raise exception 'Expired self-service quota rows remain';
  end if;
end $$;

rollback;
