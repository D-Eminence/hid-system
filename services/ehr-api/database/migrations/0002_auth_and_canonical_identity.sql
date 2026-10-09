-- Authentication abstraction and the canonical HID Identity registry.
-- Existing UUIDs and HID codes are inserted explicitly by the migration tools.
-- No database HID generator exists by design: the application uses a
-- cryptographically secure generator and the unique index is collision truth.

create table auth.accounts (
  id uuid primary key,
  subject text not null unique check (length(subject) between 1 and 255),
  email text,
  display_name text,
  status text not null default 'active' check (status in ('active', 'pending_reset', 'locked', 'disabled', 'deleted')),
  password_hash text,
  password_algorithm text check (password_algorithm in ('argon2id', 'bcrypt_legacy')),
  password_changed_at timestamptz,
  token_version bigint not null default 1 check (token_version > 0),
  row_version bigint not null default 1 check (row_version > 0),
  legacy_identity_user_id uuid unique,
  source_system text not null default 'hid',
  source_created_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, subject),
  check ((password_hash is null) = (password_algorithm is null))
);

create unique index accounts_email_ci_uq
  on auth.accounts (lower(email)) where email is not null and status <> 'deleted';

create table auth.external_identities (
  id uuid primary key,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  issuer text not null,
  subject text not null,
  status text not null default 'active' check (status in ('active', 'revoked', 'disabled')),
  assurance_level text,
  linked_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  source_system text not null default 'hid',
  unique (issuer, subject)
);

create index external_identities_account_idx on auth.external_identities (account_id, status);

create table auth.roles (
  code text primary key,
  description text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);

create table auth.permissions (
  code text primary key,
  description text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);

create table auth.role_permissions (
  role_code text not null references auth.roles(code) on delete restrict,
  permission_code text not null references auth.permissions(code) on delete restrict,
  granted_at timestamptz not null default clock_timestamp(),
  primary key (role_code, permission_code)
);

create table auth.sessions (
  id uuid primary key,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  family_id uuid not null,
  refresh_token_sha256 char(64) not null unique,
  access_jti uuid not null unique,
  account_token_version bigint not null check (account_token_version > 0),
  authentication_method text not null check (authentication_method in ('password', 'oidc', 'legacy_exchange', 'service')),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  replaced_by_session_id uuid,
  source_ip inet,
  user_agent_sha256 char(64),
  row_version bigint not null default 1 check (row_version > 0),
  check (expires_at > issued_at),
  check (absolute_expires_at >= expires_at),
  check (revoked_at is null or revocation_reason is not null),
  foreign key (replaced_by_session_id) references auth.sessions(id) on delete restrict
);

create index sessions_account_active_idx
  on auth.sessions (account_id, expires_at desc) where revoked_at is null;
create index sessions_family_idx on auth.sessions (family_id, issued_at);

create table auth.login_attempts (
  principal_hmac char(64) not null,
  pepper_version smallint not null check (pepper_version > 0),
  failure_count integer not null default 0 check (failure_count >= 0),
  window_started_at timestamptz not null,
  locked_until timestamptz,
  last_failed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (principal_hmac, pepper_version),
  check (last_failed_at is null or last_failed_at >= window_started_at)
);

create table auth.session_events (
  id bigint generated always as identity primary key,
  event_id uuid not null unique default gen_random_uuid(),
  session_id uuid references auth.sessions(id) on delete restrict,
  account_id uuid references auth.accounts(id) on delete restrict,
  event_type text not null check (event_type in ('login_succeeded', 'login_failed', 'refresh', 'rotated', 'revoked', 'logout', 'expired', 'reuse_detected')),
  outcome text not null check (outcome in ('success', 'denied', 'failure')),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  source_ip inet,
  user_agent_sha256 char(64),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  check (octet_length(details::text) <= 16384)
);

create trigger session_events_no_mutation
  before update or delete on auth.session_events
  for each row execute function platform.reject_mutation();

create table identity.organizations (
  id uuid primary key,
  name text not null check (length(btrim(name)) between 1 and 200),
  slug text not null,
  active boolean not null default true,
  row_version bigint not null default 1 check (row_version > 0),
  source_system text not null default 'hid',
  source_created_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create unique index organizations_slug_ci_uq on identity.organizations (lower(slug));

create table identity.facilities (
  id uuid primary key,
  organization_id uuid not null references identity.organizations(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 200),
  code text not null,
  active boolean not null default true,
  timezone text not null,
  row_version bigint not null default 1 check (row_version > 0),
  source_system text not null default 'hid',
  source_created_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, organization_id)
);

create unique index facilities_code_ci_uq on identity.facilities (upper(code));
create index facilities_org_active_idx on identity.facilities (organization_id, active, name);

create table identity.patients (
  id uuid primary key,
  account_id uuid unique references auth.accounts(id) on delete restrict,
  hid_code text not null,
  first_name text not null,
  last_name text not null,
  full_name text not null,
  phone_e164_ciphertext bytea,
  phone_lookup_hmac char(64),
  email_ciphertext bytea,
  email_lookup_hmac char(64),
  contact_key_version text,
  gender text,
  dob date,
  country text,
  state text,
  photo_object_key text,
  emergency_contact_ciphertext bytea,
  emergency_contact_key_version text,
  nin_last4 text,
  nin_hash text,
  nin_ciphertext text,
  notifications_enabled boolean not null default true,
  profile_percent integer not null default 0 check (profile_percent between 0 and 100),
  status text not null default 'active' check (status in ('active', 'inactive', 'merged', 'deceased', 'deleted')),
  row_version bigint not null default 1 check (row_version > 0),
  source_system text not null default 'hid',
  source_record_id text,
  source_created_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (hid_code ~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'),
  check (nin_last4 is null or nin_last4 ~ '^[0-9]{4}$'),
  check ((phone_e164_ciphertext is null) = (phone_lookup_hmac is null)),
  check ((email_ciphertext is null) = (email_lookup_hmac is null)),
  check ((emergency_contact_ciphertext is null) = (emergency_contact_key_version is null)),
  check (
    contact_key_version is not null
    or (phone_e164_ciphertext is null and email_ciphertext is null)
  )
);

create unique index patients_hid_code_ci_uq on identity.patients (upper(hid_code));
create index patients_name_dob_lookup_idx on identity.patients (lower(last_name), lower(first_name), dob) where status = 'active';
create index patients_account_idx on identity.patients (account_id) where account_id is not null;
create unique index patients_phone_hmac_uq on identity.patients (phone_lookup_hmac) where phone_lookup_hmac is not null;
create unique index patients_email_hmac_uq on identity.patients (email_lookup_hmac) where email_lookup_hmac is not null;

create table migration.legacy_clinical_quarantine (
  id uuid primary key,
  run_id uuid not null references migration.runs(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  source_record_id text not null,
  encrypted_payload bytea not null,
  payload_sha256 char(64) not null,
  encryption_key_reference text not null,
  status text not null default 'quarantined' check (status = 'quarantined'),
  created_at timestamptz not null default clock_timestamp(),
  unique (run_id, patient_id, source_record_id)
);

create trigger legacy_clinical_quarantine_no_mutation
  before update or delete on migration.legacy_clinical_quarantine
  for each row execute function platform.reject_mutation();

create table migration.legacy_clinical_quarantine_events (
  id bigint generated always as identity primary key,
  quarantine_id uuid not null references migration.legacy_clinical_quarantine(id) on delete restrict,
  event_type text not null check (event_type in ('reviewed', 'attributed_to_facility', 'imported_to_ehr', 'excluded_with_approval')),
  reason text not null check (length(btrim(reason)) >= 8),
  evidence_reference text not null,
  actor_subject text not null,
  occurred_at timestamptz not null default clock_timestamp()
);

create trigger legacy_clinical_quarantine_events_no_mutation
  before update or delete on migration.legacy_clinical_quarantine_events
  for each row execute function platform.reject_mutation();

create table identity.patient_identifiers (
  id uuid primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  identifier_type text not null check (identifier_type in ('hid_code', 'phone', 'email', 'legacy_mrn', 'external')),
  public_value text,
  value_ciphertext bytea,
  lookup_hmac char(64),
  encryption_key_version text,
  display_hint text,
  verified boolean not null default false,
  source_system text not null default 'hid',
  created_at timestamptz not null default clock_timestamp(),
  check (
    (identifier_type = 'hid_code' and public_value is not null and value_ciphertext is null and lookup_hmac is null)
    or
    (identifier_type <> 'hid_code' and public_value is null and value_ciphertext is not null and lookup_hmac is not null and encryption_key_version is not null)
  )
);

create index patient_identifiers_patient_idx on identity.patient_identifiers (patient_id, identifier_type);
create unique index patient_identifiers_public_uq
  on identity.patient_identifiers (identifier_type, upper(public_value)) where public_value is not null;
create unique index patient_identifiers_lookup_uq
  on identity.patient_identifiers (identifier_type, lookup_hmac) where lookup_hmac is not null;

create table identity.staff (
  id uuid primary key,
  account_id uuid not null unique references auth.accounts(id) on delete restrict,
  full_name text not null,
  email text not null,
  hospital_name text,
  verification_status text not null,
  license_number text,
  default_role text not null,
  active boolean not null default true,
  row_version bigint not null default 1 check (row_version > 0),
  source_system text not null default 'hid',
  source_created_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, account_id)
);

create unique index staff_email_ci_uq on identity.staff (lower(email));
create index staff_license_lookup_idx on identity.staff (license_number) where license_number is not null;

create table identity.staff_facility_memberships (
  id uuid primary key,
  staff_id uuid not null,
  account_id uuid not null,
  organization_id uuid not null references identity.organizations(id) on delete restrict,
  facility_id uuid,
  membership_role text not null,
  app_role text not null,
  is_primary boolean not null default false,
  active boolean not null default true,
  migration_hold_reason text,
  source_system text not null default 'hid',
  source_created_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (staff_id, account_id) references identity.staff(id, account_id) on delete restrict,
  foreign key (facility_id, organization_id) references identity.facilities(id, organization_id) on delete restrict,
  unique (id, facility_id, account_id),
  check (facility_id is not null or migration_hold_reason is not null)
);

create unique index staff_memberships_scoped_uq
  on identity.staff_facility_memberships (staff_id, organization_id, facility_id, membership_role)
  where facility_id is not null;
create unique index staff_memberships_unscoped_uq
  on identity.staff_facility_memberships (staff_id, organization_id, membership_role)
  where facility_id is null;
create index staff_memberships_actor_facility_idx
  on identity.staff_facility_memberships (account_id, facility_id, active)
  where facility_id is not null and migration_hold_reason is null;

create table auth.account_roles (
  id uuid primary key,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  role_code text not null references auth.roles(code) on delete restrict,
  scope_type text not null check (scope_type in ('platform', 'facility')),
  membership_id uuid,
  facility_id uuid,
  granted_at timestamptz not null default clock_timestamp(),
  granted_by uuid references auth.accounts(id) on delete restrict,
  revoked_at timestamptz,
  foreign key (membership_id, facility_id, account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (revoked_at is null or revoked_at >= granted_at),
  check (
    (scope_type = 'platform' and membership_id is null and facility_id is null)
    or (scope_type = 'facility' and membership_id is not null and facility_id is not null)
  )
);

create unique index account_roles_active_platform_uq
  on auth.account_roles (account_id, role_code) where revoked_at is null and scope_type = 'platform';
create unique index account_roles_active_facility_uq
  on auth.account_roles (membership_id, role_code) where revoked_at is null and scope_type = 'facility';

create or replace function auth.account_id_for_subject(request_subject text)
returns uuid
language sql
stable
security definer
set search_path = auth, pg_temp
as $$
  select account_row.id
  from auth.accounts account_row
  where account_row.subject = request_subject
    and account_row.status = 'active'
  limit 1
$$;

create or replace function platform.current_account_id()
returns uuid
language sql
stable
as $$
  select auth.account_id_for_subject(platform.current_actor_subject())
$$;

create or replace function identity.has_active_membership(
  request_subject text,
  request_membership_id uuid,
  request_facility_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = identity, auth, pg_temp
as $$
  select exists (
    select 1
    from identity.staff_facility_memberships membership
    join auth.accounts account_row on account_row.id = membership.account_id
    join identity.staff staff_row on staff_row.id = membership.staff_id
    join identity.facilities facility on facility.id = membership.facility_id
    where membership.id = request_membership_id
      and membership.facility_id = request_facility_id
      and account_row.subject = request_subject
      and account_row.status = 'active'
      and staff_row.active
      and membership.active
      and membership.migration_hold_reason is null
      and facility.active
  )
$$;

comment on column identity.patients.id is
  'Canonical patient UUID. EHR and all downstream domains reference this UUID; it is never reissued during migration.';
comment on column identity.patients.hid_code is
  'Governed human-facing HID. Existing values are preserved. New values are generated with application crypto; this unique index resolves collisions.';
comment on table migration.legacy_clinical_quarantine is
  'Encrypted preservation of clinical profile fields formerly owned by Identity. Rows are not operational EHR records and require governed facility attribution before import.';
comment on column identity.staff_facility_memberships.migration_hold_reason is
  'A non-null value makes a legacy membership ineligible for authorization until explicitly remediated.';
