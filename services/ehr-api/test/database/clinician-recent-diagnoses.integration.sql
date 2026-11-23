\set ON_ERROR_STOP on
-- 0151 (ORD-9): recent diagnoses. Rollback-only.
--   1. a doctor's picks are recorded in the session's membership and
--      facility, newest first, with a count; the same pick again updates
--      its display, time and count; no code records nothing; a member
--      without ehr.diagnosis.write records and reads nothing;
--   2. the same account at another facility (another membership) sees its
--      own picks only; no session, a malformed one, or a membership
--      presented at another facility reads and records nothing;
--   3. at most 200 per membership, the oldest dropping off; limit 1-50;
--   4. the table is the owner's only: the EHR runtime runs the functions
--      and reads no row; no patient id is held.
-- Every record and every read through ehr.recent_diagnoses (pg_temp.recent
-- and case 3c) runs as the EHR runtime (set local role hid_ehr_runtime ...
-- reset role); only the direct counts of the table run as its owner. The
-- concurrency of the record (it never waits; a save that finds the
-- membership's recording lock taken skips its record) needs two sessions
-- and is proven outside this suite; 1c checks the lock is taken.
-- Synthetic values only: uuid prefix 151, example.invalid addresses.
set plpgsql.variable_conflict = error;
begin;

create temporary table recent_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on recent_cases to public;
grant usage on sequence recent_cases_seq_seq to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language sql as $$
  insert into recent_cases (name, expected, actual) values (case_name, expected, coalesce(actual, 'null'));
$$;
grant execute on function pg_temp.expect(text, text, text) to public;
create function pg_temp.refusal(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'none';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.refusal(text) to public;
create function pg_temp.as_member(subject text, membership text, facility text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.membership_id', membership, true),
         set_config('app.facility_id', facility, true);
$$;
grant execute on function pg_temp.as_member(text, text, text) to public;
create function pg_temp.recent(lim integer default 10) returns text language sql as $$
  select coalesce(string_agg(format('%s:%s(%s)x%s', recent.code_system, recent.code, recent.display, recent.use_count),
    ' ' order by ordinality), '')
    from ehr.recent_diagnoses(lim) with ordinality as recent;
$$;
grant execute on function pg_temp.recent(integer) to public;

insert into auth.accounts (id, subject, email, display_name, status, source_system) values
  ('15100000-0000-4000-8000-000000000001', 'staff:151-doctor', '151-doctor@example.invalid', 'Recent Doctor', 'active', 'hid'),
  ('15100000-0000-4000-8000-000000000002', 'staff:151-pharmacist', '151-pharm@example.invalid', 'Recent Pharmacist',
   'active', 'hid');
insert into identity.organizations (id, name, slug) values
  ('15100000-0000-4000-8000-000000000011', 'Recent Diagnoses Test Org', '151-recent-diagnoses-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('15100000-0000-4000-8000-000000000021', '15100000-0000-4000-8000-000000000011', 'Recent Test Hospital', '151-H',
   'Africa/Lagos', true, 'verified'),
  ('15100000-0000-4000-8000-000000000022', '15100000-0000-4000-8000-000000000011', 'Recent Other Clinic', '151-C',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('15100000-0000-4000-8000-000000000031', '15100000-0000-4000-8000-000000000001', 'Recent Doctor',
   '151-doctor@example.invalid', 'verified', 'doctor'),
  ('15100000-0000-4000-8000-000000000032', '15100000-0000-4000-8000-000000000002', 'Recent Pharmacist',
   '151-pharm@example.invalid', 'verified', 'pharmacist');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('15100000-0000-4000-8000-000000000041', '15100000-0000-4000-8000-000000000031', '15100000-0000-4000-8000-000000000001',
   '15100000-0000-4000-8000-000000000011', '15100000-0000-4000-8000-000000000021', 'doctor', 'doctor', true, true),
  ('15100000-0000-4000-8000-000000000042', '15100000-0000-4000-8000-000000000031', '15100000-0000-4000-8000-000000000001',
   '15100000-0000-4000-8000-000000000011', '15100000-0000-4000-8000-000000000022', 'doctor', 'doctor', false, true),
  ('15100000-0000-4000-8000-000000000043', '15100000-0000-4000-8000-000000000032', '15100000-0000-4000-8000-000000000002',
   '15100000-0000-4000-8000-000000000011', '15100000-0000-4000-8000-000000000021', 'pharmacist', 'pharmacist', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('15100000-0000-4000-8000-000000000051', '15100000-0000-4000-8000-000000000001', 'doctor', 'facility',
   '15100000-0000-4000-8000-000000000041', '15100000-0000-4000-8000-000000000021', 'Synthetic recent diagnoses test'),
  ('15100000-0000-4000-8000-000000000052', '15100000-0000-4000-8000-000000000001', 'doctor', 'facility',
   '15100000-0000-4000-8000-000000000042', '15100000-0000-4000-8000-000000000022', 'Synthetic recent diagnoses test'),
  ('15100000-0000-4000-8000-000000000053', '15100000-0000-4000-8000-000000000002', 'pharmacist', 'facility',
   '15100000-0000-4000-8000-000000000043', '15100000-0000-4000-8000-000000000021', 'Synthetic recent diagnoses test');

-- 1. A doctor's picks.
select pg_temp.as_member('staff:151-doctor', '15100000-0000-4000-8000-000000000041', '15100000-0000-4000-8000-000000000021');
set local role hid_ehr_runtime;
select ehr.record_recent_diagnosis('ICD-11', '1F40', 'Malaria due to Plasmodium falciparum');
select pg_sleep(0.01);
select ehr.record_recent_diagnosis('ICD-10', 'A01.0', 'Typhoid fever');
select pg_temp.expect('1a picks are recorded, newest first, any code system', 'ICD-10:A01.0(Typhoid fever)x1 '
  || 'ICD-11:1F40(Malaria due to Plasmodium falciparum)x1', pg_temp.recent());
select pg_sleep(0.01);
select ehr.record_recent_diagnosis('ICD-11', '1F40', 'Falciparum malaria');
select ehr.record_recent_diagnosis(null, null, 'Fever, cause not yet known');
select ehr.record_recent_diagnosis('ICD-11', '', 'blank code');
select pg_temp.expect('1b the same pick again moves it first with its new display and count; no code records nothing',
  'ICD-11:1F40(Falciparum malaria)x2 ICD-10:A01.0(Typhoid fever)x1', pg_temp.recent());
reset role;
select pg_temp.expect('1c the rows hold the membership and facility, never a patient; the record holds the '
  || 'membership''s recording lock (advisory, class key 7409) to the end of the transaction', '2|2|false|1',
  (select count(*) from ehr.clinician_recent_diagnoses where membership_id = '15100000-0000-4000-8000-000000000041'
     and facility_id = '15100000-0000-4000-8000-000000000021') || '|'
  || (select count(*) from ehr.clinician_recent_diagnoses) || '|'
  || exists (select 1 from information_schema.columns where table_schema = 'ehr'
              and table_name = 'clinician_recent_diagnoses' and column_name like '%patient%')::text || '|'
  || (select count(*) from pg_locks lock_row
       where lock_row.locktype = 'advisory' and lock_row.pid = pg_backend_pid() and lock_row.granted
         and lock_row.mode = 'ExclusiveLock' and lock_row.classid = 7409 and lock_row.objsubid = 2
         and lock_row.objid::bigint = (hashtext('15100000-0000-4000-8000-000000000041')::bigint & 4294967295)));
select pg_temp.as_member('staff:151-pharmacist', '15100000-0000-4000-8000-000000000043', '15100000-0000-4000-8000-000000000021');
set local role hid_ehr_runtime;
select ehr.record_recent_diagnosis('ICD-11', '1A07', 'Typhoid fever');
select set_config('recent_suite.read', pg_temp.recent(), true);
reset role;
select pg_temp.expect('1d a member without ehr.diagnosis.write records and reads nothing', '|2',
  current_setting('recent_suite.read') || '|' || (select count(*) from ehr.clinician_recent_diagnoses));
select pg_temp.as_member('staff:151-pharmacist', '15100000-0000-4000-8000-000000000041', '15100000-0000-4000-8000-000000000021');
set local role hid_ehr_runtime;
select pg_temp.expect('1e another account''s membership in the session reads nothing', '', pg_temp.recent());
reset role;

-- 2. Another facility, no session.
select pg_temp.as_member('staff:151-doctor', '15100000-0000-4000-8000-000000000042', '15100000-0000-4000-8000-000000000022');
set local role hid_ehr_runtime;
select pg_temp.expect('2a the same account at another facility sees its own picks only', '', pg_temp.recent());
select ehr.record_recent_diagnosis('ICD-11', 'BA00', 'Essential hypertension');
select pg_temp.expect('2b ... and records there', 'ICD-11:BA00(Essential hypertension)x1', pg_temp.recent());
select pg_temp.as_member('', '', '');
select pg_temp.expect('2c no session reads nothing', '', pg_temp.recent());
select pg_temp.as_member('staff:151-doctor', 'not-a-uuid', 'x');
select ehr.record_recent_diagnosis('ICD-11', '1A07', 'Typhoid fever');
select set_config('recent_suite.read', pg_temp.recent(), true);
reset role;
select pg_temp.expect('2d a malformed session reads and records nothing', '|3',
  current_setting('recent_suite.read') || '|' || (select count(*) from ehr.clinician_recent_diagnoses));
select pg_temp.as_member('staff:151-doctor', '15100000-0000-4000-8000-000000000041', '15100000-0000-4000-8000-000000000022');
set local role hid_ehr_runtime;
select ehr.record_recent_diagnosis('ICD-11', '1A07', 'Typhoid fever');
select set_config('recent_suite.read', pg_temp.recent(), true);
reset role;
select pg_temp.expect('2e a membership presented at another facility reads and records nothing', '|3',
  current_setting('recent_suite.read') || '|' || (select count(*) from ehr.clinician_recent_diagnoses));

-- 3. Limits.
select pg_temp.as_member('staff:151-doctor', '15100000-0000-4000-8000-000000000041', '15100000-0000-4000-8000-000000000021');
set local role hid_ehr_runtime;
select ehr.record_recent_diagnosis('ICD-11', format('9A%s', lpad(serial::text, 3, '0')), format('Synthetic %s', serial))
  from generate_series(0, 204) as serial;
reset role;
select pg_temp.expect('3a at most 200 per membership; the oldest dropped', '200|false|true',
  (select count(*) from ehr.clinician_recent_diagnoses where membership_id = '15100000-0000-4000-8000-000000000041')
  || '|' || exists (select 1 from ehr.clinician_recent_diagnoses where code = '1F40'
                     and membership_id = '15100000-0000-4000-8000-000000000041')::text
  || '|' || exists (select 1 from ehr.clinician_recent_diagnoses where code = '9A204')::text);
select pg_temp.expect('3b the other membership kept its own', '1',
  (select count(*)::text from ehr.clinician_recent_diagnoses where membership_id = '15100000-0000-4000-8000-000000000042'));
set local role hid_ehr_runtime;
select pg_temp.expect('3c limit 1-50', '22023 RECENT_DIAGNOSES_INVALID|22023 RECENT_DIAGNOSES_INVALID|1|50',
  pg_temp.refusal('select * from ehr.recent_diagnoses(0)') || '|' || pg_temp.refusal('select * from ehr.recent_diagnoses(51)')
  || '|' || (select count(*) from ehr.recent_diagnoses(1)) || '|' || (select count(*) from ehr.recent_diagnoses(50)));
reset role;

-- 4. As the EHR runtime: the functions run; the table does not answer.
set local role hid_ehr_runtime;
select pg_temp.expect('4a the EHR runtime reads no row of the table', '42501',
  left(pg_temp.refusal('select count(*) from ehr.clinician_recent_diagnoses'), 5));
reset role;
select pg_temp.expect('4b the functions are the EHR runtime''s, not the pharmacy runtime''s', 'true true false',
  has_function_privilege('hid_ehr_runtime', 'ehr.record_recent_diagnosis(text,text,text)', 'EXECUTE') || ' '
  || has_function_privilege('hid_ehr_runtime', 'ehr.recent_diagnoses(integer)', 'EXECUTE') || ' '
  || has_function_privilege('hid_pharmacy_runtime', 'ehr.recent_diagnoses(integer)', 'EXECUTE'));

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, actual), E'\n' order by seq) into failures
    from recent_cases where expected is distinct from actual;
  if failures is not null then
    raise exception E'0151 recent diagnoses suite failed:\n%', failures;
  end if;
  raise notice '0151 recent diagnoses suite: % cases passed', (select count(*) from recent_cases);
end $$;
rollback;
