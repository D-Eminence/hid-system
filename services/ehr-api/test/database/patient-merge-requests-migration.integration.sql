\set ON_ERROR_STOP on
-- 0207 (ID-8a): the migration file itself, run as written (psql \ir) the way
-- the runner runs it inside its transaction. Rollback-only, apart from the
-- dblink extension below. On a migrated database 0207 has run already:
--   1. busy refusals, first, before this transaction locks any table: each
--      lock the header declares (SHARE ROW EXCLUSIVE on identity.patients and
--      identity.staff_facility_memberships, ACCESS SHARE on
--      identity.patient_search_refs) is taken in the file's NOWAIT lock step
--      at exactly that mode: a second session (dblink) holds one of the three
--      at a time, while this transaction holds an earlier file's lock so the
--      file makes one attempt; in a mode that conflicts with it (ROW EXCLUSIVE
--      and SHARE for the first two, ACCESS EXCLUSIVE for the third) the file
--      refuses at once (busy), and in the strongest mode compatible with it
--      (ROW SHARE, EXCLUSIVE) it goes past its lock step and answers "already
--      applied". Then the second session writes to
--      identity.patients (ROW EXCLUSIVE, as a registration does): the file
--      tries for about 5 seconds and refuses with 55P03 "0207: ... stayed
--      busy for 5 seconds; nothing applied; run the release again at a
--      quieter time"; while this transaction already holds another file's
--      strong lock, it refuses at once ("... so it does not wait; ...").
--      Both are the messages the runner's dry run retries (hid-system#306);
--      nothing is applied;
--   2. a second run answers "already applied" (55000) and changes nothing;
--      a helper missing, or another identity function named like
--      patient_merge, is a half state;
--   3. 0207 taken away for this transaction: a half state (the table alone),
--      a changed pinned body (0132's resolver, 0145's marker test), a changed
--      policy it reads through (a cancel-check policy, 0131's and 0130's owner
--      reads, 0120's claims owner policy), a hid_ role a member of the
--      clinical tables' owner, a changed 0132 table, a changed visit key of
--      the notes or vitals, 0153 missing, and each ID-8b object already there
--      each refuse with 55000 and apply nothing; 0207 applies while a second
--      session holds every ehr., lab. and pharmacy. table, and
--      identity.registration_cases and identity.outreach_health_id_claims, in
--      ACCESS EXCLUSIVE (so the file locks none of them, not even for a
--      moment), and refuses at once while that session holds
--      identity.patient_search_refs so; then 0207 applies: the table and the
--      eleven functions; it takes no lock beyond its header's, holds every
--      lock its header declares, and holds no lock at all on any ehr., lab. or
--      pharmacy. table; a second run answers "already applied".
-- The cases are counted in a temporary sequence made before the transaction,
-- so a case inside a savepoint that is later rolled back still counts.
-- Fictional values only.
set plpgsql.variable_conflict = error;

-- dblink is created before the transaction (creating it inside would lock its
-- result type at ACCESS EXCLUSIVE, which the file reads as "this transaction
-- holds an earlier migration's locks") and dropped again at the end.
select exists (select 1 from pg_available_extensions where name = 'dblink') as m207_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as m207_dblink_create \gset
create temporary sequence m207_passed;
\if :m207_dblink_available
\if :m207_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0207 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0207_patient_merge_requests.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'

-- A case: stops the suite at once when it fails. (Functions only until 1 is done: a temporary table or sequence
-- would be a relation this transaction holds at ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0207 migrations suite failed: %: expected [%] got [%]', case_name, expected, coalesce(actual, 'null');
  end if;
  perform nextval('pg_temp.m207_passed');
end
$$;
-- The runner's test for a file's own busy refusal (dry-run-attempts.mjs).
create function pg_temp.answer(sqlstate text, message text) returns text language sql immutable as $$
  select case when sqlstate = '55P03' and message ~ '^0207: '
                   and message ~ '(so it does not wait|stayed busy for 5 seconds)(; nothing applied)?; run the release again at a quieter time$'
              then 'busy refusal: ' || substring(message from '(so it does not wait|stayed busy for 5 seconds)')
              when sqlstate = '00000' then 'applied'
              else sqlstate || ' ' || message end;
$$;
-- What the file makes, in one line.
create function pg_temp.made() returns text language sql as $$
  select (select count(*) from pg_class where oid = to_regclass('identity.patient_merges')) || ' table, '
      || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname = 'identity' and proc.proname like '%patient\_merge%') || ' functions, '
      || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname = 'identity' and proc.proname like '%patient\_merge%'
             and has_function_privilege('hid_identity_runtime', proc.oid, 'EXECUTE')) || ' granted';
$$;
-- The locks the header declares (pg_locks' names).
create function pg_temp.declared() returns table (table_name text, mode text) language sql immutable as $$
  values ('identity.patients', 'ShareRowExclusiveLock'), ('identity.staff_facility_memberships', 'ShareRowExclusiveLock'),
    ('identity.patient_search_refs', 'AccessShareLock');
$$;
create function pg_temp.lock_hold(table_name text, hold text) returns void language plpgsql as $$
begin
  perform public.dblink_exec('m207_blocker', 'begin');
  perform public.dblink_exec('m207_blocker', format('lock table %s in %s mode nowait', table_name, hold));
end
$$;
create function pg_temp.lock_release() returns void language plpgsql as $$
begin
  perform public.dblink_exec('m207_blocker', 'rollback');
end
$$;

-- 1. Busy refusals.
\if :m207_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('m207_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select public.dblink_exec('m207_blocker', 'set lock_timeout = ''3s''') as blocker_timeout \gset
set local lock_timeout = '3s';
select pg_temp.made() as made_before \gset
-- 1a2. Each declared lock in each mode its check needs: the other session holds the table; this transaction holds an
-- earlier file's lock (ehr.catalog_versions in SHARE, as the runner's dry run would), so the file makes one attempt.
\set hold 'select pg_temp.lock_hold(:''lc_table'', :''lc_hold''); savepoint holding; lock table ehr.catalog_versions in share mode;'
\set check 'rollback to savepoint holding; select pg_temp.lock_release(); select pg_temp.expect(:''lc_case'', :''lc_expected'', pg_temp.answer(:''LAST_ERROR_SQLSTATE'', :''LAST_ERROR_MESSAGE'') || '' | '' || pg_temp.made());'
\pset tuples_only on
\pset format unaligned
\set lc_table identity.patients \set lc_hold 'row exclusive' \set lc_case '1a2 identity.patients held in ROW EXCLUSIVE: busy at once'
select 'busy refusal: so it does not wait | ' || :'made_before' as lc_expected \gset
:hold
:run0207
:check
\set lc_table identity.patients \set lc_hold share \set lc_case '1a2 identity.patients held in SHARE: busy at once'
:hold
:run0207
:check
\set lc_table identity.staff_facility_memberships \set lc_hold 'row exclusive' \set lc_case '1a2 identity.staff_facility_memberships held in ROW EXCLUSIVE: busy at once'
:hold
:run0207
:check
\set lc_table identity.staff_facility_memberships \set lc_hold share \set lc_case '1a2 identity.staff_facility_memberships held in SHARE: busy at once'
:hold
:run0207
:check
select '55000 0207: already applied | ' || :'made_before' as lc_expected \gset
\set lc_table identity.patients \set lc_hold 'row share' \set lc_case '1a2 identity.patients held in ROW SHARE: past the lock step'
:hold
:run0207
:check
\set lc_table identity.staff_facility_memberships \set lc_hold 'row share' \set lc_case '1a2 identity.staff_facility_memberships held in ROW SHARE: past the lock step'
:hold
:run0207
:check
\set lc_table identity.patient_search_refs \set lc_hold exclusive \set lc_case '1a2 identity.patient_search_refs held in EXCLUSIVE: past the lock step'
:hold
:run0207
:check
select 'busy refusal: so it does not wait | ' || :'made_before' as lc_expected \gset
\set lc_table identity.patient_search_refs \set lc_hold 'access exclusive' \set lc_case '1a2 identity.patient_search_refs held in ACCESS EXCLUSIVE: busy at once'
:hold
:run0207
:check
-- (The tables the file must not lock at all are in 3: here the file stops at "already applied" before it reads
-- them.)
\pset format aligned
\pset tuples_only off
set local lock_timeout = default;
-- 1b. A writer on identity.patients (a registration in flight): the file tries for about 5 seconds, then refuses.
select public.dblink_exec('m207_blocker', 'begin') as began \gset
select public.dblink_exec('m207_blocker', 'lock table identity.patients in row exclusive mode') as blocked \gset
select clock_timestamp() as busy_started \gset
:run0207
select pg_temp.expect('1b a write in flight on identity.patients: 0207 tries for 5 seconds, then refuses as the runner retries',
  'busy refusal: stayed busy for 5 seconds | ' || :'made_before' || ' | waited',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made() || ' | '
  || case when clock_timestamp() - :'busy_started'::timestamptz >= interval '4.5 seconds' then 'waited' else 'did not wait' end);
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0207
select pg_temp.made() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: 0207 refuses at once',
  'busy refusal: so it does not wait | ' || :'made_before',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made_holding');
select public.dblink_exec('m207_blocker', 'rollback') as ended \gset
select public.dblink_exec('m207_blocker', 'begin') as began \gset
select public.dblink_exec('m207_blocker', 'lock table identity.staff_facility_memberships in row exclusive mode') as blocked \gset
:run0207
select pg_temp.expect('1d a write in flight on the memberships: the same refusal', 'busy refusal: stayed busy for 5 seconds | '
  || :'made_before', pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
select public.dblink_exec('m207_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('m207_blocker') as disconnected \gset
\else
\echo '0207 migrations suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

-- 2. A second run.
select pg_temp.made() as made_applied \gset
select pg_temp.expect('2a 0207 is applied here', '1 table, 11 functions, 5 granted', :'made_applied');
:run0207
select pg_temp.expect('2b 0207 again: already applied, nothing changed', '55000 0207: already applied | ' || :'made_applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
savepoint s2;
drop function identity.patient_merge_refusal(text, text, uuid, uuid, uuid);
:run0207
rollback to savepoint s2;
select pg_temp.expect('2c a helper missing: a half state, not "already applied"',
  '55000 0207: the schema is not in the reviewed state (part of 0207 is there); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
create function identity.patient_merge_extra() returns integer language sql as 'select 1';
:run0207
rollback to savepoint s2;
select pg_temp.expect('2d another identity function named like patient_merge: a half state',
  '55000 0207: the schema is not in the reviewed state (part of 0207 is there); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

-- 3. 0207 taken away for this transaction.
drop function identity.request_patient_merge(uuid, text, text, text, text),
  identity.list_patient_merges(text, text, integer, timestamp with time zone, uuid), identity.read_patient_merge(uuid),
  identity.refuse_patient_merge(uuid, bigint, text, text, text), identity.cancel_patient_merge(uuid, bigint, text, text),
  identity.patient_merge_actor(), identity.patient_merge_audit(record, text, text, uuid, uuid, text, jsonb),
  identity.patient_merge_source_state(uuid, uuid), identity.patient_merge_target(text, uuid, uuid, uuid),
  identity.patient_merge_items(uuid[], uuid), identity.patient_merge_refusal(text, text, uuid, uuid, uuid);
drop table identity.patient_merges;
select pg_temp.expect('3a the state before 0207, for this transaction', '0 table, 0 functions, 0 granted', pg_temp.made());
savepoint s3;
create table identity.patient_merges (id uuid);
:run0207
rollback to savepoint s3;
select pg_temp.expect('3b a half state (its table alone) is refused, nothing applied',
  '55000 0207: the schema is not in the reviewed state (part of 0207 is there); nothing applied | 0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
create table identity.patient_merge_moves (id uuid);
:run0207
rollback to savepoint s3;
select pg_temp.expect('3c an ID-8b object already there is refused, nothing applied',
  '55000 0207: an ID-8b object is already there; nothing applied | 0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
do $$
begin
  execute regexp_replace(pg_get_functiondef('identity.resolve_patient_search_ref(text,text)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0207
rollback to savepoint s3;
select pg_temp.expect('3d a body it mirrors changed (0132''s resolver) is refused, nothing applied',
  '55000 0207: these bodies are not as 0001-0153 left them: identity.resolve_patient_search_ref(text,text) | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
drop policy vitals_cancel_check_read on ehr.vitals;
create policy vitals_cancel_check_read on ehr.vitals for select using (true);
:run0207
rollback to savepoint s3;
select pg_temp.expect('3e a cancel-check policy that is not 0145''s is refused, nothing applied',
  '55000 0207: these policies are not as 0001-0153 left them: ehr.vitals.vitals_cancel_check_read | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
alter table identity.patient_search_refs drop constraint patient_search_refs_mode_purpose_ck;
:run0207
rollback to savepoint s3;
select pg_temp.expect('3f 0132''s purpose rules changed: refused, nothing applied',
  '55000 0207: identity.patient_search_refs'' purpose, mode and 10-minute rules are not as 0132 left them | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
alter table identity.patient_search_refs add column extra_note text;
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g 0132''s table with another column: refused, nothing applied',
  '55000 0207: these columns are not as 0001-0153 left them: identity.patient_search_refs has other columns | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());

-- 3g2. The other preconditions, each changed alone.
grant relb_migrator to hid_identity_runtime;
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2a a hid_ role a member of the clinical tables'' owner (0145 D11''s premise): refused, nothing applied',
  '55000 0207: the clinical tables are not as 0145 left them (one owner, row-level security forced, no hid_ role a member of the owner) | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
alter policy outreach_health_id_claims_owner on identity.outreach_health_id_claims using (false);
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2b the outreach claims'' owner policy (D2''s claim check reads through it) changed: refused, nothing applied',
  '55000 0207: these policies are not as 0001-0153 left them: identity.outreach_health_id_claims.outreach_health_id_claims_owner | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
alter policy registration_cases_owner_read on identity.registration_cases using (true);
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2c 0130''s registration_cases_owner_read changed: refused, nothing applied',
  '55000 0207: these policies are not as 0001-0153 left them: identity.registration_cases.registration_cases_owner_read | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
alter policy encounters_owner_read on ehr.encounters using (true);
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2d 0131''s encounters_owner_read changed: refused, nothing applied',
  '55000 0207: these policies are not as 0001-0153 left them: ehr.encounters.encounters_owner_read | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
-- A policy that names a column of its own table cannot be read without opening the table: it counts as changed (and
-- the file does not open the table to find out).
alter policy diagnoses_cancel_check_read on ehr.diagnoses using (patient_id is not null);
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2d2 a cancel-check policy that names its table''s column: refused, nothing applied',
  '55000 0207: these policies are not as 0001-0153 left them: ehr.diagnoses.diagnoses_cancel_check_read | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
do $$
begin
  execute regexp_replace(pg_get_functiondef('ehr.unknown_patient_cancel_scan_open()'::regprocedure),
    '\mselect exists\M', 'select /* changed */ exists');
end $$;
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2e 0145''s marker test changed: refused, nothing applied',
  '55000 0207: these bodies are not as 0001-0153 left them: ehr.unknown_patient_cancel_scan_open() | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
alter table identity.patients add column merged_into_patient_id uuid;
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2f identity.patients.merged_into_patient_id (ID-8b) already there: refused, nothing applied',
  '55000 0207: an ID-8b object is already there; nothing applied | 0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
create function identity.approve_patient_merge() returns integer language sql as 'select 1';
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2g an ID-8b approve function already there: refused, nothing applied',
  '55000 0207: an ID-8b object is already there; nothing applied | 0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
create function identity.undo_patient_merge() returns integer language sql as 'select 1';
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2g2 an ID-8b undo function already there: refused, nothing applied',
  '55000 0207: an ID-8b object is already there; nothing applied | 0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
drop table ehr.clinician_recent_diagnoses;
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2h 0153 not applied: refused, nothing applied',
  '55000 0207: 0001-0153 must be applied first | 0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
alter table ehr.vitals drop constraint vitals_encounter_id_patient_id_facility_id_fkey;
:run0207
rollback to savepoint s3;
select pg_temp.expect('3g2i the vitals'' reference to their visit dropped (D4 counts vitals through the visits): refused',
  '55000 0207: ehr.clinical_notes'' or ehr.vitals'' reference to its visit is not as 0004 left it | '
  || '0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());

-- 3g3. No clinical table, not even for a moment: a lock taken and released inside the run is gone from pg_locks
-- afterwards (3h-3l cannot see it), so a second session holds the tables while the file runs. Every ehr., lab. and
-- pharmacy. table, and the identity tables whose policies the file reads (identity.registration_cases,
-- identity.outreach_health_id_claims), held in ACCESS EXCLUSIVE: the file applies, with lock_timeout set so a wait
-- would fail the case instead of hanging. identity.patient_search_refs (whose CHECKs it reads) held so: busy at once.
\if :m207_dblink_available
select public.dblink_connect('m207_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select public.dblink_exec('m207_blocker', 'set lock_timeout = ''3s''') as blocker_timeout \gset
select blocker.pid as blocker_pid from public.dblink('m207_blocker', 'select pg_backend_pid()') as blocker(pid integer) \gset
set local lock_timeout = '3s';
select string_agg(format('%I.%I', namespace.nspname, relation.relname), ', ' order by namespace.nspname, relation.relname)
         as held_tables,
       count(*) as held_count
  from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
 where relation.relkind in ('r', 'p')
   and (namespace.nspname in ('ehr', 'lab', 'pharmacy')
        or relation.oid in ('identity.registration_cases'::regclass, 'identity.outreach_health_id_claims'::regclass)) \gset
select public.dblink_exec('m207_blocker', 'begin') as began \gset
select public.dblink_exec('m207_blocker', 'lock table ' || :'held_tables' || ' in access exclusive mode nowait') as held \gset
:run0207
select pg_temp.expect('3g3a every ehr., lab. and pharmacy. table and the two read-through identity tables held in ACCESS EXCLUSIVE by another session: 0207 applies all the same',
  'applied | 1 table, 11 functions, 5 granted | held ' || :'held_count' || ' of ' || :'held_count',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made() || ' | held '
  || (select count(*) from pg_locks held join pg_class relation on relation.oid = held.relation
       where held.pid = :blocker_pid and held.locktype = 'relation' and held.granted and held.mode = 'AccessExclusiveLock'
         and relation.relkind in ('r', 'p')
         and (relation.relnamespace in ('ehr'::regnamespace, 'lab'::regnamespace, 'pharmacy'::regnamespace)
              or relation.oid in ('identity.registration_cases'::regclass, 'identity.outreach_health_id_claims'::regclass)))
  || ' of ' || :'held_count');
rollback to savepoint s3;
select pg_temp.lock_release();
select pg_temp.expect('3g3b that run is rolled back with its savepoint', '0 table, 0 functions, 0 granted', pg_temp.made());
select pg_temp.lock_hold('identity.patient_search_refs', 'access exclusive');
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0207
rollback to savepoint holding;
select pg_temp.lock_release();
select pg_temp.expect('3g3c identity.patient_search_refs held in ACCESS EXCLUSIVE: busy at once, nothing applied',
  'busy refusal: so it does not wait | 0 table, 0 functions, 0 granted',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
select public.dblink_disconnect('m207_blocker') as disconnected \gset
set local lock_timeout = default;
\else
\echo '0207 migrations suite: dblink is not available on this server, so 3g3 (no clinical table even for a moment) is skipped'
\endif

-- The locks the file adds, on tables that were there before it ran.
create temporary table locks_seen (label text, table_name text, mode text);
create function pg_temp.record_locks(label text) returns void language sql as $$
  insert into locks_seen
  select label, namespace.nspname || '.' || relation.relname, held.mode
    from pg_locks held
    join pg_class relation on relation.oid = held.relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
   where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
     and relation.relkind in ('r', 'p', 'v', 'm')
     and namespace.nspname not in ('pg_catalog', 'information_schema', 'migration')
     and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%';
$$;
create function pg_temp.lock_rank(mode text) returns integer language sql immutable as $$
  select array_position(array['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
    'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'], mode);
$$;
select pg_temp.expect('3h before the run this transaction holds no lock on any ehr., lab. or pharmacy. table', '',
  coalesce((select string_agg(distinct namespace.nspname || '.' || relation.relname, ', ')
              from pg_locks held join pg_class relation on relation.oid = held.relation
              join pg_namespace namespace on namespace.oid = relation.relnamespace
             where held.pid = pg_backend_pid() and held.locktype = 'relation'
               and namespace.nspname in ('ehr', 'lab', 'pharmacy')), ''));
select pg_temp.record_locks('before');
:run0207
select pg_temp.record_locks('after');
select pg_temp.expect('3i 0207 applies: the table, the eleven functions, five granted',
  'applied | 1 table, 11 functions, 5 granted', pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
select pg_temp.expect('3j 0207 takes no lock beyond its header''s (on the tables that were there before it)', '',
  coalesce((select string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name, added.mode)
              from (select after_run.table_name, after_run.mode from locks_seen after_run
                     where after_run.label = 'after' and after_run.table_name <> 'identity.patient_merges'
                    except
                    select before_run.table_name, before_run.mode from locks_seen before_run
                     where before_run.label = 'before') added
             where not exists (select 1 from pg_temp.declared() declared
                                where declared.table_name = added.table_name
                                  and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(added.mode))), ''));
select pg_temp.expect('3k and holds every lock its header declares', '',
  coalesce((select string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name)
              from pg_temp.declared() declared
             where not exists (select 1 from locks_seen held where held.label = 'after'
                                and held.table_name = declared.table_name and held.mode = declared.mode)), ''));
select pg_temp.expect('3l no clinical table: no lock at all on any ehr., lab. or pharmacy. table after the run', '',
  coalesce((select string_agg(distinct held.table_name, ', ') from locks_seen held
             where held.label = 'after' and split_part(held.table_name, '.', 1) in ('ehr', 'lab', 'pharmacy')), ''));
select pg_temp.expect('3m the owner is the consent functions'' owner; no runtime role on the table', 'relb_migrator 0',
  (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'identity.patient_merges'::regclass)
  || ' ' || (select count(*) from pg_class relation, lateral aclexplode(relation.relacl) acl
              where relation.oid = 'identity.patient_merges'::regclass and acl.grantee <> relation.relowner));
:run0207
select pg_temp.expect('3n and answers already applied again', '55000 0207: already applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

select last_value as passed from pg_temp.m207_passed \gset
\echo '0207 migrations suite: ' :passed ' cases passed'
rollback;

\if :m207_dblink_available
\if :m207_dblink_create
drop extension dblink;
\endif
\endif
