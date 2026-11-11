-- 0113 Records processing, publishing a reading as a draft: a staff member
-- holding the patient's dedicated records-processing grant may publish a
-- clinical-note reading into the patient's record as a DRAFT note in one
-- "Imported paper records" encounter per patient per facility; a clinician
-- signs it. Written on the branch of draft PR #221 after it merged staging
-- (0001-0110 present; 0109 and 0110 are live on staging and touch nothing
-- this file reads or replaces). Numbers follow merge order: 0111 is
-- campaign management (#222) and 0112 the 7-day deletion (#226), both on
-- other branches and applied first; neither touches what this file reads
-- or replaces.
--
-- Owner decision (D-Eminence, in chat, relayed by the coordinator on
-- 2026-11-11), verbatim:
--   "Option B: allow drafts, but only for staff given a dedicated "records
--   processing" permission for that patient. Never through shares or PINs.
--   The draft stays a draft until a clinician signs it. This needs database
--   change 0113 and a little more work. but the staff permission should
--   cover publish to patient profile/health ID"
-- The declaration in config/production-schema-compatibility.json is signed
-- separately: its reviewed_by stays empty until the owner signs it there.
--
-- Supersedes, dated 2026-11-11 (0104 and 0108 are applied and immutable;
-- this note is where their decisions are amended):
-- - 0104 D7, "publishing into the chart still needs the publisher's own
--   direct-care write grant", and 0108 D-b, "a view-only share can start,
--   read and check a reading but never publish into the chart, which needs
--   the publisher's own direct-care write": both still hold for every
--   publication that is not a draft, and for every holder of the cover
--   (approval, Access PIN or share). One exception is added: the holder of a
--   DEDICATED records-processing grant (D1 below) may publish a clinical-note
--   reading as a draft note (D2). The cover of 0104 D6-D9 / 0108
--   (identity.records_processing_direct_care_cover) never allows it: it also
--   accepts view_only and clinical_review shares, Access-PIN grants and
--   read-only approvals, which the owner excluded ("Never through shares or
--   PINs").
-- - "the staff permission should cover publish to patient profile/health
--   ID" is read as the patient's record: the dedicated grant publishes any
--   reading into it as a draft clinical note. A Lab, medication or
--   document-only reading becomes a draft note titled by kind, built in
--   ocr-api from the reviewed fields; structured Lab and Pharmacy records
--   still need direct care and are never written under the grant.
--
-- D1 Who: identity.records_processing_write_grant(patient, subject,
--    membership, facility) returns the dedicated grant's id or NULL (sql,
--    STABLE, SECURITY DEFINER, search_path pg_catalog, pg_temp, owned by
--    identity.access_requests' owner; EXECUTE for hid_ocr_runtime and
--    hid_ehr_runtime only). The grant is the one 0072's
--    identity.approve_access_request writes when the patient approves a
--    records-processing access request (0104 D2-D4), and nothing else:
--    - grant: purpose_of_use 'healthcare-operations' (0072 copies it from the
--      request), scope 'write_records', status active, starts_at <= now <
--      expires_at, expires_at at most 24 hours after starts_at (0104 D4), not
--      break_glass, migration_hold_reason null, source_system 'hid' (not
--      imported or seeded), no authorization_method (not the Access PIN),
--      granted_by_patient_id the patient; this patient, this membership, this
--      facility, and the grant's account is the live active account of the
--      subject;
--    - its request (request_id, so never a patient share: a share has none):
--      the same patient, membership and facility, status approved, approved
--      by the patient (approved_by_patient_id), purpose healthcare-operations,
--      scope write_records, 5 to 1440 minutes, not break_glass, not held by
--      the cutover, no authorization_method;
--    - 0104 D8's refusals, at the time of the check: the patient under 18 on
--      that day's Africa/Lagos date or with no date of birth; the membership
--      without ocr.job.write at the facility (auth.membership_has_permission,
--      D2's rule, which also requires the membership and account to be live);
--      the kill switch: healthcare-operations or direct-care inactive (the
--      draft lands in the chart); an active deny directive of the patient for
--      write_records (or every action) naming records processing or direct
--      care (or no purpose) for this facility, organization, staff member or
--      all, read as 0012 reads directives;
--    - the session's own context only: subject, membership and facility must
--      equal platform.current_actor_subject(), current_membership_id() and
--      current_facility_id(), so a runtime cannot ask about another staff
--      member. Any NULL answers NULL (fail closed).
--    Why shares and PINs fail: a share's grant has no request (0095) and a PIN
--    grant carries authorization_method 'patient_access_pin' (0075/0098), and
--    both are direct-care grants; an approved read-only request writes a
--    read_records grant. Each misses at least one condition above.
-- D2 Where: notes need an encounter (ehr.clinical_notes.encounter_id NOT
--    NULL). ehr.encounters gains imported_paper_records boolean NOT NULL
--    DEFAULT false, the fixed marker of the one "Imported paper records"
--    encounter per patient per facility: CHECK (not imported_paper_records or
--    (encounter_type 'other', status 'completed', started_at = ended_at,
--    chief_complaint 'Imported paper records (Migrate)', encounter_number
--    null)), and a UNIQUE index on (patient_id, facility_id) WHERE
--    imported_paper_records. A trigger keeps the flag as inserted (no UPDATE
--    may set or clear it). ehr.imported_paper_records_encounter(patient)
--    (plpgsql, SECURITY INVOKER so row-level security applies to the caller,
--    search_path pg_catalog, pg_temp; EXECUTE for hid_ehr_runtime only)
--    finds or creates it for the session's facility: INSERT ... ON CONFLICT
--    (patient_id, facility_id) WHERE imported_paper_records DO NOTHING, then
--    SELECT; two concurrent callers get the same row (the second waits on the
--    unique index and finds the first's). It refuses (42501
--    RECORDS_PROCESSING_GRANT_REQUIRED) unless the session's purpose is
--    healthcare-operations and D1 names a grant, or the purpose is direct
--    care and ehr.context_allows(patient, facility, 'write_records') (a
--    direct-care publisher of a reading that names no visit). The EHR API
--    adds each such reading to it as a draft clinical note with
--    ehr.ocr_import_provenance, as today; signing stays the direct-care PATCH
--    route.
-- D4 The database keeps it a draft: under healthcare-operations the API is
--    not the only check. ehr.records_processing_draft_guard() (plpgsql,
--    SECURITY INVOKER, search_path pg_catalog, pg_temp, owned by
--    ehr.encounters' owner, EXECUTE for no one) runs BEFORE INSERT, UPDATE
--    and DELETE on ehr.encounters, ehr.clinical_notes and
--    ehr.clinical_note_revisions. Under any other purpose (or none) it does
--    nothing. Under healthcare-operations it refuses (42501
--    RECORDS_PROCESSING_DRAFT_ONLY) every UPDATE and DELETE, and every INSERT
--    that is not, for a patient for whom D1 names the session's dedicated
--    grant at the session's facility: the "Imported paper records" encounter;
--    a draft note in it; the first revision of such a draft note. So a
--    healthcare-operations write grant that D1 does not name (for example
--    one imported from legacy identity), or a direct SQL write under it,
--    cannot sign, change or add anything else. The draft note must be
--    inserted unsigned (signed_at and signed_by null), at revision 1, with
--    the EHR API's paper-record note type and title prefix. (Security
--    reviews of 0113.)
-- D5 One route per publication: ocr.publications gains publication_basis
--    (direct_care or records_processing_grant; NULL for rows written before
--    0113, read as direct care), written by the request and never changed
--    (ocr.publications_basis_fixed()). Every execution attempt is
--    authorized on that basis only, so a reading requested under the grant
--    is never retried as Lab or Pharmacy evidence, nor the reverse.
-- D3 Patient-facing: the patient must not see an empty "Imported paper
--    records" entry. 0030's policy encounters_patient_self_read (patient-self
--    context and status completed) is replaced by the same policy that also
--    requires, for an imported_paper_records encounter, at least one signed or
--    amended note in it: ehr.imported_paper_records_signed(encounter,
--    patient, facility) (sql, STABLE, SECURITY DEFINER, search_path
--    pg_catalog, pg_temp, owned by ehr.encounters' owner; EXECUTE for
--    hid_ehr_runtime and hid_schema_test_runtime, the two roles that read
--    ehr.encounters and so evaluate every SELECT policy on it, as 0030 grants
--    ehr.patient_self_context). A function, not a subquery in the policy, so
--    that reading encounters needs no SELECT on ehr.clinical_notes (the schema
--    test runtime has none). Drafts stay hidden as before (0030's
--    clinical_notes_patient_self_read is unchanged). Staff policies are
--    unchanged.
--
-- Not changed: identity.has_active_consent_grant, the cover (0108's body),
-- create_access_request, approve_access_request and every other body; every
-- other policy, table and grant. 0104's trigger already admits only
-- write or read records-processing requests of at most 24 hours.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0108 applied (0109 and 0110 are not
--    needed and not read; 0108's cover body md5
--    6928763d3b69f0e4b4acf96a6a255736 is the marker, else "0113: 0001-0108
--    must be applied first"); not applied yet (else "0113: already
--    applied"); md5 of the bodies relied on (the platform session helpers,
--    auth.membership_has_permission, identity.has_active_membership,
--    identity.approve_access_request (the grant's writer), the 0104 request
--    trigger, identity.has_active_consent_grant, ehr.context_allows and
--    ehr.patient_self_context); the replaced policy's expression; the columns
--    read with their types and NOT NULLs; identity.access_requests,
--    identity.consent_grants and identity.patients share one owner (O_i) and
--    ehr.encounters and ehr.clinical_notes one owner (O_e); the applier is
--    each or a member that inherits it and may SET ROLE to it; O_i may use
--    the schemas and read auth.accounts, the directive tables, the
--    memberships and the purpose codes and execute the helpers, never through
--    a superuser's bypass; the tables D1 reads as O_i do not force row-level
--    security on it.
-- 1. D1. 2. D2 (column, constraint, index, trigger, function) and D4
--    (the guard function and its three triggers). 3. D3 (function, policy).
-- 4. Owners, REVOKE FROM PUBLIC and grants (here when the roles exist, and in
--    runtime-grants.sql, which gains the same 0113 block).
-- 5. Post-checks: bodies (md5), attributes, owners, ACLs, the column, the
--    constraint (validated), the index, the trigger and the policy.
--
-- Locks: ACCESS EXCLUSIVE on ehr.encounters for the ADD COLUMN (no table
-- rewrite: a constant default), the trigger and the policy; SHARE for the
-- unique index (built in the transaction: it reads every encounter once); the
-- CHECK is added NOT VALID and then validated (SHARE UPDATE EXCLUSIVE, one
-- scan); ACCESS SHARE on the identity tables D1 reads (its SQL body is checked
-- when it is created) and on ehr.clinical_notes (the signed-note test's body);
-- catalog and the session's temporary objects. While it applies, every
-- read and write of ehr.encounters waits; behind a held lock the runner stops
-- after its 5 s lock_timeout with nothing applied.
--
-- Old services on this schema: today's EHR API inserts encounters naming
-- their columns, so the new column takes its default; a patient session sees
-- every encounter it saw before (no imported encounter exists before this
-- release); today's OCR API never calls the new functions and answers 403
-- OCR_PUBLISH_NEEDS_DIRECT_CARE as #221. The new EHR and OCR images are
-- needed for the draft path, and the website for the patient's wording.
-- Applied migrations 0001 through 0110 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0104's and 0108's helper).
create function pg_temp.records_processing_0113_holds(holder oid, object_owner oid, object_acl aclitem[],
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

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  identity_owner oid;
  ehr_owner oid;
begin
  -- a. Prerequisites (0001-0108; 0108's cover body is the marker).
  if to_regprocedure('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'))
        is distinct from '6928763d3b69f0e4b4acf96a6a255736'
     or to_regclass('identity.access_requests') is null
     or to_regclass('identity.consent_grants') is null
     or to_regclass('identity.consent_directives') is null
     or to_regclass('identity.consent_directive_versions') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('identity.purpose_of_use_codes') is null
     or to_regclass('identity.patients') is null
     or to_regclass('auth.accounts') is null
     or to_regclass('ehr.encounters') is null
     or to_regclass('ehr.clinical_notes') is null
     or to_regprocedure('identity.access_requests_records_processing()') is null then
    raise exception using errcode = '55000', message = '0113: 0001-0108 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regprocedure('identity.records_processing_write_grant(uuid,text,uuid,uuid)') is not null
     or to_regprocedure('ehr.imported_paper_records_encounter(uuid)') is not null
     or to_regprocedure('ehr.encounters_imported_paper_records_fixed()') is not null
     or to_regprocedure('ehr.imported_paper_records_signed(uuid,uuid,uuid)') is not null
     or to_regprocedure('ehr.records_processing_draft_guard()') is not null
     or to_regprocedure('ocr.publications_basis_fixed()') is not null
     or exists (select 1 from pg_attribute attribute_row
                 where attribute_row.attrelid = 'ehr.encounters'::regclass
                   and attribute_row.attname = 'imported_paper_records' and not attribute_row.attisdropped) then
    raise exception using errcode = '55000', message = '0113: already applied';
  end if;
  -- c. The bodies relied on, as 0001-0108 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('identity.approve_access_request(uuid)', 'af9482ccb8b9d9aa8486035478ac4e94'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- The policy replaced (0030's) and 0104's trigger body.
  if mismatch is null and (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.encounters'::regclass and policy_row.polname = 'encounters_patient_self_read'
         and policy_row.polcmd = 'r' and policy_row.polpermissive and policy_row.polroles = '{0}'::oid[]
         and pg_get_expr(policy_row.polqual, policy_row.polrelid)
           = '(ehr.patient_self_context(patient_id) AND (status = ''completed''::text))'
         and policy_row.polwithcheck is null) <> 1 then
    mismatch := 'policy ehr.encounters.encounters_patient_self_read';
  end if;
  if mismatch is null and (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'identity.access_requests'::regclass
         and trigger_row.tgname = 'access_requests_records_processing' and trigger_row.tgenabled = 'O') <> 1 then
    mismatch := 'trigger identity.access_requests.access_requests_records_processing';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0113: an object this migration relies on differs from 0001-0108: %s', mismatch);
  end if;
  -- d. The columns read or constrained.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('identity.access_requests', 'id', 'uuid', true),
      ('identity.access_requests', 'patient_id', 'uuid', true),
      ('identity.access_requests', 'membership_id', 'uuid', true),
      ('identity.access_requests', 'facility_id', 'uuid', false),
      ('identity.access_requests', 'scope', 'text', true),
      ('identity.access_requests', 'status', 'text', true),
      ('identity.access_requests', 'requested_duration_minutes', 'integer', true),
      ('identity.access_requests', 'purpose_of_use', 'text', false),
      ('identity.access_requests', 'break_glass', 'boolean', true),
      ('identity.access_requests', 'migration_hold_reason', 'text', false),
      ('identity.access_requests', 'approved_by_patient_id', 'uuid', false),
      ('identity.access_requests', 'authorization_method', 'text', false),
      ('identity.consent_grants', 'id', 'uuid', true),
      ('identity.consent_grants', 'request_id', 'uuid', false),
      ('identity.consent_grants', 'patient_id', 'uuid', true),
      ('identity.consent_grants', 'account_id', 'uuid', true),
      ('identity.consent_grants', 'membership_id', 'uuid', true),
      ('identity.consent_grants', 'facility_id', 'uuid', false),
      ('identity.consent_grants', 'scope', 'text', true),
      ('identity.consent_grants', 'status', 'text', true),
      ('identity.consent_grants', 'granted_by_patient_id', 'uuid', false),
      ('identity.consent_grants', 'starts_at', 'timestamp with time zone', true),
      ('identity.consent_grants', 'expires_at', 'timestamp with time zone', true),
      ('identity.consent_grants', 'break_glass', 'boolean', true),
      ('identity.consent_grants', 'migration_hold_reason', 'text', false),
      ('identity.consent_grants', 'source_system', 'text', true),
      ('identity.consent_grants', 'purpose_of_use', 'text', false),
      ('identity.consent_grants', 'authorization_method', 'text', false),
      ('auth.accounts', 'id', 'uuid', true),
      ('auth.accounts', 'subject', 'text', true),
      ('auth.accounts', 'status', 'text', true),
      ('auth.accounts', 'disabled_until', 'timestamp with time zone', false),
      ('identity.patients', 'id', 'uuid', true),
      ('identity.patients', 'dob', 'date', false),
      ('identity.purpose_of_use_codes', 'code', 'text', true),
      ('identity.purpose_of_use_codes', 'active', 'boolean', true),
      ('identity.consent_directives', 'id', 'uuid', true),
      ('identity.consent_directives', 'patient_id', 'uuid', true),
      ('identity.consent_directives', 'current_version', 'integer', true),
      ('identity.consent_directive_versions', 'directive_id', 'uuid', true),
      ('identity.consent_directive_versions', 'version_no', 'integer', true),
      ('identity.consent_directive_versions', 'status', 'text', true),
      ('identity.consent_directive_versions', 'provision_type', 'text', true),
      ('identity.consent_directive_versions', 'starts_at', 'timestamp with time zone', true),
      ('identity.consent_directive_versions', 'expires_at', 'timestamp with time zone', false),
      ('identity.consent_directive_versions', 'facility_id', 'uuid', false),
      ('identity.consent_directive_versions', 'actions', 'text[]', true),
      ('identity.consent_directive_versions', 'purposes', 'text[]', true),
      ('identity.consent_directive_versions', 'grantee_type', 'text', true),
      ('identity.consent_directive_versions', 'grantee_id', 'uuid', false),
      ('identity.staff_facility_memberships', 'id', 'uuid', true),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid', false),
      ('identity.staff_facility_memberships', 'organization_id', 'uuid', true),
      ('identity.staff_facility_memberships', 'staff_id', 'uuid', true),
      ('ehr.encounters', 'id', 'uuid', true),
      ('ehr.encounters', 'patient_id', 'uuid', true),
      ('ehr.encounters', 'facility_id', 'uuid', true),
      ('ehr.encounters', 'created_by', 'uuid', true),
      ('ehr.encounters', 'created_by_membership_id', 'uuid', true),
      ('ehr.encounters', 'encounter_number', 'text', false),
      ('ehr.encounters', 'encounter_type', 'text', true),
      ('ehr.encounters', 'status', 'text', true),
      ('ehr.encounters', 'started_at', 'timestamp with time zone', true),
      ('ehr.encounters', 'ended_at', 'timestamp with time zone', false),
      ('ehr.encounters', 'chief_complaint', 'text', false),
      ('ehr.clinical_notes', 'encounter_id', 'uuid', true),
      ('ehr.clinical_notes', 'patient_id', 'uuid', true),
      ('ehr.clinical_notes', 'facility_id', 'uuid', true),
      ('ehr.clinical_notes', 'status', 'text', true))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0113: a column this migration relies on differs from 0001-0108: %s', mismatch);
  end if;
  -- e. Ownership and privileges, never through a superuser's bypass.
  identity_owner := (select relation.relowner from pg_class relation
                      where relation.oid = 'identity.access_requests'::regclass);
  ehr_owner := (select relation.relowner from pg_class relation where relation.oid = 'ehr.encounters'::regclass);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not owned by %s', relation.oid::regclass, pg_get_userbyid(expected_owner)) as what
        from (values ('identity.patients'::regclass, identity_owner), ('identity.consent_grants'::regclass, identity_owner),
                     ('ehr.clinical_notes'::regclass, ehr_owner)) wanted(relation_oid, expected_owner)
        join pg_class relation on relation.oid = wanted.relation_oid
       where relation.relowner <> wanted.expected_owner
      union all
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(owner_id))
        from (values (identity_owner), (ehr_owner)) owners(owner_id)
       where applier <> owner_id
         and not (pg_has_role(applier, owner_id, 'USAGE') and pg_has_role(applier, owner_id, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(wanted.owner_id), wanted.privilege, namespace.nspname)
        from (values ('identity', 'CREATE', identity_owner), ('identity', 'USAGE', identity_owner),
                     ('auth', 'USAGE', identity_owner), ('platform', 'USAGE', identity_owner),
                     ('ehr', 'CREATE', ehr_owner), ('ehr', 'USAGE', ehr_owner)) wanted(schema_name, privilege, owner_id)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.records_processing_0113_holds(wanted.owner_id, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks SELECT on %s', pg_get_userbyid(identity_owner), relation.oid::regclass)
        from pg_class relation
       where relation.oid in ('auth.accounts'::regclass, 'identity.consent_directives'::regclass,
           'identity.consent_directive_versions'::regclass, 'identity.staff_facility_memberships'::regclass,
           'identity.purpose_of_use_codes'::regclass)
         and not pg_temp.records_processing_0113_holds(identity_owner, relation.relowner, relation.relacl, 'r', 'SELECT')
      union all
      select format('%s forces row-level security on its owner', relation.oid::regclass)
        from pg_class relation
       where relation.oid in ('identity.patients'::regclass, 'identity.access_requests'::regclass,
           'identity.consent_grants'::regclass, 'auth.accounts'::regclass, 'identity.consent_directives'::regclass,
           'identity.consent_directive_versions'::regclass, 'identity.staff_facility_memberships'::regclass,
           'identity.purpose_of_use_codes'::regclass)
         and relation.relforcerowsecurity
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(identity_owner), proc.oid::regprocedure)
        from (values ('platform.current_actor_subject()'), ('platform.current_membership_id()'),
                     ('platform.current_facility_id()'), ('auth.membership_has_permission(text,uuid,uuid,text)'))
               wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.records_processing_0113_holds(identity_owner, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0113: missing privileges: %s', mismatch);
  end if;
  raise notice '0113: owners checked: identity.access_requests=%, ehr.encounters=%, applier=%',
    pg_get_userbyid(identity_owner), pg_get_userbyid(ehr_owner), current_user;
end
$$;

-- 1. D1: the dedicated records-processing write grant.
create function identity.records_processing_write_grant(
  request_patient_id uuid,
  request_subject text,
  request_membership_id uuid,
  request_facility_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select grant_row.id
    from identity.consent_grants grant_row
    join auth.accounts account_row on account_row.id = grant_row.account_id
    join identity.access_requests request_row on request_row.id = grant_row.request_id
    join identity.patients patient_row on patient_row.id = grant_row.patient_id
   where request_patient_id is not null
     -- The session's own context only.
     and request_subject = platform.current_actor_subject()
     and request_membership_id = platform.current_membership_id()
     and request_facility_id = platform.current_facility_id()
     -- 0104 D1 and D8: both purposes active (the kill switch).
     and (select count(*) from identity.purpose_of_use_codes purpose
           where purpose.code in ('healthcare-operations', 'direct-care') and purpose.active) = 2
     -- This patient, this membership at this facility, this live account.
     and grant_row.patient_id = request_patient_id
     and grant_row.membership_id = request_membership_id
     and grant_row.facility_id = request_facility_id
     and account_row.subject = request_subject
     and account_row.status = 'active'
     and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
     -- The dedicated grant (0104 D2-D4, written by 0072's approval): records
     -- processing, write, active, at most 24 hours, not break-glass, not held,
     -- not imported or seeded, not the Access PIN, granted by the patient.
     and grant_row.purpose_of_use = 'healthcare-operations'
     and grant_row.scope = 'write_records'
     and grant_row.status = 'active'
     and not grant_row.break_glass
     and grant_row.migration_hold_reason is null
     and grant_row.source_system = 'hid'
     and grant_row.authorization_method is null
     and grant_row.granted_by_patient_id = grant_row.patient_id
     and grant_row.starts_at <= current_timestamp
     and grant_row.expires_at > current_timestamp
     and grant_row.expires_at <= grant_row.starts_at + interval '24 hours'
     -- Its request: the patient approved this membership's records-processing
     -- write request (a share has no request; a PIN request carries an
     -- authorization method).
     and request_row.patient_id = grant_row.patient_id
     and request_row.membership_id = grant_row.membership_id
     and request_row.facility_id = grant_row.facility_id
     and request_row.status = 'approved'
     and request_row.approved_by_patient_id = grant_row.patient_id
     and request_row.purpose_of_use = 'healthcare-operations'
     and request_row.scope = 'write_records'
     and request_row.requested_duration_minutes between 5 and 1440
     and not request_row.break_glass
     and request_row.migration_hold_reason is null
     and request_row.authorization_method is null
     -- 0104 D8: 18 or over today in Africa/Lagos, with a date of birth on record.
     and patient_row.dob is not null
     and patient_row.dob <= ((current_timestamp at time zone 'Africa/Lagos')::date - interval '18 years')::date
     -- 0104 D8: the membership may run OCR jobs (D2's rule, at each use).
     and coalesce(auth.membership_has_permission(request_subject, request_membership_id, request_facility_id,
           'ocr.job.write'), false)
     -- 0104 D8: no active deny directive of the patient for writing under
     -- records processing or direct care (0012's reading).
     and not exists (
       select 1
         from identity.consent_directives directive
         join identity.consent_directive_versions directive_version
           on directive_version.directive_id = directive.id
          and directive_version.version_no = directive.current_version
         join identity.staff_facility_memberships membership
           on membership.id = request_membership_id
          and membership.facility_id = request_facility_id
        where directive.patient_id = request_patient_id
          and directive_version.status = 'active'
          and directive_version.provision_type = 'deny'
          and directive_version.starts_at <= current_timestamp
          and (directive_version.expires_at is null or directive_version.expires_at > current_timestamp)
          and (directive_version.facility_id is null or directive_version.facility_id = request_facility_id)
          and (cardinality(directive_version.actions) = 0 or 'write_records' = any(directive_version.actions))
          and (cardinality(directive_version.purposes) = 0
               or directive_version.purposes && array['healthcare-operations', 'direct-care']::text[])
          and (
            directive_version.grantee_type = 'all'
            or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = request_facility_id)
            or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = membership.organization_id)
            or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = membership.staff_id)
          )
     )
   order by grant_row.expires_at desc, grant_row.id
   limit 1
$$;

comment on function identity.records_processing_write_grant(uuid, text, uuid, uuid) is
  '0113 (owner decision of 2026-11-11, Option B): the patient''s dedicated records-processing grant (an approved healthcare-operations write_records access request of at most 24 hours, approved by the patient, source_system ''hid'', not break-glass, not the Access PIN, not a share) of the session''s own subject, membership and facility, or NULL: none for a patient under 18 or with no date of birth, a membership without ocr.job.write, an inactive healthcare-operations or direct-care code, or a deny directive for writing under records processing or direct care. The only check that lets a staff member publish an OCR reading as a draft note. Never the cover (identity.records_processing_direct_care_cover).';

-- 2. D2: the "Imported paper records" encounter.
alter table ehr.encounters add column imported_paper_records boolean not null default false;

alter table ehr.encounters add constraint encounters_imported_paper_records_shape check (
  not imported_paper_records
  or (encounter_type = 'other' and status = 'completed' and ended_at = started_at
      and chief_complaint = 'Imported paper records (Migrate)' and encounter_number is null)
) not valid;
alter table ehr.encounters validate constraint encounters_imported_paper_records_shape;

create unique index encounters_imported_paper_records_key on ehr.encounters (patient_id, facility_id)
  where imported_paper_records;

comment on column ehr.encounters.imported_paper_records is
  '0113: the one "Imported paper records" encounter of a patient at a facility (unique), which holds the draft notes published from paper records under the patient''s dedicated records-processing grant. Shown to the patient only once it holds a signed note.';

create function ehr.encounters_imported_paper_records_fixed()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.imported_paper_records is distinct from old.imported_paper_records then
    raise exception using errcode = '55000', message = 'IMPORTED_PAPER_RECORDS_FIXED';
  end if;
  return new;
end
$$;

comment on function ehr.encounters_imported_paper_records_fixed() is
  '0113: an encounter''s imported_paper_records flag keeps the value it was inserted with.';

create trigger encounters_imported_paper_records_fixed
  before update of imported_paper_records on ehr.encounters
  for each row execute function ehr.encounters_imported_paper_records_fixed();

create function ehr.imported_paper_records_encounter(request_patient_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_purpose text := platform.current_purpose_of_use();
  created_at_value timestamptz := clock_timestamp();
  encounter_id_value uuid;
begin
  if request_patient_id is null or actor_subject is null or actor_account is null
     or actor_membership is null or actor_facility is null
     or not coalesce(
       (actor_purpose = 'healthcare-operations'
        and identity.records_processing_write_grant(request_patient_id, actor_subject, actor_membership,
              actor_facility) is not null)
       or (actor_purpose = 'direct-care' and ehr.context_allows(request_patient_id, actor_facility, 'write_records')),
       false) then
    raise exception using errcode = '42501', message = 'RECORDS_PROCESSING_GRANT_REQUIRED';
  end if;
  insert into ehr.encounters (patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
    started_at, ended_at, chief_complaint, imported_paper_records)
  values (request_patient_id, actor_facility, actor_account, actor_membership, 'other', 'completed',
    created_at_value, created_at_value, 'Imported paper records (Migrate)', true)
  on conflict (patient_id, facility_id) where imported_paper_records do nothing
  returning id into encounter_id_value;
  if encounter_id_value is null then
    select encounter_row.id into encounter_id_value
      from ehr.encounters encounter_row
     where encounter_row.patient_id = request_patient_id
       and encounter_row.facility_id = actor_facility
       and encounter_row.imported_paper_records;
  end if;
  if encounter_id_value is null then
    raise exception using errcode = '55000', message = 'IMPORTED_PAPER_RECORDS_ENCOUNTER_UNAVAILABLE';
  end if;
  return encounter_id_value;
end
$$;

comment on function ehr.imported_paper_records_encounter(uuid) is
  '0113: finds or creates the session facility''s one "Imported paper records" encounter of the patient (other, completed, started and ended when created) and returns its id; as the caller, under row-level security. 42501 RECORDS_PROCESSING_GRANT_REQUIRED unless the purpose is healthcare-operations and identity.records_processing_write_grant names the dedicated grant, or the purpose is direct-care and the caller may write the patient''s record.';

-- D4: under healthcare-operations, the database allows only the draft path.
create function ehr.records_processing_draft_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  allowed boolean := false;
begin
  if platform.current_purpose_of_use() is distinct from 'healthcare-operations' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' and actor_subject is not null and actor_membership is not null and actor_facility is not null
     and new.facility_id = actor_facility
     and identity.records_processing_write_grant(new.patient_id, actor_subject, actor_membership,
           actor_facility) is not null then
    if tg_table_name = 'encounters' then
      allowed := new.imported_paper_records;
    elsif tg_table_name = 'clinical_notes' then
      allowed := new.status = 'draft' and new.signed_at is null and new.signed_by is null
        and new.current_revision_no = 1 and new.note_type = 'From a paper record (Migrate)'
        and left(new.title, 31) = 'From a paper record (Migrate): ' and exists (
        select 1 from ehr.encounters encounter_row
         where encounter_row.id = new.encounter_id and encounter_row.patient_id = new.patient_id
           and encounter_row.facility_id = new.facility_id and encounter_row.imported_paper_records);
    elsif tg_table_name = 'clinical_note_revisions' then
      allowed := new.revision_no = 1 and exists (
        select 1 from ehr.clinical_notes note_row
          join ehr.encounters encounter_row on encounter_row.id = note_row.encounter_id
         where note_row.id = new.clinical_note_id and note_row.patient_id = new.patient_id
           and note_row.facility_id = new.facility_id and note_row.status = 'draft'
           and encounter_row.imported_paper_records);
    end if;
  end if;
  if not coalesce(allowed, false) then
    raise exception using errcode = '42501', message = 'RECORDS_PROCESSING_DRAFT_ONLY';
  end if;
  return new;
end
$$;

comment on function ehr.records_processing_draft_guard() is
  '0113 D4: under healthcare-operations, only the session''s dedicated records-processing grant (identity.records_processing_write_grant) may write, and only the "Imported paper records" encounter, a draft note in it and that note''s first revision; every UPDATE and DELETE is refused (42501 RECORDS_PROCESSING_DRAFT_ONLY). Under any other purpose it does nothing.';

create trigger encounters_records_processing_draft_guard
  before insert or update or delete on ehr.encounters
  for each row execute function ehr.records_processing_draft_guard();
create trigger clinical_notes_records_processing_draft_guard
  before insert or update or delete on ehr.clinical_notes
  for each row execute function ehr.records_processing_draft_guard();
create trigger clinical_note_revisions_records_processing_draft_guard
  before insert or update or delete on ehr.clinical_note_revisions
  for each row execute function ehr.records_processing_draft_guard();

-- D5: the publication's basis, written by the request and never changed.
alter table ocr.publications add column publication_basis text
  check (publication_basis in ('direct_care', 'records_processing_grant'));

comment on column ocr.publications.publication_basis is
  '0113: the basis the publication request was authorized on (direct_care or records_processing_grant; NULL before 0113, read as direct_care). Every execution attempt is authorized on it alone, so every attempt takes the same route.';

create function ocr.publications_basis_fixed()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.publication_basis is distinct from old.publication_basis then
    raise exception using errcode = '55000', message = 'OCR_PUBLICATION_BASIS_FIXED';
  end if;
  return new;
end
$$;

comment on function ocr.publications_basis_fixed() is
  '0113 D5: a publication''s publication_basis keeps the value its request wrote.';

create trigger publications_basis_fixed
  before update of publication_basis on ocr.publications
  for each row execute function ocr.publications_basis_fixed();

-- 3. D3: the patient sees the imported encounter only once it holds a signed note.
create function ehr.imported_paper_records_signed(
  request_encounter_id uuid,
  request_patient_id uuid,
  request_facility_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
      from ehr.clinical_notes note_row
     where note_row.encounter_id = request_encounter_id
       and note_row.patient_id = request_patient_id
       and note_row.facility_id = request_facility_id
       and note_row.status in ('signed', 'amended')
  )
$$;

comment on function ehr.imported_paper_records_signed(uuid, uuid, uuid) is
  '0113: whether an encounter holds a signed or amended clinical note; the patient-self policy on ehr.encounters shows an "Imported paper records" encounter only then.';

drop policy encounters_patient_self_read on ehr.encounters;
create policy encounters_patient_self_read on ehr.encounters for select
  using (ehr.patient_self_context(patient_id) and status = 'completed'
    and (not imported_paper_records or ehr.imported_paper_records_signed(id, patient_id, facility_id)));

-- 4. Owners: identity.access_requests' owner owns D1, ehr.encounters' owner
-- owns D2's and D3's functions (a no-op when the applier is that owner).
do $$
declare
  identity_owner oid := (select relation.relowner from pg_class relation
                          where relation.oid = 'identity.access_requests'::regclass);
  ehr_owner oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.encounters'::regclass);
begin
  if (select proc.proowner from pg_proc proc
       where proc.oid = 'identity.records_processing_write_grant(uuid,text,uuid,uuid)'::regprocedure) <> identity_owner then
    execute format('alter function identity.records_processing_write_grant(uuid,text,uuid,uuid) owner to %I',
      pg_get_userbyid(identity_owner));
  end if;
  if (select proc.proowner from pg_proc proc
       where proc.oid = 'ehr.imported_paper_records_encounter(uuid)'::regprocedure) <> ehr_owner then
    execute format('alter function ehr.imported_paper_records_encounter(uuid) owner to %I', pg_get_userbyid(ehr_owner));
  end if;
  if (select proc.proowner from pg_proc proc
       where proc.oid = 'ehr.encounters_imported_paper_records_fixed()'::regprocedure) <> ehr_owner then
    execute format('alter function ehr.encounters_imported_paper_records_fixed() owner to %I', pg_get_userbyid(ehr_owner));
  end if;
  if (select proc.proowner from pg_proc proc
       where proc.oid = 'ehr.imported_paper_records_signed(uuid,uuid,uuid)'::regprocedure) <> ehr_owner then
    execute format('alter function ehr.imported_paper_records_signed(uuid,uuid,uuid) owner to %I', pg_get_userbyid(ehr_owner));
  end if;
  if (select proc.proowner from pg_proc proc
       where proc.oid = 'ehr.records_processing_draft_guard()'::regprocedure) <> ehr_owner then
    execute format('alter function ehr.records_processing_draft_guard() owner to %I', pg_get_userbyid(ehr_owner));
  end if;
  if (select proc.proowner from pg_proc proc
       where proc.oid = 'ocr.publications_basis_fixed()'::regprocedure)
     <> (select relation.relowner from pg_class relation where relation.oid = 'ocr.publications'::regclass) then
    execute format('alter function ocr.publications_basis_fixed() owner to %I',
      pg_get_userbyid((select relation.relowner from pg_class relation where relation.oid = 'ocr.publications'::regclass)));
  end if;
end
$$;

-- Grants (here and in runtime-grants.sql).
revoke all on function identity.records_processing_write_grant(uuid, text, uuid, uuid) from public;
revoke all on function ehr.imported_paper_records_encounter(uuid) from public;
revoke all on function ehr.encounters_imported_paper_records_fixed() from public;
revoke all on function ehr.imported_paper_records_signed(uuid, uuid, uuid) from public;
revoke all on function ehr.records_processing_draft_guard() from public;
revoke all on function ocr.publications_basis_fixed() from public;

do $$
declare
  grant_row record;
begin
  for grant_row in
    select * from (values
      ('hid_ocr_runtime', 'grant usage on schema identity to hid_ocr_runtime'),
      ('hid_ocr_runtime', 'grant execute on function identity.records_processing_write_grant(uuid,text,uuid,uuid) to hid_ocr_runtime'),
      ('hid_ehr_runtime', 'grant execute on function identity.records_processing_write_grant(uuid,text,uuid,uuid) to hid_ehr_runtime'),
      ('hid_ehr_runtime', 'grant execute on function ehr.imported_paper_records_encounter(uuid) to hid_ehr_runtime'),
      ('hid_ehr_runtime', 'grant execute on function ehr.imported_paper_records_signed(uuid,uuid,uuid) to hid_ehr_runtime'),
      ('hid_schema_test_runtime',
       'grant execute on function ehr.imported_paper_records_signed(uuid,uuid,uuid) to hid_schema_test_runtime'))
      wanted(grantee, statement)
  loop
    if exists (select 1 from pg_roles where rolname = grant_row.grantee) then
      execute grant_row.statement;
    end if;
  end loop;
end
$$;

-- 5. Post-checks (after the grants, so the ACLs are the final ones).
do $$
declare
  mismatch text;
  identity_owner oid := (select relation.relowner from pg_class relation
                          where relation.oid = 'identity.access_requests'::regclass);
  ehr_owner oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.encounters'::regclass);
begin
  -- The functions: body, owner and attributes.
  select string_agg(format('%s: owner=%s definer=%s volatile=%s language=%s strict=%s config=%s result=%s md5=%s',
           proc.oid::regprocedure, pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
           language_row.lanname, proc.proisstrict, proc.proconfig, pg_get_function_result(proc.oid), md5(proc.prosrc)), '; ')
    into mismatch
    from (values
      ('identity.records_processing_write_grant(uuid,text,uuid,uuid)', identity_owner, true, 's', 'sql', 'uuid',
       '8985814bf1aa5ca5dace8f4232a18838'),
      ('ehr.imported_paper_records_encounter(uuid)', ehr_owner, false, 'v', 'plpgsql', 'uuid', '7d08e6e708c8212a22e62b753910ed1c'),
      ('ehr.encounters_imported_paper_records_fixed()', ehr_owner, false, 'v', 'plpgsql', 'trigger', '773f1c6e4a46d47fcba6ec318241b5a8'),
      ('ehr.imported_paper_records_signed(uuid,uuid,uuid)', ehr_owner, true, 's', 'sql', 'boolean', '25df452520faabbc27aceb93f32ec6ef'),
      ('ehr.records_processing_draft_guard()', ehr_owner, false, 'v', 'plpgsql', 'trigger', 'c260a12b14b1c6cc3d4ab0b6017b324a'),
      ('ocr.publications_basis_fixed()',
       (select relation.relowner from pg_class relation where relation.oid = 'ocr.publications'::regclass),
       false, 'v', 'plpgsql', 'trigger', 'd1a48f80a581ae9f1ca9f2b854897ba1'))
         expected(signature, owner_id, definer, volatility, language_name, result, digest)
    join pg_proc proc on proc.oid = expected.signature::regprocedure
    join pg_language language_row on language_row.oid = proc.prolang
   where proc.proowner <> expected.owner_id or proc.prosecdef <> expected.definer
      or proc.provolatile <> expected.volatility::"char" or language_row.lanname <> expected.language_name
      or proc.proisstrict or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
      or pg_get_function_result(proc.oid) is distinct from expected.result
      or md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is null
     and (select count(*) from pg_proc proc
           where (proc.pronamespace = 'identity'::regnamespace and proc.proname = 'records_processing_write_grant')
              or (proc.pronamespace = 'ehr'::regnamespace
                  and proc.proname in ('imported_paper_records_encounter', 'encounters_imported_paper_records_fixed',
                                       'imported_paper_records_signed', 'records_processing_draft_guard'))
              or (proc.pronamespace = 'ocr'::regnamespace and proc.proname = 'publications_basis_fixed')) <> 6 then
    mismatch := 'count';
  end if;
  -- The column, constraint, index, trigger and policy.
  if mismatch is null and not exists (select 1 from pg_attribute attribute_row
       where attribute_row.attrelid = 'ehr.encounters'::regclass and attribute_row.attname = 'imported_paper_records'
         and format_type(attribute_row.atttypid, attribute_row.atttypmod) = 'boolean' and attribute_row.attnotnull
         and pg_get_expr((select default_row.adbin from pg_attrdef default_row
                           where default_row.adrelid = attribute_row.attrelid and default_row.adnum = attribute_row.attnum),
               attribute_row.attrelid) = 'false') then
    mismatch := 'the column ehr.encounters.imported_paper_records';
  end if;
  if mismatch is null and not exists (select 1 from pg_constraint constraint_row
       where constraint_row.conrelid = 'ehr.encounters'::regclass
         and constraint_row.conname = 'encounters_imported_paper_records_shape'
         and constraint_row.contype = 'c' and constraint_row.convalidated) then
    mismatch := 'the constraint encounters_imported_paper_records_shape';
  end if;
  if mismatch is null and not exists (select 1 from pg_index index_row
       where index_row.indexrelid = 'ehr.encounters_imported_paper_records_key'::regclass
         and index_row.indrelid = 'ehr.encounters'::regclass and index_row.indisunique and index_row.indisvalid
         and pg_get_indexdef(index_row.indexrelid) = 'CREATE UNIQUE INDEX encounters_imported_paper_records_key ON '
           || 'ehr.encounters USING btree (patient_id, facility_id) WHERE imported_paper_records') then
    mismatch := 'the index encounters_imported_paper_records_key';
  end if;
  if mismatch is null and (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.encounters'::regclass
         and trigger_row.tgname = 'encounters_imported_paper_records_fixed' and trigger_row.tgenabled = 'O'
         and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER encounters_imported_paper_records_fixed BEFORE UPDATE '
           || 'OF imported_paper_records ON ehr.encounters FOR EACH ROW EXECUTE FUNCTION '
           || 'ehr.encounters_imported_paper_records_fixed()') <> 1 then
    mismatch := 'the trigger encounters_imported_paper_records_fixed';
  end if;
  if mismatch is null and (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid in ('ehr.encounters'::regclass, 'ehr.clinical_notes'::regclass,
                                     'ehr.clinical_note_revisions'::regclass)
         and trigger_row.tgfoid = 'ehr.records_processing_draft_guard()'::regprocedure
         and trigger_row.tgenabled = 'O'
         and pg_get_triggerdef(trigger_row.oid) = format('CREATE TRIGGER %s BEFORE INSERT OR DELETE OR UPDATE ON ehr.%s '
           || 'FOR EACH ROW EXECUTE FUNCTION ehr.records_processing_draft_guard()',
           trigger_row.tgname, (select relation.relname from pg_class relation where relation.oid = trigger_row.tgrelid))
         and trigger_row.tgname = (select relation.relname from pg_class relation where relation.oid = trigger_row.tgrelid)
           || '_records_processing_draft_guard') <> 3
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgfoid = 'ehr.records_processing_draft_guard()'::regprocedure) <> 3 then
    mismatch := 'the records-processing draft guard triggers';
  end if;
  if mismatch is null and not exists (select 1 from pg_attribute attribute_row
       where attribute_row.attrelid = 'ocr.publications'::regclass and attribute_row.attname = 'publication_basis'
         and format_type(attribute_row.atttypid, attribute_row.atttypmod) = 'text' and not attribute_row.attnotnull
         and not attribute_row.atthasdef and not attribute_row.attisdropped) then
    mismatch := 'the column ocr.publications.publication_basis';
  end if;
  if mismatch is null and (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ocr.publications'::regclass and trigger_row.tgname = 'publications_basis_fixed'
         and trigger_row.tgenabled = 'O'
         and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER publications_basis_fixed BEFORE UPDATE '
           || 'OF publication_basis ON ocr.publications FOR EACH ROW EXECUTE FUNCTION ocr.publications_basis_fixed()') <> 1 then
    mismatch := 'the trigger publications_basis_fixed';
  end if;
  if mismatch is null and (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.encounters'::regclass and policy_row.polname = 'encounters_patient_self_read'
         and policy_row.polcmd = 'r' and policy_row.polpermissive and policy_row.polroles = '{0}'::oid[]
         and policy_row.polwithcheck is null
         and md5(pg_get_expr(policy_row.polqual, policy_row.polrelid)) = 'e9e371454190598559a26da43c6fef4c') <> 1 then
    mismatch := 'the policy encounters_patient_self_read';
  end if;
  if mismatch is null and (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.encounters'::regclass) <> 4 then
    mismatch := 'the number of policies on ehr.encounters';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0113: not as this file makes it: %s', mismatch);
  end if;
  -- The ACLs: no PUBLIC; the write-grant check for the OCR and EHR runtimes,
  -- the encounter for the EHR runtime, the signed-note test for the two roles
  -- that read encounters, the trigger function for no one.
  select string_agg(granted.what, '; ') into mismatch
    from (
      select proc.oid::regprocedure || ' ' || case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
             || ' ' || acl.privilege_type as what
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.oid in ('identity.records_processing_write_grant(uuid,text,uuid,uuid)'::regprocedure,
                          'ehr.imported_paper_records_encounter(uuid)'::regprocedure,
                          'ehr.encounters_imported_paper_records_fixed()'::regprocedure,
                          'ehr.imported_paper_records_signed(uuid,uuid,uuid)'::regprocedure,
                          'ehr.records_processing_draft_guard()'::regprocedure,
                          'ocr.publications_basis_fixed()'::regprocedure)
         and acl.grantee <> proc.proowner
         and not (acl.grantee <> 0 and acl.privilege_type = 'EXECUTE'
                  and ((proc.oid = 'identity.records_processing_write_grant(uuid,text,uuid,uuid)'::regprocedure
                        and pg_get_userbyid(acl.grantee) in ('hid_ocr_runtime', 'hid_ehr_runtime'))
                    or (proc.oid = 'ehr.imported_paper_records_encounter(uuid)'::regprocedure
                        and pg_get_userbyid(acl.grantee) = 'hid_ehr_runtime')
                    or (proc.oid = 'ehr.imported_paper_records_signed(uuid,uuid,uuid)'::regprocedure
                        and pg_get_userbyid(acl.grantee) in ('hid_ehr_runtime', 'hid_schema_test_runtime'))))
      union all
      select format('missing %s EXECUTE on %s', wanted.grantee, wanted.signature)
        from (values ('hid_ocr_runtime', 'identity.records_processing_write_grant(uuid,text,uuid,uuid)'),
                     ('hid_ehr_runtime', 'identity.records_processing_write_grant(uuid,text,uuid,uuid)'),
                     ('hid_ehr_runtime', 'ehr.imported_paper_records_encounter(uuid)'),
                     ('hid_ehr_runtime', 'ehr.imported_paper_records_signed(uuid,uuid,uuid)'),
                     ('hid_schema_test_runtime', 'ehr.imported_paper_records_signed(uuid,uuid,uuid)')) wanted(grantee, signature)
        join pg_roles role_row on role_row.rolname = wanted.grantee
       where not exists (select 1 from pg_proc proc, aclexplode(proc.proacl) acl
                          where proc.oid = wanted.signature::regprocedure
                            and acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')
      union all
      select 'missing hid_ocr_runtime USAGE on schema identity'
        from pg_roles role_row
       where role_row.rolname = 'hid_ocr_runtime'
         and not exists (select 1 from pg_namespace namespace, aclexplode(namespace.nspacl) acl
                          where namespace.nspname = 'identity' and acl.grantee = role_row.oid
                            and acl.privilege_type = 'USAGE')) granted;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0113: an ACL is not this file''s: %s', mismatch);
  end if;
end
$$;
