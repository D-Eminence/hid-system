\set ON_ERROR_STOP on
-- 0158 (ORD-6): several tests in one lab request. The clinical owner's design
-- note on #258 (7214746190), revised after Rahman's review 7167493074.
-- Rollback-only.
-- Part A runs 0158 itself, as written (psql \ir), as the runner runs it
-- inside its transaction, as the tables' owner (the migrator):
--   1. as the runner left it: request_group_id uuid, nullable, no default, on
--      ehr.lab_requests and lab.work_items; the trigger lab_requests_group_fixed
--      by its printed form, enabled, before lab_requests_versioned; the guard
--      (body, owner, SECURITY INVOKER, search_path, plpgsql, EXECUTE for the
--      owner only); the validator (body, owner, SECURITY DEFINER, search_path,
--      VOLATILE, its ACL unchanged: PUBLIC and the owner); the pins and 0156's
--      two CHECKs unchanged;
--   2. a second run answers "0158: already applied" (55000);
--   3. each tamper of the guard is refused, "0158: not in the reviewed state"
--      (55000, from section 0, so nothing is applied): a WHEN added to the
--      trigger, the trigger disabled, the function edited, SECURITY DEFINER set
--      on it, PUBLIC granted it, the owner's own EXECUTE revoked (an empty
--      ACL); and the validator back at 0086's body under the new columns;
--      0156's marker missing; a pinned function changed; ehr.order_routes
--      owned by another role (section 0's one-owner rule);
--   4. the undo of 0158's header (the trigger and the guard dropped, 0086's
--      validator back, md5 efac1507): the columns stay, so the file refuses
--      (not in the reviewed state); with the columns dropped as well, and
--      0156's CHECK on lab.work_items kept by name, validated and on the
--      pair but printed otherwise, section 2b refuses under the locks
--      (section 0 prints nothing); then 0158 applies again exactly as the
--      runner left it.
-- Part B is the data path, through the exact runtime roles and the services'
-- statements (cases recorded, all checked at the end):
--   1. the guard: with an actor (the EHR runtime, a change reason) a change
--      of the group is refused 55000 LAB_REQUEST_GROUP_FIXED, to another
--      group, to null, and from null; the same value passes, and a change of
--      another column keeps the group; without an actor (the suite runner)
--      the guard answers 55000 first, where ehr.capture_record_version would
--      answer 42501 (shown on another column);
--   2. the validator: lab-api's Release E insert (no group named) copies the
--      EHR row's group, and leaves null for an order without one; a work item
--      naming its order's group is accepted; one naming another group, or a
--      group for an order without one, is refused 23514
--      LAB_REQUEST_GROUP_MISMATCH; a draft activated later keeps its group;
--      a routed work item (another facility) with a group is refused 23514,
--      and without one is accepted;
--   3. ehr-api's inserts: Release E's (no group) saves null; ORD-6's names
--      the group;
--   4. a name-only test (0156) in a group: its work item takes the group and
--      its requested test the null pair;
--   5. the guard's temporary-table probe (moved here from the file, Rahman's
--      nit): the guard on a temporary table refuses a change, passes the
--      same value, and is not fired by a SET that does not name the column.
-- Synthetic values only; uuid prefix e58, grp names, .invalid addresses.
set plpgsql.variable_conflict = error;

-- Runs 0158 as written, as the runner runs it inside its transaction, and keeps what it answered (SQLSTATE and
-- message, or 'applied'). psql stops an included file at its first error while ON_ERROR_STOP is on, and reads
-- ON_ERROR_STOP for a line before the line runs; so the line before turns it off for the line that includes 0158
-- (this suite goes on), and this line turns it on for 0158's own lines (0158 stops at its first error, as the
-- runner's one transaction does). Each run is followed by "\set ON_ERROR_STOP on" and "\set QUIET off".
\set run0158 '\\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\set ON_ERROR_STOP on \\ir ../../database/migrations/0158_lab_request_groups.sql'

begin;

-- A case of part A stops the suite at once when it fails. Passes are counted in a sequence, which keeps its count
-- across ROLLBACK TO SAVEPOINT.
create temporary sequence lab_request_groups_passed;
grant usage on sequence lab_request_groups_passed to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $f$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception E'0158 lab request groups suite failed: %:\n  expected [%]\n  got      [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  perform nextval('pg_temp.lab_request_groups_passed');
  raise notice '0158 lab request groups: % passed', case_name;
end
$f$;
-- What 0158 makes or keeps, as one text: both columns, the trigger, the guard and the validator (body, owner,
-- attributes, grants), the comments. The owner of ehr.lab_requests is printed as "owner".
create function pg_temp.schema_print() returns text language sql as $f$
  with owner_row(oid) as (select relation.relowner from pg_class relation where relation.oid = 'ehr.lab_requests'::regclass)
  select concat_ws(E'\n',
    (select string_agg(format('%s.%s %s %s default=%s', attribute_row.attrelid::regclass, attribute_row.attname,
              format_type(attribute_row.atttypid, attribute_row.atttypmod),
              case when attribute_row.attnotnull then 'not null' else 'null' end, attribute_row.atthasdef::text), E'\n'
              order by attribute_row.attrelid::regclass::text)
       from pg_attribute attribute_row
      where attribute_row.attrelid in ('ehr.lab_requests'::regclass, 'lab.work_items'::regclass)
        and attribute_row.attname = 'request_group_id' and not attribute_row.attisdropped),
    (select string_agg(format('%s %s %s', pg_get_triggerdef(trigger_row.oid), trigger_row.tgenabled,
              trigger_row.tgfoid::regprocedure), E'\n')
       from pg_trigger trigger_row
      where trigger_row.tgrelid = 'ehr.lab_requests'::regclass and trigger_row.tgname = 'lab_requests_group_fixed'),
    (select string_agg(format('%s %s %s definer=%s %s %s %s %s', proc.oid::regprocedure, md5(proc.prosrc),
              case when proc.proowner = (select oid from owner_row) then 'owner' else 'not the owner' end,
              proc.prosecdef::text, proc.provolatile, language_row.lanname, proc.proconfig,
              (select string_agg(case when acl.grantee = 0 then 'PUBLIC' when acl.grantee = proc.proowner then 'owner'
                                      else pg_get_userbyid(acl.grantee) end || ':' || acl.privilege_type, ','
                                 order by 1)
                 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl)), E'\n'
              order by proc.oid::regprocedure::text)
       from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
      where proc.oid in (to_regprocedure('ehr.lab_request_group_fixed()'), 'lab.validate_work_item()'::regprocedure)),
    (select string_agg(coalesce(col_description(attribute_row.attrelid, attribute_row.attnum), 'no comment'), E'\n'
              order by attribute_row.attrelid::regclass::text)
       from pg_attribute attribute_row
      where attribute_row.attrelid in ('ehr.lab_requests'::regclass, 'lab.work_items'::regclass)
        and attribute_row.attname = 'request_group_id' and not attribute_row.attisdropped),
    obj_description(to_regprocedure('ehr.lab_request_group_fixed()'), 'pg_proc'));
$f$;
select pg_get_userbyid(relation.relowner) as q158_owner from pg_class relation
 where relation.oid = 'ehr.lab_requests'::regclass \gset
select md5(pg_temp.schema_print()) as q158_applied \gset

-- A1. As the runner left it.
select pg_temp.expect('A1a request_group_id: uuid, nullable, no default, on both tables',
  'ehr.lab_requests.request_group_id uuid null default=false|lab.work_items.request_group_id uuid null default=false',
  (select string_agg(format('%s.%s %s %s default=%s', attribute_row.attrelid::regclass, attribute_row.attname,
            format_type(attribute_row.atttypid, attribute_row.atttypmod),
            case when attribute_row.attnotnull then 'not null' else 'null' end, attribute_row.atthasdef::text), '|'
            order by attribute_row.attrelid::regclass::text)
     from pg_attribute attribute_row
    where attribute_row.attrelid in ('ehr.lab_requests'::regclass, 'lab.work_items'::regclass)
      and attribute_row.attname = 'request_group_id' and not attribute_row.attisdropped
      and attribute_row.attidentity = '' and attribute_row.attgenerated = ''));
select pg_temp.expect('A1b the guard trigger by its printed form, enabled (O), no WHEN, no arguments',
  'CREATE TRIGGER lab_requests_group_fixed BEFORE UPDATE OF request_group_id ON ehr.lab_requests FOR EACH ROW '
  || 'EXECUTE FUNCTION ehr.lab_request_group_fixed() O ehr.lab_request_group_fixed() qual=true nargs=0',
  (select string_agg(format('%s %s %s qual=%s nargs=%s', pg_get_triggerdef(trigger_row.oid), trigger_row.tgenabled,
            trigger_row.tgfoid::regprocedure, (trigger_row.tgqual is null)::text, trigger_row.tgnargs), '|')
     from pg_trigger trigger_row
    where trigger_row.tgrelid = 'ehr.lab_requests'::regclass and trigger_row.tgname = 'lab_requests_group_fixed'
      and not trigger_row.tgisinternal));
select pg_temp.expect('A1c the guard fires first among the BEFORE UPDATE row triggers of ehr.lab_requests',
  'lab_requests_group_fixed,lab_requests_versioned',
  (select string_agg(trigger_row.tgname, ',' order by trigger_row.tgname::text collate "C")
     from pg_trigger trigger_row
    where trigger_row.tgrelid = 'ehr.lab_requests'::regclass and not trigger_row.tgisinternal
      and trigger_row.tgtype & 1 = 1 and trigger_row.tgtype & 2 = 2 and trigger_row.tgtype & 16 = 16));
select pg_temp.expect('A1d the guard and the validator: body, owner, definer, volatility, language, search_path, '
  || 'ACL (the guard: the owner only; the validator: unchanged, PUBLIC and the owner)',
  'ehr.lab_request_group_fixed() 58e4b93e313cf07a38ee57f5a10fa5bb owner definer=false v plpgsql '
  || '{"search_path=pg_catalog, pg_temp"} owner:EXECUTE' || E'\n'
  || 'lab.validate_work_item() 04504d00ebd8940a8178ce35343f4f8c owner definer=true v plpgsql '
  || '{"search_path=lab, ehr, identity, auth, platform, pg_temp"} PUBLIC:EXECUTE,owner:EXECUTE',
  (select string_agg(line, E'\n') from (select unnest(string_to_array(pg_temp.schema_print(), E'\n')) as line) lines
    where line like 'ehr.lab_request_group_fixed() %' or line like 'lab.validate_work_item() %'));
select pg_temp.expect('A1e the validators share an owner, as lab-session-guards requires',
  'same', (select case when count(distinct proc.proowner) = 1 then 'same' else 'different' end from pg_proc proc
            where proc.oid in ('lab.validate_work_item()'::regprocedure, 'lab.validate_work_item_child()'::regprocedure,
                               'ehr.lab_request_group_fixed()'::regprocedure)));
select pg_temp.expect('A1f the pins and 0156''s two pair CHECKs unchanged',
  'lab.validate_work_item_child() 9bc011f7583332dd3de12ce2a8e45753|platform.current_account_id() '
  || 'b715ffe72856836d13ab16656fa6e94a|platform.current_facility_id() c4a7c2989e83d9cedbf1f7b785a5aaed|'
  || 'platform.current_membership_id() 641989704fea95f885fbc38c6feb5aa5|'
  || 'lab_requests_test_code_pair_ck CHECK (((test_code_system IS NULL) = (test_code IS NULL))) true|'
  || 'work_items_test_code_pair_ck CHECK (((test_code_system IS NULL) = (test_code IS NULL))) true',
  (select string_agg(entry, '|' order by ord, entry collate "C") from (
     select 1 as ord, proc.oid::regprocedure::text || ' ' || md5(proc.prosrc) as entry from pg_proc proc
      where proc.oid in ('lab.validate_work_item_child()'::regprocedure, 'platform.current_facility_id()'::regprocedure,
                         'platform.current_account_id()'::regprocedure, 'platform.current_membership_id()'::regprocedure)
     union all
     select 2, format('%s %s %s', constraint_row.conname, pg_get_constraintdef(constraint_row.oid),
                      constraint_row.convalidated::text)
       from pg_constraint constraint_row
      where constraint_row.conname in ('lab_requests_test_code_pair_ck', 'work_items_test_code_pair_ck')
        and constraint_row.conrelid in ('ehr.lab_requests'::regclass, 'lab.work_items'::regclass)) entries));

-- A2. A second run answers "already applied" and changes nothing (the runner's transaction rolls back).
savepoint again;
set local role :"q158_owner";
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint again;
select pg_temp.expect('A2 a second run answers "0158: already applied" (55000); nothing changed',
  '55000 0158: already applied | same',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | '
  || case when md5(pg_temp.schema_print()) = :'q158_applied' then 'same' else 'changed' end);

-- 0086's validator body, rebuilt from the new one without 0158's lines (and checked by its md5).
create function pg_temp.validator_0086_body() returns text language sql as $f$
  select replace(replace(proc.prosrc,
           E'\n       or new.request_group_id is not null then', ' then'),
           E'  if new.request_group_id is not null and new.request_group_id is distinct from source_row.request_group_id then\n'
           || E'    raise exception using errcode=''23514'',message=''LAB_REQUEST_GROUP_MISMATCH'';\n'
           || E'  end if;\n  new.request_group_id := source_row.request_group_id;\n', '')
    from pg_proc proc where proc.oid = 'lab.validate_work_item()'::regprocedure
$f$;
select pg_temp.expect('A3f 0086''s validator body rebuilt (md5 efac1507)', 'efac15072e0a6e68dff199026ff6f73e',
  md5(pg_temp.validator_0086_body()));
create function pg_temp.restore_validator_0086() returns void language plpgsql as $f$
begin
  execute format('create or replace function lab.validate_work_item() returns trigger language plpgsql '
    || 'security definer set search_path = lab, ehr, identity, auth, platform, pg_temp as %L',
    pg_temp.validator_0086_body());
end
$f$;
grant execute on function pg_temp.validator_0086_body(), pg_temp.restore_validator_0086() to public;

-- A3. Each tamper, as the tables' owner, then 0158: refused by section 0 (55000, before any lock or change).
savepoint tampered;
set local role :"q158_owner";
drop trigger lab_requests_group_fixed on ehr.lab_requests;
create trigger lab_requests_group_fixed before update of request_group_id on ehr.lab_requests
  for each row when (false) execute function ehr.lab_request_group_fixed();
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint tampered;
select pg_temp.expect('A3a a WHEN (false) added to the trigger is refused, not "already applied"',
  '55000 0158: not in the reviewed state', :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q158_owner";
alter table ehr.lab_requests disable trigger lab_requests_group_fixed;
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint tampered;
select pg_temp.expect('A3b the trigger disabled is refused',
  '55000 0158: not in the reviewed state', :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q158_owner";
create or replace function ehr.lab_request_group_fixed()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  return new;
end;
$$;
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint tampered;
select pg_temp.expect('A3c the guard''s body edited is refused',
  '55000 0158: not in the reviewed state', :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q158_owner";
alter function ehr.lab_request_group_fixed() security definer;
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint tampered;
select pg_temp.expect('A3d SECURITY DEFINER set on the guard is refused',
  '55000 0158: not in the reviewed state', :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q158_owner";
grant execute on function ehr.lab_request_group_fixed() to public;
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint tampered;
select pg_temp.expect('A3e PUBLIC granted EXECUTE on the guard is refused',
  '55000 0158: not in the reviewed state', :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q158_owner";
select pg_temp.restore_validator_0086();
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint tampered;
select pg_temp.expect('A3g 0086''s validator under the new columns, trigger and guard is refused',
  '55000 0158: not in the reviewed state', :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q158_owner";
alter table lab.work_items drop constraint work_items_test_code_pair_ck;
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint tampered;
select pg_temp.expect('A3h 0156''s pair CHECK on lab.work_items missing: 0156''s marker refuses',
  '55000 0158: 0001-0153 and 0156 must be applied first', :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q158_owner";
create or replace function lab.validate_work_item_child()
returns trigger language plpgsql security definer set search_path=lab,pg_temp as $$
begin
  return new;
end
$$;
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint tampered;
select pg_temp.expect('A3i a pinned function changed (the child validator) is refused',
  '55000 0158: these functions are not as 0001-0156 left them: lab.validate_work_item_child()',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q158_owner";
revoke execute on function ehr.lab_request_group_fixed() from :"q158_owner";
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint tampered;
select pg_temp.expect('A3k the owner''s own EXECUTE revoked from the guard (an empty ACL) is refused, not "already applied"',
  '55000 0158: not in the reviewed state', :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
alter table ehr.order_routes owner to hid_lab_api_runtime;
set local role :"q158_owner";
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint tampered;
select pg_temp.expect('A3l ehr.order_routes owned by another role is refused by section 0 (55000), not in the lock loop',
  '55000 0158: ' || :'q158_owner' || ', the owner of ehr.lab_requests, must own ehr.order_routes and may create in '
  || 'schema ehr', :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
select pg_temp.expect('A3j after every tamper, the state is as the runner left it',
  :'q158_applied', md5(pg_temp.schema_print()));

-- A4. The undo of 0158's header, as the tables' owner, in this transaction: the trigger and the guard dropped, 0086's
-- validator back (its ACL kept). The columns stay, so 0158 refuses; with them dropped too, 0158 applies again exactly
-- as the runner left it.
savepoint undone;
set local role :"q158_owner";
drop trigger lab_requests_group_fixed on ehr.lab_requests;
drop function ehr.lab_request_group_fixed();
select pg_temp.restore_validator_0086();
reset role;
select pg_temp.expect('A4a the undo: no trigger or guard; 0086''s validator (md5, attributes, ACL kept); the columns stay',
  'lab.validate_work_item() efac15072e0a6e68dff199026ff6f73e owner definer=true v plpgsql '
  || '{"search_path=lab, ehr, identity, auth, platform, pg_temp"} PUBLIC:EXECUTE,owner:EXECUTE|trigger=0|columns=2',
  (select string_agg(line, '|') from (select unnest(string_to_array(pg_temp.schema_print(), E'\n')) as line) lines
    where line like 'lab.validate_work_item() %' or line like 'ehr.lab_request_group_fixed() %')
  || '|trigger=' || (select count(*) from pg_trigger where tgname = 'lab_requests_group_fixed')
  || '|columns=' || (select count(*) from pg_attribute attribute_row
                      where attribute_row.attrelid in ('ehr.lab_requests'::regclass, 'lab.work_items'::regclass)
                        and attribute_row.attname = 'request_group_id' and not attribute_row.attisdropped));
savepoint after_undo;
set local role :"q158_owner";
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint after_undo;
select pg_temp.expect('A4b after the undo the columns stay, so 0158 refuses',
  '55000 0158: not in the reviewed state', :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q158_owner";
alter table ehr.lab_requests drop column request_group_id;
alter table lab.work_items drop column request_group_id;
savepoint check_printed_otherwise;
alter table lab.work_items drop constraint work_items_test_code_pair_ck;
alter table lab.work_items add constraint work_items_test_code_pair_ck
  check (test_code_system is not null or test_code is null);
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint check_printed_otherwise;
select pg_temp.expect('A4c 0156''s CHECK on lab.work_items by name and columns, validated, printed otherwise: '
  || 'section 2b refuses under the locks, nothing applied',
  '55000 0158: 0001-0153 and 0156 must be applied first | columns=0',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | columns='
  || (select count(*) from pg_attribute attribute_row
       where attribute_row.attrelid in ('ehr.lab_requests'::regclass, 'lab.work_items'::regclass)
         and attribute_row.attname = 'request_group_id' and not attribute_row.attisdropped));
\set ON_ERROR_STOP off
:run0158
\set ON_ERROR_STOP on
\set QUIET off
reset role;
select pg_temp.expect('A4d with the columns dropped too, 0158 applies again, exactly as the runner left it',
  'applied | as built', :'LAST_ERROR_MESSAGE' || ' | '
  || case when md5(pg_temp.schema_print()) = :'q158_applied' then 'as built' else pg_temp.schema_print() end);
release savepoint undone;
select pg_temp.expect('A part done', '23', (select last_value::text from pg_temp.lab_request_groups_passed));

-- B. The data path. Clinics F1 (e5800000-...02) and F2 (e5800000-...03) of one organization; member A of F1 orders
-- and accepts (an active write consent for patient P in F1, direct care), member G of F2 accepts a route. Encounter N
-- in F1. Lab requests of A, all active at version 1 unless named: LR1-LR3 and LR7 in group G1; LR4 and LR5 with no
-- group; LR6 by name only (no codes) in group G2; LR8 in group G3, routed to F2 (route R8, accepted by G); LR9 a
-- draft in group G1.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system)
values ('direct-care', 'Direct patient care', 'lab-request-groups-test') on conflict (code) do nothing;
insert into identity.organizations (id, name, slug) values
  ('e5800000-0000-4000-8000-000000000001', 'Group Test Organization', 'grp-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e5800000-0000-4000-8000-000000000002', 'e5800000-0000-4000-8000-000000000001', 'Group Test Clinic F1',
   'GRP-TEST-F1', 'Africa/Lagos', true, 'verified'),
  ('e5800000-0000-4000-8000-000000000003', 'e5800000-0000-4000-8000-000000000001', 'Group Test Clinic F2',
   'GRP-TEST-F2', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e5810000-0000-4000-8000-00000000000' || m.n)::uuid, 'synthetic:grp-' || lower(m.x),
       'grp-' || lower(m.x) || '@example.invalid', 'Group Test ' || m.x, 'active'
  from (values (1, 'A'), (2, 'G')) m(n, x);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e5820000-0000-4000-8000-00000000000' || m.n)::uuid, ('e5810000-0000-4000-8000-00000000000' || m.n)::uuid,
       'Group Test ' || m.x, 'grp-' || lower(m.x) || '@example.invalid', 'verified', 'lab'
  from (values (1, 'A'), (2, 'G')) m(n, x);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, active)
select ('e5830000-0000-4000-8000-00000000000' || n)::uuid, ('e5820000-0000-4000-8000-00000000000' || n)::uuid,
       ('e5810000-0000-4000-8000-00000000000' || n)::uuid, 'e5800000-0000-4000-8000-000000000001',
       ('e5800000-0000-4000-8000-00000000000' || (n + 1))::uuid, 'lab', 'lab', true
  from generate_series(1, 2) n;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e5840000-0000-4000-8000-000000000001', 'HID-GRPTESTPA', 'Group', 'Patient', 'Group Test Patient', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, break_glass, purpose_of_use) values
  ('e5850000-0000-4000-8000-000000000001', 'e5840000-0000-4000-8000-000000000001',
   'e5820000-0000-4000-8000-000000000001', 'e5810000-0000-4000-8000-000000000001',
   'e5830000-0000-4000-8000-000000000001', 'e5800000-0000-4000-8000-000000000002', 'write_records', 'active',
   'Synthetic group test consent', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day',
   false, 'direct-care');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at) values
  ('e5860000-0000-4000-8000-000000000001', 'e5840000-0000-4000-8000-000000000001',
   'e5800000-0000-4000-8000-000000000002', 'e5810000-0000-4000-8000-000000000001',
   'e5830000-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, clinical_information, created_at, request_group_id)
select ('e5870000-0000-4000-8000-00000000000' || r.n)::uuid, 'e5860000-0000-4000-8000-000000000001',
       'e5840000-0000-4000-8000-000000000001', 'e5800000-0000-4000-8000-000000000002',
       'e5810000-0000-4000-8000-000000000001', 'e5830000-0000-4000-8000-000000000001',
       case when r.n = 6 then null else 'http://loinc.org' end, case when r.n = 6 then null else '718-7' end,
       case when r.n = 6 then 'Group test by name only' else 'Haemoglobin' end, 'routine',
       case when r.n = 9 then 'draft' else 'active' end, 'Synthetic group test order', '2026-11-27 09:00:00+00',
       r.grp::uuid
  from (values (1, 'e58f0000-0000-4000-8000-000000000001'), (2, 'e58f0000-0000-4000-8000-000000000001'),
               (3, 'e58f0000-0000-4000-8000-000000000001'), (4, null), (5, null),
               (6, 'e58f0000-0000-4000-8000-000000000002'), (7, 'e58f0000-0000-4000-8000-000000000001'),
               (8, 'e58f0000-0000-4000-8000-000000000003'), (9, 'e58f0000-0000-4000-8000-000000000001')) r(n, grp);
-- Route R8: LR8 sent from F1 to F2 and accepted there by G as work item W8 (e5890000-...08).
insert into ehr.order_routes (id, kind, patient_id, ordering_organization_id, ordering_facility_id,
  source_lab_request_id, source_encounter_id, source_order_version, receiving_organization_id, receiving_facility_id,
  state, sent_by_account_id, sent_by_membership_id, created_at, respond_by, patient_agreement,
  attestation_text_version, attested_by_name, attested_receiving_facility_name, orderer_account_id,
  orderer_membership_id, orderer_name, test_code_system, test_code, test_display, priority, clinical_information,
  requested_at, accepted_at, accepted_by_account_id, accepted_by_membership_id, accept_idempotency_key,
  accept_request_sha256, lab_work_item_id, writes_end_at, access_ends_at, idempotency_key, request_sha256,
  correlation_id)
select 'e5880000-0000-4000-8000-000000000008', 'lab_request', 'e5840000-0000-4000-8000-000000000001',
       'e5800000-0000-4000-8000-000000000001', 'e5800000-0000-4000-8000-000000000002',
       'e5870000-0000-4000-8000-000000000008', 'e5860000-0000-4000-8000-000000000001', 1,
       'e5800000-0000-4000-8000-000000000001', 'e5800000-0000-4000-8000-000000000003', 'accepted',
       'e5810000-0000-4000-8000-000000000001', 'e5830000-0000-4000-8000-000000000001', t, t + interval '168 hours',
       'clinician_attested', 'v1', 'Dr Group Test', 'Group Test Clinic F2', 'e5810000-0000-4000-8000-000000000001',
       'e5830000-0000-4000-8000-000000000001', 'Dr Group Test', 'http://loinc.org', '718-7', 'Haemoglobin',
       'routine', 'Synthetic group test order', '2026-11-27 09:00:00+00', t, 'e5810000-0000-4000-8000-000000000002',
       'e5830000-0000-4000-8000-000000000002', 'grp-suite-route-accept-0008', repeat('c', 64),
       'e5890000-0000-4000-8000-000000000008', t + interval '10 days', t + interval '20 days',
       'grp-suite-route-send-0008', repeat('b', 64), 'grp-suite-route'
  from (select date_trunc('second', clock_timestamp()) as t) times;
set local session_replication_role = origin;

-- The named sessions: an empty one, A at F1 and G at F2 (as both services set them).
create temporary table grp_sessions (name text primary key, subject text not null, facility text not null,
  membership text not null) on commit drop;
insert into grp_sessions values
  ('none', '', '', ''),
  ('A', 'synthetic:grp-a', 'e5800000-0000-4000-8000-000000000002', 'e5830000-0000-4000-8000-000000000001'),
  ('G', 'synthetic:grp-g', 'e5800000-0000-4000-8000-000000000003', 'e5830000-0000-4000-8000-000000000002');
grant select on grp_sessions to public;
-- services/ehr-api/src/database/database.service.ts and services/lab-api/src/database/database.service.ts set these
-- (and a change reason for an EHR update, app.change_reason).
create function pg_temp.grp_session(session_name text) returns void language plpgsql as $f$
declare
  context record;
begin
  select * into strict context from grp_sessions where name = session_name;
  perform set_config('app.actor_subject', context.subject, true),
          set_config('app.facility_id', context.facility, true),
          set_config('app.correlation_id', case when context.subject = '' then '' else 'grp-suite-correlation' end, true),
          set_config('app.membership_id', context.membership, true),
          set_config('app.purpose_of_use', case when context.subject = '' then '' else 'direct-care' end, true),
          set_config('app.change_reason', case when context.subject = '' then '' else 'Synthetic group test change' end,
                     true);
end
$f$;
-- Each case of part B: its session, the role it ran as and the outcome. Statements are queries that answer one text
-- (a data-modifying CTE where they write); each runs in a subtransaction that is then undone, so no case changes
-- what the next one sees.
create temporary table grp_cases (seq serial, name text primary key, session text not null, run_as name not null,
  expected text not null, actual text) on commit drop;
grant select, insert on grp_cases to public;
grant usage on sequence grp_cases_seq_seq to public;
create function pg_temp.grp_try(statement text) returns text language plpgsql as $f$
declare
  answer text;
  outcome text;
begin
  begin
    execute statement into answer;
    outcome := 'ok ' || coalesce(answer, 'null');
    raise exception using errcode = 'P0001', message = 'grp-suite: undo';
  exception when others then
    if sqlerrm <> 'grp-suite: undo' then outcome := sqlstate || ' ' || sqlerrm; end if;
  end;
  return outcome;
end
$f$;
create function pg_temp.grp_case(case_name text, session_name text, expected text, statement text) returns void
language plpgsql as $f$
begin
  perform pg_temp.grp_session(session_name);
  insert into grp_cases (name, session, run_as, expected, actual)
  values (case_name, session_name, current_user, expected, pg_temp.grp_try(statement));
end
$f$;
-- lab-api's acceptance insert as Release E (0cfddcc9, lab-work-items.service.ts) and 0156's image send it: no group
-- named. For order n, accepted by member A at F1 (its version, codes, name, time and requester as the EHR row has
-- them); with a group when one is given (a direct insert, which no image sends).
create function pg_temp.accept_insert(n integer, named_group text default null, order_version integer default 1)
returns text language sql as $f$
  select format($i$with item as (insert into lab.work_items(id,patient_id,facility_id,ordering_facility_id,
          source_ehr_order_id,source_ehr_order_version,source_encounter_id,status,priority,test_code_system,test_code,
          test_name,clinical_indication,requested_by,requested_at,accepted_by,
          accepted_by_membership_id,idempotency_key,request_sha256,correlation_id%s)
         values (gen_random_uuid(),'e5840000-0000-4000-8000-000000000001','e5800000-0000-4000-8000-000000000002',
          'e5800000-0000-4000-8000-000000000002',%L,%s,'e5860000-0000-4000-8000-000000000001','accepted','routine',
          %L,%L,%L,'Synthetic group test order','e5810000-0000-4000-8000-000000000001','2026-11-27 09:00:00+00',
          'e5810000-0000-4000-8000-000000000001','e5830000-0000-4000-8000-000000000001',%L,repeat('b',64),
          'grp-suite'%s)
         returning *)
         select 'group=' || coalesce(item.request_group_id::text, 'null') from item$i$,
    case when named_group is not null then ',request_group_id' else '' end,
    'e5870000-0000-4000-8000-00000000000' || n, order_version,
    case when n = 6 then null else 'http://loinc.org' end, case when n = 6 then null else '718-7' end,
    case when n = 6 then 'Group test by name only' else 'Haemoglobin' end,
    'ehr-lab-order:e5870000-0000-4000-8000-00000000000' || n || ':v' || order_version,
    case when named_group is not null then format(',%L', named_group) else '' end)
$f$;
-- The route-backed work item W8 for R8, accepted by G at F2 (the validator's route branch).
create function pg_temp.route_insert(named_group text) returns text language sql as $f$
  select format($i$with item as (insert into lab.work_items(id,patient_id,facility_id,ordering_facility_id,
          source_ehr_order_id,source_ehr_order_version,source_encounter_id,status,priority,test_code_system,test_code,
          test_name,clinical_indication,requested_by,requested_at,accepted_by,accepted_by_membership_id,
          idempotency_key,request_sha256,correlation_id,order_route_id,request_group_id)
         values ('e5890000-0000-4000-8000-000000000008','e5840000-0000-4000-8000-000000000001',
          'e5800000-0000-4000-8000-000000000003','e5800000-0000-4000-8000-000000000002',
          'e5870000-0000-4000-8000-000000000008',1,'e5860000-0000-4000-8000-000000000001','accepted','routine',
          'http://loinc.org','718-7','Haemoglobin','Synthetic group test order','e5810000-0000-4000-8000-000000000001',
          '2026-11-27 09:00:00+00','e5810000-0000-4000-8000-000000000002','e5830000-0000-4000-8000-000000000002',
          'grp-suite-route-work-item-0008',repeat('b',64),'grp-suite','e5880000-0000-4000-8000-000000000008',%L)
         returning *)
         select 'group=' || coalesce(item.request_group_id::text, 'null') from item$i$, named_group)
$f$;
-- An EHR update of order n, answering the rows changed and their group.
create function pg_temp.order_update(n integer, assignments text) returns text language sql as $f$
  select format($u$with changed as (update ehr.lab_requests set %s where id = %L returning request_group_id, row_version)
    select 'rows=' || count(*) || ' group=' || coalesce(string_agg(coalesce(changed.request_group_id::text, 'null'), ','),
           'none') || ' version=' || coalesce(string_agg(changed.row_version::text, ','), 'none') from changed$u$,
    assignments, 'e5870000-0000-4000-8000-00000000000' || n)
$f$;
grant execute on function pg_temp.grp_session(text), pg_temp.grp_try(text), pg_temp.grp_case(text, text, text, text),
  pg_temp.accept_insert(integer, text, integer), pg_temp.route_insert(text), pg_temp.order_update(integer, text)
  to public;

-- B1. The guard. With an actor: the EHR runtime, A's session and a change reason (as ehr-api's PATCH).
set local role hid_ehr_runtime;
select pg_temp.grp_case('B1a with an actor, a group changed to another is refused', 'A',
  '55000 LAB_REQUEST_GROUP_FIXED', pg_temp.order_update(7, $$request_group_id = 'e58f0000-0000-4000-8000-000000000009'$$));
select pg_temp.grp_case('B1b with an actor, a group changed to null is refused', 'A',
  '55000 LAB_REQUEST_GROUP_FIXED', pg_temp.order_update(7, 'request_group_id = null'));
select pg_temp.grp_case('B1c with an actor, a group set on an order without one is refused', 'A',
  '55000 LAB_REQUEST_GROUP_FIXED', pg_temp.order_update(4, $$request_group_id = 'e58f0000-0000-4000-8000-000000000001'$$));
select pg_temp.grp_case('B1d with an actor, a SET to the same group passes (a new version)', 'A',
  'ok rows=1 group=e58f0000-0000-4000-8000-000000000001 version=2',
  pg_temp.order_update(7, 'request_group_id = request_group_id'));
select pg_temp.grp_case('B1e with an actor, null set to null passes', 'A',
  'ok rows=1 group=null version=2', pg_temp.order_update(4, 'request_group_id = null'));
select pg_temp.grp_case('B1f with an actor, a change of another column keeps the group', 'A',
  'ok rows=1 group=e58f0000-0000-4000-8000-000000000001 version=2',
  pg_temp.order_update(7, $$clinical_information = 'Synthetic group test order, changed'$$));
reset role;
-- Without an actor: the suite runner (no row security), no session. The guard fires first (its name sorts before
-- lab_requests_versioned), so a group change gets 55000; another column gets capture_record_version's 42501.
select pg_temp.grp_case('B1g without an actor, a group change is refused by the guard first', 'none',
  '55000 LAB_REQUEST_GROUP_FIXED', pg_temp.order_update(7, $$request_group_id = 'e58f0000-0000-4000-8000-000000000009'$$));
select pg_temp.grp_case('B1h without an actor, another column is refused by capture_record_version', 'none',
  '42501 Verified actor, membership, and correlation context are required',
  pg_temp.order_update(7, $$clinical_information = 'Synthetic group test order, changed'$$));

-- B2. The validator, through lab-api's statements as the Lab API runtime (every trigger, foreign key and policy).
set local role hid_lab_api_runtime;
select pg_temp.grp_case('B2a Release E''s insert (no group named) copies the EHR row''s group', 'A',
  'ok group=e58f0000-0000-4000-8000-000000000001', pg_temp.accept_insert(1));
select pg_temp.grp_case('B2b Release E''s insert for an order without a group leaves null', 'A',
  'ok group=null', pg_temp.accept_insert(4));
select pg_temp.grp_case('B2c a work item naming its order''s own group is accepted', 'A',
  'ok group=e58f0000-0000-4000-8000-000000000001', pg_temp.accept_insert(2, 'e58f0000-0000-4000-8000-000000000001'));
select pg_temp.grp_case('B2d a work item naming another group is refused', 'A',
  '23514 LAB_REQUEST_GROUP_MISMATCH', pg_temp.accept_insert(3, 'e58f0000-0000-4000-8000-000000000009'));
select pg_temp.grp_case('B2e a work item naming a group for an order without one is refused', 'A',
  '23514 LAB_REQUEST_GROUP_MISMATCH', pg_temp.accept_insert(5, 'e58f0000-0000-4000-8000-000000000001'));
reset role;
-- A draft in a group activated later on its own (ehr-api's PATCH), then sent at its new version: Lab copies the group.
create function pg_temp.activate_then_accept() returns text language plpgsql as $f$
declare
  answer text;
begin
  perform pg_temp.grp_session('A');
  execute 'set local role hid_ehr_runtime';
  update ehr.lab_requests set status = 'active' where id = 'e5870000-0000-4000-8000-000000000009';
  execute 'set local role hid_lab_api_runtime';
  execute pg_temp.accept_insert(9, null, 2) into answer;
  execute 'reset role';
  return answer;
end
$f$;
select pg_temp.grp_case('B2f a draft in a group activated later keeps its group in Lab', 'A',
  'ok group=e58f0000-0000-4000-8000-000000000001', 'select pg_temp.activate_then_accept()');
-- The route branch, as the isolated guard cases of lab-session-guards run it: the suite runner in replica mode with
-- only the validator enabled always, under G's session at F2 (route R8 accepted by G).
set local session_replication_role = replica;
alter table lab.work_items enable always trigger lab_work_item_validate;
select pg_temp.grp_case('B2g a routed work item without a group is accepted', 'G', 'ok group=null',
  pg_temp.route_insert(null));
select pg_temp.grp_case('B2h a routed work item with a group (even its order''s) is refused', 'G',
  '23514 Lab work item does not match its accepted order route and actor context',
  pg_temp.route_insert('e58f0000-0000-4000-8000-000000000003'));
alter table lab.work_items enable trigger lab_work_item_validate;
set local session_replication_role = origin;

-- B3. ehr-api's inserts as the EHR runtime: Release E's (0cfddcc9 lab-requests.service.ts) names no group; ORD-6's
-- names the group ehr-api made.
set local role hid_ehr_runtime;
select pg_temp.grp_case('B3a Release E''s ehr-api insert saves no group', 'A', 'ok group=null',
  $$with saved as (insert into ehr.lab_requests (encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
      test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information,
      external_order_reference)
    values ('e5860000-0000-4000-8000-000000000001', 'e5840000-0000-4000-8000-000000000001',
      'e5800000-0000-4000-8000-000000000002', 'e5810000-0000-4000-8000-000000000001',
      'e5830000-0000-4000-8000-000000000001', 'http://loinc.org', '718-7', 'Haemoglobin', 'routine', 'active', null,
      null, null) returning request_group_id)
    select 'group=' || coalesce(saved.request_group_id::text, 'null') from saved$$);
select pg_temp.grp_case('B3b ORD-6''s ehr-api insert saves the group it names', 'A',
  'ok group=e58f0000-0000-4000-8000-000000000004',
  $$with saved as (insert into ehr.lab_requests (encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
      test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information,
      external_order_reference, request_group_id)
    values ('e5860000-0000-4000-8000-000000000001', 'e5840000-0000-4000-8000-000000000001',
      'e5800000-0000-4000-8000-000000000002', 'e5810000-0000-4000-8000-000000000001',
      'e5830000-0000-4000-8000-000000000001', 'http://loinc.org', '718-7', 'Haemoglobin', 'routine', 'active', null,
      null, null, 'e58f0000-0000-4000-8000-000000000004') returning request_group_id)
    select 'group=' || coalesce(saved.request_group_id::text, 'null') from saved$$);
reset role;

-- B4. A name-only test (0156) in a group: lab-api's work item and requested test (lab-work-items.service.ts), both
-- with the null pair; the work item takes the group, and the child validator (one test, equal to its parent) passes.
create function pg_temp.accept_name_only() returns text language plpgsql as $f$
declare
  item record;
  test_pair text;
begin
  perform pg_temp.grp_session('A');
  execute 'set local role hid_lab_api_runtime';
  execute replace(pg_temp.accept_insert(6), $r$select 'group=' || coalesce(item.request_group_id::text, 'null') from item$r$,
    'select item.id, item.facility_id, item.patient_id, item.request_group_id, item.test_code_system, item.test_code from item')
    into item;
  insert into lab.work_item_requested_tests(work_item_id,facility_id,patient_id,"ordinal",code_system,code,name)
  values (item.id,item.facility_id,item.patient_id,1,null,null,'Group test by name only');
  select coalesce(test.code_system, 'null') || ',' || coalesce(test.code, 'null') into test_pair
    from lab.work_item_requested_tests test where test.work_item_id = item.id;
  execute 'reset role';
  return format('group=%s pair=%s,%s test=%s', coalesce(item.request_group_id::text, 'null'),
    coalesce(item.test_code_system, 'null'), coalesce(item.test_code, 'null'), test_pair);
end
$f$;
select pg_temp.grp_case('B4 a name-only test in a group: the group copied, the null pair on both rows', 'A',
  'ok group=e58f0000-0000-4000-8000-000000000002 pair=null,null test=null,null', 'select pg_temp.accept_name_only()');

-- B5. The guard's temporary-table probe (from the earlier draft of the file): the guard on a temporary table with
-- the column, as the suite runner, so no real row is written.
create temporary table grp_probe (id integer primary key, request_group_id uuid, note text) on commit drop;
create trigger grp_probe_group_fixed before update of request_group_id on grp_probe
  for each row execute function ehr.lab_request_group_fixed();
insert into grp_probe values (1, 'e58f0000-0000-4000-8000-000000000001', 'grouped'), (2, null, 'alone');
select pg_temp.grp_case('B5a probe: the same group passes', 'none', 'ok rows=1',
  $$with changed as (update grp_probe set request_group_id = 'e58f0000-0000-4000-8000-000000000001' where id = 1
    returning 1) select 'rows=' || count(*) from changed$$);
select pg_temp.grp_case('B5b probe: another group is refused', 'none', '55000 LAB_REQUEST_GROUP_FIXED',
  $$with changed as (update grp_probe set request_group_id = 'e58f0000-0000-4000-8000-000000000002' where id = 1
    returning 1) select 'rows=' || count(*) from changed$$);
select pg_temp.grp_case('B5c probe: a group set to null is refused', 'none', '55000 LAB_REQUEST_GROUP_FIXED',
  $$with changed as (update grp_probe set request_group_id = null where id = 1 returning 1)
    select 'rows=' || count(*) from changed$$);
select pg_temp.grp_case('B5d probe: a group set where there was none is refused', 'none', '55000 LAB_REQUEST_GROUP_FIXED',
  $$with changed as (update grp_probe set request_group_id = 'e58f0000-0000-4000-8000-000000000001' where id = 2
    returning 1) select 'rows=' || count(*) from changed$$);
select pg_temp.grp_case('B5e probe: a SET that does not name the column does not fire it', 'none', 'ok rows=2',
  $$with changed as (update grp_probe set note = 'changed' returning 1) select 'rows=' || count(*) from changed$$);

-- Every case ran, as the role it names, and every outcome is the expected one.
do $$
declare
  mismatches text;
begin
  if (select count(*) from grp_cases) <> 24 or exists (select 1 from grp_cases where actual is null) then
    raise exception '0158 lab request groups suite: part B did not run every case (% recorded)',
      (select count(*) from grp_cases);
  end if;
  select string_agg(format('%s (session %s, as %s): expected [%s], got [%s]', c.name, c.session, c.run_as, c.expected,
           c.actual), E'\n' order by c.seq)
    into mismatches
    from grp_cases c
   where c.actual is distinct from c.expected
      or (c.name like 'B1_ with an actor%' and c.run_as <> 'hid_ehr_runtime')
      or (c.name like 'B2_ %' and c.name not like 'B2f%' and c.name not like 'B2g%' and c.name not like 'B2h%'
          and c.run_as <> 'hid_lab_api_runtime')
      or (c.name like 'B3_ %' and c.run_as <> 'hid_ehr_runtime');
  if mismatches is not null then
    raise exception E'0158 lab request groups suite: part B cases failed:\n%', mismatches;
  end if;
  raise notice '0158 lab request groups suite: part A % cases, part B % cases passed',
    (select last_value from pg_temp.lab_request_groups_passed), (select count(*) from grp_cases);
end $$;

rollback;
