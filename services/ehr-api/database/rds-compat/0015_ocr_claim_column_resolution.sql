-- RDS compatibility for immutable migration 0015. Recreate the 0014 function
-- with PostgreSQL's function-local column resolution directive.
-- The migration ledger records this effective SQL checksum separately.

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
#variable_conflict use_column
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
