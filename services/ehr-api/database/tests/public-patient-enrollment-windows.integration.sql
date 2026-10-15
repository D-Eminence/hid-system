\set ON_ERROR_STOP on
begin;

-- 0085: activation refuses a contact proof more than 30 minutes old (N2(c))
-- and a replay of an activation more than 15 minutes old (N2(b)). Fixture
-- ciphertext bytes and an inert Argon2-shaped hash; every account and patient
-- created below rolls back. Each command runs as the Identity API runtime.
insert into identity.public_patient_enrollments (
  id, nin_lookup_hmac, nin_last4, nin_ciphertext, profile_ciphertext,
  profile_sha256, key_version, provider_reference, request_hmac, token_hmac,
  state, contact_channel, contact_hmac, contact_lookup_hmac, contact_ciphertext,
  contact_verified_at, verified_challenge_id
) values
  -- Contact proved 31 minutes ago: too old.
  ('b8500000-0000-4000-8000-000000000001', repeat('a',64), '8901', decode(repeat('a1',32),'hex'),
   decode(repeat('b1',32),'hex'),
   encode(public.digest('{"nin":"12345678901","firstName":"Amina","lastName":"Okafor","dateOfBirth":"1990-05-12","gender":"female","providerReference":"window-stale-001"}', 'sha256'),'hex'),
   'fixture', 'window-stale-001', repeat('1',64), repeat('2',64),
   'set_password', 'email', repeat('c',64), repeat('e1',32), decode(repeat('d1',32),'hex'),
   clock_timestamp() - interval '31 minutes', 'b8510000-0000-4000-8000-000000000001'),
  -- Contact proved 29 minutes ago: still fresh.
  ('b8500000-0000-4000-8000-000000000002', repeat('b',64), '8902', decode(repeat('a2',32),'hex'),
   decode(repeat('b2',32),'hex'),
   encode(public.digest('{"nin":"12345678902","firstName":"Bola","lastName":"Uche","dateOfBirth":"1988-03-04","gender":"male","providerReference":"window-fresh-002"}', 'sha256'),'hex'),
   'fixture', 'window-fresh-002', repeat('3',64), repeat('4',64),
   'set_password', 'phone', repeat('d',64), repeat('e2',32), decode(repeat('d2',32),'hex'),
   clock_timestamp() - interval '29 minutes', 'b8510000-0000-4000-8000-000000000002');

insert into identity.public_patient_enrollment_otps (
  id, enrollment_id, recipient_hmac, channel, verifier_hmac,
  verifier_key_version, expires_at, max_attempts, delivery_outcome,
  verified_at, consumed_at
) values
  ('b8510000-0000-4000-8000-000000000001','b8500000-0000-4000-8000-000000000001',
   repeat('c',64),'email',repeat('a',64),'fixture',clock_timestamp()-interval '26 minutes',5,
   'accepted',clock_timestamp()-interval '31 minutes',clock_timestamp()-interval '31 minutes'),
  ('b8510000-0000-4000-8000-000000000002','b8500000-0000-4000-8000-000000000002',
   repeat('d',64),'phone',repeat('b',64),'fixture',clock_timestamp()-interval '24 minutes',5,
   'accepted',clock_timestamp()-interval '29 minutes',clock_timestamp()-interval '29 minutes');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select set_config('app.correlation_id','public-enrollment-windows-0001',true);

do $$
declare
  test_hash text := '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret';
  activated record;
  replayed record;
begin
  -- The token is still checked first: a wrong token is denied, whatever the proof's age.
  begin
    perform identity.activate_public_patient_enrollment(
      'b8500000-0000-4000-8000-000000000001',repeat('0',64)::char(64),
      '{"nin":"12345678901","firstName":"Amina","lastName":"Okafor","dateOfBirth":"1990-05-12","gender":"female","providerReference":"window-stale-001"}',
      'amina@example.invalid','HID-ABCDEFGH',test_hash,repeat('e1',32)::char(64));
    raise exception 'A wrong enrollment token activated a patient';
  exception when insufficient_privilege then null; end;

  begin
    perform identity.activate_public_patient_enrollment(
      'b8500000-0000-4000-8000-000000000001',repeat('2',64)::char(64),
      '{"nin":"12345678901","firstName":"Amina","lastName":"Okafor","dateOfBirth":"1990-05-12","gender":"female","providerReference":"window-stale-001"}',
      'amina@example.invalid','HID-ABCDEFGH',test_hash,repeat('e1',32)::char(64));
    raise exception 'A contact proof 31 minutes old activated a patient';
  exception when check_violation then
    if sqlerrm <> 'PATIENT_CONTACT_REVERIFY_REQUIRED' then
      raise exception 'A stale contact proof was refused with % instead of PATIENT_CONTACT_REVERIFY_REQUIRED', sqlerrm;
    end if;
  end;

  select * into activated from identity.activate_public_patient_enrollment(
    'b8500000-0000-4000-8000-000000000002',repeat('4',64)::char(64),
    '{"nin":"12345678902","firstName":"Bola","lastName":"Uche","dateOfBirth":"1988-03-04","gender":"male","providerReference":"window-fresh-002"}',
    '+2348012345678','HID-ABCDEFGM',test_hash,repeat('e2',32)::char(64));
  select * into replayed from identity.activate_public_patient_enrollment(
    'b8500000-0000-4000-8000-000000000002',repeat('4',64)::char(64),
    '{"nin":"12345678902","firstName":"Bola","lastName":"Uche","dateOfBirth":"1988-03-04","gender":"male","providerReference":"window-fresh-002"}',
    '+2348012345678','HID-ABCDEFGN',test_hash,repeat('e2',32)::char(64));
  if activated.replayed or not replayed.replayed or activated.hid_code <> 'HID-ABCDEFGM'
     or replayed.hid_code is distinct from activated.hid_code
     or replayed.patient_id is distinct from activated.patient_id then
    raise exception 'A contact proof 29 minutes old did not activate and replay';
  end if;
end $$;
reset role;

-- The stale enrollment is unchanged and created nothing.
do $$ begin
  if (select state from identity.public_patient_enrollments
      where id = 'b8500000-0000-4000-8000-000000000001') <> 'set_password'
     or exists (select 1 from identity.patient_authoritative_profiles
       where enrollment_id = 'b8500000-0000-4000-8000-000000000001')
     or (select count(*) from audit.events where correlation_id = 'public-enrollment-windows-0001'
       and action = 'identity.public-patient-enrollment.activated') <> 1 then
    raise exception 'A refused stale activation changed state';
  end if;
end $$;

-- A replay 14 minutes after activation still answers the HID; 16 minutes after, it does not.
update identity.public_patient_enrollments set activated_at = clock_timestamp() - interval '14 minutes'
 where id = 'b8500000-0000-4000-8000-000000000002';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
declare
  test_hash text := '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret';
  replayed record;
begin
  select * into replayed from identity.activate_public_patient_enrollment(
    'b8500000-0000-4000-8000-000000000002',repeat('4',64)::char(64),
    '{"nin":"12345678902","firstName":"Bola","lastName":"Uche","dateOfBirth":"1988-03-04","gender":"male","providerReference":"window-fresh-002"}',
    '+2348012345678','HID-ABCDEFGP',test_hash,repeat('e2',32)::char(64));
  if not replayed.replayed or replayed.hid_code <> 'HID-ABCDEFGM' then
    raise exception 'A replay 14 minutes after activation did not answer the HID';
  end if;
end $$;
reset role;

update identity.public_patient_enrollments set activated_at = clock_timestamp() - interval '16 minutes'
 where id = 'b8500000-0000-4000-8000-000000000002';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
declare
  test_hash text := '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret';
  replayed record;
begin
  begin
    select * into replayed from identity.activate_public_patient_enrollment(
      'b8500000-0000-4000-8000-000000000002',repeat('4',64)::char(64),
      '{"nin":"12345678902","firstName":"Bola","lastName":"Uche","dateOfBirth":"1988-03-04","gender":"male","providerReference":"window-fresh-002"}',
      '+2348012345678','HID-ABCDEFGQ',test_hash,repeat('e2',32)::char(64));
    raise exception 'A replay 16 minutes after activation answered %', replayed.hid_code;
  exception when no_data_found then
    if sqlerrm <> 'PATIENT_ENROLLMENT_REPLAY_EXPIRED' then
      raise exception 'An expired replay was refused with % instead of PATIENT_ENROLLMENT_REPLAY_EXPIRED', sqlerrm;
    end if;
  end;
end $$;
reset role;

-- The function has its 0092 signature (0085's arguments and the two
-- self-reported profile fields of ADR-061, which default to null so that the
-- 7-argument calls above still resolve), owner-only definition and grants.
do $$ begin
  if not has_function_privilege('hid_identity_runtime',
       'identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char,date,text)', 'EXECUTE')
     or has_function_privilege('public',
       'identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char,date,text)', 'EXECUTE')
     or has_function_privilege('hid_ehr_runtime',
       'identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char,date,text)', 'EXECUTE')
     or not (select prosecdef from pg_proc
       where oid = 'identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char,date,text)'::regprocedure) then
    raise exception 'The activation command lost its signature, definer rights or grants';
  end if;
end $$;

rollback;
