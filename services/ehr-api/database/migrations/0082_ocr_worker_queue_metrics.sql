-- The OCR worker reports queue depth and age through an aggregate command
-- (main D-Eminence/hid-system#30, main 0075).
--
-- With every claim the OCR worker reports queue depth and the age of the
-- oldest queued job, which feed the OCR queue age alarm and the queue depth
-- scaling signal. It read ocr.jobs directly, but hid_ocr_worker has no table
-- privileges, so the read was always refused (42501) and logged as
-- ocr.queue.metrics_unavailable. ocr.worker_queue_metrics() returns only the
-- two aggregates, with the same definitions as before: queued rows, and the
-- time since the earliest queued_at. It returns no job, patient or facility
-- data.
--
-- The function keeps the migration owner, like ocr.claim_worker_job, which
-- already reads ocr.jobs across facilities for the same worker; main's
-- dedicated non-login owner and its column policy are not ported. Only
-- hid_ocr_worker may execute it. runtime-grants.sql carries the same grant for
-- a role bootstrap; this migration grants it to the role if it already exists,
-- since a release applies only migrations. Applied migrations 0001 through
-- 0081 are immutable.

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

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_ocr_worker') then
    grant execute on function ocr.worker_queue_metrics() to hid_ocr_worker;
  end if;
end;
$$;
