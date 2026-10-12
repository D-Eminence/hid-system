\set ON_ERROR_STOP on
-- Pharmacy work is bound to its EHR prescription (0080). Rollback-only.
--
-- pharmacy.validate_work_item and pharmacy.validate_dispensing (0023, rewritten
-- fail-closed in 0077) compared a row only with the session and, for a
-- dispensing, with its work item; neither read ehr.prescriptions, and the work
-- item has no foreign key to it. So Pharmacy accepted a snapshot of a
-- prescription that was cancelled, superseded or did not exist, and dispensed a
-- work item whose prescription the prescriber had since cancelled, marked
-- entered in error, put on hold or completed. Since 0080 each guard reads the
-- prescription as its owner, with a share lock, and refuses with SQLSTATE 23514
-- naming its own constraint: an acceptance unless the snapshot is the exact
-- active prescription version (patient, facility, encounter, version, status,
-- medication, dose, route, frequency, instructions and prescriber), a
-- dispensing unless the prescription is still active at the version Pharmacy
-- accepted. A reversal does not read the prescription, so a dispensing can
-- still be corrected after a cancel. The acceptance does not compare
-- prescribed_at, starts_on or ends_on with the prescription in this release:
-- EHR builds before it send the time truncated to the millisecond and the
-- dates as local-midnight Dates (a day early east of UTC), and they may still
-- run, before the EHR API is deployed or after it is rolled back, so such an
-- acceptance is accepted.
--
-- Runtime cases run as hid_pharmacy_api_runtime with the session the Pharmacy
-- API sets and the API's own INSERT statements; the prescriber's cancel runs as
-- hid_ehr_api_runtime with the EHR's UPDATE, through ehr.capture_record_version,
-- which moves the prescription to its next version. Isolated cases run as the
-- suite runner, a superuser, with session_replication_role = replica and only
-- the guard under test enabled (ENABLE ALWAYS), so only that guard can refuse.
-- Fixtures are inserted in replica mode (CHECK constraints still apply). Probe
-- cases are undone; lifecycle steps and the cancels are kept. Each case records
-- its outcome ('ok', 'SQLSTATE: message', or for a constraint case the
-- SQLSTATE and constraint name), the role it ran as and the replication mode,
-- and the suite fails at the end listing every case whose outcome or mode
-- differs from the expected one.
--
-- The rehearsal also runs this suite with a schema owner that is neither a
-- superuser nor BYPASSRLS (release checklist P8). The guards then read and lock
-- the prescription under the session's row-level security: a share lock needs
-- the prescriptions_update policy, that is a write consent of the session's
-- member, which Pharmacy's own insert policy requires anyway. A prescription the
-- owner cannot lock reads as missing and is refused. The owner probe records
-- whether the owner can lock the prescriptions under member A's session (it
-- must, for every accepted case) and under member R's, who may only read the
-- patient's records; R's cases follow it.
begin;

-- Security properties that CREATE OR REPLACE must keep: SECURITY DEFINER, the
-- exact search_path (ehr.prescriptions is schema-qualified instead), volatility,
-- and the owner shared with pharmacy.context_allows. The two guard triggers
-- must exist, call their guard and be enabled.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: definer=%s config=%s volatility=%s owner=%s', p.oid::regprocedure,
           p.prosecdef, p.proconfig, p.provolatile, p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
    join (values ('pharmacy.validate_work_item()'::regprocedure),
                 ('pharmacy.validate_dispensing()'::regprocedure)) expected(proc) on p.oid = expected.proc
   where not p.prosecdef or p.proconfig is distinct from '{"search_path=pharmacy, platform, pg_temp"}'::text[]
      or p.provolatile <> 'v'
      or p.proowner <> (select proowner from pg_proc
                         where oid = 'pharmacy.context_allows(uuid,uuid,text)'::regprocedure);
  if mismatch is not null then
    raise exception 'Pharmacy source guard security properties changed: %', mismatch;
  end if;
  if (select count(*) from pg_trigger
       where (tgrelid, tgname, tgfoid) in (
         ('pharmacy.work_items'::regclass, 'pharmacy_work_item_validate',
          'pharmacy.validate_work_item()'::regprocedure),
         ('pharmacy.dispensings'::regclass, 'pharmacy_dispensing_validate',
          'pharmacy.validate_dispensing()'::regprocedure))
         and tgenabled = 'O' and not tgisinternal) <> 2 then
    raise exception 'the Pharmacy work-item and dispensing guard triggers must stay enabled on their tables';
  end if;
end $$;

-- Clinic F (e9a00000-...02) and clinic F2 (...03) of one organization.
-- Pharmacist A (e9a1...01), prescriber P (...02) and pharmacist R (...03) are
-- members of F (staff e9a2...0n, membership e9a3...0n). Patients P1 (e9a4...01)
-- and P2 (...02). A holds a write consent for P1 and P2 in F, P a write consent
-- for P1 (the EHR cancel needs it), R only a read consent for P1.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'pharmacy-source-test')
on conflict (code) do nothing;
insert into identity.organizations (id, name, slug) values
  ('e9a00000-0000-4000-8000-000000000001', 'Pharmacy Source Test Organization', 'pharmacy-source-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e9a00000-0000-4000-8000-000000000002', 'e9a00000-0000-4000-8000-000000000001', 'Pharmacy Source Clinic F',
   'PHARMACY-SOURCE-F', 'Africa/Lagos', true, 'verified'),
  ('e9a00000-0000-4000-8000-000000000003', 'e9a00000-0000-4000-8000-000000000001', 'Pharmacy Source Clinic F2',
   'PHARMACY-SOURCE-F2', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e9a10000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:pharmacy-source-' || x,
       'pharmacy-source-' || x || '@example.invalid', 'Pharmacy Source ' || upper(x), 'active'
  from (values (1, 'a'), (2, 'p'), (3, 'r')) member(n, x);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e9a20000-0000-4000-8000-00000000000' || n)::uuid, ('e9a10000-0000-4000-8000-00000000000' || n)::uuid,
       'Pharmacy Source ' || upper(x), 'pharmacy-source-' || x || '@example.invalid', 'verified', role_code
  from (values (1, 'a', 'pharmacist'), (2, 'p', 'doctor'), (3, 'r', 'pharmacist')) member(n, x, role_code);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role)
select ('e9a30000-0000-4000-8000-00000000000' || n)::uuid, ('e9a20000-0000-4000-8000-00000000000' || n)::uuid,
       ('e9a10000-0000-4000-8000-00000000000' || n)::uuid, 'e9a00000-0000-4000-8000-000000000001',
       'e9a00000-0000-4000-8000-000000000002', role_code, role_code
  from (values (1, 'pharmacist'), (2, 'doctor'), (3, 'pharmacist')) member(n, role_code);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e9a40000-0000-4000-8000-000000000001', 'HID-PHSRCRXA', 'Source', 'Patient', 'Source Patient', 'active'),
  ('e9a40000-0000-4000-8000-000000000002', 'HID-PHSRCRXB', 'Other', 'Patient', 'Other Patient', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select ('e9a80000-0000-4000-8000-00000000000' || n)::uuid, patient::uuid,
       ('e9a20000-0000-4000-8000-00000000000' || member)::uuid, ('e9a10000-0000-4000-8000-00000000000' || member)::uuid,
       ('e9a30000-0000-4000-8000-00000000000' || member)::uuid, 'e9a00000-0000-4000-8000-000000000002', scope,
       'direct-care', 'active', 'Synthetic Pharmacy source consent', clock_timestamp() - interval '1 hour',
       clock_timestamp() + interval '30 days'
  from (values (1, 1, 'e9a40000-0000-4000-8000-000000000001', 'write_records'),
               (2, 1, 'e9a40000-0000-4000-8000-000000000002', 'write_records'),
               (3, 2, 'e9a40000-0000-4000-8000-000000000001', 'write_records'),
               (4, 3, 'e9a40000-0000-4000-8000-000000000001', 'read_records')) grant_row(n, member, patient, scope);
-- Encounters: E (e9a6...01) and E2 (...02) of P1 in F, E3 (...03) of P2 in F,
-- E4 (...04) of P1 in F2.
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at)
select ('e9a60000-0000-4000-8000-00000000000' || n)::uuid, patient::uuid, facility::uuid,
       'e9a10000-0000-4000-8000-000000000002', 'e9a30000-0000-4000-8000-000000000002', 'ambulatory', 'in_progress',
       '2026-10-01 07:30:00+00'
  from (values (1, 'e9a40000-0000-4000-8000-000000000001', 'e9a00000-0000-4000-8000-000000000002'),
               (2, 'e9a40000-0000-4000-8000-000000000001', 'e9a00000-0000-4000-8000-000000000002'),
               (3, 'e9a40000-0000-4000-8000-000000000002', 'e9a00000-0000-4000-8000-000000000002'),
               (4, 'e9a40000-0000-4000-8000-000000000001', 'e9a00000-0000-4000-8000-000000000003'))
       encounter(n, patient, facility);
-- Prescriptions by P, created at a time with microseconds as clock_timestamp()
-- gives. The dispensing family (e9a5...01-0c) is accepted as work items W
-- (e9a7..., same suffix) at version 1; each differs from an active version 1 of
-- P1 in F and encounter E in one term only:
--   01 active (the control)          02 active, cancelled by P in this suite
--   03 entered_in_error              04 on_hold
--   05 completed                     06 draft
--   07 active at version 3           08 patient P2 (encounter E3)
--   09 does not exist                0a encounter E (the work item says E2)
--   0b clinic F2 (encounter E4)      0c active, dispensed, cancelled, reversed
-- The acceptance family (11-13) is not accepted yet; it has dates:
--   11 active at version 1           12 cancelled at version 1
--   13 active at version 2           19 does not exist
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
  instructions, starts_on, ends_on, status, row_version, created_at)
select ('e9a50000-0000-4000-8000-0000000000' || suffix)::uuid, encounter::uuid, patient::uuid, facility::uuid,
       'e9a10000-0000-4000-8000-000000000002', 'e9a30000-0000-4000-8000-000000000002', 'urn:synthetic:medication',
       'amoxicillin-500mg', 'Amoxicillin 500 mg', 1, 'tablet', 'oral', 'Every 8 hours', 'Take after food',
       starts::date, ends::date, status, version, created::timestamptz
  from (values
    ('01', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'active', 1, null, null, '2026-10-01 08:00:00.123456+00'),
    ('02', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'active', 1, null, null, '2026-10-01 08:00:00.123456+00'),
    ('03', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'entered_in_error', 1, null, null, '2026-10-01 08:00:00.123456+00'),
    ('04', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'on_hold', 1, null, null, '2026-10-01 08:00:00.123456+00'),
    ('05', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'completed', 1, null, null, '2026-10-01 08:00:00.123456+00'),
    ('06', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'draft', 1, null, null, '2026-10-01 08:00:00.123456+00'),
    ('07', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'active', 3, null, null, '2026-10-01 08:00:00.123456+00'),
    ('08', 'e9a60000-0000-4000-8000-000000000003', 'e9a40000-0000-4000-8000-000000000002',
     'e9a00000-0000-4000-8000-000000000002', 'active', 1, null, null, '2026-10-01 08:00:00.123456+00'),
    ('0a', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'active', 1, null, null, '2026-10-01 08:00:00.123456+00'),
    ('0b', 'e9a60000-0000-4000-8000-000000000004', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000003', 'active', 1, null, null, '2026-10-01 08:00:00.123456+00'),
    ('0c', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'active', 1, null, null, '2026-10-01 08:00:00.123456+00'),
    ('11', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'active', 1, '2026-10-01', '2026-10-08', '2026-10-01 09:30:00.654321+00'),
    ('12', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'cancelled', 1, '2026-10-01', '2026-10-08',
     '2026-10-01 09:30:00.654321+00'),
    ('13', 'e9a60000-0000-4000-8000-000000000001', 'e9a40000-0000-4000-8000-000000000001',
     'e9a00000-0000-4000-8000-000000000002', 'active', 2, '2026-10-01', '2026-10-08', '2026-10-01 09:30:00.654321+00'))
    rx(suffix, encounter, patient, facility, status, version, starts, ends, created);
-- Work items of the dispensing family, accepted by A for patient P1 in F.
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
  source_ehr_prescription_version, source_encounter_id, source_status, medication_code_system, medication_code,
  medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, prescribed_by, prescribed_at,
  accepted_by, accepted_by_membership_id, acceptance_reason, idempotency_key, request_sha256, correlation_id)
select ('e9a70000-0000-4000-8000-0000000000' || suffix)::uuid, 'e9a40000-0000-4000-8000-000000000001',
       'e9a00000-0000-4000-8000-000000000002', 'e9a00000-0000-4000-8000-000000000002',
       ('e9a50000-0000-4000-8000-0000000000' || suffix)::uuid, 1, encounter::uuid, 'active',
       'urn:synthetic:medication', 'amoxicillin-500mg', 'Amoxicillin 500 mg', 1, 'tablet', 'oral', 'Every 8 hours',
       'Take after food', 'e9a10000-0000-4000-8000-000000000002', '2026-10-01 08:00:00.123456+00',
       'e9a10000-0000-4000-8000-000000000001', 'e9a30000-0000-4000-8000-000000000001',
       'Synthetic prescription accepted', 'pharmacy-source-fixture-' || suffix, repeat('a', 64),
       'pharmacy-source-fixture'
  from (values ('01', 'e9a60000-0000-4000-8000-000000000001'), ('02', 'e9a60000-0000-4000-8000-000000000001'),
               ('03', 'e9a60000-0000-4000-8000-000000000001'), ('04', 'e9a60000-0000-4000-8000-000000000001'),
               ('05', 'e9a60000-0000-4000-8000-000000000001'), ('06', 'e9a60000-0000-4000-8000-000000000001'),
               ('07', 'e9a60000-0000-4000-8000-000000000001'), ('08', 'e9a60000-0000-4000-8000-000000000003'),
               ('09', 'e9a60000-0000-4000-8000-000000000001'), ('0a', 'e9a60000-0000-4000-8000-000000000002'),
               ('0b', 'e9a60000-0000-4000-8000-000000000004'), ('0c', 'e9a60000-0000-4000-8000-000000000001'))
       work(suffix, encounter);
set local session_replication_role = origin;

-- The sessions of the suite, exactly as services/pharmacy-api/src/database/database.service.ts
-- and the EHR API set them (actor subject, facility, correlation, membership, purpose).
create temporary table pharmacy_source_sessions (
  name text primary key, subject text not null, membership text not null
) on commit drop;
grant select on pharmacy_source_sessions to public;
insert into pharmacy_source_sessions values
  ('A', 'synthetic:pharmacy-source-a', 'e9a30000-0000-4000-8000-000000000001'),
  ('P', 'synthetic:pharmacy-source-p', 'e9a30000-0000-4000-8000-000000000002'),
  ('R', 'synthetic:pharmacy-source-r', 'e9a30000-0000-4000-8000-000000000003');
create function pg_temp.source_session(session_name text) returns void language plpgsql as $$
declare chosen pharmacy_source_sessions%rowtype;
begin
  select * into strict chosen from pharmacy_source_sessions where name = session_name;
  perform set_config('app.actor_subject', chosen.subject, true),
          set_config('app.facility_id', 'e9a00000-0000-4000-8000-000000000002', true),
          set_config('app.correlation_id', 'pharmacy-source-suite', true),
          set_config('app.membership_id', chosen.membership, true),
          set_config('app.purpose_of_use', 'direct-care', true);
end $$;
-- The account and membership of a member.
create function pg_temp.source_member(member text, out account uuid, out membership uuid) language sql as $$
  select ('e9a10000-0000-4000-8000-00000000000' || n)::uuid, ('e9a30000-0000-4000-8000-00000000000' || n)::uuid
    from (values ('A', 1), ('P', 2), ('R', 3)) members(name, n)
   where members.name = member
$$;

-- Each case records the role and replication mode it ran in.
create temporary table pharmacy_source_cases (
  seq serial, area text not null, name text not null, expected text not null, actual text,
  run_as name not null default current_user,
  replication text not null default current_setting('session_replication_role'),
  primary key (area, name)
) on commit drop;
grant select, insert on pharmacy_source_cases to public;
grant usage on sequence pharmacy_source_cases_seq_seq to public;

-- Runs a statement as the current role: 'ok', or 'SQLSTATE: message'. With
-- keep = false a successful statement is undone.
create function pg_temp.source_try(statement text, keep boolean) returns text language plpgsql as $$
declare outcome text;
begin
  begin
    execute statement;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'pharmacy-source-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'pharmacy-source-suite: undo' then outcome := sqlstate || ': ' || sqlerrm; end if;
  end;
  return outcome;
end $$;
-- Runs a statement and undoes it: 'ok', or the SQLSTATE and the name of the
-- constraint the refusal reports, which is what the Pharmacy API maps.
create function pg_temp.source_constraint(statement text) returns text language plpgsql as $$
declare refused_constraint text;
begin
  begin
    execute statement;
    raise exception using errcode = 'P0001', message = 'pharmacy-source-suite: undo';
  exception when others then
    if sqlerrm = 'pharmacy-source-suite: undo' then return 'ok'; end if;
    get stacked diagnostics refused_constraint = constraint_name;
    return sqlstate || ': constraint ' || coalesce(nullif(refused_constraint, ''), '(none)');
  end;
end $$;
-- Sets the named session, then runs and records one case.
create function pg_temp.source_case(area text, case_name text, expected text, session_name text, statement text,
  keep boolean default false, report text default 'outcome') returns void language plpgsql as $$
begin
  perform pg_temp.source_session(session_name);
  insert into pharmacy_source_cases (area, name, expected, actual)
  values (area, case_name, expected,
          case report when 'constraint' then pg_temp.source_constraint(statement)
                      else pg_temp.source_try(statement, keep) end);
end $$;
-- Each guard's refusal, as recorded.
create function pg_temp.source_refusal(guard text) returns text language sql immutable as $$
  select '23514: ' || case guard
    when 'work item' then 'Pharmacy acceptance does not match the exact active EHR prescription version'
    when 'dispensing' then 'The EHR prescription of this Pharmacy work item is not active at the accepted version' end
$$;

-- PharmacyService.acceptPrescription (services/pharmacy-api/src/pharmacy/pharmacy.service.ts),
-- for patient P1 in F, the medication of the fixtures and, by default, the
-- exact snapshot of prescription 11 (version 1, encounter E, dates, prescriber
-- P, created_at at the microsecond as the EHR now sends it).
create function pg_temp.accept_insert(work_item uuid, prescription uuid, accepter text, version integer default 1,
  encounter uuid default 'e9a60000-0000-4000-8000-000000000001', display text default 'Amoxicillin 500 mg',
  starts date default '2026-10-01', ends date default '2026-10-08',
  prescriber uuid default 'e9a10000-0000-4000-8000-000000000002',
  prescribed text default '2026-10-01T09:30:00.654321Z') returns text language sql as $$
  select format($i$insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,'e9a40000-0000-4000-8000-000000000001','e9a00000-0000-4000-8000-000000000002',
        'e9a00000-0000-4000-8000-000000000002',%L,%s,%L,'active','urn:synthetic:medication','amoxicillin-500mg',%L,
        1,'tablet','oral','Every 8 hours','Take after food',%L,%L,%L,%L,%L,%L,'Synthetic prescription accepted',%L,%L,
        'pharmacy-source-suite')
      returning *$i$, work_item, prescription, version, encounter, display, starts, ends, prescriber, prescribed,
    member.account, member.membership, 'pharmacy-source-accept-' || work_item, repeat('a', 64))
  from pg_temp.source_member(accepter) member
$$;
-- PharmacyService.dispense, with the work item's patient, facility and medication.
create function pg_temp.dispense_insert(dispensing uuid, work_item uuid, dispenser text) returns text
language sql as $$
  select format($i$insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,'e9a40000-0000-4000-8000-000000000001','e9a00000-0000-4000-8000-000000000002',
        'urn:synthetic:medication','amoxicillin-500mg','Amoxicillin 500 mg',21,'tablet',%L,%L,
        'Synthetic medication supplied',%L,%L,'pharmacy-source-suite') returning *$i$,
    dispensing, work_item, member.account, member.membership, 'pharmacy-source-dispense-' || work_item,
    repeat('b', 64))
  from pg_temp.source_member(dispenser) member
$$;
-- PharmacyService.reverse.
create function pg_temp.reverse_insert(reversal uuid, dispensing uuid, work_item uuid, reverser text) returns text
language sql as $$
  select format($i$insert into pharmacy.dispensing_reversals (
        id,dispensing_id,dispensing_version,work_item_id,patient_id,facility_id,reversed_by,
        reversed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,'e9a40000-0000-4000-8000-000000000001','e9a00000-0000-4000-8000-000000000002',%L,%L,
        'Synthetic dispensing reversed',%L,%L,'pharmacy-source-suite') returning *$i$,
    reversal, dispensing, work_item, member.account, member.membership, 'pharmacy-source-reverse-' || work_item,
    repeat('c', 64))
  from pg_temp.source_member(reverser) member
$$;
-- PrescriptionsService.update (services/ehr-api/src/ehr/prescriptions/prescriptions.service.ts)
-- cancelling a prescription of P1 in F, encounter E, at version 1.
create function pg_temp.cancel_update(prescription uuid) returns text language sql as $$
  select format($i$update ehr.prescriptions set
             status = coalesce('cancelled', status), frequency = coalesce(null, frequency),
             instructions = coalesce(null, instructions), ends_on = coalesce(null::date, ends_on)
           where id = %L and encounter_id = 'e9a60000-0000-4000-8000-000000000001'
             and patient_id = 'e9a40000-0000-4000-8000-000000000001'
             and facility_id = 'e9a00000-0000-4000-8000-000000000002' and row_version = 1
           returning id$i$, prescription)
$$;
-- The EHR records why a prescription changed (ehr.capture_record_version).
select set_config('app.change_reason', 'Synthetic prescriber cancelled the prescription', true);

-- Both guards read the prescription with a share lock.
insert into pharmacy_source_cases (area, name, expected, actual)
select 'property', format('%s locks its EHR prescription', proc), 'yes',
       case when pg_get_functiondef(proc) ~* '\mfor\s+share\M' and pg_get_functiondef(proc) ~* 'ehr\.prescriptions'
            then 'yes' else 'no' end
  from (values ('pharmacy.validate_work_item()'::regprocedure),
               ('pharmacy.validate_dispensing()'::regprocedure)) guard(proc);

-- Owner probe: can the guards' owner read and share-lock the prescriptions
-- the cases use, under A's session and under R's? An owner that bypasses RLS
-- can under both; a P8 owner only under A's, whose write consent passes the
-- prescriptions_update policy that a share lock applies.
do $$
declare
  owner_role name := (select proowner::regrole::name from pg_proc
                       where oid = 'pharmacy.validate_dispensing()'::regprocedure);
  probe record;
  wanted uuid[];
  seen integer;
  locked integer;
begin
  perform set_config('pharmacy_source.owner_bypasses_rls',
    (select (rolsuper or rolbypassrls)::text from pg_roles where rolname = owner_role), true);
  for probe in select * from (values
      ('A', array['e9a50000-0000-4000-8000-000000000001', 'e9a50000-0000-4000-8000-000000000002',
                  'e9a50000-0000-4000-8000-00000000000c', 'e9a50000-0000-4000-8000-000000000011',
                  'e9a50000-0000-4000-8000-000000000013']::uuid[]),
      ('R', array['e9a50000-0000-4000-8000-000000000001', 'e9a50000-0000-4000-8000-000000000011']::uuid[]))
      sessions(name, ids) loop
    wanted := probe.ids;
    perform pg_temp.source_session(probe.name);
    execute format('set local role %I', owner_role);
    select count(*) into seen from ehr.prescriptions where id = any(wanted);
    locked := -1;
    begin
      select count(*) into locked from (select 1 from ehr.prescriptions where id = any(wanted) for share) lockable;
      raise exception using errcode = 'P0001', message = 'pharmacy-source-suite: undo';
    exception when others then
      if sqlerrm <> 'pharmacy-source-suite: undo' then locked := -1; end if;
    end;
    reset role;
    perform set_config('pharmacy_source.owner_sees_for_' || lower(probe.name),
      (seen = cardinality(wanted))::text, true);
    perform set_config('pharmacy_source.owner_locks_for_' || lower(probe.name),
      (locked = cardinality(wanted))::text, true);
  end loop;
end $$;

-- R's cases follow the probe: an owner that can lock under R's session passes
-- the source check, and Pharmacy's insert policy then refuses R, who has no
-- write consent; a P8 owner cannot lock the prescription, and the guard refuses.
create function pg_temp.r_expected(guard text, table_name text) returns text language sql stable as $$
  select case when current_setting('pharmacy_source.owner_locks_for_r')::boolean
              then format('42501: new row violates row-level security policy for table "%s"', table_name)
              else pg_temp.source_refusal(guard) end
$$;

-- Runtime cases: the Pharmacy API's statements as its runtime role, with every
-- trigger, reference and RLS policy. Each is undone.
set local role hid_pharmacy_api_runtime;
-- Acceptance: only the exact active version is accepted.
select pg_temp.source_case('runtime', 'accept: the exact active snapshot, prescribed at the microsecond', 'ok', 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000101', 'e9a50000-0000-4000-8000-000000000011', 'A'));
-- An EHR build before this release sends the time truncated to the
-- millisecond; it is still accepted (the time is not compared yet).
select pg_temp.source_case('runtime', 'accept: the time truncated to the millisecond, as earlier EHR builds send it',
  'ok', 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000102', 'e9a50000-0000-4000-8000-000000000011', 'A',
    prescribed => '2026-10-01T09:30:00.654Z'));
select pg_temp.source_case('runtime', 'accept: a cancelled prescription', pg_temp.source_refusal('work item'), 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000103', 'e9a50000-0000-4000-8000-000000000012', 'A'));
select pg_temp.source_case('runtime', 'accept: a prescription that does not exist',
  pg_temp.source_refusal('work item'), 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000104', 'e9a50000-0000-4000-8000-000000000019', 'A'));
select pg_temp.source_case('runtime', 'accept: another medication display', pg_temp.source_refusal('work item'), 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000105', 'e9a50000-0000-4000-8000-000000000011', 'A',
    display => 'Amoxicillin 250 mg'));
select pg_temp.source_case('runtime', 'accept: a superseded version', pg_temp.source_refusal('work item'), 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000106', 'e9a50000-0000-4000-8000-000000000013', 'A'));
select pg_temp.source_case('runtime', 'accept: the current version of that prescription', 'ok', 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000107', 'e9a50000-0000-4000-8000-000000000013', 'A',
    version => 2));
select pg_temp.source_case('runtime', 'accept: another encounter', pg_temp.source_refusal('work item'), 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000108', 'e9a50000-0000-4000-8000-000000000011', 'A',
    encounter => 'e9a60000-0000-4000-8000-000000000002'));
-- An EHR build before this release, in a process east of UTC, sends the
-- dates a day early; the dates are not compared yet either, so it is accepted.
select pg_temp.source_case('runtime',
  'accept: a start date one day early, as an earlier EHR build east of UTC sends it', 'ok', 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000109', 'e9a50000-0000-4000-8000-000000000011', 'A',
    starts => '2026-09-30'));
select pg_temp.source_case('runtime', 'accept: the end date left out, as the dates are not compared yet', 'ok', 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-00000000010a', 'e9a50000-0000-4000-8000-000000000011', 'A',
    ends => null));
select pg_temp.source_case('runtime', 'accept: another prescriber', pg_temp.source_refusal('work item'), 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-00000000010b', 'e9a50000-0000-4000-8000-000000000011', 'A',
    prescriber => 'e9a10000-0000-4000-8000-000000000001'));
select pg_temp.source_case('runtime', 'accept: the refusal names its constraint',
  '23514: constraint pharmacy_work_item_source_prescription', 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-00000000010c', 'e9a50000-0000-4000-8000-000000000012', 'A'),
  report => 'constraint');
select pg_temp.source_case('runtime', 'accept: R, who may only read the patient''s records',
  pg_temp.r_expected('work item', 'work_items'), 'R',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-00000000010d', 'e9a50000-0000-4000-8000-000000000011', 'R'));
-- Dispensing: only while the prescription is active at the accepted version.
select pg_temp.source_case('runtime', 'dispense: an active prescription at the accepted version', 'ok', 'A',
  pg_temp.dispense_insert('e9a90000-0000-4000-8000-000000000001', 'e9a70000-0000-4000-8000-000000000001', 'A'));
select pg_temp.source_case('runtime', 'dispense: before the EHR cancels the prescription', 'ok', 'A',
  pg_temp.dispense_insert('e9a90000-0000-4000-8000-000000000002', 'e9a70000-0000-4000-8000-000000000002', 'A'));
select pg_temp.source_case('runtime', 'dispense: ' || description, pg_temp.source_refusal('dispensing'), 'A',
    pg_temp.dispense_insert(('e9a90000-0000-4000-8000-0000000000' || suffix)::uuid,
      ('e9a70000-0000-4000-8000-0000000000' || suffix)::uuid, 'A'))
  from (values ('03', 'a prescription entered in error'), ('04', 'a prescription on hold'),
               ('05', 'a completed prescription'), ('06', 'a draft prescription'),
               ('07', 'a later prescription version'), ('08', 'another patient''s prescription'),
               ('09', 'a prescription that does not exist'), ('0a', 'another encounter'),
               ('0b', 'another clinic''s prescription')) refused(suffix, description)
 order by suffix;
select pg_temp.source_case('runtime', 'dispense: R, who may only read the patient''s records',
  pg_temp.r_expected('dispensing', 'dispensings'), 'R',
  pg_temp.dispense_insert('e9a90000-0000-4000-8000-00000000000d', 'e9a70000-0000-4000-8000-000000000001', 'R'));
reset role;

-- The prescriber cancels prescription 02 through the EHR runtime (kept): the
-- EHR's own UPDATE, as hid_ehr_api_runtime with P's session and change reason.
set local role hid_ehr_api_runtime;
select pg_temp.source_case('ehr', 'P cancels prescription 02', 'ok', 'P',
  pg_temp.cancel_update('e9a50000-0000-4000-8000-000000000002'), keep => true);
reset role;
insert into pharmacy_source_cases (area, name, expected, actual)
select 'property', 'prescription 02 after the EHR cancel', 'cancelled at version 2',
       coalesce((select status || ' at version ' || row_version from ehr.prescriptions
                  where id = 'e9a50000-0000-4000-8000-000000000002'), 'missing');

set local role hid_pharmacy_api_runtime;
select pg_temp.source_case('runtime', 'dispense: after the EHR cancelled the prescription',
  pg_temp.source_refusal('dispensing'), 'A',
  pg_temp.dispense_insert('e9a90000-0000-4000-8000-000000000012', 'e9a70000-0000-4000-8000-000000000002', 'A'));
select pg_temp.source_case('runtime', 'dispense: the refusal names its constraint',
  '23514: constraint pharmacy_dispensing_source_prescription', 'A',
  pg_temp.dispense_insert('e9a90000-0000-4000-8000-000000000013', 'e9a70000-0000-4000-8000-000000000002', 'A'),
  report => 'constraint');

-- Lifecycle (kept): A dispenses work item 0c, the prescriber then cancels its
-- prescription, and A can still reverse the dispensing.
select pg_temp.source_case('lifecycle', 'A dispenses work item 0c', 'ok', 'A',
  pg_temp.dispense_insert('e9a90000-0000-4000-8000-00000000000c', 'e9a70000-0000-4000-8000-00000000000c', 'A'),
  keep => true);
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.source_case('ehr', 'P cancels prescription 0c after it was dispensed', 'ok', 'P',
  pg_temp.cancel_update('e9a50000-0000-4000-8000-00000000000c'), keep => true);
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.source_case('lifecycle', 'A reverses the dispensing after the cancel', 'ok', 'A',
  pg_temp.reverse_insert('e9aa0000-0000-4000-8000-00000000000c', 'e9a90000-0000-4000-8000-00000000000c',
    'e9a70000-0000-4000-8000-00000000000c', 'A'), keep => true);
reset role;

-- Isolated guards, as the superuser runner, which bypasses RLS, with only the
-- guard under test enabled: the refusal can only come from that guard.
set local session_replication_role = replica;
alter table pharmacy.work_items enable always trigger pharmacy_work_item_validate;
select pg_temp.source_case('isolated', 'accept: the exact active snapshot', 'ok', 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000201', 'e9a50000-0000-4000-8000-000000000011', 'A'));
select pg_temp.source_case('isolated', 'accept: a cancelled prescription', pg_temp.source_refusal('work item'), 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000202', 'e9a50000-0000-4000-8000-000000000012', 'A'));
select pg_temp.source_case('isolated', 'accept: a prescription that does not exist',
  pg_temp.source_refusal('work item'), 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000203', 'e9a50000-0000-4000-8000-000000000019', 'A'));
select pg_temp.source_case('isolated', 'accept: a superseded version', pg_temp.source_refusal('work item'), 'A',
  pg_temp.accept_insert('e9a70000-0000-4000-8000-000000000204', 'e9a50000-0000-4000-8000-000000000013', 'A'));
alter table pharmacy.work_items enable trigger pharmacy_work_item_validate;
alter table pharmacy.dispensings enable always trigger pharmacy_dispensing_validate;
select pg_temp.source_case('isolated', 'dispense: an active prescription', 'ok', 'A',
  pg_temp.dispense_insert('e9a90000-0000-4000-8000-000000000201', 'e9a70000-0000-4000-8000-000000000001', 'A'));
select pg_temp.source_case('isolated', 'dispense: after the EHR cancelled the prescription',
  pg_temp.source_refusal('dispensing'), 'A',
  pg_temp.dispense_insert('e9a90000-0000-4000-8000-000000000202', 'e9a70000-0000-4000-8000-000000000002', 'A'));
select pg_temp.source_case('isolated', 'dispense: a later prescription version', pg_temp.source_refusal('dispensing'),
  'A', pg_temp.dispense_insert('e9a90000-0000-4000-8000-000000000203', 'e9a70000-0000-4000-8000-000000000007', 'A'));
select pg_temp.source_case('isolated', 'dispense: a prescription that does not exist',
  pg_temp.source_refusal('dispensing'), 'A',
  pg_temp.dispense_insert('e9a90000-0000-4000-8000-000000000204', 'e9a70000-0000-4000-8000-000000000009', 'A'));
alter table pharmacy.dispensings enable trigger pharmacy_dispensing_validate;
set local session_replication_role = origin;

-- Every case ran in its mode, and every outcome is the expected one.
do $$
declare
  probe text := format('guard owner bypasses row-level security: %s; locks A''s prescriptions: %s; R''s: %s',
    current_setting('pharmacy_source.owner_bypasses_rls'), current_setting('pharmacy_source.owner_locks_for_a'),
    current_setting('pharmacy_source.owner_locks_for_r'));
  mismatches text;
begin
  if (select count(*) from pharmacy_source_cases) <> 42
     or exists (select 1 from pharmacy_source_cases where actual is null) then
    raise exception 'the Pharmacy source prescription suite did not run every case';
  end if;
  select string_agg(format('%s / %s: ran as %s with replication %s', area, name, run_as, replication), E'\n'
           order by seq)
    into mismatches
    from pharmacy_source_cases case_row
   where case case_row.area
           when 'isolated' then case_row.replication is distinct from 'replica'
             or not exists (select 1 from pg_roles role_row where role_row.rolname = case_row.run_as
                              and (role_row.rolsuper or role_row.rolbypassrls))
           when 'ehr' then case_row.replication is distinct from 'origin'
             or case_row.run_as is distinct from 'hid_ehr_api_runtime'
           when 'property' then case_row.replication is distinct from 'origin'
           else case_row.replication is distinct from 'origin'
             or case_row.run_as is distinct from 'hid_pharmacy_api_runtime' end;
  if mismatches is not null then
    raise exception E'Pharmacy source prescription cases ran in the wrong mode:\n%', mismatches;
  end if;
  select string_agg(format('%s / %s: expected %s, got %s', area, name, expected, actual), E'\n' order by seq)
    into mismatches
    from pharmacy_source_cases
   where actual is distinct from expected;
  if mismatches is not null then
    raise exception E'Pharmacy work is not bound to its EHR prescription (%):\n%', probe, mismatches;
  end if;
  raise notice 'Pharmacy source prescription suite: % cases passed (%)',
    (select count(*) from pharmacy_source_cases), probe;
end $$;

rollback;
