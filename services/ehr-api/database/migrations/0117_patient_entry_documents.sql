-- 0117 Photos and files on the records patients add themselves (the plan's
-- item 1b; the website's contract, health main BACKEND-NEEDS.md section 1,
-- "Patient-added records, with photos and files"; the coordinator's switch of
-- 4 Nov 2026: files have their own setting, PATIENT_ENTRY_FILES_ENABLED, on
-- by default; the number 0117 assigned by the coordinator; the declaration is
-- signed separately). Written on 0116 (records patients add, text only, PR
-- #163) merged with staging at 0107: every lower number is assumed applied,
-- and it reads objects of 0004-0116, pinned in section 0.
--
-- A patient who has saved a record of their own adds up to 5 photos or PDFs
-- to it, each in the three steps staff document uploads take: ask for an
-- upload link, PUT the exact bytes to the documents bucket, confirm. The
-- bytes never pass through the API. The object keys are staff documents'
-- (clinical/objects/<uuid>), so the bucket, its lifecycle, the GuardDuty plan
-- and the scan bridge stay as 0105 and its Terraform ship them: ehr-api's
-- scanner routes look a key up in ehr.documents first, then here, and send
-- the scanner's result to whichever holds it. At most 10 files a patient a
-- Lagos calendar day (every upload link opened counts, a removed record's
-- included), at most 5 a record, JPEG, PNG or PDF, 1 byte to 10 MB. A file is
-- read by the patient, by a clinician whose access to the patient is granted
-- (as the record it belongs to, 0116's read rule), and by the patient's chat
-- once it is confirmed and scanned clean; a removed record's files by nobody,
-- and kept. Staff uploads are untouched and have no daily limit.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0116 applied (its three bodies are the marker:
--    ehr.create_my_patient_entry 280b73ca..., ehr.withdraw_my_patient_entry
--    172d17d8..., ehr.patient_entries_guard f04a4337..., and the read policy
--    patient_entries_read as 0116 makes it) and 0105 applied (its two scanner
--    commands, whose exact refusals ehr-api's dispatch reads: resolve
--    cb5d1557..., list a608c387...); nothing of this file exists yet (else
--    55000 "0117: already applied"); the bodies the new commands, policies
--    and triggers rely on are byte for byte the ones measured on 0116 merged
--    with 0107 (md5 of pg_proc.prosrc): ehr.patient_self_context,
--    ehr.imported_record_read_context, ehr.context_allows,
--    identity.has_active_consent_grant (as 0104 left it) and
--    identity.has_active_membership, with their security attributes; the
--    platform.current_* readers, auth.account_id_for_subject,
--    auth.account_has_active_role, platform.reject_mutation,
--    audit.authorize_platform_event and 0009's ehr.append_document_scan_event
--    (whose refusals the new scanner command repeats word for word); the
--    columns of ehr.patient_entries read here; the shape of 0068's
--    ehr.patient_attachment_extractions, which the extractions table copies
--    (md5s of its columns b5f23252..., CHECKs cd808e40... and indexes
--    e5a41d7f...); the source-kind CHECK of both
--    chunk tables as 0116 left it (14 kinds, 392152e0...); the audit.events
--    CHECKs the new rows must pass with 0064's authority trigger; the
--    document_scanner role active and granting exactly ehr.document.scan;
--    the applying role, which will own the new objects, owns
--    identity.patients and ehr.patient_entries (the foreign keys; so their
--    forced RLS hides no row from the commands), owns both chunk tables or is
--    a member that inherits their owner and may SET ROLE to it (ALTER TABLE),
--    holds INSERT on audit.events and CREATE on schema ehr, and may run every
--    function the new objects call, never through a superuser's bypass.
-- 1. The locks the new foreign keys need (see Locks).
-- 2. ehr.patient_entry_documents: per file the patient, the record it is on
--    (ehr.patient_entries), the account that asked for the link, the
--    request's idempotency key and digest (unique per patient and key), the
--    file name (1-255 characters, no control character), the bucket and the
--    key (clinical/objects/<uuid>, unique), the declared type (image/jpeg,
--    image/png or application/pdf), size (1-10485760) and SHA-256, initiated
--    or uploaded (the confirm sets the object version and when), a
--    row_version. Rows are never deleted or truncated and change only from
--    initiated to uploaded with the object version
--    (ehr.patient_entry_documents_guard). ehr.patient_entry_document_scan_
--    events: the scanner's results, append-only, bound to the uploaded
--    object's version and SHA-256 (foreign key), as 0009 binds staff
--    documents'. ehr.patient_entry_documents_effective (security invoker):
--    each file with the latest scan event on its bound object, as
--    ehr.documents_effective: scan_status pending until there is one, status
--    available once uploaded and clean, rejected once rejected.
--    ehr.patient_entry_document_extractions: the patient chat's machine
--    reading of a file (0069's shape), bound to the file's object.
--    Row-level security, forced, on all three tables: the applier's own
--    policy (the commands) and a read policy. A file: its record is active
--    and readable (0116's rule: the patient in a fresh patient-self
--    transaction, or a clinician whose access at the current facility is
--    granted), and it is uploaded, or the reader is the patient (who
--    confirms their own). A scan event: its file is readable. An extraction:
--    the patient's own fresh session, of a file available on that object.
-- 3. Patient commands, SECURITY DEFINER with search_path pg_catalog,
--    pg_temp, only in a fresh patient-self EHR transaction (0116's check;
--    else 42501), under 0116's advisory lock patient-entry:<patient>:
--    a. ehr.create_my_patient_entry_document_intent: invalid input raises
--       22023 PATIENT_DOCUMENT_INVALID. A key already used by the patient:
--       another digest 'key_reused'; its record no longer active
--       'entry_not_found'; not confirmed yet 'replayed' (the same file and
--       key, for a fresh link); confirmed 'already_uploaded' with its status
--       and scan status. A new key: a record that is not the patient's or
--       is removed 'entry_not_found'; 10 files already opened today in Lagos
--       (removed records' included) 'daily_limit' with the seconds to the
--       next Lagos midnight; 5 on the record already 'entry_full' (every
--       link opened on it counts, confirmed or not, refused for its type
--       included); else the file is opened, initiated ('created'). A refusal for a limit is
--       audited as denied, counts only, and writes nothing else.
--    b. ehr.complete_my_patient_entry_document: the uploader's own file on
--       that active record, else 'not_found'; already uploaded
--       'already_uploaded'; the stored object's size or SHA-256 not the
--       declared ones 'mismatch' (nothing written); else uploaded with the
--       object version ('uploaded'). ehr-api reads the stored object (HEAD
--       and its first bytes) before it calls this.
--    Every write records its audit.events row in the same transaction:
--    ehr.patient-entry.document.upload-intent and
--    ehr.patient-entry.document.upload-complete, actor the patient, resource
--    patient-entry-document, codes and numbers only (never a file name).
-- 4. Scanner commands, SECURITY DEFINER with search_path pg_catalog,
--    pg_temp, for an active account holding document_scanner and the
--    transaction's correlation id (0105's check; else 42501), with 0105's and
--    0009's refusals word for word, so the bridge reads them the same:
--    ehr.resolve_patient_entry_document_scan_target(bucket, key, version,
--    correlation id), ehr.list_patient_entry_documents_awaiting_scan(older
--    than seconds, max rows, correlation id) and
--    ehr.append_patient_entry_document_scan_event (0009's ten arguments; a
--    clean result's detected type must be one of the three). Audited as
--    0105 and 0009 audit staff documents', resource patient-entry-document.
-- 5. Grants, here and in runtime-grants.sql: SELECT on the files, their scan
--    events and the effective view, and EXECUTE on the two patient
--    commands, to hid_ehr_runtime and hid_schema_test_runtime; SELECT,
--    INSERT and UPDATE on the extractions to hid_ehr_runtime (as 0069 grants
--    ehr.patient_document_extractions); EXECUTE on the three scanner
--    commands to hid_document_scanner alone; every new function revoked from
--    PUBLIC, the two guards granted to nobody. No write grant on the files or
--    the scan events.
-- 6. Post-checks: the new tables, view and functions are the applier's and
--    as this file makes them (owner, forced RLS, policies, SECURITY DEFINER,
--    search_path, bodies, the extractions table's shape the same three md5s
--    as its source's), and the bodies relied on are unchanged.
-- 7. Chat evidence, last: patient_entry_document becomes a source kind of
--    ehr.patient_evidence_chunks and ehr.staff_evidence_chunks (their shared
--    CHECK is dropped and added NOT VALID with the 15 kinds, then validated,
--    as 0116 did); every other CHECK of the two tables is unchanged. Only the
--    patient's chat reads the files; the staff table takes the kind so the
--    two CHECKs stay one definition.
--
-- Locks: SHARE ROW EXCLUSIVE on identity.patients and ehr.patient_entries
-- (the new foreign keys), taken first, NOWAIT every 10 ms for at most 5
-- seconds (then 55P03 and nothing applied), held to commit: patient sign-up
-- and profile writes, and records patients add and remove, wait for the
-- apply; reads do not. Then, last, ACCESS EXCLUSIVE on both chunk tables,
-- taken the same way and held to commit: every chat search waits for the rest
-- of the apply. Measured with pg_locks before commit (the file applied in an
-- open transaction, as the production-shape migrator, on a 0001-0116 copy):
-- SHARE ROW EXCLUSIVE and ACCESS SHARE on identity.patients and
-- ehr.patient_entries and ACCESS SHARE on their primary keys; ACCESS
-- EXCLUSIVE and SHARE UPDATE EXCLUSIVE on ehr.patient_evidence_chunks and
-- ehr.staff_evidence_chunks; ACCESS SHARE on auth.roles and
-- auth.role_permissions (the scanner role's precondition) and on
-- ehr.patient_attachment_extractions (the extraction table's LIKE); ACCESS
-- EXCLUSIVE (and the weaker locks creating them takes) on the new tables,
-- view and indexes; no lock on ehr.documents, audit.events or any other
-- existing table; the catalogs' own locks. The file took 16 ms there. With a
-- write held open on ehr.patient_entries, or a read held open on
-- ehr.staff_evidence_chunks, it stopped after 5.1 s with 55P03 and nothing
-- applied.
--
-- Old services on this schema: every change is additive. Today's EHR image
-- (0116's) reads no new object and writes only the 14 chunk kinds it knows,
-- which the wider CHECK still accepts; its scanner routes find no staff
-- document for a patient file's key and answer Document not found, which the
-- bridge acknowledges, so a file confirmed before the new image runs stays
-- scan-pending (never readable by the chat) until the list command offers it
-- again. The new EHR image reads these objects only while
-- PATIENT_ENTRY_FILES_ENABLED is on (and PATIENT_ENTRIES_ENABLED, which it
-- needs): that image runs before this migration only with
-- PATIENT_ENTRY_FILES_ENABLED=false. Applied migrations 0001 through 0116
-- are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0094's helper).
create function pg_temp.patient_entry_documents_holds(holder oid, object_owner oid, object_acl aclitem[],
  object_type "char", wanted text)
returns boolean
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  with recursive held(role_id) as (
    select holder
    union
    select membership.roleid from pg_catalog.pg_auth_members membership join held on membership.member = held.role_id
  )
  select object_owner in (select held.role_id from held)
    or exists (select 1 from pg_catalog.aclexplode(coalesce(object_acl, pg_catalog.acldefault(object_type, object_owner))) acl
                where acl.privilege_type = wanted
                  and (acl.grantee = 0 or acl.grantee in (select held.role_id from held)))
$$;

-- A table's shape as LIKE ... INCLUDING DEFAULTS INCLUDING CONSTRAINTS
-- INCLUDING INDEXES copies it: the md5 of its columns (name, type, NOT NULL,
-- default, in order), of its CHECKs (name and definition) and of its indexes
-- (unique, primary, method and columns; not their names). Pinned for
-- 0068's ehr.patient_attachment_extractions in 0d and checked on the copy in 6.
create function pg_temp.patient_entry_documents_shape(relation regclass)
returns text[]
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  select array[
    md5(coalesce((select string_agg(format('%s %s %s %s', attribute_row.attname,
                   format_type(attribute_row.atttypid, attribute_row.atttypmod), attribute_row.attnotnull,
                   coalesce(pg_get_expr(default_row.adbin, default_row.adrelid), '')), ', ' order by attribute_row.attnum)
                    from pg_attribute attribute_row
                    left join pg_attrdef default_row
                      on default_row.adrelid = attribute_row.attrelid and default_row.adnum = attribute_row.attnum
                   where attribute_row.attrelid = relation and attribute_row.attnum > 0
                     and not attribute_row.attisdropped), '')),
    md5(coalesce((select string_agg(format('%s %s', constraint_row.conname, pg_get_constraintdef(constraint_row.oid)),
                   '; ' order by constraint_row.conname)
                    from pg_constraint constraint_row
                   where constraint_row.conrelid = relation and constraint_row.contype = 'c'), '')),
    md5(coalesce((select string_agg(format('%s %s %s', index_row.indisunique, index_row.indisprimary,
                   regexp_replace(pg_get_indexdef(index_row.indexrelid), '^.* USING ', '')), '; '
                   order by regexp_replace(pg_get_indexdef(index_row.indexrelid), '^.* USING ', ''))
                    from pg_index index_row
                   where index_row.indrelid = relation), ''))]
$$;

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  -- a. Prerequisites: 0116 (its bodies and read policy are the marker) and
  -- 0105 (its scanner commands).
  if to_regclass('ehr.patient_entries') is null
     or to_regclass('identity.patients') is null
     or to_regclass('audit.events') is null
     or to_regclass('ehr.patient_evidence_chunks') is null
     or to_regclass('ehr.staff_evidence_chunks') is null
     or to_regclass('ehr.patient_attachment_extractions') is null
     or to_regprocedure('ehr.create_my_patient_entry(text,text,text,date,text,text,text)') is null
     or to_regprocedure('ehr.withdraw_my_patient_entry(uuid)') is null
     or to_regprocedure('ehr.patient_entries_guard()') is null
     or to_regprocedure('ehr.resolve_document_scan_target(text,text,text,text)') is null
     or to_regprocedure('ehr.list_documents_awaiting_scan(integer,integer,text)') is null
     or (select qual from pg_policies where schemaname = 'ehr' and tablename = 'patient_entries'
           and policyname = 'patient_entries_read' and cmd = 'SELECT')
        is distinct from '((status = ''active''::text) AND ehr.imported_record_read_context(patient_id))' then
    raise exception using errcode = '55000', message = '0117: 0001-0116 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('ehr.patient_entry_documents') is not null
     or to_regclass('ehr.patient_entry_document_scan_events') is not null
     or to_regclass('ehr.patient_entry_documents_effective') is not null
     or to_regclass('ehr.patient_entry_document_extractions') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and proc.proname in ('create_my_patient_entry_document_intent', 'complete_my_patient_entry_document',
                     'resolve_patient_entry_document_scan_target', 'list_patient_entry_documents_awaiting_scan',
                     'append_patient_entry_document_scan_event', 'patient_entry_documents_guard')) then
    raise exception using errcode = '55000', message = '0117: already applied';
  end if;
  -- c. The bodies relied on: 0116's commands and guard (the marker, and the
  -- lock and rules this file shares), 0105's scanner commands (ehr-api's
  -- dispatch reads their refusals), 0009's append (whose refusals the new
  -- append repeats), the patient-self and clinician read contexts with the
  -- consent and membership checks behind them, the request-context readers,
  -- the scanner role check, the no-delete trigger and the audit table's
  -- authority trigger.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ehr.create_my_patient_entry(text,text,text,date,text,text,text)', '280b73ca5151f73ffac6256bf81110af'),
      ('ehr.withdraw_my_patient_entry(uuid)', '172d17d8abb9d237ba4fa6fd06ddeb21'),
      ('ehr.patient_entries_guard()', 'f04a4337f2d2be151d2483af0ba0207c'),
      ('ehr.resolve_document_scan_target(text,text,text,text)', 'cb5d1557133df9bb91602b0391e63483'),
      ('ehr.list_documents_awaiting_scan(integer,integer,text)', 'a608c387d89ab3d6940e75cdc9fa8053'),
      ('ehr.append_document_scan_event(uuid,text,text,text,text,text,text,text,text,text)',
        '48028691118378511414feabd53ccbc7'),
      ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
      ('ehr.imported_record_read_context(uuid)', 'eabd4af535ecf91508eae6003836e427'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('auth.account_has_active_role(uuid,text)', 'a3310b48da6ff8bcd3ecb9d7dbef900a'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- Their security attributes: the patient-self context, the consent and
  -- membership checks and 0116's commands run as their owner, the read
  -- context as its caller.
  if mismatch is null then
    select string_agg(expected.proc, '; ') into mismatch
      from (values
        ('ehr.patient_self_context(uuid)', true, 's', '{"search_path=pg_catalog, pg_temp"}'),
        ('ehr.imported_record_read_context(uuid)', false, 's', '{"search_path=ehr, platform, pg_temp"}'),
        ('ehr.context_allows(uuid,uuid,text)', true, 's', '{"search_path=ehr, identity, platform, pg_temp"}'),
        ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', true, 's',
         '{"search_path=identity, auth, pg_temp"}'),
        ('identity.has_active_membership(text,uuid,uuid)', true, 's', '{"search_path=identity, auth, pg_temp"}'),
        ('ehr.create_my_patient_entry(text,text,text,date,text,text,text)', true, 'v',
         '{"search_path=pg_catalog, pg_temp"}'),
        ('ehr.withdraw_my_patient_entry(uuid)', true, 'v', '{"search_path=pg_catalog, pg_temp"}'))
           expected(proc, definer, volatility, config)
     where not exists (select 1 from pg_proc proc
                        where proc.oid = to_regprocedure(expected.proc)
                          and proc.prosecdef = expected.definer and proc.provolatile = expected.volatility
                          and proc.proconfig = expected.config::text[]);
    if mismatch is not null then mismatch := 'attributes of ' || mismatch; end if;
  end if;
  -- d. The columns of ehr.patient_entries read here, the shape the
  -- extractions table copies (0068's ehr.patient_attachment_extractions:
  -- columns, CHECKs, and the primary key the chat's reading writes through
  -- with on conflict), the CHECK this file writes through (the source-kind
  -- CHECK of both chunk tables, as 0116 left it), the audit rules the new rows
  -- pass, and the scanner role.
  if mismatch is null then
    select string_agg(format('%s.%s', expected.relation_name, expected.column_name), ', ') into mismatch
      from (values
        ('ehr.patient_entries', 'id', 'uuid', true),
        ('ehr.patient_entries', 'patient_id', 'uuid', true),
        ('ehr.patient_entries', 'status', 'text', true))
           expected(relation_name, column_name, type_name, not_null)
     where not exists (select 1 from pg_attribute attribute_row
                        where attribute_row.attrelid = expected.relation_name::regclass
                          and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                          and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                          and attribute_row.attnotnull = expected.not_null);
  end if;
  if mismatch is null
     and pg_temp.patient_entry_documents_shape('ehr.patient_attachment_extractions'::regclass)
       is distinct from array['b5f232528db89ab9a49c64eb4dff18ec', 'cd808e4010fb29251c10af60e6ade7cc',
                              'e5a41d7f2d45540f7e5808bd495248ca'] then
    mismatch := 'the shape of ehr.patient_attachment_extractions (columns, CHECKs, indexes)';
  end if;
  if mismatch is null
     and (select count(*) from pg_constraint constraint_row
           where constraint_row.conrelid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
             and constraint_row.contype = 'c' and constraint_row.convalidated
             and constraint_row.conname = 'patient_evidence_chunks_source_kind_check'
             and md5(pg_get_constraintdef(constraint_row.oid)) = '392152e0fd4834262de048c7b9027151') <> 2 then
    mismatch := 'patient_evidence_chunks_source_kind_check on ehr.patient_evidence_chunks and ehr.staff_evidence_chunks';
  end if;
  if mismatch is null
     and (select count(*) from pg_constraint constraint_row
           where constraint_row.conrelid = 'audit.events'::regclass and constraint_row.contype = 'c'
             and constraint_row.convalidated
             and (constraint_row.conname, md5(pg_get_constraintdef(constraint_row.oid))) in (
               ('audit_actor_type_ck', 'd630642d19ec60d7d0cfab2d90533dba'),
               ('audit_actor_facility_ck', 'd74856f4b11b9e7e378d1a586f3a284b'),
               ('audit_platform_scope_ck', 'bc5f610696515dc7475eadde912e0a30'),
               ('events_correlation_id_check', '9066882d9638362e3e51196825b0a764'),
               ('events_outcome_check', '8ec48394933b68472efacffc62cfeda2'),
               ('events_provenance_check', '6bf802bf3aa55c42b5c3752b204fbad1'),
               ('events_details_check', '13e7eaeabe2055f5d8a517bf0fc75a88'),
               ('events_action_check', 'a3aa891e6aa8e44df4b69cb2eaff7c10'))) <> 8 then
    mismatch := 'the audit.events constraints the new rows must pass';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'audit.events'::regclass
             and trigger_row.tgname = 'audit_platform_authority' and trigger_row.tgenabled = 'O'
             and pg_get_triggerdef(trigger_row.oid) =
               'CREATE TRIGGER audit_platform_authority BEFORE INSERT ON audit.events '
               || 'FOR EACH ROW EXECUTE FUNCTION audit.authorize_platform_event()') <> 1 then
    mismatch := 'the trigger audit_platform_authority';
  end if;
  if mismatch is null
     and (not exists (select 1 from auth.roles role_row where role_row.code = 'document_scanner' and role_row.active)
       or (select array_agg(grant_row.permission_code order by grant_row.permission_code)
             from auth.role_permissions grant_row where grant_row.role_code = 'document_scanner')
          is distinct from array['ehr.document.scan']) then
    mismatch := 'the document_scanner role (active, granting exactly ehr.document.scan)';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0117: an object this migration relies on differs from 0001-0116: %s', mismatch);
  end if;
  -- e. Privileges, never through a superuser's bypass (production's
  -- migrator has none).
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s lacks %s on %s', holder.rolname, wanted.privilege, relation.oid::regclass) as what
        from (values ('identity.patients', 'OWNER'), ('ehr.patient_entries', 'OWNER'), ('audit.events', 'INSERT'),
                     ('auth.roles', 'SELECT'), ('auth.role_permissions', 'SELECT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
        join pg_roles holder on holder.oid = applier
       where case when wanted.privilege = 'OWNER'
               then not pg_temp.patient_entry_documents_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
               else not pg_temp.patient_entry_documents_holds(applier, relation.relowner, relation.relacl, 'r',
                 wanted.privilege) end
      union all
      select format('%s is not %s and may not act as it (INHERIT and SET) for %s', holder.rolname,
               pg_get_userbyid(relation.relowner), relation.oid::regclass)
        from pg_class relation
        join pg_roles holder on holder.oid = applier
       where relation.oid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
         and relation.relowner <> applier
         and not (pg_temp.patient_entry_documents_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
           and pg_has_role(applier, relation.relowner, 'USAGE') and pg_has_role(applier, relation.relowner, 'SET'))
      union all
      select format('%s lacks %s on schema %s', holder.rolname, wanted.privilege, namespace.nspname)
        from (values ('ehr', 'CREATE'), ('auth', 'USAGE'), ('audit', 'USAGE'), ('platform', 'USAGE'),
                     ('identity', 'USAGE')) wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
        join pg_roles holder on holder.oid = applier
       where not pg_temp.patient_entry_documents_holds(applier, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks EXECUTE on %s', holder.rolname, proc.oid::regprocedure)
        from (values
          ('ehr.patient_self_context(uuid)'), ('ehr.imported_record_read_context(uuid)'),
          ('platform.current_correlation_id()'), ('platform.current_actor_subject()'),
          ('auth.account_id_for_subject(text)'), ('auth.account_has_active_role(uuid,text)'),
          ('platform.reject_mutation()')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
        join pg_roles holder on holder.oid = applier
       where not pg_temp.patient_entry_documents_holds(applier, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0117: missing privileges: %s', mismatch);
  end if;
  raise notice '0117: owners checked: %', (
    select string_agg(format('%s=%s', owned.what, owned.owner), ', ' order by owned.what)
      from (select relation.oid::regclass::text as what, pg_get_userbyid(relation.relowner)::text as owner
              from pg_class relation
             where relation.oid in ('identity.patients'::regclass, 'ehr.patient_entries'::regclass,
                                    'ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
            union all
            select 'new tables, view and functions', current_user::text) owned);
end
$$;

-- 1. The locks the new foreign keys take, up front and bounded.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.patients, ehr.patient_entries in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0117: identity.patients or ehr.patient_entries stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 2. The files, their scan results, the effective view and the chat's reading.
create table ehr.patient_entry_documents (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  entry_id uuid not null references ehr.patient_entries(id) on delete restrict,
  created_by_account_id uuid not null,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  original_file_name text not null check (length(original_file_name) between 1 and 255
    and original_file_name !~ '[\u0001-\u001f\u007f-\u009f]'),
  storage_bucket text not null check (length(storage_bucket) between 3 and 63),
  storage_key text not null
    check (storage_key ~ '^clinical/objects/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  object_version_id text check (object_version_id is null or length(object_version_id) between 1 and 1024),
  declared_media_type text not null check (declared_media_type in ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  sha256_hex char(64) not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  status text not null default 'initiated' check (status in ('initiated', 'uploaded')),
  uploaded_at timestamptz,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint patient_entry_documents_uploaded_check
    check ((status = 'uploaded') = (object_version_id is not null and uploaded_at is not null)),
  constraint patient_entry_documents_idempotency_key_uq unique (patient_id, idempotency_key),
  constraint patient_entry_documents_object_key_uq unique (storage_bucket, storage_key),
  constraint patient_entry_documents_object_binding_uq unique (id, patient_id, object_version_id, sha256_hex)
);
create index patient_entry_documents_entry_idx on ehr.patient_entry_documents (entry_id, created_at, id);
create index patient_entry_documents_patient_day_idx on ehr.patient_entry_documents (patient_id, created_at);
create index patient_entry_documents_awaiting_scan_idx on ehr.patient_entry_documents (updated_at, id)
  where status = 'uploaded';

-- Only initiated to uploaded: the object version and when set, row_version
-- + 1, every other column but updated_at unchanged.
create function ehr.patient_entry_documents_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status = 'initiated' and new.status = 'uploaded' and new.object_version_id is not null
     and new.uploaded_at is not null and new.row_version = old.row_version + 1
     and (new.id, new.patient_id, new.entry_id, new.created_by_account_id, new.idempotency_key, new.request_sha256,
          new.original_file_name, new.storage_bucket, new.storage_key, new.declared_media_type, new.size_bytes,
          new.sha256_hex, new.created_at)
         is not distinct from
         (old.id, old.patient_id, old.entry_id, old.created_by_account_id, old.idempotency_key, old.request_sha256,
          old.original_file_name, old.storage_bucket, old.storage_key, old.declared_media_type, old.size_bytes,
          old.sha256_hex, old.created_at) then
    return new;
  end if;
  raise exception using errcode = '55000',
    message = 'A file a patient added changes only from initiated to uploaded, with its object';
end
$$;
create trigger patient_entry_documents_one_way
  before update on ehr.patient_entry_documents
  for each row execute function ehr.patient_entry_documents_guard();
create trigger patient_entry_documents_no_delete
  before delete on ehr.patient_entry_documents
  for each row execute function platform.reject_mutation();
create trigger patient_entry_documents_no_truncate
  before truncate on ehr.patient_entry_documents
  for each statement execute function platform.reject_mutation();

create table ehr.patient_entry_document_scan_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  patient_id uuid not null,
  created_by uuid not null,
  object_version_id text not null check (length(object_version_id) between 1 and 1024),
  object_sha256_hex char(64) not null check (object_sha256_hex ~ '^[0-9a-f]{64}$'),
  event_type text not null check (event_type in ('scan_started', 'clean', 'rejected', 'failed')),
  detected_media_type text check (detected_media_type is null or length(detected_media_type) <= 255),
  scanner_engine text not null check (length(scanner_engine) between 1 and 120 and length(btrim(scanner_engine)) > 0),
  scanner_version text not null check (length(scanner_version) between 1 and 120 and length(btrim(scanner_version)) > 0),
  reason_code text check (reason_code is null or length(reason_code) <= 120),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  created_at timestamptz not null default clock_timestamp(),
  constraint patient_entry_document_scan_events_object_fk foreign key (document_id, patient_id, object_version_id,
    object_sha256_hex) references ehr.patient_entry_documents (id, patient_id, object_version_id, sha256_hex)
    on delete restrict,
  constraint patient_entry_document_scan_events_idempotency_uq unique (document_id, idempotency_key),
  constraint patient_entry_document_scan_events_reason_check
    check (event_type not in ('rejected', 'failed') or reason_code is not null),
  constraint patient_entry_document_scan_events_clean_type_check
    check (event_type <> 'clean' or detected_media_type in ('image/jpeg', 'image/png', 'application/pdf'))
);
create index patient_entry_document_scan_events_document_idx
  on ehr.patient_entry_document_scan_events (document_id, created_at desc, id desc);
create trigger patient_entry_document_scan_events_no_change
  before update or delete on ehr.patient_entry_document_scan_events
  for each row execute function platform.reject_mutation();
create trigger patient_entry_document_scan_events_no_truncate
  before truncate on ehr.patient_entry_document_scan_events
  for each statement execute function platform.reject_mutation();

create view ehr.patient_entry_documents_effective
with (security_invoker = true, security_barrier = true)
as
select document_row.id,
       document_row.patient_id,
       document_row.entry_id,
       document_row.created_by_account_id,
       document_row.original_file_name,
       document_row.storage_bucket,
       document_row.storage_key,
       document_row.object_version_id,
       document_row.declared_media_type,
       latest_scan.detected_media_type,
       document_row.size_bytes,
       document_row.sha256_hex,
       coalesce(latest_scan.event_type, 'pending') as scan_status,
       case
         when document_row.status = 'uploaded' and latest_scan.event_type = 'clean' then 'available'
         when latest_scan.event_type = 'rejected' then 'rejected'
         else document_row.status
       end as status,
       document_row.row_version,
       document_row.created_at,
       document_row.uploaded_at,
       document_row.updated_at
from ehr.patient_entry_documents document_row
left join lateral (
  select scan.event_type, scan.detected_media_type
    from ehr.patient_entry_document_scan_events scan
   where scan.document_id = document_row.id
     and scan.object_version_id = document_row.object_version_id
     and scan.object_sha256_hex = document_row.sha256_hex
   order by scan.created_at desc, scan.id desc
   limit 1
) latest_scan on true;

create table ehr.patient_entry_document_extractions
  (like ehr.patient_attachment_extractions including defaults including constraints including indexes);
alter table ehr.patient_entry_document_extractions
  add constraint patient_entry_document_extractions_object_fk foreign key (file_id, patient_id, object_version_id,
    sha256_hex) references ehr.patient_entry_documents (id, patient_id, object_version_id, sha256_hex)
    on delete restrict;

alter table ehr.patient_entry_documents enable row level security;
alter table ehr.patient_entry_documents force row level security;
alter table ehr.patient_entry_document_scan_events enable row level security;
alter table ehr.patient_entry_document_scan_events force row level security;
alter table ehr.patient_entry_document_extractions enable row level security;
alter table ehr.patient_entry_document_extractions force row level security;
do $$
begin
  execute format('create policy patient_entry_documents_owner on ehr.patient_entry_documents for all '
    || 'using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy patient_entry_document_scan_events_owner on ehr.patient_entry_document_scan_events '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy patient_entry_document_extractions_owner on ehr.patient_entry_document_extractions '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
end
$$;
-- A file is read where its record is (0116's rule; the record's own read
-- policy applies to the subquery), once confirmed, or by the patient, who
-- confirms their own. A removed record's files are read by nobody.
create policy patient_entry_documents_read on ehr.patient_entry_documents
  for select using (
    exists (select 1 from ehr.patient_entries entry
             where entry.id = patient_entry_documents.entry_id and entry.patient_id = patient_entry_documents.patient_id
               and entry.status = 'active')
    and ehr.imported_record_read_context(patient_id)
    and (status = 'uploaded' or ehr.patient_self_context(patient_id)));
create policy patient_entry_document_scan_events_read on ehr.patient_entry_document_scan_events
  for select using (
    exists (select 1 from ehr.patient_entry_documents document_row
             where document_row.id = patient_entry_document_scan_events.document_id
               and document_row.patient_id = patient_entry_document_scan_events.patient_id));
-- The patient chat's reading of a file: the patient's own fresh session, of a
-- file available (uploaded and clean) on that exact object.
create policy patient_entry_document_extractions_self on ehr.patient_entry_document_extractions
  using (ehr.patient_self_context(patient_id) and exists (select 1 from ehr.patient_entry_documents_effective file_row
    where file_row.id = patient_entry_document_extractions.file_id
      and file_row.patient_id = patient_entry_document_extractions.patient_id and file_row.status = 'available'
      and file_row.object_version_id = patient_entry_document_extractions.object_version_id
      and file_row.sha256_hex = patient_entry_document_extractions.sha256_hex))
  with check (ehr.patient_self_context(patient_id) and exists (select 1 from ehr.patient_entry_documents_effective file_row
    where file_row.id = patient_entry_document_extractions.file_id
      and file_row.patient_id = patient_entry_document_extractions.patient_id and file_row.status = 'available'
      and file_row.object_version_id = patient_entry_document_extractions.object_version_id
      and file_row.sha256_hex = patient_entry_document_extractions.sha256_hex));
revoke all on ehr.patient_entry_documents, ehr.patient_entry_document_scan_events,
  ehr.patient_entry_documents_effective, ehr.patient_entry_document_extractions from public;

-- 3a. The patient asks for an upload link for one file (fresh patient-self context).
create function ehr.create_my_patient_entry_document_intent(requested_entry_id uuid, requested_file_name text,
  requested_media_type text, requested_size_bytes bigint, requested_sha256_hex text, requested_idempotency_key text,
  requested_request_sha256 text, requested_storage_bucket text, requested_storage_key text)
returns table (outcome text, document_id uuid, document_status text, document_scan_status text,
  document_storage_bucket text, document_storage_key text, document_media_type text, document_size_bytes bigint,
  document_sha256_hex text, retry_after_seconds integer)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  claimed_patient text := nullif(current_setting('app.patient_id', true), '');
  claimed_account text := nullif(current_setting('app.account_id', true), '');
  claimed_subject text := nullif(current_setting('app.actor_subject', true), '');
  patient_id_value uuid;
  existing ehr.patient_entry_documents%rowtype;
  entry_status text;
  lagos_midnight timestamptz;
  opened_today bigint;
  on_entry bigint;
  current_status text;
  current_scan text;
begin
  if claimed_patient is null or claimed_patient !~ uuid_shape or claimed_account is null
     or claimed_account !~ uuid_shape or platform.current_correlation_id() is null
     or not ehr.patient_self_context(claimed_patient::uuid) then
    raise exception using errcode = '42501', message = 'Patient self context is required';
  end if;
  patient_id_value := claimed_patient::uuid;
  if requested_entry_id is null
     or requested_file_name is null or length(requested_file_name) not between 1 and 255
     or requested_file_name ~ '[\u0001-\u001f\u007f-\u009f]' or requested_file_name <> btrim(requested_file_name)
     or requested_media_type is null or requested_media_type not in ('image/jpeg', 'image/png', 'application/pdf')
     or requested_size_bytes is null or requested_size_bytes not between 1 and 10485760
     or requested_sha256_hex is null or requested_sha256_hex !~ '^[0-9a-f]{64}$'
     or requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or requested_request_sha256 is null or requested_request_sha256 !~ '^[a-f0-9]{64}$'
     or requested_storage_bucket is null or length(requested_storage_bucket) not between 3 and 63
     or requested_storage_key is null
     or requested_storage_key !~ '^clinical/objects/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'PATIENT_DOCUMENT_INVALID';
  end if;
  -- 0116's lock: one patient's adds, removals and files one at a time.
  perform pg_advisory_xact_lock(hashtextextended('patient-entry:' || patient_id_value::text, 0));
  select file_row.* into existing from ehr.patient_entry_documents file_row
   where file_row.patient_id = patient_id_value and file_row.idempotency_key = requested_idempotency_key;
  if found then
    if existing.request_sha256 <> requested_request_sha256 then
      return query select 'key_reused'::text, null::uuid, null::text, null::text, null::text, null::text, null::text,
        null::bigint, null::text, null::integer;
      return;
    end if;
    select entry.status into entry_status from ehr.patient_entries entry
     where entry.id = existing.entry_id and entry.patient_id = patient_id_value;
    if entry_status is distinct from 'active' then
      return query select 'entry_not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
        null::text, null::bigint, null::text, null::integer;
      return;
    end if;
    select effective.status, effective.scan_status into current_status, current_scan
      from ehr.patient_entry_documents_effective effective where effective.id = existing.id;
    return query select case when existing.status = 'initiated' then 'replayed' else 'already_uploaded' end,
      existing.id, current_status, current_scan, existing.storage_bucket, existing.storage_key,
      existing.declared_media_type, existing.size_bytes, existing.sha256_hex::text, null::integer;
    return;
  end if;
  select entry.status into entry_status from ehr.patient_entries entry
   where entry.id = requested_entry_id and entry.patient_id = patient_id_value;
  if entry_status is distinct from 'active' then
    return query select 'entry_not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
      null::text, null::bigint, null::text, null::integer;
    return;
  end if;
  -- The day in Lagos: every link opened since its midnight, any record's.
  lagos_midnight := date_trunc('day', clock_timestamp() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos';
  select count(*) into opened_today from ehr.patient_entry_documents file_row
   where file_row.patient_id = patient_id_value and file_row.created_at >= lagos_midnight;
  if opened_today >= 10 then
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'patient', claimed_subject, claimed_account::uuid, patient_id_value,
      'ehr.patient-entry.document.upload-intent', 'denied', 'patient-entry-document', null, 'patient-self',
      'application', 'ehr-api', jsonb_build_object('reason', 'daily_limit', 'limit', 10));
    return query select 'daily_limit'::text, null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::bigint, null::text,
      greatest(1, ceil(extract(epoch from (lagos_midnight + interval '1 day') - clock_timestamp())))::integer;
    return;
  end if;
  select count(*) into on_entry from ehr.patient_entry_documents file_row where file_row.entry_id = requested_entry_id;
  if on_entry >= 5 then
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'patient', claimed_subject, claimed_account::uuid, patient_id_value,
      'ehr.patient-entry.document.upload-intent', 'denied', 'patient-entry-document', null, 'patient-self',
      'application', 'ehr-api', jsonb_build_object('reason', 'entry_limit', 'limit', 5));
    return query select 'entry_full'::text, null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::bigint, null::text, null::integer;
    return;
  end if;
  insert into ehr.patient_entry_documents (patient_id, entry_id, created_by_account_id, idempotency_key,
    request_sha256, original_file_name, storage_bucket, storage_key, declared_media_type, size_bytes, sha256_hex)
  values (patient_id_value, requested_entry_id, claimed_account::uuid, requested_idempotency_key,
    requested_request_sha256, requested_file_name, requested_storage_bucket, requested_storage_key,
    requested_media_type, requested_size_bytes, requested_sha256_hex)
  returning * into existing;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', claimed_subject, claimed_account::uuid, patient_id_value,
    'ehr.patient-entry.document.upload-intent', 'success', 'patient-entry-document', existing.id::text,
    'patient-self', 'application', 'ehr-api', jsonb_build_object('entryId', existing.entry_id,
      'mediaType', existing.declared_media_type, 'sizeBytes', existing.size_bytes));
  return query select 'created'::text, existing.id, existing.status, 'pending'::text, existing.storage_bucket,
    existing.storage_key, existing.declared_media_type, existing.size_bytes, existing.sha256_hex::text, null::integer;
end
$$;

-- 3b. The patient confirms one file, after ehr-api read the stored object.
create function ehr.complete_my_patient_entry_document(requested_entry_id uuid, requested_document_id uuid,
  requested_object_version_id text, requested_size_bytes bigint, requested_sha256_hex text)
returns table (outcome text, document_id uuid, document_status text, document_scan_status text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  claimed_patient text := nullif(current_setting('app.patient_id', true), '');
  claimed_account text := nullif(current_setting('app.account_id', true), '');
  claimed_subject text := nullif(current_setting('app.actor_subject', true), '');
  patient_id_value uuid;
  existing ehr.patient_entry_documents%rowtype;
  entry_status text;
  current_status text;
  current_scan text;
begin
  if claimed_patient is null or claimed_patient !~ uuid_shape or claimed_account is null
     or claimed_account !~ uuid_shape or platform.current_correlation_id() is null
     or not ehr.patient_self_context(claimed_patient::uuid) then
    raise exception using errcode = '42501', message = 'Patient self context is required';
  end if;
  patient_id_value := claimed_patient::uuid;
  if requested_entry_id is null or requested_document_id is null
     or length(coalesce(requested_object_version_id, '')) not between 1 and 1024
     or requested_size_bytes is null or requested_size_bytes < 1
     or coalesce(requested_sha256_hex, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'PATIENT_DOCUMENT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-entry:' || patient_id_value::text, 0));
  select file_row.* into existing from ehr.patient_entry_documents file_row
   where file_row.id = requested_document_id and file_row.patient_id = patient_id_value
     and file_row.entry_id = requested_entry_id and file_row.created_by_account_id = claimed_account::uuid
     for update;
  if found then
    select entry.status into entry_status from ehr.patient_entries entry
     where entry.id = existing.entry_id and entry.patient_id = patient_id_value;
  end if;
  if not found or entry_status is distinct from 'active' then
    return query select 'not_found'::text, requested_document_id, null::text, null::text;
    return;
  end if;
  if existing.status = 'uploaded' then
    select effective.status, effective.scan_status into current_status, current_scan
      from ehr.patient_entry_documents_effective effective where effective.id = existing.id;
    return query select 'already_uploaded'::text, existing.id, current_status, current_scan;
    return;
  end if;
  if requested_size_bytes <> existing.size_bytes or requested_sha256_hex <> existing.sha256_hex then
    return query select 'mismatch'::text, existing.id, existing.status, 'pending'::text;
    return;
  end if;
  update ehr.patient_entry_documents file_row
     set status = 'uploaded', object_version_id = requested_object_version_id, uploaded_at = clock_timestamp(),
         updated_at = clock_timestamp(), row_version = file_row.row_version + 1
   where file_row.id = existing.id
  returning file_row.* into existing;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', claimed_subject, claimed_account::uuid, patient_id_value,
    'ehr.patient-entry.document.upload-complete', 'success', 'patient-entry-document', existing.id::text,
    'patient-self', 'application', 'ehr-api', jsonb_build_object('entryId', existing.entry_id,
      'mediaType', existing.declared_media_type, 'sizeBytes', existing.size_bytes));
  return query select 'uploaded'::text, existing.id, existing.status, 'pending'::text;
end
$$;

-- 4. The scanner's three commands, as 0105 and 0009 make them for staff
-- documents, with their refusals word for word.
create function ehr.resolve_patient_entry_document_scan_target(
  requested_storage_bucket text,
  requested_storage_key text,
  requested_object_version_id text,
  requested_correlation_id text
)
returns table (
  document_id uuid,
  object_version_id text,
  sha256_hex text,
  status text,
  declared_media_type text,
  latest_event_type text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  file_row ehr.patient_entry_documents%rowtype;
  latest_event text;
begin
  if actor_account is null
     or not auth.account_has_active_role(actor_account, 'document_scanner')
     or requested_correlation_id is null
     or requested_correlation_id is distinct from platform.current_correlation_id() then
    raise exception using errcode = '42501', message = 'Authorized document scanner context is required';
  end if;
  if length(coalesce(requested_storage_bucket, '')) not between 3 and 63
     or length(coalesce(requested_storage_key, '')) not between 1 and 1024
     or length(coalesce(requested_object_version_id, '')) not between 1 and 1024 then
    raise exception using errcode = '22023', message = 'Invalid document scan target';
  end if;

  -- One row per key (patient_entry_documents_object_key_uq).
  select * into file_row
    from ehr.patient_entry_documents candidate
   where candidate.storage_bucket = requested_storage_bucket
     and candidate.storage_key = requested_storage_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'Document not found';
  end if;
  if file_row.status = 'initiated' then
    raise exception using errcode = '55000', message = 'Only an uploaded document can be scanned';
  end if;
  if file_row.object_version_id is distinct from requested_object_version_id then
    raise exception using errcode = '55000', message = 'Scan result does not match the current immutable document object';
  end if;
  if exists (select 1 from ehr.patient_entry_document_scan_events terminal_event
              where terminal_event.document_id = file_row.id
                and terminal_event.object_version_id = file_row.object_version_id
                and terminal_event.object_sha256_hex = file_row.sha256_hex
                and terminal_event.event_type in ('clean', 'rejected')) then
    raise exception using errcode = '55000', message = 'Document object scan has already reached a terminal result';
  end if;

  select scan_event.event_type into latest_event
    from ehr.patient_entry_document_scan_events scan_event
   where scan_event.document_id = file_row.id
     and scan_event.object_version_id = file_row.object_version_id
     and scan_event.object_sha256_hex = file_row.sha256_hex
   order by scan_event.created_at desc, scan_event.id desc
   limit 1;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    requested_correlation_id, 'workload', actor_subject, actor_account,
    file_row.patient_id, 'ehr.document.scan-target.resolve', 'success', 'patient-entry-document', file_row.id::text,
    'operations-security', 'application', 'ehr-document-scanner',
    jsonb_build_object('object_version_id', file_row.object_version_id, 'latest_event_type', latest_event)
  );

  return query select file_row.id, file_row.object_version_id, file_row.sha256_hex::text,
    file_row.status, file_row.declared_media_type, latest_event;
end
$$;

create function ehr.list_patient_entry_documents_awaiting_scan(
  requested_older_than_seconds integer,
  requested_max_rows integer,
  requested_correlation_id text
)
returns table (
  document_id uuid,
  storage_bucket text,
  storage_key text,
  object_version_id text,
  sha256_hex text,
  declared_media_type text,
  updated_at timestamptz,
  latest_event_type text,
  scan_started_count integer,
  last_scan_started_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  listed record;
  listed_ids uuid[] := array[]::uuid[];
begin
  if actor_account is null
     or not auth.account_has_active_role(actor_account, 'document_scanner')
     or requested_correlation_id is null
     or requested_correlation_id is distinct from platform.current_correlation_id() then
    raise exception using errcode = '42501', message = 'Authorized document scanner context is required';
  end if;
  if requested_older_than_seconds is null or requested_older_than_seconds not between 0 and 31536000
     or requested_max_rows is null or requested_max_rows not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid scan target list request';
  end if;

  for listed in
    select candidate.id, candidate.storage_bucket, candidate.storage_key, candidate.object_version_id,
           candidate.sha256_hex::text as sha256_hex, candidate.declared_media_type, candidate.updated_at,
           latest.event_type as latest_event_type, started.started_count, started.last_started_at
      from ehr.patient_entry_documents candidate
      left join lateral (
        select scan_event.event_type
          from ehr.patient_entry_document_scan_events scan_event
         where scan_event.document_id = candidate.id
           and scan_event.object_version_id = candidate.object_version_id
           and scan_event.object_sha256_hex = candidate.sha256_hex
         order by scan_event.created_at desc, scan_event.id desc
         limit 1) latest on true
      left join lateral (
        select count(*)::integer as started_count, max(scan_event.created_at) as last_started_at
          from ehr.patient_entry_document_scan_events scan_event
         where scan_event.document_id = candidate.id
           and scan_event.object_version_id = candidate.object_version_id
           and scan_event.object_sha256_hex = candidate.sha256_hex
           and scan_event.event_type = 'scan_started') started on true
     where candidate.status = 'uploaded'
       and candidate.updated_at <= clock_timestamp() - make_interval(secs => requested_older_than_seconds)
       and not exists (
         select 1 from ehr.patient_entry_document_scan_events terminal_event
          where terminal_event.document_id = candidate.id
            and terminal_event.object_version_id = candidate.object_version_id
            and terminal_event.object_sha256_hex = candidate.sha256_hex
            and terminal_event.event_type in ('clean', 'rejected'))
     order by candidate.updated_at, candidate.id
     limit requested_max_rows
  loop
    document_id := listed.id;
    storage_bucket := listed.storage_bucket;
    storage_key := listed.storage_key;
    object_version_id := listed.object_version_id;
    sha256_hex := listed.sha256_hex;
    declared_media_type := listed.declared_media_type;
    updated_at := listed.updated_at;
    latest_event_type := listed.latest_event_type;
    scan_started_count := listed.started_count;
    last_scan_started_at := listed.last_started_at;
    listed_ids := listed_ids || listed.id;
    return next;
  end loop;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    action, outcome, resource_type, purpose_of_use, provenance, source_system, details
  ) values (
    requested_correlation_id, 'workload', actor_subject, actor_account,
    'ehr.document.scan-target.list', 'success', 'patient-entry-document-scan-targets',
    'operations-security', 'application', 'ehr-document-scanner',
    jsonb_build_object('older_than_seconds', requested_older_than_seconds, 'max_rows', requested_max_rows,
      'returned', cardinality(listed_ids), 'document_ids', to_jsonb(listed_ids))
  );
  return;
end
$$;

create function ehr.append_patient_entry_document_scan_event(
  requested_document_id uuid,
  requested_object_version_id text,
  requested_object_sha256_hex text,
  requested_event_type text,
  requested_detected_media_type text,
  requested_scanner_engine text,
  requested_scanner_version text,
  requested_reason_code text,
  requested_idempotency_key text,
  requested_correlation_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  file_row ehr.patient_entry_documents%rowtype;
  existing_event ehr.patient_entry_document_scan_events%rowtype;
  latest_terminal text;
  new_event_id uuid := gen_random_uuid();
begin
  if actor_account is null
     or not auth.account_has_active_role(actor_account, 'document_scanner')
     or requested_correlation_id is null
     or requested_correlation_id is distinct from platform.current_correlation_id() then
    raise exception using errcode = '42501', message = 'Authorized document scanner context is required';
  end if;
  if requested_event_type is null or requested_event_type not in ('scan_started', 'clean', 'rejected', 'failed') then
    raise exception using errcode = '22023', message = 'Invalid document scan event type';
  end if;
  if length(coalesce(requested_object_version_id, '')) not between 1 and 1024
     or coalesce(requested_object_sha256_hex, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Exact scanned object version and SHA-256 are required';
  end if;
  if length(coalesce(requested_idempotency_key, '')) not between 16 and 128
     or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' then
    raise exception using errcode = '22023', message = 'Invalid scanner idempotency key';
  end if;
  if length(coalesce(btrim(requested_scanner_engine), '')) not between 1 and 120
     or length(coalesce(btrim(requested_scanner_version), '')) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'Invalid scanner provenance';
  end if;
  -- A patient file is a JPEG, a PNG or a PDF (the confirm read its first bytes).
  if requested_event_type = 'clean'
     and coalesce(requested_detected_media_type, '') not in ('application/pdf', 'image/jpeg', 'image/png') then
    raise exception using errcode = '22023', message = 'A supported detected media type is required for a clean scan';
  end if;
  if requested_event_type in ('rejected', 'failed')
     and nullif(btrim(requested_reason_code), '') is null then
    raise exception using errcode = '22023', message = 'A reason code is required for unsuccessful scans';
  end if;
  if requested_reason_code is not null
     and (length(requested_reason_code) > 120
       or requested_reason_code !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$') then
    raise exception using errcode = '22023', message = 'Invalid scanner reason code';
  end if;

  -- The owner's lock (its own policy is FOR ALL), never a runtime's.
  select * into file_row
    from ehr.patient_entry_documents candidate
   where candidate.id = requested_document_id
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Document not found';
  end if;
  if file_row.status <> 'uploaded' then
    raise exception using errcode = '55000', message = 'Only an uploaded document can be scanned';
  end if;
  if file_row.object_version_id is distinct from requested_object_version_id
     or file_row.sha256_hex is distinct from requested_object_sha256_hex then
    raise exception using errcode = '55000', message = 'Scan result does not match the current immutable document object';
  end if;

  select * into existing_event
    from ehr.patient_entry_document_scan_events scan_event
   where scan_event.document_id = requested_document_id
     and scan_event.idempotency_key = requested_idempotency_key;
  if found then
    if existing_event.object_version_id = requested_object_version_id
       and existing_event.object_sha256_hex = requested_object_sha256_hex
       and existing_event.event_type = requested_event_type
       and existing_event.detected_media_type is not distinct from requested_detected_media_type
       and existing_event.scanner_engine = requested_scanner_engine
       and existing_event.scanner_version = requested_scanner_version
       and existing_event.reason_code is not distinct from requested_reason_code then
      insert into audit.events (
        correlation_id, actor_type, actor_subject, actor_account_id,
        patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, provenance, source_system, details
      ) values (
        requested_correlation_id, 'workload', actor_subject, actor_account,
        file_row.patient_id, 'ehr.document.scan.idempotent-replay', 'success',
        'patient-entry-document', file_row.id::text, 'operations-security',
        'application', 'ehr-document-scanner',
        jsonb_build_object('original_event_id', existing_event.id, 'event_type', existing_event.event_type,
          'object_version_id', existing_event.object_version_id)
      );
      return existing_event.id;
    end if;
    raise exception using errcode = '23505', message = 'Scanner idempotency key payload mismatch';
  end if;

  select scan_event.event_type into latest_terminal
    from ehr.patient_entry_document_scan_events scan_event
   where scan_event.document_id = requested_document_id
     and scan_event.object_version_id = requested_object_version_id
     and scan_event.object_sha256_hex = requested_object_sha256_hex
     and scan_event.event_type in ('clean', 'rejected')
   order by scan_event.created_at desc, scan_event.id desc
   limit 1;
  if latest_terminal is not null then
    raise exception using errcode = '55000', message = 'Document object scan has already reached a terminal result';
  end if;

  insert into ehr.patient_entry_document_scan_events (
    id, document_id, patient_id, created_by, object_version_id, object_sha256_hex, event_type,
    detected_media_type, scanner_engine, scanner_version, reason_code, idempotency_key, correlation_id
  ) values (
    new_event_id, file_row.id, file_row.patient_id, actor_account, requested_object_version_id,
    requested_object_sha256_hex, requested_event_type, requested_detected_media_type,
    requested_scanner_engine, requested_scanner_version, requested_reason_code,
    requested_idempotency_key, requested_correlation_id
  );

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    requested_correlation_id, 'workload', actor_subject, actor_account,
    file_row.patient_id, 'ehr.document.scan.' || requested_event_type,
    case when requested_event_type in ('rejected', 'failed') then 'failure' else 'success' end,
    'patient-entry-document', file_row.id::text, 'operations-security', requested_reason_code,
    'application', 'ehr-document-scanner',
    jsonb_build_object('scanner_engine', requested_scanner_engine, 'scanner_version', requested_scanner_version,
      'object_version_id', requested_object_version_id)
  );

  return new_event_id;
end
$$;

-- 5. Grants (here and in runtime-grants.sql).
revoke all on function ehr.create_my_patient_entry_document_intent(uuid,text,text,bigint,text,text,text,text,text),
  ehr.complete_my_patient_entry_document(uuid,uuid,text,bigint,text),
  ehr.resolve_patient_entry_document_scan_target(text,text,text,text),
  ehr.list_patient_entry_documents_awaiting_scan(integer,integer,text),
  ehr.append_patient_entry_document_scan_event(uuid,text,text,text,text,text,text,text,text,text),
  ehr.patient_entry_documents_guard() from public;
do $$
declare grantee text;
begin
  foreach grantee in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant select on ehr.patient_entry_documents, ehr.patient_entry_document_scan_events, '
        || 'ehr.patient_entry_documents_effective to %I', grantee);
      execute format('grant execute on function '
        || 'ehr.create_my_patient_entry_document_intent(uuid,text,text,bigint,text,text,text,text,text), '
        || 'ehr.complete_my_patient_entry_document(uuid,uuid,text,bigint,text) to %I', grantee);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant select, insert, update on ehr.patient_entry_document_extractions to hid_ehr_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_document_scanner') then
    grant execute on function ehr.resolve_patient_entry_document_scan_target(text,text,text,text),
      ehr.list_patient_entry_documents_awaiting_scan(integer,integer,text),
      ehr.append_patient_entry_document_scan_event(uuid,text,text,text,text,text,text,text,text,text)
      to hid_document_scanner;
  end if;
end
$$;

comment on table ehr.patient_entry_documents is
  'Photos and PDFs a patient added to a record of their own (0117), stored as staff documents are (clinical/objects/<uuid>). Written only by the patient''s intent and confirm commands; read where the record is read, once confirmed; a removed record''s files are read by nobody and kept.';
comment on table ehr.patient_entry_document_scan_events is
  'The document scanner''s results for files patients added (0117), append-only, bound to the confirmed object version and SHA-256.';
comment on view ehr.patient_entry_documents_effective is
  'Files patients added with the latest scan result on their bound object (0117), as ehr.documents_effective: available once uploaded and clean, rejected once rejected.';
comment on table ehr.patient_entry_document_extractions is
  'The patient chat''s machine reading of a file the patient added (0117), as ehr.patient_document_extractions.';
comment on function ehr.create_my_patient_entry_document_intent(uuid,text,text,bigint,text,text,text,text,text) is
  'Opens an upload for one file on a record of the patient of a fresh patient-self transaction: created, replayed (the key before its file is confirmed), already_uploaded, key_reused, entry_not_found, daily_limit (10 a Lagos day, with the seconds to midnight) or entry_full (5 a record).';
comment on function ehr.complete_my_patient_entry_document(uuid,uuid,text,bigint,text) is
  'Confirms one file the uploader of a fresh patient-self transaction stored: uploaded, already_uploaded, mismatch (size or SHA-256) or not_found.';
comment on function ehr.resolve_patient_entry_document_scan_target(text,text,text,text) is
  '0117: the file a patient added that an S3 object version belongs to, for the document scanner only (42501 otherwise), with 0105''s refusals. Audited as ehr.document.scan-target.resolve.';
comment on function ehr.list_patient_entry_documents_awaiting_scan(integer,integer,text) is
  '0117: confirmed files patients added with no clean or rejected result on their bound object, for the document scanner only, as 0105''s list. Audited as ehr.document.scan-target.list.';
comment on function ehr.append_patient_entry_document_scan_event(uuid,text,text,text,text,text,text,text,text,text) is
  '0117: records the document scanner''s result for a file a patient added, as 0009''s append does for staff documents, with its refusals.';
comment on function ehr.patient_entry_documents_guard() is
  'A file a patient added changes only from initiated to uploaded, with its object.';

-- 6. Post-checks.
do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  select string_agg(expected.relation_name, ', ') into mismatch
    from (values
      ('ehr.patient_entry_documents', 'patient_entry_documents_owner, patient_entry_documents_read'),
      ('ehr.patient_entry_document_scan_events',
       'patient_entry_document_scan_events_owner, patient_entry_document_scan_events_read'),
      ('ehr.patient_entry_document_extractions',
       'patient_entry_document_extractions_owner, patient_entry_document_extractions_self'))
         expected(relation_name, policies)
   where not exists (select 1 from pg_class relation
                      where relation.oid = expected.relation_name::regclass and relation.relowner = applier
                        and relation.relrowsecurity and relation.relforcerowsecurity)
      or (select string_agg(policy.polname, ', ' order by policy.polname) from pg_policy policy
           where policy.polrelid = expected.relation_name::regclass) is distinct from expected.policies;
  if mismatch is null
     and not exists (select 1 from pg_class relation
                      where relation.oid = 'ehr.patient_entry_documents_effective'::regclass
                        and relation.relowner = applier and relation.relkind = 'v'
                        and relation.reloptions @> array['security_invoker=true', 'security_barrier=true']) then
    mismatch := 'ehr.patient_entry_documents_effective';
  end if;
  if mismatch is not null then
    mismatch := format('owner, forced row-level security or policies of %s', mismatch);
  end if;
  -- The extractions copy has the shape pinned on its source in 0d.
  if mismatch is null
     and pg_temp.patient_entry_documents_shape('ehr.patient_entry_document_extractions'::regclass)
       is distinct from array['b5f232528db89ab9a49c64eb4dff18ec', 'cd808e4010fb29251c10af60e6ade7cc',
                              'e5a41d7f2d45540f7e5808bd495248ca'] then
    mismatch := 'the shape of ehr.patient_entry_document_extractions (columns, CHECKs, indexes)';
  end if;
  if mismatch is null then
    select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
      into mismatch
      from (values
        ('ehr.create_my_patient_entry_document_intent(uuid,text,text,bigint,text,text,text,text,text)', true,
         '8e91b4c8d76342d55f07500b74c44491'),
        ('ehr.complete_my_patient_entry_document(uuid,uuid,text,bigint,text)', true,
         '0ad3ce2c7d4ed33cbc908274a45fd209'),
        ('ehr.resolve_patient_entry_document_scan_target(text,text,text,text)', true,
         '5a2332674e676efc6dab7feb672b144e'),
        ('ehr.list_patient_entry_documents_awaiting_scan(integer,integer,text)', true,
         '93de12341dde488013c4b6d6f642ec79'),
        ('ehr.append_patient_entry_document_scan_event(uuid,text,text,text,text,text,text,text,text,text)', true,
         'a8ca1399365e4072b87ea45202c7c518'),
        ('ehr.patient_entry_documents_guard()', false, '3f6cd4dd96084c02f72a365f0663db04'))
           expected(proc, definer, digest)
      left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
     where proc.oid is null or md5(proc.prosrc) is distinct from expected.digest or proc.proowner <> applier
        or proc.prosecdef <> expected.definer
        or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[];
  end if;
  if mismatch is null then
    select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
      into mismatch
      from (values
        ('ehr.create_my_patient_entry(text,text,text,date,text,text,text)', '280b73ca5151f73ffac6256bf81110af'),
        ('ehr.withdraw_my_patient_entry(uuid)', '172d17d8abb9d237ba4fa6fd06ddeb21'),
        ('ehr.resolve_document_scan_target(text,text,text,text)', 'cb5d1557133df9bb91602b0391e63483'),
        ('ehr.list_documents_awaiting_scan(integer,integer,text)', 'a608c387d89ab3d6940e75cdc9fa8053'),
        ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
        ('ehr.imported_record_read_context(uuid)', 'eabd4af535ecf91508eae6003836e427'),
        ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
        ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '732d11892dd4e27e1ff9093ae3b7de5a'),
        ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
        ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'))
           expected(proc, digest)
      left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
     where md5(proc.prosrc) is distinct from expected.digest;
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0117: post-check failed: %s', mismatch);
  end if;
end
$$;

-- 7. Chat evidence, last: the lock on both chunk tables, up front and
-- bounded, then the source-kind CHECK written through with
-- patient_entry_document.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.patient_evidence_chunks, ehr.staff_evidence_chunks in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0117: the chat search tables stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;
alter table ehr.patient_evidence_chunks
  drop constraint patient_evidence_chunks_source_kind_check,
  add constraint patient_evidence_chunks_source_kind_check check (source_kind in ('note', 'encounter', 'diagnosis',
    'prescription', 'investigation', 'vital', 'import', 'import_version', 'health_profile', 'lab_result', 'attachment',
    'document', 'profile', 'patient_entry', 'patient_entry_document')) not valid;
alter table ehr.patient_evidence_chunks validate constraint patient_evidence_chunks_source_kind_check;
alter table ehr.staff_evidence_chunks
  drop constraint patient_evidence_chunks_source_kind_check,
  add constraint patient_evidence_chunks_source_kind_check check (source_kind in ('note', 'encounter', 'diagnosis',
    'prescription', 'investigation', 'vital', 'import', 'import_version', 'health_profile', 'lab_result', 'attachment',
    'document', 'profile', 'patient_entry', 'patient_entry_document')) not valid;
alter table ehr.staff_evidence_chunks validate constraint patient_evidence_chunks_source_kind_check;

-- The two CHECKs as written, validated; every other CHECK of the two tables
-- as 0067, 0069 and 0070 left it.
do $$
begin
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
         and constraint_row.contype = 'c' and constraint_row.convalidated
         and (constraint_row.conname, md5(pg_get_constraintdef(constraint_row.oid))) in (
           ('patient_evidence_chunks_source_kind_check', 'bfbe0af8c372b45fc68a39cd3a4e4d28'),
           ('patient_evidence_chunks_chunk_no_check', 'd4ae960c85bf97e058d641877bd560ee'),
           ('patient_evidence_chunks_model_id_check', 'afcc38827908755887318a60c0860911'),
           ('patient_evidence_chunks_normalizer_version_check', '6fbc583f60344327350aea0741ee5969'),
           ('patient_evidence_chunks_source_hash_check', '740cf637b654a9226e2d17711debd38c'),
           ('patient_evidence_chunks_source_version_check', 'bc99e4320b5c83fb21491387f477999c'),
           ('staff_evidence_chunks_purpose_of_use_check', 'f889369f4e96e9e156544fc087fb1a72'))) <> 13
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.conrelid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
            and constraint_row.contype = 'c') <> 13 then
    raise exception using errcode = '55000',
      message = '0117: post-check failed: the chunk tables'' CHECKs are not as this file leaves them';
  end if;
end
$$;
drop function pg_temp.patient_entry_documents_holds(oid, oid, aclitem[], "char", text);
drop function pg_temp.patient_entry_documents_shape(regclass);
