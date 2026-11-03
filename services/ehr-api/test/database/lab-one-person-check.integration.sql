\set ON_ERROR_STOP on
-- 0110, owner decision 33.3 ("two-person lab check default; a single-person
-- facility may release with a typed, logged reason"). Rollback-only.
--
-- A facility is two-person until its administrator (organization.manage at
-- the session facility) switches One-person lab on, with a typed reason, as
-- the Identity runtime with the session DatabaseService sets. While it is on,
-- the person who entered a result version may check it themselves only by
-- asking for a self-check with a typed reason of 10-500 characters; the
-- verification row then records self_check and the setting in force (never
-- the client's value). Release is unchanged. Off, a same-person check is
-- LAB_RESULT_SECOND_CHECK_REQUIRED whatever the client sends. A different
-- person's check is as before. Every Lab write runs as the Lab API runtime
-- with the Lab API's session and its INSERT statements; fixtures are
-- inserted with session_replication_role = replica (CHECK constraints still
-- apply). The suite fails on a 0103 database (the functions are missing).
begin;

-- Organizations O1 (facility F1, a laboratory) and O2 (facility F2). Members:
-- 1 ADM (admin, F1), 2 A (lab, F1, the enterer), 3 B (lab, F1),
-- 4 W (org_admin_awaiting_review, F1), 5 I (admin, F1, inactive membership),
-- 6 ADM2 (admin, F2), 7 G (lab, F2). Patient P; A, B and G hold write
-- consents at their facility for direct care.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system)
values ('direct-care', 'Direct patient care', 'one-person-lab-test') on conflict (code) do nothing;
insert into identity.organizations (id, name, slug) values
  ('b1100000-0000-4000-8000-000000000001', 'One Person Lab Org', 'one-person-lab-org'),
  ('b1100000-0000-4000-8000-000000000002', 'Two Person Lab Org', 'two-person-lab-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('b1100000-0000-4000-8000-000000000011', 'b1100000-0000-4000-8000-000000000001', 'One Person Lab F1',
   'ONE-PERSON-F1', 'Africa/Lagos', true, 'verified'),
  ('b1100000-0000-4000-8000-000000000012', 'b1100000-0000-4000-8000-000000000002', 'Two Person Lab F2',
   'ONE-PERSON-F2', 'Africa/Lagos', true, 'verified');
create temporary table onepl_members (n int primary key, name text unique, role_code text, facility uuid,
  organization uuid, active boolean) on commit drop;
insert into onepl_members values
  (1, 'ADM', 'admin', 'b1100000-0000-4000-8000-000000000011', 'b1100000-0000-4000-8000-000000000001', true),
  (2, 'A', 'lab', 'b1100000-0000-4000-8000-000000000011', 'b1100000-0000-4000-8000-000000000001', true),
  (3, 'B', 'lab', 'b1100000-0000-4000-8000-000000000011', 'b1100000-0000-4000-8000-000000000001', true),
  (4, 'W', 'org_admin_awaiting_review', 'b1100000-0000-4000-8000-000000000011',
   'b1100000-0000-4000-8000-000000000001', true),
  (5, 'I', 'admin', 'b1100000-0000-4000-8000-000000000011', 'b1100000-0000-4000-8000-000000000001', false),
  (6, 'ADM2', 'admin', 'b1100000-0000-4000-8000-000000000012', 'b1100000-0000-4000-8000-000000000002', true),
  (7, 'G', 'lab', 'b1100000-0000-4000-8000-000000000012', 'b1100000-0000-4000-8000-000000000002', true);
grant select on onepl_members to public;
insert into auth.accounts (id, subject, email, display_name, status)
select ('b1110000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:onepl-' || lower(name),
       'onepl-' || lower(name) || '@example.invalid', 'One Person ' || name, 'active'
  from onepl_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('b1120000-0000-4000-8000-00000000000' || n)::uuid, ('b1110000-0000-4000-8000-00000000000' || n)::uuid,
       'Staff ' || name, 'onepl-' || lower(name) || '@example.invalid', 'verified', role_code
  from onepl_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('b1130000-0000-4000-8000-00000000000' || n)::uuid, ('b1120000-0000-4000-8000-00000000000' || n)::uuid,
       ('b1110000-0000-4000-8000-00000000000' || n)::uuid, organization, facility, role_code, role_code, true, active
  from onepl_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('b1140000-0000-4000-8000-00000000000' || n)::uuid, ('b1110000-0000-4000-8000-00000000000' || n)::uuid,
       role_code, 'facility', ('b1130000-0000-4000-8000-00000000000' || n)::uuid, facility,
       'Synthetic one-person lab test'
  from onepl_members;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('b1150000-0000-4000-8000-000000000001', 'HID-SNGLLAB2', 'One', 'Person', 'One Person Patient', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, break_glass, purpose_of_use)
select ('b1160000-0000-4000-8000-00000000000' || n)::uuid, 'b1150000-0000-4000-8000-000000000001',
       ('b1120000-0000-4000-8000-00000000000' || n)::uuid, ('b1110000-0000-4000-8000-00000000000' || n)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || n)::uuid, facility, 'write_records', 'active',
       'Synthetic one-person lab consent', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day',
       false, 'direct-care'
  from onepl_members where n in (2, 3, 7);

-- Lab chains 1-6, one result each, at version 1 entered by A (1-5, F1) or by
-- G (6, F2): R1 default-off checks, R2 the self-check, release and
-- correction, R3 off again, R4 invalidated, R5 the release guard and the
-- direct constraint inserts, R6 the other facility.
create temporary table onepl_chain (n int primary key, facility uuid, enterer int, accepter int) on commit drop;
insert into onepl_chain select n,
  (case when n = 6 then 'b1100000-0000-4000-8000-000000000012' else 'b1100000-0000-4000-8000-000000000011' end)::uuid,
  case when n = 6 then 7 else 2 end, case when n = 6 then 7 else 3 end
  from generate_series(1, 6) n;
grant select on onepl_chain to public;
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at)
select ('b1180000-0000-4000-8000-00000000000' || n)::uuid, 'b1150000-0000-4000-8000-000000000001', facility,
       ('b1110000-0000-4000-8000-00000000000' || accepter)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || accepter)::uuid, 'ambulatory', 'in_progress', clock_timestamp()
  from onepl_chain;
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, clinical_information, created_at)
select ('b1190000-0000-4000-8000-00000000000' || n)::uuid, ('b1180000-0000-4000-8000-00000000000' || n)::uuid,
       'b1150000-0000-4000-8000-000000000001', facility, ('b1110000-0000-4000-8000-00000000000' || accepter)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || accepter)::uuid, 'http://loinc.org', '718-7', 'Haemoglobin',
       'routine', 'active', 'Synthetic one-person lab order', '2026-10-01 09:00:00+00'
  from onepl_chain;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, priority, test_code_system, test_code, test_name,
  clinical_indication, requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key,
  request_sha256, correlation_id)
select ('b11a0000-0000-4000-8000-00000000000' || n)::uuid, 'b1150000-0000-4000-8000-000000000001', facility,
       facility, ('b1190000-0000-4000-8000-00000000000' || n)::uuid, 1,
       ('b1180000-0000-4000-8000-00000000000' || n)::uuid, 'routine', 'http://loinc.org', '718-7', 'Haemoglobin',
       'Synthetic one-person lab order', ('b1110000-0000-4000-8000-00000000000' || accepter)::uuid,
       '2026-10-01 09:00:00+00', ('b1110000-0000-4000-8000-00000000000' || accepter)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || accepter)::uuid, 'onepl-fixture-work-' || n, repeat('a', 64),
       'onepl-fixture'
  from onepl_chain;
insert into lab.work_item_requested_tests (id, work_item_id, facility_id, patient_id, ordinal, code_system, code,
  name)
select ('b11a0000-0000-4000-8000-00000000001' || n)::uuid, ('b11a0000-0000-4000-8000-00000000000' || n)::uuid,
       facility, 'b1150000-0000-4000-8000-000000000001', 1, 'http://loinc.org', '718-7', 'Haemoglobin'
  from onepl_chain;
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
select ('b11b0000-0000-4000-8000-00000000000' || n)::uuid, ('b11a0000-0000-4000-8000-00000000000' || n)::uuid,
       'b1150000-0000-4000-8000-000000000001', facility, 'routine',
       ('b1110000-0000-4000-8000-00000000000' || accepter)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || accepter)::uuid, 'onepl-fixture-accession-' || n,
       repeat('a', 64), 'onepl-fixture'
  from onepl_chain;
insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
select ('b11b0000-0000-4000-8000-00000000001' || n)::uuid, ('b11b0000-0000-4000-8000-00000000000' || n)::uuid,
       'b1150000-0000-4000-8000-000000000001', facility, 1, 'whole blood'
  from onepl_chain;
insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
  collected_at, collected_by, collected_by_membership_id, received_at, received_by, received_by_membership_id,
  row_version)
select ('b11b0000-0000-4000-8000-00000000002' || n)::uuid, ('b11b0000-0000-4000-8000-00000000001' || n)::uuid,
       ('b11b0000-0000-4000-8000-00000000000' || n)::uuid, 'b1150000-0000-4000-8000-000000000001', facility,
       'whole blood', 'received', clock_timestamp(), ('b1110000-0000-4000-8000-00000000000' || accepter)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || accepter)::uuid, clock_timestamp(),
       ('b1110000-0000-4000-8000-00000000000' || accepter)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || accepter)::uuid, 3
  from onepl_chain;
insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
  started_by, started_by_membership_id, started_at, completed_by, completed_by_membership_id, completed_at,
  idempotency_key, request_sha256, correlation_id, row_version)
select ('b11c0000-0000-4000-8000-00000000000' || n)::uuid, ('b11b0000-0000-4000-8000-00000000000' || n)::uuid,
       ('b11b0000-0000-4000-8000-00000000002' || n)::uuid, ('b11a0000-0000-4000-8000-00000000001' || n)::uuid,
       'b1150000-0000-4000-8000-000000000001', facility, 'completed',
       ('b1110000-0000-4000-8000-00000000000' || enterer)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || enterer)::uuid, clock_timestamp(),
       ('b1110000-0000-4000-8000-00000000000' || enterer)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || enterer)::uuid, clock_timestamp(),
       'onepl-fixture-execution-' || n, repeat('a', 64), 'onepl-fixture', 2
  from onepl_chain;
insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id)
select ('b11c0000-0000-4000-8000-00000000001' || n)::uuid, ('b11c0000-0000-4000-8000-00000000000' || n)::uuid,
       'b1150000-0000-4000-8000-000000000001', facility, ('b1110000-0000-4000-8000-00000000000' || enterer)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || enterer)::uuid
  from onepl_chain;
insert into lab.result_revisions (id, result_id, execution_id, patient_id, facility_id, version, result_type,
  numeric_value, unit, entered_by, entered_by_membership_id, idempotency_key, request_sha256, correlation_id,
  revision_kind)
select ('b11c0000-0000-4000-8000-00000000002' || n)::uuid, ('b11c0000-0000-4000-8000-00000000001' || n)::uuid,
       ('b11c0000-0000-4000-8000-00000000000' || n)::uuid, 'b1150000-0000-4000-8000-000000000001', facility, 1,
       'numeric', 12.5, 'g/dL', ('b1110000-0000-4000-8000-00000000000' || enterer)::uuid,
       ('b1130000-0000-4000-8000-00000000000' || enterer)::uuid, 'onepl-fixture-result-' || n, repeat('a', 64),
       'onepl-fixture', 'original'
  from onepl_chain;
-- R4 version 1 was marked entered in error by B.
insert into lab.result_invalidations (id, result_id, execution_id, patient_id, facility_id, result_version,
  disposition, actor_id, actor_membership_id, reason, idempotency_key, request_sha256, correlation_id) values
  ('b11d0000-0000-4000-8000-000000000004', 'b11c0000-0000-4000-8000-000000000014',
   'b11c0000-0000-4000-8000-000000000004', 'b1150000-0000-4000-8000-000000000001',
   'b1100000-0000-4000-8000-000000000011', 1, 'entered_in_error', 'b1110000-0000-4000-8000-000000000003',
   'b1130000-0000-4000-8000-000000000003', 'Synthetic entered in error', 'onepl-fixture-invalidation',
   repeat('a', 64), 'onepl-fixture');
set local session_replication_role = origin;

-- Sessions as the services' DatabaseService sets them (actor_subject,
-- facility_id, correlation_id, membership_id, purpose_of_use; '' is missing).
create function pg_temp.onepl_session(member text, purpose text, want_facility text default null,
  want_membership text default null, correlation text default 'onepl-suite-correlation-0001') returns void
language sql as $$
  select set_config('app.actor_subject', 'synthetic:onepl-' || lower(coalesce(m.name, member)), true),
         set_config('app.facility_id', coalesce(want_facility, m.facility::text, ''), true),
         set_config('app.correlation_id', correlation, true),
         set_config('app.membership_id', coalesce(want_membership, 'b1130000-0000-4000-8000-00000000000' || m.n, ''), true),
         set_config('app.purpose_of_use', purpose, true)
    from (select 1) single_row left join onepl_members m on m.name = member
$$;
-- The outcome of one statement: 'ok', or its SQLSTATE and message.
create function pg_temp.onepl_try(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.onepl_expect(label text, actual text, expected text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'onepl: %: expected [%], got [%]', label, expected, actual;
  end if;
end $$;
-- services/lab-api/src/lab/lab-executions.service.ts govern(verify): the
-- Lab API's insert, with self_check (and, for the forged-id case, a
-- client-supplied one_person_setting_id).
create function pg_temp.onepl_verify(chain int, version int, member text, self_check boolean, reason text,
  forged_setting uuid default null) returns text language sql as $$
  select format($i$insert into lab.result_verifications(result_id,execution_id,patient_id,facility_id,result_version,
    verified_by,verified_by_membership_id,verified_at,reason,idempotency_key,request_sha256,correlation_id,self_check,
    one_person_setting_id)
    values(%L,%L,'b1150000-0000-4000-8000-000000000001',%L,%s,%L,%L,clock_timestamp(),%L,%L,repeat('b',64),
      'onepl-suite-correlation-0001',%L,%L)$i$,
    'b11c0000-0000-4000-8000-00000000001' || chain, 'b11c0000-0000-4000-8000-00000000000' || chain, c.facility,
    version, 'b1110000-0000-4000-8000-00000000000' || m.n, 'b1130000-0000-4000-8000-00000000000' || m.n, reason,
    'onepl-verify-' || chain || '-' || version || '-' || m.n || '-' || md5(coalesce(reason, '') || self_check::text),
    self_check, forged_setting)
    from onepl_chain c, onepl_members m where c.n = chain and m.name = member
$$;
create function pg_temp.onepl_release(chain int, version int, member text) returns text language sql as $$
  select format($i$insert into lab.result_releases(verification_id,result_id,execution_id,patient_id,facility_id,
    result_version,released_by,released_by_membership_id,released_at,reason,idempotency_key,request_sha256,
    correlation_id)
    values(%L,%L,%L,'b1150000-0000-4000-8000-000000000001',%L,%s,%L,%L,clock_timestamp(),'Synthetic release',
      %L,repeat('b',64),'onepl-suite-correlation-0001')$i$,
    coalesce(current_setting('onepl.verification_' || chain || '_' || version, true), gen_random_uuid()::text),
    'b11c0000-0000-4000-8000-00000000001' || chain, 'b11c0000-0000-4000-8000-00000000000' || chain, c.facility,
    version, 'b1110000-0000-4000-8000-00000000000' || m.n, 'b1130000-0000-4000-8000-00000000000' || m.n,
    'onepl-release-' || chain || '-' || version)
    from onepl_chain c, onepl_members m where c.n = chain and m.name = member
$$;
create function pg_temp.onepl_set(enabled boolean, reason text) returns text language sql as $$
  select format('select * from identity.set_facility_one_person_lab(%L, %L)', enabled, reason)
$$;
grant execute on function pg_temp.onepl_session(text,text,text,text,text), pg_temp.onepl_try(text),
  pg_temp.onepl_expect(text,text,text), pg_temp.onepl_verify(int,int,text,boolean,text,uuid),
  pg_temp.onepl_release(int,int,text), pg_temp.onepl_set(boolean,text) to public;
create temporary table onepl_counts (settings bigint, audit bigint) on commit drop;
grant all on onepl_counts to public;
create function pg_temp.onepl_snapshot() returns void language sql security definer as $$
  delete from onepl_counts;
  insert into onepl_counts select (select count(*) from identity.facility_lab_check_settings),
    (select count(*) from audit.events where action like 'identity.facility.one-person-lab.%');
$$;
create function pg_temp.onepl_unchanged(label text) returns void language plpgsql security definer as $$
begin
  if (select row(settings, audit) from onepl_counts) is distinct from
     row((select count(*) from identity.facility_lab_check_settings),
         (select count(*) from audit.events where action like 'identity.facility.one-person-lab.%')) then
    raise exception 'onepl: % wrote a setting or an audit row', label;
  end if;
end $$;

-- 0. The objects exist with their privileges: the tables are no runtime
-- role's; the functions are SECURITY DEFINER and executable only by their
-- runtime.
do $$
begin
  if exists (select 1 from pg_roles role_row
              cross join (values ('identity.facility_lab_check_settings'), ('identity.facility_lab_check_current')) t(name)
              cross join (values ('select'), ('insert'), ('update'), ('delete')) p(privilege)
             where role_row.rolname like 'hid\_%'
               and has_table_privilege(role_row.oid, t.name, p.privilege)) then
    raise exception 'onepl: a runtime role holds a privilege on a one-person lab table';
  end if;
  if not has_function_privilege('hid_identity_api_runtime', 'identity.set_facility_one_person_lab(boolean,text)', 'execute')
     or not has_function_privilege('hid_identity_api_runtime', 'identity.facility_one_person_lab_state()', 'execute')
     or not has_function_privilege('hid_lab_api_runtime', 'lab.one_person_lab_enabled()', 'execute')
     or has_function_privilege('hid_lab_api_runtime', 'identity.set_facility_one_person_lab(boolean,text)', 'execute')
     or has_function_privilege('hid_identity_api_runtime', 'lab.one_person_lab_enabled()', 'execute')
     or has_function_privilege('hid_ehr_api_runtime', 'identity.set_facility_one_person_lab(boolean,text)', 'execute')
     or has_function_privilege('hid_ehr_api_runtime', 'lab.one_person_lab_enabled()', 'execute') then
    raise exception 'onepl: EXECUTE on the one-person lab functions is not exactly the runtimes''';
  end if;
end $$;

-- 1. Default off (no setting row).
set local role hid_lab_api_runtime;
select pg_temp.onepl_session('A', 'direct-care');
select pg_temp.onepl_expect('1 off: lab read', lab.one_person_lab_enabled()::text, 'false');
select pg_temp.onepl_expect('1 off: A checks own R1', pg_temp.onepl_try(pg_temp.onepl_verify(1, 1, 'A', false,
  'Manual result verified')), '23514 LAB_RESULT_SECOND_CHECK_REQUIRED');
select pg_temp.onepl_expect('1 off: A asks a self-check of R1', pg_temp.onepl_try(pg_temp.onepl_verify(1, 1, 'A', true,
  'I am the only scientist here today')), '23514 LAB_RESULT_SECOND_CHECK_REQUIRED');
select pg_temp.onepl_session('B', 'direct-care');
select pg_temp.onepl_expect('1 off: B checks R1', pg_temp.onepl_try(pg_temp.onepl_verify(1, 1, 'B', false,
  'Manual result verified')), 'ok');
reset role;
select pg_temp.onepl_expect('1 off: B''s row', (select self_check::text || ' ' || coalesce(one_person_setting_id::text, 'null')
  from lab.result_verifications where result_id = 'b11c0000-0000-4000-8000-000000000011'), 'false null');

-- 2. Switching it.
select pg_temp.onepl_snapshot();
set local role hid_identity_api_runtime;
do $$
declare
  attempt record;
begin
  for attempt in select * from (values
    ('A', 'healthcare-operations', null, null, 'onepl-suite-correlation-0001', 'Only one scientist works here',
     '42501 FACILITY_SETTING_PERMISSION_DENIED', 'a lab scientist'),
    ('W', 'healthcare-operations', null, null, 'onepl-suite-correlation-0001', 'Only one scientist works here',
     '42501 FACILITY_SETTING_PERMISSION_DENIED', 'an administrator awaiting review'),
    ('I', 'healthcare-operations', null, null, 'onepl-suite-correlation-0001', 'Only one scientist works here',
     '42501 FACILITY_SETTING_PERMISSION_DENIED', 'an inactive membership'),
    ('ADM2', 'healthcare-operations', 'b1100000-0000-4000-8000-000000000011', null, 'onepl-suite-correlation-0001',
     'Only one scientist works here', '42501 FACILITY_SETTING_PERMISSION_DENIED', 'another facility''s administrator'),
    ('ADM', 'healthcare-operations', null, '', 'onepl-suite-correlation-0001', 'Only one scientist works here',
     '42501 FACILITY_SETTING_PERMISSION_DENIED', 'no membership'),
    ('ADM', 'healthcare-operations', '', null, 'onepl-suite-correlation-0001', 'Only one scientist works here',
     '42501 FACILITY_SETTING_PERMISSION_DENIED', 'no facility'),
    ('ADM', 'healthcare-operations', null, null, '', 'Only one scientist works here',
     '42501 FACILITY_SETTING_PERMISSION_DENIED', 'no correlation id'),
    ('ADM', 'direct-care', null, null, 'onepl-suite-correlation-0001', 'Only one scientist works here',
     '42501 FACILITY_SETTING_PERMISSION_DENIED', 'purpose direct-care'),
    ('nobody', 'healthcare-operations', 'b1100000-0000-4000-8000-000000000011', 'b1130000-0000-4000-8000-000000000001',
     'onepl-suite-correlation-0001', 'Only one scientist works here', '42501 FACILITY_SETTING_PERMISSION_DENIED',
     'an unknown subject with the administrator''s membership'),
    ('ADM', 'healthcare-operations', null, null, 'onepl-suite-correlation-0001', repeat('x', 9),
     '22023 FACILITY_SETTING_REASON_INVALID', 'a reason of 9 characters'),
    ('ADM', 'healthcare-operations', null, null, 'onepl-suite-correlation-0001', repeat('x', 501),
     '22023 FACILITY_SETTING_REASON_INVALID', 'a reason of 501 characters'),
    ('ADM', 'healthcare-operations', null, null, 'onepl-suite-correlation-0001', '   too short    ',
     '22023 FACILITY_SETTING_REASON_INVALID', 'a padded reason of 9 characters'),
    ('ADM', 'healthcare-operations', null, null, 'onepl-suite-correlation-0001', null,
     '22023 FACILITY_SETTING_REASON_INVALID', 'no reason'),
    ('ADM', 'healthcare-operations', null, null, 'onepl-suite-correlation-0001', 'Only one scientist works here',
     '22023 FACILITY_SETTING_INVALID', 'no value'),
    ('ADM', 'healthcare-operations', null, null, 'onepl-suite-correlation-0001', 'Only one scientist works here',
     'P0001 FACILITY_SETTING_UNCHANGED', 'off again while off'))
      s(member, purpose, facility, membership, correlation, reason, expected, what)
  loop
    perform pg_temp.onepl_session(attempt.member, attempt.purpose, attempt.facility, attempt.membership,
      attempt.correlation);
    perform pg_temp.onepl_expect('2 refused: ' || attempt.what,
      pg_temp.onepl_try(case when attempt.what = 'no value'
        then 'select * from identity.set_facility_one_person_lab(null, ' || quote_literal(attempt.reason) || ')'
        else pg_temp.onepl_set(attempt.what not like 'off again%', attempt.reason) end), attempt.expected);
    perform pg_temp.onepl_unchanged('2 refused: ' || attempt.what);
    if attempt.expected like '42501%' then
      perform pg_temp.onepl_expect('2 state refused: ' || attempt.what,
        pg_temp.onepl_try('select * from identity.facility_one_person_lab_state()'), attempt.expected);
    end if;
  end loop;
end $$;
-- The administrator's state read before any switch.
select pg_temp.onepl_session('ADM', 'healthcare-operations');
select pg_temp.onepl_expect('2 state before', (select row(enabled, changed_at, changed_by_name, reason)::text
  from identity.facility_one_person_lab_state()), '(f,,,)');
-- The administrator switches it on (the reason is trimmed).
select pg_temp.onepl_expect('2 on', pg_temp.onepl_try(pg_temp.onepl_set(true, '  Only one scientist works here  ')), 'ok');
select pg_temp.onepl_expect('2 state after', (select row(enabled, changed_at is not null, changed_by_name, reason)::text
  from identity.facility_one_person_lab_state()), '(t,t,"One Person ADM","Only one scientist works here")');
select pg_temp.onepl_expect('2 on again', pg_temp.onepl_try(pg_temp.onepl_set(true, 'Only one scientist works here')),
  'P0001 FACILITY_SETTING_UNCHANGED');
-- Another facility's administrator switches only their own.
select pg_temp.onepl_session('ADM2', 'healthcare-operations');
select pg_temp.onepl_expect('2 F2 state', (select enabled::text from identity.facility_one_person_lab_state()), 'false');
select pg_temp.onepl_expect('2 F2 on', pg_temp.onepl_try(pg_temp.onepl_set(true, 'Trial of the switch at F2')), 'ok');
select pg_temp.onepl_expect('2 F2 off', pg_temp.onepl_try(pg_temp.onepl_set(false, 'Trial over, two people again')), 'ok');
-- Runtime roles cannot touch the tables.
do $$
declare
  statement text;
begin
  foreach statement in array array[
    'select 1 from identity.facility_lab_check_settings',
    'insert into identity.facility_lab_check_settings (facility_id) values (null)',
    'update identity.facility_lab_check_settings set reason = reason',
    'delete from identity.facility_lab_check_settings',
    'select 1 from identity.facility_lab_check_current',
    'update identity.facility_lab_check_current set row_version = row_version',
    'delete from identity.facility_lab_check_current'] loop
    perform pg_temp.onepl_expect('2 identity runtime: ' || statement, left(pg_temp.onepl_try(statement), 5), '42501');
  end loop;
end $$;
set local role hid_lab_api_runtime;
select pg_temp.onepl_expect('2 lab runtime select', left(pg_temp.onepl_try(
  'select 1 from identity.facility_lab_check_settings'), 5), '42501');
select pg_temp.onepl_expect('2 lab runtime insert', left(pg_temp.onepl_try(
  'insert into identity.facility_lab_check_current (facility_id, setting_id) values (null, null)'), 5), '42501');
reset role;
-- The rows: F1 one setting and one audit row with exactly these columns; F2 two.
select pg_temp.onepl_expect('2 F1 setting', (select string_agg(row(one_person, reason, set_by_account_id,
    set_by_membership_id, organization_id, correlation_id)::text, ';')
  from identity.facility_lab_check_settings where facility_id = 'b1100000-0000-4000-8000-000000000011'),
  '(t,"Only one scientist works here",b1110000-0000-4000-8000-000000000001,b1130000-0000-4000-8000-000000000001,'
  || 'b1100000-0000-4000-8000-000000000001,onepl-suite-correlation-0001)');
select pg_temp.onepl_expect('2 F1 audit', (select string_agg(row(event.correlation_id, event.actor_type,
    event.actor_subject, event.actor_account_id, event.actor_membership_id, event.organization_id,
    event.facility_id, event.patient_id, event.action, event.outcome, event.resource_type, event.resource_id,
    event.purpose_of_use, event.reason, event.provenance, event.source_system,
    event.details = jsonb_build_object('settingId', setting.id, 'onePersonLab', true, 'previous', false))::text, ';')
  from audit.events event join identity.facility_lab_check_settings setting
    on setting.facility_id = event.facility_id
 where event.action like 'identity.facility.one-person-lab.%'
   and event.facility_id = 'b1100000-0000-4000-8000-000000000011'),
  '(onepl-suite-correlation-0001,staff,synthetic:onepl-adm,b1110000-0000-4000-8000-000000000001,'
  || 'b1130000-0000-4000-8000-000000000001,b1100000-0000-4000-8000-000000000001,'
  || 'b1100000-0000-4000-8000-000000000011,,identity.facility.one-person-lab.on,success,facility,'
  || 'b1100000-0000-4000-8000-000000000011,healthcare-operations,"Only one scientist works here",application,'
  || 'identity-api,t)');
select pg_temp.onepl_expect('2 F2 rows', (select count(*)::text || ' ' || string_agg(event.action || ':'
    || (event.details ->> 'previous'), ',' order by event.sequence_id)
  from audit.events event where event.action like 'identity.facility.one-person-lab.%'
   and event.facility_id = 'b1100000-0000-4000-8000-000000000012'),
  '2 identity.facility.one-person-lab.on:false,identity.facility.one-person-lab.off:true');
select pg_temp.onepl_expect('2 F2 settings', (select count(*)::text from identity.facility_lab_check_settings
  where facility_id = 'b1100000-0000-4000-8000-000000000012'), '2');
-- The owner cannot change or delete a setting row, nor delete the current row.
select pg_temp.onepl_expect('2 owner update', pg_temp.onepl_try(
  'update identity.facility_lab_check_settings set reason = reason'),
  '55000 identity.facility_lab_check_settings is append-only');
select pg_temp.onepl_expect('2 owner delete', pg_temp.onepl_try('delete from identity.facility_lab_check_settings'),
  '55000 identity.facility_lab_check_settings is append-only');
select pg_temp.onepl_expect('2 owner delete current', pg_temp.onepl_try('delete from identity.facility_lab_check_current'),
  '55000 identity.facility_lab_check_current is append-only');
select set_config('onepl.setting_on', (select setting_id::text from identity.facility_lab_check_current
  where facility_id = 'b1100000-0000-4000-8000-000000000011'), true);
select set_config('onepl.setting_f2', (select setting_id::text from identity.facility_lab_check_current
  where facility_id = 'b1100000-0000-4000-8000-000000000012'), true);

-- 3. On.
set local role hid_lab_api_runtime;
select pg_temp.onepl_session('A', 'direct-care');
select pg_temp.onepl_expect('3 lab read at F1', lab.one_person_lab_enabled()::text, 'true');
select pg_temp.onepl_expect('3 A without self_check', pg_temp.onepl_try(pg_temp.onepl_verify(2, 1, 'A', false,
  'Manual result verified')), '23514 LAB_RESULT_SELF_CHECK_REASON_REQUIRED');
select pg_temp.onepl_expect('3 A with a 7-character reason', pg_temp.onepl_try(pg_temp.onepl_verify(2, 1, 'A', true,
  'checked')), '22023 LAB_RESULT_SELF_CHECK_REASON_INVALID');
select pg_temp.onepl_expect('3 A with a padded reason', pg_temp.onepl_try(pg_temp.onepl_verify(2, 1, 'A', true,
  '    checked     ')), '22023 LAB_RESULT_SELF_CHECK_REASON_INVALID');
select pg_temp.onepl_expect('3 A with a 501-character reason', pg_temp.onepl_try(pg_temp.onepl_verify(2, 1, 'A', true,
  repeat('y', 501))), '22023 LAB_RESULT_SELF_CHECK_REASON_INVALID');
-- B (not the enterer) may not ask a self-check.
select pg_temp.onepl_session('B', 'direct-care');
select pg_temp.onepl_expect('3 B asks a self-check', pg_temp.onepl_try(pg_temp.onepl_verify(2, 1, 'B', true,
  'I would like to check this myself')), '23514 LAB_RESULT_SELF_CHECK_NOT_YOURS');
-- B's ordinary check with a forged setting id: the id is dropped.
select pg_temp.onepl_expect('3 B with a forged setting id', pg_temp.onepl_try(pg_temp.onepl_verify(3, 1, 'B', false,
  'Manual result verified', current_setting('onepl.setting_on')::uuid)), 'ok');
-- A's self-check with the other facility's setting id: replaced by F1's.
select pg_temp.onepl_session('A', 'direct-care');
select pg_temp.onepl_expect('3 A self-check', pg_temp.onepl_try(pg_temp.onepl_verify(2, 1, 'A', true,
  '  I am the only scientist at this lab  ', current_setting('onepl.setting_f2')::uuid)), 'ok');
reset role;
select pg_temp.onepl_expect('3 the self-check row', (select row(self_check, one_person_setting_id::text =
    current_setting('onepl.setting_on'), reason, verified_by)::text
  from lab.result_verifications where result_id = 'b11c0000-0000-4000-8000-000000000012' and result_version = 1),
  '(t,t,"  I am the only scientist at this lab  ",b1110000-0000-4000-8000-000000000002)');
select pg_temp.onepl_expect('3 B''s row', (select self_check::text || ' ' || coalesce(one_person_setting_id::text, 'null')
  from lab.result_verifications where result_id = 'b11c0000-0000-4000-8000-000000000013'), 'false null');
select set_config('onepl.verification_2_1', (select id::text from lab.result_verifications
  where result_id = 'b11c0000-0000-4000-8000-000000000012' and result_version = 1), true);
-- A releases the self-checked version.
set local role hid_lab_api_runtime;
select pg_temp.onepl_session('A', 'direct-care');
select pg_temp.onepl_expect('3 A releases', pg_temp.onepl_try(pg_temp.onepl_release(2, 1, 'A')), 'ok');
reset role;
-- A correction v2 by A needs its own self-check.
set local session_replication_role = replica;
update lab.results set current_version = 2 where id = 'b11c0000-0000-4000-8000-000000000012';
insert into lab.result_revisions (id, result_id, execution_id, patient_id, facility_id, version, result_type,
  numeric_value, unit, entered_by, entered_by_membership_id, idempotency_key, request_sha256, correlation_id,
  revision_kind, supersedes_version, correction_reason) values
  ('b11c0000-0000-4000-8000-000000000032', 'b11c0000-0000-4000-8000-000000000012',
   'b11c0000-0000-4000-8000-000000000002', 'b1150000-0000-4000-8000-000000000001',
   'b1100000-0000-4000-8000-000000000011', 2, 'numeric', 13.1, 'g/dL', 'b1110000-0000-4000-8000-000000000002',
   'b1130000-0000-4000-8000-000000000002', 'onepl-fixture-correction-2', repeat('a', 64), 'onepl-fixture',
   'correction', 1, 'Transcription error corrected');
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.onepl_session('A', 'direct-care');
select pg_temp.onepl_expect('3 v2 without self_check', pg_temp.onepl_try(pg_temp.onepl_verify(2, 2, 'A', false,
  'Manual result verified')), '23514 LAB_RESULT_SELF_CHECK_REASON_REQUIRED');
select pg_temp.onepl_expect('3 v2 self-check', pg_temp.onepl_try(pg_temp.onepl_verify(2, 2, 'A', true,
  'Rechecked the corrected value myself')), 'ok');
-- The other facility is off: G may not check G's own result.
select pg_temp.onepl_session('G', 'direct-care');
select pg_temp.onepl_expect('3 lab read at F2', lab.one_person_lab_enabled()::text, 'false');
select pg_temp.onepl_expect('3 G self-check at F2', pg_temp.onepl_try(pg_temp.onepl_verify(6, 1, 'G', true,
  'I am the only scientist at this lab')), '23514 LAB_RESULT_SECOND_CHECK_REQUIRED');
-- The read reveals nothing without an active membership at the facility.
select pg_temp.onepl_session('A', 'direct-care', null, '');
select pg_temp.onepl_expect('3 lab read without membership', lab.one_person_lab_enabled()::text, 'false');
select pg_temp.onepl_session('G', 'direct-care', 'b1100000-0000-4000-8000-000000000011');
select pg_temp.onepl_expect('3 lab read at F1 with an F2 membership', lab.one_person_lab_enabled()::text, 'false');
select pg_temp.onepl_session('I', 'direct-care');
select pg_temp.onepl_expect('3 lab read with an inactive membership', lab.one_person_lab_enabled()::text, 'false');
select pg_temp.onepl_session('nobody', 'direct-care', 'b1100000-0000-4000-8000-000000000011',
  'b1130000-0000-4000-8000-000000000002');
select pg_temp.onepl_expect('3 lab read by an unknown subject', lab.one_person_lab_enabled()::text, 'false');
reset role;

-- 4. Off again.
set local role hid_identity_api_runtime;
select pg_temp.onepl_session('ADM', 'healthcare-operations');
select pg_temp.onepl_expect('4 off', pg_temp.onepl_try(pg_temp.onepl_set(false, 'A second scientist has joined')), 'ok');
select pg_temp.onepl_expect('4 state', (select row(enabled, reason)::text from identity.facility_one_person_lab_state()),
  '(f,"A second scientist has joined")');
set local role hid_lab_api_runtime;
select pg_temp.onepl_session('A', 'direct-care');
select pg_temp.onepl_expect('4 lab read', lab.one_person_lab_enabled()::text, 'false');
select pg_temp.onepl_expect('4 A self-check', pg_temp.onepl_try(pg_temp.onepl_verify(5, 1, 'A', true,
  'I am the only scientist at this lab')), '23514 LAB_RESULT_SECOND_CHECK_REQUIRED');
select pg_temp.onepl_expect('4 A without self_check', pg_temp.onepl_try(pg_temp.onepl_verify(1, 1, 'A', false,
  'Manual result verified')), '23514 LAB_RESULT_SECOND_CHECK_REQUIRED');
reset role;
select pg_temp.onepl_expect('4 the earlier self-check is kept', (select row(self_check, one_person_setting_id::text =
    current_setting('onepl.setting_on'))::text
  from lab.result_verifications where result_id = 'b11c0000-0000-4000-8000-000000000012' and result_version = 1),
  '(t,t)');
select pg_temp.onepl_expect('4 the earlier self-check is immutable', left(pg_temp.onepl_try(
  'update lab.result_verifications set self_check = false, one_person_setting_id = null where result_id = '
  || quote_literal('b11c0000-0000-4000-8000-000000000012')), 5), '55000');
select pg_temp.onepl_expect('4 audit F1', (select string_agg(event.action || ':' || (event.details ->> 'previous'), ','
    order by event.sequence_id)
  from audit.events event where event.action like 'identity.facility.one-person-lab.%'
   and event.facility_id = 'b1100000-0000-4000-8000-000000000011'),
  'identity.facility.one-person-lab.on:false,identity.facility.one-person-lab.off:true');

-- 5. Unchanged behaviour. Switch F1 on again for the cases that need it.
set local role hid_identity_api_runtime;
select pg_temp.onepl_session('ADM', 'healthcare-operations');
select pg_temp.onepl_expect('5 on', pg_temp.onepl_try(pg_temp.onepl_set(true, 'Second scientist left again')), 'ok');
set local role hid_lab_api_runtime;
select pg_temp.onepl_session('B', 'direct-care');
select pg_temp.onepl_expect('5 invalidated, another person', pg_temp.onepl_try(pg_temp.onepl_verify(4, 1, 'B', false,
  'Manual result verified')), '23514 Result verifier must be independent and result must be eligible');
select pg_temp.onepl_session('A', 'direct-care');
select pg_temp.onepl_expect('5 invalidated, a self-check', pg_temp.onepl_try(pg_temp.onepl_verify(4, 1, 'A', true,
  'I am the only scientist at this lab')), '23514 Result verifier must be independent and result must be eligible');
select pg_temp.onepl_expect('5 wrong version', pg_temp.onepl_try(pg_temp.onepl_verify(5, 2, 'A', true,
  'I am the only scientist at this lab')), '23514 Governance command must bind the exact current result version');
select pg_temp.onepl_expect('5 another verifier', pg_temp.onepl_try(replace(pg_temp.onepl_verify(5, 1, 'A', true,
  'I am the only scientist at this lab'), 'b1110000-0000-4000-8000-000000000002', 'b1110000-0000-4000-8000-000000000003')),
  '42501 Verifier must match authenticated database context');
select pg_temp.onepl_expect('5 release without verification', pg_temp.onepl_try(pg_temp.onepl_release(5, 1, 'A')),
  '23514 Release requires exact valid verification');
select pg_temp.onepl_expect('5 release by another actor', pg_temp.onepl_try(replace(pg_temp.onepl_release(2, 2, 'A'),
  'b1130000-0000-4000-8000-000000000002', 'b1130000-0000-4000-8000-000000000003')),
  '42501 Release actor must match authenticated database context');
select pg_temp.onepl_expect('5 invalidation by another actor', pg_temp.onepl_try(format(
  $i$insert into lab.result_invalidations(result_id,execution_id,patient_id,facility_id,result_version,disposition,
    actor_id,actor_membership_id,reason,idempotency_key,request_sha256,correlation_id)
    values('b11c0000-0000-4000-8000-000000000015','b11c0000-0000-4000-8000-000000000005',
    'b1150000-0000-4000-8000-000000000001','b1100000-0000-4000-8000-000000000011',1,'entered_in_error',
    'b1110000-0000-4000-8000-000000000003','b1130000-0000-4000-8000-000000000003','Synthetic entered in error',
    'onepl-suite-invalidation',repeat('b',64),'onepl-suite-correlation-0001')$i$)),
  '42501 Invalidation actor must match authenticated database context');
reset role;
-- The check constraint and the foreign key, past the governance trigger
-- (disabled for these inserts only): a self-check needs a setting of its
-- facility and a reason of 10-500 characters, and a setting needs a
-- self-check.
alter table lab.result_verifications disable trigger lab_verification_validate;
select pg_temp.onepl_expect('5 self_check without a setting', pg_temp.onepl_try(pg_temp.onepl_verify(5, 1, 'A', true,
  'I am the only scientist at this lab')),
  '23514 new row for relation "result_verifications" violates check constraint "result_verifications_self_check_ck"');
select pg_temp.onepl_expect('5 a setting without self_check', pg_temp.onepl_try(pg_temp.onepl_verify(5, 1, 'B', false,
  'I am the only scientist at this lab', current_setting('onepl.setting_on')::uuid)),
  '23514 new row for relation "result_verifications" violates check constraint "result_verifications_self_check_ck"');
select pg_temp.onepl_expect('5 a self-check with a short reason', pg_temp.onepl_try(pg_temp.onepl_verify(5, 1, 'A', true,
  'checked', current_setting('onepl.setting_on')::uuid)),
  '23514 new row for relation "result_verifications" violates check constraint "result_verifications_self_check_ck"');
select pg_temp.onepl_expect('5 another facility''s setting', left(pg_temp.onepl_try(pg_temp.onepl_verify(5, 1, 'A', true,
  'I am the only scientist at this lab', current_setting('onepl.setting_f2')::uuid)), 5), '23503');
alter table lab.result_verifications enable trigger lab_verification_validate;

rollback;
