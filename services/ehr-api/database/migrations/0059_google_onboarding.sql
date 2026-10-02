-- A Google ID token can start accountless onboarding, but cannot create a
-- patient, HID, or ordinary authentication session. The application verifies
-- the token before invoking these narrow commands.
alter table identity.public_patient_enrollments
  add column google_onboarding_required boolean not null default false;

create table auth.google_onboarding_capabilities (
  id uuid primary key,
  token_sha256 char(64) not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  google_subject text not null check (length(google_subject) between 1 and 255),
  state text not null default 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY'
    check (state = 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY'),
  -- Pending enrollment pruning invalidates its Google capability as well.
  bound_enrollment_id uuid unique references identity.public_patient_enrollments(id) on delete cascade,
  linked_account_id uuid references auth.accounts(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text
    check (invalidation_reason is null or length(btrim(invalidation_reason)) between 8 and 100),
  check (expires_at > created_at and expires_at <= created_at + interval '1 hour'),
  check ((consumed_at is null) = (linked_account_id is null)),
  check ((invalidated_at is null) = (invalidation_reason is null)),
  check (consumed_at is null or invalidated_at is null)
);
create index google_onboarding_expiry_idx on auth.google_onboarding_capabilities(expires_at)
  where consumed_at is null;

create function auth.create_google_onboarding_capability(
  requested_id uuid, requested_token_sha256 char(64), requested_subject text
) returns timestamptz language plpgsql security definer
set search_path = pg_catalog, auth, platform, pg_temp as $$
declare deadline timestamptz;
begin
  if platform.current_actor_subject() <> 'system:auth'
    or platform.current_correlation_id() is null
    or requested_subject is null or length(requested_subject) not between 1 and 255
    or requested_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  -- A disabled or revoked mapping is still owned; it cannot be silently
  -- registered to a different account through the onboarding path.
  if exists (select 1 from auth.external_identities
    where issuer = 'https://accounts.google.com' and subject = requested_subject) then
    raise exception using errcode = '23505', message = 'GOOGLE_IDENTITY_ALREADY_LINKED';
  end if;
  delete from auth.google_onboarding_capabilities
    where consumed_at is null and expires_at < clock_timestamp() - interval '1 day';
  deadline := clock_timestamp() + interval '30 minutes';
  insert into auth.google_onboarding_capabilities(id,token_sha256,google_subject,expires_at)
    values(requested_id,requested_token_sha256,requested_subject,deadline);
  return deadline;
end
$$;

create function auth.google_onboarding_capability_status(
  requested_id uuid, requested_token_sha256 char(64)
) returns timestamptz language sql stable security definer
set search_path = pg_catalog, auth, pg_temp as $$
  select capability.expires_at from auth.google_onboarding_capabilities capability
  where capability.id = requested_id and capability.token_sha256 = requested_token_sha256
    and capability.consumed_at is null and capability.invalidated_at is null
    and capability.expires_at > statement_timestamp()
$$;

create function auth.bind_google_onboarding_capability(
  requested_id uuid, requested_token_sha256 char(64),
  requested_enrollment_id uuid, requested_enrollment_token_hmac char(64)
) returns boolean language plpgsql security definer
set search_path = pg_catalog, auth, identity, platform, pg_temp as $$
declare enrollment identity.public_patient_enrollments%rowtype;
declare capability auth.google_onboarding_capabilities%rowtype;
declare prior_capability auth.google_onboarding_capabilities%rowtype;
begin
  if platform.current_actor_subject() <> 'system:auth'
    or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.token_hmac <> requested_enrollment_token_hmac
    or enrollment.state = 'active' or enrollment.expires_at <= clock_timestamp() then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  select * into capability from auth.google_onboarding_capabilities
    where id = requested_id for update;
  if not found or capability.token_sha256 <> requested_token_sha256
    or capability.consumed_at is not null or capability.invalidated_at is not null
    or capability.expires_at <= clock_timestamp()
    or (capability.bound_enrollment_id is not null
      and capability.bound_enrollment_id <> requested_enrollment_id) then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  if exists (select 1 from auth.external_identities
    where issuer = 'https://accounts.google.com' and subject = capability.google_subject) then
    raise exception using errcode = '23505', message = 'GOOGLE_IDENTITY_ALREADY_LINKED';
  end if;
  -- A fresh proof for the same exact Google subject can replace a lost or
  -- expired onboarding cookie without abandoning the verified HID enrollment.
  -- The old bearer is invalidated before its unique enrollment binding moves.
  select * into prior_capability from auth.google_onboarding_capabilities
    where bound_enrollment_id = requested_enrollment_id for update;
  if found and prior_capability.id <> capability.id then
    if prior_capability.consumed_at is not null
      or prior_capability.google_subject <> capability.google_subject then
      raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
    end if;
    update auth.google_onboarding_capabilities
      set bound_enrollment_id = null,
          invalidated_at = clock_timestamp(),
          invalidation_reason = 'replaced_by_fresh_google_proof'
      where id = prior_capability.id;
  end if;
  update identity.public_patient_enrollments
    set google_onboarding_required = true,
        updated_at = clock_timestamp(), row_version = row_version + 1
    where id = requested_enrollment_id;
  update auth.google_onboarding_capabilities set bound_enrollment_id = requested_enrollment_id
    where id = requested_id;
  return true;
end
$$;

create function auth.google_onboarding_enrollment_requirement(
  requested_enrollment_id uuid, requested_enrollment_token_hmac char(64)
) returns table (required boolean, capability_expires_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, auth, identity, platform, pg_temp as $$
begin
  if platform.current_actor_subject() <> 'system:auth'
    or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  select enrollment.google_onboarding_required
    into required
    from identity.public_patient_enrollments enrollment
    where enrollment.id = requested_enrollment_id
      and enrollment.token_hmac = requested_enrollment_token_hmac
      and enrollment.expires_at > statement_timestamp();
  if not found then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  if required then
    select capability.expires_at
      into capability_expires_at
    from auth.google_onboarding_capabilities capability
    where capability.bound_enrollment_id = requested_enrollment_id
      and capability.invalidated_at is null
    limit 1;
  else
    capability_expires_at := null;
  end if;
  return next;
end
$$;

create function auth.consume_google_onboarding_capability(
  requested_id uuid, requested_token_sha256 char(64),
  requested_enrollment_id uuid, requested_account_id uuid
) returns boolean language plpgsql security definer
set search_path = pg_catalog, auth, identity, audit, platform, pg_temp as $$
declare enrollment identity.public_patient_enrollments%rowtype;
declare capability auth.google_onboarding_capabilities%rowtype;
begin
  if platform.current_actor_subject() <> 'system:auth'
    or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.state <> 'active'
    or enrollment.account_id <> requested_account_id then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  if not exists (
    select 1 from identity.patients patient
    join identity.patient_identifiers nin_identifier on nin_identifier.patient_id = patient.id
    join identity.patient_assurance_states assurance on assurance.patient_id = patient.id
    join identity.patient_authoritative_profiles profile on profile.patient_id = patient.id
    where patient.id = enrollment.patient_id and patient.account_id = requested_account_id
      and patient.status = 'active' and patient.source_system = 'hid-public-qoreid-enrollment'
      and nin_identifier.identifier_type = 'nin' and nin_identifier.verified = true
      and nin_identifier.lookup_hmac = enrollment.nin_lookup_hmac
      and nin_identifier.public_enrollment_id = enrollment.id
      and assurance.state = 'NIN_VERIFIED' and profile.enrollment_id = enrollment.id
  ) then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  if not enrollment.google_onboarding_required then return false; end if;
  select * into capability from auth.google_onboarding_capabilities
    where bound_enrollment_id = requested_enrollment_id
      and invalidated_at is null for update;
  if not found then raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED'; end if;
  if capability.consumed_at is not null then
    -- A lost activation response can replay the same completed enrollment
    -- after its Google cookie has been cleared. This cannot link another ID.
    if capability.linked_account_id = requested_account_id
      and ((requested_id is null and requested_token_sha256 is null)
        or (capability.id = requested_id
          and capability.token_sha256 = requested_token_sha256)) then return true; end if;
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  if capability.id is distinct from requested_id
    or capability.token_sha256 is distinct from requested_token_sha256 then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_DENIED';
  end if;
  if capability.expires_at <= clock_timestamp() then
    raise exception using errcode = '42501', message = 'GOOGLE_ONBOARDING_EXPIRED';
  end if;
  insert into auth.external_identities(id,account_id,issuer,subject,status,source_system)
    values(gen_random_uuid(),requested_account_id,'https://accounts.google.com',
      capability.google_subject,'active','hid-google-onboarding');
  update auth.google_onboarding_capabilities
    set consumed_at = clock_timestamp(), linked_account_id = requested_account_id
    where id = requested_id;
  insert into audit.events(correlation_id,actor_type,actor_subject,actor_account_id,patient_id,
    action,resource_type,resource_id,outcome,purpose_of_use,provenance,source_system,details)
  values(platform.current_correlation_id(),'system',null,requested_account_id,enrollment.patient_id,
    'auth.google.onboarding.link','account',requested_account_id::text,
    'success','patient-self','application','identity-api','{}'::jsonb);
  return true;
end
$$;

create function auth.link_google_identity_to_patient_account(
  requested_account_id uuid, requested_google_subject text
) returns boolean language plpgsql security definer
set search_path = pg_catalog, auth, identity, audit, platform, pg_temp as $$
declare patient_id_value uuid;
begin
  if platform.current_actor_subject() <> 'system:auth'
    or platform.current_correlation_id() is null
    or requested_google_subject is null
    or length(requested_google_subject) not between 1 and 255 then
    raise exception using errcode = '42501', message = 'GOOGLE_LINK_DENIED';
  end if;
  select patient.id into patient_id_value from identity.patients patient
    join auth.accounts account on account.id = patient.account_id
    where account.id = requested_account_id and account.status = 'active'
      and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
      and patient.status = 'active'
    for update of account, patient;
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'GOOGLE_LINK_DENIED';
  end if;
  -- Locking the account and patient during the status check serializes
  -- concurrent link operations with account/patient deactivation.
  if exists (select 1 from auth.external_identities identity_row
    where identity_row.account_id = requested_account_id
      and identity_row.issuer = 'https://accounts.google.com'
      and identity_row.subject <> requested_google_subject
      and identity_row.status = 'active') then
    raise exception using errcode = '23505', message = 'GOOGLE_ACCOUNT_ALREADY_LINKED';
  end if;
  if exists (select 1 from auth.external_identities identity_row
    where identity_row.issuer = 'https://accounts.google.com'
      and identity_row.subject = requested_google_subject) then
    raise exception using errcode = '23505', message = 'GOOGLE_IDENTITY_ALREADY_LINKED';
  end if;
  insert into auth.external_identities(id,account_id,issuer,subject,status,source_system)
    values(gen_random_uuid(),requested_account_id,'https://accounts.google.com',
      requested_google_subject,'active','hid-google-explicit-link');
  insert into audit.events(correlation_id,actor_type,actor_subject,actor_account_id,patient_id,
    action,resource_type,resource_id,outcome,purpose_of_use,provenance,source_system,details)
  values(platform.current_correlation_id(),'patient',
    (select subject from auth.accounts where id = requested_account_id),
    requested_account_id,patient_id_value,'auth.google.link','account',requested_account_id::text,
    'success','patient-self','application','identity-api','{}'::jsonb);
  return true;
end
$$;

revoke all on auth.google_onboarding_capabilities from public;
revoke all on function auth.create_google_onboarding_capability(uuid,char,text),
  auth.google_onboarding_capability_status(uuid,char),
  auth.bind_google_onboarding_capability(uuid,char,uuid,char),
  auth.consume_google_onboarding_capability(uuid,char,uuid,uuid),
  auth.link_google_identity_to_patient_account(uuid,text) from public;
