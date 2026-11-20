\set ON_ERROR_STOP on
-- 0138 (ID-6): verify a NIN later and link it. Rollback-only. Every command
-- runs as Identity's runtime role in the context Identity's transactions set.
-- Fictional people, places and identifiers only; ids start e1380. The NIN's
-- lookup HMACs are made-up hex strings ('a' x 64 and so on), never a NIN.
--
--   1. the precheck: this facility's own patient (registered here without a
--      NIN, 0130) is eligible; another facility's patient and a patient
--      with no basis here are not_permitted; an unknown, inactive or
--      across-the-seals patient is not_found (one answer);
--   2. the link: the verified `nin` identifier (source hid-desk-nin-link,
--      the link's id, QoreID's reference, the last 4), the evidence row, the
--      patient's row_version + 1 and one audit row with no NIN or HMAC; the
--      own-facility basis is unchanged; ID-0's rule now reads verified;
--   3. after it: the same NIN is already_linked, another NIN has_nin; the
--      same key and request replays, another request under the key is
--      key_reused (both in the precheck and the link);
--   4. a NIN on another record: on_another_record names that record (for the
--      audit only) and writes nothing;
--   5. refusals: no registration permission, another purpose, no
--      membership; malformed input;
--   6. the evidence cannot be changed or deleted, and the runtime cannot read
--      it; a NIN row with two sources is refused;
--   7. the patient's access log shows "nin_added" at this facility, once;
--      an already_linked answer adds nothing;
--   8. structure: owners, SECURITY DEFINER, search_path, EXECUTE.
--
-- Each case records its outcome; the suite fails at the end listing every case
-- whose outcome differs.
begin;

set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e1380000-0000-4000-8000-000000000001', 'NIN Link Group A', 'nin-link-group-a'),
  ('e1380000-0000-4000-8000-000000000011', 'NIN Link Group B', 'nin-link-group-b'),
  ('e1380000-0000-4000-8000-000000000021', 'NIN Link Sealed Group', 'nin-link-sealed-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1380000-0000-4000-8000-000000000002', 'e1380000-0000-4000-8000-000000000001', 'NIN Link Clinic A',
   'NIN-LINK-A', 'Africa/Lagos', true, 'verified'),
  ('e1380000-0000-4000-8000-000000000012', 'e1380000-0000-4000-8000-000000000011', 'NIN Link Clinic B',
   'NIN-LINK-B', 'Africa/Lagos', true, 'verified'),
  ('e1380000-0000-4000-8000-000000000022', 'e1380000-0000-4000-8000-000000000021', 'NIN Link Sealed Clinic',
   'NIN-LINK-S', 'Africa/Lagos', true, 'verified');
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('facility', 'e1380000-0000-4000-8000-000000000022');
create temporary table link_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into link_members values
  (1, 'e1380000-0000-4000-8000-000000000002', 'e1380000-0000-4000-8000-000000000001', 'receptionist', 'Ada Desk'),
  (2, 'e1380000-0000-4000-8000-000000000002', 'e1380000-0000-4000-8000-000000000001', 'lab', 'Bola Lab'),
  (3, 'e1380000-0000-4000-8000-000000000012', 'e1380000-0000-4000-8000-000000000011', 'receptionist', 'Chidi Desk'),
  (4, 'e1380000-0000-4000-8000-000000000022', 'e1380000-0000-4000-8000-000000000021', 'receptionist', 'Dayo Sealed');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1380100-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:nin-link-member-' || n,
  'nin-link-member-' || n || '@example.invalid', name, 'active' from link_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1380200-0000-4000-8000-00000000000' || n)::uuid, ('e1380100-0000-4000-8000-00000000000' || n)::uuid,
  name, 'nin-link-member-' || n || '@example.invalid', 'verified', role_code from link_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1380300-0000-4000-8000-00000000000' || n)::uuid, ('e1380200-0000-4000-8000-00000000000' || n)::uuid,
  ('e1380100-0000-4000-8000-00000000000' || n)::uuid, organization, facility, role_code, role_code, true, true
from link_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('e1380100-0000-4000-8000-00000000000' || n)::uuid, role_code, 'facility',
  ('e1380300-0000-4000-8000-00000000000' || n)::uuid, facility, 'Synthetic NIN link suite role'
from link_members;
-- p9: a patient with no basis anywhere; p8: inactive; p7: a sealed demo patient.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, status) values
  ('e1380400-0000-4000-8000-000000000009', 'HID-NLZ2Y3', 'Nobasis', 'Person', 'Nobasis Person', '1981-01-01', 'active'),
  ('e1380400-0000-4000-8000-000000000008', 'HID-NLX4W5', 'Gone', 'Person', 'Gone Person', '1982-02-02', 'inactive'),
  ('e1380400-0000-4000-8000-000000000007', 'HID-NLV6U7', 'Sealed', 'Person', 'Sealed Person', '1983-03-03', 'active');
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('patient', 'e1380400-0000-4000-8000-000000000007');
-- p1's patient login and live session, for the access log.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1380100-0000-4000-8000-000000000099', 'synthetic:nin-link-patient-1', 'nin-link-patient-1@example.invalid',
   'Link Patient', 'active');
set local session_replication_role = origin;

create temporary table link_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
grant select, insert on pg_temp.link_outcomes to hid_identity_api_runtime;
grant select on pg_temp.link_members to hid_identity_api_runtime;
grant usage on sequence pg_temp.link_outcomes_seq_seq to hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.link_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;

create function pg_temp.as_member(n integer, purpose text default 'healthcare-operations') returns void
language sql as $f$
  select set_config('app.actor_subject', 'synthetic:nin-link-member-' || n, true),
    set_config('app.membership_id', 'e1380300-0000-4000-8000-00000000000' || n, true),
    set_config('app.facility_id', (select facility::text from pg_temp.link_members where link_members.n = as_member.n), true),
    set_config('app.correlation_id', 'nin-link-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;

create function pg_temp.precheck(n integer, patient uuid, hmac text, idempotency_key text, request_sha text,
  purpose text default 'healthcare-operations') returns text language plpgsql as $f$
begin
  perform pg_temp.as_member(n, purpose);
  return (select format('%s%s', decision, coalesce('/' || first_name || '/' || last_name || '/' || date_of_birth, ''))
            from identity.patient_nin_link_precheck(patient, hmac, idempotency_key, request_sha));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

create function pg_temp.link(n integer, patient uuid, link_id uuid, hmac text, idempotency_key text, request_sha text,
  purpose text default 'healthcare-operations', reference text default 'QOREID-TXN-0001') returns text
language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n, purpose);
  select * into answer from identity.link_patient_nin(patient, link_id, hmac, decode(repeat('5a', 40), 'hex'), 'k1',
    '4321', reference, true, idempotency_key, request_sha);
  return answer.outcome || coalesce('/' || answer.other_patient_id, '');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

create function pg_temp.register(n integer, case_id uuid, first_name text, last_name text, dob date, key text,
  request_sha text, hid text) returns uuid language plpgsql as $f$
declare
  answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from identity.register_patient_without_nin(case_id, first_name, last_name, dob, 'female',
    'child', null, null, null, null, null, key, request_sha, hid);
  return answer.subject_patient_id;
end
$f$;

set local role hid_identity_api_runtime;

-- Patients registered without a NIN at clinic A (p1, p2, p3) and at clinic B (p4): each a child, so no
-- phone is needed, and each unlike the others, so each is created at once (0130).
create temporary table link_patients (n integer primary key, patient uuid) on commit drop;
insert into link_patients
select 1, pg_temp.register(1, 'e1380500-0000-4000-8000-000000000001', 'Ngozi', 'Linkone',
  ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '5 years')::date, 'nin-link-reg-0001',
  repeat('1', 64), 'HID-NLA2B3');
insert into link_patients
select 2, pg_temp.register(1, 'e1380500-0000-4000-8000-000000000002', 'Tunde', 'Linktwo',
  ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '6 years')::date, 'nin-link-reg-0002',
  repeat('2', 64), 'HID-NLC4D5');
insert into link_patients
select 3, pg_temp.register(1, 'e1380500-0000-4000-8000-000000000003', 'Kemi', 'Linkthree',
  ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '7 years')::date, 'nin-link-reg-0003',
  repeat('3', 64), 'HID-NLE6F7');
insert into link_patients
select 4, pg_temp.register(3, 'e1380500-0000-4000-8000-000000000004', 'Efe', 'Linkfour',
  ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '8 years')::date, 'nin-link-reg-0004',
  repeat('4', 64), 'HID-NLG8H9');
select pg_temp.check_case('0 fixtures registered', '4', (select count(patient)::text from pg_temp.link_patients));

-- 1. The precheck.
select pg_temp.check_case('1 own patient is eligible, with the record''s name and date of birth',
  'eligible/Ngozi/Linkone/' || ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '5 years')::date,
  pg_temp.precheck(1, (select patient from pg_temp.link_patients where n = 1), repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));
select pg_temp.check_case('1 another facility''s patient', 'not_permitted',
  pg_temp.precheck(1, (select patient from pg_temp.link_patients where n = 4), repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));
select pg_temp.check_case('1 no basis here', 'not_permitted',
  pg_temp.precheck(1, 'e1380400-0000-4000-8000-000000000009', repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));
select pg_temp.check_case('1 unknown id', 'not_found',
  pg_temp.precheck(1, 'e1380400-0000-4000-8000-0000000000ff', repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));
select pg_temp.check_case('1 inactive', 'not_found',
  pg_temp.precheck(1, 'e1380400-0000-4000-8000-000000000008', repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));
select pg_temp.check_case('1 across the seals', 'not_found',
  pg_temp.precheck(1, 'e1380400-0000-4000-8000-000000000007', repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));
select pg_temp.check_case('1 a sealed desk and a standard patient', 'not_found',
  pg_temp.precheck(4, (select patient from pg_temp.link_patients where n = 1), repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));

-- 2. The link.
do $$
declare
  p1 uuid := (select patient from pg_temp.link_patients where n = 1);
  version_before bigint;
  basis_before text;
begin
  reset role;
  select row_version into version_before from identity.patients where id = p1;
  basis_before := identity.own_facility_basis(p1, 'e1380000-0000-4000-8000-000000000002');
  set local role hid_identity_api_runtime;
  perform pg_temp.check_case('2 linked', 'nin_linked',
    pg_temp.link(1, p1, 'e1380600-0000-4000-8000-000000000001', repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));
  reset role;
  perform pg_temp.check_case('2 the identifier', 't/hid-desk-nin-link/e1380600-0000-4000-8000-000000000001/QOREID-TXN-0001/4321/k1/qoreid',
    (select format('%s/%s/%s/%s/%s/%s/%s', verified, source_system, nin_link_id, verification_reference, display_hint,
        encryption_key_version, verification_provider)
       from identity.patient_identifiers where patient_id = p1 and identifier_type = 'nin'));
  perform pg_temp.check_case('2 the evidence', 'e1380000-0000-4000-8000-000000000002/e1380300-0000-4000-8000-000000000001/t/QOREID-TXN-0001',
    (select format('%s/%s/%s/%s', facility_id, membership_id, qoreid_called, provider_reference)
       from identity.patient_nin_links where id = 'e1380600-0000-4000-8000-000000000001'));
  perform pg_temp.check_case('2 row_version + 1', 'true',
    ((select row_version from identity.patients where id = p1) = version_before + 1)::text);
  perform pg_temp.check_case('2 the basis is unchanged', basis_before,
    identity.own_facility_basis(p1, 'e1380000-0000-4000-8000-000000000002'));
  perform pg_temp.check_case('2 no new basis at clinic B', '(null)',
    coalesce(identity.own_facility_basis(p1, 'e1380000-0000-4000-8000-000000000012'), '(null)'));
  perform pg_temp.check_case('2 one audit row, no NIN or HMAC', '1/success/nin_linked/f',
    (select format('%s/%s/%s/%s', count(*), min(outcome), min(details ->> 'outcome'),
        bool_or(details::text like '%' || repeat('a', 64) || '%' or details::text like '%4321%'))
       from audit.events where patient_id = p1 and action = 'identity.patient.nin-link'));
  -- ID-0's rule (nin-status.ts): a verified, unrevoked nin row.
  perform pg_temp.check_case('2 ID-0 reads verified', 'true',
    exists (select 1 from identity.patient_identifiers where patient_id = p1 and identifier_type = 'nin'
             and verified and revoked_at is null)::text);
  set local role hid_identity_api_runtime;
end $$;

-- 3. After the link.
select pg_temp.check_case('3 the same NIN', 'already_linked',
  pg_temp.precheck(1, (select patient from pg_temp.link_patients where n = 1), repeat('a', 64), 'nin-link-key-0003', repeat('d', 64)));
select pg_temp.check_case('3 another NIN', 'has_nin',
  pg_temp.precheck(1, (select patient from pg_temp.link_patients where n = 1), repeat('b', 64), 'nin-link-key-0003', repeat('d', 64)));
select pg_temp.check_case('3 the link answers already_linked', 'already_linked',
  pg_temp.link(1, (select patient from pg_temp.link_patients where n = 1), 'e1380600-0000-4000-8000-000000000031',
    repeat('a', 64), 'nin-link-key-0031', repeat('e', 64)));
select pg_temp.check_case('3 the link answers has_nin', 'has_nin',
  pg_temp.link(1, (select patient from pg_temp.link_patients where n = 1), 'e1380600-0000-4000-8000-000000000032',
    repeat('b', 64), 'nin-link-key-0032', repeat('f', 64)));
select pg_temp.check_case('3 precheck replay', 'replay',
  pg_temp.precheck(1, (select patient from pg_temp.link_patients where n = 1), repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));
select pg_temp.check_case('3 precheck key reused (another digest)', 'key_reused',
  pg_temp.precheck(1, (select patient from pg_temp.link_patients where n = 1), repeat('a', 64), 'nin-link-key-0001', repeat('9', 64)));
select pg_temp.check_case('3 precheck key reused (another patient)', 'key_reused',
  pg_temp.precheck(1, (select patient from pg_temp.link_patients where n = 2), repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));
select pg_temp.check_case('3 link replay', 'replay',
  pg_temp.link(1, (select patient from pg_temp.link_patients where n = 1), 'e1380600-0000-4000-8000-000000000033',
    repeat('a', 64), 'nin-link-key-0001', repeat('c', 64)));
select pg_temp.check_case('3 link key reused', 'key_reused',
  pg_temp.link(1, (select patient from pg_temp.link_patients where n = 2), 'e1380600-0000-4000-8000-000000000034',
    repeat('b', 64), 'nin-link-key-0001', repeat('9', 64)));
select pg_temp.check_case('3 another member may use the same key', 'eligible/Efe/Linkfour/'
    || ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '8 years')::date,
  pg_temp.precheck(3, (select patient from pg_temp.link_patients where n = 4), repeat('b', 64), 'nin-link-key-0001', repeat('c', 64)));

-- 4. A NIN on another record.
select pg_temp.check_case('4 on another record', 'on_another_record/' || (select patient from pg_temp.link_patients where n = 1),
  pg_temp.link(1, (select patient from pg_temp.link_patients where n = 2), 'e1380600-0000-4000-8000-000000000041',
    repeat('a', 64), 'nin-link-key-0041', repeat('4', 64)));
do $$
begin
  reset role;
  perform pg_temp.check_case('4 nothing written', '0/0',
    (select format('%s/%s',
       (select count(*) from identity.patient_identifiers identifier join pg_temp.link_patients p on p.patient = identifier.patient_id
         where p.n = 2 and identifier.identifier_type = 'nin'),
       (select count(*) from identity.patient_nin_links where id = 'e1380600-0000-4000-8000-000000000041'))));
  set local role hid_identity_api_runtime;
end $$;
select pg_temp.check_case('4 p2 still eligible for its own NIN', 'nin_linked',
  pg_temp.link(1, (select patient from pg_temp.link_patients where n = 2), 'e1380600-0000-4000-8000-000000000042',
    repeat('b', 64), 'nin-link-key-0042', repeat('5', 64), 'healthcare-operations', 'QOREID-TXN-0002'));

-- 5. Refusals.
select pg_temp.check_case('5 no registration permission (lab)', '42501 NIN_LINK_DENIED',
  pg_temp.precheck(2, (select patient from pg_temp.link_patients where n = 3), repeat('c', 64), 'nin-link-key-0051', repeat('6', 64)));
select pg_temp.check_case('5 no registration permission, the link', '42501 NIN_LINK_DENIED',
  pg_temp.link(2, (select patient from pg_temp.link_patients where n = 3), 'e1380600-0000-4000-8000-000000000051',
    repeat('c', 64), 'nin-link-key-0051', repeat('6', 64)));
select pg_temp.check_case('5 another purpose', '42501 NIN_LINK_DENIED',
  pg_temp.link(1, (select patient from pg_temp.link_patients where n = 3), 'e1380600-0000-4000-8000-000000000052',
    repeat('c', 64), 'nin-link-key-0052', repeat('6', 64), 'direct-care'));
do $$
begin
  perform set_config('app.actor_subject', 'synthetic:nin-link-member-1', true),
    set_config('app.membership_id', 'e1380300-0000-4000-8000-000000000003', true),
    set_config('app.facility_id', 'e1380000-0000-4000-8000-000000000002', true),
    set_config('app.correlation_id', 'nin-link-suite-foreign-membership', true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
  begin
    perform * from identity.patient_nin_link_precheck((select patient from pg_temp.link_patients where n = 3),
      repeat('c', 64), 'nin-link-key-0053', repeat('6', 64));
    perform pg_temp.check_case('5 another account''s membership', '42501', 'answered');
  exception when others then
    perform pg_temp.check_case('5 another account''s membership', '42501', sqlstate);
  end;
end $$;
select pg_temp.check_case('5 malformed HMAC', '22023 NIN_LINK_INVALID',
  pg_temp.link(1, (select patient from pg_temp.link_patients where n = 3), 'e1380600-0000-4000-8000-000000000054',
    'not-a-hash', 'nin-link-key-0054', repeat('6', 64)));
select pg_temp.check_case('5 malformed reference', '22023 NIN_LINK_INVALID',
  pg_temp.link(1, (select patient from pg_temp.link_patients where n = 3), 'e1380600-0000-4000-8000-000000000055',
    repeat('c', 64), 'nin-link-key-0055', repeat('6', 64), 'healthcare-operations', 'not a reference'));

-- 6. The evidence and the identifier sources.
do $$
begin
  begin
    perform count(*) from identity.patient_nin_links;
    perform pg_temp.check_case('6 the runtime cannot read the evidence', '42501', 'read');
  exception when others then
    perform pg_temp.check_case('6 the runtime cannot read the evidence', '42501', sqlstate);
  end;
  reset role;
  begin
    update identity.patient_nin_links set provider_reference = 'QOREID-TXN-9999'
     where id = 'e1380600-0000-4000-8000-000000000001';
    perform pg_temp.check_case('6 the evidence cannot change', 'refused', 'changed');
  exception when others then
    perform pg_temp.check_case('6 the evidence cannot change', 'refused', 'refused');
  end;
  begin
    delete from identity.patient_nin_links where id = 'e1380600-0000-4000-8000-000000000001';
    perform pg_temp.check_case('6 the evidence cannot be deleted', 'refused', 'deleted');
  exception when others then
    perform pg_temp.check_case('6 the evidence cannot be deleted', 'refused', 'refused');
  end;
  begin
    insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
      encryption_key_version, display_hint, verified, source_system, verified_at, verification_provider,
      verification_reference, nin_link_id, registration_case_id)
    select gen_random_uuid(), p.patient, 'nin', decode(repeat('5a', 40), 'hex'), repeat('e', 64), 'k1', '1111', true,
      'hid-desk-nin-link', clock_timestamp(), 'qoreid', 'QOREID-TXN-0003', 'e1380600-0000-4000-8000-000000000001',
      'e1380500-0000-4000-8000-000000000003'
      from pg_temp.link_patients p where p.n = 3;
    perform pg_temp.check_case('6 two sources refused', '23514', 'inserted');
  exception when others then
    perform pg_temp.check_case('6 two sources refused', '23514', sqlstate);
  end;
  set local role hid_identity_api_runtime;
end $$;

-- 7. The patient's access log.
do $$
declare
  p1 uuid := (select patient from pg_temp.link_patients where n = 1);
begin
  reset role;
  set local session_replication_role = replica;
  update identity.patients set account_id = 'e1380100-0000-4000-8000-000000000099' where id = p1;
  insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
    ('e1380a00-0000-4000-8000-000000000001', 'e1380100-0000-4000-8000-000000000099',
     'e1380a00-0000-4000-8000-000000000001', md5('nin-link-patient') || md5('nin-link-patient'), gen_random_uuid(), 1,
     'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
     'patient', p1);
  set local session_replication_role = origin;
  set local role hid_identity_api_runtime;
  perform set_config('app.actor_subject', 'synthetic:nin-link-patient-1', true),
    set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'nin-link-suite-patient-1', true), set_config('app.purpose_of_use', '', true);
  perform pg_temp.check_case('7 nin_added once, at clinic A', 'nin_added/NIN Link Clinic A/clinician/Ada Desk',
    (select string_agg(format('%s/%s/%s/%s', entry ->> 'action', entry ->> 'facilityName', entry ->> 'actorKind',
         entry ->> 'actorName'), '|')
       from jsonb_array_elements(identity.patient_self_access_log('synthetic:nin-link-patient-1',
         'e1380a00-0000-4000-8000-000000000001', 50, null, null) -> 'events') entry
      where entry ->> 'action' = 'nin_added'));
end $$;
-- An already_linked answer's audit row (written by Identity) adds nothing.
do $$
begin
  reset role;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, resource_type, resource_id, outcome, purpose_of_use,
    provenance, source_system, details)
  select 'nin-link-suite-already-linked', 'staff', 'synthetic:nin-link-member-1', 'e1380100-0000-4000-8000-000000000001',
    'e1380300-0000-4000-8000-000000000001', 'e1380000-0000-4000-8000-000000000001',
    'e1380000-0000-4000-8000-000000000002', p.patient, 'identity.patient.nin-link', 'patient', p.patient::text,
    'success', 'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('outcome', 'already_linked', 'qoreidCalled', false)
    from pg_temp.link_patients p where p.n = 1;
  set local role hid_identity_api_runtime;
  perform set_config('app.actor_subject', 'synthetic:nin-link-patient-1', true);
  perform pg_temp.check_case('7 already_linked adds nothing', '1',
    (select count(*)::text
       from jsonb_array_elements(identity.patient_self_access_log('synthetic:nin-link-patient-1',
         'e1380a00-0000-4000-8000-000000000001', 50, null, null) -> 'events') entry
      where entry ->> 'action' = 'nin_added'));
end $$;

-- 8. Structure.
reset role;
select pg_temp.check_case('8 functions', 'identity.link_patient_nin(uuid,uuid,character,bytea,text,character,text,boolean,text,character)/v/t/{"search_path=pg_catalog, pg_temp"}|identity.patient_nin_link_precheck(uuid,character,text,character)/s/t/{"search_path=pg_catalog, pg_temp"}|identity.patient_self_access_log(text,uuid,integer,timestamp with time zone,bigint)/s/t/{"search_path=pg_catalog, pg_temp"}',
  (select string_agg(format('%s/%s/%s/%s', proc.oid::regprocedure, proc.provolatile, proc.prosecdef, proc.proconfig),
       '|' order by proc.proname)
     from pg_proc proc
    where proc.oid in (to_regprocedure('identity.link_patient_nin(uuid,uuid,character,bytea,text,character,text,boolean,text,character)'),
                       to_regprocedure('identity.patient_nin_link_precheck(uuid,character,text,character)'),
                       to_regprocedure('identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)'))));
select pg_temp.check_case('8 who may execute the link', 'hid_identity_runtime,hid_schema_test_runtime',
  (select string_agg(grantee.rolname, ',' order by grantee.rolname)
     from pg_proc proc
     cross join lateral aclexplode(proc.proacl) privilege
     join pg_roles grantee on grantee.oid = privilege.grantee
    where proc.oid = to_regprocedure('identity.link_patient_nin(uuid,uuid,character,bytea,text,character,text,boolean,text,character)')
      and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> proc.proowner));
select pg_temp.check_case('8 no privilege on the evidence', '(null)',
  (select string_agg(grantee.rolname || ' ' || privilege.privilege_type, ',')
     from pg_class relation
     cross join lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
     join pg_roles grantee on grantee.oid = privilege.grantee
    where relation.oid = 'identity.patient_nin_links'::regclass and privilege.grantee <> relation.relowner));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.link_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0138 NIN link:\n%', mismatch;
  end if;
  raise notice '0138 NIN link: % cases passed', (select count(*) from pg_temp.link_outcomes);
end $$;

rollback;
