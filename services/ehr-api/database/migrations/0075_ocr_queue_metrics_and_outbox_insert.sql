-- Phase 4 Stage 6: OCR worker queue metrics and OCR outbox inserts.
--
-- 1. With every claim the OCR worker reports queue depth and the age of the
--    oldest queued job, which feed OcrQueueAgeAlarm and the QueueDepth
--    scaling signal. It read ocr.jobs directly, but hid_ocr_worker has no
--    table privileges, so the read was always refused (42501) and logged as
--    ocr.queue.metrics_unavailable. ocr.worker_queue_metrics() returns only
--    the two aggregates, with the same definitions as before: queued rows, and
--    the time since the earliest queued_at. The role bootstrap grants EXECUTE
--    to hid_ocr_worker only, and makes hid_ocr_queue_metrics its owner: a
--    non-login technical role that can read only ocr.jobs.status and
--    ocr.jobs.queued_at, across facilities, through one exact policy. The
--    function therefore does not depend on its owner bypassing FORCE ROW
--    LEVEL SECURITY.
-- 2. ocr.outbox_events had only SELECT policies under FORCE ROW LEVEL
--    SECURITY, so every insert by the OCR API runtime was refused ("new row
--    violates row-level security policy"). Patient confirmation and every
--    publication request, success and failure append an outbox event in the
--    same transaction, so all of them failed. The insert policy admits rows
--    for the current facility only, as ocr.extractions and ocr.validations
--    already do. Only hid_ocr_runtime holds INSERT on the table.

create function ocr.worker_queue_metrics()
returns table (queue_depth bigint, oldest_queue_age_seconds bigint)
language sql volatile security definer
set search_path = pg_catalog, ocr, pg_temp as $$
  select count(*)::bigint,
         coalesce(extract(epoch from (clock_timestamp() - min(job.queued_at))), 0)::bigint
    from ocr.jobs job
   where job.status = 'queued'
$$;
revoke all on function ocr.worker_queue_metrics() from public;
comment on function ocr.worker_queue_metrics() is
  'Aggregate-only OCR queue depth and oldest queued age for the OCR worker; no job, patient or facility data.';

create policy ocr_outbox_staff_insert on ocr.outbox_events for insert
  with check (facility_id = platform.current_facility_id());
