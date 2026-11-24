-- 0150 Q141 B: every doctor can start or retry a paper-record reading again.
-- Written on staging-novu-ci-20261005 at d519e5d1 (0001-0149 applied:
-- Release A, Release B and Release C, live since 24 November 2026 19:47
-- UTC). Numbers are given at merge; this owner-requested change takes 0150
-- (the coordinator moves the provisional bookings after it). The declaration
-- in config/production-schema-compatibility.json is signed separately: its
-- reviewed_by stays as it is until the owner signs this file.
--
-- Owner decision (D-Eminence, 24 November 2026), verbatim:
--   "Q141 B and add front-desk or nurse login"
-- This file is the "Q141 B" part only: every doctor gets back the start of a
-- paper-record reading, the one part of Q111 A that 0136 applied by not
-- giving doctors the new code ocr.job.start (0136's header, C4: "do not get
-- ocr.job.start"). 0136's line 21 counted 1 doctor at real facilities who
-- could start a reading before 0136 and could not after it (Q134 B); 0147
-- (Q137 B) gave that one doctor the narrow role reading_starter. Q141 B gives
-- the start to the doctor role itself, so every doctor, at every facility
-- (the sealed demo and QA tenants' fictional doctors too), starts and retries
-- readings again, exactly as before 0136. The rest of Q111 A, Q103 A and
-- Q112 A is unchanged: doctors keep everything else 0136 left them and gain
-- nothing else; no other role changes. 0147's two narrow roles stay as they
-- are, with their rows and their assignments: the counted doctor then holds
-- ocr.job.start through both doctor and reading_starter, which changes
-- nothing for that doctor (and SX-4 still revokes reading_starter with
-- doctor, as 0147 made it).
--
-- What it changes (nothing else):
-- E1 auth.role_permissions  one new row: doctor, ocr.job.start. ocr-api asks
--                           for ocr.job.write and ocr.job.start to start
--                           (POST ocr/jobs) or retry (POST
--                           ocr/jobs/:jobId/retry) a reading; doctors hold
--                           ocr.job.write and ocr.job.read (kept by Q111 A),
--                           so with this row they start, retry and follow
--                           readings again. Every file and reading still needs
--                           the patient's access (a consent grant, or records
--                           processing under 0104/0108/0113), exactly as for
--                           anyone else.
-- E2 audit.events           one row, as the system actor (no account,
--                           membership, facility or patient):
--                           auth.role-permission.add, resource
--                           role-permission "doctor/ocr.job.start", reason
--                           "Owner decision Q141 B (24 November 2026): every
--                           doctor starts paper readings again", details the
--                           role, the permission, the migration and the
--                           decision.
-- No function, policy, grant or table changes, so runtime-grants.sql is
-- unchanged. Permissions are read from this table on every request
-- (auth.membership_has_permission and the Identity staff context), so the
-- change applies from each signed-in doctor's next request; nobody is signed
-- out. No service or image changes: ocr-api already asks for exactly these
-- two codes (0136), and Release C's records-processing runtime verifier
-- already uses a doctor when doctors hold ocr.job.start.
--
-- Locks, taken first, NOWAIT: SHARE ROW EXCLUSIVE on auth.role_permissions for
-- the transaction (other writers wait; every reader, each staff request's
-- permission check included, goes on), so the role table cannot change
-- between the preconditions and the post-checks; ROW EXCLUSIVE on
-- audit.events (the audit row); ROW SHARE on auth.roles and auth.permissions
-- (the foreign key checks of the new row; the preconditions read them) and
-- on auth.accounts, identity.staff_facility_memberships,
-- identity.organizations, identity.facilities and identity.patients (the
-- foreign key checks of the audit row open every table it references at ROW
-- SHARE, even for a null key). That is every existing table this file locks,
-- at the strongest mode it takes (pg_locks before commit; the suite compares
-- them). Besides tables it locks only indexes, at ACCESS SHARE (planning) or
-- ROW EXCLUSIVE (the new rows' index entries), and audit.events' identity
-- sequence (ROW EXCLUSIVE, for the audit row's number); the preconditions and
-- post-checks read the catalog (pg_proc, pg_class, pg_namespace, pg_database,
-- pg_locks) at ACCESS SHARE, which only DDL or maintenance that holds a
-- catalog (VACUUM FULL, REINDEX) would make wait, and no service runs either.
-- A busy table fails the attempt at once, and its subtransaction releases
-- every lock the attempt took. The attempt is made 50 times, 100 ms apart
-- (about 5 seconds), so the file never waits for one of its locks while
-- holding the others and no request queues behind such a wait; then 55P03
-- (nothing applied; the release can run again). When this transaction
-- already holds an earlier migration's locks that stop other sessions' reads
-- or writes (the runner's dry run applies every pending file in one
-- transaction), one attempt and no sleep: 55P03 at once, nothing applied,
-- instead of keeping those locks while this file waits. Both refusals begin
-- "0150: " and end "run the release again at a quieter time", so the
-- runner's dry run rolls back and tries again (hid-system#306). Other waits
-- are not NOWAIT, and the runner's lock_timeout ends each after 5 seconds
-- (55P03 lock timeout: not a busy refusal, so not retried; nothing applied):
-- a row of auth.roles or auth.permissions that another session holds FOR
-- UPDATE (the new row's foreign key checks), DDL in flight on audit.events'
-- identity sequence, or an index or catalog that maintenance holds.
--
-- Undo (not in the ledger; a migration only if the owner signs it): take the
-- one row (role doctor, permission ocr.job.start) out of
-- auth.role_permissions again. Every doctor is then back where 0136 and 0147
-- left them from the next request (the counted doctor keeps reading_starter).
--
-- The whole file is one statement (do $q141b$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (each failure raises 55000 and nothing is applied):
--    0001-0149 applied (a marker of each of 0147, 0148 and 0149); the row
--    doctor, ocr.job.start is absent ("0150: already applied" when it is
--    there and the role table is exactly as this file leaves it; any other
--    state with the row: "0150: the role table is not in the reviewed
--    state"); the roles doctor and reading_starter and the permissions
--    ocr.job.start, ocr.job.write and ocr.job.read exist and are active;
--    the doctor's rows are exactly as Release C leaves them (35 codes, md5
--    pinned below, in byte order: ocr.job.write and ocr.job.read among them,
--    ocr.job.start not); ocr.job.start is held by exactly clinician, nurse,
--    reading_starter and receptionist (0136 C1 and C3, 0147 D2);
--    reading_starter holds ocr.job.start only; auth.membership_has_permission,
--    which every service's permission check calls, is as Release C leaves it
--    (md5 pinned below, so it still reads the role's rows on every request).
-- 2. The row and its audit row (E1, E2).
-- 3. Post-checks: the doctor holds exactly the pinned codes plus
--    ocr.job.start (md5 pinned below); every other row of the role table is
--    unchanged (compared row by row with the table before step 2);
--    ocr.job.start is held by exactly clinician, doctor, nurse,
--    reading_starter and receptionist; 0147's two roles and their rows are
--    unchanged (this file writes no assignment); exactly one audit row of
--    this file.

do $q141b$
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
  q141b_reason constant text := 'Owner decision Q141 B (24 November 2026): every doctor starts paper readings again';
  -- The doctor's codes as Release C leaves them (0001-0149), and with this
  -- file's row: md5 of the codes in byte order (collate "C", so the database's
  -- own collation does not matter), joined by ','.
  doctor_before_md5 constant text := '186a1ece641bffd2be5ebb05b80479b2';
  doctor_after_md5 constant text := '9da3f7c9be69ae834e9f7a7555eb3e07';
  -- auth.membership_has_permission(text,uuid,uuid,text) as Release C leaves it.
  permission_check_md5 constant text := '65e3eaff93fe729fd5c5b986b80c9dd6';
  rows_before text;
  narrow_before text;
  audited integer;
begin
  loop
  attempt := attempt + 1;
  begin
  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  lock table auth.role_permissions
    in share row exclusive mode nowait;
  lock table audit.events
    in row exclusive mode nowait;
  lock table auth.roles, auth.permissions, auth.accounts, identity.staff_facility_memberships,
             identity.organizations, identity.facilities, identity.patients
    in row share mode nowait;
  exit;

  exception when lock_not_available then
    -- Only these NOWAIT locks are in the attempt, so only they are retried.
    if holding then
      raise exception using errcode = '55P03',
        message = '0150: auth.role_permissions, audit.events or a table 0150''s rows check (the roles, permissions, '
          || 'accounts, staff memberships, organizations, facilities and patients) is busy, and this transaction '
          || 'already holds an earlier migration''s locks, so it does not wait; nothing applied; run the release '
          || 'again at a quieter time';
    end if;
    if attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0150: auth.role_permissions, audit.events or a table 0150''s rows check (the roles, permissions, '
          || 'accounts, staff memberships, organizations, facilities and patients) stayed busy for 5 seconds; '
          || 'nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- A marker of each of 0147, 0148 and 0149 (each file's own "already
  -- applied" test).
  if not exists (select 1 from auth.roles where code = 'reading_starter')
     or not exists (select 1 from auth.roles where code = 'work_list_reader')
     or to_regclass('pharmacy.prescription_changes_after_dispensing') is null
     or to_regclass('ehr.catalog_versions') is null
     or to_regclass('migration.schema_migrations') is null then
    raise exception using errcode = '55000', message = '0150: 0001-0149 must be applied first';
  end if;

  -- Already applied: the row is there and the doctor's codes are exactly what
  -- this file leaves.
  if exists (select 1 from auth.role_permissions
              where role_code = 'doctor' and permission_code = 'ocr.job.start') then
    if (select md5(string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C"))
          from auth.role_permissions grant_row where grant_row.role_code = 'doctor')
       is not distinct from doctor_after_md5 then
      raise exception using errcode = '55000', message = '0150: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0150: the role table is not in the reviewed state (doctor already holds ocr.job.start, '
        || 'with other codes than 0150 leaves); nothing applied';
  end if;

  select string_agg(code, ', ' order by code) into missing
    from (values ('doctor'), ('reading_starter')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0150: role missing or inactive: ' || missing;
  end if;

  select string_agg(code, ', ' order by code) into missing
    from (values ('ocr.job.start'), ('ocr.job.write'), ('ocr.job.read')) wanted(code)
   where not exists (select 1 from auth.permissions permission_row
                      where permission_row.code = wanted.code and permission_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0150: permission missing or inactive: ' || missing;
  end if;

  -- The doctor's codes, who holds ocr.job.start, and reading_starter's codes,
  -- as Release C leaves them.
  if (select md5(string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C"))
        from auth.role_permissions grant_row where grant_row.role_code = 'doctor')
     is distinct from doctor_before_md5
     or (select count(*) from auth.role_permissions grant_row where grant_row.role_code = 'doctor') <> 35
     or (select string_agg(grant_row.role_code, ',' order by grant_row.role_code collate "C")
           from auth.role_permissions grant_row where grant_row.permission_code = 'ocr.job.start')
        is distinct from 'clinician,nurse,reading_starter,receptionist'
     or (select string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C")
           from auth.role_permissions grant_row where grant_row.role_code = 'reading_starter')
        is distinct from 'ocr.job.start' then
    raise exception using errcode = '55000',
      message = '0150: the role table is not in the reviewed state (the doctor''s codes, the holders of '
        || 'ocr.job.start or reading_starter''s codes differ from Release C); nothing applied';
  end if;

  -- The permission check every service calls reads the role's rows on every
  -- request, as Release C leaves it.
  if to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)'))
        is distinct from permission_check_md5 then
    raise exception using errcode = '55000',
      message = '0150: auth.membership_has_permission is not as Release C leaves it; nothing applied';
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into rows_before from auth.role_permissions grant_row;
  select string_agg(to_jsonb(role_row)::text, ',' order by role_row.code collate "C")
    into narrow_before
    from auth.roles role_row where role_row.code in ('reading_starter', 'work_list_reader');

  -- 2. The row and its audit row.
  insert into auth.role_permissions (role_code, permission_code) values ('doctor', 'ocr.job.start');

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  ) values (
    '0150-doctors-start-readings-q141b', 'system', 'auth.role-permission.add', 'success', 'role-permission',
    'doctor/ocr.job.start', 'healthcare-operations', q141b_reason, 'migration', 'hid-0150',
    jsonb_build_object('roleCode', 'doctor', 'permissionCode', 'ocr.job.start', 'migration', '0150',
                       'decision', 'Q141 B')
  );

  -- 3. Post-checks.
  select count(*) into audited from audit.events event_row
   where event_row.correlation_id = '0150-doctors-start-readings-q141b';
  if (select md5(string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C"))
        from auth.role_permissions grant_row where grant_row.role_code = 'doctor')
     is distinct from doctor_after_md5
     or (select count(*) from auth.role_permissions grant_row where grant_row.role_code = 'doctor') <> 36
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                           ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
           from auth.role_permissions grant_row
          where (grant_row.role_code, grant_row.permission_code) <> ('doctor', 'ocr.job.start'))
        is distinct from rows_before
     or (select string_agg(grant_row.role_code, ',' order by grant_row.role_code collate "C")
           from auth.role_permissions grant_row where grant_row.permission_code = 'ocr.job.start')
        is distinct from 'clinician,doctor,nurse,reading_starter,receptionist'
     or (select string_agg(to_jsonb(role_row)::text, ',' order by role_row.code collate "C")
           from auth.roles role_row where role_row.code in ('reading_starter', 'work_list_reader'))
        is distinct from narrow_before
     or audited <> 1 then
    raise exception using errcode = '55000', message = '0150: post-check failed';
  end if;

  raise notice '0150: doctors hold ocr.job.start again (Q141 B): every doctor starts and retries paper readings from the next request; one audit row.';
end
$q141b$;
