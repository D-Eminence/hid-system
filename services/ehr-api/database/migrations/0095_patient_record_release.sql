-- Patient record release (owner decision 4 of 2026-10-16, D7).
-- Applied migrations 0001 through 0094 are immutable.
--
-- Patients may see their diagnoses, prescriptions, Lab results, vitals and
-- clinical documents as well as their encounters and notes. The EHR service
-- defines the release set (one default-off flag per category,
-- PatientRecordRelease in services/ehr-api), and the database follows it:
-- each policy and the view below admit their category only in a transaction
-- whose transaction-local setting app.patient_release names it exactly
-- (a comma-separated list of vitals, diagnoses, prescriptions, labResults
-- and documents). PatientRecordRelease sets it to the categories whose flag
-- is on, inside the patient-self transaction; DatabaseService starts every
-- patient-self transaction with it empty. A transaction that names no
-- category reads none of these rows, and every EHR build from before this
-- change runs its patient transactions that way, including one from before
-- D-Eminence/hid-system#52, whose patient summary still queried every
-- category: with every flag off, or under an earlier build, the database
-- refuses these categories to the patient as before 0095.
-- The rules (proposed defaults, ADR-064, beyond D7's completed-encounter,
-- no-draft, confirmed-diagnosis and no-entered-in-error rules) are below.
-- Row-level security restricts rows, not columns, as for encounters and notes
-- since 0030: the service's SELECT lists leave out the diagnosis notes, the
-- document's storage location and staff identities.
--
-- 1. Five permissive patient-release SELECT policies, each gated by its
--    category in app.patient_release and, like 0030 and 0084, by
--    ehr.patient_self_context (the 0091 binding), whose EXECUTE stays with
--    hid_ehr_runtime and the test role (PSELF-RLS, unchanged):
--    - ehr.vitals: status 'final' with no correction (current_correction_no
--      0). A corrected vital is withheld while D8 (correction semantics) is
--      open; a vital entered in error is never released.
--    - ehr.diagnoses: verification_status 'confirmed' only. The clinician's
--      free-text notes column is never selected by the service.
--    - ehr.prescriptions: status 'active', 'on_hold' or 'completed'; never a
--      draft, a cancelled or an entered-in-error prescription.
--    - ehr.documents: status 'uploaded', classification 'phi', attached to an
--      encounter. ehr.documents_effective (0009, security_invoker) then shows
--      a document as available only when the latest scan of its exact object
--      version and checksum is clean.
--    - ehr.document_scan_events: every scan event of a document the patient
--      may read, so documents_effective computes the true latest scan; it
--      follows the documents category.
--    Each item's encounter must be completed and match the item on all three
--    keys of the composite foreign key. Retracting a completed encounter
--    (entered_in_error) hides its items at once.
--
-- 2. The view ehr.patient_released_lab_results: the latest released revision
--    of each Lab result of the bound patient whose source EHR order is still
--    active, on hold or completed and whose source encounter is completed,
--    unless that revision was invalidated (entered in error). It returns no
--    correction or release reason and no staff identity. It is not
--    security_invoker: the role bootstrap gives it to the technical owner
--    hid_lab_release_reader, which reads the Lab tables through exact
--    policies (runtime-grants.sql). It admits rows only when
--    app.patient_release names labResults. Functions in a view run as its
--    caller, so the view's own condition, ehr.patient_self_context(patient_id),
--    and the encounters' patient-self policy are evaluated as hid_ehr_runtime; the
--    owner itself cannot evaluate them, has no EXECUTE on
--    ehr.patient_self_context and is never granted to a login. Only
--    hid_ehr_runtime and the test role may select the view. lab-api never
--    receives patient credentials or patient-self context (D17), and
--    hid_lab_runtime gains nothing.
--
-- 3. lab_result_releases_patient_idx on lab.result_releases(patient_id,
--    released_at desc, result_id), the view's access path, and one index per
--    EHR section in the order the section reads it: ehr.vitals (patient_id,
--    recorded_at desc, id desc), ehr.diagnoses and ehr.prescriptions
--    (patient_id, created_at desc, id desc). The section then stops after
--    the rows it shows (101) instead of checking the policies of every row
--    the patient has (about 1.6 ms a row); a patient with thousands of vitals
--    would otherwise pass the EHR pool's 15 s statement timeout. The
--    documents section filters on the computed scan status and reads every
--    document of the patient; a statement timeout answers 503.
--
-- Not included: no policy on ehr.vital_corrections, ehr.lab_requests or
-- ehr.record_versions; lab requests (orders) are never released. No change
-- to the emergency summary, to any staff path or to any Lab permission (Lab
-- stays off at launch, 0091 section 2). The EHR production profile refuses
-- every category's flag (Lab results while Lab is off, D17; the others until
-- the clinical owner signs them off, release checklist P35).
--
-- Locks, in order: CREATE POLICY takes ACCESS EXCLUSIVE briefly on
-- ehr.vitals, ehr.diagnoses, ehr.prescriptions, ehr.documents and
-- ehr.document_scan_events; CREATE VIEW takes ACCESS SHARE on the tables it
-- names; each CREATE INDEX takes SHARE on its table (lab.result_releases,
-- ehr.vitals, ehr.diagnoses, ehr.prescriptions) and scans it, so writes to
-- that table wait until the migration commits (a launch database holds no
-- Lab rows, 0091, and few clinical rows). Every lock is held to the commit.
-- Each waits at most the runner's 5 s lock timeout; a timeout rolls this
-- migration back whole, and it can be run again.

-- 1. Patient-release policies.
create policy vitals_patient_release_read on ehr.vitals for select
  using ('vitals' = any(string_to_array(current_setting('app.patient_release', true), ','))
    and ehr.patient_self_context(patient_id) and status = 'final' and current_correction_no = 0 and exists (
    select 1 from ehr.encounters encounter
     where encounter.id = vitals.encounter_id
       and encounter.patient_id = vitals.patient_id
       and encounter.facility_id = vitals.facility_id
       and encounter.status = 'completed'
  ));

create policy diagnoses_patient_release_read on ehr.diagnoses for select
  using ('diagnoses' = any(string_to_array(current_setting('app.patient_release', true), ','))
    and ehr.patient_self_context(patient_id) and verification_status = 'confirmed' and exists (
    select 1 from ehr.encounters encounter
     where encounter.id = diagnoses.encounter_id
       and encounter.patient_id = diagnoses.patient_id
       and encounter.facility_id = diagnoses.facility_id
       and encounter.status = 'completed'
  ));

create policy prescriptions_patient_release_read on ehr.prescriptions for select
  using ('prescriptions' = any(string_to_array(current_setting('app.patient_release', true), ','))
    and ehr.patient_self_context(patient_id) and status in ('active', 'on_hold', 'completed') and exists (
    select 1 from ehr.encounters encounter
     where encounter.id = prescriptions.encounter_id
       and encounter.patient_id = prescriptions.patient_id
       and encounter.facility_id = prescriptions.facility_id
       and encounter.status = 'completed'
  ));

create policy documents_patient_release_read on ehr.documents for select
  using ('documents' = any(string_to_array(current_setting('app.patient_release', true), ','))
    and ehr.patient_self_context(patient_id) and status = 'uploaded' and classification = 'phi'
    and encounter_id is not null and exists (
    select 1 from ehr.encounters encounter
     where encounter.id = documents.encounter_id
       and encounter.patient_id = documents.patient_id
       and encounter.facility_id = documents.facility_id
       and encounter.status = 'completed'
  ));

create policy document_scan_events_patient_release_read on ehr.document_scan_events for select
  using ('documents' = any(string_to_array(current_setting('app.patient_release', true), ','))
    and ehr.patient_self_context(patient_id) and exists (
    select 1 from ehr.documents document_row
     where document_row.id = document_scan_events.document_id
       and document_row.patient_id = document_scan_events.patient_id
       and document_row.facility_id = document_scan_events.facility_id
  ));

-- 2. The released Lab results of the bound patient.
create view ehr.patient_released_lab_results
with (security_barrier = true)
as
select result_row.id as result_id,
       result_row.patient_id,
       work_item.source_encounter_id as encounter_id,
       work_item.source_ehr_order_id,
       work_item.ordering_facility_id as facility_id,
       requested_test.code_system as test_code_system,
       requested_test.code as test_code,
       requested_test.name as test_name,
       revision.version,
       revision.revision_kind,
       revision.result_type,
       revision.numeric_value,
       revision.text_value,
       revision.unit,
       revision.reference_range,
       revision.abnormal_flag,
       release_row.released_at
  from lab.result_releases release_row
  join lab.results result_row
    on result_row.id = release_row.result_id
   and result_row.patient_id = release_row.patient_id
   and result_row.facility_id = release_row.facility_id
  join lab.result_revisions revision
    on revision.result_id = release_row.result_id
   and revision.version = release_row.result_version
   and revision.patient_id = release_row.patient_id
   and revision.facility_id = release_row.facility_id
  join lab.test_executions execution
    on execution.id = result_row.execution_id
   and execution.patient_id = result_row.patient_id
   and execution.facility_id = result_row.facility_id
  join lab.work_item_requested_tests requested_test
    on requested_test.id = execution.requested_test_id
   and requested_test.patient_id = execution.patient_id
   and requested_test.facility_id = execution.facility_id
  join lab.work_items work_item
    on work_item.id = requested_test.work_item_id
   and work_item.patient_id = requested_test.patient_id
   and work_item.facility_id = requested_test.facility_id
 where 'labResults' = any(string_to_array(current_setting('app.patient_release', true), ','))
   and ehr.patient_self_context(release_row.patient_id)
   and not exists (
     select 1 from lab.result_releases later
      where later.result_id = release_row.result_id
        and later.patient_id = release_row.patient_id
        and later.result_version > release_row.result_version)
   and not exists (
     select 1 from lab.result_invalidations invalidation
      where invalidation.result_id = release_row.result_id
        and invalidation.patient_id = release_row.patient_id
        and invalidation.result_version = release_row.result_version)
   and exists (
     select 1 from ehr.lab_requests source_order
      where source_order.id = work_item.source_ehr_order_id
        and source_order.patient_id = work_item.patient_id
        and source_order.facility_id = work_item.ordering_facility_id
        and source_order.status in ('active', 'on_hold', 'completed'))
   and exists (
     select 1 from ehr.encounters encounter
      where encounter.id = work_item.source_encounter_id
        and encounter.patient_id = work_item.patient_id
        and encounter.facility_id = work_item.ordering_facility_id
        and encounter.status = 'completed');

revoke all on ehr.patient_released_lab_results from public;
comment on view ehr.patient_released_lab_results is
  'Latest released, not invalidated revision of each Lab result of the bound patient-self patient whose source order is open or completed and whose source encounter is completed, in a transaction whose app.patient_release names labResults; no reasons or staff identities (patient record release, ADR-064). Owned by hid_lab_release_reader; selected only by hid_ehr_runtime and the test role.';

-- 3. The view's access path, and each EHR section's.
create index lab_result_releases_patient_idx
  on lab.result_releases (patient_id, released_at desc, result_id);
create index vitals_patient_release_idx on ehr.vitals (patient_id, recorded_at desc, id desc);
create index diagnoses_patient_release_idx on ehr.diagnoses (patient_id, created_at desc, id desc);
create index prescriptions_patient_release_idx on ehr.prescriptions (patient_id, created_at desc, id desc);
