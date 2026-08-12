-- Durable, facility-scoped OCR processing. OCR output remains provisional and
-- cannot create Identity patients or clinical records.

create schema if not exists ocr;
revoke all on schema ocr from public;

insert into auth.roles (code, description) values
  ('ocr_worker', 'Workload identity permitted to claim and complete OCR jobs');

insert into auth.permissions (code, description) values
  ('ocr.job.read', 'Read facility-scoped OCR jobs and extraction evidence'),
  ('ocr.job.write', 'Create and retry facility-scoped OCR jobs'),
  ('ocr.validation.write', 'Append human OCR validation evidence'),
  ('ocr.job.process', 'Claim and complete OCR jobs as an isolated workload');

insert into auth.role_permissions (role_code, permission_code)
select role_code, permission_code from (values
  ('doctor', 'ocr.job.read'), ('doctor', 'ocr.job.write'), ('doctor', 'ocr.validation.write'),
  ('clinician', 'ocr.job.read'), ('clinician', 'ocr.job.write'), ('clinician', 'ocr.validation.write'),
  ('nurse', 'ocr.job.read'), ('nurse', 'ocr.job.write'), ('nurse', 'ocr.validation.write'),
  ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'), ('lab', 'ocr.validation.write'),
  ('admin', 'ocr.job.read'),
  ('ocr_worker', 'ocr.job.process')
) mapping(role_code, permission_code);

create table ocr.jobs (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  document_id uuid not null references ehr.documents(id) on delete restrict,
  patient_id uuid references identity.patients(id) on delete restrict,
  source_object_version_id text not null check (length(source_object_version_id) between 1 and 1024),
  source_sha256_hex char(64) not null check (source_sha256_hex ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check (
    status in ('queued', 'processing', 'extracted', 'awaiting_validation', 'validated', 'failed', 'cancelled')
  ),
  operation text not null default 'ocr.extract' check (operation = 'ocr.extract'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  provider text not null check (length(btrim(provider)) between 1 and 120),
  provider_job_reference text check (provider_job_reference is null or length(provider_job_reference) <= 255),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  queued_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{2,80}$'),
  last_error_summary text check (last_error_summary is null or length(last_error_summary) <= 240),
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (facility_id, created_by, operation, idempotency_key),
  unique (id, facility_id),
  foreign key (document_id, source_object_version_id, source_sha256_hex)
    references ehr.documents(id, object_version_id, sha256_hex) on delete restrict,
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (attempt_count <= max_attempts),
  check ((status = 'processing') = (started_at is not null and completed_at is null and failed_at is null)
    or status <> 'processing'),
  check (status <> 'failed' or (failed_at is not null and last_error_code is not null)),
  check (status <> 'validated' or completed_at is not null)
);

create index ocr_jobs_claim_idx on ocr.jobs (next_attempt_at, queued_at, id) where status = 'queued';
create index ocr_jobs_facility_created_idx on ocr.jobs (facility_id, created_at desc, id);
create index ocr_jobs_document_idx on ocr.jobs (document_id, created_at desc);

create table ocr.job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  facility_id uuid not null,
  from_status text,
  to_status text not null,
  job_version bigint not null check (job_version > 0),
  actor_subject text,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  reason_code text check (reason_code is null or reason_code ~ '^[A-Z0-9_]{2,80}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (job_id, facility_id) references ocr.jobs(id, facility_id) on delete restrict,
  unique (job_id, job_version)
);

create table ocr.extractions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  facility_id uuid not null,
  document_id uuid not null references ehr.documents(id) on delete restrict,
  patient_id uuid references identity.patients(id) on delete restrict,
  extraction_version integer not null check (extraction_version > 0),
  attempt_no integer not null check (attempt_no > 0),
  provider text not null check (length(btrim(provider)) between 1 and 120),
  provider_model text not null check (length(btrim(provider_model)) between 1 and 160),
  provider_request_reference text check (provider_request_reference is null or length(provider_request_reference) <= 255),
  provider_result_key text not null check (length(provider_result_key) between 8 and 255),
  content_sha256 char(64) not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_object_version_id text not null,
  source_sha256_hex char(64) not null check (source_sha256_hex ~ '^[0-9a-f]{64}$'),
  raw_text text,
  structured_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(structured_payload) = 'object'),
  confidence numeric(6,5) check (confidence is null or confidence between 0 and 1),
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (job_id, facility_id) references ocr.jobs(id, facility_id) on delete restrict,
  foreign key (document_id, source_object_version_id, source_sha256_hex)
    references ehr.documents(id, object_version_id, sha256_hex) on delete restrict,
  unique (job_id, extraction_version),
  unique (job_id, provider_result_key)
);

create table ocr.validations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  facility_id uuid not null,
  extraction_id uuid not null references ocr.extractions(id) on delete restrict,
  validation_version integer not null check (validation_version > 0),
  validated_payload jsonb not null check (jsonb_typeof(validated_payload) = 'object'),
  corrections jsonb not null default '[]'::jsonb check (jsonb_typeof(corrections) = 'array'),
  reason text not null check (length(btrim(reason)) between 8 and 500),
  validated_by uuid not null references auth.accounts(id) on delete restrict,
  validated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (job_id, facility_id) references ocr.jobs(id, facility_id) on delete restrict,
  foreign key (validated_by_membership_id, facility_id, validated_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (job_id, validation_version)
);

create table ocr.outbox_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type ~ '^Ocr[A-Za-z]+$'),
  event_version integer not null default 1 check (event_version = 1),
  aggregate_id uuid not null references ocr.jobs(id) on delete restrict,
  aggregate_version bigint not null check (aggregate_version > 0),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  unique (aggregate_id, event_type, aggregate_version)
);
create index ocr_outbox_pending_idx on ocr.outbox_events (next_attempt_at, occurred_at, id) where published_at is null;

create or replace function ocr.reject_immutable_change()
returns trigger language plpgsql set search_path = ocr, pg_temp as $$
begin
  raise exception using errcode = '55000', message = 'OCR evidence is append-only';
end
$$;
create trigger ocr_job_events_immutable before update or delete on ocr.job_events
  for each row execute function ocr.reject_immutable_change();
create trigger ocr_extractions_immutable before update or delete on ocr.extractions
  for each row execute function ocr.reject_immutable_change();
create trigger ocr_validations_immutable before update or delete on ocr.validations
  for each row execute function ocr.reject_immutable_change();

create or replace function ocr.validate_job_write()
returns trigger language plpgsql security definer
set search_path = ocr, ehr, identity, auth, platform, pg_temp as $$
declare
  document_row record;
  latest_scan record;
begin
  select document.id, document.patient_id, document.facility_id, document.object_version_id,
         document.sha256_hex, document.status
    into document_row from ehr.documents document where document.id = new.document_id;
  select scan.event_type, scan.object_version_id, scan.object_sha256_hex,
         scan.binding_migration_hold_reason
    into latest_scan from ehr.document_scan_events scan
   where scan.document_id = new.document_id
   order by scan.created_at desc, scan.id desc limit 1;
  if document_row.id is null
     or document_row.facility_id <> new.facility_id
     or document_row.object_version_id <> new.source_object_version_id
     or document_row.sha256_hex <> new.source_sha256_hex
     or document_row.status <> 'uploaded'
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
       or new.source_sha256_hex <> old.source_sha256_hex
       or new.operation <> old.operation or new.idempotency_key <> old.idempotency_key
       or new.request_sha256 <> old.request_sha256 or new.provider <> old.provider
       or new.created_by <> old.created_by
       or new.created_by_membership_id <> old.created_by_membership_id
       or new.row_version <> old.row_version + 1 then
      raise exception using errcode = '55000', message = 'OCR job identity is immutable and updates require the next version';
    end if;
    if not (
      (old.status = 'queued' and new.status in ('processing', 'cancelled'))
      or (old.status = 'processing' and new.status in ('extracted', 'failed'))
      or (old.status = 'extracted' and new.status = 'awaiting_validation')
      or (old.status = 'awaiting_validation' and new.status = 'validated')
      or (old.status = 'failed' and new.status in ('queued', 'cancelled'))
    ) then
      raise exception using errcode = '23514', message = 'Invalid OCR job state transition';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end
$$;
create trigger ocr_jobs_validate before insert or update on ocr.jobs
  for each row execute function ocr.validate_job_write();

create or replace function ocr.record_job_event()
returns trigger language plpgsql security definer
set search_path = ocr, platform, pg_temp as $$
declare event_name text;
begin
  event_name := case new.status
    when 'queued' then 'OcrJobQueued'
    when 'processing' then 'OcrProcessingStarted'
    when 'extracted' then 'OcrExtractionCreated'
    when 'awaiting_validation' then 'OcrAwaitingValidation'
    when 'validated' then 'OcrValidated'
    when 'failed' then 'OcrFailed'
    else 'OcrJobCancelled' end;
  insert into ocr.job_events (
    job_id, facility_id, from_status, to_status, job_version,
    actor_subject, correlation_id, reason_code
  ) values (
    new.id, new.facility_id, case when tg_op = 'UPDATE' then old.status end,
    new.status, new.row_version, platform.current_actor_subject(), new.correlation_id,
    new.last_error_code
  );
  insert into ocr.outbox_events (
    event_type, aggregate_id, aggregate_version, facility_id, correlation_id, payload
  ) values (
    event_name, new.id, new.row_version, new.facility_id, new.correlation_id,
    jsonb_build_object('jobId', new.id, 'documentId', new.document_id,
      'status', new.status, 'patientResolved', new.patient_id is not null)
  );
  return new;
end
$$;
create trigger ocr_jobs_event after insert or update of status on ocr.jobs
  for each row execute function ocr.record_job_event();

create or replace function ocr.validate_extraction_insert()
returns trigger language plpgsql security definer set search_path = ocr, pg_temp as $$
declare job_row ocr.jobs%rowtype; expected_version integer;
begin
  select * into job_row from ocr.jobs where id = new.job_id for update;
  if job_row.id is null or job_row.facility_id <> new.facility_id
     or job_row.document_id <> new.document_id
     or job_row.patient_id is distinct from new.patient_id
     or job_row.source_object_version_id <> new.source_object_version_id
     or job_row.source_sha256_hex <> new.source_sha256_hex
     or job_row.status <> 'processing'
     or job_row.attempt_count <> new.attempt_no then
    raise exception using errcode = '23514', message = 'Extraction does not match the active OCR processing attempt';
  end if;
  select coalesce(max(extraction_version), 0) + 1 into expected_version
    from ocr.extractions where job_id = new.job_id;
  if new.extraction_version <> expected_version then
    raise exception using errcode = '23514', message = 'Extraction version is not the next immutable version';
  end if;
  return new;
end
$$;
create trigger ocr_extractions_validate before insert on ocr.extractions
  for each row execute function ocr.validate_extraction_insert();

create or replace function ocr.validate_validation_insert()
returns trigger language plpgsql security definer set search_path = ocr, platform, pg_temp as $$
declare job_row ocr.jobs%rowtype; extraction_job uuid; expected_version integer;
begin
  select * into job_row from ocr.jobs where id = new.job_id for update;
  select job_id into extraction_job from ocr.extractions where id = new.extraction_id;
  if job_row.id is null or job_row.facility_id <> new.facility_id
     or job_row.status <> 'awaiting_validation' or extraction_job <> new.job_id
     or new.validated_by::text <> platform.current_account_id()::text
     or new.validated_by_membership_id::text <> platform.current_membership_id()::text then
    raise exception using errcode = '23514', message = 'Validation does not match the authorized OCR review context';
  end if;
  select coalesce(max(validation_version), 0) + 1 into expected_version
    from ocr.validations where job_id = new.job_id;
  if new.validation_version <> expected_version then
    raise exception using errcode = '23514', message = 'Validation version is not the next immutable version';
  end if;
  return new;
end
$$;
create trigger ocr_validations_validate before insert on ocr.validations
  for each row execute function ocr.validate_validation_insert();

create or replace function ocr.claim_next_job(requested_provider text)
returns setof ocr.jobs language plpgsql security definer
set search_path = ocr, auth, platform, pg_temp as $$
declare claimed ocr.jobs%rowtype;
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  select * into claimed from ocr.jobs
   where status = 'queued' and provider = requested_provider
     and next_attempt_at <= clock_timestamp() and attempt_count < max_attempts
   order by next_attempt_at, queued_at, id
   for update skip locked limit 1;
  if claimed.id is null then return; end if;
  update ocr.jobs set status = 'processing', attempt_count = attempt_count + 1,
         started_at = clock_timestamp(), completed_at = null, failed_at = null,
         last_error_code = null, last_error_summary = null,
         row_version = row_version + 1
   where id = claimed.id returning * into claimed;
  return next claimed;
end
$$;

create or replace function ocr.record_extraction(
  requested_job_id uuid,
  requested_provider_result_key text,
  requested_content_sha256 text,
  requested_provider_model text,
  requested_provider_request_reference text,
  requested_raw_text text,
  requested_structured_payload jsonb,
  requested_confidence numeric,
  requested_provenance jsonb,
  requested_correlation_id text
)
returns uuid language plpgsql security definer
set search_path = ocr, auth, platform, pg_temp as $$
declare
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
  job_row ocr.jobs%rowtype;
  existing ocr.extractions%rowtype;
  extraction_id uuid := gen_random_uuid();
  next_version integer;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_content_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(requested_structured_payload) <> 'object'
     or jsonb_typeof(requested_provenance) <> 'object'
     or requested_confidence not between 0 and 1 then
    raise exception using errcode = '22023', message = 'Invalid OCR extraction result';
  end if;
  select * into job_row from ocr.jobs where id = requested_job_id for update;
  select * into existing from ocr.extractions
   where job_id = requested_job_id and provider_result_key = requested_provider_result_key;
  if existing.id is not null then
    if existing.content_sha256 <> requested_content_sha256 then
      raise exception using errcode = '23505', message = 'OCR provider result key payload mismatch';
    end if;
    return existing.id;
  end if;
  if job_row.id is null or job_row.status <> 'processing' then
    raise exception using errcode = '55000', message = 'OCR job is not processing';
  end if;
  select coalesce(max(extraction_version), 0) + 1 into next_version
    from ocr.extractions where job_id = requested_job_id;
  insert into ocr.extractions (
    id, job_id, facility_id, document_id, patient_id, extraction_version,
    attempt_no, provider, provider_model, provider_request_reference,
    provider_result_key, content_sha256, source_object_version_id,
    source_sha256_hex, raw_text, structured_payload, confidence, provenance
  ) values (
    extraction_id, job_row.id, job_row.facility_id, job_row.document_id,
    job_row.patient_id, next_version, job_row.attempt_count, job_row.provider,
    requested_provider_model, requested_provider_request_reference,
    requested_provider_result_key, requested_content_sha256,
    job_row.source_object_version_id, job_row.source_sha256_hex,
    requested_raw_text, requested_structured_payload, requested_confidence,
    requested_provenance
  );
  update ocr.jobs set status = 'extracted', completed_at = clock_timestamp(),
         correlation_id = requested_correlation_id, row_version = row_version + 1
   where id = job_row.id;
  update ocr.jobs set status = 'awaiting_validation',
         correlation_id = requested_correlation_id, row_version = row_version + 1
   where id = job_row.id;
  return extraction_id;
end
$$;

create or replace function ocr.fail_job(
  requested_job_id uuid,
  requested_error_code text,
  requested_error_summary text,
  requested_retryable boolean,
  requested_retry_delay_seconds integer,
  requested_correlation_id text
)
returns void language plpgsql security definer
set search_path = ocr, auth, platform, pg_temp as $$
declare actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
  job_row ocr.jobs%rowtype;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_error_code !~ '^[A-Z0-9_]{2,80}$'
     or length(coalesce(requested_error_summary, '')) > 240
     or requested_retry_delay_seconds not between 0 and 86400 then
    raise exception using errcode = '22023', message = 'Invalid safe OCR failure metadata';
  end if;
  select * into job_row from ocr.jobs where id = requested_job_id for update;
  if job_row.id is null or job_row.status <> 'processing' then
    raise exception using errcode = '55000', message = 'OCR job is not processing';
  end if;
  update ocr.jobs set status = 'failed', failed_at = clock_timestamp(),
         completed_at = null, last_error_code = requested_error_code,
         last_error_summary = requested_error_summary,
         next_attempt_at = case when requested_retryable and attempt_count < max_attempts
           then clock_timestamp() + make_interval(secs => requested_retry_delay_seconds)
           else clock_timestamp() end,
         correlation_id = requested_correlation_id, row_version = row_version + 1
   where id = requested_job_id;
end
$$;

alter table ocr.jobs enable row level security; alter table ocr.jobs force row level security;
alter table ocr.job_events enable row level security; alter table ocr.job_events force row level security;
alter table ocr.extractions enable row level security; alter table ocr.extractions force row level security;
alter table ocr.validations enable row level security; alter table ocr.validations force row level security;
alter table ocr.outbox_events enable row level security; alter table ocr.outbox_events force row level security;

create policy ocr_jobs_staff on ocr.jobs for all
  using (facility_id = platform.current_facility_id())
  with check (facility_id = platform.current_facility_id());
create policy ocr_job_events_staff_read on ocr.job_events for select
  using (facility_id = platform.current_facility_id());
create policy ocr_extractions_staff_read on ocr.extractions for select
  using (facility_id = platform.current_facility_id());
create policy ocr_extractions_staff_insert on ocr.extractions for insert
  with check (facility_id = platform.current_facility_id());
create policy ocr_validations_staff on ocr.validations for select
  using (facility_id = platform.current_facility_id());
create policy ocr_validations_staff_insert on ocr.validations for insert
  with check (facility_id = platform.current_facility_id());
create policy ocr_outbox_staff_read on ocr.outbox_events for select
  using (facility_id = platform.current_facility_id());

revoke all on all tables in schema ocr from public;
revoke all on all sequences in schema ocr from public;
revoke all on all functions in schema ocr from public;
revoke all on function ocr.claim_next_job(text) from public;
revoke all on function ocr.record_extraction(uuid, text, text, text, text, text, jsonb, numeric, jsonb, text) from public;
revoke all on function ocr.fail_job(uuid, text, text, boolean, integer, text) from public;

comment on schema ocr is 'Provider-neutral OCR jobs, immutable extraction/validation evidence, and transactional outbox.';
comment on table ocr.extractions is 'Immutable provisional model output; never clinical truth.';
comment on table ocr.validations is 'Append-only human review evidence preserving the source extraction.';
comment on table ocr.outbox_events is 'Minimum-necessary transactional OCR events pending external delivery.';
