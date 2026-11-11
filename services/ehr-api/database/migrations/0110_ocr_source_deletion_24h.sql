-- 0110 OCR source deletion after 24 hours (owner and coordinator decisions
-- of 2026-11-11, relayed by the coordinator; number 0110 reserved for it by
-- decision (4)). The declaration is signed separately (reviewed_by is empty
-- until the owner signs).
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
--   (4) "Migration number 0110 is reserved for this."
--   And: "Keep the existing clinical/objects/ key layout. Do NOT change upload
--   keys or malware scanning. The sweeper finds each source by the key stored
--   in ehr.documents."
--
-- It applies after 0108 (0109 is not part of this change). It needs: the
-- ehr.documents, ocr.jobs, ocr.extractions, ocr.validations (with 0016's
-- columns), ocr.patient_confirmations and ocr.publications tables; the three
-- trigger functions it replaces exactly as 0004, 0009 and 0016 left them (md5
-- pinned in section 0); the session and permission helpers it calls, whose
-- bodies are pinned the same way; and the runtime roles. If a later migration
-- replaces one of the pinned bodies, section 0 stops 0110 with nothing
-- applied and the pins must be renewed against that body.
--
-- What it adds.
-- 1. ehr.documents.status may be 'source_deleted' (documents_status_check
--    re-created with that one value added; every other rule unchanged). The
--    view ehr.documents_effective passes it through unchanged (its CASE maps
--    only uploaded+clean to available and a rejected scan to rejected).
-- 2. A document is due for deletion when: it has at least one OCR job; every
--    one of its jobs is finished (awaiting_validation, validated, rejected,
--    failed or cancelled); the latest finish (completed_at, failed_at for a
--    failed job, updated_at for a cancelled one, updated_at when the column
--    is empty) is at least 24 hours ago; no publication of its jobs is
--    pending or processing, except one requested more than 24 hours ago (a
--    stuck publication delays deletion by at most a further 24 hours);
--    legal_hold is false; and its status is 'uploaded'. due_at is the later
--    of latest finish + 24 h and the latest blocking publication's
--    requested_at + 24 h.
--    - ocr.source_deletion_due(document or NULL for all) -> (document_id,
--      facility_id, patient_id, storage_bucket, storage_key, job_count,
--      due_at): the shared reckoning (SECURITY INVOKER, granted to no role,
--      called only by the functions below as their owner).
--    - ocr.list_worker_source_deletions(limit 1-500) -> (document_id,
--      facility_id, storage_bucket, storage_key, due_seconds), oldest due
--      first; hid_ocr_worker.
--    - ocr.worker_source_deletion_backlog() -> (due, overdue): documents due
--      now, and those due for more than 2 hours (the CloudWatch overdue alarm);
--      hid_ocr_worker.
-- 3. ocr.purge_worker_source_document(document, S3 versions deleted 0-100000,
--    correlation id) -> (outcome, extractions, validations, confirmations);
--    hid_ocr_worker. The worker calls it only after it deleted every S3
--    version and delete marker of the document's storage key and confirmed
--    none remain. Under a row lock on the document and its jobs it checks
--    again that the document is due ('not_due', nothing changed, otherwise),
--    sets the document's status to 'source_deleted' and original_file_name to
--    'Source page deleted after 24 hours' (row_version + 1), then blanks:
--    - ocr.extractions: raw_text -> NULL, structured_payload -> '{}';
--    - ocr.validations: validated_payload -> '{}', accepted_fields -> '{}',
--      rejected_fields -> '[]', corrections -> '[]', reason -> 'Content
--      deleted after 24 hours';
--    - ocr.patient_confirmations: reason -> 'Content deleted after 24 hours',
--      evidence_reference -> NULL;
--    and writes one audit.events row ocr.source.deleted_after_24h (workload
--    actor, resource the document; details: job count, S3 versions deleted,
--    rows blanked per table, seconds past due; ids and counts only).
--    Idempotent: for a document already 'source_deleted' it blanks whatever
--    still holds content (none, unless a row was added after the purge),
--    answers 'already_deleted', and writes an audit row only when it blanked
--    something. Kept: job ids and status (ocr.jobs, ocr.job_events,
--    ocr.outbox_events, whose payloads carry ids, status and flags only),
--    extraction provenance, confidence and content hash (versions, models,
--    counts; no text), validation provenance ({source, extractionId}),
--    ocr.publications, ehr.ocr_import_provenance, ocr.page_usage,
--    ocr.ai_usage and every EHR row a person published.
-- 4. Narrow replacements of three trigger functions (bodies otherwise as
--    before; owner, ACL and attributes kept):
--    - ocr.reject_immutable_change() (0016; the append-only trigger of
--      ocr.job_events, ocr.extractions, ocr.validations,
--      ocr.patient_confirmations and ehr.ocr_import_provenance) still raises
--      55000 on every DELETE and every UPDATE, except an UPDATE of
--      ocr.extractions, ocr.validations or ocr.patient_confirmations that
--      changes only the content columns listed in 3, to exactly the values
--      listed there, made by the OCR functions' owner (current_user; the
--      trigger function is SECURITY INVOKER, so that is true only inside a
--      SECURITY DEFINER function it owns, never for a runtime role), on a row
--      whose document (extractions.document_id, or the job's document) is
--      already 'source_deleted'. No session setting is consulted. job_events
--      and ehr.ocr_import_provenance get no exception.
--    - ehr.reject_document_object_rebinding() (0009; BEFORE UPDATE on
--      ehr.documents, SECURITY INVOKER) also refuses (55000) any update of a
--      document that is 'source_deleted', and a change to 'source_deleted'
--      unless it is made by the OCR functions' owner from 'uploaded', with
--      legal_hold false, original_file_name set to the neutral value, and no
--      other column but row_version and updated_at changed.
--    - ehr.capture_record_version() (0004; versioning trigger of every
--      clinical table) refuses an insert with status 'source_deleted'; and for
--      the purge's own change to ehr.documents (status uploaded ->
--      source_deleted, the neutral file name, nothing else) made in a session
--      whose actor is an active ocr_worker account with a correlation id, it
--      bumps row_version and updated_at and writes no ehr.record_versions row
--      (that table requires a staff membership; the audit row above records
--      the change). Every other call runs the 0004 body unchanged.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): the tables present; not applied yet; md5 of
--    pg_proc.prosrc of the three replaced functions, the session helpers,
--    auth.account_id_for_subject, auth.account_has_active_role and
--    ocr.validate_job_write (0107's body: the purge relies on it refusing a
--    job's later state change on a document that is not 'uploaded'); the
--    triggers that call the replaced functions; documents_status_check as
--    0004 created it; the role ocr_worker; the runtime roles hid_ocr_worker,
--    where it exists, neither superuser nor BYPASSRLS; ocr.jobs, ehr.documents,
--    the OCR evidence tables and the three replaced functions share one owner,
--    which may create in schema ocr, and the applier is it or a member that
--    inherits it and may SET ROLE to it.
-- 5. Grants are made here too, since a release applies only migrations;
--    runtime-grants.sql gains the same 0110 block for a role bootstrap.
-- 6. Post-checks: the replaced bodies by md5, owners, ACLs and attributes,
--    the new functions' attributes and EXECUTE, and the status constraint.
--
-- Row-level security. Like every OCR worker command, the functions run as
-- the OCR functions' owner. ocr.* rows are read under the facility policies
-- with app.facility_id set to the document's facility for the blanking (as
-- ocr.set_facility_page_limit, 0107); ehr.documents has no policy a workload
-- session satisfies, so under an owner that neither is a superuser nor
-- bypasses row-level security (release checklist P8) the list is empty and
-- the purge answers 'not_found' (P0002), exactly as the OCR worker claim then
-- sees no job.
--
-- Locks: ACCESS EXCLUSIVE on ehr.documents for the constraint swap (added NOT
-- VALID, then validated in the same transaction, which reads the table once);
-- no other table lock beyond ACCESS SHARE; CREATE OR REPLACE FUNCTION takes
-- no table lock. Behind a session holding a lock on ehr.documents the runner
-- stops after its lock_timeout with nothing applied.
--
-- Old services on this schema: nothing changes for them until a document is
-- purged; ocr-api, ehr-api and ocr-worker images built before 0110 keep
-- working (they never write 'source_deleted'). After a purge, the old ehr-api
-- answers a download of the document with its generic 409 and the old ocr-api
-- shows an empty reading.
-- Applied migrations 0001 through 0108 are immutable.

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
    raise exception using errcode = '55000', message = '0110: the OCR tables and 0107 must be applied first';
  end if;
  -- b. Not applied yet (nor partly present).
  if to_regprocedure('ocr.source_deletion_due(uuid)') is not null
     or to_regprocedure('ocr.list_worker_source_deletions(integer)') is not null
     or to_regprocedure('ocr.worker_source_deletion_backlog()') is not null
     or to_regprocedure('ocr.purge_worker_source_document(uuid,integer,text)') is not null
     or exists (select 1 from pg_constraint where conrelid = 'ehr.documents'::regclass
                  and conname = 'documents_status_check'
                  and pg_get_constraintdef(oid) like '%source_deleted%') then
    raise exception using errcode = '55000', message = '0110: already applied';
  end if;
  -- c. The bodies replaced and relied on, as 0001-0108 left them.
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
         and ((proc.oid = 'ocr.reject_immutable_change()'::regprocedure and not proc.prosecdef
               and proc.proconfig = '{"search_path=ocr, pg_temp"}'::text[])
           or (proc.oid = 'ehr.reject_document_object_rebinding()'::regprocedure and not proc.prosecdef
               and proc.proconfig = '{"search_path=ehr, pg_temp"}'::text[])
           or (proc.oid = 'ehr.capture_record_version()'::regprocedure and proc.prosecdef
               and proc.proconfig = '{"search_path=ehr, auth, identity, platform, pg_temp"}'::text[]))) <> 3 then
    mismatch := 'attributes of the three replaced trigger functions';
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
            ('ehr.documents', 'documents_no_delete', 'CREATE TRIGGER documents_no_delete BEFORE DELETE ON ehr.documents FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()'))) <> 8 then
    mismatch := 'the append-only triggers of the OCR evidence tables or the ehr.documents triggers';
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
      message = format('0110: an object this migration relies on differs from 0001-0108: %s', mismatch);
  end if;
  -- d. One owner for the tables and functions touched; it may create in schema
  -- ocr; the applier is it, or a member that inherits it and may SET ROLE to it.
  select string_agg(distinct pg_get_userbyid(owner_row.owner_oid), ', ') into mismatch
    from (select proc.proowner as owner_oid from pg_proc proc
           where proc.oid in ('ocr.reject_immutable_change()'::regprocedure,
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
      message = format('0110: ocr.jobs, ehr.documents, the OCR evidence tables and the replaced functions must share one owner (found %s)', mismatch);
  end if;
  if not has_schema_privilege(ocr_owner, 'ocr', 'CREATE') then
    raise exception using errcode = '55000',
      message = format('0110: %s may not create in schema ocr', pg_get_userbyid(ocr_owner));
  end if;
  if applier <> ocr_owner
     and not (pg_has_role(applier, ocr_owner, 'USAGE') and pg_has_role(applier, ocr_owner, 'SET')) then
    raise exception using errcode = '42501',
      message = format('0110: %s is not %s and may not act as it (INHERIT and SET)', current_user,
        pg_get_userbyid(ocr_owner));
  end if;
  raise notice '0110: owners checked: ocr.jobs=%, applier=%', pg_get_userbyid(ocr_owner), current_user;
end;
$$;

-- The ACLs of the replaced trigger functions, for the post-check.
create temporary table ocr_source_deletion_0110_acl on commit drop as
  select proc.oid as function_oid, proc.proowner, proc.proacl, proc.prosecdef, proc.proconfig
    from pg_proc proc
   where proc.oid in ('ocr.reject_immutable_change()'::regprocedure,
     'ehr.reject_document_object_rebinding()'::regprocedure, 'ehr.capture_record_version()'::regprocedure);

-- 1. The status value.
alter table ehr.documents drop constraint documents_status_check;
alter table ehr.documents add constraint documents_status_check check (
  status in ('initiated', 'uploaded', 'rejected', 'entered_in_error', 'source_deleted')) not valid;
alter table ehr.documents validate constraint documents_status_check;

-- 2. Which documents are due. Granted to no role; the callers below run it
-- as its owner.
create function ocr.source_deletion_due(requested_document_id uuid)
returns table (document_id uuid, facility_id uuid, patient_id uuid, storage_bucket text, storage_key text,
  job_count integer, due_at timestamptz)
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
    select job.document_id, max(publication.requested_at) as requested_at
      from ocr.publications publication join ocr.jobs job on job.id = publication.job_id
     where publication.status in ('pending', 'processing')
       and (requested_document_id is null or job.document_id = requested_document_id)
     group by job.document_id
  )
  select document.id, document.facility_id, document.patient_id, document.storage_bucket, document.storage_key,
         per_document.job_count,
         greatest(per_document.finished_at + interval '24 hours',
                  coalesce(blocking.requested_at + interval '24 hours', '-infinity'::timestamptz))
    from per_document
    join ehr.documents document on document.id = per_document.document_id
    left join blocking on blocking.document_id = per_document.document_id
   where per_document.finished
     and document.status = 'uploaded' and not document.legal_hold
     and per_document.finished_at <= clock_timestamp() - interval '24 hours'
     and (blocking.requested_at is null or blocking.requested_at <= clock_timestamp() - interval '24 hours')
$$;

-- The worker lists the documents due, oldest due first.
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
    select due.document_id, due.facility_id, due.storage_bucket, due.storage_key,
           greatest(0, floor(extract(epoch from clock_timestamp() - due.due_at)))::bigint
      from ocr.source_deletion_due(null) due
     order by due.due_at, due.document_id
     limit requested_limit;
end
$$;

-- The worker counts the documents due now and those due for more than 2 hours.
create function ocr.worker_source_deletion_backlog()
returns table (due integer, overdue integer)
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, auth, platform, pg_temp
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
      from ocr.source_deletion_due(null) due_row;
end
$$;

-- 3. The purge, after the worker deleted every S3 version of the source.
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
  -- The jobs, too: a retry or a new state of one waits for this purge.
  perform 1 from ocr.jobs job where job.document_id = document_row.id order by job.id for update;
  already_deleted := document_row.status = 'source_deleted';
  if not already_deleted then
    select due.job_count, due.due_at into due_job_count, due_since
      from ocr.source_deletion_due(document_row.id) due;
    if due_job_count is null then
      return query select 'not_due'::text, 0, 0, 0;
      return;
    end if;
    update ehr.documents set status = 'source_deleted', original_file_name = 'Source page deleted after 24 hours',
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
         rejected_fields = '[]'::jsonb, corrections = '[]'::jsonb, reason = 'Content deleted after 24 hours'
    from ocr.jobs job
   where job.id = validation.job_id and job.document_id = document_row.id
     and (validation.validated_payload <> '{}'::jsonb or validation.accepted_fields <> '{}'::jsonb
       or validation.rejected_fields <> '[]'::jsonb or validation.corrections <> '[]'::jsonb
       or validation.reason <> 'Content deleted after 24 hours');
  get diagnostics blanked_validations = row_count;
  update ocr.patient_confirmations confirmation set reason = 'Content deleted after 24 hours', evidence_reference = null
    from ocr.jobs job
   where job.id = confirmation.job_id and job.document_id = document_row.id
     and (confirmation.reason <> 'Content deleted after 24 hours' or confirmation.evidence_reference is not null);
  get diagnostics blanked_confirmations = row_count;
  perform set_config('app.facility_id', coalesce(session_facility, ''), true);
  if not already_deleted or blanked_extractions + blanked_validations + blanked_confirmations > 0 then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
      patient_id, action, outcome, resource_type, resource_id, provenance, details
    ) values (
      requested_correlation_id, 'workload', actor_subject, actor_account,
      document_row.facility_id, document_row.patient_id, 'ocr.source.deleted_after_24h', 'success',
      'document', document_row.id::text, 'application',
      jsonb_build_object('jobCount', coalesce(due_job_count,
          (select count(*)::integer from ocr.jobs job where job.document_id = document_row.id)),
        'objectVersionsDeleted', requested_deleted_versions,
        'extractionsBlanked', blanked_extractions, 'validationsBlanked', blanked_validations,
        'confirmationsBlanked', blanked_confirmations, 'alreadyDeleted', already_deleted,
        'secondsPastDue', case when already_deleted then null
          else greatest(0, floor(extract(epoch from clock_timestamp() - due_since)))::bigint end)
    );
  end if;
  return query select case when already_deleted then 'already_deleted' else 'deleted' end,
    blanked_extractions, blanked_validations, blanked_confirmations;
end
$$;

-- 4. The append-only trigger (0016's body) with one exception: the purge's
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
        'reason', 'Content deleted after 24 hours')
      else pg_catalog.jsonb_build_object('reason', 'Content deleted after 24 hours', 'evidence_reference', null) end;
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

-- The document object guard (0009's body), plus: a 'source_deleted' document
-- is never changed again, and only the purge, as the OCR functions' owner,
-- moves an uploaded document there.
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
  if old.status = 'source_deleted'
     or (new.status = 'source_deleted'
       and (old.status is distinct from 'uploaded' or old.legal_hold
         or new.original_file_name is distinct from 'Source page deleted after 24 hours'
         or current_user is distinct from (select pg_catalog.pg_get_userbyid(class_row.relowner)
                                             from pg_catalog.pg_class class_row
                                            where class_row.oid = 'ocr.jobs'::pg_catalog.regclass)
         or (pg_catalog.to_jsonb(new) - array['status', 'original_file_name', 'row_version', 'updated_at'])
            is distinct from (pg_catalog.to_jsonb(old) - array['status', 'original_file_name', 'row_version', 'updated_at']))) then
    raise exception using errcode = '55000', message = 'Only the OCR source purge may delete a document source, once';
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
     and to_jsonb(new)->>'status' = 'source_deleted' then
    if tg_op <> 'UPDATE' or actor_account_id is null or correlation is null
       or not auth.account_has_active_role(actor_account_id, 'ocr_worker')
       or to_jsonb(old)->>'status' is distinct from 'uploaded'
       or to_jsonb(new)->>'original_file_name' is distinct from 'Source page deleted after 24 hours'
       or (to_jsonb(new) - array['status', 'original_file_name', 'row_version', 'updated_at'])
          is distinct from (to_jsonb(old) - array['status', 'original_file_name', 'row_version', 'updated_at']) then
      raise exception using errcode = '55000', message = 'Only the OCR source purge may delete a document source, once';
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
    execute format('alter function ocr.purge_worker_source_document(uuid,integer,text) owner to %I', ocr_owner);
  end if;
end
$$;

revoke all on function ocr.source_deletion_due(uuid),
  ocr.list_worker_source_deletions(integer),
  ocr.worker_source_deletion_backlog(),
  ocr.purge_worker_source_document(uuid,integer,text) from public;

comment on function ocr.source_deletion_due(uuid) is
  '0110: documents due for deletion of their OCR source (every job finished at least 24 hours ago, no publication active for less than 24 hours, no legal hold, status uploaded), with due_at. Granted to no role.';
comment on function ocr.list_worker_source_deletions(integer) is
  '0110: the OCR worker lists documents due for source deletion (ids, bucket, key, seconds past due), oldest due first.';
comment on function ocr.worker_source_deletion_backlog() is
  '0110: the OCR worker counts documents due for source deletion now, and those due for more than 2 hours.';
comment on function ocr.purge_worker_source_document(uuid,integer,text) is
  '0110: after the OCR worker deleted every S3 version of a due document, marks it source_deleted and blanks the reading and review content of its OCR rows (owner decisions of 2026-11-11). Idempotent.';

-- 5. Grants (the same in runtime-grants.sql's 0110 block). A release applies
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
        || 'ocr.worker_source_deletion_backlog(), ocr.purge_worker_source_document(uuid,integer,text)'))
      grant_row(grantee, privilege)
     where exists (select 1 from pg_roles where rolname = grant_row.grantee)
  loop
    execute format('grant %s to %I', wanted.privilege, wanted.grantee);
  end loop;
end
$$;

-- 6. Post-checks.
do $$
declare
  mismatch text;
  ocr_owner oid := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
begin
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ocr.reject_immutable_change()', '2b0476d4cfb42c39182899e0ab9c6302'),
      ('ehr.reject_document_object_rebinding()', '1f6c250657df1b09a7a3c2e6a2c5e2a6'),
      ('ehr.capture_record_version()', '77887743439d9416bc8de68c7e22b482'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then mismatch := 'the bodies of ' || mismatch; end if;
  if mismatch is null and exists (
       select 1 from ocr_source_deletion_0110_acl before_row
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
         'worker_source_deletion_backlog', 'purge_worker_source_document')
       and privilege.grantee <> proc.proowner
       and (proc.proname, coalesce(grantee.rolname, 'PUBLIC')) not in (
         ('list_worker_source_deletions', 'hid_ocr_worker'), ('worker_source_deletion_backlog', 'hid_ocr_worker'),
         ('purge_worker_source_document', 'hid_ocr_worker'));
    if mismatch is not null then mismatch := 'unexpected EXECUTE: ' || mismatch; end if;
  end if;
  if mismatch is null and not exists (
       select 1 from pg_constraint where conrelid = 'ehr.documents'::regclass
          and conname = 'documents_status_check' and convalidated
          and pg_get_constraintdef(oid) = 'CHECK ((status = ANY (ARRAY[''initiated''::text, ''uploaded''::text, ''rejected''::text, ''entered_in_error''::text, ''source_deleted''::text])))') then
    mismatch := 'the constraint documents_status_check';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0110: post-check failed: %s', mismatch);
  end if;
end;
$$;
