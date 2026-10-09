-- A QoreID verification made by an existing patient is an independent,
-- session-bound provenance path. It never changes the patient, account, HID,
-- clinical records, or legacy migration mapping.
alter table identity.patient_identifiers
  drop constraint patient_identifiers_nin_verification_ck,
  drop constraint patient_identifiers_registration_case_ck,
  add column patient_self_evidence_id uuid unique
    references identity.verification_evidence(id) on delete restrict,
  add constraint patient_identifiers_nin_verification_ck check (
    identifier_type <> 'nin' or
    (verified and verified_at is not null and verification_provider is not null
      and length(verification_provider) between 1 and 100
      and verification_reference is not null and length(verification_reference) between 1 and 255
      and num_nonnulls(registration_case_id, public_enrollment_id, patient_self_evidence_id) = 1)
  ),
  add constraint patient_identifiers_registration_case_ck check (
    (identifier_type = 'nin'
      and num_nonnulls(registration_case_id, public_enrollment_id, patient_self_evidence_id) = 1)
    or (identifier_type <> 'nin'
      and registration_case_id is null and public_enrollment_id is null
      and patient_self_evidence_id is null)
  );

alter table identity.patient_authoritative_profiles
  alter column enrollment_id drop not null,
  add column patient_self_evidence_id uuid unique
    references identity.verification_evidence(id) on delete restrict,
  add constraint patient_authoritative_profile_source_ck
    check (num_nonnulls(enrollment_id, patient_self_evidence_id) = 1);

create policy patient_identifiers_self_nin_insert on identity.patient_identifiers
  for insert with check (
    identifier_type = 'nin' and verified and patient_self_evidence_id is not null
    and registration_case_id is null and public_enrollment_id is null
    and source_system = 'hid-patient-self-qoreid-verification'
    and verification_provider = 'qoreid'
    and exists (
      select 1 from identity.verification_evidence evidence
      where evidence.id = patient_identifiers.patient_self_evidence_id
        and evidence.patient_id = patient_identifiers.patient_id
        and evidence.subject_type = 'patient'
        and evidence.verification_type = 'nin'
        and evidence.result = 'verified'
        and evidence.provider = 'qoreid'
        and evidence.provider_reference = patient_identifiers.verification_reference
        and evidence.verified_at = patient_identifiers.verified_at
    )
  );

create policy patient_authoritative_profile_self_insert
  on identity.patient_authoritative_profiles for insert with check (
    enrollment_id is null and patient_self_evidence_id is not null
    and exists (
      select 1 from identity.verification_evidence evidence
      where evidence.id = patient_authoritative_profiles.patient_self_evidence_id
        and evidence.patient_id = patient_authoritative_profiles.patient_id
        and evidence.subject_type = 'patient'
        and evidence.verification_type = 'nin'
        and evidence.result = 'verified'
        and evidence.provider = 'qoreid'
        and evidence.provider_reference = patient_authoritative_profiles.provider_reference
        and evidence.verified_at = patient_authoritative_profiles.verified_at
    )
  );

-- This table forces RLS. The session-bound command needs to see whether a
-- prior provider profile exists before it can safely create another one.
create policy patient_authoritative_profile_self_read
  on identity.patient_authoritative_profiles for select using (
    exists (select 1 from identity.patients patient
      join auth.accounts account on account.id = patient.account_id
      where patient.id = patient_authoritative_profiles.patient_id
        and account.subject = platform.current_actor_subject())
  );

create function identity.patient_self_nin_eligibility(
  requested_subject text, requested_session uuid, requested_lookup_hmac char(64)
) returns text language plpgsql stable security definer
set search_path = pg_catalog, identity, migration, platform, pg_temp
as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  assurance_state text;
  existing_patient uuid;
  crosswalk_patient uuid;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$' then return 'denied'; end if;
  if not identity.legacy_nin_crosswalk_ready() then return 'denied'; end if;
  select patient.account_id, assurance.state into account_id_value, assurance_state
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
  return 'denied';
end;
$$;
revoke all on function identity.patient_self_nin_eligibility(text,uuid,char(64)) from public;

create function identity.bind_my_verified_nin(
  requested_subject text, requested_session uuid, requested_evidence_id uuid,
  requested_lookup_hmac char(64), requested_nin_ciphertext bytea,
  requested_key_version text, requested_last4 char(4),
  requested_provider_reference text, requested_profile_ciphertext bytea,
  requested_profile_sha256 char(64)
) returns table (evidence_id uuid, recorded_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, migration, platform, pg_temp
as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  state_value text;
  eligibility text;
  recorded_at_value timestamptz;
  verified_at_value timestamptz;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_evidence_id is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$'
    or requested_last4 !~ '^[0-9]{4}$'
    or requested_nin_ciphertext is null or octet_length(requested_nin_ciphertext) < 30
    or requested_profile_ciphertext is null or octet_length(requested_profile_ciphertext) < 30
    or requested_profile_sha256 !~ '^[0-9a-f]{64}$'
    or encode(public.digest(requested_profile_ciphertext, 'sha256'), 'hex')
      <> requested_profile_sha256
    or requested_key_version is null or length(requested_key_version) not between 1 and 64
    or requested_provider_reference is null
    or requested_provider_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' then
    raise exception using errcode = '23514', message = 'Patient NIN evidence is invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-nin:' || requested_lookup_hmac, 0));
  select patient.account_id into account_id_value from identity.patients patient
    where patient.id = patient_id_value and patient.status = 'active' for update;
  select assurance.state into state_value from identity.patient_assurance_states assurance
    where assurance.patient_id = patient_id_value and assurance.account_id = account_id_value for update;
  eligibility := identity.patient_self_nin_eligibility(
    requested_subject, requested_session, requested_lookup_hmac);
  if eligibility not in ('bound_exact', 'legacy_unbound') or state_value is null then
    raise exception using errcode = '23505', message = 'PATIENT_NIN_BINDING_CONFLICT';
  end if;
  verified_at_value := clock_timestamp();
  insert into identity.verification_evidence(
    id,subject_type,patient_id,verification_type,provider,provider_reference,
    result,verified_at,created_at,correlation_id,actor_account_id,source_system
  ) values (
    requested_evidence_id,'patient',patient_id_value,'nin','qoreid',requested_provider_reference,
    'verified',verified_at_value,verified_at_value,
    platform.current_correlation_id(),account_id_value,'identity-api'
  ) returning created_at into recorded_at_value;
  if eligibility = 'legacy_unbound' then
    insert into identity.patient_identifiers(
      id,patient_id,identifier_type,value_ciphertext,lookup_hmac,encryption_key_version,
      display_hint,verified,source_system,verified_at,verification_provider,
      verification_reference,patient_self_evidence_id
    ) values (
      gen_random_uuid(),patient_id_value,'nin',requested_nin_ciphertext,requested_lookup_hmac,
      requested_key_version,requested_last4,true,'hid-patient-self-qoreid-verification',
      recorded_at_value,'qoreid',requested_provider_reference,requested_evidence_id
    );
  end if;
  if not exists (select 1 from identity.patient_authoritative_profiles profile
    where profile.patient_id = patient_id_value) then
    insert into identity.patient_authoritative_profiles(
      patient_id,patient_self_evidence_id,profile_ciphertext,profile_sha256,
      key_version,provider,provider_reference,verified_at
    ) values (
      patient_id_value,requested_evidence_id,requested_profile_ciphertext,requested_profile_sha256,
      requested_key_version,'qoreid',requested_provider_reference,recorded_at_value
    );
  end if;
  if state_value <> 'NIN_VERIFIED' then
    update identity.patient_assurance_states assurance set state = 'NIN_VERIFIED',
      verified_provider = 'qoreid', nin_verified_at = recorded_at_value,
      updated_at = clock_timestamp(), row_version = row_version + 1
      where assurance.patient_id = patient_id_value and assurance.account_id = account_id_value;
  end if;
  insert into audit.events(
    correlation_id,actor_type,actor_subject,actor_account_id,patient_id,action,
    resource_type,resource_id,outcome,purpose_of_use,provenance,source_system,details
  ) values (
    platform.current_correlation_id(),'patient',requested_subject,account_id_value,patient_id_value,
    'identity.patient.nin-verification','verification-evidence',requested_evidence_id::text,
    'success','patient-self','application','identity-api',
    jsonb_build_object('provider','qoreid','verificationType','nin',
      'result','verified','providerReference',requested_provider_reference,
      'assuranceTransition',state_value <> 'NIN_VERIFIED')
  );
  return query select requested_evidence_id, recorded_at_value;
end;
$$;
revoke all on function identity.bind_my_verified_nin(
  text,uuid,uuid,char(64),bytea,text,char(4),text,bytea,char(64)) from public;

comment on function identity.bind_my_verified_nin(
  text,uuid,uuid,char(64),bytea,text,char(4),text,bytea,char(64)) is
  'QoreID-verified patient-self NIN binding against the existing session patient; no account or HID creation.';

create or replace function identity.public_patient_nin_already_bound(requested_lookup_hmac char(64))
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, identity, migration, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() <> 'system:auth'
    or requested_lookup_hmac is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  return exists(select 1 from identity.patient_identifiers identifier
      where identifier.identifier_type = 'nin'
        and identifier.lookup_hmac = requested_lookup_hmac)
    or identity.legacy_nin_crosswalk_patient(requested_lookup_hmac) is not null;
end;
$$;

create function identity.public_patient_enrollment_ready()
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() <> 'system:auth' then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  return identity.legacy_nin_crosswalk_ready()
    and identity.patient_contact_lookup_ready();
end;
$$;

create function identity.public_patient_contact_already_bound(
  requested_channel text, requested_lookup_hmac char(64)
) returns boolean language plpgsql stable security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() <> 'system:auth'
    or requested_channel not in ('phone', 'email')
    or requested_lookup_hmac is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  return exists(select 1 from identity.patients patient
    where (requested_channel = 'phone' and patient.phone_lookup_hmac = requested_lookup_hmac)
      or (requested_channel = 'email' and patient.email_lookup_hmac = requested_lookup_hmac));
end;
$$;

revoke all on function identity.public_patient_enrollment_ready(),
  identity.public_patient_contact_already_bound(text,char(64)) from public;

-- Remove the old six-argument entry point so callers cannot bypass the
-- canonical contact and reconciliation checks.
drop function identity.activate_public_patient_enrollment(uuid,char(64),text,text,text,text);

create function identity.activate_public_patient_enrollment(
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
    return query select enrollment.patient_id,
      (select patient.hid_code from identity.patients patient where patient.id = enrollment.patient_id),
      enrollment.account_id, true;
    return;
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
    or coalesce(profile->>'dateOfBirth','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or coalesce(profile->>'gender','') not in ('female','male','intersex','other','unknown')
    or (profile->>'dateOfBirth')::date < date '1900-01-01'
    or (profile->>'dateOfBirth')::date > current_date
    or coalesce(profile->>'providerReference','') <> enrollment.provider_reference then
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
    btrim(profile->>'firstName') || ' ' || btrim(profile->>'lastName'),profile->>'gender',
    (profile->>'dateOfBirth')::date,
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
    jsonb_build_object('provider','qoreid','contactChannel',enrollment.contact_channel));
  return query select new_patient, requested_hid, new_account, false;
end
$$;


revoke all on function identity.activate_public_patient_enrollment(
  uuid,char(64),text,text,text,text,char(64)) from public;
