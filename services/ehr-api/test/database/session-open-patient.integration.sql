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
--      update and delete, and execute D6's patient existence check (a
--      SECURITY DEFINER owned by identity.patients' owner); PUBLIC, the EHR
--      runtime and the schema test runtime hold nothing;
--   3. as the Identity API runtime: a set (the upsert keyed by family) is
--      kept and replaced; a clear deletes it; a set for a patient sign-in,
--      a signed-out sign-in, a session that is not the family's first, an
--      ended membership or another facility's membership is refused (23514
--      or 23503); a set longer than 8 hours, with another purpose, or for no
--      such patient is refused (23514, 23503); an update cannot move a row
--      to another sign-in (55000);
--   4. Identity's own statements, verbatim (open-patient.service.ts and
--      auth/open-patient.ts; open-patient-sql.spec.ts holds this file to
--      their text), as the Identity API runtime: the presented session; the
--      store (8 hours, never past the sign-in's end, nothing for a sign-in
--      ending now, version by version); the read through any live session
--      of the sign-in only; a stale version is not cleared; a move clears
--      only another facility's row; the user's clear and its repeat; an
--      expired row reads expired; a refreshed sign-in stores and reads
--      through its new session; D6's existence check (true for a patient,
--      false for a UUID that is no patient); and the card, given only under
--      the grant the access check allows: also to a doctor whose
--      identity.registration.write lets 0011's registration read show every
--      unsealed patient, and under 0131's own-facility grant.
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
  ('f1407000-0000-4000-8000-000000000002', 'HID-QPC4D5', 'Bayo', 'Open', 'Bayo Open', '1985-02-02', 'active', null),
  ('f1407000-0000-4000-8000-000000000003', 'HID-QPE6F7', 'Chidi', 'Open', 'Chidi Open', '1979-09-09', 'active', null);
-- A opened Chidi at F1 through 0131's own-facility opening (its grant's shape).
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, authorization_method) values
  ('f140b000-0000-4000-8000-000000000003', 'f1407000-0000-4000-8000-000000000003',
   'f1404000-0000-4000-8000-00000000000a', 'f1402000-0000-4000-8000-00000000000a',
   'f1405000-0000-4000-8000-0000000000a1', 'f1401000-0000-4000-8000-0000000000f1',
   'write_records', 'direct-care', 'active', 'Synthetic own-facility opening', now() - interval '1 minute',
   now() + interval '1 hour', false, 'open-patient-0140-own', 'own_facility');
-- A may read Bayo's records at F1 for direct care (section 4's card); nobody may read Amaka's.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id) values
  ('f140b000-0000-4000-8000-000000000001', 'f1407000-0000-4000-8000-000000000002',
   'f1404000-0000-4000-8000-00000000000a', 'f1402000-0000-4000-8000-00000000000a',
   'f1405000-0000-4000-8000-0000000000a1', 'f1401000-0000-4000-8000-0000000000f1',
   'read_records', 'direct-care', 'active', 'Synthetic open patient grant', now() - interval '1 minute',
   now() + interval '1 hour', false, 'open-patient-0140-grant');
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
-- A set keyed by the family, with its set time taken once (section 4 runs the API's own statement).
create function pg_temp.set_open(family uuid, account uuid, facility uuid, membership uuid, patient uuid,
  purpose text default 'direct-care', hours interval default interval '8 hours') returns text language plpgsql as $f$
declare
  moment timestamptz := clock_timestamp();
begin
  insert into auth.session_open_patient (family_id, account_id, facility_id, membership_id, patient_id, purpose,
    set_at, expires_at)
  values (family, account, facility, membership, patient, purpose, moment, moment + hours)
  on conflict (family_id) do update
     set facility_id = excluded.facility_id, membership_id = excluded.membership_id,
         patient_id = excluded.patient_id, purpose = excluded.purpose, set_at = excluded.set_at,
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
select pg_temp.check_case('2 D6: only the Identity runtime may run the existence check, a definer of the patients'' owner',
  't/f/f/f/t/t',
  format('%s/%s/%s/%s/%s/%s',
    has_function_privilege('hid_identity_api_runtime', 'auth.session_open_patient_target_exists(uuid)', 'EXECUTE'),
    has_function_privilege('hid_ehr_api_runtime', 'auth.session_open_patient_target_exists(uuid)', 'EXECUTE'),
    has_function_privilege('hid_schema_test_runtime', 'auth.session_open_patient_target_exists(uuid)', 'EXECUTE'),
    exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
             where proc.oid = 'auth.session_open_patient_target_exists(uuid)'::regprocedure and acl.grantee = 0),
    (select proc.prosecdef from pg_proc proc where proc.oid = 'auth.session_open_patient_target_exists(uuid)'::regprocedure),
    (select proc.proowner = (select relowner from pg_class where oid = 'identity.patients'::regclass)
       from pg_proc proc where proc.oid = 'auth.session_open_patient_target_exists(uuid)'::regprocedure)));
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

-- 4. Identity's own statements, verbatim. Each helper runs one statement with
-- EXECUTE ... USING, so its $n are the API's parameters.
create function pg_temp.op_presented(session_id uuid, account uuid) returns text language plpgsql as $f$
declare
  family text;
  ends timestamptz;
begin
  execute $sql$select session.family_id::text, session.absolute_expires_at
  from auth.sessions session
 where session.id = $1
   and session.account_id = $2
   and session.session_kind = 'staff'
   and session.revoked_at is null
   and session.expires_at > clock_timestamp()
   and session.absolute_expires_at > clock_timestamp()
   for share$sql$ into family, ends using session_id, account;
  return family;
end
$f$;
create function pg_temp.op_store(family uuid, account uuid, facility uuid, membership uuid, patient uuid,
  purpose text, ends timestamptz) returns text language plpgsql as $f$
declare
  kept timestamptz;
  stored bigint;
begin
  execute $sql$insert into auth.session_open_patient
       (family_id, account_id, facility_id, membership_id, patient_id, purpose, set_at, expires_at)
select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, moment.at,
       least(moment.at + make_interval(hours => 8), $7::timestamptz)
  from (select clock_timestamp() as at) moment
 where $7::timestamptz > moment.at
on conflict (family_id) do update
   set facility_id = excluded.facility_id, membership_id = excluded.membership_id,
       patient_id = excluded.patient_id, purpose = excluded.purpose,
       set_at = excluded.set_at, expires_at = excluded.expires_at,
       row_version = auth.session_open_patient.row_version + 1
returning expires_at$sql$ into kept using family, account, facility, membership, patient, purpose, ends;
  get diagnostics stored = row_count;
  return case when stored = 0 then 'none' else 'kept' end;
exception when others then
  return sqlstate;
end
$f$;
create function pg_temp.op_read(session_id uuid, account uuid) returns text language plpgsql as $f$
declare
  found_row record;
  rows_read bigint;
begin
  execute $sql$select open_patient.patient_id::text, open_patient.purpose,
       open_patient.facility_id::text, open_patient.expires_at, open_patient.row_version::text,
       open_patient.expires_at <= clock_timestamp() as expired
  from auth.sessions session
  join auth.session_open_patient open_patient
    on open_patient.family_id = session.family_id and open_patient.account_id = session.account_id
 where session.id = $1
   and session.account_id = $2
   and session.session_kind = 'staff'
   and session.revoked_at is null
   and session.expires_at > clock_timestamp()
   and session.absolute_expires_at > clock_timestamp()$sql$ into found_row using session_id, account;
  get diagnostics rows_read = row_count;
  if rows_read = 0 then return 'none'; end if;
  return format('%s/%s/%s/%s/%s', found_row.patient_id, found_row.purpose, found_row.facility_id,
    found_row.row_version, found_row.expired);
end
$f$;
create function pg_temp.op_clear(session_id uuid, account uuid) returns text language plpgsql as $f$
declare
  patient text;
  cleared bigint;
begin
  execute $sql$delete from auth.session_open_patient open_patient
  using auth.sessions session
 where session.id = $1
   and session.account_id = $2
   and open_patient.family_id = session.family_id
   and open_patient.account_id = session.account_id
returning open_patient.patient_id::text$sql$ into patient using session_id, account;
  get diagnostics cleared = row_count;
  return format('%s/%s', cleared, patient);
end
$f$;
create function pg_temp.op_clear_read(session_id uuid, account uuid, version text) returns text language plpgsql as $f$
declare
  cleared bigint;
begin
  execute $sql$delete from auth.session_open_patient open_patient
  using auth.sessions session
 where session.id = $1
   and session.account_id = $2
   and open_patient.family_id = session.family_id
   and open_patient.account_id = session.account_id
   and open_patient.row_version = $3::bigint$sql$ using session_id, account, version;
  get diagnostics cleared = row_count;
  return cleared::text;
end
$f$;
create function pg_temp.op_clear_elsewhere(session_id uuid, account uuid, facility uuid) returns text language plpgsql as $f$
declare
  cleared bigint;
begin
  execute $sql$delete from auth.session_open_patient open_patient
  using auth.sessions session
 where session.id = $1
   and session.account_id = $2
   and open_patient.family_id = session.family_id
   and open_patient.account_id = session.account_id
   and open_patient.facility_id <> $3$sql$ using session_id, account, facility;
  get diagnostics cleared = row_count;
  return cleared::text;
end
$f$;
create function pg_temp.op_card(patient uuid) returns text language plpgsql as $f$
declare
  card record;
  rows_read bigint;
begin
  execute $sql$select patient_row.full_name, patient_row.gender as sex,
       patient_row.dob::text as date_of_birth, right(patient_row.hid_code, 4) as health_id_last4,
       exists (select 1 from identity.patient_identifiers nin_identifier
     where nin_identifier.patient_id = patient_row.id
       and nin_identifier.identifier_type = 'nin'
       and nin_identifier.verified
       and nin_identifier.revoked_at is null) as nin_verified
  from identity.patients patient_row
 where patient_row.id = $1
   and patient_row.status = 'active'
   and identity.has_active_consent_grant(patient_row.id, platform.current_actor_subject(),
         platform.current_membership_id(), platform.current_facility_id(), 'read_records',
         platform.current_purpose_of_use(), clock_timestamp())$sql$ into card using patient;
  get diagnostics rows_read = row_count;
  if rows_read = 0 then return 'none'; end if;
  return format('%s/%s/%s/%s/%s', card.full_name, coalesce(card.sex, '-'), card.date_of_birth, card.health_id_last4,
    card.nin_verified);
end
$f$;
create function pg_temp.op_span() returns text language sql as $f$
  select (expires_at - set_at)::text from auth.session_open_patient where family_id = 'f1406000-0000-4000-8000-0000000000a1'
$f$;

set local role hid_identity_api_runtime;
select pg_temp.check_case('4 the presented session, locked for share', 'f1406000-0000-4000-8000-0000000000a1',
  pg_temp.op_presented('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 a later session of the sign-in presents its family', 'f1406000-0000-4000-8000-0000000000a1',
  pg_temp.op_presented('f1406000-0000-4000-8000-0000000000a2', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 a signed-out session is not presented', '(null)',
  pg_temp.op_presented('f1406000-0000-4000-8000-0000000000a9', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 another account''s session is not presented', '(null)',
  pg_temp.op_presented('f1406000-0000-4000-8000-0000000000b1', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 the store', 'kept',
  pg_temp.op_store('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000002',
    'direct-care', clock_timestamp() + interval '24 hours'));
select pg_temp.check_case('4 kept 8 hours', '08:00:00', pg_temp.op_span());
select pg_temp.check_case('4 a second store replaces it', 'kept',
  pg_temp.op_store('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000001',
    'emergency', clock_timestamp() + interval '24 hours'));
select pg_temp.check_case('4 a sign-in ending sooner ends it sooner', 'kept',
  pg_temp.op_store('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000001',
    'emergency', clock_timestamp() + interval '1 hour'));
select pg_temp.check_case('4 under an hour', 'true',
  (select (pg_temp.op_span()::interval <= interval '1 hour' and pg_temp.op_span()::interval > interval '59 minutes')::text));
select pg_temp.check_case('4 a sign-in ending now stores nothing', 'none',
  pg_temp.op_store('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000002',
    'direct-care', clock_timestamp() - interval '1 second'));
select pg_temp.check_case('4 the read through the sign-in',
  'f1407000-0000-4000-8000-000000000001/emergency/f1401000-0000-4000-8000-0000000000f1/3/f',
  pg_temp.op_read('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 the read through a later session of the sign-in',
  'f1407000-0000-4000-8000-000000000001/emergency/f1401000-0000-4000-8000-0000000000f1/3/f',
  pg_temp.op_read('f1406000-0000-4000-8000-0000000000a2', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 no read under another account', 'none',
  pg_temp.op_read('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000b'));
select pg_temp.check_case('4 no read through a signed-out sign-in', 'none',
  pg_temp.op_read('f1406000-0000-4000-8000-0000000000a9', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 a stale version is not cleared', '0',
  pg_temp.op_clear_read('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a', '2'));
select pg_temp.check_case('4 a move to the same facility clears nothing', '0',
  pg_temp.op_clear_elsewhere('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1'));
select pg_temp.check_case('4 a move to another facility clears it', '1',
  pg_temp.op_clear_elsewhere('f1406000-0000-4000-8000-0000000000a2', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f2'));
select pg_temp.check_case('4 stored again', 'kept',
  pg_temp.op_store('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000002',
    'direct-care', clock_timestamp() + interval '24 hours'));
select pg_temp.check_case('4 the version read is cleared', '1',
  pg_temp.op_clear_read('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a', '1'));
select pg_temp.check_case('4 and stored again', 'kept',
  pg_temp.op_store('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000002',
    'direct-care', clock_timestamp() + interval '24 hours'));
select pg_temp.check_case('4 the user''s clear names the patient', '1/f1407000-0000-4000-8000-000000000002',
  pg_temp.op_clear('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 a repeated clear clears nothing', '0/',
  pg_temp.op_clear('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 B''s row is untouched by A''s clears', '1',
  (select count(*)::text from auth.session_open_patient where family_id = 'f1406000-0000-4000-8000-0000000000b1'));
update auth.session_open_patient set set_at = now() - interval '9 hours',
       expires_at = now() - interval '2 hours', row_version = row_version + 1
 where family_id = 'f1406000-0000-4000-8000-0000000000b1';
select pg_temp.check_case('4 an expired row reads expired', 't',
  (select split_part(pg_temp.op_read('f1406000-0000-4000-8000-0000000000b1', 'f1402000-0000-4000-8000-00000000000b'), '/', 5)));
reset role;
-- A refresh: the sign-in's first session is replaced by a later one.
update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'rotated', row_version = row_version + 1
 where id = 'f1406000-0000-4000-8000-0000000000a1';
set local role hid_identity_api_runtime;
select pg_temp.check_case('4 after a refresh, presented through the new session', 'f1406000-0000-4000-8000-0000000000a1',
  pg_temp.op_presented('f1406000-0000-4000-8000-0000000000a2', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 after a refresh, the first session is not presented', '(null)',
  pg_temp.op_presented('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a'));
select pg_temp.check_case('4 after a refresh, the store', 'kept',
  pg_temp.op_store('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a',
    'f1401000-0000-4000-8000-0000000000f1', 'f1405000-0000-4000-8000-0000000000a1', 'f1407000-0000-4000-8000-000000000002',
    'direct-care', clock_timestamp() + interval '24 hours'));
select pg_temp.check_case('4 after a refresh, read through the new session', 'f1407000-0000-4000-8000-000000000002',
  split_part(pg_temp.op_read('f1406000-0000-4000-8000-0000000000a2', 'f1402000-0000-4000-8000-00000000000a'), '/', 1));
select pg_temp.check_case('4 after a refresh, no read through the first session', 'none',
  pg_temp.op_read('f1406000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a'));
-- The card, as Identity reads it: as A at F1 for direct care.
select set_config('app.actor_subject', 'synthetic:open-patient-0140:a', true),
  set_config('app.facility_id', 'f1401000-0000-4000-8000-0000000000f1', true),
  set_config('app.membership_id', 'f1405000-0000-4000-8000-0000000000a1', true),
  set_config('app.purpose_of_use', 'direct-care', true),
  set_config('app.correlation_id', 'open-patient-0140-card', true);
select pg_temp.check_case('4 the access check allows Bayo, not Amaka', 't/f',
  (select format('%s/%s',
     identity.has_active_consent_grant('f1407000-0000-4000-8000-000000000002', 'synthetic:open-patient-0140:a',
       'f1405000-0000-4000-8000-0000000000a1', 'f1401000-0000-4000-8000-0000000000f1', 'read_records', 'direct-care',
       clock_timestamp()),
     identity.has_active_consent_grant('f1407000-0000-4000-8000-000000000001', 'synthetic:open-patient-0140:a',
       'f1405000-0000-4000-8000-0000000000a1', 'f1401000-0000-4000-8000-0000000000f1', 'read_records', 'direct-care',
       clock_timestamp()))));
select pg_temp.check_case('4 the card under the grant (last 4 only)', 'Bayo Open/-/1985-02-02/C4D5/f',
  pg_temp.op_card('f1407000-0000-4000-8000-000000000002'));
select pg_temp.check_case('4 no card without one', 'none', pg_temp.op_card('f1407000-0000-4000-8000-000000000001'));
select pg_temp.check_case('4 the card under 0131''s own-facility grant', 'Chidi Open/-/1979-09-09/E6F7/f',
  pg_temp.op_card('f1407000-0000-4000-8000-000000000003'));
-- D6, as Identity asks it before the access check.
select pg_temp.check_case('4 D6: a patient exists, a UUID that is no patient does not', 't/f',
  format('%s/%s', auth.session_open_patient_target_exists('f1407000-0000-4000-8000-000000000001'),
    auth.session_open_patient_target_exists('f1407fff-0000-4000-8000-000000000999')));
select set_config('app.purpose_of_use', 'emergency', true);
select pg_temp.check_case('4 no card under another purpose', 'none', pg_temp.op_card('f1407000-0000-4000-8000-000000000002'));
-- A doctor holding identity.registration.write (a real account_roles row):
-- 0011's registration read now shows A every unsealed patient, Amaka
-- included, yet the card follows the grant, not that read (Ola's review of
-- #295, item 2).
reset role;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('f140c000-0000-4000-8000-0000000000a1', 'f1402000-0000-4000-8000-00000000000a', 'doctor', 'facility',
   'f1405000-0000-4000-8000-0000000000a1', 'f1401000-0000-4000-8000-0000000000f1', 'Synthetic doctor role');
set local role hid_identity_api_runtime;
select set_config('app.purpose_of_use', 'direct-care', true);
select pg_temp.check_case('4 a registration writer sees Amaka through 0011''s read', 't/1',
  format('%s/%s', auth.membership_has_permission('synthetic:open-patient-0140:a', 'f1405000-0000-4000-8000-0000000000a1',
      'f1401000-0000-4000-8000-0000000000f1', 'identity.registration.write'),
    (select count(*) from identity.patients where id = 'f1407000-0000-4000-8000-000000000001')));
select pg_temp.check_case('4 a registration writer gets no card without the grant', 'none',
  pg_temp.op_card('f1407000-0000-4000-8000-000000000001'));
select pg_temp.check_case('4 a registration writer still gets the card under the grant', 'Bayo Open/-/1985-02-02/C4D5/f',
  pg_temp.op_card('f1407000-0000-4000-8000-000000000002'));
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
