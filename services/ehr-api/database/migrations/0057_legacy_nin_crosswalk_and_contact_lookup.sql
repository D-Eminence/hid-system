-- OTP recipient verifiers and durable patient contact lookups have different
-- key domains. Existing rows remain nullable until the explicit rekey job has
-- reconciled their ciphertext and prior lookup value.
alter table identity.public_patient_enrollments
  add column contact_lookup_hmac char(64)
    check (contact_lookup_hmac is null or contact_lookup_hmac ~ '^[0-9a-f]{64}$');

create index public_patient_enrollments_contact_lookup_idx
  on identity.public_patient_enrollments (contact_channel, contact_lookup_hmac)
  where contact_lookup_hmac is not null;

-- The rekey job writes this only after it has decrypted every pre-existing
-- legacy/public contact and verified the old and canonical HMACs in one
-- serializable transaction. A migration after the marker requires another
-- reconciliation before public activation resumes.
create table migration.patient_contact_lookup_rekeys (
  id uuid primary key default gen_random_uuid(),
  source_snapshot text not null check (length(btrim(source_snapshot)) between 8 and 255),
  operator text not null check (length(btrim(operator)) between 3 and 255),
  legacy_patient_count bigint not null check (legacy_patient_count >= 0),
  legacy_contact_count bigint not null check (legacy_contact_count >= 0),
  enrollment_count bigint not null check (enrollment_count >= 0),
  created_at timestamptz not null default clock_timestamp()
);
create trigger patient_contact_lookup_rekeys_immutable before update or delete
  on migration.patient_contact_lookup_rekeys for each row
  execute function platform.reject_mutation();

-- One attested source disposition is required for EVERY patient in a verified
-- migration run, including patients with no NIN. Deprecated nin_last4,
-- nin_hash and nin_ciphertext never constitute an exact NIN or verification.
create table migration.legacy_nin_crosswalk (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references migration.runs(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  source_row_sha256 char(64) not null check (source_row_sha256 ~ '^[0-9a-f]{64}$'),
  nin_state text not null check (nin_state in ('attested_exact', 'attested_absent')),
  nin_lookup_hmac char(64) check (nin_lookup_hmac is null or nin_lookup_hmac ~ '^[0-9a-f]{64}$'),
  source_snapshot text not null check (length(btrim(source_snapshot)) between 8 and 255),
  evidence_reference text not null check (length(btrim(evidence_reference)) between 8 and 500),
  attested_by text not null check (length(btrim(attested_by)) between 3 and 255),
  attested_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at timestamptz,
  revocation_reason text check (revocation_reason is null or length(btrim(revocation_reason)) between 8 and 500),
  created_at timestamptz not null default clock_timestamp(),
  check ((nin_state = 'attested_exact') = (nin_lookup_hmac is not null)),
  check ((status = 'active') = (revoked_at is null)),
  check ((status = 'active') = (revocation_reason is null))
);
create unique index legacy_nin_crosswalk_active_patient_uq
  on migration.legacy_nin_crosswalk(patient_id) where status = 'active';
create unique index legacy_nin_crosswalk_active_nin_uq
  on migration.legacy_nin_crosswalk(nin_lookup_hmac)
  where status = 'active' and nin_lookup_hmac is not null;
create index legacy_nin_crosswalk_run_idx
  on migration.legacy_nin_crosswalk(run_id) where status = 'active';

-- The attestation binds the complete per-patient inventory to a sealed,
-- reconciled migration run. No attestation means no public NIN activation.
create table migration.legacy_nin_crosswalk_attestations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references migration.runs(id) on delete restrict,
  source_snapshot text not null check (length(btrim(source_snapshot)) between 8 and 255),
  source_checksum_sha256 char(64) not null check (source_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  patient_count integer not null check (patient_count >= 0),
  exact_nin_count integer not null check (exact_nin_count >= 0),
  absent_nin_count integer not null check (absent_nin_count >= 0),
  inventory_sha256 char(64) not null check (inventory_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_reference text not null check (length(btrim(evidence_reference)) between 8 and 500),
  attested_by text not null check (length(btrim(attested_by)) between 3 and 255),
  attested_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at timestamptz,
  revocation_reason text check (revocation_reason is null or length(btrim(revocation_reason)) between 8 and 500),
  created_at timestamptz not null default clock_timestamp(),
  check (patient_count = exact_nin_count + absent_nin_count),
  check ((status = 'active') = (revoked_at is null)),
  check ((status = 'active') = (revocation_reason is null))
);
create unique index legacy_nin_attestation_active_run_uq
  on migration.legacy_nin_crosswalk_attestations(run_id) where status = 'active';

create function migration.guard_legacy_nin_attestation_mutation()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Legacy NIN attestation is not deletable';
  end if;
  if old.status <> 'active' or new.status <> 'revoked'
     or new.revoked_at is null or new.revocation_reason is null
     or (to_jsonb(old) - 'status' - 'revoked_at' - 'revocation_reason')
        is distinct from
        (to_jsonb(new) - 'status' - 'revoked_at' - 'revocation_reason') then
    raise exception using errcode = '55000', message = 'Legacy NIN attestation may only be revoked';
  end if;
  return new;
end;
$$;
create trigger legacy_nin_crosswalk_guard before update or delete
  on migration.legacy_nin_crosswalk for each row
  execute function migration.guard_legacy_nin_attestation_mutation();
create trigger legacy_nin_crosswalk_attestation_guard before update or delete
  on migration.legacy_nin_crosswalk_attestations for each row
  execute function migration.guard_legacy_nin_attestation_mutation();

-- Identity may ask only whether the entire preserved source identity set has
-- an attested exact/absent disposition. The absence of a matching NIN is not
-- safe evidence until this function returns true.
create function identity.legacy_nin_crosswalk_ready()
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, identity, migration, platform, pg_temp as $$
begin
  if nullif(platform.current_actor_subject(), '') is null then
    raise exception using errcode = '42501', message = 'LEGACY_NIN_LOOKUP_DENIED';
  end if;
  -- A currently staged source inventory may contain identities that are not
  -- represented in the target yet. Terminal failed/blocked attempts remain as
  -- evidence, but do not permanently close enrollment after a later run has
  -- reconciled every promoted legacy patient.
  if exists (select 1 from migration.runs where source_system = 'legacy_identity'
    and status in ('running', 'staged')) then
    return false;
  end if;
  if not exists (select 1 from identity.patients where source_system = 'legacy_identity') then
    return true;
  end if;
  -- Validate only runs that own an active crosswalk disposition. Superseded
  -- runs have no active disposition; the per-patient completeness check below
  -- still requires every promoted patient to belong to one eligible run.
  if exists (
    select 1 from migration.runs run
    left join migration.legacy_nin_crosswalk_attestations attestation
      on attestation.run_id = run.id and attestation.status = 'active'
    where run.source_system = 'legacy_identity'
      and exists (select 1 from migration.legacy_nin_crosswalk item
        where item.run_id = run.id and item.status = 'active')
      and (run.status not in ('verified', 'completed')
        or run.mode not in ('reconcile', 'cutover')
        or attestation.id is null
        or run.source_snapshot is distinct from attestation.source_snapshot
        or run.source_checksum_sha256 is distinct from attestation.source_checksum_sha256
        or attestation.patient_count <> (
          select count(*) from migration.source_rows source
          where source.run_id = run.id and source.entity_type = 'patients')
        or attestation.patient_count <> (
          select count(*) from migration.legacy_nin_crosswalk item
          where item.run_id = run.id and item.status = 'active')
        or attestation.exact_nin_count <> (
          select count(*) from migration.legacy_nin_crosswalk item
          where item.run_id = run.id and item.status = 'active'
            and item.nin_state = 'attested_exact')
        or attestation.absent_nin_count <> (
          select count(*) from migration.legacy_nin_crosswalk item
          where item.run_id = run.id and item.status = 'active'
            and item.nin_state = 'attested_absent')
        or attestation.inventory_sha256 <> encode(public.digest(coalesce((
          select string_agg(item.patient_id::text || E'\x1f' || item.source_row_sha256::text
            || E'\x1f' || item.nin_state || E'\x1f' || coalesce(item.nin_lookup_hmac::text, ''),
            E'\n' order by item.patient_id)
          from migration.legacy_nin_crosswalk item
          where item.run_id = run.id and item.status = 'active'
        ), ''), 'sha256'), 'hex'))
  ) then return false;
  end if;
  if exists (
    select 1 from identity.patients patient
    where patient.source_system = 'legacy_identity'
      and not exists (
        select 1 from migration.legacy_nin_crosswalk item
        join migration.runs run on run.id = item.run_id
        join migration.source_rows source on source.run_id = item.run_id
          and source.entity_type = 'patients' and source.source_pk = item.patient_id::text
        where item.patient_id = patient.id and item.status = 'active'
          and run.source_system = 'legacy_identity'
          and run.status in ('verified', 'completed')
          and run.mode in ('reconcile', 'cutover')
          and item.source_snapshot is not distinct from run.source_snapshot
          and source.payload_sha256 = item.source_row_sha256
          and patient.source_record_id is not distinct from item.patient_id::text
          and exists (select 1 from migration.legacy_identity_mappings mapping
            where mapping.run_id = item.run_id
              and mapping.canonical_patient_id = patient.id
              and mapping.canonical_account_id = patient.account_id
              and mapping.migration_status in ('promoted', 'reconciled')))
  ) then return false;
  end if;
  if exists (
    select 1 from migration.legacy_nin_crosswalk item
    left join migration.source_rows source on source.run_id = item.run_id
      and source.entity_type = 'patients' and source.source_pk = item.patient_id::text
    left join identity.patients patient on patient.id = item.patient_id
    left join migration.runs run on run.id = item.run_id
    where item.status = 'active'
      and (source.source_pk is null or source.payload_sha256 <> item.source_row_sha256
        or run.source_system is distinct from 'legacy_identity'
        or run.status not in ('verified', 'completed')
        or run.mode not in ('reconcile', 'cutover')
        or item.source_snapshot is distinct from run.source_snapshot
        or patient.source_system is distinct from 'legacy_identity'
        or patient.source_record_id is distinct from item.patient_id::text
        or not exists (select 1 from migration.legacy_identity_mappings mapping
          where mapping.run_id = item.run_id
            and mapping.canonical_patient_id = item.patient_id
            and mapping.canonical_account_id = patient.account_id
            and mapping.migration_status in ('promoted', 'reconciled')))
  ) then return false;
  end if;
  return true;
end;
$$;

create function identity.patient_contact_lookup_ready()
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, identity, migration, platform, pg_temp as $$
declare legacy_count bigint;
begin
  if nullif(platform.current_actor_subject(), '') is null then
    raise exception using errcode = '42501', message = 'PATIENT_CONTACT_LOOKUP_DENIED';
  end if;
  select count(*) into legacy_count from identity.patients
    where source_system = 'legacy_identity';
  if legacy_count = 0
    and not exists (select 1 from identity.public_patient_enrollments
      where contact_hmac is not null and contact_lookup_hmac is null) then
    return true;
  end if;
  if not exists (select 1 from migration.patient_contact_lookup_rekeys marker
    where marker.legacy_patient_count = legacy_count
      and marker.legacy_contact_count = (
        select count(*) from identity.patients patient
        cross join lateral (values (patient.phone_e164_ciphertext),
          (patient.email_ciphertext)) as contact(ciphertext)
        where patient.source_system = 'legacy_identity'
          and contact.ciphertext is not null)
      and marker.enrollment_count >= (
        select count(*) from identity.public_patient_enrollments enrollment
        where enrollment.contact_hmac is not null
          and enrollment.created_at <= marker.created_at)) then
    return false;
  end if;
  if exists (select 1 from identity.patients patient
    where patient.source_system = 'legacy_identity'
      and ((patient.phone_e164_ciphertext is not null and patient.phone_lookup_hmac is null)
        or (patient.email_ciphertext is not null and patient.email_lookup_hmac is null))) then
    return false;
  end if;
  if exists (select 1 from identity.public_patient_enrollments enrollment
    where enrollment.contact_hmac is not null
      and (enrollment.contact_lookup_hmac is null
        or (enrollment.state = 'active' and not exists (
          select 1 from identity.patients patient
          where patient.id = enrollment.patient_id
            and ((enrollment.contact_channel = 'phone'
              and patient.phone_lookup_hmac = enrollment.contact_lookup_hmac)
              or (enrollment.contact_channel = 'email'
                and patient.email_lookup_hmac = enrollment.contact_lookup_hmac)))))) then
    return false;
  end if;
  return true;
end;
$$;

-- Restricted exact-match lookup. It returns a patient UUID, never an
-- assurance claim. The caller still has to obtain authoritative QoreID proof.
create function identity.legacy_nin_crosswalk_patient(requested_lookup_hmac char(64))
returns uuid language plpgsql stable security definer
set search_path = pg_catalog, migration, platform, pg_temp as $$
declare matched_patient uuid;
begin
  if platform.current_actor_subject() <> 'system:auth'
    or requested_lookup_hmac is null
    or requested_lookup_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'LEGACY_NIN_LOOKUP_DENIED';
  end if;
  select item.patient_id into matched_patient
  from migration.legacy_nin_crosswalk item
  where item.nin_lookup_hmac = requested_lookup_hmac
    and item.nin_state = 'attested_exact' and item.status = 'active';
  return matched_patient;
end;
$$;

revoke all on migration.legacy_nin_crosswalk,
  migration.legacy_nin_crosswalk_attestations,
  migration.patient_contact_lookup_rekeys from public;
revoke all on function identity.legacy_nin_crosswalk_patient(char(64)),
  identity.legacy_nin_crosswalk_ready(), identity.patient_contact_lookup_ready() from public;

comment on table migration.legacy_nin_crosswalk is
  'Restricted, complete source NIN inventory. Exact entries are unverified source associations; absence is explicitly attested, never inferred from opaque legacy fields.';
comment on table migration.legacy_nin_crosswalk_attestations is
  'Operator attestation of complete exact/absent NIN inventory for a verified legacy identity migration run.';
comment on column identity.public_patient_enrollments.contact_lookup_hmac is
  'Dedicated durable contact lookup HMAC; distinct from contact_hmac, which remains the OTP recipient verifier.';
