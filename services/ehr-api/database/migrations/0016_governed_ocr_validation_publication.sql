-- Governed OCR validation, canonical-patient confirmation, durable publication,
-- and owning-EHR provenance. Applied migrations 0001 through 0015 are immutable.

insert into auth.permissions (code, description) values
  ('ocr.patient.confirm', 'Confirm the canonical patient for governed OCR evidence'),
  ('ocr.publication.write', 'Request publication of validated OCR candidate data');

insert into auth.role_permissions (role_code, permission_code)
select role_code, permission_code from (values
  ('doctor', 'ocr.patient.confirm'), ('doctor', 'ocr.publication.write'),
  ('clinician', 'ocr.patient.confirm'), ('clinician', 'ocr.publication.write'),
  ('nurse', 'ocr.patient.confirm'), ('nurse', 'ocr.publication.write')
) mapping(role_code, permission_code);

alter table ocr.jobs drop constraint jobs_status_check;
alter table ocr.jobs add constraint jobs_status_check check (status in (
  'queued', 'processing', 'extracted', 'awaiting_validation', 'validated',
  'rejected', 'failed', 'cancelled'
));

alter table ocr.validations
  add column disposition text not null default 'validated'
    check (disposition in ('validated', 'rejected')),
  add column target_domain text not null default 'UNCLASSIFIED'
    check (target_domain in ('EHR', 'LAB', 'PHARMACY', 'DOCUMENT_ONLY', 'UNCLASSIFIED')),
  add column candidate_type text not null default 'unclassified'
    check (candidate_type in ('clinical_note', 'document_only', 'lab_document',
      'historical_medication_evidence', 'unclassified')),
  add column accepted_fields jsonb not null default '{}'::jsonb
    check (jsonb_typeof(accepted_fields) = 'object'),
  add column rejected_fields jsonb not null default '[]'::jsonb
    check (jsonb_typeof(rejected_fields) = 'array'),
  add column provenance jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provenance) = 'object'),
  add column idempotency_key text
    check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  add column request_sha256 char(64)
    check (request_sha256 is null or request_sha256 ~ '^[0-9a-f]{64}$');

update ocr.validations set accepted_fields = validated_payload,
  provenance = jsonb_build_object('migration', '0016', 'legacyValidation', true)
 where accepted_fields = '{}'::jsonb;
create unique index ocr_validations_idempotency_uq
  on ocr.validations (facility_id, validated_by, idempotency_key)
  where idempotency_key is not null;

create table ocr.patient_confirmations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  facility_id uuid not null,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  confirmation_version integer not null check (confirmation_version > 0),
  method text not null check (method in ('source_document', 'hid', 'verified_nin', 'reviewed_candidate')),
  evidence_reference text check (evidence_reference is null or length(evidence_reference) <= 255),
  reason text not null check (length(btrim(reason)) between 8 and 500),
  confirmed_by uuid not null references auth.accounts(id) on delete restrict,
  confirmed_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (job_id, facility_id) references ocr.jobs(id, facility_id) on delete restrict,
  foreign key (confirmed_by_membership_id, facility_id, confirmed_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (job_id, confirmation_version),
  unique (facility_id, confirmed_by, idempotency_key)
);

create table ocr.publications (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  validation_id uuid not null references ocr.validations(id) on delete restrict,
  validation_version integer not null check (validation_version > 0),
  patient_confirmation_id uuid not null references ocr.patient_confirmations(id) on delete restrict,
  facility_id uuid not null,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  target_domain text not null check (target_domain in ('EHR', 'LAB', 'PHARMACY', 'DOCUMENT_ONLY')),
  target_operation text not null check (target_operation in ('create_imported_clinical_note', 'retain_validated_document')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'published', 'failed')),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  requested_by uuid not null references auth.accounts(id) on delete restrict,
  requested_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  next_attempt_at timestamptz not null default clock_timestamp(),
  processing_token uuid,
  processing_expires_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  target_resource_type text check (target_resource_type is null or length(target_resource_type) <= 80),
  target_resource_id uuid,
  failure_code text check (failure_code is null or failure_code ~ '^[A-Z0-9_]{2,80}$'),
  failure_summary text check (failure_summary is null or length(failure_summary) <= 240),
  row_version bigint not null default 1 check (row_version > 0),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (job_id, facility_id) references ocr.jobs(id, facility_id) on delete restrict,
  foreign key (requested_by_membership_id, facility_id, requested_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (validation_id),
  unique (facility_id, requested_by, idempotency_key),
  check ((status = 'processing') = (processing_token is not null and processing_expires_at is not null)),
  check (status <> 'published' or (completed_at is not null and target_resource_type is not null)),
  check (status <> 'failed' or (failed_at is not null and failure_code is not null))
);
create index ocr_publications_retry_idx on ocr.publications (next_attempt_at, requested_at, id)
  where status in ('pending', 'failed');

create table ehr.ocr_import_provenance (
  id uuid primary key default gen_random_uuid(),
  clinical_resource_type text not null check (clinical_resource_type in ('clinical_note')),
  clinical_resource_id uuid not null,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  document_id uuid not null references ehr.documents(id) on delete restrict,
  ocr_job_id uuid not null,
  extraction_id uuid not null,
  validation_id uuid not null,
  validation_version integer not null check (validation_version > 0),
  publication_id uuid not null references ocr.publications(id) on delete restrict,
  reviewed_by uuid not null references auth.accounts(id) on delete restrict,
  published_by uuid not null references auth.accounts(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (ocr_job_id, facility_id) references ocr.jobs(id, facility_id) on delete restrict,
  foreign key (validation_id) references ocr.validations(id) on delete restrict,
  unique (publication_id),
  unique (clinical_resource_type, clinical_resource_id)
);

create or replace function ocr.reject_immutable_change()
returns trigger language plpgsql set search_path = ocr, pg_temp as $$
begin raise exception using errcode = '55000', message = 'OCR evidence is append-only'; end
$$;
create trigger ocr_patient_confirmations_immutable before update or delete on ocr.patient_confirmations
  for each row execute function ocr.reject_immutable_change();
create trigger ehr_ocr_import_provenance_immutable before update or delete on ehr.ocr_import_provenance
  for each row execute function ocr.reject_immutable_change();

create or replace function ocr.validate_patient_confirmation()
returns trigger language plpgsql security definer
set search_path = ocr, ehr, pg_temp as $$
declare job_row ocr.jobs%rowtype; source_patient uuid; expected_version integer;
begin
  select * into job_row from ocr.jobs where id = new.job_id for update;
  select patient_id into source_patient from ehr.documents where id = job_row.document_id;
  select coalesce(max(confirmation_version), 0) + 1 into expected_version
    from ocr.patient_confirmations where job_id = new.job_id;
  if job_row.id is null or job_row.facility_id <> new.facility_id
     or source_patient <> new.patient_id
     or (job_row.patient_id is not null and job_row.patient_id <> new.patient_id)
     or new.confirmation_version <> expected_version then
    raise exception using errcode = '23514', message = 'Patient confirmation does not match the canonical OCR source patient';
  end if;
  return new;
end
$$;
create trigger ocr_patient_confirmations_validate before insert on ocr.patient_confirmations
  for each row execute function ocr.validate_patient_confirmation();

create or replace function ocr.validate_publication_write()
returns trigger language plpgsql security definer set search_path = ocr, pg_temp as $$
declare validation_row ocr.validations%rowtype; confirmation_row ocr.patient_confirmations%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into validation_row from ocr.validations where id = new.validation_id;
    select * into confirmation_row from ocr.patient_confirmations where id = new.patient_confirmation_id;
    if validation_row.id is null or validation_row.job_id <> new.job_id
       or validation_row.facility_id <> new.facility_id
       or validation_row.validation_version <> new.validation_version
       or validation_row.disposition <> 'validated'
       or validation_row.target_domain <> new.target_domain
       or validation_row.target_domain = 'UNCLASSIFIED'
       or confirmation_row.id is null or confirmation_row.job_id <> new.job_id
       or confirmation_row.facility_id <> new.facility_id
       or confirmation_row.patient_id <> new.patient_id then
      raise exception using errcode = '23514', message = 'Publication is not bound to validated confirmed OCR evidence';
    end if;
  else
    if new.job_id <> old.job_id or new.validation_id <> old.validation_id
       or new.validation_version <> old.validation_version
       or new.patient_confirmation_id <> old.patient_confirmation_id
       or new.facility_id <> old.facility_id or new.patient_id <> old.patient_id
       or new.target_domain <> old.target_domain or new.target_operation <> old.target_operation
       or new.idempotency_key <> old.idempotency_key or new.request_sha256 <> old.request_sha256
       or new.requested_by <> old.requested_by
       or new.requested_by_membership_id <> old.requested_by_membership_id
       or new.row_version <> old.row_version + 1 then
      raise exception using errcode = '55000', message = 'OCR publication identity is immutable';
    end if;
    if not ((old.status = 'pending' and new.status = 'processing')
      or (old.status = 'processing' and new.status in ('published', 'failed'))
      or (old.status = 'failed' and new.status = 'processing')
      or (old.status = 'processing' and new.status = 'processing')) then
      raise exception using errcode = '23514', message = 'Invalid OCR publication transition';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end
$$;
create trigger ocr_publications_validate before insert or update on ocr.publications
  for each row execute function ocr.validate_publication_write();

create or replace function ocr.validate_job_write()
returns trigger language plpgsql security definer
set search_path = ocr, ehr, identity, auth, platform, pg_temp as $$
declare document_row record; latest_scan record;
begin
  select document.id, document.patient_id, document.facility_id, document.object_version_id,
         document.sha256_hex, document.status into document_row
    from ehr.documents document where document.id = new.document_id;
  select scan.event_type, scan.object_version_id, scan.object_sha256_hex,
         scan.binding_migration_hold_reason into latest_scan
    from ehr.document_scan_events scan where scan.document_id = new.document_id
   order by scan.created_at desc, scan.id desc limit 1;
  if document_row.id is null or document_row.facility_id <> new.facility_id
     or document_row.object_version_id <> new.source_object_version_id
     or document_row.sha256_hex <> new.source_sha256_hex or document_row.status <> 'uploaded'
     or latest_scan.event_type <> 'clean'
     or latest_scan.object_version_id <> new.source_object_version_id
     or latest_scan.object_sha256_hex <> new.source_sha256_hex
     or latest_scan.binding_migration_hold_reason is not null then
    raise exception using errcode = '23514', message = 'OCR requires exact clean immutable document evidence';
  end if;
  if new.patient_id is not null and new.patient_id <> document_row.patient_id then
    raise exception using errcode = '23514', message = 'OCR patient association must match the canonical document patient';
  end if;
  if tg_op = 'UPDATE' then
    if new.facility_id <> old.facility_id or new.document_id <> old.document_id
       or new.patient_id is distinct from old.patient_id
       or new.source_object_version_id <> old.source_object_version_id
       or new.source_sha256_hex <> old.source_sha256_hex or new.operation <> old.operation
       or new.idempotency_key <> old.idempotency_key or new.request_sha256 <> old.request_sha256
       or new.provider <> old.provider or new.created_by <> old.created_by
       or new.created_by_membership_id <> old.created_by_membership_id
       or new.row_version <> old.row_version + 1 then
      raise exception using errcode = '55000', message = 'OCR job identity is immutable and updates require the next version';
    end if;
    if not ((old.status = 'queued' and new.status in ('processing', 'cancelled'))
      or (old.status = 'processing' and new.status in ('extracted', 'failed'))
      or (old.status = 'extracted' and new.status = 'awaiting_validation')
      or (old.status = 'awaiting_validation' and new.status in ('validated', 'rejected'))
      or (old.status = 'failed' and new.status in ('queued', 'cancelled'))) then
      raise exception using errcode = '23514', message = 'Invalid OCR job state transition';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end
$$;

create or replace function ocr.record_job_event()
returns trigger language plpgsql security definer set search_path = ocr, platform, pg_temp as $$
declare event_name text;
begin
  event_name := case new.status when 'queued' then 'OcrJobQueued'
    when 'processing' then 'OcrProcessingStarted' when 'extracted' then 'OcrExtractionCreated'
    when 'awaiting_validation' then 'OcrAwaitingValidation' when 'validated' then 'OcrValidated'
    when 'rejected' then 'OcrValidationRejected' when 'failed' then 'OcrFailed'
    else 'OcrJobCancelled' end;
  insert into ocr.job_events (job_id, facility_id, from_status, to_status, job_version,
    actor_subject, correlation_id, reason_code) values (new.id, new.facility_id,
    case when tg_op = 'UPDATE' then old.status end, new.status, new.row_version,
    platform.current_actor_subject(), new.correlation_id, new.last_error_code);
  insert into ocr.outbox_events (event_type, aggregate_id, aggregate_version,
    facility_id, correlation_id, payload) values (event_name, new.id, new.row_version,
    new.facility_id, new.correlation_id, jsonb_build_object('jobId', new.id,
      'documentId', new.document_id, 'status', new.status,
      'patientResolved', new.patient_id is not null));
  return new;
end
$$;

alter table ocr.patient_confirmations enable row level security;
alter table ocr.patient_confirmations force row level security;
alter table ocr.publications enable row level security;
alter table ocr.publications force row level security;
alter table ehr.ocr_import_provenance enable row level security;
alter table ehr.ocr_import_provenance force row level security;
create policy ocr_patient_confirmations_staff on ocr.patient_confirmations for all
  using (facility_id = platform.current_facility_id()) with check (facility_id = platform.current_facility_id());
create policy ocr_publications_staff on ocr.publications for all
  using (facility_id = platform.current_facility_id()) with check (facility_id = platform.current_facility_id());
create policy ehr_ocr_import_provenance_staff on ehr.ocr_import_provenance for all
  using (facility_id = platform.current_facility_id()) with check (facility_id = platform.current_facility_id());

revoke all on ocr.patient_confirmations, ocr.publications, ehr.ocr_import_provenance from public;
revoke all on all sequences in schema ocr from public;

comment on table ocr.patient_confirmations is 'Append-only human confirmation of the canonical Identity patient for OCR evidence.';
comment on table ocr.publications is 'Durable idempotent command state; publication is separate from human validation.';
comment on table ehr.ocr_import_provenance is 'EHR-owned immutable provenance for clinical artifacts imported through the EHR service boundary.';
