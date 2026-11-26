-- 0177 NUR-1 Nursing on the ward: who uses the medicine round, nursing tasks,
-- clinical shifts and handover, and sealed test shifts (Release D, the
-- department sprint the owner approved on 25 November 2026, verbatim: "I
-- approve Q147–Q290 at the recommended options"). Written on
-- claude/sprint-inpatient-backend at e224bc62 (staging at 0cfddcc9) after
-- 0174-0176 in the same pull request. The number is provisional (given at
-- merge). It needs 0174-0176 and ADT-1's 0173. It pins no role's whole code
-- list: only that no nursing code exists yet and that every other row of the
-- role table is the same after it as before. The declaration in
-- config/production-schema-compatibility.json stays unsigned until the owner
-- signs this file. It is its own file so Rahman can review who gets the
-- nursing functions apart from the tables.
--
-- Owner decisions (25 November 2026, each at its recommended option): Q200 A
-- (their own access codes and a "nursing" department switch), Q193 A
-- (clinical shifts), and the section's smaller choice Q-NUR-16 A (no shift
-- seeded for real facilities; the sealed QA and demo facilities get the three
-- starting shifts, fictional).
--
-- What it changes (nothing else):
-- C1 auth.permissions          seven codes: ehr.mar.read (the medicine round),
--                              ehr.mar.record (record a dose, mark one entered
--                              in error), ehr.nursing-task.read (tasks,
--                              shifts, assignments and handover sheets),
--                              ehr.nursing-task.write (create, start,
--                              complete, cancel and change tasks),
--                              ehr.handover.write (handover notes, give and
--                              accept), ehr.shift-assignment.manage (assign
--                              nurses, the nurse in charge and the on-call
--                              doctor) and ehr.clinical-shift.manage (set up
--                              the facility's clinical shifts).
-- C2 auth.role_permissions     nineteen rows:
--                                nurse      mar.read, mar.record,
--                                           nursing-task.read and .write,
--                                           handover.write,
--                                           shift-assignment.manage
--                                clinician  mar.read, mar.record,
--                                           nursing-task.read and .write,
--                                           handover.write
--                                doctor     mar.read, mar.record,
--                                           nursing-task.read and .write
--                                admin      shift-assignment.manage,
--                                           clinical-shift.manage
--                                org_admin  shift-assignment.manage,
--                                           clinical-shift.manage
--                              Observations and fluid balance keep
--                              ehr.vital.read and ehr.vital.write (Q-NUR-6 A);
--                              inpatient orders keep ehr.prescription.write.
-- C3 audit.events              one row per role row added, as the system
--                              actor: auth.role-permission.add, resource
--                              role-permission "<role>/<code>", reason "NUR-1
--                              Nursing (Release D, owner decision Q200 A)".
-- C4 Sealed test shifts (Q-NUR-16 A, Q163 A): only where 0123 installed QA
--    Hospital, and at the sealed demo facilities (0098) with a nurse,
--    clinician or doctor: Morning 07:30-14:30, Afternoon 14:00-21:00 and Night
--    20:30-08:00 (Lagos time; the overlaps are handover time), each unless an
--    active shift of that name is already there; one audit row per shift
--    (ehr.clinical-shift.sealed-seed, as the system actor). Nothing else. On
--    every other database (CI, acceptance, rehearsals, throwaway clusters,
--    production without the QA tenant) nothing is written there and a NOTICE
--    says so.
-- Permissions are read from the role table on every request, so the change
-- applies from each signed-in member's next request; nobody is signed out.
-- ehr-api's NURSING_ENABLED still keeps every route closed in production until
-- the owner's go-live. Without this file no role holds a nursing code, so
-- every new function refuses: the database half of "built but switched off".
-- The closing NOTICE prints how many active memberships at real (not sealed)
-- facilities gain each code.
--
-- Locks, taken first, NOWAIT: SHARE ROW EXCLUSIVE on auth.role_permissions
-- (other writers wait; every reader goes on); ROW EXCLUSIVE on
-- auth.permissions, ehr.clinical_shifts and audit.events; ROW SHARE on
-- auth.roles, identity.staff_facility_memberships and identity.facilities (the
-- foreign key checks of the new rows); ACCESS SHARE on auth.account_roles,
-- auth.accounts, identity.sealed_demo_members and identity.sealed_qa_members
-- (read by the sealed checks). A busy
-- table fails the attempt at once, and its subtransaction releases what it
-- took. The attempt is made 50 times, 100 ms apart (about 5 seconds); then
-- 55P03 (nothing applied). When this transaction already holds an earlier
-- migration's locks that stop other sessions' reads or writes, one attempt and
-- no sleep: 55P03 at once, nothing applied. Both refusals begin "0177: " and
-- end "run the release again at a quieter time" (#306).
--
-- Undo (not in the ledger; a migration only if the owner signs it): take the
-- nineteen rows out of auth.role_permissions (or mark the seven codes
-- inactive); every member is back where 0176 left them (no nursing functions)
-- from the next request.
--
-- The whole file is one statement (do $nur0177$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0173-0176 applied; "0177:
--    already applied" when the seven codes and exactly the nineteen rows are
--    there; "0177: the schema is not in the reviewed state" for any half
--    state; the five roles active; auth.membership_has_permission as 0001-0176
--    leave it (md5).
-- 2. C1-C4.
-- 3. Post-checks: the nursing rows are exactly the nineteen; every other row
--    of the role table is unchanged; exactly nineteen role audit rows and
--    three seed rows per sealed facility.

do $nur0177$
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
  v_reason constant text := 'NUR-1 Nursing (Release D, owner decision Q200 A)';
  v_correlation constant text := '0177-nursing-nur1';
  -- The nineteen rows, in byte order (role, then code), joined by ','.
  v_rows_expected constant text := 'admin ehr.clinical-shift.manage,admin ehr.shift-assignment.manage,'
    || 'clinician ehr.handover.write,clinician ehr.mar.read,clinician ehr.mar.record,clinician ehr.nursing-task.read,'
    || 'clinician ehr.nursing-task.write,doctor ehr.mar.read,doctor ehr.mar.record,doctor ehr.nursing-task.read,'
    || 'doctor ehr.nursing-task.write,nurse ehr.handover.write,nurse ehr.mar.read,nurse ehr.mar.record,'
    || 'nurse ehr.nursing-task.read,nurse ehr.nursing-task.write,nurse ehr.shift-assignment.manage,'
    || 'org_admin ehr.clinical-shift.manage,org_admin ehr.shift-assignment.manage';
  v_codes constant text[] := array['ehr.mar.read', 'ehr.mar.record', 'ehr.nursing-task.read',
    'ehr.nursing-task.write', 'ehr.handover.write', 'ehr.shift-assignment.manage', 'ehr.clinical-shift.manage'];
  v_rows_before text;
  v_audited integer;
  v_sealed record;
  v_creator uuid;
  v_seeded_facilities integer := 0;
  v_seeded_shifts integer := 0;
  v_shift record;
  v_new uuid;
  v_gain record;
begin
  -- Before the locks (catalog reads only): the files whose tables step 0 locks.
  if to_regclass('ehr.clinical_shifts') is null then
    raise exception using errcode = '55000', message = '0177: 0174-0176 must be applied first';
  end if;

  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table auth.role_permissions in share row exclusive mode nowait;
  lock table auth.permissions, ehr.clinical_shifts, audit.events in row exclusive mode nowait;
  lock table auth.roles, identity.staff_facility_memberships, identity.facilities in row share mode nowait;
  lock table auth.account_roles, auth.accounts, identity.sealed_demo_members, identity.sealed_qa_members
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0177: the role table, the clinical shifts, audit.events or a table 0177''s rows check or read is '
          || 'busy, and this transaction already holds an earlier migration''s locks, so it does not wait; nothing '
          || 'applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0177: the role table, the clinical shifts, audit.events or a table 0177''s rows check or read '
          || 'stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regprocedure('ehr.observation_chart(uuid, timestamptz, timestamptz, boolean)') is null
     or to_regprocedure('ehr.mar_read(uuid, timestamptz, timestamptz)') is null
     or to_regprocedure('ehr.handover_accept(uuid, bigint, text, text)') is null
     or not exists (select 1 from auth.permissions where code = 'ehr.ward.read') then
    raise exception using errcode = '55000', message = '0177: 0173-0176 must be applied first';
  end if;
  if (select count(*) from auth.permissions where code = any (v_codes) and active) = 7
     and (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                            order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
            from auth.role_permissions grant_row where grant_row.permission_code = any (v_codes))
         is not distinct from v_rows_expected then
    raise exception using errcode = '55000', message = '0177: already applied';
  end if;
  if exists (select 1 from auth.permissions where code = any (v_codes))
     or exists (select 1 from auth.role_permissions where permission_code = any (v_codes)) then
    raise exception using errcode = '55000',
      message = '0177: the schema is not in the reviewed state (a nursing code or row is there, but not exactly what '
        || '0177 leaves); nothing applied';
  end if;
  select string_agg(code, ', ' order by code) into v_missing
    from (values ('nurse'), ('clinician'), ('doctor'), ('admin'), ('org_admin')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if v_missing is not null then
    raise exception using errcode = '55000', message = '0177: role missing or inactive: ' || v_missing;
  end if;
  select string_agg(expected.signature, ', ') into v_missing
    from (values
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_missing is not null then
    raise exception using errcode = '55000', message = '0177: these bodies are not as 0001-0176 left them: ' || v_missing;
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into v_rows_before from auth.role_permissions grant_row;

  -- 2. C1. The seven codes.
  insert into auth.permissions (code, description) values
    ('ehr.mar.read', 'See the medicine round of admitted patients (NUR-1, 0177)'),
    ('ehr.mar.record', 'Record a dose as given, held, refused, omitted or not available, and mark one entered in error (NUR-1, 0177)'),
    ('ehr.nursing-task.read', 'See nursing tasks, clinical shifts, shift assignments and handover sheets (NUR-1, 0177)'),
    ('ehr.nursing-task.write', 'Create, start, complete, cancel and change nursing tasks (NUR-1, 0177)'),
    ('ehr.handover.write', 'Write handover notes, and give or accept a shift handover (NUR-1, 0177)'),
    ('ehr.shift-assignment.manage', 'Assign nurses, the nurse in charge and the on-call doctor to wards and patients for a shift (NUR-1, 0177)'),
    ('ehr.clinical-shift.manage', 'Set up this facility''s clinical shifts (NUR-1, 0177)');

  -- C2. The nineteen rows (Q200 A).
  insert into auth.role_permissions (role_code, permission_code) values
    ('nurse', 'ehr.mar.read'), ('nurse', 'ehr.mar.record'), ('nurse', 'ehr.nursing-task.read'),
    ('nurse', 'ehr.nursing-task.write'), ('nurse', 'ehr.handover.write'), ('nurse', 'ehr.shift-assignment.manage'),
    ('clinician', 'ehr.mar.read'), ('clinician', 'ehr.mar.record'), ('clinician', 'ehr.nursing-task.read'),
    ('clinician', 'ehr.nursing-task.write'), ('clinician', 'ehr.handover.write'),
    ('doctor', 'ehr.mar.read'), ('doctor', 'ehr.mar.record'), ('doctor', 'ehr.nursing-task.read'),
    ('doctor', 'ehr.nursing-task.write'),
    ('admin', 'ehr.shift-assignment.manage'), ('admin', 'ehr.clinical-shift.manage'),
    ('org_admin', 'ehr.shift-assignment.manage'), ('org_admin', 'ehr.clinical-shift.manage');

  -- C3. One audit row per role row, as the system actor.
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  )
  select v_correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', v_reason, 'migration',
         'hid-0177',
         jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0177', 'decision', 'Q200 A')
    from auth.role_permissions grant_row
   where grant_row.permission_code = any (v_codes)
   order by grant_row.role_code collate "C", grant_row.permission_code collate "C";

  -- C4. Sealed test shifts (Q-NUR-16 A): QA Hospital where 0123 installed it, and the sealed demo facilities.
  for v_sealed in
    select facility.id as facility_id
      from identity.facilities facility
     where facility.active
       and ((facility.id = 'c0a00002-0000-4000-8000-000000000001' and identity.sealed_qa_facility(facility.id))
            or (identity.sealed_demo_facility(facility.id)
                and exists (select 1 from identity.sealed_demo_members member
                             where member.member_kind = 'facility' and member.member_id = facility.id)))
       and exists (select 1 from identity.staff_facility_memberships membership
                     join auth.account_roles assignment on assignment.membership_id = membership.id
                      and assignment.revoked_at is null and assignment.scope_type = 'facility'
                    where membership.facility_id = facility.id and membership.active
                      and assignment.role_code in ('nurse', 'clinician', 'doctor'))
     order by facility.id
  loop
    select membership.id into v_creator
      from identity.staff_facility_memberships membership
      join auth.account_roles assignment on assignment.membership_id = membership.id
       and assignment.revoked_at is null and assignment.scope_type = 'facility'
     where membership.facility_id = v_sealed.facility_id and membership.active
     order by (assignment.role_code in ('admin', 'org_admin')) desc, membership.id
     limit 1;
    for v_shift in
      select * from (values ('Morning', time '07:30', time '14:30'), ('Afternoon', time '14:00', time '21:00'),
                            ('Night', time '20:30', time '08:00')) seeded(shift_name, starts, ends)
    loop
      if exists (select 1 from ehr.clinical_shifts shift
                  where shift.facility_id = v_sealed.facility_id and shift.active
                    and lower(shift.name) = lower(v_shift.shift_name)) then
        continue;
      end if;
      insert into ehr.clinical_shifts (facility_id, name, starts_at, ends_at, created_by_membership_id,
        updated_by_membership_id)
      values (v_sealed.facility_id, v_shift.shift_name, v_shift.starts, v_shift.ends, v_creator, v_creator)
      returning id into v_new;
      insert into audit.events (correlation_id, actor_type, facility_id, action, outcome, resource_type, resource_id,
        purpose_of_use, reason, provenance, source_system, details)
      values (v_correlation, 'system', v_sealed.facility_id, 'ehr.clinical-shift.sealed-seed', 'success',
        'clinical-shift', v_new::text, 'healthcare-operations', 'Sealed test shift (0177, Q-NUR-16 A)', 'migration',
        'hid-0177', jsonb_build_object('startsAt', to_char(v_shift.starts, 'HH24:MI'),
          'endsAt', to_char(v_shift.ends, 'HH24:MI'), 'migration', '0177'));
      v_seeded_shifts := v_seeded_shifts + 1;
    end loop;
    v_seeded_facilities := v_seeded_facilities + 1;
  end loop;
  if v_seeded_facilities = 0 then
    raise notice '0177: no sealed QA or demo facility with nurses, clinicians or doctors is installed here: no test shift written';
  end if;

  -- 3. Post-checks.
  select count(*) into v_audited from audit.events event_row
   where event_row.correlation_id = v_correlation and event_row.action = 'auth.role-permission.add';
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                        order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row where grant_row.permission_code = any (v_codes))
     is distinct from v_rows_expected
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                           ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
           from auth.role_permissions grant_row where not grant_row.permission_code = any (v_codes))
        is distinct from v_rows_before
     or (select count(*) from auth.permissions where code = any (v_codes) and active) <> 7
     or v_audited <> 19
     or (select count(*) from audit.events event_row
          where event_row.correlation_id = v_correlation and event_row.action = 'ehr.clinical-shift.sealed-seed')
        <> v_seeded_shifts then
    raise exception using errcode = '55000', message = '0177: post-check failed (the role table or its audit rows)';
  end if;

  -- What the rows give, at real (not sealed) facilities: the active memberships that gain each code.
  select count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.mar.read') as mar_read,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.mar.record') as mar_record,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.nursing-task.read') as task_read,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.nursing-task.write') as task_write,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.handover.write') as handover,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.shift-assignment.manage') as assign,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.clinical-shift.manage') as setup
    into v_gain
    from identity.staff_facility_memberships membership
    join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
    join auth.role_permissions grant_row on grant_row.role_code = assignment.role_code
   where membership.active and membership.facility_id is not null
     and grant_row.permission_code = any (v_codes)
     and not identity.sealed_demo_facility(membership.facility_id)
     and not identity.sealed_qa_facility(membership.facility_id);
  raise notice '0177: the nursing codes are given (Q200 A): at real facilities ehr.mar.read is now held by % active staff memberships, ehr.mar.record by %, ehr.nursing-task.read by %, ehr.nursing-task.write by %, ehr.handover.write by %, ehr.shift-assignment.manage by %, ehr.clinical-shift.manage by %; nineteen role rows, nineteen audit rows; % sealed test shifts at % facilities.',
    v_gain.mar_read, v_gain.mar_record, v_gain.task_read, v_gain.task_write, v_gain.handover, v_gain.assign,
    v_gain.setup, v_seeded_shifts, v_seeded_facilities;
end
$nur0177$;
