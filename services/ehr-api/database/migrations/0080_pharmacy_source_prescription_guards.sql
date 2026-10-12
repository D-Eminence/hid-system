-- Pharmacy work is bound to its EHR prescription. pharmacy.validate_work_item
-- and pharmacy.validate_dispensing (0023, rewritten fail-closed in 0077)
-- compared a row only with the session and, for a dispensing, with its work
-- item; neither read ehr.prescriptions, and pharmacy.work_items has no foreign
-- key to it. Pharmacy therefore accepted a snapshot of a prescription that was
-- cancelled, superseded or did not exist (the EHR checks eligibility in its own
-- transaction, which commits before it calls Pharmacy), and dispensed a work
-- item whose prescription the prescriber had since cancelled, marked entered
-- in error, put on hold, completed or edited. Each guard now also reads the
-- prescription, with a share lock, and refuses with SQLSTATE 23514 naming its
-- own constraint, which the Pharmacy API answers with 409:
--
--   pharmacy_work_item_source_prescription: an acceptance unless the snapshot
--   is the exact active prescription version (patient, facility, encounter,
--   version, status, medication, dose, route, frequency, instructions and
--   prescriber), as Lab accepts an EHR order (lab.validate_work_item, 0077);
--   pharmacy_dispensing_source_prescription: a dispensing unless the
--   prescription of its work item is still active at the version Pharmacy
--   accepted.
--
-- The acceptance does not compare prescribed_at with created_at, or starts_on
-- and ends_on with the prescription's dates, yet. The migrations run before
-- the EHR API is deployed, and the EHR API may be rolled back; every EHR build
-- before this release sends created_at truncated to the millisecond, and sends
-- the dates as node-postgres local-midnight Dates, which a process east of UTC
-- renders a day early. Exact comparisons would refuse nearly every acceptance
-- such a build sends, so Pharmacy stores those three fields as it did before.
-- The three terms are left to a later migration, once every EHR build that
-- can be deployed or rolled back to sends the exact time and date texts.
--
-- Requiring the accepted version, not only an active status, is the
-- fail-closed default while the lifecycle of accepted work after an EHR
-- change is undecided: a hold then resume, or an edit, makes the work item
-- undispensable. The share lock makes a cancel that commits after the
-- transaction's snapshot fail the SERIALIZABLE dispense or acceptance with
-- 40001, which the Pharmacy API retries; the retry reads the cancel. A cancel
-- in progress is waited for, and an EHR update waits for a dispensing or
-- acceptance in progress. A reversal does not read the prescription, so a
-- dispensing can still be corrected after a cancel. Applied migrations 0001
-- through 0079 are immutable.
--
-- Both functions are replaced with CREATE OR REPLACE, which keeps their owner,
-- ACL and triggers; the signature, SECURITY DEFINER attribute, search_path and
-- volatility are restated exactly as in 0077, and so are the 0077 checks and
-- their message. ehr.prescriptions is schema-qualified instead of added to the
-- search_path. The owner reads it, so no runtime role gains a privilege; under
-- an owner subject to row-level security (release checklist P8) the share lock
-- needs the session member's write consent, which Pharmacy's own insert policy
-- already requires, and a prescription the owner cannot lock reads as missing
-- and is refused.

create or replace function pharmacy.validate_work_item()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
  rx_patient_id uuid;
  rx_facility_id uuid;
  rx_encounter_id uuid;
  rx_version bigint;
  rx_status text;
  rx_medication_code_system text;
  rx_medication_code text;
  rx_medication_display text;
  rx_dose_quantity numeric;
  rx_dose_unit text;
  rx_route_code text;
  rx_frequency text;
  rx_instructions text;
  rx_created_by uuid;
begin
  if session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or new.facility_id is distinct from new.ordering_facility_id
     or new.facility_id is distinct from session_facility_id
     or new.accepted_by is distinct from session_account_id
     or new.accepted_by_membership_id is distinct from session_membership_id
     or new.source_status is distinct from 'active' then
    raise exception using errcode = '23514',
      message = 'Pharmacy acceptance patient, facility, prescription status, or actor context is invalid';
  end if;
  select p.patient_id, p.facility_id, p.encounter_id, p.row_version, p.status, p.medication_code_system,
         p.medication_code, p.medication_display, p.dose_quantity, p.dose_unit, p.route_code, p.frequency,
         p.instructions, p.created_by
    into rx_patient_id, rx_facility_id, rx_encounter_id, rx_version, rx_status, rx_medication_code_system,
         rx_medication_code, rx_medication_display, rx_dose_quantity, rx_dose_unit, rx_route_code, rx_frequency,
         rx_instructions, rx_created_by
    from ehr.prescriptions p
   where p.id = new.source_ehr_prescription_id
     for share;
  if not found
     or rx_patient_id is distinct from new.patient_id
     or rx_facility_id is distinct from new.ordering_facility_id
     or rx_encounter_id is distinct from new.source_encounter_id
     or rx_version is distinct from new.source_ehr_prescription_version
     or rx_status is distinct from 'active'
     or rx_medication_code_system is distinct from new.medication_code_system
     or rx_medication_code is distinct from new.medication_code
     or rx_medication_display is distinct from new.medication_display
     or rx_dose_quantity is distinct from new.dose_quantity
     or rx_dose_unit is distinct from new.dose_unit
     or rx_route_code is distinct from new.route_code
     or rx_frequency is distinct from new.frequency
     or rx_instructions is distinct from new.instructions
     or rx_created_by is distinct from new.prescribed_by then
    raise exception using errcode = '23514', constraint = 'pharmacy_work_item_source_prescription',
      message = 'Pharmacy acceptance does not match the exact active EHR prescription version';
  end if;
  return new;
end
$$;

create or replace function pharmacy.validate_dispensing()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  parent_row pharmacy.work_items%rowtype;
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
  rx_patient_id uuid;
  rx_facility_id uuid;
  rx_encounter_id uuid;
  rx_version bigint;
  rx_status text;
begin
  select * into parent_row from pharmacy.work_items where id = new.work_item_id;
  if parent_row.id is null
     or session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or parent_row.patient_id is distinct from new.patient_id
     or parent_row.facility_id is distinct from new.facility_id
     or parent_row.row_version is distinct from new.work_item_version
     or parent_row.medication_code_system is distinct from new.medication_code_system
     or parent_row.medication_code is distinct from new.medication_code
     or parent_row.medication_display is distinct from new.medication_display
     or new.facility_id is distinct from session_facility_id
     or new.dispensed_by is distinct from session_account_id
     or new.dispensed_by_membership_id is distinct from session_membership_id then
    raise exception using errcode = '23514',
      message = 'Dispensing does not match its eligible Pharmacy work item and actor context';
  end if;
  select p.patient_id, p.facility_id, p.encounter_id, p.row_version, p.status
    into rx_patient_id, rx_facility_id, rx_encounter_id, rx_version, rx_status
    from ehr.prescriptions p
   where p.id = parent_row.source_ehr_prescription_id
     for share;
  if not found
     or rx_patient_id is distinct from parent_row.patient_id
     or rx_facility_id is distinct from parent_row.facility_id
     or rx_encounter_id is distinct from parent_row.source_encounter_id
     or rx_status is distinct from 'active'
     or rx_version is distinct from parent_row.source_ehr_prescription_version then
    raise exception using errcode = '23514', constraint = 'pharmacy_dispensing_source_prescription',
      message = 'The EHR prescription of this Pharmacy work item is not active at the accepted version';
  end if;
  return new;
end
$$;
