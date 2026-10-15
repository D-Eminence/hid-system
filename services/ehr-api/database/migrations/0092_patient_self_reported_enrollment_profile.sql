-- Public patient enrollment: a NIN record without a date of birth or gender
-- (ADR-061). QoreID may return only the name, the NIN and its reference; the
-- patient then enters the missing date of birth or gender at activation.
-- Applied migrations 0001 through 0091 are immutable.
--
-- identity.activate_public_patient_enrollment (0085) required both in the
-- profile JSON, which must hash to the enrollment's profile_sha256, so the
-- Identity API could not add them. It is dropped and created again with two
-- more arguments, requested_date_of_birth and requested_gender, both default
-- null, so a 7-argument call (the Identity build before this one, and the
-- SQL suites) still resolves to it. Everything else is 0085's: owner,
-- SECURITY DEFINER, search_path, result, the replay branch (which ignores the
-- new arguments) and every other check. Only the profile check changes:
--   * a dateOfBirth or gender the profile gives is checked as before, and the
--     matching argument must be null: a value the NIN record gives can never
--     be replaced;
--   * one the profile lacks must be given: a date from 1900-01-01 to
--     current_date, a gender in the list;
--   * any failure raises 23514 PATIENT_IDENTITY_INVALID.
-- identity.patients.dob and gender take the profile value or the entered
-- one. identity.patient_authoritative_profiles still stores the profile
-- exactly as QoreID returned it, so a value in identity.patients that the
-- authoritative profile lacks was self-reported. The activation audit event's
-- details gain selfReportedFields: the names of the fields taken from the
-- request, never their values ([] when none).
--
-- Dropping the function drops its grants. The role bootstrap
-- (runtime-grants.sql), which runs after every migration, grants EXECUTE on
-- the new signature to hid_identity_runtime and hid_schema_test_runtime, as
-- it did after 0058 dropped the 6-argument form. Until it has run, only the
-- owner can activate; run db:bootstrap and db:verify-roles right after this
-- migration.

drop function identity.activate_public_patient_enrollment(uuid,char(64),text,text,text,text,char(64));

create function identity.activate_public_patient_enrollment(
  requested_enrollment_id uuid, requested_token_hmac char(64), requested_profile_json text,
  requested_contact text, requested_hid text, requested_password_hash text,
  requested_contact_lookup_hmac char(64),
  requested_date_of_birth date default null, requested_gender text default null
) returns table (patient_id uuid, hid_code text, account_id uuid, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, public, pg_temp
as $$
declare
  enrollment identity.public_patient_enrollments%rowtype;
  profile jsonb;
  new_account uuid;
  new_patient uuid;
  normalized_email text;
  patient_dob date;
  patient_gender text;
  self_reported_fields jsonb := '[]'::jsonb;
begin
  if platform.current_actor_subject() <> 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if not identity.public_patient_enrollment_ready() then
    raise exception using errcode = '55000', message = 'PATIENT_ENROLLMENT_RECONCILIATION_REQUIRED';
  end if;
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.token_hmac <> requested_token_hmac then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if enrollment.state = 'active' then
    -- N2(b): the HID is shown again for 15 minutes after activation only.
    if enrollment.activated_at is null
      or enrollment.activated_at <= clock_timestamp() - interval '15 minutes' then
      raise exception using errcode = 'P0002', message = 'PATIENT_ENROLLMENT_REPLAY_EXPIRED';
    end if;
    return query select enrollment.patient_id,
      (select patient.hid_code from identity.patients patient where patient.id = enrollment.patient_id),
      enrollment.account_id, true;
    return;
  end if;
  -- N2(c): a contact proof older than 30 minutes is verified again.
  if enrollment.state = 'set_password'
    and enrollment.contact_verified_at <= clock_timestamp() - interval '30 minutes' then
    raise exception using errcode = '23514', message = 'PATIENT_CONTACT_REVERIFY_REQUIRED';
  end if;
  if enrollment.state <> 'set_password' or enrollment.expires_at <= clock_timestamp()
    or enrollment.contact_verified_at is null or enrollment.verified_challenge_id is null
    or enrollment.contact_lookup_hmac is null
    or requested_contact_lookup_hmac is null
    or enrollment.contact_lookup_hmac <> requested_contact_lookup_hmac
    or requested_contact_lookup_hmac !~ '^[0-9a-f]{64}$'
    or requested_hid !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'
    or requested_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$'
    or length(requested_password_hash) not between 64 and 512
    or requested_profile_json is null or length(requested_profile_json) > 1048576
    or encode(public.digest(requested_profile_json, 'sha256'), 'hex') <> enrollment.profile_sha256 then
    raise exception using errcode = '23514', message = 'PATIENT_ENROLLMENT_NOT_READY';
  end if;
  if not exists (select 1 from identity.public_patient_enrollment_otps challenge
    where challenge.id = enrollment.verified_challenge_id and challenge.enrollment_id = enrollment.id
      and challenge.channel = enrollment.contact_channel
      and challenge.recipient_hmac = enrollment.contact_hmac
      and challenge.verified_at is not null and challenge.consumed_at is not null
      and challenge.invalidated_at is null) then
    raise exception using errcode = '23514', message = 'PATIENT_CONTACT_NOT_VERIFIED';
  end if;
  profile := requested_profile_json::jsonb;
  if jsonb_typeof(profile) <> 'object' or coalesce(profile->>'nin','') !~ '^[0-9]{11}$'
    or right(profile->>'nin',4) <> enrollment.nin_last4
    or coalesce(profile->>'firstName','') !~ '^[^[:cntrl:]]{1,100}$'
    or coalesce(profile->>'lastName','') !~ '^[^[:cntrl:]]{1,100}$'
    or coalesce(profile->>'providerReference','') <> enrollment.provider_reference then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
  -- 0092 (ADR-061): a date of birth or gender the NIN record gives is checked
  -- as before and cannot come from the request; one it lacks must. The format
  -- is checked before the cast, and a date that is not on the calendar is
  -- refused like any other invalid identity, not raised as a cast error.
  if profile->>'dateOfBirth' is not null then
    if profile->>'dateOfBirth' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or requested_date_of_birth is not null then
      raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
    end if;
    begin
      patient_dob := (profile->>'dateOfBirth')::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
    end;
  else
    patient_dob := requested_date_of_birth;
    self_reported_fields := self_reported_fields || '["dateOfBirth"]'::jsonb;
  end if;
  if patient_dob is null or patient_dob < date '1900-01-01' or patient_dob > current_date then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
  if profile->>'gender' is not null then
    if requested_gender is not null then
      raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
    end if;
    patient_gender := profile->>'gender';
  else
    patient_gender := requested_gender;
    self_reported_fields := self_reported_fields || '["gender"]'::jsonb;
  end if;
  if patient_gender is null or patient_gender not in ('female','male','intersex','other','unknown') then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-nin:' || enrollment.nin_lookup_hmac, 0));
  if identity.public_patient_nin_already_bound(enrollment.nin_lookup_hmac) then
    raise exception using errcode = '23505', message = 'PATIENT_NIN_ALREADY_BOUND';
  end if;
  if enrollment.contact_channel = 'email' then
    normalized_email := lower(btrim(requested_contact));
    if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or length(normalized_email) > 254 then
      raise exception using errcode = '22023', message = 'PATIENT_CONTACT_INVALID';
    end if;
  elsif enrollment.contact_channel = 'phone' then
    if requested_contact !~ '^\+[1-9][0-9]{7,14}$' then
      raise exception using errcode = '22023', message = 'PATIENT_CONTACT_INVALID';
    end if;
  else
    raise exception using errcode = '23514', message = 'PATIENT_CONTACT_NOT_VERIFIED';
  end if;
  if identity.public_patient_contact_already_bound(
    enrollment.contact_channel, enrollment.contact_lookup_hmac) then
    raise exception using errcode = '23505', message = 'PATIENT_CONTACT_ALREADY_BOUND';
  end if;
  new_account := gen_random_uuid();
  new_patient := gen_random_uuid();
  -- Set IDs before inserting the canonical patient so FORCE RLS can prove the
  -- exact pending enrollment tuple. All writes commit or roll back together.
  update identity.public_patient_enrollments set account_id = new_account,
    patient_id = new_patient, updated_at = clock_timestamp(), row_version = row_version + 1
    where id = enrollment.id;
  insert into auth.accounts(id,subject,email,display_name,status,password_hash,
    password_algorithm,password_changed_at,email_verified_at,source_system)
  values(new_account,'patient:' || new_account::text,normalized_email,
    btrim(profile->>'firstName') || ' ' || btrim(profile->>'lastName'),
    'active',requested_password_hash,'argon2id',clock_timestamp(),
    case when normalized_email is not null then enrollment.contact_verified_at else null end,
    'hid-public-qoreid-enrollment');
  insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,
    gender,dob,phone_e164_ciphertext,phone_lookup_hmac,email_ciphertext,email_lookup_hmac,
    contact_key_version,source_system,status)
  values(new_patient,new_account,requested_hid,btrim(profile->>'firstName'),btrim(profile->>'lastName'),
    btrim(profile->>'firstName') || ' ' || btrim(profile->>'lastName'),patient_gender,
    patient_dob,
    case when enrollment.contact_channel = 'phone' then enrollment.contact_ciphertext else null end,
    case when enrollment.contact_channel = 'phone' then enrollment.contact_lookup_hmac else null end,
    case when enrollment.contact_channel = 'email' then enrollment.contact_ciphertext else null end,
    case when enrollment.contact_channel = 'email' then enrollment.contact_lookup_hmac else null end,
    enrollment.key_version,'hid-public-qoreid-enrollment','active');
  insert into identity.patient_identifiers(id,patient_id,identifier_type,public_value,verified,source_system)
    values(gen_random_uuid(),new_patient,'hid_code',requested_hid,true,'hid-public-qoreid-enrollment');
  insert into identity.patient_identifiers(id,patient_id,identifier_type,value_ciphertext,lookup_hmac,
    encryption_key_version,display_hint,verified,source_system,verified_at,
    verification_provider,verification_reference,public_enrollment_id)
  values(gen_random_uuid(),new_patient,'nin',enrollment.nin_ciphertext,enrollment.nin_lookup_hmac,
    enrollment.key_version,enrollment.nin_last4,true,'hid-public-qoreid-enrollment',enrollment.created_at,
    'qoreid',enrollment.provider_reference,enrollment.id);
  insert into identity.patient_authoritative_profiles(patient_id,enrollment_id,profile_ciphertext,
    profile_sha256,key_version,provider,provider_reference,verified_at)
  values(new_patient,enrollment.id,enrollment.profile_ciphertext,enrollment.profile_sha256,
    enrollment.key_version,'qoreid',enrollment.provider_reference,enrollment.created_at);
  insert into identity.patient_assurance_states(patient_id,account_id,state,source_system,
    source_reference,verified_provider,contact_verified_at,nin_verified_at)
  values(new_patient,new_account,'NIN_VERIFIED','hid-public-qoreid-enrollment',
    enrollment.id::text,'qoreid',enrollment.contact_verified_at,enrollment.created_at);
  update identity.public_patient_enrollments set state = 'active', activated_at = clock_timestamp(),
    updated_at = clock_timestamp(), row_version = row_version + 1 where id = enrollment.id;
  insert into audit.events(correlation_id,actor_type,actor_subject,patient_id,
    action,resource_type,resource_id,outcome,purpose_of_use,provenance,source_system,details)
  values(platform.current_correlation_id(),'system',null,new_patient,
    'identity.public-patient-enrollment.activated','patient',new_patient::text,
    'success','patient-self','application','identity-api',
    jsonb_build_object('provider','qoreid','contactChannel',enrollment.contact_channel,
      'selfReportedFields',self_reported_fields));
  return query select new_patient, requested_hid, new_account, false;
end
$$;

revoke all on function identity.activate_public_patient_enrollment(
  uuid,char(64),text,text,text,text,char(64),date,text) from public;
