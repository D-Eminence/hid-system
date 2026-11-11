\set ON_ERROR_STOP on
-- Admin dashboard activity (0123): identity.admin_platform_activity(p_days)
-- as the Identity API runtime. Who may call it (platform.dashboard.read, the
-- platform super admin only), the days it accepts, the one audit row per
-- call (details {"days": n} only), the numbers it moves (measured as the
-- difference from a first call in the same transaction, so rows other suites
-- or the sealed demo leave do not matter), and that names, emails, Health IDs
-- and file names leave it shortened. Each case is recorded and the suite
-- fails at the end listing every case whose outcome differs from the expected
-- one.
-- Run it also on a database whose migrations were applied by a role that is
-- neither superuser nor BYPASSRLS (as production's): there the read-window
-- policies are what let the function count rows in the FORCE row-level
-- security tables (with three of them dropped, 5d and 6e fail; under a
-- superuser owner every case passes either way).
-- Rollback-only. Synthetic values only; uuid prefix a123.
set plpgsql.variable_conflict = error;
begin;

create temporary table activity_cases (name text primary key, expected text not null, actual text not null)
  on commit drop;
grant all on activity_cases to public;

create function pg_temp.activity_as(subject text, correlation text default 'admin-activity-suite-0001')
returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.facility_id', '', true),
    set_config('app.membership_id', '', true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$$;
grant execute on function pg_temp.activity_as(text, text) to public;

create function pg_temp.activity_try(requested_days integer) returns text language plpgsql as $$
begin
  perform identity.admin_platform_activity(requested_days);
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$$;
grant execute on function pg_temp.activity_try(integer) to public;

create function pg_temp.activity_case(case_name text, expected text, actual text) returns void
language sql as $$ insert into activity_cases values (case_name, expected, coalesce(actual, '(null)')) $$;
grant execute on function pg_temp.activity_case(text, text, text) to public;

-- 1. Catalog: the permission is the super admin's alone; the function's ACL.
select pg_temp.activity_case('1a permission granted to platform_super_admin only', 'platform_super_admin',
  (select string_agg(role_code, ',' order by role_code) from auth.role_permissions
    where permission_code = 'platform.dashboard.read'));
select pg_temp.activity_case('1b identity runtime may execute', 'true',
  has_function_privilege('hid_identity_runtime', 'identity.admin_platform_activity(integer)', 'EXECUTE')::text);
select pg_temp.activity_case('1c public may not execute', 'false',
  has_function_privilege('public', 'identity.admin_platform_activity(integer)', 'EXECUTE')::text);
select pg_temp.activity_case('1d EHR runtime may not execute', 'false',
  has_function_privilege('hid_ehr_runtime', 'identity.admin_platform_activity(integer)', 'EXECUTE')::text);
select pg_temp.activity_case('1e identity runtime may not execute the name shortener', 'false',
  has_function_privilege('hid_identity_runtime', 'identity.admin_activity_short_name(text,text,text)', 'EXECUTE')::text);

-- 2. Fixtures.
set local session_replication_role = replica;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('a1230000-0000-4000-8000-000000000001', 'staff:activity-super', 'activity-super@example.invalid', 'Activity Super', 'active'),
  ('a1230000-0000-4000-8000-000000000002', 'staff:activity-platform-admin', 'activity-admin@example.invalid', 'Activity Admin', 'active'),
  ('a1230000-0000-4000-8000-000000000003', 'staff:activity-operations', 'activity-ops@example.invalid', 'Activity Ops', 'active'),
  ('a1230000-0000-4000-8000-000000000004', 'staff:activity-disabled-super', 'activity-disabled@example.invalid', 'Disabled Super', 'disabled'),
  ('a1230000-0000-4000-8000-000000000011', 'patient:activity-adaeze', 'adaeze.okafor@gmail.example', 'Adaeze Okafor', 'active'),
  ('a1230000-0000-4000-8000-000000000012', 'patient:activity-bola', 'bola.adeyemi@example.invalid', 'Bola Adeyemi', 'locked'),
  ('a1230000-0000-4000-8000-000000000013', 'staff:activity-clinician', 'activity-clinician@example.invalid', 'Activity Clinician', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('a1231000-0000-4000-8000-000000000001', 'a1230000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform', 'Synthetic activity suite'),
  ('a1231000-0000-4000-8000-000000000002', 'a1230000-0000-4000-8000-000000000002', 'platform_admin', 'platform', 'Synthetic activity suite'),
  ('a1231000-0000-4000-8000-000000000003', 'a1230000-0000-4000-8000-000000000003', 'platform_operations_admin', 'platform', 'Synthetic activity suite'),
  ('a1231000-0000-4000-8000-000000000004', 'a1230000-0000-4000-8000-000000000004', 'platform_super_admin', 'platform', 'Synthetic activity suite');
insert into identity.organizations (id, name, slug) values
  ('a1232000-0000-4000-8000-000000000001', 'Activity Suite Organization', 'activity-suite-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('a1232000-0000-4000-8000-000000000002', 'a1232000-0000-4000-8000-000000000001', 'Activity Suite Clinic',
   'ACTIVITY-SUITE', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('a1233000-0000-4000-8000-000000000001', 'a1230000-0000-4000-8000-000000000013', 'Activity Clinician',
   'activity-clinician@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role) values
  ('a1233000-0000-4000-8000-000000000002', 'a1233000-0000-4000-8000-000000000001',
   'a1230000-0000-4000-8000-000000000013', 'a1232000-0000-4000-8000-000000000001',
   'a1232000-0000-4000-8000-000000000002', 'doctor', 'doctor');
set local session_replication_role = origin;

-- 3. Who may call, and the days accepted (as the Identity API runtime).
set local role hid_identity_api_runtime;
select pg_temp.activity_as('staff:activity-platform-admin');
select pg_temp.activity_case('3a platform_admin (no dashboard permission) refused', '42501 ADMIN_PERMISSION_DENIED',
  pg_temp.activity_try(7));
select pg_temp.activity_as('staff:activity-operations');
select pg_temp.activity_case('3b operations admin refused', '42501 ADMIN_PERMISSION_DENIED', pg_temp.activity_try(30));
select pg_temp.activity_as('staff:activity-disabled-super');
select pg_temp.activity_case('3c disabled super admin refused', '42501 ADMIN_PERMISSION_DENIED', pg_temp.activity_try(7));
select pg_temp.activity_as('');
select pg_temp.activity_case('3d no session subject refused', '42501 ADMIN_PERMISSION_DENIED', pg_temp.activity_try(7));
select pg_temp.activity_as('patient:activity-adaeze');
select pg_temp.activity_case('3e a patient refused', '42501 ADMIN_PERMISSION_DENIED', pg_temp.activity_try(7));
select pg_temp.activity_as('staff:activity-super');
select pg_temp.activity_case('3f days 14 refused', '22023 ADMIN_INVALID_DAYS', pg_temp.activity_try(14));
select pg_temp.activity_case('3g days 0 refused', '22023 ADMIN_INVALID_DAYS', pg_temp.activity_try(0));
select pg_temp.activity_case('3h days null refused', '22023 ADMIN_INVALID_DAYS', pg_temp.activity_try(null));
select pg_temp.activity_case('3i days 7 accepted', 'ok', pg_temp.activity_try(7));
select pg_temp.activity_case('3j days 30 accepted', 'ok', pg_temp.activity_try(30));
select pg_temp.activity_case('3k days 90 accepted', 'ok', pg_temp.activity_try(90));
-- The read window cannot be opened or read by the runtime.
create function pg_temp.activity_forge() returns text language plpgsql as $$
begin
  insert into identity.admin_activity_read_windows (backend_pid, transaction_id)
  values (pg_backend_pid(), pg_current_xact_id());
  return 'ok';
exception when others then
  return sqlstate;
end
$$;
create function pg_temp.activity_peek() returns text language plpgsql as $$
begin
  return identity.admin_activity_read_open()::text;
exception when others then
  return sqlstate;
end
$$;
select pg_temp.activity_case('3l runtime cannot open a read window', '42501', pg_temp.activity_forge());
select pg_temp.activity_case('3m runtime cannot call the window helper', '42501', pg_temp.activity_peek());
reset role;
select pg_temp.activity_case('3n no read window left open after the calls', '0',
  (select count(*)::text from identity.admin_activity_read_windows));
select pg_temp.activity_case('3o the eleven read-window policies are the applier''s, SELECT only', '11',
  (select count(*)::text from pg_policy policy_row
    where pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'identity.admin_activity_read_open()'
      and policy_row.polcmd = 'r'
      and policy_row.polroles = array[(select proowner from pg_proc
                                        where oid = 'identity.admin_platform_activity(integer)'::regprocedure)]));

-- 4. The audit row: one per accepted call, platform-scoped, days only.
select pg_temp.activity_case('4a one audit row per accepted call, none for a refusal', '3',
  (select count(*)::text from audit.events where action = 'admin.overview.activity.read'
     and actor_account_id = 'a1230000-0000-4000-8000-000000000001'));
select pg_temp.activity_case('4b audit details are the days alone', '{"days": 7},{"days": 30},{"days": 90}',
  (select string_agg(details::text, ',' order by (details ->> 'days')::integer) from audit.events
    where action = 'admin.overview.activity.read' and actor_account_id = 'a1230000-0000-4000-8000-000000000001'));
select pg_temp.activity_case('4c audit row is platform-scoped', 'platform|platform-dashboard|healthcare-operations|||',
  (select string_agg(concat_ws('|', actor_type, resource_type, purpose_of_use, coalesce(facility_id::text, ''),
      coalesce(patient_id::text, ''), coalesce(resource_id, '')), ',')
     from audit.events where action = 'admin.overview.activity.read' and (details ->> 'days') = '7'
      and actor_account_id = 'a1230000-0000-4000-8000-000000000001'));

-- 5. The numbers move by exactly what the fixtures add.
create temporary table activity_before on commit drop as
  select identity.admin_platform_activity(7) as d7, identity.admin_platform_activity(30) as d30;
-- (the two baseline calls above ran as the applier with the super admin's session settings)

set local session_replication_role = replica;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, profile_percent, created_at) values
  ('a1234000-0000-4000-8000-000000000001', 'a1230000-0000-4000-8000-000000000011', 'HID-7KQWERM9', 'Adaeze', 'Okafor',
   'Adaeze Okafor', 'active', 100, clock_timestamp() - interval '1 minute'),
  ('a1234000-0000-4000-8000-000000000002', 'a1230000-0000-4000-8000-000000000012', 'HID-BCDFGH', 'Bola', 'Adeyemi',
   'Bola Adeyemi', 'active', 40, clock_timestamp() - interval '2 minutes'),
  ('a1234000-0000-4000-8000-000000000003', null, 'HID-XYZ234', 'Chidi', '', 'Chidi Nnamdi Eze', 'active', 60,
   clock_timestamp() - interval '12 days'),
  ('a1234000-0000-4000-8000-000000000004', null, 'HID-DELETED', 'Deleted', 'Person', 'Deleted Person', 'deleted', 100,
   clock_timestamp() - interval '3 minutes');
insert into identity.patient_assurance_states (patient_id, account_id, state, source_system, nin_verified_at, verified_provider)
values ('a1234000-0000-4000-8000-000000000001', 'a1230000-0000-4000-8000-000000000011', 'NIN_VERIFIED', 'synthetic',
  clock_timestamp(), 'synthetic-provider');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at)
values ('a1235000-0000-4000-8000-000000000001', 'a1230000-0000-4000-8000-000000000011',
  'a1235000-0000-4000-8000-000000000002', repeat('a', 64), 'a1235000-0000-4000-8000-000000000003', 1, 'password',
  clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '1 day');
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_number,
  encounter_type, status, started_at)
values ('a1236000-0000-4000-8000-000000000001', 'a1234000-0000-4000-8000-000000000001',
  'a1232000-0000-4000-8000-000000000002', 'a1230000-0000-4000-8000-000000000013',
  'a1233000-0000-4000-8000-000000000002', 'ACT-0001', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status,
  retention_class, created_at, updated_at)
select ('a1237000-0000-4000-8000-00000000000' || d.n)::uuid, 'a1234000-0000-4000-8000-000000000001',
       'a1232000-0000-4000-8000-000000000002', 'a1230000-0000-4000-8000-000000000013',
       'a1233000-0000-4000-8000-000000000002', d.file_name, 'hid-activity-suite',
       'clinical/objects/a1237000-0000-4000-8000-00000000000' || d.n, 'activity-v' || d.n, 'application/pdf',
       2048 * d.n, repeat(d.n::text, 64), d.status, 'clinical_record',
       clock_timestamp() + d.n * interval '1 second', clock_timestamp()
  from (values (1, 'Adaeze_Okafor_lab_result.PDF', 'uploaded'), (2, 'scan.pdf', 'uploaded'),
               (3, 'xray.png', 'rejected')) d(n, file_name, status);
insert into ehr.document_scan_events (id, document_id, patient_id, facility_id, created_by, event_type,
  detected_media_type, reason_code, scanner_engine, scanner_version, idempotency_key, correlation_id,
  object_version_id, object_sha256_hex, created_at)
values ('a1238000-0000-4000-8000-000000000001', 'a1237000-0000-4000-8000-000000000001',
  'a1234000-0000-4000-8000-000000000001', 'a1232000-0000-4000-8000-000000000002',
  'd0c5ca40-0105-4000-8000-000000000001', 'clean', 'application/pdf', null,
  'aws-guardduty-malware-protection-s3', '1.0', 'activity-suite-fixture-0001', 'activity-suite-fixture',
  'activity-v1', repeat('1', 64), clock_timestamp());
set local session_replication_role = origin;

set local role hid_identity_api_runtime;
select pg_temp.activity_as('staff:activity-super', 'admin-activity-suite-0002');
create temporary table activity_after on commit drop as
  select identity.admin_platform_activity(7) as d7, identity.admin_platform_activity(30) as d30;
reset role;

create function pg_temp.delta(path text[], period text default 'd7') returns text language sql as $$
  select ((case period when 'd7' then after_row.d7 else after_row.d30 end #>> path)::numeric
        - (case period when 'd7' then before_row.d7 else before_row.d30 end #>> path)::numeric)::text
    from activity_after after_row, activity_before before_row
$$;
select pg_temp.activity_case('5a two new patients in 7 days (deleted one left out)', '2',
  pg_temp.delta('{people,newInPeriod}'));
select pg_temp.activity_case('5b three new patients in 30 days', '3', pg_temp.delta('{people,newInPeriod}', 'd30'));
select pg_temp.activity_case('5c one active account', '1', pg_temp.delta('{people,activeInPeriod}'));
select pg_temp.activity_case('5d one visit', '1', pg_temp.delta('{care,visits}'));
select pg_temp.activity_case('5e days and shape', '7|7|30|30',
  (select concat_ws('|', d7 ->> 'days', jsonb_array_length(d7 -> 'daily'), d30 ->> 'days',
     jsonb_array_length(d30 -> 'daily')) from activity_after));
select pg_temp.activity_case('5f last daily entry is today in Lagos', to_char((clock_timestamp() at time zone 'Africa/Lagos')::date, 'YYYY-MM-DD'),
  (select d7 -> 'daily' -> 6 ->> 'date' from activity_after));
select pg_temp.activity_case('5g today counts the two sign-ups', '2',
  ((select (d7 -> 'daily' -> 6 ->> 'signups')::integer from activity_after)
   - (select (d7 -> 'daily' -> 6 ->> 'signups')::integer from activity_before))::text);
select pg_temp.activity_case('5h at most ten sign-ups and uploads', 'true',
  (select (jsonb_array_length(d7 -> 'recentSignups') <= 10 and jsonb_array_length(d7 -> 'recentUploads') <= 10)::text
     from activity_after));

-- 6. Shortened, never whole.
select pg_temp.activity_case('6a sign-up shortened', 'Adaeze O.|a***@gmail.example|HID-7K…M9|100|verified',
  (select concat_ws('|', item ->> 'name', item ->> 'email', item ->> 'healthId', item ->> 'profilePct', item ->> 'status')
     from activity_after, jsonb_array_elements(d7 -> 'recentSignups') item where item ->> 'healthId' = 'HID-7K…M9'));
select pg_temp.activity_case('6b locked account shows suspended', 'Bola A.|b***@example.invalid|suspended',
  (select concat_ws('|', item ->> 'name', item ->> 'email', item ->> 'status')
     from activity_after, jsonb_array_elements(d7 -> 'recentSignups') item where item ->> 'healthId' = 'HID-BC…GH'));
select pg_temp.activity_case('6c no account and no last name: first name alone, no email, pending', 'Chidi||pending',
  (select concat_ws('|', item ->> 'name', coalesce(item ->> 'email', ''), item ->> 'status')
     from activity_after, jsonb_array_elements(d30 -> 'recentSignups') item where item ->> 'healthId' = 'HID-XY…34'));
select pg_temp.activity_case('6d no whole name, email, Health ID or file name in the answer', 'true',
  (select (position('Okafor' in d7::text || d30::text) = 0 and position('adaeze.okafor' in d7::text || d30::text) = 0
       and position('7KQWERM9' in d7::text || d30::text) = 0 and position('Adeyemi' in d7::text || d30::text) = 0
       and position('Nnamdi' in d7::text || d30::text) = 0 and position('lab_result' in d7::text || d30::text) = 0
       and position('Deleted' in d7::text || d30::text) = 0)::text from activity_after));
select pg_temp.activity_case('6e uploads: file names shortened, scan state, size, facility',
  'Adaeze….pdf|Adaeze O.|Activity Suite Clinic|2048|clean;scan.pdf|Adaeze O.|Activity Suite Clinic|4096|pending;xray.png|Adaeze O.|Activity Suite Clinic|6144|refused',
  (select string_agg(concat_ws('|', item ->> 'document', item ->> 'patient', item ->> 'facility', item ->> 'sizeBytes',
      item ->> 'scan'), ';' order by (item ->> 'sizeBytes')::integer)
     from activity_after, jsonb_array_elements(d7 -> 'recentUploads') item
    where item ->> 'facility' = 'Activity Suite Clinic'));
select pg_temp.activity_case('6f shorteners on edge values', 'Unnamed|document|a.pdf|Ngozi',
  concat_ws('|', identity.admin_activity_short_name(null, null, '  '), identity.admin_activity_short_file_name(''),
    identity.admin_activity_short_file_name('a.pdf'), identity.admin_activity_short_name(' Ngozi ', '', null)));

-- Result.
do $$
declare failures text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by name)
    into failures from activity_cases where expected is distinct from actual;
  if failures is not null then
    raise exception E'admin platform activity cases failed:\n%', failures;
  end if;
  raise notice 'admin platform activity: % cases passed', (select count(*) from activity_cases);
end
$$;

rollback;
