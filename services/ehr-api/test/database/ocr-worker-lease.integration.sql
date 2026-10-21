\set ON_ERROR_STOP on
-- OCR worker leases (Phase 4 Stage 8): the claim token, the lease expiry and
-- lease renewal. Rollback-only.
--
-- ocr.complete_worker_job and ocr.fail_worker_job (0014) compared the claim
-- token with <>, so a NULL token passed: any session of the shared OCR worker
-- subject could complete or fail a job that another worker replica held.
-- ocr.renew_worker_claim never worked: the job trigger (0016) allowed no
-- processing-to-processing update, so every renewal was refused and a job that
-- ran longer than its lease could not complete. A job whose document was
-- withdrawn while it was processing could not be failed, and its lease
-- recovery in ocr.claim_worker_job raised for every claim of its provider.
--
-- Fixtures are inserted with session_replication_role = replica, which skips
-- triggers and foreign-key checks; every case then runs with triggers and
-- references enforced, as the exact runtime role: hid_ocr_worker for the worker
-- commands, hid_ocr_api_runtime for direct job updates. Probe cases are undone;
-- lifecycle steps are kept. Each case is recorded and the suite fails at the end
-- listing every case whose outcome differs from the expected one.
--
-- The rehearsal also runs this suite with a schema owner that is neither a
-- superuser nor BYPASSRLS (release checklist P8). The worker commands then
-- cannot see ocr.jobs under row-level security, and every case must be
-- refused: the suite expects that when the commands' owner cannot see the
-- fixture job.
begin;

-- Security properties that CREATE OR REPLACE must keep.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: definer=%s config=%s volatility=%s owner=%s acl=%s', p.oid::regprocedure,
           p.prosecdef, p.proconfig, p.provolatile, p.proowner::regrole, p.proacl), '; ')
    into mismatch
    from pg_proc p
    join (values
      ('ocr.complete_worker_job(uuid,uuid,text,text,text,text,text,jsonb,numeric,jsonb,text)'::regprocedure,
       '{"search_path=ocr, audit, auth, platform, pg_temp"}'::text[]),
      ('ocr.fail_worker_job(uuid,uuid,text,text,boolean,integer,text)'::regprocedure,
       '{"search_path=ocr, audit, auth, platform, pg_temp"}'::text[]),
      ('ocr.renew_worker_claim(uuid,uuid,integer)'::regprocedure,
       '{"search_path=ocr, auth, platform, pg_temp"}'::text[]),
      ('ocr.validate_job_write()'::regprocedure, '{"search_path=ocr, ehr, identity, auth, platform, pg_temp"}'::text[]),
      ('ocr.record_job_event()'::regprocedure, '{"search_path=ocr, platform, pg_temp"}'::text[]))
      expected(proc, config) on p.oid = expected.proc
   where not p.prosecdef or p.proconfig is distinct from expected.config or p.provolatile <> 'v'
      or p.proowner <> (select proowner from pg_proc where oid = 'ocr.claim_worker_job(text,integer)'::regprocedure);
  if mismatch is not null then
    raise exception 'OCR worker command security properties changed: %', mismatch;
  end if;
  -- Only the worker (and the schema test runtime) may execute the three commands.
  -- A NULL ACL is the default, which grants EXECUTE to PUBLIC.
  select string_agg(format('%s on %s', coalesce(grantee.rolname, 'PUBLIC'), p.oid::regprocedure), '; ')
    into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
   where p.oid in ('ocr.complete_worker_job(uuid,uuid,text,text,text,text,text,jsonb,numeric,jsonb,text)'::regprocedure,
                   'ocr.fail_worker_job(uuid,uuid,text,text,boolean,integer,text)'::regprocedure,
                   'ocr.renew_worker_claim(uuid,uuid,integer)'::regprocedure)
     and privilege.grantee <> p.proowner
     and coalesce(grantee.rolname, 'PUBLIC') not in ('hid_ocr_worker', 'hid_schema_test_runtime');
  if mismatch is not null then
    raise exception 'unexpected EXECUTE grants on the OCR worker commands: %', mismatch;
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'ocr.jobs'::regclass and tgname = 'ocr_jobs_validate'
                   and tgfoid = 'ocr.validate_job_write()'::regprocedure and tgenabled = 'O') then
    raise exception 'the OCR job trigger must stay enabled';
  end if;
end $$;

set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e8a00000-0000-4000-8000-000000000001', 'OCR Lease Test Organization', 'ocr-lease-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e8a00000-0000-4000-8000-000000000002', 'e8a00000-0000-4000-8000-000000000001', 'OCR Lease Clinic',
   'OCR-LEASE-A', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e8a10000-0000-4000-8000-000000000001', 'synthetic:ocr-lease-clinician', 'ocr-lease-clinician@example.invalid',
   'OCR Lease Clinician', 'active'),
  ('e8a10000-0000-4000-8000-000000000002', 'workload:ocr-lease-worker-a', null, 'OCR Lease Worker A', 'active'),
  ('e8a10000-0000-4000-8000-000000000003', 'workload:ocr-lease-worker-b', null, 'OCR Lease Worker B', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('e8a80000-0000-4000-8000-000000000001', 'e8a10000-0000-4000-8000-000000000002', 'ocr_worker', 'platform',
   'Synthetic OCR lease worker A'),
  ('e8a80000-0000-4000-8000-000000000002', 'e8a10000-0000-4000-8000-000000000003', 'ocr_worker', 'platform',
   'Synthetic OCR lease worker B');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e8a20000-0000-4000-8000-000000000001', 'e8a10000-0000-4000-8000-000000000001', 'OCR Lease Clinician',
   'ocr-lease-clinician@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role) values
  ('e8a30000-0000-4000-8000-000000000001', 'e8a20000-0000-4000-8000-000000000001',
   'e8a10000-0000-4000-8000-000000000001', 'e8a00000-0000-4000-8000-000000000001',
   'e8a00000-0000-4000-8000-000000000002', 'doctor', 'doctor');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e8a40000-0000-4000-8000-000000000001', 'HID-LEASEA', 'Lease', 'Patient', 'Lease Patient', 'active');
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status,
  retention_class) values
  ('e8a50000-0000-4000-8000-000000000001', 'e8a40000-0000-4000-8000-000000000001',
   'e8a00000-0000-4000-8000-000000000002', 'e8a10000-0000-4000-8000-000000000001',
   'e8a30000-0000-4000-8000-000000000001', 'ocr-lease-source.pdf', 'synthetic-bucket',
   'synthetic/ocr-lease-source.pdf', 'lease-v1', 'application/pdf', 1024, repeat('1', 64), 'uploaded',
   'clinical_record'),
  -- Scanned clean, then withdrawn (entered in error) while J7 and J8 were processing.
  ('e8a50000-0000-4000-8000-000000000002', 'e8a40000-0000-4000-8000-000000000001',
   'e8a00000-0000-4000-8000-000000000002', 'e8a10000-0000-4000-8000-000000000001',
   'e8a30000-0000-4000-8000-000000000001', 'ocr-lease-withdrawn.pdf', 'synthetic-bucket',
   'synthetic/ocr-lease-withdrawn.pdf', 'lease-v2', 'application/pdf', 1024, repeat('3', 64), 'entered_in_error',
   'clinical_record');
insert into ehr.document_scan_events (document_id, patient_id, facility_id, created_by, event_type,
  detected_media_type, scanner_engine, scanner_version, idempotency_key, correlation_id, object_version_id,
  object_sha256_hex) values
  ('e8a50000-0000-4000-8000-000000000001', 'e8a40000-0000-4000-8000-000000000001',
   'e8a00000-0000-4000-8000-000000000002', 'e8a10000-0000-4000-8000-000000000001', 'clean', 'application/pdf',
   'synthetic-scanner', '1.0', 'ocr-lease-scan-0001', 'ocr-lease-scan', 'lease-v1', repeat('1', 64)),
  ('e8a50000-0000-4000-8000-000000000002', 'e8a40000-0000-4000-8000-000000000001',
   'e8a00000-0000-4000-8000-000000000002', 'e8a10000-0000-4000-8000-000000000001', 'clean', 'application/pdf',
   'synthetic-scanner', '1.0', 'ocr-lease-scan-0002', 'ocr-lease-scan', 'lease-v2', repeat('3', 64));
-- J1, J2, J4 and J6 are held by worker A; J3 by worker A with an expired lease;
-- J5 by worker B. J7 (expired lease) and J8 are held by worker A on the
-- withdrawn document, for their own provider. Tokens are fixed so the cases
-- can name them.
insert into ocr.jobs (id, facility_id, document_id, source_object_version_id, source_sha256_hex, idempotency_key,
  request_sha256, provider, max_attempts, created_by, created_by_membership_id, correlation_id, status,
  attempt_count, started_at, claim_token, claim_expires_at, claimed_by_subject)
select ('e8a60000-0000-4000-8000-00000000000' || job.n)::uuid, 'e8a00000-0000-4000-8000-000000000002',
       ('e8a50000-0000-4000-8000-00000000000' || job.document)::uuid, 'lease-v' || job.document,
       repeat(case job.document when 1 then '1' else '3' end, 64), 'ocr-lease-fixture-000' || job.n,
       repeat('2', 64), job.provider, 3, 'e8a10000-0000-4000-8000-000000000001',
       'e8a30000-0000-4000-8000-000000000001', 'ocr-lease-fixture', 'processing', 1,
       clock_timestamp() - interval '1 minute', ('e8a70000-0000-4000-8000-00000000000' || job.n)::uuid,
       clock_timestamp() + job.lease, job.subject
  from (values (1, 1, 'lease-provider', interval '10 minutes', 'workload:ocr-lease-worker-a'),
               (2, 1, 'lease-provider', interval '10 minutes', 'workload:ocr-lease-worker-a'),
               (3, 1, 'lease-provider', interval '-1 minute', 'workload:ocr-lease-worker-a'),
               (4, 1, 'lease-provider', interval '2 minutes', 'workload:ocr-lease-worker-a'),
               (5, 1, 'lease-provider', interval '10 minutes', 'workload:ocr-lease-worker-b'),
               (6, 1, 'lease-provider', interval '10 minutes', 'workload:ocr-lease-worker-a'),
               (7, 2, 'lease-provider-withdrawn', interval '-1 minute', 'workload:ocr-lease-worker-a'),
               (8, 2, 'lease-provider-withdrawn', interval '10 minutes', 'workload:ocr-lease-worker-a'))
    job(n, document, provider, lease, subject);
set local session_replication_role = origin;

-- Can the worker commands' owner see the fixture job? Not under a non-bypass
-- owner (P8): every case is then refused.
do $$
declare
  owner_role name := (select proowner::regrole::name from pg_proc
                       where oid = 'ocr.renew_worker_claim(uuid,uuid,integer)'::regprocedure);
  visible boolean;
begin
  execute format('set local role %I', owner_role);
  select exists (select 1 from ocr.jobs where id = 'e8a60000-0000-4000-8000-000000000001') into visible;
  reset role;
  perform set_config('ocr_lease.owner_sees_jobs', visible::text, true);
end $$;

create temporary table ocr_lease_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
-- The cases run as the runtime roles and record their own outcome.
grant select, insert on ocr_lease_cases to public;
grant usage on sequence ocr_lease_cases_seq_seq to public;

-- Runs a statement as the current role. 'ok', or the SQLSTATE it raised. With
-- keep = false a successful statement is undone.
create function pg_temp.lease_try(statement text, keep boolean) returns text language plpgsql as $$
declare outcome text;
begin
  begin
    execute statement;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'ocr-lease-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'ocr-lease-suite: undo' then outcome := sqlstate; end if;
  end;
  return outcome;
end $$;
create function pg_temp.lease_case(case_name text, expected text, statement text, keep boolean) returns void
language plpgsql as $$
begin
  insert into ocr_lease_cases (name, expected, actual)
  values (case_name, expected, pg_temp.lease_try(statement, keep));
end $$;

-- The worker session, exactly as services/ocr-worker/src/repository.ts sets it.
create function pg_temp.as_worker(subject text) returns void language plpgsql as $$
begin
  perform set_config('app.actor_subject', subject, true),
          set_config('app.correlation_id', 'ocr-lease-suite-worker', true);
end $$;

set local role hid_ocr_worker;
select pg_temp.as_worker('workload:ocr-lease-worker-a');

-- Probes against job J1, which worker A holds with token ...7...01. Undone.
select pg_temp.lease_case('complete with a NULL token', '55000', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000001', null, 'lease-result-null', repeat('a', 64),
    'lease-model', null, 'forged text', '{}'::jsonb, 0.5, '{}'::jsonb, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('fail with a NULL token, terminal', '55000', $s$
  select ocr.fail_worker_job('e8a60000-0000-4000-8000-000000000001', null, 'UNSUPPORTED_DOCUMENT',
    'Forged terminal failure', false, 0, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('fail with a NULL token, retryable', '55000', $s$
  select ocr.fail_worker_job('e8a60000-0000-4000-8000-000000000001', null, 'PROVIDER_UNAVAILABLE',
    'Forged retry', true, 0, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('complete with a wrong token', '55000', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000001', gen_random_uuid(), 'lease-result-wrong',
    repeat('a', 64), 'lease-model', null, 'forged text', '{}'::jsonb, 0.5, '{}'::jsonb, 'ocr-lease-suite-worker')$s$,
  false);
select pg_temp.lease_case('fail with the nil token', '55000', $s$
  select ocr.fail_worker_job('e8a60000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
    'PROVIDER_UNAVAILABLE', 'Forged retry', true, 0, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('renew with a NULL token', '55000', $s$
  select ocr.renew_worker_claim('e8a60000-0000-4000-8000-000000000001', null, 300)$s$, false);
-- J5 is held by worker B.
select pg_temp.lease_case('complete another worker''s job with its token', '55000', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000005', 'e8a70000-0000-4000-8000-000000000005',
    'lease-result-5', repeat('a', 64), 'lease-model', null, 'forged text', '{}'::jsonb, 0.5, '{}'::jsonb,
    'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('complete another worker''s job with a NULL token', '55000', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000005', null, 'lease-result-5', repeat('a', 64),
    'lease-model', null, 'forged text', '{}'::jsonb, 0.5, '{}'::jsonb, 'ocr-lease-suite-worker')$s$, false);
-- Missing failure or result metadata is refused, not treated as a terminal
-- failure or passed on to the extraction.
select pg_temp.lease_case('fail with a NULL retryable flag', '22023', $s$
  select ocr.fail_worker_job('e8a60000-0000-4000-8000-000000000006', 'e8a70000-0000-4000-8000-000000000006',
    'PROVIDER_UNAVAILABLE', 'Provider unavailable', null, 0, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('fail with a NULL retry delay', '22023', $s$
  select ocr.fail_worker_job('e8a60000-0000-4000-8000-000000000006', 'e8a70000-0000-4000-8000-000000000006',
    'UNSUPPORTED_DOCUMENT', 'Unsupported document', false, null, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('fail with a NULL error code', '22023', $s$
  select ocr.fail_worker_job('e8a60000-0000-4000-8000-000000000006', 'e8a70000-0000-4000-8000-000000000006',
    null, 'No code', false, 0, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('complete with a NULL structured payload', '22023', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000006', 'e8a70000-0000-4000-8000-000000000006',
    'lease-result-6', repeat('a', 64), 'lease-model', null, 'Synthetic OCR text', null, 0.5, '{}'::jsonb,
    'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('complete with a NULL provenance', '22023', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000006', 'e8a70000-0000-4000-8000-000000000006',
    'lease-result-6', repeat('a', 64), 'lease-model', null, 'Synthetic OCR text', '{}'::jsonb, 0.5, null,
    'ocr-lease-suite-worker')$s$, false);

-- The document of J7 and J8 was withdrawn while they were processing. A job
-- can no longer complete from it, but its holder can still fail it, and the
-- next claim of its provider recovers the expired J7 (kept) instead of
-- raising for every claim.
select pg_temp.lease_case('complete a job whose document was withdrawn', '23514', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000008', 'e8a70000-0000-4000-8000-000000000008',
    'lease-result-8', repeat('a', 64), 'lease-model', null, 'Synthetic OCR text', '{}'::jsonb, 0.5, '{}'::jsonb,
    'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('fail a job whose document was withdrawn', 'ok', $s$
  select ocr.fail_worker_job('e8a60000-0000-4000-8000-000000000008', 'e8a70000-0000-4000-8000-000000000008',
    'UNSUPPORTED_DOCUMENT', 'Source document withdrawn', false, 0, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('claim that recovers a job whose document was withdrawn', 'ok', $s$
  select * from ocr.claim_worker_job('lease-provider-withdrawn', 300)$s$, true);

-- The holder completes J1 (kept), then replays it.
select pg_temp.lease_case('complete by the holder', 'ok', $s$
  select set_config('ocr_lease.extraction', ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000001',
    'e8a70000-0000-4000-8000-000000000001', 'lease-result-1', repeat('a', 64), 'lease-model', 'lease-request-1',
    'Synthetic OCR text', '{"field":"value"}'::jsonb, 0.9, '{"engine":"synthetic"}'::jsonb,
    'ocr-lease-suite-worker')::text, true)$s$, true);
select pg_temp.lease_case('replay by the holder', 'ok', $s$
  do $d$ begin
    if ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000001', 'e8a70000-0000-4000-8000-000000000001',
         'lease-result-1', repeat('a', 64), 'lease-model', 'lease-request-1', 'Synthetic OCR text',
         '{"field":"value"}'::jsonb, 0.9, '{"engine":"synthetic"}'::jsonb, 'ocr-lease-suite-worker')::text
       is distinct from current_setting('ocr_lease.extraction', true) then
      raise exception using errcode = 'P0002', message = 'the replay returned another extraction';
    end if;
  end $d$$s$, false);
select pg_temp.lease_case('replay with a NULL token', '55000', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000001', null, 'lease-result-1', repeat('a', 64),
    'lease-model', 'lease-request-1', 'Synthetic OCR text', '{"field":"value"}'::jsonb, 0.9,
    '{"engine":"synthetic"}'::jsonb, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('replay with a NULL content hash', '22023', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000001', 'e8a70000-0000-4000-8000-000000000001',
    'lease-result-1', null, 'lease-model', 'lease-request-1', 'Synthetic OCR text', '{"field":"value"}'::jsonb,
    0.9, '{"engine":"synthetic"}'::jsonb, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('replay with another content hash', '23505', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000001', 'e8a70000-0000-4000-8000-000000000001',
    'lease-result-1', repeat('b', 64), 'lease-model', 'lease-request-1', 'Synthetic OCR text',
    '{"field":"value"}'::jsonb, 0.9, '{"engine":"synthetic"}'::jsonb, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('fail after completion', '55000', $s$
  select ocr.fail_worker_job('e8a60000-0000-4000-8000-000000000001', 'e8a70000-0000-4000-8000-000000000001',
    'PROVIDER_UNAVAILABLE', 'Too late', true, 0, 'ocr-lease-suite-worker')$s$, false);

-- The holder fails J2 for a retry (kept).
select pg_temp.lease_case('retryable fail by the holder', 'ok', $s$
  select ocr.fail_worker_job('e8a60000-0000-4000-8000-000000000002', 'e8a70000-0000-4000-8000-000000000002',
    'PROVIDER_UNAVAILABLE', 'Provider request failed safely', true, 0, 'ocr-lease-suite-worker')$s$, true);

-- J3's lease has expired: its holder can neither complete, fail nor renew it.
select pg_temp.lease_case('complete after the lease expired', '55000', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000003', 'e8a70000-0000-4000-8000-000000000003',
    'lease-result-3', repeat('a', 64), 'lease-model', null, 'late text', '{}'::jsonb, 0.5, '{}'::jsonb,
    'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('fail after the lease expired', '55000', $s$
  select ocr.fail_worker_job('e8a60000-0000-4000-8000-000000000003', 'e8a70000-0000-4000-8000-000000000003',
    'UNSUPPORTED_DOCUMENT', 'Late failure', false, 0, 'ocr-lease-suite-worker')$s$, false);
select pg_temp.lease_case('renew after the lease expired', '55000', $s$
  select ocr.renew_worker_claim('e8a60000-0000-4000-8000-000000000003', 'e8a70000-0000-4000-8000-000000000003', 300)$s$,
  false);

-- Renewal of J4.
select pg_temp.lease_case('renew with a wrong token', '55000', $s$
  select ocr.renew_worker_claim('e8a60000-0000-4000-8000-000000000004', gen_random_uuid(), 300)$s$, false);
select pg_temp.as_worker('workload:ocr-lease-worker-b');
select pg_temp.lease_case('renew another worker''s job with its token', '55000', $s$
  select ocr.renew_worker_claim('e8a60000-0000-4000-8000-000000000004', 'e8a70000-0000-4000-8000-000000000004', 300)$s$,
  false);
select pg_temp.as_worker('workload:ocr-lease-worker-a');
reset role;
select set_config('ocr_lease.before_expiry', claim_expires_at::text, true),
       set_config('ocr_lease.before_events', (select count(*) from ocr.job_events where job_id = jobs.id)::text, true)
  from ocr.jobs jobs where id = 'e8a60000-0000-4000-8000-000000000004';
set local role hid_ocr_worker;
select pg_temp.lease_case('renew by the holder', 'ok', $s$
  select ocr.renew_worker_claim('e8a60000-0000-4000-8000-000000000004', 'e8a70000-0000-4000-8000-000000000004', 600)$s$,
  true);
reset role;
-- The renewal moved the expiry forward, kept the token, holder, status and
-- attempt, took the next version and appended no job event.
select pg_temp.lease_case('the renewal changed only the lease and the version', 'ok', $s$
  do $d$ begin
    if not exists (
      select 1 from ocr.jobs
       where id = 'e8a60000-0000-4000-8000-000000000004' and status = 'processing'
         and claim_token = 'e8a70000-0000-4000-8000-000000000004'
         and claimed_by_subject = 'workload:ocr-lease-worker-a' and attempt_count = 1 and row_version = 2
         and claim_expires_at > current_setting('ocr_lease.before_expiry')::timestamptz + interval '5 minutes')
       or (select count(*) from ocr.job_events where job_id = 'e8a60000-0000-4000-8000-000000000004')
          <> current_setting('ocr_lease.before_events')::bigint then
      raise exception using errcode = 'P0002', message = 'the renewal did not change exactly the lease';
    end if;
  end $d$$s$, false);
set local role hid_ocr_worker;
select pg_temp.lease_case('complete after a renewal', 'ok', $s$
  select ocr.complete_worker_job('e8a60000-0000-4000-8000-000000000004', 'e8a70000-0000-4000-8000-000000000004',
    'lease-result-4', repeat('c', 64), 'lease-model', null, 'Renewed OCR text', '{}'::jsonb, 0.8, '{}'::jsonb,
    'ocr-lease-suite-worker')$s$, true);
reset role;

-- Direct updates of J6 by the OCR API runtime, which has UPDATE on ocr.jobs:
-- only the lease of a processing job may change, only forward, only while it
-- is active and at most an hour ahead. Each refused probe also extends the
-- lease, so only the rule it names can refuse it.
set local role hid_ocr_api_runtime;
select set_config('app.facility_id', 'e8a00000-0000-4000-8000-000000000002', true),
       set_config('app.actor_subject', 'synthetic:ocr-lease-clinician', true),
       set_config('app.membership_id', 'e8a30000-0000-4000-8000-000000000001', true),
       set_config('app.purpose_of_use', 'healthcare-operations', true),
       set_config('app.correlation_id', 'ocr-lease-suite-api', true);
select pg_temp.lease_case('direct lease extension that swaps the claim token', '23514', $s$
  update ocr.jobs set claim_token = gen_random_uuid(), claim_expires_at = claim_expires_at + interval '5 minutes',
    row_version = row_version + 1 where id = 'e8a60000-0000-4000-8000-000000000006'$s$, false);
select pg_temp.lease_case('direct lease extension that moves the claim to another worker', '23514', $s$
  update ocr.jobs set claimed_by_subject = 'workload:ocr-lease-worker-b',
    claim_expires_at = claim_expires_at + interval '5 minutes', row_version = row_version + 1
   where id = 'e8a60000-0000-4000-8000-000000000006'$s$, false);
select pg_temp.lease_case('direct lease extension that resets the attempt count', '23514', $s$
  update ocr.jobs set attempt_count = 0, claim_expires_at = claim_expires_at + interval '5 minutes',
    row_version = row_version + 1 where id = 'e8a60000-0000-4000-8000-000000000006'$s$, false);
select pg_temp.lease_case('direct lease extension that changes the correlation id', '23514', $s$
  update ocr.jobs set correlation_id = 'ocr-lease-suite-other',
    claim_expires_at = claim_expires_at + interval '5 minutes', row_version = row_version + 1
   where id = 'e8a60000-0000-4000-8000-000000000006'$s$, false);
select pg_temp.lease_case('direct update that ends the lease early', '23514', $s$
  update ocr.jobs set claim_expires_at = clock_timestamp() - interval '1 minute', row_version = row_version + 1
   where id = 'e8a60000-0000-4000-8000-000000000006'$s$, false);
select pg_temp.lease_case('direct update that makes the lease endless', '23514', $s$
  update ocr.jobs set claim_expires_at = 'infinity', row_version = row_version + 1
   where id = 'e8a60000-0000-4000-8000-000000000006'$s$, false);
select pg_temp.lease_case('direct update that extends the lease beyond an hour', '23514', $s$
  update ocr.jobs set claim_expires_at = clock_timestamp() + interval '2 hours', row_version = row_version + 1
   where id = 'e8a60000-0000-4000-8000-000000000006'$s$, false);
select pg_temp.lease_case('direct update that revives an expired lease', '23514', $s$
  update ocr.jobs set claim_expires_at = clock_timestamp() + interval '5 minutes', row_version = row_version + 1
   where id = 'e8a60000-0000-4000-8000-000000000003'$s$, false);
select pg_temp.lease_case('direct update that only extends the lease', 'ok', $s$
  update ocr.jobs set claim_expires_at = claim_expires_at + interval '5 minutes', row_version = row_version + 1
   where id = 'e8a60000-0000-4000-8000-000000000006'$s$, false);
-- An extension that names the unchanged status is not a status change: it
-- records no job event and no outbox event.
select pg_temp.lease_case('lease extension naming the status records no event', 'ok', $s$
  do $d$
  declare
    events bigint := (select count(*) from ocr.job_events where job_id = 'e8a60000-0000-4000-8000-000000000006');
    outbox bigint := (select count(*) from ocr.outbox_events
                       where aggregate_id = 'e8a60000-0000-4000-8000-000000000006');
  begin
    update ocr.jobs set status = 'processing', claim_expires_at = claim_expires_at + interval '5 minutes',
      row_version = row_version + 1 where id = 'e8a60000-0000-4000-8000-000000000006';
    if (select count(*) from ocr.job_events where job_id = 'e8a60000-0000-4000-8000-000000000006') <> events
       or (select count(*) from ocr.outbox_events where aggregate_id = 'e8a60000-0000-4000-8000-000000000006') <> outbox
    then
      raise exception using errcode = 'P0002', message = 'a lease extension recorded a status event';
    end if;
  end $d$$s$, false);
reset role;

do $$
declare
  owner_sees_jobs boolean := current_setting('ocr_lease.owner_sees_jobs')::boolean;
  mismatches text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq)
    into mismatches
    from ocr_lease_cases
   where case when owner_sees_jobs then actual is distinct from expected
              else actual is not distinct from 'ok' end;
  if mismatches is not null then
    raise exception E'OCR worker lease cases failed (owner sees jobs: %):\n%', owner_sees_jobs, mismatches;
  end if;
  raise notice 'OCR worker lease suite: % cases passed (owner sees jobs: %)',
    (select count(*) from ocr_lease_cases), owner_sees_jobs;
end $$;

-- Outcomes that the case results alone do not show, checked as the suite owner.
do $$
declare
  owner_sees_jobs boolean := current_setting('ocr_lease.owner_sees_jobs')::boolean;
  job record;
begin
  if not owner_sees_jobs then
    return;
  end if;
  select * into job from ocr.jobs where id = 'e8a60000-0000-4000-8000-000000000002';
  if job.status <> 'queued' or job.attempt_count <> 1 or job.last_error_code <> 'PROVIDER_UNAVAILABLE'
     or job.claim_token is not null then
    raise exception 'the holder''s retryable failure was not recorded and requeued: %', row_to_json(job);
  end if;
  select * into job from ocr.jobs where id = 'e8a60000-0000-4000-8000-000000000004';
  if job.status <> 'awaiting_validation' then
    raise exception 'the renewed job did not complete: %', row_to_json(job);
  end if;
  select * into job from ocr.jobs where id = 'e8a60000-0000-4000-8000-000000000007';
  if job.status <> 'queued' or job.last_error_code <> 'WORKER_LEASE_EXPIRED' or job.claim_token is not null then
    raise exception 'the expired job on the withdrawn document was not recovered: %', row_to_json(job);
  end if;
  if (select count(*) from ocr.extractions where job_id = 'e8a60000-0000-4000-8000-000000000001') <> 1
     or (select count(*) from audit.events where resource_id = 'e8a60000-0000-4000-8000-000000000001'
           and action in ('ocr.worker.complete', 'ocr.worker.fail')) <> 1 then
    raise exception 'refused or replayed calls wrote an extraction or an audit event';
  end if;
end $$;

rollback;
