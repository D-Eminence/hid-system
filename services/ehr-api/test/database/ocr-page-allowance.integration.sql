\set ON_ERROR_STOP on
-- 0110: the OCR page allowance. Rollback-only. Every person, facility and
-- document here is made up (Test Patient Adaeze Example, Allowance Test
-- Clinic A/B, folder numbers that do not exist).
--
-- Proves, as the exact runtime roles (hid_ocr_worker for the worker
-- commands, hid_ocr_api_runtime for the staff read, hid_identity_api_runtime
-- for the platform read and the limit command), with the session settings
-- each service sets:
--   - the security properties, EXECUTE grants and the absence of any table
--     privilege for a runtime role;
--   - the worker reads its job's allowance (default 500, this Africa/Lagos
--     month, resets on the first of next month); a NULL or wrong token,
--     another worker's job and a non-worker subject are refused;
--   - recording is idempotent per job (replay and a smaller count change
--     nothing and write no audit row; a larger count is kept), a bad count is
--     refused, and last month's usage does not count;
--   - a pause under the limit is refused and changes nothing; at 500 the
--     pause parks the job queued until 00:00 Africa/Lagos on resets_on with
--     its attempt restored (2 -> 1, 1 -> 0), the reason code on the job
--     events, an audit row, and the claim does not pick it up;
--   - staff holding ocr.job.read at the facility read it; another facility,
--     a membership without ocr.job.read, an inactive membership and a session
--     without a membership are refused; a platform administrator reads it in
--     a platform session; an account without platform.admin.access is
--     refused;
--   - only a platform super admin (platform_super_admin or platform_admin, in
--     a platform session, with a correlation id and healthcare-operations)
--     sets a limit: a support admin, a facility-scoped session, no
--     correlation id and bad input are refused; a limit still below use
--     resumes nothing; a limit above use resumes the parked jobs (and only
--     those), writes a platform audit row 0064 accepts, and the claim then
--     takes the job as attempt 2 of 3;
--   - the extra job transition is narrow: a queued job not parked by the
--     allowance, a later next_attempt_at, or any other column is refused.
-- Under an owner that does not bypass row-level security (release checklist
-- P8) the worker commands cannot see ocr.jobs, like every OCR worker command;
-- the worker cases then expect 55000 and the job-state checks are skipped.
begin;

-- Security properties.
do $$
declare
  mismatch text;
  ocr_owner oid := (select proowner from pg_proc where oid = 'ocr.claim_worker_job(text,integer)'::regprocedure);
begin
  select string_agg(format('%s: definer=%s config=%s owner=%s', p.oid::regprocedure, p.prosecdef, p.proconfig,
           p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
    join (values
      ('ocr.worker_page_allowance(uuid,uuid)'::regprocedure,
       '{"search_path=pg_catalog, ocr, auth, platform, pg_temp"}'::text[]),
      ('ocr.record_worker_pages(uuid,uuid,integer,text)'::regprocedure,
       '{"search_path=pg_catalog, ocr, audit, auth, platform, pg_temp"}'::text[]),
      ('ocr.pause_worker_job_for_allowance(uuid,uuid,text)'::regprocedure,
       '{"search_path=pg_catalog, ocr, audit, auth, platform, pg_temp"}'::text[]),
      ('ocr.facility_page_allowance(uuid)'::regprocedure,
       '{"search_path=pg_catalog, ocr, auth, identity, platform, pg_temp"}'::text[]),
      ('ocr.set_facility_page_limit(uuid,integer,text)'::regprocedure,
       '{"search_path=pg_catalog, ocr, audit, auth, identity, platform, pg_temp"}'::text[]))
      expected(proc, config) on p.oid = expected.proc
   where not p.prosecdef or p.proconfig is distinct from expected.config or p.proowner <> ocr_owner;
  if mismatch is not null then
    raise exception '0110 command security properties differ: %', mismatch;
  end if;
  if (select count(*) from pg_proc where oid in ('ocr.worker_page_allowance(uuid,uuid)'::regprocedure,
        'ocr.record_worker_pages(uuid,uuid,integer,text)'::regprocedure,
        'ocr.pause_worker_job_for_allowance(uuid,uuid,text)'::regprocedure,
        'ocr.facility_page_allowance(uuid)'::regprocedure,
        'ocr.set_facility_page_limit(uuid,integer,text)'::regprocedure)) <> 5 then
    raise exception 'a 0110 command is missing';
  end if;
  if exists (select 1 from pg_proc where oid = 'ocr.facility_page_allowance_state(uuid)'::regprocedure
               and (prosecdef or proowner <> ocr_owner)) then
    raise exception 'ocr.facility_page_allowance_state must be SECURITY INVOKER and the OCR owner''s';
  end if;
  select string_agg(format('%s to %s', p.oid::regprocedure, coalesce(grantee.rolname, 'PUBLIC')), '; ')
    into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
   where p.pronamespace = 'ocr'::regnamespace
     and p.proname in ('facility_page_allowance_state', 'worker_page_allowance', 'record_worker_pages',
       'pause_worker_job_for_allowance', 'facility_page_allowance', 'set_facility_page_limit')
     and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner
     and (p.proname, coalesce(grantee.rolname, 'PUBLIC')) not in (
       ('worker_page_allowance', 'hid_ocr_worker'), ('record_worker_pages', 'hid_ocr_worker'),
       ('pause_worker_job_for_allowance', 'hid_ocr_worker'),
       ('facility_page_allowance', 'hid_ocr_runtime'), ('facility_page_allowance', 'hid_identity_runtime'),
       ('set_facility_page_limit', 'hid_identity_runtime'));
  if mismatch is not null then
    raise exception 'unexpected EXECUTE grants on the 0110 commands: %', mismatch;
  end if;
  if (select count(*) from pg_proc p, aclexplode(p.proacl) privilege
       where p.pronamespace = 'ocr'::regnamespace and privilege.privilege_type = 'EXECUTE'
         and (p.proname, privilege.grantee::regrole::text) in (
           ('worker_page_allowance', 'hid_ocr_worker'), ('record_worker_pages', 'hid_ocr_worker'),
           ('pause_worker_job_for_allowance', 'hid_ocr_worker'),
           ('facility_page_allowance', 'hid_ocr_runtime'), ('facility_page_allowance', 'hid_identity_runtime'),
           ('set_facility_page_limit', 'hid_identity_runtime'))) <> 6 then
    raise exception 'the 0110 EXECUTE grants are incomplete';
  end if;
  -- No table privilege for any runtime role (or PUBLIC); forced row-level
  -- security with only the owner's policy.
  select string_agg(format('%s %s %s', role_row.rolname, privilege, table_name), '; ') into mismatch
    from pg_roles role_row
    cross join unnest(array['ocr.facility_page_limits', 'ocr.page_usage']) table_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege
   where role_row.rolname like 'hid\_%' and not role_row.rolsuper
     and not pg_has_role(role_row.oid, (select relowner from pg_class where oid = table_name::regclass), 'MEMBER')
     and has_table_privilege(role_row.oid, table_name, privilege);
  if mismatch is not null then
    raise exception 'a runtime role has a privilege on a 0110 table: %', mismatch;
  end if;
  if (select count(*) from pg_class c
       where c.oid in ('ocr.facility_page_limits'::regclass, 'ocr.page_usage'::regclass)
         and c.relrowsecurity and c.relforcerowsecurity and c.relacl is not null
         and not exists (select 1 from aclexplode(c.relacl) a where a.grantee <> c.relowner)
         and (select count(*) from pg_policy p where p.polrelid = c.oid) = 1) <> 2 then
    raise exception 'the 0110 tables must force row-level security, grant nothing and have one owner policy';
  end if;
  -- Nothing in the two tables can hold text from a page.
  if exists (select 1 from information_schema.columns
              where table_schema = 'ocr' and table_name in ('page_usage', 'facility_page_limits')
                and data_type in ('text', 'jsonb', 'json', 'bytea', 'character varying')
                and not (table_name = 'facility_page_limits' and column_name = 'reason')) then
    raise exception 'a 0110 table has a free-text column beyond the limit reason';
  end if;
end $$;

-- Fixtures (triggers and references skipped while they are inserted).
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('b1100000-0000-4000-8000-000000000001', 'Allowance Test Organization', 'allowance-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('b1100000-0000-4000-8000-00000000000a', 'b1100000-0000-4000-8000-000000000001', 'Allowance Test Clinic A',
   'ALLOWANCE-A', 'Africa/Lagos', true, 'verified'),
  ('b1100000-0000-4000-8000-00000000000b', 'b1100000-0000-4000-8000-000000000001', 'Allowance Test Clinic B',
   'ALLOWANCE-B', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('b1110000-0000-4000-8000-000000000001', 'staff:allowance-doctor', 'allowance-doctor@example.invalid', 'Allowance Doctor', 'active'),
  ('b1110000-0000-4000-8000-000000000002', 'staff:allowance-pharmacist', 'allowance-pharmacist@example.invalid', 'Allowance Pharmacist', 'active'),
  ('b1110000-0000-4000-8000-000000000003', 'staff:allowance-lapsed', 'allowance-lapsed@example.invalid', 'Allowance Lapsed', 'active'),
  ('b1110000-0000-4000-8000-000000000004', 'staff:allowance-super', 'allowance-super@example.invalid', 'Allowance Super Admin', 'active'),
  ('b1110000-0000-4000-8000-000000000005', 'staff:allowance-support', 'allowance-support@example.invalid', 'Allowance Support Admin', 'active'),
  ('b1110000-0000-4000-8000-000000000006', 'staff:allowance-nobody', 'allowance-nobody@example.invalid', 'Allowance No Platform Role', 'active'),
  ('b1110000-0000-4000-8000-000000000007', 'staff:allowance-legacy-admin', 'allowance-legacy@example.invalid', 'Allowance Legacy Admin', 'active'),
  ('b1110000-0000-4000-8000-000000000008', 'workload:allowance-worker-a', null, 'Allowance Worker A', 'active'),
  ('b1110000-0000-4000-8000-000000000009', 'workload:allowance-worker-b', null, 'Allowance Worker B', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('b1120000-0000-4000-8000-000000000001', 'b1110000-0000-4000-8000-000000000001', 'Allowance Doctor',
   'allowance-doctor@example.invalid', 'verified', 'doctor'),
  ('b1120000-0000-4000-8000-000000000002', 'b1110000-0000-4000-8000-000000000002', 'Allowance Pharmacist',
   'allowance-pharmacist@example.invalid', 'verified', 'pharmacist'),
  ('b1120000-0000-4000-8000-000000000003', 'b1110000-0000-4000-8000-000000000003', 'Allowance Lapsed',
   'allowance-lapsed@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, active) values
  ('b1130000-0000-4000-8000-000000000001', 'b1120000-0000-4000-8000-000000000001',
   'b1110000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000001',
   'b1100000-0000-4000-8000-00000000000a', 'doctor', 'doctor', true),
  ('b1130000-0000-4000-8000-000000000002', 'b1120000-0000-4000-8000-000000000002',
   'b1110000-0000-4000-8000-000000000002', 'b1100000-0000-4000-8000-000000000001',
   'b1100000-0000-4000-8000-00000000000a', 'pharmacist', 'pharmacist', true),
  ('b1130000-0000-4000-8000-000000000003', 'b1120000-0000-4000-8000-000000000003',
   'b1110000-0000-4000-8000-000000000003', 'b1100000-0000-4000-8000-000000000001',
   'b1100000-0000-4000-8000-00000000000a', 'doctor', 'doctor', false),
  -- The doctor also works at clinic B.
  ('b1130000-0000-4000-8000-000000000004', 'b1120000-0000-4000-8000-000000000001',
   'b1110000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000001',
   'b1100000-0000-4000-8000-00000000000b', 'doctor', 'doctor', true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('b1140000-0000-4000-8000-000000000001', 'b1110000-0000-4000-8000-000000000001', 'doctor', 'facility',
   'b1130000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-00000000000a', 'Synthetic allowance test'),
  ('b1140000-0000-4000-8000-000000000002', 'b1110000-0000-4000-8000-000000000002', 'pharmacist', 'facility',
   'b1130000-0000-4000-8000-000000000002', 'b1100000-0000-4000-8000-00000000000a', 'Synthetic allowance test'),
  ('b1140000-0000-4000-8000-000000000003', 'b1110000-0000-4000-8000-000000000003', 'doctor', 'facility',
   'b1130000-0000-4000-8000-000000000003', 'b1100000-0000-4000-8000-00000000000a', 'Synthetic allowance test'),
  ('b1140000-0000-4000-8000-00000000000a', 'b1110000-0000-4000-8000-000000000001', 'doctor', 'facility',
   'b1130000-0000-4000-8000-000000000004', 'b1100000-0000-4000-8000-00000000000b', 'Synthetic allowance test');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('b1140000-0000-4000-8000-000000000004', 'b1110000-0000-4000-8000-000000000004', 'platform_super_admin', 'platform', 'Synthetic allowance test'),
  ('b1140000-0000-4000-8000-000000000005', 'b1110000-0000-4000-8000-000000000005', 'support_admin', 'platform', 'Synthetic allowance test'),
  ('b1140000-0000-4000-8000-000000000007', 'b1110000-0000-4000-8000-000000000007', 'platform_admin', 'platform', 'Synthetic allowance test'),
  ('b1140000-0000-4000-8000-000000000008', 'b1110000-0000-4000-8000-000000000008', 'ocr_worker', 'platform', 'Synthetic allowance worker A'),
  ('b1140000-0000-4000-8000-000000000009', 'b1110000-0000-4000-8000-000000000009', 'ocr_worker', 'platform', 'Synthetic allowance worker B');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('b1150000-0000-4000-8000-000000000001', 'HID-ALWTST', 'Adaeze', 'Example', 'Test Patient Adaeze Example', 'active');
-- One clean document per job (folder numbers are made up and in no file name).
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status,
  retention_class)
select ('b1160000-0000-4000-8000-00000000000' || n)::uuid, 'b1150000-0000-4000-8000-000000000001',
       case when n = 9 then 'b1100000-0000-4000-8000-00000000000b' else 'b1100000-0000-4000-8000-00000000000a' end::uuid,
       'b1110000-0000-4000-8000-000000000001', 'b1130000-0000-4000-8000-000000000001',
       'allowance-paper-record-' || n || '.pdf', 'synthetic-bucket', 'synthetic/allowance-' || n || '.pdf',
       'allowance-v' || n, 'application/pdf', 2048, repeat(n::text, 64), 'uploaded', 'clinical_record'
  from generate_series(1, 9) n;
insert into ehr.document_scan_events (document_id, patient_id, facility_id, created_by, event_type,
  detected_media_type, scanner_engine, scanner_version, idempotency_key, correlation_id, object_version_id,
  object_sha256_hex)
select ('b1160000-0000-4000-8000-00000000000' || n)::uuid, 'b1150000-0000-4000-8000-000000000001',
       case when n = 9 then 'b1100000-0000-4000-8000-00000000000b' else 'b1100000-0000-4000-8000-00000000000a' end::uuid,
       'b1110000-0000-4000-8000-000000000001', 'clean', 'application/pdf', 'synthetic-scanner', '1.0',
       'allowance-scan-000' || n, 'allowance-scan', 'allowance-v' || n, repeat(n::text, 64)
  from generate_series(1, 9) n;
-- J1-J3 at clinic A held by worker A (J2 on attempt 2 of 3, J3 on attempt 1);
-- J4 at A held by worker B; J5 queued at A, parked by hand with another error
-- code (must never be resumed); J6 queued at A, parked by the allowance last
-- month (resumed by a raise, also under a non-bypass owner); J9 at clinic B
-- held by worker A. Each job has
-- its own provider so a claim can name one job.
insert into ocr.jobs (id, facility_id, document_id, patient_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, max_attempts, created_by, created_by_membership_id, correlation_id,
  status, attempt_count, started_at, claim_token, claim_expires_at, claimed_by_subject, next_attempt_at,
  last_error_code)
select ('b1170000-0000-4000-8000-00000000000' || job.n)::uuid,
       case when job.n = 9 then 'b1100000-0000-4000-8000-00000000000b' else 'b1100000-0000-4000-8000-00000000000a' end::uuid,
       ('b1160000-0000-4000-8000-00000000000' || job.n)::uuid, 'b1150000-0000-4000-8000-000000000001',
       'allowance-v' || job.n, repeat(job.n::text, 64), 'allowance-fixture-000' || job.n, repeat('e', 64),
       'allowance-provider-' || job.n, 3, 'b1110000-0000-4000-8000-000000000001',
       'b1130000-0000-4000-8000-000000000001', 'allowance-fixture', job.status, job.attempts,
       case when job.status = 'processing' then clock_timestamp() - interval '1 minute' end,
       case when job.status = 'processing' then ('b1180000-0000-4000-8000-00000000000' || job.n)::uuid end,
       case when job.status = 'processing' then clock_timestamp() + interval '10 minutes' end,
       case when job.status = 'processing' then job.subject end,
       case when job.status = 'queued' then clock_timestamp() + interval '3 days' else clock_timestamp() end,
       job.error_code
  from (values (1, 'processing', 1, 'workload:allowance-worker-a', null),
               (2, 'processing', 2, 'workload:allowance-worker-a', null),
               (3, 'processing', 1, 'workload:allowance-worker-a', null),
               (4, 'processing', 1, 'workload:allowance-worker-b', null),
               (5, 'queued', 1, null, 'PROVIDER_THROTTLED'),
               (6, 'queued', 1, null, 'OCR_PAGE_ALLOWANCE_USED_UP'),
               (9, 'processing', 1, 'workload:allowance-worker-a', null))
       job(n, status, attempts, subject, error_code);
set local session_replication_role = origin;

-- Can the worker commands' owner see the fixture jobs? Not under a non-bypass
-- owner (P8): the worker cases then expect 55000.
do $$
declare
  owner_role name := (select proowner::regrole::name from pg_proc
                       where oid = 'ocr.worker_page_allowance(uuid,uuid)'::regprocedure);
  visible boolean;
begin
  execute format('set local role %I', owner_role);
  select exists (select 1 from ocr.jobs where id = 'b1170000-0000-4000-8000-000000000001') into visible;
  reset role;
  perform set_config('ocr_allowance.owner_sees_jobs', visible::text, true);
  perform set_config('ocr_allowance.resets_on',
    ((date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos') + interval '1 month')::date)::text, true);
end $$;

create temporary table allowance_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on allowance_cases to public;
grant usage on sequence allowance_cases_seq_seq to public;

-- 'ok' or the SQLSTATE; with keep = false a success is undone.
create function pg_temp.allowance_try(statement text, keep boolean) returns text language plpgsql as $$
declare outcome text;
begin
  begin
    execute statement;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'allowance-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'allowance-suite: undo' then outcome := sqlstate; end if;
  end;
  return outcome;
end $$;
create function pg_temp.allowance_case(case_name text, expected text, statement text, keep boolean) returns void
language plpgsql as $$
begin
  insert into allowance_cases (name, expected, actual)
  values (case_name, expected, pg_temp.allowance_try(statement, keep));
end $$;
-- A worker case: its expectation when the owner sees the jobs, else 55000.
create function pg_temp.worker_case(case_name text, expected text, statement text, keep boolean) returns void
language plpgsql as $$
begin
  perform pg_temp.allowance_case(case_name,
    case when current_setting('ocr_allowance.owner_sees_jobs')::boolean then expected else '55000' end,
    statement, keep);
end $$;
-- Asserts a value check, recorded as a case.
create function pg_temp.allowance_check(case_name text, ok boolean) returns void language plpgsql as $$
begin
  insert into allowance_cases (name, expected, actual) values (case_name, 'true', coalesce(ok, false)::text);
end $$;
grant execute on function pg_temp.allowance_try(text, boolean), pg_temp.allowance_case(text, text, text, boolean),
  pg_temp.worker_case(text, text, text, boolean), pg_temp.allowance_check(text, boolean) to public;

-- Sessions as the services set them.
create function pg_temp.as_worker(subject text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.correlation_id', 'allowance-suite-worker', true);
$$;
create function pg_temp.as_staff(subject text, facility text, membership text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', facility, true),
    set_config('app.membership_id', membership, true), set_config('app.correlation_id', 'allowance-suite-staff', true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$$;
create function pg_temp.as_platform(subject text, correlation text default 'allowance-suite-platform',
  purpose text default 'healthcare-operations') returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', '', true),
    set_config('app.membership_id', '', true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', purpose, true);
$$;
grant execute on function pg_temp.as_worker(text), pg_temp.as_staff(text, text, text),
  pg_temp.as_platform(text, text, text) to public;

-- Worker: reads.
set local role hid_ocr_worker;
select pg_temp.as_worker('workload:allowance-worker-a');
select pg_temp.worker_case('worker reads J1 allowance', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.worker_page_allowance('b1170000-0000-4000-8000-000000000001',
      'b1180000-0000-4000-8000-000000000001');
    if r.pages_used <> 0 or r.pages_limit <> 500 or r.paused
       or r.resets_on <> current_setting('ocr_allowance.resets_on')::date then
      raise exception 'unexpected allowance %', r;
    end if;
  end $d$ $s$, true);
select pg_temp.allowance_case('worker read with a NULL token', '55000', $s$
  select * from ocr.worker_page_allowance('b1170000-0000-4000-8000-000000000001', null) $s$, false);
select pg_temp.allowance_case('worker read with a wrong token', '55000', $s$
  select * from ocr.worker_page_allowance('b1170000-0000-4000-8000-000000000001',
    'b1180000-0000-4000-8000-000000000002') $s$, false);
select pg_temp.allowance_case('worker A reads worker B''s job', '55000', $s$
  select * from ocr.worker_page_allowance('b1170000-0000-4000-8000-000000000004',
    'b1180000-0000-4000-8000-000000000004') $s$, false);
select pg_temp.allowance_case('worker reads a queued job', '55000', $s$
  select * from ocr.worker_page_allowance('b1170000-0000-4000-8000-000000000005', null) $s$, false);
select pg_temp.as_worker('staff:allowance-doctor');
select pg_temp.allowance_case('a staff subject on the worker role reads', '42501', $s$
  select * from ocr.worker_page_allowance('b1170000-0000-4000-8000-000000000001',
    'b1180000-0000-4000-8000-000000000001') $s$, false);
select pg_temp.allowance_case('a staff subject records pages', '42501', $s$
  select * from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000001',
    'b1180000-0000-4000-8000-000000000001', 3, 'allowance-suite-worker') $s$, false);
select pg_temp.allowance_case('a staff subject pauses', '42501', $s$
  select ocr.pause_worker_job_for_allowance('b1170000-0000-4000-8000-000000000001',
    'b1180000-0000-4000-8000-000000000001', 'allowance-suite-worker') $s$, false);
select pg_temp.allowance_case('the worker reads ocr.page_usage directly', '42501', $s$
  select * from ocr.page_usage $s$, false);
select pg_temp.allowance_case('the worker reads ocr.facility_page_limits directly', '42501', $s$
  select * from ocr.facility_page_limits $s$, false);
select pg_temp.allowance_case('the worker reads the staff allowance command', '42501', $s$
  select * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a') $s$, false);
select pg_temp.allowance_case('the worker sets a limit', '42501', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 9999, 'worker raise') $s$, false);

-- Worker: recording.
select pg_temp.as_worker('workload:allowance-worker-a');
select pg_temp.worker_case('record 10 pages for J1', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000001',
      'b1180000-0000-4000-8000-000000000001', 10, 'allowance-suite-worker');
    if r.pages_used <> 10 or r.pages_limit <> 500 or r.paused then raise exception 'unexpected %', r; end if;
  end $d$ $s$, true);
select pg_temp.worker_case('replay 10 pages for J1', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000001',
      'b1180000-0000-4000-8000-000000000001', 10, 'allowance-suite-worker');
    if r.pages_used <> 10 then raise exception 'replay changed the count: %', r; end if;
  end $d$ $s$, true);
select pg_temp.worker_case('a smaller count for J1 keeps 10', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000001',
      'b1180000-0000-4000-8000-000000000001', 4, 'allowance-suite-worker');
    if r.pages_used <> 10 then raise exception 'a smaller count changed the total: %', r; end if;
  end $d$ $s$, true);
select pg_temp.worker_case('a larger count for J1 is kept (12)', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000001',
      'b1180000-0000-4000-8000-000000000001', 12, 'allowance-suite-worker');
    if r.pages_used <> 12 then raise exception 'the larger count was not kept: %', r; end if;
  end $d$ $s$, true);
select pg_temp.allowance_case('record 0 pages', '22023', $s$
  select * from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000001',
    'b1180000-0000-4000-8000-000000000001', 0, 'allowance-suite-worker') $s$, false);
select pg_temp.allowance_case('record 201 pages', '22023', $s$
  select * from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000001',
    'b1180000-0000-4000-8000-000000000001', 201, 'allowance-suite-worker') $s$, false);
select pg_temp.allowance_case('record with a wrong token', '55000', $s$
  select * from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000001',
    'b1180000-0000-4000-8000-000000000003', 5, 'allowance-suite-worker') $s$, false);
select pg_temp.allowance_case('record for worker B''s job', '55000', $s$
  select * from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000004',
    'b1180000-0000-4000-8000-000000000004', 5, 'allowance-suite-worker') $s$, false);
-- Under the limit the pause answers NULL and changes nothing.
select pg_temp.worker_case('pause J2 at 12 of 500 answers NULL', 'ok', $s$
  do $d$ begin
    if ocr.pause_worker_job_for_allowance('b1170000-0000-4000-8000-000000000002',
         'b1180000-0000-4000-8000-000000000002', 'allowance-suite-worker') is not null then
      raise exception 'a pause under the limit returned a resume time';
    end if;
  end $d$ $s$, true);
select pg_temp.worker_case('record 200 pages for J2', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000002',
      'b1180000-0000-4000-8000-000000000002', 200, 'allowance-suite-worker');
    if r.pages_used <> 212 or r.paused then raise exception 'unexpected %', r; end if;
  end $d$ $s$, true);
select pg_temp.worker_case('record 5 pages for J9 at clinic B', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000009',
      'b1180000-0000-4000-8000-000000000009', 5, 'allowance-suite-worker');
    if r.pages_used <> 5 or r.paused then raise exception 'clinic B shares clinic A''s count: %', r; end if;
  end $d$ $s$, true);
reset role;

-- The stored rows and audit (as the suite's administrator).
do $$
declare visible boolean := current_setting('ocr_allowance.owner_sees_jobs')::boolean;
begin
  if visible then
    perform pg_temp.allowance_check('J1 stored once with 12 pages in this Lagos month',
      (select count(*) = 1 and min(pages) = 12
              and min(usage_month) = date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos')::date
         from ocr.page_usage where job_id = 'b1170000-0000-4000-8000-000000000001'));
    perform pg_temp.allowance_check('two pages_recorded audit rows for J1 (10, then 12), pages only',
      (select count(*) = 2 and bool_and(details ?& array['pages'] and (select count(*) from jsonb_object_keys(details)) = 1)
              and bool_and(actor_type = 'workload' and outcome = 'success')
         from audit.events where action = 'ocr.worker.pages_recorded'
          and resource_id = 'b1170000-0000-4000-8000-000000000001'));
    perform pg_temp.allowance_check('J2 still processing after the NULL pause',
      (select status = 'processing' and attempt_count = 2 from ocr.jobs where id = 'b1170000-0000-4000-8000-000000000002'));
  end if;
end $$;

-- Fill clinic A to exactly 500 this month (synthetic usage rows of jobs
-- whose working data is gone), and give clinic B 500 pages last month, which
-- must not count. J2's own 200 pages move to a synthetic row, so J2 stands
-- for a job that has not been read yet; J1 keeps its 12 (a retry after its
-- reading was counted).
set local session_replication_role = replica;
delete from ocr.page_usage where job_id = 'b1170000-0000-4000-8000-000000000002';
insert into ocr.page_usage (job_id, facility_id, usage_month, pages) values
  ('b1190000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-00000000000a',
   date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos')::date,
   case when current_setting('ocr_allowance.owner_sees_jobs')::boolean then 200 else 200 end),
  ('b1190000-0000-4000-8000-000000000002', 'b1100000-0000-4000-8000-00000000000a',
   date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos')::date,
   case when current_setting('ocr_allowance.owner_sees_jobs')::boolean then 88 else 200 end),
  ('b1190000-0000-4000-8000-000000000003', 'b1100000-0000-4000-8000-00000000000b',
   (date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos') - interval '1 month')::date, 200),
  ('b1190000-0000-4000-8000-000000000004', 'b1100000-0000-4000-8000-00000000000b',
   (date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos') - interval '1 month')::date, 200),
  ('b1190000-0000-4000-8000-000000000005', 'b1100000-0000-4000-8000-00000000000b',
   (date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos') - interval '1 month')::date, 100);
insert into ocr.page_usage (job_id, facility_id, usage_month, pages)
select 'b1190000-0000-4000-8000-000000000006', 'b1100000-0000-4000-8000-00000000000a',
       date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos')::date, 100
 where not current_setting('ocr_allowance.owner_sees_jobs')::boolean;
-- J2's 200 pages, now under a synthetic job.
insert into ocr.page_usage (job_id, facility_id, usage_month, pages)
select 'b1190000-0000-4000-8000-000000000007', 'b1100000-0000-4000-8000-00000000000a',
       date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos')::date, 200
 where current_setting('ocr_allowance.owner_sees_jobs')::boolean;
set local session_replication_role = origin;

-- Worker: at 500 of 500, the pause.
set local role hid_ocr_worker;
select pg_temp.as_worker('workload:allowance-worker-a');
select pg_temp.worker_case('J2 reads 500 of 500, paused', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.worker_page_allowance('b1170000-0000-4000-8000-000000000002',
      'b1180000-0000-4000-8000-000000000002');
    if r.pages_used <> 500 or r.pages_limit <> 500 or not r.paused then raise exception 'unexpected %', r; end if;
  end $d$ $s$, true);
select pg_temp.worker_case('J9 at clinic B: last month does not count', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.worker_page_allowance('b1170000-0000-4000-8000-000000000009',
      'b1180000-0000-4000-8000-000000000009');
    if r.pages_used <> 5 or r.paused then raise exception 'unexpected %', r; end if;
  end $d$ $s$, true);
select pg_temp.worker_case('pause J9 at clinic B (5 of 500) answers NULL', 'ok', $s$
  do $d$ begin
    if ocr.pause_worker_job_for_allowance('b1170000-0000-4000-8000-000000000009',
         'b1180000-0000-4000-8000-000000000009', 'allowance-suite-worker') is not null then
      raise exception 'a pause under the limit returned a resume time';
    end if;
  end $d$ $s$, false);
-- A retry whose own pages are already counted is never parked by them.
select pg_temp.worker_case('J1 (12 pages already recorded) reads 500 of 500, not paused', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.worker_page_allowance('b1170000-0000-4000-8000-000000000001',
      'b1180000-0000-4000-8000-000000000001');
    if r.pages_used <> 500 or r.pages_limit <> 500 or r.paused then raise exception 'unexpected %', r; end if;
  end $d$ $s$, true);
select pg_temp.worker_case('pause J1 (pages already recorded) answers NULL', 'ok', $s$
  do $d$ begin
    if ocr.pause_worker_job_for_allowance('b1170000-0000-4000-8000-000000000001',
         'b1180000-0000-4000-8000-000000000001', 'allowance-suite-worker') is not null then
      raise exception 'a job whose pages are counted was parked';
    end if;
  end $d$ $s$, true);
select pg_temp.worker_case('J1 re-records 12 pages at 500 of 500: count unchanged', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.record_worker_pages('b1170000-0000-4000-8000-000000000001',
      'b1180000-0000-4000-8000-000000000001', 12, 'allowance-suite-worker');
    if r.pages_used <> 500 or not r.paused then raise exception 'unexpected %', r; end if;
  end $d$ $s$, true);
select pg_temp.allowance_case('pause with a NULL token', '55000', $s$
  select ocr.pause_worker_job_for_allowance('b1170000-0000-4000-8000-000000000002', null,
    'allowance-suite-worker') $s$, false);
select pg_temp.allowance_case('pause worker B''s job', '55000', $s$
  select ocr.pause_worker_job_for_allowance('b1170000-0000-4000-8000-000000000004',
    'b1180000-0000-4000-8000-000000000004', 'allowance-suite-worker') $s$, false);
select pg_temp.worker_case('pause J2 at 500 of 500', 'ok', $s$
  do $d$ declare resume_at timestamptz; begin
    resume_at := ocr.pause_worker_job_for_allowance('b1170000-0000-4000-8000-000000000002',
      'b1180000-0000-4000-8000-000000000002', 'allowance-suite-pause-j2');
    if resume_at is distinct from (current_setting('ocr_allowance.resets_on')::date::timestamp at time zone 'Africa/Lagos') then
      raise exception 'resume time % is not 00:00 Africa/Lagos on %', resume_at, current_setting('ocr_allowance.resets_on');
    end if;
  end $d$ $s$, true);
select pg_temp.worker_case('pause J3 at 500 of 500', 'ok', $s$
  select ocr.pause_worker_job_for_allowance('b1170000-0000-4000-8000-000000000003',
    'b1180000-0000-4000-8000-000000000003', 'allowance-suite-pause-j3') $s$, true);
select pg_temp.allowance_case('pause J2 again (no longer held)', '55000', $s$
  select ocr.pause_worker_job_for_allowance('b1170000-0000-4000-8000-000000000002',
    'b1180000-0000-4000-8000-000000000002', 'allowance-suite-worker') $s$, false);
-- The claim does not take a parked job.
select pg_temp.allowance_case('the claim skips parked J2', 'ok', $s$
  do $d$ begin
    if exists (select 1 from ocr.claim_worker_job('allowance-provider-2', 60)) then
      raise exception 'a parked job was claimed';
    end if;
  end $d$ $s$, false);
reset role;

do $$
declare
  visible boolean := current_setting('ocr_allowance.owner_sees_jobs')::boolean;
  resume_at timestamptz := current_setting('ocr_allowance.resets_on')::date::timestamp at time zone 'Africa/Lagos';
begin
  if visible then
    perform pg_temp.allowance_check('J2 parked: queued, attempt 2 -> 1, until 00:00 Lagos on resets_on',
      (select status = 'queued' and attempt_count = 1 and next_attempt_at = resume_at
              and last_error_code = 'OCR_PAGE_ALLOWANCE_USED_UP'
              and last_error_summary = 'Reading is paused because this facility has used this month''s page allowance'
              and claim_token is null and claimed_by_subject is null and claim_expires_at is null
              and started_at is null and failed_at is null and correlation_id = 'allowance-suite-pause-j2'
         from ocr.jobs where id = 'b1170000-0000-4000-8000-000000000002'));
    perform pg_temp.allowance_check('J3 parked: attempt 1 -> 0',
      (select status = 'queued' and attempt_count = 0 and next_attempt_at = resume_at
         from ocr.jobs where id = 'b1170000-0000-4000-8000-000000000003'));
    perform pg_temp.allowance_check('J2 job events: failed then queued with the reason code',
      (select array_agg(to_status order by job_version) = array['failed', 'queued']
              and bool_and(reason_code = 'OCR_PAGE_ALLOWANCE_USED_UP')
         from ocr.job_events where job_id = 'b1170000-0000-4000-8000-000000000002'));
    perform pg_temp.allowance_check('one paused_for_allowance audit row for J2',
      (select count(*) = 1 and min(details->>'pagesUsed') = '500' and min(details->>'pagesLimit') = '500'
              and min(details->>'resetsOn') = current_setting('ocr_allowance.resets_on')
         from audit.events where action = 'ocr.worker.paused_for_allowance'
          and resource_id = 'b1170000-0000-4000-8000-000000000002'));
  end if;
end $$;

-- Staff and platform reads, through the OCR API runtime.
set local role hid_ocr_api_runtime;
select pg_temp.as_staff('staff:allowance-doctor', 'b1100000-0000-4000-8000-00000000000a',
  'b1130000-0000-4000-8000-000000000001');
select pg_temp.allowance_case('a doctor at clinic A reads clinic A', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a');
    if r.pages_used <> 500 or r.pages_limit <> 500 or not r.paused
       or r.resets_on <> current_setting('ocr_allowance.resets_on')::date then raise exception 'unexpected %', r; end if;
  end $d$ $s$, false);
select pg_temp.allowance_case('a doctor at clinic A reads clinic B', '42501', $s$
  select * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000b') $s$, false);
select pg_temp.allowance_case('a doctor at clinic A (with clinic B membership) names clinic B''s membership', '42501', $s$
  do $d$ begin
    perform set_config('app.membership_id', 'b1130000-0000-4000-8000-000000000004', true);
    perform * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000b');
  end $d$ $s$, false);
select pg_temp.allowance_case('a doctor at clinic A reads ocr.page_usage directly', '42501', $s$
  select * from ocr.page_usage $s$, false);
select pg_temp.allowance_case('the OCR API sets a limit', '42501', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 9999, 'ocr api raise') $s$, false);
select pg_temp.as_staff('staff:allowance-doctor', 'b1100000-0000-4000-8000-00000000000a', '');
select pg_temp.allowance_case('a facility session without a membership', '42501', $s$
  select * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a') $s$, false);
select pg_temp.as_staff('staff:allowance-pharmacist', 'b1100000-0000-4000-8000-00000000000a',
  'b1130000-0000-4000-8000-000000000002');
select pg_temp.allowance_case('a pharmacist (no ocr.job.read) at clinic A', '42501', $s$
  select * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a') $s$, false);
select pg_temp.as_staff('staff:allowance-lapsed', 'b1100000-0000-4000-8000-00000000000a',
  'b1130000-0000-4000-8000-000000000003');
select pg_temp.allowance_case('an inactive membership at clinic A', '42501', $s$
  select * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a') $s$, false);
select pg_temp.as_staff('staff:allowance-pharmacist', 'b1100000-0000-4000-8000-00000000000a',
  'b1130000-0000-4000-8000-000000000001');
select pg_temp.allowance_case('another account''s membership', '42501', $s$
  select * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a') $s$, false);
select pg_temp.as_platform('staff:allowance-super');
select pg_temp.allowance_case('the super admin reads clinic A in a platform session (OCR API)', 'ok', $s$
  select * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a') $s$, false);
select pg_temp.as_platform('staff:allowance-nobody');
select pg_temp.allowance_case('an account without platform.admin.access in a platform session', '42501', $s$
  select * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a') $s$, false);
select pg_temp.as_platform('staff:nobody-at-all');
select pg_temp.allowance_case('an unknown subject', '42501', $s$
  select * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a') $s$, false);
reset role;

-- The platform read and the limit, through the Identity API runtime.
set local role hid_identity_api_runtime;
select pg_temp.as_platform('staff:allowance-support');
select pg_temp.allowance_case('a support admin reads clinic A', 'ok', $s$
  select * from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a') $s$, false);
select pg_temp.allowance_case('a support admin sets a limit', '42501', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 9999, 'support raise') $s$, false);
select pg_temp.as_platform('staff:allowance-super');
select pg_temp.allowance_case('the super admin reads an unknown facility', 'P0002', $s$
  select * from ocr.facility_page_allowance('b11fffff-0000-4000-8000-000000000001') $s$, false);
select pg_temp.allowance_case('the super admin sets a limit for an unknown facility', 'P0002', $s$
  select ocr.set_facility_page_limit('b11fffff-0000-4000-8000-000000000001', 600, 'unknown facility') $s$, false);
select pg_temp.allowance_case('the super admin sets 0 pages', '22023', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 0, 'zero') $s$, false);
select pg_temp.allowance_case('the super admin sets 100001 pages', '22023', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 100001, 'too many') $s$, false);
select pg_temp.allowance_case('the super admin gives a blank reason', '22023', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 600, '   ') $s$, false);
select pg_temp.allowance_case('the super admin gives a 241-character reason', '22023', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 600, repeat('r', 241)) $s$, false);
select pg_temp.as_platform('staff:allowance-super', '');
select pg_temp.allowance_case('the super admin without a correlation id', '42501', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 600, 'no correlation') $s$, false);
select pg_temp.as_platform('staff:allowance-super', 'allowance-suite-platform', 'treatment');
select pg_temp.allowance_case('the super admin with another purpose', '42501', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 600, 'other purpose') $s$, false);
select pg_temp.as_staff('staff:allowance-super', 'b1100000-0000-4000-8000-00000000000a',
  'b1130000-0000-4000-8000-000000000001');
select pg_temp.allowance_case('the super admin in a facility-scoped session', '42501', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 600, 'facility session') $s$, false);
select pg_temp.as_platform('staff:allowance-nobody');
select pg_temp.allowance_case('a non-admin account sets a limit', '42501', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 600, 'not an admin') $s$, false);
-- Lowered below use: nothing resumes.
select pg_temp.as_platform('staff:allowance-super', 'allowance-suite-limit-400');
select pg_temp.allowance_case('the super admin sets 400 (below use)', 'ok', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 400, 'Pilot cap for the test clinic') $s$, true);
select pg_temp.allowance_case('clinic A reads 500 of 400, paused', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a');
    if r.pages_used <> 500 or r.pages_limit <> 400 or not r.paused then raise exception 'unexpected %', r; end if;
  end $d$ $s$, false);
reset role;
do $$
begin
  perform pg_temp.allowance_check('a limit below use resumes nothing',
    (select count(*) = case when current_setting('ocr_allowance.owner_sees_jobs')::boolean then 3 else 1 end
       from ocr.jobs where facility_id = 'b1100000-0000-4000-8000-00000000000a'
        and status = 'queued' and last_error_code = 'OCR_PAGE_ALLOWANCE_USED_UP'
        and next_attempt_at > clock_timestamp() + interval '1 hour'));
end $$;
-- Raised above use: the parked jobs resume.
set local role hid_identity_api_runtime;
select pg_temp.as_platform('staff:allowance-legacy-admin', 'allowance-suite-limit-1000');
select pg_temp.allowance_case('a platform_admin (0064 super admin) sets 1000', 'ok', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 1000, '  Raised for the pilot month  ') $s$, true);
select pg_temp.allowance_case('clinic A reads 500 of 1000, not paused', 'ok', $s$
  do $d$ declare r record; begin
    select * into strict r from ocr.facility_page_allowance('b1100000-0000-4000-8000-00000000000a');
    if r.pages_used <> 500 or r.pages_limit <> 1000 or r.paused then raise exception 'unexpected %', r; end if;
  end $d$ $s$, false);
select pg_temp.as_platform('staff:allowance-super', 'allowance-suite-limit-1200');
select pg_temp.allowance_case('the super admin sets 1200', 'ok', $s$
  select ocr.set_facility_page_limit('b1100000-0000-4000-8000-00000000000a', 1200, 'Raised again for the pilot') $s$, true);
reset role;

do $$
declare visible boolean := current_setting('ocr_allowance.owner_sees_jobs')::boolean;
begin
  perform pg_temp.allowance_check('one limit row: 1200, the super admin, the trimmed reason',
    (select count(*) = 1 and min(pages_limit) = 1200 and min(set_by_account_id::text) = 'b1110000-0000-4000-8000-000000000004'
            and min(reason) = 'Raised again for the pilot'
       from ocr.facility_page_limits where facility_id = 'b1100000-0000-4000-8000-00000000000a'));
  perform pg_temp.allowance_check('three platform audit rows 0064 accepts',
    (select count(*) = 3 and bool_and(actor_type = 'platform' and facility_id is null and actor_membership_id is null
              and organization_id is null and patient_id is null and purpose_of_use = 'healthcare-operations'
              and resource_type = 'facility' and resource_id = 'b1100000-0000-4000-8000-00000000000a'
              and outcome = 'success' and source_system = 'identity-api')
       from audit.events where action = 'admin.ocr.page-limit.set'));
  perform pg_temp.allowance_check('the audit says what changed (500 -> 400 -> 1000 -> 1200)',
    (select array_agg((details->>'previousPagesLimit') || '>' || (details->>'pagesLimit') order by sequence_id)
            = array['500>400', '400>1000', '1000>1200']
       from audit.events where action = 'admin.ocr.page-limit.set'));
  -- Under a non-bypass owner the job trigger cannot read the documents in a
  -- platform session, so the resume is skipped and counted; the parked job
  -- still becomes due at resets_on.
  perform pg_temp.allowance_check('the raise to 1000 resumed the parked jobs (J2, J3, J6) and nothing else',
    (select array_agg((details->>'resumedJobs') || '/' || (details->>'skippedJobs') order by sequence_id)
            = case when visible then array['0/0', '3/0', '0/0'] else array['0/0', '0/1', '0/1'] end
       from audit.events where action = 'admin.ocr.page-limit.set'));
  if visible then
    perform pg_temp.allowance_check('J6 due now, attempt kept, next version, correlation of the raise',
      (select status = 'queued' and next_attempt_at <= clock_timestamp() and attempt_count = 1 and row_version = 2
              and correlation_id = 'allowance-suite-limit-1000'
         from ocr.jobs where id = 'b1170000-0000-4000-8000-000000000006'));
    perform pg_temp.allowance_check('J2 and J3 due now, still queued, attempts kept, correlation of the raise',
      (select count(*) = 2 and bool_and(status = 'queued' and next_attempt_at <= clock_timestamp()
              and correlation_id = 'allowance-suite-limit-1000')
              and sum(attempt_count) = 1
         from ocr.jobs where id in ('b1170000-0000-4000-8000-000000000002', 'b1170000-0000-4000-8000-000000000003')));
    perform pg_temp.allowance_check('J5 (another error code) was not resumed',
      (select next_attempt_at > clock_timestamp() + interval '2 days' and row_version = 1
         from ocr.jobs where id = 'b1170000-0000-4000-8000-000000000005'));
    perform pg_temp.allowance_check('the resume wrote no job event',
      (select count(*) = 2 from ocr.job_events where job_id = 'b1170000-0000-4000-8000-000000000002'));
  end if;
  perform pg_temp.allowance_check('the platform session is restored (no facility)',
    current_setting('app.facility_id', true) = '');
end $$;

-- The resumed J2 is claimed as attempt 2 of 3: the pause used no attempt.
set local role hid_ocr_worker;
select pg_temp.as_worker('workload:allowance-worker-b');
select pg_temp.allowance_case('worker B claims resumed J2 as attempt 2', 'ok', $s$
  do $d$ declare claimed record; begin
    select * into claimed from ocr.claim_worker_job('allowance-provider-2', 60);
    if current_setting('ocr_allowance.owner_sees_jobs')::boolean then
      if claimed.job_id is distinct from 'b1170000-0000-4000-8000-000000000002'::uuid or claimed.attempt_no <> 2 then
        raise exception 'unexpected claim %', claimed;
      end if;
    end if;
  end $d$ $s$, true);
reset role;

-- The extra job transition is narrow (as the OCR API runtime, which may
-- update ocr.jobs of its facility).
set local role hid_ocr_api_runtime;
select pg_temp.as_staff('staff:allowance-doctor', 'b1100000-0000-4000-8000-00000000000a',
  'b1130000-0000-4000-8000-000000000001');
select pg_temp.allowance_case('moving a non-allowance queued job earlier', '23514', $s$
  update ocr.jobs set next_attempt_at = clock_timestamp(), row_version = row_version + 1
   where id = 'b1170000-0000-4000-8000-000000000005' $s$, false);
select pg_temp.allowance_case('moving a parked job later', '23514', $s$
  update ocr.jobs set next_attempt_at = next_attempt_at + interval '1 day', row_version = row_version + 1
   where id = 'b1170000-0000-4000-8000-000000000003' $s$, false);
select pg_temp.allowance_case('changing max_attempts of a parked job with its resume', '23514', $s$
  update ocr.jobs set next_attempt_at = clock_timestamp() - interval '30 seconds', max_attempts = 5,
    row_version = row_version + 1
   where id = 'b1170000-0000-4000-8000-000000000003' $s$, false);
reset role;

-- Verdict.
do $$
declare failures text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, coalesce(actual, 'nothing')), E'\n' order by seq)
    into failures from allowance_cases where actual is distinct from expected;
  if failures is not null then
    raise exception E'OCR page allowance cases failed:\n%', failures;
  end if;
  raise notice 'ocr-page-allowance: % cases passed (owner sees jobs: %)', (select count(*) from allowance_cases),
    current_setting('ocr_allowance.owner_sees_jobs');
end $$;

rollback;
