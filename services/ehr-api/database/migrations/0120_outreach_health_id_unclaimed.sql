-- Health IDs created at an outreach for people with no contact (owner,
-- 2026-11-13: "make room for if none of it unavailable sms/mail and count all
-- registers to our users"). The number 0120 is a placeholder; it releases
-- right after 0119 (assisted Health ID by email), which it extends.
--
-- WHAT IT DOES
--   * identity.outreach_registration_health_ids (0119) gains created_via
--     ('email' for 0119's path, the default; 'unclaimed' for this one) and
--     possible_duplicate; account_id and challenge_id may be null, and are
--     null exactly for an unclaimed Health ID.
--   * identity.outreach_health_id_claims: the one-time claim code of such a
--     Health ID, as a keyed HMAC only (the code is shown once on the slip),
--     valid 180 days, 5 attempts. Owner-only.
--   * identity.outreach_health_id_create_unclaimed(...): for the Identity
--     runtime in the volunteer's delegated session, with every guard of
--     0119's path (campaign membership, not redacted, not sealed demo or QA,
--     not suspended, 18 or over, one Health ID per registration). Creates the
--     patient (name, sex, phone if any; no date of birth) and its Health ID,
--     with NO account and no contact-verified assurance: nobody can sign in
--     until the person claims it. A phone already on a Health ID is refused;
--     with no phone, a same name and sex is flagged for review, never refused.
--   * identity.outreach_health_id_counts(): Health IDs created at outreach,
--     by email or unclaimed, not yet claimed, and flagged (counts only), for
--     the platform admin.
--   * identity.outreach_registration_health_ids_for(cases) also answers
--     created_via.
--   The claim itself (the person proves their own email; the account is
--   created then) and the duplicate review come after the campaign.
--
-- DATA PROTECTION
--   A Health ID with no verified contact holds the registration's name, sex
--   and phone (if any). The claim code is never stored, logged or audited;
--   audit rows carry ids and flags only.

-- 0. Preconditions.
do $$
begin
  if to_regclass('identity.outreach_registration_health_ids') is null
     or to_regprocedure('identity.outreach_health_id_registration(uuid)') is null
     or to_regprocedure('identity.outreach_health_id_eligible(uuid)') is null
     or to_regprocedure('identity.outreach_registration_health_ids_for(uuid[])') is null then
    raise exception using errcode = '55000', message = '0120: 0119 must be applied first';
  end if;
  if to_regclass('identity.outreach_health_id_claims') is not null
     or exists (select 1 from pg_attribute where attrelid = 'identity.outreach_registration_health_ids'::regclass
                 and attname = 'created_via' and not attisdropped) then
    raise exception using errcode = '55000', message = '0120: already applied';
  end if;
end
$$;

-- 1. The record of a Health ID created at outreach.
alter table identity.outreach_registration_health_ids
  alter column account_id drop not null,
  alter column challenge_id drop not null,
  add column created_via text not null default 'email' check (created_via in ('email', 'unclaimed')),
  add column possible_duplicate boolean not null default false,
  add constraint outreach_registration_health_ids_email_ck
    check ((created_via = 'email') = (account_id is not null and challenge_id is not null)),
  add constraint outreach_registration_health_ids_unclaimed_ck
    check ((created_via = 'unclaimed') = (account_id is null and challenge_id is null));
comment on column identity.outreach_registration_health_ids.created_via is
  '0120: email (0119: the person proved an email; the account exists) or unclaimed (no contact; no account until claimed).';
comment on column identity.outreach_registration_health_ids.possible_duplicate is
  '0120: unclaimed with no phone, and an active patient had the same name and sex: for review later; never refused.';

-- 2. Claim codes.
-- The one-time claim code of a Health ID created with no contact (keyed HMAC
-- only; the code itself is shown once and never stored).
create table identity.outreach_health_id_claims (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  registration_case_id uuid not null unique
    references identity.outreach_registration_health_ids(registration_case_id) on delete restrict,
  code_hmac char(64) not null unique check (code_hmac ~ '^[0-9a-f]{64}$'),
  code_key_version text not null check (length(code_key_version) between 1 and 64),
  expires_at timestamptz not null,
  failed_attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  claimed_at timestamptz,
  claimed_account_id uuid unique references auth.accounts(id) on delete restrict,
  invalidated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (failed_attempts between 0 and max_attempts),
  check ((claimed_at is null) = (claimed_account_id is null)),
  check (not (claimed_at is not null and invalidated_at is not null))
);
comment on table identity.outreach_health_id_claims is
  '0120: the claim code (keyed HMAC only) of a Health ID created at an outreach with no contact: valid 180 days, attempt-limited. The claim itself (the person proves their own email; the account is created then) comes after the campaign. Owner-only.';

alter table identity.outreach_health_id_claims enable row level security;
alter table identity.outreach_health_id_claims force row level security;

-- 3. No contact at all: a Health ID the person claims later.
create function identity.outreach_health_id_create_unclaimed(
  requested_case_id uuid, requested_hid text, requested_phone_ciphertext bytea, requested_phone_lookup_hmac char(64),
  requested_key_version text, requested_claim_code_hmac char(64), requested_claim_key_version text
) returns table (hid_code text, patient_id uuid, claim_expires_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  registration record;
  new_patient uuid := gen_random_uuid();
  first_name_value text;
  last_name_value text;
  duplicate_flag boolean := false;
  claim_expiry timestamptz := clock_timestamp() + interval '180 days';
begin
  select * into registration from identity.outreach_health_id_registration(requested_case_id);
  perform pg_advisory_xact_lock(hashtextextended('outreach-health-id:' || requested_case_id::text, 0));
  perform identity.outreach_health_id_eligible(requested_case_id);
  if requested_hid is null or requested_hid !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'
     or (registration.phone is null) <> (requested_phone_lookup_hmac is null)
     or (requested_phone_ciphertext is null) <> (requested_phone_lookup_hmac is null)
     or coalesce(requested_phone_lookup_hmac, repeat('0', 64)) !~ '^[0-9a-f]{64}$'
     or (requested_phone_lookup_hmac is not null and coalesce(length(requested_key_version), 0) not between 1 and 64)
     or coalesce(requested_claim_code_hmac, '') !~ '^[0-9a-f]{64}$'
     or coalesce(length(requested_claim_key_version), 0) not between 1 and 64 then
    raise exception using errcode = '22023', message = 'OUTREACH_HEALTH_ID_REQUEST_INVALID';
  end if;
  if requested_phone_lookup_hmac is not null then
    perform pg_advisory_xact_lock(hashtextextended('patient-contact:phone:' || requested_phone_lookup_hmac, 0));
    if exists (select 1 from identity.patients patient where patient.phone_lookup_hmac = requested_phone_lookup_hmac) then
      raise exception using errcode = '23505', message = 'OUTREACH_HEALTH_ID_PHONE_TAKEN';
    end if;
  else
    -- Nothing to check a duplicate person against: flag a same name and sex
    -- for review later; never refuse on it.
    duplicate_flag := exists (select 1 from identity.patients patient
      where lower(patient.full_name) = lower(btrim(registration.full_name))
        and patient.gender is not distinct from registration.sex and patient.status = 'active');
  end if;
  first_name_value := split_part(btrim(registration.full_name), ' ', 1);
  last_name_value := coalesce(nullif(btrim(substr(btrim(registration.full_name), length(first_name_value) + 1)), ''),
    first_name_value);
  -- No account: nobody can sign in to this Health ID until it is claimed.
  insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob,
    phone_e164_ciphertext, phone_lookup_hmac, contact_key_version, source_system, status)
  values (new_patient, null, requested_hid, first_name_value, last_name_value, btrim(registration.full_name),
    registration.sex, null, requested_phone_ciphertext, requested_phone_lookup_hmac,
    case when requested_phone_lookup_hmac is not null then requested_key_version end, 'hid-outreach-health-id', 'active');
  insert into identity.patient_identifiers (id, patient_id, identifier_type, public_value, verified, source_system)
  values (gen_random_uuid(), new_patient, 'hid_code', requested_hid, true, 'hid-outreach-health-id');
  insert into identity.outreach_registration_health_ids (registration_case_id, facility_id, patient_id, account_id,
    hid_code, challenge_id, created_via, possible_duplicate, created_by_account_id, created_by_membership_id)
  values (requested_case_id, registration.facility_id, new_patient, null, requested_hid, null, 'unclaimed',
    duplicate_flag, platform.current_account_id(), platform.current_membership_id());
  insert into identity.outreach_health_id_claims (patient_id, registration_case_id, code_hmac, code_key_version,
    expires_at)
  values (new_patient, requested_case_id, requested_claim_code_hmac, requested_claim_key_version, claim_expiry);
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system,
    details)
  values (platform.current_correlation_id(), 'staff', platform.current_actor_subject(), platform.current_account_id(),
    platform.current_membership_id(), registration.facility_id, new_patient, 'outreach.health-id.created-unclaimed',
    'success', 'outreach-registration-case', requested_case_id::text, 'direct-care', 'application', 'identity-api',
    jsonb_build_object('channel', 'none', 'phoneOnRecord', requested_phone_lookup_hmac is not null,
      'possibleDuplicate', duplicate_flag));
  return query select requested_hid, new_patient, claim_expiry;
end
$$;

comment on function identity.outreach_health_id_create_unclaimed(uuid,text,bytea,char,text,char,text) is
  '0120: creates a Health ID from an outreach registration for a person with no email (and possibly no phone): the patient (name, sex, phone if any; no date of birth), its Health ID identifier, the registration''s Health ID record (created_via unclaimed, possible_duplicate when there is no phone and an active patient has the same name and sex) and the claim code''s keyed HMAC (180 days, 5 attempts). No account and no contact-verified assurance: nobody can sign in until it is claimed. One audit row (ids and flags only). Refuses as identity.outreach_health_id_eligible does (incl. 23505 OUTREACH_HEALTH_ID_ALREADY_CREATED with the Health ID in detail, never the claim code), 23505 OUTREACH_HEALTH_ID_PHONE_TAKEN, 22023 OUTREACH_HEALTH_ID_REQUEST_INVALID.';

-- 4. Counts for the platform admin (users created at outreach).
create function identity.outreach_health_id_counts()
returns table (created_at_outreach bigint, created_with_email bigint, created_unclaimed bigint,
  unclaimed_not_yet_claimed bigint, possible_duplicates bigint)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select count(*), count(*) filter (where link.created_via = 'email'), count(*) filter (where link.created_via = 'unclaimed'),
    count(*) filter (where link.created_via = 'unclaimed' and not exists (select 1 from identity.outreach_health_id_claims claim
      where claim.registration_case_id = link.registration_case_id and claim.claimed_at is not null)),
    count(*) filter (where link.possible_duplicate)
    from identity.outreach_registration_health_ids link
$$;

comment on function identity.outreach_health_id_counts() is
  '0120: counts of Health IDs created at outreach (with a verified email; with no contact; of those, not yet claimed; flagged as a possible duplicate). Counts only. Identity runtime; the route checks the platform-admin permission.';

-- 5. For outreach-api (replaces 0119's, adding created_via): the Health IDs created for registrations the session can see.
drop function identity.outreach_registration_health_ids_for(uuid[]);
create function identity.outreach_registration_health_ids_for(requested_case_ids uuid[])
returns table (registration_case_id uuid, hid_code text, created_via text)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select link.registration_case_id, link.hid_code, link.created_via
    from identity.outreach_registration_health_ids link
   where link.registration_case_id = any(requested_case_ids)
     and cardinality(requested_case_ids) <= 500
     and link.facility_id = platform.current_facility_id()
     and exists (select 1 from outreach.registration_cases case_row where case_row.id = link.registration_case_id
                  and case_row.facility_id = link.facility_id
                  and outreach.registration_campaign_member(case_row.campaign_id, case_row.facility_id))
$$;

comment on function identity.outreach_registration_health_ids_for(uuid[]) is
  '0119, 0120: for the Outreach runtime, the Health IDs created at outreach, how (created_via email or unclaimed), for up to 500 registrations at the session facility that the session can see (the registration''s facility and campaign membership, checked here and by its row-level security).';

-- 6. Owners, policies, ACLs.
do $$
declare
  owner_name name := (select pg_get_userbyid(relowner) from pg_class where oid = 'identity.patients'::regclass);
begin
  execute format('create policy outreach_health_id_claims_owner on identity.outreach_health_id_claims '
    || 'for all to %I using (true) with check (true)', owner_name);
end
$$;

revoke all on identity.outreach_health_id_claims from public;
revoke all on function identity.outreach_health_id_create_unclaimed(uuid,text,bytea,char,text,char,text),
  identity.outreach_health_id_counts(), identity.outreach_registration_health_ids_for(uuid[]) from public;

-- Grants (here and in runtime-grants.sql).
do $$
declare
  role_name text;
begin
  foreach role_name in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant execute on function '
        || 'identity.outreach_health_id_create_unclaimed(uuid,text,bytea,char,text,char,text), '
        || 'identity.outreach_health_id_counts() to %I', role_name);
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
              and has_table_privilege(role_row.oid, 'identity.outreach_health_id_claims', 'SELECT,INSERT,UPDATE,DELETE')) then
    raise exception using errcode = '55000', message = '0120: a runtime role holds a privilege on the claims it must not';
  end if;
  if exists (select 1 from identity.outreach_registration_health_ids where created_via <> 'email') then
    raise exception using errcode = '55000', message = '0120: an existing record is not an email one';
  end if;
end
$$;
