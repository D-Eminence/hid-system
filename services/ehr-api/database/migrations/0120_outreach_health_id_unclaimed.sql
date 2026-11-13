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
--     valid 180 days, 5 attempts, with the OTP key version it was keyed with;
--     and the registration's phone, which nobody proved: it is kept here, not
--     on the patient, so it never blocks the number's real owner from signing
--     up. The claim moves it onto the patient only if it is still free.
--     Owner-only.
--   * identity.outreach_health_id_create_unclaimed(...): for the Identity
--     runtime in the volunteer's delegated session, with every guard of
--     0119's path (campaign membership, not redacted, not sealed demo or QA,
--     not suspended, 18 or over, one Health ID per registration). Creates the
--     patient (name and sex; no contact, no date of birth) and its Health
--     ID, with NO account and no contact-verified assurance: nobody can sign
--     in until the person claims it. A phone already on a real patient is
--     refused; one already on another live unclaimed Health ID's claim, or (with no phone)
--     a same name and sex, is flagged for review, never refused.
--   * identity.outreach_health_id_counts(): Health IDs created at outreach,
--     by email or unclaimed, not yet claimed, and flagged (counts only), for
--     a platform administrator (checked in the function).
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
     or to_regprocedure('identity.outreach_registration_health_ids_for(uuid[])') is null
     or to_regprocedure('auth.account_has_platform_permission(uuid,text)') is null then
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
  '0120: unclaimed, and either its phone is on another live (unexpired, not out of attempts) unclaimed Health ID''s claim or (with no phone) an active patient had the same name and sex: for review later; never refused.';

-- 2. Claim codes.
-- The one-time claim code of a Health ID created with no contact (keyed HMAC
-- only; the code itself is shown once and never stored).
create table identity.outreach_health_id_claims (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  registration_case_id uuid not null unique
    references identity.outreach_registration_health_ids(registration_case_id) on delete restrict,
  code_hmac char(64) not null unique check (code_hmac ~ '^[0-9a-f]{64}$'),
  code_key_version text not null check (length(code_key_version) between 1 and 64),
  -- The OTP key version the HMAC was keyed with: the claim flow verifies with
  -- that version's key, so it must not be retired while a code is valid.
  hmac_key_version text not null check (length(hmac_key_version) between 1 and 64),
  -- The registration's phone, typed by the volunteer and never proven: kept
  -- here, not on the patient, so it never blocks the number's real owner from
  -- signing up. The claim moves it onto the patient only if it is still free.
  phone_e164_ciphertext bytea,
  phone_lookup_hmac char(64) check (phone_lookup_hmac ~ '^[0-9a-f]{64}$'),
  contact_key_version text check (length(contact_key_version) between 1 and 64),
  expires_at timestamptz not null,
  failed_attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  claimed_at timestamptz,
  claimed_account_id uuid unique references auth.accounts(id) on delete restrict,
  invalidated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (failed_attempts between 0 and max_attempts),
  check ((claimed_at is null) = (claimed_account_id is null)),
  check (not (claimed_at is not null and invalidated_at is not null)),
  check ((phone_e164_ciphertext is null) = (phone_lookup_hmac is null)),
  check ((phone_lookup_hmac is null) = (contact_key_version is null))
);
create index outreach_health_id_claims_phone_idx on identity.outreach_health_id_claims (phone_lookup_hmac)
  where phone_lookup_hmac is not null;
comment on table identity.outreach_health_id_claims is
  '0120: the claim code (keyed HMAC only) of a Health ID created at an outreach with no contact: valid 180 days, attempt-limited. The claim itself (the person proves their own email; the account is created then) comes after the campaign. Owner-only.';

alter table identity.outreach_health_id_claims enable row level security;
alter table identity.outreach_health_id_claims force row level security;

-- 3. No contact at all: a Health ID the person claims later.
create function identity.outreach_health_id_create_unclaimed(
  requested_case_id uuid, requested_hid text, requested_phone_ciphertext bytea, requested_phone_lookup_hmac char(64),
  requested_key_version text, requested_claim_code_hmac char(64), requested_claim_key_version text,
  requested_hmac_key_version text
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
  clean_name text;
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
     or coalesce(length(requested_claim_key_version), 0) not between 1 and 64
     or coalesce(length(requested_hmac_key_version), 0) not between 1 and 64 then
    raise exception using errcode = '22023', message = 'OUTREACH_HEALTH_ID_REQUEST_INVALID';
  end if;
  if requested_phone_lookup_hmac is not null then
    perform pg_advisory_xact_lock(hashtextextended('patient-contact:phone:' || requested_phone_lookup_hmac, 0));
    -- On a real patient: refused, as before. Only on another unclaimed
    -- Health ID (never proven): flagged for review, never refused.
    if exists (select 1 from identity.patients patient where patient.phone_lookup_hmac = requested_phone_lookup_hmac) then
      raise exception using errcode = '23505', message = 'OUTREACH_HEALTH_ID_PHONE_TAKEN';
    end if;
    duplicate_flag := exists (select 1 from identity.outreach_health_id_claims claim
      where claim.phone_lookup_hmac = requested_phone_lookup_hmac and claim.claimed_at is null
        and claim.invalidated_at is null and claim.expires_at > clock_timestamp()
        and claim.failed_attempts < claim.max_attempts);
  else
    -- Nothing to check a duplicate person against: flag a same name and sex
    -- for review later; never refuse on it.
    duplicate_flag := exists (select 1 from identity.patients patient
      where lower(patient.full_name) = lower(left(btrim(regexp_replace(regexp_replace(registration.full_name,
              '[[:cntrl:]]', ' ', 'g'), '[[:space:]]+', ' ', 'g')), 200))
        and patient.gender is not distinct from registration.sex and patient.status = 'active');
  end if;
  -- Names as patient sign-up allows them (as 0119's confirmation does).
  clean_name := left(btrim(regexp_replace(regexp_replace(registration.full_name, '[[:cntrl:]]', ' ', 'g'),
    '[[:space:]]+', ' ', 'g')), 200);
  if clean_name = '' then
    raise exception using errcode = '23514', message = 'OUTREACH_HEALTH_ID_NAME_INVALID';
  end if;
  first_name_value := left(split_part(clean_name, ' ', 1), 80);
  last_name_value := left(coalesce(nullif(btrim(substr(clean_name, length(split_part(clean_name, ' ', 1)) + 1)), ''),
    first_name_value), 80);
  -- No account (nobody can sign in until it is claimed) and no contact: the
  -- unproven phone stays on the claim.
  insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob,
    source_system, status)
  values (new_patient, null, requested_hid, first_name_value, last_name_value, clean_name,
    registration.sex, null, 'hid-outreach-health-id', 'active');
  insert into identity.patient_identifiers (id, patient_id, identifier_type, public_value, verified, source_system)
  values (gen_random_uuid(), new_patient, 'hid_code', requested_hid, true, 'hid-outreach-health-id');
  insert into identity.outreach_registration_health_ids (registration_case_id, facility_id, patient_id, account_id,
    hid_code, challenge_id, created_via, possible_duplicate, created_by_account_id, created_by_membership_id)
  values (requested_case_id, registration.facility_id, new_patient, null, requested_hid, null, 'unclaimed',
    duplicate_flag, platform.current_account_id(), platform.current_membership_id());
  insert into identity.outreach_health_id_claims (patient_id, registration_case_id, code_hmac, code_key_version,
    hmac_key_version, phone_e164_ciphertext, phone_lookup_hmac, contact_key_version, expires_at)
  values (new_patient, requested_case_id, requested_claim_code_hmac, requested_claim_key_version,
    requested_hmac_key_version, requested_phone_ciphertext, requested_phone_lookup_hmac,
    case when requested_phone_lookup_hmac is not null then requested_key_version end, claim_expiry);
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system,
    details)
  values (platform.current_correlation_id(), 'staff', platform.current_actor_subject(), platform.current_account_id(),
    platform.current_membership_id(), registration.facility_id, new_patient, 'outreach.health-id.created-unclaimed',
    'success', 'outreach-registration-case', requested_case_id::text, 'direct-care', 'application', 'identity-api',
    -- Not the duplicate flag: facility audit readers see details, and the flag
    -- would tell them the phone or name is on another group's record.
    jsonb_build_object('channel', 'none', 'phoneOnRecord', requested_phone_lookup_hmac is not null));
  perform identity.outreach_health_id_scrub_claims(200);
  return query select requested_hid, new_patient, claim_expiry;
end
$$;

comment on function identity.outreach_health_id_create_unclaimed(uuid,text,bytea,char,text,char,text,text) is
  '0120: creates a Health ID from an outreach registration for a person with no email (and possibly no phone): the patient (name and sex; no contact, no date of birth), its Health ID identifier, the registration''s Health ID record (created_via unclaimed; possible_duplicate when the phone is on another live unclaimed Health ID''s claim or, with no phone, an active patient has the same name and sex) and the claim: the code''s keyed HMAC (180 days, 5 attempts) and the registration''s unproven phone, kept off the patient so it never blocks the number''s real owner. No account and no contact-verified assurance: nobody can sign in until it is claimed. One audit row (ids and the phoneOnRecord flag only; never the duplicate flag, which facility audit readers would see). Refuses as identity.outreach_health_id_eligible does (incl. 23505 OUTREACH_HEALTH_ID_ALREADY_CREATED with the Health ID in detail, never the claim code), 23505 OUTREACH_HEALTH_ID_PHONE_TAKEN (the phone is on a real patient), 22023 OUTREACH_HEALTH_ID_REQUEST_INVALID.';

-- 4. Counts for the platform admin (users created at outreach).
create function identity.outreach_health_id_counts()
returns table (created_at_outreach bigint, created_with_email bigint, created_unclaimed bigint,
  unclaimed_not_yet_claimed bigint, possible_duplicates bigint)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- A platform administrator only, checked here as 0098's admin overview does.
  if platform.current_account_id() is null
     or not auth.account_has_platform_permission(platform.current_account_id(), 'platform.admin.access') then
    raise exception using errcode = '42501', message = 'PLATFORM_ADMIN_REQUIRED';
  end if;
  return query
  select count(*), count(*) filter (where link.created_via = 'email'), count(*) filter (where link.created_via = 'unclaimed'),
    count(*) filter (where link.created_via = 'unclaimed' and not exists (select 1 from identity.outreach_health_id_claims claim
      where claim.registration_case_id = link.registration_case_id and claim.claimed_at is not null)),
    count(*) filter (where link.possible_duplicate)
    from identity.outreach_registration_health_ids link;
end
$$;

comment on function identity.outreach_health_id_counts() is
  '0120: counts of Health IDs created at outreach (with a verified email; with no contact; of those, not yet claimed, including expired or attempt-exhausted claims; flagged as a possible duplicate). Counts only. Identity runtime; refuses 42501 PLATFORM_ADMIN_REQUIRED unless the session account holds platform.admin.access (the route checks it too).';

-- 4b. Retention of the claim's unproven phone (as 0119 does for the codes'
-- email): removed once the claim can no longer be used (expired, out of
-- attempts or invalidated, and never claimed) and at once when the
-- registration is redacted. The claim code and the Health ID stay.
create function identity.outreach_health_id_scrub_claims(requested_limit integer)
returns integer language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  scrubbed integer;
begin
  with due as (
    select claim.patient_id from identity.outreach_health_id_claims claim
     where claim.phone_lookup_hmac is not null and claim.claimed_at is null
       and (claim.expires_at < clock_timestamp() or claim.failed_attempts >= claim.max_attempts
            or claim.invalidated_at is not null
            -- A redaction that ran while this claim was still being created
            -- (its trigger could not see the uncommitted claim).
            or exists (select 1 from outreach.registration_redactions redaction
                        where redaction.registration_case_id = claim.registration_case_id))
     order by claim.expires_at
     limit greatest(1, least(coalesce(requested_limit, 200), 5000))
     for update skip locked)
  update identity.outreach_health_id_claims claim
     set phone_e164_ciphertext = null, phone_lookup_hmac = null, contact_key_version = null
    from due where claim.patient_id = due.patient_id;
  get diagnostics scrubbed = row_count;
  return scrubbed;
end
$$;
comment on function identity.outreach_health_id_scrub_claims(integer) is
  '0120: removes the unproven phone (ciphertext, lookup HMAC, key version) from outreach Health ID claims that can no longer be used and were never claimed (expired, out of attempts or invalidated) or whose registration was redacted (also when the redaction raced the creation), at most the given number (1-5000) per call. Run by create_unclaimed and 0116''s daily retention sweep. Counts only.';

create function identity.outreach_health_id_claim_redacted_case()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update identity.outreach_health_id_claims claim
     set phone_e164_ciphertext = null, phone_lookup_hmac = null, contact_key_version = null
   where claim.registration_case_id = new.registration_case_id and claim.phone_lookup_hmac is not null;
  return null;
end
$$;
create trigger outreach_registration_redactions_health_id_claim_scrub
  after insert on outreach.registration_redactions
  for each row execute function identity.outreach_health_id_claim_redacted_case();

-- 0116's retention sweep (as 0119 left it) also scrubs the claims. Changed in
-- place: 0119's body pinned before, the result checked after.
do $$
declare
  old_end text := E'  perform identity.outreach_health_id_scrub_challenges(5000);\n';
  new_end text := E'  perform identity.outreach_health_id_scrub_challenges(5000);\n  perform identity.outreach_health_id_scrub_claims(5000);\n';
  definition text;
begin
  if (select md5(prosrc) from pg_proc where oid = 'identity.sweep_expired_outreach_registrations(integer)'::regprocedure)
       is distinct from '39ed34999005c9907edeafd4748aaac2' then
    raise exception using errcode = '55000', message = '0120: identity.sweep_expired_outreach_registrations is not 0119''s';
  end if;
  definition := pg_get_functiondef('identity.sweep_expired_outreach_registrations(integer)'::regprocedure);
  if (length(definition) - length(replace(definition, old_end, ''))) / length(old_end) <> 1 then
    raise exception using errcode = '55000', message = '0120: the sweep text to replace is not there exactly once';
  end if;
  execute replace(definition, old_end, new_end);
  if (select prosrc from pg_proc where oid = 'identity.sweep_expired_outreach_registrations(integer)'::regprocedure)
       not like '%identity.outreach_health_id_scrub_claims(5000)%' then
    raise exception using errcode = '55000', message = '0120: the sweep was not changed as intended';
  end if;
end
$$;

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
     and outreach.context_allows(link.facility_id, 'outreach.registration.read')
     and not exists (select 1 from outreach.registration_redactions redaction
                      where redaction.registration_case_id = link.registration_case_id)
     and exists (select 1 from outreach.registration_cases case_row where case_row.id = link.registration_case_id
                  and case_row.facility_id = link.facility_id
                  and outreach.registration_campaign_member(case_row.campaign_id, case_row.facility_id))
$$;

comment on function identity.outreach_registration_health_ids_for(uuid[]) is
  '0119, 0120: for the Outreach runtime, the Health IDs created at outreach, how (created_via email or unclaimed), for up to 500 registrations at the session facility that the session can see: the facility, outreach.registration.read for direct care (outreach.context_allows) and campaign membership, checked here and by the registration''s row-level security; never a redacted registration.';

-- 6. Owners, policies, ACLs.
do $$
declare
  owner_name name := (select pg_get_userbyid(relowner) from pg_class where oid = 'identity.patients'::regclass);
begin
  if owner_name <> current_user then
    if not (pg_has_role(current_user, owner_name, 'USAGE') and pg_has_role(current_user, owner_name, 'SET')) then
      raise exception using errcode = '42501', message = format(
        '0120: the applier (%s) must INHERIT and SET ROLE to the owner of identity.patients (%s)', current_user, owner_name);
    end if;
    execute format('alter table identity.outreach_health_id_claims owner to %I', owner_name);
    execute format('alter function identity.outreach_health_id_create_unclaimed(uuid,text,bytea,char,text,char,text,text) owner to %I', owner_name);
    execute format('alter function identity.outreach_health_id_counts() owner to %I', owner_name);
    execute format('alter function identity.outreach_health_id_scrub_claims(integer) owner to %I', owner_name);
    execute format('alter function identity.outreach_health_id_claim_redacted_case() owner to %I', owner_name);
    execute format('alter function identity.outreach_registration_health_ids_for(uuid[]) owner to %I', owner_name);
  end if;
  execute format('create policy outreach_health_id_claims_owner on identity.outreach_health_id_claims '
    || 'for all to %I using (true) with check (true)', owner_name);
end
$$;

revoke all on identity.outreach_health_id_claims from public;
revoke all on function identity.outreach_health_id_create_unclaimed(uuid,text,bytea,char,text,char,text,text),
  identity.outreach_health_id_counts(), identity.outreach_registration_health_ids_for(uuid[]),
  identity.outreach_health_id_scrub_claims(integer), identity.outreach_health_id_claim_redacted_case() from public;

-- Grants (here and in runtime-grants.sql).
do $$
declare
  role_name text;
begin
  foreach role_name in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant execute on function '
        || 'identity.outreach_health_id_create_unclaimed(uuid,text,bytea,char,text,char,text,text), '
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
  if (select relowner from pg_class where oid = 'identity.outreach_health_id_claims'::regclass)
       <> (select relowner from pg_class where oid = 'identity.patients'::regclass)
     or exists (select 1 from pg_proc where oid in (
               'identity.outreach_health_id_create_unclaimed(uuid,text,bytea,char,text,char,text,text)'::regprocedure,
               'identity.outreach_health_id_counts()'::regprocedure, 'identity.outreach_registration_health_ids_for(uuid[])'::regprocedure,
               'identity.outreach_health_id_scrub_claims(integer)'::regprocedure,
               'identity.outreach_health_id_claim_redacted_case()'::regprocedure)
               and proowner <> (select relowner from pg_class where oid = 'identity.patients'::regclass)) then
    raise exception using errcode = '55000', message = '0120: a new object is not owned by the owner of identity.patients';
  end if;
  if exists (select 1 from identity.outreach_registration_health_ids where created_via <> 'email') then
    raise exception using errcode = '55000', message = '0120: an existing record is not an email one';
  end if;
  if exists (select 1 from pg_roles role_row where role_row.rolname like 'hid\_%'
              and role_row.oid <> (select relowner from pg_class where oid = 'identity.patients'::regclass)
              and (has_function_privilege(role_row.oid, 'identity.outreach_health_id_scrub_claims(integer)', 'EXECUTE')
                   or has_function_privilege(role_row.oid, 'identity.outreach_health_id_claim_redacted_case()', 'EXECUTE'))) then
    raise exception using errcode = '55000', message = '0120: a runtime role can run the claim scrub';
  end if;
end
$$;
