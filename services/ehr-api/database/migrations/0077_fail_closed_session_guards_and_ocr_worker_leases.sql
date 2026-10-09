-- Phase 4 Stage 8: the remaining session guards fail closed (ADR-040). OCR
-- worker leases require the caller's claim token and OCR lease renewal works,
-- an OCR job is bound to a clean scan of its source and can always be taken
-- out of play, an OCR publication is requested by the session's own staff
-- member, and the Lab, Pharmacy and Outreach guards refuse a missing session
-- account, membership or facility instead of comparing it with <>. Applied
-- migrations 0001 through 0076 are immutable.
--
-- Every function below is replaced with CREATE OR REPLACE, which keeps its
-- owner, ACL and triggers; the signature, SECURITY DEFINER attribute (or its
-- absence), search_path and volatility are restated exactly as before (0014,
-- 0016, 0017-0021, 0023, 0024, 0045). Error codes and messages are unchanged.

-- OCR worker commands (0014). complete_worker_job and fail_worker_job compared
-- the claim token with <>: with a NULL token the comparison was NULL and the
-- lease check passed, so any session of the shared OCR worker subject could
-- complete or fail a job that another worker replica held. Both now refuse a
-- NULL token before anything else, as renew_worker_claim already did, and
-- compare with IS DISTINCT FROM. fail_worker_job also refuses an expired lease,
-- as complete_worker_job and renew_worker_claim do: once the lease has ended
-- the job belongs to lease recovery. Missing result or failure metadata (the
-- content hash, structured payload or provenance; the error code, retry flag
-- or retry delay) is refused as invalid (22023) instead of slipping through a
-- NULL comparison: before, a NULL content hash replayed a stored extraction
-- and a NULL retryable flag failed the job for good. A NULL confidence stays
-- allowed. As in 0014, replaying a completed result depends only on the job,
-- the result key and the content hash, not on the token.
create or replace function ocr.complete_worker_job(
  requested_job_id uuid, requested_claim_token uuid,
  requested_provider_result_key text, requested_content_sha256 text,
  requested_provider_model text, requested_provider_request_reference text,
  requested_raw_text text, requested_structured_payload jsonb,
  requested_confidence numeric, requested_provenance jsonb,
  requested_correlation_id text
) returns uuid language plpgsql security definer
set search_path = ocr, audit, auth, platform, pg_temp as $$
declare actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  job_row ocr.jobs%rowtype; existing ocr.extractions%rowtype;
  extraction_id uuid := gen_random_uuid(); next_version integer;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_content_sha256 is null or requested_content_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(requested_structured_payload) is distinct from 'object'
     or jsonb_typeof(requested_provenance) is distinct from 'object'
     or requested_confidence not between 0 and 1 then
    raise exception using errcode = '22023', message = 'Invalid OCR extraction result';
  end if;
  if requested_claim_token is null then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  select * into job_row from ocr.jobs where id = requested_job_id for update;
  select * into existing from ocr.extractions where job_id = requested_job_id
    and provider_result_key = requested_provider_result_key;
  if existing.id is not null then
    if existing.content_sha256 is distinct from requested_content_sha256 then
      raise exception using errcode = '23505', message = 'OCR provider result key payload mismatch';
    end if;
    return existing.id;
  end if;
  if job_row.id is null or job_row.status is distinct from 'processing'
     or job_row.claim_token is distinct from requested_claim_token
     or job_row.claimed_by_subject is distinct from actor_subject
     or job_row.claim_expires_at is null
     or job_row.claim_expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  select coalesce(max(extraction_version), 0) + 1 into next_version
    from ocr.extractions where job_id = requested_job_id;
  insert into ocr.extractions (
    id, job_id, facility_id, document_id, patient_id, extraction_version,
    attempt_no, provider, provider_model, provider_request_reference,
    provider_result_key, content_sha256, source_object_version_id,
    source_sha256_hex, raw_text, structured_payload, confidence, provenance
  ) values (
    extraction_id, job_row.id, job_row.facility_id, job_row.document_id,
    job_row.patient_id, next_version, job_row.attempt_count, job_row.provider,
    requested_provider_model, requested_provider_request_reference,
    requested_provider_result_key, requested_content_sha256,
    job_row.source_object_version_id, job_row.source_sha256_hex,
    requested_raw_text, requested_structured_payload, requested_confidence,
    requested_provenance
  );
  update ocr.jobs set status = 'extracted', completed_at = clock_timestamp(),
    claim_token = null, claim_expires_at = null, claimed_by_subject = null,
    correlation_id = requested_correlation_id, row_version = row_version + 1
   where id = job_row.id;
  update ocr.jobs set status = 'awaiting_validation',
    correlation_id = requested_correlation_id, row_version = row_version + 1
   where id = job_row.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
    patient_id, action, outcome, resource_type, resource_id, provenance, details
  ) values (
    requested_correlation_id, 'workload', actor_subject, actor_account,
    job_row.facility_id, job_row.patient_id, 'ocr.worker.complete', 'success',
    'ocr_job', job_row.id::text, 'application',
    jsonb_build_object('provider', job_row.provider, 'attempt', job_row.attempt_count)
  );
  return extraction_id;
end
$$;

create or replace function ocr.fail_worker_job(
  requested_job_id uuid, requested_claim_token uuid, requested_error_code text,
  requested_error_summary text, requested_retryable boolean,
  requested_retry_delay_seconds integer, requested_correlation_id text
) returns void language plpgsql security definer
set search_path = ocr, audit, auth, platform, pg_temp as $$
declare actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  job_row ocr.jobs%rowtype; will_retry boolean;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_error_code is null or requested_error_code !~ '^[A-Z0-9_]{2,80}$'
     or length(coalesce(requested_error_summary, '')) > 240
     or requested_retryable is null
     or requested_retry_delay_seconds is null
     or requested_retry_delay_seconds not between 0 and 86400 then
    raise exception using errcode = '22023', message = 'Invalid safe OCR failure metadata';
  end if;
  if requested_claim_token is null then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  select * into job_row from ocr.jobs where id = requested_job_id for update;
  if job_row.id is null or job_row.status is distinct from 'processing'
     or job_row.claim_token is distinct from requested_claim_token
     or job_row.claimed_by_subject is distinct from actor_subject
     or job_row.claim_expires_at is null
     or job_row.claim_expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  will_retry := requested_retryable and job_row.attempt_count < job_row.max_attempts;
  update ocr.jobs set status = 'failed', failed_at = clock_timestamp(), completed_at = null,
    last_error_code = requested_error_code, last_error_summary = requested_error_summary,
    next_attempt_at = case when will_retry then clock_timestamp()
      + make_interval(secs => requested_retry_delay_seconds) else clock_timestamp() end,
    claim_token = null, claim_expires_at = null, claimed_by_subject = null,
    correlation_id = requested_correlation_id, row_version = row_version + 1
   where id = requested_job_id;
  if will_retry then
    update ocr.jobs set status = 'queued', started_at = null, failed_at = null,
      correlation_id = requested_correlation_id, row_version = row_version + 1
     where id = requested_job_id;
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
    patient_id, action, outcome, resource_type, resource_id, provenance, details
  ) values (
    requested_correlation_id, 'workload', actor_subject, actor_account,
    job_row.facility_id, job_row.patient_id, 'ocr.worker.fail', 'failure',
    'ocr_job', job_row.id::text, 'application',
    jsonb_build_object('errorCode', requested_error_code, 'retryScheduled', will_retry)
  );
end
$$;

-- The OCR job trigger (0016). Three changes:
-- * Source evidence: the latest scan was compared with <>, so a document with
--   no scan event at all passed. A write that binds the job to its source (an
--   insert, or a change of the document or source object) or starts
--   processing it now needs an exact clean scan, and refuses a missing one.
--   Other updates keep the 0016 rule, under which a missing scan is not
--   refused, so jobs created before this migration for a document without a
--   scan event keep working; a scan that does exist must be exactly clean.
-- * Taking a job out of play (to failed or cancelled, or a failed job back to
--   the queue) no longer re-reads the source evidence. Before, a job whose
--   document was withdrawn or rescanned as not clean while it was processing
--   could be neither completed nor failed, and the lease recovery in
--   ocr.claim_worker_job, which fails and requeues it, then raised for every
--   claim of its provider. A requeued job is claimed only with exact clean
--   evidence, which ocr.claim_worker_job checks itself.
-- * Lease renewal: the state machine allowed no processing-to-processing
--   update, so ocr.renew_worker_claim was always refused and a job that ran
--   longer than its lease could not complete. A processing job whose lease is
--   still active may now take a later expiry, at most an hour ahead as
--   renew_worker_claim allows, and the next version, and nothing else: the
--   token, holder, attempt and every other column must stay as they were.
create or replace function ocr.validate_job_write()
returns trigger language plpgsql security definer
set search_path = ocr, ehr, identity, auth, platform, pg_temp as $$
declare document_row record; latest_scan record; scan_found boolean; binds_source boolean;
  leaves_play boolean;
begin
  select document.id, document.patient_id, document.facility_id, document.object_version_id,
         document.sha256_hex, document.status into document_row
    from ehr.documents document where document.id = new.document_id;
  select scan.event_type, scan.object_version_id, scan.object_sha256_hex,
         scan.binding_migration_hold_reason into latest_scan
    from ehr.document_scan_events scan where scan.document_id = new.document_id
   order by scan.created_at desc, scan.id desc limit 1;
  scan_found := found;
  binds_source := tg_op = 'INSERT';
  if tg_op = 'UPDATE' then
    binds_source := new.document_id is distinct from old.document_id
      or new.source_object_version_id is distinct from old.source_object_version_id
      or new.source_sha256_hex is distinct from old.source_sha256_hex
      or (new.status = 'processing' and old.status is distinct from 'processing');
  end if;
  leaves_play := tg_op = 'UPDATE' and not binds_source
    and (new.status in ('failed', 'cancelled') or (old.status = 'failed' and new.status = 'queued'));
  if not leaves_play and (document_row.id is null or document_row.facility_id is distinct from new.facility_id
     or document_row.object_version_id is distinct from new.source_object_version_id
     or document_row.sha256_hex is distinct from new.source_sha256_hex
     or document_row.status is distinct from 'uploaded'
     or (binds_source and not scan_found)
     or (scan_found and (latest_scan.event_type is distinct from 'clean'
       or latest_scan.object_version_id is distinct from new.source_object_version_id
       or latest_scan.object_sha256_hex is distinct from new.source_sha256_hex
       or latest_scan.binding_migration_hold_reason is not null))) then
    raise exception using errcode = '23514', message = 'OCR requires exact clean immutable document evidence';
  end if;
  if new.patient_id is not null and new.patient_id is distinct from document_row.patient_id then
    raise exception using errcode = '23514', message = 'OCR patient association must match the canonical document patient';
  end if;
  if tg_op = 'UPDATE' then
    if new.facility_id is distinct from old.facility_id or new.document_id is distinct from old.document_id
       or new.patient_id is distinct from old.patient_id
       or new.source_object_version_id is distinct from old.source_object_version_id
       or new.source_sha256_hex is distinct from old.source_sha256_hex
       or new.operation is distinct from old.operation
       or new.idempotency_key is distinct from old.idempotency_key
       or new.request_sha256 is distinct from old.request_sha256
       or new.provider is distinct from old.provider or new.created_by is distinct from old.created_by
       or new.created_by_membership_id is distinct from old.created_by_membership_id
       or new.row_version is distinct from old.row_version + 1 then
      raise exception using errcode = '55000', message = 'OCR job identity is immutable and updates require the next version';
    end if;
    if not ((old.status = 'queued' and new.status in ('processing', 'cancelled'))
      or (old.status = 'processing' and new.status in ('extracted', 'failed'))
      or (old.status = 'extracted' and new.status = 'awaiting_validation')
      or (old.status = 'awaiting_validation' and new.status in ('validated', 'rejected'))
      or (old.status = 'failed' and new.status in ('queued', 'cancelled'))
      or (old.status = 'processing' and new.status = 'processing'
        and old.claim_token is not null and old.claim_expires_at > clock_timestamp()
        and new.claim_expires_at > old.claim_expires_at
        and new.claim_expires_at <= clock_timestamp() + interval '3600 seconds'
        and (to_jsonb(new) - array['claim_expires_at', 'row_version', 'updated_at'])
          = (to_jsonb(old) - array['claim_expires_at', 'row_version', 'updated_at']))) then
      raise exception using errcode = '23514', message = 'Invalid OCR job state transition';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end
$$;

-- The OCR job event trigger (0016) fires on every update that names the
-- status. The only same-status update the job trigger allows is a lease
-- renewal, which is not a status change: it records no job event and no
-- outbox event, even when the update names the status.
create or replace function ocr.record_job_event()
returns trigger language plpgsql security definer set search_path = ocr, platform, pg_temp as $$
declare event_name text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  event_name := case new.status when 'queued' then 'OcrJobQueued'
    when 'processing' then 'OcrProcessingStarted' when 'extracted' then 'OcrExtractionCreated'
    when 'awaiting_validation' then 'OcrAwaitingValidation' when 'validated' then 'OcrValidated'
    when 'rejected' then 'OcrValidationRejected' when 'failed' then 'OcrFailed'
    else 'OcrJobCancelled' end;
  insert into ocr.job_events (job_id, facility_id, from_status, to_status, job_version,
    actor_subject, correlation_id, reason_code) values (new.id, new.facility_id,
    case when tg_op = 'UPDATE' then old.status end, new.status, new.row_version,
    platform.current_actor_subject(), new.correlation_id, new.last_error_code);
  insert into ocr.outbox_events (event_type, aggregate_id, aggregate_version,
    facility_id, correlation_id, payload) values (event_name, new.id, new.row_version,
    new.facility_id, new.correlation_id, jsonb_build_object('jobId', new.id,
      'documentId', new.document_id, 'status', new.status,
      'patientResolved', new.patient_id is not null));
  return new;
end
$$;

-- The OCR publication trigger (0016) did not bind the requester to the
-- session: a publication could name any member of the facility as its
-- requester, the attribution gap 0076 closed for patient confirmations. An
-- insert must now name the session's own account and membership, and is
-- refused when the session has none. Updates read no session: the OCR API
-- drives the lifecycle (claim, completion, failure, retry) and lease recovery
-- needs no requester; the requester stays immutable. Comparisons use
-- IS DISTINCT FROM.
create or replace function ocr.validate_publication_write()
returns trigger language plpgsql security definer set search_path = ocr, pg_temp as $$
declare validation_row ocr.validations%rowtype; confirmation_row ocr.patient_confirmations%rowtype;
  actor_account uuid; actor_membership uuid;
begin
  if tg_op = 'INSERT' then
    actor_account := platform.current_account_id();
    actor_membership := platform.current_membership_id();
    select * into validation_row from ocr.validations where id = new.validation_id;
    select * into confirmation_row from ocr.patient_confirmations where id = new.patient_confirmation_id;
    if validation_row.id is null or confirmation_row.id is null
       or actor_account is null or actor_membership is null
       or validation_row.job_id is distinct from new.job_id
       or validation_row.facility_id is distinct from new.facility_id
       or validation_row.validation_version is distinct from new.validation_version
       or validation_row.disposition is distinct from 'validated'
       or validation_row.target_domain is distinct from new.target_domain
       or validation_row.target_domain = 'UNCLASSIFIED'
       or confirmation_row.job_id is distinct from new.job_id
       or confirmation_row.facility_id is distinct from new.facility_id
       or confirmation_row.patient_id is distinct from new.patient_id
       or new.requested_by is distinct from actor_account
       or new.requested_by_membership_id is distinct from actor_membership then
      raise exception using errcode = '23514', message = 'Publication is not bound to validated confirmed OCR evidence';
    end if;
  else
    if new.job_id is distinct from old.job_id or new.validation_id is distinct from old.validation_id
       or new.validation_version is distinct from old.validation_version
       or new.patient_confirmation_id is distinct from old.patient_confirmation_id
       or new.facility_id is distinct from old.facility_id or new.patient_id is distinct from old.patient_id
       or new.target_domain is distinct from old.target_domain
       or new.target_operation is distinct from old.target_operation
       or new.idempotency_key is distinct from old.idempotency_key
       or new.request_sha256 is distinct from old.request_sha256
       or new.requested_by is distinct from old.requested_by
       or new.requested_by_membership_id is distinct from old.requested_by_membership_id
       or new.row_version is distinct from old.row_version + 1 then
      raise exception using errcode = '55000', message = 'OCR publication identity is immutable';
    end if;
    if not ((old.status = 'pending' and new.status = 'processing')
      or (old.status = 'processing' and new.status in ('published', 'failed'))
      or (old.status = 'failed' and new.status = 'processing')
      or (old.status = 'processing' and new.status = 'processing')) then
      raise exception using errcode = '23514', message = 'Invalid OCR publication transition';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end
$$;

-- Outreach guards (0024, 0045). They compared the session account,
-- membership, facility and purpose with <>, so with a missing or unresolved
-- session value the comparison was NULL and the guard passed. Forced RLS
-- refuses those writes for the Outreach runtime, but a session that bypasses
-- RLS (a superuser, or an owner without FORCE ROW LEVEL SECURITY) could record
-- a registration, a resolution, an event or a campaign attributed to any
-- member with no request context at all. Each guard now resolves the session
-- once, refuses a missing session value wherever it is compared (and a purpose
-- other than direct care) with the existing code and message, and compares
-- with IS DISTINCT FROM. The only writer, the Outreach API, always sets the
-- full context. A campaign update still compares only the facility, as in
-- 0045. validate_registration_case_event keeps invoker rights.
create or replace function outreach.validate_registration_case_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
declare
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
begin
  if actor_account is null
     or actor_membership is null
     or actor_facility is null
     or platform.current_purpose_of_use() is distinct from 'direct-care'
     or new.facility_id is distinct from actor_facility then
    raise exception using errcode = '42501', message = 'Valid Outreach registration context is required';
  end if;

  if tg_op = 'INSERT' then
    if new.created_by_account_id is distinct from actor_account
       or new.created_by_membership_id is distinct from actor_membership
       or new.status is distinct from 'identity_resolution_pending'
       or new.row_version is distinct from 1 then
      raise exception using errcode = '42501', message = 'Outreach registration starts unresolved';
    end if;
    return new;
  end if;

  if old.status is distinct from 'identity_resolution_pending'
     or new.status is distinct from 'identity_resolved'
     or new.row_version is distinct from old.row_version + 1
     or new.resolution_kind is distinct from 'linked_existing'
     or new.resolved_by_account_id is distinct from actor_account
     or new.resolved_by_membership_id is distinct from actor_membership
     or new.id is distinct from old.id
     or new.facility_id is distinct from old.facility_id
     or new.created_by_account_id is distinct from old.created_by_account_id
     or new.created_by_membership_id is distinct from old.created_by_membership_id
     or new.local_command_id is distinct from old.local_command_id
     or new.temporary_patient_id is distinct from old.temporary_patient_id
     or new.full_name is distinct from old.full_name
     or new.sex is distinct from old.sex
     or new.age_years is distinct from old.age_years
     or new.phone is distinct from old.phone
     or new.operational_notes is distinct from old.operational_notes
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'Outreach registration history cannot be overwritten';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;

create or replace function outreach.validate_registration_case_event()
returns trigger
language plpgsql
set search_path = pg_catalog, platform, outreach
as $$
declare
  registration outreach.registration_cases%rowtype;
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
begin
  if actor_account is null
     or actor_membership is null
     or new.actor_account_id is distinct from actor_account
     or new.actor_membership_id is distinct from actor_membership then
    raise exception using errcode = '42501', message = 'Outreach event actor must match request context';
  end if;
  select * into registration from outreach.registration_cases where id = new.registration_case_id;
  if not found
     or new.facility_id is distinct from registration.facility_id
     or new.temporary_patient_id is distinct from registration.temporary_patient_id
     or (new.event_type = 'existing_patient_linked'
       and (registration.status is distinct from 'identity_resolved'
         or new.canonical_patient_id is distinct from registration.resolved_patient_id)) then
    raise exception using errcode = '23514', message = 'Outreach event must match its registration case';
  end if;
  return new;
end
$$;

create or replace function outreach.validate_campaign_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
declare
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
begin
  if actor_facility is null or new.facility_id is distinct from actor_facility then
    raise exception using errcode='42501',message='Valid Outreach campaign context is required';
  end if;
  if tg_op = 'INSERT' then
    if actor_account is null
       or actor_membership is null
       or new.created_by_account_id is distinct from actor_account
       or new.created_by_membership_id is distinct from actor_membership then
      raise exception using errcode='42501',message='Valid Outreach campaign creator is required';
    end if;
  else
    if old.id is distinct from new.id or old.facility_id is distinct from new.facility_id
       or old.created_by_account_id is distinct from new.created_by_account_id
       or old.created_by_membership_id is distinct from new.created_by_membership_id
       or old.created_at is distinct from new.created_at
       or new.row_version is distinct from old.row_version + 1 then
      raise exception using errcode='55000',message='Outreach campaign history cannot be overwritten';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end $$;

-- Lab guards (0017-0021). Same defect as the Outreach guards: each compared
-- the row's actor and facility with the session using <>, so a missing or
-- unresolved session value let the row through to RLS, and a session that
-- bypasses RLS could record Lab evidence, work, accessions, executions and
-- result governance attributed to any member. Each guard now refuses a missing
-- session value with its existing code and message and compares with IS
-- DISTINCT FROM; missing parent rows are refused explicitly. The OCR
-- publication branch of validate_imported_evidence compared rows its owner
-- reads under RLS: under an owner that does not bypass RLS (P8), another
-- facility's validation and publication read as NULL and passed. It now
-- refuses a missing job, extraction, validation or publication. An OCR job
-- with no patient stays acceptable, as in 0016 and 0076; the publication
-- still binds the patient. The only writer, the Lab API, always sets the full
-- context.
create or replace function lab.validate_imported_evidence()
returns trigger language plpgsql security definer
set search_path = lab, ehr, ocr, identity, auth, platform, pg_temp as $$
declare source_row record; job_row record; extraction_row record; validation_row record; publication_row record;
  session_facility uuid := platform.current_facility_id();
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
begin
  select patient_id,facility_id into source_row from ehr.documents where id=new.source_document_id;
  if source_row.patient_id is null or session_facility is null
     or actor_account is null or actor_membership is null
     or source_row.patient_id is distinct from new.patient_id
     or source_row.facility_id is distinct from new.facility_id
     or new.facility_id is distinct from session_facility
     or new.created_by is distinct from actor_account
     or new.created_by_membership_id is distinct from actor_membership then
    raise exception using errcode='23514',message='Lab import source, patient, facility, or actor context is invalid';
  end if;
  if new.publication_id is not null then
    select id,document_id,patient_id,facility_id into job_row from ocr.jobs where id=new.ocr_job_id;
    select id,job_id,document_id into extraction_row from ocr.extractions where id=new.extraction_id;
    select id,job_id,extraction_id,validation_version,disposition,target_domain,validated_by
      into validation_row from ocr.validations where id=new.validation_id;
    select id,job_id,validation_id,validation_version,patient_id,facility_id,target_domain,target_operation,status
      into publication_row from ocr.publications where id=new.publication_id;
    if job_row.id is null or extraction_row.id is null or validation_row.id is null or publication_row.id is null
       or job_row.document_id is distinct from new.source_document_id
       or (job_row.patient_id is not null and job_row.patient_id is distinct from new.patient_id)
       or job_row.facility_id is distinct from new.facility_id
       or extraction_row.job_id is distinct from new.ocr_job_id
       or extraction_row.document_id is distinct from new.source_document_id
       or validation_row.job_id is distinct from new.ocr_job_id
       or validation_row.extraction_id is distinct from new.extraction_id
       or validation_row.validation_version is distinct from new.validation_version
       or validation_row.disposition is distinct from 'validated'
       or validation_row.target_domain is distinct from 'LAB'
       or validation_row.validated_by is distinct from new.reviewed_by
       or publication_row.job_id is distinct from new.ocr_job_id
       or publication_row.validation_id is distinct from new.validation_id
       or publication_row.validation_version is distinct from new.validation_version
       or publication_row.patient_id is distinct from new.patient_id
       or publication_row.facility_id is distinct from new.facility_id
       or publication_row.target_domain is distinct from 'LAB'
       or publication_row.target_operation is distinct from 'create_imported_lab_evidence'
       or publication_row.status is distinct from 'processing' then
      raise exception using errcode='23514',message='Lab import is not bound to exact governed OCR publication evidence';
    end if;
  end if;
  return new;
end
$$;

create or replace function lab.validate_work_item()
returns trigger language plpgsql security definer
set search_path = lab, ehr, identity, auth, platform, pg_temp as $$
declare source_row ehr.lab_requests%rowtype;
  session_facility uuid := platform.current_facility_id();
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
begin
  select * into source_row from ehr.lab_requests where id=new.source_ehr_order_id;
  if source_row.id is null or session_facility is null
     or actor_account is null or actor_membership is null
     or source_row.patient_id is distinct from new.patient_id
     or source_row.facility_id is distinct from new.facility_id
     or source_row.encounter_id is distinct from new.source_encounter_id
     or source_row.row_version is distinct from new.source_ehr_order_version
     or source_row.status is distinct from 'active'
     or source_row.test_code_system is distinct from new.test_code_system
     or source_row.test_code is distinct from new.test_code
     or source_row.test_display is distinct from new.test_name
     or source_row.priority is distinct from new.priority
     or source_row.clinical_information is distinct from new.clinical_indication
     or source_row.created_by is distinct from new.requested_by
     or source_row.created_at is distinct from new.requested_at
     or new.facility_id is distinct from session_facility
     or new.accepted_by is distinct from actor_account
     or new.accepted_by_membership_id is distinct from actor_membership then
    raise exception using errcode='23514',message='Lab work item does not match the exact active EHR order version and actor context';
  end if;
  return new;
end
$$;

create or replace function lab.validate_accession_insert()
returns trigger language plpgsql security definer
set search_path = lab, platform, pg_temp as $$
declare parent lab.work_items%rowtype;
  session_facility uuid := platform.current_facility_id();
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
begin
  select * into parent from lab.work_items where id=new.work_item_id;
  if parent.id is null or session_facility is null
     or actor_account is null or actor_membership is null
     or parent.status is distinct from 'accepted'
     or parent.patient_id is distinct from new.patient_id
     or parent.facility_id is distinct from new.facility_id
     or parent.priority is distinct from new.priority
     or new.facility_id is distinct from session_facility
     or new.created_by is distinct from actor_account
     or new.created_by_membership_id is distinct from actor_membership then
    raise exception using errcode='23514',message='Accession does not match accepted Lab work and actor context';
  end if;
  return new;
end
$$;

create or replace function lab.validate_execution_insert()
returns trigger language plpgsql security definer
set search_path = lab, platform, pg_temp as $$
declare specimen lab.specimens%rowtype; accession lab.accessions%rowtype; test lab.work_item_requested_tests%rowtype;
  session_facility uuid := platform.current_facility_id();
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
begin
  select * into specimen from lab.specimens where id=new.specimen_id;
  select * into accession from lab.accessions where id=new.accession_id;
  select * into test from lab.work_item_requested_tests where id=new.requested_test_id;
  if specimen.id is null or accession.id is null or test.id is null or session_facility is null
     or actor_account is null or actor_membership is null
     or specimen.status is distinct from 'received'
     or specimen.accession_id is distinct from new.accession_id
     or specimen.patient_id is distinct from new.patient_id
     or specimen.facility_id is distinct from new.facility_id
     or accession.patient_id is distinct from new.patient_id
     or accession.facility_id is distinct from new.facility_id
     or test.work_item_id is distinct from accession.work_item_id
     or test.patient_id is distinct from new.patient_id
     or test.facility_id is distinct from new.facility_id
     or new.facility_id is distinct from session_facility
     or new.started_by is distinct from actor_account
     or new.started_by_membership_id is distinct from actor_membership then
    raise exception using errcode='23514',message='Execution must match a received specimen and exact requested test';
  end if;
  return new;
end
$$;

-- Result governance keeps its split: the result binding (including the
-- session facility) raises 23514 and each actor check raises 42501.
create or replace function lab.validate_result_governance()
returns trigger language plpgsql security definer
set search_path = lab, platform, pg_temp as $$
declare head lab.results%rowtype; rev lab.result_revisions%rowtype; verifier uuid;
  session_facility uuid := platform.current_facility_id();
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
begin
  select * into head from lab.results where id=new.result_id;
  select * into rev from lab.result_revisions where result_id=new.result_id and version=new.result_version;
  if head.id is null or rev.id is null or session_facility is null
     or head.execution_id is distinct from new.execution_id
     or head.patient_id is distinct from new.patient_id
     or head.facility_id is distinct from new.facility_id
     or head.current_version is distinct from new.result_version
     or new.facility_id is distinct from session_facility then
    raise exception using errcode='23514',message='Governance command must bind the exact current result version';
  end if;
  if tg_table_name='result_verifications' then
    if actor_account is null or actor_membership is null
       or new.verified_by is distinct from actor_account
       or new.verified_by_membership_id is distinct from actor_membership then
      raise exception using errcode='42501',message='Verifier must match authenticated database context';
    end if;
    if rev.entered_by is not distinct from new.verified_by
       or exists(select 1 from lab.result_invalidations i where i.result_id=new.result_id and i.result_version=new.result_version) then
      raise exception using errcode='23514',message='Result verifier must be independent and result must be eligible';
    end if;
  elsif tg_table_name='result_releases' then
    if actor_account is null or actor_membership is null
       or new.released_by is distinct from actor_account
       or new.released_by_membership_id is distinct from actor_membership then
      raise exception using errcode='42501',message='Release actor must match authenticated database context';
    end if;
    select verified_by into verifier from lab.result_verifications
     where id=new.verification_id and result_id=new.result_id and result_version=new.result_version;
    if verifier is null
       or exists(select 1 from lab.result_invalidations i where i.result_id=new.result_id and i.result_version=new.result_version) then
      raise exception using errcode='23514',message='Release requires exact valid verification';
    end if;
  else
    if actor_account is null or actor_membership is null
       or new.actor_id is distinct from actor_account
       or new.actor_membership_id is distinct from actor_membership then
      raise exception using errcode='42501',message='Invalidation actor must match authenticated database context';
    end if;
  end if;
  return new;
end
$$;

-- Pharmacy guards (0023). Same defect and same rewrite: a missing session
-- value is refused wherever it was compared, with the existing code and
-- message, and every comparison is IS DISTINCT FROM. The work-item event guard
-- still binds the event to its work item's accepter and the session actor; as
-- in 0023 it does not compare the facility with the session. The only writer,
-- the Pharmacy API, always sets the full context; EHR acceptances and OCR
-- imports reach it as the requesting staff member.
create or replace function pharmacy.validate_work_item()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
begin
  if session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or new.facility_id is distinct from new.ordering_facility_id
     or new.facility_id is distinct from session_facility_id
     or new.accepted_by is distinct from session_account_id
     or new.accepted_by_membership_id is distinct from session_membership_id
     or new.source_status is distinct from 'active' then
    raise exception using errcode = '23514',
      message = 'Pharmacy acceptance patient, facility, prescription status, or actor context is invalid';
  end if;
  return new;
end
$$;

create or replace function pharmacy.validate_work_item_event()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  parent_row pharmacy.work_items%rowtype;
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
begin
  select * into parent_row from pharmacy.work_items where id = new.work_item_id;
  if parent_row.id is null
     or session_account_id is null
     or session_membership_id is null
     or parent_row.patient_id is distinct from new.patient_id
     or parent_row.facility_id is distinct from new.facility_id
     or parent_row.accepted_by is distinct from new.actor_id
     or parent_row.accepted_by_membership_id is distinct from new.actor_membership_id
     or parent_row.acceptance_reason is distinct from new.reason
     or new.actor_id is distinct from session_account_id
     or new.actor_membership_id is distinct from session_membership_id then
    raise exception using errcode = '23514',
      message = 'Pharmacy work-item event does not match its accepted prescription';
  end if;
  return new;
end
$$;

create or replace function pharmacy.validate_dispensing()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  parent_row pharmacy.work_items%rowtype;
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
begin
  select * into parent_row from pharmacy.work_items where id = new.work_item_id;
  if parent_row.id is null
     or session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or parent_row.patient_id is distinct from new.patient_id
     or parent_row.facility_id is distinct from new.facility_id
     or parent_row.row_version is distinct from new.work_item_version
     or parent_row.medication_code_system is distinct from new.medication_code_system
     or parent_row.medication_code is distinct from new.medication_code
     or parent_row.medication_display is distinct from new.medication_display
     or new.facility_id is distinct from session_facility_id
     or new.dispensed_by is distinct from session_account_id
     or new.dispensed_by_membership_id is distinct from session_membership_id then
    raise exception using errcode = '23514',
      message = 'Dispensing does not match its eligible Pharmacy work item and actor context';
  end if;
  return new;
end
$$;

create or replace function pharmacy.validate_dispensing_reversal()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  parent_row pharmacy.dispensings%rowtype;
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
begin
  select * into parent_row from pharmacy.dispensings where id = new.dispensing_id;
  if parent_row.id is null
     or session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or parent_row.work_item_id is distinct from new.work_item_id
     or parent_row.patient_id is distinct from new.patient_id
     or parent_row.facility_id is distinct from new.facility_id
     or parent_row.row_version is distinct from new.dispensing_version
     or new.facility_id is distinct from session_facility_id
     or new.reversed_by is distinct from session_account_id
     or new.reversed_by_membership_id is distinct from session_membership_id then
    raise exception using errcode = '23514',
      message = 'Dispensing reversal does not match its original dispensing and actor context';
  end if;
  return new;
end
$$;

create or replace function pharmacy.validate_imported_medication_evidence()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
begin
  if session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or new.facility_id is distinct from session_facility_id
     or new.created_by is distinct from session_account_id
     or new.created_by_membership_id is distinct from session_membership_id then
    raise exception using errcode = '23514',
      message = 'Imported medication evidence patient, facility, or actor context is invalid';
  end if;
  return new;
end
$$;
