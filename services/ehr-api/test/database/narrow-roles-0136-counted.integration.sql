\set ON_ERROR_STOP on
-- 0147 (owner decision Q137 B): two narrow roles, work_list_reader
-- (lab.work-item.read, pharmacy.work-item.read) and reading_starter
-- (ocr.job.start), given to exactly the staff 0136 counted, with the stop
-- unless the counts are 9, 1 and 1 (production) or 0, 0 and 0 (a database
-- without them), and SX-4's change function replaced (0147's D5). Rollback-
-- only. On a migrated database it first takes 0147's roles, rows, grants
-- and audit rows away for its transaction, and puts SX-4's change function
-- back as Release B leaves it (0147's marked lines taken out, which 0147's
-- post-check proves gives that body) (0). The migration file is then run
-- here as written (psql \ir), inside a savepoint after each fixture, as the
-- runner runs it inside its transaction:
--   1. 0, 0 and 0 before any fixture: 0147 applies, creates the two roles
--      with exactly their three rows, grants nothing and writes no audit row,
--      changes no other role's row, policy or grant, and changes no function
--      but SX-4's change, and that one only by lines marked 0147 (Q137 B),
--      with its owner, grants, comment and settings kept;
--   2. fixtures at real facilities: 9 administrators and 1 doctor 0136 would
--      count today (granted before 0136's applied_at), and decoys: an
--      administrator and a doctor at the sealed QA hospital and an
--      administrator at a sealed demo facility, a doctor and an administrator
--      covered by another role (nurse, clinician), an administrator and a
--      doctor granted after 0136 was applied, a revoked assignment, an
--      inactive membership, a disabled login, a nurse and a laboratory
--      member;
--   3. the stop at other counts (8/1/1, 10/1/1, 9/2/1, 9/2/2, 9/1/0): 55000
--      with the three numbers, nothing applied (no role, row, grant or audit
--      row);
--   4. 9, 1 and 1: exactly the counted memberships get their role (the
--      doctor both), one row each with the owner's reason and granted_by
--      null, one audit row each in 0139's role-add form with no name;
--      membership_role and app_role unchanged; through
--      auth.membership_has_permission the counted read both work lists again
--      and the doctor starts readings again, and nobody else changes; the
--      locks 0147 takes are those its Locks paragraph declares; a second run
--      answers "0147: already applied" and changes nothing;
--   5. 9, 1 and 1 with the doctor also an administrator: one work-list row
--      for that membership (9 in all) and its reading row;
--   6. the preconditions: a role row 0136 removed put back refuses, naming
--      it; SX-4's change function not as Release B leaves it refuses;
--   7. SX-4 after 0147 at 9, 1 and 1, through support's commands as the
--      Identity runtime calls them: removing doctor from the counted doctor
--      whose only other roles are the narrow ones is refused as the last
--      role; either narrow role named to add or remove is refused (the
--      commands and the change function itself); an added role and a
--      removed other role leave the narrow roles, and the answers list them;
--      removing doctor from that doctor with the front desk role revokes
--      both narrow roles (by support, with the remove's reason, one
--      role-remove audit row each in the system actor's form), and moves
--      membership_role and app_role to the front desk role, not a narrow
--      role; the doctor who is also an administrator keeps work_list_reader
--      (reading_starter revoked, the role columns to admin); the facility
--      administrator's form (the change function called as its remove
--      calls it) writes the staff actor's rows.
-- 0147's locks are measured in 4: on a database where 0147 has not run (0
-- then replaces nothing), the function's own locks too; on a migrated one,
-- 0's replacement already holds those, so 4 sees the table locks only.
-- Synthetic values only: uuid prefix c147, @example.invalid addresses.
set plpgsql.variable_conflict = error;
begin;

-- Each case stops the suite at once when it fails; a sequence counts the
-- cases passed (a sequence keeps its count across ROLLBACK TO SAVEPOINT,
-- which each variant below ends with).
create temporary sequence q137b_passed;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0147 narrow roles suite failed: %: expected [%] got [%]', case_name, expected,
      coalesce(actual, 'null');
  end if;
  perform nextval('q137b_passed');
end
$$;

-- What 0147 creates, in one line: roles, their rows, grants, audit rows.
create function pg_temp.made() returns text language sql as $$
  select (select count(*) from auth.roles where code in ('work_list_reader', 'reading_starter')) || ' roles, '
      || (select count(*) from auth.role_permissions where role_code in ('work_list_reader', 'reading_starter'))
      || ' rows, ' || (select count(*) from auth.account_roles where role_code in ('work_list_reader', 'reading_starter'))
      || ' grants, ' || (select count(*) from audit.events where correlation_id = '0147-narrow-roles-q137b')
      || ' audit rows';
$$;
-- A function body with the lines 0147 marks taken out (0147's post-check).
create function pg_temp.unmarked(body text) returns text language sql immutable as $$
  select regexp_replace(body, '[^\n]*-- 0147 \(Q137 B\)\n', '', 'g');
$$;
-- Every function (body less 0147's marked lines, grants, owner, settings,
-- comment), policy and table privilege, to show 0147 changes nothing else.
create function pg_temp.catalog_print() returns text language sql as $$
  select md5(coalesce((select string_agg(proc.oid::text || ':' || md5(pg_temp.unmarked(proc.prosrc)) || ':'
                                         || coalesce(proc.proacl::text, '') || ':' || proc.proowner || ':'
                                         || proc.prosecdef || ':' || coalesce(proc.proconfig::text, '') || ':'
                                         || coalesce(obj_description(proc.oid, 'pg_proc'), ''), ',' order by proc.oid)
                         from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                        where namespace.nspname not in ('pg_catalog', 'information_schema')
                          and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'), '')
             || '|' || coalesce((select string_agg(policy.oid::text || ':' || policy.polname, ',' order by policy.oid)
                                   from pg_policy policy), '')
             || '|' || coalesce((select string_agg(class.oid::text || ':' || coalesce(class.relacl::text, ''), ','
                                                   order by class.oid)
                                   from pg_class class join pg_namespace namespace on namespace.oid = class.relnamespace
                                  where namespace.nspname not in ('pg_catalog', 'information_schema')
                                    and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%'), ''));
$$;
-- 0. Back to the state before 0147, for this transaction. On a migrated
-- database 0147 has run already (at 0, 0 and 0 on a fresh one): its grants,
-- its two roles with their three rows, and its audit rows (append-only, so
-- with triggers off) are taken away.
set local session_replication_role = replica;
delete from audit.events where correlation_id = '0147-narrow-roles-q137b';
set local session_replication_role = origin;
delete from auth.account_roles where role_code in ('work_list_reader', 'reading_starter');
delete from auth.role_permissions where role_code in ('work_list_reader', 'reading_starter');
delete from auth.roles where code in ('work_list_reader', 'reading_starter');
-- SX-4's change function back to Release B's body: its CREATE OR REPLACE
-- statement with 0147's marked lines taken out (owner, grants and comment
-- kept). Nothing to do where 0147 has not run.
do $$
declare
  apply_oid regprocedure := 'identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,text,'
    'text,text,text,text,uuid,uuid,text)'::regprocedure;
  body text := (select proc.prosrc from pg_proc proc where proc.oid = apply_oid);
begin
  if body <> pg_temp.unmarked(body) then
    execute replace(pg_get_functiondef(apply_oid), body, pg_temp.unmarked(body));
  end if;
end $$;
select pg_temp.expect('0a the state before 0147, for this transaction', '0 roles, 0 rows, 0 grants, 0 audit rows',
  pg_temp.made());
select pg_temp.expect('0b SX-4''s change function as Release B leaves it', '25ecccbb09f5118cf0e7f7c1e98c5479',
  (select md5(proc.prosrc) from pg_proc proc
    where proc.oid = 'identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,text,text,text,'
                     'text,text,uuid,uuid,text)'::regprocedure));
create temporary table rows_before on commit drop as
  select role_code, permission_code from auth.role_permissions;
select pg_temp.catalog_print() as catalog_before \gset

-- 1. 0, 0 and 0: nobody of 0136's count is active in this database.
savepoint zero;
\set QUIET on
\ir ../../database/migrations/0147_narrow_roles_for_0136_counted_staff.sql
\set QUIET off
select pg_temp.expect('1a at 0, 0 and 0 it applies: the two roles and their three rows, no grant, no audit row',
  '2 roles, 3 rows, 0 grants, 0 audit rows', pg_temp.made());
select pg_temp.expect('1b each role holds exactly its permissions, both active, neither a staff role',
  'reading_starter true: ocr.job.start | work_list_reader true: lab.work-item.read pharmacy.work-item.read',
  (select string_agg(role_row.code || ' ' || role_row.active || ': ' || (select string_agg(grant_row.permission_code, ' '
                       order by grant_row.permission_code) from auth.role_permissions grant_row
                      where grant_row.role_code = role_row.code), ' | ' order by role_row.code)
     from auth.roles role_row where role_row.code in ('work_list_reader', 'reading_starter')));
select pg_temp.expect('1c no other role''s row changed', '0 0',
  (select count(*) from (select role_code, permission_code from auth.role_permissions
                          where role_code not in ('work_list_reader', 'reading_starter')
                         except select role_code, permission_code from rows_before) more)
  || ' ' || (select count(*) from (select role_code, permission_code from rows_before
                                   except select role_code, permission_code from auth.role_permissions) fewer));
select pg_temp.expect('1d no function changed but by lines marked 0147 (Q137 B), with owners, grants, settings and comments kept; no policy or table privilege changed (runtime-grants.sql unchanged)', 'same',
  case when pg_temp.catalog_print() = :'catalog_before' then 'same' else 'changed' end);
select pg_temp.expect('1d2 SX-4''s change function is the only one with such lines, and it has them',
  'identity.staff_role_change_apply',
  (select string_agg(namespace.nspname || '.' || proc.proname, ', ' order by namespace.nspname, proc.proname)
     from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname not in ('pg_catalog', 'information_schema') and namespace.nspname not like 'pg_temp%'
      and proc.prosrc <> pg_temp.unmarked(proc.prosrc)));
select pg_temp.expect('1e neither role can be invited or added or removed through SX-4 anywhere', '0',
  (select count(*)::text from (values ('hospital', 'ehr'), ('clinic', 'ehr'), ('laboratory', 'laboratory'),
                                      ('pharmacy', 'pharmacy'), ('other', 'ehr'), ('other', 'migrate'))
                               kind(organization_type, product_code)
     cross join lateral unnest(identity.staff_invitable_roles(kind.organization_type, kind.product_code)) offered(code)
    where offered.code in ('work_list_reader', 'reading_starter')));
select pg_temp.expect('1f 0139''s role lists still name only the five hospital roles; SX-4''s change names the narrow roles only in 0147''s lines',
  'false false', (select string_agg((pg_temp.unmarked(proc.prosrc) ~ 'work_list_reader|reading_starter')::text, ' '
                                    order by proc.proname)
            from pg_proc proc where proc.oid in (
              'identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,text,text,text,text,text,uuid,uuid,text)'::regprocedure,
              'identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)'::regprocedure)));
rollback to savepoint zero;
select pg_temp.expect('1g rolled back for the next cases', '0 roles, 0 rows, 0 grants, 0 audit rows', pg_temp.made());

-- 2. Fixtures. Organisation O; real Hospital F1 and Clinic F4; the sealed QA
-- hospital F2 and a sealed demo facility F3 (recorded as sealed members).
-- Members (n, facility, roles, granted before or after 0136, active
-- membership, login status, revoked):
--   1-7 admin at F1, 8 admin at F4, 9 admin and org_admin at F4  (counted)
--   10 doctor at F1                                    (counted, all three)
--   11 admin at F2 (sealed QA), 12 admin at F3 (sealed demo), 13 doctor at F2
--   14 doctor and nurse at F1 (the nurse role grants both reads and the start)
--   15 admin and clinician at F1 (the clinician role grants both reads)
--   16 admin granted after 0136, 17 doctor granted after 0136
--   18 admin, the assignment revoked; 19 admin, membership inactive
--   20 doctor, login disabled; 21 nurse; 22 lab
select applied_at as zero136_applied from migration.schema_migrations
 where version = '0136_role_permission_changes.sql' \gset
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('c1476000-0000-4000-8000-000000000001', 'Narrow Roles Test Org', 'narrow-roles-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c1476000-0000-4000-8000-000000000002', 'c1476000-0000-4000-8000-000000000001', 'Narrow Roles Hospital',
   'NR-147-A', 'Africa/Lagos', true, 'verified'),
  ('c1476000-0000-4000-8000-000000000003', 'c1476000-0000-4000-8000-000000000001', 'Narrow Roles QA Hospital',
   'NR-147-Q', 'Africa/Lagos', true, 'verified'),
  ('c1476000-0000-4000-8000-000000000004', 'c1476000-0000-4000-8000-000000000001', 'Narrow Roles Demo',
   'NR-147-D', 'Africa/Lagos', true, 'verified'),
  ('c1476000-0000-4000-8000-000000000005', 'c1476000-0000-4000-8000-000000000001', 'Narrow Roles Clinic',
   'NR-147-C', 'Africa/Lagos', true, 'verified');
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('facility', 'c1476000-0000-4000-8000-000000000003');
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('facility', 'c1476000-0000-4000-8000-000000000004');
create temporary table nr_member (n integer primary key, facility text, roles text[], after_0136 boolean,
  membership_active boolean, account_status text, revoked boolean) on commit drop;
insert into nr_member values
  (1, '2', array['admin'], false, true, 'active', false),
  (2, '2', array['admin'], false, true, 'active', false),
  (3, '2', array['admin'], false, true, 'active', false),
  (4, '2', array['admin'], false, true, 'active', false),
  (5, '2', array['admin'], false, true, 'active', false),
  (6, '2', array['admin'], false, true, 'active', false),
  (7, '2', array['admin'], false, true, 'active', false),
  (8, '5', array['admin'], false, true, 'active', false),
  (9, '5', array['admin', 'org_admin'], false, true, 'active', false),
  (10, '2', array['doctor'], false, true, 'active', false),
  (11, '3', array['admin'], false, true, 'active', false),
  (12, '4', array['admin'], false, true, 'active', false),
  (13, '3', array['doctor'], false, true, 'active', false),
  (14, '2', array['doctor', 'nurse'], false, true, 'active', false),
  (15, '2', array['admin', 'clinician'], false, true, 'active', false),
  (16, '2', array['admin'], true, true, 'active', false),
  (17, '2', array['doctor'], true, true, 'active', false),
  (18, '2', array['admin'], false, true, 'active', true),
  (19, '2', array['admin'], false, false, 'active', false),
  (20, '2', array['doctor'], false, true, 'disabled', false),
  (21, '2', array['nurse'], false, true, 'active', false),
  (22, '2', array['lab'], false, true, 'active', false);
create function pg_temp.nr_id(kind text, n integer) returns uuid language sql immutable as $$
  select ('c147' || kind || '000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
$$;
create function pg_temp.nr_facility(n integer) returns uuid language sql stable as $$
  select ('c1476000-0000-4000-8000-00000000000' || (select facility from nr_member where nr_member.n = $1))::uuid;
$$;
-- Members added by a variant (23 and up) use the same ids and rows.
create function pg_temp.add_member(n integer, facility text, roles text[]) returns void language plpgsql as $$
begin
  insert into nr_member values (n, facility, roles, false, true, 'active', false);
  insert into auth.accounts (id, subject, email, display_name, status)
  values (pg_temp.nr_id('1', n), 'staff:narrow-roles-' || n, 'narrow-roles-' || n || '@example.invalid',
          'Narrow Roles Staff ' || n, 'active');
  insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
  values (pg_temp.nr_id('2', n), pg_temp.nr_id('1', n), 'Narrow Roles Staff ' || n,
          'narrow-roles-' || n || '@example.invalid', 'verified', roles[1]);
  insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active)
  values (pg_temp.nr_id('3', n), pg_temp.nr_id('2', n), pg_temp.nr_id('1', n), 'c1476000-0000-4000-8000-000000000001',
          ('c1476000-0000-4000-8000-00000000000' || facility)::uuid, roles[1], roles[1], true, true);
  perform pg_temp.add_roles(n, roles);
end
$$;
insert into auth.accounts (id, subject, email, display_name, status)
select pg_temp.nr_id('1', n), 'staff:narrow-roles-' || n, 'narrow-roles-' || n || '@example.invalid',
  'Narrow Roles Staff ' || n, account_status
  from nr_member;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select pg_temp.nr_id('2', n), pg_temp.nr_id('1', n), 'Narrow Roles Staff ' || n, 'narrow-roles-' || n || '@example.invalid',
  'verified', roles[1]
  from nr_member;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select pg_temp.nr_id('3', n), pg_temp.nr_id('2', n), pg_temp.nr_id('1', n), 'c1476000-0000-4000-8000-000000000001',
  pg_temp.nr_facility(n), roles[1], roles[1], true, membership_active
  from nr_member;
-- A member's roles: before 0136 (a day before its applied_at) unless the
-- member is marked after (a second after it).
create function pg_temp.add_roles(n integer, roles text[]) returns void language sql as $$
  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason,
    granted_at, revoked_at, revoked_by, revocation_reason)
  select ('c1474000-0000-4000-8000-0000000' || lpad((member.n * 10 + role_row.k)::text, 5, '0'))::uuid,
    pg_temp.nr_id('1', member.n), role_row.role_code, 'facility', pg_temp.nr_id('3', member.n), pg_temp.nr_facility(member.n),
    'Synthetic 0147 suite role',
    (select applied_at from migration.schema_migrations where version = '0136_role_permission_changes.sql')
      + case when member.after_0136 then interval '1 second' else interval '-1 day' end,
    case when member.revoked then clock_timestamp() end,
    case when member.revoked then pg_temp.nr_id('1', 1) end,
    case when member.revoked then 'Synthetic 0147 suite revocation' end
    from nr_member member
    cross join lateral unnest(roles) with ordinality role_row(role_code, k)
   where member.n = add_roles.n;
$$;
select pg_temp.add_roles(n, roles) from nr_member order by n;
set local session_replication_role = origin;
select pg_temp.expect('2a fixtures: 22 members, 25 role rows, granted around 0136''s applied_at', '22 25 2',
  (select count(*) from nr_member) || ' ' || (select count(*) from auth.account_roles where id::text like 'c1474000-%')
  || ' ' || (select count(distinct granted_at) from auth.account_roles where id::text like 'c1474000-%'));

-- Each member's work lists and reading start at its facility, as every
-- service reads them: "lab pharmacy start", '-' where not held.
create function pg_temp.holds(n integer, permission text) returns boolean language sql as $$
  select coalesce(auth.membership_has_permission('staff:narrow-roles-' || n, pg_temp.nr_id('3', n),
    pg_temp.nr_facility(n), permission), false);
$$;
create function pg_temp.three(n integer) returns text language sql as $$
  select case when pg_temp.holds(n, 'lab.work-item.read') then 'lab' else '-' end || ' '
      || case when pg_temp.holds(n, 'pharmacy.work-item.read') then 'pharmacy' else '-' end || ' '
      || case when pg_temp.holds(n, 'ocr.job.start') then 'start' else '-' end;
$$;
create temporary table access_seen (stage text, n integer, three text) on commit drop;
insert into access_seen select 'before', n, pg_temp.three(n) from nr_member;
select pg_temp.expect('2b before 0147: no administrator or doctor alone reads a work list or starts a reading', '0',
  (select count(*)::text from access_seen seen join nr_member member on member.n = seen.n
    where seen.stage = 'before' and member.n <= 13 and seen.three <> '- - -'));
select pg_temp.expect('2c before 0147: the covered doctor and administrator hold all three through nurse and clinician',
  '14 lab pharmacy start | 15 lab pharmacy start',
  (select string_agg(n || ' ' || three, ' | ' order by n) from access_seen where stage = 'before' and n in (14, 15)));

-- Runs 0147 as written and keeps what it answered: the SQLSTATE and the
-- three counts of a stop (or its message), else 'applied'. 0147 is one
-- statement, so when it raises, ON_ERROR_ROLLBACK undoes all of it, as the
-- runner's transaction does.
\set run0147 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0147_narrow_roles_for_0136_counted_staff.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
create function pg_temp.answer(sqlstate text, message text) returns text language sql as $$
  select case when message = 'applied' then 'applied'
              else sqlstate || ' ' || coalesce(substring(message from 'the counts are ([0-9]+, [0-9]+ and [0-9]+)'),
                                                message) end;
$$;

-- 3. The stop at other counts: nothing applied.
savepoint variant;
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = pg_temp.nr_id('1', 1),
       revocation_reason = 'Synthetic 0147 suite revocation'
 where membership_id = pg_temp.nr_id('3', 7) and role_code = 'admin';
:run0147
select pg_temp.expect('3a 8, 1 and 1 (an administrator''s role revoked since): stops, nothing applied',
  '55000 8, 1 and 1 | 0 roles, 0 rows, 0 grants, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
select pg_temp.expect('3b the stop gives the numbers only', 'true',
  (:'LAST_ERROR_MESSAGE' = '0147 stopped, nothing was changed: the counts are 8, 1 and 1 (administrators and doctors '
     || 'for the work lists, doctors for the reading start); the owner approved exactly 9, 1 and 1 (Q137 B), and 0, 0 '
     || 'and 0 grants nothing.')::text);
rollback to savepoint variant;

set local session_replication_role = replica;
select pg_temp.add_member(23, '2', array['admin']);
set local session_replication_role = origin;
:run0147
select pg_temp.expect('3c 10, 1 and 1 (one administrator more): stops, nothing applied',
  '55000 10, 1 and 1 | 0 roles, 0 rows, 0 grants, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint variant;

-- A doctor with the front desk role starts readings (the desk's
-- ocr.job.start) but reads no work list: lines 13/14 only.
set local session_replication_role = replica;
select pg_temp.add_member(23, '2', array['doctor', 'receptionist']);
set local session_replication_role = origin;
:run0147
select pg_temp.expect('3d 9, 2 and 1 (a doctor with the front desk role): stops, nothing applied',
  '55000 9, 2 and 1 | 0 roles, 0 rows, 0 grants, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint variant;

set local session_replication_role = replica;
select pg_temp.add_member(23, '5', array['doctor']);
set local session_replication_role = origin;
:run0147
select pg_temp.expect('3e 9, 2 and 2 (a second doctor): stops, nothing applied',
  '55000 9, 2 and 2 | 0 roles, 0 rows, 0 grants, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint variant;

-- The counted doctor given the front desk role since: still reads no work
-- list, but starts readings, so line 21 counts nobody.
set local session_replication_role = replica;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('c1474000-0000-4000-8000-000000000109', pg_temp.nr_id('1', 10), 'receptionist', 'facility',
        pg_temp.nr_id('3', 10), pg_temp.nr_facility(10), 'Synthetic 0147 suite role');
set local session_replication_role = origin;
:run0147
select pg_temp.expect('3f 9, 1 and 0, a near miss (the doctor starts readings through the front desk role): stops, nothing applied',
  '55000 9, 1 and 0 | 0 roles, 0 rows, 0 grants, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint variant;

-- 4. 9, 1 and 1: it applies. The locks it takes are compared with those held
-- before it (the fixtures' own aside).
create temporary table locks_before on commit drop as
  select lock_row.relation, lock_row.mode from pg_locks lock_row
   where lock_row.pid = pg_backend_pid() and lock_row.granted and lock_row.locktype = 'relation';
create temporary table object_locks_before on commit drop as
  select lock_row.classid, lock_row.objid, lock_row.mode from pg_locks lock_row
   where lock_row.pid = pg_backend_pid() and lock_row.granted and lock_row.locktype = 'object';
:run0147
create temporary table locks_after on commit drop as
  select lock_row.relation, lock_row.mode from pg_locks lock_row
   where lock_row.pid = pg_backend_pid() and lock_row.granted and lock_row.locktype = 'relation';
create temporary table object_locks_after on commit drop as
  select lock_row.classid, lock_row.objid, lock_row.mode from pg_locks lock_row
   where lock_row.pid = pg_backend_pid() and lock_row.granted and lock_row.locktype = 'object';
select pg_temp.expect('4a at 9, 1 and 1 it applies: 10 work-list rows, 1 reading row, 11 audit rows',
  'applied | 2 roles, 3 rows, 11 grants, 11 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
select pg_temp.expect('4b exactly the counted memberships hold the new roles',
  '1 work_list_reader | 2 work_list_reader | 3 work_list_reader | 4 work_list_reader | 5 work_list_reader | '
  || '6 work_list_reader | 7 work_list_reader | 8 work_list_reader | 9 work_list_reader | 10 reading_starter work_list_reader',
  (select string_agg(member.n || ' ' || held.roles, ' | ' order by member.n)
     from nr_member member
     join lateral (select string_agg(assignment.role_code, ' ' order by assignment.role_code) as roles
                     from auth.account_roles assignment
                    where assignment.membership_id = pg_temp.nr_id('3', member.n)
                      and assignment.role_code in ('work_list_reader', 'reading_starter')) held on held.roles is not null));
select pg_temp.expect('4c every grant: facility scope, the membership''s facility and login, granted_by null, the owner''s reason, not revoked',
  '11',
  (select count(*)::text from auth.account_roles assignment
     join identity.staff_facility_memberships membership on membership.id = assignment.membership_id
    where assignment.role_code in ('work_list_reader', 'reading_starter')
      and assignment.scope_type = 'facility' and assignment.facility_id = membership.facility_id
      and assignment.account_id = membership.account_id and assignment.granted_by is null
      and assignment.grant_reason = 'Owner decision Q137 B (23 November 2026): access 0136 removed'
      and assignment.revoked_at is null));
select pg_temp.expect('4d one audit row per grant in 0139''s role-add form: system actor, facility and membership only',
  '11 11 0',
  (select count(*) || ' ' || count(*) filter (
            where event_row.actor_type = 'system' and event_row.actor_subject is null
              and event_row.actor_account_id is null and event_row.actor_membership_id is null
              and event_row.organization_id is null and event_row.patient_id is null
              and event_row.action = 'identity.facility-staff.role-add' and event_row.outcome = 'success'
              and event_row.resource_type = 'staff-membership'
              and event_row.purpose_of_use = 'healthcare-operations' and event_row.provenance = 'migration'
              and event_row.source_system = 'hid-0147'
              and event_row.reason = 'Owner decision Q137 B (23 November 2026): access 0136 removed'
              and exists (select 1 from auth.account_roles assignment
                           where assignment.membership_id::text = event_row.resource_id
                             and assignment.facility_id = event_row.facility_id
                             and assignment.role_code = event_row.details->>'roleCode'))
          || ' ' || count(*) filter (where event_row.details::text ~* 'narrow roles staff|example\.invalid|c1471000')
     from audit.events event_row where event_row.correlation_id = '0147-narrow-roles-q137b'));
select pg_temp.expect('4e the doctor''s two audit rows give its role codes before and after each grant',
  'reading_starter ["doctor", "work_list_reader"] -> ["doctor", "reading_starter", "work_list_reader"] | '
  || 'work_list_reader ["doctor"] -> ["doctor", "work_list_reader"]',
  (select string_agg(event_row.details->>'roleCode' || ' ' || (event_row.details->'previousRoles')::text || ' -> '
                     || (event_row.details->'roles')::text, ' | ' order by event_row.details->>'roleCode')
     from audit.events event_row
    where event_row.correlation_id = '0147-narrow-roles-q137b'
      and event_row.resource_id = pg_temp.nr_id('3', 10)::text));
select pg_temp.expect('4f membership_role and app_role unchanged for every member', '0',
  (select count(*)::text from nr_member member join identity.staff_facility_memberships membership
      on membership.id = pg_temp.nr_id('3', member.n)
    where membership.membership_role <> member.roles[1] or membership.app_role <> member.roles[1]));
insert into access_seen select 'after', n, pg_temp.three(n) from nr_member;
select pg_temp.expect('4g the counted administrators read both work lists again, and do not start readings',
  '1 lab pharmacy - | 2 lab pharmacy - | 3 lab pharmacy - | 4 lab pharmacy - | 5 lab pharmacy - | 6 lab pharmacy - | '
  || '7 lab pharmacy - | 8 lab pharmacy - | 9 lab pharmacy -',
  (select string_agg(n || ' ' || three, ' | ' order by n) from access_seen where stage = 'after' and n <= 9));
select pg_temp.expect('4h the counted doctor reads both work lists and starts readings again',
  'lab pharmacy start', (select three from access_seen where stage = 'after' and n = 10));
select pg_temp.expect('4i nobody else changed (sealed tenants, covered, granted after 0136, revoked, inactive, disabled, nurse, lab)',
  '', coalesce((select string_agg(after.n || ': ' || before.three || ' -> ' || after.three, ' | ' order by after.n)
                  from access_seen after join access_seen before on before.n = after.n and before.stage = 'before'
                 where after.stage = 'after' and after.n > 10 and after.three <> before.three), ''));
select pg_temp.expect('4j the counted doctor starts readings through ocr.job.write and the new ocr.job.start; checks and confirms as before',
  'true true true true', (select pg_temp.holds(10, 'ocr.job.write') || ' ' || pg_temp.holds(10, 'ocr.job.start') || ' '
                     || pg_temp.holds(10, 'ocr.validation.write') || ' ' || pg_temp.holds(10, 'ocr.patient.confirm')));
select pg_temp.expect('4k no other role''s row changed', '0 0',
  (select count(*) from (select role_code, permission_code from auth.role_permissions
                          where role_code not in ('work_list_reader', 'reading_starter')
                         except select role_code, permission_code from rows_before) more)
  || ' ' || (select count(*) from (select role_code, permission_code from rows_before
                                   except select role_code, permission_code from auth.role_permissions) fewer));
-- The locks: each table 0147 newly holds is one its Locks paragraph names,
-- at no stronger mode, and it holds every one of them at that mode.
create temporary table declared_locks (relation regclass, mode text) on commit drop;
insert into declared_locks values
  ('auth.roles', 'ShareRowExclusiveLock'), ('auth.role_permissions', 'ShareRowExclusiveLock'),
  ('auth.account_roles', 'ShareRowExclusiveLock'), ('audit.events', 'RowExclusiveLock'),
  ('auth.permissions', 'RowShareLock'), ('auth.accounts', 'RowShareLock'),
  ('identity.staff_facility_memberships', 'ExclusiveLock'), ('identity.facilities', 'RowShareLock'),
  ('identity.outreach_organisations', 'RowShareLock'), ('identity.organization_applications', 'RowShareLock'),
  ('identity.staff', 'AccessShareLock'), ('identity.organizations', 'AccessShareLock'),
  ('identity.sealed_demo_members', 'AccessShareLock'), ('identity.sealed_qa_members', 'AccessShareLock'),
  ('migration.schema_migrations', 'AccessShareLock');
create function pg_temp.strength(mode text) returns integer language sql immutable as $$
  select array_position(array['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
                               'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'], mode);
$$;
select pg_temp.expect('4l every table 0147 locks is declared, at no stronger mode than declared', '',
  coalesce((select string_agg(new_lock.relation::regclass::text || ' ' || new_lock.mode, '; '
                              order by new_lock.relation::regclass::text, new_lock.mode)
              from (select after.relation, after.mode from locks_after after
                    except select before.relation, before.mode from locks_before before) new_lock
              join pg_class class on class.oid = new_lock.relation
              join pg_namespace namespace on namespace.oid = class.relnamespace
             where class.relkind in ('r', 'p') and class.relpersistence <> 't'
               and namespace.nspname not in ('pg_catalog', 'information_schema')
               and not exists (select 1 from declared_locks declared
                                where declared.relation = new_lock.relation
                                  and pg_temp.strength(new_lock.mode) <= pg_temp.strength(declared.mode))), ''));
select pg_temp.expect('4m and it holds every declared table at its declared mode', '',
  coalesce((select string_agg(declared.relation::text || ' ' || declared.mode, '; ' order by declared.relation::text)
              from declared_locks declared
             where not exists (select 1 from locks_after after
                                where after.relation = declared.relation and after.mode = declared.mode)), ''));
select pg_temp.expect('4n besides tables it locks only indexes, audit.events'' sequence and pg_proc''s TOAST table (D5''s body), at most ROW EXCLUSIVE', '',
  coalesce((select string_agg(new_lock.relation::regclass::text || ' ' || new_lock.mode, '; ')
              from (select after.relation, after.mode from locks_after after
                    except select before.relation, before.mode from locks_before before) new_lock
              join pg_class class on class.oid = new_lock.relation
              join pg_namespace namespace on namespace.oid = class.relnamespace
             where class.relkind not in ('r', 'p', 'v') and class.relpersistence <> 't'
               and namespace.nspname not in ('pg_catalog', 'information_schema')
               and (class.relkind not in ('i', 'S', 't') or pg_temp.strength(new_lock.mode) > 3
                    or (class.relkind = 't' and class.oid <> (select toast.reltoastrelid from pg_class toast
                                                               where toast.oid = 'pg_catalog.pg_proc'::regclass)))), ''));
-- D5's CREATE OR REPLACE: object locks, ACCESS SHARE, on the identity schema,
-- the membership row type (its first argument) and plpgsql only (dropping
-- them waits for this transaction). On a migrated database 0 already holds
-- them, so none is new there.
select pg_temp.expect('4n2 the only objects it locks are the identity schema, the membership row type and plpgsql, at ACCESS SHARE', '',
  coalesce((select string_agg(new_lock.classid::regclass::text || ' ' || new_lock.objid || ' ' || new_lock.mode, '; ')
              from (select after.classid, after.objid, after.mode from object_locks_after after
                    except select before.classid, before.objid, before.mode from object_locks_before before) new_lock
             where not exists (select 1 from pg_type type_row
                                join pg_namespace namespace on namespace.oid = type_row.typnamespace
                               where new_lock.classid = 'pg_type'::regclass and type_row.oid = new_lock.objid
                                 and namespace.nspname like 'pg_temp%')
               and (new_lock.mode <> 'AccessShareLock'
                or (new_lock.classid, new_lock.objid) not in (
                     ('pg_namespace'::regclass, 'identity'::regnamespace::oid),
                     ('pg_type'::regclass, 'identity.staff_facility_memberships'::regtype::oid),
                     ('pg_language'::regclass, (select language_row.oid from pg_language language_row
                                                 where language_row.lanname = 'plpgsql'))))), ''));
-- A second run.
create temporary table grants_after_first on commit drop as
  select id from auth.account_roles where role_code in ('work_list_reader', 'reading_starter');
:run0147
select pg_temp.expect('4o a second run answers "0147: already applied" and changes nothing',
  '55000 0147: already applied | 2 roles, 3 rows, 11 grants, 11 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
select pg_temp.expect('4p the same eleven grants', '0',
  (select count(*)::text from (select id from auth.account_roles where role_code in ('work_list_reader', 'reading_starter')
                               except select id from grants_after_first) more));
rollback to savepoint variant;

-- 5. The counted doctor is also an administrator, and administrator 7 is not
-- counted (its role revoked): still 9, 1 and 1, and one work-list row for
-- the doctor's membership.
set local session_replication_role = replica;
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = pg_temp.nr_id('1', 1),
       revocation_reason = 'Synthetic 0147 suite revocation'
 where membership_id = pg_temp.nr_id('3', 7) and role_code = 'admin';
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason, granted_at)
values ('c1474000-0000-4000-8000-000000000108', pg_temp.nr_id('1', 10), 'admin', 'facility', pg_temp.nr_id('3', 10),
        pg_temp.nr_facility(10), 'Synthetic 0147 suite role', :'zero136_applied'::timestamptz - interval '1 day');
set local session_replication_role = origin;
:run0147
select pg_temp.expect('5a the doctor counted in both lines gets one work-list row: 9 and 1 rows, 10 audit rows',
  'applied | 2 roles, 3 rows, 10 grants, 10 audit rows | 9 1',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made() || ' | '
  || (select count(*) from auth.account_roles where role_code = 'work_list_reader') || ' '
  || (select count(*) from auth.account_roles where role_code = 'reading_starter'));
rollback to savepoint variant;

-- 6. Preconditions: a row 0136 removed is back (as #316's restore would have
-- put it), so 0147 refuses and names it.
insert into auth.role_permissions (role_code, permission_code) values ('admin', 'lab.work-item.read');
:run0147
select pg_temp.expect('6a a role row not as 0136 left it is refused, naming it',
  '55000 0147: the role table is not as 0136 left it: admin lab.work-item.read | 0 roles, 0 rows, 0 grants, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint variant;

-- SX-4's change function not as Release B leaves it: a changed body,
-- EXECUTE granted to PUBLIC, or another attribute (cost). 0147 refuses
-- before it changes anything.
do $$
declare
  apply_oid regprocedure := 'identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,text,'
    'text,text,text,text,uuid,uuid,text)'::regprocedure;
begin
  execute replace(pg_get_functiondef(apply_oid), E'  closed record;\n', E'  closed record;\n  changed_elsewhere text;\n');
end $$;
:run0147
select pg_temp.expect('6b SX-4''s change function with another body is refused',
  '55000 0147: identity.staff_role_change_apply is not as Release B leaves it (0139''s body, SECURITY INVOKER with its '
  || 'search_path and its other attributes, EXECUTE for neither PUBLIC nor the Identity runtime); nothing applied '
  || '| 0 roles, 0 rows, 0 grants, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint variant;
grant execute on function
  identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,text,text,text,text,text,uuid,uuid,text)
  to public;
:run0147
select pg_temp.expect('6c SX-4''s change function executable by PUBLIC is refused',
  '55000 0147: identity.staff_role_change_apply is not as Release B leaves it (0139''s body, SECURITY INVOKER with its '
  || 'search_path and its other attributes, EXECUTE for neither PUBLIC nor the Identity runtime); nothing applied '
  || '| 0 roles, 0 rows, 0 grants, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint variant;
alter function
  identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,text,text,text,text,text,uuid,uuid,text)
  cost 50;
:run0147
select pg_temp.expect('6d SX-4''s change function with another attribute (cost) is refused before the counts',
  '55000 0147: identity.staff_role_change_apply is not as Release B leaves it (0139''s body, SECURITY INVOKER with its '
  || 'search_path and its other attributes, EXECUTE for neither PUBLIC nor the Identity runtime); nothing applied '
  || '| 0 roles, 0 rows, 0 grants, 0 audit rows',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made());
rollback to savepoint variant;

-- 7. SX-4 after 0147 at 9, 1 and 1 (D5). Support's commands run as the
-- Identity runtime in the context withPlatformTransaction sets (F1 is a
-- governed facility, so support changes its roles); each command is built
-- as text first (with the membership's current version) and its answer read
-- back as text: roles before | roles after (| requests closed | grants
-- revoked for a remove), or the refusal's SQLSTATE and message.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('c1477000-0000-4000-8000-000000000001', 'synthetic:narrow-roles:support', 'narrow-roles-support@example.invalid',
   'Narrow Roles Support', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c1477000-0000-4000-8000-000000000002', 'c1477000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
   'Synthetic 0147 suite support');
create function pg_temp.as_support(correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:narrow-roles:support', true),
    set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
    set_config('app.correlation_id', correlation, true), set_config('app.purpose_of_use', 'healthcare-operations', true);
$$;
create function pg_temp.sx4(command text) returns text language plpgsql as $$
declare
  answer text;
begin
  execute command into answer;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$$;
grant execute on function pg_temp.as_support(text), pg_temp.sx4(text) to hid_identity_api_runtime;
create function pg_temp.version(n integer) returns bigint language sql as $$
  select membership.row_version from identity.staff_facility_memberships membership
   where membership.id = pg_temp.nr_id('3', n);
$$;
create function pg_temp.support_remove(n integer, role_code text, label text) returns text language sql as $$
  select format('select concat_ws('' | '', array_to_string(r.previous_roles, '' ''), array_to_string(r.roles, '' ''), '
                || 'r.requests_closed, r.grants_revoked) from identity.admin_remove_facility_staff_role(%L, %L, %s, %L, '
                || '%L, %L, %L) r', pg_temp.nr_facility(n), pg_temp.nr_id('3', n), pg_temp.version(n), role_code,
                'Synthetic 0147 suite remove ' || label, 'narrow-roles-sx4-' || label,
                encode(sha256(('narrow-roles-sx4-' || label)::bytea), 'hex'));
$$;
create function pg_temp.support_add(n integer, role_code text, label text) returns text language sql as $$
  select format('select concat_ws('' | '', array_to_string(r.previous_roles, '' ''), array_to_string(r.roles, '' '')) '
                || 'from identity.admin_add_facility_staff_role(%L, %L, %s, %L, null, null, null, %L, %L, %L) r',
                pg_temp.nr_facility(n), pg_temp.nr_id('3', n), pg_temp.version(n), role_code,
                'Synthetic 0147 suite add ' || label, 'narrow-roles-sx4-' || label,
                encode(sha256(('narrow-roles-sx4-' || label)::bytea), 'hex'));
$$;
-- SX-4's change function called directly, as the four commands call it (as
-- its owner), for member n: the facility administrator's form when an
-- attester membership is given, support's otherwise.
create function pg_temp.change(n integer, action text, role_code text, attester integer) returns text language sql as $$
  select format('select concat_ws('' | '', array_to_string(r.previous_roles, '' ''), array_to_string(r.roles, '' ''), '
                || 'r.requests_closed, r.grants_revoked) from identity.staff_role_change_apply((select membership '
                || 'from identity.staff_facility_memberships membership where membership.id = %L), %s, %L, %L, null, '
                || 'null, null, null, %L, %L, %L) r', pg_temp.nr_id('3', n), pg_temp.version(n), action, role_code,
                case when attester is null then 'c1477000-0000-4000-8000-000000000001'::uuid
                     else pg_temp.nr_id('1', attester) end,
                case when attester is null then null else pg_temp.nr_id('3', attester) end,
                case when attester is null then 'Role removed by Health ID support'
                     else 'Role removed by the facility administrator' end);
$$;
-- A member's facility roles held now, and its two role columns.
create function pg_temp.held(n integer) returns text language sql as $$
  select coalesce((select string_agg(assignment.role_code, ' ' order by assignment.role_code)
                     from auth.account_roles assignment
                    where assignment.membership_id = pg_temp.nr_id('3', n) and assignment.revoked_at is null), '')
      || ' | ' || membership.membership_role || ' ' || membership.app_role
    from identity.staff_facility_memberships membership where membership.id = pg_temp.nr_id('3', n);
$$;
-- The role-remove audit rows SX-4's change function wrote for the narrow
-- roles: role, roles before -> after, cause and the role removed.
create function pg_temp.narrow_rows(n integer) returns text language sql as $$
  select coalesce(string_agg(event_row.details->>'roleCode' || ' ' || (event_row.details->'previousRoles')::text
                             || ' -> ' || (event_row.details->'roles')::text || ' ' || (event_row.details->>'cause')
                             || ' ' || (event_row.details->>'removedRole'), ' | ' order by event_row.details->>'roleCode'), '')
    from audit.events event_row
   where event_row.action = 'identity.facility-staff.role-remove' and event_row.resource_id = pg_temp.nr_id('3', n)::text
     and event_row.details->>'roleCode' in ('work_list_reader', 'reading_starter');
$$;
-- How each narrow role row of member n stands: revoked or held, and for a
-- revoked one whether by the given account, with which reason, and at the
-- moment doctor was revoked.
create function pg_temp.narrow_state(n integer, by_account uuid) returns text language sql as $$
  select string_agg(assignment.role_code || ' '
                    || case when assignment.revoked_at is null then 'held'
                            else 'revoked ' || (assignment.revoked_by = by_account) || ' ' || assignment.revocation_reason
                                 || ' ' || (assignment.revoked_at = (select doctor.revoked_at from auth.account_roles doctor
                                                                     where doctor.membership_id = assignment.membership_id
                                                                       and doctor.role_code = 'doctor'))
                       end, ' | ' order by assignment.role_code)
    from auth.account_roles assignment
   where assignment.membership_id = pg_temp.nr_id('3', n)
     and assignment.role_code in ('work_list_reader', 'reading_starter');
$$;
savepoint sx4;

-- The counted doctor (doctor and the two narrow roles).
:run0147
select pg_temp.support_remove(10, 'doctor', 'remove-doctor-last') as sx4_command \gset
set local role hid_identity_api_runtime;
select pg_temp.as_support('narrow-roles-sx4-0001');
select pg_temp.sx4(:'sx4_command') as sx4_answer \gset
reset role;
select pg_temp.expect('7a doctor is the counted doctor''s last role but the narrow ones: the remove is refused, nothing changes',
  'applied | P0001 FACILITY_STAFF_LAST_ROLE | doctor reading_starter work_list_reader | doctor doctor',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'sx4_answer' || ' | ' || pg_temp.held(10));
select pg_temp.version(10) as version_before \gset
select pg_temp.support_add(10, 'work_list_reader', 'add-narrow') as add_command,
       pg_temp.support_remove(10, 'reading_starter', 'remove-narrow') as remove_command \gset
set local role hid_identity_api_runtime;
select pg_temp.as_support('narrow-roles-sx4-0002');
select pg_temp.sx4(:'add_command') as add_answer, pg_temp.sx4(:'remove_command') as remove_answer \gset
reset role;
select pg_temp.sx4(pg_temp.change(10, 'add', 'work_list_reader', null)) as add_change,
       pg_temp.sx4(pg_temp.change(10, 'remove', 'reading_starter', null)) as remove_change \gset
select pg_temp.expect('7b a narrow role named to add or remove is refused, by the commands and by SX-4''s change itself',
  '22023 STAFF_INVITATION_INVALID | 22023 STAFF_INVITATION_INVALID | 22023 STAFF_INVITATION_INVALID | '
  || '22023 STAFF_INVITATION_INVALID | doctor reading_starter work_list_reader | doctor doctor | same version',
  :'add_answer' || ' | ' || :'remove_answer' || ' | ' || :'add_change' || ' | ' || :'remove_change' || ' | '
  || pg_temp.held(10) || ' | ' || case when pg_temp.version(10) = :version_before then 'same version' else 'changed' end);
select pg_temp.support_add(10, 'receptionist', 'add-desk-first') as sx4_command \gset
set local role hid_identity_api_runtime;
select pg_temp.as_support('narrow-roles-sx4-0003');
select pg_temp.sx4(:'sx4_command') as sx4_answer \gset
reset role;
select pg_temp.expect('7c an added role leaves the narrow roles and the role columns; the answer lists every role',
  'doctor reading_starter work_list_reader | doctor reading_starter receptionist work_list_reader | '
  || 'doctor reading_starter receptionist work_list_reader | doctor doctor',
  :'sx4_answer' || ' | ' || pg_temp.held(10));
select pg_temp.support_remove(10, 'receptionist', 'remove-desk') as sx4_command \gset
set local role hid_identity_api_runtime;
select pg_temp.as_support('narrow-roles-sx4-0004');
select pg_temp.sx4(:'sx4_command') as sx4_answer \gset
reset role;
select pg_temp.expect('7d removing a role other than doctor leaves the narrow roles, and writes no row for them',
  'doctor reading_starter receptionist work_list_reader | doctor reading_starter work_list_reader | 0 | 0 | '
  || 'doctor reading_starter work_list_reader | doctor doctor | reading_starter held | work_list_reader held | ',
  :'sx4_answer' || ' | ' || pg_temp.held(10) || ' | '
  || pg_temp.narrow_state(10, 'c1477000-0000-4000-8000-000000000001') || ' | ' || pg_temp.narrow_rows(10));
select pg_temp.support_add(10, 'receptionist', 'add-desk-again') as sx4_command \gset
set local role hid_identity_api_runtime;
select pg_temp.as_support('narrow-roles-sx4-0005');
select pg_temp.sx4(:'sx4_command') as add_answer \gset
reset role;
select pg_temp.support_remove(10, 'doctor', 'remove-doctor') as sx4_command \gset
set local role hid_identity_api_runtime;
select pg_temp.as_support('narrow-roles-sx4-0006');
select pg_temp.sx4(:'sx4_command') as sx4_answer \gset
reset role;
select pg_temp.expect('7e support removes doctor from the counted doctor with the front desk role: both narrow roles go too',
  'doctor reading_starter work_list_reader | doctor reading_starter receptionist work_list_reader | '
  || 'doctor reading_starter receptionist work_list_reader | receptionist | 0 | 0 | receptionist | receptionist receptionist',
  :'add_answer' || ' | ' || :'sx4_answer' || ' | ' || pg_temp.held(10));
select pg_temp.expect('7f each narrow role revoked by support, with the remove''s reason, when doctor was',
  'reading_starter revoked true Role removed by Health ID support true | '
  || 'work_list_reader revoked true Role removed by Health ID support true',
  pg_temp.narrow_state(10, 'c1477000-0000-4000-8000-000000000001'));
select pg_temp.expect('7g one role-remove audit row each, with the roles before and after it',
  'reading_starter ["reading_starter", "receptionist", "work_list_reader"] -> ["receptionist", "work_list_reader"] '
  || 'role-removed doctor | work_list_reader ["receptionist", "work_list_reader"] -> ["receptionist"] role-removed doctor',
  pg_temp.narrow_rows(10));
select pg_temp.expect('7h in the system actor''s form for support: the facility and the membership, no person',
  '2 2',
  (select count(*) || ' ' || count(*) filter (
            where event_row.correlation_id = 'narrow-roles-sx4-0006' and event_row.actor_type = 'system'
              and event_row.actor_subject is null and event_row.actor_account_id is null
              and event_row.actor_membership_id is null and event_row.patient_id is null
              and event_row.organization_id = 'c1476000-0000-4000-8000-000000000001'
              and event_row.facility_id = pg_temp.nr_facility(10) and event_row.outcome = 'success'
              and event_row.resource_type = 'staff-membership' and event_row.purpose_of_use = 'healthcare-operations'
              and event_row.reason = 'Role removed by Health ID support' and event_row.provenance = 'application'
              and event_row.source_system = 'identity-api'
              and event_row.details->>'membershipId' = pg_temp.nr_id('3', 10)::text)
     from audit.events event_row
    where event_row.action = 'identity.facility-staff.role-remove'
      and event_row.resource_id = pg_temp.nr_id('3', 10)::text
      and event_row.details->>'roleCode' in ('work_list_reader', 'reading_starter')));
select pg_temp.expect('7i the doctor now reads no work list and starts readings through the front desk role only',
  '- - start', pg_temp.three(10));
rollback to savepoint sx4;

-- The counted doctor is also an administrator (as in 5).
set local session_replication_role = replica;
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = pg_temp.nr_id('1', 1),
       revocation_reason = 'Synthetic 0147 suite revocation'
 where membership_id = pg_temp.nr_id('3', 7) and role_code = 'admin';
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason, granted_at)
values ('c1474000-0000-4000-8000-000000000108', pg_temp.nr_id('1', 10), 'admin', 'facility', pg_temp.nr_id('3', 10),
        pg_temp.nr_facility(10), 'Synthetic 0147 suite role', :'zero136_applied'::timestamptz - interval '1 day');
set local session_replication_role = origin;
:run0147
select pg_temp.support_remove(10, 'doctor', 'remove-doctor-admin') as sx4_command \gset
set local role hid_identity_api_runtime;
select pg_temp.as_support('narrow-roles-sx4-0007');
select pg_temp.sx4(:'sx4_command') as sx4_answer \gset
reset role;
select pg_temp.expect('7j an administrator who loses doctor keeps work_list_reader; the role columns move to admin',
  'applied | admin doctor reading_starter work_list_reader | admin work_list_reader | 0 | 0 | admin work_list_reader | admin admin',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'sx4_answer' || ' | ' || pg_temp.held(10));
select pg_temp.expect('7k only reading_starter revoked, with its one audit row',
  'reading_starter revoked true Role removed by Health ID support true | work_list_reader held | '
  || 'reading_starter ["admin", "reading_starter", "work_list_reader"] -> ["admin", "work_list_reader"] role-removed doctor',
  pg_temp.narrow_state(10, 'c1477000-0000-4000-8000-000000000001') || ' | ' || pg_temp.narrow_rows(10));
select pg_temp.expect('7l it reads both work lists still, and starts no reading', 'lab pharmacy -', pg_temp.three(10));
rollback to savepoint sx4;

-- The facility administrator's form: SX-4's change function called as
-- identity.remove_facility_staff_role calls it, by administrator 1 (F1 is
-- governed, so the command itself is support's there; the function is the
-- same).
:run0147
set local session_replication_role = replica;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('c1474000-0000-4000-8000-000000000109', pg_temp.nr_id('1', 10), 'receptionist', 'facility',
        pg_temp.nr_id('3', 10), pg_temp.nr_facility(10), 'Synthetic 0147 suite role');
set local session_replication_role = origin;
select set_config('app.actor_subject', 'staff:narrow-roles-1', true),
  set_config('app.correlation_id', 'narrow-roles-sx4-0008', true);
select pg_temp.sx4(pg_temp.change(10, 'remove', 'doctor', 1)) as sx4_answer \gset
select set_config('app.actor_subject', '', true), set_config('app.correlation_id', '', true);
select pg_temp.expect('7m the administrator''s remove of doctor revokes both narrow roles, by the administrator',
  'applied | doctor reading_starter receptionist work_list_reader | receptionist | 0 | 0 | receptionist | receptionist receptionist | '
  || 'reading_starter revoked true Role removed by the facility administrator true | '
  || 'work_list_reader revoked true Role removed by the facility administrator true',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'sx4_answer' || ' | ' || pg_temp.held(10)
  || ' | ' || pg_temp.narrow_state(10, pg_temp.nr_id('1', 1)));
select pg_temp.expect('7n its two audit rows name the administrator as the staff actor',
  '2 2',
  (select count(*) || ' ' || count(*) filter (
            where event_row.correlation_id = 'narrow-roles-sx4-0008' and event_row.actor_type = 'staff'
              and event_row.actor_subject = 'staff:narrow-roles-1' and event_row.actor_account_id = pg_temp.nr_id('1', 1)
              and event_row.actor_membership_id = pg_temp.nr_id('3', 1) and event_row.patient_id is null
              and event_row.facility_id = pg_temp.nr_facility(10)
              and event_row.reason = 'Role removed by the facility administrator')
     from audit.events event_row
    where event_row.action = 'identity.facility-staff.role-remove'
      and event_row.resource_id = pg_temp.nr_id('3', 10)::text
      and event_row.details->>'roleCode' in ('work_list_reader', 'reading_starter')));
rollback to savepoint sx4;

do $$
begin
  if currval('q137b_passed') <> 55 then
    raise exception '0147 narrow roles suite failed: % cases ran, 55 expected', currval('q137b_passed');
  end if;
  raise notice '0147 narrow roles suite: % cases passed', currval('q137b_passed');
end $$;

rollback;
