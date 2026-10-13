-- Account recovery and patient search hardening (launch blockers REC-GOOGLE,
-- REC-AUDIENCE, REC-NOTIFY, PSEARCH-1). Applied migrations 0001 through 0085
-- are immutable.
--
-- 1. auth.complete_recovery_otp (0029) also revokes every external sign-in
--    identity of the account (today only Google links) that is not already
--    revoked, and records how many in the audit event. Before, a Google link
--    made by whoever once held the password survived the owner's reset, and
--    Google sign-in issues a session at the current token version. The legacy
--    importer's provenance record (issuer 'legacy-identity') is not a sign-in
--    and is kept. Replaced with CREATE OR REPLACE, which keeps its owner and
--    ACL; signature, result, SECURITY DEFINER and search_path are restated
--    exactly as in 0029.
-- 2. auth.recovery_account_audience(account, audience): whether an account is
--    of the kind a recovery start reaches (a patient record, a staff record or
--    a platform administrator assignment), for Identity's system context only.
--    A start for another kind is answered like an unknown identifier.
-- 3. patients_registration_read (0011) no longer admits a registration-role
--    membership to every identity.patients row. It admits only patients linked
--    at the current facility to a registration case (its resolved patient or a
--    review candidate) and the patient an approve-new review is creating.
--    Governed registration reads the rest through two narrow commands,
--    identity.registration_nin_holder and identity.registration_candidates,
--    which return minimum fields. The policy is dropped and created again with
--    the same name, table, command and role (PUBLIC) and the narrower
--    expression, in this transaction, so no other session sees it absent.
-- 4. auth.otp_rate_limits accepts four staff search budgets: patient lookups
--    and access-request creation, each per actor account and per facility.
-- 5. otp_challenges_account_consumed_idx serves the 24-hour hold Identity
--    applies after an OTP recovery (access-PIN set, emergency-contact changes,
--    new access approvals).
-- 6. identity.patient_lookup_audit_subject names, for the audit only, the
--    patient a refused HID lookup was about; the API answers every refusal
--    alike.
-- 7. identity.create_access_request (0010) answers an unknown HID like a
--    recorded request (a new request id, status pending, no patient) instead
--    of raising P0002, and records an 'identity.access-request.refused' audit
--    event. Nothing is persisted for any patient. Replaced with CREATE OR
--    REPLACE; signature, result, SECURITY DEFINER and search_path are restated
--    exactly as in 0010.
-- 8. identity.list_my_staff_access_requests (0074) returns patient_id only
--    while the grant made from the request is active (effective status
--    'active'); for every other request it is NULL, so a request for a
--    guessed HID never yields the patient id without the patient's consent.
--    Replaced with CREATE OR REPLACE; everything else is restated exactly as
--    in 0074, which keeps its owner and ACL.
--
-- Locks, in the order taken: ACCESS EXCLUSIVE on identity.patients (3), ACCESS
-- EXCLUSIVE on auth.otp_rate_limits (4), then SHARE on auth.otp_challenges
-- while the index builds (5), each held until commit. Every other statement
-- changes functions only. The OTP start of the Identity build that serves
-- during the migration reads identity.patients, then writes
-- auth.otp_rate_limits, then auth.otp_challenges, the same order, so it waits
-- for the migration or the migration waits for it, without a cycle (taking
-- the index first deadlocked that start, reproduced locally). Its completion
-- writes auth.otp_challenges and then reads identity.patients within one
-- function call, the opposite order, so a completion caught between those
-- two statements can still deadlock with this migration. PostgreSQL then
-- cancels one of the two (40P01): either that completion fails and the
-- owner submits it again while its verification is valid, or this migration
-- rolls back whole and is run again. The runner's 5 s lock_timeout bounds
-- every wait (55P03 also rolls the migration back whole).
--
-- The new functions are revoked from PUBLIC here; their EXECUTE grants come
-- only with the role bootstrap (runtime-grants.sql). Run db:bootstrap and
-- db:verify-roles immediately after this migration, then deploy the Identity
-- build of this change.

create or replace function auth.complete_recovery_otp(
  requested_challenge_id uuid,
  requested_purpose text,
  supplied_completion_hmac text,
  new_password_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, auth, identity, audit, platform, pg_temp
as $$
declare
  target_account_id uuid;
  account_row auth.accounts%rowtype;
  challenge_row auth.otp_challenges%rowtype;
  request_correlation text := platform.current_correlation_id();
  identities_revoked integer;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or request_correlation is null then
    raise exception using errcode = '42501', message = 'Verified recovery context is required';
  end if;
  if requested_challenge_id is null
     or requested_purpose is null
     or requested_purpose not in ('PASSWORD_RESET', 'LEGACY_ACCOUNT_RECOVERY', 'LEGACY_SESSION_FALLBACK')
     or supplied_completion_hmac is null or supplied_completion_hmac !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  if length(coalesce(new_password_hash, '')) not between 64 and 512
     or new_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$' then
    raise exception using errcode = '22023', message = 'Invalid Argon2id password hash policy';
  end if;

  select challenge.account_id into target_account_id
    from auth.otp_challenges challenge where challenge.id = requested_challenge_id;
  if target_account_id is null then return false; end if;
  -- Match administrative account commands' lock order. Recheck the challenge
  -- after locking the account so concurrent disables/recovery cannot be lost.
  select * into account_row from auth.accounts
    where id = target_account_id for update;
  if not found or account_row.status not in ('active', 'pending_reset')
     or account_row.disabled_until > clock_timestamp() then return false; end if;
  select * into challenge_row from auth.otp_challenges
    where id = requested_challenge_id and account_id = target_account_id for update;
  if not found
     or challenge_row.purpose is distinct from requested_purpose
     or challenge_row.account_token_version is distinct from account_row.token_version
     or challenge_row.verified_at is null
     or challenge_row.consumed_at is not null or challenge_row.invalidated_at is not null
     or challenge_row.failed_attempts >= challenge_row.max_attempts
     or challenge_row.completion_expires_at is null
     or challenge_row.completion_expires_at <= clock_timestamp()
     or challenge_row.completion_token_hmac is distinct from supplied_completion_hmac then
    return false;
  end if;

  update auth.accounts set password_hash = new_password_hash,
    password_algorithm = 'argon2id', password_changed_at = clock_timestamp(),
    status = case when status = 'pending_reset' then 'active' else status end,
    token_version = token_version + 1, row_version = row_version + 1,
    updated_at = clock_timestamp() where id = target_account_id;
  update auth.sessions set revoked_at = clock_timestamp(),
    revocation_reason = 'password_recovered_with_otp', row_version = row_version + 1
    where account_id = target_account_id and revoked_at is null;
  -- A recovered account keeps no sign-in another party may have linked: every
  -- external sign-in identity not already revoked (active or disabled) is
  -- revoked. The legacy importer's provenance record is not a sign-in.
  update auth.external_identities as identity_row
     set status = 'revoked', revoked_at = coalesce(identity_row.revoked_at, clock_timestamp())
   where identity_row.account_id = target_account_id and identity_row.status <> 'revoked'
     and identity_row.issuer <> 'legacy-identity';
  get diagnostics identities_revoked = row_count;
  update auth.otp_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
    where id = requested_challenge_id;
  update auth.otp_challenges set invalidated_at = clock_timestamp(),
    invalidation_reason = 'completed', row_version = row_version + 1
    where account_id = target_account_id and id <> requested_challenge_id
      and purpose in ('PASSWORD_RESET', 'LEGACY_ACCOUNT_RECOVERY', 'LEGACY_SESSION_FALLBACK')
      and consumed_at is null and invalidated_at is null;
  insert into identity.patient_assurance_states (
    patient_id, account_id, state, source_system, contact_verified_at
  ) select patient.id, account_row.id, 'CONTACT_VERIFIED', account_row.source_system, clock_timestamp()
    from identity.patients patient where patient.account_id = account_row.id
  on conflict (patient_id) do update set
    state = case when identity.patient_assurance_states.state = 'NIN_VERIFIED'
      then 'NIN_VERIFIED' else 'CONTACT_VERIFIED' end,
    contact_verified_at = clock_timestamp(), updated_at = clock_timestamp(),
    row_version = identity.patient_assurance_states.row_version + 1;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, action,
    resource_type, resource_id, outcome, provenance, source_system, details
  ) values (request_correlation, 'system', null, target_account_id,
    'auth.otp.recovery.completed', 'account', target_account_id::text,
    'success', 'application', 'identity-api', jsonb_build_object('purpose', requested_purpose,
      'external_identities_revoked', identities_revoked));
  return true;
end;
$$;

comment on function auth.complete_recovery_otp(uuid, text, text, text) is
  'Atomic one-time verified OTP recovery bound to current account token version; cannot enable disabled accounts; revokes every session and every external sign-in identity of the account, keeping the legacy importer provenance record (0086). No OTP/token/password plaintext is persisted or audited.';

create function auth.recovery_account_audience(
  requested_account_id uuid,
  requested_audience text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, auth, identity, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth' then
    raise exception using errcode = '42501', message = 'Verified recovery context is required';
  end if;
  if requested_audience is null or requested_audience not in ('patient', 'staff', 'platform') then
    raise exception using errcode = '22023', message = 'Unknown recovery audience';
  end if;
  if requested_account_id is null then
    return false;
  end if;
  if requested_audience = 'patient' then
    return exists (select 1 from identity.patients patient_row
      where patient_row.account_id = requested_account_id and patient_row.status = 'active');
  end if;
  if requested_audience = 'staff' then
    return exists (select 1 from identity.staff staff_row
      where staff_row.account_id = requested_account_id and staff_row.active);
  end if;
  -- A platform administrator: an unrevoked platform-scoped assignment of an
  -- active role that grants platform.admin.access. The account status is the
  -- caller's check, so an administrator still setting a password matches.
  return exists (
    select 1
      from auth.account_roles assignment
      join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
      join auth.role_permissions role_permission on role_permission.role_code = role_row.code
      join auth.permissions permission on permission.code = role_permission.permission_code and permission.active
     where assignment.account_id = requested_account_id
       and assignment.scope_type = 'platform'
       and assignment.revoked_at is null
       and permission.code = 'platform.admin.access');
end;
$$;

revoke all on function auth.recovery_account_audience(uuid, text) from public;
comment on function auth.recovery_account_audience(uuid, text) is
  'Whether an account is of the kind a recovery start reaches: patient (an active patient record), staff (an active staff record) or platform (an unrevoked platform.admin.access assignment). Identity system context only (0086).';

drop policy patients_registration_read on identity.patients;
create policy patients_registration_read on identity.patients
  for select using (
    (
      auth.membership_has_permission(
        platform.current_actor_subject(), platform.current_membership_id(),
        platform.current_facility_id(), 'identity.registration.write'
      )
      or auth.membership_has_permission(
        platform.current_actor_subject(), platform.current_membership_id(),
        platform.current_facility_id(), 'identity.registration.approve'
      )
    )
    and (
      -- The patient a case at this facility resolved to or linked.
      id in (
        select registration.resolved_patient_id
          from identity.registration_cases registration
         where registration.facility_id = platform.current_facility_id()
           and registration.resolved_patient_id is not null
      )
      -- A duplicate candidate a case at this facility lists for review.
      or id in (
        select candidate.patient_id
          from identity.registration_case_candidates candidate
          join identity.registration_cases registration on registration.id = candidate.case_id
         where registration.facility_id = platform.current_facility_id()
      )
      -- The patient an approve-new review is creating in this transaction,
      -- before the case names it (the identifier insert policy reads it).
      or (
        source_system = 'hid-nin-registration'
        and account_id is null
        and exists (
          select 1
            from identity.registration_cases registration
           where registration.facility_id = platform.current_facility_id()
             and registration.status = 'pending_new_identity_approval'
             and registration.resolved_patient_id is null
             and registration.first_name = patients.first_name
             and registration.last_name = patients.last_name
             and registration.full_name = patients.full_name
             and registration.dob = patients.dob
             and coalesce(registration.gender, 'unknown') = coalesce(patients.gender, 'unknown')
        )
      )
    )
  );

alter table auth.otp_rate_limits drop constraint otp_rate_limits_scope_check;
alter table auth.otp_rate_limits add constraint otp_rate_limits_scope_check check (scope in (
  'ip', 'account', 'recipient', 'mfa_failure_account', 'mfa_failure_ip', 'mfa_request_account',
  'patient_lookup_actor', 'patient_lookup_facility', 'access_request_actor', 'access_request_facility'
));

create index otp_challenges_account_consumed_idx
  on auth.otp_challenges (account_id, consumed_at desc)
  where consumed_at is not null;

create function identity.registration_nin_holder(requested_lookup_hmac text)
returns table (patient_id uuid, hid_code text, patient_status text)
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
begin
  if not (
    auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'identity.registration.write')
    or auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'identity.registration.approve')
  ) then
    raise exception using errcode = '42501', message = 'Registration context is required';
  end if;
  if requested_lookup_hmac is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid NIN lookup HMAC';
  end if;
  return query
    select patient_row.id, patient_row.hid_code, patient_row.status
      from identity.patient_identifiers identifier
      join identity.patients patient_row on patient_row.id = identifier.patient_id
     where identifier.identifier_type = 'nin'
       and identifier.lookup_hmac = requested_lookup_hmac
       and identifier.verified
       and identifier.revoked_at is null
     order by patient_row.status = 'active' desc, patient_row.id
     limit 1;
end;
$$;

revoke all on function identity.registration_nin_holder(text) from public;
comment on function identity.registration_nin_holder(text) is
  'The patient holding a verified, unrevoked NIN with this lookup HMAC (id, HID and status only), for a registration member of the current facility (0086).';

create function identity.registration_candidates(
  requested_dob date,
  requested_first_name text,
  requested_last_name text
)
returns table (patient_id uuid, first_name text, last_name text, full_name text, dob date)
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
begin
  if not (
    auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'identity.registration.write')
    or auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'identity.registration.approve')
  ) then
    raise exception using errcode = '42501', message = 'Registration context is required';
  end if;
  return query
    select patient_row.id, patient_row.first_name, patient_row.last_name, patient_row.full_name, patient_row.dob
      from identity.patients patient_row
     where patient_row.status = 'active'
       and (patient_row.dob = requested_dob
         or lower(patient_row.first_name) = lower(requested_first_name)
         or lower(patient_row.last_name) = lower(requested_last_name))
     order by patient_row.created_at asc, patient_row.id
     limit 100;
end;
$$;

revoke all on function identity.registration_candidates(date, text, text) from public;
comment on function identity.registration_candidates(date, text, text) is
  'Up to 100 active patients sharing the date of birth, first name or last name of verified registration demographics (names and date of birth only), for a registration member of the current facility (0086).';

create function identity.patient_lookup_audit_subject(requested_hid text)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  subject_patient uuid;
begin
  if not auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
       platform.current_facility_id(), 'identity.patient.read') then
    raise exception using errcode = '42501', message = 'Patient lookup context is required';
  end if;
  select patient_row.id into subject_patient
    from identity.patients patient_row
   where upper(patient_row.hid_code) = upper(btrim(requested_hid))
     and patient_row.status = 'active'
   limit 1;
  return subject_patient;
end;
$$;

revoke all on function identity.patient_lookup_audit_subject(text) from public;
comment on function identity.patient_lookup_audit_subject(text) is
  'The active patient an exact HID names, for the audit of a refused staff lookup only; never returned to a caller of the API (0086).';

create or replace function identity.create_access_request(
  requested_hid text,
  requested_scope text,
  requested_reason text,
  requested_duration_minutes integer
)
returns table (
  access_request_id uuid,
  subject_patient_id uuid,
  request_status text,
  request_scope text,
  request_purpose text,
  duration_minutes integer,
  requested_at timestamptz,
  existing_request boolean
)
language plpgsql
security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_staff_id uuid;
  actor_organization_id uuid;
  patient_id_value uuid;
  request_id_value uuid;
  request_created_at timestamptz;
  request_duration_value integer;
  replayed boolean := false;
begin
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.consent.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized consent command context is required';
  end if;
  if actor_purpose not in ('direct-care', 'healthcare-operations')
     or not exists (
       select 1 from identity.purpose_of_use_codes purpose
       where purpose.code = actor_purpose and purpose.active
     ) then
    raise exception using errcode = '22023', message = 'Invalid purpose for a standard access request';
  end if;
  if requested_scope not in ('read_records', 'write_records') then
    raise exception using errcode = '22023', message = 'Invalid access request scope';
  end if;
  if requested_duration_minutes not between 5 and 1440 then
    raise exception using errcode = '22023', message = 'Invalid access request duration';
  end if;
  if length(coalesce(btrim(requested_reason), '')) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'Invalid access request reason';
  end if;

  select membership.staff_id, membership.organization_id
    into actor_staff_id, actor_organization_id
  from identity.staff_facility_memberships membership
  where membership.id = actor_membership_id
    and membership.account_id = actor_account_id
    and membership.facility_id = actor_facility_id;
  if actor_staff_id is null then
    raise exception using errcode = '42501', message = 'Exact staff membership is required';
  end if;

  select patient_row.id
    into patient_id_value
  from identity.patients patient_row
  where upper(patient_row.hid_code) = upper(btrim(requested_hid))
    and patient_row.status = 'active'
  limit 1;
  if patient_id_value is null then
    -- Answered like a recorded request so the answer does not tell whether
    -- the HID exists. Nothing is persisted for any patient; the refusal is
    -- audited under the id the caller receives, without the requested HID.
    request_id_value := gen_random_uuid();
    request_created_at := clock_timestamp();
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id,
      actor_membership_id, organization_id, facility_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use,
      reason, provenance, source_system, details
    ) values (
      actor_correlation_id, 'staff', actor_subject, actor_account_id,
      actor_membership_id, actor_organization_id, actor_facility_id, null,
      'identity.access-request.refused', 'denied', 'access-request', request_id_value::text, actor_purpose,
      btrim(requested_reason), 'application', 'ehr-api',
      jsonb_build_object(
        'scope', requested_scope,
        'duration_minutes', requested_duration_minutes,
        'reason', 'patient_not_available'
      )
    );
    return query select
      request_id_value, null::uuid, 'pending'::text, requested_scope,
      actor_purpose, requested_duration_minutes, request_created_at, false;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    patient_id_value::text || ':' || actor_membership_id::text || ':' || requested_scope || ':' || actor_purpose, 0
  ));

  select request_row.id, request_row.created_at, request_row.requested_duration_minutes
    into request_id_value, request_created_at, request_duration_value
  from identity.access_requests request_row
  where request_row.patient_id = patient_id_value
    and request_row.membership_id = actor_membership_id
    and request_row.facility_id = actor_facility_id
    and request_row.scope = requested_scope
    and request_row.purpose_of_use = actor_purpose
    and request_row.status = 'pending'
    and not request_row.break_glass
    and request_row.migration_hold_reason is null
  order by request_row.created_at desc
  limit 1;

  if request_id_value is null then
    request_id_value := gen_random_uuid();
    request_duration_value := requested_duration_minutes;
    insert into identity.access_requests (
      id, patient_id, staff_id, membership_id, facility_id, scope,
      purpose_of_use, reason, status, requested_duration_minutes,
      break_glass, correlation_id
    ) values (
      request_id_value, patient_id_value, actor_staff_id, actor_membership_id,
      actor_facility_id, requested_scope, actor_purpose, btrim(requested_reason),
      'pending', requested_duration_minutes, false, actor_correlation_id
    )
    returning created_at into request_created_at;
  else
    replayed := true;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id,
    actor_membership_id, actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.access-request.replay' else 'identity.access-request.create' end,
    'success', 'access-request', request_id_value::text, actor_purpose,
    btrim(requested_reason), 'application', 'ehr-api',
    jsonb_build_object(
      'scope', requested_scope,
      'duration_minutes', request_duration_value,
      'existing_request', replayed
    )
  );

  return query select
    request_id_value, patient_id_value, 'pending'::text, requested_scope,
    actor_purpose, request_duration_value, request_created_at, replayed;
end;
$$;

comment on function identity.create_access_request(text, text, text, integer) is
  'Creates or reuses an exact-HID pending request after revalidating the current staff membership and permission; an unknown HID is answered alike with no patient, audited as refused and persisted nowhere else (0086).';

create or replace function identity.list_my_staff_access_requests(
  requested_status text default null
)
returns table (
  access_request_id uuid,
  patient_id uuid,
  scope text,
  purpose_of_use text,
  reason text,
  status text,
  requested_duration_minutes integer,
  requested_at timestamptz,
  approved_at timestamptz,
  denied_at timestamptz,
  denied_reason text,
  consent_grant_id uuid,
  grant_expires_at timestamptz,
  effective_status text,
  authorization_method text
)
language plpgsql
security definer
set search_path = identity, auth, platform, pg_catalog, pg_temp
as $$
declare
  actor_subject_value text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject_value);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
begin
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or not auth.membership_has_permission(
       actor_subject_value, actor_membership_id, actor_facility_id, 'identity.consent.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized consent read context is required';
  end if;

  if requested_status is not null
     and requested_status not in ('pending', 'approved', 'denied', 'revoked', 'expired', 'active', 'closed') then
    raise exception using errcode = '22023', message = 'Invalid access request status';
  end if;

  return query
  -- The patient is named only while the grant made from the request is
  -- active, so a request for a guessed HID never yields the patient id
  -- without the patient's consent (PSEARCH-1, 0086).
  select outcome.request_id,
         case when outcome.outcome_status = 'active' then outcome.request_patient_id end,
         outcome.request_scope, outcome.request_purpose,
         outcome.request_reason, outcome.request_status, outcome.request_duration, outcome.request_created_at,
         outcome.request_approved_at, outcome.request_denied_at, outcome.request_denied_reason,
         outcome.grant_id, outcome.grant_expiry, outcome.outcome_status, outcome.grant_method
    from (
      select request_row.id as request_id,
             request_row.patient_id as request_patient_id,
             request_row.scope as request_scope,
             request_row.purpose_of_use as request_purpose,
             request_row.reason as request_reason,
             request_row.status as request_status,
             request_row.requested_duration_minutes as request_duration,
             request_row.created_at as request_created_at,
             request_row.approved_at as request_approved_at,
             request_row.denied_at as request_denied_at,
             request_row.denied_reason as request_denied_reason,
             grant_row.id as grant_id,
             grant_row.expires_at as grant_expiry,
             case
               when request_row.status <> 'approved' or grant_row.id is null then request_row.status
               when grant_row.status = 'active' and grant_row.expires_at > clock_timestamp() then 'active'
               -- Only a revocation before the grant lapsed ends it; a later sweep
               -- (a PIN change, account deletion) does not change its outcome.
               when grant_row.status = 'revoked' and grant_row.revoked_at < grant_row.expires_at
                    and grant_row.revoked_by = grant_row.account_id then 'closed'
               when grant_row.status = 'revoked' and grant_row.revoked_at < grant_row.expires_at then 'revoked'
               else 'expired'
             end as outcome_status,
             case
               when grant_row.id is null then null
               when grant_row.authorization_method = 'patient_access_pin' then 'patient_access_pin'
               else 'patient_approval'
             end as grant_method
        from identity.access_requests request_row
        left join lateral (
          select candidate.id, candidate.status, candidate.expires_at, candidate.revoked_at,
                 candidate.revoked_by, candidate.account_id, candidate.authorization_method
            from identity.consent_grants candidate
           where candidate.request_id = request_row.id
           order by candidate.created_at desc
           limit 1
        ) grant_row on true
       where request_row.staff_id = (
               select membership.staff_id
                 from identity.staff_facility_memberships membership
                where membership.id = actor_membership_id
                  and membership.account_id = actor_account_id
                  and membership.facility_id = actor_facility_id
             )
         and request_row.membership_id = actor_membership_id
         and request_row.facility_id = actor_facility_id
         and request_row.break_glass = false
         and request_row.migration_hold_reason is null
    ) outcome
   where requested_status is null
      or outcome.request_status = requested_status
      or outcome.outcome_status = requested_status
   order by outcome.request_created_at desc, outcome.request_id desc
   limit 100;
end;
$$;

comment on function identity.list_my_staff_access_requests(text) is
  'The calling clinician''s own non-break-glass access requests at the current facility, with the outcome of each approval (0074); the patient id only while the grant made from the request is active (0086).';
