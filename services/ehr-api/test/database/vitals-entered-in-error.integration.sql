\set ON_ERROR_STOP on
-- 0142 (EHR-C8b): one vitals reading marked entered in error, for good.
-- Rollback-only. Synthetic values only; uuid prefix f142; .invalid addresses.
--   1. structure: the two columns and their CHECKs, the partial index for the
--      latest recorded reading, the guard (plpgsql, SECURITY INVOKER,
--      search_path pg_catalog, pg_temp; before insert and update; before
--      vitals_versioned), the patient's own read, four policies;
--   2. the guard, under a staff context: a new reading is recorded; a new
--      reading entered in error or with a status time is refused (23514); a
--      correction of a recorded reading still works; the mark needs a change
--      reason (0004's 22023) and changes nothing else (23514); the mark sets
--      the status time and keeps who, why and the prior row in
--      ehr.record_versions; a status time alone is refused; after the mark,
--      any update (back to recorded, a correction, a no-op) is refused
--      (55000) and a delete still is;
--   3. as the EHR runtime in the patient's own context: the recorded reading
--      of a completed visit is read, the entered-in-error one and its
--      corrections are not.
set plpgsql.variable_conflict = error;
begin;

insert into identity.organizations (id, name, slug, active) values
  ('f1420000-0000-4000-8000-0000000000a1', 'Vitals Error Org', 'vitals-error-org-f142', true);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f1421000-0000-4000-8000-0000000000f1', 'f1420000-0000-4000-8000-0000000000a1', 'Vitals Error Alpha', 'VEF-F1', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm, token_version) values
  ('f1422000-0000-4000-8000-00000000000a', 'synthetic:vitals-0142:nurse', 'nurse@vitals-0142.invalid', 'active', 'synthetic-hash', 'argon2id', 1),
  ('f1422000-0000-4000-8000-0000000000e0', 'synthetic:vitals-0142:patient', 'patient@vitals-0142.invalid', 'active', 'synthetic-hash', 'argon2id', 1);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values
  ('f1424000-0000-4000-8000-00000000000a', 'f1422000-0000-4000-8000-00000000000a', 'Nurse Vitals', 'nurse@vitals-0142.invalid', 'verified', 'nurse', true);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active) values
  ('f1425000-0000-4000-8000-0000000000a1', 'f1424000-0000-4000-8000-00000000000a', 'f1422000-0000-4000-8000-00000000000a',
   'f1420000-0000-4000-8000-0000000000a1', 'f1421000-0000-4000-8000-0000000000f1', 'nurse', 'nurse', true, true);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, status, account_id) values
  ('f1427000-0000-4000-8000-000000000001', 'HID-QVE2B3', 'Chidi', 'Vitals', 'Chidi Vitals', '1988-03-03', 'active',
   'f1422000-0000-4000-8000-0000000000e0');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
values ('f1426000-0000-4000-8000-0000000000e1', 'f1422000-0000-4000-8000-0000000000e0',
  'f1426000-0000-4000-8000-0000000000e1', md5('f142-e1') || md5('f142-e1-refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '8 hours', now() + interval '24 hours', 'patient', 'f1427000-0000-4000-8000-000000000001');
-- The nurse may write the patient's records here (the version rows' policy asks).
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id) values
  ('f142b000-0000-4000-8000-000000000001', 'f1427000-0000-4000-8000-000000000001',
   'f1424000-0000-4000-8000-00000000000a', 'f1422000-0000-4000-8000-00000000000a',
   'f1425000-0000-4000-8000-0000000000a1', 'f1421000-0000-4000-8000-0000000000f1',
   'write_records', 'direct-care', 'active', 'Synthetic vitals grant', now() - interval '1 minute',
   now() + interval '1 hour', false, 'vitals-0142-grant');

-- The nurse's context, as ehr-api sets it for a write.
select set_config('app.actor_subject', 'synthetic:vitals-0142:nurse', true),
  set_config('app.membership_id', 'f1425000-0000-4000-8000-0000000000a1', true),
  set_config('app.facility_id', 'f1421000-0000-4000-8000-0000000000f1', true),
  set_config('app.purpose_of_use', 'direct-care', true),
  set_config('app.correlation_id', 'vitals-0142-suite', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at, ended_at) values
  ('f1428000-0000-4000-8000-000000000001', 'f1427000-0000-4000-8000-000000000001', 'f1421000-0000-4000-8000-0000000000f1',
   'f1422000-0000-4000-8000-00000000000a', 'f1425000-0000-4000-8000-0000000000a1', 'ambulatory', 'completed',
   now() - interval '2 hours', now() - interval '1 hour');
-- V1 stays recorded; V2 is marked entered in error.
insert into ehr.vitals (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at,
  pulse_bpm, systolic_mmhg, diastolic_mmhg) values
  ('f1429000-0000-4000-8000-000000000001', 'f1428000-0000-4000-8000-000000000001', 'f1427000-0000-4000-8000-000000000001',
   'f1421000-0000-4000-8000-0000000000f1', 'f1422000-0000-4000-8000-00000000000a', 'f1425000-0000-4000-8000-0000000000a1',
   now() - interval '100 minutes', 72, 120, 80),
  ('f1429000-0000-4000-8000-000000000002', 'f1428000-0000-4000-8000-000000000001', 'f1427000-0000-4000-8000-000000000001',
   'f1421000-0000-4000-8000-0000000000f1', 'f1422000-0000-4000-8000-00000000000a', 'f1425000-0000-4000-8000-0000000000a1',
   now() - interval '90 minutes', 140, 180, 110);

create temporary table vital_outcomes (seq serial, name text primary key, expected text not null, actual text) on commit drop;
grant select, insert on pg_temp.vital_outcomes to hid_ehr_api_runtime;
grant usage on sequence pg_temp.vital_outcomes_seq_seq to hid_ehr_api_runtime;
create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.vital_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
-- One statement in its own subtransaction: 'ok', or its SQLSTATE and message.
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

-- 1. Structure.
select pg_temp.check_case('1 the two columns', 'status text! default recorded,status_changed_at timestamp with time zone',
  (select string_agg(attname || ' ' || format_type(atttypid, atttypmod) || case when attnotnull then '!' else '' end
       || coalesce(' default ' || nullif(regexp_replace(pg_get_expr(adbin, adrelid), '''(\w+)''::text', '\1'), ''), ''),
       ',' order by attnum)
     from pg_attribute left join pg_attrdef on adrelid = attrelid and adnum = attnum
    where attrelid = 'ehr.vitals'::regclass and attname in ('status', 'status_changed_at') and not attisdropped));
select pg_temp.check_case('1 the CHECKs', 'vitals_status_ck,vitals_status_shape_ck',
  (select string_agg(conname, ',' order by conname) from pg_constraint
    where conrelid = 'ehr.vitals'::regclass and conname like 'vitals_status%'));
select pg_temp.check_case('1 the latest-reading index leaves out withdrawn readings',
  'CREATE INDEX vitals_latest_recorded_idx ON ehr.vitals USING btree (patient_id, facility_id, recorded_at DESC, created_at DESC, id DESC) WHERE (status = ''recorded''::text)',
  pg_get_indexdef('ehr.vitals_latest_recorded_idx'::regclass));
select pg_temp.check_case('1 the guard', 'plpgsql/f/{"search_path=pg_catalog, pg_temp"}/insert,update',
  (select format('%s/%s/%s/%s', language.lanname, proc.prosecdef, proc.proconfig,
       (select string_agg(event, ',' order by event) from (values
          (case when trigger_row.tgtype & 4 <> 0 then 'insert' end),
          (case when trigger_row.tgtype & 8 <> 0 then 'delete' end),
          (case when trigger_row.tgtype & 16 <> 0 then 'update' end)) events(event) where event is not null))
     from pg_trigger trigger_row
     join pg_proc proc on proc.oid = trigger_row.tgfoid
     join pg_language language on language.oid = proc.prolang
    where trigger_row.tgrelid = 'ehr.vitals'::regclass and trigger_row.tgname = 'vitals_status_guard'));
select pg_temp.check_case('1 the guard fires before the version trigger', 'vitals_no_delete,vitals_status_guard,vitals_versioned',
  (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'ehr.vitals'::regclass and not tgisinternal));
select pg_temp.check_case('1 nobody may run the guard directly', '(null)',
  (select string_agg(grantee::regrole::text, ',') from pg_proc, aclexplode(proacl)
    where oid = 'ehr.guard_vital_status()'::regprocedure and privilege_type = 'EXECUTE' and grantee <> proowner));
select pg_temp.check_case('1 four policies; the patient''s own read needs recorded', '4/t',
  (select format('%s/%s', count(*), bool_or(polname = 'vitals_patient_self_read'
       and pg_get_expr(polqual, polrelid) like '%(status = ''recorded''::text)%'))
     from pg_policy where polrelid = 'ehr.vitals'::regclass));

-- 2. The guard.
select pg_temp.check_case('2 a new reading is recorded', 'recorded/(null)',
  (select status || '/' || coalesce(status_changed_at::text, '(null)') from ehr.vitals
    where id = 'f1429000-0000-4000-8000-000000000001'));
select pg_temp.check_case('2 a new reading entered in error', '23514 VITAL_STATUS_INVALID', pg_temp.try($s$
  insert into ehr.vitals (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at,
    pulse_bpm, status, status_changed_at)
  values ('f1428000-0000-4000-8000-000000000001', 'f1427000-0000-4000-8000-000000000001',
    'f1421000-0000-4000-8000-0000000000f1', 'f1422000-0000-4000-8000-00000000000a',
    'f1425000-0000-4000-8000-0000000000a1', now(), 70, 'entered_in_error', now())$s$));
select pg_temp.check_case('2 a new reading with a status time', '23514 VITAL_STATUS_INVALID', pg_temp.try($s$
  insert into ehr.vitals (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at,
    pulse_bpm, status_changed_at)
  values ('f1428000-0000-4000-8000-000000000001', 'f1427000-0000-4000-8000-000000000001',
    'f1421000-0000-4000-8000-0000000000f1', 'f1422000-0000-4000-8000-00000000000a',
    'f1425000-0000-4000-8000-0000000000a1', now(), 70, now())$s$));
select set_config('app.change_reason', 'Synthetic correction', true);
insert into ehr.vital_corrections (vital_id, patient_id, facility_id, correction_no, replacement_values, reason,
  created_by, created_by_membership_id)
values ('f1429000-0000-4000-8000-000000000002', 'f1427000-0000-4000-8000-000000000001', 'f1421000-0000-4000-8000-0000000000f1',
  1, '{"pulse_bpm": 104}'::jsonb, 'Synthetic correction', 'f1422000-0000-4000-8000-00000000000a',
  'f1425000-0000-4000-8000-0000000000a1');
select pg_temp.check_case('2 a correction of a recorded reading still works', 'ok', pg_temp.try($s$
  update ehr.vitals set current_correction_no = 1 where id = 'f1429000-0000-4000-8000-000000000002'$s$));
select set_config('app.change_reason', '', true);
select pg_temp.check_case('2 the mark needs a change reason', '22023 A change reason is required for clinical updates', pg_temp.try($s$
  update ehr.vitals set status = 'entered_in_error' where id = 'f1429000-0000-4000-8000-000000000002'$s$));
select set_config('app.change_reason', 'Recorded on the wrong patient', true);
select pg_temp.check_case('2 the mark changes nothing else', '23514 VITAL_STATUS_INVALID', pg_temp.try($s$
  update ehr.vitals set status = 'entered_in_error', pulse_bpm = 60 where id = 'f1429000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 a status time alone', '23514 VITAL_STATUS_INVALID', pg_temp.try($s$
  update ehr.vitals set status_changed_at = now() where id = 'f1429000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 no other status', '23514 VITAL_STATUS_INVALID', pg_temp.try($s$
  update ehr.vitals set status = 'withdrawn' where id = 'f1429000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 the mark', 'ok', pg_temp.try($s$
  update ehr.vitals set status = 'entered_in_error' where id = 'f1429000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 marked, with its time, version 3', 'entered_in_error/t/3',
  (select format('%s/%s/%s', status, status_changed_at is not null, row_version) from ehr.vitals
    where id = 'f1429000-0000-4000-8000-000000000002'));
select pg_temp.check_case('2 who, why and the prior row are kept', 'update/Recorded on the wrong patient/recorded/entered_in_error/f1422000-0000-4000-8000-00000000000a',
  (select format('%s/%s/%s/%s/%s', operation, change_reason, prior_state->>'status', resulting_state->>'status', changed_by)
     from ehr.record_versions where resource_type = 'vitals' and resource_id = 'f1429000-0000-4000-8000-000000000002'
      and version_no = 3));
select pg_temp.check_case('2 it cannot be undone', '55000 VITAL_ENTERED_IN_ERROR', pg_temp.try($s$
  update ehr.vitals set status = 'recorded', status_changed_at = null where id = 'f1429000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 it cannot be corrected', '55000 VITAL_ENTERED_IN_ERROR', pg_temp.try($s$
  update ehr.vitals set current_correction_no = 2 where id = 'f1429000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 it cannot be marked twice', '55000 VITAL_ENTERED_IN_ERROR', pg_temp.try($s$
  update ehr.vitals set status = 'entered_in_error' where id = 'f1429000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 it still cannot be deleted', 'false', (select (pg_temp.try($s$
  delete from ehr.vitals where id = 'f1429000-0000-4000-8000-000000000002'$s$) = 'ok')::text));
select pg_temp.check_case('2 the other reading is untouched', 'recorded/1',
  (select status || '/' || row_version from ehr.vitals where id = 'f1429000-0000-4000-8000-000000000001'));

-- 3. The patient's own read.
select set_config('app.actor_subject', 'synthetic:vitals-0142:patient', true),
  set_config('app.account_id', 'f1422000-0000-4000-8000-0000000000e0', true),
  set_config('app.session_id', 'f1426000-0000-4000-8000-0000000000e1', true),
  set_config('app.patient_id', 'f1427000-0000-4000-8000-000000000001', true),
  set_config('app.self_authorized_until', (now() + interval '5 minutes')::text, true),
  set_config('app.purpose_of_use', 'patient-self', true),
  set_config('app.membership_id', '', true),
  set_config('app.facility_id', '', true);
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 the patient reads the recorded reading only', 'f1429000-0000-4000-8000-000000000001',
  (select string_agg(id::text, ',' order by id) from ehr.vitals where patient_id = 'f1427000-0000-4000-8000-000000000001'));
select pg_temp.check_case('3 and none of the withdrawn reading''s corrections', '0',
  (select count(*)::text from ehr.vital_corrections where vital_id = 'f1429000-0000-4000-8000-000000000002'));
reset role;

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.vital_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0142 vitals entered in error:\n%', mismatch;
  end if;
  raise notice '0142 vitals entered in error: % cases passed', (select count(*) from pg_temp.vital_outcomes);
end $$;

rollback;
