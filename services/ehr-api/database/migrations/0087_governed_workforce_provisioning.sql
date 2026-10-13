-- Launch decisions D14 (workforce) and N5: governed clinician provisioning and
-- one resolvable membership per account and facility.
--
-- Until now the only writers of staff, memberships and facility roles were the
-- organization onboarding commands (0046, 0048, 0061), and each created one
-- org_admin. org_admin holds no clinical permission, so no clinician could be
-- provisioned without SQL. This migration adds platform-governed commands, run
-- only by a platform administrator holding the new permission
-- platform.workforce.manage (platform_super_admin only, as 0069 did for the
-- other high-risk platform permissions), with an MFA-verified platform session
-- and a TOTP step-up from the last five minutes:
--
-- * identity.admin_attach_workforce_member attaches an existing staff identity,
--   or creates a new one, at a verified facility. The membership is created
--   inactive ('pending'); it grants nothing until a clinical role is granted. A
--   new account is pending_reset with no password: the clinician sets one
--   through the account recovery flow, and nobody else ever knows it. A new
--   staff record is 'pending' and cannot sign in.
-- * identity.admin_record_credential_attestation records a reviewer's
--   professional-credential attestation for a staff identity: which clinical
--   roles the reviewed licence supports, its reference and issuing authority,
--   the evidence reference, the method (documented manual review; a registry
--   check is an open product and legal decision) and when it lapses. A
--   'pending' staff record becomes 'verified'.
-- * identity.admin_change_workforce_role grants or revokes exactly one clinical
--   facility role on exactly one membership. A grant needs a current
--   attestation for that role by a reviewer who is not the target, has no
--   active membership at that facility (its org_admin included) and is not the
--   granting administrator, so a clinical role always takes two platform
--   administrators. The grant is refused for the caller's own membership, to a
--   caller who works at that facility, for a membership at another facility
--   than the one named, and on a membership holding org_admin or admin
--   (org_admin stays non-clinical). Granting is limited to doctor, clinician
--   and nurse; lab and pharmacist are withheld with their modules at launch
--   (D17) but can be revoked. The first grant activates a pending membership.
-- * identity.admin_end_workforce_membership ends one membership: it is
--   deactivated for good, its facility roles are revoked, the consent grants
--   bound to it are revoked, its pending access requests expire, and the
--   account's staff sessions are revoked (a staff session is not bound to a
--   facility in the schema, so all of them; a pending membership never
--   authorized one, so ending it revokes none).
-- * identity.admin_workforce_profile reads one account's staff record,
--   attestations and memberships for the administration UI.
--
-- A clinical role granted through these commands stays effective only while
-- its attestation is current: the staff context and auth.membership_has_permission
-- ignore a role whose attestation has lapsed (auth.facility_role_is_effective).
-- Roles granted by onboarding or the legacy promotion are unchanged.
--
-- N5: staff_memberships_scoped_uq allowed one active membership per role at a
-- facility, so one account could hold two (org_admin and doctor, for
-- example), and the bound membership, its permissions and its grants depended
-- on query order. A unique partial index now allows one active, unheld
-- membership per account and facility. If a database already holds such
-- duplicates, this migration stops and changes nothing; operator plan I4
-- resolves them first. staff_memberships_scoped_uq is narrowed to active rows,
-- so ended memberships stay as history and a clinician can be attached again.

-- 1. N5 data check, then the unique index. The table lock keeps rows from
-- changing between the check and the index build.
lock table identity.staff_facility_memberships in share row exclusive mode;

do $$
declare
  duplicate_pairs integer;
begin
  select count(*) into duplicate_pairs
  from (
    select membership.account_id, membership.facility_id
    from identity.staff_facility_memberships membership
    where membership.active and membership.facility_id is not null
      and membership.migration_hold_reason is null
    group by membership.account_id, membership.facility_id
    having count(*) > 1
  ) duplicate;
  if duplicate_pairs > 0 then
    raise exception using errcode = '23505',
      message = format('MEMBERSHIP_DUPLICATES_FOUND: %s account and facility pairs hold more than one active membership',
        duplicate_pairs),
      hint = 'Nothing was changed. Run operator plan I4 (docs/PHASE_3_LAUNCH_DECISIONS.md section 3) to list them, '
        || 'deactivate the extra memberships with the facility''s confirmation (never delete them or move their '
        || 'consent grants), then apply this migration again.';
  end if;
end
$$;

create unique index staff_memberships_one_active_per_facility_uq
  on identity.staff_facility_memberships (account_id, facility_id)
  where active and facility_id is not null and migration_hold_reason is null;
comment on index identity.staff_memberships_one_active_per_facility_uq is
  'N5: one active, unheld membership per account and facility, so a facility binds exactly one membership.';

drop index identity.staff_memberships_scoped_uq;
create unique index staff_memberships_scoped_uq
  on identity.staff_facility_memberships (staff_id, organization_id, facility_id, membership_role)
  where facility_id is not null and active;

-- 2. The permission. Only platform_super_admin holds it.
insert into auth.permissions (code, description) values
  ('platform.workforce.manage', 'Attach staff to a verified facility, record credential attestations, grant or revoke clinical facility roles and end memberships (step-up; a role grant needs another administrator''s attestation)')
on conflict (code) do update set description = excluded.description, active = true;

insert into auth.role_permissions (role_code, permission_code) values
  ('platform_super_admin', 'platform.workforce.manage')
on conflict (role_code, permission_code) do nothing;

-- 3. Credential attestations. Append-only evidence; a later attestation
-- supersedes an earlier one by lasting longer, never by editing it.
create table identity.staff_credential_attestations (
  id uuid primary key,
  staff_id uuid not null,
  account_id uuid not null,
  attested_roles text[] not null,
  credential_reference text not null check (length(btrim(credential_reference)) between 3 and 100),
  issuing_authority text not null check (length(btrim(issuing_authority)) between 2 and 200),
  verification_method text not null check (verification_method = 'manual_review'),
  evidence_reference text not null check (length(btrim(evidence_reference)) between 8 and 500),
  valid_until timestamptz not null,
  reviewer_account_id uuid not null references auth.accounts(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (staff_id, account_id) references identity.staff(id, account_id) on delete restrict,
  unique (id, account_id),
  constraint staff_credential_attestations_roles_check check (
    cardinality(attested_roles) between 1 and 3
    and attested_roles <@ array['doctor', 'clinician', 'nurse']::text[]
    and array_position(attested_roles, null) is null
  ),
  constraint staff_credential_attestations_not_self check (reviewer_account_id <> account_id),
  constraint staff_credential_attestations_window_check
    check (valid_until > recorded_at and valid_until <= recorded_at + interval '3 years')
);
create index staff_credential_attestations_account_idx
  on identity.staff_credential_attestations (account_id, valid_until desc);
create trigger staff_credential_attestations_no_mutation
  before update or delete on identity.staff_credential_attestations
  for each row execute function platform.reject_mutation();
alter table identity.staff_credential_attestations enable row level security;
comment on table identity.staff_credential_attestations is
  'D14 professional-credential attestations by a platform reviewer. Written only by identity.admin_record_credential_attestation; no runtime role reads it directly.';

-- 4. Lifecycle of memberships the workforce commands touch: attached
-- (pending), activated by the first role grant, and ended. Ended is terminal.
create table identity.workforce_memberships (
  membership_id uuid primary key,
  staff_id uuid not null,
  account_id uuid not null,
  facility_id uuid not null,
  state text not null check (state in ('pending', 'active', 'ended')),
  attached_by uuid references auth.accounts(id) on delete restrict,
  attached_at timestamptz,
  attach_reason text check (attach_reason is null or length(btrim(attach_reason)) between 8 and 500),
  activated_by uuid references auth.accounts(id) on delete restrict,
  activated_at timestamptz,
  ended_by uuid references auth.accounts(id) on delete restrict,
  ended_at timestamptz,
  end_reason text check (end_reason is null or length(btrim(end_reason)) between 8 and 500),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (membership_id, staff_id, account_id, facility_id)
    references identity.staff_facility_memberships(id, staff_id, account_id, facility_id) on delete restrict,
  constraint workforce_memberships_attach_check
    check ((attached_by is null) = (attached_at is null) and (attached_at is null) = (attach_reason is null)),
  constraint workforce_memberships_activation_check check ((activated_by is null) = (activated_at is null)),
  constraint workforce_memberships_end_check
    check ((ended_by is null) = (ended_at is null) and (ended_at is null) = (end_reason is null)),
  constraint workforce_memberships_lifecycle_check check (
    (state = 'pending' and attached_at is not null and activated_at is null and ended_at is null)
    or (state = 'active' and activated_at is not null and ended_at is null)
    or (state = 'ended' and ended_at is not null)
  )
);
alter table identity.workforce_memberships enable row level security;
comment on table identity.workforce_memberships is
  'D14 membership lifecycle for memberships attached or ended by the workforce commands. Ended is terminal.';

create function identity.guard_workforce_membership_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' or old.state = 'ended' then
    raise exception using errcode = '55000', message = 'WORKFORCE_MEMBERSHIP_ENDED';
  end if;
  if new.membership_id <> old.membership_id or new.staff_id <> old.staff_id
     or new.account_id <> old.account_id or new.facility_id <> old.facility_id
     or new.attached_by is distinct from old.attached_by or new.attached_at is distinct from old.attached_at
     or new.attach_reason is distinct from old.attach_reason
     or (old.state = 'active' and (new.activated_by is distinct from old.activated_by
       or new.activated_at is distinct from old.activated_at))
     or new.row_version <> old.row_version + 1
     or (old.state = 'pending' and new.state not in ('pending', 'active', 'ended'))
     or (old.state = 'active' and new.state not in ('active', 'ended')) then
    raise exception using errcode = '55000', message = 'WORKFORCE_MEMBERSHIP_IMMUTABLE';
  end if;
  return new;
end
$$;
revoke all on function identity.guard_workforce_membership_change() from public;
create trigger workforce_memberships_guard
  before update or delete on identity.workforce_memberships
  for each row execute function identity.guard_workforce_membership_change();

-- An ended membership is never changed again, so nothing can reactivate it
-- or the consent grants still bound to it.
create function identity.guard_ended_membership_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, identity, pg_temp
as $$
begin
  if exists (select 1 from identity.workforce_memberships lifecycle
             where lifecycle.membership_id = old.id and lifecycle.state = 'ended') then
    raise exception using errcode = '55000', message = 'WORKFORCE_MEMBERSHIP_ENDED';
  end if;
  return new;
end
$$;
revoke all on function identity.guard_ended_membership_change() from public;
create trigger staff_memberships_ended_guard
  before update on identity.staff_facility_memberships
  for each row execute function identity.guard_ended_membership_change();

-- 5. Which attestation each workforce role grant relied on. Append-only.
create table identity.workforce_role_grants (
  account_role_id uuid primary key references auth.account_roles(id) on delete restrict,
  attestation_id uuid not null,
  account_id uuid not null,
  membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  role_code text not null check (role_code in ('doctor', 'clinician', 'nurse')),
  granted_by uuid not null references auth.accounts(id) on delete restrict,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  granted_at timestamptz not null default clock_timestamp(),
  foreign key (attestation_id, account_id)
    references identity.staff_credential_attestations(id, account_id) on delete restrict
);
create index workforce_role_grants_attestation_idx on identity.workforce_role_grants (attestation_id);
create trigger workforce_role_grants_no_mutation
  before update or delete on identity.workforce_role_grants
  for each row execute function platform.reject_mutation();
alter table identity.workforce_role_grants enable row level security;
comment on table identity.workforce_role_grants is
  'D14: the attestation each clinical role grant relied on. The role is effective only while that attestation is current.';

-- 6. A facility role granted on an attestation is effective only until the
-- attestation lapses. Roles granted any other way are unaffected.
create function auth.facility_role_is_effective(requested_account_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, identity, pg_temp
as $$
  select not exists (
    select 1
    from identity.workforce_role_grants role_grant
    join identity.staff_credential_attestations attestation on attestation.id = role_grant.attestation_id
    where role_grant.account_role_id = requested_account_role_id
      and attestation.valid_until <= clock_timestamp()
  )
$$;
revoke all on function auth.facility_role_is_effective(uuid) from public;

-- 0010's permission check with the same signature, owner and grants; only the
-- lapsed-attestation condition is added.
create or replace function auth.membership_has_permission(
  request_subject text,
  request_membership_id uuid,
  request_facility_id uuid,
  requested_permission text
)
returns boolean
language sql
stable
security definer
set search_path = auth, identity, pg_temp
as $$
  select
    identity.has_active_membership(request_subject, request_membership_id, request_facility_id)
    and exists (
      select 1
      from auth.accounts account_row
      join identity.staff_facility_memberships membership
        on membership.account_id = account_row.id
       and membership.id = request_membership_id
       and membership.facility_id = request_facility_id
      join auth.account_roles assignment
        on assignment.account_id = account_row.id
       and assignment.membership_id = membership.id
       and assignment.facility_id = membership.facility_id
       and assignment.scope_type = 'facility'
       and assignment.revoked_at is null
      join auth.roles role_row
        on role_row.code = assignment.role_code
       and role_row.active
      join auth.role_permissions role_permission
        on role_permission.role_code = role_row.code
       and role_permission.permission_code = requested_permission
      join auth.permissions permission_row
        on permission_row.code = role_permission.permission_code
       and permission_row.active
      where account_row.subject = request_subject
        and account_row.status = 'active'
        and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
        and auth.facility_role_is_effective(assignment.id)
    )
$$;

-- 7. Shared checks for the workforce commands.
create function identity.workforce_command_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null or platform.current_correlation_id() is null
     or not auth.account_has_platform_permission(actor_account, 'platform.workforce.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return actor_account;
end
$$;
revoke all on function identity.workforce_command_actor() from public;

create function identity.workforce_require_assurance(actor_account uuid)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, auth, platform, pg_temp
as $$
begin
  if not auth.account_has_active_mfa(actor_account) then
    raise exception using errcode = '42501', message = 'ADMIN_MFA_REQUIRED';
  end if;
  perform auth.require_platform_step_up(actor_account);
end
$$;
revoke all on function identity.workforce_require_assurance(uuid) from public;

-- True when the account works at the facility: an active membership there,
-- that facility's org_admin included.
create function identity.workforce_works_at(requested_account_id uuid, requested_facility_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, identity, pg_temp
as $$
  select exists (
    select 1 from identity.staff_facility_memberships membership
    where membership.account_id = requested_account_id
      and membership.facility_id = requested_facility_id
      and membership.active
  )
$$;
revoke all on function identity.workforce_works_at(uuid, uuid) from public;

-- A staff target: active (or awaiting its first password) and not a patient's
-- own account.
create function identity.workforce_target_eligible(target auth.accounts)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, identity, auth, pg_temp
as $$
  select target.status in ('active', 'pending_reset')
    and (target.disabled_until is null or target.disabled_until <= clock_timestamp())
    and not exists (select 1 from identity.patients patient where patient.account_id = target.id)
$$;
revoke all on function identity.workforce_target_eligible(auth.accounts) from public;

-- 8. Attach a staff identity to a verified facility.
create function identity.admin_attach_workforce_member(
  requested_facility_id uuid,
  requested_account_id uuid,
  requested_email text,
  requested_full_name text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (membership_id uuid, account_id uuid, staff_id uuid, facility_id uuid, account_status text,
  account_created boolean, membership_version bigint, staff_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.workforce_command_actor();
  correlation text := platform.current_correlation_id();
  normalized_email text := lower(btrim(requested_email));
  prior auth.admin_command_idempotency%rowtype;
  facility_row identity.facilities%rowtype;
  target auth.accounts%rowtype;
  target_staff identity.staff%rowtype;
  new_membership identity.staff_facility_memberships%rowtype;
  new_account_id uuid := gen_random_uuid();
  created boolean := false;
  response jsonb;
begin
  if requested_facility_id is null
     or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
     or (requested_account_id is null) = (requested_email is null)
     or (requested_account_id is not null and requested_full_name is not null)
     or (requested_account_id is null and (
       length(normalized_email) > 254 or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
       or requested_full_name is null or length(btrim(requested_full_name)) not between 2 and 200)) then
    raise exception using errcode = '22023', message = 'WORKFORCE_INVALID_COMMAND';
  end if;
  if requested_account_id = actor_account then
    raise exception using errcode = '42501', message = 'WORKFORCE_SELF_CHANGE_DENIED';
  end if;
  perform identity.workforce_require_assurance(actor_account);
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'workforce.membership.attach'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'membershipId')::uuid, (prior.response->>'accountId')::uuid,
      (prior.response->>'staffId')::uuid, (prior.response->>'facilityId')::uuid, prior.response->>'accountStatus',
      (prior.response->>'accountCreated')::boolean, (prior.response->>'membershipVersion')::bigint,
      (prior.response->>'staffVersion')::bigint, true;
    return;
  end if;

  -- Accounts first, in id order (0073), then the facility.
  perform 1 from auth.accounts account_row
   where account_row.id in (requested_account_id, actor_account)
   order by account_row.id
   for update;
  select * into facility_row from identity.facilities facility where facility.id = requested_facility_id for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKFORCE_FACILITY_NOT_FOUND';
  end if;
  if facility_row.lifecycle_status <> 'verified' or not facility_row.active
     or not exists (select 1 from identity.organizations organization
       where organization.id = facility_row.organization_id and organization.active) then
    raise exception using errcode = '23514', message = 'WORKFORCE_FACILITY_NOT_VERIFIED';
  end if;
  if identity.workforce_works_at(actor_account, facility_row.id) then
    raise exception using errcode = '42501', message = 'WORKFORCE_FACILITY_CONFLICT';
  end if;

  if requested_account_id is not null then
    select * into target from auth.accounts account_row where account_row.id = requested_account_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'WORKFORCE_ACCOUNT_NOT_FOUND';
    end if;
    select * into target_staff from identity.staff staff_row
     where staff_row.account_id = target.id for update;
    if not found or not target_staff.active or not identity.workforce_target_eligible(target) then
      raise exception using errcode = '23514', message = 'WORKFORCE_ACCOUNT_INELIGIBLE';
    end if;
  else
    if exists (select 1 from auth.accounts account_row
                where lower(account_row.email) = normalized_email and account_row.status <> 'deleted')
       or exists (select 1 from identity.staff staff_row where lower(staff_row.email) = normalized_email) then
      raise exception using errcode = '23505', message = 'WORKFORCE_EMAIL_IN_USE';
    end if;
    insert into auth.accounts (id, subject, email, display_name, status, source_system)
    values (new_account_id, 'workforce:' || new_account_id::text, normalized_email,
      btrim(requested_full_name), 'pending_reset', 'hid')
    returning * into target;
    insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active,
      source_system)
    values (gen_random_uuid(), target.id, btrim(requested_full_name), normalized_email, 'pending', 'staff', true,
      'hid')
    returning * into target_staff;
    created := true;
  end if;

  if exists (
    select 1 from identity.staff_facility_memberships membership
    left join identity.workforce_memberships lifecycle on lifecycle.membership_id = membership.id
    where membership.account_id = target.id and membership.facility_id = facility_row.id
      and (membership.active or lifecycle.state = 'pending')
  ) then
    raise exception using errcode = '23505', message = 'WORKFORCE_MEMBERSHIP_EXISTS';
  end if;

  insert into identity.staff_facility_memberships (
    id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active,
    source_system
  ) values (
    gen_random_uuid(), target_staff.id, target.id, facility_row.organization_id, facility_row.id,
    'pending', 'pending', false, false, 'hid'
  ) returning * into new_membership;
  insert into identity.workforce_memberships (
    membership_id, staff_id, account_id, facility_id, state, attached_by, attached_at, attach_reason,
    correlation_id
  ) values (
    new_membership.id, target_staff.id, target.id, facility_row.id, 'pending', actor_account, clock_timestamp(),
    btrim(requested_reason), correlation
  );

  response := jsonb_build_object('membershipId', new_membership.id, 'accountId', target.id,
    'staffId', target_staff.id, 'facilityId', facility_row.id, 'accountStatus', target.status,
    'accountCreated', created, 'membershipVersion', new_membership.row_version,
    'staffVersion', target_staff.row_version);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'workforce.membership.attach', requested_idempotency_key, requested_sha256, response);
  return query select new_membership.id, target.id, target_staff.id, facility_row.id, target.status, created,
    new_membership.row_version, target_staff.row_version, false;
end
$$;
revoke all on function identity.admin_attach_workforce_member(uuid, uuid, text, text, text, text, character)
  from public;

-- 9. Record a professional-credential attestation for a staff identity.
create function identity.admin_record_credential_attestation(
  requested_account_id uuid,
  expected_staff_version bigint,
  requested_roles text[],
  requested_credential_reference text,
  requested_issuing_authority text,
  requested_evidence_reference text,
  requested_valid_until timestamptz,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (attestation_id uuid, account_id uuid, staff_id uuid, attested_roles text[],
  valid_until timestamptz, verification_status text, staff_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.workforce_command_actor();
  correlation text := platform.current_correlation_id();
  prior auth.admin_command_idempotency%rowtype;
  target auth.accounts%rowtype;
  target_staff identity.staff%rowtype;
  created identity.staff_credential_attestations%rowtype;
  normalized_roles text[];
  response jsonb;
begin
  select array_agg(distinct role_code order by role_code) into normalized_roles
  from unnest(requested_roles) as requested(role_code);
  if requested_account_id is null or expected_staff_version is null
     or requested_roles is null or cardinality(requested_roles) not between 1 and 3
     or cardinality(normalized_roles) <> cardinality(requested_roles)
     or not (normalized_roles <@ array['doctor', 'clinician', 'nurse']::text[])
     or array_position(requested_roles, null) is not null
     or requested_credential_reference is null or length(btrim(requested_credential_reference)) not between 3 and 100
     or requested_issuing_authority is null or length(btrim(requested_issuing_authority)) not between 2 and 200
     or requested_evidence_reference is null or length(btrim(requested_evidence_reference)) not between 8 and 500
     or requested_valid_until is null or requested_valid_until <= clock_timestamp()
     or requested_valid_until > clock_timestamp() + interval '3 years'
     or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'WORKFORCE_INVALID_COMMAND';
  end if;
  if requested_account_id = actor_account then
    raise exception using errcode = '42501', message = 'WORKFORCE_SELF_CHANGE_DENIED';
  end if;
  perform identity.workforce_require_assurance(actor_account);
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'workforce.credential.attest'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'attestationId')::uuid, (prior.response->>'accountId')::uuid,
      (prior.response->>'staffId')::uuid,
      array(select jsonb_array_elements_text(prior.response->'attestedRoles')),
      (prior.response->>'validUntil')::timestamptz, prior.response->>'verificationStatus',
      (prior.response->>'staffVersion')::bigint, true;
    return;
  end if;

  perform 1 from auth.accounts account_row
   where account_row.id in (requested_account_id, actor_account)
   order by account_row.id
   for update;
  select * into target from auth.accounts account_row where account_row.id = requested_account_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKFORCE_ACCOUNT_NOT_FOUND';
  end if;
  select * into target_staff from identity.staff staff_row where staff_row.account_id = target.id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKFORCE_STAFF_NOT_FOUND';
  end if;
  if target_staff.row_version <> expected_staff_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if not target_staff.active or not identity.workforce_target_eligible(target) then
    raise exception using errcode = '23514', message = 'WORKFORCE_ACCOUNT_INELIGIBLE';
  end if;
  if lower(btrim(target_staff.verification_status)) not in ('pending', 'verified', 'approved', 'active') then
    raise exception using errcode = '23514', message = 'WORKFORCE_STAFF_INELIGIBLE';
  end if;

  insert into identity.staff_credential_attestations (
    id, staff_id, account_id, attested_roles, credential_reference, issuing_authority, verification_method,
    evidence_reference, valid_until, reviewer_account_id, reason, correlation_id
  ) values (
    gen_random_uuid(), target_staff.id, target.id, normalized_roles, btrim(requested_credential_reference),
    btrim(requested_issuing_authority), 'manual_review', btrim(requested_evidence_reference),
    requested_valid_until, actor_account, btrim(requested_reason), correlation
  ) returning * into created;
  update identity.staff as staff_row
     set verification_status = case when lower(btrim(staff_row.verification_status)) = 'pending'
           then 'verified' else staff_row.verification_status end,
         updated_at = clock_timestamp(),
         row_version = staff_row.row_version + 1
   where staff_row.id = target_staff.id
  returning staff_row.* into target_staff;

  response := jsonb_build_object('attestationId', created.id, 'accountId', target.id, 'staffId', target_staff.id,
    'attestedRoles', to_jsonb(created.attested_roles), 'validUntil', created.valid_until,
    'verificationStatus', target_staff.verification_status, 'staffVersion', target_staff.row_version);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'workforce.credential.attest', requested_idempotency_key, requested_sha256, response);
  return query select created.id, target.id, target_staff.id, created.attested_roles, created.valid_until,
    target_staff.verification_status, target_staff.row_version, false;
end
$$;
revoke all on function identity.admin_record_credential_attestation(uuid, bigint, text[], text, text, text,
  timestamptz, text, text, character) from public;

-- 10. Grant or revoke one clinical facility role on one membership.
create function identity.admin_change_workforce_role(
  requested_membership_id uuid,
  requested_facility_id uuid,
  expected_membership_version bigint,
  requested_role_code text,
  requested_action text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (membership_id uuid, facility_id uuid, role_code text, role_active boolean,
  membership_active boolean, membership_state text, membership_version bigint, attestation_id uuid,
  replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.workforce_command_actor();
  correlation text := platform.current_correlation_id();
  prior auth.admin_command_idempotency%rowtype;
  membership_row identity.staff_facility_memberships%rowtype;
  lifecycle_state text;
  facility_row identity.facilities%rowtype;
  target auth.accounts%rowtype;
  target_staff identity.staff%rowtype;
  chosen_attestation uuid;
  new_role uuid;
  revoked_role uuid;
  response jsonb;
begin
  if requested_membership_id is null or requested_facility_id is null or expected_membership_version is null
     or requested_action is null or requested_action not in ('grant', 'revoke')
     or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'WORKFORCE_INVALID_COMMAND';
  end if;
  if requested_role_code is null
     or (requested_action = 'grant' and requested_role_code not in ('doctor', 'clinician', 'nurse'))
     or (requested_action = 'revoke'
       and requested_role_code not in ('doctor', 'clinician', 'nurse', 'lab', 'pharmacist')) then
    raise exception using errcode = '22023', message = 'WORKFORCE_ROLE_NOT_GRANTABLE';
  end if;
  perform identity.workforce_require_assurance(actor_account);
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'workforce.role.change'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'membershipId')::uuid, (prior.response->>'facilityId')::uuid,
      prior.response->>'roleCode', (prior.response->>'roleActive')::boolean,
      (prior.response->>'membershipActive')::boolean, prior.response->>'membershipState',
      (prior.response->>'membershipVersion')::bigint, (prior.response->>'attestationId')::uuid, true;
    return;
  end if;

  select * into membership_row from identity.staff_facility_memberships membership
   where membership.id = requested_membership_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKFORCE_MEMBERSHIP_NOT_FOUND';
  end if;
  if membership_row.facility_id is distinct from requested_facility_id then
    raise exception using errcode = '23514', message = 'WORKFORCE_FACILITY_MISMATCH';
  end if;
  if membership_row.account_id = actor_account then
    raise exception using errcode = '42501', message = 'WORKFORCE_SELF_CHANGE_DENIED';
  end if;
  perform 1 from auth.accounts account_row
   where account_row.id in (membership_row.account_id, actor_account)
   order by account_row.id
   for update;
  select * into membership_row from identity.staff_facility_memberships membership
   where membership.id = requested_membership_id for update;
  if membership_row.row_version <> expected_membership_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  select lifecycle.state into lifecycle_state from identity.workforce_memberships lifecycle
   where lifecycle.membership_id = membership_row.id;
  if lifecycle_state = 'ended' then
    raise exception using errcode = '23514', message = 'WORKFORCE_MEMBERSHIP_ENDED';
  end if;
  if membership_row.migration_hold_reason is not null then
    raise exception using errcode = '23514', message = 'WORKFORCE_MEMBERSHIP_HELD';
  end if;

  if requested_action = 'grant' then
    select * into facility_row from identity.facilities facility
     where facility.id = membership_row.facility_id for share;
    if facility_row.lifecycle_status <> 'verified' or not facility_row.active
       or not exists (select 1 from identity.organizations organization
         where organization.id = facility_row.organization_id and organization.active) then
      raise exception using errcode = '23514', message = 'WORKFORCE_FACILITY_NOT_VERIFIED';
    end if;
    if identity.workforce_works_at(actor_account, facility_row.id) then
      raise exception using errcode = '42501', message = 'WORKFORCE_FACILITY_CONFLICT';
    end if;
    if not membership_row.active and lifecycle_state is distinct from 'pending' then
      raise exception using errcode = '23514', message = 'WORKFORCE_MEMBERSHIP_INACTIVE';
    end if;
    select * into target from auth.accounts account_row where account_row.id = membership_row.account_id;
    select * into target_staff from identity.staff staff_row where staff_row.id = membership_row.staff_id;
    if not target_staff.active or not identity.workforce_target_eligible(target) then
      raise exception using errcode = '23514', message = 'WORKFORCE_ACCOUNT_INELIGIBLE';
    end if;
    -- org_admin stays non-clinical: a membership that administers the
    -- facility cannot also hold a clinical role.
    if membership_row.membership_role in ('org_admin', 'admin', 'platform_admin')
       or membership_row.app_role in ('org_admin', 'admin', 'platform_admin')
       or exists (select 1 from auth.account_roles assignment
         where assignment.membership_id = membership_row.id and assignment.scope_type = 'facility'
           and assignment.revoked_at is null and assignment.role_code in ('org_admin', 'admin')) then
      raise exception using errcode = '23514', message = 'WORKFORCE_ROLE_CONFLICT';
    end if;
    if exists (select 1 from auth.account_roles assignment
        where assignment.membership_id = membership_row.id and assignment.scope_type = 'facility'
          and assignment.role_code = requested_role_code and assignment.revoked_at is null) then
      raise exception using errcode = '23505', message = 'WORKFORCE_ROLE_ALREADY_ACTIVE';
    end if;
    -- A current attestation for this role by an independent reviewer: not the
    -- target (a table constraint), not working at this facility, and not the
    -- administrator granting the role.
    select attestation.id into chosen_attestation
    from identity.staff_credential_attestations attestation
    where attestation.account_id = target.id
      and attestation.valid_until > clock_timestamp()
      and requested_role_code = any(attestation.attested_roles)
      and attestation.reviewer_account_id <> actor_account
      and not identity.workforce_works_at(attestation.reviewer_account_id, facility_row.id)
    order by attestation.valid_until desc, attestation.recorded_at desc, attestation.id
    limit 1;
    if chosen_attestation is null then
      if exists (select 1 from identity.staff_credential_attestations attestation
          where attestation.account_id = target.id
            and attestation.valid_until > clock_timestamp()
            and requested_role_code = any(attestation.attested_roles)
            and attestation.reviewer_account_id = actor_account
            and not identity.workforce_works_at(attestation.reviewer_account_id, facility_row.id)) then
        raise exception using errcode = '42501', message = 'WORKFORCE_SECOND_PERSON_REQUIRED';
      end if;
      raise exception using errcode = '23514', message = 'WORKFORCE_ATTESTATION_REQUIRED';
    end if;
    if lower(btrim(target_staff.verification_status)) not in ('verified', 'approved', 'active') then
      raise exception using errcode = '23514', message = 'WORKFORCE_STAFF_INELIGIBLE';
    end if;

    insert into auth.account_roles (
      id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason
    ) values (
      gen_random_uuid(), target.id, requested_role_code, 'facility', membership_row.id, membership_row.facility_id,
      actor_account, btrim(requested_reason)
    ) returning id into new_role;
    insert into identity.workforce_role_grants (
      account_role_id, attestation_id, account_id, membership_id, facility_id, role_code, granted_by,
      correlation_id
    ) values (
      new_role, chosen_attestation, target.id, membership_row.id, membership_row.facility_id,
      requested_role_code, actor_account, correlation
    );
    if not membership_row.active then
      begin
        update identity.staff_facility_memberships as membership
           set active = true, membership_role = requested_role_code, app_role = requested_role_code,
               updated_at = clock_timestamp(), row_version = membership.row_version + 1
         where membership.id = membership_row.id
        returning membership.* into membership_row;
      exception when unique_violation then
        raise exception using errcode = '23505', message = 'WORKFORCE_MEMBERSHIP_EXISTS';
      end;
      update identity.workforce_memberships as lifecycle
         set state = 'active', activated_by = actor_account, activated_at = clock_timestamp(),
             correlation_id = correlation, updated_at = clock_timestamp(),
             row_version = lifecycle.row_version + 1
       where lifecycle.membership_id = membership_row.id;
      lifecycle_state := 'active';
    else
      update identity.staff_facility_memberships as membership
         set updated_at = clock_timestamp(), row_version = membership.row_version + 1
       where membership.id = membership_row.id
      returning membership.* into membership_row;
    end if;
  else
    update auth.account_roles as assignment
       set revoked_at = clock_timestamp(), revoked_by = actor_account,
           revocation_reason = btrim(requested_reason), row_version = assignment.row_version + 1
     where assignment.membership_id = membership_row.id and assignment.scope_type = 'facility'
       and assignment.role_code = requested_role_code and assignment.revoked_at is null
    returning assignment.id into revoked_role;
    if revoked_role is null then
      raise exception using errcode = '23514', message = 'WORKFORCE_ROLE_NOT_ACTIVE';
    end if;
    update identity.staff_facility_memberships as membership
       set updated_at = clock_timestamp(), row_version = membership.row_version + 1
     where membership.id = membership_row.id
    returning membership.* into membership_row;
  end if;

  response := jsonb_build_object('membershipId', membership_row.id, 'facilityId', membership_row.facility_id,
    'roleCode', requested_role_code, 'roleActive', requested_action = 'grant',
    'membershipActive', membership_row.active,
    'membershipState', coalesce(lifecycle_state, case when membership_row.active then 'active' else 'inactive' end),
    'membershipVersion', membership_row.row_version, 'attestationId', chosen_attestation);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'workforce.role.change', requested_idempotency_key, requested_sha256, response);
  return query select membership_row.id, membership_row.facility_id, requested_role_code,
    requested_action = 'grant', membership_row.active, response->>'membershipState', membership_row.row_version,
    chosen_attestation, false;
end
$$;
revoke all on function identity.admin_change_workforce_role(uuid, uuid, bigint, text, text, text, text, character)
  from public;

-- 11. End one membership.
create function identity.admin_end_workforce_membership(
  requested_membership_id uuid,
  requested_facility_id uuid,
  expected_membership_version bigint,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (membership_id uuid, facility_id uuid, account_id uuid, revoked_roles integer,
  revoked_grants integer, expired_requests integer, revoked_sessions integer, membership_version bigint,
  replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.workforce_command_actor();
  correlation text := platform.current_correlation_id();
  prior auth.admin_command_idempotency%rowtype;
  membership_row identity.staff_facility_memberships%rowtype;
  roles_revoked integer;
  grants_revoked integer;
  requests_expired integer;
  sessions_revoked integer;
  was_active boolean;
  response jsonb;
begin
  if requested_membership_id is null or requested_facility_id is null or expected_membership_version is null
     or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'WORKFORCE_INVALID_COMMAND';
  end if;
  perform identity.workforce_require_assurance(actor_account);
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'workforce.membership.end'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'membershipId')::uuid, (prior.response->>'facilityId')::uuid,
      (prior.response->>'accountId')::uuid, (prior.response->>'revokedRoles')::integer,
      (prior.response->>'revokedGrants')::integer, (prior.response->>'expiredRequests')::integer,
      (prior.response->>'revokedSessions')::integer, (prior.response->>'membershipVersion')::bigint, true;
    return;
  end if;

  select * into membership_row from identity.staff_facility_memberships membership
   where membership.id = requested_membership_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKFORCE_MEMBERSHIP_NOT_FOUND';
  end if;
  if membership_row.facility_id is distinct from requested_facility_id then
    raise exception using errcode = '23514', message = 'WORKFORCE_FACILITY_MISMATCH';
  end if;
  if membership_row.account_id = actor_account then
    raise exception using errcode = '42501', message = 'WORKFORCE_SELF_CHANGE_DENIED';
  end if;
  -- The account rows first (0073): a refresh in flight finishes before the
  -- sessions are revoked, so a session it creates is revoked too.
  perform 1 from auth.accounts account_row
   where account_row.id in (membership_row.account_id, actor_account)
   order by account_row.id
   for update;
  select * into membership_row from identity.staff_facility_memberships membership
   where membership.id = requested_membership_id for update;
  if membership_row.row_version <> expected_membership_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if exists (select 1 from identity.workforce_memberships lifecycle
             where lifecycle.membership_id = membership_row.id and lifecycle.state = 'ended') then
    raise exception using errcode = '23514', message = 'WORKFORCE_MEMBERSHIP_ENDED';
  end if;

  was_active := membership_row.active;
  update identity.staff_facility_memberships as membership
     set active = false, updated_at = clock_timestamp(), row_version = membership.row_version + 1
   where membership.id = membership_row.id
  returning membership.* into membership_row;
  update auth.account_roles as assignment
     set revoked_at = clock_timestamp(), revoked_by = actor_account,
         revocation_reason = btrim(requested_reason), row_version = assignment.row_version + 1
   where assignment.membership_id = membership_row.id and assignment.scope_type = 'facility'
     and assignment.revoked_at is null;
  get diagnostics roles_revoked = row_count;
  update identity.consent_grants as grant_row
     set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = actor_account,
         revoked_reason = btrim(requested_reason), updated_at = clock_timestamp(),
         row_version = grant_row.row_version + 1
   where grant_row.membership_id = membership_row.id and grant_row.status = 'active';
  get diagnostics grants_revoked = row_count;
  update identity.access_requests as request_row
     set status = 'expired', updated_at = clock_timestamp(), row_version = request_row.row_version + 1
   where request_row.membership_id = membership_row.id and request_row.status = 'pending';
  get diagnostics requests_expired = row_count;
  -- A membership that was active may have authorized a staff session; a
  -- pending one never did, so ending it leaves the account's other work alone.
  sessions_revoked := 0;
  if was_active then
    update auth.sessions as session_row
       set revoked_at = clock_timestamp(), revocation_reason = 'workforce_membership_ended',
           row_version = session_row.row_version + 1
     where session_row.account_id = membership_row.account_id and session_row.session_kind = 'staff'
       and session_row.revoked_at is null;
    get diagnostics sessions_revoked = row_count;
    insert into auth.session_events (account_id, event_type, outcome, correlation_id, details)
    values (membership_row.account_id, 'revoked', 'success', correlation,
      jsonb_build_object('reason', 'workforce_membership_ended', 'membershipId', membership_row.id,
        'facilityId', membership_row.facility_id, 'revokedBy', actor_account, 'revokedCount', sessions_revoked));
  end if;
  insert into identity.workforce_memberships (
    membership_id, staff_id, account_id, facility_id, state, ended_by, ended_at, end_reason, correlation_id
  ) values (
    membership_row.id, membership_row.staff_id, membership_row.account_id, membership_row.facility_id, 'ended',
    actor_account, clock_timestamp(), btrim(requested_reason), correlation
  )
  on conflict on constraint workforce_memberships_pkey do update
     set state = 'ended', ended_by = excluded.ended_by, ended_at = excluded.ended_at,
         end_reason = excluded.end_reason, correlation_id = excluded.correlation_id,
         updated_at = clock_timestamp(), row_version = identity.workforce_memberships.row_version + 1;

  response := jsonb_build_object('membershipId', membership_row.id, 'facilityId', membership_row.facility_id,
    'accountId', membership_row.account_id, 'revokedRoles', roles_revoked, 'revokedGrants', grants_revoked,
    'expiredRequests', requests_expired, 'revokedSessions', sessions_revoked,
    'membershipVersion', membership_row.row_version);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'workforce.membership.end', requested_idempotency_key, requested_sha256, response);
  return query select membership_row.id, membership_row.facility_id, membership_row.account_id, roles_revoked,
    grants_revoked, requests_expired, sessions_revoked, membership_row.row_version, false;
end
$$;
revoke all on function identity.admin_end_workforce_membership(uuid, uuid, bigint, text, text, character)
  from public;

-- 12. One account's workforce profile for the administration UI.
create function identity.admin_workforce_profile(requested_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := identity.workforce_command_actor();
  account_row auth.accounts%rowtype;
  staff_row identity.staff%rowtype;
begin
  select * into account_row from auth.accounts account where account.id = requested_account_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKFORCE_ACCOUNT_NOT_FOUND';
  end if;
  select * into staff_row from identity.staff staff where staff.account_id = account_row.id;
  return jsonb_build_object(
    'account', jsonb_build_object('id', account_row.id, 'email', account_row.email,
      'displayName', account_row.display_name, 'status', account_row.status, 'version', account_row.row_version,
      'patientAccount', exists (select 1 from identity.patients patient where patient.account_id = account_row.id)),
    'staff', case when staff_row.id is null then null else jsonb_build_object('id', staff_row.id,
      'fullName', staff_row.full_name, 'verificationStatus', staff_row.verification_status,
      'active', staff_row.active, 'version', staff_row.row_version) end,
    'attestations', coalesce((
      select jsonb_agg(jsonb_build_object('id', attestation.id, 'attestedRoles', to_jsonb(attestation.attested_roles),
          'credentialReference', attestation.credential_reference, 'issuingAuthority', attestation.issuing_authority,
          'verificationMethod', attestation.verification_method,
          'evidenceReference', attestation.evidence_reference, 'validUntil', attestation.valid_until,
          'current', attestation.valid_until > clock_timestamp(),
          'reviewerAccountId', attestation.reviewer_account_id, 'recordedAt', attestation.recorded_at)
        order by attestation.recorded_at desc, attestation.id)
      from identity.staff_credential_attestations attestation
      where attestation.account_id = account_row.id), '[]'::jsonb),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object('id', membership.id, 'facilityId', membership.facility_id,
          'facilityName', facility.name,
          'state', coalesce(lifecycle.state, case when membership.active then 'active' else 'inactive' end),
          'active', membership.active, 'held', membership.migration_hold_reason is not null,
          'version', membership.row_version,
          'roles', coalesce((select jsonb_agg(jsonb_build_object('roleCode', assignment.role_code,
              'effective', auth.facility_role_is_effective(assignment.id),
              'grantedAt', assignment.granted_at) order by assignment.role_code)
            from auth.account_roles assignment
            where assignment.membership_id = membership.id and assignment.scope_type = 'facility'
              and assignment.revoked_at is null), '[]'::jsonb))
        order by facility.name, membership.id)
      from identity.staff_facility_memberships membership
      join identity.facilities facility on facility.id = membership.facility_id
      left join identity.workforce_memberships lifecycle on lifecycle.membership_id = membership.id
      where membership.account_id = account_row.id), '[]'::jsonb)
  );
end
$$;
revoke all on function identity.admin_workforce_profile(uuid) from public;

comment on function identity.admin_change_workforce_role(uuid, uuid, bigint, text, text, text, text, character) is
  'D14: grant or revoke one clinical facility role on one membership. A grant needs a current attestation by another platform reviewer who does not work at that facility.';
comment on function identity.admin_end_workforce_membership(uuid, uuid, bigint, text, text, character) is
  'D14: end one membership; revokes its roles and consent grants, expires its pending access requests and revokes the account''s staff sessions.';
