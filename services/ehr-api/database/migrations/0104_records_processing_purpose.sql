-- 0104 Records processing, Stage 1: the purpose of use OCR needs, and the
-- patient's first access approval or Access PIN covering it for 24 hours.
-- Owner decisions in chat (D-Eminence; the declaration is signed separately):
-- - 2026-10-31, Stage 1: the healthcare-operations purpose for OCR; only a
--   doctor, clinician, nurse or lab member may ask; patients under 18 refused;
--   one request at most 24 hours; publishing into the chart stays direct care.
-- - 2026-11-03, decision 33(6), "all recommended": "numbers: records
--   processing 0104, scanner 0105, support check 0106, SSO 0107, Akos
--   0108-0113, owner re-signs each" (this file was 0100 on local branch rp-be).
-- - 2026-11-03, decision 34(1), "all recommended": "the first access request
--   or Access PIN also covers bringing in paper records for 24 h, said clearly
--   to the patient; under-18s still refused" (D6-D9 below). The owner's
--   restatement for this build: "the first access request or the Access PIN
--   also covers bringing in paper records for 24 hours, said clearly to the
--   patient; under-18s still refused; the patient can still say no".
-- Turning a paper record into the digital record runs under the purpose
-- healthcare-operations, shown to patients as "Records processing". The OCR
-- API already asks for it (create, validate, confirm and retry) and the staff
-- portal already sends it, but no migration on this branch seeds the code
-- (0071 seeds direct-care, 0085 emergency), so every OCR job is refused as a
-- missing grant and Identity refuses every request for it. Once the code is
-- active, a staff member asks the patient through the existing access request
-- (identity.create_access_request admits this purpose, 0098 R1), the patient
-- approves it (0072 copies the purpose onto the grant) and
-- identity.has_active_consent_grant honours that grant for this purpose only
-- (0012). Since decision 34(1) the patient's approval of a direct-care access
-- request, or the patient's Access PIN, also covers records processing for
-- that staff member for 24 hours (D6-D9), so the separate request is needed
-- only after that, or for a grant that came another way. Publishing into the
-- chart stays a direct-care step.
--
-- D1 The code: ('healthcare-operations', 'Records processing', active, 'hid'),
--    ON CONFLICT (code) DO NOTHING as 0071 and 0085 insert theirs. A row an
--    operator already inserted, or deactivated, is kept as it is. The kill
--    switch is its active flag:
--      update identity.purpose_of_use_codes set active = false
--       where code = 'healthcare-operations';
--    Then create_access_request refuses the purpose (22023 "Invalid purpose
--    for a standard access request", Identity's 400 INVALID_CONSENT_COMMAND)
--    and has_active_consent_grant honours no grant for it, so every records-
--    processing read and write fails closed. No grant is seeded; no role,
--    permission, policy or runtime privilege changes.
-- D2 Who may ask (owner decision): staff whose membership holds ocr.job.write
--    (doctor, clinician, nurse, lab), not pharmacists or receptionists, who
--    hold identity.consent.write but could never use the grant. A BEFORE
--    INSERT trigger on identity.access_requests, for rows with this purpose
--    that are not break-glass, refuses unless
--    auth.membership_has_permission(platform.current_actor_subject(),
--    new.membership_id, new.facility_id, 'ocr.job.write'): 42501
--    RECORDS_PROCESSING_NOT_ALLOWED. The requesting membership is the one the
--    grant will belong to, and the actor must hold it, live and active. A
--    request with no actor (a direct insert) is refused too.
-- D3 Patients under 18 are refused until a guardian approval flow exists
--    (owner decision), and so is a patient with no date of birth on record
--    (fail closed): 42501 RECORDS_PROCESSING_MINOR. The date of birth is
--    identity.patients.dob; the age is taken on today's date in Africa/Lagos,
--    as 0090 and 0095 count their days. A patient is 18 from their 18th
--    birthday; one born on 29 February from 1 March in a year that has no 29
--    February. A date of birth in the future counts as under 18. The check
--    runs after D2's, so a caller who may not ask learns nothing about the
--    patient's age.
-- D4 One request lasts at most 24 hours (owner decision) and asks to read or
--    write records: the trigger refuses another scope or a duration outside 5
--    to 1440 minutes with 22023 RECORDS_PROCESSING_REQUEST_INVALID.
--    create_access_request already refuses both before its insert (and the
--    table's CHECK the duration), so only a direct insert can reach this one.
-- D5 The patient's request list shows the purpose: identity.list_my_access_
--    requests() gains a last column, purpose_of_use, and is otherwise 0072's
--    body. A function's result columns cannot change in place, so it is
--    dropped and created again with the same owner, its EXECUTE for
--    hid_identity_runtime given back (here when the role exists, and in
--    runtime-grants.sql, which already names it) and none for PUBLIC. Today's
--    Identity selects the eleven columns by name, so it reads the new
--    function unchanged. Its search_path is now pg_catalog, pg_temp; every
--    name in the body was already qualified.
-- D6 Decision 34(1), what covers records processing: an active direct-care
--    grant (purpose direct-care, scope read_records or write_records, not
--    break-glass, status active, not held by the cutover, written by this
--    branch: source_system 'hid') that this staff member's membership at this
--    facility got for this patient in one of exactly two ways:
--    - the patient approved the facility's access request: the grant's
--      request is approved, by the patient (approved_by_patient_id), for
--      direct care and not break-glass, and neither row carries an
--      authorization method (0072's approval);
--    - the patient gave the Access PIN: grant and request both carry
--      authorization_method 'patient_access_pin' (0075's and 0098's PIN
--      command, which writes an approved direct-care read request with it).
--    Nothing else covers it: a patient share (0095, no request), a seeded or
--    imported grant, an emergency grant, break-glass, a grant held by the
--    cutover, another staff member's grant, another facility's grant. The
--    grant covers the purpose for this patient at this facility for the same
--    membership only, as every grant is that membership's (0012).
-- D7 How long: from the grant's starts_at for up to 24 hours, and never past
--    the grant's end: the cover ends at least(expires_at, starts_at + 24
--    hours) and whenever the grant stops being active. So the patient ends it
--    by revoking the grant (0087's revoke_my_consent_grant, 0075's PIN
--    revocation), and it ends when the grant expires or the membership ends.
--    Within the cover it allows records processing's read_records and
--    write_records, as a records-processing request of 24 hours would, also
--    under a PIN grant, which is read only for direct care: bringing in paper
--    records means creating, validating, confirming and retrying OCR jobs.
--    Direct care itself is unchanged: the PIN still opens the chart for
--    reading only, and publishing into the chart still needs the publisher's
--    own direct-care write grant.
-- D8 Still refused while covered: a patient under 18 on that day's
--    Africa/Lagos date, or with no date of birth on record (D3's rule, at the
--    time of the check); a membership whose roles lack ocr.job.write at the
--    facility (D2's rule, checked at each use, since no request is made);
--    the kill switch (D1) and an inactive direct-care code; an active deny
--    directive of the patient that names records processing or direct care
--    (or no purpose) for this facility, organization, staff member or all,
--    as 0012 reads directives. A separate records-processing request (D2-D4)
--    still works as before, and the patient can still deny it.
-- D9 Where: identity.records_processing_direct_care_cover(patient, subject,
--    membership, facility, action, at_time) returns the covering grant and the
--    cover's end, or no row (sql, STABLE, SECURITY DEFINER, search_path
--    pg_catalog, pg_temp, owned by has_active_consent_grant's owner, EXECUTE
--    for hid_identity_runtime only: Identity reads which grant covered the
--    check). identity.has_active_consent_grant keeps 0012's body, owner,
--    attributes and grants and gains one last alternative: the purpose is
--    healthcare-operations and that function returns a row. Every other
--    purpose, and every other answer, is 0012's. Audit is unchanged: OCR and
--    Identity audit each check as today, naming the covering grant.
--
-- Not changed: create_access_request, approve_access_request and every other
-- function body but has_active_consent_grant's (D9; the pins of 0091, 0094,
-- 0095, 0098, 0100, 0101 and 0102 were preconditions of migrations already
-- applied, and order-routes-cannot-complete's suite pins the new body);
-- break-glass (emergency, break_glass rows never fire the trigger, and
-- activate_break_glass admits only the emergency purpose); the patient PIN
-- command (still direct care, read only); patient shares (direct care, and
-- never covering records processing); the replay of a pending request, which
-- inserts nothing. No table, column, constraint, policy, role or permission
-- changes, and no grant is written. The
-- trigger fires on INSERT only: no service runtime may update
-- identity.access_requests (the schema-test runtime may), and the commands
-- that do (approval, denial, the expiries of 0086 and 0096) change only its
-- status.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0103 applied (else "0104: 0001-0103 must
--    be applied first"); not applied yet (else "0104: already applied"); the
--    bodies relied on are the ones 0001-0103 gave them (md5 of
--    pg_proc.prosrc), the replaced list and consent check among them, and the
--    list still has 0072's result columns; the columns read have the types
--    and NOT NULLs 0002, 0003, 0008 and 0033 gave them;
--    identity.access_requests, identity.consent_grants, identity.patients,
--    the list and has_active_consent_grant share one owner, the applying role
--    is it or a member that inherits it and may SET ROLE to it, and that owner
--    may use the schemas, read identity.facilities, auth.accounts, the
--    directive tables, the memberships and the purpose codes, and execute the
--    helpers (never through a superuser's bypass). The new functions read
--    identity.patients, identity.access_requests and identity.consent_grants
--    as their owner, which row-level security does not restrict (not forced,
--    checked).
-- 1. The code (D1).
-- 2. The request list (D5).
-- 3. The trigger (D2-D4): identity.access_requests_records_processing(),
--    plpgsql, SECURITY DEFINER, search_path pg_catalog, pg_temp, owned by the
--    table's owner, granted to no role (a trigger needs no EXECUTE to fire).
-- 4. The cover (D6-D9): identity.records_processing_direct_care_cover(...)
--    and has_active_consent_grant's last alternative.
-- 5. Post-checks: the code exists; the list's attributes, result and ACL;
--    the trigger's definition and the function's attributes and ACL; the
--    cover's attributes, result and ACL; has_active_consent_grant's new body
--    (md5), attributes, owner and ACL (as before the file).
--
-- Locks (measured with pg_locks before commit on a 0103 copy): ROW
-- EXCLUSIVE and ACCESS SHARE on identity.purpose_of_use_codes and its key
-- (one row written, then read back); SHARE ROW EXCLUSIVE on
-- identity.access_requests for CREATE
-- TRIGGER, so an access request being written waits for this transaction (a
-- few milliseconds) and the apply waits for one being written; ACCESS SHARE
-- on identity.consent_grants, identity.patients, auth.accounts,
-- identity.consent_directives, identity.consent_directive_versions and
-- identity.staff_facility_memberships (the cover's SQL body is checked when
-- it is created; ACCESS SHARE waits only for ACCESS EXCLUSIVE); ACCESS
-- EXCLUSIVE on the dropped list function and SHARE UPDATE EXCLUSIVE on the
-- three new ones and on has_active_consent_grant (their comments); the
-- schema, role and language read locks; ACCESS EXCLUSIVE on the session's own
-- temporary schema and table (section 0's helper and section 5's ACL copy).
-- No other application table. Behind a held lock the runner stops after its 5 s
-- lock_timeout and applies nothing. Calls take no lock on a function: a list
-- call already running finishes with 0072's body, and one that starts after
-- the commit runs the new one; the same holds for has_active_consent_grant,
-- which every row-level security policy and Identity call by name.
--
-- Old services on this schema: Identity reads the list by column name and
-- ignores the new column; the OCR API, the staff portal and Identity's
-- request route already use this purpose. An Identity image from before this
-- release answers a covered check as not allowed (its own grant lookup wants
-- a healthcare-operations grant; OCR then refuses with 403 ACCESS_DENIED), so
-- the cover starts working with the new Identity image, which reads the
-- covering grant from the cover; nothing else changes for it. Applied migrations 0001 through 0103
-- are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0097's and 0099's helper).
create function pg_temp.records_processing_0104_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  -- a. Prerequisites (0001-0103; 0103's organization application gate body
  -- and 0102's demo story installer are the markers).
  if to_regprocedure('identity.organization_application_admin_account(text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = 'identity.organization_application_admin_account(text)'::regprocedure)
        is distinct from '186eb4ca420749b8bdb324bdc843bc50'
     or to_regprocedure('identity.demo_story_install(text)') is null
     or to_regclass('identity.access_requests') is null
     or to_regclass('identity.consent_grants') is null
     or to_regclass('identity.consent_directives') is null
     or to_regclass('identity.consent_directive_versions') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('auth.accounts') is null
     or to_regprocedure('identity.has_active_membership(text,uuid,uuid)') is null
     or to_regclass('identity.purpose_of_use_codes') is null
     or to_regclass('identity.patients') is null
     or to_regclass('identity.facilities') is null
     or to_regprocedure('identity.list_my_access_requests()') is null
     or to_regprocedure('identity.create_access_request(text,text,text,integer)') is null
     or to_regprocedure('identity.approve_access_request(uuid)') is null
     or to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)') is null
     or to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null
     or to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('ehr.offline_audit_patient_allowed(uuid)') is null then
    raise exception using errcode = '55000', message = '0104: 0001-0103 must be applied first';
  end if;
  -- b. Not applied yet.
  if exists (select 1 from pg_proc proc
              where proc.pronamespace = 'identity'::regnamespace
                and proc.proname in ('access_requests_records_processing', 'records_processing_direct_care_cover'))
     or exists (select 1 from pg_trigger trigger_row
                 where trigger_row.tgrelid = 'identity.access_requests'::regclass
                   and trigger_row.tgname = 'access_requests_records_processing') then
    raise exception using errcode = '55000', message = '0104: already applied';
  end if;
  -- c. The bodies relied on, as 0001-0103 left them: the actor and account
  -- readers (0001, 0008), the permission and membership checks (0010, 0008),
  -- the request command whose insert the trigger guards (0098 R1), the
  -- approval that copies the purpose (0072), the grant check that honours it
  -- and that this file replaces (0012), and the list this file replaces
  -- (0072).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('identity.create_access_request(text,text,text,integer)', 'f88923a49a180c2180fdedb29bf2eccf'),
      ('identity.approve_access_request(uuid)', 'af9482ccb8b9d9aa8486035478ac4e94'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '8b12ce866ee75cce411a2721795ffb92'),
      ('identity.list_my_access_requests()', '966c38f6e349caff2877316eed101ae3'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is null
     and pg_get_function_result('identity.list_my_access_requests()'::regprocedure) is distinct from
       'TABLE(access_request_id uuid, facility_id uuid, facility_name text, scope text, reason text, status text, '
       || 'requested_duration_minutes integer, requested_at timestamp with time zone, approved_at timestamp with time zone, '
       || 'denied_at timestamp with time zone, denied_reason text)' then
    mismatch := 'identity.list_my_access_requests() result columns';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0104: a function this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- d. The columns read.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('identity.access_requests', 'patient_id', 'uuid', true),
      ('identity.access_requests', 'membership_id', 'uuid', true),
      ('identity.access_requests', 'facility_id', 'uuid', false),
      ('identity.access_requests', 'scope', 'text', true),
      ('identity.access_requests', 'requested_duration_minutes', 'integer', true),
      ('identity.access_requests', 'break_glass', 'boolean', true),
      ('identity.access_requests', 'purpose_of_use', 'text', false),
      ('identity.access_requests', 'migration_hold_reason', 'text', false),
      ('identity.access_requests', 'id', 'uuid', true),
      ('identity.access_requests', 'status', 'text', true),
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
      ('identity.purpose_of_use_codes', 'active', 'boolean', true))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0104: a column this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- e. Ownership and privileges, never through a superuser's bypass
  -- (production's migrator has none).
  table_owner := (select relation.relowner from pg_class relation
                   where relation.oid = 'identity.access_requests'::regclass);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not owned by %s', owned.what, pg_get_userbyid(table_owner)) as what
        from (select relation.oid::regclass::text as what, relation.relowner as owner_id from pg_class relation
               where relation.oid in ('identity.patients'::regclass, 'identity.consent_grants'::regclass)
              union all
              select proc.oid::regprocedure::text, proc.proowner from pg_proc proc
               where proc.oid in ('identity.list_my_access_requests()'::regprocedure,
                 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'::regprocedure)) owned
       where owned.owner_id <> table_owner
      union all
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(table_owner))
       where applier <> table_owner
         and not (pg_has_role(applier, table_owner, 'USAGE') and pg_has_role(applier, table_owner, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(table_owner), wanted.privilege, namespace.nspname)
        from (values ('identity', 'CREATE'), ('identity', 'USAGE'), ('auth', 'USAGE'), ('platform', 'USAGE'))
               wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.records_processing_0104_holds(table_owner, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks SELECT on %s', pg_get_userbyid(table_owner), relation.oid::regclass)
        from pg_class relation
       where relation.oid in ('identity.facilities'::regclass, 'auth.accounts'::regclass,
           'identity.consent_directives'::regclass, 'identity.consent_directive_versions'::regclass,
           'identity.staff_facility_memberships'::regclass, 'identity.purpose_of_use_codes'::regclass)
         and not pg_temp.records_processing_0104_holds(table_owner, relation.relowner, relation.relacl, 'r', 'SELECT')
      union all
      select format('%s forces row-level security on its owner', relation.oid::regclass)
        from pg_class relation
       where relation.oid in ('identity.patients'::regclass, 'identity.access_requests'::regclass,
           'identity.consent_grants'::regclass)
         and relation.relforcerowsecurity
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(table_owner), proc.oid::regprocedure)
        from (values ('platform.current_actor_subject()'), ('auth.account_id_for_subject(text)'),
                     ('auth.membership_has_permission(text,uuid,uuid,text)')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.records_processing_0104_holds(table_owner, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0104: missing privileges: %s', mismatch);
  end if;
  raise notice '0104: owners checked: identity.access_requests=%, applier=%', pg_get_userbyid(table_owner), current_user;
end
$$;

-- has_active_consent_grant's ACL before this file, for section 5 (it must
-- not change).
create temporary table records_processing_0104_acl as
select coalesce(proc.proacl::text, 'default') as acl from pg_proc proc
 where proc.oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'::regprocedure;

-- 1. The code (D1).
insert into identity.purpose_of_use_codes (code, display, active, source_system)
values ('healthcare-operations', 'Records processing', true, 'hid')
on conflict (code) do nothing;

-- 2. The request list (D5): 0072's body and one more column.
drop function identity.list_my_access_requests();

create function identity.list_my_access_requests()
returns table (
  access_request_id uuid,
  facility_id uuid,
  facility_name text,
  scope text,
  reason text,
  status text,
  requested_duration_minutes integer,
  requested_at timestamptz,
  approved_at timestamptz,
  denied_at timestamptz,
  denied_reason text,
  purpose_of_use text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_account_id uuid := auth.account_id_for_subject(platform.current_actor_subject());
  patient_id_value uuid;
begin
  if actor_account_id is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;
  select patient_row.id into patient_id_value
    from identity.patients patient_row
   where patient_row.account_id = actor_account_id
     and patient_row.status = 'active'
   limit 1;
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  return query
  select request_row.id, request_row.facility_id, facility.name,
    request_row.scope, request_row.reason, request_row.status,
    request_row.requested_duration_minutes, request_row.created_at,
    request_row.approved_at, request_row.denied_at, request_row.denied_reason,
    request_row.purpose_of_use
    from identity.access_requests request_row
    join identity.facilities facility on facility.id = request_row.facility_id
   where request_row.patient_id = patient_id_value
     and request_row.break_glass = false
     and request_row.migration_hold_reason is null
   order by request_row.created_at desc, request_row.id desc
   limit 100;
end;
$$;

comment on function identity.list_my_access_requests() is
  '0104: the signed-in patient''s 100 latest standard access requests (no break-glass, none held by the cutover), with the purpose of use (0072''s body and its last column).';

-- 3. The trigger (D2-D4).
create function identity.access_requests_records_processing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  birth_date date;
begin
  if not coalesce(auth.membership_has_permission(platform.current_actor_subject(), new.membership_id,
                    new.facility_id, 'ocr.job.write'), false) then
    raise exception using errcode = '42501', message = 'RECORDS_PROCESSING_NOT_ALLOWED';
  end if;
  if new.scope not in ('read_records', 'write_records')
     or new.requested_duration_minutes not between 5 and 1440 then
    raise exception using errcode = '22023', message = 'RECORDS_PROCESSING_REQUEST_INVALID';
  end if;
  select patient_row.dob into birth_date from identity.patients patient_row where patient_row.id = new.patient_id;
  if birth_date is null
     or birth_date > ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '18 years')::date then
    raise exception using errcode = '42501', message = 'RECORDS_PROCESSING_MINOR';
  end if;
  return new;
end
$$;

comment on function identity.access_requests_records_processing() is
  '0104: a records-processing (healthcare-operations, not break-glass) access request needs an actor whose membership holds ocr.job.write (42501 RECORDS_PROCESSING_NOT_ALLOWED), read or write for 5 to 1440 minutes (22023 RECORDS_PROCESSING_REQUEST_INVALID), and a patient aged 18 or over in Africa/Lagos with a date of birth on record (42501 RECORDS_PROCESSING_MINOR).';

create trigger access_requests_records_processing
  before insert on identity.access_requests
  for each row
  when (new.purpose_of_use = 'healthcare-operations' and not new.break_glass)
  execute function identity.access_requests_records_processing();

-- 4. The cover (D6-D9).
create function identity.records_processing_direct_care_cover(
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
  select grant_row.id, least(grant_row.expires_at, grant_row.starts_at + interval '24 hours')
    from identity.consent_grants grant_row
    join auth.accounts account_row on account_row.id = grant_row.account_id
    join identity.access_requests request_row on request_row.id = grant_row.request_id
    join identity.patients patient_row on patient_row.id = grant_row.patient_id
   where at_time is not null
     and request_action in ('read_records', 'write_records')
     -- D1 and D8: both purposes active (the kill switch).
     and (select count(*) from identity.purpose_of_use_codes purpose
           where purpose.code in ('healthcare-operations', 'direct-care') and purpose.active) = 2
     -- This patient, this membership at this facility, this live account.
     and grant_row.patient_id = request_patient_id
     and grant_row.membership_id = request_membership_id
     and grant_row.facility_id = request_facility_id
     and account_row.subject = request_subject
     and account_row.status = 'active'
     and (account_row.disabled_until is null or account_row.disabled_until <= at_time)
     -- D6: an active direct-care grant, not emergency, not break-glass.
     and grant_row.purpose_of_use = 'direct-care'
     and grant_row.scope in ('read_records', 'write_records')
     and not grant_row.break_glass
     and grant_row.status = 'active'
     and grant_row.migration_hold_reason is null
     and grant_row.source_system = 'hid'
     -- D7: from its start for up to 24 hours, never past its end.
     and grant_row.starts_at <= at_time
     and grant_row.expires_at > at_time
     and at_time < grant_row.starts_at + interval '24 hours'
     -- D6: from the patient's approval of the access request, or the Access PIN.
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
     -- D8: 18 or over on that day in Africa/Lagos, with a date of birth on record.
     and patient_row.dob is not null
     and patient_row.dob <= ((at_time at time zone 'Africa/Lagos')::date - interval '18 years')::date
     -- D8: the membership may run OCR jobs (D2's rule, at each use).
     and coalesce(auth.membership_has_permission(request_subject, request_membership_id, request_facility_id,
           'ocr.job.write'), false)
     -- D8: no active deny directive of the patient for records processing or direct care (0012's reading).
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
   order by least(grant_row.expires_at, grant_row.starts_at + interval '24 hours') desc, grant_row.id
   limit 1
$$;

comment on function identity.records_processing_direct_care_cover(uuid, text, uuid, uuid, text, timestamptz) is
  '0104 (owner decision 34(1)): the direct-care grant that covers records processing (healthcare-operations read or write) for this patient, membership and facility, and the end of the cover: a grant from the patient''s approval of a direct-care access request or from the Access PIN, active, for up to 24 hours from its start and never past its end; none for a patient under 18 or with no date of birth, a membership without ocr.job.write, an inactive purpose, or a deny directive for records processing or direct care.';

create or replace function identity.has_active_consent_grant(
  request_patient_id uuid,
  request_subject text,
  request_membership_id uuid,
  request_facility_id uuid,
  request_action text,
  request_purpose text,
  at_time timestamptz default current_timestamp
)
returns boolean
language sql
stable
security definer
set search_path = identity, auth, pg_temp
as $$
  select
    at_time is not null
    and request_purpose is not null
    and length(btrim(request_purpose)) > 0
    and coalesce(request_action in ('read_records', 'write_records'), false)
    and exists (
      select 1
      from identity.purpose_of_use_codes purpose
      where purpose.code = request_purpose and purpose.active
    )
    and identity.has_active_membership(request_subject, request_membership_id, request_facility_id)
    and (
      (
        exists (
          select 1
          from identity.consent_grants grant_row
          join auth.accounts account_row on account_row.id = grant_row.account_id
          where grant_row.patient_id = request_patient_id
            and grant_row.membership_id = request_membership_id
            and grant_row.facility_id = request_facility_id
            and grant_row.purpose_of_use = request_purpose
            and account_row.subject = request_subject
            and account_row.status = 'active'
            and (account_row.disabled_until is null or account_row.disabled_until <= at_time)
            and grant_row.status = 'active'
            and grant_row.migration_hold_reason is null
            and grant_row.starts_at <= at_time
            and grant_row.expires_at > at_time
            and grant_row.scope <> 'break_glass'
            and not grant_row.break_glass
            and (
              grant_row.scope = request_action
              or (request_action = 'read_records' and grant_row.scope = 'write_records')
            )
        )
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
            and (cardinality(directive_version.purposes) = 0 or request_purpose = any(directive_version.purposes))
            and (
              directive_version.grantee_type = 'all'
              or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = request_facility_id)
              or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = membership.organization_id)
              or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = membership.staff_id)
            )
        )
      )
      or (
        request_action = 'read_records'
        and request_purpose = 'emergency'
        and exists (
          select 1
          from identity.consent_grants emergency_grant
          join auth.accounts emergency_account on emergency_account.id = emergency_grant.account_id
          where emergency_grant.patient_id = request_patient_id
            and emergency_grant.membership_id = request_membership_id
            and emergency_grant.facility_id = request_facility_id
            and emergency_grant.purpose_of_use = 'emergency'
            and emergency_account.subject = request_subject
            and emergency_account.status = 'active'
            and (emergency_account.disabled_until is null or emergency_account.disabled_until <= at_time)
            and emergency_grant.scope = 'break_glass'
            and emergency_grant.break_glass
            and emergency_grant.status = 'active'
            and emergency_grant.migration_hold_reason is null
            and length(btrim(emergency_grant.reason)) between 8 and 500
            and emergency_grant.starts_at <= at_time
            and emergency_grant.expires_at > at_time
        )
      )
      or (
        -- 0104 (decision 34(1)): records processing covered by the patient's
        -- approval of a direct-care access request or by the Access PIN.
        request_purpose = 'healthcare-operations'
        and exists (
          select 1
          from identity.records_processing_direct_care_cover(request_patient_id, request_subject,
            request_membership_id, request_facility_id, request_action, at_time) cover
        )
      )
    )
$$;

comment on function identity.has_active_consent_grant(uuid, text, uuid, uuid, text, text, timestamptz) is
  'Authorizes exact active normal consent subject to directives, an exact reasoned emergency break-glass grant for read_records only, or (0104, owner decision 34(1)) records processing covered by the patient''s direct-care approval or Access PIN for up to 24 hours (identity.records_processing_direct_care_cover).';

-- The table's owner owns the three new functions (a no-op when the applier is
-- that owner, as on every database built by one migration login; section 0
-- checked that it owns has_active_consent_grant too).
do $$
declare
  table_owner oid := (select relation.relowner from pg_class relation
                       where relation.oid = 'identity.access_requests'::regclass);
  signature text;
begin
  foreach signature in array array['identity.list_my_access_requests()', 'identity.access_requests_records_processing()',
      'identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'] loop
    if (select proc.proowner from pg_proc proc where proc.oid = signature::regprocedure) <> table_owner then
      execute format('alter function %s owner to %I', signature, pg_get_userbyid(table_owner));
    end if;
  end loop;
end
$$;

-- Grants (here and in runtime-grants.sql).
revoke all on function identity.list_my_access_requests() from public;
revoke all on function identity.access_requests_records_processing() from public;
revoke all on function identity.records_processing_direct_care_cover(uuid, text, uuid, uuid, text, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.list_my_access_requests() to hid_identity_runtime;
    grant execute on function identity.records_processing_direct_care_cover(uuid, text, uuid, uuid, text, timestamptz)
      to hid_identity_runtime;
  end if;
end
$$;

-- 5. Post-checks (after the grants, so the ACLs are the final ones).
do $$
declare
  mismatch text;
begin
  if not exists (select 1 from identity.purpose_of_use_codes where code = 'healthcare-operations') then
    raise exception using errcode = '55000', message = '0104: the healthcare-operations code is missing';
  end if;
  select string_agg(format('%s: owner=%s definer=%s volatile=%s language=%s strict=%s config=%s result=%s',
           proc.oid::regprocedure, pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
           language_row.lanname, proc.proisstrict, proc.proconfig, pg_get_function_result(proc.oid)), '; ')
    into mismatch
    from (values ('identity.list_my_access_requests()',
                  'TABLE(access_request_id uuid, facility_id uuid, facility_name text, scope text, reason text, '
                  || 'status text, requested_duration_minutes integer, requested_at timestamp with time zone, '
                  || 'approved_at timestamp with time zone, denied_at timestamp with time zone, denied_reason text, '
                  || 'purpose_of_use text)'),
                 ('identity.access_requests_records_processing()', 'trigger')) expected(signature, result)
    join pg_proc proc on proc.oid = expected.signature::regprocedure
    join pg_language language_row on language_row.oid = proc.prolang
   where proc.proowner <> (select relation.relowner from pg_class relation
                            where relation.oid = 'identity.access_requests'::regclass)
      or not proc.prosecdef or proc.provolatile <> 'v' or language_row.lanname <> 'plpgsql' or proc.proisstrict
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
      or pg_get_function_result(proc.oid) is distinct from expected.result;
  if mismatch is null
     and (select count(*) from pg_proc proc
           where proc.pronamespace = 'identity'::regnamespace
             and proc.proname in ('list_my_access_requests', 'access_requests_records_processing')) <> 2 then
    mismatch := 'count';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'identity.access_requests'::regclass
             and trigger_row.tgname = 'access_requests_records_processing' and trigger_row.tgenabled = 'O'
             and pg_get_triggerdef(trigger_row.oid) =
               'CREATE TRIGGER access_requests_records_processing BEFORE INSERT ON identity.access_requests '
               || 'FOR EACH ROW WHEN (((new.purpose_of_use = ''healthcare-operations''::text) AND (NOT new.break_glass))) '
               || 'EXECUTE FUNCTION identity.access_requests_records_processing()') <> 1 then
    mismatch := 'the trigger';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0104: not as this file makes it: %s', mismatch);
  end if;
  select string_agg(granted.what, '; ') into mismatch
    from (
      select proc.oid::regprocedure || ' ' || case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
             || ' ' || acl.privilege_type as what
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.oid in ('identity.list_my_access_requests()'::regprocedure,
                          'identity.access_requests_records_processing()'::regprocedure)
         and acl.grantee <> proc.proowner
         and (proc.oid <> 'identity.list_my_access_requests()'::regprocedure or acl.grantee = 0
              or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime' or acl.privilege_type <> 'EXECUTE')
      union all
      select 'missing hid_identity_runtime EXECUTE on identity.list_my_access_requests()'
        from pg_roles role_row
       where role_row.rolname = 'hid_identity_runtime'
         and not exists (select 1 from pg_proc proc, aclexplode(proc.proacl) acl
                          where proc.oid = 'identity.list_my_access_requests()'::regprocedure
                            and acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0104: an ACL is not this file''s: %s', mismatch);
  end if;
end
$$;

-- 5 (continued). The cover and has_active_consent_grant (D9).
do $$
declare
  mismatch text;
  table_owner oid := (select relation.relowner from pg_class relation
                       where relation.oid = 'identity.access_requests'::regclass);
begin
  select string_agg(format('%s: owner=%s definer=%s volatile=%s language=%s strict=%s config=%s result=%s',
           proc.oid::regprocedure, pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
           language_row.lanname, proc.proisstrict, proc.proconfig, pg_get_function_result(proc.oid)), '; ')
    into mismatch
    from (values ('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)',
                  'TABLE(consent_grant_id uuid, covered_until timestamp with time zone)',
                  '{"search_path=pg_catalog, pg_temp"}'),
                 ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', 'boolean',
                  '{"search_path=identity, auth, pg_temp"}')) expected(signature, result, config)
    join pg_proc proc on proc.oid = expected.signature::regprocedure
    join pg_language language_row on language_row.oid = proc.prolang
   where proc.proowner <> table_owner
      or not proc.prosecdef or proc.provolatile <> 's' or language_row.lanname <> 'sql' or proc.proisstrict
      or proc.proconfig is distinct from expected.config::text[]
      or pg_get_function_result(proc.oid) is distinct from expected.result;
  if mismatch is null
     and (select md5(proc.prosrc) from pg_proc proc
           where proc.oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'::regprocedure)
         is distinct from '732d11892dd4e27e1ff9093ae3b7de5a' then
    mismatch := 'identity.has_active_consent_grant body';
  end if;
  if mismatch is null
     and (select coalesce(proc.proacl::text, 'default') from pg_proc proc
           where proc.oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'::regprocedure)
         is distinct from (select acl from pg_temp.records_processing_0104_acl) then
    mismatch := 'identity.has_active_consent_grant ACL changed';
  end if;
  if mismatch is null
     and (select count(*) from pg_proc proc
           where proc.pronamespace = 'identity'::regnamespace
             and proc.proname in ('records_processing_direct_care_cover', 'has_active_consent_grant')) <> 2 then
    mismatch := 'count';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0104: not as this file makes it: %s', mismatch);
  end if;
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
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0104: an ACL is not this file''s: %s', mismatch);
  end if;
end
$$;

drop table pg_temp.records_processing_0104_acl;
