-- 0144 Q134 B: admins and doctors get back the laboratory's and the pharmacy's
-- work lists, and doctors get back starting a reading (Release B). Written on
-- staging-novu-ci-20261005 at 06f98040 (0001-0137 applied: Release A, live
-- since 23 November 2026). Release B applies 0138-0143 first; none of them
-- adds or removes a row this file adds, and this file reads nothing they add,
-- so it needs only 0001-0137.
--
-- Owner decision Q134 B (D-Eminence, in chat, 22 November 2026 at about
-- 20:36 UTC, as config/production-schema-compatibility.json records it):
-- "Q134 B: accept 0136's losses for 9 admins and 1 doctor; raise its limits
-- to these counts and restore their when done". The coordinator's
-- instruction (hid-system#258, 22 November 2026, and the plan of 23 November
-- 2026): "give back lab.work-item.read and pharmacy.work-item.read to admin
-- and doctor, and ocr.job.start to doctor". The coordinator chose the role
-- rows over a role for only those ten staff (hid-system#258, 23 November
-- 2026); the owner confirms it by signing this file.
--
-- Five rows (auth.role_permissions, role_code / permission_code), each one
-- 0136 removed (C4, C6) or did not give (C4, Q111 A):
--   admin   lab.work-item.read        the laboratory's whole work list
--   admin   pharmacy.work-item.read   the pharmacy's whole work list
--   doctor  lab.work-item.read        the laboratory's whole work list
--   doctor  pharmacy.work-item.read   the pharmacy's whole work list
--   doctor  ocr.job.start             start or retry a paper-record reading;
--                                     doctors kept ocr.job.write (Q111 A), so
--                                     with this row they can start one again
-- These rows apply to every admin and doctor at every facility, the sealed
-- QA and demo tenants included, as before 0136. Nothing else 0136 did changes:
-- doctors stay off outreach.*, laboratory staff stay off visit reading and
-- paper readings, the front desk keeps its six rows, nurses and clinicians
-- keep ocr.job.start, and the three codes 0136 added stay. The open
-- records-processing requests 0136 closed stay closed: it closed only those of
-- staff who lost ocr.job.write, and no row here gives that back.
--
-- No function, policy, grant or table changes, so runtime-grants.sql is
-- unchanged. Permissions are read from this table on every request
-- (auth.membership_has_permission and the Identity staff context), so the
-- change takes effect on each signed-in staff member's next request; nobody is
-- signed out. No service change is needed: lab-api, pharmacy-api and ocr-api
-- already ask for these codes, and identity-api's product gate already shows
-- the laboratory's and the pharmacy's work lists to whoever holds them.
--
-- The declaration in config/production-schema-compatibility.json is signed
-- separately: its reviewed_by stays empty until the owner signs it there.
--
-- Locks, taken first, NOWAIT: SHARE ROW EXCLUSIVE on auth.role_permissions
-- (other writers wait; every reader, including each request's permission
-- check, goes on), and ROW SHARE on auth.roles and auth.permissions, which
-- the five rows reference. That is every existing table this file locks
-- (pg_locks before commit), at the strongest mode it takes; their indexes
-- are locked only by planning and the key checks (ACCESS SHARE, ROW SHARE),
-- which only a REINDEX or DROP INDEX could hold up. A busy table
-- fails the attempt at once, and its subtransaction releases what it took.
-- The attempt is made again every 100 ms for at most 5 seconds, so the file
-- never waits while holding a lock; then 55P03 (nothing applied; the release
-- can run again). When this transaction already holds an earlier migration's
-- locks that stop other sessions' reads or writes (the runner's dry run
-- applies every pending file in one transaction), one attempt and no sleep:
-- 55P03 at once, nothing applied.
--
-- Undo: delete the five rows (0136's C4 and C6 rows again). It becomes a
-- migration only if the owner signs it.
--
-- 0. Locks. In one block: 1. Preconditions (55000, nothing applied).
-- 2. The five rows. 3. The post-check.

-- 0. Locks (see Locks above), NOWAIT, at most 5 s; one attempt when this
-- transaction already holds an earlier migration's locks.
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
      lock table auth.role_permissions in share row exclusive mode nowait;
      lock table auth.roles, auth.permissions in row share mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0144: the role table (auth.role_permissions, auth.roles or auth.permissions) is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0144: the role table (auth.role_permissions, auth.roles or auth.permissions) stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1-3 in one block, so a refusal stops the file at its first error.
do $restore$
declare
  missing text;
begin
  -- 1. Preconditions: 0136 applied and its role rows as it left them.
  if to_regclass('identity.qoreid_nin_checks') is null then
    raise exception using errcode = '55000', message = '0144: 0001-0137 must be applied first';
  end if;

  select string_agg(code, ', ' order by code) into missing
    from (values ('admin'), ('doctor')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0144: role missing or inactive: ' || missing;
  end if;

  select string_agg(code, ', ' order by code) into missing
    from (values ('lab.work-item.read'), ('pharmacy.work-item.read'), ('ocr.job.start'), ('ocr.job.write'))
         wanted(code)
   where not exists (select 1 from auth.permissions permission_row
                      where permission_row.code = wanted.code and permission_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0144: permission missing or inactive: ' || missing;
  end if;

  if (select count(*) from auth.role_permissions
       where (role_code, permission_code) in (
         ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'),
         ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
         ('doctor', 'ocr.job.start'))) = 5 then
    raise exception using errcode = '55000', message = '0144: already applied';
  end if;

  -- The state 0136 left: the five rows absent, doctors still holding
  -- ocr.job.write (Q111 A), and 0136's other rows as it left them.
  select string_agg(expected.role_code || ' ' || expected.permission_code, ', '
                    order by expected.role_code, expected.permission_code) into missing
    from (values
      ('admin', 'lab.work-item.read', false), ('admin', 'pharmacy.work-item.read', false),
      ('doctor', 'lab.work-item.read', false), ('doctor', 'pharmacy.work-item.read', false),
      ('doctor', 'ocr.job.start', false), ('doctor', 'ocr.job.write', true),
      ('doctor', 'outreach.campaign.read', false), ('doctor', 'outreach.campaign.write', false),
      ('doctor', 'outreach.registration.read', false), ('doctor', 'outreach.registration.write', false),
      ('lab', 'ehr.encounter.read', false), ('lab', 'ocr.job.read', false), ('lab', 'ocr.job.write', false),
      ('lab', 'ocr.validation.write', false), ('lab', 'ocr.job.start', false),
      ('receptionist', 'ehr.document.read', false), ('receptionist', 'ocr.job.read', false),
      ('receptionist', 'ocr.job.start', true), ('nurse', 'ocr.job.start', true),
      ('clinician', 'ocr.job.start', true)
    ) expected(role_code, permission_code, present)
   where expected.present <> exists (
           select 1 from auth.role_permissions row_now
            where row_now.role_code = expected.role_code and row_now.permission_code = expected.permission_code);
  if missing is not null then
    raise exception using errcode = '55000', message = '0144: the role table is not as 0136 left it: ' || missing;
  end if;

  -- 2. The five rows.
  insert into auth.role_permissions (role_code, permission_code) values
    ('admin', 'lab.work-item.read'),
    ('admin', 'pharmacy.work-item.read'),
    ('doctor', 'lab.work-item.read'),
    ('doctor', 'pharmacy.work-item.read'),
    ('doctor', 'ocr.job.start');

  -- 3. Post-check: the five rows there, and every other row the
  -- precondition read still as 0136 left it.
  if (select count(*) from auth.role_permissions
       where (role_code, permission_code) in (
         ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'),
         ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
         ('doctor', 'ocr.job.start'))) <> 5
     or exists (select 1 from auth.role_permissions
                 where (role_code, permission_code) in (
                   ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
                   ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
                   ('lab', 'ehr.encounter.read'), ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'),
                   ('lab', 'ocr.validation.write'), ('lab', 'ocr.job.start'),
                   ('receptionist', 'ehr.document.read'), ('receptionist', 'ocr.job.read')))
     or (select count(*) from auth.role_permissions
          where (role_code, permission_code) in (
            ('receptionist', 'ocr.job.start'), ('nurse', 'ocr.job.start'), ('clinician', 'ocr.job.start'),
            ('doctor', 'ocr.job.write'))) <> 4 then
    raise exception using errcode = '55000', message = '0144: post-check failed';
  end if;
end
$restore$;
