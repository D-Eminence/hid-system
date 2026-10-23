\set ON_ERROR_STOP on
-- OCR worker queue metrics (0082, main D-Eminence/hid-system#30, main 0075),
-- through the exact OCR worker runtime role. Rollback-only.
--
-- 0082 keeps the migration owner (main's dedicated owner role is not
-- ported), like ocr.claim_worker_job. The command counts what its owner sees:
-- every job under an owner that bypasses row-level security, and under one
-- that does not (release checklist P8) only what the facility policy shows for
-- the session, exactly as the worker's claim command does. The suite compares
-- the command with the owner's own view under the worker's session.
begin;

-- Security properties: SECURITY DEFINER, the exact search_path, the owner
-- shared with the worker's claim command, and EXECUTE for nobody but its owner
-- and the OCR worker.
do $$
declare
  mismatch text;
begin
  select format('definer=%s config=%s owner=%s', p.prosecdef, p.proconfig, p.proowner::regrole)
    into mismatch
    from pg_proc p
   where p.oid = 'ocr.worker_queue_metrics()'::regprocedure
     and (not p.prosecdef or p.proconfig is distinct from '{"search_path=pg_catalog, ocr, pg_temp"}'::text[]
       or p.proowner <> (select proowner from pg_proc where oid = 'ocr.claim_worker_job(text,integer)'::regprocedure));
  if mismatch is not null then
    raise exception 'ocr.worker_queue_metrics() security properties differ: %', mismatch;
  end if;
  select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', ')
    into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
   where p.oid = 'ocr.worker_queue_metrics()'::regprocedure
     and privilege.privilege_type = 'EXECUTE'
     and privilege.grantee <> p.proowner
     and (privilege.grantee = 0 or privilege.grantee::regrole::text <> 'hid_ocr_worker');
  if mismatch is not null then
    raise exception 'ocr.worker_queue_metrics() is executable by more than the OCR worker: %', mismatch;
  end if;
end $$;

insert into identity.organizations (id, name, slug) values
  ('fa000000-0000-4000-8000-000000000001', 'OCR Metrics Test Organization', 'ocr-metrics-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('fa000000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000001', 'OCR Metrics Clinic A',
   'OCR-METRICS-A', 'Africa/Lagos', true, 'verified'),
  ('fa000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000001', 'OCR Metrics Clinic B',
   'OCR-METRICS-B', 'Africa/Lagos', true, 'verified');

-- The job fixtures skip the security-definer job triggers, which check the
-- source document and append job events (schema.integration.sql covers them),
-- and the document and membership references.
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

-- The fixtures exist; then the owner's own view under the session the worker
-- uses below (facility B named) is the expected aggregate.
do $$ begin
  if (select count(*) from ocr.jobs where status = 'queued') < 2 then
    raise exception 'OCR metrics fixtures are not visible to the suite';
  end if;
end $$;
select set_config('app.facility_id', 'fa000000-0000-4000-8000-000000000003', true);
do $$
declare
  owner_role name := (select proowner::regrole::name from pg_proc
                       where oid = 'ocr.worker_queue_metrics()'::regprocedure);
  depth bigint;
  age bigint;
begin
  execute format('set local role %I', owner_role);
  select count(*), coalesce(extract(epoch from (clock_timestamp() - min(queued_at))), 0)::bigint
    into depth, age from ocr.jobs where status = 'queued';
  reset role;
  perform set_config('ocr_metrics.depth', depth::text, true), set_config('ocr_metrics.age', age::text, true);
end $$;

-- The worker gets the owner's aggregate, whatever facility its session names.
set local role hid_ocr_worker;
do $$
declare
  metrics record;
  expected_depth bigint := current_setting('ocr_metrics.depth')::bigint;
  expected_age bigint := current_setting('ocr_metrics.age')::bigint;
begin
  select * into strict metrics from ocr.worker_queue_metrics();
  if metrics.queue_depth <> expected_depth then
    raise exception 'OCR queue depth % does not match % queued jobs', metrics.queue_depth, expected_depth;
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

-- Other runtime roles cannot execute the command.
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
end $$;

rollback;
