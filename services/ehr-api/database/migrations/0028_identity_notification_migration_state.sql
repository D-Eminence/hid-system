-- Durable state required by the approved Identity, notification, and HID 1.0
-- convergence architecture. Migrations 0001-0027 remain immutable.

create schema notification;
revoke all on schema notification from public;

-- Identity owns authentication challenges. The verifier and lookup values are
-- keyed HMACs; the plaintext six-digit credential is never persisted.
create table auth.otp_challenges (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references auth.accounts(id) on delete restrict,
  recipient_hmac char(64) not null check (recipient_hmac ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose in (
    'SIGNUP_VERIFY', 'EMAIL_VERIFY', 'PHONE_VERIFY', 'PASSWORD_RESET',
    'LOGIN_STEP_UP', 'ADMIN_STEP_UP', 'SENSITIVE_ACTION',
    'LEGACY_ACCOUNT_RECOVERY', 'LEGACY_SESSION_FALLBACK'
  )),
  channel text not null check (channel in ('email', 'sms', 'whatsapp')),
  verifier_hmac char(64) not null check (verifier_hmac ~ '^[0-9a-f]{64}$'),
  verifier_key_version text not null check (length(verifier_key_version) between 1 and 64),
  expires_at timestamptz not null,
  max_attempts smallint not null check (max_attempts between 1 and 10),
  failed_attempts smallint not null default 0 check (failed_attempts between 0 and max_attempts),
  delivery_outcome text not null default 'pending' check (
    delivery_outcome in ('pending', 'accepted', 'definitive_failure', 'unknown')
  ),
  delivery_provider text check (
    delivery_provider is null or delivery_provider ~ '^[a-z][a-z0-9_-]{1,63}$'
  ),
  request_ip_hmac char(64) check (request_ip_hmac is null or request_ip_hmac ~ '^[0-9a-f]{64}$'),
  consumed_at timestamptz,
  verified_at timestamptz,
  completion_token_hmac char(64) check (
    completion_token_hmac is null or completion_token_hmac ~ '^[0-9a-f]{64}$'
  ),
  completion_expires_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text check (
    invalidation_reason is null or invalidation_reason in (
      'resend', 'expired', 'attempts_exhausted', 'delivery_failed', 'completed', 'operator_revoked'
    )
  ),
  last_attempt_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  check (expires_at > created_at),
  check (not (consumed_at is not null and invalidated_at is not null)),
  check ((invalidated_at is null) = (invalidation_reason is null)),
  check (
    (verified_at is null and completion_token_hmac is null and completion_expires_at is null)
    or
    (verified_at is not null and completion_token_hmac is not null and completion_expires_at is not null)
  ),
  check (consumed_at is null or verified_at is not null)
);

create unique index otp_challenges_active_account_purpose_uq
  on auth.otp_challenges (account_id, purpose)
  where account_id is not null and consumed_at is null and invalidated_at is null;
create unique index otp_challenges_active_recipient_purpose_uq
  on auth.otp_challenges (recipient_hmac, purpose)
  where consumed_at is null and invalidated_at is null;
create index otp_challenges_expiry_idx
  on auth.otp_challenges (expires_at) where consumed_at is null and invalidated_at is null;

-- Rate-limit keys are HMACs for IP/account/recipient buckets. Raw addresses,
-- account identifiers, and contact values are not copied into this table.
create table auth.otp_rate_limits (
  scope text not null check (scope in ('ip', 'account', 'recipient')),
  bucket_hmac char(64) not null check (bucket_hmac ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (scope, bucket_hmac)
);

-- Progressive KYC is independent from record visibility. A LEGACY_MIGRATED
-- principal retains its historical authorization while higher-risk actions can
-- require a stronger state.
create table identity.patient_assurance_states (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  account_id uuid not null unique references auth.accounts(id) on delete restrict,
  state text not null check (state in (
    'LEGACY_MIGRATED', 'CONTACT_VERIFIED', 'NIN_PENDING', 'NIN_VERIFIED', 'MANUAL_REVIEW'
  )),
  source_system text not null check (length(source_system) between 1 and 100),
  source_reference text check (source_reference is null or length(source_reference) between 1 and 255),
  verified_provider text check (verified_provider is null or length(verified_provider) between 1 and 100),
  contact_verified_at timestamptz,
  nin_verified_at timestamptz,
  review_reason_code text check (
    review_reason_code is null or review_reason_code ~ '^[A-Z][A-Z0-9_]{1,79}$'
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  check (state <> 'NIN_VERIFIED' or (nin_verified_at is not null and verified_provider is not null))
);

-- The generic stage/reconcile tables from 0001 remain authoritative for batch
-- evidence. This table is the missing stable identity-link ledger needed to
-- prove the complete legacy-user-to-canonical-principal chain.
create table migration.legacy_identity_mappings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references migration.runs(id) on delete restrict,
  source_system text not null check (length(source_system) between 1 and 100),
  source_auth_user_id text not null check (length(source_auth_user_id) between 1 and 255),
  source_patient_id text not null check (length(source_patient_id) between 1 and 255),
  legacy_hid_code text not null check (legacy_hid_code ~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'),
  canonical_patient_id uuid not null references identity.patients(id) on delete restrict,
  canonical_account_id uuid not null references auth.accounts(id) on delete restrict,
  migration_status text not null check (migration_status in (
    'staged', 'blocked', 'promoted', 'reconciled', 'excluded_with_approval'
  )),
  source_checksum_sha256 char(64) not null check (source_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  source_version text not null check (length(source_version) between 1 and 255),
  reconciliation_result text check (reconciliation_result in ('pending', 'matched', 'mismatch', 'approved_exception')),
  migrated_at timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  unique (source_system, source_auth_user_id),
  unique (source_system, source_patient_id),
  unique (source_system, legacy_hid_code),
  unique (run_id, canonical_patient_id),
  unique (run_id, canonical_account_id),
  check ((migration_status in ('promoted', 'reconciled')) = (migrated_at is not null)),
  check ((migration_status = 'reconciled') = (reconciled_at is not null)),
  check (migration_status <> 'reconciled' or reconciliation_result in ('matched', 'approved_exception'))
);

-- Device tokens are encrypted and located only by a keyed HMAC. Revocation is
-- principal-scoped; no browser application receives another device's token.
create table notification.device_registrations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.accounts(id) on delete restrict,
  platform text not null check (platform in ('web', 'android', 'ios')),
  token_ciphertext bytea not null,
  token_lookup_hmac char(64) not null unique check (token_lookup_hmac ~ '^[0-9a-f]{64}$'),
  encryption_key_version text not null check (length(encryption_key_version) between 1 and 64),
  status text not null default 'active' check (status in ('active', 'revoked', 'invalid')),
  last_seen_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revocation_reason_code text check (
    revocation_reason_code is null or revocation_reason_code ~ '^[A-Z][A-Z0-9_]{1,79}$'
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  check ((status = 'active') = (revoked_at is null)),
  check ((revoked_at is null) = (revocation_reason_code is null))
);
create index notification_devices_account_idx
  on notification.device_registrations (account_id, status, platform);

-- Ordinary-notification reconciliation stores transport metadata only. It
-- intentionally has no message body, recipient address, clinical value, OTP,
-- or arbitrary provider response column.
create table notification.delivery_attempts (
  id bigint generated always as identity primary key,
  event_id uuid not null,
  idempotency_key char(64) not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  workflow_id text not null check (workflow_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'push', 'in_app')),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  outcome text not null check (outcome in ('accepted', 'definitive_failure', 'unknown')),
  provider_message_id text check (provider_message_id is null or length(provider_message_id) between 1 and 255),
  safe_code text check (safe_code is null or safe_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  attempted_at timestamptz not null default clock_timestamp(),
  unique (idempotency_key, provider)
);
create index notification_attempts_event_idx
  on notification.delivery_attempts (event_id, attempted_at);
create trigger notification_delivery_attempts_no_mutation
  before update or delete on notification.delivery_attempts
  for each row execute function platform.reject_mutation();

insert into integration.inbox_consumers (consumer_name, database_role)
values ('notification-worker-v1', 'hid_notification_worker')
on conflict (consumer_name) do update
  set database_role = excluded.database_role, enabled = true;

revoke all on auth.otp_challenges, auth.otp_rate_limits,
  identity.patient_assurance_states, migration.legacy_identity_mappings,
  notification.device_registrations, notification.delivery_attempts from public;
revoke all on all sequences in schema notification from public;
alter default privileges in schema notification revoke all on tables from public;
alter default privileges in schema notification revoke all on sequences from public;
alter default privileges in schema notification revoke all on functions from public;

comment on table auth.otp_challenges is
  'Identity-owned, purpose-bound six-digit OTP verifier metadata; never stores plaintext OTP.';
comment on table identity.patient_assurance_states is
  'Progressive assurance state; it does not revoke historical continuity-of-care access.';
comment on table migration.legacy_identity_mappings is
  'Restricted HID 1.0 identity-link ledger supplementing generic migration batch and reconciliation evidence.';
comment on table notification.device_registrations is
  'Encrypted, revocable FCM-compatible device registrations owned by the authenticated principal.';
comment on table notification.delivery_attempts is
  'PHI-free ordinary-notification provider reconciliation metadata; authentication OTP never enters this table.';
