\set ON_ERROR_STOP on
-- 0160 and 0161 (APPT-1, Release D): the migration files themselves, run as
-- written (psql \ir) the way the runner runs them inside its transaction.
-- Rollback-only, apart from the dblink extension below. On a migrated
-- database both have run already:
--   1. busy refusals, first, before this transaction locks any table: a
--      second session (dblink) holds ehr.visit_queue (for 0160) or
--      platform.control_settings (for 0161) in ACCESS SHARE mode (readers go
--      on; the file's ACCESS EXCLUSIVE cannot be had): the file tries for
--      about 5 seconds and refuses with 55P03 "0160: ... stayed busy for 5
--      seconds; nothing applied; run the release again at a quieter time";
--      when this transaction already holds another file's strong lock, it
--      refuses at once ("... so it does not wait; ..."). Both messages are
--      the ones the runner's dry run retries (its own number first, its
--      wording last; hid-system#306), and nothing is applied. The same when
--      the other session holds identity.sealed_qa_members (ACCESS EXCLUSIVE:
--      0160 now takes the sealed-member tables up front, NOWAIT);
--   2. a second run of each answers "already applied" (55000) and changes
--      nothing;
--   3. 0161 taken away for this transaction: a half state ("not in the
--      reviewed state") and a changed pinned body refuse with 55000 and apply
--      nothing; then 0161 applies: its objects, the control seeded off, one
--      audit row; it takes no lock beyond its header's and every lock its
--      header declares;
--   4. 0160 taken away too: a half state, a changed pinned body, a changed
--      role table and a changed waiting-list CHECK refuse; then 0160 applies:
--      the four tables, the 18 functions, the seven role rows and seven audit
--      rows, the CHECK; it takes no lock beyond its header's and every lock
--      its header declares; then 0161 applies on top.
-- Synthetic values only.
set plpgsql.variable_conflict = error;

-- dblink is created before the transaction (creating it inside would lock its
-- result type at ACCESS EXCLUSIVE, which the files read as "this transaction
-- holds an earlier migration's locks") and dropped again at the end.
select exists (select 1 from pg_available_extensions where name = 'dblink') as m160_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as m160_dblink_create \gset
\if :m160_dblink_available
\if :m160_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0160 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0160_appointments.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0161 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0161_appointment_notices_and_call_list.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'

-- A case: stops the suite at once when it fails. (Functions only until 1 is
-- done: a temporary table or sequence would be a relation this transaction
-- holds at ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0160-0161 migrations suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  -- Counted in a setting until 1 is done, then in a sequence (which keeps its count across ROLLBACK TO SAVEPOINT).
  if to_regclass('pg_temp.m160_passed') is null then
    perform set_config('m160.passed', (coalesce(nullif(current_setting('m160.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.m160_passed');
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
create function pg_temp.made0160() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('ehr.appointment_settings'),
            to_regclass('ehr.appointment_clinics'), to_regclass('ehr.appointments'), to_regclass('ehr.appointment_events')))
      || ' tables, ' || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                          where namespace.nspname = 'ehr' and proc.proname like 'appointment%'
                            and proc.proname not in ('appointment_notice', 'appointment_events_notify',
                                                     'appointment_send_reminders', 'appointment_my_list'))
      || ' functions, ' || (select count(*) from auth.role_permissions where permission_code like 'ehr.appointment.%')
      || ' role rows, ' || (select count(*) from audit.events where correlation_id = '0160-appointments-appt1')
      || ' audit rows';
$$;
create function pg_temp.made0161() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('ehr.appointment_email_outbox'),
            to_regclass('ehr.appointment_sms_outbox')))
      || ' tables, ' || (select count(*) from pg_proc
                          where oid in (to_regprocedure('ehr.appointment_notice(uuid,text,timestamptz)'),
                                        to_regprocedure('ehr.appointment_events_notify()'),
                                        to_regprocedure('ehr.appointment_send_reminders(integer)'),
                                        to_regprocedure('ehr.appointment_my_list(uuid,text,integer,timestamptz,uuid)'),
                                        to_regprocedure('identity.appointment_call_list(date,uuid,uuid)'),
                                        to_regprocedure('identity.appointment_sms_claim(integer)'),
                                        to_regprocedure('identity.appointment_sms_record(uuid,text,text)'),
                                        to_regprocedure('identity.appointment_email_claim(text,integer,integer)'),
                                        to_regprocedure('identity.appointment_email_record(uuid,text,text,text)')))
      || ' functions, ' || (select count(*) from platform.control_settings
                             where control_key = 'appointment_sms_reminders_enabled' and not enabled)
      || ' control off, ' || (select count(*) from audit.events where correlation_id = '0161-appointment-notices-appt1')
      || ' audit rows';
$$;

-- 1. Busy refusals.
\if :m160_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('m160_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select pg_temp.made0160() as made0160_before \gset
select pg_temp.made0161() as made0161_before \gset
select public.dblink_exec('m160_blocker', 'begin') as began \gset
select public.dblink_exec('m160_blocker', 'lock table ehr.visit_queue in access share mode') as blocked \gset
:run0160
select pg_temp.expect('1b ehr.visit_queue read by another session: 0160 tries for 5 seconds, then refuses as the runner retries',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0160_before',
  pg_temp.answer('0160', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0160());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0160
select pg_temp.made0160() as made0160_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: 0160 refuses at once',
  'busy refusal: so it does not wait | ' || :'made0160_before',
  pg_temp.answer('0160', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made0160_holding');
select public.dblink_exec('m160_blocker', 'rollback') as ended \gset
select public.dblink_exec('m160_blocker', 'begin') as began \gset
select public.dblink_exec('m160_blocker', 'lock table identity.sealed_qa_members in access exclusive mode') as blocked \gset
:run0160
select pg_temp.expect('1c2 identity.sealed_qa_members held by another session: 0160 tries for 5 seconds, then refuses as the runner retries',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0160_before',
  pg_temp.answer('0160', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0160());
select public.dblink_exec('m160_blocker', 'rollback') as ended \gset
select public.dblink_exec('m160_blocker', 'begin') as began \gset
select public.dblink_exec('m160_blocker', 'lock table platform.control_settings in access share mode') as blocked \gset
:run0161
select pg_temp.expect('1d platform.control_settings read by another session: 0161 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0161_before',
  pg_temp.answer('0161', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0161());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0161
select pg_temp.made0161() as made0161_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1e the same while this transaction holds an earlier file''s lock: 0161 refuses at once',
  'busy refusal: so it does not wait | ' || :'made0161_before',
  pg_temp.answer('0161', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'made0161_holding');
select public.dblink_exec('m160_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('m160_blocker') as disconnected \gset
\else
\echo '0160-0161 migrations suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

create temporary sequence m160_passed;
select setval('pg_temp.m160_passed', coalesce(nullif(current_setting('m160.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- 2. A second run.
select pg_temp.made0160() as made0160_applied \gset
select pg_temp.made0161() as made0161_applied \gset
select pg_temp.expect('2a 0160 and 0161 are applied here', '4 tables, 18 functions, 7 role rows, 7 audit rows | '
  || '2 tables, 9 functions, 1 control off, 1 audit rows', :'made0160_applied' || ' | ' || :'made0161_applied');
:run0160
select pg_temp.expect('2b 0160 again: already applied, nothing changed', '55000 0160: already applied | ' || :'made0160_applied',
  pg_temp.answer('0160', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0160());
:run0161
select pg_temp.expect('2c 0161 again: already applied, nothing changed', '55000 0161: already applied | ' || :'made0161_applied',
  pg_temp.answer('0161', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0161());

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
-- A lock the header declares covers the same table at the same or a weaker mode (a file that takes SHARE ROW
-- EXCLUSIVE on a table also reads it).
create temporary table declared_locks (file text, table_name text, mode text);
insert into declared_locks values
  ('0160', 'identity.patients', 'ShareRowExclusiveLock'), ('0160', 'identity.facilities', 'ShareRowExclusiveLock'),
  ('0160', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'),
  ('0160', 'auth.role_permissions', 'ShareRowExclusiveLock'), ('0160', 'ehr.visit_queue', 'AccessExclusiveLock'),
  ('0160', 'auth.permissions', 'RowExclusiveLock'), ('0160', 'audit.events', 'RowExclusiveLock'),
  ('0160', 'auth.roles', 'RowShareLock'), ('0160', 'auth.accounts', 'RowShareLock'),
  ('0160', 'identity.organizations', 'RowShareLock'), ('0160', 'identity.consent_directives', 'AccessShareLock'),
  ('0160', 'identity.consent_directive_versions', 'AccessShareLock'),
  ('0160', 'identity.facility_profiles', 'AccessShareLock'), ('0160', 'auth.account_roles', 'AccessShareLock'),
  ('0160', 'identity.sealed_demo_members', 'AccessShareLock'), ('0160', 'identity.sealed_qa_members', 'AccessShareLock'),
  ('0161', 'platform.control_settings', 'AccessExclusiveLock'),
  ('0161', 'ehr.appointment_events', 'ShareRowExclusiveLock'), ('0161', 'ehr.appointments', 'ShareRowExclusiveLock'),
  ('0161', 'identity.patients', 'ShareRowExclusiveLock'), ('0161', 'identity.facilities', 'ShareRowExclusiveLock'),
  ('0161', 'identity.patient_facility_contacts', 'AccessShareLock'), ('0161', 'identity.staff', 'AccessShareLock'),
  ('0161', 'auth.accounts', 'AccessShareLock'), ('0161', 'auth.permissions', 'AccessShareLock'),
  ('0161', 'audit.events', 'RowExclusiveLock');
-- Every table that exists now, before 3 and 4 take the files away (their own new tables are left out of the
-- comparison because they do not exist before the run).
create temporary table existing_tables as
  select array_agg(relation.oid::regclass) as tables from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
   where relation.relkind in ('r', 'p', 'v', 'm')
     and namespace.nspname not in ('pg_catalog', 'information_schema', 'migration')
     and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'
     and relation.relname not like 'appointment%';

-- 3. 0161 taken away for this transaction (its history row with triggers off: the audit log is append-only).
drop trigger appointment_events_notify on ehr.appointment_events;
drop function ehr.appointment_events_notify(), ehr.appointment_notice(uuid, text, timestamptz),
  ehr.appointment_send_reminders(integer), ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid),
  identity.appointment_call_list(date, uuid, uuid), identity.appointment_sms_claim(integer),
  identity.appointment_sms_record(uuid, text, text), identity.appointment_email_claim(text, integer, integer),
  identity.appointment_email_record(uuid, text, text, text);
drop table ehr.appointment_email_outbox, ehr.appointment_sms_outbox;
delete from platform.control_settings where control_key = 'appointment_sms_reminders_enabled';
alter table platform.control_settings drop constraint control_settings_control_key_check;
alter table platform.control_settings add constraint control_settings_control_key_check check (control_key in (
  'patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
  'maintenance_mode', 'uploads_enabled', 'break_glass_enabled',
  'provider_self_service_enabled', 'staff_invitations_enabled',
  'cross_facility_orders_enabled', 'cross_facility_route_access_enabled',
  'outreach_organiser_signup_enabled'));
do $$
begin
  execute replace(pg_get_functiondef('platform.control_enabled(text)'::regprocedure),
    E'    ''outreach_organiser_signup_enabled'',''appointment_sms_reminders_enabled''\n  ) then',
    E'    ''outreach_organiser_signup_enabled''\n  ) then');
end $$;
set local session_replication_role = replica;
delete from audit.events where correlation_id = '0161-appointment-notices-appt1';
set local session_replication_role = origin;
select pg_temp.expect('3a the state before 0161, for this transaction', '0 tables, 0 functions, 0 control off, 0 audit rows',
  pg_temp.made0161());
select pg_temp.expect('3b platform.control_enabled is 0115''s body again', '1d24fbded6edff32d934d319b0135fb2',
  (select md5(prosrc) from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure));

savepoint s161;
create table ehr.appointment_sms_outbox (id integer);
:run0161
rollback to savepoint s161;
select pg_temp.expect('3c a half state (one of its tables there) is refused, nothing applied',
  '55000 0161: the schema is not in the reviewed state (part of 0161 is there); nothing applied | '
  || '0 tables, 0 functions, 0 control off, 0 audit rows',
  pg_temp.answer('0161', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0161());
do $$
begin
  execute regexp_replace(pg_get_functiondef('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'::regprocedure),
    '\mbegin\M', 'begin -- changed');
end $$;
:run0161
rollback to savepoint s161;
select pg_temp.expect('3d a body it calls changed (0037''s inbox function) is refused, nothing applied',
  '55000 0161: these bodies are not as 0001-0160 left them: notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb) | '
  || '0 tables, 0 functions, 0 control off, 0 audit rows',
  pg_temp.answer('0161', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0161());
delete from platform.control_settings where control_key = 'uploads_enabled';
:run0161
rollback to savepoint s161;
select pg_temp.expect('3e not exactly the 11 controls: refused, nothing applied',
  '55000 0161: platform.control_settings does not hold exactly the 11 controls 0001-0160 seed | '
  || '0 tables, 0 functions, 0 control off, 0 audit rows',
  pg_temp.answer('0161', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0161());

delete from locks_seen;
select pg_temp.record_locks('before');
:run0161
select pg_temp.record_locks('after');
select pg_temp.expect('3f 0161 applies: its objects, the control off, one audit row',
  'applied | 2 tables, 9 functions, 1 control off, 1 audit rows',
  pg_temp.answer('0161', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0161());
select pg_temp.expect('3g 0161 takes no lock beyond its header''s', '',
  coalesce((select string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name, added.mode)
              from pg_temp.added_locks((select tables from existing_tables)) added
             where not exists (select 1 from declared_locks declared where declared.file = '0161'
                                and declared.table_name = added.table_name
                                and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(added.mode))), ''));
select pg_temp.expect('3h and holds every lock its header declares', '',
  coalesce((select string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name)
              from declared_locks declared
             where declared.file = '0161'
               and not exists (select 1 from locks_seen held where held.label = 'after'
                                and held.table_name = declared.table_name and held.mode = declared.mode)), ''));
select pg_temp.expect('3i platform.control_enabled is 0115''s body plus the one key', '3fe37993cd36970f2d957d29b8bc39f3',
  (select md5(prosrc) from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure));
rollback to savepoint s161;

-- 4. 0160 taken away too (0161 is away already in this transaction).
drop function ehr.appointment_book(text, uuid, text, uuid, uuid, timestamptz, integer, text, text, text, text),
  ehr.appointment_list(date, uuid, uuid, text[], integer, timestamptz, timestamptz, uuid),
  ehr.appointment_read(uuid), ehr.appointment_patient_list(uuid),
  ehr.appointment_reschedule(uuid, bigint, timestamptz, integer, uuid, boolean, text, text, text),
  ehr.appointment_cancel(uuid, bigint, text, text, text), ehr.appointment_mark_no_show(uuid, bigint, text, text),
  ehr.appointment_check_in(uuid, bigint, boolean, text, text, text), ehr.appointment_bookable_staff(),
  ehr.appointment_clinic_list(boolean),
  ehr.appointment_clinic_save(uuid, bigint, text, text, integer, boolean, boolean, text, text),
  ehr.appointment_settings_read(), ehr.appointment_settings_save(bigint, integer, text, text),
  ehr.appointment_cards(uuid[], uuid, uuid, uuid), ehr.appointment_caller(text[], text[]),
  ehr.appointment_audit(text, uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text, jsonb),
  ehr.appointment_idempotency(uuid, text, text);
drop table ehr.appointment_events, ehr.appointments, ehr.appointment_clinics, ehr.appointment_settings;
drop function ehr.appointment_events_immutable();
delete from auth.role_permissions where permission_code in ('ehr.appointment.read', 'ehr.appointment.write');
delete from auth.permissions where code in ('ehr.appointment.read', 'ehr.appointment.write');
alter table ehr.visit_queue drop constraint visit_queue_check_in_basis_check;
alter table ehr.visit_queue add constraint visit_queue_check_in_basis_check
  check (check_in_basis in ('search', 'own_facility'));
set local session_replication_role = replica;
delete from audit.events where correlation_id = '0160-appointments-appt1';
set local session_replication_role = origin;
select pg_temp.expect('4a the state before 0160, for this transaction', '0 tables, 0 functions, 0 role rows, 0 audit rows',
  pg_temp.made0160());
-- A fictional front-desk member at a real facility (triggers off, as the suites seed; nothing here reads the
-- sealed-member tables), so the closing count reaches identity.sealed_demo_facility and identity.sealed_qa_facility
-- even on a fresh build, as it does on production.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e1610000-0000-4000-8000-000000000001', 'Seal Count Group', 'seal-count-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1610000-0000-4000-8000-000000000002', 'e1610000-0000-4000-8000-000000000001', 'Seal Count Clinic', 'SEAL-COUNT',
   'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1610000-0000-4000-8000-000000000003', 'synthetic:seal-count-desk', 'seal-count-desk@example.invalid',
   'Seal Count Desk', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e1610000-0000-4000-8000-000000000004', 'e1610000-0000-4000-8000-000000000003', 'Seal Count Desk',
   'seal-count-desk@example.invalid', 'verified', 'receptionist');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('e1610000-0000-4000-8000-000000000005', 'e1610000-0000-4000-8000-000000000004', 'e1610000-0000-4000-8000-000000000003',
   'e1610000-0000-4000-8000-000000000001', 'e1610000-0000-4000-8000-000000000002', 'receptionist', 'receptionist',
   true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('e1610000-0000-4000-8000-000000000006', 'e1610000-0000-4000-8000-000000000003', 'receptionist', 'facility',
   'e1610000-0000-4000-8000-000000000005', 'e1610000-0000-4000-8000-000000000002', 'Synthetic seal count role');
set local session_replication_role = origin;
select pg_temp.expect('4a2 an active membership at a facility holds one of the four roles, so 0160''s closing count reads the seals',
  'true',
  (select (count(*) > 0)::text from identity.staff_facility_memberships membership
     join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
    where membership.active and membership.facility_id is not null
      and assignment.role_code in ('receptionist', 'doctor', 'clinician', 'nurse')));

savepoint s160;
create table ehr.appointment_settings (id integer);
:run0160
rollback to savepoint s160;
select pg_temp.expect('4b a half state (one of its tables there) is refused, nothing applied',
  '55000 0160: the schema is not in the reviewed state (part of 0160 is there); nothing applied | '
  || '0 tables, 0 functions, 0 role rows, 0 audit rows',
  pg_temp.answer('0160', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0160());
do $$
begin
  execute regexp_replace(pg_get_functiondef('ehr.visit_queue_check_in(text,uuid)'::regprocedure),
    '\mbegin\M', 'begin -- changed');
end $$;
:run0160
rollback to savepoint s160;
select pg_temp.expect('4c a body it calls changed (0135''s check-in) is refused, nothing applied',
  '55000 0160: these bodies are not as 0001-0151 left them: ehr.visit_queue_check_in(text,uuid) | '
  || '0 tables, 0 functions, 0 role rows, 0 audit rows',
  pg_temp.answer('0160', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0160());
insert into auth.role_permissions (role_code, permission_code) values ('receptionist', 'ehr.vital.write');
:run0160
rollback to savepoint s160;
select pg_temp.expect('4d the front desk''s codes changed: refused, nothing applied', '55000 | '
  || '0 tables, 0 functions, 0 role rows, 0 audit rows',
  :'LAST_ERROR_SQLSTATE' || ' | ' || pg_temp.made0160());
alter table ehr.visit_queue drop constraint visit_queue_check_in_basis_check;
alter table ehr.visit_queue add constraint visit_queue_check_in_basis_check
  check (check_in_basis in ('search', 'own_facility', 'walk_in'));
:run0160
rollback to savepoint s160;
select pg_temp.expect('4e the waiting-list basis CHECK changed: refused, nothing applied',
  '55000 0160: the waiting-list basis CHECK is not as 0135 left it | 0 tables, 0 functions, 0 role rows, 0 audit rows',
  pg_temp.answer('0160', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0160());
:run0161
select pg_temp.expect('4f 0161 without 0160: refused', '55000 0161: 0160 must be applied first',
  pg_temp.answer('0161', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

delete from locks_seen;
select pg_temp.record_locks('before');
:run0160
select pg_temp.record_locks('after');
select pg_temp.expect('4g 0160 applies: 4 tables, 18 functions, 7 role rows, 7 audit rows',
  'applied | 4 tables, 18 functions, 7 role rows, 7 audit rows',
  pg_temp.answer('0160', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0160());
select pg_temp.expect('4h 0160 takes no lock beyond its header''s', '',
  coalesce((select string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name, added.mode)
              from pg_temp.added_locks((select tables from existing_tables)) added
             where not exists (select 1 from declared_locks declared where declared.file = '0160'
                                and declared.table_name = added.table_name
                                and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(added.mode))), ''));
select pg_temp.expect('4i and holds every lock its header declares', '',
  coalesce((select string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name)
              from declared_locks declared
             where declared.file = '0160'
               and not exists (select 1 from locks_seen held where held.label = 'after'
                                and held.table_name = declared.table_name and held.mode = declared.mode)), ''));
select pg_temp.expect('4j the waiting-list basis CHECK admits appointment',
  'CHECK ((check_in_basis = ANY (ARRAY[''search''::text, ''own_facility''::text, ''appointment''::text])))',
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'ehr.visit_queue'::regclass and conname = 'visit_queue_check_in_basis_check'));
:run0161
select pg_temp.expect('4k then 0161 applies on top', 'applied | 2 tables, 9 functions, 1 control off, 1 audit rows',
  pg_temp.answer('0161', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0161());
:run0160
select pg_temp.expect('4l and each answers already applied again', '55000 0160: already applied',
  pg_temp.answer('0160', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));

select nextval('pg_temp.m160_passed') - 1 as passed \gset
\echo '0160-0161 migrations suite: ' :passed ' cases passed'
rollback;

\if :m160_dblink_available
\if :m160_dblink_create
drop extension dblink;
\endif
\endif
