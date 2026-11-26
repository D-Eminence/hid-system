\set ON_ERROR_STOP on
-- 0155 (ORD-7, facility items): a facility's own medicines and lab tests,
-- ehr.catalog_facility_items. Rollback-only, apart from the dblink
-- extension below. On a migrated database 0155 has run already; where a case
-- needs it, the file is run here as written (psql \ir) and stops at its first
-- error, as the runner's one transaction does (see run0155 below).
--   1. busy refusals, first, before this transaction holds a strong table
--      lock: another session (dblink) writes identity.facilities, and 0155
--      tries for about 5 seconds, then refuses with 55P03 "0155: ... stayed
--      busy for 5 seconds; nothing applied; run the release again at a
--      quieter time"; while this transaction holds an earlier file's strong
--      lock, each of the nine tables of its lock step, held by another
--      session in a mode that conflicts with 0155's, makes it refuse at once
--      ("... so it does not wait; ..."). Both are the runner's busy refusal
--      (dry-run-attempts.mjs), and nothing is applied. Reads and row locks
--      (ROW SHARE) on all nine, and permission and audit writes (ROW
--      EXCLUSIVE), do not stop it. The lock step takes exactly the nine
--      tables at the header's modes, and a run on the migrated database
--      answers "0155: already applied";
--   2. as migrated: row security enabled and forced, the four policies in
--      full (the session ties), the three triggers, the keys and the name
--      index, the grants (the EHR runtime selects, inserts and updates, never
--      deletes; the write check is the EHR runtime's alone; the search and
--      the status the EHR and schema test runtimes'), the four functions,
--      the code held by admin alone and its two audit rows; the write check
--      takes no argument;
--   3. back to the state before 0155 for this transaction, then 0155 as
--      written, as the catalogue's owner (the applier): it still applies when
--      another lane has added codes to admin (tolerant precondition); it
--      refuses (nothing applied) when admin lacks one of its 16 codes or is
--      inactive, when the code already exists or is on a role, when a
--      function it relies on is not as pinned (a session reader, 0152's
--      status), when 0152's list is missing, and (42501) when the applier
--      does not own the catalogue; with every precondition met it applies:
--      the nine tables at the header's modes and no lock on 0149's or 0152's
--      lists or versions; a second run answers "already applied", and so
--      does a run after another role is given the code;
--   4. fictional staff at facilities A, B and C (and D, with no items), as
--      the EHR API runtime: the write check answers for the session only (an
--      admin at the facility of the session's own membership; never a
--      doctor, a revoked role, another facility or another member's
--      membership); the facility's lock (pg_advisory_xact_lock(7410,
--      facility)) makes an add or a re-activation wait and a withdrawal not;
--      an admin adds items (no RETURNING needed), each a 36-character
--      lower-case code; each facility reads, searches and counts only its own
--      items, and nothing without a session; the status answers as 0152's,
--      row for row, with no item or no session facility, with and without a
--      national list; one active name per kind (re-activation too), the
--      Idempotency-Key per creator, at most 500 active items of a kind
--      (re-activation counted, an add whose key was used not counted, an add
--      under REPEATABLE READ refused); the guard keeps every column but active,
--      row_version (old + 1) and the changed columns, and records a change at
--      the time it is made; no DELETE or TRUNCATE;
--      the session ties on the creator and changer columns; a session at A
--      cannot insert a B row (without RETURNING) or change B's rows with an
--      UPDATE that reads no column; a withdrawn item keeps its id and comes
--      back with it;
--   5. the table's owner reads every facility's items; under FORCE its
--      UPDATE changes no row (a NOSUPERUSER owner; a superuser owner skips
--      row security);
--   6. the undo from 0155's header, as the owner, with no session, on items
--      in use, every lock first and NOWAIT: admin's row removed with an audit
--      row, 0152's status put back (md5 af2b63e1d10f9922a69ab9ed216c5e09,
--      STABLE, with 0149's grants), every item withdrawn with FORCE lifted for
--      the transaction and restored (each row kept, one version on); then no
--      admin writes, nothing is offered, the status counts no item, and 0155
--      refuses to run again ("not in the reviewed state").
-- Synthetic values only: uuid prefix c155, .invalid addresses.
set plpgsql.variable_conflict = error;

-- dblink is needed for the second session of 1 and 4. Creating it inside the
-- suite's transaction would lock its result type at ACCESS EXCLUSIVE, which
-- 0155 reads as "this transaction holds an earlier migration's locks", so it
-- is created before the transaction (when the server has it and it is not
-- there yet) and dropped again at the end.
select exists (select 1 from pg_available_extensions where name = 'dblink') as c155_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as c155_dblink_create \gset
\if :c155_dblink_available
\if :c155_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

-- Runs 0155 as written and keeps what it answered (LAST_ERROR_SQLSTATE and
-- LAST_ERROR_MESSAGE, or 'applied'). 0155 is many statements. psql reads
-- ON_ERROR_STOP when it starts a line, so each run is three lines: the first
-- turns ON_ERROR_STOP off, the second turns it on and runs the file (so the
-- file stops at its first error, as the runner's transaction does, while
-- this suite goes on), the third puts psql back. ON_ERROR_ROLLBACK undoes
-- only the failing statement, so each case that runs the file rolls back to
-- a savepoint afterwards, as the runner rolls back the whole file.
\set run0155 '\\set ON_ERROR_STOP on \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0155_catalog_facility_items.sql'
\set ran0155 '\\set QUIET off \\set ON_ERROR_ROLLBACK off'

-- A case: stops the suite at once when it fails. (Functions only until 1 is
-- done: a temporary table or sequence would be a relation this transaction
-- holds at ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0155 facility items suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  -- Counted in a setting until 1 is done, then in a sequence (which keeps
  -- its count across ROLLBACK TO SAVEPOINT, which the cases below use).
  if to_regclass('pg_temp.c155_passed') is null then
    perform set_config('c155.passed', (coalesce(nullif(current_setting('c155.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.c155_passed');
  end if;
  raise notice '0155 suite: % passed', case_name;
end
$$;
-- What a run answered, with the runner's test for a file's own busy refusal
-- (dry-run-attempts.mjs: its number first, its wording last).
create function pg_temp.answer(sqlstate text, message text) returns text language sql immutable as $$
  select case when message = 'applied' then 'applied'
              when sqlstate = '55P03' and message ~ '^0155: '
                   and message ~ '(so it does not wait|stayed busy for 5 seconds)(; nothing applied)?; run the release again at a quieter time$'
              then 'busy refusal: ' || substring(message from '(so it does not wait|stayed busy for 5 seconds)')
              else sqlstate || ' ' || message end;
$$;
-- What 0155 makes, to show what a run changed.
create function pg_temp.made() returns text language sql as $$
  select coalesce(to_regclass('ehr.catalog_facility_items')::text, 'no table') || ', '
      || (select count(*) from auth.permissions where code = 'ehr.catalog.facility-item.write') || ' code, '
      || (select count(*) from auth.role_permissions where permission_code = 'ehr.catalog.facility-item.write')
      || ' role rows, '
      || (select count(*) from audit.events where correlation_id = '0155-catalog-facility-items') || ' audit rows, status '
      || (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'ehr.catalog_status()'::regprocedure);
$$;
create function pg_temp.lock_rank(mode text) returns integer language sql immutable as $$
  select array_position(array['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
    'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'], mode);
$$;
-- Each table this transaction holds a lock on (not PostgreSQL's own tables,
-- not temporary ones), at its strongest mode, leaving out the
-- "relation:mode" pairs listed in before.
create function pg_temp.locks_added(before text) returns text language sql as $$
  select coalesce(string_agg(held.table_name || ' ' || held.strongest, ', ' order by held.table_name collate "C"), 'none')
    from (select namespace.nspname || '.' || class.relname as table_name,
                 (array_agg(lock_row.mode order by pg_temp.lock_rank(lock_row.mode) desc))[1] as strongest
            from pg_locks lock_row
            join pg_class class on class.oid = lock_row.relation and class.relkind in ('r', 'p')
            join pg_namespace namespace on namespace.oid = class.relnamespace
           where lock_row.pid = pg_backend_pid() and lock_row.locktype = 'relation' and lock_row.granted
             and namespace.nspname not in ('pg_catalog', 'information_schema')
             and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'
             and not (lock_row.relation::text || ':' || lock_row.mode = any (string_to_array(before, ',')))
           group by namespace.nspname, class.relname) held;
$$;
create function pg_temp.locks_now() returns text language sql as $$
  select coalesce(string_agg(lock_row.relation::text || ':' || lock_row.mode, ','), '') from pg_locks lock_row
   where lock_row.pid = pg_backend_pid() and lock_row.locktype = 'relation' and lock_row.granted;
$$;
-- The nine tables of 0155's lock step: the locks this transaction holds on
-- them that are stronger than ACCESS SHARE.
create function pg_temp.held_on_nine() returns text language sql as $$
  select coalesce(string_agg(lock_row.relation::regclass::text || ' ' || lock_row.mode, ', '
                             order by lock_row.relation::regclass::text collate "C"), 'none')
    from pg_locks lock_row
   where lock_row.pid = pg_backend_pid() and lock_row.locktype = 'relation' and lock_row.granted
     and lock_row.mode <> 'AccessShareLock'
     and lock_row.relation in ('auth.role_permissions'::regclass, 'identity.facilities'::regclass,
       'identity.staff_facility_memberships'::regclass, 'auth.permissions'::regclass, 'audit.events'::regclass,
       'auth.roles'::regclass, 'auth.accounts'::regclass, 'identity.organizations'::regclass,
       'identity.patients'::regclass);
$$;
select pg_get_userbyid(relowner) as c155_owner from pg_class where oid = 'ehr.catalog_versions'::regclass \gset

-- 1. Busy refusals and the lock step.
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select pg_temp.made() as c155_made \gset
\if :c155_dblink_available
select public.dblink_connect('c155_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
-- A facility being saved in another session (ROW EXCLUSIVE on
-- identity.facilities): 0155's SHARE ROW EXCLUSIVE cannot be had.
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table identity.facilities in row exclusive mode') as blocked \gset
select clock_timestamp() as c155_started \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select pg_temp.expect('1b identity.facilities written by another session: 0155 tries for about 5 seconds, then refuses as the runner retries; nothing applied, and every attempt gave back what it took',
  'busy refusal: stayed busy for 5 seconds | at least 4.9 s | none | ' || :'c155_made',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
  || case when clock_timestamp() - :'c155_started'::timestamptz >= interval '4.9 seconds' then 'at least 4.9 s'
          else (clock_timestamp() - :'c155_started'::timestamptz)::text end
  || ' | ' || pg_temp.held_on_nine() || ' | ' || pg_temp.made());
savepoint holding;
lock table ehr.catalog_versions in share mode;
select clock_timestamp() as c155_started \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
       || case when clock_timestamp() - :'c155_started'::timestamptz < interval '1 second' then 'at once' else 'waited' end
       || ' | ' || pg_temp.made() as c155_answer \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s strong lock: one attempt, refused at once',
  'busy refusal: so it does not wait | at once | ' || :'c155_made', :'c155_answer');
select public.dblink_exec('c155_blocker', 'rollback') as ended \gset

-- Each of the nine tables, held by another session in a mode that conflicts
-- with the one 0155 asks for, while this transaction holds an earlier file's
-- lock (one attempt each).
savepoint holding;
lock table ehr.catalog_versions in share mode;
\set c155_busy ''
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table auth.role_permissions in row exclusive mode') as blocked \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select :'c155_busy' || 'auth.role_permissions: ' || pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') as c155_busy,
       public.dblink_exec('c155_blocker', 'rollback') as ended \gset
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table identity.facilities in row exclusive mode') as blocked \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select :'c155_busy' || ' | identity.facilities: ' || pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') as c155_busy,
       public.dblink_exec('c155_blocker', 'rollback') as ended \gset
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table identity.staff_facility_memberships in row exclusive mode') as blocked \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select :'c155_busy' || ' | identity.staff_facility_memberships: '
       || pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') as c155_busy,
       public.dblink_exec('c155_blocker', 'rollback') as ended \gset
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table auth.permissions in share mode') as blocked \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select :'c155_busy' || ' | auth.permissions: ' || pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') as c155_busy,
       public.dblink_exec('c155_blocker', 'rollback') as ended \gset
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table audit.events in share mode') as blocked \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select :'c155_busy' || ' | audit.events: ' || pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') as c155_busy,
       public.dblink_exec('c155_blocker', 'rollback') as ended \gset
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table auth.roles in exclusive mode') as blocked \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select :'c155_busy' || ' | auth.roles: ' || pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') as c155_busy,
       public.dblink_exec('c155_blocker', 'rollback') as ended \gset
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table auth.accounts in exclusive mode') as blocked \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select :'c155_busy' || ' | auth.accounts: ' || pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') as c155_busy,
       public.dblink_exec('c155_blocker', 'rollback') as ended \gset
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table identity.organizations in exclusive mode') as blocked \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select :'c155_busy' || ' | identity.organizations: ' || pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE')
         as c155_busy,
       public.dblink_exec('c155_blocker', 'rollback') as ended \gset
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table identity.patients in exclusive mode') as blocked \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select :'c155_busy' || ' | identity.patients: ' || pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') as c155_busy,
       public.dblink_exec('c155_blocker', 'rollback') as ended,
       pg_temp.made() as c155_answer \gset
rollback to savepoint holding;
select pg_temp.expect('1d each of the nine tables held by another session in a mode that conflicts with 0155''s (a row written; an index built; DDL): refused at once; nothing applied',
  'auth.role_permissions: busy refusal: so it does not wait | identity.facilities: busy refusal: so it does not wait | '
  || 'identity.staff_facility_memberships: busy refusal: so it does not wait | auth.permissions: busy refusal: so it '
  || 'does not wait | audit.events: busy refusal: so it does not wait | auth.roles: busy refusal: so it does not wait | '
  || 'auth.accounts: busy refusal: so it does not wait | identity.organizations: busy refusal: so it does not wait | '
  || 'identity.patients: busy refusal: so it does not wait || ' || :'c155_made',
  :'c155_busy' || ' || ' || :'c155_answer');

-- Reads and row locks on all nine (ROW SHARE: a permission check, a row
-- read FOR UPDATE or checked by a foreign key) and permission and audit
-- writes in flight (ROW EXCLUSIVE) do not stop 0155: it passes its lock step.
select public.dblink_exec('c155_blocker', 'begin') as began \gset
select public.dblink_exec('c155_blocker', 'lock table auth.role_permissions, identity.facilities, '
  || 'identity.staff_facility_memberships, auth.permissions, audit.events, auth.roles, auth.accounts, '
  || 'identity.organizations, identity.patients in row share mode') as blocked \gset
select public.dblink_exec('c155_blocker', 'lock table auth.permissions, audit.events in row exclusive mode') as blocked \gset
savepoint reads;
\set ON_ERROR_STOP off
:run0155
:ran0155
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') as c155_answer \gset
rollback to savepoint reads;
select public.dblink_exec('c155_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('c155_blocker') as disconnected \gset
select pg_temp.expect('1e another session reading and row-locking the nine and writing permissions and audit rows: 0155 passes its lock step and answers "already applied"',
  '55000 0155: already applied', :'c155_answer');
\else
\echo '0155 suite: dblink is not available on this server, so the busy refusals (1b-1e) and the lock waits (4c) are skipped'
\endif

-- The lock step, measured: what a run on the migrated database adds to the
-- locks this transaction holds. The lock step succeeds and keeps its locks;
-- the preconditions then refuse ("already applied") and give back theirs.
savepoint lock_step;
select pg_temp.locks_now() as c155_locks_before \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | added: '
       || pg_temp.locks_added(:'c155_locks_before') as c155_answer \gset
rollback to savepoint lock_step;
select pg_temp.expect('1f a run on the migrated database: the lock step takes the nine tables at the header''s modes and nothing else, then "already applied"',
  '55000 0155: already applied | added: audit.events RowExclusiveLock, auth.accounts RowShareLock, '
  || 'auth.permissions RowExclusiveLock, auth.role_permissions ShareRowExclusiveLock, auth.roles RowShareLock, '
  || 'identity.facilities ShareRowExclusiveLock, identity.organizations RowShareLock, identity.patients RowShareLock, '
  || 'identity.staff_facility_memberships ShareRowExclusiveLock',
  :'c155_answer');

create temporary sequence c155_passed;
select setval('pg_temp.c155_passed', coalesce(nullif(current_setting('c155.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset
grant usage on sequence pg_temp.c155_passed to public;

-- 2. As migrated.
select pg_temp.expect('2a row security enabled and forced; four permissive policies, for every role (privileges say who may use them)',
  'true true | catalog_facility_items_facility_read SELECT permissive public | catalog_facility_items_insert INSERT '
  || 'permissive public | catalog_facility_items_owner_read SELECT permissive public | catalog_facility_items_update '
  || 'UPDATE permissive public',
  (select relrowsecurity || ' ' || relforcerowsecurity from pg_class where oid = 'ehr.catalog_facility_items'::regclass)
  || ' | ' || (select string_agg(policy_row.polname || ' '
                                 || case policy_row.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
                                      when 'd' then 'DELETE' else 'ALL' end || ' '
                                 || case when policy_row.polpermissive then 'permissive' else 'restrictive' end || ' '
                                 || case when policy_row.polroles = array[0::oid] then 'public'
                                         else policy_row.polroles::text end,
                                 ' | ' order by policy_row.polname)
                 from pg_policy policy_row where policy_row.polrelid = 'ehr.catalog_facility_items'::regclass));
select pg_temp.expect('2b a session reads its facility''s items; it adds them as itself, at its facility, with its membership, and changes them so, when it holds the code (each session reader and the write check once per statement)',
  'read: (facility_id = ( SELECT platform.current_facility_id() AS current_facility_id)) | '
  || 'insert: ((facility_id = ( SELECT platform.current_facility_id() AS current_facility_id)) AND (created_by = ( SELECT '
  || 'platform.current_account_id() AS current_account_id)) AND (created_by_membership_id = ( SELECT '
  || 'platform.current_membership_id() AS current_membership_id)) AND ( SELECT ehr.facility_item_write_allowed() AS '
  || 'facility_item_write_allowed)) | '
  || 'update using: ((facility_id = ( SELECT platform.current_facility_id() AS current_facility_id)) AND ( SELECT '
  || 'ehr.facility_item_write_allowed() AS facility_item_write_allowed)) | '
  || 'update check: ((facility_id = ( SELECT platform.current_facility_id() AS current_facility_id)) AND (changed_by = '
  || '( SELECT platform.current_account_id() AS current_account_id)) AND (changed_by_membership_id = ( SELECT '
  || 'platform.current_membership_id() AS current_membership_id)) AND ( SELECT ehr.facility_item_write_allowed() AS '
  || 'facility_item_write_allowed))',
  (select 'read: ' || pg_get_expr(polqual, polrelid) from pg_policy
    where polrelid = 'ehr.catalog_facility_items'::regclass and polname = 'catalog_facility_items_facility_read')
  || ' | ' || (select 'insert: ' || pg_get_expr(polwithcheck, polrelid) from pg_policy
                where polrelid = 'ehr.catalog_facility_items'::regclass and polname = 'catalog_facility_items_insert')
  || ' | ' || (select 'update using: ' || pg_get_expr(polqual, polrelid) || ' | update check: '
                      || pg_get_expr(polwithcheck, polrelid) from pg_policy
                where polrelid = 'ehr.catalog_facility_items'::regclass and polname = 'catalog_facility_items_update'));
select pg_temp.expect('2c the owner read policy, as 0141''s: the table''s owner reads every row',
  'pg_has_role(( SELECT relation.relowner FROM pg_class relation WHERE (relation.oid = '
  || '(''ehr.catalog_facility_items''::regclass)::oid)), ''USAGE''::text)',
  (select regexp_replace(pg_get_expr(polqual, polrelid), '\s+', ' ', 'g') from pg_policy
    where polrelid = 'ehr.catalog_facility_items'::regclass and polname = 'catalog_facility_items_owner_read'));
select pg_temp.expect('2d the triggers: the guard before insert or update of each row; delete and truncate refused',
  'catalog_facility_items_guard 23 ehr.catalog_facility_item_guard O | catalog_facility_items_no_delete 11 '
  || 'platform.reject_mutation O | catalog_facility_items_no_truncate 34 platform.reject_mutation O',
  (select string_agg(tgname || ' ' || tgtype || ' ' || tgfoid::regproc::text || ' ' || tgenabled::text, ' | ' order by tgname)
     from pg_trigger where tgrelid = 'ehr.catalog_facility_items'::regclass and not tgisinternal));
select pg_temp.expect('2e the keys: the item''s id; the facility; creator and changer as members of that facility (0004''s key); one Idempotency-Key per creator; one active name per kind',
  'catalog_facility_items_changed_by_fk: FOREIGN KEY (changed_by_membership_id, facility_id, changed_by) REFERENCES '
  || 'identity.staff_facility_memberships(id, facility_id, account_id) ON DELETE RESTRICT | '
  || 'catalog_facility_items_created_by_fk: FOREIGN KEY (created_by_membership_id, facility_id, created_by) REFERENCES '
  || 'identity.staff_facility_memberships(id, facility_id, account_id) ON DELETE RESTRICT | '
  || 'catalog_facility_items_facility_fk: FOREIGN KEY (facility_id) REFERENCES identity.facilities(id) ON DELETE RESTRICT | '
  || 'catalog_facility_items_key_uq: UNIQUE (facility_id, created_by, idempotency_key) | '
  || 'catalog_facility_items_pkey: PRIMARY KEY (id) | '
  || 'CREATE UNIQUE INDEX catalog_facility_items_active_name_uq ON ehr.catalog_facility_items USING btree (facility_id, '
  || 'kind, lower(display)) WHERE active',
  (select string_agg(conname || ': ' || pg_get_constraintdef(oid), ' | ' order by conname)
     from pg_constraint where conrelid = 'ehr.catalog_facility_items'::regclass and contype in ('f', 'u', 'p'))
  || ' | ' || pg_get_indexdef('ehr.catalog_facility_items_active_name_uq'::regclass));
select pg_temp.expect('2f the table''s grants: the EHR runtime selects, inserts and updates (never deletes or truncates); no other runtime has any',
  'hid_ehr_runtime=arw | ehr api: true true true false false | others: none',
  (select string_agg(pg_get_userbyid(acl.grantee) || '=' || string_agg_codes, ',')
     from (select acl.grantee, string_agg(case acl.privilege_type when 'SELECT' then 'r' when 'INSERT' then 'a'
                                             when 'UPDATE' then 'w' else acl.privilege_type end, ''
                                          order by case acl.privilege_type when 'INSERT' then 1 when 'SELECT' then 2
                                                     when 'UPDATE' then 3 else 4 end) as string_agg_codes
             from pg_class relation, lateral aclexplode(relation.relacl) acl
            where relation.oid = 'ehr.catalog_facility_items'::regclass and acl.grantee <> relation.relowner
            group by acl.grantee) acl)
  || ' | ehr api: ' || has_table_privilege('hid_ehr_api_runtime', 'ehr.catalog_facility_items', 'SELECT') || ' '
  || has_table_privilege('hid_ehr_api_runtime', 'ehr.catalog_facility_items', 'INSERT') || ' '
  || has_table_privilege('hid_ehr_api_runtime', 'ehr.catalog_facility_items', 'UPDATE') || ' '
  || has_table_privilege('hid_ehr_api_runtime', 'ehr.catalog_facility_items', 'DELETE') || ' '
  || has_table_privilege('hid_ehr_api_runtime', 'ehr.catalog_facility_items', 'TRUNCATE')
  || ' | others: ' || coalesce((select string_agg(rolname, ' ' order by rolname) from pg_roles
                                 where rolname like 'hid\_%runtime' and rolname not in ('hid_ehr_runtime', 'hid_ehr_api_runtime')
                                   and has_table_privilege(oid, 'ehr.catalog_facility_items',
                                                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')), 'none'));
select pg_temp.expect('2g the four functions: the write check, the search and the status run as their owner (STABLE); the guard as the writer; who may run each',
  'ehr.catalog_facility_item_guard() invoker v plpgsql {"search_path=pg_catalog, pg_temp"} owner: nobody else | '
  || 'ehr.catalog_status() definer s plpgsql {"search_path=pg_catalog, pg_temp"} owner: hid_ehr_runtime '
  || 'hid_schema_test_runtime | '
  || 'ehr.facility_item_write_allowed() definer s plpgsql {"search_path=pg_catalog, pg_temp"} owner: hid_ehr_runtime | '
  || 'ehr.search_catalog_facility_items(text,text,integer) definer s plpgsql {"search_path=pg_catalog, pg_temp"} '
  || 'owner: hid_ehr_runtime hid_schema_test_runtime',
  (select string_agg(proc.oid::regprocedure::text || ' ' || case when proc.prosecdef then 'definer' else 'invoker' end
                     || ' ' || proc.provolatile::text || ' ' || language_row.lanname || ' ' || proc.proconfig::text || ' '
                     || case when proc.proowner = (select relowner from pg_class
                                                    where oid = 'ehr.catalog_versions'::regclass) then 'owner' else 'other owner' end
                     || ': ' || coalesce((select string_agg(case when acl.grantee = 0 then 'public'
                                                                  else pg_get_userbyid(acl.grantee) end, ' '
                                                             order by 1)
                                            from aclexplode(proc.proacl) acl where acl.grantee <> proc.proowner),
                                         'nobody else'),
                     ' | ' order by proc.oid::regprocedure::text)
     from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
    where proc.oid in ('ehr.catalog_facility_item_guard()'::regprocedure, 'ehr.catalog_status()'::regprocedure,
                       'ehr.facility_item_write_allowed()'::regprocedure,
                       'ehr.search_catalog_facility_items(text,text,integer)'::regprocedure)));
select pg_temp.expect('2h the write check takes no argument, so it cannot be asked about another member or facility',
  '1 0', (select count(*) || ' ' || min(pronargs) from pg_proc
           where proname = 'facility_item_write_allowed' and pronamespace = 'ehr'::regnamespace));
select pg_temp.expect('2i the bodies are the ones 0155''s post-check pins', '4befb59b31982d87c758810d2d3116ec '
  || '99e0abe265d0006f77ff6f279986dea2 b6ed2869600110b6399835bd4c4f6d7e 56d5b39e176c83b02a12df1c8a3e3e77',
  (select string_agg(md5(prosrc), ' ' order by oid::regprocedure::text) from pg_proc
    where oid in ('ehr.catalog_facility_item_guard()'::regprocedure, 'ehr.catalog_status()'::regprocedure,
                  'ehr.facility_item_write_allowed()'::regprocedure,
                  'ehr.search_catalog_facility_items(text,text,integer)'::regprocedure)));
select pg_temp.expect('2j the code: active, held by admin alone; admin''s other 16 codes as 0001-0153 left them',
  'true Add and withdraw this facility''s own medicines and lab tests | admin | 17: audit.read '
  || 'ehr.catalog.facility-item.write identity.registration.approve identity.registration.write lab.accession.read '
  || 'lab.execution.read lab.import.read lab.result.released.read ocr.job.read organization.manage outreach.campaign.read '
  || 'outreach.campaign.write outreach.registration.read outreach.registration.write pharmacy.dispensing.read '
  || 'pharmacy.import.read workforce.manage',
  (select active || ' ' || description from auth.permissions where code = 'ehr.catalog.facility-item.write')
  || ' | ' || (select string_agg(role_code, ' ' order by role_code) from auth.role_permissions
                where permission_code = 'ehr.catalog.facility-item.write')
  || ' | ' || (select count(*) || ': ' || string_agg(permission_code, ' ' order by permission_code collate "C")
                 from auth.role_permissions where role_code = 'admin'));
select pg_temp.expect('2k two audit rows as the system actor (no account, membership, facility or patient): the code, then admin''s row',
  'auth.permission.add success permission ehr.catalog.facility-item.write healthcare-operations migration hid-0155 '
  || '{"decision": "ORD-7 facility items, admin only (design note on hid-system#258, 26 November 2026)", "migration": '
  || '"0155", "permissionCode": "ehr.catalog.facility-item.write"} 0 | '
  || 'auth.role-permission.add success role-permission admin/ehr.catalog.facility-item.write healthcare-operations '
  || 'migration hid-0155 {"decision": "ORD-7 facility items, admin only (design note on hid-system#258, 26 November '
  || '2026)", "roleCode": "admin", "migration": "0155", "permissionCode": "ehr.catalog.facility-item.write"} 0 | '
  || 'system system | ORD-7: hospital administrators add and withdraw their facility''s own medicines and lab tests',
  (select string_agg(event_row.action || ' ' || event_row.outcome || ' ' || event_row.resource_type || ' '
                     || event_row.resource_id || ' ' || event_row.purpose_of_use || ' ' || event_row.provenance || ' '
                     || event_row.source_system || ' ' || event_row.details::text || ' '
                     || num_nonnulls(event_row.actor_subject, event_row.actor_account_id, event_row.actor_membership_id,
                                     event_row.organization_id, event_row.facility_id, event_row.patient_id),
                     ' | ' order by event_row.sequence_id)
     from audit.events event_row where event_row.correlation_id = '0155-catalog-facility-items')
  || ' | ' || (select string_agg(distinct actor_type, ' ') || ' ' || string_agg(distinct actor_type, ' ') || ' | '
                      || string_agg(distinct reason, ' ')
                 from audit.events where correlation_id = '0155-catalog-facility-items'));
select pg_temp.expect('2l the table is empty after 0155', '0', (select count(*)::text from ehr.catalog_facility_items));

-- 3. 0155 as written, from the state before it (for this transaction).
savepoint rerun;
-- Back to the state before 0155: its table and functions moved out of the
-- way (moving takes no lock on the tables the keys reference), 0152's status
-- put back (with check_function_bodies off, so no list is opened), the code,
-- admin's row and the audit rows taken away (append-only, so with triggers
-- off).
create schema c155_moved;
alter table ehr.catalog_facility_items set schema c155_moved;
alter function ehr.catalog_facility_item_guard() set schema c155_moved;
alter function ehr.facility_item_write_allowed() set schema c155_moved;
alter function ehr.search_catalog_facility_items(text, text, integer) set schema c155_moved;
set local check_function_bodies = off;
create or replace function ehr.catalog_status()
returns table (kind text, available boolean, list_version text, approved_at timestamptz, offered integer,
  attribution text[], file_sha256 text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select kinds.kind, version_row.id is not null, version_row.version, version_row.approved_at,
         case kinds.kind
           when 'medicine' then (select count(*)::integer from ehr.catalog_medicines medicine
                                  where medicine.version_id = version_row.id and not medicine.withdrawn)
           when 'lab_test' then (select count(*)::integer from ehr.catalog_lab_tests test
                                  where test.version_id = version_row.id and not test.withdrawn)
           else (select count(*)::integer from ehr.catalog_diagnoses diagnosis
                  where diagnosis.version_id = version_row.id) end,
         coalesce(version_row.attribution, '{}'), version_row.file_sha256::text
    from (values ('diagnosis'), ('lab_test'), ('medicine')) as kinds(kind)
    left join ehr.catalog_versions version_row on version_row.kind = kinds.kind and version_row.active
   order by kinds.kind
$$;
set local check_function_bodies = on;
comment on function ehr.catalog_status() is
  '0149 (ORD-7), 0152 (ORD-9): per kind (diagnosis, lab_test, medicine): whether an active version exists, its label, when it was approved, how many rows it offers, the notices its sources require and the sha256 of its seed file.';
delete from auth.role_permissions where permission_code = 'ehr.catalog.facility-item.write';
delete from auth.permissions where code = 'ehr.catalog.facility-item.write';
set local session_replication_role = replica;
delete from audit.events where correlation_id = '0155-catalog-facility-items';
set local session_replication_role = origin;
select pg_temp.made() as c155_before \gset
select pg_temp.expect('3a the state before 0155, for this transaction: 0152''s status (language sql, STABLE, as its owner)',
  'no table, 0 code, 0 role rows, 0 audit rows, status af2b63e1d10f9922a69ab9ed216c5e09 | sql s true owner',
  :'c155_before' || ' | ' || (select language_row.lanname || ' ' || proc.provolatile::text || ' ' || proc.prosecdef || ' '
                                     || case when proc.proowner = (select relowner from pg_class
                                                                    where oid = 'ehr.catalog_versions'::regclass)
                                             then 'owner' else 'other' end
                                from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                               where proc.oid = 'ehr.catalog_status()'::regprocedure));

-- Another lane has added codes to admin (as Billing's 0162 adds ten): 0155
-- still applies, and leaves them.
savepoint precondition;
insert into auth.permissions (code, description) values
  ('c155.other-lane.read', 'Synthetic code another lane adds (0155 suite)'),
  ('c155.other-lane.write', 'Synthetic code another lane adds (0155 suite)');
insert into auth.role_permissions (role_code, permission_code) values
  ('admin', 'c155.other-lane.read'), ('admin', 'c155.other-lane.write');
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made() || ' | '
       || (select count(*) || ' codes, ' || count(*) filter (where permission_code like 'c155.other-lane.%') || ' other lane''s'
             from auth.role_permissions where role_code = 'admin') as c155_answer \gset
rollback to savepoint precondition;
select pg_temp.expect('3b admin holds codes another lane added: 0155 applies (its codes are a subset), and leaves them',
  'applied | ehr.catalog_facility_items, 1 code, 1 role rows, 2 audit rows, status 99e0abe265d0006f77ff6f279986dea2 | '
  || '19 codes, 2 other lane''s',
  :'c155_answer');

-- Each refusal: 55000 (42501 for the applier), nothing applied.
delete from auth.role_permissions where role_code = 'admin' and permission_code = 'workforce.manage';
select pg_temp.made() as c155_pre \gset
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
       || case when pg_temp.made() = :'c155_pre' then 'nothing applied' else pg_temp.made() end as c155_answer \gset
rollback to savepoint precondition;
select pg_temp.expect('3c admin lacks one of the 16 codes 0001-0153 gave it: refused',
  '55000 0155: the role admin is inactive or lacks a code 0001-0153 gave it; nothing applied | nothing applied',
  :'c155_answer');
update auth.roles set active = false where code = 'admin';
select pg_temp.made() as c155_pre \gset
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
       || case when pg_temp.made() = :'c155_pre' then 'nothing applied' else pg_temp.made() end as c155_answer \gset
rollback to savepoint precondition;
select pg_temp.expect('3d admin inactive: refused',
  '55000 0155: the role admin is inactive or lacks a code 0001-0153 gave it; nothing applied | nothing applied',
  :'c155_answer');
insert into auth.permissions (code, description) values
  ('ehr.catalog.facility-item.write', 'Synthetic: made by another lane (0155 suite)');
insert into auth.role_permissions (role_code, permission_code) values ('org_admin', 'ehr.catalog.facility-item.write');
select pg_temp.made() as c155_pre \gset
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
       || case when pg_temp.made() = :'c155_pre' then 'nothing applied' else pg_temp.made() end as c155_answer \gset
rollback to savepoint precondition;
select pg_temp.expect('3e the code already made, on another role: not the reviewed state, refused',
  '55000 0155: the facility items, their functions or the code ehr.catalog.facility-item.write exist, with other '
  || 'content than 0155 leaves; not in the reviewed state; nothing applied | nothing applied',
  :'c155_answer');
do $$
declare
  reader regprocedure := 'platform.current_facility_id()'::regprocedure;
  body text := (select proc.prosrc from pg_proc proc where proc.oid = reader);
begin
  execute replace(pg_get_functiondef(reader), body, body || '-- changed by the 0155 suite' || chr(10));
end $$;
select pg_temp.made() as c155_pre \gset
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
       || case when pg_temp.made() = :'c155_pre' then 'nothing applied' else pg_temp.made() end as c155_answer \gset
rollback to savepoint precondition;
select pg_temp.expect('3f a session reader the policies call is not as pinned: refused, naming it',
  '55000 0155: these functions are not the ones this file relies on: platform.current_facility_id() | nothing applied',
  :'c155_answer');
set local check_function_bodies = off;
do $$
declare
  status_oid regprocedure := 'ehr.catalog_status()'::regprocedure;
  body text := (select proc.prosrc from pg_proc proc where proc.oid = status_oid);
begin
  execute replace(pg_get_functiondef(status_oid), body, body || '-- changed by the 0155 suite' || chr(10));
end $$;
set local check_function_bodies = on;
select pg_temp.made() as c155_pre \gset
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
       || case when pg_temp.made() = :'c155_pre' then 'nothing applied' else pg_temp.made() end as c155_answer \gset
rollback to savepoint precondition;
select pg_temp.expect('3g the status it replaces is not 0152''s: refused, naming it',
  '55000 0155: these functions are not the ones this file relies on: ehr.catalog_status() | nothing applied',
  :'c155_answer');
alter table ehr.catalog_diagnoses rename to catalog_diagnoses_c155;
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') as c155_answer \gset
rollback to savepoint precondition;
select pg_temp.expect('3h 0152''s list missing: refused', '55000 0155: 0149 and 0152 must be applied first',
  :'c155_answer');
-- The catalogue owned by another role than the one applying 0155.
alter table ehr.catalog_versions owner to hid_schema_test_runtime;
alter function ehr.catalog_search_query(text) owner to hid_schema_test_runtime;
alter function ehr.catalog_status() owner to hid_schema_test_runtime;
select pg_temp.made() as c155_pre \gset
\set ON_ERROR_STOP off
:run0155
:ran0155
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
       || case when pg_temp.made() = :'c155_pre' then 'nothing applied' else pg_temp.made() end as c155_answer \gset
rollback to savepoint precondition;
select pg_temp.expect('3i applied by a role that does not own the catalogue: refused (42501), naming the owner',
  '42501 0155: apply 0155 as hid_schema_test_runtime, the owner of ehr.catalog_versions (the role that applied 0149 '
  || 'and 0152), not ' || current_user || ' | nothing applied',
  :'c155_answer');

-- Every precondition met: 0155 applies, as the catalogue's owner. Its locks
-- on the nine tables are the header's, and it locks no list or version of
-- 0149 or 0152.
select pg_temp.locks_now() as c155_locks_before \gset
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made() || ' | nine: '
       || (select string_agg(nine.table_name || ' ' || (select (array_agg(lock_row.mode
                                                                  order by pg_temp.lock_rank(lock_row.mode) desc))[1]
                                                          from pg_locks lock_row
                                                         where lock_row.pid = pg_backend_pid() and lock_row.granted
                                                           and lock_row.relation = nine.table_name::regclass),
                             ', ' order by nine.table_name collate "C")
             from unnest(array['auth.role_permissions', 'identity.facilities', 'identity.staff_facility_memberships',
                               'auth.permissions', 'audit.events', 'auth.roles', 'auth.accounts',
                               'identity.organizations', 'identity.patients']) nine(table_name))
       || ' | lists and versions: '
       || (select count(*) from pg_locks lock_row
            where lock_row.pid = pg_backend_pid()
              and lock_row.relation in ('ehr.catalog_versions'::regclass, 'ehr.catalog_medicines'::regclass,
                                        'ehr.catalog_lab_tests'::regclass, 'ehr.catalog_diagnoses'::regclass))
       || ' locks' as c155_answer \gset
select pg_temp.expect('3j every precondition met: applied, with the header''s locks and none on the lists or versions',
  'applied | ehr.catalog_facility_items, 1 code, 1 role rows, 2 audit rows, status 99e0abe265d0006f77ff6f279986dea2 | '
  || 'nine: audit.events RowExclusiveLock, auth.accounts RowShareLock, auth.permissions RowExclusiveLock, '
  || 'auth.role_permissions ShareRowExclusiveLock, auth.roles RowShareLock, identity.facilities ShareRowExclusiveLock, '
  || 'identity.organizations RowShareLock, identity.patients RowShareLock, identity.staff_facility_memberships '
  || 'ShareRowExclusiveLock | lists and versions: 0 locks',
  :'c155_answer');
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.expect('3k a second run answers "already applied" and changes nothing',
  '55000 0155: already applied | ehr.catalog_facility_items, 1 code, 1 role rows, 2 audit rows, status '
  || '99e0abe265d0006f77ff6f279986dea2',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint rerun;
select pg_temp.expect('3l back to the migrated state', :'c155_made', pg_temp.made());
-- A role given the code after 0155 (owner question 5: a later role is one
-- more row): a run still answers "already applied", since that test compares
-- only 0155's own row, admin's.
savepoint later_role;
insert into auth.role_permissions (role_code, permission_code) values ('org_admin', 'ehr.catalog.facility-item.write');
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
       || (select string_agg(role_code, ' ' order by role_code) from auth.role_permissions
            where permission_code = 'ehr.catalog.facility-item.write') as c155_answer \gset
rollback to savepoint later_role;
select pg_temp.expect('3m another role given the code later: a run still answers "already applied"',
  '55000 0155: already applied | admin org_admin', :'c155_answer');

-- 4. Fictional staff, as the EHR API runtime.
-- Facilities A, B and C, and D with no items. Members (account n, the
-- membership at facility f is c1555000-...-0000000000<f><n>):
--   1 x admin at A; 2 y doctor at A; 3 z admin at B; 4 v admin at A and at B;
--   5 r admin at A, the role revoked; 6 w admin at C.
insert into identity.organizations (id, name, slug, active) values
  ('c1550000-0000-4000-8000-0000000000a1', 'Facility Items Org', 'facility-items-org-c155', true);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c1551000-0000-4000-8000-00000000000a', 'c1550000-0000-4000-8000-0000000000a1', 'Items Alpha', 'ITM-155-A',
   'Africa/Lagos', true, 'verified'),
  ('c1551000-0000-4000-8000-00000000000b', 'c1550000-0000-4000-8000-0000000000a1', 'Items Beta', 'ITM-155-B',
   'Africa/Lagos', true, 'verified'),
  ('c1551000-0000-4000-8000-00000000000c', 'c1550000-0000-4000-8000-0000000000a1', 'Items Gamma', 'ITM-155-C',
   'Africa/Lagos', true, 'verified'),
  ('c1551000-0000-4000-8000-00000000000d', 'c1550000-0000-4000-8000-0000000000a1', 'Items Delta', 'ITM-155-D',
   'Africa/Lagos', true, 'verified');
create function pg_temp.f(letter text) returns uuid language sql immutable as $$
  select ('c1551000-0000-4000-8000-00000000000' || $1)::uuid;
$$;
create function pg_temp.acct(who text) returns uuid language sql immutable as $$
  select ('c1552000-0000-4000-8000-00000000000' || position($1 in 'xyzvrw'))::uuid;
$$;
create function pg_temp.mem(who text, at text) returns uuid language sql immutable as $$
  select ('c1555000-0000-4000-8000-0000000000' || $2 || position($1 in 'xyzvrw'))::uuid;
$$;
create function pg_temp.item(k integer) returns uuid language sql immutable as $$
  select ('c155a000-0000-4000-8000-' || lpad($1::text, 12, '0'))::uuid;
$$;
create temporary table c155_member (who text, at text, role_code text, revoked boolean) on commit drop;
insert into c155_member values
  ('x', 'a', 'admin', false), ('y', 'a', 'doctor', false), ('z', 'b', 'admin', false), ('v', 'a', 'admin', false),
  ('v', 'b', 'admin', false), ('r', 'a', 'admin', true), ('w', 'c', 'admin', false);
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm, token_version)
select distinct pg_temp.acct(who), 'synthetic:items-0155:' || who, who || '@items-0155.invalid', 'active',
       'synthetic-hash', 'argon2id', 1
  from c155_member;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active)
select distinct on (who) ('c1554000-0000-4000-8000-00000000000' || position(who in 'xyzvrw'))::uuid, pg_temp.acct(who),
       'Items Staff ' || upper(who), who || '@items-0155.invalid', 'verified', role_code, true
  from c155_member order by who;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active)
select pg_temp.mem(who, at), ('c1554000-0000-4000-8000-00000000000' || position(who in 'xyzvrw'))::uuid,
       pg_temp.acct(who), 'c1550000-0000-4000-8000-0000000000a1', pg_temp.f(at), role_code, role_code, at <> 'b' or who = 'z',
       true
  from c155_member;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason,
  granted_at, revoked_at, revoked_by, revocation_reason)
select gen_random_uuid(), pg_temp.acct(who), role_code, 'facility', pg_temp.mem(who, at), pg_temp.f(at),
       'Synthetic 0155 suite role', clock_timestamp() - interval '1 day', case when revoked then clock_timestamp() end,
       case when revoked then pg_temp.acct('x') end, case when revoked then 'Synthetic 0155 suite revocation' end
  from c155_member;

create function pg_temp.session(subject text, membership uuid, facility uuid) returns void language sql as $$
  select set_config('app.actor_subject', coalesce($1, ''), true),
         set_config('app.membership_id', coalesce($2::text, ''), true),
         set_config('app.facility_id', coalesce($3::text, ''), true),
         set_config('app.correlation_id', 'c155-facility-items-suite', true);
$$;
create function pg_temp.as_member(who text, at text) returns void language sql as $$
  select pg_temp.session('synthetic:items-0155:' || $1, pg_temp.mem($1, $2), pg_temp.f($2));
$$;
create function pg_temp.no_session() returns void language sql as $$
  select pg_temp.session(null, null, null);
$$;
-- A member's session at a facility; a session with only a facility (no
-- member) when who is null; no session when both are null.
create function pg_temp.use(who text, at text) returns void language plpgsql as $$
begin
  if who is not null then
    perform pg_temp.as_member(who, at);
  else
    perform pg_temp.session(null, null, case when at is not null then pg_temp.f(at) end);
  end if;
end
$$;
-- Each of these sets the session first, in its own statement, then asks.
create function pg_temp.count_as(who text, at text) returns text language plpgsql as $$
begin
  perform pg_temp.use(who, at);
  return (select count(*)::text from ehr.catalog_facility_items);
end
$$;
-- A statement's answer: 'ok' and the rows it changed, or the SQLSTATE and the
-- constraint it broke (else the message).
create function pg_temp.try(statement text) returns text language plpgsql as $$
declare
  affected bigint;
  failed_constraint text;
begin
  execute statement;
  get diagnostics affected = row_count;
  return 'ok ' || affected;
exception when others then
  get stacked diagnostics failed_constraint = constraint_name;
  return sqlstate || ' ' || coalesce(nullif(failed_constraint, ''), sqlerrm);
end
$$;
-- The write check, asked in a session of these values.
create function pg_temp.allowed(subject text, membership uuid, facility uuid) returns text language plpgsql as $$
begin
  perform pg_temp.session(subject, membership, facility);
  return coalesce(ehr.facility_item_write_allowed()::text, 'null');
end
$$;
-- A medicine or a lab test added as the session's member, at its facility.
create function pg_temp.add(kind text, display text, idempotency_key text) returns text language sql as $$
  select pg_temp.try(format('insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name, '
    || 'idempotency_key, request_sha256, created_by, created_by_membership_id) values (%L, %L, %L, %L, %L, %L, %L, %L)',
    platform.current_facility_id(), $1, $2, case when $1 = 'medicine' then $2 end, $3, md5($3) || md5($3),
    platform.current_account_id(), platform.current_membership_id()));
$$;
-- A withdrawal or re-activation of one item, by the session's member, as
-- the service writes it (the row version + 1, the changed columns).
create function pg_temp.set_active(item uuid, active boolean) returns text language sql as $$
  select pg_temp.try(format('update ehr.catalog_facility_items set active = %L, row_version = row_version + 1, '
    || 'changed_by = %L, changed_by_membership_id = %L, changed_at = clock_timestamp() where id = %L',
    $2, platform.current_account_id(), platform.current_membership_id(), $1));
$$;
create function pg_temp.found(kind text, q text, lim integer) returns text language sql as $$
  select coalesce(string_agg(hit.display, '; ' order by hit.ordinality), '') || ' more='
         || coalesce(bool_or(hit.more)::text, 'false')
    from ehr.search_catalog_facility_items($1, $2, $3) with ordinality as hit;
$$;
create function pg_temp.status() returns text language sql as $$
  select string_agg(answer.kind || ' ' || answer.available || ' ' || answer.offered, '; ' order by answer.kind)
    from ehr.catalog_status() answer;
$$;
create function pg_temp.status_rows() returns text language sql as $$
  select string_agg(row(answer.*)::text, '; ' order by answer.kind) from ehr.catalog_status() answer;
$$;
create function pg_temp.add_as(who text, at text, kind text, display text, idempotency_key text) returns text
language plpgsql as $$
begin
  perform pg_temp.use(who, at);
  return pg_temp.add(kind, display, idempotency_key);
end
$$;
create function pg_temp.found_as(who text, at text, kind text, q text, lim integer) returns text language plpgsql as $$
begin
  perform pg_temp.use(who, at);
  return pg_temp.found(kind, q, lim);
end
$$;
create function pg_temp.status_as(who text, at text) returns text language plpgsql as $$
begin
  perform pg_temp.use(who, at);
  return pg_temp.status();
end
$$;
-- A change of one column of item 1 as the session's member, written as the
-- service writes a change (the row version + 1, the changed columns).
create function pg_temp.change(assignment text) returns text language sql as $$
  select pg_temp.try(format('update ehr.catalog_facility_items set %s, row_version = row_version + 1, changed_by = %L, '
    || 'changed_by_membership_id = %L, changed_at = clock_timestamp() where id = %L', $1, platform.current_account_id(),
    platform.current_membership_id(), pg_temp.item(1)));
$$;
-- 0152's status as a temporary copy (its md5 is checked below), to compare
-- answers row for row.
create function pg_temp.status_0152()
returns table (kind text, available boolean, list_version text, approved_at timestamptz, offered integer,
  attribution text[], file_sha256 text)
language sql
stable
as $$
  select kinds.kind, version_row.id is not null, version_row.version, version_row.approved_at,
         case kinds.kind
           when 'medicine' then (select count(*)::integer from ehr.catalog_medicines medicine
                                  where medicine.version_id = version_row.id and not medicine.withdrawn)
           when 'lab_test' then (select count(*)::integer from ehr.catalog_lab_tests test
                                  where test.version_id = version_row.id and not test.withdrawn)
           else (select count(*)::integer from ehr.catalog_diagnoses diagnosis
                  where diagnosis.version_id = version_row.id) end,
         coalesce(version_row.attribution, '{}'), version_row.file_sha256::text
    from (values ('diagnosis'), ('lab_test'), ('medicine')) as kinds(kind)
    left join ehr.catalog_versions version_row on version_row.kind = kinds.kind and version_row.active
   order by kinds.kind
$$;
create function pg_temp.status_0152_rows() returns text language sql as $$
  select string_agg(row(answer.*)::text, '; ' order by answer.kind) from pg_temp.status_0152() answer;
$$;
-- Every item as the suite's own role sees it (row security does not apply
-- to it), to show what a statement of the runtime left unchanged.
create function pg_temp.items_print(letter text) returns text language sql as $$
  select coalesce(string_agg(item.id || ' ' || item.active || ' ' || item.row_version, ', ' order by item.id), 'none')
    from ehr.catalog_facility_items item where item.facility_id = pg_temp.f($1);
$$;
-- Reads for a case's last part: a volatile function's query takes a new
-- snapshot, so it sees what the parts before it changed (a subquery of the
-- case itself would see the statement's first snapshot).
create function pg_temp.active_count(kind text) returns text language sql as $$
  select count(*)::text from ehr.catalog_facility_items where kind = $1 and active;
$$;
create function pg_temp.changed_line(item uuid) returns text language sql as $$
  select 'changed by ' || case when changed_by = pg_temp.acct('x') then 'x' else coalesce(changed_by::text, 'nobody') end
         || case when changed_at > now() - interval '1 minute' then ' now' else ' at ' || coalesce(changed_at::text, 'no time') end
    from ehr.catalog_facility_items where id = $1;
$$;
create function pg_temp.item_line(item uuid) returns text language sql as $$
  select 'version ' || row_version || ', created by '
         || case when created_by = pg_temp.acct('x') then 'x' else 'other' end || ', changed by '
         || case when changed_by is null then 'nobody'
                 when changed_by = pg_temp.acct('x') and changed_by_membership_id = pg_temp.mem('x', 'a')
                      and changed_at is not null then 'x' else 'other' end || ', '
         || case when created_at > now() - interval '1 minute' then 'created now' else 'created ' || created_at end
    from ehr.catalog_facility_items where id = $1;
$$;
-- Items for the lock waits at C, made with triggers off so this transaction
-- does not take C's lock (the guard would): one active, one withdrawn.
set local session_replication_role = replica;
insert into ehr.catalog_facility_items (id, facility_id, kind, display, generic_name, active, idempotency_key,
  request_sha256, created_by, created_by_membership_id) values
  (pg_temp.item(91), pg_temp.f('c'), 'medicine', 'Zinc sulfate 20 mg dispersible tablet', 'Zinc sulfate', true,
   'c155-key-w-0091-fixture', repeat('9', 64), pg_temp.acct('w'), pg_temp.mem('w', 'c')),
  (pg_temp.item(92), pg_temp.f('c'), 'medicine', 'Oral rehydration salts sachet', 'Oral rehydration salts', false,
   'c155-key-w-0092-fixture', repeat('9', 64), pg_temp.acct('w'), pg_temp.mem('w', 'c'));
set local session_replication_role = origin;
grant execute on all functions in schema pg_temp to public;

set local role hid_ehr_api_runtime;
select pg_temp.expect('4a the write check answers only for the session: an admin at the facility of the membership; never a doctor, another facility, another member''s membership, a revoked role or no session',
  'x at A: true | y (doctor) at A: false | z at B: true | v at A: true | v at B: true | x''s A membership at B: false | '
  || 'v''s B membership at A: false | r (role revoked) at A: false | x with v''s membership at A: false | no session: false',
  'x at A: ' || pg_temp.allowed('synthetic:items-0155:x', pg_temp.mem('x', 'a'), pg_temp.f('a'))
  || ' | y (doctor) at A: ' || pg_temp.allowed('synthetic:items-0155:y', pg_temp.mem('y', 'a'), pg_temp.f('a'))
  || ' | z at B: ' || pg_temp.allowed('synthetic:items-0155:z', pg_temp.mem('z', 'b'), pg_temp.f('b'))
  || ' | v at A: ' || pg_temp.allowed('synthetic:items-0155:v', pg_temp.mem('v', 'a'), pg_temp.f('a'))
  || ' | v at B: ' || pg_temp.allowed('synthetic:items-0155:v', pg_temp.mem('v', 'b'), pg_temp.f('b'))
  || ' | x''s A membership at B: ' || pg_temp.allowed('synthetic:items-0155:x', pg_temp.mem('x', 'a'), pg_temp.f('b'))
  || ' | v''s B membership at A: ' || pg_temp.allowed('synthetic:items-0155:v', pg_temp.mem('v', 'b'), pg_temp.f('a'))
  || ' | r (role revoked) at A: ' || pg_temp.allowed('synthetic:items-0155:r', pg_temp.mem('r', 'a'), pg_temp.f('a'))
  || ' | x with v''s membership at A: '
  || pg_temp.allowed('synthetic:items-0155:x', pg_temp.mem('v', 'a'), pg_temp.f('a'))
  || ' | no session: ' || pg_temp.allowed(null, null, null));
select pg_temp.expect('4b the EHR runtime may not ask auth.membership_has_permission itself (hence the write check)', '42501',
  left(pg_temp.try($s$select auth.membership_has_permission('synthetic:items-0155:x', pg_temp.mem('x', 'a'),
                        pg_temp.f('a'), 'ehr.catalog.facility-item.write')$s$), 5));
reset role;

-- The facility's lock: another session holds C's (7410, hashtext(C)); an add
-- and a re-activation at C wait for it, a withdrawal does not, and an add at
-- B goes on.
\if :c155_dblink_available
select public.dblink_connect('c155_other',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select public.dblink_exec('c155_other', 'begin') as began \gset
select public.dblink_exec('c155_other', format('do $d$ begin perform pg_advisory_xact_lock(7410, hashtext(%L)); end $d$',
                                               pg_temp.f('c')::text)) as locked \gset
set local role hid_ehr_api_runtime;
set local lock_timeout = '300ms';
select pg_temp.as_member('w', 'c');
select pg_temp.expect('4c another session holds C''s lock: w''s add at C and re-activation at C wait for it (ended by lock_timeout here); a withdrawal at C does not; z''s add at B goes on',
  'add at C: 55P03 canceling statement due to lock timeout | re-activation at C: 55P03 canceling statement due to lock '
  || 'timeout | withdrawal at C: ok 1 | C''s lock not taken | add at B: ok 1',
  'add at C: ' || pg_temp.add('lab_test', 'Stool microscopy (facility)', 'c155-key-w-0001-lab-test')
  || ' | re-activation at C: ' || pg_temp.set_active(pg_temp.item(92), true)
  || ' | withdrawal at C: ' || pg_temp.set_active(pg_temp.item(91), false)
  || ' | C''s lock ' || case when exists (select 1 from pg_locks lock_row
                                          where lock_row.pid = pg_backend_pid() and lock_row.locktype = 'advisory'
                                            and lock_row.classid = 7410
                                            and lock_row.objid::bigint = (hashtext(pg_temp.f('c')::text)::bigint + 4294967296) % 4294967296)
                              then 'taken' else 'not taken' end
  || ' | add at B: ' || pg_temp.add_as('z', 'b', 'medicine', 'Artemether 80 mg/mL injection', 'c155-key-z-0001-medicine'));
set local lock_timeout to default;
reset role;
select public.dblink_exec('c155_other', 'rollback') as ended \gset
select public.dblink_disconnect('c155_other') as disconnected \gset
\else
-- Without dblink: the same withdrawal at C and add at B, so the cases below
-- find the same items.
set local role hid_ehr_api_runtime;
select pg_temp.as_member('w', 'c');
select pg_temp.set_active(pg_temp.item(91), false) as c155_ignored \gset
select pg_temp.add_as('z', 'b', 'medicine', 'Artemether 80 mg/mL injection', 'c155-key-z-0001-medicine') as c155_ignored \gset
reset role;
\endif
set local role hid_ehr_api_runtime;
select pg_temp.as_member('w', 'c');
select pg_temp.expect('4d with C''s lock free: w adds at C and re-activates, holding C''s lock (7410, hashtext(facility)) until the end of the transaction',
  'ok 1 | ok 1 | held', pg_temp.add('lab_test', 'Stool microscopy (facility)', 'c155-key-w-0001-lab-test') || ' | '
  || pg_temp.set_active(pg_temp.item(92), true) || ' | '
  || case when exists (select 1 from pg_locks lock_row
                        where lock_row.pid = pg_backend_pid() and lock_row.locktype = 'advisory' and lock_row.granted
                          and lock_row.classid = 7410 and lock_row.objsubid = 2
                          and lock_row.objid::bigint = (hashtext(pg_temp.f('c')::text)::bigint + 4294967296) % 4294967296)
          then 'held' else 'not held' end);

-- x, an admin at A, adds a medicine and a lab test (without RETURNING, as
-- the service may), then a medicine with RETURNING.
select pg_temp.as_member('x', 'a');
select pg_temp.expect('4e x adds a medicine and a lab test at A',
  'ok 1 | ok 1',
  pg_temp.try($s$insert into ehr.catalog_facility_items (id, facility_id, kind, display, generic_name, strength,
      dose_form, routes, idempotency_key, request_sha256, created_by, created_by_membership_id)
    values (pg_temp.item(1), pg_temp.f('a'), 'medicine', 'Artemether + lumefantrine 20/120 mg dispersible tablet',
      'Artemether + lumefantrine', '20/120 mg', 'tablet', array['oral'], 'c155-key-x-0001-medicine', repeat('a', 64),
      pg_temp.acct('x'), pg_temp.mem('x', 'a'))$s$)
  || ' | ' || pg_temp.try($s$insert into ehr.catalog_facility_items (id, facility_id, kind, display, specimen, category,
      idempotency_key, request_sha256, created_by, created_by_membership_id)
    values (pg_temp.item(2), pg_temp.f('a'), 'lab_test', 'Malaria RDT (facility kit)', 'Blood (finger prick)',
      'parasitology', 'c155-key-x-0002-lab-test', repeat('b', 64), pg_temp.acct('x'), pg_temp.mem('x', 'a'))$s$));
with made as (
  insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name, strength, dose_form, routes,
    idempotency_key, request_sha256, created_by, created_by_membership_id)
  values (pg_temp.f('a'), 'medicine', 'Ceftriaxone 1 g powder for injection', 'Ceftriaxone', '1 g', 'injection',
    array['intravenous', 'intramuscular'], 'c155-key-x-0003-medicine', repeat('c', 64), pg_temp.acct('x'),
    pg_temp.mem('x', 'a'))
  returning id, row_version, created_by, created_by_membership_id, created_at, changed_by, changed_by_membership_id,
    changed_at, active)
select pg_temp.expect('4f with RETURNING too: the id is the HID-FACILITY code (36 characters, lower case); version 1, the creator, no change yet',
  '36 true | 1 true true recent no change true',
  (select length(id::text) || ' ' || (id::text = lower(id::text) and id::text ~ '^[0-9a-f-]{36}$') || ' | '
          || row_version || ' ' || (created_by = pg_temp.acct('x')) || ' '
          || (created_by_membership_id = pg_temp.mem('x', 'a')) || ' '
          || case when created_at between now() and clock_timestamp() then 'recent' else created_at::text end || ' '
          || case when num_nulls(changed_by, changed_by_membership_id, changed_at) = 3 then 'no change' else 'changed' end
          || ' ' || active
     from made));
select id as c155_item3 from ehr.catalog_facility_items where idempotency_key = 'c155-key-x-0003-medicine' \gset

-- Reads, search and status: each facility its own.
select pg_temp.expect('4g reads: A''s members read A''s items (the doctor too), B''s and C''s theirs; no session reads none',
  'x at A: 3 | y at A: 3 | z at B: 1 | v at B: 1 | w at C: 3 | none: 0',
  'x at A: ' || pg_temp.count_as('x', 'a') || ' | y at A: ' || pg_temp.count_as('y', 'a')
  || ' | z at B: ' || pg_temp.count_as('z', 'b') || ' | v at B: ' || pg_temp.count_as('v', 'b')
  || ' | w at C: ' || pg_temp.count_as('w', 'c') || ' | none: ' || pg_temp.count_as(null, null));
select pg_temp.as_member('x', 'a');
select pg_temp.expect('4h search at A: its items, each with its own display; names starting with q first',
  'Artemether + lumefantrine 20/120 mg dispersible tablet more=false | Artemether + lumefantrine 20/120 mg dispersible '
  || 'tablet more=false | Malaria RDT (facility kit) more=false | Ceftriaxone 1 g powder for injection more=false',
  pg_temp.found('medicine', 'artem', 10) || ' | ' || pg_temp.found('medicine', 'lumef artem', 10) || ' | '
  || pg_temp.found('lab_test', 'malaria', 10) || ' | ' || pg_temp.found('medicine', 'injection', 10));
select pg_temp.expect('4i the search answer carries the item''s own fields',
  'c155a000-0000-4000-8000-000000000001 | Artemether + lumefantrine | 20/120 mg | tablet | {oral} | - | - | false',
  (select hit.item_id || ' | ' || hit.generic_name || ' | ' || hit.strength || ' | ' || hit.dose_form || ' | '
          || hit.routes::text || ' | ' || coalesce(hit.specimen, '-') || ' | ' || coalesce(hit.category, '-') || ' | '
          || hit.more
     from ehr.search_catalog_facility_items('medicine', 'artemether', 5) hit));
select pg_temp.expect('4j search at B finds B''s only, though the search runs as the owner, who reads every facility; none without a session facility',
  'B: Artemether 80 mg/mL injection more=false | none: more=false',
  'B: ' || pg_temp.found_as('z', 'b', 'medicine', 'artem', 10)
  || ' | none: ' || btrim(pg_temp.found_as(null, null, 'medicine', 'artem', 10)));
select pg_temp.as_member('x', 'a');
select pg_temp.expect('4k the search refuses another kind, q of 1 or 101 characters and a limit of 0 or 26',
  '22023 CATALOG_SEARCH_INVALID | 22023 CATALOG_SEARCH_INVALID | 22023 CATALOG_SEARCH_INVALID | 22023 '
  || 'CATALOG_SEARCH_INVALID | 22023 CATALOG_SEARCH_INVALID',
  pg_temp.try($s$select * from ehr.search_catalog_facility_items('diagnosis', 'malaria', 10)$s$) || ' | '
  || pg_temp.try($s$select * from ehr.search_catalog_facility_items('medicine', 'a', 10)$s$) || ' | '
  || pg_temp.try(format('select * from ehr.search_catalog_facility_items(%L, %L, 10)', 'medicine', repeat('a', 101)))
  || ' | ' || pg_temp.try($s$select * from ehr.search_catalog_facility_items('medicine', 'artem', 0)$s$) || ' | '
  || pg_temp.try($s$select * from ehr.search_catalog_facility_items('medicine', 'artem', 26)$s$));
select pg_temp.expect('4l the status counts the session facility''s active items, and no other''s',
  'A: diagnosis false 0; lab_test true 1; medicine true 2 | B: diagnosis false 0; lab_test false 0; medicine true 1 | '
  || 'C: diagnosis false 0; lab_test true 1; medicine true 1 | D: diagnosis false 0; lab_test false 0; medicine false 0 | '
  || 'none: diagnosis false 0; lab_test false 0; medicine false 0',
  'A: ' || pg_temp.status_as('x', 'a') || ' | B: ' || pg_temp.status_as('z', 'b')
  || ' | C: ' || pg_temp.status_as('w', 'c') || ' | D: ' || pg_temp.status_as(null, 'd')
  || ' | none: ' || pg_temp.status_as(null, null));
reset role;
-- 0152's answer, row for row, in a session at D (a facility with no items)
-- and in no session.
create function pg_temp.as_0152(who text, at text) returns text language plpgsql as $$
begin
  perform pg_temp.use(who, at);
  return case when pg_temp.status_rows() = pg_temp.status_0152_rows() then 'same'
              else pg_temp.status_rows() || ' <> ' || pg_temp.status_0152_rows() end;
end
$$;
-- With a national medicine list active (fictional rows): with no facility
-- items or no session facility, the status is 0152's, row for row.
savepoint national;
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
values ('c155c000-0000-4000-8000-000000000001', 'medicine', '2026.1', repeat('1', 64), 'Synthetic approval (0155 suite)',
        repeat('2', 64), '2026-11-01');
insert into ehr.catalog_medicines (version_id, list_id, generic_name, dose_form, source) values
  ('c155c000-0000-4000-8000-000000000001', 'MED-00001', 'Amoxicillin', 'capsule', 'nigeria-eml-7'),
  ('c155c000-0000-4000-8000-000000000001', 'MED-00002', 'Paracetamol', 'tablet', 'nigeria-eml-7');
update ehr.catalog_versions set active = true where id = 'c155c000-0000-4000-8000-000000000001';
select pg_temp.expect('4m 0152''s answer, with a national list active: at D (no items) and with no session the same, row for row; at A its items added to offered',
  'af2b63e1d10f9922a69ab9ed216c5e09 | D: same | none: same | A: diagnosis false 0; lab_test true 1; medicine true 4',
  (select md5(prosrc) from pg_proc where oid = 'pg_temp.status_0152()'::regprocedure)
  || ' | D: ' || pg_temp.as_0152(null, 'd') || ' | none: ' || pg_temp.as_0152(null, null)
  || ' | A: ' || pg_temp.status_as('x', 'a'));
rollback to savepoint national;
select pg_temp.expect('4n 0152''s answer with no list active: D and no session the same, row for row', 'same same',
  pg_temp.as_0152(null, 'd') || ' ' || pg_temp.as_0152(null, null));

-- A session at A never writes B's items.
select pg_temp.items_print('a') as c155_a_before, pg_temp.items_print('b') as c155_b_before \gset
set local role hid_ehr_api_runtime;
select pg_temp.as_member('x', 'a');
select pg_temp.expect('4o x at A cannot add a B row, even without RETURNING', '42501',
  left(pg_temp.try($s$insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name, idempotency_key,
      request_sha256, created_by, created_by_membership_id)
    values (pg_temp.f('b'), 'medicine', 'Smuggled to B', 'Smuggled', 'c155-key-x-0004-medicine', repeat('d', 64),
      pg_temp.acct('x'), pg_temp.mem('x', 'a'))$s$), 5));
select pg_temp.as_member('v', 'a');
select pg_temp.expect('4p v, an admin at A and at B, in a session at A, cannot add a B row with v''s B membership (the key would hold), without or with RETURNING',
  '42501 new row violates row-level security policy for table "catalog_facility_items" | 42501',
  pg_temp.try($s$insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name, idempotency_key,
      request_sha256, created_by, created_by_membership_id)
    values (pg_temp.f('b'), 'medicine', 'Smuggled to B', 'Smuggled', 'c155-key-v-0001-medicine', repeat('d', 64),
      pg_temp.acct('v'), pg_temp.mem('v', 'b'))$s$)
  || ' | ' || left(pg_temp.try($s$insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name,
      idempotency_key, request_sha256, created_by, created_by_membership_id)
    values (pg_temp.f('b'), 'medicine', 'Smuggled to B', 'Smuggled', 'c155-key-v-0001-medicine', repeat('d', 64),
      pg_temp.acct('v'), pg_temp.mem('v', 'b')) returning id$s$), 5));
reset role;
select id as c155_b_item from ehr.catalog_facility_items where facility_id = pg_temp.f('b') \gset
set local role hid_ehr_api_runtime;
select pg_temp.as_member('x', 'a');
select pg_temp.expect('4q x at A cannot change B''s item by its id', 'ok 0',
  pg_temp.try(format($s$update ehr.catalog_facility_items set active = false, row_version = row_version + 1,
      changed_by = pg_temp.acct('x'), changed_by_membership_id = pg_temp.mem('x', 'a'), changed_at = clock_timestamp()
    where id = %L$s$, :'c155_b_item')));
-- An UPDATE that reads no column (no WHERE, constants only): only the
-- update policy chooses its rows.
select pg_temp.as_member('y', 'a');
select pg_temp.expect('4s y, a doctor at A, with an UPDATE that reads no column: changes nothing', 'ok 0',
  pg_temp.try($s$update ehr.catalog_facility_items set active = false, row_version = 2,
      changed_by = pg_temp.acct('y'), changed_by_membership_id = pg_temp.mem('y', 'a'), changed_at = clock_timestamp()$s$));
select pg_temp.as_member('z', 'b');
select pg_temp.expect('4t z, an admin at B, with an UPDATE that reads no column: changes B''s one item and none of A''s or C''s', 'ok 1',
  pg_temp.try($s$update ehr.catalog_facility_items set active = false, row_version = 2,
      changed_by = pg_temp.acct('z'), changed_by_membership_id = pg_temp.mem('z', 'b'), changed_at = clock_timestamp()$s$));
reset role;
select pg_temp.expect('4u A''s items as they were; B''s withdrawn by z', 'same | ' || :'c155_b_item' || ' false 2',
  case when pg_temp.items_print('a') = :'c155_a_before' then 'same' else pg_temp.items_print('a') end || ' | '
  || pg_temp.items_print('b'));
set local role hid_ehr_api_runtime;
select pg_temp.as_member('z', 'b');
select pg_temp.expect('4v z brings B''s item back', 'ok 1', pg_temp.set_active(:'c155_b_item'::uuid, true));

-- The session ties: the creator and the changer are the session's account and
-- membership.
select pg_temp.as_member('v', 'a');
select pg_temp.expect('4w v at A cannot add an item as x (x''s account and A membership: the key would hold)', '42501',
  left(pg_temp.try($s$insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name, idempotency_key,
      request_sha256, created_by, created_by_membership_id)
    values (pg_temp.f('a'), 'medicine', 'Added in x''s name', 'Amodiaquine', 'c155-key-v-0002-medicine', repeat('e', 64),
      pg_temp.acct('x'), pg_temp.mem('x', 'a'))$s$), 5));
select pg_temp.as_member('x', 'a');
select pg_temp.expect('4x x at A cannot add an item with v''s membership', '42501',
  left(pg_temp.try($s$insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name, idempotency_key,
      request_sha256, created_by, created_by_membership_id)
    values (pg_temp.f('a'), 'medicine', 'Added with v''s membership', 'Amodiaquine', 'c155-key-x-0005-medicine',
      repeat('e', 64), pg_temp.acct('x'), pg_temp.mem('v', 'a'))$s$), 5));
select pg_temp.expect('4y x''s change must name x and x''s membership as the changer: v''s account, v''s membership or no changer is refused',
  '42501 | 42501 | 42501',
  left(pg_temp.try(format($s$update ehr.catalog_facility_items set active = false, row_version = row_version + 1,
      changed_by = pg_temp.acct('v'), changed_by_membership_id = pg_temp.mem('v', 'a'), changed_at = clock_timestamp()
    where id = %L$s$, :'c155_item3')), 5)
  || ' | ' || left(pg_temp.try(format($s$update ehr.catalog_facility_items set active = false,
      row_version = row_version + 1, changed_by = pg_temp.acct('x'), changed_by_membership_id = pg_temp.mem('v', 'a'),
      changed_at = clock_timestamp() where id = %L$s$, :'c155_item3')), 5)
  || ' | ' || left(pg_temp.try(format($s$update ehr.catalog_facility_items set active = false,
      row_version = row_version + 1 where id = %L$s$, :'c155_item3')), 5));
select pg_temp.session('synthetic:items-0155:x', pg_temp.mem('v', 'a'), pg_temp.f('a'));
select pg_temp.expect('4z a session whose membership is another member''s (x with v''s), and no session: refused', '42501 | 42501',
  left(pg_temp.add('medicine', 'Added in a borrowed session', 'c155-key-x-0006-medicine'), 5) || ' | '
  || left(pg_temp.add_as(null, null, 'medicine', 'Added with no session', 'c155-key-x-0007-medicine'), 5));
select pg_temp.as_member('y', 'a');
select pg_temp.expect('4aa y, a doctor at A, cannot add an item, nor change one', '42501 | ok 0',
  left(pg_temp.add('lab_test', 'Doctor''s own test', 'c155-key-y-0001-lab-test'), 5) || ' | '
  || pg_temp.set_active(pg_temp.item(1), false));
select pg_temp.as_member('r', 'a');
select pg_temp.expect('4ab r, whose admin role is revoked, cannot add an item', '42501',
  left(pg_temp.add('lab_test', 'Revoked admin''s test', 'c155-key-r-0001-lab-test'), 5));

-- The guard: only active, row_version (old + 1) and the changed columns may
-- change.
select pg_temp.as_member('x', 'a');
select pg_temp.expect('4ac the guard keeps the id, facility, kind, names, fields, creator, time, key and digest',
  'id: 55000 FACILITY_ITEM_IMMUTABLE | facility_id: 55000 FACILITY_ITEM_IMMUTABLE | kind: 55000 FACILITY_ITEM_IMMUTABLE | '
  || 'display: 55000 FACILITY_ITEM_IMMUTABLE | generic_name: 55000 FACILITY_ITEM_IMMUTABLE | strength: 55000 '
  || 'FACILITY_ITEM_IMMUTABLE | dose_form: 55000 FACILITY_ITEM_IMMUTABLE | routes: 55000 FACILITY_ITEM_IMMUTABLE | '
  || 'created_by: 55000 FACILITY_ITEM_IMMUTABLE | created_by_membership_id: 55000 FACILITY_ITEM_IMMUTABLE | created_at: '
  || '55000 FACILITY_ITEM_IMMUTABLE | idempotency_key: 55000 FACILITY_ITEM_IMMUTABLE | request_sha256: 55000 '
  || 'FACILITY_ITEM_IMMUTABLE',
  'id: ' || pg_temp.change(format('id = %L', pg_temp.item(99)))
  || ' | facility_id: ' || pg_temp.change(format('facility_id = %L', pg_temp.f('b')))
  || ' | kind: ' || pg_temp.change('kind = ''lab_test''')
  || ' | display: ' || pg_temp.change('display = ''Artemether + lumefantrine (renamed)''')
  || ' | generic_name: ' || pg_temp.change('generic_name = ''Artemether''')
  || ' | strength: ' || pg_temp.change('strength = ''80/480 mg''')
  || ' | dose_form: ' || pg_temp.change('dose_form = ''capsule''')
  || ' | routes: ' || pg_temp.change('routes = array[''oral'', ''nasogastric'']')
  || ' | created_by: ' || pg_temp.change(format('created_by = %L', pg_temp.acct('v')))
  || ' | created_by_membership_id: ' || pg_temp.change(format('created_by_membership_id = %L', pg_temp.mem('v', 'a')))
  || ' | created_at: ' || pg_temp.change('created_at = created_at - interval ''1 day''')
  || ' | idempotency_key: ' || pg_temp.change('idempotency_key = ''c155-key-x-0099-medicine''')
  || ' | request_sha256: ' || pg_temp.change(format('request_sha256 = %L', repeat('f', 64))));
select pg_temp.expect('4ad the row version moves by one: the same or two more is refused', '55000 FACILITY_ITEM_IMMUTABLE | '
  || '55000 FACILITY_ITEM_IMMUTABLE',
  pg_temp.try(format($s$update ehr.catalog_facility_items set active = false, changed_by = pg_temp.acct('x'),
      changed_by_membership_id = pg_temp.mem('x', 'a'), changed_at = clock_timestamp() where id = %L$s$, pg_temp.item(1)))
  || ' | ' || pg_temp.try(format($s$update ehr.catalog_facility_items set active = false, row_version = row_version + 2,
      changed_by = pg_temp.acct('x'), changed_by_membership_id = pg_temp.mem('x', 'a'), changed_at = clock_timestamp()
    where id = %L$s$, pg_temp.item(1))));
-- A change is recorded at the time it is made: a time given (or none) is
-- replaced by now. Rolled back, so item 1 stays as it was.
savepoint change_time;
select pg_temp.expect('4at a change is recorded at the time it is made: a time given, or none, is replaced by now',
  'a time given: ok 1 | changed by x now | none: ok 1 | changed by x now',
  'a time given: ' || pg_temp.try(format($s$update ehr.catalog_facility_items set active = false,
      row_version = row_version + 1, changed_by = pg_temp.acct('x'), changed_by_membership_id = pg_temp.mem('x', 'a'),
      changed_at = '2001-01-01' where id = %L$s$, pg_temp.item(1)))
  || ' | ' || pg_temp.changed_line(pg_temp.item(1))
  || ' | none: ' || pg_temp.try(format($s$update ehr.catalog_facility_items set active = true,
      row_version = row_version + 1, changed_by = pg_temp.acct('x'), changed_by_membership_id = pg_temp.mem('x', 'a'),
      changed_at = null where id = %L$s$, pg_temp.item(1)))
  || ' | ' || pg_temp.changed_line(pg_temp.item(1)));
rollback to savepoint change_time;
-- As the suite's own role (row security would refuse a write without the
-- changer first): a time without a changer breaks the all-or-none CHECK.
reset role;
select pg_temp.expect('4ae the changed columns are all set or all empty', '23514 catalog_facility_items_changed_ck',
  pg_temp.try(format($s$update ehr.catalog_facility_items set active = false, row_version = row_version + 1,
      changed_at = clock_timestamp() where id = %L$s$, pg_temp.item(1))));
set local role hid_ehr_api_runtime;
select pg_temp.as_member('x', 'a');
select pg_temp.expect('4af an add starts at version 1, now, with no change recorded: a change given is refused',
  '55000 FACILITY_ITEM_IMMUTABLE | ok 1 | version 1, created by x, changed by nobody, created now',
  pg_temp.try($s$insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name, idempotency_key,
      request_sha256, created_by, created_by_membership_id, changed_by, changed_by_membership_id, changed_at)
    values (pg_temp.f('a'), 'medicine', 'Amoxicillin 250 mg dispersible tablet', 'Amoxicillin', 'c155-key-x-0008-medicine',
      repeat('e', 64), pg_temp.acct('x'), pg_temp.mem('x', 'a'), pg_temp.acct('x'), pg_temp.mem('x', 'a'), now())$s$)
  || ' | ' || pg_temp.try($s$insert into ehr.catalog_facility_items (id, facility_id, kind, display, generic_name,
      row_version, created_at, idempotency_key, request_sha256, created_by, created_by_membership_id)
    values (pg_temp.item(4), pg_temp.f('a'), 'medicine', 'Amoxicillin 250 mg dispersible tablet', 'Amoxicillin', 9,
      '2020-01-01', 'c155-key-x-0009-medicine', repeat('e', 64), pg_temp.acct('x'), pg_temp.mem('x', 'a'))$s$)
  || ' | ' || pg_temp.item_line(pg_temp.item(4)));
select pg_temp.expect('4ag each route 1-100 characters, at most 5, none empty; each kind keeps to its own fields; the names, dose forms and categories as listed',
  'empty route: 23514 FACILITY_ITEM_ROUTES_INVALID | blank route: 23514 FACILITY_ITEM_ROUTES_INVALID | long route: 23514 '
  || 'FACILITY_ITEM_ROUTES_INVALID | six routes: 23514 catalog_facility_items_routes_check | null route: 23514 '
  || 'catalog_facility_items_routes_check | medicine without a generic name: 23514 catalog_facility_items_kind_fields_ck | '
  || 'medicine with a category: 23514 catalog_facility_items_kind_fields_ck | test with a dose form: 23514 '
  || 'catalog_facility_items_kind_fields_ck | test with routes: 23514 catalog_facility_items_kind_fields_ck | blank name: '
  || '23514 catalog_facility_items_display_check | 501 characters: 23514 catalog_facility_items_display_check | dose form '
  || 'not listed: 23514 catalog_facility_items_dose_form_check | category not listed: 23514 '
  || 'catalog_facility_items_category_check | blood-bank (0149''s twelve): ok 1',
  (with tried(n, label, assignment) as (values
     (1, 'empty route', $v$'medicine', 'Route test', 'Route test', array['']::text[], null, null$v$),
     (2, 'blank route', $v$'medicine', 'Route test', 'Route test', array['  ']::text[], null, null$v$),
     (3, 'long route', format('%L, %L, %L, array[%L]::text[], null, null', 'medicine', 'Route test', 'Route test',
                              repeat('r', 101))),
     (4, 'six routes', $v$'medicine', 'Route test', 'Route test', array['oral', 'rectal', 'topical', 'nasal', 'buccal', 'vaginal'], null, null$v$),
     (5, 'null route', $v$'medicine', 'Route test', 'Route test', array['oral', null]::text[], null, null$v$),
     (6, 'medicine without a generic name', $v$'medicine', 'No generic name', null, '{}'::text[], null, null$v$),
     (7, 'medicine with a category', $v$'medicine', 'Category test', 'Category test', '{}'::text[], null, 'chemistry'$v$),
     (8, 'test with a dose form', $v$'lab_test', 'Dose form test', null, '{}'::text[], 'tablet', null$v$),
     (9, 'test with routes', $v$'lab_test', 'Routes test', null, array['oral'], null, null$v$),
     (10, 'blank name', $v$'lab_test', '   ', null, '{}'::text[], null, null$v$),
     (11, '501 characters', format('%L, %L, null, %L::text[], null, null', 'lab_test', repeat('n', 501), '{}')),
     (12, 'dose form not listed', $v$'medicine', 'Suppository test', 'Suppository test', '{}'::text[], 'suppository', null$v$),
     (13, 'category not listed', $v$'lab_test', 'Radiology test', null, '{}'::text[], null, 'radiology'$v$),
     (14, 'blood-bank (0149''s twelve)', $v$'lab_test', 'Group and crossmatch (facility)', null, '{}'::text[], null, 'blood-bank'$v$))
   select string_agg(tried.label || ': ' || pg_temp.try(format('insert into ehr.catalog_facility_items (facility_id, kind, '
            || 'display, generic_name, routes, dose_form, category, idempotency_key, request_sha256, created_by, '
            || 'created_by_membership_id) values (%L, %s, %L, %L, %L, %L)', pg_temp.f('a'), tried.assignment,
            'c155-key-x-01' || lpad(tried.n::text, 2, '0') || '-shape', repeat('e', 64), pg_temp.acct('x'),
            pg_temp.mem('x', 'a'))), ' | ' order by tried.n)
     from tried));
select pg_temp.expect('4ah the EHR runtime may not delete or truncate', '42501 | 42501',
  left(pg_temp.try(format('delete from ehr.catalog_facility_items where id = %L', pg_temp.item(1))), 5) || ' | '
  || left(pg_temp.try('truncate ehr.catalog_facility_items'), 5));
reset role;
select pg_temp.expect('4ai nor may anyone else: delete and truncate are refused by their triggers',
  '55000 ehr.catalog_facility_items is append-only | 55000 ehr.catalog_facility_items is append-only',
  pg_temp.try(format('delete from ehr.catalog_facility_items where id = %L', pg_temp.item(1))) || ' | '
  || pg_temp.try('truncate ehr.catalog_facility_items'));

-- The limits: one active name per kind at a facility; one Idempotency-Key per
-- creator; at most 500 active items of a kind at a facility.
set local role hid_ehr_api_runtime;
select pg_temp.as_member('x', 'a');
select pg_temp.expect('4aj one active name per kind at a facility (any case): another kind, or another facility, may share it',
  'same name: 23505 catalog_facility_items_active_name_uq | as a lab test: ok 1 | at B: ok 1',
  'same name: ' || pg_temp.add_as('x', 'a', 'medicine', 'ARTEMETHER + LUMEFANTRINE 20/120 mg dispersible tablet',
                                   'c155-key-x-0010-medicine')
  || ' | as a lab test: ' || pg_temp.add_as('x', 'a', 'lab_test', 'Ceftriaxone 1 g powder for injection',
                                            'c155-key-x-0011-lab-test')
  || ' | at B: ' || pg_temp.add_as('z', 'b', 'medicine', 'Ceftriaxone 1 g powder for injection',
                                   'c155-key-z-0002-medicine'));
select pg_temp.as_member('x', 'a');
select pg_temp.expect('4ak a withdrawn name may be added again; the withdrawn item cannot come back beside it (the name index on re-activation)',
  'withdraw: ok 1 | add again: ok 1 | re-activate: 23505 catalog_facility_items_active_name_uq',
  'withdraw: ' || pg_temp.set_active(pg_temp.item(1), false)
  || ' | add again: ' || pg_temp.add('medicine', 'Artemether + lumefantrine 20/120 mg dispersible tablet',
                                     'c155-key-x-0012-medicine')
  || ' | re-activate: ' || pg_temp.set_active(pg_temp.item(1), true));
select pg_temp.expect('4al an Idempotency-Key once per creator at a facility: x''s again is refused, v may use the same text',
  'x again: 23505 catalog_facility_items_key_uq | v: ok 1',
  'x again: ' || pg_temp.add_as('x', 'a', 'medicine', 'Quinine 300 mg tablet', 'c155-key-x-0012-medicine')
  || ' | v: ' || pg_temp.add_as('v', 'a', 'medicine', 'Quinine 300 mg tablet', 'c155-key-x-0012-medicine'));
select pg_temp.as_member('x', 'a');
select count(*) filter (where kind = 'medicine' and active) as c155_active_medicines from ehr.catalog_facility_items \gset
select pg_temp.expect('4am up to 500 active medicines at A, added in one statement (each counted after A''s lock)',
  'ok ' || (500 - :c155_active_medicines) || ' | 500',
  pg_temp.try(format($s$insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name, idempotency_key,
      request_sha256, created_by, created_by_membership_id)
    select pg_temp.f('a'), 'medicine', 'Cap medicine ' || n, 'Cap medicine ' || n,
      'c155-key-x-cap-' || lpad(n::text, 4, '0'), repeat('f', 64), pg_temp.acct('x'), pg_temp.mem('x', 'a')
      from generate_series(1, %s) n$s$, 500 - :c155_active_medicines))
  || ' | ' || pg_temp.active_count('medicine'));
select pg_temp.expect('4an the 501st is refused; a lab test still fits (per kind), and B takes a medicine (per facility)',
  '501st: P0001 FACILITY_ITEM_LIMIT | lab test: ok 1 | at B: ok 1',
  '501st: ' || pg_temp.add_as('x', 'a', 'medicine', 'One medicine too many', 'c155-key-x-0013-medicine')
  || ' | lab test: ' || pg_temp.add_as('x', 'a', 'lab_test', 'Widal test (facility)', 'c155-key-x-0014-lab-test')
  || ' | at B: ' || pg_temp.add_as('z', 'b', 'medicine', 'One medicine too many', 'c155-key-z-0003-medicine'));
select pg_temp.as_member('x', 'a');
select id as c155_cap1 from ehr.catalog_facility_items where idempotency_key = 'c155-key-x-cap-0001' \gset
select id as c155_cap2 from ehr.catalog_facility_items where idempotency_key = 'c155-key-x-cap-0002' \gset
select pg_temp.expect('4ao a withdrawal makes room: one more fits; then a re-activation is counted and refused, until another is withdrawn',
  'withdraw: ok 1 | add: ok 1 | re-activate: P0001 FACILITY_ITEM_LIMIT | withdraw another: ok 1 | re-activate: ok 1 | 500',
  'withdraw: ' || pg_temp.set_active(:'c155_cap1'::uuid, false)
  || ' | add: ' || pg_temp.add('medicine', 'Room for one more', 'c155-key-x-0015-medicine')
  || ' | re-activate: ' || pg_temp.set_active(:'c155_cap1'::uuid, true)
  || ' | withdraw another: ' || pg_temp.set_active(:'c155_cap2'::uuid, false)
  || ' | re-activate: ' || pg_temp.set_active(:'c155_cap1'::uuid, true)
  || ' | ' || pg_temp.active_count('medicine'));
select pg_temp.expect('4ap at the cap, the status counts 500 and the search answers 25 at most, with more',
  'diagnosis false 0; lab_test true 4; medicine true 500 | 25 more=true',
  pg_temp.status() || ' | ' || (select count(*) || ' more=' || bool_or(hit.more)
                                  from ehr.search_catalog_facility_items('medicine', 'cap medicine', 25) hit));

-- Withdrawn, then back: the same row and id (what Billing relies on).
select pg_temp.expect('4aq a withdrawn item keeps its row and id and comes back with them; each change counted, its creator kept, its changer recorded',
  'withdraw: ok 1 | not offered: more=false | back: ok 1 | offered: Ceftriaxone 1 g powder for injection more=false | '
  || 'version 3, created by x, changed by x, created now',
  'withdraw: ' || pg_temp.set_active(:'c155_item3'::uuid, false)
  || ' | not offered: ' || btrim(pg_temp.found('medicine', 'ceftriaxone', 10))
  || ' | back: ' || pg_temp.set_active(:'c155_item3'::uuid, true)
  || ' | offered: ' || pg_temp.found('medicine', 'ceftriaxone', 10)
  || ' | ' || pg_temp.item_line(:'c155_item3'::uuid));
-- At the cap again: the same add sent twice (its creator's key already on a
-- row, as when a second request waited for the first) is not counted, so the
-- service's ON CONFLICT inserts nothing and it answers as a replay; without
-- ON CONFLICT the key index refuses it; a new key is still the 501st.
select pg_temp.expect('4ar at the cap, an add whose key x already used: ON CONFLICT inserts nothing (a replay, not the cap); without it the key index refuses it; a new key is still refused',
  '500 | replay: ok 0 | without ON CONFLICT: 23505 catalog_facility_items_key_uq | new key: P0001 FACILITY_ITEM_LIMIT | 500',
  pg_temp.active_count('medicine')
  || ' | replay: ' || pg_temp.try($s$insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name,
      idempotency_key, request_sha256, created_by, created_by_membership_id)
    values (pg_temp.f('a'), 'medicine', 'Cap medicine 3', 'Cap medicine 3', 'c155-key-x-cap-0003', repeat('f', 64),
      platform.current_account_id(), platform.current_membership_id())
    on conflict on constraint catalog_facility_items_key_uq do nothing$s$)
  || ' | without ON CONFLICT: ' || pg_temp.add('medicine', 'Cap medicine three', 'c155-key-x-cap-0003')
  || ' | new key: ' || pg_temp.add('medicine', 'Cap medicine three', 'c155-key-x-0016-medicine')
  || ' | ' || pg_temp.active_count('medicine'));
reset role;
\if :c155_dblink_available
-- Under REPEATABLE READ the count would read the transaction's snapshot, not
-- what another transaction committed before letting the lock go, so an add is
-- refused there; under READ COMMITTED the same add passes the guard (a
-- foreign key then refuses its made-up facility). Another session, since
-- this transaction's level is set.
select public.dblink_connect('c155_isolation',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
create function pg_temp.add_elsewhere(isolation text) returns text language plpgsql as $$
declare
  answer text := 'inserted';
begin
  perform public.dblink_exec('c155_isolation', 'begin isolation level ' || isolation);
  if public.dblink_exec('c155_isolation', format('insert into ehr.catalog_facility_items (facility_id, kind, display, '
       || 'idempotency_key, request_sha256, created_by, created_by_membership_id) values (%L, %L, %L, %L, %L, %L, %L)',
       'c1551000-0000-4000-8000-0000000000ee', 'lab_test', 'Isolation test (facility)', 'c155-key-iso-0001-lab-test',
       repeat('a', 64), gen_random_uuid(), gen_random_uuid()), false) = 'ERROR' then
    answer := split_part(public.dblink_error_message('c155_isolation'), chr(10), 1);
  end if;
  perform public.dblink_exec('c155_isolation', 'rollback');
  return case when answer ~ 'violates foreign key constraint' then 'past the guard' else answer end;
end
$$;
select pg_temp.expect('4as an add under REPEATABLE READ is refused before the count; under READ COMMITTED it passes the guard',
  'repeatable read: ERROR:  FACILITY_ITEM_READ_COMMITTED | read committed: past the guard',
  'repeatable read: ' || pg_temp.add_elsewhere('repeatable read')
  || ' | read committed: ' || pg_temp.add_elsewhere('read committed'));
select public.dblink_disconnect('c155_isolation') as disconnected \gset
\endif

-- 5. The table's owner: it reads every facility's items (its read policy,
-- which the definer search and status need under FORCE); under FORCE its
-- UPDATE changes no row. A superuser owner skips row security.
-- The owner runs with no session, as the undo's script does.
select pg_temp.no_session();
select (select rolsuper from pg_roles where rolname = :'c155_owner') as c155_owner_super,
       (select count(*) from ehr.catalog_facility_items) as c155_items,
       (select count(*) from ehr.catalog_facility_items where active) as c155_active \gset
savepoint owner_update;
set local role :"c155_owner";
select pg_temp.expect('5a the owner reads every facility''s items', :'c155_items',
  (select count(*)::text from ehr.catalog_facility_items));
update ehr.catalog_facility_items set active = false, row_version = row_version + 1 where active;
select :ROW_COUNT as c155_changed \gset
reset role;
rollback to savepoint owner_update;
select pg_temp.expect('5b under FORCE the owner''s UPDATE changes no row (a superuser owner skips row security)',
  case when :'c155_owner_super' then :'c155_active' || ' (a superuser owner)' else '0' end,
  :'c155_changed' || case when :'c155_owner_super' then ' (a superuser owner)' else '' end);

-- 6. The undo from 0155's header, as the owner, in one transaction, with
-- items in use. Every lock first, NOWAIT, in one attempt.
create temporary table c155_versions_before on commit drop as
  select id, active, row_version from ehr.catalog_facility_items;
savepoint undo;
set local role :"c155_owner";
lock table auth.role_permissions in share row exclusive mode nowait;
lock table audit.events in row exclusive mode nowait;
lock table auth.roles, auth.permissions, auth.accounts, identity.staff_facility_memberships, identity.organizations,
  identity.facilities, identity.patients in row share mode nowait;
lock table ehr.catalog_versions, ehr.catalog_medicines, ehr.catalog_lab_tests, ehr.catalog_diagnoses
  in access share mode nowait;
lock table ehr.catalog_facility_items in access exclusive mode nowait;
-- 1. admin's row, with an audit row.
delete from auth.role_permissions where role_code = 'admin' and permission_code = 'ehr.catalog.facility-item.write';
insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
  provenance, source_system, details)
values ('0155-catalog-facility-items-undo', 'system', 'auth.role-permission.remove', 'success', 'role-permission',
        'admin/ehr.catalog.facility-item.write', 'healthcare-operations',
        'ORD-7 undo: hospital administrators no longer add or withdraw their facility''s own items', 'migration',
        'hid-0155-undo', jsonb_build_object('roleCode', 'admin', 'permissionCode', 'ehr.catalog.facility-item.write',
                                            'migration', '0155'));
-- 2. 0152's status, then its post-check.
create or replace function ehr.catalog_status()
returns table (kind text, available boolean, list_version text, approved_at timestamptz, offered integer,
  attribution text[], file_sha256 text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select kinds.kind, version_row.id is not null, version_row.version, version_row.approved_at,
         case kinds.kind
           when 'medicine' then (select count(*)::integer from ehr.catalog_medicines medicine
                                  where medicine.version_id = version_row.id and not medicine.withdrawn)
           when 'lab_test' then (select count(*)::integer from ehr.catalog_lab_tests test
                                  where test.version_id = version_row.id and not test.withdrawn)
           else (select count(*)::integer from ehr.catalog_diagnoses diagnosis
                  where diagnosis.version_id = version_row.id) end,
         coalesce(version_row.attribution, '{}'), version_row.file_sha256::text
    from (values ('diagnosis'), ('lab_test'), ('medicine')) as kinds(kind)
    left join ehr.catalog_versions version_row on version_row.kind = kinds.kind and version_row.active
   order by kinds.kind
$$;
comment on function ehr.catalog_status() is
  '0149 (ORD-7), 0152 (ORD-9): per kind (diagnosis, lab_test, medicine): whether an active version exists, its label, when it was approved, how many rows it offers, the notices its sources require and the sha256 of its seed file.';
do $$
begin
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'ehr.catalog_status()'::regprocedure
                    and md5(proc.prosrc) = 'af2b63e1d10f9922a69ab9ed216c5e09' and proc.provolatile = 's') then
    raise exception using errcode = '55000', message = '0155 undo: the status is not 0152''s';
  end if;
end $$;
-- 3. Every item withdrawn: FORCE lifted for this transaction, only active and
-- row_version changed (so the guard lets it through), FORCE restored.
alter table ehr.catalog_facility_items no force row level security;
update ehr.catalog_facility_items set active = false, row_version = row_version + 1 where active;
select :ROW_COUNT as c155_withdrawn \gset
alter table ehr.catalog_facility_items force row level security;
reset role;
select pg_temp.expect('6a the undo withdrew every active item with FORCE lifted, and restored FORCE', :'c155_active' || ' | true',
  :'c155_withdrawn' || ' | ' || (select relforcerowsecurity::text from pg_class
                                  where oid = 'ehr.catalog_facility_items'::regclass));
select pg_temp.expect('6b 0152''s status is back, as its owner, with 0149''s grants',
  'af2b63e1d10f9922a69ab9ed216c5e09 sql s true {"search_path=pg_catalog, pg_temp"} owner | hid_ehr_runtime '
  || 'hid_schema_test_runtime',
  (select md5(proc.prosrc) || ' ' || language_row.lanname || ' ' || proc.provolatile::text || ' ' || proc.prosecdef || ' '
          || proc.proconfig::text || ' '
          || case when proc.proowner = (select relowner from pg_class where oid = 'ehr.catalog_versions'::regclass)
                  then 'owner' else 'other' end || ' | '
          || (select string_agg(pg_get_userbyid(acl.grantee), ' ' order by 1) from aclexplode(proc.proacl) acl
               where acl.grantee <> proc.proowner)
     from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
    where proc.oid = 'ehr.catalog_status()'::regprocedure));
select pg_temp.expect('6c every row kept, none active; each withdrawn row one version on; the changed columns still all or none',
  :'c155_items' || ' rows, 0 active, ' || :'c155_active' || ' moved on, 0 broken',
  (select count(*) || ' rows, ' || count(*) filter (where active) || ' active, ' from ehr.catalog_facility_items)
  || (select count(*) from ehr.catalog_facility_items item
        join c155_versions_before before_row on before_row.id = item.id
       where before_row.active and item.row_version = before_row.row_version + 1) || ' moved on, '
  || (select count(*) from ehr.catalog_facility_items
       where num_nulls(changed_by, changed_by_membership_id, changed_at) not in (0, 3)) || ' broken');
select pg_temp.expect('6d admin''s row gone with one audit row; the code, the table, the write check and the search stay',
  '0 rows | 1 undo row: auth.role-permission.remove admin/ehr.catalog.facility-item.write | code true | '
  || 'ehr.catalog_facility_items ehr.facility_item_write_allowed() '
  || 'ehr.search_catalog_facility_items(text,text,integer)',
  (select count(*) || ' rows' from auth.role_permissions where permission_code = 'ehr.catalog.facility-item.write')
  || ' | ' || (select count(*) || ' undo row: ' || string_agg(action || ' ' || resource_id, ', ')
                 from audit.events where correlation_id = '0155-catalog-facility-items-undo')
  || ' | code ' || (select active::text from auth.permissions where code = 'ehr.catalog.facility-item.write')
  || ' | ' || to_regclass('ehr.catalog_facility_items')::text || ' '
  || to_regprocedure('ehr.facility_item_write_allowed()')::text || ' '
  || to_regprocedure('ehr.search_catalog_facility_items(text,text,integer)')::text);
set local role hid_ehr_api_runtime;
select pg_temp.as_member('x', 'a');
select pg_temp.expect('6e after the undo, x at A: no write; nothing offered; the status counts no facility item',
  'false | 42501 | more=false | diagnosis false 0; lab_test false 0; medicine false 0',
  pg_temp.allowed('synthetic:items-0155:x', pg_temp.mem('x', 'a'), pg_temp.f('a')) || ' | '
  || left(pg_temp.add('medicine', 'Added after the undo', 'c155-key-x-0016-medicine'), 5) || ' | '
  || btrim(pg_temp.found('medicine', 'ceftriaxone', 10)) || ' | ' || pg_temp.status());
reset role;
select pg_temp.expect('6f and 0152''s answer, row for row, at A and with no session', 'same same',
  pg_temp.as_0152('x', 'a') || ' ' || pg_temp.as_0152(null, null));
select pg_temp.no_session();
set local role :"c155_owner";
\set ON_ERROR_STOP off
:run0155
:ran0155
reset role;
select pg_temp.expect('6g after the undo, 0155 refuses to run again',
  '55000 0155: the facility items, their functions or the code ehr.catalog.facility-item.write exist, with other '
  || 'content than 0155 leaves; not in the reviewed state; nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint undo;

do $$
declare
  wanted integer := case when exists (select 1 from pg_extension where extname = 'dblink') then 85 else 79 end;
begin
  if currval('pg_temp.c155_passed') is distinct from wanted then
    raise exception '0155 facility items suite failed: % cases ran, % expected', currval('pg_temp.c155_passed'), wanted;
  end if;
  raise notice '0155 facility items suite: % cases passed', wanted;
end $$;
rollback;

\if :c155_dblink_available
\if :c155_dblink_create
drop extension dblink;
\endif
\endif
