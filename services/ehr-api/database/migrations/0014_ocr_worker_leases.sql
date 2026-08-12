-- Lease-bound commands and exact immutable source metadata for the isolated OCR worker.
-- Migration 0013 is already applied and remains immutable.

alter table ocr.jobs
  add column claim_token uuid,
  add column claim_expires_at timestamptz,
  add column claimed_by_subject text;

-- Pre-lease processing rows cannot prove ownership. Fail them safely, then
-- requeue only those with attempts remaining before enforcing the invariant.
update ocr.jobs set status = 'failed', failed_at = clock_timestamp(),
  last_error_code = 'WORKER_LEASE_MIGRATION',
  last_error_summary = 'Processing attempt predated lease-bound worker claims',
  row_version = row_version + 1
 where status = 'processing';
update ocr.jobs set status = 'queued', started_at = null, failed_at = null,
  next_attempt_at = clock_timestamp(), row_version = row_version + 1
 where status = 'failed' and last_error_code = 'WORKER_LEASE_MIGRATION'
   and attempt_count < max_attempts;

alter table ocr.jobs add constraint ocr_jobs_claim_lease_check check (
  (status = 'processing' and claim_token is not null and claim_expires_at is not null
    and claimed_by_subject is not null)
  or (status <> 'processing' and claim_token is null and claim_expires_at is null
    and claimed_by_subject is null)
);
create index ocr_jobs_expired_claim_idx on ocr.jobs (claim_expires_at, id)
  where status = 'processing';

create or replace function ocr.claim_worker_job(
  requested_provider text,
  requested_lease_seconds integer
)
returns table (
  job_id uuid, facility_id uuid, document_id uuid, patient_id uuid,
  storage_bucket text, storage_key text, object_version_id text,
  source_sha256_hex text, size_bytes bigint, media_type text,
  provider text, attempt_no integer, max_attempts integer,
  claim_token uuid, claim_expires_at timestamptz, correlation_id text
) language plpgsql security definer
set search_path = ocr, ehr, audit, auth, platform, pg_temp as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  candidate ocr.jobs%rowtype;
  expired ocr.jobs%rowtype;
  new_token uuid := gen_random_uuid();
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_provider is null or length(btrim(requested_provider)) not between 1 and 120
     or requested_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid OCR claim request';
  end if;

  -- Recover a bounded number of abandoned leases. Each transition remains visible
  -- through the existing immutable job-event and transactional-outbox triggers.
  for expired in
    select * from ocr.jobs
     where status = 'processing' and provider = requested_provider
       and claim_expires_at <= clock_timestamp()
     order by claim_expires_at, id for update skip locked limit 10
  loop
    update ocr.jobs set status = 'failed', failed_at = clock_timestamp(),
      last_error_code = 'WORKER_LEASE_EXPIRED',
      last_error_summary = 'OCR worker lease expired before completion',
      claim_token = null, claim_expires_at = null, claimed_by_subject = null,
      row_version = row_version + 1 where id = expired.id;
    if expired.attempt_count < expired.max_attempts then
      update ocr.jobs set status = 'queued', started_at = null, failed_at = null,
        next_attempt_at = clock_timestamp(), row_version = row_version + 1
       where id = expired.id;
    end if;
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
      patient_id, action, outcome, resource_type, resource_id, provenance, details
    ) values (
      expired.correlation_id, 'workload', actor_subject, actor_account,
      expired.facility_id, expired.patient_id, 'ocr.worker.lease_recovered', 'failure',
      'ocr_job', expired.id::text, 'application',
      jsonb_build_object('errorCode', 'WORKER_LEASE_EXPIRED',
        'retryScheduled', expired.attempt_count < expired.max_attempts)
    );
  end loop;

  select job.* into candidate from ocr.jobs job
   join ehr.documents document on document.id = job.document_id
   where job.status = 'queued' and job.provider = requested_provider
     and job.next_attempt_at <= clock_timestamp() and job.attempt_count < job.max_attempts
     and document.status = 'uploaded'
     and document.object_version_id = job.source_object_version_id
     and document.sha256_hex = job.source_sha256_hex
     and exists (
       select 1 from ehr.document_scan_events scan
        where scan.id = (select latest.id from ehr.document_scan_events latest
          where latest.document_id = job.document_id
          order by latest.created_at desc, latest.id desc limit 1)
          and scan.event_type = 'clean'
          and scan.object_version_id = job.source_object_version_id
          and scan.object_sha256_hex = job.source_sha256_hex
          and scan.binding_migration_hold_reason is null
     )
   order by job.next_attempt_at, job.queued_at, job.id
   for update of job skip locked limit 1;
  if candidate.id is null then return; end if;

  update ocr.jobs job set status = 'processing', attempt_count = job.attempt_count + 1,
    started_at = clock_timestamp(), completed_at = null, failed_at = null,
    last_error_code = null, last_error_summary = null, claim_token = new_token,
    claim_expires_at = clock_timestamp() + make_interval(secs => requested_lease_seconds),
    claimed_by_subject = actor_subject, row_version = job.row_version + 1
   where job.id = candidate.id;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
    patient_id, action, outcome, resource_type, resource_id, provenance, details
  ) values (
    candidate.correlation_id, 'workload', actor_subject, actor_account,
    candidate.facility_id, candidate.patient_id, 'ocr.worker.claim', 'success',
    'ocr_job', candidate.id::text, 'application',
    jsonb_build_object('provider', requested_provider, 'attempt', candidate.attempt_count + 1)
  );

  return query select job.id, job.facility_id, job.document_id, job.patient_id,
    document.storage_bucket, document.storage_key, job.source_object_version_id,
    job.source_sha256_hex::text, document.size_bytes, document.declared_media_type,
    job.provider, job.attempt_count, job.max_attempts, job.claim_token,
    job.claim_expires_at, job.correlation_id
   from ocr.jobs job join ehr.documents document on document.id = job.document_id
   where job.id = candidate.id;
end
$$;

create or replace function ocr.renew_worker_claim(
  requested_job_id uuid, requested_claim_token uuid, requested_lease_seconds integer
) returns timestamptz language plpgsql security definer
set search_path = ocr, auth, platform, pg_temp as $$
declare actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject); renewed timestamptz;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid OCR lease duration';
  end if;
  update ocr.jobs set claim_expires_at = clock_timestamp() + make_interval(secs => requested_lease_seconds),
    row_version = row_version + 1
   where id = requested_job_id and status = 'processing'
     and claim_token = requested_claim_token and claimed_by_subject = actor_subject
     and claim_expires_at > clock_timestamp()
   returning claim_expires_at into renewed;
  if renewed is null then raise exception using errcode = '55000', message = 'OCR claim is not active'; end if;
  return renewed;
end
$$;

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
  if requested_content_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(requested_structured_payload) <> 'object'
     or jsonb_typeof(requested_provenance) <> 'object'
     or requested_confidence not between 0 and 1 then
    raise exception using errcode = '22023', message = 'Invalid OCR extraction result';
  end if;
  select * into job_row from ocr.jobs where id = requested_job_id for update;
  select * into existing from ocr.extractions where job_id = requested_job_id
    and provider_result_key = requested_provider_result_key;
  if existing.id is not null then
    if existing.content_sha256 <> requested_content_sha256 then
      raise exception using errcode = '23505', message = 'OCR provider result key payload mismatch';
    end if;
    return existing.id;
  end if;
  if job_row.id is null or job_row.status <> 'processing'
     or job_row.claim_token <> requested_claim_token
     or job_row.claimed_by_subject <> actor_subject
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
  if requested_error_code !~ '^[A-Z0-9_]{2,80}$'
     or length(coalesce(requested_error_summary, '')) > 240
     or requested_retry_delay_seconds not between 0 and 86400 then
    raise exception using errcode = '22023', message = 'Invalid safe OCR failure metadata';
  end if;
  select * into job_row from ocr.jobs where id = requested_job_id for update;
  if job_row.id is null or job_row.status <> 'processing'
     or job_row.claim_token <> requested_claim_token
     or job_row.claimed_by_subject <> actor_subject then
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

-- Preserve the 0013 command signatures for rollback-only schema tests and
-- existing controlled callers, while routing them through lease enforcement.
create or replace function ocr.claim_next_job(requested_provider text)
returns setof ocr.jobs language plpgsql security definer
set search_path = ocr, pg_temp as $$
declare claimed_id uuid;
begin
  select worker.job_id into claimed_id from ocr.claim_worker_job(requested_provider, 300) worker;
  if claimed_id is not null then return query select * from ocr.jobs where id = claimed_id; end if;
end
$$;

create or replace function ocr.record_extraction(
  requested_job_id uuid, requested_provider_result_key text,
  requested_content_sha256 text, requested_provider_model text,
  requested_provider_request_reference text, requested_raw_text text,
  requested_structured_payload jsonb, requested_confidence numeric,
  requested_provenance jsonb, requested_correlation_id text
) returns uuid language plpgsql security definer set search_path = ocr, pg_temp as $$
declare token uuid;
begin
  select claim_token into token from ocr.jobs where id = requested_job_id;
  return ocr.complete_worker_job(requested_job_id, token, requested_provider_result_key,
    requested_content_sha256, requested_provider_model, requested_provider_request_reference,
    requested_raw_text, requested_structured_payload, requested_confidence,
    requested_provenance, requested_correlation_id);
end
$$;

create or replace function ocr.fail_job(
  requested_job_id uuid, requested_error_code text, requested_error_summary text,
  requested_retryable boolean, requested_retry_delay_seconds integer,
  requested_correlation_id text
) returns void language plpgsql security definer set search_path = ocr, pg_temp as $$
declare token uuid;
begin
  select claim_token into token from ocr.jobs where id = requested_job_id;
  perform ocr.fail_worker_job(requested_job_id, token, requested_error_code,
    requested_error_summary, requested_retryable, requested_retry_delay_seconds,
    requested_correlation_id);
end
$$;

revoke all on function ocr.claim_worker_job(text, integer) from public;
revoke all on function ocr.renew_worker_claim(uuid, uuid, integer) from public;
revoke all on function ocr.complete_worker_job(uuid, uuid, text, text, text, text, text, jsonb, numeric, jsonb, text) from public;
revoke all on function ocr.fail_worker_job(uuid, uuid, text, text, boolean, integer, text) from public;

comment on function ocr.claim_worker_job(text, integer) is
  'Atomically recovers stale leases, claims one eligible job, and returns only exact immutable source metadata.';
