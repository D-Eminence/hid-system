\set ON_ERROR_STOP on
-- 0130 (ID-2, owner Q106 of 18 November 2026): registration at the front desk
-- without a NIN. Rollback-only. Every command runs as Identity's runtime role
-- in the context Identity's transactions set. Fictional people, places and
-- identifiers only; ids start e1300.
--
--   1. no possible duplicate: the same desk person creates the patient at
--      once (approved_new_identity, no NIN identifier, source
--      hid-desk-registration), with the contact, the facility contact, the
--      phone lookup, the event, the outbox event and one audit row that
--      carries no name, date of birth or phone;
--   2. an idempotent retry answers the same case; the same key with another
--      request is refused;
--   3. the phone rule: an adult without a phone is refused; a child (under
--      18) may have none; "child" for an adult is refused;
--   4. each possible-duplicate kind sends the case for review and creates no
--      patient: name and date of birth, phone, the stated Health ID, and an
--      open registration without a NIN;
--   5. a second person decides: the desk cannot; the case's creator cannot,
--      even as an approver; an approver at another facility cannot see it;
--      link-existing only to a candidate; the case's version; a replay;
--      create_new, link_existing and reject;
--   6. nothing writes a case without a NIN but the two commands, and a NIN
--      case can no longer be inserted already decided, or resolved to a
--      patient who does not hold its NIN (the NIN path is otherwise
--      unchanged);
--   7. no daily limit (owner Q109): a member's 21st today is created, and
--      the facility's count today is answered for the operations alert;
--   8. refusals: no registration permission, another purpose, a sealed
--      facility; the evidence shape check;
--   9. erasing the case contact deletes the phone lookup.
--
-- Each case records its outcome; the suite fails at the end listing every case
-- whose outcome differs.
begin;

set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e1300000-0000-4000-8000-000000000001', 'No NIN Test Group A', 'no-nin-test-group-a'),
  ('e1300000-0000-4000-8000-000000000011', 'No NIN Test Group B', 'no-nin-test-group-b'),
  ('e1300000-0000-4000-8000-000000000021', 'No NIN Sealed Group', 'no-nin-sealed-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1300000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001', 'No NIN Clinic A',
   'NO-NIN-A', 'Africa/Lagos', true, 'verified'),
  ('e1300000-0000-4000-8000-000000000012', 'e1300000-0000-4000-8000-000000000011', 'No NIN Clinic B',
   'NO-NIN-B', 'Africa/Lagos', true, 'verified'),
  ('e1300000-0000-4000-8000-000000000022', 'e1300000-0000-4000-8000-000000000021', 'No NIN Sealed Clinic',
   'NO-NIN-S', 'Africa/Lagos', true, 'verified');
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('facility', 'e1300000-0000-4000-8000-000000000022');
create temporary table nonin_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into nonin_members values
  (1, 'e1300000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001', 'receptionist', 'Ada Desk'),
  (2, 'e1300000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001', 'receptionist', 'Bola Desk'),
  (3, 'e1300000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001', 'admin', 'Chidi Approver'),
  (4, 'e1300000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001', 'lab', 'Dayo Lab'),
  (5, 'e1300000-0000-4000-8000-000000000012', 'e1300000-0000-4000-8000-000000000011', 'receptionist', 'Efe Desk'),
  (6, 'e1300000-0000-4000-8000-000000000012', 'e1300000-0000-4000-8000-000000000011', 'admin', 'Femi Approver'),
  (7, 'e1300000-0000-4000-8000-000000000022', 'e1300000-0000-4000-8000-000000000021', 'receptionist', 'Gbenga Sealed'),
  (8, 'e1300000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001', 'admin', 'Hauwa Approver');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1300100-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:nonin-member-' || n,
  'nonin-member-' || n || '@example.invalid', name, 'active' from nonin_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1300200-0000-4000-8000-00000000000' || n)::uuid, ('e1300100-0000-4000-8000-00000000000' || n)::uuid,
  name, 'nonin-member-' || n || '@example.invalid', 'verified', role_code from nonin_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1300300-0000-4000-8000-00000000000' || n)::uuid, ('e1300200-0000-4000-8000-00000000000' || n)::uuid,
  ('e1300100-0000-4000-8000-00000000000' || n)::uuid, organization, facility, role_code, role_code, true, true
from nonin_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('e1300100-0000-4000-8000-00000000000' || n)::uuid, role_code, 'facility',
  ('e1300300-0000-4000-8000-00000000000' || n)::uuid, facility, 'Synthetic no-NIN registration suite role'
from nonin_members;
-- Existing patients: 1 by name and date of birth; 2 by its sign-in phone
-- (hash 'b' x 64); 3 by Health ID; 4 is inactive with 1's name and date of birth.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, status,
  phone_e164_ciphertext, phone_lookup_hmac, contact_key_version) values
  ('e1300400-0000-4000-8000-000000000001', 'HID-NNA2B3', 'Ada', 'Okafor', 'Ada Okafor', '1980-01-02', 'active', null, null, null),
  ('e1300400-0000-4000-8000-000000000002', 'HID-NNC4D5', 'Bayo', 'Phone', 'Bayo Phone', '1975-05-05', 'active',
   decode(repeat('ab', 32), 'hex'), repeat('b', 64), 'k1'),
  ('e1300400-0000-4000-8000-000000000003', 'HID-NNE6F7', 'Chika', 'Stated', 'Chika Stated', '1970-07-07', 'active', null, null, null),
  ('e1300400-0000-4000-8000-000000000004', 'HID-NNG8H9', 'Ada', 'Okafor', 'Ada Okafor', '1980-01-02', 'inactive', null, null, null);
set local session_replication_role = origin;

create temporary table nonin_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
grant select, insert on pg_temp.nonin_outcomes to hid_identity_api_runtime;
grant select on pg_temp.nonin_members to hid_identity_api_runtime;
grant usage on sequence pg_temp.nonin_outcomes_seq_seq to hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.nonin_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;

create function pg_temp.as_member(n integer, purpose text default 'healthcare-operations') returns void
language sql as $f$
  select set_config('app.actor_subject', 'synthetic:nonin-member-' || n, true),
    set_config('app.membership_id', 'e1300300-0000-4000-8000-00000000000' || n, true),
    set_config('app.facility_id', (select facility::text from pg_temp.nonin_members where nonin_members.n = as_member.n), true),
    set_config('app.correlation_id', 'nonin-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;

-- One registration: the outcome as status/candidates/replayed/has-patient, or the refusal's code and message.
create function pg_temp.register(n integer, case_id uuid, first_name text, last_name text, dob date, reason text,
  phone_hmac text, stated text, idempotency_key text, request_sha text, hid text, purpose text default 'healthcare-operations')
returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n, purpose);
  select * into answer from identity.register_patient_without_nin(case_id, first_name, last_name, dob, 'female', reason,
    phone_hmac,
    case when phone_hmac is null then null else decode(repeat('11', 40), 'hex') end,
    case when phone_hmac is null then null else decode(repeat('22', 60), 'hex') end,
    case when phone_hmac is null then null else 'k1' end,
    stated, idempotency_key, request_sha, hid);
  return format('%s/%s/%s/%s', answer.case_status, answer.candidate_count, answer.replayed,
    answer.subject_patient_id is not null);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

create function pg_temp.review(n integer, case_id uuid, version bigint, decision text, patient uuid,
  idempotency_key text, request_sha text, hid text) returns text language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from identity.review_patient_without_nin(case_id, version, decision, patient,
    'Checked the person at the desk against the card', idempotency_key, request_sha, hid);
  return format('%s/%s/%s/%s', answer.case_status, answer.case_version, answer.replayed,
    answer.subject_patient_id is not null);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

set local role hid_identity_api_runtime;

-- 1. No possible duplicate: created at once by the same desk person.
select pg_temp.check_case('1 created at the desk', 'approved_new_identity/0/f/t',
  pg_temp.register(1, 'e1300500-0000-4000-8000-000000000001', 'Ngozi', 'Freshface', '1990-03-04', 'no_nin',
    repeat('c', 64), null, 'nonin-suite-key-0001', repeat('1', 64), 'HID-NNJ2K3'));

-- 2. Idempotent retry; the same key with another request.
select pg_temp.check_case('2 replay', 'approved_new_identity/0/t/t',
  pg_temp.register(1, 'e1300500-0000-4000-8000-000000000099', 'Ngozi', 'Freshface', '1990-03-04', 'no_nin',
    repeat('c', 64), null, 'nonin-suite-key-0001', repeat('1', 64), 'HID-NNJ2K4'));
select pg_temp.check_case('2 key reused', '22023 IDEMPOTENCY_KEY_REUSED',
  pg_temp.register(1, 'e1300500-0000-4000-8000-000000000098', 'Ngozi', 'Freshface', '1990-03-05', 'no_nin',
    repeat('c', 64), null, 'nonin-suite-key-0001', repeat('2', 64), 'HID-NNJ2K5'));

-- 3. The phone rule.
select pg_temp.check_case('3 adult without a phone', '22023 NO_NIN_REGISTRATION_PHONE_REQUIRED',
  pg_temp.register(1, 'e1300500-0000-4000-8000-000000000003', 'Tunde', 'Nophone', '1985-01-01', 'not_carried',
    null, null, 'nonin-suite-key-0003', repeat('3', 64), 'HID-NNL4M5'));
select pg_temp.check_case('3 child without a phone', 'approved_new_identity/0/f/t',
  pg_temp.register(1, 'e1300500-0000-4000-8000-000000000004', 'Little', 'Childname',
    ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '5 years')::date, 'child',
    null, null, 'nonin-suite-key-0004', repeat('4', 64), 'HID-NNN6P7'));
select pg_temp.check_case('3 child reason for an adult', '22023 NO_NIN_REGISTRATION_NOT_A_CHILD',
  pg_temp.register(1, 'e1300500-0000-4000-8000-000000000005', 'Grown', 'Childname', '1990-01-01', 'child',
    null, null, 'nonin-suite-key-0005', repeat('5', 64), 'HID-NNQ8R9'));

-- 4. Each possible-duplicate kind sends the case for review.
select pg_temp.check_case('4 name and date of birth', 'review_required/1/f/f',
  pg_temp.register(1, 'e1300500-0000-4000-8000-000000000006', 'Adaeze', 'OKAFOR', '1980-01-02', 'no_nin',
    repeat('d', 64), null, 'nonin-suite-key-0006', repeat('6', 64), 'HID-NNS2T3'));
select pg_temp.check_case('4 phone', 'review_required/1/f/f',
  pg_temp.register(1, 'e1300500-0000-4000-8000-000000000007', 'Kemi', 'Different', '1999-09-09', 'nin_service_unavailable',
    repeat('e', 64) || ',' || repeat('b', 64), null, 'nonin-suite-key-0007', repeat('7', 64), 'HID-NNU4V5'));
select pg_temp.check_case('4 stated Health ID', 'review_required/1/f/f',
  pg_temp.register(1, 'e1300500-0000-4000-8000-000000000008', 'Lola', 'Other', '1998-08-08', 'foreign_national',
    repeat('f', 64), 'hid-nne6f7', 'nonin-suite-key-0008', repeat('8', 64), 'HID-NNW6X7'));
select pg_temp.check_case('4 desk phone of a patient created at the desk', 'review_required/1/f/f',
  pg_temp.register(2, 'e1300500-0000-4000-8000-000000000009', 'Musa', 'Samephone', '1960-06-06', 'no_nin',
    repeat('c', 64), null, 'nonin-suite-key-0009', repeat('9', 64), 'HID-NNY8Z9'));
-- Same date of birth and last name as case 7 (open, no patient yet), another phone.
select pg_temp.check_case('4 open registration', 'review_required/0/f/f',
  pg_temp.register(2, 'e1300500-0000-4000-8000-000000000010', 'Kemi', 'Different', '1999-09-09', 'no_nin',
    repeat('9', 64), null, 'nonin-suite-key-0010', repeat('a', 64), 'HID-NPA2B3'));

reset role;
do $$
begin
  perform pg_temp.check_case('4 reasons recorded', '["date_of_birth", "last_name"]|["phone"]|["stated_hid"]|["phone"]',
    (select string_agg(candidate.match_reasons::text, '|' order by candidate.case_id)
       from identity.registration_case_candidates candidate
      where candidate.case_id in ('e1300500-0000-4000-8000-000000000006', 'e1300500-0000-4000-8000-000000000007',
                                  'e1300500-0000-4000-8000-000000000008', 'e1300500-0000-4000-8000-000000000009')));
  -- 'Adaeze' is not 'Ada', so case 6 matched on last name and date of birth only.
  perform pg_temp.check_case('4 inactive patient never a candidate', '0',
    (select count(*)::text from identity.registration_case_candidates
      where patient_id = 'e1300400-0000-4000-8000-000000000004'));
  perform pg_temp.check_case('4 no patient for a review', '0',
    (select count(*)::text from identity.registration_cases
      where id in ('e1300500-0000-4000-8000-000000000006', 'e1300500-0000-4000-8000-000000000010')
        and resolved_patient_id is not null));
  -- 1's records.
  perform pg_temp.check_case('1 records', 'hid-desk-registration/none/no_nin/0/1/1/t/1/1',
    (select format('%s/%s/%s/%s/%s/%s/%s/%s/%s', patient.source_system, registration.identity_evidence,
       registration.no_nin_reason,
       (select count(*) from identity.patient_identifiers identifier where identifier.patient_id = patient.id),
       (select count(*) from identity.registration_case_contacts contact where contact.registration_case_id = registration.id),
       (select count(*) from identity.patient_facility_contacts contact where contact.patient_id = patient.id),
       (select lookup.patient_id = patient.id from identity.desk_registration_phone_lookups lookup
         where lookup.registration_case_id = registration.id),
       (select count(*) from identity.outbox_events event where event.aggregate_id = registration.id
          and event.event_type = 'PatientRegistered'),
       -- One row for the registration; 0145 audits a replay as its own row (replayed: true).
       (select count(*) from audit.events event where event.resource_id = registration.id::text
          and event.action = 'identity.registration.without-nin' and not (event.details ? 'replayed')))
       from identity.registration_cases registration
       join identity.patients patient on patient.id = registration.resolved_patient_id
      where registration.id = 'e1300500-0000-4000-8000-000000000001'));
  perform pg_temp.check_case('1 reviewed by the desk person itself', 'true',
    (select (reviewed_by_account_id = created_by_account_id
             and review_reason = 'No possible duplicates: created at the desk without a NIN')::text
       from identity.registration_cases where id = 'e1300500-0000-4000-8000-000000000001'));
  perform pg_temp.check_case('1 audit carries no name, date of birth or phone', 'false',
    (select bool_or(details::text ~* 'freshface|ngozi|1990-03-04|cccccccc')::text from audit.events
      where resource_id = 'e1300500-0000-4000-8000-000000000001' and action = 'identity.registration.without-nin'));
end $$;

-- 5. A second person decides.
set local role hid_identity_api_runtime;
select pg_temp.check_case('5 the desk cannot decide', '42501 NO_NIN_REVIEW_DENIED',
  pg_temp.review(2, 'e1300500-0000-4000-8000-000000000006', 1, 'create_new', null,
    'nonin-review-key-0001', repeat('1', 64), 'HID-NPC4D5'));
select pg_temp.check_case('5 another facility''s approver sees nothing', 'P0002 REGISTRATION_CASE_NOT_FOUND',
  pg_temp.review(6, 'e1300500-0000-4000-8000-000000000006', 1, 'create_new', null,
    'nonin-review-key-0002', repeat('1', 64), 'HID-NPC4D5'));
select pg_temp.check_case('5 link only to a candidate', '55000 PATIENT_NOT_A_REVIEW_CANDIDATE',
  pg_temp.review(3, 'e1300500-0000-4000-8000-000000000006', 1, 'link_existing',
    'e1300400-0000-4000-8000-000000000003', 'nonin-review-key-0003', repeat('1', 64), null));
select pg_temp.check_case('5 the case''s version', '55000 VERSION_CONFLICT',
  pg_temp.review(3, 'e1300500-0000-4000-8000-000000000006', 7, 'link_existing',
    'e1300400-0000-4000-8000-000000000001', 'nonin-review-key-0004', repeat('1', 64), null));
select pg_temp.check_case('5 link existing', 'linked_existing/2/f/t',
  pg_temp.review(3, 'e1300500-0000-4000-8000-000000000006', 1, 'link_existing',
    'e1300400-0000-4000-8000-000000000001', 'nonin-review-key-0005', repeat('5', 64), null));
select pg_temp.check_case('5 replay', 'linked_existing/2/t/t',
  pg_temp.review(3, 'e1300500-0000-4000-8000-000000000006', 1, 'link_existing',
    'e1300400-0000-4000-8000-000000000001', 'nonin-review-key-0005', repeat('5', 64), null));
select pg_temp.check_case('5 decided already', '55000 NO_NIN_REVIEW_NOT_AWAITING',
  pg_temp.review(8, 'e1300500-0000-4000-8000-000000000006', 2, 'reject', null,
    'nonin-review-key-0006', repeat('6', 64), null));
select pg_temp.check_case('5 create new', 'approved_new_identity/2/f/t',
  pg_temp.review(3, 'e1300500-0000-4000-8000-000000000007', 1, 'create_new', null,
    'nonin-review-key-0007', repeat('7', 64), 'HID-NPE6F7'));
select pg_temp.check_case('5 reject', 'rejected/2/f/f',
  pg_temp.review(3, 'e1300500-0000-4000-8000-000000000008', 1, 'reject', null,
    'nonin-review-key-0008', repeat('8', 64), null));
-- An approver who registered the person cannot decide it.
select pg_temp.check_case('5 approver''s own case', 'review_required/1/f/f',
  pg_temp.register(3, 'e1300500-0000-4000-8000-000000000011', 'Ada', 'Okafor', '1980-01-02', 'no_nin',
    repeat('7', 64), null, 'nonin-suite-key-0011', repeat('b', 64), 'HID-NPG8H9'));
select pg_temp.check_case('5 the creator cannot decide', '42501 NO_NIN_REVIEW_SECOND_PERSON',
  pg_temp.review(3, 'e1300500-0000-4000-8000-000000000011', 1, 'create_new', null,
    'nonin-review-key-0009', repeat('9', 64), 'HID-NPJ2K3'));
select pg_temp.check_case('5 another approver can', 'rejected/2/f/f',
  pg_temp.review(8, 'e1300500-0000-4000-8000-000000000011', 1, 'reject', null,
    'nonin-review-key-0010', repeat('a', 64), null));

reset role;
do $$
begin
  perform pg_temp.check_case('5 link records', 'none/1/t',
    (select format('%s/%s/%s', registration.identity_evidence,
       (select count(*) from identity.patient_facility_contacts contact
         where contact.registration_case_id = registration.id
           and contact.patient_id = 'e1300400-0000-4000-8000-000000000001'),
       (select lookup.patient_id = 'e1300400-0000-4000-8000-000000000001'::uuid
          from identity.desk_registration_phone_lookups lookup where lookup.registration_case_id = registration.id))
       from identity.registration_cases registration where registration.id = 'e1300500-0000-4000-8000-000000000006'));
  perform pg_temp.check_case('5 create-new patient', 'hid-desk-registration/0',
    (select format('%s/%s', patient.source_system,
       (select count(*) from identity.patient_identifiers identifier where identifier.patient_id = patient.id))
       from identity.registration_cases registration
       join identity.patients patient on patient.id = registration.resolved_patient_id
      where registration.id = 'e1300500-0000-4000-8000-000000000007'));
end $$;

-- 6. Direct writes.
set local role hid_identity_api_runtime;
create function pg_temp.attempt(n integer, statement text) returns text language plpgsql as $f$
begin
  perform pg_temp.as_member(n);
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select pg_temp.check_case('6 no direct insert without a NIN',
  '42501 A registration without a NIN is written only by its commands',
  pg_temp.attempt(1, $s$insert into identity.registration_cases (id, facility_id, created_by_account_id,
    created_by_membership_id, status, first_name, last_name, full_name, dob, identity_evidence, no_nin_reason,
    idempotency_key, request_sha256) values ('e1300500-0000-4000-8000-000000000020',
    'e1300000-0000-4000-8000-000000000002', 'e1300100-0000-4000-8000-000000000001',
    'e1300300-0000-4000-8000-000000000001', 'review_required', 'Direct', 'Write', 'Direct Write', '1990-01-01',
    'none', 'no_nin', 'nonin-direct-key-0001', repeat('0', 64))$s$));
select pg_temp.check_case('6 no direct decision without a NIN',
  '42501 A registration without a NIN is written only by its commands',
  pg_temp.attempt(3, $s$update identity.registration_cases set status = 'rejected',
    reviewed_by_account_id = 'e1300100-0000-4000-8000-000000000003',
    reviewed_by_membership_id = 'e1300300-0000-4000-8000-000000000003', review_reason = 'Direct decision',
    review_idempotency_key = 'nonin-direct-key-0002', review_request_sha256 = repeat('0', 64),
    row_version = row_version + 1 where id = 'e1300500-0000-4000-8000-000000000010'$s$));
select pg_temp.check_case('6 no NIN case inserted already decided', '42501 Registration case attribution is invalid',
  pg_temp.attempt(1, $s$insert into identity.registration_cases (id, facility_id, created_by_account_id,
    created_by_membership_id, status, first_name, last_name, full_name, dob, nin_ciphertext, nin_lookup_hmac, nin_last4,
    nin_key_version, verification_provider, verification_reference, verified_at, idempotency_key, request_sha256,
    resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id,
    reviewed_by_membership_id, review_reason) values ('e1300500-0000-4000-8000-000000000021',
    'e1300000-0000-4000-8000-000000000002', 'e1300100-0000-4000-8000-000000000001',
    'e1300300-0000-4000-8000-000000000001', 'approved_new_identity', 'Forged', 'Case', 'Forged Case', '1990-01-01',
    decode(repeat('ab', 32), 'hex'), repeat('1', 64), '1234', 'k1', 'fixture', 'ref', clock_timestamp(),
    'nonin-direct-key-0003', repeat('0', 64), 'e1300400-0000-4000-8000-000000000003', 'nonin-direct-key-0004',
    repeat('0', 64), 'e1300100-0000-4000-8000-000000000001', 'e1300300-0000-4000-8000-000000000001',
    'Forged review reason')$s$));
select pg_temp.check_case('6 no NIN case resolved to a patient without its NIN', '42501 Registration case attribution is invalid',
  pg_temp.attempt(1, $s$insert into identity.registration_cases (id, facility_id, created_by_account_id,
    created_by_membership_id, status, first_name, last_name, full_name, dob, nin_ciphertext, nin_lookup_hmac, nin_last4,
    nin_key_version, verification_provider, verification_reference, verified_at, idempotency_key, request_sha256,
    resolved_patient_id) values ('e1300500-0000-4000-8000-000000000022',
    'e1300000-0000-4000-8000-000000000002', 'e1300100-0000-4000-8000-000000000001',
    'e1300300-0000-4000-8000-000000000001', 'resolved_existing_identity', 'Forged', 'Case', 'Forged Case', '1990-01-01',
    decode(repeat('ab', 32), 'hex'), repeat('2', 64), '1234', 'k1', 'fixture', 'ref', clock_timestamp(),
    'nonin-direct-key-0005', repeat('0', 64), 'e1300400-0000-4000-8000-000000000003')$s$));
select pg_temp.check_case('6 the NIN path is unchanged', 'ok',
  pg_temp.attempt(1, $s$insert into identity.registration_cases (id, facility_id, created_by_account_id,
    created_by_membership_id, status, first_name, last_name, full_name, dob, nin_ciphertext, nin_lookup_hmac, nin_last4,
    nin_key_version, verification_provider, verification_reference, verified_at, idempotency_key, request_sha256)
    values ('e1300500-0000-4000-8000-000000000023',
    'e1300000-0000-4000-8000-000000000002', 'e1300100-0000-4000-8000-000000000001',
    'e1300300-0000-4000-8000-000000000001', 'pending_new_identity_approval', 'Nin', 'Path', 'Nin Path', '1990-01-01',
    decode(repeat('ab', 32), 'hex'), repeat('3', 64), '1234', 'k1', 'fixture', 'ref', clock_timestamp(),
    'nonin-direct-key-0006', repeat('0', 64))$s$));
select pg_temp.check_case('6 the runtime cannot write the marker', '42501 permission denied for table no_nin_case_writes',
  pg_temp.attempt(1, $s$insert into identity.no_nin_case_writes (case_id) values ('e1300500-0000-4000-8000-000000000020')$s$));
select pg_temp.check_case('6 the runtime cannot read the phone lookups', '42501 permission denied for table desk_registration_phone_lookups',
  pg_temp.attempt(1, $s$select 1 from identity.desk_registration_phone_lookups$s$));

-- 7. No daily limit (owner Q109). Member 1 has 5 today (cases 1, 4, 6, 7 and
-- 8); 15 more children, then the 21st and the 22nd are created too, and the
-- answer counts the facility's registrations without a NIN today.
do $$
declare
  outcome text;
begin
  for i in 1..15 loop
    outcome := pg_temp.register(1, ('e1300600-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid,
      'Batch', 'Child' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ', i, 1), ((clock_timestamp() at time zone 'Africa/Lagos')::date - (i || ' days')::interval)::date,
      'child', null, null, 'nonin-batch-key-' || lpad(i::text, 4, '0'), lpad(i::text, 64, '0'),
      'HID-NR' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ', i, 1) || 'A2B3');
    if outcome <> 'approved_new_identity/0/f/t' then
      raise exception 'Batch registration % answered %', i, outcome;
    end if;
  end loop;
end $$;
do $$
declare
  first_answer record;
  second_answer record;
begin
  perform pg_temp.as_member(1);
  select * into first_answer from identity.register_patient_without_nin('e1300600-0000-4000-8000-000000000099',
    'Batch', 'Toomany', ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '20 days')::date,
    'female', 'child', null, null, null, null, null, 'nonin-batch-key-0099', repeat('9', 64), 'HID-NSA2B3');
  perform pg_temp.check_case('7 the 21st today is created', 'approved_new_identity/0/f/t',
    format('%s/%s/%s/%s', first_answer.case_status, first_answer.candidate_count, first_answer.replayed,
      first_answer.subject_patient_id is not null));
  select * into second_answer from identity.register_patient_without_nin('e1300600-0000-4000-8000-000000000097',
    'Batch', 'Twentysecond', ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '22 days')::date,
    'female', 'child', null, null, null, null, null, 'nonin-batch-key-0097', repeat('7', 64), 'HID-NSE6F7');
  perform pg_temp.check_case('7 the 22nd today is created; the facility count goes on',
    format('approved_new_identity/t/%s', first_answer.facility_daily_count + 1),
    format('%s/%s/%s', second_answer.case_status, first_answer.facility_daily_count >= 21,
      second_answer.facility_daily_count));
end $$;
select pg_temp.check_case('7 another member registers too', 'approved_new_identity/0/f/t',
  pg_temp.register(2, 'e1300600-0000-4000-8000-000000000098', 'Batch', 'Another',
    ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '21 days')::date, 'child',
    null, null, 'nonin-batch-key-0098', repeat('8', 64), 'HID-NSC4D5'));

-- 8. Refusals.
select pg_temp.check_case('8 no registration permission', '42501 NO_NIN_REGISTRATION_DENIED',
  pg_temp.register(4, 'e1300500-0000-4000-8000-000000000030', 'Lab', 'Person', '1990-01-01', 'no_nin',
    repeat('1', 64), null, 'nonin-suite-key-0030', repeat('1', 64), 'HID-NTA2B3'));
select pg_temp.check_case('8 another purpose', '42501 NO_NIN_REGISTRATION_DENIED',
  pg_temp.register(1, 'e1300500-0000-4000-8000-000000000031', 'Purpose', 'Person', '1990-01-01', 'no_nin',
    repeat('1', 64), null, 'nonin-suite-key-0031', repeat('1', 64), 'HID-NTC4D5', 'direct-care'));
select pg_temp.check_case('8 a sealed facility', '42501 NO_NIN_REGISTRATION_SEALED_FACILITY',
  pg_temp.register(7, 'e1300500-0000-4000-8000-000000000032', 'Sealed', 'Person', '1990-01-01', 'no_nin',
    repeat('1', 64), null, 'nonin-suite-key-0032', repeat('1', 64), 'HID-NTE6F7'));
select pg_temp.check_case('8 an unknown reason', '22023 NO_NIN_REGISTRATION_INVALID',
  pg_temp.register(5, 'e1300500-0000-4000-8000-000000000033', 'Reason', 'Person', '1990-01-01', 'lost_it',
    repeat('1', 64), null, 'nonin-suite-key-0033', repeat('1', 64), 'HID-NTG8H9'));

reset role;
-- The shape check refuses NIN digits on a case without a NIN (written without triggers).
do $$
declare
  outcome text := 'stored';
begin
  set local session_replication_role = replica;
  begin
    insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
      first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, nin_last4, idempotency_key, request_sha256)
    values ('e1300500-0000-4000-8000-000000000040', 'e1300000-0000-4000-8000-000000000002',
      'e1300100-0000-4000-8000-000000000001', 'e1300300-0000-4000-8000-000000000001', 'review_required',
      'Shape', 'Check', 'Shape Check', '1990-01-01', 'none', 'no_nin', '1234', 'nonin-shape-key-0001', repeat('0', 64));
  exception when check_violation then
    outcome := 'refused';
  end;
  set local session_replication_role = origin;
  perform pg_temp.check_case('8 evidence shape', 'refused', outcome);
end $$;

-- 9. Erasing the case contact deletes the phone lookup.
do $$
begin
  perform pg_temp.as_member(1);
  perform identity.erase_registration_case_contact('e1300500-0000-4000-8000-000000000008', 'erasure_request');
  perform pg_temp.check_case('9 lookup deleted with the contact', '0',
    (select count(*)::text from identity.desk_registration_phone_lookups
      where registration_case_id = 'e1300500-0000-4000-8000-000000000008'));
end $$;

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.nonin_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0130 desk registration without a NIN:\n%', mismatch;
  end if;
  raise notice '0130 desk registration without a NIN: % cases passed', (select count(*) from pg_temp.nonin_outcomes);
end $$;

rollback;
