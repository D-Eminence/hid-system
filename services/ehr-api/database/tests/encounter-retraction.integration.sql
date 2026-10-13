\set ON_ERROR_STOP on
-- Retraction respects record permissions, closed orders are final, and vitals
-- can be entered in error (0090). Rollback-only.
--
-- Until 0090:
--   * cancelling an encounter, or marking it entered in error, changed its
--     notes, diagnoses and orders for any membership with a write consent:
--     row-level security checks consent, not role, so a nurse or receptionist
--     could retract a doctor's diagnosis and prescription (ENC-RETRACT-1);
--   * a completed, cancelled or entered-in-error prescription or lab request
--     could still have its instructions, frequency, end date, priority or
--     status rewritten, a cancelled one made active again (RX-FINAL,
--     ORDER-CLOSED-EDIT);
--   * a cancelled or entered-in-error encounter could still have its header
--     edited (ORDER-CLOSED-EDIT);
--   * a vital had no status, so one recorded on the wrong patient could not be
--     retracted (ENC-RETRACT-2).
--
-- 0090 adds, as SECURITY INVOKER triggers with a pinned search_path:
--   ehr.require_retraction_permission(): before an encounter becomes
--     cancelled or entered_in_error, refuses with 42501
--     ENCOUNTER_RETRACTION_NOT_PERMITTED when the encounter holds a record the
--     close would change and the writing membership lacks that record's write
--     permission (auth.membership_has_permission).
--   ehr.keep_closed_encounter(): refuses any update of a cancelled or
--     entered-in-error encounter (55000 ENCOUNTER_NOT_OPEN).
--   ehr.keep_closed_order(): refuses any update of a completed, cancelled or
--     entered-in-error prescription or lab request except a completed one
--     marked entered in error with nothing else changed
--     (55000 PRESCRIPTION_FINAL / LAB_REQUEST_FINAL), and any status change
--     outside the order transitions (55000 INVALID_PRESCRIPTION_TRANSITION /
--     INVALID_LAB_REQUEST_TRANSITION).
--   ehr.keep_recorded_vital() (replaced): also allows a final vital to be
--     marked entered in error, and refuses any change of a vital entered in
--     error (55000 VITAL_ENTERED_IN_ERROR).
--
-- Runtime cases run as hid_ehr_api_runtime with the session the EHR API sets
-- for each actor and the API's own statement shapes. Each case is undone.
-- Fixtures are inserted in replica mode (CHECK constraints still apply). The
-- suite fails at the end listing every case whose outcome ('ok', or
-- 'SQLSTATE: message') or role differs from the expected one.
begin;

create temporary table encounter_retraction_cases (
  seq serial, area text not null, name text not null, expected text not null, actual text,
  run_as name not null default current_user, primary key (area, name)
) on commit drop;
grant select, insert on encounter_retraction_cases to public;
grant usage on sequence encounter_retraction_cases_seq_seq to public;

-- Security properties: each guard is SECURITY INVOKER with a pinned
-- search_path, each trigger is an enabled BEFORE ROW UPDATE trigger whose name
-- sorts before the table's version trigger (so a refused write records no
-- version), and the vital status column is what the services expect.
insert into encounter_retraction_cases (area, name, expected, actual)
select 'property', format('%s is SECURITY INVOKER with a pinned search_path', name), 'yes',
       coalesce((select case when not p.prosecdef
                              and p.proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[] then 'yes'
                             else format('definer=%s config=%s', p.prosecdef, p.proconfig) end
                   from pg_proc p where p.oid = to_regprocedure(name)), 'missing')
  from (values ('ehr.require_retraction_permission()'), ('ehr.keep_closed_encounter()'),
               ('ehr.keep_closed_order()'), ('ehr.keep_recorded_vital()')) guard(name);
insert into encounter_retraction_cases (area, name, expected, actual)
select 'property', format('trigger %s on %s', trigger_name, table_name), 'enabled',
       coalesce((select case when t.tgenabled = 'O' and t.tgtype = 19
                               and t.tgfoid = to_regprocedure(function_name)
                               and t.tgattr::text = coalesce((select a.attnum::text from pg_attribute a
                                     where a.attrelid = t.tgrelid and a.attname = update_of), '')
                               and trigger_name < (select max(v.tgname) from pg_trigger v
                                     where v.tgrelid = t.tgrelid and v.tgname like '%\_versioned') collate "C" then 'enabled'
                              else format('enabled=%s type=%s function=%s columns=%s', t.tgenabled, t.tgtype,
                                          t.tgfoid::regproc, t.tgattr) end
                   from pg_trigger t where t.tgrelid = table_name::regclass and t.tgname = trigger_name
                    and not t.tgisinternal), 'missing')
  from (values ('ehr.encounters', 'encounters_closed_final', 'ehr.keep_closed_encounter()', null),
               ('ehr.encounters', 'encounters_retraction_permission', 'ehr.require_retraction_permission()', 'status'),
               ('ehr.prescriptions', 'prescriptions_closed_final', 'ehr.keep_closed_order()', null),
               ('ehr.lab_requests', 'lab_requests_closed_final', 'ehr.keep_closed_order()', null),
               ('ehr.vitals', 'vitals_recorded_values_immutable', 'ehr.keep_recorded_vital()', null))
       expected(table_name, trigger_name, function_name, update_of);
insert into encounter_retraction_cases (area, name, expected, actual)
select 'property', 'ehr.vitals.status is final by default and only final or entered_in_error',
       'text not null default final; entered_in_error, final',
       coalesce((select format('%s %s default %s; %s', format_type(a.atttypid, a.atttypmod),
                               case when a.attnotnull then 'not null' else 'null' end,
                               (select regexp_replace(pg_get_expr(d.adbin, d.adrelid), '^''(.*)''::text$', '\1')
                                  from pg_attrdef d where d.adrelid = a.attrelid and d.adnum = a.attnum),
                               (select string_agg(m[1], ', ' order by m[1])
                                  from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''(\w+)''', 'g') m
                                 where c.conrelid = a.attrelid and c.contype = 'c' and c.conkey = array[a.attnum]))
                   from pg_attribute a where a.attrelid = 'ehr.vitals'::regclass and a.attname = 'status'
                    and not a.attisdropped), 'missing');
insert into encounter_retraction_cases (area, name, expected, actual)
select 'property', 'the EHR runtime may ask whether a membership holds a permission', 'yes',
       case when to_regprocedure('auth.membership_has_permission(text, uuid, uuid, text)') is null then 'missing'
            when has_function_privilege('hid_ehr_runtime', 'auth.membership_has_permission(text, uuid, uuid, text)',
                                        'execute') then 'yes' else 'no' end;

-- Clinic F (e9000000-...02) of one organization. Doctor D, nurse N and
-- receptionist R (accounts e9100000-...01/02/03, staff e9200000-..., memberships
-- e9300000-..., role assignments e9310000-..., same suffix), each holding the
-- seeded role of that name at F and a write consent for patient P
-- (e9400000-...01). Encounters of P in F (e9600000-...nn):
--   01 in_progress: signed note, confirmed diagnosis, draft prescription, final vital
--   02 in_progress: signed note, final vital
--   03 planned: nothing
--   04 in_progress: active prescription
--   05 in_progress: draft lab request
--   06 cancelled   07 entered_in_error
--   08 completed: completed prescription
--   09 in_progress: uploaded document
--   10 in_progress: the orders and vitals of the finality cases
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'encounter-retraction-test')
on conflict (code) do nothing;
insert into identity.organizations (id, name, slug) values
  ('e9000000-0000-4000-8000-000000000001', 'Encounter Retraction Organization', 'encounter-retraction-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e9000000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-000000000001', 'Encounter Retraction Clinic',
   'ENCOUNTER-RETRACTION-F', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e9100000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:encounter-retraction-' || role,
       'encounter-retraction-' || role || '@example.invalid', 'Encounter Retraction ' || initcap(role), 'active'
  from (values (1, 'doctor'), (2, 'nurse'), (3, 'receptionist')) actor(n, role);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e9200000-0000-4000-8000-00000000000' || n)::uuid, ('e9100000-0000-4000-8000-00000000000' || n)::uuid,
       'Encounter Retraction ' || initcap(role), 'encounter-retraction-' || role || '@example.invalid', 'verified', role
  from (values (1, 'doctor'), (2, 'nurse'), (3, 'receptionist')) actor(n, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role)
select ('e9300000-0000-4000-8000-00000000000' || n)::uuid, ('e9200000-0000-4000-8000-00000000000' || n)::uuid,
       ('e9100000-0000-4000-8000-00000000000' || n)::uuid, 'e9000000-0000-4000-8000-000000000001',
       'e9000000-0000-4000-8000-000000000002', role, role
  from (values (1, 'doctor'), (2, 'nurse'), (3, 'receptionist')) actor(n, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e9310000-0000-4000-8000-00000000000' || n)::uuid, ('e9100000-0000-4000-8000-00000000000' || n)::uuid, role,
       'facility', ('e9300000-0000-4000-8000-00000000000' || n)::uuid, 'e9000000-0000-4000-8000-000000000002',
       'Synthetic encounter retraction role'
  from (values (1, 'doctor'), (2, 'nurse'), (3, 'receptionist')) actor(n, role);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e9400000-0000-4000-8000-000000000001', 'HID-ENCRTRAA', 'Retraction', 'Patient', 'Retraction Patient', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select ('e9500000-0000-4000-8000-00000000000' || n)::uuid, 'e9400000-0000-4000-8000-000000000001',
       ('e9200000-0000-4000-8000-00000000000' || n)::uuid, ('e9100000-0000-4000-8000-00000000000' || n)::uuid,
       ('e9300000-0000-4000-8000-00000000000' || n)::uuid, 'e9000000-0000-4000-8000-000000000002', 'write_records',
       'direct-care', 'active', 'Synthetic encounter retraction consent', clock_timestamp() - interval '1 hour',
       clock_timestamp() + interval '30 days'
  from generate_series(1, 3) n;
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at, ended_at)
select ('e9600000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'e9400000-0000-4000-8000-000000000001',
       'e9000000-0000-4000-8000-000000000002', 'e9100000-0000-4000-8000-000000000001',
       'e9300000-0000-4000-8000-000000000001', 'ambulatory', status, '2026-10-01 08:00:00+00',
       case when status = 'completed' then timestamptz '2026-10-01 09:00:00+00' end
  from (values (1, 'in_progress'), (2, 'in_progress'), (3, 'planned'), (4, 'in_progress'), (5, 'in_progress'),
               (6, 'cancelled'), (7, 'entered_in_error'), (8, 'completed'), (9, 'in_progress'), (10, 'in_progress'))
       encounter(n, status);
insert into ehr.clinical_notes (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  note_type, title, status, signed_at, signed_by)
select ('e9700000-0000-4000-8000-00000000000' || n)::uuid, ('e9600000-0000-4000-8000-00000000000' || n)::uuid,
       'e9400000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000002',
       'e9100000-0000-4000-8000-000000000001', 'e9300000-0000-4000-8000-000000000001', 'progress',
       'Synthetic signed note', 'signed', '2026-10-01 08:30:00+00', 'e9100000-0000-4000-8000-000000000001'
  from generate_series(1, 2) n;
insert into ehr.diagnoses (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  code_system, code, display, clinical_status, verification_status) values
  ('e9800000-0000-4000-8000-000000000001', 'e9600000-0000-4000-8000-000000000001',
   'e9400000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000002',
   'e9100000-0000-4000-8000-000000000001', 'e9300000-0000-4000-8000-000000000001', 'http://hl7.org/fhir/sid/icd-10',
   'J18.9', 'Pneumonia, unspecified', 'active', 'confirmed');
-- Vitals (e9900000-...nn): 01 on encounter 1, 02 on encounter 2, final; on
-- encounter 10, 11 final and 12 entered in error.
insert into ehr.vitals (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  recorded_at, pulse_bpm)
select ('e9900000-0000-4000-8000-0000000000' || suffix)::uuid,
       ('e9600000-0000-4000-8000-0000000000' || lpad(encounter::text, 2, '0'))::uuid,
       'e9400000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000002',
       'e9100000-0000-4000-8000-000000000001', 'e9300000-0000-4000-8000-000000000001', '2026-10-01 08:10:00+00', 72
  from (values ('01', 1), ('02', 2), ('11', 10), ('12', 10)) vital(suffix, encounter);
-- Without 0090 there is no status to set, and the cases below report it.
do $$
begin
  if exists (select 1 from pg_attribute where attrelid = 'ehr.vitals'::regclass and attname = 'status'
              and not attisdropped) then
    execute $u$update ehr.vitals set status = 'entered_in_error' where id = 'e9900000-0000-4000-8000-000000000012'$u$;
  end if;
end $$;
-- Orders (prescriptions e9a00000-..., lab requests e9b00000-..., same suffix):
--   01 draft on 1   04 active on 4   05 draft lab request on 5   08 completed on 8
--   on encounter 10: 11 completed, 12 cancelled, 13 entered_in_error, 14 active, 15 draft, 16 on_hold
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status)
select ('e9a00000-0000-4000-8000-0000000000' || suffix)::uuid,
       ('e9600000-0000-4000-8000-0000000000' || lpad(encounter::text, 2, '0'))::uuid,
       'e9400000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000002',
       'e9100000-0000-4000-8000-000000000001', 'e9300000-0000-4000-8000-000000000001', 'Amoxicillin 500 mg',
       'Every 8 hours', 'Take after food', status
  from (values ('01', 1, 'draft'), ('04', 4, 'active'), ('08', 8, 'completed'), ('11', 10, 'completed'),
               ('12', 10, 'cancelled'), ('13', 10, 'entered_in_error'), ('14', 10, 'active'), ('15', 10, 'draft'),
               ('16', 10, 'on_hold')) existing(suffix, encounter, status);
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status)
select ('e9b00000-0000-4000-8000-0000000000' || suffix)::uuid,
       ('e9600000-0000-4000-8000-0000000000' || lpad(encounter::text, 2, '0'))::uuid,
       'e9400000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000002',
       'e9100000-0000-4000-8000-000000000001', 'e9300000-0000-4000-8000-000000000001', 'http://loinc.org', '718-7',
       'Haemoglobin', 'routine', status
  from (values ('05', 5, 'draft'), ('11', 10, 'completed'), ('12', 10, 'cancelled'), ('13', 10, 'entered_in_error'),
               ('14', 10, 'active'), ('15', 10, 'draft'), ('16', 10, 'on_hold')) existing(suffix, encounter, status);
insert into ehr.documents (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  original_file_name, storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex,
  classification, status, retention_class) values
  ('e9c00000-0000-4000-8000-000000000009', 'e9600000-0000-4000-8000-000000000009',
   'e9400000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000002',
   'e9100000-0000-4000-8000-000000000001', 'e9300000-0000-4000-8000-000000000001', 'referral.pdf',
   'synthetic-bucket', 'clinical/objects/encounter-retraction-09', 'synthetic-version-09', 'application/pdf', 1024,
   repeat('b', 64), 'phi', 'uploaded', 'clinical_record');
set local session_replication_role = origin;

-- Runs a statement as the current role and undoes it: 'ok', or 'SQLSTATE: message'.
create function pg_temp.retraction_try(statement text) returns text language plpgsql as $$
declare outcome text;
begin
  begin
    execute statement;
    raise exception using errcode = 'P0001', message = 'encounter-retraction-suite: undo';
  exception when others then
    outcome := case when sqlerrm = 'encounter-retraction-suite: undo' then 'ok' else sqlstate || ': ' || sqlerrm end;
  end;
  return outcome;
end $$;
-- The EHR API session of an actor in F (services/ehr-api/src/database/database.service.ts),
-- with the change reason an update sets (ClinicalRepository.setChangeReason).
create function pg_temp.retraction_case(area text, case_name text, actor text, expected text, statement text)
returns void language plpgsql as $$
declare n integer := case actor when 'doctor' then 1 when 'nurse' then 2 when 'receptionist' then 3 end;
begin
  perform set_config('app.actor_subject', 'synthetic:encounter-retraction-' || actor, true),
          set_config('app.facility_id', 'e9000000-0000-4000-8000-000000000002', true),
          set_config('app.correlation_id', 'encounter-retraction-suite', true),
          set_config('app.membership_id', 'e9300000-0000-4000-8000-00000000000' || n, true),
          set_config('app.purpose_of_use', 'direct-care', true),
          set_config('app.change_reason', 'Synthetic encounter retraction change', true);
  insert into encounter_retraction_cases (area, name, expected, actual)
  values (area, case_name, expected, pg_temp.retraction_try(statement));
end $$;
-- The EncountersService.update statement for an encounter of P in F by its number.
create function pg_temp.retraction_encounter(n integer, status text, ended_at text, chief_complaint text) returns text
language sql as $$
  select format($i$update ehr.encounters set status = coalesce(%L, status),
      ended_at = coalesce(%L::timestamptz, ended_at), chief_complaint = coalesce(%L, chief_complaint)
    where id = %L and patient_id = 'e9400000-0000-4000-8000-000000000001'
      and facility_id = 'e9000000-0000-4000-8000-000000000002' and row_version = 1 returning id$i$,
    status, ended_at, chief_complaint, ('e9600000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid)
$$;

set local role hid_ehr_api_runtime;

-- Cancelling or retracting an encounter needs the write permission of every
-- record the close changes; an encounter with no such record needs only the
-- encounter write the route already checks.
select pg_temp.retraction_case('retraction', format('%s %s encounter %s (%s)', actor, verb, n, holds), actor, expected,
         pg_temp.retraction_encounter(n, target, case when target = 'completed' then '2026-10-01 09:00:00+00' end, null))
  from (values
    (1, 'nurse', 'entered_in_error', 'a diagnosis and a draft prescription', '42501: ENCOUNTER_RETRACTION_NOT_PERMITTED'),
    (1, 'receptionist', 'entered_in_error', 'a diagnosis and a draft prescription', '42501: ENCOUNTER_RETRACTION_NOT_PERMITTED'),
    (1, 'doctor', 'entered_in_error', 'a diagnosis and a draft prescription', 'ok'),
    (1, 'nurse', 'cancelled', 'a draft prescription', '42501: ENCOUNTER_RETRACTION_NOT_PERMITTED'),
    (2, 'nurse', 'entered_in_error', 'a note and a vital', 'ok'),
    (2, 'receptionist', 'entered_in_error', 'a note and a vital', '42501: ENCOUNTER_RETRACTION_NOT_PERMITTED'),
    (2, 'receptionist', 'cancelled', 'no open order', 'ok'),
    (3, 'receptionist', 'cancelled', 'nothing', 'ok'),
    (3, 'receptionist', 'entered_in_error', 'nothing', 'ok'),
    (4, 'receptionist', 'cancelled', 'an active prescription', '42501: ENCOUNTER_RETRACTION_NOT_PERMITTED'),
    (4, 'nurse', 'cancelled', 'an active prescription', '42501: ENCOUNTER_RETRACTION_NOT_PERMITTED'),
    (4, 'doctor', 'cancelled', 'an active prescription', 'ok'),
    -- No role holds ehr.lab-request.write since 0084.
    (5, 'doctor', 'entered_in_error', 'a draft lab request', '42501: ENCOUNTER_RETRACTION_NOT_PERMITTED'),
    (5, 'doctor', 'cancelled', 'a draft lab request', '42501: ENCOUNTER_RETRACTION_NOT_PERMITTED'),
    (8, 'doctor', 'entered_in_error', 'a completed prescription', 'ok'),
    (8, 'nurse', 'entered_in_error', 'a completed prescription', '42501: ENCOUNTER_RETRACTION_NOT_PERMITTED'),
    (9, 'nurse', 'entered_in_error', 'an uploaded document', 'ok'),
    (9, 'receptionist', 'entered_in_error', 'an uploaded document', '42501: ENCOUNTER_RETRACTION_NOT_PERMITTED'),
    -- Holding, resuming and completing close nothing and need no record permission.
    (1, 'receptionist', 'on_hold', 'a diagnosis and a draft prescription', 'ok'),
    (4, 'receptionist', 'completed', 'an active prescription', 'ok'))
  as change(n, actor, target, holds, expected)
  cross join lateral (select case target when 'entered_in_error' then 'marks entered in error'
                                         when 'cancelled' then 'cancels' when 'on_hold' then 'holds'
                                         else 'completes' end as verb) wording;

-- A cancelled or entered-in-error encounter takes no further change; a completed
-- one keeps taking late header corrections.
select pg_temp.retraction_case('closed encounter', name, 'doctor', expected, pg_temp.retraction_encounter(n, target, ended, complaint))
  from (values
    ('edit the chief complaint of cancelled encounter 6', 6, null, null, 'Rewritten complaint', '55000: ENCOUNTER_NOT_OPEN'),
    ('reopen cancelled encounter 6', 6, 'in_progress', null, null, '55000: ENCOUNTER_NOT_OPEN'),
    ('edit the end time of entered-in-error encounter 7', 7, null, '2026-10-01 10:00:00+00', null, '55000: ENCOUNTER_NOT_OPEN'),
    ('send entered-in-error encounter 7 its own status', 7, 'entered_in_error', null, null, '55000: ENCOUNTER_NOT_OPEN'),
    ('edit the chief complaint of completed encounter 8', 8, null, null, 'Late clarification', 'ok'))
  as change(name, n, target, ended, complaint, expected);

-- The retraction's own statements (EncountersService.closeRecords) on the
-- records ENC-RETRACT-2 adds: vitals, completed orders, linked documents.
select pg_temp.retraction_case('cascade', name, 'doctor', 'ok', format($i$update ehr.%I set %I = 'entered_in_error'
           where encounter_id = %L and patient_id = 'e9400000-0000-4000-8000-000000000001'
             and facility_id = 'e9000000-0000-4000-8000-000000000002' and %I = any(%L::text[]) returning id$i$,
         table_name, 'status', ('e9600000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'status', statuses))
  from (values ('final vitals of encounter 2', 'vitals', 2, '{final}'),
               ('the completed prescription of encounter 8', 'prescriptions', 8, '{draft,active,on_hold,completed}'),
               ('the uploaded document of encounter 9', 'documents', 9, '{initiated,uploaded}'))
       as retracted(name, table_name, n, statuses);

-- Closed orders are final; status changes follow the order transitions
-- (PrescriptionsService.update and LabRequestsService.update statement shapes).
select pg_temp.retraction_case('order', format('%s %s: %s', order_table, suffix, description), 'doctor',
         case when expected like '55000: %' then replace(expected, 'ORDER', upper(rtrim(order_table, 's')))
              else expected end,
         case order_table
           when 'prescriptions' then format($i$update ehr.prescriptions set status = coalesce(%L, status),
               frequency = coalesce(%L, frequency), instructions = coalesce(%L, instructions),
               ends_on = coalesce(%L::date, ends_on)
             where id = %L and encounter_id = 'e9600000-0000-4000-8000-000000000010'
               and patient_id = 'e9400000-0000-4000-8000-000000000001'
               and facility_id = 'e9000000-0000-4000-8000-000000000002' and row_version = 1 returning id$i$,
             target, null, text_change, date_change, ('e9a00000-0000-4000-8000-0000000000' || suffix)::uuid)
           else format($i$update ehr.lab_requests set priority = coalesce(%L, priority), status = coalesce(%L, status),
               clinical_information = coalesce(%L, clinical_information)
             where id = %L and encounter_id = 'e9600000-0000-4000-8000-000000000010'
               and patient_id = 'e9400000-0000-4000-8000-000000000001'
               and facility_id = 'e9000000-0000-4000-8000-000000000002' and row_version = 1 returning id$i$,
             case when date_change is not null then 'stat' end, target, text_change,
             ('e9b00000-0000-4000-8000-0000000000' || suffix)::uuid)
         end)
  from (values
    ('11', null, 'Rewritten text', null, 'change the text of a completed order', '55000: ORDER_FINAL'),
    ('12', null, 'Rewritten text', null, 'change the text of a cancelled order', '55000: ORDER_FINAL'),
    ('13', null, 'Rewritten text', null, 'change the text of an order entered in error', '55000: ORDER_FINAL'),
    ('12', null, null, '2026-09-01', 'change the end date or priority of a cancelled order', '55000: ORDER_FINAL'),
    ('12', 'active', null, null, 'make a cancelled order active again', '55000: ORDER_FINAL'),
    ('13', 'draft', null, null, 'make an order entered in error a draft again', '55000: ORDER_FINAL'),
    ('11', 'active', null, null, 'make a completed order active again', '55000: ORDER_FINAL'),
    ('11', 'completed', null, null, 'send a completed order its own status', '55000: ORDER_FINAL'),
    ('11', 'entered_in_error', 'Rewritten text', null, 'mark a completed order entered in error and change its text',
     '55000: ORDER_FINAL'),
    ('11', 'entered_in_error', null, null, 'mark a completed order entered in error', 'ok'),
    ('14', 'draft', null, null, 'make an active order a draft', '55000: INVALID_ORDER_TRANSITION'),
    ('15', 'completed', null, null, 'complete a draft order', '55000: INVALID_ORDER_TRANSITION'),
    ('16', 'completed', null, null, 'complete an on-hold order', '55000: INVALID_ORDER_TRANSITION'),
    ('15', 'on_hold', null, null, 'hold a draft order', '55000: INVALID_ORDER_TRANSITION'),
    ('14', null, 'Take with water', null, 'change the text of an active order', 'ok'),
    ('14', 'completed', null, null, 'complete an active order', 'ok'),
    ('14', 'on_hold', null, null, 'hold an active order', 'ok'),
    ('16', 'active', null, null, 'resume an on-hold order', 'ok'),
    ('15', 'entered_in_error', null, null, 'mark a draft order entered in error', 'ok'),
    ('16', 'cancelled', null, null, 'cancel an on-hold order', 'ok'))
  as change(suffix, target, text_change, date_change, description, expected)
  cross join (values ('prescriptions'), ('lab_requests')) orders(order_table);

-- A vital is entered in error only from final, and then takes no change
-- (VitalsService.markEnteredInError and VitalsService.correct statement shapes).
select pg_temp.retraction_case('vital', name, 'nurse', expected, format($i$update ehr.vitals set %s
         where id = %L and encounter_id = 'e9600000-0000-4000-8000-000000000010'
           and patient_id = 'e9400000-0000-4000-8000-000000000001'
           and facility_id = 'e9000000-0000-4000-8000-000000000002' and row_version = 1 returning id$i$,
         assignment, ('e9900000-0000-4000-8000-0000000000' || suffix)::uuid))
  from (values
    ('mark a final vital entered in error', '11', 'status = ''entered_in_error''', 'ok'),
    ('advance the correction of a final vital', '11', 'current_correction_no = 1', 'ok'),
    ('overwrite the pulse of a final vital', '11', 'pulse_bpm = 140', '55000: VITAL_RECORD_IMMUTABLE'),
    ('mark a final vital entered in error and overwrite its pulse', '11',
     'status = ''entered_in_error'', pulse_bpm = 140', '55000: VITAL_RECORD_IMMUTABLE'),
    ('give a final vital an unknown status', '11', 'status = ''amended''', '55000: VITAL_RECORD_IMMUTABLE'),
    ('correct a vital entered in error', '12', 'current_correction_no = 1', '55000: VITAL_ENTERED_IN_ERROR'),
    ('make a vital entered in error final again', '12', 'status = ''final''', '55000: VITAL_ENTERED_IN_ERROR'))
  as change(name, suffix, assignment, expected);

reset role;

-- Every runtime case ran as the EHR runtime, and every outcome is the expected one.
do $$
declare
  mismatches text;
begin
  if (select count(*) from encounter_retraction_cases) <> 86
     or exists (select 1 from encounter_retraction_cases where actual is null) then
    raise exception 'the encounter retraction suite did not run every case (% recorded)',
      (select count(*) from encounter_retraction_cases);
  end if;
  select string_agg(format('%s / %s: ran as %s', area, name, run_as), E'\n' order by seq)
    into mismatches
    from encounter_retraction_cases
   where area <> 'property' and run_as is distinct from 'hid_ehr_api_runtime';
  if mismatches is not null then
    raise exception E'encounter retraction cases ran as the wrong role:\n%', mismatches;
  end if;
  select string_agg(format('%s / %s: expected %s, got %s', area, name, expected, actual), E'\n' order by seq)
    into mismatches
    from encounter_retraction_cases
   where actual is distinct from expected;
  if mismatches is not null then
    raise exception E'encounter retraction, order finality or vital retraction is not enforced:\n%', mismatches;
  end if;
  raise notice 'encounter retraction suite: % cases passed', (select count(*) from encounter_retraction_cases);
end $$;

rollback;
