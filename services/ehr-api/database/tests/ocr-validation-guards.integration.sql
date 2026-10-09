\set ON_ERROR_STOP on
-- The OCR patient-confirmation and validation guards fail closed (0076).
-- Rollback-only.
--
-- Fixtures and the guarded inserts run with session_replication_role =
-- replica, which skips every trigger and foreign-key check, and the two
-- guards under test are enabled with ENABLE ALWAYS TRIGGER, so only they run.
-- That isolates each guard: a missing source document or extraction would
-- otherwise be refused first by a foreign key, and the job fixtures would be
-- refused by the job trigger, which needs clean scanned document evidence
-- (schema.integration.sql covers the full trigger stack). Each insert is
-- attempted and undone, so the cases do not affect each other. Every case is
-- recorded, and the suite fails at the end listing each case whose outcome
-- differs from the expected one.
begin;

-- Security properties that CREATE OR REPLACE must not change: SECURITY
-- DEFINER, the exact search_path, volatility, and the owner shared with the
-- sibling OCR guard that 0076 does not replace.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: definer=%s config=%s volatility=%s owner=%s', p.oid::regprocedure,
           p.prosecdef, p.proconfig, p.provolatile, p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
    join (values ('ocr.validate_patient_confirmation()'::regprocedure, '{"search_path=ocr, ehr, pg_temp"}'::text[]),
                 ('ocr.validate_validation_insert()'::regprocedure, '{"search_path=ocr, platform, pg_temp"}'::text[]))
      expected(proc, config) on p.oid = expected.proc
   where not p.prosecdef or p.proconfig is distinct from expected.config or p.provolatile <> 'v'
      or p.proowner <> (select proowner from pg_proc where oid = 'ocr.validate_extraction_insert()'::regprocedure);
  if mismatch is not null then
    raise exception 'OCR guard security properties changed: %', mismatch;
  end if;
  if (select count(*) from pg_trigger
       where (tgrelid, tgname, tgfoid) in (
         ('ocr.patient_confirmations'::regclass, 'ocr_patient_confirmations_validate',
          'ocr.validate_patient_confirmation()'::regprocedure),
         ('ocr.validations'::regclass, 'ocr_validations_validate', 'ocr.validate_validation_insert()'::regprocedure))
         and tgenabled = 'O' and not tgisinternal) <> 2 then
    raise exception 'the OCR guard triggers must stay enabled on their tables';
  end if;
end $$;

-- A reviewer account, so platform.current_account_id() resolves its subject.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('fb300000-0000-4000-8000-000000000001', 'synthetic:ocr-guard-reviewer', 'ocr-guard-reviewer@example.invalid',
   'OCR Guard Reviewer', 'active'),
  ('fb300000-0000-4000-8000-000000000002', 'synthetic:ocr-guard-other', 'ocr-guard-other@example.invalid',
   'OCR Guard Other Reviewer', 'active');

set local session_replication_role = replica;
alter table ocr.patient_confirmations enable always trigger ocr_patient_confirmations_validate;
alter table ocr.validations enable always trigger ocr_validations_validate;

-- One source document of patient P1 (fb500000-...01) in facility A
-- (fb000000-...02). Job J1 awaits validation for it; job J2 names a document
-- that does not exist; job J3 is another job of the same document; job J4 is
-- still queued; job J5 awaits validation but was created for patient P2.
-- Extractions E1, E3 and E4 belong to J1, J3 and J4.
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, declared_media_type, retention_class) values
  ('fb200000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001',
   'fb000000-0000-4000-8000-000000000002', 'fb300000-0000-4000-8000-000000000001',
   'fb400000-0000-4000-8000-000000000001', 'ocr-guard-source.pdf', 'synthetic-bucket',
   'synthetic/ocr-guard-source.pdf', 'application/pdf', 'clinical_record');
insert into ocr.jobs (id, facility_id, document_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, created_by, created_by_membership_id, correlation_id, status) values
  ('fb100000-0000-4000-8000-000000000001', 'fb000000-0000-4000-8000-000000000002',
   'fb200000-0000-4000-8000-000000000001', 'synthetic-version-1', repeat('a', 64), 'ocr-guard-fixture-0001',
   repeat('b', 64), 'test', 'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001',
   'ocr-guard-fixture', 'awaiting_validation'),
  ('fb100000-0000-4000-8000-000000000002', 'fb000000-0000-4000-8000-000000000002',
   'fb200000-0000-4000-8000-0000000000ff', 'synthetic-version-1', repeat('a', 64), 'ocr-guard-fixture-0002',
   repeat('b', 64), 'test', 'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001',
   'ocr-guard-fixture', 'awaiting_validation'),
  ('fb100000-0000-4000-8000-000000000003', 'fb000000-0000-4000-8000-000000000002',
   'fb200000-0000-4000-8000-000000000001', 'synthetic-version-1', repeat('a', 64), 'ocr-guard-fixture-0003',
   repeat('b', 64), 'test', 'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001',
   'ocr-guard-fixture', 'awaiting_validation'),
  ('fb100000-0000-4000-8000-000000000004', 'fb000000-0000-4000-8000-000000000002',
   'fb200000-0000-4000-8000-000000000001', 'synthetic-version-1', repeat('a', 64), 'ocr-guard-fixture-0004',
   repeat('b', 64), 'test', 'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001',
   'ocr-guard-fixture', 'queued');
insert into ocr.jobs (id, facility_id, document_id, patient_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, created_by, created_by_membership_id, correlation_id, status) values
  ('fb100000-0000-4000-8000-000000000005', 'fb000000-0000-4000-8000-000000000002',
   'fb200000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000002', 'synthetic-version-1',
   repeat('a', 64), 'ocr-guard-fixture-0005', repeat('b', 64), 'test', 'fb300000-0000-4000-8000-000000000001',
   'fb400000-0000-4000-8000-000000000001', 'ocr-guard-fixture', 'awaiting_validation');
insert into ocr.extractions (id, job_id, facility_id, document_id, extraction_version, attempt_no, provider,
  provider_model, provider_result_key, content_sha256, source_object_version_id, source_sha256_hex, provenance) values
  ('fb600000-0000-4000-8000-000000000001', 'fb100000-0000-4000-8000-000000000001',
   'fb000000-0000-4000-8000-000000000002', 'fb200000-0000-4000-8000-000000000001', 1, 1, 'test', 'test-model',
   'ocr-guard-result-1', repeat('c', 64), 'synthetic-version-1', repeat('a', 64), '{}'::jsonb),
  ('fb600000-0000-4000-8000-000000000003', 'fb100000-0000-4000-8000-000000000003',
   'fb000000-0000-4000-8000-000000000002', 'fb200000-0000-4000-8000-000000000001', 1, 1, 'test', 'test-model',
   'ocr-guard-result-3', repeat('d', 64), 'synthetic-version-1', repeat('a', 64), '{}'::jsonb),
  ('fb600000-0000-4000-8000-000000000004', 'fb100000-0000-4000-8000-000000000004',
   'fb000000-0000-4000-8000-000000000002', 'fb200000-0000-4000-8000-000000000001', 1, 1, 'test', 'test-model',
   'ocr-guard-result-4', repeat('f', 64), 'synthetic-version-1', repeat('a', 64), '{}'::jsonb);

-- The reviewing session, as the OCR API sets it.
select set_config('app.facility_id', 'fb000000-0000-4000-8000-000000000002', true),
       set_config('app.actor_subject', 'synthetic:ocr-guard-reviewer', true),
       set_config('app.membership_id', 'fb400000-0000-4000-8000-000000000001', true),
       set_config('app.purpose_of_use', 'healthcare-operations', true),
       set_config('app.correlation_id', 'ocr-guard-suite', true);

-- Runs one insert and undoes it. 'accepted', or 'refused' for SQLSTATE 23514
-- with the guard's message; any other error stops the suite.
create function pg_temp.attempt(statement text, refusal text) returns text language plpgsql as $$
begin
  begin
    execute statement;
    raise exception using errcode = 'P0001', message = 'ocr-guard-suite: accepted';
  exception
    when check_violation then
      if sqlerrm <> refusal then raise; end if;
      return 'refused';
    when raise_exception then
      if sqlerrm <> 'ocr-guard-suite: accepted' then raise; end if;
      return 'accepted';
  end;
end $$;
create temporary table ocr_guard_cases (
  name text primary key, expected text not null check (expected in ('accepted', 'refused')), actual text
) on commit drop;

-- What the confirmation guard's owner can see of the source document. The
-- rehearsal also runs this suite with a schema owner that is neither a
-- superuser nor BYPASSRLS (release checklist P8); row-level security then hides
-- the document from the guard, and the guard must refuse every confirmation
-- rather than accept one for any patient.
do $$
declare
  owner_role name := (select proowner::regrole::name from pg_proc
                       where oid = 'ocr.validate_patient_confirmation()'::regprocedure);
  visible boolean;
begin
  execute format('set local role %I', owner_role);
  select exists (select 1 from ehr.documents where id = 'fb200000-0000-4000-8000-000000000001') into visible;
  reset role;
  perform set_config('ocr_guard.source_visible', visible::text, true);
end $$;

-- Each case names the session's account and membership, then restores the reviewing session.
create function pg_temp.run_case(name text, expected text, refusal text, subject text, session_membership text,
  statement text) returns void language plpgsql as $$
begin
  perform set_config('app.actor_subject', subject, true), set_config('app.membership_id', session_membership, true);
  insert into ocr_guard_cases (name, expected, actual) values (name, expected, pg_temp.attempt(statement, refusal));
  perform set_config('app.actor_subject', 'synthetic:ocr-guard-reviewer', true),
    set_config('app.membership_id', 'fb400000-0000-4000-8000-000000000001', true);
end $$;

-- Patient confirmations.
create function pg_temp.confirmation(job uuid, patient uuid, version integer,
  confirmer uuid default 'fb300000-0000-4000-8000-000000000001',
  membership uuid default 'fb400000-0000-4000-8000-000000000001',
  facility uuid default 'fb000000-0000-4000-8000-000000000002') returns text language sql as $$
  select format($insert$insert into ocr.patient_confirmations (job_id, facility_id, patient_id, confirmation_version,
      method, reason, confirmed_by, confirmed_by_membership_id, idempotency_key, request_sha256)
    values (%L, %L, %L, %s, 'source_document', 'Synthetic OCR guard check',
      %L, %L, 'ocr-guard-confirmation-0001', repeat('e', 64))$insert$, job, facility, patient, version, confirmer,
    membership)
$$;
select pg_temp.run_case(name, expected, 'Patient confirmation does not match the canonical OCR source patient',
    subject, session_membership, statement)
  from (values
    ('confirmation: the source document patient',
      case when current_setting('ocr_guard.source_visible')::boolean then 'accepted' else 'refused' end,
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 1)),
    ('confirmation: another patient than the source document''s', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000002', 1)),
    ('confirmation: the source document is missing (no source patient)', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000002', 'fb500000-0000-4000-8000-000000000001', 1)),
    ('confirmation: the source document is missing, any patient', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000002', 'fb500000-0000-4000-8000-000000000002', 1)),
    ('confirmation: the job does not exist', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-0000000000ff', 'fb500000-0000-4000-8000-000000000001', 1)),
    ('confirmation: not the next version', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 2)),
    ('confirmation: the session has no account', 'refused',
      '', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 1)),
    ('confirmation: the session has no membership', 'refused',
      'synthetic:ocr-guard-reviewer', '',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 1)),
    ('confirmation: another account than the session''s', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 1,
        'fb300000-0000-4000-8000-000000000002')),
    ('confirmation: another membership than the session''s', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 1,
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000002')),
    ('confirmation: another facility than the job''s', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 1,
        facility => 'fb000000-0000-4000-8000-000000000003')),
    ('confirmation: another patient than the job''s own', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.confirmation('fb100000-0000-4000-8000-000000000005', 'fb500000-0000-4000-8000-000000000001', 1))
  ) cases(name, expected, subject, session_membership, statement);

-- Validations.
create function pg_temp.validation(job uuid, extraction uuid, reviewer uuid, membership uuid, version integer,
  facility uuid default 'fb000000-0000-4000-8000-000000000002') returns text language sql as $$
  select format($insert$insert into ocr.validations (job_id, facility_id, extraction_id, validation_version,
      validated_payload, reason, validated_by, validated_by_membership_id)
    values (%L, %L, %L, %s, '{}'::jsonb, 'Synthetic OCR guard check', %L, %L)$insert$,
    job, facility, extraction, version, reviewer, membership)
$$;
select pg_temp.run_case(name, expected,
    case when name = 'validation: not the next version' then 'Validation version is not the next immutable version'
      else 'Validation does not match the authorized OCR review context' end,
    subject, session_membership, statement)
  from (values
    ('validation: the reviewing account and membership', 'accepted',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.validation('fb100000-0000-4000-8000-000000000001', 'fb600000-0000-4000-8000-000000000001',
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001', 1)),
    ('validation: the extraction does not exist', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.validation('fb100000-0000-4000-8000-000000000001', 'fb600000-0000-4000-8000-0000000000ff',
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001', 1)),
    ('validation: the extraction belongs to another job', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.validation('fb100000-0000-4000-8000-000000000001', 'fb600000-0000-4000-8000-000000000003',
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001', 1)),
    ('validation: the session has no account', 'refused',
      '', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.validation('fb100000-0000-4000-8000-000000000001', 'fb600000-0000-4000-8000-000000000001',
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001', 1)),
    ('validation: the session subject has no account', 'refused',
      'synthetic:ocr-guard-unknown', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.validation('fb100000-0000-4000-8000-000000000001', 'fb600000-0000-4000-8000-000000000001',
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001', 1)),
    ('validation: the session has no membership', 'refused',
      'synthetic:ocr-guard-reviewer', '',
      pg_temp.validation('fb100000-0000-4000-8000-000000000001', 'fb600000-0000-4000-8000-000000000001',
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001', 1)),
    ('validation: another account than the session''s', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.validation('fb100000-0000-4000-8000-000000000001', 'fb600000-0000-4000-8000-000000000001',
        'fb300000-0000-4000-8000-000000000002', 'fb400000-0000-4000-8000-000000000001', 1)),
    ('validation: another membership than the session''s', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.validation('fb100000-0000-4000-8000-000000000001', 'fb600000-0000-4000-8000-000000000001',
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000002', 1)),
    ('validation: the job is not awaiting validation (its own extraction)', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.validation('fb100000-0000-4000-8000-000000000004', 'fb600000-0000-4000-8000-000000000004',
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001', 1)),
    ('validation: another facility than the job''s', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.validation('fb100000-0000-4000-8000-000000000001', 'fb600000-0000-4000-8000-000000000001',
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001', 1,
        'fb000000-0000-4000-8000-000000000003')),
    ('validation: not the next version', 'refused',
      'synthetic:ocr-guard-reviewer', 'fb400000-0000-4000-8000-000000000001',
      pg_temp.validation('fb100000-0000-4000-8000-000000000001', 'fb600000-0000-4000-8000-000000000001',
        'fb300000-0000-4000-8000-000000000001', 'fb400000-0000-4000-8000-000000000001', 2))
  ) cases(name, expected, subject, session_membership, statement);

-- Every case ran, and every outcome is the expected one.
do $$
declare
  failures text;
begin
  if (select count(*) from ocr_guard_cases) <> 23 or exists (select 1 from ocr_guard_cases where actual is null) then
    raise exception 'the OCR guard suite did not run every case';
  end if;
  select string_agg(format('%s (expected %s, got %s)', name, expected, actual), E'\n  ' order by name)
    into failures from ocr_guard_cases where actual <> expected;
  if failures is not null then
    raise exception E'OCR validation guards do not fail closed:\n  %', failures;
  end if;
end $$;

rollback;
