\set ON_ERROR_STOP on
-- Completing a document upload as the EHR API (0146 proposal; the fault came
-- with 0112). Rollback-only. Every person, facility, patient and storage key
-- here is made up (Fixture Upload Clinic, Fixture Upload Doctor, Fixture
-- Upload Patient), apart from the sealed QA tenant's own seeded rows
-- (QA Hospital, QA Clinician, QA Patient One), which this suite seeds in its
-- transaction when they are not there.
--
-- Proves, as the exact ehr-api login (hid_ehr_api_runtime) with the session
-- settings DatabaseService.withTransaction sets (app.actor_subject,
-- app.facility_id, app.correlation_id, app.membership_id,
-- app.purpose_of_use, app.own_facility_work) and the statements
-- DocumentService runs:
--   1. the premise: the EHR runtime has no USAGE on schema ocr (by design);
--   2. a doctor at a real facility: the upload intent (INSERT, 'initiated'),
--      the read-only lookup through ehr.documents_effective, and the
--      completion (app.change_reason, then the UPDATE ... RETURNING to
--      'uploaded', then the audit row) all succeed: row_version 2, one
--      ehr.record_versions row with the change reason, the view shows
--      'uploaded'. Before 0146 the UPDATE fails with 42501 "permission
--      denied for schema ocr" in ehr.reject_document_object_rebinding();
--   3. the same for the QA Clinician (doctor) at QA Hospital, the sealed QA
--      tenant, with QA Patient One's seeded share;
--   4. the document guard still holds for the runtime, with 55000 (not
--      42501): moving the completed document to 'source_deleting', or
--      rebinding its object, is refused.
begin;

create function pg_temp.as_ehr_api(subject text, facility uuid, membership uuid, correlation text)
returns void language sql as $$
  select null::void from (select
    set_config('app.actor_subject', subject, true),
    set_config('app.facility_id', facility::text, true),
    set_config('app.correlation_id', correlation, true),
    set_config('app.membership_id', membership::text, true),
    set_config('app.purpose_of_use', 'direct-care', true),
    set_config('app.own_facility_work', '0133', true)) settings
$$;

-- The upload intent, the lookup and the completion, as DocumentService runs
-- them (createUploadIntent, findById, complete), for one staff member.
create function pg_temp.upload_and_complete(label text, subject text, account uuid, membership uuid,
  organization uuid, facility uuid, patient uuid, encounter uuid, document uuid)
returns void language plpgsql as $$
declare
  completed record;
  looked record;
  failure text;
begin
  perform pg_temp.as_ehr_api(subject, facility, membership, 'doc-complete-' || left(document::text, 8) || '-intent');
  insert into ehr.documents (
    id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    original_file_name, storage_bucket, storage_key, declared_media_type,
    size_bytes, sha256_hex, classification, status, retention_class
  ) values (document, encounter, patient, facility, account, membership, 'Fixture scan.pdf',
    'synthetic-bucket', 'clinical/objects/' || document::text, 'application/pdf', 2048, repeat('b', 64),
    'phi', 'initiated', 'clinical_record');
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, resource_type, resource_id, outcome, purpose_of_use,
    details, provenance, source_system)
  values (current_setting('app.correlation_id'), 'staff', subject, account, membership, organization, facility,
    patient, 'ehr.document.upload-intent.create', 'document', document::text, 'success', 'direct-care', '{}',
    'application', 'ehr-api');

  perform pg_temp.as_ehr_api(subject, facility, membership, 'doc-complete-' || left(document::text, 8) || '-lookup');
  select id, status, row_version into looked
    from ehr.documents_effective where id = document and facility_id = facility;
  if looked.id is null or looked.status <> 'initiated' or looked.row_version <> 1 then
    raise exception '%: the read-only lookup does not see the initiated document', label;
  end if;

  perform pg_temp.as_ehr_api(subject, facility, membership, 'doc-complete-' || left(document::text, 8) || '-finish');
  begin
    perform set_config('app.change_reason', 'verified S3 upload completion', true);
    update ehr.documents
       set object_version_id = 'synthetic-version-1', size_bytes = 2048, sha256_hex = repeat('b', 64),
           status = 'uploaded'
     where id = document and facility_id = facility and status = 'initiated' and created_by = account
    returning id::text, status, row_version into completed;
  exception when others then
    get stacked diagnostics failure = returned_sqlstate;
    raise exception '%: completing the upload as the EHR API failed: % %', label, failure, sqlerrm;
  end;
  if completed.id is null or completed.status <> 'uploaded' or completed.row_version <> 2 then
    raise exception '%: the completion returned no uploaded row (got %)', label, completed;
  end if;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, resource_type, resource_id, outcome, purpose_of_use,
    details, provenance, source_system)
  values (current_setting('app.correlation_id'), 'staff', subject, account, membership, organization, facility,
    patient, 'ehr.document.upload.complete', 'document', document::text, 'success', 'direct-care', '{}',
    'application', 'ehr-api');
  if (select status from ehr.documents_effective where id = document) <> 'uploaded'
     or (select count(*) from ehr.record_versions
          where resource_type = 'documents' and resource_id = document::text and version_no = 2
            and change_reason = 'verified S3 upload completion' and changed_by = account) <> 1 then
    raise exception '%: the completed document or its version row is not as expected', label;
  end if;

  -- 4. The guard still refuses, with its own 55000, for this runtime.
  begin
    perform set_config('app.change_reason', 'fixture source claim attempt', true);
    update ehr.documents set status = 'source_deleting' where id = document;
    raise exception '%: the EHR runtime moved a document to source_deleting', label;
  exception when sqlstate '55000' then null;
  end;
  begin
    update ehr.documents set storage_key = storage_key || '-rebound' where id = document;
    raise exception '%: the EHR runtime rebound a document object', label;
  exception when sqlstate '55000' then null;
  end;
  raise notice '%: upload intent, lookup and completion succeeded', label;
end
$$;

-- 1. The premise.
do $$
begin
  if has_schema_privilege('hid_ehr_runtime', 'ocr', 'USAGE')
     or has_schema_privilege('hid_ehr_api_runtime', 'ocr', 'USAGE') then
    raise exception 'premise: the EHR runtime has USAGE on schema ocr, so this suite proves nothing';
  end if;
  if not pg_has_role('hid_ehr_api_runtime', 'hid_ehr_runtime', 'USAGE')
     or not pg_has_role('hid_ehr_api_runtime', 'hid_audit_writer', 'USAGE') then
    raise exception 'premise: hid_ehr_api_runtime is not the EHR runtime and audit writer login';
  end if;
end
$$;

-- 2. Fixtures for a real facility: a doctor with a direct-care write grant.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('9dc10000-0000-4000-8000-000000000001', 'staff:doc-complete-doctor', 'doc-complete-doctor@example.invalid',
   'Fixture Upload Doctor', 'active'),
  ('9dc10000-0000-4000-8000-000000000002', 'synthetic:doc-complete:patient', 'doc-complete-patient@example.invalid',
   'Fixture Upload Patient', 'active');
insert into identity.organizations (id, name, slug) values
  ('9dc30000-0000-4000-8000-000000000001', 'Fixture Upload Organization', 'fixture-upload-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('9dc30000-0000-4000-8000-000000000002', '9dc30000-0000-4000-8000-000000000001', 'Fixture Upload Clinic',
   'DOC-UP-1', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('9dc40000-0000-4000-8000-000000000001', '9dc10000-0000-4000-8000-000000000001', 'Fixture Upload Doctor',
   'doc-complete-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('9dc50000-0000-4000-8000-000000000001', '9dc40000-0000-4000-8000-000000000001',
   '9dc10000-0000-4000-8000-000000000001', '9dc30000-0000-4000-8000-000000000001',
   '9dc30000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('9dc60000-0000-4000-8000-000000000001', '9dc10000-0000-4000-8000-000000000001', 'doctor', 'facility',
   '9dc50000-0000-4000-8000-000000000001', '9dc30000-0000-4000-8000-000000000002', 'Fixture role assignment');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('9dc70000-0000-4000-8000-000000000001', '9dc10000-0000-4000-8000-000000000002', 'HID-DCKPXMNR',
   'Fixture', 'Upload Patient', 'Fixture Upload Patient', 'active');
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'doc-complete-fixture') on conflict (code) do nothing;
insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
  reason, status, requested_duration_minutes, approved_by_patient_id, approved_at) values
  ('9dc80000-0000-4000-8000-000000000001', '9dc70000-0000-4000-8000-000000000001',
   '9dc40000-0000-4000-8000-000000000001', '9dc50000-0000-4000-8000-000000000001',
   '9dc30000-0000-4000-8000-000000000002', 'write_records', 'direct-care', 'Fixture upload access request',
   'approved', 60, '9dc70000-0000-4000-8000-000000000001', clock_timestamp());
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass) values
  ('9dc90000-0000-4000-8000-000000000001', '9dc80000-0000-4000-8000-000000000001',
   '9dc70000-0000-4000-8000-000000000001', '9dc40000-0000-4000-8000-000000000001',
   '9dc10000-0000-4000-8000-000000000001', '9dc50000-0000-4000-8000-000000000001',
   '9dc30000-0000-4000-8000-000000000002', 'write_records', 'direct-care', 'active', 'Fixture upload consent',
   clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', false);

-- 3. The sealed QA tenant (0123's seed, as the sealed-qa-tenant suite seeds
-- it) when it is not there; its logins are seeded pending_reset, and the
-- owner's password reset makes them active, as here.
do $$
begin
  if not exists (select 1 from auth.accounts where id = 'c0a00003-0000-4000-8000-000000000001') then
    perform identity.sealed_qa_install();
    -- Seeded in this transaction, the share starts at clock_timestamp(),
    -- after the transaction's current_timestamp, the time the consent check
    -- reads; start it at the transaction's start (production's seed is
    -- long committed).
    update identity.consent_grants set starts_at = current_timestamp
     where patient_id = 'c0a00009-0000-4000-8000-000000000001'
       and membership_id = 'c0a00005-0000-4000-8000-000000000011' and starts_at > current_timestamp;
  end if;
  update auth.accounts set status = 'active'
   where id = 'c0a00003-0000-4000-8000-000000000001' and status = 'pending_reset';
  if not identity.sealed_qa_facility('c0a00002-0000-4000-8000-000000000001')
     or not exists (select 1 from identity.consent_grants
                     where patient_id = 'c0a00009-0000-4000-8000-000000000001'
                       and membership_id = 'c0a00005-0000-4000-8000-000000000011' and status = 'active'
                       and scope = 'write_records' and expires_at > clock_timestamp()) then
    raise exception 'premise: QA Hospital or QA Patient One''s share with the QA Clinician is missing';
  end if;
end
$$;

-- The consultations the documents are uploaded on, written as the EHR API.
set local role hid_ehr_api_runtime;
select pg_temp.as_ehr_api('staff:doc-complete-doctor', '9dc30000-0000-4000-8000-000000000002',
  '9dc50000-0000-4000-8000-000000000001', 'doc-complete-encounter-real');
select set_config('app.change_reason', 'fixture consultation', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at)
values ('9dca0000-0000-4000-8000-000000000001', '9dc70000-0000-4000-8000-000000000001',
  '9dc30000-0000-4000-8000-000000000002', '9dc10000-0000-4000-8000-000000000001',
  '9dc50000-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
select pg_temp.as_ehr_api('sealed-qa:c0a00003-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001',
  'c0a00005-0000-4000-8000-000000000011', 'doc-complete-encounter-qa');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at)
values ('9dca0000-0000-4000-8000-000000000002', 'c0a00009-0000-4000-8000-000000000001',
  'c0a00002-0000-4000-8000-000000000001', 'c0a00003-0000-4000-8000-000000000001',
  'c0a00005-0000-4000-8000-000000000011', 'ambulatory', 'in_progress', clock_timestamp());

-- 2. A doctor at a real facility.
select pg_temp.upload_and_complete('real facility doctor', 'staff:doc-complete-doctor',
  '9dc10000-0000-4000-8000-000000000001', '9dc50000-0000-4000-8000-000000000001',
  '9dc30000-0000-4000-8000-000000000001', '9dc30000-0000-4000-8000-000000000002',
  '9dc70000-0000-4000-8000-000000000001', '9dca0000-0000-4000-8000-000000000001',
  '9dcb0000-0000-4000-8000-000000000001');

-- 3. The QA Clinician at QA Hospital.
select pg_temp.upload_and_complete('QA Clinician at QA Hospital', 'sealed-qa:c0a00003-0000-4000-8000-000000000001',
  'c0a00003-0000-4000-8000-000000000001', 'c0a00005-0000-4000-8000-000000000011',
  'c0a00001-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001',
  'c0a00009-0000-4000-8000-000000000001', '9dca0000-0000-4000-8000-000000000002',
  '9dcb0000-0000-4000-8000-000000000002');
reset role;

select 'document-upload-complete: all cases passed' as verdict;
rollback;
