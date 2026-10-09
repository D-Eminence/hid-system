-- Pharmacy acceptance, dispensing, reversal, and imported medication evidence.
-- EHR prescription intent remains EHR-owned. Imported evidence is neither a
-- prescription nor proof of dispensing. Applied migrations 0001-0022 remain
-- immutable.

create schema pharmacy;

insert into auth.permissions(code, description) values
  ('pharmacy.work-item.read', 'Read authorized Pharmacy prescription work'),
  ('pharmacy.work-item.accept', 'Accept an exact active EHR prescription version into Pharmacy'),
  ('pharmacy.dispensing.read', 'Read authorized Pharmacy dispensing evidence'),
  ('pharmacy.dispensing.create', 'Record an explicit Pharmacy dispensing event'),
  ('pharmacy.dispensing.reverse', 'Reverse a Pharmacy dispensing event with preserved history'),
  ('pharmacy.import.read', 'Read authorized imported medication evidence'),
  ('pharmacy.import.write', 'Create imported medication evidence through a governed owning workflow');

insert into auth.role_permissions(role_code, permission_code)
select role_code, permission_code from (values
  ('doctor', 'pharmacy.work-item.read'),
  ('clinician', 'pharmacy.work-item.read'),
  ('nurse', 'pharmacy.work-item.read'),
  ('pharmacist', 'pharmacy.work-item.read'),
  ('admin', 'pharmacy.work-item.read'),
  ('pharmacist', 'pharmacy.work-item.accept'),
  ('doctor', 'pharmacy.dispensing.read'),
  ('clinician', 'pharmacy.dispensing.read'),
  ('nurse', 'pharmacy.dispensing.read'),
  ('pharmacist', 'pharmacy.dispensing.read'),
  ('admin', 'pharmacy.dispensing.read'),
  ('pharmacist', 'pharmacy.dispensing.create'),
  ('pharmacist', 'pharmacy.dispensing.reverse'),
  ('doctor', 'pharmacy.import.read'),
  ('clinician', 'pharmacy.import.read'),
  ('nurse', 'pharmacy.import.read'),
  ('pharmacist', 'pharmacy.import.read'),
  ('admin', 'pharmacy.import.read'),
  ('doctor', 'pharmacy.import.write'),
  ('clinician', 'pharmacy.import.write'),
  ('nurse', 'pharmacy.import.write'),
  ('pharmacist', 'pharmacy.import.write')
) mapping(role_code, permission_code);

alter table ocr.publications drop constraint publications_target_operation_check;
alter table ocr.publications add constraint publications_target_operation_check check (
  target_operation in (
    'create_imported_clinical_note',
    'retain_validated_document',
    'create_imported_lab_evidence',
    'create_imported_medication_evidence'
  )
);

create table pharmacy.work_items (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  ordering_facility_id uuid not null references identity.facilities(id) on delete restrict,
  source_ehr_prescription_id uuid not null,
  source_ehr_prescription_version bigint not null check(source_ehr_prescription_version > 0),
  source_encounter_id uuid not null,
  source_status text not null check(source_status = 'active'),
  status text not null default 'accepted' check(status = 'accepted'),
  medication_code_system text check(medication_code_system is null or length(btrim(medication_code_system)) between 1 and 255),
  medication_code text check(medication_code is null or length(btrim(medication_code)) between 1 and 100),
  medication_display text not null check(length(btrim(medication_display)) between 1 and 500),
  dose_quantity numeric(12,4),
  dose_unit text check(dose_unit is null or length(btrim(dose_unit)) between 1 and 80),
  route_code text check(route_code is null or length(btrim(route_code)) between 1 and 100),
  frequency text not null check(length(btrim(frequency)) between 1 and 240),
  instructions text not null check(length(btrim(instructions)) between 1 and 4000),
  starts_on date,
  ends_on date,
  prescribed_by uuid not null references auth.accounts(id) on delete restrict,
  prescribed_at timestamptz not null,
  accepted_by uuid not null references auth.accounts(id) on delete restrict,
  accepted_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  accepted_at timestamptz not null default clock_timestamp(),
  acceptance_reason text not null check(length(btrim(acceptance_reason)) between 8 and 500),
  idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check(request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  row_version bigint not null default 1 check(row_version = 1),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(accepted_by_membership_id, facility_id, accepted_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique(facility_id, accepted_by, idempotency_key),
  unique(source_ehr_prescription_id, source_ehr_prescription_version),
  unique(source_ehr_prescription_id),
  check(facility_id = ordering_facility_id),
  check((dose_quantity is null) = (dose_unit is null)),
  check(dose_quantity is null or dose_quantity > 0),
  check(ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index pharmacy_work_items_queue_idx
  on pharmacy.work_items(facility_id, status, accepted_at, id);
create index pharmacy_work_items_patient_idx
  on pharmacy.work_items(facility_id, patient_id, accepted_at desc, id);

create table pharmacy.work_item_events (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references pharmacy.work_items(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  event_version integer not null check(event_version = 1),
  event_type text not null check(event_type = 'prescription_accepted'),
  actor_id uuid not null references auth.accounts(id) on delete restrict,
  actor_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  reason text not null check(length(btrim(reason)) between 8 and 500),
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key(actor_membership_id, facility_id, actor_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique(work_item_id, event_version)
);

create table pharmacy.dispensings (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null unique references pharmacy.work_items(id) on delete restrict,
  work_item_version bigint not null check(work_item_version = 1),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  medication_code_system text check(medication_code_system is null or length(btrim(medication_code_system)) between 1 and 255),
  medication_code text check(medication_code is null or length(btrim(medication_code)) between 1 and 100),
  medication_display text not null check(length(btrim(medication_display)) between 1 and 500),
  quantity_dispensed numeric(12,4) not null check(quantity_dispensed > 0),
  quantity_unit text not null check(length(btrim(quantity_unit)) between 1 and 80),
  status text not null default 'dispensed' check(status = 'dispensed'),
  dispensed_by uuid not null references auth.accounts(id) on delete restrict,
  dispensed_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  dispensed_at timestamptz not null default clock_timestamp(),
  reason text not null check(length(btrim(reason)) between 8 and 500),
  idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check(request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  row_version bigint not null default 1 check(row_version = 1),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(dispensed_by_membership_id, facility_id, dispensed_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique(facility_id, dispensed_by, idempotency_key)
);
create index pharmacy_dispensings_patient_idx
  on pharmacy.dispensings(facility_id, patient_id, dispensed_at desc, id);

create table pharmacy.dispensing_reversals (
  id uuid primary key default gen_random_uuid(),
  dispensing_id uuid not null unique references pharmacy.dispensings(id) on delete restrict,
  dispensing_version bigint not null check(dispensing_version = 1),
  work_item_id uuid not null references pharmacy.work_items(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  status text not null default 'reversed' check(status = 'reversed'),
  reversed_by uuid not null references auth.accounts(id) on delete restrict,
  reversed_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  reversed_at timestamptz not null default clock_timestamp(),
  reason text not null check(length(btrim(reason)) between 8 and 500),
  idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check(request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  row_version bigint not null default 1 check(row_version = 1),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(reversed_by_membership_id, facility_id, reversed_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique(facility_id, reversed_by, idempotency_key)
);

create table pharmacy.imported_medication_evidence (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  source_type text not null default 'IMPORTED_MEDICATION_EVIDENCE'
    check(source_type = 'IMPORTED_MEDICATION_EVIDENCE'),
  activity_status text not null default 'unknown' check(activity_status = 'unknown'),
  source_document_id uuid not null,
  ocr_job_id uuid not null,
  extraction_id uuid not null,
  validation_id uuid not null,
  validation_version integer not null check(validation_version > 0),
  publication_id uuid not null unique,
  medication_text text not null check(length(btrim(medication_text)) between 1 and 500),
  strength_text text check(strength_text is null or length(btrim(strength_text)) between 1 and 240),
  dose_text text check(dose_text is null or length(btrim(dose_text)) between 1 and 240),
  frequency_text text check(frequency_text is null or length(btrim(frequency_text)) between 1 and 240),
  historical_context text check(historical_context is null or length(btrim(historical_context)) between 1 and 2000),
  reviewed_by uuid not null references auth.accounts(id) on delete restrict,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check(request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  row_version bigint not null default 1 check(row_version = 1),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique(facility_id, created_by, idempotency_key)
);
create index pharmacy_imported_medication_patient_idx
  on pharmacy.imported_medication_evidence(facility_id, patient_id, created_at desc, id);

create table pharmacy.outbox_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check(event_type in (
    'PharmacyWorkItemCreated',
    'MedicationDispensed',
    'MedicationDispensingReversed',
    'PharmacyImportedMedicationEvidenceCreated'
  )),
  event_version integer not null default 1 check(event_version = 1),
  aggregate_type text not null check(aggregate_type in (
    'pharmacy-work-item', 'medication-dispensing',
    'medication-dispensing-reversal', 'imported-medication-evidence'
  )),
  aggregate_id uuid not null,
  aggregate_version bigint not null check(aggregate_version > 0),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  payload jsonb not null check(jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  attempt_count integer not null default 0 check(attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default clock_timestamp(),
  unique(event_type, aggregate_id, aggregate_version)
);
create index pharmacy_outbox_pending_idx
  on pharmacy.outbox_events(next_attempt_at, occurred_at, id) where published_at is null;

create or replace function pharmacy.context_allows(
  row_patient_id uuid,
  row_facility_id uuid,
  requested_action text
) returns boolean language sql stable security definer
set search_path = pharmacy, identity, platform, pg_temp as $$
  select row_facility_id = platform.current_facility_id()
    and identity.has_active_consent_grant(
      row_patient_id,
      platform.current_actor_subject(),
      platform.current_membership_id(),
      row_facility_id,
      requested_action,
      platform.current_purpose_of_use()
    )
$$;

create or replace function pharmacy.validate_work_item()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
begin
  if new.facility_id <> new.ordering_facility_id
     or new.facility_id <> platform.current_facility_id()
     or new.accepted_by <> platform.current_account_id()
     or new.accepted_by_membership_id <> platform.current_membership_id()
     or new.source_status <> 'active' then
    raise exception using errcode = '23514',
      message = 'Pharmacy acceptance patient, facility, prescription status, or actor context is invalid';
  end if;
  return new;
end
$$;
create trigger pharmacy_work_item_validate before insert on pharmacy.work_items
  for each row execute function pharmacy.validate_work_item();

create or replace function pharmacy.validate_work_item_event()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare parent_row pharmacy.work_items%rowtype;
begin
  select * into parent_row from pharmacy.work_items where id = new.work_item_id;
  if parent_row.id is null
     or parent_row.patient_id <> new.patient_id
     or parent_row.facility_id <> new.facility_id
     or parent_row.accepted_by <> new.actor_id
     or parent_row.accepted_by_membership_id <> new.actor_membership_id
     or parent_row.acceptance_reason <> new.reason
     or new.actor_id <> platform.current_account_id()
     or new.actor_membership_id <> platform.current_membership_id() then
    raise exception using errcode = '23514',
      message = 'Pharmacy work-item event does not match its accepted prescription';
  end if;
  return new;
end
$$;
create trigger pharmacy_work_item_event_validate before insert on pharmacy.work_item_events
  for each row execute function pharmacy.validate_work_item_event();

create or replace function pharmacy.validate_dispensing()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare parent_row pharmacy.work_items%rowtype;
begin
  select * into parent_row from pharmacy.work_items where id = new.work_item_id;
  if parent_row.id is null
     or parent_row.patient_id <> new.patient_id
     or parent_row.facility_id <> new.facility_id
     or parent_row.row_version <> new.work_item_version
     or parent_row.medication_code_system is distinct from new.medication_code_system
     or parent_row.medication_code is distinct from new.medication_code
     or parent_row.medication_display <> new.medication_display
     or new.facility_id <> platform.current_facility_id()
     or new.dispensed_by <> platform.current_account_id()
     or new.dispensed_by_membership_id <> platform.current_membership_id() then
    raise exception using errcode = '23514',
      message = 'Dispensing does not match its eligible Pharmacy work item and actor context';
  end if;
  return new;
end
$$;
create trigger pharmacy_dispensing_validate before insert on pharmacy.dispensings
  for each row execute function pharmacy.validate_dispensing();

create or replace function pharmacy.validate_dispensing_reversal()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare parent_row pharmacy.dispensings%rowtype;
begin
  select * into parent_row from pharmacy.dispensings where id = new.dispensing_id;
  if parent_row.id is null
     or parent_row.work_item_id <> new.work_item_id
     or parent_row.patient_id <> new.patient_id
     or parent_row.facility_id <> new.facility_id
     or parent_row.row_version <> new.dispensing_version
     or new.facility_id <> platform.current_facility_id()
     or new.reversed_by <> platform.current_account_id()
     or new.reversed_by_membership_id <> platform.current_membership_id() then
    raise exception using errcode = '23514',
      message = 'Dispensing reversal does not match its original dispensing and actor context';
  end if;
  return new;
end
$$;
create trigger pharmacy_dispensing_reversal_validate before insert on pharmacy.dispensing_reversals
  for each row execute function pharmacy.validate_dispensing_reversal();

create or replace function pharmacy.validate_imported_medication_evidence()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
begin
  if new.facility_id <> platform.current_facility_id()
     or new.created_by <> platform.current_account_id()
     or new.created_by_membership_id <> platform.current_membership_id() then
    raise exception using errcode = '23514',
      message = 'Imported medication evidence patient, facility, or actor context is invalid';
  end if;
  return new;
end
$$;
create trigger pharmacy_imported_medication_validate before insert on pharmacy.imported_medication_evidence
  for each row execute function pharmacy.validate_imported_medication_evidence();

create or replace function pharmacy.reject_immutable_evidence()
returns trigger language plpgsql set search_path = pharmacy, pg_temp as $$
begin
  raise exception using errcode = '55000', message = 'Pharmacy clinical operational evidence is append-only';
end
$$;
create trigger pharmacy_work_items_immutable before update or delete on pharmacy.work_items
  for each row execute function pharmacy.reject_immutable_evidence();
create trigger pharmacy_work_item_events_immutable before update or delete on pharmacy.work_item_events
  for each row execute function pharmacy.reject_immutable_evidence();
create trigger pharmacy_dispensings_immutable before update or delete on pharmacy.dispensings
  for each row execute function pharmacy.reject_immutable_evidence();
create trigger pharmacy_dispensing_reversals_immutable before update or delete on pharmacy.dispensing_reversals
  for each row execute function pharmacy.reject_immutable_evidence();
create trigger pharmacy_imported_medication_immutable before update or delete on pharmacy.imported_medication_evidence
  for each row execute function pharmacy.reject_immutable_evidence();

alter table pharmacy.work_items enable row level security;
alter table pharmacy.work_items force row level security;
alter table pharmacy.work_item_events enable row level security;
alter table pharmacy.work_item_events force row level security;
alter table pharmacy.dispensings enable row level security;
alter table pharmacy.dispensings force row level security;
alter table pharmacy.dispensing_reversals enable row level security;
alter table pharmacy.dispensing_reversals force row level security;
alter table pharmacy.imported_medication_evidence enable row level security;
alter table pharmacy.imported_medication_evidence force row level security;
alter table pharmacy.outbox_events enable row level security;
alter table pharmacy.outbox_events force row level security;

create policy pharmacy_work_items_read on pharmacy.work_items for select
  using(pharmacy.context_allows(patient_id, facility_id, 'read_records'));
create policy pharmacy_work_items_insert on pharmacy.work_items for insert
  with check(pharmacy.context_allows(patient_id, facility_id, 'write_records'));
create policy pharmacy_work_item_events_read on pharmacy.work_item_events for select
  using(pharmacy.context_allows(patient_id, facility_id, 'read_records'));
create policy pharmacy_work_item_events_insert on pharmacy.work_item_events for insert
  with check(pharmacy.context_allows(patient_id, facility_id, 'write_records'));
create policy pharmacy_dispensings_read on pharmacy.dispensings for select
  using(pharmacy.context_allows(patient_id, facility_id, 'read_records'));
create policy pharmacy_dispensings_insert on pharmacy.dispensings for insert
  with check(pharmacy.context_allows(patient_id, facility_id, 'write_records'));
create policy pharmacy_reversals_read on pharmacy.dispensing_reversals for select
  using(pharmacy.context_allows(patient_id, facility_id, 'read_records'));
create policy pharmacy_reversals_insert on pharmacy.dispensing_reversals for insert
  with check(pharmacy.context_allows(patient_id, facility_id, 'write_records'));
create policy pharmacy_imports_read on pharmacy.imported_medication_evidence for select
  using(pharmacy.context_allows(patient_id, facility_id, 'read_records'));
create policy pharmacy_imports_insert on pharmacy.imported_medication_evidence for insert
  with check(pharmacy.context_allows(patient_id, facility_id, 'write_records'));
create policy pharmacy_outbox_read on pharmacy.outbox_events for select
  using(pharmacy.context_allows(patient_id, facility_id, 'read_records'));
create policy pharmacy_outbox_insert on pharmacy.outbox_events for insert
  with check(pharmacy.context_allows(patient_id, facility_id, 'write_records'));

revoke all on schema pharmacy from public;
revoke all on all tables in schema pharmacy from public;
revoke all on all sequences in schema pharmacy from public;
revoke all on all functions in schema pharmacy from public;
alter default privileges in schema pharmacy revoke all on tables from public;
alter default privileges in schema pharmacy revoke all on functions from public;

comment on table pharmacy.work_items is
  'Immutable Pharmacy acceptance of one exact active EHR prescription version; acceptance is not dispensing.';
comment on table pharmacy.dispensings is
  'Explicit immutable Pharmacy dispensing evidence; dispensing does not prove medication administration.';
comment on table pharmacy.dispensing_reversals is
  'Append-only governed reversal preserving the original dispensing event.';
comment on table pharmacy.imported_medication_evidence is
  'Imported historical medication evidence with provenance; not an active prescription or dispensing event.';
comment on table pharmacy.outbox_events is
  'Minimum-necessary transactional Pharmacy events pending external delivery.';
