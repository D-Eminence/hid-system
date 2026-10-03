-- First-class imported history. No fabricated encounter, source facility or signature.
create table ehr.imported_medical_records (
  id uuid primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  author_account_id uuid not null references auth.accounts(id) on delete restrict,
  origin text not null check (origin in ('patient-provided','provider-authored')),
  current_version_id uuid not null,
  source_run_id uuid not null references migration.runs(id) on delete restrict,
  source_payload jsonb not null check (jsonb_typeof(source_payload) = 'object'),
  source_sha256 char(64) not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_created_at timestamptz not null,
  source_updated_at timestamptz not null,
  imported_at timestamptz not null default clock_timestamp(),
  unique (id,patient_id)
);
create table ehr.imported_medical_record_versions (
  id uuid primary key,
  record_id uuid not null,
  patient_id uuid not null,
  version_no integer not null check (version_no > 0),
  author_account_id uuid not null references auth.accounts(id) on delete restrict,
  origin text not null check (origin in ('patient-provided','provider-authored')),
  source_payload jsonb not null check (jsonb_typeof(source_payload) = 'object'),
  source_sha256 char(64) not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_created_at timestamptz not null,
  foreign key (record_id,patient_id) references ehr.imported_medical_records(id,patient_id) on delete restrict,
  unique (record_id,version_no),
  unique (id,record_id,patient_id)
);
alter table ehr.imported_medical_records add constraint imported_current_version
  foreign key (current_version_id,id,patient_id)
  references ehr.imported_medical_record_versions(id,record_id,patient_id)
  deferrable initially deferred;
create table ehr.imported_medical_record_files (
  id uuid primary key,
  record_id uuid not null,
  patient_id uuid not null,
  record_version_id uuid,
  uploader_account_id uuid not null references auth.accounts(id) on delete restrict,
  source_payload jsonb not null check (jsonb_typeof(source_payload) = 'object'),
  source_sha256 char(64) not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_created_at timestamptz not null,
  foreign key (record_id,patient_id) references ehr.imported_medical_records(id,patient_id) on delete restrict,
  foreign key (record_version_id,record_id,patient_id)
    references ehr.imported_medical_record_versions(id,record_id,patient_id) on delete restrict
);
create index imported_medical_records_patient on ehr.imported_medical_records(patient_id,source_created_at desc,id);
create index imported_versions_record on ehr.imported_medical_record_versions(record_id,version_no);
create index imported_files_record on ehr.imported_medical_record_files(record_id);

create function ehr.imported_record_read_context(requested_patient uuid)
returns boolean language sql stable set search_path = ehr, platform, pg_temp as $$
  select coalesce(ehr.patient_self_context(requested_patient)
    or ehr.context_allows(requested_patient,platform.current_facility_id(),'read_records'), false)
$$;
revoke all on function ehr.imported_record_read_context(uuid) from public;

-- FORCE RLS covers runtime and owner connections. Only the schema owner may
-- import; runtime roles receive SELECT only and cannot assume that owner role.
do $$
declare table_name text;
begin
  foreach table_name in array array['imported_medical_records','imported_medical_record_versions','imported_medical_record_files'] loop
    execute format('alter table ehr.%I enable row level security',table_name);
    execute format('alter table ehr.%I force row level security',table_name);
    execute format('create policy imported_history_read on ehr.%I for select using (ehr.imported_record_read_context(patient_id))',table_name);
    execute format('create policy imported_history_owner on ehr.%I for all using (current_user = %L) with check (current_user = %L)',table_name,current_user,current_user);
    execute format('create trigger imported_history_no_mutation before update or delete on ehr.%I for each row execute function platform.reject_mutation()',table_name);
    execute format('revoke all on ehr.%I from public',table_name);
  end loop;
end $$;
comment on table ehr.imported_medical_records is 'Immutable original medical history; patient-provided content is not a signed clinician note.';
comment on table ehr.imported_medical_record_files is 'Preserved attachment metadata only. No download eligibility without separately verified object binding and clean scan.';
