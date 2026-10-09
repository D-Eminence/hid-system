\set ON_ERROR_STOP on
-- The Pharmacy guards refuse a missing session account, membership or facility
-- (Phase 4 Stage 8, 0077). Rollback-only.
--
-- pharmacy.validate_work_item, validate_work_item_event, validate_dispensing,
-- validate_dispensing_reversal and validate_imported_medication_evidence (0023)
-- compared the row's actor and facility with the session using <>. Without a
-- session account, membership or facility (no app.* setting, an unknown or
-- disabled subject, an empty membership or facility) the comparison was NULL
-- and the guard let the row through. Forced RLS then refuses the Pharmacy
-- runtime, but a session that bypasses RLS (a superuser, or a table owner
-- without FORCE ROW LEVEL SECURITY) could record a work item, an acceptance
-- event, a dispensing, a reversal or imported evidence attributed to any
-- member. Since 0077 each guard refuses a missing session value with its
-- existing code and message (23514). As in 0023, the work-item event guard
-- does not compare the facility with the session: it binds the event to its
-- work item's accepter and to the session account and membership.
--
-- Isolated cases: fixtures are inserted with session_replication_role =
-- replica, which skips triggers and foreign-key checks (CHECK constraints still
-- apply), and the five guard triggers are enabled with ENABLE ALWAYS TRIGGER,
-- so only the guard under test runs. They run as the suite runner, a superuser
-- that bypasses RLS. Runtime cases: every trigger, reference and RLS policy
-- applies, and the inserts are the Pharmacy API's own statements, run as
-- hid_pharmacy_api_runtime with the session the API sets. Before 0077 forced
-- RLS refused the runtime's inserts without a session (42501); now the guard
-- refuses them first. Probe cases are undone; lifecycle steps are kept. Each
-- case records 'ok' or 'SQLSTATE: message', and the suite fails at the end
-- listing every case whose outcome differs from the expected one.
--
-- The rehearsal also runs this suite with a schema owner that is neither a
-- superuser nor BYPASSRLS (release checklist P8). The guards' parent lookups
-- are then subject to RLS: a session without a facility hides the work item,
-- and the work-item event guard refuses the event it accepts under an owner
-- that bypasses RLS. The owner probe records what the owner sees, and the two
-- event cases without a facility follow it.
begin;

-- Security properties that CREATE OR REPLACE must keep: SECURITY DEFINER, the
-- exact search_path, volatility, and the owner shared with
-- pharmacy.context_allows, which 0077 does not replace.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: definer=%s config=%s volatility=%s owner=%s', p.oid::regprocedure,
           p.prosecdef, p.proconfig, p.provolatile, p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
    join (values ('pharmacy.validate_work_item()'::regprocedure),
                 ('pharmacy.validate_work_item_event()'::regprocedure),
                 ('pharmacy.validate_dispensing()'::regprocedure),
                 ('pharmacy.validate_dispensing_reversal()'::regprocedure),
                 ('pharmacy.validate_imported_medication_evidence()'::regprocedure))
      expected(proc) on p.oid = expected.proc
   where not p.prosecdef or p.proconfig is distinct from '{"search_path=pharmacy, platform, pg_temp"}'::text[]
      or p.provolatile <> 'v'
      or p.proowner <> (select proowner from pg_proc
                         where oid = 'pharmacy.context_allows(uuid,uuid,text)'::regprocedure);
  if mismatch is not null then
    raise exception 'Pharmacy guard security properties changed: %', mismatch;
  end if;
  if (select count(*) from pg_trigger
       where (tgrelid, tgname, tgfoid) in (
         ('pharmacy.work_items'::regclass, 'pharmacy_work_item_validate',
          'pharmacy.validate_work_item()'::regprocedure),
         ('pharmacy.work_item_events'::regclass, 'pharmacy_work_item_event_validate',
          'pharmacy.validate_work_item_event()'::regprocedure),
         ('pharmacy.dispensings'::regclass, 'pharmacy_dispensing_validate',
          'pharmacy.validate_dispensing()'::regprocedure),
         ('pharmacy.dispensing_reversals'::regclass, 'pharmacy_dispensing_reversal_validate',
          'pharmacy.validate_dispensing_reversal()'::regprocedure),
         ('pharmacy.imported_medication_evidence'::regclass, 'pharmacy_imported_medication_validate',
          'pharmacy.validate_imported_medication_evidence()'::regprocedure))
         and tgenabled = 'O' and not tgisinternal) <> 5 then
    raise exception 'the Pharmacy guard triggers must stay enabled on their tables';
  end if;
end $$;

set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e8d00000-0000-4000-8000-000000000001', 'Pharmacy Guard Test Organization', 'pharmacy-guard-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e8d00000-0000-4000-8000-000000000002', 'e8d00000-0000-4000-8000-000000000001', 'Pharmacy Guard Clinic',
   'PHARMACY-GUARD', 'Africa/Lagos', true, 'verified');
-- Pharmacists A (e8d1...01) and B (...02) are active; C's account (...03) is
-- disabled and D's (...04) is disabled until tomorrow. Member n has staff
-- e8d2...0n and one membership e8d3...0n in the clinic.
insert into auth.accounts (id, subject, email, display_name, status, disabled_until)
select ('e8d10000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:pharmacy-guard-' || x,
       'pharmacy-guard-' || x || '@example.invalid', 'Pharmacy Guard ' || upper(x),
       case when x = 'c' then 'disabled' else 'active' end,
       case when x = 'd' then clock_timestamp() + interval '1 day' end
  from (values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')) member(n, x);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e8d20000-0000-4000-8000-00000000000' || n)::uuid, ('e8d10000-0000-4000-8000-00000000000' || n)::uuid,
       'Pharmacy Guard ' || upper(x), 'pharmacy-guard-' || x || '@example.invalid', 'verified', 'pharmacist'
  from (values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')) member(n, x);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role)
select ('e8d30000-0000-4000-8000-00000000000' || n)::uuid, ('e8d20000-0000-4000-8000-00000000000' || n)::uuid,
       ('e8d10000-0000-4000-8000-00000000000' || n)::uuid, 'e8d00000-0000-4000-8000-000000000001',
       'e8d00000-0000-4000-8000-000000000002', 'pharmacist', 'pharmacist'
  from generate_series(1, 4) n;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e8d40000-0000-4000-8000-000000000001', 'HID-PHGUARDA', 'Guard', 'Patient', 'Guard Patient', 'active');
-- Pharmacy RLS (pharmacy.context_allows) needs an active write grant of the
-- session's member for the patient, for a known purpose. Every member has one,
-- so a runtime insert is refused only for its session.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'pharmacy-guard-test')
on conflict (code) do nothing;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select ('e8d80000-0000-4000-8000-00000000000' || n)::uuid, 'e8d40000-0000-4000-8000-000000000001',
       ('e8d20000-0000-4000-8000-00000000000' || n)::uuid, ('e8d10000-0000-4000-8000-00000000000' || n)::uuid,
       ('e8d30000-0000-4000-8000-00000000000' || n)::uuid, 'e8d00000-0000-4000-8000-000000000002',
       'write_records', 'direct-care', 'active', 'Synthetic Pharmacy guard consent',
       clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days'
  from generate_series(1, 4) n;
-- Work items W1-W4 (e8d5...0n, prescriptions e8d6...0n) were accepted by
-- members 1-4 and have no event or dispensing yet. W5 was accepted by A and
-- dispensed by A as S5 (e8d7...05), which has no reversal yet.
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
  source_ehr_prescription_version, source_encounter_id, source_status, medication_code_system, medication_code,
  medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, prescribed_by, prescribed_at,
  accepted_by, accepted_by_membership_id, acceptance_reason, idempotency_key, request_sha256, correlation_id)
select ('e8d50000-0000-4000-8000-00000000000' || n)::uuid, 'e8d40000-0000-4000-8000-000000000001',
       'e8d00000-0000-4000-8000-000000000002', 'e8d00000-0000-4000-8000-000000000002',
       ('e8d60000-0000-4000-8000-00000000000' || n)::uuid, 1, 'e8dc0000-0000-4000-8000-000000000001', 'active',
       'urn:synthetic:medication', 'amoxicillin-500mg', 'Amoxicillin 500 mg', 1, 'tablet', 'oral', 'Every 8 hours',
       'Take after food', 'e8d10000-0000-4000-8000-000000000002', '2026-10-01 08:00:00+00',
       ('e8d10000-0000-4000-8000-00000000000' || accepter)::uuid,
       ('e8d30000-0000-4000-8000-00000000000' || accepter)::uuid, 'Synthetic prescription accepted',
       'pharmacy-guard-accept-000' || n, repeat('a', 64), 'pharmacy-guard-fixture'
  from (values (1, 1), (2, 2), (3, 3), (4, 4), (5, 1)) work(n, accepter);
insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id, medication_code_system,
  medication_code, medication_display, quantity_dispensed, quantity_unit, dispensed_by, dispensed_by_membership_id,
  reason, idempotency_key, request_sha256, correlation_id) values
  ('e8d70000-0000-4000-8000-000000000005', 'e8d50000-0000-4000-8000-000000000005', 1,
   'e8d40000-0000-4000-8000-000000000001', 'e8d00000-0000-4000-8000-000000000002', 'urn:synthetic:medication',
   'amoxicillin-500mg', 'Amoxicillin 500 mg', 21, 'tablet', 'e8d10000-0000-4000-8000-000000000001',
   'e8d30000-0000-4000-8000-000000000001', 'Synthetic medication supplied', 'pharmacy-guard-dispense-0005',
   repeat('b', 64), 'pharmacy-guard-fixture');
set local session_replication_role = origin;

-- The session, exactly as services/pharmacy-api/src/database/database.service.ts
-- sets it (lines 44-47). An empty value reads as missing (platform.current_*).
create function pg_temp.as_member(subject text, facility text, correlation text, membership text, purpose text)
returns void language plpgsql as $$
begin
  perform set_config('app.actor_subject', subject, true), set_config('app.facility_id', facility, true),
          set_config('app.correlation_id', correlation, true), set_config('app.membership_id', membership, true),
          set_config('app.purpose_of_use', purpose, true);
end $$;

-- Can the guards' owner see the parent rows? Under member A's session, and
-- under A's subject and membership without a facility. An owner that bypasses
-- RLS sees them both times; the P8 owner sees them only with the facility.
select pg_temp.as_member('synthetic:pharmacy-guard-a', 'e8d00000-0000-4000-8000-000000000002',
  'pharmacy-guard-suite', 'e8d30000-0000-4000-8000-000000000001', 'direct-care');
do $$
declare
  owner_role name := (select proowner::regrole::name from pg_proc
                       where oid = 'pharmacy.validate_dispensing()'::regprocedure);
  visible boolean;
begin
  execute format('set local role %I', owner_role);
  select (select count(*) from pharmacy.work_items where id in ('e8d50000-0000-4000-8000-000000000001',
            'e8d50000-0000-4000-8000-000000000002', 'e8d50000-0000-4000-8000-000000000003',
            'e8d50000-0000-4000-8000-000000000004', 'e8d50000-0000-4000-8000-000000000005')) = 5
     and exists (select 1 from pharmacy.dispensings where id = 'e8d70000-0000-4000-8000-000000000005')
    into visible;
  reset role;
  perform set_config('pharmacy_guard.owner_sees', visible::text, true);
  perform set_config('app.facility_id', '', true);
  execute format('set local role %I', owner_role);
  select exists (select 1 from pharmacy.work_items where id = 'e8d50000-0000-4000-8000-000000000001') into visible;
  reset role;
  perform set_config('pharmacy_guard.owner_sees_without_facility', visible::text, true);
end $$;

-- The sessions every guard is checked under. Each case's row names one member:
-- its account, its membership and, for an acceptance event, the work item that
-- member accepted (Wn for member n), so that only the session can differ.
create temporary table pharmacy_guard_sessions (
  seq integer primary key, name text not null, subject text not null, facility text not null,
  correlation text not null, membership text not null, purpose text not null,
  actor uuid not null, actor_membership uuid not null, actor_work_item uuid not null
) on commit drop;
grant select on pharmacy_guard_sessions to public;
insert into pharmacy_guard_sessions
select seq, name, subject, facility, correlation, membership, purpose,
       ('e8d10000-0000-4000-8000-00000000000' || member)::uuid, ('e8d30000-0000-4000-8000-00000000000' || member)::uuid,
       ('e8d50000-0000-4000-8000-00000000000' || member)::uuid
  from (values
    (1, 'no session values, naming B', '', '', '', '', '', 2),
    (2, 'A without a membership, naming A', 'synthetic:pharmacy-guard-a', 'e8d00000-0000-4000-8000-000000000002',
     'pharmacy-guard-suite', '', 'direct-care', 1),
    (3, 'an unknown subject with B''s membership, naming B', 'synthetic:pharmacy-guard-unknown',
     'e8d00000-0000-4000-8000-000000000002', 'pharmacy-guard-suite', 'e8d30000-0000-4000-8000-000000000002',
     'direct-care', 2),
    (4, 'disabled C, naming C', 'synthetic:pharmacy-guard-c', 'e8d00000-0000-4000-8000-000000000002',
     'pharmacy-guard-suite', 'e8d30000-0000-4000-8000-000000000003', 'direct-care', 3),
    (5, 'D disabled until tomorrow, naming D', 'synthetic:pharmacy-guard-d', 'e8d00000-0000-4000-8000-000000000002',
     'pharmacy-guard-suite', 'e8d30000-0000-4000-8000-000000000004', 'direct-care', 4),
    (6, 'A without a facility, naming A', 'synthetic:pharmacy-guard-a', '', 'pharmacy-guard-suite',
     'e8d30000-0000-4000-8000-000000000001', 'direct-care', 1),
    (7, 'A, naming B', 'synthetic:pharmacy-guard-a', 'e8d00000-0000-4000-8000-000000000002', 'pharmacy-guard-suite',
     'e8d30000-0000-4000-8000-000000000001', 'direct-care', 2),
    (8, 'A, naming A', 'synthetic:pharmacy-guard-a', 'e8d00000-0000-4000-8000-000000000002', 'pharmacy-guard-suite',
     'e8d30000-0000-4000-8000-000000000001', 'direct-care', 1)
  ) variant(seq, name, subject, facility, correlation, membership, purpose, member);

create temporary table pharmacy_guard_cases (
  seq serial, area text not null, name text not null, expected text not null, actual text, primary key (area, name)
) on commit drop;
-- The runtime cases run as the Pharmacy API runtime and record their own outcome.
grant select, insert on pharmacy_guard_cases to public;
grant usage on sequence pharmacy_guard_cases_seq_seq to public;

-- Runs a statement as the current role: 'ok', or 'SQLSTATE: message'. With
-- keep = false a successful statement is undone.
create function pg_temp.guard_try(statement text, keep boolean) returns text language plpgsql as $$
declare outcome text;
begin
  begin
    execute statement;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'pharmacy-guard-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'pharmacy-guard-suite: undo' then outcome := sqlstate || ': ' || sqlerrm; end if;
  end;
  return outcome;
end $$;
-- Sets the numbered session, then runs and records one case.
create function pg_temp.guard_case(area text, case_name text, expected text, session_seq integer, statement text,
  keep boolean default false) returns void language plpgsql as $$
declare chosen pharmacy_guard_sessions%rowtype;
begin
  select * into strict chosen from pharmacy_guard_sessions where seq = session_seq;
  perform pg_temp.as_member(chosen.subject, chosen.facility, chosen.correlation, chosen.membership, chosen.purpose);
  insert into pharmacy_guard_cases (area, name, expected, actual)
  values (area, case_name, expected, pg_temp.guard_try(statement, keep));
end $$;
-- Each guard's refusal, as recorded.
create function pg_temp.refusal(guard text) returns text language sql immutable as $$
  select '23514: ' || case guard
    when 'work item' then 'Pharmacy acceptance patient, facility, prescription status, or actor context is invalid'
    when 'work-item event' then 'Pharmacy work-item event does not match its accepted prescription'
    when 'dispensing' then 'Dispensing does not match its eligible Pharmacy work item and actor context'
    when 'reversal' then 'Dispensing reversal does not match its original dispensing and actor context'
    when 'imported evidence' then 'Imported medication evidence patient, facility, or actor context is invalid' end
$$;

-- The Pharmacy API's inserts, with their parameters filled in for patient
-- e8d4...01 in the clinic. The API takes the facility and the actor from the
-- request context, and the dispensing and reversal columns from their parent.
-- PharmacyService.acceptPrescription (services/pharmacy-api/src/pharmacy/pharmacy.service.ts:84-97).
create function pg_temp.work_item_insert(work_item uuid, prescription uuid, accepter uuid, accepter_membership uuid,
  key text) returns text language sql as $$
  select format($i$insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,'e8d40000-0000-4000-8000-000000000001','e8d00000-0000-4000-8000-000000000002',
        'e8d00000-0000-4000-8000-000000000002',%L,1,'e8dc0000-0000-4000-8000-000000000001','active',
        'urn:synthetic:medication','amoxicillin-500mg','Amoxicillin 500 mg',1,'tablet','oral','Every 8 hours',
        'Take after food',null,null,'e8d10000-0000-4000-8000-000000000002','2026-10-01 08:00:00+00',%L,%L,
        'Synthetic prescription accepted',%L,%L,'pharmacy-guard-suite')
      returning *$i$, work_item, prescription, accepter, accepter_membership, key, repeat('a', 64))
$$;
-- The acceptance event of the same transaction (pharmacy.service.ts:101-105).
create function pg_temp.event_insert(work_item uuid, actor uuid, actor_membership uuid) returns text
language sql as $$
  select format($i$insert into pharmacy.work_item_events (
        work_item_id,patient_id,facility_id,event_version,event_type,actor_id,actor_membership_id,reason,correlation_id
      ) values (%L,'e8d40000-0000-4000-8000-000000000001','e8d00000-0000-4000-8000-000000000002',1,
        'prescription_accepted',%L,%L,'Synthetic prescription accepted','pharmacy-guard-suite')$i$,
    work_item, actor, actor_membership)
$$;
-- PharmacyService.dispense (pharmacy.service.ts:160-168).
create function pg_temp.dispensing_insert(dispensing uuid, work_item uuid, dispenser uuid, dispenser_membership uuid,
  key text) returns text language sql as $$
  select format($i$insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,'e8d40000-0000-4000-8000-000000000001','e8d00000-0000-4000-8000-000000000002',
        'urn:synthetic:medication','amoxicillin-500mg','Amoxicillin 500 mg',21,'tablet',%L,%L,
        'Synthetic medication supplied',%L,%L,'pharmacy-guard-suite') returning *$i$,
    dispensing, work_item, dispenser, dispenser_membership, key, repeat('b', 64))
$$;
-- PharmacyService.reverse (pharmacy.service.ts:212-218).
create function pg_temp.reversal_insert(reversal uuid, dispensing uuid, work_item uuid, reverser uuid,
  reverser_membership uuid, key text) returns text language sql as $$
  select format($i$insert into pharmacy.dispensing_reversals (
        id,dispensing_id,dispensing_version,work_item_id,patient_id,facility_id,reversed_by,
        reversed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,'e8d40000-0000-4000-8000-000000000001','e8d00000-0000-4000-8000-000000000002',%L,%L,
        'Synthetic dispensing reversed',%L,%L,'pharmacy-guard-suite') returning *$i$,
    reversal, dispensing, work_item, reverser, reverser_membership, key, repeat('c', 64))
$$;
-- PharmacyService.createImport (pharmacy.service.ts:244-254), for an OCR
-- publication (e8db...) reviewed by B. The guard reads no OCR evidence.
create function pg_temp.import_insert(creator uuid, creator_membership uuid) returns text language sql as $$
  select format($i$insert into pharmacy.imported_medication_evidence (
        id,patient_id,facility_id,source_document_id,ocr_job_id,extraction_id,validation_id,
        validation_version,publication_id,medication_text,strength_text,dose_text,frequency_text,
        historical_context,reviewed_by,created_by,created_by_membership_id,idempotency_key,
        request_sha256,correlation_id
      ) values ('e8da0000-0000-4000-8000-000000000010','e8d40000-0000-4000-8000-000000000001',
        'e8d00000-0000-4000-8000-000000000002','e8db0000-0000-4000-8000-000000000001',
        'e8db0000-0000-4000-8000-000000000002','e8db0000-0000-4000-8000-000000000003',
        'e8db0000-0000-4000-8000-000000000004',1,'e8db0000-0000-4000-8000-000000000005','Metformin 500 mg',
        null,null,null,null,'e8d10000-0000-4000-8000-000000000002',%L,%L,'pharmacy-guard-import-0010',%L,
        'pharmacy-guard-suite') returning *$i$, creator, creator_membership, repeat('d', 64))
$$;

-- Isolated guard cases, as the superuser runner, which bypasses RLS: only the
-- guard can refuse. Every row is a new work item (W10), an acceptance event of
-- the named member's work item, a dispensing of W1, a reversal of S5, or
-- imported evidence. Under an owner that bypasses RLS the event guard accepts
-- A's event without a facility, faithfully to 0023.
set local session_replication_role = replica;
alter table pharmacy.work_items enable always trigger pharmacy_work_item_validate;
alter table pharmacy.work_item_events enable always trigger pharmacy_work_item_event_validate;
alter table pharmacy.dispensings enable always trigger pharmacy_dispensing_validate;
alter table pharmacy.dispensing_reversals enable always trigger pharmacy_dispensing_reversal_validate;
alter table pharmacy.imported_medication_evidence enable always trigger pharmacy_imported_medication_validate;
select pg_temp.guard_case('isolated', 'work item: ' || name,
    case when seq = 8 then 'ok' else pg_temp.refusal('work item') end, seq,
    pg_temp.work_item_insert('e8d50000-0000-4000-8000-000000000010', 'e8d60000-0000-4000-8000-000000000010', actor,
      actor_membership, 'pharmacy-guard-accept-0010'))
  from pharmacy_guard_sessions order by seq;
select pg_temp.guard_case('isolated', 'work-item event: ' || name,
    case when seq = 8 or (seq = 6 and current_setting('pharmacy_guard.owner_sees_without_facility')::boolean)
      then 'ok' else pg_temp.refusal('work-item event') end, seq,
    pg_temp.event_insert(actor_work_item, actor, actor_membership))
  from pharmacy_guard_sessions order by seq;
select pg_temp.guard_case('isolated', 'dispensing: ' || name,
    case when seq = 8 then 'ok' else pg_temp.refusal('dispensing') end, seq,
    pg_temp.dispensing_insert('e8d70000-0000-4000-8000-000000000010', 'e8d50000-0000-4000-8000-000000000001', actor,
      actor_membership, 'pharmacy-guard-dispense-0010'))
  from pharmacy_guard_sessions order by seq;
select pg_temp.guard_case('isolated', 'reversal: ' || name,
    case when seq = 8 then 'ok' else pg_temp.refusal('reversal') end, seq,
    pg_temp.reversal_insert('e8d90000-0000-4000-8000-000000000010', 'e8d70000-0000-4000-8000-000000000005',
      'e8d50000-0000-4000-8000-000000000005', actor, actor_membership, 'pharmacy-guard-reverse-0010'))
  from pharmacy_guard_sessions order by seq;
select pg_temp.guard_case('isolated', 'imported evidence: ' || name,
    case when seq = 8 then 'ok' else pg_temp.refusal('imported evidence') end, seq,
    pg_temp.import_insert(actor, actor_membership))
  from pharmacy_guard_sessions order by seq;
alter table pharmacy.work_items enable trigger pharmacy_work_item_validate;
alter table pharmacy.work_item_events enable trigger pharmacy_work_item_event_validate;
alter table pharmacy.dispensings enable trigger pharmacy_dispensing_validate;
alter table pharmacy.dispensing_reversals enable trigger pharmacy_dispensing_reversal_validate;
alter table pharmacy.imported_medication_evidence enable trigger pharmacy_imported_medication_validate;
set local session_replication_role = origin;

-- Runtime cases: the same rows through the Pharmacy API's runtime role, with
-- every trigger, reference and RLS policy. The guard fires before the RLS
-- check, so a missing session value is refused by the guard; without a
-- facility the event guard (no facility term) lets A's event through to RLS
-- under an owner that bypasses RLS.
-- The API also looks for a replay with SELECT ... FOR UPDATE before each insert
-- (pharmacy.service.ts:75-78, 144, 152-154, 196-197, 204-206, 236-238). Those
-- statements are not run here: the runtime roles have no UPDATE privilege on
-- the Pharmacy tables and they fail with 42501, a separate release blocker.
set local role hid_pharmacy_api_runtime;
select pg_temp.guard_case('runtime', 'work item: ' || name,
    case when seq = 8 then 'ok' else pg_temp.refusal('work item') end, seq,
    pg_temp.work_item_insert('e8d50000-0000-4000-8000-000000000010', 'e8d60000-0000-4000-8000-000000000010', actor,
      actor_membership, 'pharmacy-guard-accept-0010'))
  from pharmacy_guard_sessions order by seq;
select pg_temp.guard_case('runtime', 'work-item event: ' || name,
    case when seq = 8 then 'ok'
         when seq = 6 and current_setting('pharmacy_guard.owner_sees_without_facility')::boolean
           then '42501: new row violates row-level security policy for table "work_item_events"'
         else pg_temp.refusal('work-item event') end, seq,
    pg_temp.event_insert(actor_work_item, actor, actor_membership))
  from pharmacy_guard_sessions order by seq;
select pg_temp.guard_case('runtime', 'dispensing: ' || name,
    case when seq = 8 then 'ok' else pg_temp.refusal('dispensing') end, seq,
    pg_temp.dispensing_insert('e8d70000-0000-4000-8000-000000000010', 'e8d50000-0000-4000-8000-000000000001', actor,
      actor_membership, 'pharmacy-guard-dispense-0010'))
  from pharmacy_guard_sessions order by seq;
select pg_temp.guard_case('runtime', 'reversal: ' || name,
    case when seq = 8 then 'ok' else pg_temp.refusal('reversal') end, seq,
    pg_temp.reversal_insert('e8d90000-0000-4000-8000-000000000010', 'e8d70000-0000-4000-8000-000000000005',
      'e8d50000-0000-4000-8000-000000000005', actor, actor_membership, 'pharmacy-guard-reverse-0010'))
  from pharmacy_guard_sessions order by seq;
select pg_temp.guard_case('runtime', 'imported evidence: ' || name,
    case when seq = 8 then 'ok' else pg_temp.refusal('imported evidence') end, seq,
    pg_temp.import_insert(actor, actor_membership))
  from pharmacy_guard_sessions order by seq;

-- Lifecycle (kept): A accepts a new prescription (work item W20 and its
-- acceptance event), dispenses it (S20) and reverses the dispensing (R20).
select pg_temp.guard_case('lifecycle', 'A accepts a prescription', 'ok', 8,
  pg_temp.work_item_insert('e8d50000-0000-4000-8000-000000000020', 'e8d60000-0000-4000-8000-000000000020',
    'e8d10000-0000-4000-8000-000000000001', 'e8d30000-0000-4000-8000-000000000001', 'pharmacy-guard-accept-0020'),
  true);
select pg_temp.guard_case('lifecycle', 'A records the acceptance event', 'ok', 8,
  pg_temp.event_insert('e8d50000-0000-4000-8000-000000000020', 'e8d10000-0000-4000-8000-000000000001',
    'e8d30000-0000-4000-8000-000000000001'), true);
select pg_temp.guard_case('lifecycle', 'A dispenses it', 'ok', 8,
  pg_temp.dispensing_insert('e8d70000-0000-4000-8000-000000000020', 'e8d50000-0000-4000-8000-000000000020',
    'e8d10000-0000-4000-8000-000000000001', 'e8d30000-0000-4000-8000-000000000001', 'pharmacy-guard-dispense-0020'),
  true);
select pg_temp.guard_case('lifecycle', 'A reverses the dispensing', 'ok', 8,
  pg_temp.reversal_insert('e8d90000-0000-4000-8000-000000000020', 'e8d70000-0000-4000-8000-000000000020',
    'e8d50000-0000-4000-8000-000000000020', 'e8d10000-0000-4000-8000-000000000001',
    'e8d30000-0000-4000-8000-000000000001', 'pharmacy-guard-reverse-0020'), true);
reset role;

-- Every case ran, and every outcome is the expected one. If the guards' owner
-- could not see the parent rows under A's session, a refusal would only need to
-- be a refusal; an 'ok' case must be 'ok' in every mode.
do $$
declare
  owner_sees boolean := current_setting('pharmacy_guard.owner_sees')::boolean;
  owner_sees_without_facility boolean := current_setting('pharmacy_guard.owner_sees_without_facility')::boolean;
  mismatches text;
begin
  if (select count(*) from pharmacy_guard_cases) <> 84
     or exists (select 1 from pharmacy_guard_cases where actual is null) then
    raise exception 'the Pharmacy guard suite did not run every case';
  end if;
  select string_agg(format('%s / %s: expected %s, got %s', area, name, expected, actual), E'\n' order by seq)
    into mismatches
    from pharmacy_guard_cases
   where case when owner_sees or expected = 'ok' then actual is distinct from expected
              else actual is not distinct from 'ok' end;
  if mismatches is not null then
    raise exception E'Pharmacy session guards do not fail closed (owner sees fixtures: %, without a facility: %):\n%',
      owner_sees, owner_sees_without_facility, mismatches;
  end if;
  raise notice 'Pharmacy session guard suite: % cases passed (owner sees fixtures: %, without a facility: %)',
    (select count(*) from pharmacy_guard_cases), owner_sees, owner_sees_without_facility;
end $$;

rollback;
