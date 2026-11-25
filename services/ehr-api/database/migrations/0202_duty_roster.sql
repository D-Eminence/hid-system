-- 0202 ROS-1 Shifts, rosters, HR and credentials: the duty roster and
-- attendance (Release D, the department sprint the owner approved on 25
-- November 2026, verbatim: "I approve Q147-Q290 at the recommended options").
-- Written on claude/sprint-hr-backend at 67a1099a (staging-novu-ci-20261005 at
-- 0cfddcc9: 0001-0153 applied) after 0199-0201 in the same pull request. The
-- number is provisional (given at merge). It needs NUR-1's 0176
-- (ehr.clinical_shifts: its columns and its (id, facility_id) key are checked
-- in the catalog; no 0176 function is called) and this lane's 0200 (leave and
-- in-charges; its helpers md5-pinned). It is kept last so 0199-0201 can be cut
-- and released before NUR-1; 0202 follows NUR-1 into a release. The
-- declaration in config/production-schema-compatibility.json stays unsigned
-- until the owner signs this file.
--
-- Owner decisions (25 November 2026, each at its recommended option): Q193 A
-- (the roster reuses NUR-1's clinical shifts and defines none of its own; it is
-- named "Duty roster"; the cashier's day stays the "till day"), Q242 A
-- (attendance is marked by an in-charge or administrator: present, absent or
-- swapped with who worked instead; no clock-in, no location, no device),
-- Q246 A (only memberships can be on the roster), Q161 A (online only; a paper
-- roster as the back-up). Smaller choices at the recommended option, not yet
-- answered by the owner: Q-ROS-9 A (published rosters are seen by every staff
-- role here; drafts by editors only), Q-ROS-10 A (a published roster changes
-- until each shift starts; every change is kept and the roster shows "changed
-- since published"), Q-ROS-11 A (overlap and rest are checked for one person
-- across every department of this facility, not across facilities). Q124 A's
-- pattern: the minimum rest is shipped as DRAFT data (8 hours) awaiting the
-- clinical lead, and only a signed migration changes it.
--
-- What it changes (nothing else):
-- R1 identity.duty_roster_rules: one row (id 1): min_rest_minutes 480,
--    clinical_status draft, changed_by_migration 0202. No runtime role may read
--    or write it. Never deleted.
-- R2 identity.duty_rosters: facility, organisation, department_code (0114's
--    codes), week_start (a Monday), status (draft, published), published_at
--    and by whom, publish_count, changed_since_published, who made it,
--    row_version. Unique per (facility, department, week). Never deleted.
-- R3 identity.duty_roster_assignments: roster, facility, membership and
--    account, shift_id (foreign key to ehr.clinical_shifts (id, facility_id)),
--    duty_date (the Lagos day the shift starts; within the roster's week, the
--    functions check), starts_at and ends_at (worked out from the shift's Lagos
--    times when the duty is saved: identity.duty_roster_shift_window, 0176's
--    ehr.clinical_shift_window formula), rest_until (ends_at plus the minimum
--    rest in force, set by the guard), status (active, removed) with who
--    removed it and when, attendance (not_marked, present, absent, swapped),
--    covered_by (exactly for swapped; never the person rostered), who marked it
--    and when, row_version. At most one active row per (membership, shift,
--    date). Removed rows are kept. Never deleted.
-- R4 identity.duty_roster_events, append-only: every roster made, save (counts
--    added, removed and kept), publish and attendance mark, with the
--    Idempotency-Key and the request's SHA-256 (unique per membership and key).
--    All four tables: row-level security enabled and forced, with only the
--    owner's four command policies (0086's staff_licence_attestations form);
--    no privilege for any runtime role; no identity column and no sequence.
--    Row DELETE and TRUNCATE are refused on all four (UPDATE too on the
--    events), with platform.reject_mutation().
-- R5 Trigger duty_roster_assignments_guard (BEFORE INSERT OR UPDATE OF status,
--    starts_at, ends_at, rest_until, for each row): for an active duty, it takes
--    the person's advisory lock (0200's 'workforce-person:<facility>:
--    <account>'), sets rest_until, and refuses (55000) a duty of the same
--    account at this facility, drafts included, that overlaps another
--    (DUTY_ROSTER_OVERLAP), one that starts less than the minimum rest after
--    another ends or ends less than the minimum rest before another starts
--    (DUTY_ROSTER_REST_TOO_SHORT; exactly the minimum is allowed), and one on a
--    day of the person's approved leave (DUTY_ROSTER_MEMBER_ON_LEAVE). This is
--    the database's own refusal, whatever writes the row.
-- R6 Trigger staff_leave_requests_roster_clash on 0200's
--    identity.staff_leave_requests (BEFORE UPDATE OF status, for each row, WHEN
--    the status becomes approved): takes the same lock and refuses (55000
--    LEAVE_CLASHES_WITH_ROSTER, the dates YYYY-MM-DD comma-separated in DETAIL)
--    while the person has active duties here on those days whose shifts have
--    not started. 0200's function bodies do not change: its decide function
--    answers this refusal as the outcome clashes_with_roster.
-- R7 Functions, SECURITY DEFINER with SET search_path = pg_catalog, pg_temp,
--    every object named with its schema, no temporary table; owned like
--    0139's (the migration owner); EXECUTE for hid_identity_runtime only:
--      identity.duty_roster_list(date)                     route 15
--      identity.duty_roster_read(uuid)                     route 16
--      identity.duty_roster_create(...)                    route 17
--      identity.duty_roster_assignments_set(...)           route 18
--      identity.duty_roster_publish(...)                   route 19
--      identity.duty_roster_attendance_mark(...)           route 20
--      identity.duty_roster_on_duty(text)                  route 21
--      identity.duty_roster_my_duties()                    route 22
--    Helpers no role may execute (SECURITY INVOKER, the same search_path):
--      identity.duty_roster_shift_window(uuid, date)       0176's formula
--      identity.duty_roster_week_ok(date)                  a Monday, 8 weeks
--                                                          ago to 26 ahead
--      identity.duty_roster_assignment_card(uuid)
--      identity.duty_roster_card(uuid, boolean)
--      identity.duty_roster_on_duty_at(uuid, timestamptz)  who is on duty at a
--        time (published rosters; absent left out; for swapped the member who
--        worked instead): Ambulance dispatch and Quality may call it from their
--        own functions later (md5-pinned by them)
--      identity.duty_roster_idempotency(uuid, text, text)
--      the two trigger functions.
--    Every function admits the caller with 0200's identity.workforce_actor:
--    workforce.roster.read for routes 15-21, an active membership for route
--    22. Editors of a department's roster are 0200's
--    identity.workforce_editor_departments: holders of workforce.roster.manage,
--    and its active in-charges while they hold workforce.roster.read.
--    Without 0201 nobody holds the codes, so every function but route 22
--    refuses (and route 22 has no duties to show).
-- R8 Audit, in the request's transaction, through 0200's
--    identity.workforce_audit. A refusal the function answers is written here;
--    a refusal it raises (42501, or 22023 for input identity-api never sends)
--    by identity-api's request audit: identity.duty-roster.list, .read,
--    .create, .assignments-set (counts added, removed and kept), .publish,
--    .attendance (the mark), .on-duty, .my-duties. Rows hold ids, codes, counts
--    and outcomes; never a name, a leave type or leave dates.
--
-- Locks (measured with pg_locks before commit and compared by the
-- workforce-migrations suite), taken first, NOWAIT: SHARE ROW EXCLUSIVE on
-- ehr.clinical_shifts, identity.staff_facility_memberships and
-- identity.facilities (the foreign keys of the new, empty tables) and on
-- identity.staff_leave_requests (the new trigger); ACCESS SHARE on
-- identity.workforce_department_in_charges and identity.facility_profiles
-- (read by the functions; nothing reads them while the file runs). A busy table
-- fails the attempt at once and its subtransaction releases what it took. The
-- attempt is made 50 times, 100 ms apart (about 5 seconds), so the file never
-- waits for one of its locks while holding the others; then 55P03 (nothing
-- applied). When this transaction already holds an earlier migration's locks
-- that stop other sessions' reads or writes (the runner's dry run), one attempt
-- and no sleep: 55P03 at once, nothing applied. Both refusals begin "0202: "
-- and end "run the release again at a quieter time" (#306).
--
-- Old images on this schema: nothing calls the new functions. The leave
-- trigger acts only inside 0200's decide function. identity-api's
-- DUTY_ROSTER_ENABLED (off by default) keeps routes 6-22 closed until the
-- owner's go-live; while it is on, a database without this file answers 503
-- DUTY_ROSTER_NOT_AVAILABLE for routes 15-22.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- two triggers, the functions and the four tables.
--
-- The whole file is one statement (do $hr0202$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): NUR-1's 0176 and this lane's 0200
--    applied; "0202: already applied" when every object of this file is there
--    exactly as it leaves it, "0202: the schema is not in the reviewed state"
--    for any other state with part of it; the bodies it calls md5-pinned (0200's
--    helpers among them); the columns it reads; the owner of these functions
--    may read ehr.clinical_shifts under its row-level security.
-- 2. R1-R7 and the grants.
-- 3. Post-checks in 0148's and 0152's form (owners; row-level security
--    enabled and forced with exactly the four owner command policies; no
--    privilege for any other role; no identity column or sequence; each
--    trigger's tgtype, tgqual, tgattr, tgnargs, tgfoid and tgenabled, and the
--    leave trigger's whole definition; each function's owner, SECURITY DEFINER
--    or not, fixed search_path, EXECUTE list and pinned body; the rule row).

do $hr0202$
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
  v_runtime boolean := exists (select 1 from pg_roles where rolname = 'hid_identity_runtime');
  v_owner oid := (select oid from pg_roles where rolname = current_user);
  v_mismatch text;
  v_present integer;
  v_tables constant text[] := array['identity.duty_roster_rules', 'identity.duty_rosters',
    'identity.duty_roster_assignments', 'identity.duty_roster_events'];
  -- Every function this file makes: signature, body md5, SECURITY DEFINER, EXECUTE for hid_identity_runtime.
  v_functions constant text[][] := array[
    ['identity.duty_roster_shift_window(uuid,date)', '2c4afdec5f9754644b8b0a63da112b6c', 'false', 'false'],
    ['identity.duty_roster_week_ok(date)', 'df83d31fb744fc6d7ef85e1503402379', 'false', 'false'],
    ['identity.duty_roster_assignment_card(uuid)', '0c126c231e19b64147d2308ce5587a44', 'false', 'false'],
    ['identity.duty_roster_card(uuid,boolean)', 'b61a1e496b2bcb19ee0bf9aabef395a8', 'false', 'false'],
    ['identity.duty_roster_on_duty_at(uuid,timestamp with time zone)', 'dd78aa9a0fbec3d0780946d719fba396', 'false',
     'false'],
    ['identity.duty_roster_idempotency(uuid,text,text)', '4e2d3b21203438567532cc7e1575b437', 'false', 'false'],
    ['identity.duty_roster_assignments_guard()', 'e7b66ef5d00e15e0a769c071254894bb', 'false', 'false'],
    ['identity.staff_leave_requests_roster_clash()', '20a044819bf8cf0984efc8b921e621ce', 'false', 'false'],
    ['identity.duty_roster_list(date)', 'b504fce965d8aa4491403a2fa4d94033', 'true', 'true'],
    ['identity.duty_roster_read(uuid)', '8256782de17a197bc5e789b22597cd15', 'true', 'true'],
    ['identity.duty_roster_create(text,date,text,text)', '0726a68cdee883e76ad237f3c5ac2ab1', 'true', 'true'],
    ['identity.duty_roster_assignments_set(uuid,bigint,jsonb,text,text)', 'e91170bb68b12fe0278c09469c84b8b4', 'true',
     'true'],
    ['identity.duty_roster_publish(uuid,bigint,text,text)', '1280ac902fc75c2e94434ac86908083c', 'true', 'true'],
    ['identity.duty_roster_attendance_mark(uuid,uuid,bigint,text,uuid,text,text)', '81bd2aa51bc6441ed0bc192abba82533',
     'true', 'true'],
    ['identity.duty_roster_on_duty(text)', 'c19676517045c134302f17a77dfa77f1', 'true', 'true'],
    ['identity.duty_roster_my_duties()', '894129e6d1de0afc9ac66b5d56c3cd81', 'true', 'true']];
  v_function_names constant text[] := array['duty_roster_shift_window', 'duty_roster_week_ok',
    'duty_roster_assignment_card', 'duty_roster_card', 'duty_roster_on_duty_at', 'duty_roster_idempotency',
    'duty_roster_assignments_guard', 'staff_leave_requests_roster_clash', 'duty_roster_list', 'duty_roster_read',
    'duty_roster_create', 'duty_roster_assignments_set', 'duty_roster_publish', 'duty_roster_attendance_mark',
    'duty_roster_on_duty', 'duty_roster_my_duties'];
  -- The plain triggers: table, name, tgtype (1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate).
  v_triggers constant text[][] := array[
    ['identity.duty_roster_rules', 'duty_roster_rules_no_delete', '11'],
    ['identity.duty_roster_rules', 'duty_roster_rules_no_truncate', '34'],
    ['identity.duty_rosters', 'duty_rosters_no_delete', '11'],
    ['identity.duty_rosters', 'duty_rosters_no_truncate', '34'],
    ['identity.duty_roster_assignments', 'duty_roster_assignments_no_delete', '11'],
    ['identity.duty_roster_assignments', 'duty_roster_assignments_no_truncate', '34'],
    ['identity.duty_roster_events', 'duty_roster_events_append_only', '27'],
    ['identity.duty_roster_events', 'duty_roster_events_no_truncate', '34']];
  v_clash_definition constant text := 'CREATE TRIGGER staff_leave_requests_roster_clash BEFORE UPDATE OF status ON '
    || 'identity.staff_leave_requests FOR EACH ROW WHEN (((new.status = ''approved''::text) AND (old.status IS '
    || 'DISTINCT FROM ''approved''::text))) EXECUTE FUNCTION identity.staff_leave_requests_roster_clash()';
  v_guard_definition constant text := 'CREATE TRIGGER duty_roster_assignments_guard BEFORE INSERT OR UPDATE OF '
    || 'status, starts_at, ends_at, rest_until ON identity.duty_roster_assignments FOR EACH ROW EXECUTE FUNCTION '
    || 'identity.duty_roster_assignments_guard()';
begin
  -- The markers of the tables step 0 locks (catalog reads only).
  if to_regclass('ehr.clinical_shifts') is null then
    raise exception using errcode = '55000', message = '0202: NUR-1''s 0176 (ehr.clinical_shifts) must be applied first';
  end if;
  if to_regclass('identity.staff_leave_requests') is null
     or to_regclass('identity.workforce_department_in_charges') is null then
    raise exception using errcode = '55000', message = '0202: 0200 must be applied first';
  end if;

  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0 reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table ehr.clinical_shifts, identity.staff_facility_memberships, identity.facilities,
    identity.staff_leave_requests
    in share row exclusive mode nowait;
  lock table identity.workforce_department_in_charges, identity.facility_profiles in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0202: the clinical shifts, staff memberships, facilities, leave requests or a table 0202 reads '
          || '(department in-charges, facility profiles) is busy, and this transaction already holds an earlier '
          || 'migration''s locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0202: the clinical shifts, staff memberships, facilities, leave requests or a table 0202 reads '
          || '(department in-charges, facility profiles) stayed busy for 5 seconds; nothing applied; run the release '
          || 'again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- Exactly applied, or not at all.
  select count(*) into v_present
    from (select to_regclass(name)::oid as object_id from unnest(v_tables) name
          union all
          select to_regprocedure(v_functions[idx][1])::oid from generate_subscripts(v_functions, 1) idx) present
   where present.object_id is not null;
  if v_present = 4 + array_length(v_functions, 1)
     and not exists (select 1 from generate_subscripts(v_functions, 1) idx
                      where (select md5(proc.prosrc) from pg_proc proc
                              where proc.oid = to_regprocedure(v_functions[idx][1]))
                            is distinct from v_functions[idx][2])
     and (select count(*) from generate_subscripts(v_triggers, 1) idx
            join pg_trigger trigger_row on trigger_row.tgrelid = to_regclass(v_triggers[idx][1])
                                       and trigger_row.tgname = v_triggers[idx][2]) = 8
     and exists (select 1 from pg_trigger trigger_row
                  where trigger_row.tgrelid = to_regclass('identity.staff_leave_requests')
                    and pg_get_triggerdef(trigger_row.oid) = v_clash_definition)
     and exists (select 1 from pg_trigger trigger_row
                  where trigger_row.tgrelid = to_regclass('identity.duty_roster_assignments')
                    and pg_get_triggerdef(trigger_row.oid) = v_guard_definition) then
    raise exception using errcode = '55000', message = '0202: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'identity' and proc.proname = any (v_function_names))
     or exists (select 1 from pg_trigger trigger_row
                 where trigger_row.tgrelid = 'identity.staff_leave_requests'::regclass
                   and trigger_row.tgname = 'staff_leave_requests_roster_clash') then
    raise exception using errcode = '55000',
      message = '0202: the schema is not in the reviewed state (part of 0202 is there); nothing applied';
  end if;

  -- The bodies this file calls: 0200's helpers as this lane made them, and 0001-0153's.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_mismatch
    from (values
      ('identity.workforce_actor(text)', '21279ebdacadfb4e469b1b0df6e09776'),
      ('identity.workforce_member_holds(uuid,text)', '387f9d0dce25909fe30c6978e1b533ff'),
      ('identity.workforce_facility_departments(uuid)', '2bf2f371dfc30b628ec3b8bd310ebeba'),
      ('identity.workforce_editor_departments(uuid)', 'e56b2e40e306ab4bd5e7528c0d181874'),
      ('identity.workforce_audit(text,uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb)',
       '38eb210c665b1d9a0588b344bb721ff1'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0202: these bodies are not as 0200 and 0001-0153 left them: '
      || v_mismatch;
  end if;
  select string_agg(wanted.relation || '.' || wanted.column_name, ', ' order by wanted.relation, wanted.column_name)
    into v_mismatch
    from (values
      ('ehr.clinical_shifts', 'id', 'uuid'), ('ehr.clinical_shifts', 'facility_id', 'uuid'),
      ('ehr.clinical_shifts', 'name', 'text'), ('ehr.clinical_shifts', 'starts_at', 'time without time zone'),
      ('ehr.clinical_shifts', 'ends_at', 'time without time zone'), ('ehr.clinical_shifts', 'active', 'boolean'),
      ('identity.staff_leave_requests', 'facility_id', 'uuid'), ('identity.staff_leave_requests', 'account_id', 'uuid'),
      ('identity.staff_leave_requests', 'membership_id', 'uuid'), ('identity.staff_leave_requests', 'status', 'text'),
      ('identity.staff_leave_requests', 'starts_on', 'date'), ('identity.staff_leave_requests', 'ends_on', 'date'),
      ('identity.workforce_department_in_charges', 'membership_id', 'uuid'),
      ('identity.workforce_department_in_charges', 'department_code', 'text'),
      ('identity.workforce_department_in_charges', 'ended_at', 'timestamp with time zone')
    ) wanted(relation, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = wanted.relation::regclass
                        and attribute_row.attname = wanted.column_name and attribute_row.attnum > 0
                        and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0202: these columns are not as 0176 and 0200 left them: '
      || v_mismatch;
  end if;
  -- The duties' foreign key needs 0176's unique (id, facility_id).
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'ehr.clinical_shifts'::regclass and constraint_row.contype = 'u'
                    and (select array_agg(attribute_row.attname::text order by attribute_row.attname)
                           from unnest(constraint_row.conkey) key_column(attnum)
                           join pg_attribute attribute_row on attribute_row.attrelid = constraint_row.conrelid
                                and attribute_row.attnum = key_column.attnum) = array['facility_id', 'id']) then
    raise exception using errcode = '55000', message = '0202: ehr.clinical_shifts has no unique (id, facility_id) key';
  end if;
  -- These functions run as their owner (this file's runner, as 0139's), which must read ehr.clinical_shifts under its
  -- row-level security: be its owner or hold its owner's privileges.
  if not pg_has_role(current_user, (select relation.relowner from pg_class relation
                                     where relation.oid = 'ehr.clinical_shifts'::regclass), 'USAGE') then
    raise exception using errcode = '55000',
      message = '0202: the owner of these functions cannot read ehr.clinical_shifts under its row-level security';
  end if;

  -- 2. R1. The rule (DRAFT, awaiting the clinical lead).
  create table identity.duty_roster_rules (
    id smallint primary key check (id = 1),
    min_rest_minutes integer not null check (min_rest_minutes between 0 and 1440),
    clinical_status text not null check (clinical_status in ('draft', 'signed')),
    changed_by_migration text not null check (changed_by_migration ~ '^[0-9]{4}$'),
    changed_at timestamptz not null default clock_timestamp()
  );
  insert into identity.duty_roster_rules (id, min_rest_minutes, clinical_status, changed_by_migration)
  values (1, 480, 'draft', '0202');

  -- R2. Rosters.
  create table identity.duty_rosters (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    facility_id uuid not null,
    department_code text not null check (department_code = any (identity.facility_department_codes())),
    week_start date not null check (extract(isodow from week_start) = 1),
    status text not null default 'draft' check (status in ('draft', 'published')),
    published_at timestamptz,
    published_by_membership_id uuid,
    published_by_account_id uuid,
    publish_count integer not null default 0 check (publish_count >= 0),
    changed_since_published boolean not null default false,
    created_by_membership_id uuid not null,
    created_by_account_id uuid not null,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    unique (facility_id, department_code, week_start),
    unique (id, facility_id),
    constraint duty_rosters_facility_fk foreign key (facility_id, organization_id)
      references identity.facilities(id, organization_id) on delete restrict,
    constraint duty_rosters_created_by_fk foreign key (created_by_membership_id, facility_id, created_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint duty_rosters_published_by_fk
      foreign key (published_by_membership_id, facility_id, published_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint duty_rosters_published_ck check (
      (status = 'published') = (published_at is not null)
      and (published_at is null) = (published_by_membership_id is null)
      and (published_at is null) = (published_by_account_id is null)
      and (status = 'published') = (publish_count > 0)
      and (status = 'published' or not changed_since_published))
  );

  -- R3. Duties.
  create table identity.duty_roster_assignments (
    id uuid primary key default gen_random_uuid(),
    roster_id uuid not null,
    facility_id uuid not null,
    membership_id uuid not null,
    account_id uuid not null,
    shift_id uuid not null,
    duty_date date not null,
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    rest_until timestamptz not null,
    status text not null default 'active' check (status in ('active', 'removed')),
    removed_at timestamptz,
    removed_by_membership_id uuid,
    removed_by_account_id uuid,
    attendance text not null default 'not_marked' check (attendance in ('not_marked', 'present', 'absent', 'swapped')),
    covered_by_membership_id uuid,
    covered_by_account_id uuid,
    attendance_marked_at timestamptz,
    attendance_marked_by_membership_id uuid,
    attendance_marked_by_account_id uuid,
    added_by_membership_id uuid not null,
    added_by_account_id uuid not null,
    added_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    constraint duty_roster_assignments_roster_fk foreign key (roster_id, facility_id)
      references identity.duty_rosters(id, facility_id) on delete restrict,
    constraint duty_roster_assignments_member_fk foreign key (membership_id, facility_id, account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint duty_roster_assignments_shift_fk foreign key (shift_id, facility_id)
      references ehr.clinical_shifts(id, facility_id) on delete restrict,
    constraint duty_roster_assignments_removed_by_fk
      foreign key (removed_by_membership_id, facility_id, removed_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint duty_roster_assignments_covered_by_fk
      foreign key (covered_by_membership_id, facility_id, covered_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint duty_roster_assignments_marked_by_fk
      foreign key (attendance_marked_by_membership_id, facility_id, attendance_marked_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint duty_roster_assignments_added_by_fk foreign key (added_by_membership_id, facility_id, added_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint duty_roster_assignments_times_ck check (ends_at > starts_at and rest_until >= ends_at),
    constraint duty_roster_assignments_removed_ck check (
      (status = 'removed') = (removed_at is not null)
      and (removed_at is null) = (removed_by_membership_id is null)
      and (removed_at is null) = (removed_by_account_id is null)),
    -- Swapped exactly with who worked instead, never the person rostered; marked exactly with who and when.
    constraint duty_roster_assignments_attendance_ck check (
      (attendance = 'swapped') = (covered_by_membership_id is not null)
      and (covered_by_membership_id is null) = (covered_by_account_id is null)
      and covered_by_account_id is distinct from account_id
      and (attendance = 'not_marked') = (attendance_marked_at is null)
      and (attendance_marked_at is null) = (attendance_marked_by_membership_id is null)
      and (attendance_marked_at is null) = (attendance_marked_by_account_id is null)
      and attendance_marked_by_account_id is distinct from account_id)
  );
  create unique index duty_roster_assignments_active_ux
    on identity.duty_roster_assignments (membership_id, shift_id, duty_date) where status = 'active';
  create index duty_roster_assignments_roster_idx on identity.duty_roster_assignments (roster_id, status);
  create index duty_roster_assignments_person_idx
    on identity.duty_roster_assignments (facility_id, account_id, starts_at) where status = 'active';
  create index duty_roster_assignments_member_day_idx
    on identity.duty_roster_assignments (membership_id, duty_date) where status = 'active';

  -- R4. The history.
  create table identity.duty_roster_events (
    id uuid primary key default gen_random_uuid(),
    roster_id uuid not null,
    facility_id uuid not null,
    kind text not null check (kind in ('created', 'assignments_set', 'published', 'attendance_marked')),
    assignment_id uuid references identity.duty_roster_assignments(id) on delete restrict,
    added_count integer check (added_count >= 0),
    removed_count integer check (removed_count >= 0),
    kept_count integer check (kept_count >= 0),
    attendance text check (attendance is null or attendance in ('present', 'absent', 'swapped')),
    covered_by_membership_id uuid,
    actor_account_id uuid not null,
    actor_membership_id uuid not null,
    at timestamptz not null default clock_timestamp(),
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    correlation_id text not null check (length(correlation_id) between 8 and 128),
    constraint duty_roster_events_roster_fk foreign key (roster_id, facility_id)
      references identity.duty_rosters(id, facility_id) on delete restrict,
    constraint duty_roster_events_actor_fk foreign key (actor_membership_id, facility_id, actor_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint duty_roster_events_kind_ck check (
      (kind = 'attendance_marked') = (assignment_id is not null)
      and (kind = 'attendance_marked') = (attendance is not null)
      and (kind = 'assignments_set') = (added_count is not null)
      and (added_count is null) = (removed_count is null) and (added_count is null) = (kept_count is null)
      and (covered_by_membership_id is null or attendance = 'swapped'))
  );
  create unique index duty_roster_events_key_ux on identity.duty_roster_events (actor_membership_id, idempotency_key);
  create index duty_roster_events_roster_idx on identity.duty_roster_events (roster_id, at);

  -- Row-level security, policies, privileges and the no-delete triggers of all four tables.
  alter table identity.duty_roster_rules enable row level security;
  alter table identity.duty_roster_rules force row level security;
  create policy duty_roster_rules_command_read on identity.duty_roster_rules for select using (true);
  create policy duty_roster_rules_command_insert on identity.duty_roster_rules for insert with check (true);
  create policy duty_roster_rules_command_update on identity.duty_roster_rules for update using (true) with check (true);
  create policy duty_roster_rules_command_delete on identity.duty_roster_rules for delete using (true);
  revoke all on identity.duty_roster_rules from public;
  create trigger duty_roster_rules_no_delete before delete on identity.duty_roster_rules
    for each row execute function platform.reject_mutation();
  create trigger duty_roster_rules_no_truncate before truncate on identity.duty_roster_rules
    for each statement execute function platform.reject_mutation();
  comment on table identity.duty_roster_rules is
    '0202 (ROS-1): the duty roster''s minimum rest between one person''s duties, DRAFT (8 hours) until the clinical lead signs a value (Q124 A pattern); changed only by a signed migration. One row. No runtime role reads or writes it.';

  alter table identity.duty_rosters enable row level security;
  alter table identity.duty_rosters force row level security;
  create policy duty_rosters_command_read on identity.duty_rosters for select using (true);
  create policy duty_rosters_command_insert on identity.duty_rosters for insert with check (true);
  create policy duty_rosters_command_update on identity.duty_rosters for update using (true) with check (true);
  create policy duty_rosters_command_delete on identity.duty_rosters for delete using (true);
  revoke all on identity.duty_rosters from public;
  create trigger duty_rosters_no_delete before delete on identity.duty_rosters
    for each row execute function platform.reject_mutation();
  create trigger duty_rosters_no_truncate before truncate on identity.duty_rosters
    for each statement execute function platform.reject_mutation();
  comment on table identity.duty_rosters is
    '0202 (ROS-1, Q193 A): one week''s duty roster (Monday to Sunday, Lagos) of one department code (0114) of a facility: draft or published, with how often it was published and whether it changed since. Never deleted. Only 0202''s functions read and write it, as its owner.';

  alter table identity.duty_roster_assignments enable row level security;
  alter table identity.duty_roster_assignments force row level security;
  create policy duty_roster_assignments_command_read on identity.duty_roster_assignments for select using (true);
  create policy duty_roster_assignments_command_insert on identity.duty_roster_assignments
    for insert with check (true);
  create policy duty_roster_assignments_command_update on identity.duty_roster_assignments
    for update using (true) with check (true);
  create policy duty_roster_assignments_command_delete on identity.duty_roster_assignments for delete using (true);
  revoke all on identity.duty_roster_assignments from public;
  create trigger duty_roster_assignments_no_delete before delete on identity.duty_roster_assignments
    for each row execute function platform.reject_mutation();
  create trigger duty_roster_assignments_no_truncate before truncate on identity.duty_roster_assignments
    for each statement execute function platform.reject_mutation();
  comment on table identity.duty_roster_assignments is
    '0202 (ROS-1, Q193 A, Q242 A, Q246 A): a duty: a member on one of the facility''s clinical shifts (NUR-1) on a Lagos day, with its start and end worked out when saved, and its attendance marked by an editor (present, absent, swapped with who worked instead). The guard refuses overlaps, rest under the rule and approved leave for one person across the facility. Removed duties are kept. Never deleted. Only 0202''s functions read and write it, as its owner.';

  alter table identity.duty_roster_events enable row level security;
  alter table identity.duty_roster_events force row level security;
  create policy duty_roster_events_command_read on identity.duty_roster_events for select using (true);
  create policy duty_roster_events_command_insert on identity.duty_roster_events for insert with check (true);
  create policy duty_roster_events_command_update on identity.duty_roster_events for update using (true) with check (true);
  create policy duty_roster_events_command_delete on identity.duty_roster_events for delete using (true);
  revoke all on identity.duty_roster_events from public;
  create trigger duty_roster_events_append_only before update or delete on identity.duty_roster_events
    for each row execute function platform.reject_mutation();
  create trigger duty_roster_events_no_truncate before truncate on identity.duty_roster_events
    for each statement execute function platform.reject_mutation();
  comment on table identity.duty_roster_events is
    '0202 (ROS-1): every roster made, save (counts), publish and attendance mark, with the Idempotency-Key and the request''s SHA-256. Append-only. Only 0202''s functions write it, as its owner.';

  -- R5 and R6. The guard and the leave clash (trigger functions; no role may execute them).
  create function identity.duty_roster_assignments_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    rule_minutes integer;
  begin
    if new.status <> 'active' then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      'workforce-person:' || new.facility_id::text || ':' || new.account_id::text, 0));
    select rule.min_rest_minutes into rule_minutes from identity.duty_roster_rules rule where rule.id = 1;
    if rule_minutes is null then
      raise exception using errcode = '55000', message = 'DUTY_ROSTER_RULES_MISSING';
    end if;
    new.rest_until := new.ends_at + make_interval(mins => rule_minutes);
    if exists (select 1 from identity.duty_roster_assignments other
                where other.facility_id = new.facility_id and other.account_id = new.account_id
                  and other.status = 'active' and other.id <> new.id
                  and other.starts_at < new.ends_at and new.starts_at < other.ends_at) then
      raise exception using errcode = '55000', message = 'DUTY_ROSTER_OVERLAP';
    end if;
    if exists (select 1 from identity.duty_roster_assignments other
                where other.facility_id = new.facility_id and other.account_id = new.account_id
                  and other.status = 'active' and other.id <> new.id
                  and ((other.ends_at <= new.starts_at
                        and new.starts_at < other.ends_at + make_interval(mins => rule_minutes))
                    or (new.ends_at <= other.starts_at
                        and other.starts_at < new.ends_at + make_interval(mins => rule_minutes)))) then
      raise exception using errcode = '55000', message = 'DUTY_ROSTER_REST_TOO_SHORT', detail = rule_minutes::text;
    end if;
    if exists (select 1 from identity.staff_leave_requests leave_row
                where leave_row.facility_id = new.facility_id and leave_row.account_id = new.account_id
                  and leave_row.status = 'approved' and new.duty_date between leave_row.starts_on and leave_row.ends_on) then
      raise exception using errcode = '55000', message = 'DUTY_ROSTER_MEMBER_ON_LEAVE';
    end if;
    return new;
  end
  $fn$;

  create function identity.staff_leave_requests_roster_clash()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    clash_dates text;
  begin
    perform pg_advisory_xact_lock(hashtextextended(
      'workforce-person:' || new.facility_id::text || ':' || new.account_id::text, 0));
    select string_agg(distinct to_char(duty.duty_date, 'YYYY-MM-DD'), ',' order by to_char(duty.duty_date, 'YYYY-MM-DD'))
      into clash_dates
      from identity.duty_roster_assignments duty
     where duty.facility_id = new.facility_id and duty.account_id = new.account_id and duty.status = 'active'
       and duty.duty_date between new.starts_on and new.ends_on and duty.starts_at > clock_timestamp();
    if clash_dates is not null then
      raise exception using errcode = '55000', message = 'LEAVE_CLASHES_WITH_ROSTER', detail = clash_dates;
    end if;
    return new;
  end
  $fn$;

  create trigger duty_roster_assignments_guard
    before insert or update of status, starts_at, ends_at, rest_until on identity.duty_roster_assignments
    for each row execute function identity.duty_roster_assignments_guard();
  create trigger staff_leave_requests_roster_clash
    before update of status on identity.staff_leave_requests
    for each row when (new.status = 'approved' and old.status is distinct from 'approved')
    execute function identity.staff_leave_requests_roster_clash();

  -- R7. Helpers (no role may execute them; the definers run them as their owner).

  -- A shift's window on a Lagos date (0176's ehr.clinical_shift_window formula: a shift that ends at or before its
  -- start ends the next day).
  create function identity.duty_roster_shift_window(requested_shift_id uuid, requested_date date)
  returns table (starts timestamptz, ends timestamptz)
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    return query
      select ((requested_date + shift.starts_at) at time zone 'Africa/Lagos'),
             ((requested_date + shift.ends_at + case when shift.ends_at <= shift.starts_at then interval '1 day'
                                                      else interval '0' end) at time zone 'Africa/Lagos')
        from ehr.clinical_shifts shift where shift.id = requested_shift_id;
  end
  $fn$;

  -- A roster week: a Monday from 8 weeks before this Lagos week's Monday to 26 weeks after it.
  create function identity.duty_roster_week_ok(requested_week_start date)
  returns boolean
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    this_monday date;
  begin
    this_monday := today - (extract(isodow from today)::integer - 1);
    return requested_week_start is not null and extract(isodow from requested_week_start) = 1
      and requested_week_start between this_monday - 56 and this_monday + 182;
  end
  $fn$;

  -- A duty's answer.
  create function identity.duty_roster_assignment_card(requested_assignment_id uuid)
  returns jsonb
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    return (select jsonb_build_object(
              'assignmentId', duty.id, 'membershipId', duty.membership_id, 'shiftId', duty.shift_id,
              'dutyDate', to_char(duty.duty_date, 'YYYY-MM-DD'),
              'startsAt', to_char(duty.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'endsAt', to_char(duty.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'attendance', duty.attendance, 'coveredByMembershipId', duty.covered_by_membership_id,
              'attendanceMarkedAt', to_char(duty.attendance_marked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'attendanceMarkedByMembershipId', duty.attendance_marked_by_membership_id,
              'rowVersion', duty.row_version)
              from identity.duty_roster_assignments duty where duty.id = requested_assignment_id);
  end
  $fn$;

  -- The roster card. unavailable (leave approved or requested in the week; never the type) only for an editor.
  create function identity.duty_roster_card(requested_roster_id uuid, requested_can_edit boolean)
  returns jsonb
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    roster identity.duty_rosters%rowtype;
    rule_row identity.duty_roster_rules%rowtype;
  begin
    select candidate.* into roster from identity.duty_rosters candidate where candidate.id = requested_roster_id;
    if not found then
      return null;
    end if;
    select rule.* into rule_row from identity.duty_roster_rules rule where rule.id = 1;
    return jsonb_build_object(
      'rosterId', roster.id, 'departmentCode', roster.department_code,
      'weekStart', to_char(roster.week_start, 'YYYY-MM-DD'), 'weekEnd', to_char(roster.week_start + 6, 'YYYY-MM-DD'),
      'status', roster.status,
      'publishedAt', to_char(roster.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'publishedByMembershipId', roster.published_by_membership_id, 'publishCount', roster.publish_count,
      'changedSincePublished', roster.changed_since_published, 'rowVersion', roster.row_version,
      'canEdit', coalesce(requested_can_edit, false),
      'rules', jsonb_build_object('minRestHours', round(rule_row.min_rest_minutes / 60.0, 2),
                                  'status', rule_row.clinical_status),
      'shifts', coalesce((
        select jsonb_agg(jsonb_build_object('shiftId', shift.id, 'name', shift.name,
                                            'startsAt', to_char(shift.starts_at, 'HH24:MI'),
                                            'endsAt', to_char(shift.ends_at, 'HH24:MI'), 'active', shift.active)
                         order by shift.starts_at, shift.name, shift.id)
          from ehr.clinical_shifts shift
         where shift.facility_id = roster.facility_id
           and (shift.active or exists (select 1 from identity.duty_roster_assignments duty
                                         where duty.roster_id = roster.id and duty.status = 'active'
                                           and duty.shift_id = shift.id))), '[]'::jsonb),
      'assignments', coalesce((
        select jsonb_agg(identity.duty_roster_assignment_card(duty.id)
                         order by duty.duty_date, duty.starts_at, duty.membership_id)
          from identity.duty_roster_assignments duty
         where duty.roster_id = roster.id and duty.status = 'active'), '[]'::jsonb),
      'unavailable', case when not coalesce(requested_can_edit, false) then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('membershipId', leave_row.membership_id,
                           'from', to_char(greatest(leave_row.starts_on, roster.week_start), 'YYYY-MM-DD'),
                           'to', to_char(least(leave_row.ends_on, roster.week_start + 6), 'YYYY-MM-DD'),
                           'kind', 'leave_' || leave_row.status)
                         order by leave_row.starts_on, leave_row.membership_id, leave_row.id)
          from identity.staff_leave_requests leave_row
         where leave_row.facility_id = roster.facility_id and leave_row.status in ('approved', 'requested')
           and leave_row.starts_on <= roster.week_start + 6 and roster.week_start <= leave_row.ends_on), '[]'::jsonb)
        end);
  end
  $fn$;

  -- Who is on duty at a time at a facility: duties on published rosters whose shift is running then; absent left
  -- out; for swapped the member who worked instead, with covering_for_membership_id. Ambulance dispatch and Quality
  -- may call it from their own functions later (md5-pinned by them).
  create function identity.duty_roster_on_duty_at(requested_facility_id uuid, requested_at timestamptz)
  returns table (department_code text, membership_id uuid, shift_id uuid, shift_name text, starts_at timestamptz,
    ends_at timestamptz, attendance text, covering_for_membership_id uuid)
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    return query
      select roster.department_code,
             case when duty.attendance = 'swapped' then duty.covered_by_membership_id else duty.membership_id end,
             duty.shift_id, shift.name, duty.starts_at, duty.ends_at, duty.attendance,
             case when duty.attendance = 'swapped' then duty.membership_id end
        from identity.duty_roster_assignments duty
        join identity.duty_rosters roster on roster.id = duty.roster_id
        join ehr.clinical_shifts shift on shift.id = duty.shift_id
       where duty.facility_id = requested_facility_id and duty.status = 'active' and roster.status = 'published'
         and duty.attendance <> 'absent' and duty.starts_at <= requested_at and requested_at < duty.ends_at
       order by roster.department_code, duty.starts_at, duty.membership_id;
  end
  $fn$;

  -- The Idempotency-Key of a roster write: 'new', 'replay' (the same key and request: the event) or 'reused' (the
  -- same key, another request, here or on 0200's leave and in-charge writes). Under an advisory lock per membership
  -- and key.
  create function identity.duty_roster_idempotency(requested_membership_id uuid, requested_key text,
    requested_sha256 text)
  returns table (state text, event_kind text, roster_id uuid, assignment_id uuid)
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    found_event identity.duty_roster_events%rowtype;
  begin
    if requested_key is null or requested_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_sha256 is null or requested_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'WORKFORCE_IDEMPOTENCY_KEY_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      'workforce-key:' || requested_membership_id::text || ':' || requested_key, 0));
    select event.* into found_event from identity.duty_roster_events event
     where event.actor_membership_id = requested_membership_id and event.idempotency_key = requested_key;
    if not found then
      state := case when exists (select 1 from identity.workforce_events other
                                  where other.actor_membership_id = requested_membership_id
                                    and other.idempotency_key = requested_key) then 'reused' else 'new' end;
    elsif found_event.request_sha256 = requested_sha256 then
      state := 'replay';
    else
      state := 'reused';
    end if;
    event_kind := found_event.kind;
    roster_id := found_event.roster_id;
    assignment_id := found_event.assignment_id;
    return next;
  end
  $fn$;

  -- Route 15: the facility's rosters for a week. Published ones for every reader; drafts, and departments with no
  -- roster yet, for their editors. Outcomes: listed, week_invalid.
  create function identity.duty_roster_list(requested_week_start date)
  returns table (outcome text, body jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    editable text[];
    in_charge_of text[];
    items jsonb;
  begin
    select * into actor from identity.workforce_actor('workforce.roster.read');
    if not identity.duty_roster_week_ok(requested_week_start) then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.list',
        'failure', 'facility', actor.actor_facility::text, jsonb_build_object('refusal', 'week_invalid'));
      return query select 'week_invalid', null::jsonb;
      return;
    end if;
    editable := identity.workforce_editor_departments(actor.actor_membership);
    in_charge_of := coalesce((select array_agg(distinct in_charge.department_code order by in_charge.department_code)
                                from identity.workforce_department_in_charges in_charge
                               where in_charge.membership_id = actor.actor_membership
                                 and in_charge.facility_id = actor.actor_facility and in_charge.ended_at is null
                                 and in_charge.department_code = any (
                                   identity.workforce_facility_departments(actor.actor_facility))),
                             array[]::text[]);
    select coalesce(jsonb_agg(item.value order by item.department_code), '[]'::jsonb) into items
      from (select roster.department_code,
                   jsonb_build_object('rosterId', roster.id, 'departmentCode', roster.department_code,
                     'status', roster.status,
                     'assignmentCount', (select count(*) from identity.duty_roster_assignments duty
                                          where duty.roster_id = roster.id and duty.status = 'active'),
                     'publishedAt', to_char(roster.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                     'changedSincePublished', roster.changed_since_published,
                     'canEdit', roster.department_code = any (editable)) as value
              from identity.duty_rosters roster
             where roster.facility_id = actor.actor_facility and roster.week_start = requested_week_start
               and (roster.status = 'published' or roster.department_code = any (editable))
            union all
            select department.code,
                   jsonb_build_object('rosterId', null, 'departmentCode', department.code, 'status', 'none',
                     'assignmentCount', 0, 'publishedAt', null, 'changedSincePublished', false, 'canEdit', true)
              from unnest(editable) department(code)
             where not exists (select 1 from identity.duty_rosters roster
                                where roster.facility_id = actor.actor_facility
                                  and roster.week_start = requested_week_start
                                  and roster.department_code = department.code)) item;
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.list',
      'success', 'facility', actor.actor_facility::text,
      jsonb_build_object('count', jsonb_array_length(items), 'weekStart', to_char(requested_week_start, 'YYYY-MM-DD')));
    return query select 'listed', jsonb_build_object('weekStart', to_char(requested_week_start, 'YYYY-MM-DD'),
      'items', items, 'inChargeOf', to_jsonb(in_charge_of));
  end
  $fn$;

  -- Route 16: one roster. A draft only for its editors (else not_found). Outcomes: found, not_found.
  create function identity.duty_roster_read(requested_roster_id uuid)
  returns table (outcome text, roster jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    found_roster identity.duty_rosters%rowtype;
    can_edit boolean;
  begin
    select * into actor from identity.workforce_actor('workforce.roster.read');
    select candidate.* into found_roster from identity.duty_rosters candidate
     where candidate.id = requested_roster_id and candidate.facility_id = actor.actor_facility;
    can_edit := found and found_roster.department_code = any (identity.workforce_editor_departments(actor.actor_membership));
    if found_roster.id is null or (found_roster.status = 'draft' and not can_edit) then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.read',
        'failure', 'duty-roster', requested_roster_id::text, jsonb_build_object('refusal', 'not_found'));
      return query select 'not_found', null::jsonb;
      return;
    end if;
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.read',
      'success', 'duty-roster', found_roster.id::text, jsonb_build_object('canEdit', can_edit));
    return query select 'found', identity.duty_roster_card(found_roster.id, can_edit);
  end
  $fn$;

  -- Route 17: make the week's draft roster of a department. Outcomes: created (replayed), already_exists,
  -- no_departments, department_invalid, week_invalid, edit_not_allowed, key_reused.
  create function identity.duty_roster_create(requested_department_code text, requested_week_start date,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, roster jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    key_state record;
    departments text[];
    refusal text;
    new_id uuid;
  begin
    select * into actor from identity.workforce_actor('workforce.roster.read');
    if requested_department_code is null or requested_department_code !~ '^[a-z_]{2,40}$'
       or requested_week_start is null then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    select * into key_state from identity.duty_roster_idempotency(actor.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.event_kind = 'created' then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.create',
        'success', 'duty-roster', key_state.roster_id::text, jsonb_build_object('replayed', true));
      return query select 'created', true, identity.duty_roster_card(key_state.roster_id, true);
      return;
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    end if;
    departments := identity.workforce_facility_departments(actor.actor_facility);
    if refusal is null and cardinality(departments) = 0 then
      refusal := 'no_departments';
    elsif refusal is null and not requested_department_code = any (departments) then
      refusal := 'department_invalid';
    elsif refusal is null and not identity.duty_roster_week_ok(requested_week_start) then
      refusal := 'week_invalid';
    elsif refusal is null
          and not requested_department_code = any (identity.workforce_editor_departments(actor.actor_membership)) then
      refusal := 'edit_not_allowed';
    end if;
    if refusal is not null then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.create',
        case when refusal in ('key_reused', 'edit_not_allowed') then 'denied' else 'failure' end, 'facility',
        actor.actor_facility::text, jsonb_build_object('refusal', refusal, 'departmentCode', requested_department_code));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    insert into identity.duty_rosters (organization_id, facility_id, department_code, week_start,
      created_by_membership_id, created_by_account_id)
    values (actor.actor_organization, actor.actor_facility, requested_department_code, requested_week_start,
      actor.actor_membership, actor.actor_account)
    on conflict (facility_id, department_code, week_start) do nothing
    returning id into new_id;
    if new_id is null then
      select candidate.id into new_id from identity.duty_rosters candidate
       where candidate.facility_id = actor.actor_facility and candidate.department_code = requested_department_code
         and candidate.week_start = requested_week_start;
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.create',
        'success', 'duty-roster', new_id::text, jsonb_build_object('outcome', 'already_exists'));
      return query select 'already_exists', false, identity.duty_roster_card(new_id, true);
      return;
    end if;
    insert into identity.duty_roster_events (roster_id, facility_id, kind, actor_account_id, actor_membership_id,
      idempotency_key, request_sha256, correlation_id)
    values (new_id, actor.actor_facility, 'created', actor.actor_account, actor.actor_membership,
      requested_idempotency_key, requested_request_sha256, actor.actor_correlation);
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.create',
      'success', 'duty-roster', new_id::text,
      jsonb_build_object('outcome', 'created', 'departmentCode', requested_department_code));
    return query select 'created', false, identity.duty_roster_card(new_id, true);
  end
  $fn$;

  -- Route 18: the week's duties become exactly the list given (all or nothing). Outcomes: saved (replayed),
  -- not_found, edit_not_allowed, changed, member_invalid, shift_invalid, date_outside_week, shift_started, overlap,
  -- rest_too_short, member_on_leave, key_reused. details: the first duty refused ({membershipId, dutyDate,
  -- shiftId}); never another department.
  create function identity.duty_roster_assignments_set(requested_roster_id uuid, requested_row_version bigint,
    requested_assignments jsonb, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, roster jsonb, changes jsonb, details jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    key_state record;
    current_roster identity.duty_rosters%rowtype;
    editable text[];
    entry jsonb;
    wanted_members uuid[];
    wanted_shifts uuid[];
    wanted_dates date[];
    refusal text;
    refusal_details jsonb;
    candidate record;
    window_row record;
    member_account uuid;
    added_count integer := 0;
    removed_count integer := 0;
    kept_count integer := 0;
    now_value timestamptz := clock_timestamp();
    error_message text;
    stored_event identity.duty_roster_events%rowtype;
  begin
    select * into actor from identity.workforce_actor('workforce.roster.read');
    if requested_roster_id is null or requested_row_version is null or requested_row_version < 1
       or requested_assignments is null or jsonb_typeof(requested_assignments) <> 'array'
       or jsonb_array_length(requested_assignments) > 500 then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    for entry in select element.value from jsonb_array_elements(requested_assignments) element loop
      if jsonb_typeof(entry) is distinct from 'object'
         or (select count(*) from jsonb_object_keys(entry)) <> 3
         or jsonb_typeof(entry->'membershipId') is distinct from 'string'
         or jsonb_typeof(entry->'shiftId') is distinct from 'string'
         or jsonb_typeof(entry->'dutyDate') is distinct from 'string'
         or entry->>'membershipId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         or entry->>'shiftId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         or entry->>'dutyDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or to_char(to_date(entry->>'dutyDate', 'YYYY-MM-DD'), 'YYYY-MM-DD') <> entry->>'dutyDate' then
        raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
      end if;
    end loop;
    select coalesce(array_agg((element.value->>'membershipId')::uuid order by element.ordinality), array[]::uuid[]),
           coalesce(array_agg((element.value->>'shiftId')::uuid order by element.ordinality), array[]::uuid[]),
           coalesce(array_agg((element.value->>'dutyDate')::date order by element.ordinality), array[]::date[])
      into wanted_members, wanted_shifts, wanted_dates
      from jsonb_array_elements(requested_assignments) with ordinality element(value, ordinality);
    if (select count(distinct (wanted.membership_id, wanted.shift_id, wanted.duty_date))
          from unnest(wanted_members, wanted_shifts, wanted_dates) wanted(membership_id, shift_id, duty_date))
       <> cardinality(wanted_members) then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    select * into key_state from identity.duty_roster_idempotency(actor.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.event_kind = 'assignments_set'
       and key_state.roster_id = requested_roster_id then
      select event.* into stored_event from identity.duty_roster_events event
       where event.actor_membership_id = actor.actor_membership and event.idempotency_key = requested_idempotency_key;
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.assignments-set',
        'success', 'duty-roster', requested_roster_id::text, jsonb_build_object('replayed', true));
      return query select 'saved', true,
        identity.duty_roster_card(requested_roster_id,
          (select candidate_roster.department_code = any (identity.workforce_editor_departments(actor.actor_membership))
             from identity.duty_rosters candidate_roster where candidate_roster.id = requested_roster_id)),
        jsonb_build_object('added', stored_event.added_count, 'removed', stored_event.removed_count,
                           'kept', stored_event.kept_count), null::jsonb;
      return;
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    end if;
    if refusal is null then
      select candidate_roster.* into current_roster from identity.duty_rosters candidate_roster
       where candidate_roster.id = requested_roster_id and candidate_roster.facility_id = actor.actor_facility
       for update;
      editable := identity.workforce_editor_departments(actor.actor_membership);
      if not found or (current_roster.status = 'draft' and not current_roster.department_code = any (editable)) then
        refusal := 'not_found';
      elsif not current_roster.department_code = any (editable) then
        refusal := 'edit_not_allowed';
      elsif current_roster.row_version <> requested_row_version then
        refusal := 'changed';
      end if;
    end if;
    -- Each new duty, in the order given: the member, the shift, the day, and not started.
    if refusal is null then
      for candidate in
        select wanted.membership_id, wanted.shift_id, wanted.duty_date, wanted.ordinality
          from unnest(wanted_members, wanted_shifts, wanted_dates) with ordinality
               wanted(membership_id, shift_id, duty_date, ordinality)
         where not exists (select 1 from identity.duty_roster_assignments duty
                            where duty.roster_id = current_roster.id and duty.status = 'active'
                              and duty.membership_id = wanted.membership_id and duty.shift_id = wanted.shift_id
                              and duty.duty_date = wanted.duty_date)
         order by wanted.ordinality
      loop
        refusal_details := jsonb_build_object('membershipId', candidate.membership_id,
          'dutyDate', to_char(candidate.duty_date, 'YYYY-MM-DD'), 'shiftId', candidate.shift_id);
        if not exists (select 1 from identity.staff_facility_memberships membership
                        where membership.id = candidate.membership_id and membership.facility_id = actor.actor_facility
                          and membership.active) then
          refusal := 'member_invalid';
        elsif not exists (select 1 from ehr.clinical_shifts shift
                           where shift.id = candidate.shift_id and shift.facility_id = actor.actor_facility
                             and shift.active) then
          refusal := 'shift_invalid';
        elsif candidate.duty_date not between current_roster.week_start and current_roster.week_start + 6 then
          refusal := 'date_outside_week';
        else
          select * into window_row from identity.duty_roster_shift_window(candidate.shift_id, candidate.duty_date);
          if window_row.starts <= now_value then
            refusal := 'shift_started';
          end if;
        end if;
        exit when refusal is not null;
      end loop;
    end if;
    -- Each duty to remove: not started.
    if refusal is null then
      select jsonb_build_object('membershipId', duty.membership_id, 'dutyDate', to_char(duty.duty_date, 'YYYY-MM-DD'),
               'shiftId', duty.shift_id)
        into refusal_details
        from identity.duty_roster_assignments duty
       where duty.roster_id = current_roster.id and duty.status = 'active' and duty.starts_at <= now_value
         and not exists (select 1 from unnest(wanted_members, wanted_shifts, wanted_dates)
                                       wanted(membership_id, shift_id, duty_date)
                          where wanted.membership_id = duty.membership_id and wanted.shift_id = duty.shift_id
                            and wanted.duty_date = duty.duty_date)
       order by duty.starts_at, duty.membership_id
       limit 1;
      if found then
        refusal := 'shift_started';
      else
        refusal_details := null;
      end if;
    end if;
    -- The writes, all or nothing: removals first, then each new duty under its person's lock (the guard), the
    -- people's locks taken in one order first.
    if refusal is null then
      refusal_details := null;
      begin
        perform pg_advisory_xact_lock(hashtextextended(
                  'workforce-person:' || actor.actor_facility::text || ':' || people.account_id::text, 0))
          from (select distinct membership.account_id
                  from unnest(wanted_members) wanted(membership_id)
                  join identity.staff_facility_memberships membership on membership.id = wanted.membership_id
                 order by membership.account_id) people;
        update identity.duty_roster_assignments duty
           set status = 'removed', removed_at = now_value, removed_by_membership_id = actor.actor_membership,
               removed_by_account_id = actor.actor_account, row_version = duty.row_version + 1
         where duty.roster_id = current_roster.id and duty.status = 'active'
           and not exists (select 1 from unnest(wanted_members, wanted_shifts, wanted_dates)
                                         wanted(membership_id, shift_id, duty_date)
                            where wanted.membership_id = duty.membership_id and wanted.shift_id = duty.shift_id
                              and wanted.duty_date = duty.duty_date);
        get diagnostics removed_count = row_count;
        select count(*) into kept_count
          from identity.duty_roster_assignments duty
         where duty.roster_id = current_roster.id and duty.status = 'active';
        for candidate in
          select wanted.membership_id, wanted.shift_id, wanted.duty_date, wanted.ordinality
            from unnest(wanted_members, wanted_shifts, wanted_dates) with ordinality
                 wanted(membership_id, shift_id, duty_date, ordinality)
           where not exists (select 1 from identity.duty_roster_assignments duty
                              where duty.roster_id = current_roster.id and duty.status = 'active'
                                and duty.membership_id = wanted.membership_id and duty.shift_id = wanted.shift_id
                                and duty.duty_date = wanted.duty_date)
           order by wanted.ordinality
        loop
          refusal_details := jsonb_build_object('membershipId', candidate.membership_id,
            'dutyDate', to_char(candidate.duty_date, 'YYYY-MM-DD'), 'shiftId', candidate.shift_id);
          select membership.account_id into member_account from identity.staff_facility_memberships membership
           where membership.id = candidate.membership_id;
          select * into window_row from identity.duty_roster_shift_window(candidate.shift_id, candidate.duty_date);
          insert into identity.duty_roster_assignments (roster_id, facility_id, membership_id, account_id, shift_id,
            duty_date, starts_at, ends_at, rest_until, added_by_membership_id, added_by_account_id)
          values (current_roster.id, actor.actor_facility, candidate.membership_id, member_account, candidate.shift_id,
            candidate.duty_date, window_row.starts, window_row.ends, window_row.ends, actor.actor_membership,
            actor.actor_account);
          added_count := added_count + 1;
        end loop;
        refusal_details := null;
      exception when object_not_in_prerequisite_state then
        get stacked diagnostics error_message = message_text;
        refusal := case error_message when 'DUTY_ROSTER_OVERLAP' then 'overlap'
                                      when 'DUTY_ROSTER_REST_TOO_SHORT' then 'rest_too_short'
                                      when 'DUTY_ROSTER_MEMBER_ON_LEAVE' then 'member_on_leave' end;
        if refusal is null then
          raise;
        end if;
        added_count := 0;
        removed_count := 0;
        kept_count := 0;
      end;
    end if;
    if refusal is not null then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.assignments-set',
        case when refusal in ('key_reused', 'edit_not_allowed') then 'denied' else 'failure' end, 'duty-roster',
        requested_roster_id::text, jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb, null::jsonb,
        case when refusal in ('member_invalid', 'shift_invalid', 'date_outside_week', 'shift_started', 'overlap',
                              'rest_too_short', 'member_on_leave') then refusal_details end;
      return;
    end if;
    kept_count := kept_count;
    if added_count + removed_count > 0 then
      update identity.duty_rosters candidate_roster
         set row_version = candidate_roster.row_version + 1, updated_at = now_value,
             changed_since_published = candidate_roster.status = 'published'
         where candidate_roster.id = current_roster.id;
    end if;
    insert into identity.duty_roster_events (roster_id, facility_id, kind, added_count, removed_count, kept_count,
      actor_account_id, actor_membership_id, idempotency_key, request_sha256, correlation_id)
    values (current_roster.id, actor.actor_facility, 'assignments_set', added_count, removed_count, kept_count,
      actor.actor_account, actor.actor_membership, requested_idempotency_key, requested_request_sha256,
      actor.actor_correlation);
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.assignments-set',
      'success', 'duty-roster', current_roster.id::text,
      jsonb_build_object('added', added_count, 'removed', removed_count, 'kept', kept_count));
    return query select 'saved', false, identity.duty_roster_card(current_roster.id, true),
      jsonb_build_object('added', added_count, 'removed', removed_count, 'kept', kept_count), null::jsonb;
  end
  $fn$;

  -- Route 19: publish, or publish again after changes. Outcomes: published (replayed), unchanged, not_found,
  -- edit_not_allowed, changed, empty, key_reused.
  create function identity.duty_roster_publish(requested_roster_id uuid, requested_row_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, roster jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    key_state record;
    current_roster identity.duty_rosters%rowtype;
    editable text[];
    refusal text;
  begin
    select * into actor from identity.workforce_actor('workforce.roster.read');
    if requested_roster_id is null or requested_row_version is null or requested_row_version < 1 then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    select * into key_state from identity.duty_roster_idempotency(actor.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.event_kind = 'published'
       and key_state.roster_id = requested_roster_id then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.publish',
        'success', 'duty-roster', requested_roster_id::text, jsonb_build_object('replayed', true));
      return query select 'published', true,
        identity.duty_roster_card(requested_roster_id,
          (select candidate_roster.department_code = any (identity.workforce_editor_departments(actor.actor_membership))
             from identity.duty_rosters candidate_roster where candidate_roster.id = requested_roster_id));
      return;
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    end if;
    if refusal is null then
      select candidate_roster.* into current_roster from identity.duty_rosters candidate_roster
       where candidate_roster.id = requested_roster_id and candidate_roster.facility_id = actor.actor_facility
       for update;
      editable := identity.workforce_editor_departments(actor.actor_membership);
      if not found or (current_roster.status = 'draft' and not current_roster.department_code = any (editable)) then
        refusal := 'not_found';
      elsif not current_roster.department_code = any (editable) then
        refusal := 'edit_not_allowed';
      elsif current_roster.row_version <> requested_row_version then
        refusal := 'changed';
      elsif not exists (select 1 from identity.duty_roster_assignments duty
                         where duty.roster_id = current_roster.id and duty.status = 'active') then
        refusal := 'empty';
      end if;
    end if;
    if refusal is not null then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.publish',
        case when refusal in ('key_reused', 'edit_not_allowed') then 'denied' else 'failure' end, 'duty-roster',
        requested_roster_id::text, jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    if current_roster.status = 'published' and not current_roster.changed_since_published then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.publish',
        'success', 'duty-roster', current_roster.id::text, jsonb_build_object('outcome', 'unchanged'));
      return query select 'unchanged', false, identity.duty_roster_card(current_roster.id, true);
      return;
    end if;
    update identity.duty_rosters candidate_roster
       set status = 'published', published_at = clock_timestamp(), published_by_membership_id = actor.actor_membership,
           published_by_account_id = actor.actor_account, publish_count = candidate_roster.publish_count + 1,
           changed_since_published = false, updated_at = clock_timestamp(),
           row_version = candidate_roster.row_version + 1
     where candidate_roster.id = current_roster.id;
    insert into identity.duty_roster_events (roster_id, facility_id, kind, actor_account_id, actor_membership_id,
      idempotency_key, request_sha256, correlation_id)
    values (current_roster.id, actor.actor_facility, 'published', actor.actor_account, actor.actor_membership,
      requested_idempotency_key, requested_request_sha256, actor.actor_correlation);
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.publish',
      'success', 'duty-roster', current_roster.id::text,
      jsonb_build_object('outcome', 'published', 'publishCount', current_roster.publish_count + 1));
    return query select 'published', false, identity.duty_roster_card(current_roster.id, true);
  end
  $fn$;

  -- Route 20: mark attendance on a published roster, from 1 hour before the shift starts to 7 days after it ends,
  -- never for one's own duty. Outcomes: marked (replayed), not_found, assignment_not_found, edit_not_allowed,
  -- not_published, own_not_allowed, not_open, changed, cover_invalid, key_reused.
  create function identity.duty_roster_attendance_mark(requested_roster_id uuid, requested_assignment_id uuid,
    requested_row_version bigint, requested_attendance text, requested_covered_by_membership_id uuid,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, assignment jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    key_state record;
    current_roster identity.duty_rosters%rowtype;
    current_duty identity.duty_roster_assignments%rowtype;
    editable text[];
    cover_account uuid;
    refusal text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into actor from identity.workforce_actor('workforce.roster.read');
    if requested_roster_id is null or requested_assignment_id is null or requested_row_version is null
       or requested_row_version < 1 or requested_attendance is null
       or requested_attendance not in ('present', 'absent', 'swapped')
       or (requested_attendance = 'swapped') <> (requested_covered_by_membership_id is not null) then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    select * into key_state from identity.duty_roster_idempotency(actor.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.event_kind = 'attendance_marked'
       and key_state.assignment_id = requested_assignment_id then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.attendance',
        'success', 'duty-roster-assignment', requested_assignment_id::text, jsonb_build_object('replayed', true));
      return query select 'marked', true, identity.duty_roster_assignment_card(requested_assignment_id);
      return;
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    end if;
    if refusal is null then
      select candidate_roster.* into current_roster from identity.duty_rosters candidate_roster
       where candidate_roster.id = requested_roster_id and candidate_roster.facility_id = actor.actor_facility;
      editable := identity.workforce_editor_departments(actor.actor_membership);
      if not found or (current_roster.status = 'draft' and not current_roster.department_code = any (editable)) then
        refusal := 'not_found';
      else
        select duty.* into current_duty from identity.duty_roster_assignments duty
         where duty.id = requested_assignment_id and duty.roster_id = current_roster.id and duty.status = 'active'
         for update;
        if not found then
          refusal := 'assignment_not_found';
        elsif not current_roster.department_code = any (editable) then
          refusal := 'edit_not_allowed';
        elsif current_roster.status <> 'published' then
          refusal := 'not_published';
        elsif current_duty.account_id = actor.actor_account then
          refusal := 'own_not_allowed';
        elsif now_value < current_duty.starts_at - interval '1 hour'
              or now_value > current_duty.ends_at + interval '7 days' then
          refusal := 'not_open';
        elsif current_duty.row_version <> requested_row_version then
          refusal := 'changed';
        elsif requested_attendance = 'swapped' then
          select membership.account_id into cover_account from identity.staff_facility_memberships membership
           where membership.id = requested_covered_by_membership_id and membership.facility_id = actor.actor_facility
             and membership.active;
          if cover_account is null or cover_account = current_duty.account_id then
            refusal := 'cover_invalid';
          end if;
        end if;
      end if;
    end if;
    if refusal is not null then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.attendance',
        case when refusal in ('key_reused', 'edit_not_allowed', 'own_not_allowed') then 'denied' else 'failure' end,
        'duty-roster-assignment', requested_assignment_id::text, jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    update identity.duty_roster_assignments duty
       set attendance = requested_attendance,
           covered_by_membership_id = case when requested_attendance = 'swapped' then requested_covered_by_membership_id end,
           covered_by_account_id = case when requested_attendance = 'swapped' then cover_account end,
           attendance_marked_at = now_value, attendance_marked_by_membership_id = actor.actor_membership,
           attendance_marked_by_account_id = actor.actor_account, row_version = duty.row_version + 1
     where duty.id = current_duty.id;
    insert into identity.duty_roster_events (roster_id, facility_id, kind, assignment_id, attendance,
      covered_by_membership_id, actor_account_id, actor_membership_id, idempotency_key, request_sha256, correlation_id)
    values (current_roster.id, actor.actor_facility, 'attendance_marked', current_duty.id, requested_attendance,
      case when requested_attendance = 'swapped' then requested_covered_by_membership_id end, actor.actor_account,
      actor.actor_membership, requested_idempotency_key, requested_request_sha256, actor.actor_correlation);
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.attendance',
      'success', 'duty-roster-assignment', current_duty.id::text,
      jsonb_build_object('attendance', requested_attendance, 'rosterId', current_roster.id));
    return query select 'marked', false, identity.duty_roster_assignment_card(current_duty.id);
  end
  $fn$;

  -- Route 21: who is on duty now (optionally one department). Outcomes: listed, department_invalid.
  create function identity.duty_roster_on_duty(requested_department_code text)
  returns table (outcome text, body jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    now_value timestamptz := clock_timestamp();
    items jsonb;
  begin
    select * into actor from identity.workforce_actor('workforce.roster.read');
    if requested_department_code is not null
       and not requested_department_code = any (identity.workforce_facility_departments(actor.actor_facility)) then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.on-duty',
        'failure', 'facility', actor.actor_facility::text, jsonb_build_object('refusal', 'department_invalid'));
      return query select 'department_invalid', null::jsonb;
      return;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('departmentCode', on_duty.department_code,
             'membershipId', on_duty.membership_id, 'shiftId', on_duty.shift_id, 'shiftName', on_duty.shift_name,
             'startsAt', to_char(on_duty.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'endsAt', to_char(on_duty.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'attendance', on_duty.attendance, 'coveringForMembershipId', on_duty.covering_for_membership_id)
             order by on_duty.department_code, on_duty.starts_at, on_duty.membership_id), '[]'::jsonb)
      into items
      from identity.duty_roster_on_duty_at(actor.actor_facility, now_value) on_duty
     where requested_department_code is null or on_duty.department_code = requested_department_code;
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.on-duty',
      'success', 'facility', actor.actor_facility::text, jsonb_build_object('count', jsonb_array_length(items)));
    return query select 'listed', jsonb_build_object(
      'at', to_char(now_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'items', items);
  end
  $fn$;

  -- Route 22: my published duties here, from 7 days ago to 28 days ahead (Lagos days). Any active member.
  create function identity.duty_roster_my_duties()
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    actor record;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    items jsonb;
  begin
    select * into actor from identity.workforce_actor(null);
    select coalesce(jsonb_agg(jsonb_build_object('assignmentId', duty.id, 'departmentCode', roster.department_code,
             'shiftName', shift.name, 'dutyDate', to_char(duty.duty_date, 'YYYY-MM-DD'),
             'startsAt', to_char(duty.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'endsAt', to_char(duty.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'attendance', duty.attendance)
             order by duty.starts_at, duty.id), '[]'::jsonb)
      into items
      from identity.duty_roster_assignments duty
      join identity.duty_rosters roster on roster.id = duty.roster_id
      join ehr.clinical_shifts shift on shift.id = duty.shift_id
     where duty.membership_id = actor.actor_membership and duty.facility_id = actor.actor_facility
       and duty.status = 'active' and roster.status = 'published'
       and duty.duty_date between today - 7 and today + 28;
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.duty-roster.my-duties',
      'success', 'facility-membership', actor.actor_membership::text,
      jsonb_build_object('count', jsonb_array_length(items)));
    return jsonb_build_object('items', items);
  end
  $fn$;

  comment on function identity.duty_roster_list(date) is
    '0202 (ROS-1): the facility''s rosters for a week (published for every reader; drafts and departments without a roster for their editors), and the caller''s in-charge departments. Needs workforce.roster.read. Outcomes listed, week_invalid. Audited (identity.duty-roster.list).';
  comment on function identity.duty_roster_read(uuid) is
    '0202 (ROS-1): one roster with its shifts, duties and rule; for editors also who is on leave in the week (never the type). Drafts for editors only. Outcomes found, not_found. Audited (identity.duty-roster.read).';
  comment on function identity.duty_roster_create(text, date, text, text) is
    '0202 (ROS-1): an editor makes the week''s draft roster of a department. Outcomes created (replayed), already_exists, no_departments, department_invalid, week_invalid, edit_not_allowed, key_reused. Audited (identity.duty-roster.create).';
  comment on function identity.duty_roster_assignments_set(uuid, bigint, jsonb, text, text) is
    '0202 (ROS-1, Q-ROS-10 A): an editor replaces the week''s duties, all or nothing; duties that started cannot be added or removed; the guard refuses overlaps, rest under the rule and approved leave. Outcomes saved (replayed), not_found, edit_not_allowed, changed, member_invalid, shift_invalid, date_outside_week, shift_started, overlap, rest_too_short, member_on_leave, key_reused. Audited (identity.duty-roster.assignments-set, counts).';
  comment on function identity.duty_roster_publish(uuid, bigint, text, text) is
    '0202 (ROS-1): an editor publishes a roster, or publishes it again after changes. Outcomes published (replayed), unchanged, not_found, edit_not_allowed, changed, empty, key_reused. Audited (identity.duty-roster.publish).';
  comment on function identity.duty_roster_attendance_mark(uuid, uuid, bigint, text, uuid, text, text) is
    '0202 (ROS-1, Q242 A): an editor marks a duty present, absent or swapped (with who worked instead), never their own, from 1 hour before the shift to 7 days after it. Outcomes marked (replayed), not_found, assignment_not_found, edit_not_allowed, not_published, own_not_allowed, not_open, changed, cover_invalid, key_reused. Audited (identity.duty-roster.attendance).';
  comment on function identity.duty_roster_on_duty(text) is
    '0202 (ROS-1): who is on duty now from the published rosters and attendance. Needs workforce.roster.read. Outcomes listed, department_invalid. Audited (identity.duty-roster.on-duty).';
  comment on function identity.duty_roster_my_duties() is
    '0202 (ROS-1): the caller''s own published duties here, 7 days back to 28 days ahead. Any active member. Audited (identity.duty-roster.my-duties).';
  comment on function identity.duty_roster_on_duty_at(uuid, timestamptz) is
    '0202 (ROS-1): who is on duty at a facility at a time (published rosters; absent left out; swapped shows who worked instead). No role may execute it; Ambulance dispatch and Quality may call it from their own functions later, md5-pinned.';

  -- Grants: EXECUTE for hid_identity_runtime on the eight definers only (here and in runtime-grants.sql).
  revoke all on function identity.duty_roster_shift_window(uuid, date), identity.duty_roster_week_ok(date),
    identity.duty_roster_assignment_card(uuid), identity.duty_roster_card(uuid, boolean),
    identity.duty_roster_on_duty_at(uuid, timestamptz), identity.duty_roster_idempotency(uuid, text, text),
    identity.duty_roster_assignments_guard(), identity.staff_leave_requests_roster_clash(),
    identity.duty_roster_list(date), identity.duty_roster_read(uuid), identity.duty_roster_create(text, date, text, text),
    identity.duty_roster_assignments_set(uuid, bigint, jsonb, text, text),
    identity.duty_roster_publish(uuid, bigint, text, text),
    identity.duty_roster_attendance_mark(uuid, uuid, bigint, text, uuid, text, text),
    identity.duty_roster_on_duty(text), identity.duty_roster_my_duties() from public;
  if v_runtime then
    grant execute on function identity.duty_roster_list(date), identity.duty_roster_read(uuid),
      identity.duty_roster_create(text, date, text, text),
      identity.duty_roster_assignments_set(uuid, bigint, jsonb, text, text),
      identity.duty_roster_publish(uuid, bigint, text, text),
      identity.duty_roster_attendance_mark(uuid, uuid, bigint, text, uuid, text, text),
      identity.duty_roster_on_duty(text), identity.duty_roster_my_duties() to hid_identity_runtime;
  end if;

  -- 3. Post-checks.
  if (select count(*) from pg_class relation
       where relation.oid = any (v_tables::regclass[])
         and relation.relowner = v_owner and relation.relrowsecurity and relation.relforcerowsecurity) <> 4
     or exists (select 1 from pg_class relation,
                  lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 where relation.oid = any (v_tables::regclass[]) and acl.grantee <> relation.relowner)
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = any (v_tables::regclass[])
            and policy_row.polpermissive and policy_row.polroles = array[0::oid]
            and ((policy_row.polcmd = 'r' and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true'
                  and policy_row.polwithcheck is null)
              or (policy_row.polcmd = 'a' and policy_row.polqual is null
                  and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'true')
              or (policy_row.polcmd = 'w' and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true'
                  and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'true')
              or (policy_row.polcmd = 'd' and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true'
                  and policy_row.polwithcheck is null))) <> 16
     or (select count(*) from pg_policy policy_row where policy_row.polrelid = any (v_tables::regclass[])) <> 16
     or exists (select 1 from pg_attribute attribute_row
                 left join pg_attrdef default_row on default_row.adrelid = attribute_row.attrelid
                       and default_row.adnum = attribute_row.attnum
                 where attribute_row.attrelid = any (v_tables::regclass[]) and attribute_row.attnum > 0
                   and (attribute_row.attidentity <> ''
                        or pg_get_expr(default_row.adbin, default_row.adrelid) like '%nextval%')) then
    raise exception using errcode = '55000', message = '0202: post-check failed (the tables'' owner, row-level security, '
      || 'policies or privileges)';
  end if;
  -- The plain triggers (platform.reject_mutation(), no WHEN, no column list, no arguments, enabled), the guard
  -- (23: before insert or update for each row, UPDATE OF status, starts_at, ends_at and rest_until, no WHEN, no
  -- arguments) and the leave trigger (19: before update for each row, UPDATE OF status, its WHEN condition), each
  -- as made; and no other trigger on the new tables, and only 0200's two and this one on the leave table.
  if (select count(*) from generate_subscripts(v_triggers, 1) idx
        join pg_trigger trigger_row on trigger_row.tgrelid = v_triggers[idx][1]::regclass
                                   and trigger_row.tgname = v_triggers[idx][2]
       where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
         and trigger_row.tgtype = v_triggers[idx][3]::smallint and trigger_row.tgqual is null
         and trigger_row.tgattr = ''::int2vector and trigger_row.tgnargs = 0
         and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure) <> 8
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'identity.duty_roster_assignments'::regclass
                       and trigger_row.tgname = 'duty_roster_assignments_guard' and not trigger_row.tgisinternal
                       and trigger_row.tgenabled = 'O' and trigger_row.tgtype = 23 and trigger_row.tgqual is null
                       and trigger_row.tgnargs = 0
                       and trigger_row.tgfoid = 'identity.duty_roster_assignments_guard()'::regprocedure
                       and (select array_agg(attribute_row.attname::text order by attribute_row.attname)
                              from unnest(trigger_row.tgattr::int2[]) column_number(attnum)
                              join pg_attribute attribute_row on attribute_row.attrelid = trigger_row.tgrelid
                                   and attribute_row.attnum = column_number.attnum)
                           = array['ends_at', 'rest_until', 'starts_at', 'status']
                       and pg_get_triggerdef(trigger_row.oid) = v_guard_definition)
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'identity.staff_leave_requests'::regclass
                       and trigger_row.tgname = 'staff_leave_requests_roster_clash' and not trigger_row.tgisinternal
                       and trigger_row.tgenabled = 'O' and trigger_row.tgtype = 19 and trigger_row.tgqual is not null
                       and trigger_row.tgnargs = 0
                       and trigger_row.tgfoid = 'identity.staff_leave_requests_roster_clash()'::regprocedure
                       and (select array_agg(attribute_row.attname::text)
                              from unnest(trigger_row.tgattr::int2[]) column_number(attnum)
                              join pg_attribute attribute_row on attribute_row.attrelid = trigger_row.tgrelid
                                   and attribute_row.attnum = column_number.attnum) = array['status']
                       and pg_get_triggerdef(trigger_row.oid) = v_clash_definition)
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = any (v_tables::regclass[]) and not trigger_row.tgisinternal) <> 9
     or (select array_agg(trigger_row.tgname::text order by trigger_row.tgname) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'identity.staff_leave_requests'::regclass and not trigger_row.tgisinternal)
        is distinct from array['staff_leave_requests_no_delete', 'staff_leave_requests_no_truncate',
                               'staff_leave_requests_roster_clash'] then
    raise exception using errcode = '55000', message = '0202: post-check failed (the triggers)';
  end if;
  select string_agg(v_functions[idx][1] || ' (' || coalesce(md5(proc.prosrc), 'missing') || ')', ', ')
    into v_mismatch
    from generate_subscripts(v_functions, 1) idx
    left join pg_proc proc on proc.oid = to_regprocedure(v_functions[idx][1])
   where proc.oid is null
      or md5(proc.prosrc) is distinct from v_functions[idx][2]
      or proc.proowner <> v_owner
      or proc.prosecdef <> v_functions[idx][3]::boolean
      or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
      or exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                  where acl.grantee <> proc.proowner
                    and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime'
                         or not v_functions[idx][4]::boolean))
      or (v_runtime and v_functions[idx][4]::boolean
          and not has_function_privilege('hid_identity_runtime', proc.oid, 'EXECUTE'));
  if v_mismatch is not null
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'identity' and proc.proname = any (v_function_names))
        <> array_length(v_functions, 1) then
    raise exception using errcode = '55000',
      message = '0202: post-check failed (these functions are not as reviewed: ' || coalesce(v_mismatch, 'an extra one')
        || ')';
  end if;
  if (select array[rule.id::text, rule.min_rest_minutes::text, rule.clinical_status, rule.changed_by_migration]
        from identity.duty_roster_rules rule) is distinct from array['1', '480', 'draft', '0202']
     or (select count(*) from identity.duty_roster_rules) <> 1 then
    raise exception using errcode = '55000', message = '0202: post-check failed (the draft rule row)';
  end if;

  raise notice '0202: the duty roster is installed (4 tables, 16 functions, the guard and the leave clash trigger; minimum rest DRAFT 480 minutes, awaiting the clinical lead). identity-api''s DUTY_ROSTER_ENABLED keeps the routes closed until the go-live.';
end
$hr0202$;
