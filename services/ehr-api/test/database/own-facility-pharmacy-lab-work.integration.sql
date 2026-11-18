\set ON_ERROR_STOP on
-- 0133 (ORD-2 of the Akos EHR plan of 18 November 2026; finding F2):
-- activated prescriptions go to the hospital's own pharmacy by themselves,
-- and the facility's pharmacy and lab staff work on their own facility's
-- work items without a personal consent grant, never the chart.
-- Rollback-only. Through the exact runtime roles the services use
-- (hid_ehr_api_runtime, hid_pharmacy_api_runtime, hid_lab_api_runtime), in
-- the session the services set.
-- Cases:
--   1. structure: the new and replaced functions' bodies (md5), owner,
--      SECURITY DEFINER, volatility, search_path; who may execute each; the
--      sends table has no grant; the two ehr.prescriptions policies name only
--      the dispensing validator's owner;
--   2. the send: the prescriber's activated prescription becomes a work item
--      accepted by the prescriber with the fixed reason, one event, one
--      outbox event, a sent row; a second send writes nothing; a failed
--      attempt leaves the prescription active and the send pending with the
--      SQLSTATE, and the next send sends it; not the prescriber, a draft, a
--      changed version, a facility with nobody to work on pharmacy items;
--      a receptionist, an emergency session and a missing session are
--      refused 42501;
--   3. the pharmacist without a grant sees the item, its card and its
--      event, may work on it (own_work_access_for), its basis is
--      'own-work', and dispenses it; it reads nothing of the chart
--      (ehr.context_allows is false, ehr.prescriptions is not readable);
--   4. not for: a nurse, an admin or a receptionist of the facility (they
--      hold the read permission but not the receive one), a lab scientist
--      (pharmacy items), a pharmacist of another facility, an emergency
--      session, a patient with a deny directive, an inactive patient;
--      a pharmacist with a grant keeps the basis 'consent';
--   5. stopping after the send: the withdrawal is marked once, the item
--      reads withdrawn, and dispensing it is refused
--      (PRESCRIPTION_SOURCE_NOT_DISPENSABLE);
--   6. lab: the facility's lab scientist without a grant sees the own lab
--      work item and its card, may work on it, its basis is 'own-work', and
--      accessions it; another facility's lab scientist and the nurse do not.
-- Fixtures inserted as the suite runner with session_replication_role =
-- replica where the services would not write them (identity rows, the lab
-- work item). Synthetic values only; uuid prefix e133.
set plpgsql.variable_conflict = error;
begin;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception 'own facility work: %: got [%], want [%]', label, got, want;
  end if;
end
$f$;
grant execute on function pg_temp.expect(text, text, text) to public;

-- 1. Structure.
do $$
declare
  mismatch text;
  owner_oid oid := (select relowner from pg_class where oid = 'pharmacy.work_items'::regclass);
begin
  select string_agg(format('%s md5=%s owner=%s definer=%s volatile=%s config=%s', expected.proc_name,
           coalesce(md5(proc.prosrc), 'none (missing)'), pg_get_userbyid(proc.proowner), proc.prosecdef,
           proc.provolatile, proc.proconfig), '; ')
    into mismatch
    from (values
      ('identity.facility_work_member_allows(text,uuid,uuid,text)', '474875a22f8c5e7b46846f1ddb1d5046', 's'),
      ('lab.work_item_allows(uuid,uuid,uuid,text)', '21012693fb2d89bb3714450655610702', 's'),
      ('pharmacy.work_item_allows(uuid,uuid,uuid,text)', 'f618d09522d3cba380da9e3d1508140b', 's'),
      ('lab.context_allows(uuid,uuid,text)', 'bb7622fd781f95899b467ec606c32d2f', 's'),
      ('pharmacy.context_allows(uuid,uuid,text)', '76e3f4819113fb2cac080e2d0851324b', 's'),
      ('lab.work_item_patient_cards(uuid[])', '91e157a7d6f89edd46c14dbb095d1bc6', 's'),
      ('pharmacy.work_item_patient_cards(uuid[])', '0dc38390c3c40a1883b87345ce0d35bd', 's'),
      ('pharmacy.own_work_source_prescription(uuid,uuid,uuid)', '41a9afd4ea6f708425b98d1fb6e6eb87', 's'),
      ('ehr.send_prescription_to_own_pharmacy(uuid,bigint)', 'f85c9c7a40c96f09510573b30912caff', 'v'),
      ('ehr.withdraw_own_pharmacy_send(uuid)', '0d6717beb1e28897e40e378a242042db', 'v'),
      ('pharmacy.own_work_access_for(text,uuid,text)', 'bb03e692d187fe85783fed28cc40413c', 's'),
      ('lab.own_work_access_for(text,uuid,text)', '89336895a7a4878211fc44c45197e454', 's'),
      ('pharmacy.own_work_item_states(uuid[])', '5882cbdcf5dcebb96b3cabb95bba9801', 's'),
      ('lab.own_work_item_bases(uuid[])', '07e31d7ca86ac31255ad096d56363637', 's')) expected(proc_name, digest, volatility)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc_name)
   where proc.oid is null or md5(proc.prosrc) <> expected.digest or proc.proowner <> owner_oid
      or not proc.prosecdef or proc.provolatile <> expected.volatility or proc.proisstrict;
  if mismatch is not null then
    raise exception 'own facility work: the functions are not 0133''s: %', mismatch;
  end if;
  -- Who may execute each, through any membership.
  select string_agg(format('%s %s=%s', expected.proc_name, role_row.rolname,
           has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')), '; ') into mismatch
    from (values
      ('identity.facility_work_member_allows(text,uuid,uuid,text)', array[]::text[]),
      ('pharmacy.own_work_source_prescription(uuid,uuid,uuid)', array[]::text[]),
      ('ehr.send_prescription_to_own_pharmacy(uuid,bigint)', array['hid_ehr_runtime', 'hid_ehr_api_runtime',
        'hid_schema_test_runtime']),
      ('ehr.withdraw_own_pharmacy_send(uuid)', array['hid_ehr_runtime', 'hid_ehr_api_runtime',
        'hid_schema_test_runtime']),
      ('pharmacy.own_work_access_for(text,uuid,text)', array['hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
        'hid_schema_test_runtime']),
      ('pharmacy.own_work_item_states(uuid[])', array['hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
        'hid_schema_test_runtime']),
      ('lab.own_work_access_for(text,uuid,text)', array['hid_lab_runtime', 'hid_lab_api_runtime',
        'hid_schema_test_runtime']),
      ('lab.own_work_item_bases(uuid[])', array['hid_lab_runtime', 'hid_lab_api_runtime',
        'hid_schema_test_runtime'])) expected(proc_name, allowed)
    cross join pg_roles role_row
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')
         <> (role_row.rolname = any(expected.allowed));
  if mismatch is not null then
    raise exception 'own facility work: EXECUTE differs: %', mismatch;
  end if;
  if exists (select 1 from pg_class relation, aclexplode(relation.relacl) acl
              where relation.oid = 'pharmacy.own_prescription_sends'::regclass and acl.grantee <> relation.relowner) then
    raise exception 'own facility work: the sends table has grants';
  end if;
  if (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.prescriptions'::regclass
         and policy_row.polname in ('prescriptions_own_pharmacy_source_read', 'prescriptions_own_pharmacy_source_lock')
         and policy_row.polroles = array[(select proowner from pg_proc
                                           where oid = 'pharmacy.validate_dispensing()'::regprocedure)]) <> 2 then
    raise exception 'own facility work: the ehr.prescriptions policies do not name only the validator''s owner';
  end if;
  if exists (select 1 from pg_roles role_row
              where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
                and pg_has_role(role_row.oid, (select proowner from pg_proc
                                                where oid = 'pharmacy.validate_dispensing()'::regprocedure), 'USAGE')) then
    raise exception 'own facility work: a runtime role is a member of the validator''s owner';
  end if;
end $$;

-- Fixtures. Organization O (e1330000...01); facilities F1 "Own Work
-- Hospital" (e1330001...01), F2 "Own Work Annex" (...02), F3 "Own Work
-- Clinic" (...03, no pharmacy staff). Members (account e1330002...n, staff
-- e1330003...n, membership e1330004...n, role e1330005...n):
--   1 DR doctor F1   2 PH pharmacist F1   3 LS lab F1   4 NU nurse F1
--   5 AD admin F1    6 P2 pharmacist F2   7 RC receptionist F1
--   8 D2 doctor F1   9 D3 doctor F3       10 PG pharmacist F1 (with grants)
--   11 L2 lab F2
-- Patients (e1330006...n): 1 Ada (active), 2 Bisi (a deny directive later),
-- 3 Chike (made inactive later). DR, D2 and PG hold write grants for all
-- three at F1, D3 for Ada at F3.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'own-work-test'),
  ('emergency', 'Emergency treatment', 'own-work-test')
on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1330000-0000-4000-8000-000000000001', 'Own Work Test Organization', 'own-work-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
select ('e1330001-0000-4000-8000-00000000000' || n)::uuid, 'e1330000-0000-4000-8000-000000000001', name,
       'OWN-WORK-' || n, 'Africa/Lagos', true, 'verified'
  from (values (1, 'Own Work Hospital'), (2, 'Own Work Annex'), (3, 'Own Work Clinic')) site(n, name);
create temporary table own_members (n integer primary key, code text, role_code text, site integer) on commit drop;
insert into own_members values (1, 'dr', 'doctor', 1), (2, 'ph', 'pharmacist', 1), (3, 'ls', 'lab', 1),
  (4, 'nu', 'nurse', 1), (5, 'ad', 'admin', 1), (6, 'p2', 'pharmacist', 2), (7, 'rc', 'receptionist', 1),
  (8, 'd2', 'doctor', 1), (9, 'd3', 'doctor', 3), (10, 'pg', 'pharmacist', 1), (11, 'l2', 'lab', 2);
grant select on own_members to public;
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:own-work-' || code,
       'own-work-' || code || '@example.invalid', 'Own Work ' || upper(code), 'active'
  from own_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1330003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'Own Work ' || upper(code),
       'own-work-' || code || '@example.invalid', 'verified', role_code
  from own_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1330004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'e1330000-0000-4000-8000-000000000001',
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, role_code, role_code, true, true
  from own_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e1330005-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
       ('e1330004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, 'Own work suite role'
  from own_members;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e1330006-0000-4000-8000-000000000001', 'HID-WRKAAA2', 'Ada', 'Own', 'Ada Own', 'female', '1990-04-05', 'active'),
  ('e1330006-0000-4000-8000-000000000002', 'HID-WRKBBB3', 'Bisi', 'Own', 'Bisi Own', 'female', '1985-01-02', 'active'),
  ('e1330006-0000-4000-8000-000000000003', 'HID-WRKCCC4', 'Chike', 'Own', 'Chike Own', 'male', '1979-09-30', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select gen_random_uuid(), ('e1330006-0000-4000-8000-00000000000' || patient)::uuid,
       ('e1330003-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, 'write_records', 'direct-care', 'active',
       'Synthetic own work consent', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days'
  from (values (1, 1, 1), (1, 2, 1), (1, 3, 1), (8, 1, 1), (10, 1, 1), (10, 2, 1), (10, 3, 1), (9, 1, 3))
       consent(member, patient, site);
set local session_replication_role = origin;

-- The session the services set (DatabaseService.withTransaction).
create function pg_temp.as_member(member integer, site integer default null, purpose text default 'direct-care',
  correlation text default null) returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:own-work-' || (select code from own_members where n = member), true),
         set_config('app.facility_id', 'e1330001-0000-4000-8000-00000000000'
           || coalesce(site, (select own_members.site from own_members where n = member)), true),
         set_config('app.correlation_id', coalesce(correlation, 'own-work-' || substr(md5(random()::text), 1, 12)), true),
         set_config('app.membership_id', 'e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'), true),
         set_config('app.purpose_of_use', purpose, true);
$f$;
create function pg_temp.rx(n integer) returns uuid language sql immutable as $f$
  select ('e1330007-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
-- A statement's outcome: 'ok', or 'SQLSTATE message'.
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The send's answer as text.
create function pg_temp.send(prescription uuid, version bigint) returns text language plpgsql as $f$
declare answer text;
begin
  select string_agg(sent.outcome || case when sent.work_item_id is null then '' else ':item' end, ',') into answer
    from ehr.send_prescription_to_own_pharmacy(prescription, version) sent;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.work_item_of(prescription uuid) returns uuid language sql security definer as $f$
  select id from pharmacy.work_items where source_ehr_prescription_id = prescription
$f$;
-- pharmacy-api's dispensing INSERT (PharmacyService.dispense) by the session's member.
create function pg_temp.dispense_sql(work_item uuid, member integer) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,%L,%L,%L,%L,21,'capsule',%L,%L,'Dispensed to the patient',%L,%L,%L)$i$,
    gen_random_uuid(), w.id, w.patient_id, w.facility_id, w.medication_code_system, w.medication_code,
    w.medication_display, 'e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'),
    'e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'),
    'own-work-dispense-' || replace(gen_random_uuid()::text, '-', ''), repeat('d', 64),
    current_setting('app.correlation_id'))
  from pharmacy.work_items w where w.id = work_item
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', proc.signature);
  end loop;
end $$;

-- The EHR rows, through the EHR runtime with the EHR API's statements, as
-- DR at F1: encounter E1 for Ada, E2 for Bisi, E3 for Chike; prescriptions
-- (draft, then activated as prescriptions.service.ts update does): 1, 2, 3,
-- 4, 6 for Ada, 7 for Bisi, 8 for Chike; 5 stays a draft. As D3 at F3: 9
-- for Ada.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e1330008-0000-4000-8000-00000000000' || n)::uuid, ('e1330006-0000-4000-8000-00000000000' || n)::uuid,
       'e1330001-0000-4000-8000-000000000001', 'e1330002-0000-4000-8000-000000000001',
       'e1330004-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp()
  from generate_series(1, 3) n;
create function pg_temp.prescribe(n integer, patient integer, member integer, site integer) returns void
language sql as $f$
  insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, ends_on, status)
  values (pg_temp.rx(n), ('e1330008-0000-4000-8000-00000000000' || case when site = 3 then 9 else patient end)::uuid,
    ('e1330006-0000-4000-8000-00000000000' || patient)::uuid, ('e1330001-0000-4000-8000-00000000000' || site)::uuid,
    ('e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
    ('e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid, 'http://www.whocc.no/atc', 'J01CA04',
    'Amoxicillin 500 mg capsule (' || n || ')', 1, 'capsule', 'oral', 'Every 8 hours', 'Take after food for 7 days',
    date '2026-11-18', date '2026-11-25', 'draft');
$f$;
create function pg_temp.set_status(n integer, new_status text, reason text) returns void language plpgsql as $f$
begin
  perform set_config('app.change_reason', reason, true);
  update ehr.prescriptions set status = new_status where id = pg_temp.rx(n);
  if not found then raise exception 'own work suite: prescription % not updated', n; end if;
end $f$;
grant execute on function pg_temp.prescribe(integer, integer, integer, integer),
  pg_temp.set_status(integer, text, text) to public;
select pg_temp.prescribe(n, patient, 1, 1)
  from (values (1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (7, 2), (8, 3)) rx(n, patient);
select pg_temp.set_status(n, 'active', 'First activation (no reason needed)') from unnest(array[1, 2, 3, 4, 6, 7, 8]) n;
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(9);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e1330008-0000-4000-8000-000000000009', 'e1330006-0000-4000-8000-000000000001',
  'e1330001-0000-4000-8000-000000000003', 'e1330002-0000-4000-8000-000000000009',
  'e1330004-0000-4000-8000-000000000009', 'ambulatory', 'in_progress', clock_timestamp());
select pg_temp.prescribe(9, 1, 9, 3);
select pg_temp.set_status(9, 'active', 'First activation (no reason needed)');
reset role;

-- 2. The send, as DR through the EHR runtime.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('rx1 is sent', pg_temp.send(pg_temp.rx(1), 2), 'sent:item');
reset role;
select pg_temp.expect('rx1''s work item: accepted by the prescriber, the fixed reason, version 2, no route',
  (select format('%s/%s/%s/%s/%s', w.accepted_by = 'e1330002-0000-4000-8000-000000000001',
     w.accepted_by_membership_id = 'e1330004-0000-4000-8000-000000000001', w.acceptance_reason,
     w.source_ehr_prescription_version, w.order_route_id is null)
     from pharmacy.work_items w where w.source_ehr_prescription_id = pg_temp.rx(1)),
  't/t/Sent automatically when the prescription was activated/2/t');
select pg_temp.expect('rx1: one event, one outbox event (auto_send), a sent row',
  (select format('%s/%s/%s', (select count(*) from pharmacy.work_item_events e where e.work_item_id = w.id),
     (select string_agg(o.event_type || ':' || (o.payload ->> 'acceptedVia'), ',') from pharmacy.outbox_events o
       where o.aggregate_id = w.id),
     (select s.state || ':' || s.attempts || ':' || (s.work_item_id = w.id) || ':' || coalesce(s.last_failure_sqlstate, '-')
        from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(1)))
     from pharmacy.work_items w where w.source_ehr_prescription_id = pg_temp.rx(1)),
  '1/PharmacyWorkItemCreated:auto_send/sent:1:true:-');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('a second send writes nothing', pg_temp.send(pg_temp.rx(1), 2), 'already_in_pharmacy:item');
select pg_temp.expect('a draft is not sent', pg_temp.send(pg_temp.rx(5), 1), 'not_active');
select pg_temp.expect('another version is not sent', pg_temp.send(pg_temp.rx(2), 1), 'changed');
select pg_temp.expect('an unknown prescription', pg_temp.send(gen_random_uuid(), 1), 'not_found');
select pg_temp.expect('a bad version', pg_temp.send(pg_temp.rx(2), 0), '22023 OWN_PHARMACY_SEND_INVALID');
-- A failed attempt (a correlation id the work item's CHECK refuses): the
-- prescription stays active, the send pending with the SQLSTATE, nothing else written.
select pg_temp.as_member(1, correlation => 'short');
select pg_temp.expect('a failed attempt is pending', pg_temp.send(pg_temp.rx(2), 2), 'pending');
reset role;
select pg_temp.expect('the pending send: no work item, the SQLSTATE, the prescription still active',
  (select format('%s/%s/%s/%s/%s', s.state, s.attempts, s.last_failure_sqlstate,
     (select count(*) from pharmacy.work_items w where w.source_ehr_prescription_id = pg_temp.rx(2)),
     (select p.status from ehr.prescriptions p where p.id = pg_temp.rx(2)))
     from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(2)),
  'pending/1/23514/0/active');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('the next send sends it', pg_temp.send(pg_temp.rx(2), 2), 'sent:item');
select pg_temp.expect('rx3, rx4, rx6, rx7, rx8 are sent', (select string_agg(pg_temp.send(pg_temp.rx(n), 2), ' ')
  from unnest(array[3, 4, 6, 7, 8]) n), 'sent:item sent:item sent:item sent:item sent:item');
-- Not the prescriber: D2 (a doctor with a grant for Ada).
select pg_temp.as_member(8);
select pg_temp.set_status(5, 'active', 'First activation (no reason needed)');
select pg_temp.expect('D2 does not send DR''s prescription', pg_temp.send(pg_temp.rx(5), 2), 'not_prescriber');
-- Refused sessions.
select pg_temp.as_member(7);
select pg_temp.expect('a receptionist is refused', pg_temp.send(pg_temp.rx(5), 2), '42501 OWN_PHARMACY_SEND_DENIED');
select pg_temp.as_member(1, purpose => 'emergency');
select pg_temp.expect('an emergency session is refused', pg_temp.send(pg_temp.rx(5), 2), '42501 OWN_PHARMACY_SEND_DENIED');
select set_config('app.membership_id', '', true);
select pg_temp.expect('a session without a membership is refused', pg_temp.send(pg_temp.rx(5), 2),
  '42501 OWN_PHARMACY_SEND_DENIED');
-- Nobody works on pharmacy items at F3.
select pg_temp.as_member(9);
select pg_temp.expect('F3 has no pharmacy staff', pg_temp.send(pg_temp.rx(9), 2), 'no_pharmacy');
reset role;
select pg_temp.expect('no send row for the refused and unsent', (select count(*)::text from pharmacy.own_prescription_sends
  where prescription_id in (pg_temp.rx(5), pg_temp.rx(9))), '0');

-- 3. PH, the pharmacist at F1 without any grant, through pharmacy-api's runtime.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH sees the seven items sent (rx1-rx4, rx6, rx7, rx8)',
  (select count(*)::text from pharmacy.work_items), '7');
select pg_temp.expect('PH sees rx1''s card with the name',
  (select string_agg(card.patient_full_name || '/' || card.patient_health_id_last4, ',')
     from pharmacy.work_item_patient_cards(array[pg_temp.work_item_of(pg_temp.rx(1))]) card), 'Ada Own/AAA2');
select pg_temp.expect('PH may work on rx1''s item',
  (select count(*)::text from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(1)),
     'write_records')), '1');
select pg_temp.expect('rx1''s basis for PH is own-work, not withdrawn',
  (select string_agg(state.basis || '/' || state.withdrawn, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(1))]) state), 'own-work/false');
select pg_temp.expect('PH reads rx1''s event', (select count(*)::text from pharmacy.work_item_events e
  where e.work_item_id = pg_temp.work_item_of(pg_temp.rx(1))), '1');
select pg_temp.expect('PH dispenses rx1', pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2)), 'ok');
select pg_temp.expect('PH reads the dispensing', (select count(*)::text from pharmacy.dispensings d
  where d.work_item_id = pg_temp.work_item_of(pg_temp.rx(1))), '1');
select pg_temp.expect('the Pharmacy runtime cannot read the chart',
  pg_temp.try('select count(*) from ehr.prescriptions'), '42501 permission denied for schema ehr');
select pg_temp.expect('PH: a Lab resource type is refused', pg_temp.try($s$select * from pharmacy.own_work_access_for(
  'accession', gen_random_uuid(), 'read_records')$s$), '22023 OWN_WORK_ACCESS_INVALID');
reset role;
-- PH's session through the EHR runtime: the chart's consent test (every EHR
-- table's policy) is still false for Ada, and no prescription, encounter or
-- version snapshot is readable.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH reads nothing of the chart through the EHR runtime',
  format('%s/%s/%s/%s', ehr.context_allows('e1330006-0000-4000-8000-000000000001',
      'e1330001-0000-4000-8000-000000000001', 'read_records'),
    (select count(*) from ehr.prescriptions), (select count(*) from ehr.encounters),
    (select count(*) from ehr.record_versions)), 'f/0/0/0');
reset role;

-- 4. Not for others.
create function pg_temp.pharmacy_view(member integer, site integer default null, purpose text default 'direct-care')
returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_member(member, site, purpose);
  select format('items=%s cards=%s access=%s', (select count(*) from pharmacy.work_items),
           (select count(*) from pharmacy.work_item_patient_cards(array[pg_temp.work_item_of(pg_temp.rx(3))])),
           (select count(*) from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(3)),
              'read_records')))
    into answer;
  return answer;
end $f$;
grant execute on function pg_temp.pharmacy_view(integer, integer, text) to public;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('NU (nurse) sees nothing', pg_temp.pharmacy_view(4), 'items=0 cards=0 access=0');
select pg_temp.expect('AD (admin) sees nothing', pg_temp.pharmacy_view(5), 'items=0 cards=0 access=0');
select pg_temp.expect('RC (receptionist) sees nothing', pg_temp.pharmacy_view(7), 'items=0 cards=0 access=0');
select pg_temp.expect('LS (lab) sees no pharmacy item', pg_temp.pharmacy_view(3), 'items=0 cards=0 access=0');
select pg_temp.expect('P2 (pharmacist at F2) sees nothing of F1', pg_temp.pharmacy_view(6), 'items=0 cards=0 access=0');
select pg_temp.expect('P2''s membership in a session at F1 sees nothing', pg_temp.pharmacy_view(6, 1),
  'items=0 cards=0 access=0');
select pg_temp.expect('PH in an emergency session sees nothing', pg_temp.pharmacy_view(2, purpose => 'emergency'),
  'items=0 cards=0 access=0');
select pg_temp.as_member(10);
select pg_temp.expect('PG (pharmacist with grants) keeps the basis consent',
  (select string_agg(state.basis, ',') from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(1))]) state),
  'consent');
reset role;
-- Bisi's deny directive (facility F1, everyone) and Chike made inactive.
set local session_replication_role = replica;
insert into identity.consent_directives (id, patient_id) values
  ('e1330009-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000002');
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, facility_id, starts_at, source_reference, reason, content_sha256)
values (gen_random_uuid(), 'e1330009-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000002', 1, 'active',
  'deny', 'all', 'e1330001-0000-4000-8000-000000000001', clock_timestamp() - interval '1 minute', 'own-work-suite',
  'Synthetic deny directive', repeat('a', 64));
update identity.patients set status = 'inactive' where id = 'e1330006-0000-4000-8000-000000000003';
set local session_replication_role = origin;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: Bisi (deny directive) and Chike (inactive) are hidden now',
  (select string_agg(right(w.source_ehr_prescription_id::text, 2), ' ' order by w.source_ehr_prescription_id)
     from pharmacy.work_items w), '01 02 03 04 06');
select pg_temp.expect('PH may not work on Bisi''s item', (select count(*)::text from pharmacy.own_work_access_for(
  'work_item', pg_temp.work_item_of(pg_temp.rx(7)), 'write_records')), '0');
reset role;

-- 5. Stopping after the send: DR holds rx3; the send is withdrawn once, and
-- dispensing is refused.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('an active prescription is not withdrawn', ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text,
  'false');
select pg_temp.set_status(3, 'on_hold', 'Held by the prescriber');
select pg_temp.expect('the held prescription''s send is withdrawn',
  ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text, 'true');
select pg_temp.expect('only once', ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text, 'false');
select pg_temp.as_member(7);
select pg_temp.expect('a receptionist cannot withdraw', pg_temp.try(format(
  'select ehr.withdraw_own_pharmacy_send(%L)', pg_temp.rx(3))), '42501 OWN_PHARMACY_SEND_DENIED');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: rx3 reads withdrawn',
  (select string_agg(state.basis || '/' || state.withdrawn, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(3))]) state), 'own-work/true');
select pg_temp.expect('PH: dispensing rx3 is refused',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(3)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE');
select pg_temp.expect('PH: rx4 (still active) dispenses', pg_temp.try(pg_temp.dispense_sql(
  pg_temp.work_item_of(pg_temp.rx(4)), 2)), 'ok');
reset role;

-- 6. Lab: an own lab work item for Ada at F1 and one at F2 (as replica, as
-- lab-api accepts them from the EHR).
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
  requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
select ('e133000a-0000-4000-8000-00000000000' || site)::uuid, 'e1330006-0000-4000-8000-000000000001',
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, ('e1330001-0000-4000-8000-00000000000' || site)::uuid,
       gen_random_uuid(), 1, gen_random_uuid(), 'accepted', 'routine', 'http://loinc.org', '718-7', 'Haemoglobin',
       'e1330002-0000-4000-8000-000000000001', clock_timestamp(), 'e1330002-0000-4000-8000-000000000001',
       'e1330004-0000-4000-8000-000000000001', 'own-work-lab-item-' || site || '-key', repeat('b', 64),
       'own-work-suite-lab-' || site
  from generate_series(1, 2) site;
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('LS sees F1''s own lab item and its card',
  (select format('%s/%s/%s/%s', (select count(*) from lab.work_items),
     (select string_agg(card.patient_full_name, ',') from lab.work_item_patient_cards(
        array['e133000a-0000-4000-8000-000000000001'::uuid, 'e133000a-0000-4000-8000-000000000002'::uuid]) card),
     (select count(*) from lab.own_work_access_for('work_item', 'e133000a-0000-4000-8000-000000000001', 'write_records')),
     (select string_agg(basis, ',') from lab.own_work_item_bases(array['e133000a-0000-4000-8000-000000000001'::uuid])))),
  '1/Ada Own/1/own-work');
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
values ('e133000b-0000-4000-8000-000000000001', 'e133000a-0000-4000-8000-000000000001',
  'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'routine',
  'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003', 'own-work-accession-0001',
  repeat('c', 64), current_setting('app.correlation_id'));
select pg_temp.expect('LS may work on its accession', (select count(*)::text from lab.own_work_access_for('accession',
  'e133000b-0000-4000-8000-000000000001', 'write_records')), '1');
select pg_temp.as_member(11);
select pg_temp.expect('L2 (lab at F2) sees only F2''s item', (select string_agg(right(id::text, 1), ',') from lab.work_items),
  '2');
select pg_temp.as_member(4);
select pg_temp.expect('NU (nurse) sees no lab item', (select count(*)::text from lab.work_items), '0');
select pg_temp.as_member(3, purpose => 'emergency');
select pg_temp.expect('LS in an emergency session sees no lab item', (select count(*)::text from lab.work_items), '0');
reset role;

rollback;
