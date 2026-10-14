\set ON_ERROR_STOP on
begin;

-- 0092 (ADR-061): QoreID may return a NIN record with only the name, the NIN
-- and its reference. The patient then enters the missing date of birth or
-- gender at activation, as the two new arguments of
-- identity.activate_public_patient_enrollment. A value the NIN record carries
-- can never be replaced, the authoritative profile stays what QoreID
-- returned, and the activation audit event names the fields taken from the
-- request (never their values). Fixture ciphertext bytes and an inert
-- Argon2-shaped hash; every account and patient created below rolls back.
-- Each command runs as the Identity API runtime. Every name, NIN and contact
-- here is invented.
insert into identity.public_patient_enrollments (
  id, nin_lookup_hmac, nin_last4, nin_ciphertext, profile_ciphertext,
  profile_sha256, key_version, provider_reference, request_hmac, token_hmac,
  state, contact_channel, contact_hmac, contact_lookup_hmac, contact_ciphertext,
  contact_verified_at, verified_challenge_id
) values
  -- A: the record has neither a date of birth nor a gender.
  ('b9200000-0000-4000-8000-000000000001', repeat('91',32), '9201', decode(repeat('a1',32),'hex'),
   decode(repeat('b1',32),'hex'),
   encode(public.digest('{"nin":"12345679201","firstName":"Ngozi","lastName":"Sample","providerReference":"self-reported-001"}', 'sha256'),'hex'),
   'fixture', 'self-reported-001', repeat('92',32), repeat('93',32),
   'set_password', 'email', repeat('94',32), repeat('95',32), decode(repeat('d1',32),'hex'),
   clock_timestamp() - interval '1 minute', 'b9210000-0000-4000-8000-000000000001'),
  -- B: a complete record, activated by the 7-argument call 0085 callers make.
  ('b9200000-0000-4000-8000-000000000002', repeat('96',32), '9202', decode(repeat('a2',32),'hex'),
   decode(repeat('b2',32),'hex'),
   encode(public.digest('{"nin":"12345679202","firstName":"Emeka","lastName":"Sample","dateOfBirth":"1987-04-05","gender":"male","providerReference":"self-reported-002"}', 'sha256'),'hex'),
   'fixture', 'self-reported-002', repeat('97',32), repeat('98',32),
   'set_password', 'phone', repeat('99',32), repeat('9a',32), decode(repeat('d2',32),'hex'),
   clock_timestamp() - interval '1 minute', 'b9210000-0000-4000-8000-000000000002'),
  -- C: the record has a date of birth but no gender.
  ('b9200000-0000-4000-8000-000000000003', repeat('9b',32), '9203', decode(repeat('a3',32),'hex'),
   decode(repeat('b3',32),'hex'),
   encode(public.digest('{"nin":"12345679203","firstName":"Funke","lastName":"Sample","dateOfBirth":"1993-08-09","providerReference":"self-reported-003"}', 'sha256'),'hex'),
   'fixture', 'self-reported-003', repeat('9c',32), repeat('9d',32),
   'set_password', 'email', repeat('9e',32), repeat('9f',32), decode(repeat('d3',32),'hex'),
   clock_timestamp() - interval '1 minute', 'b9210000-0000-4000-8000-000000000003');

insert into identity.public_patient_enrollment_otps (
  id, enrollment_id, recipient_hmac, channel, verifier_hmac,
  verifier_key_version, expires_at, max_attempts, delivery_outcome,
  verified_at, consumed_at
) values
  ('b9210000-0000-4000-8000-000000000001','b9200000-0000-4000-8000-000000000001',
   repeat('94',32),'email',repeat('a',64),'fixture',clock_timestamp()+interval '4 minutes',5,
   'accepted',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute'),
  ('b9210000-0000-4000-8000-000000000002','b9200000-0000-4000-8000-000000000002',
   repeat('99',32),'phone',repeat('b',64),'fixture',clock_timestamp()+interval '4 minutes',5,
   'accepted',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute'),
  ('b9210000-0000-4000-8000-000000000003','b9200000-0000-4000-8000-000000000003',
   repeat('9e',32),'email',repeat('c',64),'fixture',clock_timestamp()+interval '4 minutes',5,
   'accepted',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select set_config('app.correlation_id','public-enrollment-self-reported-0001',true);

do $$
declare
  test_hash text := '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret';
  profile_a text := '{"nin":"12345679201","firstName":"Ngozi","lastName":"Sample","providerReference":"self-reported-001"}';
  profile_b text := '{"nin":"12345679202","firstName":"Emeka","lastName":"Sample","dateOfBirth":"1987-04-05","gender":"male","providerReference":"self-reported-002"}';
  profile_c text := '{"nin":"12345679203","firstName":"Funke","lastName":"Sample","dateOfBirth":"1993-08-09","providerReference":"self-reported-003"}';
  refused record;
  activated record;
  replayed record;
begin
  -- A record without them: each missing field must be entered, and each must
  -- be a real date from 1900-01-01 to today and a listed gender.
  for refused in
    select * from (values
      ('the 7-argument call', null::date, null::text),
      ('a date of birth alone', date '1991-02-03', null),
      ('a gender alone', null, 'female'),
      ('a date of birth tomorrow', current_date + 1, 'female'),
      ('a date of birth before 1900', date '1899-12-31', 'female'),
      ('a gender outside the list', date '1991-02-03', 'F'),
      ('an empty gender', date '1991-02-03', '')
    ) as attempt(label, requested_date_of_birth, requested_gender)
  loop
    begin
      perform identity.activate_public_patient_enrollment(
        'b9200000-0000-4000-8000-000000000001',repeat('93',32)::char(64),profile_a,
        'ngozi.sample@example.invalid','HID-SELFRPTA',test_hash,repeat('95',32)::char(64),
        refused.requested_date_of_birth, refused.requested_gender);
      raise exception 'A record without a date of birth or gender activated with %', refused.label;
    exception when check_violation then
      if sqlerrm <> 'PATIENT_IDENTITY_INVALID' then
        raise exception '% was refused with % instead of PATIENT_IDENTITY_INVALID', refused.label, sqlerrm;
      end if;
    end;
  end loop;

  -- A complete record: neither of its values can be replaced.
  for refused in
    select * from (values
      ('a date of birth the record has', date '1990-01-02', null::text),
      ('a gender the record has', null::date, 'female'),
      ('both', date '1987-04-05', 'male')
    ) as attempt(label, requested_date_of_birth, requested_gender)
  loop
    begin
      perform identity.activate_public_patient_enrollment(
        'b9200000-0000-4000-8000-000000000002',repeat('98',32)::char(64),profile_b,
        '+2348099990002','HID-SELFRPTB',test_hash,repeat('9a',32)::char(64),
        refused.requested_date_of_birth, refused.requested_gender);
      raise exception 'A complete record activated with % from the request', refused.label;
    exception when check_violation then
      if sqlerrm <> 'PATIENT_IDENTITY_INVALID' then
        raise exception '% was refused with % instead of PATIENT_IDENTITY_INVALID', refused.label, sqlerrm;
      end if;
    end;
  end loop;

  -- A record with a date of birth but no gender: the date stays the record's.
  begin
    perform identity.activate_public_patient_enrollment(
      'b9200000-0000-4000-8000-000000000003',repeat('9d',32)::char(64),profile_c,
      'funke.sample@example.invalid','HID-SELFRPTC',test_hash,repeat('9f',32)::char(64),
      date '1990-01-02','female');
    raise exception 'A date of birth from the request replaced the record''s';
  exception when check_violation then
    if sqlerrm <> 'PATIENT_IDENTITY_INVALID' then
      raise exception 'A replaced date of birth was refused with % instead of PATIENT_IDENTITY_INVALID', sqlerrm;
    end if;
  end;

  -- Every refusal above left its enrollment waiting for its password.
  if (select count(*) from identity.public_patient_enrollments
      where id::text like 'b9200000-0000-4000-8000-00000000000_' and state = 'set_password') <> 3 then
    raise exception 'A refused activation changed an enrollment';
  end if;

  -- A: both fields from the request.
  select * into activated from identity.activate_public_patient_enrollment(
    'b9200000-0000-4000-8000-000000000001',repeat('93',32)::char(64),profile_a,
    'ngozi.sample@example.invalid','HID-SELFRPTA',test_hash,repeat('95',32)::char(64),
    date '1991-02-03','female');
  if activated.replayed or activated.hid_code <> 'HID-SELFRPTA' then
    raise exception 'A record without a date of birth or gender did not activate with both entered';
  end if;
  -- A replay ignores the new arguments, whatever they are.
  select * into replayed from identity.activate_public_patient_enrollment(
    'b9200000-0000-4000-8000-000000000001',repeat('93',32)::char(64),profile_a,
    'ngozi.sample@example.invalid','HID-SELFRPTD',test_hash,repeat('95',32)::char(64),
    date '1960-06-07','other');
  if not replayed.replayed or replayed.hid_code <> 'HID-SELFRPTA'
     or replayed.patient_id is distinct from activated.patient_id then
    raise exception 'A replay of a self-reported activation did not answer the same HID';
  end if;

  -- B: the 7-argument call still activates a complete record.
  select * into activated from identity.activate_public_patient_enrollment(
    'b9200000-0000-4000-8000-000000000002',repeat('98',32)::char(64),profile_b,
    '+2348099990002','HID-SELFRPTB',test_hash,repeat('9a',32)::char(64));
  if activated.replayed or activated.hid_code <> 'HID-SELFRPTB' then
    raise exception 'The 7-argument call did not activate a complete record';
  end if;

  -- C: the gender alone from the request.
  select * into activated from identity.activate_public_patient_enrollment(
    'b9200000-0000-4000-8000-000000000003',repeat('9d',32)::char(64),profile_c,
    'funke.sample@example.invalid','HID-SELFRPTC',test_hash,repeat('9f',32)::char(64),
    null,'intersex');
  if activated.replayed or activated.hid_code <> 'HID-SELFRPTC' then
    raise exception 'A record without a gender did not activate with the gender entered';
  end if;
end $$;
reset role;

set constraints all immediate;

-- The patient holds the record's values and the entered ones; the
-- authoritative profile stays exactly what QoreID returned; the audit event
-- names the entered fields only.
do $$
declare
  checked record;
begin
  for checked in
    select * from (values
      ('b9200000-0000-4000-8000-000000000001'::uuid, 'HID-SELFRPTA', date '1991-02-03', 'female',
       '["dateOfBirth", "gender"]'::jsonb),
      ('b9200000-0000-4000-8000-000000000002'::uuid, 'HID-SELFRPTB', date '1987-04-05', 'male', '[]'::jsonb),
      ('b9200000-0000-4000-8000-000000000003'::uuid, 'HID-SELFRPTC', date '1993-08-09', 'intersex',
       '["gender"]'::jsonb)
    ) as expected(enrollment_id, hid_code, dob, gender, self_reported)
  loop
    if not exists (select 1 from identity.public_patient_enrollments enrollment
        join identity.patients patient on patient.id = enrollment.patient_id
        where enrollment.id = checked.enrollment_id and enrollment.state = 'active'
          and patient.hid_code = checked.hid_code and patient.dob = checked.dob
          and patient.gender = checked.gender
          and patient.source_system = 'hid-public-qoreid-enrollment') then
      raise exception 'Enrollment % did not store date of birth % and gender %',
        checked.enrollment_id, checked.dob, checked.gender;
    end if;
    if not exists (select 1 from identity.patient_authoritative_profiles profile
        join identity.public_patient_enrollments enrollment on enrollment.id = profile.enrollment_id
        where enrollment.id = checked.enrollment_id
          and profile.patient_id = enrollment.patient_id
          and profile.profile_ciphertext = enrollment.profile_ciphertext
          and profile.profile_sha256 = enrollment.profile_sha256
          and profile.provider = 'qoreid'
          and profile.provider_reference = enrollment.provider_reference) then
      raise exception 'Enrollment % changed the authoritative profile QoreID returned', checked.enrollment_id;
    end if;
    if (select count(*) from audit.events event
        join identity.public_patient_enrollments enrollment on enrollment.patient_id = event.patient_id
        where enrollment.id = checked.enrollment_id
          and event.correlation_id = 'public-enrollment-self-reported-0001'
          and event.action = 'identity.public-patient-enrollment.activated'
          and event.outcome = 'success'
          and event.details -> 'selfReportedFields' = checked.self_reported
          and event.details ->> 'provider' = 'qoreid') <> 1 then
      raise exception 'Enrollment % did not audit selfReportedFields %', checked.enrollment_id, checked.self_reported;
    end if;
  end loop;
  -- Names only: no audit detail carries an entered or recorded value.
  if exists (select 1 from audit.events where correlation_id = 'public-enrollment-self-reported-0001'
      and (details::text ~ '19[0-9]{2}-[0-9]{2}-[0-9]{2}'
        or details::text ~* '"(female|male|intersex|other|unknown)"')) then
    raise exception 'An activation audit event carries a date of birth or gender value';
  end if;
  if (select count(*) from audit.events where correlation_id = 'public-enrollment-self-reported-0001'
      and action = 'identity.public-patient-enrollment.activated') <> 3 then
    raise exception 'The replay or a refusal wrote an activation audit event';
  end if;
end $$;

-- One activation command: the 0092 signature, security definer with 0085's
-- search path, result and owner, executable by the Identity runtime only.
do $$
declare
  command regprocedure := 'identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char,date,text)'::regprocedure;
begin
  if to_regprocedure('identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char)') is not null
     or (select count(*) from pg_proc proc join pg_namespace namespace_row on namespace_row.oid = proc.pronamespace
         where namespace_row.nspname = 'identity' and proc.proname = 'activate_public_patient_enrollment') <> 1 then
    raise exception 'The 7-argument activation command still exists beside the 0092 one';
  end if;
  if not (select prosecdef from pg_proc where oid = command)
     or (select proconfig from pg_proc where oid = command)
       is distinct from array['search_path=pg_catalog, identity, auth, audit, platform, public, pg_temp']
     or pg_get_function_result(command) <> 'TABLE(patient_id uuid, hid_code text, account_id uuid, replayed boolean)'
     or (select pronargdefaults from pg_proc where oid = command) <> 2
     or (select proowner from pg_proc where oid = command)
       <> (select proowner from pg_proc where oid = 'identity.public_patient_enrollment_ready()'::regprocedure) then
    raise exception 'The activation command lost its definer rights, search path, result, defaults or owner';
  end if;
  if not has_function_privilege('hid_identity_runtime', command, 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime', command, 'EXECUTE')
     or not has_function_privilege('hid_schema_test_runtime', command, 'EXECUTE')
     or has_function_privilege('public', command, 'EXECUTE')
     or has_function_privilege('hid_ehr_runtime', command, 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime', command, 'EXECUTE') then
    raise exception 'The activation command is executable by a role other than the Identity runtime';
  end if;
end $$;

rollback;
