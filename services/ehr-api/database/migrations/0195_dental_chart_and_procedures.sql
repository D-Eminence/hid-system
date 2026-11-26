-- 0195 DEN-1 (Release D): the dental record and the draft dental lists.
-- Written on claude/sprint-dental-backend at a8126e33 (staging-novu-ci-20261005
-- at 0cfddcc9: 0001-0153 applied) after 0194. The number is provisional (given
-- at merge). No migration number appears inside a function body, so
-- renumbering keeps every md5. The declaration in
-- config/production-schema-compatibility.json stays an unsigned draft until
-- the owner signs this file.
--
-- Owner decisions (25 November 2026; docs/EHR_PLANNED_CONTRACT.md, DEN-1):
-- Q254 A (D2 A, a structured FDI tooth chart plus coded procedures), Q255 A
-- (D3 A, a Health ID dental procedure list signed by a dentist; no ADA CDT;
-- "by name only" as the fallback), Q256 A (D4 A, an ordinary outpatient visit
-- with the chart and procedures attached; the design's stages are derived),
-- Q257 A (no appointments; a follow-up date), Q124 A (every list ships as
-- draft data awaiting the clinical lead's sign-off), Q161 A (online only).
-- Built at the recommended option, not yet answered by the owner: Q-DEN-1 A
-- (only dentists hold the dental codes, 0194), Q-DEN-3 A (no patient-app
-- read of these tables), Q-DEN-4 A (only the signer marks a done procedure
-- entered in error), Q-DEN-5 A (procedures by name always allowed, marked),
-- Q-DEN-6 A (a local anaesthetic, or "none", is required on a done
-- procedure).
--
-- WHAT IT DOES (nothing else)
-- T1 ehr.dental_list_versions  one row per list version (kind
--      tooth_condition, procedure, anaesthetic or anaesthetic_technique;
--      label; draft or signed with when and the clinical lead's approval
--      reference, never a name; active; one active version per kind).
--      Seeded: four draft versions labelled HID-DENT-2026-11-DRAFT.
-- T2 ehr.dental_list_items  the draft lists (59 rows): 16 tooth conditions
--      (* takes surfaces: decayed*, filled*, fractured*, fissure sealant*,
--      missing, not yet erupted, impacted, retained root, for extraction,
--      crowned, root canal treated, mobile, bridge abutment, bridge pontic,
--      implant, replaced by a denture), 30 procedures DEN-nnn with category
--      and site (DEN-001-005 diagnostic, DEN-010-012 preventive, DEN-015-017
--      periodontal, DEN-020-024 restorative, DEN-030-032 endodontic,
--      DEN-040-046 surgical, DEN-050-053 prosthetic), 8 local anaesthetic
--      agents (none, lidocaine 2% with adrenaline 1:80,000, lidocaine 2%
--      plain, articaine 4% with adrenaline 1:100,000, mepivacaine 3% plain,
--      prilocaine 3% with felypressin, topical benzocaine 20% only, other)
--      and 5 techniques (infiltration, inferior alveolar nerve block,
--      palatal, intraligamentary, topical only). No ADA CDT code or text.
--      Draft until the clinical lead signs: a later signed file moves a
--      version from draft to signed (T1's guard allows exactly that and the
--      active switch), or loads a corrected list as a new version.
-- T3 ehr.dental_visits  one per outpatient visit (encounter_id unique): the
--      follow-up date (a Lagos calendar day) and recall note, who started
--      it, a row version.
-- T4 ehr.dental_chart_versions  one row per saved chart: version 1, 2, ...
--      per patient per facility (unique; counted under an advisory lock, no
--      sequence), the version it was based on (the newest at save time; null
--      for version 1 and after every earlier one was marked in error), the
--      dentition (permanent, primary, mixed), a note (1-1000 or none), the
--      tooth-condition list version used, who and when; and the one-way
--      entered-in-error mark (when, by whom, reason 8-500).
-- T5 ehr.dental_chart_findings  per version: the FDI tooth (a CHECK: 11-18,
--      21-28, 31-38, 41-48, 51-55, 61-65, 71-75, 81-85), the condition code,
--      the surfaces (none, or 1-5 of MODBL each once in that order), a note
--      (1-200 or none); one per tooth and condition; at most 200 per version
--      (checked by the save).
-- T6 ehr.dental_procedures  planned, done, cancelled or entered_in_error: a
--      listed procedure (the list version and code, the list's name copied)
--      or one by name (2-120 characters, by_name); the site (tooth,
--      tooth_surfaces, quadrant 1-4, arch upper or lower, whole_mouth) with
--      exactly its columns; the planned visit, time and member; the done
--      visit, time, performer and signature time; the local anaesthetic
--      (agent from the anaesthetic list, "other" named 2-120, technique from
--      the technique list, 0.5-10 cartridges in steps of 0.5; "none" with no
--      technique or amount), with the two list versions it was chosen from
--      (so the answer names them as signed; not in the contract's column
--      list, added for the foreign keys); notes; the cancel and
--      entered-in-error marks; a row version. CHECKs tie the site to its
--      columns, the status to its columns, and done to a signer, a time and
--      an anaesthetic (Q-DEN-6 A).
-- T7 ehr.dental_events  append-only, one row per write: the kind
--      (visit_started, follow_up_set, chart_saved, chart_entered_in_error,
--      procedure_planned, procedure_done, procedure_cancelled,
--      procedure_entered_in_error), the outcome of a start (started or
--      already_started), the record ids, the actor, when, and the
--      Idempotency-Key with the request's SHA-256 (unique per membership and
--      key). No sequence: ordered by time and id.
-- Row-level security: T3-T7 (the patient tables) have it enabled and forced,
--   with one owner-only policy each (0131's encounters_owner_read form,
--   pg_has_role(<the table's owner>, 'USAGE'), for every command; no runtime
--   role is a member of the owner). Stated exception: T1 and T2 hold no
--   patient data, so row-level security is not enabled on them (as 0149's
--   and 0152's lists). No runtime role has any privilege on any of the seven
--   tables: only the functions below read or write them, as their owner.
-- Guards (triggers; each fingerprinted in the post-checks), all with
--   0001's platform.reject_mutation() unless named:
--   every table: BEFORE DELETE (row) and BEFORE TRUNCATE (statement);
--   T2, T5, T7: BEFORE UPDATE OR DELETE (append-only; one trigger with the
--     delete);
--   T1: BEFORE UPDATE ehr.dental_list_versions_guard(): only draft to signed
--     (with when and the reference) and the active switch;
--   T4: BEFORE UPDATE ehr.dental_chart_versions_guard(): only the one-way
--     entered-in-error mark;
--   T6: BEFORE UPDATE ehr.dental_procedures_guard(): only planned to done
--     (the done columns; the surfaces of a tooth_surfaces procedure and the
--     notes may be refined), planned to cancelled, done to entered_in_error,
--     each raising the row version by one; a done row's clinical columns
--     never change;
--   T3: BEFORE UPDATE ehr.dental_visits_guard(): only the follow-up, the
--     update time and the row version (by one).
--   The four guard functions are not SECURITY DEFINER (they read nothing),
--   have the fixed search_path and no EXECUTE for any role.
-- F  SECURITY DEFINER functions, search_path pg_catalog, pg_temp, every
--   table, function and type name schema-qualified, no temporary table, no
--   sequence; owned by the owner of identity.has_active_consent_grant (as
--   0135's); EXECUTE for hid_ehr_runtime only (here when the role exists, and
--   in runtime-grants.sql):
--     ehr.dental_lists() (route 1);
--     ehr.dental_visit_start, ehr.dental_visit_read,
--     ehr.dental_visit_follow_up, ehr.dental_visits_list (routes 2-5);
--     ehr.dental_chart_read, ehr.dental_chart_save,
--     ehr.dental_chart_entered_in_error (routes 6-8);
--     ehr.dental_procedure_record, ehr.dental_procedure_done,
--     ehr.dental_procedure_cancel, ehr.dental_procedure_entered_in_error,
--     ehr.dental_procedures_list (routes 9-13);
--     ehr.dental_summary_read (route 14: the dental part of the print and its
--     audit row; ehr-api adds the visit's diagnoses and prescriptions with
--     its existing reads).
--   Helpers, SECURITY DEFINER too, with no EXECUTE for any role:
--     ehr.dental_caller(code): the caller check below;
--     ehr.dental_cards(kind, ids, facility): the answer's records as JSON
--     (the patient card, the visit with its derived stage, the chart with
--     its findings, a chart version's summary, the procedure), never a
--     Health ID beyond its last 4 characters.
--   Each function checks, in this order: an active membership, not held by
--   the cutover, at the session facility; the code (ehr.dental.read or
--   ehr.dental.write) through auth.membership_has_permission (md5 pinned);
--   purpose direct-care (these three raise: 42501 DENTAL_NOT_ALLOWED, 22023
--   DENTAL_DIRECT_CARE_ONLY); its input (22023 DENTAL_<kind>_INVALID); the
--   facility's seal (a sealed demo or QA facility reads only its own sealed
--   patients, as 0135); the patient's consent through
--   ehr.context_allows(patient, facility, 'read_records' | 'write_records')
--   (md5 pinned), the clinical tables' own rule; for a write, the
--   Idempotency-Key (a replay answers the record as it is now, replayed
--   true; another body key_reused); and the visit: this patient's at this
--   facility (else encounter_not_found), ambulatory and not cancelled or
--   entered_in_error (else visit_encounter_invalid), and open for routes 2,
--   7, 9 and 10 (planned, in_progress or on_hold; else visit_closed).
--   Writes take an advisory transaction lock (dental-chart:<facility>:
--   <patient> for chart saves and their entered-in-error mark;
--   dental-visit:<encounter> for a start) or FOR UPDATE on the procedure or
--   visit row, check the row version or the based-on version, and write one
--   ehr.dental_events row. Without 0194 no role holds a dental code, so every
--   function refuses.
-- A  Audit, in the request's transaction (as 0135): every answer, refusals
--   answered included, writes its row here (a refusal the function raises,
--   for the caller, the purpose or the input, is recorded by ehr-api's
--   request audit): ehr.dental.visit.start, .visit.read, .visit.follow-up,
--   .visit.list (plus .visit.list.shown per patient shown), .chart.read,
--   .chart.save, .chart.entered-in-error, .procedure.plan, .procedure.done,
--   .procedure.cancel, .procedure.entered-in-error, .procedure.list,
--   ehr.dental.summary.print. Rows hold ids, the outcome or refusal, version
--   numbers, statuses and counts; never a finding, surface, procedure code
--   or name, anaesthetic, note, reason, follow-up date or note, name, date
--   of birth or Health ID. Route 1 reads no patient and writes no row. This
--   file itself writes no audit row: it changes no existing row.
--
-- Locks (measured with pg_locks before commit; dental-migrations.integration.sql
-- compares them), taken first, NOWAIT: SHARE ROW EXCLUSIVE on
-- identity.patients, identity.facilities, identity.staff_facility_memberships,
-- auth.accounts and ehr.encounters (the foreign keys of new, empty tables);
-- ROW EXCLUSIVE on audit.events (the functions' bodies write it); ACCESS
-- SHARE on every table the new functions and the functions they call read:
-- identity.consent_grants, identity.consent_directives,
-- identity.consent_directive_versions, identity.purpose_of_use_codes,
-- identity.access_requests, identity.patient_consent_shares,
-- identity.sealed_demo_members, identity.sealed_qa_members, identity.staff,
-- identity.organizations, auth.permissions, auth.role_permissions,
-- auth.roles and auth.account_roles. A busy table fails the attempt at once,
-- and its subtransaction gives back what it took. The attempt is made 50
-- times, 100 ms apart (about 5 seconds), so the file never waits for one of
-- its locks while holding the others; then 55P03 (nothing applied). When
-- this transaction already holds an earlier migration's locks that stop
-- other sessions' reads or writes (the runner's dry run applies every
-- pending file in one transaction), one attempt and no sleep. Both refusals
-- begin "0195: " and end "run the release again at a quieter time", so the
-- runner's dry run rolls back and tries again (#306).
--
-- Old images on this schema: nothing calls the new functions. New images on
-- a schema without this file: the dental routes answer 503
-- DENTAL_NOT_AVAILABLE (42883/42P01).
--
-- Undo (by hand, only if the owner signs it): drop the 14 route functions,
-- the two helpers, the seven tables (events first) and the four guard
-- functions. Nothing outside the new objects changes.
--
-- The whole file is one statement (do $den0195$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks.
-- 1. Preconditions (55000, nothing applied): the marker of 0194 (the two
--    dental codes) and of 0135 (whose owner rule this file follows);
--    "0195: already applied" when every object of this file is there as it
--    leaves it, "0195: the schema is not in the reviewed state" for any half
--    state; the bodies this file calls md5-pinned; the columns it reads;
--    the owner of identity.has_active_consent_grant may read ehr.encounters
--    under its forced row-level security.
-- 2. T1-T7, the guards, F.
-- 3. Post-checks: tables, columns, constraints and indexes (md5 of their
--    definitions); row-level security enabled and forced on T3-T7, the
--    exact policies, not enabled on T1-T2; no privilege for any role but the
--    owner on any table; each function's owner, SECURITY DEFINER, fixed
--    search_path and body md5; EXECUTE exactly as listed; each trigger's
--    tgtype, tgqual, tgattr, tgnargs, tgfoid and tgenabled; the seeded rows
--    by count and md5; the patient tables empty.

do $den0195$
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
  v_owner name;
  v_found text;
  v_tables constant text[] := array['ehr.dental_list_versions', 'ehr.dental_list_items', 'ehr.dental_visits',
    'ehr.dental_chart_versions', 'ehr.dental_chart_findings', 'ehr.dental_procedures', 'ehr.dental_events'];
  v_patient_tables constant text[] := array['ehr.dental_visits', 'ehr.dental_chart_versions',
    'ehr.dental_chart_findings', 'ehr.dental_procedures', 'ehr.dental_events'];
  -- The route functions (EXECUTE for hid_ehr_runtime), then the helpers and the guards (no EXECUTE).
  v_routes constant text[] := array[
    'ehr.dental_lists()',
    'ehr.dental_visit_start(uuid,uuid,text,text)',
    'ehr.dental_visit_read(uuid,uuid)',
    'ehr.dental_visit_follow_up(uuid,uuid,bigint,boolean,date,boolean,text,text,text)',
    'ehr.dental_visits_list(integer)',
    'ehr.dental_chart_read(uuid,uuid)',
    'ehr.dental_chart_save(uuid,uuid,uuid,text,jsonb,text,text,text)',
    'ehr.dental_chart_entered_in_error(uuid,uuid,text,text,text)',
    'ehr.dental_procedure_record(uuid,uuid,text,text,text,text,smallint,text,smallint,text,timestamp with time zone,text,text,text,numeric,text,text,text)',
    'ehr.dental_procedure_done(uuid,uuid,uuid,bigint,timestamp with time zone,text,text,text,numeric,boolean,text,boolean,text,text,text)',
    'ehr.dental_procedure_cancel(uuid,uuid,bigint,text,text,text)',
    'ehr.dental_procedure_entered_in_error(uuid,uuid,bigint,text,text,text)',
    'ehr.dental_procedures_list(uuid,text)',
    'ehr.dental_summary_read(uuid,uuid)'];
  v_helpers constant text[] := array['ehr.dental_caller(text)', 'ehr.dental_cards(text,uuid[],uuid)'];
  v_guards constant text[] := array['ehr.dental_list_versions_guard()', 'ehr.dental_chart_versions_guard()',
    'ehr.dental_procedures_guard()', 'ehr.dental_visits_guard()'];
  -- Pinned fingerprints (post-checks). Each is the md5 of the catalog rows named, in a fixed order.
  v_columns_md5 constant text := '8742c178b1b3b1561ab95cd25d1dc451';
  v_constraints_md5 constant text := '8230da8539298135e7580b7a9d2eef65';
  v_indexes_md5 constant text := '32ec85fce15f302bafeeaf4666476ada';
  v_policies_md5 constant text := 'd322023095e3ab7c54251aceef6ee283';
  v_triggers_md5 constant text := '08e7a8db198dda33c42e352e1e162b05';
  v_functions_md5 constant text := 'de6ffc96b73327344079fc3ecd57f902';
  v_versions_md5 constant text := '4865519930c84172f933d6ef64fa78ae';
  v_items_md5 constant text := 'fb79314427c30c58fdb7c579e63f60ef';
  v_saved_path text := current_setting('search_path');
begin
  -- 0. The locks, NOWAIT.
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table identity.patients, identity.facilities, identity.staff_facility_memberships, auth.accounts,
    ehr.encounters in share row exclusive mode nowait;
  lock table audit.events in row exclusive mode nowait;
  lock table identity.consent_grants, identity.consent_directives, identity.consent_directive_versions,
    identity.purpose_of_use_codes, identity.access_requests, identity.patient_consent_shares,
    identity.sealed_demo_members, identity.sealed_qa_members, identity.staff, identity.organizations,
    auth.permissions, auth.role_permissions, auth.roles, auth.account_roles
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0195: identity.patients, identity.facilities, identity.staff_facility_memberships, auth.accounts, '
          || 'ehr.encounters, audit.events or a table 0195''s functions read (consent grants and directives, purposes, '
          || 'access requests, patient shares, the sealed members, staff, organizations and the role table) is busy, '
          || 'and this transaction already holds an earlier migration''s locks, so it does not wait; nothing applied; '
          || 'run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0195: identity.patients, identity.facilities, identity.staff_facility_memberships, auth.accounts, '
          || 'ehr.encounters, audit.events or a table 0195''s functions read (consent grants and directives, purposes, '
          || 'access requests, patient shares, the sealed members, staff, organizations and the role table) stayed '
          || 'busy for 5 seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- Markers of the files whose objects this file uses: 0194 (the two dental codes) and 0135 (its owner rule).
  if not exists (select 1 from auth.permissions where code = 'ehr.dental.read' and active)
     or not exists (select 1 from auth.permissions where code = 'ehr.dental.write' and active)
     or to_regclass('ehr.visit_queue') is null then
    raise exception using errcode = '55000', message = '0195: 0135 and 0194 must be applied first';
  end if;

  select count(*) into v_present
    from (select to_regclass(name)::oid from unnest(v_tables) name
          union all select to_regprocedure(name)::oid from unnest(v_routes || v_helpers || v_guards) name) present(object_id)
   where present.object_id is not null;
  if v_present = 27 then
    -- Exactly as this file leaves it: the same fingerprints the post-checks pin.
    if (select md5(string_agg(proc.proname || ':' || md5(proc.prosrc) || ':' || proc.prosecdef::text || ':'
                              || coalesce(proc.proconfig::text, ''), ',' order by proc.proname collate "C"))
          from pg_proc proc where proc.oid in (select to_regprocedure(name) from unnest(v_routes || v_helpers || v_guards) name))
        = v_functions_md5
       and (select count(*) from ehr.dental_list_items) = 59 then
      raise exception using errcode = '55000', message = '0195: already applied';
    end if;
  end if;
  if v_present <> 0
     or exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
                 where namespace.nspname = 'ehr' and relation.relname like 'dental\_%')
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr' and proc.proname like 'dental\_%') then
    raise exception using errcode = '55000',
      message = '0195: the schema is not in the reviewed state (part of 0195 is there); nothing applied';
  end if;

  -- The bodies this file calls, as 0001-0153 leave them.
  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)',
       '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0195: these bodies are not as 0001-0153 left them: ' || v_mismatch;
  end if;
  if to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_correlation_id()') is null
     or to_regprocedure('platform.current_purpose_of_use()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null then
    raise exception using errcode = '55000', message = '0195: a function this file calls is missing';
  end if;
  -- The columns this file reads, by name and type.
  select string_agg(wanted.relation || '.' || wanted.column_name, ', ' order by wanted.relation, wanted.column_name)
    into v_mismatch
    from (values
      ('ehr.encounters', 'id', 'uuid'), ('ehr.encounters', 'patient_id', 'uuid'),
      ('ehr.encounters', 'facility_id', 'uuid'), ('ehr.encounters', 'encounter_type', 'text'),
      ('ehr.encounters', 'status', 'text'), ('ehr.encounters', 'started_at', 'timestamp with time zone'),
      ('ehr.encounters', 'ended_at', 'timestamp with time zone'), ('ehr.encounters', 'chief_complaint', 'text'),
      ('identity.patients', 'id', 'uuid'), ('identity.patients', 'full_name', 'text'),
      ('identity.patients', 'gender', 'text'), ('identity.patients', 'dob', 'date'),
      ('identity.patients', 'hid_code', 'text'),
      ('identity.facilities', 'id', 'uuid'), ('identity.facilities', 'name', 'text'),
      ('identity.staff_facility_memberships', 'id', 'uuid'),
      ('identity.staff_facility_memberships', 'account_id', 'uuid'),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid'),
      ('identity.staff_facility_memberships', 'organization_id', 'uuid'),
      ('identity.staff_facility_memberships', 'staff_id', 'uuid'),
      ('identity.staff_facility_memberships', 'active', 'boolean'),
      ('identity.staff_facility_memberships', 'migration_hold_reason', 'text'),
      ('audit.events', 'details', 'jsonb')
    ) wanted(relation, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = wanted.relation::regclass
                        and attribute_row.attname = wanted.column_name and attribute_row.attnum > 0
                        and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0195: these columns are not as 0001-0153 left them: ' || v_mismatch;
  end if;
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  if not pg_has_role(v_owner, (select relation.relowner from pg_class relation
                                where relation.oid = 'ehr.encounters'::regclass), 'USAGE') then
    raise exception using errcode = '55000',
      message = '0195: the owner of 0135''s functions cannot read ehr.encounters under its forced row-level security';
  end if;

  -- 2. T1 the list versions.
  create table ehr.dental_list_versions (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('tooth_condition', 'procedure', 'anaesthetic', 'anaesthetic_technique')),
    version_label text not null check (version_label ~ '^HID-DENT-[0-9]{4}-[0-9]{2}(-[A-Z0-9]{1,20})?$'),
    status text not null default 'draft' check (status in ('draft', 'signed')),
    active boolean not null default false,
    signed_at timestamptz,
    sign_off_reference text check (sign_off_reference is null
      or (sign_off_reference = btrim(sign_off_reference) and length(sign_off_reference) between 3 and 200
          and sign_off_reference !~ '[[:cntrl:]]')),
    created_at timestamptz not null default clock_timestamp(),
    constraint dental_list_versions_signed_ck check (
      (status = 'signed') = (signed_at is not null) and (status = 'signed') = (sign_off_reference is not null)),
    constraint dental_list_versions_label_ux unique (kind, version_label),
    constraint dental_list_versions_kind_ux unique (id, kind)
  );
  create unique index dental_list_versions_active_ux on ehr.dental_list_versions (kind) where active;
  revoke all on ehr.dental_list_versions from public;
  comment on table ehr.dental_list_versions is
    '0195 (DEN-1, Q124 A): one row per dental list version (tooth conditions, procedures, local anaesthetic agents, techniques), draft until the clinical lead signs it (signed_at and the approval reference, never a name); one active version per kind. No patient data, so no row-level security (stated exception). Only the dental functions read it, as its owner.';

  -- T2 the list items.
  create table ehr.dental_list_items (
    version_id uuid not null,
    kind text not null,
    code text not null,
    label text not null check (label = btrim(label) and length(label) between 2 and 120 and label !~ '[[:cntrl:]]'),
    category text check (category is null or category in ('diagnostic', 'preventive', 'restorative', 'endodontic',
      'periodontal', 'surgical', 'prosthetic', 'other')),
    site text check (site is null or site in ('tooth', 'tooth_surfaces', 'quadrant', 'arch', 'whole_mouth')),
    takes_surfaces boolean,
    sort_order integer not null check (sort_order between 1 and 1000),
    constraint dental_list_items_pkey primary key (version_id, code),
    constraint dental_list_items_version_fk foreign key (version_id, kind)
      references ehr.dental_list_versions (id, kind) on delete restrict,
    constraint dental_list_items_code_ck check (
      (kind = 'procedure' and code ~ '^DEN-[0-9]{3}$') or (kind <> 'procedure' and code ~ '^[a-z][a-z0-9_]{1,39}$')),
    constraint dental_list_items_shape_ck check (
      (kind = 'procedure') = (category is not null) and (kind = 'procedure') = (site is not null)
      and (kind = 'tooth_condition') = (takes_surfaces is not null))
  );
  revoke all on ehr.dental_list_items from public;
  comment on table ehr.dental_list_items is
    '0195 (DEN-1, Q124 A, Q255 A): the items of each dental list version: code, label, and for procedures the category and site, for tooth conditions whether the condition takes surfaces. Draft until the clinical lead signs. No ADA CDT code or text. Append-only. No patient data, so no row-level security (stated exception).';

  insert into ehr.dental_list_versions (id, kind, version_label, status, active) values
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'HID-DENT-2026-11-DRAFT', 'draft', true),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'HID-DENT-2026-11-DRAFT', 'draft', true),
    ('de195000-0000-4000-8000-000000000003', 'anaesthetic', 'HID-DENT-2026-11-DRAFT', 'draft', true),
    ('de195000-0000-4000-8000-000000000004', 'anaesthetic_technique', 'HID-DENT-2026-11-DRAFT', 'draft', true);
  insert into ehr.dental_list_items (version_id, kind, code, label, takes_surfaces, sort_order) values
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'decayed', 'Decayed', true, 1),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'filled', 'Filled', true, 2),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'fractured', 'Fractured', true, 3),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'fissure_sealant', 'Fissure sealant', true, 4),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'missing', 'Missing', false, 5),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'unerupted', 'Not yet erupted', false, 6),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'impacted', 'Impacted', false, 7),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'retained_root', 'Retained root', false, 8),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'for_extraction', 'For extraction', false, 9),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'crowned', 'Crowned', false, 10),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'root_canal_treated', 'Root canal treated', false, 11),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'mobile', 'Mobile', false, 12),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'bridge_abutment', 'Bridge abutment', false, 13),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'bridge_pontic', 'Bridge pontic', false, 14),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'implant', 'Implant', false, 15),
    ('de195000-0000-4000-8000-000000000001', 'tooth_condition', 'denture_replaced', 'Replaced by a denture', false, 16);
  insert into ehr.dental_list_items (version_id, kind, code, label, category, site, sort_order) values
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-001', 'Oral examination', 'diagnostic', 'whole_mouth', 1),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-002', 'Periapical radiograph', 'diagnostic', 'tooth', 2),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-003', 'Bitewing radiographs', 'diagnostic', 'whole_mouth', 3),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-004', 'Panoramic radiograph (OPG)', 'diagnostic', 'whole_mouth', 4),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-005', 'Pulp vitality test', 'diagnostic', 'tooth', 5),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-010', 'Topical fluoride', 'preventive', 'whole_mouth', 6),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-011', 'Oral hygiene instruction', 'preventive', 'whole_mouth', 7),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-012', 'Fissure sealant', 'preventive', 'tooth_surfaces', 8),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-015', 'Scaling and polishing', 'periodontal', 'whole_mouth', 9),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-016', 'Root planing', 'periodontal', 'quadrant', 10),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-017', 'Splinting of mobile teeth', 'periodontal', 'quadrant', 11),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-020', 'Amalgam filling', 'restorative', 'tooth_surfaces', 12),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-021', 'Composite filling', 'restorative', 'tooth_surfaces', 13),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-022', 'Glass ionomer filling', 'restorative', 'tooth_surfaces', 14),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-023', 'Temporary filling', 'restorative', 'tooth_surfaces', 15),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-024', 'Atraumatic restorative treatment (ART)', 'restorative', 'tooth_surfaces', 16),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-030', 'Pulpotomy', 'endodontic', 'tooth', 17),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-031', 'Pulpectomy', 'endodontic', 'tooth', 18),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-032', 'Root canal treatment', 'endodontic', 'tooth', 19),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-040', 'Simple extraction', 'surgical', 'tooth', 20),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-041', 'Surgical extraction', 'surgical', 'tooth', 21),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-042', 'Removal of a retained root', 'surgical', 'tooth', 22),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-043', 'Dressing of a dry socket', 'surgical', 'tooth', 23),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-044', 'Control of bleeding after extraction', 'surgical', 'tooth', 24),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-045', 'Incision and drainage of a dental abscess', 'surgical', 'tooth', 25),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-046', 'Reimplantation of an avulsed tooth', 'surgical', 'tooth', 26),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-050', 'Crown', 'prosthetic', 'tooth', 27),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-051', 'Partial denture', 'prosthetic', 'arch', 28),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-052', 'Complete denture', 'prosthetic', 'arch', 29),
    ('de195000-0000-4000-8000-000000000002', 'procedure', 'DEN-053', 'Denture repair', 'prosthetic', 'arch', 30);
  insert into ehr.dental_list_items (version_id, kind, code, label, sort_order) values
    ('de195000-0000-4000-8000-000000000003', 'anaesthetic', 'none', 'No local anaesthetic', 1),
    ('de195000-0000-4000-8000-000000000003', 'anaesthetic', 'lidocaine_2_adrenaline', 'Lidocaine 2% with adrenaline 1:80,000', 2),
    ('de195000-0000-4000-8000-000000000003', 'anaesthetic', 'lidocaine_2_plain', 'Lidocaine 2% plain', 3),
    ('de195000-0000-4000-8000-000000000003', 'anaesthetic', 'articaine_4_adrenaline', 'Articaine 4% with adrenaline 1:100,000', 4),
    ('de195000-0000-4000-8000-000000000003', 'anaesthetic', 'mepivacaine_3_plain', 'Mepivacaine 3% plain', 5),
    ('de195000-0000-4000-8000-000000000003', 'anaesthetic', 'prilocaine_3_felypressin', 'Prilocaine 3% with felypressin', 6),
    ('de195000-0000-4000-8000-000000000003', 'anaesthetic', 'benzocaine_20_topical', 'Topical benzocaine 20% only', 7),
    ('de195000-0000-4000-8000-000000000003', 'anaesthetic', 'other', 'Other (named)', 8),
    ('de195000-0000-4000-8000-000000000004', 'anaesthetic_technique', 'infiltration', 'Infiltration', 1),
    ('de195000-0000-4000-8000-000000000004', 'anaesthetic_technique', 'inferior_alveolar_block', 'Inferior alveolar nerve block', 2),
    ('de195000-0000-4000-8000-000000000004', 'anaesthetic_technique', 'palatal', 'Palatal', 3),
    ('de195000-0000-4000-8000-000000000004', 'anaesthetic_technique', 'intraligamentary', 'Intraligamentary', 4),
    ('de195000-0000-4000-8000-000000000004', 'anaesthetic_technique', 'topical', 'Topical only', 5);

  -- T3 the dental visits.
  create table ehr.dental_visits (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references identity.patients (id) on delete restrict,
    facility_id uuid not null references identity.facilities (id) on delete restrict,
    encounter_id uuid not null,
    follow_up_on date,
    follow_up_note text check (follow_up_note is null
      or (follow_up_note = btrim(follow_up_note) and length(follow_up_note) between 1 and 500
          and follow_up_note !~ '[[:cntrl:]]')),
    started_by uuid not null references auth.accounts (id) on delete restrict,
    started_by_membership_id uuid not null references identity.staff_facility_memberships (id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    constraint dental_visits_encounter_ux unique (encounter_id),
    constraint dental_visits_record_ux unique (id, patient_id, facility_id, encounter_id),
    constraint dental_visits_encounter_fk foreign key (encounter_id, patient_id, facility_id)
      references ehr.encounters (id, patient_id, facility_id) on delete restrict
  );
  create index dental_visits_facility_idx on ehr.dental_visits (facility_id, created_at desc);
  create index dental_visits_patient_idx on ehr.dental_visits (patient_id, facility_id);
  alter table ehr.dental_visits enable row level security;
  alter table ehr.dental_visits force row level security;
  create policy dental_visits_owner on ehr.dental_visits for all
    using (pg_has_role((select relation.relowner from pg_class relation
                         where relation.oid = 'ehr.dental_visits'::regclass), 'USAGE'))
    with check (pg_has_role((select relation.relowner from pg_class relation
                              where relation.oid = 'ehr.dental_visits'::regclass), 'USAGE'));
  revoke all on ehr.dental_visits from public;
  comment on table ehr.dental_visits is
    '0195 (DEN-1, Q256 A, Q257 A): the dental record of one outpatient visit (one per encounter): the follow-up date (a Lagos day) and recall note, who started it. Row-level security forced, owner only; only the dental functions read and write it.';

  -- T4 the chart versions.
  create table ehr.dental_chart_versions (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references identity.patients (id) on delete restrict,
    facility_id uuid not null references identity.facilities (id) on delete restrict,
    encounter_id uuid not null,
    dental_visit_id uuid not null,
    version_no integer not null check (version_no > 0),
    based_on_version_id uuid references ehr.dental_chart_versions (id) on delete restrict,
    dentition text not null check (dentition in ('permanent', 'primary', 'mixed')),
    note text check (note is null
      or (note = btrim(note) and length(note) between 1 and 1000 and note !~ '[[:cntrl:]]')),
    list_version_id uuid not null,
    list_kind text not null default 'tooth_condition' check (list_kind = 'tooth_condition'),
    recorded_at timestamptz not null default clock_timestamp(),
    created_by uuid not null references auth.accounts (id) on delete restrict,
    created_by_membership_id uuid not null references identity.staff_facility_memberships (id) on delete restrict,
    entered_in_error_at timestamptz,
    entered_in_error_by_membership_id uuid references identity.staff_facility_memberships (id) on delete restrict,
    entered_in_error_reason text check (entered_in_error_reason is null
      or (entered_in_error_reason = btrim(entered_in_error_reason)
          and length(entered_in_error_reason) between 8 and 500 and entered_in_error_reason !~ '[[:cntrl:]]')),
    constraint dental_chart_versions_number_ux unique (patient_id, facility_id, version_no),
    constraint dental_chart_versions_visit_fk foreign key (dental_visit_id, patient_id, facility_id, encounter_id)
      references ehr.dental_visits (id, patient_id, facility_id, encounter_id) on delete restrict,
    constraint dental_chart_versions_encounter_fk foreign key (encounter_id, patient_id, facility_id)
      references ehr.encounters (id, patient_id, facility_id) on delete restrict,
    constraint dental_chart_versions_list_fk foreign key (list_version_id, list_kind)
      references ehr.dental_list_versions (id, kind) on delete restrict,
    constraint dental_chart_versions_first_ck check (version_no > 1 or based_on_version_id is null),
    constraint dental_chart_versions_error_ck check (
      (entered_in_error_at is null) = (entered_in_error_by_membership_id is null)
      and (entered_in_error_at is null) = (entered_in_error_reason is null))
  );
  create index dental_chart_versions_visit_idx on ehr.dental_chart_versions (dental_visit_id);
  create index dental_chart_versions_encounter_idx on ehr.dental_chart_versions (encounter_id);
  alter table ehr.dental_chart_versions enable row level security;
  alter table ehr.dental_chart_versions force row level security;
  create policy dental_chart_versions_owner on ehr.dental_chart_versions for all
    using (pg_has_role((select relation.relowner from pg_class relation
                         where relation.oid = 'ehr.dental_chart_versions'::regclass), 'USAGE'))
    with check (pg_has_role((select relation.relowner from pg_class relation
                              where relation.oid = 'ehr.dental_chart_versions'::regclass), 'USAGE'));
  revoke all on ehr.dental_chart_versions from public;
  comment on table ehr.dental_chart_versions is
    '0195 (DEN-1, Q254 A): one row per saved dental chart (FDI odontogram) of a patient at a facility, numbered 1, 2, ... (counted under an advisory lock; no sequence), based on the newest version at save time; a version is never edited, only marked entered in error (one way, with a reason). Row-level security forced, owner only.';

  -- T5 the findings.
  create table ehr.dental_chart_findings (
    chart_version_id uuid not null references ehr.dental_chart_versions (id) on delete restrict,
    tooth smallint not null check (
      (tooth / 10 between 1 and 4 and tooth % 10 between 1 and 8)
      or (tooth / 10 between 5 and 8 and tooth % 10 between 1 and 5)),
    condition_code text not null check (condition_code ~ '^[a-z][a-z0-9_]{1,39}$'),
    surfaces text check (surfaces is null or (surfaces <> '' and surfaces ~ '^M?O?D?B?L?$')),
    note text check (note is null or (note = btrim(note) and length(note) between 1 and 200 and note !~ '[[:cntrl:]]')),
    constraint dental_chart_findings_pkey primary key (chart_version_id, tooth, condition_code)
  );
  alter table ehr.dental_chart_findings enable row level security;
  alter table ehr.dental_chart_findings force row level security;
  create policy dental_chart_findings_owner on ehr.dental_chart_findings for all
    using (pg_has_role((select relation.relowner from pg_class relation
                         where relation.oid = 'ehr.dental_chart_findings'::regclass), 'USAGE'))
    with check (pg_has_role((select relation.relowner from pg_class relation
                              where relation.oid = 'ehr.dental_chart_findings'::regclass), 'USAGE'));
  revoke all on ehr.dental_chart_findings from public;
  comment on table ehr.dental_chart_findings is
    '0195 (DEN-1): the findings of one chart version: FDI tooth, a condition of the tooth-condition list, the surfaces (MODBL) for a condition that takes them, a short note. Append-only. Row-level security forced, owner only.';

  -- T6 the procedures.
  create table ehr.dental_procedures (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references identity.patients (id) on delete restrict,
    facility_id uuid not null references identity.facilities (id) on delete restrict,
    planned_encounter_id uuid,
    done_encounter_id uuid,
    list_version_id uuid,
    list_kind text check (list_kind is null or list_kind = 'procedure'),
    procedure_code text,
    procedure_name text not null check (procedure_name = btrim(procedure_name)
      and length(procedure_name) between 2 and 120 and procedure_name !~ '[[:cntrl:]]'),
    by_name boolean not null,
    site text not null check (site in ('tooth', 'tooth_surfaces', 'quadrant', 'arch', 'whole_mouth')),
    tooth smallint check (tooth is null
      or (tooth / 10 between 1 and 4 and tooth % 10 between 1 and 8)
      or (tooth / 10 between 5 and 8 and tooth % 10 between 1 and 5)),
    surfaces text check (surfaces is null or (surfaces <> '' and surfaces ~ '^M?O?D?B?L?$')),
    quadrant smallint check (quadrant is null or quadrant between 1 and 4),
    arch text check (arch is null or arch in ('upper', 'lower')),
    status text not null check (status in ('planned', 'done', 'cancelled', 'entered_in_error')),
    planned_at timestamptz,
    planned_by_membership_id uuid references identity.staff_facility_memberships (id) on delete restrict,
    done_at timestamptz,
    performed_by uuid references auth.accounts (id) on delete restrict,
    performed_by_membership_id uuid references identity.staff_facility_memberships (id) on delete restrict,
    signed_at timestamptz,
    anaesthetic_list_version_id uuid,
    anaesthetic_list_kind text check (anaesthetic_list_kind is null or anaesthetic_list_kind = 'anaesthetic'),
    anaesthetic_code text,
    anaesthetic_other text check (anaesthetic_other is null
      or (anaesthetic_other = btrim(anaesthetic_other) and length(anaesthetic_other) between 2 and 120
          and anaesthetic_other !~ '[[:cntrl:]]')),
    technique_list_version_id uuid,
    technique_list_kind text check (technique_list_kind is null or technique_list_kind = 'anaesthetic_technique'),
    anaesthetic_technique_code text,
    anaesthetic_cartridges numeric(3, 1) check (anaesthetic_cartridges is null
      or (anaesthetic_cartridges between 0.5 and 10 and anaesthetic_cartridges * 2 = trunc(anaesthetic_cartridges * 2))),
    notes text check (notes is null
      or (notes = btrim(notes) and length(notes) between 1 and 1000 and notes !~ '[[:cntrl:]]')),
    cancelled_at timestamptz,
    cancelled_by_membership_id uuid references identity.staff_facility_memberships (id) on delete restrict,
    cancel_reason text check (cancel_reason is null
      or (cancel_reason = btrim(cancel_reason) and length(cancel_reason) between 8 and 500
          and cancel_reason !~ '[[:cntrl:]]')),
    entered_in_error_at timestamptz,
    entered_in_error_by_membership_id uuid references identity.staff_facility_memberships (id) on delete restrict,
    entered_in_error_reason text check (entered_in_error_reason is null
      or (entered_in_error_reason = btrim(entered_in_error_reason)
          and length(entered_in_error_reason) between 8 and 500 and entered_in_error_reason !~ '[[:cntrl:]]')),
    row_version bigint not null default 1 check (row_version > 0),
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    constraint dental_procedures_planned_fk foreign key (planned_encounter_id, patient_id, facility_id)
      references ehr.encounters (id, patient_id, facility_id) on delete restrict,
    constraint dental_procedures_done_fk foreign key (done_encounter_id, patient_id, facility_id)
      references ehr.encounters (id, patient_id, facility_id) on delete restrict,
    constraint dental_procedures_list_fk foreign key (list_version_id, list_kind)
      references ehr.dental_list_versions (id, kind) on delete restrict,
    constraint dental_procedures_item_fk foreign key (list_version_id, procedure_code)
      references ehr.dental_list_items (version_id, code) on delete restrict,
    constraint dental_procedures_anaesthetic_fk foreign key (anaesthetic_list_version_id, anaesthetic_list_kind)
      references ehr.dental_list_versions (id, kind) on delete restrict,
    constraint dental_procedures_anaesthetic_item_fk foreign key (anaesthetic_list_version_id, anaesthetic_code)
      references ehr.dental_list_items (version_id, code) on delete restrict,
    constraint dental_procedures_technique_fk foreign key (technique_list_version_id, technique_list_kind)
      references ehr.dental_list_versions (id, kind) on delete restrict,
    constraint dental_procedures_technique_item_fk foreign key (technique_list_version_id, anaesthetic_technique_code)
      references ehr.dental_list_items (version_id, code) on delete restrict,
    -- A listed procedure names its list version and code; one by name (Q-DEN-5 A) neither.
    constraint dental_procedures_listed_ck check (
      by_name = (procedure_code is null) and by_name = (list_version_id is null)
      and (list_version_id is null) = (list_kind is null)),
    -- The site and exactly its columns.
    constraint dental_procedures_site_ck check (
      (site = 'tooth' and tooth is not null and surfaces is null and quadrant is null and arch is null)
      or (site = 'tooth_surfaces' and tooth is not null and surfaces is not null and quadrant is null and arch is null)
      or (site = 'quadrant' and tooth is null and surfaces is null and quadrant is not null and arch is null)
      or (site = 'arch' and tooth is null and surfaces is null and quadrant is null and arch is not null)
      or (site = 'whole_mouth' and tooth is null and surfaces is null and quadrant is null and arch is null)),
    -- Planned: when and by whom, exactly with the planned visit (a procedure recorded done directly has none).
    constraint dental_procedures_planned_ck check (
      (planned_encounter_id is null) = (planned_at is null)
      and (planned_encounter_id is null) = (planned_by_membership_id is null)
      and (status not in ('planned', 'cancelled') or planned_encounter_id is not null)),
    -- Done (and entered in error, which was done): the visit, the time, the signer and the anaesthetic (Q-DEN-6 A).
    constraint dental_procedures_done_ck check (
      (status in ('done', 'entered_in_error')) = (done_encounter_id is not null)
      and (done_encounter_id is null) = (done_at is null)
      and (done_encounter_id is null) = (performed_by is null)
      and (done_encounter_id is null) = (performed_by_membership_id is null)
      and (done_encounter_id is null) = (signed_at is null)
      and (done_encounter_id is null) = (anaesthetic_code is null)),
    -- The anaesthetic: none, with no technique or amount; an agent with a technique and an amount; other, named.
    constraint dental_procedures_anaesthetic_ck check (
      (anaesthetic_code is null) = (anaesthetic_list_version_id is null)
      and (anaesthetic_list_version_id is null) = (anaesthetic_list_kind is null)
      and (anaesthetic_technique_code is null) = (technique_list_version_id is null)
      and (technique_list_version_id is null) = (technique_list_kind is null)
      and ((anaesthetic_code is null and anaesthetic_technique_code is null and anaesthetic_cartridges is null
            and anaesthetic_other is null)
           or (anaesthetic_code = 'none' and anaesthetic_technique_code is null and anaesthetic_cartridges is null
               and anaesthetic_other is null)
           or (anaesthetic_code <> 'none' and anaesthetic_technique_code is not null
               and anaesthetic_cartridges is not null
               and (anaesthetic_code = 'other') = (anaesthetic_other is not null)))),
    constraint dental_procedures_cancel_ck check (
      (status = 'cancelled') = (cancelled_at is not null)
      and (cancelled_at is null) = (cancelled_by_membership_id is null)
      and (cancelled_at is null) = (cancel_reason is null)),
    constraint dental_procedures_error_ck check (
      (status = 'entered_in_error') = (entered_in_error_at is not null)
      and (entered_in_error_at is null) = (entered_in_error_by_membership_id is null)
      and (entered_in_error_at is null) = (entered_in_error_reason is null))
  );
  create index dental_procedures_patient_idx on ehr.dental_procedures (patient_id, facility_id, status, created_at desc);
  create index dental_procedures_done_visit_idx on ehr.dental_procedures (done_encounter_id)
    where done_encounter_id is not null;
  create index dental_procedures_planned_visit_idx on ehr.dental_procedures (planned_encounter_id)
    where planned_encounter_id is not null;
  alter table ehr.dental_procedures enable row level security;
  alter table ehr.dental_procedures force row level security;
  create policy dental_procedures_owner on ehr.dental_procedures for all
    using (pg_has_role((select relation.relowner from pg_class relation
                         where relation.oid = 'ehr.dental_procedures'::regclass), 'USAGE'))
    with check (pg_has_role((select relation.relowner from pg_class relation
                              where relation.oid = 'ehr.dental_procedures'::regclass), 'USAGE'));
  revoke all on ehr.dental_procedures from public;
  comment on table ehr.dental_procedures is
    '0195 (DEN-1, Q254 A, Q255 A, Q-DEN-4 A, Q-DEN-5 A, Q-DEN-6 A): dental procedures of a patient at a facility: planned (the treatment plan), done (signed by the dentist who recorded it: an explicit attestation, no cryptographic claim; with the local anaesthetic), cancelled with a reason, or a done one marked entered in error by its signer with a reason. A done row''s clinical columns never change. Row-level security forced, owner only.';

  -- T7 the events.
  create table ehr.dental_events (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('visit_started', 'follow_up_set', 'chart_saved', 'chart_entered_in_error',
      'procedure_planned', 'procedure_done', 'procedure_cancelled', 'procedure_entered_in_error')),
    outcome text check (outcome is null or outcome in ('started', 'already_started')),
    patient_id uuid not null references identity.patients (id) on delete restrict,
    facility_id uuid not null references identity.facilities (id) on delete restrict,
    encounter_id uuid,
    dental_visit_id uuid references ehr.dental_visits (id) on delete restrict,
    chart_version_id uuid references ehr.dental_chart_versions (id) on delete restrict,
    procedure_id uuid references ehr.dental_procedures (id) on delete restrict,
    by_account_id uuid not null references auth.accounts (id) on delete restrict,
    by_membership_id uuid not null references identity.staff_facility_memberships (id) on delete restrict,
    at timestamptz not null default clock_timestamp(),
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    constraint dental_events_key_ux unique (by_membership_id, idempotency_key),
    constraint dental_events_shape_ck check (
      (kind = 'visit_started') = (outcome is not null)
      and (kind not in ('visit_started', 'follow_up_set') or dental_visit_id is not null)
      and (kind not in ('chart_saved', 'chart_entered_in_error') or chart_version_id is not null)
      and (kind not like 'procedure\_%' or procedure_id is not null))
  );
  create index dental_events_patient_idx on ehr.dental_events (patient_id, at);
  alter table ehr.dental_events enable row level security;
  alter table ehr.dental_events force row level security;
  create policy dental_events_owner on ehr.dental_events for all
    using (pg_has_role((select relation.relowner from pg_class relation
                         where relation.oid = 'ehr.dental_events'::regclass), 'USAGE'))
    with check (pg_has_role((select relation.relowner from pg_class relation
                              where relation.oid = 'ehr.dental_events'::regclass), 'USAGE'));
  revoke all on ehr.dental_events from public;
  comment on table ehr.dental_events is
    '0195 (DEN-1): one row per dental write (visit start, follow-up, chart save and its entered-in-error mark, procedure planned, done, cancelled, entered in error), with the actor, the record ids and the Idempotency-Key with the request''s SHA-256 (unique per membership and key). Never a finding, code, name, note or reason. Append-only. Row-level security forced, owner only.';

  -- The guards.
  create function ehr.dental_list_versions_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if (to_jsonb(new) - array['status', 'signed_at', 'sign_off_reference', 'active'])
         is distinct from (to_jsonb(old) - array['status', 'signed_at', 'sign_off_reference', 'active'])
       or (old.status = 'signed'
           and (new.status, new.signed_at, new.sign_off_reference)
               is distinct from (old.status, old.signed_at, old.sign_off_reference)) then
      raise exception using errcode = '55000', message = 'DENTAL_LIST_VERSION_FIXED';
    end if;
    return new;
  end
  $fn$;
  create function ehr.dental_chart_versions_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if old.entered_in_error_at is not null or new.entered_in_error_at is null
       or (to_jsonb(new) - array['entered_in_error_at', 'entered_in_error_by_membership_id', 'entered_in_error_reason'])
          is distinct from
          (to_jsonb(old) - array['entered_in_error_at', 'entered_in_error_by_membership_id', 'entered_in_error_reason']) then
      raise exception using errcode = '55000', message = 'DENTAL_CHART_VERSION_FIXED';
    end if;
    return new;
  end
  $fn$;
  create function ehr.dental_visits_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if new.row_version is distinct from old.row_version + 1
       or (to_jsonb(new) - array['follow_up_on', 'follow_up_note', 'updated_at', 'row_version'])
          is distinct from (to_jsonb(old) - array['follow_up_on', 'follow_up_note', 'updated_at', 'row_version']) then
      raise exception using errcode = '55000', message = 'DENTAL_VISIT_FIXED';
    end if;
    return new;
  end
  $fn$;
  create function ehr.dental_procedures_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    allowed text[] := array['status', 'updated_at', 'row_version'];
  begin
    if new.row_version is distinct from old.row_version + 1 then
      raise exception using errcode = '55000', message = 'DENTAL_PROCEDURE_FIXED';
    end if;
    if old.status = 'planned' and new.status = 'done' then
      allowed := allowed || array['done_encounter_id', 'done_at', 'performed_by', 'performed_by_membership_id',
        'signed_at', 'anaesthetic_list_version_id', 'anaesthetic_list_kind', 'anaesthetic_code', 'anaesthetic_other',
        'technique_list_version_id', 'technique_list_kind', 'anaesthetic_technique_code', 'anaesthetic_cartridges',
        'notes', 'surfaces'];
      if new.surfaces is distinct from old.surfaces and old.site <> 'tooth_surfaces' then
        raise exception using errcode = '55000', message = 'DENTAL_PROCEDURE_FIXED';
      end if;
    elsif old.status = 'planned' and new.status = 'cancelled' then
      allowed := allowed || array['cancelled_at', 'cancelled_by_membership_id', 'cancel_reason'];
    elsif old.status = 'done' and new.status = 'entered_in_error' then
      allowed := allowed || array['entered_in_error_at', 'entered_in_error_by_membership_id', 'entered_in_error_reason'];
    else
      raise exception using errcode = '55000', message = 'DENTAL_PROCEDURE_FIXED';
    end if;
    if (to_jsonb(new) - allowed) is distinct from (to_jsonb(old) - allowed) then
      raise exception using errcode = '55000', message = 'DENTAL_PROCEDURE_FIXED';
    end if;
    return new;
  end
  $fn$;
  revoke all on function ehr.dental_list_versions_guard(), ehr.dental_chart_versions_guard(),
    ehr.dental_visits_guard(), ehr.dental_procedures_guard() from public;

  create trigger dental_list_versions_no_delete before delete on ehr.dental_list_versions
    for each row execute function platform.reject_mutation();
  create trigger dental_list_versions_no_truncate before truncate on ehr.dental_list_versions
    for each statement execute function platform.reject_mutation();
  create trigger dental_list_versions_guard before update on ehr.dental_list_versions
    for each row execute function ehr.dental_list_versions_guard();
  create trigger dental_list_items_append_only before update or delete on ehr.dental_list_items
    for each row execute function platform.reject_mutation();
  create trigger dental_list_items_no_truncate before truncate on ehr.dental_list_items
    for each statement execute function platform.reject_mutation();
  create trigger dental_visits_no_delete before delete on ehr.dental_visits
    for each row execute function platform.reject_mutation();
  create trigger dental_visits_no_truncate before truncate on ehr.dental_visits
    for each statement execute function platform.reject_mutation();
  create trigger dental_visits_guard before update on ehr.dental_visits
    for each row execute function ehr.dental_visits_guard();
  create trigger dental_chart_versions_no_delete before delete on ehr.dental_chart_versions
    for each row execute function platform.reject_mutation();
  create trigger dental_chart_versions_no_truncate before truncate on ehr.dental_chart_versions
    for each statement execute function platform.reject_mutation();
  create trigger dental_chart_versions_guard before update on ehr.dental_chart_versions
    for each row execute function ehr.dental_chart_versions_guard();
  create trigger dental_chart_findings_append_only before update or delete on ehr.dental_chart_findings
    for each row execute function platform.reject_mutation();
  create trigger dental_chart_findings_no_truncate before truncate on ehr.dental_chart_findings
    for each statement execute function platform.reject_mutation();
  create trigger dental_procedures_no_delete before delete on ehr.dental_procedures
    for each row execute function platform.reject_mutation();
  create trigger dental_procedures_no_truncate before truncate on ehr.dental_procedures
    for each statement execute function platform.reject_mutation();
  create trigger dental_procedures_guard before update on ehr.dental_procedures
    for each row execute function ehr.dental_procedures_guard();
  create trigger dental_events_append_only before update or delete on ehr.dental_events
    for each row execute function platform.reject_mutation();
  create trigger dental_events_no_truncate before truncate on ehr.dental_events
    for each statement execute function platform.reject_mutation();

  -- F. The helpers (no role may execute them; the route functions run them as their owner).
  -- The caller: an active membership at the session facility, not held by the cutover; the code; direct care.
  create function ehr.dental_caller(required_code text)
  returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
    actor_organization uuid, actor_staff uuid, actor_correlation text, actor_purpose text)
  language plpgsql
  stable
  security definer
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
    if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
       or required_code is null or required_code not in ('ehr.dental.read', 'ehr.dental.write') then
      raise exception using errcode = '42501', message = 'DENTAL_NOT_ALLOWED';
    end if;
    select membership.organization_id, membership.staff_id into actor_organization, actor_staff
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null;
    if not found
       or not coalesce(auth.membership_has_permission(actor_subject, actor_membership, actor_facility, required_code),
                       false) then
      raise exception using errcode = '42501', message = 'DENTAL_NOT_ALLOWED';
    end if;
    if actor_purpose is distinct from 'direct-care' then
      raise exception using errcode = '22023', message = 'DENTAL_DIRECT_CARE_ONLY';
    end if;
    return next;
  end
  $fn$;
  comment on function ehr.dental_caller(text) is
    '0195 (DEN-1): the dental functions'' caller check: an active membership at the session facility not held by the cutover, the code (ehr.dental.read or ehr.dental.write) through auth.membership_has_permission, and purpose direct-care; else 42501 DENTAL_NOT_ALLOWED or 22023 DENTAL_DIRECT_CARE_ONLY. No role may execute it.';

  -- The answer's records as JSON, in the given order, only at the viewer's facility: kind patient (the card: id,
  -- name, sex, date of birth, the last 4 characters of the Health ID), visit (with its derived stage), chart (with its
  -- findings), version (a chart version's summary) or procedure. Times in UTC with milliseconds.
  create function ehr.dental_cards(requested_kind text, requested_ids uuid[], viewer_facility uuid)
  returns table (ord bigint, id uuid, card jsonb)
  language sql
  stable
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ordering.ord_position, patient.id,
           jsonb_build_object('patientId', patient.id, 'fullName', patient.full_name, 'sex', patient.gender,
             'dateOfBirth', patient.dob, 'healthIdLast4', right(patient.hid_code, 4))
      from unnest(requested_ids) with ordinality ordering(id, ord_position)
      join identity.patients patient on patient.id = ordering.id
     where requested_kind = 'patient'
    union all
    select ordering.ord_position, visit.id,
           jsonb_build_object('visitId', visit.id, 'patientId', visit.patient_id, 'encounterId', visit.encounter_id,
             'encounterStatus', encounter.status,
             'encounterStartedAt', to_char(encounter.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'startedAt', to_char(visit.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'startedByMembershipId', visit.started_by_membership_id,
             'stage', case
               when encounter.status = 'completed' then 'completed'
               when exists (select 1 from ehr.dental_procedures done_row
                             where done_row.done_encounter_id = visit.encounter_id
                               and done_row.facility_id = visit.facility_id and done_row.status = 'done') then 'treated'
               when exists (select 1 from ehr.dental_chart_versions chart_row
                             where chart_row.dental_visit_id = visit.id and chart_row.entered_in_error_at is null)
                 or exists (select 1 from ehr.dental_procedures planned_row
                             where planned_row.planned_encounter_id = visit.encounter_id
                               and planned_row.facility_id = visit.facility_id) then 'assessed'
               else 'started' end,
             'followUpOn', visit.follow_up_on, 'followUpNote', visit.follow_up_note, 'rowVersion', visit.row_version)
      from unnest(requested_ids) with ordinality ordering(id, ord_position)
      join ehr.dental_visits visit on visit.id = ordering.id and visit.facility_id = viewer_facility
      join ehr.encounters encounter on encounter.id = visit.encounter_id
     where requested_kind = 'visit'
    union all
    select ordering.ord_position, chart.id,
           jsonb_build_object('versionId', chart.id, 'versionNo', chart.version_no,
             'basedOnVersionId', chart.based_on_version_id, 'encounterId', chart.encounter_id,
             'dentition', chart.dentition,
             'recordedAt', to_char(chart.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'recordedByMembershipId', chart.created_by_membership_id,
             'listVersion', list_version.version_label, 'listStatus', list_version.status,
             'findings', coalesce((select jsonb_agg(jsonb_build_object('tooth', finding.tooth,
                                     'condition', finding.condition_code, 'surfaces', finding.surfaces,
                                     'note', finding.note)
                                     order by finding.tooth, finding.condition_code collate "C")
                                     from ehr.dental_chart_findings finding
                                    where finding.chart_version_id = chart.id), '[]'::jsonb),
             'note', chart.note,
             'enteredInError', case when chart.entered_in_error_at is null then null else jsonb_build_object(
               'at', to_char(chart.entered_in_error_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'byMembershipId', chart.entered_in_error_by_membership_id,
               'reason', chart.entered_in_error_reason) end)
      from unnest(requested_ids) with ordinality ordering(id, ord_position)
      join ehr.dental_chart_versions chart on chart.id = ordering.id and chart.facility_id = viewer_facility
      join ehr.dental_list_versions list_version on list_version.id = chart.list_version_id
     where requested_kind = 'chart'
    union all
    select ordering.ord_position, chart.id,
           jsonb_build_object('versionId', chart.id, 'versionNo', chart.version_no,
             'recordedAt', to_char(chart.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'recordedByMembershipId', chart.created_by_membership_id, 'encounterId', chart.encounter_id,
             'enteredInError', chart.entered_in_error_at is not null)
      from unnest(requested_ids) with ordinality ordering(id, ord_position)
      join ehr.dental_chart_versions chart on chart.id = ordering.id and chart.facility_id = viewer_facility
     where requested_kind = 'version'
    union all
    select ordering.ord_position, procedure_row.id,
           jsonb_build_object('procedureId', procedure_row.id, 'patientId', procedure_row.patient_id,
             'procedureCode', procedure_row.procedure_code, 'procedureName', procedure_row.procedure_name,
             'byName', procedure_row.by_name, 'listVersion', list_version.version_label,
             'listStatus', list_version.status, 'site', procedure_row.site, 'tooth', procedure_row.tooth,
             'surfaces', procedure_row.surfaces, 'quadrant', procedure_row.quadrant, 'arch', procedure_row.arch,
             'status', procedure_row.status, 'plannedEncounterId', procedure_row.planned_encounter_id,
             'plannedAt', to_char(procedure_row.planned_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'plannedByMembershipId', procedure_row.planned_by_membership_id,
             'doneEncounterId', procedure_row.done_encounter_id,
             'doneAt', to_char(procedure_row.done_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'performedByMembershipId', procedure_row.performed_by_membership_id,
             'signedAt', to_char(procedure_row.signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'anaesthetic', case when procedure_row.anaesthetic_code is null then null else jsonb_build_object(
               'agentCode', procedure_row.anaesthetic_code, 'agentName', agent.label,
               'agentOther', procedure_row.anaesthetic_other,
               'techniqueCode', procedure_row.anaesthetic_technique_code, 'techniqueName', technique.label,
               'cartridges', procedure_row.anaesthetic_cartridges) end,
             'notes', procedure_row.notes,
             'cancelled', case when procedure_row.cancelled_at is null then null else jsonb_build_object(
               'at', to_char(procedure_row.cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'byMembershipId', procedure_row.cancelled_by_membership_id,
               'reason', procedure_row.cancel_reason) end,
             'enteredInError', case when procedure_row.entered_in_error_at is null then null else jsonb_build_object(
               'at', to_char(procedure_row.entered_in_error_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'byMembershipId', procedure_row.entered_in_error_by_membership_id,
               'reason', procedure_row.entered_in_error_reason) end,
             'rowVersion', procedure_row.row_version)
      from unnest(requested_ids) with ordinality ordering(id, ord_position)
      join ehr.dental_procedures procedure_row on procedure_row.id = ordering.id
       and procedure_row.facility_id = viewer_facility
      left join ehr.dental_list_versions list_version on list_version.id = procedure_row.list_version_id
      left join ehr.dental_list_items agent on agent.version_id = procedure_row.anaesthetic_list_version_id
       and agent.code = procedure_row.anaesthetic_code
      left join ehr.dental_list_items technique on technique.version_id = procedure_row.technique_list_version_id
       and technique.code = procedure_row.anaesthetic_technique_code
     where requested_kind = 'procedure'
    order by 1
  $fn$;
  comment on function ehr.dental_cards(text, uuid[], uuid) is
    '0195 (DEN-1): the dental answers'' records as JSON, in the given order, at the viewer''s facility: patient (id, name, sex, date of birth, the last 4 characters of the Health ID; never the Health ID), visit (with the derived stage started, assessed, treated or completed), chart (with its findings), version (a chart version''s summary) or procedure. No role may execute it.';

  -- Route 1: the active lists. No patient, no audit row.
  create function ehr.dental_lists()
  returns table (kind text, version_label text, status text, code text, label text, category text, site text,
    takes_surfaces boolean, sort_order integer)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    perform 1 from ehr.dental_caller('ehr.dental.read');
    return query
      select list_version.kind, list_version.version_label, list_version.status, item.code, item.label, item.category,
             item.site, item.takes_surfaces, item.sort_order
        from ehr.dental_list_versions list_version
        join ehr.dental_list_items item on item.version_id = list_version.id
       where list_version.active
       order by list_version.kind collate "C", item.sort_order, item.code collate "C";
  end
  $fn$;

  -- Route 2: start the dental record on this outpatient visit.
  create function ehr.dental_visit_start(requested_patient_id uuid, requested_encounter_id uuid,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, visit jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_encounter ehr.encounters%rowtype;
    v_event ehr.dental_events%rowtype;
    v_visit_id uuid;
    v_refusal text;
    v_outcome text;
    v_replayed boolean := false;
  begin
    select * into caller from ehr.dental_caller('ehr.dental.write');
    if requested_patient_id is null or requested_encounter_id is null then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'DENTAL_IDEMPOTENCY_KEY_INVALID';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'write_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      perform pg_advisory_xact_lock(hashtextextended('dental-key:' || caller.actor_membership::text || ':'
        || requested_idempotency_key, 0));
      select event.* into v_event from ehr.dental_events event
       where event.by_membership_id = caller.actor_membership and event.idempotency_key = requested_idempotency_key;
      if found then
        if v_event.request_sha256 <> requested_request_sha256 or v_event.kind <> 'visit_started' then
          v_refusal := 'key_reused';
          exit work;
        end if;
        v_replayed := true;
        v_outcome := v_event.outcome;
        v_visit_id := v_event.dental_visit_id;
        exit work;
      end if;
      select encounter.* into v_encounter from ehr.encounters encounter
       where encounter.id = requested_encounter_id and encounter.patient_id = requested_patient_id
         and encounter.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'encounter_not_found';
        exit work;
      end if;
      if v_encounter.encounter_type <> 'ambulatory' or v_encounter.status in ('cancelled', 'entered_in_error') then
        v_refusal := 'visit_encounter_invalid';
        exit work;
      end if;
      if v_encounter.status not in ('planned', 'in_progress', 'on_hold') then
        v_refusal := 'visit_closed';
        exit work;
      end if;
      perform pg_advisory_xact_lock(hashtextextended('dental-visit:' || requested_encounter_id::text, 0));
      select visit_row.id into v_visit_id from ehr.dental_visits visit_row
       where visit_row.encounter_id = requested_encounter_id;
      if found then
        v_outcome := 'already_started';
      else
        v_outcome := 'started';
        insert into ehr.dental_visits (patient_id, facility_id, encounter_id, started_by, started_by_membership_id)
        values (requested_patient_id, caller.actor_facility, requested_encounter_id, caller.actor_account,
                caller.actor_membership)
        returning id into v_visit_id;
      end if;
      insert into ehr.dental_events (kind, outcome, patient_id, facility_id, encounter_id, dental_visit_id,
        by_account_id, by_membership_id, idempotency_key, request_sha256)
      values ('visit_started', v_outcome, requested_patient_id, caller.actor_facility, requested_encounter_id,
        v_visit_id, caller.actor_account, caller.actor_membership, requested_idempotency_key,
        requested_request_sha256);
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.visit.start',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-visit', v_visit_id::text,
      caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('encounterId', requested_encounter_id, 'outcome', v_outcome,
        'refusal', v_refusal, 'replayed', v_replayed)));
    if v_refusal is not null then
      outcome := v_refusal;
      replayed := false;
      return next;
      return;
    end if;
    return query select v_outcome, v_replayed, card.card
      from ehr.dental_cards('visit', array[v_visit_id], caller.actor_facility) card;
  end
  $fn$;

  -- Route 3: the visit's dental record.
  create function ehr.dental_visit_read(requested_patient_id uuid, requested_encounter_id uuid)
  returns table (outcome text, visit jsonb, chart jsonb, chart_versions_this_visit jsonb, planned_procedures jsonb,
    done_this_visit jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_encounter ehr.encounters%rowtype;
    v_visit_id uuid;
    v_chart_id uuid;
    v_refusal text;
    v_versions uuid[];
    v_planned uuid[];
    v_done uuid[];
  begin
    select * into caller from ehr.dental_caller('ehr.dental.read');
    if requested_patient_id is null or requested_encounter_id is null then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'read_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      select encounter.* into v_encounter from ehr.encounters encounter
       where encounter.id = requested_encounter_id and encounter.patient_id = requested_patient_id
         and encounter.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'encounter_not_found';
        exit work;
      end if;
      if v_encounter.encounter_type <> 'ambulatory' or v_encounter.status in ('cancelled', 'entered_in_error') then
        v_refusal := 'visit_encounter_invalid';
        exit work;
      end if;
      select visit_row.id into v_visit_id from ehr.dental_visits visit_row
       where visit_row.encounter_id = requested_encounter_id and visit_row.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'visit_not_found';
        exit work;
      end if;
      select chart_row.id into v_chart_id from ehr.dental_chart_versions chart_row
       where chart_row.patient_id = requested_patient_id and chart_row.facility_id = caller.actor_facility
         and chart_row.entered_in_error_at is null
       order by chart_row.version_no desc limit 1;
      select coalesce(array_agg(chart_row.id order by chart_row.version_no desc), array[]::uuid[]) into v_versions
        from ehr.dental_chart_versions chart_row where chart_row.dental_visit_id = v_visit_id;
      select coalesce(array_agg(procedure_row.id order by procedure_row.planned_at, procedure_row.id), array[]::uuid[])
        into v_planned
        from ehr.dental_procedures procedure_row
       where procedure_row.patient_id = requested_patient_id and procedure_row.facility_id = caller.actor_facility
         and procedure_row.status = 'planned';
      select coalesce(array_agg(procedure_row.id order by procedure_row.done_at, procedure_row.id), array[]::uuid[])
        into v_done
        from ehr.dental_procedures procedure_row
       where procedure_row.done_encounter_id = requested_encounter_id
         and procedure_row.facility_id = caller.actor_facility
         and procedure_row.status in ('done', 'entered_in_error');
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.visit.read',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-visit', v_visit_id::text,
      caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('encounterId', requested_encounter_id, 'refusal', v_refusal,
        'chartVersionId', v_chart_id, 'chartVersionsThisVisit', cardinality(v_versions),
        'plannedCount', cardinality(v_planned), 'doneThisVisitCount', cardinality(v_done))));
    if v_refusal is not null then
      outcome := v_refusal;
      return next;
      return;
    end if;
    outcome := 'found';
    visit := (select card.card from ehr.dental_cards('visit', array[v_visit_id], caller.actor_facility) card);
    chart := (select card.card from ehr.dental_cards('chart', array[v_chart_id], caller.actor_facility) card);
    chart_versions_this_visit := (select coalesce(jsonb_agg(card.card order by card.ord), '[]'::jsonb)
                                    from ehr.dental_cards('version', v_versions, caller.actor_facility) card);
    planned_procedures := (select coalesce(jsonb_agg(card.card order by card.ord), '[]'::jsonb)
                             from ehr.dental_cards('procedure', v_planned, caller.actor_facility) card);
    done_this_visit := (select coalesce(jsonb_agg(card.card order by card.ord), '[]'::jsonb)
                          from ehr.dental_cards('procedure', v_done, caller.actor_facility) card);
    return next;
  end
  $fn$;

  -- Route 4: the follow-up date and recall note (also after the visit is completed).
  create function ehr.dental_visit_follow_up(requested_patient_id uuid, requested_encounter_id uuid,
    requested_row_version bigint, set_follow_up_on boolean, requested_follow_up_on date, set_follow_up_note boolean,
    requested_follow_up_note text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, visit jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_encounter ehr.encounters%rowtype;
    v_visit ehr.dental_visits%rowtype;
    v_event ehr.dental_events%rowtype;
    v_visit_id uuid;
    v_refusal text;
    v_replayed boolean := false;
    v_note text := nullif(btrim(coalesce(requested_follow_up_note, '')), '');
    v_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  begin
    select * into caller from ehr.dental_caller('ehr.dental.write');
    if requested_patient_id is null or requested_encounter_id is null or requested_row_version is null
       or requested_row_version < 1 or not (coalesce(set_follow_up_on, false) or coalesce(set_follow_up_note, false))
       or (not coalesce(set_follow_up_note, false) and requested_follow_up_note is not null)
       or (not coalesce(set_follow_up_on, false) and requested_follow_up_on is not null)
       or (v_note is not null and (length(v_note) > 500 or v_note ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    if coalesce(set_follow_up_on, false) and requested_follow_up_on is not null
       and (requested_follow_up_on <= v_today or requested_follow_up_on > (v_today + interval '2 years')::date) then
      raise exception using errcode = '22023', message = 'DENTAL_FOLLOW_UP_INVALID';
    end if;
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'DENTAL_IDEMPOTENCY_KEY_INVALID';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'write_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      perform pg_advisory_xact_lock(hashtextextended('dental-key:' || caller.actor_membership::text || ':'
        || requested_idempotency_key, 0));
      select event.* into v_event from ehr.dental_events event
       where event.by_membership_id = caller.actor_membership and event.idempotency_key = requested_idempotency_key;
      if found then
        if v_event.request_sha256 <> requested_request_sha256 or v_event.kind <> 'follow_up_set' then
          v_refusal := 'key_reused';
          exit work;
        end if;
        v_replayed := true;
        v_visit_id := v_event.dental_visit_id;
        exit work;
      end if;
      select encounter.* into v_encounter from ehr.encounters encounter
       where encounter.id = requested_encounter_id and encounter.patient_id = requested_patient_id
         and encounter.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'encounter_not_found';
        exit work;
      end if;
      if v_encounter.encounter_type <> 'ambulatory' or v_encounter.status in ('cancelled', 'entered_in_error') then
        v_refusal := 'visit_encounter_invalid';
        exit work;
      end if;
      select visit_row.* into v_visit from ehr.dental_visits visit_row
       where visit_row.encounter_id = requested_encounter_id and visit_row.facility_id = caller.actor_facility
       for update;
      if not found then
        v_refusal := 'visit_not_found';
        exit work;
      end if;
      v_visit_id := v_visit.id;
      if v_visit.row_version <> requested_row_version then
        v_refusal := 'version_conflict';
        exit work;
      end if;
      update ehr.dental_visits visit_row
         set follow_up_on = case when coalesce(set_follow_up_on, false) then requested_follow_up_on
                                 else visit_row.follow_up_on end,
             follow_up_note = case when coalesce(set_follow_up_note, false) then v_note
                                   else visit_row.follow_up_note end,
             updated_at = clock_timestamp(), row_version = visit_row.row_version + 1
       where visit_row.id = v_visit.id;
      insert into ehr.dental_events (kind, patient_id, facility_id, encounter_id, dental_visit_id, by_account_id,
        by_membership_id, idempotency_key, request_sha256)
      values ('follow_up_set', requested_patient_id, caller.actor_facility, requested_encounter_id, v_visit.id,
        caller.actor_account, caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.visit.follow-up',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-visit', v_visit_id::text,
      caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('encounterId', requested_encounter_id, 'refusal', v_refusal,
        'replayed', v_replayed, 'followUpDateSet', case when v_refusal is null and not v_replayed
          then coalesce(set_follow_up_on, false) end,
        'followUpNoteSet', case when v_refusal is null and not v_replayed then coalesce(set_follow_up_note, false) end)));
    if v_refusal is not null then
      outcome := v_refusal;
      replayed := false;
      return next;
      return;
    end if;
    return query select 'updated'::text, v_replayed, card.card
      from ehr.dental_cards('visit', array[v_visit_id], caller.actor_facility) card;
  end
  $fn$;

  -- Route 5: this facility's dental visits of the last days (Lagos days), newest first, at most 200; only patients
  -- the member may read now for direct care; the rest counted.
  create function ehr.dental_visits_list(requested_days integer)
  returns table (ord bigint, patient jsonb, visit jsonb, hidden_count integer, has_more boolean)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_limit constant integer := 200;
    v_from date;
    v_readable uuid[];
    v_hidden integer;
    v_shown uuid[];
    v_shown_patients uuid[];
    v_more boolean;
  begin
    select * into caller from ehr.dental_caller('ehr.dental.read');
    if requested_days is null or requested_days not between 1 and 30 then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    v_from := (clock_timestamp() at time zone 'Africa/Lagos')::date - (requested_days - 1);
    select coalesce(array_agg(listed.id order by listed.created_at desc, listed.id desc)
                      filter (where listed.readable), array[]::uuid[]),
           (count(*) filter (where not listed.readable))::integer
      into v_readable, v_hidden
      from (select visit_row.id, visit_row.created_at,
                   identity.sealed_demo_facility(caller.actor_facility) = identity.sealed_demo_patient(visit_row.patient_id)
                   and identity.sealed_qa_facility(caller.actor_facility) = identity.sealed_qa_patient(visit_row.patient_id)
                   and coalesce(ehr.context_allows(visit_row.patient_id, caller.actor_facility, 'read_records'), false)
                     as readable
              from ehr.dental_visits visit_row
             where visit_row.facility_id = caller.actor_facility
               and (visit_row.created_at at time zone 'Africa/Lagos')::date >= v_from) listed;
    v_more := cardinality(v_readable) > v_limit;
    v_shown := coalesce(v_readable[1:v_limit], array[]::uuid[]);
    select coalesce(array_agg(distinct visit_row.patient_id), array[]::uuid[]) into v_shown_patients
      from ehr.dental_visits visit_row where visit_row.id = any (v_shown);
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, null, 'ehr.dental.visit.list', 'success', 'dental-visit-list',
      null, caller.actor_purpose, 'application', 'ehr-api',
      jsonb_build_object('days', requested_days, 'resultCount', cardinality(v_shown), 'hiddenCount', v_hidden,
        'hasMore', v_more, 'patientIds', to_jsonb(v_shown_patients)));
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    select caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
           caller.actor_organization, caller.actor_facility, shown.patient_id, 'ehr.dental.visit.list.shown', 'success',
           'patient', shown.patient_id::text, caller.actor_purpose, 'application', 'ehr-api',
           jsonb_build_object('visitCount', shown.visits)
      from (select visit_row.patient_id, count(*)::integer as visits from ehr.dental_visits visit_row
             where visit_row.id = any (v_shown) group by visit_row.patient_id) shown
     order by shown.patient_id;
    return query
      select visit_card.ord, patient_card.card, visit_card.card, v_hidden, v_more
        from ehr.dental_cards('visit', v_shown, caller.actor_facility) visit_card
        join ehr.dental_visits visit_row on visit_row.id = visit_card.id
        join ehr.dental_cards('patient', v_shown_patients, caller.actor_facility) patient_card
          on patient_card.id = visit_row.patient_id
       order by visit_card.ord;
    if cardinality(v_shown) = 0 then
      -- No visit shown: one row with the counts only.
      ord := 0;
      patient := null;
      visit := null;
      hidden_count := v_hidden;
      has_more := false;
      return next;
    end if;
  end
  $fn$;

  -- Route 6: the newest chart at this facility (or one version) and the versions.
  create function ehr.dental_chart_read(requested_patient_id uuid, requested_version_id uuid)
  returns table (outcome text, chart jsonb, versions jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_chart_id uuid;
    v_refusal text;
    v_versions uuid[];
  begin
    select * into caller from ehr.dental_caller('ehr.dental.read');
    if requested_patient_id is null then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'read_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      if requested_version_id is not null then
        select chart_row.id into v_chart_id from ehr.dental_chart_versions chart_row
         where chart_row.id = requested_version_id and chart_row.patient_id = requested_patient_id
           and chart_row.facility_id = caller.actor_facility;
        if not found then
          v_refusal := 'chart_not_found';
          exit work;
        end if;
      else
        select chart_row.id into v_chart_id from ehr.dental_chart_versions chart_row
         where chart_row.patient_id = requested_patient_id and chart_row.facility_id = caller.actor_facility
           and chart_row.entered_in_error_at is null
         order by chart_row.version_no desc limit 1;
      end if;
      select coalesce(array_agg(chart_row.id order by chart_row.version_no desc), array[]::uuid[]) into v_versions
        from ehr.dental_chart_versions chart_row
       where chart_row.patient_id = requested_patient_id and chart_row.facility_id = caller.actor_facility;
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.chart.read',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-chart-version',
      coalesce(v_chart_id, requested_version_id)::text, caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('refusal', v_refusal, 'versionAsked', requested_version_id is not null,
        'versionCount', cardinality(v_versions))));
    if v_refusal is not null then
      outcome := v_refusal;
      return next;
      return;
    end if;
    outcome := 'found';
    chart := (select card.card from ehr.dental_cards('chart', array[v_chart_id], caller.actor_facility) card);
    versions := (select coalesce(jsonb_agg(card.card order by card.ord), '[]'::jsonb)
                   from ehr.dental_cards('version', v_versions, caller.actor_facility) card);
    return next;
  end
  $fn$;

  -- Route 7: save a new chart version, based on the newest one.
  create function ehr.dental_chart_save(requested_patient_id uuid, requested_encounter_id uuid,
    requested_based_on_version_id uuid, requested_dentition text, requested_findings jsonb, requested_note text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, chart jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_encounter ehr.encounters%rowtype;
    v_event ehr.dental_events%rowtype;
    v_visit_id uuid;
    v_newest uuid;
    v_version_no integer;
    v_list_version uuid;
    v_chart_id uuid;
    v_refusal text;
    v_replayed boolean := false;
    v_note text := nullif(btrim(coalesce(requested_note, '')), '');
    v_count integer;
    v_bad text;
  begin
    select * into caller from ehr.dental_caller('ehr.dental.write');
    if requested_patient_id is null or requested_encounter_id is null
       or requested_dentition is null or requested_dentition not in ('permanent', 'primary', 'mixed')
       or requested_findings is null or jsonb_typeof(requested_findings) <> 'array'
       or jsonb_array_length(requested_findings) > 200
       or (v_note is not null and (length(v_note) > 1000 or v_note ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    -- Each finding: exactly tooth, condition, surfaces and note; the shapes; the tooth in the dentition.
    select case
             when exists (select 1 from jsonb_array_elements(requested_findings) finding
                           where jsonb_typeof(finding.value) <> 'object'
                              or exists (select 1 from jsonb_object_keys(finding.value) key
                                          where key not in ('tooth', 'condition', 'surfaces', 'note'))
                              or jsonb_typeof(finding.value->'condition') is distinct from 'string'
                              or jsonb_typeof(coalesce(finding.value->'surfaces', 'null'::jsonb)) not in ('string', 'null')
                              or jsonb_typeof(coalesce(finding.value->'note', 'null'::jsonb)) not in ('string', 'null'))
               then 'DENTAL_VALIDATION'
             when exists (select 1 from jsonb_array_elements(requested_findings) finding
                           where jsonb_typeof(finding.value->'tooth') is distinct from 'number'
                              or (finding.value->>'tooth') !~ '^[1-8][1-8]$'
                              or not (((finding.value->>'tooth')::integer / 10 between 1 and 4
                                       and (finding.value->>'tooth')::integer % 10 between 1 and 8)
                                      or ((finding.value->>'tooth')::integer / 10 between 5 and 8
                                          and (finding.value->>'tooth')::integer % 10 between 1 and 5))
                              or (requested_dentition = 'permanent' and (finding.value->>'tooth')::integer / 10 > 4)
                              or (requested_dentition = 'primary' and (finding.value->>'tooth')::integer / 10 < 5))
               then 'DENTAL_TOOTH_INVALID'
             when exists (select 1 from jsonb_array_elements(requested_findings) finding
                           where finding.value->>'surfaces' is not null
                             and (finding.value->>'surfaces' !~ '^M?O?D?B?L?$' or finding.value->>'surfaces' = ''))
               then 'DENTAL_SURFACES_INVALID'
             when exists (select 1 from jsonb_array_elements(requested_findings) finding
                           where finding.value->>'note' is not null
                             and (finding.value->>'note' <> btrim(finding.value->>'note')
                                  or length(finding.value->>'note') not between 1 and 200
                                  or finding.value->>'note' ~ '[[:cntrl:]]'))
               then 'DENTAL_VALIDATION'
             when (select count(*) from jsonb_array_elements(requested_findings) finding)
                  <> (select count(distinct ((finding.value->>'tooth'), (finding.value->>'condition')))
                        from jsonb_array_elements(requested_findings) finding)
               then 'DENTAL_VALIDATION'
           end into v_bad;
    if v_bad is not null then
      raise exception using errcode = '22023', message = v_bad;
    end if;
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'DENTAL_IDEMPOTENCY_KEY_INVALID';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'write_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      perform pg_advisory_xact_lock(hashtextextended('dental-key:' || caller.actor_membership::text || ':'
        || requested_idempotency_key, 0));
      select event.* into v_event from ehr.dental_events event
       where event.by_membership_id = caller.actor_membership and event.idempotency_key = requested_idempotency_key;
      if found then
        if v_event.request_sha256 <> requested_request_sha256 or v_event.kind <> 'chart_saved' then
          v_refusal := 'key_reused';
          exit work;
        end if;
        v_replayed := true;
        v_chart_id := v_event.chart_version_id;
        exit work;
      end if;
      select encounter.* into v_encounter from ehr.encounters encounter
       where encounter.id = requested_encounter_id and encounter.patient_id = requested_patient_id
         and encounter.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'encounter_not_found';
        exit work;
      end if;
      if v_encounter.encounter_type <> 'ambulatory' or v_encounter.status in ('cancelled', 'entered_in_error') then
        v_refusal := 'visit_encounter_invalid';
        exit work;
      end if;
      if v_encounter.status not in ('planned', 'in_progress', 'on_hold') then
        v_refusal := 'visit_closed';
        exit work;
      end if;
      select visit_row.id into v_visit_id from ehr.dental_visits visit_row
       where visit_row.encounter_id = requested_encounter_id and visit_row.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'visit_not_started';
        exit work;
      end if;
      -- The conditions: each of the active tooth-condition list; surfaces only where the condition takes them.
      select list_version.id into v_list_version from ehr.dental_list_versions list_version
       where list_version.kind = 'tooth_condition' and list_version.active;
      if v_list_version is null
         or exists (select 1 from jsonb_array_elements(requested_findings) finding
                     where not exists (select 1 from ehr.dental_list_items item
                                        where item.version_id = v_list_version
                                          and item.code = finding.value->>'condition')) then
        raise exception using errcode = '22023', message = 'DENTAL_CONDITION_INVALID';
      end if;
      if exists (select 1 from jsonb_array_elements(requested_findings) finding
                   join ehr.dental_list_items item on item.version_id = v_list_version
                    and item.code = finding.value->>'condition'
                  where (finding.value->>'surfaces' is not null) <> item.takes_surfaces) then
        raise exception using errcode = '22023', message = 'DENTAL_SURFACES_INVALID';
      end if;
      -- The patient's chart here, under its lock: the newest version not marked in error must be the one the screen
      -- started from; the number is the next after every version.
      perform pg_advisory_xact_lock(hashtextextended('dental-chart:' || caller.actor_facility::text || ':'
        || requested_patient_id::text, 0));
      select chart_row.id into v_newest from ehr.dental_chart_versions chart_row
       where chart_row.patient_id = requested_patient_id and chart_row.facility_id = caller.actor_facility
         and chart_row.entered_in_error_at is null
       order by chart_row.version_no desc limit 1;
      if v_newest is distinct from requested_based_on_version_id then
        v_refusal := 'chart_changed';
        exit work;
      end if;
      select coalesce(max(chart_row.version_no), 0) + 1 into v_version_no from ehr.dental_chart_versions chart_row
       where chart_row.patient_id = requested_patient_id and chart_row.facility_id = caller.actor_facility;
      insert into ehr.dental_chart_versions (patient_id, facility_id, encounter_id, dental_visit_id, version_no,
        based_on_version_id, dentition, note, list_version_id, created_by, created_by_membership_id)
      values (requested_patient_id, caller.actor_facility, requested_encounter_id, v_visit_id, v_version_no,
        v_newest, requested_dentition, v_note, v_list_version, caller.actor_account, caller.actor_membership)
      returning id into v_chart_id;
      insert into ehr.dental_chart_findings (chart_version_id, tooth, condition_code, surfaces, note)
      select v_chart_id, (finding.value->>'tooth')::smallint, finding.value->>'condition', finding.value->>'surfaces',
             finding.value->>'note'
        from jsonb_array_elements(requested_findings) finding;
      get diagnostics v_count = row_count;
      insert into ehr.dental_events (kind, patient_id, facility_id, encounter_id, dental_visit_id, chart_version_id,
        by_account_id, by_membership_id, idempotency_key, request_sha256)
      values ('chart_saved', requested_patient_id, caller.actor_facility, requested_encounter_id, v_visit_id,
        v_chart_id, caller.actor_account, caller.actor_membership, requested_idempotency_key,
        requested_request_sha256);
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.chart.save',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-chart-version', v_chart_id::text,
      caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('encounterId', requested_encounter_id, 'refusal', v_refusal,
        'replayed', v_replayed, 'versionNo', v_version_no, 'findingsCount', v_count)));
    if v_refusal is not null then
      outcome := v_refusal;
      replayed := false;
      return next;
      return;
    end if;
    return query select 'saved'::text, v_replayed, card.card
      from ehr.dental_cards('chart', array[v_chart_id], caller.actor_facility) card;
  end
  $fn$;

  -- Route 8: mark the newest chart version entered in error; the one before it is the newest again.
  create function ehr.dental_chart_entered_in_error(requested_patient_id uuid, requested_version_id uuid,
    requested_reason text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, chart jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_event ehr.dental_events%rowtype;
    v_version ehr.dental_chart_versions%rowtype;
    v_newest uuid;
    v_refusal text;
    v_replayed boolean := false;
    v_reason text := btrim(coalesce(requested_reason, ''));
  begin
    select * into caller from ehr.dental_caller('ehr.dental.write');
    if requested_patient_id is null or requested_version_id is null then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    if length(v_reason) not between 8 and 500 or v_reason ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'DENTAL_REASON_REQUIRED';
    end if;
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'DENTAL_IDEMPOTENCY_KEY_INVALID';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'write_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      perform pg_advisory_xact_lock(hashtextextended('dental-key:' || caller.actor_membership::text || ':'
        || requested_idempotency_key, 0));
      select event.* into v_event from ehr.dental_events event
       where event.by_membership_id = caller.actor_membership and event.idempotency_key = requested_idempotency_key;
      if found then
        if v_event.request_sha256 <> requested_request_sha256 or v_event.kind <> 'chart_entered_in_error' then
          v_refusal := 'key_reused';
          exit work;
        end if;
        v_replayed := true;
        v_version.id := v_event.chart_version_id;
        exit work;
      end if;
      perform pg_advisory_xact_lock(hashtextextended('dental-chart:' || caller.actor_facility::text || ':'
        || requested_patient_id::text, 0));
      select chart_row.* into v_version from ehr.dental_chart_versions chart_row
       where chart_row.id = requested_version_id and chart_row.patient_id = requested_patient_id
         and chart_row.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'chart_not_found';
        exit work;
      end if;
      select chart_row.id into v_newest from ehr.dental_chart_versions chart_row
       where chart_row.patient_id = requested_patient_id and chart_row.facility_id = caller.actor_facility
         and chart_row.entered_in_error_at is null
       order by chart_row.version_no desc limit 1;
      if v_newest is distinct from v_version.id then
        v_refusal := 'chart_not_latest';
        exit work;
      end if;
      update ehr.dental_chart_versions chart_row
         set entered_in_error_at = clock_timestamp(), entered_in_error_by_membership_id = caller.actor_membership,
             entered_in_error_reason = v_reason
       where chart_row.id = v_version.id;
      insert into ehr.dental_events (kind, patient_id, facility_id, encounter_id, dental_visit_id, chart_version_id,
        by_account_id, by_membership_id, idempotency_key, request_sha256)
      values ('chart_entered_in_error', requested_patient_id, caller.actor_facility, v_version.encounter_id,
        v_version.dental_visit_id, v_version.id, caller.actor_account, caller.actor_membership,
        requested_idempotency_key, requested_request_sha256);
    end work;
    if v_refusal is null then
      select chart_row.id into v_newest from ehr.dental_chart_versions chart_row
       where chart_row.patient_id = requested_patient_id and chart_row.facility_id = caller.actor_facility
         and chart_row.entered_in_error_at is null
       order by chart_row.version_no desc limit 1;
    end if;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.chart.entered-in-error',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-chart-version',
      coalesce(v_version.id, requested_version_id)::text, caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('refusal', v_refusal, 'replayed', v_replayed,
        'versionNo', case when v_refusal is null and not v_replayed then v_version.version_no end,
        'newestVersionId', case when v_refusal is null then v_newest end)));
    if v_refusal is not null then
      outcome := v_refusal;
      replayed := false;
      return next;
      return;
    end if;
    outcome := 'updated';
    replayed := v_replayed;
    chart := (select card.card from ehr.dental_cards('chart', array[v_newest], caller.actor_facility) card);
    return next;
  end
  $fn$;

  -- Route 9: plan a procedure, or record one done (signed by the caller).
  create function ehr.dental_procedure_record(requested_patient_id uuid, requested_encounter_id uuid,
    requested_status text, requested_procedure_code text, requested_procedure_name text, requested_site text,
    requested_tooth smallint, requested_surfaces text, requested_quadrant smallint, requested_arch text,
    requested_done_at timestamptz, requested_agent_code text, requested_agent_other text,
    requested_technique_code text, requested_cartridges numeric, requested_notes text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, procedure jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_encounter ehr.encounters%rowtype;
    v_event ehr.dental_events%rowtype;
    v_item ehr.dental_list_items%rowtype;
    v_visit_id uuid;
    v_procedure_id uuid;
    v_list_version uuid;
    v_agent_version uuid;
    v_technique_version uuid;
    v_site text;
    v_name text := nullif(btrim(coalesce(requested_procedure_name, '')), '');
    v_other text := nullif(btrim(coalesce(requested_agent_other, '')), '');
    v_notes text := nullif(btrim(coalesce(requested_notes, '')), '');
    v_now timestamptz := clock_timestamp();
    v_done_at timestamptz;
    v_refusal text;
    v_replayed boolean := false;
    v_kind text := (case when requested_status = 'done' then 'procedure_done' else 'procedure_planned' end);
  begin
    select * into caller from ehr.dental_caller('ehr.dental.write');
    if requested_patient_id is null or requested_encounter_id is null
       or requested_status is null or requested_status not in ('planned', 'done')
       or (v_notes is not null and (length(v_notes) > 1000 or v_notes ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    if (requested_procedure_code is null) = (v_name is null)
       or (v_name is not null and (length(v_name) not between 2 and 120 or v_name ~ '[[:cntrl:]]'))
       or (requested_procedure_code is not null and requested_procedure_code !~ '^DEN-[0-9]{3}$') then
      raise exception using errcode = '22023', message = 'DENTAL_PROCEDURE_INVALID';
    end if;
    if (requested_site is not null
        and requested_site not in ('tooth', 'tooth_surfaces', 'quadrant', 'arch', 'whole_mouth'))
       or (v_name is not null and requested_site is null) then
      raise exception using errcode = '22023', message = 'DENTAL_SITE_INVALID';
    end if;
    if requested_status = 'planned'
       and (requested_done_at is not null or requested_agent_code is not null or requested_agent_other is not null
            or requested_technique_code is not null or requested_cartridges is not null) then
      raise exception using errcode = '22023', message = 'DENTAL_ANAESTHETIC_INVALID';
    end if;
    if requested_status = 'done'
       and (requested_agent_code is null
            or (requested_agent_code = 'none' and (requested_technique_code is not null
                                                  or requested_cartridges is not null or v_other is not null))
            or (requested_agent_code <> 'none' and (requested_technique_code is null or requested_cartridges is null))
            or ((requested_agent_code = 'other') <> (v_other is not null))
            or (v_other is not null and (length(v_other) not between 2 and 120 or v_other ~ '[[:cntrl:]]'))
            or (requested_cartridges is not null
                and (requested_cartridges not between 0.5 and 10
                     or requested_cartridges * 2 <> trunc(requested_cartridges * 2)))) then
      raise exception using errcode = '22023', message = 'DENTAL_ANAESTHETIC_INVALID';
    end if;
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'DENTAL_IDEMPOTENCY_KEY_INVALID';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'write_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      perform pg_advisory_xact_lock(hashtextextended('dental-key:' || caller.actor_membership::text || ':'
        || requested_idempotency_key, 0));
      select event.* into v_event from ehr.dental_events event
       where event.by_membership_id = caller.actor_membership and event.idempotency_key = requested_idempotency_key;
      if found then
        if v_event.request_sha256 <> requested_request_sha256 or v_event.kind <> v_kind then
          v_refusal := 'key_reused';
          exit work;
        end if;
        v_replayed := true;
        v_procedure_id := v_event.procedure_id;
        exit work;
      end if;
      select encounter.* into v_encounter from ehr.encounters encounter
       where encounter.id = requested_encounter_id and encounter.patient_id = requested_patient_id
         and encounter.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'encounter_not_found';
        exit work;
      end if;
      if v_encounter.encounter_type <> 'ambulatory' or v_encounter.status in ('cancelled', 'entered_in_error') then
        v_refusal := 'visit_encounter_invalid';
        exit work;
      end if;
      if v_encounter.status not in ('planned', 'in_progress', 'on_hold') then
        v_refusal := 'visit_closed';
        exit work;
      end if;
      select visit_row.id into v_visit_id from ehr.dental_visits visit_row
       where visit_row.encounter_id = requested_encounter_id and visit_row.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'visit_not_started';
        exit work;
      end if;
      -- A listed procedure: the active list's code, its name and its site; one by name chooses its site.
      if requested_procedure_code is not null then
        select list_version.id into v_list_version from ehr.dental_list_versions list_version
         where list_version.kind = 'procedure' and list_version.active;
        select item.* into v_item from ehr.dental_list_items item
         where item.version_id = v_list_version and item.code = requested_procedure_code;
        if not found then
          raise exception using errcode = '22023', message = 'DENTAL_PROCEDURE_INVALID';
        end if;
        if requested_site is not null and requested_site <> v_item.site then
          raise exception using errcode = '22023', message = 'DENTAL_SITE_INVALID';
        end if;
        v_site := v_item.site;
        v_name := v_item.label;
      else
        v_site := requested_site;
      end if;
      -- The site's columns, exactly.
      if (v_site in ('tooth', 'tooth_surfaces')) <> (requested_tooth is not null)
         or (v_site = 'tooth_surfaces') <> (requested_surfaces is not null)
         or (v_site = 'quadrant') <> (requested_quadrant is not null)
         or (v_site = 'arch') <> (requested_arch is not null) then
        raise exception using errcode = '22023', message = 'DENTAL_SITE_INVALID';
      end if;
      if requested_tooth is not null
         and not ((requested_tooth / 10 between 1 and 4 and requested_tooth % 10 between 1 and 8)
                  or (requested_tooth / 10 between 5 and 8 and requested_tooth % 10 between 1 and 5)) then
        raise exception using errcode = '22023', message = 'DENTAL_TOOTH_INVALID';
      end if;
      if requested_surfaces is not null and (requested_surfaces !~ '^M?O?D?B?L?$' or requested_surfaces = '') then
        raise exception using errcode = '22023', message = 'DENTAL_SURFACES_INVALID';
      end if;
      if (requested_quadrant is not null and requested_quadrant not between 1 and 4)
         or (requested_arch is not null and requested_arch not in ('upper', 'lower')) then
        raise exception using errcode = '22023', message = 'DENTAL_SITE_INVALID';
      end if;
      if requested_status = 'done' then
        select list_version.id into v_agent_version from ehr.dental_list_versions list_version
         where list_version.kind = 'anaesthetic' and list_version.active;
        if not exists (select 1 from ehr.dental_list_items item
                        where item.version_id = v_agent_version and item.code = requested_agent_code) then
          raise exception using errcode = '22023', message = 'DENTAL_ANAESTHETIC_INVALID';
        end if;
        if requested_technique_code is not null then
          select list_version.id into v_technique_version from ehr.dental_list_versions list_version
           where list_version.kind = 'anaesthetic_technique' and list_version.active;
          if not exists (select 1 from ehr.dental_list_items item
                          where item.version_id = v_technique_version and item.code = requested_technique_code) then
            raise exception using errcode = '22023', message = 'DENTAL_ANAESTHETIC_INVALID';
          end if;
        end if;
        -- From the visit's start to now; up to 2 minutes ahead (device clocks) is taken as now.
        if requested_done_at is not null
           and (requested_done_at > v_now + interval '2 minutes' or requested_done_at < v_encounter.started_at) then
          raise exception using errcode = '22023', message = 'DENTAL_DONE_TIME_INVALID';
        end if;
        v_done_at := least(coalesce(requested_done_at, v_now), v_now);
      end if;
      insert into ehr.dental_procedures (patient_id, facility_id, planned_encounter_id, done_encounter_id,
        list_version_id, list_kind, procedure_code, procedure_name, by_name, site, tooth, surfaces, quadrant, arch,
        status, planned_at, planned_by_membership_id, done_at, performed_by, performed_by_membership_id, signed_at,
        anaesthetic_list_version_id, anaesthetic_list_kind, anaesthetic_code, anaesthetic_other,
        technique_list_version_id, technique_list_kind, anaesthetic_technique_code, anaesthetic_cartridges, notes,
        created_at, updated_at)
      values (requested_patient_id, caller.actor_facility,
        case when requested_status = 'planned' then requested_encounter_id end,
        case when requested_status = 'done' then requested_encounter_id end,
        v_list_version, case when v_list_version is not null then 'procedure' end, requested_procedure_code, v_name,
        requested_procedure_code is null, v_site, requested_tooth, requested_surfaces, requested_quadrant,
        requested_arch, requested_status,
        case when requested_status = 'planned' then v_now end,
        case when requested_status = 'planned' then caller.actor_membership end,
        v_done_at, case when requested_status = 'done' then caller.actor_account end,
        case when requested_status = 'done' then caller.actor_membership end,
        case when requested_status = 'done' then v_now end,
        v_agent_version, case when v_agent_version is not null then 'anaesthetic' end, requested_agent_code, v_other,
        v_technique_version, case when v_technique_version is not null then 'anaesthetic_technique' end,
        requested_technique_code, requested_cartridges, v_notes, v_now, v_now)
      returning id into v_procedure_id;
      insert into ehr.dental_events (kind, patient_id, facility_id, encounter_id, dental_visit_id, procedure_id,
        by_account_id, by_membership_id, idempotency_key, request_sha256)
      values (v_kind,
        requested_patient_id, caller.actor_facility, requested_encounter_id, v_visit_id, v_procedure_id,
        caller.actor_account, caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id,
      case when requested_status = 'done' then 'ehr.dental.procedure.done' else 'ehr.dental.procedure.plan' end,
      case when v_refusal is null then 'success' else 'denied' end, 'dental-procedure', v_procedure_id::text,
      caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('encounterId', requested_encounter_id, 'refusal', v_refusal,
        'replayed', v_replayed, 'status', case when v_refusal is null then requested_status end,
        'byName', case when v_refusal is null and not v_replayed then requested_procedure_code is null end)));
    if v_refusal is not null then
      outcome := v_refusal;
      replayed := false;
      return next;
      return;
    end if;
    return query select 'recorded'::text, v_replayed, card.card
      from ehr.dental_cards('procedure', array[v_procedure_id], caller.actor_facility) card;
  end
  $fn$;

  -- Route 10: record a planned procedure as done in this visit, signed by the caller.
  create function ehr.dental_procedure_done(requested_patient_id uuid, requested_encounter_id uuid,
    requested_procedure_id uuid, requested_row_version bigint, requested_done_at timestamptz,
    requested_agent_code text, requested_agent_other text, requested_technique_code text,
    requested_cartridges numeric, set_surfaces boolean, requested_surfaces text, set_notes boolean,
    requested_notes text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, procedure jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_encounter ehr.encounters%rowtype;
    v_event ehr.dental_events%rowtype;
    v_procedure ehr.dental_procedures%rowtype;
    v_visit_id uuid;
    v_procedure_id uuid;
    v_agent_version uuid;
    v_technique_version uuid;
    v_other text := nullif(btrim(coalesce(requested_agent_other, '')), '');
    v_notes text := nullif(btrim(coalesce(requested_notes, '')), '');
    v_now timestamptz := clock_timestamp();
    v_done_at timestamptz;
    v_refusal text;
    v_replayed boolean := false;
  begin
    select * into caller from ehr.dental_caller('ehr.dental.write');
    if requested_patient_id is null or requested_encounter_id is null or requested_procedure_id is null
       or requested_row_version is null or requested_row_version < 1
       or (not coalesce(set_notes, false) and requested_notes is not null)
       or (v_notes is not null and (length(v_notes) > 1000 or v_notes ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    if requested_agent_code is null
       or (requested_agent_code = 'none' and (requested_technique_code is not null
                                             or requested_cartridges is not null or v_other is not null))
       or (requested_agent_code <> 'none' and (requested_technique_code is null or requested_cartridges is null))
       or ((requested_agent_code = 'other') <> (v_other is not null))
       or (v_other is not null and (length(v_other) not between 2 and 120 or v_other ~ '[[:cntrl:]]'))
       or (requested_cartridges is not null
           and (requested_cartridges not between 0.5 and 10
                or requested_cartridges * 2 <> trunc(requested_cartridges * 2))) then
      raise exception using errcode = '22023', message = 'DENTAL_ANAESTHETIC_INVALID';
    end if;
    if (not coalesce(set_surfaces, false) and requested_surfaces is not null)
       or (coalesce(set_surfaces, false)
           and (requested_surfaces is null or requested_surfaces !~ '^M?O?D?B?L?$' or requested_surfaces = '')) then
      raise exception using errcode = '22023', message = 'DENTAL_SURFACES_INVALID';
    end if;
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'DENTAL_IDEMPOTENCY_KEY_INVALID';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'write_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      perform pg_advisory_xact_lock(hashtextextended('dental-key:' || caller.actor_membership::text || ':'
        || requested_idempotency_key, 0));
      select event.* into v_event from ehr.dental_events event
       where event.by_membership_id = caller.actor_membership and event.idempotency_key = requested_idempotency_key;
      if found then
        if v_event.request_sha256 <> requested_request_sha256 or v_event.kind <> 'procedure_done' then
          v_refusal := 'key_reused';
          exit work;
        end if;
        v_replayed := true;
        v_procedure_id := v_event.procedure_id;
        exit work;
      end if;
      select encounter.* into v_encounter from ehr.encounters encounter
       where encounter.id = requested_encounter_id and encounter.patient_id = requested_patient_id
         and encounter.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'encounter_not_found';
        exit work;
      end if;
      if v_encounter.encounter_type <> 'ambulatory' or v_encounter.status in ('cancelled', 'entered_in_error') then
        v_refusal := 'visit_encounter_invalid';
        exit work;
      end if;
      if v_encounter.status not in ('planned', 'in_progress', 'on_hold') then
        v_refusal := 'visit_closed';
        exit work;
      end if;
      select visit_row.id into v_visit_id from ehr.dental_visits visit_row
       where visit_row.encounter_id = requested_encounter_id and visit_row.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'visit_not_started';
        exit work;
      end if;
      select procedure_row.* into v_procedure from ehr.dental_procedures procedure_row
       where procedure_row.id = requested_procedure_id and procedure_row.patient_id = requested_patient_id
         and procedure_row.facility_id = caller.actor_facility
       for update;
      if not found then
        v_refusal := 'procedure_not_found';
        exit work;
      end if;
      v_procedure_id := v_procedure.id;
      if v_procedure.status <> 'planned' then
        v_refusal := 'procedure_not_planned';
        exit work;
      end if;
      if v_procedure.row_version <> requested_row_version then
        v_refusal := 'version_conflict';
        exit work;
      end if;
      if coalesce(set_surfaces, false) and v_procedure.site <> 'tooth_surfaces' then
        raise exception using errcode = '22023', message = 'DENTAL_SURFACES_INVALID';
      end if;
      select list_version.id into v_agent_version from ehr.dental_list_versions list_version
       where list_version.kind = 'anaesthetic' and list_version.active;
      if not exists (select 1 from ehr.dental_list_items item
                      where item.version_id = v_agent_version and item.code = requested_agent_code) then
        raise exception using errcode = '22023', message = 'DENTAL_ANAESTHETIC_INVALID';
      end if;
      if requested_technique_code is not null then
        select list_version.id into v_technique_version from ehr.dental_list_versions list_version
         where list_version.kind = 'anaesthetic_technique' and list_version.active;
        if not exists (select 1 from ehr.dental_list_items item
                        where item.version_id = v_technique_version and item.code = requested_technique_code) then
          raise exception using errcode = '22023', message = 'DENTAL_ANAESTHETIC_INVALID';
        end if;
      end if;
      if requested_done_at is not null
         and (requested_done_at > v_now + interval '2 minutes' or requested_done_at < v_encounter.started_at) then
        raise exception using errcode = '22023', message = 'DENTAL_DONE_TIME_INVALID';
      end if;
      v_done_at := least(coalesce(requested_done_at, v_now), v_now);
      update ehr.dental_procedures procedure_row
         set status = 'done', done_encounter_id = requested_encounter_id, done_at = v_done_at,
             performed_by = caller.actor_account, performed_by_membership_id = caller.actor_membership,
             signed_at = v_now, anaesthetic_list_version_id = v_agent_version, anaesthetic_list_kind = 'anaesthetic',
             anaesthetic_code = requested_agent_code, anaesthetic_other = v_other,
             technique_list_version_id = v_technique_version,
             technique_list_kind = case when v_technique_version is not null then 'anaesthetic_technique' end,
             anaesthetic_technique_code = requested_technique_code, anaesthetic_cartridges = requested_cartridges,
             surfaces = case when coalesce(set_surfaces, false) then requested_surfaces else procedure_row.surfaces end,
             notes = case when coalesce(set_notes, false) then v_notes else procedure_row.notes end,
             updated_at = v_now, row_version = procedure_row.row_version + 1
       where procedure_row.id = v_procedure.id;
      insert into ehr.dental_events (kind, patient_id, facility_id, encounter_id, dental_visit_id, procedure_id,
        by_account_id, by_membership_id, idempotency_key, request_sha256)
      values ('procedure_done', requested_patient_id, caller.actor_facility, requested_encounter_id, v_visit_id,
        v_procedure.id, caller.actor_account, caller.actor_membership, requested_idempotency_key,
        requested_request_sha256);
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.procedure.done',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-procedure',
      coalesce(v_procedure_id, requested_procedure_id)::text, caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('encounterId', requested_encounter_id, 'refusal', v_refusal,
        'replayed', v_replayed, 'fromStatus', case when v_refusal is null and not v_replayed then 'planned' end,
        'status', case when v_refusal is null then 'done' else v_procedure.status end)));
    if v_refusal is not null then
      outcome := v_refusal;
      replayed := false;
      return next;
      return;
    end if;
    return query select 'updated'::text, v_replayed, card.card
      from ehr.dental_cards('procedure', array[v_procedure_id], caller.actor_facility) card;
  end
  $fn$;

  -- Route 11: cancel a planned procedure, with a reason (at any time).
  create function ehr.dental_procedure_cancel(requested_patient_id uuid, requested_procedure_id uuid,
    requested_row_version bigint, requested_reason text, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, procedure jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_event ehr.dental_events%rowtype;
    v_procedure ehr.dental_procedures%rowtype;
    v_procedure_id uuid;
    v_refusal text;
    v_replayed boolean := false;
    v_reason text := btrim(coalesce(requested_reason, ''));
  begin
    select * into caller from ehr.dental_caller('ehr.dental.write');
    if requested_patient_id is null or requested_procedure_id is null or requested_row_version is null
       or requested_row_version < 1 then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    if length(v_reason) not between 8 and 500 or v_reason ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'DENTAL_REASON_REQUIRED';
    end if;
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'DENTAL_IDEMPOTENCY_KEY_INVALID';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'write_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      perform pg_advisory_xact_lock(hashtextextended('dental-key:' || caller.actor_membership::text || ':'
        || requested_idempotency_key, 0));
      select event.* into v_event from ehr.dental_events event
       where event.by_membership_id = caller.actor_membership and event.idempotency_key = requested_idempotency_key;
      if found then
        if v_event.request_sha256 <> requested_request_sha256 or v_event.kind <> 'procedure_cancelled' then
          v_refusal := 'key_reused';
          exit work;
        end if;
        v_replayed := true;
        v_procedure_id := v_event.procedure_id;
        exit work;
      end if;
      select procedure_row.* into v_procedure from ehr.dental_procedures procedure_row
       where procedure_row.id = requested_procedure_id and procedure_row.patient_id = requested_patient_id
         and procedure_row.facility_id = caller.actor_facility
       for update;
      if not found then
        v_refusal := 'procedure_not_found';
        exit work;
      end if;
      v_procedure_id := v_procedure.id;
      if v_procedure.status <> 'planned' then
        v_refusal := 'procedure_not_planned';
        exit work;
      end if;
      if v_procedure.row_version <> requested_row_version then
        v_refusal := 'version_conflict';
        exit work;
      end if;
      update ehr.dental_procedures procedure_row
         set status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by_membership_id = caller.actor_membership,
             cancel_reason = v_reason, updated_at = clock_timestamp(), row_version = procedure_row.row_version + 1
       where procedure_row.id = v_procedure.id;
      insert into ehr.dental_events (kind, patient_id, facility_id, encounter_id, procedure_id, by_account_id,
        by_membership_id, idempotency_key, request_sha256)
      values ('procedure_cancelled', requested_patient_id, caller.actor_facility, v_procedure.planned_encounter_id,
        v_procedure.id, caller.actor_account, caller.actor_membership, requested_idempotency_key,
        requested_request_sha256);
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.procedure.cancel',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-procedure',
      coalesce(v_procedure_id, requested_procedure_id)::text, caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('refusal', v_refusal, 'replayed', v_replayed,
        'status', case when v_refusal is null then 'cancelled' else v_procedure.status end)));
    if v_refusal is not null then
      outcome := v_refusal;
      replayed := false;
      return next;
      return;
    end if;
    return query select 'updated'::text, v_replayed, card.card
      from ehr.dental_cards('procedure', array[v_procedure_id], caller.actor_facility) card;
  end
  $fn$;

  -- Route 12: mark a done procedure entered in error, with a reason; only the dentist who signed it (Q-DEN-4 A).
  create function ehr.dental_procedure_entered_in_error(requested_patient_id uuid, requested_procedure_id uuid,
    requested_row_version bigint, requested_reason text, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, procedure jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_event ehr.dental_events%rowtype;
    v_procedure ehr.dental_procedures%rowtype;
    v_procedure_id uuid;
    v_refusal text;
    v_replayed boolean := false;
    v_reason text := btrim(coalesce(requested_reason, ''));
  begin
    select * into caller from ehr.dental_caller('ehr.dental.write');
    if requested_patient_id is null or requested_procedure_id is null or requested_row_version is null
       or requested_row_version < 1 then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    if length(v_reason) not between 8 and 500 or v_reason ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'DENTAL_REASON_REQUIRED';
    end if;
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'DENTAL_IDEMPOTENCY_KEY_INVALID';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'write_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      perform pg_advisory_xact_lock(hashtextextended('dental-key:' || caller.actor_membership::text || ':'
        || requested_idempotency_key, 0));
      select event.* into v_event from ehr.dental_events event
       where event.by_membership_id = caller.actor_membership and event.idempotency_key = requested_idempotency_key;
      if found then
        if v_event.request_sha256 <> requested_request_sha256 or v_event.kind <> 'procedure_entered_in_error' then
          v_refusal := 'key_reused';
          exit work;
        end if;
        v_replayed := true;
        v_procedure_id := v_event.procedure_id;
        exit work;
      end if;
      select procedure_row.* into v_procedure from ehr.dental_procedures procedure_row
       where procedure_row.id = requested_procedure_id and procedure_row.patient_id = requested_patient_id
         and procedure_row.facility_id = caller.actor_facility
       for update;
      if not found then
        v_refusal := 'procedure_not_found';
        exit work;
      end if;
      v_procedure_id := v_procedure.id;
      if v_procedure.status <> 'done' then
        v_refusal := 'procedure_not_done';
        exit work;
      end if;
      if v_procedure.performed_by_membership_id <> caller.actor_membership then
        v_refusal := 'not_signer';
        exit work;
      end if;
      if v_procedure.row_version <> requested_row_version then
        v_refusal := 'version_conflict';
        exit work;
      end if;
      update ehr.dental_procedures procedure_row
         set status = 'entered_in_error', entered_in_error_at = clock_timestamp(),
             entered_in_error_by_membership_id = caller.actor_membership, entered_in_error_reason = v_reason,
             updated_at = clock_timestamp(), row_version = procedure_row.row_version + 1
       where procedure_row.id = v_procedure.id;
      insert into ehr.dental_events (kind, patient_id, facility_id, encounter_id, procedure_id, by_account_id,
        by_membership_id, idempotency_key, request_sha256)
      values ('procedure_entered_in_error', requested_patient_id, caller.actor_facility, v_procedure.done_encounter_id,
        v_procedure.id, caller.actor_account, caller.actor_membership, requested_idempotency_key,
        requested_request_sha256);
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.procedure.entered-in-error',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-procedure',
      coalesce(v_procedure_id, requested_procedure_id)::text, caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('refusal', v_refusal, 'replayed', v_replayed,
        'status', case when v_refusal is null then 'entered_in_error' else v_procedure.status end)));
    if v_refusal is not null then
      outcome := v_refusal;
      replayed := false;
      return next;
      return;
    end if;
    return query select 'updated'::text, v_replayed, card.card
      from ehr.dental_cards('procedure', array[v_procedure_id], caller.actor_facility) card;
  end
  $fn$;

  -- Route 13: the patient's dental procedures at this facility, newest first, at most 200.
  create function ehr.dental_procedures_list(requested_patient_id uuid, requested_status text)
  returns table (outcome text, items jsonb, has_more boolean)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_limit constant integer := 200;
    v_found uuid[];
    v_refusal text;
    v_more boolean := false;
  begin
    select * into caller from ehr.dental_caller('ehr.dental.read');
    if requested_patient_id is null or requested_status is null
       or requested_status not in ('planned', 'done', 'all') then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'read_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      select coalesce(array_agg(listed.id order by listed.created_at desc, listed.id desc), array[]::uuid[])
        into v_found
        from (select procedure_row.id, procedure_row.created_at from ehr.dental_procedures procedure_row
               where procedure_row.patient_id = requested_patient_id and procedure_row.facility_id = caller.actor_facility
                 and (requested_status = 'all' or procedure_row.status = requested_status)
               order by procedure_row.created_at desc, procedure_row.id desc
               limit v_limit + 1) listed;
      v_more := cardinality(v_found) > v_limit;
      v_found := coalesce(v_found[1:v_limit], array[]::uuid[]);
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.procedure.list',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-procedure-list', null,
      caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('refusal', v_refusal, 'statusFilter', requested_status,
        'resultCount', cardinality(v_found), 'hasMore', case when v_refusal is null then v_more end)));
    if v_refusal is not null then
      outcome := v_refusal;
      return next;
      return;
    end if;
    outcome := 'found';
    items := (select coalesce(jsonb_agg(card.card order by card.ord), '[]'::jsonb)
                from ehr.dental_cards('procedure', v_found, caller.actor_facility) card);
    has_more := v_more;
    return next;
  end
  $fn$;

  -- Route 14: the printable visit summary's dental part, audited as a print.
  create function ehr.dental_summary_read(requested_patient_id uuid, requested_encounter_id uuid)
  returns table (outcome text, patient jsonb, facility_name text, visit jsonb, encounter jsonb, chart jsonb,
    done_this_visit jsonb, planned_procedures jsonb, list_status text, printed_at timestamptz)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_encounter ehr.encounters%rowtype;
    v_visit_id uuid;
    v_chart_id uuid;
    v_refusal text;
    v_planned uuid[];
    v_done uuid[];
    v_now timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.dental_caller('ehr.dental.read');
    if requested_patient_id is null or requested_encounter_id is null then
      raise exception using errcode = '22023', message = 'DENTAL_VALIDATION';
    end if;
    <<work>>
    begin
      if identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(requested_patient_id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(requested_patient_id)
         or not coalesce(ehr.context_allows(requested_patient_id, caller.actor_facility, 'read_records'), false) then
        v_refusal := 'consent_required';
        exit work;
      end if;
      select encounter_row.* into v_encounter from ehr.encounters encounter_row
       where encounter_row.id = requested_encounter_id and encounter_row.patient_id = requested_patient_id
         and encounter_row.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'encounter_not_found';
        exit work;
      end if;
      if v_encounter.encounter_type <> 'ambulatory' or v_encounter.status in ('cancelled', 'entered_in_error') then
        v_refusal := 'visit_encounter_invalid';
        exit work;
      end if;
      select visit_row.id into v_visit_id from ehr.dental_visits visit_row
       where visit_row.encounter_id = requested_encounter_id and visit_row.facility_id = caller.actor_facility;
      if not found then
        v_refusal := 'visit_not_found';
        exit work;
      end if;
      -- The newest version recorded in this visit, else the newest at this facility.
      select chart_row.id into v_chart_id from ehr.dental_chart_versions chart_row
       where chart_row.patient_id = requested_patient_id and chart_row.facility_id = caller.actor_facility
         and chart_row.entered_in_error_at is null
       order by (chart_row.dental_visit_id = v_visit_id) desc, chart_row.version_no desc limit 1;
      select coalesce(array_agg(procedure_row.id order by procedure_row.done_at, procedure_row.id), array[]::uuid[])
        into v_done
        from ehr.dental_procedures procedure_row
       where procedure_row.done_encounter_id = requested_encounter_id
         and procedure_row.facility_id = caller.actor_facility and procedure_row.status = 'done';
      select coalesce(array_agg(procedure_row.id order by procedure_row.planned_at, procedure_row.id), array[]::uuid[])
        into v_planned
        from ehr.dental_procedures procedure_row
       where procedure_row.patient_id = requested_patient_id and procedure_row.facility_id = caller.actor_facility
         and procedure_row.status = 'planned';
    end work;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, requested_patient_id, 'ehr.dental.summary.print',
      case when v_refusal is null then 'success' else 'denied' end, 'dental-visit', v_visit_id::text,
      caller.actor_purpose, 'application', 'ehr-api',
      jsonb_strip_nulls(jsonb_build_object('encounterId', requested_encounter_id, 'refusal', v_refusal,
        'chartVersionId', v_chart_id, 'doneThisVisitCount', cardinality(v_done),
        'plannedCount', cardinality(v_planned))));
    if v_refusal is not null then
      outcome := v_refusal;
      return next;
      return;
    end if;
    outcome := 'found';
    patient := (select card.card from ehr.dental_cards('patient', array[requested_patient_id], caller.actor_facility) card);
    facility_name := (select facility.name from identity.facilities facility where facility.id = caller.actor_facility);
    visit := (select card.card from ehr.dental_cards('visit', array[v_visit_id], caller.actor_facility) card);
    encounter := jsonb_build_object(
      'startedAt', to_char(v_encounter.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endedAt', to_char(v_encounter.ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'status', v_encounter.status, 'chiefComplaint', v_encounter.chief_complaint);
    chart := (select card.card from ehr.dental_cards('chart', array[v_chart_id], caller.actor_facility) card);
    done_this_visit := (select coalesce(jsonb_agg(card.card order by card.ord), '[]'::jsonb)
                          from ehr.dental_cards('procedure', v_done, caller.actor_facility) card);
    planned_procedures := (select coalesce(jsonb_agg(card.card order by card.ord), '[]'::jsonb)
                             from ehr.dental_cards('procedure', v_planned, caller.actor_facility) card);
    list_status := case when exists (select 1 from ehr.dental_list_versions list_version
                                      where list_version.active and list_version.status = 'draft')
                        then 'draft' else 'signed' end;
    printed_at := v_now;
    return next;
  end
  $fn$;

  -- Comments on the route functions.
  comment on function ehr.dental_lists() is
    '0195 (DEN-1, route 1): the active dental lists (tooth conditions, procedures, anaesthetic agents, techniques) with their version label and draft or signed status. Needs ehr.dental.read, direct care. No patient; no audit row.';
  comment on function ehr.dental_visit_start(uuid, uuid, text, text) is
    '0195 (DEN-1, route 2): start the dental record on this patient''s open outpatient visit at this facility (started or already_started). Needs ehr.dental.write and write consent (ehr.context_allows). Idempotent per membership and key. Audited (ehr.dental.visit.start).';
  comment on function ehr.dental_visit_read(uuid, uuid) is
    '0195 (DEN-1, route 3): the visit''s dental record: the visit with its derived stage, the newest chart at this facility, this visit''s chart versions, the open treatment plan and the procedures done in this visit. Needs ehr.dental.read and read consent. Audited (ehr.dental.visit.read).';
  comment on function ehr.dental_visit_follow_up(uuid, uuid, bigint, boolean, date, boolean, text, text, text) is
    '0195 (DEN-1, route 4): set or clear the follow-up date (tomorrow to two years ahead, Lagos days) and recall note, also after the visit is completed. Needs ehr.dental.write, write consent and the row version. Audited (ehr.dental.visit.follow-up; never the date or note).';
  comment on function ehr.dental_visits_list(integer) is
    '0195 (DEN-1, route 5): this facility''s dental visits started in the last 1-30 Lagos days, newest first, at most 200, only patients the member may read now for direct care (the rest counted in hidden_count). Needs ehr.dental.read. Audited: one ehr.dental.visit.list row and one ehr.dental.visit.list.shown row per patient shown.';
  comment on function ehr.dental_chart_read(uuid, uuid) is
    '0195 (DEN-1, route 6): the newest dental chart of the patient at this facility (or the version asked for) and the list of versions. Needs ehr.dental.read and read consent. Audited (ehr.dental.chart.read).';
  comment on function ehr.dental_chart_save(uuid, uuid, uuid, text, jsonb, text, text, text) is
    '0195 (DEN-1, route 7): save a new chart version based on the newest one (chart_changed when another came first), FDI teeth of the dentition, conditions of the active list, surfaces only where the condition takes them. Needs ehr.dental.write, write consent, the dental record started on this open visit. Audited (ehr.dental.chart.save: version number and findings count only).';
  comment on function ehr.dental_chart_entered_in_error(uuid, uuid, text, text, text) is
    '0195 (DEN-1, route 8): mark the newest chart version entered in error with a reason; the one before it is the newest again. Needs ehr.dental.write and write consent. Audited (never the reason).';
  comment on function ehr.dental_procedure_record(uuid, uuid, text, text, text, text, smallint, text, smallint, text, timestamptz, text, text, text, numeric, text, text, text) is
    '0195 (DEN-1, route 9): plan a procedure, or record one done and signed by the caller with its local anaesthetic (Q-DEN-6 A); a listed code (its site is the list''s) or a name typed (Q-DEN-5 A, with its site). Needs ehr.dental.write, write consent, the dental record started on this open visit. Audited (ehr.dental.procedure.plan or .done; never a code, name, anaesthetic or note).';
  comment on function ehr.dental_procedure_done(uuid, uuid, uuid, bigint, timestamptz, text, text, text, numeric, boolean, text, boolean, text, text, text) is
    '0195 (DEN-1, route 10): record a planned procedure (of this or an earlier visit here) as done in this visit, signed by the caller, with its local anaesthetic. Needs ehr.dental.write, write consent, the row version, the dental record started on this open visit. Audited (ehr.dental.procedure.done).';
  comment on function ehr.dental_procedure_cancel(uuid, uuid, bigint, text, text, text) is
    '0195 (DEN-1, route 11): cancel a planned procedure with a reason, at any time. Needs ehr.dental.write, write consent and the row version. Audited (never the reason).';
  comment on function ehr.dental_procedure_entered_in_error(uuid, uuid, bigint, text, text, text) is
    '0195 (DEN-1, route 12, Q-DEN-4 A): mark a done procedure entered in error with a reason, only by the member who signed it. Needs ehr.dental.write, write consent and the row version. Audited (never the reason).';
  comment on function ehr.dental_procedures_list(uuid, text) is
    '0195 (DEN-1, route 13): the patient''s dental procedures at this facility (planned, done or all), newest first, at most 200. Needs ehr.dental.read and read consent. Audited (ehr.dental.procedure.list).';
  comment on function ehr.dental_summary_read(uuid, uuid) is
    '0195 (DEN-1, route 14): the dental part of the printable visit summary (the patient card, the facility name, the visit, the encounter''s times, status and chief complaint, the chart, the procedures done in this visit, the open treatment plan, whether a list is still a draft). Needs ehr.dental.read and read consent. Audited as a print (ehr.dental.summary.print).';

  -- Owners and EXECUTE (as 0135: the owner of identity.has_active_consent_grant).
  if v_owner <> current_user then
    execute (select string_agg(format('alter table %s owner to %I', name, v_owner), '; ') from unnest(v_tables) name);
    execute (select string_agg(format('alter function %s owner to %I', name, v_owner), '; ')
               from unnest(v_routes || v_helpers || v_guards) name);
  end if;
  execute 'revoke all on function ' || array_to_string(v_routes || v_helpers || v_guards, ', ') || ' from public';
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    execute 'grant execute on function ' || array_to_string(v_routes, ', ') || ' to hid_ehr_runtime';
  end if;

  -- 3. Post-checks. The catalog's text forms (regclass, constraint, index, policy and trigger definitions) name
  -- objects relative to the search_path, so it is fixed for the checks and put back after them.
  perform set_config('search_path', 'pg_catalog, pg_temp', true);
  -- Tables, columns, constraints and indexes as made.
  select md5(string_agg(attribute_row.attrelid::regclass::text || '.' || attribute_row.attname || ' '
                        || format_type(attribute_row.atttypid, attribute_row.atttypmod) || ' '
                        || attribute_row.attnotnull::text || ' ' || coalesce(pg_get_expr(default_row.adbin, default_row.adrelid), ''),
                        ',' order by attribute_row.attrelid::regclass::text collate "C", attribute_row.attnum))
    into v_found
    from pg_attribute attribute_row
    left join pg_attrdef default_row on default_row.adrelid = attribute_row.attrelid
     and default_row.adnum = attribute_row.attnum
   where attribute_row.attrelid in (select to_regclass(name) from unnest(v_tables) name)
     and attribute_row.attnum > 0 and not attribute_row.attisdropped;
  if v_found is distinct from v_columns_md5 then
    raise exception using errcode = '55000', message = '0195: post-check failed (the columns): ' || v_found;
  end if;
  select md5(string_agg(constraint_row.conrelid::regclass::text || '.' || constraint_row.conname || ' '
                        || pg_get_constraintdef(constraint_row.oid) || ' ' || constraint_row.convalidated::text,
                        ',' order by constraint_row.conrelid::regclass::text collate "C",
                        constraint_row.conname collate "C"))
    into v_found
    from pg_constraint constraint_row
   where constraint_row.conrelid in (select to_regclass(name) from unnest(v_tables) name);
  if v_found is distinct from v_constraints_md5 then
    raise exception using errcode = '55000', message = '0195: post-check failed (the constraints): ' || v_found;
  end if;
  select md5(string_agg(pg_get_indexdef(index_row.indexrelid), ',' order by pg_get_indexdef(index_row.indexrelid) collate "C"))
    into v_found
    from pg_index index_row
   where index_row.indrelid in (select to_regclass(name) from unnest(v_tables) name);
  if v_found is distinct from v_indexes_md5 then
    raise exception using errcode = '55000', message = '0195: post-check failed (the indexes): ' || v_found;
  end if;
  -- Row-level security: enabled and forced on the patient tables, not enabled on the two lists; the policies.
  if (select count(*) from pg_class relation
       where relation.oid in (select to_regclass(name) from unnest(v_patient_tables) name)
         and relation.relrowsecurity and relation.relforcerowsecurity) <> 5
     or exists (select 1 from pg_class relation
                 where relation.oid in ('ehr.dental_list_versions'::regclass, 'ehr.dental_list_items'::regclass)
                   and (relation.relrowsecurity or relation.relforcerowsecurity)) then
    raise exception using errcode = '55000', message = '0195: post-check failed (row-level security)';
  end if;
  select md5(string_agg(policy_row.polrelid::regclass::text || '.' || policy_row.polname || ' '
                        || policy_row.polcmd::text || ' ' || policy_row.polpermissive::text || ' '
                        || policy_row.polroles::text || ' ' || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '')
                        || ' ' || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), ''),
                        ',' order by policy_row.polrelid::regclass::text collate "C"))
    into v_found
    from pg_policy policy_row
   where policy_row.polrelid in (select to_regclass(name) from unnest(v_tables) name);
  if v_found is distinct from v_policies_md5 then
    raise exception using errcode = '55000', message = '0195: post-check failed (the policies): ' || v_found;
  end if;
  -- No privilege for any role but the owner on any table; every table owned by the owner of 0135's functions.
  if exists (select 1 from pg_class relation,
               lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
              where relation.oid in (select to_regclass(name) from unnest(v_tables) name)
                and acl.grantee <> relation.relowner)
     or (select count(*) from pg_class relation
          where relation.oid in (select to_regclass(name) from unnest(v_tables) name)
            and relation.relowner = (select oid from pg_roles where rolname = v_owner)) <> 7 then
    raise exception using errcode = '55000', message = '0195: post-check failed (the tables'' owner or privileges)';
  end if;
  -- The functions: owner, SECURITY DEFINER (routes and helpers; not the guards), fixed search_path, bodies.
  if (select count(*) from pg_proc proc
       where proc.oid in (select to_regprocedure(name) from unnest(v_routes || v_helpers) name)
         and proc.prosecdef and proc.proconfig = array['search_path=pg_catalog, pg_temp']
         and proc.proowner = (select oid from pg_roles where rolname = v_owner)) <> 16
     or (select count(*) from pg_proc proc
          where proc.oid in (select to_regprocedure(name) from unnest(v_guards) name)
            and not proc.prosecdef and proc.proconfig = array['search_path=pg_catalog, pg_temp']
            and proc.proowner = (select oid from pg_roles where rolname = v_owner)) <> 4
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr' and proc.proname like 'dental\_%') <> 20 then
    raise exception using errcode = '55000', message = '0195: post-check failed (the functions'' owner or security)';
  end if;
  select md5(string_agg(proc.proname || ':' || md5(proc.prosrc) || ':' || proc.prosecdef::text || ':'
                        || coalesce(proc.proconfig::text, ''), ',' order by proc.proname collate "C"))
    into v_found
    from pg_proc proc where proc.oid in (select to_regprocedure(name) from unnest(v_routes || v_helpers || v_guards) name);
  if v_found is distinct from v_functions_md5 then
    raise exception using errcode = '55000', message = '0195: post-check failed (the function bodies): ' || v_found;
  end if;
  -- EXECUTE: the route functions for hid_ehr_runtime only (where it exists); helpers and guards for no role.
  if exists (select 1 from pg_proc proc,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in (select to_regprocedure(name) from unnest(v_routes || v_helpers || v_guards) name)
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                     or acl.privilege_type <> 'EXECUTE'
                     or proc.oid not in (select to_regprocedure(name) from unnest(v_routes) name)))
     or (exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime')
         and (select count(*) from unnest(v_routes) name
               where has_function_privilege('hid_ehr_runtime', to_regprocedure(name), 'EXECUTE')) <> 14) then
    raise exception using errcode = '55000', message = '0195: post-check failed (EXECUTE)';
  end if;
  -- The triggers: name, events (pg_trigger.tgtype: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate),
  -- no WHEN condition (tgqual), no column list (tgattr), no arguments (tgnargs), the function (tgfoid), enabled.
  select md5(string_agg(trigger_row.tgrelid::regclass::text || '.' || trigger_row.tgname || ' '
                        || trigger_row.tgtype::text || ' ' || (trigger_row.tgqual is null)::text || ' '
                        || trigger_row.tgattr::text || ' ' || trigger_row.tgnargs::text || ' '
                        || trigger_row.tgfoid::regprocedure::text || ' ' || trigger_row.tgenabled::text,
                        ',' order by trigger_row.tgrelid::regclass::text collate "C", trigger_row.tgname collate "C"))
    into v_found
    from pg_trigger trigger_row
   where trigger_row.tgrelid in (select to_regclass(name) from unnest(v_tables) name) and not trigger_row.tgisinternal;
  if v_found is distinct from v_triggers_md5 then
    raise exception using errcode = '55000', message = '0195: post-check failed (the triggers): ' || v_found;
  end if;
  -- The seeded lists, and the patient tables empty.
  select md5(string_agg(list_version.id::text || ' ' || list_version.kind || ' ' || list_version.version_label || ' '
                        || list_version.status || ' ' || list_version.active::text || ' '
                        || coalesce(list_version.signed_at::text, '-') || ' '
                        || coalesce(list_version.sign_off_reference, '-'), ',' order by list_version.id))
    into v_found from ehr.dental_list_versions list_version;
  if v_found is distinct from v_versions_md5 then
    raise exception using errcode = '55000', message = '0195: post-check failed (the list versions): ' || v_found;
  end if;
  select md5(string_agg(item.version_id::text || ' ' || item.kind || ' ' || item.code || ' ' || item.label || ' '
                        || coalesce(item.category, '-') || ' ' || coalesce(item.site, '-') || ' '
                        || coalesce(item.takes_surfaces::text, '-') || ' ' || item.sort_order::text,
                        ',' order by item.version_id, item.code collate "C"))
    into v_found from ehr.dental_list_items item;
  if v_found is distinct from v_items_md5 or (select count(*) from ehr.dental_list_items) <> 59 then
    raise exception using errcode = '55000', message = '0195: post-check failed (the list items): ' || v_found;
  end if;
  if exists (select 1 from ehr.dental_visits) or exists (select 1 from ehr.dental_chart_versions)
     or exists (select 1 from ehr.dental_chart_findings) or exists (select 1 from ehr.dental_procedures)
     or exists (select 1 from ehr.dental_events) then
    raise exception using errcode = '55000', message = '0195: post-check failed (a patient table is not empty)';
  end if;

  perform set_config('search_path', v_saved_path, true);
  raise notice '0195: the dental record is installed (7 tables, the draft lists HID-DENT-2026-11-DRAFT: 16 tooth conditions, 30 procedures, 8 anaesthetic agents, 5 techniques; 14 route functions, 2 helpers, 4 guards). Only dentists (0194) can use it, and ehr-api serves it only while DENTAL_ENABLED is on.';
end
$den0195$;
