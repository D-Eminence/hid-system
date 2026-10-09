\set ON_ERROR_STOP on
-- OCR queue metrics and OCR outbox inserts (0075), through the exact OCR
-- worker and OCR API runtime roles. Rollback-only.
begin;

insert into identity.organizations (id, name, slug) values
  ('fa000000-0000-4000-8000-000000000001', 'OCR Metrics Test Organization', 'ocr-metrics-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('fa000000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000001', 'OCR Metrics Clinic A',
   'OCR-METRICS-A', 'Africa/Lagos', true, 'verified'),
  ('fa000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000001', 'OCR Metrics Clinic B',
   'OCR-METRICS-B', 'Africa/Lagos', true, 'verified');

-- The job fixtures skip the security-definer job triggers, which check the
-- source document and append job events (schema.integration.sql covers them),
-- and the document and membership references. The rehearsal also runs this
-- suite with a non-superuser, non-BYPASSRLS schema owner, under which those
-- triggers cannot see fixture documents. Everything after the fixtures runs
-- with triggers and references enforced again.
set local session_replication_role = replica;
insert into ocr.jobs (id, facility_id, document_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, created_by, created_by_membership_id, correlation_id,
  status, queued_at) values
  ('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002',
   'fa200000-0000-4000-8000-000000000001', 'synthetic-version-1', repeat('a', 64),
   'ocr-metrics-fixture-0001', repeat('b', 64), 'test', 'fa300000-0000-4000-8000-000000000001',
   'fa400000-0000-4000-8000-000000000001', 'ocr-metrics-fixture', 'queued',
   clock_timestamp() - interval '2 hours'),
  ('fa100000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000003',
   'fa200000-0000-4000-8000-000000000002', 'synthetic-version-1', repeat('c', 64),
   'ocr-metrics-fixture-0002', repeat('d', 64), 'test', 'fa300000-0000-4000-8000-000000000001',
   'fa400000-0000-4000-8000-000000000002', 'ocr-metrics-fixture', 'queued',
   clock_timestamp() - interval '10 minutes'),
  -- Older than both, but no longer queued: it must not count.
  ('fa100000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000002',
   'fa200000-0000-4000-8000-000000000003', 'synthetic-version-1', repeat('e', 64),
   'ocr-metrics-fixture-0003', repeat('f', 64), 'test', 'fa300000-0000-4000-8000-000000000001',
   'fa400000-0000-4000-8000-000000000001', 'ocr-metrics-fixture', 'extracted',
   clock_timestamp() - interval '5 hours');
set local session_replication_role = origin;

-- Ground truth over every facility, read as the superuser running the suite.
-- Other synthetic rows (for example the restored baseline) count too.
select set_config('ocr_metrics.depth', count(*)::text, true),
       set_config('ocr_metrics.age',
         coalesce(extract(epoch from (clock_timestamp() - min(queued_at))), 0)::bigint::text, true)
  from ocr.jobs where status = 'queued';
do $$ begin
  if current_setting('ocr_metrics.depth')::bigint < 2 or current_setting('ocr_metrics.age')::bigint < 7200 then
    raise exception 'OCR metrics fixtures are not visible to the suite';
  end if;
end $$;

-- The worker sees the global aggregate, whatever facility its session names.
set local role hid_ocr_worker;
select set_config('app.facility_id', 'fa000000-0000-4000-8000-000000000003', true);
do $$
declare
  metrics record;
  expected_age bigint := current_setting('ocr_metrics.age')::bigint;
begin
  select * into strict metrics from ocr.worker_queue_metrics();
  if metrics.queue_depth <> current_setting('ocr_metrics.depth')::bigint then
    raise exception 'OCR queue depth % does not match % queued jobs', metrics.queue_depth,
      current_setting('ocr_metrics.depth');
  end if;
  if metrics.oldest_queue_age_seconds not between expected_age - 1 and expected_age + 5 then
    raise exception 'OCR oldest queued age % does not match %', metrics.oldest_queue_age_seconds, expected_age;
  end if;
end $$;
do $$ begin
  perform 1 from ocr.jobs limit 1;
  raise exception 'the OCR worker must not read ocr.jobs directly';
exception when insufficient_privilege then null;
end $$;
reset role;

-- Only the worker may execute the command. Six roles are tried for real; then
-- no other non-superuser HID role (or role that does not inherit the worker)
-- may hold EXECUTE at all.
do $$
declare
  role_name text;
begin
  foreach role_name in array array['hid_ocr_api_runtime', 'hid_ocr_runtime', 'hid_schema_test_runtime',
      'hid_ehr_api_runtime', 'hid_identity_api_runtime', 'hid_event_dispatcher'] loop
    begin
      execute format('set local role %I', role_name);
      perform 1 from ocr.worker_queue_metrics();
      raise exception 'role % must not execute ocr.worker_queue_metrics()', role_name;
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;
  select string_agg(rolname, ', ' order by rolname) into role_name
    from pg_roles
   where not rolsuper and rolname <> 'hid_ocr_queue_metrics'
     and has_function_privilege(oid, 'ocr.worker_queue_metrics()', 'EXECUTE')
     and not pg_has_role(oid, 'hid_ocr_worker', 'usage');
  if role_name is not null then
    raise exception 'roles other than the OCR worker can execute ocr.worker_queue_metrics(): %', role_name;
  end if;
end $$;

-- The technical owner can read job status and queue time, and no other column.
set local role hid_ocr_queue_metrics;
do $$
declare
  column_name name;
begin
  for column_name in
    select attname from pg_attribute
     where attrelid = 'ocr.jobs'::regclass and attnum > 0 and not attisdropped
       and attname not in ('status', 'queued_at')
     order by attnum
  loop
    begin
      execute format('select %I from ocr.jobs limit 1', column_name);
      raise exception 'the OCR metrics owner must not read ocr.jobs.%', column_name;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
reset role;

-- Visibility comes from the exact policy alone: without it the owner, which
-- does not bypass row-level security, sees only what the facility policy
-- allows, which is nothing for a worker session that names no facility.
drop policy ocr_jobs_queue_metrics_read on ocr.jobs;
set local role hid_ocr_worker;
select set_config('app.facility_id', '', true);
do $$
declare
  metrics record;
begin
  select * into strict metrics from ocr.worker_queue_metrics();
  if metrics.queue_depth <> 0 or metrics.oldest_queue_age_seconds <> 0 then
    raise exception 'the OCR metrics owner must not see jobs without its policy';
  end if;
end $$;
reset role;

-- The OCR API appends outbox events for the current facility, exactly as
-- OcrService.appendOutbox does, and for no other facility.
set local role hid_ocr_api_runtime;
select set_config('app.facility_id', 'fa000000-0000-4000-8000-000000000002', true),
       set_config('app.correlation_id', 'ocr-outbox-policy-check', true);
insert into ocr.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, correlation_id, payload)
values ('OcrPatientConfirmed', 'fa100000-0000-4000-8000-000000000001', 1,
  'fa000000-0000-4000-8000-000000000002', platform.current_correlation_id(),
  '{"jobId":"fa100000-0000-4000-8000-000000000001"}'::jsonb);
do $$ begin
  if not exists (select 1 from ocr.outbox_events
                  where aggregate_id = 'fa100000-0000-4000-8000-000000000001'
                    and event_type = 'OcrPatientConfirmed' and aggregate_version = 1) then
    raise exception 'the OCR API cannot read back its own outbox event';
  end if;
end $$;
do $$ begin
  insert into ocr.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, correlation_id, payload)
  values ('OcrPatientConfirmed', 'fa100000-0000-4000-8000-000000000002', 1,
    'fa000000-0000-4000-8000-000000000003', platform.current_correlation_id(),
    '{"jobId":"fa100000-0000-4000-8000-000000000002"}'::jsonb);
  raise exception 'the OCR API must not append outbox events for another facility';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
