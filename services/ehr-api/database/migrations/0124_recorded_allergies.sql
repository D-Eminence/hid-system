-- 0124 Allergies a facility records, and the prescriber's acknowledgement of
-- an allergy warning (EHR clinical safety).
--
-- Today a clinician cannot record an allergy, and nothing checks allergies
-- when a prescription is written. The patient may have typed allergies into
-- their own health information (0094, ehr.patient_reported_health_profiles,
-- "reported by the patient"); that stays apart and unchanged. This migration
-- adds the clinician's record and the acknowledgement; ehr-api does the
-- matching (generic name and a small class map) when a prescription is
-- created and asks the prescriber to acknowledge a match with a reason.
--
-- 0. Preconditions (catalog reads only; 55000, nothing applied): the tables
--    and functions this migration refers to exist (0004, 0005, 0061, 0094);
--    no object of this migration exists yet ('0124: already applied').
-- 1. ehr.recorded_allergies: per patient, an allergy a clinician recorded at
--    a facility: substance (1-200 characters, trimmed, no control
--    characters), reaction (1-500, the same rules, or null), severity
--    (mild, moderate, severe or unknown), who recorded it (account and
--    membership, at the row's facility) and when. Status active or
--    entered_in_error; marking it entered in error records who, when and
--    why (3-500 characters). Nothing else ever changes and no row is
--    deleted. Each insert and the one allowed update are versioned by 0004's
--    ehr.capture_record_version (the change reason is the entered-in-error
--    reason), like every other clinical table.
-- 2. ehr.prescription_allergy_acknowledgements: append-only; per
--    prescription created after an allergy warning, the prescriber's reason
--    (3-500 characters), the ids of the recorded allergies that matched and
--    whether the patient-reported allergies matched. Attribution checked by
--    0005's ehr.validate_append_only_clinical_actor; never updated or
--    deleted.
-- 3. Row-level security, forced on both tables, as the other clinical
--    tables (0005): the recorded allergies are read by the patient in a
--    patient-self transaction or by a clinician whose access to the patient
--    at the current facility is granted (ehr.imported_record_read_context,
--    as 0094's patient-reported profile), so an allergy recorded at one
--    facility is seen by every facility the patient has given access to;
--    they are written (insert, and marking entered in error) only at the
--    row's own facility with write access (ehr.context_allows ...
--    'write_records'). The acknowledgements are read and written at their
--    own facility (read_records, write_records).
-- 4. Grants: SELECT, INSERT, UPDATE on ehr.recorded_allergies and SELECT,
--    INSERT on ehr.prescription_allergy_acknowledgements to hid_ehr_runtime
--    and hid_schema_test_runtime when those roles exist (runtime-grants.sql
--    grants the same). No DELETE anywhere.
--
-- AUDIT: the services audit each read and write as other clinical reads and
-- writes (ClinicalRepository.run): action, resource type and id, outcome and
-- counts, never the substance, reaction or reason text.
--
-- BACKWARD COMPATIBLE: new tables only; no existing table, column, policy,
-- function or grant changes. Today's services do not read them.
--
-- LOCKS: SHARE ROW EXCLUSIVE on the referenced tables while their foreign
-- keys are added (identity.patients, identity.facilities, auth.accounts,
-- identity.staff_facility_memberships, ehr.prescriptions); nothing else.

do $$
begin
  if to_regclass('identity.patients') is null
     or to_regclass('identity.facilities') is null
     or to_regclass('auth.accounts') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('ehr.prescriptions') is null
     or to_regclass('ehr.record_versions') is null
     or to_regclass('ehr.patient_reported_health_profiles') is null
     or to_regprocedure('ehr.capture_record_version()') is null
     or to_regprocedure('ehr.validate_append_only_clinical_actor()') is null
     or to_regprocedure('ehr.context_allows(uuid,uuid,text)') is null
     or to_regprocedure('ehr.imported_record_read_context(uuid)') is null
     or to_regprocedure('platform.reject_mutation()') is null
     or to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null then
    raise exception using errcode = '55000', message = '0124: 0001-0094 must be applied first';
  end if;
  if to_regclass('ehr.recorded_allergies') is not null
     or to_regclass('ehr.prescription_allergy_acknowledgements') is not null
     or to_regprocedure('ehr.guard_recorded_allergy_update()') is not null then
    raise exception using errcode = '55000', message = '0124: already applied';
  end if;
end
$$;

-- 1. Recorded allergies.
create table ehr.recorded_allergies (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  substance text not null check (
    char_length(substance) between 1 and 200 and substance = btrim(substance)
    and substance !~ '[[:cntrl:]]'),
  reaction text check (
    reaction is null or (char_length(reaction) between 1 and 500 and reaction = btrim(reaction)
    and reaction !~ '[[:cntrl:]]')),
  severity text not null check (severity in ('mild', 'moderate', 'severe', 'unknown')),
  status text not null default 'active' check (status in ('active', 'entered_in_error')),
  entered_in_error_by uuid references auth.accounts(id) on delete restrict,
  entered_in_error_at timestamptz,
  entered_in_error_reason text check (
    entered_in_error_reason is null or (char_length(btrim(entered_in_error_reason)) between 3 and 500
    and entered_in_error_reason !~ '[\u0000-\u0009\u000b-\u001f\u007f]')),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, patient_id, facility_id),
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (
    (status = 'active' and entered_in_error_by is null and entered_in_error_at is null
      and entered_in_error_reason is null)
    or (status = 'entered_in_error' and entered_in_error_by is not null and entered_in_error_at is not null
      and entered_in_error_reason is not null))
);

create index recorded_allergies_patient_idx on ehr.recorded_allergies (patient_id, status, created_at desc);

-- Only one change is ever allowed: an active allergy marked entered in error,
-- by the acting account, now, with a reason. Everything else is immutable.
create function ehr.guard_recorded_allergy_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
begin
  if old.status <> 'active' or new.status <> 'entered_in_error' then
    raise exception using errcode = '55000', message = 'Only an active allergy can be marked entered in error';
  end if;
  if new.id <> old.id or new.patient_id <> old.patient_id or new.facility_id <> old.facility_id
     or new.created_by <> old.created_by or new.created_by_membership_id <> old.created_by_membership_id
     or new.substance <> old.substance or new.reaction is distinct from old.reaction
     or new.severity <> old.severity or new.created_at <> old.created_at then
    raise exception using errcode = '55000', message = 'A recorded allergy cannot be changed, only marked entered in error';
  end if;
  if actor_account is null or new.entered_in_error_by is distinct from actor_account then
    raise exception using errcode = '42501', message = 'entered_in_error_by must be the acting account';
  end if;
  new.entered_in_error_at := clock_timestamp();
  return new;
end
$$;
revoke all on function ehr.guard_recorded_allergy_update() from public;

create trigger recorded_allergies_guard before update on ehr.recorded_allergies
  for each row execute function ehr.guard_recorded_allergy_update();
create trigger recorded_allergies_versioned before insert or update on ehr.recorded_allergies
  for each row execute function ehr.capture_record_version();
create trigger recorded_allergies_no_delete before delete on ehr.recorded_allergies
  for each row execute function platform.reject_mutation();

comment on table ehr.recorded_allergies is
  '0124: allergies a clinician recorded at a facility (kept apart from the patient-reported ones of 0094). Never deleted; only marked entered in error with a reason.';

-- 2. Acknowledgements of an allergy warning at prescribing.
create table ehr.prescription_allergy_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null,
  patient_id uuid not null,
  facility_id uuid not null,
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  reason text not null check (
    char_length(btrim(reason)) between 10 and 500 and reason !~ '[\u0000-\u0009\u000b-\u001f\u007f]'),
  matched_recorded_allergy_ids uuid[] not null default '{}'
    check (cardinality(matched_recorded_allergy_ids) <= 50 and array_position(matched_recorded_allergy_ids, null) is null),
  patient_reported_matched boolean not null,
  -- When the reason was given: at create, on Activate (draft) or Resume (on hold), or on sending
  -- a draft to another facility. A prescription can carry one per stage it went through.
  stage text not null check (stage in ('create', 'activate', 'resume', 'send')),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (prescription_id, patient_id, facility_id)
    references ehr.prescriptions(id, patient_id, facility_id) on delete restrict,
  foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (patient_reported_matched or cardinality(matched_recorded_allergy_ids) > 0)
);

create index prescription_allergy_acknowledgements_prescription
  on ehr.prescription_allergy_acknowledgements (prescription_id);

create trigger prescription_allergy_acknowledgements_validate_actor
  before insert on ehr.prescription_allergy_acknowledgements
  for each row execute function ehr.validate_append_only_clinical_actor();
create trigger prescription_allergy_acknowledgements_no_mutation
  before update or delete on ehr.prescription_allergy_acknowledgements
  for each row execute function platform.reject_mutation();

comment on table ehr.prescription_allergy_acknowledgements is
  '0124: the prescriber''s reason for going ahead with a prescription after an allergy warning (at create, Activate, Resume or send), with the allergies that matched. Append-only.';

-- 3. Row-level security.
alter table ehr.recorded_allergies enable row level security;
alter table ehr.recorded_allergies force row level security;
alter table ehr.prescription_allergy_acknowledgements enable row level security;
alter table ehr.prescription_allergy_acknowledgements force row level security;

create policy recorded_allergies_read on ehr.recorded_allergies for select
  using (ehr.imported_record_read_context(patient_id));
create policy recorded_allergies_insert on ehr.recorded_allergies for insert
  with check (status = 'active' and ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy recorded_allergies_update on ehr.recorded_allergies for update
  using (ehr.context_allows(patient_id, facility_id, 'write_records'))
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));

create policy prescription_allergy_acknowledgements_read on ehr.prescription_allergy_acknowledgements for select
  using (ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy prescription_allergy_acknowledgements_insert on ehr.prescription_allergy_acknowledgements for insert
  with check (ehr.context_allows(patient_id, facility_id, 'write_records'));

revoke all on ehr.recorded_allergies, ehr.prescription_allergy_acknowledgements from public;

-- 4. Grants (runtime-grants.sql grants the same).
do $$
declare
  grantee text;
begin
  foreach grantee in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant select, insert, update on ehr.recorded_allergies to %I', grantee);
      execute format('grant select, insert on ehr.prescription_allergy_acknowledgements to %I', grantee);
    end if;
  end loop;
end
$$;
