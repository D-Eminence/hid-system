\set ON_ERROR_STOP on
-- 0132 (ID-3a and ID-3b; owner decisions of 18 November 2026): staff patient
-- search with the strong and weak key rule, Health ID included, matchRefs,
-- emergency search (Q104 in the patient's access log) and "No such patient"
-- for a Health ID nobody has (Q100 B). Rollback-only. Every search runs as
-- Identity's runtime role in the context Identity's transactions set.
-- Fictional people, places and identifiers only; ids start e1320.
--
--   1. strong keys find any active patient; weak keys only this facility's
--      own patients (0131's basis: a consented visit here); anything else is
--      too broad; every key given must match; names ignore case and extra
--      spaces;
--   2. Health ID outcomes: found, no_match (exists but not here, another
--      key differs, inactive or sealed) and no_such_health_id (no patient
--      record of any status has it);
--   3. exclusions: inactive, merged, sealed demo patients; another
--      facility's own patients; a sealed facility finds only its sealed
--      patients;
--   4. limits: 10 cards, 11 matches answer too_many and no card;
--   5. cards: name, sex, date of birth, last 4 of the Health ID, NIN
--      checked, a matchRef; never a Health ID or a patient id;
--   6. matchRefs: only their SHA-256 is stored; they resolve for the same
--      member, facility and purpose only, not after 10 minutes, not once the
--      patient is inactive;
--   7. refusals: no permission (lab), wrong purpose, a reason on a standard
--      search, malformed keys, too many phone HMACs, a bad hash;
--   8. emergency: break-glass permission, emergency purpose, the control
--      and a reason of 8-500 characters before any result; exactly first
--      name, last name and date of birth; at most 5 cards;
--  8b. break-glass by an emergency card's matchRef (ID-5): the member who
--      searched opens the patient, a replay finds the same grant, and
--      another member's, a direct-care or a malformed ref is refused as an
--      unknown Health ID is;
--   9. audit: one row per search (key kinds and the caller's hash, never a
--      name, date of birth, Health ID or phone HMAC; the outcome and the
--      patients shown; denied when too broad; the emergency reason) and one
--      row per patient shown; refusals the function raises write nothing;
--  10. the patient's access log shows an emergency search that found them
--      ("Found in an emergency search at <facility>") and not a standard
--      search;
--  11. structure: owners, SECURITY DEFINER, search_path, EXECUTE for the
--      Identity runtime only, no privilege on the table, row-level security.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.
begin;

-- As prescription-dispensing-details and provider-self-enrollment do: where
-- the control table's owner cannot bypass row-level security (a build whose
-- migrator has neither SUPERUSER nor BYPASSRLS), every staff-context control
-- read answers PLATFORM_CONTROL_UNAVAILABLE, so the emergency cases lift FORCE
-- for this rolled-back transaction only.
do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'search-test'),
  ('emergency', 'Emergency care', 'search-test')
  on conflict (code) do update set active = true;
insert into platform.control_settings (control_key, enabled, reason)
  values ('break_glass_enabled', true, 'Search suite')
  on conflict (control_key) do update set enabled = true;
insert into identity.organizations (id, name, slug) values
  ('e1320000-0000-4000-8000-000000000001', 'Search Group A', 'search-group-a'),
  ('e1320000-0000-4000-8000-000000000011', 'Search Group B', 'search-group-b');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1320000-0000-4000-8000-000000000002', 'e1320000-0000-4000-8000-000000000001', 'Search Clinic A',
   'SEARCH-A', 'Africa/Lagos', true, 'verified'),
  ('e1320000-0000-4000-8000-000000000012', 'e1320000-0000-4000-8000-000000000011', 'Search Clinic B',
   'SEARCH-B', 'Africa/Lagos', true, 'verified'),
  ('e1320000-0000-4000-8000-000000000022', 'e1320000-0000-4000-8000-000000000011', 'Search Demo Clinic',
   'SEARCH-DEMO', 'Africa/Lagos', true, 'verified');
create temporary table search_members (n integer primary key, facility uuid, organization uuid, role_code text,
  name text) on commit drop;
insert into search_members values
  (1, 'e1320000-0000-4000-8000-000000000002', 'e1320000-0000-4000-8000-000000000001', 'receptionist', 'Ada Desk'),
  (2, 'e1320000-0000-4000-8000-000000000002', 'e1320000-0000-4000-8000-000000000001', 'doctor', 'Bola Doctor'),
  (3, 'e1320000-0000-4000-8000-000000000002', 'e1320000-0000-4000-8000-000000000001', 'lab', 'Chidi Lab'),
  (4, 'e1320000-0000-4000-8000-000000000002', 'e1320000-0000-4000-8000-000000000001', 'receptionist', 'Dayo Desk'),
  (5, 'e1320000-0000-4000-8000-000000000012', 'e1320000-0000-4000-8000-000000000011', 'receptionist', 'Efe Desk'),
  (6, 'e1320000-0000-4000-8000-000000000012', 'e1320000-0000-4000-8000-000000000011', 'doctor', 'Femi Doctor'),
  (7, 'e1320000-0000-4000-8000-000000000022', 'e1320000-0000-4000-8000-000000000011', 'receptionist', 'Gbenga Demo Desk');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1320100-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:search-member-' || n,
  'search-member-' || n || '@example.invalid', name, 'active' from search_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1320200-0000-4000-8000-00000000000' || n)::uuid, ('e1320100-0000-4000-8000-00000000000' || n)::uuid,
  name, 'search-member-' || n || '@example.invalid', 'verified', role_code from search_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1320300-0000-4000-8000-00000000000' || n)::uuid, ('e1320200-0000-4000-8000-00000000000' || n)::uuid,
  ('e1320100-0000-4000-8000-00000000000' || n)::uuid, organization, facility, role_code, role_code, true, true
from search_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('e1320100-0000-4000-8000-00000000000' || n)::uuid, role_code, 'facility',
  ('e1320300-0000-4000-8000-00000000000' || n)::uuid, facility, 'Synthetic search suite role'
from search_members;

-- Patients. Phone HMACs are fixed fictional values ('a' x 64 for p1, 'b' x 64 for p3).
create temporary table search_patients (n integer primary key, hid text, first_name text, last_name text,
  dob date, gender text, status text, phone text) on commit drop;
insert into search_patients values
  (1, 'HID-QSAA22', 'Amaka', 'Okafor', '1990-05-01', 'female', 'active', repeat('a', 64)),  -- here at A
  (2, 'HID-QSAB22', 'Amaka', 'Okafor', '1990-05-01', 'female', 'active', null),            -- not here
  (3, 'HID-QSAC22', 'Bayo', 'Adeyemi', '1985-02-02', 'male', 'active', repeat('b', 64)),   -- not here
  (4, 'HID-QSAD22', 'Chika', 'Eze', '1970-03-03', 'female', 'inactive', null),
  (5, 'HID-QSAE22', 'Dami', 'Bello', '1975-04-04', 'male', 'active', null),                -- sealed demo
  (6, 'HID-QSAF22', 'Bayo', 'Adeyemi', '1985-02-02', 'male', 'active', null),              -- here at B only
  (7, 'HID-QSAG22', 'Ngozi', 'Uche', '1995-06-06', 'female', 'active', null),              -- checked NIN
  (8, 'HID-QSAH22', 'Amaka', 'Okafor', '1990-05-01', 'female', 'merged', null);
-- Eleven Tunde Bakare, ten Kemi Ade, five Femi Ola (2000-01-01).
insert into search_patients
select 20 + g, 'HID-QT' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ', g, 1) || 'A22', 'Tunde', 'Bakare', '2000-01-01', 'male',
  'active', null from generate_series(1, 11) g;
insert into search_patients
select 40 + g, 'HID-QK' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ', g, 1) || 'A22', 'Kemi', 'Ade', '2000-01-01', 'female',
  'active', null from generate_series(1, 10) g;
insert into search_patients
select 60 + g, 'HID-QF' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ', g, 1) || 'A22', 'Femi', 'Ola', '2000-01-01', 'male',
  'active', null from generate_series(1, 5) g;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status, source_system,
  phone_e164_ciphertext, phone_lookup_hmac, contact_key_version)
select ('e1320400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, hid, first_name, last_name,
  first_name || ' ' || last_name, dob, gender, status, 'hid',
  case when phone is not null then '\x00'::bytea end, phone, case when phone is not null then 'k1' end
from search_patients;
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('patient', 'e1320400-0000-4000-8000-000000000005'), ('facility', 'e1320000-0000-4000-8000-000000000022');
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, display_hint, verified, verified_at, verification_provider, verification_reference,
  registration_case_id)
values ('e1320600-0000-4000-8000-000000000001', 'e1320400-0000-4000-8000-000000000007', 'nin',
  decode(repeat('ab', 32), 'hex'), repeat('7', 64), 'k1', '****1234', true, clock_timestamp() - interval '30 days',
  'fixture', 'ref', 'e1320500-0000-4000-8000-000000000099');
-- "Here": a visit started under the patient's own approval to the member who started it (0131's visit_here).
-- p1 at A (member 2), p6 at B (member 6).
create temporary table search_visits (n integer primary key, patient integer, member integer, facility uuid)
  on commit drop;
insert into search_visits values (1, 1, 2, 'e1320000-0000-4000-8000-000000000002'),
  (2, 6, 6, 'e1320000-0000-4000-8000-000000000012');
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass, created_at)
select ('e1320700-0000-4000-8000-00000000000' || v.n)::uuid, null,
  ('e1320400-0000-4000-8000-0000000000' || lpad(v.patient::text, 2, '0'))::uuid,
  ('e1320200-0000-4000-8000-00000000000' || v.member)::uuid, ('e1320100-0000-4000-8000-00000000000' || v.member)::uuid,
  ('e1320300-0000-4000-8000-00000000000' || v.member)::uuid, v.facility, 'write_records', 'direct-care', 'expired',
  ('e1320400-0000-4000-8000-0000000000' || lpad(v.patient::text, 2, '0'))::uuid, 'Fixture grant',
  clock_timestamp() - interval '2 months' - interval '1 hour', clock_timestamp() - interval '2 months' + interval '23 hours',
  false, clock_timestamp() - interval '2 months' - interval '1 hour'
from search_visits v;
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, ended_at, chief_complaint, created_at)
select ('e1320800-0000-4000-8000-00000000000' || v.n)::uuid,
  ('e1320400-0000-4000-8000-0000000000' || lpad(v.patient::text, 2, '0'))::uuid, v.facility,
  ('e1320100-0000-4000-8000-00000000000' || v.member)::uuid, ('e1320300-0000-4000-8000-00000000000' || v.member)::uuid,
  'ambulatory', 'completed', statement_timestamp() - interval '2 months', statement_timestamp() - interval '2 months',
  'Fixture visit', statement_timestamp() - interval '2 months'
from search_visits v;
-- p1's patient login and live session, for the access log.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1320100-0000-4000-8000-000000000099', 'synthetic:search-patient-1', 'search-patient-1@example.invalid',
   'Search Patient', 'active');
update identity.patients set account_id = 'e1320100-0000-4000-8000-000000000099'
 where id = 'e1320400-0000-4000-8000-000000000001';
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('e1320a00-0000-4000-8000-000000000001', 'e1320100-0000-4000-8000-000000000099',
   'e1320a00-0000-4000-8000-000000000001', md5('search-patient') || md5('search-patient'), gen_random_uuid(), 1,
   'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
   'patient', 'e1320400-0000-4000-8000-000000000001');
set local session_replication_role = origin;

create temporary table search_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
create temporary table search_answers (seq serial, label text, outcome text, reach text, match_ref text,
  full_name text, sex text, date_of_birth date, health_id_last4 text, nin_verified boolean,
  match_ref_expires_at timestamptz) on commit drop;
grant select, insert on pg_temp.search_outcomes, pg_temp.search_answers to hid_identity_api_runtime;
grant usage on sequence pg_temp.search_outcomes_seq_seq, pg_temp.search_answers_seq_seq to hid_identity_api_runtime;
grant select on pg_temp.search_members to hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.search_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
-- Any statement: 'ok', or the refusal's code and message.
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.as_member(n integer, purpose text default 'direct-care') returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:search-member-' || n, true),
    set_config('app.membership_id', 'e1320300-0000-4000-8000-00000000000' || n, true),
    set_config('app.facility_id', (select facility::text from pg_temp.search_members where search_members.n = as_member.n), true),
    set_config('app.correlation_id', 'search-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;
-- One search: "outcome/reach/count" and the cards' "last4" in order, or the refusal's code and message.
create function pg_temp.search(label text, n integer, mode text, first_name text, last_name text, dob date,
  hid text, phones text[], reason text default null, purpose text default null) returns text
language plpgsql as $f$
declare
  summary text;
begin
  perform pg_temp.as_member(n, coalesce(purpose, case when mode = 'emergency' then 'emergency' else 'direct-care' end));
  -- The label names the search's audit rows.
  perform set_config('app.correlation_id', 'search-suite-' || label, true);
  insert into pg_temp.search_answers (label, outcome, reach, match_ref, full_name, sex, date_of_birth, health_id_last4,
    nin_verified, match_ref_expires_at)
  -- By name, so a column added at the end of the answer (0146's record_kind) changes nothing here.
  select label, answer.outcome, answer.reach, answer.match_ref, answer.full_name, answer.sex, answer.date_of_birth,
    answer.health_id_last4, answer.nin_verified, answer.match_ref_expires_at
    from identity.staff_patient_search(mode, first_name, last_name, dob, hid, phones, reason, repeat('c', 64)) answer;
  select format('%s/%s/%s%s', min(answer.outcome), coalesce(min(answer.reach), '-'), count(answer.match_ref),
      coalesce(':' || string_agg(answer.health_id_last4, ',' order by answer.seq), ''))
    into summary from pg_temp.search_answers answer where answer.label = search.label;
  return summary;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

set local role hid_identity_api_runtime;

-- 1. Strong and weak keys.
select pg_temp.check_case('1 full name and date of birth find anyone', 'found/everywhere/2:AA22,AB22',
  pg_temp.search('s1', 1, 'standard', 'Amaka', 'Okafor', '1990-05-01', null, null));
select pg_temp.check_case('1 case and spaces ignored', 'found/everywhere/2:AA22,AB22',
  pg_temp.search('s2', 1, 'standard', '  amaka ', 'OKAFOR', '1990-05-01', null, null));
select pg_temp.check_case('1 a different date of birth', 'no_match/everywhere/0',
  pg_temp.search('s3', 1, 'standard', 'Amaka', 'Okafor', '1990-05-02', null, null));
select pg_temp.check_case('1 Health ID and last name', 'found/everywhere/1:AC22',
  pg_temp.search('s4', 1, 'standard', null, 'adeyemi', null, 'hid-qsac22', null));
select pg_temp.check_case('1 Health ID and date of birth', 'found/everywhere/1:AC22',
  pg_temp.search('s5', 1, 'standard', null, null, '1985-02-02', 'HID-QSAC22', null));
select pg_temp.check_case('1 phone and last name', 'found/everywhere/1:AC22',
  pg_temp.search('s6', 1, 'standard', null, 'Adeyemi', null, null, array[repeat('b', 64)]));
select pg_temp.check_case('1 phone and the wrong last name', 'no_match/everywhere/0',
  pg_temp.search('s7', 1, 'standard', null, 'Okafor', null, null, array[repeat('b', 64)]));
select pg_temp.check_case('1 weak: Health ID alone, here', 'found/here/1:AA22',
  pg_temp.search('s8', 1, 'standard', null, null, null, 'HID-QSAA22', null));
select pg_temp.check_case('1 weak: Health ID alone, not here', 'no_match/here/0',
  pg_temp.search('s9', 1, 'standard', null, null, null, 'HID-QSAC22', null));
select pg_temp.check_case('1 weak: phone alone, here', 'found/here/1:AA22',
  pg_temp.search('s10', 1, 'standard', null, null, null, null, array[repeat('a', 64), repeat('e', 64)]));
select pg_temp.check_case('1 weak: phone alone, not here', 'no_match/here/0',
  pg_temp.search('s11', 1, 'standard', null, null, null, null, array[repeat('b', 64)]));
select pg_temp.check_case('1 weak: phone and date of birth, not here', 'no_match/here/0',
  pg_temp.search('s12', 1, 'standard', null, null, '1985-02-02', null, array[repeat('b', 64)]));
select pg_temp.check_case('1 weak: last name and date of birth, at A', 'no_match/here/0',
  pg_temp.search('s13', 1, 'standard', null, 'Adeyemi', '1985-02-02', null, null));
select pg_temp.check_case('1 weak: last name and date of birth, at B', 'found/here/1:AF22',
  pg_temp.search('s14', 5, 'standard', null, 'Adeyemi', '1985-02-02', null, null));
select pg_temp.check_case('1 weak: last name and date of birth, here among two', 'found/here/1:AA22',
  pg_temp.search('s15', 4, 'standard', null, 'Okafor', '1990-05-01', null, null));
select pg_temp.check_case('1 too broad: first and last name', 'too_broad/-/0',
  pg_temp.search('s16', 1, 'standard', 'Amaka', 'Okafor', null, null, null));
select pg_temp.check_case('1 too broad: last name', 'too_broad/-/0',
  pg_temp.search('s17', 1, 'standard', null, 'Okafor', null, null, null));
select pg_temp.check_case('1 too broad: date of birth', 'too_broad/-/0',
  pg_temp.search('s18', 1, 'standard', null, null, '1990-05-01', null, null));
select pg_temp.check_case('1 too broad: first name and date of birth', 'too_broad/-/0',
  pg_temp.search('s19', 1, 'standard', 'Amaka', null, '1990-05-01', null, null));
select pg_temp.check_case('1 too broad: nothing', 'too_broad/-/0',
  pg_temp.search('s20', 1, 'standard', ' ', '', null, null, null));
select pg_temp.check_case('1 a doctor may search', 'found/everywhere/2:AA22,AB22',
  pg_temp.search('s21', 2, 'standard', 'Amaka', 'Okafor', '1990-05-01', null, null));

-- 2. Health ID outcomes (owner Q100 B).
select pg_temp.check_case('2 unknown Health ID', 'no_such_health_id/here/0',
  pg_temp.search('h1', 1, 'standard', null, null, null, 'HID-QSZZ99', null));
select pg_temp.check_case('2 unknown Health ID with a last name', 'no_such_health_id/everywhere/0',
  pg_temp.search('h2', 1, 'standard', null, 'Okafor', null, 'HID-QSZZ99', null));
select pg_temp.check_case('2 known Health ID, another date of birth', 'no_match/everywhere/0',
  pg_temp.search('h3', 1, 'standard', null, null, '1985-02-03', 'HID-QSAC22', null));
select pg_temp.check_case('2 inactive patient''s Health ID', 'no_match/everywhere/0',
  pg_temp.search('h4', 1, 'standard', null, 'Eze', null, 'HID-QSAD22', null));
select pg_temp.check_case('2 sealed patient''s Health ID', 'no_match/everywhere/0',
  pg_temp.search('h5', 1, 'standard', null, 'Bello', null, 'HID-QSAE22', null));

-- 3. Exclusions.
select pg_temp.check_case('3 inactive by name', 'no_match/everywhere/0',
  pg_temp.search('x1', 1, 'standard', 'Chika', 'Eze', '1970-03-03', null, null));
select pg_temp.check_case('3 sealed by name', 'no_match/everywhere/0',
  pg_temp.search('x2', 1, 'standard', 'Dami', 'Bello', '1975-04-04', null, null));
select pg_temp.check_case('3 another facility''s own patient by Health ID alone', 'no_match/here/0',
  pg_temp.search('x3', 1, 'standard', null, null, null, 'HID-QSAF22', null));
select pg_temp.check_case('3 merged by Health ID', 'no_match/everywhere/0',
  pg_temp.search('x4', 1, 'standard', null, 'Okafor', null, 'HID-QSAH22', null));
select pg_temp.check_case('3 a sealed facility finds its sealed patient', 'found/everywhere/1:AE22',
  pg_temp.search('x5', 7, 'standard', 'Dami', 'Bello', '1975-04-04', null, null));
select pg_temp.check_case('3 and nobody else', 'no_match/everywhere/0',
  pg_temp.search('x6', 7, 'standard', 'Amaka', 'Okafor', '1990-05-01', null, null));


-- 4. Limits.
select pg_temp.check_case('4 ten matches',
  'found/everywhere/10:AA22,BA22,CA22,DA22,EA22,FA22,GA22,HA22,JA22,KA22',
  pg_temp.search('l1', 1, 'standard', 'Kemi', 'Ade', '2000-01-01', null, null));
select pg_temp.check_case('4 eleven matches', 'too_many/everywhere/0',
  pg_temp.search('l2', 1, 'standard', 'Tunde', 'Bakare', '2000-01-01', null, null));

-- 5. Cards.
select pg_temp.search('n1', 1, 'standard', 'Ngozi', 'Uche', '1995-06-06', null, null);
select pg_temp.check_case('5 card', 'Amaka Okafor/female/1990-05-01/AA22/f/t/t',
  (select format('%s/%s/%s/%s/%s/%s/%s', full_name, sex, date_of_birth, health_id_last4, nin_verified,
     match_ref ~ '^psr_[A-Za-z0-9_-]{43}$',
     match_ref_expires_at between clock_timestamp() + interval '9 minutes' and clock_timestamp() + interval '10 minutes')
     from pg_temp.search_answers where label = 's8'));
select pg_temp.check_case('5 NIN checked', 'true',
  (select nin_verified::text from pg_temp.search_answers where label = 'n1'));
select pg_temp.check_case('5 no Health ID and no patient id in any answer', '0',
  (select count(*)::text from pg_temp.search_answers answer where row_to_json(answer)::text ~* 'HID-|e1320400-'));
select pg_temp.check_case('5 every matchRef differs', 'true',
  (select (count(distinct match_ref) = count(match_ref))::text from pg_temp.search_answers));

-- 6. matchRefs.
select pg_temp.check_case('6 the runtime cannot read the table', '42501 permission denied for table patient_search_refs',
  pg_temp.try('select 1 from identity.patient_search_refs limit 1'));
select set_config('search_test.p1_ref', (select match_ref from pg_temp.search_answers where label = 's8'), true);
select set_config('search_test.p3_ref', (select match_ref from pg_temp.search_answers where label = 's4'), true);
select pg_temp.as_member(1);
select pg_temp.check_case('6 resolves for the same member', 'e1320400-0000-4000-8000-000000000001',
  identity.resolve_patient_search_ref(current_setting('search_test.p1_ref'), 'direct-care')::text);
select pg_temp.check_case('6 not for another purpose than the session''s', '(null)',
  identity.resolve_patient_search_ref(current_setting('search_test.p1_ref'), 'emergency')::text);
select pg_temp.check_case('6 not a malformed ref', '(null)',
  identity.resolve_patient_search_ref(current_setting('search_test.p1_ref') || 'x', 'direct-care')::text);
select pg_temp.as_member(1, 'emergency');
select pg_temp.check_case('6 not in an emergency session', '(null)',
  identity.resolve_patient_search_ref(current_setting('search_test.p1_ref'), 'emergency')::text);
select pg_temp.as_member(4);
select pg_temp.check_case('6 not for another member here', '(null)',
  identity.resolve_patient_search_ref(current_setting('search_test.p1_ref'), 'direct-care')::text);
select pg_temp.as_member(5);
select pg_temp.check_case('6 not at another facility', '(null)',
  identity.resolve_patient_search_ref(current_setting('search_test.p1_ref'), 'direct-care')::text);
reset role;
select pg_temp.check_case('6 only the SHA-256 is stored', '1/0',
  (select format('%s/%s',
     count(*) filter (where token_sha256 = encode(sha256(convert_to(current_setting('search_test.p1_ref'), 'UTF8')), 'hex')),
     count(*) filter (where row_to_json(ref)::text like '%' || current_setting('search_test.p1_ref') || '%'))
     from identity.patient_search_refs ref));
select pg_temp.check_case('6 bound to the patient, member, facility and purpose', 'true',
  (select (patient_id = 'e1320400-0000-4000-8000-000000000001' and account_id = 'e1320100-0000-4000-8000-000000000001'
     and membership_id = 'e1320300-0000-4000-8000-000000000001' and facility_id = 'e1320000-0000-4000-8000-000000000002'
     and purpose_of_use = 'direct-care' and search_mode = 'standard')::text
     from identity.patient_search_refs
    where token_sha256 = encode(sha256(convert_to(current_setting('search_test.p1_ref'), 'UTF8')), 'hex')));
update identity.patients set status = 'inactive' where id = 'e1320400-0000-4000-8000-000000000003';
set local role hid_identity_api_runtime;
select pg_temp.as_member(1);
select pg_temp.check_case('6 not once the patient is inactive', '(null)',
  identity.resolve_patient_search_ref(current_setting('search_test.p3_ref'), 'direct-care')::text);
reset role;
update identity.patients set status = 'active' where id = 'e1320400-0000-4000-8000-000000000003';
update identity.patient_search_refs
   set created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes'
 where token_sha256 = encode(sha256(convert_to(current_setting('search_test.p1_ref'), 'UTF8')), 'hex');
set local role hid_identity_api_runtime;
select pg_temp.as_member(1);
select pg_temp.check_case('6 not after 10 minutes', '(null)',
  identity.resolve_patient_search_ref(current_setting('search_test.p1_ref'), 'direct-care')::text);
select pg_temp.check_case('6 p3 again once active', 'e1320400-0000-4000-8000-000000000003',
  identity.resolve_patient_search_ref(current_setting('search_test.p3_ref'), 'direct-care')::text);
-- The next search removes the expired one.
select pg_temp.search('c1', 1, 'standard', 'Ngozi', 'Uche', '1995-06-06', null, null);
reset role;
select pg_temp.check_case('6 expired refs are removed by later searches', '0',
  (select count(*)::text from identity.patient_search_refs where expires_at < clock_timestamp()));
set local role hid_identity_api_runtime;

-- 7. Refusals.
select pg_temp.check_case('7 lab staff', '42501 PATIENT_SEARCH_NOT_PERMITTED',
  pg_temp.search('r1', 3, 'standard', 'Amaka', 'Okafor', '1990-05-01', null, null));
select pg_temp.check_case('7 standard search under the emergency purpose', '22023 PATIENT_SEARCH_PURPOSE',
  pg_temp.search('r2', 1, 'standard', 'Amaka', 'Okafor', '1990-05-01', null, null, null, 'emergency'));
select pg_temp.check_case('7 a reason on a standard search', '22023 PATIENT_SEARCH_INVALID',
  pg_temp.search('r3', 1, 'standard', 'Amaka', 'Okafor', '1990-05-01', null, null, 'Because'));
select pg_temp.check_case('7 a malformed Health ID', '22023 PATIENT_SEARCH_INVALID',
  pg_temp.search('r4', 1, 'standard', null, 'Okafor', null, 'HID-0000', null));
select pg_temp.check_case('7 three phone HMACs', '22023 PATIENT_SEARCH_INVALID',
  pg_temp.search('r5', 1, 'standard', null, null, null, null, array[repeat('a', 64), repeat('b', 64), repeat('e', 64)]));
select pg_temp.check_case('7 a phone that is not an HMAC', '22023 PATIENT_SEARCH_INVALID',
  pg_temp.search('r6', 1, 'standard', null, null, null, null, array['+2348030000000']));
select pg_temp.check_case('7 a name over 100 characters', '22023 PATIENT_SEARCH_INVALID',
  pg_temp.search('r7', 1, 'standard', repeat('a', 101), 'Okafor', '1990-05-01', null, null));
select pg_temp.check_case('7 a date of birth in the future', '22023 PATIENT_SEARCH_INVALID',
  pg_temp.search('r8', 1, 'standard', 'Amaka', 'Okafor', (current_date + 1), null, null));
select pg_temp.check_case('7 an unknown mode', '22023 PATIENT_SEARCH_INVALID',
  pg_temp.search('r9', 1, 'everything', 'Amaka', 'Okafor', '1990-05-01', null, null));
select pg_temp.as_member(1);
select pg_temp.check_case('7 a criteria hash that is not one', '22023 PATIENT_SEARCH_INVALID',
  pg_temp.try($q$select * from identity.staff_patient_search('standard', 'Amaka', 'Okafor', '1990-05-01', null, null,
    null, 'Amaka Okafor')$q$));
select set_config('app.membership_id', '', true);
select pg_temp.check_case('7 no membership in the session', '42501 PATIENT_SEARCH_NOT_PERMITTED',
  pg_temp.try($q$select * from identity.staff_patient_search('standard', 'Amaka', 'Okafor', '1990-05-01', null, null,
    null, null)$q$));
reset role;
update identity.staff_facility_memberships set active = false where id = 'e1320300-0000-4000-8000-000000000004';
set local role hid_identity_api_runtime;
select pg_temp.check_case('7 an inactive membership', '42501 PATIENT_SEARCH_NOT_PERMITTED',
  pg_temp.search('r10', 4, 'standard', 'Amaka', 'Okafor', '1990-05-01', null, null));
reset role;
update identity.staff_facility_memberships set active = true where id = 'e1320300-0000-4000-8000-000000000004';
set local role hid_identity_api_runtime;

-- 8. Emergency search.
select pg_temp.check_case('8 found with a reason', 'found/everywhere/2:AA22,AB22',
  pg_temp.search('e1', 2, 'emergency', 'Amaka', 'Okafor', '1990-05-01', null, null,
    'Unconscious patient brought in by ambulance'));
select pg_temp.check_case('8 no reason', '22023 PATIENT_SEARCH_REASON_REQUIRED',
  pg_temp.search('e2', 2, 'emergency', 'Amaka', 'Okafor', '1990-05-01', null, null));
select pg_temp.check_case('8 a reason under 8 characters', '22023 PATIENT_SEARCH_REASON_REQUIRED',
  pg_temp.search('e3', 2, 'emergency', 'Amaka', 'Okafor', '1990-05-01', null, null, '  Hurry  '));
select pg_temp.check_case('8 a reason over 500 characters', '22023 PATIENT_SEARCH_REASON_REQUIRED',
  pg_temp.search('e4', 2, 'emergency', 'Amaka', 'Okafor', '1990-05-01', null, null, repeat('x', 501)));
select pg_temp.check_case('8 a Health ID is not an emergency key', '22023 PATIENT_SEARCH_EMERGENCY_KEYS',
  pg_temp.search('e5', 2, 'emergency', 'Amaka', 'Okafor', '1990-05-01', 'HID-QSAA22', null, 'Unconscious patient'));
select pg_temp.check_case('8 nor a phone', '22023 PATIENT_SEARCH_EMERGENCY_KEYS',
  pg_temp.search('e6', 2, 'emergency', 'Amaka', 'Okafor', '1990-05-01', null, array[repeat('a', 64)],
    'Unconscious patient'));
select pg_temp.check_case('8 the date of birth is needed', '22023 PATIENT_SEARCH_EMERGENCY_KEYS',
  pg_temp.search('e7', 2, 'emergency', 'Amaka', 'Okafor', null, null, null, 'Unconscious patient'));
select pg_temp.check_case('8 the front desk has no break-glass permission', '42501 PATIENT_SEARCH_NOT_PERMITTED',
  pg_temp.search('e8', 1, 'emergency', 'Amaka', 'Okafor', '1990-05-01', null, null, 'Unconscious patient'));
select pg_temp.check_case('8 nor lab staff', '42501 PATIENT_SEARCH_NOT_PERMITTED',
  pg_temp.search('e9', 3, 'emergency', 'Amaka', 'Okafor', '1990-05-01', null, null, 'Unconscious patient'));
select pg_temp.check_case('8 only under the emergency purpose', '22023 PATIENT_SEARCH_PURPOSE',
  pg_temp.search('e10', 2, 'emergency', 'Amaka', 'Okafor', '1990-05-01', null, null, 'Unconscious patient',
    'direct-care'));
select pg_temp.check_case('8 five matches', 'found/everywhere/5:AA22,BA22,CA22,DA22,EA22',
  pg_temp.search('e11', 2, 'emergency', 'Femi', 'Ola', '2000-01-01', null, null, 'Unconscious patient'));
select pg_temp.check_case('8 six or more matches', 'too_many/everywhere/0',
  pg_temp.search('e12', 2, 'emergency', 'Kemi', 'Ade', '2000-01-01', null, null, 'Unconscious patient'));
select pg_temp.check_case('8 inactive and sealed are not found', 'no_match/everywhere/0',
  pg_temp.search('e13', 2, 'emergency', 'Chika', 'Eze', '1970-03-03', null, null, 'Unconscious patient'));
select pg_temp.check_case('8 a nurse at another facility finds anyone', 'found/everywhere/2:AA22,AB22',
  pg_temp.search('e14', 6, 'emergency', 'Amaka', 'Okafor', '1990-05-01', null, null, 'Collapsed at the gate'));
select set_config('search_test.e1_ref', (select match_ref from pg_temp.search_answers where label = 'e1' and health_id_last4 = 'AA22'), true);
select pg_temp.as_member(2, 'emergency');
select pg_temp.check_case('8 the emergency matchRef resolves for emergency', 'e1320400-0000-4000-8000-000000000001',
  identity.resolve_patient_search_ref(current_setting('search_test.e1_ref'), 'emergency')::text);
select pg_temp.as_member(2);
select pg_temp.check_case('8 and not for direct care', '(null)',
  identity.resolve_patient_search_ref(current_setting('search_test.e1_ref'), 'direct-care')::text);
-- 8b. Break-glass by the emergency card's matchRef (ID-5): the member who
-- searched, under the emergency purpose, opens the patient behind the card;
-- a replay finds the same grant; another member's ref, a direct-care ref and
-- a malformed ref are refused as an unknown Health ID is. (Correlation ids
-- outside 'search-suite-' keep section 9's search counts as they are.)
select pg_temp.as_member(2, 'emergency');
select set_config('app.correlation_id', 'bg-suite-1', true);
select pg_temp.check_case('8b break-glass by the emergency matchRef', 'active/e1320400-0000-4000-8000-000000000001/f',
  (select format('%s/%s/%s', grant_status, subject_patient_id, existing_grant)
     from identity.activate_break_glass_by_match_ref(current_setting('search_test.e1_ref'),
       'Unconscious patient brought in by ambulance', 60)));
select set_config('app.correlation_id', 'bg-suite-2', true);
select pg_temp.check_case('8b a replay finds the same grant', 'active/t',
  (select format('%s/%s', grant_status, existing_grant)
     from identity.activate_break_glass_by_match_ref(current_setting('search_test.e1_ref'),
       'Unconscious patient brought in by ambulance', 60)));
select pg_temp.as_member(6, 'emergency');
select set_config('app.correlation_id', 'bg-suite-3', true);
select pg_temp.check_case('8b another member''s matchRef is refused', 'P0002 Patient is not available',
  pg_temp.try($q$select * from identity.activate_break_glass_by_match_ref(current_setting('search_test.e1_ref'),
    'Unconscious patient brought in by ambulance', 60)$q$));
select pg_temp.as_member(1, 'emergency');
select set_config('app.correlation_id', 'bg-suite-4', true);
select pg_temp.check_case('8b a direct-care matchRef is refused', 'P0002 Patient is not available',
  pg_temp.try($q$select * from identity.activate_break_glass_by_match_ref(current_setting('search_test.p1_ref'),
    'Unconscious patient brought in by ambulance', 60)$q$));
select pg_temp.check_case('8b a malformed matchRef is refused', 'P0002 Patient is not available',
  pg_temp.try($q$select * from identity.activate_break_glass_by_match_ref('psr_short',
    'Unconscious patient brought in by ambulance', 60)$q$));
reset role;
update platform.control_settings set enabled = false where control_key = 'break_glass_enabled';
set local role hid_identity_api_runtime;
select pg_temp.check_case('8 the control off', '55000 PLATFORM_CONTROL_DISABLED:break_glass_enabled',
  pg_temp.search('e15', 2, 'emergency', 'Amaka', 'Okafor', '1990-05-01', null, null, 'Unconscious patient'));
select pg_temp.check_case('8 a standard search does not need the control', 'found/everywhere/2:AA22,AB22',
  pg_temp.search('e16', 2, 'standard', 'Amaka', 'Okafor', '1990-05-01', null, null));
reset role;
update platform.control_settings set enabled = true where control_key = 'break_glass_enabled';

-- 9. Audit.
create temporary table search_events on commit drop as
  select event.*, substr(event.correlation_id, 14) as label from audit.events event
   where event.correlation_id like 'search-suite-%';
select pg_temp.check_case('9 one row for each search that answered', 'true',
  (select ((select count(distinct label) from pg_temp.search_answers)
     = (select count(*) from pg_temp.search_events
         where action in ('identity.patient.search', 'identity.patient.emergency-search')))::text));
select pg_temp.check_case('9 refused searches write nothing here', '0',
  (select count(*)::text from pg_temp.search_events
    where label in ('r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'e2', 'e3', 'e4', 'e5', 'e6',
                    'e7', 'e8', 'e9', 'e10', 'e15')));
select pg_temp.check_case('9 too broad is denied', 'true',
  (select ((select count(*) from pg_temp.search_answers where outcome = 'too_broad')
     = (select count(*) from pg_temp.search_events where outcome = 'denied')
     and (select count(*) from pg_temp.search_events where outcome = 'denied') = 5)::text));
select pg_temp.check_case('9 one row for each patient shown', 'true',
  (select ((select count(*) from pg_temp.search_answers where match_ref is not null)
     = (select count(*) from pg_temp.search_events
         where action in ('identity.patient.search.shown', 'identity.patient.emergency-search.shown')
           and patient_id is not null))::text));
select pg_temp.check_case('9 the search row of s6', 'success/patient-search/["last_name", "phone"]/'
    || repeat('c', 64) || '/found/everywhere/1/["e1320400-0000-4000-8000-000000000003"]/direct-care/(none)',
  (select format('%s/%s/%s/%s/%s/%s/%s/%s/%s/%s', outcome, resource_type, details -> 'criteria',
     details ->> 'criteriaHash', details ->> 'outcome', details ->> 'reach', details ->> 'resultCount',
     details -> 'patientIds', purpose_of_use, coalesce(reason, '(none)'))
     from pg_temp.search_events where label = 's6' and action = 'identity.patient.search'));
select pg_temp.check_case('9 the emergency search row', 'success/["first_name", "last_name", "date_of_birth"]/found/2/emergency/Unconscious patient brought in by ambulance',
  (select format('%s/%s/%s/%s/%s/%s', outcome, details -> 'criteria', details ->> 'outcome',
     details ->> 'resultCount', purpose_of_use, reason)
     from pg_temp.search_events where label = 'e1' and action = 'identity.patient.emergency-search'));
select pg_temp.check_case('9 the Health ID outcome is recorded', 'no_such_health_id',
  (select details ->> 'outcome' from pg_temp.search_events where label = 'h1' and action = 'identity.patient.search'));
select pg_temp.check_case('9 no name, date of birth, Health ID or phone HMAC in any row', '0',
  (select count(*)::text from pg_temp.search_events
    where (details::text || coalesce(resource_id, '') || coalesce(reason, ''))
          ~* '(amaka|okafor|adeyemi|bakare|kemi|ngozi|1990-05-01|1985-02-02|HID-|aaaaaaaa|bbbbbbbb)'));
select pg_temp.check_case('9 shown rows name the patient and the member', 'true',
  (select bool_and(patient_id is not null and resource_id = patient_id::text and actor_membership_id is not null
     and facility_id is not null and actor_type = 'staff' and provenance = 'application')::text
     from pg_temp.search_events where action like '%.shown'));

-- 10. The patient's access log (owner Q104), in the patient's own session.
select set_config('app.actor_subject', 'synthetic:search-patient-1', true), set_config('app.membership_id', '', true),
  set_config('app.facility_id', '', true), set_config('app.correlation_id', 'search-suite-patient-1', true),
  set_config('app.purpose_of_use', '', true);
-- (8b's break-glass by matchRef is shown as the emergency access it is.)
select pg_temp.check_case('10 the emergency searches are shown, a standard search is not',
  'found_in_emergency_search|found_in_emergency_search|emergency_access',
  (select string_agg(entry ->> 'action', '|' order by entry ->> 'at')
     from jsonb_array_elements(identity.patient_self_access_log('synthetic:search-patient-1',
       'e1320a00-0000-4000-8000-000000000001', 50, null, null) -> 'events') entry));
select pg_temp.check_case('10 at which facility and by whom',
  'Search Clinic A/Bola Doctor/clinician|Search Clinic A/Bola Doctor/clinician|Search Clinic B/Femi Doctor/clinician',
  (select string_agg(format('%s/%s/%s', entry ->> 'facilityName', entry ->> 'actorName', entry ->> 'actorKind'), '|'
       order by entry ->> 'facilityName')
     from jsonb_array_elements(identity.patient_self_access_log('synthetic:search-patient-1',
       'e1320a00-0000-4000-8000-000000000001', 50, null, null) -> 'events') entry));

-- 11. Structure.
select pg_temp.check_case('11 functions', 'identity.resolve_patient_search_ref(text,text)/s/t/{"search_path=pg_catalog, pg_temp"}/t|identity.staff_patient_search(text,text,text,date,text,text[],text,text)/v/t/{"search_path=pg_catalog, pg_temp"}/t',
  (select string_agg(format('%s/%s/%s/%s/%s', proc.oid::regprocedure, proc.provolatile, proc.prosecdef, proc.proconfig,
       proc.proowner = (select proowner from pg_proc
                         where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure)),
       '|' order by proc.proname)
     from pg_proc proc
    where proc.oid in ('identity.staff_patient_search(text, text, text, date, text, text[], text, text)'::regprocedure,
                       'identity.resolve_patient_search_ref(text, text)'::regprocedure)));
select pg_temp.check_case('11 EXECUTE for the Identity runtime only', 'hid_identity_runtime|hid_identity_runtime',
  (select string_agg(pg_get_userbyid(acl.grantee), '|' order by pg_get_userbyid(acl.grantee))
     from pg_proc proc, lateral aclexplode(proc.proacl) acl
    where proc.oid in ('identity.staff_patient_search(text, text, text, date, text, text[], text, text)'::regprocedure,
                       'identity.resolve_patient_search_ref(text, text)'::regprocedure)
      and acl.grantee <> proc.proowner));
select pg_temp.check_case('11 no other runtime may search', '0',
  (select count(*)::text from pg_roles role
    where role.rolname like 'hid\_%\_runtime' and role.rolname not like 'hid\_identity%'
      and (has_function_privilege(role.oid, 'identity.staff_patient_search(text, text, text, date, text, text[], text, text)', 'execute')
        or has_function_privilege(role.oid, 'identity.resolve_patient_search_ref(text, text)', 'execute'))));
select pg_temp.check_case('11 the table: row-level security, same owner, no privilege', 't/t/0',
  (select format('%s/%s/%s', rel.relrowsecurity,
     rel.relowner = (select proowner from pg_proc
                      where oid = 'identity.staff_patient_search(text, text, text, date, text, text[], text, text)'::regprocedure),
     (select count(*) from aclexplode(rel.relacl) acl where acl.grantee <> rel.relowner))
     from pg_class rel where rel.oid = 'identity.patient_search_refs'::regclass));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.search_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0132 staff patient search:\n%', mismatch;
  end if;
  raise notice '0132 staff patient search: % cases passed', (select count(*) from pg_temp.search_outcomes);
end $$;

rollback;
