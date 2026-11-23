-- 0146 PROPOSAL, NOT SIGNED: completing a document upload works again for the
-- EHR API (hotfix for POST /api/v1/ehr/documents/:id/complete). Written on
-- staging-novu-ci-20261005 at 06f98040 (0001-0137 applied: Release A, live
-- since 23 November 2026). It needs only 0001-0137 (in fact only 0112's body
-- of the one function it replaces) and reads or replaces nothing 0138-0151
-- (booked by other Release B branches) add, so it may be applied before or
-- after them. The number is the next one free after the Release B bookings;
-- the release integrator may give it another. The declaration in
-- config/production-schema-compatibility.json is signed separately: its
-- reviewed_by stays as it is until the owner signs this file.
--
-- The fault (since 0112, not Release A). 0112 replaced
-- ehr.reject_document_object_rebinding(), the BEFORE UPDATE trigger function
-- of ehr.documents. It is SECURITY INVOKER, and its second IF names the owner
-- of ocr.jobs with the constant 'ocr.jobs'::pg_catalog.regclass. PL/pgSQL
-- prepares the whole IF expression the first time it runs, and the regclass
-- constant is resolved while it is prepared, as the invoker, before the
-- status test can short-circuit it. The EHR runtime (hid_ehr_runtime, and the
-- ehr-api login hid_ehr_api_runtime through it) has no USAGE on schema ocr,
-- by design, so every UPDATE of ehr.documents it makes fails with
--   SQLSTATE 42501  permission denied for schema ocr
--   (PL/pgSQL function reject_document_object_rebinding() line 12 at IF)
-- The only such UPDATE is DocumentService.complete (initiated -> uploaded),
-- so step 2 of every upload has answered 500 INTERNAL_ERROR (DatabaseError)
-- since 0112 was applied, at every facility (real, sealed demo and sealed
-- QA) and for every staff role; no new document reaches 'uploaded', so no
-- scan and no OCR reading starts on it. The upload intent (an INSERT) and
-- every read are unaffected. The suites missed it because they update
-- ehr.documents as the owner or as hid_schema_test_runtime, which has USAGE
-- on schema ocr, and the ocr-source-deletion suite accepts 42501 from the
-- EHR runtime for its (refused either way) source_deleting attempt.
--
-- What it does: one CREATE OR REPLACE of ehr.reject_document_object_rebinding()
-- with 0112's body except that the owner of ocr.jobs is read from
-- pg_catalog.pg_class joined to pg_catalog.pg_namespace by name (schema
-- 'ocr', relation 'jobs'), which needs no privilege on schema ocr. The rule is
-- unchanged: a document moves into, within or out of 'source_deleting' and
-- 'source_deleted' only by the OCR functions' owner's two exact steps (the
-- claim and the purge), as before; every other update keeps 0009's object
-- identity rule. Language, SECURITY INVOKER, volatility, strictness,
-- search_path, owner and ACL stay as 0112 left them (CREATE OR REPLACE keeps
-- the owner and ACL; section 2 checks all of them). No table, policy,
-- trigger or grant changes, so runtime-grants.sql is unchanged, and the EHR
-- runtime gains no privilege. No service change is needed: today's ehr-api
-- runs the same statements and they succeed from the next request; nobody is
-- signed out.
--
-- Locks: none on a table. CREATE OR REPLACE FUNCTION updates one pg_proc row;
-- a concurrent UPDATE of ehr.documents runs the old or the new body, and both
-- give the same answer for everything but the EHR runtime's completion.
--
-- Undo: replace the function with 0112's body again (md5 of prosrc
-- fe673d974c34460a6b64764117a82fc7), which brings the fault back. It becomes
-- a migration only if the owner signs it.
--
-- 1. Preconditions (catalog reads only; 55000 or 42501, nothing applied).
-- 2. The replacement, then the post-check.

-- 1. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regclass('identity.qoreid_nin_checks') is null then
    raise exception using errcode = '55000', message = '0146: 0001-0137 must be applied first';
  end if;
  if to_regprocedure('ehr.reject_document_object_rebinding()') is null or to_regclass('ocr.jobs') is null then
    raise exception using errcode = '55000', message = '0146: ehr.reject_document_object_rebinding() or ocr.jobs is missing';
  end if;
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = 'ehr.reject_document_object_rebinding()'::regprocedure)
     = 'b110135d5f09c1bbe04316e01cc2eeba' then
    raise exception using errcode = '55000', message = '0146: already applied';
  end if;
  -- 0112's body, byte for byte, with 0112's attributes.
  select string_agg(problem, '; ') into mismatch
    from (
      select 'body md5 ' || md5(proc.prosrc) as problem from pg_proc proc
       where proc.oid = 'ehr.reject_document_object_rebinding()'::regprocedure
         and md5(proc.prosrc) <> 'fe673d974c34460a6b64764117a82fc7'
      union all
      select 'attributes' from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
       where proc.oid = 'ehr.reject_document_object_rebinding()'::regprocedure
         and (language_row.lanname <> 'plpgsql' or proc.prosecdef or proc.provolatile <> 'v' or proc.proisstrict
           or proc.proconfig is distinct from '{"search_path=ehr, pg_temp"}'::text[]
           or proc.prorettype <> 'trigger'::regtype or proc.pronargs <> 0)
      union all
      -- The trigger that calls it, as 0009 created it and 0112 checked it.
      select 'trigger documents_reject_object_rebinding' where not exists (
        select 1 from pg_trigger trigger_row
         where trigger_row.tgrelid = 'ehr.documents'::regclass and not trigger_row.tgisinternal
           and trigger_row.tgname = 'documents_reject_object_rebinding' and trigger_row.tgenabled = 'O'
           and trigger_row.tgfoid = 'ehr.reject_document_object_rebinding()'::regprocedure
           and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER documents_reject_object_rebinding BEFORE UPDATE ON ehr.documents FOR EACH ROW EXECUTE FUNCTION ehr.reject_document_object_rebinding()')
      union all
      -- 0112's rule names the owner of ocr.jobs, which 0112 required to own
      -- ehr.documents too; exactly one relation named ocr.jobs.
      select 'ocr.jobs owner' where (select count(*) from pg_class class_row
          join pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace
         where namespace_row.nspname = 'ocr' and class_row.relname = 'jobs'
           and class_row.oid = 'ocr.jobs'::regclass
           and class_row.relowner = (select relowner from pg_class where oid = 'ehr.documents'::regclass)) <> 1
    ) problems;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = '0146: ehr.reject_document_object_rebinding() is not as 0112 left it: ' || mismatch;
  end if;
  if not pg_has_role(current_user,
       (select proc.proowner from pg_proc proc where proc.oid = 'ehr.reject_document_object_rebinding()'::regprocedure),
       'USAGE') then
    raise exception using errcode = '42501',
      message = '0146: the applier does not own ehr.reject_document_object_rebinding() (nor inherit its owner)';
  end if;
  -- Recorded for the post-check: owner and ACL before the replacement.
  perform set_config('m0146.before', (
    select format('%s|%s', proc.proowner, coalesce(proc.proacl::text, '')) from pg_proc proc
     where proc.oid = 'ehr.reject_document_object_rebinding()'::regprocedure), true);
end
$$;

-- 2. The document object guard (0009's body, 0112's source deletion rule),
-- with the owner of ocr.jobs read from the catalog by name: no regclass
-- constant, so the invoker needs no privilege on schema ocr.
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
  -- 0146: the owner of ocr.jobs by name, so a role without USAGE on schema
  -- ocr (the EHR runtime completing an upload) can run this check.
  if (old.status in ('source_deleting', 'source_deleted') or new.status in ('source_deleting', 'source_deleted'))
     and not (current_user = (select pg_catalog.pg_get_userbyid(class_row.relowner) from pg_catalog.pg_class class_row
                                join pg_catalog.pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace
                               where namespace_row.nspname = 'ocr' and class_row.relname = 'jobs')
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

-- Post-check: the new body, 0112's attributes, the same owner and ACL, the
-- trigger unchanged, and no regclass constant left in the body.
do $$
begin
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = 'ehr.reject_document_object_rebinding()'::regprocedure)
     <> 'b110135d5f09c1bbe04316e01cc2eeba'
     or exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                 where proc.oid = 'ehr.reject_document_object_rebinding()'::regprocedure
                   and (language_row.lanname <> 'plpgsql' or proc.prosecdef or proc.provolatile <> 'v'
                     or proc.proisstrict or proc.proconfig is distinct from '{"search_path=ehr, pg_temp"}'::text[]
                     or proc.prosrc ~ '::\s*(pg_catalog\.)?reg'
                     or format('%s|%s', proc.proowner, coalesce(proc.proacl::text, ''))
                        <> current_setting('m0146.before')))
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'ehr.documents'::regclass
                       and trigger_row.tgname = 'documents_reject_object_rebinding' and trigger_row.tgenabled = 'O'
                       and trigger_row.tgfoid = 'ehr.reject_document_object_rebinding()'::regprocedure) then
    raise exception using errcode = '55000', message = '0146: post-check failed';
  end if;
end
$$;
