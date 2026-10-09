-- EHR-owned clinical events. There is intentionally no EHR patient table.

create table ehr.record_versions (
  id bigint generated always as identity primary key,
  version_id uuid not null unique default gen_random_uuid(),
  resource_type text not null check (length(resource_type) between 1 and 80),
  resource_id text not null check (length(resource_id) between 1 and 255),
  resource_uuid uuid generated always as (
    case
      when resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then resource_id::uuid
      else null
    end
  ) stored,
  version_no bigint not null check (version_no > 0),
  operation text not null check (operation in ('create', 'update')),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  changed_by uuid not null references auth.accounts(id) on delete restrict,
  changed_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  actor_subject text not null,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  change_reason text not null check (length(btrim(change_reason)) between 3 and 500),
  prior_state jsonb,
  resulting_state jsonb not null check (jsonb_typeof(resulting_state) = 'object'),
  content_sha256 char(64) not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (resource_type, resource_id, version_no),
  foreign key (changed_by_membership_id, facility_id, changed_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict
);

create index record_versions_resource_idx on ehr.record_versions (resource_type, resource_id, version_no desc);
create index record_versions_patient_idx on ehr.record_versions (patient_id, recorded_at desc);

create table ehr.encounters (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  encounter_number text check (encounter_number is null or length(encounter_number) <= 80),
  encounter_type text not null check (encounter_type in ('ambulatory', 'emergency', 'inpatient', 'home', 'virtual', 'other')),
  status text not null check (status in ('planned', 'in_progress', 'on_hold', 'completed', 'cancelled', 'entered_in_error')),
  started_at timestamptz not null,
  ended_at timestamptz,
  chief_complaint text check (chief_complaint is null or length(chief_complaint) <= 4000),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, patient_id, facility_id),
  unique (facility_id, encounter_number),
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (ended_at is null or ended_at >= started_at),
  check ((status = 'completed' and ended_at is not null) or status <> 'completed')
);

create index encounters_patient_timeline_idx on ehr.encounters (patient_id, started_at desc);
create index encounters_facility_status_idx on ehr.encounters (facility_id, status, started_at desc);

create table ehr.clinical_notes (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null,
  patient_id uuid not null,
  facility_id uuid not null,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  note_type text not null check (length(note_type) between 1 and 80),
  title text not null check (length(title) between 1 and 240),
  status text not null default 'draft' check (status in ('draft', 'signed', 'amended', 'entered_in_error')),
  current_revision_no integer not null default 1 check (current_revision_no > 0),
  signed_at timestamptz,
  signed_by uuid references auth.accounts(id) on delete restrict,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, patient_id, facility_id),
  foreign key (encounter_id, patient_id, facility_id)
    references ehr.encounters(id, patient_id, facility_id) on delete restrict,
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check ((status in ('signed', 'amended') and signed_at is not null and signed_by is not null) or status not in ('signed', 'amended'))
);

create table ehr.clinical_note_revisions (
  id uuid primary key default gen_random_uuid(),
  clinical_note_id uuid not null,
  patient_id uuid not null,
  facility_id uuid not null,
  revision_no integer not null check (revision_no > 0),
  content text not null check (length(btrim(content)) > 0 and char_length(content) <= 100000),
  change_reason text not null check (length(btrim(change_reason)) between 3 and 500),
  supersedes_revision_no integer,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  content_sha256 char(64) generated always as (encode(public.digest(content, 'sha256'), 'hex')) stored,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (clinical_note_id, patient_id, facility_id)
    references ehr.clinical_notes(id, patient_id, facility_id) on delete restrict,
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (clinical_note_id, revision_no),
  check (supersedes_revision_no is null or supersedes_revision_no < revision_no)
);

alter table ehr.clinical_notes
  add constraint clinical_notes_current_revision_fk
  foreign key (id, current_revision_no)
  references ehr.clinical_note_revisions(clinical_note_id, revision_no)
  on delete restrict
  deferrable initially deferred;

create index clinical_notes_encounter_idx on ehr.clinical_notes (encounter_id, created_at desc);

create table ehr.vitals (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null,
  patient_id uuid not null,
  facility_id uuid not null,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  recorded_at timestamptz not null,
  height_cm numeric(6,2) check (height_cm is null or height_cm between 20 and 300),
  weight_kg numeric(7,3) check (weight_kg is null or weight_kg between 0.2 and 700),
  temperature_c numeric(4,1) check (temperature_c is null or temperature_c between 20 and 50),
  pulse_bpm smallint check (pulse_bpm is null or pulse_bpm between 10 and 350),
  respiratory_rate smallint check (respiratory_rate is null or respiratory_rate between 1 and 100),
  systolic_mmhg smallint check (systolic_mmhg is null or systolic_mmhg between 30 and 350),
  diastolic_mmhg smallint check (diastolic_mmhg is null or diastolic_mmhg between 10 and 250),
  oxygen_saturation_percent numeric(5,2) check (oxygen_saturation_percent is null or oxygen_saturation_percent between 0 and 100),
  source text not null default 'manual' check (source in ('manual', 'device', 'import')),
  current_correction_no integer not null default 0 check (current_correction_no >= 0),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, patient_id, facility_id),
  foreign key (encounter_id, patient_id, facility_id)
    references ehr.encounters(id, patient_id, facility_id) on delete restrict,
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (num_nonnulls(height_cm, weight_kg, temperature_c, pulse_bpm, respiratory_rate, systolic_mmhg, diastolic_mmhg, oxygen_saturation_percent) > 0),
  check ((systolic_mmhg is null) = (diastolic_mmhg is null))
);

create table ehr.vital_corrections (
  id uuid primary key default gen_random_uuid(),
  vital_id uuid not null,
  patient_id uuid not null,
  facility_id uuid not null,
  correction_no integer not null check (correction_no > 0),
  replacement_values jsonb not null check (jsonb_typeof(replacement_values) = 'object'),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  content_sha256 char(64) generated always as (encode(public.digest(replacement_values::text, 'sha256'), 'hex')) stored,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (vital_id, patient_id, facility_id)
    references ehr.vitals(id, patient_id, facility_id) on delete restrict,
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (vital_id, correction_no),
  check (replacement_values <> '{}'::jsonb),
  check (octet_length(replacement_values::text) <= 16384),
  check ((replacement_values - array[
    'height_cm', 'weight_kg', 'temperature_c', 'pulse_bpm', 'respiratory_rate',
    'systolic_mmhg', 'diastolic_mmhg', 'oxygen_saturation_percent'
  ]) = '{}'::jsonb)
);

create index vitals_encounter_time_idx on ehr.vitals (encounter_id, recorded_at desc);

create table ehr.diagnoses (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null,
  patient_id uuid not null,
  facility_id uuid not null,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  code_system text not null check (length(code_system) between 1 and 255),
  code text not null check (length(code) between 1 and 100),
  display text not null check (length(display) between 1 and 500),
  clinical_status text not null check (clinical_status in ('active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved')),
  verification_status text not null check (verification_status in ('unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted', 'entered_in_error')),
  onset_at timestamptz,
  abatement_at timestamptz,
  notes text check (notes is null or char_length(notes) <= 4000),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, patient_id, facility_id),
  foreign key (encounter_id, patient_id, facility_id)
    references ehr.encounters(id, patient_id, facility_id) on delete restrict,
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (abatement_at is null or onset_at is null or abatement_at >= onset_at)
);

create index diagnoses_patient_status_idx on ehr.diagnoses (patient_id, clinical_status, created_at desc);
create index diagnoses_code_idx on ehr.diagnoses (code_system, code);

create table ehr.prescriptions (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null,
  patient_id uuid not null,
  facility_id uuid not null,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  medication_code_system text check (medication_code_system is null or length(medication_code_system) <= 255),
  medication_code text check (medication_code is null or length(medication_code) <= 100),
  medication_display text not null check (length(medication_display) between 1 and 500),
  dose_quantity numeric(12,4),
  dose_unit text check (dose_unit is null or length(dose_unit) <= 80),
  route_code text check (route_code is null or length(route_code) <= 100),
  frequency text not null check (length(frequency) between 1 and 240),
  instructions text not null check (length(instructions) between 1 and 4000),
  starts_on date,
  ends_on date,
  status text not null check (status in ('draft', 'active', 'on_hold', 'completed', 'cancelled', 'entered_in_error')),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, patient_id, facility_id),
  foreign key (encounter_id, patient_id, facility_id)
    references ehr.encounters(id, patient_id, facility_id) on delete restrict,
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check ((dose_quantity is null) = (dose_unit is null)),
  check (dose_quantity is null or dose_quantity > 0),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create index prescriptions_patient_status_idx on ehr.prescriptions (patient_id, status, created_at desc);

create table ehr.lab_requests (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null,
  patient_id uuid not null,
  facility_id uuid not null,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  test_code_system text not null check (length(test_code_system) between 1 and 255),
  test_code text not null check (length(test_code) between 1 and 100),
  test_display text not null check (length(test_display) between 1 and 500),
  priority text not null default 'routine' check (priority in ('routine', 'urgent', 'asap', 'stat')),
  status text not null check (status in ('draft', 'active', 'on_hold', 'completed', 'cancelled', 'entered_in_error')),
  specimen_type_code text check (specimen_type_code is null or length(specimen_type_code) <= 100),
  clinical_information text check (clinical_information is null or char_length(clinical_information) <= 4000),
  external_order_reference text check (external_order_reference is null or length(external_order_reference) <= 255),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, patient_id, facility_id),
  foreign key (encounter_id, patient_id, facility_id)
    references ehr.encounters(id, patient_id, facility_id) on delete restrict,
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict
);

create index lab_requests_patient_status_idx on ehr.lab_requests (patient_id, status, created_at desc);
create index lab_requests_facility_queue_idx on ehr.lab_requests (facility_id, priority, created_at) where status = 'active';

create table ehr.documents (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  original_file_name text not null check (length(original_file_name) between 1 and 255),
  storage_bucket text not null check (length(storage_bucket) between 3 and 63),
  storage_key text not null check (length(storage_key) between 1 and 1024),
  object_version_id text check (object_version_id is null or length(object_version_id) <= 1024),
  declared_media_type text not null check (length(declared_media_type) between 1 and 255),
  size_bytes bigint check (size_bytes is null or size_bytes between 1 and 52428800),
  sha256_hex char(64),
  classification text not null default 'phi' check (classification in ('phi', 'restricted', 'internal')),
  status text not null default 'initiated' check (status in ('initiated', 'uploaded', 'rejected', 'entered_in_error')),
  retention_class text not null check (length(retention_class) between 1 and 80),
  legal_hold boolean not null default false,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, patient_id, facility_id),
  unique (storage_bucket, storage_key, object_version_id),
  foreign key (encounter_id, patient_id, facility_id)
    references ehr.encounters(id, patient_id, facility_id) on delete restrict,
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (sha256_hex is null or sha256_hex ~ '^[0-9a-f]{64}$'),
  check (status <> 'uploaded' or (object_version_id is not null and size_bytes is not null and sha256_hex is not null))
);

create index documents_patient_idx on ehr.documents (patient_id, created_at desc);
create unique index documents_pending_object_key_uq
  on ehr.documents (storage_bucket, storage_key) where object_version_id is null;

create table ehr.document_scan_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  patient_id uuid not null,
  facility_id uuid not null,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  event_type text not null check (event_type in ('scan_started', 'clean', 'rejected', 'failed')),
  detected_media_type text check (detected_media_type is null or length(detected_media_type) <= 255),
  scanner_engine text not null check (length(scanner_engine) between 1 and 120 and length(btrim(scanner_engine)) > 0),
  scanner_version text not null check (length(scanner_version) between 1 and 120 and length(btrim(scanner_version)) > 0),
  reason_code text check (reason_code is null or length(reason_code) <= 120),
  idempotency_key text not null check (
    length(idempotency_key) between 16 and 128
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
  ),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (document_id, patient_id, facility_id)
    references ehr.documents(id, patient_id, facility_id) on delete restrict,
  unique (document_id, idempotency_key),
  check (event_type not in ('rejected', 'failed') or reason_code is not null),
  check (
    event_type <> 'clean'
    or detected_media_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/tiff')
  )
);

create index document_scan_events_document_idx on ehr.document_scan_events (document_id, created_at desc);

create view ehr.documents_effective
with (security_invoker = true, security_barrier = true)
as
select document_row.id,
       document_row.encounter_id,
       document_row.patient_id,
       document_row.facility_id,
       document_row.created_by,
       document_row.created_by_membership_id,
       document_row.original_file_name,
       document_row.storage_bucket,
       document_row.storage_key,
       document_row.object_version_id,
       document_row.declared_media_type,
       latest_scan.detected_media_type,
       document_row.size_bytes,
       document_row.sha256_hex,
       document_row.classification,
       coalesce(latest_scan.event_type, 'pending') as scan_status,
       case
         when document_row.status = 'uploaded' and latest_scan.event_type = 'clean' then 'available'
         when latest_scan.event_type = 'rejected' then 'rejected'
         else document_row.status
       end as status,
       document_row.retention_class,
       document_row.legal_hold,
       document_row.row_version,
       document_row.created_at,
       document_row.updated_at
from ehr.documents document_row
left join lateral (
  select scan.event_type, scan.detected_media_type
  from ehr.document_scan_events scan
  where scan.document_id = document_row.id
  order by scan.created_at desc, scan.id desc
  limit 1
) latest_scan on true;

create table ehr.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text not null check (length(idempotency_key) between 16 and 128),
  operation text not null check (length(operation) between 1 and 160),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'processing' check (state in ('processing', 'completed', 'failed')),
  result_resource_type text,
  result_resource_id text,
  response_status smallint check (response_status is null or response_status between 100 and 599),
  locked_until timestamptz not null,
  expires_at timestamptz not null,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (facility_id, created_by, operation, idempotency_key),
  check (expires_at > created_at),
  check (
    (state = 'completed' and result_resource_type is not null and result_resource_id is not null and response_status is not null)
    or state <> 'completed'
  )
);

create index idempotency_expiry_idx on ehr.idempotency_keys (expires_at);

create or replace function ehr.capture_record_version()
returns trigger
language plpgsql
security definer
set search_path = ehr, auth, identity, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  correlation text := platform.current_correlation_id();
  membership_id uuid := platform.current_membership_id();
  facility uuid;
  patient uuid;
  creator uuid;
  resource text;
  reason text;
  old_state jsonb;
  new_state jsonb;
begin
  if actor_subject is null or actor_account_id is null or correlation is null or membership_id is null then
    raise exception using errcode = '42501', message = 'Verified actor, membership, and correlation context are required';
  end if;

  facility := (to_jsonb(new)->>'facility_id')::uuid;
  patient := (to_jsonb(new)->>'patient_id')::uuid;
  creator := (to_jsonb(new)->>'created_by')::uuid;
  resource := to_jsonb(new)->>'id';

  if not identity.has_active_membership(actor_subject, membership_id, facility) then
    raise exception using errcode = '42501', message = 'Active facility membership is required';
  end if;

  if tg_op = 'INSERT' then
    if creator <> actor_account_id then
      raise exception using errcode = '42501', message = 'created_by must match the authenticated account';
    end if;
    if (to_jsonb(new)->>'created_by_membership_id')::uuid <> membership_id then
      raise exception using errcode = '42501', message = 'created_by membership must match the selected membership';
    end if;
    new.row_version := 1;
    new.updated_at := clock_timestamp();
    reason := 'create';
    old_state := null;
  else
    old_state := to_jsonb(old);
    if old_state->>'id' is distinct from resource
       or old_state->>'patient_id' is distinct from patient::text
       or old_state->>'facility_id' is distinct from facility::text
       or old_state->>'created_by' is distinct from creator::text
       or old_state->>'created_by_membership_id' is distinct from to_jsonb(new)->>'created_by_membership_id' then
      raise exception using errcode = '55000', message = 'Clinical ownership and attribution fields are immutable';
    end if;
    reason := nullif(current_setting('app.change_reason', true), '');
    if reason is null or length(btrim(reason)) < 3 then
      raise exception using errcode = '22023', message = 'A change reason is required for clinical updates';
    end if;
    new.row_version := old.row_version + 1;
    new.updated_at := clock_timestamp();
  end if;

  new_state := to_jsonb(new);
  insert into ehr.record_versions (
    resource_type,
    resource_id,
    version_no,
    operation,
    patient_id,
    facility_id,
    changed_by,
    changed_by_membership_id,
    actor_subject,
    correlation_id,
    change_reason,
    prior_state,
    resulting_state,
    content_sha256
  ) values (
    tg_table_name,
    resource,
    new.row_version,
    case when tg_op = 'INSERT' then 'create' else 'update' end,
    patient,
    facility,
    actor_account_id,
    membership_id,
    actor_subject,
    correlation,
    reason,
    old_state,
    new_state,
    encode(public.digest(new_state::text, 'sha256'), 'hex')
  );

  return new;
end;
$$;

create trigger encounters_versioned before insert or update on ehr.encounters
  for each row execute function ehr.capture_record_version();
create trigger clinical_notes_versioned before insert or update on ehr.clinical_notes
  for each row execute function ehr.capture_record_version();
create trigger vitals_versioned before insert or update on ehr.vitals
  for each row execute function ehr.capture_record_version();
create trigger diagnoses_versioned before insert or update on ehr.diagnoses
  for each row execute function ehr.capture_record_version();
create trigger prescriptions_versioned before insert or update on ehr.prescriptions
  for each row execute function ehr.capture_record_version();
create trigger lab_requests_versioned before insert or update on ehr.lab_requests
  for each row execute function ehr.capture_record_version();
create trigger documents_versioned before insert or update on ehr.documents
  for each row execute function ehr.capture_record_version();
create trigger idempotency_keys_versioned before insert or update on ehr.idempotency_keys
  for each row execute function ehr.capture_record_version();

create trigger encounters_no_delete before delete on ehr.encounters
  for each row execute function platform.reject_mutation();
create trigger clinical_notes_no_delete before delete on ehr.clinical_notes
  for each row execute function platform.reject_mutation();
create trigger vitals_no_delete before delete on ehr.vitals
  for each row execute function platform.reject_mutation();
create trigger diagnoses_no_delete before delete on ehr.diagnoses
  for each row execute function platform.reject_mutation();
create trigger prescriptions_no_delete before delete on ehr.prescriptions
  for each row execute function platform.reject_mutation();
create trigger lab_requests_no_delete before delete on ehr.lab_requests
  for each row execute function platform.reject_mutation();
create trigger documents_no_delete before delete on ehr.documents
  for each row execute function platform.reject_mutation();
create trigger idempotency_keys_no_delete before delete on ehr.idempotency_keys
  for each row execute function platform.reject_mutation();

create trigger record_versions_no_mutation before update or delete on ehr.record_versions
  for each row execute function platform.reject_mutation();
create trigger clinical_note_revisions_no_mutation before update or delete on ehr.clinical_note_revisions
  for each row execute function platform.reject_mutation();
create trigger vital_corrections_no_mutation before update or delete on ehr.vital_corrections
  for each row execute function platform.reject_mutation();
create trigger document_scan_events_no_mutation before update or delete on ehr.document_scan_events
  for each row execute function platform.reject_mutation();

comment on table ehr.documents is
  'Private S3 object metadata only. Presigned URLs and object bytes are never persisted in PostgreSQL.';
comment on table ehr.idempotency_keys is
  'Stores request hashes and resource references, not copied PHI response bodies.';
