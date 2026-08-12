-- A clean scan authorizes one exact immutable S3 object version and checksum,
-- never a mutable document identifier by itself.

alter table ehr.documents
  add constraint documents_scan_object_binding_uq
    unique (id, object_version_id, sha256_hex);

alter table ehr.document_scan_events
  add column object_version_id text,
  add column object_sha256_hex char(64),
  add column binding_migration_hold_reason text;

-- Historical events predate immutable object binding. Quarantine them instead
-- of inventing provenance or making the migration fail on a populated system.
update ehr.document_scan_events
   set binding_migration_hold_reason = 'legacy scan event lacks immutable object binding'
 where object_version_id is null
   and object_sha256_hex is null;

alter table ehr.document_scan_events
  add constraint document_scan_events_object_version_ck
    check (object_version_id is null or length(object_version_id) between 1 and 1024),
  add constraint document_scan_events_object_sha256_ck
    check (object_sha256_hex is null or object_sha256_hex ~ '^[0-9a-f]{64}$'),
  add constraint document_scan_events_binding_state_ck
    check (
      (object_version_id is not null
        and object_sha256_hex is not null
        and binding_migration_hold_reason is null)
      or
      (object_version_id is null
        and object_sha256_hex is null
        and length(btrim(binding_migration_hold_reason)) between 1 and 500)
    ),
  add constraint document_scan_events_exact_object_fk
    foreign key (document_id, object_version_id, object_sha256_hex)
    references ehr.documents(id, object_version_id, sha256_hex)
    on delete restrict;

create or replace function ehr.reject_document_object_rebinding()
returns trigger
language plpgsql
set search_path = ehr, pg_temp
as $$
begin
  if old.storage_bucket is distinct from new.storage_bucket
     or old.storage_key is distinct from new.storage_key
     or old.declared_media_type is distinct from new.declared_media_type
     or old.size_bytes is distinct from new.size_bytes
     or old.sha256_hex is distinct from new.sha256_hex
     or (old.object_version_id is not null
       and old.object_version_id is distinct from new.object_version_id) then
    raise exception using errcode = '55000', message = 'Document object identity and declared integrity metadata are immutable';
  end if;
  return new;
end;
$$;

create trigger documents_reject_object_rebinding
  before update on ehr.documents
  for each row execute function ehr.reject_document_object_rebinding();

drop function ehr.append_document_scan_event(uuid, text, text, text, text, text, text, text);

create or replace function ehr.append_document_scan_event(
  requested_document_id uuid,
  requested_object_version_id text,
  requested_object_sha256_hex text,
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
  if length(coalesce(requested_object_version_id, '')) not between 1 and 1024
     or coalesce(requested_object_sha256_hex, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Exact scanned object version and SHA-256 are required';
  end if;
  if length(coalesce(requested_idempotency_key, '')) not between 16 and 128
     or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' then
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
  if requested_event_type in ('rejected', 'failed')
     and nullif(btrim(requested_reason_code), '') is null then
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
  if document_row.object_version_id is distinct from requested_object_version_id
     or document_row.sha256_hex is distinct from requested_object_sha256_hex then
    raise exception using errcode = '55000', message = 'Scan result does not match the current immutable document object';
  end if;

  select * into existing_event
  from ehr.document_scan_events
  where document_id = requested_document_id
    and idempotency_key = requested_idempotency_key;
  if found then
    if existing_event.object_version_id = requested_object_version_id
       and existing_event.object_sha256_hex = requested_object_sha256_hex
       and existing_event.event_type = requested_event_type
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
        jsonb_build_object(
          'original_event_id', existing_event.id,
          'event_type', existing_event.event_type,
          'object_version_id', existing_event.object_version_id
        )
      );
      return existing_event.id;
    end if;
    raise exception using errcode = '23505', message = 'Scanner idempotency key payload mismatch';
  end if;

  select event_type into latest_terminal
  from ehr.document_scan_events
  where document_id = requested_document_id
    and object_version_id = requested_object_version_id
    and object_sha256_hex = requested_object_sha256_hex
    and event_type in ('clean', 'rejected')
  order by created_at desc, id desc
  limit 1;
  if latest_terminal is not null then
    raise exception using errcode = '55000', message = 'Document object scan has already reached a terminal result';
  end if;

  insert into ehr.document_scan_events (
    id, document_id, patient_id, facility_id, created_by,
    object_version_id, object_sha256_hex, event_type,
    detected_media_type, scanner_engine, scanner_version, reason_code,
    idempotency_key, correlation_id
  ) values (
    new_event_id, document_row.id, document_row.patient_id, document_row.facility_id,
    actor_account, requested_object_version_id, requested_object_sha256_hex,
    requested_event_type, requested_detected_media_type,
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
    jsonb_build_object(
      'scanner_engine', requested_scanner_engine,
      'scanner_version', requested_scanner_version,
      'object_version_id', requested_object_version_id
    )
  );

  return new_event_id;
end;
$$;

revoke all on function ehr.append_document_scan_event(
  uuid, text, text, text, text, text, text, text, text, text
) from public;

create or replace view ehr.documents_effective
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
    and scan.object_version_id = document_row.object_version_id
    and scan.object_sha256_hex = document_row.sha256_hex
  order by scan.created_at desc, scan.id desc
  limit 1
) latest_scan on true;

comment on column ehr.document_scan_events.object_version_id is
  'Exact immutable object-store version inspected by this scanner event.';
comment on column ehr.document_scan_events.object_sha256_hex is
  'Exact SHA-256 inspected by this scanner event; part of the FK-bound object identity.';
comment on column ehr.document_scan_events.binding_migration_hold_reason is
  'Non-null only for quarantined historical scan events that cannot safely prove an immutable object binding; such events never make a document available.';
