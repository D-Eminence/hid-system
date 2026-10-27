-- 0092 Patient sign-up without a NIN (owner decision of 2026-10-27: sign-up
-- works like hid-1.0's; the NIN moves to profile completion, optional).
--
-- A person gives first and last name, email, phone, gender, optionally the
-- hospital they use now, accepts the terms, verifies a code sent to the
-- email and sets a password; activation then issues the account, the
-- patient and the HID at once. No NIN, no QoreID lookup and no
-- authoritative profile are involved. The signed-in patient may bind a NIN
-- later through 0058's progressive binding (POST /identity/me/verification/nin).
--
-- Additive only. 0051/0058's NIN enrollment, its activation command
-- (identity.activate_public_patient_enrollment, untouched) and its rows keep
-- working as they are:
--
-- 1. identity.public_patient_enrollments: the four NIN columns may be null,
--    all together or none (a sign-up row has none); a sign-up row holds the
--    declared email's contact lookup HMAC and the declared phone (ciphertext
--    and lookup HMAC); its verified contact can only be that email. The
--    declared profile is the row's existing encrypted profile.
-- 2. identity.start_public_patient_signup: refuses an email already used by a
--    non-deleted account or a patient, and a phone already used by a patient,
--    then inserts the pending sign-up row.
-- 3. identity.activate_public_patient_signup: the sign-up row's activation
--    (account with the verified email, patient from the declared profile with
--    no date of birth, HID identifier, assurance CONTACT_VERIFIED). The NIN
--    activation refuses a sign-up row (its profile has no NIN).
-- 4. identity.patient_self_nin_eligibility: also lets a patient activated by
--    sign-up, with no NIN and no authoritative profile, bind a verified NIN
--    (answers 'legacy_unbound', which 0058's binding already accepts).
-- 5. identity.record_my_verified_nin_date_of_birth: in the binding's
--    transaction, records the date of birth QoreID matched on a patient that
--    had none (a sign-up patient), never changing one already recorded.
-- 6. identity.patient_self_profile gains ninVerified (a verified, unrevoked
--    NIN identifier exists); every other key is unchanged.
--
-- Locks: ACCESS EXCLUSIVE on identity.public_patient_enrollments only, taken
-- NOWAIT every 10 ms for at most 5 seconds (then 55P03, nothing applied),
-- held to commit; the CHECKs scan that small table. No other table is
-- altered. Grants: the new functions to hid_identity_runtime and
-- hid_schema_test_runtime, here and in runtime-grants.sql.

do $$
declare attempt integer := 0;
begin
  if to_regclass('identity.public_patient_enrollments') is null
    or to_regprocedure('identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char)') is null
    or to_regprocedure('identity.patient_self_nin_eligibility(text,uuid,char)') is null
    or to_regprocedure('identity.patient_self_profile(text,uuid)') is null
    or to_regprocedure('identity.patient_contact_lookup_ready()') is null then
    raise exception using errcode = '55000', message = '0092: 0051, 0057, 0058 and 0060 must be applied first';
  end if;
  if to_regprocedure('identity.start_public_patient_signup(uuid,char,char,text,char,char,bytea,bytea,char,text)') is not null
    or to_regprocedure('identity.activate_public_patient_signup(uuid,char,text,text,text,text,char)') is not null
    or to_regprocedure('identity.record_my_verified_nin_date_of_birth(text,uuid,uuid,date)') is not null then
    raise exception using errcode = '55000', message = '0092: already applied';
  end if;
  loop
    attempt := attempt + 1;
    begin
      lock table identity.public_patient_enrollments in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0092: identity.public_patient_enrollments stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 1. A pending enrollment without a NIN.
alter table identity.public_patient_enrollments
  alter column nin_lookup_hmac drop not null,
  alter column nin_last4 drop not null,
  alter column nin_ciphertext drop not null,
  alter column provider_reference drop not null,
  add column signup_email_lookup_hmac char(64)
    check (signup_email_lookup_hmac is null or signup_email_lookup_hmac ~ '^[0-9a-f]{64}$'),
  add column signup_phone_lookup_hmac char(64)
    check (signup_phone_lookup_hmac is null or signup_phone_lookup_hmac ~ '^[0-9a-f]{64}$'),
  add column signup_phone_ciphertext bytea
    check (signup_phone_ciphertext is null or octet_length(signup_phone_ciphertext) >= 30),
  add constraint public_patient_enrollments_nin_all_or_none_ck check (
    num_nonnulls(nin_lookup_hmac, nin_last4, nin_ciphertext, provider_reference) in (0, 4)),
  add constraint public_patient_enrollments_signup_ck check (
    num_nonnulls(signup_email_lookup_hmac, signup_phone_lookup_hmac, signup_phone_ciphertext) in (0, 3)
    and (nin_lookup_hmac is null) = (signup_email_lookup_hmac is not null)),
  add constraint public_patient_enrollments_signup_contact_ck check (
    signup_email_lookup_hmac is null or contact_channel is null
    or (contact_channel = 'email' and contact_lookup_hmac = signup_email_lookup_hmac));

comment on column identity.public_patient_enrollments.signup_email_lookup_hmac is
  'Sign-up without NIN (0092): the declared email''s contact lookup HMAC; the only contact such a row can verify.';
comment on column identity.public_patient_enrollments.signup_phone_ciphertext is
  'Sign-up without NIN (0092): the declared, unverified phone (E.164), encrypted like the contact; becomes the patient''s phone.';

-- 2. Start a sign-up.
create function identity.start_public_patient_signup(
  requested_enrollment_id uuid, requested_request_hmac char(64), requested_token_hmac char(64),
  requested_email text, requested_email_lookup_hmac char(64), requested_phone_lookup_hmac char(64),
  requested_phone_ciphertext bytea, requested_profile_ciphertext bytea,
  requested_profile_sha256 char(64), requested_key_version text
) returns text language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare normalized_email text := lower(btrim(requested_email));
begin
  if platform.current_actor_subject() <> 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if not identity.patient_contact_lookup_ready() then
    raise exception using errcode = '55000', message = 'PATIENT_ENROLLMENT_RECONCILIATION_REQUIRED';
  end if;
  if requested_enrollment_id is null
    or normalized_email is null or length(normalized_email) > 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or coalesce(requested_email_lookup_hmac, '') !~ '^[0-9a-f]{64}$'
    or coalesce(requested_phone_lookup_hmac, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'PATIENT_CONTACT_INVALID';
  end if;
  if exists (select 1 from auth.accounts account
      where lower(account.email) = normalized_email and account.status <> 'deleted')
    or identity.public_patient_contact_already_bound('email', requested_email_lookup_hmac) then
    return 'email_registered';
  end if;
  if identity.public_patient_contact_already_bound('phone', requested_phone_lookup_hmac) then
    return 'phone_registered';
  end if;
  insert into identity.public_patient_enrollments
    (id, profile_ciphertext, profile_sha256, key_version, request_hmac, token_hmac,
     signup_email_lookup_hmac, signup_phone_lookup_hmac, signup_phone_ciphertext)
  values (requested_enrollment_id, requested_profile_ciphertext, requested_profile_sha256,
    requested_key_version, requested_request_hmac, requested_token_hmac,
    requested_email_lookup_hmac, requested_phone_lookup_hmac, requested_phone_ciphertext);
  return 'started';
end
$$;

-- 3. Activate a sign-up: the account, the patient from the declared profile
-- and the HID, in one transaction. Mirrors 0058's activation without the NIN.
create function identity.activate_public_patient_signup(
  requested_enrollment_id uuid, requested_token_hmac char(64), requested_profile_json text,
  requested_contact text, requested_hid text, requested_password_hash text,
  requested_contact_lookup_hmac char(64)
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
  first_name text;
  last_name text;
begin
  if platform.current_actor_subject() <> 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if not identity.patient_contact_lookup_ready() then
    raise exception using errcode = '55000', message = 'PATIENT_ENROLLMENT_RECONCILIATION_REQUIRED';
  end if;
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.token_hmac <> requested_token_hmac
    or enrollment.nin_lookup_hmac is not null or enrollment.signup_email_lookup_hmac is null then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if enrollment.state = 'active' then
    return query select enrollment.patient_id,
      (select patient.hid_code from identity.patients patient where patient.id = enrollment.patient_id),
      enrollment.account_id, true;
    return;
  end if;
  if enrollment.state <> 'set_password' or enrollment.expires_at <= clock_timestamp()
    or enrollment.contact_verified_at is null or enrollment.verified_challenge_id is null
    or enrollment.contact_channel is distinct from 'email'
    or enrollment.contact_lookup_hmac is null
    or enrollment.contact_lookup_hmac <> enrollment.signup_email_lookup_hmac
    or requested_contact_lookup_hmac is null
    or enrollment.contact_lookup_hmac <> requested_contact_lookup_hmac
    or requested_hid !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'
    or requested_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$'
    or length(requested_password_hash) not between 64 and 512
    or requested_profile_json is null or length(requested_profile_json) > 65536
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
  normalized_email := lower(btrim(requested_contact));
  first_name := btrim(profile->>'firstName');
  last_name := btrim(profile->>'lastName');
  if jsonb_typeof(profile) <> 'object' or profile->>'kind' is distinct from 'signup'
    or profile ? 'nin'
    or coalesce(first_name, '') !~ '^[^[:cntrl:]]{1,80}$'
    or coalesce(last_name, '') !~ '^[^[:cntrl:]]{1,80}$'
    or coalesce(profile->>'gender', '') not in ('female','male','intersex','other','unknown')
    or coalesce(profile->>'phone', '') !~ '^\+234[0-9]{10}$'
    or (profile ? 'hospitalCurrentlyUsing'
      and coalesce(profile->>'hospitalCurrentlyUsing', '') !~ '^[^[:cntrl:]]{1,120}$')
    or profile->>'email' is distinct from normalized_email
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(normalized_email) > 254 then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-contact:email:' || enrollment.contact_lookup_hmac, 0));
  perform pg_advisory_xact_lock(hashtextextended('patient-contact:phone:' || enrollment.signup_phone_lookup_hmac, 0));
  if exists (select 1 from auth.accounts account
      where lower(account.email) = normalized_email and account.status <> 'deleted')
    or identity.public_patient_contact_already_bound('email', enrollment.contact_lookup_hmac) then
    raise exception using errcode = '23505', message = 'PATIENT_EMAIL_ALREADY_BOUND';
  end if;
  if identity.public_patient_contact_already_bound('phone', enrollment.signup_phone_lookup_hmac) then
    raise exception using errcode = '23505', message = 'PATIENT_PHONE_ALREADY_BOUND';
  end if;
  new_account := gen_random_uuid();
  new_patient := gen_random_uuid();
  -- Set IDs before inserting the canonical patient so RLS can prove the exact
  -- pending enrollment tuple. All writes commit or roll back together.
  update identity.public_patient_enrollments set account_id = new_account,
    patient_id = new_patient, updated_at = clock_timestamp(), row_version = row_version + 1
    where id = enrollment.id;
  insert into auth.accounts(id,subject,email,display_name,status,password_hash,
    password_algorithm,password_changed_at,email_verified_at,source_system)
  values(new_account,'patient:' || new_account::text,normalized_email,
    first_name || ' ' || last_name,'active',requested_password_hash,'argon2id',clock_timestamp(),
    enrollment.contact_verified_at,'hid-public-qoreid-enrollment');
  insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,
    gender,dob,phone_e164_ciphertext,phone_lookup_hmac,email_ciphertext,email_lookup_hmac,
    contact_key_version,source_system,status)
  values(new_patient,new_account,requested_hid,first_name,last_name,first_name || ' ' || last_name,
    profile->>'gender',null,enrollment.signup_phone_ciphertext,enrollment.signup_phone_lookup_hmac,
    enrollment.contact_ciphertext,enrollment.contact_lookup_hmac,
    enrollment.key_version,'hid-public-qoreid-enrollment','active');
  insert into identity.patient_identifiers(id,patient_id,identifier_type,public_value,verified,source_system)
    values(gen_random_uuid(),new_patient,'hid_code',requested_hid,true,'hid-public-qoreid-enrollment');
  insert into identity.patient_assurance_states(patient_id,account_id,state,source_system,
    source_reference,contact_verified_at)
  values(new_patient,new_account,'CONTACT_VERIFIED','hid-public-signup',
    enrollment.id::text,enrollment.contact_verified_at);
  update identity.public_patient_enrollments set state = 'active', activated_at = clock_timestamp(),
    updated_at = clock_timestamp(), row_version = row_version + 1 where id = enrollment.id;
  insert into audit.events(correlation_id,actor_type,actor_subject,patient_id,
    action,resource_type,resource_id,outcome,purpose_of_use,provenance,source_system,details)
  values(platform.current_correlation_id(),'system',null,new_patient,
    'identity.public-patient-enrollment.activated','patient',new_patient::text,
    'success','patient-self','application','identity-api',
    jsonb_build_object('provider','none','enrollment','signup','contactChannel','email'));
  return query select new_patient, requested_hid, new_account, false;
end
$$;

-- 4. A sign-up patient may bind a NIN later. 0058's body plus one branch.
create or replace function identity.patient_self_nin_eligibility(
  requested_subject text, requested_session uuid, requested_lookup_hmac char(64)
) returns text language plpgsql stable security definer
set search_path = pg_catalog, identity, migration, platform, pg_temp
as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  assurance_state text;
  assurance_source text;
  existing_patient uuid;
  crosswalk_patient uuid;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$' then return 'denied'; end if;
  if not identity.legacy_nin_crosswalk_ready() then return 'denied'; end if;
  select patient.account_id, assurance.state, assurance.source_system
    into account_id_value, assurance_state, assurance_source
    from identity.patients patient
    join identity.patient_assurance_states assurance
      on assurance.patient_id = patient.id and assurance.account_id = patient.account_id
    where patient.id = patient_id_value and patient.status = 'active';
  if account_id_value is null or assurance_state = 'MANUAL_REVIEW' then return 'denied'; end if;
  select identifier.patient_id into existing_patient
    from identity.patient_identifiers identifier
    where identifier.identifier_type = 'nin' and identifier.lookup_hmac = requested_lookup_hmac;
  if existing_patient is not null and existing_patient <> patient_id_value then return 'denied'; end if;
  select crosswalk.patient_id into crosswalk_patient
    from migration.legacy_nin_crosswalk crosswalk
    where crosswalk.nin_lookup_hmac = requested_lookup_hmac and crosswalk.status = 'active';
  if crosswalk_patient is not null and crosswalk_patient <> patient_id_value then return 'denied'; end if;
  -- An exact source disposition belongs to this preserved patient identity.
  -- QoreID may verify that exact NIN later, but a different submitted NIN must
  -- go to governed review rather than replace the attested source association.
  if exists (select 1 from migration.legacy_nin_crosswalk crosswalk
    where crosswalk.patient_id = patient_id_value and crosswalk.status = 'active'
      and crosswalk.nin_state = 'attested_exact'
      and crosswalk.nin_lookup_hmac is distinct from requested_lookup_hmac) then
    return 'denied';
  end if;
  if existing_patient = patient_id_value then
    if exists (select 1 from identity.patient_identifiers identifier
      where identifier.identifier_type = 'nin' and identifier.lookup_hmac = requested_lookup_hmac
        and identifier.patient_id = patient_id_value and identifier.verified
        and identifier.revoked_at is null) then return 'bound_exact'; end if;
    return 'denied';
  end if;
  if assurance_state = 'LEGACY_MIGRATED'
    and exists (select 1 from migration.legacy_identity_mappings mapping
      where mapping.canonical_patient_id = patient_id_value
        and mapping.canonical_account_id = account_id_value
        and mapping.migration_status in ('promoted', 'reconciled'))
    and not exists (select 1 from identity.patient_identifiers identifier
      where identifier.patient_id = patient_id_value and identifier.identifier_type = 'nin')
    and not exists (select 1 from identity.patient_authoritative_profiles profile
      where profile.patient_id = patient_id_value)
  then return 'legacy_unbound'; end if;
  -- 0092: a patient activated by sign-up without a NIN (assurance written by
  -- identity.activate_public_patient_signup) binds like a legacy patient.
  if assurance_state = 'CONTACT_VERIFIED' and assurance_source = 'hid-public-signup'
    and not exists (select 1 from identity.patient_identifiers identifier
      where identifier.patient_id = patient_id_value and identifier.identifier_type = 'nin')
    and not exists (select 1 from identity.patient_authoritative_profiles profile
      where profile.patient_id = patient_id_value)
  then return 'legacy_unbound'; end if;
  return 'denied';
end;
$$;

-- 5. The date of birth QoreID matched, for a patient that had none. Only in
-- the transaction that wrote the patient's verified NIN evidence (0058's
-- binding, same correlation id), which QoreID matched on this date.
create function identity.record_my_verified_nin_date_of_birth(
  requested_subject text, requested_session uuid, requested_evidence_id uuid,
  requested_date_of_birth date
) returns boolean language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
declare patient_id_value uuid;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_date_of_birth is null or requested_date_of_birth < date '1900-01-01'
    or requested_date_of_birth > current_date
    or not exists (select 1 from identity.verification_evidence evidence
      where evidence.id = requested_evidence_id and evidence.patient_id = patient_id_value
        and evidence.subject_type = 'patient' and evidence.verification_type = 'nin'
        and evidence.result = 'verified' and evidence.provider = 'qoreid'
        and evidence.correlation_id = platform.current_correlation_id()) then
    raise exception using errcode = '23514', message = 'Patient NIN evidence is invalid';
  end if;
  update identity.patients set dob = requested_date_of_birth,
    updated_at = clock_timestamp(), row_version = row_version + 1
    where id = patient_id_value and dob is null;
  return found;
end;
$$;

-- 6. The patient's own profile says whether a verified NIN is bound.
create or replace function identity.patient_self_profile(requested_subject text, requested_session uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('patientId',p.id,'hid',p.hid_code,
    'firstName',p.first_name,'lastName',p.last_name,'fullName',p.full_name,
    'dateOfBirth',p.dob,'gender',p.gender,'country',p.country,'state',p.state,
    'version',p.row_version,
    'assuranceState',(
      select assurance.state from identity.patient_assurance_states assurance
      where assurance.patient_id=p.id
    ),
    'accessPinConfigured',exists (
      select 1 from identity.patient_access_pins pin
      where pin.patient_id=p.id and pin.status='active'
    ),
    'ninVerified',exists (
      select 1 from identity.patient_identifiers identifier
      where identifier.patient_id=p.id and identifier.identifier_type='nin'
        and identifier.verified and identifier.revoked_at is null
    ))
  from identity.patients p
  where p.id = identity.patient_self_session(requested_subject,requested_session)
$$;

revoke all on function identity.start_public_patient_signup(uuid,char,char,text,char,char,bytea,bytea,char,text),
  identity.activate_public_patient_signup(uuid,char,text,text,text,text,char),
  identity.record_my_verified_nin_date_of_birth(text,uuid,uuid,date) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.start_public_patient_signup(uuid,char,char,text,char,char,bytea,bytea,char,text),
      identity.activate_public_patient_signup(uuid,char,text,text,text,text,char),
      identity.record_my_verified_nin_date_of_birth(text,uuid,uuid,date)
      to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function identity.start_public_patient_signup(uuid,char,char,text,char,char,bytea,bytea,char,text),
      identity.activate_public_patient_signup(uuid,char,text,text,text,text,char),
      identity.record_my_verified_nin_date_of_birth(text,uuid,uuid,date)
      to hid_schema_test_runtime;
  end if;
end
$$;
