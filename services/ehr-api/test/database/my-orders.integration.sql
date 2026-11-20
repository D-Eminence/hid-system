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
--      kind without its read permission); an empty first page still counts;
--   3. the access rule's edges: a break-glass-only patient is counted, never
--      listed; 0131's own-facility opening lists;
--   4. outside the list, owner-run reads are as before 0143 (0133's D7 and
--      D8, and a read by id as the tables' owner);
--   5. the bounds: 1,000 patients asked per page, the resume position, the
--      first page's count capped and marked not complete.
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
select pg_temp.check_case('2 the next page starts after the cursor (only the first page counts)', 'b1|hidden -|more true',
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
select pg_temp.check_case('2 an empty later page: no count, nothing more', '-|hidden -|more false',
  pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90),
    timestamptz '2000-01-01 00:00:00+00', 'lab_request', 'f1439000-0000-4000-8000-000000000000'));
reset role;
savepoint empty_first_page;
update identity.consent_grants set status = 'revoked', revoked_at = now(), revoked_reason = 'Synthetic pause'
 where id = 'f143b000-0000-4000-8000-000000000001';
select set_config('app.correlation_id', 'my-orders-0143-empty-first', true);
set local role hid_ehr_api_runtime;
select pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90))
  as empty_first_page \gset
reset role;
rollback to savepoint empty_first_page;
select pg_temp.check_case('2 an empty first page still counts what is hidden', '-|hidden 4|more false', :'empty_first_page');
select set_config('app.correlation_id', 'my-orders-0143-list', true);
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 more than 2 years back', '22023 MY_ORDERS_SINCE_TOO_OLD',
  pg_temp.mine(array['lab_request', 'prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 731)));
select pg_temp.check_case('2 a date in the future has its own refusal', '22023 MY_ORDERS_SINCE_INVALID',
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

-- 3. The access rule's edges: an active break-glass grant never lists a
-- patient (it is for emergency only); 0131's own-facility opening does.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status) values
  ('f1437000-0000-4000-8000-000000000003', 'HID-QMF6G7', 'Chidi', 'Orders', 'Chidi Orders', '1990-01-01', 'male', 'active'),
  ('f1437000-0000-4000-8000-000000000004', 'HID-QMH8J9', 'Dupe', 'Orders', 'Dupe Orders', '1991-02-02', 'female', 'active');
-- P3's order is written under a direct-care grant that then ends (the
-- version trigger asks for write access); only a break-glass grant remains.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, authorization_method) values
  ('f143b000-0000-4000-8000-000000000007', 'f1437000-0000-4000-8000-000000000003',
   'f1434000-0000-4000-8000-00000000000d', 'f1432000-0000-4000-8000-00000000000d',
   'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1',
   'write_records', 'direct-care', 'active', 'Synthetic grant that ends', now() - interval '1 minute',
   now() + interval '1 hour', false, 'my-orders-0143-grant-p3', null),
  ('f143b000-0000-4000-8000-000000000006', 'f1437000-0000-4000-8000-000000000004',
   'f1434000-0000-4000-8000-00000000000d', 'f1432000-0000-4000-8000-00000000000d',
   'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1',
   'write_records', 'direct-care', 'active', 'Synthetic own-facility opening', now() - interval '1 minute',
   now() + interval '1 hour', false, 'my-orders-0143-grant-own', 'own_facility');
select pg_temp.as_member('synthetic:my-orders-0143:d', 'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status, started_at) values
  ('f1438000-0000-4000-8000-000000000004', 'f1437000-0000-4000-8000-000000000003', 'f1431000-0000-4000-8000-0000000000f1',
   'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d1', 'ambulatory', 'in_progress', now() - interval '1 day'),
  ('f1438000-0000-4000-8000-000000000005', 'f1437000-0000-4000-8000-000000000004', 'f1431000-0000-4000-8000-0000000000f1',
   'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d1', 'ambulatory', 'in_progress', now() - interval '1 day');
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status, created_at) values
  ('f1439000-0000-4000-8000-0000000000c3', 'f1438000-0000-4000-8000-000000000004', 'f1437000-0000-4000-8000-000000000003',
   'f1431000-0000-4000-8000-0000000000f1', 'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d1',
   'Synthetic break-glass patient', 'Daily', 'Synthetic instructions', 'active', now() - interval '5 minutes'),
  ('f1439000-0000-4000-8000-0000000000c4', 'f1438000-0000-4000-8000-000000000005', 'f1437000-0000-4000-8000-000000000004',
   'f1431000-0000-4000-8000-0000000000f1', 'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d1',
   'Synthetic own-facility patient', 'Daily', 'Synthetic instructions', 'active', now() - interval '6 minutes');
update identity.consent_grants set status = 'revoked', revoked_at = now(), revoked_reason = 'Synthetic end'
 where id = 'f143b000-0000-4000-8000-000000000007';
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id) values
  ('f143b000-0000-4000-8000-000000000005', 'f1437000-0000-4000-8000-000000000003',
   'f1434000-0000-4000-8000-00000000000d', 'f1432000-0000-4000-8000-00000000000d',
   'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1',
   'break_glass', 'emergency', 'active', 'Synthetic break-glass only', now() - interval '1 minute',
   now() + interval '1 hour', true, 'my-orders-0143-grant-bg');
select set_config('app.correlation_id', 'my-orders-0143-edges', true);
set local role hid_ehr_api_runtime;
select pg_temp.check_case('3 a break-glass-only patient is counted, never listed; an own-facility opening lists',
  'c4,a1|hidden 2|more false',
  pg_temp.mine(array['prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90)));
reset role;

-- 4. Outside the list, owner-run reads see what they saw before 0143: 0133's
-- own-pharmacy send (D7) and withdrawal (D8) for D's own prescription of a
-- patient D may no longer read, and any read of the tables' owner by id.
create function pg_temp.owner_reads(prescription uuid) returns bigint language sql security definer
  set search_path = pg_catalog, pg_temp as $f$ select count(*) from ehr.prescriptions where id = prescription $f$;
do $$
begin
  execute format('alter function pg_temp.owner_reads(uuid) owner to %I',
    (select relowner::regrole::text from pg_class where oid = 'ehr.prescriptions'::regclass));
end $$;
grant execute on function pg_temp.owner_reads(uuid) to hid_ehr_api_runtime;
create function pg_temp.answer(statement text) returns text language plpgsql as $f$
declare
  result text;
begin
  execute statement into result;
  return coalesce(result, '(null)');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select set_config('app.correlation_id', 'my-orders-0143-owner-reads', true);
set local role hid_ehr_api_runtime;
select pg_temp.check_case('4 0133 D7 still answers not_found for a prescription the session cannot read', '(not_found,)',
  pg_temp.answer($q$select send::text from ehr.send_prescription_to_own_pharmacy('f1439000-0000-4000-8000-0000000000a3', 1) send$q$));
select pg_temp.check_case('4 0133 D8 still finds nothing to withdraw', 'false',
  pg_temp.answer($q$select ehr.withdraw_own_pharmacy_send('f1439000-0000-4000-8000-0000000000a3')::text$q$));
select pg_temp.check_case('4 an owner-run read by id: the hidden prescription unseen, the readable one seen', '0/1',
  (select format('%s/%s', pg_temp.owner_reads('f1439000-0000-4000-8000-0000000000a3'),
     pg_temp.owner_reads('f1439000-0000-4000-8000-0000000000a1'))));
select pg_temp.check_case('4 no marker is left behind', '0',
  (select count(*)::text from ehr.list_my_orders(array['prescription'], false,
     ((now() at time zone 'Africa/Lagos')::date - 90), null, null, null, 1) listed
    where pg_temp.owner_reads('f1439000-0000-4000-8000-0000000000a3') > 0));
reset role;

-- 5. The bounds: 2,100 more patients D may not read, each with one active
-- prescription newer than everything above. The first page asks 1,000
-- patients, lists none and resumes after the last row read; it counts 2,000
-- hidden orders and says the count is not complete. Two more pages read the
-- rest and list the two readable ones.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status)
select ('f1437000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid,
       'HID-QMZZ' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (n / 1024) % 32 + 1, 1)
                  || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (n / 32) % 32 + 1, 1)
                  || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', n % 32 + 1, 1),
       'Bulk', 'Orders', 'Bulk Orders', '1980-01-01', 'unknown', 'active'
  from generate_series(1, 2100) n;
-- Written under direct-care grants that then end, as P2's.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id)
select ('f143b000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid, ('f1437000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid,
       'f1434000-0000-4000-8000-00000000000d', 'f1432000-0000-4000-8000-00000000000d',
       'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1',
       'write_records', 'direct-care', 'active', 'Synthetic bulk grant', now() - interval '1 minute',
       now() + interval '1 hour', false, 'my-orders-0143-grant-bulk'
  from generate_series(1, 2100) n;
select pg_temp.as_member('synthetic:my-orders-0143:d', 'f1435000-0000-4000-8000-0000000000d1', 'f1431000-0000-4000-8000-0000000000f1');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status, started_at)
select ('f1438000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid, ('f1437000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid,
       'f1431000-0000-4000-8000-0000000000f1', 'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d1',
       'ambulatory', 'in_progress', now() - interval '1 day'
  from generate_series(1, 2100) n;
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status, created_at)
select ('f1439000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid, ('f1438000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid,
       ('f1437000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid, 'f1431000-0000-4000-8000-0000000000f1',
       'f1432000-0000-4000-8000-00000000000d', 'f1435000-0000-4000-8000-0000000000d1', 'Synthetic bulk', 'Daily',
       'Synthetic instructions', 'active', now() - interval '1 minute' - n * interval '1 millisecond'
  from generate_series(1, 2100) n;
update identity.consent_grants set status = 'revoked', revoked_at = now(), revoked_reason = 'Synthetic end'
 where correlation_id = 'my-orders-0143-grant-bulk';
create temporary table bulk_pages (page integer primary key, listed text, hidden bigint, complete boolean,
  more boolean, resume_at timestamptz, resume_kind text, resume_id uuid) on commit drop;
grant select, insert on pg_temp.bulk_pages to hid_ehr_api_runtime;
create function pg_temp.bulk_page(page integer) returns void language plpgsql as $f$
declare
  previous record;
begin
  select * into previous from pg_temp.bulk_pages where bulk_pages.page = bulk_page.page - 1;
  insert into pg_temp.bulk_pages
  select bulk_page.page, coalesce(string_agg(right(listed.order_id::text, 2), ',' order by listed.ordinality), '-'),
         max(listed.hidden_count), bool_and(listed.hidden_count_complete), bool_or(listed.has_more),
         max(listed.resume_created_at), max(listed.resume_kind), max(listed.resume_id::text)::uuid
    from ehr.list_my_orders(array['prescription'], false, ((now() at time zone 'Africa/Lagos')::date - 90),
      previous.resume_at, previous.resume_kind, previous.resume_id, 25) with ordinality listed;
end
$f$;
select set_config('app.correlation_id', 'my-orders-0143-bounds', true);
set local role hid_ehr_api_runtime;
select pg_temp.bulk_page(1);
select pg_temp.bulk_page(2);
select pg_temp.bulk_page(3);
reset role;
select pg_temp.check_case('5 page 1: none listed, 2,000 counted, not complete, more, resumes after the 1,000th row',
  '-|2000|f|t|f1439000-0000-4000-8001-000000001000',
  (select format('%s|%s|%s|%s|%s', listed, hidden, complete, more, resume_id) from pg_temp.bulk_pages where page = 1));
select pg_temp.check_case('5 page 2: none listed, no count, more, resumes after the 2,000th row',
  '-|(null)|(null)|t|f1439000-0000-4000-8001-000000002000',
  (select format('%s|%s|%s|%s|%s', listed, coalesce(hidden::text, '(null)'), coalesce(complete::text, '(null)'), more, resume_id)
     from pg_temp.bulk_pages where page = 2));
select pg_temp.check_case('5 page 3: the last 100 hidden read, the two readable listed, nothing more', 'c4,a1|f',
  (select format('%s|%s', listed, more) from pg_temp.bulk_pages where page = 3));
select pg_temp.check_case('5 each call says how many patients it asked', '2000/1000/104',
  (select string_agg(details->>'patientsChecked', '/' order by sequence_id) from audit.events
    where correlation_id = 'my-orders-0143-bounds' and action = 'ehr.my-orders.list'));

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
