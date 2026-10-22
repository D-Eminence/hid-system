\set ON_ERROR_STOP on
-- OCR outbox inserts (0081, main D-Eminence/hid-system#30, main 0075),
-- through the exact OCR API runtime role. Rollback-only.
begin;

insert into identity.organizations (id, name, slug) values
  ('fa000000-0000-4000-8000-000000000011', 'OCR Outbox Test Organization', 'ocr-outbox-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('fa000000-0000-4000-8000-000000000012', 'fa000000-0000-4000-8000-000000000011', 'OCR Outbox Clinic A',
   'OCR-OUTBOX-A', 'Africa/Lagos', true, 'verified'),
  ('fa000000-0000-4000-8000-000000000013', 'fa000000-0000-4000-8000-000000000011', 'OCR Outbox Clinic B',
   'OCR-OUTBOX-B', 'Africa/Lagos', true, 'verified');

-- Jobs for the events; the fixtures skip the job triggers and the document
-- and membership references (schema.integration.sql covers them).
set local session_replication_role = replica;
insert into ocr.jobs (id, facility_id, document_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, created_by, created_by_membership_id, correlation_id, status)
select ('fa100000-0000-4000-8000-0000000000' || n)::uuid, facility::uuid,
       ('fa200000-0000-4000-8000-0000000000' || n)::uuid, 'synthetic-version-1', repeat('a', 64),
       'ocr-outbox-fixture-00' || n, repeat('b', 64), 'test', 'fa300000-0000-4000-8000-000000000011',
       'fa400000-0000-4000-8000-000000000011', 'ocr-outbox-fixture', 'queued'
  from (values ('11', 'fa000000-0000-4000-8000-000000000012'), ('12', 'fa000000-0000-4000-8000-000000000013'),
               ('13', 'fa000000-0000-4000-8000-000000000012')) job(n, facility);
set local session_replication_role = origin;

-- The insert policy is the only write policy on the table, for the current
-- facility, and only the OCR runtime holds INSERT.
do $$ begin
  if (select string_agg(format('%s:%s:%s', polname, polcmd, pg_get_expr(polwithcheck, polrelid)), '; ')
        from pg_policy where polrelid = 'ocr.outbox_events'::regclass and polcmd <> 'r')
     is distinct from 'ocr_outbox_staff_insert:a:((facility_id = platform.current_facility_id()) AND (EXISTS ( SELECT 1
   FROM ocr.jobs job
  WHERE ((job.id = outbox_events.aggregate_id) AND (job.facility_id = outbox_events.facility_id)))))' then
    raise exception 'ocr.outbox_events write policies differ from the single facility insert policy';
  end if;
  if exists (select 1 from pg_roles where not rolsuper and rolname <> 'hid_ocr_runtime'
               and rolname like 'hid\_%' and not pg_has_role(oid, 'hid_ocr_runtime', 'usage')
               and has_table_privilege(oid, 'ocr.outbox_events', 'INSERT')) then
    raise exception 'a role other than the OCR runtime can insert OCR outbox events';
  end if;
end $$;

-- The OCR API appends outbox events for the current facility, exactly as
-- OcrService.appendOutbox does, and for no other facility.
set local role hid_ocr_api_runtime;
select set_config('app.facility_id', 'fa000000-0000-4000-8000-000000000012', true),
       set_config('app.correlation_id', 'ocr-outbox-policy-check', true);
insert into ocr.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, correlation_id, payload)
values ('OcrPatientConfirmed', 'fa100000-0000-4000-8000-000000000011', 1,
  'fa000000-0000-4000-8000-000000000012', platform.current_correlation_id(),
  '{"jobId":"fa100000-0000-4000-8000-000000000011"}'::jsonb);
do $$ begin
  if not exists (select 1 from ocr.outbox_events
                  where aggregate_id = 'fa100000-0000-4000-8000-000000000011'
                    and event_type = 'OcrPatientConfirmed' and aggregate_version = 1) then
    raise exception 'the OCR API cannot read back its own outbox event';
  end if;
end $$;
-- A second event for the same job version is the duplicate the OCR API answers
-- with 409 OCR_PATIENT_ALREADY_CONFIRMED, by this constraint name.
do $$ begin
  insert into ocr.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, correlation_id, payload)
  values ('OcrPatientConfirmed', 'fa100000-0000-4000-8000-000000000011', 1,
    'fa000000-0000-4000-8000-000000000012', platform.current_correlation_id(),
    '{"jobId":"fa100000-0000-4000-8000-000000000011"}'::jsonb);
  raise exception 'a second outbox event for the same job version was accepted';
exception when unique_violation then
  declare constraint_name text;
  begin
    get stacked diagnostics constraint_name = constraint_name;
    if constraint_name <> 'outbox_events_aggregate_id_event_type_aggregate_version_key' then
      raise exception 'the duplicate outbox event violated % instead', constraint_name;
    end if;
  end;
end $$;
do $$ begin
  insert into ocr.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, correlation_id, payload)
  values ('OcrPatientConfirmed', 'fa100000-0000-4000-8000-000000000012', 1,
    'fa000000-0000-4000-8000-000000000013', platform.current_correlation_id(),
    '{"jobId":"fa100000-0000-4000-8000-000000000012"}'::jsonb);
  raise exception 'the OCR API must not append outbox events for another facility';
exception when insufficient_privilege then null;
end $$;
-- A row for the session's facility that names another facility's job is
-- refused, so it cannot take that job's event key.
do $$ begin
  insert into ocr.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, correlation_id, payload)
  values ('OcrPatientConfirmed', 'fa100000-0000-4000-8000-000000000012', 1,
    'fa000000-0000-4000-8000-000000000012', platform.current_correlation_id(),
    '{"jobId":"fa100000-0000-4000-8000-000000000012"}'::jsonb);
  raise exception 'the OCR API appended an outbox event for another facility''s job';
exception when insufficient_privilege then null;
end $$;
-- Without a facility, no insert passes.
select set_config('app.facility_id', '', true);
do $$ begin
  insert into ocr.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, correlation_id, payload)
  values ('OcrPatientConfirmed', 'fa100000-0000-4000-8000-000000000013', 1,
    'fa000000-0000-4000-8000-000000000012', platform.current_correlation_id(),
    '{"jobId":"fa100000-0000-4000-8000-000000000013"}'::jsonb);
  raise exception 'the OCR API appended an outbox event without a facility';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
