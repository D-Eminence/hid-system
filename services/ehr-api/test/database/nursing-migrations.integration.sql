\set ON_ERROR_STOP on
-- 0174-0177 (NUR-1, Release D): the migration files themselves, run as
-- written (psql \ir) the way the runner runs them inside its transaction.
-- Rollback-only, apart from the dblink extension below. Needs 0001-0153,
-- BILL-1's 0162-0167, ED-1's 0168-0169, ADT-1's 0170-0173 and 0174-0177
-- applied. On such a database all four have run already:
--   1. busy refusals, first, before this transaction locks any table: a second
--      session (dblink) holds a table each file locks first (ehr.vitals read,
--      ehr.prescriptions read, ehr.admissions written, auth.role_permissions
--      written): the file tries for about 5 seconds and refuses with 55P03
--      "017n: ... stayed busy for 5 seconds; nothing applied; run the release
--      again at a quieter time"; when this transaction already holds another
--      file's strong lock, it refuses at once ("... so it does not wait; ...");
--   2. a second run of each answers "017n: already applied" (55000) and changes
--      nothing;
--   3. 0177 taken away for this transaction: a half state and a changed
--      permission check refuse and apply nothing; then 0177 applies (seven
--      codes, nineteen role rows, nineteen audit rows) within its header's
--      locks; with the sealed tenants installed it writes the three test
--      shifts there and nowhere else;
--   4. 0176 taken away too (0174's, 0171's and 0173's bodies put back): a half
--      state and a changed pinned body refuse; then 0176 applies within its
--      header's locks, and the three replaced bodies are as written;
--   5. 0175 taken away too: on a table with an outpatient prescription, a
--      trigger that would fire after 0148's refuses; then 0175 applies within
--      its header's locks and the prescription is unchanged;
--   6. 0174 taken away too: 0004's CHECK not as it left it refuses; with a
--      reading of the old fields, 0174 applies within its header's locks, the
--      reading unchanged; then 0175, 0176 and 0177 apply in order.
-- Synthetic values only.
set plpgsql.variable_conflict = error;

select exists (select 1 from pg_available_extensions where name = 'dblink') as m174_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as m174_dblink_create \gset
\if :m174_dblink_available
\if :m174_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0174 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0174_nursing_observation_chart.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0175 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0175_nursing_medicine_round.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0176 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0176_nursing_tasks_fluid_shifts_handover.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0177 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0177_nursing_access_codes.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'

create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0174-0177 migrations suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  if to_regclass('pg_temp.m174_passed') is null then
    perform set_config('m174.passed', (coalesce(nullif(current_setting('m174.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.m174_passed');
  end if;
end
$$;
create function pg_temp.answer(file text, sqlstate text, message text) returns text language sql immutable as $$
  select case when sqlstate = '55P03' and message ~ ('^' || file || ': ')
                   and message ~ '(so it does not wait|stayed busy for 5 seconds)(; nothing applied)?; run the release again at a quieter time$'
              then 'busy refusal: ' || substring(message from '(so it does not wait|stayed busy for 5 seconds)')
              when sqlstate = '00000' then 'applied'
              else sqlstate || ' ' || message end;
$$;
create function pg_temp.made0174() returns text language sql as $$
  select (select count(*) from pg_attribute where attrelid = 'ehr.vitals'::regclass and not attisdropped
           and attname in ('pain_score', 'avpu', 'blood_glucose_mmol_l', 'oxygen_device', 'oxygen_flow_l_per_min',
             'fio2_percent', 'gcs_eye', 'gcs_verbal', 'gcs_verbal_not_testable', 'gcs_motor')) || ' columns, '
      || (select count(*) from pg_constraint where conname in ('vitals_oxygen_ck', 'vitals_gcs_ck', 'vitals_one_value_ck',
           'vital_corrections_keys_ck')) || ' CHECKs, '
      || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname = 'ehr' and proc.proname in ('observation_chart', 'observation_fluid_hours',
             'nursing_caller')) || ' functions';
$$;
create function pg_temp.made0175() returns text language sql as $$
  select (select count(*) from pg_attribute where attrelid = 'ehr.prescriptions'::regclass and not attisdropped
           and attname in ('schedule_kind', 'scheduled_times', 'first_due_at', 'as_needed_reason',
             'as_needed_min_interval_minutes', 'as_needed_max_doses_per_24h', 'infusion_rate_ml_per_hour',
             'infusion_volume_ml', 'infusion_fluid')) || ' columns, '
      || (select count(*) from pg_class where oid in (to_regclass('ehr.medication_administrations'),
           to_regclass('ehr.nursing_requests'))) || ' tables, '
      || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname = 'ehr' and (proc.proname like 'mar\_%' or proc.proname like 'nursing\_key%'))
      || ' functions, ' || (select count(*) from pg_policy where polname = 'prescriptions_mar_owner_read') || ' policy';
$$;
create function pg_temp.made0176() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('ehr.nursing_tasks'), to_regclass('ehr.fluid_balance_entries'),
            to_regclass('ehr.facility_nursing_settings'), to_regclass('ehr.clinical_shifts'),
            to_regclass('ehr.shift_assignments'), to_regclass('ehr.shift_patient_allocations'),
            to_regclass('ehr.shift_assignment_events'), to_regclass('ehr.shift_handovers'),
            to_regclass('ehr.shift_handover_items'))) || ' tables, '
      || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname = 'ehr'
             and (proc.proname like 'nursing\_task%' or proc.proname like 'fluid\_balance\_%'
                  or proc.proname like 'clinical\_shift%' or proc.proname like 'shift\_%'
                  or proc.proname like 'handover\_%' or proc.proname = 'nursing_fluid_day_start_hour'))
      || ' functions, ' || (select count(*) from pg_trigger where tgname = 'admissions_nursing_tasks_close') || ' trigger';
$$;
create function pg_temp.made0177() returns text language sql as $$
  select (select count(*) from auth.permissions where code in ('ehr.mar.read', 'ehr.mar.record', 'ehr.nursing-task.read',
            'ehr.nursing-task.write', 'ehr.handover.write', 'ehr.shift-assignment.manage', 'ehr.clinical-shift.manage'))
      || ' codes, ' || (select count(*) from auth.role_permissions where permission_code in ('ehr.mar.read',
            'ehr.mar.record', 'ehr.nursing-task.read', 'ehr.nursing-task.write', 'ehr.handover.write',
            'ehr.shift-assignment.manage', 'ehr.clinical-shift.manage')) || ' role rows, '
      || (select count(*) from audit.events where correlation_id = '0177-nursing-nur1'
           and action = 'auth.role-permission.add') || ' audit rows';
$$;

-- 1. Busy refusals.
\if :m174_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('m174_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select pg_temp.made0174() as made0174_before \gset
select pg_temp.made0175() as made0175_before \gset
select pg_temp.made0176() as made0176_before \gset
select pg_temp.made0177() as made0177_before \gset
select public.dblink_exec('m174_blocker', 'begin') as began \gset
select public.dblink_exec('m174_blocker', 'lock table ehr.vitals in access share mode') as blocked \gset
:run0174
select pg_temp.expect('1b ehr.vitals read by another session: 0174 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0174_before',
  pg_temp.answer('0174', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0174());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0174
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: 0174 refuses at once',
  'busy refusal: so it does not wait', pg_temp.answer('0174', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select public.dblink_exec('m174_blocker', 'rollback') as ended \gset
select public.dblink_exec('m174_blocker', 'begin') as began \gset
select public.dblink_exec('m174_blocker', 'lock table ehr.prescriptions in access share mode') as blocked \gset
:run0175
select pg_temp.expect('1d ehr.prescriptions read by another session: 0175 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0175_before',
  pg_temp.answer('0175', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0175());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0175
rollback to savepoint holding;
select pg_temp.expect('1e the same while this transaction holds an earlier file''s lock: 0175 refuses at once',
  'busy refusal: so it does not wait', pg_temp.answer('0175', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select public.dblink_exec('m174_blocker', 'rollback') as ended \gset
select public.dblink_exec('m174_blocker', 'begin') as began \gset
select public.dblink_exec('m174_blocker', 'lock table ehr.admissions in row exclusive mode') as blocked \gset
:run0176
select pg_temp.expect('1f ehr.admissions written by another session: 0176 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0176_before',
  pg_temp.answer('0176', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0176());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0176
rollback to savepoint holding;
select pg_temp.expect('1g the same while this transaction holds an earlier file''s lock: 0176 refuses at once',
  'busy refusal: so it does not wait', pg_temp.answer('0176', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select public.dblink_exec('m174_blocker', 'rollback') as ended \gset
select public.dblink_exec('m174_blocker', 'begin') as began \gset
select public.dblink_exec('m174_blocker', 'lock table auth.role_permissions in row exclusive mode') as blocked \gset
:run0177
select pg_temp.expect('1h auth.role_permissions written by another session: 0177 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0177_before',
  pg_temp.answer('0177', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0177());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0177
rollback to savepoint holding;
select pg_temp.expect('1i the same while this transaction holds an earlier file''s lock: 0177 refuses at once',
  'busy refusal: so it does not wait', pg_temp.answer('0177', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select public.dblink_exec('m174_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('m174_blocker') as disconnected \gset
\else
\echo '0174-0177 migrations suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

create temporary sequence m174_passed;
select setval('pg_temp.m174_passed', coalesce(nullif(current_setting('m174.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- 2. A second run.
select pg_temp.made0174() || ' | ' || pg_temp.made0175() || ' | ' || pg_temp.made0176() || ' | ' || pg_temp.made0177()
  as made_applied \gset
select pg_temp.expect('2a 0174-0177 are applied here',
  '10 columns, 4 CHECKs, 3 functions | 9 columns, 2 tables, 10 functions, 1 policy | 9 tables, 29 functions, 1 trigger | 7 codes, 19 role rows, 19 audit rows',
  :'made_applied');
:run0174
select pg_temp.expect('2b 0174 again: already applied', '55000 0174: already applied',
  pg_temp.answer('0174', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0175
select pg_temp.expect('2c 0175 again: already applied', '55000 0175: already applied',
  pg_temp.answer('0175', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0176
select pg_temp.expect('2d 0176 again: already applied', '55000 0176: already applied',
  pg_temp.answer('0176', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0177
select pg_temp.expect('2e 0177 again: already applied', '55000 0177: already applied',
  pg_temp.answer('0177', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.expect('2f nothing changed', :'made_applied',
  pg_temp.made0174() || ' | ' || pg_temp.made0175() || ' | ' || pg_temp.made0176() || ' | ' || pg_temp.made0177());

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
  ('0174', 'ehr.vitals', 'AccessExclusiveLock'), ('0174', 'ehr.vital_corrections', 'AccessExclusiveLock'),
  ('0174', 'audit.events', 'RowExclusiveLock'), ('0174', 'ehr.admissions', 'AccessShareLock'),
  ('0174', 'ehr.encounters', 'AccessShareLock'), ('0174', 'ehr.wards', 'AccessShareLock'),
  ('0175', 'ehr.prescriptions', 'AccessExclusiveLock'), ('0175', 'ehr.admissions', 'ShareRowExclusiveLock'),
  ('0175', 'ehr.encounters', 'ShareRowExclusiveLock'), ('0175', 'identity.facilities', 'ShareRowExclusiveLock'),
  ('0175', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'), ('0175', 'audit.events', 'RowExclusiveLock'),
  ('0175', 'ehr.wards', 'AccessShareLock'), ('0175', 'ehr.order_routes', 'AccessShareLock'),
  ('0175', 'pharmacy.work_items', 'AccessShareLock'), ('0175', 'pharmacy.work_item_acceptances', 'AccessShareLock'),
  ('0175', 'pharmacy.dispensings', 'AccessShareLock'), ('0175', 'pharmacy.dispensing_reversals', 'AccessShareLock'),
  ('0175', 'pharmacy.own_prescription_sends', 'AccessShareLock'),
  ('0175', 'pharmacy.prescription_item_claims', 'AccessShareLock'),
  ('0176', 'ehr.admissions', 'ShareRowExclusiveLock'), ('0176', 'ehr.wards', 'ShareRowExclusiveLock'),
  ('0176', 'ehr.encounters', 'ShareRowExclusiveLock'), ('0176', 'ehr.clinical_notes', 'ShareRowExclusiveLock'),
  ('0176', 'identity.facilities', 'ShareRowExclusiveLock'), ('0176', 'identity.patients', 'ShareRowExclusiveLock'),
  ('0176', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'), ('0176', 'audit.events', 'RowExclusiveLock'),
  ('0176', 'ehr.beds', 'AccessShareLock'), ('0176', 'ehr.vitals', 'AccessShareLock'),
  ('0176', 'ehr.vital_corrections', 'AccessShareLock'), ('0176', 'ehr.clinical_note_revisions', 'AccessShareLock'),
  ('0176', 'ehr.medication_administrations', 'AccessShareLock'), ('0176', 'ehr.inpatient_switches', 'AccessShareLock'),
  ('0176', 'auth.account_roles', 'AccessShareLock'),
  ('0177', 'auth.role_permissions', 'ShareRowExclusiveLock'), ('0177', 'auth.permissions', 'RowExclusiveLock'),
  ('0177', 'ehr.clinical_shifts', 'RowExclusiveLock'), ('0177', 'audit.events', 'RowExclusiveLock'),
  ('0177', 'auth.roles', 'RowShareLock'), ('0177', 'identity.staff_facility_memberships', 'RowShareLock'),
  ('0177', 'identity.facilities', 'RowShareLock'), ('0177', 'auth.account_roles', 'AccessShareLock'),
  ('0177', 'auth.accounts', 'AccessShareLock'), ('0177', 'identity.sealed_demo_members', 'AccessShareLock'),
  ('0177', 'identity.sealed_qa_members', 'AccessShareLock');
create function pg_temp.beyond(file text, existing text[]) returns text language sql as $$
  select coalesce(string_agg(after_run.table_name || ' ' || after_run.mode, ', '
                             order by after_run.table_name, after_run.mode), '')
    from (select table_name, mode from locks_seen where label = 'after' and table_name = any (existing)
          except select table_name, mode from locks_seen where label = 'before') after_run
   where not exists (select 1 from declared_locks declared where declared.file = beyond.file
                      and declared.table_name = after_run.table_name
                      and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(after_run.mode));
$$;
create function pg_temp.missing(file text) returns text language sql as $$
  select coalesce(string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name), '')
    from declared_locks declared
   where declared.file = missing.file
     and not exists (select 1 from locks_seen held where held.label = 'after'
                      and held.table_name = declared.table_name and held.mode = declared.mode);
$$;

-- Take a file away for this transaction, putting back what it replaced.
create function pg_temp.away0177() returns void language plpgsql as $away$
begin
  delete from auth.role_permissions where permission_code in ('ehr.mar.read', 'ehr.mar.record', 'ehr.nursing-task.read',
    'ehr.nursing-task.write', 'ehr.handover.write', 'ehr.shift-assignment.manage', 'ehr.clinical-shift.manage');
  delete from auth.permissions where code in ('ehr.mar.read', 'ehr.mar.record', 'ehr.nursing-task.read',
    'ehr.nursing-task.write', 'ehr.handover.write', 'ehr.shift-assignment.manage', 'ehr.clinical-shift.manage');
  set local session_replication_role = replica;
  delete from audit.events where correlation_id = '0177-nursing-nur1';
  delete from ehr.clinical_shifts where name in ('Morning', 'Afternoon', 'Night')
    and (identity.sealed_qa_facility(facility_id) or identity.sealed_demo_facility(facility_id));
  set local session_replication_role = origin;
end
$away$;
create function pg_temp.away0176() returns void language plpgsql as $away$
declare
  target regprocedure;
begin
  drop trigger admissions_nursing_tasks_close on ehr.admissions;
  drop table ehr.shift_handover_items, ehr.shift_handovers, ehr.shift_patient_allocations, ehr.shift_assignments,
    ehr.shift_assignment_events, ehr.nursing_tasks, ehr.fluid_balance_entries, ehr.facility_nursing_settings,
    ehr.clinical_shifts;
  for target in select proc.oid::regprocedure from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'nursing\_task%' or proc.proname like 'fluid\_balance\_%'
                        or proc.proname like 'clinical\_shift%' or proc.proname like 'shift\_%'
                        or proc.proname like 'handover\_%' or proc.proname = 'nursing_fluid_day_start_hour') loop
    execute format('drop function %s', target);
  end loop;
  -- 0174's, 0171's and 0173's bodies, as those files wrote them.
  execute $orig$create or replace function ehr.observation_fluid_hours(requested_admission uuid, requested_from timestamptz,
    requested_to timestamptz)
  returns table (hour_start timestamptz, fluid_in_ml bigint, fluid_out_ml bigint, running_balance_ml bigint)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select null::timestamptz, 0::bigint, 0::bigint, 0::bigint where false
  $fn$$orig$;
  execute $orig$create or replace function ehr.admission_notice_recipients(requested_admission uuid)
  returns table (membership_id uuid, why text)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select admission.responsible_membership_id, 'responsible_doctor'
      from ehr.admissions admission
      join identity.staff_facility_memberships membership on membership.id = admission.responsible_membership_id
     where admission.id = requested_admission and admission.status in ('requested', 'admitted', 'discharge_ready')
       and membership.active and membership.migration_hold_reason is null
  $fn$$orig$;
  execute replace(pg_get_functiondef('identity.open_ward_stay(uuid)'::regprocedure),
    E'                           and staff.membership_id = actor_membership)\n'
    || E'               -- 0176 (NUR-1, Q193 A): a nurse allocated to the patient on the current clinical shift.\n'
    || E'               or exists (select 1 from ehr.shift_patient_allocations allocation\n'
    || E'                            join ehr.clinical_shifts_at(actor_facility, clock_timestamp()) current_shift\n'
    || E'                              on current_shift.shift_id = allocation.shift_id\n'
    || E'                             and current_shift.shift_date = allocation.shift_date\n'
    || E'                           where allocation.admission_id = admission_row.id\n'
    || E'                             and allocation.membership_id = actor_membership)) then\n',
    E'                           and staff.membership_id = actor_membership)) then\n');
end
$away$;
create function pg_temp.away0175() returns void language plpgsql as $away$
declare
  target regprocedure;
begin
  drop policy prescriptions_mar_owner_read on ehr.prescriptions;
  drop trigger prescriptions_inpatient_schedule_guard on ehr.prescriptions;
  drop table ehr.medication_administrations, ehr.nursing_requests;
  for target in select proc.oid::regprocedure from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'mar\_%' or proc.proname like 'nursing\_key%'
                        or proc.proname in ('prescriptions_inpatient_schedule_guard', 'medication_administrations_guard',
                                            'nursing_requests_immutable')) loop
    execute format('drop function %s', target);
  end loop;
  alter table ehr.prescriptions drop constraint prescriptions_inpatient_schedule_ck, drop column schedule_kind,
    drop column scheduled_times, drop column first_due_at, drop column as_needed_reason,
    drop column as_needed_min_interval_minutes, drop column as_needed_max_doses_per_24h,
    drop column infusion_rate_ml_per_hour, drop column infusion_volume_ml, drop column infusion_fluid;
end
$away$;
create function pg_temp.away0174() returns void language plpgsql as $away$
begin
  drop function ehr.observation_chart(uuid, timestamptz, timestamptz, boolean);
  drop function ehr.observation_fluid_hours(uuid, timestamptz, timestamptz);
  drop function ehr.nursing_caller(text, text[]);
  alter table ehr.vitals drop constraint vitals_oxygen_ck, drop constraint vitals_gcs_ck,
    drop constraint vitals_one_value_ck,
    add constraint vitals_check check (num_nonnulls(height_cm, weight_kg, temperature_c, pulse_bpm, respiratory_rate,
      systolic_mmhg, diastolic_mmhg, oxygen_saturation_percent) > 0),
    drop column pain_score, drop column avpu, drop column blood_glucose_mmol_l, drop column oxygen_device,
    drop column oxygen_flow_l_per_min, drop column fio2_percent, drop column gcs_eye, drop column gcs_verbal,
    drop column gcs_verbal_not_testable, drop column gcs_motor;
  alter table ehr.vital_corrections drop constraint vital_corrections_keys_ck,
    add constraint vital_corrections_replacement_values_check3 check ((replacement_values - array['height_cm',
      'weight_kg', 'temperature_c', 'pulse_bpm', 'respiratory_rate', 'systolic_mmhg', 'diastolic_mmhg',
      'oxygen_saturation_percent']) = '{}'::jsonb);
end
$away$;
create temporary table existing_tables as
  select array_agg(namespace.nspname || '.' || relation.relname) as tables from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
   where relation.relkind in ('r', 'p', 'v', 'm')
     and namespace.nspname not in ('pg_catalog', 'information_schema', 'migration')
     and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'
     and (namespace.nspname, relation.relname) not in (('ehr', 'medication_administrations'), ('ehr', 'nursing_requests'),
       ('ehr', 'nursing_tasks'), ('ehr', 'fluid_balance_entries'), ('ehr', 'facility_nursing_settings'),
       ('ehr', 'clinical_shifts'), ('ehr', 'shift_assignments'), ('ehr', 'shift_patient_allocations'),
       ('ehr', 'shift_assignment_events'), ('ehr', 'shift_handovers'), ('ehr', 'shift_handover_items'));
select tables::text as existing from existing_tables \gset
-- 0177 locks the clinical shifts table 0176 makes: it is "there before" 0177 runs.
select (tables || array['ehr.clinical_shifts'])::text as existing177 from existing_tables \gset

-- 3. 0177 taken away.
savepoint s177;
select pg_temp.away0177();
select pg_temp.expect('3a the state before 0177, for this transaction', '0 codes, 0 role rows, 0 audit rows',
  pg_temp.made0177());
savepoint s177b;
insert into auth.permissions (code, description) values ('ehr.mar.read', 'Half state');
:run0177
rollback to savepoint s177b;
select pg_temp.expect('3b a half state is refused, nothing applied',
  '55000 0177: the schema is not in the reviewed state (a nursing code or row is there, but not exactly what 0177 leaves); nothing applied | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0177', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0177());
do $$
begin
  execute regexp_replace(pg_get_functiondef('auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0177
rollback to savepoint s177b;
select pg_temp.expect('3c the permission check changed: refused, nothing applied',
  '55000 0177: these bodies are not as 0001-0176 left them: auth.membership_has_permission(text,uuid,uuid,text) | 0 codes, 0 role rows, 0 audit rows',
  pg_temp.answer('0177', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0177());
delete from locks_seen;
select pg_temp.record_locks('before');
:run0177
select pg_temp.record_locks('after');
select pg_temp.expect('3d 0177 applies', 'applied | 7 codes, 19 role rows, 19 audit rows',
  pg_temp.answer('0177', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0177());
select pg_temp.expect('3e the rows, and every audit row as the system actor with no account, facility or patient',
  'admin:ehr.clinical-shift.manage,ehr.shift-assignment.manage|clinician:ehr.handover.write,ehr.mar.read,ehr.mar.record,ehr.nursing-task.read,ehr.nursing-task.write|doctor:ehr.mar.read,ehr.mar.record,ehr.nursing-task.read,ehr.nursing-task.write|nurse:ehr.handover.write,ehr.mar.read,ehr.mar.record,ehr.nursing-task.read,ehr.nursing-task.write,ehr.shift-assignment.manage|org_admin:ehr.clinical-shift.manage,ehr.shift-assignment.manage / 19 system rows',
  (select string_agg(role_code || ':' || codes, '|' order by role_code)
     from (select role_code, string_agg(permission_code, ',' order by permission_code) as codes
             from auth.role_permissions where permission_code in ('ehr.mar.read', 'ehr.mar.record',
               'ehr.nursing-task.read', 'ehr.nursing-task.write', 'ehr.handover.write', 'ehr.shift-assignment.manage',
               'ehr.clinical-shift.manage') group by role_code) grouped)
  || ' / ' || (select count(*) from audit.events
                where correlation_id = '0177-nursing-nur1' and actor_type = 'system' and actor_account_id is null
                  and facility_id is null and patient_id is null and action = 'auth.role-permission.add'
                  and reason = 'NUR-1 Nursing (Release D, owner decision Q200 A)') || ' system rows');
select pg_temp.expect('3f 0177 takes no lock beyond its header''s', '', pg_temp.beyond('0177', :'existing177'::text[]));
select pg_temp.expect('3g and holds every lock its header declares', '', pg_temp.missing('0177'));
rollback to savepoint s177;

-- 3h. With the sealed QA tenant and the sealed demo tenant installed: 0177 writes the three test shifts there and
-- nowhere else.
savepoint s177s;
select pg_temp.away0177();
select identity.sealed_qa_install() is not null as qa_installed \gset
select identity.sealed_demo_install() is not null as demo_installed \gset
:run0177
select pg_temp.expect('3h 0177 applies with the sealed tenants', 'applied',
  pg_temp.answer('0177', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.expect('3i QA Hospital: Morning 07:30-14:30, Afternoon 14:00-21:00, Night 20:30-08:00; only at sealed facilities',
  'Afternoon 14:00-21:00|Morning 07:30-14:30|Night 20:30-08:00 / true',
  (select string_agg(shift.name || ' ' || to_char(shift.starts_at, 'HH24:MI') || '-' || to_char(shift.ends_at, 'HH24:MI'),
                     '|' order by shift.name)
     from ehr.clinical_shifts shift where shift.facility_id = 'c0a00002-0000-4000-8000-000000000001')
  || ' / ' || (select bool_and(identity.sealed_qa_facility(shift.facility_id) or identity.sealed_demo_facility(shift.facility_id))::text
                 from ehr.clinical_shifts shift));
select pg_temp.expect('3j one sealed-seed audit row per shift, as the system actor', 'true',
  (select (count(*) = (select count(*) from ehr.clinical_shifts) and bool_and(actor_type = 'system' and patient_id is null))::text
     from audit.events where correlation_id = '0177-nursing-nur1' and action = 'ehr.clinical-shift.sealed-seed'));
rollback to savepoint s177s;

-- 4. 0176 taken away (with 0177).
savepoint s176;
select pg_temp.away0177();
select pg_temp.away0176();
select pg_temp.expect('4a the state before 0176, for this transaction', '0 tables, 0 functions, 0 trigger',
  pg_temp.made0176());
select pg_temp.expect('4b the three bodies are back as 0174, 0171 and 0173 wrote them',
  'c15ad3a0e447fafd48a7d4b8f1630f0c 38097e2f83954868d0fb2f971e49e9c9 8c5a8d1c2440c505753f07f42bc5a81a',
  (select md5(prosrc) from pg_proc where oid = 'ehr.observation_fluid_hours(uuid,timestamptz,timestamptz)'::regprocedure)
  || ' ' || (select md5(prosrc) from pg_proc where oid = 'ehr.admission_notice_recipients(uuid)'::regprocedure)
  || ' ' || (select md5(prosrc) from pg_proc where oid = 'identity.open_ward_stay(uuid)'::regprocedure));
savepoint s176b;
create table ehr.clinical_shifts (id uuid);
:run0176
rollback to savepoint s176b;
select pg_temp.expect('4c a half state is refused, nothing applied',
  '55000 0176: the schema is not in the reviewed state (part of 0176 is there); nothing applied | 0 tables, 0 functions, 0 trigger',
  pg_temp.answer('0176', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0176());
do $$
begin
  execute regexp_replace(pg_get_functiondef('ehr.admission_notice_recipients(uuid)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0176
rollback to savepoint s176b;
select pg_temp.expect('4d who is told changed since 0171: refused, nothing applied',
  '55000 0176: these bodies are not as 0001-0175 left them: ehr.admission_notice_recipients(uuid) | 0 tables, 0 functions, 0 trigger',
  pg_temp.answer('0176', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0176());
delete from locks_seen;
select pg_temp.record_locks('before');
:run0176
select pg_temp.record_locks('after');
select pg_temp.expect('4e 0176 applies', 'applied | 9 tables, 29 functions, 1 trigger',
  pg_temp.answer('0176', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0176());
select pg_temp.expect('4f 0176 takes no lock beyond its header''s', '', pg_temp.beyond('0176', :'existing'::text[]));
select pg_temp.expect('4g and holds every lock its header declares', '', pg_temp.missing('0176'));
select pg_temp.expect('4h the ward-team rule now counts an allocated nurse; the switch is still off', 'true/false',
  (position('shift_patient_allocations' in (select prosrc from pg_proc where oid = 'identity.open_ward_stay(uuid)'::regprocedure)) > 0)::text
  || '/' || (select enabled::text from ehr.inpatient_switches where key = 'ward_stay_access'));
rollback to savepoint s176;

-- 5. 0175 taken away (with 0176 and 0177).
savepoint s175;
select pg_temp.away0177();
select pg_temp.away0176();
select pg_temp.away0175();
select pg_temp.expect('5a the state before 0175, for this transaction', '0 columns, 0 tables, 0 functions, 0 policy',
  pg_temp.made0175());
-- An outpatient prescription already there (synthetic; the clinical tables refuse deletes, so it stays in this
-- transaction only).
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values ('a1750000-0000-4000-8000-000000000001', 'Rx Group', 'rx-group-m175');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
values ('a1750000-0000-4000-8000-000000000002', 'a1750000-0000-4000-8000-000000000001', 'Rx Hospital', 'RX-M175',
  'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
values ('a1750100-0000-4000-8000-000000000001', 'synthetic:m175-doctor', 'm175-doctor@example.invalid', 'Rx Doctor', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
values ('a1750200-0000-4000-8000-000000000001', 'a1750100-0000-4000-8000-000000000001', 'Rx Doctor',
  'm175-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id, membership_role,
  app_role, is_primary, active)
values ('a1750300-0000-4000-8000-000000000001', 'a1750200-0000-4000-8000-000000000001',
  'a1750100-0000-4000-8000-000000000001', 'a1750000-0000-4000-8000-000000000001', 'a1750000-0000-4000-8000-000000000002',
  'doctor', 'doctor', true, true);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
values ('a1750400-0000-4000-8000-000000000001', 'HID-RXAAAQQ', 'Pat', 'Rxperson', 'Pat Rxperson', 'female',
  date '1980-01-01', 'active', 'hid');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, created_at)
values ('a1750800-0000-4000-8000-000000000001', 'a1750400-0000-4000-8000-000000000001', 'a1750000-0000-4000-8000-000000000002',
  'a1750100-0000-4000-8000-000000000001', 'a1750300-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', now(), now());
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status)
values ('a1750900-0000-4000-8000-000000000001', 'a1750800-0000-4000-8000-000000000001',
  'a1750400-0000-4000-8000-000000000001', 'a1750000-0000-4000-8000-000000000002', 'a1750100-0000-4000-8000-000000000001',
  'a1750300-0000-4000-8000-000000000001', 'Fictional Med Outpatient', 'twice daily', 'Fictional', 'active');
set local session_replication_role = origin;
select md5(to_jsonb(rx)::text) as rx_before from ehr.prescriptions rx where id = 'a1750900-0000-4000-8000-000000000001' \gset
savepoint s175b;
create function pg_temp.noop_trigger() returns trigger language plpgsql as $$ begin return null; end $$;
create trigger prescriptions_zz_after after update on ehr.prescriptions for each row execute function pg_temp.noop_trigger();
:run0175
rollback to savepoint s175b;
select pg_temp.expect('5b an AFTER UPDATE trigger that would fire after 0148''s: refused, nothing applied',
  '55000 0175: ehr.prescriptions'' AFTER UPDATE triggers are not as 0148 left them; nothing applied | 0 columns, 0 tables, 0 functions, 0 policy',
  pg_temp.answer('0175', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0175());
delete from locks_seen;
select pg_temp.record_locks('before');
:run0175
select pg_temp.record_locks('after');
select pg_temp.expect('5c 0175 applies on a table with a prescription', 'applied | 9 columns, 2 tables, 10 functions, 1 policy',
  pg_temp.answer('0175', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0175());
select pg_temp.expect('5d 0175 takes no lock beyond its header''s', '', pg_temp.beyond('0175', :'existing'::text[]));
select pg_temp.expect('5e and holds every lock its header declares', '', pg_temp.missing('0175'));
select pg_temp.expect('5f the prescription is unchanged (its new columns empty)', :'rx_before',
  (select md5((to_jsonb(rx) - array['schedule_kind', 'scheduled_times', 'first_due_at', 'as_needed_reason',
     'as_needed_min_interval_minutes', 'as_needed_max_doses_per_24h', 'infusion_rate_ml_per_hour', 'infusion_volume_ml',
     'infusion_fluid'])::text) || case when rx.schedule_kind is null and rx.first_due_at is null then '' else ' changed' end
     from ehr.prescriptions rx where id = 'a1750900-0000-4000-8000-000000000001'));
rollback to savepoint s175;

-- 6. 0174 taken away (with 0175-0177).
savepoint s174;
select pg_temp.away0177();
select pg_temp.away0176();
select pg_temp.away0175();
select pg_temp.away0174();
select pg_temp.expect('6a the state before 0174, for this transaction', '0 columns, 0 CHECKs, 0 functions', pg_temp.made0174());
savepoint s174b;
alter table ehr.vitals drop constraint vitals_check, add constraint vitals_check check (num_nonnulls(height_cm, weight_kg) > 0);
:run0174
rollback to savepoint s174b;
select pg_temp.expect('6b 0004''s "at least one value" CHECK not as it left it: refused, nothing applied',
  '55000 0174: the vitals "at least one value" or corrections keys CHECK is not as 0004 left it; nothing applied | 0 columns, 0 CHECKs, 0 functions',
  pg_temp.answer('0174', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0174());
-- A reading of the old fields already there.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values ('a1740000-0000-4000-8000-000000000101', 'Vitals Group', 'vitals-group-m174');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
values ('a1740000-0000-4000-8000-000000000102', 'a1740000-0000-4000-8000-000000000101', 'Vitals Hospital', 'VT-M174',
  'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
values ('a1740100-0000-4000-8000-000000000101', 'synthetic:m174-nurse', 'm174-nurse@example.invalid', 'Vitals Nurse', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
values ('a1740200-0000-4000-8000-000000000101', 'a1740100-0000-4000-8000-000000000101', 'Vitals Nurse',
  'm174-nurse@example.invalid', 'verified', 'nurse');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id, membership_role,
  app_role, is_primary, active)
values ('a1740300-0000-4000-8000-000000000101', 'a1740200-0000-4000-8000-000000000101',
  'a1740100-0000-4000-8000-000000000101', 'a1740000-0000-4000-8000-000000000101', 'a1740000-0000-4000-8000-000000000102',
  'nurse', 'nurse', true, true);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
values ('a1740400-0000-4000-8000-000000000101', 'HID-VTAAAQQ', 'Pat', 'Vitalsperson', 'Pat Vitalsperson', 'male',
  date '1980-01-01', 'active', 'hid');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, created_at)
values ('a1740800-0000-4000-8000-000000000101', 'a1740400-0000-4000-8000-000000000101', 'a1740000-0000-4000-8000-000000000102',
  'a1740100-0000-4000-8000-000000000101', 'a1740300-0000-4000-8000-000000000101', 'ambulatory', 'in_progress', now(), now());
insert into ehr.vitals (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at,
  pulse_bpm, systolic_mmhg, diastolic_mmhg)
values ('a1740900-0000-4000-8000-000000000101', 'a1740800-0000-4000-8000-000000000101',
  'a1740400-0000-4000-8000-000000000101', 'a1740000-0000-4000-8000-000000000102', 'a1740100-0000-4000-8000-000000000101',
  'a1740300-0000-4000-8000-000000000101', now(), 88, 120, 80);
set local session_replication_role = origin;
select md5(to_jsonb(vital)::text) as vital_before from ehr.vitals vital where id = 'a1740900-0000-4000-8000-000000000101' \gset
delete from locks_seen;
select pg_temp.record_locks('before');
:run0174
select pg_temp.record_locks('after');
select pg_temp.expect('6c 0174 applies on a table with a reading', 'applied | 10 columns, 4 CHECKs, 3 functions',
  pg_temp.answer('0174', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0174());
select pg_temp.expect('6d 0174 takes no lock beyond its header''s', '', pg_temp.beyond('0174', :'existing'::text[]));
select pg_temp.expect('6e and holds every lock its header declares', '', pg_temp.missing('0174'));
select pg_temp.expect('6f the reading is unchanged, its new fields empty', :'vital_before',
  (select md5((to_jsonb(vital) - array['pain_score', 'avpu', 'blood_glucose_mmol_l', 'oxygen_device', 'oxygen_flow_l_per_min',
     'fio2_percent', 'gcs_eye', 'gcs_verbal', 'gcs_verbal_not_testable', 'gcs_motor'])::text)
     || case when num_nonnulls(vital.pain_score, vital.avpu, vital.gcs_eye) = 0 then '' else ' changed' end
     from ehr.vitals vital where id = 'a1740900-0000-4000-8000-000000000101'));
:run0175
select pg_temp.expect('6g then 0175', 'applied', pg_temp.answer('0175', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0176
select pg_temp.expect('6h then 0176', 'applied', pg_temp.answer('0176', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0177
select pg_temp.expect('6i then 0177', 'applied', pg_temp.answer('0177', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.expect('6j all four as on a migrated database', :'made_applied',
  pg_temp.made0174() || ' | ' || pg_temp.made0175() || ' | ' || pg_temp.made0176() || ' | ' || pg_temp.made0177());
rollback to savepoint s174;

do $$
begin
  raise notice '0174-0177 migrations: % cases passed', currval('pg_temp.m174_passed');
end $$;
rollback;
