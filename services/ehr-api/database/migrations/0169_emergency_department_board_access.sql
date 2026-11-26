-- 0169 ED-1 Emergency department board: who uses it (Release D, the
-- department sprint the owner approved on 25 November 2026). Written on
-- staging-novu-ci-20261005 at 95fa1e52 (0001-0151 applied) with 0168. The
-- number is provisional: numbers are given at merge, after the files booked
-- before it (0152-0153 ORD-9, 0154 ORD-12 refills, APPT-1's 0160-0161 and any
-- department file cut earlier). It reads nothing 0152-0167 create or change:
-- it pins no role's whole code list, only that no ED code exists yet and that
-- every other row of the role table is the same after it as before. The
-- declaration in config/production-schema-compatibility.json stays unsigned
-- until the owner signs this file. It is its own file so Rahman can review who
-- gets the board apart from the tables, and it can be signed after 0168 if the
-- role table changes.
--
-- Decision taken at the recommended option, not yet answered by the owner
-- (docs/EHR_PLANNED_CONTRACT.md, ED-1): Q-ED-2 A. The front desk puts patients
-- on the board and sees it (without the presenting complaint); nurses also
-- triage and move patients; clinicians and doctors also record where the
-- patient goes next. Hospital administrators, owners, lab and pharmacy staff
-- get no clinical board. With Q-ED-2 B (the design's mapping: doctors only)
-- the receptionist, nurse and clinician rows below are left out.
--
-- What it changes (nothing else):
-- F1 auth.permissions          four codes: ehr.ed.read (see the board),
--                              ehr.ed.arrive (put a patient on it, cancel an
--                              arrival made in error), ehr.ed.triage (triage,
--                              the complaint, move, start care, link the visit,
--                              "Left the department"), ehr.ed.disposition
--                              (record where the patient goes next).
-- F2 auth.role_permissions     thirteen rows:
--                                receptionist  read, arrive
--                                nurse         read, arrive, triage
--                                clinician     read, arrive, triage, disposition
--                                doctor        read, arrive, triage, disposition
--                              Every ED function also needs 0135's pair
--                              ehr.encounter.read and ehr.encounter.write,
--                              which all four roles already hold.
-- F3 audit.events              one row per role row added, as the system actor
--                              (no account, membership, facility or patient):
--                              auth.role-permission.add, resource
--                              role-permission "<role>/<code>", reason "ED-1
--                              Emergency department board (Release D,
--                              recommended Q-ED-2 A)".
-- No function, policy, grant or table changes, so runtime-grants.sql is
-- unchanged by this file. Permissions are read from these tables on every
-- request (auth.membership_has_permission and the Identity staff context), so
-- the change applies from each signed-in member's next request; nobody is
-- signed out. ehr-api's flag ED_BOARD_ENABLED still keeps every route closed
-- in production until the owner's go-live.
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
-- identity.sealed_qa_members (the closing count). A busy table fails the
-- attempt at once, and its subtransaction releases every lock the attempt
-- took. The attempt is made 50 times, 100 ms apart (about 5 seconds), so the
-- file never waits for one of its locks while holding the others; then 55P03
-- (nothing applied). When this transaction already holds an earlier
-- migration's locks that stop other sessions' reads or writes (the runner's
-- dry run applies every pending file in one transaction), one attempt and no
-- sleep: 55P03 at once, nothing applied. Both refusals begin "0169: " and end
-- "run the release again at a quieter time", so the runner's dry run rolls
-- back and tries again (#306). Other waits are not NOWAIT, and the runner's
-- lock_timeout ends each after 5 seconds (nothing applied): a row of
-- auth.roles that another session holds FOR UPDATE, or DDL in flight on
-- audit.events' identity sequence.
--
-- Undo (not in the ledger; a migration only if the owner signs it): take the
-- thirteen rows out of auth.role_permissions (or mark the four codes
-- inactive). Every member is back where 0168 left them (no board) from the
-- next request.
--
-- The whole file is one statement (do $ed0169$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0168 applied (its tables and its
--    functions); "0169: already applied" when the four codes and exactly the
--    thirteen rows are there, "0169: the role table is not in the reviewed
--    state" when any ED code or row is there otherwise; the four roles exist
--    and are active; 0135's pair exists and each of the four roles holds it;
--    auth.membership_has_permission, which every service's permission check
--    calls, is as 0001-0151 leave it (md5 pinned, so it still reads the role's
--    rows on every request).
-- 2. F1-F3.
-- 3. Post-checks: the ED rows are exactly the thirteen; every other row of the
--    role table is unchanged (compared row by row with the table before step
--    2); exactly thirteen audit rows of this file.

do $ed0169$
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
  v_reason constant text := 'ED-1 Emergency department board (Release D, recommended Q-ED-2 A)';
  v_correlation constant text := '0169-emergency-board-ed1';
  -- The thirteen rows, in byte order (role, then code), joined by ','.
  v_rows_expected constant text := 'clinician ehr.ed.arrive,clinician ehr.ed.disposition,clinician ehr.ed.read,'
    || 'clinician ehr.ed.triage,doctor ehr.ed.arrive,doctor ehr.ed.disposition,doctor ehr.ed.read,'
    || 'doctor ehr.ed.triage,nurse ehr.ed.arrive,nurse ehr.ed.read,nurse ehr.ed.triage,'
    || 'receptionist ehr.ed.arrive,receptionist ehr.ed.read';
  -- auth.membership_has_permission(text,uuid,uuid,text) as 0001-0151 leave it.
  v_permission_check_md5 constant text := '65e3eaff93fe729fd5c5b986b80c9dd6';
  v_rows_before text;
  v_audited integer;
  v_read_gain integer;
  v_arrive_gain integer;
  v_triage_gain integer;
  v_disposition_gain integer;
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
        message = '0169: auth.role_permissions, auth.permissions, audit.events or a table 0169''s rows check or '
          || 'count (the roles, accounts, staff memberships, organizations, facilities, patients, role assignments '
          || 'and sealed member lists) is busy, and this transaction already holds an earlier migration''s locks, so '
          || 'it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0169: auth.role_permissions, auth.permissions, audit.events or a table 0169''s rows check or '
          || 'count (the roles, accounts, staff memberships, organizations, facilities, patients, role assignments '
          || 'and sealed member lists) stayed busy for 5 seconds; nothing applied; run the release again at a '
          || 'quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regclass('ehr.ed_attendances') is null or to_regclass('ehr.ed_attendance_events') is null
     or to_regprocedure('ehr.ed_arrive(text, uuid, text, timestamptz, smallint, text, text, text)') is null
     or to_regprocedure('ehr.ed_record_disposition(uuid, bigint, text, text, uuid, text, text, text, text)') is null
     or to_regprocedure('ehr.visit_queue_ed_close_mirror()') is null then
    raise exception using errcode = '55000', message = '0169: 0168 must be applied first';
  end if;

  if (select count(*) from auth.permissions
       where code in ('ehr.ed.read', 'ehr.ed.arrive', 'ehr.ed.triage', 'ehr.ed.disposition') and active) = 4
     and (select count(*) from auth.permissions where code like 'ehr.ed.%') = 4
     and (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                            order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
            from auth.role_permissions grant_row where grant_row.permission_code like 'ehr.ed.%')
         is not distinct from v_rows_expected then
    raise exception using errcode = '55000', message = '0169: already applied';
  end if;
  if exists (select 1 from auth.permissions where code like 'ehr.ed.%')
     or exists (select 1 from auth.role_permissions where permission_code like 'ehr.ed.%') then
    raise exception using errcode = '55000',
      message = '0169: the role table is not in the reviewed state (an emergency board code or row is there, '
        || 'but not exactly what 0169 leaves); nothing applied';
  end if;

  select string_agg(code, ', ' order by code) into v_missing
    from (values ('receptionist'), ('nurse'), ('clinician'), ('doctor')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if v_missing is not null then
    raise exception using errcode = '55000', message = '0169: role missing or inactive: ' || v_missing;
  end if;
  select string_agg(wanted.role_code || ' ' || wanted.permission_code, ', '
                    order by wanted.role_code, wanted.permission_code) into v_missing
    from (values ('receptionist'), ('nurse'), ('clinician'), ('doctor')) role_list(role_code)
    cross join lateral (values (role_list.role_code, 'ehr.encounter.read'), (role_list.role_code, 'ehr.encounter.write'))
      wanted(role_code, permission_code)
   where not exists (select 1 from auth.role_permissions grant_row
                      join auth.permissions permission_row on permission_row.code = grant_row.permission_code
                     where grant_row.role_code = wanted.role_code and grant_row.permission_code = wanted.permission_code
                       and permission_row.active);
  if v_missing is not null then
    raise exception using errcode = '55000',
      message = '0169: these roles do not hold 0135''s pair (every ED function needs it): ' || v_missing;
  end if;
  if to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)'))
        is distinct from v_permission_check_md5 then
    raise exception using errcode = '55000',
      message = '0169: auth.membership_has_permission is not as 0001-0151 leave it; nothing applied';
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into v_rows_before from auth.role_permissions grant_row;

  -- 2. F1. The four codes.
  insert into auth.permissions (code, description) values
    ('ehr.ed.read', 'See this facility''s emergency department board (ED-1, 0169)'),
    ('ehr.ed.arrive', 'Put patients on this facility''s emergency department board, and cancel an arrival made in error (ED-1, 0169)'),
    ('ehr.ed.triage', 'Triage, record the presenting complaint, move patients, link the visit and record that a patient left, on the emergency department board (ED-1, 0169)'),
    ('ehr.ed.disposition', 'Record where an emergency department patient goes next (ED-1, 0169)');

  -- F2. The thirteen rows (Q-ED-2 A).
  insert into auth.role_permissions (role_code, permission_code) values
    ('receptionist', 'ehr.ed.read'), ('receptionist', 'ehr.ed.arrive'),
    ('nurse', 'ehr.ed.read'), ('nurse', 'ehr.ed.arrive'), ('nurse', 'ehr.ed.triage'),
    ('clinician', 'ehr.ed.read'), ('clinician', 'ehr.ed.arrive'), ('clinician', 'ehr.ed.triage'),
    ('clinician', 'ehr.ed.disposition'),
    ('doctor', 'ehr.ed.read'), ('doctor', 'ehr.ed.arrive'), ('doctor', 'ehr.ed.triage'),
    ('doctor', 'ehr.ed.disposition');

  -- F3. One audit row per role row, as the system actor.
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  )
  select v_correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', v_reason, 'migration',
         'hid-0169',
         jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0169', 'decision', 'Q-ED-2 A (recommended option)')
    from auth.role_permissions grant_row
   where grant_row.permission_code like 'ehr.ed.%'
   order by grant_row.role_code collate "C", grant_row.permission_code collate "C";

  -- 3. Post-checks.
  select count(*) into v_audited from audit.events event_row where event_row.correlation_id = v_correlation;
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                        order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row where grant_row.permission_code like 'ehr.ed.%')
     is distinct from v_rows_expected
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                           ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
           from auth.role_permissions grant_row where grant_row.permission_code not like 'ehr.ed.%')
        is distinct from v_rows_before
     or (select count(*) from auth.permissions where code like 'ehr.ed.%' and active) <> 4
     or v_audited <> 13 then
    raise exception using errcode = '55000', message = '0169: post-check failed';
  end if;

  -- What the rows give, at real (not sealed) facilities: the active memberships that gain each code.
  select count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.ed.read'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.ed.arrive'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.ed.triage'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.ed.disposition')
    into v_read_gain, v_arrive_gain, v_triage_gain, v_disposition_gain
    from identity.staff_facility_memberships membership
    join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
    join auth.role_permissions grant_row on grant_row.role_code = assignment.role_code
   where membership.active and membership.facility_id is not null
     and grant_row.permission_code like 'ehr.ed.%'
     and not identity.sealed_demo_facility(membership.facility_id)
     and not identity.sealed_qa_facility(membership.facility_id);
  raise notice '0169: the emergency department board codes are given (Q-ED-2 A): at real facilities ehr.ed.read is now held by % active staff memberships, ehr.ed.arrive by %, ehr.ed.triage by %, ehr.ed.disposition by %; thirteen role rows, thirteen audit rows.',
    v_read_gain, v_arrive_gain, v_triage_gain, v_disposition_gain;
end
$ed0169$;
