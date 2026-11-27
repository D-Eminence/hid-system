\set ON_ERROR_STOP on
-- 0205 (SX-6): the migration file itself, run as written (psql \ir) the way
-- the runner runs it inside its transaction. Rollback-only, apart from the
-- dblink extension below. On a migrated database 0205 has run already:
--   1. busy refusals, first, before this transaction locks any table: a
--      second session (dblink) holds auth.accounts in ROW EXCLUSIVE mode (a
--      writer in flight; every reader goes on): the file tries for about 5
--      seconds (it takes at least 4.5) and refuses with 55P03 "0205:
--      auth.accounts stayed busy for 5 seconds; nothing applied; run the
--      release again at a quieter time"; when this transaction already holds
--      another file's strong lock, it refuses at once (in under a second:
--      "... so it does not wait; ..."). Both are the messages the runner's
--      dry run retries (its own number first, its wording last;
--      hid-system#306), and nothing is applied;
--   2. a second run answers "already applied" (55000) and changes nothing;
--      "already applied" needs the reviewed bodies: with any one of 0205's
--      four functions changed, the run answers "not in the reviewed state";
--   3. 0205 taken away for this transaction: a half state (one of its tables
--      there, or one function), a changed pinned body (each of the seven
--      0205 calls: 0001's platform.current_actor_subject,
--      platform.current_correlation_id and platform.reject_mutation, 0008's
--      auth.account_id_for_subject, 0096's auth.protect_deleted_account,
--      0098's identity.sealed_demo_account and 0123's
--      identity.sealed_qa_account) and a missing column refuse with 55000 and
--      apply nothing; then 0205 applies: two tables, four functions, owned by
--      auth.accounts' owner even when run by another role; it takes no lock
--      beyond its header's (SHARE ROW EXCLUSIVE on auth.accounts) and holds
--      that one; then "already applied" again.
-- Fictional values only.
set plpgsql.variable_conflict = error;

-- dblink is created before the transaction (creating it inside would lock its
-- result type at ACCESS EXCLUSIVE, which the file reads as "this transaction
-- holds an earlier migration's locks") and dropped again at the end.
select exists (select 1 from pg_available_extensions where name = 'dblink') as m205_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as m205_dblink_create \gset
\if :m205_dblink_available
\if :m205_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0205 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0205_own_password_and_name.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'

-- A case: stops the suite at once when it fails. (Functions only until 1 is
-- done: a temporary table or sequence would be a relation this transaction
-- holds at ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0205 migration suite failed: %: expected [%] got [%]', case_name, expected, coalesce(actual, 'null');
  end if;
  -- Counted in a setting until 1 is done, then in a sequence (which keeps its count across ROLLBACK TO SAVEPOINT).
  if to_regclass('pg_temp.m205_passed') is null then
    perform set_config('m205.passed', (coalesce(nullif(current_setting('m205.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.m205_passed');
  end if;
end
$$;
-- The runner's test for a file's own busy refusal (dry-run-attempts.mjs).
create function pg_temp.answer(file text, sqlstate text, message text) returns text language sql immutable as $$
  select case when sqlstate = '55P03' and message ~ ('^' || file || ': ')
                   and message ~ '(so it does not wait|stayed busy for 5 seconds)(; nothing applied)?; run the release again at a quieter time$'
              then 'busy refusal: ' || substring(message from '(so it does not wait|stayed busy for 5 seconds)')
              when sqlstate = '00000' then 'applied'
              else sqlstate || ' ' || message end;
$$;
-- A function's body changed for one case (a comment added at its end), whatever its language.
create function pg_temp.change_body(signature text) returns void language plpgsql as $$
declare
  definition text := pg_get_functiondef(to_regprocedure(signature));
begin
  if right(definition, 11) <> E'$function$\n' then
    raise exception 'unexpected definition of %', signature;
  end if;
  execute left(definition, -11) || E'-- changed for this case\n$function$';
end
$$;
-- What the file makes, in one line.
create function pg_temp.made0205() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('auth.staff_name_changes'),
            to_regclass('auth.password_change_requests')))
      || ' tables, ' || (select count(*) from pg_proc where pronamespace = 'auth'::regnamespace
                          and proname in ('staff_person_name_acceptable', 'change_own_password',
                                          'change_own_display_name', 'own_profile_version'))
      || ' functions';
$$;

-- 1. Busy refusals.
\if :m205_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('m205_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select pg_temp.made0205() as made0205_before \gset
select public.dblink_exec('m205_blocker', 'begin') as began \gset
select public.dblink_exec('m205_blocker', 'lock table auth.accounts in row exclusive mode') as blocked \gset
select clock_timestamp() as m205_tried_from \gset
:run0205
select pg_temp.expect('1b auth.accounts written by another session: 0205 tries for 5 seconds, then refuses as the runner retries',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0205_before' || ' | tried for 4.5 seconds or more',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205() || ' | '
  || case when clock_timestamp() - :'m205_tried_from'::timestamptz >= interval '4.5 seconds'
          then 'tried for 4.5 seconds or more'
          else 'tried for ' || (clock_timestamp() - :'m205_tried_from'::timestamptz)::text end);
savepoint holding;
lock table ehr.catalog_versions in share mode;
select clock_timestamp() as m205_tried_from \gset
:run0205
select pg_temp.made0205() as made0205_holding,
       clock_timestamp() - :'m205_tried_from'::timestamptz < interval '1 second' as m205_at_once \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: 0205 refuses at once',
  'busy refusal: so it does not wait | ' || :'made0205_before' || ' | in under a second',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made0205_holding' || ' | '
  || case when :'m205_at_once'::boolean then 'in under a second' else 'after waiting' end);
select public.dblink_exec('m205_blocker', 'rollback') as ended \gset
-- A reader in flight does not stop it (ACCESS SHARE, as every request's session check takes).
select public.dblink_exec('m205_blocker', 'begin') as began \gset
select public.dblink_exec('m205_blocker', 'lock table auth.accounts in access share mode') as blocked \gset
:run0205
select pg_temp.expect('1d auth.accounts read by another session: 0205 is not held up (it answers already applied at once)',
  '55000 0205: already applied', pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select public.dblink_exec('m205_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('m205_blocker') as disconnected \gset
\else
\echo '0205 migration suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

create temporary sequence m205_passed;
select setval('pg_temp.m205_passed', coalesce(nullif(current_setting('m205.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- 2. A second run.
select pg_temp.expect('2a 0205 is applied here', '2 tables, 4 functions', pg_temp.made0205());
:run0205
select pg_temp.expect('2b 0205 again: already applied, nothing changed', '55000 0205: already applied | 2 tables, 4 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
-- "Already applied" needs the reviewed bodies: with one of the four changed, the run refuses as a half state.
savepoint s205_bodies;
select pg_temp.change_body('auth.staff_person_name_acceptable(text)');
:run0205
rollback to savepoint s205_bodies;
select pg_temp.expect('2c the name rule''s body changed: not already applied, refused',
  '55000 0205: the schema is not in the reviewed state (part of 0205 is there); nothing applied',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.change_body('auth.change_own_password(uuid, uuid, text, text, text, uuid, uuid, text, timestamptz, inet, text)');
:run0205
rollback to savepoint s205_bodies;
select pg_temp.expect('2c the password change''s body changed: not already applied, refused',
  '55000 0205: the schema is not in the reviewed state (part of 0205 is there); nothing applied',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.change_body('auth.change_own_display_name(text, bigint, text, uuid, inet, text)');
:run0205
rollback to savepoint s205_bodies;
select pg_temp.expect('2c the name edit''s body changed: not already applied, refused',
  '55000 0205: the schema is not in the reviewed state (part of 0205 is there); nothing applied',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.change_body('auth.own_profile_version()');
:run0205
rollback to savepoint s205_bodies;
select pg_temp.expect('2c the profile version''s body changed: not already applied, refused',
  '55000 0205: the schema is not in the reviewed state (part of 0205 is there); nothing applied',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
release savepoint s205_bodies;

-- The locks the file adds, on tables that were there before it ran: (table, mode) pairs held by this backend after
-- the run and not before; catalogs, temporary objects and the runner's own schema left out.
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
create temporary table existing_tables as
  select array_agg(relation.oid::regclass) as tables from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
   where relation.relkind in ('r', 'p', 'v', 'm')
     and namespace.nspname not in ('pg_catalog', 'information_schema', 'migration')
     and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'
     and relation.oid not in (to_regclass('auth.staff_name_changes'), to_regclass('auth.password_change_requests'));

-- 3. 0205 taken away for this transaction.
drop function auth.change_own_password(uuid, uuid, text, text, text, uuid, uuid, text, timestamptz, inet, text),
  auth.change_own_display_name(text, bigint, text, uuid, inet, text), auth.own_profile_version(),
  auth.staff_person_name_acceptable(text);
drop table auth.staff_name_changes, auth.password_change_requests;
select pg_temp.expect('3a the state before 0205, for this transaction', '0 tables, 0 functions', pg_temp.made0205());

savepoint s205;
create table auth.staff_name_changes (id integer);
:run0205
rollback to savepoint s205;
select pg_temp.expect('3b a half state (one of its tables there) is refused, nothing applied',
  '55000 0205: the schema is not in the reviewed state (part of 0205 is there); nothing applied | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
create function auth.own_profile_version() returns bigint language sql as 'select 1::bigint';
:run0205
rollback to savepoint s205;
select pg_temp.expect('3c a half state (one function, another body) is refused, nothing applied',
  '55000 0205: the schema is not in the reviewed state (part of 0205 is there); nothing applied | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
-- Each of the seven bodies 0205's functions call, changed in turn.
select pg_temp.change_body('platform.current_actor_subject()');
:run0205
rollback to savepoint s205;
select pg_temp.expect('3d a body it calls changed (0001''s platform.current_actor_subject) is refused, nothing applied',
  '55000 0205: these bodies are not as 0001-0153 left them: platform.current_actor_subject() | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
select pg_temp.change_body('platform.current_correlation_id()');
:run0205
rollback to savepoint s205;
select pg_temp.expect('3d a body it calls changed (0001''s platform.current_correlation_id) is refused, nothing applied',
  '55000 0205: these bodies are not as 0001-0153 left them: platform.current_correlation_id() | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
select pg_temp.change_body('platform.reject_mutation()');
:run0205
rollback to savepoint s205;
select pg_temp.expect('3d a body it calls changed (0001''s platform.reject_mutation) is refused, nothing applied',
  '55000 0205: these bodies are not as 0001-0153 left them: platform.reject_mutation() | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
select pg_temp.change_body('auth.account_id_for_subject(text)');
:run0205
rollback to savepoint s205;
select pg_temp.expect('3d a body it calls changed (0008''s auth.account_id_for_subject) is refused, nothing applied',
  '55000 0205: these bodies are not as 0001-0153 left them: auth.account_id_for_subject(text) | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
select pg_temp.change_body('auth.protect_deleted_account()');
:run0205
rollback to savepoint s205;
select pg_temp.expect('3d a body it calls changed (0096''s auth.protect_deleted_account) is refused, nothing applied',
  '55000 0205: these bodies are not as 0001-0153 left them: auth.protect_deleted_account() | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
select pg_temp.change_body('identity.sealed_demo_account(uuid)');
:run0205
rollback to savepoint s205;
select pg_temp.expect('3d a body it calls changed (0098''s identity.sealed_demo_account) is refused, nothing applied',
  '55000 0205: these bodies are not as 0001-0153 left them: identity.sealed_demo_account(uuid) | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
select pg_temp.change_body('identity.sealed_qa_account(uuid)');
:run0205
rollback to savepoint s205;
select pg_temp.expect('3d a body it calls changed (0123''s identity.sealed_qa_account) is refused, nothing applied',
  '55000 0205: these bodies are not as 0001-0153 left them: identity.sealed_qa_account(uuid) | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
alter table auth.sessions rename column access_jti to access_token_id;
:run0205
rollback to savepoint s205;
select pg_temp.expect('3e a column it uses missing (auth.sessions.access_jti) is refused, nothing applied',
  '55000 0205: the objects it uses are not there (0002''s accounts and sessions, 0003''s audit, 0096''s deleted-account '
  || 'trigger, the ICU collation und-x-icu): auth.sessions.access_jti | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
alter table auth.accounts disable trigger accounts_deleted_terminal;
:run0205
rollback to savepoint s205;
select pg_temp.expect('3f 0096''s deleted-account trigger disabled: refused, nothing applied',
  '55000 0205: the objects it uses are not there (0002''s accounts and sessions, 0003''s audit, 0096''s deleted-account '
  || 'trigger, the ICU collation und-x-icu) | 0 tables, 0 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());

delete from locks_seen;
select pg_temp.record_locks('before');
:run0205
select pg_temp.record_locks('after');
select pg_temp.expect('3g 0205 applies: two tables, four functions', 'applied | 2 tables, 4 functions',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0205());
-- Every lock it adds on an existing table is on auth.accounts: the header's SHARE ROW EXCLUSIVE, and the ACCESS SHARE
-- that reading it (the preconditions' catalog joins, the foreign keys' creation) takes under it.
select pg_temp.expect('3h it locks no existing table but auth.accounts, at SHARE ROW EXCLUSIVE at most',
  'auth.accounts AccessShareLock, auth.accounts ShareRowExclusiveLock',
  (select string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name, added.mode)
     from (select after_run.table_name, after_run.mode from locks_seen after_run, existing_tables existing
            where after_run.label = 'after' and after_run.table_name::regclass = any (existing.tables)
           except
           select before_run.table_name, before_run.mode from locks_seen before_run where before_run.label = 'before') added));
select pg_temp.expect('3i its objects are auth.accounts'' owner''s, whoever ran it', 'relb_migrator x6',
  (select string_agg(distinct owner, ',') || ' x' || count(*) from (
     select pg_get_userbyid(relowner) as owner from pg_class
      where oid in ('auth.staff_name_changes'::regclass, 'auth.password_change_requests'::regclass)
     union all
     select pg_get_userbyid(proowner) from pg_proc where pronamespace = 'auth'::regnamespace
        and proname in ('staff_person_name_acceptable', 'change_own_password', 'change_own_display_name',
                        'own_profile_version')) owners));
:run0205
select pg_temp.expect('3j and it answers already applied again', '55000 0205: already applied',
  pg_temp.answer('0205', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

select nextval('pg_temp.m205_passed') - 1 as passed \gset
\echo '0205 migration suite: ' :passed ' cases passed'
rollback;

\if :m205_dblink_available
\if :m205_dblink_create
drop extension dblink;
\endif
\endif
