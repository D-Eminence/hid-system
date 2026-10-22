-- OCR patient confirmation and publication can write their outbox events
-- (main D-Eminence/hid-system#30, the last statement of main 0075).
--
-- ocr.outbox_events has FORCE ROW LEVEL SECURITY (0013) and only SELECT
-- policies, so every insert by the OCR API runtime was refused ("new row
-- violates row-level security policy"). Patient confirmation and every
-- publication request, success and failure append an outbox event in the same
-- transaction, so all of them failed. The insert policy admits rows for the
-- current facility only, as ocr.extractions and ocr.validations already do,
-- and, unlike main, only for a job of that facility the session can see: the
-- aggregate's foreign key ignores row-level security, so a row naming another
-- facility's job could otherwise take that job's event key. Every writer
-- (OcrService.appendOutbox and the 0013, 0016 and 0077 job-event triggers)
-- appends events of a job under the job's own facility. Only hid_ocr_runtime
-- holds INSERT on the table; no grant changes. Applied migrations 0001
-- through 0080 are immutable.

create policy ocr_outbox_staff_insert on ocr.outbox_events for insert
  with check (facility_id = platform.current_facility_id()
    and exists (select 1 from ocr.jobs job
                 where job.id = outbox_events.aggregate_id and job.facility_id = outbox_events.facility_id));
