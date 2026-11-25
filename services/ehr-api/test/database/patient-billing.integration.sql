\set ON_ERROR_STOP on
-- 0162-0167 (BILL-1, Release D): patient billing release 1 with pharmacy
-- point-of-care stock. Rollback-only. Billing commands run as ehr-api's login
-- role (hid_ehr_api_runtime) and stock and counter-sale commands as
-- pharmacy-api's (hid_pharmacy_api_runtime), each in the context its
-- service's transactions set. The hooks of 0167 are exercised by writing the
-- live tables as the suite's owner in the pharmacist's or desk's session with
-- the live tables' own validators switched off for this transaction only (the
-- validators have their own suites; what is tested here is the hook).
-- Fictional people, places and identifiers only; ids start b1620.
--
--   1. payment settings: defaults, who may change them, emergency deferral
--      cannot be removed, pay-before not available, version conflict;
--   2. the price list: create, the national link (ORD-7 code checked, one
--      priced item per code), names unique per kind, update, who may;
--   3. bills: the check-in charge (0167 H1), one bill per visit, manual lines,
--      emergency and unknown patients deferred by the system (BILL-3), a
--      facility with no settings sees no bill, search text refused;
--   4. money: no open day, overpayment, POS, cash, transfer pending and its
--      second-person check, HMO cover never paid and never in the day,
--      waiver needs its code, void by another member only, receipts without
--      gaps, idempotency replay and reuse, totals agree after every command;
--   5. RLS and other facilities: another facility's bill is not found, the
--      runtime cannot read or write the tables;
--   6. end of day: one open day per scope, expected cash, a note for a
--      difference, a closed day never changes;
--   7. stock: settings, receipts by batch, expiry first across three
--      batches, expired batches never given out, OUT_OF_STOCK takes nothing,
--      adjustments, counter sale and hand-over, the ledger agrees; a
--      prescription-only medicine never sold through the bill routes or
--      handed over without its outside prescriber; no line on a sale already
--      handed over; a sale of free medicines is paid as made and handed over;
--   8. hooks: an accepted priced prescription adds a line with its quantity,
--      an unpriced code is counted, a dispensing takes stock expiry first,
--      pay-before refuses an unpaid bill and never a deferred one, a reversal
--      moves no stock and takes its line off an unpaid bill or marks a paid
--      one for a refund, a lab work item adds its line and the collection
--      gate;
--   9. audit rows never hold a name, Health ID, reference or reason text.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.
begin;

set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'billing-test'),
  ('healthcare-operations', 'Healthcare operations', 'billing-test')
  on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('b1620000-0000-4000-8000-000000000001', 'Billing Group A', 'billing-group-a'),
  ('b1620000-0000-4000-8000-000000000011', 'Billing Group B', 'billing-group-b');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('b1620000-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000001', 'Billing Clinic A',
   'BILL-A', 'Africa/Lagos', true, 'verified'),
  ('b1620000-0000-4000-8000-000000000012', 'b1620000-0000-4000-8000-000000000011', 'Billing Clinic B',
   'BILL-B', 'Africa/Lagos', true, 'verified');
create temporary table b_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into b_members values
  (1, 'b1620000-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000001', 'cashier', 'Ada Cashier'),
  (2, 'b1620000-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000001', 'billing_officer', 'Bola Officer'),
  (3, 'b1620000-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000001', 'pharmacist', 'Chidi Pharmacist'),
  (4, 'b1620000-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000001', 'doctor', 'Dayo Doctor'),
  (5, 'b1620000-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000001', 'receptionist', 'Efe Desk'),
  (6, 'b1620000-0000-4000-8000-000000000012', 'b1620000-0000-4000-8000-000000000011', 'cashier', 'Femi Cashier'),
  (7, 'b1620000-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000001', 'admin', 'Gbenga Admin'),
  (8, 'b1620000-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000001', 'lab', 'Hauwa Lab'),
  (9, 'b1620000-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000001', 'billing_officer', 'Ife Officer'),
  (10, 'b1620000-0000-4000-8000-000000000012', 'b1620000-0000-4000-8000-000000000011', 'receptionist', 'Jide Desk');
insert into auth.accounts (id, subject, email, display_name, status)
select ('b1620100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:billing-member-' || n,
  'billing-member-' || n || '@example.invalid', name, 'active' from b_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('b1620200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('b1620100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'billing-member-' || n || '@example.invalid', 'verified', role_code from b_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('b1620300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('b1620200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('b1620100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, organization, facility, role_code, role_code,
  true, true
from b_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('b1620100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
  ('b1620300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, facility, 'Synthetic billing suite role'
from b_members;

-- Patients: p1 standard (visit bill), p2 an unknown patient (ID-7), p3 arrives at triage 1, p4 at facility B,
-- p5 raised to triage 2 later, p6 a counter sale put on a Health ID.
create temporary table b_patients (n integer primary key, hid text, first text, last text) on commit drop;
insert into b_patients values
  (1, 'HID-BLAA22', 'Amaka', 'Billone'), (2, 'HID-BLAB22', 'Unknown', 'Patient'), (3, 'HID-BLAC22', 'Chioma', 'Billthree'),
  (4, 'HID-BLAD22', 'Dele', 'Billfour'), (5, 'HID-BLAE22', 'Ebere', 'Billfive'), (6, 'HID-BLAF22', 'Funmi', 'Billsix');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status, source_system)
select ('b1620400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, hid, first, last, first || ' ' || last,
  'female', date '1990-01-01' + n, 'active', 'hid' from b_patients;
insert into identity.unknown_patients (patient_id, facility_id, label_number, unknown_reason, status,
  created_by_account_id, created_by_membership_id, idempotency_key, request_sha256, row_version, updated_at)
values ('b1620400-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000002', 7, 'unconscious',
  'open', 'b1620100-0000-4000-8000-000000000005', 'b1620300-0000-4000-8000-000000000005', 'billing-unknown-key-0001',
  repeat('0', 64), 1, clock_timestamp());
-- ORD-7 lists (0149) with one active version each: a medicine and a lab test (fictional codes).
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at,
  loaded_at, active, sealed, attribution) values
  ('b1620500-0000-4000-8000-000000000001', 'medicine', 'billing-suite-1', repeat('a', 64), 'billing-suite',
   repeat('a', 64), clock_timestamp(), clock_timestamp(), true, true, array['fictional']),
  ('b1620500-0000-4000-8000-000000000002', 'lab_test', 'billing-suite-1', repeat('b', 64), 'billing-suite',
   repeat('b', 64), clock_timestamp(), clock_timestamp(), true, true, array['fictional']);
insert into ehr.catalog_medicines (version_id, list_id, generic_name, other_names, strength, dose_form, routes, source,
  withdrawn) values
  ('b1620500-0000-4000-8000-000000000001', 'MED-00042', 'Amoxicillin', '', '500 mg', 'capsule', array['oral'], 'fictional', false),
  ('b1620500-0000-4000-8000-000000000001', 'MED-00043', 'Paracetamol', '', '500 mg', 'tablet', array['oral'], 'fictional', false);
insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display, other_names, category, source, withdrawn)
values ('b1620500-0000-4000-8000-000000000002', 'LAB-0001', 'HID-LAB', 'LAB-FBC', 'Full blood count', '', 'haematology',
  'fictional', false);
-- An encounter and two prescriptions for p1 (one priced by code, one not), and a lab request.
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at) values
  ('b1620600-0000-4000-8000-000000000001', 'b1620400-0000-4000-8000-000000000001', 'b1620000-0000-4000-8000-000000000002',
   'b1620100-0000-4000-8000-000000000004', 'b1620300-0000-4000-8000-000000000004', 'ambulatory', 'in_progress',
   clock_timestamp());
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_code_system, medication_code, medication_display, frequency, instructions, status, quantity_to_dispense,
  quantity_unit) values
  ('b1620610-0000-4000-8000-000000000001', 'b1620600-0000-4000-8000-000000000001', 'b1620400-0000-4000-8000-000000000001',
   'b1620000-0000-4000-8000-000000000002', 'b1620100-0000-4000-8000-000000000004', 'b1620300-0000-4000-8000-000000000004',
   'HID-MED', 'MED-00042', 'Amoxicillin 500 mg capsule', 'three times a day', 'After food', 'active', 6, 'Capsule'),
  ('b1620610-0000-4000-8000-000000000002', 'b1620600-0000-4000-8000-000000000001', 'b1620400-0000-4000-8000-000000000001',
   'b1620000-0000-4000-8000-000000000002', 'b1620100-0000-4000-8000-000000000004', 'b1620300-0000-4000-8000-000000000004',
   'HID-MED', 'MED-00099', 'Fictional syrup', 'daily', 'At night', 'active', null, null),
  ('b1620610-0000-4000-8000-000000000003', 'b1620600-0000-4000-8000-000000000001', 'b1620400-0000-4000-8000-000000000001',
   'b1620000-0000-4000-8000-000000000002', 'b1620100-0000-4000-8000-000000000004', 'b1620300-0000-4000-8000-000000000004',
   'HID-MED', 'MED-00042', 'Amoxicillin 500 mg capsule', 'twice a day', 'After food', 'active', 2, 'Capsule');
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, status) values
  ('b1620630-0000-4000-8000-000000000001', 'b1620600-0000-4000-8000-000000000001', 'b1620400-0000-4000-8000-000000000001',
   'b1620000-0000-4000-8000-000000000002', 'b1620100-0000-4000-8000-000000000004', 'b1620300-0000-4000-8000-000000000004',
   'HID-LAB', 'LAB-FBC', 'Full blood count', 'active');
set local session_replication_role = origin;

-- The live tables' own validators are switched off for this transaction only (rolled back at the end).
alter table pharmacy.work_item_acceptances disable trigger pharmacy_work_item_acceptance_validate;
alter table pharmacy.dispensings disable trigger pharmacy_dispensing_validate;
alter table pharmacy.dispensings disable trigger dispensings_claim_prescription;
alter table pharmacy.dispensings disable trigger dispensings_order_route_return;
alter table pharmacy.dispensing_reversals disable trigger pharmacy_dispensing_reversal_validate;
alter table pharmacy.dispensing_reversals disable trigger dispensing_reversals_order_route_return;
alter table lab.work_items disable trigger lab_work_item_validate;
alter table lab.specimens disable trigger lab_specimen_transition;
alter table pharmacy.work_items disable trigger pharmacy_work_item_validate;
alter table pharmacy.work_items disable trigger work_items_claim_prescription;
-- p1's three pharmacy work items, sent automatically (0133), written in the desk doctor's session so 0133's own-work
-- listing trigger lists the patient for this facility's pharmacy.
select set_config('app.facility_id', 'b1620000-0000-4000-8000-000000000002', true),
  set_config('app.correlation_id', 'billing-suite-fixture', true);
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
  source_ehr_prescription_version, source_encounter_id, source_status, status, medication_code_system, medication_code,
  medication_display, frequency, instructions, prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id,
  accepted_at, acceptance_reason, idempotency_key, request_sha256, correlation_id)
select ('b1620620-0000-4000-8000-00000000000' || n)::uuid, 'b1620400-0000-4000-8000-000000000001',
  'b1620000-0000-4000-8000-000000000002', 'b1620000-0000-4000-8000-000000000002',
  ('b1620610-0000-4000-8000-00000000000' || n)::uuid, 1, 'b1620600-0000-4000-8000-000000000001', 'active', 'accepted',
  'HID-MED', case n when 2 then 'MED-00099' else 'MED-00042' end,
  case n when 2 then 'Fictional syrup' else 'Amoxicillin 500 mg capsule' end, 'daily', 'As directed',
  'b1620100-0000-4000-8000-000000000004', clock_timestamp(), 'b1620100-0000-4000-8000-000000000004',
  'b1620300-0000-4000-8000-000000000004', clock_timestamp(), 'Sent automatically when the prescription was activated',
  'own-pharmacy-send:billing-' || n, repeat('0', 64), 'billing-suite-correlation'
from generate_series(1, 3) n;

create temporary table b_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
create temporary table b_saved (label text primary key, value jsonb) on commit drop;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.b_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.member(n integer) returns uuid language sql immutable as $f$
  select ('b1620300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.patient(n integer) returns uuid language sql immutable as $f$
  select ('b1620400-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.as_member(n integer, purpose text default 'healthcare-operations') returns void
language sql as $f$
  select set_config('app.actor_subject', 'synthetic:billing-member-' || n, true),
    set_config('app.membership_id', pg_temp.member(n)::text, true),
    set_config('app.facility_id', (select facility::text from pg_temp.b_members where b_members.n = as_member.n), true),
    set_config('app.correlation_id', 'billing-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.own_facility_work', '0133', true),
    set_config('app.vitals_status', '0142', true);
$f$;
create function pg_temp.k(label text) returns text language sql immutable as $f$ select 'k' || md5(label) $f$;
create function pg_temp.h(label text) returns text language sql immutable as $f$
  select md5(label) || md5(label || '/')
$f$;
-- Runs one command as member n under a runtime role. Success keeps the answer under label and answers 'ok';
-- a refusal answers its SQLSTATE and code.
create function pg_temp.go(saved_as text, n integer, runtime text, statement text) returns text language plpgsql as $f$
declare
  answer jsonb;
begin
  perform pg_temp.as_member(n);
  execute format('set local role %I', runtime);
  execute statement into answer;
  reset role;
  insert into pg_temp.b_saved as saved (label, value) values (saved_as, answer)
    on conflict on constraint b_saved_pkey do update set value = excluded.value;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.ehr(label text, n integer, statement text) returns text language sql as $f$
  select pg_temp.go(label, n, 'hid_ehr_api_runtime', statement)
$f$;
create function pg_temp.pharm(label text, n integer, statement text) returns text language sql as $f$
  select pg_temp.go(label, n, 'hid_pharmacy_api_runtime', statement)
$f$;
create function pg_temp.v(wanted text) returns jsonb language sql stable as $f$
  select saved.value from pg_temp.b_saved saved where saved.label = wanted
$f$;
create function pg_temp.ids(wanted text) returns text language sql stable as $f$
  select pg_temp.v(wanted)->>'id'
$f$;
-- Suite lookups as the suite's owner.
create function pg_temp.bill_of(patient integer) returns uuid language sql as $f$
  select id from commercial.bills where patient_id = pg_temp.patient(patient) order by created_at desc limit 1
$f$;
create function pg_temp.version(bill uuid) returns bigint language sql as $f$
  select row_version from commercial.bills where id = bill
$f$;
create function pg_temp.agree() returns text language sql as $f$
  select count(*) filter (where not commercial.bill_totals_agree(id))::text from commercial.bills
$f$;
-- A check-in as written by 0135's function (in the desk member's session).
create function pg_temp.check_in(n integer, patient integer, triage smallint default null) returns uuid
language plpgsql as $f$
declare
  entry uuid;
begin
  perform pg_temp.as_member(n);
  insert into ehr.visit_queue (facility_id, patient_id, queue_day, stage, triage_level, check_in_basis,
    checked_in_by_account_id, checked_in_by_membership_id, checked_in_at, stage_changed_at, updated_by_membership_id)
  values ((select facility from pg_temp.b_members where b_members.n = check_in.n), pg_temp.patient(patient),
    commercial.lagos_day(clock_timestamp()), 'waiting', triage, 'search',
    ('b1620100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.member(n), clock_timestamp(),
    clock_timestamp(), pg_temp.member(n))
  returning id into entry;
  return entry;
end
$f$;

-- 1. Payment settings.
select pg_temp.check_case('1 defaults before any settings', 'ok',
  pg_temp.ehr('s0', 1, 'select commercial.settings_get()'));
select pg_temp.check_case('1 defaults are the contract''s', 'cashier/["cash", "pos", "transfer"]/["emergency"]/facility/0',
  (select format('%s/%s/%s/%s/%s', v->>'wherePaid', v->'methods', v->'allowDeferredFor', v->>'dayCloseBy', v->>'version')
     from pg_temp.v('s0') v));
select pg_temp.check_case('1 a cashier cannot change settings', 'HB403 BILLING_NOT_ALLOWED',
  pg_temp.ehr('x', 1, $s$select commercial.settings_put('{"wherePaid":"both","methods":["cash"],"payBefore":{"pharmacy":false,"lab":false},"allowDeferredFor":["emergency"],"transferAccount":null,"hmos":[],"tills":[],"dayCloseBy":"facility","receiptFooter":null,"checkInChargeItemId":null}', 0, false, false, 'kbillingsettings000001', repeat('1', 64))$s$));
select pg_temp.check_case('1 emergency deferral cannot be removed', 'HB409 EMERGENCY_DEFERRAL_REQUIRED',
  pg_temp.ehr('x', 7, $s$select commercial.settings_put('{"wherePaid":"both","methods":["cash"],"payBefore":{"pharmacy":false,"lab":false},"allowDeferredFor":[],"transferAccount":null,"hmos":[],"tills":[],"dayCloseBy":"facility","receiptFooter":null,"checkInChargeItemId":null}', 0, false, false, 'kbillingsettings000002', repeat('2', 64))$s$));
select pg_temp.check_case('1 pay-before is not available yet', 'HB409 PAY_BEFORE_NOT_AVAILABLE',
  pg_temp.ehr('x', 7, $s$select commercial.settings_put('{"wherePaid":"both","methods":["cash"],"payBefore":{"pharmacy":true,"lab":false},"allowDeferredFor":["emergency"],"transferAccount":null,"hmos":[],"tills":[],"dayCloseBy":"facility","receiptFooter":null,"checkInChargeItemId":null}', 0, false, false, 'kbillingsettings000003', repeat('3', 64))$s$));
select pg_temp.check_case('1 the administrator saves the settings', 'ok',
  pg_temp.ehr('s1', 7, $s$select commercial.settings_put('{"wherePaid":"both","methods":["cash","pos","transfer","hmo","waiver"],"payBefore":{"pharmacy":false,"lab":false},"allowDeferredFor":["emergency"],"transferAccount":{"bankName":"Test Bank","accountName":"Billing Clinic A","accountNumber":"0000000000"},"hmos":[{"name":"Demo HMO","active":true}],"tills":[{"name":"Front till","active":true}],"dayCloseBy":"cashier","receiptFooter":"Thank you","checkInChargeItemId":null}', 0, false, false, 'kbillingsettings000004', repeat('4', 64))$s$));
select pg_temp.check_case('1 saved: version 1, one HMO, one till', '1/1/1/cashier',
  (select format('%s/%s/%s/%s', v->>'version', jsonb_array_length(v->'hmos'), jsonb_array_length(v->'tills'),
     v->>'dayCloseBy') from pg_temp.v('s1') v));
select pg_temp.check_case('1 a stale version is refused', 'HB412 VERSION_CONFLICT',
  pg_temp.ehr('x', 7, $s$select commercial.settings_put('{"wherePaid":"both","methods":["cash"],"payBefore":{"pharmacy":false,"lab":false},"allowDeferredFor":["emergency"],"transferAccount":null,"hmos":[],"tills":[],"dayCloseBy":"cashier","receiptFooter":null,"checkInChargeItemId":null}', 0, false, false, 'kbillingsettings000005', repeat('5', 64))$s$));

-- 2. The price list.
select pg_temp.check_case('2 a cashier cannot add an item', 'HB403 BILLING_NOT_ALLOWED',
  pg_temp.ehr('x', 1, $s$select commercial.catalogue_create('{"kind":"other","name":"Consultation","prices":{"cashKobo":500000,"hmo":[]}}', 'kbillingcatalogue00001', repeat('1', 64))$s$));
select pg_temp.check_case('2 the consultation fee', 'ok',
  pg_temp.ehr('consult', 2, $s$select commercial.catalogue_create('{"kind":"other","name":"Consultation","prices":{"cashKobo":500000,"hmo":[]}}', 'kbillingcatalogue00002', repeat('2', 64))$s$));
select pg_temp.check_case('2 amoxicillin with its national code', 'ok',
  pg_temp.ehr('amox', 2, format($s$select commercial.catalogue_create('{"kind":"drug","name":"Amoxicillin 500 mg capsule","strength":"500 mg","form":"capsule","packSize":"21 capsules","prescriptionOnly":true,"nationalCodeSystem":"HID-MED","nationalCode":"MED-00042","prices":{"cashKobo":15000,"hmo":[{"hmoId":"%s","amountKobo":12000}]}}', 'kbillingcatalogue00003', repeat('3', 64))$s$,
    (select pg_temp.v('s1')->'hmos'->0->>'id'))));
select pg_temp.check_case('2 the item answers its link and HMO price', 'HID-MED/MED-00042/15000/12000/false',
  (select format('%s/%s/%s/%s/%s', v->>'nationalCodeSystem', v->>'nationalCode', v->'prices'->>'cashKobo',
     v->'prices'->'hmo'->0->>'amountKobo', v->>'stockKept') from pg_temp.v('amox') v));
select pg_temp.check_case('2 a second item with the same code', 'HB409 NATIONAL_CODE_ALREADY_PRICED',
  pg_temp.ehr('x', 2, $s$select commercial.catalogue_create('{"kind":"drug","name":"Amoxicillin again","prescriptionOnly":true,"nationalCodeSystem":"HID-MED","nationalCode":"MED-00042","prices":{"cashKobo":1,"hmo":[]}}', 'kbillingcatalogue00004', repeat('4', 64))$s$));
select pg_temp.check_case('2 a code not on the national list', 'HB409 NATIONAL_CODE_NOT_FOUND',
  pg_temp.ehr('x', 2, $s$select commercial.catalogue_create('{"kind":"drug","name":"Made up","prescriptionOnly":false,"nationalCodeSystem":"HID-MED","nationalCode":"MED-09999","prices":{"cashKobo":1,"hmo":[]}}', 'kbillingcatalogue00005', repeat('5', 64))$s$));
select pg_temp.check_case('2 an active name is unique per kind in any case', 'HB409 CATALOGUE_ITEM_EXISTS',
  pg_temp.ehr('x', 2, $s$select commercial.catalogue_create('{"kind":"other","name":"CONSULTATION","prices":{"cashKobo":1,"hmo":[]}}', 'kbillingcatalogue00006', repeat('6', 64))$s$));
select pg_temp.check_case('2 the full blood count', 'ok',
  pg_temp.ehr('fbc', 2, $s$select commercial.catalogue_create('{"kind":"lab_test","name":"Full blood count","nationalCodeSystem":"HID-LAB","nationalCode":"LAB-FBC","prices":{"cashKobo":300000,"hmo":[]}}', 'kbillingcatalogue00007', repeat('7', 64))$s$));
select pg_temp.check_case('2 a price change', 'ok',
  pg_temp.ehr('consult2', 2, format($s$select commercial.catalogue_update('%s', '{"prices":{"cashKobo":400000,"hmo":[]}}', 1, 'kbillingcatalogue00008', repeat('8', 64))$s$,
    pg_temp.ids('consult'))));
select pg_temp.check_case('2 the new price and version', '400000/2',
  (select format('%s/%s', v->'prices'->>'cashKobo', v->>'version') from pg_temp.v('consult2') v));
select pg_temp.check_case('2 the check-in charge is set', 'ok',
  pg_temp.ehr('s2', 7, format($s$select commercial.settings_put('{"wherePaid":"both","methods":["cash","pos","transfer","hmo","waiver"],"payBefore":{"pharmacy":false,"lab":false},"allowDeferredFor":["emergency"],"transferAccount":null,"hmos":%s,"tills":%s,"dayCloseBy":"cashier","receiptFooter":"Thank you","checkInChargeItemId":"%s"}', 1, false, false, 'kbillingsettings000006', repeat('6', 64))$s$,
    pg_temp.v('s1')->'hmos', pg_temp.v('s1')->'tills', pg_temp.ids('consult'))));

-- 3. Bills.
select pg_temp.check_in(5, 1);
select pg_temp.check_case('3 the check-in opened the visit bill with the charge', 'visit/unpaid/400000/check_in',
  (select format('%s/%s/%s/%s', bill.source, bill.status, bill.total_kobo,
     (select string_agg(line.origin, ',') from commercial.bill_lines line where line.bill_id = bill.id))
     from commercial.bills bill where bill.id = pg_temp.bill_of(1)));
select pg_temp.check_case('3 a manual bill for the same visit is merged into it', 'ok',
  pg_temp.ehr('merge', 1, format($s$select commercial.bill_create('{"source":"visit","patient":{"visitQueueEntryId":"%s"},"lines":[{"catalogueItemId":"%s","quantity":2}]}', 'kbillingbillcreate001', repeat('1', 64))$s$,
    (select visit_queue_entry_id from commercial.bills where id = pg_temp.bill_of(1)), pg_temp.ids('amox'))));
select pg_temp.check_case('3 merged: same bill, two lines, total', 'true/true/2/430000',
  (select format('%s/%s/%s/%s', ((v->'bill'->>'id')::uuid = pg_temp.bill_of(1))::text, v->>'merged',
     jsonb_array_length(v->'bill'->'lines'), v->'bill'->>'totalKobo') from pg_temp.v('merge') v));
select pg_temp.check_case('3 the patient on a bill: last 4 of the Health ID only', 'AA22/Amaka Billone/no',
  (select format('%s/%s/%s', v->'bill'->'patient'->>'healthIdLast4', v->'bill'->'patient'->>'displayName',
     case when v::text like '%HID-BLAA22%' then 'yes' else 'no' end) from pg_temp.v('merge') v));
select pg_temp.check_in(5, 3, 1::smallint);
select pg_temp.check_case('3 a triage-1 arrival''s bill is deferred by the system', 'deferred/emergency/system',
  (select format('%s/%s/%s', status, deferred_reason, deferred_by) from commercial.bills where id = pg_temp.bill_of(3)));
select pg_temp.check_in(5, 2);
select pg_temp.check_case('3 an unknown patient''s bill is deferred by the system', 'deferred/unknown_patient/system',
  (select format('%s/%s/%s', status, deferred_reason, deferred_by) from commercial.bills where id = pg_temp.bill_of(2)));
select pg_temp.check_in(5, 5);
do $$ begin
  perform pg_temp.as_member(4);
  update ehr.visit_queue set triage_level = 2 where patient_id = pg_temp.patient(5);
end $$;
select pg_temp.check_case('3 raised to triage 2: the bill is deferred', 'deferred/emergency',
  (select format('%s/%s', status, deferred_reason) from commercial.bills where id = pg_temp.bill_of(5)));
select pg_temp.check_in(10, 4);
select pg_temp.check_case('3 a facility with no settings gets no bill', '0',
  (select count(*)::text from commercial.bills where patient_id = pg_temp.patient(4)));
select pg_temp.check_case('3 a Health ID in the search is refused', 'HB400 BILLING_SEARCH_TEXT_NOT_ALLOWED',
  pg_temp.ehr('x', 1, $s$select commercial.bill_list(null, null, 'HID-BLAA22', null, 1)$s$));
select pg_temp.check_case('3 an 11-digit NIN in the search is refused', 'HB400 BILLING_SEARCH_TEXT_NOT_ALLOWED',
  pg_temp.ehr('x', 1, $s$select commercial.bill_list(null, null, '12345678901', null, 1)$s$));
select pg_temp.check_case('3 the list by name start', 'ok',
  pg_temp.ehr('list', 1, $s$select commercial.bill_list('open', null, 'amak', null, 1)$s$));
select pg_temp.check_case('3 the list finds p1''s bill only', '1',
  (select jsonb_array_length(pg_temp.v('list')->'items')::text));
select pg_temp.check_case('3 a doctor may defer, the cashier may not', 'HB403 BILLING_NOT_ALLOWED',
  pg_temp.ehr('x', 1, format($s$select commercial.bill_defer('%s', 'emergency', null, 'kbillingdefer00000001', repeat('1', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('3 inpatient deferral is not available', 'HB409 DEFERRAL_REASON_NOT_AVAILABLE',
  pg_temp.ehr('x', 4, format($s$select commercial.bill_defer('%s', 'inpatient', null, 'kbillingdefer00000002', repeat('2', 64))$s$, pg_temp.bill_of(1))));

-- 4. Money (p1's bill: 430000 due).
select pg_temp.check_case('4 no open day: cash refused', 'HB409 TILL_DAY_NOT_OPEN',
  pg_temp.ehr('x', 1, format($s$select commercial.payment_record('%s', '{"method":"cash","amountKobo":1000}', null, 'kbillingpay0000000001', repeat('1', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 the cashier opens a day', 'ok',
  pg_temp.ehr('day1', 1, $s$select commercial.day_open(null, 100000, 'kbillingday0000000001', repeat('1', 64))$s$));
select pg_temp.check_case('4 a second open day in the same scope', 'HB409 SHIFT_ALREADY_OPEN',
  pg_temp.ehr('x', 1, $s$select commercial.day_open(null, 0, 'kbillingday0000000002', repeat('2', 64))$s$));
select pg_temp.check_case('4 overpayment is refused', 'HB409 OVERPAYMENT',
  pg_temp.ehr('x', 1, format($s$select commercial.payment_record('%s', '{"method":"cash","amountKobo":430001}', null, 'kbillingpay0000000002', repeat('2', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 POS with its RRN', 'ok',
  pg_temp.ehr('pos', 1, format($s$select commercial.payment_record('%s', '{"method":"pos","amountKobo":100000,"reference":"123456789012"}', null, 'kbillingpay0000000003', repeat('3', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 a replay of the same key and body', 'ok',
  pg_temp.ehr('posr', 1, format($s$select commercial.payment_record('%s', '{"method":"pos","amountKobo":100000,"reference":"123456789012"}', null, 'kbillingpay0000000003', repeat('3', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 the replay answers the same bill, marked replayed, one payment', 'true/1',
  (select format('%s/%s', v->>'replayed', jsonb_array_length(v->'payments')) from pg_temp.v('posr') v));
select pg_temp.check_case('4 the same key with another body', 'HB409 IDEMPOTENCY_KEY_REUSED',
  pg_temp.ehr('x', 1, format($s$select commercial.payment_record('%s', '{"method":"pos","amountKobo":100,"reference":"123456789012"}', null, 'kbillingpay0000000003', repeat('4', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 cash', 'ok',
  pg_temp.ehr('cash', 1, format($s$select commercial.payment_record('%s', '{"method":"cash","amountKobo":30000}', null, 'kbillingpay0000000005', repeat('5', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 receipts are numbered without gaps', format('R-%s-000001,R-%s-000002',
    extract(year from clock_timestamp() at time zone 'Africa/Lagos'), extract(year from clock_timestamp() at time zone 'Africa/Lagos')),
  (select string_agg(receipt_number, ',' order by receipt_number) from commercial.payments where bill_id = pg_temp.bill_of(1)));
select pg_temp.check_case('4 a transfer needs the recorder''s own open day', 'HB409 TILL_DAY_NOT_OPEN',
  pg_temp.ehr('x', 2, format($s$select commercial.payment_record('%s', '{"method":"transfer","amountKobo":50000,"reference":"TRF-0001"}', null, 'kbillingpay0000000006', repeat('6', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 the officer opens a day', 'ok',
  pg_temp.ehr('day2', 2, $s$select commercial.day_open(null, 0, 'kbillingday0000000003', repeat('3', 64))$s$));
select pg_temp.check_case('4 the transfer is recorded', 'ok',
  pg_temp.ehr('tr', 2, format($s$select commercial.payment_record('%s', '{"method":"transfer","amountKobo":50000,"reference":"TRF-0001"}', null, 'kbillingpay0000000007', repeat('7', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 a pending transfer lowers due, not paid', '130000/50000/250000',
  (select format('%s/%s/%s', v->>'paidKobo', v->>'pendingCheckKobo', v->>'dueKobo') from pg_temp.v('tr') v));
select pg_temp.check_case('4 the recorder cannot check their own transfer', 'HB403 SECOND_PERSON_REQUIRED',
  pg_temp.ehr('x', 2, format($s$select commercial.payment_confirm('%s', '%s', null, 'kbillingconfirm000001', repeat('1', 64))$s$,
    pg_temp.bill_of(1), (select id from commercial.payments where method = 'transfer' and bill_id = pg_temp.bill_of(1)))));
select pg_temp.check_case('4 another officer checks it', 'ok',
  pg_temp.ehr('conf', 9, format($s$select commercial.payment_confirm('%s', '%s', null, 'kbillingconfirm000002', repeat('2', 64))$s$,
    pg_temp.bill_of(1), (select id from commercial.payments where method = 'transfer' and bill_id = pg_temp.bill_of(1)))));
select pg_temp.check_case('4 a checked transfer is paid', '180000/0',
  (select format('%s/%s', v->>'paidKobo', v->>'pendingCheckKobo') from pg_temp.v('conf') v));
select pg_temp.check_case('4 HMO cover', 'ok',
  pg_temp.ehr('hmo', 1, format($s$select commercial.payment_record('%s', '{"method":"hmo","amountKobo":200000,"hmoId":"%s","reference":"APP-778"}', null, 'kbillingpay0000000008', repeat('8', 64))$s$,
    pg_temp.bill_of(1), pg_temp.v('s1')->'hmos'->0->>'id')));
select pg_temp.check_case('4 HMO cover is owed, not paid, and has no receipt', '180000/200000/50000/3/1/pending_claim',
  (select format('%s/%s/%s/%s/%s/%s', v->>'paidKobo', v->>'hmoCoveredKobo', v->>'dueKobo',
     jsonb_array_length(v->'payments'), jsonb_array_length(v->'hmoCovers'), v->'hmoCovers'->0->>'status')
     from pg_temp.v('hmo') v));
select pg_temp.check_case('4 a cashier cannot waive', 'HB403 BILLING_NOT_ALLOWED',
  pg_temp.ehr('x', 1, format($s$select commercial.payment_record('%s', '{"method":"waiver","amountKobo":1000,"reason":"Hardship case"}', null, 'kbillingpay0000000009', repeat('9', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 a cashier cannot void', 'HB403 BILLING_NOT_ALLOWED',
  pg_temp.ehr('x', 1, format($s$select commercial.payment_void('%s', '%s', 'Refund: wrong amount', null, null, 'kbillingvoid000000001', repeat('1', 64))$s$,
    pg_temp.bill_of(1), (select id from commercial.payments where method = 'cash' and bill_id = pg_temp.bill_of(1)))));
select pg_temp.check_case('4 the officer who took a payment cannot void it', 'HB403 SECOND_PERSON_REQUIRED',
  pg_temp.ehr('x', 2, format($s$select commercial.payment_void('%s', '%s', 'Refund: wrong amount', null, null, 'kbillingvoid000000002', repeat('2', 64))$s$,
    pg_temp.bill_of(1), (select id from commercial.payments where method = 'transfer' and bill_id = pg_temp.bill_of(1)))));
select pg_temp.check_case('4 voiding cash needs the voider''s open day', 'HB409 TILL_DAY_NOT_OPEN',
  pg_temp.ehr('x', 9, format($s$select commercial.payment_void('%s', '%s', 'Refund: wrong amount', null, null, 'kbillingvoid000000003', repeat('3', 64))$s$,
    pg_temp.bill_of(1), (select id from commercial.payments where method = 'cash' and bill_id = pg_temp.bill_of(1)))));
select pg_temp.check_case('4 the second officer opens a day', 'ok',
  pg_temp.ehr('day9', 9, $s$select commercial.day_open(null, 0, 'kbillingday0000000009', repeat('9', 64))$s$));
select pg_temp.check_case('4 another officer voids the cash', 'ok',
  pg_temp.ehr('void', 9, format($s$select commercial.payment_void('%s', '%s', 'Refund: wrong amount', null, null, 'kbillingvoid000000004', repeat('4', 64))$s$,
    pg_temp.bill_of(1), (select id from commercial.payments where method = 'cash' and bill_id = pg_temp.bill_of(1)))));
select pg_temp.check_case('4 the void keeps its receipt number and puts the amount back', '150000/80000/t',
  (select format('%s/%s/%s', v->>'paidKobo', v->>'dueKobo',
     exists (select 1 from jsonb_array_elements(v->'payments') p where p->>'method' = 'cash' and (p->>'voided')::boolean
              and p->>'receiptNumber' is not null)) from pg_temp.v('void') v));
select pg_temp.check_case('4 a voided payment cannot be voided again', 'HB409 PAYMENT_ALREADY_VOIDED',
  pg_temp.ehr('x', 9, format($s$select commercial.payment_void('%s', '%s', 'Refund: wrong amount', null, null, 'kbillingvoid000000005', repeat('5', 64))$s$,
    pg_temp.bill_of(1), (select id from commercial.payments where method = 'cash' and bill_id = pg_temp.bill_of(1)))));
select pg_temp.check_case('4 the officer waives with a reason', 'ok',
  pg_temp.ehr('waive', 2, format($s$select commercial.payment_record('%s', '{"method":"waiver","amountKobo":10000,"reason":"Hardship case"}', null, 'kbillingpay0000000010', repeat('a', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 a line cannot be cancelled below what is paid', 'HB409 LINE_CANCEL_BELOW_PAID',
  pg_temp.ehr('x', 2, format($s$select commercial.bill_line_cancel('%s', '%s', 'Charged by mistake', null, 'kbillingcancel0000001', repeat('1', 64))$s$,
    pg_temp.bill_of(1), (select id from commercial.bill_lines where bill_id = pg_temp.bill_of(1) and origin = 'check_in'))));
select pg_temp.check_case('4 a bill with payments cannot be voided', 'HB409 BILL_HAS_PAYMENTS',
  pg_temp.ehr('x', 2, format($s$select commercial.bill_void('%s', 'Opened by mistake', null, 'kbillingbillvoid00001', repeat('1', 64))$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('4 a cashier cannot cancel an HMO cover', 'HB403 BILLING_NOT_ALLOWED',
  pg_temp.ehr('x', 1, format($s$select commercial.hmo_cover_cancel('%s', '%s', 'Wrong HMO chosen', null, 'kbillingcover00000001', repeat('1', 64))$s$,
    pg_temp.bill_of(1), (select id from commercial.hmo_covers where bill_id = pg_temp.bill_of(1)))));
select pg_temp.check_case('4 the POS receipt', 'ok',
  pg_temp.ehr('receipt', 1, format($s$select commercial.receipt('%s', '%s')$s$, pg_temp.bill_of(1),
    (select id from commercial.payments where method = 'pos' and bill_id = pg_temp.bill_of(1)))));
select pg_temp.check_case('4 no receipt for an HMO cover', 'HB404 RECEIPT_NOT_FOUND',
  pg_temp.ehr('x', 1, format($s$select commercial.receipt('%s', '%s')$s$, pg_temp.bill_of(1),
    (select id from commercial.hmo_covers where bill_id = pg_temp.bill_of(1)))));
select pg_temp.check_case('4 the HMO owes 200000', 'ok',
  pg_temp.ehr('recv', 2, $s$select commercial.hmo_receivables(null, 1)$s$));
select pg_temp.check_case('4 receivables by HMO', 'Demo HMO/1/200000',
  (select format('%s/%s/%s', v->'items'->0->>'hmoName', v->'items'->0->>'count', v->'items'->0->>'amountKobo')
     from pg_temp.v('recv') v));
select pg_temp.check_case('4 outstanding balances', 'ok', pg_temp.ehr('out', 2, $s$select commercial.outstanding(0, 1)$s$));
select pg_temp.check_case('4 outstanding includes p1''s 70000', 'true',
  (select exists (select 1 from jsonb_array_elements(pg_temp.v('out')->'items') item
                   where item->'patient'->>'healthIdLast4' = 'AA22' and (item->>'dueKobo')::bigint = 70000)::text));
select pg_temp.check_case('4 the cashier cannot read the outstanding list', 'HB403 BILLING_NOT_ALLOWED',
  pg_temp.ehr('x', 1, $s$select commercial.outstanding(0, 1)$s$));
select pg_temp.check_case('4 every bill''s totals agree', '0', pg_temp.agree());

-- 5. Other facilities and the runtime.
select pg_temp.check_case('5 another facility''s bill is not found', 'HB404 BILL_NOT_FOUND',
  pg_temp.ehr('x', 6, format($s$select commercial.bill_get('%s')$s$, pg_temp.bill_of(1))));
select pg_temp.check_case('5 the runtime cannot read the bills table', '42501',
  (select left(pg_temp.ehr('x', 1, 'select to_jsonb(count(*)) from commercial.bills'), 5)));
select pg_temp.check_case('5 the pharmacy runtime cannot call the money functions', '42501',
  (select left(pg_temp.pharm('x', 3, format($s$select commercial.payment_record('%s', '{"method":"cash","amountKobo":1}', null, 'kbillingpay0000000011', repeat('b', 64))$s$, pg_temp.bill_of(1))), 5)));

-- 6. End of day.
select pg_temp.check_case('6 the cashier''s day: cash taken counted, expected cash', 'ok',
  pg_temp.ehr('cur1', 1, $s$select commercial.day_current(null)$s$));
select pg_temp.check_case('6 expected cash is opening plus cash taken', '130000',
  (select pg_temp.v('cur1')->'shift'->>'expectedCashKobo'));
select pg_temp.check_case('6 a difference needs a note', 'HB400 VALIDATION_FAILED',
  pg_temp.ehr('x', 1, format($s$select commercial.day_close('%s', 120000, null, %s, 'kbillingclose00000001', repeat('1', 64))$s$, pg_temp.ids('day1'), pg_temp.v('cur1')->'shift'->>'version')));
select pg_temp.check_case('6 the day closes with a note', 'ok',
  pg_temp.ehr('close1', 1, format($s$select commercial.day_close('%s', 120000, 'Counted twice; 100 naira notes short', %s, 'kbillingclose00000002', repeat('2', 64))$s$, pg_temp.ids('day1'), pg_temp.v('cur1')->'shift'->>'version')));
select pg_temp.check_case('6 the difference', '-10000',
  (select pg_temp.v('close1')->>'differenceKobo'));
select pg_temp.check_case('6 a closed day cannot be closed again', 'HB409 TILL_DAY_NOT_OPEN',
  pg_temp.ehr('x', 1, format($s$select commercial.day_close('%s', 120000, 'Again', %s, 'kbillingclose00000003', repeat('3', 64))$s$, pg_temp.ids('day1'), pg_temp.v('close1')->>'version')));
do $$
declare
  answer text;
begin
  begin
    update commercial.till_days set note = 'changed later' where id = (pg_temp.ids('day1'))::uuid;
    answer := 'changed';
  exception when others then
    answer := sqlstate;
  end;
  perform pg_temp.check_case('6 a closed day''s row never changes, even for the owner', 'HB409', answer);
end $$;

-- 7. Stock (pharmacist, pharmacy-api).
select pg_temp.check_case('7 stock settings for amoxicillin', 'ok',
  pg_temp.pharm('stk', 3, format($s$select pharmacy.stock_settings_put('%s', 'capsule', 10, 0, 'kbillingstock00000001', repeat('1', 64))$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 receive three batches', 'ok',
  pg_temp.pharm('rcv', 3, format($s$select pharmacy.stock_receive(jsonb_build_object('supplier', 'Fictional Supplies', 'invoiceNumber', 'INV-1', 'lines', jsonb_build_array(
      jsonb_build_object('catalogueItemId', '%1$s', 'batchNumber', 'LATE', 'expiresOn', (clock_timestamp() at time zone 'Africa/Lagos')::date + 100, 'quantity', 10),
      jsonb_build_object('catalogueItemId', '%1$s', 'batchNumber', 'SOON', 'expiresOn', (clock_timestamp() at time zone 'Africa/Lagos')::date + 10, 'quantity', 5),
      jsonb_build_object('catalogueItemId', '%1$s', 'batchNumber', 'MID', 'expiresOn', (clock_timestamp() at time zone 'Africa/Lagos')::date + 30, 'quantity', 5),
      jsonb_build_object('catalogueItemId', '%1$s', 'batchNumber', 'OLD', 'expiresOn', (clock_timestamp() at time zone 'Africa/Lagos')::date + 1, 'quantity', 7))), 'kbillingstock00000002', repeat('2', 64))$s$, pg_temp.ids('amox'))));
-- The OLD batch's expiry passes (the suite's owner moves it to yesterday).
update pharmacy.stock_batches set expires_on = commercial.lagos_day(clock_timestamp()) - 1 where batch_number = 'OLD'
   and facility_id = 'b1620000-0000-4000-8000-000000000002';
select pg_temp.check_case('7 a batch number with another expiry', 'HB409 BATCH_EXPIRY_MISMATCH',
  pg_temp.pharm('x', 3, format($s$select pharmacy.stock_receive(jsonb_build_object('lines', jsonb_build_array(
      jsonb_build_object('catalogueItemId', '%1$s', 'batchNumber', 'SOON', 'expiresOn', (clock_timestamp() at time zone 'Africa/Lagos')::date + 11, 'quantity', 1))), 'kbillingstock00000003', repeat('3', 64))$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 the stock line: on hand, expired apart', 'ok',
  pg_temp.pharm('list', 3, $s$select pharmacy.stock_list(null, null, 1)$s$));
select pg_temp.check_case('7 on hand 20, expired 7', '20/7',
  (select format('%s/%s', item->>'onHand', item->>'expiredOnHand') from jsonb_array_elements(pg_temp.v('list')->'items') item
    where item->>'catalogueItemId' = pg_temp.ids('amox')));
select pg_temp.check_case('7 the unit cannot change while there is stock', 'HB409 STOCK_UNIT_LOCKED',
  pg_temp.pharm('x', 3, format($s$select pharmacy.stock_settings_put('%s', 'tablet', 10, 1, 'kbillingstock00000004', repeat('4', 64))$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 stock cannot go below zero', 'HB409 STOCK_BELOW_ZERO',
  pg_temp.pharm('x', 3, format($s$select pharmacy.stock_adjust('{"catalogueItemId":"%s","batchId":"%s","change":-100,"reason":"damaged"}', 'kbillingstock00000006', repeat('6', 64))$s$,
    pg_temp.ids('amox'), (select id from pharmacy.stock_batches where batch_number = 'LATE' and facility_id = 'b1620000-0000-4000-8000-000000000002'))));
select pg_temp.check_case('7 a count adjustment needs a note', 'HB400 VALIDATION_FAILED',
  pg_temp.pharm('x', 3, format($s$select pharmacy.stock_adjust('{"catalogueItemId":"%s","batchId":"%s","change":-1,"reason":"count"}', 'kbillingstock00000007', repeat('7', 64))$s$,
    pg_temp.ids('amox'), (select id from pharmacy.stock_batches where batch_number = 'LATE' and facility_id = 'b1620000-0000-4000-8000-000000000002'))));
select pg_temp.check_case('7 a prescription-only sale needs the prescriber', 'HB422 PRESCRIPTION_REQUIRED',
  pg_temp.pharm('x', 3, format($s$select pharmacy.counter_sale_create('{"patient":{"kind":"anonymous"},"counter":true,"items":[{"catalogueItemId":"%s","quantity":8}]}', 'kbillingsale000000001', repeat('1', 64))$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 an anonymous pharmacy bill cannot sell a prescription-only medicine', 'HB422 PRESCRIPTION_REQUIRED',
  pg_temp.ehr('x', 3, format($s$select commercial.bill_create('{"source":"pharmacy","patient":{"anonymous":true},"lines":[{"catalogueItemId":"%s","quantity":2}]}', 'kbillingrxbill0000001', repeat('1', 64))$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 nor can the front desk', 'HB422 PRESCRIPTION_REQUIRED',
  pg_temp.ehr('x', 5, format($s$select commercial.bill_create('{"source":"pharmacy","patient":{"anonymous":true},"lines":[{"catalogueItemId":"%s","quantity":2}]}', 'kbillingrxbill0000002', repeat('2', 64))$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 queueing an outside prescription is not available', 'HB409 WALK_IN_QUEUE_NOT_AVAILABLE',
  pg_temp.pharm('x', 3, format($s$select pharmacy.counter_sale_create('{"patient":{"kind":"anonymous"},"counter":false,"outside":{"prescriberName":"Dr Test"},"items":[{"catalogueItemId":"%s","quantity":8}]}', 'kbillingsale000000002', repeat('2', 64))$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 a counter sale of 8', 'ok',
  pg_temp.pharm('sale', 3, format($s$select pharmacy.counter_sale_create('{"patient":{"kind":"anonymous","name":"Walk-in"},"counter":true,"outside":{"prescriberName":"Dr Test","facilityName":"Test Clinic"},"items":[{"catalogueItemId":"%s","quantity":8}],"purpose":"healthcare-operations"}', 'kbillingsale000000003', repeat('3', 64))$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 the sale''s bill', 'pharmacy/120000/true',
  (select format('%s/%s/%s', v->'bill'->>'source', v->'bill'->>'totalKobo', v->'bill'->>'counter') from pg_temp.v('sale') v));
select pg_temp.check_case('7 an unpaid counter sale is not handed over', 'HB409 PAYMENT_REQUIRED',
  pg_temp.pharm('x', 3, format($s$select pharmacy.sale_hand_over('%s', null, 'kbillinghand000000001', repeat('1', 64))$s$, pg_temp.v('sale')->'bill'->>'id')));
select pg_temp.check_case('7 the pharmacist opens a day', 'ok',
  pg_temp.ehr('day3', 3, $s$select commercial.day_open(null, 0, 'kbillingday0000000004', repeat('4', 64))$s$));
select pg_temp.check_case('7 the pharmacist takes cash for the sale', 'ok',
  pg_temp.ehr('salepay', 3, format($s$select commercial.payment_record('%s', '{"method":"cash","amountKobo":120000}', null, 'kbillingpay0000000012', repeat('c', 64))$s$, pg_temp.v('sale')->'bill'->>'id')));
select pg_temp.check_case('7 hand-over', 'ok',
  pg_temp.pharm('hand', 3, format($s$select pharmacy.sale_hand_over('%s', null, 'kbillinghand000000002', repeat('2', 64))$s$, pg_temp.v('sale')->'bill'->>'id')));
select pg_temp.check_case('7 expiry first: SOON emptied, then 3 from MID; LATE and the expired OLD untouched', 'LATE:10,MID:2,OLD:7,SOON:0',
  (select string_agg(batch_number || ':' || on_hand, ',' order by batch_number) from pharmacy.stock_batches
    where facility_id = 'b1620000-0000-4000-8000-000000000002'));
select pg_temp.check_case('7 a second hand-over', 'HB409 ALREADY_HANDED_OVER',
  pg_temp.pharm('x', 3, format($s$select pharmacy.sale_hand_over('%s', null, 'kbillinghand000000003', repeat('3', 64))$s$, pg_temp.v('sale')->'bill'->>'id')));
select pg_temp.check_case('7 no line is added to a sale already handed over', 'HB409 ALREADY_HANDED_OVER',
  pg_temp.ehr('x', 1, format($s$select commercial.bill_line_add('%s', '{"catalogueItemId":"%s","quantity":1}', null, 'kbillinglineadd000001', repeat('1', 64))$s$,
    pg_temp.v('sale')->'bill'->>'id', pg_temp.ids('amox'))));
select pg_temp.check_case('7 nor an item that needs no prescription', 'HB409 ALREADY_HANDED_OVER',
  pg_temp.ehr('x', 1, format($s$select commercial.bill_line_add('%s', '{"catalogueItemId":"%s","quantity":1}', null, 'kbillinglineadd000002', repeat('2', 64))$s$,
    pg_temp.v('sale')->'bill'->>'id', pg_temp.ids('consult'))));
select pg_temp.check_case('7 the handed-over sale is as it was paid', 'paid/120000/1',
  (select format('%s/%s/%s', status, total_kobo, (select count(*) from commercial.bill_lines where bill_id = bill.id))
     from commercial.bills bill where id = (pg_temp.v('sale')->'bill'->>'id')::uuid));
-- An anonymous pharmacy bill of an item that needs no prescription, which a prescription-only line then joins as the
-- suite's owner writes it (as a line made before this rule, or by any other way): the hand-over checks again.
select pg_temp.check_case('7 an anonymous pharmacy bill of an item that needs no prescription', 'ok',
  pg_temp.ehr('rxfree', 3, format($s$select commercial.bill_create('{"source":"pharmacy","patient":{"anonymous":true},"lines":[{"catalogueItemId":"%s","quantity":1}]}', 'kbillingrxbill0000003', repeat('3', 64))$s$, pg_temp.ids('consult'))));
select pg_temp.check_case('7 it is a counter sale', 'true', (select pg_temp.v('rxfree')->'bill'->>'counter'));
do $$
declare
  bill_value uuid := (pg_temp.v('rxfree')->'bill'->>'id')::uuid;
begin
  perform pg_temp.as_member(3);
  insert into commercial.bill_lines (facility_id, bill_id, catalogue_item_id, name, kind, quantity, unit_kobo, total_kobo,
    origin, created_by_membership_id)
  values ('b1620000-0000-4000-8000-000000000002', bill_value, (pg_temp.ids('amox'))::uuid, 'Amoxicillin 500 mg capsule',
    'drug', 1, 15000, 15000, 'manual', pg_temp.member(3));
  perform commercial.bill_recompute(bill_value);
end $$;
select pg_temp.check_case('7 that bill is paid', 'ok',
  pg_temp.ehr('x', 3, format($s$select commercial.payment_record('%s', '{"method":"cash","amountKobo":415000}', null, 'kbillingpay0000000014', repeat('e', 64))$s$, pg_temp.v('rxfree')->'bill'->>'id')));
select pg_temp.check_case('7 a prescription-only medicine is not handed over with no prescriber on the sale', 'HB422 PRESCRIPTION_REQUIRED',
  pg_temp.pharm('x', 3, format($s$select pharmacy.sale_hand_over('%s', null, 'kbillinghand000000005', repeat('5', 64))$s$, pg_temp.v('rxfree')->'bill'->>'id')));
select pg_temp.check_case('7 the sale''s prescriber is kept on its bill', 'Dr Test/',
  (select format('%s/%s', bill.outside_prescriber_name, (select outside_prescriber_name from commercial.bills
     where id = (pg_temp.v('rxfree')->'bill'->>'id')::uuid))
     from commercial.bills bill where id = (pg_temp.v('sale')->'bill'->>'id')::uuid));
select pg_temp.check_case('7 a sale of 13 (12 good on hand, 7 expired)', 'ok',
  pg_temp.pharm('sale2', 3, format($s$select pharmacy.counter_sale_create('{"patient":{"kind":"anonymous"},"counter":true,"outside":{"prescriberName":"Dr Test"},"items":[{"catalogueItemId":"%s","quantity":13}]}', 'kbillingsale000000004', repeat('4', 64))$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 the sale of 13 is paid', 'ok',
  pg_temp.ehr('salepay2', 3, format($s$select commercial.payment_record('%s', '{"method":"cash","amountKobo":195000}', null, 'kbillingpay0000000013', repeat('d', 64))$s$, pg_temp.v('sale2')->'bill'->>'id')));
select pg_temp.check_case('7 out of stock at hand-over', 'HB409 OUT_OF_STOCK',
  pg_temp.pharm('x', 3, format($s$select pharmacy.sale_hand_over('%s', null, 'kbillinghand000000004', repeat('4', 64))$s$, pg_temp.v('sale2')->'bill'->>'id')));
select pg_temp.check_case('7 out of stock takes nothing', 'LATE:10,MID:2,OLD:7,SOON:0',
  (select string_agg(batch_number || ':' || on_hand, ',' order by batch_number) from pharmacy.stock_batches
    where facility_id = 'b1620000-0000-4000-8000-000000000002'));
do $$
declare
  detail_text text;
begin
  perform pg_temp.as_member(3);
  begin
    perform pharmacy.take_stock_expiry_first('b1620000-0000-4000-8000-000000000002', (pg_temp.ids('amox'))::uuid, 13,
      null, 'counter_sale', null, (select id from commercial.bill_lines where bill_id = (pg_temp.v('sale2')->'bill'->>'id')::uuid),
      pg_temp.member(3));
    detail_text := 'taken';
  exception when sqlstate 'HB409' then
    get stacked diagnostics detail_text = pg_exception_detail;
    detail_text := sqlerrm || '/' || detail_text;
  end;
  perform pg_temp.check_case('7 OUT_OF_STOCK carries on hand, unit and expired on hand',
    'OUT_OF_STOCK/{"unit": "capsule", "onHand": 12, "expiredOnHand": 7}', detail_text);
end $$;
select pg_temp.check_case('7 the expired batch is written off', 'ok',
  pg_temp.pharm('wo', 3, format($s$select pharmacy.stock_adjust('{"catalogueItemId":"%s","batchId":"%s","change":-7,"reason":"expired"}', 'kbillingstock00000008', repeat('8', 64))$s$,
    pg_temp.ids('amox'), (select id from pharmacy.stock_batches where batch_number = 'OLD' and facility_id = 'b1620000-0000-4000-8000-000000000002'))));
select pg_temp.check_case('7 movements newest first', 'ok', pg_temp.pharm('mov', 3, format($s$select pharmacy.stock_movement_list('%s', 1)$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 the movement kinds', 'adjustment:1,counter_sale:2,receipt:4',
  (select string_agg(kind || ':' || count, ',' order by kind) from (
     select item->>'kind' as kind, count(*) from jsonb_array_elements(pg_temp.v('mov')->'items') item group by 1) counted));
select pg_temp.check_case('7 each batch''s on hand is the sum of its movements', 'true',
  (select pharmacy.stock_ledger_agrees('b1620000-0000-4000-8000-000000000002')::text));
select pg_temp.check_case('7 a counter sale on a Health ID', 'ok',
  pg_temp.pharm('sale3', 3, format($s$select pharmacy.counter_sale_create('{"patient":{"kind":"health_id","healthId":"HID-BLAF22"},"counter":true,"outside":{"prescriberName":"Dr Test"},"items":[{"catalogueItemId":"%s","quantity":1}]}', 'kbillingsale000000005', repeat('5', 64))$s$, pg_temp.ids('amox'))));
select pg_temp.check_case('7 only the bill is put on the patient', 'AF22/0',
  (select format('%s/%s', pg_temp.v('sale3')->'bill'->'patient'->>'healthIdLast4',
     (select count(*) from pharmacy.dispensings where patient_id = pg_temp.patient(6)))));
select pg_temp.check_case('7 the Health ID lookup is audited', '1',
  (select count(*)::text from audit.events where action = 'identity.patient.lookup' and patient_id = pg_temp.patient(6)));
select pg_temp.check_case('7 a manual prescription-only line on a counter sale is refused, prescriber or not', 'HB422 PRESCRIPTION_REQUIRED',
  pg_temp.ehr('x', 1, format($s$select commercial.bill_line_add('%s', '{"catalogueItemId":"%s","quantity":3}', null, 'kbillinglineadd000003', repeat('3', 64))$s$,
    pg_temp.v('sale3')->'bill'->>'id', pg_temp.ids('amox'))));
select pg_temp.check_case('7 an item that needs no prescription joins an open counter sale', 'ok',
  pg_temp.ehr('x', 1, format($s$select commercial.bill_line_add('%s', '{"catalogueItemId":"%s","quantity":1}', null, 'kbillinglineadd000004', repeat('4', 64))$s$,
    pg_temp.v('sale3')->'bill'->>'id', pg_temp.ids('consult'))));
-- Free programme medicines (priced at 0): the sale has nothing to pay, so it is paid as made and handed over.
select pg_temp.check_case('7 a free programme medicine', 'ok',
  pg_temp.ehr('ors', 2, $s$select commercial.catalogue_create('{"kind":"drug","name":"ORS sachet","prescriptionOnly":false,"prices":{"cashKobo":0,"hmo":[]}}', 'kbillingcatalogue00009', repeat('9', 64))$s$));
select pg_temp.check_case('7 its stock is counted', 'ok',
  pg_temp.pharm('orsstk', 3, format($s$select pharmacy.stock_settings_put('%s', 'sachet', 5, 0, 'kbillingstock00000009', repeat('9', 64))$s$, pg_temp.ids('ors'))));
select pg_temp.check_case('7 ten sachets received', 'ok',
  pg_temp.pharm('orsrcv', 3, format($s$select pharmacy.stock_receive(jsonb_build_object('lines', jsonb_build_array(
      jsonb_build_object('catalogueItemId', '%s', 'batchNumber', 'ORS-1', 'expiresOn', (clock_timestamp() at time zone 'Africa/Lagos')::date + 200, 'quantity', 10))), 'kbillingstock00000010', repeat('a', 64))$s$, pg_temp.ids('ors'))));
select pg_temp.check_case('7 a sale of two free sachets', 'ok',
  pg_temp.pharm('freesale', 3, format($s$select pharmacy.counter_sale_create('{"patient":{"kind":"anonymous"},"counter":true,"items":[{"catalogueItemId":"%s","quantity":2}]}', 'kbillingsale000000006', repeat('6', 64))$s$, pg_temp.ids('ors'))));
select pg_temp.check_case('7 a sale with nothing to pay is paid as made', 'paid/0/0',
  (select format('%s/%s/%s', v->'bill'->>'status', v->'bill'->>'totalKobo', v->'bill'->>'dueKobo') from pg_temp.v('freesale') v));
select pg_temp.check_case('7 the free sale is handed over', 'ok',
  pg_temp.pharm('freehand', 3, format($s$select pharmacy.sale_hand_over('%s', null, 'kbillinghand000000006', repeat('6', 64))$s$, pg_temp.v('freesale')->'bill'->>'id')));
select pg_temp.check_case('7 the free sachets leave the stock', '8',
  (select sum(on_hand)::text from pharmacy.stock_batches where catalogue_item_id = (pg_temp.ids('ors'))::uuid));

-- 8. Hooks.
do $$ begin
  perform pg_temp.as_member(3, 'direct-care');
  insert into pharmacy.work_item_acceptances (work_item_id, patient_id, facility_id, accepted_by, accepted_by_membership_id,
    accepted_with, idempotency_key, request_sha256, correlation_id)
  select ('b1620620-0000-4000-8000-00000000000' || n)::uuid, pg_temp.patient(1), 'b1620000-0000-4000-8000-000000000002',
    'b1620100-0000-4000-8000-000000000003', pg_temp.member(3), 'accept', 'billing-accept-key-000' || n, repeat('0', 64),
    'billing-suite-correlation' from generate_series(1, 2) n;
end $$;
select pg_temp.check_case('8 the accepted priced prescription is on the visit bill with its quantity', 'pharmacy/6/90000/f',
  (select format('%s/%s/%s/%s', origin, quantity, total_kobo, check_quantity) from commercial.bill_lines
    where work_item_id = 'b1620620-0000-4000-8000-000000000001'));
select pg_temp.check_case('8 the line joined p1''s visit bill', 'true',
  (select (bill_id = pg_temp.bill_of(1))::text from commercial.bill_lines where work_item_id = 'b1620620-0000-4000-8000-000000000001'));
select pg_temp.check_case('8 the unpriced code gets no line and is counted', '0/1',
  (select format('%s/%s', (select count(*) from commercial.bill_lines where work_item_id = 'b1620620-0000-4000-8000-000000000002'),
     (select count(*) from commercial.unpriced_code_hits where code = 'MED-00099'))));
select pg_temp.check_case('8 the officer sees the unpriced code with a count only', 'ok',
  pg_temp.ehr('unpriced', 2, 'select commercial.catalogue_unpriced_codes()'));
select pg_temp.check_case('8 unpriced codes', 'HID-MED/MED-00099/1',
  (select format('%s/%s/%s', item->>'codeSystem', item->>'code', item->>'count')
     from jsonb_array_elements(pg_temp.v('unpriced')->'items') item));
select pg_temp.check_case('8 the pharmacy sees the work item''s bill', 'ok',
  (select case when count(*) = 1 then 'ok' else count(*)::text end from (
     select 1 from (select pg_temp.as_member(3)) s, commercial.work_item_bills('pharmacy', array['b1620620-0000-4000-8000-000000000001'::uuid])) x));
-- A dispensing of 6 capsules takes MID's 2 then 4 from LATE.
do $$ begin
  perform pg_temp.as_member(3, 'direct-care');
  insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id, medication_code_system,
    medication_code, medication_display, quantity_dispensed, quantity_unit, status, dispensed_by, dispensed_by_membership_id,
    reason, idempotency_key, request_sha256, correlation_id)
  values ('b1620640-0000-4000-8000-000000000001', 'b1620620-0000-4000-8000-000000000001', 1, pg_temp.patient(1),
    'b1620000-0000-4000-8000-000000000002', 'HID-MED', 'MED-00042', 'Amoxicillin 500 mg capsule', 6, 'Capsule', 'dispensed',
    'b1620100-0000-4000-8000-000000000003', pg_temp.member(3), 'Dispensed as prescribed', 'billing-dispense-key-01',
    repeat('0', 64), 'billing-suite-correlation');
end $$;
select pg_temp.check_case('8 the dispensing took stock expiry first', 'LATE:6,MID:0,OLD:0,SOON:0',
  (select string_agg(batch_number || ':' || on_hand, ',' order by batch_number) from pharmacy.stock_batches
    where facility_id = 'b1620000-0000-4000-8000-000000000002' and catalogue_item_id = (pg_temp.ids('amox'))::uuid));
do $$
declare
  answer text;
begin
  perform pg_temp.as_member(3, 'direct-care');
  begin
    insert into pharmacy.dispensings (work_item_id, work_item_version, patient_id, facility_id, medication_code_system,
      medication_code, medication_display, quantity_dispensed, quantity_unit, status, dispensed_by, dispensed_by_membership_id,
      reason, idempotency_key, request_sha256, correlation_id)
    values ('b1620620-0000-4000-8000-000000000002', 1, pg_temp.patient(1), 'b1620000-0000-4000-8000-000000000002', 'HID-MED',
      'MED-00042', 'Amoxicillin 500 mg capsule', 1, 'bottle', 'dispensed', 'b1620100-0000-4000-8000-000000000003',
      pg_temp.member(3), 'Dispensed as prescribed', 'billing-dispense-key-02', repeat('0', 64), 'billing-suite-correlation');
    answer := 'inserted';
  exception when others then
    answer := sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.check_case('8 a dispensing in another unit is refused', 'HB409 STOCK_UNIT_MISMATCH', answer);
end $$;
-- Pay-before (the database takes the server's availability as given): on for pharmacy and lab.
select pg_temp.check_case('8 pay-before switched on where available', 'ok',
  pg_temp.ehr('s3', 7, format($s$select commercial.settings_put('{"wherePaid":"both","methods":["cash","pos","transfer","hmo","waiver"],"payBefore":{"pharmacy":true,"lab":true},"allowDeferredFor":["emergency"],"transferAccount":null,"hmos":%s,"tills":%s,"dayCloseBy":"cashier","receiptFooter":"Thank you","checkInChargeItemId":"%s"}', 2, true, false, 'kbillingsettings000007', repeat('7', 64))$s$,
    pg_temp.v('s1')->'hmos', pg_temp.v('s1')->'tills', pg_temp.ids('consult'))));
do $$
declare
  answer text;
begin
  perform pg_temp.as_member(3, 'direct-care');
  begin
    insert into pharmacy.dispensings (work_item_id, work_item_version, patient_id, facility_id, medication_code_system,
      medication_code, medication_display, quantity_dispensed, quantity_unit, status, dispensed_by, dispensed_by_membership_id,
      reason, idempotency_key, request_sha256, correlation_id)
    values ('b1620620-0000-4000-8000-000000000001', 1, pg_temp.patient(1), 'b1620000-0000-4000-8000-000000000002', 'HID-MED',
      'MED-00042', 'Amoxicillin 500 mg capsule', 6, 'capsule', 'dispensed', 'b1620100-0000-4000-8000-000000000003',
      pg_temp.member(3), 'Dispensed as prescribed', 'billing-dispense-key-03', repeat('0', 64), 'billing-suite-correlation');
    answer := 'inserted';
  exception when others then
    answer := sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.check_case('8 pay-before refuses the unpaid visit bill', 'HB409 PAYMENT_REQUIRED', answer);
  -- A deferred bill is never held up.
  update commercial.bills set deferred_reason = 'emergency', deferred_by = 'staff', deferred_at = clock_timestamp()
   where id = pg_temp.bill_of(1);
  begin
    insert into pharmacy.dispensings (work_item_id, work_item_version, patient_id, facility_id, medication_code_system,
      medication_code, medication_display, quantity_dispensed, quantity_unit, status, dispensed_by, dispensed_by_membership_id,
      reason, idempotency_key, request_sha256, correlation_id)
    values ('b1620620-0000-4000-8000-000000000001', 1, pg_temp.patient(1), 'b1620000-0000-4000-8000-000000000002', 'HID-MED',
      'MED-00042', 'Amoxicillin 500 mg capsule', 6, 'capsule', 'dispensed', 'b1620100-0000-4000-8000-000000000003',
      pg_temp.member(3), 'Dispensed as prescribed', 'billing-dispense-key-04', repeat('0', 64), 'billing-suite-correlation');
    answer := 'inserted';
  exception when unique_violation then
    -- The work item already has its (reversed) dispensing: the row got past the gate and the stock.
    answer := 'passed the gate';
  when others then
    answer := sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.check_case('8 pay-before never holds up a deferred bill', 'passed the gate', answer);
  update commercial.bills set deferred_reason = null, deferred_by = null, deferred_at = null where id = pg_temp.bill_of(1);
end $$;
-- A reversal (dispensed to the wrong patient: the capsules went home with them) moves no stock, and the medicine's
-- line comes off p1's bill, which can lose it (430000 left on the bill, 360000 paid, waived or covered).
do $$ begin
  perform pg_temp.as_member(3, 'direct-care');
  insert into pharmacy.dispensing_reversals (dispensing_id, dispensing_version, work_item_id, patient_id, facility_id,
    status, reversed_by, reversed_by_membership_id, reason, idempotency_key, request_sha256, correlation_id)
  values ('b1620640-0000-4000-8000-000000000001', 1, 'b1620620-0000-4000-8000-000000000001', pg_temp.patient(1),
    'b1620000-0000-4000-8000-000000000002', 'reversed', 'b1620100-0000-4000-8000-000000000003', pg_temp.member(3),
    'Dispensed to the wrong patient', 'billing-reverse-key-001', repeat('0', 64), 'billing-suite-correlation');
end $$;
select pg_temp.check_case('8 the reversal moves no stock: the capsules did not come back', 'LATE:6,MID:0,OLD:0,SOON:0',
  (select string_agg(batch_number || ':' || on_hand, ',' order by batch_number) from pharmacy.stock_batches
    where facility_id = 'b1620000-0000-4000-8000-000000000002' and catalogue_item_id = (pg_temp.ids('amox'))::uuid));
select pg_temp.check_case('8 the ledger still agrees', 'true',
  (select pharmacy.stock_ledger_agrees('b1620000-0000-4000-8000-000000000002')::text));
select pg_temp.check_case('8 the reversed medicine''s line comes off the unpaid bill', 't/Dispensing reversed/t/b1620300-0000-4000-8000-000000000003',
  (select format('%s/%s/%s/%s', cancelled, cancel_reason, dispensing_reversed_at is not null, cancelled_by_membership_id)
     from commercial.bill_lines where work_item_id = 'b1620620-0000-4000-8000-000000000001'));
select pg_temp.check_case('8 what is due drops by the line', '430000/70000/part_paid',
  (select format('%s/%s/%s', total_kobo, due_kobo, status) from commercial.bills where id = pg_temp.bill_of(1)));
select pg_temp.check_case('8 a work item whose line came off has no badge', '0',
  (select count(*)::text from (select pg_temp.as_member(3)) s,
     commercial.work_item_bills('pharmacy', array['b1620620-0000-4000-8000-000000000001'::uuid])));
-- An own lab work item: a line for the priced test; the collection gate.
do $$ begin
  perform pg_temp.as_member(8, 'direct-care');
  insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id, source_ehr_order_version,
    source_encounter_id, status, priority, test_code_system, test_code, test_name, requested_by, requested_at, accepted_by,
    accepted_by_membership_id, accepted_at, idempotency_key, request_sha256, correlation_id)
  values ('b1620650-0000-4000-8000-000000000001', pg_temp.patient(1), 'b1620000-0000-4000-8000-000000000002',
    'b1620000-0000-4000-8000-000000000002', 'b1620630-0000-4000-8000-000000000001', 1,
    'b1620600-0000-4000-8000-000000000001', 'accepted', 'routine', 'HID-LAB', 'LAB-FBC', 'Full blood count',
    'b1620100-0000-4000-8000-000000000004', clock_timestamp(), 'b1620100-0000-4000-8000-000000000008', pg_temp.member(8),
    clock_timestamp(), 'billing-lab-key-000001', repeat('0', 64), 'billing-suite-correlation');
end $$;
select pg_temp.check_case('8 the own lab work item is on the visit bill', 'lab/1/300000/t',
  (select format('%s/%s/%s/%s', origin, quantity, total_kobo, bill_id = pg_temp.bill_of(1)) from commercial.bill_lines
    where work_item_id = 'b1620650-0000-4000-8000-000000000001'));
set local session_replication_role = replica;
insert into lab.accessions (id, accession_number, work_item_id, patient_id, facility_id, status, priority, created_by,
  created_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('b1620660-0000-4000-8000-000000000001', 'ACC-BILL-1', 'b1620650-0000-4000-8000-000000000001', pg_temp.patient(1),
  'b1620000-0000-4000-8000-000000000002', 'accessioned', 'routine', 'b1620100-0000-4000-8000-000000000008',
  pg_temp.member(8), 'billing-accession-0001', repeat('0', 64), 'billing-suite-correlation');
insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
values ('b1620670-0000-4000-8000-000000000001', 'b1620660-0000-4000-8000-000000000001', pg_temp.patient(1),
  'b1620000-0000-4000-8000-000000000002', 1, 'blood');
insert into lab.specimens (id, specimen_identifier, requirement_id, accession_id, patient_id, facility_id, collection_ordinal,
  specimen_type, status)
values ('b1620680-0000-4000-8000-000000000001', 'SPEC-BILL-1', 'b1620670-0000-4000-8000-000000000001',
  'b1620660-0000-4000-8000-000000000001', pg_temp.patient(1), 'b1620000-0000-4000-8000-000000000002', 1, 'blood', 'required');
set local session_replication_role = origin;
do $$
declare
  answer text;
begin
  perform pg_temp.as_member(8, 'direct-care');
  begin
    update lab.specimens set status = 'collected', collected_at = clock_timestamp(),
      collected_by = 'b1620100-0000-4000-8000-000000000008', collected_by_membership_id = pg_temp.member(8)
     where id = 'b1620680-0000-4000-8000-000000000001';
    answer := 'collected';
  exception when others then
    answer := sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.check_case('8 pay-before for lab refuses collection on an unpaid bill', 'HB409 PAYMENT_REQUIRED', answer);
end $$;
-- p1's third prescription (2 capsules) is accepted, the bill is paid in full, the medicine dispensed and then reversed:
-- the paid line cannot come off, so it stays, marked reversed, for billing staff to refund.
do $$ begin
  perform pg_temp.as_member(3, 'direct-care');
  insert into pharmacy.work_item_acceptances (work_item_id, patient_id, facility_id, accepted_by, accepted_by_membership_id,
    accepted_with, idempotency_key, request_sha256, correlation_id)
  values ('b1620620-0000-4000-8000-000000000003', pg_temp.patient(1), 'b1620000-0000-4000-8000-000000000002',
    'b1620100-0000-4000-8000-000000000003', pg_temp.member(3), 'accept', 'billing-accept-key-0003', repeat('0', 64),
    'billing-suite-correlation');
end $$;
select pg_temp.check_case('8 the third prescription''s line', 'pharmacy/2/30000',
  (select format('%s/%s/%s', origin, quantity, total_kobo) from commercial.bill_lines
    where work_item_id = 'b1620620-0000-4000-8000-000000000003'));
select pg_temp.check_case('8 the pharmacist takes what is due on p1''s bill', 'ok',
  pg_temp.ehr('p1paid', 3, format($s$select commercial.payment_record('%s', '{"method":"cash","amountKobo":%s}', null, 'kbillingpay0000000015', repeat('f', 64))$s$,
    pg_temp.bill_of(1), (select due_kobo from commercial.bills where id = pg_temp.bill_of(1)))));
do $$ begin
  perform pg_temp.as_member(3, 'direct-care');
  insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id, medication_code_system,
    medication_code, medication_display, quantity_dispensed, quantity_unit, status, dispensed_by, dispensed_by_membership_id,
    reason, idempotency_key, request_sha256, correlation_id)
  values ('b1620640-0000-4000-8000-000000000003', 'b1620620-0000-4000-8000-000000000003', 1, pg_temp.patient(1),
    'b1620000-0000-4000-8000-000000000002', 'HID-MED', 'MED-00042', 'Amoxicillin 500 mg capsule', 2, 'capsule', 'dispensed',
    'b1620100-0000-4000-8000-000000000003', pg_temp.member(3), 'Dispensed as prescribed', 'billing-dispense-key-05',
    repeat('0', 64), 'billing-suite-correlation');
  insert into pharmacy.dispensing_reversals (dispensing_id, dispensing_version, work_item_id, patient_id, facility_id,
    status, reversed_by, reversed_by_membership_id, reason, idempotency_key, request_sha256, correlation_id)
  values ('b1620640-0000-4000-8000-000000000003', 1, 'b1620620-0000-4000-8000-000000000003', pg_temp.patient(1),
    'b1620000-0000-4000-8000-000000000002', 'reversed', 'b1620100-0000-4000-8000-000000000003', pg_temp.member(3),
    'Wrong strength picked', 'billing-reverse-key-003', repeat('0', 64), 'billing-suite-correlation');
end $$;
select pg_temp.check_case('8 the paid line stays on the paid bill, marked reversed', 'f/t/paid',
  (select format('%s/%s/%s', line.cancelled, line.dispensing_reversed_at is not null, bill.status)
     from commercial.bill_lines line join commercial.bills bill on bill.id = line.bill_id
    where line.work_item_id = 'b1620620-0000-4000-8000-000000000003'));
select pg_temp.check_case('8 the bill shows billing staff the line was reversed', 'true',
  (select line->>'dispensingReversed' from jsonb_array_elements(commercial.bill_json(pg_temp.bill_of(1))->'lines') line
    where line->>'workItemId' = 'b1620620-0000-4000-8000-000000000003'));
select pg_temp.check_case('8 so does the work item''s badge', 'true/paid',
  (select format('%s/%s', bill->>'dispensingReversed', bill->>'status') from (select pg_temp.as_member(3)) s,
     commercial.work_item_bills('pharmacy', array['b1620620-0000-4000-8000-000000000003'::uuid])));
select pg_temp.check_case('8 the bill''s log has both reversals', 'dispensing-reversed:1,line-cancel:1',
  (select string_agg(kind || ':' || count, ',' order by kind) from (
     select kind, count(*) from commercial.bill_events where bill_id = pg_temp.bill_of(1)
        and (details->>'dispensingReversed')::boolean group by kind) counted));
select pg_temp.check_case('8 the second reversal moves no stock either', 'LATE:4',
  (select string_agg(batch_number || ':' || on_hand, ',' order by batch_number) from pharmacy.stock_batches
    where facility_id = 'b1620000-0000-4000-8000-000000000002' and catalogue_item_id = (pg_temp.ids('amox'))::uuid
      and on_hand > 0));
-- A facility with no settings: a dispensing-like hook and a lab line do nothing (facility B check-in made no bill above).
select pg_temp.check_case('8 hooks are silent for another facility''s session', 'true',
  (select (not commercial.hook_facility('b1620000-0000-4000-8000-000000000012'))::text
     from (select pg_temp.as_member(1)) s));
select pg_temp.check_case('8 every bill''s totals agree at the end', '0', pg_temp.agree());

-- 9. Audit.
select pg_temp.check_case('9 money audit rows', 'true',
  (select (count(*) filter (where action = 'commercial.payment.record') >= 5
       and count(*) filter (where action = 'commercial.payment.confirm') = 1
       and count(*) filter (where action = 'commercial.payment.void') = 1
       and count(*) filter (where action = 'commercial.hmo-cover.record') = 1)::text
     from audit.events where facility_id = 'b1620000-0000-4000-8000-000000000002'));
select pg_temp.check_case('9 an automatic line is audited with its origin', 'true',
  (select exists (select 1 from audit.events where action = 'commercial.bill.line-add' and details->>'origin' = 'pharmacy'
                   and facility_id = 'b1620000-0000-4000-8000-000000000002')::text));
select pg_temp.check_case('9 no name, Health ID, reference, approval code or reason text in any billing audit row', '0',
  (select count(*)::text from audit.events
    where (action like 'commercial.%' or action like 'pharmacy.stock%' or action like 'pharmacy.sale%')
      and (details::text ~* 'billone|billsix|amaka|HID-BL|123456789012|TRF-0001|APP-778|hardship|wrong amount|fictional supplies|walk-in|dr test'
           or coalesce(reason, '') <> '')));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.b_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0162-0167 patient billing:\n%', mismatch;
  end if;
  raise notice '0162-0167 patient billing: % cases passed', (select count(*) from pg_temp.b_outcomes);
end $$;

rollback;
