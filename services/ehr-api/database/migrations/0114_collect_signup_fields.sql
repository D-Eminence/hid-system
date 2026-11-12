-- 0114 Collect the sign-up fields Health ID did not collect ("Not collected by
-- Health ID yet"): the facility's profile at facility sign-up and in the setup
-- wizard, and the patient's contact at the registration desk.
--
-- Owner decisions in chat (D-Eminence, relayed by the coordinator): "don't
-- remove them instead we need to collect those information" and "allow
-- trading name, all fields required". Every field of facility sign-up, the
-- setup wizard and staff patient registration is required (the website
-- always sends them; Identity refuses a partial set, and, for the release
-- step, still accepts a sign-up or desk request without any of the new
-- fields; a follow-up makes them required), except the three document uploads (operating
-- licence, CAC certificate, proof of address) and the facility logo, which
-- stay deferred until the document bucket and its scanner exist (D5). The
-- other decisions take the plan's recommended defaults:
--   D1  the facility keeps its CAC legal name; a trading name is collected
--       beside it (required, as the owner said);
--   D2  the directory and order routes keep showing the registered (CAC)
--       address (decision Q8); the site address is stored here and shown to
--       the facility's administrator and Health ID support only;
--   D3  phones are E.164, "+" and 8-15 digits (the normalizeContactForLookup
--       rule); identity.facility_alert_phones is NOT seeded from the facility
--       phone: it stays set by a platform administrator (0084);
--   D4  the Medical Director's name and MDCN number are collected (0086's
--       licence number format); the applicant's own phone is personal data
--       and is stored encrypted by Identity (AES-256-GCM, the 0084 pattern);
--   D6  the state is one of the 37 (identity.nigeria_states, seeded here);
--       the local government area is free text, required;
--   D7  departments are a fixed code list (the design's 15); choosing them
--       creates no department;
--   D8  after activation the facility administrator (workforce.manage at a
--       self-service facility) edits the profile; governed and legacy
--       facilities are refused (STAFF_MANAGEMENT_NOT_AVAILABLE);
--   D9  sealed demo facilities are refused (FACILITY_PROFILE_SEALED);
--   D10 the patient's phone and address at the desk are facility-held,
--       unverified, encrypted by Identity, never used for sign-in or
--       recovery;
--   D11 allergies are NOT collected at the desk (left to clinical records);
--   D12 "provisional local identity" stays off;
--   D13 an existing Health ID the patient states is recorded with the case.
--       It is a hint only: it never adds a review candidate and never
--       bypasses matching. When the patient it names is already a candidate
--       by name and date of birth, Identity adds the reason stated_hid to that
--       candidate; otherwise it records only whether it matched ('matches' or
--       'no_match', never whether the Health ID exists). A candidate whose
--       only reason is stated_hid cannot be linked.
--
-- WHAT IT DOES
--  1. identity.nigeria_states: the 36 states and the FCT (ISO 3166-2:NG
--     codes), read by Identity.
--  2. identity.facility_profiles: one profile row per facility, and, before
--     activation, one per emailed sign-up code (challenge_id) holding what
--     was sent with the request that asked for that code (as 0086 R6 keeps
--     the administrator name on the challenge). A code's row goes with the
--     code (ON DELETE CASCADE); a facility's row is never deleted.
--  3. identity.begin_self_service_provider_enrollment, a new 11-argument
--     signature: 0086's 7-argument command (unchanged, still granted, so the
--     running Identity keeps working) plus the profile and the applicant's
--     encrypted phone, stored with the code when a code is sent.
--  4. A trigger on identity.organization_applications: when an application
--     becomes approved with a facility, by self-service activation or by an
--     administrator's approval, the profile sent with its most recent
--     confirmed code is copied to the facility. No function body of 0086 or
--     0103 is replaced.
--  5. identity.read_facility_profile() and identity.set_facility_profile(...)
--     for the facility administrator (workforce.manage, healthcare-operations,
--     self-service facility), with If-Match (row_version) and Idempotency-Key
--     (auth.admin_command_idempotency); the audit row names the changed fields
--     only, never a value.
--  6. Patient registration: identity.registration_case_contacts (the case's
--     encrypted phone and address, their key version, the stated Health ID),
--     written once with the case, and identity.patient_facility_contacts,
--     the facility-held contact Identity writes when the case resolves to a
--     patient (resolved at once, approved new, linked existing). Neither is
--     ever deleted or changed, except by erasure (NDPA, 0084's rule): the
--     owner-only identity.erase_patient_facility_contacts nulls the
--     ciphertexts, key version and stated Health ID and records erased_at and
--     the reason, and removes the patient's Health ID from any other case
--     that stated it (that person's own phone and address stay). A trigger on
--     identity.patient_account_deletion_requests calls it when an account
--     deletion completes ('account_deleted'); Health ID support has it run
--     for an erasure request ('erasure_request'). A case that never became a
--     patient (rejected, cancelled, never reviewed) is erased by case with
--     the owner-only identity.erase_registration_case_contact
--     ('erasure_request'). Both refuse to run unless their caller is (a member
--     of) the owner of both contact tables, so a later change of owner fails
--     loudly instead of erasing nothing. identity.registration_cases is not
--     altered.
--
-- BACKWARD COMPATIBLE: no existing table gains a column; no existing
-- function body, policy or grant changes. Today's Identity calls the
-- 7-argument begin command and never reads the new objects. The new
-- Identity accepts the old request bodies too (the new sign-up and desk
-- fields are optional, all or none), so the release order is: this
-- backend first, then the website that sends the fields, then a follow-up
-- that makes them required.
--
-- A release applies only migrations, never runtime-grants.sql, so the grants
-- are in this file, for roles that already exist, and in runtime-grants.sql,
-- for a role bootstrap. The declaration in
-- config/production-schema-compatibility.json is signed separately: its
-- reviewed_by stays empty until the owner signs it there.

-- 0. Preconditions (catalog reads only).
do $$
declare
  applier oid := (select oid from pg_roles where rolname = current_user);
  table_name text;
begin
  if to_regclass('identity.facility_profiles') is not null
     or to_regclass('identity.nigeria_states') is not null
     or to_regclass('identity.patient_facility_contacts') is not null
     or to_regclass('identity.registration_case_contacts') is not null then
    raise exception using errcode = '55000', message = '0114: already applied';
  end if;
  if to_regprocedure('identity.begin_self_service_provider_enrollment(text,text,text,uuid,char,text,text)') is null
     or to_regprocedure('identity.staff_management_actor(boolean)') is null
     or to_regprocedure('identity.sealed_demo_facility(uuid)') is null
     or to_regprocedure('identity.licence_number_valid(text)') is null
     or to_regprocedure('identity.normalize_licence_number(text)') is null
     or to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or to_regprocedure('platform.reject_mutation()') is null
     or to_regclass('auth.admin_command_idempotency') is null
     or to_regclass('identity.patient_account_deletion_requests') is null
     or not exists (select 1 from pg_attribute
                     where attrelid = 'identity.patient_account_deletion_requests'::regclass
                       and attname = 'state' and not attisdropped)
     or to_regprocedure('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)') is null
     or not exists (select 1 from pg_attribute
                     where attrelid = 'identity.organization_profile_completion_challenges'::regclass
                       and attname = 'requested_organization_type' and not attisdropped)
     -- 0111 (the last migration before this one on staging) is applied.
     or to_regprocedure('outreach.campaign_staff(uuid)') is null then
    raise exception using errcode = '55000', message = '0114: 0001-0111 must be applied first';
  end if;
  -- The applier will own the new tables, functions and the trigger on
  -- identity.organization_applications, so it must own (or be a member of the
  -- owner of) the tables it alters or adds a trigger to.
  foreach table_name in array array['identity.organization_applications',
    'identity.organization_profile_completion_challenges', 'identity.registration_cases',
    'identity.facilities', 'identity.patients', 'identity.patient_account_deletion_requests'] loop
    if not pg_has_role(applier, (select relowner from pg_class where oid = table_name::regclass), 'USAGE') then
      raise exception using errcode = '42501', message = format('0114: the applier must own %s', table_name);
    end if;
  end loop;
end
$$;

lock table identity.organization_applications, identity.organization_profile_completion_challenges,
  identity.registration_cases, identity.patient_account_deletion_requests in share row exclusive mode;

-- 1. The states (D6). The FCT is "Federal Capital Territory" (the website's
-- facility list says "FCT"; hid-system apps/web says "Abuja FCT").
create table identity.nigeria_states (
  code char(2) primary key check (code ~ '^[A-Z]{2}$'),
  name text not null unique check (name = btrim(name) and length(name) between 2 and 60)
);
insert into identity.nigeria_states (code, name) values
  ('AB', 'Abia'), ('AD', 'Adamawa'), ('AK', 'Akwa Ibom'), ('AN', 'Anambra'), ('BA', 'Bauchi'),
  ('BY', 'Bayelsa'), ('BE', 'Benue'), ('BO', 'Borno'), ('CR', 'Cross River'), ('DE', 'Delta'),
  ('EB', 'Ebonyi'), ('ED', 'Edo'), ('EK', 'Ekiti'), ('EN', 'Enugu'), ('FC', 'Federal Capital Territory'),
  ('GO', 'Gombe'), ('IM', 'Imo'), ('JI', 'Jigawa'), ('KD', 'Kaduna'), ('KN', 'Kano'),
  ('KT', 'Katsina'), ('KE', 'Kebbi'), ('KO', 'Kogi'), ('KW', 'Kwara'), ('LA', 'Lagos'),
  ('NA', 'Nasarawa'), ('NI', 'Niger'), ('OG', 'Ogun'), ('ON', 'Ondo'), ('OS', 'Osun'),
  ('OY', 'Oyo'), ('PL', 'Plateau'), ('RI', 'Rivers'), ('SO', 'Sokoto'), ('TA', 'Taraba'),
  ('YO', 'Yobe'), ('ZA', 'Zamfara');
alter table identity.nigeria_states enable row level security;
alter table identity.nigeria_states force row level security;
create policy nigeria_states_read on identity.nigeria_states for select using (true);
create trigger nigeria_states_no_mutation
  before update or delete on identity.nigeria_states
  for each row execute function platform.reject_mutation();
revoke all on identity.nigeria_states from public;

-- 2. The facility profile.
create function identity.facility_department_codes()
returns text[]
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select array['general_outpatient', 'emergency', 'inpatient', 'laboratory', 'pharmacy', 'maternity',
    'pediatrics', 'radiology', 'dental', 'physiotherapy', 'dialysis', 'oncology', 'cardiology', 'icu',
    'theatre']::text[]
$$;

-- 1 to 15 known codes, each once.
create function identity.facility_departments_valid(requested text[])
returns boolean
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    cardinality(requested) between 1 and 15
    and array_position(requested, null) is null
    and requested <@ identity.facility_department_codes()
    and (select count(distinct code) from unnest(requested) as code) = cardinality(requested),
    false)
$$;

create table identity.facility_profiles (
  id uuid primary key default gen_random_uuid(),
  -- Before activation: the emailed code whose request sent this profile.
  challenge_id uuid unique
    references identity.organization_profile_completion_challenges(id) on delete cascade,
  -- After activation: the facility.
  facility_id uuid unique references identity.facilities(id) on delete restrict,
  trading_name text not null check (trading_name = btrim(trading_name) and length(trading_name) between 2 and 200),
  ownership text not null check (ownership in ('public', 'private', 'faith_based', 'ngo')),
  care_level text not null check (care_level in ('primary', 'secondary', 'tertiary')),
  address_line text not null check (address_line = btrim(address_line) and length(address_line) between 5 and 300),
  city text not null check (city = btrim(city) and length(city) between 2 and 100),
  state_code char(2) not null references identity.nigeria_states(code) on delete restrict,
  lga text not null check (lga = btrim(lga) and length(lga) between 2 and 100),
  gps_latitude numeric(8,6) not null check (gps_latitude between 4 and 14),
  gps_longitude numeric(9,6) not null check (gps_longitude between 2.5 and 15),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email text not null check (email = lower(btrim(email)) and length(email) <= 254
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  bed_count integer not null check (bed_count between 0 and 100000),
  operating_hours text not null check (operating_hours = btrim(operating_hours)
    and length(operating_hours) between 2 and 200),
  emergency_24h boolean not null,
  departments text[] not null check (identity.facility_departments_valid(departments)),
  services_offered text not null check (services_offered = btrim(services_offered)
    and length(services_offered) between 2 and 2000),
  smoh_licence_number text not null check (smoh_licence_number = btrim(smoh_licence_number)
    and length(smoh_licence_number) between 2 and 100),
  has_registry_id boolean not null,
  registry_id text check (registry_id is null or (registry_id = btrim(registry_id)
    and length(registry_id) between 2 and 100)),
  has_nhia_accreditation boolean not null,
  nhia_accreditation_number text check (nhia_accreditation_number is null
    or (nhia_accreditation_number = btrim(nhia_accreditation_number)
      and length(nhia_accreditation_number) between 2 and 100)),
  medical_director_name text not null check (medical_director_name = btrim(medical_director_name)
    and length(medical_director_name) between 2 and 200),
  medical_director_mdcn text not null check (identity.licence_number_valid(medical_director_mdcn)
    and medical_director_mdcn = identity.normalize_licence_number(medical_director_mdcn)),
  expected_staff integer not null check (expected_staff between 1 and 100000),
  migrating_records boolean not null,
  needs_interoperability boolean not null,
  -- The applicant's role at the facility and phone (personal data, D4),
  -- given at sign-up; null for a profile an administrator first wrote after
  -- activation. The phone is AES-256-GCM ciphertext Identity wrote under
  -- identity:facility-signup-phone:<submitter_phone_ref>.
  submitter_role text check (submitter_role is null or submitter_role in
    ('owner', 'medical_director', 'administrator', 'other_authorised_representative')),
  submitter_phone_ciphertext bytea check (submitter_phone_ciphertext is null
    or octet_length(submitter_phone_ciphertext) between 30 and 2048),
  submitter_phone_key_version text check (submitter_phone_key_version is null
    or length(submitter_phone_key_version) between 1 and 64),
  submitter_phone_ref uuid,
  source text not null check (source in ('self_service_signup', 'facility_administrator')),
  updated_by_account_id uuid references auth.accounts(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  constraint facility_profiles_owner_ck check ((challenge_id is null) <> (facility_id is null)),
  constraint facility_profiles_registry_ck check (has_registry_id = (registry_id is not null)),
  constraint facility_profiles_nhia_ck check (has_nhia_accreditation = (nhia_accreditation_number is not null)),
  constraint facility_profiles_submitter_phone_ck check (
    (submitter_phone_ciphertext is null and submitter_phone_key_version is null and submitter_phone_ref is null)
    or (submitter_phone_ciphertext is not null and submitter_phone_key_version is not null
      and submitter_phone_ref is not null)),
  -- What sign-up sends is complete: the role and the phone with it.
  constraint facility_profiles_signup_ck check (
    challenge_id is null or (source = 'self_service_signup' and submitter_role is not null
      and submitter_phone_ciphertext is not null))
);
alter table identity.facility_profiles enable row level security;
alter table identity.facility_profiles force row level security;
-- Only the owner's commands below read and write it (no runtime grant).
create policy facility_profiles_command_read on identity.facility_profiles for select using (true);
create policy facility_profiles_command_insert on identity.facility_profiles for insert with check (true);
create policy facility_profiles_command_update on identity.facility_profiles
  for update using (true) with check (true);
create policy facility_profiles_command_delete on identity.facility_profiles
  for delete using (facility_id is null);
revoke all on identity.facility_profiles from public;

-- A facility's profile is never deleted and never moves; a code's profile is
-- never changed (it goes with its code).
create function identity.guard_facility_profile_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.facility_id is not null then
      raise exception using errcode = '42501', message = 'A facility profile cannot be deleted';
    end if;
    return old;
  end if;
  if old.challenge_id is not null
     or new.id is distinct from old.id
     or new.challenge_id is distinct from old.challenge_id
     or new.facility_id is distinct from old.facility_id
     or new.submitter_role is distinct from old.submitter_role
     or new.submitter_phone_ciphertext is distinct from old.submitter_phone_ciphertext
     or new.submitter_phone_key_version is distinct from old.submitter_phone_key_version
     or new.submitter_phone_ref is distinct from old.submitter_phone_ref
     or new.created_at is distinct from old.created_at
     or new.row_version <> old.row_version + 1 then
    raise exception using errcode = '42501', message = 'This facility profile change is not allowed';
  end if;
  return new;
end;
$$;
revoke all on function identity.guard_facility_profile_mutation() from public;
create trigger facility_profiles_guard
  before update or delete on identity.facility_profiles
  for each row execute function identity.guard_facility_profile_mutation();

-- The fields a request may set, as JSON keys (the column names). Anything
-- else is refused.
create function identity.facility_profile_editable_fields()
returns text[]
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select array['trading_name', 'ownership', 'care_level', 'address_line', 'city', 'state_code', 'lga',
    'gps_latitude', 'gps_longitude', 'phone_e164', 'email', 'bed_count', 'operating_hours', 'emergency_24h',
    'departments', 'services_offered', 'smoh_licence_number', 'has_registry_id', 'registry_id',
    'has_nhia_accreditation', 'nhia_accreditation_number', 'medical_director_name', 'medical_director_mdcn',
    'expected_staff', 'migrating_records', 'needs_interoperability']::text[]
$$;

-- A JSON object of exactly the editable fields (every one present; registry
-- and NHIA numbers may be null) as a profile row with no owner. 22023
-- FACILITY_PROFILE_INVALID for anything else; the table's checks apply at
-- insert or update.
create function identity.facility_profile_from_json(requested jsonb)
returns identity.facility_profiles
language plpgsql stable
set search_path = pg_catalog, identity, pg_temp
as $$
declare
  result identity.facility_profiles;
begin
  if requested is null or jsonb_typeof(requested) <> 'object'
     or exists (select 1 from jsonb_object_keys(requested) as field
                 where field <> all (identity.facility_profile_editable_fields()))
     or exists (select 1 from unnest(identity.facility_profile_editable_fields()) as field
                 where not requested ? field)
     or jsonb_typeof(requested -> 'departments') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'FACILITY_PROFILE_INVALID';
  end if;
  begin
    result := jsonb_populate_record(null::identity.facility_profiles, requested);
  exception when others then
    raise exception using errcode = '22023', message = 'FACILITY_PROFILE_INVALID';
  end;
  result.id := null;
  result.challenge_id := null;
  result.facility_id := null;
  result.submitter_role := null;
  result.submitter_phone_ciphertext := null;
  result.submitter_phone_key_version := null;
  result.submitter_phone_ref := null;
  result.source := null;
  result.updated_by_account_id := null;
  result.created_at := null;
  result.updated_at := null;
  result.row_version := null;
  return result;
end;
$$;
revoke all on function identity.facility_profile_from_json(jsonb) from public;

-- 3. Facility sign-up's emailed code with the profile (an 11-argument
-- signature beside 0086's 7-argument one). 0086's command runs unchanged;
-- when it sends a code, the profile and the applicant's role and encrypted
-- phone are stored with that code. An invalid profile refuses the whole
-- request (22023 FACILITY_PROFILE_INVALID) and no code is sent.
create function identity.begin_self_service_provider_enrollment(
  requested_cac_number text,
  requested_email text,
  requested_product text,
  requested_challenge_id uuid,
  requested_code_hmac char(64),
  requested_administrator_name text,
  requested_organization_type text,
  requested_profile jsonb,
  requested_submitter_role text,
  requested_submitter_phone_ciphertext bytea,
  requested_submitter_phone_key_version text
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
declare
  profile identity.facility_profiles;
  recipient text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '22023', message = 'Invalid completion request';
  end if;
  profile := identity.facility_profile_from_json(requested_profile);
  if requested_submitter_role is null
     or requested_submitter_role not in ('owner', 'medical_director', 'administrator',
       'other_authorised_representative')
     or requested_submitter_phone_ciphertext is null
     or requested_submitter_phone_key_version is null then
    raise exception using errcode = '22023', message = 'FACILITY_PROFILE_INVALID';
  end if;
  recipient := identity.begin_self_service_provider_enrollment(requested_cac_number, requested_email,
    requested_product, requested_challenge_id, requested_code_hmac, requested_administrator_name,
    requested_organization_type);
  if recipient is null then
    return null;
  end if;
  profile.id := gen_random_uuid();
  profile.challenge_id := requested_challenge_id;
  profile.submitter_role := requested_submitter_role;
  profile.submitter_phone_ciphertext := requested_submitter_phone_ciphertext;
  profile.submitter_phone_key_version := requested_submitter_phone_key_version;
  profile.submitter_phone_ref := requested_challenge_id;
  profile.source := 'self_service_signup';
  profile.created_at := clock_timestamp();
  profile.updated_at := profile.created_at;
  profile.row_version := 1;
  begin
    insert into identity.facility_profiles select profile.*;
  exception when check_violation or not_null_violation or foreign_key_violation then
    raise exception using errcode = '22023', message = 'FACILITY_PROFILE_INVALID';
  end;
  return recipient;
end;
$$;

-- 4. Activation copies the profile (both paths). The profile is the one sent
-- with the application's confirmed code that is still in force (the session
-- the self-service activation runs in), else its most recently confirmed
-- code that carried one. None (a governed application, or a sign-up made by
-- an Identity that did not send a profile): nothing is copied.
create function identity.copy_signup_profile_to_facility()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  chosen identity.facility_profiles;
begin
  if new.status <> 'approved' or old.status = 'approved' or new.facility_id is null
     or exists (select 1 from identity.facility_profiles existing where existing.facility_id = new.facility_id) then
    return null;
  end if;
  select profile.* into chosen
    from identity.facility_profiles profile
    join identity.organization_profile_completion_challenges challenge on challenge.id = profile.challenge_id
   where challenge.application_id = new.id
     and challenge.consumed_at is not null
   order by (challenge.invalidated_at is null) desc, challenge.consumed_at desc, challenge.created_at desc
   limit 1;
  if not found then
    return null;
  end if;
  chosen.id := gen_random_uuid();
  chosen.challenge_id := null;
  chosen.facility_id := new.facility_id;
  chosen.created_at := clock_timestamp();
  chosen.updated_at := chosen.created_at;
  chosen.row_version := 1;
  insert into identity.facility_profiles select chosen.*;
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    organization_id, facility_id, purpose_of_use, provenance, source_system, details
  ) values (
    coalesce(platform.current_correlation_id(), gen_random_uuid()::text), 'system',
    'identity.facility-profile.activate', 'success', 'facility', new.facility_id::text,
    new.organization_id, new.facility_id, 'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('source', 'self_service_signup', 'approvalMode', new.approval_mode)
  );
  return null;
end;
$$;
revoke all on function identity.copy_signup_profile_to_facility() from public;
create trigger organization_applications_copy_signup_profile
  after update of status on identity.organization_applications
  for each row execute function identity.copy_signup_profile_to_facility();

-- 5. The facility administrator's read and write (D8, D9).
create function identity.facility_profile_json(profile identity.facility_profiles)
returns jsonb
language sql immutable
set search_path = pg_catalog, pg_temp
as $$
  select to_jsonb(profile) - 'id' - 'challenge_id' - 'submitter_phone_ciphertext'
    - 'submitter_phone_key_version' - 'submitter_phone_ref' - 'updated_by_account_id'
    || jsonb_build_object('submitter_phone_on_record', profile.submitter_phone_ciphertext is not null)
$$;
revoke all on function identity.facility_profile_json(identity.facility_profiles) from public;

-- The X-Facility-ID facility's profile (null when it has none yet), its
-- name as Health ID has it and support's review state.
create function identity.read_facility_profile()
returns table (facility_id uuid, facility_name text, review_state text, profile_data jsonb)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor record;
  current_profile identity.facility_profiles;
begin
  select * into actor from identity.staff_management_actor(false);
  select profile.* into current_profile from identity.facility_profiles profile
   where profile.facility_id = actor.facility_id;
  return query select actor.facility_id, actor.facility_name, actor.review_state,
    case when current_profile.id is null then null else identity.facility_profile_json(current_profile) end;
end;
$$;

-- Saves the X-Facility-ID facility's profile. expected_version is the
-- profile's row_version (0 when it has none yet). Answers the new version;
-- a replay of the same key and request answers the first answer with
-- replayed true. Refusals: 42501 STAFF_MANAGEMENT_* (not the administrator
-- of a self-service facility), P0001 FACILITY_PROFILE_SEALED, 22023
-- FACILITY_PROFILE_INVALID, 40001 FACILITY_PROFILE_VERSION_CONFLICT, 23505
-- FACILITY_PROFILE_IDEMPOTENCY_CONFLICT. The audit row lists the names of
-- the fields that changed, never a value.
create function identity.set_facility_profile(
  expected_version bigint,
  requested_profile jsonb,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (facility_id uuid, row_version bigint, changed_fields text[], replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
  prior auth.admin_command_idempotency%rowtype;
  incoming identity.facility_profiles;
  current_profile identity.facility_profiles;
  saved identity.facility_profiles;
  changed text[];
  response jsonb;
begin
  select * into actor from identity.staff_management_actor(false);
  if identity.sealed_demo_facility(actor.facility_id) then
    raise exception using errcode = 'P0001', message = 'FACILITY_PROFILE_SEALED';
  end if;
  if expected_version is null or expected_version < 0
     or requested_idempotency_key is null or length(requested_idempotency_key) not between 8 and 200
     or requested_sha256 is null or requested_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'FACILITY_PROFILE_INVALID';
  end if;
  select * into prior from auth.admin_command_idempotency command
   where command.actor_account_id = actor.account_id
     and command.operation = 'facility.profile.set:' || actor.facility_id::text
     and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'FACILITY_PROFILE_IDEMPOTENCY_CONFLICT';
    end if;
    return query select actor.facility_id, (prior.response->>'version')::bigint,
      array(select jsonb_array_elements_text(prior.response->'changedFields')), true;
    return;
  end if;
  incoming := identity.facility_profile_from_json(requested_profile);
  perform 1 from identity.facilities facility where facility.id = actor.facility_id for no key update;
  select profile.* into current_profile from identity.facility_profiles profile
   where profile.facility_id = actor.facility_id for update;
  if coalesce(current_profile.row_version, 0) <> expected_version then
    raise exception using errcode = '40001', message = 'FACILITY_PROFILE_VERSION_CONFLICT';
  end if;
  begin
    if current_profile.id is null then
      incoming.id := gen_random_uuid();
      incoming.facility_id := actor.facility_id;
      incoming.source := 'facility_administrator';
      incoming.updated_by_account_id := actor.account_id;
      incoming.created_at := clock_timestamp();
      incoming.updated_at := incoming.created_at;
      incoming.row_version := 1;
      insert into identity.facility_profiles select incoming.*;
      saved := incoming;
      changed := identity.facility_profile_editable_fields();
    else
      select coalesce(array_agg(field order by field), '{}') into changed
        from unnest(identity.facility_profile_editable_fields()) as field
       where to_jsonb(incoming) -> field is distinct from to_jsonb(current_profile) -> field;
      if cardinality(changed) = 0 then
        saved := current_profile;
      else
        update identity.facility_profiles profile
           set trading_name = incoming.trading_name, ownership = incoming.ownership,
               care_level = incoming.care_level, address_line = incoming.address_line, city = incoming.city,
               state_code = incoming.state_code, lga = incoming.lga, gps_latitude = incoming.gps_latitude,
               gps_longitude = incoming.gps_longitude, phone_e164 = incoming.phone_e164, email = incoming.email,
               bed_count = incoming.bed_count, operating_hours = incoming.operating_hours,
               emergency_24h = incoming.emergency_24h, departments = incoming.departments,
               services_offered = incoming.services_offered, smoh_licence_number = incoming.smoh_licence_number,
               has_registry_id = incoming.has_registry_id, registry_id = incoming.registry_id,
               has_nhia_accreditation = incoming.has_nhia_accreditation,
               nhia_accreditation_number = incoming.nhia_accreditation_number,
               medical_director_name = incoming.medical_director_name,
               medical_director_mdcn = incoming.medical_director_mdcn, expected_staff = incoming.expected_staff,
               migrating_records = incoming.migrating_records,
               needs_interoperability = incoming.needs_interoperability,
               updated_by_account_id = actor.account_id, updated_at = clock_timestamp(),
               row_version = profile.row_version + 1
         where profile.id = current_profile.id
         returning profile.* into saved;
      end if;
    end if;
  exception when check_violation or not_null_violation or foreign_key_violation then
    raise exception using errcode = '22023', message = 'FACILITY_PROFILE_INVALID';
  end;
  response := jsonb_build_object('facilityId', actor.facility_id, 'version', saved.row_version,
    'changedFields', to_jsonb(changed));
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor.account_id, 'facility.profile.set:' || actor.facility_id::text, requested_idempotency_key,
    requested_sha256, response);
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
    actor.membership_id, actor.organization_id, actor.facility_id,
    'identity.facility-profile.set', 'success', 'facility', actor.facility_id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('changedFields', to_jsonb(changed), 'version', saved.row_version)
  );
  return query select actor.facility_id, saved.row_version, changed, false;
end;
$$;

-- 6. Patient registration at the desk (D10, D13).
-- The phone and address the desk records, and the Health ID the patient
-- states, live beside the case in identity.registration_case_contacts, not on
-- identity.registration_cases: the case's write trigger (0011) allows only a
-- reviewer's status change, and this data must stay erasable (NDPA; 0084's
-- rule: a removed contact is erased, ciphertext and key version set to null).
-- A row is written once by Identity in the transaction that creates its case;
-- afterwards its only allowed change is erasure, and it is never deleted.
create table identity.registration_case_contacts (
  registration_case_id uuid primary key references identity.registration_cases(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  phone_ciphertext bytea check (phone_ciphertext is null or octet_length(phone_ciphertext) between 30 and 2048),
  address_ciphertext bytea check (address_ciphertext is null or octet_length(address_ciphertext) between 30 and 4096),
  key_version text check (key_version is null or length(key_version) between 1 and 64),
  stated_hid_code text check (stated_hid_code is null or stated_hid_code ~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'),
  created_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  erased_at timestamptz,
  erasure_reason text check (erasure_reason is null or erasure_reason in ('account_deleted', 'erasure_request')),
  constraint registration_case_contacts_state_ck check (
    (erased_at is null and erasure_reason is null and phone_ciphertext is not null
      and address_ciphertext is not null and key_version is not null)
    or (erased_at is not null and erasure_reason is not null and phone_ciphertext is null
      and address_ciphertext is null and key_version is null and stated_hid_code is null))
);

-- The only change either contact table allows: erasure (the erasable columns
-- become null, erased_at and erasure_reason are set, once), and for a case
-- contact the removal of its stated Health ID alone. Never deleted.
-- TG_ARGV lists the erasable columns.
create function identity.guard_facility_contact_erasure()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'A facility-held contact is never deleted; erase it instead';
  end if;
  -- A case contact may also lose only its stated Health ID, when the patient
  -- that Health ID names has their contacts erased; the rest of the row stays.
  if tg_table_name = 'registration_case_contacts'
     and old.erased_at is null and new.erased_at is null
     and (to_jsonb(old) ->> 'stated_hid_code') is not null and (to_jsonb(new) ->> 'stated_hid_code') is null
     and (to_jsonb(new) - 'stated_hid_code') = (to_jsonb(old) - 'stated_hid_code') then
    return new;
  end if;
  if old.erased_at is not null or new.erased_at is null
     or (to_jsonb(new) - tg_argv) is distinct from (to_jsonb(old) - tg_argv) then
    raise exception using errcode = '42501', message = 'A facility-held contact can only be erased';
  end if;
  return new;
end;
$$;
revoke all on function identity.guard_facility_contact_erasure() from public;
create trigger registration_case_contacts_erasure_only
  before update or delete on identity.registration_case_contacts
  for each row execute function identity.guard_facility_contact_erasure(
    'phone_ciphertext', 'address_ciphertext', 'key_version', 'stated_hid_code', 'erased_at', 'erasure_reason');
alter table identity.registration_case_contacts enable row level security;
alter table identity.registration_case_contacts force row level security;
create policy registration_case_contacts_staff_read on identity.registration_case_contacts
  for select using (
    facility_id = platform.current_facility_id()
    and (
      auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
        facility_id, 'identity.registration.write')
      or auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
        facility_id, 'identity.registration.approve')
    )
  );
-- Only the desk member who created the case, at its facility, while the case
-- has not yet been reviewed.
create policy registration_case_contacts_staff_create on identity.registration_case_contacts
  for insert with check (
    facility_id = platform.current_facility_id()
    and erased_at is null
    and created_by_membership_id = platform.current_membership_id()
    and created_by_account_id = auth.account_id_for_subject(platform.current_actor_subject())
    and auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
      facility_id, 'identity.registration.write')
    and exists (
      select 1 from identity.registration_cases registration
       where registration.id = registration_case_contacts.registration_case_id
         and registration.facility_id = registration_case_contacts.facility_id
         and registration.created_by_membership_id = registration_case_contacts.created_by_membership_id
         and registration.created_by_account_id = registration_case_contacts.created_by_account_id
         and registration.reviewed_by_account_id is null
    )
  );
revoke all on identity.registration_case_contacts from public;
-- Erasure finds the cases that stated a patient's Health ID.
create index registration_case_contacts_stated_hid_idx on identity.registration_case_contacts (stated_hid_code)
  where stated_hid_code is not null;

-- The facility-held, unverified contact of a registered patient: the copy of
-- the case's encrypted phone and address (ciphertext bound by Identity to
-- identity:registration-case:<case id>:phone|address), written once when the
-- case resolves to a patient. Never used for sign-in or recovery. Erasable
-- like the case's row; never deleted.
create table identity.patient_facility_contacts (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  registration_case_id uuid not null unique
    references identity.registration_case_contacts(registration_case_id) on delete restrict,
  phone_ciphertext bytea check (phone_ciphertext is null or octet_length(phone_ciphertext) between 30 and 2048),
  address_ciphertext bytea check (address_ciphertext is null or octet_length(address_ciphertext) between 30 and 4096),
  key_version text check (key_version is null or length(key_version) between 1 and 64),
  source text not null default 'staff_registration' check (source = 'staff_registration'),
  verification_status text not null default 'unverified' check (verification_status = 'unverified'),
  created_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  erased_at timestamptz,
  erasure_reason text check (erasure_reason is null or erasure_reason in ('account_deleted', 'erasure_request')),
  constraint patient_facility_contacts_state_ck check (
    (erased_at is null and erasure_reason is null and phone_ciphertext is not null
      and address_ciphertext is not null and key_version is not null)
    or (erased_at is not null and erasure_reason is not null and phone_ciphertext is null
      and address_ciphertext is null and key_version is null))
);
create index patient_facility_contacts_patient_idx on identity.patient_facility_contacts (patient_id, facility_id);
create trigger patient_facility_contacts_erasure_only
  before update or delete on identity.patient_facility_contacts
  for each row execute function identity.guard_facility_contact_erasure(
    'phone_ciphertext', 'address_ciphertext', 'key_version', 'erased_at', 'erasure_reason');
alter table identity.patient_facility_contacts enable row level security;
alter table identity.patient_facility_contacts force row level security;
create policy patient_facility_contacts_staff_read on identity.patient_facility_contacts
  for select using (
    facility_id = platform.current_facility_id()
    and (
      auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
        facility_id, 'identity.registration.write')
      or auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
        facility_id, 'identity.registration.approve')
    )
  );
create policy patient_facility_contacts_staff_create on identity.patient_facility_contacts
  for insert with check (
    facility_id = platform.current_facility_id()
    and erased_at is null
    and created_by_membership_id = platform.current_membership_id()
    and created_by_account_id = auth.account_id_for_subject(platform.current_actor_subject())
    and (
      auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
        facility_id, 'identity.registration.write')
      or auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
        facility_id, 'identity.registration.approve')
    )
    and exists (
      select 1 from identity.registration_cases registration
        join identity.registration_case_contacts contact on contact.registration_case_id = registration.id
       where registration.id = patient_facility_contacts.registration_case_id
         and registration.facility_id = patient_facility_contacts.facility_id
         and registration.resolved_patient_id = patient_facility_contacts.patient_id
         and contact.facility_id = patient_facility_contacts.facility_id
         and contact.erased_at is null
         and contact.phone_ciphertext = patient_facility_contacts.phone_ciphertext
         and contact.address_ciphertext = patient_facility_contacts.address_ciphertext
         and contact.key_version = patient_facility_contacts.key_version
    )
  );
revoke all on identity.patient_facility_contacts from public;

-- Erasure (NDPA). Only the owner of these tables (the applier) may erase, as
-- 0084's erasure runs as its owner. The two owner policies below follow the
-- table's owner at the time of each statement (not the role that applied
-- this migration), and no runtime role holds UPDATE on either table.
create policy registration_case_contacts_owner on identity.registration_case_contacts
  for all using (pg_catalog.pg_has_role((select relation.relowner from pg_catalog.pg_class relation
                   where relation.oid = 'identity.registration_case_contacts'::pg_catalog.regclass), 'USAGE'))
  with check (pg_catalog.pg_has_role((select relation.relowner from pg_catalog.pg_class relation
                   where relation.oid = 'identity.registration_case_contacts'::pg_catalog.regclass), 'USAGE'));
create policy patient_facility_contacts_owner on identity.patient_facility_contacts
  for all using (pg_catalog.pg_has_role((select relation.relowner from pg_catalog.pg_class relation
                   where relation.oid = 'identity.patient_facility_contacts'::pg_catalog.regclass), 'USAGE'))
  with check (pg_catalog.pg_has_role((select relation.relowner from pg_catalog.pg_class relation
                   where relation.oid = 'identity.patient_facility_contacts'::pg_catalog.regclass), 'USAGE'));

-- The erasure functions run as their owner. If that is not (a member of) the
-- owner of both contact tables (an owner changed later), they refuse, so an
-- erasure never reports nothing erased while the contacts stay.
create function identity.assert_facility_contact_eraser()
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if not pg_catalog.pg_has_role((select relation.relowner from pg_catalog.pg_class relation
           where relation.oid = 'identity.registration_case_contacts'::pg_catalog.regclass), 'USAGE')
     or not pg_catalog.pg_has_role((select relation.relowner from pg_catalog.pg_class relation
           where relation.oid = 'identity.patient_facility_contacts'::pg_catalog.regclass), 'USAGE') then
    raise exception using errcode = '42501',
      message = 'Facility-held contacts can only be erased by the owner of their tables';
  end if;
end;
$$;
revoke all on function identity.assert_facility_contact_eraser() from public;

-- identity.erase_patient_facility_contacts erases every facility's copy of a
-- patient's phone and address (patient_facility_contacts) and what the desk
-- recorded on the cases that were copied to the patient
-- (registration_case_contacts, the stated Health ID included). It also
-- removes the patient's Health ID (current or earlier) from any other case
-- that stated it, for example by a typo; that person's own phone and address
-- stay. Every path that resolves a case to a patient writes the copy in the
-- same transaction (resolved at once, approved new, linked existing), so the
-- copies find every such case; identity.registration_cases is not read (its
-- row-level security is forced and 0114 adds no policy to it). Called by the
-- account-deletion trigger below ('account_deleted') and, for an NDPA
-- erasure request, by Health ID support through the owner
-- ('erasure_request'). Never granted to a runtime role. Its audit row holds
-- only the counts.
create function identity.erase_patient_facility_contacts(requested_patient_id uuid, requested_reason text)
returns table (facility_contacts integer, registration_contacts integer, stated_health_ids integer)
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  erased_facility integer;
  erased_registration integer;
  removed_stated integer;
  erased_moment timestamptz := clock_timestamp();
  patient_hid_codes text[];
begin
  if requested_patient_id is null or requested_reason is null
     or requested_reason not in ('account_deleted', 'erasure_request') then
    raise exception using errcode = '22023', message = 'Invalid contact erasure request';
  end if;
  perform identity.assert_facility_contact_eraser();
  update identity.registration_case_contacts contact
     set phone_ciphertext = null, address_ciphertext = null, key_version = null, stated_hid_code = null,
         erased_at = erased_moment, erasure_reason = requested_reason
   where contact.erased_at is null
     and contact.registration_case_id in (
       select copied.registration_case_id from identity.patient_facility_contacts copied
        where copied.patient_id = requested_patient_id);
  get diagnostics erased_registration = row_count;
  update identity.patient_facility_contacts copied
     set phone_ciphertext = null, address_ciphertext = null, key_version = null,
         erased_at = erased_moment, erasure_reason = requested_reason
   where copied.patient_id = requested_patient_id and copied.erased_at is null;
  get diagnostics erased_facility = row_count;
  select coalesce(array_agg(distinct code), '{}'::text[]) into patient_hid_codes
    from (
      select upper(patient.hid_code) as code from identity.patients patient where patient.id = requested_patient_id
      union all
      select upper(identifier.public_value) from identity.patient_identifiers identifier
       where identifier.patient_id = requested_patient_id and identifier.identifier_type = 'hid_code'
         and identifier.public_value is not null
    ) codes;
  update identity.registration_case_contacts contact
     set stated_hid_code = null
   where contact.erased_at is null and contact.stated_hid_code = any (patient_hid_codes);
  get diagnostics removed_stated = row_count;
  insert into audit.events (
    correlation_id, actor_type, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    coalesce(platform.current_correlation_id(), gen_random_uuid()::text), 'system', requested_patient_id,
    'identity.patient-facility-contact.erase', 'success', 'patient', requested_patient_id::text,
    case when requested_reason = 'account_deleted' then 'patient-self' else 'healthcare-operations' end,
    'application', 'identity-api',
    jsonb_build_object('reason', requested_reason, 'facilityContacts', erased_facility,
      'registrationContacts', erased_registration, 'statedHealthIds', removed_stated)
  );
  return query select erased_facility, erased_registration, removed_stated;
end;
$$;
revoke all on function identity.erase_patient_facility_contacts(uuid, text) from public;

-- identity.erase_registration_case_contact erases one case's contact by case:
-- for a case that never became a patient (rejected, cancelled or never
-- reviewed), which no patient erasure reaches. It also erases that case's
-- facility copy, if one exists. Only for an NDPA erasure request
-- ('erasure_request'), run by Health ID support through the owner. Never
-- granted to a runtime role. Its audit row holds only the counts.
create function identity.erase_registration_case_contact(requested_case_id uuid, requested_reason text)
returns table (facility_contacts integer, registration_contacts integer)
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  erased_facility integer;
  erased_registration integer;
  erased_moment timestamptz := clock_timestamp();
  case_facility uuid;
  case_patient uuid;
begin
  if requested_case_id is null or requested_reason is distinct from 'erasure_request' then
    raise exception using errcode = '22023', message = 'Invalid contact erasure request';
  end if;
  perform identity.assert_facility_contact_eraser();
  select contact.facility_id into case_facility from identity.registration_case_contacts contact
   where contact.registration_case_id = requested_case_id;
  select copied.patient_id into case_patient from identity.patient_facility_contacts copied
   where copied.registration_case_id = requested_case_id;
  update identity.patient_facility_contacts copied
     set phone_ciphertext = null, address_ciphertext = null, key_version = null,
         erased_at = erased_moment, erasure_reason = requested_reason
   where copied.registration_case_id = requested_case_id and copied.erased_at is null;
  get diagnostics erased_facility = row_count;
  update identity.registration_case_contacts contact
     set phone_ciphertext = null, address_ciphertext = null, key_version = null, stated_hid_code = null,
         erased_at = erased_moment, erasure_reason = requested_reason
   where contact.registration_case_id = requested_case_id and contact.erased_at is null;
  get diagnostics erased_registration = row_count;
  insert into audit.events (
    correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    coalesce(platform.current_correlation_id(), gen_random_uuid()::text), 'system', case_facility, case_patient,
    'identity.registration-case-contact.erase', 'success', 'registration-case', requested_case_id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('reason', requested_reason, 'facilityContacts', erased_facility,
      'registrationContacts', erased_registration)
  );
  return query select erased_facility, erased_registration;
end;
$$;
revoke all on function identity.erase_registration_case_contact(uuid, text) from public;

-- Account deletion (0096) erases them when it completes, as it erases the
-- patient's emergency contacts. No 0096 function body is replaced.
create function identity.erase_facility_contacts_on_account_deletion()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, identity, pg_temp
as $$
begin
  if new.state = 'completed' and old.state is distinct from 'completed' then
    perform identity.erase_patient_facility_contacts(new.patient_id, 'account_deleted');
  end if;
  return null;
end;
$$;
revoke all on function identity.erase_facility_contacts_on_account_deletion() from public;
create trigger patient_account_deletion_requests_erase_facility_contacts
  after update of state on identity.patient_account_deletion_requests
  for each row execute function identity.erase_facility_contacts_on_account_deletion();

-- 7. Grants (as runtime-grants.sql makes them for a role bootstrap).
revoke all on function identity.facility_department_codes(),
  identity.facility_departments_valid(text[]),
  identity.facility_profile_editable_fields(),
  identity.begin_self_service_provider_enrollment(text,text,text,uuid,char,text,text,jsonb,text,bytea,text),
  identity.read_facility_profile(),
  identity.set_facility_profile(bigint,jsonb,text,char)
  from public;
do $$
declare grantee text;
begin
  foreach grantee in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant select on identity.nigeria_states to %I', grantee);
      execute format('grant select, insert on identity.registration_case_contacts to %I', grantee);
      execute format('grant select, insert on identity.patient_facility_contacts to %I', grantee);
      execute format('grant execute on function '
        || 'identity.begin_self_service_provider_enrollment(text,text,text,uuid,char,text,text,jsonb,text,bytea,text), '
        || 'identity.read_facility_profile(), '
        || 'identity.set_facility_profile(bigint,jsonb,text,char) to %I', grantee);
    end if;
  end loop;
end
$$;

comment on table identity.facility_profiles is
  '0114: a facility''s profile (sign-up and setup wizard fields); before activation, the one sent with an emailed sign-up code. Not shown publicly (D2).';
comment on table identity.registration_case_contacts is
  '0114: the phone and address a registration desk recorded for a case (encrypted) and the Health ID the patient stated; written once, erasable, never deleted.';
comment on table identity.patient_facility_contacts is
  '0114: a patient''s phone and address as a facility''s registration desk recorded them (encrypted, unverified, facility-held); never used for sign-in or recovery; erased on account deletion or an erasure request.';
comment on function identity.erase_patient_facility_contacts(uuid, text) is
  '0114: owner-only NDPA erasure of every facility-held contact of a patient (account deletion or an erasure request), and removal of the patient''s Health ID from other cases that stated it; audited with counts only.';
comment on function identity.erase_registration_case_contact(uuid, text) is
  '0114: owner-only NDPA erasure of one registration case''s contact and its facility copy, for a case that never became a patient (erasure request); audited with counts only.';
comment on function identity.begin_self_service_provider_enrollment(text,text,text,uuid,char,text,text,jsonb,text,bytea,text) is
  '0114: 0086''s facility sign-up code, with the facility profile and the applicant''s role and encrypted phone stored with the code it sends.';
comment on function identity.read_facility_profile() is
  '0114: the facility administrator''s read of the X-Facility-ID facility''s profile (workforce.manage, self-service facility).';
comment on function identity.set_facility_profile(bigint,jsonb,text,char) is
  '0114: the facility administrator saves the X-Facility-ID facility''s profile (If-Match row_version, Idempotency-Key); audited with field names only.';
