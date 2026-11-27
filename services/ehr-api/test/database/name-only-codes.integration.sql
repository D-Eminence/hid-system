\set ON_ERROR_STOP on
-- 0156 (ORD-7 F3 and ORD-9): lab tests and diagnoses by name only. The
-- clinical owner's design note on #258 (7192389223). Rollback-only.
-- Part A runs 0156 itself, as written (psql \ir), as the runner runs it
-- inside its transaction, and as the tables' owner (the migrator); it writes
-- no row to the six tables, as 0156's post-check requires. Part B is the
-- data path, through the exact runtime roles and the services' statements.
-- A. The migration:
--   1. as the runner left it: the twelve code columns nullable, the names
--      required; the five pair CHECKs and the route's kind check, validated;
--      both functions (body, owner, SECURITY DEFINER, STABLE, plpgsql,
--      search_path) and EXECUTE for the EHR and schema test runtimes only;
--   2. a second run answers "0156: already applied" (55000);
--   3. the undo of 0156's header (here in one transaction): the ten columns
--      NOT NULL again, the constraints on the code columns 0001-0153's
--      (0086's kind check by md5), 0153's read back (md5 48c0dbad) and no
--      ehr.catalog_diagnosis_listed;
--   4. on that state the preconditions refuse (55000, nothing applied):
--      another lane's CHECK on a code column, a length CHECK changed, a name
--      column made nullable, a pinned function replaced, 0153's read not at
--      its before-pin or not STABLE, another ehr.catalog_diagnosis_listed,
--      0153 missing;
--   5. the size bound for an analysed table: reltuples above 5,000,000
--      refuses, exactly 5,000,000 applies. With no ANALYZE: the runbook
--      recommends it, 0156 does not need it. (The bound for a table never
--      analysed, 2 GiB on disk, is pinned by dry-run-attempts.test.mjs; a
--      table past 2 GiB takes too long to make here, so that refusal is
--      proven outside this suite);
--   6. 0156 applies again after the undo, exactly as the runner left it,
--      writing no row;
--   7. other lanes' additions to the six tables pass (7174680244): a
--      stand-in for Billing's zz_billing_lab_work_item trigger on
--      lab.work_items (0167), a column with its own CHECK, an index on the
--      code pair, a column on ehr.diagnoses; 0156 keeps them;
--   8. tables never analysed (reltuples -1) with pages on disk, as a fresh
--      install on Amazon RDS leaves ehr.diagnoses and ehr.lab_requests
--      (0102's demo rows): rows written in the transaction before 0156, and
--      undone; under 2 GiB, 0156 applies (its post-check counts only what is
--      written while it runs); a row written while 0156 runs (by an event
--      trigger on its ALTER TABLE) makes its post-check refuse
--      (pg_stat_xact_user_tables, against section 0's counts);
--   9. back to the state the runner left.
-- B. The data path (the P4c fixture of the order route suites):
--   1. a lab request by name only is saved (ehr-api's columns); half a pair
--      is refused, blank codes as before, the name stays required; it is
--      changed like any other and its versions keep the null pair;
--   2. the same for a diagnosis; a name-only save records no recent pick;
--   3. this facility's own lab (lab-api's statements): the name-only order's
--      work item and requested test take the null pair, which must equal the
--      order's (a coded item for it, a name-only item for a coded order and
--      a coded requested test under it are refused); lab-api's execution and
--      released reads answer the name and no codes; the result is released;
--   4. each route step: the route, L1's list and page, the acceptance (work
--      item and requested test), v1 and its correction released and
--      reported to GH, GH's page (C3) and the patient's list (C5), all with
--      the null pair and the name; a coded order alongside keeps its codes;
--   5. the wrong person reported (0088): both reports marked in error with
--      the null pair;
--   6. a late correction (0090, D17) of another completed route, its window
--      lapsed: its report marked in error with the null pair;
--   7. each pair CHECK on its own (half a pair refused in the six tables; a
--      lab route without its name refused); the coded order's codes at every
--      step;
--   8. the undo refuses once a name-only row is saved (step a's VALIDATE
--      fails on each of the five tables).
-- Synthetic values only; uuid prefix e56, n156 names, .invalid addresses.
set plpgsql.variable_conflict = error;

-- Runs 0156 as written, as the runner runs it inside its transaction, and keeps what it answered (SQLSTATE and
-- message, or 'applied'). psql stops an included file at its first error while ON_ERROR_STOP is on, and reads
-- ON_ERROR_STOP for a line before the line runs; so the line before turns it off for the line that includes 0156
-- (this suite goes on), and this line turns it on for 0156's own lines (0156 stops at its first error, as the
-- runner's one transaction does). Each run is followed by "\set ON_ERROR_STOP on" and "\set QUIET off".
\set run0156 '\\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\set ON_ERROR_STOP on \\ir ../../database/migrations/0156_name_only_lab_tests_and_diagnoses.sql'

begin;

-- A case stops the suite at once when it fails. Passes are counted in a sequence, which keeps its count across
-- ROLLBACK TO SAVEPOINT (the cases of part A run inside savepoints).
create temporary sequence name_only_passed;
grant usage on sequence name_only_passed to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $f$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception E'0156 name-only codes suite failed: %:\n  expected [%]\n  got      [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  perform nextval('pg_temp.name_only_passed');
  raise notice '0156 name-only codes: % passed', case_name;
end
$f$;
-- The SQLSTATE and message of a statement, or 'ok'.
create function pg_temp.outcome(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.check(label text, statement text, expected text) returns void language sql as $f$
  select pg_temp.expect(label, expected, pg_temp.outcome(statement));
$f$;
-- What 0156 makes or keeps, as one text: every column and constraint of the six tables, their triggers, and the two
-- functions (body, owner, attributes, grants, comment) and whether each exists. The owner is printed as "owner".
create function pg_temp.schema_print() returns text language sql as $f$
  with six(oid) as (values ('ehr.lab_requests'::regclass), ('ehr.diagnoses'::regclass), ('ehr.order_routes'::regclass),
                           ('lab.work_items'::regclass), ('lab.work_item_requested_tests'::regclass),
                           ('lab.order_route_result_reports'::regclass)),
       owner_row(oid) as (select relation.relowner from pg_class relation where relation.oid = 'ehr.catalog_versions'::regclass)
  select concat_ws(E'\n',
    (select string_agg(format('%s.%s %s %s', attribute_row.attrelid::regclass, attribute_row.attname,
              format_type(attribute_row.atttypid, attribute_row.atttypmod),
              case when attribute_row.attnotnull then 'not null' else 'null' end), E'\n'
              order by attribute_row.attrelid::regclass::text, attribute_row.attnum)
       from pg_attribute attribute_row
      where attribute_row.attrelid in (select oid from six) and attribute_row.attnum > 0 and not attribute_row.attisdropped),
    (select string_agg(format('%s %s %s %s %s', constraint_row.conrelid::regclass, constraint_row.conname,
              constraint_row.contype, pg_get_constraintdef(constraint_row.oid),
              case when constraint_row.convalidated then 'validated' else 'not valid' end), E'\n'
              order by constraint_row.conrelid::regclass::text, constraint_row.conname)
       from pg_constraint constraint_row where constraint_row.conrelid in (select oid from six)),
    (select string_agg(format('%s %s %s %s %s', trigger_row.tgrelid::regclass, trigger_row.tgname,
              trigger_row.tgfoid::regprocedure, trigger_row.tgtype, trigger_row.tgenabled), E'\n'
              order by trigger_row.tgrelid::regclass::text, trigger_row.tgname)
       from pg_trigger trigger_row where trigger_row.tgrelid in (select oid from six) and not trigger_row.tgisinternal),
    (select string_agg(format('%s %s %s %s %s %s %s [%s]', proc.oid::regprocedure, md5(proc.prosrc),
              case when proc.proowner = (select oid from owner_row) then 'owner' else proc.proowner::regrole::text end,
              proc.prosecdef, proc.provolatile, proc.proconfig,
              replace(coalesce(proc.proacl, acldefault('f', proc.proowner))::text, proc.proowner::regrole::text, 'owner'),
              obj_description(proc.oid, 'pg_proc')), E'\n' order by proc.oid::regprocedure::text)
       from pg_proc proc
      where proc.pronamespace = 'ehr'::regnamespace and proc.proname in ('catalog_diagnosis_listed', 'recent_diagnoses')));
$f$;
-- The six tables' write counts in this transaction (pg_stat_xact_user_tables), as 0156's post-check reads them.
create function pg_temp.written() returns text language sql as $f$
  select string_agg(format('%s=%s', statistics.relname, statistics.n_tup_ins + statistics.n_tup_upd + statistics.n_tup_del),
           ' ' order by statistics.relname)
    from pg_stat_xact_user_tables statistics
   where statistics.relid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass, 'ehr.order_routes'::regclass,
                              'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
                              'lab.order_route_result_reports'::regclass);
$f$;

-- The six tables' owner (the migrator): 0156 and its undo run as this role here, as the runner runs them.
select relation.relowner::regrole::text as q156_owner from pg_class relation
 where relation.oid = 'ehr.lab_requests'::regclass \gset
select md5(pg_temp.schema_print()) as q156_applied \gset

-- A1. 0156 as the runner left it.
select pg_temp.expect('A1a one owner for the six tables, the catalogue and both functions', '1',
  (select count(distinct owner_oid)::text from (
     select relation.relowner as owner_oid from pg_class relation
      where relation.oid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass, 'ehr.order_routes'::regclass,
                             'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
                             'lab.order_route_result_reports'::regclass, 'ehr.catalog_versions'::regclass,
                             'ehr.catalog_diagnoses'::regclass)
     union all
     select proc.proowner from pg_proc proc
      where proc.oid in ('ehr.catalog_diagnosis_listed(text,text)'::regprocedure,
                         'ehr.recent_diagnoses(integer)'::regprocedure)) owners));
select pg_temp.expect('A1b the twelve code columns are text and nullable; the four name columns stay NOT NULL',
  'ehr.diagnoses.code text null|ehr.diagnoses.code_system text null|ehr.diagnoses.display text not null|'
  || 'ehr.lab_requests.test_code text null|ehr.lab_requests.test_code_system text null|'
  || 'ehr.lab_requests.test_display text not null|ehr.order_routes.test_code text null|'
  || 'ehr.order_routes.test_code_system text null|ehr.order_routes.test_display text null|'
  || 'lab.order_route_result_reports.test_code text null|lab.order_route_result_reports.test_code_system text null|'
  || 'lab.order_route_result_reports.test_name text not null|lab.work_item_requested_tests.code text null|'
  || 'lab.work_item_requested_tests.code_system text null|lab.work_item_requested_tests.name text not null|'
  || 'lab.work_items.test_code text null|lab.work_items.test_code_system text null|lab.work_items.test_name text not null',
  (select string_agg(format('%s.%s %s %s', attribute_row.attrelid::regclass, attribute_row.attname,
            format_type(attribute_row.atttypid, attribute_row.atttypmod),
            case when attribute_row.attnotnull then 'not null' else 'null' end), '|'
            order by attribute_row.attrelid::regclass::text, attribute_row.attname)
     from pg_attribute attribute_row
    where attribute_row.attrelid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass,
            'ehr.order_routes'::regclass, 'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
            'lab.order_route_result_reports'::regclass)
      and attribute_row.attname in ('test_code_system', 'test_code', 'code_system', 'code', 'test_display', 'display',
            'test_name', 'name') and not attribute_row.attisdropped));
select pg_temp.expect('A1c the five pair CHECKs, each validated; the route''s kind check (both or neither, name '
  || 'required), validated',
  'diagnoses_code_pair_ck CHECK (((code_system IS NULL) = (code IS NULL))) true|'
  || 'lab_requests_test_code_pair_ck CHECK (((test_code_system IS NULL) = (test_code IS NULL))) true|'
  || 'order_route_result_reports_test_code_pair_ck CHECK (((test_code_system IS NULL) = (test_code IS NULL))) true|'
  || 'order_routes_kind_ck da75b1703689457cdb6b35053a48af52 true|'
  || 'work_item_requested_tests_code_pair_ck CHECK (((code_system IS NULL) = (code IS NULL))) true|'
  || 'work_items_test_code_pair_ck CHECK (((test_code_system IS NULL) = (test_code IS NULL))) true',
  (select string_agg(format('%s %s %s', constraint_row.conname,
            case when constraint_row.conname = 'order_routes_kind_ck' then md5(pg_get_constraintdef(constraint_row.oid))
                 else pg_get_constraintdef(constraint_row.oid) end, constraint_row.convalidated::text), '|'
            order by constraint_row.conname)
     from pg_constraint constraint_row
    where constraint_row.conrelid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass,
            'ehr.order_routes'::regclass, 'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
            'lab.order_route_result_reports'::regclass)
      and (constraint_row.conname like '%code_pair_ck' or constraint_row.conname = 'order_routes_kind_ck')));
select pg_temp.expect('A1d both functions: body, owner, SECURITY DEFINER, STABLE (provolatile s), plpgsql, '
  || 'search_path; EXECUTE for the EHR and schema test runtimes only',
  'ehr.catalog_diagnosis_listed(text,text) 28048d5d87de33e9f03e71a93024d214 owner true s plpgsql '
  || '{"search_path=pg_catalog, pg_temp"} hid_ehr_runtime,hid_schema_test_runtime|'
  || 'ehr.recent_diagnoses(integer) 034774a650aacf33a366e186d15cd5d7 owner true s plpgsql '
  || '{"search_path=pg_catalog, pg_temp"} hid_ehr_runtime,hid_schema_test_runtime',
  (select string_agg(format('%s %s %s %s %s %s %s %s', proc.oid::regprocedure, md5(proc.prosrc),
            case when proc.proowner = (select relation.relowner from pg_class relation
                                        where relation.oid = 'ehr.catalog_versions'::regclass)
                 then 'owner' else 'not the owner' end,
            proc.prosecdef::text, proc.provolatile, language_row.lanname, proc.proconfig,
            (select string_agg(case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end, ','
                      order by pg_get_userbyid(acl.grantee))
               from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where acl.grantee <> proc.proowner)), '|' order by proc.oid::regprocedure::text)
     from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
    where proc.oid in ('ehr.catalog_diagnosis_listed(text,text)'::regprocedure,
                       'ehr.recent_diagnoses(integer)'::regprocedure)));

-- A2. A second run answers "already applied" and changes nothing (the runner's transaction rolls back).
savepoint again;
set local role :"q156_owner";
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint again;
select pg_temp.expect('A2 a second run answers "0156: already applied" (55000); nothing changed',
  '55000 0156: already applied | same',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | '
  || case when md5(pg_temp.schema_print()) = :'q156_applied' then 'same' else 'changed' end);

-- A3. The undo of 0156's header, as the tables' owner. The header runs step a outside the main transaction (each
-- NOT VALID CHECK added and committed, then validated in its own transaction, so that no scan runs under ACCESS
-- EXCLUSIVE); here it is one transaction, with the same statements in the same order. SET NOT NULL comes in its own
-- statement, before the CHECK it relies on is dropped.
savepoint undone;
set local role :"q156_owner";
-- a. A NOT VALID CHECK (col IS NOT NULL) on each of the ten columns, and 0086's route kind check under a temporary
-- name, then VALIDATE.
alter table ehr.lab_requests add constraint lab_requests_test_code_system_undo_nn check (test_code_system is not null) not valid,
  add constraint lab_requests_test_code_undo_nn check (test_code is not null) not valid;
alter table ehr.diagnoses add constraint diagnoses_code_system_undo_nn check (code_system is not null) not valid,
  add constraint diagnoses_code_undo_nn check (code is not null) not valid;
alter table lab.work_items add constraint work_items_test_code_system_undo_nn check (test_code_system is not null) not valid,
  add constraint work_items_test_code_undo_nn check (test_code is not null) not valid;
alter table lab.work_item_requested_tests add constraint work_item_requested_tests_code_system_undo_nn
    check (code_system is not null) not valid,
  add constraint work_item_requested_tests_code_undo_nn check (code is not null) not valid;
alter table lab.order_route_result_reports add constraint order_route_result_reports_test_code_system_undo_nn
    check (test_code_system is not null) not valid,
  add constraint order_route_result_reports_test_code_undo_nn check (test_code is not null) not valid;
-- 0086's kind check as 0086 made it (0086:6377-6390), under a temporary name.
alter table ehr.order_routes add constraint order_routes_kind_0086_ck check (
    (kind = 'lab_request' and source_lab_request_id is not null and source_prescription_id is null
      and test_code_system is not null and test_code is not null and test_display is not null
      and priority is not null and requested_at is not null
      and medication_code_system is null and medication_code is null and medication_display is null
      and dose_quantity is null and dose_unit is null and route_code is null and frequency is null
      and instructions is null and starts_on is null and ends_on is null and prescribed_at is null
      and pharmacy_work_item_id is null)
    or (kind = 'prescription' and source_prescription_id is not null and source_lab_request_id is null
      and medication_display is not null and frequency is not null and instructions is not null
      and prescribed_at is not null
      and test_code_system is null and test_code is null and test_display is null and priority is null
      and specimen_type_code is null and clinical_information is null and requested_at is null
      and lab_work_item_id is null)) not valid;
alter table ehr.lab_requests validate constraint lab_requests_test_code_system_undo_nn;
alter table ehr.lab_requests validate constraint lab_requests_test_code_undo_nn;
alter table ehr.diagnoses validate constraint diagnoses_code_system_undo_nn;
alter table ehr.diagnoses validate constraint diagnoses_code_undo_nn;
alter table lab.work_items validate constraint work_items_test_code_system_undo_nn;
alter table lab.work_items validate constraint work_items_test_code_undo_nn;
alter table lab.work_item_requested_tests validate constraint work_item_requested_tests_code_system_undo_nn;
alter table lab.work_item_requested_tests validate constraint work_item_requested_tests_code_undo_nn;
alter table lab.order_route_result_reports validate constraint order_route_result_reports_test_code_system_undo_nn;
alter table lab.order_route_result_reports validate constraint order_route_result_reports_test_code_undo_nn;
alter table ehr.order_routes validate constraint order_routes_kind_0086_ck;
-- b. The main transaction: the six tables at once, NOWAIT; SET NOT NULL (each proven by its CHECK, so no scan); the
-- ten CHECKs and the five pair CHECKs dropped; 0156's kind check dropped and 0086's renamed back (no scan); 0153's read
-- (and its comment) back; the new function dropped.
lock table ehr.lab_requests, ehr.diagnoses, ehr.order_routes, lab.work_items, lab.work_item_requested_tests,
  lab.order_route_result_reports in access exclusive mode nowait;
alter table ehr.lab_requests alter column test_code_system set not null, alter column test_code set not null;
alter table ehr.diagnoses alter column code_system set not null, alter column code set not null;
alter table lab.work_items alter column test_code_system set not null, alter column test_code set not null;
alter table lab.work_item_requested_tests alter column code_system set not null, alter column code set not null;
alter table lab.order_route_result_reports alter column test_code_system set not null, alter column test_code set not null;
alter table ehr.lab_requests drop constraint lab_requests_test_code_system_undo_nn,
  drop constraint lab_requests_test_code_undo_nn, drop constraint lab_requests_test_code_pair_ck;
alter table ehr.diagnoses drop constraint diagnoses_code_system_undo_nn, drop constraint diagnoses_code_undo_nn,
  drop constraint diagnoses_code_pair_ck;
alter table lab.work_items drop constraint work_items_test_code_system_undo_nn, drop constraint work_items_test_code_undo_nn,
  drop constraint work_items_test_code_pair_ck;
alter table lab.work_item_requested_tests drop constraint work_item_requested_tests_code_system_undo_nn,
  drop constraint work_item_requested_tests_code_undo_nn, drop constraint work_item_requested_tests_code_pair_ck;
alter table lab.order_route_result_reports drop constraint order_route_result_reports_test_code_system_undo_nn,
  drop constraint order_route_result_reports_test_code_undo_nn,
  drop constraint order_route_result_reports_test_code_pair_ck;
alter table ehr.order_routes drop constraint order_routes_kind_ck;
alter table ehr.order_routes rename constraint order_routes_kind_0086_ck to order_routes_kind_ck;
-- 0153's read, as 0153 made it (md5 48c0dbad), with its comment.
create or replace function ehr.recent_diagnoses(requested_limit integer)
returns table (code_system text, code text, display text, last_used_at timestamptz, use_count integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  membership_value uuid;
  facility_value uuid;
begin
  if requested_limit is null or requested_limit < 1 or requested_limit > 50 then
    raise exception using errcode = '22023', message = 'RECENT_DIAGNOSES_INVALID';
  end if;
  begin
    membership_value := nullif(current_setting('app.membership_id', true), '')::uuid;
    facility_value := nullif(current_setting('app.facility_id', true), '')::uuid;
  exception when invalid_text_representation then
    return;
  end;
  if membership_value is null or facility_value is null
     or not auth.membership_has_permission(current_setting('app.actor_subject', true), membership_value,
                                           facility_value, 'ehr.diagnosis.write') then
    return;
  end if;
  return query
    select recent.code_system, recent.code, recent.display, recent.last_used_at, recent.use_count
      from ehr.clinician_recent_diagnoses recent
     where recent.membership_id = membership_value and recent.facility_id = facility_value
     order by recent.last_used_at desc, recent.code_system, recent.code
     limit requested_limit;
end;
$$;
comment on function ehr.recent_diagnoses(integer) is
  '0153 (ORD-9): the session''s membership''s diagnosis picks at its facility, newest first, at most limit (1-50); none without ehr.diagnosis.write. 22023 RECENT_DIAGNOSES_INVALID for a limit outside 1-50.';
drop function ehr.catalog_diagnosis_listed(text, text);
reset role;
select pg_temp.expect('A3a after the undo: the ten columns NOT NULL again, the route''s two nullable as before',
  'ehr.diagnoses.code not null|ehr.diagnoses.code_system not null|ehr.lab_requests.test_code not null|'
  || 'ehr.lab_requests.test_code_system not null|ehr.order_routes.test_code null|ehr.order_routes.test_code_system null|'
  || 'lab.order_route_result_reports.test_code not null|lab.order_route_result_reports.test_code_system not null|'
  || 'lab.work_item_requested_tests.code not null|lab.work_item_requested_tests.code_system not null|'
  || 'lab.work_items.test_code not null|lab.work_items.test_code_system not null',
  (select string_agg(format('%s.%s %s', attribute_row.attrelid::regclass, attribute_row.attname,
            case when attribute_row.attnotnull then 'not null' else 'null' end), '|'
            order by attribute_row.attrelid::regclass::text, attribute_row.attname)
     from pg_attribute attribute_row
    where attribute_row.attrelid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass,
            'ehr.order_routes'::regclass, 'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
            'lab.order_route_result_reports'::regclass)
      and attribute_row.attname in ('test_code_system', 'test_code', 'code_system', 'code')
      and not attribute_row.attisdropped));
select pg_temp.expect('A3b ... the constraints on the code columns are 0001-0153''s: the ten length CHECKs and 0086''s '
  || 'kind check (md5 e26083a6), each validated; no pair CHECK and no undo CHECK left',
  'diagnoses_code_check|diagnoses_code_system_check|lab_requests_test_code_check|lab_requests_test_code_system_check|'
  || 'order_routes_kind_ck e26083a62f5b32553520f82676fca2aa|order_routes_test_code_check|'
  || 'order_routes_test_code_system_check|work_item_requested_tests_code_check|'
  || 'work_item_requested_tests_code_system_check|work_items_test_code_check|work_items_test_code_system_check',
  (select string_agg(constraint_row.conname
            || case when constraint_row.conname = 'order_routes_kind_ck'
                    then ' ' || md5(pg_get_constraintdef(constraint_row.oid)) else '' end
            || case when constraint_row.convalidated then '' else ' NOT VALID' end, '|' order by constraint_row.conname)
     from pg_constraint constraint_row
    where constraint_row.conrelid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass,
            'ehr.order_routes'::regclass, 'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
            'lab.order_route_result_reports'::regclass)
      and exists (select 1 from pg_attribute attribute_row
                   where attribute_row.attrelid = constraint_row.conrelid
                     and attribute_row.attnum = any(constraint_row.conkey)
                     and attribute_row.attname in ('test_code_system', 'test_code', 'code_system', 'code'))));
select pg_temp.expect('A3c ... 0153''s read (md5 48c0dbad, owner, SECURITY DEFINER, STABLE, search_path, its grants), '
  || 'and no ehr.catalog_diagnosis_listed',
  '48c0dbad4f4d53fa6fbc6a1e5e0a35ac owner true s {"search_path=pg_catalog, pg_temp"} '
  || 'hid_ehr_runtime,hid_schema_test_runtime | none',
  (select format('%s %s %s %s %s %s', md5(proc.prosrc),
            case when proc.proowner = (select relation.relowner from pg_class relation
                                        where relation.oid = 'ehr.catalog_versions'::regclass)
                 then 'owner' else 'not the owner' end, proc.prosecdef::text, proc.provolatile, proc.proconfig,
            (select string_agg(pg_get_userbyid(acl.grantee), ',' order by pg_get_userbyid(acl.grantee))
               from aclexplode(proc.proacl) acl where acl.grantee <> proc.proowner))
     from pg_proc proc where proc.oid = 'ehr.recent_diagnoses(integer)'::regprocedure)
  || ' | ' || coalesce((select string_agg(proc.oid::regprocedure::text, ',') from pg_proc proc
                          where proc.pronamespace = 'ehr'::regnamespace and proc.proname = 'catalog_diagnosis_listed'),
                       'none'));
select md5(pg_temp.schema_print()) as q156_undone \gset

-- A4. On the state before 0156 (the undo), 0156's preconditions refuse what is not as 0001-0153 left it (55000,
-- nothing applied), each change made first as the owner (or another lane's migrator) would make it.
savepoint refused;
set local role :"q156_owner";
alter table lab.work_items add constraint work_items_zz_other_lane_code_ck check (test_code <> 'withdrawn-code') not valid;
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint refused;
select pg_temp.expect('A4a another lane''s CHECK on a code column',
  '55000 0156: the constraints on the code columns are not as 0001-0153 left them: work_items_zz_other_lane_code_ck | same',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | '
  || case when md5(pg_temp.schema_print()) = :'q156_undone' then 'same' else 'changed' end);
set local role :"q156_owner";
alter table lab.work_item_requested_tests drop constraint work_item_requested_tests_code_check,
  add constraint work_item_requested_tests_code_check check (length(btrim(code)) between 1 and 200);
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint refused;
select pg_temp.expect('A4b a length CHECK on a code column changed (100 to 200)',
  '55000 0156: the constraints on the code columns are not as 0001-0153 left them: work_item_requested_tests_code_check, work_item_requested_tests_code_check',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q156_owner";
alter table ehr.diagnoses alter column display drop not null;
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint refused;
select pg_temp.expect('A4c a name column made nullable',
  '55000 0156: these columns are not as 0001-0153 left them: ehr.diagnoses.display',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q156_owner";
do $$
begin
  execute replace(pg_get_functiondef('lab.validate_work_item_child()'::regprocedure), 'AS $function$',
                  'AS $function$' || chr(10) || '-- changed by another lane');
end
$$;
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint refused;
select pg_temp.expect('A4d a pinned function another lane replaced (lab.validate_work_item_child)',
  '55000 0156: these functions are not as 0001-0153 left them: lab.validate_work_item_child()',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q156_owner";
do $$
begin
  execute replace(pg_get_functiondef('ehr.recent_diagnoses(integer)'::regprocedure), 'AS $function$',
                  'AS $function$' || chr(10) || '-- changed by another lane');
end
$$;
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint refused;
select pg_temp.expect('A4e 0153''s read not at its before-pin (48c0dbad)',
  '55000 0156: these functions are not as 0001-0153 left them: ehr.recent_diagnoses(integer)',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q156_owner";
alter function ehr.recent_diagnoses(integer) volatile;
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint refused;
select pg_temp.expect('A4f 0153''s read at its body but no longer STABLE',
  '55000 0156: 0153''s ehr.recent_diagnoses is not as 0153 made it',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q156_owner";
create function ehr.catalog_diagnosis_listed(code text) returns boolean language sql stable as $f$ select false $f$;
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint refused;
select pg_temp.expect('A4g another function named ehr.catalog_diagnosis_listed',
  '55000 0156: a function ehr.catalog_diagnosis_listed already exists',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
set local role :"q156_owner";
drop function ehr.recent_diagnoses(integer);
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint refused;
select pg_temp.expect('A4h 0153 not applied (its read missing)',
  '55000 0156: 0001-0153 (0152 and 0153) must be applied first',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');

-- A5. The size bound for an analysed table, read under the locks: reltuples above 5,000,000 refuses (55000, nothing
-- applied); exactly 5,000,000 applies. (pg_class is set by hand here, as the suite runner, for this transaction only.)
update pg_class set reltuples = 5000001 where oid = 'lab.order_route_result_reports'::regclass;
set local role :"q156_owner";
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint refused;
select pg_temp.expect('A5a analysed, reltuples above 5,000,000 refuses',
  '55000 0156: too large to validate here: lab.order_route_result_reports (reltuples 5000001, N bytes); nothing applied | same',
  :'LAST_ERROR_SQLSTATE' || ' ' || regexp_replace(:'LAST_ERROR_MESSAGE', '\d+ bytes', 'N bytes') || ' | '
  || case when md5(pg_temp.schema_print()) = :'q156_undone' then 'same' else 'changed' end);
update pg_class set reltuples = 5000000 where oid = 'lab.order_route_result_reports'::regclass;
set local role :"q156_owner";
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
select md5(pg_temp.schema_print()) as q156_reapplied \gset
rollback to savepoint refused;
select pg_temp.expect('A5b analysed, exactly 5,000,000 applies', 'applied | as built', :'LAST_ERROR_MESSAGE' || ' | '
  || case when :'q156_reapplied' = :'q156_applied' then 'as built' else 'not as built' end);

-- A6. 0156 again on the undone state: it applies, and leaves exactly what the runner's run left (columns,
-- constraints, triggers, both functions, their grants and comments); no row written.
set local role :"q156_owner";
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
reset role;
select md5(pg_temp.schema_print()) as q156_reapplied, pg_temp.written() as q156_written \gset
rollback to savepoint refused;
select pg_temp.expect('A6 after the undo 0156 applies again, exactly as built, writing no row',
  'applied | as built | no row written',
  :'LAST_ERROR_MESSAGE' || ' | ' || case when :'q156_reapplied' = :'q156_applied' then 'as built' else 'not as built' end
  || ' | ' || case when coalesce(:'q156_written', '') ~ '=[1-9]' then 'written: ' || :'q156_written'
                   else 'no row written' end);

-- A7. Other lanes' additions to the six tables pass (7174680244): Billing's trigger on lab.work_items
-- (zz_billing_lab_work_item, 0167, which skips a null pair; a stand-in here), a column with its own CHECK, an index on
-- the code pair, and a column on ehr.diagnoses. 0156 applies and leaves them as they were.
set local role :"q156_owner";
create function lab.zz_billing_lab_work_item_stand_in() returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $f$
begin
  -- Billing prices a work item by its code pair (0167:300); a name-only item has none and gets no bill line.
  if new.test_code_system is null or new.test_code is null then
    return null;
  end if;
  return null;
end
$f$;
create trigger zz_billing_lab_work_item after insert on lab.work_items
  for each row execute function lab.zz_billing_lab_work_item_stand_in();
alter table lab.work_items add column zz_billing_price_reference text,
  add constraint work_items_zz_billing_price_reference_ck check (length(zz_billing_price_reference) <= 64);
create index work_items_zz_billing_code_pair_idx on lab.work_items (test_code_system, test_code);
alter table ehr.diagnoses add column zz_other_lane_note text;
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
reset role;
select (select string_agg(format('%s %s %s', trigger_row.tgname, trigger_row.tgfoid::regprocedure, trigger_row.tgenabled), ',')
          from pg_trigger trigger_row
         where trigger_row.tgrelid = 'lab.work_items'::regclass and trigger_row.tgname = 'zz_billing_lab_work_item')
       || ' | ' || (select string_agg(format('%s %s', constraint_row.conname, constraint_row.convalidated::text), ','
                                         order by constraint_row.conname)
                      from pg_constraint constraint_row
                     where constraint_row.conrelid = 'lab.work_items'::regclass
                       and constraint_row.conname in ('work_items_zz_billing_price_reference_ck',
                                                      'work_items_test_code_pair_ck'))
       || ' | ' || (to_regclass('lab.work_items_zz_billing_code_pair_idx') is not null)::text
       || ' | ' || exists (select 1 from pg_attribute attribute_row
                            where attribute_row.attrelid = 'ehr.diagnoses'::regclass
                              and attribute_row.attname = 'zz_other_lane_note')::text as q156_others \gset
rollback to savepoint refused;
select pg_temp.expect('A7 with other lanes'' additions, 0156 applies and keeps them',
  'applied | zz_billing_lab_work_item lab.zz_billing_lab_work_item_stand_in() O | '
  || 'work_items_test_code_pair_ck true,work_items_zz_billing_price_reference_ck true | true | true',
  :'LAST_ERROR_MESSAGE' || ' | ' || :'q156_others');

-- A8. Tables never analysed, with pages on disk, as a fresh install leaves them (on Amazon RDS, 0102's demo rows in
-- ehr.diagnoses and ehr.lab_requests) and as autovacuum can leave a small table: a row written to each of three of
-- the six in this transaction before 0156 runs (an earlier file's, in a dry run of several files), then undone (its
-- page stays on disk), and their reltuples -1. Each is far under 2 GiB, so the size bound lets it through and 0156
-- applies: its post-check counts only what is written while it runs, against the counts section 0 keeps. A row
-- written while 0156 runs (an event trigger on its ALTER TABLE, as the suite runner) makes the post-check refuse,
-- nothing applied. Last of part A: the counts stay for the rest of the transaction.
savepoint write_one;
set local session_replication_role = replica;
insert into lab.work_item_requested_tests (work_item_id, facility_id, patient_id, "ordinal", code_system, code, name)
values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'http://loinc.org', '718-7', 'Haemoglobin');
insert into ehr.diagnoses (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, code_system,
  code, display, clinical_status, verification_status)
values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'ICD-10',
  'B50.9', 'Malaria (n156 fictional)', 'active', 'confirmed');
insert into ehr.lab_requests (encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, status)
values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  'http://loinc.org', '718-7', 'Haemoglobin (n156 fictional)', 'active');
rollback to savepoint write_one;
update pg_class set reltuples = -1
 where oid in ('lab.work_item_requested_tests'::regclass, 'ehr.diagnoses'::regclass, 'ehr.lab_requests'::regclass);
select string_agg(format('%s %s %s', relation.oid::regclass, relation.reltuples::bigint,
         case when pg_relation_size(relation.oid) between 8192 and 2147483648 then 'pages under 2 GiB'
              else pg_relation_size(relation.oid) || ' bytes' end), ', ' order by relation.oid::regclass::text)
         as q156_never_analysed
  from pg_class relation
 where relation.oid in ('lab.work_item_requested_tests'::regclass, 'ehr.diagnoses'::regclass,
                        'ehr.lab_requests'::regclass) \gset
set local role :"q156_owner";
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
select md5(pg_temp.schema_print()) as q156_reapplied \gset
rollback to savepoint refused;
select pg_temp.expect('A8a never analysed (reltuples -1), pages on disk under 2 GiB: 0156 applies; rows written, and '
  || 'undone, before it ran are not its own',
  'ehr.diagnoses -1 pages under 2 GiB, ehr.lab_requests -1 pages under 2 GiB, '
  || 'lab.work_item_requested_tests -1 pages under 2 GiB | applied | as built',
  :'q156_never_analysed' || ' | ' || :'LAST_ERROR_MESSAGE' || ' | '
  || case when :'q156_reapplied' = :'q156_applied' then 'as built' else 'not as built' end);
-- A row written while 0156 runs: after each of its ALTER TABLE statements, one coded requested test (no foreign key or
-- trigger runs for it: replica mode, as above).
create function pg_temp.write_one_during_0156() returns event_trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp set session_replication_role = replica as $f$
begin
  insert into lab.work_item_requested_tests (work_item_id, facility_id, patient_id, "ordinal", code_system, code, name)
  values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'http://loinc.org', '718-7', 'Haemoglobin');
end
$f$;
create event trigger name_only_codes_write_during_0156 on ddl_command_end when tag in ('ALTER TABLE')
  execute function pg_temp.write_one_during_0156();
set local role :"q156_owner";
\set ON_ERROR_STOP off
:run0156
\set ON_ERROR_STOP on
\set QUIET off
rollback to savepoint refused;
select pg_temp.expect('A8b a row written while 0156 runs: its post-check refuses (55000), nothing applied',
  '55000 0156: rows were written while this file ran: lab.work_item_requested_tests | same | no event trigger',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | '
  || case when md5(pg_temp.schema_print()) = :'q156_undone' then 'same' else 'changed' end || ' | '
  || case when exists (select 1 from pg_event_trigger where evtname = 'name_only_codes_write_during_0156')
          then 'event trigger left' else 'no event trigger' end);

rollback to savepoint undone;
select pg_temp.expect('A9 back to 0156 as the runner left it', 'as built',
  case when md5(pg_temp.schema_print()) = :'q156_applied' then 'as built' else 'not as built' end);

-- Part B. The data path, on 0156 as the runner left it. Fixture: the shared P4c fixture of the order route suites
-- (order-routes-returns.integration.sql), re-prefixed (uuid prefix e56, n156), without its pharmacy helpers and
-- recorded checks; the lab request helper takes the code pair and the name.
do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

insert into identity.purpose_of_use_codes (code, display, source_system)
values ('direct-care', 'Direct patient care', 'n156-test') on conflict (code) do nothing;

-- Platform administrators (standalone, no facility membership).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e5610000-0000-4000-8000-000000000001', 'synthetic:n156:super', 'super@n156.invalid', 'N156 Super Admin', 'active'),
  ('e5610000-0000-4000-8000-000000000002', 'synthetic:n156:support', 'support@n156.invalid', 'N156 Support', 'active'),
  ('e5610000-0000-4000-8000-000000000003', 'synthetic:n156:reviewer', 'reviewer@n156.invalid', 'N156 Reviewer', 'active'),
  ('e5610000-0000-4000-8000-000000000004', 'synthetic:n156:auditor', 'auditor@n156.invalid', 'N156 Auditor', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('e5611000-0000-4000-8000-000000000001', 'e5610000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform', 'N156 suite super admin'),
  ('e5611000-0000-4000-8000-000000000002', 'e5610000-0000-4000-8000-000000000002', 'support_admin', 'platform', 'N156 suite support admin'),
  ('e5611000-0000-4000-8000-000000000003', 'e5610000-0000-4000-8000-000000000003', 'facility_review_admin', 'platform', 'N156 suite facility reviewer'),
  ('e5611000-0000-4000-8000-000000000004', 'e5610000-0000-4000-8000-000000000004', 'security_auditor', 'platform', 'N156 suite security auditor');

-- Governed organizations: hospital GH, hospital H3, laboratory GL.
insert into identity.organizations (id, name, slug) values
  ('e5620000-0000-4000-8000-000000000001', 'N156 Governed Hospital Ltd', 'n156-governed-hospital'),
  ('e5620000-0000-4000-8000-000000000003', 'N156 Third Hospital Ltd', 'n156-third-hospital'),
  ('e5620000-0000-4000-8000-000000000002', 'N156 Governed Diagnostics Ltd', 'n156-governed-diagnostics');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e5621000-0000-4000-8000-000000000001', 'e5620000-0000-4000-8000-000000000001', 'N156 General Hospital',
   'N156-GH', 'Africa/Lagos', true, 'verified'),
  ('e5621000-0000-4000-8000-000000000003', 'e5620000-0000-4000-8000-000000000003', 'N156 Third Hospital',
   'N156-H3', 'Africa/Lagos', true, 'verified'),
  ('e5621000-0000-4000-8000-000000000002', 'e5620000-0000-4000-8000-000000000002', 'N156 Governed Laboratory',
   'N156-GL', 'Africa/Lagos', true, 'verified');
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status)
select ('e5622000-0000-4000-8000-00000000000' || g.n)::uuid, g.product, g.legal_name, g.kind, g.cac,
  'Governed Admin ' || g.n, 'admin' || g.n || '@n156-governed.invalid', 'approved', 'verified', '77' || g.n,
  clock_timestamp(), ('e5620000-0000-4000-8000-00000000000' || g.n)::uuid,
  ('e5621000-0000-4000-8000-00000000000' || g.n)::uuid, 'e5610000-0000-4000-8000-000000000001',
  'Governed approval for the N156 suites', clock_timestamp(), g.legal_name, 'Private Company Limited by Shares',
  '2019-05-01', g.n || ' Governed Road, Ikeja, Lagos', 'active'
  from (values (1, 'ehr', 'hospital', 'RC9956001', 'N156 Governed Hospital Ltd'),
               (2, 'laboratory', 'laboratory', 'RC9956002', 'N156 Governed Diagnostics Ltd'),
               (3, 'ehr', 'hospital', 'RC9956003', 'N156 Third Hospital Ltd')) g(n, product, kind, cac, legal_name);
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
select ('e5620000-0000-4000-8000-00000000000' || n)::uuid, product, ('e5621000-0000-4000-8000-00000000000' || n)::uuid,
  'active', ('e5622000-0000-4000-8000-00000000000' || n)::uuid
  from (values (1, 'ehr'), (2, 'laboratory'), (3, 'ehr')) g(n, product);
-- (The binding trigger copies from a ready_for_review application at
-- approval; the fixture writes the approved binding directly.)
set local session_replication_role = replica;
insert into identity.organization_cac_registrations (cac_registration_number, organization_id, primary_facility_id,
  source_application_id, verified_organization_name, verified_entity_type, verified_registration_date, verified_address,
  verified_registry_status, organization_name_source, entity_type_source, registration_date_source, address_source,
  registry_status_source)
values ('RC9956002', 'e5620000-0000-4000-8000-000000000002', 'e5621000-0000-4000-8000-000000000002',
  'e5622000-0000-4000-8000-000000000002', 'N156 Governed Diagnostics Ltd', 'Private Company Limited by Shares',
  '2019-05-01', '2 Governed Road, Ikeja, Lagos', 'active', 'qoreid', 'qoreid', 'qoreid', 'qoreid', 'qoreid');
set local session_replication_role = origin;

-- Governed staff. n: 11 DA doctor, 12 CA clinician, 13 NA nurse, 14 LA lab,
-- 15 PA pharmacist, 16 RA receptionist, 17 GA org_admin (GH); 21 GLM lab
-- (GL); 26 D3 doctor (H3).
insert into auth.accounts (id, subject, email, display_name, status)
select ('e5610000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:n156:' || s.code,
  s.code || '@n156-staff.invalid', s.full_name, 'active'
  from (values (11, 'da', 'Ada Doctor'), (12, 'ca', 'Bayo Clinician'), (13, 'na', 'Chika Nurse'),
               (14, 'la', 'Dele Lab'), (15, 'pa', 'Efe Pharmacist'), (16, 'ra', 'Funmi Reception'),
               (17, 'ga', 'Gbade Admin'), (21, 'glm', 'Hassan Governed Lab'), (26, 'd3', 'Ifeoma Third Doctor'))
       s(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e5612000-0000-4000-8000-0000000000' || s.n)::uuid, ('e5610000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@n156-staff.invalid', 'verified', s.role
  from (values (11, 'da', 'Ada Doctor', 'doctor'), (12, 'ca', 'Bayo Clinician', 'clinician'),
               (13, 'na', 'Chika Nurse', 'nurse'), (14, 'la', 'Dele Lab', 'lab'), (15, 'pa', 'Efe Pharmacist', 'pharmacist'),
               (16, 'ra', 'Funmi Reception', 'receptionist'), (17, 'ga', 'Gbade Admin', 'org_admin'),
               (21, 'glm', 'Hassan Governed Lab', 'lab'), (26, 'd3', 'Ifeoma Third Doctor', 'doctor'))
       s(n, code, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e5613000-0000-4000-8000-0000000000' || s.n)::uuid, ('e5612000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e5610000-0000-4000-8000-0000000000' || s.n)::uuid, ('e5620000-0000-4000-8000-00000000000' || s.org)::uuid,
  ('e5621000-0000-4000-8000-00000000000' || s.org)::uuid, s.role, s.role, true, true
  from (values (11, 1, 'doctor'), (12, 1, 'clinician'), (13, 1, 'nurse'), (14, 1, 'lab'), (15, 1, 'pharmacist'),
               (16, 1, 'receptionist'), (17, 1, 'org_admin'), (21, 2, 'lab'), (26, 3, 'doctor')) s(n, org, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e5611000-0000-4000-8000-0000000000' || s.n)::uuid, ('e5610000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e5613000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e5621000-0000-4000-8000-00000000000' || s.org)::uuid, 'N156 suite governed role'
  from (values (11, 1, 'doctor'), (12, 1, 'clinician'), (13, 1, 'nurse'), (14, 1, 'lab'), (15, 1, 'pharmacist'),
               (16, 1, 'receptionist'), (17, 1, 'org_admin'), (21, 2, 'lab'), (26, 3, 'doctor')) s(n, org, role);
-- DA's licence, attested by GH's administrator (P4b's attestation table).
insert into identity.staff_licence_attestations (organization_id, facility_id, account_id, staff_id, membership_id,
  role_code, role_grant_id, licence_body, licence_number, attested_person_name, verification_method,
  attested_by_account_id, attested_by_membership_id, attestation_version, attested_at, correlation_id)
values ('e5620000-0000-4000-8000-000000000001', 'e5621000-0000-4000-8000-000000000001',
  'e5610000-0000-4000-8000-000000000011', 'e5612000-0000-4000-8000-000000000011',
  'e5613000-0000-4000-8000-000000000011', 'doctor', 'e5611000-0000-4000-8000-000000000011', 'MDCN', 'MDCN/45678',
  'Ada Doctor', 'facility_attestation', 'e5610000-0000-4000-8000-000000000017', 'e5613000-0000-4000-8000-000000000017',
  'facility-staff-attestation-v1', clock_timestamp(), 'n156-fixture-licence');

-- Patients: P and Q with active accounts and a live patient session, N
-- without an account.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e5610000-0000-4000-8000-000000000041', 'synthetic:n156:patient-p', 'patient-p@n156.invalid', 'Patience Okafor', 'active'),
  ('e5610000-0000-4000-8000-000000000042', 'synthetic:n156:patient-q', 'patient-q@n156.invalid', 'Quadri Bello', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e5630000-0000-4000-8000-000000000001', 'e5610000-0000-4000-8000-000000000041', 'HID-N56PATP',
   'Patience', 'Okafor', 'Patience Okafor', 'female', '1990-04-12', 'active'),
  ('e5630000-0000-4000-8000-000000000002', 'e5610000-0000-4000-8000-000000000042', 'HID-N56PATQ',
   'Quadri', 'Bello', 'Quadri Bello', 'male', '1985-09-30', 'active'),
  ('e5630000-0000-4000-8000-000000000003', null, 'HID-N56PATN', 'Nkem', 'Eze', 'Nkem Eze', 'female', null, 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('e5631000-0000-4000-8000-00000000000' || n)::uuid, ('e5610000-0000-4000-8000-00000000004' || n)::uuid,
  ('e5631000-0000-4000-8000-00000000000' || n)::uuid, md5('n156-session-' || n) || md5('n156-session-' || n),
  gen_random_uuid(), 1, 'password', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '2 hours', 'patient', ('e5630000-0000-4000-8000-00000000000' || n)::uuid
  from generate_series(1, 2) n;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), ('e5630000-0000-4000-8000-00000000000' || p.n)::uuid,
  ('e5612000-0000-4000-8000-0000000000' || s.n)::uuid, ('e5610000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e5613000-0000-4000-8000-0000000000' || s.n)::uuid, ('e5621000-0000-4000-8000-00000000000' || s.org)::uuid,
  'write_records', 'active', 'N156 suite direct-care consent', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '30 days', false, 'direct-care'
  from (values (11, 1), (12, 1), (13, 1), (14, 1), (15, 1), (16, 1), (26, 3)) s(n, org)
  cross join generate_series(1, 3) p(n)
 where s.n <> 26 or p.n = 1;

-- Self sign-ups through the real commands, then support's review: 1
-- laboratory L1 (lab), 2 pharmacy PH1 (pharmacist).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:n156:super', true),
  set_config('app.correlation_id', 'n156-fixture-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'N156 suite opens facility sign-up');
select platform.admin_set_control('cross_facility_orders_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'N156 suite opens orders between facilities');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'n156-fixture-signup', true),
  set_config('app.purpose_of_use', '', true);
create function pg_temp.n156_sign_up(n integer, product text, kind text, cac text, admin_name text, admin_email text,
  legal_name text)
returns void language plpgsql as $f$
declare
  application_id uuid;
  current_application record;
  activated record;
  challenge_id uuid := ('e5640000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
  code_hmac char(64) := encode(sha256(('n156-otp-' || n)::bytea), 'hex');
  session_hmac char(64) := encode(sha256(('n156-session-' || n)::bytea), 'hex');
begin
  application_id := identity.submit_self_service_organization_application(product, kind, cac, admin_name,
    admin_email, encode(sha256(('n156-network-' || n)::bytea), 'hex'));
  select * into current_application from identity.public_get_organization_application(cac, admin_email, product);
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
    'verified', '9956' || n, cac, legal_name, 'Private Company Limited by Shares', '2021-02-0' || (n % 9 + 1),
    n || ' Sign-up Street, Yaba, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment(cac, admin_email, product, challenge_id, code_hmac,
    admin_name, kind);
  if not identity.verify_organization_profile_completion_challenge(challenge_id, code_hmac, session_hmac) then
    raise exception 'N156 sign-up % was not verified', n;
  end if;
  select * into activated from identity.activate_self_service_provider_enrollment(session_hmac,
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform set_config('hid.test.app_' || n, application_id::text, true);
  perform set_config('hid.test.facility_' || n, activated.facility_id::text, true);
  perform set_config('hid.test.account_' || n, activated.account_id::text, true);
  perform set_config('hid.test.org_' || n, activated.organization_id::text, true);
end
$f$;
reset role;
grant execute on function pg_temp.n156_sign_up(integer,text,text,text,text,text,text) to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select pg_temp.n156_sign_up(1, 'laboratory', 'laboratory', 'RC9957001', 'Kemi Lab Admin', 'kemi@n156-lab.invalid',
  'N156 Sign-up Laboratory Ltd');
select pg_temp.n156_sign_up(2, 'pharmacy', 'pharmacy', 'RC9957002', 'Lanre Pharmacy Admin',
  'lanre@n156-pharmacy.invalid', 'N156 Sign-up Pharmacy Ltd');
select set_config('app.actor_subject', 'synthetic:n156:super', true),
  set_config('app.correlation_id', 'n156-fixture-review', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select identity.admin_review_self_service_facility(current_setting('hid.test.app_1')::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('unreviewed') application
    where application.application_id = current_setting('hid.test.app_1')::uuid),
  'Reached the laboratory on its CAC contact number', 'lab', 'cac_registered_contact', 'MLSCN', 'MLS/10001');
select identity.admin_review_self_service_facility(current_setting('hid.test.app_2')::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('unreviewed') application
    where application.application_id = current_setting('hid.test.app_2')::uuid),
  'Reached the pharmacy on its CAC contact number', 'pharmacist', 'cac_registered_contact', 'PCN', 'PCN/20002');
reset role;
select set_config('hid.test.membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.account_' || n)::uuid), true),
  set_config('hid.test.subject_' || n,
  (select account.subject from auth.accounts account where account.id = current_setting('hid.test.account_' || n)::uuid),
  true)
  from generate_series(1, 2) n;

-- L1's second lab member LB2 (31) and receptionist RB (32); PH1's second
-- pharmacist PB2 (33). No consent grants at L1 or PH1.
insert into auth.accounts (id, subject, email, display_name, status)
select ('e5610000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:n156:' || s.code,
  s.code || '@n156-staff.invalid', s.full_name, 'active'
  from (values (31, 'lb2', 'Musa Second Lab'), (32, 'rb', 'Ngozi Lab Reception'), (33, 'pb2', 'Ola Second Pharmacist'))
       s(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e5612000-0000-4000-8000-0000000000' || s.n)::uuid, ('e5610000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@n156-staff.invalid', 'verified', s.role
  from (values (31, 'lb2', 'Musa Second Lab', 'lab'), (32, 'rb', 'Ngozi Lab Reception', 'receptionist'),
               (33, 'pb2', 'Ola Second Pharmacist', 'pharmacist')) s(n, code, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e5613000-0000-4000-8000-0000000000' || s.n)::uuid, ('e5612000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e5610000-0000-4000-8000-0000000000' || s.n)::uuid, current_setting('hid.test.org_' || s.site)::uuid,
  current_setting('hid.test.facility_' || s.site)::uuid, s.role, s.role, true, true
  from (values (31, 1, 'lab'), (32, 1, 'receptionist'), (33, 2, 'pharmacist')) s(n, site, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e5611000-0000-4000-8000-0000000000' || s.n)::uuid, ('e5610000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e5613000-0000-4000-8000-0000000000' || s.n)::uuid,
  current_setting('hid.test.facility_' || s.site)::uuid, 'N156 suite invited role'
  from (values (31, 1, 'lab'), (32, 1, 'receptionist'), (33, 2, 'pharmacist')) s(n, site, role);

-- Encounters at GH for P, Q and N, written by DA through the EHR runtime.
set local role hid_ehr_api_runtime;
select set_config('app.actor_subject', 'synthetic:n156:da', true),
  set_config('app.membership_id', 'e5613000-0000-4000-8000-000000000011', true),
  set_config('app.facility_id', 'e5621000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'n156-fixture-ehr', true),
  set_config('app.purpose_of_use', 'direct-care', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e5650000-0000-4000-8000-00000000000' || n)::uuid, ('e5630000-0000-4000-8000-00000000000' || n)::uuid,
  'e5621000-0000-4000-8000-000000000001', 'e5610000-0000-4000-8000-000000000011',
  'e5613000-0000-4000-8000-000000000011', 'ambulatory', 'in_progress', clock_timestamp()
  from generate_series(1, 3) n;
reset role;

-- Session helpers.
create function pg_temp.as_staff(member integer, facility uuid, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:n156:' || case member when 11 then 'da' when 12 then 'ca'
      when 13 then 'na' when 14 then 'la' when 15 then 'pa' when 16 then 'ra' when 17 then 'ga' when 21 then 'glm'
      when 26 then 'd3' when 31 then 'lb2' when 32 then 'rb' when 33 then 'pb2' when 18 then 'dr' when 19 then 'dx'
      when 22 then 'gpm' when 23 then 'gl2a' when 24 then 'gl3' when 25 then 'llm' when 27 then 'gl2b'
      else 'unknown' end, true),
    set_config('app.membership_id', 'e5613000-0000-4000-8000-0000000000' || member, true),
    set_config('hid.test.actor_account', 'e5610000-0000-4000-8000-0000000000' || member, true),
    set_config('app.facility_id', facility::text, true),
    set_config('app.correlation_id', 'n156-suite-' || member || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.as_signup_admin(n integer, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', current_setting('hid.test.subject_' || n), true),
    set_config('app.membership_id', current_setting('hid.test.membership_' || n), true),
    set_config('hid.test.actor_account', current_setting('hid.test.account_' || n), true),
    set_config('app.facility_id', current_setting('hid.test.facility_' || n), true),
    set_config('app.correlation_id', 'n156-suite-admin-' || n || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.as_platform(admin integer)
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:n156:' || case admin when 1 then 'super' when 2 then 'support'
      when 3 then 'reviewer' when 4 then 'auditor' else 'unknown' end, true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'n156-suite-platform-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', 'healthcare-operations', true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.as_patient(n integer)
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:n156:patient-' || case n when 1 then 'p' else 'q' end, true),
    set_config('app.account_id', 'e5610000-0000-4000-8000-00000000004' || n, true),
    set_config('app.session_id', 'e5631000-0000-4000-8000-00000000000' || n, true),
    set_config('app.patient_id', 'e5630000-0000-4000-8000-00000000000' || n, true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '5 minutes')::text, true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'n156-suite-patient-' || n || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', 'patient-self', true);
$f$;
-- A lab request by DA for patient n (1 P, 2 Q, 3 N), in the given status, with the given code pair (null, null:
-- by name only) and name, through the EHR runtime with ehr-api's columns; answers its id.
create function pg_temp.lab_request(n integer, request_status text, code_system text, code text, display text)
returns uuid language plpgsql as $f$
declare created uuid := gen_random_uuid();
begin
  perform pg_temp.as_staff(11, 'e5621000-0000-4000-8000-000000000001');
  insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
  values (created, ('e5650000-0000-4000-8000-00000000000' || n)::uuid, ('e5630000-0000-4000-8000-00000000000' || n)::uuid,
    'e5621000-0000-4000-8000-000000000001', 'e5610000-0000-4000-8000-000000000011',
    'e5613000-0000-4000-8000-000000000011', code_system, code, display, 'urgent', request_status, 'whole-blood',
    'Fever for three days');
  return created;
end
$f$;
-- Send an order (kind, order, receiving facility) as member m: answers the route id.
create function pg_temp.send(m integer, kind text, order_id uuid, receiving uuid, key text,
  attestation text default null)
returns uuid language plpgsql as $f$
declare
  source_row record;
  sent record;
begin
  perform pg_temp.as_staff(m, 'e5621000-0000-4000-8000-000000000001');
  if kind = 'lab_request' then
    select source_order.patient_id, source_order.encounter_id, source_order.row_version into source_row
      from ehr.lab_requests source_order where source_order.id = order_id;
  else
    select source_order.patient_id, source_order.encounter_id, source_order.row_version into source_row
      from ehr.prescriptions source_order where source_order.id = order_id;
  end if;
  select * into sent from ehr.send_order_route(gen_random_uuid(), kind, source_row.patient_id, order_id,
    source_row.encounter_id, source_row.row_version, receiving,
    coalesce(attestation, case kind when 'lab_request' then 'order-route-lab-attestation-v1'
                                   else 'order-route-prescription-attestation-v1' end),
    key, encode(sha256(key::bytea), 'hex'));
  return sent.route_id;
end
$f$;
-- Owner SQL: a received, completed execution with a verified result
-- version for a route-backed Lab work item at L1 (entered by LB2, verified by
-- LB1; triggers and keys off), as the Lab's own commands leave it. Answers
-- the result id; its execution and verification are set as hid.test.<label>_*.
create function pg_temp.lab_chain(work_item uuid, label text, numeric_value numeric)
returns uuid language plpgsql as $f$
declare
  item lab.work_items%rowtype;
  test_id uuid;
  accession_id uuid := gen_random_uuid();
  requirement_id uuid := gen_random_uuid();
  specimen_id uuid := gen_random_uuid();
  execution_id uuid := gen_random_uuid();
  result_id uuid := gen_random_uuid();
  verification_id uuid := gen_random_uuid();
begin
  select * into item from lab.work_items where id = work_item;
  select test.id into test_id from lab.work_item_requested_tests test where test.work_item_id = work_item;
  set local session_replication_role = replica;
  insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
    idempotency_key, request_sha256, correlation_id)
  values (accession_id, work_item, item.patient_id, item.facility_id, item.priority,
    'e5610000-0000-4000-8000-000000000031', 'e5613000-0000-4000-8000-000000000031', 'n156-chain-acc-' || label || '-000',
    repeat('a', 64), 'n156-chain');
  insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
  values (requirement_id, accession_id, item.patient_id, item.facility_id, 1, 'whole blood');
  insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
    collected_at, collected_by, collected_by_membership_id, received_at, received_by, received_by_membership_id,
    row_version)
  values (specimen_id, requirement_id, accession_id, item.patient_id, item.facility_id, 'whole blood', 'received',
    clock_timestamp(), 'e5610000-0000-4000-8000-000000000031', 'e5613000-0000-4000-8000-000000000031', clock_timestamp(),
    'e5610000-0000-4000-8000-000000000031', 'e5613000-0000-4000-8000-000000000031', 3);
  insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
    started_by, started_by_membership_id, started_at, completed_by, completed_by_membership_id, completed_at,
    idempotency_key, request_sha256, correlation_id, row_version)
  values (execution_id, accession_id, specimen_id, test_id, item.patient_id, item.facility_id, 'completed',
    'e5610000-0000-4000-8000-000000000031', 'e5613000-0000-4000-8000-000000000031', clock_timestamp(),
    'e5610000-0000-4000-8000-000000000031', 'e5613000-0000-4000-8000-000000000031', clock_timestamp(),
    'n156-chain-exe-' || label || '-000', repeat('a', 64), 'n156-chain', 2);
  insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id)
  values (result_id, execution_id, item.patient_id, item.facility_id, 'e5610000-0000-4000-8000-000000000031',
    'e5613000-0000-4000-8000-000000000031');
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, idempotency_key,
    request_sha256, correlation_id, revision_kind)
  values (result_id, execution_id, item.patient_id, item.facility_id, 1, 'numeric', numeric_value, 'g/dL', '12.0-15.5',
    case when numeric_value < 12 then 'low' else 'normal' end, 'e5610000-0000-4000-8000-000000000031',
    'e5613000-0000-4000-8000-000000000031', 'n156-chain-rev-' || label || '-001', repeat('a', 64), 'n156-chain',
    'original');
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, result_id, execution_id, item.patient_id, item.facility_id, 1,
    item.accepted_by, item.accepted_by_membership_id, clock_timestamp(), 'Verified by the second scientist',
    'n156-chain-ver-' || label || '-001', repeat('a', 64), 'n156-chain');
  set local session_replication_role = origin;
  perform set_config('hid.test.' || label || '_execution', execution_id::text, true);
  perform set_config('hid.test.' || label || '_verification_1', verification_id::text, true);
  return result_id;
end
$f$;
-- Owner SQL: a corrected version (2) of a result, verified (triggers off).
create function pg_temp.lab_correction(result_id uuid, label text, numeric_value numeric, verifier uuid,
  verifier_membership uuid)
returns uuid language plpgsql as $f$
declare
  head lab.results%rowtype;
  verification_id uuid := gen_random_uuid();
begin
  select * into head from lab.results where id = result_id;
  set local session_replication_role = replica;
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, correction_reason,
    idempotency_key, request_sha256, correlation_id, revision_kind, supersedes_version)
  values (result_id, head.execution_id, head.patient_id, head.facility_id, 2, 'numeric', numeric_value, 'g/dL',
    '12.0-15.5', 'normal', 'e5610000-0000-4000-8000-000000000031', 'e5613000-0000-4000-8000-000000000031',
    'Analyser recalibrated', 'n156-chain-rev-' || label || '-002', repeat('a', 64), 'n156-chain', 'correction', 1);
  update lab.results set current_version = 2 where id = result_id;
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, result_id, head.execution_id, head.patient_id, head.facility_id, 2, verifier,
    verifier_membership, clock_timestamp(), 'Verified the correction', 'n156-chain-ver-' || label || '-002',
    repeat('a', 64), 'n156-chain');
  set local session_replication_role = origin;
  return verification_id;
end
$f$;
-- The Lab's release statement, as the session's member (route access or consent).
create function pg_temp.release(result_id uuid, result_version bigint, verification_id uuid, key text)
returns void language plpgsql as $f$
declare head record;
begin
  select result_row.execution_id, result_row.patient_id, result_row.facility_id into head
    from lab.results result_row where result_row.id = result_id;
  insert into lab.result_releases (verification_id, result_id, execution_id, patient_id, facility_id, result_version,
    released_by, released_by_membership_id, released_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, result_id, head.execution_id, head.patient_id, head.facility_id, result_version,
    current_setting('hid.test.actor_account')::uuid, current_setting('app.membership_id')::uuid, clock_timestamp(),
    'Released to the requester',
    key, repeat('b', 64), current_setting('app.correlation_id'));
end
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;

-- Part B helpers. A diagnosis by DA for P (EP), with ehr-api's insert and then its recent record (diagnoses.service.ts),
-- through the EHR runtime; answers its id.
create function pg_temp.diagnosis(code_system text, code text, display text) returns uuid language plpgsql as $f$
declare created uuid;
begin
  perform pg_temp.as_staff(11, 'e5621000-0000-4000-8000-000000000001');
  insert into ehr.diagnoses (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, code_system, code,
    display, clinical_status, verification_status, onset_at, abatement_at, notes)
  values ('e5650000-0000-4000-8000-000000000001', 'e5630000-0000-4000-8000-000000000001',
    'e5621000-0000-4000-8000-000000000001', 'e5610000-0000-4000-8000-000000000011',
    'e5613000-0000-4000-8000-000000000011', code_system, code, display, 'active', 'provisional', null, null, null)
  returning id into created;
  perform ehr.record_recent_diagnosis(code_system, code, display);
  return created;
end
$f$;
-- lab-api's acceptance of an order of this facility (lab-work-items.service.ts: the work item, then its one
-- requested test), as LA at GH, for the order whose row the suite runner read (source); the pair and the name given.
create function pg_temp.own_work_item(source jsonb, code_system text, code text, name text, key text)
returns uuid language plpgsql as $f$
declare created uuid := gen_random_uuid();
begin
  perform pg_temp.as_staff(14, 'e5621000-0000-4000-8000-000000000001');
  insert into lab.work_items(id,patient_id,facility_id,ordering_facility_id,source_ehr_order_id,
    source_ehr_order_version,source_encounter_id,status,priority,test_code_system,test_code,
    test_name,clinical_indication,requested_by,requested_at,accepted_by,
    accepted_by_membership_id,idempotency_key,request_sha256,correlation_id)
  values (created, (source ->> 'patient_id')::uuid, 'e5621000-0000-4000-8000-000000000001',
    'e5621000-0000-4000-8000-000000000001', (source ->> 'id')::uuid, (source ->> 'row_version')::bigint,
    (source ->> 'encounter_id')::uuid, 'accepted', source ->> 'priority', code_system, code, name,
    source ->> 'clinical_information', (source ->> 'created_by')::uuid, (source ->> 'created_at')::timestamptz,
    'e5610000-0000-4000-8000-000000000014', 'e5613000-0000-4000-8000-000000000014', key, repeat('b', 64),
    current_setting('app.correlation_id'));
  insert into lab.work_item_requested_tests(work_item_id,facility_id,patient_id,"ordinal",code_system,code,name)
  values (created, 'e5621000-0000-4000-8000-000000000001', (source ->> 'patient_id')::uuid, 1, code_system, code, name);
  return created;
end
$f$;
-- A pair and a name as one text ('null' for a null code).
create function pg_temp.pair(code_system text, code text, name text) returns text language sql immutable as $f$
  select coalesce(code_system, 'null') || '|' || coalesce(code, 'null') || '|' || coalesce(name, 'null')
$f$;
-- An order route's result reports, oldest first: kind:version:system|code|name.
create function pg_temp.reports(route uuid) returns text language sql stable as $f$
  select string_agg(report.kind || ':' || report.result_version || ':'
           || pg_temp.pair(report.test_code_system, report.test_code, report.test_name), ' '
           order by report.recorded_at, report.id)
    from lab.order_route_result_reports report where report.route_id = route
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;

-- B1. Lab requests by name only, through ehr-api's columns, as DA (EHR runtime).
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_own', pg_temp.lab_request(1, 'active', null, null, 'Malaria rapid test (as written)')::text,
  true);
select set_config('hid.test.lr_own_coded', pg_temp.lab_request(1, 'active', 'http://loinc.org', '70569-9',
  'Malaria rapid test')::text, true);
select set_config('hid.test.lr_changed', pg_temp.lab_request(2, 'active', null, null, 'Widal test (as written)')::text,
  true);
select pg_temp.expect('B1a a lab request by name only is saved: both codes null, the name kept',
  'null|null|Malaria rapid test (as written)',
  (select pg_temp.pair(request.test_code_system, request.test_code, request.test_display)
     from ehr.lab_requests request where request.id = current_setting('hid.test.lr_own')::uuid));
select pg_temp.check('B1b a code without its code system is refused',
  $s$select pg_temp.lab_request(1, 'active', null, '718-7', 'Haemoglobin')$s$,
  '23514 new row for relation "lab_requests" violates check constraint "lab_requests_test_code_pair_ck"');
select pg_temp.check('B1c a code system without its code is refused',
  $s$select pg_temp.lab_request(1, 'active', 'http://loinc.org', null, 'Haemoglobin')$s$,
  '23514 new row for relation "lab_requests" violates check constraint "lab_requests_test_code_pair_ck"');
select pg_temp.check('B1d blank codes are no name-only request: refused as before',
  $s$select pg_temp.lab_request(1, 'active', '', '', 'Haemoglobin')$s$,
  '23514 new row for relation "lab_requests" violates check constraint "lab_requests_test_code_check"');
select pg_temp.check('B1e the name stays required', $s$select pg_temp.lab_request(1, 'active', null, null, null)$s$,
  '23502 null value in column "test_display" of relation "lab_requests" violates not-null constraint');
select set_config('app.change_reason', 'The clinician raised the priority', true);
select pg_temp.check('B1f a name-only request is changed like any other',
  format($s$update ehr.lab_requests set priority = 'stat' where id = %L$s$, current_setting('hid.test.lr_changed')), 'ok');
reset role;
select pg_temp.expect('B1g ... and its versions are captured with the null pair',
  '1:null|null|Widal test (as written) 2:null|null|Widal test (as written) stat',
  (select string_agg(version_row.version_no || ':' || pg_temp.pair(version_row.resulting_state ->> 'test_code_system',
            version_row.resulting_state ->> 'test_code', version_row.resulting_state ->> 'test_display')
            || case when version_row.version_no > 1 then ' ' || (version_row.resulting_state ->> 'priority') else '' end,
            ' ' order by version_row.version_no)
     from ehr.record_versions version_row
    where version_row.resource_id = current_setting('hid.test.lr_changed')));

-- B2. Diagnoses by name only, as DA (EHR runtime); ehr-api records the pick after the save.
set local role hid_ehr_api_runtime;
select set_config('hid.test.dx_name', pg_temp.diagnosis(null, null, 'Fever, cause not yet known')::text, true);
select set_config('hid.test.dx_coded', pg_temp.diagnosis('ICD-10', 'A01.0', 'Typhoid fever')::text, true);
select pg_temp.expect('B2a a diagnosis by name only is saved: both codes null, the name kept',
  'null|null|Fever, cause not yet known',
  (select pg_temp.pair(diagnosis.code_system, diagnosis.code, diagnosis.display)
     from ehr.diagnoses diagnosis where diagnosis.id = current_setting('hid.test.dx_name')::uuid));
select pg_temp.check('B2b a code without its code system is refused',
  $s$select pg_temp.diagnosis(null, 'A01.0', 'Typhoid fever')$s$,
  '23514 new row for relation "diagnoses" violates check constraint "diagnoses_code_pair_ck"');
select pg_temp.check('B2c a code system without its code is refused',
  $s$select pg_temp.diagnosis('ICD-11', null, 'Typhoid fever')$s$,
  '23514 new row for relation "diagnoses" violates check constraint "diagnoses_code_pair_ck"');
select pg_temp.check('B2d blank codes are refused as before', $s$select pg_temp.diagnosis('', '', 'Typhoid fever')$s$,
  '23514 new row for relation "diagnoses" violates check constraint "diagnoses_code_check"');
select pg_temp.expect('B2e the recent list holds the coded pick only: a name-only save records nothing',
  'ICD-10:A01.0(Typhoid fever)x1',
  (select string_agg(format('%s:%s(%s)x%s', recent.code_system, recent.code, recent.display, recent.use_count), ' ')
     from ehr.recent_diagnoses(10) recent));
select set_config('app.change_reason', 'Confirmed on review', true);
select pg_temp.check('B2f a name-only diagnosis is changed like any other',
  format($s$update ehr.diagnoses set verification_status = 'confirmed' where id = %L$s$,
    current_setting('hid.test.dx_name')), 'ok');
reset role;
select pg_temp.expect('B2g ... and its versions are captured with the null pair',
  '1:null|null|Fever, cause not yet known 2:null|null|Fever, cause not yet known',
  (select string_agg(version_row.version_no || ':' || pg_temp.pair(version_row.resulting_state ->> 'code_system',
            version_row.resulting_state ->> 'code', version_row.resulting_state ->> 'display'), ' '
            order by version_row.version_no)
     from ehr.record_versions version_row where version_row.resource_id = current_setting('hid.test.dx_name')));

-- B3. This facility's own lab (LA at GH, lab-api's statements): the name-only order is accepted with its null pair;
-- the pair must equal the order's; the executions and the released read answer the null pair and the name.
select set_config('hid.test.src_own', (select to_jsonb(request) from ehr.lab_requests request
                                         where request.id = current_setting('hid.test.lr_own')::uuid)::text, true),
       set_config('hid.test.src_own_coded', (select to_jsonb(request) from ehr.lab_requests request
                                               where request.id = current_setting('hid.test.lr_own_coded')::uuid)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.check('B3a a coded work item for the name-only order is refused',
  $s$select pg_temp.own_work_item(current_setting('hid.test.src_own')::jsonb, 'http://loinc.org', '70569-9',
    'Malaria rapid test (as written)', 'n156-own-work-wrong-0001')$s$,
  '23514 Lab work item does not match the exact active EHR order version and actor context');
select pg_temp.check('B3b a name-only work item for a coded order is refused',
  $s$select pg_temp.own_work_item(current_setting('hid.test.src_own_coded')::jsonb, null, null, 'Malaria rapid test',
    'n156-own-work-wrong-0002')$s$,
  '23514 Lab work item does not match the exact active EHR order version and actor context');
select set_config('hid.test.own_item', pg_temp.own_work_item(current_setting('hid.test.src_own')::jsonb, null, null,
  'Malaria rapid test (as written)', 'n156-own-work-item-0001')::text, true);
select set_config('hid.test.own_item_coded', pg_temp.own_work_item(current_setting('hid.test.src_own_coded')::jsonb,
  'http://loinc.org', '70569-9', 'Malaria rapid test', 'n156-own-work-item-0002')::text, true);
select pg_temp.check('B3c a coded requested test under the name-only work item is refused',
  format($s$insert into lab.work_item_requested_tests(work_item_id,facility_id,patient_id,"ordinal",code_system,code,name)
    values (%L, 'e5621000-0000-4000-8000-000000000001', 'e5630000-0000-4000-8000-000000000001', 2, 'http://loinc.org',
    '70569-9', 'Malaria rapid test (as written)')$s$, current_setting('hid.test.own_item')),
  '23514 Requested-test snapshot differs from accepted EHR order');
reset role;
select pg_temp.expect('B3d the work item and its requested test carry the null pair; the coded one its codes',
  'null|null|Malaria rapid test (as written) null|null|Malaria rapid test (as written) | '
  || 'http://loinc.org|70569-9|Malaria rapid test http://loinc.org|70569-9|Malaria rapid test',
  (select string_agg(pg_temp.pair(item.test_code_system, item.test_code, item.test_name) || ' '
            || pg_temp.pair(test.code_system, test.code, test.name), ' | ' order by item.test_code nulls first)
     from lab.work_items item join lab.work_item_requested_tests test on test.work_item_id = item.id
    where item.id in (current_setting('hid.test.own_item')::uuid, current_setting('hid.test.own_item_coded')::uuid)));
select set_config('hid.test.own_result', pg_temp.lab_chain(current_setting('hid.test.own_item')::uuid, 'own', 4.9)::text,
  true);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(14, 'e5621000-0000-4000-8000-000000000001');
select pg_temp.expect('B3e lab-api''s execution read (lab-executions.service.ts EXEC) answers the name and no codes',
  'Malaria rapid test (as written)|null|null',
  (select t.name || '|' || coalesce(t.code, 'null') || '|' || coalesce(t.code_system, 'null')
     from lab.test_executions e join lab.work_item_requested_tests t on t.id = e.requested_test_id
    where e.id = current_setting('hid.test.own_execution')::uuid));
select pg_temp.check('B3f LA releases the result of the name-only work item',
  format($s$select pg_temp.release(%L, 1, %L, 'n156-own-release-01')$s$, current_setting('hid.test.own_result'),
    current_setting('hid.test.own_verification_1')), 'ok');
select pg_temp.expect('B3g lab-api''s released read for the order (listReleasedForEhrOrder) answers the null pair',
  'null|null|Malaria rapid test (as written)',
  (select pg_temp.pair(test_code_system, test_code, test_name) from lab.work_items
    where source_ehr_order_id = current_setting('hid.test.lr_own')::uuid
      and facility_id = 'e5621000-0000-4000-8000-000000000001'));
reset role;
select pg_temp.expect('B3h no route report for this facility''s own work', '0',
  (select count(*)::text from lab.order_route_result_reports report
    where report.work_item_id = current_setting('hid.test.own_item')::uuid));

-- B4. Another facility's lab (L1), each route step with a name-only order: DA sends it; L1's lists and page show it;
-- LB1 accepts it (the work item and its requested test take the null pair); v1 released (LB1) and its correction v2
-- released (LB2), each reported to GH with the null pair; the patient's own list (C5) and GH's page (C3) show it.
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_route', pg_temp.lab_request(1, 'active', null, null, 'Sickle cell screen (as written)')::text,
  true);
select set_config('hid.test.route', pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_route')::uuid,
  current_setting('hid.test.facility_1')::uuid, 'n156-route-send-0001')::text, true);
select set_config('hid.test.lr_coded_route', pg_temp.lab_request(1, 'active', 'http://loinc.org', '718-7',
  'Haemoglobin')::text, true);
select set_config('hid.test.route_coded', pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_coded_route')::uuid,
  current_setting('hid.test.facility_1')::uuid, 'n156-route-send-0002')::text, true);
reset role;
select pg_temp.expect('B4a the route carries the null pair and the name (the kind check holds); the coded one its codes',
  'lab_request null|null|Sickle cell screen (as written) | lab_request http://loinc.org|718-7|Haemoglobin',
  (select string_agg(route.kind || ' ' || pg_temp.pair(route.test_code_system, route.test_code, route.test_display), ' | '
            order by route.test_code nulls first)
     from ehr.order_routes route
    where route.id in (current_setting('hid.test.route')::uuid, current_setting('hid.test.route_coded')::uuid)));
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.expect('B4b L1''s incoming list (lab.list_order_routes) and page (lab.get_order_route) show the name and '
  || 'no codes', 'null|null|Sickle cell screen (as written) null|null|Sickle cell screen (as written)',
  (select pg_temp.pair(incoming.test_code_system, incoming.test_code, incoming.test_name)
     from lab.list_order_routes('incoming', null) incoming where incoming.route_id = current_setting('hid.test.route')::uuid)
  || ' ' || (select pg_temp.pair(one.test_code_system, one.test_code, one.test_name)
               from lab.get_order_route(current_setting('hid.test.route')::uuid) one));
select set_config('hid.test.item', (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.route')::uuid, 1, 'health_id', 'HID-N56PATP', 'n156-route-accept-0001', repeat('a', 64))
  accepted), true);
select set_config('hid.test.item_coded', (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.route_coded')::uuid, 1, 'health_id', 'HID-N56PATP', 'n156-route-accept-0002', repeat('a', 64))
  accepted), true);
reset role;
select pg_temp.expect('B4c LB1 accepts it: the work item and its requested test take the null pair and the name',
  'null|null|Sickle cell screen (as written) null|null|Sickle cell screen (as written) accepted',
  (select pg_temp.pair(item.test_code_system, item.test_code, item.test_name) || ' '
          || pg_temp.pair(test.code_system, test.code, test.name) || ' ' || route.state
     from lab.work_items item join lab.work_item_requested_tests test on test.work_item_id = item.id
     join ehr.order_routes route on route.id = item.order_route_id
    where item.id = current_setting('hid.test.item')::uuid));
select set_config('hid.test.result', pg_temp.lab_chain(current_setting('hid.test.item')::uuid, 'route', 7.1)::text, true);
select set_config('hid.test.result_coded', pg_temp.lab_chain(current_setting('hid.test.item_coded')::uuid, 'coded',
  13.2)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('B4d LB1 releases v1', format($s$select pg_temp.release(%L, 1, %L, 'n156-route-release-01')$s$,
  current_setting('hid.test.result'), current_setting('hid.test.route_verification_1')), 'ok');
select pg_temp.check('B4d ... and the coded order''s v1', format($s$select pg_temp.release(%L, 1, %L,
  'n156-route-release-02')$s$, current_setting('hid.test.result_coded'), current_setting('hid.test.coded_verification_1')),
  'ok');
reset role;
select pg_temp.expect('B4e the reports to GH: the name-only v1 with the null pair, the coded v1 with its codes; both '
  || 'routes completed',
  'released:1:null|null|Sickle cell screen (as written) completed | released:1:http://loinc.org|718-7|Haemoglobin completed',
  pg_temp.reports(current_setting('hid.test.route')::uuid) || ' '
  || (select route.state from ehr.order_routes route where route.id = current_setting('hid.test.route')::uuid) || ' | '
  || pg_temp.reports(current_setting('hid.test.route_coded')::uuid) || ' '
  || (select route.state from ehr.order_routes route where route.id = current_setting('hid.test.route_coded')::uuid));
select set_config('hid.test.route_verification_2', pg_temp.lab_correction(current_setting('hid.test.result')::uuid,
  'route', 6.8, current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('B4f LB2 releases the correction v2', format($s$select pg_temp.release(%L, 2, %L,
  'n156-route-release-03')$s$, current_setting('hid.test.result'), current_setting('hid.test.route_verification_2')), 'ok');
reset role;
select pg_temp.expect('B4g ... reported with the null pair too',
  'released:1:null|null|Sickle cell screen (as written) released:2:null|null|Sickle cell screen (as written)',
  pg_temp.reports(current_setting('hid.test.route')::uuid));
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e5621000-0000-4000-8000-000000000001');
select pg_temp.expect('B4h GH''s page for the order (C3) gives both reports with the name and no codes',
  'released:1:{"code": null, "name": "Sickle cell screen (as written)", "codeSystem": null} '
  || 'released:2:{"code": null, "name": "Sickle cell screen (as written)", "codeSystem": null}',
  (select string_agg((item ->> 'kind') || ':' || (item ->> 'resultVersion') || ':' || (item -> 'test')::text, ' '
            order by (item ->> 'occurredAt'))
     from ehr.list_order_routes_for_order('lab_request', 'e5630000-0000-4000-8000-000000000001',
            current_setting('hid.test.lr_route')::uuid) listed, jsonb_array_elements(listed.reports) item));
select pg_temp.as_patient(1);
select pg_temp.expect('B4i the patient''s own list (C5) shows the name and no codes',
  '{"testCode": null, "testDisplay": "Sickle cell screen (as written)", "testCodeSystem": null} completed',
  (select jsonb_build_object('testCodeSystem', listed.content -> 'testCodeSystem', 'testCode', listed.content -> 'testCode',
            'testDisplay', listed.content -> 'testDisplay')::text || ' ' || listed.effective_state
     from ehr.patient_list_order_routes() listed where listed.route_id = current_setting('hid.test.route')::uuid));
reset role;

-- B5. The wrong person: LB1 reports the completed name-only route (0088, C25): v2 is invalidated (its report to GH by
-- 0086's invalidation trigger) and v1 reported directly with its released fields; both with the null pair.
select set_config('hid.test.route_version', (select route.row_version::text from ehr.order_routes route
                                              where route.id = current_setting('hid.test.route')::uuid), true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.expect('B5a LB1 reports the route as the wrong person''s', 'ended completed 1 2',
  (select reported.result || ' ' || reported.route_state || ' ' || reported.results_voided || ' '
          || reported.result_reports_marked
     from lab.report_wrong_patient_order_route(current_setting('hid.test.route')::uuid,
            current_setting('hid.test.route_version')::bigint, 'suspected_misuse',
            'The person used a Health ID card that was not theirs', 'n156-route-wrong-patient-0001',
            encode(sha256('n156-route-wrong-patient-0001'::bytea), 'hex')) reported));
reset role;
select pg_temp.expect('B5b the reports marked in error carry the null pair and the name',
  'released:1:null|null|Sickle cell screen (as written) released:2:null|null|Sickle cell screen (as written) '
  || 'entered_in_error:2:null|null|Sickle cell screen (as written) entered_in_error:1:null|null|Sickle cell screen (as written)',
  pg_temp.reports(current_setting('hid.test.route')::uuid));

-- B6. The late correction (0090, D17, C29) of another name-only route, completed and its window lapsed (owner SQL
-- moves its clock back 46 days, as the late correction suite does): v1 invalidated, reported with the null pair.
create function pg_temp.age_route(route uuid, by_interval interval) returns void language plpgsql as $f$
begin
  set local session_replication_role = replica;
  update ehr.order_routes set created_at = created_at - by_interval, respond_by = respond_by - by_interval,
    accepted_at = accepted_at - by_interval, completed_at = completed_at - by_interval,
    writes_end_at = writes_end_at - by_interval, access_ends_at = access_ends_at - by_interval
   where id = route;
  set local session_replication_role = origin;
end
$f$;
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_late', pg_temp.lab_request(1, 'active', null, null, 'Blood film for parasites (as written)')::text,
  true);
select set_config('hid.test.route_late', pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_late')::uuid,
  current_setting('hid.test.facility_1')::uuid, 'n156-route-send-0003')::text, true);
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select set_config('hid.test.item_late', (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.route_late')::uuid, 1, 'health_id', 'HID-N56PATP', 'n156-route-accept-0003', repeat('a', 64))
  accepted), true);
reset role;
select set_config('hid.test.result_late', pg_temp.lab_chain(current_setting('hid.test.item_late')::uuid, 'late',
  9.9)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('B6a LB1 releases its v1', format($s$select pg_temp.release(%L, 1, %L, 'n156-route-release-04')$s$,
  current_setting('hid.test.result_late'), current_setting('hid.test.late_verification_1')), 'ok');
reset role;
select pg_temp.age_route(current_setting('hid.test.route_late')::uuid, interval '46 days');
select set_config('hid.test.route_late_version', route.row_version::text, true),
       set_config('hid.test.route_late_day', (route.accepted_at at time zone 'Africa/Lagos')::date::text, true)
  from ehr.order_routes route where route.id = current_setting('hid.test.route_late')::uuid;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.expect('B6b LB1 corrects it late', 'corrected 1 1',
  (select corrected.result || ' ' || corrected.results_voided || ' ' || corrected.result_reports_marked
     from lab.correct_wrong_patient_order_route(current_setting('hid.test.route_late')::uuid,
            current_setting('hid.test.route_late_version')::bigint, 'suspected_misuse', 'ordering_facility',
            current_setting('hid.test.route_late_day')::date, 'Reported after the order had ended',
            'n156-route-late-correction-0001', encode(sha256('n156-route-late-correction-0001'::bytea), 'hex')) corrected));
reset role;
select pg_temp.expect('B6c the report marked in error carries the null pair and the name',
  'released:1:null|null|Blood film for parasites (as written) entered_in_error:1:null|null|Blood film for parasites (as written)',
  pg_temp.reports(current_setting('hid.test.route_late')::uuid));

-- B7. Each pair CHECK on its own (triggers off, as the suite runner, each change undone): half a pair is refused
-- wherever a lab test's or diagnosis's codes are kept, and a lab route still needs its name.
set local session_replication_role = replica;
select pg_temp.check('B7a ehr.lab_requests: half a pair', format($s$update ehr.lab_requests set test_code = '70569-9'
  where id = %L$s$, current_setting('hid.test.lr_own')),
  '23514 new row for relation "lab_requests" violates check constraint "lab_requests_test_code_pair_ck"');
select pg_temp.check('B7b ehr.diagnoses: half a pair', format($s$update ehr.diagnoses set code_system = 'ICD-11'
  where id = %L$s$, current_setting('hid.test.dx_name')),
  '23514 new row for relation "diagnoses" violates check constraint "diagnoses_code_pair_ck"');
select pg_temp.check('B7c ehr.order_routes: half a pair on a lab route', format($s$update ehr.order_routes
  set test_code = '718-7' where id = %L$s$, current_setting('hid.test.route')),
  '23514 new row for relation "order_routes" violates check constraint "order_routes_kind_ck"');
select pg_temp.check('B7d ehr.order_routes: a lab route without its name', format($s$update ehr.order_routes
  set test_display = null where id = %L$s$, current_setting('hid.test.route_coded')),
  '23514 new row for relation "order_routes" violates check constraint "order_routes_kind_ck"');
select pg_temp.check('B7e lab.work_items: half a pair', format($s$update lab.work_items set test_code_system = 'http://loinc.org'
  where id = %L$s$, current_setting('hid.test.item')),
  '23514 new row for relation "work_items" violates check constraint "work_items_test_code_pair_ck"');
select pg_temp.check('B7f lab.work_item_requested_tests: half a pair', format($s$update lab.work_item_requested_tests
  set code = '718-7' where work_item_id = %L$s$, current_setting('hid.test.item')),
  '23514 new row for relation "work_item_requested_tests" violates check constraint "work_item_requested_tests_code_pair_ck"');
select pg_temp.check('B7g lab.order_route_result_reports: half a pair', format($s$update lab.order_route_result_reports
  set test_code_system = 'http://loinc.org' where route_id = %L$s$, current_setting('hid.test.route')),
  '23514 new row for relation "order_route_result_reports" violates check constraint "order_route_result_reports_test_code_pair_ck"');
set local session_replication_role = origin;
select pg_temp.expect('B7h the coded order''s rows keep their codes at every step (request, route, work item, test, report)',
  'http://loinc.org|718-7|Haemoglobin http://loinc.org|718-7|Haemoglobin http://loinc.org|718-7|Haemoglobin '
  || 'http://loinc.org|718-7|Haemoglobin released:1:http://loinc.org|718-7|Haemoglobin',
  (select pg_temp.pair(request.test_code_system, request.test_code, request.test_display) || ' '
          || pg_temp.pair(route.test_code_system, route.test_code, route.test_display) || ' '
          || pg_temp.pair(item.test_code_system, item.test_code, item.test_name) || ' '
          || pg_temp.pair(test.code_system, test.code, test.name) || ' ' || pg_temp.reports(route.id)
     from ehr.order_routes route join ehr.lab_requests request on request.id = route.source_lab_request_id
     join lab.work_items item on item.order_route_id = route.id
     join lab.work_item_requested_tests test on test.work_item_id = item.id
    where route.id = current_setting('hid.test.route_coded')::uuid));

-- B8. The undo is for before any name-only row: with one saved, step a's VALIDATE of the NOT NULL CHECK fails on each
-- of the five tables (23514), and nothing changes (as the tables' owner).
savepoint undo_after_use;
set local role :"q156_owner";
alter table ehr.lab_requests add constraint lab_requests_test_code_undo_nn check (test_code is not null) not valid;
alter table ehr.diagnoses add constraint diagnoses_code_undo_nn check (code is not null) not valid;
alter table lab.work_items add constraint work_items_test_code_undo_nn check (test_code is not null) not valid;
alter table lab.work_item_requested_tests add constraint work_item_requested_tests_code_undo_nn
  check (code is not null) not valid;
alter table lab.order_route_result_reports add constraint order_route_result_reports_test_code_undo_nn
  check (test_code is not null) not valid;
select pg_temp.expect('B8 the undo refuses once a name-only row is saved',
  '23514 check constraint "lab_requests_test_code_undo_nn" of relation "lab_requests" is violated by some row|'
  || '23514 check constraint "diagnoses_code_undo_nn" of relation "diagnoses" is violated by some row|'
  || '23514 check constraint "work_items_test_code_undo_nn" of relation "work_items" is violated by some row|'
  || '23514 check constraint "work_item_requested_tests_code_undo_nn" of relation "work_item_requested_tests" is violated by some row|'
  || '23514 check constraint "order_route_result_reports_test_code_undo_nn" of relation "order_route_result_reports" is violated by some row',
  pg_temp.outcome('alter table ehr.lab_requests validate constraint lab_requests_test_code_undo_nn') || '|'
  || pg_temp.outcome('alter table ehr.diagnoses validate constraint diagnoses_code_undo_nn') || '|'
  || pg_temp.outcome('alter table lab.work_items validate constraint work_items_test_code_undo_nn') || '|'
  || pg_temp.outcome('alter table lab.work_item_requested_tests validate constraint work_item_requested_tests_code_undo_nn')
  || '|' || pg_temp.outcome('alter table lab.order_route_result_reports validate constraint '
                            || 'order_route_result_reports_test_code_undo_nn'));
reset role;
rollback to savepoint undo_after_use;

do $$
begin
  raise notice '0156 name-only codes suite: % cases passed', currval('pg_temp.name_only_passed');
end $$;
rollback;
