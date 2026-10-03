-- Preserve legacy patient access PIN hashes for a reviewed application port.
-- No runtime role can use this table to approve access.
create table migration.legacy_patient_access_secrets (
  id uuid primary key,
  run_id uuid not null references migration.runs(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  encrypted_payload bytea not null,
  payload_sha256 char(64) not null,
  encryption_key_reference text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (run_id, patient_id)
);

create trigger legacy_patient_access_secrets_no_mutation
  before update or delete on migration.legacy_patient_access_secrets
  for each row execute function platform.reject_mutation();

comment on table migration.legacy_patient_access_secrets is
  'Migrator-only encrypted preservation of legacy patient access PIN hashes; not an operational PIN store.';
