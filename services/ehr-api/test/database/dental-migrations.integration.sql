\set ON_ERROR_STOP on
-- 0194, 0195 and 0196 (DEN-1, Release D): the migration files themselves, run
-- as written (psql \ir) the way the runner runs them inside its transaction.
-- Rollback-only, apart from the dblink extension below. On a migrated
-- database all three have run already:
--   1. busy refusals, first, before this transaction locks any table: a
--      second session (dblink) holds auth.role_permissions in ROW EXCLUSIVE
--      mode (a writer; 0194's and 0196's SHARE ROW EXCLUSIVE cannot be had),
--      identity.sealed_qa_members in SHARE mode (0194's ROW EXCLUSIVE cannot
--      be had) or in ACCESS EXCLUSIVE mode (0195's ACCESS SHARE cannot be
--      had): the file tries for about 5 seconds and refuses with 55P03
--      "019x: ... stayed busy for 5 seconds; nothing applied; run the release
--      again at a quieter time"; when this transaction already holds another
--      file's strong lock it refuses at once ("... so it does not wait;
--      ..."). Both messages are the ones the runner's dry run retries, and
--      nothing is applied;
--   2. a second run of each answers "already applied" (55000) and changes
--      nothing;
--   3. 0196 taken away for this transaction: its row without its audit row,
--      and its audit row without its row, are half states and refused; then
--      0196 applies (one row, one audit row) within its declared locks;
--   4. 0195 taken away: a half state and a changed pinned body
--      (ehr.context_allows) refuse; then 0195 applies (7 tables, 20
--      functions, 59 draft list items) within its declared locks, holding
--      every one of them;
--   5. 0194 taken away (0195 and 0196 too): 0195 and 0196 without 0194
--      refuse; a half state, a changed role function and a role list naming
--      an unknown first role refuse; then 0194 applies on 0001-0153's role
--      functions (25 rows, 28 audit rows, eight functions, two checks)
--      within its declared locks; on BILL-1's 0162 versions of the role
--      functions and checks (simulated here as 0162 makes them: cashier and
--      billing_officer appended, in/not in for the front desk), it applies
--      and keeps every other lane's role; with the sealed QA tenant
--      installed it writes the QA dentist (29 audit rows), and a fixed id or
--      the address held elsewhere refuses; then 0195 and 0196 apply on top.
-- Synthetic values only.
set plpgsql.variable_conflict = error;

-- dblink is created before the transaction (creating it inside would lock its
-- result type at ACCESS EXCLUSIVE, which the files read as "this transaction
-- holds an earlier migration's locks") and dropped again at the end.
select exists (select 1 from pg_available_extensions where name = 'dblink') as m194_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as m194_dblink_create \gset
\if :m194_dblink_available
\if :m194_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0194 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0194_dentist_role_and_dental_codes.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0195 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0195_dental_chart_and_procedures.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0196 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0196_dentist_own_facility_opening.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'

-- A case: stops the suite at once when it fails. (Functions only until 1 is
-- done: a temporary table or sequence would be a relation this transaction
-- holds at ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0194-0196 migrations suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  -- Counted in a setting until 1 is done, then in a sequence (which keeps its count across ROLLBACK TO SAVEPOINT).
  if to_regclass('pg_temp.m194_passed') is null then
    perform set_config('m194.passed', (coalesce(nullif(current_setting('m194.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.m194_passed');
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
create function pg_temp.made0194() returns text language sql as $$
  select (select count(*) from auth.permissions where code like 'ehr.dental.%') || ' codes, '
      || (select count(*) from auth.roles where code = 'dentist') || ' role, '
      || (select count(*) from auth.role_permissions where role_code = 'dentist'
            and permission_code <> 'identity.patient.open-own-facility') || ' role rows, '
      || (select count(*) from audit.events where correlation_id = '0194-dentist-role-and-dental-codes') || ' audit rows, '
      || (select count(*) from pg_proc where prosrc like '%''dentist''%' and pronamespace = 'identity'::regnamespace)
      || ' functions, '
      || (select count(*) from pg_constraint where conname in ('staff_invitations_role_code_check',
            'staff_licence_attestations_role_code_check') and pg_get_constraintdef(oid) like '%dentist%') || ' checks';
$$;
create function pg_temp.made0195() returns text language plpgsql as $$
declare
  items bigint := 0;
begin
  if to_regclass('ehr.dental_list_items') is not null then
    execute 'select count(*) from ehr.dental_list_items' into items;
  end if;
  return (select count(*) from pg_class where relnamespace = 'ehr'::regnamespace and relname like 'dental\_%'
            and relkind = 'r') || ' tables, '
      || (select count(*) from pg_proc where pronamespace = 'ehr'::regnamespace and proname like 'dental\_%')
      || ' functions, ' || items || ' list items';
end
$$;
create function pg_temp.made0196() returns text language sql as $$
  select (select count(*) from auth.role_permissions where role_code = 'dentist'
            and permission_code = 'identity.patient.open-own-facility') || ' row, '
      || (select count(*) from audit.events where correlation_id = '0196-dentist-own-facility-opening') || ' audit row';
$$;

-- 1. Busy refusals.
\if :m194_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('m194_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select pg_temp.made0194() as made0194_before \gset
select pg_temp.made0195() as made0195_before \gset
select pg_temp.made0196() as made0196_before \gset
select public.dblink_exec('m194_blocker', 'begin') as began \gset
select public.dblink_exec('m194_blocker', 'lock table auth.role_permissions in row exclusive mode') as blocked \gset
:run0194
select pg_temp.expect('1b auth.role_permissions written by another session: 0194 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0194_before',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0194());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0194
select pg_temp.made0194() as made0194_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: 0194 refuses at once',
  'busy refusal: so it does not wait | ' || :'made0194_before',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made0194_holding');
:run0196
select pg_temp.expect('1d 0196 too tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0196_before',
  pg_temp.answer('0196', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0196());
select public.dblink_exec('m194_blocker', 'rollback') as ended \gset
select public.dblink_exec('m194_blocker', 'begin') as began \gset
select public.dblink_exec('m194_blocker', 'lock table identity.sealed_qa_members in share mode') as blocked \gset
:run0194
select pg_temp.expect('1e identity.sealed_qa_members held by another session: 0194 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0194_before',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0194());
select public.dblink_exec('m194_blocker', 'rollback') as ended \gset
select public.dblink_exec('m194_blocker', 'begin') as began \gset
select public.dblink_exec('m194_blocker', 'lock table identity.sealed_qa_members in access exclusive mode') as blocked \gset
:run0195
select pg_temp.expect('1f identity.sealed_qa_members (read by the seal checks) locked by another session: 0195 refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0195_before',
  pg_temp.answer('0195', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0195());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0195
select pg_temp.made0195() as made0195_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1g the same while this transaction holds an earlier file''s lock: 0195 refuses at once',
  'busy refusal: so it does not wait | ' || :'made0195_before',
  pg_temp.answer('0195', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made0195_holding');
select public.dblink_exec('m194_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('m194_blocker') as disconnected \gset
\else
\echo '0194-0196 migrations suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

create temporary sequence m194_passed;
select setval('pg_temp.m194_passed', coalesce(nullif(current_setting('m194.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- 2. A second run.
select pg_temp.expect('2a 0194-0196 are applied here',
  '2 codes, 1 role, 25 role rows, 28 audit rows, 8 functions, 2 checks | 7 tables, 20 functions, 59 list items | 1 row, 1 audit row',
  pg_temp.made0194() || ' | ' || pg_temp.made0195() || ' | ' || pg_temp.made0196());
:run0194
select pg_temp.expect('2b 0194 again: already applied', '55000 0194: already applied',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0195
select pg_temp.expect('2c 0195 again: already applied', '55000 0195: already applied',
  pg_temp.answer('0195', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0196
select pg_temp.expect('2d 0196 again: already applied', '55000 0196: already applied',
  pg_temp.answer('0196', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

-- The locks a file adds, on tables that were there before it ran.
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
create temporary table declared_locks (file text, table_name text, mode text);
insert into declared_locks values
  ('0194', 'auth.roles', 'ShareRowExclusiveLock'), ('0194', 'auth.permissions', 'ShareRowExclusiveLock'),
  ('0194', 'auth.role_permissions', 'ShareRowExclusiveLock'),
  ('0194', 'identity.staff_invitations', 'AccessExclusiveLock'),
  ('0194', 'identity.staff_licence_attestations', 'AccessExclusiveLock'),
  ('0194', 'audit.events', 'RowExclusiveLock'), ('0194', 'identity.sealed_qa_members', 'RowExclusiveLock'),
  ('0194', 'auth.accounts', 'RowExclusiveLock'), ('0194', 'identity.staff', 'RowExclusiveLock'),
  ('0194', 'identity.staff_facility_memberships', 'RowExclusiveLock'), ('0194', 'auth.account_roles', 'RowExclusiveLock'),
  ('0194', 'identity.organization_applications', 'ShareLock'), ('0194', 'identity.organizations', 'RowShareLock'),
  ('0194', 'identity.facilities', 'RowShareLock'), ('0194', 'identity.patients', 'RowShareLock'),
  ('0194', 'identity.outreach_organisations', 'RowShareLock'), ('0194', 'identity.sealed_demo_members', 'AccessShareLock'),
  ('0194', 'identity.staff_attestation_texts', 'AccessShareLock'),
  ('0195', 'identity.patients', 'ShareRowExclusiveLock'), ('0195', 'identity.facilities', 'ShareRowExclusiveLock'),
  ('0195', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'), ('0195', 'auth.accounts', 'ShareRowExclusiveLock'),
  ('0195', 'ehr.encounters', 'ShareRowExclusiveLock'), ('0195', 'audit.events', 'RowExclusiveLock'),
  ('0195', 'identity.consent_grants', 'AccessShareLock'), ('0195', 'identity.consent_directives', 'AccessShareLock'),
  ('0195', 'identity.consent_directive_versions', 'AccessShareLock'), ('0195', 'identity.purpose_of_use_codes', 'AccessShareLock'),
  ('0195', 'identity.access_requests', 'AccessShareLock'), ('0195', 'identity.patient_consent_shares', 'AccessShareLock'),
  ('0195', 'identity.sealed_demo_members', 'AccessShareLock'), ('0195', 'identity.sealed_qa_members', 'AccessShareLock'),
  ('0195', 'identity.staff', 'AccessShareLock'), ('0195', 'identity.organizations', 'AccessShareLock'),
  ('0195', 'auth.permissions', 'AccessShareLock'), ('0195', 'auth.role_permissions', 'AccessShareLock'),
  ('0195', 'auth.roles', 'AccessShareLock'), ('0195', 'auth.account_roles', 'AccessShareLock'),
  ('0196', 'auth.role_permissions', 'ShareRowExclusiveLock'), ('0196', 'audit.events', 'RowExclusiveLock'),
  ('0196', 'auth.roles', 'RowShareLock'), ('0196', 'auth.permissions', 'RowShareLock'),
  ('0196', 'auth.accounts', 'RowShareLock'), ('0196', 'identity.staff_facility_memberships', 'RowShareLock'),
  ('0196', 'identity.organizations', 'RowShareLock'), ('0196', 'identity.facilities', 'RowShareLock'),
  ('0196', 'identity.patients', 'RowShareLock'), ('0196', 'auth.account_roles', 'AccessShareLock'),
  ('0196', 'identity.sealed_demo_members', 'AccessShareLock'), ('0196', 'identity.sealed_qa_members', 'AccessShareLock');
-- Locks a file added beyond its header's ('' when none), and the declared ones it does not hold ('' when none).
create function pg_temp.undeclared(file text) returns text language sql as $$
  select coalesce(string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name, added.mode), '')
    from (select after_run.table_name, after_run.mode from locks_seen after_run where after_run.label = 'after'
          except
          select before_run.table_name, before_run.mode from locks_seen before_run where before_run.label = 'before') added
   where added.table_name not like 'ehr.dental\_%'
     and not exists (select 1 from declared_locks declared where declared.file = undeclared.file
                       and declared.table_name = added.table_name
                       and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(added.mode));
$$;
create function pg_temp.unheld(file text) returns text language sql as $$
  select coalesce(string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name), '')
    from declared_locks declared
   where declared.file = unheld.file
     and not exists (select 1 from locks_seen held where held.label = 'after'
                      and held.table_name = declared.table_name and held.mode = declared.mode);
$$;

-- 3. 0196 taken away for this transaction (its audit row with triggers off: the audit log is append-only).
delete from auth.role_permissions where role_code = 'dentist' and permission_code = 'identity.patient.open-own-facility';
set local session_replication_role = replica;
delete from audit.events where correlation_id = '0196-dentist-own-facility-opening';
set local session_replication_role = origin;
select pg_temp.expect('3a the state before 0196', '0 row, 0 audit row', pg_temp.made0196());
savepoint s196;
insert into auth.role_permissions (role_code, permission_code) values ('dentist', 'identity.patient.open-own-facility');
:run0196
rollback to savepoint s196;
select pg_temp.expect('3b the row without its audit row: refused, nothing applied',
  '55000 0196: the role table is not in the reviewed state (the dentist holds the code without 0196''s audit row); nothing applied | 0 row, 0 audit row',
  pg_temp.answer('0196', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0196());
set local session_replication_role = replica;
insert into audit.events (correlation_id, actor_type, action, outcome, provenance, details)
values ('0196-dentist-own-facility-opening', 'system', 'auth.role-permission.add', 'success', 'migration', '{}');
set local session_replication_role = origin;
:run0196
rollback to savepoint s196;
select pg_temp.expect('3c the audit row without the row: refused',
  '55000 0196: the role table is not in the reviewed state (0196''s audit row without its row); nothing applied',
  pg_temp.answer('0196', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
delete from locks_seen;
select pg_temp.record_locks('before');
:run0196
select pg_temp.record_locks('after');
select pg_temp.expect('3d 0196 applies: one row, one audit row', 'applied | 1 row, 1 audit row',
  pg_temp.answer('0196', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0196());
select pg_temp.expect('3e the code''s holders: 0131''s three and the dentist', 'clinician,dentist,doctor,nurse',
  (select string_agg(role_code, ',' order by role_code) from auth.role_permissions
    where permission_code = 'identity.patient.open-own-facility'));
select pg_temp.expect('3f 0196 takes no lock beyond its header''s, and every one it declares', '|',
  pg_temp.undeclared('0196') || '|' || pg_temp.unheld('0196'));
rollback to savepoint s196;

-- 4. 0195 taken away (0196 is away already in this transaction).
create function pg_temp.drop0195() returns void language plpgsql as $$
begin
  execute (select 'drop function ' || string_agg(proc.oid::regprocedure::text, ', ')
             from pg_proc proc where proc.pronamespace = 'ehr'::regnamespace and proc.proname like 'dental\_%'
              and proc.prorettype <> 'trigger'::regtype);
  drop table ehr.dental_events, ehr.dental_procedures, ehr.dental_chart_findings, ehr.dental_chart_versions,
    ehr.dental_visits, ehr.dental_list_items, ehr.dental_list_versions;
  drop function ehr.dental_list_versions_guard(), ehr.dental_chart_versions_guard(), ehr.dental_visits_guard(),
    ehr.dental_procedures_guard();
end
$$;
select pg_temp.drop0195();
select pg_temp.expect('4a the state before 0195', '0 tables, 0 functions, 0 list items', pg_temp.made0195());
savepoint s195;
create table ehr.dental_visits (id integer);
:run0195
rollback to savepoint s195;
select pg_temp.expect('4b a half state (one of its tables there) is refused, nothing applied',
  '55000 0195: the schema is not in the reviewed state (part of 0195 is there); nothing applied | 0 tables, 0 functions, 0 list items',
  pg_temp.answer('0195', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0195());
do $$
begin
  execute regexp_replace(pg_get_functiondef('ehr.context_allows(uuid,uuid,text)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0195
rollback to savepoint s195;
select pg_temp.expect('4c a consent rule it calls changed: refused, nothing applied',
  '55000 0195: these bodies are not as 0001-0153 left them: ehr.context_allows(uuid,uuid,text) | 0 tables, 0 functions, 0 list items',
  pg_temp.answer('0195', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0195());
delete from locks_seen;
select pg_temp.record_locks('before');
:run0195
select pg_temp.record_locks('after');
select pg_temp.expect('4d 0195 applies', 'applied | 7 tables, 20 functions, 59 list items',
  pg_temp.answer('0195', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0195());
select pg_temp.expect('4e 0195 takes no lock beyond its header''s, and holds every one it declares', '|',
  pg_temp.undeclared('0195') || '|' || pg_temp.unheld('0195'));
select pg_temp.expect('4f the draft lists: four versions, 16, 30, 8 and 5 items, no ADA CDT',
  'anaesthetic:8,anaesthetic_technique:5,procedure:30,tooth_condition:16|4 draft|0',
  (select string_agg(kind || ':' || n, ',' order by kind) from (select kind, count(*) as n from ehr.dental_list_items
     group by kind) counted)
  || '|' || (select count(*) || ' ' || min(status) from ehr.dental_list_versions where active)
  || '|' || (select count(*) from ehr.dental_list_items where code ~ '^D[0-9]{4}$'));
select pg_temp.expect('4g no audit row of its own', '0',
  (select count(*)::text from audit.events where source_system like 'hid-0195%'));
:run0195
select pg_temp.expect('4h 0195 again: already applied', '55000 0195: already applied',
  pg_temp.answer('0195', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s195;

-- 5. 0194 taken away too (0195 and 0196 are away in this transaction).
create function pg_temp.drop0194() returns void language plpgsql as $$
declare
  signature text;
begin
  delete from auth.role_permissions where role_code = 'dentist';
  delete from auth.permissions where code like 'ehr.dental.%';
  delete from auth.roles where code = 'dentist';
  perform set_config('session_replication_role', 'replica', true);
  delete from audit.events where correlation_id = '0194-dentist-role-and-dental-codes';
  perform set_config('session_replication_role', 'origin', true);
  execute replace(pg_get_functiondef('identity.staff_role_licence_body(text)'::regprocedure),
    E'    when ''dentist'' then ''MDCN''\n', '');
  foreach signature in array array['identity.staff_invitable_roles(text,text)',
      'identity.staff_invitation_fields_valid(text,text,text,text,text,text)',
      'identity.change_facility_staff_role(uuid,bigint,text,text,text,text,text)',
      'identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)',
      'identity.remove_facility_staff_role(uuid,bigint,text,text)',
      'identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character)',
      'identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character)'] loop
    execute replace(pg_get_functiondef(signature::regprocedure), '''doctor'', ''dentist'', ', '''doctor'', ');
  end loop;
  alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
  alter table identity.staff_invitations add constraint staff_invitations_role_code_check
    check (role_code in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist'));
  alter table identity.staff_licence_attestations drop constraint staff_licence_attestations_role_code_check;
  alter table identity.staff_licence_attestations add constraint staff_licence_attestations_role_code_check
    check (role_code in ('doctor', 'nurse', 'lab', 'pharmacist'));
end
$$;
select pg_temp.drop0194();
select pg_temp.expect('5a the state before 0194: 0001-0153''s bodies again',
  '0 codes, 0 role, 0 role rows, 0 audit rows, 0 functions, 0 checks|b6f4068712d97284fd95d169e3bde0cf|1d6531b60beaf640a46342be8380eac3|1ca56a2cdd0231341d9f3b48441b2074',
  pg_temp.made0194() || '|' || (select md5(prosrc) from pg_proc where oid = 'identity.staff_invitable_roles(text,text)'::regprocedure)
  || '|' || (select md5(prosrc) from pg_proc where oid = 'identity.staff_role_licence_body(text)'::regprocedure)
  || '|' || (select md5(prosrc) from pg_proc
              where oid = 'identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)'::regprocedure));
:run0195
select pg_temp.expect('5b 0195 without 0194: refused', '55000 0195: 0135 and 0194 must be applied first',
  pg_temp.answer('0195', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0196
select pg_temp.expect('5c 0196 without 0194: refused', '55000 0196: 0194 must be applied first',
  pg_temp.answer('0196', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
savepoint s194;
insert into auth.roles (code, description) values ('dentist', 'Half state');
:run0194
rollback to savepoint s194;
select pg_temp.expect('5d a half state (the role there) is refused, nothing applied',
  '55000 0194: the schema is not in the reviewed state (the dentist role, a dental code, a role row, a role list naming dentist or 0194''s audit rows exist, with other content than 0194 leaves); nothing applied | 0 codes, 0 role, 0 role rows, 0 audit rows, 0 functions, 0 checks',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0194());
do $$
begin
  execute regexp_replace(pg_get_functiondef('identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)'::regprocedure),
    '\mbegin\M', 'begin /* changed */');
end $$;
:run0194
rollback to savepoint s194;
select pg_temp.expect('5e a role function changed: refused, nothing applied',
  '55000 0194: these functions differ from 0001-0153 (other lanes'' roles aside) or are missing: identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
alter table identity.staff_invitations add constraint staff_invitations_role_code_check
  check (role_code in ('surgeon', 'doctor', 'nurse', 'lab', 'pharmacist', 'receptionist'));
:run0194
rollback to savepoint s194;
select pg_temp.expect('5f a role list starting with a role 0001-0153 do not name: refused',
  '55000 0194: identity.staff_invitations.staff_invitations_role_code_check is not a role list of 0001-0153 (other lanes'' roles after it aside)',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
update auth.permissions set active = false where code = 'lab.work-item.accept';
:run0194
rollback to savepoint s194;
select pg_temp.expect('5g a code the dentist''s rows name is inactive: refused',
  '55000 0194: these codes are missing or inactive: lab.work-item.accept',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

-- On 0001-0153's functions, measuring the locks.
delete from locks_seen;
select pg_temp.record_locks('before');
:run0194
select pg_temp.record_locks('after');
select pg_temp.expect('5h 0194 applies', 'applied | 2 codes, 1 role, 25 role rows, 28 audit rows, 8 functions, 2 checks',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0194());
select pg_temp.expect('5i 0194 takes no lock beyond its header''s, and holds every one it declares', '|',
  pg_temp.undeclared('0194') || '|' || pg_temp.unheld('0194'));
select pg_temp.expect('5j the staff vocabulary: dentist after doctor at hospitals, MDCN; not at laboratories',
  '{doctor,dentist,nurse,lab,pharmacist,receptionist}|MDCN|{lab,receptionist}|{pharmacist,receptionist}|{doctor,dentist,nurse,lab,pharmacist,receptionist}',
  identity.staff_invitable_roles('hospital', 'ehr')::text || '|' || identity.staff_role_licence_body('dentist') || '|'
  || identity.staff_invitable_roles('laboratory', 'ehr')::text || '|' || identity.staff_invitable_roles('pharmacy', 'ehr')::text
  || '|' || identity.staff_invitable_roles('other', 'migrate')::text);
select pg_temp.expect('5k the old roles answer as before', 'MDCN|NMCN|MLSCN|PCN|null|null',
  identity.staff_role_licence_body('doctor') || '|' || identity.staff_role_licence_body('nurse') || '|'
  || identity.staff_role_licence_body('lab') || '|' || identity.staff_role_licence_body('pharmacist') || '|'
  || coalesce(identity.staff_role_licence_body('receptionist'), 'null') || '|'
  || coalesce(identity.staff_role_licence_body('clinician'), 'null'));
select pg_temp.expect('5l the audit rows: 2 codes, 1 role, 25 rows, as the system actor',
  'auth.permission.add:2,auth.role-permission.add:25,auth.role.add:1/28',
  (select string_agg(action || ':' || n, ',' order by action collate "C") from (select action, count(*) as n from audit.events
     where correlation_id = '0194-dentist-role-and-dental-codes' group by action) counted)
  || '/' || (select count(*) from audit.events where correlation_id = '0194-dentist-role-and-dental-codes'
              and actor_type = 'system' and actor_account_id is null and facility_id is null and patient_id is null
              and provenance = 'migration' and source_system = 'hid-0194'));
:run0195
select pg_temp.expect('5m then 0195 applies on top', 'applied | 7 tables, 20 functions, 59 list items',
  pg_temp.answer('0195', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0195());
:run0196
select pg_temp.expect('5n then 0196', 'applied | 1 row, 1 audit row',
  pg_temp.answer('0196', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0196());
:run0194
select pg_temp.expect('5o 0194 again (0196 applied): already applied', '55000 0194: already applied',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s194;

-- On BILL-1's 0162 versions (cashier and billing_officer appended to the lists, "in"/"not in" for the front desk,
-- the invitable roles with the two at hospitals and cashier at laboratories and pharmacies), as 0162 makes them.
do $$
declare
  signature text;
  source text;
begin
  foreach signature in array array['identity.staff_invitation_fields_valid(text,text,text,text,text,text)',
      'identity.change_facility_staff_role(uuid,bigint,text,text,text,text,text)',
      'identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)',
      'identity.remove_facility_staff_role(uuid,bigint,text,text)',
      'identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character)',
      'identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character)'] loop
    source := pg_get_functiondef(signature::regprocedure);
    source := replace(source, $r$('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist')$r$,
      $r$('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer')$r$);
    source := replace(source, $r$= 'receptionist'$r$, $r$in ('receptionist', 'cashier', 'billing_officer')$r$);
    source := replace(source, $r$<> 'receptionist'$r$, $r$not in ('receptionist', 'cashier', 'billing_officer')$r$);
    execute source;
  end loop;
  -- 0162's own text of the invitable roles (its B5), byte for byte.
  create or replace function identity.staff_invitable_roles(target_organization_type text, target_product_code text)
  returns text[]
  language sql immutable parallel safe
  set search_path = pg_catalog, pg_temp
  as $invitable$
  select case
    when target_organization_type in ('hospital', 'clinic')
      or (target_organization_type = 'other' and target_product_code in ('ehr', 'migrate'))
      then array['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer']
    when target_organization_type = 'laboratory'
      or (target_organization_type = 'other' and target_product_code = 'laboratory')
      then array['lab', 'receptionist', 'cashier']
    when target_organization_type = 'pharmacy'
      or (target_organization_type = 'other' and target_product_code = 'pharmacy')
      then array['pharmacist', 'receptionist', 'cashier']
    else array[]::text[]
  end
$invitable$;
end $$;
alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
alter table identity.staff_invitations add constraint staff_invitations_role_code_check
  check (role_code in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer'));
select pg_temp.expect('5p BILL-1''s versions are in place (simulated)', 'd43c8b94981d500263462d0ae2664b8a',
  (select md5(prosrc) from pg_proc where oid = 'identity.staff_invitable_roles(text,text)'::regprocedure));
:run0194
select pg_temp.expect('5q 0194 applies after 0162 and keeps its roles',
  'applied | {doctor,dentist,nurse,lab,pharmacist,receptionist,cashier,billing_officer}|{lab,receptionist,cashier}|CHECK ((role_code = ANY (ARRAY[''doctor''::text, ''dentist''::text, ''nurse''::text, ''lab''::text, ''pharmacist''::text, ''receptionist''::text, ''cashier''::text, ''billing_officer''::text])))',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
  || identity.staff_invitable_roles('clinic', 'ehr')::text || '|' || identity.staff_invitable_roles('laboratory', 'ehr')::text
  || '|' || (select pg_get_constraintdef(oid) from pg_constraint where conname = 'staff_invitations_role_code_check'));
select pg_temp.expect('5r each replaced function keeps 0162''s text: its list with dentist (6), and its in (the four that had one)', '6/4',
  (select count(*) from pg_proc where pronamespace = 'identity'::regnamespace
     and prosrc like $r$%('doctor', 'dentist', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer')%$r$)
  || '/' || (select count(*) from pg_proc where pronamespace = 'identity'::regnamespace
     and prosrc like $r$%('doctor', 'dentist', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer')%$r$
     and prosrc like $r$%in ('receptionist', 'cashier', 'billing_officer')%$r$));
:run0194
select pg_temp.expect('5s and answers already applied again', '55000 0194: already applied',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s194;

-- With the sealed QA tenant (0123's install, as the 0123, 0134 and 0151 suites call it).
update platform.control_settings set enabled = true where control_key = 'outreach_organiser_signup_enabled';
select identity.sealed_qa_install() is not null as installed \gset
savepoint qa;
set local session_replication_role = replica;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('c0a00003-0000-4000-8000-0000000000de', 'synthetic:taken-id', 'taken-id@example.invalid', 'Taken Id', 'active');
set local session_replication_role = origin;
:run0194
rollback to savepoint qa;
select pg_temp.expect('5t a fixed id held elsewhere: SEALED_QA_ID_TAKEN, nothing applied',
  '55000 0194: SEALED_QA_ID_TAKEN | 0 codes, 0 role, 0 role rows, 0 audit rows, 0 functions, 0 checks',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0194());
set local session_replication_role = replica;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('de194000-0000-4000-8000-000000000001', 'synthetic:taken-address', 'Dentist@HealthIdentityDirectory.com',
   'Taken Address', 'active');
set local session_replication_role = origin;
:run0194
rollback to savepoint qa;
select pg_temp.expect('5u the address held by another account: SEALED_QA_ADDRESS_TAKEN, nothing applied',
  '55000 0194: SEALED_QA_ADDRESS_TAKEN | 0 codes, 0 role, 0 role rows, 0 audit rows, 0 functions, 0 checks',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0194());
:run0194
select pg_temp.expect('5v with the QA tenant: the QA dentist at QA Hospital, pending_reset, no password, one role, its audit row',
  'applied | pending_reset/t/t/1/dentist/1',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
  || (select account.status || '/' || (account.password_hash is null)::text::char(1) || '/'
             || identity.sealed_qa_account(account.id)::text::char(1) || '/'
             || (select count(*) from auth.account_roles assignment where assignment.account_id = account.id) || '/'
             || (select role_code from auth.account_roles assignment where assignment.id = 'c0a00005-0000-4000-8000-000000000de1')
             || '/' || (select count(*) from audit.events where correlation_id = '0194-sealed-qa-dentist')
        from auth.accounts account where account.id = 'c0a00003-0000-4000-8000-0000000000de'));
:run0194
select pg_temp.expect('5w and answers already applied again', '55000 0194: already applied',
  pg_temp.answer('0194', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint qa;

select nextval('pg_temp.m194_passed') - 1 as passed \gset
\echo '0194-0196 migrations suite: ' :passed ' cases passed'
rollback;

\if :m194_dblink_available
\if :m194_dblink_create
drop extension dblink;
\endif
\endif
