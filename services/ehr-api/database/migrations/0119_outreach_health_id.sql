-- Assisted Health ID at an outreach (owner, 2026-11-13: "after their
-- information is taking on outreach, we can just get health id for them by
-- verifying with thier number ... they can complete their infornation input
-- later"; and "lets able to send to mail to not just number"). The number
-- 0119 is a placeholder; it releases right after 0118 (outreach screening).
--
-- WHAT IT DOES
-- A volunteer or organiser at an outreach group (outreach.registration.write,
-- a member of the registration's campaign) creates a patient Health ID for a
-- person they registered, from the registration's details only (name, sex,
-- phone), after the person proves an email address with a 6-digit code sent
-- to it. Tonight the code goes by email only (SMS is not confirmed live).
--   * identity.outreach_health_id_challenges: the codes (only a keyed
--     verifier of the code, never the code), the email (ciphertext and lookup
--     HMAC), expiry, attempts, and who asked. Owner-only.
--   * identity.outreach_registration_health_ids: one row per registration for
--     which a Health ID was created this way (the patient, the Health ID, who
--     and when). The registration itself stays as it is: rule G (0115: an
--     outreach group never links a person to an EXISTING Health ID) is not
--     touched. Owner-only.
--   * Commands for the Identity runtime, run in the volunteer's delegated
--     session (identity-api sets the session from the volunteer's sign-in):
--       - identity.outreach_health_id_registration(case): the registration's
--         name, sex, age, phone and group name, for a volunteer who may write
--         it, refusing (55000/42501/23514 with a code) a registration that is
--         not visible, redacted, under 18, at a group that is
--         suspended, sealed (demo or QA) or not an outreach group; or its
--         Health ID when one was already created.
--       - identity.outreach_health_id_start(...): a new email code for the
--         registration, refusing an email or phone already on a Health ID
--         (23505, never saying whose), more than 3 codes for the
--         registration in 24 hours or one within 60 seconds of the last
--         (P0001). Earlier open codes are invalidated.
--       - identity.outreach_health_id_open_challenge(case): the open code's id
--         (identity-api keys the verifier with it).
--       - identity.outreach_health_id_confirm(...): checks the code (counting
--         failures, which are kept: the command answers an outcome rather than
--         raising), then creates the account (no password, status
--         pending_reset, email verified), the patient (name, sex and the
--         proven email only: the registration's phone, never proven, is not
--         stored, so it never blocks the number's real owner; the person adds
--         a phone later in the app; no date of birth), its Health ID
--         identifier and assurance state
--         CONTACT_VERIFIED, records the registration's Health ID, and writes
--         one audit row (ids only). A replay answers the Health ID created.
--   * identity.outreach_registration_health_ids_for(cases): for the Outreach
--     runtime, the Health IDs created for the given registrations the session
--     can see (registration reads show "healthId").
--   The person sets a password later with "Forgot password" by email: the
--   account's email is verified.
--
-- Not changed: the registration tables, rule G, patient sign-up and recovery.

-- 0. Preconditions.
do $$
begin
  if to_regclass('outreach.registration_screenings') is null
     or to_regclass('outreach.registration_redactions') is null
     or to_regprocedure('outreach.organiser_tenant_state(uuid)') is null
     or to_regprocedure('outreach.registration_campaign_member(uuid,uuid)') is null
     or to_regprocedure('outreach.context_allows(uuid,text)') is null
     or to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or to_regprocedure('identity.sealed_demo_facility(uuid)') is null then
    raise exception using errcode = '55000', message = '0119: a prerequisite object is missing (0115, 0116, 0118, 0098)';
  end if;
  -- The commands run as the owner of identity.patients and write these.
  if exists (select 1 from unnest(array['auth.accounts', 'identity.patients', 'identity.patient_identifiers',
               'identity.patient_assurance_states', 'audit.events']) as target(name)
             where not has_table_privilege((select relowner from pg_class where oid = 'identity.patients'::regclass),
               target.name, 'INSERT')) then
    raise exception using errcode = '55000', message =
      '0119: the owner of identity.patients cannot insert into the account, patient or audit tables';
  end if;
  if to_regclass('identity.outreach_health_id_challenges') is not null then
    raise exception using errcode = '55000', message = '0119: already applied';
  end if;
  -- The commands' owner (Identity's) reads the outreach registration under
  -- the volunteer's row-level security: one owner for both schemas.
  if (select relowner from pg_class where oid = 'identity.patients'::regclass)
       <> (select relowner from pg_class where oid = 'outreach.registration_cases'::regclass) then
    raise exception using errcode = '55000', message = '0119: identity.patients and outreach.registration_cases have different owners';
  end if;
  -- Patients and accounts do not force row-level security (their owner, the
  -- commands' owner, writes them; 0109 asserts the same for patients).
  if exists (select 1 from pg_class where oid in ('identity.patients'::regclass, 'auth.accounts'::regclass,
               'identity.patient_identifiers'::regclass, 'identity.patient_assurance_states'::regclass)
               and relforcerowsecurity) then
    raise exception using errcode = '55000', message = '0119: a patient or account table forces row-level security';
  end if;
end
$$;

-- 1. Tables.
create table identity.outreach_health_id_challenges (
  id uuid primary key,
  registration_case_id uuid not null references outreach.registration_cases(id) on delete restrict,
  facility_id uuid not null,
  channel text not null check (channel = 'email'),
  email_lookup_hmac char(64) not null check (email_lookup_hmac ~ '^[0-9a-f]{64}$'),
  email_ciphertext bytea not null check (octet_length(email_ciphertext) between 16 and 2048),
  key_version text not null check (length(key_version) between 1 and 64),
  verifier_hmac char(64) not null check (verifier_hmac ~ '^[0-9a-f]{64}$'),
  verifier_key_version text not null check (length(verifier_key_version) between 1 and 64),
  expires_at timestamptz not null,
  failed_attempts smallint not null default 0,
  max_attempts smallint not null check (max_attempts between 1 and 10),
  requested_by_account_id uuid not null,
  requested_by_membership_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text check (invalidation_reason in ('resend', 'attempts_exhausted', 'delivery_failed')),
  check (failed_attempts between 0 and max_attempts),
  check ((invalidated_at is null) = (invalidation_reason is null)),
  check (not (consumed_at is not null and invalidated_at is not null))
);
create index outreach_health_id_challenges_case_idx
  on identity.outreach_health_id_challenges (registration_case_id, created_at desc);
create unique index outreach_health_id_challenges_open_uq
  on identity.outreach_health_id_challenges (registration_case_id)
  where consumed_at is null and invalidated_at is null;

create table identity.outreach_registration_health_ids (
  registration_case_id uuid primary key references outreach.registration_cases(id) on delete restrict,
  facility_id uuid not null,
  patient_id uuid not null unique references identity.patients(id) on delete restrict,
  account_id uuid not null unique references auth.accounts(id) on delete restrict,
  hid_code text not null check (hid_code ~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'),
  challenge_id uuid not null unique references identity.outreach_health_id_challenges(id) on delete restrict,
  created_by_account_id uuid not null,
  created_by_membership_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table identity.outreach_health_id_challenges is
  '0119: the email codes for creating a Health ID from an outreach registration (a keyed verifier only, never the code), with expiry, attempts and who asked. Owner-only.';
comment on table identity.outreach_registration_health_ids is
  '0119: the Health ID created from an outreach registration (one per registration), by whom and when. The registration itself is unchanged (0115''s rule G stands). Owner-only.';

create function identity.outreach_registration_health_ids_immutable()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception using errcode = '55000', message = 'OUTREACH_HEALTH_ID_RECORD_IMMUTABLE';
end
$$;
create trigger outreach_registration_health_ids_immutable
  before update or delete on identity.outreach_registration_health_ids
  for each row execute function identity.outreach_registration_health_ids_immutable();

alter table identity.outreach_health_id_challenges enable row level security;
alter table identity.outreach_health_id_challenges force row level security;
alter table identity.outreach_registration_health_ids enable row level security;
alter table identity.outreach_registration_health_ids force row level security;

-- 2. The registration, as the volunteer may use it.
create function identity.outreach_health_id_registration(requested_case_id uuid)
returns table (registration_case_id uuid, facility_id uuid, full_name text, sex text, age_years integer, phone text,
  group_name text, existing_hid_code text)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  registration record;
  tenant_state text;
  qa boolean := false;
begin
  if requested_case_id is null or platform.current_account_id() is null or platform.current_membership_id() is null
     or platform.current_facility_id() is null
     or not coalesce(auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
       platform.current_facility_id(), 'outreach.registration.write'), false) then
    raise exception using errcode = '42501', message = 'OUTREACH_REGISTRATION_NOT_FOUND';
  end if;
  -- The facility and the campaign's members only (0024, 0045). Checked here as
  -- well as by row-level security, which does not apply to a superuser owner.
  select case_row.id, case_row.facility_id, case_row.full_name, case_row.sex, case_row.age_years, case_row.phone
    into registration
    from outreach.registration_cases case_row
   where case_row.id = requested_case_id and case_row.facility_id = platform.current_facility_id()
     and outreach.registration_campaign_member(case_row.campaign_id, case_row.facility_id);
  if registration.id is null then
    raise exception using errcode = '42501', message = 'OUTREACH_REGISTRATION_NOT_FOUND';
  end if;
  if exists (select 1 from outreach.registration_redactions redaction
              where redaction.registration_case_id = registration.id) then
    raise exception using errcode = '55000', message = 'OUTREACH_REGISTRATION_REDACTED';
  end if;
  tenant_state := outreach.organiser_tenant_state(registration.facility_id);
  if to_regprocedure('identity.sealed_qa_facility(uuid)') is not null then
    execute 'select identity.sealed_qa_facility($1)' into qa using registration.facility_id;
  end if;
  if tenant_state is null or identity.sealed_demo_facility(registration.facility_id) or coalesce(qa, false) then
    raise exception using errcode = '42501', message = 'OUTREACH_HEALTH_ID_NOT_AVAILABLE';
  end if;
  if tenant_state = 'suspended' then
    raise exception using errcode = '55000', message = 'OUTREACH_ORGANISER_SUSPENDED';
  end if;
  return query select registration.id, registration.facility_id, registration.full_name, registration.sex,
    registration.age_years::integer, registration.phone,
    (select organisation.display_name::text from identity.outreach_organisations organisation
      where organisation.facility_id = registration.facility_id),
    (select link.hid_code from identity.outreach_registration_health_ids link
      where link.registration_case_id = registration.id);
end
$$;

comment on function identity.outreach_health_id_registration(uuid) is
  '0119: the outreach registration a volunteer may create a Health ID from (name, sex, age, phone, the group''s name, or the Health ID already created), at the volunteer''s facility and in a campaign they are a member of (checked here and by row-level security). Refuses 42501 OUTREACH_REGISTRATION_NOT_FOUND (not visible, or no outreach.registration.write), 55000 OUTREACH_REGISTRATION_REDACTED, 42501 OUTREACH_HEALTH_ID_NOT_AVAILABLE (not an outreach group, or a sealed demo or QA one), 55000 OUTREACH_ORGANISER_SUSPENDED.';

-- The checks a creation needs beyond the registration itself.
create function identity.outreach_health_id_eligible(requested_case_id uuid)
returns void language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  registration record;
begin
  select * into registration from identity.outreach_health_id_registration(requested_case_id);
  if registration.existing_hid_code is not null then
    raise exception using errcode = '23505', message = 'OUTREACH_HEALTH_ID_ALREADY_CREATED',
      detail = registration.existing_hid_code;
  end if;
  if registration.age_years < 18 then
    raise exception using errcode = '23514', message = 'OUTREACH_HEALTH_ID_UNDER_18';
  end if;
end
$$;

-- 3. A new email code.
create function identity.outreach_health_id_start(
  requested_case_id uuid, requested_challenge_id uuid, requested_email text, requested_email_lookup_hmac char(64),
  requested_email_ciphertext bytea, requested_phone_lookup_hmac char(64), requested_key_version text,
  requested_verifier_hmac char(64), requested_verifier_key_version text, requested_ttl_seconds integer,
  requested_max_attempts integer
) returns table (challenge_id uuid, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  registration record;
  normalized_email text := lower(btrim(requested_email));
  last_sent timestamptz;
  sent_today integer;
  new_expiry timestamptz;
begin
  select * into registration from identity.outreach_health_id_registration(requested_case_id);
  -- The registration's lock first, then eligibility: a confirmation that
  -- committed while this waited is seen (ALREADY_CREATED).
  perform pg_advisory_xact_lock(hashtextextended('outreach-health-id:' || requested_case_id::text, 0));
  perform identity.outreach_health_id_eligible(requested_case_id);
  if requested_challenge_id is null or normalized_email is null
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(normalized_email) > 254
     or coalesce(requested_email_lookup_hmac, '') !~ '^[0-9a-f]{64}$'
     or (registration.phone is null) <> (requested_phone_lookup_hmac is null)
     or coalesce(requested_phone_lookup_hmac, repeat('0', 64)) !~ '^[0-9a-f]{64}$'
     or requested_ttl_seconds not between 60 and 1800 or requested_max_attempts not between 1 and 10 then
    raise exception using errcode = '22023', message = 'OUTREACH_HEALTH_ID_EMAIL_INVALID';
  end if;
  -- A request id already used (a retried request whose code then failed or
  -- expired): the caller starts a new request.
  if exists (select 1 from identity.outreach_health_id_challenges challenge where challenge.id = requested_challenge_id) then
    raise exception using errcode = '55000', message = 'OUTREACH_HEALTH_ID_REQUEST_USED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-contact:email:' || requested_email_lookup_hmac, 0));
  if requested_phone_lookup_hmac is not null then
    perform pg_advisory_xact_lock(hashtextextended('patient-contact:phone:' || requested_phone_lookup_hmac, 0));
  end if;
  -- Start answers the same for any email, so a volunteer cannot learn whether
  -- an email belongs to a patient or a staff login; confirmation refuses an
  -- email already on any account or patient, after the person proved it.
  if exists (select 1 from identity.patients patient where patient.phone_lookup_hmac = requested_phone_lookup_hmac) then
    raise exception using errcode = '23505', message = 'OUTREACH_HEALTH_ID_PHONE_TAKEN';
  end if;
  select max(challenge.created_at), count(*) filter (where challenge.created_at > clock_timestamp() - interval '24 hours')
    into last_sent, sent_today
    from identity.outreach_health_id_challenges challenge
   where challenge.registration_case_id = requested_case_id;
  if sent_today >= 3 then
    raise exception using errcode = 'P0001', message = 'OUTREACH_HEALTH_ID_TOO_MANY_CODES', detail = 'daily';
  end if;
  if last_sent > clock_timestamp() - interval '60 seconds' then
    raise exception using errcode = 'P0001', message = 'OUTREACH_HEALTH_ID_TOO_MANY_CODES', detail = format('cooldown:%s',
      ceil(extract(epoch from last_sent + interval '60 seconds' - clock_timestamp()))::integer);
  end if;
  update identity.outreach_health_id_challenges challenge
     set invalidated_at = clock_timestamp(), invalidation_reason = 'resend'
   where challenge.registration_case_id = requested_case_id
     and challenge.consumed_at is null and challenge.invalidated_at is null;
  new_expiry := clock_timestamp() + make_interval(secs => requested_ttl_seconds);
  insert into identity.outreach_health_id_challenges (id, registration_case_id, facility_id, channel,
    email_lookup_hmac, email_ciphertext, key_version, verifier_hmac, verifier_key_version, expires_at, max_attempts,
    requested_by_account_id, requested_by_membership_id)
  values (requested_challenge_id, requested_case_id, registration.facility_id, 'email', requested_email_lookup_hmac,
    requested_email_ciphertext, requested_key_version, requested_verifier_hmac, requested_verifier_key_version,
    new_expiry, requested_max_attempts, platform.current_account_id(), platform.current_membership_id());
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'staff', platform.current_actor_subject(), platform.current_account_id(),
    platform.current_membership_id(), registration.facility_id, 'outreach.health-id.code-sent', 'success',
    'outreach-registration-case', requested_case_id::text, 'direct-care', 'application', 'identity-api',
    jsonb_build_object('channel', 'email', 'codesToday', sent_today + 1));
  return query select requested_challenge_id, new_expiry;
end
$$;

comment on function identity.outreach_health_id_start(uuid,uuid,text,char,bytea,char,text,char,text,integer,integer) is
  '0119: a new email code for creating a Health ID from an outreach registration (the volunteer''s session). Answers the same for any email (an email already in use is refused only at confirmation, after the proof); refuses the registration''s phone already on a Health ID (23505 OUTREACH_HEALTH_ID_PHONE_TAKEN, never whose), more than 3 codes for the registration in 24 hours (P0001 OUTREACH_HEALTH_ID_TOO_MANY_CODES, detail daily) or one within 60 seconds (detail cooldown:<seconds>), a request id already used (55000 OUTREACH_HEALTH_ID_REQUEST_USED), and every refusal of identity.outreach_health_id_registration. One audit row (counts only).';

-- A delivery that failed definitively ends its code (it does not count
-- towards the daily three any less).
create function identity.outreach_health_id_delivery_failed(requested_challenge_id uuid)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update identity.outreach_health_id_challenges challenge
     set invalidated_at = clock_timestamp(), invalidation_reason = 'delivery_failed'
   where challenge.id = requested_challenge_id
     and challenge.requested_by_account_id = platform.current_account_id()
     and challenge.consumed_at is null and challenge.invalidated_at is null;
end
$$;

create function identity.outreach_health_id_open_challenge(requested_case_id uuid)
returns table (challenge_id uuid, expires_at timestamptz, verifier_key_version text, email_ciphertext bytea,
  key_version text)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
begin
  perform identity.outreach_health_id_registration(requested_case_id);
  -- The email's ciphertext, which identity-api decrypts for the account at
  -- confirmation (the database never holds it in the clear).
  return query select challenge.id, challenge.expires_at, challenge.verifier_key_version, challenge.email_ciphertext,
    challenge.key_version
    from identity.outreach_health_id_challenges challenge
   where challenge.registration_case_id = requested_case_id
     and challenge.consumed_at is null and challenge.invalidated_at is null
   order by challenge.created_at desc limit 1;
end
$$;

-- 4. Confirming the code and creating the Health ID.
create function identity.outreach_health_id_confirm(
  requested_case_id uuid, requested_challenge_id uuid, requested_verifier_hmac char(64), requested_email text,
  requested_hid text
) returns table (outcome text, hid_code text, patient_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  registration record;
  challenge identity.outreach_health_id_challenges%rowtype;
  existing record;
  normalized_email text := lower(btrim(requested_email));
  new_account uuid := gen_random_uuid();
  new_patient uuid := gen_random_uuid();
  first_name_value text;
  last_name_value text;
  clean_name text;
begin
  select * into registration from identity.outreach_health_id_registration(requested_case_id);
  perform pg_advisory_xact_lock(hashtextextended('outreach-health-id:' || requested_case_id::text, 0));
  select * into existing from identity.outreach_registration_health_ids link
   where link.registration_case_id = requested_case_id;
  if existing.registration_case_id is not null then
    if existing.challenge_id = requested_challenge_id then
      return query select 'replayed'::text, existing.hid_code, existing.patient_id;
      return;
    end if;
    raise exception using errcode = '23505', message = 'OUTREACH_HEALTH_ID_ALREADY_CREATED', detail = existing.hid_code;
  end if;
  perform identity.outreach_health_id_eligible(requested_case_id);
  select * into challenge from identity.outreach_health_id_challenges candidate
   where candidate.id = requested_challenge_id and candidate.registration_case_id = requested_case_id
   for update;
  if challenge.id is null or challenge.consumed_at is not null or challenge.invalidated_at is not null then
    return query select 'expired'::text, null::text, null::uuid;
    return;
  end if;
  if challenge.expires_at <= clock_timestamp() then
    return query select 'expired'::text, null::text, null::uuid;
    return;
  end if;
  if requested_verifier_hmac is distinct from challenge.verifier_hmac then
    update identity.outreach_health_id_challenges candidate
       set failed_attempts = candidate.failed_attempts + 1,
           invalidated_at = case when candidate.failed_attempts + 1 >= candidate.max_attempts then clock_timestamp() end,
           invalidation_reason = case when candidate.failed_attempts + 1 >= candidate.max_attempts
                                      then 'attempts_exhausted' end
     where candidate.id = challenge.id;
    return query select case when challenge.failed_attempts + 1 >= challenge.max_attempts then 'too_many_tries'
                             else 'invalid' end, null::text, null::uuid;
    return;
  end if;
  if normalized_email is null or requested_hid is null or requested_hid !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$' then
    raise exception using errcode = '22023', message = 'OUTREACH_HEALTH_ID_REQUEST_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-contact:email:' || challenge.email_lookup_hmac, 0));
  if exists (select 1 from auth.accounts account where lower(account.email) = normalized_email
              and account.status <> 'deleted')
     or exists (select 1 from identity.patients patient where patient.email_lookup_hmac = challenge.email_lookup_hmac) then
    raise exception using errcode = '23505', message = 'OUTREACH_HEALTH_ID_EMAIL_TAKEN';
  end if;
  -- Names as patient sign-up allows them: no control characters, whitespace
  -- collapsed, each name at most 80 characters (0093).
  clean_name := left(btrim(regexp_replace(regexp_replace(registration.full_name, '[[:cntrl:]]', ' ', 'g'),
    '[[:space:]]+', ' ', 'g')), 200);
  if clean_name = '' then
    raise exception using errcode = '23514', message = 'OUTREACH_HEALTH_ID_NAME_INVALID';
  end if;
  first_name_value := left(split_part(clean_name, ' ', 1), 80);
  last_name_value := left(coalesce(nullif(btrim(substr(clean_name, length(split_part(clean_name, ' ', 1)) + 1)), ''),
    first_name_value), 80);
  update identity.outreach_health_id_challenges candidate set consumed_at = clock_timestamp()
   where candidate.id = challenge.id;
  insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system)
  values (new_account, 'patient:' || new_account::text, normalized_email, clean_name,
    'pending_reset', clock_timestamp(), 'hid-outreach-health-id');
  -- Only the proven email. The registration's phone, typed by the volunteer
  -- and never proven, is not stored on the Health ID (it would block the
  -- number's real owner from signing up); the person adds a phone later in the
  -- app through the verified contact change.
  insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob,
    email_ciphertext, email_lookup_hmac, contact_key_version, source_system, status)
  values (new_patient, new_account, requested_hid, first_name_value, last_name_value, clean_name,
    registration.sex, null, challenge.email_ciphertext, challenge.email_lookup_hmac, challenge.key_version,
    'hid-outreach-health-id', 'active');
  insert into identity.patient_identifiers (id, patient_id, identifier_type, public_value, verified, source_system)
  values (gen_random_uuid(), new_patient, 'hid_code', requested_hid, true, 'hid-outreach-health-id');
  insert into identity.patient_assurance_states (patient_id, account_id, state, source_system, source_reference,
    contact_verified_at)
  -- The assurance patient sign-up writes ('hid-public-signup'), so the person
  -- can verify a NIN later like any patient who signed up without one (0092's
  -- identity.patient_self_nin_eligibility); the outreach origin is in the
  -- reference, the patient's source_system and the registration's record.
  values (new_patient, new_account, 'CONTACT_VERIFIED', 'hid-public-signup', 'outreach-health-id:' || challenge.id::text,
    clock_timestamp());
  insert into identity.outreach_registration_health_ids (registration_case_id, facility_id, patient_id, account_id,
    hid_code, challenge_id, created_by_account_id, created_by_membership_id)
  values (requested_case_id, registration.facility_id, new_patient, new_account, requested_hid, challenge.id,
    platform.current_account_id(), platform.current_membership_id());
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system,
    details)
  values (platform.current_correlation_id(), 'staff', platform.current_actor_subject(), platform.current_account_id(),
    platform.current_membership_id(), registration.facility_id, new_patient, 'outreach.health-id.created', 'success',
    'outreach-registration-case', requested_case_id::text, 'direct-care', 'application', 'identity-api',
    jsonb_build_object('channel', 'email', 'contactVerified', true));
  return query select 'created'::text, requested_hid, new_patient;
end
$$;

comment on function identity.outreach_health_id_confirm(uuid,uuid,char,text,text) is
  '0119: checks an outreach Health ID code and, when right, creates the account (no password, pending_reset, email verified), the patient (the registration''s name and sex; the verified email; no phone, no date of birth), its Health ID identifier and CONTACT_VERIFIED assurance, the registration''s Health ID record and one audit row (ids only). Answers an outcome (created, replayed, invalid, expired, too_many_tries) so that a failed attempt is counted; raises the refusals of identity.outreach_health_id_registration, 23505 OUTREACH_HEALTH_ID_ALREADY_CREATED / _EMAIL_TAKEN, 23514 _UNDER_18 / _NAME_INVALID (a name with nothing printable). The registration''s phone, never proven, is not stored on the Health ID, so it never blocks the number''s real owner; the person adds a phone later in the app.';

-- 5. For outreach-api: the Health IDs created for registrations the session can see.
create function identity.outreach_registration_health_ids_for(requested_case_ids uuid[])
returns table (registration_case_id uuid, hid_code text)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select link.registration_case_id, link.hid_code
    from identity.outreach_registration_health_ids link
   where link.registration_case_id = any(requested_case_ids)
     and cardinality(requested_case_ids) <= 500
     and link.facility_id = platform.current_facility_id()
     and outreach.context_allows(link.facility_id, 'outreach.registration.read')
     and not exists (select 1 from outreach.registration_redactions redaction
                      where redaction.registration_case_id = link.registration_case_id)
     and exists (select 1 from outreach.registration_cases case_row where case_row.id = link.registration_case_id
                  and case_row.facility_id = link.facility_id
                  and outreach.registration_campaign_member(case_row.campaign_id, case_row.facility_id))
$$;

comment on function identity.outreach_registration_health_ids_for(uuid[]) is
  '0119: for the Outreach runtime, the Health IDs created (0119) for up to 500 registrations at the session facility that the session can see: the facility, outreach.registration.read for direct care (outreach.context_allows) and campaign membership, checked here and by the registration''s row-level security; never a redacted registration.';

-- 6. Owners, policies, ACLs. Everything new belongs to the owner of
-- identity.patients (also outreach.registration_cases', precondition), whoever
-- applies the migration; the SECURITY DEFINER commands then run as that owner.
do $$
declare
  owner_name name := (select pg_get_userbyid(relowner) from pg_class where oid = 'identity.patients'::regclass);
begin
  if owner_name <> current_user then
    if not (pg_has_role(current_user, owner_name, 'USAGE') and pg_has_role(current_user, owner_name, 'SET')) then
      raise exception using errcode = '42501', message = format(
        '0119: the applier (%s) must INHERIT and SET ROLE to the owner of identity.patients (%s)', current_user, owner_name);
    end if;
    execute format('alter table identity.outreach_health_id_challenges owner to %I', owner_name);
    execute format('alter table identity.outreach_registration_health_ids owner to %I', owner_name);
    execute format('alter function identity.outreach_registration_health_ids_immutable() owner to %I', owner_name);
    execute format('alter function identity.outreach_health_id_registration(uuid) owner to %I', owner_name);
    execute format('alter function identity.outreach_health_id_eligible(uuid) owner to %I', owner_name);
    execute format('alter function identity.outreach_health_id_start(uuid,uuid,text,char,bytea,char,text,char,text,integer,integer) owner to %I', owner_name);
    execute format('alter function identity.outreach_health_id_delivery_failed(uuid) owner to %I', owner_name);
    execute format('alter function identity.outreach_health_id_open_challenge(uuid) owner to %I', owner_name);
    execute format('alter function identity.outreach_health_id_confirm(uuid,uuid,char,text,text) owner to %I', owner_name);
    execute format('alter function identity.outreach_registration_health_ids_for(uuid[]) owner to %I', owner_name);
  end if;
  execute format('create policy outreach_health_id_challenges_owner on identity.outreach_health_id_challenges '
    || 'for all to %I using (true) with check (true)', owner_name);
  execute format('create policy outreach_registration_health_ids_owner on identity.outreach_registration_health_ids '
    || 'for all to %I using (true) with check (true)', owner_name);
end
$$;

revoke all on identity.outreach_health_id_challenges, identity.outreach_registration_health_ids from public;
revoke all on function identity.outreach_registration_health_ids_immutable(),
  identity.outreach_health_id_registration(uuid), identity.outreach_health_id_eligible(uuid),
  identity.outreach_health_id_start(uuid,uuid,text,char,bytea,char,text,char,text,integer,integer),
  identity.outreach_health_id_delivery_failed(uuid), identity.outreach_health_id_open_challenge(uuid),
  identity.outreach_health_id_confirm(uuid,uuid,char,text,text),
  identity.outreach_registration_health_ids_for(uuid[]) from public;

-- Grants (here and in runtime-grants.sql).
do $$
declare
  role_name text;
begin
  foreach role_name in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant execute on function identity.outreach_health_id_registration(uuid), '
        || 'identity.outreach_health_id_start(uuid,uuid,text,char,bytea,char,text,char,text,integer,integer), '
        || 'identity.outreach_health_id_delivery_failed(uuid), identity.outreach_health_id_open_challenge(uuid), '
        || 'identity.outreach_health_id_confirm(uuid,uuid,char,text,text) to %I', role_name);
    end if;
  end loop;
  foreach role_name in array array['hid_outreach_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant execute on function identity.outreach_registration_health_ids_for(uuid[]) to %I',
        role_name);
    end if;
  end loop;
end
$$;

-- 7. Post-checks.
do $$
begin
  if exists (select 1 from pg_roles role_row where role_row.rolname like 'hid\_%'
              and role_row.oid <> (select relowner from pg_class where oid = 'identity.patients'::regclass)
              and (has_table_privilege(role_row.oid, 'identity.outreach_health_id_challenges', 'SELECT,INSERT,UPDATE,DELETE')
                   or has_table_privilege(role_row.oid, 'identity.outreach_registration_health_ids',
                        'SELECT,INSERT,UPDATE,DELETE')
                   or has_function_privilege(role_row.oid, 'identity.outreach_health_id_eligible(uuid)', 'EXECUTE'))) then
    raise exception using errcode = '55000', message = '0119: a runtime role holds a privilege it must not';
  end if;
  if exists (select 1 from pg_class where oid in ('identity.outreach_health_id_challenges'::regclass,
               'identity.outreach_registration_health_ids'::regclass)
               and relowner <> (select relowner from pg_class where oid = 'identity.patients'::regclass))
     or exists (select 1 from pg_proc where pronamespace = 'identity'::regnamespace
               and (proname like 'outreach\_health\_id\_%' or proname like 'outreach\_registration\_health\_ids\_%')
               and proowner <> (select relowner from pg_class where oid = 'identity.patients'::regclass)) then
    raise exception using errcode = '55000', message = '0119: a new object is not owned by the owner of identity.patients';
  end if;
end
$$;
