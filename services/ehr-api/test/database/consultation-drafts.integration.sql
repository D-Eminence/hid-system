\set ON_ERROR_STOP on
-- 0141 (EHR-C6): consultation drafts saved on the server. Rollback-only.
-- Synthetic values only; uuid prefix f141; .invalid addresses.
--   1. structure: forced row-level security and its six policies, the two
--      one-per uniqueness rules, the guard, the two functions (SECURITY
--      DEFINER, search_path pg_catalog, pg_temp), the grants;
--   2. as the EHR API runtime: the author writes, saves and discards; the
--      server sets the times, the size and the version; the one-per rules;
--      no move to another patient or visit; the size limit; another member,
--      the same doctor at another facility and an expired draft see
--      nothing; the author's list across patients (an ended grant is
--      counted, not shown) and its audit rows; the sweeper.
set plpgsql.variable_conflict = error;
begin;

insert into identity.organizations (id, name, slug, active) values
  ('f1410000-0000-4000-8000-0000000000a1', 'Drafts Org', 'drafts-org-f141', true);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f1411000-0000-4000-8000-0000000000f1', 'f1410000-0000-4000-8000-0000000000a1', 'Drafts Alpha', 'DRF-F1', 'Africa/Lagos', true, 'verified'),
  ('f1411000-0000-4000-8000-0000000000f2', 'f1410000-0000-4000-8000-0000000000a1', 'Drafts Beta', 'DRF-F2', 'Africa/Lagos', true, 'verified');
-- D: a doctor at F1 and F2. E: another doctor at F1. H: a pharmacist at F1.
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm, token_version) values
  ('f1412000-0000-4000-8000-00000000000d', 'synthetic:drafts-0141:d', 'd@drafts-0141.invalid', 'active', 'synthetic-hash', 'argon2id', 1),
  ('f1412000-0000-4000-8000-00000000000e', 'synthetic:drafts-0141:e', 'e@drafts-0141.invalid', 'active', 'synthetic-hash', 'argon2id', 1),
  ('f1412000-0000-4000-8000-0000000000a8', 'synthetic:drafts-0141:h', 'h@drafts-0141.invalid', 'active', 'synthetic-hash', 'argon2id', 1);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values
  ('f1414000-0000-4000-8000-00000000000d', 'f1412000-0000-4000-8000-00000000000d', 'Doctor D', 'd@drafts-0141.invalid', 'verified', 'doctor', true),
  ('f1414000-0000-4000-8000-00000000000e', 'f1412000-0000-4000-8000-00000000000e', 'Doctor E', 'e@drafts-0141.invalid', 'verified', 'doctor', true),
  ('f1414000-0000-4000-8000-0000000000a8', 'f1412000-0000-4000-8000-0000000000a8', 'Pharmacist H', 'h@drafts-0141.invalid', 'verified', 'pharmacist', true);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active) values
  ('f1415000-0000-4000-8000-0000000000d1', 'f1414000-0000-4000-8000-00000000000d', 'f1412000-0000-4000-8000-00000000000d',
   'f1410000-0000-4000-8000-0000000000a1', 'f1411000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true),
  ('f1415000-0000-4000-8000-0000000000d2', 'f1414000-0000-4000-8000-00000000000d', 'f1412000-0000-4000-8000-00000000000d',
   'f1410000-0000-4000-8000-0000000000a1', 'f1411000-0000-4000-8000-0000000000f2', 'doctor', 'doctor', false, true),
  ('f1415000-0000-4000-8000-0000000000e1', 'f1414000-0000-4000-8000-00000000000e', 'f1412000-0000-4000-8000-00000000000e',
   'f1410000-0000-4000-8000-0000000000a1', 'f1411000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true),
  ('f1415000-0000-4000-8000-0000000000a8', 'f1414000-0000-4000-8000-0000000000a8', 'f1412000-0000-4000-8000-0000000000a8',
   'f1410000-0000-4000-8000-0000000000a1', 'f1411000-0000-4000-8000-0000000000f1', 'pharmacist', 'pharmacist', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), fixture.account::uuid, fixture.role_code, 'facility', fixture.membership::uuid, fixture.facility::uuid, 'Synthetic 0141 role'
  from (values
    ('f1412000-0000-4000-8000-00000000000d', 'doctor', 'f1415000-0000-4000-8000-0000000000d1', 'f1411000-0000-4000-8000-0000000000f1'),
    ('f1412000-0000-4000-8000-00000000000d', 'doctor', 'f1415000-0000-4000-8000-0000000000d2', 'f1411000-0000-4000-8000-0000000000f2'),
    ('f1412000-0000-4000-8000-00000000000e', 'doctor', 'f1415000-0000-4000-8000-0000000000e1', 'f1411000-0000-4000-8000-0000000000f1'),
    ('f1412000-0000-4000-8000-0000000000a8', 'pharmacist', 'f1415000-0000-4000-8000-0000000000a8', 'f1411000-0000-4000-8000-0000000000f1')
  ) fixture(account, role_code, membership, facility);
-- P1: D may read at F1 (a consent grant). P2: D's grant ended after the order was written.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status) values
  ('f1417000-0000-4000-8000-000000000001', 'HID-QDA2B3', 'Ada', 'Orders', 'Ada Orders', '1984-04-04', 'female', 'active'),
  ('f1417000-0000-4000-8000-000000000002', 'HID-QDC4D5', 'Bode', 'Orders', 'Bode Orders', '1979-07-07', 'male', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id) values
  ('f141b000-0000-4000-8000-000000000001', 'f1417000-0000-4000-8000-000000000001',
   'f1414000-0000-4000-8000-00000000000d', 'f1412000-0000-4000-8000-00000000000d',
   'f1415000-0000-4000-8000-0000000000d1', 'f1411000-0000-4000-8000-0000000000f1',
   'write_records', 'direct-care', 'active', 'Synthetic drafts grant', now() - interval '1 minute',
   now() + interval '1 hour', false, 'drafts-0141-grant'),
  ('f141b000-0000-4000-8000-000000000002', 'f1417000-0000-4000-8000-000000000002',
   'f1414000-0000-4000-8000-00000000000d', 'f1412000-0000-4000-8000-00000000000d',
   'f1415000-0000-4000-8000-0000000000d1', 'f1411000-0000-4000-8000-0000000000f1',
   'write_records', 'direct-care', 'active', 'Synthetic grant that ends', now() - interval '1 minute',
   now() + interval '1 hour', false, 'drafts-0141-grant-ended'),
  ('f141b000-0000-4000-8000-000000000003', 'f1417000-0000-4000-8000-000000000001',
   'f1414000-0000-4000-8000-00000000000e', 'f1412000-0000-4000-8000-00000000000e',
   'f1415000-0000-4000-8000-0000000000e1', 'f1411000-0000-4000-8000-0000000000f1',
   'write_records', 'direct-care', 'active', 'Synthetic grant for E', now() - interval '1 minute',
   now() + interval '1 hour', false, 'drafts-0141-grant-e'),
  ('f141b000-0000-4000-8000-000000000004', 'f1417000-0000-4000-8000-000000000001',
   'f1414000-0000-4000-8000-00000000000d', 'f1412000-0000-4000-8000-00000000000d',
   'f1415000-0000-4000-8000-0000000000d2', 'f1411000-0000-4000-8000-0000000000f2',
   'write_records', 'direct-care', 'active', 'Synthetic grant for D at F2', now() - interval '1 minute',
   now() + interval '1 hour', false, 'drafts-0141-grant-f2');


create function pg_temp.as_member(subject text, membership uuid, facility uuid) returns void language sql as $f$
  select set_config('app.actor_subject', subject, true), set_config('app.membership_id', membership::text, true),
    set_config('app.facility_id', facility::text, true), set_config('app.purpose_of_use', 'direct-care', true),
    set_config('app.correlation_id', 'drafts-0141-suite', true);
$f$;
select pg_temp.as_member('synthetic:drafts-0141:d', 'f1415000-0000-4000-8000-0000000000d1', 'f1411000-0000-4000-8000-0000000000f1');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status, started_at) values
  ('f1418000-0000-4000-8000-000000000001', 'f1417000-0000-4000-8000-000000000001', 'f1411000-0000-4000-8000-0000000000f1',
   'f1412000-0000-4000-8000-00000000000d', 'f1415000-0000-4000-8000-0000000000d1', 'ambulatory', 'in_progress', now());
-- P2's grant ends once D has a draft for P2 (below).

create temporary table draft_outcomes (seq serial, name text primary key, expected text not null, actual text) on commit drop;
grant select, insert on pg_temp.draft_outcomes to hid_ehr_api_runtime;
grant usage on sequence pg_temp.draft_outcomes_seq_seq to hid_ehr_api_runtime;
create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.draft_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.try(statement text) returns text language plpgsql as $f$
declare
  affected bigint;
begin
  execute statement;
  get diagnostics affected = row_count;
  return 'ok ' || affected;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

-- 1. Structure.
select pg_temp.check_case('1 forced row-level security, six policies', 't/t/6',
  (select format('%s/%s/%s', relrowsecurity, relforcerowsecurity,
     (select count(*) from pg_policy where polrelid = 'ehr.consultation_drafts'::regclass))
     from pg_class where oid = 'ehr.consultation_drafts'::regclass));
select pg_temp.check_case('1 one per visit, one per patient without a visit',
  'consultation_drafts_one_per_visit (membership_id, encounter_id) WHERE (encounter_id IS NOT NULL)|consultation_drafts_one_without_visit (membership_id, patient_id) WHERE (encounter_id IS NULL)',
  (select string_agg(regexp_replace(pg_get_indexdef(indexrelid), '^CREATE UNIQUE INDEX (\w+) ON ehr.consultation_drafts USING btree ', '\1 '), '|'
       order by indexrelid::regclass::text)
     from pg_index where indrelid = 'ehr.consultation_drafts'::regclass and indisunique and not indisprimary));
select pg_temp.check_case('1 the functions', 'true/true/true',
  (select string_agg((prosecdef and proconfig = array['search_path=pg_catalog, pg_temp'])::text, '/' order by proname)
     from pg_proc where oid in ('ehr.list_my_consultation_drafts()'::regprocedure, 'ehr.sweep_consultation_drafts(integer)'::regprocedure,
       'ehr.is_consultation_draft_author(uuid,uuid,uuid)'::regprocedure)));
select pg_temp.check_case('1 the EHR runtime only', 'DELETE,INSERT,SELECT,UPDATE/(null)',
  (select format('%s/%s',
     (select string_agg(privilege, ',' order by privilege) from unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege
       where has_table_privilege('hid_ehr_runtime', 'ehr.consultation_drafts', privilege)),
     coalesce((select string_agg(role_name, ',') from unnest(array['hid_identity_runtime', 'hid_lab_runtime', 'hid_schema_test_runtime']) role_name
       where exists (select 1 from pg_roles where rolname = role_name)
         and has_table_privilege(role_name, 'ehr.consultation_drafts', 'SELECT')), '(null)'))));

-- 2. As the EHR API runtime, D at F1.
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 a draft for the visit', 'ok 1', pg_temp.try($s$
  insert into ehr.consultation_drafts (id, patient_id, facility_id, account_id, membership_id, encounter_id, form_version,
    content, size_bytes, row_version, created_at, saved_at, expires_at)
  values ('f141d000-0000-4000-8000-000000000001', 'f1417000-0000-4000-8000-000000000001', 'f1411000-0000-4000-8000-0000000000f1',
    'f1412000-0000-4000-8000-00000000000d', 'f1415000-0000-4000-8000-0000000000d1', 'f1418000-0000-4000-8000-000000000001', 1,
    '{"chiefComplaint": "Synthetic cough"}', 99999, 7, now() - interval '1 year', now() - interval '1 year', now())$s$));
select pg_temp.check_case('2 the server sets the version, the size and the times', '1/37/7 days/t',
  (select format('%s/%s/%s/%s', row_version, size_bytes, expires_at - saved_at, created_at > now() - interval '1 minute')
     from ehr.consultation_drafts where id = 'f141d000-0000-4000-8000-000000000001'));
select pg_temp.check_case('2 one draft per visit', '23505', (select split_part(pg_temp.try($s$
  insert into ehr.consultation_drafts (patient_id, facility_id, account_id, membership_id, encounter_id, form_version, content,
    size_bytes, expires_at)
  values ('f1417000-0000-4000-8000-000000000001', 'f1411000-0000-4000-8000-0000000000f1', 'f1412000-0000-4000-8000-00000000000d',
    'f1415000-0000-4000-8000-0000000000d1', 'f1418000-0000-4000-8000-000000000001', 1, '{}', 2, now())$s$), ' ', 1)));
select pg_temp.check_case('2 a draft before any visit, and P2''s', 'ok 2', pg_temp.try($s$
  insert into ehr.consultation_drafts (id, patient_id, facility_id, account_id, membership_id, form_version, content, size_bytes, expires_at)
  values ('f141d000-0000-4000-8000-000000000002', 'f1417000-0000-4000-8000-000000000001', 'f1411000-0000-4000-8000-0000000000f1',
    'f1412000-0000-4000-8000-00000000000d', 'f1415000-0000-4000-8000-0000000000d1', 2, '{"examination": "Synthetic"}', 2, now()),
         ('f141d000-0000-4000-8000-000000000003', 'f1417000-0000-4000-8000-000000000002', 'f1411000-0000-4000-8000-0000000000f1',
    'f1412000-0000-4000-8000-00000000000d', 'f1415000-0000-4000-8000-0000000000d1', 1, '{"examination": "Synthetic"}', 2, now())$s$));
select pg_temp.check_case('2 one draft per patient without a visit', '23505', (select split_part(pg_temp.try($s$
  insert into ehr.consultation_drafts (patient_id, facility_id, account_id, membership_id, form_version, content, size_bytes, expires_at)
  values ('f1417000-0000-4000-8000-000000000001', 'f1411000-0000-4000-8000-0000000000f1', 'f1412000-0000-4000-8000-00000000000d',
    'f1415000-0000-4000-8000-0000000000d1', 1, '{}', 2, now())$s$), ' ', 1)));
select pg_temp.check_case('2 not as another member', '42501', (select split_part(pg_temp.try($s$
  insert into ehr.consultation_drafts (patient_id, facility_id, account_id, membership_id, form_version, content, size_bytes, expires_at)
  values ('f1417000-0000-4000-8000-000000000001', 'f1411000-0000-4000-8000-0000000000f1', 'f1412000-0000-4000-8000-00000000000e',
    'f1415000-0000-4000-8000-0000000000e1', 1, '{}', 2, now())$s$), ' ', 1)));
select pg_temp.check_case('2 a save: a new version, a new save time', 'ok 1', pg_temp.try($s$
  update ehr.consultation_drafts set content = '{"chiefComplaint": "Synthetic cough, 3 days"}', form_version = 1
   where id = 'f141d000-0000-4000-8000-000000000001' and row_version = 1$s$));
select pg_temp.check_case('2 version 2', '2', (select row_version::text from ehr.consultation_drafts where id = 'f141d000-0000-4000-8000-000000000001'));
select pg_temp.check_case('2 no move to another patient', '55000 CONSULTATION_DRAFT_IMMUTABLE', pg_temp.try($s$
  update ehr.consultation_drafts set patient_id = 'f1417000-0000-4000-8000-000000000002'
   where id = 'f141d000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 no move to a visit', '55000 CONSULTATION_DRAFT_IMMUTABLE', pg_temp.try($s$
  update ehr.consultation_drafts set encounter_id = 'f1418000-0000-4000-8000-000000000001'
   where id = 'f141d000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 over 256 KB', '22023 CONSULTATION_DRAFT_TOO_LARGE', pg_temp.try($s$
  update ehr.consultation_drafts set content = jsonb_build_object('text', repeat('x', 262200))
   where id = 'f141d000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 content is an object', '23514', (select split_part(pg_temp.try($s$
  update ehr.consultation_drafts set content = '["not", "an", "object"]'
   where id = 'f141d000-0000-4000-8000-000000000002'$s$), ' ', 1)));
reset role;
-- P2's grant ends now; and one draft of D's is already past its 7 days.
update identity.consent_grants set status = 'revoked', revoked_at = now(), revoked_reason = 'Synthetic end'
 where id = 'f141b000-0000-4000-8000-000000000002';
set local session_replication_role = replica;
update ehr.consultation_drafts set created_at = now() - interval '9 days', saved_at = now() - interval '8 days',
       expires_at = now() - interval '1 day' where id = 'f141d000-0000-4000-8000-000000000002';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 D sees D''s live drafts only', 'f141d000-0000-4000-8000-000000000001,f141d000-0000-4000-8000-000000000003',
  (select string_agg(id::text, ',' order by id) from ehr.consultation_drafts));
select pg_temp.check_case('2 an expired draft cannot be saved', 'ok 0', pg_temp.try($s$
  update ehr.consultation_drafts set content = '{}' where id = 'f141d000-0000-4000-8000-000000000002'$s$));
select pg_temp.check_case('2 the list across patients: P2''s draft counted, not shown', 'f141d000-0000-4000-8000-000000000001/Ada Orders/female/1984-04-04/A2B3/hidden 1',
  (select string_agg(format('%s/%s/%s/%s/%s/hidden %s', draft_id, full_name, sex, date_of_birth, health_id_last4, hidden_count), '|')
     from ehr.list_my_consultation_drafts()));
reset role;
select pg_temp.check_case('2 the list is audited, with one shown row per patient', '1/1/1',
  (select format('%s/%s/%s', count(*) filter (where action = 'ehr.consultation-draft.list'),
       count(*) filter (where action = 'ehr.consultation-draft.list.shown'),
       max((details->>'hiddenCount')) filter (where action = 'ehr.consultation-draft.list'))
     from audit.events where correlation_id = 'drafts-0141-suite'));
select pg_temp.as_member('synthetic:drafts-0141:e', 'f1415000-0000-4000-8000-0000000000e1', 'f1411000-0000-4000-8000-0000000000f1');
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 another member sees, saves and discards nothing', '0/ok 0/ok 0',
  (select format('%s/%s/%s', (select count(*) from ehr.consultation_drafts),
     pg_temp.try($s$update ehr.consultation_drafts set content = '{}' where id = 'f141d000-0000-4000-8000-000000000001'$s$),
     pg_temp.try($s$delete from ehr.consultation_drafts where id = 'f141d000-0000-4000-8000-000000000001'$s$))));
select pg_temp.check_case('2 another member''s list is empty', '(null)/hidden 0',
  (select format('%s/hidden %s', coalesce(draft_id::text, '(null)'), hidden_count) from ehr.list_my_consultation_drafts()));
reset role;
select pg_temp.as_member('synthetic:drafts-0141:d', 'f1415000-0000-4000-8000-0000000000d2', 'f1411000-0000-4000-8000-0000000000f2');
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 the same doctor at another facility sees nothing', '0',
  (select count(*)::text from ehr.consultation_drafts));
reset role;
select pg_temp.as_member('synthetic:drafts-0141:d', 'f1415000-0000-4000-8000-0000000000d1', 'f1411000-0000-4000-8000-0000000000f1');
set local role hid_ehr_api_runtime;
select pg_temp.check_case('2 the sweeper removes the expired draft', '1', (select ehr.sweep_consultation_drafts(100)::text));
select pg_temp.check_case('2 a batch out of range', '22023', (select split_part(pg_temp.try('select ehr.sweep_consultation_drafts(0)'), ' ', 1)));
select pg_temp.check_case('2 the author discards, and again', 'ok 1/ok 0',
  (select format('%s/%s', pg_temp.try($s$delete from ehr.consultation_drafts where id = 'f141d000-0000-4000-8000-000000000001'$s$),
     pg_temp.try($s$delete from ehr.consultation_drafts where id = 'f141d000-0000-4000-8000-000000000001'$s$))));
reset role;
select pg_temp.check_case('2 the sweep is audited, never the content', 'ehr.consultation-draft.expire/f141d000-0000-4000-8000-000000000002/f',
  (select format('%s/%s/%s', action, resource_id, details ? 'content') from audit.events
    where correlation_id = 'consultation-draft-sweep' and resource_id = 'f141d000-0000-4000-8000-000000000002'));

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.draft_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0141 consultation drafts:\n%', mismatch;
  end if;
  raise notice '0141 consultation drafts: % cases passed', (select count(*) from pg_temp.draft_outcomes);
end $$;

rollback;
