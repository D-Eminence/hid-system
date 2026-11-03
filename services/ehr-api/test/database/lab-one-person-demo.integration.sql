\set ON_ERROR_STOP on
-- 0111, owner decision of 3 Nov 2026 13:00: One-person lab ON at the sealed
-- demo's Demo Laboratory only. Rollback-only. On the databases CI and the
-- release rehearsals use (plain PostgreSQL, no rds_superuser) 0098 installs
-- the seal and not the seed, and 0111 installs identity.demo_one_person_lab_install()
-- without calling it, so this suite calls identity.sealed_demo_install() and
-- then the 0111 install itself, as the owner, inside its transaction.
--   1. structure: the install is the owner's, SECURITY DEFINER, granted to
--      no role, and the migration switched nothing on here;
--   2. refusals, each writing nothing: before 0098's install (no demo), and
--      with a demo id no longer as 0098 left it; the owner's pre-sign check
--      (0111 header 7) answers false in both and true after 0098's install;
--   3. the install: one setting row (fixed id, one_person true, the plain
--      reason, the demo login's Demo Laboratory membership, the correlation
--      id), its current row, one migration audit row naming no person; a
--      second call writes nothing;
--   4. ON at Demo Laboratory and OFF at every other facility, demo or real:
--      in the tables, through lab.one_person_lab_enabled() as the demo
--      login at each of the four demo facilities, through the
--      administrator's read, and through the governance trigger (a
--      self-check at Demo Laboratory is accepted with the seeded setting; the
--      same at Demo Hospital is LAB_RESULT_SECOND_CHECK_REQUIRED);
--   5. the seal still holds: the demo's members unchanged, the seal's
--      triggers unchanged, a real account still cannot join Demo
--      Laboratory, a real administrator cannot switch Demo Laboratory, and
--      the demo login may switch it off there as any facility administrator.
begin;

create function pg_temp.demo_assert(label text, condition boolean, detail text default null)
returns void language plpgsql as $f$
begin
  if condition is not true then
    raise exception 'one-person demo: % failed%', label, coalesce(': ' || detail, '');
  end if;
end
$f$;
create function pg_temp.demo_try(statement text)
returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The effective switch of every facility (the newest setting, else off).
create function pg_temp.demo_switches()
returns table (facility_id uuid, one_person boolean) language sql as $f$
  select facility.id, coalesce(setting.one_person, false)
    from identity.facilities facility
    left join identity.facility_lab_check_current current_state on current_state.facility_id = facility.id
    left join identity.facility_lab_check_settings setting
      on setting.id = current_state.setting_id and setting.facility_id = current_state.facility_id
$f$;
create function pg_temp.demo_counts()
returns text language sql as $f$
  select concat_ws(',', (select count(*) from identity.facility_lab_check_settings),
    (select count(*) from identity.facility_lab_check_current), (select count(*) from audit.events),
    (select count(*) from identity.sealed_demo_members))
$f$;
-- The owner's pre-sign check, the text of 0111's header 7 (keep the two in
-- step): true exactly when the install's refusal test passes.
create function pg_temp.demo_laboratory_ready()
returns boolean language sql as $f$
  select identity.sealed_demo_facility('98d00002-0000-4000-8000-000000000002')
     and identity.sealed_demo_account('98d00003-0000-4000-8000-000000000001')
     and exists (select 1 from identity.sealed_demo_members m
                  where m.member_kind = 'organization'
                    and m.member_id = '98d00001-0000-4000-8000-000000000002')
     and exists (select 1 from identity.facilities f
                  where f.id = '98d00002-0000-4000-8000-000000000002'
                    and f.organization_id = '98d00001-0000-4000-8000-000000000002'
                    and upper(f.code) = 'DEMO-LABORATORY')
     and exists (select 1 from identity.staff_facility_memberships s
                  where s.id = '98d00005-0000-4000-8000-000000000002'
                    and s.account_id = '98d00003-0000-4000-8000-000000000001'
                    and s.facility_id = '98d00002-0000-4000-8000-000000000002'
                    and s.organization_id = '98d00001-0000-4000-8000-000000000002')
         as demo_laboratory_ready
$f$;
-- The demo login's session at demo facility n (1 Hospital, 2 Laboratory,
-- 3 Pharmacy, 4 Outreach), as the services' DatabaseService sets it.
create function pg_temp.as_demo(site integer, purpose text)
returns void language sql as $f$
  select set_config('app.actor_subject', 'sealed-demo:98d00003-0000-4000-8000-000000000001', true),
    set_config('app.membership_id', '98d00005-0000-4000-8000-00000000000' || site, true),
    set_config('app.facility_id', '98d00002-0000-4000-8000-00000000000' || site, true),
    set_config('app.correlation_id', 'onepl-demo-correlation-' || site, true),
    set_config('app.purpose_of_use', purpose, true);
$f$;

-- 1. Structure, and nothing switched on by the migration on this database.
do $$
begin
  perform pg_temp.demo_assert('the install is the identity owner''s, SECURITY DEFINER, with its search path',
    exists (select 1 from pg_proc proc
             where proc.oid = 'identity.demo_one_person_lab_install()'::regprocedure
               and proc.proowner = (select nspowner from pg_namespace where nspname = 'identity')
               and proc.prosecdef and proc.proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[]));
  perform pg_temp.demo_assert('no role but the owner may run the install',
    not exists (select 1 from pg_roles role_row
                 where role_row.oid <> (select proowner from pg_proc
                                         where oid = 'identity.demo_one_person_lab_install()'::regprocedure)
                   and not role_row.rolsuper
                   and has_function_privilege(role_row.oid, 'identity.demo_one_person_lab_install()', 'execute')));
  perform pg_temp.demo_assert('the migration switched One-person lab on nowhere here (not Amazon RDS)',
    not exists (select 1 from identity.facility_lab_check_settings
                 where id = '98d0000b-0000-4000-8000-000000000001'
                    or correlation_id = '0111-sealed-demo-one-person-lab')
    and not exists (select 1 from audit.events where correlation_id = '0111-sealed-demo-one-person-lab'));
end $$;

-- 2a. Before 0098's install there is no demo: refused, nothing written.
savepoint no_demo;
create temporary table demo_before_install on commit drop as select pg_temp.demo_counts() as counts;
select pg_temp.demo_assert('without the sealed demo the owner''s pre-sign check answers false',
  pg_temp.demo_laboratory_ready() is false);
select pg_temp.demo_assert('without the sealed demo the install is refused',
  pg_temp.demo_try('select identity.demo_one_person_lab_install()') = '55000 0111: SEALED_DEMO_LAB_CHECK_NOT_DEMO');
select pg_temp.demo_assert('the refusal wrote nothing', pg_temp.demo_counts() = (select counts from demo_before_install));
rollback to savepoint no_demo;

select identity.sealed_demo_install() is not null as sealed_demo_installed;
select pg_temp.demo_assert('after 0098''s install the owner''s pre-sign check answers true',
  pg_temp.demo_laboratory_ready());
create temporary table demo_seal_before on commit drop as
  select (select md5(string_agg(member.member_kind || ':' || member.member_id::text, ',' order by member.member_kind,
                                member.member_id)) from identity.sealed_demo_members member) as members,
         (select md5(string_agg(trigger_row.tgname || ':' || trigger_row.tgenabled::text || ':' || pg_get_triggerdef(trigger_row.oid),
                                ',' order by trigger_row.tgname))
            from pg_trigger trigger_row where trigger_row.tgname like '%sealed_demo%' and not trigger_row.tgisinternal)
           as triggers,
         (select count(*) from pg_trigger trigger_row where trigger_row.tgname like '%sealed_demo%'
             and not trigger_row.tgisinternal and trigger_row.tgenabled = 'O') as enabled_triggers;

-- 2b. A demo id no longer as 0098 left it: refused, nothing written.
savepoint not_demo;
create temporary table demo_before_refusal on commit drop as select pg_temp.demo_counts() as counts;
update identity.facilities set code = 'DEMO-LAB-RENAMED' where id = '98d00002-0000-4000-8000-000000000002';
select pg_temp.demo_assert('with another Demo Laboratory code the owner''s pre-sign check answers false',
  pg_temp.demo_laboratory_ready() is false);
select pg_temp.demo_assert('Demo Laboratory with another code is refused',
  pg_temp.demo_try('select identity.demo_one_person_lab_install()') = '55000 0111: SEALED_DEMO_LAB_CHECK_NOT_DEMO');
select pg_temp.demo_assert('that refusal wrote nothing', pg_temp.demo_counts() = (select counts from demo_before_refusal));
rollback to savepoint not_demo;

-- 3. The install, once.
create temporary table demo_counts_before on commit drop as
  select (select count(*) from identity.facility_lab_check_settings) as settings,
         (select count(*) from identity.facility_lab_check_current) as current_rows,
         (select count(*) from audit.events) as audit_rows,
         (select max(sequence_id) from audit.events) as last_audit;
select pg_temp.demo_assert('the install writes one setting',
  identity.demo_one_person_lab_install() = '{"settings": 1}'::jsonb);
do $$
begin
  perform pg_temp.demo_assert('one setting row, at Demo Laboratory, as the header says',
    (select count(*) from identity.facility_lab_check_settings) = (select settings + 1 from demo_counts_before)
    and exists (select 1 from identity.facility_lab_check_settings setting
                 where setting.id = '98d0000b-0000-4000-8000-000000000001'
                   and setting.facility_id = '98d00002-0000-4000-8000-000000000002'
                   and setting.organization_id = '98d00001-0000-4000-8000-000000000002'
                   and setting.one_person
                   and setting.reason = 'Demo Laboratory works as a one-person lab for the demo (owner decision, 3 Nov 2026).'
                   and setting.set_by_account_id = '98d00003-0000-4000-8000-000000000001'
                   and setting.set_by_membership_id = '98d00005-0000-4000-8000-000000000002'
                   and setting.correlation_id = '0111-sealed-demo-one-person-lab'));
  perform pg_temp.demo_assert('its current row',
    (select count(*) from identity.facility_lab_check_current) = (select current_rows + 1 from demo_counts_before)
    and exists (select 1 from identity.facility_lab_check_current current_state
                 where current_state.facility_id = '98d00002-0000-4000-8000-000000000002'
                   and current_state.setting_id = '98d0000b-0000-4000-8000-000000000001'));
  perform pg_temp.demo_assert('one audit row, the migration''s own, naming no person',
    (select count(*) from audit.events) = (select audit_rows + 1 from demo_counts_before)
    and exists (select 1 from audit.events event
                 where event.sequence_id > (select coalesce(last_audit, 0) from demo_counts_before)
                   and event.correlation_id = '0111-sealed-demo-one-person-lab'
                   and event.actor_type = 'system' and event.actor_subject is null
                   and event.actor_account_id is null and event.actor_membership_id is null
                   and event.patient_id is null
                   and event.organization_id = '98d00001-0000-4000-8000-000000000002'
                   and event.facility_id = '98d00002-0000-4000-8000-000000000002'
                   and event.action = 'identity.facility.one-person-lab.on' and event.outcome = 'success'
                   and event.resource_type = 'facility' and event.resource_id = '98d00002-0000-4000-8000-000000000002'
                   and event.provenance = 'migration' and event.source_system = 'hid-sealed-demo'
                   and event.reason = 'Demo Laboratory works as a one-person lab for the demo (owner decision, 3 Nov 2026).'
                   and event.details = jsonb_build_object('settingId', '98d0000b-0000-4000-8000-000000000001',
                                                          'onePersonLab', true, 'previous', false)));
end $$;
create temporary table demo_after_install on commit drop as select pg_temp.demo_counts() as counts;
select pg_temp.demo_assert('a second call writes nothing',
  identity.demo_one_person_lab_install() = '{"settings": 0}'::jsonb
  and pg_temp.demo_counts() = (select counts from demo_after_install));

-- 4a. In the tables: ON at Demo Laboratory, OFF at every other facility
-- (the other three demo facilities among them).
do $$
begin
  perform pg_temp.demo_assert('the four demo facilities are there',
    (select count(*) from pg_temp.demo_switches() switch
      where switch.facility_id in ('98d00002-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000002',
                                   '98d00002-0000-4000-8000-000000000003', '98d00002-0000-4000-8000-000000000004')) = 4);
  perform pg_temp.demo_assert('ON at Demo Laboratory and at no other facility',
    (select array_agg(switch.facility_id) from pg_temp.demo_switches() switch where switch.one_person)
      = array['98d00002-0000-4000-8000-000000000002'::uuid]
    and (select count(*) from pg_temp.demo_switches() switch where not switch.one_person)
      = (select count(*) - 1 from identity.facilities));
end $$;

-- The owner's password reset makes the demo login active (as 0098's and
-- 0102's suites do through recovery; here directly, undone with the suite).
set local session_replication_role = replica;
update auth.accounts set status = 'active' where id = '98d00003-0000-4000-8000-000000000001';
-- A real organization, facility and administrator, and a real lab account
-- (the suite's own, not demo).
insert into identity.organizations (id, name, slug) values
  ('b1200000-0000-4000-8000-000000000001', 'One Person Demo Real Org', 'one-person-demo-real-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('b1200000-0000-4000-8000-000000000011', 'b1200000-0000-4000-8000-000000000001', 'One Person Demo Real Lab',
   'ONE-PERSON-DEMO-REAL', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('b1210000-0000-4000-8000-000000000001', 'synthetic:onepl-demo-admin', 'onepl-demo-admin@example.invalid',
   'Real Admin', 'active'),
  ('b1210000-0000-4000-8000-000000000002', 'synthetic:onepl-demo-lab', 'onepl-demo-lab@example.invalid',
   'Real Lab', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('b1220000-0000-4000-8000-000000000001', 'b1210000-0000-4000-8000-000000000001', 'Real Admin',
   'onepl-demo-admin@example.invalid', 'verified', 'admin'),
  ('b1220000-0000-4000-8000-000000000002', 'b1210000-0000-4000-8000-000000000002', 'Real Lab',
   'onepl-demo-lab@example.invalid', 'verified', 'lab');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('b1230000-0000-4000-8000-000000000001', 'b1220000-0000-4000-8000-000000000001',
   'b1210000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000001',
   'b1200000-0000-4000-8000-000000000011', 'admin', 'admin', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('b1240000-0000-4000-8000-000000000001', 'b1210000-0000-4000-8000-000000000001', 'admin', 'facility',
   'b1230000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000011', 'Synthetic one-person demo test');
-- Lab chains for Demo Patient Three (fictional): chain 1 at Demo Laboratory,
-- chain 2 at Demo Hospital, each a version 1 entered by the demo login's lab
-- or doctor membership there, with its consent there for direct care.
create temporary table demo_chain (n int primary key, facility uuid, membership uuid) on commit drop;
insert into demo_chain values
  (1, '98d00002-0000-4000-8000-000000000002', '98d00005-0000-4000-8000-000000000002'),
  (2, '98d00002-0000-4000-8000-000000000001', '98d00005-0000-4000-8000-000000000001');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, break_glass, purpose_of_use)
select ('b1260000-0000-4000-8000-00000000000' || n)::uuid, '98d00009-0000-4000-8000-000000000003',
       '98d00004-0000-4000-8000-000000000001', '98d00003-0000-4000-8000-000000000001', membership, facility,
       'write_records', 'active', 'Synthetic one-person demo consent', clock_timestamp() - interval '1 hour',
       clock_timestamp() + interval '1 day', false, 'direct-care'
  from demo_chain;
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at)
select ('b1280000-0000-4000-8000-00000000000' || n)::uuid, '98d00009-0000-4000-8000-000000000003', facility,
       '98d00003-0000-4000-8000-000000000001', membership, 'ambulatory', 'in_progress', clock_timestamp()
  from demo_chain;
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, clinical_information, created_at)
select ('b1290000-0000-4000-8000-00000000000' || n)::uuid, ('b1280000-0000-4000-8000-00000000000' || n)::uuid,
       '98d00009-0000-4000-8000-000000000003', facility, '98d00003-0000-4000-8000-000000000001', membership,
       'http://loinc.org', '718-7', 'Haemoglobin', 'routine', 'active', 'Synthetic one-person demo order',
       '2026-11-03 09:00:00+00'
  from demo_chain;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, priority, test_code_system, test_code, test_name,
  clinical_indication, requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key,
  request_sha256, correlation_id)
select ('b12a0000-0000-4000-8000-00000000000' || n)::uuid, '98d00009-0000-4000-8000-000000000003', facility,
       facility, ('b1290000-0000-4000-8000-00000000000' || n)::uuid, 1,
       ('b1280000-0000-4000-8000-00000000000' || n)::uuid, 'routine', 'http://loinc.org', '718-7', 'Haemoglobin',
       'Synthetic one-person demo order', '98d00003-0000-4000-8000-000000000001', '2026-11-03 09:00:00+00',
       '98d00003-0000-4000-8000-000000000001', membership, 'onepl-demo-work-' || n, repeat('a', 64),
       'onepl-demo-fixture'
  from demo_chain;
insert into lab.work_item_requested_tests (id, work_item_id, facility_id, patient_id, ordinal, code_system, code,
  name)
select ('b12a0000-0000-4000-8000-00000000001' || n)::uuid, ('b12a0000-0000-4000-8000-00000000000' || n)::uuid,
       facility, '98d00009-0000-4000-8000-000000000003', 1, 'http://loinc.org', '718-7', 'Haemoglobin'
  from demo_chain;
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
select ('b12b0000-0000-4000-8000-00000000000' || n)::uuid, ('b12a0000-0000-4000-8000-00000000000' || n)::uuid,
       '98d00009-0000-4000-8000-000000000003', facility, 'routine', '98d00003-0000-4000-8000-000000000001',
       membership, 'onepl-demo-accession-' || n, repeat('a', 64), 'onepl-demo-fixture'
  from demo_chain;
insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
select ('b12b0000-0000-4000-8000-00000000001' || n)::uuid, ('b12b0000-0000-4000-8000-00000000000' || n)::uuid,
       '98d00009-0000-4000-8000-000000000003', facility, 1, 'whole blood'
  from demo_chain;
insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
  collected_at, collected_by, collected_by_membership_id, received_at, received_by, received_by_membership_id,
  row_version)
select ('b12b0000-0000-4000-8000-00000000002' || n)::uuid, ('b12b0000-0000-4000-8000-00000000001' || n)::uuid,
       ('b12b0000-0000-4000-8000-00000000000' || n)::uuid, '98d00009-0000-4000-8000-000000000003', facility,
       'whole blood', 'received', clock_timestamp(), '98d00003-0000-4000-8000-000000000001', membership,
       clock_timestamp(), '98d00003-0000-4000-8000-000000000001', membership, 3
  from demo_chain;
insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
  started_by, started_by_membership_id, started_at, completed_by, completed_by_membership_id, completed_at,
  idempotency_key, request_sha256, correlation_id, row_version)
select ('b12c0000-0000-4000-8000-00000000000' || n)::uuid, ('b12b0000-0000-4000-8000-00000000000' || n)::uuid,
       ('b12b0000-0000-4000-8000-00000000002' || n)::uuid, ('b12a0000-0000-4000-8000-00000000001' || n)::uuid,
       '98d00009-0000-4000-8000-000000000003', facility, 'completed', '98d00003-0000-4000-8000-000000000001',
       membership, clock_timestamp(), '98d00003-0000-4000-8000-000000000001', membership, clock_timestamp(),
       'onepl-demo-execution-' || n, repeat('a', 64), 'onepl-demo-fixture', 2
  from demo_chain;
insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id)
select ('b12c0000-0000-4000-8000-00000000001' || n)::uuid, ('b12c0000-0000-4000-8000-00000000000' || n)::uuid,
       '98d00009-0000-4000-8000-000000000003', facility, '98d00003-0000-4000-8000-000000000001', membership
  from demo_chain;
insert into lab.result_revisions (id, result_id, execution_id, patient_id, facility_id, version, result_type,
  numeric_value, unit, entered_by, entered_by_membership_id, idempotency_key, request_sha256, correlation_id,
  revision_kind)
select ('b12c0000-0000-4000-8000-00000000002' || n)::uuid, ('b12c0000-0000-4000-8000-00000000001' || n)::uuid,
       ('b12c0000-0000-4000-8000-00000000000' || n)::uuid, '98d00009-0000-4000-8000-000000000003', facility, 1,
       'numeric', 12.5, 'g/dL', '98d00003-0000-4000-8000-000000000001', membership, 'onepl-demo-result-' || n,
       repeat('a', 64), 'onepl-demo-fixture', 'original'
  from demo_chain;
set local session_replication_role = origin;

-- The Lab API's verification insert (lab-executions.service.ts govern) for
-- chain n, as the demo login, a self-check with a typed reason.
create function pg_temp.demo_self_check(chain integer)
returns text language sql as $f$
  select format($q$insert into lab.result_verifications(result_id, execution_id, patient_id, facility_id,
    result_version, verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256,
    correlation_id, self_check) values (%L, %L, '98d00009-0000-4000-8000-000000000003', %L, 1,
    '98d00003-0000-4000-8000-000000000001', %L, clock_timestamp(), 'I am the only scientist on duty today',
    %L, repeat('b', 64), current_setting('app.correlation_id'), true)$q$,
    'b12c0000-0000-4000-8000-00000000001' || chain, 'b12c0000-0000-4000-8000-00000000000' || chain,
    (select facility from demo_chain where n = chain), (select membership from demo_chain where n = chain),
    'onepl-demo-check-' || chain)
$f$;
grant select on demo_chain to public;

-- 4b. lab.one_person_lab_enabled() as the demo login at each demo facility.
set local role hid_lab_api_runtime;
select pg_temp.as_demo(2, 'direct-care');
select pg_temp.demo_assert('the Lab API reads ON at Demo Laboratory', lab.one_person_lab_enabled());
select pg_temp.as_demo(1, 'direct-care');
select pg_temp.demo_assert('the Lab API reads OFF at Demo Hospital', not lab.one_person_lab_enabled());
select pg_temp.as_demo(3, 'direct-care');
select pg_temp.demo_assert('the Lab API reads OFF at Demo Pharmacy', not lab.one_person_lab_enabled());
select pg_temp.as_demo(4, 'direct-care');
select pg_temp.demo_assert('the Lab API reads OFF at Demo Outreach', not lab.one_person_lab_enabled());
reset role;

-- 4c. The governance trigger: the demo login's self-check at Demo
-- Laboratory is accepted with the seeded setting; at Demo Hospital it is
-- refused.
savepoint demo_checks;
set local role hid_lab_api_runtime;
select pg_temp.as_demo(1, 'direct-care');
select pg_temp.demo_assert('a self-check at Demo Hospital is LAB_RESULT_SECOND_CHECK_REQUIRED',
  pg_temp.demo_try(pg_temp.demo_self_check(2)) = '23514 LAB_RESULT_SECOND_CHECK_REQUIRED',
  pg_temp.demo_try(pg_temp.demo_self_check(2)));
select pg_temp.as_demo(2, 'direct-care');
select pg_temp.demo_assert('a self-check at Demo Laboratory is accepted',
  pg_temp.demo_try(pg_temp.demo_self_check(1)) = 'ok', pg_temp.demo_try(pg_temp.demo_self_check(1)));
reset role;
select pg_temp.demo_assert('it records self_check and the seeded setting',
  exists (select 1 from lab.result_verifications verification
           where verification.result_id = 'b12c0000-0000-4000-8000-000000000011'
             and verification.self_check
             and verification.one_person_setting_id = '98d0000b-0000-4000-8000-000000000001')
  and not exists (select 1 from lab.result_verifications
                   where result_id = 'b12c0000-0000-4000-8000-000000000012'));
rollback to savepoint demo_checks;

-- 4d. The administrator's read at Demo Laboratory (the demo login is
-- org_admin there) and at Demo Hospital.
set local role hid_identity_api_runtime;
select pg_temp.as_demo(2, 'healthcare-operations');
select pg_temp.demo_assert('the administrator reads ON at Demo Laboratory, with the plain reason',
  (select enabled and reason = 'Demo Laboratory works as a one-person lab for the demo (owner decision, 3 Nov 2026).'
     from identity.facility_one_person_lab_state()));
select pg_temp.as_demo(1, 'healthcare-operations');
select pg_temp.demo_assert('the administrator reads OFF at Demo Hospital',
  (select not enabled and reason is null from identity.facility_one_person_lab_state()));
reset role;

-- 5. The seal still holds.
do $$
begin
  perform pg_temp.demo_assert('the demo''s members are unchanged',
    (select md5(string_agg(member.member_kind || ':' || member.member_id::text, ',' order by member.member_kind,
                           member.member_id)) from identity.sealed_demo_members member)
      = (select members from demo_seal_before));
  perform pg_temp.demo_assert('the seal''s triggers are unchanged and enabled',
    (select md5(string_agg(trigger_row.tgname || ':' || trigger_row.tgenabled::text || ':' || pg_get_triggerdef(trigger_row.oid),
                           ',' order by trigger_row.tgname))
       from pg_trigger trigger_row where trigger_row.tgname like '%sealed_demo%' and not trigger_row.tgisinternal)
      = (select triggers from demo_seal_before)
    and (select enabled_triggers from demo_seal_before) > 0);
  perform pg_temp.demo_assert('a real account still cannot join Demo Laboratory',
    pg_temp.demo_try($q$insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
      facility_id, membership_role, app_role, is_primary, active) values ('b1230000-0000-4000-8000-000000000002',
      'b1220000-0000-4000-8000-000000000002', 'b1210000-0000-4000-8000-000000000002',
      '98d00001-0000-4000-8000-000000000002', '98d00002-0000-4000-8000-000000000002', 'lab', 'lab', true,
      true)$q$) = '42501 SEALED_DEMO_MEMBERSHIP_REFUSED');
end $$;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:onepl-demo-admin', true),
  set_config('app.membership_id', 'b1230000-0000-4000-8000-000000000001', true),
  set_config('app.facility_id', '98d00002-0000-4000-8000-000000000002', true),
  set_config('app.correlation_id', 'onepl-demo-correlation-real', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select pg_temp.demo_assert('a real administrator cannot switch Demo Laboratory',
  pg_temp.demo_try($q$select * from identity.set_facility_one_person_lab(false, 'A real administrator tries the demo')$q$)
    = '42501 FACILITY_SETTING_PERMISSION_DENIED');
select set_config('app.facility_id', 'b1200000-0000-4000-8000-000000000011', true);
select pg_temp.demo_assert('the real facility is still OFF for its own administrator',
  (select not enabled from identity.facility_one_person_lab_state()));
reset role;
-- The demo login may switch it off at Demo Laboratory, as any facility
-- administrator may (the setter's rules, not a seal exception).
savepoint demo_off;
set local role hid_identity_api_runtime;
select pg_temp.as_demo(2, 'healthcare-operations');
select pg_temp.demo_assert('the demo login switches Demo Laboratory off',
  (select not enabled from identity.set_facility_one_person_lab(false, 'The demo needs a second scientist again')));
reset role;
select pg_temp.demo_assert('then no facility is ON',
  not exists (select 1 from pg_temp.demo_switches() switch where switch.one_person));
rollback to savepoint demo_off;

rollback;
