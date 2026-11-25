\set ON_ERROR_STOP on
-- 0168 and 0169 (ED-1, Release D): the migration files themselves, run as
-- written (psql \ir) the way the runner runs them inside its transaction.
-- Rollback-only, apart from the dblink extension below. On a migrated
-- database both have run already:
--   1. busy refusals, first, before this transaction locks any table: a
--      second session (dblink) holds ehr.visit_queue in ACCESS SHARE mode
--      (readers go on; 0168's ACCESS EXCLUSIVE cannot be had), or
--      auth.role_permissions in ROW EXCLUSIVE mode (a writer; 0169's SHARE ROW
--      EXCLUSIVE cannot be had): the file tries for about 5 seconds and
--      refuses with 55P03 "0168: ... stayed busy for 5 seconds; nothing
--      applied; run the release again at a quieter time"; when this
--      transaction already holds another file's strong lock, it refuses at
--      once ("... so it does not wait; ..."). Both messages are the ones the
--      runner's dry run retries (its own number first, its wording last;
--      hid-system#306), and nothing is applied;
--   2. a second run of each answers "already applied" (55000) and changes
--      nothing;
--   3. 0169 taken away for this transaction: a half state, a changed
--      permission check and a role without 0135's pair refuse with 55000 and
--      apply nothing; 0169 without 0168 refuses; then 0169 applies: four
--      codes, thirteen role rows, thirteen audit rows; it takes no lock beyond
--      its header's and every lock its header declares;
--   4. 0168 taken away too: a half state, a changed pinned body and an
--      unknown third waiting-list basis CHECK refuse; then 0168 applies on
--      0135's CHECK (search, own_facility, emergency) and, in its own
--      savepoint, on APPT-1's (search, own_facility, appointment, emergency),
--      each time keeping every waiting-list row; it takes no lock beyond its
--      header's and every lock its header declares; then 0169 applies on top.
-- Synthetic values only.
set plpgsql.variable_conflict = error;

-- dblink is created before the transaction (creating it inside would lock its
-- result type at ACCESS EXCLUSIVE, which the files read as "this transaction
-- holds an earlier migration's locks") and dropped again at the end.
select exists (select 1 from pg_available_extensions where name = 'dblink') as m168_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as m168_dblink_create \gset
\if :m168_dblink_available
\if :m168_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0168 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0168_emergency_department_board.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0169 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0169_emergency_department_board_access.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'

-- A case: stops the suite at once when it fails. (Functions only until 1 is
-- done: a temporary table or sequence would be a relation this transaction
-- holds at ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0168-0169 migrations suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  -- Counted in a setting until 1 is done, then in a sequence (which keeps its count across ROLLBACK TO SAVEPOINT).
  if to_regclass('pg_temp.m168_passed') is null then
    perform set_config('m168.passed', (coalesce(nullif(current_setting('m168.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.m168_passed');
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
create function pg_temp.made0168() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('ehr.ed_attendances'), to_regclass('ehr.ed_attendance_events')))
      || ' tables, ' || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                          where namespace.nspname = 'ehr'
                            and (proc.proname like 'ed\_%' or proc.proname like 'visit\_queue\_ed\_%'))
      || ' functions, ' || (select count(*) from pg_trigger
                             where tgname in ('visit_queue_ed_close_mirror', 'visit_queue_ed_guard', 'ed_attendance_events_immutable'))
      || ' triggers, basis ' || (select replace(replace(substring(pg_get_constraintdef(oid) from 'ARRAY\[(.*)\]'),
                                   '::text', ''), '''', '')
                                   from pg_constraint where conrelid = 'ehr.visit_queue'::regclass
                                    and conname = 'visit_queue_check_in_basis_check');
$$;
create function pg_temp.made0169() returns text language sql as $$
  select (select count(*) from auth.permissions where code like 'ehr.ed.%') || ' codes, '
      || (select count(*) from auth.role_permissions where permission_code like 'ehr.ed.%') || ' role rows, '
      || (select count(*) from audit.events where correlation_id = '0169-emergency-board-ed1') || ' audit rows';
$$;

-- 1. Busy refusals.
\if :m168_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('m168_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select pg_temp.made0168() as made0168_before \gset
select pg_temp.made0169() as made0169_before \gset
select public.dblink_exec('m168_blocker', 'begin') as began \gset
select public.dblink_exec('m168_blocker', 'lock table ehr.visit_queue in access share mode') as blocked \gset
:run0168
select pg_temp.expect('1b ehr.visit_queue read by another session: 0168 tries for 5 seconds, then refuses as the runner retries',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0168_before',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0168());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0168
select pg_temp.made0168() as made0168_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: 0168 refuses at once',
  'busy refusal: so it does not wait | ' || :'made0168_before',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made0168_holding');
select public.dblink_exec('m168_blocker', 'rollback') as ended \gset
select public.dblink_exec('m168_blocker', 'begin') as began \gset
select public.dblink_exec('m168_blocker', 'lock table auth.role_permissions in row exclusive mode') as blocked \gset
:run0169
select pg_temp.expect('1d auth.role_permissions written by another session: 0169 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0169_before',
  pg_temp.answer('0169', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0169());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0169
select pg_temp.made0169() as made0169_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1e the same while this transaction holds an earlier file''s lock: 0169 refuses at once',
  'busy refusal: so it does not wait | ' || :'made0169_before',
  pg_temp.answer('0169', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made0169_holding');
select public.dblink_exec('m168_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('m168_blocker') as disconnected \gset
\else
\echo '0168-0169 migrations suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

create temporary sequence m168_passed;
select setval('pg_temp.m168_passed', coalesce(nullif(current_setting('m168.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- 2. A second run.
select pg_temp.made0168() as made0168_applied \gset
select pg_temp.made0169() as made0169_applied \gset
select pg_temp.expect('2a 0168 and 0169 are applied here',
  '2 tables, 18 functions, 3 triggers, basis search, own_facility, emergency | 4 codes, 13 role rows, 13 audit rows',
  :'made0168_applied' || ' | ' || :'made0169_applied');
:run0168
select pg_temp.expect('2b 0168 again: already applied, nothing changed', '55000 0168: already applied | ' || :'made0168_applied',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0168());
:run0169
select pg_temp.expect('2c 0169 again: already applied, nothing changed', '55000 0169: already applied | ' || :'made0169_applied',
  pg_temp.answer('0169', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0169());

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
   where after_run.label = 'after' and after_run.table_name::regclass = any (existing)
  except
  select before_run.table_name, before_run.mode from locks_seen before_run where before_run.label = 'before';
$$;
create function pg_temp.lock_rank(mode text) returns integer language sql immutable as $$
  select array_position(array['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
    'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'], mode);
$$;
-- A lock the header declares covers the same table at the same or a weaker mode.
create temporary table declared_locks (file text, table_name text, mode text);
insert into declared_locks values
  ('0168', 'identity.patients', 'ShareRowExclusiveLock'), ('0168', 'identity.facilities', 'ShareRowExclusiveLock'),
  ('0168', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'),
  ('0168', 'ehr.encounters', 'ShareRowExclusiveLock'), ('0168', 'ehr.visit_queue', 'AccessExclusiveLock'),
  ('0168', 'audit.events', 'RowExclusiveLock'), ('0168', 'identity.unknown_patients', 'AccessShareLock'),
  ('0168', 'identity.consent_grants', 'AccessShareLock'), ('0168', 'identity.consent_directives', 'AccessShareLock'),
  ('0168', 'identity.consent_directive_versions', 'AccessShareLock'), ('0168', 'auth.permissions', 'AccessShareLock'),
  ('0168', 'auth.role_permissions', 'AccessShareLock'),
  ('0169', 'auth.role_permissions', 'ShareRowExclusiveLock'), ('0169', 'auth.permissions', 'RowExclusiveLock'),
  ('0169', 'audit.events', 'RowExclusiveLock'), ('0169', 'auth.roles', 'RowShareLock'),
  ('0169', 'auth.accounts', 'RowShareLock'), ('0169', 'identity.staff_facility_memberships', 'RowShareLock'),
  ('0169', 'identity.organizations', 'RowShareLock'), ('0169', 'identity.facilities', 'RowShareLock'),
  ('0169', 'identity.patients', 'RowShareLock'), ('0169', 'auth.account_roles', 'AccessShareLock'),
  ('0169', 'identity.sealed_demo_members', 'AccessShareLock'), ('0169', 'identity.sealed_qa_members', 'AccessShareLock');
-- Every table that exists now, before 3 and 4 take the files away (their own new tables are left out of the
-- comparison because they do not exist before the run).
create temporary table existing_tables as
  select array_agg(relation.oid::regclass) as tables from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
   where relation.relkind in ('r', 'p', 'v', 'm')
     and namespace.nspname not in ('pg_catalog', 'information_schema', 'migration')
     and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'
     and relation.relname not like 'ed\_attendance%';

-- 3. 0169 taken away for this transaction (its audit rows with triggers off: the audit log is append-only).
delete from auth.role_permissions where permission_code like 'ehr.ed.%';
delete from auth.permissions where code like 'ehr.ed.%';
set local session_replication_role = replica;
delete from audit.events where correlation_id = '0169-emergency-board-ed1';
set local session_replication_role = origin;
select pg_temp.expect('3a the state before 0169, for this transaction', '0 codes, 0 role rows, 0 audit rows',
  pg_temp.made0169());

savepoint s169;
insert into auth.permissions (code, description) values ('ehr.ed.read', 'Half state');
:run0169
rollback to savepoint s169;
select pg_temp.expect('3b a half state (one of its codes there) is refused, nothing applied',
  '55000 0169: the role table is not in the reviewed state (an emergency board code or row is there, but not exactly what 0169 leaves); nothing applied | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0169', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0169());
do $$
begin
  execute regexp_replace(pg_get_functiondef('auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0169
rollback to savepoint s169;
select pg_temp.expect('3c the permission check changed: refused, nothing applied',
  '55000 0169: auth.membership_has_permission is not as 0001-0151 leave it; nothing applied | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0169', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0169());
delete from auth.role_permissions where role_code = 'receptionist' and permission_code = 'ehr.encounter.write';
:run0169
rollback to savepoint s169;
select pg_temp.expect('3d the front desk without 0135''s pair: refused, nothing applied',
  '55000 0169: these roles do not hold 0135''s pair (every ED function needs it): receptionist ehr.encounter.write | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0169', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0169());

delete from locks_seen;
select pg_temp.record_locks('before');
:run0169
select pg_temp.record_locks('after');
select pg_temp.expect('3e 0169 applies: four codes, thirteen role rows, thirteen audit rows',
  'applied | 4 codes, 13 role rows, 13 audit rows',
  pg_temp.answer('0169', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0169());
select pg_temp.expect('3f the rows, and every audit row as the system actor with no account, facility or patient',
  'clinician:ehr.ed.arrive,ehr.ed.disposition,ehr.ed.read,ehr.ed.triage|doctor:ehr.ed.arrive,ehr.ed.disposition,ehr.ed.read,ehr.ed.triage|nurse:ehr.ed.arrive,ehr.ed.read,ehr.ed.triage|receptionist:ehr.ed.arrive,ehr.ed.read / 13 system rows',
  (select string_agg(role_code || ':' || codes, '|' order by role_code)
     from (select role_code, string_agg(permission_code, ',' order by permission_code) as codes
             from auth.role_permissions where permission_code like 'ehr.ed.%' group by role_code) grouped)
  || ' / ' || (select count(*) from audit.events
                where correlation_id = '0169-emergency-board-ed1' and actor_type = 'system' and actor_account_id is null
                  and facility_id is null and patient_id is null and action = 'auth.role-permission.add'
                  and reason = 'ED-1 Emergency department board (Release D, recommended Q-ED-2 A)') || ' system rows');
select pg_temp.expect('3g 0169 takes no lock beyond its header''s', '',
  coalesce((select string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name, added.mode)
              from pg_temp.added_locks((select tables from existing_tables)) added
             where not exists (select 1 from declared_locks declared where declared.file = '0169'
                                and declared.table_name = added.table_name
                                and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(added.mode))), ''));
select pg_temp.expect('3h and holds every lock its header declares', '',
  coalesce((select string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name)
              from declared_locks declared
             where declared.file = '0169'
               and not exists (select 1 from locks_seen held where held.label = 'after'
                                and held.table_name = declared.table_name and held.mode = declared.mode)), ''));
rollback to savepoint s169;

-- 4. 0168 taken away too (0169 is away already in this transaction). A waiting-list row first, which every
-- apply below must keep.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e1690000-0000-4000-8000-000000000001', 'Board Migration Group', 'board-migration-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1690000-0000-4000-8000-000000000002', 'e1690000-0000-4000-8000-000000000001', 'Board Migration Clinic',
   'BOARD-M', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1690100-0000-4000-8000-000000000001', 'synthetic:board-migration-1', 'board-migration-1@example.invalid',
   'Ada Migrationdesk', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e1690200-0000-4000-8000-000000000001', 'e1690100-0000-4000-8000-000000000001', 'Ada Migrationdesk',
   'board-migration-1@example.invalid', 'verified', 'receptionist');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('e1690300-0000-4000-8000-000000000001', 'e1690200-0000-4000-8000-000000000001', 'e1690100-0000-4000-8000-000000000001',
   'e1690000-0000-4000-8000-000000000001', 'e1690000-0000-4000-8000-000000000002', 'receptionist', 'receptionist', true,
   true);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system) values
  ('e1690400-0000-4000-8000-000000000001', 'HID-EMAA22', 'Amaka', 'Migrationone', 'Amaka Migrationone', 'female',
   date '1990-01-01', 'active', 'hid');
insert into ehr.visit_queue (facility_id, patient_id, queue_day, check_in_basis, checked_in_by_account_id,
  checked_in_by_membership_id, updated_by_membership_id)
values ('e1690000-0000-4000-8000-000000000002', 'e1690400-0000-4000-8000-000000000001',
  (clock_timestamp() at time zone 'Africa/Lagos')::date, 'search', 'e1690100-0000-4000-8000-000000000001',
  'e1690300-0000-4000-8000-000000000001', 'e1690300-0000-4000-8000-000000000001');
set local session_replication_role = origin;
create temporary table queue_before as select md5(string_agg(to_jsonb(entry)::text, ',' order by entry.id)) as rows
  from ehr.visit_queue entry;

drop trigger visit_queue_ed_close_mirror on ehr.visit_queue;
drop trigger visit_queue_ed_guard on ehr.visit_queue;
drop function ehr.ed_arrive(text, uuid, text, timestamptz, smallint, text, text, text), ehr.ed_board(boolean),
  ehr.ed_read(uuid), ehr.ed_triage(uuid, bigint, smallint, text, boolean, text, text),
  ehr.ed_move(uuid, bigint, text, uuid, boolean, text, text), ehr.ed_link_visit(uuid, bigint, uuid, text, text),
  ehr.ed_record_disposition(uuid, bigint, text, text, uuid, text, text, text, text),
  ehr.ed_leave(uuid, bigint, text, text), ehr.ed_cancel(uuid, bigint, text, text, text),
  ehr.visit_queue_ed_attendances(uuid[]), ehr.ed_cards(uuid[], uuid, uuid, uuid, boolean),
  ehr.ed_caller(text, text[]),
  ehr.ed_audit(text, uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text, jsonb),
  ehr.ed_idempotency(uuid, text, text), ehr.visit_queue_ed_close_mirror(), ehr.visit_queue_ed_guard(),
  ehr.visit_queue_ed_board_off_update(uuid, bigint, text, smallint, boolean, uuid, boolean);
drop table ehr.ed_attendance_events, ehr.ed_attendances;
drop function ehr.ed_attendance_events_immutable();
alter table ehr.visit_queue drop constraint visit_queue_check_in_basis_check;
alter table ehr.visit_queue add constraint visit_queue_check_in_basis_check
  check (check_in_basis in ('search', 'own_facility'));
select pg_temp.expect('4a the state before 0168, for this transaction', '0 tables, 0 functions, 0 triggers, basis search, own_facility',
  pg_temp.made0168());
:run0169
select pg_temp.expect('4b 0169 without 0168: refused', '55000 0169: 0168 must be applied first',
  pg_temp.answer('0169', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

savepoint s168;
create table ehr.ed_attendances (id integer);
:run0168
rollback to savepoint s168;
select pg_temp.expect('4c a half state (one of its tables there) is refused, nothing applied',
  '55000 0168: the schema is not in the reviewed state (part of 0168 is there); nothing applied | '
  || '0 tables, 0 functions, 0 triggers, basis search, own_facility',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0168());
alter table ehr.visit_queue drop constraint visit_queue_check_in_basis_check;
alter table ehr.visit_queue add constraint visit_queue_check_in_basis_check
  check (check_in_basis in ('search', 'own_facility', 'emergency'));
:run0168
rollback to savepoint s168;
select pg_temp.expect('4d the basis CHECK already with emergency (a half state) is refused, nothing applied',
  '55000 0168: the schema is not in the reviewed state (part of 0168 is there); nothing applied | '
  || '0 tables, 0 functions, 0 triggers, basis search, own_facility',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0168());
do $$
begin
  execute regexp_replace(pg_get_functiondef('identity.resolve_patient_search_ref(text,text)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0168
rollback to savepoint s168;
select pg_temp.expect('4e a body it calls changed (0132''s matchRef check) is refused, nothing applied',
  '55000 0168: these bodies are not as 0001-0151 left them: identity.resolve_patient_search_ref(text,text) | '
  || '0 tables, 0 functions, 0 triggers, basis search, own_facility',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0168());
do $$
begin
  execute regexp_replace(pg_get_functiondef('ehr.visit_queue_update(uuid,bigint,text,smallint,boolean,uuid,boolean)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0168
rollback to savepoint s168;
select pg_temp.expect('4e2 0135''s update changed (the board-off update calls it) is refused, nothing applied',
  '55000 0168: these bodies are not as 0001-0151 left them: ehr.visit_queue_update(uuid,bigint,text,smallint,boolean,uuid,boolean) | '
  || '0 tables, 0 functions, 0 triggers, basis search, own_facility',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0168());
alter table ehr.visit_queue drop constraint visit_queue_check_in_basis_check;
alter table ehr.visit_queue add constraint visit_queue_check_in_basis_check
  check (check_in_basis in ('search', 'own_facility', 'walk_in'));
:run0168
rollback to savepoint s168;
select pg_temp.expect('4f an unknown third waiting-list basis CHECK: refused, nothing applied',
  '55000 0168: the waiting-list basis CHECK is neither 0135''s nor APPT-1''s; nothing applied | '
  || '0 tables, 0 functions, 0 triggers, basis search, own_facility',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0168());
rollback to savepoint s168;

-- On APPT-1's CHECK (0160 applied first), in its own savepoint.
alter table ehr.visit_queue drop constraint visit_queue_check_in_basis_check;
alter table ehr.visit_queue add constraint visit_queue_check_in_basis_check
  check (check_in_basis in ('search', 'own_facility', 'appointment'));
:run0168
select pg_temp.expect('4g on APPT-1''s CHECK: applies and keeps appointment',
  'applied | 2 tables, 18 functions, 3 triggers, basis search, own_facility, appointment, emergency',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0168());
select pg_temp.expect('4h every waiting-list row kept', 'true',
  ((select md5(string_agg(to_jsonb(entry)::text, ',' order by entry.id)) from ehr.visit_queue entry)
   = (select rows from queue_before))::text);
:run0168
select pg_temp.expect('4i and answers already applied again', '55000 0168: already applied',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s168;

-- On 0135's CHECK, measuring the locks.
delete from locks_seen;
select pg_temp.record_locks('before');
:run0168
select pg_temp.record_locks('after');
select pg_temp.expect('4j on 0135''s CHECK: applies', 'applied | 2 tables, 18 functions, 3 triggers, basis search, own_facility, emergency',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0168());
select pg_temp.expect('4k every waiting-list row kept', 'true',
  ((select md5(string_agg(to_jsonb(entry)::text, ',' order by entry.id)) from ehr.visit_queue entry)
   = (select rows from queue_before))::text);
select pg_temp.expect('4l 0168 takes no lock beyond its header''s', '',
  coalesce((select string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name, added.mode)
              from pg_temp.added_locks((select tables from existing_tables)) added
             where not exists (select 1 from declared_locks declared where declared.file = '0168'
                                and declared.table_name = added.table_name
                                and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(added.mode))), ''));
select pg_temp.expect('4m and holds every lock its header declares', '',
  coalesce((select string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name)
              from declared_locks declared
             where declared.file = '0168'
               and not exists (select 1 from locks_seen held where held.label = 'after'
                                and held.table_name = declared.table_name and held.mode = declared.mode)), ''));
select pg_temp.expect('4n no audit row of its own', '0',
  (select count(*)::text from audit.events where source_system like 'hid-0168%'));
:run0169
select pg_temp.expect('4o then 0169 applies on top', 'applied | 4 codes, 13 role rows, 13 audit rows',
  pg_temp.answer('0169', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0169());
:run0168
select pg_temp.expect('4p and each answers already applied again: 0168', '55000 0168: already applied',
  pg_temp.answer('0168', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0169
select pg_temp.expect('4q 0169 too', '55000 0169: already applied',
  pg_temp.answer('0169', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

select nextval('pg_temp.m168_passed') - 1 as passed \gset
\echo '0168-0169 migrations suite: ' :passed ' cases passed'
rollback;

\if :m168_dblink_available
\if :m168_dblink_create
drop extension dblink;
\endif
\endif
