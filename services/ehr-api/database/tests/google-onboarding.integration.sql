\set ON_ERROR_STOP on
begin;
set constraints all deferred;

-- Synthetic QoreID, OTP, and contact evidence. The whole suite rolls back.
insert into identity.public_patient_enrollments (
  id,nin_lookup_hmac,nin_last4,nin_ciphertext,profile_ciphertext,profile_sha256,
  key_version,provider_reference,request_hmac,token_hmac,state,contact_channel,
  contact_hmac,contact_lookup_hmac,contact_ciphertext,contact_verified_at,
  verified_challenge_id
) values (
  'b9100000-0000-4000-8000-000000000001',repeat('a',64),'8901',
  decode(repeat('a1',32),'hex'),decode(repeat('b1',32),'hex'),
  encode(public.digest('{"nin":"12345678901","firstName":"Amina","lastName":"Okafor","dateOfBirth":"1990-05-12","gender":"female","providerReference":"google-fixture-001"}','sha256'),'hex'),
  'fixture','google-fixture-001',repeat('1',64),repeat('2',64),'set_password',
  'email',repeat('c',64),repeat('d',64),decode(repeat('e1',32),'hex'),
  clock_timestamp(),'b9110000-0000-4000-8000-000000000001'
), (
  'b9100000-0000-4000-8000-000000000002',repeat('9',64),'8903',
  decode(repeat('a2',32),'hex'),decode(repeat('b2',32),'hex'),
  encode(public.digest('{"nin":"12345678903","firstName":"Ordinary","lastName":"Patient","dateOfBirth":"1991-06-13","gender":"female","providerReference":"ordinary-fixture-001"}','sha256'),'hex'),
  'fixture','ordinary-fixture-001',repeat('6',64),repeat('7',64),'set_password',
  'email',repeat('8',64),repeat('9',64),decode(repeat('e2',32),'hex'),
  clock_timestamp(),'b9110000-0000-4000-8000-000000000002'
);
insert into identity.public_patient_enrollment_otps (
  id,enrollment_id,recipient_hmac,channel,verifier_hmac,verifier_key_version,
  expires_at,max_attempts,delivery_outcome,verified_at,consumed_at
) values (
  'b9110000-0000-4000-8000-000000000001',
  'b9100000-0000-4000-8000-000000000001',repeat('c',64),'email',repeat('f',64),
  'fixture',clock_timestamp()+interval '10 minutes',5,'accepted',
  clock_timestamp(),clock_timestamp()
), (
  'b9110000-0000-4000-8000-000000000002',
  'b9100000-0000-4000-8000-000000000002',repeat('8',64),'email',repeat('7',64),
  'fixture',clock_timestamp()+interval '10 minutes',5,'accepted',
  clock_timestamp(),clock_timestamp()
);
insert into auth.accounts(id,subject,email,status)
values ('b9200000-0000-4000-8000-000000000001',
  'synthetic:google-second-patient','second-google@example.invalid','active');
insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
values ('b9300000-0000-4000-8000-000000000001',
  'b9200000-0000-4000-8000-000000000001','HID-ABCDEF2',
  'Second','Patient','Second Patient','active');

-- Test-only clock control for expiry recovery. SECURITY DEFINER lets the
-- runtime exercise only this synthetic row mutation inside the rollback-only
-- transaction; no equivalent production command exists.
create function pg_temp.expire_google_capability(requested_id uuid)
returns void language sql security definer
set search_path = pg_catalog, auth, pg_temp as $$
  update auth.google_onboarding_capabilities
    set created_at = clock_timestamp() - interval '31 minutes',
        expires_at = clock_timestamp() - interval '1 minute'
    where id = requested_id
$$;

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select set_config('app.correlation_id','google-onboarding-integration-0001',true);

do $$
declare
  enrollment_id uuid := 'b9100000-0000-4000-8000-000000000001';
  capability_id uuid := 'b9400000-0000-4000-8000-000000000001';
  replacement_capability_id uuid := 'b9400000-0000-4000-8000-000000000002';
  token_hash char(64) := repeat('3',64);
  replacement_token_hash char(64) := repeat('4',64);
  activated record;
  capability_expires_at timestamptz;
  test_hash text := '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret';
  profile_json text := '{"nin":"12345678901","firstName":"Amina","lastName":"Okafor","dateOfBirth":"1990-05-12","gender":"female","providerReference":"google-fixture-001"}';
  ordinary_profile_json text := '{"nin":"12345678903","firstName":"Ordinary","lastName":"Patient","dateOfBirth":"1991-06-13","gender":"female","providerReference":"ordinary-fixture-001"}';
  ordinary_activated record;
begin
  if not identity.public_patient_enrollment_ready() then
    raise exception 'Clean-install reconciliation gate unexpectedly blocked Google test';
  end if;
  perform auth.create_google_onboarding_capability(
    'b9400000-0000-4000-8000-000000000004',repeat('6',64),
    'unrelated-google-subject-001');
  select * into ordinary_activated from identity.activate_public_patient_enrollment(
    'b9100000-0000-4000-8000-000000000002',repeat('7',64),ordinary_profile_json,
    'ordinary-google@example.invalid','HID-ABCDEF4',test_hash,repeat('9',64));
  if auth.consume_google_onboarding_capability(
      'b9400000-0000-4000-8000-000000000004',repeat('6',64),
      'b9100000-0000-4000-8000-000000000002',ordinary_activated.account_id)
    or exists (select 1 from auth.resolve_google_identity('unrelated-google-subject-001')) then
    raise exception 'Unbound Google cookie changed an ordinary enrollment';
  end if;
  capability_expires_at := auth.create_google_onboarding_capability(
    capability_id,token_hash,'google-stable-subject-001');
  if capability_expires_at <= clock_timestamp()
    or auth.google_onboarding_capability_status(capability_id,token_hash) is null then
    raise exception 'Accountless Google capability was not created';
  end if;
  if exists(select 1 from auth.accounts where subject='google-stable-subject-001')
    or exists(select 1 from identity.patients where hid_code='HID-ABCDEF3') then
    raise exception 'Pending Google authentication created an HID identity';
  end if;
  begin
    perform auth.bind_google_onboarding_capability(capability_id,repeat('0',64),
      enrollment_id,repeat('2',64));
    raise exception 'Wrong Google capability token bound to enrollment';
  exception when insufficient_privilege then null; end;
  perform auth.bind_google_onboarding_capability(capability_id,token_hash,
    enrollment_id,repeat('2',64));
  -- The same pending proof can be retried with the same enrollment only.
  perform auth.bind_google_onboarding_capability(capability_id,token_hash,
    enrollment_id,repeat('2',64));
  perform pg_temp.expire_google_capability(capability_id);
  perform auth.create_google_onboarding_capability(
    replacement_capability_id,replacement_token_hash,'google-stable-subject-001');
  perform auth.bind_google_onboarding_capability(replacement_capability_id,
    replacement_token_hash,enrollment_id,repeat('2',64));
  if auth.google_onboarding_capability_status(capability_id,token_hash) is not null
    or auth.google_onboarding_capability_status(
      replacement_capability_id,replacement_token_hash) is null
    or not exists (select 1 from auth.google_onboarding_enrollment_requirement(
      enrollment_id,repeat('2',64)) requirement
      where requirement.required and requirement.capability_expires_at > clock_timestamp()) then
    raise exception 'Fresh same-subject proof did not recover the expired bound enrollment';
  end if;
  begin
    perform auth.bind_google_onboarding_capability(capability_id,token_hash,
      enrollment_id,repeat('2',64));
    raise exception 'Expired replaced Google proof was reusable';
  exception when insufficient_privilege then null; end;
  begin
    perform auth.consume_google_onboarding_capability(replacement_capability_id,
      replacement_token_hash,
      enrollment_id,'b9200000-0000-4000-8000-000000000001');
    raise exception 'Pending Google capability linked before patient activation';
  exception when insufficient_privilege then null; end;

  -- A failed Google link must roll back the account/patient/HID creation from
  -- the same transaction, including the consumed OTP and NIN assurance writes.
  begin
    select * into activated from identity.activate_public_patient_enrollment(
      enrollment_id,repeat('2',64),profile_json,'amina-google@example.invalid',
      'HID-ABCDEF3',test_hash,repeat('d',64));
    perform auth.consume_google_onboarding_capability(replacement_capability_id,repeat('0',64),
      enrollment_id,activated.account_id);
    raise exception 'Wrong Google proof linked after activation';
  exception when insufficient_privilege then
    if SQLERRM <> 'GOOGLE_ONBOARDING_DENIED' then raise; end if;
  end;
  if exists (select 1 from identity.public_patient_enrollments
    where id=enrollment_id and (state <> 'set_password' or account_id is not null
      or patient_id is not null)) then
    raise exception 'Google link failure did not roll back HID activation';
  end if;

  select * into activated from identity.activate_public_patient_enrollment(
    enrollment_id,repeat('2',64),profile_json,'amina-google@example.invalid',
    'HID-ABCDEF3',test_hash,repeat('d',64));
  if activated.replayed or activated.account_id is null or activated.patient_id is null then
    raise exception 'Verified patient activation failed';
  end if;
  perform auth.consume_google_onboarding_capability(replacement_capability_id,
    replacement_token_hash,
    enrollment_id,activated.account_id);
  if auth.google_onboarding_capability_status(
      replacement_capability_id,replacement_token_hash) is not null
    or not exists (select 1 from auth.resolve_google_identity('google-stable-subject-001')
      where account_id=activated.account_id) then
    raise exception 'Google link was not committed against the activated HID account';
  end if;
  -- Lost-response replay is safe after the short-lived cookie has been cleared.
  perform auth.consume_google_onboarding_capability(null,null,enrollment_id,activated.account_id);
  begin
    perform auth.bind_google_onboarding_capability(replacement_capability_id,
      replacement_token_hash,
      enrollment_id,repeat('2',64));
    raise exception 'Consumed Google capability was rebound';
  exception when insufficient_privilege then null; end;
  begin
    perform auth.link_google_identity_to_patient_account(
      'b9200000-0000-4000-8000-000000000001','google-stable-subject-001');
    raise exception 'One Google subject linked to two HID accounts';
  exception when unique_violation then null; end;
  begin
    perform auth.create_google_onboarding_capability(
      'b9400000-0000-4000-8000-000000000003',repeat('5',64),
      'google-stable-subject-001');
    raise exception 'Linked Google subject received another accountless capability';
  exception when unique_violation then null; end;
end $$;

reset role;
set constraints all immediate;
do $$
begin
  if (select count(*) from auth.google_onboarding_capabilities
      where google_subject='google-stable-subject-001' and consumed_at is not null
        and linked_account_id is not null) <> 1
    or (select count(*) from auth.google_onboarding_capabilities
      where google_subject='google-stable-subject-001'
        and invalidation_reason='replaced_by_fresh_google_proof'
        and bound_enrollment_id is null) <> 1
    or (select count(*) from auth.external_identities
      where issuer='https://accounts.google.com'
        and subject='google-stable-subject-001' and status='active') <> 1
    or not exists (select 1 from identity.patient_assurance_states assurance
      join identity.public_patient_enrollments enrollment
        on enrollment.patient_id=assurance.patient_id
      where enrollment.id='b9100000-0000-4000-8000-000000000001'
        and assurance.state='NIN_VERIFIED')
    or (select count(*) from audit.events
      where correlation_id='google-onboarding-integration-0001'
        and action='auth.google.onboarding.link' and outcome='success') <> 1 then
    raise exception 'Google capability, exact subject, or audit evidence was not singular';
  end if;
end $$;

rollback;
