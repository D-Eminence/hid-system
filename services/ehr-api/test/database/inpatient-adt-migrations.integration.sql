\set ON_ERROR_STOP on
-- 0170-0173 (ADT-1, Release D): the migration files themselves, run as
-- written (psql \ir) the way the runner runs them inside its transaction.
-- Rollback-only, apart from the dblink extension below. Needs 0001-0151,
-- BILL-1's 0162-0167, ED-1's 0168-0169 and 0170-0173 applied. On such a
-- database all four have run already:
--   1. busy refusals, first, before this transaction locks any table: a second
--      session (dblink) holds a table each file locks first (identity.facilities
--      written, ehr.encounters read, commercial.bills read, auth.role_permissions
--      written): the file tries for about 5 seconds and refuses with 55P03
--      "017n: ... stayed busy for 5 seconds; nothing applied; run the release
--      again at a quieter time"; when this transaction already holds another
--      file's strong lock, it refuses at once ("... so it does not wait; ...").
--      Both messages are the ones the runner's dry run retries (#306);
--   2. a second run of each answers "017n: already applied" (55000) and changes
--      nothing;
--   3. 0173 taken away for this transaction (its rows, codes, functions, column
--      and CHECKs, and 0131's three bodies put back): a half state, a changed
--      permission check, a notice-kind CHECK without one of 0131's values and a
--      grant-method CHECK that already holds ward_stay refuse with 55000 and
--      apply nothing; another lane's extra method and kind are kept; then 0173 applies (seven codes, sixteen role rows, sixteen
--      audit rows), taking no lock beyond its header's and every lock its
--      header declares;
--   4. 0172 taken away too (BILL-1's four bodies at claude/sprint-billing-backend
--      bd427a88 and its CHECKs put back): a half state, a changed pinned body
--      (a replaced one, or a BILL-1 helper the bodies call), BILL-1's changed
--      money-over CHECK, a source CHECK without one of BILL-1's values and a
--      database without BILL-1 refuse; another lane's extra source value is
--      kept; a new admission function that names the commercial schema makes
--      0172's scan refuse; then 0172 applies within its header's locks;
--   5. 0171 taken away too (0170's three parts and 0168's two CHECKs put back):
--      an ED CHECK without one of 0168's values, 0168's changed waiting-list
--      guard, a changed 0170 part and a half state refuse; another lane's extra
--      closed_via value is kept; then 0171 applies within its header's locks;
--   6. all four taken away: 0171 without 0170 refuses; a half state of 0170
--      refuses; a runtime that would get the new histories' sequences (default
--      privileges) makes 0170's post-check refuse; then 0170, 0171, 0172 and
--      0173 apply in order, each within its header's locks.
-- Synthetic values only.
set plpgsql.variable_conflict = error;

-- dblink is created before the transaction (creating it inside would lock its
-- result type at ACCESS EXCLUSIVE, which the files read as "this transaction
-- holds an earlier migration's locks").
select exists (select 1 from pg_available_extensions where name = 'dblink') as m170_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as m170_dblink_create \gset
\if :m170_dblink_available
\if :m170_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0170 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0170_inpatient_wards_and_beds.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0171 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0171_inpatient_admissions_and_discharge.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0172 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0172_inpatient_admission_charges.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
\set run0173 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0173_inpatient_access_and_ward_team.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'

-- A case: stops the suite at once when it fails. (Functions only until 1 is
-- done: a temporary table would be a relation this transaction holds at
-- ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0170-0173 migrations suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  -- Counted in a setting until 1 is done, then in a sequence (which keeps its count across ROLLBACK TO SAVEPOINT).
  if to_regclass('pg_temp.m170_passed') is null then
    perform set_config('m170.passed', (coalesce(nullif(current_setting('m170.passed', true), ''), '0')::integer + 1)::text,
                       true);
  else
    perform nextval('pg_temp.m170_passed');
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
create function pg_temp.made0170() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('ehr.wards'), to_regclass('ehr.beds'),
            to_regclass('ehr.bed_status_events'), to_regclass('ehr.ward_staff'), to_regclass('ehr.ward_events'),
            to_regclass('ehr.inpatient_switches'))) || ' tables, '
      || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname = 'ehr'
             and (proc.proname like 'ward\_%' or proc.proname like 'bed\_%' or proc.proname like 'inpatient\_%'))
      || ' functions';
$$;
create function pg_temp.made0171() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('ehr.admissions'), to_regclass('ehr.admission_movements'),
            to_regclass('ehr.admission_counters'), to_regclass('ehr.admission_discharge_medicines'),
            to_regclass('ehr.wristband_prints'), to_regclass('ehr.death_records'), to_regclass('ehr.death_record_versions')))
      || ' tables, ' || (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname = 'ehr'
             and (proc.proname like 'admission\_%' or proc.proname like 'wristband\_%' or proc.proname like 'newborn\_%'
                  or proc.proname like 'death\_record%' or proc.proname like 'discharge\_%'))
      || ' functions, ' || (select count(*) from pg_policy where polname in ('encounters_inpatient_owner_update',
           'record_versions_inpatient_owner_insert', 'recorded_allergies_inpatient_band_read')) || ' policies, closed via '
      || (select replace(replace(substring(pg_get_constraintdef(oid) from 'ARRAY\[(.*)\]'), '::text', ''), '''', '')
            from pg_constraint where conrelid = 'ehr.ed_attendances'::regclass
             and conname = 'ed_attendances_closed_via_check');
$$;
create function pg_temp.made0172() returns text language sql as $$
  select (select count(*) from pg_class where oid in (to_regclass('commercial.ward_charge_items'),
            to_regclass('commercial.bed_day_charges'))) || ' tables, '
      || (select count(*) from pg_trigger where tgname in ('zz_billing_admission_open', 'zz_billing_admission_status',
           'payments_deposit_guard')) || ' triggers, sources '
      || (select replace(replace(substring(pg_get_constraintdef(oid) from 'ARRAY\[(.*)\]'), '::text', ''), '''', '')
            from pg_constraint where conrelid = 'commercial.bills'::regclass and conname = 'bills_source_check');
$$;
create function pg_temp.made0173() returns text language sql as $$
  select (select count(*) from auth.permissions where code in ('ehr.ward.read', 'ehr.admission.read', 'ehr.bed.allocate',
            'ehr.wristband.print', 'ehr.admission.decide', 'ehr.ward.manage', 'ehr.death-record.write')) || ' codes, '
      || (select count(*) from auth.role_permissions where permission_code in ('ehr.ward.read', 'ehr.admission.read',
            'ehr.bed.allocate', 'ehr.wristband.print', 'ehr.admission.decide', 'ehr.ward.manage',
            'ehr.death-record.write')) || ' role rows, '
      || (select count(*) from audit.events where correlation_id = '0173-inpatient-adt1') || ' audit rows, '
      || (select count(*) from pg_proc where oid in (to_regprocedure('identity.open_ward_stay(uuid)'),
            to_regprocedure('identity.end_ward_stay_grants(uuid, text)'))) || ' ward-stay functions';
$$;

-- 1. Busy refusals.
\if :m170_dblink_available
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('m170_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select pg_temp.made0170() as made0170_before \gset
select pg_temp.made0171() as made0171_before \gset
select pg_temp.made0172() as made0172_before \gset
select pg_temp.made0173() as made0173_before \gset
select public.dblink_exec('m170_blocker', 'begin') as began \gset
select public.dblink_exec('m170_blocker', 'lock table identity.facilities in row exclusive mode') as blocked \gset
:run0170
select pg_temp.expect('1b identity.facilities written by another session: 0170 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0170_before',
  pg_temp.answer('0170', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0170());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0170
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: 0170 refuses at once',
  'busy refusal: so it does not wait', pg_temp.answer('0170', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select public.dblink_exec('m170_blocker', 'rollback') as ended \gset
select public.dblink_exec('m170_blocker', 'begin') as began \gset
select public.dblink_exec('m170_blocker', 'lock table ehr.encounters in access share mode') as blocked \gset
:run0171
select pg_temp.expect('1d ehr.encounters read by another session: 0171 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0171_before',
  pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0171());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0171
rollback to savepoint holding;
select pg_temp.expect('1e the same while this transaction holds an earlier file''s lock: 0171 refuses at once',
  'busy refusal: so it does not wait', pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select public.dblink_exec('m170_blocker', 'rollback') as ended \gset
select public.dblink_exec('m170_blocker', 'begin') as began \gset
select public.dblink_exec('m170_blocker', 'lock table commercial.bills in access share mode') as blocked \gset
:run0172
select pg_temp.expect('1f commercial.bills read by another session: 0172 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0172_before',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0172());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0172
rollback to savepoint holding;
select pg_temp.expect('1g the same while this transaction holds an earlier file''s lock: 0172 refuses at once',
  'busy refusal: so it does not wait', pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select public.dblink_exec('m170_blocker', 'rollback') as ended \gset
select public.dblink_exec('m170_blocker', 'begin') as began \gset
select public.dblink_exec('m170_blocker', 'lock table auth.role_permissions in row exclusive mode') as blocked \gset
:run0173
select pg_temp.expect('1h auth.role_permissions written by another session: 0173 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | ' || :'made0173_before',
  pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0173());
savepoint holding;
lock table ehr.catalog_versions in share mode;
:run0173
rollback to savepoint holding;
select pg_temp.expect('1i the same while this transaction holds an earlier file''s lock: 0173 refuses at once',
  'busy refusal: so it does not wait', pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select public.dblink_exec('m170_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('m170_blocker') as disconnected \gset
\else
\echo '0170-0173 migrations suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

create temporary sequence m170_passed;
select setval('pg_temp.m170_passed', coalesce(nullif(current_setting('m170.passed', true), ''), '0')::bigint + 1, false)
  as counted \gset

-- 2. A second run.
select pg_temp.made0170() || ' | ' || pg_temp.made0171() || ' | ' || pg_temp.made0172() || ' | ' || pg_temp.made0173()
  as made_applied \gset
select pg_temp.expect('2a 0170-0173 are applied here',
  '6 tables, 20 functions | 7 tables, 30 functions, 3 policies, closed via board, disposition, cancel, waiting_list, admission | 2 tables, 3 triggers, sources visit, pharmacy, lab, admission | 7 codes, 16 role rows, 16 audit rows, 2 ward-stay functions',
  :'made_applied');
:run0170
select pg_temp.expect('2b 0170 again: already applied', '55000 0170: already applied',
  pg_temp.answer('0170', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0171
select pg_temp.expect('2c 0171 again: already applied', '55000 0171: already applied',
  pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0172
select pg_temp.expect('2d 0172 again: already applied', '55000 0172: already applied',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0173
select pg_temp.expect('2e 0173 again: already applied', '55000 0173: already applied',
  pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.expect('2f nothing changed', :'made_applied',
  pg_temp.made0170() || ' | ' || pg_temp.made0171() || ' | ' || pg_temp.made0172() || ' | ' || pg_temp.made0173());

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
  ('0170', 'identity.facilities', 'ShareRowExclusiveLock'), ('0170', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'),
  ('0170', 'audit.events', 'RowExclusiveLock'), ('0170', 'identity.patients', 'AccessShareLock'),
  ('0170', 'identity.unknown_patients', 'AccessShareLock'), ('0170', 'identity.consent_directives', 'AccessShareLock'),
  ('0170', 'identity.consent_directive_versions', 'AccessShareLock'), ('0170', 'auth.permissions', 'AccessShareLock'),
  ('0170', 'auth.role_permissions', 'AccessShareLock'), ('0170', 'auth.account_roles', 'AccessShareLock'),
  ('0171', 'ehr.encounters', 'AccessExclusiveLock'), ('0171', 'ehr.record_versions', 'AccessExclusiveLock'),
  ('0171', 'ehr.recorded_allergies', 'AccessExclusiveLock'), ('0171', 'ehr.ed_attendances', 'AccessExclusiveLock'),
  ('0171', 'ehr.ed_attendance_events', 'AccessExclusiveLock'), ('0171', 'identity.patients', 'ShareRowExclusiveLock'),
  ('0171', 'identity.facilities', 'ShareRowExclusiveLock'),
  ('0171', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'),
  ('0171', 'ehr.clinical_notes', 'ShareRowExclusiveLock'), ('0171', 'ehr.prescriptions', 'ShareRowExclusiveLock'),
  ('0171', 'ehr.visit_queue', 'ShareRowExclusiveLock'), ('0171', 'ehr.wards', 'ShareRowExclusiveLock'),
  ('0171', 'ehr.beds', 'ShareRowExclusiveLock'), ('0171', 'audit.events', 'RowExclusiveLock'),
  ('0171', 'ehr.bed_status_events', 'RowExclusiveLock'), ('0171', 'identity.unknown_patients', 'AccessShareLock'),
  ('0171', 'identity.consent_grants', 'AccessShareLock'), ('0171', 'identity.consent_directives', 'AccessShareLock'),
  ('0171', 'identity.consent_directive_versions', 'AccessShareLock'),
  ('0171', 'identity.patient_identifiers', 'AccessShareLock'), ('0171', 'identity.facility_profiles', 'AccessShareLock'),
  ('0171', 'identity.staff', 'AccessShareLock'), ('0171', 'ehr.diagnoses', 'AccessShareLock'),
  ('0171', 'ehr.clinical_note_revisions', 'AccessShareLock'), ('0171', 'ehr.inpatient_switches', 'AccessShareLock'),
  ('0171', 'ehr.ward_staff', 'AccessShareLock'), ('0171', 'auth.permissions', 'AccessShareLock'),
  ('0171', 'auth.role_permissions', 'AccessShareLock'), ('0171', 'auth.account_roles', 'AccessShareLock'),
  ('0172', 'commercial.bills', 'AccessExclusiveLock'), ('0172', 'commercial.bill_lines', 'AccessExclusiveLock'),
  ('0172', 'commercial.payments', 'AccessExclusiveLock'), ('0172', 'commercial.number_counters', 'AccessExclusiveLock'),
  ('0172', 'ehr.admissions', 'ShareRowExclusiveLock'), ('0172', 'ehr.wards', 'ShareRowExclusiveLock'),
  ('0172', 'commercial.catalogue_items', 'ShareRowExclusiveLock'), ('0172', 'identity.facilities', 'ShareRowExclusiveLock'),
  ('0172', 'identity.staff_facility_memberships', 'ShareRowExclusiveLock'), ('0172', 'audit.events', 'RowExclusiveLock'),
  ('0172', 'commercial.payment_settings', 'AccessShareLock'), ('0172', 'commercial.catalogue_item_prices', 'AccessShareLock'),
  ('0172', 'commercial.facility_hmos', 'AccessShareLock'), ('0172', 'commercial.hmo_covers', 'AccessShareLock'),
  ('0172', 'ehr.admission_movements', 'AccessShareLock'), ('0172', 'ehr.visit_queue', 'AccessShareLock'),
  ('0172', 'identity.patients', 'AccessShareLock'),
  ('0173', 'auth.role_permissions', 'ShareRowExclusiveLock'), ('0173', 'ehr.admissions', 'ShareRowExclusiveLock'),
  ('0173', 'auth.permissions', 'RowExclusiveLock'), ('0173', 'audit.events', 'RowExclusiveLock'),
  ('0173', 'ehr.wards', 'RowExclusiveLock'), ('0173', 'ehr.beds', 'RowExclusiveLock'),
  ('0173', 'ehr.ward_staff', 'RowExclusiveLock'), ('0173', 'identity.consent_grants', 'AccessExclusiveLock'),
  ('0173', 'identity.record_access_notices', 'AccessExclusiveLock'), ('0173', 'auth.roles', 'RowShareLock'),
  ('0173', 'auth.accounts', 'RowShareLock'), ('0173', 'identity.staff_facility_memberships', 'RowShareLock'),
  ('0173', 'identity.organizations', 'RowShareLock'), ('0173', 'identity.facilities', 'RowShareLock'),
  ('0173', 'identity.patients', 'RowShareLock'), ('0173', 'auth.account_roles', 'AccessShareLock'),
  ('0173', 'identity.sealed_demo_members', 'AccessShareLock'), ('0173', 'identity.sealed_qa_members', 'AccessShareLock'),
  ('0173', 'ehr.inpatient_switches', 'AccessShareLock');
-- Beyond the header: a lock the file added on a table that was there before it, stronger than the header's.
create function pg_temp.beyond(file text, existing text[]) returns text language sql as $$
  select coalesce(string_agg(after_run.table_name || ' ' || after_run.mode, ', '
                             order by after_run.table_name, after_run.mode), '')
    from (select table_name, mode from locks_seen where label = 'after' and table_name = any (existing)
          except select table_name, mode from locks_seen where label = 'before') after_run
   where not exists (select 1 from declared_locks declared where declared.file = beyond.file
                      and declared.table_name = after_run.table_name
                      and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(after_run.mode));
$$;
-- Declared but not held after the run.
create function pg_temp.missing(file text) returns text language sql as $$
  select coalesce(string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name), '')
    from declared_locks declared
   where declared.file = missing.file
     and not exists (select 1 from locks_seen held where held.label = 'after'
                      and held.table_name = declared.table_name and held.mode = declared.mode);
$$;

-- Take a file away for this transaction, putting back what it replaced.
create function pg_temp.away0173() returns void language plpgsql as $away$
begin
  delete from auth.role_permissions where permission_code in ('ehr.ward.read', 'ehr.admission.read', 'ehr.bed.allocate',
    'ehr.wristband.print', 'ehr.admission.decide', 'ehr.ward.manage', 'ehr.death-record.write');
  delete from auth.permissions where code in ('ehr.ward.read', 'ehr.admission.read', 'ehr.bed.allocate',
    'ehr.wristband.print', 'ehr.admission.decide', 'ehr.ward.manage', 'ehr.death-record.write');
  set local session_replication_role = replica;
  delete from audit.events where correlation_id = '0173-inpatient-adt1';
  delete from ehr.ward_staff where ward_id in (select id from ehr.wards where name in ('QA Ward A', 'QA ICU')
    and (identity.sealed_qa_facility(facility_id) or identity.sealed_demo_facility(facility_id)));
  delete from ehr.beds where ward_id in (select id from ehr.wards where name in ('QA Ward A', 'QA ICU')
    and (identity.sealed_qa_facility(facility_id) or identity.sealed_demo_facility(facility_id)));
  delete from ehr.wards where name in ('QA Ward A', 'QA ICU')
    and (identity.sealed_qa_facility(facility_id) or identity.sealed_demo_facility(facility_id));
  set local session_replication_role = origin;
  drop function identity.open_ward_stay(uuid);
  drop function identity.end_ward_stay_grants(uuid, text);
  alter table identity.consent_grants drop constraint consent_grants_ward_stay_shape_ck, drop column admission_id,
    drop constraint consent_grants_authorization_method_ck,
    add constraint consent_grants_authorization_method_ck
      check (authorization_method is null or authorization_method in ('patient_access_pin', 'own_facility'));
  alter table identity.record_access_notices drop constraint record_access_notices_access_kind_check,
    add constraint record_access_notices_access_kind_check
      check (access_kind in ('standard', 'share', 'pin', 'own_facility'));
  execute $orig$create or replace function identity.patient_self_access_history(requested_subject text, requested_session uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = pg_catalog, pg_temp
as $function$
declare patient uuid; result jsonb;
begin
  patient := identity.patient_self_session(requested_subject,requested_session);
  if patient is null then return null; end if;
  select jsonb_build_object('items',coalesce(jsonb_agg(entries.item order by entries.created_at desc,entries.id desc),
      '[]'::jsonb)) into result from (
    select jsonb_build_object('consentGrantId',g.id,'scope',g.scope,'purpose',g.purpose_of_use,
      'status',case when g.status='active' and g.expires_at<=statement_timestamp() then 'expired' else g.status end,
      'startsAt',g.starts_at,'expiresAt',g.expires_at,'reason',g.reason,'facilityName',f.name,
      'breakGlass',g.break_glass or g.scope='break_glass',
      'revocableByPatient',labelled.revocable,
      -- 0131: how the access was given ("Opened as this facility's patient" for own-facility).
      'basis',case when g.break_glass or g.scope='break_glass' then 'emergency'
        when g.authorization_method='own_facility' then 'own-facility'
        when g.authorization_method='patient_access_pin' then 'pin'
        when s.consent_grant_id is not null then 'share'
        when g.granted_by_patient_id is not distinct from patient then 'approval'
        else 'other' end,
      'shareLevel',s.level,'shareDuration',s.duration_preset,
      'clinicianName',case when s.consent_grant_id is not null then st.full_name end) as item, g.created_at, g.id
    from identity.consent_grants g join identity.facilities f on f.id=g.facility_id
    left join identity.patient_consent_shares s on s.consent_grant_id=g.id
    left join identity.staff st on st.id=g.staff_id and s.consent_grant_id is not null
    cross join lateral (select g.status='active' and g.expires_at>statement_timestamp()
        and not g.break_glass and g.scope<>'break_glass'
        and (g.granted_by_patient_id is not distinct from patient
          or g.authorization_method is not distinct from 'patient_access_pin'
          or g.authorization_method is not distinct from 'own_facility') as revocable) labelled
    where g.patient_id=patient order by labelled.revocable desc,g.created_at desc,g.id desc limit 50
  ) entries;
  return result;
end;
$function$
$orig$;
  execute $orig$create or replace function identity.revoke_my_consent_grant(requested_subject text, requested_session uuid,
  requested_grant_id uuid, requested_reason text)
returns table(consent_grant_id uuid, grant_status text, revoked_at timestamp with time zone, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $function$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  grant_row identity.consent_grants%rowtype;
  revoked_at_value timestamptz;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if length(btrim(coalesce(requested_reason, ''))) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'A revocation reason is required';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  -- Serialize with PIN verification, replacement and removal for this patient.
  perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || patient_id_value::text, 0));
  select * into grant_row from identity.consent_grants grant_candidate
   where grant_candidate.id = requested_grant_id and grant_candidate.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The access grant is unavailable';
  end if;
  -- 0131: an own-facility opening is the patient's to revoke too.
  if grant_row.break_glass or grant_row.scope = 'break_glass'
     or not (grant_row.granted_by_patient_id is not distinct from patient_id_value
       or grant_row.authorization_method is not distinct from 'patient_access_pin'
       or grant_row.authorization_method is not distinct from 'own_facility') then
    raise exception using errcode = '55000', message = 'CONSENT_GRANT_NOT_PATIENT_REVOCABLE';
  end if;
  if grant_row.status = 'revoked' then
    return query select grant_row.id, 'revoked'::text, grant_row.revoked_at, true;
    return;
  end if;
  if grant_row.status <> 'active' or grant_row.expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'The access grant is no longer active';
  end if;
  revoked_at_value := clock_timestamp();
  update identity.consent_grants
     set status = 'revoked', revoked_at = revoked_at_value, revoked_by = account_id_value,
         revoked_reason = btrim(requested_reason), updated_at = revoked_at_value,
         row_version = row_version + 1
   where id = grant_row.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id, facility_id,
    action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    grant_row.facility_id, 'identity.consent-grant.patient-revoke', 'success', 'consent-grant',
    grant_row.id::text, 'patient-self', 'Revoked by the patient', 'application', 'identity-api',
    jsonb_build_object('scope', grant_row.scope,
      'authorizationMethod', coalesce(grant_row.authorization_method, 'patient_approval'))
  );
  return query select grant_row.id, 'revoked'::text, revoked_at_value, false;
end
$function$
$orig$;
  execute $orig$create or replace function identity.note_record_access(requested_consent_grant_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  subject_value text := platform.current_actor_subject();
  membership_value uuid := platform.current_membership_id();
  facility_value uuid := platform.current_facility_id();
  account_id_value uuid;
  grant_row identity.consent_grants%rowtype;
  day_value date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  kind_value text;
  notice_id_value uuid := gen_random_uuid();
  inbox_id_value uuid;
  facility_name_value text;
  recipient_exists boolean;
begin
  select account.id into account_id_value from auth.accounts account where account.subject = subject_value;
  if account_id_value is null or membership_value is null or facility_value is null
     or platform.current_correlation_id() is null then
    return 'not_applicable';
  end if;
  select * into grant_row from identity.consent_grants candidate
   where candidate.id = requested_consent_grant_id and candidate.membership_id = membership_value
     and candidate.facility_id = facility_value and candidate.account_id = account_id_value
     and candidate.status = 'active' and candidate.starts_at <= clock_timestamp()
     and candidate.expires_at > clock_timestamp() and not candidate.break_glass and candidate.scope <> 'break_glass'
     and candidate.migration_hold_reason is null;
  if not found then
    perform identity.share_audit('staff', subject_value, account_id_value, membership_value, facility_value, null,
      'identity.record-access-notice.note', 'denied', 'consent-grant', null, platform.current_purpose_of_use(),
      jsonb_build_object('reason', 'not_applicable'));
    return 'not_applicable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('record-access-notice:' || grant_row.patient_id::text, 0));
  if exists (select 1 from identity.record_access_notices notice
              where notice.patient_id = grant_row.patient_id and notice.facility_id = facility_value
                and notice.notice_day = day_value) then
    return 'already_noted';
  end if;
  if (select count(*) from identity.record_access_notices notice
       where notice.patient_id = grant_row.patient_id and notice.notice_day = day_value) >= 10 then
    return 'capped';
  end if;
  kind_value := case
    when grant_row.authorization_method = 'patient_access_pin' then 'pin'
    -- 0131: opened as this facility's own patient.
    when grant_row.authorization_method = 'own_facility' then 'own_facility'
    when exists (select 1 from identity.patient_consent_shares share where share.consent_grant_id = grant_row.id)
      then 'share'
    else 'standard' end;
  select facility.name into facility_name_value from identity.facilities facility where facility.id = facility_value;
  inbox_id_value := notification.enqueue_patient_inbox_item(grant_row.patient_id, 'RECORDS_OPENED', 'record-access',
    notice_id_value, jsonb_strip_nulls(jsonb_build_object('facilityName', facility_name_value, 'accessKind', kind_value)));
  recipient_exists := exists (select 1 from integration.verified_notification_recipient(grant_row.patient_id));
  insert into identity.record_access_notices (
    id, patient_id, facility_id, membership_id, consent_grant_id, notice_day, access_kind, first_access_at,
    inbox_item_id, email_status, next_attempt_at
  ) values (
    notice_id_value, grant_row.patient_id, facility_value, membership_value, grant_row.id, day_value, kind_value,
    clock_timestamp(), inbox_id_value, case when recipient_exists then 'pending' else 'not_sent' end,
    case when recipient_exists then clock_timestamp() end
  );
  perform identity.share_audit('staff', subject_value, account_id_value, membership_value, facility_value,
    grant_row.patient_id, 'identity.record-access-notice.note', 'success', 'record-access', notice_id_value,
    platform.current_purpose_of_use(), jsonb_build_object('accessKind', kind_value));
  return 'noted';
end
$function$
$orig$;
end
$away$;
create function pg_temp.away0172() returns void language plpgsql as $away$
begin
  drop trigger zz_billing_admission_open on ehr.admissions;
  drop trigger zz_billing_admission_status on ehr.admissions;
  drop trigger payments_deposit_guard on commercial.payments;
  drop function commercial.hook_admission_open(), commercial.hook_admission_status(),
    commercial.payments_deposit_guard(), commercial.admission_bill_open(uuid),
    commercial.admission_line_put(uuid, uuid, text, text), commercial.admission_fee_add(uuid),
    commercial.accrue_bed_days(uuid), commercial.accrue_bed_days_due(uuid),
    commercial.ward_charges_set(uuid, bigint, uuid, uuid), commercial.ward_charges_list(),
    commercial.interim_statement(uuid), commercial.admission_bill_ids(uuid[]);
  drop table commercial.bed_day_charges, commercial.ward_charge_items;
  alter table commercial.bills drop column admission_id, drop column credit_kobo,
    drop constraint bills_source_check, add constraint bills_source_check check (source in ('visit', 'pharmacy', 'lab')),
    add constraint bills_source_ck check ((source = 'visit') = (visit_queue_entry_id is not null));
  alter table commercial.bill_lines drop constraint bill_lines_origin_check,
    add constraint bill_lines_origin_check check (origin in ('check_in', 'pharmacy', 'lab', 'counter', 'manual'));
  alter table commercial.payments drop column kind;
  alter table commercial.number_counters drop constraint number_counters_kind_check,
    add constraint number_counters_kind_check check (kind in ('bill', 'receipt'));
  -- BILL-1's money-over CHECK (dropped with credit_kobo), as BILL-1 wrote it.
  alter table commercial.bills add constraint bills_over_ck check (
    refund_due_kobo = least(greatest(paid_kobo + pending_check_kobo + waived_kobo + hmo_covered_kobo - total_kobo, 0),
      paid_kobo + pending_check_kobo)
    and cover_over_kobo = greatest(paid_kobo + pending_check_kobo + waived_kobo + hmo_covered_kobo - total_kobo, 0)
      - refund_due_kobo);
  execute $orig$create or replace function commercial.bill_recompute(requested_bill uuid)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  sums record;
  bill commercial.bills%rowtype;
  due bigint;
  over bigint;
  refund bigint;
  status_value text;
begin
  select * into sums from commercial.bill_sums(requested_bill);
  select bill_row.* into bill from commercial.bills bill_row where bill_row.id = requested_bill;
  due := greatest(sums.total_kobo - sums.paid_kobo - sums.pending_check_kobo - sums.waived_kobo - sums.hmo_covered_kobo, 0);
  -- Collected beyond the total (a dispensing reversal took a line off): the patient's money is given back first.
  over := greatest(sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo + sums.hmo_covered_kobo - sums.total_kobo, 0);
  refund := least(over, sums.paid_kobo + sums.pending_check_kobo);
  status_value := case
    when bill.voided_at is not null then 'void'
    when sums.all_lines > 0 and sums.live_lines = 0 and sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo
         + sums.hmo_covered_kobo = 0 then 'void'
    when bill.deferred_reason is not null and due > 0 then 'deferred'
    -- Nothing left to pay on live lines is paid, free lines too (a sale of
    -- free programme medicines has nothing to take and is handed over); so
    -- is a bill whose lines a reversal took off after money was taken.
    when due = 0 and (sums.live_lines > 0 or over > 0) then 'paid'
    when sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo + sums.hmo_covered_kobo > 0 then 'part_paid'
    else 'unpaid' end;
  update commercial.bills bill_row
     set total_kobo = sums.total_kobo, paid_kobo = sums.paid_kobo, pending_check_kobo = sums.pending_check_kobo,
         waived_kobo = sums.waived_kobo, hmo_covered_kobo = sums.hmo_covered_kobo, due_kobo = due,
         refund_due_kobo = refund, cover_over_kobo = over - refund, status = status_value, row_version = bill_row.row_version + 1, updated_at = clock_timestamp()
   where bill_row.id = requested_bill;
end
$$
$orig$;
  execute $orig$create or replace function commercial.bill_totals_agree(requested_bill uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select (bill.total_kobo, bill.paid_kobo, bill.pending_check_kobo, bill.waived_kobo, bill.hmo_covered_kobo)
         = (sums.total_kobo, sums.paid_kobo, sums.pending_check_kobo, sums.waived_kobo, sums.hmo_covered_kobo)
     and bill.due_kobo = greatest(sums.total_kobo - sums.paid_kobo - sums.pending_check_kobo - sums.waived_kobo
                                  - sums.hmo_covered_kobo, 0)
     and (bill.paid_kobo + bill.pending_check_kobo + bill.waived_kobo + bill.hmo_covered_kobo <= bill.total_kobo
          or exists (select 1 from commercial.bill_lines line where line.bill_id = bill.id and line.cancelled
                      and line.dispensing_reversed_at is not null))
     and bill.refund_due_kobo = least(greatest(sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo
           + sums.hmo_covered_kobo - sums.total_kobo, 0), sums.paid_kobo + sums.pending_check_kobo)
     and bill.cover_over_kobo = greatest(sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo
           + sums.hmo_covered_kobo - sums.total_kobo, 0) - bill.refund_due_kobo
    from commercial.bills bill, commercial.bill_sums(bill.id) sums
   where bill.id = requested_bill
$$
$orig$;
  execute $orig$create or replace function commercial.bill_json(requested_bill uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'id', bill.id, 'number', bill.number, 'source', bill.source, 'status', bill.status, 'counter', bill.counter,
    'patient', case when bill.patient_id is null then null else commercial.patient_card(bill.patient_id) end,
    'displayName', case when bill.patient_id is null
                        then coalesce(bill.anonymous_name, case when bill.counter then 'Counter sale' else 'Walk-in' end)
                        else (select patient.full_name from identity.patients patient where patient.id = bill.patient_id) end,
    'visit', case when bill.visit_queue_entry_id is null then null
                  else (select jsonb_build_object('visitQueueEntryId', entry.id, 'queueDay', entry.queue_day)
                          from ehr.visit_queue entry where entry.id = bill.visit_queue_entry_id) end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', line.id, 'catalogueItemId', line.catalogue_item_id,
                'name', line.name, 'kind', line.kind, 'quantity', line.quantity, 'unitKobo', line.unit_kobo,
                'totalKobo', line.total_kobo, 'workItemId', line.work_item_id, 'origin', line.origin,
                'checkQuantity', line.check_quantity, 'note', line.note, 'cancelled', line.cancelled,
                'dispensingReversed', line.dispensing_reversed_at is not null)
                order by line.created_at, line.id)
              from commercial.bill_lines line where line.bill_id = bill.id), '[]'::jsonb),
    'totalKobo', bill.total_kobo, 'paidKobo', bill.paid_kobo, 'waivedKobo', bill.waived_kobo,
    'hmoCoveredKobo', bill.hmo_covered_kobo, 'pendingCheckKobo', bill.pending_check_kobo, 'dueKobo', bill.due_kobo,
    'refundDueKobo', bill.refund_due_kobo, 'coverOverKobo', bill.cover_over_kobo,
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', payment.id, 'method', payment.method,
                'amountKobo', payment.amount_kobo, 'reference', payment.reference, 'hmoId', null,
                'waivedBy', case when payment.method = 'waiver' then commercial.member_name(payment.received_by_membership_id) end,
                'reason', payment.reason,
                'receivedBy', case when payment.received_by_membership_id is null then 'Online payment'
                                   else commercial.member_name(payment.received_by_membership_id) end,
                'receivedAt', payment.received_at, 'voided', payment.voided_at is not null, 'status', payment.status,
                'receiptNumber', payment.receipt_number, 'tillDayId', payment.till_day_id,
                'voidedBy', case when payment.voided_by_membership_id is null then null
                                 else commercial.member_name(payment.voided_by_membership_id) end,
                'voidedAt', payment.voided_at, 'voidReason', payment.void_reason,
                'paperReceiptNumber', payment.paper_receipt_number)
                order by payment.received_at, payment.id)
              from commercial.payments payment where payment.bill_id = bill.id), '[]'::jsonb),
    'hmoCovers', coalesce((select jsonb_agg(jsonb_build_object('id', cover.id, 'hmoId', cover.hmo_id,
                'hmoName', hmo.name, 'amountKobo', cover.amount_kobo, 'approvalCode', cover.approval_code,
                'status', cover.status, 'recordedBy', commercial.member_name(cover.recorded_by_membership_id),
                'recordedAt', cover.recorded_at) order by cover.recorded_at, cover.id)
              from commercial.hmo_covers cover join commercial.facility_hmos hmo on hmo.id = cover.hmo_id
             where cover.bill_id = bill.id), '[]'::jsonb),
    'deferred', case when bill.deferred_reason is null then null
                     else jsonb_build_object('reason', bill.deferred_reason, 'by', bill.deferred_by, 'at', bill.deferred_at) end,
    'receiptNumber', (select payment.receipt_number from commercial.payments payment
                       where payment.bill_id = bill.id and payment.voided_at is null and payment.method <> 'waiver'
                       order by payment.received_at desc, payment.id desc limit 1),
    'handedOverAt', bill.handed_over_at, 'createdAt', bill.created_at, 'version', bill.row_version)
    from commercial.bills bill where bill.id = requested_bill
$$
$orig$;
  execute $orig$create or replace function commercial.bill_for_work(requested_facility uuid, requested_patient uuid, source_value text)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  entry_value uuid;
  bill_id uuid;
begin
  select entry.id into entry_value from ehr.visit_queue entry
   where entry.facility_id = requested_facility and entry.patient_id = requested_patient and entry.closed_at is null;
  if entry_value is null then
    select entry.id into entry_value from ehr.visit_queue entry
     where entry.facility_id = requested_facility and entry.patient_id = requested_patient
       and entry.closed_at is not null and commercial.lagos_day(entry.closed_at) = commercial.lagos_day(clock_timestamp())
     order by entry.closed_at desc, entry.id desc limit 1;
  end if;
  if entry_value is not null then
    perform pg_advisory_xact_lock(hashtextextended('commercial-visit-bill:' || entry_value::text, 0));
    select bill.id into bill_id from commercial.bills bill
     where bill.visit_queue_entry_id = entry_value and bill.status <> 'void' for update;
    if bill_id is null then
      bill_id := commercial.bill_new(requested_facility, 'visit', requested_patient, entry_value, null, false, null,
        null, null);
    end if;
    return bill_id;
  end if;
  return commercial.bill_new(requested_facility, source_value, requested_patient, null, null, false, null, null, null);
end
$$
$orig$;
  execute $orig$create or replace function commercial.payment_record(requested_bill uuid, requested jsonb, expected_version bigint,
  requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  bill commercial.bills%rowtype;
  settings commercial.payment_settings%rowtype;
  method_value text := requested->>'method';
  amount bigint;
  reference_value text := nullif(btrim(coalesce(requested->>'reference', '')), '');
  reason_value text := nullif(btrim(coalesce(requested->>'reason', '')), '');
  paper_value text := nullif(btrim(coalesce(requested->>'paperReceiptNumber', '')), '');
  till_value uuid;
  hmo_value uuid;
  scope_row record;
  day_id uuid;
  year_value integer := extract(year from (clock_timestamp() at time zone 'Africa/Lagos'))::integer;
  receipt text;
  payment_id uuid;
  cover_id uuid;
begin
  select * into actor from commercial.caller('billing.payment.record');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'payment.record');
  if replay.replayed then
    return commercial.bill_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  if jsonb_typeof(requested) <> 'object' or method_value is null
     or method_value not in ('cash', 'pos', 'transfer', 'waiver', 'hmo')
     or jsonb_typeof(requested->'amountKobo') <> 'number'
     or (requested->>'amountKobo')::numeric <> trunc((requested->>'amountKobo')::numeric)
     or (requested->>'amountKobo')::numeric not between 1 and 1000000000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "amountKobo"}';
  end if;
  amount := (requested->>'amountKobo')::numeric::bigint;
  if requested->>'tillId' is not null then
    if requested->>'tillId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "tillId"}';
    end if;
    till_value := (requested->>'tillId')::uuid;
  end if;
  if paper_value is not null and char_length(paper_value) > 30 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "paperReceiptNumber"}';
  end if;
  case method_value
    when 'cash' then
      if reference_value is not null or reason_value is not null then
        raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reference"}';
      end if;
    when 'pos' then
      if reference_value is null or reference_value !~ '^[A-Za-z0-9]{6,20}$' then
        raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reference"}';
      end if;
    when 'transfer' then
      if reference_value is null or char_length(reference_value) not between 4 and 60 then
        raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reference"}';
      end if;
    when 'waiver' then
      if reason_value is null or char_length(reason_value) not between 8 and 500 then
        raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reason"}';
      end if;
      if not commercial.holds('billing.payment.waive') then
        raise exception using errcode = 'HB403', message = 'BILLING_NOT_ALLOWED';
      end if;
    when 'hmo' then
      if reference_value is null or char_length(reference_value) not between 3 and 60
         or coalesce(requested->>'hmoId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "hmoId"}';
      end if;
      hmo_value := (requested->>'hmoId')::uuid;
  end case;
  select payment_settings.* into settings from commercial.payment_settings payment_settings
   where payment_settings.facility_id = actor.facility_id;
  if not (method_value = any (coalesce(settings.methods, array['cash', 'pos', 'transfer']))) then
    raise exception using errcode = 'HB409', message = 'PAYMENT_METHOD_NOT_ACCEPTED';
  end if;
  if coalesce(settings.where_paid, 'cashier') = 'cashier' and commercial.counter_staff_only(actor.membership_id) then
    raise exception using errcode = 'HB403', message = 'PAYMENT_AT_CASHIER_ONLY';
  end if;
  if hmo_value is not null and not exists (select 1 from commercial.facility_hmos hmo
                                            where hmo.id = hmo_value and hmo.facility_id = actor.facility_id and hmo.active) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "hmoId"}';
  end if;
  bill := commercial.bill_lock(requested_bill, actor.facility_id, expected_version);
  if bill.voided_at is not null or bill.status = 'void' then
    raise exception using errcode = 'HB409', message = 'BILL_VOID';
  end if;
  if amount > bill.due_kobo then
    raise exception using errcode = 'HB409', message = 'OVERPAYMENT';
  end if;
  -- The day it is taken in: the open day of the member's scope. A waiver is
  -- listed in that day when there is one, and needs none; HMO cover none.
  if method_value <> 'hmo' then
    begin
      select * into scope_row from commercial.day_scope(actor.facility_id, actor.membership_id, till_value);
      day_id := commercial.open_day_locked(actor.facility_id, scope_row.scope, scope_row.membership_id,
        scope_row.till_id);
    exception when sqlstate 'HB400' then
      if method_value <> 'waiver' then raise; end if;
    end;
    if day_id is null and method_value <> 'waiver' then
      raise exception using errcode = 'HB409', message = 'TILL_DAY_NOT_OPEN';
    end if;
  end if;

  if method_value = 'hmo' then
    insert into commercial.hmo_covers (facility_id, bill_id, hmo_id, amount_kobo, approval_code,
      recorded_by_membership_id, idempotency_key, request_sha256)
    values (actor.facility_id, bill.id, hmo_value, amount, reference_value, actor.membership_id, requested_key,
      requested_sha256)
    returning id into cover_id;
    perform commercial.bill_recompute(bill.id);
    perform commercial.bill_event(bill.id, bill.facility_id, 'hmo-cover', actor.membership_id,
      jsonb_build_object('coverId', cover_id, 'amountKobo', amount));
    perform commercial.command_record(requested_key, requested_sha256, 'payment.record', bill.id);
    perform commercial.audit('commercial.hmo-cover.record', 'success', 'hmo-cover', cover_id::text, bill.patient_id,
      jsonb_build_object('billId', bill.id, 'hmoId', hmo_value, 'amountKobo', amount), 'ehr-api');
    return commercial.bill_json(bill.id);
  end if;

  -- Six digits at least, all of them past 999999 (never cut to six, which would repeat a number).
  receipt := 'R-' || year_value::text || '-' || (select lpad(numbered.n::text, greatest(6, length(numbered.n::text)), '0')
    from (select commercial.next_number(actor.facility_id, 'receipt', year_value) as n) numbered);
  insert into commercial.payments (facility_id, bill_id, method, amount_kobo, reference, reason, status, receipt_number,
    till_day_id, paper_receipt_number, received_by_membership_id, idempotency_key, request_sha256)
  values (actor.facility_id, bill.id, method_value, amount, reference_value,
    case when method_value = 'waiver' then reason_value end,
    case when method_value = 'transfer' then 'pending_check' else 'recorded' end, receipt, day_id, paper_value,
    actor.membership_id, requested_key, requested_sha256)
  returning id into payment_id;
  perform commercial.bill_recompute(bill.id);
  perform commercial.bill_event(bill.id, bill.facility_id, 'payment', actor.membership_id,
    jsonb_build_object('paymentId', payment_id, 'method', method_value, 'amountKobo', amount));
  perform commercial.command_record(requested_key, requested_sha256, 'payment.record', bill.id);
  perform commercial.audit('commercial.payment.record', 'success', 'payment', payment_id::text, bill.patient_id,
    jsonb_build_object('billId', bill.id, 'method', method_value, 'amountKobo', amount,
      'status', case when method_value = 'transfer' then 'pending_check' else 'recorded' end,
      'tillDayId', day_id, 'paperReceipt', paper_value is not null), 'ehr-api');
  return commercial.bill_json(bill.id);
end
$$
$orig$;
end
$away$;
create function pg_temp.away0171() returns void language plpgsql as $away$
declare
  target regprocedure;
begin
  for target in select proc.oid::regprocedure from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'admission\_%' or proc.proname like 'wristband\_%'
                        or proc.proname like 'newborn\_%' or proc.proname like 'death\_record%'
                        or proc.proname like 'discharge\_%')
                   and proc.proname <> 'admission_history_immutable' loop
    execute format('drop function %s', target);
  end loop;
  drop policy encounters_inpatient_owner_update on ehr.encounters;
  drop policy record_versions_inpatient_owner_insert on ehr.record_versions;
  drop policy recorded_allergies_inpatient_band_read on ehr.recorded_allergies;
  drop table ehr.death_record_versions, ehr.death_records, ehr.wristband_prints, ehr.admission_discharge_medicines,
    ehr.admission_movements, ehr.admissions, ehr.admission_counters;
  drop function ehr.admission_history_immutable();
  alter table ehr.ed_attendances drop constraint ed_attendances_closed_via_check,
    add constraint ed_attendances_closed_via_check
      check (closed_via is null or closed_via in ('board', 'disposition', 'cancel', 'waiting_list'));
  alter table ehr.ed_attendance_events drop constraint ed_attendance_events_kind_check,
    add constraint ed_attendance_events_kind_check
      check (kind in ('arrived', 'moved_from_waiting_list', 'already_on_board', 'triaged', 'moved', 'visit_linked',
        'disposition', 'disposition_changed', 'left', 'cancelled', 'closed_on_waiting_list'));
  execute $orig$  create or replace function ehr.inpatient_bed_occupants(requested_facility uuid, requested_wards uuid[])
  returns table (bed_id uuid, patient_id uuid, admission_id uuid, name_shown boolean, card jsonb)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select null::uuid, null::uuid, null::uuid, null::boolean, null::jsonb where false
  $fn$
$orig$;
  execute $orig$  create or replace function ehr.inpatient_waiting(requested_facility uuid, requested_wards uuid[])
  returns table (patient_id uuid, admission_id uuid, name_shown boolean, card jsonb)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select null::uuid, null::uuid, null::boolean, null::jsonb where false
  $fn$
$orig$;
  execute $orig$  create or replace function ehr.inpatient_day_counts(requested_facility uuid, requested_day date)
  returns table (ward_id uuid, admitted integer, transfers_in integer, transfers_out integer, discharged integer,
    died integer, waiting_for_bed integer, midnight_count integer)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select null::uuid, 0, 0, 0, 0, 0, 0, 0 where false
  $fn$
$orig$;
end
$away$;
create function pg_temp.away0170() returns void language plpgsql as $away$
declare
  target regprocedure;
begin
  drop table ehr.ward_events, ehr.ward_staff, ehr.bed_status_events, ehr.beds, ehr.wards, ehr.inpatient_switches;
  for target in select proc.oid::regprocedure from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'ward\_%' or proc.proname like 'bed\_%' or proc.proname like 'inpatient\_%') loop
    execute format('drop function %s', target);
  end loop;
end
$away$;
-- NUR-1's 0174-0177 stand on 0170-0173: where they are applied, they are taken away for the rest of this
-- transaction first (as nursing-migrations.integration.sql takes them away, putting back 0171's and 0173's bodies
-- 0176 replaced), so each ADT-1 file below can be taken away and applied again.
do $nur$
declare
  target regprocedure;
begin
  if to_regclass('ehr.medication_administrations') is null then
    return;
  end if;
  delete from auth.role_permissions where permission_code in ('ehr.mar.read', 'ehr.mar.record', 'ehr.nursing-task.read',
    'ehr.nursing-task.write', 'ehr.handover.write', 'ehr.shift-assignment.manage', 'ehr.clinical-shift.manage');
  delete from auth.permissions where code in ('ehr.mar.read', 'ehr.mar.record', 'ehr.nursing-task.read',
    'ehr.nursing-task.write', 'ehr.handover.write', 'ehr.shift-assignment.manage', 'ehr.clinical-shift.manage');
  set local session_replication_role = replica;
  delete from audit.events where correlation_id = '0177-nursing-nur1';
  set local session_replication_role = origin;
  drop trigger admissions_nursing_tasks_close on ehr.admissions;
  drop table ehr.shift_handover_items, ehr.shift_handovers, ehr.shift_patient_allocations, ehr.shift_assignments,
    ehr.shift_assignment_events, ehr.nursing_tasks, ehr.fluid_balance_entries, ehr.facility_nursing_settings,
    ehr.clinical_shifts, ehr.medication_administrations, ehr.nursing_requests;
  drop policy prescriptions_mar_owner_read on ehr.prescriptions;
  drop trigger prescriptions_inpatient_schedule_guard on ehr.prescriptions;
  for target in select proc.oid::regprocedure from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'nursing\_%' or proc.proname like 'fluid\_balance\_%'
                        or proc.proname like 'clinical\_shift%' or proc.proname like 'shift\_%'
                        or proc.proname like 'handover\_%' or proc.proname like 'mar\_%'
                        or proc.proname like 'observation\_%'
                        or proc.proname in ('prescriptions_inpatient_schedule_guard', 'medication_administrations_guard')) loop
    execute format('drop function %s', target);
  end loop;
  alter table ehr.prescriptions drop constraint prescriptions_inpatient_schedule_ck, drop column schedule_kind,
    drop column scheduled_times, drop column first_due_at, drop column as_needed_reason,
    drop column as_needed_min_interval_minutes, drop column as_needed_max_doses_per_24h,
    drop column infusion_rate_ml_per_hour, drop column infusion_volume_ml, drop column infusion_fluid;
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
$nur$;
create temporary table existing_tables as
  select array_agg(namespace.nspname || '.' || relation.relname) as tables from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
   where relation.relkind in ('r', 'p', 'v', 'm')
     and namespace.nspname not in ('pg_catalog', 'information_schema', 'migration')
     and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'
     and (namespace.nspname, relation.relname) not in (('ehr', 'wards'), ('ehr', 'beds'), ('ehr', 'bed_status_events'),
       ('ehr', 'ward_staff'), ('ehr', 'ward_events'), ('ehr', 'inpatient_switches'), ('ehr', 'admissions'),
       ('ehr', 'admission_movements'), ('ehr', 'admission_counters'), ('ehr', 'admission_discharge_medicines'),
       ('ehr', 'wristband_prints'), ('ehr', 'death_records'), ('ehr', 'death_record_versions'),
       ('commercial', 'ward_charge_items'), ('commercial', 'bed_day_charges'));
select tables::text as existing from existing_tables \gset

-- 3. 0173 taken away.
savepoint s173;
select pg_temp.away0173();
select pg_temp.expect('3a the state before 0173, for this transaction', '0 codes, 0 role rows, 0 audit rows, 0 ward-stay functions',
  pg_temp.made0173());
savepoint s173b;
insert into auth.permissions (code, description) values ('ehr.ward.read', 'Half state');
:run0173
rollback to savepoint s173b;
select pg_temp.expect('3b a half state is refused, nothing applied',
  '55000 0173: the schema is not in the reviewed state (an inpatient code, row or ward-team object is there, but not exactly what 0173 leaves); nothing applied | 0 codes, 0 role rows, 0 audit rows, 0 ward-stay functions',
  pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0173());
do $$
begin
  execute regexp_replace(pg_get_functiondef('auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure),
    '\mselect\M', 'select /* changed */');
end $$;
:run0173
rollback to savepoint s173b;
select pg_temp.expect('3c the permission check changed: refused, nothing applied',
  '55000 0173: these bodies are not as 0001-0151 left them: auth.membership_has_permission(text,uuid,uuid,text) | 0 codes, 0 role rows, 0 audit rows, 0 ward-stay functions',
  pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0173());
alter table identity.record_access_notices drop constraint record_access_notices_access_kind_check,
  add constraint record_access_notices_access_kind_check check (access_kind in ('standard', 'share', 'own_facility'));
:run0173
rollback to savepoint s173b;
select pg_temp.expect('3d a notice kind CHECK without one of 0131''s values: refused, nothing applied',
  '55000 0173: the grant method or notice kind CHECK is not as 0131 left it (with any value another lane added); nothing applied | 0 codes, 0 role rows, 0 audit rows, 0 ward-stay functions',
  pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0173());
alter table identity.consent_grants drop constraint consent_grants_authorization_method_ck,
  add constraint consent_grants_authorization_method_ck
    check (authorization_method is null or authorization_method in ('patient_access_pin', 'own_facility', 'ward_stay'));
:run0173
rollback to savepoint s173b;
select pg_temp.expect('3d2 a grant method CHECK that already holds ward_stay: refused, nothing applied',
  '55000 0173: the grant method or notice kind CHECK is not as 0131 left it (with any value another lane added); nothing applied | 0 codes, 0 role rows, 0 audit rows, 0 ward-stay functions',
  pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0173());
alter table identity.consent_grants drop constraint consent_grants_authorization_method_ck,
  add constraint consent_grants_authorization_method_ck
    check (authorization_method is null or authorization_method in ('patient_access_pin', 'own_facility', 'referral'));
alter table identity.record_access_notices drop constraint record_access_notices_access_kind_check,
  add constraint record_access_notices_access_kind_check
    check (access_kind in ('standard', 'share', 'pin', 'own_facility', 'referral'));
:run0173
select pg_temp.expect('3d3 another lane''s extra method and kind: 0173 applies and keeps them',
  'applied | CHECK (((authorization_method IS NULL) OR (authorization_method = ANY (ARRAY[''patient_access_pin''::text, ''own_facility''::text, ''referral''::text, ''ward_stay''::text])))) | CHECK ((access_kind = ANY (ARRAY[''standard''::text, ''share''::text, ''pin''::text, ''own_facility''::text, ''referral''::text, ''ward_stay''::text])))',
  pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE')
  || ' | ' || (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'identity.consent_grants'::regclass
                and conname = 'consent_grants_authorization_method_ck')
  || ' | ' || (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'identity.record_access_notices'::regclass
                and conname = 'record_access_notices_access_kind_check'));
rollback to savepoint s173b;
delete from locks_seen;
select pg_temp.record_locks('before');
:run0173
select pg_temp.record_locks('after');
select pg_temp.expect('3e 0173 applies', 'applied | 7 codes, 16 role rows, 16 audit rows, 2 ward-stay functions',
  pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0173());
select pg_temp.expect('3f the rows, and every audit row as the system actor with no account, facility or patient',
  'admin:ehr.ward.manage|clinician:ehr.admission.decide,ehr.admission.read,ehr.bed.allocate,ehr.ward.read,ehr.wristband.print|doctor:ehr.admission.decide,ehr.admission.read,ehr.bed.allocate,ehr.ward.read,ehr.wristband.print|nurse:ehr.admission.read,ehr.bed.allocate,ehr.ward.read,ehr.wristband.print|org_admin:ehr.ward.manage / 16 system rows',
  (select string_agg(role_code || ':' || codes, '|' order by role_code)
     from (select role_code, string_agg(permission_code, ',' order by permission_code) as codes
             from auth.role_permissions where permission_code like 'ehr.ward.%' or permission_code like 'ehr.admission.%'
               or permission_code like 'ehr.bed.%' or permission_code like 'ehr.wristband.%'
               or permission_code like 'ehr.death-record.%' group by role_code) grouped)
  || ' / ' || (select count(*) from audit.events
                where correlation_id = '0173-inpatient-adt1' and actor_type = 'system' and actor_account_id is null
                  and facility_id is null and patient_id is null and action = 'auth.role-permission.add'
                  and reason = 'ADT-1 Inpatient (Release D, owner decisions Q185 A and Q191 A)') || ' system rows');
select pg_temp.expect('3g 0173 takes no lock beyond its header''s', '', pg_temp.beyond('0173', :'existing'::text[]));
select pg_temp.expect('3h and holds every lock its header declares', '', pg_temp.missing('0173'));
rollback to savepoint s173;

-- 3j. With the sealed QA tenant and the sealed demo tenant installed (0123's and 0098's install functions, as their
-- suites call them): 0173 writes the test wards there and nowhere else.
savepoint s173s;
select pg_temp.away0173();
select identity.sealed_qa_install() is not null as qa_installed \gset
select identity.sealed_demo_install() is not null as demo_installed \gset
:run0173
select pg_temp.expect('3j 0173 applies with the sealed tenants', 'applied',
  pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.expect('3k QA Hospital: QA Ward A (8 beds, 2 overflow spaces) and QA ICU (4 beds), every ward sealed',
  'QA ICU:icu:4:0|QA Ward A:general:8:2 / true',
  (select string_agg(ward.name || ':' || ward.ward_type || ':' || (select count(*) from ehr.beds bed
            where bed.ward_id = ward.id and bed.kind = 'bed') || ':' || (select count(*) from ehr.beds bed
            where bed.ward_id = ward.id and bed.kind = 'overflow'), '|' order by ward.name)
     from ehr.wards ward where ward.facility_id = 'c0a00002-0000-4000-8000-000000000001')
  || ' / ' || (select bool_and(identity.sealed_qa_facility(ward.facility_id) or identity.sealed_demo_facility(ward.facility_id))::text
                 from ehr.wards ward where ward.name in ('QA Ward A', 'QA ICU')));
select pg_temp.expect('3l the QA nurse, clinician and doctor logins on the staff lists, and no one else', 'true/true',
  (select (count(*) > 0)::text from ehr.ward_staff staff join ehr.wards ward on ward.id = staff.ward_id
    where ward.facility_id = 'c0a00002-0000-4000-8000-000000000001')
  || '/' || (select bool_and(exists (select 1 from auth.account_roles assignment where assignment.membership_id = staff.membership_id
                and assignment.revoked_at is null and assignment.role_code in ('nurse', 'clinician', 'doctor')))::text
               from ehr.ward_staff staff));
select pg_temp.expect('3m one sealed-seed audit row per ward, as the system actor', 'true',
  (select (count(*) = (select count(*) from ehr.wards where name in ('QA Ward A', 'QA ICU'))
           and bool_and(actor_type = 'system' and patient_id is null))::text
     from audit.events where correlation_id = '0173-inpatient-adt1' and action = 'ehr.ward.sealed-seed'));
select pg_temp.expect('3n no patient is admitted by the file', '0', (select count(*)::text from ehr.admissions));
rollback to savepoint s173s;

-- 4. 0173 and 0172 taken away.
savepoint s172;
select pg_temp.away0173();
select pg_temp.away0172();
select pg_temp.expect('4a the state before 0172', '0 tables, 0 triggers, sources visit, pharmacy, lab', pg_temp.made0172());
savepoint s172b;
create table commercial.ward_charge_items (ward_id uuid);
:run0172
rollback to savepoint s172b;
select pg_temp.expect('4b a half state is refused', '55000 0172: the schema is not in the reviewed state (part of 0172 is there); nothing applied',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
do $$
begin
  execute regexp_replace(pg_get_functiondef('commercial.bill_for_work(uuid,uuid,text)'::regprocedure), '\mdeclare\M',
    'declare /* changed */');
end $$;
:run0172
rollback to savepoint s172b;
select pg_temp.expect('4c BILL-1''s bill_for_work changed: refused',
  '55000 0172: these bodies are not as BILL-1 left them: commercial.bill_for_work(uuid,uuid,text)',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
do $$
begin
  execute regexp_replace(pg_get_functiondef('commercial.open_day_locked(uuid,text,uuid,uuid)'::regprocedure), '\mselect\M',
    'select /* changed */');
end $$;
:run0172
rollback to savepoint s172b;
select pg_temp.expect('4c2 a BILL-1 helper the replaced bodies call changed (the till day lock): refused',
  '55000 0172: these bodies are not as BILL-1 left them: commercial.open_day_locked(uuid,text,uuid,uuid)',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table commercial.bills drop constraint bills_over_ck, add constraint bills_over_ck check (refund_due_kobo >= 0);
:run0172
rollback to savepoint s172b;
select pg_temp.expect('4c3 BILL-1''s money-over CHECK changed: refused',
  '55000 0172: these CHECKs are not as BILL-1 left them: bills_over_ck',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table commercial.bills drop constraint bills_source_check, add constraint bills_source_check check (source in ('visit', 'pharmacy'));
:run0172
rollback to savepoint s172b;
select pg_temp.expect('4c4 a source CHECK without one of BILL-1''s values: refused',
  '55000 0172: this CHECK is not as BILL-1 left it (with any value another lane added): commercial.bills.bills_source_check',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table commercial.bills drop constraint bills_source_check,
  add constraint bills_source_check check (source in ('visit', 'pharmacy', 'lab', 'radiology'));
:run0172
select pg_temp.expect('4c5 another lane''s extra source value: 0172 applies and keeps it',
  'applied | 2 tables, 3 triggers, sources visit, pharmacy, lab, radiology, admission',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0172());
rollback to savepoint s172b;
alter table commercial.till_days rename to till_days_suite;
:run0172
rollback to savepoint s172b;
select pg_temp.expect('4d without BILL-1: refused', '55000 0172: BILL-1''s 0162-0167 must be applied first',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
create function ehr.admission_suite_probe() returns text language sql as $f$ select 'commercial.bills' $f$;
:run0172
rollback to savepoint s172b;
select pg_temp.expect('4e an admission function that names the commercial schema: the scan refuses',
  '55000 0172: post-check failed (an admission function reads the bill: admission_suite_probe)',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
delete from locks_seen;
select pg_temp.record_locks('before');
:run0172
select pg_temp.record_locks('after');
select pg_temp.expect('4f 0172 applies', 'applied | 2 tables, 3 triggers, sources visit, pharmacy, lab, admission',
  pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0172());
select pg_temp.expect('4g 0172 takes no lock beyond its header''s', '', pg_temp.beyond('0172', :'existing'::text[]));
select pg_temp.expect('4h and holds every lock its header declares', '', pg_temp.missing('0172'));
rollback to savepoint s172;

-- 5. 0173, 0172 and 0171 taken away.
savepoint s171;
select pg_temp.away0173();
select pg_temp.away0172();
select pg_temp.away0171();
select pg_temp.expect('5a the state before 0171', '0 tables, 0 functions, 0 policies, closed via board, disposition, cancel, waiting_list',
  pg_temp.made0171());
savepoint s171b;
alter table ehr.ed_attendances drop constraint ed_attendances_closed_via_check,
  add constraint ed_attendances_closed_via_check
    check (closed_via is null or closed_via in ('board', 'disposition', 'waiting_list'));
:run0171
rollback to savepoint s171b;
select pg_temp.expect('5b the ED record''s CHECK without one of 0168''s values: refused',
  '55000 0171: the ED record''s closed_via or history kind CHECK is not as 0168 left it (with any value another lane added); nothing applied',
  pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table ehr.ed_attendances drop constraint ed_attendances_closed_via_check,
  add constraint ed_attendances_closed_via_check
    check (closed_via is null or closed_via in ('board', 'disposition', 'cancel', 'waiting_list', 'transfer'));
:run0171
select pg_temp.expect('5b2 another lane''s extra closed_via value: 0171 applies and keeps it',
  'applied | 7 tables, 30 functions, 3 policies, closed via board, disposition, cancel, waiting_list, transfer, admission',
  pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0171());
rollback to savepoint s171b;
do $$
begin
  execute regexp_replace(pg_get_functiondef('ehr.visit_queue_ed_guard()'::regprocedure), '\mbegin\M',
    'begin /* changed */');
end $$;
:run0171
rollback to savepoint s171b;
select pg_temp.expect('5b3 0168''s waiting-list guard changed (the board''s marker): refused',
  '55000 0171: these bodies are not as 0001-0170 left them: ehr.visit_queue_ed_guard()',
  pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
do $$
begin
  execute regexp_replace(pg_get_functiondef('ehr.inpatient_waiting(uuid,uuid[])'::regprocedure), '\mwhere false\M',
    'where 1 = 0');
end $$;
:run0171
rollback to savepoint s171b;
select pg_temp.expect('5c 0170''s waiting part changed: refused',
  '55000 0171: these bodies are not as 0001-0170 left them: ehr.inpatient_waiting(uuid,uuid[])',
  pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
create table ehr.wristband_prints (id uuid);
:run0171
rollback to savepoint s171b;
select pg_temp.expect('5d a half state is refused',
  '55000 0171: the schema is not in the reviewed state (part of 0171 is there); nothing applied',
  pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
delete from locks_seen;
select pg_temp.record_locks('before');
:run0171
select pg_temp.record_locks('after');
select pg_temp.expect('5e 0171 applies',
  'applied | 7 tables, 30 functions, 3 policies, closed via board, disposition, cancel, waiting_list, admission',
  pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0171());
select pg_temp.expect('5f 0171 takes no lock beyond its header''s', '', pg_temp.beyond('0171', :'existing'::text[]));
select pg_temp.expect('5g and holds every lock its header declares', '', pg_temp.missing('0171'));
rollback to savepoint s171;

-- 6. All four taken away.
savepoint s170;
select pg_temp.away0173();
select pg_temp.away0172();
select pg_temp.away0171();
select pg_temp.away0170();
select pg_temp.expect('6a the state before 0170', '0 tables, 0 functions', pg_temp.made0170());
:run0171
select pg_temp.expect('6b 0171 without 0170: refused', '55000 0171: 0170 must be applied first',
  pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0173
select pg_temp.expect('6c 0173 without 0170 and 0171: refused', '55000 0173: 0170 and 0171 must be applied first',
  pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
savepoint s170b;
create table ehr.inpatient_switches (key text);
:run0170
rollback to savepoint s170b;
select pg_temp.expect('6d a half state of 0170 is refused',
  '55000 0170: the schema is not in the reviewed state (part of 0170 is there); nothing applied',
  pg_temp.answer('0170', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter default privileges in schema ehr grant usage, select on sequences to hid_ehr_runtime;
:run0170
rollback to savepoint s170b;
select pg_temp.expect('6d2 a runtime would get the new histories'' sequences: 0170''s post-check refuses',
  '55000 0170: post-check failed (a sequence of the new tables is granted to a role or is not the owner''s)',
  pg_temp.answer('0170', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
delete from locks_seen;
select pg_temp.record_locks('before');
:run0170
select pg_temp.record_locks('after');
select pg_temp.expect('6e 0170 applies', 'applied | 6 tables, 20 functions',
  pg_temp.answer('0170', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0170());
select pg_temp.expect('6f 0170 takes no lock beyond its header''s', '', pg_temp.beyond('0170', :'existing'::text[]));
select pg_temp.expect('6g and holds every lock its header declares', '', pg_temp.missing('0170'));
select pg_temp.expect('6h the three switches, all off',
  'board_names_for_ward_staff=false,death_record=false,ward_stay_access=false',
  (select string_agg(key || '=' || enabled::text, ',' order by key) from ehr.inpatient_switches));
:run0171
select pg_temp.expect('6i then 0171', 'applied', pg_temp.answer('0171', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0172
select pg_temp.expect('6j then 0172', 'applied', pg_temp.answer('0172', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0173
select pg_temp.expect('6k then 0173', 'applied', pg_temp.answer('0173', :'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.expect('6l all four as on a migrated database', :'made_applied',
  pg_temp.made0170() || ' | ' || pg_temp.made0171() || ' | ' || pg_temp.made0172() || ' | ' || pg_temp.made0173());
rollback to savepoint s170;

do $$
begin
  raise notice '0170-0173 migrations: % cases passed', currval('pg_temp.m170_passed');
end $$;
rollback;
