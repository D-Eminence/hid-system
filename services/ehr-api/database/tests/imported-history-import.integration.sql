\set ON_ERROR_STOP on
\o /dev/null
-- The legacy medical history import command (owner decision 3 of 2026-10-16,
-- ADR-066, migration 0097), against the database. Rollback-only.
--
-- ehr.import_legacy_medical_history is the write boundary: whatever
-- import-legacy-history.mjs checked first, the command itself must refuse
-- every input that is not a sealed history run of a verified legacy identity
-- run, with the same codes. This suite stages crafted runs the way main's
-- stager and the history scope stage them (running, rows, then sealed; the
-- parent then reconciled and verified), through the real ledger triggers,
-- and calls the command as hid_migration_admin, the only role that may:
-- - the history run's source system is legacy_imported_history, which main's
--   crosswalk gate does not count, so staging and importing a history leave
--   public patient enrollment open; a history run of source system
--   legacy_identity is refused, and the history run is sealed by the same
--   rules as a legacy identity run (no row after the seal, no second seal, no
--   snapshot change, no resume);
-- - every refusal code of the command, each on its own crafted run;
-- - patient-provided and provider-authored origins, the receipt run, an
--   idempotent repeat (also under another session time zone), and a later
--   history whose record differs from the imported one;
-- - legacy timestamps only as ISO 8601 with an offset, finite (no 'now',
--   'infinity', 'epoch' or zone-less value);
-- - an import whose time grows linearly with the number of versions.
--
-- Fixtures are synthetic and in the ea identifier range, which no other suite
-- and neither release/migration/synthetic-fixture.mjs nor the importer's
-- fixtures (e7) use. Every case is recorded and the suite fails at the end
-- listing every case whose outcome differs.
begin;

create temporary table import_case_results(name text primary key, expected text not null, actual text not null)
  on commit drop;
grant all on import_case_results to public;
create function pg_temp.import_record(name text, expected text, actual text) returns void
language sql as $$
  insert into import_case_results values (name, expected, coalesce(actual, '<none>'));
$$;
create function pg_temp.ea(kind text, n integer) returns text
language sql immutable as $$
  select 'ea' || kind || '00000-0000-4000-8000-' || lpad(n::text, 12, '0');
$$;

-- The enrollment gate, as Identity asks it before any public enrollment.
create function pg_temp.enrollment_ready() returns text
language plpgsql as $$
declare
  ready text;
begin
  perform set_config('app.actor_subject', 'system:auth', true);
  ready := identity.public_patient_enrollment_ready()::text || ':' || identity.legacy_nin_crosswalk_ready()::text;
  perform set_config('app.actor_subject', '', true);
  return ready;
end
$$;
select pg_temp.import_record('enrollment is open before any history run', 'true:true', pg_temp.enrollment_ready());

-- Canonical accounts and patients, as main's promoter leaves them (the legacy
-- ids are the canonical ids). Accounts: 1 patient P, 2 staff S, 3 patient Q,
-- 4 an account the parent did not stage, 6 patient R's account. Patients: P,
-- Q, and R, who exists canonically but was not staged by the parent.
insert into auth.accounts(id,subject,email,display_name,status)
select pg_temp.ea('1', n)::uuid, 'synthetic:import-suite:'||n, 'import-suite-'||n||'@example.invalid',
  'Synthetic import suite '||n, 'active'
from unnest(array[1,2,3,4,6]) n;
insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
values (pg_temp.ea('2', 1)::uuid, pg_temp.ea('1', 1)::uuid, 'HID-EAXMPA', 'Import', 'P', 'Import P', 'active'),
  (pg_temp.ea('2', 2)::uuid, pg_temp.ea('1', 3)::uuid, 'HID-EAXMPB', 'Import', 'Q', 'Import Q', 'active'),
  (pg_temp.ea('2', 3)::uuid, pg_temp.ea('1', 6)::uuid, 'HID-EAXMPC', 'Import', 'R', 'Import R', 'active');

-- One staged row: its category and its payload, keyed by the payload's id.
create function pg_temp.staged(entity text, payload jsonb) returns jsonb
language sql immutable as $$ select jsonb_build_object('entity_type', entity, 'payload', payload) $$;

-- Stages rows into a new run exactly as the stager does: running, the rows,
-- then sealed with the counts (for a history run, of all three categories).
-- A parent is then reconciled and verified, as main's promoter and
-- reconciler leave it.
create function pg_temp.stage_run(run text, system text, snapshot text, rows jsonb, seal boolean default true,
  counts jsonb default null, verify boolean default false) returns void
language plpgsql as $$
declare
  item jsonb;
begin
  insert into migration.runs(id, source_system, source_snapshot, mode, status, started_by, source_transaction_snapshot)
  values (run::uuid, system, snapshot, 'stage', 'running', 'synthetic-import-suite', 'synthetic:' || run);
  for item in select value from jsonb_array_elements(rows) loop
    insert into migration.source_rows(run_id, entity_type, source_pk, payload, payload_sha256, source_updated_at)
    values (run::uuid, item ->> 'entity_type', item -> 'payload' ->> 'id', item -> 'payload',
      encode(sha256(convert_to((item -> 'payload')::text, 'UTF8')), 'hex'), clock_timestamp());
  end loop;
  if not seal then
    return;
  end if;
  update migration.runs
     set status = 'staged', source_checksum_sha256 = repeat('5', 64),
         source_counts = coalesce(counts, case when system = 'legacy_imported_history' then
           (select jsonb_object_agg(category, (select count(*) from jsonb_array_elements(rows) element
                                                 where element ->> 'entity_type' = category))
              from unnest(array['medical_records', 'medical_record_versions', 'medical_record_files']) category)
           else (select coalesce(jsonb_object_agg(category, total), '{}') from (
                   select element ->> 'entity_type' as category, count(*) as total
                     from jsonb_array_elements(rows) element group by 1) totals) end)
   where id = run::uuid;
  if verify then
    update migration.runs set mode = 'reconcile', status = 'verified', completed_at = clock_timestamp()
     where id = run::uuid;
  end if;
end
$$;

-- The parent: accounts, user profiles, patients and staff of the legacy
-- identity source. Profiles: 1 is P's, 2 S's, 3 Q's, 4 names account 4,
-- which the parent did not stage; staff 1 is S.
create temporary table parent_rows on commit drop as
select jsonb_agg(item order by item -> 'payload' ->> 'id') as rows from (
  select pg_temp.staged('accounts', jsonb_build_object('id', pg_temp.ea('1', n), 'email', 'import-'||n||'@example.invalid')) item
    from unnest(array[1,2,3]) n
  union all
  select pg_temp.staged('user_profiles', jsonb_build_object('id', pg_temp.ea('3', n), 'auth_user_id', pg_temp.ea('1', n)))
    from unnest(array[1,2,3,4]) n
  union all
  select pg_temp.staged('patients', jsonb_build_object('id', pg_temp.ea('2', 1), 'auth_user_id', pg_temp.ea('1', 1),
    'hid_code', 'HID-EAXMPA'))
  union all
  select pg_temp.staged('patients', jsonb_build_object('id', pg_temp.ea('2', 2), 'auth_user_id', pg_temp.ea('1', 3),
    'hid_code', 'HID-EAXMPB'))
  union all
  select pg_temp.staged('staff', jsonb_build_object('id', pg_temp.ea('4', 1), 'auth_user_id', pg_temp.ea('1', 2)))) staged;
select pg_temp.stage_run(pg_temp.ea('5', 1), 'legacy_identity', 'synthetic-import-suite-v1',
  (select rows from parent_rows), verify => true);

-- The base history of the same snapshot: records 1 and 2 of P (1 written by
-- P with versions 1 and 2 and a file on version 2; 2 written by S), record 3
-- of Q, written by Q.
create function pg_temp.history_record(n integer, patient integer, current_version integer, author integer,
  staff integer, title text) returns jsonb
language sql immutable as $$
  select pg_temp.staged('medical_records', jsonb_build_object('id', pg_temp.ea('6', n),
    'patient_id', pg_temp.ea('2', patient), 'current_version_id', pg_temp.ea('7', current_version),
    'title', title, 'category', 'history', 'info_type', 'text',
    'created_by_user_profile_id', pg_temp.ea('3', author),
    'created_by_staff_account_id', case when staff is null then null else pg_temp.ea('4', staff) end,
    'created_at', '2025-03-0' || n || 'T08:00:00.000Z', 'updated_at', '2025-03-0' || n || 'T09:00:00+01:00'))
$$;
create function pg_temp.history_version(n integer, record integer, version_no integer, author integer, staff integer)
returns jsonb
language sql immutable as $$
  select pg_temp.staged('medical_record_versions', jsonb_build_object('id', pg_temp.ea('7', n),
    'record_id', pg_temp.ea('6', record), 'version_no', version_no,
    'created_by_user_profile_id', pg_temp.ea('3', author),
    'created_by_staff_account_id', case when staff is null then null else pg_temp.ea('4', staff) end,
    'record', 'Invented import suite content ' || n, 'notes', null, 'structured_data', jsonb_build_object('synthetic', true),
    'transcription_text', null, 'created_at', '2025-03-01T08:0' || version_no || ':00.000Z'))
$$;
create temporary table history_base on commit drop as
select jsonb_build_array(
  pg_temp.history_record(1, 1, 12, 1, null, 'Synthetic import history 1'),
  pg_temp.history_record(2, 1, 21, 2, 1, 'Synthetic import history 2'),
  pg_temp.history_record(3, 2, 31, 3, null, 'Synthetic import history 3'),
  pg_temp.history_version(11, 1, 1, 1, null),
  pg_temp.history_version(12, 1, 2, 1, null),
  pg_temp.history_version(21, 2, 1, 2, 1),
  pg_temp.history_version(31, 3, 1, 3, null),
  pg_temp.staged('medical_record_files', jsonb_build_object('id', pg_temp.ea('8', 1), 'record_id', pg_temp.ea('6', 1),
    'patient_id', pg_temp.ea('2', 1), 'record_version_id', pg_temp.ea('7', 12),
    'uploaded_by_user_profile_id', pg_temp.ea('3', 1), 'original_file_name', 'synthetic-import.txt',
    'mime_type', 'text/plain', 'size_bytes', 19, 'storage_bucket', 'synthetic-private',
    'storage_path', 'synthetic/import-1', 'created_at', '2025-03-01T08:30:00Z'))) as rows;

-- The base history with one row's payload changed (patch), removed (null
-- patch) or another row added.
create function pg_temp.variant(entity text, id text, patch jsonb) returns jsonb
language sql as $$
  select coalesce(jsonb_agg(case when element ->> 'entity_type' = entity and element -> 'payload' ->> 'id' = id
      then jsonb_set(element, '{payload}', (element -> 'payload') || patch) else element end)
    filter (where patch is not null or not (element ->> 'entity_type' = entity and element -> 'payload' ->> 'id' = id)),
    '[]'::jsonb)
  from history_base, jsonb_array_elements(history_base.rows) element
$$;
create function pg_temp.plus(item jsonb) returns jsonb
language sql as $$ select rows || jsonb_build_array(item) from history_base $$;

-- The rows the importer sends: exactly the run's sealed rows.
create function pg_temp.sealed_rows(run text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('entityType', entity_type, 'sourcePk', source_pk, 'payload', payload,
      'payloadSha256', btrim(payload_sha256)) order by entity_type, source_pk), '[]'::jsonb)
    from migration.source_rows where run_id = run::uuid
$$;
-- The command as the migration administrator: 'accepted' (and rolled back)
-- or SQLSTATE:message.
create function pg_temp.import_attempt(parent text, history text, supplied jsonb default null,
  operator text default 'synthetic-import-suite') returns text
language plpgsql as $$
declare
  rows jsonb := coalesce(supplied, pg_temp.sealed_rows(history));
begin
  begin
    set local role hid_migration_admin;
    perform ehr.import_legacy_medical_history(parent::uuid, history::uuid, operator, rows);
    raise exception using errcode = 'P0001', message = 'import-suite-rollback';
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'import-suite-rollback' then return 'accepted'; end if;
      return sqlstate || ':' || sqlerrm;
    when others then
      return sqlstate || ':' || sqlerrm;
  end;
end
$$;
-- The command as the migration administrator, kept: its inserted counts.
create function pg_temp.import_apply(parent text, history text) returns text
language plpgsql as $$
declare
  result jsonb;
begin
  set local role hid_migration_admin;
  result := ehr.import_legacy_medical_history(parent::uuid, history::uuid, 'synthetic-import-suite',
    pg_temp.sealed_rows(history));
  reset role;
  return (result -> 'inserted' ->> 'medical_records') || ',' || (result -> 'inserted' ->> 'medical_record_versions')
    || ',' || (result -> 'inserted' ->> 'medical_record_files');
exception when others then
  reset role;
  return sqlstate || ':' || sqlerrm;
end
$$;
-- A history run of the base rows (or the given rows), sealed.
create function pg_temp.history(n integer, rows jsonb default null, snapshot text default 'synthetic-import-suite-v1',
  system text default 'legacy_imported_history', seal boolean default true, counts jsonb default null) returns text
language plpgsql as $$
declare
  run text := pg_temp.ea('5', n);
begin
  perform pg_temp.stage_run(run, system, snapshot, coalesce(rows, (select history_base.rows from history_base)),
    seal, counts);
  return run;
end
$$;

-- 1. The history run's own seal: the rules of a legacy identity run, for
--    source system legacy_imported_history.
select pg_temp.history(2);
select pg_temp.import_record('enrollment stays open with a sealed history run', 'true:true', pg_temp.enrollment_ready());
do $$
declare
  probe record;
  outcome text;
begin
  for probe in select * from (values
    ('a row appended after the seal', $q$insert into migration.source_rows(run_id, entity_type, source_pk, payload,
       payload_sha256) values ('ea500000-0000-4000-8000-000000000002', 'medical_records',
       'ea600000-0000-4000-8000-000000000099', '{"id":"ea600000-0000-4000-8000-000000000099"}', repeat('6', 64))$q$),
    ('a second seal of the counts', $q$update migration.runs set source_counts = '{"medical_records":1}'
       where id = 'ea500000-0000-4000-8000-000000000002'$q$),
    ('a second seal of the checksum', $q$update migration.runs set source_checksum_sha256 = repeat('7', 64)
       where id = 'ea500000-0000-4000-8000-000000000002'$q$),
    ('a changed snapshot', $q$update migration.runs set source_snapshot = 'another-snapshot'
       where id = 'ea500000-0000-4000-8000-000000000002'$q$),
    ('a resumed run', $q$update migration.runs set status = 'running'
       where id = 'ea500000-0000-4000-8000-000000000002'$q$),
    ('another source system', $q$update migration.runs set source_system = 'legacy_identity'
       where id = 'ea500000-0000-4000-8000-000000000002'$q$),
    ('another mode', $q$update migration.runs set mode = 'reconcile', status = 'verified', completed_at = clock_timestamp()
       where id = 'ea500000-0000-4000-8000-000000000002'$q$))
    cases(name, change)
  loop
    -- Each probe is rolled back, whether it is refused or not.
    begin
      execute probe.change;
      raise exception using errcode = 'P0001', message = 'seal-probe-rollback';
    exception
      when sqlstate '55000' then outcome := 'refused';
      when sqlstate 'P0001' then outcome := 'changed';
    end;
    perform pg_temp.import_record('sealed history run: ' || probe.name, 'refused', outcome);
  end loop;
end $$;

-- 2. Refusals, each on its own crafted run (the history of a refusal is
--    rolled back with it).
select pg_temp.import_record('operator too short', '22023:IMPORTED_HISTORY_INPUT_INVALID',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.ea('5', 2), operator => 'ab'));
select pg_temp.import_record('rows not an array', '22023:IMPORTED_HISTORY_INPUT_INVALID',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.ea('5', 2), '{}'::jsonb));
-- Parents: a history run, an unverified identity run, one with a conflict.
select pg_temp.import_record('parent is a history run', '55000:IMPORTED_HISTORY_PARENT_NOT_VERIFIED',
  pg_temp.import_attempt(pg_temp.ea('5', 2), pg_temp.ea('5', 2)));
-- A staged legacy identity run closes enrollment (main's crosswalk gate), so
-- the cases that stage one roll it back with them.
create function pg_temp.rolled_back(statement text) returns text
language plpgsql as $$
declare
  outcome text;
begin
  begin
    execute 'select ' || statement into outcome;
    raise exception using errcode = 'P0001', message = 'identity-run-rollback', detail = outcome;
  exception when sqlstate 'P0001' then
    get stacked diagnostics outcome = pg_exception_detail;
  end;
  return outcome;
end
$$;
select pg_temp.import_record('parent only staged, not reconciled', '55000:IMPORTED_HISTORY_PARENT_NOT_VERIFIED',
  pg_temp.rolled_back($s$(select pg_temp.import_attempt(pg_temp.ea('5', 3), pg_temp.ea('5', 2))
    from (select pg_temp.stage_run(pg_temp.ea('5', 3), 'legacy_identity', 'synthetic-import-suite-v1',
      (select rows from parent_rows))) staged)$s$));
select pg_temp.stage_run(pg_temp.ea('5', 4), 'legacy_identity', 'synthetic-import-suite-v1', (select rows from parent_rows),
  verify => true);
insert into migration.conflicts(run_id, entity_type, source_pk, conflict_type)
values (pg_temp.ea('5', 4)::uuid, 'patients', pg_temp.ea('2', 1), 'invalid_source_value');
select pg_temp.import_record('parent with a conflict', '55000:IMPORTED_HISTORY_PARENT_NOT_VERIFIED',
  pg_temp.import_attempt(pg_temp.ea('5', 4), pg_temp.ea('5', 2)));
-- Histories: the parent itself, an identity-system run, an unsealed run, one
-- with a conflict, another snapshot, other categories or counts.
select pg_temp.import_record('history is the parent', '55000:IMPORTED_HISTORY_RUN_NOT_SEALED',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.ea('5', 1)));
select pg_temp.import_record('history of source system legacy_identity', '55000:IMPORTED_HISTORY_RUN_NOT_SEALED',
  pg_temp.rolled_back($s$pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.history(10, system => 'legacy_identity'))$s$));
select pg_temp.import_record('history left running', '55000:IMPORTED_HISTORY_RUN_NOT_SEALED',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.history(11, seal => false)));
insert into migration.conflicts(run_id, entity_type, source_pk, conflict_type)
values (pg_temp.history(12)::uuid, 'medical_records', pg_temp.ea('6', 1), 'invalid_source_value');
select pg_temp.import_record('history with a conflict', '55000:IMPORTED_HISTORY_RUN_NOT_SEALED',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.ea('5', 12)));
select pg_temp.import_record('history of another snapshot', '55000:IMPORTED_HISTORY_SNAPSHOT_MISMATCH',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.history(13, snapshot => 'synthetic-import-suite-v2')));
select pg_temp.import_record('history holding a patient row', '55000:IMPORTED_HISTORY_CATEGORY_MISMATCH',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.history(14, pg_temp.plus(pg_temp.staged('patients',
    jsonb_build_object('id', pg_temp.ea('2', 1), 'auth_user_id', pg_temp.ea('1', 1)))))));
select pg_temp.import_record('history counts without the files', '55000:IMPORTED_HISTORY_CATEGORY_MISMATCH',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.history(15,
    counts => '{"medical_records":3,"medical_record_versions":4}')));
select pg_temp.import_record('history counts that are not the rows', '55000:IMPORTED_HISTORY_CATEGORY_MISMATCH',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.history(16,
    counts => '{"medical_records":2,"medical_record_versions":4,"medical_record_files":1}')));
-- Supplied rows that are not the sealed rows.
select pg_temp.import_record('a sealed row left out', '55000:IMPORTED_HISTORY_ROWS_DIFFER',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.ea('5', 2), pg_temp.sealed_rows(pg_temp.ea('5', 2)) - 0));
select pg_temp.import_record('a sealed row altered', '55000:IMPORTED_HISTORY_ROWS_DIFFER',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.ea('5', 2), jsonb_set(pg_temp.sealed_rows(pg_temp.ea('5', 2)),
    '{0,payload,title}', '"Synthetic forged title"')));
-- Records, versions and files that the command refuses.
do $$
declare
  probe record;
  run integer := 20;
begin
  for probe in select * from (values
    ('record created now', 'medical_records', 1, '{"created_at":"now"}', 'IMPORTED_HISTORY_RECORD_INVALID'),
    ('record updated at infinity', 'medical_records', 1, '{"updated_at":"infinity"}', 'IMPORTED_HISTORY_RECORD_INVALID'),
    ('record created without a zone', 'medical_records', 1, '{"created_at":"2025-03-01 08:00:00"}',
       'IMPORTED_HISTORY_RECORD_INVALID'),
    ('record created at epoch', 'medical_records', 1, '{"created_at":"epoch"}', 'IMPORTED_HISTORY_RECORD_INVALID'),
    ('record of a patient id that is not a UUID', 'medical_records', 1, '{"patient_id":"not-a-uuid"}',
       'IMPORTED_HISTORY_RECORD_INVALID'),
    ('record of a patient the parent did not stage', 'medical_records', 1,
       '{"patient_id":"ea200000-0000-4000-8000-000000000003"}', 'IMPORTED_HISTORY_BINDING_DIFFERS'),
    ('record whose current version is another record''s', 'medical_records', 1,
       '{"current_version_id":"ea700000-0000-4000-8000-000000000021"}', 'IMPORTED_HISTORY_BINDING_DIFFERS'),
    ('record by a profile the parent did not stage', 'medical_records', 1,
       '{"created_by_user_profile_id":"ea300000-0000-4000-8000-000000000009"}', 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED'),
    ('record by a profile whose account the parent did not stage', 'medical_records', 1,
       '{"created_by_user_profile_id":"ea300000-0000-4000-8000-000000000004"}', 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED'),
    ('record by the patient naming a staff member', 'medical_records', 1,
       '{"created_by_staff_account_id":"ea400000-0000-4000-8000-000000000001"}', 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED'),
    ('record by another patient', 'medical_records', 1,
       '{"created_by_user_profile_id":"ea300000-0000-4000-8000-000000000003"}', 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED'),
    ('record by staff naming another staff member', 'medical_records', 2,
       '{"created_by_staff_account_id":"ea400000-0000-4000-8000-000000000009"}', 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED'),
    ('version numbered as another', 'medical_record_versions', 12, '{"version_no":1}', 'IMPORTED_HISTORY_VERSION_INVALID'),
    ('version numbered 0', 'medical_record_versions', 11, '{"version_no":0}', 'IMPORTED_HISTORY_VERSION_INVALID'),
    ('version numbered with a string', 'medical_record_versions', 11, '{"version_no":"1"}',
       'IMPORTED_HISTORY_VERSION_INVALID'),
    ('version without content', 'medical_record_versions', 11, '{"record":" ","structured_data":{}}',
       'IMPORTED_HISTORY_VERSION_INVALID'),
    ('version created without a zone', 'medical_record_versions', 11, '{"created_at":"2024-01-01 10:00:00"}',
       'IMPORTED_HISTORY_VERSION_INVALID'),
    ('version created now', 'medical_record_versions', 11, '{"created_at":"now"}', 'IMPORTED_HISTORY_VERSION_INVALID'),
    ('version of a record the run does not hold', 'medical_record_versions', 11,
       '{"record_id":"ea600000-0000-4000-8000-000000000009"}', 'IMPORTED_HISTORY_BINDING_DIFFERS'),
    ('version by a profile the parent did not stage', 'medical_record_versions', 11,
       '{"created_by_user_profile_id":"ea300000-0000-4000-8000-000000000009"}', 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED'),
    ('file created at epoch', 'medical_record_files', 1, '{"created_at":"epoch"}', 'IMPORTED_HISTORY_FILE_INVALID'),
    ('file created at infinity', 'medical_record_files', 1, '{"created_at":"infinity"}', 'IMPORTED_HISTORY_FILE_INVALID'),
    ('file size as a string', 'medical_record_files', 1, '{"size_bytes":"19"}', 'IMPORTED_HISTORY_FILE_INVALID'),
    ('file without a media type', 'medical_record_files', 1, '{"mime_type":null}', 'IMPORTED_HISTORY_FILE_INVALID'),
    ('file of another patient than its record''s', 'medical_record_files', 1,
       '{"patient_id":"ea200000-0000-4000-8000-000000000002"}', 'IMPORTED_HISTORY_BINDING_DIFFERS'),
    ('file of another record''s version', 'medical_record_files', 1,
       '{"record_version_id":"ea700000-0000-4000-8000-000000000021"}', 'IMPORTED_HISTORY_BINDING_DIFFERS'),
    ('file uploaded by a profile the parent did not stage', 'medical_record_files', 1,
       '{"uploaded_by_user_profile_id":"ea300000-0000-4000-8000-000000000009"}', 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED'))
    cases(name, entity, item, patch, code)
  loop
    run := run + 1;
    perform pg_temp.import_record(probe.name, '55000:' || probe.code,
      pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.history(run, pg_temp.variant(probe.entity,
        pg_temp.ea(case probe.entity when 'medical_records' then '6' when 'medical_record_versions' then '7' else '8' end,
          probe.item), probe.patch::jsonb))));
  end loop;
end $$;
select pg_temp.import_record('nothing was imported by a refusal', '0|0|0',
  (select count(*) || '|' || (select count(*) from ehr.imported_medical_record_versions where id::text like 'ea7%')
     || '|' || (select count(*) from ehr.imported_medical_record_files where id::text like 'ea8%')
     from ehr.imported_medical_records where id::text like 'ea6%'));

-- 3. The import: every row once, each author's origin, the receipt, and
--    enrollment still open.
select pg_temp.import_record('the import inserts every row', '3,4,1', pg_temp.import_apply(pg_temp.ea('5', 1),
  pg_temp.ea('5', 2)));
select pg_temp.import_record('record origins and authors',
  '01:patient-provided:01:2025-03-01 08:00:00+00,02:provider-authored:02:2025-03-02 08:00:00+00,'
  || '03:patient-provided:03:2025-03-03 08:00:00+00',
  (select string_agg(right(id::text, 2) || ':' || origin || ':' || right(author_account_id::text, 2) || ':'
     || to_char(source_created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') || '+00', ',' order by id)
     from ehr.imported_medical_records where id::text like 'ea6%'));
select pg_temp.import_record('version origins',
  '11:1:patient-provided,12:2:patient-provided,21:1:provider-authored,31:1:patient-provided',
  (select string_agg(right(id::text, 2) || ':' || version_no || ':' || origin, ',' order by id)
     from ehr.imported_medical_record_versions where id::text like 'ea7%'));
select pg_temp.import_record('file binding and uploader', '01:12:01',
  (select string_agg(right(id::text, 2) || ':' || right(record_version_id::text, 2) || ':'
     || right(uploader_account_id::text, 2), ',') from ehr.imported_medical_record_files where id::text like 'ea8%'));
select pg_temp.import_record('the receipt run', 'legacy_imported_history:cutover:completed:synthetic-import-suite:'
  || '{"medical_records": 3, "medical_record_files": 1, "medical_record_versions": 4}',
  (select source_system || ':' || mode || ':' || status || ':' || started_by || ':' || target_counts::text
     from migration.runs where id = md5('hid-imported-history:' || pg_temp.ea('5', 1) || ':' || pg_temp.ea('5', 2))::uuid));
select pg_temp.import_record('enrollment stays open after the import', 'true:true', pg_temp.enrollment_ready());
create temporary table imported_snapshot on commit drop as
select (select md5(string_agg(to_jsonb(t)::text, ',' order by id)) from ehr.imported_medical_records t
         where id::text like 'ea6%') as records,
       (select md5(string_agg(to_jsonb(t)::text, ',' order by id)) from ehr.imported_medical_record_versions t
         where id::text like 'ea7%') as versions,
       (select md5(string_agg(to_jsonb(t)::text, ',' order by id)) from ehr.imported_medical_record_files t
         where id::text like 'ea8%') as files;
-- A repeat changes nothing, also from a session in another time zone.
select pg_temp.import_record('a repeated import inserts nothing', '0,0,0', pg_temp.import_apply(pg_temp.ea('5', 1),
  pg_temp.ea('5', 2)));
set local timezone = 'America/New_York';
select pg_temp.import_record('a repeat in another session time zone inserts nothing', '0,0,0',
  pg_temp.import_apply(pg_temp.ea('5', 1), pg_temp.ea('5', 2)));
reset timezone;
select pg_temp.import_record('the repeats left every imported row as it was', 'true',
  (select ((select md5(string_agg(to_jsonb(t)::text, ',' order by id)) from ehr.imported_medical_records t
             where id::text like 'ea6%') = records
       and (select md5(string_agg(to_jsonb(t)::text, ',' order by id)) from ehr.imported_medical_record_versions t
             where id::text like 'ea7%') = versions
       and (select md5(string_agg(to_jsonb(t)::text, ',' order by id)) from ehr.imported_medical_record_files t
             where id::text like 'ea8%') = files)::text from imported_snapshot));
-- A later history of the same snapshot whose record differs from the imported one.
select pg_temp.import_record('a later history whose record differs', '55000:IMPORTED_HISTORY_DIFFERS',
  pg_temp.import_attempt(pg_temp.ea('5', 1), pg_temp.history(60,
    pg_temp.variant('medical_records', pg_temp.ea('6', 1), '{"title":"Synthetic changed history"}'))));
select pg_temp.import_record('the import command pins its search path, time zone and per-call plans',
  '{"search_path=pg_catalog, pg_temp",TimeZone=UTC,plan_cache_mode=force_custom_plan}',
  (select proconfig::text from pg_proc where oid = 'ehr.import_legacy_medical_history(uuid,uuid,text,jsonb)'::regprocedure));

-- 4. The import's time grows linearly with the versions: 4 times the versions
--    take well under 8 times as long (a check per version over all versions
--    takes about 16 times as long).
create function pg_temp.scaled_history(n integer, records integer) returns text
language plpgsql as $$
declare
  prefix text := 'ea6' || n;
begin
  return pg_temp.history(n, (
    select jsonb_agg(item) from (
      select pg_temp.staged('medical_records', jsonb_build_object('id', prefix || lpad(to_hex(r), 3, '0') || '-0000-4000-8000-000000000000',
        'patient_id', pg_temp.ea('2', 1), 'current_version_id', prefix || lpad(to_hex(r), 3, '0') || '-0000-4000-8000-000000000004',
        'title', 'Synthetic scaled history', 'category', 'history', 'info_type', 'text',
        'created_by_user_profile_id', pg_temp.ea('3', 1), 'created_by_staff_account_id', null,
        'created_at', '2025-04-01T08:00:00Z', 'updated_at', '2025-04-01T08:00:00Z')) item
        from generate_series(1, records) r
      union all
      select pg_temp.staged('medical_record_versions', jsonb_build_object(
        'id', prefix || lpad(to_hex(r), 3, '0') || '-0000-4000-8000-00000000000' || v,
        'record_id', prefix || lpad(to_hex(r), 3, '0') || '-0000-4000-8000-000000000000', 'version_no', v,
        'created_by_user_profile_id', pg_temp.ea('3', 1), 'created_by_staff_account_id', null,
        'record', 'Invented scaled content', 'created_at', '2025-04-01T08:0' || v || ':00Z'))
        from generate_series(1, records) r, generate_series(1, 4) v) items));
end
$$;
-- As on a new database, where autovacuum analyzes the imported tables
-- while they are empty: a plan cached for an empty table must not decide how
-- every later row is read. (ANALYZE's relpages and reltuples outlive the
-- rollback, as autovacuum's would.)
analyze ehr.imported_medical_records, ehr.imported_medical_record_versions, ehr.imported_medical_record_files;
do $$
declare
  small_run text := pg_temp.scaled_history(80, 400);
  large_run text := pg_temp.scaled_history(81, 1600);
  started timestamptz;
  small_ms double precision;
  large_ms double precision;
  small_result text;
  large_result text;
  scans_before bigint;
  scans bigint;
begin
  started := clock_timestamp();
  small_result := pg_temp.import_apply(pg_temp.ea('5', 1), small_run);
  small_ms := extract(epoch from clock_timestamp() - started) * 1000;
  scans_before := (select coalesce(sum(seq_scan), 0) from pg_stat_xact_user_tables
                     where relid in ('ehr.imported_medical_records'::regclass,
                       'ehr.imported_medical_record_versions'::regclass, 'ehr.imported_medical_record_files'::regclass));
  started := clock_timestamp();
  large_result := pg_temp.import_apply(pg_temp.ea('5', 1), large_run);
  large_ms := extract(epoch from clock_timestamp() - started) * 1000;
  -- Each stored row is read by its key, whatever plan was cached while the
  -- tables were small: a sequential scan per row makes the import quadratic.
  scans := (select coalesce(sum(seq_scan), 0) from pg_stat_xact_user_tables
              where relid in ('ehr.imported_medical_records'::regclass,
                'ehr.imported_medical_record_versions'::regclass, 'ehr.imported_medical_record_files'::regclass))
           - scans_before;
  perform pg_temp.import_record('the import reads stored rows by key, not by a scan per row', 'true',
    (scans < 10)::text);
  perform pg_temp.import_record('scaled imports insert every row', '400,1600,0|1600,6400,0',
    small_result || '|' || large_result);
  perform pg_temp.import_record('4 times the versions take under 8 times as long', 'true',
    (large_ms < 8 * greatest(small_ms, 25))::text);
  raise notice 'imported history import: 1600 versions in % ms, 6400 versions in % ms (% sequential scans)',
    round(small_ms::numeric), round(large_ms::numeric), scans;
end $$;

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by name)
    into failures from import_case_results where expected is distinct from actual;
  if failures is not null then
    raise exception E'imported history import cases differ from the rules:\n%', failures;
  end if;
  if (select count(*) from import_case_results) < 60 then
    raise exception 'imported history import suite recorded only % cases', (select count(*) from import_case_results);
  end if;
end $$;
rollback;
