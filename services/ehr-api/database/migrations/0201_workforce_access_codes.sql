-- 0201 ROS-1 Shifts, rosters, HR and credentials: who uses the duty roster
-- and leave (Release D, the department sprint the owner approved on 25
-- November 2026, verbatim: "I approve Q147-Q290 at the recommended options").
-- Written on claude/sprint-hr-backend at 67a1099a (staging-novu-ci-20261005 at
-- 0cfddcc9: 0001-0153 applied) with 0199, 0200 and 0202. The number is
-- provisional (given at merge). It reads nothing 0140-0200 create or change:
-- it adds codes and role rows only, and the workforce functions read the codes
-- on every call, so it needs nothing of 0199 or 0200. It pins no role's whole
-- code list: other lanes' codes on these roles (BILL-1, ED-1, ADT-1, NUR-1 and
-- later) are kept, and the post-check compares every row that is not this
-- file's with the table before. The declaration in
-- config/production-schema-compatibility.json stays unsigned until the owner
-- signs this file. It is its own file so Rahman can review who gets the duty
-- roster and leave apart from the tables (as 0169).
--
-- Owner decisions (25 November 2026, each at its recommended option): Q245 A
-- (in-charges get the roster right from the administrator), Q193 A (the codes
-- are workforce.roster.*, never billing.shift.*). Smaller choices at the
-- recommended option, not yet answered by the owner: Q-ROS-8 A (no new role:
-- the administrator names in-charges per department, 0200), Q-ROS-9 A
-- (published rosters are seen by every staff role at the facility).
--
-- What it changes (nothing else):
-- F1 auth.permissions          three codes: workforce.roster.read (see the
--                              published rosters, who is in charge and who is
--                              on duty; an in-charge named by 0200 edits that
--                              department's rosters while holding it),
--                              workforce.roster.manage (the administrator:
--                              every department's rosters, name in-charges,
--                              decide all leave), workforce.leave.request (ask
--                              for leave and see one's own requests).
-- F2 auth.role_permissions     eighteen rows:
--                                receptionist  read, leave.request
--                                nurse         read, leave.request
--                                clinician     read, leave.request
--                                doctor        read, leave.request
--                                lab           read, leave.request
--                                pharmacist    read, leave.request
--                                admin         read, manage, leave.request
--                                org_admin     read, manage, leave.request
--                              cashier, billing_officer, the narrow roles and
--                              the platform roles get none (a later file, once
--                              those roles are live). HR & Credentials keeps
--                              0006's workforce.manage (admin, org_admin).
-- F3 audit.events              one row per role row added, as the system actor
--                              (no account, membership, facility or patient):
--                              auth.role-permission.add, resource
--                              role-permission "<role>/<code>", reason "ROS-1
--                              Duty roster and leave (Release D, owner
--                              decisions Q245 A and Q-ROS-8 A)".
-- No function, policy, grant or table changes, so runtime-grants.sql is
-- unchanged by this file. Permissions are read from these tables on every
-- request (auth.membership_has_permission and the Identity staff context), so
-- the change applies from each signed-in member's next request; nobody is
-- signed out. identity-api's DUTY_ROSTER_ENABLED still keeps every route closed
-- in production until the owner's go-live. The closing NOTICE prints how many
-- active memberships at real (not sealed) facilities gain each code.
--
-- Locks, taken first, NOWAIT: SHARE ROW EXCLUSIVE on auth.role_permissions for
-- the transaction (other writers wait; every reader, each staff request's
-- permission check included, goes on), so the role table cannot change
-- between the preconditions and the post-checks; ROW EXCLUSIVE on
-- auth.permissions and audit.events (the new rows); ROW SHARE on auth.roles
-- (the role rows' foreign key checks) and on auth.accounts,
-- identity.staff_facility_memberships, identity.organizations,
-- identity.facilities and identity.patients (the foreign key checks of the
-- audit rows open every table they reference, even for a null key); ACCESS
-- SHARE on auth.account_roles, identity.sealed_demo_members and
-- identity.sealed_qa_members (the closing count: identity.sealed_demo_facility
-- and identity.sealed_qa_facility read the two lists). A busy table fails the
-- attempt at once, and its subtransaction releases every lock the attempt
-- took. The attempt is made 50 times, 100 ms apart (about 5 seconds), so the
-- file never waits for one of its locks while holding the others; then 55P03
-- (nothing applied). When this transaction already holds an earlier
-- migration's locks that stop other sessions' reads or writes (the runner's
-- dry run applies every pending file in one transaction), one attempt and no
-- sleep: 55P03 at once, nothing applied. Both refusals begin "0201: " and end
-- "run the release again at a quieter time", so the runner's dry run rolls
-- back and tries again (#306). Other waits are not NOWAIT, and the runner's
-- lock_timeout ends each after 5 seconds (nothing applied): a row of
-- auth.roles that another session holds FOR UPDATE, or DDL in flight on
-- audit.events' identity sequence.
--
-- Undo (not in the ledger; a migration only if the owner signs it): take the
-- eighteen rows out of auth.role_permissions (or mark the three codes
-- inactive). Every workforce function then refuses again from the next
-- request.
--
-- The whole file is one statement (do $hr0201$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): "0201: already applied" when the
--    three codes and exactly the eighteen rows are there, "0201: the role
--    table is not in the reviewed state" when any of the codes or rows is
--    there otherwise; the eight roles exist and are active;
--    auth.membership_has_permission, which every service's permission check
--    calls, is as 0001-0153 leave it (md5 pinned, so it still reads the
--    role's rows on every request); the two sealed-list readers the closing
--    count calls are as 0098 and 0123 leave them.
-- 2. F1-F3.
-- 3. Post-checks: the workforce.roster.* and workforce.leave.* rows are
--    exactly the eighteen; every other row of the role table is unchanged
--    (compared row by row with the table before step 2); the three codes are
--    active; exactly eighteen audit rows of this file.

do $hr0201$
declare
  v_attempt integer := 0;
  v_holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  v_missing text;
  v_reason constant text := 'ROS-1 Duty roster and leave (Release D, owner decisions Q245 A and Q-ROS-8 A)';
  v_correlation constant text := '0201-duty-roster-ros1';
  -- The eighteen rows, in byte order (role, then code), joined by ','.
  v_rows_expected constant text := 'admin workforce.leave.request,admin workforce.roster.manage,'
    || 'admin workforce.roster.read,clinician workforce.leave.request,clinician workforce.roster.read,'
    || 'doctor workforce.leave.request,doctor workforce.roster.read,lab workforce.leave.request,'
    || 'lab workforce.roster.read,nurse workforce.leave.request,nurse workforce.roster.read,'
    || 'org_admin workforce.leave.request,org_admin workforce.roster.manage,org_admin workforce.roster.read,'
    || 'pharmacist workforce.leave.request,pharmacist workforce.roster.read,'
    || 'receptionist workforce.leave.request,receptionist workforce.roster.read';
  v_codes constant text[] := array['workforce.roster.read', 'workforce.roster.manage', 'workforce.leave.request'];
  -- auth.membership_has_permission(text,uuid,uuid,text) as 0001-0153 leave it.
  v_permission_check_md5 constant text := '65e3eaff93fe729fd5c5b986b80c9dd6';
  v_rows_before text;
  v_audited integer;
  v_read_gain integer;
  v_manage_gain integer;
  v_leave_gain integer;
begin
  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0 reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table auth.role_permissions in share row exclusive mode nowait;
  lock table auth.permissions, audit.events in row exclusive mode nowait;
  lock table auth.roles, auth.accounts, identity.staff_facility_memberships, identity.organizations,
             identity.facilities, identity.patients
    in row share mode nowait;
  lock table auth.account_roles, identity.sealed_demo_members, identity.sealed_qa_members
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0201: auth.role_permissions, auth.permissions, audit.events or a table 0201''s rows check or '
          || 'count (the roles, accounts, staff memberships, organizations, facilities, patients, role assignments '
          || 'and sealed member lists) is busy, and this transaction already holds an earlier migration''s locks, so '
          || 'it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0201: auth.role_permissions, auth.permissions, audit.events or a table 0201''s rows check or '
          || 'count (the roles, accounts, staff memberships, organizations, facilities, patients, role assignments '
          || 'and sealed member lists) stayed busy for 5 seconds; nothing applied; run the release again at a '
          || 'quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if (select count(*) from auth.permissions where code = any (v_codes) and active) = 3
     and (select count(*) from auth.permissions where code like 'workforce.roster.%' or code like 'workforce.leave.%') = 3
     and (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                            order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
            from auth.role_permissions grant_row
           where grant_row.permission_code like 'workforce.roster.%' or grant_row.permission_code like 'workforce.leave.%')
         is not distinct from v_rows_expected
     and (select count(*) from audit.events event_row where event_row.correlation_id = v_correlation) = 18 then
    raise exception using errcode = '55000', message = '0201: already applied';
  end if;
  if exists (select 1 from auth.permissions where code like 'workforce.roster.%' or code like 'workforce.leave.%')
     or exists (select 1 from auth.role_permissions
                 where permission_code like 'workforce.roster.%' or permission_code like 'workforce.leave.%')
     or exists (select 1 from audit.events event_row where event_row.correlation_id = v_correlation) then
    raise exception using errcode = '55000',
      message = '0201: the role table is not in the reviewed state (a duty roster or leave code or row is there, '
        || 'but not exactly what 0201 leaves); nothing applied';
  end if;

  select string_agg(code, ', ' order by code) into v_missing
    from (values ('receptionist'), ('nurse'), ('clinician'), ('doctor'), ('lab'), ('pharmacist'), ('admin'),
                 ('org_admin')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if v_missing is not null then
    raise exception using errcode = '55000', message = '0201: role missing or inactive: ' || v_missing;
  end if;
  if to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)'))
        is distinct from v_permission_check_md5 then
    raise exception using errcode = '55000',
      message = '0201: auth.membership_has_permission is not as 0001-0153 leave it; nothing applied';
  end if;
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure('identity.sealed_demo_facility(uuid)'))
       is distinct from 'd91d91c1d3e1a455e49c5960f313a6e7'
     or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure('identity.sealed_qa_facility(uuid)'))
       is distinct from 'fe9846d94cd744bf37c3f72053d9931f' then
    raise exception using errcode = '55000',
      message = '0201: the sealed demo or QA facility check is not as 0098 and 0123 leave it; nothing applied';
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into v_rows_before from auth.role_permissions grant_row;

  -- 2. F1. The three codes.
  insert into auth.permissions (code, description) values
    ('workforce.roster.read', 'See this facility''s published duty rosters, its department in-charges and who is on duty; a department in-charge named by the administrator also edits that department''s rosters and decides leave sent to it (ROS-1, 0201)'),
    ('workforce.roster.manage', 'Make and publish every department''s duty roster, name department in-charges and decide all leave at this facility (ROS-1, 0201)'),
    ('workforce.leave.request', 'Ask for leave at this facility and see one''s own leave requests (ROS-1, 0201)');

  -- F2. The eighteen rows (Q245 A, Q-ROS-8 A, Q-ROS-9 A).
  insert into auth.role_permissions (role_code, permission_code) values
    ('receptionist', 'workforce.roster.read'), ('receptionist', 'workforce.leave.request'),
    ('nurse', 'workforce.roster.read'), ('nurse', 'workforce.leave.request'),
    ('clinician', 'workforce.roster.read'), ('clinician', 'workforce.leave.request'),
    ('doctor', 'workforce.roster.read'), ('doctor', 'workforce.leave.request'),
    ('lab', 'workforce.roster.read'), ('lab', 'workforce.leave.request'),
    ('pharmacist', 'workforce.roster.read'), ('pharmacist', 'workforce.leave.request'),
    ('admin', 'workforce.roster.read'), ('admin', 'workforce.roster.manage'), ('admin', 'workforce.leave.request'),
    ('org_admin', 'workforce.roster.read'), ('org_admin', 'workforce.roster.manage'),
    ('org_admin', 'workforce.leave.request');

  -- F3. One audit row per role row, as the system actor.
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  )
  select v_correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', v_reason, 'migration',
         'hid-0201',
         jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0201', 'decision', 'Q245 A, Q-ROS-8 A (recommended option)')
    from auth.role_permissions grant_row
   where grant_row.permission_code = any (v_codes)
   order by grant_row.role_code collate "C", grant_row.permission_code collate "C";

  -- 3. Post-checks.
  select count(*) into v_audited from audit.events event_row where event_row.correlation_id = v_correlation;
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                        order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row
       where grant_row.permission_code like 'workforce.roster.%' or grant_row.permission_code like 'workforce.leave.%')
     is distinct from v_rows_expected
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                           ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
           from auth.role_permissions grant_row where not grant_row.permission_code = any (v_codes))
        is distinct from v_rows_before
     or (select count(*) from auth.permissions where code = any (v_codes) and active) <> 3
     or v_audited <> 18 then
    raise exception using errcode = '55000', message = '0201: post-check failed';
  end if;

  -- What the rows give, at real (not sealed) facilities: the active memberships that gain each code.
  select count(distinct membership.id) filter (where grant_row.permission_code = 'workforce.roster.read'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'workforce.roster.manage'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'workforce.leave.request')
    into v_read_gain, v_manage_gain, v_leave_gain
    from identity.staff_facility_memberships membership
    join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
    join auth.role_permissions grant_row on grant_row.role_code = assignment.role_code
   where membership.active and membership.facility_id is not null
     and grant_row.permission_code = any (v_codes)
     and not identity.sealed_demo_facility(membership.facility_id)
     and not identity.sealed_qa_facility(membership.facility_id);
  raise notice '0201: the duty roster and leave codes are given (Q245 A, Q-ROS-8 A): at real facilities workforce.roster.read is now held by % active staff memberships, workforce.roster.manage by %, workforce.leave.request by %; eighteen role rows, eighteen audit rows.',
    v_read_gain, v_manage_gain, v_leave_gain;
end
$hr0201$;
