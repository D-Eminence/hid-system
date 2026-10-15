-- Facility-assisted registration (ADR-063). Applied migrations 0001 through
-- 0093 are immutable.
--
-- A person who cannot use the online holder route of 0093 (no usable phone on
-- the NIN record, a lost or changed SIM, a code that cannot be completed)
-- proves that they hold the NIN in person at a participating facility. The
-- patient always starts the enrollment on their own device; at the desk the
-- phone shows a desk code, staff check one original photo ID, and the server
-- compares the name and date of birth the staff member types with the NIN
-- record without showing the record. Staff never see the NIN, the record, the
-- contact or the Health ID.
--
-- 1. The permission identity.patient.assisted_registration, on the doctor,
--    clinician and nurse roles only. A holder must also have an attested
--    workforce grant (0087) for the role that carries it:
--    identity.assisted_registration_actor_attested.
-- 2. identity.facility_assisted_registration: which facilities take part,
--    with the location a patient is shown, and its append-only events. Set
--    only by identity.admin_set_facility_assisted_registration, a platform
--    command (platform.facility.manage, a fresh step-up, a reason, the
--    expected version, an idempotency key). A facility takes part while its
--    designation is active and it and its organization are active.
-- 3. auth.staff_session_is_mfa: whether the request runs on a live staff
--    session of the actor with MFA assurance (0088), checked in SQL as well
--    as by the Identity guard.
-- 4. identity.assisted_registration_verifications: one append-only row per
--    in-person check (matched, not_matched or code_not_found), with digests,
--    the method, the document type and the staff member, facility and
--    membership; never a name, document number, contact or free text. Written
--    only by identity.record_assisted_verification in staff context, which
--    also charges the per-staff and per-facility daily budgets and writes the
--    staff audit row. The holder proof writes its outcome on the row once.
-- 5. Desk codes: the enrollment keeps a random salt for the code it shows to
--    the cookie holder and counts the codes it issued (at most 5).
-- 6. identity.record_public_patient_holder_proof (0093's command, same
--    signature, owner, search_path and grants) accepts facility_in_person
--    with a matched verification of this enrollment and its current desk
--    code, recorded in the last 10 minutes, by a staff member who is still
--    authorized at a participating facility. The proof clears the desk code.
-- 7. identity.activate_public_patient_enrollment (same signature) accepts a
--    facility_in_person proof and re-checks the designation and the verifying
--    membership.
-- 8. identity.list_participating_facilities: the public facility list, read
--    in system context.
--
-- No runtime role has a table privilege on the three new tables; FORCE row
-- level security keeps the definer commands to their own contexts.
--
-- Locks: ACCESS EXCLUSIVE on identity.public_patient_enrollments while its two
-- columns and checks are added (no rewrite; the checks scan the table), within
-- the runner's 5 s lock timeout. Everything else creates new objects or
-- replaces functions. A timeout rolls 0094 back whole, and it can be run again.

-- 1. The permission.
insert into auth.permissions (code, description) values
  ('identity.patient.assisted_registration',
   'Check a patient''s original photo ID in person and record the outcome for assisted registration (ADR-063)')
on conflict (code) do update set description = excluded.description, active = true;
insert into auth.role_permissions (role_code, permission_code) values
  ('doctor', 'identity.patient.assisted_registration'),
  ('clinician', 'identity.patient.assisted_registration'),
  ('nurse', 'identity.patient.assisted_registration')
on conflict (role_code, permission_code) do nothing;

-- 2. Participating facilities.
create table identity.facility_assisted_registration (
  facility_id uuid primary key references identity.facilities(id) on delete restrict,
  status text not null check (status in ('active', 'suspended')),
  address_line text check (address_line is null
    or (length(address_line) between 1 and 200 and address_line = btrim(address_line) and address_line !~ '[[:cntrl:]]')),
  town text not null check (length(town) between 1 and 120 and town = btrim(town) and town !~ '[[:cntrl:]]'),
  lga text not null check (length(lga) between 1 and 120 and lga = btrim(lga) and lga !~ '[[:cntrl:]]'),
  state text not null check (length(state) between 1 and 120 and state = btrim(state) and state !~ '[[:cntrl:]]'),
  hours text check (hours is null
    or (length(hours) between 1 and 200 and hours = btrim(hours) and hours !~ '[[:cntrl:]]')),
  reason text not null check (length(reason) between 8 and 500 and reason = btrim(reason)),
  row_version bigint not null default 1 check (row_version > 0),
  updated_by uuid not null references auth.accounts(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
comment on table identity.facility_assisted_registration is
  'ADR-063: facilities designated for in-person NIN holder checks, with the location patients are shown. Set only by identity.admin_set_facility_assisted_registration.';

create table identity.facility_assisted_registration_events (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  from_status text check (from_status is null or from_status in ('active', 'suspended')),
  to_status text not null check (to_status in ('active', 'suspended')),
  designation_version bigint not null check (designation_version > 0),
  address_line text,
  town text not null,
  lga text not null,
  state text not null,
  hours text,
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  reason text not null check (length(reason) between 8 and 500),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  occurred_at timestamptz not null default clock_timestamp()
);
create index facility_assisted_registration_events_facility_idx
  on identity.facility_assisted_registration_events (facility_id, occurred_at);
create trigger facility_assisted_registration_events_no_mutation
  before update or delete on identity.facility_assisted_registration_events
  for each row execute function platform.reject_mutation();
comment on table identity.facility_assisted_registration_events is
  'ADR-063: append-only history of facility designations for assisted registration.';

alter table identity.facility_assisted_registration enable row level security;
alter table identity.facility_assisted_registration force row level security;
alter table identity.facility_assisted_registration_events enable row level security;
alter table identity.facility_assisted_registration_events force row level security;
-- Read in system context (the public list, the holder proof, activation), by
-- the staff command for its own facility, and by platform administrators.
create policy facility_assisted_registration_read on identity.facility_assisted_registration for select
  using (platform.current_actor_subject() = 'system:auth'
    or facility_id = platform.current_facility_id()
    or (platform.current_access_scope() = 'platform'
      and auth.account_has_platform_permission(platform.current_account_id(), 'platform.facility.read')));
create policy facility_assisted_registration_insert on identity.facility_assisted_registration for insert
  with check (platform.current_access_scope() = 'platform'
    and auth.account_has_platform_permission(platform.current_account_id(), 'platform.facility.manage'));
create policy facility_assisted_registration_update on identity.facility_assisted_registration for update
  using (platform.current_access_scope() = 'platform'
    and auth.account_has_platform_permission(platform.current_account_id(), 'platform.facility.manage'))
  with check (platform.current_access_scope() = 'platform'
    and auth.account_has_platform_permission(platform.current_account_id(), 'platform.facility.manage'));
create policy facility_assisted_registration_events_insert on identity.facility_assisted_registration_events
  for insert with check (platform.current_access_scope() = 'platform'
    and auth.account_has_platform_permission(platform.current_account_id(), 'platform.facility.manage'));
create policy facility_assisted_registration_events_read on identity.facility_assisted_registration_events
  for select using (platform.current_access_scope() = 'platform'
    and auth.account_has_platform_permission(platform.current_account_id(), 'platform.facility.read'));
revoke all on identity.facility_assisted_registration, identity.facility_assisted_registration_events from public;

-- A facility takes part while its designation is active and the facility
-- (verified) and its organization are active.
create function identity.facility_assisted_registration_participating(requested_facility_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, identity, pg_temp
as $$
  select exists (
    select 1
    from identity.facility_assisted_registration designation
    join identity.facilities facility on facility.id = designation.facility_id
    join identity.organizations organization_row on organization_row.id = facility.organization_id
    where designation.facility_id = requested_facility_id
      and designation.status = 'active'
      and facility.active
      and facility.lifecycle_status = 'verified'
      and organization_row.active
  )
$$;
revoke all on function identity.facility_assisted_registration_participating(uuid) from public;

-- The public list, read in system context: name and location only, no ids.
create function identity.list_participating_facilities()
returns table (name text, address_line text, town text, lga text, state text, hours text)
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth' then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  return query
    select facility.name, designation.address_line, designation.town, designation.lga, designation.state,
           designation.hours
    from identity.facility_assisted_registration designation
    join identity.facilities facility on facility.id = designation.facility_id
    join identity.organizations organization_row on organization_row.id = facility.organization_id
    where designation.status = 'active' and facility.active and facility.lifecycle_status = 'verified'
      and organization_row.active
    order by designation.state, designation.lga, designation.town, facility.name, facility.id
    limit 500;
end
$$;
revoke all on function identity.list_participating_facilities() from public;

-- The platform read of one designation (none: no row).
create function identity.admin_facility_assisted_registration(requested_facility_id uuid)
returns table (facility_id uuid, status text, address_line text, town text, lga text, state text, hours text,
  reason text, row_version bigint, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null or platform.current_access_scope() is distinct from 'platform'
     or not auth.account_has_platform_permission(actor_account, 'platform.facility.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return query
    select designation.facility_id, designation.status, designation.address_line, designation.town,
           designation.lga, designation.state, designation.hours, designation.reason, designation.row_version,
           designation.updated_at
    from identity.facility_assisted_registration designation
    where designation.facility_id = requested_facility_id;
end
$$;
revoke all on function identity.admin_facility_assisted_registration(uuid) from public;

-- Designates a facility, changes its location or suspends it. Version 0
-- creates the designation (active only); every later change names the
-- current version. Same idempotency contract as 0027.
create function identity.admin_set_facility_assisted_registration(
  requested_facility_id uuid,
  expected_version bigint,
  requested_status text,
  requested_address_line text,
  requested_town text,
  requested_lga text,
  requested_state text,
  requested_hours text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (facility_id uuid, status text, row_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  prior auth.admin_command_idempotency%rowtype;
  facility_row identity.facilities%rowtype;
  current_row identity.facility_assisted_registration%rowtype;
  previous_status text;
  address_value text := nullif(btrim(coalesce(requested_address_line, '')), '');
  town_value text := btrim(coalesce(requested_town, ''));
  lga_value text := btrim(coalesce(requested_lga, ''));
  state_value text := btrim(coalesce(requested_state, ''));
  hours_value text := nullif(btrim(coalesce(requested_hours, '')), '');
  reason_value text := btrim(coalesce(requested_reason, ''));
  response jsonb;
begin
  if actor_account is null or platform.current_access_scope() is distinct from 'platform'
     or not auth.account_has_platform_permission(actor_account, 'platform.facility.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  perform auth.require_platform_step_up(actor_account);
  if requested_status is null or requested_status not in ('active', 'suspended')
     or expected_version is null or expected_version < 0
     or length(reason_value) not between 8 and 500
     or length(town_value) not between 1 and 120 or length(lga_value) not between 1 and 120
     or length(state_value) not between 1 and 120
     or (address_value is not null and length(address_value) > 200)
     or (hours_value is not null and length(hours_value) > 200)
     or concat_ws(' ', address_value, town_value, lga_value, state_value, hours_value) ~ '[[:cntrl:]]'
     or requested_idempotency_key is null or requested_sha256 is null or requested_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_ASSISTED_REGISTRATION';
  end if;
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'facility.assisted-registration'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'facilityId')::uuid, prior.response->>'status',
      (prior.response->>'version')::bigint, true;
    return;
  end if;
  -- One designation change of a facility at a time; the facility row is
  -- read under a share lock, so a status change waits for it (and it for one).
  perform pg_advisory_xact_lock(hashtextextended('facility-assisted-registration:' || requested_facility_id::text, 0));
  select * into facility_row from identity.facilities facility where facility.id = requested_facility_id for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'ADMIN_FACILITY_NOT_FOUND';
  end if;
  select * into current_row from identity.facility_assisted_registration designation
    where designation.facility_id = requested_facility_id for update;
  if not found then
    if expected_version <> 0 then
      raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
    end if;
    if requested_status <> 'active' then
      raise exception using errcode = '22023', message = 'ADMIN_INVALID_ASSISTED_REGISTRATION';
    end if;
  elsif current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  elsif current_row.status = requested_status
     and current_row.address_line is not distinct from address_value and current_row.town = town_value
     and current_row.lga = lga_value and current_row.state = state_value
     and current_row.hours is not distinct from hours_value then
    raise exception using errcode = '22023', message = 'ADMIN_NO_STATE_CHANGE';
  end if;
  if requested_status = 'active' and not (facility_row.active and facility_row.lifecycle_status = 'verified'
      and exists (select 1 from identity.organizations organization_row
        where organization_row.id = facility_row.organization_id and organization_row.active)) then
    raise exception using errcode = '55000', message = 'ASSISTED_REGISTRATION_FACILITY_INACTIVE';
  end if;
  previous_status := current_row.status;
  if current_row.facility_id is null then
    insert into identity.facility_assisted_registration (facility_id, status, address_line, town, lga, state, hours,
      reason, updated_by)
    values (requested_facility_id, requested_status, address_value, town_value, lga_value, state_value, hours_value,
      reason_value, actor_account)
    returning * into current_row;
  else
    update identity.facility_assisted_registration designation
       set status = requested_status, address_line = address_value, town = town_value, lga = lga_value,
           state = state_value, hours = hours_value, reason = reason_value, updated_by = actor_account,
           updated_at = clock_timestamp(), row_version = designation.row_version + 1
     where designation.facility_id = requested_facility_id
    returning * into current_row;
  end if;
  insert into identity.facility_assisted_registration_events (facility_id, from_status, to_status,
    designation_version, address_line, town, lga, state, hours, actor_account_id, reason, correlation_id)
  values (current_row.facility_id, previous_status, current_row.status, current_row.row_version,
    current_row.address_line, current_row.town, current_row.lga, current_row.state, current_row.hours,
    actor_account, reason_value, platform.current_correlation_id());
  response := jsonb_build_object('facilityId', current_row.facility_id, 'status', current_row.status,
    'version', current_row.row_version);
  insert into auth.admin_command_idempotency (actor_account_id, operation, idempotency_key, request_sha256, response)
  values (actor_account, 'facility.assisted-registration', requested_idempotency_key, requested_sha256, response);
  return query select current_row.facility_id, current_row.status, current_row.row_version, false;
end
$$;
revoke all on function identity.admin_set_facility_assisted_registration(uuid, bigint, text, text, text, text, text,
  text, text, text, char) from public;

-- 3. Staff session assurance in SQL: the request's session is a live staff
-- session of the actor, at the account's token version, with MFA assurance on
-- an active factor (0088).
create function auth.staff_session_is_mfa()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, auth, platform, pg_temp
as $$
  select exists (
    select 1
    from auth.sessions session_row
    join auth.accounts account_row on account_row.id = session_row.account_id
    join auth.session_assurance assurance
      on assurance.family_id = session_row.family_id and assurance.account_id = session_row.account_id
    join auth.mfa_factors factor
      on factor.id = assurance.mfa_factor_id and factor.account_id = session_row.account_id
     and factor.status = 'active'
    where session_row.id = platform.current_session_id()
      and account_row.subject = platform.current_actor_subject()
      and session_row.session_kind = 'staff'
      and session_row.revoked_at is null
      and session_row.expires_at > clock_timestamp()
      and session_row.absolute_expires_at > clock_timestamp()
      and session_row.account_token_version = account_row.token_version
      and account_row.status = 'active'
      and (account_row.disabled_until is null or account_row.disabled_until <= clock_timestamp())
  )
$$;
revoke all on function auth.staff_session_is_mfa() from public;

-- 1 (cont.). A holder of the permission whose role at this facility rests on
-- a current credential attestation (0087). Onboarding and legacy roles, which
-- have no workforce grant, never qualify.
create function identity.assisted_registration_actor_attested(request_subject text, request_membership_id uuid,
  request_facility_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, auth, identity, pg_temp
as $$
  select exists (
    select 1
    from auth.accounts account_row
    join auth.account_roles assignment
      on assignment.account_id = account_row.id
     and assignment.membership_id = request_membership_id
     and assignment.facility_id = request_facility_id
     and assignment.scope_type = 'facility'
     and assignment.revoked_at is null
    join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
    join auth.role_permissions role_permission
      on role_permission.role_code = role_row.code
     and role_permission.permission_code = 'identity.patient.assisted_registration'
    join auth.permissions permission_row on permission_row.code = role_permission.permission_code and permission_row.active
    join identity.workforce_role_grants role_grant
      on role_grant.account_role_id = assignment.id
     and role_grant.account_id = account_row.id
     and role_grant.membership_id = request_membership_id
     and role_grant.facility_id = request_facility_id
     and role_grant.role_code = assignment.role_code
    join identity.staff_credential_attestations attestation
      on attestation.id = role_grant.attestation_id
     and attestation.account_id = account_row.id
     and attestation.valid_until > clock_timestamp()
     and assignment.role_code = any (attestation.attested_roles)
    where account_row.subject = request_subject
  )
$$;
revoke all on function identity.assisted_registration_actor_attested(text, uuid, uuid) from public;

-- 4. In-person checks.
create table identity.assisted_registration_verifications (
  id uuid primary key,
  enrollment_id uuid,
  nin_digest char(64) check (nin_digest is null or nin_digest ~ '^[0-9a-f]{64}$'),
  desk_code_hmac char(64) not null check (desk_code_hmac ~ '^[0-9a-f]{64}$'),
  method text not null check (method = 'government_photo_id_in_person'),
  document_type text not null
    check (document_type in ('national_id_card', 'international_passport', 'drivers_licence', 'voters_card')),
  outcome text not null check (outcome in ('matched', 'not_matched', 'code_not_found')),
  first_name_result text check (first_name_result in ('match', 'no_match')),
  last_name_result text check (last_name_result in ('match', 'no_match')),
  date_of_birth_result text check (date_of_birth_result in ('match', 'no_match', 'not_in_record')),
  staff_account_id uuid not null references auth.accounts(id) on delete restrict,
  membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  request_key_hmac char(64) not null check (request_key_hmac ~ '^[0-9a-f]{64}$'),
  request_hmac char(64) not null check (request_hmac ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  verified_at timestamptz not null default clock_timestamp(),
  proof_outcome text check (proof_outcome in ('verified', 'existing_identity')),
  proof_recorded_at timestamptz,
  constraint assisted_registration_verifications_key_uq unique (staff_account_id, request_key_hmac),
  constraint assisted_registration_verifications_enrollment_check
    check ((outcome = 'code_not_found') = (enrollment_id is null) and (enrollment_id is null) = (nin_digest is null)),
  constraint assisted_registration_verifications_results_check
    check ((outcome = 'code_not_found') = (first_name_result is null)
      and (first_name_result is null) = (last_name_result is null)
      and (first_name_result is null) = (date_of_birth_result is null)),
  constraint assisted_registration_verifications_matched_check
    check ((outcome = 'matched') = coalesce(first_name_result = 'match' and last_name_result = 'match'
      and date_of_birth_result in ('match', 'not_in_record'), false)),
  constraint assisted_registration_verifications_proof_check
    check ((proof_outcome is null) = (proof_recorded_at is null) and (proof_outcome is null or outcome = 'matched'))
);
create index assisted_registration_verifications_staff_idx
  on identity.assisted_registration_verifications (staff_account_id, verified_at);
create index assisted_registration_verifications_facility_idx
  on identity.assisted_registration_verifications (facility_id, verified_at);
create index assisted_registration_verifications_enrollment_idx
  on identity.assisted_registration_verifications (enrollment_id) where enrollment_id is not null;
comment on table identity.assisted_registration_verifications is
  'ADR-063: one append-only row per in-person check, with digests and outcomes only (never a name, document number, contact or free text). Written by identity.record_assisted_verification; the holder proof records its outcome once.';

-- Append-only, except the proof outcome, written once on a matched check.
create function identity.guard_assisted_verification_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' or old.proof_outcome is not null or new.proof_outcome is null
     or (to_jsonb(new) - 'proof_outcome' - 'proof_recorded_at') <> (to_jsonb(old) - 'proof_outcome' - 'proof_recorded_at') then
    raise exception using errcode = '55000', message = 'ASSISTED_VERIFICATION_IMMUTABLE';
  end if;
  return new;
end
$$;
revoke all on function identity.guard_assisted_verification_change() from public;
create trigger assisted_registration_verifications_guard
  before update or delete on identity.assisted_registration_verifications
  for each row execute function identity.guard_assisted_verification_change();

alter table identity.assisted_registration_verifications enable row level security;
alter table identity.assisted_registration_verifications force row level security;
-- Staff context: a check is recorded only for the bound facility and
-- membership. A staff member's own rows at another facility are read only to
-- count the per-staff budget; nothing else of another facility is visible.
create policy assisted_registration_verifications_staff_insert on identity.assisted_registration_verifications
  for insert with check (facility_id = platform.current_facility_id()
    and membership_id = platform.current_membership_id()
    and staff_account_id = auth.account_id_for_subject(platform.current_actor_subject()));
create policy assisted_registration_verifications_staff_read on identity.assisted_registration_verifications
  for select using (facility_id = platform.current_facility_id()
    or staff_account_id = auth.account_id_for_subject(platform.current_actor_subject()));
-- System context: the holder proof and activation read a check; the proof
-- writes its outcome once (the guard above).
create policy assisted_registration_verifications_system_read on identity.assisted_registration_verifications
  for select using (platform.current_actor_subject() = 'system:auth');
create policy assisted_registration_verifications_system_update on identity.assisted_registration_verifications
  for update using (platform.current_actor_subject() = 'system:auth')
  with check (platform.current_actor_subject() = 'system:auth');
revoke all on identity.assisted_registration_verifications from public;

-- The staff command: authorizes the actor in SQL, charges the budgets and
-- appends the check with its staff audit row. Identity reads the enrollment a
-- desk code names and compares the typed name and date of birth with the NIN
-- record in system context first; this command never reads an enrollment.
-- The same key replays the stored check (another request under the key is
-- refused); a replay is not charged.
create function identity.record_assisted_verification(
  requested_enrollment_id uuid, requested_nin_digest char(64), requested_desk_code_hmac char(64),
  requested_method text, requested_document_type text, requested_outcome text,
  requested_first_name_result text, requested_last_name_result text, requested_date_of_birth_result text,
  requested_key_hmac char(64), requested_request_hmac char(64),
  staff_daily_limit integer, facility_daily_limit integer
) returns table (verification_id uuid, outcome text, first_name_result text, last_name_result text,
  date_of_birth_result text, enrollment_id uuid, correlation_id text, proof_outcome text, verified_at timestamptz,
  replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_organization uuid;
  prior identity.assisted_registration_verifications%rowtype;
  recorded identity.assisted_registration_verifications%rowtype;
begin
  if actor_account is null or actor_membership is null or actor_facility is null
     or platform.current_correlation_id() is null
     or not auth.staff_session_is_mfa()
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
       'identity.patient.assisted_registration')
     or not identity.assisted_registration_actor_attested(actor_subject, actor_membership, actor_facility)
     or not identity.facility_assisted_registration_participating(actor_facility) then
    raise exception using errcode = '42501', message = 'ASSISTED_REGISTRATION_NOT_AUTHORIZED';
  end if;
  if staff_daily_limit is null or facility_daily_limit is null
     or staff_daily_limit not between 1 and 200 or facility_daily_limit not between 1 and 1000
     or requested_method is distinct from 'government_photo_id_in_person'
     or requested_document_type is null
     or requested_document_type not in ('national_id_card', 'international_passport', 'drivers_licence', 'voters_card')
     or requested_outcome is null or requested_outcome not in ('matched', 'not_matched', 'code_not_found')
     or requested_desk_code_hmac is null or requested_desk_code_hmac !~ '^[0-9a-f]{64}$'
     or requested_key_hmac is null or requested_key_hmac !~ '^[0-9a-f]{64}$'
     or requested_request_hmac is null or requested_request_hmac !~ '^[0-9a-f]{64}$'
     or (requested_outcome = 'code_not_found') <> (requested_enrollment_id is null)
     or (requested_enrollment_id is null) <> (requested_nin_digest is null)
     or (requested_nin_digest is not null and requested_nin_digest !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = '22023', message = 'ASSISTED_VERIFICATION_INVALID';
  end if;
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.facility_id = actor_facility;
  -- One staff member, then one facility, at a time: the budgets are counted
  -- and charged without a race, and a retry under the same key waits for the
  -- first request and replays it.
  perform pg_advisory_xact_lock(hashtextextended('assisted-verification-staff:' || actor_account::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('assisted-verification-facility:' || actor_facility::text, 0));
  select * into prior from identity.assisted_registration_verifications verification
   where verification.staff_account_id = actor_account and verification.request_key_hmac = requested_key_hmac;
  if found then
    if prior.request_hmac <> requested_request_hmac or prior.facility_id <> actor_facility
       or prior.membership_id <> actor_membership then
      raise exception using errcode = '23505', message = 'ASSISTED_VERIFICATION_KEY_REUSED';
    end if;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance,
      source_system, details)
    values (platform.current_correlation_id(), 'staff', actor_subject, actor_account, actor_membership,
      actor_organization, actor_facility, 'identity.assisted-verification.replay',
      case when prior.outcome = 'matched' then 'success' else 'denied' end, 'assisted-verification',
      prior.id::text, platform.current_purpose_of_use(), 'application', 'identity-api',
      jsonb_build_object('method', prior.method, 'documentType', prior.document_type, 'outcome', prior.outcome,
        'ninDigest', prior.nin_digest));
    return query select prior.id, prior.outcome, prior.first_name_result, prior.last_name_result,
      prior.date_of_birth_result, prior.enrollment_id, prior.correlation_id, prior.proof_outcome,
      prior.verified_at, true;
    return;
  end if;
  -- Sliding 24-hour budgets; every outcome counts.
  if (select count(*) from identity.assisted_registration_verifications verification
      where verification.staff_account_id = actor_account
        and verification.verified_at > clock_timestamp() - interval '24 hours') >= staff_daily_limit
     or (select count(*) from identity.assisted_registration_verifications verification
      where verification.facility_id = actor_facility
        and verification.verified_at > clock_timestamp() - interval '24 hours') >= facility_daily_limit then
    raise exception using errcode = '54000', message = 'ASSISTED_VERIFICATION_LIMITED';
  end if;
  insert into identity.assisted_registration_verifications (id, enrollment_id, nin_digest, desk_code_hmac, method,
    document_type, outcome, first_name_result, last_name_result, date_of_birth_result, staff_account_id,
    membership_id, facility_id, request_key_hmac, request_hmac, correlation_id)
  values (gen_random_uuid(), requested_enrollment_id, requested_nin_digest, requested_desk_code_hmac,
    requested_method, requested_document_type, requested_outcome,
    case when requested_outcome <> 'code_not_found' then requested_first_name_result end,
    case when requested_outcome <> 'code_not_found' then requested_last_name_result end,
    case when requested_outcome <> 'code_not_found' then requested_date_of_birth_result end,
    actor_account, actor_membership, actor_facility, requested_key_hmac, requested_request_hmac,
    platform.current_correlation_id())
  returning * into recorded;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance,
    source_system, details)
  values (platform.current_correlation_id(), 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, 'identity.assisted-verification.record',
    case when recorded.outcome = 'matched' then 'success' else 'denied' end, 'assisted-verification',
    recorded.id::text, platform.current_purpose_of_use(), 'application', 'identity-api',
    jsonb_build_object('method', recorded.method, 'documentType', recorded.document_type,
      'outcome', recorded.outcome, 'ninDigest', recorded.nin_digest));
  return query select recorded.id, recorded.outcome, recorded.first_name_result, recorded.last_name_result,
    recorded.date_of_birth_result, recorded.enrollment_id, recorded.correlation_id, recorded.proof_outcome,
    recorded.verified_at, false;
end
$$;
revoke all on function identity.record_assisted_verification(uuid, char, char, text, text, text, text, text, text,
  char, char, integer, integer) from public;

-- 5. Desk codes. The code a cookie holder is shown is derived from the cookie
-- and this salt, so it is never stored; desk_code_hmac is its keyed digest.
-- A desk code exists only while the enrollment waits for a holder proof and
-- never outlives it; one enrollment issues at most five.
alter table identity.public_patient_enrollments
  add column desk_code_salt char(32),
  add column desk_code_issues smallint not null default 0;
alter table identity.public_patient_enrollments
  add constraint public_patient_enrollments_desk_code_salt_check
    check ((desk_code_salt is null or desk_code_salt ~ '^[0-9a-f]{32}$')
      and ((desk_code_salt is null) = (desk_code_hmac is null))),
  add constraint public_patient_enrollments_desk_code_issues_check check (desk_code_issues between 0 and 5),
  add constraint public_patient_enrollments_desk_code_stage_check
    check (desk_code_hmac is null or (state = 'verify_holder' and desk_code_expires_at <= expires_at));
comment on column identity.public_patient_enrollments.desk_code_hmac is
  'Keyed digest of the desk code the enrollment shows at a participating facility (ADR-063); the code is never stored.';

-- 6. The holder proof accepts the in-person method. Lock order as 0093: the
-- NIN advisory lock, the enrollment row, then (in person) the check row,
-- then the other enrollments of the NIN in id order, then the holder budget
-- locks. Returns as 0093; an in-person proof never answers facility_conflict
-- or route_limited.
create or replace function identity.record_public_patient_holder_proof(
  requested_enrollment_id uuid, requested_token_hmac char(64), requested_method text,
  requested_challenge_id uuid, requested_verification_id uuid, requested_nin_digest char(64),
  distinct_nins_limit integer
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, migration, audit, platform, public, pg_temp
as $$
declare
  lookup_hmac char(64);
  enrollment identity.public_patient_enrollments%rowtype;
  challenge identity.public_patient_enrollment_otps%rowtype;
  verification identity.assisted_registration_verifications%rowtype;
  verifier_subject text;
  existing_binding text;
  superseded_count integer;
  superseded_methods jsonb;
  contested boolean;
  proved_at timestamptz;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
    or platform.current_correlation_id() is null
    or requested_nin_digest is null or requested_nin_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if not coalesce((requested_method = 'registry_phone_otp' and requested_challenge_id is not null
        and requested_verification_id is null)
      or (requested_method = 'facility_in_person' and requested_verification_id is not null
        and requested_challenge_id is null), false) then
    raise exception using errcode = '22023', message = 'PATIENT_HOLDER_METHOD_UNAVAILABLE';
  end if;
  if distinct_nins_limit is null or distinct_nins_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'PATIENT_HOLDER_LIMIT_INVALID';
  end if;
  -- The NIN lock comes before any row lock (ADR-062).
  select candidate.nin_lookup_hmac into lookup_hmac from identity.public_patient_enrollments candidate
    where candidate.id = requested_enrollment_id;
  if not found then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-nin:' || lookup_hmac, 0));
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.token_hmac <> requested_token_hmac
    or enrollment.nin_lookup_hmac <> lookup_hmac
    or enrollment.state <> 'verify_holder' or enrollment.expires_at <= clock_timestamp() then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if not identity.public_patient_enrollment_ready() then
    raise exception using errcode = '55000', message = 'PATIENT_ENROLLMENT_RECONCILIATION_REQUIRED';
  end if;
  if requested_method = 'registry_phone_otp' then
    select * into challenge from identity.public_patient_enrollment_otps
      where id = requested_challenge_id and enrollment_id = enrollment.id for update;
    if not found or challenge.purpose <> 'nin_holder' or challenge.channel <> 'phone'
      or enrollment.holder_recipient_hmac is null
      or challenge.recipient_hmac <> enrollment.holder_recipient_hmac
      or challenge.consumed_at is not null or challenge.invalidated_at is not null
      or challenge.verified_at is not null
      or challenge.expires_at <= clock_timestamp()
      or challenge.failed_attempts >= challenge.max_attempts
      or challenge.delivery_outcome = 'definitive_failure' then
      raise exception using errcode = '23514', message = 'PATIENT_HOLDER_PROOF_INVALID';
    end if;
  else
    -- 0094 (ADR-063): a matched in-person check of this enrollment and its
    -- current desk code, made in the last 10 minutes and not yet used.
    select * into verification from identity.assisted_registration_verifications check_row
      where check_row.id = requested_verification_id for update;
    if not found or verification.outcome <> 'matched'
      or verification.method <> 'government_photo_id_in_person'
      or verification.enrollment_id is distinct from enrollment.id
      or verification.nin_digest is distinct from requested_nin_digest
      or verification.proof_outcome is not null
      or verification.verified_at <= clock_timestamp() - interval '10 minutes'
      or enrollment.desk_code_hmac is null
      or verification.desk_code_hmac <> enrollment.desk_code_hmac
      or enrollment.desk_code_expires_at <= clock_timestamp()
      or exists (select 1 from identity.public_patient_enrollments other
        where other.holder_verification_id = verification.id) then
      raise exception using errcode = '23514', message = 'PATIENT_HOLDER_PROOF_INVALID';
    end if;
    -- The verifying staff member is still authorized at a participating facility.
    select account_row.subject into verifier_subject from auth.accounts account_row
      where account_row.id = verification.staff_account_id;
    if verifier_subject is null
      or not identity.facility_assisted_registration_participating(verification.facility_id)
      or not auth.membership_has_permission(verifier_subject, verification.membership_id, verification.facility_id,
        'identity.patient.assisted_registration')
      or not identity.assisted_registration_actor_attested(verifier_subject, verification.membership_id,
        verification.facility_id) then
      raise exception using errcode = '42501', message = 'ASSISTED_REGISTRATION_NOT_AUTHORIZED';
    end if;
  end if;

  -- The existing-Health-ID check runs only after the proof (ADR-062).
  if identity.public_patient_nin_already_bound(enrollment.nin_lookup_hmac) then
    select coalesce(bound.holder_method, 'other') into existing_binding
      from identity.patient_identifiers identifier
      left join identity.public_patient_enrollments bound on bound.id = identifier.public_enrollment_id
     where identifier.identifier_type = 'nin' and identifier.lookup_hmac = enrollment.nin_lookup_hmac
     order by identifier.created_at limit 1;
    delete from identity.public_patient_enrollment_otps where enrollment_id = enrollment.id;
    delete from identity.public_patient_enrollments where id = enrollment.id;
    if requested_method = 'facility_in_person' then
      update identity.assisted_registration_verifications
         set proof_outcome = 'existing_identity', proof_recorded_at = clock_timestamp()
       where id = verification.id;
    end if;
    insert into audit.events(correlation_id, actor_type, action, resource_type, resource_id,
      outcome, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'system',
      'identity.public-patient-enrollment.existing-identity', 'public-patient-enrollment',
      enrollment.id::text, 'denied', 'patient-self', 'application', 'identity-api',
      jsonb_build_object('method', requested_method, 'ninDigest', requested_nin_digest,
        'existingBinding', coalesce(existing_binding, 'other')));
    return 'existing_identity';
  end if;

  -- Every other unfinished enrollment of this NIN, in id order.
  perform 1 from identity.public_patient_enrollments other
    where other.nin_lookup_hmac = enrollment.nin_lookup_hmac and other.id <> enrollment.id
      and other.state <> 'active'
    order by other.id for update;
  perform pg_advisory_xact_lock(hashtextextended('patient-holder-nin:' || requested_nin_digest, 0));
  if requested_method = 'registry_phone_otp' then
    perform pg_advisory_xact_lock(hashtextextended('patient-holder-phone:' || enrollment.holder_recipient_hmac, 0));
    -- One registry phone proves at most distinct_nins_limit other NINs a year.
    if (select count(distinct event.nin_digest) from identity.public_patient_holder_events event
        where event.kind = 'proof' and event.method = 'registry_phone_otp'
          and event.phone_digest = enrollment.holder_recipient_hmac
          and event.nin_digest <> requested_nin_digest
          and event.occurred_at > clock_timestamp() - interval '365 days') >= distinct_nins_limit then
      return 'route_limited';
    end if;
    -- An unexpired in-person proof is displaced only by another in-person proof.
    if exists (select 1 from identity.public_patient_enrollments other
      where other.nin_lookup_hmac = enrollment.nin_lookup_hmac and other.id <> enrollment.id
        and other.holder_method = 'facility_in_person'
        and other.state in ('verify_contact', 'set_password')
        and other.expires_at > clock_timestamp()) then
      return 'facility_conflict';
    end if;
  end if;

  select count(*), coalesce(jsonb_agg(distinct coalesce(other.holder_method, 'unproven')), '[]'::jsonb),
    coalesce(bool_or(other.holder_method is not null and other.holder_method <> requested_method), false)
    into superseded_count, superseded_methods, contested
    from identity.public_patient_enrollments other
   where other.nin_lookup_hmac = enrollment.nin_lookup_hmac and other.id <> enrollment.id
     and other.state <> 'active';
  if superseded_count > 0 then
    delete from identity.public_patient_enrollment_otps challenge_row
      using identity.public_patient_enrollments other
     where challenge_row.enrollment_id = other.id
       and other.nin_lookup_hmac = enrollment.nin_lookup_hmac and other.id <> enrollment.id
       and other.state <> 'active';
    delete from identity.public_patient_enrollments other
     where other.nin_lookup_hmac = enrollment.nin_lookup_hmac and other.id <> enrollment.id
       and other.state <> 'active';
    insert into audit.events(correlation_id, actor_type, action, resource_type, resource_id,
      outcome, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'system',
      case when contested then 'identity.public-patient-enrollment.contested'
        else 'identity.public-patient-enrollment.superseded' end,
      'public-patient-enrollment', enrollment.id::text, 'success', 'patient-self',
      'application', 'identity-api',
      jsonb_build_object('count', superseded_count, 'methods', superseded_methods,
        'ninDigest', requested_nin_digest));
  end if;

  proved_at := clock_timestamp();
  if requested_method = 'registry_phone_otp' then
    update identity.public_patient_enrollment_otps
       set verified_at = proved_at, consumed_at = proved_at
     where id = challenge.id;
    update identity.public_patient_enrollments
       set holder_method = requested_method, holder_verified_at = proved_at,
           holder_challenge_id = challenge.id, state = 'verify_contact',
           desk_code_hmac = null, desk_code_expires_at = null, desk_code_salt = null,
           updated_at = proved_at, row_version = row_version + 1
     where id = enrollment.id;
  else
    -- An open holder code would block the contact code (one open code per
    -- enrollment, 0051); it can no longer be used.
    update identity.public_patient_enrollment_otps
       set invalidated_at = proved_at, invalidation_reason = 'expired'
     where enrollment_id = enrollment.id and consumed_at is null and invalidated_at is null;
    update identity.public_patient_enrollments
       set holder_method = requested_method, holder_verified_at = proved_at,
           holder_verification_id = verification.id, state = 'verify_contact',
           desk_code_hmac = null, desk_code_expires_at = null, desk_code_salt = null,
           updated_at = proved_at, row_version = row_version + 1
     where id = enrollment.id;
    update identity.assisted_registration_verifications
       set proof_outcome = 'verified', proof_recorded_at = proved_at
     where id = verification.id;
  end if;
  insert into identity.public_patient_holder_events(kind, nin_digest, phone_digest, method)
    values ('proof', requested_nin_digest,
      case when requested_method = 'registry_phone_otp' then enrollment.holder_recipient_hmac end, requested_method);
  insert into audit.events(correlation_id, actor_type, action, resource_type, resource_id,
    outcome, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'system',
    'identity.public-patient-enrollment.holder-verified', 'public-patient-enrollment',
    enrollment.id::text, 'success', 'patient-self', 'application', 'identity-api',
    jsonb_build_object('method', requested_method, 'ninDigest', requested_nin_digest));
  return 'verified';
end
$$;

-- 7. Activation accepts an in-person proof. Everything else is 0093's.
create or replace function identity.activate_public_patient_enrollment(
  requested_enrollment_id uuid, requested_token_hmac char(64), requested_profile_json text,
  requested_contact text, requested_hid text, requested_password_hash text,
  requested_contact_lookup_hmac char(64),
  requested_date_of_birth date default null, requested_gender text default null
) returns table (patient_id uuid, hid_code text, account_id uuid, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, public, pg_temp
as $$
declare
  lookup_hmac char(64);
  enrollment identity.public_patient_enrollments%rowtype;
  verification identity.assisted_registration_verifications%rowtype;
  verifier_subject text;
  holder_proved_at timestamptz;
  profile jsonb;
  new_account uuid;
  new_patient uuid;
  normalized_email text;
  patient_dob date;
  patient_gender text;
  self_reported_fields jsonb := '[]'::jsonb;
begin
  if platform.current_actor_subject() <> 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if not identity.public_patient_enrollment_ready() then
    raise exception using errcode = '55000', message = 'PATIENT_ENROLLMENT_RECONCILIATION_REQUIRED';
  end if;
  -- 0093: the NIN lock before the row lock, the order of the holder proof.
  select candidate.nin_lookup_hmac into lookup_hmac from identity.public_patient_enrollments candidate
    where candidate.id = requested_enrollment_id;
  if not found then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-nin:' || lookup_hmac, 0));
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.token_hmac <> requested_token_hmac
    or enrollment.nin_lookup_hmac <> lookup_hmac then
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
      and challenge.purpose = 'contact'
      and challenge.channel = enrollment.contact_channel
      and challenge.recipient_hmac = enrollment.contact_hmac
      and challenge.verified_at is not null and challenge.verified_at <= challenge.expires_at
      and challenge.consumed_at is not null
      and challenge.invalidated_at is null) then
    raise exception using errcode = '23514', message = 'PATIENT_CONTACT_NOT_VERIFIED';
  end if;
  -- 0093 (ADR-062): a first activation needs a holder proof made before the
  -- contact proof.
  if enrollment.holder_verified_at is null or enrollment.holder_verified_at > enrollment.contact_verified_at then
    raise exception using errcode = '23514', message = 'PATIENT_HOLDER_PROOF_INVALID';
  end if;
  if enrollment.holder_method = 'registry_phone_otp' then
    -- A different, consumed code sent to the registry phone.
    if enrollment.holder_challenge_id is null
      or enrollment.holder_recipient_hmac is null
      or enrollment.holder_challenge_id = enrollment.verified_challenge_id
      or not exists (select 1 from identity.public_patient_enrollment_otps holder
        where holder.id = enrollment.holder_challenge_id and holder.enrollment_id = enrollment.id
          and holder.purpose = 'nin_holder' and holder.channel = 'phone'
          and holder.recipient_hmac = enrollment.holder_recipient_hmac
          and holder.verified_at is not null and holder.verified_at <= holder.expires_at
          and holder.consumed_at is not null and holder.invalidated_at is null) then
      raise exception using errcode = '23514', message = 'PATIENT_HOLDER_PROOF_INVALID';
    end if;
    holder_proved_at := enrollment.holder_verified_at;
  elsif enrollment.holder_method = 'facility_in_person' then
    -- 0094 (ADR-063): the matched in-person check this enrollment's proof
    -- recorded, by a staff member still authorized at a participating facility.
    select * into verification from identity.assisted_registration_verifications check_row
      where check_row.id = enrollment.holder_verification_id;
    if not found or verification.outcome <> 'matched'
      or verification.enrollment_id is distinct from enrollment.id
      or verification.proof_outcome is distinct from 'verified'
      or verification.verified_at > enrollment.holder_verified_at then
      raise exception using errcode = '23514', message = 'PATIENT_HOLDER_PROOF_INVALID';
    end if;
    select account_row.subject into verifier_subject from auth.accounts account_row
      where account_row.id = verification.staff_account_id;
    if verifier_subject is null
      or not identity.facility_assisted_registration_participating(verification.facility_id)
      or not auth.membership_has_permission(verifier_subject, verification.membership_id, verification.facility_id,
        'identity.patient.assisted_registration')
      or not identity.assisted_registration_actor_attested(verifier_subject, verification.membership_id,
        verification.facility_id) then
      raise exception using errcode = '23514', message = 'PATIENT_HOLDER_PROOF_INVALID';
    end if;
    holder_proved_at := verification.verified_at;
  else
    raise exception using errcode = '23514', message = 'PATIENT_HOLDER_PROOF_INVALID';
  end if;
  profile := requested_profile_json::jsonb;
  if jsonb_typeof(profile) <> 'object' or coalesce(profile->>'nin','') !~ '^[0-9]{11}$'
    or right(profile->>'nin',4) <> enrollment.nin_last4
    or coalesce(profile->>'firstName','') !~ '^[^[:cntrl:]]{1,100}$'
    or coalesce(profile->>'lastName','') !~ '^[^[:cntrl:]]{1,100}$'
    or coalesce(profile->>'providerReference','') <> enrollment.provider_reference then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
  -- 0092 (ADR-061): a date of birth or gender the NIN record gives is checked
  -- as before and cannot come from the request; one it lacks must. The format
  -- is checked before the cast, and a date that is not on the calendar is
  -- refused like any other invalid identity, not raised as a cast error.
  if profile->>'dateOfBirth' is not null then
    if profile->>'dateOfBirth' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or requested_date_of_birth is not null then
      raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
    end if;
    begin
      patient_dob := (profile->>'dateOfBirth')::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
    end;
  else
    patient_dob := requested_date_of_birth;
    self_reported_fields := self_reported_fields || '["dateOfBirth"]'::jsonb;
  end if;
  if patient_dob is null or patient_dob < date '1900-01-01' or patient_dob > current_date then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
  if profile->>'gender' is not null then
    if requested_gender is not null then
      raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
    end if;
    patient_gender := profile->>'gender';
  else
    patient_gender := requested_gender;
    self_reported_fields := self_reported_fields || '["gender"]'::jsonb;
  end if;
  if patient_gender is null or patient_gender not in ('female','male','intersex','other','unknown') then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
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
    btrim(profile->>'firstName') || ' ' || btrim(profile->>'lastName'),patient_gender,
    patient_dob,
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
    enrollment.id::text,'qoreid',enrollment.contact_verified_at,holder_proved_at);
  update identity.public_patient_enrollments set state = 'active', activated_at = clock_timestamp(),
    updated_at = clock_timestamp(), row_version = row_version + 1 where id = enrollment.id;
  insert into audit.events(correlation_id,actor_type,actor_subject,patient_id,
    action,resource_type,resource_id,outcome,purpose_of_use,provenance,source_system,details)
  values(platform.current_correlation_id(),'system',null,new_patient,
    'identity.public-patient-enrollment.activated','patient',new_patient::text,
    'success','patient-self','application','identity-api',
    jsonb_build_object('provider','qoreid','contactChannel',enrollment.contact_channel,
      'selfReportedFields',self_reported_fields,'holderMethod',enrollment.holder_method));
  return query select new_patient, requested_hid, new_account, false;
end
$$;
