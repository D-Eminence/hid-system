\set ON_ERROR_STOP on
-- The OCR worker's workload account (0122). Rollback-only.
--
-- 0122 seeds the account hid:staging:ocr-worker and its platform ocr_worker
-- role, so the worker's commands stop answering 42501 Authorized OCR workload
-- context is required for that subject (and only for it). Fixtures are
-- inserted with session_replication_role = replica (no triggers or foreign-key
-- checks); every claim then runs with triggers enforced as hid_ocr_worker,
-- with the session set exactly as services/ocr-worker/src/repository.ts sets
-- it. Each case records its outcome ('ok', or the SQLSTATE it raised) and the
-- suite fails at the end listing every case whose outcome differs.
--
-- Run on a database whose functions are owned by a role that is neither a
-- superuser nor BYPASSRLS, the claim cannot see ocr.jobs (as
-- ocr-worker-lease.integration.sql expects): the authorized claim then still
-- passes the account check but claims nothing, which the last block accepts.
begin;

-- 1. The seed, as 0122 makes it.
do $$
declare
  worker_account constant uuid := '0c4e0122-0122-4000-8000-000000000001';
begin
  if (select count(*) from auth.accounts account_row
       where (account_row.id = worker_account or account_row.subject = 'hid:staging:ocr-worker')
         and account_row.id = worker_account and account_row.subject = 'hid:staging:ocr-worker'
         and account_row.status = 'active' and account_row.email is null and account_row.password_hash is null
         and account_row.password_algorithm is null and account_row.disabled_until is null
         and account_row.display_name = 'OCR worker' and account_row.source_system = 'hid-workload') <> 1
     or (select count(*) from auth.accounts account_row
          where account_row.id = worker_account or account_row.subject = 'hid:staging:ocr-worker') <> 1 then
    raise exception 'the OCR worker account is not as 0122 seeds it';
  end if;
  if (select count(*) from auth.account_roles assignment
       where assignment.account_id = worker_account and assignment.revoked_at is null) <> 1
     or (select count(*) from auth.account_roles assignment
          where assignment.id = '0c4e0122-0122-4000-8000-000000000002' and assignment.account_id = worker_account
            and assignment.role_code = 'ocr_worker' and assignment.scope_type = 'platform'
            and assignment.membership_id is null and assignment.facility_id is null and assignment.granted_by is null
            and assignment.revoked_at is null and assignment.grant_reason like '%migration 0122%') <> 1 then
    raise exception 'the OCR worker account must hold exactly the platform ocr_worker role 0122 seeds';
  end if;
  if (select array_agg(grant_row.permission_code order by grant_row.permission_code)
        from auth.role_permissions grant_row where grant_row.role_code = 'ocr_worker')
     is distinct from array['ocr.job.process'] then
    raise exception 'ocr_worker must grant exactly ocr.job.process';
  end if;
  -- The OCR API's subject (today's OCR_WORKER_SUBJECT) gets nothing.
  if exists (select 1 from auth.accounts where subject = 'hid:staging:ocr-api') then
    raise exception '0122 must not create an account for hid:staging:ocr-api';
  end if;
end $$;

-- 2. Fixture: one uploaded document scanned clean and one queued job for it.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('0c4e0000-0000-4000-8000-000000000001', 'OCR Account Test Organization', 'ocr-account-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('0c4e0000-0000-4000-8000-000000000002', '0c4e0000-0000-4000-8000-000000000001', 'OCR Account Clinic',
   'OCR-ACCOUNT-A', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('0c4e1000-0000-4000-8000-000000000001', 'synthetic:ocr-account-clinician',
   'ocr-account-clinician@example.invalid', 'OCR Account Clinician', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('0c4e2000-0000-4000-8000-000000000001', '0c4e1000-0000-4000-8000-000000000001', 'OCR Account Clinician',
   'ocr-account-clinician@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role) values
  ('0c4e3000-0000-4000-8000-000000000001', '0c4e2000-0000-4000-8000-000000000001',
   '0c4e1000-0000-4000-8000-000000000001', '0c4e0000-0000-4000-8000-000000000001',
   '0c4e0000-0000-4000-8000-000000000002', 'doctor', 'doctor');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('0c4e4000-0000-4000-8000-000000000001', 'HID-WKRACC', 'Account', 'Patient', 'Account Patient', 'active');
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status,
  retention_class) values
  ('0c4e5000-0000-4000-8000-000000000001', '0c4e4000-0000-4000-8000-000000000001',
   '0c4e0000-0000-4000-8000-000000000002', '0c4e1000-0000-4000-8000-000000000001',
   '0c4e3000-0000-4000-8000-000000000001', 'ocr-account-source.pdf', 'synthetic-bucket',
   'synthetic/ocr-account-source.pdf', 'account-v1', 'application/pdf', 1024, repeat('4', 64), 'uploaded',
   'clinical_record');
insert into ehr.document_scan_events (document_id, patient_id, facility_id, created_by, event_type,
  detected_media_type, scanner_engine, scanner_version, idempotency_key, correlation_id, object_version_id,
  object_sha256_hex) values
  ('0c4e5000-0000-4000-8000-000000000001', '0c4e4000-0000-4000-8000-000000000001',
   '0c4e0000-0000-4000-8000-000000000002', '0c4e1000-0000-4000-8000-000000000001', 'clean', 'application/pdf',
   'synthetic-scanner', '1.0', 'ocr-account-scan-0001', 'ocr-account-scan', 'account-v1', repeat('4', 64));
insert into ocr.jobs (id, facility_id, document_id, source_object_version_id, source_sha256_hex, idempotency_key,
  request_sha256, provider, max_attempts, created_by, created_by_membership_id, correlation_id, status)
values ('0c4e6000-0000-4000-8000-000000000001', '0c4e0000-0000-4000-8000-000000000002',
        '0c4e5000-0000-4000-8000-000000000001', 'account-v1', repeat('4', 64), 'ocr-account-fixture-0001',
        repeat('5', 64), 'ocr-account-provider', 3, '0c4e1000-0000-4000-8000-000000000001',
        '0c4e3000-0000-4000-8000-000000000001', 'ocr-account-fixture', 'queued');
set local session_replication_role = origin;

-- Can the claim's owner see the fixture job? Not under a non-bypass owner.
do $$
declare
  owner_role name := (select proowner::regrole::name from pg_proc
                       where oid = 'ocr.claim_worker_job(text,integer)'::regprocedure);
  visible boolean;
begin
  execute format('set local role %I', owner_role);
  select exists (select 1 from ocr.jobs where id = '0c4e6000-0000-4000-8000-000000000001') into visible;
  reset role;
  perform set_config('ocr_account.owner_sees_jobs', visible::text, true);
end $$;

create temporary table ocr_account_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on ocr_account_cases to public;
grant usage on sequence ocr_account_cases_seq_seq to public;

-- Claims as the current role with the worker session set to subject; 'ok' or
-- the SQLSTATE. With keep = false a successful claim is undone.
create function pg_temp.account_claim(case_name text, expected text, subject text, keep boolean) returns void
language plpgsql as $$
declare
  outcome text;
begin
  begin
    perform set_config('app.actor_subject', subject, true),
            set_config('app.correlation_id', 'ocr-account-suite-worker', true);
    perform * from ocr.claim_worker_job('ocr-account-provider', 300);
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'ocr-account-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'ocr-account-suite: undo' then outcome := sqlstate; end if;
  end;
  insert into ocr_account_cases (name, expected, actual) values (case_name, expected, outcome);
end $$;

-- 3. The claims, as the worker's runtime role.
set local role hid_ocr_worker;
select pg_temp.account_claim('the OCR API subject (today''s OCR_WORKER_SUBJECT) is refused', '42501',
  'hid:staging:ocr-api', false);
select pg_temp.account_claim('a random subject is refused', '42501',
  'hid:staging:' || gen_random_uuid()::text, false);
select pg_temp.account_claim('an empty subject is refused', '42501', '', false);
select pg_temp.account_claim('the document scanner''s account is refused', '42501',
  'hid:staging:document-scanner', false);
select pg_temp.account_claim('a near-miss subject is refused', '42501', 'hid:staging:ocr-worker ', false);
reset role;

-- The kill switches, each undone with the claim it is tested by: a revoked
-- role row, then a disabled account.
create function pg_temp.account_kill_case(case_name text, kill_switch text) returns void
language plpgsql as $$
declare
  outcome text;
begin
  begin
    execute kill_switch;
    execute 'set local role hid_ocr_worker';
    perform set_config('app.actor_subject', 'hid:staging:ocr-worker', true),
            set_config('app.correlation_id', 'ocr-account-suite-worker', true);
    perform * from ocr.claim_worker_job('ocr-account-provider', 300);
    outcome := 'ok';
    raise exception using errcode = 'P0001', message = 'ocr-account-suite: undo';
  exception when others then
    if sqlerrm <> 'ocr-account-suite: undo' then outcome := sqlstate; end if;
  end;
  insert into ocr_account_cases (name, expected, actual) values (case_name, '42501', outcome);
end $$;
select pg_temp.account_kill_case('the seeded subject with its role revoked is refused',
  $sql$update auth.account_roles set revoked_at = clock_timestamp(),
         revoked_by = '0c4e1000-0000-4000-8000-000000000001', revocation_reason = 'ocr-account suite kill switch'
   where id = '0c4e0122-0122-4000-8000-000000000002'$sql$);
select pg_temp.account_kill_case('the seeded subject with its account disabled is refused',
  $sql$update auth.accounts set status = 'disabled' where id = '0c4e0122-0122-4000-8000-000000000001'$sql$);
do $$
begin
  if not auth.account_has_active_role(auth.account_id_for_subject('hid:staging:ocr-worker'), 'ocr_worker') then
    raise exception 'a kill switch case was not undone';
  end if;
end $$;

set local role hid_ocr_worker;
select pg_temp.account_claim('the seeded subject claims', 'ok', 'hid:staging:ocr-worker', true);
reset role;

-- 4. Outcomes, and what the authorized claim did.
do $$
declare
  mismatches text;
  owner_sees_jobs boolean := current_setting('ocr_account.owner_sees_jobs')::boolean;
  job ocr.jobs%rowtype;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, coalesce(actual, 'nothing')), E'\n' order by seq)
    into mismatches
    from ocr_account_cases where actual is distinct from expected;
  if mismatches is not null or (select count(*) from ocr_account_cases) <> 8 then
    raise exception E'OCR worker account cases failed:\n%', coalesce(mismatches, 'case count');
  end if;
  select * into job from ocr.jobs where id = '0c4e6000-0000-4000-8000-000000000001';
  if owner_sees_jobs then
    if job.status <> 'processing' or job.claimed_by_subject <> 'hid:staging:ocr-worker' or job.claim_token is null
       or job.attempt_count <> 1 then
      raise exception 'the authorized claim did not claim the fixture job: %', row_to_json(job);
    end if;
    if (select count(*) from audit.events
         where action = 'ocr.worker.claim' and resource_id = job.id::text and outcome = 'success'
           and actor_type = 'workload' and actor_subject = 'hid:staging:ocr-worker'
           and actor_account_id = '0c4e0122-0122-4000-8000-000000000001') <> 1 then
      raise exception 'the authorized claim must write one audit row naming the worker account';
    end if;
  elsif job.status <> 'queued' or job.claim_token is not null then
    raise exception 'a claim that cannot see ocr.jobs changed a job: %', row_to_json(job);
  end if;
end $$;

rollback;
