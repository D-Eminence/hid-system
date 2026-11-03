\set ON_ERROR_STOP on
-- Prescription strength, form, duration, quantity and priority for the
-- pharmacy (0114, owner decision 25 of 2026-11-01, D-Eminence: "all
-- recommended except D5"; the Akos handover backend plan, items 3b and 4).
-- Rollback-only.
--
-- 0114 adds seven nullable columns to ehr.prescriptions with one CHECK,
-- and pharmacy.work_item_prescription_details(ids), which answers them for
-- each given work item that is this facility's own work and that the
-- session's member may read, from the snapshot of the prescription version
-- Pharmacy accepted (ehr.record_versions). The cases, through the exact EHR
-- and Pharmacy API runtime roles in the session the services set:
--   1. structure: the function is 0114's (md5), SECURITY DEFINER, STABLE,
--      plpgsql, not STRICT, search_path pg_catalog, pg_temp, owned by
--      pharmacy.work_items' owner, EXECUTE for the Pharmacy runtime, its API
--      login and the schema test runtime only; the seven columns nullable
--      without default and their one CHECK validated; the 0100, 0101, 0098
--      and 0086 bodies untouched;
--   2. the CHECK, through the EHR API's INSERT: every value set and range,
--      both pairs, blank and long texts; all seven given, and none (today's
--      INSERT, so a row written before 0114 reads null in each); the EHR
--      runtime reads the new columns;
--   3. the snapshot carries the seven values, and acceptances (pharmacy-api's
--      INSERT under 0100's guard) and a dispensing (0101's guard) pass on
--      prescriptions with and without them;
--   4. a pharmacist gets exactly the accepted version's values for its own
--      rows: all seven, seven nulls for a prescription without them and for
--      one written before 0114 (its snapshot has no such keys); after the EHR
--      changes the prescription (a new version, a changed priority) the work
--      item still answers the accepted version's values, while 0101 still
--      refuses its dispensing;
--   5. no row: a route-backed work item (also one naming this facility's own
--      prescription, as a forged row would); another facility's own work; a
--      patient without a grant for the member; a work item whose snapshot
--      names another patient, another facility, another encounter, or a
--      version that has none;
--      a member with consent but without pharmacy.work-item.read; a session
--      at another facility, without a membership, with an unknown subject or
--      without a purpose of use; a revoked or an expired grant; an active
--      deny directive; a disabled account; a held membership; a malformed
--      facility setting is refused 22023; the EHR and Lab runtimes may not
--      call it (42501); a doctor with consent and the read permission gets
--      its row;
--   6. emergency (D8): a break-glass grant under purpose 'emergency' gets the
--      rows it can read (also under a deny directive), nothing under direct
--      care;
--   7. limits: 200 ids are read; 201 ids (also as a 2 x 101 array) and a null
--      list raise 22023 WORK_ITEM_PRESCRIPTION_DETAILS_INVALID; an empty list
--      answers nothing;
--   8. the reads write nothing (no audit or snapshot row);
--   9. row types: after a further ADD COLUMN on ehr.prescriptions in this
--      same session, which has already run both guards, an EHR prescription,
--      its acceptance and its dispensing still pass and the details read
--      (pharmacy-api's pooled connections re-resolve the row type; the
--      two-session proof is in the release evidence).
-- Identity fixtures are inserted as the suite runner with
-- session_replication_role = replica (CHECK constraints still apply; foreign
-- keys and guards are skipped), and so are the work items that stand for
-- rows accepted before 0100 or from another facility. Synthetic values only;
-- uuid prefix e114.
set plpgsql.variable_conflict = error;
begin;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception 'prescription dispensing details: %: got [%], want [%]', label, got, want;
  end if;
end
$f$;
grant execute on function pg_temp.expect(text, text, text) to public;

-- 1. Structure.
do $$
declare
  mismatch text;
begin
  select string_agg(format('md5=%s owner=%s definer=%s volatile=%s language=%s strict=%s config=%s',
           coalesce(md5(proc.prosrc), 'none (missing)'), pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
           language_row.lanname, proc.proisstrict, proc.proconfig), '; ')
    into mismatch
    from (values ('pharmacy.work_item_prescription_details(uuid[])')) expected(proc_name)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc_name)
    left join pg_language language_row on language_row.oid = proc.prolang
   where proc.oid is null or md5(proc.prosrc) <> 'e6013d732354a56794ad8ec7f2bbaf0c'
      or proc.proowner <> (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass)
      or not proc.prosecdef or proc.provolatile <> 's' or language_row.lanname <> 'plpgsql' or proc.proisstrict
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[];
  if mismatch is not null then
    raise exception 'prescription dispensing details: the function is not 0114''s: %', mismatch;
  end if;
  select string_agg(format('%s %s', acl.grantee::regrole, acl.privilege_type), '; ') into mismatch
    from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
   where proc.oid = 'pharmacy.work_item_prescription_details(uuid[])'::regprocedure
     and acl.grantee <> proc.proowner
     and (acl.grantee = 0 or acl.privilege_type <> 'EXECUTE'
       or acl.grantee::regrole::text not in ('hid_pharmacy_runtime', 'hid_schema_test_runtime'));
  if mismatch is not null then
    raise exception 'prescription dispensing details: unexpected grants: %', mismatch;
  end if;
  -- Who may execute it, through any membership: the Pharmacy runtime, its API
  -- login and the schema test runtime; no other runtime or API login.
  select string_agg(format('%s=%s', role_row.rolname,
           has_function_privilege(role_row.oid, 'pharmacy.work_item_prescription_details(uuid[])', 'EXECUTE')), '; ')
    into mismatch
    from pg_roles role_row
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_function_privilege(role_row.oid, 'pharmacy.work_item_prescription_details(uuid[])', 'EXECUTE')
         <> (role_row.rolname in ('hid_pharmacy_runtime', 'hid_pharmacy_api_runtime', 'hid_schema_test_runtime'));
  if mismatch is not null then
    raise exception 'prescription dispensing details: EXECUTE differs: %', mismatch;
  end if;
  if (select count(*) from pg_roles where rolname in ('hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
        'hid_schema_test_runtime', 'hid_ehr_api_runtime', 'hid_lab_api_runtime')) <> 5 then
    raise exception 'prescription dispensing details: the runtime roles are not bootstrapped';
  end if;
  select string_agg(attribute_row.attname || ' ' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
           || case when attribute_row.attnotnull then ' not null' else '' end
           || case when attribute_row.atthasdef then ' default' else '' end, ', ' order by attribute_row.attnum)
    into mismatch
    from pg_attribute attribute_row
   where attribute_row.attrelid = 'ehr.prescriptions'::regclass and not attribute_row.attisdropped
     and attribute_row.attname in ('priority', 'medication_strength', 'medication_dose_form', 'duration_value',
           'duration_unit', 'quantity_to_dispense', 'quantity_unit');
  if mismatch is distinct from 'priority text, medication_strength text, medication_dose_form text, '
       || 'duration_value integer, duration_unit text, quantity_to_dispense numeric(12,4), quantity_unit text' then
    raise exception 'prescription dispensing details: the columns are %', mismatch;
  end if;
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid = 'ehr.prescriptions'::regclass and constraint_row.contype = 'c'
         and constraint_row.convalidated and constraint_row.conname = 'prescriptions_dispensing_details_ck') <> 1 then
    raise exception 'prescription dispensing details: the CHECK is not there and validated';
  end if;
  if (select count(*) from pg_proc proc
       where (proc.oid::regprocedure::text, md5(proc.prosrc)) in (
         ('pharmacy.validate_work_item()', 'e2411539ee8c95a02dad46c03e24db05'),
         ('pharmacy.validate_dispensing()', '17f7e8897bd2ab240332e4d2c9f757b7'),
         ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)',
          '4202ba3bbf02abd7db34606d42adca9c'),
         ('ehr.sync_order_routes_on_order_change()', '8ce6b42450cc06fc02fec8d1cf63af41'),
         ('ehr.capture_record_version()', '70daa16f05bb3ec28f05292e6358a702'))) <> 5 then
    raise exception 'prescription dispensing details: a body 0114 leaves untouched has changed';
  end if;
end $$;

-- Fixtures. Organization (e1140000...01); facilities F1 "Details Test
-- Clinic" (e1140001...01) and F2 "Details Test Annex" (...02). Members
-- (account e1140002...0n, staff e1140003...0n, membership e1140004...0n,
-- role e1140005...0n): 1 DR doctor at F1, 2 PH pharmacist at F1, 3 LS
-- laboratory scientist at F1, 4 P2 pharmacist at F2, 5 PE pharmacist at F1
-- (emergency grant only), 6 D2 doctor at F2. Patients (e1140006...0n):
-- 1 Ngozi, 2 Femi, 3 Kemi.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'prescription-details-test'),
  ('emergency', 'Emergency treatment', 'prescription-details-test')
on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1140000-0000-4000-8000-000000000001', 'Details Test Organization', 'details-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1140001-0000-4000-8000-000000000001', 'e1140000-0000-4000-8000-000000000001', 'Details Test Clinic',
   'DETAILS-TEST-1', 'Africa/Lagos', true, 'verified'),
  ('e1140001-0000-4000-8000-000000000002', 'e1140000-0000-4000-8000-000000000001', 'Details Test Annex',
   'DETAILS-TEST-2', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1140002-0000-4000-8000-00000000000' || member.n)::uuid, 'synthetic:details-' || member.code,
       'details-' || member.code || '@example.invalid', member.full_name, 'active'
  from (values (1, 'dr', 'Details Doctor'), (2, 'ph', 'Details Pharmacist'), (3, 'ls', 'Details Lab Scientist'),
               (4, 'p2', 'Details Annex Pharmacist'), (5, 'pe', 'Details Emergency Pharmacist'),
               (6, 'd2', 'Details Annex Doctor')) member(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1140003-0000-4000-8000-00000000000' || member.n)::uuid, ('e1140002-0000-4000-8000-00000000000' || member.n)::uuid,
       account.display_name, account.email, 'verified', member.role_code
  from (values (1, 'doctor'), (2, 'pharmacist'), (3, 'lab'), (4, 'pharmacist'), (5, 'pharmacist'), (6, 'doctor'))
       member(n, role_code)
  join auth.accounts account on account.id = ('e1140002-0000-4000-8000-00000000000' || member.n)::uuid;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1140004-0000-4000-8000-00000000000' || member.n)::uuid, ('e1140003-0000-4000-8000-00000000000' || member.n)::uuid,
       ('e1140002-0000-4000-8000-00000000000' || member.n)::uuid, 'e1140000-0000-4000-8000-000000000001',
       ('e1140001-0000-4000-8000-00000000000' || member.site)::uuid, member.role_code, member.role_code, true, true
  from (values (1, 1, 'doctor'), (2, 1, 'pharmacist'), (3, 1, 'lab'), (4, 2, 'pharmacist'), (5, 1, 'pharmacist'),
               (6, 2, 'doctor')) member(n, site, role_code);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e1140005-0000-4000-8000-00000000000' || member.n)::uuid, ('e1140002-0000-4000-8000-00000000000' || member.n)::uuid,
       member.role_code, 'facility', ('e1140004-0000-4000-8000-00000000000' || member.n)::uuid,
       ('e1140001-0000-4000-8000-00000000000' || member.site)::uuid, 'Details suite role'
  from (values (1, 1, 'doctor'), (2, 1, 'pharmacist'), (3, 1, 'lab'), (4, 2, 'pharmacist'), (5, 1, 'pharmacist'),
               (6, 2, 'doctor')) member(n, site, role_code);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e1140006-0000-4000-8000-000000000001', 'HID-DTLSAAA2', 'Ngozi', 'Details', 'Ngozi Details', 'female', '1990-04-05',
   'active'),
  ('e1140006-0000-4000-8000-000000000002', 'HID-DTLSBBB3', 'Femi', 'Details', 'Femi Details', 'male', '1985-09-10',
   'active'),
  ('e1140006-0000-4000-8000-000000000003', 'HID-DTLSCCC4', 'Kemi', 'Details', 'Kemi Details', 'female', '2001-01-20',
   'active');
-- Direct-care write grants (which also allow reads): DR for Ngozi, Femi and
-- Kemi at F1; PH for Ngozi and Femi at F1; LS for Ngozi at F1; P2 and D2 for
-- Ngozi at F2. A break-glass read grant: PE for Ngozi at F1.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass)
select ('e1140008-0000-4000-8000-0000000000' || grant_row.member || grant_row.patient)::uuid,
       ('e1140006-0000-4000-8000-00000000000' || grant_row.patient)::uuid,
       ('e1140003-0000-4000-8000-00000000000' || grant_row.member)::uuid,
       ('e1140002-0000-4000-8000-00000000000' || grant_row.member)::uuid,
       ('e1140004-0000-4000-8000-00000000000' || grant_row.member)::uuid,
       ('e1140001-0000-4000-8000-00000000000' || grant_row.site)::uuid,
       case when grant_row.emergency then 'break_glass' else 'write_records' end,
       case when grant_row.emergency then 'emergency' else 'direct-care' end, 'active',
       case when grant_row.emergency then 'Synthetic emergency for the details suite' else 'Synthetic details consent' end,
       clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', grant_row.emergency
  from (values (1, 1, 1, false), (1, 2, 1, false), (1, 3, 1, false), (2, 1, 1, false), (2, 2, 1, false),
               (3, 1, 1, false), (4, 1, 2, false), (6, 1, 2, false), (5, 1, 1, true)) grant_row(member, patient, site, emergency);
set local session_replication_role = origin;

-- The session the EHR API and pharmacy-api set for a staff request.
create function pg_temp.as_member(member integer, site integer, purpose text default 'direct-care') returns void
language sql as $f$
  select set_config('app.actor_subject', 'synthetic:details-'
           || (array['dr', 'ph', 'ls', 'p2', 'pe', 'd2'])[member], true),
         set_config('app.facility_id', 'e1140001-0000-4000-8000-00000000000' || site, true),
         set_config('app.correlation_id', 'details-suite-' || substr(md5(random()::text), 1, 12), true),
         set_config('app.membership_id', 'e1140004-0000-4000-8000-00000000000' || member, true),
         set_config('app.purpose_of_use', purpose, true);
$f$;
-- The EHR API's INSERT with the seven new columns (prescriptions.service.ts
-- create, PRESCRIPTION_DISPENSING_DETAILS_ENABLED on), for prescriber n at
-- site s; and today's INSERT, without them.
create function pg_temp.prescribe_sql(prescription uuid, encounter uuid, patient uuid, member integer, site integer,
  display text, priority text, strength text, dose_form text, duration_value integer, duration_unit text,
  quantity numeric, quantity_unit text) returns text language sql as $f$
  select format($i$insert into ehr.prescriptions (
       id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
       medication_code_system, medication_code, medication_display, dose_quantity, dose_unit,
       route_code, frequency, instructions, starts_on, ends_on, status,
       priority, medication_strength, medication_dose_form, duration_value, duration_unit,
       quantity_to_dispense, quantity_unit
     ) values (%L,%L,%L,%L,%L,%L,null,null,%L,1,'dose','oral','Every 8 hours','Take after food',
       '2026-11-02','2026-11-08','active',%L,%L,%L,%L,%L,%L,%L)$i$,
    prescription, encounter, patient, 'e1140001-0000-4000-8000-00000000000' || site,
    'e1140002-0000-4000-8000-00000000000' || member, 'e1140004-0000-4000-8000-00000000000' || member,
    display, priority, strength, dose_form, duration_value, duration_unit, quantity, quantity_unit)
$f$;
create function pg_temp.prescribe_today_sql(encounter uuid, patient uuid, member integer, site integer,
  display text) returns text language sql as $f$
  select format($i$insert into ehr.prescriptions (
       encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
       medication_code_system, medication_code, medication_display, dose_quantity, dose_unit,
       route_code, frequency, instructions, starts_on, ends_on, status
     ) values (%L,%L,%L,%L,%L,null,null,%L,null,null,null,'Once daily','In the morning',null,null,'active')$i$,
    encounter, patient, 'e1140001-0000-4000-8000-00000000000' || site,
    'e1140002-0000-4000-8000-00000000000' || member, 'e1140004-0000-4000-8000-00000000000' || member, display)
$f$;
-- A statement's outcome ('ok', or 'SQLSTATE message'): run keeps its effect,
-- try always undoes it.
create function pg_temp.run(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.try(statement text) returns text language plpgsql as $f$
declare outcome text;
begin
  begin
    execute statement;
    outcome := 'ok';
    raise exception using errcode = 'P0001', message = 'details-suite: undo';
  exception when others then
    if sqlerrm <> 'details-suite: undo' then outcome := sqlstate || ' ' || sqlerrm; end if;
  end;
  return outcome;
end $f$;
-- The EHR API's UPDATE (prescriptions.service.ts update), and a direct
-- UPDATE of the priority by the EHR runtime (no EHR route does it; a new
-- version either way).
create function pg_temp.change(prescription uuid, new_instructions text, new_priority text, expected_version bigint)
returns void language plpgsql as $f$
begin
  perform set_config('app.change_reason', 'Changed by the prescriber in the details suite', true);
  update ehr.prescriptions set instructions = coalesce(new_instructions, instructions),
    priority = coalesce(new_priority, priority)
   where id = prescription and row_version = expected_version;
  if not found then raise exception 'details suite: % was not at version %', prescription, expected_version; end if;
end $f$;
-- The ids of the ten work items (e114000b...NN), and the answers in a
-- comparable form: the work item's last two digits, then
-- priority/strength/form/duration/quantity ('-' for null).
create function pg_temp.items() returns uuid[] language sql as $f$
  select array_agg(('e114000b-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid order by n)
    from generate_series(1, 10) n;
$f$;
create function pg_temp.details(ids uuid[]) returns text language sql as $f$
  select coalesce(string_agg(format('%s:%s/%s/%s/%s/%s', right(detail.work_item_id::text, 2),
           coalesce(detail.priority, '-'), coalesce(detail.medication_strength, '-'),
           coalesce(detail.medication_dose_form, '-'),
           coalesce(detail.duration_value || ' ' || detail.duration_unit, '-'),
           coalesce(detail.quantity_to_dispense || ' ' || detail.quantity_unit, '-')), ' ' order by detail.work_item_id), '')
    from pharmacy.work_item_prescription_details(ids) detail;
$f$;
create function pg_temp.detail_ids() returns text language sql as $f$
  select coalesce(string_agg(right(detail.work_item_id::text, 2), ' ' order by detail.work_item_id), '')
    from pharmacy.work_item_prescription_details(pg_temp.items()) detail;
$f$;
-- The own work items the session can read under row-level security.
create function pg_temp.visible_own() returns text language sql as $f$
  select coalesce(string_agg(right(item.id::text, 2), ' ' order by item.id), '')
    from pharmacy.work_items item where item.id = any(pg_temp.items()) and item.order_route_id is null;
$f$;
create function pg_temp.refusal(ids uuid[]) returns text language plpgsql as $f$
begin
  perform pg_temp.details(ids);
  return 'no error';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', proc.signature);
  end loop;
end $$;

-- The EHR rows, through the EHR runtime with the EHR API's statements.
-- Encounters E1 (Ngozi), E2 (Femi), E3 (Kemi) at F1 by DR; E4 (Ngozi) at F2
-- by D2.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1, 1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e1140009-0000-4000-8000-00000000000' || n)::uuid, ('e1140006-0000-4000-8000-00000000000' || patient)::uuid,
       'e1140001-0000-4000-8000-000000000001', 'e1140002-0000-4000-8000-000000000001',
       'e1140004-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp()
  from (values (1, 1), (2, 2), (3, 3)) encounter(n, patient);

-- 2. The CHECK, case by case, through the EHR API's INSERT (undone).
create temporary table check_cases (name text primary key, got text not null) on commit drop;
grant select, insert on check_cases to public;
insert into check_cases
select check_case.name, pg_temp.try(pg_temp.prescribe_sql(gen_random_uuid(), 'e1140009-0000-4000-8000-000000000001',
         'e1140006-0000-4000-8000-000000000001', 1, 1, 'Probe medicine', check_case.priority, check_case.strength,
         check_case.dose_form, check_case.duration_value, check_case.duration_unit, check_case.quantity,
         check_case.quantity_unit))
  from (values
    ('all seven', 'stat', '500 mg', 'capsule', 7, 'day', 21::numeric, 'capsule'),
    ('none', null, null, null, null, null, null, null),
    ('each priority: routine', 'routine', null, null, null, null, null, null),
    ('each priority: urgent', 'urgent', null, null, null, null, null, null),
    ('each priority: asap', 'asap', null, null, null, null, null, null),
    ('another priority', 'high', null, null, null, null, null, null),
    ('a capitalised priority', 'Urgent', null, null, null, null, null, null),
    ('each form: tablet', null, null, 'tablet', null, null, null, null),
    ('each form: liquid', null, null, 'liquid', null, null, null, null),
    ('each form: injection', null, null, 'injection', null, null, null, null),
    ('each form: cream', null, null, 'cream', null, null, null, null),
    ('each form: inhaler', null, null, 'inhaler', null, null, null, null),
    ('each form: drops', null, null, 'drops', null, null, null, null),
    ('each form: other', null, null, 'other', null, null, null, null),
    ('another form', null, null, 'pill', null, null, null, null),
    ('a strength of 80', null, repeat('m', 80), null, null, null, null, null),
    ('a strength of 81', null, repeat('m', 81), null, null, null, null, null),
    ('an empty strength', null, '', null, null, null, null, null),
    ('a blank strength', null, '   ', null, null, null, null, null),
    ('duration 1 week', null, null, null, 1, 'week', null, null),
    ('duration 3650 days', null, null, null, 3650, 'day', null, null),
    ('duration 12 months', null, null, null, 12, 'month', null, null),
    ('duration 0', null, null, null, 0, 'day', null, null),
    ('duration 3651', null, null, null, 3651, 'day', null, null),
    ('duration in years', null, null, null, 1, 'year', null, null),
    ('a duration without its unit', null, null, null, 7, null, null, null),
    ('a duration unit without its value', null, null, null, null, 'day', null, null),
    ('quantity 0.0001', null, null, null, null, null, 0.0001, 'g'),
    ('quantity 99999999.9999', null, null, null, null, null, 99999999.9999, 'mL'),
    ('quantity 0', null, null, null, null, null, 0, 'tablet'),
    ('a negative quantity', null, null, null, null, null, -1, 'tablet'),
    ('quantity 100000000', null, null, null, null, null, 100000000, 'tablet'),
    ('a quantity without its unit', null, null, null, null, null, 21, null),
    ('a quantity unit without its quantity', null, null, null, null, null, null, 'tablet'),
    ('a quantity unit of 81', null, null, null, null, null, 21, repeat('u', 81)),
    ('a blank quantity unit', null, null, null, null, null, 21, ' '))
         check_case(name, priority, strength, dose_form, duration_value, duration_unit, quantity, quantity_unit);
select pg_temp.expect('the CHECK outcomes',
  (select string_agg(name || '=' || regexp_replace(got, '^23514 new row for relation "prescriptions" violates check constraint ', ''), '; '
            order by name) from check_cases),
  (select string_agg(name || '=' || got, '; ' order by name) from (values
    ('a blank quantity unit', '"prescriptions_dispensing_details_ck"'),
    ('a blank strength', '"prescriptions_dispensing_details_ck"'),
    ('a capitalised priority', '"prescriptions_dispensing_details_ck"'),
    ('a duration unit without its value', '"prescriptions_dispensing_details_ck"'),
    ('a duration without its unit', '"prescriptions_dispensing_details_ck"'),
    ('a negative quantity', '"prescriptions_dispensing_details_ck"'),
    ('a quantity unit of 81', '"prescriptions_dispensing_details_ck"'),
    ('a quantity unit without its quantity', '"prescriptions_dispensing_details_ck"'),
    ('a quantity without its unit', '"prescriptions_dispensing_details_ck"'),
    ('a strength of 80', 'ok'),
    ('a strength of 81', '"prescriptions_dispensing_details_ck"'),
    ('all seven', 'ok'),
    ('an empty strength', '"prescriptions_dispensing_details_ck"'),
    ('another form', '"prescriptions_dispensing_details_ck"'),
    ('another priority', '"prescriptions_dispensing_details_ck"'),
    ('duration 0', '"prescriptions_dispensing_details_ck"'),
    ('duration 1 week', 'ok'),
    ('duration 12 months', 'ok'),
    ('duration 3650 days', 'ok'),
    ('duration 3651', '"prescriptions_dispensing_details_ck"'),
    ('duration in years', '"prescriptions_dispensing_details_ck"'),
    ('each form: cream', 'ok'), ('each form: drops', 'ok'), ('each form: inhaler', 'ok'),
    ('each form: injection', 'ok'), ('each form: liquid', 'ok'), ('each form: other', 'ok'),
    ('each form: tablet', 'ok'),
    ('each priority: asap', 'ok'), ('each priority: routine', 'ok'), ('each priority: urgent', 'ok'),
    ('none', 'ok'),
    ('quantity 0', '"prescriptions_dispensing_details_ck"'),
    ('quantity 0.0001', 'ok'),
    ('quantity 100000000', '22003 numeric field overflow'),
    ('quantity 99999999.9999', 'ok')) expected(name, got)));

-- The prescriptions (e1140007...XX): a1 Ngozi, every value; b1 Ngozi, today's
-- INSERT (none); c1 Femi, every value; d1 Kemi; e1, e2, e3, e4 Ngozi (named
-- by the mismatched work items); f1 Ngozi (its snapshot is made pre-0114
-- below); at F2 by D2: a2, a3 and a4 Ngozi.
select pg_temp.expect('the EHR prescriptions at F1', (select string_agg(pg_temp.run(pg_temp.prescribe_sql(
    ('e1140007-0000-4000-8000-0000000000' || p.code)::uuid, ('e1140009-0000-4000-8000-00000000000' || p.encounter)::uuid,
    ('e1140006-0000-4000-8000-00000000000' || p.patient)::uuid, 1, 1, p.display, p.priority, p.strength, p.dose_form,
    p.duration_value, p.duration_unit, p.quantity, p.quantity_unit)), ' ' order by p.code)
  from (values
    ('a1', 1, 1, 'Amoxicillin 500 mg capsule', 'urgent', '500 mg', 'capsule', 7, 'day', 21::numeric, 'capsule'),
    ('c1', 2, 2, 'Paracetamol suspension', 'stat', '120 mg/5 mL', 'liquid', 2, 'week', 100.5, 'mL'),
    ('d1', 3, 3, 'Amlodipine 10 mg', 'asap', '10 mg', 'tablet', 1, 'month', 30, 'tablet'),
    ('e1', 1, 1, 'Ceftriaxone 1 g', 'routine', '1 g', 'injection', 3, 'day', 3, 'vial'),
    ('e2', 1, 1, 'Salbutamol inhaler', 'routine', '100 mcg/dose', 'inhaler', 1, 'month', 1, 'inhaler'),
    ('e3', 1, 1, 'Hydrocortisone cream', 'routine', '1%', 'cream', 2, 'week', 1, 'tube'),
    ('e4', 1, 1, 'Doxycycline 100 mg', 'urgent', '100 mg', 'capsule', 7, 'day', 14, 'capsule'),
    ('f1', 1, 1, 'Chloramphenicol eye drops', 'urgent', '0.5%', 'drops', 5, 'day', 1, 'bottle'))
       p(code, encounter, patient, display, priority, strength, dose_form, duration_value, duration_unit, quantity,
         quantity_unit)), 'ok ok ok ok ok ok ok ok');
-- b1, through today's INSERT (no new column named; its id from the column
-- default, so it is found by its medicine).
select pg_temp.expect('today''s INSERT', pg_temp.run(pg_temp.prescribe_today_sql('e1140009-0000-4000-8000-000000000001',
  'e1140006-0000-4000-8000-000000000001', 1, 1, 'Omeprazole 20 mg (details suite)')), 'ok');
select set_config('details.b1', (select id::text from ehr.prescriptions
  where medication_display = 'Omeprazole 20 mg (details suite)'), true);
select pg_temp.expect('the EHR runtime reads the new columns of a1 and b1',
  (select string_agg(format('%s/%s/%s/%s/%s/%s/%s', coalesce(priority, '-'), coalesce(medication_strength, '-'),
     coalesce(medication_dose_form, '-'), coalesce(duration_value::text, '-'), coalesce(duration_unit, '-'),
     coalesce(quantity_to_dispense::text, '-'), coalesce(quantity_unit, '-')), ' ' order by created_at, id)
     from ehr.prescriptions
    where id in ('e1140007-0000-4000-8000-0000000000a1', current_setting('details.b1')::uuid)),
  'urgent/500 mg/capsule/7/day/21.0000/capsule -/-/-/-/-/-/-');
select pg_temp.as_member(6, 2);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e1140009-0000-4000-8000-000000000004', 'e1140006-0000-4000-8000-000000000001',
  'e1140001-0000-4000-8000-000000000002', 'e1140002-0000-4000-8000-000000000006',
  'e1140004-0000-4000-8000-000000000006', 'ambulatory', 'in_progress', clock_timestamp());
select pg_temp.expect('the EHR prescriptions at F2', (select string_agg(pg_temp.run(pg_temp.prescribe_sql(
    ('e1140007-0000-4000-8000-0000000000' || p.code)::uuid, 'e1140009-0000-4000-8000-000000000004',
    'e1140006-0000-4000-8000-000000000001', 6, 2, p.display, 'routine', p.strength, 'tablet', 5, 'day', 10, 'tablet')),
    ' ' order by p.code)
  from (values ('a2', 'Metronidazole 400 mg', '400 mg'), ('a3', 'Ibuprofen 400 mg', '400 mg'),
               ('a4', 'Ciprofloxacin 500 mg', '500 mg')) p(code, display, strength)),
  'ok ok ok');
reset role;

-- 3. The snapshot carries the values (a1 at version 1, as the owner).
select pg_temp.expect('a1''s snapshot', (select format('%s/%s/%s/%s/%s/%s/%s/%s', resource_type, version_no,
    resulting_state->>'priority', resulting_state->>'medication_strength', resulting_state->>'medication_dose_form',
    resulting_state->>'duration_value', resulting_state->>'duration_unit',
    resulting_state->>'quantity_to_dispense' || ' ' || (resulting_state->>'quantity_unit'))
  from ehr.record_versions where resource_id = 'e1140007-0000-4000-8000-0000000000a1'),
  'prescriptions/1/urgent/500 mg/capsule/7/day/21.0000 capsule');
select pg_temp.expect('b1''s snapshot has the seven keys, all null', (select string_agg(key || '=' || coalesce(value, 'null'),
    ' ' order by key) from ehr.record_versions version_row,
    jsonb_each_text(version_row.resulting_state) state(key, value)
   where version_row.resource_id = current_setting('details.b1')
     and key in ('priority', 'medication_strength', 'medication_dose_form', 'duration_value', 'duration_unit',
                 'quantity_to_dispense', 'quantity_unit')),
  'duration_unit=null duration_value=null medication_dose_form=null medication_strength=null priority=null '
  || 'quantity_to_dispense=null quantity_unit=null');

-- pharmacy-api's INSERT (PharmacyService.acceptPrescription) for prescription
-- p as work item w, built here as the owner from the row as the EHR API
-- hands it off (calendar dates, created_at to the millisecond, dose as a
-- number), for accepter n at site s.
create function pg_temp.acceptance_sql(item text, prescription uuid, accepter integer) returns text
language sql as $f$
  select format($i$insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,%L,%L,%L,%L,%L,'active',%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)$i$,
    ('e114000b-0000-4000-8000-0000000000' || item)::uuid, p.patient_id, p.facility_id, p.facility_id, p.id,
    p.row_version, p.encounter_id, p.medication_code_system, p.medication_code, p.medication_display,
    p.dose_quantity::text::float8::text, p.dose_unit, p.route_code, p.frequency, p.instructions,
    to_char(p.starts_on, 'YYYY-MM-DD'), to_char(p.ends_on, 'YYYY-MM-DD'), p.created_by,
    to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'e1140002-0000-4000-8000-00000000000' || accepter, 'e1140004-0000-4000-8000-00000000000' || accepter,
    'Accepted for dispensing', 'details-suite-' || item || '-' || replace(gen_random_uuid()::text, '-', ''),
    repeat('e', 64), 'details-suite-accept-' || item)
  from ehr.prescriptions p where p.id = prescription
$f$;
create temporary table acceptances (name text primary key, statement text not null) on commit drop;
grant select on acceptances to public;
insert into acceptances
select accept.item, pg_temp.acceptance_sql(accept.item, coalesce(('e1140007-0000-4000-8000-0000000000' || accept.code)::uuid,
         current_setting('details.b1')::uuid), accept.accepter)
  from (values ('01', 'a1', 2), ('02', null, 2), ('03', 'c1', 2), ('05', 'a2', 4), ('10', 'f1', 2))
       accept(item, code, accepter);
select pg_temp.expect('five acceptances built', (select count(*)::text from acceptances where statement is not null), '5');
-- pharmacy-api's dispensing INSERT (PharmacyService.dispense) for work item w,
-- as the session's member.
create function pg_temp.dispense_sql(work_item uuid) returns text language sql as $f$
  select format($i$insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)$i$,
    gen_random_uuid(), w.id, 1, w.patient_id, w.facility_id, w.medication_code_system, w.medication_code,
    w.medication_display, 21, 'capsule', replace(current_setting('app.membership_id'), 'e1140004-', 'e1140002-'),
    current_setting('app.membership_id'),
    'Dispensed to the patient', 'details-dispensing-' || replace(gen_random_uuid()::text, '-', ''), repeat('d', 64),
    current_setting('app.correlation_id'))
  from pharmacy.work_items w where w.id = work_item
$f$;
grant execute on function pg_temp.dispense_sql(uuid) to public;

-- 3. The acceptances pass 0100's guard, as PH at F1 and P2 at F2.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH accepts a1, b1, c1 and f1', (select string_agg(pg_temp.run(statement), ' ' order by name)
  from acceptances where name in ('01', '02', '03', '10')), 'ok ok ok ok');
select pg_temp.as_member(4, 2);
select pg_temp.expect('P2 accepts a2 at F2', pg_temp.run((select statement from acceptances where name = '05')), 'ok');
reset role;
-- The work items that stand for rows accepted before 0100 or from another
-- facility (as the owner, replica): 04 Kemi's d1 accepted by DR; 06 routed
-- to F1 from F2, a3; 07 Femi's naming Ngozi's e1; 08 Ngozi's e2 with another
-- encounter; 09 Ngozi's e3 at a version it never had; 12 a route-backed row
-- naming this facility's own e4, and 13 an own row at F1 naming F2's a4 (no
-- guard makes either; they stand for forged rows).
set local session_replication_role = replica;
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
  source_ehr_prescription_version, source_encounter_id, source_status, status, medication_display, frequency,
  instructions, prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason,
  idempotency_key, request_sha256, correlation_id, order_route_id)
select ('e114000b-0000-4000-8000-0000000000' || item.n)::uuid, ('e1140006-0000-4000-8000-00000000000' || item.patient)::uuid,
       ('e1140001-0000-4000-8000-00000000000' || item.site)::uuid,
       ('e1140001-0000-4000-8000-00000000000' || item.ordering)::uuid,
       ('e1140007-0000-4000-8000-0000000000' || item.code)::uuid, item.version, item.encounter::uuid,
       'active', 'accepted', 'Legacy work item', 'Every 8 hours', 'Take after food',
       'e1140002-0000-4000-8000-000000000001', clock_timestamp(), ('e1140002-0000-4000-8000-00000000000' || item.member)::uuid,
       ('e1140004-0000-4000-8000-00000000000' || item.member)::uuid, 'Accepted for the details suite',
       'details-legacy-item-' || item.n || '-key', md5('details-legacy-' || item.n) || md5('details-legacy-' || item.n),
       'details-suite-legacy-' || item.n,
       item.route::uuid
  from (values ('04', 3, 1, 1, 'd1', 1, 'e1140009-0000-4000-8000-000000000003', 1, null),
               ('06', 1, 1, 2, 'a3', 1, 'e1140009-0000-4000-8000-000000000004', 2, 'e114000c-0000-4000-8000-000000000001'),
               ('07', 2, 1, 1, 'e1', 1, 'e1140009-0000-4000-8000-000000000001', 2, null),
               ('08', 1, 1, 1, 'e2', 1, 'e1140009-0000-4000-8000-000000000002', 2, null),
               ('09', 1, 1, 1, 'e3', 5, 'e1140009-0000-4000-8000-000000000001', 2, null),
               ('12', 1, 1, 2, 'e4', 1, 'e1140009-0000-4000-8000-000000000001', 2, 'e114000c-0000-4000-8000-000000000002'),
               ('13', 1, 1, 1, 'a4', 1, 'e1140009-0000-4000-8000-000000000004', 2, null))
       item(n, patient, site, ordering, code, version, encounter, member, route);
-- f1 as if prescribed before 0114: its snapshot without the seven keys.
update ehr.record_versions set resulting_state = resulting_state - array['priority', 'medication_strength',
    'medication_dose_form', 'duration_value', 'duration_unit', 'quantity_to_dispense', 'quantity_unit']
 where resource_type = 'prescriptions' and resource_id = 'e1140007-0000-4000-8000-0000000000f1';
set local session_replication_role = origin;
select set_config('details.audit_before', (select count(*)::text from audit.events), true),
  set_config('details.versions_before', (select count(*)::text from ehr.record_versions), true);

-- 4-7. Through pharmacy-api's runtime.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH reads its own rows'' details', pg_temp.details(pg_temp.items()),
  '01:urgent/500 mg/capsule/7 day/21.0000 capsule 02:-/-/-/-/- 03:stat/120 mg/5 mL/liquid/2 week/100.5000 mL '
  || '10:-/-/-/-/-');
select pg_temp.expect('PH: row-level security shows its own rows 01-03 and 07-10', pg_temp.visible_own(),
  '01 02 03 07 08 09 10');
select pg_temp.expect('PH: one routed row alone', pg_temp.details(array['e114000b-0000-4000-8000-000000000006'::uuid]), '');
select pg_temp.expect('PH: row-level security shows the route-backed row naming e4',
  (select count(*)::text from pharmacy.work_items where id = 'e114000b-0000-4000-8000-000000000012'), '1');
select pg_temp.expect('PH: a route-backed row naming this facility''s own prescription',
  pg_temp.details(array['e114000b-0000-4000-8000-000000000012'::uuid]), '');
select pg_temp.expect('PH: row-level security shows the own row naming F2''s a4',
  (select count(*)::text from pharmacy.work_items where id = 'e114000b-0000-4000-8000-000000000013'), '1');
select pg_temp.expect('PH: an own row naming another facility''s prescription',
  pg_temp.details(array['e114000b-0000-4000-8000-000000000013'::uuid]), '');
select pg_temp.expect('PH: Kemi''s, without a grant', pg_temp.details(array['e114000b-0000-4000-8000-000000000004'::uuid]), '');
select pg_temp.expect('PH: F2''s own row', pg_temp.details(array['e114000b-0000-4000-8000-000000000005'::uuid]), '');
select pg_temp.expect('PH: a snapshot of another patient, another encounter, or no snapshot at that version',
  pg_temp.details(array['e114000b-0000-4000-8000-000000000007'::uuid, 'e114000b-0000-4000-8000-000000000008'::uuid,
    'e114000b-0000-4000-8000-000000000009'::uuid]), '');
select pg_temp.expect('PH: repeated, unknown and null ids', pg_temp.details(array['e114000b-0000-4000-8000-000000000001'::uuid,
  'e114000b-0000-4000-8000-000000000001'::uuid, 'e114000b-0000-4000-8000-000000000099'::uuid, null]),
  '01:urgent/500 mg/capsule/7 day/21.0000 capsule');
select pg_temp.expect('PH: an empty list', pg_temp.details(array[]::uuid[]), '');
select pg_temp.expect('PH: 200 ids are read', pg_temp.details(array['e114000b-0000-4000-8000-000000000003'::uuid]
  || array(select gen_random_uuid() from generate_series(1, 199))), '03:stat/120 mg/5 mL/liquid/2 week/100.5000 mL');
select pg_temp.expect('PH: 201 ids', pg_temp.refusal(array(select gen_random_uuid() from generate_series(1, 201))),
  '22023: WORK_ITEM_PRESCRIPTION_DETAILS_INVALID');
select pg_temp.expect('PH: a 2 x 101 array', pg_temp.refusal((select array_agg(pair.ids) from (
    select array[gen_random_uuid(), gen_random_uuid()] ids from generate_series(1, 101)) pair)),
  '22023: WORK_ITEM_PRESCRIPTION_DETAILS_INVALID');
select pg_temp.expect('PH: a null list', pg_temp.refusal(null), '22023: WORK_ITEM_PRESCRIPTION_DETAILS_INVALID');
-- 3. 0101's guard dispenses a1 (its row type has the new columns).
select pg_temp.expect('PH dispenses a1', pg_temp.try(pg_temp.dispense_sql('e114000b-0000-4000-8000-000000000001')), 'ok');
-- Sessions that do not resolve, or resolve to another facility.
select pg_temp.as_member(2, 2);
select pg_temp.expect('PH with F2 as its facility', pg_temp.details(pg_temp.items()), '');
select pg_temp.as_member(2, 1), set_config('app.membership_id', '', true);
select pg_temp.expect('PH without a membership', pg_temp.details(pg_temp.items()), '');
select pg_temp.as_member(2, 1), set_config('app.actor_subject', 'synthetic:details-nobody', true);
select pg_temp.expect('an unknown subject', pg_temp.details(pg_temp.items()), '');
select pg_temp.as_member(2, 1, '');
select pg_temp.expect('PH with no purpose of use', pg_temp.details(pg_temp.items()), '');
select pg_temp.as_member(2, 1, 'emergency');
select pg_temp.expect('PH under emergency without a break-glass grant', pg_temp.details(pg_temp.items()), '');
select pg_temp.as_member(2, 1), set_config('app.membership_id', 'e1140004-0000-4000-8000-000000000005', true);
select pg_temp.expect('PH''s subject with PE''s membership', pg_temp.details(pg_temp.items()), '');
select pg_temp.as_member(2, 1), set_config('app.facility_id', 'not-a-uuid', true);
select pg_temp.expect('a malformed facility setting', left(pg_temp.refusal(pg_temp.items()), 5), '22023');
-- Consent without pharmacy.work-item.read (a laboratory scientist), and a
-- doctor with both.
select pg_temp.as_member(3, 1);
select pg_temp.expect('LS: row-level security shows Ngozi''s own rows', pg_temp.visible_own(), '01 02 08 09 10');
select pg_temp.expect('LS holds no pharmacy.work-item.read', pg_temp.details(pg_temp.items()), '');
select pg_temp.as_member(1, 1);
select pg_temp.expect('DR with consent and the read permission',
  pg_temp.details(array['e114000b-0000-4000-8000-000000000004'::uuid]), '04:asap/10 mg/tablet/1 month/30.0000 tablet');
-- Another facility's pharmacist.
select pg_temp.as_member(4, 2);
select pg_temp.expect('P2 at F2', pg_temp.details(pg_temp.items()), '05:routine/400 mg/tablet/5 day/10.0000 tablet');
select pg_temp.expect('P2: the details are exactly its own rows', pg_temp.detail_ids(), pg_temp.visible_own());
-- 6. Emergency (D8).
select pg_temp.as_member(5, 1, 'emergency');
select pg_temp.expect('PE under emergency', pg_temp.details(pg_temp.items()),
  '01:urgent/500 mg/capsule/7 day/21.0000 capsule 02:-/-/-/-/- 10:-/-/-/-/-');
select pg_temp.expect('PE: row-level security shows its own rows', pg_temp.visible_own(), '01 02 08 09 10');
select pg_temp.as_member(5, 1);
select pg_temp.expect('PE under direct care', pg_temp.details(pg_temp.items()), '');
reset role;

-- 5. The EHR and Lab runtimes may not call it.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.expect('the EHR runtime', left(pg_temp.refusal(pg_temp.items()), 5), '42501');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3, 1);
select pg_temp.expect('the Lab runtime', left(pg_temp.refusal(pg_temp.items()), 5), '42501');
reset role;

-- 4. The EHR changes c1 after Pharmacy accepted it at version 1 (new
-- instructions, then a direct change of its priority: versions 2 and 3).
-- The work item still answers version 1's values; 0101 refuses its
-- dispensing as before.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.change('e1140007-0000-4000-8000-0000000000c1', 'Shake well before use', null, 1);
select pg_temp.change('e1140007-0000-4000-8000-0000000000c1', null, 'routine', 2);
select pg_temp.expect('c1 is now version 3, routine',
  (select row_version || '/' || priority from ehr.prescriptions where id = 'e1140007-0000-4000-8000-0000000000c1'),
  '3/routine');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH: 03 still answers the accepted version''s values',
  pg_temp.details(array['e114000b-0000-4000-8000-000000000003'::uuid]), '03:stat/120 mg/5 mL/liquid/2 week/100.5000 mL');
select pg_temp.expect('PH: 03 is no longer dispensable (0101)',
  pg_temp.try(pg_temp.dispense_sql('e114000b-0000-4000-8000-000000000003')), '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE');
reset role;
-- 5. A changed source: the details follow the snapshot's identity, not the
-- live row's (a1's snapshot names a1's patient, facility and encounter).
select pg_temp.expect('the snapshot rows named by 07, 08 and 09 exist but do not match',
  (select string_agg(format('%s:%s', right(item.id::text, 2), (select count(*) from ehr.record_versions version_row
       where version_row.resource_type = 'prescriptions'
         and version_row.resource_id = item.source_ehr_prescription_id::text)), ' ' order by item.id)
     from pharmacy.work_items item
    where item.id in ('e114000b-0000-4000-8000-000000000007', 'e114000b-0000-4000-8000-000000000008',
                      'e114000b-0000-4000-8000-000000000009')), '07:1 08:1 09:1');

-- 5. A revoked or an expired grant, a disabled account, a held membership (as
-- the owner, then the runtime again; each undone).
savepoint grant_changes;
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp()
 where id = 'e1140008-0000-4000-8000-000000000022';
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH after Femi''s grant is revoked', pg_temp.details(pg_temp.items()),
  '01:urgent/500 mg/capsule/7 day/21.0000 capsule 02:-/-/-/-/- 10:-/-/-/-/-');
reset role;
rollback to savepoint grant_changes;
savepoint grant_expiry;
update identity.consent_grants set starts_at = clock_timestamp() - interval '2 hours',
  expires_at = clock_timestamp() - interval '1 hour'
 where id = 'e1140008-0000-4000-8000-000000000021';
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH after Ngozi''s grant expired', pg_temp.details(pg_temp.items()),
  '03:stat/120 mg/5 mL/liquid/2 week/100.5000 mL');
reset role;
rollback to savepoint grant_expiry;
savepoint account_change;
update auth.accounts set status = 'disabled' where id = 'e1140002-0000-4000-8000-000000000002';
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH disabled', pg_temp.details(pg_temp.items()), '');
reset role;
rollback to savepoint account_change;
savepoint membership_hold;
update identity.staff_facility_memberships set migration_hold_reason = 'Synthetic hold for the details suite'
 where id = 'e1140004-0000-4000-8000-000000000002';
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH with its membership held', pg_temp.details(pg_temp.items()), '');
reset role;
rollback to savepoint membership_hold;

-- 5, 6. An active deny directive for everyone on Ngozi: PH loses her rows'
-- details; an emergency break-glass session still sees her rows, so still
-- gets them (D8).
savepoint deny_directive;
set local session_replication_role = replica;
insert into identity.consent_directives (id, patient_id, current_version) values
  ('e114000d-0000-4000-8000-000000000001', 'e1140006-0000-4000-8000-000000000001', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, facility_id, purposes, actions, starts_at, source_reference, reason, content_sha256)
values ('e114000d-0000-4000-8000-000000000011', 'e114000d-0000-4000-8000-000000000001',
  'e1140006-0000-4000-8000-000000000001', 1, 'active', 'deny', 'all', null, null, '{}', '{}',
  clock_timestamp() - interval '1 hour', 'details-suite', 'Synthetic deny for the details suite', md5('d') || md5('d'));
set local session_replication_role = origin;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH with a deny directive on Ngozi', pg_temp.details(pg_temp.items()),
  '03:stat/120 mg/5 mL/liquid/2 week/100.5000 mL');
select pg_temp.expect('PH deny: row-level security shows only Femi''s', pg_temp.visible_own(), '03 07');
select pg_temp.as_member(5, 1, 'emergency');
select pg_temp.expect('PE under emergency with a deny directive', pg_temp.details(pg_temp.items()),
  '01:urgent/500 mg/capsule/7 day/21.0000 capsule 02:-/-/-/-/- 10:-/-/-/-/-');
reset role;
rollback to savepoint deny_directive;

-- 8. Nothing was written by the reads (the dispensings above were undone,
-- the EHR's two changes wrote c1's versions 2 and 3).
select pg_temp.expect('no audit row from the reads', (select count(*)::text from audit.events),
  current_setting('details.audit_before'));
select pg_temp.expect('no snapshot row from the reads', (select count(*)::text from ehr.record_versions),
  (current_setting('details.versions_before')::integer + 2)::text);

-- 9. Row types: this session has run 0100's and 0101's guards on
-- ehr.prescriptions as 0114 left it. After one more ADD COLUMN, as a later
-- migration would make it, a new prescription, its acceptance, its
-- dispensing and its details all still pass here (undone).
savepoint later_column;
alter table ehr.prescriptions add column details_suite_probe text;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.expect('a prescription after a further column', pg_temp.run(pg_temp.prescribe_sql(
  'e1140007-0000-4000-8000-0000000000f9', 'e1140009-0000-4000-8000-000000000001', 'e1140006-0000-4000-8000-000000000001',
  1, 1, 'Azithromycin 250 mg', 'urgent', '250 mg', 'tablet', 3, 'day', 3, 'tablet')), 'ok');
reset role;
insert into acceptances
values ('11', pg_temp.acceptance_sql('11', 'e1140007-0000-4000-8000-0000000000f9', 2));
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('its acceptance (0100''s guard)', pg_temp.run((select statement from acceptances where name = '11')), 'ok');
select pg_temp.expect('its dispensing (0101''s guard)',
  pg_temp.try(pg_temp.dispense_sql('e114000b-0000-4000-8000-000000000011')), 'ok');
select pg_temp.expect('its details', pg_temp.details(array['e114000b-0000-4000-8000-000000000011'::uuid]),
  '11:urgent/250 mg/tablet/3 day/3.0000 tablet');
reset role;
rollback to savepoint later_column;

rollback;
