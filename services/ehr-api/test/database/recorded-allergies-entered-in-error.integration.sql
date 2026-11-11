\set ON_ERROR_STOP on
-- Recorded allergies (0124): an allergy marked entered in error stops warning.
-- Rollback-only. The EHR's statements run as hid_ehr_api_runtime in the
-- context ClinicalRepository sets (app.actor_subject, facility, membership,
-- purpose, correlation). Synthetic values only; uuid prefix e124.
--
-- The allergy check (prescription create and the allergy-check route) reads
-- the patient's recorded allergies with one query (allergy-reader.ts,
-- allergiesForCheck) and then matches the medicine against what it read
-- (allergy-match.ts). pg_temp.allergies_for_check below is that query, word
-- for word; allergies.service.spec.ts fails if the two ever differ. The
-- service matches a Penicillin allergy to 'Amoxicillin 500 mg' (penicillins);
-- allergies.service.spec.ts shows that, and that the warning stops once the
-- allergy is marked. This suite shows what the database gives the check:
--   1. Penicillin (severe, anaphylaxis) recorded at facility F1: the check
--      reads it at F1 and at F2 (allergies follow the patient), and nothing
--      outside the doctor's context (it runs under row-level security); once
--      F1 marks it entered in error, the check reads nothing at F1 or at F2,
--      and the allergy is still kept, as entered in error;
--   2. the same for Penicillin recorded at another facility, F2 (patient R,
--      so that nothing from 1 is in the way): the check at F1 reads it; once
--      F2 marks it entered in error, the check at F1 reads nothing;
--   3. an active allergy beside one entered in error is still read, alone.
begin;

create function pg_temp.as_staff(subject text, membership text, facility text, purpose text, correlation text)
returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', facility, true),
    set_config('app.membership_id', membership, true), set_config('app.purpose_of_use', purpose, true),
    set_config('app.correlation_id', correlation, true), set_config('app.patient_id', '', true),
    set_config('app.change_reason', '', true);
$$;
-- The allergy check's read, exactly as ehr-api sends it. A plain SQL function
-- (not SECURITY DEFINER), so it runs as the caller: hid_ehr_api_runtime under
-- forced row-level security.
create function pg_temp.allergies_for_check(uuid)
returns table (allergy_id uuid, allergy_substance text, allergy_reaction text, allergy_severity text)
language sql as $$
  select id, substance, reaction, severity from ehr.recorded_allergies
     where patient_id = $1 and status = 'active' order by created_at, id
$$;
-- What the check read, as 'substance (severity, reaction)' in its order, or '' for nothing.
create function pg_temp.check_reads(patient uuid) returns text language sql as $$
  select coalesce(string_agg(format('%s (%s, %s)', allergy_substance, allergy_severity, allergy_reaction), ', '), '')
    from pg_temp.allergies_for_check(patient);
$$;
grant execute on function pg_temp.as_staff(text, text, text, text, text), pg_temp.allergies_for_check(uuid),
  pg_temp.check_reads(uuid) to public;

-- Fixtures: doctor D (account e124a...01) with memberships at F1 and F2, and
-- write access to patients P and R at both.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'allergy-test') on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, source_system) values
  ('e124a000-0000-4000-8000-000000000001', 'staff:e124-doctor', 'e124-doctor@example.invalid', 'Error Doctor', 'active', 'hid'),
  ('e124a000-0000-4000-8000-000000000002', 'synthetic:e124:p', 'e124-p@example.invalid', 'Pat Errorcase', 'active', 'hid'),
  ('e124a000-0000-4000-8000-000000000003', 'synthetic:e124:r', 'e124-r@example.invalid', 'Remi Errorcase', 'active', 'hid');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, source_system) values
  ('e124b000-0000-4000-8000-000000000001', 'e124a000-0000-4000-8000-000000000002', 'HID-ERRPAT', 'Pat', 'Errorcase',
   'Pat Errorcase', 'active', 'hid'),
  ('e124b000-0000-4000-8000-000000000002', 'e124a000-0000-4000-8000-000000000003', 'HID-ERRREM', 'Remi', 'Errorcase',
   'Remi Errorcase', 'active', 'hid');
insert into identity.organizations (id, name, slug) values
  ('e124d000-0000-4000-8000-000000000001', 'Allergy Error Test Org', 'e124-allergy-error-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e124d000-0000-4000-8000-000000000002', 'e124d000-0000-4000-8000-000000000001', 'Error Test Hospital', 'E124-H',
   'Africa/Lagos', true, 'verified'),
  ('e124d000-0000-4000-8000-000000000003', 'e124d000-0000-4000-8000-000000000001', 'Error Other Clinic', 'E124-C',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e124e000-0000-4000-8000-000000000001', 'e124a000-0000-4000-8000-000000000001', 'Error Doctor',
   'e124-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('e124f000-0000-4000-8000-000000000001', 'e124e000-0000-4000-8000-000000000001', 'e124a000-0000-4000-8000-000000000001',
   'e124d000-0000-4000-8000-000000000001', 'e124d000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true),
  ('e124f000-0000-4000-8000-000000000002', 'e124e000-0000-4000-8000-000000000001', 'e124a000-0000-4000-8000-000000000001',
   'e124d000-0000-4000-8000-000000000001', 'e124d000-0000-4000-8000-000000000003', 'doctor', 'doctor', false, true);
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system) values
  ('e124c000-0000-4000-8000-000000000001', 'e124b000-0000-4000-8000-000000000001', 'e124e000-0000-4000-8000-000000000001',
   'e124a000-0000-4000-8000-000000000001', 'e124f000-0000-4000-8000-000000000001', 'e124d000-0000-4000-8000-000000000002',
   'write_records', 'direct-care', 'active', 'Allergy error test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'e124-grant-0001', 'hid'),
  ('e124c000-0000-4000-8000-000000000002', 'e124b000-0000-4000-8000-000000000001', 'e124e000-0000-4000-8000-000000000001',
   'e124a000-0000-4000-8000-000000000001', 'e124f000-0000-4000-8000-000000000002', 'e124d000-0000-4000-8000-000000000003',
   'write_records', 'direct-care', 'active', 'Allergy error test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'e124-grant-0002', 'hid'),
  ('e124c000-0000-4000-8000-000000000003', 'e124b000-0000-4000-8000-000000000002', 'e124e000-0000-4000-8000-000000000001',
   'e124a000-0000-4000-8000-000000000001', 'e124f000-0000-4000-8000-000000000001', 'e124d000-0000-4000-8000-000000000002',
   'write_records', 'direct-care', 'active', 'Allergy error test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'e124-grant-0003', 'hid'),
  ('e124c000-0000-4000-8000-000000000004', 'e124b000-0000-4000-8000-000000000002', 'e124e000-0000-4000-8000-000000000001',
   'e124a000-0000-4000-8000-000000000001', 'e124f000-0000-4000-8000-000000000002', 'e124d000-0000-4000-8000-000000000003',
   'write_records', 'direct-care', 'active', 'Allergy error test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'e124-grant-0004', 'hid');

set local role hid_ehr_api_runtime;
do $$
declare
  read text;
  row_count integer;
begin
  -- 1. Penicillin recorded at F1.
  perform pg_temp.as_staff('staff:e124-doctor', 'e124f000-0000-4000-8000-000000000001',
    'e124d000-0000-4000-8000-000000000002', 'direct-care', 'e124-record-0001');
  insert into ehr.recorded_allergies (id, patient_id, facility_id, created_by, created_by_membership_id, substance,
    reaction, severity)
  values ('e1241000-0000-4000-8000-000000000001', 'e124b000-0000-4000-8000-000000000001',
    'e124d000-0000-4000-8000-000000000002', 'e124a000-0000-4000-8000-000000000001',
    'e124f000-0000-4000-8000-000000000001', 'Penicillin', 'Anaphylaxis', 'severe');
  -- 1a. The check at F1 reads it (the service then warns for 'Amoxicillin 500 mg').
  read := pg_temp.check_reads('e124b000-0000-4000-8000-000000000001');
  if read <> 'Penicillin (severe, Anaphylaxis)' then
    raise exception '1a: the check at F1 does not read the active Penicillin allergy: "%"', read;
  end if;

  -- 1b. Outside the doctor's context (another purpose of use) the same read gives nothing:
  -- it runs as the runtime role under row-level security, not as the table owner.
  perform pg_temp.as_staff('staff:e124-doctor', 'e124f000-0000-4000-8000-000000000001',
    'e124d000-0000-4000-8000-000000000002', 'healthcare-operations', 'e124-read-0001');
  if pg_temp.check_reads('e124b000-0000-4000-8000-000000000001') <> '' then
    raise exception '1b: the check read allergies outside the doctor''s context';
  end if;

  -- 1c. The check at F2 reads it too: the allergy follows the patient.
  perform pg_temp.as_staff('staff:e124-doctor', 'e124f000-0000-4000-8000-000000000002',
    'e124d000-0000-4000-8000-000000000003', 'direct-care', 'e124-read-0002');
  read := pg_temp.check_reads('e124b000-0000-4000-8000-000000000001');
  if read <> 'Penicillin (severe, Anaphylaxis)' then
    raise exception '1c: the check at F2 does not read F1''s active Penicillin allergy: "%"', read;
  end if;

  -- 1d. F1 marks it entered in error, with the update and change reason the service sends.
  perform pg_temp.as_staff('staff:e124-doctor', 'e124f000-0000-4000-8000-000000000001',
    'e124d000-0000-4000-8000-000000000002', 'direct-care', 'e124-error-0001');
  perform set_config('app.change_reason', 'Recorded on the wrong patient', true);
  update ehr.recorded_allergies
     set status = 'entered_in_error', entered_in_error_by = 'e124a000-0000-4000-8000-000000000001',
         entered_in_error_reason = 'Recorded on the wrong patient', entered_in_error_at = clock_timestamp()
   where id = 'e1241000-0000-4000-8000-000000000001' and patient_id = 'e124b000-0000-4000-8000-000000000001'
     and facility_id = 'e124d000-0000-4000-8000-000000000002' and row_version = 1 and status = 'active';
  get diagnostics row_count = row_count;
  if row_count <> 1 then raise exception '1d: F1 could not mark its allergy entered in error'; end if;

  -- 1e. The check no longer reads it, at F1 or at F2.
  read := pg_temp.check_reads('e124b000-0000-4000-8000-000000000001');
  if read <> '' then
    raise exception '1e: the check at F1 still reads an allergy marked entered in error: "%"', read;
  end if;
  perform pg_temp.as_staff('staff:e124-doctor', 'e124f000-0000-4000-8000-000000000002',
    'e124d000-0000-4000-8000-000000000003', 'direct-care', 'e124-read-0003');
  read := pg_temp.check_reads('e124b000-0000-4000-8000-000000000001');
  if read <> '' then
    raise exception '1e: the check at F2 still reads an allergy marked entered in error at F1: "%"', read;
  end if;
  -- 1f. The allergy is kept, marked: nothing was deleted.
  if (select format('%s|%s', status, row_version) from ehr.recorded_allergies
       where id = 'e1241000-0000-4000-8000-000000000001') is distinct from 'entered_in_error|2' then
    raise exception '1f: the allergy is not kept as entered in error at version 2';
  end if;

  -- 2. Penicillin recorded for patient R at another facility, F2.
  insert into ehr.recorded_allergies (id, patient_id, facility_id, created_by, created_by_membership_id, substance,
    reaction, severity)
  values ('e1241000-0000-4000-8000-000000000002', 'e124b000-0000-4000-8000-000000000002',
    'e124d000-0000-4000-8000-000000000003', 'e124a000-0000-4000-8000-000000000001',
    'e124f000-0000-4000-8000-000000000002', 'Penicillin', 'Anaphylaxis', 'severe');
  -- 2a. The check at F1 reads F2's allergy.
  perform pg_temp.as_staff('staff:e124-doctor', 'e124f000-0000-4000-8000-000000000001',
    'e124d000-0000-4000-8000-000000000002', 'direct-care', 'e124-read-0004');
  read := pg_temp.check_reads('e124b000-0000-4000-8000-000000000002');
  if read <> 'Penicillin (severe, Anaphylaxis)' then
    raise exception '2a: the check at F1 does not read the active Penicillin allergy recorded at F2: "%"', read;
  end if;
  -- 2b. F2 marks it entered in error.
  perform pg_temp.as_staff('staff:e124-doctor', 'e124f000-0000-4000-8000-000000000002',
    'e124d000-0000-4000-8000-000000000003', 'direct-care', 'e124-error-0002');
  perform set_config('app.change_reason', 'Recorded on the wrong patient', true);
  update ehr.recorded_allergies
     set status = 'entered_in_error', entered_in_error_by = 'e124a000-0000-4000-8000-000000000001',
         entered_in_error_reason = 'Recorded on the wrong patient', entered_in_error_at = clock_timestamp()
   where id = 'e1241000-0000-4000-8000-000000000002' and patient_id = 'e124b000-0000-4000-8000-000000000002'
     and facility_id = 'e124d000-0000-4000-8000-000000000003' and row_version = 1 and status = 'active';
  get diagnostics row_count = row_count;
  if row_count <> 1 then raise exception '2b: F2 could not mark its allergy entered in error'; end if;
  -- 2c. The check at F1 no longer reads it, though F1 still sees it, marked.
  perform pg_temp.as_staff('staff:e124-doctor', 'e124f000-0000-4000-8000-000000000001',
    'e124d000-0000-4000-8000-000000000002', 'direct-care', 'e124-read-0005');
  read := pg_temp.check_reads('e124b000-0000-4000-8000-000000000002');
  if read <> '' then
    raise exception '2c: the check at F1 still reads an allergy marked entered in error at F2: "%"', read;
  end if;
  if (select status from ehr.recorded_allergies where id = 'e1241000-0000-4000-8000-000000000002')
       is distinct from 'entered_in_error' then
    raise exception '2c: F1 does not see F2''s allergy as entered in error';
  end if;

  -- 3. For patient P, an active allergy beside the one entered in error is still read, and only it.
  insert into ehr.recorded_allergies (id, patient_id, facility_id, created_by, created_by_membership_id, substance,
    reaction, severity)
  values ('e1241000-0000-4000-8000-000000000003', 'e124b000-0000-4000-8000-000000000001',
    'e124d000-0000-4000-8000-000000000002', 'e124a000-0000-4000-8000-000000000001',
    'e124f000-0000-4000-8000-000000000001', 'Amoxicillin', 'Hives', 'moderate');
  read := pg_temp.check_reads('e124b000-0000-4000-8000-000000000001');
  if read <> 'Amoxicillin (moderate, Hives)' then
    raise exception '3: the check does not read only the one active allergy: "%"', read;
  end if;
end $$;
reset role;

rollback;
