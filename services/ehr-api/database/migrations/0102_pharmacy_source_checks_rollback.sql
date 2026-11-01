-- 0102 Pharmacy source checks rollback: puts pharmacy.validate_work_item()
-- and pharmacy.validate_dispensing() back exactly as 0086 left them, which
-- switches off the checks 0100 and 0101 added. Prepared at the owner's request
-- of 2026-11-01 (D-Eminence: a ready rollback, kept on its own branch and
-- never merged unless needed); the declaration stays unsigned until the owner
-- decides to use it. ROLLBACK.md (at the root of the branch, not shipped) says
-- when and how. Written on 0101 (the pharmacy release head a25fc7a).
--
-- Renumbering: this file takes the next free number after the newest
-- released migration when it is used. The numbers in it are mechanical: 0102
-- is this migration and is replaced throughout; 0100 and 0101 are the guard's
-- two migrations and are replaced in the same pass only if the guard shipped
-- under other numbers; 0086 and 0099 are released history and stay. The
-- messages' "0001-0101" stays true when later migrations sit between the guard
-- and this one (none of them may touch what section 0 pins; if one does,
-- section 0 refuses and nothing is applied). No migration number appears
-- inside either function body (they are 0086's text), so renumbering leaves
-- their md5.
--
-- What it undoes. 0100 made a same-facility acceptance (order_route_id null)
-- read its ehr.prescriptions row FOR SHARE and refuse, with 23514,
-- PRESCRIPTION_SOURCE_NOT_FOUND, PRESCRIPTION_SOURCE_NOT_ACTIVE,
-- PRESCRIPTION_SOURCE_VERSION_MISMATCH or PRESCRIPTION_SOURCE_MISMATCH. 0101
-- made a same-facility dispensing read that row FOR SHARE and refuse, with
-- 23514, PRESCRIPTION_SOURCE_NOT_DISPENSABLE once the prescription is missing,
-- another patient's, facility's or encounter's, not active, or at another
-- version than the one accepted. Each replaced its function from 0086's text
-- and added a comment.
--
-- The change: both functions are replaced with 0086's text byte for byte
-- (0086 lines 9424-9491 and 9497-9533; md5 of pg_proc.prosrc
-- bc7df9aadfcc5f99965bcba0cfb2a5d7 and 23d9b6a9a9d09b106f685679df84f74f, the
-- values 0100 and 0101 checked before they ran), and the two comments are
-- removed (0099 had none). Signature, language, SECURITY DEFINER, volatility,
-- search_path, owner, ACL and triggers are kept (CREATE OR REPLACE). So
-- pg_dump --schema-only of the database equals a 0099 database's, and the
-- behaviour is 0099's again:
--   - a same-facility acceptance is checked only for the session, the
--     facility, the actor, source_status 'active' (which the caller sends) and
--     a live route to another facility (PRESCRIPTION_ROUTED); the database no
--     longer compares it with the EHR prescription;
--   - a same-facility dispensing no longer reads the prescription, so a work
--     item whose prescription was cancelled, put on hold, completed, marked
--     entered in error or changed after acceptance is dispensable again,
--     including the ones 0101 held back;
--   - the order-route branches (work sent from another facility) are byte for
--     byte the same in all four bodies, so cross-facility work is unchanged;
--   - pharmacy.validate_dispensing_reversal() is not touched.
-- Existing work items and dispensings are not touched (both triggers fire on
-- INSERT only). 0100 and 0101 stay in the ledger: applied migrations 0001
-- through 0101 are immutable, and this is a new forward migration.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied):
--    a. the objects 0001-0101 made exist (else "0102: 0001-0101 must be
--       applied first");
--    b. not applied yet: the two bodies are not both 0086's already (else
--       "0102: already applied, or 0100 and 0101 never were");
--    c. 0100 and 0101 applied and unchanged: validate_work_item's body is
--       0100's (e2411539ee8c95a02dad46c03e24db05) and validate_dispensing's is
--       0101's (17f7e8897bd2ab240332e4d2c9f757b7); validate_dispensing_reversal
--       and the three session readers the restored bodies call are as 0001-0101
--       left them; both functions' attributes and their two triggers (else
--       "0102: a function this migration relies on differs from 0001-0101");
--    d. the types and NOT NULLs of the 59 columns the restored bodies read, as
--       0099 and 0101 have them (else "0102: a column this migration relies on
--       differs from 0001-0101");
--    e. the applying role is each function's owner or a member that inherits
--       it and may SET ROLE to it; that owner may use the schemas, read
--       pharmacy.work_items, read and update (FOR UPDATE and FOR SHARE need
--       UPDATE) ehr.order_routes, and execute the session readers, never
--       through a superuser's bypass (else 42501 "0102: missing privileges").
--    ehr.prescriptions, its policies and the consent functions 0100 and 0101
--    pinned are not pinned here: the restored bodies do not read
--    ehr.prescriptions.
-- 1. The two functions, replaced with 0086's text (owner, ACL and triggers
--    kept).
-- 2. Their comments removed; their PUBLIC EXECUTE revoked (they have none;
--    runtime-grants.sql says so too).
-- 3. Post-checks: both bodies are 0086's, their attributes, triggers and
--    owner-only ACLs are as before, neither has a comment, and
--    validate_dispensing_reversal is still 0086's.
--
-- Locks (measured with pg_locks before commit on a 0101 copy): SHARE UPDATE
-- EXCLUSIVE on the two functions (their comments), ACCESS SHARE on schema
-- pharmacy and on the language, ACCESS EXCLUSIVE on the session's own
-- temporary schema (section 0's helper); no lock on any application table is
-- held to commit. Creating the functions resolves their %ROWTYPE declarations,
-- which opens pharmacy.work_items and ehr.order_routes for a moment, so behind
-- a session holding ACCESS EXCLUSIVE on either (DDL) the runner stopped after
-- its 5 s lock_timeout (5.1-5.3 s) with nothing applied, and applied once the
-- holder ended; behind ROW EXCLUSIVE on pharmacy.work_items,
-- pharmacy.dispensings, ehr.order_routes or ehr.prescriptions (rows being
-- written), and behind ACCESS EXCLUSIVE on pharmacy.dispensings or
-- ehr.prescriptions, it applied at once (runner 0.1-0.4 s; the migration's
-- own execution 14-25 ms). An acceptance or a dispensing already running
-- finishes with the body it started with; one that starts after the commit
-- runs 0086's.
-- At run time the restored bodies take only 0086's row locks (the route of a
-- route-backed work item FOR UPDATE, a prescription's live routes FOR SHARE)
-- and no longer lock ehr.prescriptions.
--
-- Services on this schema: the guard release's pharmacy-api maps 0100's four
-- messages and 0101's one to 404, 409, 409, 422 and 409; the database no longer
-- raises them, so those mappings never fire and every other answer is as
-- before. ehr-api's SERIALIZABLE order-route send and its calendar dates do
-- not depend on the checks and are kept. 82f52b9's images (0099) ran on these
-- bodies. Lab, the EHR API's other routes and the website are unaffected.
-- Suites: the guard's two suites (pharmacy-prescription-source,
-- pharmacy-dispensing-source) test the checks this switches off and are
-- removed with it; schema.integration.sql and pharmacy-session-guards go back
-- to 0099's text (82f52b9).

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0100's and 0101's helper).
create function pg_temp.pharmacy_rollback_0102_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  work_item_owner oid;
  dispensing_owner oid;
begin
  -- a. Prerequisites (0001-0101).
  if to_regclass('pharmacy.work_items') is null
     or to_regclass('pharmacy.dispensings') is null
     or to_regclass('ehr.order_routes') is null
     or to_regprocedure('pharmacy.validate_work_item()') is null
     or to_regprocedure('pharmacy.validate_dispensing()') is null
     or to_regprocedure('pharmacy.validate_dispensing_reversal()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_account_id()') is null
     or to_regprocedure('platform.current_membership_id()') is null then
    raise exception using errcode = '55000', message = '0102: 0001-0101 must be applied first';
  end if;
  -- b. Not applied yet: the two bodies are not both 0086's already. (A
  -- database where 0100 and 0101 never ran has them as 0086's too, and there is
  -- nothing to undo.)
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'pharmacy.validate_work_item()'::regprocedure)
       = 'bc7df9aadfcc5f99965bcba0cfb2a5d7'
     and (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure)
       = '23d9b6a9a9d09b106f685679df84f74f' then
    raise exception using errcode = '55000',
      message = '0102: already applied, or 0100 and 0101 never were: both functions are as 0086 left them';
  end if;
  -- c. 0100 and 0101 applied and unchanged (their bodies), the reversal guard
  -- this migration leaves as 0086 left it, and the three session readers the
  -- restored bodies call (0001, 0008).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('pharmacy.validate_work_item()', 'e2411539ee8c95a02dad46c03e24db05'),
      ('pharmacy.validate_dispensing()', '17f7e8897bd2ab240332e4d2c9f757b7'),
      ('pharmacy.validate_dispensing_reversal()', 'a8b1147f356e669fe0d14bea3e7ab014'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is null then
    select string_agg(format('%s attributes', expected.proc), '; ') into mismatch
      from (values ('pharmacy.validate_work_item()'), ('pharmacy.validate_dispensing()')) expected(proc)
     where not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                        where proc.oid = expected.proc::regprocedure
                          and language_row.lanname = 'plpgsql' and proc.prosecdef and proc.provolatile = 'v'
                          and not proc.proisstrict and proc.prorettype = 'trigger'::regtype
                          and proc.proconfig = '{"search_path=pharmacy, platform, pg_temp"}'::text[]);
  end if;
  if mismatch is null then
    select string_agg(format('the trigger %s', expected.trigger_name), '; ') into mismatch
      from (values ('pharmacy.work_items', 'pharmacy_work_item_validate', 'pharmacy.validate_work_item()'),
                   ('pharmacy.dispensings', 'pharmacy_dispensing_validate', 'pharmacy.validate_dispensing()'))
             expected(relation_name, trigger_name, proc)
     where (select count(*) from pg_trigger trigger_row
             where trigger_row.tgrelid = expected.relation_name::regclass
               and trigger_row.tgfoid = expected.proc::regprocedure
               and trigger_row.tgname = expected.trigger_name and trigger_row.tgenabled = 'O'
               and pg_get_triggerdef(trigger_row.oid) =
                 format('CREATE TRIGGER %s BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION %s',
                        expected.trigger_name, expected.relation_name, expected.proc)) <> 1;
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0102: a function this migration relies on differs from 0001-0101: %s', mismatch);
  end if;
  -- d. The columns the restored bodies read (as 0099 and 0101 have them).
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('pharmacy.work_items', 'id', 'uuid', true), ('pharmacy.work_items', 'patient_id', 'uuid', true),
      ('pharmacy.work_items', 'facility_id', 'uuid', true), ('pharmacy.work_items', 'ordering_facility_id', 'uuid', true),
      ('pharmacy.work_items', 'source_ehr_prescription_id', 'uuid', true),
      ('pharmacy.work_items', 'source_ehr_prescription_version', 'bigint', true),
      ('pharmacy.work_items', 'source_encounter_id', 'uuid', true), ('pharmacy.work_items', 'source_status', 'text', true),
      ('pharmacy.work_items', 'medication_code_system', 'text', false), ('pharmacy.work_items', 'medication_code', 'text', false),
      ('pharmacy.work_items', 'medication_display', 'text', true), ('pharmacy.work_items', 'dose_quantity', 'numeric(12,4)', false),
      ('pharmacy.work_items', 'dose_unit', 'text', false), ('pharmacy.work_items', 'route_code', 'text', false),
      ('pharmacy.work_items', 'frequency', 'text', true), ('pharmacy.work_items', 'instructions', 'text', true),
      ('pharmacy.work_items', 'starts_on', 'date', false), ('pharmacy.work_items', 'ends_on', 'date', false),
      ('pharmacy.work_items', 'prescribed_by', 'uuid', true),
      ('pharmacy.work_items', 'prescribed_at', 'timestamp with time zone', true),
      ('pharmacy.work_items', 'accepted_by', 'uuid', true), ('pharmacy.work_items', 'accepted_by_membership_id', 'uuid', true),
      ('pharmacy.work_items', 'row_version', 'bigint', true), ('pharmacy.work_items', 'order_route_id', 'uuid', false),
      ('pharmacy.dispensings', 'work_item_id', 'uuid', true), ('pharmacy.dispensings', 'work_item_version', 'bigint', true),
      ('pharmacy.dispensings', 'patient_id', 'uuid', true), ('pharmacy.dispensings', 'facility_id', 'uuid', true),
      ('pharmacy.dispensings', 'medication_code_system', 'text', false), ('pharmacy.dispensings', 'medication_code', 'text', false),
      ('pharmacy.dispensings', 'medication_display', 'text', true), ('pharmacy.dispensings', 'dispensed_by', 'uuid', true),
      ('pharmacy.dispensings', 'dispensed_by_membership_id', 'uuid', true),
      ('ehr.order_routes', 'id', 'uuid', true), ('ehr.order_routes', 'kind', 'text', true),
      ('ehr.order_routes', 'state', 'text', true), ('ehr.order_routes', 'pharmacy_work_item_id', 'uuid', false),
      ('ehr.order_routes', 'patient_id', 'uuid', true), ('ehr.order_routes', 'receiving_facility_id', 'uuid', true),
      ('ehr.order_routes', 'ordering_facility_id', 'uuid', true), ('ehr.order_routes', 'source_prescription_id', 'uuid', false),
      ('ehr.order_routes', 'source_order_version', 'bigint', true), ('ehr.order_routes', 'source_encounter_id', 'uuid', true),
      ('ehr.order_routes', 'medication_code_system', 'text', false), ('ehr.order_routes', 'medication_code', 'text', false),
      ('ehr.order_routes', 'medication_display', 'text', false), ('ehr.order_routes', 'dose_quantity', 'numeric(12,4)', false),
      ('ehr.order_routes', 'dose_unit', 'text', false), ('ehr.order_routes', 'route_code', 'text', false),
      ('ehr.order_routes', 'frequency', 'text', false), ('ehr.order_routes', 'instructions', 'text', false),
      ('ehr.order_routes', 'starts_on', 'date', false), ('ehr.order_routes', 'ends_on', 'date', false),
      ('ehr.order_routes', 'orderer_account_id', 'uuid', true),
      ('ehr.order_routes', 'prescribed_at', 'timestamp with time zone', false),
      ('ehr.order_routes', 'accepted_by_account_id', 'uuid', false),
      ('ehr.order_routes', 'accepted_by_membership_id', 'uuid', false),
      ('ehr.order_routes', 'respond_by', 'timestamp with time zone', true),
      ('ehr.order_routes', 'writes_end_at', 'timestamp with time zone', false))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0102: a column this migration relies on differs from 0001-0101: %s', mismatch);
  end if;
  -- e. Ownership and privileges, never through a superuser's bypass
  -- (production's migrator has none). CREATE OR REPLACE keeps each owner.
  work_item_owner := (select proc.proowner from pg_proc proc
                       where proc.oid = 'pharmacy.validate_work_item()'::regprocedure);
  dispensing_owner := (select proc.proowner from pg_proc proc
                        where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(owners.owner_id)) as what
        from (select distinct owner_id from (values (work_item_owner), (dispensing_owner)) both_owners(owner_id)) owners
       where applier <> owners.owner_id
         and not (pg_has_role(applier, owners.owner_id, 'USAGE') and pg_has_role(applier, owners.owner_id, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(owners.owner_id), wanted.privilege, namespace.nspname)
        from (select distinct owner_id from (values (work_item_owner), (dispensing_owner)) both_owners(owner_id)) owners
       cross join (values ('pharmacy', 'CREATE'), ('pharmacy', 'USAGE'), ('ehr', 'USAGE'), ('platform', 'USAGE'))
               wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.pharmacy_rollback_0102_holds(owners.owner_id, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks %s on %s', pg_get_userbyid(owners.owner_id), wanted.privilege, relation.oid::regclass)
        from (select distinct owner_id from (values (work_item_owner), (dispensing_owner)) both_owners(owner_id)) owners
       cross join (values ('pharmacy.work_items', 'SELECT'), ('ehr.order_routes', 'SELECT'), ('ehr.order_routes', 'UPDATE'))
               wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
       where not pg_temp.pharmacy_rollback_0102_holds(owners.owner_id, relation.relowner, relation.relacl, 'r',
               wanted.privilege)
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(owners.owner_id), proc.oid::regprocedure)
        from (select distinct owner_id from (values (work_item_owner), (dispensing_owner)) both_owners(owner_id)) owners
       cross join (values ('platform.current_facility_id()'), ('platform.current_account_id()'),
                          ('platform.current_membership_id()')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.pharmacy_rollback_0102_holds(owners.owner_id, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0102: missing privileges: %s', mismatch);
  end if;
  raise notice '0102: owners checked: pharmacy.validate_work_item()=%, pharmacy.validate_dispensing()=%, applier=%',
    pg_get_userbyid(work_item_owner), pg_get_userbyid(dispensing_owner), current_user;
end
$$;

-- 1. The two functions: 0086's text, byte for byte (0086 lines 9424-9491 and
-- 9497-9533, with 0086's own comments above each).

-- The Pharmacy twin: a route-backed work item is exactly its accepted
-- route's prescription snapshot; a same-facility one keeps 0077's checks and
-- is refused while the prescription has a live route (PRESCRIPTION_ROUTED).
create or replace function pharmacy.validate_work_item()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
  route_row ehr.order_routes%rowtype;
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

-- A dispensing of a route-backed work item locks its route FOR UPDATE (V9: a
-- concurrent cancellation makes the SERIALIZABLE dispensing fail and its
-- retry be refused) and needs it accepted and inside its work window
-- (ORDER_ROUTE_CLOSED); a same-facility dispensing is unchanged.
create or replace function pharmacy.validate_dispensing()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  parent_row pharmacy.work_items%rowtype;
  route_row ehr.order_routes%rowtype;
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
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
  return new;
end
$$;

-- 2. No comments (0099 had none; 0100 and 0101 added them), and no EXECUTE
-- for PUBLIC (a trigger function needs none to fire; they already have none,
-- and runtime-grants.sql says so too).
comment on function pharmacy.validate_work_item() is null;
comment on function pharmacy.validate_dispensing() is null;

revoke all on function pharmacy.validate_work_item() from public;
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
    from (values ('pharmacy.validate_work_item()', 'bc7df9aadfcc5f99965bcba0cfb2a5d7'),
                 ('pharmacy.validate_dispensing()', '23d9b6a9a9d09b106f685679df84f74f')) expected(proc, digest)
    join pg_proc proc on proc.oid = expected.proc::regprocedure
    join pg_language language_row on language_row.oid = proc.prolang
   where md5(proc.prosrc) <> expected.digest
      or not proc.prosecdef or proc.provolatile <> 'v' or language_row.lanname <> 'plpgsql' or proc.proisstrict
      or proc.proconfig is distinct from '{"search_path=pharmacy, platform, pg_temp"}'::text[]
      or proc.prorettype <> 'trigger'::regtype;
  if mismatch is null then
    select string_agg(format('the trigger %s', expected.trigger_name), '; ') into mismatch
      from (values ('pharmacy.work_items', 'pharmacy_work_item_validate', 'pharmacy.validate_work_item()'),
                   ('pharmacy.dispensings', 'pharmacy_dispensing_validate', 'pharmacy.validate_dispensing()'))
             expected(relation_name, trigger_name, proc)
     where (select count(*) from pg_trigger trigger_row
             where trigger_row.tgrelid = expected.relation_name::regclass
               and trigger_row.tgfoid = expected.proc::regprocedure
               and trigger_row.tgname = expected.trigger_name and trigger_row.tgenabled = 'O') <> 1;
  end if;
  if mismatch is null
     and (select md5(proc.prosrc) from pg_proc proc
           where proc.oid = 'pharmacy.validate_dispensing_reversal()'::regprocedure)
         is distinct from 'a8b1147f356e669fe0d14bea3e7ab014' then
    mismatch := 'pharmacy.validate_dispensing_reversal() changed';
  end if;
  if mismatch is null then
    select string_agg(format('%s has a comment', proc.oid::regprocedure), '; ') into mismatch
      from pg_proc proc
     where proc.oid in ('pharmacy.validate_work_item()'::regprocedure, 'pharmacy.validate_dispensing()'::regprocedure)
       and obj_description(proc.oid, 'pg_proc') is not null;
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0102: not as this file makes it: %s', mismatch);
  end if;
  -- No role but the owner holds anything on either (0086 left them so).
  select string_agg(proc.oid::regprocedure::text || ': '
           || case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
           || ' ' || acl.privilege_type, '; ')
    into mismatch
    from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
   where proc.oid in ('pharmacy.validate_work_item()'::regprocedure, 'pharmacy.validate_dispensing()'::regprocedure)
     and acl.grantee <> proc.proowner;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0102: an ACL is not this file''s: %s', mismatch);
  end if;
end
$$;
