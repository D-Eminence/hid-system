\set ON_ERROR_STOP on
-- 0199-0202 (ROS-1, Release D): the migration files themselves, run as
-- written (psql \ir) the way the runner runs them inside its transaction.
-- Rollback-only, apart from the dblink extension below. On a migrated
-- database (0001-0153, NUR-1's 0170-0177 and what they need, and 0199-0202)
-- all four have run already:
--   1. busy refusals, first, before this transaction locks any table: a
--      second session (dblink) writes a table each file locks (0199 the
--      licence attestations, 0200 the organizations, 0201 the role table,
--      0202 the clinical shifts): the file tries for about 5 seconds and
--      refuses with 55P03 "020n: ... stayed busy for 5 seconds; nothing
--      applied; run the release again at a quieter time"; when this
--      transaction already holds another file's strong lock, it refuses at
--      once ("... so it does not wait; ..."). Both are the messages the
--      runner's dry run retries (hid-system#306), and nothing is applied;
--   2. a second run of each answers "already applied" (55000) and changes
--      nothing;
--   3. 0202 taken away for this transaction: without NUR-1's 0176 it refuses;
--      a half state and a changed 0200 helper it pins refuse; then it applies
--      (four tables, sixteen functions, the leave trigger, the draft rule) and
--      takes no lock beyond its header's and every lock its header declares;
--   4. 0201 taken away: a half state, a changed permission check and a missing
--      role refuse; it applies with another lane's code already on a role and
--      keeps it, three codes, eighteen rows, eighteen system audit rows; the
--      locks as declared;
--   5. 0202 and 0200 taken away: a half state and a changed 0114 body refuse;
--      0202 then refuses without 0200; 0200 applies, the locks as declared;
--      0202 applies on top;
--   6. 0199 taken away: a half state (its text row alone) and a changed
--      0086 actor refuse; it applies, the locks as declared.
-- Synthetic values only.
set plpgsql.variable_conflict = error;

-- dblink is created before the transaction (creating it inside would lock its
-- result type at ACCESS EXCLUSIVE, which the files read as "this transaction
-- holds an earlier migration's locks") and dropped again at the end.
select exists (select 1 from pg_available_extensions where name = 'dblink') as m199_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as m199_dblink_create \gset
\if :m199_dblink_available
\if :m199_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0199 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0199_staff_licence_renewals.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0200 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0200_staff_leave_and_department_in_charges.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0201 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0201_workforce_access_codes.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0202 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0202_duty_roster.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'

-- A case: stops the suite at once when it fails. (Functions only until 1 is
-- done: a temporary table or sequence would be a relation this transaction
-- holds at ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0199-0202 migrations suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  if to_regclass('pg_temp.m199_passed') is null then
    perform set_config('m199.passed', (coalesce(nullif(current_setting('m199.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.m199_passed');
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
-- What each file makes, in one line.
create function pg_temp.made0199() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('identity.staff_licence_renewals'),
                                                      to_regclass('identity.staff_licence_renewal_withdrawals')))
      || ' tables, ' || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                          where namespace.nspname = 'identity' and proc.proname in ('staff_licence_status_of',
                            'staff_licence_status_rows', 'staff_licence_renewal_json', 'staff_licence_audit',
                            'staff_licence_status_list', 'staff_licence_member_read', 'staff_licence_export_rows',
                            'staff_licence_renewal_record', 'staff_licence_renewal_withdraw'))
      || ' functions, ' || (select count(*) from identity.staff_attestation_texts
                             where version = 'facility-licence-renewal-v1') || ' text';
$$;
create function pg_temp.made0200() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('identity.workforce_department_in_charges'),
                                                      to_regclass('identity.staff_leave_requests'),
                                                      to_regclass('identity.workforce_events')))
      || ' tables, ' || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                          where namespace.nspname = 'identity'
                            and (proc.proname like 'workforce\_%' or proc.proname in ('staff_leave_card',
                              'staff_leave_requests_mine', 'staff_leave_request_create', 'staff_leave_request_cancel',
                              'staff_leave_requests_to_decide', 'staff_leave_request_decide')))
      || ' functions';
$$;
create function pg_temp.made0201() returns text language sql as $$
  select (select count(*) from auth.permissions where code like 'workforce.roster.%' or code like 'workforce.leave.%')
      || ' codes, ' || (select count(*) from auth.role_permissions
                         where permission_code like 'workforce.roster.%' or permission_code like 'workforce.leave.%')
      || ' role rows, ' || (select count(*) from audit.events where correlation_id = '0201-duty-roster-ros1') || ' audit rows';
$$;
create function pg_temp.made0202() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('identity.duty_roster_rules'),
                                                      to_regclass('identity.duty_rosters'),
                                                      to_regclass('identity.duty_roster_assignments'),
                                                      to_regclass('identity.duty_roster_events')))
      || ' tables, ' || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                          where namespace.nspname = 'identity'
                            and (proc.proname like 'duty\_roster\_%' or proc.proname = 'staff_leave_requests_roster_clash'))
      || ' functions, ' || (select count(*) from pg_trigger where tgname = 'staff_leave_requests_roster_clash')
      || ' leave trigger';
$$;

-- 1. Busy refusals.
\if :m199_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('m199_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select pg_temp.made0199() || ' | ' || pg_temp.made0200() || ' | ' || pg_temp.made0201() || ' | ' || pg_temp.made0202()
  as made_before \gset
create function pg_temp.made_all() returns text language sql as $$
  select pg_temp.made0199() || ' | ' || pg_temp.made0200() || ' | ' || pg_temp.made0201() || ' | ' || pg_temp.made0202();
$$;

select public.dblink_exec('m199_blocker', 'begin') as began \gset
select public.dblink_exec('m199_blocker', 'lock table identity.staff_licence_attestations in row exclusive mode') as blocked \gset
:run0199
select pg_temp.expect('1b the licence attestations written by another session: 0199 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made_before',
  pg_temp.answer('0199', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made_all());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0199
select pg_temp.made_all() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: 0199 refuses at once',
  'busy refusal: so it does not wait | ' || :'made_before',
  pg_temp.answer('0199', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made_holding');
select public.dblink_exec('m199_blocker', 'rollback') as ended \gset

select public.dblink_exec('m199_blocker', 'begin') as began \gset
select public.dblink_exec('m199_blocker', 'lock table identity.organizations in row exclusive mode') as blocked \gset
:run0200
select pg_temp.expect('1d the organizations written by another session: 0200 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made_before',
  pg_temp.answer('0200', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made_all());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0200
select pg_temp.made_all() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1e the same while holding an earlier file''s lock: 0200 refuses at once',
  'busy refusal: so it does not wait | ' || :'made_before',
  pg_temp.answer('0200', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made_holding');
select public.dblink_exec('m199_blocker', 'rollback') as ended \gset

select public.dblink_exec('m199_blocker', 'begin') as began \gset
select public.dblink_exec('m199_blocker', 'lock table auth.role_permissions in row exclusive mode') as blocked \gset
:run0201
select pg_temp.expect('1f the role table written by another session: 0201 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made_before',
  pg_temp.answer('0201', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made_all());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0201
select pg_temp.made_all() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1g the same while holding an earlier file''s lock: 0201 refuses at once',
  'busy refusal: so it does not wait | ' || :'made_before',
  pg_temp.answer('0201', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made_holding');
select public.dblink_exec('m199_blocker', 'rollback') as ended \gset

select public.dblink_exec('m199_blocker', 'begin') as began \gset
select public.dblink_exec('m199_blocker', 'lock table ehr.clinical_shifts in row exclusive mode') as blocked \gset
:run0202
select pg_temp.expect('1h the clinical shifts written by another session: 0202 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made_before',
  pg_temp.answer('0202', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made_all());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0202
select pg_temp.made_all() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1i the same while holding an earlier file''s lock: 0202 refuses at once',
  'busy refusal: so it does not wait | ' || :'made_before',
  pg_temp.answer('0202', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made_holding');
select public.dblink_exec('m199_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('m199_blocker') as disconnected \gset
\else
\echo '0199-0202 migrations suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

create temporary sequence m199_passed;
select setval('pg_temp.m199_passed', coalesce(nullif(current_setting('m199.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- 2. A second run.
select pg_temp.expect('2a all four are applied here',
  '2 tables, 9 functions, 1 text | 3 tables, 16 functions | 3 codes, 18 role rows, 18 audit rows | 4 tables, 16 functions, 1 leave trigger',
  pg_temp.made0199() || ' | ' || pg_temp.made0200() || ' | ' || pg_temp.made0201() || ' | ' || pg_temp.made0202());
:run0199
select pg_temp.expect('2b 0199 again: already applied', '55000 0199: already applied | 2 tables, 9 functions, 1 text',
  pg_temp.answer('0199', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0199());
:run0200
select pg_temp.expect('2c 0200 again (0202''s trigger on its leave table is not a half state): already applied',
  '55000 0200: already applied | 3 tables, 16 functions',
  pg_temp.answer('0200', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0200());
:run0201
select pg_temp.expect('2d 0201 again: already applied', '55000 0201: already applied | 3 codes, 18 role rows, 18 audit rows',
  pg_temp.answer('0201', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0201());
:run0202
select pg_temp.expect('2e 0202 again: already applied', '55000 0202: already applied | 4 tables, 16 functions, 1 leave trigger',
  pg_temp.answer('0202', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0202());

-- The locks a file adds, on tables that were there before it ran: (table, mode) pairs held by this backend after
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
create function pg_temp.added_locks(existing regclass[]) returns table (table_name text, mode text) language sql as $$
  select after_run.table_name, after_run.mode from locks_seen after_run
   where after_run.label = 'after' and to_regclass(after_run.table_name) = any (existing)
  except
  select before_run.table_name, before_run.mode from locks_seen before_run where before_run.label = 'before';
$$;
create function pg_temp.lock_rank(mode text) returns integer language sql immutable as $$
  select array_position(array['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
    'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'], mode);
$$;
-- The locks each header declares.
create temporary table declared_locks (file text, table_name text, mode text);
insert into declared_locks values
  ('0199', 'identity.staff_licence_attestations', 'ShareRowExclusiveLock'),
  ('0199', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'),
  ('0199', 'identity.facilities', 'ShareRowExclusiveLock'),
  ('0199', 'identity.staff_attestation_texts', 'ShareRowExclusiveLock'),
  ('0199', 'auth.accounts', 'ShareRowExclusiveLock'),
  ('0199', 'auth.account_roles', 'AccessShareLock'), ('0199', 'identity.staff', 'AccessShareLock'),
  ('0199', 'auth.permissions', 'AccessShareLock'),
  ('0200', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'),
  ('0200', 'identity.facilities', 'ShareRowExclusiveLock'),
  ('0200', 'identity.organizations', 'ShareRowExclusiveLock'),
  ('0200', 'identity.facility_profiles', 'AccessShareLock'), ('0200', 'auth.permissions', 'AccessShareLock'),
  ('0200', 'auth.role_permissions', 'AccessShareLock'),
  ('0201', 'auth.role_permissions', 'ShareRowExclusiveLock'), ('0201', 'auth.permissions', 'RowExclusiveLock'),
  ('0201', 'audit.events', 'RowExclusiveLock'), ('0201', 'auth.roles', 'RowShareLock'),
  ('0201', 'auth.accounts', 'RowShareLock'), ('0201', 'identity.staff_facility_memberships', 'RowShareLock'),
  ('0201', 'identity.organizations', 'RowShareLock'), ('0201', 'identity.facilities', 'RowShareLock'),
  ('0201', 'identity.patients', 'RowShareLock'), ('0201', 'auth.account_roles', 'AccessShareLock'),
  ('0201', 'identity.sealed_demo_members', 'AccessShareLock'), ('0201', 'identity.sealed_qa_members', 'AccessShareLock'),
  ('0202', 'ehr.clinical_shifts', 'ShareRowExclusiveLock'),
  ('0202', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'),
  ('0202', 'identity.facilities', 'ShareRowExclusiveLock'),
  ('0202', 'identity.staff_leave_requests', 'ShareRowExclusiveLock'),
  ('0202', 'identity.workforce_department_in_charges', 'AccessShareLock'),
  ('0202', 'identity.facility_profiles', 'AccessShareLock');
create function pg_temp.lock_check(file text, existing regclass[]) returns text language sql as $$
  select coalesce((select 'beyond: ' || string_agg(added.table_name || ' ' || added.mode, ', '
                                                  order by added.table_name, added.mode)
                     from pg_temp.added_locks(existing) added
                    where not exists (select 1 from declared_locks declared where declared.file = lock_check.file
                                       and declared.table_name = added.table_name
                                       and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(added.mode))), '')
      || coalesce((select ' missing: ' || string_agg(declared.table_name || ' ' || declared.mode, ', '
                                                      order by declared.table_name)
                     from declared_locks declared
                    where declared.file = lock_check.file
                      and not exists (select 1 from locks_seen held where held.label = 'after'
                                       and held.table_name = declared.table_name and held.mode = declared.mode)), '');
$$;
-- Every table that exists now, before 3-6 take the files away (their own new tables are left out).
create temporary table existing_tables as
  select array_agg(relation.oid::regclass) as tables from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
   where relation.relkind in ('r', 'p', 'v', 'm')
     and namespace.nspname not in ('pg_catalog', 'information_schema', 'migration')
     and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'
     and relation.oid not in (select to_regclass(name) from unnest(array['identity.staff_licence_renewals',
       'identity.staff_licence_renewal_withdrawals', 'identity.workforce_department_in_charges',
       'identity.staff_leave_requests', 'identity.workforce_events', 'identity.duty_roster_rules',
       'identity.duty_rosters', 'identity.duty_roster_assignments', 'identity.duty_roster_events']) name);
-- 0202's leave table is 0200's (there before 0202 runs).
create temporary table existing_tables_0202 as
  select tables || 'identity.staff_leave_requests'::regclass || 'identity.workforce_department_in_charges'::regclass
           as tables from existing_tables;

-- Taking a file away (for this transaction).
create function pg_temp.drop0202() returns void language plpgsql as $$
begin
  drop trigger staff_leave_requests_roster_clash on identity.staff_leave_requests;
  drop table identity.duty_roster_events, identity.duty_roster_assignments, identity.duty_rosters,
    identity.duty_roster_rules;
  execute (select string_agg(format('drop function %s', proc.oid::regprocedure), '; ')
             from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
            where namespace.nspname = 'identity'
              and (proc.proname like 'duty\_roster\_%' or proc.proname = 'staff_leave_requests_roster_clash'));
end $$;
create function pg_temp.drop0200() returns void language plpgsql as $$
begin
  drop table identity.workforce_events, identity.staff_leave_requests, identity.workforce_department_in_charges;
  execute (select string_agg(format('drop function %s', proc.oid::regprocedure), '; ')
             from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
            where namespace.nspname = 'identity'
              and (proc.proname like 'workforce\_%' or proc.proname in ('staff_leave_requests_mine',
                'staff_leave_request_create', 'staff_leave_request_cancel', 'staff_leave_requests_to_decide',
                'staff_leave_request_decide')));
end $$;
create function pg_temp.drop0201() returns void language plpgsql as $$
begin
  delete from auth.role_permissions where permission_code like 'workforce.roster.%' or permission_code like 'workforce.leave.%';
  delete from auth.permissions where code like 'workforce.roster.%' or code like 'workforce.leave.%';
  set local session_replication_role = replica;
  delete from audit.events where correlation_id = '0201-duty-roster-ros1';
  set local session_replication_role = origin;
end $$;
create function pg_temp.drop0199() returns void language plpgsql as $$
begin
  drop table identity.staff_licence_renewal_withdrawals, identity.staff_licence_renewals;
  execute (select string_agg(format('drop function %s', proc.oid::regprocedure), '; ')
             from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
            where namespace.nspname = 'identity' and proc.proname in ('staff_licence_status_of',
              'staff_licence_status_rows', 'staff_licence_renewal_json', 'staff_licence_audit', 'staff_licence_status_list',
              'staff_licence_member_read', 'staff_licence_export_rows', 'staff_licence_renewal_record',
              'staff_licence_renewal_withdraw'));
  set local session_replication_role = replica;
  delete from identity.staff_attestation_texts where version = 'facility-licence-renewal-v1';
  set local session_replication_role = origin;
end $$;

-- 3. 0202 taken away.
savepoint s202;
select pg_temp.drop0202();
select pg_temp.expect('3a the state before 0202, for this transaction', '0 tables, 0 functions, 0 leave trigger',
  pg_temp.made0202());
savepoint s202b;
alter table ehr.clinical_shifts rename to clinical_shifts_set_aside;
:run0202
rollback to savepoint s202b;
select pg_temp.expect('3b without NUR-1''s 0176: refused', '55000 0202: NUR-1''s 0176 (ehr.clinical_shifts) must be applied first',
  pg_temp.answer('0202', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
create table identity.duty_rosters (id integer);
:run0202
rollback to savepoint s202b;
select pg_temp.expect('3c a half state (one of its tables there): refused, nothing applied',
  '55000 0202: the schema is not in the reviewed state (part of 0202 is there); nothing applied | 0 tables, 0 functions, 0 leave trigger',
  pg_temp.answer('0202', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0202());
do $$
begin
  execute regexp_replace(pg_get_functiondef('identity.workforce_editor_departments(uuid)'::regprocedure),
    '\mreturn departments;', 'return departments; -- changed');
end $$;
:run0202
rollback to savepoint s202b;
select pg_temp.expect('3d a changed 0200 helper it calls: refused, nothing applied',
  '55000 0202: these bodies are not as 0200 and 0001-0153 left them: identity.workforce_editor_departments(uuid) | 0 tables, 0 functions, 0 leave trigger',
  pg_temp.answer('0202', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0202());
delete from locks_seen;
select pg_temp.record_locks('before');
:run0202
select pg_temp.record_locks('after');
select pg_temp.expect('3e 0202 applies: four tables, sixteen functions, the leave trigger',
  'applied | 4 tables, 16 functions, 1 leave trigger',
  pg_temp.answer('0202', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0202());
select pg_temp.expect('3f 0202 takes no lock beyond its header''s and every lock its header declares', '',
  pg_temp.lock_check('0202', (select tables from existing_tables_0202)));
select pg_temp.expect('3g the draft rule: 480 minutes, draft, by 0202', '1/480/draft/0202',
  (select format('%s/%s/%s/%s', id, min_rest_minutes, clinical_status, changed_by_migration) from identity.duty_roster_rules));
:run0202
select pg_temp.expect('3h and answers already applied again', '55000 0202: already applied',
  pg_temp.answer('0202', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s202;

-- 4. 0201 taken away (another lane's code is on the nurse role).
savepoint s201;
select pg_temp.drop0201();
select pg_temp.expect('4a the state before 0201, for this transaction', '0 codes, 0 role rows, 0 audit rows',
  pg_temp.made0201());
insert into auth.permissions (code, description) values ('ehr.other-lane.read', 'Another lane''s code (suite)');
insert into auth.role_permissions (role_code, permission_code) values ('nurse', 'ehr.other-lane.read');
savepoint s201b;
insert into auth.permissions (code, description) values ('workforce.roster.read', 'Half state');
:run0201
rollback to savepoint s201b;
select pg_temp.expect('4b a half state (one of its codes there): refused, nothing applied',
  '55000 0201: the role table is not in the reviewed state (a duty roster or leave code or row is there, but not exactly what 0201 leaves); nothing applied | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0201', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0201());
do $$
begin
  execute regexp_replace(pg_get_functiondef('auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0201
rollback to savepoint s201b;
select pg_temp.expect('4c the permission check changed: refused, nothing applied',
  '55000 0201: auth.membership_has_permission is not as 0001-0153 leave it; nothing applied | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0201', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0201());
update auth.roles set active = false where code = 'pharmacist';
:run0201
rollback to savepoint s201b;
select pg_temp.expect('4d a role inactive: refused, nothing applied',
  '55000 0201: role missing or inactive: pharmacist | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0201', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0201());
create temporary table roles_before as
  select role_code, permission_code, granted_at from auth.role_permissions
   where permission_code not like 'workforce.roster.%' and permission_code not like 'workforce.leave.%';
delete from locks_seen;
select pg_temp.record_locks('before');
:run0201
select pg_temp.record_locks('after');
select pg_temp.expect('4e 0201 applies: three codes, eighteen role rows, eighteen audit rows',
  'applied | 3 codes, 18 role rows, 18 audit rows',
  pg_temp.answer('0201', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0201());
select pg_temp.expect('4f the rows, and every audit row as the system actor with no account, facility or patient',
  'admin:leave.request,roster.manage,roster.read|clinician:leave.request,roster.read|doctor:leave.request,roster.read|lab:leave.request,roster.read|nurse:leave.request,roster.read|org_admin:leave.request,roster.manage,roster.read|pharmacist:leave.request,roster.read|receptionist:leave.request,roster.read / 18 system rows',
  (select string_agg(role_code || ':' || codes, '|' order by role_code)
     from (select role_code, string_agg(replace(permission_code, 'workforce.', ''), ',' order by permission_code) as codes
             from auth.role_permissions
            where permission_code like 'workforce.roster.%' or permission_code like 'workforce.leave.%'
            group by role_code) grouped)
  || ' / ' || (select count(*) from audit.events
                where correlation_id = '0201-duty-roster-ros1' and actor_type = 'system' and actor_account_id is null
                  and facility_id is null and patient_id is null and action = 'auth.role-permission.add'
                  and source_system = 'hid-0201'
                  and reason = 'ROS-1 Duty roster and leave (Release D, owner decisions Q245 A and Q-ROS-8 A)')
  || ' system rows');
select pg_temp.expect('4g every other row of the role table is kept, another lane''s code included', 'true/true',
  ((select count(*) from (select role_code, permission_code, granted_at from auth.role_permissions
                           where permission_code not like 'workforce.roster.%'
                             and permission_code not like 'workforce.leave.%'
                          except select * from pg_temp.roles_before) changed) = 0
   and (select count(*) from (select * from pg_temp.roles_before
                              except select role_code, permission_code, granted_at from auth.role_permissions) gone) = 0)::text
  || '/' || exists (select 1 from auth.role_permissions where role_code = 'nurse'
                     and permission_code = 'ehr.other-lane.read')::text);
select pg_temp.expect('4h 0201 takes no lock beyond its header''s and every lock its header declares', '',
  pg_temp.lock_check('0201', (select tables from existing_tables)));
:run0201
select pg_temp.expect('4i and answers already applied again, the other lane''s code still there',
  '55000 0201: already applied', pg_temp.answer('0201', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s201;

-- 5. 0202 and 0200 taken away.
savepoint s200;
select pg_temp.drop0202();
select pg_temp.drop0200();
select pg_temp.expect('5a the state before 0200, for this transaction', '0 tables, 0 functions | 0 tables, 0 functions, 0 leave trigger',
  pg_temp.made0200() || ' | ' || pg_temp.made0202());
:run0202
select pg_temp.expect('5b 0202 without 0200: refused', '55000 0202: 0200 must be applied first',
  pg_temp.answer('0202', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
savepoint s200b;
create table identity.workforce_events (id integer);
:run0200
rollback to savepoint s200b;
select pg_temp.expect('5c a half state (one of its tables there): refused, nothing applied',
  '55000 0200: the schema is not in the reviewed state (part of 0200 is there); nothing applied | 0 tables, 0 functions',
  pg_temp.answer('0200', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0200());
do $$
begin
  execute regexp_replace(pg_get_functiondef('identity.facility_department_codes()'::regprocedure),
    '''theatre''', '''theatre'', ''physio''');
end $$;
:run0200
rollback to savepoint s200b;
select pg_temp.expect('5d a changed 0114 body it calls (the department codes): refused, nothing applied',
  '55000 0200: these bodies are not as 0001-0153 left them: identity.facility_department_codes() | 0 tables, 0 functions',
  pg_temp.answer('0200', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0200());
delete from locks_seen;
select pg_temp.record_locks('before');
:run0200
select pg_temp.record_locks('after');
select pg_temp.expect('5e 0200 applies: three tables, sixteen functions', 'applied | 3 tables, 16 functions',
  pg_temp.answer('0200', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0200());
select pg_temp.expect('5f 0200 takes no lock beyond its header''s and every lock its header declares', '',
  pg_temp.lock_check('0200', (select tables from existing_tables)));
:run0202
select pg_temp.expect('5g then 0202 applies on top', 'applied | 4 tables, 16 functions, 1 leave trigger',
  pg_temp.answer('0202', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0202());
:run0200
select pg_temp.expect('5h and 0200 answers already applied with 0202''s trigger on its table', '55000 0200: already applied',
  pg_temp.answer('0200', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s200;

-- 6. 0199 taken away.
savepoint s199;
select pg_temp.drop0199();
select pg_temp.expect('6a the state before 0199, for this transaction', '0 tables, 0 functions, 0 text', pg_temp.made0199());
savepoint s199b;
insert into identity.staff_attestation_texts (version, text) values ('facility-licence-renewal-v1',
  'A text that 0199 does not leave there, for the half-state case.');
:run0199
rollback to savepoint s199b;
select pg_temp.expect('6b a half state (its text row alone): refused, nothing applied',
  '55000 0199: the schema is not in the reviewed state (part of 0199 is there); nothing applied',
  pg_temp.answer('0199', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
do $$
begin
  execute regexp_replace(pg_get_functiondef('identity.staff_management_actor(boolean)'::regprocedure),
    'STAFF_MANAGEMENT_NOT_AVAILABLE', 'STAFF_MANAGEMENT_CLOSED');
end $$;
:run0199
rollback to savepoint s199b;
select pg_temp.expect('6c a changed 0086 actor it calls: refused, nothing applied',
  '55000 0199: these bodies are not as 0001-0153 left them: identity.staff_management_actor(boolean) | 0 tables, 0 functions, 0 text',
  pg_temp.answer('0199', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0199());
delete from locks_seen;
select pg_temp.record_locks('before');
:run0199
select pg_temp.record_locks('after');
select pg_temp.expect('6d 0199 applies: two tables, nine functions, the text', 'applied | 2 tables, 9 functions, 1 text',
  pg_temp.answer('0199', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0199());
select pg_temp.expect('6e 0199 takes no lock beyond its header''s and every lock its header declares', '',
  pg_temp.lock_check('0199', (select tables from existing_tables)));
select pg_temp.expect('6f no audit row of its own (0199, 0200 and 0202 write none)', '0',
  (select count(*)::text from audit.events where source_system in ('hid-0199', 'hid-0200', 'hid-0202')));
:run0199
select pg_temp.expect('6g and answers already applied again', '55000 0199: already applied',
  pg_temp.answer('0199', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s199;

select nextval('pg_temp.m199_passed') - 1 as passed \gset
\echo '0199-0202 migrations suite: ' :passed ' cases passed'
rollback;

\if :m199_dblink_available
\if :m199_dblink_create
drop extension dblink;
\endif
\endif
