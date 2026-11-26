\set ON_ERROR_STOP on
-- 0203 and 0204 (REP-1, Release D): the facility's operations report. Rollback-only. Synthetic values only; uuid
-- prefix f203; .invalid addresses. Run as the cluster superuser on a database migrated by a NOSUPERUSER NOBYPASSRLS
-- migrator with the role bootstrap; every report is read as the EHR API runtime, so the functions run as their owner
-- under the tables' forced row-level security.
--   1. structure: the functions (SECURITY DEFINER for the two routes, invoker for the helper and the stamp),
--      search_path, EXECUTE, the marker table and policies, the two codes and their four role rows;
--   2. every figure on a seeded facility over a 7-day range and its previous period: Lagos day edges (23:30 UTC is
--      the next Lagos day), tracked and untracked check-ins and their coverage, a result released twice counted
--      once and one first released before the range not counted, a reversed dispensing not counted as dispensed,
--      visits imported from paper, cancelled and entered in error left out, lab requests and samples by status,
--      the eight reasons; another facility's rows never counted; the shape of the answer;
--   3. the download: counts from 1 to 4 null and marked, 0 and 5 shown, medians of samples under 5 hidden, sample
--      sizes and coverage hidden the same way; no number from 1 to 4 left anywhere; suppressedValues is the number
--      of hidden values;
--   4. the range: 92 days accepted (today counting so far), 93 refused, from after to, a future to and more than
--      2 years back refused; the format;
--   5. the caller: no code, a download without reports.export, another purpose, a held, an inactive and another
--      facility's membership, no session; the switch off refusing at a real facility and not at a sealed demo or QA
--      facility, which count only their own rows;
--   6. audit: exactly one row per call that answers, with no patient and no figure's value; none for a refusal;
--   7. the marker: none left after a call or a refusal; the owner reads a source table only while its own
--      transaction holds one; a runtime role's own reads unchanged by one; an owner-run read after a report in the
--      same transaction sees nothing more;
--   8. the waiting list's stamp: on insert at with_clinician, on the first move there through 0135's own update,
--      unchanged by later moves and by a direct update as the owner, never on an untracked row; the CHECK;
--   9. the cost: one facility with 92 days of fictional work (about 50,000 check-ins and 50,000 visits, and lab and
--      pharmacy work): route 1 well inside ehr-api's 15-second limit, its time printed against the 2-second target.
set plpgsql.variable_conflict = error;
begin;

create temporary table report_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
-- Cases are also recorded while the EHR runtime or the tables' owner is the current role.
grant insert on pg_temp.report_outcomes to public;
grant usage on sequence pg_temp.report_outcomes_seq_seq to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.report_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
-- Lagos days relative to today, and a Lagos wall-clock time on one.
create function pg_temp.d(back integer) returns date language sql stable as $f$
  select (clock_timestamp() at time zone 'Africa/Lagos')::date - back
$f$;
create function pg_temp.at(back integer, wall text) returns timestamptz language sql stable as $f$
  select (pg_temp.d(back)::timestamp + wall::time) at time zone 'Africa/Lagos'
$f$;
create function pg_temp.as_staff(subject text, membership text, facility text, purpose text,
  correlation text) returns void language sql as $f$
  select set_config('app.actor_subject', coalesce(subject, ''), true),
         set_config('app.membership_id', coalesce(membership, ''), true),
         set_config('app.facility_id', coalesce(facility, ''), true),
         set_config('app.purpose_of_use', coalesce(purpose, ''), true),
         set_config('app.correlation_id', coalesce(correlation, ''), true);
$f$;
-- One call of route 1 or route 2 (days counted back from today), or the SQLSTATE and message.
create function pg_temp.report(from_back integer, to_back integer, switched_on boolean default true) returns jsonb
language plpgsql as $f$
begin
  return ehr.facility_report_operations(pg_temp.d(from_back), pg_temp.d(to_back), switched_on);
exception when others then
  return jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
end
$f$;
create function pg_temp.download(from_back integer, to_back integer, format text default 'csv',
  switched_on boolean default true) returns jsonb language plpgsql as $f$
begin
  return ehr.facility_report_operations_export(pg_temp.d(from_back), pg_temp.d(to_back), format, switched_on);
exception when others then
  return jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
end
$f$;
-- One figure as a line: current|previous|daily values (oldest first). A hidden value is *, a median with no sample
-- -/0, a median value/sample.
create function pg_temp.cell(figure jsonb, name text) returns text language sql immutable as $f$
  select case when coalesce((figure ->> (name || 'Suppressed'))::boolean, false) then '*'
              else coalesce(figure ->> name, '-') end
$f$;
create function pg_temp.line(answer jsonb, figure_key text) returns text language sql immutable as $f$
  select case when figure_row ->> 'kind' = 'count' then
           concat_ws('|', pg_temp.cell(figure_row, 'current'), pg_temp.cell(figure_row, 'previous'),
             (select string_agg(case when coalesce((entry ->> 'suppressed')::boolean, false) then '*'
                                     else entry ->> 'value' end, ',' order by position)
                from jsonb_array_elements(figure_row -> 'daily') with ordinality daily(entry, position)))
         else
           concat_ws('|',
             case when pg_temp.cell(figure_row, 'current') = '*' then '*'
                  else pg_temp.cell(figure_row, 'current') || '/' || pg_temp.cell(figure_row, 'sampleSize') end,
             case when pg_temp.cell(figure_row, 'previous') = '*' then '*'
                  else pg_temp.cell(figure_row, 'previous') || '/' || pg_temp.cell(figure_row, 'previousSampleSize') end,
             (select string_agg(case when coalesce((entry ->> 'suppressed')::boolean, false) then '*'
                                     else coalesce(entry ->> 'value', '-') || '/' || (entry ->> 'sampleSize') end,
                                ',' order by position)
                from jsonb_array_elements(figure_row -> 'daily') with ordinality daily(entry, position)))
         end
    from jsonb_array_elements(answer -> 'sections') section_row,
         jsonb_array_elements(section_row -> 'figures') figure_row
   where figure_row ->> 'key' = figure_key
$f$;
create function pg_temp.figure(answer jsonb, figure_key text) returns jsonb language sql immutable as $f$
  select figure_row from jsonb_array_elements(answer -> 'sections') section_row,
         jsonb_array_elements(section_row -> 'figures') figure_row
   where figure_row ->> 'key' = figure_key
$f$;
create function pg_temp.key(prefix text, n integer) returns text language sql immutable as $f$
  select 'rep0203-' || prefix || '-' || lpad(n::text, 10, '0')
$f$;
-- A marker written by the calling role, or the SQLSTATE that refuses it.
create function pg_temp.marker_attempt() returns text language plpgsql as $f$
begin
  insert into ehr.report_scans (backend_pid, transaction_started_at) values (pg_backend_pid(), transaction_timestamp());
  return 'written';
exception when others then
  return sqlstate;
end
$f$;
-- A waiting-list row with a stamp and no wait_tracked (only possible with the trigger off), or the SQLSTATE.
create function pg_temp.unstamped_insert() returns text language plpgsql as $f$
begin
  insert into ehr.visit_queue (facility_id, patient_id, queue_day, stage, check_in_basis, checked_in_by_account_id,
    checked_in_by_membership_id, checked_in_at, stage_changed_at, updated_by_membership_id, first_with_clinician_at)
  values ('f2031000-0000-4000-8000-0000000000f1', 'f2037000-0000-4000-8000-000000000022',
    (clock_timestamp() at time zone 'Africa/Lagos')::date, 'with_clinician', 'search',
    'f2032000-0000-4000-8000-0000000000a0', 'f2035000-0000-4000-8000-0000000000a1', clock_timestamp(),
    clock_timestamp(), 'f2035000-0000-4000-8000-0000000000a1', clock_timestamp());
  return 'written';
exception when others then
  return sqlstate;
end
$f$;

-- The fixture. F1 and F2 are real facilities; S1 a sealed demo facility, Q1 the sealed QA facility. A is an
-- administrator (admin at F1, Q1 and S1, org_admin at F2); D a doctor at F1; R holds a synthetic role with
-- reports.read only; H an admin whose membership the cutover holds; I an admin whose membership is inactive;
-- N a nurse at F1 (for 0135's own update).
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug, active) values
  ('f2030000-0000-4000-8000-0000000000a1', 'Reports Org', 'reports-org-f203', true);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f2031000-0000-4000-8000-0000000000f1', 'f2030000-0000-4000-8000-0000000000a1', 'Reports Alpha', 'REP-F1', 'Africa/Lagos', true, 'verified'),
  ('f2031000-0000-4000-8000-0000000000f2', 'f2030000-0000-4000-8000-0000000000a1', 'Reports Beta', 'REP-F2', 'Africa/Lagos', true, 'verified'),
  ('f2031000-0000-4000-8000-0000000000f3', 'f2030000-0000-4000-8000-0000000000a1', 'Reports Demo', 'REP-S1', 'Africa/Lagos', true, 'verified'),
  ('f2031000-0000-4000-8000-0000000000f4', 'f2030000-0000-4000-8000-0000000000a1', 'Reports QA', 'REP-Q1', 'Africa/Lagos', true, 'verified'),
  ('f2031000-0000-4000-8000-0000000000f9', 'f2030000-0000-4000-8000-0000000000a1', 'Reports Busy', 'REP-F9', 'Africa/Lagos', true, 'verified');
insert into identity.sealed_demo_members (member_kind, member_id) values ('facility', 'f2031000-0000-4000-8000-0000000000f3');
insert into identity.sealed_qa_members (member_kind, member_id) values ('facility', 'f2031000-0000-4000-8000-0000000000f4');
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm, token_version)
select ('f2032000-0000-4000-8000-0000000000' || person.code)::uuid, 'synthetic:reports-0203:' || person.code,
       person.code || '@reports-0203.invalid', 'active', 'synthetic-hash', 'argon2id', 1
  from (values ('a0'), ('d0'), ('b0'), ('c0'), ('e0'), ('90')) person(code);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active)
select ('f2034000-0000-4000-8000-0000000000' || person.code)::uuid,
       ('f2032000-0000-4000-8000-0000000000' || person.code)::uuid, 'Reports Staff ' || person.code,
       person.code || '@reports-0203.invalid', 'verified', person.role_code, true
  from (values ('a0', 'admin'), ('d0', 'doctor'), ('b0', 'admin'), ('c0', 'admin'), ('e0', 'admin'), ('90', 'nurse'))
         person(code, role_code);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, migration_hold_reason)
select membership.id::uuid, ('f2034000-0000-4000-8000-0000000000' || membership.person)::uuid,
       ('f2032000-0000-4000-8000-0000000000' || membership.person)::uuid, 'f2030000-0000-4000-8000-0000000000a1',
       membership.facility::uuid, membership.role_code, membership.role_code, membership.is_primary, membership.active,
       membership.hold
  from (values
    ('f2035000-0000-4000-8000-0000000000a1', 'a0', 'f2031000-0000-4000-8000-0000000000f1', 'admin', true, true, null),
    ('f2035000-0000-4000-8000-0000000000a2', 'a0', 'f2031000-0000-4000-8000-0000000000f2', 'org_admin', false, true, null),
    ('f2035000-0000-4000-8000-0000000000a3', 'a0', 'f2031000-0000-4000-8000-0000000000f3', 'admin', false, true, null),
    ('f2035000-0000-4000-8000-0000000000a4', 'a0', 'f2031000-0000-4000-8000-0000000000f4', 'admin', false, true, null),
    ('f2035000-0000-4000-8000-0000000000a9', 'a0', 'f2031000-0000-4000-8000-0000000000f9', 'admin', false, true, null),
    ('f2035000-0000-4000-8000-0000000000d1', 'd0', 'f2031000-0000-4000-8000-0000000000f1', 'doctor', true, true, null),
    ('f2035000-0000-4000-8000-0000000000b1', 'b0', 'f2031000-0000-4000-8000-0000000000f1', 'admin', true, true, null),
    ('f2035000-0000-4000-8000-0000000000c1', 'c0', 'f2031000-0000-4000-8000-0000000000f1', 'admin', true, true,
     'Synthetic cutover hold'),
    ('f2035000-0000-4000-8000-0000000000e1', 'e0', 'f2031000-0000-4000-8000-0000000000f1', 'admin', true, false, null),
    ('f2035000-0000-4000-8000-000000000091', '90', 'f2031000-0000-4000-8000-0000000000f1', 'nurse', true, true, null)
  ) membership(id, person, facility, role_code, is_primary, active, hold);
-- A synthetic role holding reports.read only (no backend role is so in 0204).
insert into auth.roles (code, description, active) values ('rep0203_reader', 'Synthetic 0203 reader', true);
insert into auth.role_permissions (role_code, permission_code) values ('rep0203_reader', 'reports.read');
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('f2032000-0000-4000-8000-0000000000' || role_row.person)::uuid, role_row.role_code,
       'facility', role_row.membership::uuid, role_row.facility::uuid, 'Synthetic 0203 role'
  from (values
    ('a0', 'admin', 'f2035000-0000-4000-8000-0000000000a1', 'f2031000-0000-4000-8000-0000000000f1'),
    ('a0', 'org_admin', 'f2035000-0000-4000-8000-0000000000a2', 'f2031000-0000-4000-8000-0000000000f2'),
    ('a0', 'admin', 'f2035000-0000-4000-8000-0000000000a3', 'f2031000-0000-4000-8000-0000000000f3'),
    ('a0', 'admin', 'f2035000-0000-4000-8000-0000000000a4', 'f2031000-0000-4000-8000-0000000000f4'),
    ('a0', 'admin', 'f2035000-0000-4000-8000-0000000000a9', 'f2031000-0000-4000-8000-0000000000f9'),
    ('d0', 'doctor', 'f2035000-0000-4000-8000-0000000000d1', 'f2031000-0000-4000-8000-0000000000f1'),
    ('b0', 'rep0203_reader', 'f2035000-0000-4000-8000-0000000000b1', 'f2031000-0000-4000-8000-0000000000f1'),
    ('c0', 'admin', 'f2035000-0000-4000-8000-0000000000c1', 'f2031000-0000-4000-8000-0000000000f1'),
    ('e0', 'admin', 'f2035000-0000-4000-8000-0000000000e1', 'f2031000-0000-4000-8000-0000000000f1'),
    ('90', 'nurse', 'f2035000-0000-4000-8000-000000000091', 'f2031000-0000-4000-8000-0000000000f1')
  ) role_row(person, role_code, membership, facility);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status)
select ('f2037000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'HID-RPQ' || translate(lpad(n::text, 4, '0'), '0123456789', 'ABCDEFGHJK'),
       'Report', 'Patient' || n, 'Report Patient' || n, date '1980-01-01' + n, 'female', 'active'
  from generate_series(1, 40) n;
set local session_replication_role = origin;

-- The waiting list at F1 (and one row each at F2, S1 and Q1). Tracked rows are written as any writer writes them
-- (the stamp trigger fires); the two untracked rows stand for check-ins from before 0203 (written with triggers
-- off, so both columns stay null).
create function pg_temp.check_in(row_id text, facility text, patient integer, checked_in timestamptz, stage text,
  changed timestamptz) returns void language sql as $f$
  insert into ehr.visit_queue (id, facility_id, patient_id, queue_day, stage, check_in_basis, checked_in_by_account_id,
    checked_in_by_membership_id, checked_in_at, stage_changed_at, closed_at, updated_by_membership_id, updated_at)
  values (row_id::uuid, facility::uuid, ('f2037000-0000-4000-8000-' || lpad(patient::text, 12, '0'))::uuid,
    (checked_in at time zone 'Africa/Lagos')::date, stage, 'search', 'f2032000-0000-4000-8000-0000000000a0',
    'f2035000-0000-4000-8000-0000000000a1', checked_in, changed,
    case when stage in ('finished', 'left', 'cancelled') then changed end,
    'f2035000-0000-4000-8000-0000000000a1', changed)
$f$;
create function pg_temp.move(row_id text, stage text, changed timestamptz) returns void language sql as $f$
  update ehr.visit_queue entry
     set stage = move.stage, stage_changed_at = changed,
         closed_at = case when move.stage in ('finished', 'left', 'cancelled') then changed end,
         updated_at = changed, row_version = entry.row_version + 1
   where entry.id = row_id::uuid
$f$;
-- q1: seen (30 minutes) then finished; q2: finished without reaching a clinician; q3: left before being seen; q4:
-- seen (10 minutes) then left; q6: cancelled; q8: checked in at 23:30 UTC the day before (Lagos 00:30), still
-- waiting; q7: checked in straight to the clinician (5 minutes). q9: previous period, seen after 40 minutes.
select pg_temp.check_in('f2038000-0000-4000-8000-000000000001', 'f2031000-0000-4000-8000-0000000000f1', 1, pg_temp.at(9, '09:00'), 'waiting', pg_temp.at(9, '09:00'));
select pg_temp.move('f2038000-0000-4000-8000-000000000001', 'with_clinician', pg_temp.at(9, '09:30'));
select pg_temp.move('f2038000-0000-4000-8000-000000000001', 'finished', pg_temp.at(9, '10:00'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000002', 'f2031000-0000-4000-8000-0000000000f1', 2, pg_temp.at(9, '09:05'), 'waiting', pg_temp.at(9, '09:05'));
select pg_temp.move('f2038000-0000-4000-8000-000000000002', 'finished', pg_temp.at(9, '11:00'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000003', 'f2031000-0000-4000-8000-0000000000f1', 3, pg_temp.at(9, '09:10'), 'waiting', pg_temp.at(9, '09:10'));
select pg_temp.move('f2038000-0000-4000-8000-000000000003', 'left', pg_temp.at(9, '12:00'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000004', 'f2031000-0000-4000-8000-0000000000f1', 4, pg_temp.at(9, '09:15'), 'triage', pg_temp.at(9, '09:15'));
select pg_temp.move('f2038000-0000-4000-8000-000000000004', 'with_clinician', pg_temp.at(9, '09:25'));
select pg_temp.move('f2038000-0000-4000-8000-000000000004', 'left', pg_temp.at(9, '09:50'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000006', 'f2031000-0000-4000-8000-0000000000f1', 6, pg_temp.at(9, '09:20'), 'waiting', pg_temp.at(9, '09:20'));
select pg_temp.move('f2038000-0000-4000-8000-000000000006', 'cancelled', pg_temp.at(9, '09:40'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000008', 'f2031000-0000-4000-8000-0000000000f1', 8, pg_temp.at(9, '00:30'), 'waiting', pg_temp.at(9, '00:30'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000007', 'f2031000-0000-4000-8000-0000000000f1', 7, pg_temp.at(3, '15:00'), 'with_clinician', pg_temp.at(3, '15:05'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000009', 'f2031000-0000-4000-8000-0000000000f1', 9, pg_temp.at(12, '08:00'), 'waiting', pg_temp.at(12, '08:00'));
select pg_temp.move('f2038000-0000-4000-8000-000000000009', 'with_clinician', pg_temp.at(12, '08:40'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000011', 'f2031000-0000-4000-8000-0000000000f2', 11, pg_temp.at(5, '08:00'), 'with_clinician', pg_temp.at(5, '08:01'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000012', 'f2031000-0000-4000-8000-0000000000f3', 12, pg_temp.at(5, '08:00'), 'waiting', pg_temp.at(5, '08:00'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000013', 'f2031000-0000-4000-8000-0000000000f4', 13, pg_temp.at(5, '08:00'), 'waiting', pg_temp.at(5, '08:00'));
set local session_replication_role = replica;
-- q5 (in the range, closed left) and q10 (previous period): from before 0203, not tracked.
select pg_temp.check_in('f2038000-0000-4000-8000-000000000005', 'f2031000-0000-4000-8000-0000000000f1', 5, pg_temp.at(9, '09:30'), 'left', pg_temp.at(9, '10:30'));
select pg_temp.check_in('f2038000-0000-4000-8000-000000000010', 'f2031000-0000-4000-8000-0000000000f1', 10, pg_temp.at(12, '09:00'), 'waiting', pg_temp.at(12, '09:00'));

-- Registrations (triggers off: only the shape CHECKs apply).
create function pg_temp.registration(n integer, facility text, status text, created timestamptz) returns void
language sql as $f$
  insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
    first_name, last_name, full_name, dob, gender, identity_evidence, no_nin_reason, nin_ciphertext, nin_lookup_hmac,
    nin_last4, nin_key_version, verification_provider, verification_reference, verified_at, idempotency_key,
    request_sha256, resolved_patient_id, review_idempotency_key, review_request_sha256, reviewed_by_account_id,
    reviewed_by_membership_id, review_reason, created_at, updated_at)
  select ('f2039000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, facility::uuid,
         'f2032000-0000-4000-8000-0000000000a0', 'f2035000-0000-4000-8000-0000000000a1', status,
         'Case', 'Person' || n, 'Case Person' || n, date '1990-01-01', 'male',
         case when nin then 'nin_verified' else 'none' end, case when nin then null else 'no_nin' end,
         case when nin then decode(repeat('ab', 32), 'hex') end, case when nin then md5(n::text) || md5(n::text) end,
         case when nin then '1234' end, case when nin then 'v1' end, case when nin then 'synthetic' end,
         case when nin then 'synthetic-ref' end, case when nin then created end,
         pg_temp.key('case', n), repeat('a', 64),
         case when status in ('resolved_existing_identity', 'linked_existing', 'approved_new_identity')
              then ('f2037000-0000-4000-8000-' || lpad((n % 40 + 1)::text, 12, '0'))::uuid end,
         case when reviewed then pg_temp.key('review', n) end, case when reviewed then repeat('b', 64) end,
         case when reviewed then 'f2032000-0000-4000-8000-0000000000a0'::uuid end,
         case when reviewed then 'f2035000-0000-4000-8000-0000000000a1'::uuid end,
         case when reviewed then 'Synthetic review reason' end, created, created
    from (select status = 'resolved_existing_identity' as nin,
                 status in ('linked_existing', 'approved_new_identity', 'rejected', 'cancelled') as reviewed) shape
$f$;
select pg_temp.registration(1, 'f2031000-0000-4000-8000-0000000000f1', 'approved_new_identity', pg_temp.at(9, '00:30'));
select pg_temp.registration(2, 'f2031000-0000-4000-8000-0000000000f1', 'approved_new_identity', pg_temp.at(6, '10:00'));
select pg_temp.registration(3, 'f2031000-0000-4000-8000-0000000000f1', 'linked_existing', pg_temp.at(8, '11:00'));
select pg_temp.registration(4, 'f2031000-0000-4000-8000-0000000000f1', 'resolved_existing_identity', pg_temp.at(8, '12:00'));
select pg_temp.registration(5, 'f2031000-0000-4000-8000-0000000000f1', 'rejected', pg_temp.at(7, '10:00'));
select pg_temp.registration(6, 'f2031000-0000-4000-8000-0000000000f1', 'review_required', pg_temp.at(7, '10:00'));
select pg_temp.registration(7, 'f2031000-0000-4000-8000-0000000000f1', 'approved_new_identity', pg_temp.at(2, '00:30'));
select pg_temp.registration(8, 'f2031000-0000-4000-8000-0000000000f1', 'approved_new_identity', pg_temp.at(14, '10:00'));
select pg_temp.registration(9, 'f2031000-0000-4000-8000-0000000000f2', 'approved_new_identity', pg_temp.at(6, '10:00'));

-- Visits.
create function pg_temp.visit(n integer, facility text, status text, started timestamptz, ended timestamptz,
  paper boolean default false) returns void language sql as $f$
  insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
    started_at, ended_at, imported_paper_records, chief_complaint)
  values (('f203a000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
    ('f2037000-0000-4000-8000-' || lpad((n % 40 + 1)::text, 12, '0'))::uuid, facility::uuid,
    'f2032000-0000-4000-8000-0000000000d0', 'f2035000-0000-4000-8000-0000000000d1',
    case when paper then 'other' else 'ambulatory' end, status, started, ended, paper,
    case when paper then 'Imported paper records (Migrate)' end)
$f$;
select pg_temp.visit(1, 'f2031000-0000-4000-8000-0000000000f1', 'in_progress', pg_temp.at(8, '09:00'), null);
select pg_temp.visit(2, 'f2031000-0000-4000-8000-0000000000f1', 'completed', pg_temp.at(8, '10:00'), pg_temp.at(7, '10:00'));
select pg_temp.visit(3, 'f2031000-0000-4000-8000-0000000000f1', 'cancelled', pg_temp.at(8, '11:00'), null);
select pg_temp.visit(4, 'f2031000-0000-4000-8000-0000000000f1', 'entered_in_error', pg_temp.at(8, '12:00'), null);
select pg_temp.visit(5, 'f2031000-0000-4000-8000-0000000000f1', 'completed', pg_temp.at(7, '09:00'), pg_temp.at(7, '09:00'), true);
select pg_temp.visit(6, 'f2031000-0000-4000-8000-0000000000f1', 'completed', pg_temp.at(11, '09:00'), pg_temp.at(9, '09:00'));
select pg_temp.visit(7, 'f2031000-0000-4000-8000-0000000000f2', 'completed', pg_temp.at(8, '09:00'), pg_temp.at(8, '10:00'));

-- Lab requests: five that count (active, on hold, completed), three that do not.
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, created_at, updated_at)
select ('f203b000-0000-4000-8000-' || lpad(request.n::text, 12, '0'))::uuid, 'f203a000-0000-4000-8000-000000000001',
       'f2037000-0000-4000-8000-000000000002', request.facility::uuid, 'f2032000-0000-4000-8000-0000000000d0',
       'f2035000-0000-4000-8000-0000000000d1', 'http://loinc.org', '718-7', 'Synthetic haemoglobin', 'routine',
       request.status, pg_temp.at(request.back, '10:00'), pg_temp.at(request.back, '10:00')
  from (values
    (1, 'f2031000-0000-4000-8000-0000000000f1', 'active', 8), (2, 'f2031000-0000-4000-8000-0000000000f1', 'active', 8),
    (3, 'f2031000-0000-4000-8000-0000000000f1', 'active', 5), (4, 'f2031000-0000-4000-8000-0000000000f1', 'on_hold', 5),
    (5, 'f2031000-0000-4000-8000-0000000000f1', 'completed', 4), (6, 'f2031000-0000-4000-8000-0000000000f1', 'draft', 4),
    (7, 'f2031000-0000-4000-8000-0000000000f1', 'cancelled', 4),
    (8, 'f2031000-0000-4000-8000-0000000000f1', 'entered_in_error', 4),
    (9, 'f2031000-0000-4000-8000-0000000000f1', 'active', 12), (10, 'f2031000-0000-4000-8000-0000000000f2', 'active', 5)
  ) request(n, facility, status, back);

-- Samples (A, C, D and the required and cancelled ones in the range; B in the previous period; one at F2), their
-- test runs, and the result releases: A released twice (counted once, on its first release), B first released in
-- the previous period and again in the range (not counted in the range), C once.
insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
  collected_at, collected_by, received_at, received_by, rejected_at, rejected_by, rejection_reason)
select ('f203c000-0000-4000-8000-0000000000' || specimen.code)::uuid, gen_random_uuid(), gen_random_uuid(),
       'f2037000-0000-4000-8000-000000000003', specimen.facility::uuid, 'Blood', specimen.status,
       specimen.collected, case when specimen.collected is not null then 'f2032000-0000-4000-8000-0000000000a0'::uuid end,
       case when specimen.status = 'received' then specimen.collected + interval '1 hour' end,
       case when specimen.status = 'received' then 'f2032000-0000-4000-8000-0000000000a0'::uuid end,
       case when specimen.status = 'rejected' then specimen.collected + interval '1 hour' end,
       case when specimen.status = 'rejected' then 'f2032000-0000-4000-8000-0000000000a0'::uuid end,
       case when specimen.status = 'rejected' then 'Synthetic haemolysed' end
  from (values
    ('a1', 'f2031000-0000-4000-8000-0000000000f1', 'collected', pg_temp.at(8, '08:00')),
    ('b1', 'f2031000-0000-4000-8000-0000000000f1', 'received', pg_temp.at(13, '10:00')),
    ('c1', 'f2031000-0000-4000-8000-0000000000f1', 'received', pg_temp.at(5, '12:00')),
    ('d1', 'f2031000-0000-4000-8000-0000000000f1', 'rejected', pg_temp.at(6, '12:00')),
    ('e1', 'f2031000-0000-4000-8000-0000000000f1', 'required', null),
    ('f1', 'f2031000-0000-4000-8000-0000000000f1', 'cancelled', pg_temp.at(6, '13:00')),
    ('a2', 'f2031000-0000-4000-8000-0000000000f2', 'collected', pg_temp.at(6, '13:00'))
  ) specimen(code, facility, status, collected);
insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
  started_by, started_by_membership_id, started_at, idempotency_key, request_sha256, correlation_id)
select ('f203d000-0000-4000-8000-0000000000' || execution.code)::uuid, gen_random_uuid(),
       ('f203c000-0000-4000-8000-0000000000' || execution.code)::uuid, gen_random_uuid(),
       'f2037000-0000-4000-8000-000000000003', execution.facility::uuid, 'in_progress',
       'f2032000-0000-4000-8000-0000000000a0', 'f2035000-0000-4000-8000-0000000000a1', now(),
       pg_temp.key('execution', execution.n), repeat('c', 64), 'rep0203-execution'
  from (values (1, 'a1', 'f2031000-0000-4000-8000-0000000000f1'), (2, 'b1', 'f2031000-0000-4000-8000-0000000000f1'),
               (3, 'c1', 'f2031000-0000-4000-8000-0000000000f1'), (4, 'a2', 'f2031000-0000-4000-8000-0000000000f2'))
         execution(n, code, facility);
insert into lab.result_releases (id, verification_id, result_id, execution_id, patient_id, facility_id, result_version,
  released_by, released_by_membership_id, released_at, reason, idempotency_key, request_sha256, correlation_id)
select gen_random_uuid(), gen_random_uuid(), ('f203e000-0000-4000-8000-0000000000' || release.result)::uuid,
       ('f203d000-0000-4000-8000-0000000000' || release.execution)::uuid, 'f2037000-0000-4000-8000-000000000003',
       release.facility::uuid, release.version, 'f2032000-0000-4000-8000-0000000000a0',
       'f2035000-0000-4000-8000-0000000000a1', release.released, 'Synthetic release', pg_temp.key('release', release.n),
       repeat('d', 64), 'rep0203-release'
  from (values
    (1, 'a1', 'a1', 'f2031000-0000-4000-8000-0000000000f1', 1, pg_temp.at(8, '10:00')),
    (2, 'a1', 'a1', 'f2031000-0000-4000-8000-0000000000f1', 2, pg_temp.at(6, '10:00')),
    (3, 'b1', 'b1', 'f2031000-0000-4000-8000-0000000000f1', 1, pg_temp.at(12, '10:30')),
    (4, 'b1', 'b1', 'f2031000-0000-4000-8000-0000000000f1', 2, pg_temp.at(5, '09:00')),
    (5, 'c1', 'c1', 'f2031000-0000-4000-8000-0000000000f1', 1, pg_temp.at(4, '12:00')),
    (6, 'a2', 'a2', 'f2031000-0000-4000-8000-0000000000f2', 1, pg_temp.at(6, '15:00'))
  ) release(n, result, execution, facility, version, released);

-- Dispensings (each with the claim 0133's always-on trigger completes) and a reversal of d2.
insert into pharmacy.prescription_item_claims (work_item_id, prescription_id, facility_id)
select ('f203f000-0000-4000-8000-00000000000' || n)::uuid, gen_random_uuid(),
       case when n = 5 then 'f2031000-0000-4000-8000-0000000000f2' else 'f2031000-0000-4000-8000-0000000000f1' end::uuid
  from generate_series(1, 5) n;
insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id, medication_display,
  quantity_dispensed, quantity_unit, dispensed_by, dispensed_by_membership_id, dispensed_at, reason, idempotency_key,
  request_sha256, correlation_id)
select ('f2030d00-0000-4000-8000-00000000000' || dispensing.n)::uuid,
       ('f203f000-0000-4000-8000-00000000000' || dispensing.n)::uuid, 1, 'f2037000-0000-4000-8000-000000000004',
       dispensing.facility::uuid, 'Synthetic amoxicillin', 10, 'capsule', 'f2032000-0000-4000-8000-0000000000a0',
       'f2035000-0000-4000-8000-0000000000a1', pg_temp.at(dispensing.back, '11:00'), 'Synthetic dispensing',
       pg_temp.key('dispensing', dispensing.n), repeat('e', 64), 'rep0203-dispensing'
  from (values (1, 'f2031000-0000-4000-8000-0000000000f1', 7), (2, 'f2031000-0000-4000-8000-0000000000f1', 7),
               (3, 'f2031000-0000-4000-8000-0000000000f1', 4), (4, 'f2031000-0000-4000-8000-0000000000f1', 11),
               (5, 'f2031000-0000-4000-8000-0000000000f2', 7)) dispensing(n, facility, back);
insert into pharmacy.dispensing_reversals (dispensing_id, dispensing_version, work_item_id, patient_id, facility_id,
  reversed_by, reversed_by_membership_id, reversed_at, reason, idempotency_key, request_sha256, correlation_id)
values ('f2030d00-0000-4000-8000-000000000002', 1, 'f203f000-0000-4000-8000-000000000002',
  'f2037000-0000-4000-8000-000000000004', 'f2031000-0000-4000-8000-0000000000f1', 'f2032000-0000-4000-8000-0000000000a0',
  'f2035000-0000-4000-8000-0000000000a1', pg_temp.at(6, '11:00'), 'Synthetic reversal', pg_temp.key('reversal', 1),
  repeat('f', 64), 'rep0203-reversal');

-- Could not complete: prescriptions F1 received (two out of stock and one declined in the range, one out of stock
-- before it), a lab request it could not complete, and one F2 received.
insert into ehr.order_route_unable_endings (route_id, kind, receiving_facility_id, receiving_organization_id,
  ordering_facility_id, reason_code, ended_by_account_id, ended_by_membership_id, accepted_by_membership_id,
  accepted_at, ended_by_acceptor, minutes_after_acceptance, accession_made, specimens_collected, results_recorded,
  idempotency_key, request_sha256, correlation_id, recorded_at)
select gen_random_uuid(), ending.kind, ending.facility::uuid, 'f2030000-0000-4000-8000-0000000000a1',
       'f2031000-0000-4000-8000-0000000000f2', ending.reason, 'f2032000-0000-4000-8000-0000000000a0',
       'f2035000-0000-4000-8000-0000000000a1', 'f2035000-0000-4000-8000-0000000000a1', pg_temp.at(ending.back, '08:00'),
       true, 60, false, 0, 0, pg_temp.key('ending', ending.n), repeat('9', 64), 'rep0203-ending',
       pg_temp.at(ending.back, '09:00')
  from (values
    (1, 'prescription', 'f2031000-0000-4000-8000-0000000000f1', 'out_of_stock', 8),
    (2, 'prescription', 'f2031000-0000-4000-8000-0000000000f1', 'out_of_stock', 7),
    (3, 'prescription', 'f2031000-0000-4000-8000-0000000000f1', 'patient_declined', 5),
    (4, 'lab_request', 'f2031000-0000-4000-8000-0000000000f1', 'test_not_offered', 5),
    (5, 'prescription', 'f2031000-0000-4000-8000-0000000000f1', 'out_of_stock', 12),
    (6, 'prescription', 'f2031000-0000-4000-8000-0000000000f2', 'out_of_stock', 7)
  ) ending(n, kind, facility, reason, back);
set local session_replication_role = origin;

-- 1. Structure.
select pg_temp.expect('1 the two routes: SECURITY DEFINER, fixed search_path, EXECUTE for the EHR runtime only',
  'ehr.facility_report_operations(date,date,boolean) t {"search_path=pg_catalog, pg_temp"} hid_ehr_runtime|'
  || 'ehr.facility_report_operations_export(date,date,text,boolean) t {"search_path=pg_catalog, pg_temp"} hid_ehr_runtime',
  (select string_agg(format('%s %s %s %s', proc.oid::regprocedure, proc.prosecdef, proc.proconfig,
       (select string_agg(acl.grantee::regrole::text, ',' order by acl.grantee::regrole::text)
          from aclexplode(proc.proacl) acl where acl.grantee <> proc.proowner)), '|' order by proc.proname)
     from pg_proc proc
    where proc.oid in ('ehr.facility_report_operations(date,date,boolean)'::regprocedure,
                       'ehr.facility_report_operations_export(date,date,text,boolean)'::regprocedure)));
select pg_temp.expect('1 the helper and the stamp: invoker, fixed search_path, no role may execute them',
  'ehr.facility_report_operations_figures(uuid,date,date,boolean) f {"search_path=pg_catalog, pg_temp"} -|'
  || 'ehr.visit_queue_report_stamp() f {"search_path=pg_catalog, pg_temp"} -',
  (select string_agg(format('%s %s %s %s', proc.oid::regprocedure, proc.prosecdef, proc.proconfig,
       coalesce((select string_agg(acl.grantee::text, ',') from aclexplode(proc.proacl) acl
                  where acl.grantee <> proc.proowner), '-')), '|' order by proc.proname)
     from pg_proc proc
    where proc.oid in ('ehr.facility_report_operations_figures(uuid,date,date,boolean)'::regprocedure,
                       'ehr.visit_queue_report_stamp()'::regprocedure)));
select pg_temp.expect('1 the marker: forced row-level security, no grant; its check EXECUTE to PUBLIC',
  't t - | PUBLIC',
  (select format('%s %s %s', relrowsecurity, relforcerowsecurity,
     coalesce((select string_agg(acl.grantee::text, ',') from aclexplode(relacl) acl where acl.grantee <> relowner), '-'))
     from pg_class where oid = 'ehr.report_scans'::regclass)
  || ' | ' || (select string_agg(case when acl.grantee = 0 then 'PUBLIC' else acl.grantee::regrole::text end, ',')
                 from pg_proc proc, aclexplode(proc.proacl) acl
                where proc.oid = 'ehr.report_scan_open()'::regprocedure and acl.grantee <> proc.proowner));
select pg_temp.expect('1 the eight marker policies', 'ehr.encounters encounters_scan_reports|'
  || 'ehr.lab_requests lab_requests_scan_reports|identity.registration_cases registration_cases_scan_reports|'
  || 'lab.result_releases result_releases_scan_reports|lab.specimens specimens_scan_reports|'
  || 'lab.test_executions test_executions_scan_reports|pharmacy.dispensing_reversals pharmacy_reversals_scan_reports|'
  || 'pharmacy.dispensings pharmacy_dispensings_scan_reports',
  (select string_agg(polrelid::regclass || ' ' || polname, '|' order by polrelid::regclass::text)
     from pg_policy where polname like '%\_scan\_reports'));
select pg_temp.expect('1 the two codes, each held by admin and org_admin only',
  'reports.export:admin,org_admin|reports.read:admin,org_admin,rep0203_reader',
  (select string_agg(permission_code || ':' || roles, '|' order by permission_code)
     from (select permission_code, string_agg(role_code, ',' order by role_code) as roles from auth.role_permissions
            where permission_code in ('reports.read', 'reports.export') group by permission_code) grouped));

-- 2. Every figure, as A (admin at F1) reads them: the range is the Lagos days 9 to 3 days ago, the previous period
-- 16 to 10 days ago.
select pg_temp.as_staff('synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a1',
  'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations', 'reports-0203-read-1');
set local role hid_ehr_api_runtime;
select pg_temp.report(9, 3)::text as r1 \gset
reset role;
select pg_temp.expect('2 the answer''s head', format('operations|f2031000-0000-4000-8000-0000000000f1|%s|%s|7|%s|%s|false|'
    || 'Africa/Lagos|rep1-draft-1|false|waitingList,registrations,visits,lab,pharmacy', pg_temp.d(9), pg_temp.d(3),
    pg_temp.d(16), pg_temp.d(10)),
  (select concat_ws('|', r ->> 'report', r ->> 'facilityId', r ->> 'from', r ->> 'to', r ->> 'days',
     r ->> 'previousFrom', r ->> 'previousTo', r ->> 'includesToday', r ->> 'timeZone',
     r #>> '{definitions,version}', r #>> '{definitions,signedOff}',
     (select string_agg(section_row ->> 'key', ',' order by position)
        from jsonb_array_elements(r -> 'sections') with ordinality sections(section_row, position)))
     from (select :'r1'::jsonb as r) answer));
select pg_temp.expect('2 every figure, in order', 'waitingList:checkedIn,seen,leftWithoutBeingSeen,cancelled,medianWaitMinutes|'
  || 'registrations:newHealthIds,existingHealthIds|visits:opened,completed|'
  || 'lab:requested,specimensCollected,resultsReleased,medianTurnaroundMinutes|'
  || 'pharmacy:dispensed,dispensingsReversed,notCompleted',
  (select string_agg(section_row ->> 'key' || ':' || (select string_agg(figure_row ->> 'key', ',' order by figure_position)
       from jsonb_array_elements(section_row -> 'figures') with ordinality figures(figure_row, figure_position)),
       '|' order by position)
     from jsonb_array_elements((:'r1'::jsonb) -> 'sections') with ordinality sections(section_row, position)));
select pg_temp.expect('2 generatedAt is an ISO instant in UTC', 'true',
  ((:'r1'::jsonb ->> 'generatedAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')::text);
select pg_temp.expect('2 the answer holds no patient: no patient id, name or Health ID', 'false',
  (:'r1' ~ 'f2037000|Report Patient|HID-RPQ|Case Person')::text);
select pg_temp.expect('2 checked in: every check-in, by Lagos day (the 23:30 UTC one on the next day)',
  '8|2|7,0,0,0,0,0,1', pg_temp.line(:'r1'::jsonb, 'checkedIn'));
select pg_temp.expect('2 seen: tracked, reached the clinician or finished', '4|1|3,0,0,0,0,0,1',
  pg_temp.line(:'r1'::jsonb, 'seen'));
select pg_temp.expect('2 left without being seen: tracked only (the untracked one left is not counted)',
  '1|0|1,0,0,0,0,0,0', pg_temp.line(:'r1'::jsonb, 'leftWithoutBeingSeen'));
select pg_temp.expect('2 cancelled', '1|0|1,0,0,0,0,0,0', pg_temp.line(:'r1'::jsonb, 'cancelled'));
select pg_temp.expect('2 median wait: 30, 10 and 5 minutes; 40 before; by day', '10/3|40/1|20/2,-/0,-/0,-/0,-/0,-/0,5/1',
  pg_temp.line(:'r1'::jsonb, 'medianWaitMinutes'));
select pg_temp.expect('2 coverage on the three tracked figures, and only there',
  '{"tracked": 7, "previousTracked": 1}|{"tracked": 7, "previousTracked": 1}|{"tracked": 7, "previousTracked": 1}|0',
  (select concat_ws('|', pg_temp.figure(r, 'seen') -> 'coverage', pg_temp.figure(r, 'leftWithoutBeingSeen') -> 'coverage',
     pg_temp.figure(r, 'medianWaitMinutes') -> 'coverage',
     (select count(*) from jsonb_array_elements(r -> 'sections') section_row,
             jsonb_array_elements(section_row -> 'figures') figure_row
       where figure_row ? 'coverage'
         and figure_row ->> 'key' not in ('seen', 'leftWithoutBeingSeen', 'medianWaitMinutes')))
     from (select :'r1'::jsonb as r) answer));
select pg_temp.expect('2 new Health IDs: approved new identity (the 00:30 Lagos one counted, the one after the range not)',
  '2|1|1,0,0,1,0,0,0', pg_temp.line(:'r1'::jsonb, 'newHealthIds'));
select pg_temp.expect('2 existing Health IDs: resolved or linked', '2|0|0,2,0,0,0,0,0',
  pg_temp.line(:'r1'::jsonb, 'existingHealthIds'));
select pg_temp.expect('2 visits opened: not cancelled, entered in error or imported from paper', '2|1|0,2,0,0,0,0,0',
  pg_temp.line(:'r1'::jsonb, 'opened'));
select pg_temp.expect('2 visits completed: by the day they ended, not imported from paper', '2|0|1,0,1,0,0,0,0',
  pg_temp.line(:'r1'::jsonb, 'completed'));
select pg_temp.expect('2 lab tests requested: active, on hold or completed', '5|1|0,2,0,0,2,1,0',
  pg_temp.line(:'r1'::jsonb, 'requested'));
select pg_temp.expect('2 samples collected: collected, received or rejected', '3|1|0,1,0,1,1,0,0',
  pg_temp.line(:'r1'::jsonb, 'specimensCollected'));
select pg_temp.expect('2 results released: each once, on its first release', '2|1|0,1,0,0,0,1,0',
  pg_temp.line(:'r1'::jsonb, 'resultsReleased'));
select pg_temp.expect('2 median time from sample to result: 120 and 1440 minutes; 1470 before',
  '780/2|1470/1|-/0,120/1,-/0,-/0,-/0,1440/1,-/0', pg_temp.line(:'r1'::jsonb, 'medianTurnaroundMinutes'));
select pg_temp.expect('2 dispensed: not reversed', '2|1|0,0,1,0,0,1,0', pg_temp.line(:'r1'::jsonb, 'dispensed'));
select pg_temp.expect('2 dispensings reversed', '1|0|0,0,0,1,0,0,0', pg_temp.line(:'r1'::jsonb, 'dispensingsReversed'));
select pg_temp.expect('2 could not complete: prescriptions this facility received', '3|1|0,1,1,0,1,0,0',
  pg_temp.line(:'r1'::jsonb, 'notCompleted'));
select pg_temp.expect('2 the eight reasons, in order',
  'out_of_stock 2/1,medicine_unavailable 0/0,needs_prescriber_review 0/0,controlled_requirements 0/0,'
  || 'cannot_meet_priority 0/0,patient_declined 1/0,patient_did_not_return 0/0,other 0/0',
  (select string_agg(format('%s %s/%s', reason_row ->> 'reason', reason_row ->> 'current', reason_row ->> 'previous'),
                     ',' order by position)
     from jsonb_array_elements(pg_temp.figure(:'r1'::jsonb, 'notCompleted') -> 'byReason')
          with ordinality reasons(reason_row, position)));
select pg_temp.expect('2 the daily days, oldest first', format('%s,%s', pg_temp.d(9), pg_temp.d(3)),
  (select string_agg(entry ->> 'day', ',' order by position)
     from jsonb_array_elements(pg_temp.figure(:'r1'::jsonb, 'checkedIn') -> 'daily') with ordinality daily(entry, position)
    where position in (1, 7)));

-- 3. The download of the same range (counts from 1 to 4 hidden).
select pg_temp.as_staff('synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a1',
  'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations', 'reports-0203-export-1');
set local role hid_ehr_api_runtime;
select pg_temp.download(9, 3, 'pdf')::text as x1 \gset
reset role;
select pg_temp.expect('3 the download carries the same head and the export record',
  format('%s|%s|7|pdf|5|true', pg_temp.d(9), pg_temp.d(3)),
  (select concat_ws('|', r ->> 'from', r ->> 'to', r ->> 'days', r #>> '{export,format}', r #>> '{export,minimumCount}',
     ((r #>> '{export,recordedAt}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')::text)
     from (select :'x1'::jsonb as r) answer));
select pg_temp.expect('3 checked in: 8 shown, 2 and 1 hidden, 0 and 7 shown', '8|*|7,0,0,0,0,0,*',
  pg_temp.line(:'x1'::jsonb, 'checkedIn'));
select pg_temp.expect('3 seen: every count from 1 to 4 hidden', '*|*|*,0,0,0,0,0,*', pg_temp.line(:'x1'::jsonb, 'seen'));
select pg_temp.expect('3 median wait: samples of 3, 1, 2 and 1 hide the median and its size', '*|*|*,-/0,-/0,-/0,-/0,-/0,*',
  pg_temp.line(:'x1'::jsonb, 'medianWaitMinutes'));
select pg_temp.expect('3 a hidden median says so beside each field',
  '{"current": null, "sampleSize": null, "currentSuppressed": true, "sampleSizeSuppressed": true}',
  (select jsonb_build_object('current', f -> 'current', 'currentSuppressed', f -> 'currentSuppressed',
     'sampleSize', f -> 'sampleSize', 'sampleSizeSuppressed', f -> 'sampleSizeSuppressed')::text
     from (select pg_temp.figure(:'x1'::jsonb, 'medianWaitMinutes') as f) figure));
select pg_temp.expect('3 coverage: 7 shown, 1 hidden', '{"tracked": 7, "previousTracked": null, "previousTrackedSuppressed": true}',
  (pg_temp.figure(:'x1'::jsonb, 'seen') -> 'coverage')::text);
select pg_temp.expect('3 lab tests requested: 5 shown', '5|*|0,*,0,0,*,*,0', pg_temp.line(:'x1'::jsonb, 'requested'));
select pg_temp.expect('3 a hidden daily value: null with suppressed true',
  format('{"day": "%s", "value": null, "suppressed": true}', pg_temp.d(8)),
  ((pg_temp.figure(:'x1'::jsonb, 'requested') -> 'daily') -> 1)::text);
select pg_temp.expect('3 the reasons: 1 to 4 hidden, 0 shown',
  '{"reason": "out_of_stock", "current": null, "previous": null, "currentSuppressed": true, "previousSuppressed": true}|'
  || '{"reason": "medicine_unavailable", "current": 0, "previous": 0}',
  (select string_agg(reason_row::text, '|' order by position)
     from jsonb_array_elements(pg_temp.figure(:'x1'::jsonb, 'notCompleted') -> 'byReason')
          with ordinality reasons(reason_row, position) where position <= 2));
select pg_temp.expect('3 no number from 1 to 4 is left anywhere in the download', 'false',
  jsonb_path_exists(:'x1'::jsonb - 'export', 'strict $.** ? (@.type() == "number" && @ >= 1 && @ <= 4)')::text);
select pg_temp.expect('3 suppressedValues is the number of hidden values (a hidden daily median hides two)', 'true',
  ((:'x1'::jsonb #>> '{export,suppressedValues}')::integer
   = (select count(*) from jsonb_path_query(:'x1'::jsonb, 'strict $.** ? (@.type() == "object")') object_row,
             jsonb_each(object_row) field
       where field.key like '%Suppressed' and field.value = 'true'::jsonb)
     + (select count(*) from jsonb_path_query(:'x1'::jsonb, 'strict $.** ? (@.type() == "object")') object_row
         where object_row ->> 'suppressed' = 'true')
     + (select count(*) from jsonb_path_query(:'x1'::jsonb, 'strict $.** ? (@.type() == "object")') object_row
         where object_row ->> 'suppressed' = 'true' and object_row ? 'sampleSize'))::text);
select pg_temp.expect('3 and it is not 0 here', 'true', ((:'x1'::jsonb #>> '{export,suppressedValues}')::integer > 20)::text);

-- 4. The range.
select pg_temp.as_staff('synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a1',
  'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations', 'reports-0203-range');
-- A check-in today, so today counts so far.
select pg_temp.check_in('f2038000-0000-4000-8000-000000000014', 'f2031000-0000-4000-8000-0000000000f1', 14,
  clock_timestamp() - interval '1 second', 'waiting', clock_timestamp() - interval '1 second');
set local role hid_ehr_api_runtime;
select pg_temp.report(91, 0)::text as r92 \gset
select pg_temp.report(0, 0)::text as rtoday \gset
select pg_temp.report(92, 0)::text as r93 \gset
select pg_temp.report(3, 4)::text as rbackwards \gset
select pg_temp.report(0, -1)::text as rfuture \gset
select (ehr.facility_report_operations(((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '2 years')::date,
   ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '2 years')::date + 6, true) ->> 'days') as rtwoyears \gset
select pg_temp.report(800, 790)::text as rtooold \gset
select pg_temp.download(9, 3, 'xlsx')::text as xformat \gset
reset role;
select pg_temp.expect('4 92 days, both included, ending today: accepted, today counting so far',
  format('92|%s|%s|true|%s', pg_temp.d(91), pg_temp.d(0), pg_temp.d(183)),
  (select concat_ws('|', r ->> 'days', r ->> 'from', r ->> 'to', r ->> 'includesToday', r ->> 'previousFrom')
     from (select :'r92'::jsonb as r) answer));
select pg_temp.expect('4 today alone: the check-in made a second ago', '1|0|1|true',
  (select concat_ws('|', pg_temp.line(r, 'checkedIn'), r ->> 'includesToday') from (select :'rtoday'::jsonb as r) answer));
select pg_temp.expect('4 93 days: refused', '22023 REPORT_RANGE_TOO_LONG', :'r93'::jsonb ->> 'error');
select pg_temp.expect('4 from after to: refused', '22023 REPORT_RANGE_INVALID', :'rbackwards'::jsonb ->> 'error');
select pg_temp.expect('4 to tomorrow: refused', '22023 REPORT_RANGE_INVALID', :'rfuture'::jsonb ->> 'error');
select pg_temp.expect('4 from exactly 2 years back: accepted', '7', :'rtwoyears');
select pg_temp.expect('4 from more than 2 years back: refused', '22023 REPORT_RANGE_INVALID', :'rtooold'::jsonb ->> 'error');
select pg_temp.expect('4 a format other than csv or pdf: refused', '22023 REPORT_FORMAT_INVALID', :'xformat'::jsonb ->> 'error');

-- 5. The caller and the switch.
create temporary table caller_answers (label text primary key, answer text);
grant insert, select on pg_temp.caller_answers to hid_ehr_api_runtime;
create function pg_temp.try(label text, subject text, membership text, facility text, purpose text,
  download boolean default false, switched_on boolean default true) returns void language plpgsql as $f$
declare
  outcome jsonb;
begin
  perform pg_temp.as_staff(subject, membership, facility, purpose, 'reports-0203-' || label);
  execute 'set local role hid_ehr_api_runtime';
  outcome := case when download then pg_temp.download(9, 3, 'csv', switched_on)
                  else pg_temp.report(9, 3, switched_on) end;
  insert into pg_temp.caller_answers values (label, coalesce(outcome ->> 'error',
    'answered ' || coalesce(pg_temp.line(outcome, 'checkedIn'), '-')));
  execute 'reset role';
end
$f$;
select pg_temp.try('doctor', 'synthetic:reports-0203:d0', 'f2035000-0000-4000-8000-0000000000d1', 'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations');
select pg_temp.try('doctor-download', 'synthetic:reports-0203:d0', 'f2035000-0000-4000-8000-0000000000d1', 'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations', true);
select pg_temp.try('reader', 'synthetic:reports-0203:b0', 'f2035000-0000-4000-8000-0000000000b1', 'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations');
select pg_temp.try('reader-download', 'synthetic:reports-0203:b0', 'f2035000-0000-4000-8000-0000000000b1', 'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations', true);
select pg_temp.try('direct-care', 'synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a1', 'f2031000-0000-4000-8000-0000000000f1', 'direct-care');
select pg_temp.try('direct-care-download', 'synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a1', 'f2031000-0000-4000-8000-0000000000f1', 'direct-care', true);
select pg_temp.try('held', 'synthetic:reports-0203:c0', 'f2035000-0000-4000-8000-0000000000c1', 'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations');
select pg_temp.try('inactive', 'synthetic:reports-0203:e0', 'f2035000-0000-4000-8000-0000000000e1', 'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations');
select pg_temp.try('another-facility-membership', 'synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a2', 'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations');
select pg_temp.try('no-session', null, null, null, null);
select pg_temp.try('switch-off', 'synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a1', 'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations', false, false);
select pg_temp.try('switch-off-download', 'synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a1', 'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations', true, false);
select pg_temp.try('switch-off-before-the-caller', 'synthetic:reports-0203:d0', 'f2035000-0000-4000-8000-0000000000d1', 'f2031000-0000-4000-8000-0000000000f1', 'healthcare-operations', false, false);
select pg_temp.try('sealed-demo', 'synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a3', 'f2031000-0000-4000-8000-0000000000f3', 'healthcare-operations', false, false);
select pg_temp.try('sealed-demo-download', 'synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a3', 'f2031000-0000-4000-8000-0000000000f3', 'healthcare-operations', true, false);
select pg_temp.try('sealed-qa', 'synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a4', 'f2031000-0000-4000-8000-0000000000f4', 'healthcare-operations', false, false);
select pg_temp.try('other-facility', 'synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a2', 'f2031000-0000-4000-8000-0000000000f2', 'healthcare-operations');
select pg_temp.expect('5 the caller and the switch',
  'another-facility-membership: 42501 REPORTS_NOT_PERMITTED|direct-care: 22023 REPORTS_OPERATIONS_PURPOSE_ONLY|'
  || 'direct-care-download: 22023 REPORTS_OPERATIONS_PURPOSE_ONLY|doctor: 42501 REPORTS_NOT_PERMITTED|'
  || 'doctor-download: 42501 REPORTS_NOT_PERMITTED|held: 42501 REPORTS_NOT_PERMITTED|'
  || 'inactive: 42501 REPORTS_NOT_PERMITTED|no-session: 42501 REPORTS_NOT_PERMITTED|'
  || 'other-facility: answered 1|0|0,0,0,0,1,0,0|reader: answered 8|2|7,0,0,0,0,0,1|'
  || 'reader-download: 42501 REPORTS_EXPORT_NOT_PERMITTED|sealed-demo: answered 1|0|0,0,0,0,1,0,0|'
  || 'sealed-demo-download: answered *|0|0,0,0,0,*,0,0|sealed-qa: answered 1|0|0,0,0,0,1,0,0|'
  || 'switch-off: 55000 REPORTS_SWITCHED_OFF|switch-off-before-the-caller: 42501 REPORTS_NOT_PERMITTED|'
  || 'switch-off-download: 55000 REPORTS_EXPORT_SWITCHED_OFF',
  (select string_agg(label || ': ' || answer, '|' order by label collate "C") from pg_temp.caller_answers));

-- 6. Audit: exactly one row for each call that answered, none for a refusal; no patient, no figure's value.
select pg_temp.expect('6 route 1: one row, the details its header names',
  format('1|ehr.reports.operations.read|success|facility-report|operations|null|f2031000-0000-4000-8000-0000000000f1|'
    || 'f2035000-0000-4000-8000-0000000000a1|healthcare-operations|{"to": "%s", "days": 7, "from": "%s", "figures": 16, '
    || '"includesToday": false}', pg_temp.d(3), pg_temp.d(9)),
  (select concat_ws('|', count(*), max(action), max(outcome), max(resource_type), max(resource_id),
     coalesce(max(patient_id::text), 'null'), max(facility_id::text), max(actor_membership_id::text), max(purpose_of_use),
     max(details::text))
     from audit.events where correlation_id = 'reports-0203-read-1'));
select pg_temp.expect('6 route 2: one row, range, format and counts only',
  format('1|ehr.reports.operations.exported|null|days,figures,format,from,minimumCount,suppressedValues,to,values|pdf|5|%s',
    :'x1'::jsonb #>> '{export,suppressedValues}'),
  (select concat_ws('|', count(*), max(action), coalesce(max(patient_id::text), 'null'),
     (select string_agg(key, ',' order by key) from jsonb_object_keys(max(details::text)::jsonb) key),
     max(details ->> 'format'), max(details ->> 'minimumCount'), max(details ->> 'suppressedValues'))
     from audit.events where correlation_id = 'reports-0203-export-1'));
select pg_temp.expect('6 the export record''s time is the audit row''s', 'true',
  ((select to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from audit.events
     where correlation_id = 'reports-0203-export-1') = :'x1'::jsonb #>> '{export,recordedAt}')::text);
select pg_temp.expect('6 refusals write no row; the reader, sealed and other-facility calls one each',
  'other-facility:1|reader:1|sealed-demo:1|sealed-demo-download:1|sealed-qa:1',
  (select string_agg(replace(correlation_id, 'reports-0203-', '') || ':' || n, '|' order by correlation_id collate "C")
     from (select correlation_id, count(*) as n from audit.events
            where correlation_id like 'reports-0203-%' and correlation_id not in ('reports-0203-read-1',
                    'reports-0203-export-1', 'reports-0203-range')
              and action like 'ehr.reports.%' group by correlation_id) counted));
select pg_temp.expect('6 no report row names a patient', '0',
  (select count(*)::text from audit.events where action like 'ehr.reports.%' and patient_id is not null));

-- 7. The marker.
select pg_temp.expect('7 no marker left after the calls and the refusals', '0',
  (select count(*)::text from ehr.report_scans));
-- As the tables' owner (not a superuser: row-level security applies to it).
select pg_get_userbyid(relowner) as table_owner from pg_class where oid = 'lab.specimens'::regclass \gset
set local role :"table_owner";
select pg_temp.expect('7 the owner, after a report in this transaction, reads no sample, encounter or dispensing', '0/0/0',
  (select count(*) from lab.specimens where facility_id = 'f2031000-0000-4000-8000-0000000000f1') || '/'
  || (select count(*) from ehr.lab_requests where facility_id = 'f2031000-0000-4000-8000-0000000000f1') || '/'
  || (select count(*) from pharmacy.dispensings where facility_id = 'f2031000-0000-4000-8000-0000000000f1'));
insert into ehr.report_scans (backend_pid, transaction_started_at) values (pg_backend_pid() + 1, transaction_timestamp());
select pg_temp.expect('7 another backend''s marker opens nothing', '0',
  (select count(*)::text from lab.specimens where facility_id = 'f2031000-0000-4000-8000-0000000000f1'));
insert into ehr.report_scans (backend_pid, transaction_started_at) values (pg_backend_pid(), transaction_timestamp());
select pg_temp.expect('7 with this transaction''s marker the owner reads them (the counting helper''s view)',
  '6/9/4/1/8/6/5',
  (select count(*) from lab.specimens where facility_id = 'f2031000-0000-4000-8000-0000000000f1') || '/'
  || (select count(*) from ehr.lab_requests where facility_id = 'f2031000-0000-4000-8000-0000000000f1') || '/'
  || (select count(*) from pharmacy.dispensings where facility_id = 'f2031000-0000-4000-8000-0000000000f1') || '/'
  || (select count(*) from pharmacy.dispensing_reversals where facility_id = 'f2031000-0000-4000-8000-0000000000f1') || '/'
  || (select count(*) from identity.registration_cases where facility_id = 'f2031000-0000-4000-8000-0000000000f1') || '/'
  || (select count(*) from ehr.encounters where facility_id = 'f2031000-0000-4000-8000-0000000000f1') || '/'
  || (select count(*) from lab.result_releases where facility_id = 'f2031000-0000-4000-8000-0000000000f1'));
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.expect('7 a runtime role''s own reads are unchanged by a marker (no grant there, no consent here)',
  '0/0', (select count(*) from ehr.encounters where facility_id = 'f2031000-0000-4000-8000-0000000000f1') || '/'
  || (select count(*) from ehr.lab_requests where facility_id = 'f2031000-0000-4000-8000-0000000000f1'));
reset role;
delete from ehr.report_scans;
set local role hid_ehr_api_runtime;
select pg_temp.expect('7 ... and the same without it', '0/0',
  (select count(*) from ehr.encounters where facility_id = 'f2031000-0000-4000-8000-0000000000f1') || '/'
  || (select count(*) from ehr.lab_requests where facility_id = 'f2031000-0000-4000-8000-0000000000f1'));
select pg_temp.expect('7 the runtime cannot write a marker', '42501',
  (select pg_temp.marker_attempt()));
reset role;

-- 8. The waiting list's stamp: 0135's own update, as the nurse N (direct care).
select pg_temp.check_in('f2038000-0000-4000-8000-000000000020', 'f2031000-0000-4000-8000-0000000000f1', 20,
  clock_timestamp() - interval '20 minutes', 'waiting', clock_timestamp() - interval '20 minutes');
select pg_temp.as_staff('synthetic:reports-0203:90', 'f2035000-0000-4000-8000-000000000091',
  'f2031000-0000-4000-8000-0000000000f1', 'direct-care', 'reports-0203-stamp');
set local role hid_ehr_api_runtime;
select outcome as moved from ehr.visit_queue_update('f2038000-0000-4000-8000-000000000020', 1, 'with_clinician', null,
  false, null, false) \gset
reset role;
select pg_temp.expect('8 the first move to with_clinician through 0135''s update: stamped with its stage time',
  'updated|true|true', (select concat_ws('|', :'moved', wait_tracked::text,
     (first_with_clinician_at = stage_changed_at and first_with_clinician_at > checked_in_at)::text)
     from ehr.visit_queue where id = 'f2038000-0000-4000-8000-000000000020'));
select first_with_clinician_at::text as stamp20 from ehr.visit_queue where id = 'f2038000-0000-4000-8000-000000000020' \gset
set local role hid_ehr_api_runtime;
select outcome as moved_back from ehr.visit_queue_update('f2038000-0000-4000-8000-000000000020', 2, 'ready', null,
  false, null, false) \gset
select outcome as moved_again from ehr.visit_queue_update('f2038000-0000-4000-8000-000000000020', 3, 'with_clinician',
  null, false, null, false) \gset
reset role;
select pg_temp.expect('8 later moves away and back leave the stamp as it was', 'updated|updated|true',
  (select concat_ws('|', :'moved_back', :'moved_again', (first_with_clinician_at = :'stamp20'::timestamptz)::text)
     from ehr.visit_queue where id = 'f2038000-0000-4000-8000-000000000020'));
set local role :"table_owner";
update ehr.visit_queue set first_with_clinician_at = checked_in_at + interval '1 minute', wait_tracked = false
 where id = 'f2038000-0000-4000-8000-000000000020';
update ehr.visit_queue set first_with_clinician_at = pg_temp.at(9, '09:01'), wait_tracked = true
 where id = 'f2038000-0000-4000-8000-000000000005';
reset role;
select pg_temp.expect('8 a direct update as the owner changes neither column, on a tracked or an untracked row',
  'true|true|null|null',
  (select concat_ws('|', (first_with_clinician_at = :'stamp20'::timestamptz)::text, wait_tracked::text)
     from ehr.visit_queue where id = 'f2038000-0000-4000-8000-000000000020')
  || '|' || (select concat_ws('|', coalesce(first_with_clinician_at::text, 'null'), coalesce(wait_tracked::text, 'null'))
     from ehr.visit_queue where id = 'f2038000-0000-4000-8000-000000000005'));
select pg_temp.move('f2038000-0000-4000-8000-000000000010', 'with_clinician', pg_temp.at(12, '09:30'));
select pg_temp.expect('8 an untracked row reaching the clinician stays untracked', 'null|null',
  (select concat_ws('|', coalesce(first_with_clinician_at::text, 'null'), coalesce(wait_tracked::text, 'null'))
     from ehr.visit_queue where id = 'f2038000-0000-4000-8000-000000000010'));
insert into ehr.visit_queue (id, facility_id, patient_id, queue_day, stage, check_in_basis, checked_in_by_account_id,
  checked_in_by_membership_id, checked_in_at, stage_changed_at, updated_by_membership_id, first_with_clinician_at,
  wait_tracked)
values ('f2038000-0000-4000-8000-000000000021', 'f2031000-0000-4000-8000-0000000000f1',
  'f2037000-0000-4000-8000-000000000021', (clock_timestamp() at time zone 'Africa/Lagos')::date, 'with_clinician',
  'search', 'f2032000-0000-4000-8000-0000000000a0', 'f2035000-0000-4000-8000-0000000000a1', clock_timestamp(),
  clock_timestamp() - interval '1 hour', 'f2035000-0000-4000-8000-0000000000a1', clock_timestamp() - interval '2 hours',
  false);
select pg_temp.expect('8 an insert at with_clinician: tracked, stamped, never before the check-in (what the writer sent '
  || 'for the two columns is not kept)', 'true|true',
  (select concat_ws('|', wait_tracked::text, (first_with_clinician_at = checked_in_at)::text)
     from ehr.visit_queue where id = 'f2038000-0000-4000-8000-000000000021'));
savepoint stamp_check;
set local session_replication_role = replica;
select pg_temp.expect('8 the CHECK: a stamp without wait_tracked is refused even with the trigger off', '23514',
  (select pg_temp.unstamped_insert()));
rollback to savepoint stamp_check;
select pg_temp.expect('8 the trigger''s definition', 'visit_queue_report_stamp 23 O 0 ',
  (select format('%s %s %s %s %s', tgname, tgtype, tgenabled, tgnargs, coalesce(pg_get_expr(tgqual, tgrelid), ''))
     from pg_trigger where tgrelid = 'ehr.visit_queue'::regclass and tgname = 'visit_queue_report_stamp'));

-- 9. The cost: F9 with 92 days of fictional work. Written with triggers off (tracked rows carry their stamp, as the
-- trigger would have written it).
set local session_replication_role = replica;
insert into ehr.visit_queue (facility_id, patient_id, queue_day, stage, check_in_basis, checked_in_by_account_id,
  checked_in_by_membership_id, checked_in_at, stage_changed_at, closed_at, updated_by_membership_id, updated_at,
  first_with_clinician_at, wait_tracked)
select 'f2031000-0000-4000-8000-0000000000f9', gen_random_uuid(), (checked_in at time zone 'Africa/Lagos')::date,
       'finished', 'search', 'f2032000-0000-4000-8000-0000000000a0', 'f2035000-0000-4000-8000-0000000000a9',
       checked_in, checked_in + interval '50 minutes', checked_in + interval '50 minutes',
       'f2035000-0000-4000-8000-0000000000a9', checked_in + interval '50 minutes', checked_in + (n % 60) * interval '1 minute',
       true
  from (select n, pg_temp.at(n % 92, '08:00') + (n % 600) * interval '1 minute' as checked_in
          from generate_series(1, 50000) n) fixture;
insert into ehr.encounters (patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, ended_at)
select gen_random_uuid(), 'f2031000-0000-4000-8000-0000000000f9', 'f2032000-0000-4000-8000-0000000000d0',
       'f2035000-0000-4000-8000-0000000000d1', 'ambulatory', case when n % 10 = 0 then 'in_progress' else 'completed' end,
       started, case when n % 10 = 0 then null else started + interval '40 minutes' end
  from (select n, pg_temp.at(n % 92, '08:00') + (n % 600) * interval '1 minute' as started
          from generate_series(1, 50000) n) fixture;
insert into ehr.lab_requests (encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, created_at, updated_at)
select gen_random_uuid(), gen_random_uuid(), 'f2031000-0000-4000-8000-0000000000f9', 'f2032000-0000-4000-8000-0000000000d0',
       'f2035000-0000-4000-8000-0000000000d1', 'http://loinc.org', '718-7', 'Synthetic haemoglobin', 'routine',
       'completed', created, created
  from (select pg_temp.at(n % 92, '09:00') + (n % 500) * interval '1 minute' as created
          from generate_series(1, 20000) n) fixture;
insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
  collected_at, collected_by)
select ('f203c900-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, gen_random_uuid(), gen_random_uuid(),
       gen_random_uuid(), 'f2031000-0000-4000-8000-0000000000f9', 'Blood', 'collected',
       pg_temp.at(n % 92, '09:30') + (n % 500) * interval '1 minute', 'f2032000-0000-4000-8000-0000000000a0'
  from generate_series(1, 20000) n;
insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
  started_by, started_by_membership_id, started_at, idempotency_key, request_sha256, correlation_id)
select ('f203d900-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, gen_random_uuid(),
       ('f203c900-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, gen_random_uuid(), gen_random_uuid(),
       'f2031000-0000-4000-8000-0000000000f9', 'in_progress', 'f2032000-0000-4000-8000-0000000000a0',
       'f2035000-0000-4000-8000-0000000000a9', now(), pg_temp.key('busy-execution', n), repeat('c', 64),
       'rep0203-busy-execution'
  from generate_series(1, 20000) n;
insert into lab.result_releases (verification_id, result_id, execution_id, patient_id, facility_id, result_version,
  released_by, released_by_membership_id, released_at, reason, idempotency_key, request_sha256, correlation_id)
select gen_random_uuid(), gen_random_uuid(), ('f203d900-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       gen_random_uuid(), 'f2031000-0000-4000-8000-0000000000f9', 1, 'f2032000-0000-4000-8000-0000000000a0',
       'f2035000-0000-4000-8000-0000000000a9', pg_temp.at(n % 92, '12:00') + (n % 500) * interval '1 minute',
       'Synthetic release', pg_temp.key('busy-release', n), repeat('d', 64), 'rep0203-busy-release'
  from generate_series(1, 20000) n;
insert into pharmacy.prescription_item_claims (work_item_id, prescription_id, facility_id)
select ('f203f900-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, gen_random_uuid(),
       'f2031000-0000-4000-8000-0000000000f9'
  from generate_series(1, 20000) n;
-- The claim trigger's update reads the claims by key: give the planner their size first.
analyze pharmacy.prescription_item_claims;
insert into pharmacy.dispensings (work_item_id, work_item_version, patient_id, facility_id, medication_display,
  quantity_dispensed, quantity_unit, dispensed_by, dispensed_by_membership_id, dispensed_at, reason, idempotency_key,
  request_sha256, correlation_id)
select ('f203f900-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 1, gen_random_uuid(),
       'f2031000-0000-4000-8000-0000000000f9', 'Synthetic amoxicillin', 10, 'capsule',
       'f2032000-0000-4000-8000-0000000000a0', 'f2035000-0000-4000-8000-0000000000a9',
       pg_temp.at(n % 92, '13:00') + (n % 400) * interval '1 minute', 'Synthetic dispensing',
       pg_temp.key('busy-dispensing', n), repeat('e', 64), 'rep0203-busy-dispensing'
  from generate_series(1, 20000) n;
set local session_replication_role = origin;
analyze ehr.visit_queue, ehr.encounters, ehr.lab_requests, lab.specimens, lab.test_executions, lab.result_releases,
  pharmacy.dispensings, pharmacy.dispensing_reversals, identity.registration_cases, ehr.order_route_unable_endings;
select pg_temp.as_staff('synthetic:reports-0203:a0', 'f2035000-0000-4000-8000-0000000000a9',
  'f2031000-0000-4000-8000-0000000000f9', 'healthcare-operations', 'reports-0203-busy');
set local role hid_ehr_api_runtime;
select clock_timestamp() as busy_started \gset
select pg_temp.report(91, 0)::text as busy \gset
select extract(epoch from clock_timestamp() - :'busy_started'::timestamptz) * 1000 as busy_ms \gset
reset role;
\echo 'facility reports: route 1 over 92 days at the busy facility took' :busy_ms 'ms'
select pg_temp.expect('9 the busy facility: every check-in, visit, request, sample, result and dispensing counted',
  '50000/45000/20000/20000/20000/20000/50000',
  (select concat_ws('/', (r #>> '{sections,0,figures,0,current}'), (r #>> '{sections,2,figures,1,current}'),
     (r #>> '{sections,3,figures,0,current}'), (r #>> '{sections,3,figures,1,current}'),
     (r #>> '{sections,3,figures,2,current}'), (r #>> '{sections,4,figures,0,current}'),
     (r #>> '{sections,2,figures,0,current}'))
     from (select :'busy'::jsonb as r) answer));
-- The contract's target is 2 seconds on an idle server; the hard limit is ehr-api's 15-second statement_timeout
-- (REPORT_TOO_SLOW). The suite holds the call well inside the limit and prints the time against the target, which
-- depends on the server's load.
select pg_temp.expect('9 route 1 over 92 days well inside the 15-second limit', 'true', (:'busy_ms'::numeric < 10000)::text);
select (:'busy_ms'::numeric < 2000) as busy_within_target \gset
\if :busy_within_target
\echo 'facility reports: within the 2-second target'
\else
\echo 'facility reports: over the 2-second target on this server (a loaded server is slower)'
\endif

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.report_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0203-0204 facility reports:\n%', mismatch;
  end if;
  raise notice '0203-0204 facility reports: % cases passed', (select count(*) from pg_temp.report_outcomes);
end $$;

rollback;
