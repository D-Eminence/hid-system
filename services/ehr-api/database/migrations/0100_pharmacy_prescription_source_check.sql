-- 0100 Pharmacy acceptance checks its EHR prescription (owner decision of
-- 2026-11-01, D-Eminence: "Fix it now"; the declaration signed separately).
-- Written on the released 0099 (82f52b9); RENUMBER.md (beside the branch,
-- not shipped) says how it and 0101 (the same check at dispensing) are
-- renumbered when other migrations ship first: the two numbers are replaced
-- mechanically throughout both files. No migration number appears inside the
-- function body, so renumbering leaves its md5.
--
-- The gap: pharmacy-api's acceptPrescription inserts a dispensable
-- pharmacy.work_items row from fields its caller supplies (the prescription's
-- id, version and encounter, the patient, the ordering facility, the status
-- 'active', the medication, dose, route, frequency, instructions, dates,
-- prescriber and time). For a same-facility acceptance (order_route_id null)
-- pharmacy.validate_work_item (0086) checked only the session, the facility,
-- the actor, source_status = 'active' (which the caller supplies) and that the
-- prescription is not routed elsewhere. It never looked at ehr.prescriptions,
-- so a caller could make a dispensable work item for a prescription that does
-- not exist, is not active, is at another version, belongs to another
-- patient, facility or encounter, or says something else. The order-route
-- branch already checks every field against ehr.order_routes; the Lab twin
-- (lab.validate_work_item, 0086) already checks its same-facility branch
-- against ehr.lab_requests.
--
-- The change: pharmacy.validate_work_item is replaced from its latest
-- definition (0086) with only its same-facility branch changed (and two
-- declarations added for it). The order-route branch, the existing checks,
-- the signature, language, SECURITY DEFINER, volatility, search_path
-- (pharmacy, platform, pg_temp; every new name is schema-qualified), owner,
-- ACL and trigger are unchanged. In the same-facility branch, in this order:
--   1. The ehr.prescriptions row whose id is new.source_ehr_prescription_id is
--      read FOR SHARE (held to commit: the EHR cannot change or cancel the
--      prescription under the acceptance; the EHR's own writers take it FOR
--      UPDATE or FOR NO KEY UPDATE first, then the routes, so the order
--      prescription-then-route is the one every writer already uses). The
--      lock does not stop a route send to another facility: the send
--      (ehr.send_order_route) only locks the prescription FOR NO KEY UPDATE
--      and writes ehr.order_routes, so an acceptance that waited for it
--      gets the lock without a serialization error and then reads the routes
--      (step 5) with the snapshot it took before the send committed. Such a
--      send is caught only when the EHR API runs it SERIALIZABLE, as it does
--      from this release (OrderRoutesService.send): the acceptance then fails
--      40001 and pharmacy-api's retry answers PRESCRIPTION_ROUTED. With an
--      older EHR API image only the unique work-item key stops the receiving
--      pharmacy from accepting it too (nothing is dispensed twice). None:
--      23514 PRESCRIPTION_SOURCE_NOT_FOUND. It is read as this function's
--      owner, so on production, where ehr.prescriptions forces row-level
--      security on its owner, only a row the session may read and update
--      (ehr.context_allows: this facility, write consent for its patient) is
--      found; a prescription of another facility, or one the session has no
--      write consent for, is not found either, and so a session that is not
--      a member with consent there (no membership, facility or account) is
--      refused here, before 0077's session checks; an owner that bypasses
--      row-level security reaches those checks and their message.
--   2. status must be 'active': else 23514 PRESCRIPTION_SOURCE_NOT_ACTIVE.
--   3. row_version must equal new.source_ehr_prescription_version: else 23514
--      PRESCRIPTION_SOURCE_VERSION_MISMATCH (it changed since it was read).
--   4. Each of these must equal the work item's, else 23514
--      PRESCRIPTION_SOURCE_MISMATCH: patient_id; facility_id (= facility_id
--      and ordering_facility_id, and so the session's facility, which 0077's
--      check in step 5 requires of facility_id); encounter_id
--      (source_encounter_id); medication_code_system, medication_code,
--      medication_display; dose_quantity, dose_unit, route_code, frequency,
--      instructions; starts_on, ends_on; created_by (prescribed_by, the
--      prescriber's account); created_at (prescribed_at).
--      Normalised as the only writer (the EHR API's handoff to pharmacy-api)
--      carries them: a text equals the stored text or the stored text with
--      what JavaScript's String.prototype.trim() removes cut from both ends
--      (pharmacy-api trims every text it accepts); numeric dose_quantity is
--      compared by value (500.0000 equals 500, which is what JSON carries);
--      prescribed_at equals created_at or created_at cut to the millisecond
--      (the EHR API sends it through a JavaScript Date, which keeps
--      milliseconds); dates and ids exactly. Null equals only null. From
--      this release the EHR API sends each date as its calendar date
--      (YYYY-MM-DD), whatever the process's TZ. An older EHR API image sends
--      the JavaScript Date node-postgres makes of a date column (local
--      midnight), which matches only while it runs in UTC, as it does (its
--      image and task definitions set no TZ); east of UTC it would send the
--      day before and the acceptance would be refused as a mismatch.
--   5. Then 0077's and 0086's checks as before (session, facility, actor,
--      source_status 'active', 23514 with their messages, and 23514
--      PRESCRIPTION_ROUTED while the prescription has a live route).
-- All new refusals keep errcode 23514 (check_violation); pharmacy-api maps the
-- four messages to 404, 409, 409 and 422. Existing work items are not touched:
-- the trigger fires on INSERT only (work items are insert-only, 0023). The
-- lock ends when the acceptance commits; 0101 makes a same-facility work item
-- undispensable once its prescription is no longer active at that version.
-- Who can still be refused: only a work item that differs from its
-- prescription. The EHR API builds every same-facility acceptance from the
-- row it has just read and checked (active, the version the client read, not
-- routed), in a transaction that commits before it calls pharmacy-api; the
-- prescription can change in between, and then the acceptance is refused as
-- not active or as a version mismatch, which is the point.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0099 applied (else "0100: 0001-0099 must
--    be applied first"); not applied yet (else "0100: already applied"); the
--    bodies relied on are the ones 0001-0099 gave them (md5 of
--    pg_proc.prosrc): validate_work_item as 0086 left it, the three session
--    readers, and ehr.context_allows and identity.has_active_consent_grant,
--    through which row-level security lets the owner see the prescription;
--    validate_work_item's attributes and its trigger; the two
--    ehr.prescriptions policies a read FOR SHARE applies (prescriptions_read,
--    prescriptions_update); the types and NOT NULLs of the columns read; a
--    UTF8 database (the trim characters); the applying role is the
--    function's owner or a member that inherits it and may SET ROLE to it;
--    that owner may use the schemas, read and update (FOR SHARE needs UPDATE)
--    ehr.prescriptions and ehr.order_routes, and execute the session readers
--    and the policies' functions (never through a superuser's bypass).
-- 1. The function, replaced (owner, ACL and trigger kept).
-- 2. Its comment; its PUBLIC EXECUTE revoked (it has none; runtime-grants.sql
--    says so too).
-- 3. Post-checks: the body is exactly this file's, the attributes, owner and
--    ACL are as before, and the trigger still calls it.
--
-- Locks (measured with pg_locks before commit on a 0099 copy): SHARE UPDATE
-- EXCLUSIVE on the function (its comment), ACCESS SHARE on schema pharmacy
-- and on the language, ACCESS EXCLUSIVE on the session's own temporary schema
-- (section 0's helper); no lock on any application table is held to commit.
-- Reading the two policies' expressions (section 0) opens ehr.prescriptions
-- for a moment, so behind a session holding ACCESS EXCLUSIVE on it (DDL) the
-- runner stops after its 5 s lock_timeout and applies nothing; behind ROW
-- EXCLUSIVE on ehr.prescriptions or pharmacy.work_items (rows being
-- written), and even ACCESS EXCLUSIVE on pharmacy.work_items, it applied at
-- once. An acceptance already running finishes with 0086's body; one that
-- starts after the commit runs this one. At run time the same-facility
-- branch adds one row lock, FOR SHARE on the prescription, to an
-- acceptance's transaction: an EHR change of that prescription waits for the
-- acceptance to commit, and an acceptance that reaches a prescription being
-- changed waits, then (SERIALIZABLE) fails with 40001, which pharmacy-api
-- retries and the retry answers PRESCRIPTION_SOURCE_VERSION_MISMATCH. A route
-- send only locks the prescription, so the lock orders an acceptance after a
-- send that has not committed yet but does not refuse it (see step 1).
--
-- Old services on this schema: today's pharmacy-api sends the same INSERT;
-- a legitimate acceptance (the EHR API's handoff) passes, and the four new
-- refusals reach today's pharmacy-api as 23514 errors it does not map (500)
-- until the new image maps them. The EHR API, Lab, the website and the
-- order-route branch are unaffected. Applied migrations 0001 through 0099
-- are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0097's, 0099's and 0100's helper).
create function pg_temp.pharmacy_source_0100_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  function_owner oid;
begin
  -- a. Prerequisites (0001-0099).
  if to_regclass('pharmacy.work_items') is null
     or to_regclass('ehr.prescriptions') is null
     or to_regclass('ehr.order_routes') is null
     or to_regprocedure('pharmacy.validate_work_item()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_account_id()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('ehr.context_allows(uuid,uuid,text)') is null
     or to_regprocedure('ehr.patient_self_context(uuid)') is null
     or to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)') is null
     or to_regprocedure('ehr.offline_audit_patient_allowed(uuid)') is null then
    raise exception using errcode = '55000', message = '0100: 0001-0099 must be applied first';
  end if;
  -- b. Not applied yet: the body is not this file's already.
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'pharmacy.validate_work_item()'::regprocedure)
     = 'e2411539ee8c95a02dad46c03e24db05' then
    raise exception using errcode = '55000', message = '0100: already applied';
  end if;
  -- c. The bodies relied on, as 0001-0099 left them: the function replaced
  -- (0086), the three session readers it calls (0001, 0008), and the consent
  -- gate row-level security puts in front of its read of ehr.prescriptions
  -- (0005, 0012).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('pharmacy.validate_work_item()', 'bc7df9aadfcc5f99965bcba0cfb2a5d7'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '8b12ce866ee75cce411a2721795ffb92'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is null
     and not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                      where proc.oid = 'pharmacy.validate_work_item()'::regprocedure
                        and language_row.lanname = 'plpgsql' and proc.prosecdef and proc.provolatile = 'v'
                        and not proc.proisstrict and proc.prorettype = 'trigger'::regtype
                        and proc.proconfig = '{"search_path=pharmacy, platform, pg_temp"}'::text[]) then
    mismatch := 'pharmacy.validate_work_item() attributes';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'pharmacy.work_items'::regclass
             and trigger_row.tgfoid = 'pharmacy.validate_work_item()'::regprocedure
             and trigger_row.tgname = 'pharmacy_work_item_validate' and trigger_row.tgenabled = 'O'
             and pg_get_triggerdef(trigger_row.oid) =
               'CREATE TRIGGER pharmacy_work_item_validate BEFORE INSERT ON pharmacy.work_items '
               || 'FOR EACH ROW EXECUTE FUNCTION pharmacy.validate_work_item()') <> 1 then
    mismatch := 'the trigger pharmacy_work_item_validate';
  end if;
  -- The policies a read FOR SHARE of ehr.prescriptions applies (0005).
  if mismatch is null
     and (select count(*) from pg_policy policy_row
           where policy_row.polrelid = 'ehr.prescriptions'::regclass and policy_row.polpermissive
             and policy_row.polroles = '{0}'::oid[]
             and ((policy_row.polname = 'prescriptions_read' and policy_row.polcmd = 'r'
                   and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                     = 'ehr.context_allows(patient_id, facility_id, ''read_records''::text)')
               or (policy_row.polname = 'prescriptions_update' and policy_row.polcmd = 'w'
                   and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                     = 'ehr.context_allows(patient_id, facility_id, ''write_records''::text)'))) <> 2
     or mismatch is null
     and exists (select 1 from pg_policy policy_row
                  where policy_row.polrelid = 'ehr.prescriptions'::regclass and not policy_row.polpermissive) then
    mismatch := 'the ehr.prescriptions policies';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0100: a function this migration relies on differs from 0001-0099: %s', mismatch);
  end if;
  -- d. The columns read, and the encoding the trim characters need.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('ehr.prescriptions', 'id', 'uuid', true),
      ('ehr.prescriptions', 'encounter_id', 'uuid', true),
      ('ehr.prescriptions', 'patient_id', 'uuid', true),
      ('ehr.prescriptions', 'facility_id', 'uuid', true),
      ('ehr.prescriptions', 'created_by', 'uuid', true),
      ('ehr.prescriptions', 'medication_code_system', 'text', false),
      ('ehr.prescriptions', 'medication_code', 'text', false),
      ('ehr.prescriptions', 'medication_display', 'text', true),
      ('ehr.prescriptions', 'dose_quantity', 'numeric(12,4)', false),
      ('ehr.prescriptions', 'dose_unit', 'text', false),
      ('ehr.prescriptions', 'route_code', 'text', false),
      ('ehr.prescriptions', 'frequency', 'text', true),
      ('ehr.prescriptions', 'instructions', 'text', true),
      ('ehr.prescriptions', 'starts_on', 'date', false),
      ('ehr.prescriptions', 'ends_on', 'date', false),
      ('ehr.prescriptions', 'status', 'text', true),
      ('ehr.prescriptions', 'row_version', 'bigint', true),
      ('ehr.prescriptions', 'created_at', 'timestamp with time zone', true),
      ('pharmacy.work_items', 'patient_id', 'uuid', true),
      ('pharmacy.work_items', 'facility_id', 'uuid', true),
      ('pharmacy.work_items', 'ordering_facility_id', 'uuid', true),
      ('pharmacy.work_items', 'source_ehr_prescription_id', 'uuid', true),
      ('pharmacy.work_items', 'source_ehr_prescription_version', 'bigint', true),
      ('pharmacy.work_items', 'source_encounter_id', 'uuid', true),
      ('pharmacy.work_items', 'source_status', 'text', true),
      ('pharmacy.work_items', 'medication_code_system', 'text', false),
      ('pharmacy.work_items', 'medication_code', 'text', false),
      ('pharmacy.work_items', 'medication_display', 'text', true),
      ('pharmacy.work_items', 'dose_quantity', 'numeric(12,4)', false),
      ('pharmacy.work_items', 'dose_unit', 'text', false),
      ('pharmacy.work_items', 'route_code', 'text', false),
      ('pharmacy.work_items', 'frequency', 'text', true),
      ('pharmacy.work_items', 'instructions', 'text', true),
      ('pharmacy.work_items', 'starts_on', 'date', false),
      ('pharmacy.work_items', 'ends_on', 'date', false),
      ('pharmacy.work_items', 'prescribed_by', 'uuid', true),
      ('pharmacy.work_items', 'prescribed_at', 'timestamp with time zone', true),
      ('pharmacy.work_items', 'accepted_by', 'uuid', true),
      ('pharmacy.work_items', 'accepted_by_membership_id', 'uuid', true),
      ('pharmacy.work_items', 'order_route_id', 'uuid', false))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is null
     and (select pg_encoding_to_char(database_row.encoding) from pg_database database_row
           where database_row.datname = current_database()) <> 'UTF8' then
    mismatch := 'the database encoding (UTF8 needed)';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0100: a column this migration relies on differs from 0001-0099: %s', mismatch);
  end if;
  -- e. Ownership and privileges, never through a superuser's bypass
  -- (production's migrator has none). CREATE OR REPLACE keeps the owner.
  function_owner := (select proc.proowner from pg_proc proc
                      where proc.oid = 'pharmacy.validate_work_item()'::regprocedure);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(function_owner)) as what
       where applier <> function_owner
         and not (pg_has_role(applier, function_owner, 'USAGE') and pg_has_role(applier, function_owner, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(function_owner), wanted.privilege, namespace.nspname)
        from (values ('pharmacy', 'CREATE'), ('pharmacy', 'USAGE'), ('ehr', 'USAGE'), ('platform', 'USAGE'))
               wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.pharmacy_source_0100_holds(function_owner, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks %s on %s', pg_get_userbyid(function_owner), wanted.privilege, relation.oid::regclass)
        from (values ('ehr.prescriptions', 'SELECT'), ('ehr.prescriptions', 'UPDATE'),
                     ('ehr.order_routes', 'SELECT'), ('ehr.order_routes', 'UPDATE')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
       where not pg_temp.pharmacy_source_0100_holds(function_owner, relation.relowner, relation.relacl, 'r',
               wanted.privilege)
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(function_owner), proc.oid::regprocedure)
        from (values ('platform.current_facility_id()'), ('platform.current_account_id()'),
                     ('platform.current_membership_id()'), ('ehr.context_allows(uuid,uuid,text)'),
                     ('ehr.patient_self_context(uuid)')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.pharmacy_source_0100_holds(function_owner, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0100: missing privileges: %s', mismatch);
  end if;
  raise notice '0100: owners checked: pharmacy.validate_work_item()=%, ehr.prescriptions=%, applier=%',
    pg_get_userbyid(function_owner),
    (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'ehr.prescriptions'::regclass),
    current_user;
end
$$;

-- 1. The function: 0086's text, with the same-facility branch (after the
-- order-route branch's "end if;") checking the prescription first.
create or replace function pharmacy.validate_work_item()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
  route_row ehr.order_routes%rowtype;
  source_row ehr.prescriptions%rowtype;
  -- What String.prototype.trim() removes (pharmacy-api trims each text it
  -- accepts): tab, LF, VT, FF, CR, space, U+00A0, U+1680, U+2000-U+200A,
  -- U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF (a UTF8 database).
  js_whitespace constant text := chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160)
    || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
    || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287)
    || chr(12288) || chr(65279);
begin
  if new.order_route_id is not null then
    select route.* into route_row from ehr.order_routes route where route.id = new.order_route_id for update;
    if route_row.id is null
       or session_facility_id is null
       or session_account_id is null
       or session_membership_id is null
       or route_row.kind is distinct from 'prescription'
       or route_row.state is distinct from 'accepted'
       or route_row.pharmacy_work_item_id is distinct from new.id
       or route_row.patient_id is distinct from new.patient_id
       or route_row.receiving_facility_id is distinct from new.facility_id
       or route_row.ordering_facility_id is distinct from new.ordering_facility_id
       or route_row.source_prescription_id is distinct from new.source_ehr_prescription_id
       or route_row.source_order_version is distinct from new.source_ehr_prescription_version
       or route_row.source_encounter_id is distinct from new.source_encounter_id
       or route_row.medication_code_system is distinct from new.medication_code_system
       or route_row.medication_code is distinct from new.medication_code
       or route_row.medication_display is distinct from new.medication_display
       or route_row.dose_quantity is distinct from new.dose_quantity
       or route_row.dose_unit is distinct from new.dose_unit
       or route_row.route_code is distinct from new.route_code
       or route_row.frequency is distinct from new.frequency
       or route_row.instructions is distinct from new.instructions
       or route_row.starts_on is distinct from new.starts_on
       or route_row.ends_on is distinct from new.ends_on
       or route_row.orderer_account_id is distinct from new.prescribed_by
       or route_row.prescribed_at is distinct from new.prescribed_at
       or route_row.accepted_by_account_id is distinct from new.accepted_by
       or route_row.accepted_by_membership_id is distinct from new.accepted_by_membership_id
       or new.facility_id is distinct from session_facility_id
       or new.accepted_by is distinct from session_account_id
       or new.accepted_by_membership_id is distinct from session_membership_id
       or new.source_status is distinct from 'active' then
      raise exception using errcode = '23514',
        message = 'Pharmacy work item does not match its accepted order route and actor context';
    end if;
    return new;
  end if;
  -- Same facility: the work item is exactly the EHR prescription it
  -- names, at the version accepted, held FOR SHARE until commit so the EHR
  -- cannot change or cancel it under the acceptance. Read as this function's
  -- owner: under production's forced row-level security only a prescription
  -- the session may read and write (its patient, this facility, write
  -- consent) is found, so any other is PRESCRIPTION_SOURCE_NOT_FOUND.
  select prescription.* into source_row
    from ehr.prescriptions prescription
   where prescription.id = new.source_ehr_prescription_id
   for share;
  if source_row.id is null then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_FOUND';
  end if;
  if source_row.status is distinct from 'active' then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_ACTIVE';
  end if;
  if source_row.row_version is distinct from new.source_ehr_prescription_version then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_VERSION_MISMATCH';
  end if;
  -- The session's facility is the work item's by 0077's check below. Texts
  -- as stored or as pharmacy-api trims them; the dose by value (numeric
  -- 500.0000 = 500); the time as stored or cut to the millisecond (the EHR
  -- API sends created_at through a JavaScript Date).
  if source_row.patient_id is distinct from new.patient_id
     or source_row.facility_id is distinct from new.facility_id
     or source_row.facility_id is distinct from new.ordering_facility_id
     or source_row.encounter_id is distinct from new.source_encounter_id
     or (new.medication_code_system is distinct from source_row.medication_code_system
         and new.medication_code_system is distinct from btrim(source_row.medication_code_system, js_whitespace))
     or (new.medication_code is distinct from source_row.medication_code
         and new.medication_code is distinct from btrim(source_row.medication_code, js_whitespace))
     or (new.medication_display is distinct from source_row.medication_display
         and new.medication_display is distinct from btrim(source_row.medication_display, js_whitespace))
     or source_row.dose_quantity is distinct from new.dose_quantity
     or (new.dose_unit is distinct from source_row.dose_unit
         and new.dose_unit is distinct from btrim(source_row.dose_unit, js_whitespace))
     or (new.route_code is distinct from source_row.route_code
         and new.route_code is distinct from btrim(source_row.route_code, js_whitespace))
     or (new.frequency is distinct from source_row.frequency
         and new.frequency is distinct from btrim(source_row.frequency, js_whitespace))
     or (new.instructions is distinct from source_row.instructions
         and new.instructions is distinct from btrim(source_row.instructions, js_whitespace))
     or source_row.starts_on is distinct from new.starts_on
     or source_row.ends_on is distinct from new.ends_on
     or source_row.created_by is distinct from new.prescribed_by
     or (new.prescribed_at is distinct from source_row.created_at
         and new.prescribed_at is distinct from date_trunc('milliseconds', source_row.created_at)) then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_MISMATCH';
  end if;
  -- Then 0077's and 0086's checks, unchanged.
  if session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or new.facility_id is distinct from new.ordering_facility_id
     or new.facility_id is distinct from session_facility_id
     or new.accepted_by is distinct from session_account_id
     or new.accepted_by_membership_id is distinct from session_membership_id
     or new.source_status is distinct from 'active' then
    raise exception using errcode = '23514',
      message = 'Pharmacy acceptance patient, facility, prescription status, or actor context is invalid';
  end if;
  perform 1 from ehr.order_routes route
   where route.source_prescription_id = new.source_ehr_prescription_id
     and (route.state in ('accepted', 'completed') or (route.state = 'sent' and clock_timestamp() < route.respond_by))
   for share;
  if found then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_ROUTED';
  end if;
  return new;
end
$$;

-- 2. Its comment, and no EXECUTE for PUBLIC (a trigger function needs none to
-- fire; it already has none, and runtime-grants.sql says so too).
comment on function pharmacy.validate_work_item() is
  '0100: a route-backed work item is exactly its accepted route''s prescription snapshot (0086); a same-facility one is exactly its ehr.prescriptions row, read FOR SHARE, at the version accepted (23514 PRESCRIPTION_SOURCE_NOT_FOUND, PRESCRIPTION_SOURCE_NOT_ACTIVE, PRESCRIPTION_SOURCE_VERSION_MISMATCH, PRESCRIPTION_SOURCE_MISMATCH), then keeps 0077''s checks and is refused while the prescription has a live route (PRESCRIPTION_ROUTED).';

revoke all on function pharmacy.validate_work_item() from public;

-- 3. Post-checks.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: md5=%s owner=%s definer=%s volatile=%s language=%s strict=%s config=%s',
           proc.oid::regprocedure, md5(proc.prosrc), pg_get_userbyid(proc.proowner), proc.prosecdef,
           proc.provolatile, language_row.lanname, proc.proisstrict, proc.proconfig), '; ')
    into mismatch
    from pg_proc proc
    join pg_language language_row on language_row.oid = proc.prolang
   where proc.oid = 'pharmacy.validate_work_item()'::regprocedure
     and (md5(proc.prosrc) <> 'e2411539ee8c95a02dad46c03e24db05'
       or not proc.prosecdef or proc.provolatile <> 'v' or language_row.lanname <> 'plpgsql' or proc.proisstrict
       or proc.proconfig is distinct from '{"search_path=pharmacy, platform, pg_temp"}'::text[]
       or proc.prorettype <> 'trigger'::regtype);
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'pharmacy.work_items'::regclass
             and trigger_row.tgfoid = 'pharmacy.validate_work_item()'::regprocedure
             and trigger_row.tgname = 'pharmacy_work_item_validate' and trigger_row.tgenabled = 'O') <> 1 then
    mismatch := 'the trigger pharmacy_work_item_validate';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0100: not as this file makes it: %s', mismatch);
  end if;
  -- No role but the owner holds anything on it (0086 left it so).
  select string_agg(case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
           || ' ' || acl.privilege_type, '; ')
    into mismatch
    from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
   where proc.oid = 'pharmacy.validate_work_item()'::regprocedure and acl.grantee <> proc.proowner;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0100: an ACL is not this file''s: %s', mismatch);
  end if;
end
$$;
