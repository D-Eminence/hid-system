-- Accountless provider self-enrollment makes its QoreID CAC lookup before any
-- HID account exists, so the account-scoped 0049 `application_cac` quota cannot
-- apply and is left unchanged. This command charges the lookup to:
--   * a keyed digest of the server-observed client network (an IPv4 address
--     or an IPv6 /64), computed by the Identity API with the server-only OTP
--     HMAC key after Origin and Turnstile checks, using the same hourly and
--     daily limits 0049 gives one reviewer account for `application_cac`;
--   * the application's existing 0049 daily CAC target counter, shared with
--     the reviewed path, so one application cannot exceed three lookups a day.
-- Request fields cannot select or reset a scope. No CAC number, raw IP, email
-- or provider payload is stored. Every decision is audited, including denials.

create table platform.self_service_cac_quota_counters (
  network_digest char(64) not null check (network_digest ~ '^[a-f0-9]{64}$'),
  bucket_period text not null check (bucket_period in ('hour', 'day')),
  bucket_start timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (network_digest, bucket_period, bucket_start)
);
create index self_service_cac_quota_expiry_idx on platform.self_service_cac_quota_counters(bucket_start);
alter table platform.self_service_cac_quota_counters enable row level security;
alter table platform.self_service_cac_quota_counters force row level security;
-- As in 0049, the security-definer command is the only runtime access path.
create policy self_service_cac_quota_command_read on platform.self_service_cac_quota_counters
  for select using (true);
create policy self_service_cac_quota_command_insert on platform.self_service_cac_quota_counters
  for insert with check (true);
create policy self_service_cac_quota_command_update on platform.self_service_cac_quota_counters
  for update using (true) with check (true);
create policy self_service_cac_quota_command_delete on platform.self_service_cac_quota_counters
  for delete using (true);
revoke all on platform.self_service_cac_quota_counters from public;

-- Returns true when the lookup may proceed. A denial returns false rather than
-- raising, so its audit event commits while every counter stays unchanged.
create function platform.consume_self_service_cac_quota(
  requested_application uuid,
  requested_network_digest char(64)
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, platform, identity, audit, pg_temp
as $$
declare
  quota record;
  new_attempts integer;
  exhausted_limit text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or platform.current_account_id() is not null
     or requested_application is null
     or requested_network_digest is null
     or requested_network_digest !~ '^[a-f0-9]{64}$'
     or not exists (
       select 1 from identity.organization_applications application
        where application.id = requested_application
          and application.approval_mode = 'self_service'
          and application.status = 'pending_verification'
     ) then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;

  delete from platform.self_service_cac_quota_counters old
   where old.ctid in (select stale.ctid from platform.self_service_cac_quota_counters stale
     where stale.bucket_start < statement_timestamp() - interval '48 hours'
     order by stale.bucket_start limit 100);

  begin
    for quota in
      select * from (values
        ('network_hour'::text, 'hour'::text, date_trunc('hour', statement_timestamp()), 5),
        ('network_day'::text, 'day'::text, date_trunc('day', statement_timestamp()), 15)
      ) as limits(limit_name, bucket_period, bucket_start, max_attempts)
    loop
      insert into platform.self_service_cac_quota_counters as counter
        (network_digest, bucket_period, bucket_start, attempt_count)
      values (requested_network_digest, quota.bucket_period, quota.bucket_start, 1)
      on conflict (network_digest, bucket_period, bucket_start)
      do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
        where counter.attempt_count < quota.max_attempts
      returning attempt_count into new_attempts;
      if not found then
        exhausted_limit := quota.limit_name;
        raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
      end if;
    end loop;

    -- The same per-application row and limit 0049 uses for `application_cac`.
    insert into platform.qoreid_quota_counters as counter
      (operation, scope_type, scope_id, bucket_period, bucket_start, attempt_count)
    values ('application_cac', 'target', requested_application, 'day',
      date_trunc('day', statement_timestamp()), 1)
    on conflict (operation, scope_type, scope_id, bucket_period, bucket_start)
    do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
      where counter.attempt_count < 3
    returning attempt_count into new_attempts;
    if not found then
      exhausted_limit := 'application_day';
      raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
    end if;
  exception when sqlstate 'P4290' then
    -- Leaving the block rolls back any increment made before the exhausted scope.
    null;
  end;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.cac-quota',
    case when exhausted_limit is null then 'success' else 'denied' end,
    'organization-application', requested_application::text,
    'application', 'identity-api',
    jsonb_build_object('operation', 'self_service_cac', 'exhaustedLimit', exhausted_limit,
      'networkDigest', requested_network_digest)
  );

  return exhausted_limit is null;
end
$$;

revoke all on function platform.consume_self_service_cac_quota(uuid,char) from public;

-- Hourly retention now also drains the self-service network counters.
create or replace function platform.prune_verification_quotas() returns integer
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
  deleted_count := deleted_count + batch_count;
  delete from platform.self_service_cac_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  return deleted_count + batch_count;
end
$$;
revoke all on function platform.prune_verification_quotas() from public;
