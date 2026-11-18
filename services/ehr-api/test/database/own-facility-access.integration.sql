\set ON_ERROR_STOP on
-- 0131 (ID-4, owner Q101 of 18 November 2026): a doctor, nurse or clinician
-- opens this facility's own patient without a PIN. Rollback-only. Every
-- command runs as Identity's runtime role in the context Identity's
-- transactions set. Fictional people, places and identifiers only; ids start
-- e1310.
--
--   1. each basis opens: a NIN registration that created the patient, one
--      that resolved the patient's own checked NIN, one without a NIN that
--      created the patient, one without a NIN that was linked and then
--      confirmed by the patient's PIN, and a consented visit in the last 24
--      months; the grant is own_facility, 24 hours, write, direct care, no
--      access request; a second opening reuses it;
--   2. none of these is a basis: a visit 25 months ago, a cancelled or
--      entered-in-error visit, a check-in visit (no grant from the patient),
--      a visit started under an own-facility grant or under records
--      processing, imported paper records, a link without a NIN the patient
--      never confirmed, a NIN case that never attached its NIN, a basis at
--      another facility;
--   3. refusals: the front desk, lab and pharmacy staff (no permission);
--      another facility; a deny directive; another purpose; both or neither
--      identifier; an unknown Health ID, an inactive patient and a sealed
--      patient answer not_found;
--   4. the grant passes the EHR check and does not give records-processing
--      cover; the "records opened" notice is noted as own_facility;
--   5. the patient's side: the history shows basis own-facility, revocable;
--      the patient revokes it; reopening here is refused for 24 hours;
--   6. every opening and every refusal the command answers writes one audit
--      row (a refusal it raises, such as no permission, writes none here:
--      identity-api audits those).
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.
begin;

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'own-facility-test'),
  ('healthcare-operations', 'Records processing', 'own-facility-test')
  on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1310000-0000-4000-8000-000000000001', 'Own Facility Group A', 'own-facility-group-a'),
  ('e1310000-0000-4000-8000-000000000011', 'Own Facility Group B', 'own-facility-group-b');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1310000-0000-4000-8000-000000000002', 'e1310000-0000-4000-8000-000000000001', 'Own Facility Clinic A',
   'OWN-FAC-A', 'Africa/Lagos', true, 'verified'),
  ('e1310000-0000-4000-8000-000000000012', 'e1310000-0000-4000-8000-000000000011', 'Own Facility Clinic B',
   'OWN-FAC-B', 'Africa/Lagos', true, 'verified');
create temporary table own_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into own_members values
  (1, 'e1310000-0000-4000-8000-000000000002', 'e1310000-0000-4000-8000-000000000001', 'doctor', 'Ada Doctor'),
  (2, 'e1310000-0000-4000-8000-000000000002', 'e1310000-0000-4000-8000-000000000001', 'nurse', 'Bola Nurse'),
  (3, 'e1310000-0000-4000-8000-000000000002', 'e1310000-0000-4000-8000-000000000001', 'clinician', 'Chidi Clinician'),
  (4, 'e1310000-0000-4000-8000-000000000002', 'e1310000-0000-4000-8000-000000000001', 'receptionist', 'Dayo Desk'),
  (5, 'e1310000-0000-4000-8000-000000000002', 'e1310000-0000-4000-8000-000000000001', 'lab', 'Efe Lab'),
  (6, 'e1310000-0000-4000-8000-000000000002', 'e1310000-0000-4000-8000-000000000001', 'pharmacist', 'Femi Pharmacist'),
  (7, 'e1310000-0000-4000-8000-000000000002', 'e1310000-0000-4000-8000-000000000001', 'doctor', 'Gbenga Doctor'),
  (8, 'e1310000-0000-4000-8000-000000000012', 'e1310000-0000-4000-8000-000000000011', 'doctor', 'Hauwa Doctor');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1310100-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:own-member-' || n,
  'own-member-' || n || '@example.invalid', name, 'active' from own_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1310200-0000-4000-8000-00000000000' || n)::uuid, ('e1310100-0000-4000-8000-00000000000' || n)::uuid,
  name, 'own-member-' || n || '@example.invalid', 'verified', role_code from own_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1310300-0000-4000-8000-00000000000' || n)::uuid, ('e1310200-0000-4000-8000-00000000000' || n)::uuid,
  ('e1310100-0000-4000-8000-00000000000' || n)::uuid, organization, facility, role_code, role_code, true, true
from own_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('e1310100-0000-4000-8000-00000000000' || n)::uuid, role_code, 'facility',
  ('e1310300-0000-4000-8000-00000000000' || n)::uuid, facility, 'Synthetic own-facility suite role'
from own_members;

-- Patients (Health IDs HID-QF + two letters): p1 .. p20; p12 inactive; p13 sealed.
create temporary table own_patients (n integer primary key, hid text, status text, source text) on commit drop;
insert into own_patients values
  (1, 'HID-QFAA22', 'active', 'hid-nin-registration'),   -- NIN registration created it here
  (2, 'HID-QFAB22', 'active', 'hid'),                    -- resolved to its own checked NIN here
  (3, 'HID-QFAC22', 'active', 'hid-desk-registration'),  -- created here without a NIN
  (4, 'HID-QFAD22', 'active', 'hid'),                    -- linked here without a NIN, never confirmed
  (5, 'HID-QFAE22', 'active', 'hid'),                    -- linked here without a NIN, then the patient's PIN
  (6, 'HID-QFAF22', 'active', 'hid'),                    -- consented visit 23 months ago
  (7, 'HID-QFAG22', 'active', 'hid'),                    -- consented visit 25 months ago
  (8, 'HID-QFAH22', 'active', 'hid'),                    -- consented visits, cancelled and entered in error
  (9, 'HID-QFAJ22', 'active', 'hid'),                    -- check-in visit (no grant from the patient)
  (10, 'HID-QFAK22', 'active', 'hid'),                   -- visit under an own-facility grant only
  (11, 'HID-QFAL22', 'active', 'hid'),                   -- visit under records processing; imported paper records
  (12, 'HID-QFAM22', 'inactive', 'hid-nin-registration'),-- inactive, registered here
  (13, 'HID-QFAN22', 'active', 'hid-nin-registration'),  -- sealed demo, registered here
  (14, 'HID-QFAP22', 'active', 'hid'),                   -- NIN case linked here that never attached its NIN
  (15, 'HID-QFAQ22', 'active', 'hid'),                   -- consented visit at facility B only
  (16, 'HID-QFAR22', 'active', 'hid-nin-registration');  -- registered here, with a deny directive
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, status, source_system)
select ('e1310400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, hid, 'Patient', 'Number' || n,
  'Patient Number' || n, '1980-01-01', status, source from own_patients;
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('patient', 'e1310400-0000-4000-8000-000000000013');

-- Registration cases at A (member 4, the desk; reviewed by member 1 where decided).
create temporary table own_cases (n integer primary key, patient integer, status text, evidence text,
  hmac text, facility uuid) on commit drop;
insert into own_cases values
  (1, 1, 'approved_new_identity', 'nin_verified', repeat('1', 64), 'e1310000-0000-4000-8000-000000000002'),
  (2, 2, 'resolved_existing_identity', 'nin_verified', repeat('2', 64), 'e1310000-0000-4000-8000-000000000002'),
  (3, 3, 'approved_new_identity', 'none', null, 'e1310000-0000-4000-8000-000000000002'),
  (4, 4, 'linked_existing', 'none', null, 'e1310000-0000-4000-8000-000000000002'),
  (5, 5, 'linked_existing', 'none', null, 'e1310000-0000-4000-8000-000000000002'),
  (12, 12, 'approved_new_identity', 'nin_verified', repeat('c', 64), 'e1310000-0000-4000-8000-000000000002'),
  (13, 13, 'approved_new_identity', 'nin_verified', repeat('d', 64), 'e1310000-0000-4000-8000-000000000002'),
  (14, 14, 'linked_existing', 'nin_verified', repeat('e', 64), 'e1310000-0000-4000-8000-000000000002'),
  (16, 16, 'approved_new_identity', 'nin_verified', repeat('f', 64), 'e1310000-0000-4000-8000-000000000002');
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, nin_ciphertext, nin_lookup_hmac, nin_last4,
  nin_key_version, verification_provider, verification_reference, verified_at, idempotency_key, request_sha256,
  resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id,
  review_reason, created_at, updated_at)
select ('e1310500-0000-4000-8000-0000000000' || lpad(c.n::text, 2, '0'))::uuid, c.facility,
  'e1310100-0000-4000-8000-000000000004', 'e1310300-0000-4000-8000-000000000004', c.status,
  'Patient', 'Number' || c.patient, 'Patient Number' || c.patient, '1980-01-01', c.evidence,
  case when c.evidence = 'none' then 'no_nin' end,
  case when c.evidence = 'nin_verified' then decode(repeat('ab', 32), 'hex') end, c.hmac,
  case when c.evidence = 'nin_verified' then '1234' end, case when c.evidence = 'nin_verified' then 'k1' end,
  case when c.evidence = 'nin_verified' then 'fixture' end, case when c.evidence = 'nin_verified' then 'ref' end,
  case when c.evidence = 'nin_verified' then clock_timestamp() - interval '30 days' end,
  'own-case-key-00000' || lpad(c.n::text, 2, '0'), repeat('0', 64),
  ('e1310400-0000-4000-8000-0000000000' || lpad(c.patient::text, 2, '0'))::uuid,
  case when c.status <> 'resolved_existing_identity' then 'own-review-key-0000' || lpad(c.n::text, 2, '0') end,
  case when c.status <> 'resolved_existing_identity' then repeat('0', 64) end,
  case when c.status <> 'resolved_existing_identity' then 'e1310100-0000-4000-8000-000000000001'::uuid end,
  case when c.status <> 'resolved_existing_identity' then 'e1310300-0000-4000-8000-000000000001'::uuid end,
  case when c.status <> 'resolved_existing_identity' then 'Checked at the desk' end,
  clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days'
from own_cases c;
-- The NIN identifiers: cases 1, 12, 13, 16 attached theirs; patient 2 holds the NIN case 2 resolved to (from an
-- earlier registration elsewhere); case 14 attached nothing.
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, display_hint, verified, verified_at, verification_provider, verification_reference,
  registration_case_id)
select ('e1310600-0000-4000-8000-0000000000' || lpad(c.n::text, 2, '0'))::uuid,
  ('e1310400-0000-4000-8000-0000000000' || lpad(c.patient::text, 2, '0'))::uuid, 'nin', decode(repeat('ab', 32), 'hex'),
  c.hmac, 'k1', '****1234', true, clock_timestamp() - interval '30 days', 'fixture', 'ref',
  case when c.n = 2 then 'e1310500-0000-4000-8000-000000000099'::uuid
       else ('e1310500-0000-4000-8000-0000000000' || lpad(c.n::text, 2, '0'))::uuid end
from own_cases c where c.n in (1, 2, 12, 13, 16);

-- Grants and visits. A patient's approval (granted_by_patient_id) or PIN to member 1 (or 8 at B) when the visit
-- was created; an own-facility grant (p10); records processing (p11).
create temporary table own_visits (n integer primary key, patient integer, member integer, facility uuid,
  started interval, status text, method text, purpose text, imported boolean) on commit drop;
insert into own_visits values
  (1, 6, 1, 'e1310000-0000-4000-8000-000000000002', interval '23 months', 'completed', 'approval', 'direct-care', false),
  (2, 7, 1, 'e1310000-0000-4000-8000-000000000002', interval '25 months', 'completed', 'pin', 'direct-care', false),
  (3, 8, 1, 'e1310000-0000-4000-8000-000000000002', interval '2 months', 'cancelled', 'approval', 'direct-care', false),
  (4, 8, 1, 'e1310000-0000-4000-8000-000000000002', interval '1 month', 'entered_in_error', 'approval', 'direct-care', false),
  (5, 9, 4, 'e1310000-0000-4000-8000-000000000002', interval '1 month', 'completed', null, null, false),
  (6, 10, 1, 'e1310000-0000-4000-8000-000000000002', interval '1 month', 'completed', 'own_facility', 'direct-care', false),
  (7, 11, 1, 'e1310000-0000-4000-8000-000000000002', interval '1 month', 'completed', 'approval', 'healthcare-operations', false),
  (8, 11, 1, 'e1310000-0000-4000-8000-000000000002', interval '3 months', 'completed', 'pin', 'direct-care', true),
  (9, 15, 8, 'e1310000-0000-4000-8000-000000000012', interval '1 month', 'completed', 'approval', 'direct-care', false);
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass, authorization_method,
  created_at)
select ('e1310700-0000-4000-8000-0000000000' || lpad(v.n::text, 2, '0'))::uuid, null,
  ('e1310400-0000-4000-8000-0000000000' || lpad(v.patient::text, 2, '0'))::uuid,
  ('e1310200-0000-4000-8000-00000000000' || v.member)::uuid, ('e1310100-0000-4000-8000-00000000000' || v.member)::uuid,
  ('e1310300-0000-4000-8000-00000000000' || v.member)::uuid, v.facility, 'write_records', v.purpose, 'expired',
  case when v.method = 'approval' then ('e1310400-0000-4000-8000-0000000000' || lpad(v.patient::text, 2, '0'))::uuid end,
  'Fixture grant', clock_timestamp() - v.started - interval '1 hour', clock_timestamp() - v.started + interval '23 hours',
  false, case when v.method in ('pin', 'own_facility') then
    case v.method when 'pin' then 'patient_access_pin' else 'own_facility' end end,
  clock_timestamp() - v.started - interval '1 hour'
from own_visits v where v.method is not null;
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, ended_at, chief_complaint, created_at, imported_paper_records)
select ('e1310800-0000-4000-8000-0000000000' || lpad(v.n::text, 2, '0'))::uuid,
  ('e1310400-0000-4000-8000-0000000000' || lpad(v.patient::text, 2, '0'))::uuid, v.facility,
  ('e1310100-0000-4000-8000-00000000000' || v.member)::uuid, ('e1310300-0000-4000-8000-00000000000' || v.member)::uuid,
  case when v.imported then 'other' else 'ambulatory' end, v.status, statement_timestamp() - v.started,
  case when v.status = 'completed' then statement_timestamp() - v.started end,
  case when v.imported then 'Imported paper records (Migrate)' else 'Fixture visit' end,
  statement_timestamp() - v.started, v.imported
from own_visits v;
-- p5: after its link without a NIN (30 days ago), the patient gave member 7 their PIN.
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, authorization_method, created_at) values
  ('e1310700-0000-4000-8000-000000000020', null, 'e1310400-0000-4000-8000-000000000005',
   'e1310200-0000-4000-8000-000000000007', 'e1310100-0000-4000-8000-000000000007',
   'e1310300-0000-4000-8000-000000000007', 'e1310000-0000-4000-8000-000000000002', 'write_records', 'direct-care',
   'expired', 'Patient access PIN verification', clock_timestamp() - interval '10 days',
   clock_timestamp() - interval '9 days', false, 'patient_access_pin', clock_timestamp() - interval '10 days');
-- p16: a deny directive for every action and purpose.
insert into identity.consent_directives (id, patient_id, current_version)
values ('e1310900-0000-4000-8000-000000000001', 'e1310400-0000-4000-8000-000000000016', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  starts_at, grantee_type, actions, purposes, source_reference, reason, content_sha256)
values ('e1310900-0000-4000-8000-000000000002', 'e1310900-0000-4000-8000-000000000001',
  'e1310400-0000-4000-8000-000000000016', 1, 'active', 'deny', clock_timestamp() - interval '1 day', 'all',
  array[]::text[], array[]::text[], 'own-facility-suite', 'The patient refuses all access', repeat('0', 64));
-- p1's patient login and live session, for the patient's side.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1310100-0000-4000-8000-000000000099', 'synthetic:own-patient-1', 'own-patient-1@example.invalid', 'Own Patient', 'active');
update identity.patients set account_id = 'e1310100-0000-4000-8000-000000000099'
 where id = 'e1310400-0000-4000-8000-000000000001';
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('e1310a00-0000-4000-8000-000000000001', 'e1310100-0000-4000-8000-000000000099',
   'e1310a00-0000-4000-8000-000000000001', md5('own-patient') || md5('own-patient'), gen_random_uuid(), 1,
   'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
   'patient', 'e1310400-0000-4000-8000-000000000001');
set local session_replication_role = origin;

create temporary table own_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
grant select, insert on pg_temp.own_outcomes to hid_identity_api_runtime;
grant usage on sequence pg_temp.own_outcomes_seq_seq to hid_identity_api_runtime;
grant select on pg_temp.own_members to hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.own_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.as_member(n integer, purpose text default 'direct-care') returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:own-member-' || n, true),
    set_config('app.membership_id', 'e1310300-0000-4000-8000-00000000000' || n, true),
    set_config('app.facility_id', (select facility::text from pg_temp.own_members where own_members.n = as_member.n), true),
    set_config('app.correlation_id', 'own-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;
-- One opening: outcome/basis/existing, or the refusal's code and message.
create function pg_temp.open(n integer, hid text, patient uuid, purpose text default 'direct-care') returns text
language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n, purpose);
  select * into answer from identity.open_own_facility_patient(hid, patient);
  perform set_config('own_test.last_grant', coalesce(answer.consent_grant_id::text, ''), true);
  return format('%s/%s/%s', answer.outcome, coalesce(answer.basis, '-'), answer.existing_grant::text);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

set local role hid_identity_api_runtime;

-- 1. Each basis opens.
select pg_temp.check_case('1 NIN registration created it', 'opened/own-facility/false',
  pg_temp.open(1, 'HID-QFAA22', null));
select set_config('own_test.p1_grant', current_setting('own_test.last_grant'), true);
select pg_temp.check_case('1 a second opening reuses the grant', 'opened/own-facility/true',
  pg_temp.open(1, 'hid-qfaa22', null));
select pg_temp.check_case('1 the same grant', 'true',
  (current_setting('own_test.last_grant') = current_setting('own_test.p1_grant'))::text);
select pg_temp.check_case('1 resolved to its own checked NIN', 'opened/own-facility/false',
  pg_temp.open(2, null, 'e1310400-0000-4000-8000-000000000002'));
select pg_temp.check_case('1 created here without a NIN', 'opened/own-facility/false',
  pg_temp.open(3, 'HID-QFAC22', null));
select pg_temp.check_case('1 linked without a NIN, then the patient''s PIN', 'opened/own-facility/false',
  pg_temp.open(1, 'HID-QFAE22', null));
select pg_temp.check_case('1 a consented visit 23 months ago', 'opened/own-facility/false',
  pg_temp.open(2, 'HID-QFAF22', null));

-- 2. Not a basis.
select pg_temp.check_case('2 a visit 25 months ago', 'refused/-/false', pg_temp.open(1, 'HID-QFAG22', null));
select pg_temp.check_case('2 cancelled and entered-in-error visits', 'refused/-/false', pg_temp.open(1, 'HID-QFAH22', null));
select pg_temp.check_case('2 a check-in visit', 'refused/-/false', pg_temp.open(1, 'HID-QFAJ22', null));
select pg_temp.check_case('2 a visit under an own-facility grant', 'refused/-/false', pg_temp.open(1, 'HID-QFAK22', null));
select pg_temp.check_case('2 records processing and imported paper records', 'refused/-/false',
  pg_temp.open(1, 'HID-QFAL22', null));
select pg_temp.check_case('2 a link without a NIN never confirmed', 'refused/-/false', pg_temp.open(1, 'HID-QFAD22', null));
select pg_temp.check_case('2 a NIN case that attached nothing', 'refused/-/false', pg_temp.open(1, 'HID-QFAP22', null));
select pg_temp.check_case('2 a visit at another facility only', 'refused/-/false', pg_temp.open(1, 'HID-QFAQ22', null));
select pg_temp.check_case('2 that visit is facility B''s', 'opened/own-facility/false', pg_temp.open(8, 'HID-QFAQ22', null));

-- 3. Refusals.
select pg_temp.check_case('3 front desk', '42501 OWN_FACILITY_ACCESS_NOT_PERMITTED', pg_temp.open(4, 'HID-QFAA22', null));
select pg_temp.check_case('3 lab', '42501 OWN_FACILITY_ACCESS_NOT_PERMITTED', pg_temp.open(5, 'HID-QFAA22', null));
select pg_temp.check_case('3 pharmacy', '42501 OWN_FACILITY_ACCESS_NOT_PERMITTED', pg_temp.open(6, 'HID-QFAA22', null));
select pg_temp.check_case('3 another facility', 'refused/-/false', pg_temp.open(8, 'HID-QFAA22', null));
select pg_temp.check_case('3 deny directive', 'refused/-/false', pg_temp.open(1, 'HID-QFAR22', null));
select pg_temp.check_case('3 another purpose', '22023 OWN_FACILITY_ACCESS_DIRECT_CARE_ONLY',
  pg_temp.open(1, 'HID-QFAA22', null, 'emergency'));
select pg_temp.check_case('3 both identifiers', '22023 OWN_FACILITY_ACCESS_INVALID',
  pg_temp.open(1, 'HID-QFAA22', 'e1310400-0000-4000-8000-000000000001'));
select pg_temp.check_case('3 neither identifier', '22023 OWN_FACILITY_ACCESS_INVALID', pg_temp.open(1, null, null));
select pg_temp.check_case('3 unknown Health ID', 'not_found/-/false', pg_temp.open(1, 'HID-QFZZ99', null));
select pg_temp.check_case('3 inactive patient', 'not_found/-/false', pg_temp.open(1, 'HID-QFAM22', null));
select pg_temp.check_case('3 sealed patient', 'not_found/-/false', pg_temp.open(1, 'HID-QFAN22', null));

-- 4. The grant passes the EHR check, gives no records-processing cover, and is noted.
select pg_temp.as_member(1);
select pg_temp.check_case('4 EHR write check', 'true',
  identity.has_active_consent_grant('e1310400-0000-4000-8000-000000000001', 'synthetic:own-member-1',
    'e1310300-0000-4000-8000-000000000001', 'e1310000-0000-4000-8000-000000000002', 'write_records', 'direct-care')::text);
select pg_temp.check_case('4 no other member', 'false',
  identity.has_active_consent_grant('e1310400-0000-4000-8000-000000000001', 'synthetic:own-member-7',
    'e1310300-0000-4000-8000-000000000007', 'e1310000-0000-4000-8000-000000000002', 'read_records', 'direct-care')::text);
select pg_temp.check_case('4 the notice', 'noted', identity.note_record_access(current_setting('own_test.p1_grant')::uuid));

reset role;
select pg_temp.check_case('4 no records-processing cover', '0',
  (select count(*)::text from identity.records_processing_direct_care_cover('e1310400-0000-4000-8000-000000000001',
    'synthetic:own-member-1', 'e1310300-0000-4000-8000-000000000001', 'e1310000-0000-4000-8000-000000000002',
    'read_records', clock_timestamp())));
select pg_temp.check_case('4 the grant', 'write_records/direct-care/own_facility/1440/t/t/t',
  (select format('%s/%s/%s/%s/%s/%s/%s', scope, purpose_of_use, authorization_method,
     extract(epoch from expires_at - starts_at)::integer / 60, request_id is null, granted_by_patient_id is null,
     reason = 'Opened as this facility''s patient')
     from identity.consent_grants where id = current_setting('own_test.p1_grant')::uuid));
select pg_temp.check_case('4 notice kind', 'own_facility',
  (select access_kind from identity.record_access_notices where consent_grant_id = current_setting('own_test.p1_grant')::uuid));

-- 5. The patient's side.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:own-patient-1', true), set_config('app.membership_id', '', true),
  set_config('app.facility_id', '', true), set_config('app.correlation_id', 'own-suite-patient-1', true),
  set_config('app.purpose_of_use', '', true);
reset role;
select pg_temp.check_case('5 history', 'own-facility/true',
  (select format('%s/%s', item ->> 'basis', item ->> 'revocableByPatient')
     from jsonb_array_elements(identity.patient_self_access_history('synthetic:own-patient-1',
       'e1310a00-0000-4000-8000-000000000001') -> 'items') item
    where item ->> 'consentGrantId' = current_setting('own_test.p1_grant')));
select pg_temp.check_case('5 revoked by the patient', 'revoked/false',
  (select format('%s/%s', grant_status, replayed::text) from identity.revoke_my_consent_grant('synthetic:own-patient-1',
    'e1310a00-0000-4000-8000-000000000001', current_setting('own_test.p1_grant')::uuid, 'I did not agree to this')));
set local role hid_identity_api_runtime;
select pg_temp.check_case('5 reopening here is refused', 'refused/-/false', pg_temp.open(1, 'HID-QFAA22', null));
select pg_temp.check_case('5 another member here too', 'refused/-/false', pg_temp.open(7, 'HID-QFAA22', null));

-- 6. Audit rows.
reset role;
select pg_temp.check_case('6 audit rows', 'denied:15/success:7',
  (select string_agg(format('%s:%s', outcome, count), '/' order by outcome)
     from (select outcome, count(*) from audit.events
            where action = 'identity.patient.open-own-facility'
              and facility_id in ('e1310000-0000-4000-8000-000000000002', 'e1310000-0000-4000-8000-000000000012')
            group by outcome) counted));
select pg_temp.check_case('6 refusal kinds', 'deny_directive:1/not_found:3/not_own_facility:9/revoked_by_patient:2',
  (select string_agg(format('%s:%s', kind, count), '/' order by kind)
     from (select details ->> 'refusal' as kind, count(*) from audit.events
            where action = 'identity.patient.open-own-facility' and outcome = 'denied'
              and facility_id in ('e1310000-0000-4000-8000-000000000002', 'e1310000-0000-4000-8000-000000000012')
            group by 1) counted));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.own_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0131 own-facility access:\n%', mismatch;
  end if;
  raise notice '0131 own-facility access: % cases passed', (select count(*) from pg_temp.own_outcomes);
end $$;

rollback;
