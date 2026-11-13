\set ON_ERROR_STOP on
-- Recorded allergies and allergy-warning acknowledgements (0117).
-- Rollback-only. The EHR's statements run as hid_ehr_api_runtime in the
-- context ClinicalRepository sets (app.actor_subject, facility, membership,
-- purpose, correlation). Synthetic values only; uuid prefix a124.
--   1. privileges: the EHR runtime may SELECT, INSERT and UPDATE recorded
--      allergies and SELECT and INSERT acknowledgements; never DELETE;
--      PUBLIC nothing;
--   2. a doctor with write access at facility F1 records an allergy; it is
--      versioned in ehr.record_versions; attribution to another account,
--      an invalid severity, a control character, a status other than active
--      and a facility where the nurse has only read access are refused;
--   3. reads: the doctor (write access at F2) and the nurse (read access at
--      F2) see F1's allergy; no access, another patient or another purpose
--      sees nothing;
--   4. marking entered in error: only at F1 (not from F2, with read or with
--      write access), with a change reason, by the acting account; once;
--      nothing else may change; nothing is deleted; the allergy check's read
--      no longer returns it;
--   5. acknowledgements: written at the prescription's facility with a
--      match, a stage (create, activate, resume, send or handoff; any
--      other is refused) and a reason of 10 to 500 characters; one or more
--      per prescription, each with its stage, and the patient's own terms
--      that matched; append-only; a row with nothing matched is refused;
--   7. the emergency (break-glass) read: with a reasoned break-glass grant
--      for P at F2 and purpose emergency, an emergency doctor E (membership
--      at F2, no direct-care grant) reads the recorded
--      allergies (every facility's) and the patient's own text, through
--      the same read policies as direct care; without the grant nothing;
--      the grant writes nothing (no allergy, no marking, no acknowledgement)
--      and reads no acknowledgement; E under direct care reads nothing.
begin;

create function pg_temp.as_staff(subject text, membership text, facility text, purpose text, correlation text)
returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', facility, true),
    set_config('app.membership_id', membership, true), set_config('app.purpose_of_use', purpose, true),
    set_config('app.correlation_id', correlation, true), set_config('app.patient_id', '', true),
    set_config('app.change_reason', '', true);
$$;
create function pg_temp.sqlstate_of(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.as_staff(text, text, text, text, text), pg_temp.sqlstate_of(text) to public;

-- 1. Privileges.
do $$
begin
  if not has_table_privilege('hid_ehr_api_runtime', 'ehr.recorded_allergies', 'SELECT')
     or not has_table_privilege('hid_ehr_api_runtime', 'ehr.recorded_allergies', 'INSERT')
     or not has_table_privilege('hid_ehr_api_runtime', 'ehr.recorded_allergies', 'UPDATE')
     or has_table_privilege('hid_ehr_api_runtime', 'ehr.recorded_allergies', 'DELETE')
     or not has_table_privilege('hid_ehr_api_runtime', 'ehr.prescription_allergy_acknowledgements', 'SELECT')
     or not has_table_privilege('hid_ehr_api_runtime', 'ehr.prescription_allergy_acknowledgements', 'INSERT')
     or has_table_privilege('hid_ehr_api_runtime', 'ehr.prescription_allergy_acknowledgements', 'UPDATE')
     or has_table_privilege('hid_ehr_api_runtime', 'ehr.prescription_allergy_acknowledgements', 'DELETE') then
    raise exception '1a: the EHR runtime''s privileges on the 0117 tables are not as granted';
  end if;
  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'ehr' and table_name in ('recorded_allergies', 'prescription_allergy_acknowledgements')
                and grantee = 'PUBLIC') then
    raise exception '1b: PUBLIC holds a privilege on a 0117 table';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'ehr.recorded_allergies'::regclass)
     or not (select relrowsecurity and relforcerowsecurity from pg_class
              where oid = 'ehr.prescription_allergy_acknowledgements'::regclass) then
    raise exception '1c: row-level security is not forced on a 0117 table';
  end if;
  if has_table_privilege('hid_lab_api_runtime', 'ehr.recorded_allergies', 'SELECT')
     or has_table_privilege('hid_pharmacy_api_runtime', 'ehr.recorded_allergies', 'SELECT') then
    raise exception '1d: another service reads recorded allergies';
  end if;
end $$;

-- Fixtures: doctor D (account a124a...01) with memberships at F1 and F2
-- (write access to patient P at both); nurse N with memberships at F1
-- (write access) and F2 (read access only); patient P and patient Q (no
-- access); an encounter and a prescription for P at F1.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'allergy-test') on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, source_system) values
  ('a124a000-0000-4000-8000-000000000001', 'staff:a124-doctor', 'a124-doctor@example.invalid', 'Allergy Doctor', 'active', 'hid'),
  ('a124a000-0000-4000-8000-000000000002', 'synthetic:a124:p', 'a124-p@example.invalid', 'Pat Allergy', 'active', 'hid'),
  ('a124a000-0000-4000-8000-000000000003', 'synthetic:a124:q', 'a124-q@example.invalid', 'Quin Other', 'active', 'hid'),
  ('a124a000-0000-4000-8000-000000000004', 'staff:a124-nurse', 'a124-nurse@example.invalid', 'Allergy Nurse', 'active', 'hid');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, source_system) values
  ('a124b000-0000-4000-8000-000000000001', 'a124a000-0000-4000-8000-000000000002', 'HID-ALRPAT', 'Pat', 'Allergy',
   'Pat Allergy', 'active', 'hid'),
  ('a124b000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000003', 'HID-ALRQUN', 'Quin', 'Other',
   'Quin Other', 'active', 'hid');
insert into identity.organizations (id, name, slug) values
  ('a124d000-0000-4000-8000-000000000001', 'Allergy Test Org', 'a124-allergy-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('a124d000-0000-4000-8000-000000000002', 'a124d000-0000-4000-8000-000000000001', 'Allergy Test Hospital', 'A124-H',
   'Africa/Lagos', true, 'verified'),
  ('a124d000-0000-4000-8000-000000000003', 'a124d000-0000-4000-8000-000000000001', 'Allergy Other Clinic', 'A124-C',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('a124e000-0000-4000-8000-000000000001', 'a124a000-0000-4000-8000-000000000001', 'Allergy Doctor',
   'a124-doctor@example.invalid', 'verified', 'doctor'),
  ('a124e000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000004', 'Allergy Nurse',
   'a124-nurse@example.invalid', 'verified', 'nurse');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('a124f000-0000-4000-8000-000000000001', 'a124e000-0000-4000-8000-000000000001', 'a124a000-0000-4000-8000-000000000001',
   'a124d000-0000-4000-8000-000000000001', 'a124d000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true),
  ('a124f000-0000-4000-8000-000000000002', 'a124e000-0000-4000-8000-000000000001', 'a124a000-0000-4000-8000-000000000001',
   'a124d000-0000-4000-8000-000000000001', 'a124d000-0000-4000-8000-000000000003', 'doctor', 'doctor', false, true),
  ('a124f000-0000-4000-8000-000000000003', 'a124e000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000004',
   'a124d000-0000-4000-8000-000000000001', 'a124d000-0000-4000-8000-000000000002', 'nurse', 'nurse', true, true),
  ('a124f000-0000-4000-8000-000000000004', 'a124e000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000004',
   'a124d000-0000-4000-8000-000000000001', 'a124d000-0000-4000-8000-000000000003', 'nurse', 'nurse', false, true);
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system) values
  ('a124c000-0000-4000-8000-000000000001', 'a124b000-0000-4000-8000-000000000001', 'a124e000-0000-4000-8000-000000000001',
   'a124a000-0000-4000-8000-000000000001', 'a124f000-0000-4000-8000-000000000001', 'a124d000-0000-4000-8000-000000000002',
   'write_records', 'direct-care', 'active', 'Allergy test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'a124-grant-0001', 'hid'),
  ('a124c000-0000-4000-8000-000000000002', 'a124b000-0000-4000-8000-000000000001', 'a124e000-0000-4000-8000-000000000001',
   'a124a000-0000-4000-8000-000000000001', 'a124f000-0000-4000-8000-000000000002', 'a124d000-0000-4000-8000-000000000003',
   'write_records', 'direct-care', 'active', 'Allergy test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'a124-grant-0002', 'hid'),
  ('a124c000-0000-4000-8000-000000000003', 'a124b000-0000-4000-8000-000000000001', 'a124e000-0000-4000-8000-000000000002',
   'a124a000-0000-4000-8000-000000000004', 'a124f000-0000-4000-8000-000000000003', 'a124d000-0000-4000-8000-000000000002',
   'write_records', 'direct-care', 'active', 'Allergy test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'a124-grant-0003', 'hid'),
  ('a124c000-0000-4000-8000-000000000004', 'a124b000-0000-4000-8000-000000000001', 'a124e000-0000-4000-8000-000000000002',
   'a124a000-0000-4000-8000-000000000004', 'a124f000-0000-4000-8000-000000000004', 'a124d000-0000-4000-8000-000000000003',
   'read_records', 'direct-care', 'active', 'Allergy test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'a124-grant-0004', 'hid');
-- An encounter and a prescription for P at F1, without triggers (fixture only).
set local session_replication_role = replica;
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, chief_complaint)
values ('a1240000-0000-4000-8000-0000000000e1', 'a124b000-0000-4000-8000-000000000001', 'a124d000-0000-4000-8000-000000000002',
  'a124a000-0000-4000-8000-000000000001', 'a124f000-0000-4000-8000-000000000001', 'ambulatory', 'in_progress',
  clock_timestamp(), 'Allergy fixture');
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status)
values ('a1240000-0000-4000-8000-0000000000a1', 'a1240000-0000-4000-8000-0000000000e1', 'a124b000-0000-4000-8000-000000000001',
  'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001', 'a124f000-0000-4000-8000-000000000001',
  'Amoxicillin 500 mg', 'Three times daily', 'After food', 'active');
set local session_replication_role = origin;

-- 2. Recording.
set local role hid_ehr_api_runtime;
do $$
declare
  answer text;
  row_count integer;
begin
  perform pg_temp.as_staff('staff:a124-doctor', 'a124f000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000002', 'direct-care', 'a124-record-0001');
  insert into ehr.recorded_allergies (id, patient_id, facility_id, created_by, created_by_membership_id, substance,
    reaction, severity)
  values ('a1241000-0000-4000-8000-000000000001', 'a124b000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
    'a124f000-0000-4000-8000-000000000001', 'Penicillin', 'Hives', 'severe');
  if (select row_version from ehr.recorded_allergies where id = 'a1241000-0000-4000-8000-000000000001') <> 1 then
    raise exception '2a: a new allergy is not at version 1';
  end if;
  -- 2b. Attribution to another account (the nurse) is refused.
  answer := pg_temp.sqlstate_of($q$insert into ehr.recorded_allergies (patient_id, facility_id, created_by,
      created_by_membership_id, substance, severity) values ('a124b000-0000-4000-8000-000000000001',
      'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000004',
      'a124f000-0000-4000-8000-000000000003', 'Latex', 'mild')$q$);
  if answer not like '42501%' then raise exception '2b: attribution to another account: %', answer; end if;
  -- 2c. Values the table refuses.
  foreach answer in array array[
      pg_temp.sqlstate_of($q$insert into ehr.recorded_allergies (patient_id, facility_id, created_by,
        created_by_membership_id, substance, severity) values ('a124b000-0000-4000-8000-000000000001',
        'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
        'a124f000-0000-4000-8000-000000000001', 'Latex', 'deadly')$q$),
      pg_temp.sqlstate_of($q$insert into ehr.recorded_allergies (patient_id, facility_id, created_by,
        created_by_membership_id, substance, severity) values ('a124b000-0000-4000-8000-000000000001',
        'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
        'a124f000-0000-4000-8000-000000000001', 'Lat' || chr(9) || 'ex', 'mild')$q$),
      pg_temp.sqlstate_of($q$insert into ehr.recorded_allergies (patient_id, facility_id, created_by,
        created_by_membership_id, substance, severity) values ('a124b000-0000-4000-8000-000000000001',
        'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
        'a124f000-0000-4000-8000-000000000001', ' Latex', 'mild')$q$),
      pg_temp.sqlstate_of($q$insert into ehr.recorded_allergies (patient_id, facility_id, created_by,
        created_by_membership_id, substance, severity) values ('a124b000-0000-4000-8000-000000000001',
        'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
        'a124f000-0000-4000-8000-000000000001', repeat('a', 201), 'mild')$q$)] loop
    if answer not like '23514%' then raise exception '2c: an invalid value was stored: %', answer; end if;
  end loop;
  answer := pg_temp.sqlstate_of($q$insert into ehr.recorded_allergies (patient_id, facility_id, created_by,
      created_by_membership_id, substance, severity, status, entered_in_error_by, entered_in_error_at,
      entered_in_error_reason) values ('a124b000-0000-4000-8000-000000000001',
      'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
      'a124f000-0000-4000-8000-000000000001', 'Latex', 'mild', 'entered_in_error',
      'a124a000-0000-4000-8000-000000000001', clock_timestamp(), 'Born in error')$q$);
  if answer not like '42501%' then raise exception '2d: an allergy was recorded already in error: %', answer; end if;
  -- 2e. Patient Q (no access) and, below, the nurse at F2 (read access only) are refused.
  answer := pg_temp.sqlstate_of($q$insert into ehr.recorded_allergies (patient_id, facility_id, created_by,
      created_by_membership_id, substance, severity) values ('a124b000-0000-4000-8000-000000000002',
      'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
      'a124f000-0000-4000-8000-000000000001', 'Latex', 'mild')$q$);
  if answer not like '42501%' then raise exception '2e: recorded for a patient without access: %', answer; end if;
  perform pg_temp.as_staff('staff:a124-nurse', 'a124f000-0000-4000-8000-000000000004',
    'a124d000-0000-4000-8000-000000000003', 'direct-care', 'a124-record-0002');
  answer := pg_temp.sqlstate_of($q$insert into ehr.recorded_allergies (patient_id, facility_id, created_by,
      created_by_membership_id, substance, severity) values ('a124b000-0000-4000-8000-000000000001',
      'a124d000-0000-4000-8000-000000000003', 'a124a000-0000-4000-8000-000000000004',
      'a124f000-0000-4000-8000-000000000004', 'Latex', 'mild')$q$);
  if answer not like '42501%' then raise exception '2f: recorded with read access only: %', answer; end if;

  -- 3. Reads. Another facility sees F1's allergy: allergies follow the patient.
  if (select count(*) from ehr.recorded_allergies where patient_id = 'a124b000-0000-4000-8000-000000000001') <> 1 then
    raise exception '3a: the nurse at another facility with read access does not see the allergy';
  end if;
  perform pg_temp.as_staff('staff:a124-doctor', 'a124f000-0000-4000-8000-000000000002',
    'a124d000-0000-4000-8000-000000000003', 'direct-care', 'a124-read-0003');
  if (select count(*) from ehr.recorded_allergies where patient_id = 'a124b000-0000-4000-8000-000000000001') <> 1 then
    raise exception '3a: the doctor at another facility with write access does not see the allergy';
  end if;
  perform pg_temp.as_staff('staff:a124-doctor', 'a124f000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000002', 'healthcare-operations', 'a124-read-0001');
  if exists (select 1 from ehr.recorded_allergies) then raise exception '3b: read for another purpose'; end if;
  perform pg_temp.as_staff('staff:a124-doctor', 'a124f000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000003', 'direct-care', 'a124-read-0002');
  if exists (select 1 from ehr.recorded_allergies) then
    raise exception '3c: read with a membership that is not the facility''s';
  end if;

  -- 4. Marking entered in error.
  -- 4a. At F2 the row is not updatable: not by the nurse (read access) ...
  perform pg_temp.as_staff('staff:a124-nurse', 'a124f000-0000-4000-8000-000000000004',
    'a124d000-0000-4000-8000-000000000003', 'direct-care', 'a124-error-0001');
  perform set_config('app.change_reason', 'Recorded on the wrong patient', true);
  update ehr.recorded_allergies set status = 'entered_in_error',
      entered_in_error_by = 'a124a000-0000-4000-8000-000000000004', entered_in_error_reason = 'Wrong patient'
   where id = 'a1241000-0000-4000-8000-000000000001';
  get diagnostics row_count = row_count;
  if row_count <> 0 then raise exception '4a: marked from a facility with read access only'; end if;
  -- ... and not by the doctor, who holds write access there: the update policy binds the
  -- row to its own facility, so only the recording facility may mark it.
  perform pg_temp.as_staff('staff:a124-doctor', 'a124f000-0000-4000-8000-000000000002',
    'a124d000-0000-4000-8000-000000000003', 'direct-care', 'a124-error-0003');
  perform set_config('app.change_reason', 'Recorded on the wrong patient', true);
  update ehr.recorded_allergies set status = 'entered_in_error',
      entered_in_error_by = 'a124a000-0000-4000-8000-000000000001', entered_in_error_reason = 'Wrong patient'
   where id = 'a1241000-0000-4000-8000-000000000001';
  get diagnostics row_count = row_count;
  if row_count <> 0 then raise exception '4a1: marked from another facility with write access'; end if;
  -- 4a2. At F2 a plain read sees the row but a locking read (FOR UPDATE, which applies the
  -- update policy) does not. The EHR therefore reads first and answers "recorded elsewhere"
  -- (409) from the plain read, and locks only at the recording facility.
  if (select facility_id from ehr.recorded_allergies where id = 'a1241000-0000-4000-8000-000000000001')
       is distinct from 'a124d000-0000-4000-8000-000000000002'::uuid then
    raise exception '4a2: the plain read at F2 does not show F1''s allergy';
  end if;
  if exists (select 1 from ehr.recorded_allergies where id = 'a1241000-0000-4000-8000-000000000001' for update) then
    raise exception '4a2: a locking read at F2 returned F1''s allergy; the service''s read-then-lock order is unneeded';
  end if;
  perform pg_temp.as_staff('staff:a124-doctor', 'a124f000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000002', 'direct-care', 'a124-error-0002');
  -- 4b. Without a change reason.
  answer := pg_temp.sqlstate_of($q$update ehr.recorded_allergies set status = 'entered_in_error',
      entered_in_error_by = 'a124a000-0000-4000-8000-000000000001', entered_in_error_reason = 'Wrong patient'
    where id = 'a1241000-0000-4000-8000-000000000001'$q$);
  if answer not like '22023%' then raise exception '4b: marked without a change reason: %', answer; end if;
  perform set_config('app.change_reason', 'Recorded on the wrong patient', true);
  -- 4c. Changing the substance, or keeping it active, is refused.
  answer := pg_temp.sqlstate_of($q$update ehr.recorded_allergies set substance = 'Sulfa'
    where id = 'a1241000-0000-4000-8000-000000000001'$q$);
  if answer not like '55000%' then raise exception '4c: the substance changed: %', answer; end if;
  answer := pg_temp.sqlstate_of($q$update ehr.recorded_allergies set status = 'entered_in_error', severity = 'mild',
      entered_in_error_by = 'a124a000-0000-4000-8000-000000000001', entered_in_error_reason = 'Wrong patient'
    where id = 'a1241000-0000-4000-8000-000000000001'$q$);
  if answer not like '55000%' then raise exception '4d: the severity changed with the marking: %', answer; end if;
  -- 4e. In another account's name.
  answer := pg_temp.sqlstate_of($q$update ehr.recorded_allergies set status = 'entered_in_error',
      entered_in_error_by = 'a124a000-0000-4000-8000-000000000004', entered_in_error_reason = 'Wrong patient'
    where id = 'a1241000-0000-4000-8000-000000000001'$q$);
  if answer not like '42501%' then raise exception '4e: marked in another account''s name: %', answer; end if;
  -- 4f. The marking.
  update ehr.recorded_allergies set status = 'entered_in_error',
      entered_in_error_by = 'a124a000-0000-4000-8000-000000000001', entered_in_error_reason = 'Recorded on the wrong patient',
      entered_in_error_at = '2000-01-01'
   where id = 'a1241000-0000-4000-8000-000000000001';
  if (select format('%s|%s|%s', status, row_version, entered_in_error_at > clock_timestamp() - interval '1 minute')
        from ehr.recorded_allergies where id = 'a1241000-0000-4000-8000-000000000001')
     <> 'entered_in_error|2|t' then
    raise exception '4f: the marking is not stored as entered in error at version 2, now';
  end if;
  answer := pg_temp.sqlstate_of($q$update ehr.recorded_allergies set entered_in_error_reason = 'Another reason'
    where id = 'a1241000-0000-4000-8000-000000000001'$q$);
  if answer not like '55000%' then raise exception '4g: an allergy in error changed again: %', answer; end if;
  answer := pg_temp.sqlstate_of($q$delete from ehr.recorded_allergies$q$);
  if answer not like '42501%' then raise exception '4h: the runtime deleted an allergy: %', answer; end if;
  -- 4i. The allergy check's read (allergy-reader.ts) no longer returns it, so it stops warning.
  if exists (select id, substance, reaction, severity, facility_id, created_at from ehr.recorded_allergies
              where patient_id = 'a124b000-0000-4000-8000-000000000001' and status = 'active') then
    raise exception '4i: the allergy check still reads an allergy marked entered in error';
  end if;

  -- 5. Acknowledgements.
  insert into ehr.prescription_allergy_acknowledgements (prescription_id, patient_id, facility_id, created_by,
    created_by_membership_id, reason, matched_recorded_allergy_ids, patient_reported_matched, stage)
  values ('a1240000-0000-4000-8000-0000000000a1', 'a124b000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
    'a124f000-0000-4000-8000-000000000001', 'Tolerated before; monitoring for 30 minutes',
    array['a1241000-0000-4000-8000-000000000001']::uuid[], false, 'create');
  answer := pg_temp.sqlstate_of($q$update ehr.prescription_allergy_acknowledgements set reason = 'Changed'$q$);
  if answer not like '42501%' then raise exception '5a: an acknowledgement changed: %', answer; end if;
  answer := pg_temp.sqlstate_of($q$delete from ehr.prescription_allergy_acknowledgements$q$);
  if answer not like '42501%' then raise exception '5b: an acknowledgement was deleted: %', answer; end if;
end $$;
reset role;

-- 5c-5g: a second prescription for P at F1.
set local session_replication_role = replica;
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status)
values ('a1240000-0000-4000-8000-0000000000a2', 'a1240000-0000-4000-8000-0000000000e1', 'a124b000-0000-4000-8000-000000000001',
  'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001', 'a124f000-0000-4000-8000-000000000001',
  'Ceftriaxone 1 g', 'Once daily', 'Intravenous', 'active');
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
do $$
declare answer text;
begin
  perform pg_temp.as_staff('staff:a124-doctor', 'a124f000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000002', 'direct-care', 'a124-ack-0001');
  answer := pg_temp.sqlstate_of($q$insert into ehr.prescription_allergy_acknowledgements (prescription_id, patient_id,
      facility_id, created_by, created_by_membership_id, reason, matched_recorded_allergy_ids, patient_reported_matched,
      stage)
    values ('a1240000-0000-4000-8000-0000000000a2', 'a124b000-0000-4000-8000-000000000001',
      'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
      'a124f000-0000-4000-8000-000000000001', 'Nothing matched', '{}', false, 'create')$q$);
  if answer not like '23514%' then raise exception '5c: an acknowledgement without a match: %', answer; end if;
  -- 5d. A reason under 10 characters once trimmed, a stage that is not one of the five ('later', or 'hand-off'
  -- for 'handoff'), or a null term is refused.
  foreach answer in array array[
      pg_temp.sqlstate_of($q$insert into ehr.prescription_allergy_acknowledgements (prescription_id, patient_id,
        facility_id, created_by, created_by_membership_id, reason, matched_recorded_allergy_ids, patient_reported_matched,
        stage)
      values ('a1240000-0000-4000-8000-0000000000a2', 'a124b000-0000-4000-8000-000000000001',
        'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
        'a124f000-0000-4000-8000-000000000001', '  a ', '{}', true, 'create')$q$),
      pg_temp.sqlstate_of($q$insert into ehr.prescription_allergy_acknowledgements (prescription_id, patient_id,
        facility_id, created_by, created_by_membership_id, reason, matched_recorded_allergy_ids, patient_reported_matched,
        stage)
      values ('a1240000-0000-4000-8000-0000000000a2', 'a124b000-0000-4000-8000-000000000001',
        'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
        'a124f000-0000-4000-8000-000000000001', '   ok ok   ', '{}', true, 'create')$q$),
      pg_temp.sqlstate_of($q$insert into ehr.prescription_allergy_acknowledgements (prescription_id, patient_id,
        facility_id, created_by, created_by_membership_id, reason, matched_recorded_allergy_ids, patient_reported_matched,
        stage)
      values ('a1240000-0000-4000-8000-0000000000a2', 'a124b000-0000-4000-8000-000000000001',
        'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
        'a124f000-0000-4000-8000-000000000001', 'Tolerated before', '{}', true, 'later')$q$),
      pg_temp.sqlstate_of($q$insert into ehr.prescription_allergy_acknowledgements (prescription_id, patient_id,
        facility_id, created_by, created_by_membership_id, reason, matched_recorded_allergy_ids, patient_reported_matched,
        stage)
      values ('a1240000-0000-4000-8000-0000000000a2', 'a124b000-0000-4000-8000-000000000001',
        'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
        'a124f000-0000-4000-8000-000000000001', 'Tolerated before', '{}', true, 'hand-off')$q$),
      pg_temp.sqlstate_of($q$insert into ehr.prescription_allergy_acknowledgements (prescription_id, patient_id,
        facility_id, created_by, created_by_membership_id, reason, matched_recorded_allergy_ids, patient_reported_matched,
        stage, patient_reported_terms)
      values ('a1240000-0000-4000-8000-0000000000a2', 'a124b000-0000-4000-8000-000000000001',
        'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
        'a124f000-0000-4000-8000-000000000001', 'Tolerated before', '{}', true, 'create', array['penicillin', null])$q$)] loop
    if answer not like '23514%' then raise exception '5d: an invalid acknowledgement was stored: %', answer; end if;
  end loop;
  -- 5g. A prescription may carry one or more reasons, each with its stage: at create, on Activate and,
  -- the prescription being active, at the hand-off to this facility's pharmacy (the 'handoff' stage).
  insert into ehr.prescription_allergy_acknowledgements (prescription_id, patient_id, facility_id, created_by,
    created_by_membership_id, reason, matched_recorded_allergy_ids, patient_reported_matched, stage,
    patient_reported_terms)
  values ('a1240000-0000-4000-8000-0000000000a2', 'a124b000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
    'a124f000-0000-4000-8000-000000000001', 'Patient-reported only; tolerated before', '{}', true, 'create',
    array['penicillin']),
    ('a1240000-0000-4000-8000-0000000000a2', 'a124b000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
    'a124f000-0000-4000-8000-000000000001', 'New allergy reviewed with the patient before activating',
    array['a1241000-0000-4000-8000-000000000001']::uuid[], false, 'activate', default);
  answer := pg_temp.sqlstate_of($q$insert into ehr.prescription_allergy_acknowledgements (prescription_id, patient_id,
      facility_id, created_by, created_by_membership_id, reason, matched_recorded_allergy_ids, patient_reported_matched,
      stage)
    values ('a1240000-0000-4000-8000-0000000000a2', 'a124b000-0000-4000-8000-000000000001',
      'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
      'a124f000-0000-4000-8000-000000000001', 'Allergy recorded since; checked again before the hand-off',
      array['a1241000-0000-4000-8000-000000000001']::uuid[], false, 'handoff')$q$);
  if answer <> 'ok' then raise exception '5g: a reason at the hand-off was refused: %', answer; end if;
  if (select string_agg(stage, ',' order by stage) from ehr.prescription_allergy_acknowledgements
       where prescription_id = 'a1240000-0000-4000-8000-0000000000a2') <> 'activate,create,handoff' then
    raise exception '5g: the reasons per stage are not stored';
  end if;
  if (select string_agg(format('%s:%s', stage, patient_reported_terms), ',' order by stage)
        from ehr.prescription_allergy_acknowledgements
       where prescription_id = 'a1240000-0000-4000-8000-0000000000a2') <> 'activate:{},create:{penicillin},handoff:{}' then
    raise exception '5g: the patient''s acknowledged terms are not stored';
  end if;
  -- 5e. From F2, even with write access there, no acknowledgement for F1's prescription.
  perform pg_temp.as_staff('staff:a124-doctor', 'a124f000-0000-4000-8000-000000000002',
    'a124d000-0000-4000-8000-000000000003', 'direct-care', 'a124-ack-0002');
  answer := pg_temp.sqlstate_of($q$insert into ehr.prescription_allergy_acknowledgements (prescription_id, patient_id,
      facility_id, created_by, created_by_membership_id, reason, matched_recorded_allergy_ids, patient_reported_matched,
      stage)
    values ('a1240000-0000-4000-8000-0000000000a2', 'a124b000-0000-4000-8000-000000000001',
      'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
      'a124f000-0000-4000-8000-000000000001', 'From the other facility', '{}', true, 'create')$q$);
  if answer not like '42501%' then raise exception '5e: acknowledged from another facility: %', answer; end if;
  if exists (select 1 from ehr.prescription_allergy_acknowledgements) then
    raise exception '5f: another facility reads the acknowledgement';
  end if;
end $$;
reset role;

-- Versions: the recording and the marking, each with its change reason.
do $$
begin
  if (select string_agg(format('%s:%s:%s', version_no, operation, change_reason), ',' order by version_no)
        from ehr.record_versions where resource_type = 'recorded_allergies'
          and resource_id = 'a1241000-0000-4000-8000-000000000001')
     <> '1:create:create,2:update:Recorded on the wrong patient' then
    raise exception '6: the allergy''s versions are not the recording and the marking';
  end if;
end $$;

-- 7. The emergency (break-glass) read. A second active allergy for P at F1, the patient's own text,
-- and the emergency purpose (0085 seeds it; other suites may have changed it).
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('emergency', 'Emergency treatment', 'allergy-test') on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, source_system) values
  ('a124a000-0000-4000-8000-000000000005', 'staff:a124-er', 'a124-er@example.invalid', 'Emergency Doctor', 'active', 'hid');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('a124e000-0000-4000-8000-000000000003', 'a124a000-0000-4000-8000-000000000005', 'Emergency Doctor',
   'a124-er@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('a124f000-0000-4000-8000-000000000005', 'a124e000-0000-4000-8000-000000000003', 'a124a000-0000-4000-8000-000000000005',
   'a124d000-0000-4000-8000-000000000001', 'a124d000-0000-4000-8000-000000000003', 'doctor', 'doctor', true, true);
insert into ehr.patient_reported_health_profiles (patient_id, allergies, updated_by_account_id)
values ('a124b000-0000-4000-8000-000000000001', 'sulfa drugs', 'a124a000-0000-4000-8000-000000000002');
set local role hid_ehr_api_runtime;
do $$
begin
  perform pg_temp.as_staff('staff:a124-doctor', 'a124f000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000002', 'direct-care', 'a124-emergency-0001');
  insert into ehr.recorded_allergies (id, patient_id, facility_id, created_by, created_by_membership_id, substance,
    reaction, severity)
  values ('a1241000-0000-4000-8000-000000000002', 'a124b000-0000-4000-8000-000000000001',
    'a124d000-0000-4000-8000-000000000002', 'a124a000-0000-4000-8000-000000000001',
    'a124f000-0000-4000-8000-000000000001', 'Latex', null, 'unknown');
  -- 7a. Before any break-glass grant, the emergency purpose at F2 reads nothing.
  perform pg_temp.as_staff('staff:a124-er', 'a124f000-0000-4000-8000-000000000005',
    'a124d000-0000-4000-8000-000000000003', 'emergency', 'a124-emergency-0002');
  if exists (select 1 from ehr.recorded_allergies) or exists (select 1 from ehr.patient_reported_health_profiles) then
    raise exception '7a: the emergency purpose reads allergies without a break-glass grant';
  end if;
end $$;
reset role;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system) values
  ('a124c000-0000-4000-8000-000000000005', 'a124b000-0000-4000-8000-000000000001', 'a124e000-0000-4000-8000-000000000003',
   'a124a000-0000-4000-8000-000000000005', 'a124f000-0000-4000-8000-000000000005', 'a124d000-0000-4000-8000-000000000003',
   'break_glass', 'emergency', 'active', 'Unconscious on arrival; allergy test', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', true, 'a124-grant-0005', 'hid');
set local role hid_ehr_api_runtime;
do $$
declare answer text;
begin
  perform pg_temp.as_staff('staff:a124-er', 'a124f000-0000-4000-8000-000000000005',
    'a124d000-0000-4000-8000-000000000003', 'emergency', 'a124-emergency-0003');
  -- 7b. The emergency read's queries (allergy-reader.ts emergencyAllergies): the active recorded allergies
  -- of every facility, most serious first, and the patient's own text.
  if (select string_agg(format('%s:%s:%s', substance, severity, facility_id = platform.current_facility_id()), ','
        order by array_position(array['severe', 'unknown', 'moderate', 'mild'], severity), created_at desc, id desc)
        from ehr.recorded_allergies where patient_id = 'a124b000-0000-4000-8000-000000000001' and status = 'active')
     is distinct from 'Latex:unknown:f' then
    raise exception '7b: the break-glass read does not see F1''s active allergy: %',
      (select string_agg(format('%s:%s', substance, status), ',') from ehr.recorded_allergies);
  end if;
  if (select count(*) from ehr.recorded_allergies where patient_id = 'a124b000-0000-4000-8000-000000000001') <> 2 then
    raise exception '7b: the break-glass read does not see every recorded allergy';
  end if;
  if (select allergies from ehr.patient_reported_health_profiles
       where patient_id = 'a124b000-0000-4000-8000-000000000001') is distinct from 'sulfa drugs' then
    raise exception '7c: the break-glass read does not see the patient''s own allergy text';
  end if;
  -- 7d. Another patient: nothing.
  if exists (select 1 from ehr.recorded_allergies where patient_id <> 'a124b000-0000-4000-8000-000000000001') then
    raise exception '7d: the break-glass read sees another patient';
  end if;
  -- 7e. Read-only: no allergy, no marking, no acknowledgement; no acknowledgement read.
  answer := pg_temp.sqlstate_of($q$insert into ehr.recorded_allergies (patient_id, facility_id, created_by,
      created_by_membership_id, substance, severity) values ('a124b000-0000-4000-8000-000000000001',
      'a124d000-0000-4000-8000-000000000003', 'a124a000-0000-4000-8000-000000000005',
      'a124f000-0000-4000-8000-000000000005', 'Iodine', 'mild')$q$);
  if answer not like '42501%' then raise exception '7e: recorded an allergy under break-glass: %', answer; end if;
  perform set_config('app.change_reason', 'Wrong patient', true);
  update ehr.recorded_allergies set status = 'entered_in_error',
      entered_in_error_by = 'a124a000-0000-4000-8000-000000000005', entered_in_error_reason = 'Wrong patient'
   where id = 'a1241000-0000-4000-8000-000000000002';
  if found then raise exception '7e: marked an allergy under break-glass'; end if;
  if exists (select 1 from ehr.prescription_allergy_acknowledgements) then
    raise exception '7e: read an acknowledgement under break-glass';
  end if;
  -- 7f. E under direct care (no direct-care grant) reads nothing.
  perform pg_temp.as_staff('staff:a124-er', 'a124f000-0000-4000-8000-000000000005',
    'a124d000-0000-4000-8000-000000000003', 'direct-care', 'a124-emergency-0004');
  if exists (select 1 from ehr.recorded_allergies) or exists (select 1 from ehr.patient_reported_health_profiles) then
    raise exception '7f: the break-glass grant was used for direct care';
  end if;
end $$;
reset role;

rollback;
