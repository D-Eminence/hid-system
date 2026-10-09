-- Public NIN enrollment is an Identity-owned pending identity. Neither an
-- account nor a HID code exists until the selected HID contact is verified
-- and a password is supplied to the atomic activation command.
create table identity.public_patient_enrollments (
  id uuid primary key,
  nin_lookup_hmac char(64) not null unique check (nin_lookup_hmac ~ '^[0-9a-f]{64}$'),
  nin_last4 char(4) not null check (nin_last4 ~ '^[0-9]{4}$'),
  nin_ciphertext bytea not null check (octet_length(nin_ciphertext) >= 30),
  profile_ciphertext bytea not null check (octet_length(profile_ciphertext) >= 30),
  profile_sha256 char(64) not null check (profile_sha256 ~ '^[0-9a-f]{64}$'),
  key_version text not null check (length(key_version) between 1 and 64),
  provider_reference text not null check (provider_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'),
  request_hmac char(64) not null check (request_hmac ~ '^[0-9a-f]{64}$'),
  token_hmac char(64) not null check (token_hmac ~ '^[0-9a-f]{64}$'),
  state text not null default 'verify_contact' check (state in ('verify_contact','set_password','active')),
  contact_channel text check (contact_channel in ('phone','email')),
  contact_hmac char(64) check (contact_hmac is null or contact_hmac ~ '^[0-9a-f]{64}$'),
  contact_ciphertext bytea,
  contact_verified_at timestamptz,
  verified_challenge_id uuid,
  patient_id uuid unique references identity.patients(id) on delete restrict deferrable initially deferred,
  account_id uuid unique references auth.accounts(id) on delete restrict deferrable initially deferred,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  activated_at timestamptz,
  row_version bigint not null default 1 check (row_version > 0),
  check ((contact_channel is null) = (contact_hmac is null)),
  check ((contact_channel is null) = (contact_ciphertext is null)),
  check ((state = 'set_password') = (contact_verified_at is not null and activated_at is null)),
  check ((state = 'active') = (activated_at is not null)),
  check ((patient_id is null) = (account_id is null)),
  check (state <> 'verify_contact' or patient_id is null),
  check (state <> 'active' or patient_id is not null),
  check (state <> 'active' or contact_verified_at is not null)
);

create table identity.public_patient_enrollment_otps (
  id uuid primary key,
  enrollment_id uuid not null references identity.public_patient_enrollments(id) on delete restrict,
  recipient_hmac char(64) not null check (recipient_hmac ~ '^[0-9a-f]{64}$'),
  channel text not null check (channel in ('phone','email')),
  verifier_hmac char(64) not null check (verifier_hmac ~ '^[0-9a-f]{64}$'),
  verifier_key_version text not null check (length(verifier_key_version) between 1 and 64),
  expires_at timestamptz not null,
  failed_attempts smallint not null default 0,
  max_attempts smallint not null check (max_attempts between 1 and 10),
  delivery_outcome text not null default 'pending' check (delivery_outcome in ('pending','accepted','definitive_failure','unknown')),
  delivery_provider text check (delivery_provider is null or delivery_provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  request_ip_hmac char(64) check (request_ip_hmac is null or request_ip_hmac ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  verified_at timestamptz,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text check (invalidation_reason in ('resend','expired','attempts_exhausted','delivery_failed')),
  check (failed_attempts between 0 and max_attempts),
  check ((invalidated_at is null) = (invalidation_reason is null)),
  check (not (consumed_at is not null and invalidated_at is not null)),
  check (consumed_at is null or verified_at is not null)
);
create unique index public_patient_enrollment_request_uq
  on identity.public_patient_enrollments(request_hmac);
create unique index public_patient_otp_active_enrollment_uq
  on identity.public_patient_enrollment_otps(enrollment_id)
  where consumed_at is null and invalidated_at is null;
create index public_patient_otp_expiry_idx on identity.public_patient_enrollment_otps(expires_at)
  where consumed_at is null and invalidated_at is null;

create table identity.public_patient_enrollment_rates (
  scope text not null check (scope in ('ip','recipient','enrollment')),
  bucket_hmac char(64) not null check (bucket_hmac ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key(scope,bucket_hmac)
);

create table identity.patient_authoritative_profiles (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  enrollment_id uuid not null unique references identity.public_patient_enrollments(id) on delete restrict,
  profile_ciphertext bytea not null check (octet_length(profile_ciphertext) >= 30),
  profile_sha256 char(64) not null check (profile_sha256 ~ '^[0-9a-f]{64}$'),
  key_version text not null check (length(key_version) between 1 and 64),
  provider text not null check (provider = 'qoreid'),
  provider_reference text not null,
  verified_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create trigger patient_authoritative_profiles_immutable before update or delete
  on identity.patient_authoritative_profiles for each row execute function platform.reject_mutation();

-- The existing governed NIN path still requires a registration case. Public
-- enrollment uses a mutually exclusive, verified enrollment reference.
alter table identity.patient_identifiers
  drop constraint patient_identifiers_nin_verification_ck,
  drop constraint patient_identifiers_registration_case_ck,
  add column public_enrollment_id uuid references identity.public_patient_enrollments(id) on delete restrict,
  add constraint patient_identifiers_nin_verification_ck check (
    identifier_type <> 'nin' or
    (verified and verified_at is not null and verification_provider is not null
      and length(verification_provider) between 1 and 100
      and verification_reference is not null and length(verification_reference) between 1 and 255
      and num_nonnulls(registration_case_id, public_enrollment_id) = 1)
  ),
  add constraint patient_identifiers_registration_case_ck check (
    (identifier_type = 'nin' and num_nonnulls(registration_case_id, public_enrollment_id) = 1)
    or (identifier_type <> 'nin' and registration_case_id is null and public_enrollment_id is null)
  );

alter table identity.public_patient_enrollments enable row level security;
alter table identity.public_patient_enrollments force row level security;
alter table identity.public_patient_enrollment_otps enable row level security;
alter table identity.public_patient_enrollment_otps force row level security;
alter table identity.public_patient_enrollment_rates enable row level security;
alter table identity.public_patient_enrollment_rates force row level security;
alter table identity.patient_authoritative_profiles enable row level security;
alter table identity.patient_authoritative_profiles force row level security;

create policy public_patient_enrollment_system on identity.public_patient_enrollments for all
  using (platform.current_actor_subject() = 'system:auth')
  with check (platform.current_actor_subject() = 'system:auth');
create policy public_patient_otp_system on identity.public_patient_enrollment_otps for all
  using (platform.current_actor_subject() = 'system:auth')
  with check (platform.current_actor_subject() = 'system:auth');
create policy public_patient_rate_system on identity.public_patient_enrollment_rates for all
  using (platform.current_actor_subject() = 'system:auth')
  with check (platform.current_actor_subject() = 'system:auth');
create policy patient_authoritative_profile_system on identity.patient_authoritative_profiles for select
  using (platform.current_actor_subject() = 'system:auth');
create policy patient_authoritative_profile_system_insert on identity.patient_authoritative_profiles for insert
  with check (platform.current_actor_subject() = 'system:auth');

create policy patients_public_enrollment_insert on identity.patients for insert with check (
  platform.current_actor_subject() = 'system:auth'
  and source_system = 'hid-public-qoreid-enrollment'
  and account_id is not null and status = 'active'
  and exists (select 1 from identity.public_patient_enrollments enrollment
    where enrollment.patient_id = patients.id and enrollment.account_id = patients.account_id
      and enrollment.state = 'set_password' and enrollment.contact_verified_at is not null)
);
create policy patients_public_enrollment_system_read on identity.patients for select using (
  platform.current_actor_subject() = 'system:auth'
  and source_system = 'hid-public-qoreid-enrollment'
);
create policy patient_identifiers_public_enrollment_insert on identity.patient_identifiers for insert with check (
  platform.current_actor_subject() = 'system:auth'
  and exists (select 1 from identity.public_patient_enrollments enrollment
    where enrollment.patient_id = patient_identifiers.patient_id
      and enrollment.state = 'set_password' and enrollment.contact_verified_at is not null
      and ((patient_identifiers.identifier_type = 'nin'
        and patient_identifiers.public_enrollment_id = enrollment.id
        and patient_identifiers.lookup_hmac = enrollment.nin_lookup_hmac)
        or (patient_identifiers.identifier_type = 'hid_code'
          and patient_identifiers.public_enrollment_id is null
          and patient_identifiers.public_value = (
            select patient.hid_code from identity.patients patient
            where patient.id = enrollment.patient_id))))
);

create function identity.public_patient_nin_already_bound(requested_lookup_hmac char(64))
returns boolean language plpgsql security definer
set search_path = pg_catalog, identity, platform, public, pg_temp
as $$
begin
  if platform.current_actor_subject() <> 'system:auth'
    or requested_lookup_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='42501', message='PATIENT_ENROLLMENT_DENIED';
  end if;
  return exists(select 1 from identity.patient_identifiers identifier
    where identifier.identifier_type='nin'
      and identifier.lookup_hmac=requested_lookup_hmac);
end
$$;
revoke all on function identity.public_patient_nin_already_bound(char) from public;

create function identity.prune_expired_public_patient_enrollments()
returns integer language plpgsql security definer
set search_path = pg_catalog, identity, platform, public, pg_temp
as $$
declare removed integer;
begin
  if platform.current_actor_subject() <> 'system:auth' then
    raise exception using errcode='42501', message='PATIENT_ENROLLMENT_DENIED';
  end if;
  delete from identity.public_patient_enrollment_otps challenge
    using identity.public_patient_enrollments enrollment
    where challenge.enrollment_id=enrollment.id and enrollment.state <> 'active'
      and enrollment.expires_at <= clock_timestamp();
  delete from identity.public_patient_enrollments
    where state <> 'active' and expires_at <= clock_timestamp();
  get diagnostics removed = row_count;
  delete from identity.public_patient_enrollment_rates
    where window_started_at < clock_timestamp() - interval '48 hours';
  return removed;
end
$$;
revoke all on function identity.prune_expired_public_patient_enrollments() from public;

create function identity.activate_public_patient_enrollment(
  requested_enrollment_id uuid, requested_token_hmac char(64), requested_profile_json text,
  requested_contact text, requested_hid text, requested_password_hash text
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
  if exists (select 1 from identity.patient_identifiers identifier
    where identifier.identifier_type = 'nin' and identifier.lookup_hmac = enrollment.nin_lookup_hmac) then
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
    case when enrollment.contact_channel = 'phone' then enrollment.contact_hmac else null end,
    case when enrollment.contact_channel = 'email' then enrollment.contact_ciphertext else null end,
    case when enrollment.contact_channel = 'email' then enrollment.contact_hmac else null end,
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

revoke all on identity.public_patient_enrollments, identity.public_patient_enrollment_otps,
  identity.public_patient_enrollment_rates, identity.patient_authoritative_profiles from public;
revoke all on function identity.activate_public_patient_enrollment(uuid,char,text,text,text,text) from public;
comment on table identity.public_patient_enrollments is
  'Encrypted, unique-NIN pending public identity. Contains no active HID before contact OTP and password activation.';
