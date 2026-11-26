-- 0204 REP-1 Provider reports, operations figures first: who reads reports
-- (Release D, the department sprint the owner approved on 25 November 2026).
-- Written on staging-novu-ci-20261005 at 0cfddcc9 (0001-0153 applied) with
-- 0203. The number is provisional: numbers are given at integration, in
-- release order, after the files booked before it. It reads nothing
-- 0154-0202 create or change: it pins no role's whole code list, only that
-- no report code exists yet and that every other row of the role table is
-- the same after it as before, so the codes and roles other lanes add (for
-- example BILL-1's cashier and billing_officer, 0162) are accepted. The
-- declaration in config/production-schema-compatibility.json stays unsigned
-- until the owner signs this file. It is its own file so Rahman can review
-- who reads reports apart from the tables, and so it can be signed after
-- 0203 if the role table changes (for example for the doctor leads, an open
-- point of the contract).
--
-- Decision (owner decision Q240 A, 25 November 2026; docs/EHR_PLANNED_CONTRACT.md
-- REP-1, Roles and access codes): new codes reports.read and reports.export,
-- given to the facility's administrators, admin and org_admin (the design's
-- Hospital Owner and Hospital Admin). Not given: org_admin_awaiting_review (a
-- self-signed-up facility before support's review), doctor, clinician, nurse,
-- receptionist, lab, pharmacist, the narrow roles, and BILL-1's cashier and
-- billing_officer (finance figures come with REP-2). The design's Medical
-- Director and Records Officer have no backend role (Q155 A), so nothing is
-- given for them.
--
-- What it changes (nothing else):
-- G1 auth.permissions          two codes: reports.read (see this facility's
--                              operations reports: totals only, no patient)
--                              and reports.export (download them with small
--                              counts hidden; each download is recorded).
-- G2 auth.role_permissions     four rows: admin and org_admin, each with
--                              both codes.
-- G3 audit.events              one row per role row added, as the system actor
--                              (no account, membership, facility or patient):
--                              auth.role-permission.add, resource
--                              role-permission "<role>/<code>", reason "REP-1
--                              Provider reports, operations figures (Release
--                              D, owner decision Q240 A)".
-- No function, policy, grant or table changes, so runtime-grants.sql is
-- unchanged by this file. Permissions are read from these tables on every
-- request (auth.membership_has_permission and the Identity staff context), so
-- the change applies from each signed-in member's next request; nobody is
-- signed out. ehr-api's REPORTS_ENABLED and REPORTS_EXPORT_ENABLED still keep
-- both report routes closed at real facilities until the clinical lead's and
-- Ola's sign-off of the figures, the DPO's review of downloads and the
-- owner's go-live.
-- The closing NOTICE prints how many active memberships at real (not sealed)
-- facilities gain each code.
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
-- identity.sealed_qa_members (the closing count, which calls
-- identity.sealed_demo_facility and identity.sealed_qa_facility). A busy table
-- fails the attempt at once, and its subtransaction releases every lock the
-- attempt took. The attempt is made 50 times, 100 ms apart (about 5 seconds),
-- so the file never waits for one of its locks while holding the others; then
-- 55P03 (nothing applied). When this transaction already holds an earlier
-- migration's locks that stop other sessions' reads or writes (the runner's
-- dry run applies every pending file in one transaction), one attempt and no
-- sleep: 55P03 at once, nothing applied. Both refusals begin "0204: " and end
-- "run the release again at a quieter time", so the runner's dry run rolls
-- back and tries again (#306). Other waits are not NOWAIT, and the runner's
-- lock_timeout ends each after 5 seconds (nothing applied): a row of
-- auth.roles that another session holds FOR UPDATE, or DDL in flight on
-- audit.events' identity sequence.
--
-- Undo (not in the ledger; a migration only if the owner signs it): take the
-- four rows out of auth.role_permissions (or mark the two codes inactive).
-- Every member is back where 0203 left them (no report) from the next
-- request.
--
-- The whole file is one statement (do $rep0204$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0203 applied (its two report
--    functions and its marker); "0204: already applied" when the two codes,
--    named exactly, are active and exactly the four rows hold them; "0204: the
--    role table is not in the reviewed state" when either code or a row of
--    either is there otherwise; admin and org_admin exist and are active;
--    auth.membership_has_permission, which every service's permission check
--    and both report functions call, is as 0001-0153 leave it (md5 pinned, so
--    it still reads the role's rows on every request).
-- 2. G1-G3.
-- 3. Post-checks: the rows of the two codes are exactly the four; every other
--    row of the role table is unchanged (compared row by row with the table
--    before step 2); the two codes active; exactly four audit rows of this
--    file.

do $rep0204$
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
  v_reason constant text := 'REP-1 Provider reports, operations figures (Release D, owner decision Q240 A)';
  v_correlation constant text := '0204-facility-reports-rep1';
  v_codes constant text[] := array['reports.read', 'reports.export'];
  -- The four rows, in byte order (role, then code), joined by ','.
  v_rows_expected constant text :=
    'admin reports.export,admin reports.read,org_admin reports.export,org_admin reports.read';
  -- auth.membership_has_permission(text,uuid,uuid,text) as 0001-0153 leave it.
  v_permission_check_md5 constant text := '65e3eaff93fe729fd5c5b986b80c9dd6';
  v_rows_before text;
  v_audited integer;
  v_read_gain integer;
  v_export_gain integer;
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
        message = '0204: auth.role_permissions, auth.permissions, audit.events or a table 0204''s rows check or '
          || 'count (the roles, accounts, staff memberships, organizations, facilities, patients, role assignments '
          || 'and sealed member lists) is busy, and this transaction already holds an earlier migration''s locks, so '
          || 'it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0204: auth.role_permissions, auth.permissions, audit.events or a table 0204''s rows check or '
          || 'count (the roles, accounts, staff memberships, organizations, facilities, patients, role assignments '
          || 'and sealed member lists) stayed busy for 5 seconds; nothing applied; run the release again at a '
          || 'quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regprocedure('ehr.facility_report_operations(date,date,boolean)') is null
     or to_regprocedure('ehr.facility_report_operations_export(date,date,text,boolean)') is null
     or to_regprocedure('ehr.facility_report_operations_figures(uuid,date,date,boolean)') is null
     or to_regprocedure('ehr.report_scan_open()') is null
     or to_regclass('ehr.report_scans') is null then
    raise exception using errcode = '55000', message = '0204: 0203 must be applied first';
  end if;

  if (select count(*) from auth.permissions where code = any (v_codes) and active) = 2
     and (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                            order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
            from auth.role_permissions grant_row where grant_row.permission_code = any (v_codes))
         is not distinct from v_rows_expected then
    raise exception using errcode = '55000', message = '0204: already applied';
  end if;
  if exists (select 1 from auth.permissions where code = any (v_codes))
     or exists (select 1 from auth.role_permissions where permission_code = any (v_codes)) then
    raise exception using errcode = '55000',
      message = '0204: the role table is not in the reviewed state (a report code or row is there, but not exactly '
        || 'what 0204 leaves); nothing applied';
  end if;

  select string_agg(code, ', ' order by code) into v_missing
    from (values ('admin'), ('org_admin')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if v_missing is not null then
    raise exception using errcode = '55000', message = '0204: role missing or inactive: ' || v_missing;
  end if;
  if to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)'))
        is distinct from v_permission_check_md5 then
    raise exception using errcode = '55000',
      message = '0204: auth.membership_has_permission is not as 0001-0153 leave it; nothing applied';
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into v_rows_before from auth.role_permissions grant_row;

  -- 2. G1. The two codes.
  insert into auth.permissions (code, description) values
    ('reports.read', 'See this facility''s operations reports: totals only, no patient (REP-1, 0204)'),
    ('reports.export', 'Download this facility''s operations reports with small counts hidden; each download is recorded (REP-1, 0204)');

  -- G2. The four rows (Q240 A).
  insert into auth.role_permissions (role_code, permission_code) values
    ('admin', 'reports.read'), ('admin', 'reports.export'),
    ('org_admin', 'reports.read'), ('org_admin', 'reports.export');

  -- G3. One audit row per role row, as the system actor.
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  )
  select v_correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', v_reason, 'migration',
         'hid-0204',
         jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0204', 'decision', 'Q240 A (owner decision, 25 November 2026)')
    from auth.role_permissions grant_row
   where grant_row.permission_code = any (v_codes)
   order by grant_row.role_code collate "C", grant_row.permission_code collate "C";

  -- 3. Post-checks.
  select count(*) into v_audited from audit.events event_row where event_row.correlation_id = v_correlation;
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                        order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row where grant_row.permission_code = any (v_codes))
     is distinct from v_rows_expected
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                           ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
           from auth.role_permissions grant_row where grant_row.permission_code <> all (v_codes))
        is distinct from v_rows_before
     or (select count(*) from auth.permissions where code = any (v_codes) and active) <> 2
     or v_audited <> 4 then
    raise exception using errcode = '55000', message = '0204: post-check failed';
  end if;

  -- What the rows give, at real (not sealed) facilities: the active memberships that gain each code.
  select count(distinct membership.id) filter (where grant_row.permission_code = 'reports.read'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'reports.export')
    into v_read_gain, v_export_gain
    from identity.staff_facility_memberships membership
    join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
    join auth.role_permissions grant_row on grant_row.role_code = assignment.role_code
   where membership.active and membership.facility_id is not null
     and grant_row.permission_code = any (v_codes)
     and not identity.sealed_demo_facility(membership.facility_id)
     and not identity.sealed_qa_facility(membership.facility_id);
  raise notice '0204: the report codes are given (Q240 A): at real facilities reports.read is now held by % active staff memberships and reports.export by %; four role rows, four audit rows. ehr-api''s REPORTS_ENABLED and REPORTS_EXPORT_ENABLED keep the routes closed at real facilities until go-live.',
    v_read_gain, v_export_gain;
end
$rep0204$;
