-- Database-level facility and consent isolation.
-- RLS is defense in depth; the API must still authenticate, authorize, set all
-- four transaction-local app.* settings, and use parameterized statements.

create or replace function auth.account_has_active_role(account uuid, requested_role text)
returns boolean
language sql
stable
security definer
set search_path = auth, pg_temp
as $$
  select exists (
    select 1
    from auth.account_roles assignment
    join auth.roles role_row on role_row.code = assignment.role_code
    where assignment.account_id = account
      and assignment.role_code = requested_role
      and assignment.scope_type = 'platform'
      and assignment.revoked_at is null
      and role_row.active
  )
$$;

create or replace function ehr.context_allows(
  row_patient_id uuid,
  row_facility_id uuid,
  requested_action text
)
returns boolean
language sql
stable
security definer
set search_path = ehr, identity, platform, pg_temp
as $$
  select
    row_facility_id = platform.current_facility_id()
    and identity.has_active_consent_grant(
      row_patient_id,
      platform.current_actor_subject(),
      platform.current_membership_id(),
      row_facility_id,
      requested_action,
      platform.current_purpose_of_use()
    )
$$;

create or replace function ehr.validate_append_only_clinical_actor()
returns trigger
language plpgsql
security definer
set search_path = ehr, auth, identity, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  membership_id uuid := platform.current_membership_id();
  row_json jsonb := to_jsonb(new);
  row_facility uuid := (row_json->>'facility_id')::uuid;
  row_creator uuid := (row_json->>'created_by')::uuid;
  row_membership uuid := (row_json->>'created_by_membership_id')::uuid;
begin
  if actor_account_id is null
     or platform.current_correlation_id() is null
     or membership_id is null
     or row_creator <> actor_account_id
     or row_membership <> membership_id
     or row_facility <> platform.current_facility_id()
     or not identity.has_active_membership(actor_subject, membership_id, row_facility) then
    raise exception using errcode = '42501', message = 'Verified clinical attribution context is required';
  end if;
  return new;
end;
$$;

create trigger clinical_note_revisions_validate_actor
  before insert on ehr.clinical_note_revisions
  for each row execute function ehr.validate_append_only_clinical_actor();
create trigger vital_corrections_validate_actor
  before insert on ehr.vital_corrections
  for each row execute function ehr.validate_append_only_clinical_actor();

create or replace function ehr.validate_document_scan_actor()
returns trigger
language plpgsql
security definer
set search_path = ehr, auth, platform, pg_temp
as $$
declare
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
begin
  if actor_account is null
     or actor_account <> new.created_by
     or platform.current_correlation_id() is null
     or new.correlation_id <> platform.current_correlation_id()
     or not auth.account_has_active_role(actor_account, 'document_scanner') then
    raise exception using errcode = '42501', message = 'Authorized document scanner context is required';
  end if;
  return new;
end;
$$;

create trigger document_scan_events_validate_actor
  before insert on ehr.document_scan_events
  for each row execute function ehr.validate_document_scan_actor();

create or replace function ehr.append_document_scan_event(
  requested_document_id uuid,
  requested_event_type text,
  requested_detected_media_type text,
  requested_scanner_engine text,
  requested_scanner_version text,
  requested_reason_code text,
  requested_idempotency_key text,
  requested_correlation_id text
)
returns uuid
language plpgsql
security definer
set search_path = ehr, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  document_row ehr.documents%rowtype;
  existing_event ehr.document_scan_events%rowtype;
  latest_terminal text;
  new_event_id uuid := gen_random_uuid();
begin
  if actor_account is null
     or not auth.account_has_active_role(actor_account, 'document_scanner')
     or requested_correlation_id is null
     or requested_correlation_id <> platform.current_correlation_id() then
    raise exception using errcode = '42501', message = 'Authorized document scanner context is required';
  end if;
  if requested_event_type not in ('scan_started', 'clean', 'rejected', 'failed') then
    raise exception using errcode = '22023', message = 'Invalid document scan event type';
  end if;
  if length(coalesce(requested_idempotency_key, '')) not between 16 and 128 then
    raise exception using errcode = '22023', message = 'Invalid scanner idempotency key';
  end if;
  if requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' then
    raise exception using errcode = '22023', message = 'Invalid scanner idempotency key';
  end if;
  if length(coalesce(btrim(requested_scanner_engine), '')) not between 1 and 120
     or length(coalesce(btrim(requested_scanner_version), '')) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'Invalid scanner provenance';
  end if;
  if requested_event_type = 'clean'
     and coalesce(requested_detected_media_type, '') not in (
       'application/pdf', 'image/jpeg', 'image/png', 'image/tiff'
     ) then
    raise exception using errcode = '22023', message = 'A supported detected media type is required for a clean scan';
  end if;
  if requested_event_type in ('rejected', 'failed') and nullif(btrim(requested_reason_code), '') is null then
    raise exception using errcode = '22023', message = 'A reason code is required for unsuccessful scans';
  end if;
  if requested_reason_code is not null
     and (length(requested_reason_code) > 120
       or requested_reason_code !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$') then
    raise exception using errcode = '22023', message = 'Invalid scanner reason code';
  end if;

  select * into document_row
  from ehr.documents
  where id = requested_document_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Document not found';
  end if;
  if document_row.status <> 'uploaded' then
    raise exception using errcode = '55000', message = 'Only an uploaded document can be scanned';
  end if;

  select * into existing_event
  from ehr.document_scan_events
  where document_id = requested_document_id and idempotency_key = requested_idempotency_key;
  if found then
    if existing_event.event_type = requested_event_type
       and existing_event.detected_media_type is not distinct from requested_detected_media_type
       and existing_event.scanner_engine = requested_scanner_engine
       and existing_event.scanner_version = requested_scanner_version
       and existing_event.reason_code is not distinct from requested_reason_code then
      insert into audit.events (
        correlation_id, actor_type, actor_subject, actor_account_id,
        facility_id, patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, provenance, source_system, details
      ) values (
        requested_correlation_id, 'workload', actor_subject, actor_account,
        document_row.facility_id, document_row.patient_id,
        'ehr.document.scan.idempotent-replay', 'success',
        'document', document_row.id::text, 'operations-security',
        'application', 'ehr-document-scanner',
        jsonb_build_object('original_event_id', existing_event.id, 'event_type', existing_event.event_type)
      );
      return existing_event.id;
    end if;
    raise exception using errcode = '23505', message = 'Scanner idempotency key payload mismatch';
  end if;

  select event_type into latest_terminal
  from ehr.document_scan_events
  where document_id = requested_document_id and event_type in ('clean', 'rejected')
  order by created_at desc, id desc
  limit 1;
  if latest_terminal is not null then
    raise exception using errcode = '55000', message = 'Document scan has already reached a terminal result';
  end if;

  insert into ehr.document_scan_events (
    id, document_id, patient_id, facility_id, created_by, event_type,
    detected_media_type, scanner_engine, scanner_version, reason_code,
    idempotency_key, correlation_id
  ) values (
    new_event_id, document_row.id, document_row.patient_id, document_row.facility_id,
    actor_account, requested_event_type, requested_detected_media_type,
    requested_scanner_engine, requested_scanner_version, requested_reason_code,
    requested_idempotency_key, requested_correlation_id
  );

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    requested_correlation_id, 'workload', actor_subject, actor_account,
    document_row.facility_id, document_row.patient_id,
    'ehr.document.scan.' || requested_event_type,
    case when requested_event_type in ('rejected', 'failed') then 'failure' else 'success' end,
    'document', document_row.id::text, 'operations-security', requested_reason_code,
    'application', 'ehr-document-scanner',
    jsonb_build_object('scanner_engine', requested_scanner_engine, 'scanner_version', requested_scanner_version)
  );

  return new_event_id;
end;
$$;

revoke all on function ehr.append_document_scan_event(uuid, text, text, text, text, text, text, text) from public;

alter table identity.patients enable row level security;
alter table identity.patient_identifiers enable row level security;
alter table identity.consent_directives enable row level security;
alter table identity.consent_directive_versions enable row level security;
alter table identity.access_requests enable row level security;
alter table identity.consent_grants enable row level security;

create policy patients_staff_read on identity.patients
  for select
  using (
    account_id = platform.current_account_id()
    or identity.has_active_consent_grant(
      id,
      platform.current_actor_subject(),
      platform.current_membership_id(),
      platform.current_facility_id(),
      'read_records',
      platform.current_purpose_of_use()
    )
  );

create policy patient_identifiers_staff_read on identity.patient_identifiers
  for select
  using (
    exists (
      select 1
      from identity.patients patient_row
      where patient_row.id = patient_identifiers.patient_id
    )
  );

create policy consent_grants_actor_read on identity.consent_grants
  for select
  using (
    account_id = platform.current_account_id()
    and membership_id = platform.current_membership_id()
    and facility_id = platform.current_facility_id()
  );

create policy access_requests_actor_read on identity.access_requests
  for select
  using (
    membership_id = platform.current_membership_id()
    and facility_id = platform.current_facility_id()
  );

create policy consent_directives_patient_read on identity.consent_directives
  for select
  using (
    exists (
      select 1 from identity.patients patient_row
      where patient_row.id = consent_directives.patient_id
    )
  );

create policy consent_directive_versions_patient_read on identity.consent_directive_versions
  for select
  using (
    exists (
      select 1 from identity.patients patient_row
      where patient_row.id = consent_directive_versions.patient_id
    )
  );

alter table ehr.encounters enable row level security;
alter table ehr.encounters force row level security;
alter table ehr.clinical_notes enable row level security;
alter table ehr.clinical_notes force row level security;
alter table ehr.clinical_note_revisions enable row level security;
alter table ehr.clinical_note_revisions force row level security;
alter table ehr.vitals enable row level security;
alter table ehr.vitals force row level security;
alter table ehr.vital_corrections enable row level security;
alter table ehr.vital_corrections force row level security;
alter table ehr.diagnoses enable row level security;
alter table ehr.diagnoses force row level security;
alter table ehr.prescriptions enable row level security;
alter table ehr.prescriptions force row level security;
alter table ehr.lab_requests enable row level security;
alter table ehr.lab_requests force row level security;
alter table ehr.documents enable row level security;
alter table ehr.documents force row level security;
alter table ehr.document_scan_events enable row level security;
alter table ehr.document_scan_events force row level security;
alter table ehr.idempotency_keys enable row level security;
alter table ehr.idempotency_keys force row level security;
alter table ehr.record_versions enable row level security;
alter table ehr.record_versions force row level security;

create policy encounters_read on ehr.encounters for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy encounters_insert on ehr.encounters for insert
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy encounters_update on ehr.encounters for update
  using (ehr.context_allows(patient_id, facility_id, 'write_records'))
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));

create policy clinical_notes_read on ehr.clinical_notes for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy clinical_notes_insert on ehr.clinical_notes for insert
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy clinical_notes_update on ehr.clinical_notes for update
  using (ehr.context_allows(patient_id, facility_id, 'write_records'))
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));

create policy clinical_note_revisions_read on ehr.clinical_note_revisions for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy clinical_note_revisions_insert on ehr.clinical_note_revisions for insert
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));

create policy vitals_read on ehr.vitals for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy vitals_insert on ehr.vitals for insert
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy vitals_update on ehr.vitals for update
  using (ehr.context_allows(patient_id, facility_id, 'write_records'))
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));

create policy vital_corrections_read on ehr.vital_corrections for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy vital_corrections_insert on ehr.vital_corrections for insert
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));

create policy diagnoses_read on ehr.diagnoses for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy diagnoses_insert on ehr.diagnoses for insert
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy diagnoses_update on ehr.diagnoses for update
  using (ehr.context_allows(patient_id, facility_id, 'write_records'))
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));

create policy prescriptions_read on ehr.prescriptions for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy prescriptions_insert on ehr.prescriptions for insert
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy prescriptions_update on ehr.prescriptions for update
  using (ehr.context_allows(patient_id, facility_id, 'write_records'))
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));

create policy lab_requests_read on ehr.lab_requests for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy lab_requests_insert on ehr.lab_requests for insert
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy lab_requests_update on ehr.lab_requests for update
  using (ehr.context_allows(patient_id, facility_id, 'write_records'))
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));

create policy documents_read on ehr.documents for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy documents_insert on ehr.documents for insert
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy documents_update on ehr.documents for update
  using (ehr.context_allows(patient_id, facility_id, 'write_records'))
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy documents_scanner_function_read on ehr.documents for select
  using (auth.account_has_active_role(platform.current_account_id(), 'document_scanner'));

create policy document_scan_events_staff_read on ehr.document_scan_events for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy document_scan_events_workload_insert on ehr.document_scan_events for insert
  with check (
    created_by = platform.current_account_id()
    and correlation_id = platform.current_correlation_id()
    and auth.account_has_active_role(created_by, 'document_scanner')
  );
create policy document_scan_events_scanner_function_read on ehr.document_scan_events for select
  using (auth.account_has_active_role(platform.current_account_id(), 'document_scanner'));

create policy idempotency_keys_owner_all on ehr.idempotency_keys
  for all
  using (
    created_by = platform.current_account_id()
    and created_by_membership_id = platform.current_membership_id()
    and facility_id = platform.current_facility_id()
  )
  with check (
    created_by = platform.current_account_id()
    and created_by_membership_id = platform.current_membership_id()
    and facility_id = platform.current_facility_id()
    and ehr.context_allows(patient_id, facility_id, 'write_records')
  );

create policy record_versions_read on ehr.record_versions for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy record_versions_insert on ehr.record_versions for insert
  with check (
    changed_by = platform.current_account_id()
    and changed_by_membership_id = platform.current_membership_id()
    and correlation_id = platform.current_correlation_id()
    and ehr.context_allows(patient_id, facility_id, 'write_records')
  );

comment on function ehr.context_allows(uuid, uuid, text) is
  'Requires exact transaction facility, exact active membership, and an unexpired non-held consent grant. Custom GUCs are never trusted without relational verification.';
