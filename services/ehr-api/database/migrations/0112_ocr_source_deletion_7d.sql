-- 0112 OCR source deletion after 7 days (owner and coordinator decisions
-- of 2026-11-11, relayed by the coordinator; decision (4) reserved 0110,
-- renumbered 0112 as noted there; decision (5) made the window 7 days).
-- The declaration is signed separately (reviewed_by is empty until the
-- owner signs).
--
-- The decisions, as given:
--   (1) "At 24 hours after an OCR job finishes, saved or not, delete the
--       uploaded source file with every S3 version, the Textract text and the
--       AI reading, and the content of the job's working rows. KEEP: what a
--       person saved or published into the record (EHR rows,
--       ehr.ocr_import_provenance), ocr.page_usage and ocr.ai_usage, a
--       deletion audit event (ids and counts only), and job ids and status with
--       the content removed."
--   (2) "The source scan is NOT kept in the chart. Published records keep
--       provenance by job id plus a plain note that the source page was
--       deleted after 24 hours. Do not build 'attach source to chart'."
--   (3) "Content removal, not row deletion: one narrow SECURITY DEFINER purge
--       path. The append-only triggers stay. reviewed_by stays empty; the
--       owner signs separately."
--   (4) "Migration number 0110 is reserved for this." Renumbered 0112 by the
--       coordinator (numbers follow merge order; 0110 went to another change).
--   (5) Q36, 2026-11-11: "make it 7days (signed)". The 24 hours of (1)
--       and (2) are 7 days everywhere below: a document is due 7 days after
--       its latest job finished, and overdue 7 days and 2 hours after.
--   And: "Keep the existing clinical/objects/ key layout. Do NOT change upload
--   keys or malware scanning. The sweeper finds each source by the key stored
--   in ehr.documents."
--
-- It applies after 0110 (staging's 0109 and 0110 touch none of the objects
-- below). It needs: the ehr.documents, ocr.jobs, ocr.extractions,
-- ocr.validations (with 0016's columns), ocr.patient_confirmations and ocr.publications tables; the four
-- trigger functions it replaces exactly as 0004, 0009, 0016 and 0107 left them
-- (md5 pinned in section 0); the session and permission helpers it calls,
-- whose bodies are pinned the same way; and the runtime roles. If a later
-- migration replaces one of the pinned bodies, section 0 stops 0112 with
-- nothing applied and the pins must be renewed against that body.
--
-- What it adds.
-- 1. ehr.documents.status may be 'source_deleting' (claimed by the OCR worker,
--    S3 deletion under way) and 'source_deleted' (documents_status_check
--    re-created with those two values added; every other rule unchanged). The
--    view ehr.documents_effective passes both through unchanged (its CASE maps
--    only uploaded+clean to available and a rejected scan to rejected).
-- 2. A document is due for deletion when: its status is 'uploaded';
--    legal_hold is false; it has at least one OCR job; every one of its jobs
--    is finished (awaiting_validation, validated, rejected, failed or
--    cancelled); and the latest finish (completed_at, failed_at for a failed
--    job, updated_at for a cancelled one, updated_at when the column is empty)
--    is at least 7 days ago. A publication of its jobs that could still run
--    (pending, processing, or failed with a retryable code:
--    OWNING_SERVICE_UNAVAILABLE, REQUEST_IN_PROGRESS, the codes ocr-api
--    retries, and attempts left) blocks until at least 72 hours after the
--    latest finish, and no longer after that (a hard cap). Since 7 days is
--    longer than the 72-hour cap, a publication no longer delays deletion:
--    due_at is latest finish + greatest(7 days, 72 h while blocked), that is
--    + 7 days (greatest keeps the cap's bound should the window ever be
--    shorter). A blocked document is not due, so it is not counted as due or
--    overdue. A document already 'source_deleting' is always
--    listed (first), so a claim whose S3 deletion failed is retried; claimed
--    documents go least recently attempted first and take at most half of a
--    batch while due documents wait (ocr.source_deletion_attempts holds the
--    attempt count and time; ids, counts and times only, no runtime grant).
--    There is no unclaim: a claim that keeps failing stays for an operator,
--    surfaced by the overdue count (ocr-worker README).
--    - ocr.source_deletion_due(document or NULL for all) -> (document_id,
--      facility_id, patient_id, storage_bucket, storage_key, status,
--      job_count, due_at): the shared reckoning (SECURITY INVOKER, granted to
--      no role, called only by the functions below as their owner).
--    - ocr.list_worker_source_deletions(limit 1-500) -> (document_id,
--      facility_id, storage_bucket, storage_key, due_seconds):
--      'source_deleting' documents first, then oldest due first;
--      hid_ocr_worker.
--    - ocr.worker_source_deletion_backlog() -> (due, overdue): documents due
--      or 'source_deleting' now; overdue = those of them due for more than 2
--      hours (7 days and 2 hours after the latest finish), plus documents still 'uploaded' with a job stuck in 'extracted'
--      for more than 24 hours, or in 'queued' or 'processing' for more than
--      48 hours (not a job parked by the page allowance until its reset);
--      those are never deleted, only surfaced to the CloudWatch overdue
--      alarm; hid_ocr_worker.
-- 3. ocr.claim_worker_source_deletion(document, correlation id) -> (outcome,
--    storage_bucket, storage_key); hid_ocr_worker. Under a row lock on the
--    document and its jobs: 'claimed' when the document is due (checked
--    again, legal_hold included), moving it to 'source_deleting' (one audit
--    row ocr.source.deletion_claimed); 'already_claimed' when it is
--    'source_deleting' (a retry); 'already_deleted'; 'not_due' (nothing
--    changed). Only after 'claimed' or 'already_claimed' does the worker
--    delete every S3 version and delete marker of the stored key. From the
--    claim on, the database refuses a new job on the document, a failed ->
--    queued retry of its jobs (ocr.validate_job_write) and every change to
--    the document, legal_hold included, except the purge.
-- 4. ocr.purge_worker_source_document(document, S3 versions deleted 0-100000,
--    correlation id) -> (outcome, extractions, validations, confirmations);
--    hid_ocr_worker. The worker calls it only after the S3 deletion was
--    confirmed. It requires 'source_deleting' ('not_claimed', nothing
--    changed, for any other status but 'source_deleted'), sets the status to
--    'source_deleted' and original_file_name to 'Source page deleted after 7
--    days' (row_version + 1), then blanks:
--    - ocr.extractions: raw_text -> NULL, structured_payload -> '{}';
--    - ocr.validations: validated_payload -> '{}', accepted_fields -> '{}',
--      rejected_fields -> '[]', corrections -> '[]', reason -> 'Content
--      deleted after 7 days';
--    - ocr.patient_confirmations: reason -> 'Content deleted after 7 days',
--      evidence_reference -> NULL;
--    and writes one audit.events row ocr.source.deleted_after_7d (workload
--    actor, resource the document; details: job count, S3 versions deleted
--    (the worker's count across its rounds for the document), rows blanked
--    per table, seconds past due; ids and counts only).
--    Idempotent: for a document already 'source_deleted' it blanks whatever
--    still holds content (none, unless a row was added after the purge),
--    answers 'already_deleted', and writes an audit row only when it blanked
--    something. Kept: job ids and status (ocr.jobs, ocr.job_events,
--    ocr.outbox_events, whose payloads carry ids, status and flags only),
--    extraction provenance, confidence and content hash (versions, models,
--    counts; no text), validation provenance ({source, extractionId}),
--    ocr.publications, ehr.ocr_import_provenance, ocr.page_usage,
--    ocr.ai_usage and every EHR row a person published. ehr.record_versions
--    keeps the document's earlier states, original file name included (it is
--    append-only and is not touched).
-- 5. Narrow replacements of four trigger functions (bodies otherwise as
--    before; owner, ACL and attributes kept):
--    - ocr.reject_immutable_change() (0016; the append-only trigger of
--      ocr.job_events, ocr.extractions, ocr.validations,
--      ocr.patient_confirmations and ehr.ocr_import_provenance) still raises
--      55000 on every DELETE and every UPDATE, except an UPDATE of
--      ocr.extractions, ocr.validations or ocr.patient_confirmations that
--      changes only the content columns listed in 4, to exactly the values
--      listed there, made by the OCR functions' owner (current_user; the
--      trigger function is SECURITY INVOKER, so that is true only inside a
--      SECURITY DEFINER function it owns, never for a runtime role), on a row
--      whose document (extractions.document_id, or the job's document) is
--      already 'source_deleted'. No session setting is consulted. job_events
--      and ehr.ocr_import_provenance get no exception.
--    - ehr.reject_document_object_rebinding() (0009; BEFORE UPDATE on
--      ehr.documents, SECURITY INVOKER) also refuses (55000) every update
--      into, within or out of 'source_deleting' and 'source_deleted' except
--      the two the OCR functions' owner makes: the claim (uploaded ->
--      source_deleting, legal_hold false, nothing else changed) and the purge
--      (source_deleting -> source_deleted with the neutral file name, nothing
--      else changed). So legal_hold cannot be set once a document is claimed.
--    - ehr.capture_record_version() (0004; versioning trigger of every
--      clinical table) refuses an insert with either status; and for those
--      two changes, made in a session whose actor is an active ocr_worker
--      account with a correlation id, bumps row_version and updated_at and
--      writes no ehr.record_versions row (that table requires a staff
--      membership; the audit rows record the changes). Every other call runs
--      the 0004 body unchanged.
--    - ocr.validate_job_write() (0107's body) refuses (55000, 'Source page
--      deleted after 7 days') an insert of a job, and any update to queued
--      or processing, on a document that is 'source_deleting' or
--      'source_deleted'. 0107 lets a failed -> queued retry pass without the
--      document check; this closes it for such documents only. An insert
--      first takes the document row FOR SHARE, so it waits for a claim in
--      flight (FOR UPDATE) and then sees 'source_deleting'; a job inserted
--      first makes the claim, which re-checks after its lock, answer
--      'not_due'. (Retries and claims of existing jobs already serialize on
--      the job rows the deletion claim locks.)
--
-- Accepted: a publication requested near the 72-hour cap may run its attempt
-- after the document was claimed or purged. ocr-api reads the source again
-- for each attempt and answers 410 DOCUMENT_SOURCE_DELETED for both statuses,
-- so the attempt fails terminally before any owning-domain call; a blanked
-- validation could not be published anyway (its empty accepted fields fail
-- the candidate check).
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): the tables present; not applied yet; md5 of
--    pg_proc.prosrc of the four replaced functions, the session helpers,
--    auth.account_id_for_subject and auth.account_has_active_role; the
--    triggers that call the replaced functions; documents_status_check as
--    0004 created it; the role ocr_worker; the runtime roles hid_ocr_worker,
--    where it exists, neither superuser nor BYPASSRLS; ocr.jobs, ehr.documents,
--    the OCR evidence tables and the four replaced functions share one owner,
--    which may create in schema ocr, and the applier is it or a member that
--    inherits it and may SET ROLE to it.
-- 6. Grants are made here too, since a release applies only migrations;
--    runtime-grants.sql gains the same 0112 block for a role bootstrap.
-- 7. Post-checks: the replaced bodies by md5, owners, ACLs and attributes,
--    the new functions' attributes and EXECUTE, and the status constraint.
--
-- Row-level security. Like every OCR worker command, the functions run as
-- the OCR functions' owner. ocr.* rows are read under the facility policies
-- with app.facility_id set to the document's facility for the blanking (as
-- ocr.set_facility_page_limit, 0107); ehr.documents has no policy a workload
-- session satisfies, so under an owner that neither is a superuser nor
-- bypasses row-level security (release checklist P8) the list is empty and
-- the claim and the purge answer P0002 (document not found), exactly as the
-- OCR worker claim then sees no job.
--
-- Locks: ACCESS EXCLUSIVE on ehr.documents for the constraint swap (added NOT
-- VALID, then validated in the same transaction, which reads the table once);
-- no other table lock beyond ACCESS SHARE; CREATE OR REPLACE FUNCTION takes
-- no table lock. Behind a session holding a lock on ehr.documents the runner
-- stops after its lock_timeout with nothing applied.
--
-- Old services on this schema: nothing changes for them until a document is
-- purged; ocr-api, ehr-api and ocr-worker images built before 0112 keep
-- working (they never write either new status). After a purge, the old ehr-api
-- answers a download of the document with its generic 409 and the old ocr-api
-- shows an empty reading.
-- Applied migrations 0001 through 0110 are immutable.

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  ocr_owner oid;
begin
  -- a. Prerequisites.
  if to_regclass('ehr.documents') is null or to_regclass('ocr.jobs') is null
     or to_regclass('ocr.extractions') is null or to_regclass('ocr.validations') is null
     or to_regclass('ocr.patient_confirmations') is null or to_regclass('ocr.publications') is null
     or to_regclass('ehr.ocr_import_provenance') is null or to_regclass('audit.events') is null
     or to_regprocedure('ocr.claim_worker_job_fair(text,integer,integer)') is null then
    raise exception using errcode = '55000', message = '0112: the OCR tables and 0107 must be applied first';
  end if;
  -- b. Not applied yet (nor partly present).
  if to_regprocedure('ocr.source_deletion_due(uuid)') is not null
     or to_regprocedure('ocr.list_worker_source_deletions(integer)') is not null
     or to_regprocedure('ocr.worker_source_deletion_backlog()') is not null
     or to_regprocedure('ocr.purge_worker_source_document(uuid,integer,text)') is not null
     or to_regprocedure('ocr.claim_worker_source_deletion(uuid,text)') is not null
     or to_regclass('ocr.source_deletion_attempts') is not null
     or exists (select 1 from pg_constraint where conrelid = 'ehr.documents'::regclass
                  and conname = 'documents_status_check'
                  and pg_get_constraintdef(oid) like '%source_deleted%') then
    raise exception using errcode = '55000', message = '0112: already applied';
  end if;
  -- c. The bodies replaced and relied on, as 0001-0111 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ocr.reject_immutable_change()', '2c9fc5030a0d8fe67fb83597f4db83e1'),
      ('ehr.reject_document_object_rebinding()', '2b00470189d53a1a0704df4be004ca39'),
      ('ehr.capture_record_version()', '70daa16f05bb3ec28f05292e6358a702'),
      ('ocr.validate_job_write()', '58ff61a5b9b95685f6a6d3f938b8481f'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('auth.account_has_active_role(uuid,text)', 'a3310b48da6ff8bcd3ecb9d7dbef900a'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- Attributes of the replaced functions (kept by CREATE OR REPLACE below).
  if mismatch is null and (select count(*) from pg_proc proc
        join pg_language language_row on language_row.oid = proc.prolang
       where language_row.lanname = 'plpgsql' and proc.provolatile = 'v' and not proc.proisstrict
         and ((proc.oid = 'ocr.validate_job_write()'::regprocedure and proc.prosecdef
               and proc.proconfig = '{"search_path=ocr, ehr, identity, auth, platform, pg_temp"}'::text[])
           or (proc.oid = 'ocr.reject_immutable_change()'::regprocedure and not proc.prosecdef
               and proc.proconfig = '{"search_path=ocr, pg_temp"}'::text[])
           or (proc.oid = 'ehr.reject_document_object_rebinding()'::regprocedure and not proc.prosecdef
               and proc.proconfig = '{"search_path=ehr, pg_temp"}'::text[])
           or (proc.oid = 'ehr.capture_record_version()'::regprocedure and proc.prosecdef
               and proc.proconfig = '{"search_path=ehr, auth, identity, platform, pg_temp"}'::text[]))) <> 4 then
    mismatch := 'attributes of the four replaced trigger functions';
  end if;
  -- The triggers that call them, enabled, as 0004, 0009, 0013 and 0016 created them.
  if mismatch is null and (select count(*) from pg_trigger trigger_row
        where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
          and (trigger_row.tgrelid::regclass::text, trigger_row.tgname, pg_get_triggerdef(trigger_row.oid)) in (
            ('ocr.job_events', 'ocr_job_events_immutable', 'CREATE TRIGGER ocr_job_events_immutable BEFORE DELETE OR UPDATE ON ocr.job_events FOR EACH ROW EXECUTE FUNCTION ocr.reject_immutable_change()'),
            ('ocr.extractions', 'ocr_extractions_immutable', 'CREATE TRIGGER ocr_extractions_immutable BEFORE DELETE OR UPDATE ON ocr.extractions FOR EACH ROW EXECUTE FUNCTION ocr.reject_immutable_change()'),
            ('ocr.validations', 'ocr_validations_immutable', 'CREATE TRIGGER ocr_validations_immutable BEFORE DELETE OR UPDATE ON ocr.validations FOR EACH ROW EXECUTE FUNCTION ocr.reject_immutable_change()'),
            ('ocr.patient_confirmations', 'ocr_patient_confirmations_immutable', 'CREATE TRIGGER ocr_patient_confirmations_immutable BEFORE DELETE OR UPDATE ON ocr.patient_confirmations FOR EACH ROW EXECUTE FUNCTION ocr.reject_immutable_change()'),
            ('ehr.ocr_import_provenance', 'ehr_ocr_import_provenance_immutable', 'CREATE TRIGGER ehr_ocr_import_provenance_immutable BEFORE DELETE OR UPDATE ON ehr.ocr_import_provenance FOR EACH ROW EXECUTE FUNCTION ocr.reject_immutable_change()'),
            ('ehr.documents', 'documents_reject_object_rebinding', 'CREATE TRIGGER documents_reject_object_rebinding BEFORE UPDATE ON ehr.documents FOR EACH ROW EXECUTE FUNCTION ehr.reject_document_object_rebinding()'),
            ('ehr.documents', 'documents_versioned', 'CREATE TRIGGER documents_versioned BEFORE INSERT OR UPDATE ON ehr.documents FOR EACH ROW EXECUTE FUNCTION ehr.capture_record_version()'),
            ('ehr.documents', 'documents_no_delete', 'CREATE TRIGGER documents_no_delete BEFORE DELETE ON ehr.documents FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()'),
            ('ocr.jobs', 'ocr_jobs_validate', 'CREATE TRIGGER ocr_jobs_validate BEFORE INSERT OR UPDATE ON ocr.jobs FOR EACH ROW EXECUTE FUNCTION ocr.validate_job_write()'))) <> 9 then
    mismatch := 'the append-only triggers of the OCR evidence tables, the ehr.documents triggers or ocr_jobs_validate';
  end if;
  -- The trigger function is used by no other trigger than those five.
  if mismatch is null and (select count(*) from pg_trigger
        where tgfoid = 'ocr.reject_immutable_change()'::regprocedure) <> 5 then
    mismatch := 'the triggers that call ocr.reject_immutable_change()';
  end if;
  if mismatch is null and (select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'ehr.documents'::regclass and conname = 'documents_status_check')
       is distinct from 'CHECK ((status = ANY (ARRAY[''initiated''::text, ''uploaded''::text, ''rejected''::text, ''entered_in_error''::text])))' then
    mismatch := 'the constraint documents_status_check';
  end if;
  if mismatch is null and not exists (select 1 from auth.roles where code = 'ocr_worker') then
    mismatch := 'the role ocr_worker';
  end if;
  if mismatch is null and exists (select 1 from pg_roles where rolname = 'hid_ocr_worker'
                                   and (rolsuper or rolbypassrls)) then
    mismatch := 'hid_ocr_worker (superuser or BYPASSRLS)';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0112: an object this migration relies on differs from 0001-0111: %s', mismatch);
  end if;
  -- d. One owner for the tables and functions touched; it may create in schema
  -- ocr; the applier is it, or a member that inherits it and may SET ROLE to it.
  select string_agg(distinct pg_get_userbyid(owner_row.owner_oid), ', ') into mismatch
    from (select proc.proowner as owner_oid from pg_proc proc
           where proc.oid in ('ocr.reject_immutable_change()'::regprocedure,
             'ocr.validate_job_write()'::regprocedure,
             'ehr.reject_document_object_rebinding()'::regprocedure,
             'ehr.capture_record_version()'::regprocedure,
             'ocr.claim_worker_job_fair(text,integer,integer)'::regprocedure)
          union all
          select class_row.relowner from pg_class class_row
           where class_row.oid in ('ocr.jobs'::regclass, 'ehr.documents'::regclass, 'ocr.extractions'::regclass,
             'ocr.validations'::regclass, 'ocr.patient_confirmations'::regclass, 'ocr.publications'::regclass)) owner_row;
  ocr_owner := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
  if mismatch is distinct from pg_get_userbyid(ocr_owner) then
    raise exception using errcode = '55000',
      message = format('0112: ocr.jobs, ehr.documents, the OCR evidence tables and the replaced functions must share one owner (found %s)', mismatch);
  end if;
  if not has_schema_privilege(ocr_owner, 'ocr', 'CREATE') then
    raise exception using errcode = '55000',
      message = format('0112: %s may not create in schema ocr', pg_get_userbyid(ocr_owner));
  end if;
  if applier <> ocr_owner
     and not (pg_has_role(applier, ocr_owner, 'USAGE') and pg_has_role(applier, ocr_owner, 'SET')) then
    raise exception using errcode = '42501',
      message = format('0112: %s is not %s and may not act as it (INHERIT and SET)', current_user,
        pg_get_userbyid(ocr_owner));
  end if;
  raise notice '0112: owners checked: ocr.jobs=%, applier=%', pg_get_userbyid(ocr_owner), current_user;
end;
$$;

-- The ACLs of the replaced trigger functions, for the post-check.
create temporary table ocr_source_deletion_0112_acl on commit drop as
  select proc.oid as function_oid, proc.proowner, proc.proacl, proc.prosecdef, proc.proconfig
    from pg_proc proc
   where proc.oid in ('ocr.reject_immutable_change()'::regprocedure, 'ocr.validate_job_write()'::regprocedure,
     'ehr.reject_document_object_rebinding()'::regprocedure, 'ehr.capture_record_version()'::regprocedure);

-- 1. The status values.
alter table ehr.documents drop constraint documents_status_check;
alter table ehr.documents add constraint documents_status_check check (
  status in ('initiated', 'uploaded', 'rejected', 'entered_in_error', 'source_deleting', 'source_deleted')) not valid;
alter table ehr.documents validate constraint documents_status_check;

-- The claim's attempts (ids, counts and times only): one row per claimed
-- document, its last attempt ordering the retries. Only the 0112 SECURITY
-- DEFINER functions touch it (row-level security forced, the owner's policy
-- only, no runtime grant). No foreign key, so creating it takes no lock on
-- ehr.documents beyond the constraint swap's.
create table ocr.source_deletion_attempts (
  document_id uuid primary key,
  attempts integer not null check (attempts >= 1),
  claimed_at timestamptz not null,
  last_attempt_at timestamptz not null
);
alter table ocr.source_deletion_attempts enable row level security;
alter table ocr.source_deletion_attempts force row level security;
revoke all on ocr.source_deletion_attempts from public;
comment on table ocr.source_deletion_attempts is
  '0112: per claimed document, how many deletion attempts and when the last one was (the retry order of claimed documents). Ids, counts and times only.';

-- 2. Which documents are due (and those already claimed). Granted to no
-- role; the callers below run it as its owner.
create function ocr.source_deletion_due(requested_document_id uuid)
returns table (document_id uuid, facility_id uuid, patient_id uuid, storage_bucket text, storage_key text,
  status text, job_count integer, due_at timestamptz)
language sql stable
set search_path = pg_catalog, ocr, ehr, pg_temp
as $$
  with per_document as (
    select job.document_id,
           count(*)::integer as job_count,
           bool_and(job.status in ('awaiting_validation', 'validated', 'rejected', 'failed', 'cancelled')) as finished,
           max(coalesce(case job.status
                          when 'failed' then job.failed_at
                          when 'cancelled' then job.updated_at
                          else job.completed_at end, job.updated_at)) as finished_at
      from ocr.jobs job
     where requested_document_id is null or job.document_id = requested_document_id
     group by job.document_id
  ), blocking as (
    -- A publication that could still run: pending, processing, or failed with
    -- a code ocr-api retries and attempts left.
    select distinct job.document_id
      from ocr.publications publication join ocr.jobs job on job.id = publication.job_id
     where (publication.status in ('pending', 'processing')
         or (publication.status = 'failed'
           and publication.failure_code in ('OWNING_SERVICE_UNAVAILABLE', 'REQUEST_IN_PROGRESS')
           and publication.attempt_count < publication.max_attempts))
       and (requested_document_id is null or job.document_id = requested_document_id)
  ), reckoned as (
    select per_document.*,
           per_document.finished_at + greatest(interval '7 days',
             case when blocking.document_id is null then interval '0 hours' else interval '72 hours' end) as due_at
      from per_document left join blocking on blocking.document_id = per_document.document_id
  )
  select document.id, document.facility_id, document.patient_id, document.storage_bucket, document.storage_key,
         document.status, reckoned.job_count, reckoned.due_at
    from reckoned
    join ehr.documents document on document.id = reckoned.document_id
   where document.status = 'source_deleting'
      or (document.status = 'uploaded' and not document.legal_hold and reckoned.finished
          and reckoned.due_at <= clock_timestamp())
$$;

-- The worker lists the documents to delete: those already claimed first (a
-- retry), least recently attempted first, but at most half the batch while
-- due documents wait, so a claim whose S3 deletion keeps failing never
-- starves new ones; then the due documents, oldest due first.
create function ocr.list_worker_source_deletions(requested_limit integer)
returns table (document_id uuid, facility_id uuid, storage_bucket text, storage_key text, due_seconds bigint)
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, auth, platform, pg_temp
as $$
declare
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_limit is null or requested_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Invalid OCR source deletion request';
  end if;
  return query
    with due as (
      select due_row.*, attempt.last_attempt_at
        from ocr.source_deletion_due(null) due_row
        left join ocr.source_deletion_attempts attempt on attempt.document_id = due_row.document_id
    ), claimed as (
      select due.*, row_number() over (order by due.last_attempt_at nulls first, due.due_at, due.document_id) as rank
        from due where due.status = 'source_deleting'
    ), fresh as (
      select due.*, row_number() over (order by due.due_at, due.document_id) as rank
        from due where due.status = 'uploaded'
    ), fresh_taken as (
      select * from fresh
       where fresh.rank <= requested_limit - least((select count(*) from claimed), requested_limit / 2)
    ), claimed_taken as (
      select * from claimed where claimed.rank <= requested_limit - (select count(*) from fresh_taken)
    )
    select taken.document_id, taken.facility_id, taken.storage_bucket, taken.storage_key,
           greatest(0, floor(extract(epoch from clock_timestamp() - taken.due_at)))::bigint
      from (select claimed_taken.document_id, claimed_taken.facility_id, claimed_taken.storage_bucket,
                   claimed_taken.storage_key, claimed_taken.due_at, 0 as part, claimed_taken.rank
              from claimed_taken
            union all
            select fresh_taken.document_id, fresh_taken.facility_id, fresh_taken.storage_bucket,
                   fresh_taken.storage_key, fresh_taken.due_at, 1, fresh_taken.rank
              from fresh_taken) taken
     order by taken.part, taken.rank;
end
$$;

-- The worker counts the documents due now (claimed ones included) and those
-- overdue: due for more than 2 hours (7 days and 2 hours after the latest
-- finish), or still uploaded with a job stuck in
-- 'extracted' for more than 24 hours, or in 'queued' or 'processing' for
-- more than 48 hours (a queued job parked by the page allowance until its
-- reset is not stuck); those are counted, never deleted.
create function ocr.worker_source_deletion_backlog()
returns table (due integer, overdue integer)
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, ehr, auth, platform, pg_temp
as $$
declare
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  return query
    select count(*)::integer,
           (count(*) filter (where due_row.due_at < clock_timestamp() - interval '2 hours'))::integer
           + (select count(distinct job.document_id)::integer
                from ocr.jobs job join ehr.documents document on document.id = job.document_id
               where document.status = 'uploaded'
                 and ((job.status = 'extracted'
                       and coalesce(job.completed_at, job.updated_at) < clock_timestamp() - interval '24 hours')
                   or (job.status in ('queued', 'processing')
                       and coalesce(job.started_at, job.queued_at) < clock_timestamp() - interval '48 hours'
                       and not (job.status = 'queued'
                         and job.last_error_code is not distinct from 'OCR_PAGE_ALLOWANCE_USED_UP'
                         and job.next_attempt_at > clock_timestamp()))))
      from ocr.source_deletion_due(null) due_row;
end
$$;

-- 3. The claim, before any S3 call: a due document becomes 'source_deleting'
-- under a row lock, so no job, retry or legal hold can come after the check.
create function ocr.claim_worker_source_deletion(requested_document_id uuid, requested_correlation_id text)
returns table (outcome text, storage_bucket text, storage_key text)
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, ehr, audit, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  document_row record;
  due_job_count integer;
  due_since timestamptz;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_document_id is null or requested_correlation_id is null
     or length(requested_correlation_id) not between 8 and 128 then
    raise exception using errcode = '22023', message = 'Invalid OCR source deletion request';
  end if;
  select document.id, document.facility_id, document.patient_id, document.status, document.storage_bucket,
         document.storage_key
    into document_row from ehr.documents document where document.id = requested_document_id for update;
  if document_row.id is null then
    raise exception using errcode = 'P0002', message = 'Document not found';
  end if;
  -- The jobs, too: a retry or a new state of one waits for this claim, then
  -- finds the document claimed and is refused.
  perform 1 from ocr.jobs job where job.document_id = document_row.id order by job.id for update;
  if document_row.status = 'source_deleting' then
    -- Another attempt at a claim whose S3 deletion has not finished: noted,
    -- so the listing takes the least recently attempted first.
    update ocr.source_deletion_attempts set attempts = attempts + 1, last_attempt_at = clock_timestamp()
     where document_id = document_row.id;
    return query select 'already_claimed'::text, document_row.storage_bucket, document_row.storage_key;
    return;
  end if;
  if document_row.status = 'source_deleted' then
    return query select 'already_deleted'::text, null::text, null::text;
    return;
  end if;
  select due.job_count, due.due_at into due_job_count, due_since
    from ocr.source_deletion_due(document_row.id) due where due.status = 'uploaded';
  if due_job_count is null then
    return query select 'not_due'::text, null::text, null::text;
    return;
  end if;
  update ehr.documents set status = 'source_deleting', row_version = row_version + 1 where id = document_row.id;
  insert into ocr.source_deletion_attempts (document_id, attempts, claimed_at, last_attempt_at)
  values (document_row.id, 1, clock_timestamp(), clock_timestamp());
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
    patient_id, action, outcome, resource_type, resource_id, provenance, details
  ) values (
    requested_correlation_id, 'workload', actor_subject, actor_account,
    document_row.facility_id, document_row.patient_id, 'ocr.source.deletion_claimed', 'success',
    'document', document_row.id::text, 'application',
    jsonb_build_object('jobCount', due_job_count,
      'secondsPastDue', greatest(0, floor(extract(epoch from clock_timestamp() - due_since)))::bigint)
  );
  return query select 'claimed'::text, document_row.storage_bucket, document_row.storage_key;
end
$$;

-- 4. The purge, after the worker deleted every S3 version of the claimed source.
create function ocr.purge_worker_source_document(
  requested_document_id uuid, requested_deleted_versions integer, requested_correlation_id text
) returns table (outcome text, extractions integer, validations integer, confirmations integer)
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, ehr, audit, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  document_row record;
  due_job_count integer;
  due_since timestamptz;
  session_facility text;
  blanked_extractions integer := 0;
  blanked_validations integer := 0;
  blanked_confirmations integer := 0;
  already_deleted boolean;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_document_id is null or requested_deleted_versions is null
     or requested_deleted_versions not between 0 and 100000
     or requested_correlation_id is null or length(requested_correlation_id) not between 8 and 128 then
    raise exception using errcode = '22023', message = 'Invalid OCR source deletion request';
  end if;
  select document.id, document.facility_id, document.patient_id, document.status
    into document_row from ehr.documents document where document.id = requested_document_id for update;
  if document_row.id is null then
    raise exception using errcode = 'P0002', message = 'Document not found';
  end if;
  perform 1 from ocr.jobs job where job.document_id = document_row.id order by job.id for update;
  already_deleted := document_row.status = 'source_deleted';
  if not already_deleted then
    -- Only a document this worker claimed (the S3 deletion ran under the claim).
    if document_row.status is distinct from 'source_deleting' then
      return query select 'not_claimed'::text, 0, 0, 0;
      return;
    end if;
    select due.job_count, due.due_at into due_job_count, due_since
      from ocr.source_deletion_due(document_row.id) due;
    update ehr.documents set status = 'source_deleted', original_file_name = 'Source page deleted after 7 days',
      row_version = row_version + 1
     where id = document_row.id;
  end if;
  -- The OCR rows are read under their facility policies: name the document's
  -- facility for the blanking and restore the session afterwards.
  session_facility := current_setting('app.facility_id', true);
  perform set_config('app.facility_id', document_row.facility_id::text, true);
  update ocr.extractions extraction set raw_text = null, structured_payload = '{}'::jsonb
   where extraction.document_id = document_row.id
     and (extraction.raw_text is not null or extraction.structured_payload <> '{}'::jsonb);
  get diagnostics blanked_extractions = row_count;
  update ocr.validations validation set validated_payload = '{}'::jsonb, accepted_fields = '{}'::jsonb,
         rejected_fields = '[]'::jsonb, corrections = '[]'::jsonb, reason = 'Content deleted after 7 days'
    from ocr.jobs job
   where job.id = validation.job_id and job.document_id = document_row.id
     and (validation.validated_payload <> '{}'::jsonb or validation.accepted_fields <> '{}'::jsonb
       or validation.rejected_fields <> '[]'::jsonb or validation.corrections <> '[]'::jsonb
       or validation.reason <> 'Content deleted after 7 days');
  get diagnostics blanked_validations = row_count;
  update ocr.patient_confirmations confirmation set reason = 'Content deleted after 7 days', evidence_reference = null
    from ocr.jobs job
   where job.id = confirmation.job_id and job.document_id = document_row.id
     and (confirmation.reason <> 'Content deleted after 7 days' or confirmation.evidence_reference is not null);
  get diagnostics blanked_confirmations = row_count;
  perform set_config('app.facility_id', coalesce(session_facility, ''), true);
  if not already_deleted or blanked_extractions + blanked_validations + blanked_confirmations > 0 then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
      patient_id, action, outcome, resource_type, resource_id, provenance, details
    ) values (
      requested_correlation_id, 'workload', actor_subject, actor_account,
      document_row.facility_id, document_row.patient_id, 'ocr.source.deleted_after_7d', 'success',
      'document', document_row.id::text, 'application',
      jsonb_build_object('jobCount', coalesce(due_job_count,
          (select count(*)::integer from ocr.jobs job where job.document_id = document_row.id)),
        'objectVersionsDeleted', requested_deleted_versions,
        'extractionsBlanked', blanked_extractions, 'validationsBlanked', blanked_validations,
        'confirmationsBlanked', blanked_confirmations, 'alreadyDeleted', already_deleted,
        'secondsPastDue', case when due_since is null then null
          else greatest(0, floor(extract(epoch from clock_timestamp() - due_since)))::bigint end)
    );
  end if;
  return query select case when already_deleted then 'already_deleted' else 'deleted' end,
    blanked_extractions, blanked_validations, blanked_confirmations;
end
$$;

-- 5. The append-only trigger (0016's body) with one exception: the purge's
-- blanking, by the OCR functions' owner, of a row whose document is already
-- 'source_deleted', changing only the content columns to exactly the purge
-- values.
create or replace function ocr.reject_immutable_change()
returns trigger language plpgsql set search_path = ocr, pg_temp as $$
declare
  purged jsonb;
  old_state jsonb;
  new_state jsonb;
  content_columns text[];
  source_status text;
begin
  if tg_op = 'UPDATE' and tg_table_schema = 'ocr'
     and tg_table_name in ('extractions', 'validations', 'patient_confirmations')
     and current_user = (select pg_catalog.pg_get_userbyid(class_row.relowner) from pg_catalog.pg_class class_row
                          where class_row.oid = 'ocr.jobs'::pg_catalog.regclass) then
    purged := case tg_table_name
      when 'extractions' then pg_catalog.jsonb_build_object('raw_text', null, 'structured_payload', '{}'::jsonb)
      when 'validations' then pg_catalog.jsonb_build_object('validated_payload', '{}'::jsonb,
        'accepted_fields', '{}'::jsonb, 'rejected_fields', '[]'::jsonb, 'corrections', '[]'::jsonb,
        'reason', 'Content deleted after 7 days')
      else pg_catalog.jsonb_build_object('reason', 'Content deleted after 7 days', 'evidence_reference', null) end;
    content_columns := array(select pg_catalog.jsonb_object_keys(purged));
    old_state := pg_catalog.to_jsonb(old);
    new_state := pg_catalog.to_jsonb(new);
    if (new_state - content_columns) = (old_state - content_columns)
       and (select pg_catalog.jsonb_object_agg(column_name, new_state -> column_name)
              from pg_catalog.unnest(content_columns) column_name) = purged then
      select document.status into source_status from ehr.documents document
       where document.id = case when tg_table_name = 'extractions' then (new_state ->> 'document_id')::uuid
                                else (select job.document_id from ocr.jobs job
                                       where job.id = (new_state ->> 'job_id')::uuid) end;
      if source_status = 'source_deleted' then
        return new;
      end if;
    end if;
  end if;
  raise exception using errcode = '55000', message = 'OCR evidence is append-only';
end
$$;

-- The document object guard (0009's body), plus: a document claimed for
-- deletion or deleted changes only by the OCR functions' owner's two exact
-- steps (the claim, then the purge); nothing else, legal_hold included.
create or replace function ehr.reject_document_object_rebinding()
returns trigger
language plpgsql
set search_path = ehr, pg_temp
as $$
begin
  if old.storage_bucket is distinct from new.storage_bucket
     or old.storage_key is distinct from new.storage_key
     or old.declared_media_type is distinct from new.declared_media_type
     or old.size_bytes is distinct from new.size_bytes
     or old.sha256_hex is distinct from new.sha256_hex
     or (old.object_version_id is not null
       and old.object_version_id is distinct from new.object_version_id) then
    raise exception using errcode = '55000', message = 'Document object identity and declared integrity metadata are immutable';
  end if;
  if (old.status in ('source_deleting', 'source_deleted') or new.status in ('source_deleting', 'source_deleted'))
     and not (current_user = (select pg_catalog.pg_get_userbyid(class_row.relowner) from pg_catalog.pg_class class_row
                               where class_row.oid = 'ocr.jobs'::pg_catalog.regclass)
       and ((old.status = 'uploaded' and not old.legal_hold and new.status = 'source_deleting'
             and (pg_catalog.to_jsonb(new) - array['status', 'row_version', 'updated_at'])
               = (pg_catalog.to_jsonb(old) - array['status', 'row_version', 'updated_at']))
         or (old.status = 'source_deleting' and new.status = 'source_deleted'
             and new.original_file_name = 'Source page deleted after 7 days'
             and (pg_catalog.to_jsonb(new) - array['status', 'original_file_name', 'row_version', 'updated_at'])
               = (pg_catalog.to_jsonb(old) - array['status', 'original_file_name', 'row_version', 'updated_at'])))) then
    raise exception using errcode = '55000',
      message = 'The document''s source is being or has been deleted after 7 days; it cannot be changed or put on legal hold';
  end if;
  return new;
end;
$$;

-- The clinical versioning trigger (0004's body), plus the purge's change to
-- ehr.documents, which has no staff membership to version it under.
create or replace function ehr.capture_record_version()
returns trigger
language plpgsql
security definer
set search_path = ehr, auth, identity, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  correlation text := platform.current_correlation_id();
  membership_id uuid := platform.current_membership_id();
  facility uuid;
  patient uuid;
  creator uuid;
  resource text;
  reason text;
  old_state jsonb;
  new_state jsonb;
begin
  if tg_table_schema = 'ehr' and tg_table_name = 'documents'
     and to_jsonb(new)->>'status' in ('source_deleting', 'source_deleted') then
    if tg_op <> 'UPDATE' or actor_account_id is null or correlation is null
       or not auth.account_has_active_role(actor_account_id, 'ocr_worker')
       or not ((to_jsonb(old)->>'status' = 'uploaded' and to_jsonb(new)->>'status' = 'source_deleting'
                and (to_jsonb(new) - array['status', 'row_version', 'updated_at'])
                  = (to_jsonb(old) - array['status', 'row_version', 'updated_at']))
            or (to_jsonb(old)->>'status' = 'source_deleting' and to_jsonb(new)->>'status' = 'source_deleted'
                and to_jsonb(new)->>'original_file_name' = 'Source page deleted after 7 days'
                and (to_jsonb(new) - array['status', 'original_file_name', 'row_version', 'updated_at'])
                  = (to_jsonb(old) - array['status', 'original_file_name', 'row_version', 'updated_at']))) then
      raise exception using errcode = '55000', message = 'Only the OCR source deletion may claim or delete a document source';
    end if;
    new.row_version := old.row_version + 1;
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if actor_subject is null or actor_account_id is null or correlation is null or membership_id is null then
    raise exception using errcode = '42501', message = 'Verified actor, membership, and correlation context are required';
  end if;

  facility := (to_jsonb(new)->>'facility_id')::uuid;
  patient := (to_jsonb(new)->>'patient_id')::uuid;
  creator := (to_jsonb(new)->>'created_by')::uuid;
  resource := to_jsonb(new)->>'id';

  if not identity.has_active_membership(actor_subject, membership_id, facility) then
    raise exception using errcode = '42501', message = 'Active facility membership is required';
  end if;

  if tg_op = 'INSERT' then
    if creator <> actor_account_id then
      raise exception using errcode = '42501', message = 'created_by must match the authenticated account';
    end if;
    if (to_jsonb(new)->>'created_by_membership_id')::uuid <> membership_id then
      raise exception using errcode = '42501', message = 'created_by membership must match the selected membership';
    end if;
    new.row_version := 1;
    new.updated_at := clock_timestamp();
    reason := 'create';
    old_state := null;
  else
    old_state := to_jsonb(old);
    if old_state->>'id' is distinct from resource
       or old_state->>'patient_id' is distinct from patient::text
       or old_state->>'facility_id' is distinct from facility::text
       or old_state->>'created_by' is distinct from creator::text
       or old_state->>'created_by_membership_id' is distinct from to_jsonb(new)->>'created_by_membership_id' then
      raise exception using errcode = '55000', message = 'Clinical ownership and attribution fields are immutable';
    end if;
    reason := nullif(current_setting('app.change_reason', true), '');
    if reason is null or length(btrim(reason)) < 3 then
      raise exception using errcode = '22023', message = 'A change reason is required for clinical updates';
    end if;
    new.row_version := old.row_version + 1;
    new.updated_at := clock_timestamp();
  end if;

  new_state := to_jsonb(new);
  insert into ehr.record_versions (
    resource_type,
    resource_id,
    version_no,
    operation,
    patient_id,
    facility_id,
    changed_by,
    changed_by_membership_id,
    actor_subject,
    correlation_id,
    change_reason,
    prior_state,
    resulting_state,
    content_sha256
  ) values (
    tg_table_name,
    resource,
    new.row_version,
    case when tg_op = 'INSERT' then 'create' else 'update' end,
    patient,
    facility,
    actor_account_id,
    membership_id,
    actor_subject,
    correlation,
    reason,
    old_state,
    new_state,
    encode(public.digest(new_state::text, 'sha256'), 'hex')
  );

  return new;
end;
$$;

-- The OCR job trigger (0107's body), plus: on a document claimed for
-- deletion or deleted, no job is created and none goes back to queued or on
-- to processing.
create or replace function ocr.validate_job_write()
returns trigger language plpgsql security definer
set search_path = ocr, ehr, identity, auth, platform, pg_temp as $$
declare document_row record; latest_scan record; scan_found boolean; binds_source boolean;
  leaves_play boolean;
begin
  -- 0112: a new job waits for a deletion claim in flight on its document (the
  -- claim holds the row FOR UPDATE) and then reads the status it left.
  if tg_op = 'INSERT' then
    perform 1 from ehr.documents document where document.id = new.document_id for share;
  end if;
  select document.id, document.patient_id, document.facility_id, document.object_version_id,
         document.sha256_hex, document.status into document_row
    from ehr.documents document where document.id = new.document_id;
  select scan.event_type, scan.object_version_id, scan.object_sha256_hex,
         scan.binding_migration_hold_reason into latest_scan
    from ehr.document_scan_events scan where scan.document_id = new.document_id
   order by scan.created_at desc, scan.id desc limit 1;
  scan_found := found;
  -- 0112: no job, retry or new reading once the source is claimed for
  -- deletion or deleted (0107 lets failed -> queued pass without the
  -- document check below).
  if document_row.status in ('source_deleting', 'source_deleted')
     and (tg_op = 'INSERT' or new.status in ('queued', 'processing')) then
    raise exception using errcode = '55000', message = 'Source page deleted after 7 days';
  end if;
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
          = (to_jsonb(old) - array['claim_expires_at', 'row_version', 'updated_at']))
      or (old.status = 'queued' and new.status = 'queued'
        and old.last_error_code is not distinct from 'OCR_PAGE_ALLOWANCE_USED_UP'
        and new.next_attempt_at < old.next_attempt_at
        and new.next_attempt_at >= clock_timestamp() - interval '1 minute'
        and (to_jsonb(new) - array['next_attempt_at', 'correlation_id', 'row_version', 'updated_at'])
          = (to_jsonb(old) - array['next_attempt_at', 'correlation_id', 'row_version', 'updated_at']))) then
      raise exception using errcode = '23514', message = 'Invalid OCR job state transition';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end
$$;

-- Owner, ACLs. New functions belong to the OCR functions' owner (the
-- applier, or the owner it acts as).
do $$
declare
  ocr_owner name := (select pg_get_userbyid(relowner) from pg_class where oid = 'ocr.jobs'::regclass);
begin
  if ocr_owner <> current_user then
    execute format('alter function ocr.source_deletion_due(uuid) owner to %I', ocr_owner);
    execute format('alter function ocr.list_worker_source_deletions(integer) owner to %I', ocr_owner);
    execute format('alter function ocr.worker_source_deletion_backlog() owner to %I', ocr_owner);
    execute format('alter function ocr.claim_worker_source_deletion(uuid,text) owner to %I', ocr_owner);
    execute format('alter function ocr.purge_worker_source_document(uuid,integer,text) owner to %I', ocr_owner);
    execute format('alter table ocr.source_deletion_attempts owner to %I', ocr_owner);
  end if;
  execute format('create policy source_deletion_attempts_owner on ocr.source_deletion_attempts for all '
    || 'using (current_user = %L) with check (current_user = %L)', ocr_owner, ocr_owner);
end
$$;

revoke all on function ocr.source_deletion_due(uuid),
  ocr.list_worker_source_deletions(integer),
  ocr.worker_source_deletion_backlog(),
  ocr.claim_worker_source_deletion(uuid,text),
  ocr.purge_worker_source_document(uuid,integer,text) from public;

comment on function ocr.source_deletion_due(uuid) is
  '0112: documents due for deletion of their OCR source (status uploaded, no legal hold, every job finished at least 7 days ago; a publication that could still run blocks only until 72 hours after, so no longer delays it), and those already source_deleting, with due_at. Granted to no role.';
comment on function ocr.list_worker_source_deletions(integer) is
  '0112: the OCR worker lists documents to delete (ids, bucket, key, seconds past due): source_deleting first, then oldest due first.';
comment on function ocr.worker_source_deletion_backlog() is
  '0112: the OCR worker counts documents due for source deletion now, and the overdue ones (due for more than 2 hours, that is 7 days and 2 hours after the latest finish, or a job stuck in extracted for more than 24 hours).';
comment on function ocr.claim_worker_source_deletion(uuid,text) is
  '0112: the OCR worker claims a due document (status source_deleting, under a row lock) before deleting its S3 versions; from then no job, retry or legal hold.';
comment on function ocr.purge_worker_source_document(uuid,integer,text) is
  '0112: after the OCR worker deleted every S3 version of a claimed (source_deleting) document, marks it source_deleted and blanks the reading and review content of its OCR rows (owner decisions of 2026-11-11). Idempotent.';

-- 6. Grants (the same in runtime-grants.sql's 0112 block). A release applies
-- only migrations, so the role that already exists gets them here; on a
-- fresh database the role bootstrap makes them.
do $$
declare
  wanted record;
begin
  for wanted in
    select * from (values
      ('hid_ocr_worker', 'usage on schema ocr'),
      ('hid_ocr_worker', 'execute on function ocr.list_worker_source_deletions(integer), '
        || 'ocr.worker_source_deletion_backlog(), ocr.claim_worker_source_deletion(uuid,text), '
        || 'ocr.purge_worker_source_document(uuid,integer,text)'))
      grant_row(grantee, privilege)
     where exists (select 1 from pg_roles where rolname = grant_row.grantee)
  loop
    execute format('grant %s to %I', wanted.privilege, wanted.grantee);
  end loop;
end
$$;

-- 7. Post-checks.
do $$
declare
  mismatch text;
  ocr_owner oid := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
begin
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ocr.reject_immutable_change()', '2240da0545eb5125b39d460d23b5e382'),
      ('ehr.reject_document_object_rebinding()', 'fe673d974c34460a6b64764117a82fc7'),
      ('ehr.capture_record_version()', 'cae99883d00e70ab1d20ed6fbc97ad7b'),
      ('ocr.validate_job_write()', '116078d43e2de6861388f51036224226'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then mismatch := 'the bodies of ' || mismatch; end if;
  if mismatch is null and exists (
       select 1 from ocr_source_deletion_0112_acl before_row
         left join pg_proc proc on proc.oid = before_row.function_oid
        where proc.oid is null or proc.proowner <> before_row.proowner
           or proc.proacl::text is distinct from before_row.proacl::text
           or proc.prosecdef <> before_row.prosecdef or proc.provolatile <> 'v'
           or proc.proconfig is distinct from before_row.proconfig) then
    mismatch := 'the owner, ACL or attributes of a replaced trigger function';
  end if;
  if mismatch is null then
    select string_agg(proc.oid::regprocedure::text, ', ') into mismatch
      from pg_proc proc
     where proc.oid in ('ocr.list_worker_source_deletions(integer)'::regprocedure,
         'ocr.worker_source_deletion_backlog()'::regprocedure,
         'ocr.claim_worker_source_deletion(uuid,text)'::regprocedure,
         'ocr.purge_worker_source_document(uuid,integer,text)'::regprocedure)
       and (not proc.prosecdef or proc.proowner <> ocr_owner or proc.proconfig is null
            or proc.proconfig[1] not like 'search_path=pg_catalog, ocr, %');
    if mismatch is not null then mismatch := 'attributes of ' || mismatch; end if;
  end if;
  if mismatch is null and exists (
       select 1 from pg_proc proc where proc.oid = 'ocr.source_deletion_due(uuid)'::regprocedure
          and (proc.prosecdef or proc.proowner <> ocr_owner)) then
    mismatch := 'attributes of ocr.source_deletion_due(uuid)';
  end if;
  if mismatch is null then
    select string_agg(format('%s to %s', proc.oid::regprocedure, coalesce(grantee.rolname, 'PUBLIC')), '; ')
      into mismatch
      from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
      left join pg_roles grantee on grantee.oid = privilege.grantee
     where proc.pronamespace = 'ocr'::regnamespace
       and proc.proname in ('source_deletion_due', 'list_worker_source_deletions',
         'worker_source_deletion_backlog', 'claim_worker_source_deletion', 'purge_worker_source_document')
       and privilege.grantee <> proc.proowner
       and (proc.proname, coalesce(grantee.rolname, 'PUBLIC')) not in (
         ('list_worker_source_deletions', 'hid_ocr_worker'), ('worker_source_deletion_backlog', 'hid_ocr_worker'),
         ('claim_worker_source_deletion', 'hid_ocr_worker'), ('purge_worker_source_document', 'hid_ocr_worker'));
    if mismatch is not null then mismatch := 'unexpected EXECUTE: ' || mismatch; end if;
  end if;
  if mismatch is null and not exists (
       select 1 from pg_constraint where conrelid = 'ehr.documents'::regclass
          and conname = 'documents_status_check' and convalidated
          and pg_get_constraintdef(oid) = 'CHECK ((status = ANY (ARRAY[''initiated''::text, ''uploaded''::text, ''rejected''::text, ''entered_in_error''::text, ''source_deleting''::text, ''source_deleted''::text])))') then
    mismatch := 'the constraint documents_status_check';
  end if;
  if mismatch is null and not exists (
       select 1 from pg_class class_row
        where class_row.oid = 'ocr.source_deletion_attempts'::regclass and class_row.relowner = ocr_owner
          and class_row.relrowsecurity and class_row.relforcerowsecurity
          and (select count(*) from pg_policy policy_row where policy_row.polrelid = class_row.oid) = 1
          and not exists (select 1 from aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) privilege
                           where privilege.grantee <> class_row.relowner)) then
    mismatch := 'the owner, row-level security, policy or ACL of ocr.source_deletion_attempts';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0112: post-check failed: %s', mismatch);
  end if;
end;
$$;
