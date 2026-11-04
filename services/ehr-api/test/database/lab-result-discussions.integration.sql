\set ON_ERROR_STOP on
-- Lab result discussions (0107, patient chat part 2): the patient gate the Lab
-- API's patient query joins (lab.patient_self_result_gates: finished visits
-- only, and whether a clinician's "Discussed with the patient" mark is active on
-- the last released version), the record, withdraw and list commands, the
-- append-only event table and the owner-only work-item policy. Rollback-only.
-- Fictional data only.
--
-- Fixtures are inserted with session_replication_role = replica (no triggers
-- or foreign-key checks; CHECK constraints still apply). Every case then runs
-- with triggers enforced, as hid_lab_runtime with the app.* settings exactly as
-- lab-api sets them: DatabaseService.withTransaction for staff (actor subject,
-- facility, correlation, membership, purpose) and withPatientTransaction for
-- the patient (subject, account, patient, session, authorized-until,
-- correlation, purpose patient-self, empty facility and membership). Each case
-- records its outcome ('ok', or the SQLSTATE and message it raised) and the
-- suite fails at the end listing every case whose outcome differs. The
-- messages are the codes lab-api maps to its HTTP problems
-- (services/lab-api/src/lab/result-discussions.service.ts).
--
-- When the functions' owner bypasses row-level security (a superuser, as on a
-- local cluster), section 9 moves the tables involved, the 0107 functions and
-- the owner-only policy to a fresh NOSUPERUSER NOBYPASSRLS role inside the
-- transaction and runs the gate, mark, withdraw, routed and list cases again,
-- then drops the policy to show it is needed (the patient gate then loses the
-- row). On an owner that does not bypass row-level security the whole suite
-- already runs that way, and section 9 only drops the policy.
-- Section 9's rows in lrd_cases are checked before its savepoint rollback
-- (which undoes them); section 9b lists a 520-result history in its own
-- savepoint. The two-session interleavings (a duplicate in flight, one key for
-- two results) cannot run in one session; the build's race harness runs them.
begin;

-- 1. Catalog: owners, attributes, ACLs, row-level security, policies, the
-- trigger and the permission rows.
do $$
declare
  mismatch text;
  table_owner oid := (select relowner from pg_class where oid = 'lab.results'::regclass);
begin
  select string_agg(format('%s: definer=%s config=%s owner=%s', p.oid::regprocedure, p.prosecdef, p.proconfig,
           p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
    join (values ('lab.result_visit_finished(uuid,uuid,uuid)'::regprocedure, true),
                 ('lab.result_discussion_target(uuid,uuid)'::regprocedure, false),
                 ('lab.patient_self_result_gates(uuid)'::regprocedure, true),
                 ('lab.record_result_discussion(uuid,uuid,bigint,text,text)'::regprocedure, true),
                 ('lab.withdraw_result_discussion(uuid,uuid,bigint,text,text,text,text)'::regprocedure, true),
                 ('lab.list_result_discussions(uuid)'::regprocedure, true)) expected(proc, definer)
      on p.oid = expected.proc
   where p.prosecdef <> expected.definer or p.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
      or p.proowner <> table_owner;
  if mismatch is not null then
    raise exception 'discussion function attributes changed: %', mismatch;
  end if;
  -- EXECUTE: the four commands to hid_lab_runtime and hid_schema_test_runtime
  -- only; the two helpers to nobody; never PUBLIC.
  select string_agg(format('%s on %s', coalesce(grantee.rolname, 'PUBLIC'), p.oid::regprocedure), '; ')
    into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
   where p.pronamespace = 'lab'::regnamespace
     and p.proname in ('result_visit_finished', 'result_discussion_target', 'patient_self_result_gates',
                       'record_result_discussion', 'withdraw_result_discussion', 'list_result_discussions')
     and privilege.grantee <> p.proowner
     and (p.proname in ('result_visit_finished', 'result_discussion_target')
          or coalesce(grantee.rolname, 'PUBLIC') not in ('hid_lab_runtime', 'hid_schema_test_runtime'));
  if mismatch is not null then
    raise exception 'unexpected EXECUTE grants: %', mismatch;
  end if;
  if not has_function_privilege('hid_lab_runtime', 'lab.patient_self_result_gates(uuid)', 'EXECUTE')
     or not has_function_privilege('hid_lab_runtime', 'lab.record_result_discussion(uuid,uuid,bigint,text,text)', 'EXECUTE')
     or not has_function_privilege('hid_lab_runtime',
       'lab.withdraw_result_discussion(uuid,uuid,bigint,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('hid_lab_runtime', 'lab.list_result_discussions(uuid)', 'EXECUTE')
     or has_function_privilege('hid_lab_runtime', 'lab.result_visit_finished(uuid,uuid,uuid)', 'EXECUTE')
     or has_function_privilege('hid_lab_runtime', 'lab.result_discussion_target(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('hid_ehr_runtime', 'lab.patient_self_result_gates(uuid)', 'EXECUTE') then
    raise exception 'the Lab runtime EXECUTE set is not 0107''s';
  end if;
  -- The event table: FORCE row-level security, no grant to anyone, two policies
  -- (read and insert, true), the append-only trigger.
  if not exists (select 1 from pg_class c where c.oid = 'lab.result_discussion_events'::regclass
                  and c.relrowsecurity and c.relforcerowsecurity and c.relowner = table_owner
                  and not exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
                                   where acl.grantee <> c.relowner)) then
    raise exception 'lab.result_discussion_events: row-level security, owner or ACL changed';
  end if;
  if (select string_agg(polname || ':' || polcmd::text, ',' order by polname) from pg_policy
       where polrelid = 'lab.result_discussion_events'::regclass)
     is distinct from 'result_discussion_events_command_insert:a,result_discussion_events_command_read:r' then
    raise exception 'lab.result_discussion_events policies changed';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'lab.result_discussion_events'::regclass
                  and tgfoid = 'platform.reject_mutation()'::regprocedure and tgenabled = 'O' and tgtype = 27) then
    raise exception 'lab.result_discussion_events lost its append-only trigger';
  end if;
  -- The owner-only policy: TO the owner of lab.work_items, SELECT, permissive.
  if (select count(*) from pg_policy where polrelid = 'lab.work_items'::regclass
        and polname = 'lab_work_items_patient_result_gate' and polcmd = 'r' and polpermissive
        and polroles = array[(select relowner from pg_class where oid = 'lab.work_items'::regclass)]
        and pg_get_expr(polqual, polrelid) = 'lab.patient_self_context(patient_id)') <> 1 then
    raise exception 'the owner-only work-item policy changed';
  end if;
  if exists (select 1 from pg_roles r where (r.rolname like 'hid\_%\_runtime' or r.rolname = 'hid_schema_test_runtime')
              and pg_has_role(r.oid, (select relowner from pg_class where oid = 'lab.work_items'::regclass), 'USAGE')) then
    raise exception 'a runtime role is a member of the owner, so the owner-only policy would apply to it';
  end if;
  if (select array_agg(role_code order by role_code) from auth.role_permissions
       where permission_code = 'lab.result.discuss') is distinct from array['clinician', 'doctor']
     or not exists (select 1 from auth.permissions where code = 'lab.result.discuss' and active) then
    raise exception 'lab.result.discuss must be active and granted to doctor and clinician only';
  end if;
end $$;

-- 2. Fixtures. IDs: f121KKKK-0000-4000-8000-00000000NNNN (KKKK the kind, NNNN
-- the number). Facilities 1 FA (clinic and its lab), 2 FB (the lab FA routes
-- to), 3 FC (another clinic). Staff n: 1 doctor at FA (write grant for PA and
-- PB), 2 nurse at FA (write grant), 3 doctor at FA (no grant), 4 doctor at FA
-- (break-glass grant only), 5 doctor at FA (read grant only), 6 lab at FB, 7
-- doctor at FC (write grant at FC), 8 lab at FA. Patients 1 PA and 2 PB, each
-- with a live patient session.
create function pg_temp.lrd_id(kind integer, n integer) returns uuid language sql immutable as $$
  select format('f121%s-0000-4000-8000-%s', lpad(kind::text, 4, '0'), lpad(n::text, 12, '0'))::uuid
$$;

set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  (pg_temp.lrd_id(1001, 1), 'Discussion Suite Organization', 'discussion-suite-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
select pg_temp.lrd_id(1002, n), pg_temp.lrd_id(1001, 1), 'Discussion Suite Facility ' || n, 'LRD-SUITE-' || n,
       'Africa/Lagos', true, 'verified'
  from generate_series(1, 3) n;
insert into auth.accounts (id, subject, email, display_name, status)
select pg_temp.lrd_id(1003, n), 'synthetic:lrd-' || n, 'lrd-' || n || '@example.invalid', 'Discussion Suite ' || n,
       'active'
  from (select generate_series(1, 8) union all select 11 union all select 12) s(n);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select pg_temp.lrd_id(1004, m.n), pg_temp.lrd_id(1003, m.n), 'Discussion Suite ' || m.n,
       'lrd-' || m.n || '@example.invalid', 'verified', m.role_code
  from (values (1, 'doctor', 1), (2, 'nurse', 1), (3, 'doctor', 1), (4, 'doctor', 1), (5, 'doctor', 1),
               (6, 'lab', 2), (7, 'doctor', 3), (8, 'lab', 1)) m(n, role_code, facility);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, active)
select pg_temp.lrd_id(1005, m.n), pg_temp.lrd_id(1004, m.n), pg_temp.lrd_id(1003, m.n), pg_temp.lrd_id(1001, 1),
       pg_temp.lrd_id(1002, m.facility), m.role_code, m.role_code, true
  from (values (1, 'doctor', 1), (2, 'nurse', 1), (3, 'doctor', 1), (4, 'doctor', 1), (5, 'doctor', 1),
               (6, 'lab', 2), (7, 'doctor', 3), (8, 'lab', 1)) m(n, role_code, facility);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select pg_temp.lrd_id(1021, m.n), pg_temp.lrd_id(1003, m.n), m.role_code, 'facility', pg_temp.lrd_id(1005, m.n),
       pg_temp.lrd_id(1002, m.facility), 'Synthetic discussion suite role'
  from (values (1, 'doctor', 1), (2, 'nurse', 1), (3, 'doctor', 1), (4, 'doctor', 1), (5, 'doctor', 1),
               (6, 'lab', 2), (7, 'doctor', 3), (8, 'lab', 1)) m(n, role_code, facility);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  (pg_temp.lrd_id(1006, 1), pg_temp.lrd_id(1003, 11), 'HID-LRDPATA', 'Adaeze', 'Fictional', 'Adaeze Fictional',
   'female', '1990-01-01', 'active'),
  (pg_temp.lrd_id(1006, 2), pg_temp.lrd_id(1003, 12), 'HID-LRDPATB', 'Bayo', 'Fictional', 'Bayo Fictional',
   'male', '1988-02-02', 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select pg_temp.lrd_id(1007, n), pg_temp.lrd_id(1003, 10 + n), pg_temp.lrd_id(1007, n),
       md5('lrd-session-' || n) || md5('lrd-session-' || n), gen_random_uuid(), 1, 'password',
       clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
       clock_timestamp() + interval '2 hours', 'patient', pg_temp.lrd_id(1006, n)
  from generate_series(1, 2) n;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, break_glass, purpose_of_use)
select pg_temp.lrd_id(1008, g.n), pg_temp.lrd_id(1006, g.patient), pg_temp.lrd_id(1004, g.staff),
       pg_temp.lrd_id(1003, g.staff), pg_temp.lrd_id(1005, g.staff), pg_temp.lrd_id(1002, g.facility), g.scope,
       'active', 'Synthetic discussion suite grant', clock_timestamp() - interval '1 hour',
       clock_timestamp() + interval '1 day', g.scope = 'break_glass', g.purpose
  from (values (1, 1, 1, 1, 'write_records', 'direct-care'), (2, 1, 2, 1, 'write_records', 'direct-care'),
               (3, 1, 4, 1, 'break_glass', 'emergency'), (4, 1, 5, 1, 'read_records', 'direct-care'),
               (5, 1, 7, 3, 'write_records', 'direct-care'), (6, 2, 1, 1, 'write_records', 'direct-care'))
         g(n, patient, staff, facility, scope, purpose);

-- One Lab chain per result n: encounter and lab request at the ordering
-- facility; work item, requested test, execution and result at the lab
-- facility (another one when route is given); revisions 1..current, verified
-- and released 1..released; an invalidation of the last released version.
create function pg_temp.lrd_chain(n integer, patient integer, lab_facility integer, ordering_facility integer,
  encounter_status text, request_status text, route integer, released integer, current_version integer,
  flag text, invalidated boolean, test_name text)
returns void language plpgsql as $f$
declare
  clinician integer := case ordering_facility when 3 then 7 else 1 end;
  scientist integer := case lab_facility when 2 then 6 when 3 then 7 else 8 end;
  v integer;
begin
  insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
    status, started_at, ended_at)
  values (pg_temp.lrd_id(1009, n), pg_temp.lrd_id(1006, patient), pg_temp.lrd_id(1002, ordering_facility),
    pg_temp.lrd_id(1003, clinician), pg_temp.lrd_id(1005, clinician), 'ambulatory', encounter_status,
    clock_timestamp() - interval '2 days',
    case when encounter_status = 'completed' then clock_timestamp() - interval '1 day' end);
  insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    test_code_system, test_code, test_display, priority, status, clinical_information, created_at)
  values (pg_temp.lrd_id(1010, n), pg_temp.lrd_id(1009, n), pg_temp.lrd_id(1006, patient),
    pg_temp.lrd_id(1002, ordering_facility), pg_temp.lrd_id(1003, clinician), pg_temp.lrd_id(1005, clinician),
    'http://loinc.org', '718-7', test_name, 'routine', request_status, 'Synthetic discussion suite order',
    clock_timestamp() - interval '2 days');
  insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
    source_ehr_order_version, source_encounter_id, priority, test_code_system, test_code, test_name, requested_by,
    requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id,
    order_route_id)
  values (pg_temp.lrd_id(1011, n), pg_temp.lrd_id(1006, patient), pg_temp.lrd_id(1002, lab_facility),
    pg_temp.lrd_id(1002, ordering_facility), pg_temp.lrd_id(1010, n), 1, pg_temp.lrd_id(1009, n), 'routine',
    'http://loinc.org', '718-7', test_name, pg_temp.lrd_id(1003, clinician), clock_timestamp() - interval '2 days',
    pg_temp.lrd_id(1003, scientist), pg_temp.lrd_id(1005, scientist), 'lrd-fixture-work-' || lpad(n::text, 4, '0'),
    repeat('a', 64), 'lrd-fixture', case when route is not null then pg_temp.lrd_id(1019, route) end);
  insert into lab.work_item_requested_tests (id, work_item_id, facility_id, patient_id, ordinal, code_system, code,
    name)
  values (pg_temp.lrd_id(1012, n), pg_temp.lrd_id(1011, n), pg_temp.lrd_id(1002, lab_facility),
    pg_temp.lrd_id(1006, patient), 1, 'http://loinc.org', '718-7', test_name);
  insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
    started_by, started_by_membership_id, started_at, completed_by, completed_by_membership_id, completed_at,
    idempotency_key, request_sha256, correlation_id, row_version)
  values (pg_temp.lrd_id(1013, n), gen_random_uuid(), gen_random_uuid(), pg_temp.lrd_id(1012, n),
    pg_temp.lrd_id(1006, patient), pg_temp.lrd_id(1002, lab_facility), 'completed', pg_temp.lrd_id(1003, scientist),
    pg_temp.lrd_id(1005, scientist), clock_timestamp(), pg_temp.lrd_id(1003, scientist),
    pg_temp.lrd_id(1005, scientist), clock_timestamp(), 'lrd-fixture-execution-' || lpad(n::text, 4, '0'),
    repeat('a', 64), 'lrd-fixture', 2);
  insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id,
    current_version)
  values (pg_temp.lrd_id(1014, n), pg_temp.lrd_id(1013, n), pg_temp.lrd_id(1006, patient),
    pg_temp.lrd_id(1002, lab_facility), pg_temp.lrd_id(1003, scientist), pg_temp.lrd_id(1005, scientist),
    current_version);
  for v in 1 .. current_version loop
    perform pg_temp.lrd_revision(n, v, flag);
  end loop;
  for v in 1 .. released loop
    perform pg_temp.lrd_release(n, v);
  end loop;
  if invalidated then
    insert into lab.result_invalidations (result_id, execution_id, patient_id, facility_id, result_version,
      disposition, actor_id, actor_membership_id, reason, idempotency_key, request_sha256, correlation_id)
    select r.id, r.execution_id, r.patient_id, r.facility_id, released, 'entered_in_error', r.created_by,
           r.created_by_membership_id, 'Synthetic entered in error', 'lrd-fixture-void-' || lpad(n::text, 4, '0'),
           repeat('a', 64), 'lrd-fixture'
      from lab.results r where r.id = pg_temp.lrd_id(1014, n);
  end if;
end $f$;
create function pg_temp.lrd_revision(n integer, v integer, flag text) returns void language sql as $f$
  insert into lab.result_revisions (id, result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, abnormal_flag, entered_by, entered_by_membership_id, idempotency_key, request_sha256,
    correlation_id, revision_kind, supersedes_version, correction_reason)
  select pg_temp.lrd_id(1015, n * 10 + v), r.id, r.execution_id, r.patient_id, r.facility_id, v, 'numeric', 5 + v,
         'g/dL', flag, r.created_by, r.created_by_membership_id,
         'lrd-fixture-revision-' || lpad((n * 10 + v)::text, 4, '0'), repeat('a', 64), 'lrd-fixture',
         case when v = 1 then 'original' else 'correction' end, case when v > 1 then v - 1 end,
         case when v > 1 then 'Synthetic correction' end
    from lab.results r where r.id = pg_temp.lrd_id(1014, n)
$f$;
create function pg_temp.lrd_release(n integer, v integer) returns void language sql as $f$
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  select pg_temp.lrd_id(1016, n * 10 + v), r.id, r.execution_id, r.patient_id, r.facility_id, v, r.created_by,
         r.created_by_membership_id, clock_timestamp(), 'Synthetic verification',
         'lrd-fixture-verify-' || lpad((n * 10 + v)::text, 4, '0'), repeat('a', 64), 'lrd-fixture'
    from lab.results r where r.id = pg_temp.lrd_id(1014, n);
  insert into lab.result_releases (id, verification_id, result_id, execution_id, patient_id, facility_id,
    result_version, released_by, released_by_membership_id, released_at, reason, idempotency_key, request_sha256,
    correlation_id)
  select pg_temp.lrd_id(1017, n * 10 + v), pg_temp.lrd_id(1016, n * 10 + v), r.id, r.execution_id, r.patient_id,
         r.facility_id, v, r.created_by, r.created_by_membership_id,
         timestamptz '2026-10-01 08:00+00' + make_interval(hours => n, mins => v), 'Synthetic release',
         'lrd-fixture-release-' || lpad((n * 10 + v)::text, 4, '0'), repeat('b', 64), 'lrd-fixture'
    from lab.results r where r.id = pg_temp.lrd_id(1014, n)
$f$;
-- A route from FA to FB for chain n, accepted (or cancelled as wrong
-- patient), and the result reports that came back to FA.
create function pg_temp.lrd_route(n integer, ended text) returns void language sql as $f$
  insert into ehr.order_routes (id, kind, patient_id, ordering_organization_id, ordering_facility_id,
    source_lab_request_id, source_encounter_id, source_order_version, receiving_organization_id,
    receiving_facility_id, state, sent_by_account_id, sent_by_membership_id, created_at, respond_by,
    patient_agreement, attestation_text_version, attested_by_name, attested_receiving_facility_name,
    orderer_account_id, orderer_membership_id, orderer_name, test_code_system, test_code, test_display, priority,
    requested_at, accepted_at, accepted_by_account_id, accepted_by_membership_id, accept_idempotency_key,
    accept_request_sha256, lab_work_item_id, writes_end_at, access_ends_at, ended_at, ended_kind, idempotency_key,
    request_sha256, correlation_id)
  values (pg_temp.lrd_id(1019, n), 'lab_request', pg_temp.lrd_id(1006, 1), pg_temp.lrd_id(1001, 1),
    pg_temp.lrd_id(1002, 1), pg_temp.lrd_id(1010, n), pg_temp.lrd_id(1009, n), 1, pg_temp.lrd_id(1001, 1),
    pg_temp.lrd_id(1002, 2), case when ended is null then 'accepted' else 'cancelled' end, pg_temp.lrd_id(1003, 1),
    pg_temp.lrd_id(1005, 1), timestamptz '2026-10-01 07:00+00', timestamptz '2026-10-01 07:00+00' + interval '168 hours',
    'clinician_attested', 'order-route-lab-attestation-v1', 'Discussion Suite 1', 'Discussion Suite Facility 2',
    pg_temp.lrd_id(1003, 1), pg_temp.lrd_id(1005, 1), 'Discussion Suite 1', 'http://loinc.org', '718-7',
    'Routed Test ' || n, 'routine', timestamptz '2026-10-01 07:00+00', timestamptz '2026-10-01 07:30+00',
    pg_temp.lrd_id(1003, 6), pg_temp.lrd_id(1005, 6), 'lrd-fixture-accept-' || lpad(n::text, 4, '0'),
    repeat('c', 64), pg_temp.lrd_id(1011, n), timestamptz '2026-10-20 07:30+00', timestamptz '2026-10-30 07:30+00',
    case when ended is not null then timestamptz '2026-10-02 07:30+00' end, ended,
    'lrd-fixture-route-' || lpad(n::text, 4, '0'), repeat('d', 64), 'lrd-fixture')
$f$;
create function pg_temp.lrd_report(n integer, kind text, v integer) returns void language sql as $f$
  insert into lab.order_route_result_reports (route_id, work_item_id, result_id, result_version, kind,
    test_code_system, test_code, test_name, result_type, numeric_value, unit, abnormal_flag, revision_kind,
    occurred_at, performing_facility_id)
  values (pg_temp.lrd_id(1019, n), pg_temp.lrd_id(1011, n), pg_temp.lrd_id(1014, n), v, kind, 'http://loinc.org',
    '718-7', 'Routed Test ' || n, case when kind = 'released' then 'numeric' end,
    case when kind = 'released' then 6 end, case when kind = 'released' then 'g/dL' end,
    case when kind = 'released' then 'normal' end, case when kind = 'released' then 'original' end,
    timestamptz '2026-10-01 08:00+00' + make_interval(hours => n), pg_temp.lrd_id(1002, 2))
$f$;

-- Chains (patient, lab facility, ordering facility, encounter, request, route,
-- released, current, flag, invalidated, test).
select pg_temp.lrd_chain(1, 1, 1, 1, 'completed', 'active', null, 1, 1, 'normal', false, 'Haemoglobin');
select pg_temp.lrd_chain(2, 1, 1, 1, 'in_progress', 'active', null, 1, 1, 'normal', false, 'Haemoglobin');
select pg_temp.lrd_chain(3, 1, 1, 1, 'cancelled', 'active', null, 1, 1, 'normal', false, 'Haemoglobin');
select pg_temp.lrd_chain(4, 1, 1, 1, 'entered_in_error', 'active', null, 1, 1, 'normal', false, 'Haemoglobin');
select pg_temp.lrd_chain(5, 1, 1, 1, 'completed', 'cancelled', null, 1, 1, 'normal', false, 'Haemoglobin');
select pg_temp.lrd_chain(6, 1, 1, 1, 'completed', 'entered_in_error', null, 1, 1, 'normal', false, 'Haemoglobin');
select pg_temp.lrd_chain(7, 1, 2, 1, 'completed', 'active', 7, 1, 1, 'normal', false, 'Routed Test 7');
select pg_temp.lrd_chain(8, 1, 2, 1, 'completed', 'active', 8, 1, 1, 'normal', false, 'Routed Test 8');
select pg_temp.lrd_chain(9, 2, 1, 1, 'completed', 'active', null, 1, 1, 'normal', false, 'Haemoglobin');
select pg_temp.lrd_chain(10, 1, 3, 3, 'completed', 'active', null, 1, 1, 'normal', false, 'Haemoglobin');
select pg_temp.lrd_chain(11, 1, 1, 1, 'completed', 'completed', null, 1, 2, 'normal', false, 'Haemoglobin');
select pg_temp.lrd_chain(12, 1, 1, 1, 'completed', 'active', null, 1, 1, 'normal', true, 'Haemoglobin');
select pg_temp.lrd_chain(13, 1, 2, 1, 'completed', 'active', 13, 1, 1, 'normal', false, 'Routed Test 13');
select pg_temp.lrd_chain(14, 1, 1, 1, 'completed', 'on_hold', null, 1, 1, 'critical_candidate', false, 'Potassium');
select pg_temp.lrd_chain(15, 1, 2, 1, 'completed', 'active', 15, 1, 1, 'normal', false, 'Routed Test 15');
select pg_temp.lrd_chain(16, 1, 1, 1, 'completed', 'active', null, 0, 1, 'normal', false, 'Haemoglobin');
select pg_temp.lrd_route(7, 'wrong_patient'), pg_temp.lrd_route(8, null), pg_temp.lrd_route(13, null),
       pg_temp.lrd_route(15, null);
select pg_temp.lrd_report(7, 'released', 1), pg_temp.lrd_report(8, 'released', 1),
       pg_temp.lrd_report(13, 'released', 1), pg_temp.lrd_report(13, 'entered_in_error', 1),
       pg_temp.lrd_report(15, 'released', 1);
set local session_replication_role = origin;

do $$
declare owner_role text := (select proowner::regrole::text from pg_proc
                             where oid = 'lab.patient_self_result_gates(uuid)'::regprocedure);
begin
  perform set_config('lrd_suite.owner_bypasses_rls',
    (select (rolsuper or rolbypassrls)::text from pg_roles where rolname = owner_role), true);
  perform set_config('lrd_suite.audit_before', (select count(*)::text from audit.events), true);
end $$;

create temporary table lrd_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;

-- Runs a statement as run_as: 'ok', or the SQLSTATE and message it raised.
-- With keep = false a successful statement is undone.
create function pg_temp.lrd_try(run_as text, statement text, keep boolean) returns text language plpgsql as $$
declare outcome text;
begin
  if run_as is not null then
    execute format('set local role %I', run_as);
  end if;
  begin
    execute statement;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'lrd-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'lrd-suite: undo' then outcome := sqlstate || ' ' || sqlerrm; end if;
  end;
  reset role;
  return outcome;
end $$;
create function pg_temp.lrd_case(case_name text, expected text, statement text, keep boolean default true,
  run_as text default 'hid_lab_runtime')
returns void language plpgsql as $$
begin
  insert into lrd_cases (name, expected, actual) values (case_name, expected, pg_temp.lrd_try(run_as, statement, keep));
end $$;
-- Raises listing every case so far whose outcome differs; else a notice.
create function pg_temp.lrd_outcome(stage text) returns void language plpgsql as $$
declare
  mismatches text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq)
    into mismatches
    from lrd_cases
   where actual is distinct from expected;
  if mismatches is not null then
    raise exception E'lab result discussion cases failed (owner bypasses row-level security: %):\n%',
      current_setting('lrd_suite.owner_bypasses_rls'), mismatches;
  end if;
  raise notice '%: % cases passed (owner_bypasses_rls: %)', stage,
    (select count(*) from lrd_cases), current_setting('lrd_suite.owner_bypasses_rls');
end $$;
-- A DO block that runs the query and raises P0001 unless its rows (as text,
-- sorted, joined with |) are the expected ones.
create function pg_temp.lrd_q(query text, expected text) returns text language sql as $f$
  select format($s$do $d$ declare got text; begin
    execute 'select string_agg(x::text, ''|'' order by x::text) from (' || %L || ') x' into got;
    if got is distinct from %L then
      raise exception using errcode = 'P0001', message = 'got ' || coalesce(got, 'nothing');
    end if; end $d$$s$, query, expected)
$f$;
-- lab-api's staff session (DatabaseService.withTransaction) for member n.
create function pg_temp.as_staff(n integer, purpose text default 'direct-care',
  correlation text default 'lrd-suite-correlation') returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:lrd-' || n, true),
    set_config('app.facility_id', (select facility_id::text from identity.staff_facility_memberships
                                    where id = pg_temp.lrd_id(1005, n)), true),
    set_config('app.correlation_id', coalesce(correlation, ''), true),
    set_config('app.membership_id', pg_temp.lrd_id(1005, n)::text, true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.account_id', '', true), set_config('app.patient_id', '', true),
    set_config('app.session_id', '', true), set_config('app.self_authorized_until', '', true);
$f$;
-- lab-api's patient session (DatabaseService.withPatientTransaction) for patient n.
create function pg_temp.as_patient(n integer) returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:lrd-' || (10 + n), true),
    set_config('app.account_id', pg_temp.lrd_id(1003, 10 + n)::text, true),
    set_config('app.patient_id', pg_temp.lrd_id(1006, n)::text, true),
    set_config('app.session_id', pg_temp.lrd_id(1007, n)::text, true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '1 minute')::text, true),
    set_config('app.correlation_id', 'lrd-suite-patient-' || n, true),
    set_config('app.purpose_of_use', 'patient-self', true),
    set_config('app.facility_id', '', true), set_config('app.membership_id', '', true);
$f$;
create function pg_temp.as_nobody() returns void language sql as $f$
  select set_config('app.actor_subject', '', true), set_config('app.account_id', '', true),
    set_config('app.patient_id', '', true), set_config('app.session_id', '', true),
    set_config('app.self_authorized_until', '', true), set_config('app.correlation_id', '', true),
    set_config('app.purpose_of_use', '', true), set_config('app.facility_id', '', true),
    set_config('app.membership_id', '', true);
$f$;
-- Statement texts. r(n) is result n's id; the gate row of result n for
-- patient p as (released_version, finished_visit, discussed).
create function pg_temp.r(n integer) returns text language sql immutable as $$ select pg_temp.lrd_id(1014, n)::text $$;
create function pg_temp.gate(p integer, n integer) returns text language sql as $f$
  select format('select g.released_version, g.finished_visit, g.discussed from lab.patient_self_result_gates(%L) g '
    || 'where g.result_id = %L', pg_temp.lrd_id(1006, p), pg_temp.r(n))
$f$;
create function pg_temp.mark(n integer, v integer, key text, sha text, patient integer default 1) returns text
language sql as $f$
  select format('select m.event_no, m.state, m.finished_visit, m.replayed from lab.record_result_discussion(%L, %L, %s, %L, %L) m',
    pg_temp.lrd_id(1006, patient), pg_temp.r(n), v, key, sha)
$f$;
create function pg_temp.withdraw(n integer, v integer, code text, reason text, key text, sha text) returns text
language sql as $f$
  select format('select w.event_no, w.state, w.finished_visit, w.replayed from lab.withdraw_result_discussion(%L, %L, %s, %L, %L, %L, %L) w',
    pg_temp.lrd_id(1006, 1), pg_temp.r(n), v, code, reason, key, sha)
$f$;
create function pg_temp.list_rows(query_tail text) returns text language sql as $f$
  select format('select %s from lab.list_result_discussions(%L) l', query_tail, pg_temp.lrd_id(1006, 1))
$f$;

-- 3. The patient gate: finished visits only (D-F), isolation (G1-G9).
select pg_temp.as_patient(1);
select pg_temp.lrd_case('G1 completed encounter, active request: finished, not discussed', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 1), '(1,t,f)'));
select pg_temp.lrd_case('G2 encounter in progress: not finished', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 2), '(1,f,f)'));
select pg_temp.lrd_case('G3 encounter cancelled: not finished', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 3), '(1,f,f)'));
select pg_temp.lrd_case('G4 encounter entered in error: not finished', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 4), '(1,f,f)'));
select pg_temp.lrd_case('G5 request cancelled: not finished', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 5), '(1,f,f)'));
select pg_temp.lrd_case('G6 request entered in error: not finished', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 6), '(1,f,f)'));
select pg_temp.lrd_case('G7 routed, the route ended wrong_patient: not finished', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 7), '(1,f,f)'));
select pg_temp.lrd_case('G8 routed, ordinary: finished', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 8), '(1,t,f)'));
select pg_temp.lrd_case('G8b request on hold: finished; another facility''s result too', 'ok',
  pg_temp.lrd_q(format('select count(*) filter (where g.finished_visit) from lab.patient_self_result_gates(%L) g '
    || 'where g.result_id in (%L, %L)', pg_temp.lrd_id(1006, 1), pg_temp.r(14), pg_temp.r(10)), '(2)'));
select pg_temp.lrd_case('G8c the last released version, not the pending correction', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 11), '(1,t,f)'));
select pg_temp.lrd_case('G8d one row per released result of the patient (none unreleased, none of PB)', 'ok',
  pg_temp.lrd_q(format('select count(*), count(*) filter (where g.result_id = %L) from lab.patient_self_result_gates(%L) g',
    pg_temp.r(16), pg_temp.lrd_id(1006, 1)), '(14,0)'));
select pg_temp.lrd_case('G9a patient A''s session asking for B: no row', 'ok',
  pg_temp.lrd_q(format('select count(*) from lab.patient_self_result_gates(%L) g', pg_temp.lrd_id(1006, 2)), '(0)'));
select pg_temp.as_patient(2);
select pg_temp.lrd_case('G9b patient B''s own session: B''s result', 'ok', pg_temp.lrd_q(pg_temp.gate(2, 9), '(1,t,f)'));
select pg_temp.as_nobody();
select pg_temp.lrd_case('G9c no patient context: no row', 'ok',
  pg_temp.lrd_q(format('select count(*) from lab.patient_self_result_gates(%L) g', pg_temp.lrd_id(1006, 1)), '(0)'));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('G9d staff context: no row', 'ok',
  pg_temp.lrd_q(format('select count(*) from lab.patient_self_result_gates(%L) g', pg_temp.lrd_id(1006, 1)), '(0)'));

-- 4. G11: the Lab runtime itself reads no work item in a patient session and
-- has no right on the event table.
select pg_temp.as_patient(1);
select pg_temp.lrd_case('G11a hid_lab_runtime sees no work item in a patient session', 'ok',
  pg_temp.lrd_q('select count(*) from lab.work_items', '(0)'));
select pg_temp.lrd_case('G11b hid_lab_runtime sees the patient''s results (unchanged)', 'ok',
  pg_temp.lrd_q(format('select count(*) > 0 from lab.results where patient_id = %L', pg_temp.lrd_id(1006, 1)), '(t)'));
select pg_temp.lrd_case('G11c select events refused', '42501 permission denied for table result_discussion_events',
  'select * from lab.result_discussion_events');
select pg_temp.as_staff(1);
select pg_temp.lrd_case('G11d insert event refused', '42501 permission denied for table result_discussion_events',
  format($s$insert into lab.result_discussion_events (result_id, result_version, patient_id, result_facility_id,
    event_no, kind, actor_account_id, actor_membership_id, actor_facility_id, idempotency_key, request_sha256,
    correlation_id) values (%L, 1, %L, %L, 1, 'discussed', %L, %L, %L, 'lrd-suite-direct-insert', repeat('e', 64),
    'lrd-suite-correlation')$s$, pg_temp.r(1), pg_temp.lrd_id(1006, 1), pg_temp.lrd_id(1002, 1),
    pg_temp.lrd_id(1003, 1), pg_temp.lrd_id(1005, 1), pg_temp.lrd_id(1002, 1)));
select pg_temp.lrd_case('G11e update events refused', '42501 permission denied for table result_discussion_events',
  'update lab.result_discussion_events set kind = kind');
select pg_temp.lrd_case('G11f delete events refused', '42501 permission denied for table result_discussion_events',
  'delete from lab.result_discussion_events');
select pg_temp.lrd_case('G11g the visit check is the owner''s alone',
  '42501 permission denied for function result_visit_finished',
  format('select lab.result_visit_finished(%L, %L, null)', pg_temp.lrd_id(1009, 1), pg_temp.lrd_id(1010, 1)));
select pg_temp.lrd_case('G11h the target helper is the owner''s alone',
  '42501 permission denied for function result_discussion_target',
  format('select * from lab.result_discussion_target(%L, %L)', pg_temp.lrd_id(1006, 1), pg_temp.r(1)));

-- 5. Marking (R1-R16), withdrawing (W1-W5) and versions (G10), in order.
select pg_temp.as_staff(1);
select pg_temp.lrd_case('R1 a doctor with a write grant marks result 1 v1', 'ok',
  pg_temp.lrd_q(pg_temp.mark(1, 1, 'lrd-key-0001-record', repeat('1', 64)), '(1,discussed,t,f)'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('G10a marked: discussed', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 1), '(1,t,t)'));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('R2 same key and request: replayed', 'ok',
  pg_temp.lrd_q(pg_temp.mark(1, 1, 'lrd-key-0001-record', repeat('1', 64)), '(1,discussed,t,t)'));
select pg_temp.lrd_case('R3 same key, another request', 'P0001 IDEMPOTENCY_KEY_REUSED',
  pg_temp.mark(1, 1, 'lrd-key-0001-record', repeat('2', 64)));
select pg_temp.lrd_case('R3b same key for another result', 'P0001 IDEMPOTENCY_KEY_REUSED',
  pg_temp.mark(2, 1, 'lrd-key-0001-record', repeat('1', 64)));
select pg_temp.lrd_case('R4 a new key while discussed: the existing mark', 'ok',
  pg_temp.lrd_q(pg_temp.mark(1, 1, 'lrd-key-0002-record', repeat('3', 64)), '(1,discussed,t,t)'));
select pg_temp.as_staff(1, 'healthcare-operations');
select pg_temp.lrd_case('R5 another purpose of use', '42501 PURPOSE_OF_USE_REQUIRED',
  pg_temp.mark(1, 1, 'lrd-key-0005-record', repeat('5', 64)));
select pg_temp.as_staff(1, 'direct-care', null);
select pg_temp.lrd_case('R6 no correlation ID', '42501 LAB_CONTEXT_REQUIRED',
  pg_temp.mark(1, 1, 'lrd-key-0006-record', repeat('6', 64)));
select pg_temp.as_staff(2);
select pg_temp.lrd_case('R7 a nurse (no lab.result.discuss)', '42501 PERMISSION_DENIED',
  pg_temp.mark(1, 1, 'lrd-key-0007-record', repeat('7', 64)));
select pg_temp.as_staff(3);
select pg_temp.lrd_case('R8 a doctor with no grant', '42501 PATIENT_ACCESS_DENIED',
  pg_temp.mark(1, 1, 'lrd-key-0008-record', repeat('8', 64)));
select pg_temp.as_staff(4);
select pg_temp.lrd_case('R9 a doctor with a break-glass grant only', '42501 PATIENT_ACCESS_DENIED',
  pg_temp.mark(1, 1, 'lrd-key-0009-record', repeat('9', 64)));
select pg_temp.as_staff(5);
select pg_temp.lrd_case('R10 a doctor with a read grant only', '42501 PATIENT_ACCESS_DENIED',
  pg_temp.mark(1, 1, 'lrd-key-0010-record', repeat('a', 64)));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('R10b version 0', '22023 RESULT_DISCUSSION_INVALID',
  pg_temp.mark(1, 0, 'lrd-key-0011-record', repeat('b', 64)));
select pg_temp.lrd_case('R10c a short idempotency key', '22023 RESULT_DISCUSSION_INVALID',
  pg_temp.mark(1, 1, 'short-key', repeat('b', 64)));
select pg_temp.lrd_case('R10d a request digest that is not hex', '22023 RESULT_DISCUSSION_INVALID',
  pg_temp.mark(1, 1, 'lrd-key-0012-record', repeat('G', 64)));
select pg_temp.lrd_case('R11 another patient''s result', 'P0002 RESULT_NOT_FOUND',
  pg_temp.mark(9, 1, 'lrd-key-0013-record', repeat('c', 64)));
select pg_temp.lrd_case('R12 another facility''s result, no route', 'P0002 RESULT_NOT_FOUND',
  pg_temp.mark(10, 1, 'lrd-key-0014-record', repeat('c', 64)));
select pg_temp.lrd_case('R12b an unreleased result', 'P0001 RESULT_NOT_RELEASED',
  pg_temp.mark(16, 1, 'lrd-key-0015-record', repeat('c', 64)));
-- Result 11: v1 released, a v2 correction entered but not released
-- (current_version 2). The list and the patient gate offer v1, so v1 is the
-- version to mark; v2 is not released yet.
select pg_temp.lrd_case('R14a correction pending: the last released v1 is marked', 'ok',
  pg_temp.lrd_q(pg_temp.mark(11, 1, 'lrd-key-0016-record', repeat('c', 64)), '(1,discussed,t,f)'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('R14c correction pending: the patient gate counts the v1 mark', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 11), '(1,t,t)'));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('R14b correction pending: v2 not released', 'P0001 RESULT_NOT_RELEASED',
  pg_temp.mark(11, 2, 'lrd-key-0017-record', repeat('c', 64)));
select pg_temp.lrd_case('R15 invalidated', 'P0001 RESULT_ENTERED_IN_ERROR',
  pg_temp.mark(12, 1, 'lrd-key-0018-record', repeat('c', 64)));
select pg_temp.lrd_case('R16a routed: the ordering facility marks a released report', 'ok',
  pg_temp.lrd_q(pg_temp.mark(8, 1, 'lrd-key-0019-record', repeat('c', 64)), '(1,discussed,t,f)'));
select pg_temp.lrd_case('R16b routed: an entered_in_error report', 'P0001 RESULT_ENTERED_IN_ERROR',
  pg_temp.mark(13, 1, 'lrd-key-0020-record', repeat('c', 64)));
select pg_temp.lrd_case('R16c routed, the route ended wrong_patient: marked, visit not finished', 'ok',
  pg_temp.lrd_q(pg_temp.mark(7, 1, 'lrd-key-0021-record', repeat('c', 64)), '(1,discussed,f,f)'));
select pg_temp.lrd_case('R16d routed: a version never reported', 'P0001 RESULT_VERSION_CHANGED',
  pg_temp.mark(8, 2, 'lrd-key-0022-record', repeat('c', 64)));
select pg_temp.as_staff(6);
select pg_temp.lrd_case('R16e the performing lab''s scientist (no lab.result.discuss)', '42501 PERMISSION_DENIED',
  pg_temp.mark(8, 1, 'lrd-key-0023-record', repeat('c', 64)));
select pg_temp.as_staff(7);
select pg_temp.lrd_case('R16f a doctor at FC marks FC''s own result', 'ok',
  pg_temp.lrd_q(pg_temp.mark(10, 1, 'lrd-key-0024-record', repeat('c', 64)), '(1,discussed,t,f)'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('G10e routed marks reach the patient gate; a wrong-patient route stays unfinished', 'ok',
  pg_temp.lrd_q(format('select g.result_id = %L, g.finished_visit, g.discussed from lab.patient_self_result_gates(%L) g '
    || 'where g.result_id in (%L, %L)', pg_temp.r(8), pg_temp.lrd_id(1006, 1), pg_temp.r(7), pg_temp.r(8)),
    '(f,f,t)|(t,t,t)'));

select pg_temp.as_staff(1);
select pg_temp.lrd_case('W1 withdraw: event 2', 'ok',
  pg_temp.lrd_q(pg_temp.withdraw(1, 1, 'not_yet_discussed', 'Fictional withdrawal reason one',
    'lrd-key-0101-withdraw', repeat('1', 64)), '(2,withdrawn,t,f)'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('G10b withdrawn: not discussed', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 1), '(1,t,f)'));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('R2b a replay of the mark after its withdrawal: refused, never "discussed"',
  'P0001 RESULT_DISCUSSION_CHANGED', pg_temp.mark(1, 1, 'lrd-key-0001-record', repeat('1', 64)));
select pg_temp.lrd_case('W4 replay of the withdrawal', 'ok',
  pg_temp.lrd_q(pg_temp.withdraw(1, 1, 'not_yet_discussed', 'Fictional withdrawal reason one',
    'lrd-key-0101-withdraw', repeat('1', 64)), '(2,withdrawn,t,t)'));
select pg_temp.lrd_case('W4b the withdrawal key reused for a mark', 'P0001 IDEMPOTENCY_KEY_REUSED',
  pg_temp.mark(1, 1, 'lrd-key-0101-withdraw', repeat('1', 64)));
select pg_temp.lrd_case('W2 withdraw when not discussed', 'P0001 RESULT_NOT_DISCUSSED',
  pg_temp.withdraw(1, 1, 'other', 'Fictional withdrawal reason two', 'lrd-key-0102-withdraw', repeat('2', 64)));
select pg_temp.lrd_case('W2b withdraw a result never marked', 'P0001 RESULT_NOT_DISCUSSED',
  pg_temp.withdraw(2, 1, 'other', 'Fictional withdrawal reason two', 'lrd-key-0103-withdraw', repeat('2', 64)));
select pg_temp.lrd_case('W3a an unknown reason code', '22023 RESULT_DISCUSSION_INVALID',
  pg_temp.withdraw(1, 1, 'bored', 'Fictional withdrawal reason two', 'lrd-key-0104-withdraw', repeat('2', 64)));
select pg_temp.lrd_case('W3b a reason of 7 characters', '22023 RESULT_DISCUSSION_INVALID',
  pg_temp.withdraw(1, 1, 'other', 'Seven c', 'lrd-key-0105-withdraw', repeat('2', 64)));
select pg_temp.lrd_case('W3c a reason with outer spaces', '22023 RESULT_DISCUSSION_INVALID',
  pg_temp.withdraw(1, 1, 'other', ' Fictional withdrawal reason ', 'lrd-key-0106-withdraw', repeat('2', 64)));
select pg_temp.lrd_case('W3d a reason of 501 characters', '22023 RESULT_DISCUSSION_INVALID',
  pg_temp.withdraw(1, 1, 'other', repeat('x', 501), 'lrd-key-0107-withdraw', repeat('2', 64)));
select pg_temp.lrd_case('W3e withdraw an unreleased version', 'P0002 RESULT_NOT_FOUND',
  pg_temp.withdraw(11, 2, 'other', 'Fictional withdrawal reason two', 'lrd-key-0108-withdraw', repeat('2', 64)));
select pg_temp.as_staff(2);
select pg_temp.lrd_case('W3f a nurse may not withdraw', '42501 PERMISSION_DENIED',
  pg_temp.withdraw(1, 1, 'other', 'Fictional withdrawal reason two', 'lrd-key-0109-withdraw', repeat('2', 64)));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('W5 marked again: event 3', 'ok',
  pg_temp.lrd_q(pg_temp.mark(1, 1, 'lrd-key-0110-record', repeat('4', 64)), '(3,discussed,t,f)'));
select pg_temp.lrd_case('W4c a replay of the withdrawal after a new mark: refused, never "withdrawn"',
  'P0001 RESULT_DISCUSSION_CHANGED',
  pg_temp.withdraw(1, 1, 'not_yet_discussed', 'Fictional withdrawal reason one', 'lrd-key-0101-withdraw',
    repeat('1', 64)));
select pg_temp.lrd_case('R2c a replay of the first mark while marked again: its event, discussed', 'ok',
  pg_temp.lrd_q(pg_temp.mark(1, 1, 'lrd-key-0001-record', repeat('1', 64)), '(1,discussed,t,t)'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('G10c marked again: discussed', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 1), '(1,t,t)'));
-- A released v2 correction of result 1: the v1 mark no longer counts (D-E).
set local session_replication_role = replica;
select pg_temp.lrd_revision(1, 2, 'normal'), pg_temp.lrd_release(1, 2);
update lab.results set current_version = 2 where id = pg_temp.lrd_id(1014, 1);
set local session_replication_role = origin;
select pg_temp.as_patient(1);
select pg_temp.lrd_case('G10d a released v2 correction: not discussed until v2 is marked', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 1), '(2,t,f)'));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('R13 a stale version', 'P0001 RESULT_VERSION_CHANGED',
  pg_temp.mark(1, 1, 'lrd-key-0111-record', repeat('5', 64)));
select pg_temp.lrd_case('W1b withdrawing the old version needs no currency check', 'ok',
  pg_temp.lrd_q(pg_temp.withdraw(1, 1, 'marked_in_error', 'Fictional withdrawal reason three',
    'lrd-key-0112-withdraw', repeat('3', 64)), '(4,withdrawn,t,f)'));
select pg_temp.lrd_case('G10f v2 marked', 'ok',
  pg_temp.lrd_q(pg_temp.mark(1, 2, 'lrd-key-0113-record', repeat('6', 64)), '(1,discussed,t,f)'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('G10g v2 discussed', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 1), '(2,t,t)'));
-- Result 3 (cancelled visit): marked, then withdrawn as wrong patient.
select pg_temp.as_staff(1);
select pg_temp.lrd_case('R17 a result from an unfinished visit may be marked', 'ok',
  pg_temp.lrd_q(pg_temp.mark(3, 1, 'lrd-key-0114-record', repeat('7', 64)), '(1,discussed,f,f)'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('G10h marked but unfinished: the patient chat still drops it', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 3), '(1,f,t)'));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('W6 withdraw as wrong patient', 'ok',
  pg_temp.lrd_q(pg_temp.withdraw(3, 1, 'wrong_patient', 'Fictional withdrawal reason four',
    'lrd-key-0115-withdraw', repeat('4', 64)), '(2,withdrawn,f,f)'));
select pg_temp.lrd_case('W7 routed withdrawal by the ordering facility', 'ok',
  pg_temp.lrd_q(pg_temp.withdraw(7, 1, 'other', 'Fictional withdrawal reason five',
    'lrd-key-0116-withdraw', repeat('5', 64)), '(2,withdrawn,f,f)'));

-- 6. The table (T1, T2), as the suite owner.
select pg_temp.lrd_case('T1a update refused even for the owner', '55000 lab.result_discussion_events is append-only',
  'update lab.result_discussion_events set reason = reason', true, null);
select pg_temp.lrd_case('T1b delete refused even for the owner', '55000 lab.result_discussion_events is append-only',
  'delete from lab.result_discussion_events', true, null);
select pg_temp.lrd_case('T2 an even event_no cannot be a mark',
  '23514 new row for relation "result_discussion_events" violates check constraint "result_discussion_events_alternation_ck"',
  format($s$insert into lab.result_discussion_events (result_id, result_version, patient_id, result_facility_id,
    event_no, kind, actor_account_id, actor_membership_id, actor_facility_id, idempotency_key, request_sha256,
    correlation_id) values (%L, 1, %L, %L, 6, 'discussed', %L, %L, %L, 'lrd-suite-direct-insert', repeat('e', 64),
    'lrd-suite-correlation')$s$, pg_temp.r(2), pg_temp.lrd_id(1006, 1), pg_temp.lrd_id(1002, 1),
    pg_temp.lrd_id(1003, 1), pg_temp.lrd_id(1005, 1), pg_temp.lrd_id(1002, 1)), false, null);
select pg_temp.lrd_case('T3 a withdrawal without a reason',
  '23514 new row for relation "result_discussion_events" violates check constraint "result_discussion_events_reason_ck"',
  format($s$insert into lab.result_discussion_events (result_id, result_version, patient_id, result_facility_id,
    event_no, kind, actor_account_id, actor_membership_id, actor_facility_id, idempotency_key, request_sha256,
    correlation_id) values (%L, 1, %L, %L, 2, 'withdrawn', %L, %L, %L, 'lrd-suite-direct-insert', repeat('e', 64),
    'lrd-suite-correlation')$s$, pg_temp.r(2), pg_temp.lrd_id(1006, 1), pg_temp.lrd_id(1002, 1),
    pg_temp.lrd_id(1003, 1), pg_temp.lrd_id(1005, 1), pg_temp.lrd_id(1002, 1)), false, null);
select pg_temp.lrd_case('T4 a mark of an unreleased version (no release row)',
  '23503 insert or update on table "result_discussion_events" violates foreign key constraint "result_discussion_events_release_fk"',
  format($s$insert into lab.result_discussion_events (result_id, result_version, patient_id, result_facility_id,
    event_no, kind, actor_account_id, actor_membership_id, actor_facility_id, idempotency_key, request_sha256,
    correlation_id) values (%L, 2, %L, %L, 1, 'discussed', %L, %L, %L, 'lrd-suite-direct-insert', repeat('e', 64),
    'lrd-suite-correlation')$s$, pg_temp.r(11), pg_temp.lrd_id(1006, 1), pg_temp.lrd_id(1002, 1),
    pg_temp.lrd_id(1003, 1), pg_temp.lrd_id(1005, 1), pg_temp.lrd_id(1002, 1)), false, null);

-- 7. The list (L1-L3).
select pg_temp.as_staff(1);
select pg_temp.lrd_case('L1a every visible result at its last released version (local and routed)', 'ok',
  pg_temp.lrd_q(pg_temp.list_rows('count(*), count(distinct l.result_id)'), '(11,11)'));
select pg_temp.lrd_case('L1b result 1: v2, finished, discussed as event 1', 'ok',
  pg_temp.lrd_q(pg_temp.list_rows('l.result_version, l.finished_visit, l.discussion_state, l.discussion_event_no, '
    || 'l.discussion_by_membership_id = ''' || pg_temp.lrd_id(1005, 1) || ''', l.withdrawal_reason_code') ||
    ' where l.result_id = ''' || pg_temp.r(1) || '''', '(2,t,discussed,1,t,)'));
select pg_temp.lrd_case('L1c result 3: withdrawn with its code, unfinished', 'ok',
  pg_temp.lrd_q(pg_temp.list_rows('l.result_version, l.finished_visit, l.discussion_state, l.discussion_event_no, '
    || 'l.withdrawal_reason_code') || ' where l.result_id = ''' || pg_temp.r(3) || '''',
    '(1,f,withdrawn,2,wrong_patient)'));
select pg_temp.lrd_case('L1d routed result 8: the report''s test, discussed', 'ok',
  pg_temp.lrd_q(pg_temp.list_rows('l.test_name, l.finished_visit, l.discussion_state') || ' where l.result_id = '''
    || pg_temp.r(8) || '''', '("Routed Test 8",t,discussed)'));
select pg_temp.lrd_case('L1e result 14: its flag, not discussed', 'ok',
  pg_temp.lrd_q(pg_temp.list_rows('l.abnormal_flag, l.finished_visit, l.discussion_state') || ' where l.result_id = '''
    || pg_temp.r(14) || '''', '(critical_candidate,t,)'));
select pg_temp.lrd_case('L1f no invalidated, unreleased, other patient''s, other facility''s or in-error routed row', 'ok',
  pg_temp.lrd_q(pg_temp.list_rows('count(*)') || format(' where l.result_id in (%L, %L, %L, %L, %L)', pg_temp.r(12),
    pg_temp.r(16), pg_temp.r(9), pg_temp.r(10), pg_temp.r(13)), '(0)'));
select pg_temp.lrd_case('L1g never the reason text', 'ok',
  pg_temp.lrd_q(pg_temp.list_rows('count(*)') || ' where row_to_json(l)::text like ''%Fictional withdrawal%''', '(0)'));
select pg_temp.lrd_case('L1h newest release first', 'ok',
  pg_temp.lrd_q(format('select (array_agg(l.result_id order by l.released_at desc, l.result_id))[1] = %L '
    || 'from lab.list_result_discussions(%L) l', pg_temp.r(15), pg_temp.lrd_id(1006, 1)), '(t)'));
select pg_temp.as_staff(2);
select pg_temp.lrd_case('L2 a nurse with lab.result.released.read may list', 'ok',
  pg_temp.lrd_q(pg_temp.list_rows('count(*)'), '(11)'));
select pg_temp.as_staff(5);
select pg_temp.lrd_case('L2b a read grant is enough to list', 'ok', pg_temp.lrd_q(pg_temp.list_rows('count(*)'), '(11)'));
select pg_temp.as_staff(3);
select pg_temp.lrd_case('L3 no grant', '42501 PATIENT_ACCESS_DENIED', pg_temp.list_rows('*'));
select pg_temp.as_staff(6);
select pg_temp.lrd_case('L3b the performing lab, no grant for the patient', '42501 PATIENT_ACCESS_DENIED',
  pg_temp.list_rows('*'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('L3c the patient''s own session', '42501 PURPOSE_OF_USE_REQUIRED', pg_temp.list_rows('*'));
select pg_temp.as_staff(1, 'direct-care', null);
select pg_temp.lrd_case('L3d no correlation ID', '42501 LAB_CONTEXT_REQUIRED', pg_temp.list_rows('*'));

-- 8. What the cases alone do not show, as the suite owner: the stored rows,
-- one per kept call, and no audit row from the database (lab-api writes those).
insert into lrd_cases (name, expected, actual)
select 'S1 result 1''s events are the kept calls', '1:1:discussed:-,1:2:withdrawn:not_yet_discussed,1:3:discussed:-,1:4:withdrawn:marked_in_error,2:1:discussed:-',
       (select string_agg(format('%s:%s:%s:%s', e.result_version, e.event_no, e.kind, coalesce(e.reason_code, '-')), ','
                          order by e.result_version, e.event_no)
          from lab.result_discussion_events e where e.result_id = pg_temp.lrd_id(1014, 1));
insert into lrd_cases (name, expected, actual)
select 'S2 one event per kept call, each with its correlation ID and patient', '12 0',
       (select count(*) || ' ' || count(*) filter (where e.correlation_id <> 'lrd-suite-correlation'
                                                      or e.patient_id <> pg_temp.lrd_id(1006, 1))
          from lab.result_discussion_events e);
insert into lrd_cases (name, expected, actual)
select 'S3 a routed mark names the performing lab and the ordering facility''s member', 'true',
       (select bool_and(e.result_facility_id = pg_temp.lrd_id(1002, 2) and e.actor_facility_id = pg_temp.lrd_id(1002, 1)
                        and e.actor_account_id = pg_temp.lrd_id(1003, 1)
                        and e.actor_membership_id = pg_temp.lrd_id(1005, 1))::text
          from lab.result_discussion_events e where e.result_id = pg_temp.lrd_id(1014, 8));
insert into lrd_cases (name, expected, actual)
select 'S4 the commands write no audit row (lab-api does)', current_setting('lrd_suite.audit_before'),
       (select count(*)::text from audit.events);

-- 9. A non-bypass owner. With a superuser owner, the tables involved, the
-- 0107 functions and the owner-only policy move to a fresh NOSUPERUSER
-- NOBYPASSRLS role for these cases (rolled back after); the owner then sees
-- only what the policies admit, as production's owner does.
savepoint non_bypass_owner;
do $$
declare
  name text;
begin
  if not current_setting('lrd_suite.owner_bypasses_rls')::boolean then
    return;
  end if;
  create role lrd_suite_owner nosuperuser nobypassrls nologin;
  grant usage on schema lab, ehr, identity, auth, platform, audit to lrd_suite_owner;
  grant execute on all functions in schema lab, ehr, identity, auth, platform to lrd_suite_owner;
  grant select on all tables in schema identity, auth to lrd_suite_owner;
  foreach name in array array['lab.results', 'lab.result_revisions', 'lab.result_releases', 'lab.result_invalidations',
      'lab.test_executions', 'lab.work_item_requested_tests', 'lab.work_items', 'lab.order_route_result_reports',
      'lab.result_discussion_events', 'ehr.encounters', 'ehr.lab_requests', 'ehr.order_routes'] loop
    execute format('alter table %s owner to lrd_suite_owner', name);
  end loop;
  foreach name in array array['lab.result_visit_finished(uuid,uuid,uuid)', 'lab.result_discussion_target(uuid,uuid)',
      'lab.patient_self_result_gates(uuid)', 'lab.record_result_discussion(uuid,uuid,bigint,text,text)',
      'lab.withdraw_result_discussion(uuid,uuid,bigint,text,text,text,text)', 'lab.list_result_discussions(uuid)'] loop
    execute format('alter function %s owner to lrd_suite_owner', name);
  end loop;
  alter policy lab_work_items_patient_result_gate on lab.work_items to lrd_suite_owner;
  if (select rolsuper or rolbypassrls from pg_roles r join pg_proc p on p.proowner = r.oid
       where p.oid = 'lab.patient_self_result_gates(uuid)'::regprocedure) then
    raise exception 'the moved owner still bypasses row-level security';
  end if;
end $$;
select pg_temp.as_patient(1);
select pg_temp.lrd_case('N-G1 non-bypass owner: finished, discussed v2', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 1), '(2,t,t)'));
select pg_temp.lrd_case('N-G2 non-bypass owner: encounter in progress', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 2), '(1,f,f)'));
select pg_temp.lrd_case('N-G9 non-bypass owner: patient A asking for B', 'ok',
  pg_temp.lrd_q(format('select count(*) from lab.patient_self_result_gates(%L) g', pg_temp.lrd_id(1006, 2)), '(0)'));
select pg_temp.lrd_case('N-G11 non-bypass owner: the runtime still sees no work item', 'ok',
  pg_temp.lrd_q('select count(*) from lab.work_items', '(0)'));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('N-R1 non-bypass owner: mark result 14', 'ok',
  pg_temp.lrd_q(pg_temp.mark(14, 1, 'lrd-key-0201-record', repeat('1', 64)), '(1,discussed,t,f)'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('N-G10a non-bypass owner: discussed', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 14), '(1,t,t)'));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('N-W1 non-bypass owner: withdraw', 'ok',
  pg_temp.lrd_q(pg_temp.withdraw(14, 1, 'other', 'Fictional withdrawal reason six', 'lrd-key-0202-withdraw',
    repeat('2', 64)), '(2,withdrawn,t,f)'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('N-G10b non-bypass owner: withdrawn', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 14), '(1,t,f)'));
select pg_temp.as_staff(1);
select pg_temp.lrd_case('N-R16 non-bypass owner: routed mark', 'ok',
  pg_temp.lrd_q(pg_temp.mark(15, 1, 'lrd-key-0203-record', repeat('3', 64)), '(1,discussed,t,f)'));
select pg_temp.lrd_case('N-R15 non-bypass owner: invalidated', 'P0001 RESULT_ENTERED_IN_ERROR',
  pg_temp.mark(12, 1, 'lrd-key-0204-record', repeat('4', 64)));
select pg_temp.lrd_case('N-R11 non-bypass owner: another patient''s result', 'P0002 RESULT_NOT_FOUND',
  pg_temp.mark(9, 1, 'lrd-key-0205-record', repeat('5', 64)));
select pg_temp.lrd_case('N-L1 non-bypass owner: the list', 'ok', pg_temp.lrd_q(pg_temp.list_rows('count(*)'), '(11)'));
select pg_temp.as_patient(1);
select pg_temp.lrd_case('N-G8 non-bypass owner: routed result finished, discussed', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 15), '(1,t,t)'));
-- A later migration narrowing what the owner sees of ehr.order_routes (here:
-- staff sessions only) hides the route from the patient gate. The visit check
-- must then read "not finished", never "the route did not end wrong_patient":
-- result 7's route ended wrong_patient, result 8's did not.
alter policy order_routes_command_read on ehr.order_routes
  using (nullif(current_setting('app.facility_id', true), '') is not null);
select pg_temp.lrd_case('N-G7x a route the owner cannot see: not finished (wrong-patient route)', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 7), '(1,f,f)'));
select pg_temp.lrd_case('N-G8x a route the owner cannot see: not finished (ordinary route)', 'ok',
  pg_temp.lrd_q(pg_temp.gate(1, 8), '(1,f,t)'));
alter policy order_routes_command_read on ehr.order_routes using (true);
select pg_temp.lrd_case('N-G8y the route seen again: finished', 'ok', pg_temp.lrd_q(pg_temp.gate(1, 8), '(1,t,t)'));
-- Without the owner-only policy the owner cannot reach the work item in a
-- patient session, so the gate loses the row and the patient chat drops the
-- result (fail-safe, but every result would vanish): the policy is needed.
drop policy lab_work_items_patient_result_gate on lab.work_items;
select pg_temp.lrd_case('N-G1x without the policy the gate loses the row', 'ok',
  pg_temp.lrd_q(format('select count(*) from lab.patient_self_result_gates(%L) g', pg_temp.lrd_id(1006, 1)),
    '(0)'));
-- The rollback below also undoes this section's rows in lrd_cases, so they are
-- checked here, before it.
select pg_temp.lrd_outcome('sections 3-9');
rollback to savepoint non_bypass_owner;

-- 9b. The list returns every released result (no cut before lab-api's
-- sensitive and critical gate): 520 newer released results of patient 1
-- leave the older result 1 (v2) in the list.
savepoint long_list;
set local session_replication_role = replica;
select pg_temp.lrd_chain(n, 1, 1, 1, 'completed', 'active', null, 1, 1, 'normal', false, 'Haemoglobin')
  from generate_series(2001, 2520) n;
set local session_replication_role = origin;
select pg_temp.as_staff(1);
select pg_temp.lrd_case('L4 a long history: every released result, the oldest included', 'ok',
  pg_temp.lrd_q(pg_temp.list_rows(format('count(*), bool_or(l.result_id = %L and l.result_version = 2)',
    pg_temp.r(1))), '(531,t)'));
select pg_temp.lrd_outcome('section 9b');
rollback to savepoint long_list;

-- 10. The outcome.
select pg_temp.lrd_outcome('lab result discussion suite');

rollback;
