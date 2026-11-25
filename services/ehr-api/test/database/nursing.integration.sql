\set ON_ERROR_STOP on
-- 0174-0177 (NUR-1, Release D; owner decisions of 25 November 2026 at the
-- recommended options): the observation chart fields on vitals, inpatient
-- medicine orders and the medicine round, nursing tasks, fluid balance,
-- clinical shifts and assignments, and shift handover. Rollback-only. The
-- functions run as ehr-api's login role (hid_ehr_api_runtime), and ward-team
-- access as identity-api's (hid_identity_api_runtime), each in the context its
-- service's transactions set. Needs 0001-0153, BILL-1's 0162-0167, ED-1's
-- 0168-0169, ADT-1's 0170-0173 and 0174-0177 applied and the runtime roles
-- bootstrapped. The session's time zone is set to New York so every Lagos-time
-- rule is shown not to depend on it. Fictional people, places and identifiers
-- only; ids start a174.
--
--   1. vitals with each new field alone; the oxygen and GCS rules; a
--      correction of new fields; entered in error still works;
--   2. the observation chart: chart access, entered-in-error readings marked,
--      the hourly grid with the fluid running balance, no score anywhere;
--   3. inpatient schedules: refused on an outpatient visit, each kind's shape,
--      sorted times, never changed after creation, STAT sets the priority,
--      0148's trigger still the last AFTER UPDATE trigger;
--   4. due doses across midnight and on the schedule's first day, in Lagos
--      time;
--   5. the medicine round: each outcome and its reasons, one record per
--      scheduled dose, a dose before dispensing needs a source, dose differs
--      and as-needed overrides need reasons, late and recorded-late marks,
--      entered in error frees the dose, a stopped order, the ward round's
--      names and medicines hidden without chart access;
--   6. tasks: the flow, repeats, cancel at discharge, the completion record
--      hidden without chart access;
--   7. fluid balance: totals per hour, shift and fluid day (with the
--      facility's start hour), unmeasured entries never counted, entered in
--      error removed from totals;
--   8. shifts across midnight, the 8-shift limit, one nurse in charge and one
--      on-call doctor, one nurse per patient per shift, the ICU warning;
--   9. handover: notes as clinical notes, revisions, give and accept, only the
--      next shift's nurse accepts; who is told of a critical result (Q194);
--      ward-team access for an allocated nurse (on in this test only);
--  10. replays, reused keys, version conflicts, another facility, the
--      runtime cannot read the tables or run the helpers;
--  11. audit: no medicine name, dose, value, note text, task name or reason
--      text in any nursing audit row.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs. (Two sessions recording one dose at once is in
-- nursing.pg.spec.ts.)

begin;
set local timezone = 'America/New_York';

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'nur-test'),
  ('healthcare-operations', 'Healthcare operations', 'nur-test')
  on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('a1740000-0000-4000-8000-000000000001', 'Nursing Group A', 'nursing-group-a'),
  ('a1740000-0000-4000-8000-000000000011', 'Nursing Group B', 'nursing-group-b');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('a1740000-0000-4000-8000-000000000002', 'a1740000-0000-4000-8000-000000000001', 'Nursing Hospital A',
   'NUR-A', 'Africa/Lagos', true, 'verified'),
  ('a1740000-0000-4000-8000-000000000012', 'a1740000-0000-4000-8000-000000000011', 'Nursing Hospital B',
   'NUR-B', 'Africa/Lagos', true, 'verified');
create temporary table n_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into n_members values
  (1, 'a1740000-0000-4000-8000-000000000002', 'a1740000-0000-4000-8000-000000000001', 'nurse', 'Ifeoma Nurseone'),
  (2, 'a1740000-0000-4000-8000-000000000002', 'a1740000-0000-4000-8000-000000000001', 'doctor', 'Tunde Doctortwo'),
  (3, 'a1740000-0000-4000-8000-000000000002', 'a1740000-0000-4000-8000-000000000001', 'clinician', 'Kemi Clinthree'),
  (4, 'a1740000-0000-4000-8000-000000000002', 'a1740000-0000-4000-8000-000000000001', 'admin', 'Sola Adminfour'),
  (5, 'a1740000-0000-4000-8000-000000000002', 'a1740000-0000-4000-8000-000000000001', 'receptionist', 'Femi Deskfive'),
  (7, 'a1740000-0000-4000-8000-000000000012', 'a1740000-0000-4000-8000-000000000011', 'nurse', 'Bola Othernurse'),
  (8, 'a1740000-0000-4000-8000-000000000002', 'a1740000-0000-4000-8000-000000000001', 'nurse', 'Uche Floateight');
insert into auth.accounts (id, subject, email, display_name, status)
select ('a1740100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:nur-member-' || n,
  'nur-member-' || n || '@example.invalid', name, 'active' from n_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('a1740200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('a1740100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'nur-member-' || n || '@example.invalid', 'verified', role_code from n_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('a1740300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('a1740200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('a1740100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, organization, facility, role_code, role_code,
  true, true
from n_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('a1740100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
  ('a1740300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, facility, 'Synthetic nursing suite role'
from n_members;
-- Patients p1-p8 (odd male, even female). p6 has an outpatient visit only.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
select ('a1740400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  'HID-NU' || translate(lpad(n::text, 2, '0'), '0123456789', 'ABCDEFGHJK') || 'QQ', 'Pat', 'Nursingperson' || n,
  'Pat Nursingperson' || n, case when n % 2 = 0 then 'female' else 'male' end, date '1975-01-01' + n * 300, 'active', 'hid'
from generate_series(1, 8) n;
-- Chart grants (write, direct care, an hour): the doctor (2) and clinician (3) for every patient; nurse 1 for p1 and
-- p2 only; nurse 8 has none.
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass)
select gen_random_uuid(), null, ('a1740400-0000-4000-8000-0000000000' || lpad(p::text, 2, '0'))::uuid,
  ('a1740200-0000-4000-8000-0000000000' || lpad(m::text, 2, '0'))::uuid,
  ('a1740100-0000-4000-8000-0000000000' || lpad(m::text, 2, '0'))::uuid,
  ('a1740300-0000-4000-8000-0000000000' || lpad(m::text, 2, '0'))::uuid, 'a1740000-0000-4000-8000-000000000002',
  'write_records', 'direct-care', 'active', 'Synthetic nursing suite grant', now() - interval '5 minutes',
  now() + interval '1 hour', false
from (select p, m from generate_series(1, 8) p cross join (values (2), (3)) member(m)
      union all select p, 1 from generate_series(1, 2) p) granted;
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, created_at) values
  ('a1740800-0000-4000-8000-000000000006', 'a1740400-0000-4000-8000-000000000006', 'a1740000-0000-4000-8000-000000000002',
   'a1740100-0000-4000-8000-000000000002', 'a1740300-0000-4000-8000-000000000002', 'ambulatory', 'in_progress',
   now() - interval '1 hour', now() - interval '1 hour');
set local session_replication_role = origin;

create temporary table n_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
create temporary table n_refs (name text primary key, value text) on commit drop;
grant select, insert on pg_temp.n_outcomes to hid_ehr_api_runtime, hid_identity_api_runtime;
grant usage on sequence pg_temp.n_outcomes_seq_seq to hid_ehr_api_runtime, hid_identity_api_runtime;
grant select, insert, update on pg_temp.n_refs to hid_ehr_api_runtime, hid_identity_api_runtime;
grant select on pg_temp.n_members to hid_ehr_api_runtime, hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.n_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.member(n integer) returns uuid language sql immutable as $f$
  select ('a1740300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.account(n integer) returns uuid language sql immutable as $f$
  select ('a1740100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.patient(n integer) returns uuid language sql immutable as $f$
  select ('a1740400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.as_member(n integer, purpose text default 'direct-care') returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:nur-member-' || n, true),
    set_config('app.membership_id', pg_temp.member(n)::text, true),
    set_config('app.facility_id', (select facility::text from pg_temp.n_members where n_members.n = as_member.n), true),
    set_config('app.correlation_id', 'nur-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.vitals_status', '0142', true),
    set_config('app.change_reason', 'Synthetic nursing suite change', true);
$f$;
create function pg_temp.key(label text) returns text language sql immutable as $f$
  select 'nursing-suite-key-' || label
$f$;
create function pg_temp.sha(label text) returns text language sql immutable as $f$
  select encode(sha256(convert_to(label, 'UTF8')), 'hex')
$f$;
create function pg_temp.remember(ref_name text, ref_value text) returns text language sql as $f$
  insert into pg_temp.n_refs (name, value) values (ref_name, ref_value)
    on conflict (name) do update set value = excluded.value returning value
$f$;
create function pg_temp.ref(ref_name text) returns text language sql as $f$
  select value from pg_temp.n_refs where name = ref_name
$f$;
create function pg_temp.run(n integer, statement text, purpose text default 'direct-care') returns jsonb
language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n, purpose);
  execute statement into answer;
  return answer;
exception when others then
  return jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
end
$f$;
create function pg_temp.o(answer jsonb) returns text language sql immutable as $f$
  select coalesce(answer->>'error', (case when (answer->>'replayed')::boolean then 'replayed:' else '' end)
    || coalesce(answer->>'outcome', '(none)'))
$f$;
-- (The suite's own lookups read the tables as the suite's owner, not as a runtime.)
create function pg_temp.ward(ward_name text) returns uuid language sql security definer as $f$
  select id from ehr.wards where name = ward_name and facility_id = 'a1740000-0000-4000-8000-000000000002' and active
$f$;
create function pg_temp.bed(ward_name text, bed_name text) returns uuid language sql security definer as $f$
  select bed.id from ehr.beds bed join ehr.wards ward on ward.id = bed.ward_id
   where ward.name = ward_name and bed.name = bed_name and ward.facility_id = 'a1740000-0000-4000-8000-000000000002'
$f$;
create function pg_temp.adm(p integer) returns uuid language sql security definer as $f$
  select id from ehr.admissions where patient_id = pg_temp.patient(p) order by requested_at desc, id desc limit 1
$f$;
create function pg_temp.adm_version(p integer) returns bigint language sql security definer as $f$
  select row_version from ehr.admissions where id = pg_temp.adm(p)
$f$;
create function pg_temp.enc(p integer) returns uuid language sql security definer as $f$
  select encounter_id from ehr.admissions where id = pg_temp.adm(p)
$f$;
create function pg_temp.lagos_today() returns date language sql stable as $f$
  select (clock_timestamp() at time zone 'Africa/Lagos')::date
$f$;
-- A prescription written by the doctor (2) on a visit, as ehr-api's INSERT writes it, with the schedule columns.
create function pg_temp.rx(encounter uuid, p integer, display text, kind text, times text[], first_due timestamptz,
  as_needed text default null, gap integer default null, most integer default null, rate numeric default null,
  dose numeric default 1, unit text default 'g', route text default 'IV') returns jsonb language plpgsql as $f$
begin
  return pg_temp.run(2, format($s$with written as (
      insert into ehr.prescriptions (encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
        medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, status, schedule_kind,
        scheduled_times, first_due_at, as_needed_reason, as_needed_min_interval_minutes, as_needed_max_doses_per_24h,
        infusion_rate_ml_per_hour, infusion_volume_ml, infusion_fluid)
      values (%L, %L, 'a1740000-0000-4000-8000-000000000002', %L, %L, %L, %s, %L, %L, 'as scheduled', 'Fictional',
        'active', %L, %L::text[], %L::timestamptz, %L, %s, %s, %s, %s, %L)
      returning id, priority) select jsonb_build_object('outcome', 'created', 'id', id, 'priority', priority)
      from written$s$, encounter, pg_temp.patient(p), pg_temp.account(2), pg_temp.member(2), display, dose, unit, route,
    kind, times, first_due, as_needed, coalesce(gap::text, 'null'), coalesce(most::text, 'null'),
    coalesce(rate::text, 'null'), case when rate is null then 'null' else '500' end,
    case when rate is null then null else 'Normal saline (fictional)' end));
end
$f$;
-- A vitals reading by member n on p's stay, with the given columns (as ehr-api's INSERT writes them).
create function pg_temp.vital(n integer, p integer, columns text, vals text, at_value timestamptz default null)
returns jsonb language plpgsql as $f$
begin
  return pg_temp.run(n, format($s$with written as (
      insert into ehr.vitals (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at, %s)
      values (%L, %L, 'a1740000-0000-4000-8000-000000000002', %L, %L, %L, %s) returning id)
      select jsonb_build_object('outcome', 'created', 'id', id) from written$s$, columns, pg_temp.enc(p),
    pg_temp.patient(p), pg_temp.account(n), pg_temp.member(n), coalesce(at_value, clock_timestamp()), vals));
end
$f$;
create function pg_temp.err(answer jsonb) returns text language sql immutable as $f$
  select coalesce(split_part(answer->>'error', ' ', 1), answer->>'outcome')
$f$;
create function pg_temp.dose_state(prescription uuid, scheduled timestamptz) returns text language sql security definer as $f$
  select state from ehr.mar_due_doses((select admission.id from ehr.admissions admission
                                        join ehr.prescriptions rx on rx.encounter_id = admission.encounter_id
                                       where rx.id = prescription), scheduled - interval '1 minute',
                                      scheduled + interval '1 minute') due
   where due.prescription_id = prescription and due.scheduled_for = scheduled
$f$;
create function pg_temp.task_of(label text) returns uuid language sql as $f$ select pg_temp.ref(label)::uuid $f$;
create function pg_temp.due_gap_hours(next_task uuid, this_task uuid) returns text language sql security definer as $f$
  select extract(hour from later.due_at - earlier.due_at)::text from ehr.nursing_tasks later, ehr.nursing_tasks earlier
   where later.id = next_task and earlier.id = this_task
$f$;
create function pg_temp.task_version(task uuid) returns bigint language sql security definer as $f$
  select row_version from ehr.nursing_tasks where id = task
$f$;

-- 0. Wards, beds and stays through ADT-1's functions.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('0 wards', 'created,created',
  (select string_agg(pg_temp.o(pg_temp.run(4, format($s$select ehr.ward_create(%L, %L, 'any', %L, %L)$s$, w.name, w.kind,
     pg_temp.key('w-' || w.kind), pg_temp.sha('w-' || w.kind)), 'healthcare-operations')), ',' order by w.kind)
     from (values ('General Ward', 'general'), ('ICU', 'icu')) w(name, kind)));
select pg_temp.check_case('0 beds', 'created,created,created,created,created,created,created',
  (select string_agg(pg_temp.o(pg_temp.run(4, format($s$select ehr.bed_create(%L, %L, 'bed', %L, %L)$s$,
     pg_temp.ward(b.ward), b.bed, pg_temp.key('b-' || replace(b.ward || b.bed, ' ', '')), pg_temp.sha('b-' || b.ward || b.bed)),
     'healthcare-operations')), ',' order by b.ward, b.bed)
     from (values ('General Ward', 'Bed 1'), ('General Ward', 'Bed 2'), ('General Ward', 'Bed 3'),
                  ('General Ward', 'Bed 4'), ('ICU', 'ICU 1'), ('ICU', 'ICU 2'), ('ICU', 'ICU 3')) b(ward, bed)));
select pg_temp.check_case('0 requests', 'created,created,created,created,created,created,created',
  (select string_agg(pg_temp.o(pg_temp.run(2, format($s$select ehr.admission_request(%L, 'direct', null, null, null,
     'Observation (fictional)', null, %L, %L, null, %L, %L)$s$, pg_temp.patient(p), pg_temp.member(2),
     pg_temp.ward(case when p in (5, 7, 8) then 'ICU' else 'General Ward' end), pg_temp.key('r-' || p),
     pg_temp.sha('r-' || p)))), ',' order by p)
     from (values (1), (2), (3), (4), (5), (7), (8)) patients(p)));
select pg_temp.check_case('0 beds given', 'updated,updated,updated,updated,updated,updated,updated',
  (select string_agg(pg_temp.o(pg_temp.run(1, format($s$select ehr.admission_admit(%L, %s, %L, true, %L, %L)$s$,
     pg_temp.adm(s.p), pg_temp.adm_version(s.p), pg_temp.bed(s.ward, s.bed), pg_temp.key('a-' || s.p),
     pg_temp.sha('a-' || s.p)))), ',' order by s.p)
     from (values (1, 'General Ward', 'Bed 1'), (2, 'General Ward', 'Bed 2'), (3, 'General Ward', 'Bed 3'),
                  (4, 'General Ward', 'Bed 4'), (5, 'ICU', 'ICU 1'), (7, 'ICU', 'ICU 2'), (8, 'ICU', 'ICU 3')) s(p, ward, bed)));

-- 1. Vitals: the new fields.
select pg_temp.check_case('1 pain alone', 'created', pg_temp.o(pg_temp.vital(1, 1, 'pain_score', '4')));
select pg_temp.check_case('1 AVPU alone', 'created', pg_temp.o(pg_temp.vital(1, 1, 'avpu', $v$'voice'$v$)));
select pg_temp.check_case('1 glucose alone', 'created', pg_temp.o(pg_temp.vital(1, 1, 'blood_glucose_mmol_l', '7.2')));
select pg_temp.check_case('1 room air alone', 'created', pg_temp.o(pg_temp.vital(1, 1, 'oxygen_device', $v$'room_air'$v$)));
select pg_temp.check_case('1 room air at 21%', 'created',
  pg_temp.o(pg_temp.vital(1, 1, 'oxygen_device, fio2_percent', $v$'room_air', 21$v$)));
select pg_temp.check_case('1 a flow on room air', '23514',
  pg_temp.err(pg_temp.vital(1, 1, 'oxygen_device, oxygen_flow_l_per_min', $v$'room_air', 2$v$)));
select pg_temp.check_case('1 FiO2 above 21 on room air', '23514',
  pg_temp.err(pg_temp.vital(1, 1, 'oxygen_device, fio2_percent', $v$'room_air', 28$v$)));
select pg_temp.check_case('1 a flow with no device', '23514',
  pg_temp.err(pg_temp.vital(1, 1, 'oxygen_flow_l_per_min', '2')));
select pg_temp.check_case('1 nasal cannula 2 L/min with values', 'created',
  pg_temp.o(pg_temp.vital(1, 1, 'pulse_bpm, oxygen_saturation_percent, oxygen_device, oxygen_flow_l_per_min',
    $v$112, 92, 'nasal_cannula', 2$v$, clock_timestamp() - interval '90 minutes')));
select pg_temp.check_case('1 a full GCS', 'created',
  pg_temp.o(pg_temp.vital(1, 1, 'gcs_eye, gcs_verbal, gcs_verbal_not_testable, gcs_motor', '4, 5, false, 6')));
select pg_temp.check_case('1 GCS with the verbal part not testable', 'created',
  pg_temp.o(pg_temp.vital(1, 1, 'gcs_eye, gcs_verbal_not_testable, gcs_motor', '3, true, 5')));
select pg_temp.check_case('1 GCS missing a part', '23514',
  pg_temp.err(pg_temp.vital(1, 1, 'gcs_eye, gcs_motor', '3, 5')));
select pg_temp.check_case('1 a verbal score marked not testable', '23514',
  pg_temp.err(pg_temp.vital(1, 1, 'gcs_eye, gcs_verbal, gcs_verbal_not_testable, gcs_motor', '3, 2, true, 5')));
select pg_temp.check_case('1 pain out of range', '23514', pg_temp.err(pg_temp.vital(1, 1, 'pain_score', '11')));
select pg_temp.check_case('1 an empty reading', '23514', pg_temp.err(pg_temp.vital(1, 1, 'source', $v$'manual'$v$)));
select pg_temp.remember('v-pain', (pg_temp.vital(1, 1, 'pain_score, temperature_c', '6, 38.4', clock_timestamp() - interval '30 minutes'))->>'id');
select pg_temp.check_case('1 a correction of new fields', 'ok',
  (select case when answer ? 'error' then answer->>'error' else 'ok' end from pg_temp.run(1, format($s$
     with written as (insert into ehr.vital_corrections (vital_id, patient_id, facility_id, correction_no,
       replacement_values, reason, created_by, created_by_membership_id)
     values (%L, %L, 'a1740000-0000-4000-8000-000000000002', 1, '{"pain_score": 3, "avpu": "alert"}', 'Re-scored',
       %L, %L) returning id) select jsonb_build_object('id', id) from written$s$, pg_temp.ref('v-pain'),
     pg_temp.patient(1), pg_temp.account(1), pg_temp.member(1))) answer));
select pg_temp.run(1, format($s$with changed as (update ehr.vitals set current_correction_no = 1
  where id = %L returning 1) select jsonb_build_object('n', count(*)) from changed$s$, pg_temp.ref('v-pain')));
select pg_temp.check_case('1 a correction with an unknown key', '23514',
  (select split_part(answer->>'error', ' ', 1) from pg_temp.run(1, format($s$
     with written as (insert into ehr.vital_corrections (vital_id, patient_id, facility_id, correction_no,
       replacement_values, reason, created_by, created_by_membership_id)
     values (%L, %L, 'a1740000-0000-4000-8000-000000000002', 2, '{"news2": 3}', 'Not a measure', %L, %L)
     returning id) select jsonb_build_object('id', id) from written$s$, pg_temp.ref('v-pain'),
     pg_temp.patient(1), pg_temp.account(1), pg_temp.member(1))) answer));
select pg_temp.remember('v-eie', (pg_temp.vital(1, 1, 'avpu', $v$'pain'$v$, clock_timestamp() - interval '20 minutes'))->>'id');
select pg_temp.check_case('1 entered in error still works (0142)', 'entered_in_error',
  (select answer->>'status' from pg_temp.run(1, format($s$with changed as (update ehr.vitals
     set status = 'entered_in_error' where id = %L returning status) select to_jsonb(changed) from changed$s$, pg_temp.ref('v-eie'))) answer));

-- 2. The observation chart.
select pg_temp.check_case('2 nurse 1 reads p1''s chart: found, no score', 'found/null',
  (select pg_temp.o(answer) || '/' || coalesce(answer->>'score', 'null')
     from pg_temp.run(1, format($s$select ehr.observation_chart(%L, now() - interval '24 hours', now() + interval '1 minute', false)$s$,
       pg_temp.adm(1))) answer));
select pg_temp.check_case('2 the readings, the corrected one with its correction, the one in error marked', 'true/3/alert/entered_in_error',
  (select (jsonb_array_length(answer->'readings') >= 9)::text || '/'
          || (select reading->'values'->>'painScore' from jsonb_array_elements(answer->'readings') reading
               where reading->>'vitalId' = pg_temp.ref('v-pain')) || '/'
          || (select reading->'values'->>'avpu' from jsonb_array_elements(answer->'readings') reading
               where reading->>'vitalId' = pg_temp.ref('v-pain')) || '/'
          || (select reading->>'status' from jsonb_array_elements(answer->'readings') reading
               where reading->>'vitalId' = pg_temp.ref('v-eie'))
     from pg_temp.run(1, format($s$select ehr.observation_chart(%L, now() - interval '24 hours', now() + interval '1 minute', false)$s$,
       pg_temp.adm(1))) answer));
select pg_temp.check_case('2 nurse 8 (no chart grant) cannot read it', 'chart_access_required',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.observation_chart(%L, now() - interval '1 day', now(), false)$s$, pg_temp.adm(1)))));
select pg_temp.check_case('2 the front desk (vitals, no admissions) cannot', '42501 NURSING_NOT_ALLOWED',
  pg_temp.o(pg_temp.run(5, format($s$select ehr.observation_chart(%L, now() - interval '1 day', now(), false)$s$, pg_temp.adm(1)))));
select pg_temp.check_case('2 more than 7 days is refused', '22023 NURSING_INVALID',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.observation_chart(%L, now() - interval '8 days', now(), false)$s$, pg_temp.adm(1)))));
select pg_temp.check_case('2 another facility''s nurse finds nothing', 'not_found',
  pg_temp.o(pg_temp.run(7, format($s$select ehr.observation_chart(%L, now() - interval '1 day', now(), false)$s$, pg_temp.adm(1)))));

-- 3. Inpatient schedules.
select pg_temp.check_case('3 a schedule on an outpatient visit', '22023',
  pg_temp.err(pg_temp.rx('a1740800-0000-4000-8000-000000000006', 6, 'Fictional Med A', 'regular',
    array['08:00'], null)));
select pg_temp.check_case('3 times out of order', '22023',
  pg_temp.err(pg_temp.rx(pg_temp.enc(1), 1, 'Fictional Med A', 'regular', array['14:00', '06:00'], null)));
select pg_temp.check_case('3 an as-needed order without its gap', '23514',
  pg_temp.err(pg_temp.rx(pg_temp.enc(1), 1, 'Fictional Med A', 'as_needed', null, null, 'Pain')));
select pg_temp.check_case('3 an infusion on an as-needed order', '23514',
  pg_temp.err(pg_temp.rx(pg_temp.enc(1), 1, 'Fictional Med A', 'as_needed', null, null, 'Pain', 60, 4, 125)));
-- R1: 06:00, 14:00, 22:00 since three days ago (p1). R2: due now (p1). R3: 3 hours ago (p1). R4: across midnight (p2).
select pg_temp.remember('r1', (pg_temp.rx(pg_temp.enc(1), 1, 'Ceftriaxone (fictional)', 'regular',
  array['06:00', '14:00', '22:00'], now() - interval '3 days'))->>'id');
select pg_temp.remember('r2-at', date_trunc('minute', clock_timestamp())::text);
select pg_temp.remember('r2', (pg_temp.rx(pg_temp.enc(1), 1, 'Fictional Med Due', 'regular',
  array[to_char(pg_temp.ref('r2-at')::timestamptz at time zone 'Africa/Lagos', 'HH24:MI')], now() - interval '1 day'))->>'id');
select pg_temp.remember('r3-at', date_trunc('minute', clock_timestamp() - interval '3 hours')::text);
select pg_temp.remember('r3', (pg_temp.rx(pg_temp.enc(1), 1, 'Fictional Med Earlier', 'regular',
  array[to_char(pg_temp.ref('r3-at')::timestamptz at time zone 'Africa/Lagos', 'HH24:MI')],
  now() - interval '1 day'))->>'id');
select pg_temp.remember('r4', (pg_temp.rx(pg_temp.enc(2), 2, 'Fictional Med Night', 'regular', array['00:30', '23:30'],
  now() - interval '3 days', null, null, null, null, 500, 'mg', 'oral'))->>'id');
select pg_temp.remember('prn', (pg_temp.rx(pg_temp.enc(1), 1, 'Paracetamol (fictional)', 'as_needed', null,
  now() - interval '1 day', 'Pain or fever', 240, 1, null, 1, 'g', 'oral'))->>'id');
select pg_temp.check_case('3 STAT sets the priority', 'created/stat',
  (select pg_temp.o(answer) || '/' || (answer->>'priority') from pg_temp.rx(pg_temp.enc(2), 2, 'Fictional Med Stat', 'stat', null,
     null) answer));
select pg_temp.remember('once', (pg_temp.rx(pg_temp.enc(2), 2, 'Fictional Med Once', 'once', null,
  now() + interval '2 hours'))->>'id');
select pg_temp.remember('inf', (pg_temp.rx(pg_temp.enc(5), 5, 'Fictional Infusion', 'regular', array['08:00'],
  now() - interval '1 day', null, null, null, 125))->>'id');
select pg_temp.check_case('3 the schedule never changes', '55000 INPATIENT_SCHEDULE_IMMUTABLE',
  (select answer->>'error' from pg_temp.run(2, format($s$with changed as (update ehr.prescriptions
     set scheduled_times = array['07:00', '15:00', '23:00'] where id = %L returning id) select to_jsonb(changed) from changed$s$, pg_temp.ref('r1'))) answer));
select pg_temp.check_case('3 other fields still change', 'ok',
  (select case when answer ? 'error' then answer->>'error' else 'ok' end from pg_temp.run(2, format($s$with changed as (update ehr.prescriptions set instructions = 'With food (fictional)' where id = %L returning id) select to_jsonb(changed) from changed$s$,
     pg_temp.ref('r1'))) answer));
reset role;
select pg_temp.check_case('3 0148''s trigger is still the last AFTER UPDATE trigger', 'prescriptions_pharmacy_change_after_dispensing',
  (select tgname from pg_trigger where tgrelid = 'ehr.prescriptions'::regclass and not tgisinternal
     and tgtype & 1 <> 0 and tgtype & 16 <> 0 and tgtype & 2 = 0 and tgtype & 64 = 0
   order by tgname collate "C" desc limit 1));

-- 4. Due doses, in Lagos time (the session is in New York).
select pg_temp.check_case('4 R1 on a Lagos day: three doses at 05:00, 13:00 and 21:00 UTC', '05:00,13:00,21:00',
  (select string_agg(to_char(due.scheduled_for at time zone 'UTC', 'HH24:MI'), ',' order by due.scheduled_for)
     from ehr.mar_due_doses(pg_temp.adm(1), (pg_temp.lagos_today() - 1)::timestamp at time zone 'Africa/Lagos',
                            (pg_temp.lagos_today())::timestamp at time zone 'Africa/Lagos') due
    where due.prescription_id = pg_temp.ref('r1')::uuid));
select pg_temp.check_case('4 R4 across midnight: 23:30 then 00:30 the next day', '23:30,00:30',
  (select string_agg(to_char(due.scheduled_for at time zone 'Africa/Lagos', 'HH24:MI'), ',' order by due.scheduled_for)
     from ehr.mar_due_doses(pg_temp.adm(2), (pg_temp.lagos_today() - 1)::timestamp at time zone 'Africa/Lagos' + interval '23 hours',
                            (pg_temp.lagos_today())::timestamp at time zone 'Africa/Lagos' + interval '1 hour') due
    where due.prescription_id = pg_temp.ref('r4')::uuid));
select pg_temp.check_case('4 a schedule''s first day starts at its first due time', '0',
  (select count(*)::text from ehr.mar_due_doses(pg_temp.adm(2), now() - interval '7 days', now() - interval '3 days 1 minute') due
    where due.prescription_id = pg_temp.ref('r4')::uuid));
select pg_temp.check_case('4 R2 is due now, R3 is late, the once dose is upcoming', 'due/late/upcoming',
  pg_temp.dose_state(pg_temp.ref('r2')::uuid, pg_temp.ref('r2-at')::timestamptz) || '/'
  || pg_temp.dose_state(pg_temp.ref('r3')::uuid, pg_temp.ref('r3-at')::timestamptz) || '/'
  || (select state from ehr.mar_due_doses(pg_temp.adm(2), now(), now() + interval '3 hours') due
       where due.prescription_id = pg_temp.ref('once')::uuid));
select pg_temp.check_case('4 an as-needed order has no due doses', '0',
  (select count(*)::text from ehr.mar_due_doses(pg_temp.adm(1), now() - interval '1 day', now() + interval '1 day') due
    where due.prescription_id = pg_temp.ref('prn')::uuid));

-- 5. The medicine round.
set local role hid_ehr_api_runtime;
create function pg_temp.mar(n integer, prescription text, scheduled text, outcome text, given_at text, dose numeric,
  unit text, route text, differs text, reason_code text, reason_text text, supply text, override text, label text)
returns jsonb language sql as $f$
  select pg_temp.run(n, format($s$select ehr.mar_record(%L, %L, %L::timestamptz, %L, %L::timestamptz, %s, %L, %L, %L, %L,
    %L, %L, %L, null, %L, %L)$s$, (select value from pg_temp.n_refs where name = 'adm-of-' || prescription),
    pg_temp.ref(prescription), scheduled, outcome, given_at, coalesce(dose::text, 'null'), unit, route, differs,
    reason_code, reason_text, supply, override, pg_temp.key(label), pg_temp.sha(label)))
$f$;
select pg_temp.remember('adm-of-' || name, pg_temp.adm(p)::text)
  from (values ('r1', 1), ('r2', 1), ('r3', 1), ('prn', 1), ('r4', 2), ('once', 2), ('inf', 5)) refs(name, p);
select pg_temp.check_case('5 the front desk cannot record a dose', '42501 MAR_RECORD_NOT_ALLOWED',
  pg_temp.o(pg_temp.mar(5, 'r2', pg_temp.ref('r2-at'), 'given', now()::text, 1, 'g', 'IV', null, null, null, 'ward_stock',
    null, 'm-desk')));
select pg_temp.check_case('5 nurse 8 (no chart grant) cannot', 'chart_access_required',
  pg_temp.o(pg_temp.mar(8, 'r2', pg_temp.ref('r2-at'), 'given', now()::text, 1, 'g', 'IV', null, null, null, 'ward_stock',
    null, 'm-8')));
select pg_temp.check_case('5 not dispensed: where it came from is needed', 'supply_source_required',
  pg_temp.o(pg_temp.mar(1, 'r2', pg_temp.ref('r2-at'), 'given', now()::text, 1, 'g', 'IV', null, null, null, null,
    null, 'm-nosource')));
select pg_temp.check_case('5 given from ward stock, before dispensing', 'created/before_dispensing/not_sent/false/false',
  (select pg_temp.o(answer) || '/' || (answer->'warnings'->>0) || '/'
          || (answer->'administration'->>'pharmacyStateAtRecord') || '/' || (answer->'administration'->>'late') || '/'
          || (answer->'administration'->>'recordedLate')
     from pg_temp.mar(1, 'r2', pg_temp.ref('r2-at'), 'given', now()::text, 1, 'g', 'IV', null, null, null, 'ward_stock',
       null, 'm-r2') answer));
select pg_temp.check_case('5 the same key and body replays', 'replayed:created',
  pg_temp.o(pg_temp.mar(1, 'r2', pg_temp.ref('r2-at'), 'given', now()::text, 1, 'g', 'IV', null, null, null, 'ward_stock',
    null, 'm-r2')));
select pg_temp.check_case('5 the dose is recorded once', 'already_recorded',
  pg_temp.o(pg_temp.mar(2, 'r2', pg_temp.ref('r2-at'), 'held', now()::text, null, null, null, null, 'nil_by_mouth', null,
    null, null, 'm-r2-twice')));
select pg_temp.check_case('5 a key used again with another body', 'key_reused',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.mar_record(%L, %L, %L::timestamptz, 'held', now(), null, null, null, null,
    'nil_by_mouth', null, null, null, null, %L, %L)$s$, pg_temp.adm(1), pg_temp.ref('r3'), pg_temp.ref('r3-at'),
    pg_temp.key('m-r2'), pg_temp.sha('another body')))));
select pg_temp.check_case('5 a time that is not a due time', 'scheduled_for_invalid',
  pg_temp.o(pg_temp.mar(1, 'r3', (pg_temp.ref('r3-at')::timestamptz + interval '7 minutes')::text, 'given', now()::text, 1,
    'g', 'IV', null, null, null, 'ward_stock', null, 'm-r3-wrong')));
select pg_temp.check_case('5 held needs a reason', '22023 DOSE_REASON_REQUIRED',
  pg_temp.o(pg_temp.mar(1, 'r3', pg_temp.ref('r3-at'), 'held', now()::text, null, null, null, null, null, null, null,
    null, 'm-r3-noreason')));
select pg_temp.check_case('5 a clinical decision needs words', '22023 DOSE_REASON_REQUIRED',
  pg_temp.o(pg_temp.mar(1, 'r3', pg_temp.ref('r3-at'), 'held', now()::text, null, null, null, null, 'clinical_decision',
    'low', null, null, 'm-r3-short')));
select pg_temp.check_case('5 a reason from another outcome''s list', '22023 DOSE_REASON_REQUIRED',
  pg_temp.o(pg_temp.mar(1, 'r3', pg_temp.ref('r3-at'), 'refused', now()::text, null, null, null, null, 'nil_by_mouth',
    null, null, null, 'm-r3-wronglist')));
select pg_temp.check_case('5 a dose different from the order needs a reason', 'dose_differs_reason_required',
  pg_temp.o(pg_temp.mar(1, 'r3', pg_temp.ref('r3-at'), 'given', (now() - interval '150 minutes')::text, 2, 'g', 'IV', null,
    null, null, 'patient_own', null, 'm-r3-differs')));
select pg_temp.check_case('5 given with a reason, 150 minutes ago: recorded late, not late', 'created/false/true/dose_differs',
  (select pg_temp.o(answer) || '/' || (answer->'administration'->>'late') || '/'
          || (answer->'administration'->>'recordedLate') || '/' || ((answer->'warnings'->>0))
     from pg_temp.mar(1, 'r3', pg_temp.ref('r3-at'), 'given', (now() - interval '150 minutes')::text, 2, 'g', 'IV',
       'Weight-based dose (fictional)', null, null, 'patient_own', null, 'm-r3') answer));
select pg_temp.check_case('5 a time more than 12 hours ago', '22023 DOSE_TIME_INVALID',
  pg_temp.o(pg_temp.mar(1, 'prn', null, 'given', (now() - interval '13 hours')::text, 1, 'g', 'oral', null, null, null,
    'ward_stock', null, 'm-old')));
select pg_temp.check_case('5 a time in the future', '22023 DOSE_TIME_INVALID',
  pg_temp.o(pg_temp.mar(1, 'prn', null, 'given', (now() + interval '1 hour')::text, 1, 'g', 'oral', null, null, null,
    'ward_stock', null, 'm-future')));
select pg_temp.check_case('5 an as-needed dose', 'created',
  pg_temp.o(pg_temp.mar(1, 'prn', null, 'given', (now() - interval '1 hour')::text, 1, 'g', 'oral', null, null, null,
    'ward_stock', null, 'm-prn-1')));
select pg_temp.check_case('5 another inside the gap needs a reason', 'override_reason_required',
  pg_temp.o(pg_temp.mar(1, 'prn', null, 'given', now()::text, 1, 'g', 'oral', null, null, null, 'ward_stock', null,
    'm-prn-2')));
select pg_temp.check_case('5 with a reason it is recorded and warned, never blocked', 'created/as_needed_inside_gap,as_needed_over_max,before_dispensing',
  (select pg_temp.o(answer) || '/' || (select string_agg(warning, ',') from jsonb_array_elements_text(answer->'warnings') warning)
     from pg_temp.mar(1, 'prn', null, 'given', now()::text, 1, 'g', 'oral', null, null, null, 'ward_stock',
       'Severe pain after a fall (fictional)', 'm-prn-3') answer));
select pg_temp.check_case('5 an as-needed dose gives no scheduled time', 'scheduled_for_invalid',
  pg_temp.o(pg_temp.mar(1, 'prn', pg_temp.ref('r2-at'), 'given', now()::text, 1, 'g', 'oral', null, null, null,
    'ward_stock', 'Again (fictional reason)', 'm-prn-4')));
reset role;
select pg_temp.remember('r1-late', (select max(due.scheduled_for)::text from ehr.mar_due_doses(pg_temp.adm(1),
  now() - interval '11 hours', now() - interval '61 minutes') due where due.prescription_id = pg_temp.ref('r1')::uuid));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('5 an override reason where none is needed', '22023 NURSING_INVALID',
  pg_temp.o(pg_temp.mar(2, 'r1', pg_temp.ref('r1-late'), 'given', now()::text, 1, 'g', 'IV', null, null, null,
    'ward_stock', 'Not needed at all here', 'm-r1-override')));
select pg_temp.check_case('5 R1''s last missed dose given now is late', 'created/true/late',
  (select pg_temp.o(answer) || '/' || (answer->'administration'->>'late') || '/' || ((answer->'warnings'->>0))
     from pg_temp.mar(2, 'r1', pg_temp.ref('r1-late'), 'given', now()::text, 1, 'g', 'IV', null, null, null, 'ward_stock',
       null, 'm-r1-late') answer));
select pg_temp.check_case('5 entered in error needs a reason', '22023 NURSING_INVALID',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.mar_entered_in_error(%L, 1, 'short', %L, %L)$s$,
    (select answer->'administration'->>'administrationId' from pg_temp.mar(1, 'r2', pg_temp.ref('r2-at'), 'given', now()::text,
       1, 'g', 'IV', null, null, null, 'ward_stock', null, 'm-r2') answer), pg_temp.key('e-short'), pg_temp.sha('e-short')))));
select pg_temp.remember('r2-admin', (select answer->'administration'->>'administrationId' from pg_temp.mar(1, 'r2',
  pg_temp.ref('r2-at'), 'given', now()::text, 1, 'g', 'IV', null, null, null, 'ward_stock', null, 'm-r2') answer));
select pg_temp.check_case('5 a stale version', 'changed',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.mar_entered_in_error(%L, 7, 'Recorded on the wrong order (fictional)', %L, %L)$s$,
    pg_temp.ref('r2-admin'), pg_temp.key('e-stale'), pg_temp.sha('e-stale')))));
select pg_temp.check_case('5 entered in error, for good', 'updated/entered_in_error',
  (select pg_temp.o(answer) || '/' || (answer->'administration'->>'status') from pg_temp.run(1, format(
     $s$select ehr.mar_entered_in_error(%L, 1, 'Recorded on the wrong order (fictional)', %L, %L)$s$,
     pg_temp.ref('r2-admin'), pg_temp.key('e-r2'), pg_temp.sha('e-r2'))) answer));
select pg_temp.check_case('5 once only', 'already_entered_in_error',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.mar_entered_in_error(%L, 2, 'Recorded on the wrong order (fictional)', %L, %L)$s$,
    pg_temp.ref('r2-admin'), pg_temp.key('e-r2-again'), pg_temp.sha('e-r2-again')))));
reset role;
select pg_temp.check_case('5 the dose is due again', 'due', pg_temp.dose_state(pg_temp.ref('r2')::uuid, pg_temp.ref('r2-at')::timestamptz));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('5 and can be recorded again (omitted, patient away)', 'created',
  pg_temp.o(pg_temp.mar(1, 'r2', pg_temp.ref('r2-at'), 'omitted', now()::text, null, null, null, null, 'patient_away', null,
    null, null, 'm-r2-again')));
select pg_temp.check_case('5 the record is never edited', '42501',
  (select split_part(answer->>'error', ' ', 1) from pg_temp.run(1, format($s$with changed as (update
     ehr.medication_administrations set outcome = 'given' where id = %L returning id) select to_jsonb(changed) from changed$s$,
     pg_temp.ref('r2-admin'))) answer));
-- An order put on hold has no due doses, and a dose against it is refused.
select pg_temp.run(2, format($s$with changed as (update ehr.prescriptions set status = 'on_hold' where id = %L
  returning id) select to_jsonb(changed) from changed$s$, pg_temp.ref('r3')));
select pg_temp.check_case('5 a stopped order', 'order_not_active',
  pg_temp.o(pg_temp.mar(1, 'r3', pg_temp.ref('r3-at'), 'held', now()::text, null, null, null, null, 'nil_by_mouth', null,
    null, null, 'm-r3-held')));
select pg_temp.check_case('5 the round for p1: orders, pharmacy state, the stopped order has no due dose', 'found/true/not_sent/0',
  (select pg_temp.o(answer) || '/' || (jsonb_array_length(answer->'orders') >= 4)::text || '/'
          || (select item->>'pharmacyState' from jsonb_array_elements(answer->'orders') item
               where item->>'prescriptionId' = pg_temp.ref('r1')) || '/'
          || (select jsonb_array_length(item->'doses') from jsonb_array_elements(answer->'orders') item
               where item->>'prescriptionId' = pg_temp.ref('r3'))
     from pg_temp.run(1, format($s$select ehr.mar_read(%L, now() - interval '24 hours', now() + interval '24 hours')$s$,
       pg_temp.adm(1))) answer));
select pg_temp.check_case('5 the as-needed order says when the next dose is allowed', 'true',
  (select ((item->>'nextAllowedAt')::timestamptz > now() + interval '3 hours')::text
     from pg_temp.run(1, format($s$select ehr.mar_read(%L, now() - interval '24 hours', now() + interval '24 hours')$s$,
       pg_temp.adm(1))) answer, jsonb_array_elements(answer->'orders') item
    where item->>'prescriptionId' = pg_temp.ref('prn')));
select pg_temp.check_case('5 nurse 8 cannot read p1''s round', 'chart_access_required',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.mar_read(%L, now() - interval '1 day', now())$s$, pg_temp.adm(1)))));
select pg_temp.check_case('5 the ward round for nurse 8: counts, no names, no medicines', 'found/true/true/0',
  (select pg_temp.o(answer) || '/' || (item->'patient'->>'nameHidden') || '/' || (item->>'medicinesHidden') || '/'
          || jsonb_array_length(item->'doses')
     from pg_temp.run(8, format($s$select ehr.mar_ward_round(%L, 'next_4h')$s$, pg_temp.ward('General Ward'))) answer,
          jsonb_array_elements(answer->'items') item
    where item->>'admissionId' = pg_temp.adm(1)::text));
select pg_temp.check_case('5 the ward round for nurse 1: p1''s name and medicines', 'false/true',
  (select (item->'patient'->>'nameHidden') || '/'
          || exists (select 1 from jsonb_array_elements(item->'doses') dose where dose->>'medicationDisplay' like '%fictional%')::text
     from pg_temp.run(1, format($s$select ehr.mar_ward_round(%L, 'next_4h')$s$, pg_temp.ward('General Ward'))) answer,
          jsonb_array_elements(answer->'items') item
    where item->>'admissionId' = pg_temp.adm(1)::text));
select pg_temp.check_case('5 the round of another facility''s ward', 'ward_not_found',
  pg_temp.o(pg_temp.run(7, format($s$select ehr.mar_ward_round(%L, 'now')$s$, pg_temp.ward('General Ward')))));
select pg_temp.check_case('5 the runtime cannot read the record or run the helpers', '42501/42501',
  (select split_part(answer->>'error', ' ', 1) from pg_temp.run(1, $s$select jsonb_build_object('n', count(*))
     from ehr.medication_administrations$s$) answer) || '/'
  || (select split_part(answer->>'error', ' ', 1) from pg_temp.run(1, format($s$select jsonb_build_object('n', count(*))
     from ehr.mar_due_doses(%L, now(), now() + interval '1 hour')$s$, pg_temp.adm(1))) answer));

-- 6. Nursing tasks.
select pg_temp.check_case('6 the front desk cannot make a task', '42501 NURSING_NOT_ALLOWED',
  pg_temp.o(pg_temp.run(5, format($s$select ehr.nursing_task_create(%L, '4-hourly observations', now() + interval '1 hour', null,
    4, %L, %L)$s$, pg_temp.adm(1), pg_temp.key('t-desk'), pg_temp.sha('t-desk')))));
select pg_temp.check_case('6 the assignee must be a nurse, clinician or doctor here', 'assignee_invalid',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.nursing_task_create(%L, 'Wound dressing check', now() + interval '1 hour', %L,
    null, %L, %L)$s$, pg_temp.adm(1), pg_temp.member(5), pg_temp.key('t-bad'), pg_temp.sha('t-bad')))));
select pg_temp.remember('t-obs', (select answer->'task'->>'taskId' from pg_temp.run(8, format($s$select
  ehr.nursing_task_create(%L, '4-hourly observations', now() - interval '10 minutes', %L, 4, %L, %L)$s$, pg_temp.adm(1),
  pg_temp.member(1), pg_temp.key('t-obs'), pg_temp.sha('t-obs'))) answer));
select pg_temp.remember('t-wound', (select answer->'task'->>'taskId' from pg_temp.run(1, format($s$select
  ehr.nursing_task_create(%L, 'Wound dressing check', now() + interval '2 hours', null, null, %L, %L)$s$, pg_temp.adm(2),
  pg_temp.key('t-wound'), pg_temp.sha('t-wound'))) answer));
select pg_temp.check_case('6 the ward''s open tasks: overdue first, names hidden for nurse 8', '2/true/true',
  (select jsonb_array_length(answer->'items') || '/' || (answer->'items'->0->>'overdue') || '/'
          || (answer->'items'->0->'patient'->>'nameHidden')
     from pg_temp.run(8, format($s$select ehr.nursing_task_list(%L, null, 'open', false)$s$, pg_temp.ward('General Ward'))) answer));
select pg_temp.check_case('6 complete before start', 'state_invalid',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.nursing_task_complete(%L, 1, null, %L, %L)$s$, pg_temp.ref('t-obs'),
    pg_temp.key('t-early'), pg_temp.sha('t-early')))));
select pg_temp.check_case('6 start', 'updated/in_progress',
  (select pg_temp.o(answer) || '/' || (answer->'task'->>'status') from pg_temp.run(1, format(
     $s$select ehr.nursing_task_start(%L, 1, %L, %L)$s$, pg_temp.ref('t-obs'), pg_temp.key('t-start'), pg_temp.sha('t-start'))) answer));
select pg_temp.check_case('6 a stale version', 'changed',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.nursing_task_complete(%L, 1, null, %L, %L)$s$, pg_temp.ref('t-obs'),
    pg_temp.key('t-stale'), pg_temp.sha('t-stale')))));
select pg_temp.check_case('6 nurse 8 cannot write a completion record without chart access', 'chart_access_required',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.nursing_task_complete(%L, 2, 'Observations done (fictional)', %L, %L)$s$,
    pg_temp.ref('t-obs'), pg_temp.key('t-8'), pg_temp.sha('t-8')))));
select pg_temp.check_case('6 nurse 1 completes with a record; the repeat is made 4 hours on', 'updated/completed/true/4',
  (select pg_temp.o(answer) || '/' || (answer->'task'->>'status') || '/' || ((answer->>'nextTaskId') is not null)::text || '/'
          || pg_temp.due_gap_hours((answer->>'nextTaskId')::uuid, pg_temp.ref('t-obs')::uuid)
     from pg_temp.run(1, format($s$select ehr.nursing_task_complete(%L, 2, 'Observations done (fictional)', %L, %L)$s$,
       pg_temp.ref('t-obs'), pg_temp.key('t-done'), pg_temp.sha('t-done'))) answer));
select pg_temp.check_case('6 the completion record shows to nurse 1, not to nurse 8', 'Observations done (fictional)/true/null',
  (select (select item->>'completionRecord' from jsonb_array_elements(answer->'items') item
            where item->>'taskId' = pg_temp.ref('t-obs'))
     from pg_temp.run(1, format($s$select ehr.nursing_task_list(null, %L, 'done', false)$s$, pg_temp.adm(1))) answer) || '/'
  || (select (select (item->>'completionRecorded') || '/' || coalesce(item->>'completionRecord', 'null')
                from jsonb_array_elements(answer->'items') item where item->>'taskId' = pg_temp.ref('t-obs'))
        from pg_temp.run(8, format($s$select ehr.nursing_task_list(null, %L, 'done', false)$s$, pg_temp.adm(1))) answer));
select pg_temp.check_case('6 cancel needs a reason of 8 or more', '22023 NURSING_INVALID',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.nursing_task_cancel(%L, 1, 'no', %L, %L)$s$, pg_temp.ref('t-wound'),
    pg_temp.key('t-c-short'), pg_temp.sha('t-c-short')))));
select pg_temp.check_case('6 reassign and move', 'updated',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.nursing_task_update(%L, 1, %L, now() + interval '3 hours', %L, %L)$s$,
    pg_temp.ref('t-wound'), pg_temp.member(8), pg_temp.key('t-move'), pg_temp.sha('t-move')))));
select pg_temp.check_case('6 "mine" for nurse 8', '1',
  (select jsonb_array_length(answer->'items')::text from pg_temp.run(8, format(
     $s$select ehr.nursing_task_list(%L, null, 'open', true)$s$, pg_temp.ward('General Ward'))) answer));

-- 7. Fluid balance. The facility's fluid day starts at the current Lagos hour (another start hour, Q-NUR-15 A).
reset role;
insert into ehr.facility_nursing_settings (facility_id, fluid_day_starts_at_hour)
values ('a1740000-0000-4000-8000-000000000002', extract(hour from clock_timestamp() at time zone 'Africa/Lagos')::integer);
set local role hid_ehr_api_runtime;
create function pg_temp.fluid(n integer, p integer, direction text, kind text, volume integer, unmeasured boolean,
  at_value timestamptz, label text) returns jsonb language sql as $f$
  select pg_temp.run(n, format($s$select ehr.fluid_balance_record(%L, %L, %L, %s, %L, %L, 'Fictional note', %L, %L)$s$,
    pg_temp.adm(p), direction, kind, coalesce(volume::text, 'null'), unmeasured, at_value, pg_temp.key(label), pg_temp.sha(label)))
$f$;
select pg_temp.check_case('7 an amount and "not measured" together', '22023 FLUID_ENTRY_INVALID',
  pg_temp.o(pg_temp.fluid(1, 1, 'out', 'urine', 200, true, clock_timestamp(), 'f-both')));
select pg_temp.check_case('7 a kind of the other direction', '22023 NURSING_INVALID',
  pg_temp.o(pg_temp.fluid(1, 1, 'in', 'urine', 200, false, clock_timestamp(), 'f-kind')));
select pg_temp.check_case('7 more than 24 hours ago', '22023 FLUID_TIME_INVALID',
  pg_temp.o(pg_temp.fluid(1, 1, 'in', 'oral', 200, false, clock_timestamp() - interval '25 hours', 'f-old')));
select pg_temp.check_case('7 nurse 8 cannot without chart access', 'chart_access_required',
  pg_temp.o(pg_temp.fluid(8, 1, 'in', 'oral', 200, false, clock_timestamp(), 'f-8')));
select pg_temp.check_case('7 entries', 'created,created,created,created,created',
  (select string_agg(pg_temp.o(pg_temp.fluid(1, 1, e.direction, e.kind, e.volume, e.unmeasured, e.at_value, e.label)), ','
                     order by e.label)
     from (values ('in', 'oral', 300, false, clock_timestamp() - interval '2 seconds', 'f-1'),
                  ('out', 'urine', 200, false, clock_timestamp() - interval '1 second', 'f-2'),
                  ('out', 'urine', null, true, clock_timestamp() - interval '1 second', 'f-3'),
                  ('in', 'iv', 1000, false, clock_timestamp() - interval '1 second', 'f-4'),
                  ('in', 'oral', 150, false, date_trunc('hour', clock_timestamp()) - interval '10 minutes', 'f-5'))
          e(direction, kind, volume, unmeasured, at_value, label)));
select pg_temp.check_case('7 entered in error', 'updated',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.fluid_balance_entered_in_error(%L, 1, 'Wrong patient (fictional)', %L, %L)$s$,
    (select answer->>'entryId' from pg_temp.fluid(1, 1, 'in', 'iv', 1000, false, clock_timestamp() - interval '1 second', 'f-4') answer),
    pg_temp.key('f-e'), pg_temp.sha('f-e')))));
select pg_temp.check_case('7 today''s fluid day: 300 in, 200 out, 100 balance, one unmeasured, the one in error left out, the earlier one on yesterday''s day',
  'found/300/200/100/1/4',
  (select pg_temp.o(answer) || '/' || (answer->'totals'->>'intakeMl') || '/' || (answer->'totals'->>'outputMl') || '/'
          || (answer->'totals'->>'balanceMl') || '/' || (answer->'totals'->>'unmeasuredOutputCount') || '/'
          || jsonb_array_length(answer->'entries')
     from pg_temp.run(1, format($s$select ehr.fluid_balance_read(%L, null)$s$, pg_temp.adm(1))) answer));
select pg_temp.check_case('7 yesterday''s fluid day has the 150', '150',
  (select answer->'totals'->>'intakeMl' from pg_temp.run(1, format($s$select ehr.fluid_balance_read(%L, %L::date)$s$,
     pg_temp.adm(1), (clock_timestamp() at time zone 'Africa/Lagos')::date - 1)) answer));
select pg_temp.check_case('7 the hour''s totals and running balance', '300/200/100',
  (select (hour_row->>'inMl') || '/' || (hour_row->>'outMl') || '/' || (hour_row->>'runningBalanceMl')
     from pg_temp.run(1, format($s$select ehr.fluid_balance_read(%L, null)$s$, pg_temp.adm(1))) answer,
          jsonb_array_elements(answer->'byHour') hour_row
    where (hour_row->>'hourStart')::timestamptz = date_trunc('hour', clock_timestamp())));
select pg_temp.check_case('7 the ICU grid hours carry the same running balance', '100',
  (select hour_row->>'runningBalanceMl'
     from pg_temp.run(1, format($s$select ehr.observation_chart(%L, now() - interval '2 hours', now() + interval '1 minute', true)$s$,
       pg_temp.adm(1))) answer, jsonb_array_elements(answer->'hours') hour_row
    where (hour_row->>'hourStart')::timestamptz = date_trunc('hour', clock_timestamp())));
select pg_temp.check_case('7 nurse 8 cannot read it', 'chart_access_required',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.fluid_balance_read(%L, null)$s$, pg_temp.adm(1)))));

-- 8. Clinical shifts and assignments.
create function pg_temp.shift(n integer, shift_name text, starts text, ends text) returns jsonb language sql as $f$
  select pg_temp.run(n, format($s$select ehr.clinical_shift_create(%L, %L, %L, %L, %L)$s$, shift_name, starts, ends,
    pg_temp.key('s-' || replace(shift_name, ' ', '') || n), pg_temp.sha('s-' || shift_name || n)), 'healthcare-operations')
$f$;
select pg_temp.check_case('8 a nurse cannot set up shifts', '42501 SHIFT_SETUP_NOT_ALLOWED',
  pg_temp.o(pg_temp.shift(1, 'Morning', '07:30', '14:30')));
select pg_temp.check_case('8 the same start and end', '22023 SHIFT_TIMES_INVALID',
  pg_temp.o(pg_temp.shift(4, 'Odd', '07:30', '07:30')));
select pg_temp.check_case('8 Morning, Afternoon, Night (across midnight) and Now', 'created,created,created,created',
  (select string_agg(pg_temp.o(pg_temp.shift(4, s.name, s.starts, s.ends)), ',' order by s.ord)
     from (values (1, 'Morning', '07:30', '14:30'), (2, 'Afternoon', '14:00', '21:00'), (3, 'Night', '20:30', '08:00'),
                  (4, 'Now', to_char((clock_timestamp() - interval '1 hour') at time zone 'Africa/Lagos', 'HH24:00'),
                   to_char((clock_timestamp() + interval '2 hours') at time zone 'Africa/Lagos', 'HH24:00'))) s(ord, name, starts, ends)));
select pg_temp.check_case('8 a name already used (any case)', 'name_taken',
  pg_temp.o(pg_temp.shift(4, 'MORNING', '06:00', '12:00')));
select pg_temp.check_case('8 up to 8 active', 'created,created,created,created,limit_reached',
  (select string_agg(pg_temp.o(pg_temp.shift(4, 'Extra ' || k, '01:00', '02:00')), ',' order by k)
     from generate_series(1, 5) k));
select pg_temp.check_case('8 the list (Night crosses midnight)', 'found/8/true',
  (select pg_temp.o(answer) || '/' || jsonb_array_length(answer->'items') || '/'
          || (select item->>'crossesMidnight' from jsonb_array_elements(answer->'items') item where item->>'name' = 'Night')
     from pg_temp.run(1, $s$select ehr.clinical_shift_list()$s$) answer));
reset role;
create function pg_temp.shift_id(shift_name text) returns uuid language sql security definer as $f$
  select id from ehr.clinical_shifts where facility_id = 'a1740000-0000-4000-8000-000000000002' and name = shift_name and active
$f$;
select pg_temp.check_case('8 23:00 Lagos is in that day''s Night; 02:00 in the day before''s', 'true/true',
  (select (count(*) = 1)::text from ehr.clinical_shifts_at('a1740000-0000-4000-8000-000000000002',
     (pg_temp.lagos_today() + time '23:00') at time zone 'Africa/Lagos') at_shift
    where at_shift.shift_id = pg_temp.shift_id('Night') and at_shift.shift_date = pg_temp.lagos_today()) || '/'
  || (select (count(*) = 1)::text from ehr.clinical_shifts_at('a1740000-0000-4000-8000-000000000002',
     (pg_temp.lagos_today() + time '02:00') at time zone 'Africa/Lagos') at_shift
    where at_shift.shift_id = pg_temp.shift_id('Night') and at_shift.shift_date = pg_temp.lagos_today() - 1));
select pg_temp.remember('now-date', (select at_shift.shift_date::text from ehr.clinical_shifts_at(
  'a1740000-0000-4000-8000-000000000002', clock_timestamp()) at_shift where at_shift.shift_id = pg_temp.shift_id('Now')));
select pg_temp.remember('next-shift', (select next_shift.shift_id::text || '|' || next_shift.shift_date::text
  from ehr.clinical_shift_next(pg_temp.shift_id('Now'), pg_temp.ref('now-date')::date) next_shift));
set local role hid_ehr_api_runtime;
create function pg_temp.assign(n integer, shift_name text, shift_date date, ward_name text, expected integer, rows jsonb,
  label text) returns jsonb language sql as $f$
  select pg_temp.run(n, format($s$select ehr.shift_assignments_set(%L, %L, %L, %s, %L::jsonb, %L, %L)$s$, shift_date,
    pg_temp.shift_id(shift_name), pg_temp.ward(ward_name), expected, rows, pg_temp.key(label), pg_temp.sha(label)))
$f$;
select pg_temp.check_case('8 the front desk cannot assign', '42501 SHIFT_ASSIGN_NOT_ALLOWED',
  pg_temp.o(pg_temp.assign(5, 'Now', pg_temp.ref('now-date')::date, 'General Ward', 0, '[]', 'as-desk')));
select pg_temp.check_case('8 two nurses in charge', '22023 NURSING_INVALID',
  pg_temp.o(pg_temp.assign(1, 'Now', pg_temp.ref('now-date')::date, 'General Ward', 0, jsonb_build_array(
    jsonb_build_object('membershipId', pg_temp.member(1), 'duty', 'nurse_in_charge'),
    jsonb_build_object('membershipId', pg_temp.member(8), 'duty', 'nurse_in_charge')), 'as-two')));
select pg_temp.check_case('8 a doctor cannot be a ward nurse', 'assignee_invalid',
  pg_temp.o(pg_temp.assign(1, 'Now', pg_temp.ref('now-date')::date, 'General Ward', 0, jsonb_build_array(
    jsonb_build_object('membershipId', pg_temp.member(2), 'duty', 'nurse')), 'as-doc')));
select pg_temp.check_case('8 one nurse per patient', 'admission_invalid',
  pg_temp.o(pg_temp.assign(1, 'Now', pg_temp.ref('now-date')::date, 'General Ward', 0, jsonb_build_array(
    jsonb_build_object('membershipId', pg_temp.member(1), 'duty', 'nurse', 'admissionIds', jsonb_build_array(pg_temp.adm(1))),
    jsonb_build_object('membershipId', pg_temp.member(8), 'duty', 'nurse', 'admissionIds', jsonb_build_array(pg_temp.adm(1)))),
    'as-dup')));
select pg_temp.check_case('8 a patient of another ward', 'admission_invalid',
  pg_temp.o(pg_temp.assign(1, 'Now', pg_temp.ref('now-date')::date, 'General Ward', 0, jsonb_build_array(
    jsonb_build_object('membershipId', pg_temp.member(1), 'duty', 'nurse', 'admissionIds', jsonb_build_array(pg_temp.adm(5)))),
    'as-ward')));
select pg_temp.check_case('8 the General Ward now: nurse 8 for p1 and p2, nurse 1 in charge, the doctor on call', 'updated/1/3',
  (select pg_temp.o(answer) || '/' || (answer->'list'->>'version') || '/' || jsonb_array_length(answer->'list'->'assignments')
     from pg_temp.assign(1, 'Now', pg_temp.ref('now-date')::date, 'General Ward', 0, jsonb_build_array(
       jsonb_build_object('membershipId', pg_temp.member(8), 'duty', 'nurse',
         'admissionIds', jsonb_build_array(pg_temp.adm(1), pg_temp.adm(2))),
       jsonb_build_object('membershipId', pg_temp.member(1), 'duty', 'nurse_in_charge',
         'admissionIds', jsonb_build_array(pg_temp.adm(3))),
       jsonb_build_object('membershipId', pg_temp.member(2), 'duty', 'on_call_doctor')), 'as-gen') answer));
select pg_temp.check_case('8 the same version again', 'changed',
  pg_temp.o(pg_temp.assign(4, 'Now', pg_temp.ref('now-date')::date, 'General Ward', 0, '[]', 'as-again')));
select pg_temp.check_case('8 an ICU nurse with three patients is a warning, not a refusal', 'updated/icu_nurse_over_two',
  (select pg_temp.o(answer) || '/' || coalesce(answer->'warnings'->>0, 'none')
     from pg_temp.assign(4, 'Now', pg_temp.ref('now-date')::date, 'ICU', 0, jsonb_build_array(
       jsonb_build_object('membershipId', pg_temp.member(3), 'duty', 'nurse',
         'admissionIds', jsonb_build_array(pg_temp.adm(5), pg_temp.adm(7), pg_temp.adm(8)))), 'as-icu') answer));

-- 9. Handover, who is told, ward-team access.
select pg_temp.check_case('9 no sheet yet: a draft with the ward''s patients and nurse 1 among those handing over', 'found/null/draft/4/true',
  (select pg_temp.o(answer) || '/' || coalesce(answer->>'handoverId', 'null') || '/' || (answer->>'status') || '/'
          || jsonb_array_length(answer->'patients') || '/' || ((answer->'fromMembershipIds') ? pg_temp.member(1)::text)::text
     from pg_temp.run(1, format($s$select ehr.handover_read(%L, %L, %L)$s$, pg_temp.ward('General Ward'),
       pg_temp.ref('now-date'), pg_temp.shift_id('Now'))) answer));
select pg_temp.check_case('9 nurse 8 cannot write p1''s note without chart access', 'chart_access_required',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.handover_note_put(null, %L, %L, %L, %L, null, 'Stable overnight (fictional)',
    false, %L, %L)$s$, pg_temp.adm(1), pg_temp.ward('General Ward'), pg_temp.ref('now-date'), pg_temp.shift_id('Now'),
    pg_temp.key('h-8'), pg_temp.sha('h-8')))));
select pg_temp.check_case('9 nurse 1 writes p1''s note: the sheet is made', 'updated',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.handover_note_put(null, %L, %L, %L, %L, null, 'Stable overnight (fictional)',
    true, %L, %L)$s$, pg_temp.adm(1), pg_temp.ward('General Ward'), pg_temp.ref('now-date'), pg_temp.shift_id('Now'),
    pg_temp.key('h-1'), pg_temp.sha('h-1')))));
select pg_temp.remember('handover', (select answer->>'handoverId' from pg_temp.run(1, format(
  $s$select ehr.handover_read(%L, %L, %L)$s$, pg_temp.ward('General Ward'), pg_temp.ref('now-date'), pg_temp.shift_id('Now'))) answer));
select pg_temp.check_case('9 a second write is a revision of the same note', 'updated/2',
  (select pg_temp.o(answer) || '/' || (answer->'item'->>'rowVersion')
     from pg_temp.run(1, format($s$select ehr.handover_note_put(%L, %L, null, null, null, 1, 'Stable, watch fever (fictional)',
       true, %L, %L)$s$, pg_temp.ref('handover'), pg_temp.adm(1), pg_temp.key('h-2'), pg_temp.sha('h-2'))) answer));
reset role;
select pg_temp.check_case('9 the note is a clinical note "Nursing handover", amended at revision 2', 'Nursing handover/amended/2',
  (select note.note_type || '/' || note.status || '/' || note.current_revision_no from ehr.shift_handover_items item
     join ehr.clinical_notes note on note.id = item.clinical_note_id where item.handover_id = pg_temp.ref('handover')::uuid));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('9 nurse 1 sees the note; nurse 8 sees the counts only', 'Stable, watch fever (fictional)/true/null/true',
  (select (select patient->>'handoverNote' from jsonb_array_elements(answer->'patients') patient
            where patient->>'admissionId' = pg_temp.adm(1)::text)
     from pg_temp.run(1, format($s$select ehr.handover_read(%L, %L, %L)$s$, pg_temp.ward('General Ward'),
       pg_temp.ref('now-date'), pg_temp.shift_id('Now'))) answer) || '/'
  || (select (select (patient->>'noteHidden') || '/' || coalesce(patient->>'handoverNote', 'null') || '/'
                     || ((patient->>'openTasks')::integer >= 1)::text
                from jsonb_array_elements(answer->'patients') patient where patient->>'admissionId' = pg_temp.adm(1)::text)
        from pg_temp.run(8, format($s$select ehr.handover_read(%L, %L, %L)$s$, pg_temp.ward('General Ward'),
          pg_temp.ref('now-date'), pg_temp.shift_id('Now'))) answer));
select pg_temp.check_case('9 give', 'updated/given',
  (select pg_temp.o(answer) || '/' || (answer->'handover'->>'status') from pg_temp.run(1, format(
     $s$select ehr.handover_give(%L, 1, %L, %L)$s$, pg_temp.ref('handover'), pg_temp.key('h-give'), pg_temp.sha('h-give'))) answer));
select pg_temp.check_case('9 no note after it is given', 'not_draft',
  pg_temp.o(pg_temp.run(1, format($s$select ehr.handover_note_put(%L, %L, null, null, null, null, 'Late addition (fictional)',
    false, %L, %L)$s$, pg_temp.ref('handover'), pg_temp.adm(1), pg_temp.key('h-late'), pg_temp.sha('h-late')))));
select pg_temp.check_case('9 only a nurse of the next shift accepts', 'not_yours',
  pg_temp.o(pg_temp.run(8, format($s$select ehr.handover_accept(%L, 2, %L, %L)$s$, pg_temp.ref('handover'),
    pg_temp.key('h-acc-8'), pg_temp.sha('h-acc-8')))));
reset role;
select pg_temp.remember('next-name', (select name from ehr.clinical_shifts where id = split_part(pg_temp.ref('next-shift'), '|', 1)::uuid));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('9 nurse 8 is put on the next shift', 'updated',
  pg_temp.o(pg_temp.assign(1, pg_temp.ref('next-name'), split_part(pg_temp.ref('next-shift'), '|', 2)::date, 'General Ward', 0,
    jsonb_build_array(jsonb_build_object('membershipId', pg_temp.member(8), 'duty', 'nurse')), 'as-next')));
select pg_temp.check_case('9 and accepts', 'updated/accepted',
  (select pg_temp.o(answer) || '/' || (answer->'handover'->>'status') from pg_temp.run(8, format(
     $s$select ehr.handover_accept(%L, 2, %L, %L)$s$, pg_temp.ref('handover'), pg_temp.key('h-acc'), pg_temp.sha('h-acc'))) answer));
reset role;
select pg_temp.check_case('9 who is told of p1''s critical result (Q194): the doctor (also on call), nurse 8, the nurse in charge', 'allocated_nurse,nurse_in_charge,responsible_doctor',
  (select string_agg(recipient.why, ',' order by recipient.why) from ehr.admission_notice_recipients(pg_temp.adm(1)) recipient));
update ehr.inpatient_switches set enabled = true where key = 'ward_stay_access';
set local role hid_identity_api_runtime;
select pg_temp.check_case('9 ward-team access (on in this test only): nurse 8, allocated to p1 now, not on the staff list', 'opened',
  (select coalesce(answer->>'error', answer->>'outcome') from pg_temp.run(8, format(
     $s$select to_jsonb(opened) from identity.open_ward_stay(%L) opened$s$, pg_temp.adm(1))) answer));
select pg_temp.check_case('9 but not for p4, whom nobody allocated to them', 'refused',
  (select coalesce(answer->>'error', answer->>'outcome') from pg_temp.run(8, format(
     $s$select to_jsonb(opened) from identity.open_ward_stay(%L) opened$s$, pg_temp.adm(4))) answer));
reset role;
update ehr.inpatient_switches set enabled = false where key = 'ward_stay_access';

-- 6b. Discharge cancels the stay's open tasks.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('6 p2 discharged (DAMA): its open tasks are cancelled "Discharged"', 'updated/0',
  (select pg_temp.o(answer) || '/' || (select jsonb_array_length(list->'items') from pg_temp.run(1, format(
       $s$select ehr.nursing_task_list(null, %L, 'open', false)$s$, pg_temp.adm(2))) list)
     from pg_temp.run(2, format($s$select ehr.admission_discharge(%L, %s, 'dama', null, %L::jsonb, null, null, 'SIGN', %L, %L)$s$,
       pg_temp.adm(2), pg_temp.adm_version(2),
       '{"presentingProblem": "Fever (fictional)", "courseInHospital": "Left (fictional)"}', pg_temp.key('d-2'),
       pg_temp.sha('d-2'))) answer));
reset role;
select pg_temp.check_case('6 with the reason', 'cancelled/Discharged',
  (select status || '/' || cancel_reason from ehr.nursing_tasks where id = pg_temp.ref('t-wound')::uuid));

-- 10. No score anywhere; the runtime sees no table.
select pg_temp.check_case('10 no function computes a score', '0',
  (select count(*)::text from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'ehr' and (proc.proname ~* 'news|score|warning_score' or proc.prosrc ~* 'news2')));
select pg_temp.check_case('10 no runtime privilege on the new tables', '0',
  (select count(*)::text from pg_class class_row, lateral aclexplode(coalesce(class_row.relacl,
     acldefault('r', class_row.relowner))) acl
    where class_row.oid in ('ehr.medication_administrations'::regclass, 'ehr.nursing_requests'::regclass,
      'ehr.nursing_tasks'::regclass, 'ehr.fluid_balance_entries'::regclass, 'ehr.clinical_shifts'::regclass,
      'ehr.shift_assignments'::regclass, 'ehr.shift_patient_allocations'::regclass, 'ehr.shift_handovers'::regclass,
      'ehr.shift_handover_items'::regclass, 'ehr.facility_nursing_settings'::regclass,
      'ehr.shift_assignment_events'::regclass)
      and acl.grantee <> class_row.relowner));

-- 11. Audit.
select pg_temp.check_case('11 every round, task list and handover read has a row per patient shown', 'true',
  (select (count(*) filter (where action like '%.shown') > 0
           and count(*) filter (where action = 'ehr.mar.ward-round') > 0
           and count(*) filter (where action = 'ehr.handover.read') > 0)::text
     from audit.events where facility_id = 'a1740000-0000-4000-8000-000000000002'));
select pg_temp.check_case('11 every dose recorded is audited with its outcome and pharmacy state', 'true',
  (select bool_and(details ? 'pharmacyState' and details ? 'outcome')::text from audit.events
    where action = 'ehr.mar.record' and outcome = 'success'));
select pg_temp.check_case('11 no name, medicine, dose, value, note, task name or reason text in a nursing audit row', '0',
  (select count(*)::text from audit.events
    where (action like 'ehr.mar%' or action like 'ehr.nursing-task%' or action like 'ehr.fluid-balance%'
           or action like 'ehr.clinical-shift%' or action like 'ehr.shift-assignment%' or action like 'ehr.handover%'
           or action like 'ehr.observation-chart%')
      and (details::text ~* 'nursingperson|ifeoma|uche|HID-NU|ceftriaxone|paracetamol|fictional|observations|wound|stable|"quantity"|mmol'
           or coalesce(reason, '') <> '')));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.n_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0174-0177 nursing:\n%', mismatch;
  end if;
  raise notice '0174-0177 nursing: % cases passed', (select count(*) from pg_temp.n_outcomes);
end $$;

rollback;
