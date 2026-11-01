-- 0101 Pharmacy dispensing checks its EHR prescription (the review of 0100;
-- owner decision of 2026-11-01, D-Eminence: "Fix it now"; main 0080's
-- dispensing half; the declaration signed separately). Written on 0100 and
-- the released 0099 (82f52b9); RENUMBER.md (beside the branch, not shipped)
-- says how it and 0100 are renumbered when other migrations ship first: the
-- two numbers are replaced mechanically throughout both files. No migration
-- number appears inside the function body, so renumbering leaves its md5.
--
-- The gap: 0100 checks a same-facility acceptance against its
-- ehr.prescriptions row and holds that row FOR SHARE, but only until the
-- acceptance commits. pharmacy.validate_dispensing (0086) reads
-- ehr.prescriptions only for a route-backed work item (through its route), so
-- after a legitimate same-facility acceptance the EHR could cancel the
-- prescription, put it on hold, complete it, mark it entered in error, or
-- change its instructions, frequency or dates, and the work item stayed
-- dispensable: pharmacy-api's dispensing INSERT went through. Work items are
-- insert-only and nothing updates them when the prescription changes.
--
-- The change: pharmacy.validate_dispensing is replaced from its latest
-- definition (0086) with one declaration and one block added after its
-- existing checks. The order-route branch (ORDER_ROUTE_CLOSED) and the actor
-- and work-item check (0077's message), their order, the signature,
-- language, SECURITY DEFINER, volatility, search_path (pharmacy, platform,
-- pg_temp; the new name is schema-qualified), owner, ACL and trigger are
-- unchanged, so a broken session or a dispensing that does not match its work
-- item still gets 0077's message first. Then, only for a same-facility work
-- item (order_route_id null), the ehr.prescriptions row it names is read FOR
-- SHARE (held to commit, so the EHR cannot cancel or change it under the
-- dispensing) and the dispensing is refused with 23514
-- PRESCRIPTION_SOURCE_NOT_DISPENSABLE when the row is missing, or its
-- patient_id, facility_id or encounter_id is not the work item's (patient_id,
-- facility_id, source_encounter_id), or its status is not 'active', or its
-- row_version is not the version Pharmacy accepted
-- (source_ehr_prescription_version). The other fields need no comparison:
-- the version is the EHR's row version, raised by every change of the row,
-- and 0100 made the work item equal to that version. Read as this function's
-- owner, so on production, where ehr.prescriptions forces row-level security
-- on its owner, only a prescription the session may read and update
-- (ehr.context_allows: this facility, write consent for its patient) is
-- found; pharmacy-api's dispensing already requires that consent for a
-- same-facility work item, and any other session is refused by 0077's check
-- first. pharmacy-api answers the new message 409
-- PHARMACY_PRESCRIPTION_NOT_DISPENSABLE, the code the website already handles
-- (it marks the work "Not dispensable"). pharmacy.validate_dispensing_reversal
-- is not changed: a dispensing recorded while the prescription was active can
-- still be reversed after the prescription is cancelled.
--
-- Owner decision this carries (as on main): once its prescription has
-- changed or stopped, a same-facility work item can be neither dispensed nor
-- accepted again (pharmacy.work_items keeps one work item per prescription,
-- unique(source_ehr_prescription_id), and pharmacy-api answers a second
-- acceptance 409), so the prescriber writes a new prescription. A
-- prescription that is put on hold and resumed is a new version, and its
-- work item stays undispensable too.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0100 applied (0100's
--    pharmacy.validate_work_item body the marker; else "0101: 0001-0100 must
--    be applied first"); not applied yet (else "0101: already applied"); the
--    bodies relied on are the ones 0001-0100 gave them (md5 of
--    pg_proc.prosrc): validate_dispensing and validate_dispensing_reversal as
--    0086 left them, the three session readers, and ehr.context_allows and
--    identity.has_active_consent_grant, through which row-level security
--    lets the owner see the prescription; validate_dispensing's attributes
--    and its trigger; the two ehr.prescriptions policies a read FOR SHARE
--    applies (prescriptions_read, prescriptions_update) and no restrictive
--    one; the types and NOT NULLs of the columns read; the applying role is
--    the function's owner or a member that inherits it and may SET ROLE to
--    it; that owner may use the schemas, read pharmacy.work_items, read and
--    update (FOR SHARE needs UPDATE) ehr.prescriptions and ehr.order_routes,
--    and execute the session readers and the policies' functions (never
--    through a superuser's bypass).
-- 1. The function, replaced (owner, ACL and trigger kept).
-- 2. Its comment; its PUBLIC EXECUTE revoked (it has none; runtime-grants.sql
--    says so too).
-- 3. Post-checks: the body is exactly this file's, the attributes, owner and
--    ACL are as before, the trigger still calls it, and
--    validate_dispensing_reversal is still 0086's.
--
-- Locks (measured with pg_locks before commit on a 0100 copy): SHARE UPDATE
-- EXCLUSIVE on the function (its comment), ACCESS SHARE on schema pharmacy
-- and on the language, ACCESS EXCLUSIVE on the session's own temporary schema
-- (section 0's helper); no lock on any application table is held to commit.
-- Section 0 (the policies' expressions) and the function's declarations
-- (%ROWTYPE) open ehr.prescriptions and pharmacy.work_items for a moment, so
-- behind a session holding ACCESS EXCLUSIVE on either (DDL) the runner stops
-- after its 5 s lock_timeout and applies nothing; behind ROW EXCLUSIVE on
-- ehr.prescriptions or pharmacy.dispensings (rows being written), and even
-- ACCESS EXCLUSIVE on pharmacy.dispensings, it applied at once. A dispensing
-- already running finishes with 0086's body; one that starts after the commit
-- runs this one.
-- At run time the same-facility branch adds one row lock, FOR SHARE on the
-- prescription, to a dispensing's transaction: an EHR change of that
-- prescription waits for the dispensing to commit, and a dispensing that
-- reaches a prescription being changed waits, then (pharmacy-api's
-- SERIALIZABLE transaction) fails with 40001, which pharmacy-api retries and
-- the retry is refused PRESCRIPTION_SOURCE_NOT_DISPENSABLE. A route-backed
-- dispensing takes no new lock.
--
-- Old services on this schema: today's pharmacy-api sends the same INSERT; a
-- dispensing of a work item whose prescription is still active at the
-- accepted version passes, and the new refusal reaches today's pharmacy-api as
-- a 23514 error it does not map for a same-facility work item (500; the
-- website says the action could not be recorded) until the new image maps it.
-- The EHR API, Lab, the website, the order-route branch and reversals are
-- unaffected. Existing work items and dispensings are not touched (the
-- trigger fires on INSERT only). Applied migrations 0001 through 0100 are
-- immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0097's, 0099's and 0100's helper).
create function pg_temp.pharmacy_dispensing_0101_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  -- a. Prerequisites (0001-0100; 0100's body is the marker).
  if to_regclass('pharmacy.work_items') is null
     or to_regclass('pharmacy.dispensings') is null
     or to_regclass('ehr.prescriptions') is null
     or to_regclass('ehr.order_routes') is null
     or to_regprocedure('pharmacy.validate_dispensing()') is null
     or to_regprocedure('pharmacy.validate_dispensing_reversal()') is null
     or to_regprocedure('pharmacy.validate_work_item()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_account_id()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('ehr.context_allows(uuid,uuid,text)') is null
     or to_regprocedure('ehr.patient_self_context(uuid)') is null
     or to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)') is null
     or (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'pharmacy.validate_work_item()'::regprocedure)
        is distinct from 'e2411539ee8c95a02dad46c03e24db05' then
    raise exception using errcode = '55000', message = '0101: 0001-0100 must be applied first';
  end if;
  -- b. Not applied yet: the body is not this file's already.
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure)
     = '17f7e8897bd2ab240332e4d2c9f757b7' then
    raise exception using errcode = '55000', message = '0101: already applied';
  end if;
  -- c. The bodies relied on, as 0001-0100 left them: the function replaced
  -- and the reversal guard kept (0086), the three session readers it calls
  -- (0001, 0008), and the consent gate row-level security puts in front of
  -- its read of ehr.prescriptions (0005, 0012).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('pharmacy.validate_dispensing()', '23d9b6a9a9d09b106f685679df84f74f'),
      ('pharmacy.validate_dispensing_reversal()', 'a8b1147f356e669fe0d14bea3e7ab014'),
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
                      where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure
                        and language_row.lanname = 'plpgsql' and proc.prosecdef and proc.provolatile = 'v'
                        and not proc.proisstrict and proc.prorettype = 'trigger'::regtype
                        and proc.proconfig = '{"search_path=pharmacy, platform, pg_temp"}'::text[]) then
    mismatch := 'pharmacy.validate_dispensing() attributes';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'pharmacy.dispensings'::regclass
             and trigger_row.tgfoid = 'pharmacy.validate_dispensing()'::regprocedure
             and trigger_row.tgname = 'pharmacy_dispensing_validate' and trigger_row.tgenabled = 'O'
             and pg_get_triggerdef(trigger_row.oid) =
               'CREATE TRIGGER pharmacy_dispensing_validate BEFORE INSERT ON pharmacy.dispensings '
               || 'FOR EACH ROW EXECUTE FUNCTION pharmacy.validate_dispensing()') <> 1 then
    mismatch := 'the trigger pharmacy_dispensing_validate';
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
      message = format('0101: a function this migration relies on differs from 0001-0100: %s', mismatch);
  end if;
  -- d. The columns read.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('ehr.prescriptions', 'id', 'uuid', true),
      ('ehr.prescriptions', 'encounter_id', 'uuid', true),
      ('ehr.prescriptions', 'patient_id', 'uuid', true),
      ('ehr.prescriptions', 'facility_id', 'uuid', true),
      ('ehr.prescriptions', 'status', 'text', true),
      ('ehr.prescriptions', 'row_version', 'bigint', true),
      ('pharmacy.work_items', 'id', 'uuid', true),
      ('pharmacy.work_items', 'patient_id', 'uuid', true),
      ('pharmacy.work_items', 'facility_id', 'uuid', true),
      ('pharmacy.work_items', 'source_ehr_prescription_id', 'uuid', true),
      ('pharmacy.work_items', 'source_ehr_prescription_version', 'bigint', true),
      ('pharmacy.work_items', 'source_encounter_id', 'uuid', true),
      ('pharmacy.work_items', 'order_route_id', 'uuid', false),
      ('pharmacy.dispensings', 'work_item_id', 'uuid', true))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0101: a column this migration relies on differs from 0001-0100: %s', mismatch);
  end if;
  -- e. Ownership and privileges, never through a superuser's bypass
  -- (production's migrator has none). CREATE OR REPLACE keeps the owner.
  function_owner := (select proc.proowner from pg_proc proc
                      where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure);
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
       where not pg_temp.pharmacy_dispensing_0101_holds(function_owner, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks %s on %s', pg_get_userbyid(function_owner), wanted.privilege, relation.oid::regclass)
        from (values ('pharmacy.work_items', 'SELECT'), ('ehr.prescriptions', 'SELECT'), ('ehr.prescriptions', 'UPDATE'),
                     ('ehr.order_routes', 'SELECT'), ('ehr.order_routes', 'UPDATE')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
       where not pg_temp.pharmacy_dispensing_0101_holds(function_owner, relation.relowner, relation.relacl, 'r',
               wanted.privilege)
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(function_owner), proc.oid::regprocedure)
        from (values ('platform.current_facility_id()'), ('platform.current_account_id()'),
                     ('platform.current_membership_id()'), ('ehr.context_allows(uuid,uuid,text)'),
                     ('ehr.patient_self_context(uuid)')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.pharmacy_dispensing_0101_holds(function_owner, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0101: missing privileges: %s', mismatch);
  end if;
  raise notice '0101: owners checked: pharmacy.validate_dispensing()=%, ehr.prescriptions=%, applier=%',
    pg_get_userbyid(function_owner),
    (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'ehr.prescriptions'::regclass),
    current_user;
end
$$;

-- 1. The function: 0086's text, with the same-facility check after its
-- existing checks and one declaration added for it.
create or replace function pharmacy.validate_dispensing()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  parent_row pharmacy.work_items%rowtype;
  route_row ehr.order_routes%rowtype;
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
  source_row ehr.prescriptions%rowtype;
begin
  select * into parent_row from pharmacy.work_items where id = new.work_item_id;
  if parent_row.order_route_id is not null then
    select route.* into route_row from ehr.order_routes route where route.id = parent_row.order_route_id for update;
    if route_row.id is null or route_row.state is distinct from 'accepted'
       or not coalesce(clock_timestamp() < route_row.writes_end_at, false) then
      raise exception using errcode = '23514', message = 'ORDER_ROUTE_CLOSED';
    end if;
  end if;
  if parent_row.id is null
     or session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or parent_row.patient_id is distinct from new.patient_id
     or parent_row.facility_id is distinct from new.facility_id
     or parent_row.row_version is distinct from new.work_item_version
     or parent_row.medication_code_system is distinct from new.medication_code_system
     or parent_row.medication_code is distinct from new.medication_code
     or parent_row.medication_display is distinct from new.medication_display
     or new.facility_id is distinct from session_facility_id
     or new.dispensed_by is distinct from session_account_id
     or new.dispensed_by_membership_id is distinct from session_membership_id then
    raise exception using errcode = '23514',
      message = 'Dispensing does not match its eligible Pharmacy work item and actor context';
  end if;
  -- Same facility: dispensable only while the EHR prescription the work item
  -- names is still active, at the version Pharmacy accepted, for its patient,
  -- facility and encounter. Read FOR SHARE until commit, so the EHR cannot
  -- cancel or change it under the dispensing. Read as this function's owner:
  -- under production's forced row-level security only a prescription the
  -- session may read and write is found, and any other is not dispensable.
  if parent_row.order_route_id is null then
    select prescription.* into source_row
      from ehr.prescriptions prescription
     where prescription.id = parent_row.source_ehr_prescription_id
       for share;
    if source_row.id is null
       or source_row.patient_id is distinct from parent_row.patient_id
       or source_row.facility_id is distinct from parent_row.facility_id
       or source_row.encounter_id is distinct from parent_row.source_encounter_id
       or source_row.status is distinct from 'active'
       or source_row.row_version is distinct from parent_row.source_ehr_prescription_version then
      raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE';
    end if;
  end if;
  return new;
end
$$;

-- 2. Its comment, and no EXECUTE for PUBLIC (a trigger function needs none to
-- fire; it already has none, and runtime-grants.sql says so too).
comment on function pharmacy.validate_dispensing() is
  '0101: a route-backed work item is dispensable only while its route is accepted and inside its work window (0086, ORDER_ROUTE_CLOSED); the dispensing must match its work item and the session (0077); a same-facility work item is dispensable only while its ehr.prescriptions row, read FOR SHARE, is active at the version accepted, for its patient, facility and encounter (23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE).';

revoke all on function pharmacy.validate_dispensing() from public;

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
   where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure
     and (md5(proc.prosrc) <> '17f7e8897bd2ab240332e4d2c9f757b7'
       or not proc.prosecdef or proc.provolatile <> 'v' or language_row.lanname <> 'plpgsql' or proc.proisstrict
       or proc.proconfig is distinct from '{"search_path=pharmacy, platform, pg_temp"}'::text[]
       or proc.prorettype <> 'trigger'::regtype);
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'pharmacy.dispensings'::regclass
             and trigger_row.tgfoid = 'pharmacy.validate_dispensing()'::regprocedure
             and trigger_row.tgname = 'pharmacy_dispensing_validate' and trigger_row.tgenabled = 'O') <> 1 then
    mismatch := 'the trigger pharmacy_dispensing_validate';
  end if;
  if mismatch is null
     and (select md5(proc.prosrc) from pg_proc proc
           where proc.oid = 'pharmacy.validate_dispensing_reversal()'::regprocedure)
         is distinct from 'a8b1147f356e669fe0d14bea3e7ab014' then
    mismatch := 'pharmacy.validate_dispensing_reversal() changed';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0101: not as this file makes it: %s', mismatch);
  end if;
  -- No role but the owner holds anything on it (0086 left it so).
  select string_agg(case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
           || ' ' || acl.privilege_type, '; ')
    into mismatch
    from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
   where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure and acl.grantee <> proc.proowner;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0101: an ACL is not this file''s: %s', mismatch);
  end if;
end
$$;
