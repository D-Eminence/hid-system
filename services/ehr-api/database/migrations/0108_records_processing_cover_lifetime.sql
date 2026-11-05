-- 0108 Records processing, the cover's lifetime and patient shares: the
-- patient's direct-care approval or Access PIN covers records processing for
-- as long as that access lasts (D-a), and so does an active patient share
-- (D-b). Written on staging-novu-ci-20261005 at 605e971e (migrations
-- 0001-0107 applied); it is the next migration after 0107 and replaces one
-- function body of 0104's, identity.records_processing_direct_care_cover.
-- Owner decisions in chat (D-Eminence, 2026-11-05, about 12:00 UTC, relayed by
-- the coordinator; the declaration is signed separately, reviewed_by is empty
-- until the owner signs):
--
-- D-a (lifetime): staff whose direct-care access to the patient is active may
--    do records processing (purpose healthcare-operations, read_records or
--    write_records) for as long as that access lasts, not only for 24 hours
--    from its start. This supersedes the 24-hour bound of decision
--    34(1) (0104 D7). A grant that covers records processing under 0104 D6
--    (the patient's approval of the facility's direct-care access request, or
--    the patient's Access PIN) now covers it from its starts_at until its
--    expires_at, and whenever it stops being active before that: the patient
--    revokes it (0087's revoke_my_consent_grant, 0075's PIN revocation), it is
--    held by the cutover, the membership ends, the account is disabled or
--    ends. covered_until, the cover's end Identity reads, is the grant's
--    expires_at. 0104's "at_time < starts_at + 24 hours" is dropped and
--    least(expires_at, starts_at + 24 hours) becomes expires_at, in the result
--    and in the ordering. Today requests last at most 24 hours and PIN grants
--    at most 60 minutes, so for those two the cover's end does not move; the
--    change matters for a longer grant (D-b's shares last up to 365 days).
--
-- D-b (shares): an active 0095 patient share also covers it. A consent
--    grant that has its row in identity.patient_consent_shares (consent_grant_id
--    the grant's id, the same patient_id and membership_id as the grant) and
--    that is, like every covering grant, direct care (purpose direct-care),
--    read_records or write_records, not break-glass, active, not held by the
--    cutover (migration_hold_reason null) and written by this branch
--    (source_system 'hid'), and, as 0095's identity.write_patient_share writes
--    it, has no request (request_id null), no authorization method and was
--    granted by the patient (granted_by_patient_id = patient_id). Any share
--    level (view_only, clinical_review or clinical_collaboration) covers
--    records processing's read_records AND write_records, exactly as a PIN
--    grant, which is read only for direct care, does under 0104 D7: bringing
--    in paper records means creating, validating, confirming and retrying OCR
--    jobs. Direct care itself is unchanged: a view_only or clinical_review
--    share still opens the chart for reading only. The share's cover lasts as
--    D-a says (until its expires_at: 24 hours, 7 days, 30 days or 365 days
--    for until_revoked), and ends when the patient revokes the share or
--    replaces it with a new one (0095's D5 revokes the earlier grant). D-b is
--    one clearly delimited alternative in the body (marked "D-b" below), next
--    to 0104's two ways, so the owner may approve D-a alone: without D-b the
--    body is the same less that alternative, and then the sealed demo doctor
--    (whose only grant is 0098's seeded share) still gets no cover. With D-b
--    that seeded share (source_system 'hid', granted by the patient,
--    request_id null, clinical_collaboration) covers records processing at
--    Demo Hospital under the same rules as any share: the demo patient 18 or
--    over with a date of birth, the doctor's membership holding ocr.job.write
--    there, no deny directive.
--
-- Everything else of 0104 D6 and D8 stays exactly as it was: the same staff
-- member's membership at the same facility and the live active account (the
-- grant every check already names, 0012); ocr.job.write for that membership at
-- that facility at each use (auth.membership_has_permission, D2's rule); the
-- patient 18 or over on the Africa/Lagos date of the check, with a date of
-- birth on record; no active deny directive of the patient for records
-- processing or direct care (or no purpose) for this facility, organization,
-- staff member or all, for this action, read as 0012 reads directives (0104's
-- reading, unchanged); break-glass and emergency grants never cover it;
-- imported or legacy-seeded grants (source_system other than 'hid') never
-- cover it (0098's demo share, which a migration seeded with source_system
-- 'hid' in a share's shape, is the one seeded grant that covers, under D-b);
-- both purpose codes, healthcare-operations and direct-care, active (the kill
-- switch, 0104 D1); a grant held by the cutover never covers it. The approval
-- way and the PIN way are 0104's conditions, unchanged (now in an EXISTS on
-- identity.access_requests instead of an inner join, so that D-b's grants,
-- which have no request, can be one more alternative; a grant's request_id
-- names at most one request, so the two forms answer alike).
--
-- What does not change. The cover's signature, result (consent_grant_id uuid,
-- covered_until timestamptz), owner, language sql, STABLE, SECURITY DEFINER,
-- search_path pg_catalog, pg_temp, not strict, its other attributes and its
-- ACL (EXECUTE for hid_identity_runtime only, where that role exists; none for
-- PUBLIC): CREATE OR REPLACE keeps them, and section 2 compares every
-- attribute but the body with what it was before. identity.has_active_consent_
-- grant, which calls the cover, is untouched: its body (md5
-- 732d11892dd4e27e1ff9093ae3b7de5a, 0104's), attributes, owner, ACL and
-- comment (whose words "for up to 24 hours" are 0104's and stay; the cover's
-- comment is this file's). No table, column, constraint, policy, trigger, role,
-- permission or grant changes, runtime-grants.sql is unchanged (its 0104 block
-- names the same signature) and no row is read or written. A separate
-- records-processing request (0104 D2-D4) works as before, and the patient can
-- still deny it.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0107 applied (0107's
--    ocr.claim_worker_job_fair and its md5 are the marker, else "0108:
--    0001-0107 must be applied first"); not applied yet (the cover's body is
--    not already this file's, else "0108: already applied"); the bodies relied
--    on are the ones 0001-0107 gave them (md5 of pg_proc.prosrc): the cover
--    this file replaces (0104's), has_active_consent_grant that calls it
--    (0104's), auth.membership_has_permission (0010's, the D2 rule) and
--    identity.write_patient_share (0095's, the only command that writes a
--    patient share and its grant, whose shape D-b reads); the cover's
--    attributes and result are 0104's; the columns read have the types and
--    NOT NULLs 0001-0107 gave them (0104's list, the directive and membership
--    columns of 0012's reading, and the patient_consent_shares columns
--    consent_grant_id, patient_id and membership_id, uuid NOT NULL);
--    identity.access_requests,
--    identity.consent_grants, identity.patients, the cover and
--    has_active_consent_grant share one owner, the applying role is it or a
--    member that inherits it and may SET ROLE to it, and that owner may use the
--    schemas, read auth.accounts, the directive tables, the memberships, the
--    purpose codes and identity.patient_consent_shares, and execute
--    auth.membership_has_permission (never through a superuser's bypass); the
--    tables the cover reads as its owner do not force row-level security on it
--    (identity.patients, identity.access_requests, identity.consent_grants,
--    the directive tables, the memberships, auth.accounts), and
--    identity.patient_consent_shares, which forces it (0095), has a permissive
--    policy for every role and command whose condition admits the owner (true,
--    or CURRENT_USER = the owner, as 0095 made it), so the cover sees every
--    share row; the cover's ACL is 0104's (no PUBLIC, no grantee but
--    hid_identity_runtime EXECUTE).
-- 1. The cover (D-a, D-b): CREATE OR REPLACE, and its comment.
-- 2. Post-checks: the new body (md5), every other attribute of the cover as it
--    was before (owner, language, volatility, SECURITY DEFINER, strictness,
--    search_path, cost, rows, parallel, result, arguments, ACL) and as 0104
--    made it; has_active_consent_grant's body (md5), attributes, owner and ACL
--    unchanged.
--
-- Locks (measured with pg_locks before commit on a 0107 copy): ACCESS SHARE
-- on identity.consent_grants, auth.accounts, identity.patients,
-- identity.access_requests, identity.patient_consent_shares,
-- identity.purpose_of_use_codes, identity.consent_directives,
-- identity.consent_directive_versions and identity.staff_facility_memberships
-- (the cover's SQL body is checked when it is created; ACCESS SHARE waits only
-- for ACCESS EXCLUSIVE), SHARE UPDATE EXCLUSIVE on the cover (its comment),
-- the schema, role and language read locks, and ACCESS EXCLUSIVE on the
-- session's own temporary schema and table (section 0's helper and the
-- attribute copy). No lock on any application table above ACCESS SHARE, and no
-- row of one is read or written; nothing on has_active_consent_grant. Behind
-- a session holding ACCESS EXCLUSIVE on one of those tables the runner stops
-- after its 5 s lock_timeout and applies nothing. Calls take
-- no lock on a function: a check already running finishes with 0104's body,
-- and one that starts after the commit runs the new one; every row-level
-- security policy and Identity call has_active_consent_grant by name, which
-- calls the cover by name.
--
-- Old services on this schema: Identity (services/identity-api,
-- postgres-identity.provider.ts) reads consent_grant_id and covered_until from
-- the cover and answers expiresAt = covered_until, so today's Identity image
-- reports the longer cover with no code change (only a comment there named
-- 24 hours); an Identity image from before 0104 still answers a covered check
-- as not allowed (0104's header). The OCR API, EHR's documents and every
-- policy that calls has_active_consent_grant honour the longer cover and the
-- shares with no change. The website's words to the patient (0104 decision
-- 34(1): "said clearly to the patient") name 24 hours today and say nothing on
-- the share screens; they are the website lane's to change and are not in
-- place when this applies: the approval, PIN and inbox words must drop "for up
-- to 24 hours" (D-a), and with D-b the share search, share confirmation and
-- invitation screens must say that a share at any level, view_only included,
-- also lets the clinician bring in the patient's paper records for the share's
-- duration (docs/INTERFACE_CONTRACT.md section 36). Applied migrations 0001
-- through 0107 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0104's helper).
create function pg_temp.records_processing_0108_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  table_owner oid;
begin
  -- a. Prerequisites (0001-0107; 0107's fair claim and its body are the marker).
  if to_regprocedure('ocr.claim_worker_job_fair(text,integer,integer)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('ocr.claim_worker_job_fair(text,integer,integer)'))
        is distinct from '49b95651106e0aaa6f8bf6c8adcdb696'
     or to_regclass('identity.access_requests') is null
     or to_regclass('identity.consent_grants') is null
     or to_regclass('identity.patient_consent_shares') is null
     or to_regclass('identity.consent_directives') is null
     or to_regclass('identity.consent_directive_versions') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('identity.purpose_of_use_codes') is null
     or to_regclass('identity.patients') is null
     or to_regclass('auth.accounts') is null
     or to_regprocedure('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)') is null
     or to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)') is null
     or to_regprocedure('identity.write_patient_share(uuid,uuid,text,uuid,text,text,text,uuid,text,text)') is null
     or to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null then
    raise exception using errcode = '55000', message = '0108: 0001-0107 must be applied first';
  end if;
  -- b. Not applied yet.
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = to_regprocedure('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'))
     = '6928763d3b69f0e4b4acf96a6a255736' then
    raise exception using errcode = '55000', message = '0108: already applied';
  end if;
  -- c. The bodies replaced and relied on, as 0001-0107 left them: the cover
  -- (0104's, replaced here), the consent gate that calls it (0104's, kept),
  -- the permission check (0010) and the share writer (0095).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)', 'f3216bee48827dfba8073199b56ded67'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.write_patient_share(uuid,uuid,text,uuid,text,text,text,uuid,text,text)', 'e7bce33a905c66e224f0fb7dff513701'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- The cover's attributes and result as 0104 made them.
  if mismatch is null and not exists (
       select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
        where proc.oid = 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'::regprocedure
          and language_row.lanname = 'sql' and proc.prosecdef and not proc.proisstrict and proc.provolatile = 's'
          and proc.proretset and proc.prokind = 'f'
          and proc.proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[]
          and pg_get_function_result(proc.oid) = 'TABLE(consent_grant_id uuid, covered_until timestamp with time zone)'
          and pg_get_function_arguments(proc.oid) = 'request_patient_id uuid, request_subject text, '
            || 'request_membership_id uuid, request_facility_id uuid, request_action text, at_time timestamp with time zone') then
    mismatch := 'attributes or result of identity.records_processing_direct_care_cover';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0108: a function this migration relies on differs from 0001-0107: %s', mismatch);
  end if;
  -- d. The columns read.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('identity.access_requests', 'id', 'uuid', true),
      ('identity.access_requests', 'patient_id', 'uuid', true),
      ('identity.access_requests', 'membership_id', 'uuid', true),
      ('identity.access_requests', 'facility_id', 'uuid', false),
      ('identity.access_requests', 'status', 'text', true),
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
      ('identity.patient_consent_shares', 'consent_grant_id', 'uuid', true),
      ('identity.patient_consent_shares', 'patient_id', 'uuid', true),
      ('identity.patient_consent_shares', 'membership_id', 'uuid', true),
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
      ('identity.staff_facility_memberships', 'staff_id', 'uuid', true))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0108: a column this migration relies on differs from 0001-0107: %s', mismatch);
  end if;
  -- e. Ownership, privileges and row-level security, never through a
  -- superuser's bypass (production's migrator has none).
  table_owner := (select relation.relowner from pg_class relation
                   where relation.oid = 'identity.access_requests'::regclass);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not owned by %s', owned.what, pg_get_userbyid(table_owner)) as what
        from (select relation.oid::regclass::text as what, relation.relowner as owner_id from pg_class relation
               where relation.oid in ('identity.patients'::regclass, 'identity.consent_grants'::regclass)
              union all
              select proc.oid::regprocedure::text, proc.proowner from pg_proc proc
               where proc.oid in ('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'::regprocedure,
                 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'::regprocedure)) owned
       where owned.owner_id <> table_owner
      union all
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(table_owner))
       where applier <> table_owner
         and not (pg_has_role(applier, table_owner, 'USAGE') and pg_has_role(applier, table_owner, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(table_owner), wanted.privilege, namespace.nspname)
        from (values ('identity', 'CREATE'), ('identity', 'USAGE'), ('auth', 'USAGE')) wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.records_processing_0108_holds(table_owner, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks SELECT on %s', pg_get_userbyid(table_owner), relation.oid::regclass)
        from pg_class relation
       where relation.oid in ('auth.accounts'::regclass, 'identity.consent_directives'::regclass,
           'identity.consent_directive_versions'::regclass, 'identity.staff_facility_memberships'::regclass,
           'identity.purpose_of_use_codes'::regclass, 'identity.patient_consent_shares'::regclass)
         and not pg_temp.records_processing_0108_holds(table_owner, relation.relowner, relation.relacl, 'r', 'SELECT')
      union all
      select format('%s forces row-level security on its owner', relation.oid::regclass)
        from pg_class relation
       where relation.oid in ('identity.patients'::regclass, 'identity.access_requests'::regclass,
           'identity.consent_grants'::regclass, 'auth.accounts'::regclass, 'identity.consent_directives'::regclass,
           'identity.consent_directive_versions'::regclass, 'identity.staff_facility_memberships'::regclass)
         and relation.relforcerowsecurity
      union all
      -- 0095 forces row-level security on the shares, with one policy for its
      -- applier: the cover reads them as its owner, which that policy (or one
      -- like it) must admit, or every share would be hidden from it.
      select 'identity.patient_consent_shares row-level security hides rows from ' || pg_get_userbyid(table_owner)
        from pg_class relation
       where relation.oid = 'identity.patient_consent_shares'::regclass
         and relation.relrowsecurity
         and (relation.relforcerowsecurity or relation.relowner <> table_owner)
         and not exists (select 1 from pg_policy policy_row
                          where policy_row.polrelid = relation.oid
                            and policy_row.polpermissive and policy_row.polcmd in ('r', '*')
                            and policy_row.polroles = '{0}'::oid[]
                            and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                              in ('true', format('(CURRENT_USER = %L::name)', pg_get_userbyid(table_owner))))
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(table_owner), proc.oid::regprocedure)
        from pg_proc proc
       where proc.oid = 'auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure
         and not pg_temp.records_processing_0108_holds(table_owner, proc.proowner, proc.proacl, 'f', 'EXECUTE')
      union all
      -- The cover's ACL is 0104's: no PUBLIC and no grantee but the Identity runtime.
      select 'the cover grants ' || acl.privilege_type || ' to '
             || case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.oid = 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'::regprocedure
         and acl.grantee <> proc.proowner
         and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime' or acl.privilege_type <> 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0108: missing privileges: %s', mismatch);
  end if;
  raise notice '0108: owners checked: identity.access_requests=%, applier=%', pg_get_userbyid(table_owner), current_user;
end
$$;

-- Every attribute but the body of the cover and of has_active_consent_grant
-- before this file, for section 2 (they must not change).
create temporary table records_processing_0108_before as
select proc.oid::regprocedure::text as signature,
       concat_ws(' | ', proc.proowner::regrole::text, proc.prolang::text, proc.procost::text, proc.prorows::text,
         proc.provariadic::text, proc.prosupport::text, proc.prokind::text, proc.prosecdef::text,
         proc.proleakproof::text, proc.proisstrict::text, proc.proretset::text, proc.provolatile::text,
         proc.proparallel::text, proc.pronargs::text, proc.pronargdefaults::text, proc.prorettype::text,
         proc.proargtypes::text, coalesce(proc.proallargtypes::text, '-'), coalesce(proc.proargmodes::text, '-'),
         coalesce(proc.proargnames::text, '-'), coalesce(pg_get_expr(proc.proargdefaults, 0), '-'),
         coalesce(proc.proconfig::text, '-'), coalesce(proc.proacl::text, 'default')) as attributes,
       md5(proc.prosrc) as digest
  from pg_proc proc
 where proc.oid in ('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'::regprocedure,
                    'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'::regprocedure);

-- 1. The cover (D-a, D-b).
create or replace function identity.records_processing_direct_care_cover(
  request_patient_id uuid,
  request_subject text,
  request_membership_id uuid,
  request_facility_id uuid,
  request_action text,
  at_time timestamptz
)
returns table (consent_grant_id uuid, covered_until timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select grant_row.id, grant_row.expires_at
    from identity.consent_grants grant_row
    join auth.accounts account_row on account_row.id = grant_row.account_id
    join identity.patients patient_row on patient_row.id = grant_row.patient_id
   where at_time is not null
     and request_action in ('read_records', 'write_records')
     -- 0104 D1 and D8: both purposes active (the kill switch).
     and (select count(*) from identity.purpose_of_use_codes purpose
           where purpose.code in ('healthcare-operations', 'direct-care') and purpose.active) = 2
     -- This patient, this membership at this facility, this live account.
     and grant_row.patient_id = request_patient_id
     and grant_row.membership_id = request_membership_id
     and grant_row.facility_id = request_facility_id
     and account_row.subject = request_subject
     and account_row.status = 'active'
     and (account_row.disabled_until is null or account_row.disabled_until <= at_time)
     -- 0104 D6: an active direct-care grant, not emergency, not break-glass,
     -- not held by the cutover, written by this branch.
     and grant_row.purpose_of_use = 'direct-care'
     and grant_row.scope in ('read_records', 'write_records')
     and not grant_row.break_glass
     and grant_row.status = 'active'
     and grant_row.migration_hold_reason is null
     and grant_row.source_system = 'hid'
     -- 0108 D-a: for as long as the grant lasts (no 24-hour bound).
     and grant_row.starts_at <= at_time
     and grant_row.expires_at > at_time
     and (
       -- 0104 D6: from the patient's approval of the access request, or the Access PIN.
       exists (
         select 1
           from identity.access_requests request_row
          where request_row.id = grant_row.request_id
            and request_row.patient_id = grant_row.patient_id
            and request_row.membership_id = grant_row.membership_id
            and request_row.facility_id = grant_row.facility_id
            and request_row.status = 'approved'
            and request_row.purpose_of_use = 'direct-care'
            and not request_row.break_glass
            and request_row.migration_hold_reason is null
            and (
              (grant_row.authorization_method is null and request_row.authorization_method is null
               and grant_row.granted_by_patient_id = grant_row.patient_id
               and request_row.approved_by_patient_id = grant_row.patient_id)
              or (grant_row.authorization_method = 'patient_access_pin'
                  and request_row.authorization_method = 'patient_access_pin')
            )
       )
       -- 0108 D-b (begin): an active patient share (0095), any level.
       or (
         grant_row.request_id is null
         and grant_row.authorization_method is null
         and grant_row.granted_by_patient_id = grant_row.patient_id
         and exists (
           select 1
             from identity.patient_consent_shares share_row
            where share_row.consent_grant_id = grant_row.id
              and share_row.patient_id = grant_row.patient_id
              and share_row.membership_id = grant_row.membership_id
         )
       )
       -- 0108 D-b (end).
     )
     -- 0104 D8: 18 or over on that day in Africa/Lagos, with a date of birth on record.
     and patient_row.dob is not null
     and patient_row.dob <= ((at_time at time zone 'Africa/Lagos')::date - interval '18 years')::date
     -- 0104 D8: the membership may run OCR jobs (D2's rule, at each use).
     and coalesce(auth.membership_has_permission(request_subject, request_membership_id, request_facility_id,
           'ocr.job.write'), false)
     -- 0104 D8: no active deny directive of the patient for records processing or direct care (0012's reading).
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
          and directive_version.starts_at <= at_time
          and (directive_version.expires_at is null or directive_version.expires_at > at_time)
          and (directive_version.facility_id is null or directive_version.facility_id = request_facility_id)
          and (cardinality(directive_version.actions) = 0 or request_action = any(directive_version.actions))
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

comment on function identity.records_processing_direct_care_cover(uuid, text, uuid, uuid, text, timestamptz) is
  '0108 (owner decisions D-a and D-b of 2026-11-05, superseding the 24-hour bound of 0104''s decision 34(1)): the direct-care grant that covers records processing (healthcare-operations read or write) for this patient, membership and facility, and the end of the cover, the grant''s expires_at: a grant from the patient''s approval of a direct-care access request, from the Access PIN, or from an active patient share (0095, any level), active, for as long as it lasts; none for a patient under 18 or with no date of birth, a membership without ocr.job.write, an inactive purpose, a deny directive for records processing or direct care, break-glass, emergency, or a grant whose source_system is not ''hid'' (imported or legacy-seeded). 0098''s seeded demo share (source_system ''hid'', granted by the demo patient, no request, with its share row) is a share and covers under D-b.';

-- 2. Post-checks.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: %s', before.signature, case
           when after.signature is null then 'missing'
           when after.attributes is distinct from before.attributes then 'attributes changed: ' || after.attributes
           else 'body' end), '; ')
    into mismatch
    from pg_temp.records_processing_0108_before before
    left join (
      select proc.oid::regprocedure::text as signature,
             concat_ws(' | ', proc.proowner::regrole::text, proc.prolang::text, proc.procost::text, proc.prorows::text,
               proc.provariadic::text, proc.prosupport::text, proc.prokind::text, proc.prosecdef::text,
               proc.proleakproof::text, proc.proisstrict::text, proc.proretset::text, proc.provolatile::text,
               proc.proparallel::text, proc.pronargs::text, proc.pronargdefaults::text, proc.prorettype::text,
               proc.proargtypes::text, coalesce(proc.proallargtypes::text, '-'), coalesce(proc.proargmodes::text, '-'),
               coalesce(proc.proargnames::text, '-'), coalesce(pg_get_expr(proc.proargdefaults, 0), '-'),
               coalesce(proc.proconfig::text, '-'), coalesce(proc.proacl::text, 'default')) as attributes,
             md5(proc.prosrc) as digest
        from pg_proc proc
       where proc.pronamespace = 'identity'::regnamespace
         and proc.proname in ('records_processing_direct_care_cover', 'has_active_consent_grant')) after
      on after.signature = before.signature
   where after.signature is null
      or after.attributes is distinct from before.attributes
      or after.digest is distinct from case
           when before.signature like 'identity.records_processing_direct_care_cover(%'
             then '6928763d3b69f0e4b4acf96a6a255736'
           else '732d11892dd4e27e1ff9093ae3b7de5a' end;
  if mismatch is null
     and (select count(*) from pg_proc proc
           where proc.pronamespace = 'identity'::regnamespace
             and proc.proname in ('records_processing_direct_care_cover', 'has_active_consent_grant')) <> 2 then
    mismatch := 'count';
  end if;
  -- As 0104 made the cover: owner, attributes, result and ACL.
  if mismatch is null and not exists (
       select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
        where proc.oid = 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'::regprocedure
          and proc.proowner = (select relation.relowner from pg_class relation
                                where relation.oid = 'identity.access_requests'::regclass)
          and language_row.lanname = 'sql' and proc.prosecdef and not proc.proisstrict and proc.provolatile = 's'
          and proc.proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[]
          and pg_get_function_result(proc.oid) = 'TABLE(consent_grant_id uuid, covered_until timestamp with time zone)') then
    mismatch := 'the cover''s owner, attributes or result';
  end if;
  if mismatch is null then
    select string_agg(granted.what, '; ') into mismatch
      from (
        select case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
               || ' ' || acl.privilege_type || ' on the cover' as what
          from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
         where proc.oid = 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'::regprocedure
           and acl.grantee <> proc.proowner
           and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime' or acl.privilege_type <> 'EXECUTE')
        union all
        select 'missing hid_identity_runtime EXECUTE on the cover'
          from pg_roles role_row
         where role_row.rolname = 'hid_identity_runtime'
           and not exists (select 1 from pg_proc proc, aclexplode(proc.proacl) acl
                            where proc.oid = 'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'::regprocedure
                              and acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0108: not as this file makes it: %s', mismatch);
  end if;
end
$$;

drop table pg_temp.records_processing_0108_before;
