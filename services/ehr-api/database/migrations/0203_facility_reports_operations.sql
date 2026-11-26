-- 0203 REP-1 Provider reports, operations figures first: the figures
-- (Release D, the department sprint the owner approved on 25 November 2026).
-- Written on staging-novu-ci-20261005 at 0cfddcc9 (0001-0153 applied:
-- Release A, B, C and E). The number is provisional: numbers are given at
-- integration, in release order, after the files booked before it. This
-- file reads nothing 0154-0202 create, so it applies on 0001-0153 and on any
-- later base that keeps what it reads; it applies with or without ED-1's
-- 0168 and APPT-1's 0160 (they change ehr.visit_queue too: their CHECK and
-- triggers are untouched here, and theirs leave this file's alone). No
-- migration number appears inside a function body. The declaration in
-- config/production-schema-compatibility.json stays unsigned until the owner
-- signs this file. 0204 (who reads reports) is its own file.
--
-- Decisions this file is built on (owner decisions of 25 November 2026, the
-- sprint sheet's recommended options, docs/EHR_PLANNED_CONTRACT.md REP-1):
-- Q237 A (figures worked out on demand from live data, indexed, at most 92
-- days, one facility; no nightly totals), Q238 A (operations figures only),
-- Q239 A (totals only: no answer and no audit row names a patient), Q241 A
-- (the session's facility only: the facility is never an argument a runtime
-- chooses), Q149 A (the service switches REPORTS_ENABLED and
-- REPORTS_EXPORT_ENABLED, seeded off), Q124 A (the figure definitions ship
-- as a draft: every answer says signedOff false until the clinical lead and
-- Ola sign them).
--
-- What it changes (nothing else):
-- R1 ehr.visit_queue (0135)    two columns, first_with_clinician_at
--                              (timestamptz) and wait_tracked (boolean). Rows
--                              that exist when this file applies keep null in
--                              both (not tracked): adding a column without a
--                              default rewrites no row. A CHECK,
--                              visit_queue_report_stamp_ck: the stamp is null,
--                              or wait_tracked is true and the stamp is not
--                              before checked_in_at. A trigger,
--                              visit_queue_report_stamp (BEFORE INSERT OR
--                              UPDATE, FOR EACH ROW, no column list, no WHEN),
--                              runs ehr.visit_queue_report_stamp() (plpgsql,
--                              SECURITY INVOKER, fixed search_path, EXECUTE
--                              for no role; a trigger needs none). On insert
--                              it sets wait_tracked true, and the stamp to
--                              stage_changed_at (never before checked_in_at)
--                              when the row starts at with_clinician. On
--                              update it keeps both columns as they were,
--                              except that a tracked row reaching
--                              with_clinician with no stamp yet gets
--                              stage_changed_at (never before checked_in_at).
--                              So whatever a writer sends for the two
--                              columns, the owner included, the trigger
--                              decides them: 0135's, ED-1's and APPT-1's
--                              functions need no change, and the stamp is the
--                              first move to "With clinician" for every
--                              writer. It writes only the row's own two
--                              columns, so ED-1's guard (BEFORE UPDATE OF its
--                              four columns, which fires first by name) and
--                              close mirror, APPT-1's CHECK and BILL-1's AFTER
--                              triggers see the same row whichever file
--                              applies first.
-- R2 Seven indexes for the day ranges (the other figures use
--    encounters_facility_status_idx, registration_cases_facility_status_idx
--    and order_route_unable_endings_facility_idx, which exist):
--      ehr.visit_queue (facility_id, queue_day)                visit_queue_report_day_idx
--      ehr.encounters (facility_id, ended_at)
--        where status = 'completed'                            encounters_report_completed_idx
--      ehr.lab_requests (facility_id, created_at)              lab_requests_report_day_idx
--      lab.specimens (facility_id, collected_at)
--        where collected_at is not null                        specimens_report_collected_idx
--      lab.result_releases (facility_id, released_at)          result_releases_report_day_idx
--      pharmacy.dispensings (facility_id, dispensed_at)        dispensings_report_day_idx
--      pharmacy.dispensing_reversals (facility_id, reversed_at) dispensing_reversals_report_day_idx
-- R3 The owner's count, only while a report counts (0143's marker pattern).
--    The functions below run as the owner of ehr.visit_queue, and every
--    source table but ehr.visit_queue has row-level security forced. Six of
--    them let their owner read nothing: lab.specimens, lab.test_executions,
--    lab.result_releases, pharmacy.dispensings, pharmacy.dispensing_reversals
--    and ehr.lab_requests (whose owner reads only under 0143's and 0145's own
--    markers). ehr.encounters and identity.registration_cases already have
--    an owner read policy (encounters_owner_read, registration_cases_owner_read),
--    but PostgreSQL joins a table's permissive policies with OR in reverse
--    order of their names and stops at the first that holds (0133, THE COST),
--    so those two are asked last, after 0086's consent test on every
--    encounter (about 1 ms a row: 50,000 visits would take the call past its
--    15-second limit) and after the registration staff and platform review
--    checks. So each of the eight gets the same marker policy:
--    - ehr.report_scans (backend_pid, transaction_started_at), primary key on
--      both: one row while a report counts, for this backend's transaction
--      only. Row-level security enabled and forced, four policies (as 0091's
--      ehr.order_route_unable_endings: every command, using true) so that its
--      owner, the only role with any privilege on it, is bound by them; no
--      grant to any role. Not history: the counting helper deletes its row
--      before it returns, and a raise rolls it back.
--    - ehr.report_scan_open() (SQL, STABLE, SECURITY DEFINER, fixed
--      search_path, cost 1): whether this backend's own transaction holds a
--      marker. EXECUTE to PUBLIC: every role that reads the eight tables
--      evaluates their policies, and PostgreSQL checks EXECUTE on each
--      function of a plan when it starts it. It answers nothing else.
--    - One read policy per table, <table>_scan_reports (on the two Pharmacy
--      tables pharmacy_dispensings_scan_reports and
--      pharmacy_reversals_scan_reports, after their consent policies'
--      prefixes, so that 0086's consent test is not asked first), FOR
--      SELECT, to PUBLIC, permissive: true only when the current role is the
--      table's owner or inherits it (pg_has_role USAGE) and
--      ehr.report_scan_open() is true; the owner test comes first (CASE), so
--      a runtime role's read never
--      asks the marker, and the whole test is one scalar subquery, which
--      PostgreSQL runs once per statement (an InitPlan), never per row. So no
--      runtime role's reads change, and the owner without a marker sees what
--      it saw before. The eight: ehr.encounters, ehr.lab_requests,
--      identity.registration_cases, lab.specimens, lab.test_executions,
--      lab.result_releases, pharmacy.dispensings and
--      pharmacy.dispensing_reversals. By name, the marker policy is the first
--      read policy asked on ehr.encounters, ehr.lab_requests and
--      lab.test_executions; on lab.specimens, lab.result_releases,
--      pharmacy.dispensings and pharmacy.dispensing_reversals 0133's
--      staff_own_work_read is asked first, and it calls nothing for a session
--      whose purpose is not direct care (0133, THE COST), then the marker; on
--      identity.registration_cases registration_cases_staff_access is asked
--      first (one permission check a row, true for an administrator holding
--      identity.registration.write). The post-checks hold that order.
--    ehr.order_route_unable_endings already lets its owner read it (0091,
--    using true), and ehr.visit_queue's row-level security is not forced
--    (0135's stated exception), so neither needs a policy.
-- R4 Functions, owned by the owner of ehr.visit_queue (0135's: the owner of
--    identity.has_active_consent_grant), search_path pg_catalog, pg_temp, no
--    temporary table, every relation and type name schema-qualified or
--    pg_catalog's (pg_temp is never searched for functions or operators, and
--    pg_catalog comes first):
--    - ehr.facility_report_operations_figures(facility, from, to, suppress)
--      (plpgsql, SECURITY INVOKER, EXECUTE for no role: it runs only inside
--      the two below, as their owner). It writes the marker, counts in one
--      statement, deletes the marker, then builds the report. While the
--      marker exists it calls no function but pg_catalog's and
--      ehr.report_scan_open() (from the policies), so no other owner-run
--      function or trigger ever reads what the policies open; a raise
--      anywhere rolls the marker back with the transaction.
--    - ehr.facility_report_operations(from, to, switched_on) and
--      ehr.facility_report_operations_export(from, to, format, switched_on)
--      (plpgsql, SECURITY DEFINER, EXECUTE for hid_ehr_runtime only, here
--      when the role exists and in runtime-grants.sql). Each checks, in this
--      order: the caller (an account, an active membership at the session
--      facility that the cutover does not hold, reports.read and, for the
--      download, reports.export through auth.membership_has_permission;
--      else 42501 REPORTS_NOT_PERMITTED or REPORTS_EXPORT_NOT_PERMITTED); the
--      purpose, healthcare-operations only (else 22023
--      REPORTS_OPERATIONS_PURPOSE_ONLY); the switch: switched_on (ehr-api's
--      setting), or the session facility is a sealed demo or sealed QA
--      facility (else 55000 REPORTS_SWITCHED_OFF or
--      REPORTS_EXPORT_SWITCHED_OFF); the range of Lagos days: both given,
--      from on or before to, to today or earlier, from no more than 2 years
--      before today (else 22023 REPORT_RANGE_INVALID), at most 92 days both
--      included (else 22023 REPORT_RANGE_TOO_LONG); the download's format,
--      csv or pdf (else 22023 REPORT_FORMAT_INVALID). The facility is always
--      platform.current_facility_id(). Without 0204 no role holds a report
--      code, so both refuse: the database half of "built but switched off".
-- R5 Audit, in the request's transaction, one row per call that answers:
--    ehr.reports.operations.read (details from, to, days, includesToday,
--    figures) and ehr.reports.operations.exported (details from, to, days,
--    format, figures, values, suppressedValues, minimumCount); resource
--    facility-report "operations", purpose as sent, no patient, never a
--    figure's value. A refusal the functions raise rolls back; ehr-api's
--    request audit records it. This file itself writes no audit row.
--
-- The figures (draft definitions "rep1-draft-1", awaiting the clinical
-- lead's and Ola's sign-off). Each record counts once, on the Lagos day
-- named; the previous period is the same number of days just before from:
--   waitingList   checkedIn             visit_queue, queue_day: every check-in
--                 seen                  tracked, reached with_clinician or closed finished
--                 leftWithoutBeingSeen  tracked, closed left, never reached with_clinician
--                 cancelled             closed cancelled
--                 medianWaitMinutes     tracked with a stamp: check-in to the stamp
--                 (coverage on the three tracked figures: tracked check-ins in each period)
--   registrations newHealthIds          registration_cases, created_at: approved_new_identity
--                 existingHealthIds     resolved_existing_identity or linked_existing
--   visits        opened                encounters, started_at: not imported from paper,
--                                       not cancelled or entered_in_error
--                 completed             encounters, ended_at: completed, not imported from paper
--   lab           requested             lab_requests, created_at: active, on_hold or completed
--                 specimensCollected    specimens, collected_at: collected, received or rejected
--                 resultsReleased       result_releases: each result once, on its first release
--                 medianTurnaroundMinutes  the sample's collection to the result's first release
--   pharmacy      dispensed             dispensings, dispensed_at: not reversed
--                 dispensingsReversed   dispensing_reversals, reversed_at
--                 notCompleted          order_route_unable_endings, recorded_at: prescriptions
--                                       this facility received, with the eight reasons of 0091
-- Medians are whole minutes, half up, with their sample size; a median with
-- no sample is null with sample size 0. With suppress (the download) every
-- count from 1 to 4 (totals, daily values, reasons, coverage, sample sizes)
-- is null with <field>Suppressed (in a daily entry, suppressed) true beside
-- it, and so is every median whose sample is 1 to 4; 0 and 5 or more are
-- shown.
--
-- Locks (measured with pg_locks before commit and compared by the
-- migrations suite), taken first, NOWAIT, in one LOCK statement: ACCESS
-- EXCLUSIVE on ehr.visit_queue (the columns, the CHECK, the trigger),
-- ehr.encounters, ehr.lab_requests, identity.registration_cases,
-- lab.specimens, lab.test_executions, lab.result_releases,
-- pharmacy.dispensings and pharmacy.dispensing_reversals (each policy; the
-- index builds need less). The CHECK and the seven index builds read their
-- tables once; on the live system these tables are small, so the file holds
-- them well under a second; run it at a quiet time. This file calls no
-- function that reads a table. A busy table fails the attempt at once, and
-- its subtransaction releases what it took. The attempt is made 50 times,
-- 100 ms apart (about 5 seconds), so the file never waits for one of its
-- locks while holding the others; then 55P03 (nothing applied). When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run applies every pending file
-- in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied. Both refusals begin "0203: " and end "run the release again at a
-- quieter time", so the runner's dry run rolls back and tries again (#306).
-- Other waits are not NOWAIT, and the runner's lock_timeout ends each after
-- 5 seconds (nothing applied): an index or catalog row that maintenance
-- holds, or DDL in flight on a function this file reads.
--
-- Old images on this schema: nothing calls the new functions. The policies
-- change nothing for any runtime role (each is false for a role that is not
-- the table's owner, without asking the marker). The trigger only fills the
-- two new columns, inside 0135's, ED-1's and APPT-1's own functions; no
-- image reads them but this branch's.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- three report functions, the eight policies, ehr.report_scan_open(),
-- ehr.report_scans, the seven indexes, the trigger, its function, the CHECK
-- and the two columns (the stamps are lost).
--
-- The whole file is one statement (do $rep0203$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): "0203: already applied" when
--    every object of this file is there exactly as it leaves it, "0203: the
--    schema is not in the reviewed state" when any of them is there
--    otherwise; the columns this file reads in 0135's, 0113's, 0130's,
--    0018-0021's, 0023's and 0091's tables, by name and type; the bodies the
--    functions call md5-pinned (the permission check, the sealed facility
--    tests, the session readers, the account lookup); the owners in 0133's
--    form: the owner of ehr.visit_queue owns, or inherits the owner of, each
--    source table, may run what the functions call and write audit rows, the
--    applying role may act for it, and no hid_ role but the owners is a
--    member of a source table's owner. A NOTICE names every owner checked;
--    Rahman confirms them for production before signing.
-- 2. R1-R4.
-- 3. Post-checks (0148's and 0152's form): exactly this file's objects, as
--    made (the columns, the CHECK, the trigger by tgtype, tgqual, tgattr,
--    tgnargs, tgfoid and tgenabled, the trigger function, the seven index
--    definitions, the marker table with row-level security enabled and
--    forced and its four policies, the eight marker policies by command,
--    roles and expression, each function's language, volatility, prosecdef,
--    proconfig and result); every new object the owner's; the marker table
--    granted to no role; the marker check EXECUTE to PUBLIC; the counting
--    helper and the trigger function to no role; the two report functions to
--    hid_ehr_runtime only; the read policies asked before each marker policy
--    exactly the ones named in R3; no hid_ role but the owners a member of a
--    source table's owner; every waiting-list row unchanged, with both new
--    columns null; no marker row.

do $rep0203$
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
  v_mismatch text;
  v_owner name;
  v_owner_oid oid;
  v_owners_named text;
  v_queue_rows text;
  v_state text[];
  -- What this file leaves, one line per object, in byte order: the post-check compares it with what is there, and a
  -- second run answers "already applied" only when exactly this is there.
  v_state_sql constant text := $state$
    select coalesce(array_agg(described.item order by described.item collate "C"), array[]::text[])
      from (
        select format('column ehr.visit_queue.%s %s', attribute_row.attname,
                 format_type(attribute_row.atttypid, attribute_row.atttypmod)) as item
          from pg_attribute attribute_row
         where attribute_row.attrelid = 'ehr.visit_queue'::regclass and attribute_row.attnum > 0
           and not attribute_row.attisdropped and attribute_row.attname in ('first_with_clinician_at', 'wait_tracked')
        union all
        select format('constraint %s on %s: %s, validated %s', constraint_row.conname,
                 constraint_row.conrelid::regclass, pg_get_constraintdef(constraint_row.oid),
                 constraint_row.convalidated::text)
          from pg_constraint constraint_row
         where constraint_row.conname like '%report\_stamp%'
        union all
        select format('trigger %s on %s: type %s, function %s, when %s, columns [%s], arguments %s, enabled %s',
                 trigger_row.tgname, trigger_row.tgrelid::regclass, trigger_row.tgtype,
                 trigger_row.tgfoid::regprocedure, coalesce(pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid), '-'),
                 trigger_row.tgattr::text, trigger_row.tgnargs, trigger_row.tgenabled)
          from pg_trigger trigger_row
         where not trigger_row.tgisinternal and trigger_row.tgname like '%report\_stamp%'
        union all
        select format('index %s, valid %s', pg_get_indexdef(index_row.indexrelid), index_row.indisvalid::text)
          from pg_index index_row join pg_class index_class on index_class.oid = index_row.indexrelid
         where index_class.relname like '%\_report\_%\_idx'
        union all
        select format('table %s: kind %s, row security %s, forced %s', class_row.oid::regclass, class_row.relkind,
                 class_row.relrowsecurity::text, class_row.relforcerowsecurity::text)
          from pg_class class_row join pg_namespace namespace on namespace.oid = class_row.relnamespace
         where namespace.nspname = 'ehr' and class_row.relname like 'report\_scan%' and class_row.relkind <> 'i'
        union all
        select format('policy %s on %s: command %s, permissive %s, roles %s, using %s, check %s', policy_row.polname,
                 policy_row.polrelid::regclass, policy_row.polcmd, policy_row.polpermissive::text,
                 policy_row.polroles::text, coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-'),
                 coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '-'))
          from pg_policy policy_row
         where policy_row.polname like '%\_scan\_reports' or policy_row.polname like 'report\_scans\_%'
        union all
        select format('function %s: language %s, volatility %s, security definer %s, config %s, returns %s',
                 proc.oid::regprocedure, language_row.lanname, proc.provolatile, proc.prosecdef::text, proc.proconfig::text,
                 pg_get_function_result(proc.oid))
          from pg_proc proc
          join pg_namespace namespace on namespace.oid = proc.pronamespace
          join pg_language language_row on language_row.oid = proc.prolang
         where namespace.nspname = 'ehr'
           and (proc.proname like 'facility\_report\_%' or proc.proname like 'report\_scan%'
                or proc.proname like '%report\_stamp%')
      ) described
  $state$;
  v_expected constant text[] := array[
    'column ehr.visit_queue.first_with_clinician_at timestamp with time zone',
    'column ehr.visit_queue.wait_tracked boolean',
    'constraint visit_queue_report_stamp_ck on ehr.visit_queue: CHECK (((first_with_clinician_at IS NULL) OR ((wait_tracked IS TRUE) AND (first_with_clinician_at >= checked_in_at)))), validated true',
    'function ehr.facility_report_operations(date,date,boolean): language plpgsql, volatility v, security definer true, config {"search_path=pg_catalog, pg_temp"}, returns jsonb',
    'function ehr.facility_report_operations_export(date,date,text,boolean): language plpgsql, volatility v, security definer true, config {"search_path=pg_catalog, pg_temp"}, returns jsonb',
    'function ehr.facility_report_operations_figures(uuid,date,date,boolean): language plpgsql, volatility v, security definer false, config {"search_path=pg_catalog, pg_temp",jit=off}, returns jsonb',
    'function ehr.report_scan_open(): language sql, volatility s, security definer true, config {"search_path=pg_catalog, pg_temp"}, returns boolean',
    'function ehr.visit_queue_report_stamp(): language plpgsql, volatility v, security definer false, config {"search_path=pg_catalog, pg_temp"}, returns trigger',
    'index CREATE INDEX dispensing_reversals_report_day_idx ON pharmacy.dispensing_reversals USING btree (facility_id, reversed_at), valid true',
    'index CREATE INDEX dispensings_report_day_idx ON pharmacy.dispensings USING btree (facility_id, dispensed_at), valid true',
    'index CREATE INDEX encounters_report_completed_idx ON ehr.encounters USING btree (facility_id, ended_at) WHERE (status = ''completed''::text), valid true',
    'index CREATE INDEX lab_requests_report_day_idx ON ehr.lab_requests USING btree (facility_id, created_at), valid true',
    'index CREATE INDEX result_releases_report_day_idx ON lab.result_releases USING btree (facility_id, released_at), valid true',
    'index CREATE INDEX specimens_report_collected_idx ON lab.specimens USING btree (facility_id, collected_at) WHERE (collected_at IS NOT NULL), valid true',
    'index CREATE INDEX visit_queue_report_day_idx ON ehr.visit_queue USING btree (facility_id, queue_day), valid true',
    'POLICIES',
    'table ehr.report_scans: kind r, row security true, forced true',
    'trigger visit_queue_report_stamp on ehr.visit_queue: type 23, function ehr.visit_queue_report_stamp(), when -, columns [], arguments 0, enabled O'];
  -- The eight marker policies' expression, with the table's name for %1$s (as pg_get_expr prints it).
  v_marker_using constant text := '( SELECT
        CASE
            WHEN pg_has_role(( SELECT relation.relowner
               FROM pg_class relation
              WHERE (relation.oid = (''%1$s''::regclass)::oid)), ''USAGE''::text) THEN ehr.report_scan_open()
            ELSE false
        END AS "case")';
  v_expected_all text[];
  v_source_tables constant regclass[] := array['ehr.visit_queue', 'ehr.encounters', 'ehr.lab_requests',
    'identity.registration_cases', 'lab.specimens', 'lab.test_executions', 'lab.result_releases',
    'pharmacy.dispensings', 'pharmacy.dispensing_reversals', 'ehr.order_route_unable_endings']::regclass[];
  v_policy_tables constant regclass[] := array['ehr.encounters', 'ehr.lab_requests', 'identity.registration_cases',
    'lab.specimens', 'lab.test_executions', 'lab.result_releases', 'pharmacy.dispensings',
    'pharmacy.dispensing_reversals']::regclass[];
  -- Their marker policies, in the same order: <table>_scan_reports, except on the two Pharmacy tables, whose consent
  -- policies (pharmacy_dispensings_read, pharmacy_reversals_read) would sort after that name and so be asked first.
  v_policy_names constant text[] := array['encounters_scan_reports', 'lab_requests_scan_reports',
    'registration_cases_scan_reports', 'specimens_scan_reports', 'test_executions_scan_reports',
    'result_releases_scan_reports', 'pharmacy_dispensings_scan_reports', 'pharmacy_reversals_scan_reports'];
begin
  -- 0. The locks, NOWAIT, all in one LOCK statement. (The attempt's block is not indented, so step 0 reads as its own
  -- step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table ehr.visit_queue, ehr.encounters, ehr.lab_requests, identity.registration_cases, lab.specimens,
    lab.test_executions, lab.result_releases, pharmacy.dispensings, pharmacy.dispensing_reversals
    in access exclusive mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0203: ehr.visit_queue or a table whose figures 0203 counts (the visits, lab requests, registration '
          || 'cases, samples, test runs, result releases, dispensings and dispensing reversals) is busy, and this '
          || 'transaction already holds an earlier migration''s locks, so it does not wait; nothing applied; run the '
          || 'release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0203: ehr.visit_queue or a table whose figures 0203 counts (the visits, lab requests, registration '
          || 'cases, samples, test runs, result releases, dispensings and dispensing reversals) stayed busy for 5 '
          || 'seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- What this file leaves: the fixed lines, then one line per marker policy (the eight, then the marker table's four).
  select array_agg(line order by line collate "C") into v_expected_all
    from (select expected.line from unnest(v_expected) expected(line) where expected.line <> 'POLICIES'
          union all
          select format('policy %s on %s: command r, permissive true, roles {0}, using %s, check -',
                   policy_table.policy_name, policy_table.relation, format(v_marker_using, policy_table.relation))
            from unnest(v_policy_tables, v_policy_names) policy_table(relation, policy_name)
          union all
          select format('policy report_scans_owner_%s on ehr.report_scans: command %s, permissive true, roles {0}, '
                   || 'using %s, check %s', command.name, command.code, command.using_text, command.check_text)
            from (values ('delete', 'd', 'true', '-'), ('insert', 'a', '-', 'true'), ('read', 'r', 'true', '-'),
                         ('update', 'w', 'true', 'true')) command(name, code, using_text, check_text)) expected_lines;
  execute v_state_sql into v_state;
  if v_state = v_expected_all then
    raise exception using errcode = '55000', message = '0203: already applied';
  end if;
  if cardinality(v_state) <> 0 then
    raise exception using errcode = '55000',
      message = '0203: the schema is not in the reviewed state (part of 0203, or an object with one of its names, is '
        || 'there); nothing applied';
  end if;

  -- The columns this file reads (and, for ehr.visit_queue, keeps), by name and type.
  select string_agg(wanted.relation || '.' || wanted.column_name, ', ' order by wanted.relation, wanted.column_name)
    into v_mismatch
    from (values
      ('ehr.visit_queue', 'facility_id', 'uuid'), ('ehr.visit_queue', 'queue_day', 'date'),
      ('ehr.visit_queue', 'stage', 'text'), ('ehr.visit_queue', 'checked_in_at', 'timestamp with time zone'),
      ('ehr.visit_queue', 'stage_changed_at', 'timestamp with time zone'),
      ('identity.registration_cases', 'facility_id', 'uuid'), ('identity.registration_cases', 'status', 'text'),
      ('identity.registration_cases', 'created_at', 'timestamp with time zone'),
      ('ehr.encounters', 'facility_id', 'uuid'), ('ehr.encounters', 'status', 'text'),
      ('ehr.encounters', 'started_at', 'timestamp with time zone'),
      ('ehr.encounters', 'ended_at', 'timestamp with time zone'),
      ('ehr.encounters', 'imported_paper_records', 'boolean'),
      ('ehr.lab_requests', 'facility_id', 'uuid'), ('ehr.lab_requests', 'status', 'text'),
      ('ehr.lab_requests', 'created_at', 'timestamp with time zone'),
      ('lab.specimens', 'id', 'uuid'), ('lab.specimens', 'facility_id', 'uuid'), ('lab.specimens', 'status', 'text'),
      ('lab.specimens', 'collected_at', 'timestamp with time zone'),
      ('lab.test_executions', 'id', 'uuid'), ('lab.test_executions', 'specimen_id', 'uuid'),
      ('lab.result_releases', 'id', 'uuid'), ('lab.result_releases', 'result_id', 'uuid'),
      ('lab.result_releases', 'execution_id', 'uuid'), ('lab.result_releases', 'facility_id', 'uuid'),
      ('lab.result_releases', 'released_at', 'timestamp with time zone'),
      ('pharmacy.dispensings', 'id', 'uuid'), ('pharmacy.dispensings', 'facility_id', 'uuid'),
      ('pharmacy.dispensings', 'dispensed_at', 'timestamp with time zone'),
      ('pharmacy.dispensing_reversals', 'dispensing_id', 'uuid'),
      ('pharmacy.dispensing_reversals', 'facility_id', 'uuid'),
      ('pharmacy.dispensing_reversals', 'reversed_at', 'timestamp with time zone'),
      ('ehr.order_route_unable_endings', 'kind', 'text'),
      ('ehr.order_route_unable_endings', 'receiving_facility_id', 'uuid'),
      ('ehr.order_route_unable_endings', 'reason_code', 'text'),
      ('ehr.order_route_unable_endings', 'recorded_at', 'timestamp with time zone'),
      ('identity.staff_facility_memberships', 'id', 'uuid'),
      ('identity.staff_facility_memberships', 'account_id', 'uuid'),
      ('identity.staff_facility_memberships', 'organization_id', 'uuid'),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid'),
      ('identity.staff_facility_memberships', 'active', 'boolean'),
      ('identity.staff_facility_memberships', 'migration_hold_reason', 'text')
    ) wanted(relation, column_name, type_name)
   where to_regclass(wanted.relation) is null
      or not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = to_regclass(wanted.relation)
                        and attribute_row.attname = wanted.column_name and attribute_row.attnum > 0
                        and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000',
      message = '0203: these columns are not as 0001-0153 left them: ' || v_mismatch || '; nothing applied';
  end if;
  -- The bodies the functions call, as 0001-0153 leave them.
  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000',
      message = '0203: these bodies are not as 0001-0153 left them: ' || v_mismatch || '; nothing applied';
  end if;
  -- The owner read policy 0091 gave ehr.order_route_unable_endings (this file adds none there).
  if not exists (select 1 from pg_policy policy_row
                  where policy_row.polrelid = 'ehr.order_route_unable_endings'::regclass
                    and policy_row.polname = 'order_route_unable_endings_command_read' and policy_row.polcmd = 'r'
                    and policy_row.polpermissive and policy_row.polroles = '{0}'::oid[]
                    and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true') then
    raise exception using errcode = '55000',
      message = '0203: ehr.order_route_unable_endings is not readable by its owner as 0091 left it; nothing applied';
  end if;

  -- The owners, in 0133's form.
  v_owner_oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.visit_queue'::regclass);
  v_owner := pg_get_userbyid(v_owner_oid);
  select string_agg(distinct format('%s=%s', checked.what, pg_get_userbyid(checked.role_id)), ', ')
    into v_owners_named
    from (select source_table.relation::text as what, relation.relowner as role_id
            from unnest(v_source_tables) source_table(relation)
            join pg_class relation on relation.oid = source_table.relation
          union all
          select proc.oid::regprocedure::text, proc.proowner from pg_proc proc
           where proc.oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure)
         checked;
  raise notice '0203: owners checked: %', v_owners_named;
  -- a. The functions' owner reads every source table: it owns it, or inherits its owner.
  select string_agg(source_table.relation::text, ', ') into v_mismatch
    from unnest(v_source_tables) source_table(relation)
    join pg_class relation on relation.oid = source_table.relation
   where not pg_has_role(v_owner_oid, relation.relowner, 'USAGE');
  if v_mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0203: %s, the owner of ehr.visit_queue that will own the report functions, does not own or '
        || 'inherit the owner of: %s; nothing applied', v_owner, v_mismatch);
  end if;
  -- b. It may run what the functions call, write their audit rows and read the memberships.
  select string_agg(needed.what, ', ') into v_mismatch
    from (values
      ('EXECUTE auth.membership_has_permission', has_function_privilege(v_owner_oid,
         'auth.membership_has_permission(text,uuid,uuid,text)', 'EXECUTE')),
      ('EXECUTE identity.sealed_demo_facility', has_function_privilege(v_owner_oid,
         'identity.sealed_demo_facility(uuid)', 'EXECUTE')),
      ('EXECUTE identity.sealed_qa_facility', has_function_privilege(v_owner_oid,
         'identity.sealed_qa_facility(uuid)', 'EXECUTE')),
      ('EXECUTE auth.account_id_for_subject', has_function_privilege(v_owner_oid,
         'auth.account_id_for_subject(text)', 'EXECUTE')),
      ('EXECUTE platform.current_actor_subject', has_function_privilege(v_owner_oid,
         'platform.current_actor_subject()', 'EXECUTE')),
      ('EXECUTE platform.current_facility_id', has_function_privilege(v_owner_oid,
         'platform.current_facility_id()', 'EXECUTE')),
      ('EXECUTE platform.current_membership_id', has_function_privilege(v_owner_oid,
         'platform.current_membership_id()', 'EXECUTE')),
      ('EXECUTE platform.current_correlation_id', has_function_privilege(v_owner_oid,
         'platform.current_correlation_id()', 'EXECUTE')),
      ('EXECUTE platform.current_purpose_of_use', has_function_privilege(v_owner_oid,
         'platform.current_purpose_of_use()', 'EXECUTE')),
      ('INSERT audit.events', has_table_privilege(v_owner_oid, 'audit.events', 'INSERT')),
      ('SELECT identity.staff_facility_memberships',
         has_table_privilege(v_owner_oid, 'identity.staff_facility_memberships', 'SELECT')),
      ('USAGE on schema ehr', has_schema_privilege(v_owner_oid, 'ehr', 'USAGE')),
      ('CREATE on schema ehr', has_schema_privilege(v_owner_oid, 'ehr', 'CREATE')),
      ('USAGE on schema lab', has_schema_privilege(v_owner_oid, 'lab', 'USAGE')),
      ('USAGE on schema pharmacy', has_schema_privilege(v_owner_oid, 'pharmacy', 'USAGE')),
      ('USAGE on schema identity', has_schema_privilege(v_owner_oid, 'identity', 'USAGE')),
      ('USAGE on schema auth', has_schema_privilege(v_owner_oid, 'auth', 'USAGE')),
      ('USAGE on schema platform', has_schema_privilege(v_owner_oid, 'platform', 'USAGE')),
      ('USAGE on schema audit', has_schema_privilege(v_owner_oid, 'audit', 'USAGE'))
    ) needed(what, held)
   where not needed.held;
  if v_mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0203: %s, the owner of ehr.visit_queue that will own the report functions, lacks: %s; '
        || 'nothing applied', v_owner, v_mismatch);
  end if;
  -- c. The applying role is that owner, or inherits it and may SET ROLE to it (to hand the new objects over), and
  -- owns or inherits each table it adds a policy, an index or a column to.
  if not (current_user = v_owner
          or (pg_has_role(current_user, v_owner_oid, 'USAGE') and pg_has_role(current_user, v_owner_oid, 'SET'))) then
    raise exception using errcode = '55000',
      message = format('0203: %s must own, or inherit from and be able to SET ROLE to, %s, the owner of '
        || 'ehr.visit_queue; nothing applied', current_user, v_owner);
  end if;
  select string_agg(source_table.relation::text, ', ') into v_mismatch
    from unnest(v_source_tables[1:9]) source_table(relation)
    join pg_class relation on relation.oid = source_table.relation
   where not pg_has_role(current_user, relation.relowner, 'USAGE');
  if v_mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0203: %s does not own or inherit the owner of: %s; nothing applied', current_user, v_mismatch);
  end if;
  -- d. R3's premise: no hid_ role but the owners is a member of a source table's owner (MEMBER, so a NOINHERIT
  -- membership counts too).
  select string_agg(distinct role_row.rolname, ', ') into v_mismatch
    from pg_roles role_row,
         (select distinct relation.relowner from unnest(v_source_tables) source_table(relation)
            join pg_class relation on relation.oid = source_table.relation) table_owner
   where role_row.rolname like 'hid\_%' and role_row.oid <> table_owner.relowner and role_row.oid <> v_owner_oid
     and pg_has_role(role_row.oid, table_owner.relowner, 'MEMBER');
  if v_mismatch is not null then
    raise exception using errcode = '55000',
      message = '0203: these roles are members of a source table''s owner, which the marker policies name: '
        || v_mismatch || '; nothing applied';
  end if;
  select md5(coalesce(string_agg(to_jsonb(entry)::text, ',' order by entry.id), '')) into v_queue_rows
    from ehr.visit_queue entry;

  -- 2. R1. The waiting list records the first move to "With clinician".
  alter table ehr.visit_queue
    add column first_with_clinician_at timestamptz,
    add column wait_tracked boolean;
  alter table ehr.visit_queue add constraint visit_queue_report_stamp_ck
    check (first_with_clinician_at is null or (wait_tracked is true and first_with_clinician_at >= checked_in_at));
  comment on column ehr.visit_queue.first_with_clinician_at is
    '0203 (REP-1): when the row first reached with_clinician (stage_changed_at then, never before checked_in_at); set only by the trigger visit_queue_report_stamp, and never changed after. Null on rows from before 0203.';
  comment on column ehr.visit_queue.wait_tracked is
    '0203 (REP-1): true on every row made from 0203 on (the stamp is recorded for it); null on rows from before 0203. Set only by the trigger visit_queue_report_stamp.';

  create function ehr.visit_queue_report_stamp()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if tg_op = 'INSERT' then
      new.wait_tracked := true;
      new.first_with_clinician_at := case when new.stage = 'with_clinician'
                                          then greatest(new.stage_changed_at, new.checked_in_at) end;
      return new;
    end if;
    new.wait_tracked := old.wait_tracked;
    if old.wait_tracked is true and old.first_with_clinician_at is null and new.stage = 'with_clinician' then
      new.first_with_clinician_at := greatest(new.stage_changed_at, new.checked_in_at);
    else
      new.first_with_clinician_at := old.first_with_clinician_at;
    end if;
    return new;
  end
  $fn$;
  comment on function ehr.visit_queue_report_stamp() is
    '0203 (REP-1): the waiting list''s report stamp. On insert, wait_tracked true and, for a row that starts at with_clinician, first_with_clinician_at; on update both kept, except that a tracked row reaching with_clinician with no stamp yet gets one (stage_changed_at, never before checked_in_at). Whatever a writer sends for the two columns, the owner included. No role may execute it.';
  revoke all on function ehr.visit_queue_report_stamp() from public;
  create trigger visit_queue_report_stamp
    before insert or update on ehr.visit_queue
    for each row execute function ehr.visit_queue_report_stamp();

  -- R2. The day ranges.
  create index visit_queue_report_day_idx on ehr.visit_queue (facility_id, queue_day);
  create index encounters_report_completed_idx on ehr.encounters (facility_id, ended_at) where status = 'completed';
  create index lab_requests_report_day_idx on ehr.lab_requests (facility_id, created_at);
  create index specimens_report_collected_idx on lab.specimens (facility_id, collected_at)
    where collected_at is not null;
  create index result_releases_report_day_idx on lab.result_releases (facility_id, released_at);
  create index dispensings_report_day_idx on pharmacy.dispensings (facility_id, dispensed_at);
  create index dispensing_reversals_report_day_idx on pharmacy.dispensing_reversals (facility_id, reversed_at);

  -- R3. The marker: one row while a report counts, for this backend's transaction only.
  create table ehr.report_scans (
    backend_pid integer not null,
    transaction_started_at timestamptz not null,
    primary key (backend_pid, transaction_started_at)
  );
  alter table ehr.report_scans enable row level security;
  alter table ehr.report_scans force row level security;
  create policy report_scans_owner_read on ehr.report_scans for select using (true);
  create policy report_scans_owner_insert on ehr.report_scans for insert with check (true);
  create policy report_scans_owner_update on ehr.report_scans for update using (true) with check (true);
  create policy report_scans_owner_delete on ehr.report_scans for delete using (true);
  revoke all on ehr.report_scans from public;
  comment on table ehr.report_scans is
    '0203 (REP-1): one row while ehr.facility_report_operations_figures counts, for this backend''s transaction only; deleted before the function returns, rolled back with any raise. Row-level security enabled and forced; no role but its owner holds any privilege on it.';

  create function ehr.report_scan_open()
  returns boolean
  language sql
  stable
  security definer
  cost 1
  set search_path = pg_catalog, pg_temp
  as $fn$
    select exists (select 1 from ehr.report_scans scan
                    where scan.backend_pid = pg_catalog.pg_backend_pid()
                      and scan.transaction_started_at = pg_catalog.transaction_timestamp())
  $fn$;
  comment on function ehr.report_scan_open() is
    '0203 (REP-1): whether this backend''s own transaction holds a report marker (ehr.report_scans). Every role that reads the eight source tables evaluates their marker policies, so PUBLIC may execute it; it answers nothing else.';
  revoke all on function ehr.report_scan_open() from public;
  grant execute on function ehr.report_scan_open() to public;

  -- One read policy per source table, named after every other read policy where the name allows it (R3).
  create policy encounters_scan_reports on ehr.encounters for select
    using ((select case when pg_has_role((select relation.relowner from pg_class relation
                                           where relation.oid = 'ehr.encounters'::regclass), 'USAGE')
                        then ehr.report_scan_open() else false end));
  create policy lab_requests_scan_reports on ehr.lab_requests for select
    using ((select case when pg_has_role((select relation.relowner from pg_class relation
                                           where relation.oid = 'ehr.lab_requests'::regclass), 'USAGE')
                        then ehr.report_scan_open() else false end));
  create policy registration_cases_scan_reports on identity.registration_cases for select
    using ((select case when pg_has_role((select relation.relowner from pg_class relation
                                           where relation.oid = 'identity.registration_cases'::regclass), 'USAGE')
                        then ehr.report_scan_open() else false end));
  create policy specimens_scan_reports on lab.specimens for select
    using ((select case when pg_has_role((select relation.relowner from pg_class relation
                                           where relation.oid = 'lab.specimens'::regclass), 'USAGE')
                        then ehr.report_scan_open() else false end));
  create policy test_executions_scan_reports on lab.test_executions for select
    using ((select case when pg_has_role((select relation.relowner from pg_class relation
                                           where relation.oid = 'lab.test_executions'::regclass), 'USAGE')
                        then ehr.report_scan_open() else false end));
  create policy result_releases_scan_reports on lab.result_releases for select
    using ((select case when pg_has_role((select relation.relowner from pg_class relation
                                           where relation.oid = 'lab.result_releases'::regclass), 'USAGE')
                        then ehr.report_scan_open() else false end));
  create policy pharmacy_dispensings_scan_reports on pharmacy.dispensings for select
    using ((select case when pg_has_role((select relation.relowner from pg_class relation
                                           where relation.oid = 'pharmacy.dispensings'::regclass), 'USAGE')
                        then ehr.report_scan_open() else false end));
  create policy pharmacy_reversals_scan_reports on pharmacy.dispensing_reversals for select
    using ((select case when pg_has_role((select relation.relowner from pg_class relation
                                           where relation.oid = 'pharmacy.dispensing_reversals'::regclass), 'USAGE')
                        then ehr.report_scan_open() else false end));

  -- R4. The counting helper: the marker, one counting statement, the marker gone, then the report.
  create function ehr.facility_report_operations_figures(requested_facility uuid, requested_from date,
    requested_to date, requested_suppress boolean)
  returns jsonb
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  set jit = off
  as $fn$
  declare
    minimum_count constant integer := 5;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    suppress boolean := coalesce(requested_suppress, false);
    span integer;
    previous_from date;
    previous_to date;
    window_start timestamptz;
    window_end timestamptz;
    raw jsonb;
    definition record;
    slot record;
    figure jsonb;
    part jsonb;
    daily jsonb;
    section_figures jsonb := '[]'::jsonb;
    sections jsonb := '[]'::jsonb;
    section_key text;
    hidden integer := 0;
    value_count integer := 0;
    daily_hidden integer;
    daily_values integer;
    sample bigint;
    median numeric;
  begin
    if requested_facility is null or requested_from is null or requested_to is null
       or requested_from > requested_to or requested_to > today then
      raise exception using errcode = '22023', message = 'REPORT_RANGE_INVALID';
    end if;
    span := requested_to - requested_from + 1;
    if span > 92 then
      raise exception using errcode = '22023', message = 'REPORT_RANGE_TOO_LONG';
    end if;
    previous_from := requested_from - span;
    previous_to := requested_from - 1;
    window_start := previous_from::timestamp at time zone 'Africa/Lagos';
    window_end := (requested_to + 1)::timestamp at time zone 'Africa/Lagos';

    -- From here until the marker is deleted only this statement runs, and it calls nothing but pg_catalog's
    -- functions (and ehr.report_scan_open, from the policies).
    insert into ehr.report_scans (backend_pid, transaction_started_at)
    values (pg_backend_pid(), transaction_timestamp()) on conflict do nothing;

    with queue_days as (
      select entry.queue_day as day,
             count(*) as checked_in,
             count(*) filter (where entry.wait_tracked is true
                                and (entry.first_with_clinician_at is not null or entry.stage = 'finished')) as seen,
             count(*) filter (where entry.wait_tracked is true and entry.stage = 'left'
                                and entry.first_with_clinician_at is null) as left_unseen,
             count(*) filter (where entry.stage = 'cancelled') as cancelled,
             count(*) filter (where entry.wait_tracked is true) as tracked
        from ehr.visit_queue entry
       where entry.facility_id = requested_facility
         and entry.queue_day >= previous_from and entry.queue_day <= requested_to
       group by entry.queue_day
    ),
    window_releases as (
      select distinct on (release.result_id) release.result_id, release.execution_id, release.released_at
        from lab.result_releases release
       where release.facility_id = requested_facility
         and release.released_at >= window_start and release.released_at < window_end
       order by release.result_id, release.released_at, release.id
    ),
    -- Each result once, on its first release: one released before the window is not counted again.
    first_releases as (
      select window_release.result_id, window_release.execution_id, window_release.released_at,
             (window_release.released_at at time zone 'Africa/Lagos')::date as day
        from window_releases window_release
       where not exists (select 1 from lab.result_releases earlier
                          where earlier.result_id = window_release.result_id
                            and earlier.released_at < window_release.released_at)
    ),
    counted (figure, day, n) as (
      select counted_figure.key, queue_days.day, counted_figure.n
        from queue_days
        cross join lateral (values ('checkedIn', queue_days.checked_in), ('seen', queue_days.seen),
          ('leftWithoutBeingSeen', queue_days.left_unseen), ('cancelled', queue_days.cancelled),
          ('tracked', queue_days.tracked)) counted_figure(key, n)
       where counted_figure.n > 0
      union all
      select case when registration.status = 'approved_new_identity' then 'newHealthIds' else 'existingHealthIds' end,
             (registration.created_at at time zone 'Africa/Lagos')::date, count(*)
        from identity.registration_cases registration
       where registration.facility_id = requested_facility
         and registration.status in ('approved_new_identity', 'resolved_existing_identity', 'linked_existing')
         and registration.created_at >= window_start and registration.created_at < window_end
       group by 1, 2
      union all
      select 'opened', (visit.started_at at time zone 'Africa/Lagos')::date, count(*)
        from ehr.encounters visit
       where visit.facility_id = requested_facility and not visit.imported_paper_records
         and visit.status not in ('cancelled', 'entered_in_error')
         and visit.started_at >= window_start and visit.started_at < window_end
       group by 2
      union all
      select 'completed', (visit.ended_at at time zone 'Africa/Lagos')::date, count(*)
        from ehr.encounters visit
       where visit.facility_id = requested_facility and visit.status = 'completed' and not visit.imported_paper_records
         and visit.ended_at >= window_start and visit.ended_at < window_end
       group by 2
      union all
      select 'requested', (request.created_at at time zone 'Africa/Lagos')::date, count(*)
        from ehr.lab_requests request
       where request.facility_id = requested_facility and request.status in ('active', 'on_hold', 'completed')
         and request.created_at >= window_start and request.created_at < window_end
       group by 2
      union all
      select 'specimensCollected', (specimen.collected_at at time zone 'Africa/Lagos')::date, count(*)
        from lab.specimens specimen
       where specimen.facility_id = requested_facility and specimen.status in ('collected', 'received', 'rejected')
         and specimen.collected_at >= window_start and specimen.collected_at < window_end
       group by 2
      union all
      select 'resultsReleased', first_release.day, count(*)
        from first_releases first_release
       group by 2
      union all
      select 'dispensed', (dispensing.dispensed_at at time zone 'Africa/Lagos')::date, count(*)
        from pharmacy.dispensings dispensing
       where dispensing.facility_id = requested_facility
         and dispensing.dispensed_at >= window_start and dispensing.dispensed_at < window_end
         and not exists (select 1 from pharmacy.dispensing_reversals reversal
                          where reversal.dispensing_id = dispensing.id)
       group by 2
      union all
      select 'dispensingsReversed', (reversal.reversed_at at time zone 'Africa/Lagos')::date, count(*)
        from pharmacy.dispensing_reversals reversal
       where reversal.facility_id = requested_facility
         and reversal.reversed_at >= window_start and reversal.reversed_at < window_end
       group by 2
      union all
      select reason.key, (ending.recorded_at at time zone 'Africa/Lagos')::date, count(*)
        from ehr.order_route_unable_endings ending
        cross join lateral (values ('notCompleted'), ('notCompleted:' || ending.reason_code)) reason(key)
       where ending.receiving_facility_id = requested_facility and ending.kind = 'prescription'
         and ending.recorded_at >= window_start and ending.recorded_at < window_end
       group by 1, 2
    ),
    measured (figure, day, minutes) as (
      select 'medianWaitMinutes', entry.queue_day,
             (extract(epoch from (entry.first_with_clinician_at - entry.checked_in_at)) / 60)::double precision
        from ehr.visit_queue entry
       where entry.facility_id = requested_facility
         and entry.queue_day >= previous_from and entry.queue_day <= requested_to
         and entry.wait_tracked is true and entry.first_with_clinician_at is not null
      union all
      select 'medianTurnaroundMinutes', first_release.day,
             greatest(extract(epoch from (first_release.released_at - specimen.collected_at)) / 60, 0)::double precision
        from first_releases first_release
        join lab.test_executions execution on execution.id = first_release.execution_id
        join lab.specimens specimen on specimen.id = execution.specimen_id
       where specimen.collected_at is not null
    )
    select jsonb_build_object(
      'counts', coalesce((
        select jsonb_object_agg(totals.figure, jsonb_build_object('current', totals.current_n,
                 'previous', totals.previous_n, 'daily', coalesce(per_day.days, '{}'::jsonb)))
          from (select counted.figure,
                       coalesce(sum(counted.n) filter (where counted.day >= requested_from), 0)::bigint as current_n,
                       coalesce(sum(counted.n) filter (where counted.day < requested_from), 0)::bigint as previous_n
                  from counted group by counted.figure) totals
          left join (select counted.figure, jsonb_object_agg(to_char(counted.day, 'YYYY-MM-DD'), counted.n) as days
                       from counted where counted.day >= requested_from group by counted.figure) per_day
            on per_day.figure = totals.figure), '{}'::jsonb),
      'medians', coalesce((
        select jsonb_object_agg(periods.figure, jsonb_build_object(
                 'current', periods.current_m, 'currentN', periods.current_n,
                 'previous', periods.previous_m, 'previousN', periods.previous_n,
                 'daily', coalesce(per_day.days, '{}'::jsonb)))
          from (select measured.figure,
                       percentile_cont(0.5) within group (order by measured.minutes)
                         filter (where measured.day >= requested_from) as current_m,
                       count(*) filter (where measured.day >= requested_from) as current_n,
                       percentile_cont(0.5) within group (order by measured.minutes)
                         filter (where measured.day < requested_from) as previous_m,
                       count(*) filter (where measured.day < requested_from) as previous_n
                  from measured group by measured.figure) periods
          left join (select by_day.figure, jsonb_object_agg(to_char(by_day.day, 'YYYY-MM-DD'),
                              jsonb_build_object('m', by_day.m, 'n', by_day.n)) as days
                       from (select measured.figure, measured.day,
                                    percentile_cont(0.5) within group (order by measured.minutes) as m,
                                    count(*) as n
                               from measured where measured.day >= requested_from
                              group by measured.figure, measured.day) by_day
                      group by by_day.figure) per_day
            on per_day.figure = periods.figure), '{}'::jsonb))
      into raw;

    delete from ehr.report_scans scan
     where scan.backend_pid = pg_backend_pid() and scan.transaction_started_at = transaction_timestamp();

    -- The report: the five sections, each with every figure, in the contract's order.
    for definition in
      select listed.section_key, listed.figure_key, listed.kind, listed.tracked
        from (values
          (1, 'waitingList', 'checkedIn', 'count', false),
          (2, 'waitingList', 'seen', 'count', true),
          (3, 'waitingList', 'leftWithoutBeingSeen', 'count', true),
          (4, 'waitingList', 'cancelled', 'count', false),
          (5, 'waitingList', 'medianWaitMinutes', 'median_minutes', true),
          (6, 'registrations', 'newHealthIds', 'count', false),
          (7, 'registrations', 'existingHealthIds', 'count', false),
          (8, 'visits', 'opened', 'count', false),
          (9, 'visits', 'completed', 'count', false),
          (10, 'lab', 'requested', 'count', false),
          (11, 'lab', 'specimensCollected', 'count', false),
          (12, 'lab', 'resultsReleased', 'count', false),
          (13, 'lab', 'medianTurnaroundMinutes', 'median_minutes', false),
          (14, 'pharmacy', 'dispensed', 'count', false),
          (15, 'pharmacy', 'dispensingsReversed', 'count', false),
          (16, 'pharmacy', 'notCompleted', 'count', false)
        ) listed(position, section_key, figure_key, kind, tracked)
       order by listed.position
    loop
      if section_key is distinct from definition.section_key then
        if section_key is not null then
          sections := sections || jsonb_build_array(jsonb_build_object('key', section_key, 'figures', section_figures));
        end if;
        section_key := definition.section_key;
        section_figures := '[]'::jsonb;
      end if;
      figure := jsonb_build_object('key', definition.figure_key, 'kind', definition.kind);

      if definition.kind = 'count' then
        -- The totals; with suppress, a count from 1 to 4 is null with <field>Suppressed true.
        for slot in
          select slot_row.name, coalesce((raw #>> array['counts', definition.figure_key, slot_row.name])::bigint, 0)
                   as value
            from (values ('current'), ('previous')) slot_row(name)
        loop
          value_count := value_count + 1;
          if suppress and slot.value between 1 and minimum_count - 1 then
            figure := figure || jsonb_build_object(slot.name, null, slot.name || 'Suppressed', true);
            hidden := hidden + 1;
          else
            figure := figure || jsonb_build_object(slot.name, slot.value);
          end if;
        end loop;
        select coalesce(jsonb_agg(case when per_day.hide
                                       then jsonb_build_object('day', per_day.day_text, 'value', null, 'suppressed', true)
                                       else jsonb_build_object('day', per_day.day_text, 'value', per_day.n) end
                                  order by per_day.day_text), '[]'::jsonb),
               count(*) filter (where per_day.hide), count(*)
          into daily, daily_hidden, daily_values
          from (select listed_day.day_text, listed_day.n,
                       suppress and listed_day.n between 1 and minimum_count - 1 as hide
                  from (select to_char(day_value, 'YYYY-MM-DD') as day_text,
                               coalesce((raw #>> array['counts', definition.figure_key, 'daily',
                                                       to_char(day_value, 'YYYY-MM-DD')])::bigint, 0) as n
                          from generate_series(requested_from::timestamp, requested_to::timestamp,
                                               interval '1 day') day_value) listed_day) per_day;
      else
        -- A median: whole minutes, half up, with its sample size; null with sample size 0 when there is no sample;
        -- with suppress, a sample from 1 to 4 hides both the median and its size.
        for slot in
          select slot_row.name, slot_row.size_name,
                 coalesce((raw #>> array['medians', definition.figure_key, slot_row.count_key])::bigint, 0) as size,
                 round((raw #>> array['medians', definition.figure_key, slot_row.name])::numeric) as value
            from (values ('current', 'sampleSize', 'currentN'), ('previous', 'previousSampleSize', 'previousN'))
                   slot_row(name, size_name, count_key)
        loop
          value_count := value_count + 2;
          if suppress and slot.size between 1 and minimum_count - 1 then
            figure := figure || jsonb_build_object(slot.name, null, slot.name || 'Suppressed', true,
                                                   slot.size_name, null, slot.size_name || 'Suppressed', true);
            hidden := hidden + 2;
          else
            figure := figure || jsonb_build_object(slot.name, case when slot.size > 0 then slot.value end,
                                                   slot.size_name, slot.size);
          end if;
        end loop;
        select coalesce(jsonb_agg(case when per_day.hide
                                       then jsonb_build_object('day', per_day.day_text, 'value', null,
                                                               'sampleSize', null, 'suppressed', true)
                                       else jsonb_build_object('day', per_day.day_text,
                                                               'value', case when per_day.n > 0 then per_day.m end,
                                                               'sampleSize', per_day.n) end
                                  order by per_day.day_text), '[]'::jsonb),
               2 * count(*) filter (where per_day.hide), 2 * count(*)
          into daily, daily_hidden, daily_values
          from (select listed_day.day_text, listed_day.n, listed_day.m,
                       suppress and listed_day.n between 1 and minimum_count - 1 as hide
                  from (select to_char(day_value, 'YYYY-MM-DD') as day_text,
                               coalesce((raw #>> array['medians', definition.figure_key, 'daily',
                                                       to_char(day_value, 'YYYY-MM-DD'), 'n'])::bigint, 0) as n,
                               round((raw #>> array['medians', definition.figure_key, 'daily',
                                                    to_char(day_value, 'YYYY-MM-DD'), 'm'])::numeric) as m
                          from generate_series(requested_from::timestamp, requested_to::timestamp,
                                               interval '1 day') day_value) listed_day) per_day;
      end if;

      -- How many check-ins in each period record the stamp (the three tracked figures).
      if definition.tracked then
        part := '{}'::jsonb;
        for slot in
          select slot_row.name,
                 coalesce((raw #>> array['counts', 'tracked', slot_row.count_key])::bigint, 0) as value
            from (values ('tracked', 'current'), ('previousTracked', 'previous')) slot_row(name, count_key)
        loop
          value_count := value_count + 1;
          if suppress and slot.value between 1 and minimum_count - 1 then
            part := part || jsonb_build_object(slot.name, null, slot.name || 'Suppressed', true);
            hidden := hidden + 1;
          else
            part := part || jsonb_build_object(slot.name, slot.value);
          end if;
        end loop;
        figure := figure || jsonb_build_object('coverage', part);
      end if;

      -- Could not complete: all eight reasons of 0091 for a prescription, in this order.
      if definition.figure_key = 'notCompleted' then
        part := '[]'::jsonb;
        for slot in
          select reason_row.reason,
                 coalesce((raw #>> array['counts', 'notCompleted:' || reason_row.reason, 'current'])::bigint, 0)
                   as current_value,
                 coalesce((raw #>> array['counts', 'notCompleted:' || reason_row.reason, 'previous'])::bigint, 0)
                   as previous_value
            from (values (1, 'out_of_stock'), (2, 'medicine_unavailable'), (3, 'needs_prescriber_review'),
                         (4, 'controlled_requirements'), (5, 'cannot_meet_priority'), (6, 'patient_declined'),
                         (7, 'patient_did_not_return'), (8, 'other')) reason_row(position, reason)
           order by reason_row.position
        loop
          value_count := value_count + 2;
          part := part || jsonb_build_array(jsonb_build_object('reason', slot.reason)
            || case when suppress and slot.current_value between 1 and minimum_count - 1
                    then jsonb_build_object('current', null, 'currentSuppressed', true)
                    else jsonb_build_object('current', slot.current_value) end
            || case when suppress and slot.previous_value between 1 and minimum_count - 1
                    then jsonb_build_object('previous', null, 'previousSuppressed', true)
                    else jsonb_build_object('previous', slot.previous_value) end);
          hidden := hidden + (suppress and slot.current_value between 1 and minimum_count - 1)::integer
                           + (suppress and slot.previous_value between 1 and minimum_count - 1)::integer;
        end loop;
        figure := figure || jsonb_build_object('byReason', part);
      end if;

      value_count := value_count + daily_values;
      hidden := hidden + daily_hidden;
      section_figures := section_figures || jsonb_build_array(figure || jsonb_build_object('daily', daily));
    end loop;
    sections := sections || jsonb_build_array(jsonb_build_object('key', section_key, 'figures', section_figures));

    return jsonb_build_object(
      'report', jsonb_build_object(
        'report', 'operations',
        'facilityId', requested_facility,
        'from', to_char(requested_from, 'YYYY-MM-DD'),
        'to', to_char(requested_to, 'YYYY-MM-DD'),
        'days', span,
        'previousFrom', to_char(previous_from, 'YYYY-MM-DD'),
        'previousTo', to_char(previous_to, 'YYYY-MM-DD'),
        'includesToday', requested_to = today,
        'timeZone', 'Africa/Lagos',
        'generatedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'definitions', jsonb_build_object('version', 'rep1-draft-1', 'signedOff', false),
        'sections', sections),
      'figures', 16,
      'values', value_count,
      'suppressedValues', hidden,
      'minimumCount', minimum_count);
  end
  $fn$;
  comment on function ehr.facility_report_operations_figures(uuid, date, date, boolean) is
    '0203 (REP-1): the operations report of one facility over a range of Lagos days (at most 92) and the previous period of the same length: the marker (ehr.report_scans) while one statement counts, then the five sections with every figure, its previous period and a daily line; with suppress, counts and median samples from 1 to 4 hidden. Answers {report, figures, values, suppressedValues, minimumCount}. Runs only inside the two report functions, as their owner; no role may execute it.';
  revoke all on function ehr.facility_report_operations_figures(uuid, date, date, boolean) from public;

  -- Route 1: the report, as the screen shows it.
  create function ehr.facility_report_operations(requested_from date, requested_to date, requested_switched_on boolean)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    actor_subject text := platform.current_actor_subject();
    actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
    actor_membership uuid := platform.current_membership_id();
    actor_facility uuid := platform.current_facility_id();
    actor_correlation text := platform.current_correlation_id();
    actor_purpose text := platform.current_purpose_of_use();
    actor_organization uuid;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    answer jsonb;
  begin
    if actor_subject is null or actor_account is null or actor_membership is null or actor_facility is null
       or actor_correlation is null then
      raise exception using errcode = '42501', message = 'REPORTS_NOT_PERMITTED';
    end if;
    select membership.organization_id into actor_organization
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null;
    if not found
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'reports.read') then
      raise exception using errcode = '42501', message = 'REPORTS_NOT_PERMITTED';
    end if;
    if actor_purpose is distinct from 'healthcare-operations' then
      raise exception using errcode = '22023', message = 'REPORTS_OPERATIONS_PURPOSE_ONLY';
    end if;
    if not coalesce(requested_switched_on, false) and not identity.sealed_demo_facility(actor_facility)
       and not identity.sealed_qa_facility(actor_facility) then
      raise exception using errcode = '55000', message = 'REPORTS_SWITCHED_OFF';
    end if;
    if requested_from is null or requested_to is null or requested_from > requested_to or requested_to > today
       or requested_from < (today - interval '2 years')::date then
      raise exception using errcode = '22023', message = 'REPORT_RANGE_INVALID';
    end if;
    if requested_to - requested_from + 1 > 92 then
      raise exception using errcode = '22023', message = 'REPORT_RANGE_TOO_LONG';
    end if;

    answer := ehr.facility_report_operations_figures(actor_facility, requested_from, requested_to, false);

    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation, 'staff', actor_subject, actor_account, actor_membership, actor_organization, actor_facility,
      null, 'ehr.reports.operations.read', 'success', 'facility-report', 'operations', actor_purpose, 'application',
      'ehr-api',
      jsonb_build_object('from', answer #>> '{report,from}', 'to', answer #>> '{report,to}',
        'days', answer #> '{report,days}', 'includesToday', answer #> '{report,includesToday}',
        'figures', answer -> 'figures'));
    return answer -> 'report';
  end
  $fn$;
  comment on function ehr.facility_report_operations(date, date, boolean) is
    '0203 (REP-1): route 1, the session facility''s operations report over a range of Lagos days, values as they are. Needs an active membership here holding reports.read, the purpose healthcare-operations, the switch (ehr-api''s REPORTS_ENABLED) or a sealed demo or QA facility, and a range ending today or earlier, within 2 years, of at most 92 days. One ehr.reports.operations.read audit row (no patient, no value). EXECUTE for hid_ehr_runtime only.';
  revoke all on function ehr.facility_report_operations(date, date, boolean) from public;

  -- Route 2: a download, recorded, with small counts hidden.
  create function ehr.facility_report_operations_export(requested_from date, requested_to date, requested_format text,
    requested_switched_on boolean)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    actor_subject text := platform.current_actor_subject();
    actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
    actor_membership uuid := platform.current_membership_id();
    actor_facility uuid := platform.current_facility_id();
    actor_correlation text := platform.current_correlation_id();
    actor_purpose text := platform.current_purpose_of_use();
    actor_organization uuid;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    answer jsonb;
    recorded timestamptz;
  begin
    if actor_subject is null or actor_account is null or actor_membership is null or actor_facility is null
       or actor_correlation is null then
      raise exception using errcode = '42501', message = 'REPORTS_EXPORT_NOT_PERMITTED';
    end if;
    select membership.organization_id into actor_organization
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null;
    if not found
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'reports.read') then
      raise exception using errcode = '42501', message = 'REPORTS_NOT_PERMITTED';
    end if;
    if not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'reports.export') then
      raise exception using errcode = '42501', message = 'REPORTS_EXPORT_NOT_PERMITTED';
    end if;
    if actor_purpose is distinct from 'healthcare-operations' then
      raise exception using errcode = '22023', message = 'REPORTS_OPERATIONS_PURPOSE_ONLY';
    end if;
    if not coalesce(requested_switched_on, false) and not identity.sealed_demo_facility(actor_facility)
       and not identity.sealed_qa_facility(actor_facility) then
      raise exception using errcode = '55000', message = 'REPORTS_EXPORT_SWITCHED_OFF';
    end if;
    if requested_from is null or requested_to is null or requested_from > requested_to or requested_to > today
       or requested_from < (today - interval '2 years')::date then
      raise exception using errcode = '22023', message = 'REPORT_RANGE_INVALID';
    end if;
    if requested_to - requested_from + 1 > 92 then
      raise exception using errcode = '22023', message = 'REPORT_RANGE_TOO_LONG';
    end if;
    if requested_format is null or requested_format not in ('csv', 'pdf') then
      raise exception using errcode = '22023', message = 'REPORT_FORMAT_INVALID';
    end if;

    answer := ehr.facility_report_operations_figures(actor_facility, requested_from, requested_to, true);

    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation, 'staff', actor_subject, actor_account, actor_membership, actor_organization, actor_facility,
      null, 'ehr.reports.operations.exported', 'success', 'facility-report', 'operations', actor_purpose,
      'application', 'ehr-api',
      jsonb_build_object('from', answer #>> '{report,from}', 'to', answer #>> '{report,to}',
        'days', answer #> '{report,days}', 'format', requested_format, 'figures', answer -> 'figures',
        'values', answer -> 'values', 'suppressedValues', answer -> 'suppressedValues',
        'minimumCount', answer -> 'minimumCount'))
    returning recorded_at into recorded;
    return (answer -> 'report') || jsonb_build_object('export', jsonb_build_object(
      'format', requested_format, 'minimumCount', answer -> 'minimumCount',
      'suppressedValues', answer -> 'suppressedValues',
      'recordedAt', to_char(recorded at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end
  $fn$;
  comment on function ehr.facility_report_operations_export(date, date, text, boolean) is
    '0203 (REP-1): route 2, a download of the session facility''s operations report (csv or pdf, built by the browser from this answer only): the report with every count from 1 to 4 and every median of a sample under 5 hidden, plus the export record. Needs reports.read and reports.export, the purpose healthcare-operations, the switch (ehr-api''s REPORTS_ENABLED and REPORTS_EXPORT_ENABLED) or a sealed demo or QA facility, and route 1''s range rules. One ehr.reports.operations.exported audit row (range, format and counts only). EXECUTE for hid_ehr_runtime only.';
  revoke all on function ehr.facility_report_operations_export(date, date, text, boolean) from public;

  -- Owners and EXECUTE (as 0135: the owner of ehr.visit_queue, the owner of identity.has_active_consent_grant).
  if v_owner <> current_user then
    execute format('alter table ehr.report_scans owner to %I', v_owner);
    execute format('alter function ehr.visit_queue_report_stamp() owner to %I', v_owner);
    execute format('alter function ehr.report_scan_open() owner to %I', v_owner);
    execute format('alter function ehr.facility_report_operations_figures(uuid, date, date, boolean) owner to %I',
                   v_owner);
    execute format('alter function ehr.facility_report_operations(date, date, boolean) owner to %I', v_owner);
    execute format('alter function ehr.facility_report_operations_export(date, date, text, boolean) owner to %I',
                   v_owner);
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.facility_report_operations(date, date, boolean),
      ehr.facility_report_operations_export(date, date, text, boolean) to hid_ehr_runtime;
  end if;

  -- 3. Post-checks.
  execute v_state_sql into v_state;
  if v_state is distinct from v_expected_all then
    select string_agg(item, '; ') into v_mismatch
      from (select '+' || made.item as item from unnest(v_state) made(item)
             where made.item <> all (v_expected_all)
            union all
            select '-' || wanted.item from unnest(v_expected_all) wanted(item)
             where wanted.item <> all (v_state)) difference;
    raise exception using errcode = '55000', message = '0203: post-check failed (the objects as made): ' || v_mismatch;
  end if;
  -- Every new object the owner's.
  if (select relation.relowner from pg_class relation where relation.oid = 'ehr.report_scans'::regclass)
       <> v_owner_oid
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr'
            and (proc.proname like 'facility\_report\_%' or proc.proname like 'report\_scan%'
                 or proc.proname like '%report\_stamp%')
            and proc.proowner = v_owner_oid) <> 5 then
    raise exception using errcode = '55000', message = '0203: post-check failed (an object is not the owner''s)';
  end if;
  -- Grants: the marker table to no role; the marker check to PUBLIC; the helper and the trigger function to no role;
  -- the two report functions to hid_ehr_runtime only.
  if exists (select 1 from pg_class class_row,
                    lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
              where class_row.oid = 'ehr.report_scans'::regclass and acl.grantee <> class_row.relowner)
     or exists (select 1 from pg_proc proc,
                       lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid in ('ehr.visit_queue_report_stamp()'::regprocedure,
                                    'ehr.facility_report_operations_figures(uuid,date,date,boolean)'::regprocedure)
                   and acl.grantee <> proc.proowner)
     or exists (select 1 from pg_proc proc,
                       lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid = 'ehr.report_scan_open()'::regprocedure
                   and acl.grantee <> proc.proowner and acl.grantee <> 0)
     or not exists (select 1 from pg_proc proc,
                           lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                     where proc.oid = 'ehr.report_scan_open()'::regprocedure and acl.grantee = 0
                       and acl.privilege_type = 'EXECUTE')
     or exists (select 1 from pg_proc proc,
                       lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid in ('ehr.facility_report_operations(date,date,boolean)'::regprocedure,
                                    'ehr.facility_report_operations_export(date,date,text,boolean)'::regprocedure)
                   and acl.grantee <> proc.proowner
                   and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime')) then
    raise exception using errcode = '55000', message = '0203: post-check failed (a grant)';
  end if;
  -- R3's order, in 0133's form: the permissive read policies asked before each marker policy (those whose names sort
  -- after it, C collation, as PostgreSQL orders them) are exactly the ones the header names.
  select string_agg(format('%s %s', other_policy.polrelid::regclass, other_policy.polname), '; '
           order by other_policy.polrelid::regclass::text collate "C", other_policy.polname::text collate "C")
    into v_mismatch
    from pg_policy marker_policy
    join pg_policy other_policy on other_policy.polrelid = marker_policy.polrelid
   where marker_policy.polname like '%\_scan\_reports' and marker_policy.polrelid = any (v_policy_tables)
     and other_policy.oid <> marker_policy.oid and other_policy.polpermissive
     and other_policy.polcmd in ('r', '*')
     and other_policy.polname::text collate "C" > marker_policy.polname::text collate "C";
  if v_mismatch is distinct from 'identity.registration_cases registration_cases_staff_access; '
       || 'lab.result_releases staff_own_work_read; lab.specimens staff_own_work_read; '
       || 'pharmacy.dispensing_reversals staff_own_work_read; pharmacy.dispensings staff_own_work_read' then
    raise exception using errcode = '55000',
      message = '0203: post-check failed (the read policies asked before the marker policies are not the reviewed '
        || 'ones: ' || coalesce(v_mismatch, 'none') || ')';
  end if;
  if exists (select 1 from pg_roles role_row,
                    (select distinct relation.relowner from unnest(v_source_tables) source_table(relation)
                       join pg_class relation on relation.oid = source_table.relation) table_owner
              where role_row.rolname like 'hid\_%' and role_row.oid <> table_owner.relowner
                and role_row.oid <> v_owner_oid
                and pg_has_role(role_row.oid, table_owner.relowner, 'MEMBER')) then
    raise exception using errcode = '55000', message = '0203: post-check failed (a hid_ role is a member of a source table''s owner)';
  end if;
  if (select md5(coalesce(string_agg((to_jsonb(entry) - 'first_with_clinician_at' - 'wait_tracked')::text, ','
                                     order by entry.id), '')) from ehr.visit_queue entry)
       is distinct from v_queue_rows
     or exists (select 1 from ehr.visit_queue entry
                 where entry.first_with_clinician_at is not null or entry.wait_tracked is not null)
     or exists (select 1 from ehr.report_scans) then
    raise exception using errcode = '55000',
      message = '0203: post-check failed (a waiting-list row changed, or a marker row is left)';
  end if;

  raise notice '0203: the operations figures are installed (the waiting list''s report stamp, seven day-range indexes, the report marker and its eight read policies, the counting helper and the two report functions, owned by %). Nobody can read a report until 0204 gives the codes, and ehr-api''s REPORTS_ENABLED is off.', v_owner;
end
$rep0203$;
