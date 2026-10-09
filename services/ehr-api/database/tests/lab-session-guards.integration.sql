\set ON_ERROR_STOP on
-- The Lab session guards fail closed (Phase 4 Stage 8, migration 0077). Rollback-only.
--
-- lab.validate_imported_evidence (0017), lab.validate_work_item (0018), lab.validate_accession_insert (0019),
-- lab.validate_execution_insert (0020) and lab.validate_result_governance (0021) compared the row's actor and
-- facility with platform.current_account_id(), current_membership_id() and current_facility_id() using <>. When a
-- session value was missing or did not resolve (no subject, an unknown subject, a disabled account, no membership,
-- no facility) the comparison was NULL and the guard let the row through. Forced row-level security refused those
-- rows for the Lab runtime, but a session that bypasses RLS could record Lab evidence, work, accessions, executions
-- and result governance attributed to any member. Since 0077 each guard refuses a missing session value with its
-- existing code and message and compares with IS DISTINCT FROM. Result governance keeps its split: the result
-- binding, including the session facility, raises 23514; the actor check raises 42501.
--
-- The OCR publication branch of validate_imported_evidence compared OCR rows that its owner reads under RLS. Under
-- an owner that does not bypass RLS (release checklist P8), another clinic's validation and publication read as
-- NULL and an import naming them was accepted. Since 0077 a missing job, extraction, validation or publication is
-- refused; an OCR job without a patient stays acceptable.
--
-- (A) Isolated cases run as the suite runner, a superuser (a session that bypasses RLS), with
-- session_replication_role = replica and only the seven guard triggers enabled (ENABLE ALWAYS): foreign keys and
-- the other triggers are skipped, and every parent row a guard reads exists, so a refusal can only come from the
-- guard. (B) Runtime-path cases run as hid_lab_api_runtime with every trigger, foreign key and RLS policy, the
-- session the Lab API sets and the Lab API's own INSERT statements; before 0077 RLS, not the guard, refused their
-- missing-session variants. Fixtures are inserted with session_replication_role = replica (CHECK constraints still
-- apply). Every case is undone. Each case is recorded, and the suite fails at the end listing every case whose
-- outcome differs from the expected one: 'ok', or the guard's SQLSTATE and message.
--
-- The rehearsal also runs this suite with a schema owner that is neither a superuser nor BYPASSRLS (release
-- checklist P8). That owner reads the fixtures only through RLS: under member A's session it sees them, without a
-- valid session it does not, and a guard then refuses for a missing parent row, possibly with another of its own
-- messages (a hidden result reads as an unbound result). The suite probes both; when the owner does not bypass RLS,
-- a refused case must be refused by its guard with one of the guard's messages, and an accepted case must still be
-- accepted.
begin;

-- Security properties that CREATE OR REPLACE must keep: SECURITY DEFINER, the exact search_path, volatility, and
-- the owner shared with lab.validate_work_item_child, which 0077 does not replace. The seven guard triggers must
-- exist, call their guard and be enabled.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: definer=%s config=%s volatility=%s owner=%s', p.oid::regprocedure,
           p.prosecdef, p.proconfig, p.provolatile, p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
    join (values ('lab.validate_imported_evidence()'::regprocedure,
                  '{"search_path=lab, ehr, ocr, identity, auth, platform, pg_temp"}'::text[]),
                 ('lab.validate_work_item()'::regprocedure,
                  '{"search_path=lab, ehr, identity, auth, platform, pg_temp"}'::text[]),
                 ('lab.validate_accession_insert()'::regprocedure, '{"search_path=lab, platform, pg_temp"}'::text[]),
                 ('lab.validate_execution_insert()'::regprocedure, '{"search_path=lab, platform, pg_temp"}'::text[]),
                 ('lab.validate_result_governance()'::regprocedure, '{"search_path=lab, platform, pg_temp"}'::text[]))
      expected(proc, config) on p.oid = expected.proc
   where not p.prosecdef or p.proconfig is distinct from expected.config or p.provolatile <> 'v'
      or p.proowner <> (select proowner from pg_proc where oid = 'lab.validate_work_item_child()'::regprocedure);
  if mismatch is not null then
    raise exception 'Lab guard security properties changed: %', mismatch;
  end if;
  if (select count(*) from pg_trigger
       where (tgrelid, tgname, tgfoid) in (
         ('lab.imported_evidence'::regclass, 'lab_imported_evidence_validate',
          'lab.validate_imported_evidence()'::regprocedure),
         ('lab.work_items'::regclass, 'lab_work_item_validate', 'lab.validate_work_item()'::regprocedure),
         ('lab.accessions'::regclass, 'lab_accession_validate', 'lab.validate_accession_insert()'::regprocedure),
         ('lab.test_executions'::regclass, 'lab_execution_insert_validate',
          'lab.validate_execution_insert()'::regprocedure),
         ('lab.result_verifications'::regclass, 'lab_verification_validate',
          'lab.validate_result_governance()'::regprocedure),
         ('lab.result_releases'::regclass, 'lab_release_validate', 'lab.validate_result_governance()'::regprocedure),
         ('lab.result_invalidations'::regclass, 'lab_invalidation_validate',
          'lab.validate_result_governance()'::regprocedure))
         and tgenabled = 'O' and not tgisinternal) <> 7 then
    raise exception 'the seven Lab guard triggers must stay enabled on their tables';
  end if;
end $$;

-- Clinics F1 (e8c00000-...02) and F2 (e8c00000-...03) of one organization. Members of F1: A (the acting member),
-- B (another member), E (entered the results and validated the OCR evidence), C (disabled until later) and D
-- (disabled); G is a member of F2. Patient P. A holds an active write consent for P in F1 for direct care, so RLS
-- lets A's session write P's Lab records in F1.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system)
values ('direct-care', 'Direct patient care', 'lab-guard-test') on conflict (code) do nothing;
insert into identity.organizations (id, name, slug) values
  ('e8c00000-0000-4000-8000-000000000001', 'Lab Guard Test Organization', 'lab-guard-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e8c00000-0000-4000-8000-000000000002', 'e8c00000-0000-4000-8000-000000000001', 'Lab Guard Clinic F1',
   'LAB-GUARD-F1', 'Africa/Lagos', true, 'verified'),
  ('e8c00000-0000-4000-8000-000000000003', 'e8c00000-0000-4000-8000-000000000001', 'Lab Guard Clinic F2',
   'LAB-GUARD-F2', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status, disabled_until, disabled_from_status)
select ('e8c10000-0000-4000-8000-00000000000' || m.n)::uuid, 'synthetic:lab-guard-' || lower(m.x),
       'lab-guard-' || lower(m.x) || '@example.invalid', 'Lab Guard ' || m.x, m.status, m.disabled_until,
       m.disabled_from_status
  from (values (1, 'A', 'active', null::timestamptz, null::text), (2, 'B', 'active', null, null),
               (3, 'E', 'active', null, null), (4, 'C', 'active', clock_timestamp() + interval '10 days', null),
               (5, 'D', 'disabled', null, 'active'), (6, 'G', 'active', null, null))
       m(n, x, status, disabled_until, disabled_from_status);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e8c20000-0000-4000-8000-00000000000' || m.n)::uuid, ('e8c10000-0000-4000-8000-00000000000' || m.n)::uuid,
       'Lab Guard ' || m.x, 'lab-guard-' || lower(m.x) || '@example.invalid', 'verified', 'lab'
  from (values (1, 'A'), (2, 'B'), (3, 'E'), (4, 'C'), (5, 'D'), (6, 'G')) m(n, x);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, active)
select ('e8c30000-0000-4000-8000-00000000000' || n)::uuid, ('e8c20000-0000-4000-8000-00000000000' || n)::uuid,
       ('e8c10000-0000-4000-8000-00000000000' || n)::uuid, 'e8c00000-0000-4000-8000-000000000001',
       (case when n = 6 then 'e8c00000-0000-4000-8000-000000000003'
             else 'e8c00000-0000-4000-8000-000000000002' end)::uuid, 'lab', 'lab', true
  from generate_series(1, 6) n;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e8c40000-0000-4000-8000-000000000001', 'HID-LABGRDSESS', 'Lab', 'Guard', 'Lab Guard Patient', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, break_glass, purpose_of_use) values
  ('e8c50000-0000-4000-8000-000000000001', 'e8c40000-0000-4000-8000-000000000001',
   'e8c20000-0000-4000-8000-000000000001', 'e8c10000-0000-4000-8000-000000000001',
   'e8c30000-0000-4000-8000-000000000001', 'e8c00000-0000-4000-8000-000000000002', 'write_records', 'active',
   'Synthetic Lab guard consent', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day',
   false, 'direct-care');
-- EHR sources: encounter N, document DOC1 in F1 and DOC2 in F2, and three active lab orders of A (LR1, LR2 are
-- already accepted as work items W1, W2; LR3 is not).
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at) values
  ('e8c60000-0000-4000-8000-000000000001', 'e8c40000-0000-4000-8000-000000000001',
   'e8c00000-0000-4000-8000-000000000002', 'e8c10000-0000-4000-8000-000000000001',
   'e8c30000-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status,
  retention_class)
select ('e8c70000-0000-4000-8000-00000000000' || n)::uuid, 'e8c40000-0000-4000-8000-000000000001',
       ('e8c00000-0000-4000-8000-00000000000' || (n + 1))::uuid,
       ('e8c10000-0000-4000-8000-00000000000' || case n when 1 then 1 else 6 end)::uuid,
       ('e8c30000-0000-4000-8000-00000000000' || case n when 1 then 1 else 6 end)::uuid,
       'lab-guard-' || n || '.pdf', 'synthetic-bucket', 'synthetic/lab-guard-' || n || '.pdf', 'lab-guard-v' || n,
       'application/pdf', 1024, repeat(n::text, 64), 'uploaded', 'clinical_record'
  from generate_series(1, 2) n;
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, clinical_information, created_at)
select ('e8c80000-0000-4000-8000-00000000000' || n)::uuid, 'e8c60000-0000-4000-8000-000000000001',
       'e8c40000-0000-4000-8000-000000000001', 'e8c00000-0000-4000-8000-000000000002',
       'e8c10000-0000-4000-8000-000000000001', 'e8c30000-0000-4000-8000-000000000001', 'http://loinc.org',
       '718-7', 'Haemoglobin', 'routine', 'active', 'Synthetic Lab guard order', '2026-10-01 09:00:00+00'
  from generate_series(1, 3) n;
-- Lab chain of F1, recorded by B: work items W1 and W2 with requested tests T1 and T2; accession AC1 of W1 with
-- specimens S1, S2 and S3, all received; completed executions X1 (S2) and X2 (S3) of T1; results R1 (X1) and R2
-- (X2), each at version 1 entered by E; R2 version 1 verified by B (V).
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, priority, test_code_system, test_code, test_name,
  clinical_indication, requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key,
  request_sha256, correlation_id)
select ('e8c90000-0000-4000-8000-00000000000' || n)::uuid, 'e8c40000-0000-4000-8000-000000000001',
       'e8c00000-0000-4000-8000-000000000002', 'e8c00000-0000-4000-8000-000000000002',
       ('e8c80000-0000-4000-8000-00000000000' || n)::uuid, 1, 'e8c60000-0000-4000-8000-000000000001', 'routine',
       'http://loinc.org', '718-7', 'Haemoglobin', 'Synthetic Lab guard order',
       'e8c10000-0000-4000-8000-000000000001', '2026-10-01 09:00:00+00', 'e8c10000-0000-4000-8000-000000000002',
       'e8c30000-0000-4000-8000-000000000002', 'lab-guard-fixture-work-' || n, repeat('a', 64), 'lab-guard-fixture'
  from generate_series(1, 2) n;
insert into lab.work_item_requested_tests (id, work_item_id, facility_id, patient_id, ordinal, code_system, code,
  name)
select ('e8c90000-0000-4000-8000-00000000001' || n)::uuid, ('e8c90000-0000-4000-8000-00000000000' || n)::uuid,
       'e8c00000-0000-4000-8000-000000000002', 'e8c40000-0000-4000-8000-000000000001', 1, 'http://loinc.org',
       '718-7', 'Haemoglobin'
  from generate_series(1, 2) n;
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id) values
  ('e8ca0000-0000-4000-8000-000000000001', 'e8c90000-0000-4000-8000-000000000001',
   'e8c40000-0000-4000-8000-000000000001', 'e8c00000-0000-4000-8000-000000000002', 'routine',
   'e8c10000-0000-4000-8000-000000000002', 'e8c30000-0000-4000-8000-000000000002', 'lab-guard-fixture-accession',
   repeat('a', 64), 'lab-guard-fixture');
insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
select ('e8ca0000-0000-4000-8000-00000000001' || n)::uuid, 'e8ca0000-0000-4000-8000-000000000001',
       'e8c40000-0000-4000-8000-000000000001', 'e8c00000-0000-4000-8000-000000000002', n, 'whole blood'
  from generate_series(1, 3) n;
insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
  collected_at, collected_by, collected_by_membership_id, received_at, received_by, received_by_membership_id,
  row_version)
select ('e8ca0000-0000-4000-8000-00000000002' || n)::uuid, ('e8ca0000-0000-4000-8000-00000000001' || n)::uuid,
       'e8ca0000-0000-4000-8000-000000000001', 'e8c40000-0000-4000-8000-000000000001',
       'e8c00000-0000-4000-8000-000000000002', 'whole blood', 'received', clock_timestamp(),
       'e8c10000-0000-4000-8000-000000000002', 'e8c30000-0000-4000-8000-000000000002', clock_timestamp(),
       'e8c10000-0000-4000-8000-000000000002', 'e8c30000-0000-4000-8000-000000000002', 3
  from generate_series(1, 3) n;
insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
  started_by, started_by_membership_id, started_at, completed_by, completed_by_membership_id, completed_at,
  idempotency_key, request_sha256, correlation_id, row_version)
select ('e8cb0000-0000-4000-8000-00000000000' || n)::uuid, 'e8ca0000-0000-4000-8000-000000000001',
       ('e8ca0000-0000-4000-8000-00000000002' || (n + 1))::uuid, 'e8c90000-0000-4000-8000-000000000011',
       'e8c40000-0000-4000-8000-000000000001', 'e8c00000-0000-4000-8000-000000000002', 'completed',
       'e8c10000-0000-4000-8000-000000000002', 'e8c30000-0000-4000-8000-000000000002', clock_timestamp(),
       'e8c10000-0000-4000-8000-000000000002', 'e8c30000-0000-4000-8000-000000000002', clock_timestamp(),
       'lab-guard-fixture-execution-' || n, repeat('a', 64), 'lab-guard-fixture', 2
  from generate_series(1, 2) n;
insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id)
select ('e8cb0000-0000-4000-8000-00000000001' || n)::uuid, ('e8cb0000-0000-4000-8000-00000000000' || n)::uuid,
       'e8c40000-0000-4000-8000-000000000001', 'e8c00000-0000-4000-8000-000000000002',
       'e8c10000-0000-4000-8000-000000000003', 'e8c30000-0000-4000-8000-000000000003'
  from generate_series(1, 2) n;
insert into lab.result_revisions (id, result_id, execution_id, patient_id, facility_id, version, result_type,
  numeric_value, unit, entered_by, entered_by_membership_id, idempotency_key, request_sha256, correlation_id,
  revision_kind)
select ('e8cb0000-0000-4000-8000-00000000002' || n)::uuid, ('e8cb0000-0000-4000-8000-00000000001' || n)::uuid,
       ('e8cb0000-0000-4000-8000-00000000000' || n)::uuid, 'e8c40000-0000-4000-8000-000000000001',
       'e8c00000-0000-4000-8000-000000000002', 1, 'numeric', 12.5, 'g/dL', 'e8c10000-0000-4000-8000-000000000003',
       'e8c30000-0000-4000-8000-000000000003', 'lab-guard-fixture-result-' || n, repeat('a', 64),
       'lab-guard-fixture', 'original'
  from generate_series(1, 2) n;
insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
  verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id) values
  ('e8cb0000-0000-4000-8000-000000000032', 'e8cb0000-0000-4000-8000-000000000012',
   'e8cb0000-0000-4000-8000-000000000002', 'e8c40000-0000-4000-8000-000000000001',
   'e8c00000-0000-4000-8000-000000000002', 1, 'e8c10000-0000-4000-8000-000000000002',
   'e8c30000-0000-4000-8000-000000000002', clock_timestamp(), 'Synthetic fixture verification',
   'lab-guard-fixture-verification', repeat('a', 64), 'lab-guard-fixture');
-- Governed OCR evidence for Lab, one chain per clinic: job J (J1 of DOC1 in F1 without a patient, J2 of DOC2 in F2),
-- extraction, validation (validated for LAB, by E in F1 and by G in F2), patient confirmation and a publication
-- being processed. Chain n uses e8cc0000-...0n (job), ...1n (extraction), ...2n (validation), ...3n
-- (confirmation) and ...4n (publication).
insert into ocr.jobs (id, facility_id, document_id, patient_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, max_attempts, created_by, created_by_membership_id, correlation_id,
  status, attempt_count, completed_at)
select ('e8cc0000-0000-4000-8000-00000000000' || n)::uuid, ('e8c00000-0000-4000-8000-00000000000' || (n + 1))::uuid,
       ('e8c70000-0000-4000-8000-00000000000' || n)::uuid,
       case when n = 2 then 'e8c40000-0000-4000-8000-000000000001'::uuid end, 'lab-guard-v' || n,
       repeat(n::text, 64), 'lab-guard-fixture-ocr-job-' || n, repeat('a', 64), 'synthetic-provider', 3,
       ('e8c10000-0000-4000-8000-00000000000' || case n when 1 then 3 else 6 end)::uuid,
       ('e8c30000-0000-4000-8000-00000000000' || case n when 1 then 3 else 6 end)::uuid, 'lab-guard-fixture',
       'validated', 1, clock_timestamp()
  from generate_series(1, 2) n;
insert into ocr.extractions (id, job_id, facility_id, document_id, extraction_version, attempt_no, provider,
  provider_model, provider_result_key, content_sha256, source_object_version_id, source_sha256_hex, provenance)
select ('e8cc0000-0000-4000-8000-00000000001' || n)::uuid, ('e8cc0000-0000-4000-8000-00000000000' || n)::uuid,
       ('e8c00000-0000-4000-8000-00000000000' || (n + 1))::uuid, ('e8c70000-0000-4000-8000-00000000000' || n)::uuid,
       1, 1, 'synthetic-provider', 'synthetic-model', 'lab-guard-result-' || n, repeat('c', 64), 'lab-guard-v' || n,
       repeat(n::text, 64), '{}'::jsonb
  from generate_series(1, 2) n;
insert into ocr.validations (id, job_id, facility_id, extraction_id, validation_version, validated_payload, reason,
  validated_by, validated_by_membership_id, disposition, target_domain, candidate_type)
select ('e8cc0000-0000-4000-8000-00000000002' || n)::uuid, ('e8cc0000-0000-4000-8000-00000000000' || n)::uuid,
       ('e8c00000-0000-4000-8000-00000000000' || (n + 1))::uuid, ('e8cc0000-0000-4000-8000-00000000001' || n)::uuid,
       1, '{}'::jsonb, 'Synthetic reviewer validated the Lab report',
       ('e8c10000-0000-4000-8000-00000000000' || case n when 1 then 3 else 6 end)::uuid,
       ('e8c30000-0000-4000-8000-00000000000' || case n when 1 then 3 else 6 end)::uuid, 'validated', 'LAB',
       'lab_document'
  from generate_series(1, 2) n;
insert into ocr.patient_confirmations (id, job_id, facility_id, patient_id, confirmation_version, method, reason,
  confirmed_by, confirmed_by_membership_id, idempotency_key, request_sha256)
select ('e8cc0000-0000-4000-8000-00000000003' || n)::uuid, ('e8cc0000-0000-4000-8000-00000000000' || n)::uuid,
       ('e8c00000-0000-4000-8000-00000000000' || (n + 1))::uuid, 'e8c40000-0000-4000-8000-000000000001', 1,
       'source_document', 'Confirmed against the governed source document',
       ('e8c10000-0000-4000-8000-00000000000' || case n when 1 then 3 else 6 end)::uuid,
       ('e8c30000-0000-4000-8000-00000000000' || case n when 1 then 3 else 6 end)::uuid,
       'lab-guard-fixture-confirmation-' || n, repeat('a', 64)
  from generate_series(1, 2) n;
insert into ocr.publications (id, job_id, validation_id, validation_version, patient_confirmation_id, facility_id,
  patient_id, target_domain, target_operation, idempotency_key, request_sha256, requested_by,
  requested_by_membership_id, correlation_id, status, processing_token, processing_expires_at, attempt_count)
select ('e8cc0000-0000-4000-8000-00000000004' || n)::uuid, ('e8cc0000-0000-4000-8000-00000000000' || n)::uuid,
       ('e8cc0000-0000-4000-8000-00000000002' || n)::uuid, 1, ('e8cc0000-0000-4000-8000-00000000003' || n)::uuid,
       ('e8c00000-0000-4000-8000-00000000000' || (n + 1))::uuid, 'e8c40000-0000-4000-8000-000000000001', 'LAB',
       'create_imported_lab_evidence', 'lab-guard-fixture-publication-' || n, repeat('a', 64),
       ('e8c10000-0000-4000-8000-00000000000' || case n when 1 then 3 else 6 end)::uuid,
       ('e8c30000-0000-4000-8000-00000000000' || case n when 1 then 3 else 6 end)::uuid, 'lab-guard-fixture',
       'processing', gen_random_uuid(), clock_timestamp() + interval '1 hour', 1
  from generate_series(1, 2) n;

-- The session, exactly as services/lab-api/src/database/database.service.ts:48-62 sets it (actor_subject,
-- facility_id, correlation_id, membership_id, purpose_of_use), for each named session of the suite. 'none' sets
-- every value to '', which every platform.current_* function reads as missing, as if it had never been set.
create function pg_temp.lab_session(session_name text) returns void language plpgsql as $$
declare
  context record;
begin
  select * into strict context
    from (values
      ('none', '', '', '', '', ''),
      ('A', 'synthetic:lab-guard-a', 'e8c00000-0000-4000-8000-000000000002', 'lab-guard-suite',
       'e8c30000-0000-4000-8000-000000000001', 'direct-care'),
      ('A without membership', 'synthetic:lab-guard-a', 'e8c00000-0000-4000-8000-000000000002', 'lab-guard-suite',
       '', 'direct-care'),
      ('A without facility', 'synthetic:lab-guard-a', '', 'lab-guard-suite',
       'e8c30000-0000-4000-8000-000000000001', 'direct-care'),
      ('unknown subject with B''s membership', 'synthetic:lab-guard-unknown', 'e8c00000-0000-4000-8000-000000000002',
       'lab-guard-suite', 'e8c30000-0000-4000-8000-000000000002', 'direct-care'),
      ('C', 'synthetic:lab-guard-c', 'e8c00000-0000-4000-8000-000000000002', 'lab-guard-suite',
       'e8c30000-0000-4000-8000-000000000004', 'direct-care'),
      ('D', 'synthetic:lab-guard-d', 'e8c00000-0000-4000-8000-000000000002', 'lab-guard-suite',
       'e8c30000-0000-4000-8000-000000000005', 'direct-care'))
      sessions(name, subject, facility, correlation, membership, purpose)
   where sessions.name = session_name;
  perform set_config('app.actor_subject', context.subject, true),
          set_config('app.facility_id', context.facility, true),
          set_config('app.correlation_id', context.correlation, true),
          set_config('app.membership_id', context.membership, true),
          set_config('app.purpose_of_use', context.purpose, true);
end $$;

-- The account and membership of a member named by a row.
create function pg_temp.lab_member(member text, out account uuid, out membership uuid) language sql as $$
  select ('e8c10000-0000-4000-8000-00000000000' || n)::uuid, ('e8c30000-0000-4000-8000-00000000000' || n)::uuid
    from (values ('A', 1), ('B', 2), ('E', 3), ('C', 4), ('D', 5), ('G', 6)) members(name, n)
   where members.name = member
$$;

-- The guarded inserts of the Lab API, with the row naming a member, on patient P in clinic F1.
-- services/lab-api/src/lab/lab-imports.service.ts:79-90 (create): an external import, or with OCR evidence the
-- import of an OCR publication (createFromOcr, keyed by the publication); the reviewer is the account itself for
-- an external import and the OCR validator otherwise.
create function pg_temp.import_insert(member text, ocr_job uuid default null, extraction uuid default null,
  validation uuid default null, publication uuid default null, reviewer text default null) returns text
language sql as $$
  select format($i$insert into lab.imported_evidence (id,patient_id,facility_id,external_lab_name,external_reference,
          collected_at,reported_at,source_document_id,ocr_job_id,extraction_id,validation_id,
          validation_version,publication_id,reviewed_by,created_by,created_by_membership_id,
          idempotency_key,request_sha256,correlation_id)
         values (gen_random_uuid(),'e8c40000-0000-4000-8000-000000000001','e8c00000-0000-4000-8000-000000000002',
          %L,null,null,null,'e8c70000-0000-4000-8000-000000000001',%L,%L,%L,%L,%L,%L,%L,%L,%L,repeat('b',64),
          'lab-guard-suite')
         returning *$i$,
    case when publication is null then 'Synthetic external laboratory' end, ocr_job, extraction, validation,
    case when validation is not null then 1 end, publication,
    coalesce((select account from pg_temp.lab_member(reviewer)), actor.account), actor.account, actor.membership,
    coalesce('ocr-publication:' || publication, 'lab-guard-suite-import'))
  from pg_temp.lab_member(member) actor
$$;
-- services/lab-api/src/lab/lab-work-items.service.ts:201-212 (acceptEhrOrder) for order LR3.
create function pg_temp.work_item_insert(member text) returns text language sql as $$
  select format($i$insert into lab.work_items(id,patient_id,facility_id,ordering_facility_id,source_ehr_order_id,
          source_ehr_order_version,source_encounter_id,status,priority,test_code_system,test_code,
          test_name,clinical_indication,requested_by,requested_at,accepted_by,
          accepted_by_membership_id,idempotency_key,request_sha256,correlation_id)
         values (gen_random_uuid(),'e8c40000-0000-4000-8000-000000000001','e8c00000-0000-4000-8000-000000000002',
          'e8c00000-0000-4000-8000-000000000002','e8c80000-0000-4000-8000-000000000003',1,
          'e8c60000-0000-4000-8000-000000000001','accepted','routine','http://loinc.org','718-7','Haemoglobin',
          'Synthetic Lab guard order','e8c10000-0000-4000-8000-000000000001','2026-10-01 09:00:00+00',%L,%L,
          'ehr-lab-order:e8c80000-0000-4000-8000-000000000003:v1',repeat('b',64),'lab-guard-suite')
         returning *$i$, actor.account, actor.membership)
  from pg_temp.lab_member(member) actor
$$;
-- services/lab-api/src/lab/lab-accessions.service.ts:48-51 (create) for work item W2.
create function pg_temp.accession_insert(member text) returns text language sql as $$
  select format($i$insert into lab.accessions(work_item_id,patient_id,facility_id,
        priority,created_by,created_by_membership_id,idempotency_key,request_sha256,correlation_id)
        values('e8c90000-0000-4000-8000-000000000002','e8c40000-0000-4000-8000-000000000001',
          'e8c00000-0000-4000-8000-000000000002','routine',%L,%L,'lab-guard-suite-accession',repeat('b',64),
          'lab-guard-suite') returning id::text,accession_number,work_item_id::text,patient_id::text,
          facility_id::text,status,priority,row_version::text,created_at,request_sha256$i$,
    actor.account, actor.membership)
  from pg_temp.lab_member(member) actor
$$;
-- services/lab-api/src/lab/lab-executions.service.ts:45-51 (start) for specimen S1 of accession AC1, test T1.
create function pg_temp.execution_insert(member text) returns text language sql as $$
  select format($i$insert into lab.test_executions(accession_id,specimen_id,requested_test_id,patient_id,facility_id,
    method,started_by,started_by_membership_id,started_at,idempotency_key,request_sha256,correlation_id)
    values('e8ca0000-0000-4000-8000-000000000001','e8ca0000-0000-4000-8000-000000000021',
      'e8c90000-0000-4000-8000-000000000011','e8c40000-0000-4000-8000-000000000001',
      'e8c00000-0000-4000-8000-000000000002',null,%L,%L,clock_timestamp(),'lab-guard-suite-execution',
      repeat('b',64),'lab-guard-suite') returning id::text,accession_id::text,specimen_id::text,
    requested_test_id::text,patient_id::text,facility_id::text,status,method,started_at,completed_at,
    row_version::text,idempotency_key,request_sha256,completed_idempotency_key,completed_request_sha256,
    '' as test_name,'' as test_code,'' as test_code_system$i$, actor.account, actor.membership)
  from pg_temp.lab_member(member) actor
$$;
-- services/lab-api/src/lab/lab-executions.service.ts:126 (govern, verify) for result R1 version 1.
create function pg_temp.verification_insert(member text) returns text language sql as $$
  select format($i$insert into lab.result_verifications(result_id,execution_id,patient_id,facility_id,result_version,
    verified_by,verified_by_membership_id,verified_at,reason,idempotency_key,request_sha256,correlation_id)
    values('e8cb0000-0000-4000-8000-000000000011','e8cb0000-0000-4000-8000-000000000001',
      'e8c40000-0000-4000-8000-000000000001','e8c00000-0000-4000-8000-000000000002',1,%L,%L,clock_timestamp(),
      'Synthetic verification','lab-guard-suite-verification',repeat('b',64),'lab-guard-suite')$i$,
    actor.account, actor.membership)
  from pg_temp.lab_member(member) actor
$$;
-- services/lab-api/src/lab/lab-executions.service.ts:127 (govern, release) of verification V of R2 version 1.
create function pg_temp.release_insert(member text) returns text language sql as $$
  select format($i$insert into lab.result_releases(verification_id,result_id,execution_id,patient_id,facility_id,
    result_version,released_by,released_by_membership_id,released_at,reason,idempotency_key,request_sha256,
    correlation_id)
    values('e8cb0000-0000-4000-8000-000000000032','e8cb0000-0000-4000-8000-000000000012',
      'e8cb0000-0000-4000-8000-000000000002','e8c40000-0000-4000-8000-000000000001',
      'e8c00000-0000-4000-8000-000000000002',1,%L,%L,clock_timestamp(),'Synthetic release',
      'lab-guard-suite-release',repeat('b',64),'lab-guard-suite')$i$, actor.account, actor.membership)
  from pg_temp.lab_member(member) actor
$$;
-- No service writes lab.result_invalidations; this insert follows its columns (0021) for result R1 version 1.
create function pg_temp.invalidation_insert(member text) returns text language sql as $$
  select format($i$insert into lab.result_invalidations(result_id,execution_id,patient_id,facility_id,
    result_version,disposition,actor_id,actor_membership_id,reason,idempotency_key,request_sha256,correlation_id)
    values('e8cb0000-0000-4000-8000-000000000011','e8cb0000-0000-4000-8000-000000000001',
      'e8c40000-0000-4000-8000-000000000001','e8c00000-0000-4000-8000-000000000002',1,'entered_in_error',%L,%L,
      'Synthetic entered in error','lab-guard-suite-invalidation',repeat('b',64),'lab-guard-suite')$i$,
    actor.account, actor.membership)
  from pg_temp.lab_member(member) actor
$$;
create function pg_temp.guarded_insert(area text, member text) returns text language sql as $$
  select case area
    when 'import' then pg_temp.import_insert(member)
    when 'work item' then pg_temp.work_item_insert(member)
    when 'accession' then pg_temp.accession_insert(member)
    when 'execution' then pg_temp.execution_insert(member)
    when 'verification' then pg_temp.verification_insert(member)
    when 'release' then pg_temp.release_insert(member)
    when 'invalidation' then pg_temp.invalidation_insert(member)
  end
$$;

-- Each guarded table and the guard's refusals: for a missing session facility (context), for a missing or other
-- account or membership (actor) and, for imports, for OCR evidence that is not exactly governed.
create temporary table lab_guard_areas (
  area text primary key, context_refusal text not null, actor_refusal text not null, evidence_refusal text
) on commit drop;
insert into lab_guard_areas values
  ('import', '23514: Lab import source, patient, facility, or actor context is invalid',
   '23514: Lab import source, patient, facility, or actor context is invalid',
   '23514: Lab import is not bound to exact governed OCR publication evidence'),
  ('work item', '23514: Lab work item does not match the exact active EHR order version and actor context',
   '23514: Lab work item does not match the exact active EHR order version and actor context', null),
  ('accession', '23514: Accession does not match accepted Lab work and actor context',
   '23514: Accession does not match accepted Lab work and actor context', null),
  ('execution', '23514: Execution must match a received specimen and exact requested test',
   '23514: Execution must match a received specimen and exact requested test', null),
  ('verification', '23514: Governance command must bind the exact current result version',
   '42501: Verifier must match authenticated database context', null),
  ('release', '23514: Governance command must bind the exact current result version',
   '42501: Release actor must match authenticated database context', null),
  ('invalidation', '23514: Governance command must bind the exact current result version',
   '42501: Invalidation actor must match authenticated database context', null);
create temporary table lab_guard_cases (
  seq serial, path text not null, area text not null references lab_guard_areas, name text not null,
  expected text not null, actual text, primary key (path, area, name)
) on commit drop;
-- The runtime-path cases run as the Lab API runtime and record their own outcome.
grant select on lab_guard_areas to public;
grant select, insert on lab_guard_cases to public;
grant usage on sequence lab_guard_cases_seq_seq to public;

-- Runs a statement as the current role and undoes it: 'ok', or its SQLSTATE and message.
create function pg_temp.lab_try(statement text) returns text language plpgsql as $$
declare outcome text;
begin
  begin
    execute statement;
    outcome := 'ok';
    raise exception using errcode = 'P0001', message = 'lab-guard-suite: undo';
  exception when others then
    if sqlerrm <> 'lab-guard-suite: undo' then outcome := sqlstate || ': ' || sqlerrm; end if;
  end;
  return outcome;
end $$;
create function pg_temp.lab_case(path text, area text, case_name text, expected text, session_name text,
  statement text)
returns void language plpgsql as $$
begin
  perform pg_temp.lab_session(session_name);
  insert into lab_guard_cases (path, area, name, expected, actual)
  values (path, area, case_name, expected, pg_temp.lab_try(statement));
end $$;
-- The OCR publication branch of the import guard, under member A's session: (i) the governed chain of clinic F1,
-- whose job has no patient; (ii) F1's job and extraction with clinic F2's validation and publication, which an
-- owner that does not bypass RLS cannot see; (iii) an extraction that does not exist.
create function pg_temp.ocr_cases(path text) returns void language plpgsql as $$
declare
  refusal text := (select evidence_refusal from lab_guard_areas where area = 'import');
begin
  perform pg_temp.lab_case(path, 'import', 'OCR: the governed F1 chain, its job without a patient', 'ok', 'A',
    pg_temp.import_insert('A', 'e8cc0000-0000-4000-8000-000000000001', 'e8cc0000-0000-4000-8000-000000000011',
      'e8cc0000-0000-4000-8000-000000000021', 'e8cc0000-0000-4000-8000-000000000041', 'E'));
  perform pg_temp.lab_case(path, 'import', 'OCR: F1''s job naming F2''s validation and publication', refusal, 'A',
    pg_temp.import_insert('A', 'e8cc0000-0000-4000-8000-000000000001', 'e8cc0000-0000-4000-8000-000000000011',
      'e8cc0000-0000-4000-8000-000000000022', 'e8cc0000-0000-4000-8000-000000000042', 'G'));
  perform pg_temp.lab_case(path, 'import', 'OCR: an extraction that does not exist', refusal, 'A',
    pg_temp.import_insert('A', 'e8cc0000-0000-4000-8000-000000000001', 'e8cc0000-0000-4000-8000-0000000000ff',
      'e8cc0000-0000-4000-8000-000000000021', 'e8cc0000-0000-4000-8000-000000000041', 'E'));
end $$;

-- (C) What the guards' owner can see of the parent rows the guards read: under member A's session, and without a
-- session. A superuser owner sees them either way. An owner that does not bypass RLS (P8) sees them only under
-- A's session, through A's consent and clinic; the accepted cases need that.
create function pg_temp.parents_visible() returns boolean language sql as $$
  select exists (select 1 from ehr.documents where id = 'e8c70000-0000-4000-8000-000000000001')
     and exists (select 1 from ehr.lab_requests where id = 'e8c80000-0000-4000-8000-000000000003')
     and exists (select 1 from lab.work_items where id = 'e8c90000-0000-4000-8000-000000000002')
     and exists (select 1 from lab.work_item_requested_tests where id = 'e8c90000-0000-4000-8000-000000000011')
     and exists (select 1 from lab.accessions where id = 'e8ca0000-0000-4000-8000-000000000001')
     and exists (select 1 from lab.specimens where id = 'e8ca0000-0000-4000-8000-000000000021')
     and (select count(*) from lab.results where id in ('e8cb0000-0000-4000-8000-000000000011',
           'e8cb0000-0000-4000-8000-000000000012')) = 2
     and (select count(*) from lab.result_revisions where id in ('e8cb0000-0000-4000-8000-000000000021',
           'e8cb0000-0000-4000-8000-000000000022')) = 2
     and exists (select 1 from lab.result_verifications where id = 'e8cb0000-0000-4000-8000-000000000032')
     and exists (select 1 from ocr.jobs where id = 'e8cc0000-0000-4000-8000-000000000001')
     and exists (select 1 from ocr.extractions where id = 'e8cc0000-0000-4000-8000-000000000011')
     and exists (select 1 from ocr.validations where id = 'e8cc0000-0000-4000-8000-000000000021')
     and exists (select 1 from ocr.publications where id = 'e8cc0000-0000-4000-8000-000000000041')
$$;
do $$
declare
  owner_role name := (select proowner::regrole::name from pg_proc
                       where oid = 'lab.validate_imported_evidence()'::regprocedure);
  visible boolean;
begin
  perform pg_temp.lab_session('A');
  execute format('set local role %I', owner_role);
  visible := pg_temp.parents_visible();
  reset role;
  perform set_config('lab_guard.owner_sees', visible::text, true);
  perform pg_temp.lab_session('none');
  execute format('set local role %I', owner_role);
  visible := pg_temp.parents_visible();
  reset role;
  perform set_config('lab_guard.owner_sees_without_session', visible::text, true);
end $$;

-- (A) Isolated guards, as the superuser suite runner. Each row names a member; the session is one of the named
-- sessions. 'context' cases miss the session facility, 'actor' cases an account or membership, or name another
-- member than the session's.
alter table lab.imported_evidence enable always trigger lab_imported_evidence_validate;
alter table lab.work_items enable always trigger lab_work_item_validate;
alter table lab.accessions enable always trigger lab_accession_validate;
alter table lab.test_executions enable always trigger lab_execution_insert_validate;
alter table lab.result_verifications enable always trigger lab_verification_validate;
alter table lab.result_releases enable always trigger lab_release_validate;
alter table lab.result_invalidations enable always trigger lab_invalidation_validate;
select pg_temp.lab_case('isolated', a.area, c.name,
         case c.outcome when 'ok' then 'ok' when 'context' then a.context_refusal else a.actor_refusal end,
         c.session, pg_temp.guarded_insert(a.area, c.member))
  from lab_guard_areas a
 cross join (values
   ('no request context at all, naming member B', 'none', 'B', 'context'),
   ('member A''s session without a membership, naming A', 'A without membership', 'A', 'actor'),
   ('an unknown subject with B''s membership, naming B', 'unknown subject with B''s membership', 'B', 'actor'),
   ('disabled account D, naming itself', 'D', 'D', 'actor'),
   ('account C disabled until later, naming itself', 'C', 'C', 'actor'),
   ('member A''s session without a facility, naming A', 'A without facility', 'A', 'context'),
   ('member A naming member B', 'A', 'B', 'actor'),
   ('member A naming itself', 'A', 'A', 'ok')) c(name, session, member, outcome);
select pg_temp.ocr_cases('isolated');
alter table lab.imported_evidence enable trigger lab_imported_evidence_validate;
alter table lab.work_items enable trigger lab_work_item_validate;
alter table lab.accessions enable trigger lab_accession_validate;
alter table lab.test_executions enable trigger lab_execution_insert_validate;
alter table lab.result_verifications enable trigger lab_verification_validate;
alter table lab.result_releases enable trigger lab_release_validate;
alter table lab.result_invalidations enable trigger lab_invalidation_validate;

-- (B) Runtime path: every trigger, foreign key and RLS policy, as hid_lab_api_runtime with the Lab API's session
-- and INSERT statements. The API binds the session's own account and membership into every row, so the
-- missing-session variants here are accounts that do not resolve: an unknown subject, a disabled account, an
-- account disabled until later. An empty membership or facility cannot reach a guard through the API: the same ''
-- is bound into a uuid column and fails with 22P02 first (request-context.ts:67 falls back to ''). No service
-- writes lab.result_invalidations. The API's replay reads with SELECT ... FOR UPDATE (lab-imports.service.ts:65-72,
-- lab-work-items.service.ts:189-195, lab-accessions.service.ts:41-43) are not run: the runtime role has no UPDATE
-- privilege on those tables and they fail with 42501, a separate release blocker outside this stage.
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.lab_case('runtime', a.area, c.name,
         case c.outcome when 'ok' then 'ok' else a.actor_refusal end,
         c.session, pg_temp.guarded_insert(a.area, c.member))
  from lab_guard_areas a
 cross join (values
   ('member A naming itself', 'A', 'A', 'ok'),
   ('an unknown subject with B''s membership, naming B', 'unknown subject with B''s membership', 'B', 'actor'),
   ('disabled account D, naming itself', 'D', 'D', 'actor'),
   ('account C disabled until later, naming itself', 'C', 'C', 'actor')) c(name, session, member, outcome)
 where a.area <> 'invalidation';
select pg_temp.ocr_cases('runtime');
reset role;

-- Every case ran, and every outcome is the expected one. Accepted cases must be accepted in every mode. When the
-- owner does not bypass RLS, a refused case must be refused by its own guard, with any of the guard's messages.
do $$
declare
  owner_sees boolean := current_setting('lab_guard.owner_sees')::boolean;
  owner_sees_without_session boolean := current_setting('lab_guard.owner_sees_without_session')::boolean;
  mismatches text;
begin
  if (select count(*) from lab_guard_cases) <> 86 or exists (select 1 from lab_guard_cases where actual is null) then
    raise exception 'the Lab session guard suite did not run every case';
  end if;
  select string_agg(format('%s / %s / %s: expected %s, got %s', c.path, c.area, c.name, c.expected, c.actual),
           E'\n' order by c.seq)
    into mismatches
    from lab_guard_cases c
    join lab_guard_areas a on a.area = c.area
   where case when c.expected = 'ok' or owner_sees_without_session then c.actual <> c.expected
              else c.actual not in (a.context_refusal, a.actor_refusal, coalesce(a.evidence_refusal, a.actor_refusal))
         end;
  if mismatches is not null then
    raise exception E'Lab session guard cases failed (owner sees fixtures with A''s session: %, without: %):\n%',
      owner_sees, owner_sees_without_session, mismatches;
  end if;
  raise notice 'Lab session guard suite: % cases passed (owner sees fixtures with A''s session: %, without: %)',
    (select count(*) from lab_guard_cases), owner_sees, owner_sees_without_session;
end $$;

rollback;
