-- Shared counters bound QoreID requests across Identity API instances. Keys are
-- canonical account, organization, or application UUIDs. Never store submitted
-- NIN/CAC numbers, IP addresses, provider payloads, or OAuth material here.
create table platform.qoreid_quota_counters (
  operation text not null check (operation in ('patient_nin', 'existing_cac', 'application_cac', 'connection_test')),
  scope_type text not null check (scope_type in ('account', 'target')),
  scope_id uuid not null,
  bucket_period text not null check (bucket_period in ('hour', 'day')),
  bucket_start timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (operation, scope_type, scope_id, bucket_period, bucket_start),
  check (scope_type = 'account' or bucket_period = 'day')
);
create index qoreid_quota_counters_expiry_idx on platform.qoreid_quota_counters(bucket_start);

-- A connection-test key is reserved before the outbound OAuth probe. This
-- avoids double charging or duplicate probes when concurrent requests reuse
-- one key, without holding a database client across a nested transaction.
create table platform.qoreid_test_quota_reservations (
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  idempotency_key_sha256 char(64) not null check (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  reserved_at timestamptz not null default clock_timestamp(),
  primary key (actor_account_id, idempotency_key_sha256)
);
create index qoreid_test_quota_reservations_expiry_idx
  on platform.qoreid_test_quota_reservations(reserved_at);

alter table platform.qoreid_quota_counters enable row level security;
alter table platform.qoreid_quota_counters force row level security;
alter table platform.qoreid_test_quota_reservations enable row level security;
alter table platform.qoreid_test_quota_reservations force row level security;
-- The security-definer command is the only runtime access path. The table is
-- not granted to an application role, including the schema-test role.
create policy qoreid_quota_command_read on platform.qoreid_quota_counters for select using (true);
create policy qoreid_quota_command_insert on platform.qoreid_quota_counters for insert with check (true);
create policy qoreid_quota_command_update on platform.qoreid_quota_counters for update
  using (true) with check (true);
create policy qoreid_test_reservation_command_read on platform.qoreid_test_quota_reservations
  for select using (true);
create policy qoreid_test_reservation_command_insert on platform.qoreid_test_quota_reservations
  for insert with check (true);
create policy qoreid_test_reservation_command_delete on platform.qoreid_test_quota_reservations
  for delete using (true);
create policy qoreid_quota_command_delete on platform.qoreid_quota_counters for delete using (true);

create function platform.consume_qoreid_quota(
  requested_operation text, requested_target uuid, requested_patient_session uuid,
  requested_idempotency_hash char(64), requested_request_sha256 char(64)
) returns void
language plpgsql security definer
set search_path = pg_catalog, platform, auth, identity, pg_temp
as $$
declare
  actor uuid := platform.current_account_id();
  actor_subject text := platform.current_actor_subject();
  hourly_max integer;
  daily_max integer;
  target_daily_max integer := 0;
  quota record;
  new_attempts integer;
begin
  if actor is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;

  if requested_operation <> 'connection_test'
     and (requested_idempotency_hash is not null or requested_request_sha256 is not null) then
    raise exception using errcode = '22023', message = 'QOREID_QUOTA_OPERATION_INVALID';
  end if;

  case requested_operation
    when 'patient_nin' then
      if requested_target is not null or requested_patient_session is null
         or identity.patient_self_session(actor_subject, requested_patient_session) is null then
        raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
      end if;
      hourly_max := 3; daily_max := 10;
    when 'existing_cac' then
      if requested_target is null or requested_patient_session is not null
         or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
         or not auth.membership_has_permission(
           actor_subject, platform.current_membership_id(), platform.current_facility_id(), 'organization.manage'
         )
         or not exists (
           select 1 from identity.facilities facility
           where facility.id = platform.current_facility_id()
             and facility.organization_id = requested_target and facility.active
         ) then
        raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
      end if;
      hourly_max := 5; daily_max := 15; target_daily_max := 10;
    when 'application_cac' then
      if requested_target is null or requested_patient_session is not null
         or identity.organization_application_admin_account('platform.facility.manage') <> actor
         or not exists (select 1 from identity.organization_applications application
           where application.id = requested_target) then
        raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
      end if;
      hourly_max := 5; daily_max := 15; target_daily_max := 3;
    when 'connection_test' then
      if requested_target is not null or requested_patient_session is not null
         or requested_idempotency_hash is null or requested_idempotency_hash !~ '^[a-f0-9]{64}$'
         or requested_request_sha256 is null or requested_request_sha256 !~ '^[a-f0-9]{64}$'
         or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
         or not auth.account_has_platform_permission(actor, 'platform.integration.test') then
        raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
      end if;
      hourly_max := 3; daily_max := 10;
    else
      raise exception using errcode = '22023', message = 'QOREID_QUOTA_OPERATION_INVALID';
  end case;

  -- Incremental, indexed pruning keeps active deployments within 48 hours
  -- of historical counters. Each invocation deletes at most 100 old
  -- rows; the scheduled maintenance command below drains dormant rows.
  delete from platform.qoreid_quota_counters old
   where old.ctid in (select stale.ctid from platform.qoreid_quota_counters stale
     where stale.bucket_start < statement_timestamp() - interval '48 hours'
     order by stale.bucket_start limit 100);
  delete from platform.qoreid_test_quota_reservations old
   where old.ctid in (select stale.ctid from platform.qoreid_test_quota_reservations stale
     where stale.reserved_at < statement_timestamp() - interval '2 days'
     order by stale.reserved_at limit 100);

  if requested_operation = 'connection_test' then
    insert into platform.qoreid_test_quota_reservations
      (actor_account_id, idempotency_key_sha256, request_sha256)
    values (actor, requested_idempotency_hash, requested_request_sha256)
    on conflict do nothing;
    if not found then
      raise exception using errcode = 'P4090', message = 'QOREID_TEST_ALREADY_ATTEMPTED';
    end if;
  end if;

  -- INSERT ... ON CONFLICT is atomic across API replicas. If any scope is
  -- exhausted, the raised exception rolls back increments to earlier scopes.
  for quota in
    select * from (values
      ('account'::text, actor, 'hour'::text, date_trunc('hour', statement_timestamp()), hourly_max),
      ('account'::text, actor, 'day'::text, date_trunc('day', statement_timestamp()), daily_max),
      ('target'::text, requested_target, 'day'::text, date_trunc('day', statement_timestamp()), target_daily_max)
    ) as limits(scope_type, scope_id, bucket_period, bucket_start, max_attempts)
    where limits.scope_id is not null and limits.max_attempts > 0
  loop
    insert into platform.qoreid_quota_counters as counter
      (operation, scope_type, scope_id, bucket_period, bucket_start, attempt_count)
    values (requested_operation, quota.scope_type, quota.scope_id, quota.bucket_period, quota.bucket_start, 1)
    on conflict (operation, scope_type, scope_id, bucket_period, bucket_start)
    do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
      where counter.attempt_count < quota.max_attempts
    returning attempt_count into new_attempts;
    if not found then
      raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
    end if;
  end loop;
end
$$;

revoke all on platform.qoreid_quota_counters, platform.qoreid_test_quota_reservations from public;
revoke all on function platform.consume_qoreid_quota(text,uuid,uuid,char,char) from public;

-- Public applications use a domain-separated HMAC of the remote address.
-- Only the keyed digest reaches PostgreSQL; the public intake payload and
-- address do not become rate-limit keys in the database.
create table platform.public_application_quota_counters (
  network_digest char(64) not null check (network_digest ~ '^[a-f0-9]{64}$'),
  bucket_period text not null check (bucket_period in ('hour', 'day')),
  bucket_start timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (network_digest, bucket_period, bucket_start)
);
create index public_application_quota_expiry_idx on platform.public_application_quota_counters(bucket_start);
alter table platform.public_application_quota_counters enable row level security;
alter table platform.public_application_quota_counters force row level security;
create policy public_application_quota_command_read on platform.public_application_quota_counters
  for select using (true);
create policy public_application_quota_command_insert on platform.public_application_quota_counters
  for insert with check (true);
create policy public_application_quota_command_update on platform.public_application_quota_counters
  for update using (true) with check (true);
create policy public_application_quota_command_delete on platform.public_application_quota_counters
  for delete using (true);

create function platform.consume_public_application_quota(requested_digest char(64))
returns void language plpgsql security definer
set search_path = pg_catalog, platform, pg_temp
as $$
declare
  quota record;
  new_attempts integer;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_digest is null or requested_digest !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'APPLICATION_QUOTA_PERMISSION_DENIED';
  end if;
  delete from platform.public_application_quota_counters old
   where old.ctid in (select stale.ctid from platform.public_application_quota_counters stale
     where stale.bucket_start < statement_timestamp() - interval '48 hours'
     order by stale.bucket_start limit 100);
  for quota in
    select * from (values
      ('hour'::text, date_trunc('hour', statement_timestamp()), 10),
      ('day'::text, date_trunc('day', statement_timestamp()), 30)
    ) as limits(bucket_period, bucket_start, max_attempts)
  loop
    insert into platform.public_application_quota_counters as counter
      (network_digest, bucket_period, bucket_start, attempt_count)
    values (requested_digest, quota.bucket_period, quota.bucket_start, 1)
    on conflict (network_digest, bucket_period, bucket_start)
    do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
      where counter.attempt_count < quota.max_attempts
    returning attempt_count into new_attempts;
    if not found then
      raise exception using errcode = 'P4290', message = 'APPLICATION_QUOTA_EXCEEDED';
    end if;
  end loop;
end
$$;

revoke all on platform.public_application_quota_counters from public;
revoke all on function platform.consume_public_application_quota(char) from public;

-- Identity API calls this hourly even if intake and verification traffic stop.
-- Expired pseudonymous counters and test-key reservations do not persist just
-- because no new request arrives. Every delete uses an expiry index.
create function platform.prune_verification_quotas() returns integer
language plpgsql security definer
set search_path = pg_catalog, platform, pg_temp
as $$
declare
  deleted_count integer := 0;
  batch_count integer;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;
  delete from platform.qoreid_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.qoreid_test_quota_reservations
    where reserved_at < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.public_application_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  return deleted_count + batch_count;
end
$$;
revoke all on function platform.prune_verification_quotas() from public;
