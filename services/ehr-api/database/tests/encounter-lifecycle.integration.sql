\set ON_ERROR_STOP on
-- Clinical records follow their encounter's status (0084). Rollback-only.
--
-- Until 0084 every child create checked only that the encounter existed: a
-- note, vital, diagnosis, prescription, lab request or document could be added
-- to an encounter that was cancelled or entered in error, and a new order to a
-- completed one; an order could be activated on such an encounter; a diagnosis
-- entered in error could be set back to confirmed; and the EHR runtime could
-- overwrite a recorded vital in place. 0084 adds, as SECURITY INVOKER triggers:
--
--   ehr.require_open_encounter(): before a child is inserted, and before an
--   order is activated, it reads the encounter with FOR SHARE and refuses with
--   55000 ENCOUNTER_NOT_OPEN when the encounter is cancelled or entered in
--   error, or when a new order (an insert, or the activation of a draft) is
--   placed on a completed encounter. Late notes, vitals, diagnoses and
--   documents on a completed encounter, and resuming a held order there, stay
--   allowed. An encounter the writer cannot lock is refused with 42501.
--   ehr.keep_entered_in_error_diagnosis(): refuses any update of a diagnosis
--   entered in error (55000 DIAGNOSIS_ENTERED_IN_ERROR).
--   ehr.keep_recorded_vital(): refuses an update of a vital that changes any
--   column but current_correction_no (55000 VITAL_RECORD_IMMUTABLE); the
--   correction flow changes only that column.
--
-- Runtime cases run as hid_ehr_api_runtime with the session the EHR API sets
-- and the API's own statement shapes, so the trigger's share lock is taken
-- under the runtime role's privileges and row-level security. Each case is
-- undone. Fixtures are inserted in replica mode (CHECK constraints still
-- apply). The suite fails at the end listing every case whose outcome
-- ('ok', or 'SQLSTATE: message') or role differs from the expected one.
begin;

-- Each case records the role it ran as.
create temporary table encounter_lifecycle_cases (
  seq serial, area text not null, name text not null, expected text not null, actual text,
  run_as name not null default current_user, primary key (area, name)
) on commit drop;
grant select, insert on encounter_lifecycle_cases to public;
grant usage on sequence encounter_lifecycle_cases_seq_seq to public;

-- Security properties: the three guards are SECURITY INVOKER with a pinned
-- search_path, the open-encounter guard reads the encounter with a share lock,
-- and each trigger is an enabled BEFORE ROW trigger of the right events
-- (tgtype bits: 1 row, 2 before, 4 insert, 16 update).
insert into encounter_lifecycle_cases (area, name, expected, actual)
select 'property', format('%s is SECURITY INVOKER with a pinned search_path', name), 'yes',
       coalesce((select case when not p.prosecdef
                              and p.proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[] then 'yes'
                             else format('definer=%s config=%s', p.prosecdef, p.proconfig) end
                   from pg_proc p where p.oid = to_regprocedure(name)), 'missing')
  from (values ('ehr.require_open_encounter()'), ('ehr.keep_entered_in_error_diagnosis()'),
               ('ehr.keep_recorded_vital()')) guard(name);
insert into encounter_lifecycle_cases (area, name, expected, actual)
select 'property', 'the open-encounter guard share-locks the encounter', 'yes',
       case when to_regprocedure('ehr.require_open_encounter()') is null then 'missing'
            when pg_get_functiondef(to_regprocedure('ehr.require_open_encounter()')) ~* 'from\s+ehr\.encounters\M'
             and pg_get_functiondef(to_regprocedure('ehr.require_open_encounter()')) ~* '\mfor\s+share\M' then 'yes'
            else 'no' end;
insert into encounter_lifecycle_cases (area, name, expected, actual)
select 'property', format('trigger %s on %s', trigger_name, table_name), 'enabled',
       coalesce((select case when t.tgenabled = 'O' and t.tgtype = trigger_type
                               and t.tgfoid = to_regprocedure(function_name) then 'enabled'
                              else format('enabled=%s type=%s function=%s', t.tgenabled, t.tgtype, t.tgfoid::regproc) end
                   from pg_trigger t where t.tgrelid = table_name::regclass and t.tgname = trigger_name
                    and not t.tgisinternal), 'missing')
  from (values ('ehr.clinical_notes', 'clinical_notes_encounter_open', 'ehr.require_open_encounter()', 7),
               ('ehr.vitals', 'vitals_encounter_open', 'ehr.require_open_encounter()', 7),
               ('ehr.diagnoses', 'diagnoses_encounter_open', 'ehr.require_open_encounter()', 7),
               ('ehr.documents', 'documents_encounter_open', 'ehr.require_open_encounter()', 7),
               ('ehr.prescriptions', 'prescriptions_encounter_open', 'ehr.require_open_encounter()', 23),
               ('ehr.lab_requests', 'lab_requests_encounter_open', 'ehr.require_open_encounter()', 23),
               ('ehr.diagnoses', 'diagnoses_entered_in_error_final', 'ehr.keep_entered_in_error_diagnosis()', 19),
               ('ehr.vitals', 'vitals_recorded_values_immutable', 'ehr.keep_recorded_vital()', 19))
       expected(table_name, trigger_name, function_name, trigger_type);

-- Clinic F (ec100000-...02) of one organization; doctor D (account ec110000-...01,
-- staff ec120000-...01, membership ec130000-...01) with a write consent for
-- patient P (ec140000-...01) in F. Encounters of P in F (ec160000-...0n):
--   1 planned   2 in_progress   3 on_hold   4 completed   5 cancelled   6 entered_in_error
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'encounter-lifecycle-test')
on conflict (code) do nothing;
insert into identity.organizations (id, name, slug) values
  ('ec100000-0000-4000-8000-000000000001', 'Encounter Lifecycle Organization', 'encounter-lifecycle-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('ec100000-0000-4000-8000-000000000002', 'ec100000-0000-4000-8000-000000000001', 'Encounter Lifecycle Clinic',
   'ENCOUNTER-LIFECYCLE-F', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('ec110000-0000-4000-8000-000000000001', 'synthetic:encounter-lifecycle-d', 'encounter-lifecycle-d@example.invalid',
   'Encounter Lifecycle Doctor', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('ec120000-0000-4000-8000-000000000001', 'ec110000-0000-4000-8000-000000000001', 'Encounter Lifecycle Doctor',
   'encounter-lifecycle-d@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role) values
  ('ec130000-0000-4000-8000-000000000001', 'ec120000-0000-4000-8000-000000000001',
   'ec110000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000001',
   'ec100000-0000-4000-8000-000000000002', 'doctor', 'doctor');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('ec140000-0000-4000-8000-000000000001', 'HID-ENCLFEAA', 'Lifecycle', 'Patient', 'Lifecycle Patient', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at) values
  ('ec180000-0000-4000-8000-000000000001', 'ec140000-0000-4000-8000-000000000001',
   'ec120000-0000-4000-8000-000000000001', 'ec110000-0000-4000-8000-000000000001',
   'ec130000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002', 'write_records', 'direct-care',
   'active', 'Synthetic encounter lifecycle consent', clock_timestamp() - interval '1 hour',
   clock_timestamp() + interval '30 days');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at, ended_at)
select ('ec160000-0000-4000-8000-00000000000' || n)::uuid, 'ec140000-0000-4000-8000-000000000001',
       'ec100000-0000-4000-8000-000000000002', 'ec110000-0000-4000-8000-000000000001',
       'ec130000-0000-4000-8000-000000000001', 'ambulatory', status, '2026-10-01 08:00:00+00',
       case when status = 'completed' then timestamptz '2026-10-01 09:00:00+00' end
  from (values (1, 'planned'), (2, 'in_progress'), (3, 'on_hold'), (4, 'completed'), (5, 'cancelled'),
               (6, 'entered_in_error')) encounter(n, status);
-- Orders already on those encounters (prescriptions ec170000-..., lab requests
-- ec190000-..., same suffix): suffix <status digit><encounter digit>.
--   12 draft on in_progress    14 draft on completed     15 draft on cancelled
--   16 draft on entered_in_error                          34 on_hold on completed
--   35 on_hold on cancelled
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status)
select ('ec170000-0000-4000-8000-0000000000' || suffix)::uuid, ('ec160000-0000-4000-8000-00000000000' || encounter)::uuid,
       'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
       'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001', 'Amoxicillin 500 mg',
       'Every 8 hours', 'Take after food', status
  from (values ('12', 2, 'draft'), ('14', 4, 'draft'), ('15', 5, 'draft'), ('16', 6, 'draft'),
               ('34', 4, 'on_hold'), ('35', 5, 'on_hold')) existing(suffix, encounter, status);
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status)
select ('ec190000-0000-4000-8000-0000000000' || suffix)::uuid, ('ec160000-0000-4000-8000-00000000000' || encounter)::uuid,
       'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
       'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001', 'http://loinc.org', '718-7',
       'Haemoglobin', 'routine', status
  from (values ('12', 2, 'draft'), ('14', 4, 'draft'), ('15', 5, 'draft'), ('16', 6, 'draft'),
               ('34', 4, 'on_hold'), ('35', 5, 'on_hold')) existing(suffix, encounter, status);
-- Diagnoses (ec1a0000-...): 01 entered in error, 02 confirmed, both on encounter 2.
insert into ehr.diagnoses (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  code_system, code, display, clinical_status, verification_status)
select ('ec1a0000-0000-4000-8000-00000000000' || n)::uuid, 'ec160000-0000-4000-8000-000000000002',
       'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
       'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001', 'http://hl7.org/fhir/sid/icd-10',
       'J18.9', 'Pneumonia, unspecified', 'active', verification
  from (values (1, 'entered_in_error'), (2, 'confirmed')) diagnosis(n, verification);
-- Vital ec1b0000-...01 on encounter 2, never corrected.
insert into ehr.vitals (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  recorded_at, pulse_bpm, systolic_mmhg, diastolic_mmhg) values
  ('ec1b0000-0000-4000-8000-000000000001', 'ec160000-0000-4000-8000-000000000002',
   'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
   'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001', '2026-10-01 08:10:00+00',
   72, 120, 80);
set local session_replication_role = origin;

-- Runs a statement as the current role and undoes it: 'ok', or 'SQLSTATE: message'.
create function pg_temp.lifecycle_try(statement text) returns text language plpgsql as $$
declare outcome text;
begin
  begin
    execute statement;
    raise exception using errcode = 'P0001', message = 'encounter-lifecycle-suite: undo';
  exception when others then
    outcome := case when sqlerrm = 'encounter-lifecycle-suite: undo' then 'ok' else sqlstate || ': ' || sqlerrm end;
  end;
  return outcome;
end $$;
-- The EHR API session of doctor D in F (services/ehr-api/src/database/database.service.ts),
-- with the change reason an update sets (ClinicalRepository.setChangeReason).
create function pg_temp.lifecycle_case(area text, case_name text, expected text, statement text) returns void
language plpgsql as $$
begin
  perform set_config('app.actor_subject', 'synthetic:encounter-lifecycle-d', true),
          set_config('app.facility_id', 'ec100000-0000-4000-8000-000000000002', true),
          set_config('app.correlation_id', 'encounter-lifecycle-suite', true),
          set_config('app.membership_id', 'ec130000-0000-4000-8000-000000000001', true),
          set_config('app.purpose_of_use', 'direct-care', true),
          set_config('app.change_reason', 'Synthetic encounter lifecycle change', true);
  insert into encounter_lifecycle_cases (area, name, expected, actual)
  values (area, case_name, expected, pg_temp.lifecycle_try(statement));
end $$;
-- An encounter of P in F by its digit.
create function pg_temp.lifecycle_encounter(n integer) returns uuid language sql immutable as $$
  select ('ec160000-0000-4000-8000-00000000000' || n)::uuid
$$;
-- The create statements of the EHR services, for patient P in F by doctor D.
create function pg_temp.lifecycle_insert(kind text, encounter uuid) returns text language sql as $$
  select case kind
    when 'note' then format($i$insert into ehr.clinical_notes (encounter_id, patient_id, facility_id, created_by,
        created_by_membership_id, note_type, title, status, signed_at, signed_by)
      values (%L, 'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
        'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001', 'progress',
        'Synthetic note', 'signed', clock_timestamp(), 'ec110000-0000-4000-8000-000000000001')$i$, encounter)
    when 'vital' then format($i$insert into ehr.vitals (encounter_id, patient_id, facility_id, created_by,
        created_by_membership_id, recorded_at, pulse_bpm, source)
      values (%L, 'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
        'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001', clock_timestamp(), 70,
        'manual')$i$, encounter)
    when 'diagnosis' then format($i$insert into ehr.diagnoses (encounter_id, patient_id, facility_id, created_by,
        created_by_membership_id, code_system, code, display, clinical_status, verification_status)
      values (%L, 'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
        'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001',
        'http://hl7.org/fhir/sid/icd-10', 'R50.9', 'Fever, unspecified', 'active', 'provisional')$i$, encounter)
    when 'document' then format($i$insert into ehr.documents (id, encounter_id, patient_id, facility_id, created_by,
        created_by_membership_id, original_file_name, storage_bucket, storage_key, declared_media_type, size_bytes,
        sha256_hex, classification, status, retention_class)
      values (gen_random_uuid(), %L, 'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
        'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001', 'referral.pdf',
        'synthetic-bucket', 'clinical/objects/' || gen_random_uuid(), 'application/pdf', 1024, repeat('a', 64),
        'phi', 'initiated', 'clinical_record')$i$, encounter)
    when 'draft prescription' then format($i$insert into ehr.prescriptions (encounter_id, patient_id, facility_id,
        created_by, created_by_membership_id, medication_display, frequency, instructions, status)
      values (%L, 'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
        'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001', 'Paracetamol 500 mg',
        'Every 6 hours', 'Take with water', 'draft')$i$, encounter)
    when 'active prescription' then format($i$insert into ehr.prescriptions (encounter_id, patient_id, facility_id,
        created_by, created_by_membership_id, medication_display, frequency, instructions, status)
      values (%L, 'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
        'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001', 'Paracetamol 500 mg',
        'Every 6 hours', 'Take with water', 'active')$i$, encounter)
    when 'lab request' then format($i$insert into ehr.lab_requests (encounter_id, patient_id, facility_id,
        created_by, created_by_membership_id, test_code_system, test_code, test_display, priority, status)
      values (%L, 'ec140000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000002',
        'ec110000-0000-4000-8000-000000000001', 'ec130000-0000-4000-8000-000000000001', 'http://loinc.org',
        '2345-7', 'Glucose', 'routine', 'draft')$i$, encounter)
  end
$$;
-- The status update of PrescriptionsService.update and LabRequestsService.update.
create function pg_temp.lifecycle_order_status(order_table text, suffix text, status text) returns text
language sql as $$
  select format($i$update ehr.%I set status = coalesce(%L, status)
      where id = %L and patient_id = 'ec140000-0000-4000-8000-000000000001'
        and facility_id = 'ec100000-0000-4000-8000-000000000002' returning id$i$,
    order_table, status,
    (case order_table when 'prescriptions' then 'ec170000-0000-4000-8000-0000000000'
                      else 'ec190000-0000-4000-8000-0000000000' end) || suffix)
$$;

set local role hid_ehr_api_runtime;

-- Creates: every child on an open encounter; late documentation (not new
-- orders) on a completed one; nothing on a cancelled or entered-in-error one.
select pg_temp.lifecycle_case('create', format('%s on %s %s encounter', kind,
           case when status ~ '^[aeiou]' then 'an' else 'a' end, replace(status, '_', '-')),
         case when status in ('planned', 'in_progress', 'on_hold') then 'ok'
              when status = 'completed' and kind not in ('draft prescription', 'active prescription', 'lab request')
                then 'ok'
              else '55000: ENCOUNTER_NOT_OPEN' end,
         pg_temp.lifecycle_insert(kind, pg_temp.lifecycle_encounter(n)))
  from (values (1, 'planned'), (2, 'in_progress'), (3, 'on_hold'), (4, 'completed'), (5, 'cancelled'),
               (6, 'entered_in_error')) encounter(n, status)
 cross join (values ('note'), ('vital'), ('diagnosis'), ('document'), ('draft prescription'),
                    ('active prescription'), ('lab request')) child(kind)
 order by n, kind;
-- A document without an encounter is not checked.
select pg_temp.lifecycle_case('create', 'document without an encounter', 'ok',
         pg_temp.lifecycle_insert('document', null));

-- Order activation and other status changes.
select pg_temp.lifecycle_case('order', format('%s %s: %s', order_table, suffix, description), expected,
         pg_temp.lifecycle_order_status(order_table, suffix, target))
  from (values ('12', 'active', 'activate a draft on an in-progress encounter', 'ok'),
               ('14', 'active', 'activate a draft on a completed encounter', '55000: ENCOUNTER_NOT_OPEN'),
               ('34', 'active', 'resume a held order on a completed encounter', 'ok'),
               ('15', 'active', 'activate a draft on a cancelled encounter', '55000: ENCOUNTER_NOT_OPEN'),
               ('35', 'active', 'resume a held order on a cancelled encounter', '55000: ENCOUNTER_NOT_OPEN'),
               ('16', 'active', 'activate a draft on an entered-in-error encounter', '55000: ENCOUNTER_NOT_OPEN'),
               ('15', 'cancelled', 'cancel a draft on a cancelled encounter', 'ok'),
               ('16', 'entered_in_error', 'mark a draft on an entered-in-error encounter entered in error', 'ok'))
       change(suffix, target, description, expected)
 cross join (values ('prescriptions'), ('lab_requests')) orders(order_table)
 order by order_table, suffix, target;

-- A diagnosis entered in error stays so (DiagnosesService.update statement shape).
select pg_temp.lifecycle_case('diagnosis', name, expected, format($i$update ehr.diagnoses set
           clinical_status = coalesce(%L, clinical_status), verification_status = coalesce(%L, verification_status),
           notes = coalesce(%L, notes)
         where id = %L and encounter_id = 'ec160000-0000-4000-8000-000000000002'
           and patient_id = 'ec140000-0000-4000-8000-000000000001'
           and facility_id = 'ec100000-0000-4000-8000-000000000002' returning id$i$,
         clinical, verification, notes, diagnosis))
  from (values ('confirm a diagnosis entered in error', 'ec1a0000-0000-4000-8000-000000000001', null, 'confirmed',
                null, '55000: DIAGNOSIS_ENTERED_IN_ERROR'),
               ('annotate a diagnosis entered in error', 'ec1a0000-0000-4000-8000-000000000001', null, null,
                'Synthetic note', '55000: DIAGNOSIS_ENTERED_IN_ERROR'),
               ('resolve a diagnosis entered in error', 'ec1a0000-0000-4000-8000-000000000001', 'resolved', null,
                null, '55000: DIAGNOSIS_ENTERED_IN_ERROR'),
               ('mark a confirmed diagnosis entered in error', 'ec1a0000-0000-4000-8000-000000000002', null,
                'entered_in_error', null, 'ok'),
               ('refute a confirmed diagnosis', 'ec1a0000-0000-4000-8000-000000000002', null, 'refuted', null, 'ok'))
       change(name, diagnosis, clinical, verification, notes, expected);

-- A recorded vital is corrected only through ehr.vital_corrections and
-- current_correction_no (VitalsService.correct statement shape).
select pg_temp.lifecycle_case('vital', name, expected, format($i$update ehr.vitals set %s
         where id = 'ec1b0000-0000-4000-8000-000000000001' and patient_id = 'ec140000-0000-4000-8000-000000000001'
           and facility_id = 'ec100000-0000-4000-8000-000000000002' and row_version = 1 returning id$i$, assignment))
  from (values ('advance the current correction', 'current_correction_no = 1', 'ok'),
               ('overwrite the pulse', 'pulse_bpm = 140', '55000: VITAL_RECORD_IMMUTABLE'),
               ('overwrite the blood pressure', 'systolic_mmhg = 180, diastolic_mmhg = 110',
                '55000: VITAL_RECORD_IMMUTABLE'),
               ('add a measurement', 'oxygen_saturation_percent = 88', '55000: VITAL_RECORD_IMMUTABLE'),
               ('move the recording time', 'recorded_at = recorded_at - interval ''1 hour''',
                '55000: VITAL_RECORD_IMMUTABLE'),
               ('change the source', 'source = ''device''', '55000: VITAL_RECORD_IMMUTABLE'),
               ('move it to another encounter', 'encounter_id = ''ec160000-0000-4000-8000-000000000003''',
                '55000: VITAL_RECORD_IMMUTABLE'))
       change(name, assignment, expected);

reset role;

-- Every runtime case ran as the EHR runtime, and every outcome is the expected one.
do $$
declare
  mismatches text;
begin
  if (select count(*) from encounter_lifecycle_cases) <> 83
     or exists (select 1 from encounter_lifecycle_cases where actual is null) then
    raise exception 'the encounter lifecycle suite did not run every case (% recorded)',
      (select count(*) from encounter_lifecycle_cases);
  end if;
  select string_agg(format('%s / %s: ran as %s', area, name, run_as), E'\n' order by seq)
    into mismatches
    from encounter_lifecycle_cases
   where area <> 'property' and run_as is distinct from 'hid_ehr_api_runtime';
  if mismatches is not null then
    raise exception E'encounter lifecycle cases ran as the wrong role:\n%', mismatches;
  end if;
  select string_agg(format('%s / %s: expected %s, got %s', area, name, expected, actual), E'\n' order by seq)
    into mismatches
    from encounter_lifecycle_cases
   where actual is distinct from expected;
  if mismatches is not null then
    raise exception E'clinical records do not follow their encounter''s status:\n%', mismatches;
  end if;
  raise notice 'encounter lifecycle suite: % cases passed', (select count(*) from encounter_lifecycle_cases);
end $$;

rollback;
