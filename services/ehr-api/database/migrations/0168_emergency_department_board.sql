-- 0168 ED-1 Emergency department board: records, arrival, triage and
-- disposition (Release D, the department sprint the owner approved on 25
-- November 2026). Written on staging-novu-ci-20261005 at 95fa1e52 (0001-0151
-- applied: Release A, B and C, 0150 and 0151). The number is provisional:
-- numbers are given at merge, after the files booked before it (0152-0153
-- ORD-9, 0154 ORD-12 refills, APPT-1's 0160-0161 and any department file cut
-- earlier). This file reads nothing 0152-0154 create or change, so it applies
-- on 0001-0151 and on 0001-0154 alike; it applies with or without APPT-1's
-- 0160 (the waiting-list basis CHECK, below). The declaration in
-- config/production-schema-compatibility.json stays unsigned until the owner
-- signs this file. 0169 (who gets the board) is its own file.
--
-- Decisions taken at the recommended option, not yet answered by the owner
-- (docs/EHR_PLANNED_CONTRACT.md, ED-1): Q-ED-1 A (an ED patient is a row of
-- the live waiting list plus an ED record: stage, triage level and assignee
-- stay on the waiting-list row), Q-ED-3 A (a member who found the patient by
-- emergency search and holds an active break-glass grant for them here may put
-- them on the board, basis emergency; the board gives no chart access),
-- Q-ED-4 A (a short presenting complaint, 1-120 characters, shown only to
-- members who hold ehr.ed.triage), Q-ED-5 A (disposition in two steps: home,
-- admission requested and referred out wait in Disposition until "Left the
-- department"; left before being seen, left against advice, died and sent to
-- outpatients close at once), Q-ED-6 A (the admission request is stored on the
-- ED record until wards ship), Q-ED-7 A (no new write basis: break-glass stays
-- read only). Q-ED-2 A (who uses the board) is 0169.
--
-- Not a choice: the triage scale. The board reuses 0135's live
-- ehr.visit_queue.triage_level (1 most urgent to 5) and adds no second scale.
-- 0135 shipped that scale as an owner default without clinical sign-off: the
-- clinical lead must sign off the five-level scale before real patients use
-- the board (or, retroactively, the waiting list).
--
-- What it changes (nothing else):
-- E1 ehr.ed_attendances        one row per arrival on the board: facility,
--                              organisation, patient, the waiting-list row
--                              (one open or decided record per row and per
--                              patient and facility), how the patient came to
--                              the board (arrival_basis search, own_facility or
--                              emergency), how they arrived (arrival_mode),
--                              arrived_at and its Lagos day, whether the
--                              patient was moved from the outpatient waiting
--                              list and, if so, that row's stage, triage
--                              level, assignee and stage time before the move
--                              (a cancel puts them back), the presenting
--                              complaint (1-120, no
--                              control characters), who triaged and when (the
--                              level itself stays on ehr.visit_queue), the
--                              linked visit, the status (open, decided, closed),
--                              the disposition (outcome, admitting department,
--                              admitting doctor, referral facility name, who
--                              decided and when), when the patient left, how it
--                              closed (board, disposition, cancel or
--                              waiting_list), who arrived and changed it, and a
--                              row version. Cancelled records are kept.
-- E2 ehr.ed_attendance_events  one row per arrival, triage, move, visit link,
--                              disposition, leave, cancel or mirrored close,
--                              with the from and to stage, the triage level,
--                              whether the complaint changed (never its text),
--                              the outcome, the reason (8-500, for a changed
--                              disposition and a cancel), and the
--                              Idempotency-Key with the request's SHA-256
--                              (unique per membership and key). A trigger
--                              refuses any update or delete.
--    Both tables have row-level security enabled and no policy or privilege for
--    any runtime role: only the functions below read or write them, as their
--    owner (0135's rule).
-- E3 ehr.visit_queue           the check_in_basis CHECK gains 'emergency'. The
--                              CHECK found must be exactly 0135's ('search',
--                              'own_facility') or APPT-1's ('search',
--                              'own_facility', 'appointment'); every value
--                              found is kept. Two triggers. The guard,
--                              visit_queue_ed_guard (BEFORE UPDATE OF stage,
--                              triage_level, assigned_membership_id,
--                              closed_at): while a row has an open or decided
--                              ED record, its stage, triage level, assignee and
--                              close belong to the board, so 0135's
--                              ehr.visit_queue_update (the waiting list's
--                              next-step button and Change form) is refused
--                              for it (55000 VISIT_QUEUE_ON_ED_BOARD), whoever
--                              calls it; the ED functions name the row in a
--                              transaction-local marker first. So the ED
--                              record's row version covers every field the
--                              board writes, and the board's roles, reasons
--                              and cancel rule cannot be gone around on the
--                              waiting list. The one exception is a row of a
--                              patient whose record is no longer active
--                              (0145's cancel of an unknown record makes the
--                              patient inactive, then cancels the row). The
--                              mirror, visit_queue_ed_close_mirror (AFTER
--                              UPDATE OF closed_at, only when a row closes),
--                              closes the open or decided ED record of a row
--                              closed that way with a closed_on_waiting_list
--                              event and one ehr.ed.closed-on-waiting-list
--                              audit row, unless the change came from an ED
--                              function (the same marker). Nothing else in
--                              0135 changes: its three functions and its card
--                              are not replaced. The kill switch: while
--                              ED_BOARD_ENABLED is off ehr-api sends the
--                              waiting list's changes through
--                              ehr.visit_queue_ed_board_off_update (E4), which
--                              runs 0135's update under the marker and, when
--                              the row was updated, closes its ED record as
--                              the mirror does (boardOff true in the audit
--                              row), so a board patient's row is never stuck
--                              while the board is off. While the flag is on
--                              ehr-api never calls it.
-- E4 SECURITY DEFINER functions (search_path pg_catalog, pg_temp), owned like
--    0135's (the owner of identity.has_active_consent_grant), EXECUTE for
--    hid_ehr_runtime only: ehr.ed_arrive, ehr.ed_board, ehr.ed_read,
--    ehr.ed_triage, ehr.ed_move, ehr.ed_link_visit, ehr.ed_record_disposition,
--    ehr.ed_leave, ehr.ed_cancel, the waiting-list helper
--    ehr.visit_queue_ed_attendances (beside 0145's
--    ehr.visit_queue_record_kinds) and the waiting list's update while the
--    board is off, ehr.visit_queue_ed_board_off_update (0135's
--    ehr.visit_queue_update, md5-pinned, under the marker). Helpers no role may execute:
--    ehr.ed_cards (0135's card fields, 0145's record kind and label, the ED
--    fields; the complaint only for a caller holding ehr.ed.triage),
--    ehr.ed_caller, ehr.ed_audit, ehr.ed_idempotency, the history's
--    immutability trigger, the waiting-list guard and the mirror trigger.
--    Each function checks the caller: an active membership not held by the
--    cutover at the session facility, ehr.ed.read and the function's own code
--    (ehr.ed.arrive, ehr.ed.triage or ehr.ed.disposition), 0135's pair
--    ehr.encounter.read and ehr.encounter.write, and the purpose (direct care;
--    emergency only for ehr.ed_arrive with an emergency search's matchRef). A
--    sealed demo or QA facility puts only its own sealed patients on its board,
--    as 0135. Without 0169 no role holds an ED code, so every function
--    refuses: the database half of "built but switched off".
-- E5 Audit, in the request's transaction (as 0135: a refusal the function
--    raises is recorded by ehr-api's request audit; an answer that refuses is
--    recorded here): ehr.ed.arrive (basis, outcome; plus 0135's
--    ehr.visit-queue.check-in, by emergency_department, when a waiting-list
--    row is made), ehr.ed.board (+ ehr.ed.board.shown per patient),
--    ehr.ed.record-read, ehr.ed.triage, ehr.ed.move, ehr.ed.link-visit,
--    ehr.ed.disposition, ehr.ed.leave, ehr.ed.cancel, and
--    ehr.ed.closed-on-waiting-list (the mirror, and the waiting list's update
--    while the board is off, with boardOff true). Rows hold ids, the outcome or
--    refusal, the basis, the triage level and the disposition outcome; never a
--    name, date of birth, Health ID, presenting complaint, referral facility
--    name or reason text. This file itself writes no audit row: it changes no
--    existing row.
--
-- How a patient gets onto the board (ehr.ed_arrive), exactly one of:
--   1. a matchRef from this member's own direct-care staff search in the last
--      10 minutes here (0132), basis search;
--   2. a patient id of this facility's own patient (0131's
--      identity.own_facility_basis, which includes every unknown record made
--      here by 0145), basis own_facility;
--   3. a matchRef from this member's own emergency search (0132, purpose
--      emergency, sent with X-Purpose-Of-Use: emergency) while this member
--      holds an active, unexpired break-glass grant for that patient here
--      (identity.consent_grants, scope break_glass), basis emergency. The
--      record stays on the board after the grant ends; the chart still needs a
--      grant. With Q-ED-3 B the one change is that this route is refused.
-- Anything else answers needs_search, the same for every reason. Under 0135's
-- advisory lock (visit-queue:<facility>:<patient>) and its one-open-row index:
-- a new waiting-list row and ED record (arrived), an ED record on the open
-- outpatient row (moved_from_waiting_list), or the record already on the board
-- (already_on_board).
--
-- Every write locks the ED record, then the waiting-list row, FOR UPDATE, in
-- that order, checks the ED record's row version and raises both rows'
-- versions. While the record is open or decided only the ED functions change
-- the row's stage, triage level and assignee (the guard), so that one version
-- covers them. 0145's cancel of an unknown record locks the waiting-list row
-- first and its close runs the mirror, which then locks the ED record: that
-- close at the same moment as a board write for the same patient can
-- deadlock; PostgreSQL ends one of the two after deadlock_timeout (40P01, the
-- whole request rolled back), and ehr-api answers it as a version conflict
-- ("reload and try again"). The waiting list's update while the board is off
-- takes the mirror's order too (the row, then the record); ehr-api serves no
-- board write then.
--
-- Locks (measured with pg_locks before commit and compared by the suite),
-- taken first, NOWAIT: SHARE ROW EXCLUSIVE on identity.patients,
-- identity.facilities, identity.staff_facility_memberships and ehr.encounters
-- (the foreign keys of the new, empty tables); ACCESS EXCLUSIVE on
-- ehr.visit_queue (the CHECK swap, the new trigger and the new tables' foreign
-- key; the table is small, so the hold is milliseconds); ROW EXCLUSIVE on
-- audit.events (the audit helper's body names it; this file writes no audit
-- row); ACCESS SHARE on identity.unknown_patients, identity.consent_grants,
-- identity.consent_directives, identity.consent_directive_versions,
-- auth.permissions and auth.role_permissions (read by the preconditions or by
-- the card's body check). A busy table fails the attempt at once, and its subtransaction releases
-- what it took. The attempt is made 50 times, 100 ms apart (about 5 seconds),
-- so the file never waits for one of its locks while holding the others; then
-- 55P03 (nothing applied). When this transaction already holds an earlier
-- migration's locks that stop other sessions' reads or writes (the runner's
-- dry run applies every pending file in one transaction), one attempt and no
-- sleep: 55P03 at once, nothing applied. Both refusals begin "0168: " and end
-- "run the release again at a quieter time", so the runner's dry run rolls back
-- and tries again (#306). Other waits are not NOWAIT, and the runner's
-- lock_timeout ends each after 5 seconds (nothing applied): an index or
-- catalog that maintenance holds, or DDL in flight on a function this file
-- reads.
--
-- Old images on this schema: nothing calls the new functions. Today's ehr-api
-- maps any waiting-list basis other than own_facility to "search"
-- (visit-queue.service.ts), so an emergency arrival shows as "search" on the
-- waiting list until the new image ships; no access depends on it. The guard
-- and the mirror run inside 0135's and 0145's own functions for old and new
-- images alike; the guard refuses only rows with an open or decided ED record
-- and the mirror only writes ED rows, and none exist until the new image puts
-- a patient on the board.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- triggers, the functions and the two tables, and put back the CHECK found
-- (without 'emergency') once no waiting-list row has basis emergency.
--
-- The whole file is one statement (do $ed0168$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): markers of 0145, 0149 and 0150;
--    "0168: already applied" when every object of this file is there with the
--    CHECK it leaves, "0168: the schema is not in the reviewed state" for any
--    half state; the bodies this file calls md5-pinned; the waiting-list basis
--    CHECK exactly 0135's or APPT-1's; the columns this file reads in 0135's,
--    0145's and 0003's tables; the functions' owner may read ehr.encounters
--    under its forced row-level security (the visit link).
-- 2. E1-E4.
-- 3. Post-checks: the CHECK is the found one plus 'emergency'; the tables have
--    row-level security and no privilege; the functions are SECURITY DEFINER
--    with the fixed search_path and EXECUTE only for hid_ehr_runtime; the
--    helpers have no EXECUTE for any role; the three triggers are there; no
--    row of any existing table changed (this file writes none).

do $ed0168$
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
  v_present integer;
  v_check_found text;
  v_check_after text;
  v_owner name;
  v_queue_rows text;
  -- The two reviewed definitions of 0135's basis CHECK, and what this file leaves for each.
  v_check_0135 constant text := 'CHECK ((check_in_basis = ANY (ARRAY[''search''::text, ''own_facility''::text])))';
  v_check_appt constant text :=
    'CHECK ((check_in_basis = ANY (ARRAY[''search''::text, ''own_facility''::text, ''appointment''::text])))';
  v_check_0135_ed constant text :=
    'CHECK ((check_in_basis = ANY (ARRAY[''search''::text, ''own_facility''::text, ''emergency''::text])))';
  v_check_appt_ed constant text := 'CHECK ((check_in_basis = ANY (ARRAY[''search''::text, ''own_facility''::text, '
    || '''appointment''::text, ''emergency''::text])))';
begin
  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table identity.patients, identity.facilities, identity.staff_facility_memberships, ehr.encounters
    in share row exclusive mode nowait;
  lock table ehr.visit_queue in access exclusive mode nowait;
  lock table audit.events in row exclusive mode nowait;
  lock table identity.unknown_patients, identity.consent_grants, identity.consent_directives,
    identity.consent_directive_versions, auth.permissions, auth.role_permissions
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0168: identity.patients, identity.facilities, identity.staff_facility_memberships, '
          || 'ehr.encounters, ehr.visit_queue, audit.events or a table 0168 reads (the unknown patient records, consent '
          || 'grants, consent directives, permissions and role permissions) is busy, and this transaction already holds an '
          || 'earlier migration''s locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0168: identity.patients, identity.facilities, identity.staff_facility_memberships, '
          || 'ehr.encounters, ehr.visit_queue, audit.events or a table 0168 reads (the unknown patient records, consent '
          || 'grants, consent directives, permissions and role permissions) stayed busy for 5 seconds; nothing applied; run '
          || 'the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- A marker of each of 0145, 0149 and 0150.
  if to_regprocedure('ehr.visit_queue_record_kinds(uuid[])') is null
     or to_regclass('ehr.catalog_versions') is null
     or not exists (select 1 from auth.role_permissions where role_code = 'doctor' and permission_code = 'ocr.job.start')
     or to_regclass('migration.schema_migrations') is null then
    raise exception using errcode = '55000', message = '0168: 0001-0151 must be applied first';
  end if;

  select pg_get_constraintdef(constraint_row.oid) into v_check_found from pg_constraint constraint_row
   where constraint_row.conrelid = 'ehr.visit_queue'::regclass
     and constraint_row.conname = 'visit_queue_check_in_basis_check';
  select count(*) into v_present
    from (values (to_regclass('ehr.ed_attendances')::oid), (to_regclass('ehr.ed_attendance_events')::oid),
                 (to_regprocedure('ehr.ed_cards(uuid[], uuid, uuid, uuid, boolean)')::oid),
                 (to_regprocedure('ehr.ed_arrive(text, uuid, text, timestamptz, smallint, text, text, text)')::oid),
                 (to_regprocedure('ehr.ed_board(boolean)')::oid),
                 (to_regprocedure('ehr.visit_queue_ed_attendances(uuid[])')::oid),
                 (to_regprocedure('ehr.visit_queue_ed_close_mirror()')::oid),
                 (to_regprocedure('ehr.visit_queue_ed_guard()')::oid),
                 (to_regprocedure('ehr.visit_queue_ed_board_off_update(uuid, bigint, text, smallint, boolean, uuid, boolean)')::oid),
                 ((select trigger_row.oid from pg_trigger trigger_row
                    where trigger_row.tgrelid = 'ehr.visit_queue'::regclass
                      and trigger_row.tgname = 'visit_queue_ed_close_mirror')),
                 ((select trigger_row.oid from pg_trigger trigger_row
                    where trigger_row.tgrelid = 'ehr.visit_queue'::regclass
                      and trigger_row.tgname = 'visit_queue_ed_guard')))
         present(object_id)
   where present.object_id is not null;
  if v_present = 11 and v_check_found in (v_check_0135_ed, v_check_appt_ed) then
    raise exception using errcode = '55000', message = '0168: already applied';
  end if;
  if v_present <> 0
     or v_check_found like '%emergency%'
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr' and (proc.proname like 'ed\_%' or proc.proname like 'visit\_queue\_ed\_%')) then
    raise exception using errcode = '55000',
      message = '0168: the schema is not in the reviewed state (part of 0168 is there); nothing applied';
  end if;
  if v_check_found is null or v_check_found not in (v_check_0135, v_check_appt) then
    raise exception using errcode = '55000',
      message = '0168: the waiting-list basis CHECK is neither 0135''s nor APPT-1''s; nothing applied';
  end if;

  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.resolve_patient_search_ref(text,text)', '9a80a8997571565f0e99c96f1cba4697'),
      ('identity.own_facility_basis(uuid,uuid)', '16ec336ac3633a295bc4a89f0e9f7542'),
      ('identity.facility_departments_valid(text[])', '8c52c07209052d3045736fa26eb6ac52'),
      ('ehr.visit_queue_update(uuid,bigint,text,smallint,boolean,uuid,boolean)', '6071d40ccdc0fca94d1bb91a1116df55')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0168: these bodies are not as 0001-0151 left them: ' || v_mismatch;
  end if;
  if to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_correlation_id()') is null
     or to_regprocedure('platform.current_purpose_of_use()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null
     or to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)') is null then
    raise exception using errcode = '55000', message = '0168: a function this file calls is missing';
  end if;
  select string_agg(code, ', ' order by code) into v_mismatch
    from (values ('ehr.encounter.read'), ('ehr.encounter.write'), ('ehr.note.write')) wanted(code)
   where not exists (select 1 from auth.permissions permission_row
                      where permission_row.code = wanted.code and permission_row.active);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0168: permission missing or inactive: ' || v_mismatch;
  end if;
  -- The columns this file reads, by name and type.
  select string_agg(wanted.relation || '.' || wanted.column_name, ', ' order by wanted.relation, wanted.column_name)
    into v_mismatch
    from (values
      ('ehr.visit_queue', 'id', 'uuid'), ('ehr.visit_queue', 'facility_id', 'uuid'),
      ('ehr.visit_queue', 'patient_id', 'uuid'), ('ehr.visit_queue', 'queue_day', 'date'),
      ('ehr.visit_queue', 'stage', 'text'), ('ehr.visit_queue', 'triage_level', 'smallint'),
      ('ehr.visit_queue', 'assigned_membership_id', 'uuid'), ('ehr.visit_queue', 'check_in_basis', 'text'),
      ('ehr.visit_queue', 'checked_in_by_account_id', 'uuid'), ('ehr.visit_queue', 'checked_in_by_membership_id', 'uuid'),
      ('ehr.visit_queue', 'checked_in_at', 'timestamp with time zone'),
      ('ehr.visit_queue', 'stage_changed_at', 'timestamp with time zone'),
      ('ehr.visit_queue', 'closed_at', 'timestamp with time zone'),
      ('ehr.visit_queue', 'updated_by_membership_id', 'uuid'),
      ('ehr.visit_queue', 'updated_at', 'timestamp with time zone'), ('ehr.visit_queue', 'row_version', 'bigint'),
      ('identity.patients', 'id', 'uuid'), ('identity.patients', 'status', 'text'),
      ('identity.unknown_patients', 'patient_id', 'uuid'), ('identity.unknown_patients', 'status', 'text'),
      ('identity.unknown_patients', 'label', 'text'),
      ('identity.consent_grants', 'patient_id', 'uuid'), ('identity.consent_grants', 'account_id', 'uuid'),
      ('identity.consent_grants', 'membership_id', 'uuid'), ('identity.consent_grants', 'facility_id', 'uuid'),
      ('identity.consent_grants', 'scope', 'text'), ('identity.consent_grants', 'status', 'text'),
      ('identity.consent_grants', 'break_glass', 'boolean'), ('identity.consent_grants', 'purpose_of_use', 'text'),
      ('identity.consent_grants', 'migration_hold_reason', 'text'),
      ('identity.consent_grants', 'starts_at', 'timestamp with time zone'),
      ('identity.consent_grants', 'expires_at', 'timestamp with time zone'),
      ('identity.consent_grants', 'revoked_at', 'timestamp with time zone'),
      ('ehr.encounters', 'patient_id', 'uuid'), ('ehr.encounters', 'facility_id', 'uuid'),
      ('ehr.encounters', 'status', 'text'), ('ehr.encounters', 'started_at', 'timestamp with time zone'),
      ('ehr.encounters', 'imported_paper_records', 'boolean'),
      ('identity.facility_profiles', 'facility_id', 'uuid'), ('identity.facility_profiles', 'departments', 'text[]'),
      ('identity.facility_profiles', 'created_at', 'timestamp with time zone')
    ) wanted(relation, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = wanted.relation::regclass
                        and attribute_row.attname = wanted.column_name and attribute_row.attnum > 0
                        and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0168: these columns are not as 0001-0151 left them: ' || v_mismatch;
  end if;
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  if not pg_has_role(v_owner, (select relation.relowner from pg_class relation
                                where relation.oid = 'ehr.encounters'::regclass), 'USAGE') then
    raise exception using errcode = '55000',
      message = '0168: the owner of 0135''s functions cannot read ehr.encounters under its forced row-level security';
  end if;
  select md5(coalesce(string_agg(to_jsonb(entry)::text, ',' order by entry.id), '')) into v_queue_rows
    from ehr.visit_queue entry;

  -- E1. The ED records.
  create table ehr.ed_attendances (
    id uuid primary key default gen_random_uuid(),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    organization_id uuid not null,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    visit_queue_entry_id uuid not null references ehr.visit_queue(id) on delete restrict,
    arrival_basis text not null check (arrival_basis in ('search', 'own_facility', 'emergency')),
    arrival_mode text not null
      check (arrival_mode in ('walk_in', 'ambulance', 'brought_by_public', 'police', 'referred', 'other')),
    arrived_at timestamptz not null,
    arrival_day date not null,
    moved_from_waiting_list boolean not null default false,
    -- The outpatient row as it was before the move (a cancel puts it back).
    moved_from_stage text check (moved_from_stage is null
      or moved_from_stage in ('waiting', 'triage', 'ready', 'with_clinician')),
    moved_from_triage_level smallint check (moved_from_triage_level between 1 and 5),
    moved_from_assigned_membership_id uuid,
    moved_from_stage_changed_at timestamptz,
    presenting_complaint text check (presenting_complaint is null
      or (presenting_complaint = btrim(presenting_complaint) and length(presenting_complaint) between 1 and 120
          and presenting_complaint !~ '[[:cntrl:]]')),
    triaged_at timestamptz,
    triaged_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    encounter_id uuid references ehr.encounters(id) on delete restrict,
    status text not null default 'open' check (status in ('open', 'decided', 'closed')),
    disposition_outcome text check (disposition_outcome is null or disposition_outcome in ('discharged',
      'admit_requested', 'referred_out', 'sent_to_outpatients', 'left_before_seen', 'left_against_advice', 'died')),
    admit_to_department_code text check (admit_to_department_code is null
      or (admit_to_department_code <> 'emergency' and identity.facility_departments_valid(array[admit_to_department_code]))),
    admitting_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    referred_to_facility_name text check (referred_to_facility_name is null
      or (referred_to_facility_name = btrim(referred_to_facility_name)
          and length(referred_to_facility_name) between 2 and 120 and referred_to_facility_name !~ '[[:cntrl:]]')),
    decided_at timestamptz,
    decided_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    left_at timestamptz,
    closed_via text check (closed_via is null or closed_via in ('board', 'disposition', 'cancel', 'waiting_list')),
    arrived_by_account_id uuid not null,
    arrived_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    constraint ed_attendances_facility_organization_fk foreign key (facility_id, organization_id)
      references identity.facilities(id, organization_id) on delete restrict,
    constraint ed_attendances_day_ck check (arrival_day = (arrived_at at time zone 'Africa/Lagos')::date),
    constraint ed_attendances_triaged_ck check ((triaged_at is null) = (triaged_by_membership_id is null)),
    constraint ed_attendances_moved_ck check (
      moved_from_waiting_list = (moved_from_stage is not null)
      and moved_from_waiting_list = (moved_from_stage_changed_at is not null)
      and (moved_from_waiting_list or (moved_from_triage_level is null and moved_from_assigned_membership_id is null))),
    -- Closed exactly when it has left, and then it says how.
    constraint ed_attendances_closed_ck check (
      (status = 'closed') = (left_at is not null) and (status = 'closed') = (closed_via is not null)),
    -- A disposition exactly when decided, or closed by a disposition or by leaving after one; never on an open
    -- record or a cancelled one; who and when exactly with it.
    constraint ed_attendances_disposition_ck check (
      (status <> 'open' or disposition_outcome is null)
      and (status <> 'decided'
           or coalesce(disposition_outcome in ('discharged', 'admit_requested', 'referred_out'), false))
      and (closed_via is null or closed_via <> 'cancel' or disposition_outcome is null)
      and (closed_via is null or closed_via <> 'board'
           or coalesce(disposition_outcome in ('discharged', 'admit_requested', 'referred_out'), false))
      and (closed_via is null or closed_via <> 'disposition'
           or coalesce(disposition_outcome in ('sent_to_outpatients', 'left_before_seen', 'left_against_advice',
                                               'died'), false))
      and (disposition_outcome is null) = (decided_at is null)
      and (disposition_outcome is null) = (decided_by_membership_id is null)),
    constraint ed_attendances_admission_ck check (
      (admit_to_department_code is not null) = (disposition_outcome is not distinct from 'admit_requested')
      and (admitting_membership_id is null or disposition_outcome is not distinct from 'admit_requested')),
    constraint ed_attendances_referral_ck check (
      referred_to_facility_name is null or disposition_outcome is not distinct from 'referred_out')
  );
  create index ed_attendances_open_idx on ehr.ed_attendances (facility_id, status, arrived_at) where status <> 'closed';
  -- The closed records of a day by the Lagos day they left the department (the board's "left today").
  create index ed_attendances_closed_day_idx on ehr.ed_attendances (facility_id, ((left_at at time zone 'Africa/Lagos')::date))
    where status = 'closed';
  create index ed_attendances_patient_idx on ehr.ed_attendances (patient_id);
  create unique index ed_attendances_entry_open_ux on ehr.ed_attendances (visit_queue_entry_id) where status <> 'closed';
  create unique index ed_attendances_patient_open_ux on ehr.ed_attendances (facility_id, patient_id)
    where status <> 'closed';
  create index ed_attendances_admit_requested_idx on ehr.ed_attendances (facility_id, status)
    where disposition_outcome = 'admit_requested';
  create index ed_attendances_entry_idx on ehr.ed_attendances (visit_queue_entry_id);
  create index ed_attendances_encounter_idx on ehr.ed_attendances (encounter_id) where encounter_id is not null;
  alter table ehr.ed_attendances enable row level security;
  revoke all on ehr.ed_attendances from public;
  comment on table ehr.ed_attendances is
    '0168 (ED-1): one row per arrival on the emergency department board, beside its waiting-list row (0135), which keeps the stage, the triage level and the assignee (for a patient moved from the outpatient waiting list, that row as it was before the move is kept too, so a cancel puts it back). The presenting complaint is shown only to members holding ehr.ed.triage. Cancelled records are kept. Only the ED functions read and write it, as its owner.';

  -- E2. The history.
  create table ehr.ed_attendance_events (
    id uuid primary key default gen_random_uuid(),
    sequence_no bigint generated always as identity,
    attendance_id uuid not null references ehr.ed_attendances(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    kind text not null check (kind in ('arrived', 'moved_from_waiting_list', 'already_on_board', 'triaged', 'moved',
      'visit_linked', 'disposition', 'disposition_changed', 'left', 'cancelled', 'closed_on_waiting_list')),
    at timestamptz not null default clock_timestamp(),
    by_account_id uuid,
    by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    from_stage text check (from_stage is null
      or from_stage in ('waiting', 'triage', 'ready', 'with_clinician', 'finished', 'left', 'cancelled')),
    to_stage text check (to_stage is null
      or to_stage in ('waiting', 'triage', 'ready', 'with_clinician', 'finished', 'left', 'cancelled')),
    triage_level smallint check (triage_level between 1 and 5),
    complaint_changed boolean,
    assigned_membership_id uuid,
    encounter_id uuid,
    outcome text check (outcome is null or outcome in ('discharged', 'admit_requested', 'referred_out',
      'sent_to_outpatients', 'left_before_seen', 'left_against_advice', 'died')),
    basis text check (basis is null or basis in ('search', 'own_facility', 'emergency')),
    reason text,
    idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) check (request_sha256 ~ '^[0-9a-f]{64}$'),
    constraint ed_attendance_events_reason_ck check (
      (kind not in ('disposition_changed', 'cancelled') or reason is not null)
      and (reason is null or (reason = btrim(reason) and length(reason) between 8 and 500))),
    constraint ed_attendance_events_outcome_ck check ((kind in ('disposition', 'disposition_changed')) = (outcome is not null)),
    constraint ed_attendance_events_key_ck check (
      (idempotency_key is null) = (request_sha256 is null)
      and (kind = 'closed_on_waiting_list') = (idempotency_key is null))
  );
  create unique index ed_attendance_events_key_ux on ehr.ed_attendance_events (by_membership_id, idempotency_key)
    where idempotency_key is not null;
  create index ed_attendance_events_attendance_idx on ehr.ed_attendance_events (attendance_id, sequence_no);
  create index ed_attendance_events_patient_idx on ehr.ed_attendance_events (patient_id);
  alter table ehr.ed_attendance_events enable row level security;
  revoke all on ehr.ed_attendance_events from public;
  comment on table ehr.ed_attendance_events is
    '0168 (ED-1): one row per arrival, triage, move, visit link, disposition, leave, cancel or mirrored close of an ED record, with the Idempotency-Key and the request''s SHA-256. Never the complaint text. Append only (a trigger refuses update and delete). Only the ED functions read and write it, as its owner.';

  create function ehr.ed_attendance_events_immutable()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    raise exception using errcode = '55000', message = 'ED_HISTORY_IMMUTABLE';
  end
  $fn$;
  revoke all on function ehr.ed_attendance_events_immutable() from public;
  create trigger ed_attendance_events_immutable
    before update or delete on ehr.ed_attendance_events
    for each row execute function ehr.ed_attendance_events_immutable();

  -- E3. The waiting-list basis: every value found, plus emergency.
  alter table ehr.visit_queue drop constraint visit_queue_check_in_basis_check;
  if v_check_found = v_check_appt then
    alter table ehr.visit_queue add constraint visit_queue_check_in_basis_check
      check (check_in_basis in ('search', 'own_facility', 'appointment', 'emergency'));
  else
    alter table ehr.visit_queue add constraint visit_queue_check_in_basis_check
      check (check_in_basis in ('search', 'own_facility', 'emergency'));
  end if;

  -- E4. Helpers (no role may execute them; the functions below run them as their owner).
  -- The caller: an active membership here not held by the cutover, ehr.ed.read, the function's own code, 0135's pair,
  -- and an allowed purpose. can_triage says whether the complaint is shown.
  create function ehr.ed_caller(required_code text, allowed_purposes text[])
  returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
    actor_organization uuid, actor_staff uuid, actor_correlation text, actor_purpose text, can_triage boolean)
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    actor_subject := platform.current_actor_subject();
    actor_account := auth.account_id_for_subject(actor_subject);
    actor_membership := platform.current_membership_id();
    actor_facility := platform.current_facility_id();
    actor_correlation := platform.current_correlation_id();
    actor_purpose := platform.current_purpose_of_use();
    if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null then
      raise exception using errcode = '42501', message = 'ED_BOARD_NOT_ALLOWED';
    end if;
    select membership.organization_id, membership.staff_id into actor_organization, actor_staff
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null;
    if not found
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.ed.read')
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.read')
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.write') then
      raise exception using errcode = '42501', message = 'ED_BOARD_NOT_ALLOWED';
    end if;
    can_triage := auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.ed.triage');
    if required_code = 'ehr.ed.arrive'
       and not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.ed.arrive') then
      raise exception using errcode = '42501', message = 'ED_BOARD_NOT_ALLOWED';
    elsif required_code = 'ehr.ed.triage' and not can_triage then
      raise exception using errcode = '42501', message = 'ED_TRIAGE_NOT_ALLOWED';
    elsif required_code = 'ehr.ed.disposition'
          and not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.ed.disposition') then
      raise exception using errcode = '42501', message = 'ED_DISPOSITION_NOT_ALLOWED';
    elsif required_code not in ('ehr.ed.read', 'ehr.ed.arrive', 'ehr.ed.triage', 'ehr.ed.disposition') then
      raise exception using errcode = '42501', message = 'ED_BOARD_NOT_ALLOWED';
    end if;
    if actor_purpose is null or not actor_purpose = any (allowed_purposes) then
      raise exception using errcode = '22023', message = 'ED_DIRECT_CARE_ONLY';
    end if;
    return next;
  end
  $fn$;
  revoke all on function ehr.ed_caller(text, text[]) from public;

  create function ehr.ed_audit(a_subject text, a_account uuid, a_membership uuid, a_organization uuid,
    a_facility uuid, a_correlation text, a_purpose text, a_patient uuid, a_action text, a_outcome text,
    a_resource_type text, a_resource_id text, a_details jsonb)
  returns void
  language sql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      a_correlation, 'staff', a_subject, a_account, a_membership, a_organization, a_facility, a_patient,
      a_action, a_outcome, a_resource_type, a_resource_id, a_purpose, 'application', 'ehr-api',
      coalesce(a_details, '{}'::jsonb))
  $fn$;
  revoke all on function ehr.ed_audit(text, uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text, jsonb)
    from public;

  -- The Idempotency-Key: 'new', 'replay' (the same key and body: the record and the first answer's kind) or
  -- 'reused' (the same key, another body). Under an advisory lock per membership and key, so two requests with one
  -- key never both act.
  create function ehr.ed_idempotency(a_membership uuid, a_key text, a_sha text)
  returns table (state text, attendance_id uuid, kind text)
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    found_event ehr.ed_attendance_events%rowtype;
  begin
    if a_key is null or a_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or a_sha is null or a_sha !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'ED_IDEMPOTENCY_KEY_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('ed-key:' || a_membership::text || ':' || a_key, 0));
    select event.* into found_event from ehr.ed_attendance_events event
     where event.by_membership_id = a_membership and event.idempotency_key = a_key;
    if not found then
      state := 'new';
    elsif found_event.request_sha256 = a_sha then
      state := 'replay';
      attendance_id := found_event.attendance_id;
      kind := found_event.kind;
    else
      state := 'reused';
      attendance_id := found_event.attendance_id;
    end if;
    return next;
  end
  $fn$;
  revoke all on function ehr.ed_idempotency(uuid, text, text) from public;

  -- The board card: 0135's card fields (from the waiting-list row and identity.patients), 0145's record kind and
  -- label, and the ED fields. Never clinical content beyond the presenting complaint, and that only when asked for
  -- (the caller holds ehr.ed.triage); never a Health ID (its last 4 characters only).
  create function ehr.ed_cards(requested_ids uuid[], viewer_facility uuid, viewer_organization uuid,
    viewer_staff uuid, show_complaint boolean)
  returns table (ord bigint, attendance_id uuid, entry_id uuid, patient_id uuid, full_name text,
    record_kind text, unknown_label text, sex text, date_of_birth date, dob_estimated boolean, health_id_last4 text,
    chart_blocked boolean, arrival_basis text, arrival_mode text, arrived_at timestamptz, minutes_in_department integer,
    board_column text, stage text, triage_level smallint, triaged_at timestamptz, triaged_by_membership_id uuid,
    presenting_complaint text, complaint_hidden boolean, assigned_membership_id uuid, encounter_id uuid, status text,
    disposition_outcome text, decided_at timestamptz, decided_by_membership_id uuid, admit_to_department_code text,
    admitting_membership_id uuid, referred_to_facility_name text, left_at timestamptz, row_version bigint)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ordering.ord_position, attendance.id, attendance.visit_queue_entry_id, attendance.patient_id,
           patient.full_name,
           case when unknown_record.patient_id is null then 'standard' else 'unknown' end,
           unknown_record.label, patient.gender, patient.dob,
           unknown_record.patient_id is not null and patient.dob is not null,
           right(patient.hid_code, 4),
           exists (
             select 1
               from identity.consent_directives directive
               join identity.consent_directive_versions directive_version
                 on directive_version.directive_id = directive.id
                and directive_version.version_no = directive.current_version
              where directive.patient_id = attendance.patient_id
                and directive_version.status = 'active'
                and directive_version.provision_type = 'deny'
                and directive_version.starts_at <= clock_timestamp()
                and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
                and (directive_version.facility_id is null or directive_version.facility_id = viewer_facility)
                and (cardinality(directive_version.actions) = 0
                     or directive_version.actions && array['read_records', 'write_records']::text[])
                and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any (directive_version.purposes))
                and (directive_version.grantee_type = 'all'
                     or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = viewer_facility)
                     or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = viewer_organization)
                     or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = viewer_staff))),
           attendance.arrival_basis, attendance.arrival_mode, attendance.arrived_at,
           greatest(floor(extract(epoch from (coalesce(attendance.left_at, clock_timestamp()) - attendance.arrived_at))
                          / 60), 0)::integer,
           case when attendance.status = 'closed' then 'closed'
                when attendance.status = 'decided' then 'disposition'
                when entry.stage = 'with_clinician' then 'being_seen'
                else 'waiting' end,
           entry.stage, entry.triage_level, attendance.triaged_at, attendance.triaged_by_membership_id,
           case when coalesce(show_complaint, false) then attendance.presenting_complaint end,
           not coalesce(show_complaint, false),
           entry.assigned_membership_id, attendance.encounter_id, attendance.status, attendance.disposition_outcome,
           attendance.decided_at, attendance.decided_by_membership_id, attendance.admit_to_department_code,
           attendance.admitting_membership_id, attendance.referred_to_facility_name, attendance.left_at,
           attendance.row_version
      from unnest(requested_ids) with ordinality ordering(id, ord_position)
      join ehr.ed_attendances attendance on attendance.id = ordering.id and attendance.facility_id = viewer_facility
      join ehr.visit_queue entry on entry.id = attendance.visit_queue_entry_id
      join identity.patients patient on patient.id = attendance.patient_id
      left join identity.unknown_patients unknown_record
        on unknown_record.patient_id = attendance.patient_id and unknown_record.status <> 'identified'
     order by ordering.ord_position
  $fn$;
  comment on function ehr.ed_cards(uuid[], uuid, uuid, uuid, boolean) is
    '0168 (ED-1): the board card of each given ED record at the viewer''s facility, in the given order: 0135''s card fields, 0145''s record kind and label, the arrival, the column, the waiting-list row''s stage, triage level and assignee, the complaint (only when show_complaint), the visit, the disposition and the row version. Called by the ED functions as their owner; no role may execute it.';
  revoke all on function ehr.ed_cards(uuid[], uuid, uuid, uuid, boolean) from public;

  -- Route 1: put a patient on the board.
  create function ehr.ed_arrive(requested_match_ref text, requested_patient_id uuid, requested_arrival_mode text,
    requested_arrived_at timestamptz, requested_triage_level smallint, requested_complaint text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, attendance_id uuid, entry_id uuid, patient_id uuid, full_name text,
    record_kind text, unknown_label text, sex text, date_of_birth date, dob_estimated boolean, health_id_last4 text,
    chart_blocked boolean, arrival_basis text, arrival_mode text, arrived_at timestamptz, minutes_in_department integer,
    board_column text, stage text, triage_level smallint, triaged_at timestamptz, triaged_by_membership_id uuid,
    presenting_complaint text, complaint_hidden boolean, assigned_membership_id uuid, encounter_id uuid, status text,
    disposition_outcome text, decided_at timestamptz, decided_by_membership_id uuid, admit_to_department_code text,
    admitting_membership_id uuid, referred_to_facility_name text, left_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    ref_value text := nullif(btrim(coalesce(requested_match_ref, '')), '');
    complaint_value text := nullif(btrim(coalesce(requested_complaint, '')), '');
    patient_value uuid;
    basis_value text;
    refusal text;
    refusal_kind text;
    arrived_value timestamptz;
    existing_row ehr.ed_attendances%rowtype;
    entry_row ehr.visit_queue%rowtype;
    moved_row ehr.visit_queue%rowtype;
    stage_before text;
    outcome_value text;
    new_id uuid;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.ed_caller('ehr.ed.arrive', array['direct-care', 'emergency']);
    if (ref_value is null) = (requested_patient_id is null) then
      raise exception using errcode = '22023', message = 'ED_ARRIVAL_NEEDS_ONE_PATIENT';
    end if;
    -- Emergency is the purpose only of an emergency search's matchRef.
    if caller.actor_purpose = 'emergency' and ref_value is null then
      raise exception using errcode = '22023', message = 'ED_DIRECT_CARE_ONLY';
    end if;
    if (ref_value is not null and ref_value !~ '^psr_[A-Za-z0-9_-]{43}$')
       or requested_arrival_mode is null
       or requested_arrival_mode not in ('walk_in', 'ambulance', 'brought_by_public', 'police', 'referred', 'other')
       or (requested_complaint is not null
           and (complaint_value is null or length(complaint_value) > 120 or complaint_value ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'ED_INVALID';
    end if;
    if requested_triage_level is not null and requested_triage_level not between 1 and 5 then
      raise exception using errcode = '22023', message = 'ED_TRIAGE_INVALID';
    end if;
    if (requested_triage_level is not null or complaint_value is not null) and not caller.can_triage then
      raise exception using errcode = '42501', message = 'ED_TRIAGE_NOT_ALLOWED';
    end if;

    select * into key_state from ehr.ed_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select attendance.patient_id from ehr.ed_attendances attendance where attendance.id = key_state.attendance_id), 'ehr.ed.arrive', 'success', 'ed-attendance', key_state.attendance_id::text,
        jsonb_build_object('replayed', true, 'outcome', key_state.kind));
      return query select key_state.kind, true, card.* from ehr.ed_cards(array[key_state.attendance_id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
      return;
    elsif key_state.state = 'reused' then
      refusal := 'key_reused';
      refusal_kind := 'key_reused';
    end if;

    if refusal is null then
      if ref_value is not null then
        patient_value := identity.resolve_patient_search_ref(ref_value, caller.actor_purpose);
        if patient_value is null then
          refusal := 'needs_search';
          refusal_kind := 'match_ref_not_valid';
        elsif caller.actor_purpose = 'emergency' then
          -- Q-ED-3 A: this member's own active, unexpired break-glass grant for the patient here.
          if exists (select 1 from identity.consent_grants grant_row
                      where grant_row.patient_id = patient_value
                        and grant_row.account_id = caller.actor_account
                        and grant_row.membership_id = caller.actor_membership
                        and grant_row.facility_id = caller.actor_facility
                        and grant_row.scope = 'break_glass' and grant_row.break_glass
                        and grant_row.purpose_of_use = 'emergency'
                        and grant_row.status = 'active' and grant_row.revoked_at is null
                        and grant_row.migration_hold_reason is null
                        and grant_row.starts_at <= now_value and grant_row.expires_at > now_value) then
            basis_value := 'emergency';
          else
            refusal := 'needs_search';
            refusal_kind := 'no_break_glass';
          end if;
        else
          basis_value := 'search';
        end if;
      else
        select patient.id into patient_value
          from identity.patients patient
         where patient.id = requested_patient_id and patient.status = 'active'
           and identity.sealed_demo_facility(caller.actor_facility) = identity.sealed_demo_patient(patient.id)
           and identity.sealed_qa_facility(caller.actor_facility) = identity.sealed_qa_patient(patient.id);
        if patient_value is null then
          refusal := 'needs_search';
          refusal_kind := 'patient_not_available';
        elsif identity.own_facility_basis(patient_value, caller.actor_facility) is null then
          refusal := 'needs_search';
          refusal_kind := 'not_own_facility_patient';
        else
          basis_value := 'own_facility';
        end if;
      end if;
    end if;

    if refusal is null then
      -- At most 6 hours ago and not in the future; up to 2 minutes ahead (device clocks) is taken as now.
      arrived_value := least(coalesce(requested_arrived_at, now_value), now_value);
      if requested_arrived_at is not null
         and (requested_arrived_at > now_value + interval '2 minutes'
              or requested_arrived_at < now_value - interval '6 hours') then
        refusal := 'time_invalid';
        refusal_kind := 'time_invalid';
      end if;
    end if;

    if refusal is not null then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        case when refusal_kind in ('no_break_glass', 'not_own_facility_patient', 'time_invalid') then patient_value end, 'ehr.ed.arrive', 'denied', 'ed-attendance', null,
        jsonb_build_object('by', case when ref_value is not null then 'match_ref' else 'patient_id' end, 'refusal', refusal_kind));
      outcome := refusal;
      replayed := false;
      return next;
      return;
    end if;

    -- 0135's lock and its one open row per patient per facility.
    perform pg_advisory_xact_lock(hashtextextended(
      'visit-queue:' || caller.actor_facility::text || ':' || patient_value::text, 0));
    select attendance.* into existing_row from ehr.ed_attendances attendance
     where attendance.facility_id = caller.actor_facility and attendance.patient_id = patient_value
       and attendance.status <> 'closed'
     for update;
    if found then
      insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
        by_membership_id, basis, idempotency_key, request_sha256)
      values (existing_row.id, caller.actor_facility, patient_value, 'already_on_board', now_value, caller.actor_account,
        caller.actor_membership, basis_value, requested_idempotency_key, requested_request_sha256);
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        patient_value, 'ehr.ed.arrive', 'success', 'ed-attendance', existing_row.id::text,
        jsonb_build_object('by', case when ref_value is not null then 'match_ref' else 'patient_id' end, 'basis', basis_value, 'outcome', 'already_on_board'));
      return query select 'already_on_board', false, card.* from ehr.ed_cards(array[existing_row.id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
      return;
    end if;

    select entry.* into entry_row from ehr.visit_queue entry
     where entry.facility_id = caller.actor_facility and entry.patient_id = patient_value and entry.closed_at is null
     for update;
    if found then
      outcome_value := 'moved_from_waiting_list';
      -- The outpatient row as it was: a cancel of this arrival puts it back.
      moved_row := entry_row;
    else
      outcome_value := 'arrived';
      insert into ehr.visit_queue (facility_id, patient_id, queue_day, check_in_basis, checked_in_by_account_id,
        checked_in_by_membership_id, checked_in_at, stage_changed_at, updated_by_membership_id, updated_at)
      values (caller.actor_facility, patient_value, (now_value at time zone 'Africa/Lagos')::date, basis_value,
        caller.actor_account, caller.actor_membership, now_value, now_value, caller.actor_membership, now_value)
      returning * into entry_row;
      -- 0135's own audit row for a new waiting-list row, made by the emergency department.
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        patient_value, 'ehr.visit-queue.check-in', 'success', 'visit-queue-entry', entry_row.id::text,
        jsonb_build_object('by', 'emergency_department', 'basis', basis_value, 'alreadyOpen', false));
    end if;
    stage_before := entry_row.stage;
    -- Triage on arrival (nurses, clinicians and doctors): the level on the waiting-list row, ready to be seen.
    if requested_triage_level is not null then
      perform set_config('hid.ed_board_closing', entry_row.id::text, true);
      update ehr.visit_queue entry
         set triage_level = requested_triage_level,
             stage = case when entry.stage in ('waiting', 'triage') then 'ready' else entry.stage end,
             stage_changed_at = case when entry.stage in ('waiting', 'triage') then now_value
                                     else entry.stage_changed_at end,
             updated_by_membership_id = caller.actor_membership, updated_at = now_value,
             row_version = entry.row_version + 1
       where entry.id = entry_row.id
      returning * into entry_row;
      perform set_config('hid.ed_board_closing', '', true);
    end if;

    insert into ehr.ed_attendances (facility_id, organization_id, patient_id, visit_queue_entry_id, arrival_basis,
      arrival_mode, arrived_at, arrival_day, moved_from_waiting_list, moved_from_stage, moved_from_triage_level,
      moved_from_assigned_membership_id, moved_from_stage_changed_at, presenting_complaint, triaged_at,
      triaged_by_membership_id, arrived_by_account_id, arrived_by_membership_id, updated_by_membership_id, updated_at)
    values (caller.actor_facility, caller.actor_organization, patient_value, entry_row.id, basis_value,
      requested_arrival_mode, arrived_value, (arrived_value at time zone 'Africa/Lagos')::date,
      outcome_value = 'moved_from_waiting_list', moved_row.stage, moved_row.triage_level,
      moved_row.assigned_membership_id, moved_row.stage_changed_at, complaint_value,
      case when requested_triage_level is not null or complaint_value is not null then now_value end,
      case when requested_triage_level is not null or complaint_value is not null then caller.actor_membership end,
      caller.actor_account, caller.actor_membership, caller.actor_membership, now_value)
    returning id into new_id;
    insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_stage, to_stage, triage_level, complaint_changed, basis, idempotency_key, request_sha256)
    values (new_id, caller.actor_facility, patient_value, outcome_value, now_value, caller.actor_account,
      caller.actor_membership, case when outcome_value = 'moved_from_waiting_list' then stage_before end,
      entry_row.stage, requested_triage_level, complaint_value is not null, basis_value, requested_idempotency_key,
      requested_request_sha256);
    perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        patient_value, 'ehr.ed.arrive', 'success', 'ed-attendance', new_id::text,
        jsonb_build_object('by', case when ref_value is not null then 'match_ref' else 'patient_id' end, 'basis', basis_value, 'outcome', outcome_value, 'arrivalMode', requested_arrival_mode, 'triageLevel', requested_triage_level, 'complaintRecorded', complaint_value is not null, 'visitQueueEntryId', entry_row.id));
    return query select outcome_value, false, card.* from ehr.ed_cards(array[new_id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
  end
  $fn$;
  comment on function ehr.ed_arrive(text, uuid, text, timestamptz, smallint, text, text, text) is
    '0168 (ED-1, Q-ED-1 A, Q-ED-3 A): put a patient on this facility''s emergency board. Exactly one of a matchRef from this member''s own direct-care search in the last 10 minutes (basis search), a patient id of this facility''s own patient (0131, basis own_facility), or (session purpose emergency) a matchRef from this member''s own emergency search while this member holds an active break-glass grant for that patient here (basis emergency); anything else answers needs_search, the same for every reason. Under 0135''s advisory lock: a new waiting-list row (arrived), the open outpatient row (moved_from_waiting_list) or the record already on the board (already_on_board, triage fields not applied). Needs ehr.ed.read, ehr.ed.arrive and 0135''s pair; the triage level and complaint need ehr.ed.triage. Audited (ehr.ed.arrive; ehr.visit-queue.check-in when a row is made).';
  revoke all on function ehr.ed_arrive(text, uuid, text, timestamptz, smallint, text, text, text) from public;

  -- Route 2: the board.
  create function ehr.ed_board(requested_include_closed_today boolean)
  returns table (ord bigint, attendance_id uuid, entry_id uuid, patient_id uuid, full_name text,
    record_kind text, unknown_label text, sex text, date_of_birth date, dob_estimated boolean, health_id_last4 text,
    chart_blocked boolean, arrival_basis text, arrival_mode text, arrived_at timestamptz, minutes_in_department integer,
    board_column text, stage text, triage_level smallint, triaged_at timestamptz, triaged_by_membership_id uuid,
    presenting_complaint text, complaint_hidden boolean, assigned_membership_id uuid, encounter_id uuid, status text,
    disposition_outcome text, decided_at timestamptz, decided_by_membership_id uuid, admit_to_department_code text,
    admitting_membership_id uuid, referred_to_facility_name text, left_at timestamptz, row_version bigint, has_more boolean, waiting_count integer, being_seen_count integer,
    disposition_count integer)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    board_limit constant integer := 200;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    found_ids uuid[];
    shown_ids uuid[];
    shown_patients uuid[];
    more boolean;
    counted record;
  begin
    select * into caller from ehr.ed_caller('ehr.ed.read', array['direct-care']);
    select array_agg(listed.id order by listed.column_order, listed.level_order, listed.arrived_at, listed.id)
      into found_ids
      from (
        select attendance.id,
               case when attendance.status = 'closed' then 4 when attendance.status = 'decided' then 3
                    when entry.stage = 'with_clinician' then 2 else 1 end as column_order,
               coalesce(entry.triage_level, 6) as level_order, attendance.arrived_at
          from ehr.ed_attendances attendance
          join ehr.visit_queue entry on entry.id = attendance.visit_queue_entry_id
         where attendance.facility_id = caller.actor_facility
           and (attendance.status <> 'closed'
                or (coalesce(requested_include_closed_today, false)
                    and (attendance.left_at at time zone 'Africa/Lagos')::date = today))
         order by 2, 3, attendance.arrived_at, attendance.id
         limit board_limit + 1
      ) listed;
    more := coalesce(cardinality(found_ids), 0) > board_limit;
    shown_ids := coalesce(found_ids[1:board_limit], array[]::uuid[]);
    select coalesce(array_agg(attendance.patient_id order by ordering.ord_position), array[]::uuid[]) into shown_patients
      from unnest(shown_ids) with ordinality ordering(id, ord_position)
      join ehr.ed_attendances attendance on attendance.id = ordering.id;
    select count(*) filter (where attendance.status = 'open' and entry.stage <> 'with_clinician')::integer as waiting,
           count(*) filter (where attendance.status = 'open' and entry.stage = 'with_clinician')::integer as being_seen,
           count(*) filter (where attendance.status = 'decided')::integer as decided
      into counted
      from ehr.ed_attendances attendance
      join ehr.visit_queue entry on entry.id = attendance.visit_queue_entry_id
     where attendance.facility_id = caller.actor_facility and attendance.status <> 'closed';

    perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        null, 'ehr.ed.board', 'success', 'ed-board', null,
        jsonb_build_object('includeClosedToday', coalesce(requested_include_closed_today, false), 'resultCount', cardinality(shown_ids), 'hasMore', more, 'patientIds', to_jsonb(shown_patients)));
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    )
    select caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
           caller.actor_organization, caller.actor_facility, attendance.patient_id, 'ehr.ed.board.shown', 'success',
           'ed-attendance', attendance.id::text, caller.actor_purpose, 'application', 'ehr-api',
           jsonb_build_object('status', attendance.status)
      from unnest(shown_ids) with ordinality ordering(id, ord_position)
      join ehr.ed_attendances attendance on attendance.id = ordering.id
     order by ordering.ord_position;

    return query select card.*, more, counted.waiting, counted.being_seen, counted.decided
      from ehr.ed_cards(shown_ids, caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
  end
  $fn$;
  comment on function ehr.ed_board(boolean) is
    '0168 (ED-1): this facility''s open and decided ED records (and, when asked, the closed ones that left the department today, Lagos day, whenever they arrived), by column (waiting, being seen, disposition, closed), then triage level (1 first, no level last), then arrival, at most 200, has_more when there are more, with the counts of the three columns. Needs ehr.ed.read and 0135''s pair, for direct care. The complaint only for members holding ehr.ed.triage. Audited: one ehr.ed.board row and one ehr.ed.board.shown row per patient shown.';
  revoke all on function ehr.ed_board(boolean) from public;

  -- Route 3: one record with its history.
  create function ehr.ed_read(requested_attendance_id uuid)
  returns table (outcome text, ord bigint, attendance_id uuid, entry_id uuid, patient_id uuid, full_name text,
    record_kind text, unknown_label text, sex text, date_of_birth date, dob_estimated boolean, health_id_last4 text,
    chart_blocked boolean, arrival_basis text, arrival_mode text, arrived_at timestamptz, minutes_in_department integer,
    board_column text, stage text, triage_level smallint, triaged_at timestamptz, triaged_by_membership_id uuid,
    presenting_complaint text, complaint_hidden boolean, assigned_membership_id uuid, encounter_id uuid, status text,
    disposition_outcome text, decided_at timestamptz, decided_by_membership_id uuid, admit_to_department_code text,
    admitting_membership_id uuid, referred_to_facility_name text, left_at timestamptz, row_version bigint, history jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    patient_value uuid;
  begin
    select * into caller from ehr.ed_caller('ehr.ed.read', array['direct-care']);
    if requested_attendance_id is null then
      raise exception using errcode = '22023', message = 'ED_INVALID';
    end if;
    select attendance.patient_id into patient_value from ehr.ed_attendances attendance
     where attendance.id = requested_attendance_id and attendance.facility_id = caller.actor_facility;
    if patient_value is null then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        null, 'ehr.ed.record-read', 'failure', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('outcome', 'not_found'));
      outcome := 'not_found';
      return next;
      return;
    end if;
    perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        patient_value, 'ehr.ed.record-read', 'success', 'ed-attendance', requested_attendance_id::text,
        '{}'::jsonb);
    return query
      select 'found', card.*,
             coalesce((select jsonb_agg(jsonb_build_object('kind', event.kind, 'at', event.at,
                         'byMembershipId', event.by_membership_id, 'fromStage', event.from_stage,
                         'toStage', event.to_stage, 'triageLevel', event.triage_level, 'outcome', event.outcome,
                         'reason', event.reason, 'complaintChanged', event.complaint_changed)
                         order by event.sequence_no)
                         from ehr.ed_attendance_events event
                        where event.attendance_id = requested_attendance_id and event.kind <> 'already_on_board'),
                      '[]'::jsonb)
        from ehr.ed_cards(array[requested_attendance_id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
  end
  $fn$;
  comment on function ehr.ed_read(uuid) is
    '0168 (ED-1): one ED record of this facility with its history (arrived, moved_from_waiting_list, triaged, moved, visit_linked, disposition, disposition_changed, left, cancelled, closed_on_waiting_list; never the complaint text). Needs ehr.ed.read and 0135''s pair, for direct care. Another facility''s record answers not_found. Audited (ehr.ed.record-read).';
  revoke all on function ehr.ed_read(uuid) from public;

  -- Route 4: triage (the level on the waiting-list row; the complaint on the ED record).
  create function ehr.ed_triage(requested_attendance_id uuid, requested_row_version bigint,
    requested_triage_level smallint, requested_complaint text, requested_set_complaint boolean,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, attendance_id uuid, entry_id uuid, patient_id uuid, full_name text,
    record_kind text, unknown_label text, sex text, date_of_birth date, dob_estimated boolean, health_id_last4 text,
    chart_blocked boolean, arrival_basis text, arrival_mode text, arrived_at timestamptz, minutes_in_department integer,
    board_column text, stage text, triage_level smallint, triaged_at timestamptz, triaged_by_membership_id uuid,
    presenting_complaint text, complaint_hidden boolean, assigned_membership_id uuid, encounter_id uuid, status text,
    disposition_outcome text, decided_at timestamptz, decided_by_membership_id uuid, admit_to_department_code text,
    admitting_membership_id uuid, referred_to_facility_name text, left_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    complaint_value text := nullif(btrim(coalesce(requested_complaint, '')), '');
    current_row ehr.ed_attendances%rowtype;
    entry_row ehr.visit_queue%rowtype;
    refusal text;
    stage_after text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.ed_caller('ehr.ed.triage', array['direct-care']);
    if requested_attendance_id is null or requested_row_version is null or requested_row_version < 1
       or (coalesce(requested_set_complaint, false) and requested_complaint is not null
           and (complaint_value is null or length(complaint_value) > 120 or complaint_value ~ '[[:cntrl:]]'))
       or (not coalesce(requested_set_complaint, false) and requested_complaint is not null) then
      raise exception using errcode = '22023', message = 'ED_INVALID';
    end if;
    if requested_triage_level is null or requested_triage_level not between 1 and 5 then
      raise exception using errcode = '22023', message = 'ED_TRIAGE_INVALID';
    end if;
    select * into key_state from ehr.ed_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.attendance_id = requested_attendance_id then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select attendance.patient_id from ehr.ed_attendances attendance where attendance.id = requested_attendance_id), 'ehr.ed.triage', 'success', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('replayed', true));
      return query select 'updated', true, card.* from ehr.ed_cards(array[requested_attendance_id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
      return;
    end if;
    -- The ED record, then the waiting-list row, FOR UPDATE, always in that order.
    select attendance.* into current_row from ehr.ed_attendances attendance
     where attendance.id = requested_attendance_id and attendance.facility_id = caller.actor_facility
     for update;
    if not found then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        null, 'ehr.ed.triage', 'failure', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('outcome', 'not_found'));
      outcome := 'not_found';
      replayed := false;
      return next;
      return;
    end if;
    select entry.* into entry_row from ehr.visit_queue entry where entry.id = current_row.visit_queue_entry_id
     for update;
    if key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif current_row.status = 'closed' then
      refusal := 'closed';
    end if;
    if refusal is null and current_row.status = 'decided' then
      refusal := 'decided';
    end if;
    if refusal is null and current_row.row_version <> requested_row_version then
      refusal := 'changed';
    end if;
    if refusal is not null then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.triage', 'denied', 'ed-attendance', current_row.id::text,
        jsonb_build_object('refusal', refusal));
      outcome := refusal;
      replayed := false;
      return next;
      return;
    end if;

    stage_after := case when entry_row.stage in ('waiting', 'triage') then 'ready' else entry_row.stage end;
    perform set_config('hid.ed_board_closing', entry_row.id::text, true);
    update ehr.visit_queue entry
       set triage_level = requested_triage_level, stage = stage_after,
           stage_changed_at = case when stage_after <> entry.stage then now_value else entry.stage_changed_at end,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = entry.row_version + 1
     where entry.id = entry_row.id;
    perform set_config('hid.ed_board_closing', '', true);
    update ehr.ed_attendances attendance
       set presenting_complaint = case when coalesce(requested_set_complaint, false) then complaint_value
                                       else attendance.presenting_complaint end,
           triaged_at = now_value, triaged_by_membership_id = caller.actor_membership,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = attendance.row_version + 1
     where attendance.id = current_row.id;
    insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_stage, to_stage, triage_level, complaint_changed, idempotency_key, request_sha256)
    values (current_row.id, caller.actor_facility, current_row.patient_id, 'triaged', now_value, caller.actor_account,
      caller.actor_membership, entry_row.stage, stage_after, requested_triage_level,
      coalesce(requested_set_complaint, false)
        and complaint_value is distinct from current_row.presenting_complaint,
      requested_idempotency_key, requested_request_sha256);
    perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.triage', 'success', 'ed-attendance', current_row.id::text,
        jsonb_build_object('triageLevel', requested_triage_level, 'fromStage', entry_row.stage, 'stage', stage_after, 'complaintChanged', coalesce(requested_set_complaint, false) and complaint_value is distinct from current_row.presenting_complaint));
    return query select 'updated', false, card.* from ehr.ed_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
  end
  $fn$;
  comment on function ehr.ed_triage(uuid, bigint, smallint, text, boolean, text, text) is
    '0168 (ED-1): triage an open ED record: the triage level (1-5, 0135''s scale) on the waiting-list row, which moves from waiting or triage to ready, and optionally the presenting complaint (1-120; null clears). Triage again is allowed; every change is kept in the history (never the complaint text). Needs ehr.ed.triage. Outcomes updated (replayed for the same Idempotency-Key and body), not_found, closed, decided, changed, key_reused. Audited (ehr.ed.triage).';
  revoke all on function ehr.ed_triage(uuid, bigint, smallint, text, boolean, text, text) from public;

  -- Route 5: the stage and who is seeing the patient.
  create function ehr.ed_move(requested_attendance_id uuid, requested_row_version bigint, requested_stage text,
    requested_assigned_membership_id uuid, requested_clear_assignment boolean, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, attendance_id uuid, entry_id uuid, patient_id uuid, full_name text,
    record_kind text, unknown_label text, sex text, date_of_birth date, dob_estimated boolean, health_id_last4 text,
    chart_blocked boolean, arrival_basis text, arrival_mode text, arrived_at timestamptz, minutes_in_department integer,
    board_column text, stage text, triage_level smallint, triaged_at timestamptz, triaged_by_membership_id uuid,
    presenting_complaint text, complaint_hidden boolean, assigned_membership_id uuid, encounter_id uuid, status text,
    disposition_outcome text, decided_at timestamptz, decided_by_membership_id uuid, admit_to_department_code text,
    admitting_membership_id uuid, referred_to_facility_name text, left_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    current_row ehr.ed_attendances%rowtype;
    entry_row ehr.visit_queue%rowtype;
    refusal text;
    assignee_subject text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.ed_caller('ehr.ed.triage', array['direct-care']);
    if requested_attendance_id is null or requested_row_version is null or requested_row_version < 1
       or (requested_stage is not null and requested_stage not in ('waiting', 'triage', 'ready', 'with_clinician'))
       or (requested_assigned_membership_id is not null and coalesce(requested_clear_assignment, false)) then
      raise exception using errcode = '22023', message = 'ED_INVALID';
    end if;
    if requested_stage is null and requested_assigned_membership_id is null
       and not coalesce(requested_clear_assignment, false) then
      raise exception using errcode = '22023', message = 'ED_NOTHING_TO_CHANGE';
    end if;
    select * into key_state from ehr.ed_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.attendance_id = requested_attendance_id then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select attendance.patient_id from ehr.ed_attendances attendance where attendance.id = requested_attendance_id), 'ehr.ed.move', 'success', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('replayed', true));
      return query select 'updated', true, card.* from ehr.ed_cards(array[requested_attendance_id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
      return;
    end if;
    -- The ED record, then the waiting-list row, FOR UPDATE, always in that order.
    select attendance.* into current_row from ehr.ed_attendances attendance
     where attendance.id = requested_attendance_id and attendance.facility_id = caller.actor_facility
     for update;
    if not found then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        null, 'ehr.ed.move', 'failure', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('outcome', 'not_found'));
      outcome := 'not_found';
      replayed := false;
      return next;
      return;
    end if;
    select entry.* into entry_row from ehr.visit_queue entry where entry.id = current_row.visit_queue_entry_id
     for update;
    if key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif current_row.status = 'closed' then
      refusal := 'closed';
    end if;
    if refusal is null and current_row.status = 'decided' then
      refusal := 'decided';
    end if;
    if refusal is null and current_row.row_version <> requested_row_version then
      refusal := 'changed';
    end if;
    if refusal is null and requested_assigned_membership_id is not null then
      -- 0135's rule: an active nurse, clinician or doctor here (ehr.encounter.write and ehr.note.write).
      select account_row.subject into assignee_subject
        from identity.staff_facility_memberships membership
        join auth.accounts account_row on account_row.id = membership.account_id
       where membership.id = requested_assigned_membership_id and membership.facility_id = caller.actor_facility
         and membership.active and membership.migration_hold_reason is null;
      if assignee_subject is null
         or not auth.membership_has_permission(assignee_subject, requested_assigned_membership_id, caller.actor_facility,
                                               'ehr.encounter.write')
         or not auth.membership_has_permission(assignee_subject, requested_assigned_membership_id, caller.actor_facility,
                                               'ehr.note.write') then
        refusal := 'assignee_invalid';
      end if;
    end if;
    if refusal is not null then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.move', 'denied', 'ed-attendance', current_row.id::text,
        jsonb_build_object('refusal', refusal));
      outcome := refusal;
      replayed := false;
      return next;
      return;
    end if;

    perform set_config('hid.ed_board_closing', entry_row.id::text, true);
    update ehr.visit_queue entry
       set stage = coalesce(requested_stage, entry.stage),
           stage_changed_at = case when requested_stage is not null and requested_stage <> entry.stage then now_value
                                   else entry.stage_changed_at end,
           assigned_membership_id = case when coalesce(requested_clear_assignment, false) then null
                                         else coalesce(requested_assigned_membership_id, entry.assigned_membership_id) end,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = entry.row_version + 1
     where entry.id = entry_row.id;
    perform set_config('hid.ed_board_closing', '', true);
    update ehr.ed_attendances attendance
       set updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = attendance.row_version + 1
     where attendance.id = current_row.id;
    insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_stage, to_stage, assigned_membership_id, idempotency_key, request_sha256)
    values (current_row.id, caller.actor_facility, current_row.patient_id, 'moved', now_value, caller.actor_account,
      caller.actor_membership, entry_row.stage, coalesce(requested_stage, entry_row.stage),
      case when coalesce(requested_clear_assignment, false) then null
           else coalesce(requested_assigned_membership_id, entry_row.assigned_membership_id) end,
      requested_idempotency_key, requested_request_sha256);
    perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.move', 'success', 'ed-attendance', current_row.id::text,
        jsonb_build_object('fromStage', entry_row.stage, 'stage', coalesce(requested_stage, entry_row.stage), 'assigneeChanged', requested_assigned_membership_id is not null or coalesce(requested_clear_assignment, false)));
    return query select 'updated', false, card.* from ehr.ed_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
  end
  $fn$;
  comment on function ehr.ed_move(uuid, bigint, text, uuid, boolean, text, text) is
    '0168 (ED-1): move an open ED record''s waiting-list row between waiting, triage, ready and with_clinician, and set or clear who is seeing the patient (0135''s rule: an active nurse, clinician or doctor here). "Start care" sends with_clinician and the member''s own membership. Needs ehr.ed.triage. Outcomes updated (replayed), not_found, closed, decided, changed, assignee_invalid, key_reused. Audited (ehr.ed.move).';
  revoke all on function ehr.ed_move(uuid, bigint, text, uuid, boolean, text, text) from public;

  -- Route 6: link the visit (the usual emergency visit, opened under the usual chart access).
  create function ehr.ed_link_visit(requested_attendance_id uuid, requested_row_version bigint,
    requested_encounter_id uuid, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, attendance_id uuid, entry_id uuid, patient_id uuid, full_name text,
    record_kind text, unknown_label text, sex text, date_of_birth date, dob_estimated boolean, health_id_last4 text,
    chart_blocked boolean, arrival_basis text, arrival_mode text, arrived_at timestamptz, minutes_in_department integer,
    board_column text, stage text, triage_level smallint, triaged_at timestamptz, triaged_by_membership_id uuid,
    presenting_complaint text, complaint_hidden boolean, assigned_membership_id uuid, encounter_id uuid, status text,
    disposition_outcome text, decided_at timestamptz, decided_by_membership_id uuid, admit_to_department_code text,
    admitting_membership_id uuid, referred_to_facility_name text, left_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    current_row ehr.ed_attendances%rowtype;
    entry_row ehr.visit_queue%rowtype;
    refusal text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.ed_caller('ehr.ed.triage', array['direct-care']);
    if requested_attendance_id is null or requested_row_version is null or requested_row_version < 1
       or requested_encounter_id is null then
      raise exception using errcode = '22023', message = 'ED_INVALID';
    end if;
    select * into key_state from ehr.ed_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.attendance_id = requested_attendance_id then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select attendance.patient_id from ehr.ed_attendances attendance where attendance.id = requested_attendance_id), 'ehr.ed.link-visit', 'success', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('replayed', true));
      return query select 'updated', true, card.* from ehr.ed_cards(array[requested_attendance_id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
      return;
    end if;
    -- The ED record, then the waiting-list row, FOR UPDATE, always in that order.
    select attendance.* into current_row from ehr.ed_attendances attendance
     where attendance.id = requested_attendance_id and attendance.facility_id = caller.actor_facility
     for update;
    if not found then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        null, 'ehr.ed.link-visit', 'failure', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('outcome', 'not_found'));
      outcome := 'not_found';
      replayed := false;
      return next;
      return;
    end if;
    select entry.* into entry_row from ehr.visit_queue entry where entry.id = current_row.visit_queue_entry_id
     for update;
    if key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif current_row.status = 'closed' then
      refusal := 'closed';
    end if;
    if refusal is null and current_row.row_version <> requested_row_version then
      refusal := 'changed';
    end if;
    -- This patient's visit at this facility, not cancelled or entered in error, started no earlier than one hour
    -- before the arrival, or still open (planned, in progress or on hold, not imported from paper) and started on the
    -- arrival's Lagos day: EHR-C1's one open visit of the day, which the visit request reuses (a patient moved from
    -- the outpatient waiting list, or back in the department later the same day). Only these facts are read; no
    -- clinical content.
    if refusal is null
       and not exists (select 1 from ehr.encounters encounter
                        where encounter.id = requested_encounter_id and encounter.patient_id = current_row.patient_id
                          and encounter.facility_id = caller.actor_facility
                          and encounter.status not in ('cancelled', 'entered_in_error')
                          and (encounter.started_at >= current_row.arrived_at - interval '1 hour'
                               or (encounter.status in ('planned', 'in_progress', 'on_hold')
                                   and not encounter.imported_paper_records
                                   and (encounter.started_at at time zone 'Africa/Lagos')::date = current_row.arrival_day
                                   and encounter.started_at <= current_row.arrived_at))) then
      refusal := 'visit_invalid';
    end if;
    if refusal is not null then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.link-visit', 'denied', 'ed-attendance', current_row.id::text,
        jsonb_build_object('refusal', refusal));
      outcome := refusal;
      replayed := false;
      return next;
      return;
    end if;

    update ehr.visit_queue entry
       set updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = entry.row_version + 1
     where entry.id = entry_row.id;
    update ehr.ed_attendances attendance
       set encounter_id = requested_encounter_id,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = attendance.row_version + 1
     where attendance.id = current_row.id;
    insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, encounter_id, idempotency_key, request_sha256)
    values (current_row.id, caller.actor_facility, current_row.patient_id, 'visit_linked', now_value,
      caller.actor_account, caller.actor_membership, requested_encounter_id, requested_idempotency_key,
      requested_request_sha256);
    perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.link-visit', 'success', 'ed-attendance', current_row.id::text,
        jsonb_build_object('encounterId', requested_encounter_id, 'replacedVisit', current_row.encounter_id is not null and current_row.encounter_id <> requested_encounter_id));
    return query select 'updated', false, card.* from ehr.ed_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
  end
  $fn$;
  comment on function ehr.ed_link_visit(uuid, bigint, uuid, text, text) is
    '0168 (ED-1): link this patient''s visit at this facility (not cancelled or entered in error, started no earlier than one hour before the arrival, or still open and started earlier on the arrival''s Lagos day: EHR-C1''s open visit of the day) to an open or decided ED record; a linked visit can be replaced, and the change is kept in the history. Reads no clinical content and answers none. Needs ehr.ed.triage. Outcomes updated (replayed), not_found, closed, changed, visit_invalid (the same for every reason), key_reused. Audited (ehr.ed.link-visit).';
  revoke all on function ehr.ed_link_visit(uuid, bigint, uuid, text, text) from public;

  -- Route 7: where the patient goes next (Q-ED-5 A, Q-ED-6 A).
  create function ehr.ed_record_disposition(requested_attendance_id uuid, requested_row_version bigint,
    requested_outcome text, requested_admit_to_department_code text, requested_admitting_membership_id uuid,
    requested_referred_to_facility_name text, requested_reason text, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, attendance_id uuid, entry_id uuid, patient_id uuid, full_name text,
    record_kind text, unknown_label text, sex text, date_of_birth date, dob_estimated boolean, health_id_last4 text,
    chart_blocked boolean, arrival_basis text, arrival_mode text, arrived_at timestamptz, minutes_in_department integer,
    board_column text, stage text, triage_level smallint, triaged_at timestamptz, triaged_by_membership_id uuid,
    presenting_complaint text, complaint_hidden boolean, assigned_membership_id uuid, encounter_id uuid, status text,
    disposition_outcome text, decided_at timestamptz, decided_by_membership_id uuid, admit_to_department_code text,
    admitting_membership_id uuid, referred_to_facility_name text, left_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    current_row ehr.ed_attendances%rowtype;
    entry_row ehr.visit_queue%rowtype;
    refusal text;
    reason_value text := nullif(btrim(coalesce(requested_reason, '')), '');
    referral_value text := nullif(btrim(coalesce(requested_referred_to_facility_name, '')), '');
    profile_departments text[];
    admitting_subject text;
    changing boolean;
    closes boolean := requested_outcome in ('sent_to_outpatients', 'left_before_seen', 'left_against_advice', 'died');
    queue_stage text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.ed_caller('ehr.ed.disposition', array['direct-care']);
    if requested_attendance_id is null or requested_row_version is null or requested_row_version < 1
       or requested_outcome is null
       or requested_outcome not in ('discharged', 'admit_requested', 'referred_out', 'sent_to_outpatients',
                                    'left_before_seen', 'left_against_advice', 'died')
       or (requested_outcome <> 'admit_requested'
           and (requested_admit_to_department_code is not null or requested_admitting_membership_id is not null))
       or (requested_outcome <> 'referred_out' and requested_referred_to_facility_name is not null)
       or (requested_referred_to_facility_name is not null
           and (referral_value is null or length(referral_value) not between 2 and 120 or referral_value ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'ED_INVALID';
    end if;
    if requested_reason is not null
       and (reason_value is null or length(reason_value) not between 8 and 500 or reason_value ~ '[[:cntrl:]]') then
      raise exception using errcode = '22023', message = 'ED_REASON_REQUIRED';
    end if;
    select * into key_state from ehr.ed_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.attendance_id = requested_attendance_id then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select attendance.patient_id from ehr.ed_attendances attendance where attendance.id = requested_attendance_id), 'ehr.ed.disposition', 'success', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('replayed', true));
      return query select 'updated', true, card.* from ehr.ed_cards(array[requested_attendance_id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
      return;
    end if;
    -- The ED record, then the waiting-list row, FOR UPDATE, always in that order.
    select attendance.* into current_row from ehr.ed_attendances attendance
     where attendance.id = requested_attendance_id and attendance.facility_id = caller.actor_facility
     for update;
    if not found then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        null, 'ehr.ed.disposition', 'failure', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('outcome', 'not_found'));
      outcome := 'not_found';
      replayed := false;
      return next;
      return;
    end if;
    select entry.* into entry_row from ehr.visit_queue entry where entry.id = current_row.visit_queue_entry_id
     for update;
    if key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif current_row.status = 'closed' then
      refusal := 'closed';
    end if;
    changing := current_row.status = 'decided';
    if refusal is null and current_row.row_version <> requested_row_version then
      refusal := 'changed';
    end if;
    if refusal is null and changing and reason_value is null then
      refusal := 'reason_required';
    end if;
    if refusal is null and requested_outcome = 'admit_requested' then
      select profile.departments into profile_departments
        from identity.facility_profiles profile where profile.facility_id = caller.actor_facility
       order by profile.created_at desc nulls last limit 1;
      if requested_admit_to_department_code is null or requested_admit_to_department_code = 'emergency'
         or not identity.facility_departments_valid(array[requested_admit_to_department_code])
         or (profile_departments is not null and cardinality(profile_departments) > 0
             and not requested_admit_to_department_code = any (profile_departments)) then
        refusal := 'admit_department_invalid';
      end if;
    end if;
    if refusal is null and requested_admitting_membership_id is not null then
      -- An active clinician or doctor here: they hold ehr.ed.disposition and ehr.note.write.
      select account_row.subject into admitting_subject
        from identity.staff_facility_memberships membership
        join auth.accounts account_row on account_row.id = membership.account_id
       where membership.id = requested_admitting_membership_id and membership.facility_id = caller.actor_facility
         and membership.active and membership.migration_hold_reason is null;
      if admitting_subject is null
         or not auth.membership_has_permission(admitting_subject, requested_admitting_membership_id,
                                               caller.actor_facility, 'ehr.ed.disposition')
         or not auth.membership_has_permission(admitting_subject, requested_admitting_membership_id,
                                               caller.actor_facility, 'ehr.note.write') then
        refusal := 'admitting_invalid';
      end if;
    end if;
    if refusal is not null then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.disposition', 'denied', 'ed-attendance', current_row.id::text,
        jsonb_build_object('refusal', refusal));
      outcome := refusal;
      replayed := false;
      return next;
      return;
    end if;

    -- The waiting-list row: left before being seen or against advice: left; died: finished (both close it);
    -- sent to outpatients: back to waiting, still open, with its triage level and nobody down to see them (the ED
    -- clinician has handed over); otherwise unchanged.
    queue_stage := case requested_outcome when 'left_before_seen' then 'left' when 'left_against_advice' then 'left'
                                          when 'died' then 'finished' when 'sent_to_outpatients' then 'waiting' end;
    perform set_config('hid.ed_board_closing', entry_row.id::text, true);
    update ehr.visit_queue entry
       set stage = coalesce(queue_stage, entry.stage),
           stage_changed_at = case when queue_stage is not null and queue_stage <> entry.stage then now_value
                                   else entry.stage_changed_at end,
           closed_at = case when queue_stage in ('left', 'finished') then now_value else entry.closed_at end,
           assigned_membership_id = case when requested_outcome = 'sent_to_outpatients' then null
                                         else entry.assigned_membership_id end,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = entry.row_version + 1
     where entry.id = entry_row.id;
    perform set_config('hid.ed_board_closing', '', true);
    update ehr.ed_attendances attendance
       set status = case when closes then 'closed' else 'decided' end,
           disposition_outcome = requested_outcome,
           admit_to_department_code = case when requested_outcome = 'admit_requested'
                                           then requested_admit_to_department_code end,
           admitting_membership_id = case when requested_outcome = 'admit_requested'
                                          then requested_admitting_membership_id end,
           referred_to_facility_name = case when requested_outcome = 'referred_out' then referral_value end,
           decided_at = now_value, decided_by_membership_id = caller.actor_membership,
           left_at = case when closes then now_value end,
           closed_via = case when closes then 'disposition' end,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = attendance.row_version + 1
     where attendance.id = current_row.id;
    insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_stage, to_stage, outcome, reason, idempotency_key, request_sha256)
    values (current_row.id, caller.actor_facility, current_row.patient_id,
      case when changing then 'disposition_changed' else 'disposition' end, now_value, caller.actor_account,
      caller.actor_membership, entry_row.stage, coalesce(queue_stage, entry_row.stage), requested_outcome, reason_value,
      requested_idempotency_key, requested_request_sha256);
    perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.disposition', 'success', 'ed-attendance', current_row.id::text,
        jsonb_build_object('outcome', requested_outcome, 'changed', changing, 'previousOutcome', current_row.disposition_outcome, 'closed', closes, 'admitToDepartmentCode', case when requested_outcome = 'admit_requested' then requested_admit_to_department_code end));
    return query select 'updated', false, card.* from ehr.ed_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
  end
  $fn$;
  comment on function ehr.ed_record_disposition(uuid, bigint, text, text, uuid, text, text, text, text) is
    '0168 (ED-1, Q-ED-5 A, Q-ED-6 A): record where the patient goes next. discharged, admit_requested (a department of this facility other than emergency, optionally the admitting clinician or doctor) and referred_out (optionally the facility''s name) make the record decided (it stays in Disposition); left_before_seen and left_against_advice close it and the waiting-list row (left); died closes both (finished; no notice of any kind); sent_to_outpatients closes the ED record only and puts the waiting-list row back to waiting with nobody down to see the patient. From decided the decision can be changed with a reason (8-500). Never completes or changes the visit. Needs ehr.ed.disposition. Outcomes updated (replayed), not_found, closed, changed, reason_required, admit_department_invalid, admitting_invalid, key_reused. Audited (ehr.ed.disposition; never the referral name or the reason).';
  revoke all on function ehr.ed_record_disposition(uuid, bigint, text, text, uuid, text, text, text, text) from public;

  -- Route 8: "Left the department".
  create function ehr.ed_leave(requested_attendance_id uuid, requested_row_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, attendance_id uuid, entry_id uuid, patient_id uuid, full_name text,
    record_kind text, unknown_label text, sex text, date_of_birth date, dob_estimated boolean, health_id_last4 text,
    chart_blocked boolean, arrival_basis text, arrival_mode text, arrived_at timestamptz, minutes_in_department integer,
    board_column text, stage text, triage_level smallint, triaged_at timestamptz, triaged_by_membership_id uuid,
    presenting_complaint text, complaint_hidden boolean, assigned_membership_id uuid, encounter_id uuid, status text,
    disposition_outcome text, decided_at timestamptz, decided_by_membership_id uuid, admit_to_department_code text,
    admitting_membership_id uuid, referred_to_facility_name text, left_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    current_row ehr.ed_attendances%rowtype;
    entry_row ehr.visit_queue%rowtype;
    refusal text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.ed_caller('ehr.ed.triage', array['direct-care']);
    if requested_attendance_id is null or requested_row_version is null or requested_row_version < 1 then
      raise exception using errcode = '22023', message = 'ED_INVALID';
    end if;
    select * into key_state from ehr.ed_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.attendance_id = requested_attendance_id then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select attendance.patient_id from ehr.ed_attendances attendance where attendance.id = requested_attendance_id), 'ehr.ed.leave', 'success', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('replayed', true));
      return query select 'updated', true, card.* from ehr.ed_cards(array[requested_attendance_id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
      return;
    end if;
    -- The ED record, then the waiting-list row, FOR UPDATE, always in that order.
    select attendance.* into current_row from ehr.ed_attendances attendance
     where attendance.id = requested_attendance_id and attendance.facility_id = caller.actor_facility
     for update;
    if not found then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        null, 'ehr.ed.leave', 'failure', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('outcome', 'not_found'));
      outcome := 'not_found';
      replayed := false;
      return next;
      return;
    end if;
    select entry.* into entry_row from ehr.visit_queue entry where entry.id = current_row.visit_queue_entry_id
     for update;
    if key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif current_row.status = 'closed' then
      refusal := 'closed';
    end if;
    if refusal is null and current_row.status = 'open' then
      refusal := 'not_decided';
    end if;
    if refusal is null and current_row.row_version <> requested_row_version then
      refusal := 'changed';
    end if;
    if refusal is not null then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.leave', 'denied', 'ed-attendance', current_row.id::text,
        jsonb_build_object('refusal', refusal));
      outcome := refusal;
      replayed := false;
      return next;
      return;
    end if;

    perform set_config('hid.ed_board_closing', entry_row.id::text, true);
    update ehr.visit_queue entry
       set stage = 'finished', stage_changed_at = case when entry.stage <> 'finished' then now_value
                                                       else entry.stage_changed_at end,
           closed_at = now_value, updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = entry.row_version + 1
     where entry.id = entry_row.id;
    perform set_config('hid.ed_board_closing', '', true);
    update ehr.ed_attendances attendance
       set status = 'closed', left_at = now_value, closed_via = 'board',
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = attendance.row_version + 1
     where attendance.id = current_row.id;
    insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_stage, to_stage, idempotency_key, request_sha256)
    values (current_row.id, caller.actor_facility, current_row.patient_id, 'left', now_value, caller.actor_account,
      caller.actor_membership, entry_row.stage, 'finished', requested_idempotency_key, requested_request_sha256);
    perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.leave', 'success', 'ed-attendance', current_row.id::text,
        jsonb_build_object('outcome', current_row.disposition_outcome));
    return query select 'updated', false, card.* from ehr.ed_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
  end
  $fn$;
  comment on function ehr.ed_leave(uuid, bigint, text, text) is
    '0168 (ED-1, Q-ED-5 A): "Left the department" for a decided ED record (for an admission request, "Handed over to the ward"): closes it and its waiting-list row (finished). Needs ehr.ed.triage. Outcomes updated (replayed), not_found, closed, not_decided, changed, key_reused. Audited (ehr.ed.leave).';
  revoke all on function ehr.ed_leave(uuid, bigint, text, text) from public;

  -- Route 9: cancel an arrival made in error.
  create function ehr.ed_cancel(requested_attendance_id uuid, requested_row_version bigint, requested_reason text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, attendance_id uuid, entry_id uuid, patient_id uuid, full_name text,
    record_kind text, unknown_label text, sex text, date_of_birth date, dob_estimated boolean, health_id_last4 text,
    chart_blocked boolean, arrival_basis text, arrival_mode text, arrived_at timestamptz, minutes_in_department integer,
    board_column text, stage text, triage_level smallint, triaged_at timestamptz, triaged_by_membership_id uuid,
    presenting_complaint text, complaint_hidden boolean, assigned_membership_id uuid, encounter_id uuid, status text,
    disposition_outcome text, decided_at timestamptz, decided_by_membership_id uuid, admit_to_department_code text,
    admitting_membership_id uuid, referred_to_facility_name text, left_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    current_row ehr.ed_attendances%rowtype;
    entry_row ehr.visit_queue%rowtype;
    refusal text;
    reason_value text := nullif(btrim(coalesce(requested_reason, '')), '');
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.ed_caller('ehr.ed.arrive', array['direct-care']);
    if requested_attendance_id is null or requested_row_version is null or requested_row_version < 1 then
      raise exception using errcode = '22023', message = 'ED_INVALID';
    end if;
    if reason_value is null or length(reason_value) not between 8 and 500 or reason_value ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'ED_REASON_REQUIRED';
    end if;
    select * into key_state from ehr.ed_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.attendance_id = requested_attendance_id then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select attendance.patient_id from ehr.ed_attendances attendance where attendance.id = requested_attendance_id), 'ehr.ed.cancel', 'success', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('replayed', true));
      return query select 'updated', true, card.* from ehr.ed_cards(array[requested_attendance_id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
      return;
    end if;
    -- The ED record, then the waiting-list row, FOR UPDATE, always in that order.
    select attendance.* into current_row from ehr.ed_attendances attendance
     where attendance.id = requested_attendance_id and attendance.facility_id = caller.actor_facility
     for update;
    if not found then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        null, 'ehr.ed.cancel', 'failure', 'ed-attendance', requested_attendance_id::text,
        jsonb_build_object('outcome', 'not_found'));
      outcome := 'not_found';
      replayed := false;
      return next;
      return;
    end if;
    select entry.* into entry_row from ehr.visit_queue entry where entry.id = current_row.visit_queue_entry_id
     for update;
    if key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif current_row.status = 'closed' then
      refusal := 'closed';
    end if;
    if refusal is null and (current_row.status <> 'open' or current_row.encounter_id is not null) then
      refusal := 'cancel_not_allowed';
    end if;
    if refusal is null and current_row.row_version <> requested_row_version then
      refusal := 'changed';
    end if;
    if refusal is not null then
      perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.cancel', 'denied', 'ed-attendance', current_row.id::text,
        jsonb_build_object('refusal', refusal));
      outcome := refusal;
      replayed := false;
      return next;
      return;
    end if;

    -- The row the arrival made closes as cancelled; a row moved from the outpatient waiting list stays open and is
    -- put back as it was before the move (its stage, triage level, assignee and stage time), so nothing the
    -- mistaken arrival or the board wrote stays on another patient's outpatient row.
    perform set_config('hid.ed_board_closing', entry_row.id::text, true);
    if not current_row.moved_from_waiting_list then
      update ehr.visit_queue entry
         set stage = 'cancelled', stage_changed_at = now_value, closed_at = now_value,
             updated_by_membership_id = caller.actor_membership, updated_at = now_value,
             row_version = entry.row_version + 1
       where entry.id = entry_row.id;
    else
      update ehr.visit_queue entry
         set stage = current_row.moved_from_stage, triage_level = current_row.moved_from_triage_level,
             assigned_membership_id = current_row.moved_from_assigned_membership_id,
             stage_changed_at = current_row.moved_from_stage_changed_at,
             updated_by_membership_id = caller.actor_membership, updated_at = now_value,
             row_version = entry.row_version + 1
       where entry.id = entry_row.id;
    end if;
    perform set_config('hid.ed_board_closing', '', true);
    update ehr.ed_attendances attendance
       set status = 'closed', left_at = now_value, closed_via = 'cancel',
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = attendance.row_version + 1
     where attendance.id = current_row.id;
    insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_stage, to_stage, reason, idempotency_key, request_sha256)
    values (current_row.id, caller.actor_facility, current_row.patient_id, 'cancelled', now_value,
      caller.actor_account, caller.actor_membership, entry_row.stage,
      case when current_row.moved_from_waiting_list then current_row.moved_from_stage else 'cancelled' end, reason_value,
      requested_idempotency_key, requested_request_sha256);
    perform ehr.ed_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.ed.cancel', 'success', 'ed-attendance', current_row.id::text,
        jsonb_build_object('waitingListRowKept', current_row.moved_from_waiting_list));
    return query select 'updated', false, card.* from ehr.ed_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
        caller.actor_staff, caller.can_triage) card;
  end
  $fn$;
  comment on function ehr.ed_cancel(uuid, bigint, text, text, text) is
    '0168 (ED-1): cancel an arrival made in error: only an open ED record with no visit linked and no disposition, with a reason (8-500). The waiting-list row the arrival made closes as cancelled; a row moved from the outpatient waiting list stays open and is put back as it was before the move (stage, triage level, assignee). The record is kept. Needs ehr.ed.arrive. Outcomes updated (replayed), not_found, closed, cancel_not_allowed, changed, key_reused. Audited (ehr.ed.cancel; never the reason).';
  revoke all on function ehr.ed_cancel(uuid, bigint, text, text, text) from public;

  -- The waiting-list helper: the open or decided ED record of each given waiting-list row at this facility.
  create function ehr.visit_queue_ed_attendances(requested_entry_ids uuid[])
  returns table (entry_id uuid, attendance_id uuid)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor_subject text := platform.current_actor_subject();
    actor_membership uuid := platform.current_membership_id();
    actor_facility uuid := platform.current_facility_id();
  begin
    if actor_membership is null or actor_facility is null
       or not exists (select 1 from identity.staff_facility_memberships membership
                       where membership.id = actor_membership and membership.facility_id = actor_facility
                         and membership.account_id = auth.account_id_for_subject(actor_subject)
                         and membership.active and membership.migration_hold_reason is null)
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.read') then
      raise exception using errcode = '42501', message = 'VISIT_QUEUE_DENIED';
    end if;
    if coalesce(cardinality(requested_entry_ids), 0) > 500 then
      raise exception using errcode = '22023', message = 'VISIT_QUEUE_INVALID';
    end if;
    return query select attendance.visit_queue_entry_id, attendance.id
      from ehr.ed_attendances attendance
     where attendance.visit_queue_entry_id = any (coalesce(requested_entry_ids, array[]::uuid[]))
       and attendance.facility_id = actor_facility and attendance.status <> 'closed';
  end
  $fn$;
  comment on function ehr.visit_queue_ed_attendances(uuid[]) is
    '0168 (ED-1): for the waiting list''s cards, the open or decided ED record of each given waiting-list row at the session facility (at most 500 ids). The same caller rule as 0145''s ehr.visit_queue_record_kinds. Writes no audit row: the waiting list''s own ehr.visit-queue.list.shown rows cover each patient.';
  revoke all on function ehr.visit_queue_ed_attendances(uuid[]) from public;

  -- The mirror: a waiting-list row that closes (finished, left or cancelled, by 0135's update) closes its open or
  -- decided ED record, unless the close came from an ED function (its transaction-local marker names the row).
  create function ehr.visit_queue_ed_close_mirror()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    attendance_row ehr.ed_attendances%rowtype;
    actor_subject text := platform.current_actor_subject();
    actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
    actor_correlation text := platform.current_correlation_id();
    actor_organization uuid;
    now_value timestamptz := clock_timestamp();
  begin
    if new.closed_at is null or old.closed_at is not null
       or coalesce(current_setting('hid.ed_board_closing', true), '') = new.id::text then
      return null;
    end if;
    select attendance.* into attendance_row from ehr.ed_attendances attendance
     where attendance.visit_queue_entry_id = new.id and attendance.status <> 'closed'
     for update;
    if not found then
      return null;
    end if;
    update ehr.ed_attendances attendance
       set status = 'closed', left_at = new.closed_at, closed_via = 'waiting_list',
           updated_by_membership_id = new.updated_by_membership_id, updated_at = now_value,
           row_version = attendance.row_version + 1
     where attendance.id = attendance_row.id;
    insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_stage, to_stage)
    values (attendance_row.id, new.facility_id, new.patient_id, 'closed_on_waiting_list', now_value, actor_account,
      new.updated_by_membership_id, old.stage, new.stage);
    select membership.organization_id into actor_organization
      from identity.staff_facility_memberships membership
     where membership.id = new.updated_by_membership_id and membership.facility_id = new.facility_id
       and membership.account_id = actor_account;
    if actor_subject is not null and actor_account is not null and actor_organization is not null
       and actor_correlation is not null then
      -- The waiting-list action's own actor.
      insert into audit.events (
        correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
        organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, provenance, source_system, details
      ) values (
        actor_correlation, 'staff', actor_subject, actor_account, new.updated_by_membership_id, actor_organization,
        new.facility_id, new.patient_id, 'ehr.ed.closed-on-waiting-list', 'success', 'ed-attendance',
        attendance_row.id::text, platform.current_purpose_of_use(), 'application', 'ehr-api',
        jsonb_build_object('stage', new.stage, 'statusBefore', attendance_row.status,
          'visitQueueEntryId', new.id));
    else
      insert into audit.events (
        correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, provenance, source_system, details
      ) values (
        coalesce(actor_correlation, 'ed-close-mirror-' || attendance_row.id::text), 'system', new.facility_id,
        new.patient_id, 'ehr.ed.closed-on-waiting-list', 'success', 'ed-attendance', attendance_row.id::text,
        'healthcare-operations', 'system', 'ehr-api',
        jsonb_build_object('stage', new.stage, 'statusBefore', attendance_row.status, 'visitQueueEntryId', new.id));
    end if;
    return null;
  end
  $fn$;
  comment on function ehr.visit_queue_ed_close_mirror() is
    '0168 (ED-1): when a waiting-list row closes (finished, left or cancelled) other than by an ED function, its open or decided ED record closes too (closed_via waiting_list), with a closed_on_waiting_list event and one ehr.ed.closed-on-waiting-list audit row as the waiting-list action''s actor. No role may execute it.';
  revoke all on function ehr.visit_queue_ed_close_mirror() from public;
  create trigger visit_queue_ed_close_mirror
    after update of closed_at on ehr.visit_queue
    for each row when (old.closed_at is null and new.closed_at is not null)
    execute function ehr.visit_queue_ed_close_mirror();

  -- The guard: while a waiting-list row has an open or decided ED record, its stage, triage level, assignee and close
  -- belong to the board. Only the ED functions change them (their transaction-local marker names the row); 0135's
  -- ehr.visit_queue_update (the waiting list's next-step button and Change form) is refused for it, whoever calls it.
  -- The marker is hid.ed_board_closing (its name from when only the ED closes set it): every ED function's write to
  -- the row sets it, and so may a later file that closes an ED record itself (ADT-1's admission).
  -- So the ED record's row version covers every field the board writes, the triage on the board is the only triage
  -- (with its history and who did it), and the board's roles, reasons and cancel rule cannot be gone around on the
  -- waiting list. One exception: a row of a patient whose record is no longer active (0145's cancel of an unknown
  -- record makes the patient inactive, then cancels the row; the mirror then closes the ED record).
  create function ehr.visit_queue_ed_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if coalesce(current_setting('hid.ed_board_closing', true), '') = old.id::text then
      return new;
    end if;
    if not exists (select 1 from ehr.ed_attendances attendance
                    where attendance.visit_queue_entry_id = old.id and attendance.status <> 'closed') then
      return new;
    end if;
    if exists (select 1 from identity.patients patient where patient.id = old.patient_id and patient.status <> 'active') then
      return new;
    end if;
    raise exception using errcode = '55000', message = 'VISIT_QUEUE_ON_ED_BOARD';
  end
  $fn$;
  comment on function ehr.visit_queue_ed_guard() is
    '0168 (ED-1): refuses (55000 VISIT_QUEUE_ON_ED_BOARD) a change of the stage, triage level, assignee or close of a waiting-list row that has an open or decided ED record, unless it comes from an ED function (its transaction-local marker names the row) or the patient''s record is no longer active (0145''s cancel of an unknown record). No role may execute it.';
  revoke all on function ehr.visit_queue_ed_guard() from public;
  create trigger visit_queue_ed_guard
    before update of stage, triage_level, assigned_membership_id, closed_at on ehr.visit_queue
    for each row
    execute function ehr.visit_queue_ed_guard();

  -- The waiting list while the board is switched off (ED_BOARD_ENABLED off after use, the kill switch): ehr-api calls
  -- this instead of 0135's ehr.visit_queue_update only while the flag is off, so a board patient's row is not stuck.
  -- It runs 0135's update under the board's marker (so the guard lets it through and the mirror stays out), and when
  -- the row was updated it takes the patient off the board: the open or decided ED record closes as the mirror closes
  -- it (closed_via waiting_list, a closed_on_waiting_list event, one ehr.ed.closed-on-waiting-list audit row as the
  -- waiting-list action's actor, with boardOff true). For a change that leaves the row open (a stage, triage level or
  -- assignee) the record closes too: the waiting list owns the row from then on, so no later board save can overwrite
  -- it and no board triage is credited to the earlier nurse. Any other outcome (not_found, changed, closed,
  -- assignee_invalid) and any refusal 0135 raises leaves the ED record as it was. A row with no open or decided ED
  -- record is 0135's update exactly. Locks: the waiting-list row (0135's FOR UPDATE), then the ED record, as the mirror.
  -- While the flag is on ehr-api never calls it, and the guard refuses 0135's update for a board patient's row.
  create function ehr.visit_queue_ed_board_off_update(requested_entry_id uuid, requested_row_version bigint,
    requested_stage text, requested_triage_level smallint, requested_clear_triage boolean,
    requested_assigned_membership_id uuid, requested_clear_assignment boolean)
  returns table (outcome text, ord bigint, entry_id uuid, patient_id uuid, full_name text, sex text,
    date_of_birth date, health_id_last4 text, stage text, triage_level smallint, assigned_membership_id uuid,
    check_in_basis text, checked_in_at timestamptz, queue_day date, stage_changed_at timestamptz,
    closed_at timestamptz, row_version bigint, chart_blocked boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor_subject text := platform.current_actor_subject();
    actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
    actor_membership uuid := platform.current_membership_id();
    actor_facility uuid := platform.current_facility_id();
    actor_organization uuid;
    stage_before text;
    attendance_row ehr.ed_attendances%rowtype;
    answer record;
    now_value timestamptz;
  begin
    -- The stage before, read under the row lock 0135's update takes next (the same transaction already holds it).
    select entry.stage into stage_before from ehr.visit_queue entry
     where entry.id = requested_entry_id and entry.facility_id = actor_facility
     for update;
    perform set_config('hid.ed_board_closing', coalesce(requested_entry_id::text, ''), true);
    select updated.* into answer
      from ehr.visit_queue_update(requested_entry_id, requested_row_version, requested_stage, requested_triage_level,
             requested_clear_triage, requested_assigned_membership_id, requested_clear_assignment) updated;
    perform set_config('hid.ed_board_closing', '', true);
    if answer.outcome = 'updated' then
      select attendance.* into attendance_row from ehr.ed_attendances attendance
       where attendance.visit_queue_entry_id = requested_entry_id and attendance.facility_id = actor_facility
         and attendance.status <> 'closed'
       for update;
      if found then
        now_value := clock_timestamp();
        update ehr.ed_attendances attendance
           set status = 'closed', left_at = coalesce(answer.closed_at, now_value), closed_via = 'waiting_list',
               updated_by_membership_id = actor_membership, updated_at = now_value,
               row_version = attendance.row_version + 1
         where attendance.id = attendance_row.id;
        insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
          by_membership_id, from_stage, to_stage)
        values (attendance_row.id, attendance_row.facility_id, attendance_row.patient_id, 'closed_on_waiting_list',
          now_value, actor_account, actor_membership, stage_before, answer.stage);
        select membership.organization_id into actor_organization
          from identity.staff_facility_memberships membership
         where membership.id = actor_membership and membership.facility_id = actor_facility
           and membership.account_id = actor_account;
        perform ehr.ed_audit(actor_subject, actor_account, actor_membership, actor_organization, actor_facility,
          platform.current_correlation_id(), platform.current_purpose_of_use(), attendance_row.patient_id,
          'ehr.ed.closed-on-waiting-list', 'success', 'ed-attendance', attendance_row.id::text,
          jsonb_build_object('stage', answer.stage, 'statusBefore', attendance_row.status,
            'visitQueueEntryId', requested_entry_id, 'boardOff', true));
      end if;
    end if;
    return query select answer.outcome, answer.ord, answer.entry_id, answer.patient_id, answer.full_name, answer.sex,
      answer.date_of_birth, answer.health_id_last4, answer.stage, answer.triage_level, answer.assigned_membership_id,
      answer.check_in_basis, answer.checked_in_at, answer.queue_day, answer.stage_changed_at, answer.closed_at,
      answer.row_version, answer.chart_blocked;
  end
  $fn$;
  comment on function ehr.visit_queue_ed_board_off_update(uuid, bigint, text, smallint, boolean, uuid, boolean) is
    '0168 (ED-1): the waiting list''s update while ED_BOARD_ENABLED is off (ehr-api calls it only then): 0135''s ehr.visit_queue_update under the board''s marker, so a board patient''s row can be finished, cancelled, closed or changed; when the row is updated, its open or decided ED record closes (closed_via waiting_list) with a closed_on_waiting_list event and one ehr.ed.closed-on-waiting-list audit row (boardOff true) as the waiting-list action''s actor. Any other outcome leaves the ED record as it was. Same arguments, outcomes and answer as 0135''s update. EXECUTE for hid_ehr_runtime only.';
  revoke all on function ehr.visit_queue_ed_board_off_update(uuid, bigint, text, smallint, boolean, uuid, boolean)
    from public;

  -- Owners and EXECUTE (as 0135: the owner of identity.has_active_consent_grant).
  if v_owner <> current_user then
    execute format('alter table ehr.ed_attendances owner to %I', v_owner);
    execute format('alter table ehr.ed_attendance_events owner to %I', v_owner);
    execute (select string_agg(format('alter function %s owner to %I', proc.oid::regprocedure, v_owner), '; ')
               from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'ehr'
                and (proc.proname like 'ed\_%' or proc.proname like 'visit\_queue\_ed\_%'));
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function
      ehr.ed_arrive(text, uuid, text, timestamptz, smallint, text, text, text),
      ehr.ed_board(boolean),
      ehr.ed_read(uuid),
      ehr.ed_triage(uuid, bigint, smallint, text, boolean, text, text),
      ehr.ed_move(uuid, bigint, text, uuid, boolean, text, text),
      ehr.ed_link_visit(uuid, bigint, uuid, text, text),
      ehr.ed_record_disposition(uuid, bigint, text, text, uuid, text, text, text, text),
      ehr.ed_leave(uuid, bigint, text, text),
      ehr.ed_cancel(uuid, bigint, text, text, text),
      ehr.visit_queue_ed_attendances(uuid[]),
      ehr.visit_queue_ed_board_off_update(uuid, bigint, text, smallint, boolean, uuid, boolean)
      to hid_ehr_runtime;
  end if;

  -- 3. Post-checks.
  select pg_get_constraintdef(constraint_row.oid) into v_check_after from pg_constraint constraint_row
   where constraint_row.conrelid = 'ehr.visit_queue'::regclass
     and constraint_row.conname = 'visit_queue_check_in_basis_check';
  if v_check_after is distinct from (array[v_check_0135_ed, v_check_appt_ed])[1 + (v_check_found = v_check_appt)::integer] then
    raise exception using errcode = '55000', message = '0168: post-check failed (the waiting-list basis CHECK)';
  end if;
  if (select md5(coalesce(string_agg(to_jsonb(entry)::text, ',' order by entry.id), '')) from ehr.visit_queue entry)
     is distinct from v_queue_rows then
    raise exception using errcode = '55000', message = '0168: post-check failed (a waiting-list row changed)';
  end if;
  if exists (select 1 from pg_class class_row, lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
              where class_row.oid in ('ehr.ed_attendances'::regclass, 'ehr.ed_attendance_events'::regclass)
                and acl.grantee <> class_row.relowner)
     or (select count(*) from pg_class
          where oid in ('ehr.ed_attendances'::regclass, 'ehr.ed_attendance_events'::regclass)
            and relrowsecurity) <> 2 then
    raise exception using errcode = '55000',
      message = '0168: post-check failed (a table is granted to a role or lacks row-level security)';
  end if;
  if exists (select 1 from pg_proc proc
               join pg_namespace namespace on namespace.oid = proc.pronamespace,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where namespace.nspname = 'ehr'
                and (proc.proname like 'ed\_%' or proc.proname like 'visit\_queue\_ed\_%')
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                     or proc.proname in ('ed_cards', 'ed_caller', 'ed_audit', 'ed_idempotency',
                                         'ed_attendance_events_immutable', 'visit_queue_ed_close_mirror',
                                         'visit_queue_ed_guard')))
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr'
            and (proc.proname like 'ed\_%' or proc.proname like 'visit\_queue\_ed\_%') and proc.prosecdef
            and proc.proconfig = array['search_path=pg_catalog, pg_temp']) <> 13
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr'
            and (proc.proname like 'ed\_%' or proc.proname like 'visit\_queue\_ed\_%')) <> 18
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'ed\_%' or proc.proname like 'visit\_queue\_ed\_%')
                   and proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000', message = '0168: post-check failed (the functions'' security or grants)';
  end if;
  if (select count(*) from pg_trigger trigger_row
       where (trigger_row.tgrelid, trigger_row.tgname) in (('ehr.visit_queue'::regclass, 'visit_queue_ed_close_mirror'),
               ('ehr.visit_queue'::regclass, 'visit_queue_ed_guard'),
               ('ehr.ed_attendance_events'::regclass, 'ed_attendance_events_immutable'))
         and trigger_row.tgenabled = 'O') <> 3 then
    raise exception using errcode = '55000', message = '0168: post-check failed (the triggers)';
  end if;

  raise notice '0168: the emergency department board is installed (2 tables, 18 functions, the waiting-list guard and close mirror, the waiting list''s update while the board is off; basis emergency on the waiting list). Nobody can use it until 0169 gives the codes.';
end
$ed0168$;
