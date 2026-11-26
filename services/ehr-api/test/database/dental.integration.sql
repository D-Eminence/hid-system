\set ON_ERROR_STOP on
-- 0194-0196 (DEN-1, Release D; built at the recommended options Q-DEN-1 A to
-- Q-DEN-6 A, not yet answered by the owner): the dental clinic. Rollback-only.
-- The dental functions run as ehr-api's login role (hid_ehr_api_runtime) in
-- the context ehr-api's transactions set. Needs 0001-0153 with 0194 and 0195
-- applied (0196 or not) and the runtime roles bootstrapped. Fictional people,
-- places and identifiers only; ids start de1.
--
--   1. the caller: no dental code (nurse, doctor: Q-DEN-1 A; front desk), a
--      held membership, the wrong purpose, another facility, no consent, an
--      ended consent, a deny directive, a sealed demo or QA facility with a
--      real patient and a real facility with a sealed patient; each answered
--      refusal has its audit row;
--   2. the lists (route 1): four draft lists, 59 items, no audit row;
--   3. the visit rules: start, already started, another patient's visit,
--      another facility's, an emergency, an inpatient and a cancelled visit,
--      a completed one (writes refused, the follow-up allowed);
--   4. charts: versions, based-on, chart_changed, FDI and dentition checks,
--      surfaces only where the condition takes them, the active list,
--      entered in error only on the newest, the one before becoming newest;
--   5. procedures: plan, by name, every site rule, the anaesthetic rules
--      (Q-DEN-6 A), the done time, done at a later visit, cancel, entered in
--      error by the signer only (Q-DEN-4 A), the list;
--   6. idempotent replays, a reused key, version conflicts;
--   7. the follow-up window; the derived stage; the visits list and its
--      hiddenCount; the summary;
--   8. guards: DELETE, UPDATE and TRUNCATE refused on every append-only table
--      and every forbidden change refused, also for the owner's own
--      statements; the runtime reads no dental table and runs no helper;
--   9. audit: the rows and their outcomes; no finding, surface, code, name,
--      anaesthetic, note, reason, follow-up date, patient name, date of birth
--      or Health ID in any dental audit row.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.
begin;

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'dental-test'),
  ('emergency', 'Emergency care', 'dental-test')
  on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('de100000-0000-4000-8000-000000000001', 'Tooth Group A', 'tooth-group-a'),
  ('de100000-0000-4000-8000-000000000011', 'Tooth Group B', 'tooth-group-b'),
  ('de100000-0000-4000-8000-000000000021', 'Tooth Demo Group', 'tooth-demo-group'),
  ('de100000-0000-4000-8000-000000000031', 'Tooth QA Group', 'tooth-qa-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('de100000-0000-4000-8000-000000000002', 'de100000-0000-4000-8000-000000000001', 'Tooth Clinic A', 'TOOTH-A',
   'Africa/Lagos', true, 'verified'),
  ('de100000-0000-4000-8000-000000000012', 'de100000-0000-4000-8000-000000000011', 'Tooth Clinic B', 'TOOTH-B',
   'Africa/Lagos', true, 'verified'),
  ('de100000-0000-4000-8000-000000000022', 'de100000-0000-4000-8000-000000000021', 'Tooth Demo Clinic', 'TOOTH-D',
   'Africa/Lagos', true, 'verified'),
  ('de100000-0000-4000-8000-000000000032', 'de100000-0000-4000-8000-000000000031', 'Tooth QA Clinic', 'TOOTH-Q',
   'Africa/Lagos', true, 'verified');
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('facility', 'de100000-0000-4000-8000-000000000022');
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('facility', 'de100000-0000-4000-8000-000000000032');
create temporary table d_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into d_members values
  (1, 'de100000-0000-4000-8000-000000000002', 'de100000-0000-4000-8000-000000000001', 'dentist', 'Dami Dentist'),
  (2, 'de100000-0000-4000-8000-000000000002', 'de100000-0000-4000-8000-000000000001', 'dentist', 'Ebi Dentist'),
  (3, 'de100000-0000-4000-8000-000000000002', 'de100000-0000-4000-8000-000000000001', 'doctor', 'Chidi Doctor'),
  (4, 'de100000-0000-4000-8000-000000000002', 'de100000-0000-4000-8000-000000000001', 'nurse', 'Bola Nurse'),
  (5, 'de100000-0000-4000-8000-000000000002', 'de100000-0000-4000-8000-000000000001', 'receptionist', 'Ada Desk'),
  (6, 'de100000-0000-4000-8000-000000000012', 'de100000-0000-4000-8000-000000000011', 'dentist', 'Femi Dentist'),
  (7, 'de100000-0000-4000-8000-000000000002', 'de100000-0000-4000-8000-000000000001', 'dentist', 'Gbenga Dentist'),
  (8, 'de100000-0000-4000-8000-000000000022', 'de100000-0000-4000-8000-000000000021', 'dentist', 'Hauwa Dentist'),
  (9, 'de100000-0000-4000-8000-000000000032', 'de100000-0000-4000-8000-000000000031', 'dentist', 'Ife Dentist');
insert into auth.accounts (id, subject, email, display_name, status)
select ('de100100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:tooth-member-' || n,
  'tooth-member-' || n || '@example.invalid', name, 'active' from d_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('de100200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('de100100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'tooth-member-' || n || '@example.invalid', 'verified', role_code from d_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('de100300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('de100200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('de100100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, organization, facility, role_code, role_code,
  true, true
from d_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('de100100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
  ('de100300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, facility, 'Synthetic dental suite role'
from d_members;
-- Member 7's membership is held by the cutover.
update identity.staff_facility_memberships set migration_hold_reason = 'Synthetic cutover hold'
 where id = 'de100300-0000-4000-8000-000000000007';

-- Patients (Health IDs HID-DN + two letters): p1-p3, p6, p7 real; p4 with a deny directive; p5 sealed demo.
create temporary table d_patients (n integer primary key, hid text, first text, last text, sex text) on commit drop;
insert into d_patients values
  (1, 'HID-DNAA22', 'Ada', 'Toothone', 'female'), (2, 'HID-DNAB22', 'Bayo', 'Toothtwo', 'male'),
  (3, 'HID-DNAC22', 'Chika', 'Ooththree', 'female'), (4, 'HID-DNAD22', 'Dayo', 'Toothfour', 'male'),
  (5, 'HID-DNAE22', 'Ebere', 'Toothfive', 'female'), (6, 'HID-DNAF22', 'Funmi', 'Toothsix', 'female'),
  (7, 'HID-DNAG22', 'Gozie', 'Toothseven', 'male');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
select ('de100400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, hid, first, last, first || ' ' || last,
  sex, date '1990-05-14' + n, 'active', 'hid' from d_patients;
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('patient', 'de100400-0000-4000-8000-000000000005');
-- Consent: direct care, write_records (which also reads), for the dentists named; p3's has ended; dentist 1 also
-- holds one for p4 (whose deny directive wins) and p5 (sealed demo); dentist 6 at B, 8 at the demo clinic and 9 at
-- the QA clinic for p1 at their own facility; dentist 2 (not 1) for p7.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system)
select gen_random_uuid(), ('de100400-0000-4000-8000-0000000000' || lpad(grant_row.p::text, 2, '0'))::uuid,
  ('de100200-0000-4000-8000-0000000000' || lpad(grant_row.m::text, 2, '0'))::uuid,
  ('de100100-0000-4000-8000-0000000000' || lpad(grant_row.m::text, 2, '0'))::uuid,
  ('de100300-0000-4000-8000-0000000000' || lpad(grant_row.m::text, 2, '0'))::uuid,
  (select facility from d_members where d_members.n = grant_row.m), 'write_records', 'direct-care', grant_row.status,
  'Dental suite grant', clock_timestamp() - interval '3 hours',
  case when grant_row.status = 'active' then clock_timestamp() + interval '1 day' else clock_timestamp() - interval '1 hour' end,
  false, 'dental-suite-grant-' || grant_row.m || '-' || grant_row.p, 'hid'
from (values (1, 1, 'active'), (2, 1, 'active'), (1, 3, 'expired'), (1, 4, 'active'),
             (1, 5, 'active'), (1, 6, 'active'), (2, 6, 'active'), (2, 7, 'active'), (6, 1, 'active'), (8, 1, 'active'),
             (9, 1, 'active'), (7, 1, 'active'), (3, 1, 'active'), (4, 1, 'active')) grant_row(m, p, status);
insert into identity.consent_directives (id, patient_id, current_version)
values ('de100900-0000-4000-8000-000000000001', 'de100400-0000-4000-8000-000000000004', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  starts_at, grantee_type, actions, purposes, source_reference, reason, content_sha256)
values ('de100900-0000-4000-8000-000000000002', 'de100900-0000-4000-8000-000000000001',
  'de100400-0000-4000-8000-000000000004', 1, 'active', 'deny', clock_timestamp() - interval '1 day', 'all',
  array[]::text[], array[]::text[], 'dental-suite', 'The patient refuses all access', repeat('0', 64));
-- Visits: e1 p1@A ambulatory now; e2 p1@A ambulatory completed; e3 p1@A emergency; e4 p1@A inpatient; e5 p1@A
-- ambulatory cancelled; e6 p2@A ambulatory; e7 p1@B ambulatory; e8 p1@A ambulatory (a later visit); e9 p6@A
-- ambulatory; e10 p7@A ambulatory; e11 p4@A, e12 p5@A, e13 p3@A ambulatory; e14 p1@demo, e15 p1@QA ambulatory;
-- e16 p1@A ambulatory, open, with no dental record.
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, chief_complaint, created_at)
select ('de100800-0000-4000-8000-0000000000' || lpad(visit_row.e::text, 2, '0'))::uuid,
  ('de100400-0000-4000-8000-0000000000' || lpad(visit_row.p::text, 2, '0'))::uuid, visit_row.facility,
  ('de100100-0000-4000-8000-0000000000' || lpad(visit_row.m::text, 2, '0'))::uuid,
  ('de100300-0000-4000-8000-0000000000' || lpad(visit_row.m::text, 2, '0'))::uuid, visit_row.kind, visit_row.status,
  clock_timestamp() - interval '1 hour', 'Toothache, lower left', clock_timestamp() - interval '1 hour'
from (values (1, 1, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'in_progress'),
             (2, 1, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'in_progress'),
             (3, 1, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'emergency', 'in_progress'),
             (4, 1, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'inpatient', 'in_progress'),
             (5, 1, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'cancelled'),
             (6, 2, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'in_progress'),
             (7, 1, 6, 'de100000-0000-4000-8000-000000000012'::uuid, 'ambulatory', 'in_progress'),
             (8, 1, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'in_progress'),
             (9, 6, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'in_progress'),
             (10, 7, 2, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'in_progress'),
             (11, 4, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'in_progress'),
             (12, 5, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'in_progress'),
             (13, 3, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'in_progress'),
             (14, 1, 8, 'de100000-0000-4000-8000-000000000022'::uuid, 'ambulatory', 'in_progress'),
             (15, 1, 9, 'de100000-0000-4000-8000-000000000032'::uuid, 'ambulatory', 'in_progress'),
             (16, 1, 1, 'de100000-0000-4000-8000-000000000002'::uuid, 'ambulatory', 'in_progress'))
     visit_row(e, p, m, facility, kind, status);
update ehr.encounters set status = 'completed', ended_at = clock_timestamp() - interval '10 minutes'
 where id = 'de100800-0000-4000-8000-000000000002';
set local session_replication_role = origin;

create temporary table d_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
create temporary table d_refs (name text primary key, id uuid, version bigint) on commit drop;
grant select, insert, update on pg_temp.d_outcomes, pg_temp.d_refs to hid_ehr_api_runtime;
grant usage on sequence pg_temp.d_outcomes_seq_seq to hid_ehr_api_runtime;
grant select on pg_temp.d_members to hid_ehr_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.d_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.member(n integer) returns uuid language sql immutable as $f$
  select ('de100300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.patient(n integer) returns uuid language sql immutable as $f$
  select ('de100400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.enc(n integer) returns uuid language sql immutable as $f$
  select ('de100800-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.as_member(n integer, purpose text default 'direct-care') returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:tooth-member-' || n, true),
    set_config('app.membership_id', pg_temp.member(n)::text, true),
    set_config('app.facility_id', (select facility::text from pg_temp.d_members where d_members.n = as_member.n), true),
    set_config('app.correlation_id', 'dental-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;
create function pg_temp.key(label text) returns text language sql immutable as $f$
  select 'dental-suite-key-' || label
$f$;
create function pg_temp.sha(label text) returns text language sql immutable as $f$
  select encode(sha256(convert_to(label, 'UTF8')), 'hex')
$f$;
create function pg_temp.ref(ref_name text) returns uuid language sql as $f$
  select id from pg_temp.d_refs where name = ref_name
$f$;
create function pg_temp.ver(ref_name text) returns bigint language sql as $f$
  select version from pg_temp.d_refs where name = ref_name
$f$;
create function pg_temp.keep(ref_name text, value uuid, version bigint default null) returns void language sql as $f$
  insert into pg_temp.d_refs (name, id, version) values (ref_name, value, version)
  on conflict (name) do update set id = excluded.id, version = excluded.version
$f$;

-- One call, its answer in one line or its refusal (SQLSTATE and message).
create function pg_temp.start(n integer, p integer, e integer, label text) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_visit_start(pg_temp.patient(p), pg_temp.enc(e), pg_temp.key(label),
    pg_temp.sha('start' || p || '/' || e));
  if answer.visit is not null then
    perform pg_temp.keep('visit-e' || e, (answer.visit->>'visitId')::uuid, (answer.visit->>'rowVersion')::bigint);
  end if;
  return answer.outcome || '/' || answer.replayed || coalesce('/' || (answer.visit->>'stage'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.save(n integer, p integer, e integer, based text, dentition text, findings jsonb,
  note text, label text, ref_name text, body text default null) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_chart_save(pg_temp.patient(p), pg_temp.enc(e), pg_temp.ref(based), dentition,
    findings, note, pg_temp.key(label), pg_temp.sha(coalesce(body, 'save' || label)));
  if answer.chart is not null and ref_name is not null then
    perform pg_temp.keep(ref_name, (answer.chart->>'versionId')::uuid);
  end if;
  return answer.outcome || case when answer.chart is null then '' else '/' || answer.replayed end
    || coalesce('/' || (answer.chart->>'versionNo'), '') || coalesce('/' || jsonb_array_length(answer.chart->'findings'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.chart_error(n integer, p integer, ref_name text, reason text, label text) returns text
language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_chart_entered_in_error(pg_temp.patient(p), pg_temp.ref(ref_name), reason,
    pg_temp.key(label), pg_temp.sha('chart-error' || label));
  return answer.outcome || coalesce('/' || answer.replayed, '') || coalesce('/' || (answer.chart->>'versionNo'), '/none');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.chart_read(n integer, p integer, ref_name text default null) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_chart_read(pg_temp.patient(p), pg_temp.ref(ref_name));
  return answer.outcome || coalesce('/' || (answer.chart->>'versionNo'), '/none')
    || coalesce('/' || (select string_agg((version->>'versionNo') || case when (version->>'enteredInError')::boolean
                                           then 'x' else '' end, ',' order by ord)
                          from jsonb_array_elements(answer.versions) with ordinality listed(version, ord)), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.proc(n integer, p integer, e integer, status text, code text, name text, site text,
  tooth smallint, surfaces text, quadrant smallint, arch text, done_at timestamptz, agent text, other text,
  technique text, cartridges numeric, label text, ref_name text) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_procedure_record(pg_temp.patient(p), pg_temp.enc(e), status, code, name, site,
    tooth, surfaces, quadrant, arch, done_at, agent, other, technique, cartridges, 'Procedure note ' || label,
    pg_temp.key(label), pg_temp.sha('proc' || label));
  if answer.procedure is not null and ref_name is not null then
    perform pg_temp.keep(ref_name, (answer.procedure->>'procedureId')::uuid, (answer.procedure->>'rowVersion')::bigint);
  end if;
  return answer.outcome || case when answer.procedure is null then '' else '/' || answer.replayed end
    || coalesce('/' || (answer.procedure->>'status'), '')
    || coalesce('/' || (answer.procedure->>'site'), '') || coalesce('/' || (answer.procedure->>'byName'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.done(n integer, p integer, e integer, ref_name text, version bigint, agent text,
  technique text, cartridges numeric, label text, surfaces text default null) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_procedure_done(pg_temp.patient(p), pg_temp.enc(e), pg_temp.ref(ref_name),
    version, null, agent, null, technique, cartridges, surfaces is not null, surfaces, false, null,
    pg_temp.key(label), pg_temp.sha('done' || label));
  if answer.procedure is not null then
    perform pg_temp.keep(ref_name, (answer.procedure->>'procedureId')::uuid, (answer.procedure->>'rowVersion')::bigint);
  end if;
  return answer.outcome || case when answer.procedure is null then '' else '/' || answer.replayed end
    || coalesce('/' || (answer.procedure->>'status'), '')
    || coalesce('/' || right(answer.procedure->>'doneEncounterId', 2), '')
    || coalesce('/' || (answer.procedure->>'surfaces'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.cancel(n integer, p integer, ref_name text, version bigint, reason text, label text)
returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_procedure_cancel(pg_temp.patient(p), pg_temp.ref(ref_name), version, reason,
    pg_temp.key(label), pg_temp.sha('cancel' || label));
  if answer.procedure is not null then
    perform pg_temp.keep(ref_name, (answer.procedure->>'procedureId')::uuid, (answer.procedure->>'rowVersion')::bigint);
  end if;
  return answer.outcome || case when answer.procedure is null then '' else '/' || answer.replayed end
    || coalesce('/' || (answer.procedure->>'status'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.proc_error(n integer, p integer, ref_name text, version bigint, reason text, label text)
returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_procedure_entered_in_error(pg_temp.patient(p), pg_temp.ref(ref_name), version,
    reason, pg_temp.key(label), pg_temp.sha('proc-error' || label));
  if answer.procedure is not null then
    perform pg_temp.keep(ref_name, (answer.procedure->>'procedureId')::uuid, (answer.procedure->>'rowVersion')::bigint);
  end if;
  return answer.outcome || case when answer.procedure is null then '' else '/' || answer.replayed end
    || coalesce('/' || (answer.procedure->>'status'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.follow(n integer, p integer, e integer, version bigint, set_on boolean, on_date date,
  set_note boolean, note text, label text) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_visit_follow_up(pg_temp.patient(p), pg_temp.enc(e), version, set_on, on_date,
    set_note, note, pg_temp.key(label), pg_temp.sha('follow' || label));
  return answer.outcome || case when answer.visit is null then '' else '/' || answer.replayed end
    || coalesce('/' || (answer.visit->>'rowVersion'), '')
    || case when answer.visit is null then '' else '/' || coalesce(answer.visit->>'followUpOn', '-') end;
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.visit_read(n integer, p integer, e integer) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_visit_read(pg_temp.patient(p), pg_temp.enc(e));
  return answer.outcome || coalesce('/' || (answer.visit->>'stage'), '') || coalesce('/' || (answer.chart->>'versionNo'), '/none')
    || coalesce('/' || jsonb_array_length(answer.chart_versions_this_visit) || '/' || jsonb_array_length(answer.planned_procedures)
                || '/' || jsonb_array_length(answer.done_this_visit), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.procs(n integer, p integer, status text) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.as_member(n);
  select * into answer from ehr.dental_procedures_list(pg_temp.patient(p), status);
  return answer.outcome || coalesce('/' || (select string_agg(item->>'status', ',' order by ord)
                                             from jsonb_array_elements(answer.items) with ordinality listed(item, ord)), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.try(n integer, statement text, purpose text default 'direct-care') returns text
language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_member(n, purpose);
  execute statement into answer;
  return answer;
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
-- The suite's own lookups read the tables as the cluster's superuser.
create function pg_temp.procedure_state(ref_name text) returns text language sql as $f$
  select status || '/' || row_version || '/' || coalesce(right(done_encounter_id::text, 2), '-')
    from ehr.dental_procedures where id = pg_temp.ref(ref_name)
$f$;

-- 1. The caller.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('1 a nurse has no dental code (lists)', '42501 DENTAL_NOT_ALLOWED',
  pg_temp.try(4, 'select count(*)::text from ehr.dental_lists()'));
select pg_temp.check_case('1 a nurse with the patient''s consent cannot start the dental record', '42501 DENTAL_NOT_ALLOWED',
  pg_temp.start(4, 1, 1, 'nurse-start-0001'));
select pg_temp.check_case('1 a doctor with the patient''s consent cannot read the chart (Q-DEN-1 A)', '42501 DENTAL_NOT_ALLOWED',
  pg_temp.chart_read(3, 1));
select pg_temp.check_case('1 the front desk cannot list dental visits', '42501 DENTAL_NOT_ALLOWED',
  pg_temp.try(5, 'select count(*)::text from ehr.dental_visits_list(1)'));
select pg_temp.check_case('1 a held membership is refused', '42501 DENTAL_NOT_ALLOWED', pg_temp.chart_read(7, 1));
select pg_temp.check_case('1 emergency purpose is refused', '22023 DENTAL_DIRECT_CARE_ONLY',
  pg_temp.try(1, 'select count(*)::text from ehr.dental_lists()', 'emergency'));
select pg_temp.check_case('1 another facility''s dentist (consent there): the visit is not found there', 'encounter_not_found/false',
  pg_temp.try(6, format('select outcome || ''/'' || replayed from ehr.dental_visit_start(%L, %L, %L, %L)',
    pg_temp.patient(1), pg_temp.enc(1), pg_temp.key('b-start-0001'), pg_temp.sha('b-start'))));
select pg_temp.check_case('1 no consent', 'consent_required/false', pg_temp.start(1, 2, 6, 'no-consent-0001'));
select pg_temp.check_case('1 an ended consent', 'consent_required/false', pg_temp.start(1, 3, 13, 'ended-0001'));
select pg_temp.check_case('1 a deny directive', 'consent_required/false', pg_temp.start(1, 4, 11, 'deny-0001'));
select pg_temp.check_case('1 a sealed demo patient at a real facility', 'consent_required/false',
  pg_temp.start(1, 5, 12, 'sealed-patient-0001'));
select pg_temp.check_case('1 a sealed demo facility and a real patient', 'consent_required/false',
  pg_temp.start(8, 1, 14, 'sealed-demo-0001'));
select pg_temp.check_case('1 a sealed QA facility and a real patient', 'consent_required/false',
  pg_temp.start(9, 1, 15, 'sealed-qa-0001'));
select pg_temp.check_case('1 reads refuse without consent too', 'consent_required/none',
  pg_temp.chart_read(1, 2));
select pg_temp.check_case('1 a bad Idempotency-Key is refused before anything', '22023 DENTAL_IDEMPOTENCY_KEY_INVALID',
  pg_temp.try(1, format('select outcome from ehr.dental_visit_start(%L, %L, %L, %L)', pg_temp.patient(1),
    pg_temp.enc(1), 'short', pg_temp.sha('x'))));
reset role;
select pg_temp.check_case('1 each answered refusal has a denied audit row with the patient',
  'consent_required:7,encounter_not_found:1', (select string_agg(refusal || ':' || n, ',' order by refusal) from (
    select details->>'refusal' as refusal, count(*) as n from audit.events
     where action like 'ehr.dental.%' and outcome = 'denied' group by 1) counted));
select pg_temp.check_case('1 the raised refusals wrote no dental audit row', '0',
  (select count(*)::text from audit.events where action like 'ehr.dental.%' and outcome <> 'denied'));

-- 2. The lists.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 four draft lists, 59 items', 'anaesthetic:8:draft,anaesthetic_technique:5:draft,procedure:30:draft,tooth_condition:16:draft',
  pg_temp.try(1, $q$select string_agg(kind || ':' || n || ':' || status, ',' order by kind) from (
      select kind, count(*) as n, min(status) as status from ehr.dental_lists() group by kind) listed$q$));
select pg_temp.check_case('2 four conditions take surfaces; DEN-021 is a composite filling on tooth surfaces',
  '4|DEN-021 Composite filling restorative tooth_surfaces',
  pg_temp.try(1, $q$select (select count(*) from ehr.dental_lists() where takes_surfaces)::text || '|'
      || (select code || ' ' || label || ' ' || category || ' ' || site from ehr.dental_lists() where code = 'DEN-021')$q$));
select pg_temp.check_case('2 no ADA CDT code (D followed by four digits) in any list', '0',
  pg_temp.try(1, $q$select count(*)::text from ehr.dental_lists() where code ~ '^D[0-9]{4}$' or label ~* 'CDT|ADA'$q$));
reset role;
select pg_temp.check_case('2 the lists wrote no audit row', '0',
  (select count(*)::text from audit.events where action like 'ehr.dental.list%'));

-- 3. The visit rules.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 start on the open outpatient visit', 'started/false/started', pg_temp.start(1, 1, 1, 'start-e1-0001'));
select pg_temp.check_case('3 the same request again is a replay', 'started/true/started', pg_temp.start(1, 1, 1, 'start-e1-0001'));
select pg_temp.check_case('3 another dentist starts it again: already started', 'already_started/false/started',
  pg_temp.start(2, 1, 1, 'start-e1-0002'));
select pg_temp.check_case('3 the same key with another body', 'key_reused/false',
  pg_temp.start(1, 1, 8, 'start-e1-0001'));
select pg_temp.check_case('3 another patient''s visit', 'encounter_not_found/false', pg_temp.start(1, 1, 6, 'other-patient-0001'));
select pg_temp.check_case('3 another facility''s visit', 'encounter_not_found/false', pg_temp.start(1, 1, 7, 'other-facility-0001'));
select pg_temp.check_case('3 an emergency visit', 'visit_encounter_invalid/false', pg_temp.start(1, 1, 3, 'emergency-0001'));
select pg_temp.check_case('3 an inpatient visit', 'visit_encounter_invalid/false', pg_temp.start(1, 1, 4, 'inpatient-0001'));
select pg_temp.check_case('3 a cancelled visit', 'visit_encounter_invalid/false', pg_temp.start(1, 1, 5, 'cancelled-0001'));
select pg_temp.check_case('3 a completed visit', 'visit_closed/false', pg_temp.start(1, 1, 2, 'completed-0001'));
select pg_temp.check_case('3 reading a visit with no dental record', 'visit_not_found/none', pg_temp.visit_read(1, 1, 2));
select pg_temp.check_case('3 reading the started visit', 'found/started/none/0/0/0', pg_temp.visit_read(1, 1, 1));
select pg_temp.check_case('3 a chart on a visit whose record was not started', 'visit_not_started',
  pg_temp.save(1, 6, 9, null, 'permanent', '[]', null, 'save-e9-0001', null));
select pg_temp.check_case('3 later visit e8 started', 'started/false/started', pg_temp.start(1, 1, 8, 'start-e8-0001'));
select pg_temp.check_case('3 p6''s visit e9 started by dentist 2', 'started/false/started', pg_temp.start(2, 6, 9, 'start-e9-0001'));
select pg_temp.check_case('3 p7''s visit e10 started by dentist 2', 'started/false/started', pg_temp.start(2, 7, 10, 'start-e10-0001'));

-- 4. Charts.
select pg_temp.check_case('4 the first chart', 'saved/false/1/3',
  pg_temp.save(1, 1, 1, null, 'permanent', '[{"tooth": 36, "condition": "decayed", "surfaces": "MO", "note": null},
    {"tooth": 46, "condition": "missing", "surfaces": null, "note": "Extracted elsewhere"},
    {"tooth": 11, "condition": "crowned"}]', 'Generalised plaque', 'save-1', 'v1'));
select pg_temp.check_case('4 a save not based on the newest: chart_changed', 'chart_changed',
  pg_temp.save(2, 1, 1, null, 'permanent', '[]', null, 'save-stale-0001', null));
select pg_temp.check_case('4 the second chart, based on the first', 'saved/false/2/1',
  pg_temp.save(1, 1, 1, 'v1', 'mixed', '[{"tooth": 55, "condition": "decayed", "surfaces": "O"}]', null, 'save-2', 'v2'));
select pg_temp.check_case('4 the second dentist, still based on the first: chart_changed (two saves, one wins)', 'chart_changed',
  pg_temp.save(2, 1, 1, 'v1', 'permanent', '[]', null, 'save-race-0001', null));
select pg_temp.check_case('4 a tooth outside FDI', '22023 DENTAL_TOOTH_INVALID',
  pg_temp.save(1, 1, 1, 'v2', 'permanent', '[{"tooth": 19, "condition": "missing"}]', null, 'tooth-19-0001', null));
select pg_temp.check_case('4 a primary tooth in a permanent chart', '22023 DENTAL_TOOTH_INVALID',
  pg_temp.save(1, 1, 1, 'v2', 'permanent', '[{"tooth": 55, "condition": "missing"}]', null, 'tooth-55-0001', null));
select pg_temp.check_case('4 a permanent tooth in a primary chart', '22023 DENTAL_TOOTH_INVALID',
  pg_temp.save(1, 1, 1, 'v2', 'primary', '[{"tooth": 36, "condition": "missing"}]', null, 'tooth-36-0001', null));
select pg_temp.check_case('4 surfaces on a condition that takes none', '22023 DENTAL_SURFACES_INVALID',
  pg_temp.save(1, 1, 1, 'v2', 'permanent', '[{"tooth": 36, "condition": "missing", "surfaces": "M"}]', null,
    'surf-missing-0001', null));
select pg_temp.check_case('4 no surfaces on a condition that takes them', '22023 DENTAL_SURFACES_INVALID',
  pg_temp.save(1, 1, 1, 'v2', 'permanent', '[{"tooth": 36, "condition": "decayed"}]', null, 'surf-none-0001', null));
select pg_temp.check_case('4 surfaces out of order or repeated', '22023 DENTAL_SURFACES_INVALID|22023 DENTAL_SURFACES_INVALID',
  pg_temp.save(1, 1, 1, 'v2', 'permanent', '[{"tooth": 36, "condition": "decayed", "surfaces": "OM"}]', null, 'surf-om-0001', null)
  || '|' || pg_temp.save(1, 1, 1, 'v2', 'permanent', '[{"tooth": 36, "condition": "decayed", "surfaces": "MM"}]', null,
    'surf-mm-0001', null));
select pg_temp.check_case('4 a condition not on the list', '22023 DENTAL_CONDITION_INVALID',
  pg_temp.save(1, 1, 1, 'v2', 'permanent', '[{"tooth": 36, "condition": "caries_deep"}]', null, 'cond-0001', null));
select pg_temp.check_case('4 one finding per tooth and condition', '22023 DENTAL_VALIDATION',
  pg_temp.save(1, 1, 1, 'v2', 'permanent', '[{"tooth": 36, "condition": "missing"}, {"tooth": 36, "condition": "missing"}]',
    null, 'dup-0001', null));
select pg_temp.check_case('4 an unknown finding field', '22023 DENTAL_VALIDATION',
  pg_temp.save(1, 1, 1, 'v2', 'permanent', '[{"tooth": 36, "condition": "missing", "colour": "grey"}]', null, 'field-0001', null));
select pg_temp.check_case('4 a third chart', 'saved/false/3/0',
  pg_temp.save(1, 1, 1, 'v2', 'permanent', '[]', 'All teeth sound', 'save-3', 'v3'));
select pg_temp.check_case('4 entered in error: not the newest', 'chart_not_latest/false/none',
  pg_temp.chart_error(1, 1, 'v1', 'Charted the wrong patient by mistake', 'err-v1-0001'));
select pg_temp.check_case('4 entered in error: a short reason', '22023 DENTAL_REASON_REQUIRED',
  pg_temp.chart_error(1, 1, 'v3', 'short', 'err-short-0001'));
select pg_temp.check_case('4 entered in error: another patient''s version', 'chart_not_found/false/none',
  pg_temp.chart_error(2, 6, 'v3', 'Charted the wrong patient by mistake', 'err-other-0001'));
select pg_temp.check_case('4 entered in error on the newest: the one before is the newest again', 'updated/false/2',
  pg_temp.chart_error(1, 1, 'v3', 'Charted the wrong patient by mistake', 'err-v3-0001'));
select pg_temp.check_case('4 the same request again is a replay', 'updated/true/2',
  pg_temp.chart_error(1, 1, 'v3', 'Charted the wrong patient by mistake', 'err-v3-0001'));
select pg_temp.check_case('4 a version marked in error is never the newest again', 'chart_not_latest/false/none',
  pg_temp.chart_error(1, 1, 'v3', 'Charted the wrong patient by mistake', 'err-v3-0002'));
select pg_temp.check_case('4 a save based on version 3 (in error) is chart_changed; based on 2 it is version 4',
  'chart_changed|saved/false/4/1',
  pg_temp.save(1, 1, 1, 'v3', 'permanent', '[]', null, 'save-on-3-0001', null) || '|'
  || pg_temp.save(1, 1, 1, 'v2', 'permanent', '[{"tooth": 21, "condition": "fractured", "surfaces": "DB"}]', null,
       'save-4', 'v4'));
select pg_temp.check_case('4 the chart read: newest 4, versions 4,3x,2,1', 'found/4/4,3x,2,1', pg_temp.chart_read(1, 1));
select pg_temp.check_case('4 one version by id', 'found/1/4,3x,2,1', pg_temp.chart_read(1, 1, 'v1'));
select pg_temp.check_case('4 another facility''s dentist reads no chart of this facility', 'found/none/',
  pg_temp.try(6, format($q$select outcome || '/' || coalesce(chart->>'versionNo', 'none') || '/'
      || coalesce((select string_agg(v->>'versionNo', ',') from jsonb_array_elements(versions) v), '')
      from ehr.dental_chart_read(%L, null)$q$, pg_temp.patient(1))));
select pg_temp.check_case('4 another facility''s version by id', 'chart_not_found',
  pg_temp.try(6, format('select outcome from ehr.dental_chart_read(%L, %L)', pg_temp.patient(1), pg_temp.ref('v1'))));
select pg_temp.check_case('4 a replay of the first save answers version 1', 'saved/true/1/3',
  pg_temp.save(1, 1, 1, null, 'permanent', '[{"tooth": 36, "condition": "decayed", "surfaces": "MO", "note": null},
    {"tooth": 46, "condition": "missing", "surfaces": null, "note": "Extracted elsewhere"},
    {"tooth": 11, "condition": "crowned"}]', 'Generalised plaque', 'save-1', null));
select pg_temp.check_case('4 the same key, another body', 'key_reused',
  pg_temp.save(1, 1, 1, 'v4', 'permanent', '[]', null, 'save-1', null, 'another body'));
select pg_temp.check_case('4 a chart key used for a visit start', 'key_reused/false', pg_temp.start(1, 1, 1, 'save-4'));

-- 5. Procedures.
select pg_temp.check_case('5 plan a listed filling on 36 MO', 'recorded/false/planned/tooth_surfaces/false',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-021', null, null, 36::smallint, 'MO', null, null, null, null, null, null, null,
    'plan-1', 'pr1'));
select pg_temp.check_case('5 plan by name (Q-DEN-5 A) on the whole mouth', 'recorded/false/planned/whole_mouth/true',
  pg_temp.proc(1, 1, 1, 'planned', null, 'Gum massage', 'whole_mouth', null, null, null, null, null, null, null, null,
    null, 'plan-2', 'pr2'));
select pg_temp.check_case('5 plan a scaling to cancel later', 'recorded/false/planned/whole_mouth/false',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-015', null, null, null, null, null, null, null, null, null, null, null,
    'plan-3', 'pr3'));
select pg_temp.check_case('5 a code and a name', '22023 DENTAL_PROCEDURE_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-021', 'Filling', null, 36::smallint, 'MO', null, null, null, null, null, null,
    null, 'both-0001', null));
select pg_temp.check_case('5 neither a code nor a name', '22023 DENTAL_PROCEDURE_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', null, null, 'tooth', 36::smallint, null, null, null, null, null, null, null, null,
    'neither-0001', null));
select pg_temp.check_case('5 a code not on the list', '22023 DENTAL_PROCEDURE_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-999', null, null, 36::smallint, null, null, null, null, null, null, null, null,
    'den999-0001', null));
select pg_temp.check_case('5 a listed code with another site', '22023 DENTAL_SITE_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-021', null, 'tooth', 36::smallint, null, null, null, null, null, null, null,
    null, 'site-0001', null));
select pg_temp.check_case('5 a tooth_surfaces procedure without surfaces', '22023 DENTAL_SITE_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-021', null, null, 36::smallint, null, null, null, null, null, null, null, null,
    'site-0002', null));
select pg_temp.check_case('5 a by-name procedure without a site', '22023 DENTAL_SITE_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', null, 'Something', null, 36::smallint, null, null, null, null, null, null, null,
    null, 'site-0003', null));
select pg_temp.check_case('5 a quadrant procedure with a tooth', '22023 DENTAL_SITE_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-016', null, null, 36::smallint, null, 3::smallint, null, null, null, null, null,
    null, 'site-0004', null));
select pg_temp.check_case('5 quadrant 5', '22023 DENTAL_SITE_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-016', null, null, null, null, 5::smallint, null, null, null, null, null, null,
    'site-0005', null));
select pg_temp.check_case('5 an arch that is not upper or lower', '22023 DENTAL_SITE_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-052', null, null, null, null, null, 'left', null, null, null, null, null,
    'site-0006', null));
select pg_temp.check_case('5 a tooth outside FDI', '22023 DENTAL_TOOTH_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-040', null, null, 49::smallint, null, null, null, null, null, null, null, null,
    'tooth-0001', null));
select pg_temp.check_case('5 bad surfaces', '22023 DENTAL_SURFACES_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-021', null, null, 36::smallint, 'OX', null, null, null, null, null, null, null,
    'surf-0001', null));
select pg_temp.check_case('5 an anaesthetic on a planned procedure', '22023 DENTAL_ANAESTHETIC_INVALID',
  pg_temp.proc(1, 1, 1, 'planned', 'DEN-040', null, null, 38::smallint, null, null, null, null, 'none', null, null,
    null, 'an-0001', null));
select pg_temp.check_case('5 done without an anaesthetic (Q-DEN-6 A)', '22023 DENTAL_ANAESTHETIC_INVALID',
  pg_temp.proc(1, 1, 1, 'done', 'DEN-040', null, null, 38::smallint, null, null, null, null, null, null, null, null,
    'an-0002', null));
select pg_temp.check_case('5 none with a technique', '22023 DENTAL_ANAESTHETIC_INVALID',
  pg_temp.proc(1, 1, 1, 'done', 'DEN-040', null, null, 38::smallint, null, null, null, null, 'none', null,
    'infiltration', null, 'an-0003', null));
select pg_temp.check_case('5 an agent without cartridges', '22023 DENTAL_ANAESTHETIC_INVALID',
  pg_temp.proc(1, 1, 1, 'done', 'DEN-040', null, null, 38::smallint, null, null, null, null, 'lidocaine_2_adrenaline',
    null, 'inferior_alveolar_block', null, 'an-0004', null));
select pg_temp.check_case('5 0.3 cartridges', '22023 DENTAL_ANAESTHETIC_INVALID',
  pg_temp.proc(1, 1, 1, 'done', 'DEN-040', null, null, 38::smallint, null, null, null, null, 'lidocaine_2_adrenaline',
    null, 'inferior_alveolar_block', 0.3, 'an-0005', null));
select pg_temp.check_case('5 other without its name', '22023 DENTAL_ANAESTHETIC_INVALID',
  pg_temp.proc(1, 1, 1, 'done', 'DEN-040', null, null, 38::smallint, null, null, null, null, 'other', null,
    'infiltration', 1, 'an-0006', null));
select pg_temp.check_case('5 an agent not on the list', '22023 DENTAL_ANAESTHETIC_INVALID',
  pg_temp.proc(1, 1, 1, 'done', 'DEN-040', null, null, 38::smallint, null, null, null, null, 'cocaine_10', null,
    'infiltration', 1, 'an-0007', null));
select pg_temp.check_case('5 done before the visit started', '22023 DENTAL_DONE_TIME_INVALID',
  pg_temp.proc(1, 1, 1, 'done', 'DEN-040', null, null, 38::smallint, null, null, null,
    clock_timestamp() - interval '2 hours', 'none', null, null, null, 'time-0001', null));
select pg_temp.check_case('5 done in the future', '22023 DENTAL_DONE_TIME_INVALID',
  pg_temp.proc(1, 1, 1, 'done', 'DEN-040', null, null, 38::smallint, null, null, null,
    clock_timestamp() + interval '10 minutes', 'none', null, null, null, 'time-0002', null));
select pg_temp.check_case('5 a simple extraction done and signed with an inferior alveolar block',
  'recorded/false/done/tooth/false',
  pg_temp.proc(1, 1, 1, 'done', 'DEN-040', null, null, 38::smallint, null, null, null, null, 'lidocaine_2_adrenaline',
    null, 'inferior_alveolar_block', 1.5, 'done-1', 'pr4'));
select pg_temp.check_case('5 a by-name procedure done with no local anaesthetic, on an arch', 'recorded/false/done/arch/true',
  pg_temp.proc(1, 1, 1, 'done', null, 'Denture adjustment', 'arch', null, null, null, 'upper', null, 'none', null, null,
    null, 'done-2', 'pr5'));
select pg_temp.check_case('5 an agent named other', 'recorded/false/done/quadrant/false',
  pg_temp.proc(1, 1, 1, 'done', 'DEN-016', null, null, null, null, 2::smallint, null, null, 'other', 'Bupivacaine 0.5%',
    'infiltration', 2, 'done-3', 'pr6'));
select pg_temp.check_case('5 the answer names the agent and technique as listed',
  'Lidocaine 2% with adrenaline 1:80,000|Inferior alveolar nerve block|1.5|Simple extraction|HID-DENT-2026-11-DRAFT|draft',
  pg_temp.try(1, format($q$select (p->'anaesthetic'->>'agentName') || '|' || (p->'anaesthetic'->>'techniqueName') || '|'
      || (p->'anaesthetic'->>'cartridges') || '|' || (p->>'procedureName') || '|' || (p->>'listVersion') || '|'
      || (p->>'listStatus')
      from ehr.dental_procedures_list(%L, 'done') listed, jsonb_array_elements(listed.items) p
     where p->>'procedureId' = %L$q$, pg_temp.patient(1), pg_temp.ref('pr4'))));
-- Done at a later visit: planned on e1, done on e8.
select pg_temp.check_case('5 a planned filling done at a later visit, surfaces refined', 'updated/false/done/08/MOD',
  pg_temp.done(1, 1, 8, 'pr1', 1, 'articaine_4_adrenaline', 'infiltration', 1, 'done-later-1', 'MOD'));
select pg_temp.check_case('5 done again: not planned', 'procedure_not_planned',
  pg_temp.done(1, 1, 8, 'pr1', 2, 'none', null, null, 'done-again-0001'));
select pg_temp.check_case('5 a stale row version', 'version_conflict',
  pg_temp.done(1, 1, 8, 'pr2', 9, 'none', null, null, 'done-stale-0001'));
select pg_temp.check_case('5 refining surfaces of a whole-mouth procedure', '22023 DENTAL_SURFACES_INVALID',
  pg_temp.done(1, 1, 8, 'pr2', 1, 'none', null, null, 'done-surf-0001', 'M'));
select pg_temp.check_case('5 done on a visit whose record was not started', 'visit_not_started',
  pg_temp.try(1, format($q$select outcome from ehr.dental_procedure_done(%L, %L, %L, 1, null, 'none', null, null, null,
      false, null, false, null, %L, %L)$q$, pg_temp.patient(1), pg_temp.enc(16), pg_temp.ref('pr2'),
    pg_temp.key('done-e2-0001'), pg_temp.sha('done-e2'))));
select pg_temp.check_case('5 cancel a planned procedure', 'updated/false/cancelled',
  pg_temp.cancel(1, 1, 'pr3', 1, 'Patient chose to wait for now', 'cancel-1'));
select pg_temp.check_case('5 cancel again: not planned', 'procedure_not_planned',
  pg_temp.cancel(1, 1, 'pr3', 2, 'Patient chose to wait for now', 'cancel-2'));
select pg_temp.check_case('5 cancel a done procedure: not planned', 'procedure_not_planned',
  pg_temp.cancel(1, 1, 'pr4', 1, 'Patient chose to wait for now', 'cancel-3'));
select pg_temp.check_case('5 cancel with a short reason', '22023 DENTAL_REASON_REQUIRED',
  pg_temp.cancel(1, 1, 'pr2', 1, 'no', 'cancel-4'));
select pg_temp.check_case('5 another dentist cannot mark a signed procedure in error (Q-DEN-4 A)', 'not_signer',
  pg_temp.proc_error(2, 1, 'pr4', 1, 'Recorded on the wrong tooth', 'err-pr4-2'));
select pg_temp.check_case('5 a planned procedure cannot be marked in error', 'procedure_not_done',
  pg_temp.proc_error(1, 1, 'pr2', 1, 'Recorded on the wrong tooth', 'err-pr2-1'));
select pg_temp.check_case('5 the signer with a stale version', 'version_conflict',
  pg_temp.proc_error(1, 1, 'pr4', 7, 'Recorded on the wrong tooth', 'err-pr4-stale'));
select pg_temp.check_case('5 the signer marks it in error', 'updated/false/entered_in_error',
  pg_temp.proc_error(1, 1, 'pr4', 1, 'Recorded on the wrong tooth', 'err-pr4-1'));
select pg_temp.check_case('5 a replay of the mark', 'updated/true/entered_in_error',
  pg_temp.proc_error(1, 1, 'pr4', 1, 'Recorded on the wrong tooth', 'err-pr4-1'));
select pg_temp.check_case('5 another facility''s dentist (consent there) cannot find the procedure', 'procedure_not_found',
  pg_temp.try(6, format('select outcome from ehr.dental_procedure_cancel(%L, %L, 1, %L, %L, %L)', pg_temp.patient(1),
    pg_temp.ref('pr2'), 'Patient chose to wait for now', pg_temp.key('b-cancel-0001'), pg_temp.sha('b-cancel'))));
select pg_temp.check_case('5 the list: planned, done, all (newest first)',
  'found/planned|found/done,done,done|found/done,done,entered_in_error,cancelled,planned,done',
  pg_temp.procs(1, 1, 'planned') || '|' || pg_temp.procs(1, 1, 'done') || '|' || pg_temp.procs(1, 1, 'all'));
select pg_temp.check_case('5 a status that is not planned, done or all', '22023 DENTAL_VALIDATION',
  pg_temp.procs(1, 1, 'cancelled'));

-- 6. The visit read, the stage, the follow-up, the list, the summary.
select pg_temp.check_case('6 e1: treated (done here), newest chart 4, four versions here, one planned, three done here',
  'found/treated/4/4/1/3', pg_temp.visit_read(1, 1, 1));
select pg_temp.check_case('6 e8: treated (the filling done here)', 'found/treated/4/0/1/1', pg_temp.visit_read(1, 1, 8));
select pg_temp.check_case('6 e9: started (nothing recorded)', 'found/started/none/0/0/0', pg_temp.visit_read(2, 6, 9));
select pg_temp.check_case('6 a follow-up today is refused', '22023 DENTAL_FOLLOW_UP_INVALID',
  pg_temp.follow(1, 1, 1, 1, true, (clock_timestamp() at time zone 'Africa/Lagos')::date, false, null, 'follow-today'));
select pg_temp.check_case('6 a follow-up after two years is refused', '22023 DENTAL_FOLLOW_UP_INVALID',
  pg_temp.follow(1, 1, 1, 1, true, ((clock_timestamp() at time zone 'Africa/Lagos')::date + interval '2 years 1 day')::date,
    false, null, 'follow-late'));
select pg_temp.check_case('6 neither field', '22023 DENTAL_VALIDATION',
  pg_temp.follow(1, 1, 1, 1, false, null, false, null, 'follow-none'));
select pg_temp.check_case('6 set the follow-up in six months',
  'updated/false/2/' || (((clock_timestamp() at time zone 'Africa/Lagos')::date + interval '6 months')::date)::text,
  pg_temp.follow(1, 1, 1, 1, true, ((clock_timestamp() at time zone 'Africa/Lagos')::date + interval '6 months')::date,
    true, 'Recall for scaling and polishing in six months', 'follow-1'));
select pg_temp.check_case('6 a stale version', 'version_conflict',
  pg_temp.follow(1, 1, 1, 1, false, null, true, 'Recall soon please', 'follow-2'));
reset role;
set local session_replication_role = replica;
update ehr.encounters set status = 'completed', ended_at = clock_timestamp() where id = pg_temp.enc(8);
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.check_case('6 a completed visit: completed stage; chart and procedures refused; follow-up allowed',
  'found/completed/4/0/1/1|visit_closed|visit_closed|updated/false/2/-',
  pg_temp.visit_read(1, 1, 8) || '|'
  || pg_temp.save(1, 1, 8, 'v4', 'permanent', '[]', null, 'save-e8-closed', null) || '|'
  || pg_temp.proc(1, 1, 8, 'planned', 'DEN-001', null, null, null, null, null, null, null, null, null, null, null,
       'plan-e8-closed', null) || '|'
  || pg_temp.follow(1, 1, 8, 1, false, null, true, 'Review the filling in a month', 'follow-e8'));
select pg_temp.check_case('6 the visits list (today): dentist 1 sees p1''s two and p6''s; p7''s is hidden',
  '3:1:false:Ada Toothone,Ada Toothone,Funmi Toothsix',
  pg_temp.try(1, $q$select count(visit)::text || ':' || min(hidden_count) || ':' || bool_or(has_more) || ':'
      || string_agg(patient->>'fullName', ',' order by patient->>'fullName') from ehr.dental_visits_list(1)$q$));
select pg_temp.check_case('6 the card names the last 4 characters of the Health ID only', 'AA22/1990-05-15/female',
  pg_temp.try(1, $q$select (patient->>'healthIdLast4') || '/' || (patient->>'dateOfBirth') || '/' || (patient->>'sex')
      from ehr.dental_visits_list(30) where patient->>'patientId' = 'de100400-0000-4000-8000-000000000001' limit 1$q$));
select pg_temp.check_case('6 dentist 2 sees all four (p7 too)', '4:0',
  pg_temp.try(2, $q$select count(visit)::text || ':' || min(hidden_count) from ehr.dental_visits_list(7)$q$));
select pg_temp.check_case('6 another facility sees none: one row with the counts', '0:0',
  pg_temp.try(6, $q$select count(visit)::text || ':' || min(hidden_count) from ehr.dental_visits_list(1)$q$));
select pg_temp.check_case('6 days outside 1-30', '22023 DENTAL_VALIDATION|22023 DENTAL_VALIDATION',
  pg_temp.try(1, 'select count(*)::text from ehr.dental_visits_list(0)') || '|'
  || pg_temp.try(1, 'select count(*)::text from ehr.dental_visits_list(31)'));
select pg_temp.check_case('6 the summary of e1 (the procedure in error left out)', 'found/Tooth Clinic A/4/2/1/draft/Toothache, lower left/AA22',
  pg_temp.try(1, format($q$select outcome || '/' || facility_name || '/' || (chart->>'versionNo') || '/'
      || jsonb_array_length(done_this_visit) || '/' || jsonb_array_length(planned_procedures) || '/' || list_status || '/'
      || (encounter->>'chiefComplaint') || '/' || (patient->>'healthIdLast4')
      from ehr.dental_summary_read(%L, %L)$q$, pg_temp.patient(1), pg_temp.enc(1))));
select pg_temp.check_case('6 the summary of e8: the chart is the newest here (none in e8)', 'found/4/1',
  pg_temp.try(1, format($q$select outcome || '/' || (chart->>'versionNo') || '/' || jsonb_array_length(done_this_visit)
      from ehr.dental_summary_read(%L, %L)$q$, pg_temp.patient(1), pg_temp.enc(8))));
select pg_temp.check_case('6 the summary of a visit with no record', 'visit_not_found',
  pg_temp.try(1, format('select outcome from ehr.dental_summary_read(%L, %L)', pg_temp.patient(1), pg_temp.enc(2))));

-- 8. The runtime reads no dental table and runs no helper.
select pg_temp.check_case('8 the runtime reads no dental table',
  '42501|42501|42501|42501|42501|42501|42501',
  (select string_agg(split_part(pg_temp.try(1, format('select count(*)::text from %s', name)), ' ', 1), '|' order by ord)
     from unnest(array['ehr.dental_list_versions', 'ehr.dental_list_items', 'ehr.dental_visits',
       'ehr.dental_chart_versions', 'ehr.dental_chart_findings', 'ehr.dental_procedures', 'ehr.dental_events'])
          with ordinality listed(name, ord)));
select pg_temp.check_case('8 the runtime runs no helper', '42501|42501',
  split_part(pg_temp.try(1, 'select count(*)::text from ehr.dental_caller(''ehr.dental.read'')'), ' ', 1) || '|'
  || split_part(pg_temp.try(1, format('select count(*)::text from ehr.dental_cards(%L, array[]::uuid[], %L)', 'visit',
       pg_temp.member(1))), ' ', 1));
reset role;
select pg_temp.check_case('8 no runtime role has any privilege on a dental table', '0',
  (select count(*)::text from pg_class relation, lateral aclexplode(coalesce(relation.relacl,
     acldefault('r', relation.relowner))) acl
    where relation.relnamespace = 'ehr'::regnamespace and relation.relname like 'dental\_%' and relation.relkind = 'r'
      and acl.grantee <> relation.relowner));
select pg_temp.check_case('8 EXECUTE: 14 route functions for the EHR runtime, none for identity, none on helpers',
  '14/0/0/0', format('%s/%s/%s/%s',
    (select count(*) from pg_proc where pronamespace = 'ehr'::regnamespace and proname like 'dental\_%'
       and has_function_privilege('hid_ehr_runtime', oid, 'execute')),
    (select count(*) from pg_proc where pronamespace = 'ehr'::regnamespace and proname like 'dental\_%'
       and has_function_privilege('hid_identity_api_runtime', oid, 'execute')),
    (select count(*) from pg_proc where pronamespace = 'ehr'::regnamespace
       and proname in ('dental_caller', 'dental_cards', 'dental_list_versions_guard', 'dental_chart_versions_guard',
                       'dental_visits_guard', 'dental_procedures_guard')
       and has_function_privilege('hid_ehr_runtime', oid, 'execute')),
    (select count(*) from pg_proc where pronamespace = 'ehr'::regnamespace and proname like 'dental\_%'
       and has_function_privilege('public', oid, 'execute'))));
-- Guards: each statement in its own savepoint, as the cluster's superuser (the owner's rights and more).
create function pg_temp.guard(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'allowed';
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
select pg_temp.check_case('8 DELETE refused on every dental table',
  '55000|55000|55000|55000|55000|55000|55000',
  (select string_agg(split_part(pg_temp.guard(format('delete from %s', name)), ' ', 1), '|' order by ord)
     from unnest(array['ehr.dental_list_versions', 'ehr.dental_list_items', 'ehr.dental_visits',
       'ehr.dental_chart_versions', 'ehr.dental_chart_findings', 'ehr.dental_procedures', 'ehr.dental_events'])
          with ordinality listed(name, ord)));
set local client_min_messages = warning;
select pg_temp.check_case('8 TRUNCATE refused on every dental table',
  '55000|55000|55000|55000|55000|55000|55000',
  (select string_agg(split_part(pg_temp.guard(format('truncate %s cascade', name)), ' ', 1), '|' order by ord)
     from unnest(array['ehr.dental_list_versions', 'ehr.dental_list_items', 'ehr.dental_visits',
       'ehr.dental_chart_versions', 'ehr.dental_chart_findings', 'ehr.dental_procedures', 'ehr.dental_events'])
          with ordinality listed(name, ord)));
reset client_min_messages;
select pg_temp.check_case('8 UPDATE refused on the append-only tables', '55000|55000|55000',
  split_part(pg_temp.guard('update ehr.dental_list_items set label = label || '' x'''), ' ', 1) || '|'
  || split_part(pg_temp.guard('update ehr.dental_chart_findings set note = ''changed note'''), ' ', 1) || '|'
  || split_part(pg_temp.guard('update ehr.dental_events set at = at'), ' ', 1));
select pg_temp.check_case('8 a done procedure''s clinical columns never change',
  '55000 DENTAL_PROCEDURE_FIXED|55000 DENTAL_PROCEDURE_FIXED|55000 DENTAL_PROCEDURE_FIXED',
  pg_temp.guard(format('update ehr.dental_procedures set notes = ''changed'', row_version = row_version + 1 where id = %L',
    pg_temp.ref('pr5'))) || '|'
  || pg_temp.guard(format('update ehr.dental_procedures set status = ''planned'', row_version = row_version + 1 where id = %L',
    pg_temp.ref('pr5'))) || '|'
  || pg_temp.guard(format('update ehr.dental_procedures set tooth = 37 where id = %L', pg_temp.ref('pr5'))));
select pg_temp.check_case('8 a chart version changes only by its one-way mark',
  '55000 DENTAL_CHART_VERSION_FIXED|55000 DENTAL_CHART_VERSION_FIXED',
  pg_temp.guard(format('update ehr.dental_chart_versions set dentition = ''primary'' where id = %L', pg_temp.ref('v1')))
  || '|' || pg_temp.guard(format('update ehr.dental_chart_versions set entered_in_error_at = null, '
       || 'entered_in_error_by_membership_id = null, entered_in_error_reason = null where id = %L', pg_temp.ref('v3'))));
select pg_temp.check_case('8 a visit changes only its follow-up', '55000 DENTAL_VISIT_FIXED',
  pg_temp.guard(format('update ehr.dental_visits set encounter_id = %L, row_version = row_version + 1 where id = %L',
    pg_temp.enc(9), pg_temp.ref('visit-e1'))));
savepoint list_signing;
select pg_temp.check_case('8 a list version goes from draft to signed once, never back', 'allowed|55000 DENTAL_LIST_VERSION_FIXED|55000 DENTAL_LIST_VERSION_FIXED',
  pg_temp.guard($q$update ehr.dental_list_versions set status = 'signed', signed_at = clock_timestamp(),
      sign_off_reference = 'CL-APPROVAL-0001' where kind = 'procedure'$q$) || '|'
  || pg_temp.guard($q$update ehr.dental_list_versions set status = 'draft', signed_at = null, sign_off_reference = null
      where kind = 'procedure'$q$) || '|'
  || pg_temp.guard($q$update ehr.dental_list_versions set version_label = 'HID-DENT-2026-12' where kind = 'procedure'$q$));
rollback to savepoint list_signing;

-- 9. Audit.
select pg_temp.check_case('9 the actions written', 'ehr.dental.chart.entered-in-error,ehr.dental.chart.read,ehr.dental.chart.save,'
  || 'ehr.dental.procedure.cancel,ehr.dental.procedure.done,ehr.dental.procedure.entered-in-error,ehr.dental.procedure.list,'
  || 'ehr.dental.procedure.plan,ehr.dental.summary.print,ehr.dental.visit.follow-up,ehr.dental.visit.list,'
  || 'ehr.dental.visit.list.shown,ehr.dental.visit.read,ehr.dental.visit.start',
  (select string_agg(distinct action, ',' order by action) from audit.events where action like 'ehr.dental.%'));
select pg_temp.check_case('9 every row is the staff member''s, at the facility, for direct care, from ehr-api',
  'staff/direct-care/application/ehr-api/0',
  (select min(actor_type) || '/' || min(purpose_of_use) || '/' || min(provenance) || '/' || min(source_system) || '/'
          || count(*) filter (where actor_membership_id is null or facility_id is null)
     from audit.events where action like 'ehr.dental.%'));
select pg_temp.check_case('9 the answered refusals by kind',
  'chart_changed:3,chart_not_found:2,chart_not_latest:2,consent_required:7,encounter_not_found:3,key_reused:3,'
  || 'not_signer:1,procedure_not_done:1,procedure_not_found:1,procedure_not_planned:3,version_conflict:3,'
  || 'visit_closed:3,visit_encounter_invalid:3,visit_not_found:2,visit_not_started:2',
  (select string_agg(refusal || ':' || n, ',' order by refusal) from (
     select details->>'refusal' as refusal, count(*) as n from audit.events
      where action like 'ehr.dental.%' and outcome = 'denied' group by 1) counted));
select pg_temp.check_case('9 no finding, surface, code, name, anaesthetic, note, reason, date of birth or Health ID in a dental audit row', '0',
  (select count(*)::text from audit.events event_row
    where event_row.action like 'ehr.dental.%'
      and (event_row.reason is not null
           or event_row.details::text ~* 'decayed|missing|crowned|fractured|"MO"|MOD|DEN-0|Composite|extraction|lidocaine|articaine|infiltration|alveolar|Gum massage|Denture|Bupivacaine|plaque|Extracted|sound|Recall|Review the filling|wrong patient|wrong tooth|chose to wait|Tooth[a-z]|Toothache|HID-|1990-|Procedure note|dentition|permanent|mixed')));
select pg_temp.check_case('9 the list rows: one per patient shown, with the patient', 't',
  (select (count(*) > 0 and bool_and(patient_id is not null and resource_type = 'patient'))::text::char(1)
     from audit.events where action = 'ehr.dental.visit.list.shown'));
select pg_temp.check_case('9 the summary is audited as a print', '2:1',
  (select count(*) filter (where outcome = 'success') || ':' || count(*) filter (where outcome = 'denied')
     from audit.events where action = 'ehr.dental.summary.print'));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.d_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0194-0196 dental clinic:\n%', mismatch;
  end if;
  raise notice '0194-0196 dental clinic: % cases passed', (select count(*) from pg_temp.d_outcomes);
end $$;

rollback;
