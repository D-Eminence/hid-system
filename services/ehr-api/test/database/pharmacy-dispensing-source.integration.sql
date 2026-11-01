\set ON_ERROR_STOP on
-- A same-facility Pharmacy work item is dispensable only while its EHR
-- prescription is still active at the version Pharmacy accepted (0101, the
-- review of the 0100 build; main 0080's dispensing half). Rollback-only.
--
-- 0100 checks a same-facility acceptance against its ehr.prescriptions row,
-- but its FOR SHARE lock ends when the acceptance commits. Before 0101,
-- pharmacy.validate_dispensing (0086) read ehr.prescriptions only for a
-- route-backed work item, so after a legitimate acceptance the EHR could
-- cancel the prescription, put it on hold, complete it, mark it entered in
-- error or change what it says, and the work item stayed dispensable. Since
-- 0101 the same-facility branch reads the prescription FOR SHARE after the
-- existing checks and refuses (23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE) when
-- it is missing, belongs to another patient, facility or encounter, is not
-- active, or is at another version than the one accepted.
-- Cases:
--   1. structure: the body is 0101's; the order-route branch and the existing
--      actor and work-item check are byte for byte 0086's; attributes,
--      trigger, ACL; validate_dispensing_reversal is 0086's;
--   2. dispensable: an unchanged prescription; one changed before Pharmacy
--      accepted it (accepted at version 2); another patient's;
--   3. refused after a legitimate acceptance: cancelled, on hold, completed,
--      entered in error, instructions changed, frequency changed, end date
--      changed, on hold and then active again (version 3);
--   4. refused for work items that exist from before 0100 (inserted as
--      replica, as 0099 let them be): a missing prescription, another
--      patient's, another facility's, another encounter, another version,
--      and a prescription cancelled or on hold at the very version the
--      work item names (accepted when it was no longer active);
--   5. order: a broken session still gets 0077's message first; the
--      order-route branch still answers first for a route-backed item;
--   6. a dispensing recorded while the prescription was active can still be
--      reversed after the prescription is cancelled (the reversal guard is
--      unchanged);
--   7. the sealed demo tenant (0098): dispensed at Demo Hospital, refused
--      once its prescription is cancelled;
--   8. lock (after the cases are judged): the dispensing holds the
--      prescription row locked to commit (the
--      proof script checks with two sessions that the EHR's update waits and
--      an update committed after the dispensing's snapshot makes it 40001).
-- The acceptances, dispensings and reversals run as hid_pharmacy_api_runtime
-- with the session pharmacy-api sets, using pharmacy-api's own INSERTs
-- (PharmacyService.acceptPrescription, dispense, reverse); the EHR rows are
-- written as hid_ehr_api_runtime with the EHR API's own INSERT and UPDATE.
-- Probes are undone; the work items and the one reversed dispensing are kept.
set plpgsql.variable_conflict = error;
begin;

-- 1. Structure.
do $$
declare
  body text := (select prosrc from pg_proc where oid = 'pharmacy.validate_dispensing()'::regprocedure);
  mismatch text;
begin
  if md5(body) <> '17f7e8897bd2ab240332e4d2c9f757b7' then
    raise exception 'pharmacy.validate_dispensing is not 0101''s (md5 %)', md5(body);
  end if;
  -- 0086's order-route branch (the 353 characters after its IF) and 0086's
  -- actor and work-item check (from "if parent_row.id is null" to its END IF).
  if md5(split_part(split_part(body, E'  if parent_row.order_route_id is not null then\n', 2), E'  end if;\n', 1))
       <> 'da9e79f8612145989f7363caad8151a3'
     or md5(substr(body, position(E'  if parent_row.id is null\n' in body),
              position(E'actor context'';\n  end if;\n' in body) + length(E'actor context'';\n  end if;\n')
              - position(E'  if parent_row.id is null\n' in body))) <> 'a52a4dbfcdabe00a5079c3b71c88d7fa'
     or position(E'  if parent_row.order_route_id is not null then\n' in body)
        > position(E'  if parent_row.id is null\n' in body)
     or position(E'  if parent_row.id is null\n' in body)
        > position(E'  if parent_row.order_route_id is null then\n' in body) then
    raise exception 'the order-route branch, the existing check or their order in pharmacy.validate_dispensing changed';
  end if;
  if md5((select prosrc from pg_proc where oid = 'pharmacy.validate_dispensing_reversal()'::regprocedure))
     <> 'a8b1147f356e669fe0d14bea3e7ab014' then
    raise exception 'pharmacy.validate_dispensing_reversal is not 0086''s';
  end if;
  select string_agg(format('definer=%s config=%s volatile=%s strict=%s', p.prosecdef, p.proconfig, p.provolatile,
           p.proisstrict), '; ') into mismatch
    from pg_proc p
   where p.oid = 'pharmacy.validate_dispensing()'::regprocedure
     and (not p.prosecdef or p.proconfig is distinct from '{"search_path=pharmacy, platform, pg_temp"}'::text[]
       or p.provolatile <> 'v' or p.proisstrict
       or p.proowner <> (select proowner from pg_proc where oid = 'pharmacy.context_allows(uuid,uuid,text)'::regprocedure));
  if mismatch is not null then
    raise exception 'pharmacy.validate_dispensing attributes changed: %', mismatch;
  end if;
  if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              where p.oid = 'pharmacy.validate_dispensing()'::regprocedure and acl.grantee <> p.proowner) then
    raise exception 'pharmacy.validate_dispensing is executable by a role other than its owner';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'pharmacy.dispensings'::regclass
        and tgname = 'pharmacy_dispensing_validate' and tgfoid = 'pharmacy.validate_dispensing()'::regprocedure
        and tgenabled = 'O' and tgtype = 7) <> 1 then
    raise exception 'pharmacy_dispensing_validate is not BEFORE INSERT FOR EACH ROW on pharmacy.dispensings';
  end if;
  perform set_config('dispensing_check.owner_bypasses', (select (r.rolsuper or r.rolbypassrls)::text
    from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.oid = 'pharmacy.validate_dispensing()'::regprocedure), true);
end $$;

-- Fixtures (as replica: identity rows without their triggers). Clinic C1
-- (e9d00001...01) and C2 (...02); doctor D (account e9d00002...01,
-- membership e9d00004...01) and pharmacist A (...02) at C1, doctor D2 (...03)
-- at C2; patients P1 (e9d00005...01) and P2 (...02). D and A have write
-- consent for P1 and P2 at C1, D2 for P1 at C2.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'pharmacy-dispensing-test')
on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e9d00000-0000-4000-8000-000000000001', 'Dispensing Check Organization', 'dispensing-check-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e9d00001-0000-4000-8000-000000000001', 'e9d00000-0000-4000-8000-000000000001', 'Dispensing Check Clinic',
   'DISPENSING-CHECK-1', 'Africa/Lagos', true, 'verified'),
  ('e9d00001-0000-4000-8000-000000000002', 'e9d00000-0000-4000-8000-000000000001', 'Dispensing Check Annex',
   'DISPENSING-CHECK-2', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e9d00002-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:pharmacy-dispensing-' || x,
       'pharmacy-dispensing-' || x || '@example.invalid', 'Dispensing Check ' || x, 'active'
  from (values (1, 'doctor'), (2, 'pharmacist'), (3, 'annex-doctor')) member(n, x);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e9d00003-0000-4000-8000-00000000000' || n)::uuid, ('e9d00002-0000-4000-8000-00000000000' || n)::uuid,
       'Dispensing Check ' || x, 'pharmacy-dispensing-' || x || '@example.invalid', 'verified', role_code
  from (values (1, 'doctor', 'doctor'), (2, 'pharmacist', 'pharmacist'), (3, 'annex-doctor', 'doctor'))
       member(n, x, role_code);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role)
select ('e9d00004-0000-4000-8000-00000000000' || n)::uuid, ('e9d00003-0000-4000-8000-00000000000' || n)::uuid,
       ('e9d00002-0000-4000-8000-00000000000' || n)::uuid, 'e9d00000-0000-4000-8000-000000000001',
       ('e9d00001-0000-4000-8000-00000000000' || site)::uuid, role_code, role_code
  from (values (1, 1, 'doctor'), (2, 1, 'pharmacist'), (3, 2, 'doctor')) member(n, site, role_code);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e9d00005-0000-4000-8000-000000000001', 'HID-DSPCHKA', 'Dispensing', 'One', 'Dispensing One', 'active'),
  ('e9d00005-0000-4000-8000-000000000002', 'HID-DSPCHKB', 'Dispensing', 'Two', 'Dispensing Two', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select gen_random_uuid(), ('e9d00005-0000-4000-8000-00000000000' || patient)::uuid,
       ('e9d00003-0000-4000-8000-00000000000' || member)::uuid, ('e9d00002-0000-4000-8000-00000000000' || member)::uuid,
       ('e9d00004-0000-4000-8000-00000000000' || member)::uuid, ('e9d00001-0000-4000-8000-00000000000' || site)::uuid,
       'write_records', 'direct-care', 'active', 'Synthetic dispensing check consent',
       clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days'
  from (values (1, 1, 1), (2, 1, 1), (1, 2, 1), (2, 2, 1), (3, 1, 2)) consent(member, patient, site);
set local session_replication_role = origin;

-- The session the services set (the EHR API's and pharmacy-api's are the
-- same five settings); membership '' is a broken session.
create function pg_temp.as_member(member integer, site integer, membership text default null) returns void
language sql as $f$
  select set_config('app.actor_subject', 'synthetic:pharmacy-dispensing-'
           || (array['doctor', 'pharmacist', 'annex-doctor'])[member], true),
         set_config('app.facility_id', 'e9d00001-0000-4000-8000-00000000000' || site, true),
         set_config('app.correlation_id', 'pharmacy-dispensing-' || substr(md5(random()::text), 1, 12), true),
         set_config('app.membership_id', coalesce(membership, 'e9d00004-0000-4000-8000-00000000000' || member), true),
         set_config('app.purpose_of_use', 'direct-care', true);
$f$;
-- Prescription ids by name (K1 is e9d00007...11, and so on).
create function pg_temp.rx(name text) returns uuid language sql immutable as $f$
  select ('e9d00007-0000-4000-8000-0000000000' || case name when 'k1' then '11' when 'k2' then '12' when 'k3' then '13' when 'c1' then 'c1' when 'h1' then '21' when 'm1' then '31' when 'x1' then '41' when 'i1' then '51' when 'f1' then 'f1' when 'e1' then 'e1' when 'r1' then '61' when 'v1' then '71' when 'b2' then 'b2' when 'a2' then 'a2' when 'd1' then 'd1' when 'd2' then 'd2' when 'o3' then '83' when 'o5' then '85' when 'o6' then '86' when 'o7' then '87' when 'o8' then '88' when 'o9' then '89' end)::uuid
$f$;
grant execute on function pg_temp.as_member(integer, integer, text), pg_temp.rx(text)
  to hid_pharmacy_api_runtime, hid_ehr_api_runtime;

-- The EHR rows, through the EHR runtime with the EHR API's statements
-- (prescriptions.service.ts create and update). Encounters E1, E2 (P1) and E3
-- (P2) at C1, E4 (P1) at C2.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1, 1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e9d00006-0000-4000-8000-00000000000' || n)::uuid, ('e9d00005-0000-4000-8000-00000000000' || patient)::uuid,
       'e9d00001-0000-4000-8000-000000000001', 'e9d00002-0000-4000-8000-000000000001',
       'e9d00004-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp()
  from (values (1, 1), (2, 1), (3, 2)) encounter(n, patient);
create function pg_temp.prescribe(prescription uuid, encounter uuid, patient uuid, facility uuid, creator uuid,
  creator_membership uuid, display text, ends date) returns void language sql as $f$
  insert into ehr.prescriptions (
    id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit,
    route_code, frequency, instructions, starts_on, ends_on, status
  ) values (prescription, encounter, patient, facility, creator, creator_membership, 'http://www.whocc.no/atc',
    'J01CA04', display, 1.5, 'capsule', 'oral', 'Every 8 hours', 'Take after food for 7 days', date '2026-11-01',
    ends, 'active');
$f$;
create function pg_temp.change(prescription uuid, new_status text, new_frequency text, new_instructions text,
  new_ends date, expected_version bigint, reason text) returns void language plpgsql as $f$
begin
  perform set_config('app.change_reason', reason, true);
  update ehr.prescriptions set
    status = coalesce(new_status, status), frequency = coalesce(new_frequency, frequency),
    instructions = coalesce(new_instructions, instructions), ends_on = coalesce(new_ends, ends_on)
  where id = prescription and row_version = expected_version;
  if not found then raise exception 'dispensing check suite: % was not at version %', prescription, expected_version; end if;
end $f$;
-- P1's at C1 (E1), by D: K1, K3 unchanged; K2 changed once before Pharmacy
-- accepts it; C1, H1, M1, X1, I1, F1, E1, R1, V1 changed after Pharmacy
-- accepts them (below); O3, O5, O6, O7, O8, O9 for work items from before
-- 0100.
select pg_temp.prescribe(pg_temp.rx(n), 'e9d00006-0000-4000-8000-000000000001',
  'e9d00005-0000-4000-8000-000000000001', 'e9d00001-0000-4000-8000-000000000001', 'e9d00002-0000-4000-8000-000000000001',
  'e9d00004-0000-4000-8000-000000000001', 'Amoxicillin 500 mg capsule (' || n || ')', date '2026-11-08')
  from unnest(array['k1', 'k2', 'k3', 'c1', 'h1', 'm1', 'x1', 'i1', 'f1', 'e1', 'r1', 'v1', 'o3', 'o5', 'o6', 'o7',
                     'o8', 'o9']) n;
select pg_temp.change(pg_temp.rx('k2'), null, null, 'Take after food for 5 days',
  null, 1, 'Instructions clarified before Pharmacy accepted it');
-- P2's at C1 (E3).
select pg_temp.prescribe(pg_temp.rx('b2'), 'e9d00006-0000-4000-8000-000000000003',
  'e9d00005-0000-4000-8000-000000000002', 'e9d00001-0000-4000-8000-000000000001', 'e9d00002-0000-4000-8000-000000000001',
  'e9d00004-0000-4000-8000-000000000001', 'Amoxicillin 500 mg capsule (b2)', date '2026-11-08');
-- P1's at C2 (E4), by D2.
select pg_temp.as_member(3, 2);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e9d00006-0000-4000-8000-000000000004', 'e9d00005-0000-4000-8000-000000000001',
  'e9d00001-0000-4000-8000-000000000002', 'e9d00002-0000-4000-8000-000000000003',
  'e9d00004-0000-4000-8000-000000000003', 'ambulatory', 'in_progress', clock_timestamp());
select pg_temp.prescribe(pg_temp.rx('a2'), 'e9d00006-0000-4000-8000-000000000004',
  'e9d00005-0000-4000-8000-000000000001', 'e9d00001-0000-4000-8000-000000000002', 'e9d00002-0000-4000-8000-000000000003',
  'e9d00004-0000-4000-8000-000000000003', 'Amoxicillin 500 mg capsule (a2)', date '2026-11-08');
reset role;

-- The EHR API's hand-off for a prescription as pharmacy-api receives it
-- (prescriptions.service.ts acceptForPharmacy, dates as calendar dates), and
-- pharmacy-api's acceptance INSERT with it, as pharmacist A at C1.
create function pg_temp.accept_sql(prescription uuid) returns text language sql as $f$
  select format($i$insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,%L,%L,%L,%L,%L,'active',%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)
      returning *$i$, gen_random_uuid(), p.patient_id, 'e9d00001-0000-4000-8000-000000000001', p.facility_id, p.id,
    p.row_version, p.encounter_id, p.medication_code_system, p.medication_code, p.medication_display,
    p.dose_quantity::text::float8, p.dose_unit, p.route_code, p.frequency, p.instructions, p.starts_on::text,
    p.ends_on::text, p.created_by, to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'e9d00002-0000-4000-8000-000000000002', 'e9d00004-0000-4000-8000-000000000002', 'Accepted for dispensing',
    'pharmacy-dispensing-' || replace(gen_random_uuid()::text, '-', ''), repeat('e', 64),
    current_setting('app.correlation_id'))
  from ehr.prescriptions p where p.id = prescription
$f$;
-- pharmacy-api's dispensing INSERT (PharmacyService.dispense): the work
-- item's columns as it read them, version 1, the session's account and
-- membership (pharmacist A).
create function pg_temp.dispense_sql(work_item uuid) returns text language sql as $f$
  select format($i$insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L) returning *$i$,
    gen_random_uuid(), w.id, 1, w.patient_id, w.facility_id, w.medication_code_system, w.medication_code,
    w.medication_display, 21, 'capsule', 'e9d00002-0000-4000-8000-000000000002',
    'e9d00004-0000-4000-8000-000000000002', 'Dispensed to the patient',
    'pharmacy-dispensing-' || replace(gen_random_uuid()::text, '-', ''), repeat('d', 64),
    current_setting('app.correlation_id'))
  from pharmacy.work_items w where w.id = work_item
$f$;
-- pharmacy-api's reversal INSERT (PharmacyService.reverse).
create function pg_temp.reverse_sql(dispensing uuid) returns text language sql as $f$
  select format($i$insert into pharmacy.dispensing_reversals (
        id,dispensing_id,dispensing_version,work_item_id,patient_id,facility_id,reversed_by,
        reversed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L) returning *$i$,
    gen_random_uuid(), d.id, 1, d.work_item_id, d.patient_id, d.facility_id, 'e9d00002-0000-4000-8000-000000000002',
    'e9d00004-0000-4000-8000-000000000002', 'Returned unopened by the patient',
    'pharmacy-dispensing-' || replace(gen_random_uuid()::text, '-', ''), repeat('c', 64),
    current_setting('app.correlation_id'))
  from pharmacy.dispensings d where d.id = dispensing
$f$;
-- A statement's outcome ('ok', or 'SQLSTATE message'), undone unless kept.
create function pg_temp.try(statement text, keep boolean default false) returns text language plpgsql as $f$
declare outcome text;
begin
  begin
    execute statement;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'dispensing-check-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'dispensing-check-suite: undo' then outcome := sqlstate || ' ' || sqlerrm; end if;
  end;
  return outcome;
end $f$;
-- Kept statements' ids by name.
create temporary table kept (name text primary key, id uuid not null) on commit drop;
grant select, insert on kept to public;
create function pg_temp.keep(name text, statement text) returns void language plpgsql as $f$
declare made record;
begin
  execute statement into strict made;
  insert into kept values (name, made.id);
end $f$;
create function pg_temp.kept_id(name text) returns uuid language sql stable as $f$
  select id from kept where kept.name = $1
$f$;
create temporary table dispensing_cases (
  seq serial primary key, name text not null unique, expected text not null, actual text not null
) on commit drop;
grant select, insert on dispensing_cases to public;
grant usage on sequence dispensing_cases_seq_seq to public;
create function pg_temp.dispense_case(case_name text, expected text, work_item text) returns void language sql as $f$
  insert into dispensing_cases (name, expected, actual)
  values (case_name, expected, pg_temp.try(pg_temp.dispense_sql(pg_temp.kept_id(work_item))));
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_pharmacy_api_runtime, hid_ehr_api_runtime', proc.signature);
  end loop;
end $$;

-- Pharmacy accepts K1, K2 (at version 2), B2 and the nine to be changed,
-- each as the EHR API hands it off (the statements built as the owner: the
-- Pharmacy runtime cannot read ehr), and keeps them.
select pg_temp.as_member(2, 1);
create temporary table acceptances on commit drop as
  select n as name, pg_temp.accept_sql(pg_temp.rx(n)) as statement
    from unnest(array['k1', 'k2', 'b2', 'c1', 'h1', 'm1', 'x1', 'i1', 'f1', 'e1', 'r1', 'v1']) n;
grant select on acceptances to public;
set local role hid_pharmacy_api_runtime;
select pg_temp.keep(name, statement) from acceptances;
-- V1 is dispensed while its prescription is active.
select pg_temp.keep('v1 dispensing', pg_temp.dispense_sql(pg_temp.kept_id('v1')));
reset role;
-- Then the EHR changes eight of them with its own UPDATE.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.change(pg_temp.rx(n), new_status, new_frequency, new_instructions,
  new_ends, 1, reason)
  from (values
    ('c1', 'cancelled', null, null, null::date, 'Cancelled by the prescriber'),
    ('h1', 'on_hold', null, null, null, 'Held by the prescriber'),
    ('m1', 'completed', null, null, null, 'Completed by the prescriber'),
    ('x1', 'entered_in_error', null, null, null, 'Recorded for the wrong patient'),
    ('i1', null, null, 'Stop: allergy recorded, do not take', null, 'Instructions changed by the prescriber'),
    ('f1', null, 'Every 12 hours', null, null, 'Frequency changed by the prescriber'),
    ('e1', null, null, null, date '2026-11-04', 'Shortened by the prescriber'),
    ('r1', 'on_hold', null, null, null, 'Held by the prescriber'),
    ('v1', 'cancelled', null, null, null, 'Cancelled by the prescriber'),
    ('o7', 'cancelled', null, null, null, 'Cancelled by the prescriber'),
    ('o8', 'cancelled', null, null, null, 'Cancelled by the prescriber'),
    ('o9', 'on_hold', null, null, null, 'Held by the prescriber')) changed(n, new_status, new_frequency,
      new_instructions, new_ends, reason);
select pg_temp.change(pg_temp.rx('r1'), 'active', null, null, null, 2, 'Resumed by the prescriber');
reset role;

-- Work items that exist from before 0100 (as replica: 0099 let a work item
-- name anything). Each copies one prescription at its current version (K3,
-- O3, O5, O6, A2, O8, O9; one work item per prescription) and then names
-- something else: none, P2, another encounter, version 5; or nothing else:
-- C2's A2 copied whole (only its facility, C2, is not the work item's C1),
-- the cancelled O8 and the on-hold O9 at the version they are at (only the
-- status refuses them).
set local session_replication_role = replica;
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
  source_ehr_prescription_version, source_encounter_id, source_status, medication_code_system, medication_code,
  medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, starts_on, ends_on, prescribed_by,
  prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason, idempotency_key, request_sha256,
  correlation_id)
select ('e9d00008-0000-4000-8000-0000000000' || old.n)::uuid, coalesce(old.patient, p.patient_id),
       'e9d00001-0000-4000-8000-000000000001', 'e9d00001-0000-4000-8000-000000000001', coalesce(old.prescription, p.id),
       coalesce(old.version, p.row_version), coalesce(old.encounter, p.encounter_id), 'active', p.medication_code_system,
       p.medication_code, p.medication_display, p.dose_quantity, p.dose_unit, p.route_code, p.frequency,
       p.instructions, p.starts_on, p.ends_on, p.created_by, p.created_at, 'e9d00002-0000-4000-8000-000000000002',
       'e9d00004-0000-4000-8000-000000000002', 'Accepted before 0100', 'pharmacy-dispensing-old-' || old.n,
       repeat('a', 64), 'pharmacy-dispensing-suite'
  from (values
    ('01', 'k3', null::uuid, null::uuid, null::bigint, null::uuid),
    ('02', 'o3', 'e9d00007-0000-4000-8000-0000000000ff', null, null, null),
    ('03', 'o3', null, null, null, 'e9d00005-0000-4000-8000-000000000002'),
    ('04', 'a2', null, null, null, null),
    ('05', 'o5', null, 'e9d00006-0000-4000-8000-000000000002', null, null),
    ('06', 'o6', null, null, 5, null),
    ('08', 'o8', null, null, null, null),
    ('09', 'o9', null, null, null, null)) old(n, copied, prescription, encounter, version, patient)
  join ehr.prescriptions p on p.id = pg_temp.rx(old.copied);
insert into kept select 'old ' || right(id::text, 2), id from pharmacy.work_items where id::text like 'e9d00008-%';
set local session_replication_role = origin;
do $$
begin
  if (select string_agg(format('%s/%s/%s', right(id::text, 2), status, row_version), ' ' order by id)
        from ehr.prescriptions where id::text like 'e9d00007-%')
     <> '11/active/1 12/active/2 13/active/1 21/on_hold/2 31/completed/2 41/entered_in_error/2 51/active/2 '
        || '61/active/3 71/cancelled/2 83/active/1 85/active/1 86/active/1 87/cancelled/2 88/cancelled/2 89/on_hold/2 '
        || 'a2/active/1 b2/active/1 '
        || 'c1/cancelled/2 e1/active/2 f1/active/2'
     or (select count(*) from kept) <> 21
     or (select source_ehr_prescription_version from pharmacy.work_items where id = pg_temp.kept_id('k2')) <> 2 then
    raise exception 'dispensing check fixtures are not as described';
  end if;
end $$;

-- 2.-5. The dispensings, as pharmacist A at C1 through pharmacy-api's runtime.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
-- 2. Dispensable.
select pg_temp.dispense_case('K1, unchanged since Pharmacy accepted it', 'ok', 'k1');
select pg_temp.dispense_case('K2, changed before Pharmacy accepted it at version 2', 'ok', 'k2');
select pg_temp.dispense_case('B2, P2''s, unchanged', 'ok', 'b2');
select pg_temp.dispense_case('a work item from before 0100 that is exactly K3', 'ok', 'old 01');
-- 3. Refused after a legitimate acceptance.
select pg_temp.dispense_case('C1, cancelled after acceptance', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'c1');
select pg_temp.dispense_case('H1, on hold after acceptance', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'h1');
select pg_temp.dispense_case('M1, completed after acceptance', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'm1');
select pg_temp.dispense_case('X1, entered in error after acceptance', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'x1');
select pg_temp.dispense_case('I1, instructions changed to "do not take" after acceptance',
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'i1');
select pg_temp.dispense_case('F1, frequency changed after acceptance', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'f1');
select pg_temp.dispense_case('E1, end date changed after acceptance', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'e1');
select pg_temp.dispense_case('R1, held and resumed (version 3) after acceptance at version 1',
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'r1');
-- 4. Refused: work items from before 0100.
select pg_temp.dispense_case('a work item naming a prescription that does not exist',
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'old 02');
select pg_temp.dispense_case('a work item for P2 naming P1''s O3', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'old 03');
select pg_temp.dispense_case('a work item at C1 naming C2''s prescription', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE',
  'old 04');
select pg_temp.dispense_case('a work item naming O5 with another encounter', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE',
  'old 05');
select pg_temp.dispense_case('a work item naming O6 at version 5', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'old 06');
select pg_temp.dispense_case('a work item naming O8 at its version 2, cancelled',
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'old 08');
select pg_temp.dispense_case('a work item naming O9 at its version 2, on hold',
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'old 09');
-- 5. Order. A session without a membership (the row naming A) gets 0077's
-- message, not the source check's, even for the cancelled C1 (the statement
-- is built under A's session, which may read the work item).
select set_config('dispensing_check.statement', pg_temp.dispense_sql(pg_temp.kept_id('c1')), true);
select pg_temp.as_member(2, 1, '');
insert into dispensing_cases (name, expected, actual)
values ('C1 by a session without a membership',
  '23514 Dispensing does not match its eligible Pharmacy work item and actor context',
  pg_temp.try(current_setting('dispensing_check.statement')));
select pg_temp.as_member(2, 1);
-- A dispensing that does not match its work item (another medicine name):
-- 0086's check answers before the source check, even for the cancelled C1.
insert into dispensing_cases (name, expected, actual)
values ('C1 with another medicine name',
  '23514 Dispensing does not match its eligible Pharmacy work item and actor context',
  pg_temp.try(replace(pg_temp.dispense_sql(pg_temp.kept_id('c1')), 'Amoxicillin 500 mg capsule (c1)', 'Something else')));
reset role;
-- The order-route branch answers first for a route-backed work item: one
-- naming the cancelled O7 with a route that does not exist (as replica).
set local session_replication_role = replica;
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
  source_ehr_prescription_version, source_encounter_id, source_status, medication_display, frequency, instructions,
  prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason, idempotency_key,
  request_sha256, correlation_id, order_route_id)
select 'e9d00008-0000-4000-8000-0000000000f0', w.patient_id, w.facility_id, 'e9d00001-0000-4000-8000-000000000002',
       pg_temp.rx('o7'), 1, w.source_encounter_id, 'active', w.medication_display, w.frequency,
       w.instructions, w.prescribed_by, w.prescribed_at, w.accepted_by, w.accepted_by_membership_id, 'Route-backed',
       'pharmacy-dispensing-route-0', repeat('a', 64), 'pharmacy-dispensing-suite', 'e9d00009-0000-4000-8000-000000000001'
  from pharmacy.work_items w where w.id = pg_temp.kept_id('c1');
insert into kept values ('route 0', 'e9d00008-0000-4000-8000-0000000000f0');
set local session_replication_role = origin;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.dispense_case('a route-backed work item whose route does not exist', '23514 ORDER_ROUTE_CLOSED', 'route 0');

-- 6. V1's dispensing (recorded while V1 was active) is reversed after V1 was
-- cancelled.
insert into dispensing_cases (name, expected, actual)
values ('V1''s dispensing reversed after V1 was cancelled', 'ok',
  pg_temp.try(pg_temp.reverse_sql(pg_temp.kept_id('v1 dispensing')), true));
reset role;

-- 7. The sealed demo tenant (0098): installed as the owner, its shares moved
-- an hour back (this transaction's timestamp precedes the install); the demo
-- doctor writes Patient One's prescription at Demo Hospital, accepts it there
-- through pharmacy-api's runtime and dispenses it; once the prescription is
-- cancelled, a second one accepted before the cancellation is refused.
do $$
begin
  if to_regprocedure('identity.sealed_demo_install()') is null then
    raise exception 'the sealed demo tenant (0098) is missing';
  end if;
  perform identity.sealed_demo_install();
  update identity.consent_grants set starts_at = starts_at - interval '1 hour'
   where correlation_id = '0098-sealed-demo-install';
end $$;
set local session_replication_role = replica;
update auth.accounts set status = 'active' where id = '98d00003-0000-4000-8000-000000000001';
set local session_replication_role = origin;
create function pg_temp.as_demo_doctor() returns void language sql as $f$
  select set_config('app.actor_subject', 'sealed-demo:98d00003-0000-4000-8000-000000000001', true),
         set_config('app.facility_id', '98d00002-0000-4000-8000-000000000001', true),
         set_config('app.correlation_id', 'pharmacy-dispensing-demo-' || substr(md5(random()::text), 1, 12), true),
         set_config('app.membership_id', '98d00005-0000-4000-8000-000000000001', true),
         set_config('app.purpose_of_use', 'direct-care', true);
$f$;
create function pg_temp.demo(statement text) returns text language sql as $f$
  select replace(replace(replace(statement, 'e9d00001-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001'),
    'e9d00002-0000-4000-8000-000000000002', '98d00003-0000-4000-8000-000000000001'),
    'e9d00004-0000-4000-8000-000000000002', '98d00005-0000-4000-8000-000000000001')
$f$;
grant execute on function pg_temp.as_demo_doctor() to hid_pharmacy_api_runtime, hid_ehr_api_runtime;
grant execute on function pg_temp.demo(text) to hid_pharmacy_api_runtime;
set local role hid_ehr_api_runtime;
select pg_temp.as_demo_doctor();
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e9d00006-0000-4000-8000-000000000009', '98d00009-0000-4000-8000-000000000001',
  '98d00002-0000-4000-8000-000000000001', '98d00003-0000-4000-8000-000000000001',
  '98d00005-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
select pg_temp.prescribe(pg_temp.rx(n), 'e9d00006-0000-4000-8000-000000000009',
  '98d00009-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001', '98d00003-0000-4000-8000-000000000001',
  '98d00005-0000-4000-8000-000000000001', 'Demo amoxicillin 500 mg (' || n || ')', null)
  from unnest(array['d1', 'd2']) n;
reset role;
select pg_temp.as_demo_doctor();
insert into acceptances select n, pg_temp.demo(pg_temp.accept_sql(pg_temp.rx(n))) from unnest(array['d1', 'd2']) n;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_demo_doctor();
select pg_temp.keep(name, statement) from acceptances where name in ('d1', 'd2');
insert into dispensing_cases (name, expected, actual)
values ('demo: Patient One''s prescription dispensed at Demo Hospital', 'ok',
  pg_temp.try(pg_temp.demo(pg_temp.dispense_sql(pg_temp.kept_id('d1')))));
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.as_demo_doctor();
select pg_temp.change(pg_temp.rx('d2'), 'cancelled', null, null, null, 1, 'Demo cancellation');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_demo_doctor();
insert into dispensing_cases (name, expected, actual)
values ('demo: the same, once its prescription is cancelled', '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE',
  pg_temp.try(pg_temp.demo(pg_temp.dispense_sql(pg_temp.kept_id('d2')))));
reset role;

-- Every case ran and answered as expected.
do $$
declare mismatches text;
begin
  if (select count(*) from dispensing_cases) <> 25 then
    raise exception 'the dispensing check suite ran % cases, not 25', (select count(*) from dispensing_cases);
  end if;
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatches
    from dispensing_cases where actual is distinct from expected;
  if mismatches is not null then
    raise exception E'Pharmacy dispensing source check (owner bypasses row-level security: %):\n%',
      current_setting('dispensing_check.owner_bypasses'), mismatches;
  end if;
  raise notice 'Pharmacy dispensing source suite: % cases passed (owner bypasses row-level security: %)',
    (select count(*) from dispensing_cases), current_setting('dispensing_check.owner_bypasses');
end $$;


-- 8. The lock: a kept dispensing of the work item from before 0100 that is
-- exactly K3 (nothing else in this transaction locked K3) holds K3 FOR SHARE
-- to commit; the same transaction's EHR update still runs.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.keep('old 01 dispensing', pg_temp.dispense_sql(pg_temp.kept_id('old 01')));
reset role;
do $$
declare
  locker xid := (select xmax from ehr.prescriptions where id = pg_temp.rx('k3'));
  mine xid := pg_current_xact_id()::xid;
  held boolean := locker::text = mine::text;
begin
  if not held then
    begin
      held := exists (select 1 from pg_get_multixact_members(locker) member
                       where member.xid::text = mine::text and member.mode = 'sh');
    exception when others then held := false;
    end;
  end if;
  if not held then
    raise exception 'the dispensing does not hold its prescription FOR SHARE';
  end if;
end $$;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.change(pg_temp.rx('k3'), 'completed', null, null, null, 1,
  'Dispensed and completed');
reset role;
do $$
begin
  if (select count(*) from pharmacy.dispensings where id = pg_temp.kept_id('old 01 dispensing')) <> 1
     or (select status from ehr.prescriptions where id = pg_temp.rx('k3')) <> 'completed'
     or (select count(*) from pharmacy.dispensing_reversals where dispensing_id = pg_temp.kept_id('v1 dispensing')) <> 1 then
    raise exception 'the kept dispensing, the reversal or the EHR''s later change is missing';
  end if;
end $$;

rollback;
