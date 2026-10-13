-- EHR retraction integrity: retraction respects record permissions, closed
-- orders and encounters are final, and a vital can be entered in error.
-- Applied migrations 0001 through 0084 are immutable; 0085 to 0089 belong to
-- other changes.
--
-- 1. Retraction needs the records' write permissions (ENC-RETRACT-1).
--    Cancelling an encounter cancels its open orders, and marking it entered
--    in error retracts its records (0084, CLIN-EIE). Both ran for anyone who
--    may write the encounter: row-level security checks the patient's consent,
--    not the role, so a nurse or receptionist could retract a doctor's
--    diagnosis or prescription through the encounter. Before an encounter
--    becomes cancelled or entered_in_error, ehr.require_retraction_permission()
--    finds each kind of record the close changes and refuses with 42501
--    ENCOUNTER_RETRACTION_NOT_PERMITTED unless the writing membership holds
--    that kind's write permission (auth.membership_has_permission):
--      entered_in_error: notes (draft, signed, amended) ehr.note.write;
--        diagnoses (any verification but entered_in_error) ehr.diagnosis.write;
--        vitals (final) ehr.vital.write; prescriptions and lab requests
--        (draft, active, on_hold, completed) ehr.prescription.write and
--        ehr.lab-request.write; documents linked to it (initiated, uploaded)
--        ehr.document.write;
--      cancelled: prescriptions and lab requests (draft, active, on_hold).
--    An encounter that holds none of these needs no record permission. No
--    role holds ehr.lab-request.write since 0084, so an encounter holding a
--    lab request cannot be cancelled or retracted until Lab ordering is
--    enabled again; no lab request can be created at launch.
--
-- 2. Closed encounters are final (ORDER-CLOSED-EDIT).
--    ehr.keep_closed_encounter() refuses any update of a cancelled or
--    entered-in-error encounter (55000 ENCOUNTER_NOT_OPEN, as 0084's guard).
--
-- 3. Closed orders are final (RX-FINAL, ORDER-CLOSED-EDIT).
--    ehr.keep_closed_order() refuses any update of a completed, cancelled or
--    entered-in-error prescription or lab request (55000 PRESCRIPTION_FINAL or
--    LAB_REQUEST_FINAL), except marking a completed one entered in error with
--    nothing else changed, and any status change outside the order
--    transitions the services apply (55000 INVALID_PRESCRIPTION_TRANSITION or
--    INVALID_LAB_REQUEST_TRANSITION):
--      draft -> active, cancelled, entered_in_error
--      active -> on_hold, completed, cancelled, entered_in_error
--      on_hold -> active, cancelled, entered_in_error
--      completed -> entered_in_error
--
-- 4. A vital can be entered in error (ENC-RETRACT-2).
--    ehr.vitals gains status ('final' by default, or 'entered_in_error').
--    ehr.keep_recorded_vital() (0084, D8) is replaced: it still refuses any
--    change of the recorded values (55000 VITAL_RECORD_IMMUTABLE), now also
--    allows the one-way change final -> entered_in_error, and refuses any
--    change of a vital entered in error (55000 VITAL_ENTERED_IN_ERROR), its
--    correction number included. Existing vitals become 'final' (the column
--    default; no row is rewritten and no version is recorded).
--    ehr.require_final_vital() refuses a correction row of a vital entered in
--    error (55000 VITAL_ENTERED_IN_ERROR), so the vital's corrections cannot
--    grow after its retraction either. It reads the vital with FOR SHARE: a
--    correction and a retraction of the same vital wait for each other, and a
--    correction never commits beside a retraction it did not see. A vital it
--    cannot read under the writer's row-level security is refused with 42501
--    VITAL_NOT_AVAILABLE.
--
-- 5. A retracted document stays retracted (ENC-RETRACT-2).
--    Retracting an encounter marks its initiated or uploaded documents
--    entered in error. ehr.keep_retracted_document() refuses any update of a
--    document entered in error (55000 DOCUMENT_ENTERED_IN_ERROR): setting it
--    back to uploaded would let ehr.documents_effective show it as available
--    again, and the emergency summary and the download route serve it.
--    Upload completion (initiated to uploaded) and the retraction itself
--    (initiated or uploaded to entered_in_error) are unchanged.
--
-- The guard functions are SECURITY INVOKER with a pinned search_path: they run
-- with the writer's privileges and row-level security, so they add no
-- dependency on the schema owner (release checklist P8). The retraction guard
-- calls auth.membership_has_permission, the existing SECURITY DEFINER
-- permission decision Identity uses; runtime-grants.sql grants EXECUTE on it
-- to hid_ehr_runtime. Each trigger's name sorts before the table's version
-- trigger, so a refused write records no version (ehr.vital_corrections is
-- append-only and has none). Lock order is 0084's: the encounter's row lock is
-- taken before any record of it, and the retraction guard reads records only
-- under the encounter's lock. The correction guard locks only the corrected
-- vital, which the EHR already holds FOR UPDATE when it adds a correction.

alter table ehr.vitals
  add column status text not null default 'final'
  constraint vitals_status_check check (status in ('final', 'entered_in_error'));

create or replace function ehr.keep_recorded_vital()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status = 'entered_in_error' then
    raise exception using errcode = '55000', message = 'VITAL_ENTERED_IN_ERROR';
  end if;
  if new.status is distinct from old.status and new.status is distinct from 'entered_in_error' then
    raise exception using errcode = '55000', message = 'VITAL_RECORD_IMMUTABLE';
  end if;
  if (to_jsonb(new) - array['current_correction_no', 'status', 'row_version', 'updated_at'])
     is distinct from (to_jsonb(old) - array['current_correction_no', 'status', 'row_version', 'updated_at']) then
    raise exception using errcode = '55000', message = 'VITAL_RECORD_IMMUTABLE';
  end if;
  return new;
end
$$;

create function ehr.keep_closed_order()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  kind text := case tg_table_name when 'prescriptions' then 'PRESCRIPTION' else 'LAB_REQUEST' end;
begin
  if old.status in ('cancelled', 'entered_in_error')
     or (old.status = 'completed'
         and (new.status is distinct from 'entered_in_error'
              or (to_jsonb(new) - array['status', 'row_version', 'updated_at'])
                 is distinct from (to_jsonb(old) - array['status', 'row_version', 'updated_at']))) then
    raise exception using errcode = '55000', message = kind || '_FINAL',
      detail = 'The order is ' || old.status;
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status in ('active', 'cancelled', 'entered_in_error'))
    or (old.status = 'active' and new.status in ('on_hold', 'completed', 'cancelled', 'entered_in_error'))
    or (old.status = 'on_hold' and new.status in ('active', 'cancelled', 'entered_in_error'))
    or (old.status = 'completed' and new.status = 'entered_in_error')) then
    raise exception using errcode = '55000', message = 'INVALID_' || kind || '_TRANSITION',
      detail = old.status || ' to ' || new.status;
  end if;
  return new;
end
$$;

create function ehr.keep_closed_encounter()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status in ('cancelled', 'entered_in_error') then
    raise exception using errcode = '55000', message = 'ENCOUNTER_NOT_OPEN',
      detail = 'The encounter is ' || old.status;
  end if;
  return new;
end
$$;

create function ehr.require_retraction_permission()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_membership uuid := platform.current_membership_id();
  required text[] := array[]::text[];
  missing text[];
begin
  if new.status is not distinct from old.status or new.status not in ('cancelled', 'entered_in_error') then
    return new;
  end if;
  if new.status = 'entered_in_error' then
    if exists (select 1 from ehr.clinical_notes record_row
                where record_row.encounter_id = new.id and record_row.patient_id = new.patient_id
                  and record_row.facility_id = new.facility_id
                  and record_row.status in ('draft', 'signed', 'amended')) then
      required := required || 'ehr.note.write'::text;
    end if;
    if exists (select 1 from ehr.diagnoses record_row
                where record_row.encounter_id = new.id and record_row.patient_id = new.patient_id
                  and record_row.facility_id = new.facility_id
                  and record_row.verification_status in ('unconfirmed', 'provisional', 'differential', 'confirmed',
                                                         'refuted')) then
      required := required || 'ehr.diagnosis.write'::text;
    end if;
    if exists (select 1 from ehr.vitals record_row
                where record_row.encounter_id = new.id and record_row.patient_id = new.patient_id
                  and record_row.facility_id = new.facility_id and record_row.status = 'final') then
      required := required || 'ehr.vital.write'::text;
    end if;
    if exists (select 1 from ehr.prescriptions record_row
                where record_row.encounter_id = new.id and record_row.patient_id = new.patient_id
                  and record_row.facility_id = new.facility_id
                  and record_row.status in ('draft', 'active', 'on_hold', 'completed')) then
      required := required || 'ehr.prescription.write'::text;
    end if;
    if exists (select 1 from ehr.lab_requests record_row
                where record_row.encounter_id = new.id and record_row.patient_id = new.patient_id
                  and record_row.facility_id = new.facility_id
                  and record_row.status in ('draft', 'active', 'on_hold', 'completed')) then
      required := required || 'ehr.lab-request.write'::text;
    end if;
    if exists (select 1 from ehr.documents record_row
                where record_row.encounter_id = new.id and record_row.patient_id = new.patient_id
                  and record_row.facility_id = new.facility_id
                  and record_row.status in ('initiated', 'uploaded')) then
      required := required || 'ehr.document.write'::text;
    end if;
  else
    if exists (select 1 from ehr.prescriptions record_row
                where record_row.encounter_id = new.id and record_row.patient_id = new.patient_id
                  and record_row.facility_id = new.facility_id
                  and record_row.status in ('draft', 'active', 'on_hold')) then
      required := required || 'ehr.prescription.write'::text;
    end if;
    if exists (select 1 from ehr.lab_requests record_row
                where record_row.encounter_id = new.id and record_row.patient_id = new.patient_id
                  and record_row.facility_id = new.facility_id
                  and record_row.status in ('draft', 'active', 'on_hold')) then
      required := required || 'ehr.lab-request.write'::text;
    end if;
  end if;
  if cardinality(required) = 0 then
    return new;
  end if;
  select array_agg(permission order by permission)
    into missing
    from unnest(required) permission
   where actor_subject is null or actor_membership is null
      or not auth.membership_has_permission(actor_subject, actor_membership, new.facility_id, permission);
  if missing is not null then
    raise exception using errcode = '42501', message = 'ENCOUNTER_RETRACTION_NOT_PERMITTED',
      detail = 'Missing permissions: ' || array_to_string(missing, ', ');
  end if;
  return new;
end
$$;

create function ehr.require_final_vital()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  vital_status text;
begin
  select vital.status
    into vital_status
    from ehr.vitals vital
   where vital.id = new.vital_id
     and vital.patient_id = new.patient_id
     and vital.facility_id = new.facility_id
     for share;
  if not found then
    raise exception using errcode = '42501', message = 'VITAL_NOT_AVAILABLE';
  end if;
  if vital_status = 'entered_in_error' then
    raise exception using errcode = '55000', message = 'VITAL_ENTERED_IN_ERROR';
  end if;
  return new;
end
$$;

create function ehr.keep_retracted_document()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status = 'entered_in_error' then
    raise exception using errcode = '55000', message = 'DOCUMENT_ENTERED_IN_ERROR';
  end if;
  return new;
end
$$;

create trigger encounters_closed_final before update on ehr.encounters
  for each row execute function ehr.keep_closed_encounter();
create trigger encounters_retraction_permission before update of status on ehr.encounters
  for each row execute function ehr.require_retraction_permission();
create trigger prescriptions_closed_final before update on ehr.prescriptions
  for each row execute function ehr.keep_closed_order();
create trigger lab_requests_closed_final before update on ehr.lab_requests
  for each row execute function ehr.keep_closed_order();
create trigger vital_corrections_vital_final before insert on ehr.vital_corrections
  for each row execute function ehr.require_final_vital();
create trigger documents_retracted_final before update on ehr.documents
  for each row execute function ehr.keep_retracted_document();

revoke all on function ehr.keep_closed_order() from public;
revoke all on function ehr.keep_closed_encounter() from public;
revoke all on function ehr.require_retraction_permission() from public;
revoke all on function ehr.require_final_vital() from public;
revoke all on function ehr.keep_retracted_document() from public;

comment on column ehr.vitals.status is
  'final, or entered_in_error once retracted (wrong patient or wrong value); a vital entered in error takes no further change (0090).';
comment on function ehr.keep_recorded_vital() is
  'Refuses an update of a recorded vital other than its current correction number or its retraction (final to entered_in_error), and any update of a vital entered in error (0084, D8; 0090).';
comment on function ehr.keep_closed_order() is
  'Refuses any update of a completed, cancelled or entered-in-error prescription or lab request except a completed one entered in error, and any status change outside the order transitions (0090).';
comment on function ehr.keep_closed_encounter() is
  'Refuses any update of a cancelled or entered-in-error encounter (0090).';
comment on function ehr.require_retraction_permission() is
  'Refuses cancelling or retracting an encounter unless the writing membership holds the write permission of every kind of record the close changes (0090).';
comment on function ehr.require_final_vital() is
  'Refuses a correction of a vital entered in error, reading the vital under a share lock (0090).';
comment on function ehr.keep_retracted_document() is
  'Refuses any update of a document entered in error, so a retracted document is never served again (0090).';
