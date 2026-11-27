-- 0156 Lab tests and diagnoses by name only (ORD-7 F3 and ORD-9 of the Akos
-- EHR plan, lane D). The clinical owner's design note on hid-system#258
-- (Ola, 26 November 2026, 12:34 UTC, comment 7192389223), which folds in
-- Rahman's reviews 7167521757 and 7167526411; the planned contract's
-- "Lab requests by name only (F3)", "Diagnoses by name only, and ICD-11
-- codes" and "Across an ICD-11 release switch" (#321's codeStatus booking).
-- The number is a booking, given in release order at integration; no
-- migration number appears inside a function body or a CHECK, so
-- renumbering leaves every md5. This file requires 0152's and 0153's
-- objects (0001-0153 applied); it does not need 0154 or 0155. It is
-- released alone, never with another file (Rahman's answer 1). The
-- declaration is signed separately.
--
-- THE GAP. A lab test or a diagnosis must have a code and a code system
-- today (0004:180-181, 0004:242-243). A test or diagnosis the lists do not
-- hold cannot be ordered or recorded by its name alone.
--
-- WHAT IT DOES
-- N1 Six live tables carry a lab test's or diagnosis's code pair. A pair may
--    now be left empty (both codes or neither); the name stays required:
--    - ehr.lab_requests (test_code_system, test_code; 0004:242-243),
--    - ehr.diagnoses (code_system, code; 0004:180-181),
--    - lab.work_items (test_code_system, test_code; 0018:27-28),
--    - lab.work_item_requested_tests (code_system, code; 0018:62-63),
--    - lab.order_route_result_reports (test_code_system, test_code;
--      0086:6553-6554):
--    NOT NULL is dropped from these ten columns, and each table gets a pair
--    CHECK, ((system is null) = (code is null)):
--    lab_requests_test_code_pair_ck, diagnoses_code_pair_ck,
--    work_items_test_code_pair_ck, work_item_requested_tests_code_pair_ck
--    and order_route_result_reports_test_code_pair_ck. Each is added NOT
--    VALID and then validated here (Rahman's answer 4). The existing length
--    CHECKs stay; they let a null through.
--    - ehr.order_routes: its pair is nullable already (0086:6316-6317).
--      order_routes_kind_ck (0086:6377-6390) is replaced: a lab request
--      route still needs its name (test_display), and its codes are both
--      or neither; every other term is 0086's.
--    The name columns stay NOT NULL (test_display, display, test_name,
--    name), so a row always says what was ordered or recorded. Every
--    existing row has both codes, so no CHECK fails.
-- N2 ehr.catalog_diagnosis_listed(requested_code_system text,
--    requested_code text): for ehr-api's codeStatus (Rahman's answer 8; no
--    runtime may read ehr.catalog_diagnoses, 0152:257). The note writes the
--    parameters as (code_system, code); they take the requested_ prefix of
--    0152's and 0153's functions, so neither shares a column's name. ehr-api
--    calls it by position; a caller using named notation (0180, say) uses
--    these names. It answers only for the code system
--    'ICD-11': true when the code is in the active ICD-11 release, false
--    when it is not. It answers null while no release is active and for any
--    other code system or a null code (codeStatus not_checked). A
--    post-coordinated code (with & or /) is checked on its first code, the
--    text before the first & or /, spaces trimmed (the contract's rule for
--    codeStatus), whether ehr-api passes the whole code or its first code.
--    SECURITY DEFINER, STABLE, plpgsql, search_path pg_catalog, pg_temp.
--    EXECUTE to hid_ehr_runtime and hid_schema_test_runtime (here and in
--    runtime-grants.sql). 0180 (ORD-8) can wrap it later.
-- N3 ehr.recent_diagnoses(limit) (0153) is replaced, with the same columns,
--    so CREATE OR REPLACE keeps its owner and grants (Rahman's point 4; the
--    contract's booking). Production has no active release (0152 loads
--    none) and the blue form fills 'ICD-10', so an inner join would return
--    nothing. So:
--    - while no diagnosis release is active, every pick comes back as stored,
--      as today;
--    - while one is active, a pick whose code system is 'ICD-11' is looked
--      up in that release through its key (version_id, code): a plain code
--      comes back with the release's current title, and a code the release
--      does not hold (dropped, or never in it) is left out;
--    - a post-coordinated ICD-11 pick (with & or /) is matched on its first
--      code, as codeStatus is, and keeps its stored display: the list holds
--      stem codes only (0152:246), and the release's title names only the
--      first code;
--    - every other pick (ICD-10 or any other system) comes back as stored;
--    - the limit applies after picks are left out.
--    It restates SECURITY DEFINER, search_path and STABLE (without STABLE,
--    CREATE OR REPLACE makes it volatile), and the post-check reads
--    provolatile, as 0152 does. It ships before any second ICD-11 release
--    is loaded.
-- No other function changes. Those that copy, compare or read the code
-- pairs, or run as triggers on the six tables, are pinned by md5 (all
-- compare with IS DISTINCT FROM or copy the value as it is, so a null pair
-- passes through them; the pins are for completeness):
--    the validators lab.validate_work_item() (0086:9352),
--    lab.validate_work_item_child() (0073:49-66) and
--    ehr.guard_order_route_mutation() (0086:9542); the copiers
--    ehr.send_order_route (0133:2337), ehr.accept_receiving_order_route
--    (0086:8303), lab.return_order_route_result() (0090:1023),
--    lab.return_order_route_invalidation() (0086:9888),
--    ehr.correct_wrong_patient_order_route (0090:1156),
--    ehr.report_wrong_patient_order_route (0088:641) and
--    ehr.patient_list_order_routes() (0090:1921); the readers
--    ehr.list_order_routes_for_order (0086:7726),
--    ehr.list_receiving_order_routes (0086:8063),
--    ehr.get_receiving_order_route (0086:8174), lab.list_order_routes
--    (0086:8835) and lab.get_order_route (0086:8853); the trigger functions
--    on the six tables, ehr.capture_record_version() (0112:718),
--    ehr.sync_order_routes_on_order_change() (0086:9683),
--    ehr.require_order_route_first_event() (0086:9651),
--    lab.reject_immutable_evidence() (0017:168),
--    identity.list_own_work_patient() (0133:1175) and
--    platform.reject_mutation() (0001:110); ehr.record_recent_diagnosis
--    (0153), which records nothing for a null code (0153:128-134); and
--    auth.membership_has_permission, which the new read still calls. If
--    another lane replaces one of these before this file ships, the pin
--    moves to that lane's md5 at integration. No trigger set is pinned, so
--    Billing's trigger on lab.work_items (0167) does not make this file
--    refuse; it skips a null pair.
-- 0159 (ORD-11, order notices; #345) ships before this file, but is not
-- on staging 0cfddcc9, so this branch cannot test with it. At #345's
-- 5857690e (0159 unchanged since b99011fd) its triggers are on
-- lab.result_releases, lab.result_invalidations, pharmacy.dispensings and
-- pharmacy.dispensing_reversals, and its functions read ehr.lab_requests,
-- ehr.order_routes, lab.work_items, lab.work_item_requested_tests and
-- lab.order_route_result_reports by id, and the request's test_display,
-- but no code column. So nothing of 0159 is pinned here. Owed at
-- integration on 0159: a name-only-codes case that releases a name-only
-- result and finds no row in ehr.order_notice_gaps (gaps = 0), and a
-- fresh look at 0159's functions for a code column, pinning any that
-- reads one.
--
-- SERVICE SETTINGS. Nothing changes for a service until it sends a null
-- pair. ehr-api takes a lab request by name only while
-- LAB_REQUEST_NAME_ONLY_ENABLED is true, and a diagnosis by name only while
-- DIAGNOSIS_NAME_ONLY_ENABLED is true. Both stay off when this file ships.
-- LAB_REQUEST_NAME_ONLY_ENABLED stays off until 0155's sensitive-test list
-- build is live (it ships in 0155's images). The release: this file alone,
-- then ehr-api and lab-api with both settings off, then the website, then
-- the settings on.
--
-- ONE WAY ONCE USED. The first time either setting goes on in production
-- is recorded (the time, on hid-system#258 and in the next declaration).
-- After it, lab-api cannot roll back below this file's image: the old
-- AcceptEhrOrderDto refuses a null pair (accept-ehr-order.dto.ts:15-16).
-- Old ehr-api and the old website read nulls safely (Rahman's check). The
-- fallback is to turn the settings off; rows saved by name only stay.
--
-- Old services on this schema: they write both codes, as the pair CHECKs
-- allow, and read the same columns. The recent read keeps its columns.
-- Nothing calls N2 before the new ehr-api.
--
-- Locks. Section 1, one DO block: one LOCK TABLE ... ACCESS EXCLUSIVE
-- NOWAIT statement on all six tables (0145:270-271), which ALTER TABLE
-- needs. A busy table fails the attempt at once, and the attempt gives back
-- what it took; it is made again every 100 ms for at most 5 seconds (50
-- attempts), then 55P03 "0156: ... stayed busy for 5 seconds; nothing
-- applied; run the release again at a quieter time". When this transaction
-- already holds an earlier migration's locks that stop other sessions
-- (the runner's dry run of several files), one attempt and no sleep: 55P03
-- "0156: ... so it does not wait; nothing applied; ..." at once. Both are
-- the runner's busy refusal, so a dry run rolls back and tries again
-- (dry-run-attempts.mjs). No catalogue list is locked: N2 and N3 are
-- plpgsql with no %ROWTYPE or %TYPE, so creating them opens no table. The
-- preconditions read the catalog only and take no table lock.
-- What waits while the locks are held, from section 1 to commit: every read
-- and write of the six tables, whatever the statement, and every read whose
-- row-level security policy joins one of them. After Release E, 35 policies
-- on 16 lab tables join lab.work_items, so nearly all lab-api work waits:
-- result entry, verification and release included (Rahman's 7167493074,
-- item 3). Such a read by a superuser or BYPASSRLS role does not wait (no
-- policy runs); the services' runtime roles do. Writes to the ten tables
-- whose foreign keys point at the six wait too: the key check locks the
-- row it points at FOR KEY SHARE, which takes ROW SHARE on that table
-- (measured: a ROW SHARE request on ehr.order_routes waited):
-- ehr.order_route_events,
-- ehr.order_route_accept_attempts, ehr.order_route_unable_endings,
-- ehr.order_route_wrong_patient_reports, pharmacy.work_items and
-- pharmacy.order_route_dispensing_reports (to ehr.order_routes);
-- lab.accessions, lab.accession_events and lab.work_item_events (to
-- lab.work_items); lab.test_executions (to lab.work_item_requested_tests).
-- They wait; none fails unless its own lock_timeout or statement_timeout
-- is shorter than the hold. In the dry run the locks last until the dry
-- run ends; this file goes alone, so that hold is its own.
--
-- THE SIZE BOUND (Rahman's answer 4). Each VALIDATE scans its table under
-- ACCESS EXCLUSIVE (the house pattern of 0122, 0125, 0144 and 0154; Rahman
-- measured 26-35 ms per 200,000 rows). Section 2 refuses (55000, nothing
-- applied) when any of the six has pg_class.reltuples above 5,000,000, or
-- -1 (never analysed) while its heap has a page. A table with no page on
-- disk holds no row, so a fresh install, whose six tables are empty and
-- never analysed, goes on. It is read under the locks, so no ANALYZE,
-- VACUUM or write can change it before the scans, and pg_relation_size
-- waits for nothing. Above the bound, or for a measured hold over 1 s, the
-- change is NOT VALID here and a follow-up file validates it.
-- The bound is per table and counts live rows; VALIDATE's time follows the
-- heap's pages, dead rows included, and the six scans and the route check
-- add up in one hold. So the file lets through six tables just under
-- 5,000,000 rows each, about 4-5 s at Rahman's figure. The file does not
-- check the 1 s rule: the pre-sign measurement on the rehearsal copy does,
-- and the declaration records the hold.
-- The note says -1 refuses; here -1 refuses only while the table has a
-- page on disk, so that a fresh install goes on (the contract lists this
-- among its differences).
-- ANALYZE FIRST. Autovacuum may never have analysed a small table (the
-- routed result reports, say: it analyses after about 50 changes), which
-- leaves reltuples at -1, and section 2 then refuses. ANALYZE samples pages
-- without the policies and takes SHARE UPDATE EXCLUSIVE, which no read or
-- write waits for. The deploy tool runs only the runner's plan, dry run and
-- apply tasks (scripts/production_deployment.py, no shell in the task), so
-- this is a step by hand, in the release runbook (docs/MIGRATION_RUNBOOK.md,
-- "Before 0156"):
-- - where: every environment whose six tables hold rows (production and
--   staging);
-- - who: the release operator, connected as the role that owns the six
--   tables (the migration role) or as the database owner; on PostgreSQL 16
--   only they or a superuser may ANALYZE them;
-- - what: ANALYZE ehr.lab_requests, ehr.diagnoses, ehr.order_routes,
--   lab.work_items, lab.work_item_requested_tests,
--   lab.order_route_result_reports; then each table's reltuples, relpages
--   and pg_relation_size from pg_class;
-- - when: finished before the deploy is dispatched;
-- - recorded: the time and those figures in the schema declaration's
--   evidence. The builder cannot reach production, so production's sizes
--   come from there, and the hold from the rehearsal copy at pre-sign.
-- An ANALYZE or autovacuum still running on any of the six holds SHARE
-- UPDATE EXCLUSIVE, which section 1's NOWAIT cannot pass, and a NOWAIT
-- request never cancels an autovacuum: the file stops after 5 seconds with
-- the busy refusal, nothing applied (measured: behind an open ANALYZE of
-- lab.work_items, 5.0 s). The dry run tries again, up to 20 times in 5
-- minutes; the apply does not, so the release stops and is run again.
--
-- NO ROWS READ AS THE MIGRATOR (Rahman's point 3). All six tables force row
-- security; as a NOSUPERUSER NOBYPASSRLS owner, a count(*) runs the
-- policies on every row (about 0.65 ms a row in Rahman's test). So this
-- file has no DML and no query on the six tables' rows. Sizes come from
-- pg_class (above). VALIDATE reads the heap without the policies. The
-- post-check reads pg_stat_xact_user_tables: no row inserted, updated or
-- deleted in the six tables while this file ran. That view counts the
-- whole transaction, so section 0 keeps the counts it finds (an earlier
-- file's writes, in a dry run of several files) in a setting for this
-- transaction only (hid.m0156_writes), and section 9 compares with them.
-- The size bound has no such baseline: in a fresh install, where each
-- file's tables are new, a table that an earlier file wrote rows to is
-- never analysed and has a page, so section 2 refuses (55000). No file
-- 0001-0153 writes the six at migration time; if a file booked before 0156
-- does, it must end with ANALYZE of the table it wrote (that works inside
-- the dry run's one transaction: measured, -1 became the row count), or
-- 0156 refuses in every fresh install, the CI rehearsal and check:db
-- included.
--
-- Undo (by hand only, owner-signed, and only before any name-only row is
-- saved):
-- First both settings go off (LAB_REQUEST_NAME_ONLY_ENABLED and
-- DIAGNOSIS_NAME_ONLY_ENABLED false, ehr-api restarted). The catalogue
-- status reports them from the settings alone, so with one still on over a
-- schema without 0156 the website offers "Use as written" and the save
-- fails on NOT NULL (23502, which ehr-api answers as a 500).
-- a. Before the main transaction, for each of the ten columns: add CHECK
--    (col IS NOT NULL) NOT VALID and commit (ACCESS EXCLUSIVE, briefly:
--    NOWAIT, as section 1); and on ehr.order_routes add 0086's kind check
--    (0086:6377-6390) as it was, under a temporary name
--    (order_routes_kind_0086_ck), NOT VALID, the same way. Then VALIDATE
--    each in its own transaction, with lock_timeout 5s (SHARE UPDATE
--    EXCLUSIVE: reads and writes go on; one queued behind an autovacuum
--    blocks no read or write while it waits). In the same transaction as
--    the ADD, the scan would run under the ADD's ACCESS EXCLUSIVE.
-- b. The main transaction: section 1's NOWAIT step on the six tables, with
--    both refusals; SET NOT NULL on the ten columns (each skips its scan, as
--    a validated CHECK proves it) and drop the ten CHECKs of step a; drop
--    the five pair CHECKs; drop this file's order_routes_kind_ck and RENAME
--    CONSTRAINT order_routes_kind_0086_ck TO order_routes_kind_ck (catalog
--    only, so no route is scanned under the six locks); put back 0153's
--    ehr.recent_diagnoses (md5 48c0dbad4f4d53fa6fbc6a1e5e0a35ac, STABLE,
--    SECURITY DEFINER and its search_path restated) and 0153's comment on
--    it; drop ehr.catalog_diagnosis_listed and remove its lines from
--    runtime-grants.sql in the same release.
-- The ledger row stays. Measured with the 20,000-row data below, as the
-- NOSUPERUSER NOBYPASSRLS owner: step a's eleven VALIDATEs each held SHARE
-- UPDATE EXCLUSIVE only (the kind check's 11.6 ms); in step b, after the
-- locks, every SET NOT NULL skipped its scan (0.5-0.9 ms each), the kind
-- check's drop and rename took 0.6 ms (putting it back with ADD CONSTRAINT
-- scanned the 20,000 routes for 42.7 ms in review), and all of step b's
-- statements about 7 ms. The six tables, their constraints, both functions,
-- their grants and comments then matched 0001-0153's exactly.
--
-- Measured on throwaway PostgreSQL 16 with 0001-0153 applied and about
-- 20,000 rows of fictional data in each of the six tables, analysed; ten
-- runs with a superuser applier and ten with a NOSUPERUSER NOBYPASSRLS
-- applier that owns the tables:
-- - the hold, from section 1 to the end of COMMIT: 34-44 ms (median 39.1)
--   and 37-52 ms (median 40.1); the whole file 47-70 ms;
-- - in one run with each applier: section 0, before any lock, 14-22 ms;
--   the lock 1.2-1.4 ms; the size bound 0.9-1.0 ms; each pair's VALIDATE
--   2.0-8.4 ms and the route check's 8.7 ms (one scan of 20,000 rows
--   each); the two functions, their grants and comments 2.1-2.4 ms; the
--   post-checks 8.1-8.4 ms;
-- - pg_locks before commit: ACCESS EXCLUSIVE (and VALIDATE's SHARE UPDATE
--   EXCLUSIVE) on the six tables, and no other relation;
-- - pg_stat_xact_user_tables before commit: no row inserted, updated or
--   deleted in the six; one sequential scan of 20,000 rows in each
--   (VALIDATE);
-- - for comparison, a count(*) as the NOSUPERUSER NOBYPASSRLS owner took
--   14.8-20.2 s on ehr.lab_requests, ehr.diagnoses, lab.work_items and
--   lab.work_item_requested_tests and returned 0 (0.74-1.01 ms a row); on
--   ehr.order_routes and lab.order_route_result_reports, whose policies let
--   the owner read, it returned every row in 17 ms and 2.5 ms. So the file
--   runs no policy per row;
-- - behind an open read of any one of the six tables, the file stops after
--   4.99-5.02 s with section 1's 55P03, nothing applied (both appliers);
--   with an earlier migration's lock held in the same transaction it stops
--   at once (25-32 ms) with the one-attempt text; the runner's dry run
--   retries it.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied), and
--    the six tables' write counts so far, for section 9.
-- 1. The locks.             2. The size bound (under the locks).
-- 3. The five pairs (N1).   4. The route's kind check (N1).
-- 5. N2.                    6. N3.
-- 7. Grants (here and in runtime-grants.sql).
-- 8. Comments.              9. Post-checks (55000).

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  -- a. 0152's and 0153's objects.
  if to_regclass('ehr.catalog_versions') is null or to_regclass('ehr.catalog_diagnoses') is null
     or to_regclass('ehr.clinician_recent_diagnoses') is null
     or to_regprocedure('ehr.recent_diagnoses(integer)') is null then
    raise exception using errcode = '55000', message = '0156: 0001-0153 (0152 and 0153) must be applied first';
  end if;
  -- b. Already applied: every pair, the route's kind check and both functions as this file leaves them.
  if (select count(*) from pg_attribute attribute_row
       where not attribute_row.attisdropped and not attribute_row.attnotnull
         and (attribute_row.attrelid, attribute_row.attname) in (
               ('ehr.lab_requests'::regclass, 'test_code_system'), ('ehr.lab_requests'::regclass, 'test_code'),
               ('ehr.diagnoses'::regclass, 'code_system'), ('ehr.diagnoses'::regclass, 'code'),
               ('lab.work_items'::regclass, 'test_code_system'), ('lab.work_items'::regclass, 'test_code'),
               ('lab.work_item_requested_tests'::regclass, 'code_system'),
               ('lab.work_item_requested_tests'::regclass, 'code'),
               ('lab.order_route_result_reports'::regclass, 'test_code_system'),
               ('lab.order_route_result_reports'::regclass, 'test_code'))) = 10
     and (select count(*) from pg_constraint constraint_row
           where constraint_row.convalidated
             and (constraint_row.conrelid, constraint_row.conname, md5(pg_get_constraintdef(constraint_row.oid))) in (
                   ('ehr.lab_requests'::regclass, 'lab_requests_test_code_pair_ck', md5('CHECK (((test_code_system IS NULL) = (test_code IS NULL)))')),
                   ('ehr.diagnoses'::regclass, 'diagnoses_code_pair_ck', md5('CHECK (((code_system IS NULL) = (code IS NULL)))')),
                   ('lab.work_items'::regclass, 'work_items_test_code_pair_ck', md5('CHECK (((test_code_system IS NULL) = (test_code IS NULL)))')),
                   ('lab.work_item_requested_tests'::regclass, 'work_item_requested_tests_code_pair_ck',
                    md5('CHECK (((code_system IS NULL) = (code IS NULL)))')),
                   ('lab.order_route_result_reports'::regclass, 'order_route_result_reports_test_code_pair_ck',
                    md5('CHECK (((test_code_system IS NULL) = (test_code IS NULL)))')),
                   ('ehr.order_routes'::regclass, 'order_routes_kind_ck', 'da75b1703689457cdb6b35053a48af52'))) = 6
     and (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure('ehr.recent_diagnoses(integer)'))
         = '034774a650aacf33a366e186d15cd5d7'
     and (select md5(proc.prosrc) from pg_proc proc
           where proc.oid = to_regprocedure('ehr.catalog_diagnosis_listed(text,text)')) = '28048d5d87de33e9f03e71a93024d214' then
    raise exception using errcode = '55000', message = '0156: already applied';
  end if;
  -- c. The code columns as 0001-0153 left them: text; NOT NULL but on ehr.order_routes, whose pair is nullable.
  -- Only these columns and their constraints are read, so other lanes' additions to the six tables pass.
  select string_agg(expected.table_name || '.' || expected.column_name, ', ') into mismatch
    from (values
      ('ehr.lab_requests', 'test_code_system', true), ('ehr.lab_requests', 'test_code', true),
      ('ehr.lab_requests', 'test_display', true),
      ('ehr.diagnoses', 'code_system', true), ('ehr.diagnoses', 'code', true), ('ehr.diagnoses', 'display', true),
      ('lab.work_items', 'test_code_system', true), ('lab.work_items', 'test_code', true),
      ('lab.work_items', 'test_name', true),
      ('lab.work_item_requested_tests', 'code_system', true), ('lab.work_item_requested_tests', 'code', true),
      ('lab.work_item_requested_tests', 'name', true),
      ('lab.order_route_result_reports', 'test_code_system', true),
      ('lab.order_route_result_reports', 'test_code', true), ('lab.order_route_result_reports', 'test_name', true),
      ('ehr.order_routes', 'test_code_system', false), ('ehr.order_routes', 'test_code', false),
      ('ehr.order_routes', 'test_display', false)) expected(table_name, column_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = to_regclass(expected.table_name)
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and attribute_row.atttypid = 'text'::regtype
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0156: these columns are not as 0001-0153 left them: ' || mismatch;
  end if;
  -- d. The constraints on the twelve code columns, exactly: the length CHECKs and 0086's route kind check, by
  -- their printed definitions (the kind check by md5). None of this file's names exists.
  select string_agg(coalesce(found.conname, expected.conname), ', ') into mismatch
    from (select constraint_row.conrelid, constraint_row.conname, constraint_row.contype,
                 md5(pg_get_constraintdef(constraint_row.oid)) as definition_md5
            from pg_constraint constraint_row
           where constraint_row.conrelid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass,
                   'ehr.order_routes'::regclass, 'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
                   'lab.order_route_result_reports'::regclass)
             and exists (select 1 from pg_attribute attribute_row
                          where attribute_row.attrelid = constraint_row.conrelid
                            and attribute_row.attnum = any(constraint_row.conkey)
                            and attribute_row.attname in ('test_code_system', 'test_code', 'code_system', 'code'))) found
    full join (values
      ('ehr.lab_requests'::regclass, 'lab_requests_test_code_system_check', md5('CHECK (((length(test_code_system) >= 1) AND (length(test_code_system) <= 255)))')),
      ('ehr.lab_requests'::regclass, 'lab_requests_test_code_check', md5('CHECK (((length(test_code) >= 1) AND (length(test_code) <= 100)))')),
      ('ehr.diagnoses'::regclass, 'diagnoses_code_system_check', md5('CHECK (((length(code_system) >= 1) AND (length(code_system) <= 255)))')),
      ('ehr.diagnoses'::regclass, 'diagnoses_code_check', md5('CHECK (((length(code) >= 1) AND (length(code) <= 100)))')),
      ('lab.work_items'::regclass, 'work_items_test_code_system_check', md5('CHECK (((length(btrim(test_code_system)) >= 1) AND (length(btrim(test_code_system)) <= 255)))')),
      ('lab.work_items'::regclass, 'work_items_test_code_check', md5('CHECK (((length(btrim(test_code)) >= 1) AND (length(btrim(test_code)) <= 100)))')),
      ('lab.work_item_requested_tests'::regclass, 'work_item_requested_tests_code_system_check', md5('CHECK (((length(btrim(code_system)) >= 1) AND (length(btrim(code_system)) <= 255)))')),
      ('lab.work_item_requested_tests'::regclass, 'work_item_requested_tests_code_check', md5('CHECK (((length(btrim(code)) >= 1) AND (length(btrim(code)) <= 100)))')),
      ('ehr.order_routes'::regclass, 'order_routes_test_code_system_check', md5('CHECK (((test_code_system IS NULL) OR ((length(test_code_system) >= 1) AND (length(test_code_system) <= 255))))')),
      ('ehr.order_routes'::regclass, 'order_routes_test_code_check', md5('CHECK (((test_code IS NULL) OR ((length(test_code) >= 1) AND (length(test_code) <= 100))))')),
      ('ehr.order_routes'::regclass, 'order_routes_kind_ck', 'e26083a62f5b32553520f82676fca2aa')
    ) expected(conrelid, conname, definition_md5)
      on expected.conrelid = found.conrelid and expected.conname = found.conname
         and expected.definition_md5 = found.definition_md5 and found.contype = 'c'
   where found.conname is null or expected.conname is null;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = '0156: the constraints on the code columns are not as 0001-0153 left them: ' || mismatch;
  end if;
  if exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'ehr' and proc.proname = 'catalog_diagnosis_listed') then
    raise exception using errcode = '55000', message = '0156: a function ehr.catalog_diagnosis_listed already exists';
  end if;
  -- e. The columns N2 and N3 read in 0149's and 0152's tables.
  select string_agg(expected.table_name || '.' || expected.column_name, ', ') into mismatch
    from (values ('ehr.catalog_versions', 'id', 'uuid'), ('ehr.catalog_versions', 'kind', 'text'),
                 ('ehr.catalog_versions', 'active', 'boolean'), ('ehr.catalog_diagnoses', 'version_id', 'uuid'),
                 ('ehr.catalog_diagnoses', 'code', 'text'), ('ehr.catalog_diagnoses', 'title', 'text'))
         expected(table_name, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = to_regclass(expected.table_name)
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0156: these catalogue columns are not as 0149 and 0152 made them: ' || mismatch;
  end if;
  -- f. The pins: 0153's read (replaced here), and every function this file calls or relies on (see the header).
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      -- 0153's read, replaced in section 6.
      ('ehr.recent_diagnoses(integer)', '48c0dbad4f4d53fa6fbc6a1e5e0a35ac'),
      -- The validators.
      ('lab.validate_work_item()', 'efac15072e0a6e68dff199026ff6f73e'),
      ('lab.validate_work_item_child()', '9bc011f7583332dd3de12ce2a8e45753'),
      ('ehr.guard_order_route_mutation()', '6a01bc885cd54f87a1bee8c0ebc100a4'),
      -- The functions that copy the codes.
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', 'fef3bfda1239e5cd72a149f8db30ff64'),
      ('ehr.accept_receiving_order_route(text,uuid,bigint,text,text,text,text,character,text)', '1d4a77de6316fa95a539d8151c8604df'),
      ('lab.return_order_route_result()', '10f7b7726a59488cd6ae6f9e55c4c568'),
      ('lab.return_order_route_invalidation()', '2176bfd64b05c6e357021c178060f1b7'),
      ('ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)', '6e903c30ec5c1c6c6949a4d16ea65dbe'),
      ('ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,character)', 'ef39eba74338f1414787ade116e3bc6b'),
      ('ehr.patient_list_order_routes()', '4dee7f9f41fc9c51e7364452a2968b73'),
      -- The five readers.
      ('ehr.list_order_routes_for_order(text,uuid,uuid)', 'cb6c138fbbffa1e1f226cde0aac1ec0b'),
      ('ehr.list_receiving_order_routes(text,text,text)', 'd48eed974035d514ab8aeafae31f4c39'),
      ('ehr.get_receiving_order_route(text,uuid)', 'ec84596219cef718917cd7f51f877952'),
      ('lab.list_order_routes(text,text)', '317d2f46f637b71b02258445b22fcb6c'),
      ('lab.get_order_route(uuid)', '0e87412493573e49e09f078254044748'),
      -- The trigger functions on the six tables.
      ('ehr.capture_record_version()', 'cae99883d00e70ab1d20ed6fbc97ad7b'),
      ('ehr.sync_order_routes_on_order_change()', '8ce6b42450cc06fc02fec8d1cf63af41'),
      ('ehr.require_order_route_first_event()', 'ae41186236e61c14f252bfa38a008e6a'),
      ('lab.reject_immutable_evidence()', '96897909ea027a8f17ebf63f4af0a0ac'),
      ('identity.list_own_work_patient()', '4a5d85a1c4d6f22c1f289c0dba7ed143'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      -- The recent record (nothing for a null code), and the permission check the read calls.
      ('ehr.record_recent_diagnosis(text,text,text)', 'e93826baac0c57bc21358916038c5567'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0156: these functions are not as 0001-0153 left them: ' || mismatch;
  end if;
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'ehr.recent_diagnoses(integer)'::regprocedure and proc.prosecdef
                    and proc.provolatile = 's'
                    and proc.proowner = (select relation.relowner from pg_class relation
                                          where relation.oid = 'ehr.catalog_versions'::regclass)
                    and proc.proconfig = array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000', message = '0156: 0153''s ehr.recent_diagnoses is not as 0153 made it';
  end if;
  -- g. The six tables' writes so far in this transaction (an earlier file's, in a dry run of several files), kept
  -- for this transaction only, so that section 9 counts only what is written while this file runs.
  perform set_config('hid.m0156_writes',
    (select jsonb_object_agg(statistics.relid::text,
                             statistics.n_tup_ins + statistics.n_tup_upd + statistics.n_tup_del)::text
       from pg_stat_xact_user_tables statistics
      where statistics.relid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass, 'ehr.order_routes'::regclass,
                                 'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
                                 'lab.order_route_result_reports'::regclass)), true);
end
$$;

-- 1. The locks (NOWAIT, at most 5 seconds; one attempt when this
-- transaction already holds an earlier migration's locks).
do $locks$
declare
  attempt integer := 0;
  holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.lab_requests, ehr.diagnoses, ehr.order_routes, lab.work_items, lab.work_item_requested_tests,
        lab.order_route_result_reports in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      -- Both endings are the runner's busy refusal (dry-run-attempts.mjs), so a dry run tries again.
      if holding then
        raise exception using errcode = '55P03',
          message = '0156: ehr.lab_requests, ehr.diagnoses, ehr.order_routes, lab.work_items, '
            || 'lab.work_item_requested_tests or lab.order_route_result_reports is busy, and this transaction '
            || 'already holds an earlier migration''s locks, so it does not wait; nothing applied; run the release '
            || 'again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0156: ehr.lab_requests, ehr.diagnoses, ehr.order_routes, lab.work_items, '
            || 'lab.work_item_requested_tests or lab.order_route_result_reports stayed busy for 5 seconds; nothing '
            || 'applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 2. The size bound, read under the locks: reltuples above 5,000,000, or -1
-- (never analysed) while the heap has a page, refuses. No row is read.
do $$
declare
  too_large text;
begin
  select string_agg(format('%s (reltuples %s, %s bytes)', relation.oid::regclass, relation.reltuples::bigint,
                           pg_relation_size(relation.oid)), ', ' order by relation.oid::regclass::text)
    into too_large
    from pg_class relation
   where relation.oid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass, 'ehr.order_routes'::regclass,
                          'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
                          'lab.order_route_result_reports'::regclass)
     and (relation.reltuples > 5000000 or (relation.reltuples < 0 and pg_relation_size(relation.oid) > 0));
  if too_large is not null then
    raise exception using errcode = '55000',
      message = '0156: too large to validate here, or never analysed: ' || too_large || '; nothing applied',
      hint = 'Run ANALYZE on the six tables first (docs/MIGRATION_RUNBOOK.md, "Before 0156"). Above 5,000,000 rows the '
        || 'pair checks go in NOT VALID with a follow-up file.';
  end if;
end
$$;

-- 3. The five pairs (N1): nullable, both or neither, validated here.
alter table ehr.lab_requests
  alter column test_code_system drop not null,
  alter column test_code drop not null,
  add constraint lab_requests_test_code_pair_ck check ((test_code_system is null) = (test_code is null)) not valid;
alter table ehr.lab_requests validate constraint lab_requests_test_code_pair_ck;
alter table ehr.diagnoses
  alter column code_system drop not null,
  alter column code drop not null,
  add constraint diagnoses_code_pair_ck check ((code_system is null) = (code is null)) not valid;
alter table ehr.diagnoses validate constraint diagnoses_code_pair_ck;
alter table lab.work_items
  alter column test_code_system drop not null,
  alter column test_code drop not null,
  add constraint work_items_test_code_pair_ck check ((test_code_system is null) = (test_code is null)) not valid;
alter table lab.work_items validate constraint work_items_test_code_pair_ck;
alter table lab.work_item_requested_tests
  alter column code_system drop not null,
  alter column code drop not null,
  add constraint work_item_requested_tests_code_pair_ck check ((code_system is null) = (code is null)) not valid;
alter table lab.work_item_requested_tests validate constraint work_item_requested_tests_code_pair_ck;
alter table lab.order_route_result_reports
  alter column test_code_system drop not null,
  alter column test_code drop not null,
  add constraint order_route_result_reports_test_code_pair_ck
    check ((test_code_system is null) = (test_code is null)) not valid;
alter table lab.order_route_result_reports validate constraint order_route_result_reports_test_code_pair_ck;

-- 4. The route's kind check (N1): a lab request route needs its name, and its
-- codes both or neither; every other term is 0086's.
alter table ehr.order_routes
  drop constraint order_routes_kind_ck,
  add constraint order_routes_kind_ck check (
    (kind = 'lab_request' and source_lab_request_id is not null and source_prescription_id is null
      and test_display is not null and (test_code_system is null) = (test_code is null)
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
alter table ehr.order_routes validate constraint order_routes_kind_ck;

-- 5. N2: whether a code is in the active ICD-11 release.
create function ehr.catalog_diagnosis_listed(requested_code_system text, requested_code text)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  release_id uuid;
begin
  -- Only ICD-11 is checked; any other code system, or no code, is not checked.
  if requested_code_system is distinct from 'ICD-11' or requested_code is null then
    return null;
  end if;
  select version_row.id into release_id
    from ehr.catalog_versions version_row
   where version_row.active and version_row.kind = 'diagnosis';
  if release_id is null then
    return null;
  end if;
  -- A post-coordinated code (with & or /) is checked on its first code; the list holds stem codes only.
  return exists (select 1 from ehr.catalog_diagnoses diagnosis
                  where diagnosis.version_id = release_id
                    and diagnosis.code = btrim(regexp_replace(requested_code, '[&/].*$', '')));
end;
$$;

-- 6. N3: the recent read, across an ICD-11 release switch (the same columns).
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
  release_id uuid;
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
  -- The active ICD-11 release, if any. With none, every pick comes back as stored.
  select version_row.id into release_id
    from ehr.catalog_versions version_row
   where version_row.active and version_row.kind = 'diagnosis';
  return query
    select recent.code_system, recent.code,
           -- A plain code: the release's current title. A post-coordinated one keeps its stored display.
           case when listed.code = recent.code then listed.title else recent.display end,
           recent.last_used_at, recent.use_count
      from ehr.clinician_recent_diagnoses recent
      -- Only an ICD-11 pick, only while a release is active, through the list's key (version_id, code), on its
      -- first code (the text before the first & or /).
      left join lateral (
        select diagnosis.code, diagnosis.title
          from ehr.catalog_diagnoses diagnosis
         where release_id is not null and recent.code_system = 'ICD-11'
           and diagnosis.version_id = release_id
           and diagnosis.code = btrim(regexp_replace(recent.code, '[&/].*$', ''))) listed on true
     where recent.membership_id = membership_value and recent.facility_id = facility_value
       -- An ICD-11 code the active release does not hold is left out, before the limit.
       and (release_id is null or recent.code_system <> 'ICD-11' or listed.code is not null)
     order by recent.last_used_at desc, recent.code_system, recent.code
     limit requested_limit;
end;
$$;

-- 7. Grants (here and in runtime-grants.sql). N3 keeps 0153's.
revoke all on function ehr.catalog_diagnosis_listed(text, text) from public;
do $$
declare runtime_role text;
begin
  foreach runtime_role in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function ehr.catalog_diagnosis_listed(text, text) to %I', runtime_role);
    end if;
  end loop;
end
$$;

-- 8. Comments.
comment on function ehr.catalog_diagnosis_listed(text, text) is
  '0156 (ORD-9): whether an ICD-11 code is in the active ICD-11 release (a post-coordinated code with & or / on its first code); null while no release is active, and for any other code system or no code (codeStatus not_checked).';
comment on function ehr.recent_diagnoses(integer) is
  '0153, 0156 (ORD-9): the session''s membership''s diagnosis picks at its facility, newest first, at most limit (1-50); none without ehr.diagnosis.write. While an ICD-11 release is active, an ICD-11 pick comes back with the release''s current title (a post-coordinated one, matched on its first code, keeps its display), and one the release does not hold is left out; every other pick, and every pick while no release is active, as stored. 22023 RECENT_DIAGNOSES_INVALID for a limit outside 1-50.';

-- 9. Post-checks (55000).
do $$
declare
  owner_oid oid := (select relation.relowner from pg_class relation
                     where relation.oid = 'ehr.catalog_versions'::regclass);
  mismatch text;
begin
  -- The ten columns nullable (and the route's two, as before).
  if (select count(*) from pg_attribute attribute_row
       where not attribute_row.attisdropped and not attribute_row.attnotnull
         and attribute_row.atttypid = 'text'::regtype
         and (attribute_row.attrelid, attribute_row.attname) in (
               ('ehr.lab_requests'::regclass, 'test_code_system'), ('ehr.lab_requests'::regclass, 'test_code'),
               ('ehr.diagnoses'::regclass, 'code_system'), ('ehr.diagnoses'::regclass, 'code'),
               ('lab.work_items'::regclass, 'test_code_system'), ('lab.work_items'::regclass, 'test_code'),
               ('lab.work_item_requested_tests'::regclass, 'code_system'),
               ('lab.work_item_requested_tests'::regclass, 'code'),
               ('lab.order_route_result_reports'::regclass, 'test_code_system'),
               ('lab.order_route_result_reports'::regclass, 'test_code'),
               ('ehr.order_routes'::regclass, 'test_code_system'), ('ehr.order_routes'::regclass, 'test_code'))) <> 12 then
    raise exception using errcode = '55000', message = '0156: a code column is not nullable';
  end if;
  -- The constraints on the twelve code columns, exactly: the length CHECKs as before, the five pair CHECKs and
  -- the new route kind check, each validated.
  select string_agg(coalesce(found.conname, expected.conname), ', ') into mismatch
    from (select constraint_row.conrelid, constraint_row.conname, constraint_row.contype, constraint_row.convalidated,
                 md5(pg_get_constraintdef(constraint_row.oid)) as definition_md5
            from pg_constraint constraint_row
           where constraint_row.conrelid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass,
                   'ehr.order_routes'::regclass, 'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
                   'lab.order_route_result_reports'::regclass)
             and exists (select 1 from pg_attribute attribute_row
                          where attribute_row.attrelid = constraint_row.conrelid
                            and attribute_row.attnum = any(constraint_row.conkey)
                            and attribute_row.attname in ('test_code_system', 'test_code', 'code_system', 'code'))) found
    full join (values
      ('ehr.lab_requests'::regclass, 'lab_requests_test_code_system_check', md5('CHECK (((length(test_code_system) >= 1) AND (length(test_code_system) <= 255)))')),
      ('ehr.lab_requests'::regclass, 'lab_requests_test_code_check', md5('CHECK (((length(test_code) >= 1) AND (length(test_code) <= 100)))')),
      ('ehr.lab_requests'::regclass, 'lab_requests_test_code_pair_ck', md5('CHECK (((test_code_system IS NULL) = (test_code IS NULL)))')),
      ('ehr.diagnoses'::regclass, 'diagnoses_code_system_check', md5('CHECK (((length(code_system) >= 1) AND (length(code_system) <= 255)))')),
      ('ehr.diagnoses'::regclass, 'diagnoses_code_check', md5('CHECK (((length(code) >= 1) AND (length(code) <= 100)))')),
      ('ehr.diagnoses'::regclass, 'diagnoses_code_pair_ck', md5('CHECK (((code_system IS NULL) = (code IS NULL)))')),
      ('lab.work_items'::regclass, 'work_items_test_code_system_check', md5('CHECK (((length(btrim(test_code_system)) >= 1) AND (length(btrim(test_code_system)) <= 255)))')),
      ('lab.work_items'::regclass, 'work_items_test_code_check', md5('CHECK (((length(btrim(test_code)) >= 1) AND (length(btrim(test_code)) <= 100)))')),
      ('lab.work_items'::regclass, 'work_items_test_code_pair_ck', md5('CHECK (((test_code_system IS NULL) = (test_code IS NULL)))')),
      ('lab.work_item_requested_tests'::regclass, 'work_item_requested_tests_code_system_check', md5('CHECK (((length(btrim(code_system)) >= 1) AND (length(btrim(code_system)) <= 255)))')),
      ('lab.work_item_requested_tests'::regclass, 'work_item_requested_tests_code_check', md5('CHECK (((length(btrim(code)) >= 1) AND (length(btrim(code)) <= 100)))')),
      ('lab.work_item_requested_tests'::regclass, 'work_item_requested_tests_code_pair_ck', md5('CHECK (((code_system IS NULL) = (code IS NULL)))')),
      ('lab.order_route_result_reports'::regclass, 'order_route_result_reports_test_code_pair_ck', md5('CHECK (((test_code_system IS NULL) = (test_code IS NULL)))')),
      ('ehr.order_routes'::regclass, 'order_routes_test_code_system_check', md5('CHECK (((test_code_system IS NULL) OR ((length(test_code_system) >= 1) AND (length(test_code_system) <= 255))))')),
      ('ehr.order_routes'::regclass, 'order_routes_test_code_check', md5('CHECK (((test_code IS NULL) OR ((length(test_code) >= 1) AND (length(test_code) <= 100))))')),
      ('ehr.order_routes'::regclass, 'order_routes_kind_ck', 'da75b1703689457cdb6b35053a48af52')
    ) expected(conrelid, conname, definition_md5)
      on expected.conrelid = found.conrelid and expected.conname = found.conname
         and expected.definition_md5 = found.definition_md5 and found.contype = 'c' and found.convalidated
   where found.conname is null or expected.conname is null;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0156: the constraints on the code columns are not as made: ' || mismatch;
  end if;
  -- Both functions exactly: body, owner, definer, STABLE, boolean or 0153's columns, search_path.
  if (select count(*) from pg_proc proc
       where proc.prosecdef and proc.provolatile = 's' and proc.proowner = owner_oid
         and proc.proconfig = array['search_path=pg_catalog, pg_temp']
         and proc.prolang = (select language_row.oid from pg_language language_row where language_row.lanname = 'plpgsql')
         and ((proc.oid = 'ehr.catalog_diagnosis_listed(text,text)'::regprocedure and md5(proc.prosrc) = '28048d5d87de33e9f03e71a93024d214'
               and proc.prorettype = 'boolean'::regtype and not proc.proretset)
           or (proc.oid = 'ehr.recent_diagnoses(integer)'::regprocedure and md5(proc.prosrc) = '034774a650aacf33a366e186d15cd5d7'
               and proc.proretset
               and pg_get_function_result(proc.oid) = 'TABLE(code_system text, code text, display text, '
                   || 'last_used_at timestamp with time zone, use_count integer)'))) <> 2 then
    raise exception using errcode = '55000', message = '0156: ehr.catalog_diagnosis_listed or ehr.recent_diagnoses is not as made';
  end if;
  -- EXECUTE: the owner and the two runtimes only, each runtime that exists holding it.
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('ehr.catalog_diagnosis_listed(text,text)'::regprocedure,
                                 'ehr.recent_diagnoses(integer)'::regprocedure)
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) not in ('hid_ehr_runtime', 'hid_schema_test_runtime')))
     or exists (select 1 from pg_roles role_row
                 cross join (values ('ehr.catalog_diagnosis_listed(text,text)'::regprocedure),
                                    ('ehr.recent_diagnoses(integer)'::regprocedure)) function_row(oid)
                 where role_row.rolname in ('hid_ehr_runtime', 'hid_schema_test_runtime')
                   and not has_function_privilege(role_row.oid, function_row.oid, 'EXECUTE')) then
    raise exception using errcode = '55000', message = '0156: EXECUTE on ehr.catalog_diagnosis_listed or ehr.recent_diagnoses is not as made';
  end if;
  -- The pins unchanged (0153's read is replaced, so it is not here).
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      -- The validators.
      ('lab.validate_work_item()', 'efac15072e0a6e68dff199026ff6f73e'),
      ('lab.validate_work_item_child()', '9bc011f7583332dd3de12ce2a8e45753'),
      ('ehr.guard_order_route_mutation()', '6a01bc885cd54f87a1bee8c0ebc100a4'),
      -- The functions that copy the codes.
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', 'fef3bfda1239e5cd72a149f8db30ff64'),
      ('ehr.accept_receiving_order_route(text,uuid,bigint,text,text,text,text,character,text)', '1d4a77de6316fa95a539d8151c8604df'),
      ('lab.return_order_route_result()', '10f7b7726a59488cd6ae6f9e55c4c568'),
      ('lab.return_order_route_invalidation()', '2176bfd64b05c6e357021c178060f1b7'),
      ('ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)', '6e903c30ec5c1c6c6949a4d16ea65dbe'),
      ('ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,character)', 'ef39eba74338f1414787ade116e3bc6b'),
      ('ehr.patient_list_order_routes()', '4dee7f9f41fc9c51e7364452a2968b73'),
      -- The five readers.
      ('ehr.list_order_routes_for_order(text,uuid,uuid)', 'cb6c138fbbffa1e1f226cde0aac1ec0b'),
      ('ehr.list_receiving_order_routes(text,text,text)', 'd48eed974035d514ab8aeafae31f4c39'),
      ('ehr.get_receiving_order_route(text,uuid)', 'ec84596219cef718917cd7f51f877952'),
      ('lab.list_order_routes(text,text)', '317d2f46f637b71b02258445b22fcb6c'),
      ('lab.get_order_route(uuid)', '0e87412493573e49e09f078254044748'),
      -- The trigger functions on the six tables.
      ('ehr.capture_record_version()', 'cae99883d00e70ab1d20ed6fbc97ad7b'),
      ('ehr.sync_order_routes_on_order_change()', '8ce6b42450cc06fc02fec8d1cf63af41'),
      ('ehr.require_order_route_first_event()', 'ae41186236e61c14f252bfa38a008e6a'),
      ('lab.reject_immutable_evidence()', '96897909ea027a8f17ebf63f4af0a0ac'),
      ('identity.list_own_work_patient()', '4a5d85a1c4d6f22c1f289c0dba7ed143'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      -- The recent record (nothing for a null code), and the permission check the read calls.
      ('ehr.record_recent_diagnosis(text,text,text)', 'e93826baac0c57bc21358916038c5567'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0156: these functions changed: ' || mismatch;
  end if;
  -- No row of the six tables inserted, updated or deleted while this file ran (it has no DML): the counts against
  -- section 0's, so an earlier file's writes in the same transaction are not counted.
  select string_agg(statistics.relid::regclass::text, ', ' order by statistics.relid::regclass::text) into mismatch
    from pg_stat_xact_user_tables statistics
   where statistics.relid in ('ehr.lab_requests'::regclass, 'ehr.diagnoses'::regclass, 'ehr.order_routes'::regclass,
                              'lab.work_items'::regclass, 'lab.work_item_requested_tests'::regclass,
                              'lab.order_route_result_reports'::regclass)
     and statistics.n_tup_ins + statistics.n_tup_upd + statistics.n_tup_del
         > coalesce((current_setting('hid.m0156_writes')::jsonb ->> statistics.relid::text)::bigint, 0);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0156: rows were written while this file ran: ' || mismatch;
  end if;
end
$$;
