-- HID PostgreSQL bootstrap.
--
-- This migration is intentionally additive. It does not inspect or mutate the
-- legacy legacy hosted identity database. The migration runner executes this file inside a
-- transaction and records its SHA-256 checksum in migration.schema_migrations.

create extension if not exists pgcrypto;

create schema if not exists platform;
create schema if not exists auth;
create schema if not exists identity;
create schema if not exists audit;
create schema if not exists ehr;
create schema if not exists migration;

revoke all on schema platform, auth, identity, audit, ehr, migration from public;

create table if not exists migration.schema_migrations (
  version text primary key,
  checksum_sha256 char(64) not null,
  applied_at timestamptz not null default clock_timestamp(),
  applied_by text not null default current_user,
  execution_ms integer not null check (execution_ms >= 0)
);

create table if not exists migration.runs (
  id uuid primary key,
  source_system text not null,
  source_snapshot text not null,
  mode text not null check (mode in ('stage', 'promote', 'reconcile', 'cutover')),
  status text not null check (status in ('running', 'staged', 'blocked', 'verified', 'completed', 'failed')),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  started_by text not null,
  source_transaction_snapshot text,
  source_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(source_counts) = 'object'),
  target_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(target_counts) = 'object'),
  source_checksum_sha256 char(64),
  target_checksum_sha256 char(64),
  notes text,
  check ((status in ('running', 'staged', 'blocked')) or completed_at is not null)
);

create table if not exists migration.source_rows (
  run_id uuid not null references migration.runs(id) on delete restrict,
  entity_type text not null,
  source_pk text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 char(64) not null,
  source_updated_at timestamptz,
  staged_at timestamptz not null default clock_timestamp(),
  promoted_at timestamptz,
  primary key (run_id, entity_type, source_pk)
);

create index if not exists source_rows_entity_hash_idx
  on migration.source_rows (run_id, entity_type, payload_sha256);
create index if not exists source_rows_auth_user_idx
  on migration.source_rows (run_id, entity_type, ((payload->>'auth_user_id')))
  where entity_type in ('user_profiles', 'patients', 'staff');

create table if not exists migration.conflicts (
  id bigint generated always as identity primary key,
  run_id uuid not null references migration.runs(id) on delete restrict,
  entity_type text not null,
  source_pk text not null,
  conflict_type text not null check (
    conflict_type in (
      'staging_checksum_mismatch',
      'target_content_mismatch',
      'missing_dependency',
      'invalid_source_value',
      'reconciliation_mismatch',
      'concurrent_target_change'
    )
  ),
  source_sha256 char(64),
  target_sha256 char(64),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  detected_at timestamptz not null default clock_timestamp(),
  unique (run_id, entity_type, source_pk, conflict_type)
);

create index if not exists migration_conflicts_run_idx
  on migration.conflicts (run_id, detected_at);

create table if not exists migration.conflict_resolutions (
  id bigint generated always as identity primary key,
  conflict_id bigint not null references migration.conflicts(id) on delete restrict,
  resolution text not null check (resolution in ('source_corrected', 'target_corrected', 'accepted_equivalent', 'excluded_with_approval')),
  reason text not null check (length(btrim(reason)) >= 8),
  evidence_reference text not null,
  resolved_by text not null,
  resolved_at timestamptz not null default clock_timestamp()
);

create table if not exists migration.entity_reconciliations (
  run_id uuid not null references migration.runs(id) on delete restrict,
  entity_type text not null,
  source_count bigint not null check (source_count >= 0),
  target_count bigint not null check (target_count >= 0),
  source_checksum_sha256 char(64) not null,
  target_checksum_sha256 char(64) not null,
  verified_at timestamptz not null default clock_timestamp(),
  primary key (run_id, entity_type),
  check (source_count = target_count),
  check (source_checksum_sha256 = target_checksum_sha256)
);

create or replace function platform.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = '55000',
    message = format('%I.%I is append-only', tg_table_schema, tg_table_name);
end;
$$;

create or replace function platform.current_actor_subject()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.actor_subject', true), '')
$$;

create or replace function platform.current_facility_id()
returns uuid
language plpgsql
stable
as $$
declare
  value text := nullif(current_setting('app.facility_id', true), '');
begin
  if value is null then
    return null;
  end if;
  if value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'Invalid facility request context';
  end if;
  return value::uuid;
end;
$$;

create or replace function platform.current_membership_id()
returns uuid
language plpgsql
stable
as $$
declare
  value text := nullif(current_setting('app.membership_id', true), '');
begin
  if value is null then
    return null;
  end if;
  if value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'Invalid membership request context';
  end if;
  return value::uuid;
end;
$$;

create or replace function platform.current_correlation_id()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.correlation_id', true), '')
$$;

create or replace function platform.current_purpose_of_use()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.purpose_of_use', true), '')
$$;

comment on schema migration is
  'Restricted controlled-migration workspace. Staged PHI must be encrypted at rest and purged only under the approved runbook.';

comment on table migration.conflicts is
  'Conflict evidence only. Details must contain identifiers and hashes, never copied PHI or credentials.';
