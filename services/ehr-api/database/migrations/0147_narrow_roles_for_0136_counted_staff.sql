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
-- D1 auth.roles             two new roles:
--      work_list_reader     "Lab and pharmacy work lists": reads the
--                           laboratory's and the pharmacy's work lists
--                           (lab.work-item.read, pharmacy.work-item.read), what
--                           0136 took from administrators (C6) and doctors
--                           (C4);
--      reading_starter      "Start a paper reading": ocr.job.start, which 0136
--                           made starting a reading need and did not give
--                           doctors (Q111 A). A doctor holds ocr.job.write and
--                           ocr.job.read, so with it the doctor starts and
--                           retries readings again, exactly as before 0136.
-- D2 auth.role_permissions  exactly those three rows. No row of any other role
--                           changes, so Q103 A and Q111 A hold for everyone
--                           else.
-- D3 auth.account_roles     one row per counted membership and role (scope
--                           'facility', the membership, its facility and
--                           login; granted_by null, as the other migrations'
--                           grants; grant_reason "Owner decision Q137 B (23
--                           November 2026): access 0136 removed").
-- D4 audit.events           one row per grant, in the form 0139's role add
--                           writes (identity.facility-staff.role-add, resource
--                           staff-membership, the membership, its role codes
--                           before and after), as the system actor (0136's
--                           close rows): the facility and the membership
--                           only, no name, account or organisation.
-- D5 identity.staff_role_change_apply, SX-4's change (0139), replaced as 0139
--    replaced the openers (its D6): md5-pinned as Release B leaves it;
--    CREATE OR REPLACE keeps its oid, owner, grants (EXECUTE for nobody: it
--    runs only inside SX-4's four commands, as their owner) and comment; it
--    stays SECURITY INVOKER with 0139's search_path; only the lines marked
--    0147 (Q137 B) are added, which the post-check proves (taking them out
--    gives back Release B's body). With it, after this file:
--      - what SX-4 counts and checks leaves out the two narrow roles: the
--        role already held (add) or not held (remove), the member's last
--        role, and the role that takes membership_role or app_role after a
--        remove (and the refusal when none can) are among the other roles
--        only. So neither narrow role ever becomes a membership's role
--        columns, and doctor cannot be removed from a member whose only
--        other roles are narrow (FACILITY_STAFF_LAST_ROLE; end the
--        membership instead);
--      - either narrow role named as the role to add or remove is refused
--        (22023 STAFF_INVITATION_INVALID, as SX-4's four commands and
--        identity-api's DTOs already refuse them);
--      - removing doctor also revokes that membership's reading_starter, and
--        its work_list_reader unless it still holds admin (whose work lists
--        0147 gave back too): revoked when doctor is, by the caller, with the
--        remove's reason ("Role removed by the facility administrator" or
--        "Role removed by Health ID support"), and one
--        identity.facility-staff.role-remove audit row each, written as 0139's
--        own revocations in it are (the administrator as a staff actor,
--        support as the system actor; the facility and the membership, the
--        narrow role, the role codes before and after, cause role-removed,
--        removedRole doctor). Adding doctor back does not give them back;
--      - SX-4 still answers (and its commands audit) every role held before
--        and after the change, the narrow roles too, as before this file.
--    Nothing else in it changes, and no other function changes.
-- Neither role is a staff kind, a membership_role or app_role, or a role
-- anyone can invite (identity.staff_invitable_roles) or add or remove through
-- SX-4 (0139's role lists stay the five hospital roles). They are only these
-- extra assignment rows, and they end with the membership, as every role
-- does, or when doctor is removed (D5). No policy, grant or table changes, so
-- runtime-grants.sql is unchanged (D5 keeps the function's grants, and the
-- file's revoke from PUBLIC still holds). Permissions are read on every
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
-- identity sequence. Replacing SX-4's change function (D5, CREATE OR
-- REPLACE) locks no table: ACCESS SHARE object locks on the identity schema,
-- plpgsql and the membership row type (identity.staff_facility_memberships,
-- its first argument), so none of them can be dropped until commit, and ROW
-- EXCLUSIVE on pg_proc's TOAST table and its index (where the new body is
-- stored); its pg_proc row is replaced and the catalog's own lock released
-- at once. The preconditions read the catalog (pg_proc, pg_language,
-- pg_roles, pg_description) at ACCESS SHARE. Those are not taken NOWAIT, as
-- only DDL on that function, schema, type or language would make them wait,
-- and no service runs DDL. (pg_locks before commit, at 9, 1 and 1 and at 0, 0
-- and 0, on a database 0147 had not changed; the narrow-roles suite checks
-- them there.) An SX-4 command already inside the function when 0147 commits
-- finishes with the body it started with; every later call uses the new one.
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
-- D5 can stay: with the roles inactive it still only keeps their codes out of
-- SX-4's counting and revokes them with doctor.
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
--    x ocr.job.start, as Release B leaves it; SX-4's change function as
--    Release B leaves it (0139's body by its md5, SECURITY INVOKER with
--    0139's search_path, plpgsql and volatile, EXECUTE for neither PUBLIC nor
--    the Identity runtime), and this login holding its owner's privileges
--    (42501 otherwise); this login sees every row it counts (42501
--    otherwise).
-- 2. The count and the stop.
-- 3. The two roles and their three rows, the grants and their audit rows
--    (D1-D4).
-- 3b. SX-4's change function replaced (D5), at any counts that apply.
-- 4. The post-checks: exactly the two roles and their three rows, no other
--    role's row changed, the grants exactly the counted memberships, one
--    audit row each; SX-4's change function is Release B's body once the
--    lines marked 0147 (Q137 B) are taken out (the md5 above), with its oid,
--    owner, grants, comment, language, settings and arguments as before.

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
  apply_signature constant text := 'identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,'
    || 'text,text,text,text,text,uuid,uuid,text)';
  apply_before text;
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

  -- SX-4's change function (0139) as Release B leaves it, which 3b replaces:
  -- its body, SECURITY INVOKER with 0139's search_path, plpgsql and volatile,
  -- EXECUTE for neither PUBLIC nor the Identity runtime (0139's post-check),
  -- and an owner whose privileges this login has (CREATE OR REPLACE keeps
  -- the owner, and only it may replace the function).
  if to_regprocedure(apply_signature) is null
     or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(apply_signature))
        is distinct from '25ecccbb09f5118cf0e7f7c1e98c5479'
     or (select proc.prosecdef or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
                or proc.provolatile <> 'v' or language_row.lanname <> 'plpgsql'
           from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
          where proc.oid = to_regprocedure(apply_signature))
     or has_function_privilege('public', apply_signature, 'EXECUTE')
     or (exists (select 1 from pg_roles where rolname = 'hid_identity_runtime')
         and has_function_privilege('hid_identity_runtime', apply_signature, 'EXECUTE')) then
    raise exception using errcode = '55000',
      message = '0147: identity.staff_role_change_apply is not as Release B leaves it (0139''s body, SECURITY INVOKER '
        || 'with its search_path, EXECUTE for neither PUBLIC nor the Identity runtime); nothing applied';
  end if;
  select pg_get_userbyid(proc.proowner) into missing
    from pg_proc proc
   where proc.oid = to_regprocedure(apply_signature) and not pg_has_role(current_user, proc.proowner, 'USAGE');
  if missing is not null then
    raise exception using errcode = '42501',
      message = format('0147: this login (%s) may not replace identity.staff_role_change_apply, whose owner is %s; '
        || 'nothing applied', current_user, missing);
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

  -- 3b. SX-4's change function (D5), replaced as 0139 replaced the openers:
  -- Release B's body (checked in 1) with only the lines marked 0147 (Q137 B)
  -- added, which the post-check proves. CREATE OR REPLACE keeps its oid,
  -- owner, grants and comment; SECURITY INVOKER and its search_path are
  -- written as 0139 wrote them.
  select row(proc.oid, proc.proowner, proc.proacl, obj_description(proc.oid, 'pg_proc'), proc.prolang,
             proc.prosecdef, proc.proconfig, proc.provolatile, proc.proparallel, proc.proleakproof, proc.procost,
             proc.prorettype, proc.proallargtypes, proc.proargmodes, proc.proargnames)::text
    into apply_before
    from pg_proc proc where proc.oid = to_regprocedure(apply_signature);
  execute $apply$
create or replace function identity.staff_role_change_apply(
  member identity.staff_facility_memberships,
  expected_version bigint,
  requested_action text,
  requested_role text,
  licence_body text,
  licence_number text,
  verification_method text,
  attestation_version text,
  attester_account uuid,
  attester_membership uuid,
  change_reason text,
  out row_version bigint,
  out roles text[],
  out previous_roles text[],
  out requests_closed integer,
  out grants_revoked integer
) returns record
language plpgsql volatile
set search_path = pg_catalog, pg_temp
as $body$
declare
  observed timestamptz := clock_timestamp();
  grant_id uuid;
  person_name text;
  member_subject text;
  next_app_role text;
  next_membership_role text;
  own_facility_lost boolean;
  break_glass_lost boolean;
  closed record;
  narrow_held text[];  -- 0147 (Q137 B)
  narrow_left text[];  -- 0147 (Q137 B)
  narrow_role text;  -- 0147 (Q137 B)
begin
  if requested_action not in ('add', 'remove') then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;
  -- The two narrow roles are never added or removed by name (0147).  -- 0147 (Q137 B)
  if requested_role in ('work_list_reader', 'reading_starter') then  -- 0147 (Q137 B)
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';  -- 0147 (Q137 B)
  end if;  -- 0147 (Q137 B)
  perform 1 from auth.account_roles assignment
   where assignment.membership_id = member.id and assignment.revoked_at is null
   order by assignment.id
   for update;
  select coalesce(array_agg(assignment.role_code order by assignment.role_code), array[]::text[])
    into previous_roles
    from auth.account_roles assignment
   where assignment.membership_id = member.id and assignment.scope_type = 'facility'
     and assignment.role_code not in ('work_list_reader', 'reading_starter')  -- 0147 (Q137 B)
     and assignment.revoked_at is null;
  -- previous_roles leaves out the two narrow roles, so the checks below, the  -- 0147 (Q137 B)
  -- last role and the two role columns count and choose among the others  -- 0147 (Q137 B)
  -- only; the narrow roles held are kept apart.  -- 0147 (Q137 B)
  select coalesce(array_agg(assignment.role_code order by assignment.role_code), array[]::text[])  -- 0147 (Q137 B)
    into narrow_held  -- 0147 (Q137 B)
    from auth.account_roles assignment  -- 0147 (Q137 B)
   where assignment.membership_id = member.id and assignment.scope_type = 'facility'  -- 0147 (Q137 B)
     and assignment.role_code in ('work_list_reader', 'reading_starter') and assignment.revoked_at is null;  -- 0147 (Q137 B)
  narrow_left := narrow_held;  -- 0147 (Q137 B)
  if requested_action = 'add' and requested_role = any(previous_roles) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ROLE_ALREADY_HELD';
  end if;
  if requested_action = 'remove' and not (requested_role = any(previous_roles)) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ROLE_NOT_HELD';
  end if;
  if requested_action = 'remove' and cardinality(previous_roles) = 1 then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_LAST_ROLE';
  end if;
  -- No role left can take membership_role (staff_memberships_scoped_uq).
  if requested_action = 'remove' and member.membership_role = requested_role
     and not exists (select 1 from unnest(previous_roles) held(role_code)
                      where held.role_code <> requested_role
                        and not exists (select 1 from identity.staff_facility_memberships other
                                         where other.staff_id = member.staff_id
                                           and other.organization_id = member.organization_id
                                           and other.facility_id = member.facility_id and other.id <> member.id
                                           and other.membership_role = held.role_code)) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ROLE_COLUMN_CONFLICT';
  end if;
  if expected_version is null or member.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Facility staff membership version conflict';
  end if;

  if requested_action = 'add' then
    grant_id := gen_random_uuid();
    insert into auth.account_roles (
      id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason
    ) values (
      grant_id, member.account_id, requested_role, 'facility', member.id, member.facility_id, attester_account,
      change_reason
    );
    if licence_body is not null then
      select btrim(left(coalesce(account.display_name, staff.full_name), 200)) into person_name
        from identity.staff staff join auth.accounts account on account.id = staff.account_id
       where staff.id = member.staff_id;
      insert into identity.staff_licence_attestations (
        organization_id, facility_id, account_id, staff_id, membership_id, role_code, role_grant_id,
        licence_body, licence_number, attested_person_name, verification_method,
        attested_by_account_id, attested_by_membership_id, attestation_version, attested_at, correlation_id
      ) values (
        member.organization_id, member.facility_id, member.account_id, member.staff_id, member.id,
        requested_role, grant_id, licence_body, licence_number, person_name, verification_method,
        attester_account, attester_membership, attestation_version, observed, platform.current_correlation_id()
      );
    end if;
    select array_agg(held.role_code order by held.role_code) into roles
      from unnest(previous_roles || requested_role) held(role_code);
  else
    update auth.account_roles assignment
       set revoked_at = observed, revoked_by = attester_account, revocation_reason = change_reason,
           row_version = assignment.row_version + 1
     where assignment.membership_id = member.id and assignment.scope_type = 'facility'
       and assignment.role_code = requested_role and assignment.revoked_at is null;
    roles := array_remove(previous_roles, requested_role);
    -- Removing doctor also revokes the membership's reading_starter, and its  -- 0147 (Q137 B)
    -- work_list_reader unless it still holds admin: revoked by the caller  -- 0147 (Q137 B)
    -- with the remove's reason, one role-remove audit row each.  -- 0147 (Q137 B)
    if requested_role = 'doctor' then  -- 0147 (Q137 B)
      for narrow_role in  -- 0147 (Q137 B)
        select held.role_code from unnest(narrow_held) held(role_code)  -- 0147 (Q137 B)
         where held.role_code = 'reading_starter' or not ('admin' = any(roles))  -- 0147 (Q137 B)
         order by held.role_code  -- 0147 (Q137 B)
      loop  -- 0147 (Q137 B)
        update auth.account_roles assignment  -- 0147 (Q137 B)
           set revoked_at = observed, revoked_by = attester_account, revocation_reason = change_reason,  -- 0147 (Q137 B)
               row_version = assignment.row_version + 1  -- 0147 (Q137 B)
         where assignment.membership_id = member.id and assignment.scope_type = 'facility'  -- 0147 (Q137 B)
           and assignment.role_code = narrow_role and assignment.revoked_at is null;  -- 0147 (Q137 B)
        insert into audit.events (  -- 0147 (Q137 B)
          correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,  -- 0147 (Q137 B)
          organization_id, facility_id, action, outcome, resource_type, resource_id,  -- 0147 (Q137 B)
          purpose_of_use, reason, provenance, source_system, details  -- 0147 (Q137 B)
        ) values (  -- 0147 (Q137 B)
          platform.current_correlation_id(),  -- 0147 (Q137 B)
          case when attester_membership is null then 'system' else 'staff' end,  -- 0147 (Q137 B)
          case when attester_membership is null then null else platform.current_actor_subject() end,  -- 0147 (Q137 B)
          case when attester_membership is null then null else attester_account end,  -- 0147 (Q137 B)
          attester_membership, member.organization_id, member.facility_id,  -- 0147 (Q137 B)
          'identity.facility-staff.role-remove', 'success', 'staff-membership', member.id::text,  -- 0147 (Q137 B)
          'healthcare-operations', change_reason, 'application', 'identity-api',  -- 0147 (Q137 B)
          jsonb_build_object('membershipId', member.id, 'roleCode', narrow_role,  -- 0147 (Q137 B)
            'previousRoles', (select to_jsonb(array_agg(held.role_code order by held.role_code))  -- 0147 (Q137 B)
                                from unnest(roles || narrow_left) held(role_code)),  -- 0147 (Q137 B)
            'roles', (select to_jsonb(array_agg(held.role_code order by held.role_code))  -- 0147 (Q137 B)
                        from unnest(roles || array_remove(narrow_left, narrow_role)) held(role_code)),  -- 0147 (Q137 B)
            'cause', 'role-removed', 'removedRole', requested_role)  -- 0147 (Q137 B)
        );  -- 0147 (Q137 B)
        narrow_left := array_remove(narrow_left, narrow_role);  -- 0147 (Q137 B)
      end loop;  -- 0147 (Q137 B)
    end if;  -- 0147 (Q137 B)
  end if;

  -- The two role columns the staff session lists (see "What a command does").
  next_app_role := case when requested_action = 'remove' and member.app_role = requested_role
    then roles[1] else member.app_role end;
  next_membership_role := member.membership_role;
  if requested_action = 'remove' and member.membership_role = requested_role then
    select held.role_code into next_membership_role
      from unnest(roles) held(role_code)
     where not exists (select 1 from identity.staff_facility_memberships other
                        where other.staff_id = member.staff_id and other.organization_id = member.organization_id
                          and other.facility_id = member.facility_id and other.id <> member.id
                          and other.membership_role = held.role_code)
     order by held.role_code
     limit 1;
  end if;
  update identity.staff_facility_memberships membership
     set membership_role = next_membership_role, app_role = next_app_role,
         updated_at = observed, row_version = membership.row_version + 1
   where membership.id = member.id
   returning membership.row_version into row_version;

  requests_closed := 0;
  if requested_action = 'remove' then
    select account.subject into member_subject from auth.accounts account where account.id = member.account_id;
    with closed_request as (
      update identity.access_requests request_row
         set status = 'expired', updated_at = clock_timestamp(), row_version = request_row.row_version + 1
       where request_row.membership_id = member.id and request_row.status = 'pending'
         and request_row.purpose_of_use = 'healthcare-operations'
         and not request_row.break_glass and request_row.migration_hold_reason is null
         and not coalesce(auth.membership_has_permission(member_subject, member.id, request_row.facility_id,
                            'ocr.job.write'), false)
      returning request_row.id, request_row.patient_id, request_row.facility_id, request_row.scope
    ), audited as (
      insert into audit.events (
        correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, reason, provenance, source_system, details
      )
      select platform.current_correlation_id(), 'system', closed_request.facility_id, closed_request.patient_id,
             'identity.access-request.close', 'success', 'access-request', closed_request.id::text,
             'healthcare-operations', 'This staff member can no longer process records', 'application',
             'identity-api',
             jsonb_build_object('status', 'expired', 'scope', closed_request.scope, 'cause', 'role-removed')
        from closed_request
      returning 1
    )
    select count(*)::integer into requests_closed from audited;
  end if;

  -- The grants the roles left no longer allow (see "What a command does").
  grants_revoked := 0;
  if requested_action = 'remove' then
    select
      not exists (select 1 from auth.account_roles assignment
                    join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
                    join auth.role_permissions holder on holder.role_code = assignment.role_code
                    join auth.permissions permission_row
                      on permission_row.code = holder.permission_code and permission_row.active
                   where assignment.membership_id = member.id and assignment.facility_id = member.facility_id
                     and assignment.scope_type = 'facility' and assignment.revoked_at is null
                     and holder.permission_code = 'identity.patient.open-own-facility'),
      not exists (select 1 from auth.account_roles assignment
                    join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
                    join auth.role_permissions holder on holder.role_code = assignment.role_code
                    join auth.permissions permission_row
                      on permission_row.code = holder.permission_code and permission_row.active
                   where assignment.membership_id = member.id and assignment.facility_id = member.facility_id
                     and assignment.scope_type = 'facility' and assignment.revoked_at is null
                     and holder.permission_code = 'identity.break-glass.write')
      into own_facility_lost, break_glass_lost;
    if own_facility_lost or break_glass_lost then
      for closed in
        update identity.consent_grants grant_row
           set status = 'revoked', revoked_at = observed, revoked_by = attester_account,
               revoked_reason = change_reason, updated_at = observed, row_version = grant_row.row_version + 1
         where grant_row.membership_id = member.id and grant_row.status = 'active'
           and grant_row.expires_at > observed
           and ((own_facility_lost and grant_row.authorization_method = 'own_facility')
             or (break_glass_lost and (grant_row.break_glass or grant_row.scope = 'break_glass')))
        returning grant_row.id, grant_row.patient_id, grant_row.facility_id, grant_row.break_glass
      loop
        grants_revoked := grants_revoked + 1;
        insert into audit.events (
          correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
          organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
          purpose_of_use, reason, provenance, source_system, details
        ) values (
          platform.current_correlation_id(),
          case when attester_membership is null then 'system' else 'staff' end,
          case when attester_membership is null then null else platform.current_actor_subject() end,
          case when attester_membership is null then null else attester_account end,
          attester_membership, member.organization_id, closed.facility_id, closed.patient_id,
          'identity.consent-grant.close', 'success', 'consent-grant', closed.id::text,
          'healthcare-operations', change_reason, 'application', 'identity-api',
          jsonb_build_object('existing_closure', false, 'membershipId', member.id, 'cause', 'role-removed',
            'access', case when closed.break_glass then 'break_glass' else 'own_facility' end)
        );
      end loop;
    end if;
  end if;
  -- The roles answered (and audited by the commands) are every role held  -- 0147 (Q137 B)
  -- before and after the change, the narrow roles too.  -- 0147 (Q137 B)
  select coalesce(array_agg(held.role_code order by held.role_code), array[]::text[]) into previous_roles  -- 0147 (Q137 B)
    from unnest(previous_roles || narrow_held) held(role_code);  -- 0147 (Q137 B)
  select array_agg(held.role_code order by held.role_code) into roles  -- 0147 (Q137 B)
    from unnest(roles || narrow_left) held(role_code);  -- 0147 (Q137 B)
end
$body$
$apply$;

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
  -- SX-4's change function (3b): taking out the lines marked 0147 (Q137 B)
  -- gives back Release B's body exactly, and its oid, owner, grants,
  -- comment, language, settings and arguments are as they were.
  if (select md5(regexp_replace(proc.prosrc, '[^\n]*-- 0147 \(Q137 B\)\n', '', 'g'))
        from pg_proc proc where proc.oid = to_regprocedure(apply_signature))
     is distinct from '25ecccbb09f5118cf0e7f7c1e98c5479'
     or (select row(proc.oid, proc.proowner, proc.proacl, obj_description(proc.oid, 'pg_proc'), proc.prolang,
                    proc.prosecdef, proc.proconfig, proc.provolatile, proc.proparallel, proc.proleakproof, proc.procost,
                    proc.prorettype, proc.proallargtypes, proc.proargmodes, proc.proargnames)::text
           from pg_proc proc where proc.oid = to_regprocedure(apply_signature))
        is distinct from apply_before then
    raise exception using errcode = '55000',
      message = '0147: post-check failed (identity.staff_role_change_apply is not Release B''s body plus 0147''s lines)';
  end if;

  if cardinality(work_list_members) + cardinality(reading_members) = 0 then
    raise notice '0147: nobody of 0136''s count is active today (0, 0 and 0): the two roles are created and given to nobody.';
  else
    raise notice '0147 gave work_list_reader to % memberships and reading_starter to % memberships, one audit row each.',
      cardinality(work_list_members), cardinality(reading_members);
  end if;
end
$q137b$;
