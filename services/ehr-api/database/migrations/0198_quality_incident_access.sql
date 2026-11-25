-- 0198 QUAL-1 Quality and safety reporting: who reports and who manages
-- (Release D, the department sprint the owner approved on 25 November 2026).
-- Written on staging-novu-ci-20261005 at 0cfddcc9 (0001-0153 applied) with
-- 0197. The number is provisional: numbers are given at merge, in release
-- order, after the files booked before it. It reads nothing 0152-0196 create
-- or change: it pins no role's whole code list, only that no quality code
-- exists yet and that every other row of the role table is the same after it
-- as before. The declaration in config/production-schema-compatibility.json
-- stays unsigned until the owner signs this file. It is its own file so
-- Rahman can review who gets the codes apart from the tables, and it can be
-- signed after 0197 if the role table changes.
--
-- Owner decisions (approved with the whole sheet on 25 November 2026,
-- hid-system#332): Q248 A (every staff member reports, named but
-- confidential) and Q251 A (quality.incident.manage for the facility
-- administrator roles, plus named quality leads; doctors no longer manage as
-- the design had it). Q155 A: no new role. A named quality lead is a row of
-- 0197's ehr.quality_leads (Q-QUAL-1 A, recommended option, not yet answered
-- by the owner), not a code or a role, so this file gives leads nothing.
--
-- What it changes (nothing else):
-- R1 auth.permissions          two codes: quality.incident.report (report an
--                              incident or near miss at this facility and
--                              follow one's own reports) and
--                              quality.incident.manage (see and manage every
--                              incident report of this facility, and name its
--                              quality leads).
-- R2 auth.role_permissions     quality.incident.report for receptionist,
--                              nurse, clinician, doctor, lab, pharmacist,
--                              admin and org_admin, and for every other active
--                              role that identity.staff_invitable_roles(
--                              'hospital', 'ehr') lists when this file runs
--                              (BILL-1's cashier and billing_officer when 0162
--                              applied first, and any staff role a department
--                              file cut before it adds); never the narrow
--                              roles (work_list_reader, reading_starter),
--                              platform, review, support, audit, outreach or
--                              scanner roles, or org_admin_awaiting_review.
--                              quality.incident.manage for admin and org_admin
--                              only. 10 rows on staging today (12 with
--                              BILL-1). The quality functions need nothing
--                              else from a role.
-- R3 audit.events              one row per code (auth.permission.add,
--                              resource permission "<code>") and one per role
--                              row (auth.role-permission.add, resource
--                              role-permission "<role>/<code>"), as the system
--                              actor (no account, membership, facility or
--                              patient), reason "QUAL-1 Quality and safety
--                              reporting (Release D, owner decisions Q248 A and
--                              Q251 A)"; details hold the codes, the migration
--                              and the decision, never a name.
-- No function, policy, grant or table changes, so runtime-grants.sql is
-- unchanged by this file. Permissions are read from these tables on every
-- request (auth.membership_has_permission and the Identity staff context), so
-- the change applies from each signed-in member's next request; nobody is
-- signed out. ehr-api's flag QUALITY_INCIDENTS_ENABLED still keeps every route
-- closed in production until the owner's go-live.
-- A staff role added by a file that applies after this one must add
-- quality.incident.report for itself (the release checklist carries this
-- rule). services/identity-api/test/role-matrix.json and the SX-1 area
-- quality change in the same pull request.
-- The closing NOTICE prints which roles got quality.incident.report, and how
-- many active memberships at real (not sealed) facilities gain each code.
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
-- identity.sealed_qa_members (the closing count calls the seal functions). A
-- busy table fails the attempt at once, and its subtransaction releases every
-- lock the attempt took. The attempt is made 50 times, 100 ms apart (about 5
-- seconds), so the file never waits for one of its locks while holding the
-- others; then 55P03 (nothing applied). When this transaction already holds
-- an earlier migration's locks that stop other sessions' reads or writes (the
-- runner's dry run applies every pending file in one transaction), one
-- attempt and no sleep: 55P03 at once, nothing applied. Both refusals begin
-- "0198: " and end "run the release again at a quieter time", so the
-- runner's dry run rolls back and tries again (#306). Other waits are not
-- NOWAIT, and the runner's lock_timeout ends each after 5 seconds (nothing
-- applied): a row of auth.roles that another session holds FOR UPDATE, or DDL
-- in flight on audit.events' identity sequence.
--
-- Undo (not in the ledger; a migration only if the owner signs it): take the
-- quality rows out of auth.role_permissions (or mark the two codes inactive).
-- Every member is back where 0197 left them (every quality function refuses)
-- from the next request.
--
-- The whole file is one statement (do $quality0198$), so whatever raises in
-- it, however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0197 applied (its tables and its
--    fifteen functions); "0198: already applied" when the two codes are there
--    and the quality rows are exactly the set above as computed now, "0198:
--    the role table is not in the reviewed state" for any other quality code
--    or row; the eight named roles exist and are active;
--    auth.membership_has_permission, which every service's permission check
--    calls, is as 0001-0153 leave it (md5 pinned, so it still reads the role's
--    rows on every request).
-- 2. R1-R3.
-- 3. Post-checks: the quality rows are exactly that set; every other row of
--    the role table is unchanged (compared row by row with the table before
--    step 2); exactly one audit row of this file per code and per role row.

do $quality0198$
declare
  v_attempt integer := 0;
  v_holding boolean := exists (
    select 1 from pg_catalog.pg_locks held
      join pg_catalog.pg_class relation on relation.oid = held.relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_catalog.pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_catalog.pg_database database_row
                             where database_row.datname = pg_catalog.current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  v_missing text;
  v_reason constant text := 'QUAL-1 Quality and safety reporting (Release D, owner decisions Q248 A and Q251 A)';
  v_correlation constant text := '0198-quality-incident-access-qual1';
  -- The roles named by the owner's decisions (Q248 A: every staff member reports; Q251 A: the administrator roles
  -- manage).
  v_named constant text[] := array['receptionist', 'nurse', 'clinician', 'doctor', 'lab', 'pharmacist', 'admin',
    'org_admin'];
  -- Roles that never get a quality code, whatever the invitable list says.
  v_never constant text[] := array['org_admin_awaiting_review', 'work_list_reader', 'reading_starter',
    'document_scanner', 'ocr_worker', 'outreach_organiser', 'outreach_volunteer', 'facility_review_admin',
    'identity_review_admin', 'security_auditor', 'support_admin'];
  -- auth.membership_has_permission(text,uuid,uuid,text) as 0001-0153 leave it.
  v_permission_check_md5 constant text := '65e3eaff93fe729fd5c5b986b80c9dd6';
  v_extra text[];
  v_rows_expected text;
  v_row_count integer;
  v_rows_before text;
  v_audited integer;
  v_report_gain integer;
  v_manage_gain integer;
  v_report_roles text;
begin
  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
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
        message = '0198: auth.role_permissions, auth.permissions, audit.events or a table 0198''s rows check or '
          || 'count (the roles, accounts, staff memberships, organizations, facilities, patients, role assignments '
          || 'and sealed member lists) is busy, and this transaction already holds an earlier migration''s locks, so '
          || 'it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0198: auth.role_permissions, auth.permissions, audit.events or a table 0198''s rows check or '
          || 'count (the roles, accounts, staff memberships, organizations, facilities, patients, role assignments '
          || 'and sealed member lists) stayed busy for 5 seconds; nothing applied; run the release again at a '
          || 'quieter time';
    end if;
    perform pg_catalog.pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if pg_catalog.to_regclass('ehr.quality_incidents') is null
     or pg_catalog.to_regclass('ehr.quality_leads') is null
     or pg_catalog.to_regclass('ehr.quality_incident_events') is null
     or pg_catalog.to_regprocedure('ehr.quality_caller(text)') is null
     or pg_catalog.to_regprocedure('ehr.quality_me()') is null
     or pg_catalog.to_regprocedure('ehr.quality_lead_end(uuid,text,text,text)') is null then
    raise exception using errcode = '55000', message = '0198: 0197 must be applied first';
  end if;

  -- The roles that get quality.incident.report beyond the eight named: every other active role a hospital can
  -- invite for the EHR now (tolerant of other lanes' staff roles, such as BILL-1's cashier and billing_officer).
  select coalesce(array_agg(distinct invitable.role_code order by invitable.role_code), array[]::text[])
    into v_extra
    from pg_catalog.unnest(identity.staff_invitable_roles('hospital', 'ehr')) invitable(role_code)
    join auth.roles role_row on role_row.code = invitable.role_code and role_row.active
   where not invitable.role_code = any (v_named) and not invitable.role_code = any (v_never)
     and invitable.role_code not like 'platform\_%';
  -- The quality rows, in byte order (role, then code), joined by ','.
  select string_agg(wanted.role_code || ' ' || wanted.permission_code, ','
                    order by wanted.role_code collate "C", wanted.permission_code collate "C"), count(*)
    into v_rows_expected, v_row_count
    from (select named.role_code, 'quality.incident.report' as permission_code
            from pg_catalog.unnest(v_named || v_extra) named(role_code)
          union all
          select manager.role_code, 'quality.incident.manage'
            from pg_catalog.unnest(array['admin', 'org_admin']) manager(role_code)) wanted;

  if (select count(*) from auth.permissions
       where code in ('quality.incident.report', 'quality.incident.manage') and active) = 2
     and (select count(*) from auth.permissions where code like 'quality.%') = 2
     and (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                            order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
            from auth.role_permissions grant_row where grant_row.permission_code like 'quality.%')
         is not distinct from v_rows_expected then
    raise exception using errcode = '55000', message = '0198: already applied';
  end if;
  if exists (select 1 from auth.permissions where code like 'quality.%')
     or exists (select 1 from auth.role_permissions where permission_code like 'quality.%') then
    raise exception using errcode = '55000',
      message = '0198: the role table is not in the reviewed state (a quality code or row is there, but not '
        || 'exactly what 0198 leaves); nothing applied';
  end if;

  select string_agg(code, ', ' order by code) into v_missing
    from pg_catalog.unnest(v_named) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if v_missing is not null then
    raise exception using errcode = '55000', message = '0198: role missing or inactive: ' || v_missing;
  end if;
  if pg_catalog.to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or (select pg_catalog.md5(proc.prosrc) from pg_catalog.pg_proc proc
          where proc.oid = pg_catalog.to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)'))
        is distinct from v_permission_check_md5 then
    raise exception using errcode = '55000',
      message = '0198: auth.membership_has_permission is not as 0001-0153 leave it; nothing applied';
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into v_rows_before from auth.role_permissions grant_row;

  -- 2. R1. The two codes.
  insert into auth.permissions (code, description) values
    ('quality.incident.report', 'Report an incident or near miss at this facility and follow one''s own reports (QUAL-1, 0198)'),
    ('quality.incident.manage', 'See and manage every incident report of this facility, and name its quality leads (QUAL-1, 0198)');

  -- R2. The rows the owner's decisions name (Q248 A, Q251 A).
  insert into auth.role_permissions (role_code, permission_code) values
    ('receptionist', 'quality.incident.report'), ('nurse', 'quality.incident.report'),
    ('clinician', 'quality.incident.report'), ('doctor', 'quality.incident.report'),
    ('lab', 'quality.incident.report'), ('pharmacist', 'quality.incident.report'),
    ('admin', 'quality.incident.report'), ('org_admin', 'quality.incident.report'),
    ('admin', 'quality.incident.manage'), ('org_admin', 'quality.incident.manage');
  -- And every other staff role a hospital can invite now (none on staging today; BILL-1's two when 0162 applied
  -- first).
  insert into auth.role_permissions (role_code, permission_code)
  select extra_role.role_code, 'quality.incident.report'
    from pg_catalog.unnest(v_extra) extra_role(role_code)
   order by extra_role.role_code;

  -- R3. One audit row per code and per role row, as the system actor.
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  )
  select v_correlation, 'system', 'auth.permission.add', 'success', 'permission', permission_row.code,
         'healthcare-operations', v_reason, 'migration', 'hid-0198',
         pg_catalog.jsonb_build_object('permissionCode', permission_row.code, 'migration', '0198',
           'decision', 'Q248 A, Q251 A (owner, 25 November 2026)')
    from auth.permissions permission_row
   where permission_row.code like 'quality.%'
   order by permission_row.code collate "C";
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  )
  select v_correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', v_reason, 'migration',
         'hid-0198',
         pg_catalog.jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0198', 'decision', 'Q248 A, Q251 A (owner, 25 November 2026)')
    from auth.role_permissions grant_row
   where grant_row.permission_code like 'quality.%'
   order by grant_row.role_code collate "C", grant_row.permission_code collate "C";

  -- 3. Post-checks.
  select count(*) into v_audited from audit.events event_row where event_row.correlation_id = v_correlation;
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                        order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row where grant_row.permission_code like 'quality.%')
     is distinct from v_rows_expected
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                           ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
           from auth.role_permissions grant_row where grant_row.permission_code not like 'quality.%')
        is distinct from v_rows_before
     or (select count(*) from auth.permissions where code like 'quality.%' and active) <> 2
     or v_audited <> 2 + v_row_count then
    raise exception using errcode = '55000', message = '0198: post-check failed';
  end if;

  -- What the rows give, at real (not sealed) facilities: the active memberships that gain each code.
  select count(distinct membership.id) filter (where grant_row.permission_code = 'quality.incident.report'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'quality.incident.manage')
    into v_report_gain, v_manage_gain
    from identity.staff_facility_memberships membership
    join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
    join auth.role_permissions grant_row on grant_row.role_code = assignment.role_code
   where membership.active and membership.facility_id is not null
     and grant_row.permission_code like 'quality.%'
     and not identity.sealed_demo_facility(membership.facility_id)
     and not identity.sealed_qa_facility(membership.facility_id);
  select string_agg(grant_row.role_code, ', ' order by grant_row.role_code collate "C") into v_report_roles
    from auth.role_permissions grant_row where grant_row.permission_code = 'quality.incident.report';
  raise notice '0198: quality and safety reporting codes are given (Q248 A, Q251 A): quality.incident.report to %; quality.incident.manage to admin, org_admin. At real facilities quality.incident.report is now held by % active staff memberships, quality.incident.manage by %; % role rows, % audit rows.',
    v_report_roles, v_report_gain, v_manage_gain, v_row_count, v_audited;
end
$quality0198$;
