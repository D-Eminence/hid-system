-- 0136 Who can do what: changes to the staff role table (Akos SX-2 and SX-3,
-- Release A). Written on staging-novu-ci-20261005 at afec3f75 (0001-0127
-- applied). Release A applies 0128-0135 first; none of them touches the rows
-- this file adds or removes (0131 adds one doctor, nurse and clinician row of
-- its own, 0133 deliberately adds no doctor row), and this file reads nothing
-- they add, so it needs only 0001-0127.
--
-- Owner decisions (D-Eminence, in chat, 18 November 2026), verbatim:
-- "Q103 A" (about 21:00 UTC): the five changes, with the admin's "approve new
-- patient" and the nurse's note writing unchanged; then "Q111 A, Q112 A,
-- Q113 A":
--   Q111 A  doctors keep checking a scanned paper record and confirming its
--           patient (both need ocr.job.write, under records processing); only
--           starting a new scan (a reading) moves from doctors to the front
--           desk.
--   Q112 A  the front desk uploads scans and sees its own uploads, but does
--           not open other stored documents or read the text taken from them
--           (and still reads no note, diagnosis, prescription or lab request).
--   Q113 A  no real (non-sealed) staff are active yet, so 0136 may touch
--           none: at apply it prints the counts and stops, changing
--           nothing, if any of lines 1-24 at real facilities is above 0
--           (coordinator's hand-over on hid-system#258, 18 November 2026).
--           Nothing is filled in at signing; the maximums below are 0.
--   Q134 B  real staff became active, and the release's dry run of 21
--           November 2026 stopped here with these counts at real
--           facilities: lines 13 and 14 (a doctor loses lab.work-item.read
--           and pharmacy.work-item.read) 1 (1 staff login), lines 19 and 20
--           (admins lose lab.work-item.read and pharmacy.work-item.read) 9
--           (9 staff logins), line 21 (doctors who can start a reading today
--           and cannot after 0136) 1 (1 staff login), every other line 0.
--           The owner accepted those losses and raised exactly those five
--           maximums to those counts; every other maximum stays 0, so any
--           further real staff affected still stop 0136.
-- The declaration in config/production-schema-compatibility.json is signed
-- separately: its reviewed_by stays empty until the owner signs it there.
--
-- Rows (auth.role_permissions, role_code / permission_code) and three new
-- permission codes (auth.permissions). The only other change is closing open
-- records-processing requests that can no longer be used (step 4 below): no
-- function, policy, grant or table changes, so runtime-grants.sql is
-- unchanged. Permissions are read from this table on every request
-- (auth.membership_has_permission and the Identity staff context), so a
-- change takes effect on the next request of each signed-in staff member;
-- nobody is signed out. ehr-api and ocr-api read the three new codes from the
-- same release on (they ship together; the release applies migrations before
-- it starts the new service images).
--
-- New permission codes:
--   ocr.job.start          start or retry a paper-record reading (POST
--                          ocr/jobs, ocr/jobs/:id/retry), together with
--                          ocr.job.write. From this release on ocr-api asks
--                          for both, so a role holding ocr.job.write without
--                          ocr.job.start (the doctor) can no longer start a
--                          reading but keeps everything else ocr.job.write
--                          gives: checking readings and confirming their
--                          patient under records processing, and asking a
--                          patient for records processing (Q111 A).
--   ocr.job.read-own       follow the readings of documents this login
--                          uploaded at the facility (GET ocr/jobs/:id, GET
--                          ocr/jobs?documentId=, GET ocr/job-list, which then
--                          shows only the readings it started), and let
--                          ocr-api read such a document to start its reading.
--                          Never the text taken from it: extractions,
--                          validations and publications still need
--                          ocr.job.read (Q112 A).
--   ehr.document.read-own  list and open only the documents this login
--                          uploaded at the facility (GET ehr/documents, GET
--                          ehr/documents/:id/download); any other document
--                          answers 404, as an unknown one does (Q112 A).
-- A login holding the full code (ocr.job.read, ehr.document.read) through any
-- role keeps the full read; the -own codes narrow nobody.
--
-- C1 The front desk (receptionist) may scan paper records into a patient's
--    file. Six rows:
--      receptionist  ehr.document.write     upload the scan (POST
--                                           ehr/documents/upload-intents and
--                                           :id/complete)
--      receptionist  ehr.document.read-own  see its own uploads, to pick one
--                                           for reading
--      receptionist  ocr.job.write          start and retry the reading, and
--                                           ask the patient for records
--                                           processing (0104 D2)
--      receptionist  ocr.job.start          (with ocr.job.write) start and
--                                           retry the reading
--      receptionist  ocr.job.read-own       follow the readings of its own
--                                           uploads, without their text
--      receptionist  ehr.vital.read         see vitals (C2)
--    Not given: ehr.document.read, ocr.job.read, ocr.validation.write,
--    ocr.patient.confirm, ocr.publication.write. Every file and reading still
--    needs the patient's access (a consent grant, or records processing under
--    0104/0108/0113), exactly as for anyone else.
-- C2 The front desk may see vitals (the ehr.vital.read row above).
-- C3 Nurses and clinicians keep starting readings: two rows,
--      nurse      ocr.job.start
--      clinician  ocr.job.start
--    Nothing else changes for them.
-- C4 Doctors lose the leftover Outreach permissions and the lab and pharmacy
--    queue reads (six rows), and do not get ocr.job.start:
--      doctor  outreach.campaign.read, outreach.campaign.write,
--              outreach.registration.read, outreach.registration.write
--                                         (Q97 already keeps doctors off
--                                         outreach.; the rows were left over)
--      doctor  lab.work-item.read         the laboratory's whole work list
--      doctor  pharmacy.work-item.read    the pharmacy's whole work list
--    Doctors keep ocr.job.write, ocr.job.read, ocr.validation.write,
--    ocr.patient.confirm and ocr.publication.write (Q111 A),
--    lab.work-item.accept (sending a lab request to their own laboratory when
--    it is activated), ehr.lab-request.read and ehr.prescription.read (their
--    own orders' progress, ORD-3, live) and lab.result.released.read.
-- C5 Laboratory staff lose visit reading and paper readings (four rows):
--      lab  ehr.encounter.read
--      lab  ocr.job.read, ocr.job.write, ocr.validation.write
--    They keep their own work (lab.work-item.*, lab.accession.*,
--    lab.specimen.*, lab.execution.*, lab.result.*, lab.order-route.receive)
--    and ehr.lab-request.read/write.
-- C6 Hospital administrators (admin) lose the lab and pharmacy queue reads
--    (two rows):
--      admin  lab.work-item.read
--      admin  pharmacy.work-item.read
--    They keep running staff (workforce.manage), settings
--    (organization.manage), audit.read, approving new patients
--    (identity.registration.approve) and ocr.job.read.
-- Unchanged on purpose (asserted below): admin identity.registration.approve,
-- nurse ehr.note.write, doctor ocr.job.write, ocr.validation.write and
-- ocr.patient.confirm. org_admin holds neither queue read, so it is not
-- touched.
--
-- Staff counts and the stop (Q113 A). Before changing anything,
-- the block do $count_0136$ (the same text, character for character, as in
-- docs/rollback/0136_affected_staff_counts.sql) counts 26 lines and prints
-- each as a NOTICE "0136 count n: ..." with the owner's maximum: lines 1-20,
-- one per row added or removed (active staff memberships at real facilities
-- that actually gain or lose it, and the distinct staff logins behind them,
-- and the same at the sealed QA and demo tenants), line 21 the doctors who
-- stop being able to start a reading, lines 22-24 facilities left with
-- nobody who can check a reading or confirm its patient, line 25 the open
-- records-processing requests step 4 closes, line 26 readings not yet checked
-- at the facilities of line 22. Then, for lines 1-24, if a number at real
-- facilities is above the owner's maximum below, which is 0 for every line
-- (Q113 A: no real staff are active yet), 0136 stops with error 55000 and
-- changes nothing. The sealed QA and demo tenants (fictional staff) and lines
-- 25-26 (they move by the hour) are printed only. Numbers only: no name,
-- email, account, membership, facility or patient id. The migration runner
-- forwards these lines to the release's dry-run and apply logs.
--
-- Undo: docs/rollback/0136_rollback.sql puts back exactly what each role
-- could do before 0136. It is not in the ledger; it becomes the next
-- migration number only if the owner signs it.
--
-- 0. Preconditions (each failure raises 55000 and nothing is applied):
--    0001-0127 applied (auth.session_single_sign_on is the marker); the six
--    roles and the permission codes this file names exist and are active, and
--    the three new codes do not exist yet; every row to remove is present and
--    every row to add absent (otherwise "0136: the role table is not in the
--    reviewed state"); the rows kept on purpose are present.
-- 1. The owner's maximums. 2. Counts (NOTICE) and the stop. 3. The change.
-- 4. Closing the open records-processing requests of staff who lost
-- ocr.job.write. 5. Post-checks.
-- Locks, taken first, NOWAIT: SHARE ROW EXCLUSIVE on auth.permissions,
-- auth.role_permissions and identity.access_requests for the transaction
-- (other writers wait, for example a new access request or a patient's
-- approval; every reader goes on), taken before the reads, so no
-- records-processing request can be made or approved between the snapshot
-- and the close; ROW EXCLUSIVE on audit.events, ROW SHARE on auth.roles, and
-- ACCESS SHARE on the tables the counts and checks read (auth.accounts,
-- auth.account_roles, identity.staff, identity.staff_facility_memberships,
-- identity.facilities, identity.organizations and the sealed demo and QA
-- member lists). That is every existing table this file locks (pg_locks
-- before commit), at the strongest mode it takes.
-- A busy table fails the attempt at once, and its subtransaction releases
-- what it took. The attempt is made again every 100 ms for at most 5 seconds,
-- so the file never waits while holding a lock and no request queues behind
-- a waiting lock; then 55P03 (nothing applied; the release can run again).
-- When this transaction already holds an earlier migration's locks that stop
-- other sessions' reads or writes (the runner's dry run applies every pending
-- file in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied, instead of keeping those locks while this file waits. Indexes are
-- locked only by planning (ACCESS SHARE), which only a REINDEX or DROP INDEX
-- could hold up.

do $locks$
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
begin
  loop
    attempt := attempt + 1;
    begin
      lock table auth.permissions, auth.role_permissions, identity.access_requests
        in share row exclusive mode nowait;
      lock table audit.events
        in row exclusive mode nowait;
      lock table auth.roles
        in row share mode nowait;
      lock table auth.accounts, auth.account_roles, identity.staff, identity.staff_facility_memberships, identity.facilities, identity.organizations, identity.sealed_demo_members, identity.sealed_qa_members
        in access share mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0136: auth.permissions, auth.role_permissions, identity.access_requests, audit.events or a table 0136 reads (the roles, accounts, staff, memberships, facilities, organizations and sealed member lists) is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0136: auth.permissions, auth.role_permissions, identity.access_requests, audit.events or a table 0136 reads (the roles, accounts, staff, memberships, facilities, organizations and sealed member lists) stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

do $preconditions$
declare
  missing text;
begin
  if to_regclass('auth.session_single_sign_on') is null
     or to_regclass('auth.permissions') is null
     or to_regclass('auth.role_permissions') is null
     or to_regclass('auth.account_roles') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('identity.sealed_demo_members') is null
     or to_regclass('identity.sealed_qa_members') is null
     or to_regclass('identity.access_requests') is null
     or to_regclass('ocr.jobs') is null
     or to_regclass('audit.events') is null then
    raise exception using errcode = '55000', message = '0136: 0001-0127 must be applied first';
  end if;

  select string_agg(code, ', ' order by code) into missing
    from (values ('receptionist'), ('doctor'), ('lab'), ('admin'), ('nurse'), ('clinician')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0136: role missing or inactive: ' || missing;
  end if;

  select string_agg(code, ', ' order by code) into missing
    from (values ('ehr.document.write'), ('ehr.document.read'), ('ocr.job.write'), ('ocr.job.read'),
                 ('ehr.vital.read'), ('outreach.campaign.read'), ('outreach.campaign.write'),
                 ('outreach.registration.read'), ('outreach.registration.write'), ('lab.work-item.read'),
                 ('pharmacy.work-item.read'), ('ehr.encounter.read'), ('ocr.validation.write'),
                 ('ocr.patient.confirm'), ('identity.registration.approve'), ('ehr.note.write')) wanted(code)
   where not exists (select 1 from auth.permissions permission_row
                      where permission_row.code = wanted.code and permission_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0136: permission missing or inactive: ' || missing;
  end if;

  select string_agg(code, ', ' order by code) into missing
    from auth.permissions where code in ('ocr.job.start', 'ocr.job.read-own', 'ehr.document.read-own');
  if missing is not null then
    raise exception using errcode = '55000', message = '0136: the new permission codes already exist: ' || missing;
  end if;

  -- The reviewed state: every row to remove present, every row to add absent.
  select string_agg(change.role_code || ' ' || change.permission_code, ', '
                    order by change.role_code, change.permission_code) into missing
    from (values
      ('receptionist', 'ehr.document.write', 'add'), ('receptionist', 'ocr.job.write', 'add'),
      ('receptionist', 'ehr.vital.read', 'add'),
      ('doctor', 'outreach.campaign.read', 'remove'), ('doctor', 'outreach.campaign.write', 'remove'),
      ('doctor', 'outreach.registration.read', 'remove'), ('doctor', 'outreach.registration.write', 'remove'),
      ('doctor', 'lab.work-item.read', 'remove'), ('doctor', 'pharmacy.work-item.read', 'remove'),
      ('lab', 'ehr.encounter.read', 'remove'),
      ('lab', 'ocr.job.read', 'remove'), ('lab', 'ocr.job.write', 'remove'), ('lab', 'ocr.validation.write', 'remove'),
      ('admin', 'lab.work-item.read', 'remove'), ('admin', 'pharmacy.work-item.read', 'remove'),
      -- Not added by 0136, and the front desk must not hold them either.
      ('receptionist', 'ehr.document.read', 'add'), ('receptionist', 'ocr.job.read', 'add')
    ) change(role_code, permission_code, action)
   where (change.action = 'remove') <> exists (
           select 1 from auth.role_permissions row_now
            where row_now.role_code = change.role_code and row_now.permission_code = change.permission_code);
  if missing is not null then
    raise exception using errcode = '55000', message = '0136: the role table is not in the reviewed state: ' || missing;
  end if;

  if (select count(*) from auth.role_permissions
       where (role_code, permission_code) in (('admin', 'identity.registration.approve'), ('nurse', 'ehr.note.write'),
                                              ('doctor', 'ocr.job.write'), ('doctor', 'ocr.validation.write'),
                                              ('doctor', 'ocr.patient.confirm'))) <> 5 then
    raise exception using errcode = '55000',
      message = '0136: admin identity.registration.approve, nurse ehr.note.write and doctor ocr.job.write, ocr.validation.write and ocr.patient.confirm must be present';
  end if;
end
$preconditions$;

-- 1. THE OWNER'S MAXIMUMS (owner decisions Q113 A and Q134 B): 0 at real
-- facilities on every line except lines 13, 14, 19, 20 and 21, which Q134 B
-- raised to the counts printed on 21 November 2026 (see the header). The owner says no real (non-sealed) staff are active yet, so
-- 0136 may touch none of them: it stops and changes nothing if any of lines
-- 1-24 counts anyone (or, for lines 22-24, any facility) at a real facility.
-- The sealed QA and demo tenants' fictional staff are counted apart and
-- never stop it. Nothing is filled in at signing. If real staff are active by
-- the time 0136 applies, it stops in the release's dry run, and the owner
-- decides again with the printed counts (a changed number changes the file
-- and needs a new signature). Lines 22-24 count facilities, so their staff
-- logins stay null.
select set_config('zero136.owner_maximums', (
  select jsonb_agg(jsonb_build_object('line', maximum.line, 'real_count', maximum.real_count,
                                      'logins', maximum.logins))::text
    from (values
      -- line, at real facilities, staff logins at real facilities
      ( 1, 0, 0),
      ( 2, 0, 0),
      ( 3, 0, 0),
      ( 4, 0, 0),
      ( 5, 0, 0),
      ( 6, 0, 0),
      ( 7, 0, 0),
      ( 8, 0, 0),
      ( 9, 0, 0),
      (10, 0, 0),
      (11, 0, 0),
      (12, 0, 0),
      (13, 1, 1),
      (14, 1, 1),
      (15, 0, 0),
      (16, 0, 0),
      (17, 0, 0),
      (18, 0, 0),
      (19, 9, 9),
      (20, 9, 9),
      (21, 1, 1),
      (22, 0, null),
      (23, 0, null),
      (24, 0, null)
    ) maximum(line, real_count, logins)), true);

-- 2. Counts, before the change, and the comparison with the owner's maximums
-- (the same block as docs/rollback/0136_affected_staff_counts.sql).
do $count_0136$
-- 0136's count (the same text in docs/rollback/0136_affected_staff_counts.sql
-- and in the migration). It counts, keeps the answer in the session setting
-- zero136.counts (numbers only), and, when the caller set the owner's maximums
-- in zero136.owner_maximums (0136 does, from its own text), compares each of
-- lines 1-24 with them: zero136.maximums_checked says whether it compared,
-- zero136.over_maximums names every line that is higher ('' when none).
declare
  hidden text;
  lines jsonb;
  places_left jsonb;
  place_row jsonb;
  waiting bigint;
  unchecked_real bigint := 0;
  unchecked_sealed bigint := 0;
  session_facility text := current_setting('app.facility_id', true);
  maximums_text text := coalesce(current_setting('zero136.owner_maximums', true), '');
  maximums jsonb;
  over text;
  line_row record;
begin
  perform set_config('zero136.counts', '', false), set_config('zero136.maximums_checked', 'no', false),
          set_config('zero136.over_maximums', '', false);
  -- The numbers are right only if this login sees every row it counts. Row
  -- security hides rows of the access requests and of the sealed QA and demo
  -- lists from any login but the database owner (the login the migrations use)
  -- and a login that bypasses row security; then this stops with a plain
  -- message instead of answering numbers that are too low.
  select string_agg(table_name, ', ' order by table_name) into hidden
    from unnest(array['auth.permissions', 'auth.role_permissions', 'auth.roles', 'auth.accounts',
                      'auth.account_roles', 'identity.staff_facility_memberships', 'identity.staff',
                      'identity.facilities', 'identity.organizations', 'identity.sealed_demo_members',
                      'identity.sealed_qa_members', 'identity.access_requests']) table_name
   where row_security_active(table_name::regclass);
  if hidden is not null then
    raise exception using errcode = '42501',
      message = '0136 counts: this login cannot see every row of ' || hidden
        || ', so the numbers would be too low. Run it with the database owner''s login (the one the migrations use) in a read-only session.';
  end if;
  if exists (select 1 from auth.permissions
              where code in ('ocr.job.start', 'ocr.job.read-own', 'ehr.document.read-own')) then
    raise exception using errcode = '55000',
      message = '0136 counts: this database already has 0136''s new permissions, so 0136 has already run here and there is nothing left to count.';
  end if;

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
  -- The role table today ('now') and as 0136 leaves it ('after').
  role_table as (
    select 'now' as stage, grant_row.role_code, grant_row.permission_code
      from auth.role_permissions grant_row
    union all
    select 'after', grant_row.role_code, grant_row.permission_code
      from auth.role_permissions grant_row
     where not exists (select 1 from change
                        where change.action = 'loses' and change.role_code = grant_row.role_code
                          and change.permission_code = grant_row.permission_code)
    union all
    select 'after', change.role_code, change.permission_code from change where change.action = 'gains'
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
  assignment as (
    select live.id as membership_id, live.account_id, live.facility_id, live.sealed, role_row.code as role_code
      from live_membership live
      join auth.account_roles assignment_row
        on assignment_row.membership_id = live.id and assignment_row.facility_id = live.facility_id
       and assignment_row.account_id = live.account_id and assignment_row.scope_type = 'facility'
       and assignment_row.revoked_at is null
      join auth.roles role_row on role_row.code = assignment_row.role_code and role_row.active
  ),
  -- Lines 1-20: each membership holding the changed role. A gain changes
  -- nothing for a membership whose other role grants the code today; a loss
  -- changes nothing for one whose other role still grants it after 0136.
  holder as (
    select change.position, assignment.membership_id, assignment.account_id, assignment.sealed,
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
  ),
  -- Each active membership's codes today and after 0136, through all its
  -- active roles, and what it can do with paper readings. Starting a reading
  -- needs ocr.job.write and the source read (ocr.job.read) today; after 0136
  -- it needs ocr.job.write, ocr.job.start and ocr.job.read or ocr.job.read-own.
  -- Checking needs ocr.job.write and ocr.validation.write, confirming the
  -- patient ocr.job.write and ocr.patient.confirm (both run under records
  -- processing, which needs ocr.job.write).
  member as (
    select assignment.membership_id as id, assignment.account_id, assignment.facility_id, assignment.sealed,
           bool_or(assignment.role_code = 'doctor') as doctor,
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
           member.now_codes @> array['ocr.job.write', 'ocr.validation.write'] as checks_now,
           member.after_codes @> array['ocr.job.write', 'ocr.validation.write'] as checks_after,
           member.after_codes @> array['ocr.job.write', 'ocr.patient.confirm'] as confirms_after,
           member.now_codes @> array['ocr.job.write', 'ocr.job.read'] as starts_now,
           member.after_codes @> array['ocr.job.write', 'ocr.job.start']
             and member.after_codes && array['ocr.job.read', 'ocr.job.read-own'] as starts_after,
           'ocr.job.write' = any(member.now_codes) as writes_now,
           'ocr.job.write' = any(member.after_codes) as writes_after
      from member
  ),
  place as (
    select ability.facility_id, ability.sealed, bool_or(ability.checks_now) as checks_now,
           bool_or(ability.checks_after) as checks_after, bool_or(ability.confirms_after) as confirms_after,
           bool_or(ability.starts_after) as starts_after
      from ability
     group by ability.facility_id, ability.sealed
  ),
  line(position, what, real_count, real_logins, sealed_count) as (
    select change.position, change.role_code || ' ' || change.action || ' ' || change.permission_code,
           count(holder.membership_id) filter (where not holder.sealed and not holder.covered),
           count(distinct holder.account_id) filter (where not holder.sealed and not holder.covered),
           count(holder.membership_id) filter (where holder.sealed and not holder.covered)
      from change
      left join holder on holder.position = change.position
     group by change.position, change.role_code, change.action, change.permission_code
    union all
    select 21, 'doctors who can start a reading today and cannot after 0136',
           count(*) filter (where not ability.sealed), count(distinct ability.account_id) filter (where not ability.sealed),
           count(*) filter (where ability.sealed)
      from ability
     where ability.doctor and ability.starts_now and not ability.starts_after
    union all
    select 22, 'facilities where staff can check a reading today and nobody can after 0136',
           count(*) filter (where not place.sealed), null::bigint, count(*) filter (where place.sealed)
      from place
     where place.checks_now and not place.checks_after
    union all
    select 23, 'facilities where after 0136 staff can start a reading and nobody can check it',
           count(*) filter (where not place.sealed), null::bigint, count(*) filter (where place.sealed)
      from place
     where place.starts_after and not place.checks_after
    union all
    select 24, 'facilities where after 0136 staff can start a reading and nobody can confirm its patient',
           count(*) filter (where not place.sealed), null::bigint, count(*) filter (where place.sealed)
      from place
     where place.starts_after and not place.confirms_after
    union all
    select 25, 'open records-processing requests from staff who lose ocr.job.write (0136 closes them)',
           count(request_row.id) filter (where not ability.sealed), null::bigint,
           count(request_row.id) filter (where ability.sealed)
      from ability
      join identity.access_requests request_row
        on request_row.membership_id = ability.id and request_row.facility_id = ability.facility_id
       and request_row.status = 'pending' and request_row.purpose_of_use = 'healthcare-operations'
       and not request_row.break_glass and request_row.migration_hold_reason is null
     where ability.writes_now and not ability.writes_after
  )
  select (select jsonb_agg(jsonb_build_object('line', line.position, 'what', line.what, 'real_count', line.real_count,
                                              'logins', line.real_logins, 'sealed_count', line.sealed_count)
                           order by line.position)
            from line),
         (select coalesce(jsonb_agg(jsonb_build_object('facility', place.facility_id, 'sealed', place.sealed)),
                          '[]'::jsonb)
            from place
           where place.checks_now and not place.checks_after)
    into lines, places_left;

  -- Line 26: readings not yet checked (queued, being read, read, or waiting
  -- for their check) at the facilities of line 22. OCR readings are read under
  -- their facility's row security even by the database owner, so this names
  -- each facility in turn (transaction-local, as 0107 does) and puts the
  -- setting back. The facility ids stay inside this block.
  for place_row in select value from jsonb_array_elements(places_left) loop
    perform set_config('app.facility_id', place_row ->> 'facility', true);
    select count(*) into waiting from ocr.jobs job
     where job.facility_id = (place_row ->> 'facility')::uuid
       and job.status in ('queued', 'processing', 'extracted', 'awaiting_validation');
    if (place_row ->> 'sealed')::boolean then
      unchecked_sealed := unchecked_sealed + waiting;
    else
      unchecked_real := unchecked_real + waiting;
    end if;
  end loop;
  perform set_config('app.facility_id', coalesce(session_facility, ''), true);
  lines := lines || jsonb_build_array(jsonb_build_object('line', 26,
    'what', 'readings not yet checked at the facilities of line 22', 'real_count', unchecked_real, 'logins', null,
    'sealed_count', unchecked_sealed));
  perform set_config('zero136.counts', lines::text, false);

  -- The owner's maximums (0136 sets them from its own text; this file does
  -- not). A line not filled in allows nobody: it stops wherever that line
  -- touches anyone at a real facility.
  if maximums_text = '' then
    return;
  end if;
  maximums := maximums_text::jsonb;
  if jsonb_typeof(maximums) <> 'array'
     or (select count(*) from jsonb_array_elements(maximums)) <> 24
     or (select count(distinct (item ->> 'line')::integer) from jsonb_array_elements(maximums) item
          where (item ->> 'line')::integer between 1 and 24) <> 24 then
    raise exception using errcode = '55000',
      message = '0136: the owner''s maximums must list lines 1 to 24, once each; nothing was changed.';
  end if;
  for line_row in
    select counted.line, counted.what, counted.real_count, counted.logins, counted.sealed_count,
           (allowed.item ->> 'real_count')::bigint as real_maximum, (allowed.item ->> 'logins')::bigint as logins_maximum,
           allowed.item ->> 'real_count' is not null and (counted.logins is null or allowed.item ->> 'logins' is not null)
             as filled
      from jsonb_to_recordset(lines) counted(line integer, what text, real_count bigint, logins bigint, sealed_count bigint)
      left join lateral (select item from jsonb_array_elements(maximums) item
                          where (item ->> 'line')::integer = counted.line) allowed on true
     order by counted.line
  loop
    if line_row.line > 24 then
      raise notice '0136 count %: %: % at real facilities, % at the sealed QA and demo tenants (printed only).',
        line_row.line, line_row.what, line_row.real_count, line_row.sealed_count;
      continue;
    end if;
    raise notice '0136 count %: %: % at real facilities%, % at the sealed QA and demo tenants; the owner''s maximum: %.',
      line_row.line, line_row.what, line_row.real_count,
      case when line_row.logins is null then '' else ' (' || line_row.logins || ' staff logins)' end, line_row.sealed_count,
      case when not line_row.filled then 'not filled in'
           else line_row.real_maximum
                || case when line_row.logins is null then '' else ' (' || line_row.logins_maximum || ' staff logins)' end
      end;
    if line_row.real_count > coalesce(line_row.real_maximum, 0)
       or (line_row.logins is not null and line_row.logins > coalesce(line_row.logins_maximum, 0)) then
      over := coalesce(over || '; ', '') || 'line ' || line_row.line || ' (' || line_row.what || ') is now '
        || line_row.real_count
        || case when line_row.logins is null then '' else ' (' || line_row.logins || ' staff logins)' end
        || case when not line_row.filled then ' and the owner''s maximum is not filled in'
                else ', more than the owner''s ' || line_row.real_maximum
                     || case when line_row.logins is null then '' else ' (' || line_row.logins_maximum || ')' end
           end;
    end if;
  end loop;
  perform set_config('zero136.maximums_checked', 'yes', false),
          set_config('zero136.over_maximums', coalesce(over, ''), false);
end
$count_0136$;

-- The stop (Q113 A): nothing below runs unless every line 1-24 is within the
-- owner's maximum, 0 at real facilities.
do $owner_maximums$
begin
  if coalesce(current_setting('zero136.maximums_checked', true), '') <> 'yes' then
    raise exception using errcode = '55000',
      message = '0136 stopped, nothing was changed: the counts were not compared with the owner''s maximums.';
  end if;
  if coalesce(current_setting('zero136.over_maximums', true), '') <> '' then
    raise exception using errcode = '55000',
      message = '0136 stopped, nothing was changed: real staff would be affected, and the owner approved 0136 '
        || 'only while none are active (Q113 A): '
        || current_setting('zero136.over_maximums')
        || '. Show the owner these counts (docs/rollback/0136_affected_staff_counts.sql prints them read-only); 0136 changes nothing until the owner decides again.';
  end if;
end
$owner_maximums$;

-- Open records-processing requests whose staff member holds ocr.job.write
-- now, by the check every service and 0104's trigger use; 0136 closes those
-- whose staff member no longer holds it after the change (step 4).
create temporary table zero136_records_processing_requests on commit drop as
select request_row.id
  from identity.access_requests request_row
  join identity.staff_facility_memberships membership on membership.id = request_row.membership_id
  join auth.accounts account_row on account_row.id = membership.account_id
 where request_row.status = 'pending' and request_row.purpose_of_use = 'healthcare-operations'
   and not request_row.break_glass and request_row.migration_hold_reason is null
   and coalesce(auth.membership_has_permission(account_row.subject, request_row.membership_id,
                  request_row.facility_id, 'ocr.job.write'), false);

-- 3. The change.
insert into auth.permissions (code, description) values
  ('ocr.job.start', 'Start or retry a paper-record reading (OCR job); needs ocr.job.write as well'),
  ('ocr.job.read-own', 'Follow the readings of documents this login uploaded at the facility, without their text'),
  ('ehr.document.read-own', 'List and open only the documents this login uploaded at the facility');

delete from auth.role_permissions
 where (role_code, permission_code) in (
   ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
   ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
   ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
   ('lab', 'ehr.encounter.read'),
   ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'), ('lab', 'ocr.validation.write'),
   ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'));

insert into auth.role_permissions (role_code, permission_code) values
  ('receptionist', 'ehr.document.write'),
  ('receptionist', 'ehr.document.read-own'),
  ('receptionist', 'ocr.job.write'),
  ('receptionist', 'ocr.job.start'),
  ('receptionist', 'ocr.job.read-own'),
  ('receptionist', 'ehr.vital.read'),
  ('nurse', 'ocr.job.start'),
  ('clinician', 'ocr.job.start');

-- 4. Close the open records-processing requests made by staff who lost
-- ocr.job.write here (laboratory staff with no other role that grants it;
-- doctors keep it, Q111 A). 0104's trigger checks ocr.job.write only when a
-- request is made, so without this a patient could still approve one, and
-- the grant would show in their access history but never work (0104 D8,
-- 0108 and 0113 check ocr.job.write at each use). Status 'expired', as 0086
-- and 0096 close pending requests; one audit row per request (system actor,
-- the plain reason, ids only, no patient detail), the patient's own audit
-- trail shows it. The undo does not reopen them: the staff member asks again.
do $close_requests$
declare
  closed integer;
begin
  with closed_request as (
    update identity.access_requests request_row
       set status = 'expired', updated_at = clock_timestamp(), row_version = request_row.row_version + 1
      from identity.staff_facility_memberships membership
      join auth.accounts account_row on account_row.id = membership.account_id
     where request_row.id in (select snapshot.id from zero136_records_processing_requests snapshot)
       and request_row.status = 'pending'
       and membership.id = request_row.membership_id
       and not coalesce(auth.membership_has_permission(account_row.subject, request_row.membership_id,
                          request_row.facility_id, 'ocr.job.write'), false)
    returning request_row.id, request_row.patient_id, request_row.facility_id, request_row.scope
  ), audited as (
    insert into audit.events (
      correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, reason, provenance, source_system, details
    )
    select '0136-role-permission-changes', 'system', closed_request.facility_id, closed_request.patient_id,
           'identity.access-request.close', 'success', 'access-request', closed_request.id::text,
           'healthcare-operations', 'This staff member can no longer process records', 'migration', 'hid-0136',
           jsonb_build_object('migration', '0136', 'status', 'expired', 'scope', closed_request.scope)
      from closed_request
    returning 1
  )
  select count(*) into closed from audited;
  raise notice '0136 closed % open records-processing requests (staff who no longer hold ocr.job.write).', closed;
end
$close_requests$;

-- 5. Post-checks: exactly the twelve rows gone, the eight rows and three
-- codes there, the kept rows still there, the front desk without the full
-- reads, and no open records-processing request left from a staff member who
-- lost ocr.job.write here.
do $postchecks$
begin
  if exists (select 1 from auth.role_permissions
              where (role_code, permission_code) in (
                ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
                ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
                ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
                ('lab', 'ehr.encounter.read'),
                ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'), ('lab', 'ocr.validation.write'),
                ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'),
                ('receptionist', 'ehr.document.read'), ('receptionist', 'ocr.job.read'),
                ('doctor', 'ocr.job.start'), ('lab', 'ocr.job.start')))
     or (select count(*) from auth.permissions
          where code in ('ocr.job.start', 'ocr.job.read-own', 'ehr.document.read-own') and active) <> 3
     or (select count(*) from auth.role_permissions
          where (role_code, permission_code) in (
            ('receptionist', 'ehr.document.write'), ('receptionist', 'ehr.document.read-own'),
            ('receptionist', 'ocr.job.write'), ('receptionist', 'ocr.job.start'),
            ('receptionist', 'ocr.job.read-own'), ('receptionist', 'ehr.vital.read'),
            ('nurse', 'ocr.job.start'), ('clinician', 'ocr.job.start'))) <> 8
     or (select count(*) from auth.role_permissions
          where (role_code, permission_code) in (('admin', 'identity.registration.approve'), ('nurse', 'ehr.note.write'),
                                                 ('doctor', 'ocr.job.write'), ('doctor', 'ocr.validation.write'),
                                                 ('doctor', 'ocr.patient.confirm'))) <> 5
     or exists (select 1
                  from identity.access_requests request_row
                  join zero136_records_processing_requests snapshot on snapshot.id = request_row.id
                  join identity.staff_facility_memberships membership on membership.id = request_row.membership_id
                  join auth.accounts account_row on account_row.id = membership.account_id
                 where request_row.status = 'pending'
                   and not coalesce(auth.membership_has_permission(account_row.subject, request_row.membership_id,
                                      request_row.facility_id, 'ocr.job.write'), false)) then
    raise exception using errcode = '55000', message = '0136: post-check failed';
  end if;
end
$postchecks$;
