-- 0132 Staff patient search: strong and weak keys, and emergency search
-- (ID-3a and ID-3b, Release A of the Akos EHR plan of 18 November 2026).
-- Written on staging-novu-ci-20261005 at afec3f75; this file requires
-- 0001-0127, 0130 and 0131 applied (it calls 0131's
-- identity.own_facility_basis). 0128 (hid-system#264) and 0129 ship before
-- it and change nothing it reads or replaces. The declaration is signed
-- separately (the release integrator's).
--
-- Owner, 18 November 2026: YES to search by name, phone, date of birth and
-- Health ID, with the strong and weak key rule; YES to emergency search by
-- name and date of birth; Q104 YES: an emergency search shows in the
-- patient's own access history ("Found in an emergency search at
-- <facility>"); Q100 B: a Health ID that does not exist answers "No such
-- patient" distinctly.
--
-- WHAT IT DOES
--   1. identity.patient_search_refs: the match references (matchRef) a
--      search hands out instead of a Health ID or a patient id. Each is a
--      random server-side token ('psr_' and 43 characters); only its SHA-256
--      is stored, bound to the patient, the member's account, membership and
--      facility, the purpose (direct care, or emergency for an emergency
--      search), and it expires 10 minutes after it was made. No key and no
--      setting: nothing is sealed with a secret. Row-level security on, no
--      policy and no privilege for any runtime role; only the two functions
--      below (as the table's owner) read or write it. Expired rows are
--      deleted by later searches (at most 200 at a time).
--   2. identity.staff_patient_search(mode, first name, last name, date of
--      birth, Health ID, phone lookup HMACs, reason, criteria hash)
--      (SECURITY DEFINER), for the Identity runtime.
--      standard: the member holds identity.registration.write at the session
--        facility, for direct care. Strong keys find any active patient:
--          first name + last name + date of birth;
--          Health ID + (last name or date of birth);
--          phone + last name.
--        Weak keys find only this facility's own patients (0131's
--        identity.own_facility_basis is not null):
--          last name + date of birth; phone; Health ID.
--        Anything else is too broad (outcome too_broad, no search).
--        Every key given must match. At most 10 cards; more than 10 answers
--        too_many and no card.
--      emergency: the member holds identity.break-glass.write, the purpose is
--        emergency, the break_glass_enabled control is on and a reason of
--        8-500 characters is given before any result. Exactly first name +
--        last name + date of birth (no other key); any active patient; at
--        most 5 cards, more than 5 answers too_many. The cards give no
--        access: break-glass still needs its own reason.
--      Names match case-insensitively after trimming and collapsing spaces;
--      the date of birth exactly; the Health ID exactly (any case); the phone
--      by the lookup HMACs Identity computes (every stored form, at most 2).
--      Only active patients, never one the session facility's seal (sealed
--      demo or QA tenant) does not allow, are found.
--      Outcomes: found (one row per card), no_match, no_such_health_id (a
--      Health ID was given and no patient record of any status has it, as
--      the staff Health ID lookup answers owner Q100 B; an inactive, merged
--      or sealed patient's Health ID is no_match), too_many, too_broad. A card: full name, sex, date of
--      birth, the last 4 characters of the Health ID, whether the patient's
--      NIN was checked, and a new matchRef. Never a Health ID or patient id.
--      Audit: one row per search (identity.patient.search or
--      identity.patient.emergency-search; success, or denied when too broad)
--      with the kinds of keys given, the caller's keyed hash of the values
--      (never a name, date of birth, Health ID or phone), the reach, the
--      outcome, the count and the patient ids shown; and one row per patient
--      shown (identity.patient.search.shown or
--      identity.patient.emergency-search.shown) naming the patient. The
--      emergency reason is kept on the search row. Refusals it raises
--      (permission, purpose, control, invalid input) write nothing here:
--      identity-api audits those.
--   3. identity.resolve_patient_search_ref(match ref, purpose) (SECURITY
--      DEFINER, STABLE), for the Identity runtime: the patient id of an
--      unexpired matchRef made for this account, membership, facility and
--      purpose (which must be the session's), while the patient is active
--      and the seal allows it; null otherwise. Other packages (break-glass
--      by matchRef, check-in) call it; it writes nothing (they audit).
--   3b. identity.activate_break_glass_by_match_ref(match ref, reason,
--      minutes) (SECURITY DEFINER), for the Identity runtime (ID-5): the
--      patient of an emergency search's matchRef of this account,
--      membership and facility, then 0031's identity.activate_break_glass,
--      unchanged, with that patient's Health ID; an unresolved ref is
--      refused as an unknown Health ID ('Patient is not available').
--   4. identity.patient_self_access_log (0093) replaced: 0093's body with
--      one more kind, found_in_emergency_search, for
--      identity.patient.emergency-search.shown rows by staff (owner Q104).
--      A standard search's rows are not shown there.
--   5. Owners and EXECUTE: the table and functions are owned by the owner
--      of identity.has_active_consent_grant (as 0131's); EXECUTE on 2, 3 and 3b
--      for hid_identity_runtime only (here when the role exists, and in
--      runtime-grants.sql).
--
-- Locks, taken first (section 0b), NOWAIT: SHARE ROW EXCLUSIVE on
-- identity.patients and identity.staff_facility_memberships for the two
-- foreign keys of a new, empty table (no scan), held to commit; nothing else
-- (pg_locks before commit). Writes to the two tables wait until the file
-- commits; reads do not.
-- A busy table fails the attempt at once, and its subtransaction releases
-- what it took. The attempt is made again every 100 ms for at most 5 seconds,
-- so the file never waits while holding a lock and no request queues behind
-- a waiting lock; then 55P03 (nothing applied; the release can run again).
-- When this transaction already holds an earlier migration's locks that stop
-- other sessions' reads or writes (the runner's dry run applies every pending
-- file in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied, instead of keeping those locks while this file waits. Indexes are
-- locked only by planning (ACCESS SHARE), which only a REINDEX or DROP INDEX
-- could hold up.
--
-- Old services on this schema: today's identity-api never calls the new
-- functions; its access-log reader drops an action it does not know, so the
-- new kind is not shown until this branch's identity-api runs.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 0b. Locks, NOWAIT (55P03 and nothing applied).
-- 1-5. As above.
-- 6. Post-checks.

-- 0. Preconditions.
do $$
begin
  if to_regprocedure('identity.organization_staff_kinds(uuid)') is null
     or to_regprocedure('identity.own_facility_basis(uuid, uuid)') is null
     or to_regprocedure('identity.open_own_facility_patient(text, uuid)') is null then
    raise exception using errcode = '55000', message = '0132: 0001-0127, 0130 and 0131 must be applied first';
  end if;
  if to_regclass('identity.patient_search_refs') is not null
     or to_regprocedure('identity.staff_patient_search(text, text, text, date, text, text[], text, text)') is not null
     or to_regprocedure('identity.resolve_patient_search_ref(text, text)') is not null
     or to_regprocedure('identity.activate_break_glass_by_match_ref(text, text, integer)') is not null then
    raise exception using errcode = '55000', message = '0132: already applied';
  end if;
  if (select md5(prosrc) from pg_proc
       where oid = 'identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)'::regprocedure)
     is distinct from '774de1706eef07e5cb52af783be47401' then
    raise exception using errcode = '55000', message = '0132: identity.patient_self_access_log differs from 0093''s body';
  end if;
  if to_regprocedure('identity.sealed_demo_facility(uuid)') is null
     or to_regprocedure('identity.sealed_demo_patient(uuid)') is null
     or to_regprocedure('identity.sealed_qa_facility(uuid)') is null
     or to_regprocedure('identity.sealed_qa_patient(uuid)') is null
     or to_regprocedure('platform.require_control_enabled(text)') is null
     or to_regprocedure('auth.membership_has_permission(text, uuid, uuid, text)') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null
     or to_regprocedure('identity.activate_break_glass(text, text, integer)') is null then
    raise exception using errcode = '55000', message = '0132: a function this file calls is missing';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pgcrypto')
     or to_regprocedure('public.gen_random_bytes(integer)') is null then
    raise exception using errcode = '55000', message = '0132: pgcrypto (public.gen_random_bytes) is required';
  end if;
end
$$;

-- 0b. Locks (see Locks), NOWAIT, at most 5 s; one attempt when this
-- transaction already holds an earlier migration's locks.
do $locks$
declare
  attempt integer := 0;
  holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.patients, identity.staff_facility_memberships
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0132: identity.patients or identity.staff_facility_memberships is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0132: identity.patients or identity.staff_facility_memberships stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. The match references.
create table identity.patient_search_refs (
  token_sha256 char(64) primary key check (token_sha256 ~ '^[0-9a-f]{64}$'),
  patient_id uuid not null references identity.patients(id) on delete cascade,
  account_id uuid not null,
  membership_id uuid not null references identity.staff_facility_memberships(id) on delete cascade,
  facility_id uuid not null,
  purpose_of_use text not null check (purpose_of_use in ('direct-care', 'emergency')),
  search_mode text not null check (search_mode in ('standard', 'emergency')),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint patient_search_refs_ten_minutes_ck check (expires_at = created_at + interval '10 minutes'),
  constraint patient_search_refs_mode_purpose_ck
    check ((search_mode = 'emergency') = (purpose_of_use = 'emergency'))
);
create index patient_search_refs_expires_idx on identity.patient_search_refs (expires_at);
create index patient_search_refs_membership_idx on identity.patient_search_refs (membership_id);
create index patient_search_refs_patient_idx on identity.patient_search_refs (patient_id);
alter table identity.patient_search_refs enable row level security;
revoke all on identity.patient_search_refs from public;
comment on table identity.patient_search_refs is
  '0132: the matchRefs a staff patient search handed out (SHA-256 of the token only), bound to patient, account, membership, facility and purpose, for 10 minutes. No runtime role reads it; identity.staff_patient_search and identity.resolve_patient_search_ref do, as its owner.';

-- 2. The search.
create function identity.staff_patient_search(
  requested_mode text, requested_first_name text, requested_last_name text, requested_dob date,
  requested_hid text, requested_phone_hmacs text[], requested_reason text, requested_criteria_hash text)
returns table (outcome text, reach text, match_ref text, full_name text, sex text, date_of_birth date,
  health_id_last4 text, nin_verified boolean, match_ref_expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_correlation text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_organization uuid;
  emergency boolean;
  first_value text;
  last_value text;
  hid_value text;
  phone_values char(64)[];
  reason_value text;
  kinds text[] := array[]::text[];
  reach_value text;
  card_limit integer;
  query_text text;
  found_ids uuid[];
  outcome_value text;
  action_value text;
  ref_expiry timestamptz;
  token text;
  patient_row record;
  shown_ids uuid[] := array[]::uuid[];
begin
  if requested_mode is null or requested_mode not in ('standard', 'emergency') then
    raise exception using errcode = '22023', message = 'PATIENT_SEARCH_INVALID';
  end if;
  emergency := requested_mode = 'emergency';
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
          case when emergency then 'identity.break-glass.write' else 'identity.registration.write' end) then
    raise exception using errcode = '42501', message = 'PATIENT_SEARCH_NOT_PERMITTED';
  end if;
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if not found then
    raise exception using errcode = '42501', message = 'PATIENT_SEARCH_NOT_PERMITTED';
  end if;
  if actor_purpose is distinct from (case when emergency then 'emergency' else 'direct-care' end)
     or not exists (select 1 from identity.purpose_of_use_codes code
                     where code.code = actor_purpose and code.active) then
    raise exception using errcode = '22023', message = 'PATIENT_SEARCH_PURPOSE';
  end if;
  if emergency then
    perform platform.require_control_enabled('break_glass_enabled');
  end if;

  first_value := nullif(lower(regexp_replace(btrim(coalesce(requested_first_name, '')), '\s+', ' ', 'g')), '');
  last_value := nullif(lower(regexp_replace(btrim(coalesce(requested_last_name, '')), '\s+', ' ', 'g')), '');
  hid_value := nullif(upper(btrim(coalesce(requested_hid, ''))), '');
  reason_value := nullif(btrim(coalesce(requested_reason, '')), '');
  if length(first_value) > 100 or length(last_value) > 100
     or (hid_value is not null and hid_value !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$')
     or (requested_dob is not null and (requested_dob > current_date or requested_dob < date '1880-01-01'))
     or coalesce(cardinality(requested_phone_hmacs), 0) > 2
     or exists (select 1 from unnest(requested_phone_hmacs) hmac where hmac is null or hmac !~ '^[0-9a-f]{64}$')
     or (requested_criteria_hash is not null and requested_criteria_hash !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = '22023', message = 'PATIENT_SEARCH_INVALID';
  end if;
  if coalesce(cardinality(requested_phone_hmacs), 0) > 0 then
    phone_values := requested_phone_hmacs::char(64)[];
  end if;
  if emergency then
    if reason_value is null or length(reason_value) < 8 or length(reason_value) > 500 then
      raise exception using errcode = '22023', message = 'PATIENT_SEARCH_REASON_REQUIRED';
    end if;
    if first_value is null or last_value is null or requested_dob is null
       or hid_value is not null or phone_values is not null then
      raise exception using errcode = '22023', message = 'PATIENT_SEARCH_EMERGENCY_KEYS';
    end if;
  elsif reason_value is not null then
    raise exception using errcode = '22023', message = 'PATIENT_SEARCH_INVALID';
  end if;

  if first_value is not null then kinds := array_append(kinds, 'first_name'); end if;
  if last_value is not null then kinds := array_append(kinds, 'last_name'); end if;
  if requested_dob is not null then kinds := array_append(kinds, 'date_of_birth'); end if;
  if hid_value is not null then kinds := array_append(kinds, 'health_id'); end if;
  if phone_values is not null then kinds := array_append(kinds, 'phone'); end if;

  if emergency
     or (first_value is not null and last_value is not null and requested_dob is not null)
     or (hid_value is not null and (last_value is not null or requested_dob is not null))
     or (phone_values is not null and last_value is not null) then
    reach_value := 'everywhere';
  elsif (last_value is not null and requested_dob is not null) or phone_values is not null
     or hid_value is not null then
    reach_value := 'here';
  end if;
  card_limit := case when emergency then 5 else 10 end;
  action_value := case when emergency then 'identity.patient.emergency-search' else 'identity.patient.search' end;

  -- Expired references go, a few at a time.
  delete from identity.patient_search_refs old_ref
   where old_ref.token_sha256 in (select expired.token_sha256 from identity.patient_search_refs expired
                                   where expired.expires_at < clock_timestamp() limit 200);

  if reach_value is null then
    outcome_value := 'too_broad';
  else
    -- Only the keys given, so each search uses its index (Health ID, phone,
    -- or last name with first name and date of birth).
    query_text := 'select array_agg(matched.id order by matched.sort_name, matched.id) from ('
      || 'select patient.id, lower(patient.full_name) as sort_name from identity.patients patient'
      || ' where patient.status = ''active'''
      || case when last_value is not null then ' and lower(patient.last_name) = $2' else '' end
      || case when first_value is not null then ' and lower(patient.first_name) = $3' else '' end
      || case when requested_dob is not null then ' and patient.dob = $4' else '' end
      || case when hid_value is not null then ' and upper(patient.hid_code) = $5' else '' end
      || case when phone_values is not null then ' and patient.phone_lookup_hmac = any ($6)' else '' end
      || ' and identity.sealed_demo_facility($1) = identity.sealed_demo_patient(patient.id)'
      || ' and identity.sealed_qa_facility($1) = identity.sealed_qa_patient(patient.id)'
      || case when reach_value = 'here' then ' and identity.own_facility_basis(patient.id, $1) is not null' else '' end
      || ' order by lower(patient.full_name), patient.id limit ' || (card_limit + 1)::text
      || ') matched';
    execute query_text into found_ids
      using actor_facility, last_value, first_value, requested_dob, hid_value, phone_values;
    if coalesce(cardinality(found_ids), 0) = 0 then
      outcome_value := case
        -- Owner Q100 B, as the staff Health ID lookup answers it: no patient
        -- record of any status has the Health ID.
        when hid_value is not null and not exists (
          select 1 from identity.patients patient where upper(patient.hid_code) = hid_value)
          then 'no_such_health_id'
        else 'no_match' end;
    elsif cardinality(found_ids) > card_limit then
      outcome_value := 'too_many';
    else
      outcome_value := 'found';
    end if;
  end if;

  if outcome_value = 'found' then
    ref_expiry := clock_timestamp();
    for patient_row in
      select patient.id, patient.full_name, patient.gender, patient.dob, patient.hid_code,
             exists (select 1 from identity.patient_identifiers nin_identifier
                      where nin_identifier.patient_id = patient.id and nin_identifier.identifier_type = 'nin'
                        and nin_identifier.verified and nin_identifier.revoked_at is null) as nin_checked,
             ordering.ord_position
        from unnest(found_ids) with ordinality ordering(id, ord_position)
        join identity.patients patient on patient.id = ordering.id
       order by ordering.ord_position
    loop
      token := 'psr_' || translate(encode(public.gen_random_bytes(32), 'base64'), '+/=', '-_');
      insert into identity.patient_search_refs (token_sha256, patient_id, account_id, membership_id, facility_id,
        purpose_of_use, search_mode, created_at, expires_at)
      values (encode(sha256(convert_to(token, 'UTF8')), 'hex'), patient_row.id, actor_account, actor_membership,
        actor_facility, actor_purpose, requested_mode, ref_expiry, ref_expiry + interval '10 minutes');
      insert into audit.events (
        correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
        organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, provenance, source_system, details
      ) values (
        actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
        actor_organization, actor_facility, patient_row.id, action_value || '.shown', 'success',
        'patient', patient_row.id::text, actor_purpose, 'application', 'identity-api',
        jsonb_build_object('mode', requested_mode, 'reach', reach_value, 'criteria', to_jsonb(kinds))
      );
      shown_ids := shown_ids || patient_row.id;
      outcome := 'found'; reach := reach_value; match_ref := token; full_name := patient_row.full_name;
      sex := patient_row.gender; date_of_birth := patient_row.dob;
      health_id_last4 := right(patient_row.hid_code, 4); nin_verified := patient_row.nin_checked;
      match_ref_expires_at := ref_expiry + interval '10 minutes';
      return next;
    end loop;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, null, action_value,
    case when outcome_value = 'too_broad' then 'denied' else 'success' end,
    'patient-search', null, actor_purpose, case when emergency then reason_value end, 'application', 'identity-api',
    jsonb_build_object('mode', requested_mode, 'reach', reach_value, 'criteria', to_jsonb(kinds),
      'criteriaHash', requested_criteria_hash, 'outcome', outcome_value,
      'resultCount', cardinality(shown_ids), 'patientIds', to_jsonb(shown_ids))
  );

  if outcome_value <> 'found' then
    outcome := outcome_value; reach := reach_value; match_ref := null; full_name := null; sex := null;
    date_of_birth := null; health_id_last4 := null; nin_verified := null; match_ref_expires_at := null;
    return next;
  end if;
end
$$;

comment on function identity.staff_patient_search(text, text, text, date, text, text[], text, text) is
  '0132 (ID-3a, ID-3b; owner decisions of 18 November 2026): staff patient search. standard (identity.registration.write, direct care): strong keys (first + last name + date of birth; Health ID + last name or date of birth; phone + last name) find any active patient, weak keys (last name + date of birth; phone; Health ID) only this facility''s own patients (0131 basis); at most 10 cards. emergency (identity.break-glass.write, emergency purpose, break_glass_enabled, a reason of 8-500 characters): exact first + last name + date of birth only, at most 5 cards. Outcomes found, no_match, no_such_health_id, too_many, too_broad. Cards carry a 10-minute matchRef, never a Health ID or patient id. Audited per search (key kinds and the caller''s keyed hash, never the values) and per patient shown.';
revoke all on function identity.staff_patient_search(text, text, text, date, text, text[], text, text) from public;

-- 3. Resolving a matchRef.
create function identity.resolve_patient_search_ref(requested_ref text, requested_purpose text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select ref.patient_id
    from identity.patient_search_refs ref
    join identity.patients patient on patient.id = ref.patient_id and patient.status = 'active'
   where requested_ref ~ '^psr_[A-Za-z0-9_-]{43}$'
     and ref.token_sha256 = encode(sha256(convert_to(requested_ref, 'UTF8')), 'hex')::char(64)
     and ref.account_id = auth.account_id_for_subject(platform.current_actor_subject())
     and ref.membership_id = platform.current_membership_id()
     and ref.facility_id = platform.current_facility_id()
     and ref.purpose_of_use = requested_purpose
     and requested_purpose = platform.current_purpose_of_use()
     and ref.expires_at > clock_timestamp()
     and identity.sealed_demo_facility(ref.facility_id) = identity.sealed_demo_patient(ref.patient_id)
     and identity.sealed_qa_facility(ref.facility_id) = identity.sealed_qa_patient(ref.patient_id)
$$;

comment on function identity.resolve_patient_search_ref(text, text) is
  '0132: the patient id of an unexpired matchRef made by a search of this account, membership and facility for this purpose (the session''s), while the patient is active and the seal allows it; null otherwise. Writes nothing; callers audit.';
revoke all on function identity.resolve_patient_search_ref(text, text) from public;

-- 3b. Break-glass by matchRef (ID-5): the emergency search's card carries no
-- Health ID, so the next step names the patient by the card's matchRef. The
-- ref must be this account's, membership's and facility's, from an emergency
-- search (the session's purpose, which break-glass requires anyway), in the
-- last 10 minutes, for an active patient the seal allows; anything else is
-- refused as an unknown Health ID is ('Patient is not available', P0002),
-- the same for every reason. The activation itself is 0031's
-- identity.activate_break_glass, unchanged, with the patient's Health ID,
-- run as this function's owner: its permission, purpose, reason, duration,
-- seal, hourly limit, replay, grant, event and audit all apply as they do
-- to a Health ID typed at the desk.
create function identity.activate_break_glass_by_match_ref(
  requested_ref text, requested_reason text, requested_duration_minutes integer)
returns table (access_request_id uuid, consent_grant_id uuid, subject_patient_id uuid, grant_status text,
  expires_at timestamptz, existing_grant boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  matched_patient uuid := identity.resolve_patient_search_ref(requested_ref, 'emergency');
  matched_hid text;
begin
  if matched_patient is not null then
    select patient_row.hid_code into matched_hid from identity.patients patient_row where patient_row.id = matched_patient;
  end if;
  if matched_hid is null then
    raise exception using errcode = 'P0002', message = 'Patient is not available';
  end if;
  return query select activated.access_request_id, activated.consent_grant_id, activated.subject_patient_id,
                      activated.grant_status, activated.expires_at, activated.existing_grant
                 from identity.activate_break_glass(matched_hid, requested_reason, requested_duration_minutes) activated;
end
$$;

comment on function identity.activate_break_glass_by_match_ref(text, text, integer) is
  '0132 (ID-5): break-glass for the patient behind an emergency search''s matchRef of this account, membership and facility (10 minutes); 0031''s activate_break_glass does the rest, unchanged. An unresolved ref is refused as an unknown Health ID.';
revoke all on function identity.activate_break_glass_by_match_ref(text, text, integer) from public;

-- 4. The patient's access log (0093), with emergency searches (owner Q104).
create or replace function identity.patient_self_access_log(
  requested_subject text, requested_session uuid, requested_limit integer,
  before_occurred_at timestamptz, before_sequence_id bigint
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  bounded_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 100);
  scan_cap constant integer := 2000;
  scanned integer;
  oldest_cursor text;
  all_islands jsonb;
  island_count integer;
  take_count integer;
  next_cursor jsonb;
  entries jsonb;
begin
  if patient_id_value is null then return null; end if;
  if (before_occurred_at is null) <> (before_sequence_id is null) then
    raise exception using errcode = '22023', message = 'ACCESS_LOG_CURSOR_INVALID';
  end if;
  with raw as materialized (
    select event.sequence_id, event.event_id, event.occurred_at, event.action, event.outcome,
           event.provenance, event.actor_type, event.actor_account_id, event.actor_membership_id,
           event.facility_id
      from audit.events event
     where event.patient_id = patient_id_value
       and (before_occurred_at is null
         or (event.occurred_at, event.sequence_id) < (before_occurred_at, before_sequence_id))
     order by event.occurred_at desc, event.sequence_id desc
     limit scan_cap
  ), classified as materialized (
    -- Materialized, so that each row's kind is computed once.
    select raw.*, kinds.kind
      from raw
      cross join lateral (select case
        when raw.outcome <> 'success' or raw.provenance <> 'application' then null
        -- The interceptor's rows and the authorization checks, most of a
        -- chart's rows, without a regular expression.
        when raw.action like 'api.%' or raw.action like '%.request'
          or raw.action = 'identity.authorization.check' then null
        when raw.actor_type = 'staff' and raw.action = 'identity.break-glass.activate' then 'emergency_access'
        -- 0132 (owner Q104 of 18 November 2026): "Found in an emergency search at <facility>".
        when raw.actor_type = 'staff' and raw.action = 'identity.patient.emergency-search.shown'
          then 'found_in_emergency_search'
        when raw.actor_type = 'patient' and raw.action = 'identity.access-request.approve' then 'access_granted'
        when raw.actor_type = 'staff' and raw.action = 'identity.patient-access-pin.verify' then 'access_granted'
        when raw.actor_type = 'staff' and raw.action = 'identity.consent-grant.close' then 'access_ended'
        when raw.actor_type = 'patient' and raw.action = 'identity.consent-grant.patient-revoke' then 'access_ended'
        when raw.actor_type not in ('staff', 'system', 'workload') then null
        when raw.action ~ ('^(ehr\.((encounter|note|note-revision|vital|vital-correction|diagnosis|prescription'
            || '|lab-request)\.(create|update)|note\.import-ocr|document\.upload\.complete'
            || '|order-route\.(send|withdraw))'
            || '|lab\.(result\.(enter|correct|verify|release|revise-released|entered-in-error)'
            || '|specimen\.(collect|receive|reject)|accession\.create|execution\.(start|complete)'
            || '|import\.create|imported-evidence\.create|work-item\.accept'
            || '|order-route\.(cannot-complete|wrong-patient|wrong-patient-correction))'
            || '|pharmacy\.(dispensing\.(create|reverse)|import\.create|imported-medication-evidence\.create'
            || '|work-item\.accept|order-route\.(cannot-complete|wrong-patient|wrong-patient-correction)))$')
          then 'changed'
        when raw.action ~ ('^(ehr\.((encounter|note|note-revision|vital|vital-correction|diagnosis|prescription'
            || '|lab-request|document|order-route)\.(read|list)|document\.(download|ocr-source\.read)'
            || '|imported\.records\.read|emergency\.records\.read'
            || '|imported\.attachment\.download|staff\.chat\.evidence\.read|record\.read)'
            || '|identity\.(patient\.lookup|staff\.chat\.profile\.read)'
            || '|lab\.((work-item|accession|execution|import)\.(read|list)|result\.(history|released)\.read'
            || '|staff\.chat\.released-results\.read|order-route\.(read|accept))'
            || '|pharmacy\.((work-item|dispensing|import)\.(read|list)|order-route\.(read|accept))'
            || '|ocr\.(job\.read|(extraction|validation|publication)\.list))$')
          then 'viewed'
      end as kind) kinds
     where kinds.kind is not null
  ), flagged as (
    select classified.*,
      case when classified.kind in ('viewed', 'changed')
            and lag(classified.kind) over ordered = classified.kind
            and lag(classified.actor_type) over ordered = classified.actor_type
            and lag(classified.actor_account_id) over ordered is not distinct from classified.actor_account_id
            and lag(classified.facility_id) over ordered is not distinct from classified.facility_id
            and lag(classified.occurred_at) over ordered - classified.occurred_at < interval '10 minutes'
           then 0 else 1 end as starts_island
      from classified
    window ordered as (order by classified.occurred_at desc, classified.sequence_id desc)
  ), numbered as (
    select flagged.*,
      sum(flagged.starts_island) over (order by flagged.occurred_at desc, flagged.sequence_id desc
        rows unbounded preceding) as island
      from flagged
  ), islands as (
    select numbered.island,
      (array_agg(numbered.event_id order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as event_id,
      max(numbered.occurred_at) as newest_at,
      (array_agg(numbered.occurred_at order by numbered.occurred_at, numbered.sequence_id))[1] as oldest_at,
      (array_agg(numbered.sequence_id order by numbered.occurred_at, numbered.sequence_id))[1] as oldest_sequence,
      (array_agg(numbered.kind order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as kind,
      (array_agg(numbered.actor_type order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as actor_type,
      (array_agg(numbered.actor_membership_id order by numbered.occurred_at desc, numbered.sequence_id desc))[1]
        as actor_membership_id,
      (array_agg(numbered.facility_id order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as facility_id
      from numbered
     group by numbered.island
  )
  select (select count(*) from raw),
         (select to_char(raw.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || raw.sequence_id
            from raw order by raw.occurred_at, raw.sequence_id limit 1),
         coalesce((select jsonb_agg(jsonb_build_object(
              'id', islands.event_id::text,
              'at', to_char(islands.newest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'action', islands.kind,
              'actorKind', case
                when islands.actor_type = 'patient' then 'patient'
                when islands.actor_type = 'staff' and islands.actor_membership_id is not null then 'clinician'
                when islands.actor_type = 'staff' then 'support'
                when islands.facility_id is not null then 'facility'
                else 'system' end,
              'membership', case when islands.actor_type = 'staff' then islands.actor_membership_id end,
              'facility', islands.facility_id,
              'cursor', to_char(islands.oldest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                || '|' || islands.oldest_sequence)
            order by islands.island) from islands), '[]'::jsonb)
    into scanned, oldest_cursor, all_islands;
  island_count := jsonb_array_length(all_islands);
  -- An entry is complete once an older entry follows it in the rows read,
  -- or once every row was read.
  if island_count > bounded_limit then
    take_count := bounded_limit;
    next_cursor := to_jsonb(all_islands -> (take_count - 1) ->> 'cursor');
  elsif scanned >= scan_cap then
    take_count := case when island_count > 1 then island_count - 1 else island_count end;
    next_cursor := case when take_count >= 1 and take_count < island_count
      then to_jsonb(all_islands -> (take_count - 1) ->> 'cursor') else to_jsonb(oldest_cursor) end;
  else
    take_count := island_count;
    next_cursor := null;
  end if;
  -- Names only for the entries returned: the clinician's (staff record of
  -- the membership the row names) and the facility's.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', element.value->>'id', 'at', element.value->>'at', 'action', element.value->>'action',
      'actorKind', element.value->>'actorKind',
      'actorName', case when element.value->>'actorKind' = 'clinician' then (
        select staff_record.full_name
          from identity.staff_facility_memberships membership
          join identity.staff staff_record on staff_record.id = membership.staff_id
         where membership.id = (element.value->>'membership')::uuid) end,
      'facilityName', (select facility.name from identity.facilities facility
                        where facility.id = (element.value->>'facility')::uuid))
      order by element.ordinality), '[]'::jsonb) into entries
    from jsonb_array_elements(all_islands) with ordinality element(value, ordinality)
   where element.ordinality <= take_count;
  return jsonb_build_object('events', entries, 'next', case when next_cursor is null then null else
    jsonb_build_object('occurredAt', split_part(next_cursor #>> '{}', '|', 1),
                       'sequenceId', split_part(next_cursor #>> '{}', '|', 2)::bigint) end);
end
$$;

comment on function identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint) is
  '0093, 0132: who viewed or changed the live patient session''s record, newest first, from its successful audit events; since 0132 also each emergency search that found the patient (found_in_emergency_search, owner Q104); no record contents.';

-- 5. Owners and EXECUTE.
do $$
declare
  grant_owner name := (select pg_get_userbyid(proowner) from pg_proc
                        where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
begin
  if grant_owner <> current_user then
    execute format('alter table identity.patient_search_refs owner to %I', grant_owner);
    execute format('alter function identity.staff_patient_search(text, text, text, date, text, text[], text, text) owner to %I', grant_owner);
    execute format('alter function identity.resolve_patient_search_ref(text, text) owner to %I', grant_owner);
    execute format('alter function identity.activate_break_glass_by_match_ref(text, text, integer) owner to %I', grant_owner);
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.staff_patient_search(text, text, text, date, text, text[], text, text),
      identity.resolve_patient_search_ref(text, text),
      identity.activate_break_glass_by_match_ref(text, text, integer) to hid_identity_runtime;
  end if;
end
$$;

-- 6. Post-checks.
do $$
begin
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('identity.staff_patient_search(text, text, text, date, text, text[], text, text)'::regprocedure,
                                 'identity.resolve_patient_search_ref(text, text)'::regprocedure,
                                 'identity.activate_break_glass_by_match_ref(text, text, integer)'::regprocedure)
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime')) then
    raise exception using errcode = '55000', message = '0132: a search function is granted to a role other than hid_identity_runtime';
  end if;
  if exists (select 1 from pg_class rel, lateral aclexplode(coalesce(rel.relacl, acldefault('r', rel.relowner))) acl
              where rel.oid = 'identity.patient_search_refs'::regclass and acl.grantee <> rel.relowner) then
    raise exception using errcode = '55000', message = '0132: identity.patient_search_refs is granted to a role';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'identity.patient_search_refs'::regclass) then
    raise exception using errcode = '55000', message = '0132: row-level security is off on identity.patient_search_refs';
  end if;
  if (select pg_get_userbyid(relowner) from pg_class where oid = 'identity.patient_search_refs'::regclass)
     is distinct from (select pg_get_userbyid(proowner) from pg_proc
                        where oid = 'identity.staff_patient_search(text, text, text, date, text, text[], text, text)'::regprocedure) then
    raise exception using errcode = '55000', message = '0132: the search function does not own identity.patient_search_refs';
  end if;
  if position('found_in_emergency_search' in (select prosrc from pg_proc
       where oid = 'identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)'::regprocedure)) = 0 then
    raise exception using errcode = '55000', message = '0132: identity.patient_self_access_log was not replaced';
  end if;
end
$$;
