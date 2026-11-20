\set ON_ERROR_STOP on
-- 0140 (SX-8): the open patient a staff sign-in keeps across a reload.
-- Rollback-only. The writes run as the Identity API's runtime role, as the
-- API makes them. 0129's suite covers the admission rule this table's guard
-- reuses unchanged (every way a sign-in or membership is not live); this one
-- covers what 0140 adds. Synthetic values only; uuid prefix f140; .invalid
-- addresses.
--
--   1. structure: columns, primary key, the five foreign keys (all ON DELETE
--      RESTRICT: the sign-in, the account, the facility, the patient, and
--      the membership by (id, facility_id, account_id)), the purpose and
--      8-hour CHECKs, no row-level security; the guard is plpgsql, SECURITY
--      INVOKER, search_path pg_catalog, pg_temp, and fires before every row
--      insert and update (not delete);
--   2. privileges: the Identity runtime and its API login select, insert,
--      update and delete; PUBLIC, the EHR runtime and the schema test
--      runtime hold nothing;
--   3. as the Identity API runtime: a set (the upsert keyed by family) is
--      kept and replaced; a clear deletes it; a set for a patient sign-in,
--      a signed-out sign-in, a session that is not the family's first, an
--      ended membership or another facility's membership is refused (23514
--      or 23503); a set longer than 8 hours, with another purpose, or for no
--      such patient is refused (23514, 23503); an update cannot move a row
--      to another sign-in (55000).
set plpgsql.variable_conflict = error;
begin;

insert into identity.organizations (id, name, slug, active) values
  ('f1400000-0000-4000-8000-0000000000a1', 'Open Patient Org', 'open-patient-org-f140', true);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f1401000-0000-4000-8000-0000000000f1', 'f1400000-0000-4000-8000-0000000000a1', 'Open Patient Alpha', 'OPF-F1', 'Africa/Lagos', true, 'verified'),
  ('f1401000-0000-4000-8000-0000000000f2', 'f1400000-0000-4000-8000-0000000000a1', 'Open Patient Beta', 'OPF-F2', 'Africa/Lagos', true, 'verified');
-- A: staff at F1 (and an ended membership at F2). B: staff at F2. P: a patient.
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm, token_version) values
  ('f1402000-0000-4000-8000-00000000000a', 'synthetic:open-patient-0140:a', 'a@open-patient-0140.invalid', 'active', 'synthetic-hash', 'argon2id', 1),
  ('f1402000-0000-4000-8000-00000000000b', 'synthetic:open-patient-0140:b', 'b@open-patient-0140.invalid', 'active', 'synthetic-hash', 'argon2id', 1),
  ('f1402000-0000-4000-8000-0000000000e0', 'synthetic:open-patient-0140:p', 'p@open-patient-0140.invalid', 'active', 'synthetic-hash', 'argon2id', 1);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values
  ('f1404000-0000-4000-8000-00000000000a', 'f1402000-0000-4000-8000-00000000000a', 'Staff A Open', 'a@open-patient-0140.invalid', 'verified', 'doctor', true),
  ('f1404000-0000-4000-8000-00000000000b', 'f1402000-0000-4000-8000-00000000000b', 'Staff B Open', 'b@open-patient-0140.invalid', 'verified', 'doctor', true);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active) values
  ('f1405000-0000-4000-8000-0000000000a1', 'f1404000-0000-4000-8000-00000000000a', 'f1402000-0000-4000-8000-00000000000a',
   'f1400000-0000-4000-8000-0000000000a1', 'f1401000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true),
  ('f1405000-0000-4000-8000-0000000000a2', 'f1404000-0000-4000-8000-00000000000a', 'f1402000-0000-4000-8000-00000000000a',
   'f1400000-0000-4000-8000-0000000000a1', 'f1401000-0000-4000-8000-0000000000f2', 'doctor', 'doctor', false, false),
  ('f1405000-0000-4000-8000-0000000000b2', 'f1404000-0000-4000-8000-00000000000b', 'f1402000-0000-4000-8000-00000000000b',
   'f1400000-0000-4000-8000-0000000000a1', 'f1401000-0000-4000-8000-0000000000f2', 'doctor', 'doctor', true, true);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, status, account_id) values
  ('f1407000-0000-4000-8000-000000000001', 'HID-QPA2B3', 'Amaka', 'Open', 'Amaka Open', '1990-05-01', 'active', 'f1402000-0000-4000-8000-0000000000e0'),
  ('f1407000-0000-4000-8000-000000000002', 'HID-QPC4D5', 'Bayo', 'Open', 'Bayo Open', '1985-02-02', 'active', null);
-- Sessions: a1 A's live staff sign-in (and a1b, a later session of it); a9 A's signed-out sign-in;
-- b1 B's live staff sign-in; p1 P's patient sign-in.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, revoked_at, revocation_reason, session_kind, patient_id)
select fixture.id::uuid, fixture.account::uuid, fixture.family::uuid, md5(fixture.id) || md5(fixture.id || 'refresh'),
  gen_random_uuid(), 1, 'password', now(), now() + interval '8 hours', now() + interval '24 hours',
  fixture.revoked, case when fixture.revoked is not null then 'logout' end, fixture.kind, fixture.patient::uuid
from (values
  ('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a', 'f1406000-0000-4000-8000-0000000000a1', null::timestamptz, 'staff', null),
  ('f1406000-0000-4000-8000-0000000000a9', 'f1402000-0000-4000-8000-00000000000a', 'f1406000-0000-4000-8000-0000000000a9', now() - interval '1 minute', 'staff', null),
  ('f1406000-0000-4000-8000-0000000000b1', 'f1402000-0000-4000-8000-00000000000b', 'f1406000-0000-4000-8000-0000000000b1', null, 'staff', null),
  ('f1406000-0000-4000-8000-0000000000e1', 'f1402000-0000-4000-8000-0000000000e0', 'f1406000-0000-4000-8000-0000000000e1', null, 'patient',
   'f1407000-0000-4000-8000-000000000001')
) fixture(id, account, family, revoked, kind, patient);
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
values ('f1406000-0000-4000-8000-0000000000a2', 'f1402000-0000-4000-8000-00000000000a',
  'f1406000-0000-4000-8000-0000000000a1', md5('f140-a2') || md5('f140-a2-refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '8 hours', now() + interval '24 hours', 'staff');

create temporary table open_outcomes (seq serial, name text primary key, expected text not null, actual text) on commit drop;
grant select, insert on pg_temp.open_outcomes to hid_identity_api_runtime;
grant usage on sequence pg_temp.open_outcomes_seq_seq to hid_identity_api_runtime;
create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.open_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
-- The API's set: the upsert keyed by the family, as TokenService writes it.
create function pg_temp.set_open(family uuid, account uuid, facility uuid, membership uuid, patient uuid,
  purpose text default 'direct-care', hours interval default interval '8 hours') returns text language plpgsql as $f$
begin
  insert into auth.session_open_patient (family_id, account_id, facility_id, membership_id, patient_id, purpose, expires_at)
  values (family, account, facility, membership, patient, purpose, clock_timestamp() + hours)
  on conflict (family_id) do update
     set facility_id = excluded.facility_id, membership_id = excluded.membership_id,
         patient_id = excluded.patient_id, purpose = excluded.purpose, set_at = clock_timestamp(),
         expires_at = excluded.expires_at, row_version = auth.session_open_patient.row_version + 1;
  return 'kept';
exception when others then
  return sqlstate;
end
$f$;

-- 1. Structure.
select pg_temp.check_case('1 columns',
  'family_id uuid!,account_id uuid!,facility_id uuid!,membership_id uuid!,patient_id uuid!,purpose text!,set_at timestamp with time zone!,expires_at timestamp with time zone!,row_version bigint!',
  (select string_agg(attname || ' ' || format_type(atttypid, atttypmod) || case when attnotnull then '!' else '' end, ',' order by attnum)
     from pg_attribute where attrelid = 'auth.session_open_patient'::regclass and attnum > 0 and not attisdropped));
select pg_temp.check_case('1 foreign keys, all restrict',
  'auth.accounts(account_id)/r|auth.sessions(family_id)/r|identity.facilities(facility_id)/r|identity.patients(patient_id)/r|identity.staff_facility_memberships(membership_id,facility_id,account_id)/r',
  (select string_agg(format('%s(%s)/%s', confrelid::regclass,
       (select string_agg(attname, ',' order by array_position(conkey, attnum)) from pg_attribute
         where attrelid = conrelid and attnum = any (conkey)), confdeltype), '|' order by confrelid::regclass::text)
     from pg_constraint where conrelid = 'auth.session_open_patient'::regclass and contype = 'f'));
select pg_temp.check_case('1 no row-level security', 'false',
  (select relrowsecurity::text from pg_class where oid = 'auth.session_open_patient'::regclass));
select pg_temp.check_case('1 the guard', 'plpgsql/f/{"search_path=pg_catalog, pg_temp"}/insert,update',
  (select format('%s/%s/%s/%s', language.lanname, proc.prosecdef, proc.proconfig,
       (select string_agg(event, ',' order by event) from (values
          (case when trigger_row.tgtype & 4 <> 0 then 'insert' end),
          (case when trigger_row.tgtype & 8 <> 0 then 'delete' end),
          (case when trigger_row.tgtype & 16 <> 0 then 'update' end)) events(event) where event is not null))
     from pg_trigger trigger_row
     join pg_proc proc on proc.oid = trigger_row.tgfoid
     join pg_language language on language.oid = proc.prolang
    where trigger_row.tgrelid = 'auth.session_open_patient'::regclass and trigger_row.tgname = 'session_open_patient_guard'));

-- 2. Privileges.
select pg_temp.check_case('2 the Identity API runtime', 'DELETE,INSERT,SELECT,UPDATE',
  (select string_agg(privilege, ',' order by privilege) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) privilege
    where has_table_privilege('hid_identity_api_runtime', 'auth.session_open_patient', privilege)));
select pg_temp.check_case('2 the EHR runtime and the schema test runtime', '(null)',
  (select string_agg(role_name || ' ' || privilege, ',')
     from unnest(array['hid_ehr_api_runtime', 'hid_schema_test_runtime']) role_name
     cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege
    where has_table_privilege(role_name, 'auth.session_open_patient', privilege)));

-- 3. As the Identity API runtime.
set local role hid_identity_api_runtime;
select pg_temp.check_case('3 a set is kept', 'kept',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000001'));
select pg_temp.check_case('3 another set replaces it', 'kept',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000002',
    'emergency'));
select pg_temp.check_case('3 one row, the second patient, version 2', '1/f1407000-0000-4000-8000-000000000002/emergency/2',
  (select format('%s/%s/%s/%s', count(*), min(patient_id::text), min(purpose), max(row_version))
     from auth.session_open_patient where family_id = 'f1406000-0000-4000-8000-0000000000a1'));
select pg_temp.check_case('3 a patient sign-in', '23514',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000e1', 'f1402000-0000-4000-8000-0000000000e0',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000001'));
select pg_temp.check_case('3 a signed-out sign-in', '23514',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000a9', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000001'));
select pg_temp.check_case('3 not the family''s first session', '23514',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000a2', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000001'));
select pg_temp.check_case('3 an ended membership', '23514',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000b1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f2', 'f1405000-0000-4000-8000-0000000000a2', 'f1407000-0000-4000-8000-000000000001'));
select pg_temp.check_case('3 another facility''s membership (the guard, before the key)', '23514',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000b1', 'f1402000-0000-4000-8000-00000000000b',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000b2', 'f1407000-0000-4000-8000-000000000001'));
select pg_temp.check_case('3 longer than 8 hours', '23514',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000b1', 'f1402000-0000-4000-8000-00000000000b',
    'f1401000-0000-4000-8000-0000000000f2', 'f1405000-0000-4000-8000-0000000000b2', 'f1407000-0000-4000-8000-000000000001',
    'direct-care', interval '9 hours'));
select pg_temp.check_case('3 another purpose', '23514',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000b1', 'f1402000-0000-4000-8000-00000000000b',
    'f1401000-0000-4000-8000-0000000000f2', 'f1405000-0000-4000-8000-0000000000b2', 'f1407000-0000-4000-8000-000000000001',
    'healthcare-operations'));
select pg_temp.check_case('3 no such patient', '23503',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000b1', 'f1402000-0000-4000-8000-00000000000b',
    'f1401000-0000-4000-8000-0000000000f2', 'f1405000-0000-4000-8000-0000000000b2', 'f1407000-0000-4000-8000-0000000000ff'));
select pg_temp.check_case('3 B''s own set', 'kept',
  pg_temp.set_open('f1406000-0000-4000-8000-0000000000b1', 'f1402000-0000-4000-8000-00000000000b',
    'f1401000-0000-4000-8000-0000000000f2', 'f1405000-0000-4000-8000-0000000000b2', 'f1407000-0000-4000-8000-000000000001'));
do $$
begin
  begin
    update auth.session_open_patient set family_id = 'f1406000-0000-4000-8000-0000000000b1'
     where family_id = 'f1406000-0000-4000-8000-0000000000a1';
    perform pg_temp.check_case('3 no move to another sign-in', '55000', 'moved');
  exception when others then
    perform pg_temp.check_case('3 no move to another sign-in', '55000', sqlstate);
  end;
end $$;
delete from auth.session_open_patient where family_id = 'f1406000-0000-4000-8000-0000000000a1';
select pg_temp.check_case('3 a clear deletes it', '0',
  (select count(*)::text from auth.session_open_patient where family_id = 'f1406000-0000-4000-8000-0000000000a1'));
reset role;

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.open_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0140 open patient:\n%', mismatch;
  end if;
  raise notice '0140 open patient: % cases passed', (select count(*) from pg_temp.open_outcomes);
end $$;

rollback;
