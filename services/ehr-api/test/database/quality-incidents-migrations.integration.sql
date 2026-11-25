\set ON_ERROR_STOP on
-- 0197 and 0198 (QUAL-1, Release D): the migration files themselves, run as
-- written (psql \ir) the way the runner runs them inside its transaction.
-- Rollback-only, apart from the dblink extension below. On a migrated
-- database both have run already. The suite runs as the cluster superuser,
-- which is not the owner of 0135's functions, so every apply here also takes
-- the files' "owner is not the one applying" path (ALTER ... OWNER), and the
-- "already applied" detection is checked from a role that is not the owner.
--   1. busy refusals, first, before this transaction locks any table: a
--      second session (dblink) writes identity.facilities (ROW EXCLUSIVE;
--      0197's SHARE ROW EXCLUSIVE for its foreign keys cannot be had), or
--      auth.role_permissions (0198's SHARE ROW EXCLUSIVE cannot be had): the
--      file tries for about 5 seconds and refuses with 55P03 "0197: ...
--      stayed busy for 5 seconds; nothing applied; run the release again at a
--      quieter time"; when this transaction already holds another file's
--      strong lock, it refuses at once ("... so it does not wait; ..."). Both
--      messages are the ones the runner's dry run retries (its own number
--      first, its wording last; hid-system#306), and nothing is applied;
--   2. a second run of each answers "already applied" (55000) and changes
--      nothing;
--   3. 0198 taken away for this transaction: a half state, a changed
--      permission check and a named role inactive refuse with 55000 and apply
--      nothing; then 0198 applies: two codes, ten role rows, twelve audit
--      rows; it takes no lock beyond its header's and every lock its header
--      declares. With BILL-1's roles invitable (0162 applied first) it gives
--      cashier and billing_officer the report code too (twelve rows); with
--      another invitable staff role it gives that role too, and never a
--      narrow role or an inactive role even when the invitable list names
--      them;
--   4. 0197 taken away too: 0198 without 0197 refuses; a half state and a
--      changed pinned body refuse; then 0197 applies (seven tables with
--      forced row-level security, 23 functions, 17 triggers, 7 policies,
--      owned by 0135's owner), writes no row of an existing table, takes no
--      lock beyond its header's and every lock its header declares; a second
--      run is "already applied"; a changed function body, an extra grant or
--      a dropped policy afterwards make a second run "not in the reviewed
--      state"; then 0198 applies on top.
-- Synthetic values only.
set plpgsql.variable_conflict = error;

-- dblink is created before the transaction (creating it inside would lock its
-- result type at ACCESS EXCLUSIVE, which the files read as "this transaction
-- holds an earlier migration's locks") and dropped again at the end.
select exists (select 1 from pg_available_extensions where name = 'dblink') as m197_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as m197_dblink_create \gset
\if :m197_dblink_available
\if :m197_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0197 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0197_quality_incident_reporting.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0198 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0198_quality_incident_access.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'

-- A case: stops the suite at once when it fails. (Functions only until 1 is
-- done: a temporary table or sequence would be a relation this transaction
-- holds at ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0197-0198 migrations suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  -- Counted in a setting until 1 is done, then in a sequence (which keeps its count across ROLLBACK TO SAVEPOINT).
  if to_regclass('pg_temp.m197_passed') is null then
    perform set_config('m197.passed', (coalesce(nullif(current_setting('m197.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.m197_passed');
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
create function pg_temp.made0197() returns text language sql as $$
  select (select count(*) from pg_class where relnamespace = 'ehr'::regnamespace and relname like 'quality\_%'
             and relkind = 'r') || ' tables, '
      || (select count(*) from pg_proc where pronamespace = 'ehr'::regnamespace and proname like 'quality\_%')
      || ' functions, '
      || (select count(*) from pg_trigger trigger_row join pg_class class_row on class_row.oid = trigger_row.tgrelid
           where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
             and not trigger_row.tgisinternal) || ' triggers, '
      || (select count(*) from pg_policy policy_row join pg_class class_row on class_row.oid = policy_row.polrelid
           where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%') || ' policies';
$$;
create function pg_temp.made0198() returns text language sql as $$
  select (select count(*) from auth.permissions where code like 'quality.%') || ' codes, '
      || (select count(*) from auth.role_permissions where permission_code like 'quality.%') || ' role rows, '
      || (select count(*) from audit.events where correlation_id = '0198-quality-incident-access-qual1') || ' audit rows';
$$;

-- 1. Busy refusals.
\if :m197_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('m197_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select pg_temp.made0197() as made0197_before \gset
select pg_temp.made0198() as made0198_before \gset
select public.dblink_exec('m197_blocker', 'begin') as began \gset
select public.dblink_exec('m197_blocker', 'lock table identity.facilities in row exclusive mode') as blocked \gset
:run0197
select pg_temp.expect('1b identity.facilities written by another session: 0197 tries for 5 seconds, then refuses as the runner retries',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0197_before',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0197());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0197
select pg_temp.made0197() as made0197_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: 0197 refuses at once',
  'busy refusal: so it does not wait | ' || :'made0197_before',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made0197_holding');
select public.dblink_exec('m197_blocker', 'rollback') as ended \gset
select public.dblink_exec('m197_blocker', 'begin') as began \gset
select public.dblink_exec('m197_blocker', 'lock table auth.role_permissions in row exclusive mode') as blocked \gset
:run0198
select pg_temp.expect('1d auth.role_permissions written by another session: 0198 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0198_before',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0198());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0198
select pg_temp.made0198() as made0198_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1e the same while this transaction holds an earlier file''s lock: 0198 refuses at once',
  'busy refusal: so it does not wait | ' || :'made0198_before',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made0198_holding');
select public.dblink_exec('m197_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('m197_blocker') as disconnected \gset
\else
\echo '0197-0198 migrations suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

create temporary sequence m197_passed;
select setval('pg_temp.m197_passed', coalesce(nullif(current_setting('m197.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- 2. A second run.
select pg_temp.made0197() as made0197_applied \gset
select pg_temp.made0198() as made0198_applied \gset
select pg_temp.expect('2a 0197 and 0198 are applied here',
  '7 tables, 23 functions, 17 triggers, 7 policies | 2 codes, 10 role rows, 12 audit rows',
  :'made0197_applied' || ' | ' || :'made0198_applied');
:run0197
select pg_temp.expect('2b 0197 again (applied by the migrator, run by another role): already applied, nothing changed',
  '55000 0197: already applied | ' || :'made0197_applied',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0197());
:run0198
select pg_temp.expect('2c 0198 again: already applied, nothing changed', '55000 0198: already applied | ' || :'made0198_applied',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0198());

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
  ('0197', 'identity.facilities', 'ShareRowExclusiveLock'), ('0197', 'identity.patients', 'ShareRowExclusiveLock'),
  ('0197', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'),
  ('0198', 'auth.role_permissions', 'ShareRowExclusiveLock'), ('0198', 'auth.permissions', 'RowExclusiveLock'),
  ('0198', 'audit.events', 'RowExclusiveLock'), ('0198', 'auth.roles', 'RowShareLock'),
  ('0198', 'auth.accounts', 'RowShareLock'), ('0198', 'identity.staff_facility_memberships', 'RowShareLock'),
  ('0198', 'identity.organizations', 'RowShareLock'), ('0198', 'identity.facilities', 'RowShareLock'),
  ('0198', 'identity.patients', 'RowShareLock'), ('0198', 'auth.account_roles', 'AccessShareLock'),
  ('0198', 'identity.sealed_demo_members', 'AccessShareLock'), ('0198', 'identity.sealed_qa_members', 'AccessShareLock');
-- Every table that exists now, before 3 and 4 take the files away (0197's own tables are left out of the
-- comparison because they do not exist before its run).
create temporary table existing_tables as
  select array_agg(relation.oid::regclass) as tables from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
   where relation.relkind in ('r', 'p', 'v', 'm')
     and namespace.nspname not in ('pg_catalog', 'information_schema', 'migration')
     and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'
     and relation.relname not like 'quality\_%';

-- 3. 0198 taken away for this transaction (its audit rows with triggers off: the audit log is append-only).
delete from auth.role_permissions where permission_code like 'quality.%';
delete from auth.permissions where code like 'quality.%';
set local session_replication_role = replica;
delete from audit.events where correlation_id = '0198-quality-incident-access-qual1';
set local session_replication_role = origin;
select pg_temp.expect('3a the state before 0198, for this transaction', '0 codes, 0 role rows, 0 audit rows',
  pg_temp.made0198());

savepoint s198;
insert into auth.permissions (code, description) values ('quality.incident.report', 'Half state');
:run0198
rollback to savepoint s198;
select pg_temp.expect('3b a half state (one of its codes there) is refused, nothing applied',
  '55000 0198: the role table is not in the reviewed state (a quality code or row is there, but not exactly what 0198 leaves); nothing applied | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0198());
do $$
begin
  execute regexp_replace(pg_get_functiondef('auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0198
rollback to savepoint s198;
select pg_temp.expect('3c the permission check changed: refused, nothing applied',
  '55000 0198: auth.membership_has_permission is not as 0001-0153 leave it; nothing applied | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0198());
update auth.roles set active = false where code = 'pharmacist';
:run0198
rollback to savepoint s198;
select pg_temp.expect('3d a named role inactive: refused, nothing applied',
  '55000 0198: role missing or inactive: pharmacist | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0198());

delete from locks_seen;
select pg_temp.record_locks('before');
:run0198
select pg_temp.record_locks('after');
select pg_temp.expect('3e 0198 applies: two codes, ten role rows, twelve audit rows',
  'applied | 2 codes, 10 role rows, 12 audit rows',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0198());
select pg_temp.expect('3f the rows, and every audit row as the system actor with no account, facility or patient',
  'admin:quality.incident.manage,quality.incident.report|clinician:quality.incident.report|doctor:quality.incident.report|lab:quality.incident.report|nurse:quality.incident.report|org_admin:quality.incident.manage,quality.incident.report|pharmacist:quality.incident.report|receptionist:quality.incident.report / 2 code rows, 10 role rows',
  (select string_agg(role_code || ':' || codes, '|' order by role_code)
     from (select role_code, string_agg(permission_code, ',' order by permission_code) as codes
             from auth.role_permissions where permission_code like 'quality.%' group by role_code) grouped)
  || ' / ' || (select count(*) from audit.events
                where correlation_id = '0198-quality-incident-access-qual1' and actor_type = 'system'
                  and actor_account_id is null and facility_id is null and patient_id is null
                  and action = 'auth.permission.add' and resource_type = 'permission'
                  and reason = 'QUAL-1 Quality and safety reporting (Release D, owner decisions Q248 A and Q251 A)')
  || ' code rows, ' || (select count(*) from audit.events
                where correlation_id = '0198-quality-incident-access-qual1' and actor_type = 'system'
                  and actor_account_id is null and facility_id is null and patient_id is null
                  and action = 'auth.role-permission.add' and resource_type = 'role-permission'
                  and reason = 'QUAL-1 Quality and safety reporting (Release D, owner decisions Q248 A and Q251 A)')
  || ' role rows');
select pg_temp.expect('3g 0198 takes no lock beyond its header''s', '',
  coalesce((select string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name, added.mode)
              from pg_temp.added_locks((select tables from existing_tables)) added
             where not exists (select 1 from declared_locks declared where declared.file = '0198'
                                and declared.table_name = added.table_name
                                and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(added.mode))), ''));
select pg_temp.expect('3h and holds every lock its header declares', '',
  coalesce((select string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name)
              from declared_locks declared
             where declared.file = '0198'
               and not exists (select 1 from locks_seen held where held.label = 'after'
                                and held.table_name = declared.table_name and held.mode = declared.mode)), ''));
rollback to savepoint s198;

-- BILL-1 first (0162: cashier and billing_officer, and the invitable list that names them).
insert into auth.roles (code, description) values
  ('cashier', 'Cashier (synthetic, as BILL-1 0162 adds it)'),
  ('billing_officer', 'Billing officer (synthetic, as BILL-1 0162 adds it)');
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
:run0198
select pg_temp.expect('3i with BILL-1 first: the cashier and billing officer report too',
  'applied | 2 codes, 12 role rows, 14 audit rows | billing_officer,cashier',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0198() || ' | '
  || (select string_agg(role_code, ',' order by role_code) from auth.role_permissions
       where permission_code = 'quality.incident.report' and role_code in ('cashier', 'billing_officer')));
:run0198
select pg_temp.expect('3j and answers already applied there', '55000 0198: already applied',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s198;

-- Another staff role a department file cut before 0198 makes invitable, and a list that also names a narrow role
-- and an inactive role (never given).
insert into auth.roles (code, description, active) values
  ('midwife', 'Midwife (synthetic, a later department''s staff role)', true),
  ('porter', 'Porter (synthetic, inactive)', false);
create or replace function identity.staff_invitable_roles(target_organization_type text, target_product_code text)
returns text[]
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $invitable$
  select case
    when target_organization_type in ('hospital', 'clinic')
      or (target_organization_type = 'other' and target_product_code in ('ehr', 'migrate'))
      then array['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'midwife', 'work_list_reader', 'porter',
                 'org_admin_awaiting_review']
    else array[]::text[]
  end
$invitable$;
:run0198
select pg_temp.expect('3k another invitable staff role reports too; never a narrow, inactive or awaiting-review role',
  'applied | 2 codes, 11 role rows, 13 audit rows | midwife',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0198() || ' | '
  || (select string_agg(role_code, ',' order by role_code) from auth.role_permissions
       where permission_code like 'quality.%'
         and role_code not in ('receptionist', 'nurse', 'clinician', 'doctor', 'lab', 'pharmacist', 'admin', 'org_admin')));
rollback to savepoint s198;

-- 4. 0197 taken away too (0198 is away already in this transaction).
drop table ehr.quality_incident_events, ehr.quality_incident_actions, ehr.quality_incidents, ehr.quality_leads,
  ehr.quality_switches, ehr.quality_list_items, ehr.quality_list_versions;
drop function ehr.quality_me(),
  ehr.quality_incident_report(text, text, timestamptz, text, text, text, text, text, text, uuid, text, text),
  ehr.quality_incident_list(text, text, text, text, date, date, text, integer, timestamptz, uuid),
  ehr.quality_incident_read(uuid), ehr.quality_incident_assign(uuid, bigint, uuid, text, text),
  ehr.quality_incident_investigate(uuid, bigint, text, text, text),
  ehr.quality_incident_action_add(uuid, bigint, text, uuid, date, text, text),
  ehr.quality_incident_action_update(uuid, uuid, bigint, text, text, uuid, date, text, text),
  ehr.quality_incident_resolve(uuid, bigint, text, text, text), ehr.quality_incident_reopen(uuid, bigint, text, text, text),
  ehr.quality_incident_correct(uuid, bigint, text, text[], text, text, text, text, text, uuid, text, text),
  ehr.quality_incident_counts(text, text), ehr.quality_lead_list(), ehr.quality_lead_name(uuid, text, text),
  ehr.quality_lead_end(uuid, text, text, text), ehr.quality_caller(text), ehr.quality_patient_of_facility(uuid, uuid),
  ehr.quality_detail(uuid, uuid, boolean),
  ehr.quality_audit(text, uuid, uuid, uuid, uuid, text, uuid, text, text, text, text, jsonb),
  ehr.quality_idempotency(uuid, text, text), ehr.quality_incident_fixed_fields(), ehr.quality_action_fixed_fields(),
  ehr.quality_lead_end_once();
select pg_temp.expect('4a the state before 0197, for this transaction', '0 tables, 0 functions, 0 triggers, 0 policies',
  pg_temp.made0197());
:run0198
select pg_temp.expect('4b 0198 without 0197: refused', '55000 0198: 0197 must be applied first',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

savepoint s197;
create table ehr.quality_incidents (id integer);
:run0197
rollback to savepoint s197;
select pg_temp.expect('4c a half state (one of its tables there) is refused, nothing applied',
  '55000 0197: the schema is not in the reviewed state (part of 0197 is there, or not exactly as 0197 leaves it); nothing applied | '
  || '0 tables, 0 functions, 0 triggers, 0 policies',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0197());
create function ehr.quality_caller(required_level text) returns integer language sql as $$ select 1 $$;
:run0197
rollback to savepoint s197;
select pg_temp.expect('4d a half state (one of its functions there) is refused, nothing applied',
  '55000 0197: the schema is not in the reviewed state (part of 0197 is there, or not exactly as 0197 leaves it); nothing applied | '
  || '0 tables, 0 functions, 0 triggers, 0 policies',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0197());
do $$
begin
  execute regexp_replace(pg_get_functiondef('identity.own_facility_basis(uuid,uuid)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0197
rollback to savepoint s197;
select pg_temp.expect('4e a body it calls changed (0145''s own-facility basis) is refused, nothing applied',
  '55000 0197: these bodies are not as 0001-0153 left them: identity.own_facility_basis(uuid,uuid) | '
  || '0 tables, 0 functions, 0 triggers, 0 policies',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0197());
do $$
begin
  execute regexp_replace(pg_get_functiondef('platform.reject_mutation()'::regprocedure),
    'append-only', 'append only');
end $$;
:run0197
rollback to savepoint s197;
select pg_temp.expect('4f the guard function changed is refused, nothing applied',
  '55000 0197: these bodies are not as 0001-0153 left them: platform.reject_mutation() | '
  || '0 tables, 0 functions, 0 triggers, 0 policies',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0197());

-- 0197 applies, measuring its locks and this transaction's writes to existing tables.
create temporary table writes_before as
  select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) as n from pg_stat_xact_user_tables
   where relname not like 'quality\_%' and relname not in ('locks_seen', 'writes_before');
delete from locks_seen;
select pg_temp.record_locks('before');
:run0197
select pg_temp.record_locks('after');
select pg_temp.expect('4g 0197 applies', 'applied | 7 tables, 23 functions, 17 triggers, 7 policies',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0197());
select pg_temp.expect('4h every table and function owned by 0135''s owner (not the role that ran it), forced row-level security',
  '7/23/7',
  (select count(*) from pg_class where relnamespace = 'ehr'::regnamespace and relname like 'quality\_%' and relkind = 'r'
      and relowner = (select proowner from pg_proc where oid = 'ehr.visit_queue_update(uuid,bigint,text,smallint,boolean,uuid,boolean)'::regprocedure)
      and relowner <> (select oid from pg_roles where rolname = current_user)) || '/'
  || (select count(*) from pg_proc where pronamespace = 'ehr'::regnamespace and proname like 'quality\_%'
      and proowner = (select proowner from pg_proc where oid = 'ehr.visit_queue_update(uuid,bigint,text,smallint,boolean,uuid,boolean)'::regprocedure))
  || '/' || (select count(*) from pg_class where relnamespace = 'ehr'::regnamespace and relname like 'quality\_%'
      and relkind = 'r' and relrowsecurity and relforcerowsecurity));
select pg_temp.expect('4i the draft list and the switch off', 'QS-DRAFT-1:draft:true/16/patient_link:false',
  (select string_agg(list_version || ':' || status || ':' || active, ',') from ehr.quality_list_versions) || '/'
  || (select count(*) from ehr.quality_list_items) || '/'
  || (select string_agg(key || ':' || enabled, ',') from ehr.quality_switches));
select pg_temp.expect('4j no row of an existing table written (no audit row either)', '0',
  ((select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) from pg_stat_xact_user_tables
     where relname not like 'quality\_%' and relname not in ('locks_seen', 'writes_before'))
   - (select n from writes_before))::text);
select pg_temp.expect('4k 0197 takes no lock beyond its header''s', '',
  coalesce((select string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name, added.mode)
              from pg_temp.added_locks((select tables from existing_tables)) added
             where not exists (select 1 from declared_locks declared where declared.file = '0197'
                                and declared.table_name = added.table_name
                                and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(added.mode))), ''));
select pg_temp.expect('4l and holds every lock its header declares; none ACCESS EXCLUSIVE on an existing table', '/',
  coalesce((select string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name)
              from declared_locks declared
             where declared.file = '0197'
               and not exists (select 1 from locks_seen held where held.label = 'after'
                                and held.table_name = declared.table_name and held.mode = declared.mode)), '')
  || '/' || coalesce((select string_agg(added.table_name, ', ') from pg_temp.added_locks((select tables from existing_tables)) added
                       where added.mode = 'AccessExclusiveLock'), ''));
:run0197
select pg_temp.expect('4m and answers already applied again', '55000 0197: already applied',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

savepoint s197b;
do $$
begin
  execute regexp_replace(pg_get_functiondef('ehr.quality_patient_of_facility(uuid,uuid)'::regprocedure),
    '90 days', '120 days', 'g');
end $$;
:run0197
rollback to savepoint s197b;
select pg_temp.expect('4n a function changed afterwards: not in the reviewed state',
  '55000 0197: the schema is not in the reviewed state (part of 0197 is there, or not exactly as 0197 leaves it); nothing applied',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
grant execute on function ehr.quality_patient_of_facility(uuid, uuid) to hid_ehr_runtime;
:run0197
rollback to savepoint s197b;
select pg_temp.expect('4o a helper granted afterwards: not in the reviewed state',
  '55000 0197: the schema is not in the reviewed state (part of 0197 is there, or not exactly as 0197 leaves it); nothing applied',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
grant select on ehr.quality_incidents to hid_ehr_runtime;
:run0197
rollback to savepoint s197b;
select pg_temp.expect('4p a table granted afterwards: not in the reviewed state',
  '55000 0197: the schema is not in the reviewed state (part of 0197 is there, or not exactly as 0197 leaves it); nothing applied',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
drop policy quality_incidents_owner on ehr.quality_incidents;
:run0197
rollback to savepoint s197b;
select pg_temp.expect('4q a policy dropped afterwards: not in the reviewed state',
  '55000 0197: the schema is not in the reviewed state (part of 0197 is there, or not exactly as 0197 leaves it); nothing applied',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table ehr.quality_incident_events no force row level security;
:run0197
rollback to savepoint s197b;
select pg_temp.expect('4r row-level security no longer forced: not in the reviewed state',
  '55000 0197: the schema is not in the reviewed state (part of 0197 is there, or not exactly as 0197 leaves it); nothing applied',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table ehr.quality_incident_events disable trigger quality_incident_events_append_only;
:run0197
rollback to savepoint s197b;
select pg_temp.expect('4s a guard disabled: not in the reviewed state',
  '55000 0197: the schema is not in the reviewed state (part of 0197 is there, or not exactly as 0197 leaves it); nothing applied',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

:run0198
select pg_temp.expect('4t then 0198 applies on top', 'applied | 2 codes, 10 role rows, 12 audit rows',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0198());
:run0197
select pg_temp.expect('4u and each answers already applied again: 0197', '55000 0197: already applied',
  pg_temp.answer('0197', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0198
select pg_temp.expect('4v 0198 too', '55000 0198: already applied',
  pg_temp.answer('0198', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

select nextval('pg_temp.m197_passed') - 1 as passed \gset
\echo '0197-0198 migrations suite: ' :passed ' cases passed'
rollback;

\if :m197_dblink_available
\if :m197_dblink_create
drop extension dblink;
\endif
\endif
