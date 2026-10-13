-- EHR clinical safety and the launch module set. Applied migrations 0001
-- through 0083 are immutable.
--
-- 1. Launch module set (decision D17, MOD-1). Lab, Pharmacy, OCR and Outreach
--    are off at launch; EHR prescriptions are records only. The seeded roles
--    lose the write permissions of EHR lab ordering, Lab acceptance and
--    accession, and Pharmacy acceptance and dispensing:
--      ehr.lab-request.write       doctor, clinician, lab (0006)
--      lab.work-item.accept        doctor, clinician, nurse, lab (0018)
--      lab.accession.create        lab (0019)
--      pharmacy.work-item.accept   pharmacist (0023)
--      pharmacy.dispensing.create  pharmacist (0023)
--    The rows are deleted for every role, so no role holds them. The routes
--    that need them (lab-request create and update, the EHR's lab-work-item
--    and pharmacy-work-item commands, Lab acceptance and accession, Pharmacy
--    acceptance and dispensing) answer 403 PERMISSION_DENIED before any write
--    or call to another service. Read permissions are kept, so existing
--    orders stay readable. Re-enabling a module takes its own decision, its
--    fixes, a staging acceptance run and a reviewed migration that grants the
--    permissions again. The platform controls outreach_portal_enabled,
--    uploads_enabled and break_glass_enabled are not changed here: every
--    platform.control_events row names the account that made the change
--    (actor_account_id is NOT NULL), and a migration has no such account. An
--    operator sets them false through POST /admin/controls before ingress
--    (release checklist).
--
-- 2. Records follow their encounter (CLIN-EIE). ehr.require_open_encounter()
--    runs before a note, vital, diagnosis, prescription, lab request or
--    encounter-linked document is inserted, and before a prescription or lab
--    request is activated. It reads the encounter with FOR SHARE and refuses
--    with 55000 ENCOUNTER_NOT_OPEN when the encounter is cancelled or entered
--    in error, and when a new order (an insert, or the activation of a draft)
--    is placed on a completed encounter. Late notes, vitals, diagnoses and
--    documents on a completed encounter, and resuming a held order, stay
--    allowed. The share lock serialises a child write with the EHR's
--    retraction of the encounter, which holds FOR UPDATE on it while it marks
--    the encounter's records entered in error or cancelled: the child either
--    commits first and is retracted with the rest, or waits and sees the
--    retracted encounter. The EHR services take the same share lock before
--    they lock an order row, so every path locks the encounter before its
--    records, as the retraction does. An encounter the writer cannot lock
--    (row-level security requires a write consent for the share lock) is
--    refused with 42501.
--
-- 3. ehr.keep_entered_in_error_diagnosis() refuses any update of a diagnosis
--    whose verification status is entered_in_error (55000
--    DIAGNOSIS_ENTERED_IN_ERROR).
--
-- 4. Vital corrections (D8). A correction is a row of ehr.vital_corrections
--    and the current correction number on the vital; nothing updates the
--    recorded values in place. ehr.keep_recorded_vital() refuses an update of
--    a vital that changes any column but current_correction_no (and the
--    row_version and updated_at the version trigger maintains), with 55000
--    VITAL_RECORD_IMMUTABLE.
--
-- 5. Patient release of notes (PREC-NOTES, D7). The patient-self policies of
--    0030 released a signed or amended note, and its current revision,
--    whatever its encounter's status, while the encounter itself was released
--    only once completed. Both policies now require the note's encounter,
--    matched on encounter, patient and facility, to be completed: a note of
--    an open, cancelled or entered-in-error encounter is not released.
--
-- The three guard functions are SECURITY INVOKER with a pinned search_path:
-- they run with the writer's privileges and row-level security, so they add no
-- dependency on the schema owner (release checklist P8). The EHR runtime
-- already holds UPDATE on ehr.encounters, which FOR SHARE needs. Each trigger's
-- name sorts before the table's version trigger, so a refused write records no
-- version. Existing records are not changed: a migration has no actor for the
-- version trigger, and the release checklist lists open records of closed
-- encounters for review.

delete from auth.role_permissions
 where permission_code in ('ehr.lab-request.write', 'lab.work-item.accept', 'lab.accession.create',
                           'pharmacy.work-item.accept', 'pharmacy.dispensing.create');

create function ehr.require_open_encounter()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  is_order boolean := tg_table_name in ('prescriptions', 'lab_requests');
  encounter_status text;
begin
  if tg_op = 'UPDATE' then
    -- Only an order's activation is checked; this trigger fires on UPDATE only
    -- for prescriptions and lab requests.
    if new.status is distinct from 'active' or old.status = 'active' then
      return new;
    end if;
  end if;
  if new.encounter_id is null then
    -- A document need not belong to an encounter.
    return new;
  end if;
  select encounter.status
    into encounter_status
    from ehr.encounters encounter
   where encounter.id = new.encounter_id
     and encounter.patient_id = new.patient_id
     and encounter.facility_id = new.facility_id
     for share;
  if not found then
    raise exception using errcode = '42501', message = 'ENCOUNTER_NOT_AVAILABLE';
  end if;
  if encounter_status in ('cancelled', 'entered_in_error') then
    raise exception using errcode = '55000', message = 'ENCOUNTER_NOT_OPEN',
      detail = 'The encounter is ' || encounter_status;
  end if;
  if is_order and encounter_status = 'completed' then
    if tg_op = 'INSERT' then
      raise exception using errcode = '55000', message = 'ENCOUNTER_NOT_OPEN',
        detail = 'A new order cannot be placed on a completed encounter';
    end if;
    if old.status = 'draft' then
      raise exception using errcode = '55000', message = 'ENCOUNTER_NOT_OPEN',
        detail = 'A draft order cannot be activated on a completed encounter';
    end if;
  end if;
  return new;
end
$$;

create trigger clinical_notes_encounter_open before insert on ehr.clinical_notes
  for each row execute function ehr.require_open_encounter();
create trigger vitals_encounter_open before insert on ehr.vitals
  for each row execute function ehr.require_open_encounter();
create trigger diagnoses_encounter_open before insert on ehr.diagnoses
  for each row execute function ehr.require_open_encounter();
create trigger documents_encounter_open before insert on ehr.documents
  for each row execute function ehr.require_open_encounter();
create trigger prescriptions_encounter_open before insert or update of status on ehr.prescriptions
  for each row execute function ehr.require_open_encounter();
create trigger lab_requests_encounter_open before insert or update of status on ehr.lab_requests
  for each row execute function ehr.require_open_encounter();

create function ehr.keep_entered_in_error_diagnosis()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.verification_status = 'entered_in_error' then
    raise exception using errcode = '55000', message = 'DIAGNOSIS_ENTERED_IN_ERROR';
  end if;
  return new;
end
$$;

create trigger diagnoses_entered_in_error_final before update on ehr.diagnoses
  for each row execute function ehr.keep_entered_in_error_diagnosis();

create function ehr.keep_recorded_vital()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if (to_jsonb(new) - array['current_correction_no', 'row_version', 'updated_at'])
     is distinct from (to_jsonb(old) - array['current_correction_no', 'row_version', 'updated_at']) then
    raise exception using errcode = '55000', message = 'VITAL_RECORD_IMMUTABLE';
  end if;
  return new;
end
$$;

create trigger vitals_recorded_values_immutable before update on ehr.vitals
  for each row execute function ehr.keep_recorded_vital();

revoke all on function ehr.require_open_encounter() from public;
revoke all on function ehr.keep_entered_in_error_diagnosis() from public;
revoke all on function ehr.keep_recorded_vital() from public;

comment on function ehr.require_open_encounter() is
  'Refuses a clinical record on a cancelled or entered-in-error encounter, and a new or activated order on a completed one, under a share lock on the encounter (0084).';
comment on function ehr.keep_entered_in_error_diagnosis() is
  'Refuses any update of a diagnosis entered in error (0084).';
comment on function ehr.keep_recorded_vital() is
  'Refuses an update of a recorded vital other than its current correction number (0084, D8).';

drop policy clinical_notes_patient_self_read on ehr.clinical_notes;
create policy clinical_notes_patient_self_read on ehr.clinical_notes for select
  using (ehr.patient_self_context(patient_id) and status in ('signed', 'amended') and exists (
    select 1 from ehr.encounters encounter
     where encounter.id = clinical_notes.encounter_id
       and encounter.patient_id = clinical_notes.patient_id
       and encounter.facility_id = clinical_notes.facility_id
       and encounter.status = 'completed'
  ));
drop policy note_revisions_patient_self_read on ehr.clinical_note_revisions;
create policy note_revisions_patient_self_read on ehr.clinical_note_revisions for select
  using (ehr.patient_self_context(patient_id) and exists (
    select 1 from ehr.clinical_notes note
      join ehr.encounters encounter
        on encounter.id = note.encounter_id
       and encounter.patient_id = note.patient_id
       and encounter.facility_id = note.facility_id
     where note.id = clinical_note_revisions.clinical_note_id
       and note.patient_id = clinical_note_revisions.patient_id
       and note.facility_id = clinical_note_revisions.facility_id
       and note.current_revision_no = clinical_note_revisions.revision_no
       and note.status in ('signed', 'amended')
       and encounter.status = 'completed'
  ));
