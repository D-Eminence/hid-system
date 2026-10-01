\set ON_ERROR_STOP on
begin;

-- This transaction uses fixture ciphertext bytes and an inert Argon2-shaped
-- hash. It rolls back every canonical account and patient created below.
insert into identity.public_patient_enrollments (
  id, nin_lookup_hmac, nin_last4, nin_ciphertext, profile_ciphertext,
  profile_sha256, key_version, provider_reference, request_hmac, token_hmac,
  state, contact_channel, contact_hmac, contact_ciphertext,
  contact_verified_at, verified_challenge_id
) values
  ('b5100000-0000-4000-8000-000000000001', repeat('a',64), '8901', decode(repeat('a1',32),'hex'),
   decode(repeat('b1',32),'hex'),
   encode(public.digest('{"nin":"12345678901","firstName":"Amina","lastName":"Okafor","dateOfBirth":"1990-05-12","gender":"female","providerReference":"fixture-email-001"}', 'sha256'),'hex'),
   'fixture', 'fixture-email-001', repeat('1',64), repeat('2',64),
   'set_password', 'email', repeat('c',64), decode(repeat('d1',32),'hex'),
   clock_timestamp(), 'b5200000-0000-4000-8000-000000000001'),
  ('b5100000-0000-4000-8000-000000000002', repeat('b',64), '8902', decode(repeat('a2',32),'hex'),
   decode(repeat('b2',32),'hex'),
   encode(public.digest('{"nin":"12345678902","firstName":"Bola","lastName":"Uche","dateOfBirth":"1988-03-04","gender":"male","providerReference":"fixture-phone-002"}', 'sha256'),'hex'),
   'fixture', 'fixture-phone-002', repeat('3',64), repeat('4',64),
   'set_password', 'phone', repeat('d',64), decode(repeat('d2',32),'hex'),
   clock_timestamp(), 'b5200000-0000-4000-8000-000000000002'),
  ('b5100000-0000-4000-8000-000000000003', repeat('e',64), '8903', decode(repeat('a3',32),'hex'),
   decode(repeat('b3',32),'hex'),
   encode(public.digest('{"nin":"12345678903","firstName":"Chika","lastName":"Eze","dateOfBirth":"1995-07-08","gender":"female","providerReference":"fixture-stage-003"}', 'sha256'),'hex'),
   'fixture', 'fixture-stage-003', repeat('5',64), repeat('6',64), 'verify_contact',
   null, null, null, null, null),
  ('b5100000-0000-4000-8000-000000000004', repeat('f',64), '8904', decode(repeat('a4',32),'hex'),
   decode(repeat('b4',32),'hex'),
   encode(public.digest('{"nin":"12345678904","firstName":"Dayo","lastName":"Ibe","dateOfBirth":"1992-11-09","gender":"other","providerReference":"fixture-duplicate-004"}', 'sha256'),'hex'),
   'fixture', 'fixture-duplicate-004', repeat('7',64), repeat('8',64),
   'set_password', 'email', repeat('9',64), decode(repeat('d4',32),'hex'),
   clock_timestamp(), 'b5200000-0000-4000-8000-000000000004');

insert into identity.public_patient_enrollment_otps (
  id, enrollment_id, recipient_hmac, channel, verifier_hmac,
  verifier_key_version, expires_at, max_attempts, delivery_outcome,
  verified_at, consumed_at
) values
  ('b5200000-0000-4000-8000-000000000001','b5100000-0000-4000-8000-000000000001',
   repeat('c',64),'email',repeat('a',64),'fixture',clock_timestamp()+interval '10 minutes',5,
   'accepted',clock_timestamp(),clock_timestamp()),
  ('b5200000-0000-4000-8000-000000000002','b5100000-0000-4000-8000-000000000002',
   repeat('d',64),'phone',repeat('b',64),'fixture',clock_timestamp()+interval '10 minutes',5,
   'accepted',clock_timestamp(),clock_timestamp()),
  ('b5200000-0000-4000-8000-000000000004','b5100000-0000-4000-8000-000000000004',
   repeat('9',64),'email',repeat('c',64),'fixture',clock_timestamp()+interval '10 minutes',5,
   'accepted',clock_timestamp(),clock_timestamp());

-- Simulate a NIN that has already been canonically bound. The superuser
-- fixture bypasses RLS; activation below executes as the actual runtime role.
insert into identity.patients(id,hid_code,first_name,last_name,full_name,status)
values ('b5300000-0000-4000-8000-000000000004','HID-ABCDEFGJ','Existing','Patient',
  'Existing Patient','active');
insert into identity.patient_identifiers (
  id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, verified, verified_at, verification_provider,
  verification_reference, public_enrollment_id
) values (
  'b5400000-0000-4000-8000-000000000004','b5300000-0000-4000-8000-000000000004',
  'nin',decode(repeat('e4',32),'hex'),repeat('f',64),'fixture',true,clock_timestamp(),
  'qoreid','fixture-prebound-004','b5100000-0000-4000-8000-000000000004'
);

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select set_config('app.correlation_id','public-patient-enrollment-test-0001',true);

do $$
declare
  email_result record;
  phone_result record;
  replay_result record;
  test_hash text := '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret';
begin
  if not identity.public_patient_nin_already_bound(repeat('f',64)::char(64))
    or identity.public_patient_nin_already_bound(repeat('a',64)::char(64)) then
    raise exception 'Public enrollment duplicate-NIN preflight failed';
  end if;
  begin
    perform identity.activate_public_patient_enrollment(
      'b5100000-0000-4000-8000-000000000001',repeat('0',64)::char(64),
      '{"nin":"12345678901","firstName":"Amina","lastName":"Okafor","dateOfBirth":"1990-05-12","gender":"female","providerReference":"fixture-email-001"}',
      'amina@example.invalid','HID-ABCDEFGH',test_hash);
    raise exception 'Wrong enrollment token activated a patient';
  exception when insufficient_privilege then null; end;
  begin
    perform identity.activate_public_patient_enrollment(
      'b5100000-0000-4000-8000-000000000003',repeat('6',64)::char(64),
      '{"nin":"12345678903","firstName":"Chika","lastName":"Eze","dateOfBirth":"1995-07-08","gender":"female","providerReference":"fixture-stage-003"}',
      'chika@example.invalid','HID-ABCDEFGJ',test_hash);
    raise exception 'Unverified-contact enrollment activated a patient';
  exception when check_violation then null; end;
  begin
    perform identity.activate_public_patient_enrollment(
      'b5100000-0000-4000-8000-000000000004',repeat('8',64)::char(64),
      '{"nin":"12345678904","firstName":"Dayo","lastName":"Ibe","dateOfBirth":"1992-11-09","gender":"other","providerReference":"fixture-duplicate-004"}',
      'dayo@example.invalid','HID-ABCDEFGK',test_hash);
    raise exception 'Already-bound NIN activated a second patient';
  exception when unique_violation then null; end;

  select * into email_result from identity.activate_public_patient_enrollment(
    'b5100000-0000-4000-8000-000000000001',repeat('2',64)::char(64),
    '{"nin":"12345678901","firstName":"Amina","lastName":"Okafor","dateOfBirth":"1990-05-12","gender":"female","providerReference":"fixture-email-001"}',
    'Amina@Example.Invalid','HID-ABCDEFGH',test_hash);
  select * into replay_result from identity.activate_public_patient_enrollment(
    'b5100000-0000-4000-8000-000000000001',repeat('2',64)::char(64),
    '{"nin":"12345678901","firstName":"Amina","lastName":"Okafor","dateOfBirth":"1990-05-12","gender":"female","providerReference":"fixture-email-001"}',
    'amina@example.invalid','HID-ABCDEFGH',test_hash);
  select * into phone_result from identity.activate_public_patient_enrollment(
    'b5100000-0000-4000-8000-000000000002',repeat('4',64)::char(64),
    '{"nin":"12345678902","firstName":"Bola","lastName":"Uche","dateOfBirth":"1988-03-04","gender":"male","providerReference":"fixture-phone-002"}',
    '+2348012345678','HID-ABCDEFGM',test_hash);
  if email_result.replayed or not replay_result.replayed or phone_result.replayed
    or email_result.patient_id is null or email_result.account_id is null
    or email_result.patient_id <> replay_result.patient_id
    or email_result.account_id <> replay_result.account_id
    or email_result.hid_code <> replay_result.hid_code
    or phone_result.patient_id = email_result.patient_id
    or phone_result.account_id = email_result.account_id then
    raise exception 'Public patient activation/replay tuple failed';
  end if;
end $$;
reset role;

-- Force deferred enrollment foreign keys to validate before rollback, just
-- as they would at a real activation commit.
set constraints all immediate;

do $$
begin
  if (select count(*) from identity.public_patient_enrollments where state='active'
      and id in ('b5100000-0000-4000-8000-000000000001','b5100000-0000-4000-8000-000000000002')) <> 2
    or (select count(*) from auth.accounts where source_system='hid-public-qoreid-enrollment') <> 2
    or (select count(*) from identity.patients where source_system='hid-public-qoreid-enrollment') <> 2
    or (select count(*) from identity.patient_authoritative_profiles where provider='qoreid') <> 2
    or (select count(*) from identity.patient_assurance_states
      where source_system='hid-public-qoreid-enrollment' and state='NIN_VERIFIED'
        and contact_verified_at is not null and nin_verified_at is not null) <> 2
    or (select count(*) from identity.patient_identifiers
      where source_system='hid-public-qoreid-enrollment' and identifier_type='nin'
        and public_enrollment_id is not null and verified) <> 2
    or (select count(*) from identity.patient_identifiers
      where source_system='hid-public-qoreid-enrollment' and identifier_type='hid_code') <> 2
    or (select count(*) from audit.events
      where correlation_id='public-patient-enrollment-test-0001'
        and action='identity.public-patient-enrollment.activated' and outcome='success') <> 2
    or not exists (select 1 from auth.accounts where email='amina@example.invalid'
      and email_verified_at is not null and password_algorithm='argon2id')
    or not exists (select 1 from auth.accounts account_row
      join identity.patients patient_row on patient_row.account_id=account_row.id
      where patient_row.hid_code='HID-ABCDEFGM' and account_row.email is null
        and patient_row.phone_lookup_hmac=repeat('d',64)) then
    raise exception 'Public patient activation did not persist one complete email and phone identity';
  end if;
  if exists (select 1 from identity.public_patient_enrollments
      where id in ('b5100000-0000-4000-8000-000000000003',
        'b5100000-0000-4000-8000-000000000004') and state='active') then
    raise exception 'Invalid-stage or duplicate-NIN activation changed state';
  end if;
end $$;

rollback;
