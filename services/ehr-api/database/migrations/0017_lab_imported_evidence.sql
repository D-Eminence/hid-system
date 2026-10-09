-- Lab-owned imported/external evidence. This is not native HID Lab execution.
-- Applied migrations 0001 through 0016 remain immutable.

create schema if not exists lab;

insert into auth.permissions (code, description) values
  ('lab.import.read', 'Read authorized Lab-owned imported external evidence'),
  ('lab.import.write', 'Create Lab-owned imported external evidence');

insert into auth.role_permissions (role_code, permission_code)
select role_code, permission_code from (values
  ('doctor', 'lab.import.read'), ('doctor', 'lab.import.write'),
  ('clinician', 'lab.import.read'), ('clinician', 'lab.import.write'),
  ('nurse', 'lab.import.read'), ('nurse', 'lab.import.write'),
  ('lab', 'lab.import.read'), ('lab', 'lab.import.write'),
  ('admin', 'lab.import.read')
) mapping(role_code, permission_code);

alter table ocr.publications drop constraint publications_target_operation_check;
alter table ocr.publications add constraint publications_target_operation_check check (
  target_operation in ('create_imported_clinical_note', 'retain_validated_document',
    'create_imported_lab_evidence')
);

create table lab.imported_evidence (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  source_type text not null default 'IMPORTED_EXTERNAL' check (source_type = 'IMPORTED_EXTERNAL'),
  status text not null default 'accepted' check (status in ('accepted', 'entered_in_error', 'amended')),
  external_lab_name text check (external_lab_name is null or length(btrim(external_lab_name)) between 1 and 240),
  external_reference text check (external_reference is null or length(btrim(external_reference)) between 1 and 240),
  collected_at timestamptz,
  reported_at timestamptz,
  received_at timestamptz not null default clock_timestamp(),
  source_document_id uuid not null references ehr.documents(id) on delete restrict,
  ocr_job_id uuid,
  extraction_id uuid,
  validation_id uuid,
  validation_version integer check (validation_version is null or validation_version > 0),
  publication_id uuid unique references ocr.publications(id) on delete restrict,
  reviewed_by uuid not null references auth.accounts(id) on delete restrict,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  foreign key (ocr_job_id, facility_id) references ocr.jobs(id, facility_id) on delete restrict,
  foreign key (validation_id) references ocr.validations(id) on delete restrict,
  unique (facility_id, created_by, idempotency_key),
  check ((ocr_job_id is null and extraction_id is null and validation_id is null
          and validation_version is null and publication_id is null)
      or (ocr_job_id is not null and extraction_id is not null and validation_id is not null
          and validation_version is not null and publication_id is not null)),
  check (reported_at is null or collected_at is null or reported_at >= collected_at)
);
create index lab_imported_evidence_patient_timeline_idx
  on lab.imported_evidence(facility_id,patient_id,received_at desc,id);

create table lab.imported_observations (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references lab.imported_evidence(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  "ordinal" integer not null check ("ordinal" between 1 and 200),
  test_code text check (test_code is null or length(btrim(test_code)) between 1 and 120),
  test_name text not null check (length(btrim(test_name)) between 1 and 240),
  value text check (value is null or length(btrim(value)) between 1 and 240),
  value_text text check (value_text is null or length(btrim(value_text)) between 1 and 2000),
  unit text check (unit is null or length(btrim(unit)) between 1 and 80),
  reference_range text check (reference_range is null or length(btrim(reference_range)) between 1 and 240),
  abnormal_flag text not null default 'unknown'
    check (abnormal_flag in ('normal','low','high','critical','abnormal','unknown')),
  reported_at timestamptz,
  status text not null default 'reported' check (status = 'reported'),
  created_at timestamptz not null default clock_timestamp(),
  unique(import_id,"ordinal"),
  check (value is not null or value_text is not null)
);

create table lab.outbox_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('LabImportedEvidenceCreated','LabImportedEvidenceAmended')),
  event_version integer not null default 1 check (event_version = 1),
  aggregate_id uuid not null references lab.imported_evidence(id) on delete restrict,
  aggregate_version bigint not null check (aggregate_version > 0),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default clock_timestamp(),
  unique(event_type,aggregate_id,aggregate_version)
);
create index lab_outbox_pending_idx on lab.outbox_events(next_attempt_at,occurred_at,id)
  where published_at is null;

create or replace function lab.context_allows(row_patient_id uuid,row_facility_id uuid,requested_action text)
returns boolean language sql stable security definer
set search_path = lab,identity,platform,pg_temp as $$
  select row_facility_id=platform.current_facility_id()
    and identity.has_active_consent_grant(row_patient_id,platform.current_actor_subject(),
      platform.current_membership_id(),row_facility_id,requested_action,platform.current_purpose_of_use())
$$;

create or replace function lab.validate_imported_evidence()
returns trigger language plpgsql security definer
set search_path = lab,ehr,ocr,identity,auth,platform,pg_temp as $$
declare source_row record; job_row record; extraction_row record; validation_row record; publication_row record;
begin
  select patient_id,facility_id into source_row from ehr.documents where id=new.source_document_id;
  if source_row.patient_id is null or source_row.patient_id<>new.patient_id or source_row.facility_id<>new.facility_id
     or new.facility_id<>platform.current_facility_id()
     or new.created_by<>platform.current_account_id()
     or new.created_by_membership_id<>platform.current_membership_id() then
    raise exception using errcode='23514',message='Lab import source, patient, facility, or actor context is invalid';
  end if;
  if new.publication_id is not null then
    select document_id,patient_id,facility_id into job_row from ocr.jobs where id=new.ocr_job_id;
    select job_id,document_id into extraction_row from ocr.extractions where id=new.extraction_id;
    select job_id,extraction_id,validation_version,disposition,target_domain,validated_by
      into validation_row from ocr.validations where id=new.validation_id;
    select job_id,validation_id,validation_version,patient_id,facility_id,target_domain,target_operation,status
      into publication_row from ocr.publications where id=new.publication_id;
    if job_row.document_id<>new.source_document_id or job_row.patient_id<>new.patient_id
       or job_row.facility_id<>new.facility_id or extraction_row.job_id<>new.ocr_job_id
       or extraction_row.document_id<>new.source_document_id or validation_row.job_id<>new.ocr_job_id
       or validation_row.extraction_id<>new.extraction_id
       or validation_row.validation_version<>new.validation_version
       or validation_row.disposition<>'validated' or validation_row.target_domain<>'LAB'
       or validation_row.validated_by<>new.reviewed_by
       or publication_row.job_id<>new.ocr_job_id or publication_row.validation_id<>new.validation_id
       or publication_row.validation_version<>new.validation_version
       or publication_row.patient_id<>new.patient_id or publication_row.facility_id<>new.facility_id
       or publication_row.target_domain<>'LAB'
       or publication_row.target_operation<>'create_imported_lab_evidence'
       or publication_row.status<>'processing' then
      raise exception using errcode='23514',message='Lab import is not bound to exact governed OCR publication evidence';
    end if;
  end if;
  return new;
end
$$;
create trigger lab_imported_evidence_validate before insert on lab.imported_evidence
  for each row execute function lab.validate_imported_evidence();

create or replace function lab.validate_imported_observation()
returns trigger language plpgsql security definer set search_path=lab,pg_temp as $$
declare parent_row record;
begin
  select facility_id,patient_id into parent_row from lab.imported_evidence where id=new.import_id;
  if parent_row.facility_id is null or parent_row.facility_id<>new.facility_id
     or parent_row.patient_id<>new.patient_id then
    raise exception using errcode='23514',message='Imported Lab observation does not match its evidence aggregate';
  end if;
  return new;
end
$$;
create trigger lab_imported_observation_validate before insert on lab.imported_observations
  for each row execute function lab.validate_imported_observation();

create or replace function lab.reject_immutable_evidence()
returns trigger language plpgsql set search_path=lab,pg_temp as $$
begin raise exception using errcode='55000',message='Imported Lab evidence is append-only'; end
$$;
create trigger lab_imported_evidence_immutable before update or delete on lab.imported_evidence
  for each row execute function lab.reject_immutable_evidence();
create trigger lab_imported_observations_immutable before update or delete on lab.imported_observations
  for each row execute function lab.reject_immutable_evidence();

alter table lab.imported_evidence enable row level security;
alter table lab.imported_evidence force row level security;
alter table lab.imported_observations enable row level security;
alter table lab.imported_observations force row level security;
alter table lab.outbox_events enable row level security;
alter table lab.outbox_events force row level security;
create policy lab_imported_evidence_read on lab.imported_evidence for select
  using (lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_imported_evidence_insert on lab.imported_evidence for insert
  with check (lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_imported_observations_read on lab.imported_observations for select
  using (lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_imported_observations_insert on lab.imported_observations for insert
  with check (lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_outbox_staff_read on lab.outbox_events for select
  using (facility_id=platform.current_facility_id());
create policy lab_outbox_staff_insert on lab.outbox_events for insert
  with check (facility_id=platform.current_facility_id());

revoke all on schema lab from public;
revoke all on all tables in schema lab from public;
revoke all on all sequences in schema lab from public;
revoke all on all functions in schema lab from public;
alter default privileges in schema lab revoke all on tables from public;
alter default privileges in schema lab revoke all on functions from public;

comment on table lab.imported_evidence is
  'Lab-owned imported external evidence; never represents native HID accession, specimen, execution, QC, or verification.';
comment on table lab.imported_observations is
  'Immutable transcribed observations belonging to imported external Lab evidence.';
comment on table lab.outbox_events is
  'Minimum-necessary transactional Lab domain events pending external delivery.';
