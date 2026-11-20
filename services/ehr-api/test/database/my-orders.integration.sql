\set ON_ERROR_STOP on
-- 0143 (MY-1): "Ordered by me". Rollback-only. Synthetic values only; uuid
-- prefix f143; .invalid addresses.
--   1. structure: the function (SECURITY DEFINER, search_path pg_catalog,
--      pg_temp; EXECUTE for the EHR runtime only) and the two indexes;
--   2. as the EHR API runtime, a doctor at F1: the reach (open of any age,
--      ended since the day given, never entered in error, never another
--      member's or another facility's), the access rule (a patient with no
--      grant is counted, never shown), kinds, open only, newest first,
--      keyset paging, the card, the audit rows; and the refusals (no
--      session, another purpose, a date over 2 years back, a half cursor, a
--      kind without its read permission).
set plpgsql.variable_conflict = error;
begin;

insert into identity.organizations (id, name, slug, active) values
  ('f1430000-0000-4000-8000-0000000000a1', 'My Orders Org', 'my-orders-org-f143', true);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f1431000-0000-4000-8000-0000000000f1', 'f1430000-0000-4000-8000-0000000000a1', 'My Orders Alpha', 'MOF-F1', 'Africa/Lagos', true, 'verified'),
  ('f1431000-0000-4000-8000-0000000000f2', 'f1430000-0000-4000-8000-0000000000a1', 'My Orders Beta', 'MOF-F2', 'Africa/Lagos', true, 'verified');
-- D: a doctor at F1 and F2. E: another doctor at F1. H: a pharmacist at F1.
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm, token_version) values
  ('f1432000-0000-4000-8000-00000000000d', 'synthetic:my-orders-0143:d', 'd@my-orders-0143.invalid', 'active', 'synthetic-hash', 'argon2id', 1),
  ('f1432000-0000-4000-8000-00000000000e', 'synthetic:my-orders-0143:e', 'e@my-orders-0143.invalid', 'active', 'synthetic-hash', 'argon2id', 1),
  ('f1432000-0000-4000-8000-0000000000a8', 'synthetic:my-orders-0143:h', 'h@my-orders-0143.invalid', 'active', 'synthetic-hash', 'argon2id', 1);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values
  ('f1434000-0000-4000-8000-00000000000d', 'f1432000-0000-4000-8000-00000000000d', 'Doctor D', 'd@my-orders-0143.invalid', 'verified', 'doctor', true),
  ('f1434000-0000-4000-8000-00000000000e', 'f1432000-0000-4000-8000-00000000000e', 'Doctor E', 'e@my-orders-0143.invalid', 'verified', 'doctor', true),
  ('f1434000-0000-4000-8000-0000000000a8', 'f1432000-0000-4000-8000-0000000000a8', 'Pharmacist H', 'h@my-orders-0143.invalid', 'verified', 'pharmacist', true);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active) values
  ('f1435000-0000-4000-8000-0000000000d1', 'f1434000-0000-4000-8000-00000000000d', 'f1432000-0000-4000-8000-00000000000d',
   'f1430000-0000-4000-8000-0000000000a1', 'f1431000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true),
  ('f1435000-0000-4000-8000-0000000000d2', 'f1434000-0000-4000-8000-00000000000d', 'f1432000-0000-4000-8000-00000000000d',
   'f1430000-0000-4000-8000-0000000000a1', 'f1431000-0000-4000-8000-0000000000f2', 'doctor', 'doctor', false, true),
  ('f1435000-0000-4000-8000-0000000000e1', 'f1434000-0000-4000-8000-00000000000e', 'f1432000-0000-4000-8000-00000000000e',
   'f1430000-0000-4000-8000-0000000000a1', 'f1431000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true),
  ('f1435000-0000-4000-8000-0000000000a8', 'f1434000-0000-4000-8000-0000000000a8', 'f1432000-0000-4000-8000-0000000000a8',
   'f1430000-0000-4000-8000-0000000000a1', 'f1431000-0000-4000-8000-0000000000f1', 'pharmacist', 'pharmacist', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), fixture.account::uuid, fixture.role_code, 'facility', fixture.membership::uuid, fixture.facility::uuid, 'Synthetic 0143 role'
  from (values
    ('f1432000-0000-4000-8000-00000000000d', 'doctor', 'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1'),
    ('f1432000-0000-4000-8000-00000000000d', 'doctor', 'f1435000-0000-4000-8000-0000000000d2', 'f1431000-0000-4000-8000-0000000000f2'),
    ('f1432000-0000-4000-8000-00000000000e', 'doctor', 'f1435000-0000-4000-8000-0000000000e1', 'f1431000-0000-4000-8000-0000000000f1'),
    ('f1432000-0000-4000-8000-0000000000a8', 'pharmacist', 'f1435000-0000-4000-8000-0000000000a8', 'f1431000-0000-4000-8000-0000000000f1')
  ) fixture(account, role_code, membership, facility);
-- P1: D may read at F1 (a consent grant). P2: D's grant ended after the order was written.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status) values
  ('f1437000-0000-4000-8000-000000000001', 'HID-QMA2B3', 'Ada', 'Orders', 'Ada Orders', '1984-04-04', 'female', 'active'),
  ('f1437000-0000-4000-8000-000000000002', 'HID-QMC4D5', 'Bode', 'Orders', 'Bode Orders', '1979-07-07', 'male', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id) values
  ('f143b000-0000-4000-8000-000000000001', 'f1437000-0000-4000-8000-000000000001',
   'f1434000-0000-4000-8000-00000000000d', 'f1432000-0000-4000-8000-00000000000d',
   'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1',
   'write_records', 'direct-care', 'active', 'Synthetic my orders grant', now() - interval '1 minute',
   now() + interval '1 hour', false, 'my-orders-0143-grant'),
  ('f143b000-0000-4000-8000-000000000002', 'f1437000-0000-4000-8000-000000000002',
   'f1434000-0000-4000-8000-00000000000d', 'f1432000-0000-4000-8000-00000000000d',
   'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1',
   'write_records', 'direct-care', 'active', 'Synthetic grant that ends', now() - interval '1 minute',
   now() + interval '1 hour', false, 'my-orders-0143-grant-ended'),
  ('f143b000-0000-4000-8000-000000000003', 'f1437000-0000-4000-8000-000000000001',
   'f1434000-0000-4000-8000-00000000000e', 'f1432000-0000-4000-8000-00000000000e',
   'f1435000-0000-4000-8000-0000000000e1', 'f1431000-0000-4000-8000-0000000000f1',
   'write_records', 'direct-care', 'active', 'Synthetic grant for E', now() - interval '1 minute',
   now() + interval '1 hour', false, 'my-orders-0143-grant-e'),
  ('f143b000-0000-4000-8000-000000000004', 'f1437000-0000-4000-8000-000000000001',
   'f1434000-0000-4000-8000-00000000000d', 'f1432000-0000-4000-8000-00000000000d',
   'f1435000-0000-4000-8000-0000000000d2', 'f1431000-0000-4000-8000-0000000000f2',
   'write_records', 'direct-care', 'active', 'Synthetic grant for D at F2', now() - interval '1 minute',
   now() + interval '1 hour', false, 'my-orders-0143-grant-f2');

-- The orders, written as each creator (the version trigger asks for the creator's context).
create function pg_temp.as_member(subject text, membership uuid, facility uuid) returns void language sql as $f$
  select set_config('app.actor_subject', subject, true), set_config('app.membership_id', membership::text, true),
    set_config('app.facility_id', facility::text, true), set_config('app.purpose_of_use', 'direct-care', true),
    set_config('app.correlation_id', 'my-orders-0143-fixture', true);
$f$;
select pg_temp.as_member('synthetic:my-orders-0143:d', 'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status, started_at) values
  ('f1438000-0000-4000-8000-000000000001', 'f1437000-0000-4000-8000-000000000001', 'f1431000-0000-4000-8000-0000000000f1',
   'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d1', 'ambulatory', 'in_progress', now() - interval '500 days'),
  ('f1438000-0000-4000-8000-000000000002', 'f1437000-0000-4000-8000-000000000002', 'f1431000-0000-4000-8000-0000000000f1',
   'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d1', 'ambulatory', 'in_progress', now() - interval '1 day');
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status, created_at)
select fixture.id::uuid, fixture.encounter::uuid, fixture.patient::uuid, 'f1431000-0000-4000-8000-0000000000f1',
  'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d1', fixture.display, 'Twice a day',
  'Synthetic instructions', fixture.status, now() - fixture.age
  from (values
    ('f1439000-0000-4000-8000-0000000000a1', 'f1438000-0000-4000-8000-000000000001', 'f1437000-0000-4000-8000-000000000001',
     'Synthetic amoxicillin', 'active', interval '1 hour'),
    ('f1439000-0000-4000-8000-0000000000a2', 'f1438000-0000-4000-8000-000000000001', 'f1437000-0000-4000-8000-000000000001',
     'Synthetic withdrawn', 'entered_in_error', interval '2 hours'),
    ('f1439000-0000-4000-8000-0000000000a3', 'f1438000-0000-4000-8000-000000000002', 'f1437000-0000-4000-8000-000000000002',
     'Synthetic hidden', 'active', interval '3 hours')
  ) fixture(id, encounter, patient, display, status, age);
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, created_at)
select fixture.id::uuid, 'f1438000-0000-4000-8000-000000000001', 'f1437000-0000-4000-8000-000000000001',
  'f1431000-0000-4000-8000-0000000000f1', 'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d1',
  'http://loinc.org', fixture.code, fixture.display, 'urgent', fixture.status, now() - fixture.age
  from (values
    ('f1439000-0000-4000-8000-0000000000b1', '58410-2', 'Synthetic blood count', 'completed', interval '10 days'),
    ('f1439000-0000-4000-8000-0000000000b2', '2345-7', 'Synthetic glucose (old)', 'completed', interval '200 days'),
    ('f1439000-0000-4000-8000-0000000000b3', '718-7', 'Synthetic draft (older)', 'draft', interval '400 days')
  ) fixture(id, code, display, status, age);
-- P2's grant ends: D's order for P2 stays D's, but D may no longer read P2.
update identity.consent_grants set status = 'revoked', revoked_at = now(), revoked_reason = 'Synthetic end'
 where id = 'f143b000-0000-4000-8000-000000000002';
-- Not D's at F1: E's order for P1, and D's own order at F2.
select pg_temp.as_member('synthetic:my-orders-0143:e', 'f1435000-0000-4000-8000-0000000000e1', 'f1431000-0000-4000-8000-0000000000f1');
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status)
values ('f1439000-0000-4000-8000-0000000000e1', 'f1438000-0000-4000-8000-000000000001', 'f1437000-0000-4000-8000-000000000001',
  'f1431000-0000-4000-8000-0000000000f1', 'f1432000-0000-4000-8000-00000000000e', 'f1435000-0000-4000-8000-0000000000e1',
  'Synthetic by another member', 'Daily', 'Synthetic instructions', 'active');
select pg_temp.as_member('synthetic:my-orders-0143:d', 'f1435000-0000-4000-8000-0000000000d2', 'f1431000-0000-4000-8000-0000000000f2');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status, started_at) values
  ('f1438000-0000-4000-8000-000000000003', 'f1437000-0000-4000-8000-000000000001', 'f1431000-0000-4000-8000-0000000000f2',
   'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d2', 'ambulatory', 'in_progress', now());
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status)
values ('f1439000-0000-4000-8000-0000000000f2', 'f1438000-0000-4000-8000-000000000003', 'f1437000-0000-4000-8000-000000000001',
  'f1431000-0000-4000-8000-0000000000f2', 'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d2',
  'Synthetic at another facility', 'Daily', 'Synthetic instructions', 'active');

create temporary table order_outcomes (seq serial, name text primary key, expected text not null, actual text) on commit drop;
grant select, insert on pg_temp.order_outcomes to hid_ehr_api_runtime;
grant usage on sequence pg_temp.order_outcomes_seq_seq to hid_ehr_api_runtime;
create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.order_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
-- One call: the listed order ids (newest first), hidden_count and has_more; or the SQLSTATE and message.
create function pg_temp.mine(kinds text[], open_only boolean, since date, cursor_at timestamptz default null,
  cursor_kind text default null, cursor_id uuid default null, page integer default 25) returns text language plpgsql as $f$
declare
  listed text;
  hidden bigint;
  more boolean;
begin
  select string_agg(right(listed_row.order_id::text, 2), ',' order by listed_row.ordinality),
         max(listed_row.hidden_count), bool_or(listed_row.has_more)
    into listed, hidden, more
    from ehr.list_my_orders(kinds, open_only, since, cursor_at, cursor_kind, cursor_id, page) with ordinality listed_row;
  return format('%s|hidden %s|more %s', coalesce(listed, '-'), coalesce(hidden::text, '-'), coalesce(more::text, '-'));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

-- 1. Structure.
select pg_temp.check_case('1 the function', 't/{"search_path=pg_catalog, pg_temp"}',
  (select format('%s/%s', prosecdef, proconfig) from pg_proc
    where oid = 'ehr.list_my_orders(text[],boolean,date,timestamp with time zone,text,uuid,integer)'::regprocedure));
select pg_temp.check_case('1 only the EHR runtime may run it', 'hid_ehr_runtime',
  (select string_agg(grantee::regrole::text, ',') from pg_proc, aclexplode(proacl)
    where oid = 'ehr.list_my_orders(text[],boolean,date,timestamp with time zone,text,uuid,integer)'::regprocedure
      and privilege_type = 'EXECUTE' and grantee <> proowner));
select pg_temp.check_case('1 the indexes',
  'CREATE INDEX lab_requests_my_orders_idx ON ehr.lab_requests USING btree (facility_id, created_by_membership_id, created_at DESC, id DESC)|'
  || 'CREATE INDEX prescriptions_my_orders_idx ON ehr.prescriptions USING btree (facility_id, created_by_membership_id, created_at DESC, id DESC)',
  (select string_agg(pg_get_indexdef(indexrelid), '|' order by indexrelid::regclass::text) from pg_index
    where indexrelid in ('ehr.prescriptions_my_orders_idx'::regclass, 'ehr.lab_requests_my_orders_idx'::regclass)));

-- 2. As the EHR API runtime.
select pg_temp.as_member('synthetic:my-orders-0143:d', 'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1');
select set_config('app.correlation_id', 'my-orders-0143-list', true);
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 the default reach: open of any age, ended in 90 days; P2''s order counted, not shown',
  'a1,b1,b3|hidden 1|more false',
  pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90)));
select pg_temp.check_case('2 the card, the display, the status and the priority',
  'prescription/Ada Orders/female/1984-04-04/A2B3/Synthetic amoxicillin/active/-|lab_request/Ada Orders/female/1984-04-04/A2B3/Synthetic blood count/completed/urgent',
  (select string_agg(format('%s/%s/%s/%s/%s/%s/%s/%s', listed.kind, listed.full_name, listed.sex, listed.date_of_birth,
       listed.health_id_last4, listed.display, listed.status, coalesce(listed.priority, '-')), '|' order by listed.created_at desc)
     from ehr.list_my_orders(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90),
       null, null, null, 2) listed));
select pg_temp.check_case('2 looking back further reaches the older ended order', 'a1,b1,b2,b3|hidden 1|more false',
  pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 700)));
select pg_temp.check_case('2 open only', 'a1,b3|hidden 1|more false',
  pg_temp.mine(array['lab_request', 'prescription'], true, ((now() at time zone 'Africa/Lagos')::date - 90)));
select pg_temp.check_case('2 lab only (nothing of it is hidden)', 'b1,b3|hidden 0|more false',
  pg_temp.mine(array['lab_request'], false, ((now() at time zone 'Africa/Lagos')::date - 90)));
select pg_temp.check_case('2 the runtime itself still cannot read the hidden order (the owner''s policy is the owner''s)', '0',
  (select count(*)::text from ehr.prescriptions where id = 'f1439000-0000-4000-8000-0000000000a3'));
select pg_temp.check_case('2 a page of one says there is more', 'a1|hidden 1|more true',
  pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90), page => 1));
select pg_temp.check_case('2 the next page starts after the cursor', 'b1|hidden 1|more true',
  (select pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90),
     prescription.created_at, 'prescription', prescription.id, 1)
     from (select created_at, order_id as id from ehr.list_my_orders(array['lab_request', 'prescription'], false,
       ((now() at time zone 'Africa/Lagos')::date - 90), null, null, null, 1)) prescription));
reset role;
select pg_temp.check_case('2 each list call is audited once, with one shown row per patient shown', '8/8/f1437000-0000-4000-8000-000000000001',
  (select format('%s/%s/%s', count(*) filter (where action = 'ehr.my-orders.list'),
       count(*) filter (where action = 'ehr.my-orders.list.shown'),
       string_agg(distinct patient_id::text, ','))
     from audit.events where correlation_id = 'my-orders-0143-list'));
select pg_temp.check_case('2 the list row says what was hidden, never naming it', '1/["f1437000-0000-4000-8000-000000000001"]',
  (select format('%s/%s', details->>'hiddenCount', details->'patientIds') from audit.events
    where correlation_id = 'my-orders-0143-list' and action = 'ehr.my-orders.list' and details->>'openOnly' = 'true'));
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 an empty page still says what is hidden', '-|hidden 1|more false',
  pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90),
    timestamptz '2000-01-01 00:00:00+00', 'lab_request', 'f1439000-0000-4000-8000-000000000000'));
select pg_temp.check_case('2 more than 2 years back', '22023 MY_ORDERS_SINCE_TOO_OLD',
  pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 731)));
select pg_temp.check_case('2 a date in the future', '22023 MY_ORDERS_SINCE_TOO_OLD',
  pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date + 1)));
select pg_temp.check_case('2 half a cursor', '22023 MY_ORDERS_CURSOR_INVALID',
  pg_temp.mine(array['prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90), now(), null, null));
select pg_temp.check_case('2 an unknown kind', '42501 MY_ORDERS_NOT_PERMITTED',
  pg_temp.mine(array['visit'], false, ((now() at time zone 'Africa/Lagos')::date - 90)));
select set_config('app.purpose_of_use', 'emergency', true);
select pg_temp.check_case('2 not for direct care', '22023 MY_ORDERS_DIRECT_CARE_ONLY',
  pg_temp.mine(array['prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90)));
reset role;
select pg_temp.as_member('synthetic:my-orders-0143:h', 'f1435000-0000-4000-8000-0000000000a8', 'f1431000-0000-4000-8000-0000000000f1');
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 a pharmacist without lab-request read', '42501 MY_ORDERS_NOT_PERMITTED',
  pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90)));
select pg_temp.check_case('2 a pharmacist''s own prescriptions (none)', '-|hidden 0|more false',
  pg_temp.mine(array['prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90)));
select set_config('app.membership_id', '', true);
select pg_temp.check_case('2 no session membership', '42501 MY_ORDERS_NOT_PERMITTED',
  pg_temp.mine(array['prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90)));
reset role;

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.order_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0143 my orders:\n%', mismatch;
  end if;
  raise notice '0143 my orders: % cases passed', (select count(*) from pg_temp.order_outcomes);
end $$;

rollback;
