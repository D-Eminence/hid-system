\set ON_ERROR_STOP on
-- 0112: deletion of an OCR source and its reading 7 days after the job
-- finished. Rollback-only. Every person, facility, document and line of text
-- here is made up (Test Patient Chidi Example, Deletion Test Clinic A/B,
-- "Fictional reading line" text, storage keys that name no real object).
--
-- Proves, as the exact runtime roles (hid_ocr_worker for the worker
-- commands, hid_ocr_api_runtime and hid_ehr_api_runtime for the services that
-- must not reach them), with the session settings each service sets:
--   - the security properties and EXECUTE grants of the 0112 functions; the
--     shared reckoning is granted to no role; the worker has no table
--     privilege on the rows it purges;
--   - which documents are due: every job finished (awaiting_validation,
--     validated, rejected, failed, cancelled) and the latest finish at least
--     7 days ago; a document with a job still queued, finished less than
--     7 days ago (6 days and 23 hours), on legal hold, with no job or not
--     'uploaded' is not due; a publication pending, processing or failed with
--     a retryable code and attempts left blocks until 72 hours after the
--     finish (then it no longer blocks, so a document finished 7 days ago is
--     due despite it); a terminally failed one does not block; due_seconds
--     and the backlog's due and overdue counts (due for more than 2 hours,
--     that is 7 days and 2 hours after the finish, plus a job stuck in
--     'extracted' for more than 24 hours, which is never listed);
--   - only an active ocr_worker subject may list, count, claim or purge; bad
--     input is refused;
--   - the claim: a due document becomes 'source_deleting' (idempotent:
--     'already_claimed'); a document not due is refused ('not_due'), also one
--     put on legal hold before the claim; claimed documents are listed first;
--     after the claim a new job, a failed -> queued retry and a legal hold
--     are refused; the purge requires the claim ('not_claimed' otherwise);
--   - the purge of a claimed document: status 'source_deleted', the neutral
--     file name, row_version + 2 (claim and purge; no ehr.record_versions
--     row); extractions'
--     raw_text NULL and structured_payload {}; validations' payloads, fields
--     and corrections emptied and the neutral reason; confirmations' neutral
--     reason and no evidence reference; every other column unchanged; job
--     ids and status, job events, outbox payloads, publications,
--     ehr.ocr_import_provenance, ocr.page_usage and ocr.ai_usage kept; one
--     audit row with ids and counts only;
--   - a document not due is refused ('not_due') and nothing changes;
--   - idempotency: a second purge changes nothing and writes no audit row; a
--     row added after the purge is blanked by the next call, with an audit row;
--   - the append-only triggers: a purge-shaped update of a row whose document
--     is not 'source_deleted' is refused, also with forged session settings;
--     any other update or a delete of an evidence row is refused, also on a
--     purged document; job events and ehr.ocr_import_provenance get no
--     exception; a runtime role cannot update the evidence tables at all;
--   - the document guard: a purged document is never changed again; only the
--     purge's exact change moves a document to 'source_deleted' (not another
--     shape, not a non-worker session, not a runtime role); an insert with
--     status 'source_deleted' is refused.
-- Under an owner that does not bypass row-level security (release checklist
-- P8) the worker commands see no document (as every OCR worker command sees
-- no job); the suite then checks the properties and the triggers only.
begin;

-- Security properties.
do $$
declare
  mismatch text;
  ocr_owner oid := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
begin
  select string_agg(format('%s: definer=%s config=%s', p.oid::regprocedure, p.prosecdef, p.proconfig), '; ')
    into mismatch
    from pg_proc p
    join (values
      ('ocr.list_worker_source_deletions(integer)'::regprocedure,
       '{"search_path=pg_catalog, ocr, auth, platform, pg_temp"}'::text[]),
      ('ocr.worker_source_deletion_backlog()'::regprocedure,
       '{"search_path=pg_catalog, ocr, ehr, auth, platform, pg_temp"}'::text[]),
      ('ocr.claim_worker_source_deletion(uuid,text)'::regprocedure,
       '{"search_path=pg_catalog, ocr, ehr, audit, auth, platform, pg_temp"}'::text[]),
      ('ocr.purge_worker_source_document(uuid,integer,text)'::regprocedure,
       '{"search_path=pg_catalog, ocr, ehr, audit, auth, platform, pg_temp"}'::text[]))
      expected(proc, config) on p.oid = expected.proc
   where not p.prosecdef or p.proconfig is distinct from expected.config or p.proowner <> ocr_owner;
  if mismatch is not null then
    raise exception '0112 command security properties differ: %', mismatch;
  end if;
  if exists (select 1 from pg_proc where oid = 'ocr.source_deletion_due(uuid)'::regprocedure
               and (prosecdef or proowner <> ocr_owner)) then
    raise exception 'ocr.source_deletion_due must be SECURITY INVOKER and the OCR owner''s';
  end if;
  select string_agg(format('%s to %s', p.oid::regprocedure, coalesce(grantee.rolname, 'PUBLIC')), '; ')
    into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
   where p.pronamespace = 'ocr'::regnamespace
     and p.proname in ('source_deletion_due', 'list_worker_source_deletions', 'worker_source_deletion_backlog',
       'claim_worker_source_deletion', 'purge_worker_source_document')
     and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner
     and (p.proname, coalesce(grantee.rolname, 'PUBLIC')) not in (
       ('list_worker_source_deletions', 'hid_ocr_worker'), ('worker_source_deletion_backlog', 'hid_ocr_worker'),
       ('claim_worker_source_deletion', 'hid_ocr_worker'), ('purge_worker_source_document', 'hid_ocr_worker'));
  if mismatch is not null then
    raise exception 'unexpected EXECUTE grants on the 0112 commands: %', mismatch;
  end if;
  if (select count(*) from pg_proc p, aclexplode(p.proacl) privilege
       where p.pronamespace = 'ocr'::regnamespace and privilege.privilege_type = 'EXECUTE'
         and privilege.grantee = 'hid_ocr_worker'::regrole
         and p.proname in ('list_worker_source_deletions', 'worker_source_deletion_backlog',
           'claim_worker_source_deletion', 'purge_worker_source_document')) <> 4 then
    raise exception 'the 0112 EXECUTE grants are incomplete';
  end if;
  -- The worker purges only through the command: no privilege on the rows.
  select string_agg(format('%s %s', privilege, table_name), '; ') into mismatch
    from unnest(array['ehr.documents', 'ocr.extractions', 'ocr.validations', 'ocr.patient_confirmations',
                      'ocr.jobs', 'ocr.publications']) table_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) privilege
   where has_table_privilege('hid_ocr_worker', table_name, privilege);
  if mismatch is not null then
    raise exception 'hid_ocr_worker has a table privilege: %', mismatch;
  end if;
end $$;

-- Fixtures (triggers and references skipped while they are inserted).
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('c0110000-0000-4000-8000-000000000001', 'Deletion Test Organization', 'deletion-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c0110000-0000-4000-8000-00000000000a', 'c0110000-0000-4000-8000-000000000001', 'Deletion Test Clinic A',
   'DELETION-A', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('c0111000-0000-4000-8000-000000000001', 'staff:deletion-doctor', 'deletion-doctor@example.invalid', 'Deletion Doctor', 'active'),
  ('c0111000-0000-4000-8000-000000000002', 'workload:deletion-worker', null, 'Deletion Worker', 'active'),
  ('c0111000-0000-4000-8000-000000000003', 'workload:deletion-not-a-worker', null, 'Deletion Not A Worker', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('c0112000-0000-4000-8000-000000000001', 'c0111000-0000-4000-8000-000000000001', 'Deletion Doctor',
   'deletion-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, active) values
  ('c0113000-0000-4000-8000-000000000001', 'c0112000-0000-4000-8000-000000000001',
   'c0111000-0000-4000-8000-000000000001', 'c0110000-0000-4000-8000-000000000001',
   'c0110000-0000-4000-8000-00000000000a', 'doctor', 'doctor', true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('c0114000-0000-4000-8000-000000000001', 'c0111000-0000-4000-8000-000000000001', 'doctor', 'facility',
   'c0113000-0000-4000-8000-000000000001', 'c0110000-0000-4000-8000-00000000000a', 'Synthetic deletion test');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c0114000-0000-4000-8000-000000000002', 'c0111000-0000-4000-8000-000000000002', 'ocr_worker', 'platform',
   'Synthetic deletion worker');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('c0115000-0000-4000-8000-000000000001', 'HID-DELTST', 'Chidi', 'Example', 'Test Patient Chidi Example', 'active');
-- Documents (two-digit suffix):
--   01 one validated job finished 30 h ago, published               -> due, overdue
--   02 one job awaiting validation, finished 25 h ago                -> due, not overdue
--   03 one job awaiting validation, finished 23 h ago                -> not due
--   04 a job failed 30 h ago and a job still queued                  -> not due
--   05 validated 30 h ago, a publication pending since 10 h ago      -> not due
--   06 validated 80 h ago, a publication processing since 79 h ago   -> due (after 72 h nothing blocks)
--   07 cancelled 30 h ago, on legal hold                              -> not due
--   08 no OCR job                                                     -> not due
--   09 rejected 30 h ago, status entered_in_error                     -> not due
--   10 rejected 30 h ago                                              -> due
--   11 validated 30 h ago, a publication failed retryably, 1 of 3     -> not due (blocked until 72 h)
--   12 validated 30 h ago, a publication failed terminally            -> due
--   13 a job stuck in 'extracted' since 30 h ago                      -> not due, but overdue
--   14 failed 30 h ago (attempts left)                                -> due; claimed, then job, retry, hold refused
--   15 rejected 30 h ago                                              -> due, then put on legal hold before its claim
--   16 a job queued since 50 h ago                                    -> not due, but overdue
--   17 a job queued since 50 h ago, parked by the page allowance      -> not due, not overdue
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status,
  retention_class, legal_hold)
select ('c0116000-0000-4000-8000-0000000000' || n)::uuid, 'c0115000-0000-4000-8000-000000000001',
       'c0110000-0000-4000-8000-00000000000a', 'c0111000-0000-4000-8000-000000000001',
       'c0113000-0000-4000-8000-000000000001', 'Fictional Example scan ' || n || '.pdf', 'synthetic-bucket',
       'clinical/objects/c0116000-0000-4000-8000-0000000000' || n, 'deletion-v' || n, 'application/pdf', 2048,
       repeat(right(n, 1), 64), case when n = '09' then 'entered_in_error' else 'uploaded' end, 'clinical_record',
       n = '07'
  from unnest(array['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17']) n;
insert into ehr.document_scan_events (document_id, patient_id, facility_id, created_by, event_type,
  detected_media_type, scanner_engine, scanner_version, idempotency_key, correlation_id, object_version_id,
  object_sha256_hex)
select ('c0116000-0000-4000-8000-0000000000' || n)::uuid, 'c0115000-0000-4000-8000-000000000001',
       'c0110000-0000-4000-8000-00000000000a', 'c0111000-0000-4000-8000-000000000001', 'clean', 'application/pdf',
       'synthetic-scanner', '1.0', 'deletion-scan-00' || n || 'x', 'deletion-scan', 'deletion-v' || n,
       repeat(right(n, 1), 64)
  from unnest(array['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17']) n;
insert into ocr.jobs (id, facility_id, document_id, patient_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, max_attempts, created_by, created_by_membership_id, correlation_id,
  status, attempt_count, completed_at, failed_at, last_error_code, updated_at, row_version)
select ('c0117000-0000-4000-8000-0000000000' || job.n)::uuid, 'c0110000-0000-4000-8000-00000000000a',
       ('c0116000-0000-4000-8000-0000000000' || job.document)::uuid, 'c0115000-0000-4000-8000-000000000001',
       'deletion-v' || job.document, repeat(right(job.document, 1), 64), 'deletion-fixture-00' || job.n,
       repeat('e', 64), 'deletion-provider', 3, 'c0111000-0000-4000-8000-000000000001',
       'c0113000-0000-4000-8000-000000000001', 'deletion-fixture', job.status, 1,
       case when job.status in ('awaiting_validation', 'validated', 'rejected', 'extracted')
            then clock_timestamp() - job.age end,
       case when job.status = 'failed' then clock_timestamp() - job.age end,
       case when job.status = 'failed' then 'PROVIDER_THROTTLED' end,
       clock_timestamp() - job.age, 4
  -- Due 7 days after the finish: 01 and the others at 7 days 6 hours (overdue
  -- after 7 days 2 hours), 02 at 7 days 1 hour (due, not overdue), 03 at 6
  -- days 23 hours (not due yet), 06 at 7 days 8 hours. 05 and 11 finished 30
  -- hours ago, inside the 72-hour publication cap. 13 is stuck in
  -- 'extracted' for 30 hours (more than 24).
  from (values ('01', '01', 'validated', interval '7 days 6 hours'),
               ('02', '02', 'awaiting_validation', interval '7 days 1 hour'),
               ('03', '03', 'awaiting_validation', interval '6 days 23 hours'),
               ('04', '04', 'failed', interval '7 days 6 hours'),
               ('14', '04', 'queued', interval '7 days 6 hours'),
               ('05', '05', 'validated', interval '30 hours'),
               ('06', '06', 'validated', interval '7 days 8 hours'),
               ('07', '07', 'cancelled', interval '7 days 6 hours'),
               ('09', '09', 'rejected', interval '7 days 6 hours'),
               ('10', '10', 'rejected', interval '7 days 6 hours'),
               ('11', '11', 'validated', interval '30 hours'),
               ('12', '12', 'validated', interval '7 days 6 hours'),
               ('13', '13', 'extracted', interval '30 hours'),
               ('24', '14', 'failed', interval '7 days 6 hours'),
               ('15', '15', 'rejected', interval '7 days 6 hours')) job(n, document, status, age);
insert into ocr.jobs (id, facility_id, document_id, patient_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, max_attempts, created_by, created_by_membership_id, correlation_id,
  status, attempt_count, queued_at, next_attempt_at, last_error_code, updated_at, row_version)
select ('c0117000-0000-4000-8000-0000000000' || n)::uuid, 'c0110000-0000-4000-8000-00000000000a',
       ('c0116000-0000-4000-8000-0000000000' || n)::uuid, 'c0115000-0000-4000-8000-000000000001',
       'deletion-v' || n, repeat(right(n, 1), 64), 'deletion-fixture-00' || n, repeat('e', 64), 'deletion-provider', 3,
       'c0111000-0000-4000-8000-000000000001', 'c0113000-0000-4000-8000-000000000001', 'deletion-fixture', 'queued', 1,
       clock_timestamp() - interval '50 hours',
       case when n = '17' then clock_timestamp() + interval '5 days' else clock_timestamp() - interval '49 hours' end,
       case when n = '17' then 'OCR_PAGE_ALLOWANCE_USED_UP' end, clock_timestamp() - interval '50 hours', 2
  from unnest(array['16','17']) n;
-- Reading and review content of jobs 01 (purged below) and 03 (not due).
insert into ocr.extractions (id, job_id, facility_id, document_id, patient_id, extraction_version, attempt_no,
  provider, provider_model, provider_result_key, content_sha256, source_object_version_id, source_sha256_hex,
  raw_text, structured_payload, confidence, provenance)
select ('c0118000-0000-4000-8000-0000000000' || n)::uuid, ('c0117000-0000-4000-8000-0000000000' || n)::uuid,
       'c0110000-0000-4000-8000-00000000000a', ('c0116000-0000-4000-8000-0000000000' || n)::uuid,
       'c0115000-0000-4000-8000-000000000001', 1, 1, 'deletion-provider', 'synthetic-model',
       'deletion-result-' || n, repeat('a', 64), 'deletion-v' || n, repeat(right(n, 1), 64),
       'Fictional reading line for Test Patient Chidi Example',
       '{"contract":"hid-paper-reading-v2","pages":[{"page":1,"text":"Fictional reading line"}]}'::jsonb, 0.9,
       '{"processingContract":"hid-textract-v2","pageCount":1,"lineCount":1}'::jsonb
  from unnest(array['01','03']) n;
insert into ocr.validations (id, job_id, facility_id, extraction_id, validation_version, validated_payload,
  corrections, reason, validated_by, validated_by_membership_id, disposition, target_domain, candidate_type,
  accepted_fields, rejected_fields, provenance, idempotency_key, request_sha256)
select ('c0119000-0000-4000-8000-0000000000' || n)::uuid, ('c0117000-0000-4000-8000-0000000000' || n)::uuid,
       'c0110000-0000-4000-8000-00000000000a', ('c0118000-0000-4000-8000-0000000000' || n)::uuid, 1,
       '{"title":"Fictional clinic visit","content":"Fictional reading line"}'::jsonb,
       '[{"field":"title","originalValue":"Fictional","correctedValue":"Fictional clinic visit"}]'::jsonb,
       'Reviewer checked the fictional page', 'c0111000-0000-4000-8000-000000000001',
       'c0113000-0000-4000-8000-000000000001', 'validated', 'EHR', 'clinical_note',
       '{"title":"Fictional clinic visit","content":"Fictional reading line"}'::jsonb,
       '[{"field":"noteType","originalValue":"Fictional note type"}]'::jsonb,
       '{"source":"human_review"}'::jsonb, 'deletion-validation-' || n || 'xxxxx', repeat('b', 64)
  from unnest(array['01','03']) n;
insert into ocr.patient_confirmations (id, job_id, facility_id, patient_id, confirmation_version, method,
  evidence_reference, reason, confirmed_by, confirmed_by_membership_id, idempotency_key, request_sha256)
select ('c011a000-0000-4000-8000-0000000000' || n)::uuid, ('c0117000-0000-4000-8000-0000000000' || n)::uuid,
       'c0110000-0000-4000-8000-00000000000a', 'c0115000-0000-4000-8000-000000000001', 1, 'source_document',
       'Fictional folder 0000', 'Name on the fictional page matches', 'c0111000-0000-4000-8000-000000000001',
       'c0113000-0000-4000-8000-000000000001', 'deletion-confirm-' || n || 'xxxxxxx', repeat('c', 64)
  from unnest(array['01','03']) n;
-- Publications: 01 published, 05 pending since 10 h ago, 06 processing since
-- 7 days 7 hours ago, 11 failed with a retryable code (attempt 1 of 3), 12
-- failed terminally.
insert into ocr.publications (id, job_id, validation_id, validation_version, patient_confirmation_id, facility_id,
  patient_id, target_domain, target_operation, status, idempotency_key, request_sha256, requested_by,
  requested_by_membership_id, requested_at, completed_at, target_resource_type, target_resource_id,
  processing_token, processing_expires_at, failed_at, failure_code, attempt_count, correlation_id)
select ('c011b000-0000-4000-8000-0000000000' || p.n)::uuid, ('c0117000-0000-4000-8000-0000000000' || p.n)::uuid,
       ('c0119000-0000-4000-8000-0000000000' || p.n)::uuid, 1, ('c011a000-0000-4000-8000-0000000000' || p.n)::uuid,
       'c0110000-0000-4000-8000-00000000000a', 'c0115000-0000-4000-8000-000000000001', 'EHR',
       'create_imported_clinical_note', p.status, 'deletion-publication-' || p.n || 'xxx', repeat('d', 64),
       'c0111000-0000-4000-8000-000000000001', 'c0113000-0000-4000-8000-000000000001',
       clock_timestamp() - p.age,
       case when p.status = 'published' then clock_timestamp() - p.age end,
       case when p.status = 'published' then 'clinical_note' end,
       case when p.status = 'published' then 'c011c000-0000-4000-8000-000000000001'::uuid end,
       case when p.status = 'processing' then 'c011d000-0000-4000-8000-000000000006'::uuid end,
       case when p.status = 'processing' then clock_timestamp() - interval '7 days 6 hours' end,
       case when p.status = 'failed' then clock_timestamp() - p.age end, p.failure_code, p.attempts,
       'deletion-publication'
  from (values ('01', 'published', interval '7 days 5 hours', null, 1), ('05', 'pending', interval '10 hours', null, 0),
               ('06', 'processing', interval '7 days 7 hours', null, 1),
               ('11', 'failed', interval '29 hours', 'OWNING_SERVICE_UNAVAILABLE', 1),
               ('12', 'failed', interval '7 days 5 hours', 'EHR_VALIDATION_FAILED', 1)) p(n, status, age, failure_code, attempts);
insert into ehr.ocr_import_provenance (id, clinical_resource_type, clinical_resource_id, facility_id, patient_id,
  document_id, ocr_job_id, extraction_id, validation_id, validation_version, publication_id, reviewed_by,
  published_by) values
  ('c011e000-0000-4000-8000-000000000001', 'clinical_note', 'c011c000-0000-4000-8000-000000000001',
   'c0110000-0000-4000-8000-00000000000a', 'c0115000-0000-4000-8000-000000000001',
   'c0116000-0000-4000-8000-000000000001', 'c0117000-0000-4000-8000-000000000001',
   'c0118000-0000-4000-8000-000000000001', 'c0119000-0000-4000-8000-000000000001', 1,
   'c011b000-0000-4000-8000-000000000001', 'c0111000-0000-4000-8000-000000000001',
   'c0111000-0000-4000-8000-000000000001');
insert into ocr.job_events (job_id, facility_id, from_status, to_status, job_version, correlation_id)
values ('c0117000-0000-4000-8000-000000000001', 'c0110000-0000-4000-8000-00000000000a', 'awaiting_validation',
        'validated', 4, 'deletion-fixture');
insert into ocr.page_usage (job_id, facility_id, usage_month, pages) values
  ('c0117000-0000-4000-8000-000000000001', 'c0110000-0000-4000-8000-00000000000a',
   date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos')::date, 2);
insert into ocr.ai_usage (job_id, attempt_no, model, facility_id, usage_month, requests, input_tokens,
  output_tokens, cache_read_tokens, cache_write_tokens) values
  ('c0117000-0000-4000-8000-000000000001', 1, 'claude-synthetic-model', 'c0110000-0000-4000-8000-00000000000a',
   date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos')::date, 2, 100, 50, 0, 0);
set local session_replication_role = origin;

-- What the fixtures looked like, to compare against after the purge.
create temporary table deletion_before on commit drop as
  select 'extraction' as kind, to_jsonb(row_value) - array['raw_text', 'structured_payload'] as kept
    from ocr.extractions row_value where id = 'c0118000-0000-4000-8000-000000000001'
  union all
  select 'validation', to_jsonb(row_value) - array['validated_payload', 'accepted_fields', 'rejected_fields',
           'corrections', 'reason']
    from ocr.validations row_value where id = 'c0119000-0000-4000-8000-000000000001'
  union all
  select 'confirmation', to_jsonb(row_value) - array['reason', 'evidence_reference']
    from ocr.patient_confirmations row_value where id = 'c011a000-0000-4000-8000-000000000001'
  union all
  select 'document', to_jsonb(row_value) - array['status', 'original_file_name', 'row_version', 'updated_at']
    from ehr.documents row_value where id = 'c0116000-0000-4000-8000-000000000001'
  union all
  select 'document-version', jsonb_build_object('row_version', row_version)
    from ehr.documents where id = 'c0116000-0000-4000-8000-000000000001'
  union all
  select 'job', to_jsonb(row_value) from ocr.jobs row_value where id = 'c0117000-0000-4000-8000-000000000001'
  union all
  select 'publication', to_jsonb(row_value) from ocr.publications row_value
   where id = 'c011b000-0000-4000-8000-000000000001'
  union all
  select 'provenance', to_jsonb(row_value) from ehr.ocr_import_provenance row_value
   where id = 'c011e000-0000-4000-8000-000000000001'
  union all
  select 'job-events', jsonb_agg(to_jsonb(row_value) order by row_value.id) from ocr.job_events row_value
   where job_id = 'c0117000-0000-4000-8000-000000000001'
  union all
  select 'usage', jsonb_build_object(
      'pages', (select jsonb_agg(to_jsonb(page_row)) from ocr.page_usage page_row
                 where job_id = 'c0117000-0000-4000-8000-000000000001'),
      'ai', (select jsonb_agg(to_jsonb(ai_row)) from ocr.ai_usage ai_row
              where job_id = 'c0117000-0000-4000-8000-000000000001'))
  union all
  select 'record-versions', jsonb_build_object('count', count(*)) from ehr.record_versions
   where resource_id = 'c0116000-0000-4000-8000-000000000001';

-- Can the commands' owner see the fixture documents? Not under a non-bypass
-- owner (release checklist P8).
do $$
declare
  owner_role name := (select pg_get_userbyid(relowner) from pg_class where oid = 'ocr.jobs'::regclass);
  visible boolean;
begin
  execute format('set local role %I', owner_role);
  visible := exists (select 1 from ehr.documents where id = 'c0116000-0000-4000-8000-000000000001');
  reset role;
  perform set_config('ocr_deletion.owner_sees', visible::text, true);
end $$;

create temporary table deletion_cases (seq serial, name text, expected text, actual text) on commit drop;
grant insert, select on deletion_cases to public;
grant usage on sequence deletion_cases_seq_seq to public;

-- 'ok' or the SQLSTATE; with keep = false a success is undone.
create function pg_temp.deletion_try(statement text, keep boolean) returns text language plpgsql as $$
declare outcome text;
begin
  begin
    execute statement;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'deletion-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'deletion-suite: undo' then outcome := sqlstate; end if;
  end;
  return outcome;
end $$;
create function pg_temp.deletion_case(case_name text, expected text, statement text, keep boolean) returns void
language plpgsql as $$
begin
  insert into deletion_cases (name, expected, actual)
  values (case_name, expected, pg_temp.deletion_try(statement, keep));
end $$;
create function pg_temp.deletion_check(case_name text, ok boolean) returns void language plpgsql as $$
begin
  insert into deletion_cases (name, expected, actual) values (case_name, 'true', coalesce(ok, false)::text);
end $$;
create function pg_temp.deletion_value(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  insert into deletion_cases (name, expected, actual) values (case_name, expected, actual);
end $$;
grant execute on function pg_temp.deletion_try(text, boolean), pg_temp.deletion_case(text, text, text, boolean),
  pg_temp.deletion_check(text, boolean), pg_temp.deletion_value(text, text, text) to public;

create function pg_temp.as_worker(subject text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.correlation_id', 'deletion-suite-worker', true),
    set_config('app.facility_id', '', true), set_config('app.membership_id', '', true);
$$;
create function pg_temp.as_staff() returns void language sql as $$
  select set_config('app.actor_subject', 'staff:deletion-doctor', true),
    set_config('app.facility_id', 'c0110000-0000-4000-8000-00000000000a', true),
    set_config('app.membership_id', 'c0113000-0000-4000-8000-000000000001', true),
    set_config('app.correlation_id', 'deletion-suite-staff', true),
    set_config('app.purpose_of_use', 'direct-care', true),
    set_config('app.change_reason', 'Synthetic deletion suite change', true);
$$;
grant execute on function pg_temp.as_worker(text), pg_temp.as_staff() to public;

-- 1. The worker: listing, counting, refusals, the purge.
set local role hid_ocr_worker;
select pg_temp.as_worker('workload:deletion-not-a-worker');
select pg_temp.deletion_case('a subject without ocr_worker may not list', '42501',
  'select * from ocr.list_worker_source_deletions(10)', false);
select pg_temp.deletion_case('a subject without ocr_worker may not count', '42501',
  'select * from ocr.worker_source_deletion_backlog()', false);
select pg_temp.deletion_case('a subject without ocr_worker may not claim', '42501',
  $q$select * from ocr.claim_worker_source_deletion('c0116000-0000-4000-8000-000000000001', 'deletion-suite-claim')$q$, false);
select pg_temp.deletion_case('a subject without ocr_worker may not purge', '42501',
  $q$select * from ocr.purge_worker_source_document('c0116000-0000-4000-8000-000000000001', 1, 'deletion-suite-purge')$q$, false);
select pg_temp.as_worker('workload:deletion-worker');
select pg_temp.deletion_case('the worker may not read the evidence tables', '42501',
  'select 1 from ocr.extractions limit 1', false);
select pg_temp.deletion_case('the worker may not update the evidence tables', '42501',
  $q$update ocr.extractions set raw_text = null where id = 'c0118000-0000-4000-8000-000000000003'$q$, false);
select pg_temp.deletion_case('a limit of 0 is refused', '22023',
  'select * from ocr.list_worker_source_deletions(0)', false);
select pg_temp.deletion_case('a limit over 500 is refused', '22023',
  'select * from ocr.list_worker_source_deletions(501)', false);
select pg_temp.deletion_case('a negative version count is refused', '22023',
  $q$select * from ocr.purge_worker_source_document('c0116000-0000-4000-8000-000000000001', -1, 'deletion-suite-purge')$q$, false);
select pg_temp.deletion_case('a short correlation id is refused', '22023',
  $q$select * from ocr.purge_worker_source_document('c0116000-0000-4000-8000-000000000001', 1, 'short')$q$, false);
select pg_temp.deletion_case('a claim with a short correlation id is refused', '22023',
  $q$select * from ocr.claim_worker_source_deletion('c0116000-0000-4000-8000-000000000001', 'short')$q$, false);
select pg_temp.deletion_case('an unknown document cannot be claimed', 'P0002',
  $q$select * from ocr.claim_worker_source_deletion('c0116000-0000-4000-8000-0000000000ff', 'deletion-suite-claim')$q$, false);
select pg_temp.deletion_case('an unknown document is not found', 'P0002',
  $q$select * from ocr.purge_worker_source_document('c0116000-0000-4000-8000-0000000000ff', 1, 'deletion-suite-purge')$q$, false);

do $$
declare
  listed text;
  owner_sees boolean := current_setting('ocr_deletion.owner_sees')::boolean;
  backlog record;
  purge record;
begin
  if not owner_sees then
    raise notice 'ocr-source-deletion: the commands'' owner does not bypass row-level security; worker data cases skipped';
    return;
  end if;
  select string_agg(right(document_id::text, 2), ',' order by document_id) into listed
    from ocr.list_worker_source_deletions(500) where document_id::text like 'c0116000-%';
  perform pg_temp.deletion_value('due: 01, 02, 06, 10, 12, 14 and 15 only', '01,02,06,10,12,14,15', listed);
  perform pg_temp.deletion_check('the listing gives the stored bucket and exact key',
    exists (select 1 from ocr.list_worker_source_deletions(500)
             where document_id = 'c0116000-0000-4000-8000-000000000001'
               and facility_id = 'c0110000-0000-4000-8000-00000000000a' and storage_bucket = 'synthetic-bucket'
               and storage_key = 'clinical/objects/c0116000-0000-4000-8000-000000000001'));
  perform pg_temp.deletion_check('01 is due for about 6 hours (finished 7 days and 6 hours ago)',
    (select due_seconds between 6 * 3600 - 60 and 6 * 3600 + 60 from ocr.list_worker_source_deletions(500)
      where document_id = 'c0116000-0000-4000-8000-000000000001'));
  perform pg_temp.deletion_check('02 is due for about 1 hour (finished 7 days and 1 hour ago)',
    (select due_seconds between 3600 - 60 and 3600 + 60 from ocr.list_worker_source_deletions(500)
      where document_id = 'c0116000-0000-4000-8000-000000000002'));
  perform pg_temp.deletion_check('06 is due 7 days after its finish despite its stuck publication, past the 72-hour cap (about 8 hours)',
    (select due_seconds between 8 * 3600 - 60 and 8 * 3600 + 60 from ocr.list_worker_source_deletions(500)
      where document_id = 'c0116000-0000-4000-8000-000000000006'));
  perform pg_temp.deletion_check('the listing honours the limit',
    (select count(*) from ocr.list_worker_source_deletions(1)) = 1);
  select * into backlog from ocr.worker_source_deletion_backlog();
  perform pg_temp.deletion_check('the backlog counts every due document',
    backlog.due = (select count(*) from ocr.list_worker_source_deletions(500)));
  perform pg_temp.deletion_check('overdue: due for more than 2 hours, 7 days and 2 hours after the finish (01, 06, 10, 12, 14, 15; not 02), plus 13 stuck in extracted and 16 queued for 50 h (not 17, parked by the allowance)',
    backlog.overdue = (select count(*) from ocr.list_worker_source_deletions(500) where due_seconds > 7200) + 2
    and backlog.overdue >= 7 and backlog.due >= 7);

  -- Not due: the claim refuses and nothing changes.
  for purge in select * from (values ('03', 'finished 6 days and 23 hours ago, less than 7 days'), ('04', 'a job still queued'),
      ('05', 'a publication pending, finished 30 h ago'), ('07', 'on legal hold'), ('08', 'no OCR job'),
      ('09', 'not uploaded'), ('11', 'a publication failed retryably with attempts left, finished 30 h ago'),
      ('13', 'a job stuck in extracted'), ('16', 'a job queued for 50 h')) x(n, why)
  loop
    perform pg_temp.deletion_value('not due (' || purge.why || ')', 'not_due',
      (select outcome from ocr.claim_worker_source_deletion(('c0116000-0000-4000-8000-0000000000' || purge.n)::uuid,
         'deletion-suite-claim')));
  end loop;

  -- The purge requires the claim.
  perform pg_temp.deletion_value('a purge without a claim changes nothing', 'not_claimed,0,0,0',
    (select concat_ws(',', outcome, extractions, validations, confirmations)
       from ocr.purge_worker_source_document('c0116000-0000-4000-8000-000000000001', 2, 'deletion-suite-purge')));

  -- Claim, then (the worker deletes 2 S3 versions), then purge.
  perform pg_temp.deletion_value('the claim of 01', 'claimed,synthetic-bucket,clinical/objects/c0116000-0000-4000-8000-000000000001',
    (select concat_ws(',', outcome, storage_bucket, storage_key)
       from ocr.claim_worker_source_deletion('c0116000-0000-4000-8000-000000000001', 'deletion-suite-claim')));
  perform pg_temp.deletion_value('a second claim of 01 is idempotent', 'already_claimed',
    (select outcome from ocr.claim_worker_source_deletion('c0116000-0000-4000-8000-000000000001',
       'deletion-suite-claim-2')));
  perform pg_temp.deletion_check('a claimed document is listed first (a batch of 2: one claimed, one due)',
    (select array_agg(document_id) from ocr.list_worker_source_deletions(2))
      = array['c0116000-0000-4000-8000-000000000001', 'c0116000-0000-4000-8000-000000000006']::uuid[]);
  perform pg_temp.deletion_check('a claimed document still counts as due and overdue',
    (select due from ocr.worker_source_deletion_backlog()) = backlog.due
    and (select overdue from ocr.worker_source_deletion_backlog()) = backlog.overdue);
  perform pg_temp.deletion_value('the purge of 01', 'deleted,1,1,1',
    (select concat_ws(',', outcome, extractions, validations, confirmations)
       from ocr.purge_worker_source_document('c0116000-0000-4000-8000-000000000001', 2, 'deletion-suite-purge')));
  perform pg_temp.deletion_value('a second purge of 01 changes nothing', 'already_deleted,0,0,0',
    (select concat_ws(',', outcome, extractions, validations, confirmations)
       from ocr.purge_worker_source_document('c0116000-0000-4000-8000-000000000001', 0, 'deletion-suite-purge-2')));
  perform pg_temp.deletion_value('a claim of a deleted document', 'already_deleted',
    (select outcome from ocr.claim_worker_source_deletion('c0116000-0000-4000-8000-000000000001',
       'deletion-suite-claim-3')));
  perform pg_temp.deletion_check('01 is no longer listed',
    not exists (select 1 from ocr.list_worker_source_deletions(500)
                 where document_id = 'c0116000-0000-4000-8000-000000000001'));

  -- 14: claimed, and its S3 deletion has not finished (no purge yet).
  perform pg_temp.deletion_value('the claim of 14', 'claimed',
    (select outcome from ocr.claim_worker_source_deletion('c0116000-0000-4000-8000-000000000014',
       'deletion-suite-claim')));
end $$;
reset role;

-- 2. What the purge left, read as the owner.
do $$
begin
  if not current_setting('ocr_deletion.owner_sees')::boolean then return; end if;
  perform pg_temp.deletion_check('a refused claim changes nothing, and writes no audit row',
    (select count(*) from ehr.documents where status = 'uploaded' and id in (
       'c0116000-0000-4000-8000-000000000003', 'c0116000-0000-4000-8000-000000000004',
       'c0116000-0000-4000-8000-000000000005', 'c0116000-0000-4000-8000-000000000007',
       'c0116000-0000-4000-8000-000000000008', 'c0116000-0000-4000-8000-000000000011',
       'c0116000-0000-4000-8000-000000000013', 'c0116000-0000-4000-8000-000000000016')) = 8
    and not exists (select 1 from audit.events where action like 'ocr.source.%'
                     and resource_id::text like 'c0116000-%' and resource_id not in (
                       'c0116000-0000-4000-8000-000000000001', 'c0116000-0000-4000-8000-000000000014')));
  perform pg_temp.deletion_check('14 is source_deleting with its name, nothing blanked yet',
    (select status = 'source_deleting' and original_file_name = 'Fictional Example scan 14.pdf'
       from ehr.documents where id = 'c0116000-0000-4000-8000-000000000014')
    and (select count(*) from audit.events where action = 'ocr.source.deletion_claimed'
          and resource_id = 'c0116000-0000-4000-8000-000000000014') = 1);
  perform pg_temp.deletion_check('the document is source_deleted with the neutral name and the next version',
    (select status = 'source_deleted' and original_file_name = 'Source page deleted after 7 days'
            and row_version = (select (kept ->> 'row_version')::bigint + 2 from deletion_before
                                where kind = 'document-version')
       from ehr.documents where id = 'c0116000-0000-4000-8000-000000000001'));
  perform pg_temp.deletion_check('ehr.documents_effective shows source_deleted',
    (select status from ehr.documents_effective where id = 'c0116000-0000-4000-8000-000000000001')
      = 'source_deleted');
  perform pg_temp.deletion_check('every other document column is unchanged',
    (select to_jsonb(d) - array['status', 'original_file_name', 'row_version', 'updated_at'] from ehr.documents d
      where id = 'c0116000-0000-4000-8000-000000000001')
      = (select kept from deletion_before where kind = 'document'));
  perform pg_temp.deletion_check('no ehr.record_versions row was written for the purge',
    (select count(*) from ehr.record_versions where resource_id = 'c0116000-0000-4000-8000-000000000001')
      = (select (kept ->> 'count')::bigint from deletion_before where kind = 'record-versions'));
  perform pg_temp.deletion_check('the extraction holds no text or reading, the rest unchanged',
    (select raw_text is null and structured_payload = '{}'::jsonb
            and to_jsonb(e) - array['raw_text', 'structured_payload']
              = (select kept from deletion_before where kind = 'extraction')
       from ocr.extractions e where id = 'c0118000-0000-4000-8000-000000000001'));
  perform pg_temp.deletion_check('the validation holds no payload, fields or corrections and the neutral reason',
    (select validated_payload = '{}'::jsonb and accepted_fields = '{}'::jsonb and rejected_fields = '[]'::jsonb
            and corrections = '[]'::jsonb and reason = 'Content deleted after 7 days'
            and to_jsonb(v) - array['validated_payload', 'accepted_fields', 'rejected_fields', 'corrections', 'reason']
              = (select kept from deletion_before where kind = 'validation')
       from ocr.validations v where id = 'c0119000-0000-4000-8000-000000000001'));
  perform pg_temp.deletion_check('the confirmation holds the neutral reason and no evidence reference',
    (select reason = 'Content deleted after 7 days' and evidence_reference is null
            and to_jsonb(c) - array['reason', 'evidence_reference']
              = (select kept from deletion_before where kind = 'confirmation')
       from ocr.patient_confirmations c where id = 'c011a000-0000-4000-8000-000000000001'));
  perform pg_temp.deletion_check('the job, its events, the publication, the EHR provenance and the usage are kept',
    (select to_jsonb(j) from ocr.jobs j where id = 'c0117000-0000-4000-8000-000000000001')
      = (select kept from deletion_before where kind = 'job')
    and (select to_jsonb(p) from ocr.publications p where id = 'c011b000-0000-4000-8000-000000000001')
      = (select kept from deletion_before where kind = 'publication')
    and (select to_jsonb(p) from ehr.ocr_import_provenance p where id = 'c011e000-0000-4000-8000-000000000001')
      = (select kept from deletion_before where kind = 'provenance')
    and (select jsonb_agg(to_jsonb(e) order by e.id) from ocr.job_events e
          where job_id = 'c0117000-0000-4000-8000-000000000001')
      = (select kept from deletion_before where kind = 'job-events')
    and jsonb_build_object(
          'pages', (select jsonb_agg(to_jsonb(page_row)) from ocr.page_usage page_row
                     where job_id = 'c0117000-0000-4000-8000-000000000001'),
          'ai', (select jsonb_agg(to_jsonb(ai_row)) from ocr.ai_usage ai_row
                  where job_id = 'c0117000-0000-4000-8000-000000000001'))
      = (select kept from deletion_before where kind = 'usage'));
  perform pg_temp.deletion_check('the not-due documents and their rows are untouched',
    (select count(*) from ehr.documents where id::text like 'c0116000-%' and status = 'source_deleted') = 1
    and (select count(*) from ehr.documents where id::text like 'c0116000-%' and status = 'source_deleting') = 1
    and (select raw_text from ocr.extractions where id = 'c0118000-0000-4000-8000-000000000003')
      = 'Fictional reading line for Test Patient Chidi Example');
  perform pg_temp.deletion_check('exactly one audit row, ids and counts only',
    (select count(*) from audit.events where action = 'ocr.source.deleted_after_7d'
      and resource_id = 'c0116000-0000-4000-8000-000000000001') = 1
    and (select actor_type = 'workload' and actor_subject = 'workload:deletion-worker'
              and facility_id = 'c0110000-0000-4000-8000-00000000000a'
              and patient_id = 'c0115000-0000-4000-8000-000000000001' and resource_type = 'document'
              and details ->> 'objectVersionsDeleted' = '2' and details ->> 'jobCount' = '1'
              and details ->> 'extractionsBlanked' = '1' and details ->> 'validationsBlanked' = '1'
              and details ->> 'confirmationsBlanked' = '1' and (details ->> 'secondsPastDue')::bigint > 6 * 3600 - 120
              and position('Fictional' in details::text) = 0 and position('Example' in details::text) = 0
              and reason is null
         from audit.events where action = 'ocr.source.deleted_after_7d'
          and resource_id = 'c0116000-0000-4000-8000-000000000001')
    and (select count(*) from audit.events where action = 'ocr.source.deletion_claimed'
          and resource_id = 'c0116000-0000-4000-8000-000000000001') = 1);

  -- 15: put on legal hold (by staff) before its claim: no longer due.
  perform pg_temp.as_staff();
  update ehr.documents set legal_hold = true where id = 'c0116000-0000-4000-8000-000000000015';
  perform pg_temp.as_worker('workload:deletion-worker');
end $$;

-- 2b. After a claim: a legal hold set before it makes the document not due;
-- on the claimed document 14 a new job, a retry and a legal hold are refused.
set local role hid_ocr_worker;
select pg_temp.as_worker('workload:deletion-worker');
do $$
begin
  if not current_setting('ocr_deletion.owner_sees')::boolean then return; end if;
  perform pg_temp.deletion_value('a document put on legal hold before its claim is not due', 'not_due',
    (select outcome from ocr.claim_worker_source_deletion('c0116000-0000-4000-8000-000000000015',
       'deletion-suite-claim')));
  -- Stuck claims: 14 (claimed first), then 02, 06 and 10 claimed and their
  -- S3 deletion assumed failing; 12 is the only due document left.
  perform ocr.claim_worker_source_deletion(('c0116000-0000-4000-8000-0000000000' || n)::uuid, 'deletion-suite-claim')
     from unnest(array['02', '06', '10']) n;
  perform pg_temp.deletion_value('claimed documents take at most half a batch; the least recently attempted first',
    '14,12', (select string_agg(right(document_id::text, 2), ',') from ocr.list_worker_source_deletions(2)));
  perform pg_temp.deletion_value('another attempt at 14', 'already_claimed',
    (select outcome from ocr.claim_worker_source_deletion('c0116000-0000-4000-8000-000000000014',
       'deletion-suite-claim')));
  perform pg_temp.deletion_value('after that attempt 14 goes last among the claimed', '02,12',
    (select string_agg(right(document_id::text, 2), ',') from ocr.list_worker_source_deletions(2)));
  perform pg_temp.deletion_value('with room, every claimed document is listed (least recently attempted first), then the due',
    '02,06,10,14,12', (select string_agg(right(document_id::text, 2), ',') from ocr.list_worker_source_deletions(500)
                         where document_id::text like 'c0116000-%'));
  perform pg_temp.deletion_value('with 3 places: one fresh, two claimed', '02,06,12',
    (select string_agg(right(document_id::text, 2), ',') from ocr.list_worker_source_deletions(3)));
  perform pg_temp.deletion_case('the worker may not read the attempts', '42501',
    'select 1 from ocr.source_deletion_attempts', false);
end $$;
reset role;
select pg_temp.as_staff();
do $$
begin
  if not current_setting('ocr_deletion.owner_sees')::boolean then return; end if;
  perform pg_temp.deletion_case('a claimed document cannot be put on legal hold', '55000',
    $q$update ehr.documents set legal_hold = true where id = 'c0116000-0000-4000-8000-000000000014'$q$, false);
  perform pg_temp.deletion_case('a deleted document cannot be put on legal hold', '55000',
    $q$update ehr.documents set legal_hold = true where id = 'c0116000-0000-4000-8000-000000000001'$q$, false);
  perform pg_temp.deletion_case('no new job on a claimed document', '55000',
    $q$insert into ocr.jobs (facility_id, document_id, patient_id, source_object_version_id, source_sha256_hex,
         idempotency_key, request_sha256, provider, created_by, created_by_membership_id, correlation_id)
       values ('c0110000-0000-4000-8000-00000000000a', 'c0116000-0000-4000-8000-000000000014',
         'c0115000-0000-4000-8000-000000000001', 'deletion-v14', repeat('4', 64), 'deletion-new-job-14xxxx',
         repeat('e', 64), 'deletion-provider', 'c0111000-0000-4000-8000-000000000001',
         'c0113000-0000-4000-8000-000000000001', 'deletion-suite-staff')$q$, false);
  perform pg_temp.deletion_case('no new job on a deleted document', '55000',
    $q$insert into ocr.jobs (facility_id, document_id, patient_id, source_object_version_id, source_sha256_hex,
         idempotency_key, request_sha256, provider, created_by, created_by_membership_id, correlation_id)
       values ('c0110000-0000-4000-8000-00000000000a', 'c0116000-0000-4000-8000-000000000001',
         'c0115000-0000-4000-8000-000000000001', 'deletion-v01', repeat('1', 64), 'deletion-new-job-01xxxx',
         repeat('e', 64), 'deletion-provider', 'c0111000-0000-4000-8000-000000000001',
         'c0113000-0000-4000-8000-000000000001', 'deletion-suite-staff')$q$, false);
  perform pg_temp.deletion_case('no failed -> queued retry on a claimed document', '55000',
    $q$update ocr.jobs set status = 'queued', failed_at = null, next_attempt_at = clock_timestamp(),
         row_version = row_version + 1 where id = 'c0117000-0000-4000-8000-000000000024'$q$, false);
  perform pg_temp.deletion_case('a failed job of a claimed document may still be cancelled', 'ok',
    $q$update ocr.jobs set status = 'cancelled', row_version = row_version + 1
       where id = 'c0117000-0000-4000-8000-000000000024'$q$, false);
end $$;
do $$
begin
  if not current_setting('ocr_deletion.owner_sees')::boolean then return; end if;
  perform pg_temp.deletion_check('the attempts table holds ids, counts and times: 14 tried twice, 01 once',
    (select attempts from ocr.source_deletion_attempts where document_id = 'c0116000-0000-4000-8000-000000000014') = 2
    and (select attempts from ocr.source_deletion_attempts where document_id = 'c0116000-0000-4000-8000-000000000001') = 2
    and not exists (select 1 from information_schema.columns where table_schema = 'ocr'
                     and table_name = 'source_deletion_attempts' and data_type in ('text', 'jsonb', 'json')));
end $$;
select pg_temp.deletion_case('a failed -> queued retry on a document not claimed still works', 'ok',
  $q$update ocr.jobs set status = 'queued', failed_at = null, last_error_code = null, next_attempt_at = clock_timestamp(),
       row_version = row_version + 1 where id = 'c0117000-0000-4000-8000-000000000004'$q$, false);

-- 3. A confirmation added after the purge is blanked by the next call.
do $$
begin
  if not current_setting('ocr_deletion.owner_sees')::boolean then return; end if;
  set local session_replication_role = replica;
  insert into ocr.patient_confirmations (id, job_id, facility_id, patient_id, confirmation_version, method,
    evidence_reference, reason, confirmed_by, confirmed_by_membership_id, idempotency_key, request_sha256)
  values ('c011a000-0000-4000-8000-000000000011', 'c0117000-0000-4000-8000-000000000001',
    'c0110000-0000-4000-8000-00000000000a', 'c0115000-0000-4000-8000-000000000001', 2, 'source_document',
    'Fictional folder 0001', 'Late fictional confirmation reason', 'c0111000-0000-4000-8000-000000000001',
    'c0113000-0000-4000-8000-000000000001', 'deletion-confirm-late-xxxxx', repeat('c', 64));
  set local session_replication_role = origin;
end $$;
set local role hid_ocr_worker;
select pg_temp.as_worker('workload:deletion-worker');
do $$
begin
  if not current_setting('ocr_deletion.owner_sees')::boolean then return; end if;
  perform pg_temp.deletion_value('a late row is blanked by the next purge call', 'already_deleted,0,0,1',
    (select concat_ws(',', outcome, extractions, validations, confirmations)
       from ocr.purge_worker_source_document('c0116000-0000-4000-8000-000000000001', 0, 'deletion-suite-purge-3')));
end $$;
reset role;
do $$
begin
  if not current_setting('ocr_deletion.owner_sees')::boolean then return; end if;
  perform pg_temp.deletion_check('the late blanking wrote one more audit row',
    (select count(*) from audit.events where action = 'ocr.source.deleted_after_7d'
      and resource_id = 'c0116000-0000-4000-8000-000000000001') = 2
    and (select reason = 'Content deleted after 7 days' and evidence_reference is null
           from ocr.patient_confirmations where id = 'c011a000-0000-4000-8000-000000000011'));
end $$;

-- 4. The append-only triggers, as the OCR functions' owner (the only role
-- the exception can apply to) and as runtime roles.
select pg_temp.as_worker('workload:deletion-worker');
select set_config('hid.ocr.source_purge', 'c0116000-0000-4000-8000-000000000003', true);
select pg_temp.deletion_case('a purge-shaped extraction update of a document not deleted is refused (forged settings)',
  '55000', $q$update ocr.extractions set raw_text = null, structured_payload = '{}'
   where id = 'c0118000-0000-4000-8000-000000000003'$q$, false);
select pg_temp.deletion_case('a purge-shaped validation update of a document not deleted is refused', '55000',
  $q$update ocr.validations set validated_payload = '{}', accepted_fields = '{}', rejected_fields = '[]',
     corrections = '[]', reason = 'Content deleted after 7 days'
   where id = 'c0119000-0000-4000-8000-000000000003'$q$, false);
select pg_temp.deletion_case('a purge-shaped confirmation update of a document not deleted is refused', '55000',
  $q$update ocr.patient_confirmations set reason = 'Content deleted after 7 days', evidence_reference = null
   where id = 'c011a000-0000-4000-8000-000000000003'$q$, false);
select set_config('hid.ocr.source_purge', '', true);
select pg_temp.deletion_case('an ordinary extraction update is refused', '55000',
  $q$update ocr.extractions set raw_text = 'Changed fictional line' where id = 'c0118000-0000-4000-8000-000000000003'$q$, false);
select pg_temp.deletion_case('an extraction delete is refused', '55000',
  $q$delete from ocr.extractions where id = 'c0118000-0000-4000-8000-000000000003'$q$, false);
select pg_temp.deletion_case('a validation delete is refused', '55000',
  $q$delete from ocr.validations where id = 'c0119000-0000-4000-8000-000000000003'$q$, false);
select pg_temp.deletion_case('a confirmation delete is refused', '55000',
  $q$delete from ocr.patient_confirmations where id = 'c011a000-0000-4000-8000-000000000003'$q$, false);
do $$
begin
  if not current_setting('ocr_deletion.owner_sees')::boolean then return; end if;
  perform pg_temp.deletion_case('on a deleted document, text written back is refused', '55000',
    $q$update ocr.extractions set raw_text = 'Fictional text again' where id = 'c0118000-0000-4000-8000-000000000001'$q$, false);
  perform pg_temp.deletion_case('on a deleted document, another column with the blanking is refused', '55000',
    $q$update ocr.extractions set raw_text = null, structured_payload = '{}', confidence = 0.1
     where id = 'c0118000-0000-4000-8000-000000000001'$q$, false);
  perform pg_temp.deletion_case('on a deleted document, another reason is refused', '55000',
    $q$update ocr.validations set reason = 'Another neutral sentence' where id = 'c0119000-0000-4000-8000-000000000001'$q$, false);
  perform pg_temp.deletion_case('on a deleted document, the disposition stays', '55000',
    $q$update ocr.validations set disposition = 'rejected' where id = 'c0119000-0000-4000-8000-000000000001'$q$, false);
  perform pg_temp.deletion_case('on a deleted document, a delete is refused', '55000',
    $q$delete from ocr.extractions where id = 'c0118000-0000-4000-8000-000000000001'$q$, false);
  perform pg_temp.deletion_case('on a deleted document, the owner may re-apply the exact blanking', 'ok',
    $q$update ocr.extractions set raw_text = null, structured_payload = '{}'
     where id = 'c0118000-0000-4000-8000-000000000001'$q$, false);
  perform pg_temp.deletion_case('job events get no exception', '55000',
    $q$update ocr.job_events set reason_code = null where job_id = 'c0117000-0000-4000-8000-000000000001'$q$, false);
  perform pg_temp.deletion_case('ehr.ocr_import_provenance gets no exception', '55000',
    $q$update ehr.ocr_import_provenance set validation_version = 1
     where id = 'c011e000-0000-4000-8000-000000000001'$q$, false);
end $$;

-- A runtime role (the OCR API) cannot update the evidence tables, even for a
-- deleted document.
set local role hid_ocr_api_runtime;
select pg_temp.as_staff();
select pg_temp.deletion_case('the OCR API may not blank an extraction', '42501',
  $q$update ocr.extractions set raw_text = null, structured_payload = '{}'
   where id = 'c0118000-0000-4000-8000-000000000001'$q$, false);
select pg_temp.deletion_case('the OCR API may not blank a validation', '42501',
  $q$update ocr.validations set reason = 'Content deleted after 7 days'
   where id = 'c0119000-0000-4000-8000-000000000003'$q$, false);
reset role;

-- 5. The document guard. (The OCR functions' owner is trusted: it may make
-- the purge's exact change itself, which the purge function relies on.)
set local role hid_ocr_worker;
select pg_temp.as_worker('workload:deletion-worker');
select pg_temp.deletion_case('the worker may not update a document outside its commands', '42501',
  $q$update ehr.documents set status = 'source_deleting' where id = 'c0116000-0000-4000-8000-000000000003'$q$, false);
reset role;
select pg_temp.deletion_case('uploaded straight to source_deleted is refused (no claim)', '55000',
  $q$update ehr.documents set status = 'source_deleted', original_file_name = 'Source page deleted after 7 days'
   where id = 'c0116000-0000-4000-8000-000000000003'$q$, false);
select pg_temp.deletion_case('a claim of another shape is refused', '55000',
  $q$update ehr.documents set status = 'source_deleting', retention_class = 'changed'
   where id = 'c0116000-0000-4000-8000-000000000003'$q$, false);
select pg_temp.deletion_case('a document on legal hold is never claimed', '55000',
  $q$update ehr.documents set status = 'source_deleting' where id = 'c0116000-0000-4000-8000-000000000007'$q$, false);
select pg_temp.deletion_case('the owner, in a worker session, may make the exact claim (as the claim does)', 'ok',
  $q$update ehr.documents set status = 'source_deleting' where id = 'c0116000-0000-4000-8000-000000000003'$q$, false);
do $$
begin
  if not current_setting('ocr_deletion.owner_sees')::boolean then return; end if;
  perform pg_temp.deletion_case('a purge step keeping the file name is refused', '55000',
    $q$update ehr.documents set status = 'source_deleted' where id = 'c0116000-0000-4000-8000-000000000014'$q$, false);
  perform pg_temp.deletion_case('a claimed document is never restored', '55000',
    $q$update ehr.documents set status = 'uploaded' where id = 'c0116000-0000-4000-8000-000000000014'$q$, false);
  perform pg_temp.deletion_case('the owner, in a worker session, may make the exact purge step', 'ok',
    $q$update ehr.documents set status = 'source_deleted', original_file_name = 'Source page deleted after 7 days'
     where id = 'c0116000-0000-4000-8000-000000000014'$q$, false);
end $$;
select pg_temp.as_staff();
select pg_temp.deletion_case('a staff session may not claim a source', '55000',
  $q$update ehr.documents set status = 'source_deleting' where id = 'c0116000-0000-4000-8000-000000000003'$q$, false);
select pg_temp.deletion_case('an insert with status source_deleting is refused', '55000',
  $q$insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
       storage_bucket, storage_key, declared_media_type, status, retention_class)
     values ('c0116000-0000-4000-8000-0000000000ab', 'c0115000-0000-4000-8000-000000000001',
       'c0110000-0000-4000-8000-00000000000a', 'c0111000-0000-4000-8000-000000000001',
       'c0113000-0000-4000-8000-000000000001', 'Fictional Example scan.pdf', 'synthetic-bucket',
       'clinical/objects/c0116000-0000-4000-8000-0000000000ab', 'application/pdf', 'source_deleting',
       'clinical_record')$q$, false);
select pg_temp.deletion_case('an insert with status source_deleted is refused', '55000',
  $q$insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
       storage_bucket, storage_key, declared_media_type, status, retention_class)
     values ('c0116000-0000-4000-8000-0000000000aa', 'c0115000-0000-4000-8000-000000000001',
       'c0110000-0000-4000-8000-00000000000a', 'c0111000-0000-4000-8000-000000000001',
       'c0113000-0000-4000-8000-000000000001', 'Source page deleted after 7 days', 'synthetic-bucket',
       'clinical/objects/c0116000-0000-4000-8000-0000000000aa', 'application/pdf', 'source_deleted',
       'clinical_record')$q$, false);
do $$
begin
  if not current_setting('ocr_deletion.owner_sees')::boolean then return; end if;
  perform pg_temp.deletion_case('a deleted document is never changed again (staff)', '55000',
    $q$update ehr.documents set original_file_name = 'Fictional Example scan 01.pdf'
     where id = 'c0116000-0000-4000-8000-000000000001'$q$, false);
  perform pg_temp.deletion_case('a deleted document is never restored (staff)', '55000',
    $q$update ehr.documents set status = 'uploaded' where id = 'c0116000-0000-4000-8000-000000000001'$q$, false);
end $$;
-- The EHR API's runtime role cannot do it either (refused, or the row is not
-- visible to it and nothing changes).
set local role hid_ehr_api_runtime;
select pg_temp.as_staff();
create temporary table deletion_ehr_attempt (outcome text) on commit drop;
reset role;
grant insert, select on deletion_ehr_attempt to public;
set local role hid_ehr_api_runtime;
insert into deletion_ehr_attempt select pg_temp.deletion_try(
  $q$update ehr.documents set status = 'source_deleting' where id = 'c0116000-0000-4000-8000-000000000003'$q$, true);
reset role;
select pg_temp.deletion_check('the EHR API runtime role cannot delete a source',
  (select outcome in ('55000', '42501') or (outcome = 'ok'
     and (select status from ehr.documents where id = 'c0116000-0000-4000-8000-000000000003') = 'uploaded')
     from deletion_ehr_attempt));

-- Verdict.
do $$
declare failures text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, coalesce(actual, 'nothing')), E'\n' order by seq)
    into failures from deletion_cases where actual is distinct from expected;
  if failures is not null then
    raise exception E'OCR source deletion cases failed:\n%', failures;
  end if;
  raise notice 'ocr-source-deletion: % cases passed (owner sees documents: %)', (select count(*) from deletion_cases),
    current_setting('ocr_deletion.owner_sees');
end $$;

rollback;
