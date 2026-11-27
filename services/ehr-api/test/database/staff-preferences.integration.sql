\set ON_ERROR_STOP on
-- 0206 (SX-7): staff preferences (language) and up to 12 Home shortcuts per
-- membership. On a migrated database 0206 has run already; the migration
-- file is also run here as written (psql \ir), as the runner runs it inside
-- its transaction. Rollback-only, apart from the dblink extension (made
-- before the transaction when the server has it and the suite's user may
-- make it, and dropped again) and the fictional account, organisation,
-- facility, staff row and membership the races' two sessions need (1d),
-- committed by a third session and deleted again; no row ever refers to them
-- outside a rolled-back transaction.
--   1. the file itself, first, before this transaction locks any table:
--      a. busy refusals (a second session holds auth.accounts in SHARE
--         mode): 0206 tries 50 times 100 ms apart (measured: 4.5 to 8
--         seconds) and refuses with 55P03 "0206: ... stayed busy for 5
--         seconds; nothing applied; run the release again at a quieter
--         time"; while this transaction already holds another file's strong
--         lock it refuses at once ("... so it does not wait; ..."). Both are
--         what the runner's dry run retries;
--      b. the locks: with 0206's objects moved aside (renamed, in a
--         savepoint), the file applies and adds exactly the locks its
--         header declares (SHARE ROW EXCLUSIVE on auth.accounts and
--         identity.staff_facility_memberships), nothing on audit.events or
--         any other existing table;
--      c. a second run answers "0206: already applied"; one table or one
--         function missing, a stray function of the same name, or a body
--         changed is "the schema is not in the reviewed state"; with the
--         objects moved aside: each of the six bodies the functions call,
--         changed, is refused by name; audit CHECKs that no longer admit a
--         staff 'auth.' row on 'session' with no facility are refused, and
--         ones with extra values are not (read tolerantly); a column the
--         file uses, renamed, is refused; a stray function of the names
--         with nothing else of 0206 there is refused; nothing applied;
--      d. the concurrent first save, of the preferences and of the
--         shortcuts (two more sessions each time): the second save waits
--         for the first's advisory lock; once the first is gone it saves as
--         the first save (version 1), with no unique violation and no key
--         reuse; and in its transaction an old first save sent after it
--         answers VERSION_CONFLICT.
--      The second sessions need dblink and a superuser (dblink refuses a
--      password-less connection to anyone else): without them 1a and 1d
--      are skipped and say so.
--   2. structure: columns, CHECKs, foreign keys (RESTRICT), row-level
--      security on with no policy, no trigger; the functions' security,
--      search_path and volatility; no body names a migration number (the
--      saves' advisory locks are seeded 0); privileges: only the Identity
--      runtime (and its API login, through it) executes the read and the
--      two saves; nobody but the owner holds anything on the tables or the
--      helpers.
--   Sections 3, 4 and 6 read and save through identity-api's own three
--   statements (READ_STAFF_PREFERENCES_SQL, SAVE_STAFF_PREFERENCES_SQL and
--   SAVE_STAFF_SHORTCUTS_SQL in staff-preferences.service.ts), word for word
--   in pg_temp.service_read, service_save_preferences and
--   service_save_shortcuts (staff-preferences.spec.ts compares them), each
--   save followed by the read, as the service does.
--   3. preferences: defaults (en, version 0, shortcuts null with no
--      membership named); the first save with version 0; replay (replayed
--      true, the row as it is, version unchanged); the same key with
--      another body (23505 IDEMPOTENCY_KEY_REUSED); a stale version (40001
--      VERSION_CONFLICT); input refusals; a platform administrator with no
--      membership saves; a disabled or inactive account, no subject and no
--      correlation id are refused (42501).
--   4. shortcuts: the membership must be the caller's, active, unheld, at
--      the named facility (42501 otherwise: another facility's, another
--      account's, an ended one, a held one); 0 and 12 items, the order
--      kept; 13 items, repeats, NULL, a nested array and every non-key
--      string (UUID, Health ID, matchRef, NIN, hyphenated, capitalised, too
--      short, too long) refused; replay, key reuse, version conflict; no
--      correlation id and a malformed SHA-256 refused; an array that does
--      not start at subscript 1 stored from 1; each membership's own row and
--      key; a reactivated membership reads its old row again; each of the
--      tables' own CHECKs (named) refuses a direct write the save would
--      refuse: count, repeats, shape, format, language, version,
--      Idempotency-Key and SHA-256.
--   5. audit: one row per save (and per replay), each passing the audit
--      CHECKs: preferences as auth.staff-preferences.update on 'session'
--      with no facility, membership or organization; shortcuts as
--      identity.staff-shortcuts.update with account, membership,
--      organization and facility; refusals leave none; the read writes
--      none; the contracted name identity.staff-preferences.update with no
--      facility is what the audit CHECKs refuse.
--   6. as the Identity API login (when this user may act as it): the
--      functions run; the tables cannot be read or written directly.
-- Synthetic values only: uuid prefix c206, .invalid addresses.
set plpgsql.variable_conflict = error;

select exists (select 1 from pg_available_extensions where name = 'dblink') as sx7_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as sx7_dblink_create,
       coalesce((select rolsuper from pg_roles where rolname = current_user), false) as sx7_superuser \gset
\if :sx7_dblink_available
\if :sx7_superuser
\else
\set sx7_dblink_available false
\endif
\endif
\if :sx7_dblink_available
\if :sx7_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0206 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0206_staff_preferences_and_shortcuts.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
-- A case: stops the suite at once when it fails. Counted in a setting until
-- 1 is done (no temporary relation may exist then: it would be a relation
-- this transaction holds at ACCESS EXCLUSIVE), then in a sequence, which
-- keeps its count across ROLLBACK TO SAVEPOINT.
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0206 staff preferences suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  if to_regclass('pg_temp.sx7_passed') is null then
    perform set_config('sx7.passed', (coalesce(nullif(current_setting('sx7.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.sx7_passed');
  end if;
  raise notice '0206 suite: % passed', case_name;
end
$$;
-- The runner's test for a file's own busy refusal (dry-run-attempts.mjs).
create function pg_temp.busy_refusal(sqlstate text, message text) returns text language sql immutable as $$
  select case when sqlstate = '55P03' and message ~ '^0206: '
                   and message ~ '(so it does not wait|stayed busy for 5 seconds)(; nothing applied)?; run the release again at a quieter time$'
              then 'busy refusal: ' || substring(message from '(so it does not wait|stayed busy for 5 seconds)')
              else sqlstate || ' ' || message end;
$$;
create function pg_temp.answer(sqlstate text, message text) returns text language sql immutable as $$
  select case when message = 'applied' then 'applied' else sqlstate || ' ' || message end;
$$;
-- 0206's objects as found: each name and its oid.
create function pg_temp.made() returns text language sql as $$
  select concat_ws(' ', to_regclass('identity.staff_preferences')::oid, to_regclass('identity.staff_shortcuts')::oid,
    to_regprocedure('identity.staff_shortcut_keys_valid(text[])')::oid,
    to_regprocedure('identity.staff_shortcut_keys_distinct(text[])')::oid,
    to_regprocedure('identity.read_my_staff_preferences()')::oid,
    to_regprocedure('identity.save_my_staff_preferences(text,bigint,text,text)')::oid,
    to_regprocedure('identity.save_my_staff_shortcuts(text[],bigint,text,text)')::oid);
$$;
create function pg_temp.lock_rank(mode text) returns integer language sql immutable as $$
  select array_position(array['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
    'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'], mode);
$$;
-- The SQLSTATE and message of a statement, or its one-value answer.
create function pg_temp.try(statement text) returns text language plpgsql as $$
declare
  answer text;
begin
  execute statement into answer;
  return coalesce(answer, '(null)');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$$;
grant execute on function pg_temp.try(text) to public;
-- 0206's objects moved aside (renamed: a rename locks only the object
-- renamed), so the file runs its preconditions as on a schema without it.
create function pg_temp.move_aside() returns void language plpgsql as $$
begin
  alter table identity.staff_preferences rename to sx7_suite_old_preferences;
  alter table identity.staff_shortcuts rename to sx7_suite_old_shortcuts;
  alter index identity.staff_preferences_pkey rename to sx7_suite_old_preferences_pkey;
  alter index identity.staff_shortcuts_pkey rename to sx7_suite_old_shortcuts_pkey;
  alter function identity.staff_shortcut_keys_valid(text[]) rename to sx7_suite_old_keys_valid;
  alter function identity.staff_shortcut_keys_distinct(text[]) rename to sx7_suite_old_keys_distinct;
  alter function identity.read_my_staff_preferences() rename to sx7_suite_old_read;
  alter function identity.save_my_staff_preferences(text, bigint, text, text) rename to sx7_suite_old_save_language;
  alter function identity.save_my_staff_shortcuts(text[], bigint, text, text) rename to sx7_suite_old_save_modules;
end
$$;
-- A body the functions call, changed by a comment (its md5 then differs).
create function pg_temp.change_body(signature text) returns void language plpgsql as $$
declare
  body text := (select proc.prosrc from pg_proc proc where proc.oid = signature::regprocedure);
begin
  execute replace(pg_get_functiondef(signature::regprocedure), body, body || '  -- changed by the 0206 suite' || chr(10));
end
$$;
select pg_temp.made() as made_at_start \gset

-- 1. The file itself.
-- 1a. Busy refusals.
\if :sx7_dblink_available
select pg_temp.expect('1a0 this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port')) as sx7_connection \gset
select public.dblink_connect('sx7_blocker', :'sx7_connection') as connected \gset
select public.dblink_exec('sx7_blocker', 'begin') as began \gset
select public.dblink_exec('sx7_blocker', 'lock table auth.accounts in share mode') as blocked \gset
select clock_timestamp() as busy_started \gset
:run0206
select extract(epoch from clock_timestamp() - :'busy_started'::timestamptz) as busy_seconds \gset
select pg_temp.expect('1a1 auth.accounts held by another session: 0206 tries 50 times 100 ms apart (4.5 to 8 seconds), then refuses as the runner retries',
  'busy refusal: stayed busy for 5 seconds | tried for 4.5 to 8 seconds | ' || :'made_at_start',
  pg_temp.busy_refusal(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
  || case when :'busy_seconds'::numeric between 4.5 and 8 then 'tried for 4.5 to 8 seconds'
          else 'tried for ' || round(:'busy_seconds'::numeric, 2) || ' seconds' end
  || ' | ' || pg_temp.made());
savepoint holding;
lock table identity.facilities in share mode;
:run0206
select pg_temp.made() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1a2 the same while this transaction holds an earlier file''s lock: refuses at once',
  'busy refusal: so it does not wait | ' || :'made_at_start',
  pg_temp.busy_refusal(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made_holding');
select public.dblink_exec('sx7_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('sx7_blocker') as disconnected \gset
\set sx7_dblink_cases 7
\else
\set sx7_dblink_cases 0
\echo '0206 suite: dblink with a superuser is not available here, so 1a (the busy refusals) and 1d (the race) are skipped'
\endif

-- 1b. The locks, with 0206's objects moved aside (renamed: a rename locks
-- only the object renamed, so auth.accounts and the memberships stay
-- unlocked until the file runs).
savepoint locks;
alter table identity.staff_preferences rename to sx7_suite_old_preferences;
alter table identity.staff_shortcuts rename to sx7_suite_old_shortcuts;
alter index identity.staff_preferences_pkey rename to sx7_suite_old_preferences_pkey;
alter index identity.staff_shortcuts_pkey rename to sx7_suite_old_shortcuts_pkey;
alter function identity.staff_shortcut_keys_valid(text[]) rename to sx7_suite_old_keys_valid;
alter function identity.staff_shortcut_keys_distinct(text[]) rename to sx7_suite_old_keys_distinct;
alter function identity.read_my_staff_preferences() rename to sx7_suite_old_read;
alter function identity.save_my_staff_preferences(text, bigint, text, text) rename to sx7_suite_old_save_language;
alter function identity.save_my_staff_shortcuts(text[], bigint, text, text) rename to sx7_suite_old_save_modules;
select coalesce(string_agg(lock_row.relation::text || ' ' || lock_row.mode, ',' order by lock_row.relation, lock_row.mode), '')
         as locks_before
  from pg_locks lock_row
 where lock_row.pid = pg_backend_pid() and lock_row.granted and lock_row.locktype = 'relation' \gset
:run0206
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE')
  || ' | added: ' || coalesce((select string_agg(table_name || ' ' || strongest, ', ' order by table_name)
     from (select namespace.nspname || '.' || class.relname as table_name,
                  (array_agg(lock_row.mode order by pg_temp.lock_rank(lock_row.mode) desc))[1] as strongest
             from pg_locks lock_row
             join pg_class class on class.oid = lock_row.relation and class.relkind in ('r', 'p')
             join pg_namespace namespace on namespace.oid = class.relnamespace
            where lock_row.pid = pg_backend_pid() and lock_row.granted and lock_row.locktype = 'relation'
              and namespace.nspname not in ('pg_catalog', 'information_schema') and namespace.nspname not like 'pg_temp%'
              and lock_row.relation not in (to_regclass('identity.staff_preferences'), to_regclass('identity.staff_shortcuts'))
              and (lock_row.relation::text || ' ' || lock_row.mode) <> all (string_to_array(:'locks_before', ','))
            group by namespace.nspname, class.relname) added), 'none')
  || ' | audit.events ' || coalesce((select (array_agg(lock_row.mode order by pg_temp.lock_rank(lock_row.mode) desc))[1]
                              from pg_locks lock_row
                             where lock_row.pid = pg_backend_pid() and lock_row.relation = 'audit.events'::regclass), 'none')
  as locks_added \gset
rollback to savepoint locks;
select pg_temp.expect('1b the locks: the tables and modes 0206''s Locks paragraph declares, nothing else, nothing stronger',
  'applied | added: auth.accounts ShareRowExclusiveLock, identity.staff_facility_memberships ShareRowExclusiveLock | audit.events none',
  :'locks_added');

-- 1c. Already applied, and half states.
:run0206
select pg_temp.expect('1c1 a second run answers "already applied" and changes nothing',
  '55000 0206: already applied | ' || :'made_at_start',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || pg_temp.made());
savepoint half;
drop function identity.read_my_staff_preferences();
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' as half_function \gset
rollback to savepoint half;
alter table identity.staff_shortcuts rename to sx7_suite_aside;
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' as half_table \gset
rollback to savepoint half;
create function identity.staff_shortcuts_extra() returns integer language sql as 'select 1';
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' as half_stray \gset
rollback to savepoint half;
create or replace function identity.staff_shortcut_keys_distinct(requested_keys text[]) returns boolean
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp as 'select true';
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' as half_body \gset
rollback to savepoint half;
select pg_temp.expect('1c2 half states refuse, nothing applied: a function missing, a table missing, a stray function of the name, a body changed',
  '55000 0206: the schema is not in the reviewed state; nothing applied (x4) | ' || :'made_at_start',
  case when :'half_function' = :'half_table' and :'half_table' = :'half_stray' and :'half_stray' = :'half_body'
       then :'half_function' || ' (x4)' else :'half_function' || ' / ' || :'half_table' || ' / ' || :'half_stray'
         || ' / ' || :'half_body' end || ' | ' || pg_temp.made());

-- 1c3. Each body the functions call, changed (with 0206's objects moved aside).
savepoint pinned;
select pg_temp.move_aside(), pg_temp.change_body('platform.current_actor_subject()');
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as pinned_1 \gset
rollback to savepoint pinned;
select pg_temp.move_aside(), pg_temp.change_body('platform.current_account_id()');
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as pinned_2 \gset
rollback to savepoint pinned;
select pg_temp.move_aside(), pg_temp.change_body('platform.current_membership_id()');
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as pinned_3 \gset
rollback to savepoint pinned;
select pg_temp.move_aside(), pg_temp.change_body('platform.current_facility_id()');
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as pinned_4 \gset
rollback to savepoint pinned;
select pg_temp.move_aside(), pg_temp.change_body('platform.current_correlation_id()');
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as pinned_5 \gset
rollback to savepoint pinned;
select pg_temp.move_aside(), pg_temp.change_body('auth.account_id_for_subject(text)');
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as pinned_6 \gset
rollback to savepoint pinned;
select pg_temp.expect('1c3 each of the six bodies the functions call, not as 0001-0074 left it (moved aside first): refused by name, nothing applied',
  (select string_agg('55000 0206: these bodies are not as 0001, 0002 and 0074 left them: ' || signature || '; nothing applied | none',
                     ' / ' order by position)
     from unnest(array['platform.current_actor_subject()', 'platform.current_account_id()', 'platform.current_membership_id()',
                       'platform.current_facility_id()', 'platform.current_correlation_id()',
                       'auth.account_id_for_subject(text)']) with ordinality as wanted(signature, position)),
  concat_ws(' / ', :'pinned_1', :'pinned_2', :'pinned_3', :'pinned_4', :'pinned_5', :'pinned_6'));

-- 1c4. The audit CHECKs (with 0206's objects moved aside): without the staff
-- 'auth.'/'session' exemption the preferences' audit row could never be
-- written, so the file refuses; with extra values beside it, it applies.
savepoint audit_checks;
select pg_temp.move_aside();
alter table audit.events drop constraint audit_actor_facility_ck;
alter table audit.events add constraint audit_actor_facility_ck check (facility_id is not null
  or actor_type = any (array['platform', 'patient', 'workload', 'system', 'legacy'])) not valid;
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as audit_facility_check \gset
rollback to savepoint audit_checks;
select pg_temp.move_aside();
alter table audit.events drop constraint events_check4;
alter table audit.events add constraint events_check4 check (actor_type <> 'staff'
  or (actor_account_id is not null and actor_membership_id is not null and facility_id is not null)) not valid;
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as audit_staff_check \gset
rollback to savepoint audit_checks;
select pg_temp.move_aside();
alter table audit.events drop constraint audit_actor_facility_ck;
alter table audit.events add constraint audit_actor_facility_ck check (facility_id is not null
  or actor_type = any (array['platform', 'patient', 'workload', 'system', 'legacy', 'sx7-suite-extra'])
  or (actor_type = 'staff' and action like 'auth.%' and resource_type = any (array['authentication', 'session', 'sx7-suite-extra'])))
  not valid;
:run0206
select pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as audit_tolerant \gset
rollback to savepoint audit_checks;
select pg_temp.expect('1c4 audit CHECKs without the staff ''auth.''/''session'' exemption are refused (each of the two), nothing applied; extra values beside it apply',
  '55000 0206: the audit CHECKs no longer admit a staff ''auth.'' row on ''session'' with no facility; nothing applied | none'
  || ' / 55000 0206: the audit CHECKs no longer admit a staff ''auth.'' row on ''session'' with no facility; nothing applied | none'
  || ' / applied | identity.staff_preferences',
  :'audit_facility_check' || ' / ' || :'audit_staff_check' || ' / ' || :'audit_tolerant');

-- 1c5. A column the file uses, renamed (0206's objects moved aside).
savepoint columns;
select pg_temp.move_aside();
alter table identity.staff_facility_memberships rename column migration_hold_reason to sx7_suite_hold_reason;
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as renamed_column \gset
rollback to savepoint columns;
select pg_temp.expect('1c5 a column the file uses, renamed: refused by name, nothing applied',
  '55000 0206: 0001 and 0002 must be applied first (missing or of another type: '
  || 'identity.staff_facility_memberships.migration_hold_reason) | none',
  :'renamed_column');

-- 1c6. Nothing of 0206 there but a stray function of its names.
savepoint stray;
select pg_temp.move_aside();
create function identity.staff_preferences_x() returns integer language sql as 'select 1';
:run0206
select :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || coalesce(to_regclass('identity.staff_preferences')::text, 'none')
  as stray_alone \gset
rollback to savepoint stray;
select pg_temp.expect('1c6 no 0206 object but a stray identity.staff_preferences_x(): not the reviewed state, nothing applied',
  '55000 0206: the schema is not in the reviewed state; nothing applied | none', :'stray_alone');

-- 1d. The concurrent first save.
\if :sx7_dblink_available
select public.dblink_connect('sx7_fixture', :'sx7_connection') as connected \gset
-- One fictional account with an active membership at its own facility (for
-- the shortcuts race), committed so the two sessions see it.
select public.dblink_exec('sx7_fixture',
  'insert into auth.accounts (id, subject, email, status) values (''c2061000-0000-4000-8000-0000000000d9'', '
  || '''synthetic:sx7-0206:race'', ''race@sx7-0206.invalid'', ''active'') on conflict (id) do nothing; '
  || 'insert into identity.organizations (id, name, slug, active) values (''c2060000-0000-4000-8000-0000000000d1'', '
  || '''Preferences Race Org'', ''preferences-race-org-c206'', true) on conflict (id) do nothing; '
  || 'insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values '
  || '(''c2060000-0000-4000-8000-0000000000d2'', ''c2060000-0000-4000-8000-0000000000d1'', ''Preferences Race'', '
  || '''SX7-RACE'', ''Africa/Lagos'', true, ''verified'') on conflict (id) do nothing; '
  || 'insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values '
  || '(''c2062000-0000-4000-8000-0000000000d9'', ''c2061000-0000-4000-8000-0000000000d9'', ''Preferences Race Staff'', '
  || '''race@sx7-0206.invalid'', ''verified'', ''doctor'', true) on conflict (id) do nothing; '
  || 'insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id, '
  || 'membership_role, app_role, is_primary, active) values (''c2063000-0000-4000-8000-0000000000d9'', '
  || '''c2062000-0000-4000-8000-0000000000d9'', ''c2061000-0000-4000-8000-0000000000d9'', '
  || '''c2060000-0000-4000-8000-0000000000d1'', ''c2060000-0000-4000-8000-0000000000d2'', ''doctor'', ''doctor'', true, true) '
  || 'on conflict (id) do nothing')
  as made_race \gset
select public.dblink_connect('sx7_first', :'sx7_connection') as connected \gset
select public.dblink_connect('sx7_second', :'sx7_connection') as connected \gset
select public.dblink_exec(conn, 'begin') from unnest(array['sx7_first', 'sx7_second']) conn;
select answer from unnest(array['sx7_first', 'sx7_second']) conn,
  lateral public.dblink(conn, 'select set_config(''app.actor_subject'', ''synthetic:sx7-0206:race'', true) || '
    || 'set_config(''app.correlation_id'', ''sx7-0206-race-' || replace(conn, '_', '-') || ''', true)') as result(answer text);
select answer as second_pid from public.dblink('sx7_second', 'select pg_backend_pid()::text') as result(answer text) \gset
select set_config('sx7.second_pid', :'second_pid', true) as noted \gset
select answer as first_saved from public.dblink('sx7_first',
  'select row(saved.*)::text from identity.save_my_staff_preferences(''en'', 0, ''sx7-race-first-key-0001'', '
  || 'repeat(''a'', 64)) saved') as result(answer text) \gset
select public.dblink_send_query('sx7_second',
  'select row(saved.*)::text from identity.save_my_staff_preferences(''en'', 0, ''sx7-race-second-key-01'', '
  || 'repeat(''b'', 64)) saved') as sent \gset
do $$
declare
  tries integer := 0;
begin
  while not exists (select 1 from pg_locks lock_row
                     where lock_row.pid = current_setting('sx7.second_pid')::integer
                       and lock_row.locktype = 'advisory' and not lock_row.granted) and tries < 50 loop
    perform pg_sleep(0.1);
    tries := tries + 1;
  end loop;
end
$$;
select pg_temp.expect('1d1 the second first save waits for the first''s advisory lock',
  '(en,1,f) | waiting on advisory',
  :'first_saved' || ' | ' || coalesce((select 'waiting on ' || lock_row.locktype from pg_locks lock_row
                                         where lock_row.pid = :'second_pid'::integer and not lock_row.granted), 'not waiting'));
select public.dblink_exec('sx7_first', 'rollback') as first_gone \gset
select answer as second_saved from public.dblink_get_result('sx7_second') as result(answer text) \gset
select answer as second_done from public.dblink_get_result('sx7_second') as result(answer text);
select count(*) as old_first_rows from public.dblink('sx7_second',
  'select row(saved.*)::text from identity.save_my_staff_preferences(''en'', 0, ''sx7-race-first-key-0001'', '
  || 'repeat(''a'', 64)) saved', false) as result(answer text) \gset
select coalesce(substring(public.dblink_error_message('sx7_second') from '(VERSION_CONFLICT|IDEMPOTENCY_KEY_REUSED|duplicate key)'),
                public.dblink_error_message('sx7_second')) as old_first_again \gset
select pg_temp.expect('1d2 once the first is gone the second saves as the first save: version 1, no unique violation, no key reuse; the old first save sent after it is a version conflict',
  '(en,1,f) | 0 VERSION_CONFLICT', :'second_saved' || ' | ' || :'old_first_rows' || ' ' || :'old_first_again');
select public.dblink_exec('sx7_second', 'rollback') as second_gone \gset
-- The same race for the shortcuts of one membership (its own advisory lock).
select public.dblink_exec(conn, 'begin') from unnest(array['sx7_first', 'sx7_second']) conn;
select answer from unnest(array['sx7_first', 'sx7_second']) conn,
  lateral public.dblink(conn, 'select set_config(''app.actor_subject'', ''synthetic:sx7-0206:race'', true) || '
    || 'set_config(''app.correlation_id'', ''sx7-0206-race-' || replace(conn, '_', '-') || ''', true) || '
    || 'set_config(''app.membership_id'', ''c2063000-0000-4000-8000-0000000000d9'', true) || '
    || 'set_config(''app.facility_id'', ''c2060000-0000-4000-8000-0000000000d2'', true)') as result(answer text);
select answer as first_shortcuts from public.dblink('sx7_first',
  'select saved.shortcuts_modules::text || '' v'' || saved.shortcuts_version || '' '' || saved.replayed '
  || 'from identity.save_my_staff_shortcuts(array[''patients''], 0, ''sx7-race-first-mod-0001'', repeat(''a'', 64)) saved')
  as result(answer text) \gset
select public.dblink_send_query('sx7_second',
  'select saved.shortcuts_modules::text || '' v'' || saved.shortcuts_version || '' '' || saved.replayed '
  || 'from identity.save_my_staff_shortcuts(array[''triage''], 0, ''sx7-race-second-mod-01'', repeat(''b'', 64)) saved')
  as sent \gset
do $$
declare
  tries integer := 0;
begin
  while not exists (select 1 from pg_locks lock_row
                     where lock_row.pid = current_setting('sx7.second_pid')::integer
                       and lock_row.locktype = 'advisory' and not lock_row.granted) and tries < 50 loop
    perform pg_sleep(0.1);
    tries := tries + 1;
  end loop;
end
$$;
select pg_temp.expect('1d3 the second first save of one membership''s shortcuts waits for the first''s advisory lock',
  '{patients} v1 false | waiting on advisory',
  :'first_shortcuts' || ' | ' || coalesce((select 'waiting on ' || lock_row.locktype from pg_locks lock_row
                                             where lock_row.pid = :'second_pid'::integer and not lock_row.granted), 'not waiting'));
select public.dblink_exec('sx7_first', 'rollback') as first_gone \gset
select answer as second_shortcuts from public.dblink_get_result('sx7_second') as result(answer text) \gset
select answer as second_done from public.dblink_get_result('sx7_second') as result(answer text);
select count(*) as old_first_shortcut_rows from public.dblink('sx7_second',
  'select saved.shortcuts_modules::text from identity.save_my_staff_shortcuts(array[''patients''], 0, '
  || '''sx7-race-first-mod-0001'', repeat(''a'', 64)) saved', false) as result(answer text) \gset
select coalesce(substring(public.dblink_error_message('sx7_second') from '(VERSION_CONFLICT|IDEMPOTENCY_KEY_REUSED|duplicate key)'),
                public.dblink_error_message('sx7_second')) as old_first_shortcuts_again \gset
select pg_temp.expect('1d4 once the first is gone the second saves the shortcuts as the first save: version 1, no unique violation, no key reuse; the old first save sent after it is a version conflict',
  '{triage} v1 false | 0 VERSION_CONFLICT',
  :'second_shortcuts' || ' | ' || :'old_first_shortcut_rows' || ' ' || :'old_first_shortcuts_again');
select public.dblink_exec('sx7_second', 'rollback') as second_gone \gset
select public.dblink_exec('sx7_fixture',
  'delete from identity.staff_facility_memberships where id = ''c2063000-0000-4000-8000-0000000000d9''; '
  || 'delete from identity.staff where id = ''c2062000-0000-4000-8000-0000000000d9''; '
  || 'delete from identity.facilities where id = ''c2060000-0000-4000-8000-0000000000d2''; '
  || 'delete from identity.organizations where id = ''c2060000-0000-4000-8000-0000000000d1''; '
  || 'delete from auth.accounts where id = ''c2061000-0000-4000-8000-0000000000d9''') as race_fixture_gone \gset
select public.dblink_disconnect(conn) from unnest(array['sx7_first', 'sx7_second', 'sx7_fixture']) conn;
\endif

create temporary sequence sx7_passed;
select setval('pg_temp.sx7_passed', coalesce(nullif(current_setting('sx7.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- 2. Structure and privileges.
select pg_temp.expect('2a columns',
  'staff_preferences: account_id uuid!, language text!, version bigint!, last_idempotency_key text!, '
  || 'last_request_sha256 text!, created_at timestamp with time zone!, updated_at timestamp with time zone! | '
  || 'staff_shortcuts: membership_id uuid!, facility_id uuid!, account_id uuid!, modules text[]!, version bigint!, '
  || 'last_idempotency_key text!, last_request_sha256 text!, created_at timestamp with time zone!, '
  || 'updated_at timestamp with time zone!',
  (select string_agg(table_columns, ' | ' order by table_name) from (
     select class.relname as table_name,
            class.relname || ': ' || string_agg(attribute.attname || ' ' || format_type(attribute.atttypid, attribute.atttypmod)
              || case when attribute.attnotnull then '!' else '' end, ', ' order by attribute.attnum) as table_columns
       from pg_class class join pg_attribute attribute on attribute.attrelid = class.oid
      where class.oid in ('identity.staff_preferences'::regclass, 'identity.staff_shortcuts'::regclass)
        and attribute.attnum > 0 and not attribute.attisdropped
      group by class.relname) per_table));
select pg_temp.expect('2b foreign keys: the account, and the membership by (id, facility_id, account_id), both RESTRICT',
  'identity.staff_preferences: auth.accounts(account_id)/r | identity.staff_shortcuts: identity.staff_facility_memberships(membership_id,facility_id,account_id)/r',
  (select string_agg(format('%s: %s(%s)/%s', conrelid::regclass::text, confrelid::regclass,
       (select string_agg(attname, ',' order by array_position(conkey, attnum)) from pg_attribute
         where attrelid = conrelid and attnum = any (conkey)), confdeltype), ' | ' order by conrelid::regclass::text)
     from pg_constraint where conrelid in ('identity.staff_preferences'::regclass, 'identity.staff_shortcuts'::regclass)
      and contype = 'f')
    ::text);
select pg_temp.expect('2c row-level security on and not forced, no policy, no trigger of its own',
  'true false 0 0 | true false 0 0',
  (select string_agg(class.relrowsecurity || ' ' || class.relforcerowsecurity || ' '
       || (select count(*) from pg_policy where polrelid = class.oid) || ' '
       || (select count(*) from pg_trigger where tgrelid = class.oid and not tgisinternal), ' | ' order by class.relname)
     from pg_class class where class.oid in ('identity.staff_preferences'::regclass, 'identity.staff_shortcuts'::regclass)));
select pg_temp.expect('2d functions: the read STABLE and the saves VOLATILE SECURITY DEFINER, the helpers IMMUTABLE invokers; all search_path pg_catalog, pg_temp, all the memberships'' owner''s',
  'read_my_staff_preferences s t | save_my_staff_preferences v t | save_my_staff_shortcuts v t | '
  || 'staff_shortcut_keys_distinct i f | staff_shortcut_keys_valid i f | 5 5',
  (select string_agg(proc.proname || ' ' || proc.provolatile::text || ' ' || case when proc.prosecdef then 't' else 'f' end, ' | '
                     order by proc.proname)
         || ' | ' || count(*) filter (where proc.proconfig = array['search_path=pg_catalog, pg_temp'])
         || ' ' || count(*) filter (where proc.proowner = (select relowner from pg_class
                                                          where oid = 'identity.staff_facility_memberships'::regclass))
     from pg_proc proc where proc.pronamespace = 'identity'::regnamespace
      and (proc.proname like '%staff\_preferences%' or proc.proname like '%staff\_shortcut%')));
select pg_temp.expect('2g no function body names a migration number; both saves seed their advisory lock 0',
  'saves seeded 0: save_my_staff_preferences,save_my_staff_shortcuts | bodies naming 206: none',
  'saves seeded 0: ' || coalesce((select string_agg(proc.proname, ',' order by proc.proname) from pg_proc proc
                                   where proc.pronamespace = 'identity'::regnamespace
                                     and (proc.proname like '%staff\_preferences%' or proc.proname like '%staff\_shortcut%')
                                     and proc.prosrc ~ 'pg_advisory_xact_lock\(hashtextextended\([^;]*, 0\)\);'), 'none')
  || ' | bodies naming 206: ' || coalesce((select string_agg(proc.proname, ',' order by proc.proname) from pg_proc proc
                                            where proc.pronamespace = 'identity'::regnamespace
                                              and (proc.proname like '%staff\_preferences%' or proc.proname like '%staff\_shortcut%')
                                              and proc.prosrc ~ '206'), 'none'));
create function pg_temp.may(role_name text) returns text language sql as $$
  select concat_ws(' ',
    case when to_regrole(role_name) is null and role_name <> 'public' then 'absent' end,
    'tables:' || (select count(*) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege
                   cross join unnest(array['identity.staff_preferences', 'identity.staff_shortcuts']) relation_name
                   where (to_regrole(role_name) is not null or role_name = 'public')
                     and has_table_privilege(role_name, relation_name, privilege)),
    'execute:' || coalesce((select string_agg(proc.proname, ',' order by proc.proname) from pg_proc proc
                             where proc.pronamespace = 'identity'::regnamespace
                               and (proc.proname like '%staff\_preferences%' or proc.proname like '%staff\_shortcut%')
                               and (to_regrole(role_name) is not null or role_name = 'public')
                               and has_function_privilege(role_name, proc.oid, 'EXECUTE')), '-'));
$$;
select pg_temp.expect('2e privileges: only the Identity runtime and its API login execute the read and the two saves; nobody holds a table privilege or runs a helper',
  'hid_identity_runtime tables:0 execute:read_my_staff_preferences,save_my_staff_preferences,save_my_staff_shortcuts | '
  || 'hid_identity_api_runtime tables:0 execute:read_my_staff_preferences,save_my_staff_preferences,save_my_staff_shortcuts | '
  || 'hid_ehr_runtime tables:0 execute:- | hid_schema_test_runtime tables:0 execute:- | hid_audit_writer tables:0 execute:- | '
  || 'public tables:0 execute:-',
  (select string_agg(role_name || ' ' || pg_temp.may(role_name), ' | ' order by position)
     from unnest(array['hid_identity_runtime', 'hid_identity_api_runtime', 'hid_ehr_runtime', 'hid_schema_test_runtime',
                       'hid_audit_writer', 'public']) with ordinality as wanted(role_name, position)));
select pg_temp.expect('2f the tables'' grants are the owner''s alone, the functions'' the owner''s and the Identity runtime''s (no PUBLIC)',
  'identity.staff_preferences: owner | identity.staff_shortcuts: owner | read: hid_identity_runtime,owner | '
  || 'save language: hid_identity_runtime,owner | save modules: hid_identity_runtime,owner | helpers: owner,owner',
  (select string_agg(class.oid::regclass::text || ': ' || (select string_agg(distinct case when acl.grantee = class.relowner then 'owner'
                                                                     else coalesce(pg_get_userbyid(nullif(acl.grantee, 0)), 'PUBLIC') end, ',')
                                                      from aclexplode(coalesce(class.relacl, acldefault('r', class.relowner))) acl),
                     ' | ' order by class.relname)
     from pg_class class where class.oid in ('identity.staff_preferences'::regclass, 'identity.staff_shortcuts'::regclass))
  || ' | read: ' || (select string_agg(distinct case when acl.grantee = proc.proowner then 'owner'
                       else coalesce(pg_get_userbyid(nullif(acl.grantee, 0)), 'PUBLIC') end, ',')
                       from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                      where proc.oid = 'identity.read_my_staff_preferences()'::regprocedure)
  || ' | save language: ' || (select string_agg(distinct case when acl.grantee = proc.proowner then 'owner'
                       else coalesce(pg_get_userbyid(nullif(acl.grantee, 0)), 'PUBLIC') end, ',')
                       from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                      where proc.oid = 'identity.save_my_staff_preferences(text,bigint,text,text)'::regprocedure)
  || ' | save modules: ' || (select string_agg(distinct case when acl.grantee = proc.proowner then 'owner'
                       else coalesce(pg_get_userbyid(nullif(acl.grantee, 0)), 'PUBLIC') end, ',')
                       from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                      where proc.oid = 'identity.save_my_staff_shortcuts(text[],bigint,text,text)'::regprocedure)
  || ' | helpers: ' || (select string_agg(case when acl.grantee = proc.proowner then 'owner'
                       else coalesce(pg_get_userbyid(nullif(acl.grantee, 0)), 'PUBLIC') end, ',' order by proc.proname)
                       from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                      where proc.oid in ('identity.staff_shortcut_keys_valid(text[])'::regprocedure,
                                         'identity.staff_shortcut_keys_distinct(text[])'::regprocedure)));

-- Fixtures. Organisation O with facilities F1 and F2. Accounts:
--   A staff, active memberships mA1 at F1 and mA2 at F2;
--   B staff, active membership mB1 at F1;
--   C staff, disabled until tomorrow, membership mC1 at F1;
--   D a platform administrator with no membership;
--   E staff, an ended membership mE1 at F1 and one held for migration mE2 at F2;
--   G staff, status 'locked', membership mG1 at F1.
insert into identity.organizations (id, name, slug, active) values
  ('c2060000-0000-4000-8000-0000000000a1', 'Preferences Test Org', 'preferences-test-org-c206', true);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c2060000-0000-4000-8000-0000000000f1', 'c2060000-0000-4000-8000-0000000000a1', 'Preferences Alpha', 'SX7-F1',
   'Africa/Lagos', true, 'verified'),
  ('c2060000-0000-4000-8000-0000000000f2', 'c2060000-0000-4000-8000-0000000000a1', 'Preferences Beta', 'SX7-F2',
   'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, status, disabled_until) values
  ('c2061000-0000-4000-8000-00000000000a', 'synthetic:sx7-0206:a', 'a@sx7-0206.invalid', 'active', null),
  ('c2061000-0000-4000-8000-00000000000b', 'synthetic:sx7-0206:b', 'b@sx7-0206.invalid', 'active', null),
  ('c2061000-0000-4000-8000-00000000000c', 'synthetic:sx7-0206:c', 'c@sx7-0206.invalid', 'active', now() + interval '1 day'),
  ('c2061000-0000-4000-8000-00000000000d', 'synthetic:sx7-0206:d', 'd@sx7-0206.invalid', 'active', null),
  ('c2061000-0000-4000-8000-00000000000e', 'synthetic:sx7-0206:e', 'e@sx7-0206.invalid', 'active', null),
  ('c2061000-0000-4000-8000-000000000001', 'synthetic:sx7-0206:g', 'g@sx7-0206.invalid', 'locked', null);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active)
select ('c2062000-0000-4000-8000-0000000000' || suffix)::uuid, ('c2061000-0000-4000-8000-0000000000' || suffix)::uuid,
       'Preferences Staff ' || suffix, suffix || '@sx7-0206.invalid', 'verified', 'doctor', true
  from unnest(array['0a', '0b', '0c', '0e', '01']) suffix;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, migration_hold_reason)
select ('c2063000-0000-4000-8000-0000000000' || member.id_suffix)::uuid,
       ('c2062000-0000-4000-8000-0000000000' || member.account_suffix)::uuid,
       ('c2061000-0000-4000-8000-0000000000' || member.account_suffix)::uuid,
       'c2060000-0000-4000-8000-0000000000a1', ('c2060000-0000-4000-8000-0000000000' || member.facility)::uuid,
       'doctor', 'doctor', member.facility = 'f1', member.active, member.hold
  from (values ('a1', '0a', 'f1', true, null), ('a2', '0a', 'f2', true, null), ('b1', '0b', 'f1', true, null),
               ('c1', '0c', 'f1', true, null), ('e1', '0e', 'f1', false, null),
               ('e2', '0e', 'f2', true, 'Synthetic 0206 suite hold'), ('01', '01', 'f1', true, null))
       member(id_suffix, account_suffix, facility, active, hold);

-- The caller (as identity-api sets the request): subject, membership, facility, correlation id.
create function pg_temp.as_caller(who text, membership text default '', facility text default '',
  correlation text default 'sx7-0206-suite-correlation') returns void language sql as $$
  select set_config('app.actor_subject', case when who = '' then '' else 'synthetic:sx7-0206:' || who end, true),
         set_config('app.membership_id', case when membership = '' then '' else 'c2063000-0000-4000-8000-0000000000' || membership end, true),
         set_config('app.facility_id', case when facility = '' then '' else 'c2060000-0000-4000-8000-0000000000' || facility end, true),
         set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.sha(body text) returns text language sql immutable as $$
  select encode(sha256(convert_to(body, 'UTF8')), 'hex');
$$;
-- identity-api's three statements (staff-preferences.service.ts), word for
-- word: READ_STAFF_PREFERENCES_SQL, SAVE_STAFF_PREFERENCES_SQL and
-- SAVE_STAFF_SHORTCUTS_SQL. staff-preferences.spec.ts compares each body
-- here with the constant, so sections 3, 4 and 6 test what the service sends.
create function pg_temp.service_read() returns table (preferences_language text, preferences_version text,
  shortcuts_facility_id text, shortcuts_modules text[], shortcuts_version text) language sql as $$
select read.preferences_language,
       read.preferences_version::text as preferences_version,
       read.shortcuts_facility_id::text as shortcuts_facility_id,
       read.shortcuts_modules,
       read.shortcuts_version::text as shortcuts_version
  from identity.read_my_staff_preferences() read
$$;
create function pg_temp.service_save_preferences(text, bigint, text, text) returns table (replayed boolean) language sql as $$
select saved.replayed
  from identity.save_my_staff_preferences($1::text, $2::bigint, $3::text, $4::text) saved
$$;
create function pg_temp.service_save_shortcuts(text[], bigint, text, text) returns table (replayed boolean) language sql as $$
select saved.replayed
  from identity.save_my_staff_shortcuts($1::text[], $2::bigint, $3::text, $4::text) saved
$$;
-- The read, as "language vN | shortcuts".
create function pg_temp.read() returns text language sql as $$
  select pg_temp.try('select read.preferences_language || '' v'' || read.preferences_version || '' | '' || '
    || 'coalesce(''at '' || right(read.shortcuts_facility_id, 2) || '' '' || array_to_string(read.shortcuts_modules, '','') '
    || '|| '' v'' || read.shortcuts_version, ''null'') from pg_temp.service_read() read');
$$;
-- A save as the service makes it: the save, then the read in the same
-- transaction; answered "(language,version,replayed)" for the preferences and
-- "facility {modules} vN replayed" for the shortcuts, or the refusal.
create function pg_temp.save_language(wanted_language text, expected bigint, idempotency_key text, body text default null,
  request_sha256 text default null) returns text language plpgsql as $$
declare
  was_replayed boolean;
  answer record;
begin
  select saved.replayed into was_replayed
    from pg_temp.service_save_preferences(wanted_language, expected, idempotency_key,
      coalesce(request_sha256, pg_temp.sha(coalesce(body, wanted_language || expected)))) saved;
  select read.* into answer from pg_temp.service_read() read;
  return '(' || answer.preferences_language || ',' || answer.preferences_version || ','
    || case when was_replayed then 't' else 'f' end || ')';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$$;
create function pg_temp.save_modules(modules text, expected bigint, idempotency_key text, body text default null,
  request_sha256 text default null) returns text language plpgsql as $$
declare
  wanted text[];
  was_replayed boolean;
  answer record;
begin
  execute format('select %s::text[]', modules) into wanted;
  select saved.replayed into was_replayed
    from pg_temp.service_save_shortcuts(wanted, expected, idempotency_key,
      coalesce(request_sha256, pg_temp.sha(coalesce(body, modules || expected)))) saved;
  select read.* into answer from pg_temp.service_read() read;
  return right(answer.shortcuts_facility_id, 2) || ' ' || answer.shortcuts_modules::text || ' v' || answer.shortcuts_version
    || ' ' || was_replayed::text;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$$;
-- As another caller, in order: set the caller, then read or save.
create function pg_temp.read_as(who text, membership text, facility text) returns text language plpgsql as $$
begin
  perform pg_temp.as_caller(who, membership, facility);
  return pg_temp.read();
end
$$;
create function pg_temp.save_modules_as(who text, membership text, facility text, modules text, expected bigint,
  idempotency_key text) returns text language plpgsql as $$
begin
  perform pg_temp.as_caller(who, membership, facility);
  return pg_temp.save_modules(modules, expected, idempotency_key);
end
$$;
create function pg_temp.audit_rows() returns text language sql as $$
  select coalesce(string_agg(concat_ws(' ', event.action, event.outcome, event.resource_type,
      case when event.resource_id = event.actor_account_id::text then 'account'
           when event.resource_id = event.actor_membership_id::text then 'membership' else event.resource_id end,
      'facility:' || coalesce(right(event.facility_id::text, 2), '-'),
      'membership:' || coalesce(right(event.actor_membership_id::text, 2), '-'),
      'organization:' || coalesce(right(event.organization_id::text, 2), '-'),
      event.actor_type, right(event.actor_account_id::text, 2), event.details::text), ' / ' order by event.sequence_id), 'none')
    from audit.events event where event.actor_subject like 'synthetic:sx7-0206:%';
$$;

-- 3. Preferences.
select pg_temp.as_caller('a');
select pg_temp.expect('3a never saved, no membership named: en, version 0, shortcuts null; the read writes no audit row',
  'en v0 | null | none', pg_temp.read() || ' | ' || pg_temp.audit_rows());
select pg_temp.expect('3b the first save, with version 0', '(en,1,f)', pg_temp.save_language('en', 0, 'sx7-suite-a-key-000001'));
select pg_temp.expect('3c read back', 'en v1 | null', pg_temp.read());
select pg_temp.expect('3d a replay (same key, same body): the row as it is, replayed, version unchanged', '(en,1,t)',
  pg_temp.save_language('en', 0, 'sx7-suite-a-key-000001'));
select pg_temp.expect('3e the same key with another body', '23505 IDEMPOTENCY_KEY_REUSED',
  pg_temp.save_language('en', 1, 'sx7-suite-a-key-000001'));
select pg_temp.expect('3f another first save (a new key, version 0): a version conflict, never a key reuse',
  '40001 VERSION_CONFLICT', pg_temp.save_language('en', 0, 'sx7-suite-a-key-000002'));
select pg_temp.expect('3g the next save with the version read; the database takes any two lower-case letters (identity-api only en)',
  '(fr,2,f) | fr v2 | null', pg_temp.save_language('fr', 1, 'sx7-suite-a-key-000003') || ' | ' || pg_temp.read());
select pg_temp.expect('3h an older key again is a new save: its stale version conflicts', '40001 VERSION_CONFLICT',
  pg_temp.save_language('en', 0, 'sx7-suite-a-key-000001'));
select pg_temp.expect('3i input refusals: language, key, SHA-256, version',
  '22023 LANGUAGE_NOT_AVAILABLE | 22023 LANGUAGE_NOT_AVAILABLE | 22023 LANGUAGE_NOT_AVAILABLE | 22023 IDEMPOTENCY_KEY_REQUIRED | '
  || '22023 IDEMPOTENCY_KEY_REQUIRED | 22023 IDEMPOTENCY_KEY_REQUIRED | 22023 STAFF_PREFERENCES_INVALID | 22023 STAFF_PREFERENCES_INVALID',
  concat_ws(' | ', pg_temp.save_language('EN', 2, 'sx7-suite-a-key-000004'),
    pg_temp.save_language('eng', 2, 'sx7-suite-a-key-000004'), pg_temp.save_language(null, 2, 'sx7-suite-a-key-000004', 'no language'),
    pg_temp.save_language('en', 2, 'short'), pg_temp.save_language('en', 2, null),
    pg_temp.save_language('en', 2, 'sx7-suite-a-key-000004', null, 'nothex'),
    pg_temp.save_language('en', -1, 'sx7-suite-a-key-000004'), pg_temp.save_language('en', null, 'sx7-suite-a-key-000004', 'no version')));
select pg_temp.expect('3j refused saves changed nothing', 'fr v2 | null', pg_temp.read());
select pg_temp.as_caller('d');
select pg_temp.expect('3k a platform administrator with no membership saves their own language', '(en,1,f) | en v1 | null',
  pg_temp.save_language('en', 0, 'sx7-suite-d-key-000001') || ' | ' || pg_temp.read());
select pg_temp.as_caller('c');
select pg_temp.read() || ' | ' || pg_temp.save_language('en', 0, 'sx7-suite-c-key-000001') as disabled_language \gset
select pg_temp.expect('3l a disabled account: refused read and saves',
  '42501 STAFF_PREFERENCES_NOT_ALLOWED | 42501 STAFF_PREFERENCES_NOT_ALLOWED | 42501 STAFF_PREFERENCES_NOT_ALLOWED | 42501 STAFF_PREFERENCES_NOT_ALLOWED',
  :'disabled_language' || ' | ' || pg_temp.read_as('c', 'c1', 'f1') || ' | '
  || pg_temp.save_modules_as('c', 'c1', 'f1', 'array[''patients'']', 0, 'sx7-suite-c-key-000002'));
select pg_temp.as_caller('g');
select pg_temp.expect('3m an account that is not active (locked): refused', '42501 STAFF_PREFERENCES_NOT_ALLOWED | 42501 STAFF_PREFERENCES_NOT_ALLOWED',
  pg_temp.read() || ' | ' || pg_temp.save_language('en', 0, 'sx7-suite-g-key-000001'));
select pg_temp.as_caller('');
select pg_temp.expect('3n no subject: refused', '42501 STAFF_PREFERENCES_NOT_ALLOWED | 42501 STAFF_PREFERENCES_NOT_ALLOWED',
  pg_temp.read() || ' | ' || pg_temp.save_language('en', 0, 'sx7-suite-x-key-000001'));
select pg_temp.as_caller('b', '', '', '');
select pg_temp.expect('3o no correlation id: the save is refused (its audit row needs one)', '42501 STAFF_PREFERENCES_NOT_ALLOWED',
  pg_temp.save_language('en', 0, 'sx7-suite-b-key-000001'));
select pg_temp.as_caller('b', 'zz', 'f1');
select pg_temp.expect('3p a malformed membership in the request is refused by the platform context (22023)',
  '22023 Invalid membership request context', pg_temp.read());

-- 4. Shortcuts.
select pg_temp.as_caller('a', 'a1', 'f1');
select pg_temp.expect('4a at a membership never saved: none, version 0', 'fr v2 | at f1  v0', pg_temp.read());
select pg_temp.expect('4b the first save, version 0, the order kept', 'f1 {triage,patients,labResults} v1 false',
  pg_temp.save_modules('array[''triage'', ''patients'', ''labResults'']', 0, 'sx7-suite-a-mod-000001'));
select pg_temp.expect('4c read back at that membership; not at the other', 'fr v2 | at f1 triage,patients,labResults v1 / fr v2 | at f2  v0',
  pg_temp.read_as('a', 'a1', 'f1') || ' / ' || pg_temp.read_as('a', 'a2', 'f2'));
select pg_temp.as_caller('a', 'a1', 'f1');
select pg_temp.expect('4d replay, key reuse, version conflict',
  'f1 {triage,patients,labResults} v1 true | 23505 IDEMPOTENCY_KEY_REUSED | 40001 VERSION_CONFLICT',
  concat_ws(' | ', pg_temp.save_modules('array[''triage'', ''patients'', ''labResults'']', 0, 'sx7-suite-a-mod-000001'),
    pg_temp.save_modules('array[''triage'']', 1, 'sx7-suite-a-mod-000001'),
    pg_temp.save_modules('array[''triage'']', 0, 'sx7-suite-a-mod-000002')));
select pg_temp.expect('4e twelve items, then none',
  'f1 {patients,registration,accessRequests,emergencyAccess,triage,consultation,orders,lab,labResults,pharmacy,prescriptions,migrate} v2 false | f1 {} v3 false',
  pg_temp.save_modules('array[''patients'', ''registration'', ''accessRequests'', ''emergencyAccess'', ''triage'', '
    || '''consultation'', ''orders'', ''lab'', ''labResults'', ''pharmacy'', ''prescriptions'', ''migrate'']', 1,
    'sx7-suite-a-mod-000003')
  || ' | ' || pg_temp.save_modules('array[]::text[]', 2, 'sx7-suite-a-mod-000004'));
select pg_temp.expect('4f thirteen items, a repeat, a NULL, a nested array',
  '22023 SHORTCUTS_TOO_MANY | 22023 SHORTCUT_DUPLICATE | 22023 SHORTCUT_INVALID | 22023 SHORTCUT_INVALID | 22023 SHORTCUT_INVALID',
  concat_ws(' | ',
    pg_temp.save_modules('array[''patients'', ''registration'', ''accessRequests'', ''emergencyAccess'', ''triage'', '
      || '''consultation'', ''orders'', ''lab'', ''labResults'', ''pharmacy'', ''prescriptions'', ''migrate'', ''outreach'']', 3,
      'sx7-suite-a-mod-000005'),
    pg_temp.save_modules('array[''triage'', ''patients'', ''triage'']', 3, 'sx7-suite-a-mod-000005'),
    pg_temp.save_modules('array[''triage'', null]', 3, 'sx7-suite-a-mod-000005'),
    pg_temp.save_modules('array[array[''triage''], array[''lab'']]', 3, 'sx7-suite-a-mod-000005'),
    pg_temp.save_modules('null::text[]', 3, 'sx7-suite-a-mod-000005')));
select pg_temp.expect('4g no string but a key''s shape: a UUID, a Health ID, a matchRef, a NIN, hyphens, a capital first, too short, too long, a space',
  '22023 SHORTCUT_INVALID (x9)',
  (select case when count(distinct outcome) = 1 then min(outcome) || ' (x' || count(*) || ')'
               else string_agg(outcome, ' | ') end
     from unnest(array['c2063000-0000-4000-8000-0000000000a1', 'HID-QPA2B3C4', 'psr_' || repeat('A', 43), '12345678901',
                       'find-patient', 'Patients', 'p', 'p' || repeat('a', 40), 'lab queue']) with ordinality item(value, n),
          lateral (select pg_temp.save_modules(format('array[%L]', item.value), 3, 'sx7-suite-a-mod-000006')) result(outcome)));
select pg_temp.expect('4h a key of the shape SX-1 does not know is the database''s to keep (identity-api refuses it first); 40 letters fit',
  'f1 {futureDepartmentKey,p' || repeat('a', 39) || '} v4 false',
  pg_temp.save_modules(format('array[''futureDepartmentKey'', %L]', 'p' || repeat('a', 39)), 3, 'sx7-suite-a-mod-000007'));
select pg_temp.as_caller('a', 'a1', 'f1', '');
select pg_temp.save_modules('array[''triage'']', 4, 'sx7-suite-a-mod-000008') as shortcuts_no_correlation \gset
select pg_temp.as_caller('a', 'a1', 'f1');
select pg_temp.expect('4i input refusals: no correlation id (its audit row needs one), key, SHA-256, version',
  '42501 STAFF_PREFERENCES_NOT_ALLOWED | 22023 IDEMPOTENCY_KEY_REQUIRED | 22023 IDEMPOTENCY_KEY_REQUIRED | 22023 STAFF_PREFERENCES_INVALID',
  concat_ws(' | ', :'shortcuts_no_correlation', pg_temp.save_modules('array[''triage'']', 4, 'short'),
    pg_temp.save_modules('array[''triage'']', 4, 'sx7-suite-a-mod-000008', null, 'nothex'),
    pg_temp.save_modules('array[''triage'']', -1, 'sx7-suite-a-mod-000008')));
select pg_temp.as_caller('a', 'a2', 'f2');
select pg_temp.expect('4j each membership has its own row and its own key: the same key at F2 is a new first save there',
  'f2 {patients} v1 false', pg_temp.save_modules('array[''patients'']', 0, 'sx7-suite-a-mod-000007'));
select pg_temp.save_modules('''[0:1]={lab,triage}''::text[]', 1, 'sx7-suite-a-mod-000010') as zero_based \gset
select pg_temp.expect('4j2 an array that does not start at subscript 1 is stored from 1, in order',
  'f2 {lab,triage} v2 false | stored from 1: {lab,triage}',
  :'zero_based' || ' | stored from ' || (select array_lower(shortcut.modules, 1) || ': ' || shortcut.modules::text from identity.staff_shortcuts shortcut
                            where shortcut.membership_id = 'c2063000-0000-4000-8000-0000000000a2'));
select pg_temp.expect('4k refused memberships: the caller''s at another facility, another account''s, half named (read and save); none named (save)',
  '42501 STAFF_SHORTCUTS_NOT_ALLOWED (x9)',
  (select case when count(distinct outcome) = 1 then min(outcome) || ' (x' || count(*) || ')'
               else string_agg(outcome, ' | ' order by n) end
     from unnest(array[pg_temp.read_as('a', 'a1', 'f2'), pg_temp.save_modules_as('a', 'a1', 'f2', 'array[''triage'']', 0, 'sx7-suite-a-mod-000009'),
                       pg_temp.read_as('a', 'b1', 'f1'), pg_temp.save_modules_as('a', 'b1', 'f1', 'array[''triage'']', 0, 'sx7-suite-a-mod-000009'),
                       pg_temp.read_as('a', 'a1', ''), pg_temp.save_modules_as('a', 'a1', '', 'array[''triage'']', 0, 'sx7-suite-a-mod-000009'),
                       pg_temp.read_as('a', '', 'f1'), pg_temp.save_modules_as('a', '', 'f1', 'array[''triage'']', 0, 'sx7-suite-a-mod-000009'),
                       pg_temp.save_modules_as('a', '', '', 'array[''triage'']', 0, 'sx7-suite-a-mod-000009')])
          with ordinality result(outcome, n)));
select pg_temp.expect('4l an ended membership and a membership held for migration: refused',
  '42501 STAFF_SHORTCUTS_NOT_ALLOWED | 42501 STAFF_SHORTCUTS_NOT_ALLOWED | 42501 STAFF_SHORTCUTS_NOT_ALLOWED | 42501 STAFF_SHORTCUTS_NOT_ALLOWED',
  concat_ws(' | ', pg_temp.read_as('e', 'e1', 'f1'), pg_temp.save_modules_as('e', 'e1', 'f1', 'array[''triage'']', 0, 'sx7-suite-e-mod-000001'),
    pg_temp.read_as('e', 'e2', 'f2'), pg_temp.save_modules_as('e', 'e2', 'f2', 'array[''triage'']', 0, 'sx7-suite-e-mod-000002')));
-- B saves at F1, then the membership ends and is reactivated (as 0086's attach_invited_member does).
select pg_temp.as_caller('b', 'b1', 'f1');
select pg_temp.expect('4m B''s own save at F1', 'f1 {lab} v1 false', pg_temp.save_modules('array[''lab'']', 0, 'sx7-suite-b-mod-000001'));
update identity.staff_facility_memberships set active = false where id = 'c2063000-0000-4000-8000-0000000000b1';
select pg_temp.expect('4n once the membership ends its row is not read or written', '42501 STAFF_SHORTCUTS_NOT_ALLOWED | 42501 STAFF_SHORTCUTS_NOT_ALLOWED',
  pg_temp.read() || ' | ' || pg_temp.save_modules('array[''lab'']', 1, 'sx7-suite-b-mod-000002'));
update identity.staff_facility_memberships set active = true where id = 'c2063000-0000-4000-8000-0000000000b1';
select pg_temp.expect('4o a reactivated membership (the same id) reads its old row again', 'en v0 | at f1 lab v1', pg_temp.read());
-- A direct write's refusal: its SQLSTATE and the constraint that refused it.
create function pg_temp.refused(statement text) returns text language sql as $$
  select split_part(outcome, ' ', 1) || ' ' || coalesce(substring(outcome from 'constraint "([^"]+)"'), outcome)
    from pg_temp.try(statement) outcome;
$$;
select pg_temp.expect('4p each of the tables'' own CHECKs refuses a direct write (as the owner) that the save refuses, by name',
  '23514 staff_shortcuts_keys_check | 23514 staff_shortcuts_distinct_check | 23514 staff_shortcuts_distinct_check'
  || ' | 23514 staff_shortcuts_count_check | 23514 staff_shortcuts_shape_check | 23514 staff_preferences_language_check'
  || ' | 23503 staff_shortcuts_membership_fkey | 23514 staff_preferences_version_check | 23514 staff_shortcuts_version_check'
  || ' | 23514 staff_preferences_key_check | 23514 staff_shortcuts_key_check | 23514 staff_preferences_sha256_check'
  || ' | 23514 staff_shortcuts_sha256_check',
  (select string_agg(pg_temp.refused(format('update %s set %s where %s returning 1', target, change, row_filter)), ' | '
                     order by position)
     from (values
       (1, 'identity.staff_shortcuts', 'modules = array[''HID-QPA2B3C4'']', 'membership_id = ''c2063000-0000-4000-8000-0000000000b1'''),
       (2, 'identity.staff_shortcuts', 'modules = array[''lab'', ''lab'']', 'membership_id = ''c2063000-0000-4000-8000-0000000000b1'''),
       (3, 'identity.staff_shortcuts', 'modules = array[''lab'', null]', 'membership_id = ''c2063000-0000-4000-8000-0000000000b1'''),
       -- Thirteen different keys of the right shape: only the count is wrong.
       (4, 'identity.staff_shortcuts', 'modules = array[''patients'', ''registration'', ''accessRequests'', ''emergencyAccess'', '
          || '''triage'', ''consultation'', ''orders'', ''lab'', ''labResults'', ''pharmacy'', ''prescriptions'', ''migrate'', '
          || '''outreach'']', 'membership_id = ''c2063000-0000-4000-8000-0000000000b1'''),
       (5, 'identity.staff_shortcuts', 'modules = ''[0:0]={lab}''::text[]', 'membership_id = ''c2063000-0000-4000-8000-0000000000b1'''),
       (6, 'identity.staff_preferences', 'language = ''EN''', 'account_id = ''c2061000-0000-4000-8000-00000000000a'''),
       (7, 'identity.staff_shortcuts', 'facility_id = ''c2060000-0000-4000-8000-0000000000f2''',
          'membership_id = ''c2063000-0000-4000-8000-0000000000b1'''),
       (8, 'identity.staff_preferences', 'version = 0', 'account_id = ''c2061000-0000-4000-8000-00000000000a'''),
       (9, 'identity.staff_shortcuts', 'version = 0', 'membership_id = ''c2063000-0000-4000-8000-0000000000b1'''),
       (10, 'identity.staff_preferences', 'last_idempotency_key = ''short''', 'account_id = ''c2061000-0000-4000-8000-00000000000a'''),
       (11, 'identity.staff_shortcuts', 'last_idempotency_key = ''short''', 'membership_id = ''c2063000-0000-4000-8000-0000000000b1'''),
       (12, 'identity.staff_preferences', 'last_request_sha256 = ''nothex''', 'account_id = ''c2061000-0000-4000-8000-00000000000a'''),
       (13, 'identity.staff_shortcuts', 'last_request_sha256 = ''nothex''', 'membership_id = ''c2063000-0000-4000-8000-0000000000b1''')
     ) as direct_write(position, target, change, row_filter)));

-- 5. Audit.
select pg_temp.expect('5a one row per save and per replay, in order; none for a refusal or a read',
  'auth.staff-preferences.update success session account facility:- membership:- organization:- staff 0a {"version": 1, "language": "en"}'
  || ' / auth.staff-preferences.update success session account facility:- membership:- organization:- staff 0a {"version": 1, "language": "en", "replayed": true}'
  || ' / auth.staff-preferences.update success session account facility:- membership:- organization:- staff 0a {"version": 2, "language": "fr"}'
  || ' / auth.staff-preferences.update success session account facility:- membership:- organization:- staff 0d {"version": 1, "language": "en"}'
  || ' / identity.staff-shortcuts.update success staff-membership membership facility:f1 membership:a1 organization:a1 staff 0a {"modules": ["triage", "patients", "labResults"], "version": 1}'
  || ' / identity.staff-shortcuts.update success staff-membership membership facility:f1 membership:a1 organization:a1 staff 0a {"modules": ["triage", "patients", "labResults"], "version": 1, "replayed": true}'
  || ' / identity.staff-shortcuts.update success staff-membership membership facility:f1 membership:a1 organization:a1 staff 0a {"modules": ["patients", "registration", "accessRequests", "emergencyAccess", "triage", "consultation", "orders", "lab", "labResults", "pharmacy", "prescriptions", "migrate"], "version": 2}'
  || ' / identity.staff-shortcuts.update success staff-membership membership facility:f1 membership:a1 organization:a1 staff 0a {"modules": [], "version": 3}'
  || ' / identity.staff-shortcuts.update success staff-membership membership facility:f1 membership:a1 organization:a1 staff 0a {"modules": ["futureDepartmentKey", "p' || repeat('a', 39) || '"], "version": 4}'
  || ' / identity.staff-shortcuts.update success staff-membership membership facility:f2 membership:a2 organization:a1 staff 0a {"modules": ["patients"], "version": 1}'
  || ' / identity.staff-shortcuts.update success staff-membership membership facility:f2 membership:a2 organization:a1 staff 0a {"modules": ["lab", "triage"], "version": 2}'
  || ' / identity.staff-shortcuts.update success staff-membership membership facility:f1 membership:b1 organization:a1 staff 0b {"modules": ["lab"], "version": 1}',
  pg_temp.audit_rows());
select pg_temp.expect('5b every row has the subject, the correlation id, provenance application and source identity-api; no patient, no purpose',
  '12 12 0',
  (select count(*) filter (where event.correlation_id = 'sx7-0206-suite-correlation' and event.provenance = 'application'
                                 and event.source_system = 'identity-api' and event.actor_subject is not null)
          || ' ' || count(*) || ' ' || count(*) filter (where event.patient_id is not null or event.purpose_of_use is not null)
     from audit.events event where event.actor_subject like 'synthetic:sx7-0206:%'));
select pg_temp.expect('5c (why auth.*) the contracted identity.staff-preferences.update, a staff row with no facility, is refused by the audit CHECKs',
  '23514',
  split_part(pg_temp.try('insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, action, outcome, '
    || 'resource_type, resource_id, provenance, source_system, details) values (''sx7-0206-suite-correlation'', ''staff'', '
    || '''synthetic:sx7-0206:a'', ''c2061000-0000-4000-8000-00000000000a'', ''identity.staff-preferences.update'', ''success'', '
    || '''session'', ''c2061000-0000-4000-8000-00000000000a'', ''application'', ''identity-api'', ''{}'') returning 1'), ' ', 1));

-- 6. As the Identity API login, when this user may act as it.
select pg_temp.try('select pg_has_role(current_user, ''hid_identity_api_runtime'', ''SET'')::text') = 'true' as sx7_act \gset
\if :sx7_act
select pg_temp.as_caller('a', 'a1', 'f1');
set local role hid_identity_api_runtime;
select pg_temp.read() as api_read,
       pg_temp.save_modules('array[''orders'']', 4, 'sx7-suite-a-api-00001') as api_save,
       pg_temp.try('select count(*)::text from identity.staff_preferences') as api_select_preferences,
       pg_temp.try('select count(*)::text from identity.staff_shortcuts') as api_select_shortcuts,
       pg_temp.try('update identity.staff_shortcuts set version = version returning 1') as api_update,
       pg_temp.try('select identity.staff_shortcut_keys_valid(array[''lab''])::text') as api_helper \gset
reset role;
select pg_temp.expect('6 as the Identity API login: the read and the save run; the tables and the helpers are refused',
  'fr v2 | at f1 futureDepartmentKey,p' || repeat('a', 39) || ' v4 | f1 {orders} v5 false | 42501 | 42501 | 42501 | 42501',
  :'api_read' || ' | ' || :'api_save' || ' | ' || split_part(:'api_select_preferences', ' ', 1) || ' | '
  || split_part(:'api_select_shortcuts', ' ', 1) || ' | ' || split_part(:'api_update', ' ', 1) || ' | '
  || split_part(:'api_helper', ' ', 1));
\set sx7_act_cases 1
\else
\set sx7_act_cases 0
\echo '0206 suite: this user may not act as hid_identity_api_runtime, so 6 is skipped (2e covers the privileges)'
\endif

select set_config('sx7.wanted', (50 + :sx7_dblink_cases + :sx7_act_cases)::text, true) as wanted \gset
do $$
begin
  if currval('pg_temp.sx7_passed') is distinct from current_setting('sx7.wanted')::bigint then
    raise exception '0206 staff preferences suite failed: % cases ran, % expected',
      currval('pg_temp.sx7_passed'), current_setting('sx7.wanted');
  end if;
  raise notice '0206 staff preferences suite: % cases passed', currval('pg_temp.sx7_passed');
end $$;
rollback;

\if :sx7_dblink_available
\if :sx7_dblink_create
drop extension dblink;
\endif
\endif
