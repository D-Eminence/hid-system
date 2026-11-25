\set ON_ERROR_STOP on
-- 0150 (owner decision Q141 B): every doctor can start or retry a
-- paper-record reading again (role doctor, permission ocr.job.start).
-- Rollback-only, apart from the dblink extension below. On a migrated
-- database 0150 has run already; the migration file is run here as written
-- (psql \ir), as the runner runs it inside its transaction:
--   1. busy refusals, first, before this transaction locks any table: a
--      second session (dblink) holds auth.role_permissions in SHARE mode
--      (readers go on; 0150's SHARE ROW EXCLUSIVE cannot be had): 0150 tries
--      for about 5 seconds and refuses with 55P03 "0150: ... stayed busy for
--      5 seconds; nothing applied; run the release again at a quieter time";
--      when this transaction already holds another file's strong lock, it
--      refuses at once ("... so it does not wait; ..."). Both messages are
--      the ones the runner's dry run retries (its own number first, its
--      wording last; hid-system#306), and nothing is applied;
--   2. back to the state before 0150 for this transaction (its row and its
--      audit row taken away), and fictional staff: doctors at a real
--      hospital, at the sealed QA hospital and at a sealed demo facility, the
--      doctor 0147 counted (doctor and reading_starter), a doctor whose login
--      is disabled, a doctor whose role is revoked, a nurse, a clinician, a
--      front desk member, an administrator and a laboratory member;
--   3. before 0150, through auth.membership_has_permission (what every
--      service checks): no doctor alone starts a reading, every doctor checks
--      and follows readings (ocr.job.write, ocr.job.read); the nurse, the
--      clinician, the front desk and the counted doctor start readings;
--   4. 0150 applies: every active doctor starts readings, at real and sealed
--      facilities alike; every other permission of every member is as
--      before (doctors still read neither work list and no Outreach code);
--      the doctor's codes are the 35 pinned ones plus ocr.job.start; no other
--      role's row changes; 0147's two roles are unchanged; no function,
--      policy or privilege changes (runtime-grants.sql unchanged); one audit
--      row as the system actor with no account, membership, facility or
--      patient;
--   5. a second run answers "0150: already applied" (55000) and changes
--      nothing;
--   6. the preconditions refuse (55000, nothing applied): a doctor's code
--      changed, the row there beside another change, a nurse without
--      ocr.job.start, reading_starter inactive, the permission check not as
--      Release C leaves it.
-- Synthetic values only: uuid prefix c150, @example.invalid addresses.
set plpgsql.variable_conflict = error;

-- dblink is needed for the second session of 1. Creating it inside the
-- suite's transaction would lock its result type at ACCESS EXCLUSIVE, which
-- 0150 reads as "this transaction holds an earlier migration's locks", so it
-- is created before the transaction (when the server has it and it is not
-- there yet) and dropped again at the end.
select exists (select 1 from pg_available_extensions where name = 'dblink') as q150_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as q150_dblink_create \gset
\if :q150_dblink_available
\if :q150_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

-- Runs 0150 as written and keeps what it answered (SQLSTATE and message, or
-- 'applied'). 0150 is one statement, so when it raises, ON_ERROR_ROLLBACK
-- undoes all of it, as the runner's transaction does.
\set run0150 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0150_doctors_start_readings_again.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
-- A case: stops the suite at once when it fails. (Functions only until 1 is
-- done: a temporary table or sequence would be a relation this transaction
-- holds at ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0150 doctors start readings suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  -- Counted in a setting until 1 is done, then in a sequence (which keeps
  -- its count across ROLLBACK TO SAVEPOINT, which the cases below use).
  if to_regclass('pg_temp.q150_passed') is null then
    perform set_config('q150.passed', (coalesce(nullif(current_setting('q150.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.q150_passed');
  end if;
  raise notice '0150 suite: % passed', case_name;
end
$$;
-- The runner's test for a file's own busy refusal (dry-run-attempts.mjs).
create function pg_temp.busy_refusal(sqlstate text, message text) returns text language sql immutable as $$
  select case when sqlstate = '55P03' and message ~ '^0150: '
                   and message ~ '(so it does not wait|stayed busy for 5 seconds)(; nothing applied)?; run the release again at a quieter time$'
              then 'busy refusal: ' || substring(message from '(so it does not wait|stayed busy for 5 seconds)')
              else sqlstate || ' ' || message end;
$$;
create function pg_temp.made() returns text language sql as $$
  select (select count(*) from auth.role_permissions where role_code = 'doctor' and permission_code = 'ocr.job.start')
      || ' rows, ' || (select count(*) from audit.events where correlation_id = '0150-doctors-start-readings-q141b')
      || ' audit rows';
$$;

-- 1. Busy refusals.
\if :q150_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('q150_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select public.dblink_exec('q150_blocker', 'begin') as began \gset
select public.dblink_exec('q150_blocker', 'lock table auth.role_permissions in share mode') as blocked \gset
select pg_temp.made() as made_before_busy \gset
:run0150
select pg_temp.expect('1b auth.role_permissions held by another session: 0150 tries for 5 seconds, then refuses as the runner retries',
  'busy refusal: stayed busy for 5 seconds | ' || :'made_before_busy',
  pg_temp.busy_refusal(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0150
select pg_temp.made() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: refuses at once',
  'busy refusal: so it does not wait | ' || :'made_before_busy',
  pg_temp.busy_refusal(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made_holding');
select public.dblink_exec('q150_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('q150_blocker') as disconnected \gset
\else
\echo '0150 suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

create temporary sequence q150_passed;
select setval('pg_temp.q150_passed', coalesce(nullif(current_setting('q150.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- 2. Back to the state before 0150, for this transaction: its row, and its
-- audit row (append-only, so with triggers off).
set local session_replication_role = replica;
delete from audit.events where correlation_id = '0150-doctors-start-readings-q141b';
set local session_replication_role = origin;
delete from auth.role_permissions where role_code = 'doctor' and permission_code = 'ocr.job.start';
-- A later file's role rows go too (0198, QUAL-1: the quality and safety reporting rows), so the role table is as
-- 0150 found it.
delete from auth.role_permissions where permission_code like 'quality.%';
select pg_temp.expect('2a the state before 0150, for this transaction', '0 rows, 0 audit rows', pg_temp.made());
select pg_temp.expect('2b the doctor''s codes as Release C leaves them (0150''s pin)', '35 186a1ece641bffd2be5ebb05b80479b2',
  (select count(*) || ' ' || md5(string_agg(permission_code, ',' order by permission_code collate "C"))
     from auth.role_permissions where role_code = 'doctor'));
create temporary table rows_before on commit drop as
  select role_code, permission_code, granted_at from auth.role_permissions;
create temporary table roles_before on commit drop as
  select to_jsonb(role_row)::text as role_json from auth.roles role_row;
-- Every function (body, grants, owner, settings, comment), policy and table
-- privilege, to show 0150 changes none.
create function pg_temp.catalog_print() returns text language sql as $$
  select md5(coalesce((select string_agg(proc.oid::text || ':' || md5(proc.prosrc) || ':'
                                         || coalesce(proc.proacl::text, '') || ':' || proc.proowner || ':'
                                         || proc.prosecdef || ':' || coalesce(proc.proconfig::text, '') || ':'
                                         || coalesce(obj_description(proc.oid, 'pg_proc'), ''), ',' order by proc.oid)
                         from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                        where namespace.nspname not in ('pg_catalog', 'information_schema')
                          and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'), '')
             || '|' || coalesce((select string_agg(policy.oid::text || ':' || policy.polname, ',' order by policy.oid)
                                   from pg_policy policy), '')
             || '|' || coalesce((select string_agg(class.oid::text || ':' || coalesce(class.relacl::text, ''), ','
                                                   order by class.oid)
                                   from pg_class class join pg_namespace namespace on namespace.oid = class.relnamespace
                                  where namespace.nspname not in ('pg_catalog', 'information_schema')
                                    and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'), ''));
$$;
select pg_temp.catalog_print() as catalog_before \gset

-- The locks 0150 takes, measured here, before the fixtures (whose own
-- foreign key checks would already hold most of them): every table lock it
-- adds to those this transaction held, at its strongest mode, and the
-- strongest it holds on audit.events (which the delete above already holds
-- at ROW EXCLUSIVE). Then rolled back.
savepoint locks;
create temporary table locks_before on commit drop as
  select lock_row.relation, lock_row.mode from pg_locks lock_row
   where lock_row.pid = pg_backend_pid() and lock_row.granted and lock_row.locktype = 'relation';
:run0150
create temporary table locks_after on commit drop as
  select lock_row.relation, lock_row.mode from pg_locks lock_row
   where lock_row.pid = pg_backend_pid() and lock_row.granted and lock_row.locktype = 'relation';
create function pg_temp.lock_rank(mode text) returns integer language sql immutable as $$
  select array_position(array['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
    'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'], mode);
$$;
select pg_temp.expect('2c the locks: the tables and modes 0150''s Locks paragraph declares, nothing else, nothing stronger',
  'applied | added: auth.accounts RowShareLock, auth.permissions RowShareLock, '
  || 'auth.role_permissions ShareRowExclusiveLock, auth.roles RowShareLock, identity.facilities RowShareLock, '
  || 'identity.organizations RowShareLock, identity.patients RowShareLock, '
  || 'identity.staff_facility_memberships RowShareLock | audit.events RowExclusiveLock',
  case when :'LAST_ERROR_MESSAGE' = 'applied' then 'applied' else :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' end
  || ' | added: ' || (select string_agg(table_name || ' ' || strongest, ', ' order by table_name)
     from (select namespace.nspname || '.' || class.relname as table_name,
                  (array_agg(locks_after.mode order by pg_temp.lock_rank(locks_after.mode) desc))[1] as strongest
             from locks_after
             join pg_class class on class.oid = locks_after.relation and class.relkind in ('r', 'p')
             join pg_namespace namespace on namespace.oid = class.relnamespace
            where namespace.nspname not in ('pg_catalog', 'information_schema') and namespace.nspname not like 'pg_temp%'
              and not exists (select 1 from locks_before
                               where locks_before.relation = locks_after.relation
                                 and locks_before.mode = locks_after.mode)
            group by namespace.nspname, class.relname) added)
  || ' | audit.events ' || (select (array_agg(locks_after.mode order by pg_temp.lock_rank(locks_after.mode) desc))[1]
                              from locks_after where locks_after.relation = 'audit.events'::regclass));
rollback to savepoint locks;
select pg_temp.expect('2d rolled back for the next cases', '0 rows, 0 audit rows', pg_temp.made());

-- Fixtures. Organisation O; the real Hospital F1, the sealed QA hospital F2
-- and a sealed demo facility F3 (recorded as sealed members).
-- Members (n, facility, roles, login status, revoked):
--   1 doctor at F1; 2 doctor at F2 (sealed QA); 3 doctor at F3 (sealed demo);
--   4 doctor and reading_starter at F1 (the doctor 0147 counted);
--   5 doctor at F1, login disabled; 6 doctor at F1, the role revoked;
--   7 nurse; 8 clinician; 9 receptionist (front desk); 10 admin; 11 lab.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('c1506000-0000-4000-8000-000000000001', 'Doctors Readings Test Org', 'doctors-readings-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c1506000-0000-4000-8000-000000000002', 'c1506000-0000-4000-8000-000000000001', 'Doctors Readings Hospital',
   'DR-150-A', 'Africa/Lagos', true, 'verified'),
  ('c1506000-0000-4000-8000-000000000003', 'c1506000-0000-4000-8000-000000000001', 'Doctors Readings QA Hospital',
   'DR-150-Q', 'Africa/Lagos', true, 'verified'),
  ('c1506000-0000-4000-8000-000000000004', 'c1506000-0000-4000-8000-000000000001', 'Doctors Readings Demo',
   'DR-150-D', 'Africa/Lagos', true, 'verified');
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('facility', 'c1506000-0000-4000-8000-000000000003');
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('facility', 'c1506000-0000-4000-8000-000000000004');
create temporary table dr_member (n integer primary key, facility text, roles text[], account_status text,
  revoked boolean) on commit drop;
insert into dr_member values
  (1, '2', array['doctor'], 'active', false),
  (2, '3', array['doctor'], 'active', false),
  (3, '4', array['doctor'], 'active', false),
  (4, '2', array['doctor', 'reading_starter'], 'active', false),
  (5, '2', array['doctor'], 'disabled', false),
  (6, '2', array['doctor'], 'active', true),
  (7, '2', array['nurse'], 'active', false),
  (8, '2', array['clinician'], 'active', false),
  (9, '2', array['receptionist'], 'active', false),
  (10, '2', array['admin'], 'active', false),
  (11, '2', array['lab'], 'active', false);
create function pg_temp.dr_id(kind text, n integer) returns uuid language sql immutable as $$
  select ('c150' || kind || '000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
$$;
create function pg_temp.dr_facility(n integer) returns uuid language sql stable as $$
  select ('c1506000-0000-4000-8000-00000000000' || (select facility from dr_member where dr_member.n = $1))::uuid;
$$;
insert into auth.accounts (id, subject, email, display_name, status)
select pg_temp.dr_id('1', n), 'staff:doctors-readings-' || n, 'doctors-readings-' || n || '@example.invalid',
  'Doctors Readings Staff ' || n, account_status
  from dr_member;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select pg_temp.dr_id('2', n), pg_temp.dr_id('1', n), 'Doctors Readings Staff ' || n,
  'doctors-readings-' || n || '@example.invalid', 'verified', roles[1]
  from dr_member;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select pg_temp.dr_id('3', n), pg_temp.dr_id('2', n), pg_temp.dr_id('1', n), 'c1506000-0000-4000-8000-000000000001',
  pg_temp.dr_facility(n), roles[1], roles[1], true, true
  from dr_member;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason,
  granted_at, revoked_at, revoked_by, revocation_reason)
select ('c1504000-0000-4000-8000-0000000' || lpad((member.n * 10 + role_row.k)::text, 5, '0'))::uuid,
  pg_temp.dr_id('1', member.n), role_row.role_code, 'facility', pg_temp.dr_id('3', member.n),
  pg_temp.dr_facility(member.n), 'Synthetic 0150 suite role', clock_timestamp() - interval '1 day',
  case when member.revoked then clock_timestamp() end,
  case when member.revoked then pg_temp.dr_id('1', 10) end,
  case when member.revoked then 'Synthetic 0150 suite revocation' end
  from dr_member member
  cross join lateral unnest(member.roles) with ordinality role_row(role_code, k);
set local session_replication_role = origin;
select pg_temp.expect('2e fixtures: 11 members, 12 role rows', '11 12',
  (select count(*) from dr_member) || ' ' || (select count(*) from auth.account_roles where id::text like 'c1504000-%'));

-- 3. Before 0150. Each member's reading abilities at its facility, as every
-- service reads them: "start write read" ('-' where not held).
create function pg_temp.holds(n integer, permission text) returns boolean language sql as $$
  select coalesce(auth.membership_has_permission('staff:doctors-readings-' || n, pg_temp.dr_id('3', n),
    pg_temp.dr_facility(n), permission), false);
$$;
create function pg_temp.reading(n integer) returns text language sql as $$
  select case when pg_temp.holds(n, 'ocr.job.start') then 'start' else '-' end || ' '
      || case when pg_temp.holds(n, 'ocr.job.write') then 'write' else '-' end || ' '
      || case when pg_temp.holds(n, 'ocr.job.read') then 'read' else '-' end;
$$;
create function pg_temp.readings() returns text language sql as $$
  select string_agg(n || ' ' || pg_temp.reading(n), ' | ' order by n) from dr_member;
$$;
-- Every member's every active permission, to show nothing else moves.
create temporary table access_seen (stage text, n integer, permission_code text) on commit drop;
create function pg_temp.see(stage text) returns void language sql as $$
  insert into access_seen
  select stage, member.n, permission_row.code
    from dr_member member cross join auth.permissions permission_row
   where pg_temp.holds(member.n, permission_row.code);
$$;
select pg_temp.see('before');
select pg_temp.expect('3a before 0150: no doctor alone starts a reading; every active doctor checks and follows readings; the nurse, clinician, front desk and the counted doctor (reading_starter) start them',
  '1 - write read | 2 - write read | 3 - write read | 4 start write read | 5 - - - | 6 - - - | 7 start write read | '
  || '8 start write read | 9 start write - | 10 - - read | 11 - - -',
  pg_temp.readings());

-- 4. 0150 applies.
:run0150
select pg_temp.expect('4a it applies: the row and one audit row', 'applied | 1 rows, 1 audit rows',
  case when :'LAST_ERROR_MESSAGE' = 'applied' then 'applied' else :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' end
  || ' | ' || pg_temp.made());
select pg_temp.expect('4b every active doctor starts readings, at the real hospital and the sealed QA and demo facilities; a disabled login and a revoked role still cannot; everyone else as before',
  '1 start write read | 2 start write read | 3 start write read | 4 start write read | 5 - - - | 6 - - - | '
  || '7 start write read | 8 start write read | 9 start write - | 10 - - read | 11 - - -',
  pg_temp.readings());
select pg_temp.see('after');
select pg_temp.expect('4c no member''s other permission changed: the only difference is ocr.job.start for doctors 1, 2 and 3',
  '1 + ocr.job.start | 2 + ocr.job.start | 3 + ocr.job.start',
  (select string_agg(change, ' | ' order by change) from (
     select after_row.n || ' + ' || after_row.permission_code as change
       from access_seen after_row where after_row.stage = 'after'
        and not exists (select 1 from access_seen before_row where before_row.stage = 'before'
                         and before_row.n = after_row.n and before_row.permission_code = after_row.permission_code)
     union all
     select before_row.n || ' - ' || before_row.permission_code
       from access_seen before_row where before_row.stage = 'before'
        and not exists (select 1 from access_seen after_row where after_row.stage = 'after'
                         and after_row.n = before_row.n and after_row.permission_code = before_row.permission_code)) changed));
select pg_temp.expect('4d doctors still read neither work list and hold no Outreach code (Q103 A)', '0',
  (select count(*)::text from auth.role_permissions where role_code = 'doctor'
      and (permission_code in ('lab.work-item.read', 'pharmacy.work-item.read') or permission_code like 'outreach.%')));
select pg_temp.expect('4e the doctor''s codes: the 35 pinned ones plus ocr.job.start (0150''s post-check pin)',
  '36 9da3f7c9be69ae834e9f7a7555eb3e07',
  (select count(*) || ' ' || md5(string_agg(permission_code, ',' order by permission_code collate "C"))
     from auth.role_permissions where role_code = 'doctor'));
select pg_temp.expect('4f no other row of the role table changed, and the new row is the only new one', '0 0 1',
  (select count(*) from (select role_code, permission_code, granted_at from auth.role_permissions
                          except select role_code, permission_code, granted_at from rows_before) more
    where (more.role_code, more.permission_code) <> ('doctor', 'ocr.job.start'))
  || ' ' || (select count(*) from (select role_code, permission_code, granted_at from rows_before
                                   except select role_code, permission_code, granted_at from auth.role_permissions) fewer)
  || ' ' || (select count(*) from auth.role_permissions grant_row
              where not exists (select 1 from rows_before old_row where old_row.role_code = grant_row.role_code
                                  and old_row.permission_code = grant_row.permission_code)));
select pg_temp.expect('4g who starts readings', 'clinician doctor nurse reading_starter receptionist',
  (select string_agg(role_code, ' ' order by role_code collate "C") from auth.role_permissions
    where permission_code = 'ocr.job.start'));
select pg_temp.expect('4h no role changed (0147''s two included) and 0147''s assignments are as they were', '0 0 1',
  (select count(*) from (select to_jsonb(role_row)::text from auth.roles role_row
                          except select role_json from roles_before) changed)
  || ' ' || (select count(*) from (select role_json from roles_before
                                   except select to_jsonb(role_row)::text from auth.roles role_row) gone)
  || ' ' || (select count(*) from auth.account_roles
              where role_code = 'reading_starter' and membership_id = pg_temp.dr_id('3', 4) and revoked_at is null));
select pg_temp.expect('4i no function, policy or privilege changed (runtime-grants.sql unchanged)', 'same',
  case when pg_temp.catalog_print() = :'catalog_before' then 'same' else 'changed' end);
select pg_temp.expect('4j the audit row: system actor, no account, membership, facility or patient, the owner''s reason',
  'system auth.role-permission.add success role-permission doctor/ocr.job.start healthcare-operations migration hid-0150 '
  || '| Owner decision Q141 B (24 November 2026): every doctor starts paper readings again '
  || '| {"decision": "Q141 B", "roleCode": "doctor", "migration": "0150", "permissionCode": "ocr.job.start"} | 0',
  (select event_row.actor_type || ' ' || event_row.action || ' ' || event_row.outcome || ' ' || event_row.resource_type
          || ' ' || event_row.resource_id || ' ' || event_row.purpose_of_use || ' ' || event_row.provenance || ' '
          || event_row.source_system || ' | ' || event_row.reason || ' | ' || event_row.details::text || ' | '
          || num_nonnulls(event_row.actor_subject, event_row.actor_account_id, event_row.actor_membership_id,
                          event_row.organization_id, event_row.facility_id, event_row.patient_id)
     from audit.events event_row where event_row.correlation_id = '0150-doctors-start-readings-q141b'));
-- 5. Run again: "already applied", nothing changed.
savepoint applied;
:run0150
select pg_temp.expect('5a a second run answers "already applied" and changes nothing',
  '55000 0150: already applied | 1 rows, 1 audit rows | same',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || pg_temp.made() || ' | '
  || case when pg_temp.catalog_print() = :'catalog_before' then 'same' else 'changed' end);
rollback to savepoint applied;
-- The row there beside another change: not the state 0150 leaves.
insert into auth.role_permissions (role_code, permission_code) values ('doctor', 'lab.work-item.read');
:run0150
select pg_temp.expect('5b the row there, but the doctor also holds a code 0136 took: refuses, nothing changed',
  '55000 0150: the role table is not in the reviewed state (doctor already holds ocr.job.start, with other codes than 0150 leaves); nothing applied | 1 rows, 1 audit rows',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || pg_temp.made());
rollback to savepoint applied;

-- 6. The preconditions, each on the state before 0150 (its row and audit row
-- taken away again).
set local session_replication_role = replica;
delete from audit.events where correlation_id = '0150-doctors-start-readings-q141b';
set local session_replication_role = origin;
delete from auth.role_permissions where role_code = 'doctor' and permission_code = 'ocr.job.start';
select pg_temp.expect('6a back before 0150', '0 rows, 0 audit rows', pg_temp.made());
savepoint before_0150;
insert into auth.role_permissions (role_code, permission_code) values ('doctor', 'pharmacy.work-item.read');
:run0150
select pg_temp.expect('6b a doctor''s code not as Release C leaves it: refuses, nothing applied',
  '55000 0150: the role table is not in the reviewed state (the doctor''s codes, the holders of ocr.job.start or reading_starter''s codes differ from Release C); nothing applied | 0 rows, 0 audit rows',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || pg_temp.made());
rollback to savepoint before_0150;
delete from auth.role_permissions where role_code = 'nurse' and permission_code = 'ocr.job.start';
:run0150
select pg_temp.expect('6c the nurse without ocr.job.start: refuses, nothing applied',
  '55000 0150: the role table is not in the reviewed state (the doctor''s codes, the holders of ocr.job.start or reading_starter''s codes differ from Release C); nothing applied | 0 rows, 0 audit rows',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || pg_temp.made());
rollback to savepoint before_0150;
update auth.roles set active = false where code = 'reading_starter';
:run0150
select pg_temp.expect('6d reading_starter inactive: refuses, nothing applied',
  '55000 0150: role missing or inactive: reading_starter | 0 rows, 0 audit rows',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || pg_temp.made());
rollback to savepoint before_0150;
update auth.permissions set active = false where code = 'ocr.job.start';
:run0150
select pg_temp.expect('6e ocr.job.start inactive: refuses, nothing applied',
  '55000 0150: permission missing or inactive: ocr.job.start | 0 rows, 0 audit rows',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || pg_temp.made());
rollback to savepoint before_0150;
do $$
declare
  check_oid regprocedure := 'auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure;
  body text := (select proc.prosrc from pg_proc proc where proc.oid = check_oid);
begin
  execute replace(pg_get_functiondef(check_oid), body, body || '    -- changed by the 0150 suite' || chr(10));
end $$;
:run0150
select pg_temp.expect('6f the permission check not as Release C leaves it: refuses, nothing applied',
  '55000 0150: auth.membership_has_permission is not as Release C leaves it; nothing applied | 0 rows, 0 audit rows',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || pg_temp.made());
rollback to savepoint before_0150;
:run0150
select pg_temp.expect('6g with every precondition met again it applies', 'applied | 1 rows, 1 audit rows',
  :'LAST_ERROR_MESSAGE' || ' | ' || pg_temp.made());

do $$
declare
  wanted integer := case when exists (select 1 from pg_extension where extname = 'dblink') then 28 else 25 end;
begin
  if currval('pg_temp.q150_passed') is distinct from wanted then
    raise exception '0150 doctors start readings suite failed: % cases ran, % expected',
      currval('pg_temp.q150_passed'), wanted;
  end if;
  raise notice '0150 doctors start readings suite: % cases passed', wanted;
end $$;
rollback;

\if :q150_dblink_available
\if :q150_dblink_create
drop extension dblink;
\endif
\endif
