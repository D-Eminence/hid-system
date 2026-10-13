-- Public patient enrollment: the activation windows of launch decision N2 and
-- a cost ceiling on QoreID NIN lookups. Applied migrations 0001 through 0084
-- are immutable; this one changes behaviour only by CREATE OR REPLACE and a
-- new table.
--
-- 1. identity.activate_public_patient_enrollment (0058) keeps its signature,
--    owner and grants. It now refuses
--      * a first activation whose contact was proved more than 30 minutes
--        earlier (N2(c)): check_violation PATIENT_CONTACT_REVERIFY_REQUIRED,
--        changing nothing; the Identity API then sends the enrollment back to
--        the contact step;
--      * a replay more than 15 minutes after activation (N2(b)):
--        no_data_found PATIENT_ENROLLMENT_REPLAY_EXPIRED, without the HID;
--        the Identity API answers it as an unknown enrollment.
--    Everything else in the body is unchanged from 0058.
-- 2. platform.consume_public_patient_nin_quota charges each QoreID NIN lookup
--    of public enrollment, made before any account exists, to a keyed digest
--    of the client network (an IPv4 address or an IPv6 /64, computed by the
--    Identity API with its server-only OTP HMAC key) per hour and per day, and
--    to one platform-wide daily cap. The account-scoped 0049 `patient_nin`
--    quota cannot apply and is unchanged. The Identity API passes the limits
--    from its configuration within the bounds checked here. No NIN, raw
--    address or provider payload is stored. Every decision is audited,
--    denials with the exhausted limit.
-- 3. platform.prune_verification_quotas also drains the new counters.

create or replace function identity.activate_public_patient_enrollment(
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

create table platform.public_patient_nin_quota_counters (
  scope text not null check (scope in ('network', 'platform')),
  scope_key text not null,
  bucket_period text not null check (bucket_period in ('hour', 'day')),
  bucket_start timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (scope, scope_key, bucket_period, bucket_start),
  check ((scope = 'network' and scope_key ~ '^[a-f0-9]{64}$')
    or (scope = 'platform' and scope_key = 'all' and bucket_period = 'day'))
);
create index public_patient_nin_quota_expiry_idx on platform.public_patient_nin_quota_counters(bucket_start);
alter table platform.public_patient_nin_quota_counters enable row level security;
alter table platform.public_patient_nin_quota_counters force row level security;
-- As in 0049 and 0063, the security-definer command is the only runtime access path.
create policy public_patient_nin_quota_command_read on platform.public_patient_nin_quota_counters
  for select using (true);
create policy public_patient_nin_quota_command_insert on platform.public_patient_nin_quota_counters
  for insert with check (true);
create policy public_patient_nin_quota_command_update on platform.public_patient_nin_quota_counters
  for update using (true) with check (true);
create policy public_patient_nin_quota_command_delete on platform.public_patient_nin_quota_counters
  for delete using (true);
revoke all on platform.public_patient_nin_quota_counters from public;

-- Returns true when the lookup may proceed. A denial returns false rather than
-- raising, so its audit event commits while every counter stays unchanged.
create function platform.consume_public_patient_nin_quota(
  requested_network_digest char(64),
  network_hourly_limit integer,
  network_daily_limit integer,
  platform_daily_limit integer
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, platform, audit, pg_temp
as $$
declare
  quota record;
  new_attempts integer;
  exhausted_limit text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or platform.current_account_id() is not null
     or requested_network_digest is null
     or requested_network_digest !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;
  if network_hourly_limit is null or network_daily_limit is null or platform_daily_limit is null
     or network_hourly_limit not between 1 and 100
     or network_daily_limit not between network_hourly_limit and 1000
     or platform_daily_limit not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'QOREID_QUOTA_LIMIT_INVALID';
  end if;

  delete from platform.public_patient_nin_quota_counters old
   where old.ctid in (select stale.ctid from platform.public_patient_nin_quota_counters stale
     where stale.bucket_start < statement_timestamp() - interval '48 hours'
     order by stale.bucket_start limit 100);

  begin
    for quota in
      select * from (values
        ('network_hour'::text, 'network'::text, requested_network_digest::text, 'hour'::text,
          date_trunc('hour', statement_timestamp()), network_hourly_limit),
        ('network_day'::text, 'network'::text, requested_network_digest::text, 'day'::text,
          date_trunc('day', statement_timestamp()), network_daily_limit),
        ('platform_day'::text, 'platform'::text, 'all'::text, 'day'::text,
          date_trunc('day', statement_timestamp()), platform_daily_limit)
      ) as limits(limit_name, scope, scope_key, bucket_period, bucket_start, max_attempts)
    loop
      insert into platform.public_patient_nin_quota_counters as counter
        (scope, scope_key, bucket_period, bucket_start, attempt_count)
      values (quota.scope, quota.scope_key, quota.bucket_period, quota.bucket_start, 1)
      on conflict (scope, scope_key, bucket_period, bucket_start)
      do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
        where counter.attempt_count < quota.max_attempts
      returning attempt_count into new_attempts;
      if not found then
        exhausted_limit := quota.limit_name;
        raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
      end if;
    end loop;
  exception when sqlstate 'P4290' then
    -- Leaving the block rolls back any increment made before the exhausted scope.
    null;
  end;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.public-patient-enrollment.nin-lookup-quota',
    case when exhausted_limit is null then 'success' else 'denied' end,
    'qoreid-lookup-quota', 'patient_nin',
    'application', 'identity-api',
    jsonb_build_object('operation', 'public_patient_nin', 'exhaustedLimit', exhausted_limit,
      'networkDigest', requested_network_digest)
  );

  return exhausted_limit is null;
end
$$;

revoke all on function platform.consume_public_patient_nin_quota(char,integer,integer,integer) from public;

-- Hourly retention now also drains the public enrollment NIN lookup counters.
create or replace function platform.prune_verification_quotas() returns integer
language plpgsql security definer
set search_path = pg_catalog, platform, pg_temp
as $$
declare
  deleted_count integer := 0;
  batch_count integer;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;
  delete from platform.qoreid_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.qoreid_test_quota_reservations
    where reserved_at < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.public_application_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.self_service_cac_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.public_patient_nin_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  return deleted_count + batch_count;
end
$$;
revoke all on function platform.prune_verification_quotas() from public;
