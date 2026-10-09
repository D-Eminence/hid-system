\set ON_ERROR_STOP on
-- OCR job source evidence and publication requesters (Phase 4 Stage 8).
-- Rollback-only.
--
-- ocr.validate_job_write (0016) compared the source document's latest scan
-- with <>, so a document with no scan event at all passed: a job could be
-- created for an unscanned document, or moved into processing by a direct
-- update. Since Stage 8 a write that binds a job to its source (an insert, or
-- a change of the document or source object) or starts processing it needs an
-- exact clean scan; other updates of existing jobs keep the 0016 rule, so a
-- job created before Stage 8 for a document without a scan event can still be
-- cancelled, retried, failed and validated.
--
-- ocr.validate_publication_write (0016) did not bind the requester to the
-- session: a publication could name any member of the facility as requester.
-- Since Stage 8 an insert must name the session's own account and membership.
-- Lifecycle updates stay unbound, as the OCR API drives them.
--
-- Fixtures are inserted with session_replication_role = replica, which skips
-- triggers and foreign-key checks (CHECK constraints still apply); every case
-- then runs as hid_ocr_api_runtime, with the session the OCR API sets, and with
-- triggers and references enforced. Probe cases are undone; lifecycle steps are
-- kept. Each case is recorded and the suite fails at the end listing every case
-- whose outcome differs from the expected one.
--
-- The rehearsal also runs this suite with a schema owner that is neither a
-- superuser nor BYPASSRLS (release checklist P8). The definer guards then cannot
-- see the source document or the OCR evidence, and every write they guard must
-- be refused: the suite expects that when a guard's owner cannot see its
-- fixtures.
begin;

-- Security properties that CREATE OR REPLACE must keep.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: definer=%s config=%s volatility=%s owner=%s', p.oid::regprocedure,
           p.prosecdef, p.proconfig, p.provolatile, p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
    join (values ('ocr.validate_job_write()'::regprocedure,
                  '{"search_path=ocr, ehr, identity, auth, platform, pg_temp"}'::text[]),
                 ('ocr.validate_publication_write()'::regprocedure, '{"search_path=ocr, pg_temp"}'::text[]))
      expected(proc, config) on p.oid = expected.proc
   where not p.prosecdef or p.proconfig is distinct from expected.config or p.provolatile <> 'v'
      or p.proowner <> (select proowner from pg_proc where oid = 'ocr.validate_extraction_insert()'::regprocedure);
  if mismatch is not null then
    raise exception 'OCR guard security properties changed: %', mismatch;
  end if;
  if (select count(*) from pg_trigger
       where (tgrelid, tgname, tgfoid) in (
         ('ocr.jobs'::regclass, 'ocr_jobs_validate', 'ocr.validate_job_write()'::regprocedure),
         ('ocr.publications'::regclass, 'ocr_publications_validate', 'ocr.validate_publication_write()'::regprocedure))
         and tgenabled = 'O' and not tgisinternal) <> 2 then
    raise exception 'the OCR job and publication triggers must stay enabled';
  end if;
end $$;

set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e8b00000-0000-4000-8000-000000000001', 'OCR Source Test Organization', 'ocr-source-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e8b00000-0000-4000-8000-000000000002', 'e8b00000-0000-4000-8000-000000000001', 'OCR Source Clinic A',
   'OCR-SOURCE-A', 'Africa/Lagos', true, 'verified'),
  ('e8b00000-0000-4000-8000-000000000003', 'e8b00000-0000-4000-8000-000000000001', 'OCR Source Clinic B',
   'OCR-SOURCE-B', 'Africa/Lagos', true, 'verified');
-- A has two memberships in clinic A (mA1, mA2), B one (mB), C one in clinic B (mC).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e8b10000-0000-4000-8000-000000000001', 'synthetic:ocr-source-a', 'ocr-source-a@example.invalid', 'OCR Source A',
   'active'),
  ('e8b10000-0000-4000-8000-000000000002', 'synthetic:ocr-source-b', 'ocr-source-b@example.invalid', 'OCR Source B',
   'active'),
  ('e8b10000-0000-4000-8000-000000000003', 'synthetic:ocr-source-c', 'ocr-source-c@example.invalid', 'OCR Source C',
   'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e8b20000-0000-4000-8000-000000000001', 'e8b10000-0000-4000-8000-000000000001', 'OCR Source A',
   'ocr-source-a@example.invalid', 'verified', 'doctor'),
  ('e8b20000-0000-4000-8000-000000000002', 'e8b10000-0000-4000-8000-000000000002', 'OCR Source B',
   'ocr-source-b@example.invalid', 'verified', 'doctor'),
  ('e8b20000-0000-4000-8000-000000000003', 'e8b10000-0000-4000-8000-000000000003', 'OCR Source C',
   'ocr-source-c@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role) values
  ('e8b30000-0000-4000-8000-000000000001', 'e8b20000-0000-4000-8000-000000000001',
   'e8b10000-0000-4000-8000-000000000001', 'e8b00000-0000-4000-8000-000000000001',
   'e8b00000-0000-4000-8000-000000000002', 'doctor', 'doctor'),
  ('e8b30000-0000-4000-8000-000000000002', 'e8b20000-0000-4000-8000-000000000001',
   'e8b10000-0000-4000-8000-000000000001', 'e8b00000-0000-4000-8000-000000000001',
   'e8b00000-0000-4000-8000-000000000002', 'nurse', 'nurse'),
  ('e8b30000-0000-4000-8000-000000000003', 'e8b20000-0000-4000-8000-000000000002',
   'e8b10000-0000-4000-8000-000000000002', 'e8b00000-0000-4000-8000-000000000001',
   'e8b00000-0000-4000-8000-000000000002', 'doctor', 'doctor'),
  ('e8b30000-0000-4000-8000-000000000004', 'e8b20000-0000-4000-8000-000000000003',
   'e8b10000-0000-4000-8000-000000000003', 'e8b00000-0000-4000-8000-000000000001',
   'e8b00000-0000-4000-8000-000000000003', 'doctor', 'doctor');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e8b40000-0000-4000-8000-000000000001', 'HID-SRCPATA', 'Source', 'Patient', 'Source Patient', 'active');
-- Uploaded documents in clinic A: D1 scanned clean, D2 never scanned, D3 with
-- a scan still running, D4 whose scan failed, D5 rejected by the scanner.
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status,
  retention_class)
select ('e8b50000-0000-4000-8000-00000000000' || n)::uuid, 'e8b40000-0000-4000-8000-000000000001',
       'e8b00000-0000-4000-8000-000000000002', 'e8b10000-0000-4000-8000-000000000001',
       'e8b30000-0000-4000-8000-000000000001', 'ocr-source-' || n || '.pdf', 'synthetic-bucket',
       'synthetic/ocr-source-' || n || '.pdf', 'source-v' || n, 'application/pdf', 1024, repeat(n::text, 64),
       'uploaded', 'clinical_record'
  from generate_series(1, 5) n;
insert into ehr.document_scan_events (document_id, patient_id, facility_id, created_by, event_type,
  detected_media_type, reason_code, scanner_engine, scanner_version, idempotency_key, correlation_id,
  object_version_id, object_sha256_hex, created_at)
select ('e8b50000-0000-4000-8000-00000000000' || scan.n)::uuid, 'e8b40000-0000-4000-8000-000000000001',
       'e8b00000-0000-4000-8000-000000000002', 'e8b10000-0000-4000-8000-000000000001', scan.event_type,
       case when scan.event_type = 'clean' then 'application/pdf' end, scan.reason_code, 'synthetic-scanner', '1.0',
       'ocr-source-scan-' || scan.n || '-' || scan.step, 'ocr-source-scan', 'source-v' || scan.n,
       repeat(scan.n::text, 64), clock_timestamp() - scan.age
  from (values (1, 1, 'clean', null, interval '3 minutes'),
               (3, 1, 'scan_started', null, interval '3 minutes'),
               (4, 1, 'scan_started', null, interval '3 minutes'),
               (4, 2, 'failed', 'SCANNER_UNAVAILABLE', interval '2 minutes'),
               (5, 1, 'rejected', 'MALWARE_DETECTED', interval '3 minutes')) scan(n, step, event_type, reason_code, age);
-- Jobs of clinic A. J1 is queued for the clean document. J2 (queued), J3
-- (failed) and J4 (awaiting validation) were created before Stage 8 for the
-- never-scanned document. J5 is validated, with extraction E5, validation V5
-- and patient confirmation K5, for the publication cases.
insert into ocr.jobs (id, facility_id, document_id, source_object_version_id, source_sha256_hex, idempotency_key,
  request_sha256, provider, max_attempts, created_by, created_by_membership_id, correlation_id, status,
  attempt_count, failed_at, last_error_code, completed_at)
select ('e8b60000-0000-4000-8000-00000000000' || job.n)::uuid, 'e8b00000-0000-4000-8000-000000000002',
       ('e8b50000-0000-4000-8000-00000000000' || job.document)::uuid, 'source-v' || job.document,
       repeat(job.document::text, 64), 'ocr-source-fixture-000' || job.n, repeat('a', 64), 'source-provider', 3,
       'e8b10000-0000-4000-8000-000000000001', 'e8b30000-0000-4000-8000-000000000001', 'ocr-source-fixture',
       job.status, job.attempts, case when job.status = 'failed' then clock_timestamp() end,
       case when job.status = 'failed' then 'PROVIDER_UNAVAILABLE' end,
       case when job.status = 'validated' then clock_timestamp() end
  from (values (1, 1, 'queued', 0), (2, 2, 'queued', 0), (3, 2, 'failed', 1), (4, 2, 'awaiting_validation', 1),
               (5, 1, 'validated', 1)) job(n, document, status, attempts);
insert into ocr.extractions (id, job_id, facility_id, document_id, extraction_version, attempt_no, provider,
  provider_model, provider_result_key, content_sha256, source_object_version_id, source_sha256_hex, provenance) values
  ('e8b70000-0000-4000-8000-000000000005', 'e8b60000-0000-4000-8000-000000000005',
   'e8b00000-0000-4000-8000-000000000002', 'e8b50000-0000-4000-8000-000000000001', 1, 1, 'source-provider',
   'source-model', 'ocr-source-result-5', repeat('c', 64), 'source-v1', repeat('1', 64), '{}'::jsonb);
insert into ocr.validations (id, job_id, facility_id, extraction_id, validation_version, validated_payload, reason,
  validated_by, validated_by_membership_id, disposition, target_domain, candidate_type) values
  ('e8b80000-0000-4000-8000-000000000005', 'e8b60000-0000-4000-8000-000000000005',
   'e8b00000-0000-4000-8000-000000000002', 'e8b70000-0000-4000-8000-000000000005', 1, '{}'::jsonb,
   'Synthetic reviewer validated the source', 'e8b10000-0000-4000-8000-000000000001',
   'e8b30000-0000-4000-8000-000000000001', 'validated', 'DOCUMENT_ONLY', 'document_only');
insert into ocr.patient_confirmations (id, job_id, facility_id, patient_id, confirmation_version, method, reason,
  confirmed_by, confirmed_by_membership_id, idempotency_key, request_sha256) values
  ('e8b90000-0000-4000-8000-000000000005', 'e8b60000-0000-4000-8000-000000000005',
   'e8b00000-0000-4000-8000-000000000002', 'e8b40000-0000-4000-8000-000000000001', 1, 'source_document',
   'Confirmed against the governed source document', 'e8b10000-0000-4000-8000-000000000001',
   'e8b30000-0000-4000-8000-000000000001', 'ocr-source-confirmation-5', repeat('d', 64));
set local session_replication_role = origin;

-- The session, exactly as services/ocr-api/src/database/database.service.ts
-- sets it.
create function pg_temp.as_member(subject text, membership text, facility text) returns void language plpgsql as $$
begin
  perform set_config('app.actor_subject', subject, true), set_config('app.membership_id', membership, true),
          set_config('app.facility_id', facility, true),
          set_config('app.purpose_of_use', 'healthcare-operations', true),
          set_config('app.correlation_id', 'ocr-source-suite', true);
end $$;

-- Can each guard's owner see its fixtures under that session? Not under a
-- non-bypass owner (P8): every guarded write is then refused.
select pg_temp.as_member('synthetic:ocr-source-a', 'e8b30000-0000-4000-8000-000000000001',
  'e8b00000-0000-4000-8000-000000000002');
do $$
declare
  owner_role name;
  visible boolean;
begin
  owner_role := (select proowner::regrole::name from pg_proc where oid = 'ocr.validate_job_write()'::regprocedure);
  execute format('set local role %I', owner_role);
  select exists (select 1 from ehr.documents where id = 'e8b50000-0000-4000-8000-000000000001')
     and exists (select 1 from ehr.document_scan_events where document_id = 'e8b50000-0000-4000-8000-000000000001')
    into visible;
  reset role;
  perform set_config('ocr_source.owner_sees_documents', visible::text, true);
  owner_role := (select proowner::regrole::name from pg_proc where oid = 'ocr.validate_publication_write()'::regprocedure);
  execute format('set local role %I', owner_role);
  select exists (select 1 from ocr.validations where id = 'e8b80000-0000-4000-8000-000000000005')
     and exists (select 1 from ocr.patient_confirmations where id = 'e8b90000-0000-4000-8000-000000000005')
    into visible;
  reset role;
  perform set_config('ocr_source.owner_sees_evidence', visible::text, true);
end $$;

create temporary table ocr_source_cases (
  seq serial, area text not null, name text primary key, expected text not null, actual text
) on commit drop;
-- The cases run as the OCR API runtime and record their own outcome.
grant select, insert on ocr_source_cases to public;
grant usage on sequence ocr_source_cases_seq_seq to public;

-- Runs a statement as the current role. 'ok', or the SQLSTATE it raised. With
-- keep = false a successful statement is undone.
create function pg_temp.source_try(statement text, keep boolean) returns text language plpgsql as $$
declare outcome text;
begin
  begin
    execute statement;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'ocr-source-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'ocr-source-suite: undo' then outcome := sqlstate; end if;
  end;
  return outcome;
end $$;
create function pg_temp.source_case(area text, case_name text, expected text, statement text, keep boolean)
returns void language plpgsql as $$
begin
  insert into ocr_source_cases (area, name, expected, actual)
  values (area, case_name, expected, pg_temp.source_try(statement, keep));
end $$;
-- An update that must change exactly one row; a refused row is not an error,
-- so 'no row' is reported as P0002.
create function pg_temp.one_row(statement text) returns void language plpgsql as $$
declare changed bigint;
begin
  execute statement;
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception using errcode = 'P0002', message = 'expected one changed row'; end if;
end $$;
-- The OCR API job insert (services/ocr-api/src/ocr/ocr.service.ts createJob)
-- for one document of clinic A, by member A.
create function pg_temp.job_insert(document_n integer, key text) returns text language sql as $$
  select format($i$insert into ocr.jobs (facility_id, document_id, source_object_version_id, source_sha256_hex,
      idempotency_key, request_sha256, provider, max_attempts, created_by, created_by_membership_id, correlation_id)
    values ('e8b00000-0000-4000-8000-000000000002', 'e8b50000-0000-4000-8000-00000000000%s', 'source-v%s',
      repeat('%s', 64), %L, repeat('b', 64), 'source-provider', 3, 'e8b10000-0000-4000-8000-000000000001',
      'e8b30000-0000-4000-8000-000000000001', 'ocr-source-suite')$i$, document_n, document_n, document_n, key)
$$;
-- The OCR API publication insert (createPublication) of job J5, naming a requester.
create function pg_temp.publication_insert(requester text, requester_membership text, key text) returns text
language sql as $$
  select format($i$insert into ocr.publications (job_id, validation_id, validation_version, patient_confirmation_id,
      facility_id, patient_id, target_domain, target_operation, idempotency_key, request_sha256, requested_by,
      requested_by_membership_id, correlation_id)
    values ('e8b60000-0000-4000-8000-000000000005', 'e8b80000-0000-4000-8000-000000000005', 1,
      'e8b90000-0000-4000-8000-000000000005', 'e8b00000-0000-4000-8000-000000000002',
      'e8b40000-0000-4000-8000-000000000001', 'DOCUMENT_ONLY', 'retain_validated_document', %L, repeat('e', 64),
      %L, %L, 'ocr-source-suite')$i$, key, requester, requester_membership)
$$;

set local role hid_ocr_api_runtime;
select pg_temp.as_member('synthetic:ocr-source-a', 'e8b30000-0000-4000-8000-000000000001',
  'e8b00000-0000-4000-8000-000000000002');

-- New jobs need an exact clean scan of their source.
select pg_temp.source_case('job', 'insert for a document never scanned', '23514',
  pg_temp.job_insert(2, 'ocr-source-insert-0002'), false);
select pg_temp.source_case('job', 'insert for a document whose scan is still running', '23514',
  pg_temp.job_insert(3, 'ocr-source-insert-0003'), false);
select pg_temp.source_case('job', 'insert for a document whose scan failed', '23514',
  pg_temp.job_insert(4, 'ocr-source-insert-0004'), false);
select pg_temp.source_case('job', 'insert for a document rejected by the scanner', '23514',
  pg_temp.job_insert(5, 'ocr-source-insert-0005'), false);
select pg_temp.source_case('job', 'insert for a clean document', 'ok',
  pg_temp.job_insert(1, 'ocr-source-insert-0001'), false);

-- A job created before Stage 8 for the never-scanned document can still be
-- cancelled, retried, failed for good and validated, but not started.
select pg_temp.source_case('job', 'start an unscanned queued job by a direct update', '23514', $s$
  select pg_temp.one_row($u$update ocr.jobs set status = 'processing', started_at = clock_timestamp(),
      attempt_count = attempt_count + 1, claim_token = gen_random_uuid(),
      claim_expires_at = clock_timestamp() + interval '5 minutes', claimed_by_subject = 'workload:ocr-source',
      row_version = row_version + 1
    where id = 'e8b60000-0000-4000-8000-000000000002'$u$)$s$, false);
select pg_temp.source_case('job', 'cancel an unscanned queued job', 'ok', $s$
  select pg_temp.one_row($u$update ocr.jobs set status = 'cancelled', correlation_id = 'ocr-source-suite',
      row_version = row_version + 1 where id = 'e8b60000-0000-4000-8000-000000000002'$u$)$s$, false);
select pg_temp.source_case('job', 'retry an unscanned failed job (the OCR API retry)', 'ok', $s$
  select pg_temp.one_row($u$update ocr.jobs set status = 'queued', queued_at = clock_timestamp(),
      next_attempt_at = clock_timestamp(), started_at = null, failed_at = null, last_error_code = null,
      last_error_summary = null, correlation_id = 'ocr-source-suite', row_version = row_version + 1
    where id = 'e8b60000-0000-4000-8000-000000000003' and facility_id = 'e8b00000-0000-4000-8000-000000000002'
      and status = 'failed' and row_version = 1 and attempt_count < max_attempts$u$)$s$, false);
select pg_temp.source_case('job', 'cancel an unscanned failed job', 'ok', $s$
  select pg_temp.one_row($u$update ocr.jobs set status = 'cancelled', correlation_id = 'ocr-source-suite',
      row_version = row_version + 1 where id = 'e8b60000-0000-4000-8000-000000000003'$u$)$s$, false);
select pg_temp.source_case('job', 'reject an unscanned job awaiting validation (the OCR API validation)', 'ok', $s$
  select pg_temp.one_row($u$update ocr.jobs set status = 'rejected', completed_at = clock_timestamp(),
      correlation_id = 'ocr-source-suite', row_version = row_version + 1
    where id = 'e8b60000-0000-4000-8000-000000000004' and facility_id = 'e8b00000-0000-4000-8000-000000000002'
      and row_version = 1$u$)$s$, false);
-- Moving a job to another source is refused whatever that source's scan.
select pg_temp.source_case('job', 'move a clean job to the never-scanned document', '23514', $s$
  select pg_temp.one_row($u$update ocr.jobs set document_id = 'e8b50000-0000-4000-8000-000000000002',
      source_object_version_id = 'source-v2', source_sha256_hex = repeat('2', 64), row_version = row_version + 1
    where id = 'e8b60000-0000-4000-8000-000000000001'$u$)$s$, false);

-- Publication requests must name the session's own account and membership.
select pg_temp.source_case('publication', 'request naming the session member', 'ok',
  pg_temp.publication_insert('e8b10000-0000-4000-8000-000000000001', 'e8b30000-0000-4000-8000-000000000001',
    'ocr-source-publication-01'), false);
select pg_temp.source_case('publication', 'request naming another member of the clinic', '23514',
  pg_temp.publication_insert('e8b10000-0000-4000-8000-000000000002', 'e8b30000-0000-4000-8000-000000000003',
    'ocr-source-publication-02'), false);
select pg_temp.source_case('publication', 'request naming the session account''s other membership', '23514',
  pg_temp.publication_insert('e8b10000-0000-4000-8000-000000000001', 'e8b30000-0000-4000-8000-000000000002',
    'ocr-source-publication-03'), false);
-- Refused by the guard since Stage 8; before, only by the foreign key (23503).
select pg_temp.source_case('publication', 'request naming an account with another account''s membership', '23514',
  pg_temp.publication_insert('e8b10000-0000-4000-8000-000000000002', 'e8b30000-0000-4000-8000-000000000001',
    'ocr-source-publication-04'), false);
select pg_temp.as_member('synthetic:ocr-source-a', '', 'e8b00000-0000-4000-8000-000000000002');
select pg_temp.source_case('publication', 'request by a session without a membership', '23514',
  pg_temp.publication_insert('e8b10000-0000-4000-8000-000000000001', 'e8b30000-0000-4000-8000-000000000001',
    'ocr-source-publication-05'), false);
select pg_temp.as_member('', 'e8b30000-0000-4000-8000-000000000001', 'e8b00000-0000-4000-8000-000000000002');
select pg_temp.source_case('publication', 'request by a session without a subject', '23514',
  pg_temp.publication_insert('e8b10000-0000-4000-8000-000000000001', 'e8b30000-0000-4000-8000-000000000001',
    'ocr-source-publication-06'), false);
select pg_temp.as_member('synthetic:ocr-source-unknown', 'e8b30000-0000-4000-8000-000000000001',
  'e8b00000-0000-4000-8000-000000000002');
select pg_temp.source_case('publication', 'request by an unknown subject', '23514',
  pg_temp.publication_insert('e8b10000-0000-4000-8000-000000000001', 'e8b30000-0000-4000-8000-000000000001',
    'ocr-source-publication-07'), false);
-- C belongs to clinic B only, but names clinic A in the session.
select pg_temp.as_member('synthetic:ocr-source-c', 'e8b30000-0000-4000-8000-000000000004',
  'e8b00000-0000-4000-8000-000000000002');
select pg_temp.source_case('publication', 'request by a member of another clinic naming member A', '23514',
  pg_temp.publication_insert('e8b10000-0000-4000-8000-000000000001', 'e8b30000-0000-4000-8000-000000000001',
    'ocr-source-publication-08'), false);
select pg_temp.as_member('synthetic:ocr-source-b', 'e8b30000-0000-4000-8000-000000000003',
  'e8b00000-0000-4000-8000-000000000002');
select pg_temp.source_case('publication', 'request by member B naming member B', 'ok',
  pg_temp.publication_insert('e8b10000-0000-4000-8000-000000000002', 'e8b30000-0000-4000-8000-000000000003',
    'ocr-source-publication-09'), false);

-- Lifecycle (kept): A requests; the OCR API then claims and completes it. The
-- updates are not bound to a session (lease recovery and retries need that),
-- but the requester stays immutable and the state machine applies.
select pg_temp.as_member('synthetic:ocr-source-a', 'e8b30000-0000-4000-8000-000000000001',
  'e8b00000-0000-4000-8000-000000000002');
select pg_temp.source_case('publication', 'lifecycle: request by member A', 'ok',
  pg_temp.publication_insert('e8b10000-0000-4000-8000-000000000001', 'e8b30000-0000-4000-8000-000000000001',
    'ocr-source-publication-10'), true);
select pg_temp.as_member('synthetic:ocr-source-b', 'e8b30000-0000-4000-8000-000000000003',
  'e8b00000-0000-4000-8000-000000000002');
select pg_temp.source_case('publication', 'lifecycle: claim from another member''s session', 'ok', $s$
  select pg_temp.one_row($u$update ocr.publications set status = 'processing', processing_token = gen_random_uuid(),
      processing_expires_at = clock_timestamp() + interval '60 seconds', attempt_count = attempt_count + 1,
      failure_code = null, failure_summary = null, row_version = row_version + 1, correlation_id = 'ocr-source-suite'
    where validation_id = 'e8b80000-0000-4000-8000-000000000005' and status = 'pending'$u$)$s$, true);
select pg_temp.as_member('', '', 'e8b00000-0000-4000-8000-000000000002');
select pg_temp.source_case('publication', 'lifecycle: completion from a session without a member', 'ok', $s$
  select pg_temp.one_row($u$update ocr.publications set status = 'published', completed_at = clock_timestamp(),
      failed_at = null, processing_token = null, processing_expires_at = null,
      target_resource_type = 'document', target_resource_id = 'e8b50000-0000-4000-8000-000000000001',
      row_version = row_version + 1
    where validation_id = 'e8b80000-0000-4000-8000-000000000005' and status = 'processing'$u$)$s$, true);
select pg_temp.source_case('publication', 'lifecycle: changing the requester', '55000', $s$
  select pg_temp.one_row($u$update ocr.publications set requested_by = 'e8b10000-0000-4000-8000-000000000002',
      requested_by_membership_id = 'e8b30000-0000-4000-8000-000000000003', row_version = row_version + 1
    where validation_id = 'e8b80000-0000-4000-8000-000000000005'$u$)$s$, false);
select pg_temp.source_case('publication', 'lifecycle: reopening a published request', '23514', $s$
  select pg_temp.one_row($u$update ocr.publications set status = 'processing', processing_token = gen_random_uuid(),
      processing_expires_at = clock_timestamp() + interval '60 seconds', completed_at = null,
      row_version = row_version + 1
    where validation_id = 'e8b80000-0000-4000-8000-000000000005'$u$)$s$, false);
reset role;

do $$
declare
  owner_sees_documents boolean := current_setting('ocr_source.owner_sees_documents')::boolean;
  owner_sees_evidence boolean := current_setting('ocr_source.owner_sees_evidence')::boolean;
  mismatches text;
begin
  select string_agg(format('%s / %s: expected %s, got %s', area, name, expected, actual), E'\n' order by seq)
    into mismatches
    from ocr_source_cases
   where case when (area = 'job' and owner_sees_documents) or (area = 'publication' and owner_sees_evidence)
              then actual is distinct from expected
              else actual is not distinct from 'ok' end;
  if mismatches is not null then
    raise exception E'OCR job source and publication cases failed (owner sees documents: %, evidence: %):\n%',
      owner_sees_documents, owner_sees_evidence, mismatches;
  end if;
  raise notice 'OCR job source and publication suite: % cases passed (owner sees documents: %, evidence: %)',
    (select count(*) from ocr_source_cases), owner_sees_documents, owner_sees_evidence;
end $$;

rollback;
