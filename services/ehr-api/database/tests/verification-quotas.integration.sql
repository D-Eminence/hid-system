\set ON_ERROR_STOP on
begin;

insert into auth.accounts(id, subject, status) values
  ('d4900000-0000-4000-8000-000000000001', 'staff:quota-admin', 'active');
insert into auth.account_roles(id, account_id, role_code, scope_type, grant_reason)
values ('d4910000-0000-4000-8000-000000000001',
  'd4900000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
  'Synthetic QoreID request quota test');

set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'quota-integration-test-0001', true);
select set_config('app.actor_subject', 'staff:quota-admin', true);
select set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare attempt integer;
begin
  if has_table_privilege(current_user, 'platform.qoreid_quota_counters', 'SELECT')
    or has_table_privilege(current_user, 'platform.qoreid_test_quota_reservations', 'INSERT')
    or has_table_privilege(current_user, 'platform.public_application_quota_counters', 'DELETE') then
    raise exception 'Identity runtime received direct quota table privilege';
  end if;
  for attempt in 1..3 loop
    perform platform.consume_qoreid_quota('connection_test', null, null,
      lpad(attempt::text,64,'0')::char(64), repeat('a',64)::char(64));
  end loop;
  begin
    perform platform.consume_qoreid_quota('connection_test', null, null,
      lpad('4',64,'0')::char(64), repeat('a',64)::char(64));
    raise exception 'Fourth hourly QoreID connection test was accepted';
  exception when sqlstate 'P4290' then null;
  end;
  begin
    perform platform.consume_qoreid_quota('connection_test', null, null,
      lpad('1',64,'0')::char(64), repeat('a',64)::char(64));
    raise exception 'Duplicate connection-test reservation was accepted';
  exception when sqlstate 'P4090' then null;
  end;
end $$;

select set_config('app.actor_subject', 'system:auth', true);
do $$
declare attempt integer;
begin
  for attempt in 1..10 loop
    perform platform.consume_public_application_quota(repeat('d',64)::char(64));
  end loop;
  begin
    perform platform.consume_public_application_quota(repeat('d',64)::char(64));
    raise exception 'Eleventh hourly public application was accepted';
  exception when sqlstate 'P4290' then null;
  end;
end $$;

reset role;
do $$ begin
  if (select attempt_count from platform.qoreid_quota_counters
      where operation = 'connection_test' and scope_type = 'account' and bucket_period = 'hour') <> 3
    or (select attempt_count from platform.qoreid_quota_counters
      where operation = 'connection_test' and scope_type = 'account' and bucket_period = 'day') <> 3
    or (select count(*) from platform.qoreid_test_quota_reservations) <> 3
    or (select attempt_count from platform.public_application_quota_counters
      where bucket_period = 'hour') <> 10
    or (select attempt_count from platform.public_application_quota_counters
      where bucket_period = 'day') <> 10 then
    raise exception 'Quota denials did not preserve exact committed counters';
  end if;
end $$;

update platform.qoreid_quota_counters set bucket_start = statement_timestamp() - interval '3 days';
update platform.qoreid_test_quota_reservations set reserved_at = statement_timestamp() - interval '3 days';
update platform.public_application_quota_counters set bucket_start = statement_timestamp() - interval '3 days';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$ begin
  if platform.prune_verification_quotas() <> 7 then
    raise exception 'Expired quota rows were not pruned';
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from platform.qoreid_quota_counters) <> 0
    or (select count(*) from platform.qoreid_test_quota_reservations) <> 0
    or (select count(*) from platform.public_application_quota_counters) <> 0 then
    raise exception 'Expired quota rows remain';
  end if;
end $$;

rollback;
