\set ON_ERROR_STOP on
begin;

-- 0085: public patient enrollment charges each QoreID NIN lookup, before any
-- account exists, to a keyed digest of the client network (an IPv4 address or
-- an IPv6 /64, computed by the Identity API) per hour and per day, and to one
-- platform-wide daily cap. The Identity API passes the limits from its
-- configuration; small limits keep this suite short. Every command below runs
-- as the exact Identity API runtime role.

do $$ begin
  if not has_function_privilege('hid_identity_runtime',
       'platform.consume_public_patient_nin_quota(char,integer,integer,integer)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime',
       'platform.consume_public_patient_nin_quota(char,integer,integer,integer)', 'EXECUTE') then
    raise exception 'The Identity runtime cannot charge the public enrollment NIN lookup quota';
  end if;
  if has_function_privilege('public', 'platform.consume_public_patient_nin_quota(char,integer,integer,integer)', 'EXECUTE')
     or has_function_privilege('hid_ehr_runtime', 'platform.consume_public_patient_nin_quota(char,integer,integer,integer)', 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime', 'platform.consume_public_patient_nin_quota(char,integer,integer,integer)', 'EXECUTE')
     or has_function_privilege('hid_api_runtime', 'platform.consume_public_patient_nin_quota(char,integer,integer,integer)', 'EXECUTE')
     or has_function_privilege('hid_notification_runtime', 'platform.consume_public_patient_nin_quota(char,integer,integer,integer)', 'EXECUTE') then
    raise exception 'A role other than the Identity runtime can charge the public enrollment NIN lookup quota';
  end if;
  if has_table_privilege('hid_identity_api_runtime', 'platform.public_patient_nin_quota_counters', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'platform.public_patient_nin_quota_counters', 'INSERT')
     or has_table_privilege('hid_identity_api_runtime', 'platform.public_patient_nin_quota_counters', 'UPDATE')
     or has_table_privilege('hid_identity_api_runtime', 'platform.public_patient_nin_quota_counters', 'DELETE')
     or has_table_privilege('hid_schema_test_runtime', 'platform.public_patient_nin_quota_counters', 'SELECT') then
    raise exception 'A runtime role received direct NIN lookup quota table privilege';
  end if;
  if not (select relforcerowsecurity from pg_class where oid = 'platform.public_patient_nin_quota_counters'::regclass)
     or not (select prosecdef from pg_proc
       where oid = 'platform.consume_public_patient_nin_quota(char,integer,integer,integer)'::regprocedure) then
    raise exception 'The NIN lookup quota is not a definer command over a forced row-security table';
  end if;
end $$;

-- Network A: two lookups an hour, three a day; ten a day in all.
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'public-nin-quota-0001', true);
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare attempt integer;
begin
  for attempt in 1..2 loop
    if not platform.consume_public_patient_nin_quota(repeat('a', 64)::char(64), 2, 3, 10) then
      raise exception 'Lookup % from network A was refused below its hourly limit', attempt;
    end if;
  end loop;
  if platform.consume_public_patient_nin_quota(repeat('a', 64)::char(64), 2, 3, 10) then
    raise exception 'A third lookup in one hour from network A was admitted';
  end if;
end $$;
reset role;

do $$ begin
  if (select attempt_count from platform.public_patient_nin_quota_counters
      where scope = 'network' and scope_key = repeat('a', 64) and bucket_period = 'hour') <> 2
     or (select attempt_count from platform.public_patient_nin_quota_counters
      where scope = 'network' and scope_key = repeat('a', 64) and bucket_period = 'day') <> 2
     or (select attempt_count from platform.public_patient_nin_quota_counters
      where scope = 'platform' and scope_key = 'all' and bucket_period = 'day') <> 2 then
    raise exception 'The refused hourly lookup changed a counter';
  end if;
end $$;

-- The daily network limit holds across hours.
update platform.public_patient_nin_quota_counters
   set bucket_start = bucket_start - interval '1 hour'
 where bucket_period = 'hour' and bucket_start = date_trunc('hour', statement_timestamp());
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$ begin
  if not platform.consume_public_patient_nin_quota(repeat('a', 64)::char(64), 2, 3, 10) then
    raise exception 'A lookup in a new hour was refused below the daily network limit';
  end if;
  if platform.consume_public_patient_nin_quota(repeat('a', 64)::char(64), 2, 3, 10) then
    raise exception 'A fourth lookup in one day from network A was admitted';
  end if;
end $$;
reset role;

-- The platform-wide daily cap holds across networks: three lookups so far,
-- so a cap of five admits two more from other networks and then refuses
-- every network, one with an unused hourly and daily budget included.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$ begin
  if not platform.consume_public_patient_nin_quota(repeat('b', 64)::char(64), 2, 3, 5)
     or not platform.consume_public_patient_nin_quota(repeat('b', 64)::char(64), 2, 3, 5) then
    raise exception 'Network B was refused below the platform cap';
  end if;
  if platform.consume_public_patient_nin_quota(repeat('c', 64)::char(64), 2, 3, 5) then
    raise exception 'A lookup above the platform daily cap was admitted';
  end if;
end $$;
reset role;

do $$ begin
  if (select attempt_count from platform.public_patient_nin_quota_counters
      where scope = 'platform' and bucket_period = 'day') <> 5
     or exists (select 1 from platform.public_patient_nin_quota_counters where scope_key = repeat('c', 64)) then
    raise exception 'A lookup refused by the platform cap changed a network counter';
  end if;
end $$;

-- Only the accountless system context, a well-formed digest and limits
-- within the documented bounds can charge it.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare
  limits integer[];
begin
  begin
    perform platform.consume_public_patient_nin_quota(repeat('A', 64)::char(64), 2, 3, 10);
    raise exception 'A malformed network digest was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform platform.consume_public_patient_nin_quota(null, 2, 3, 10);
    raise exception 'A missing network digest was accepted';
  exception when insufficient_privilege then null;
  end;
  foreach limits slice 1 in array array[[0, 3, 10], [2, 1, 10], [101, 200, 10], [2, 1001, 10],
      [2, 3, 0], [2, 3, 100001]] loop
    begin
      perform platform.consume_public_patient_nin_quota(repeat('d', 64)::char(64), limits[1], limits[2], limits[3]);
      raise exception 'The limits % were accepted', limits;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform platform.consume_public_patient_nin_quota(repeat('d', 64)::char(64), null, 3, 10);
    raise exception 'A missing limit was accepted';
  exception when invalid_parameter_value then null;
  end;
  perform set_config('app.correlation_id', '', true);
  begin
    perform platform.consume_public_patient_nin_quota(repeat('d', 64)::char(64), 2, 3, 10);
    raise exception 'A lookup without a correlation ID was accepted';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.correlation_id', 'public-nin-quota-0001', true);
  perform set_config('app.actor_subject', 'patient:someone', true);
  begin
    perform platform.consume_public_patient_nin_quota(repeat('d', 64)::char(64), 2, 3, 10);
    raise exception 'An actor other than the accountless system context charged the quota';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$ begin
  if exists (select 1 from platform.public_patient_nin_quota_counters where scope_key = repeat('d', 64)) then
    raise exception 'A refused call wrote a counter';
  end if;
end $$;

-- Every decision is audited, denials with the exhausted limit, without a raw address.
do $$ begin
  if (select count(*) from audit.events where action = 'identity.public-patient-enrollment.nin-lookup-quota'
      and outcome = 'success') <> 5
     or (select array_agg(details ->> 'exhaustedLimit' order by sequence_id) from audit.events
      where action = 'identity.public-patient-enrollment.nin-lookup-quota' and outcome = 'denied')
      is distinct from array['network_hour', 'network_day', 'platform_day']
     or exists (select 1 from audit.events
      where action = 'identity.public-patient-enrollment.nin-lookup-quota'
        and (actor_type <> 'system' or resource_type <> 'qoreid-lookup-quota' or resource_id <> 'patient_nin'
          or correlation_id <> 'public-nin-quota-0001' or patient_id is not null or source_ip is not null
          or details ->> 'operation' <> 'public_patient_nin'
          or details ->> 'networkDigest' !~ '^[a-f0-9]{64}$'
          or (outcome = 'success') <> (details ->> 'exhaustedLimit' is null))) then
    raise exception 'NIN lookup quota decisions were not audited exactly';
  end if;
end $$;

-- Hourly retention also drains these counters.
update platform.public_patient_nin_quota_counters set bucket_start = bucket_start - interval '3 days';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$ begin
  if platform.prune_verification_quotas() < 6 then
    raise exception 'Expired NIN lookup quota rows were not pruned';
  end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from platform.public_patient_nin_quota_counters) then
    raise exception 'Expired NIN lookup quota rows remain';
  end if;
end $$;

rollback;
