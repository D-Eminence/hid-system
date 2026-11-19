\set ON_ERROR_STOP on
-- 0134 (Q102 of 18 November 2026): sealed QA only, a fictional pharmacist
-- and a fictional lab scientist at QA Hospital. Rollback-only.
-- Cases:
--   1. structure: the function is 0134's body (md5), the owner's alone (no
--      EXECUTE for any runtime), SECURITY DEFINER, search_path pg_catalog,
--      pg_temp;
--   2. without the QA tenant (every database but Amazon RDS, where 0123
--      seeds it) the migration wrote nothing and the function writes
--      nothing (0): neither fixed id exists, no audit row;
--   3. after 0123's install (as the owner, as its suite does): it writes the
--      two memberships and roles at QA Hospital (4 rows, one audit row with
--      counts only), the existing QA Laboratory and QA Pharmacy memberships
--      unchanged; a second call writes nothing; the seal still holds (a QA
--      login cannot be given a real facility);
--   4. with 0133: the QA Clinician's activated prescription for QA Patient One
--      is sent to QA Hospital's pharmacy by itself, and the QA Pharmacist,
--      at QA Hospital and without any grant, sees it with the patient's name
--      and dispenses it; at QA Pharmacy it does not see it; the QA Lab
--      Scientist at QA Hospital sees an own lab work item of QA Hospital;
--   5. a fixed id held by another row is refused (SEALED_QA_ID_TAKEN); a QA
--      login that was deleted gets nothing and the other one is written;
--   6. the QA Facility Admin already gave the QA Pharmacist the pharmacist
--      role at QA Hospital (another id, as identity.attach_invited_member
--      writes it), active or since deactivated: that membership is left as
--      it is and the QA Lab Scientist's is written (0002's
--      staff_memberships_scoped_uq would refuse a second one: the install
--      once failed there with 23505).
-- No real person, address or password: the logins are 0123's fictional ones.
set plpgsql.variable_conflict = error;
begin;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception 'sealed QA hospital staff: %: got [%], want [%]', label, got, want;
  end if;
end
$f$;
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
grant execute on function pg_temp.expect(text, text, text), pg_temp.try(text) to public;

-- 1. Structure.
select pg_temp.expect('the function''s body, attributes and ACL',
  (select format('%s/%s/%s/%s/%s', md5(proc.prosrc), proc.prosecdef, proc.provolatile, proc.proconfig,
     (select count(*) from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where acl.grantee <> proc.proowner))
     from pg_proc proc where proc.oid = 'identity.sealed_qa_hospital_work_staff_install()'::regprocedure),
  'ddce099c7c25ad606a2c3b290bd63b40/t/v/{"search_path=pg_catalog, pg_temp"}/0');
select pg_temp.expect('no runtime role may execute it',
  (select count(*)::text from pg_roles role_row
    where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
      and has_function_privilege(role_row.oid, 'identity.sealed_qa_hospital_work_staff_install()', 'EXECUTE')), '0');

-- 2. Without the QA tenant.
select pg_temp.expect('the migration wrote nothing here (no QA tenant)',
  (select format('%s/%s/%s', (select count(*) from identity.staff_facility_memberships
       where id in ('c0a00005-0000-4000-8000-000000000032', 'c0a00005-0000-4000-8000-000000000052')),
     (select count(*) from auth.account_roles
       where id in ('c0a00005-0000-4000-8000-000000000032', 'c0a00005-0000-4000-8000-000000000052')),
     (select count(*) from audit.events where action = 'identity.sealed-qa.hospital-work-staff'))), '0/0/0');
select pg_temp.expect('nothing without the QA tenant', identity.sealed_qa_hospital_work_staff_install()::text, '0');
select pg_temp.expect('and still nothing written',
  (select count(*)::text from identity.staff_facility_memberships
    where id in ('c0a00005-0000-4000-8000-000000000032', 'c0a00005-0000-4000-8000-000000000052')), '0');

-- 3. With it.
update platform.control_settings set enabled = true where control_key = 'outreach_organiser_signup_enabled';
select identity.sealed_qa_install();
select set_config('qa.audit_before', (select count(*)::text from audit.events
  where action = 'identity.sealed-qa.hospital-work-staff'), true);
select pg_temp.expect('the install writes 4 rows', identity.sealed_qa_hospital_work_staff_install()::text, '4');
select pg_temp.expect('the two memberships at QA Hospital',
  (select string_agg(format('%s:%s:%s:%s:%s', account.email, (membership.facility_id = 'c0a00002-0000-4000-8000-000000000001')::text,
     assignment.role_code, membership.is_primary::text, membership.active::text), ' ' order by account.email)
     from identity.staff_facility_memberships membership
     join auth.accounts account on account.id = membership.account_id
     join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
    where membership.id in ('c0a00005-0000-4000-8000-000000000032', 'c0a00005-0000-4000-8000-000000000052')),
  'lab@healthidentitydirectory.com:true:lab:false:true pharmacy@healthidentitydirectory.com:true:pharmacist:false:true');
select pg_temp.expect('their QA Laboratory and QA Pharmacy memberships unchanged',
  (select string_agg(format('%s:%s:%s', membership.id, membership.facility_id, membership.is_primary::text), ' '
     order by membership.id) from identity.staff_facility_memberships membership
    where membership.id in ('c0a00005-0000-4000-8000-000000000031', 'c0a00005-0000-4000-8000-000000000051')),
  'c0a00005-0000-4000-8000-000000000031:c0a00002-0000-4000-8000-000000000002:true '
  || 'c0a00005-0000-4000-8000-000000000051:c0a00002-0000-4000-8000-000000000003:true');
select pg_temp.expect('one audit row, counts only',
  (select string_agg(details::text, ',') from audit.events where action = 'identity.sealed-qa.hospital-work-staff'
     and patient_id is null and actor_subject is null),
  '{"memberships": 2, "rowsInserted": 4}');
select pg_temp.expect('a second call writes nothing', identity.sealed_qa_hospital_work_staff_install()::text, '0');
select pg_temp.expect('still one audit row', (select (count(*) - current_setting('qa.audit_before')::bigint)::text
  from audit.events where action = 'identity.sealed-qa.hospital-work-staff'), '1');
-- The seal: the QA Pharmacist cannot be given a membership outside QA.
set local session_replication_role = origin;
insert into identity.organizations (id, name, slug) values
  ('e1340000-0000-4000-8000-000000000001', 'Real Test Organization', 'real-test-organization-0134');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1340001-0000-4000-8000-000000000001', 'e1340000-0000-4000-8000-000000000001', 'Real Test Clinic',
   'REAL-TEST-0134', 'Africa/Lagos', true, 'verified');
select pg_temp.expect('the seal refuses a QA login at a real facility', pg_temp.try($s$
  insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active)
  values (gen_random_uuid(), 'c0a00004-0000-4000-8000-000000000005', 'c0a00003-0000-4000-8000-000000000005',
    'e1340000-0000-4000-8000-000000000001', 'e1340001-0000-4000-8000-000000000001', 'pharmacist', 'pharmacist', false,
    true)$s$), '42501 SEALED_QA_MEMBERSHIP_REFUSED');

-- 4. With 0133, at QA Hospital: the QA Clinician (doctor, membership ...011,
-- with 0123's share for QA Patient One) prescribes and activates; the send
-- goes to QA Hospital's pharmacy; the QA Pharmacist works on it there.
create function pg_temp.as_qa(account_n integer, membership text, facility_n integer) returns void language sql as $f$
  select set_config('app.actor_subject', 'sealed-qa:c0a00003-0000-4000-8000-00000000000' || account_n, true),
         set_config('app.facility_id', 'c0a00002-0000-4000-8000-00000000000' || facility_n, true),
         set_config('app.correlation_id', 'sealed-qa-0134-' || substr(md5(random()::text), 1, 12), true),
         set_config('app.membership_id', 'c0a00005-0000-4000-8000-0000000000' || membership, true),
         set_config('app.purpose_of_use', 'direct-care', true),
         -- 0133 D13: the switch the new pharmacy-api and lab-api images set (own work only).
         set_config('app.own_facility_work', '0133', true);
$f$;
grant execute on function pg_temp.as_qa(integer, text, integer) to public;
-- The owner has set the three logins' passwords (Forgot password): active.
-- 0123's direct-care code is seeded by its suites' fixtures, not by 0123.
update auth.accounts set status = 'active'
 where id in ('c0a00003-0000-4000-8000-000000000001', 'c0a00003-0000-4000-8000-000000000003',
              'c0a00003-0000-4000-8000-000000000005');
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'sealed-qa-0134-test')
on conflict (code) do update set active = true;
-- 0123's share was written in this transaction (starts_at its clock time);
-- the consent test reads the transaction's time, so it starts an hour back.
set local session_replication_role = replica;
update identity.consent_grants set starts_at = starts_at - interval '1 hour'
 where patient_id = 'c0a00009-0000-4000-8000-000000000001'
   and membership_id = 'c0a00005-0000-4000-8000-000000000011';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.as_qa(1, '11', 1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e1340002-0000-4000-8000-000000000001', 'c0a00009-0000-4000-8000-000000000001',
  'c0a00002-0000-4000-8000-000000000001', 'c0a00003-0000-4000-8000-000000000001',
  'c0a00005-0000-4000-8000-000000000011', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status)
values ('e1340003-0000-4000-8000-000000000001', 'e1340002-0000-4000-8000-000000000001',
  'c0a00009-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001',
  'c0a00003-0000-4000-8000-000000000001', 'c0a00005-0000-4000-8000-000000000011', 'Paracetamol 500 mg tablet',
  'Every 6 hours', 'Take with water', 'draft');
select set_config('app.change_reason', 'First activation (no reason needed)', true);
update ehr.prescriptions set status = 'active' where id = 'e1340003-0000-4000-8000-000000000001';
select pg_temp.expect('the QA Clinician''s prescription is sent to QA Hospital''s pharmacy',
  (select string_agg(sent.outcome, ',') from ehr.send_prescription_to_own_pharmacy(
     'e1340003-0000-4000-8000-000000000001', 2) sent), 'sent');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_qa(5, '52', 1);
select pg_temp.expect('the QA Pharmacist at QA Hospital sees it with the name',
  (select string_agg(card.patient_full_name, ',') from pharmacy.work_items item
     cross join lateral pharmacy.work_item_patient_cards(array[item.id]) card), 'QA Patient One');
select pg_temp.expect('and dispenses it', pg_temp.try($s$insert into pharmacy.dispensings (
    id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
    medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
    reason,idempotency_key,request_sha256,correlation_id)
  select gen_random_uuid(), item.id, 1, item.patient_id, item.facility_id, null, null, item.medication_display, 20,
    'tablet', 'c0a00003-0000-4000-8000-000000000005', 'c0a00005-0000-4000-8000-000000000052',
    'Dispensed to the patient', 'sealed-qa-0134-dispense-0001', repeat('d', 64), current_setting('app.correlation_id')
    from pharmacy.work_items item$s$), 'ok');
select pg_temp.as_qa(5, '51', 3);
select pg_temp.expect('at QA Pharmacy it does not see QA Hospital''s work', (select count(*)::text
  from pharmacy.work_items), '0');
reset role;
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
  requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e1340004-0000-4000-8000-000000000001', 'c0a00009-0000-4000-8000-000000000001',
  'c0a00002-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001', gen_random_uuid(), 1,
  'e1340002-0000-4000-8000-000000000001', 'accepted', 'routine', 'http://loinc.org', '718-7', 'Haemoglobin',
  'c0a00003-0000-4000-8000-000000000001', clock_timestamp(), 'c0a00003-0000-4000-8000-000000000001',
  'c0a00005-0000-4000-8000-000000000011', 'sealed-qa-0134-lab-item-0001', repeat('b', 64), 'sealed-qa-0134-lab');
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_qa(3, '32', 1);
select pg_temp.expect('the QA Lab Scientist at QA Hospital sees QA Hospital''s own lab work',
  (select string_agg(card.patient_full_name, ',') from lab.work_items item
     cross join lateral lab.work_item_patient_cards(array[item.id]) card), 'QA Patient One');
select pg_temp.as_qa(3, '31', 2);
select pg_temp.expect('at QA Laboratory it does not', (select count(*)::text from lab.work_items), '0');
reset role;

-- 5. A refusal, and a deleted login (each undone). Cases 5 and 6 first take
-- back case 3's four rows (session_replication_role replica: no trigger), so
-- the install runs as it would on a database where an earlier state stood.
select pg_temp.expect('a fixed id held by another row', pg_temp.try($s$
  do $d$ begin
    perform set_config('session_replication_role', 'replica', true);
    update auth.account_roles set role_code = 'nurse' where id = 'c0a00005-0000-4000-8000-000000000052';
    perform set_config('session_replication_role', 'origin', true);
    perform identity.sealed_qa_hospital_work_staff_install();
  end $d$$s$), '55000 0134: SEALED_QA_ID_TAKEN');
create function pg_temp.take_back_case_3() returns void language sql as $f$
  delete from auth.account_roles
   where id in ('c0a00005-0000-4000-8000-000000000032', 'c0a00005-0000-4000-8000-000000000052');
  delete from identity.staff_facility_memberships
   where id in ('c0a00005-0000-4000-8000-000000000032', 'c0a00005-0000-4000-8000-000000000052');
$f$;
create function pg_temp.qa_hospital_memberships() returns text language sql as $f$
  select coalesce(string_agg(format('%s %s %s %s', case when membership.id::text like 'c0a00005%' then 'fixed'
           else 'admin' end, account.email, membership.membership_role, membership.active::text), '; '
           order by account.email, membership.id), 'none')
    from identity.staff_facility_memberships membership
    join auth.accounts account on account.id = membership.account_id
   where membership.facility_id = 'c0a00002-0000-4000-8000-000000000001'
     and membership.account_id in ('c0a00003-0000-4000-8000-000000000003', 'c0a00003-0000-4000-8000-000000000005');
$f$;
select pg_temp.expect('a QA login that was deleted gets nothing; the other one is written', pg_temp.try($s$
  do $d$ declare written integer; begin
    perform set_config('session_replication_role', 'replica', true);
    perform pg_temp.take_back_case_3();
    update auth.accounts set status = 'deleted' where id = 'c0a00003-0000-4000-8000-000000000005';
    perform set_config('session_replication_role', 'origin', true);
    written := identity.sealed_qa_hospital_work_staff_install();
    raise exception 'written % / %', written, pg_temp.qa_hospital_memberships();
  end $d$$s$), 'P0001 written 2 / fixed lab@healthidentitydirectory.com lab true');

-- 6. The QA Facility Admin's own membership of the QA Pharmacist at QA
-- Hospital (each undone).
select pg_temp.expect('an active pharmacist membership the QA Facility Admin made is left as it is', pg_temp.try($s$
  do $d$ declare written integer; begin
    perform set_config('session_replication_role', 'replica', true);
    perform pg_temp.take_back_case_3();
    insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active)
    values ('e1349999-0000-4000-8000-000000000001', 'c0a00004-0000-4000-8000-000000000005',
      'c0a00003-0000-4000-8000-000000000005', 'c0a00001-0000-4000-8000-000000000001',
      'c0a00002-0000-4000-8000-000000000001', 'pharmacist', 'pharmacist', false, true);
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values ('e1349999-0000-4000-8000-000000000002', 'c0a00003-0000-4000-8000-000000000005', 'pharmacist', 'facility',
      'e1349999-0000-4000-8000-000000000001', 'c0a00002-0000-4000-8000-000000000001', 'Invited by the QA Facility Admin');
    perform set_config('session_replication_role', 'origin', true);
    written := identity.sealed_qa_hospital_work_staff_install();
    raise exception 'written % / %', written, pg_temp.qa_hospital_memberships();
  end $d$$s$), 'P0001 written 2 / fixed lab@healthidentitydirectory.com lab true; '
    || 'admin pharmacy@healthidentitydirectory.com pharmacist true');
select pg_temp.expect('and a deactivated one too', pg_temp.try($s$
  do $d$ declare written integer; begin
    perform set_config('session_replication_role', 'replica', true);
    perform pg_temp.take_back_case_3();
    insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active)
    values ('e1349999-0000-4000-8000-000000000001', 'c0a00004-0000-4000-8000-000000000005',
      'c0a00003-0000-4000-8000-000000000005', 'c0a00001-0000-4000-8000-000000000001',
      'c0a00002-0000-4000-8000-000000000001', 'pharmacist', 'pharmacist', false, false);
    perform set_config('session_replication_role', 'origin', true);
    written := identity.sealed_qa_hospital_work_staff_install();
    raise exception 'written % / %', written, pg_temp.qa_hospital_memberships();
  end $d$$s$), 'P0001 written 2 / fixed lab@healthidentitydirectory.com lab true; '
    || 'admin pharmacy@healthidentitydirectory.com pharmacist false');

rollback;
