-- 0147 Q137 B: two narrow roles that give back what 0136 took, to exactly the
-- staff 0136 counted. Written on staging-novu-ci-20261005 at 926b1c58
-- (0001-0146 applied: Release A and Release B). Booked as 0147 on
-- hid-system#258 (the next free number after Release B). The declaration in
-- config/production-schema-compatibility.json is signed separately: its
-- reviewed_by stays as it is until the owner signs this file.
--
-- Owner decision (D-Eminence, relayed by the coordinator at 13:30 UTC on 23
-- November 2026, hid-system#258), verbatim:
--   "Q137 B: the restore gives access back only to the 9 admins and 1 doctor
--   the guard counted, through narrow roles. Q103 A and Q111 A hold for
--   everyone else."
-- 0136's dry run of 21 November 2026 counted, at real facilities: lines 19
-- and 20 (administrators lose lab.work-item.read and pharmacy.work-item.read)
-- 9, lines 13 and 14 (a doctor loses both) 1, line 21 (doctors who can start
-- a reading before 0136 and cannot after) 1 (Q134 B, 0136's header). The
-- owner accepted those losses for 0136 and, with Q137 B, gives exactly those
-- members back what 0136 took from them, and nobody else anything.
-- The stop at 0, 0 and 0 as well as 9, 1 and 1 is Rahman's amendment on
-- hid-system#258 (23 November 2026), for the owner to confirm at signing: a
-- fresh database (CI's rehearsal, npm run check:db, a restore, every lane's
-- suites) has none of the counted staff.
--
-- What it changes (nothing else):
--   auth.roles             two new roles:
--     work_list_reader     "Lab and pharmacy work lists": reads the
--                          laboratory's and the pharmacy's work lists
--                          (lab.work-item.read, pharmacy.work-item.read), what
--                          0136 took from administrators (C6) and doctors (C4);
--     reading_starter      "Start a paper reading": ocr.job.start, which 0136
--                          made starting a reading need and did not give
--                          doctors (Q111 A). A doctor holds ocr.job.write and
--                          ocr.job.read, so with it the doctor starts and
--                          retries readings again, exactly as before 0136.
--   auth.role_permissions  exactly those three rows. No row of any other role
--                          changes, so Q103 A and Q111 A hold for everyone
--                          else.
--   auth.account_roles     one row per counted membership and role (scope
--                          'facility', the membership, its facility and login;
--                          granted_by null, as the other migrations' grants;
--                          grant_reason "Owner decision Q137 B (23 November
--                          2026): access 0136 removed").
--   audit.events           one row per grant, in the form 0139's role add
--                          writes (identity.facility-staff.role-add, resource
--                          staff-membership, the membership, its role codes
--                          before and after), as the system actor (0136's
--                          close rows): the facility and the membership only,
--                          no name, account or organisation.
-- Neither role is a staff kind, a membership_role or app_role, or a role
-- anyone can invite (identity.staff_invitable_roles) or add or remove through
-- SX-4 (0139's role lists stay the five hospital roles; 0139 is not
-- replaced). They are only these extra assignment rows, and they end with
-- the membership, as every role does. One gap stays until a follow-up
-- replaces a 0139 function: 0139's remove counts every role held, so
-- removing doctor through SX-4 from the doctor given them is allowed, leaves
-- both narrow roles (and so the work lists), and moves the membership's
-- role columns to reading_starter (the first role left, alphabetically).
-- Until then, end that membership instead. No function, policy, grant or table
-- changes, so runtime-grants.sql is unchanged. Permissions are read on every
-- request (auth.membership_has_permission and the Identity staff context), so
-- a grant applies from the member's next request; nobody is signed out.
--
-- Who is counted (0136's own definitions, character for character where they
-- apply; see do $q137b$ below). At real facilities only (not the sealed demo
-- or QA tenants), through 0136's live_membership (membership active and not
-- held by the cutover, login active and not disabled, staff record active and
-- verified, facility and organisation active) and assignment (role not
-- revoked, role active):
--   work lists, administrators: each membership 0136's lines 19 or 20 would
--     count today: it holds admin through an assignment granted before 0136
--     was applied (migration.schema_migrations, 0136's applied_at) and still
--     not revoked, and no other role it holds grants that work list today;
--   work lists, doctors: the same for doctor, lines 13 or 14;
--   a membership in both counts gets one work_list_reader row;
--   reading start, doctors: each membership of line 21's rule: it holds
--     doctor through an assignment granted before 0136 was applied, could
--     start a reading under the role table before 0136 (ocr.job.write and
--     ocr.job.read through its roles) and cannot today (ocr.job.write,
--     ocr.job.start, and ocr.job.read or ocr.job.read-own). The table before
--     0136 is rebuilt from today's rows and 0136's own change list: today's
--     rows, less the rows 0136 added, plus the rows it removed (the
--     precondition checks those rows are as 0136 left them).
-- When 0136's row is not in migration.schema_migrations, 0136 is being
-- applied in this same transaction (the runner's dry run applies every
-- pending file in one transaction and records none): this transaction's
-- start stands for its applied_at, and a NOTICE says so.
--
-- The stop: 0147 applies only when the counts (administrators for the work
-- lists, doctors for the work lists, doctors for the reading start) are
-- exactly 9, 1 and 1 (production as 0136 counted it), or 0, 0 and 0 (a
-- database without those staff: it creates the two roles, grants them to
-- nobody, and its NOTICE says so). Any other counts raise 55000 "0147
-- stopped, nothing was changed: the counts are a, d and r, ...", numbers
-- only, and nothing is applied. This file holds no account, membership,
-- facility or person id.
--
-- Locks, taken first, NOWAIT: SHARE ROW EXCLUSIVE on auth.roles,
-- auth.role_permissions and auth.account_roles for the transaction (other
-- writers wait, for example a role added or removed through SX-4, an
-- invitation accepted or a membership ended; every reader goes on), so no
-- role or assignment changes between the count and the grants; ROW EXCLUSIVE
-- on audit.events; ROW SHARE on auth.permissions, auth.accounts,
-- identity.staff_facility_memberships and identity.facilities (the foreign
-- key checks of the new rows) and on identity.outreach_organisations and
-- identity.organization_applications (FOR SHARE in the two triggers of
-- auth.account_roles, 0115's outreach fence and 0086's review gate); and
-- ACCESS SHARE on the tables the count reads (identity.staff,
-- identity.organizations and the sealed demo and QA member lists) and on
-- migration.schema_migrations (0136's applied_at). That is every existing
-- table this file locks (pg_locks before commit, at 9, 1 and 1 and at 0, 0
-- and 0), at the strongest mode it takes. Besides tables it locks only
-- indexes, at ACCESS SHARE or ROW SHARE (planning and the foreign key
-- checks), and, when it writes an audit row, ROW EXCLUSIVE on audit.events'
-- identity sequence.
-- A busy table fails the attempt at once, and its subtransaction releases
-- what it took. The attempt is made again every 100 ms for at most 5 seconds,
-- so the file never waits while holding a lock and no request queues behind a
-- waiting lock; then 55P03 (nothing applied; the release can run again). When
-- this transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run applies every pending file
-- in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied, instead of keeping those locks while this file waits.
--
-- Undo (not in the ledger; a migration only if the owner signs it): mark both
-- roles inactive (update auth.roles set active = false where code in
-- ('work_list_reader', 'reading_starter')). auth.membership_has_permission and
-- the Identity staff context read only active roles, so every member is back
-- where 0136 left them from their next request; the rows stay for the record.
--
-- The whole file is one statement (do $q137b$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (55P03, nothing applied).
-- 1. Preconditions (each failure raises 55000 and nothing is applied):
--    0001-0146 applied (one marker of each of 0137-0146); neither role code
--    exists ("0147: already applied" when both do); admin and doctor exist
--    and are active; lab.work-item.read, pharmacy.work-item.read,
--    ocr.job.start, ocr.job.write, ocr.job.read and ocr.job.read-own exist
--    and are active; the rows 0136 removed are absent and the rows it added
--    are present, so in particular auth.role_permissions has none of admin
--    and doctor x lab.work-item.read and pharmacy.work-item.read, nor doctor
--    x ocr.job.start, as Release B leaves it; this login sees every row it
--    counts (42501 otherwise).
-- 2. The count and the stop.
-- 3. The two roles and their three rows, the grants and their audit rows.
-- 4. The post-checks: exactly the two roles and their three rows, no other
--    role's row changed, the grants exactly the counted memberships, one
--    audit row each.

do $q137b$
declare
  attempt integer := 0;
  holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  missing text;
  q137b_reason constant text := 'Owner decision Q137 B (23 November 2026): access 0136 removed';
  zero136_applied timestamptz;
  administrators integer;
  doctors integer;
  reading_doctors integer;
  work_list_members uuid[];
  reading_members uuid[];
  granted integer;
  audited integer;
  role_rows_before text;
begin
  -- 0. The locks (see Locks), NOWAIT, at most 5 s; one attempt when this
  -- transaction already holds an earlier migration's locks.
  loop
    attempt := attempt + 1;
    begin
      lock table auth.roles, auth.role_permissions, auth.account_roles
        in share row exclusive mode nowait;
      lock table audit.events
        in row exclusive mode nowait;
      lock table auth.permissions, auth.accounts, identity.staff_facility_memberships, identity.facilities,
                 identity.outreach_organisations, identity.organization_applications
        in row share mode nowait;
      lock table identity.staff, identity.organizations, identity.sealed_demo_members, identity.sealed_qa_members,
                 migration.schema_migrations
        in access share mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0147: auth.roles, auth.role_permissions, auth.account_roles, audit.events or a table 0147 reads (the permissions, accounts, staff, memberships, facilities, organizations, outreach groups, applications, sealed member lists and migration ledger) is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0147: auth.roles, auth.role_permissions, auth.account_roles, audit.events or a table 0147 reads (the permissions, accounts, staff, memberships, facilities, organizations, outreach groups, applications, sealed member lists and migration ledger) stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;

  -- 1. Preconditions.
  -- One marker of each of 0137-0146 (each file's own "already applied" test).
  if to_regprocedure('identity.qoreid_nin_record_used(character,text)') is null
     or to_regclass('identity.patient_nin_links') is null
     or not exists (select 1 from auth.permissions where code = 'platform.facility-staff.manage')
     or to_regclass('auth.session_open_patient') is null
     or to_regclass('ehr.consultation_drafts') is null
     or to_regprocedure('ehr.guard_vital_status()') is null
     or to_regprocedure('ehr.list_my_orders(text[],boolean,date,timestamp with time zone,text,uuid,integer)') is null
     or to_regclass('pharmacy.work_item_acceptances') is null
     or to_regclass('identity.unknown_patients') is null
     or to_regprocedure('ehr.reject_document_object_rebinding()') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = 'ehr.reject_document_object_rebinding()'::regprocedure)
        is distinct from 'b110135d5f09c1bbe04316e01cc2eeba'
     or to_regclass('migration.schema_migrations') is null then
    raise exception using errcode = '55000', message = '0147: 0001-0146 must be applied first';
  end if;

  select string_agg(code, ', ' order by code) into missing
    from auth.roles where code in ('work_list_reader', 'reading_starter');
  if missing = 'reading_starter, work_list_reader' then
    raise exception using errcode = '55000', message = '0147: already applied';
  elsif missing is not null then
    raise exception using errcode = '55000', message = '0147: the role already exists: ' || missing;
  end if;

  select string_agg(code, ', ' order by code) into missing
    from (values ('admin'), ('doctor')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0147: role missing or inactive: ' || missing;
  end if;

  select string_agg(code, ', ' order by code) into missing
    from (values ('lab.work-item.read'), ('pharmacy.work-item.read'), ('ocr.job.start'), ('ocr.job.write'),
                 ('ocr.job.read'), ('ocr.job.read-own')) wanted(code)
   where not exists (select 1 from auth.permissions permission_row
                      where permission_row.code = wanted.code and permission_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0147: permission missing or inactive: ' || missing;
  end if;

  -- 0136's rows as Release B leaves them: every row 0136 removed is absent,
  -- every row it added is present, and doctors do not hold ocr.job.start.
  select string_agg(change.role_code || ' ' || change.permission_code, ', '
                    order by change.role_code, change.permission_code) into missing
    from (values
      ('receptionist', 'ehr.document.write', 'gains'), ('receptionist', 'ehr.document.read-own', 'gains'),
      ('receptionist', 'ocr.job.write', 'gains'), ('receptionist', 'ocr.job.start', 'gains'),
      ('receptionist', 'ocr.job.read-own', 'gains'), ('receptionist', 'ehr.vital.read', 'gains'),
      ('nurse', 'ocr.job.start', 'gains'), ('clinician', 'ocr.job.start', 'gains'),
      ('doctor', 'outreach.campaign.read', 'loses'), ('doctor', 'outreach.campaign.write', 'loses'),
      ('doctor', 'outreach.registration.read', 'loses'), ('doctor', 'outreach.registration.write', 'loses'),
      ('doctor', 'lab.work-item.read', 'loses'), ('doctor', 'pharmacy.work-item.read', 'loses'),
      ('lab', 'ehr.encounter.read', 'loses'), ('lab', 'ocr.job.read', 'loses'),
      ('lab', 'ocr.job.write', 'loses'), ('lab', 'ocr.validation.write', 'loses'),
      ('admin', 'lab.work-item.read', 'loses'), ('admin', 'pharmacy.work-item.read', 'loses'),
      ('doctor', 'ocr.job.start', 'loses')
    ) change(role_code, permission_code, action)
   where (change.action = 'gains') <> exists (
           select 1 from auth.role_permissions row_now
            where row_now.role_code = change.role_code and row_now.permission_code = change.permission_code);
  if missing is not null then
    raise exception using errcode = '55000', message = '0147: the role table is not as 0136 left it: ' || missing;
  end if;

  -- The counts are right only if this login sees every row it counts (0136's
  -- own check: row security hides the sealed lists' rows from any login but
  -- the database owner, the login the migrations use).
  select string_agg(table_name, ', ' order by table_name) into missing
    from unnest(array['auth.permissions', 'auth.role_permissions', 'auth.roles', 'auth.accounts',
                      'auth.account_roles', 'identity.staff_facility_memberships', 'identity.staff',
                      'identity.facilities', 'identity.organizations', 'identity.sealed_demo_members',
                      'identity.sealed_qa_members', 'migration.schema_migrations']) table_name
   where row_security_active(table_name::regclass);
  if missing is not null then
    raise exception using errcode = '42501',
      message = '0147: this login cannot see every row of ' || missing || ', so the counts would be too low; nothing applied';
  end if;

  select ledger.applied_at into zero136_applied
    from migration.schema_migrations ledger where ledger.version = '0136_role_permission_changes.sql';
  if zero136_applied is null then
    zero136_applied := transaction_timestamp();
    raise notice '0147: 0136 is not recorded in migration.schema_migrations, so it is being applied in this same transaction; this transaction''s start stands for its applied_at.';
  end if;

  -- 2. The count. 0136's change list (lines 1-20), as 0136 has it.
  with change(position, role_code, permission_code, action) as (
    values
      (1, 'receptionist', 'ehr.document.write', 'gains'), (2, 'receptionist', 'ehr.document.read-own', 'gains'),
      (3, 'receptionist', 'ocr.job.write', 'gains'), (4, 'receptionist', 'ocr.job.start', 'gains'),
      (5, 'receptionist', 'ocr.job.read-own', 'gains'), (6, 'receptionist', 'ehr.vital.read', 'gains'),
      (7, 'nurse', 'ocr.job.start', 'gains'), (8, 'clinician', 'ocr.job.start', 'gains'),
      (9, 'doctor', 'outreach.campaign.read', 'loses'), (10, 'doctor', 'outreach.campaign.write', 'loses'),
      (11, 'doctor', 'outreach.registration.read', 'loses'), (12, 'doctor', 'outreach.registration.write', 'loses'),
      (13, 'doctor', 'lab.work-item.read', 'loses'), (14, 'doctor', 'pharmacy.work-item.read', 'loses'),
      (15, 'lab', 'ehr.encounter.read', 'loses'), (16, 'lab', 'ocr.job.read', 'loses'),
      (17, 'lab', 'ocr.job.write', 'loses'), (18, 'lab', 'ocr.validation.write', 'loses'),
      (19, 'admin', 'lab.work-item.read', 'loses'), (20, 'admin', 'pharmacy.work-item.read', 'loses')
  ),
  -- The role table as 0136 found it ('now', in 0136's words: today's rows,
  -- less the rows 0136 added, plus the rows it removed) and as it is today
  -- ('after': 0136 left it so, as the precondition checks for its rows).
  role_table as (
    select 'now' as stage, grant_row.role_code, grant_row.permission_code
      from auth.role_permissions grant_row
     where not exists (select 1 from change
                        where change.action = 'gains' and change.role_code = grant_row.role_code
                          and change.permission_code = grant_row.permission_code)
    union all
    select 'now', change.role_code, change.permission_code from change where change.action = 'loses'
    union all
    select 'after', grant_row.role_code, grant_row.permission_code
      from auth.role_permissions grant_row
  ),
  -- "Active" is identity.has_active_membership's rule and
  -- auth.membership_has_permission's: membership active and not held by the
  -- cutover, login active and not disabled, staff record active and verified,
  -- facility and organisation active; the role assignment not revoked and the
  -- role active.
  live_membership as (
    select membership.id, membership.account_id, membership.facility_id,
           exists (select 1 from identity.sealed_demo_members sealed
                    where sealed.member_kind = 'facility' and sealed.member_id = membership.facility_id)
           or exists (select 1 from identity.sealed_qa_members sealed
                       where sealed.member_kind = 'facility' and sealed.member_id = membership.facility_id) as sealed
      from identity.staff_facility_memberships membership
      join auth.accounts account_row on account_row.id = membership.account_id
      join identity.staff staff_row on staff_row.id = membership.staff_id
      join identity.facilities facility on facility.id = membership.facility_id
      join identity.organizations organization_row on organization_row.id = membership.organization_id
     where membership.active and membership.migration_hold_reason is null
       and account_row.status = 'active'
       and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
       and staff_row.active and lower(staff_row.verification_status) in ('verified', 'approved', 'active')
       and facility.active and facility.organization_id = membership.organization_id and organization_row.active
  ),
  -- 0136's assignment, with when it was granted.
  assignment as (
    select live.id as membership_id, live.account_id, live.facility_id, live.sealed, role_row.code as role_code,
           assignment_row.granted_at < zero136_applied as before_0136
      from live_membership live
      join auth.account_roles assignment_row
        on assignment_row.membership_id = live.id and assignment_row.facility_id = live.facility_id
       and assignment_row.account_id = live.account_id and assignment_row.scope_type = 'facility'
       and assignment_row.revoked_at is null
      join auth.roles role_row on role_row.code = assignment_row.role_code and role_row.active
  ),
  -- Lines 13, 14, 19 and 20: each membership holding the role 0136 changed
  -- (0136's holder; a loss changes nothing for one whose other role grants
  -- the code after 0136, that is today).
  holder as (
    select change.position, assignment.membership_id, assignment.account_id, assignment.sealed, assignment.before_0136,
           exists (select 1
                     from assignment other_role
                     join role_table other_grant
                       on other_grant.role_code = other_role.role_code
                      and other_grant.permission_code = change.permission_code
                      and other_grant.stage = case when change.action = 'gains' then 'now' else 'after' end
                    where other_role.membership_id = assignment.membership_id
                      and other_role.role_code <> change.role_code) as covered
      from change
      join assignment on assignment.role_code = change.role_code
     where change.position in (13, 14, 19, 20)
  ),
  work_list as (
    select holder.membership_id, bool_or(holder.position in (19, 20)) as administrator,
           bool_or(holder.position in (13, 14)) as doctor
      from holder
     where not holder.sealed and not holder.covered and holder.before_0136
     group by holder.membership_id
  ),
  -- Line 21: each active membership's codes before 0136 ('now') and today
  -- ('after'), through all its active roles (0136's member and ability), and
  -- whether it held doctor since before 0136 was applied.
  member as (
    select assignment.membership_id as id, assignment.account_id, assignment.facility_id, assignment.sealed,
           bool_or(assignment.role_code = 'doctor' and assignment.before_0136) as doctor,
           coalesce(array_agg(distinct role_table.permission_code) filter (where role_table.stage = 'now'),
                    '{}'::text[]) as now_codes,
           coalesce(array_agg(distinct role_table.permission_code) filter (where role_table.stage = 'after'),
                    '{}'::text[]) as after_codes
      from assignment
      left join role_table on role_table.role_code = assignment.role_code
     group by assignment.membership_id, assignment.account_id, assignment.facility_id, assignment.sealed
  ),
  ability as (
    select member.id, member.account_id, member.facility_id, member.sealed, member.doctor,
           member.now_codes @> array['ocr.job.write', 'ocr.job.read'] as starts_now,
           member.after_codes @> array['ocr.job.write', 'ocr.job.start']
             and member.after_codes && array['ocr.job.read', 'ocr.job.read-own'] as starts_after
      from member
  ),
  reading as (
    select ability.id as membership_id
      from ability
     where not ability.sealed and ability.doctor and ability.starts_now and not ability.starts_after
  )
  select (select count(*) from work_list where work_list.administrator),
         (select count(*) from work_list where work_list.doctor),
         (select count(*) from reading),
         (select coalesce(array_agg(work_list.membership_id order by work_list.membership_id), '{}'::uuid[])
            from work_list),
         (select coalesce(array_agg(reading.membership_id order by reading.membership_id), '{}'::uuid[])
            from reading)
    into administrators, doctors, reading_doctors, work_list_members, reading_members;

  raise notice '0147 counts at real facilities: % administrators and % doctors read neither work list since 0136 (its lines 19/20 and 13/14), % doctors cannot start a reading since 0136 (its line 21); the owner approved exactly 9, 1 and 1 (Q137 B).',
    administrators, doctors, reading_doctors;

  -- The stop (Q137 B, and the amendment's 0, 0 and 0): numbers only.
  if (administrators, doctors, reading_doctors) not in ((9, 1, 1), (0, 0, 0)) then
    raise exception using errcode = '55000',
      message = format('0147 stopped, nothing was changed: the counts are %s, %s and %s (administrators and doctors '
        || 'for the work lists, doctors for the reading start); the owner approved exactly 9, 1 and 1 (Q137 B), '
        || 'and 0, 0 and 0 grants nothing.', administrators, doctors, reading_doctors);
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ',' order by grant_row.role_code,
                    grant_row.permission_code)
    into role_rows_before from auth.role_permissions grant_row;

  -- 3. The two roles and their three rows.
  insert into auth.roles (code, description) values
    ('work_list_reader', 'Lab and pharmacy work lists: reads the laboratory''s and the pharmacy''s work lists (owner decision Q137 B, 0147; not a staff role)'),
    ('reading_starter', 'Start a paper reading: starts or retries a paper-record reading, with ocr.job.write (owner decision Q137 B, 0147; not a staff role)');
  insert into auth.role_permissions (role_code, permission_code) values
    ('work_list_reader', 'lab.work-item.read'),
    ('work_list_reader', 'pharmacy.work-item.read'),
    ('reading_starter', 'ocr.job.start');

  -- The grants, work lists first, each with its audit row in 0139's role-add
  -- form: the membership's role codes before and after this grant.
  with wanted as (
    select membership.id, membership.account_id, membership.facility_id,
           coalesce((select array_agg(held.role_code order by held.role_code) from auth.account_roles held
                      where held.membership_id = membership.id and held.scope_type = 'facility'
                        and held.revoked_at is null), '{}'::text[]) as previous_roles
      from identity.staff_facility_memberships membership
     where membership.id = any(work_list_members)
  ), granted_row as (
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, granted_by,
                                    grant_reason)
    select gen_random_uuid(), wanted.account_id, 'work_list_reader', 'facility', wanted.id, wanted.facility_id, null,
           q137b_reason
      from wanted
    returning membership_id, facility_id, role_code
  ), audited_row as (
    insert into audit.events (
      correlation_id, actor_type, facility_id, action, outcome, resource_type, resource_id, purpose_of_use, reason,
      provenance, source_system, details
    )
    select '0147-narrow-roles-q137b', 'system', granted_row.facility_id, 'identity.facility-staff.role-add', 'success',
           'staff-membership', granted_row.membership_id::text, 'healthcare-operations', q137b_reason, 'migration',
           'hid-0147',
           jsonb_build_object('membershipId', granted_row.membership_id, 'roleCode', granted_row.role_code,
             'previousRoles', to_jsonb(wanted.previous_roles),
             'roles', (select to_jsonb(array_agg(held.role_code order by held.role_code))
                         from unnest(wanted.previous_roles || granted_row.role_code) held(role_code)),
             'migration', '0147', 'decision', 'Q137 B')
      from granted_row join wanted on wanted.id = granted_row.membership_id
    returning 1
  )
  select (select count(*) from granted_row), (select count(*) from audited_row) into granted, audited;
  if granted <> cardinality(work_list_members) or audited <> granted then
    raise exception using errcode = '55000', message = '0147: post-check failed (work list grants)';
  end if;

  with wanted as (
    select membership.id, membership.account_id, membership.facility_id,
           coalesce((select array_agg(held.role_code order by held.role_code) from auth.account_roles held
                      where held.membership_id = membership.id and held.scope_type = 'facility'
                        and held.revoked_at is null), '{}'::text[]) as previous_roles
      from identity.staff_facility_memberships membership
     where membership.id = any(reading_members)
  ), granted_row as (
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, granted_by,
                                    grant_reason)
    select gen_random_uuid(), wanted.account_id, 'reading_starter', 'facility', wanted.id, wanted.facility_id, null,
           q137b_reason
      from wanted
    returning membership_id, facility_id, role_code
  ), audited_row as (
    insert into audit.events (
      correlation_id, actor_type, facility_id, action, outcome, resource_type, resource_id, purpose_of_use, reason,
      provenance, source_system, details
    )
    select '0147-narrow-roles-q137b', 'system', granted_row.facility_id, 'identity.facility-staff.role-add', 'success',
           'staff-membership', granted_row.membership_id::text, 'healthcare-operations', q137b_reason, 'migration',
           'hid-0147',
           jsonb_build_object('membershipId', granted_row.membership_id, 'roleCode', granted_row.role_code,
             'previousRoles', to_jsonb(wanted.previous_roles),
             'roles', (select to_jsonb(array_agg(held.role_code order by held.role_code))
                         from unnest(wanted.previous_roles || granted_row.role_code) held(role_code)),
             'migration', '0147', 'decision', 'Q137 B')
      from granted_row join wanted on wanted.id = granted_row.membership_id
    returning 1
  )
  select (select count(*) from granted_row), (select count(*) from audited_row) into granted, audited;
  if granted <> cardinality(reading_members) or audited <> granted then
    raise exception using errcode = '55000', message = '0147: post-check failed (reading start grants)';
  end if;

  -- 4. Post-checks: exactly the two roles and their three rows; no other role's
  -- row changed; each counted membership holds its new role once, through a
  -- row with this file's reason, and nobody else holds either role.
  if (select count(*) from auth.roles where code in ('work_list_reader', 'reading_starter') and active) <> 2
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ',' order by grant_row.permission_code)
           from auth.role_permissions grant_row where grant_row.role_code = 'work_list_reader')
        is distinct from 'work_list_reader lab.work-item.read,work_list_reader pharmacy.work-item.read'
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ',' order by grant_row.permission_code)
           from auth.role_permissions grant_row where grant_row.role_code = 'reading_starter')
        is distinct from 'reading_starter ocr.job.start'
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ',' order by grant_row.role_code,
                           grant_row.permission_code)
           from auth.role_permissions grant_row
          where grant_row.role_code not in ('work_list_reader', 'reading_starter'))
        is distinct from role_rows_before
     or (select count(*) from auth.account_roles assignment_row
          where assignment_row.role_code = 'work_list_reader') <> cardinality(work_list_members)
     or (select count(*) from auth.account_roles assignment_row
          where assignment_row.role_code = 'reading_starter') <> cardinality(reading_members)
     or exists (select 1 from auth.account_roles assignment_row
                 where assignment_row.role_code in ('work_list_reader', 'reading_starter')
                   and (assignment_row.revoked_at is not null or assignment_row.scope_type <> 'facility'
                     or assignment_row.grant_reason <> q137b_reason
                     or not assignment_row.membership_id = any(case assignment_row.role_code
                                                                  when 'work_list_reader' then work_list_members
                                                                  else reading_members end)))
     or (select count(*) from audit.events event_row
          where event_row.correlation_id = '0147-narrow-roles-q137b')
        <> cardinality(work_list_members) + cardinality(reading_members) then
    raise exception using errcode = '55000', message = '0147: post-check failed';
  end if;

  if cardinality(work_list_members) + cardinality(reading_members) = 0 then
    raise notice '0147: nobody of 0136''s count is active today (0, 0 and 0): the two roles are created and given to nobody.';
  else
    raise notice '0147 gave work_list_reader to % memberships and reading_starter to % memberships, one audit row each.',
      cardinality(work_list_members), cardinality(reading_members);
  end if;
end
$q137b$;
