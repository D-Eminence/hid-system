-- 0197 QUAL-1 Quality and safety reporting: incidents, near misses, history,
-- corrective actions and quality leads (Release D, the department sprint the
-- owner approved on 25 November 2026). Written on staging-novu-ci-20261005 at
-- 0cfddcc9 (0001-0153 applied: Release A, B, C and E). The number is
-- provisional: numbers are given at merge, in release order, after the files
-- booked before it. This file reads nothing 0152-0196 create or change, so it
-- applies on 0001-0153 and on any later cut. The declaration in
-- config/production-schema-compatibility.json stays unsigned until the owner
-- signs this file. 0198 (who holds the two codes) is its own file.
--
-- Owner decisions (approved with the whole sheet on 25 November 2026,
-- hid-system#332): Q248 A (the reporter is named but confidential: stored,
-- shown only to managers, kept in the audit trail), Q249 A (an optional,
-- audited patient link, shown only to managers, only for a patient of this
-- facility), Q250 A (a fixed category list based on the WHO ICPS and a harm
-- scale of near miss plus five levels, shipped as a DRAFT list), Q251 A
-- (quality.incident.manage and named quality leads manage; doctors do not
-- manage as such), Q252 A ("patient or family told" is required for moderate
-- harm, severe harm and death), Q253 A (internal quality-improvement records:
-- nothing is deleted; legal sets the retention period later), Q155 A (no new
-- role), Q161 A (online only). Built at the recommended option, not yet
-- answered by the owner (docs/EHR_PLANNED_CONTRACT.md, QUAL-1): Q-QUAL-1 A
-- (quality leads are a list per facility, not a role), Q-QUAL-2 A (the patient
-- is linked by the patient id of the page the report was started from),
-- Q-QUAL-3 A (the patient link has its own switch, seeded off), Q-QUAL-4 A
-- (the reviewer sees neither the reporter nor the patient), Q-QUAL-5 A (the
-- reporter sees status only), Q-QUAL-6 A (resolve needs every action done or
-- cancelled), Q-QUAL-7 A (exact counts), Q-QUAL-8 A (a patient of this
-- facility is 0131's basis with 0145's unknown records, or a visit or a
-- waiting-list check-in here within 90 days).
--
-- Not a choice: the category words, their hints and the harm scale ship as
-- the DRAFT list QS-DRAFT-1 (owner decision Q124 A for clinical lists): the
-- clinical lead signs them, and Ola writes the medication category's words,
-- which the clinical lead countersigns (Q157 A, Q158 A). A signed migration
-- loads the signed version, with the approval reference, before the
-- production flag goes on. The codes are fixed here; only the words change.
--
-- What it changes. It changes no existing table, function, policy, trigger or
-- row; everything below is new (schema ehr):
-- Q1 ehr.quality_list_versions   the list versions: list_version (key),
--                                status (draft or signed), active (exactly one
--                                active, a unique partial index), the clinical
--                                lead's approval reference (null exactly for a
--                                draft), loaded_by_migration, created_at.
--                                Seeded: QS-DRAFT-1, draft, active.
-- Q2 ehr.quality_list_items      the words of each version: list_kind
--                                (category or harm_level), code (CHECKed
--                                against the fixed codes of its kind),
--                                position, label (2-80), hint (0-300),
--                                told_required (harm levels only; true exactly
--                                for moderate, severe and death). Seeded with
--                                the 16 draft rows. Append only.
-- Q3 ehr.quality_switches        patient_link, seeded off by migration 0197.
--                                Only a signed migration turns it on.
-- Q4 ehr.quality_leads           named quality leads: facility, membership,
--                                who named them and when, the naming's
--                                Idempotency-Key and request SHA-256; the end
--                                (when, who, a reason of 8-500 characters,
--                                its key and SHA-256). One active lead per
--                                facility and membership. Ended leads are
--                                kept; at most 10 active (the function).
-- Q5 ehr.quality_incidents       one row per report. The report as filed
--                                (facility, incident number, title, what
--                                happened, when and its Lagos day, the
--                                immediate action, who filed it and when, the
--                                list version) never changes (a trigger). The
--                                classification (category, harm level,
--                                department code, place in words, "patient or
--                                family told") is corrected only by a manager.
--                                The patient link (patient id, when, by whom).
--                                The workflow (status reported, assigned,
--                                investigated or resolved; reviewer;
--                                findings; resolution; reopened count). CHECKs
--                                for the codes, the place (a department, a
--                                place in words, or both), "told" at moderate
--                                harm and above, and the status. A row
--                                version. No delete.
-- Q6 ehr.quality_incident_actions  corrective actions (owner, due date,
--                                status open, done or cancelled, completion
--                                time exactly when done, a note required to
--                                cancel). The incident, facility, text and
--                                creator never change (a trigger). No delete.
-- Q7 ehr.quality_incident_events  the history: one row per change (reported,
--                                patient_linked, assigned, reassigned,
--                                investigation_recorded,
--                                investigation_amended, action_added,
--                                action_updated, resolved, reopened, corrected,
--                                patient_link_changed), numbered per incident,
--                                with the statuses before and after, who and
--                                when, the reason, the text written at that
--                                step, the coded values before and after
--                                (never a patient id), the action, the row
--                                version after, and the request's
--                                Idempotency-Key and SHA-256 (unique per
--                                membership and key). Append only.
--    Row-level security is ENABLED and FORCED on all seven tables, with one
--    policy each, for the owner only: on the five facility tables
--    current_user is the owner and facility_id is
--    platform.current_facility_id(), so even the owner's functions see only
--    the session facility's rows; on the list and switch tables current_user
--    is the owner. No privilege for any other role (all revoked from PUBLIC).
--    Guards (platform.reject_mutation() unless named): BEFORE TRUNCATE on all
--    seven; BEFORE UPDATE OR DELETE on the list items and the history; BEFORE
--    DELETE on the other five; ehr.quality_incident_fixed_fields() (BEFORE
--    UPDATE on incidents: the report as filed never changes, and every update
--    raises the row version by exactly one), ehr.quality_action_fixed_fields()
--    (BEFORE UPDATE on actions) and ehr.quality_lead_end_once() (BEFORE
--    UPDATE on leads: only the end, once). No identity column and no
--    sequence: keys are UUIDs, the incident number is the facility's highest
--    plus one under an advisory lock per facility, and the history number the
--    incident's highest plus one under the incident's row lock. So there is no
--    sequence to grant to anyone.
-- Q8 Fifteen SECURITY DEFINER functions, owned like 0135's (the owner of
--    identity.has_active_consent_grant), with search_path pg_catalog, pg_temp
--    and every table, function and type name schema-qualified; no temporary
--    table, no dynamic SQL, no name that could resolve to a temporary object;
--    all PL/pgSQL. EXECUTE for hid_ehr_runtime only (here when the role
--    exists, and in runtime-grants.sql): ehr.quality_me,
--    ehr.quality_incident_report, ehr.quality_incident_list,
--    ehr.quality_incident_read, ehr.quality_incident_assign,
--    ehr.quality_incident_investigate, ehr.quality_incident_action_add,
--    ehr.quality_incident_action_update, ehr.quality_incident_resolve,
--    ehr.quality_incident_reopen, ehr.quality_incident_correct,
--    ehr.quality_incident_counts, ehr.quality_lead_list,
--    ehr.quality_lead_name, ehr.quality_lead_end. Helpers no role may execute
--    (SECURITY INVOKER, called by the functions above as their owner):
--    ehr.quality_caller (the caller, whether a manager and on what basis, and
--    the facility's departments), ehr.quality_patient_of_facility (below),
--    ehr.quality_detail (the card, actions and history in the caller's view),
--    ehr.quality_audit, ehr.quality_idempotency and the three trigger
--    functions.
--    Each function checks the caller: the session's account, membership and
--    facility; an active membership here, not held by the cutover
--    (migration_hold_reason null); quality.incident.report; and the purpose
--    healthcare-operations. Manager steps also need quality.incident.manage,
--    or an active lead row for this membership and facility. Naming and
--    ending leads need quality.incident.manage itself. Without 0198 no role
--    holds a quality code, so every function refuses: the database half of
--    "built but switched off".
--    A patient of this facility (ehr.quality_patient_of_facility, Q-QUAL-8 A):
--    the patient is active; the seal allows it (a sealed demo or QA facility
--    links only its own sealed patients, a real facility never a sealed one);
--    and 0145's identity.own_facility_basis(patient, facility) is not null
--    (created_here, registered_here or visit_here), or a visit here
--    (ehr.encounters, not cancelled or entered in error, not imported paper
--    records) started in the last 90 days (recent_visit), or a waiting-list
--    row here (ehr.visit_queue, not cancelled) checked in within the last 90
--    days (recent_check_in). Anything else is refused, the same for every
--    reason. It reads no clinical content, and the link gives no chart
--    access. While ehr.quality_switches.patient_link is off, every new link
--    is refused as not available; clearing a link always works.
--    Who sees what (Q248 A, Q-QUAL-4 A, Q-QUAL-5 A): a manager sees every
--    incident of the facility with the reporter and the linked patient; the
--    current reviewer of an incident that is not resolved sees it without
--    the reporter or the patient; the reporter sees their own reports as
--    filed with status and dates, and the status changes of the history; a
--    member who is both reporter and reviewer gets the reviewer's view; anyone
--    else gets not_found, as for an incident that does not exist.
--    Every write locks the incident FOR UPDATE, checks its row version and
--    raises it by one; actions change under the incident's lock and version.
-- Q9 Audit, in the request's transaction (a refusal a function raises is
--    recorded by ehr-api's request audit; an answer that refuses is recorded
--    here): quality.incident.report, quality.incident.patient-link (the
--    patient in the patient column only when linked, changed or cleared; a
--    refused row names no patient), quality.incident.list,
--    quality.incident.read, quality.incident.assign,
--    quality.incident.investigation, quality.incident.action-add,
--    quality.incident.action-update, quality.incident.resolve,
--    quality.incident.reopen, quality.incident.correct,
--    quality.incident.counts-export, quality.lead.list, quality.lead.name,
--    quality.lead.end; purpose healthcare-operations. Rows hold ids, codes,
--    counts and outcomes; never a title, what happened, findings, a
--    resolution, an action's text or note, the place in words, a reason, a
--    name, a date of birth or a Health ID. This file itself writes no audit
--    row: it writes no row of any existing table.
--
-- Locks (measured with pg_locks before commit and compared by the migrations
-- suite), taken first, NOWAIT: SHARE ROW EXCLUSIVE on identity.facilities,
-- identity.patients and identity.staff_facility_memberships, the foreign keys
-- of the new, empty tables (writers wait a few milliseconds; readers go on).
-- Every function is PL/pgSQL, whose bodies are not checked against tables, so
-- creating them locks no existing relation. No ACCESS EXCLUSIVE lock on any
-- existing table. A busy table fails the attempt at once, and its
-- subtransaction releases what it took. The attempt is made 50 times, 100 ms
-- apart (about 5 seconds), so the file never waits for one of its locks while
-- holding the others; then 55P03 (nothing applied). When this transaction
-- already holds an earlier migration's locks that stop other sessions' reads
-- or writes (the runner's dry run applies every pending file in one
-- transaction), one attempt and no sleep: 55P03 at once, nothing applied.
-- Both refusals begin "0197: " and end "run the release again at a quieter
-- time", so the runner's dry run rolls back and tries again (#306). Other
-- waits are not NOWAIT, and the runner's lock_timeout ends each after 5
-- seconds (nothing applied): an index or catalog that maintenance holds, or
-- DDL in flight on a function this file reads.
--
-- Old images on this schema: nothing calls the new functions and nothing
-- existing changes, so Release E's images are unaffected. The new ehr-api on
-- a database without 0197 answers 503 QUALITY_NOT_AVAILABLE (42883, 42P01).
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- fifteen functions, the helpers, the seven tables and the three trigger
-- functions, once no report needs to be kept (Q253 A: none is deleted until
-- legal sets the retention period).
--
-- The whole file is one statement (do $quality0197$), so whatever raises in
-- it, however the file is run, applies nothing. Inside it the search_path is
-- pg_catalog, pg_temp, so every name below is schema-qualified and every
-- definition reads back the same whatever the runner's search_path; the
-- runner's search_path is put back at the end.
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): markers only of the earlier
--    files whose objects this file uses (0114's department codes and the
--    facility profile's departments; 0131 and 0145's own-facility basis,
--    md5-pinned at 0145's body; 0135's waiting list and the columns read;
--    0098 and 0123's four seal functions, md5-pinned; 0003's audit.events
--    columns written; auth.membership_has_permission and
--    platform.reject_mutation, md5-pinned as 0001-0153 leave them); the
--    functions' owner may read ehr.encounters under its forced row-level
--    security (0131's owner policy) and ehr.visit_queue. Other lanes' codes,
--    roles and CHECK values are never pinned. "0197: already applied" when
--    every object of this file is there exactly as it leaves it (the catalog
--    fingerprint below, and the grants); "0197: the schema is not in the
--    reviewed state" for any other state with a quality object.
-- 2. Q1-Q8.
-- 3. Post-checks in 0148's and 0152's form: each table's owner, row-level
--    security enabled and forced, its one policy (command, roles,
--    expression), and no privilege for any role but the owner; each
--    function's owner, SECURITY DEFINER (the fifteen) or not (the helpers),
--    proconfig exactly search_path=pg_catalog, pg_temp, EXECUTE exactly for
--    hid_ehr_runtime (the fifteen, when the role exists) or for no role (the
--    helpers); each trigger's tgtype, tgqual (null), tgattr (empty), tgnargs
--    (0), tgfoid and tgenabled (O); the version row, the 16 list rows and the
--    switch off; the catalog fingerprint; and no row of an existing table
--    written (this transaction's insert, update and delete counts of every
--    other user table are as before).

do $quality0197$
declare
  v_attempt integer := 0;
  v_holding boolean := exists (
    select 1 from pg_catalog.pg_locks held
      join pg_catalog.pg_class relation on relation.oid = held.relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_catalog.pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_catalog.pg_database database_row
                             where database_row.datname = pg_catalog.current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  v_search_path text := pg_catalog.current_setting('search_path');
  v_mismatch text;
  v_owner name;
  v_owner_oid oid;
  v_runtime_exists boolean;
  v_tables_present integer;
  v_functions_present integer;
  v_fingerprint text;
  v_grants_exact boolean;
  v_writes_before bigint;
  v_writes_after bigint;
  -- The catalog fingerprint of everything this file makes (tables, columns, defaults, constraints, indexes,
  -- triggers, policies with the owner's name replaced, table grants, functions with the md5 of each body), as
  -- this file leaves it. Function grants are checked on their own (hid_ehr_runtime may not exist yet).
  v_fingerprint_expected constant text := '6ba8b4a5a72ebf1802a78d46e464eded';
  -- The fifteen functions hid_ehr_runtime may execute.
  v_entry_points constant text[] := array[
    'ehr.quality_me()',
    'ehr.quality_incident_report(text,text,timestamp with time zone,text,text,text,text,text,text,uuid,text,text)',
    'ehr.quality_incident_list(text,text,text,text,date,date,text,integer,timestamp with time zone,uuid)',
    'ehr.quality_incident_read(uuid)',
    'ehr.quality_incident_assign(uuid,bigint,uuid,text,text)',
    'ehr.quality_incident_investigate(uuid,bigint,text,text,text)',
    'ehr.quality_incident_action_add(uuid,bigint,text,uuid,date,text,text)',
    'ehr.quality_incident_action_update(uuid,uuid,bigint,text,text,uuid,date,text,text)',
    'ehr.quality_incident_resolve(uuid,bigint,text,text,text)',
    'ehr.quality_incident_reopen(uuid,bigint,text,text,text)',
    'ehr.quality_incident_correct(uuid,bigint,text,text[],text,text,text,text,text,uuid,text,text)',
    'ehr.quality_incident_counts(text,text)',
    'ehr.quality_lead_list()',
    'ehr.quality_lead_name(uuid,text,text)',
    'ehr.quality_lead_end(uuid,text,text,text)'];
  -- The helpers no role may execute.
  v_helpers constant text[] := array[
    'ehr.quality_caller(text)',
    'ehr.quality_patient_of_facility(uuid,uuid)',
    'ehr.quality_detail(uuid,uuid,boolean)',
    'ehr.quality_audit(text,uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,jsonb)',
    'ehr.quality_idempotency(uuid,text,text)',
    'ehr.quality_incident_fixed_fields()',
    'ehr.quality_action_fixed_fields()',
    'ehr.quality_lead_end_once()'];
  v_tables constant text[] := array['ehr.quality_list_versions', 'ehr.quality_list_items', 'ehr.quality_switches',
    'ehr.quality_leads', 'ehr.quality_incidents', 'ehr.quality_incident_actions', 'ehr.quality_incident_events'];
  v_facility_tables constant text[] := array['ehr.quality_leads', 'ehr.quality_incidents',
    'ehr.quality_incident_actions', 'ehr.quality_incident_events'];
begin
  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table identity.facilities, identity.patients, identity.staff_facility_memberships
    in share row exclusive mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0197: identity.facilities, identity.patients or identity.staff_facility_memberships (the foreign '
          || 'keys of the new tables) is busy, and this transaction already holds an earlier migration''s locks, so '
          || 'it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0197: identity.facilities, identity.patients or identity.staff_facility_memberships (the foreign '
          || 'keys of the new tables) stayed busy for 5 seconds; nothing applied; run the release again at a quieter '
          || 'time';
    end if;
    perform pg_catalog.pg_sleep(0.1);
  end;
  end loop;

  -- Every definition below reads back the same whatever the runner's search_path (put back at the end).
  perform pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);

  -- 1. Preconditions.
  -- Markers of the files whose objects this file uses: 0003 (audit.events), 0114 (department codes and the
  -- facility profile), 0131/0145 (own-facility basis), 0135 (the waiting list), 0098/0123 (the seals).
  if to_regclass('migration.schema_migrations') is null
     or to_regclass('audit.events') is null
     or to_regprocedure('identity.facility_department_codes()') is null
     or to_regclass('identity.facility_profiles') is null
     or to_regprocedure('identity.own_facility_basis(uuid,uuid)') is null
     or to_regclass('ehr.visit_queue') is null
     or to_regclass('identity.unknown_patients') is null
     or to_regclass('identity.sealed_demo_members') is null
     or to_regclass('identity.sealed_qa_members') is null then
    raise exception using errcode = '55000', message = '0197: 0001-0153 must be applied first';
  end if;

  -- Exactly as this file leaves it, or nothing of it.
  select count(*) into v_tables_present
    from pg_class class_row
   where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
     and class_row.relkind in ('r', 'p', 'v', 'm', 'S', 'f');
  select count(*) into v_functions_present
    from pg_proc proc
   where proc.pronamespace = 'ehr'::regnamespace and proc.proname like 'quality\_%';
  if v_tables_present > 0 or v_functions_present > 0 then
    v_owner := (select pg_get_userbyid(proc.proowner) from pg_proc proc
                 where proc.oid = to_regprocedure(
                   'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'));
    v_owner_oid := (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner);
    select md5(coalesce(string_agg(part.line, E'\n' order by part.line collate "C"), '')) into v_fingerprint
      from (
        select 'table ' || class_row.relname || ' ' || class_row.relkind::text || ' rls=' || class_row.relrowsecurity
               || ' force=' || class_row.relforcerowsecurity || ' owner=' || (class_row.relowner = v_owner_oid)
               || ' acl=' || coalesce((select string_agg(case when acl.grantee = class_row.relowner then '<owner>'
                                                              when acl.grantee = 0 then 'public'
                                                              else pg_get_userbyid(acl.grantee) end
                                                         || ':' || acl.privilege_type, ',' order by 1)
                                         from aclexplode(coalesce(class_row.relacl,
                                                                  acldefault('r', class_row.relowner))) acl), '')
          from pg_class class_row
         where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
           and class_row.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
        union all
        select 'column ' || class_row.relname || ' ' || attribute_row.attnum || ' ' || attribute_row.attname || ' '
               || format_type(attribute_row.atttypid, attribute_row.atttypmod) || ' ' || attribute_row.attnotnull
               || ' ' || attribute_row.attidentity::text || attribute_row.attgenerated::text || ' '
               || coalesce(pg_get_expr(default_row.adbin, default_row.adrelid), '')
          from pg_class class_row
          join pg_attribute attribute_row on attribute_row.attrelid = class_row.oid
           and attribute_row.attnum > 0 and not attribute_row.attisdropped
          left join pg_attrdef default_row on default_row.adrelid = class_row.oid
           and default_row.adnum = attribute_row.attnum
         where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
           and class_row.relkind = 'r'
        union all
        select 'constraint ' || class_row.relname || ' ' || constraint_row.conname || ' '
               || pg_get_constraintdef(constraint_row.oid)
          from pg_constraint constraint_row
          join pg_class class_row on class_row.oid = constraint_row.conrelid
         where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
        union all
        select 'index ' || pg_get_indexdef(index_row.indexrelid)
          from pg_index index_row
          join pg_class class_row on class_row.oid = index_row.indrelid
         where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
        union all
        select 'trigger ' || class_row.relname || ' ' || trigger_row.tgname || ' ' || trigger_row.tgtype || ' '
               || trigger_row.tgfoid::regprocedure::text || ' ' || trigger_row.tgenabled::text || ' '
               || (trigger_row.tgqual is null) || ' ' || trigger_row.tgattr::text || ' ' || trigger_row.tgnargs
          from pg_trigger trigger_row
          join pg_class class_row on class_row.oid = trigger_row.tgrelid
         where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
           and not trigger_row.tgisinternal
        union all
        select 'policy ' || class_row.relname || ' ' || policy_row.polname || ' ' || policy_row.polcmd::text || ' '
               || policy_row.polpermissive || ' '
               || coalesce((select string_agg(case when role_id = v_owner_oid then '<owner>'
                                                   when role_id = 0 then 'public'
                                                   else pg_get_userbyid(role_id) end, ',' order by 1)
                              from unnest(policy_row.polroles) role_id), '') || ' '
               || replace(coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), ''),
                          quote_literal(v_owner), '<owner>') || ' '
               || replace(coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), ''),
                          quote_literal(v_owner), '<owner>')
          from pg_policy policy_row
          join pg_class class_row on class_row.oid = policy_row.polrelid
         where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
        union all
        select 'function ' || proc.oid::regprocedure::text || ' ' || md5(proc.prosrc) || ' ' || proc.prosecdef
               || ' ' || proc.provolatile::text || ' ' || coalesce(array_to_string(proc.proconfig, ';'), '') || ' owner='
               || (proc.proowner = v_owner_oid) || ' ' || language_row.lanname || ' '
               || pg_get_function_result(proc.oid)
          from pg_proc proc
          join pg_language language_row on language_row.oid = proc.prolang
         where proc.pronamespace = 'ehr'::regnamespace and proc.proname like 'quality\_%'
      ) part(line);
    -- EXECUTE: hid_ehr_runtime alone (or nobody, before the role exists) on the fifteen; nobody on the helpers.
    select not exists (
             select 1 from pg_proc proc,
                    lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.pronamespace = 'ehr'::regnamespace and proc.proname like 'quality\_%'
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                     or acl.privilege_type <> 'EXECUTE'
                     or not proc.oid::regprocedure::text = any (v_entry_points)))
      into v_grants_exact;
    if v_tables_present = 7 and v_functions_present = 23 and v_fingerprint = v_fingerprint_expected
       and v_grants_exact then
      raise exception using errcode = '55000', message = '0197: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0197: the schema is not in the reviewed state (part of 0197 is there, or not exactly as 0197 '
        || 'leaves it); nothing applied';
  end if;

  -- The bodies this file calls, as 0001-0153 leave them.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_mismatch
    from (values
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.own_facility_basis(uuid,uuid)', '16ec336ac3633a295bc4a89f0e9f7542'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0197: these bodies are not as 0001-0153 left them: ' || v_mismatch;
  end if;
  if to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_correlation_id()') is null
     or to_regprocedure('platform.current_purpose_of_use()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null
     or to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)') is null
     or (select proc.prorettype from pg_proc proc
          where proc.oid = to_regprocedure('identity.facility_department_codes()')) <> 'text[]'::regtype
     or (select proc.prorettype from pg_proc proc
          where proc.oid = to_regprocedure('identity.own_facility_basis(uuid,uuid)')) <> 'text'::regtype then
    raise exception using errcode = '55000', message = '0197: a function this file calls is missing or not as made';
  end if;
  -- The columns this file reads or writes in existing tables, by name and type.
  select string_agg(wanted.relation || '.' || wanted.column_name, ', ' order by wanted.relation, wanted.column_name)
    into v_mismatch
    from (values
      ('audit.events', 'correlation_id', 'text'), ('audit.events', 'actor_type', 'text'),
      ('audit.events', 'actor_subject', 'text'), ('audit.events', 'actor_account_id', 'uuid'),
      ('audit.events', 'actor_membership_id', 'uuid'), ('audit.events', 'organization_id', 'uuid'),
      ('audit.events', 'facility_id', 'uuid'), ('audit.events', 'patient_id', 'uuid'),
      ('audit.events', 'action', 'text'), ('audit.events', 'outcome', 'text'),
      ('audit.events', 'resource_type', 'text'), ('audit.events', 'resource_id', 'text'),
      ('audit.events', 'purpose_of_use', 'text'), ('audit.events', 'provenance', 'text'),
      ('audit.events', 'source_system', 'text'), ('audit.events', 'details', 'jsonb'),
      ('identity.facility_profiles', 'facility_id', 'uuid'), ('identity.facility_profiles', 'departments', 'text[]'),
      ('identity.facilities', 'id', 'uuid'),
      ('identity.patients', 'id', 'uuid'), ('identity.patients', 'status', 'text'),
      ('identity.patients', 'full_name', 'text'), ('identity.patients', 'gender', 'text'),
      ('identity.patients', 'dob', 'date'), ('identity.patients', 'hid_code', 'text'),
      ('identity.unknown_patients', 'patient_id', 'uuid'), ('identity.unknown_patients', 'status', 'text'),
      ('identity.unknown_patients', 'label', 'text'),
      ('identity.staff_facility_memberships', 'id', 'uuid'),
      ('identity.staff_facility_memberships', 'account_id', 'uuid'),
      ('identity.staff_facility_memberships', 'organization_id', 'uuid'),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid'),
      ('identity.staff_facility_memberships', 'active', 'boolean'),
      ('identity.staff_facility_memberships', 'migration_hold_reason', 'text'),
      ('auth.accounts', 'id', 'uuid'), ('auth.accounts', 'subject', 'text'),
      ('ehr.encounters', 'patient_id', 'uuid'), ('ehr.encounters', 'facility_id', 'uuid'),
      ('ehr.encounters', 'status', 'text'), ('ehr.encounters', 'started_at', 'timestamp with time zone'),
      ('ehr.encounters', 'imported_paper_records', 'boolean'),
      ('ehr.visit_queue', 'patient_id', 'uuid'), ('ehr.visit_queue', 'facility_id', 'uuid'),
      ('ehr.visit_queue', 'stage', 'text'), ('ehr.visit_queue', 'checked_in_at', 'timestamp with time zone')
    ) wanted(relation, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = wanted.relation::regclass
                        and attribute_row.attname = wanted.column_name and attribute_row.attnum > 0
                        and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0197: these columns are not as 0001-0153 left them: ' || v_mismatch;
  end if;
  -- The functions' owner (0135's rule) may read ehr.encounters under its forced row-level security (0131's owner
  -- policy) and ehr.visit_queue (0135's, not forced).
  v_owner := (select pg_get_userbyid(proc.proowner) from pg_proc proc
               where proc.oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  v_owner_oid := (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner);
  if not pg_has_role(v_owner, (select class_row.relowner from pg_class class_row
                                where class_row.oid = 'ehr.encounters'::regclass), 'USAGE')
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'ehr.encounters'::regclass
                       and policy_row.polname = 'encounters_owner_read' and policy_row.polcmd in ('r', '*'))
     or not pg_has_role(v_owner, (select class_row.relowner from pg_class class_row
                                   where class_row.oid = 'ehr.visit_queue'::regclass), 'USAGE')
     or (select class_row.relforcerowsecurity from pg_class class_row
          where class_row.oid = 'ehr.visit_queue'::regclass) then
    raise exception using errcode = '55000',
      message = '0197: the owner of 0135''s functions cannot read ehr.encounters or ehr.visit_queue as 0131 and 0135 '
        || 'left them';
  end if;
  v_runtime_exists := exists (select 1 from pg_roles role_row where role_row.rolname = 'hid_ehr_runtime');
  -- This transaction's insert, update and delete counts of every existing user table, before.
  select coalesce(sum(stat.n_tup_ins + stat.n_tup_upd + stat.n_tup_del), 0) into v_writes_before
    from pg_stat_xact_user_tables stat;

  -- Q1. The list versions.
  create table ehr.quality_list_versions (
    list_version text primary key check (list_version ~ '^QS-[A-Z0-9]+(-[A-Z0-9]+)*$' and length(list_version) <= 40),
    status text not null check (status in ('draft', 'signed')),
    active boolean not null default false,
    approval_reference text check (approval_reference is null
      or (approval_reference = btrim(approval_reference) and length(approval_reference) between 3 and 200
          and approval_reference !~ '[[:cntrl:]]')),
    loaded_by_migration text not null check (loaded_by_migration ~ '^[0-9]{4}$'),
    created_at timestamptz not null default clock_timestamp(),
    -- A draft has no approval reference; a signed version always has the clinical lead's.
    constraint quality_list_versions_approval_ck check ((status = 'draft') = (approval_reference is null))
  );
  create unique index quality_list_versions_one_active_ux on ehr.quality_list_versions (active) where active;
  comment on table ehr.quality_list_versions is
    '0197 (QUAL-1, Q250 A): the versions of the incident category and harm lists. Exactly one is active. QS-DRAFT-1 is a draft awaiting the clinical lead''s sign-off (Q124 A); a signed migration loads the signed version, with its approval reference, before the production flag goes on. Only the quality functions read it, as its owner.';

  -- Q2. The words of each version (codes fixed here, words per version).
  create table ehr.quality_list_items (
    list_version text not null references ehr.quality_list_versions(list_version) on delete restrict,
    list_kind text not null check (list_kind in ('category', 'harm_level')),
    code text not null,
    position smallint not null check (position between 1 and 50),
    label text not null check (label = btrim(label) and length(label) between 2 and 80 and label !~ '[[:cntrl:]]'),
    hint text not null default '' check (hint = btrim(hint) and length(hint) <= 300 and hint !~ '[[:cntrl:]]'),
    told_required boolean,
    primary key (list_version, list_kind, code),
    constraint quality_list_items_position_ux unique (list_version, list_kind, position),
    constraint quality_list_items_code_ck check (
      (list_kind = 'category' and code in ('medication', 'patient_fall', 'identification_documentation',
        'procedure_treatment', 'infection_control', 'equipment_device', 'blood_transfusion', 'safety_security',
        'facility_environment', 'other'))
      or (list_kind = 'harm_level' and code in ('near_miss', 'no_harm', 'mild', 'moderate', 'severe', 'death'))),
    -- "Patient or family told" is required exactly for moderate harm, severe harm and death (Q252 A).
    constraint quality_list_items_told_ck check (
      (list_kind = 'harm_level') = (told_required is not null)
      and (list_kind <> 'harm_level' or told_required = (code in ('moderate', 'severe', 'death'))))
  );
  comment on table ehr.quality_list_items is
    '0197 (QUAL-1, Q250 A, Q252 A): the incident categories (based on the WHO ICPS incident types) and harm levels of each list version, with the words shown on the form. Append only. QS-DRAFT-1 is DRAFT: the clinical lead signs it, and Ola writes the medication category''s words (Q157 A, Q158 A).';

  -- Q3. The patient-link switch (Q-QUAL-3 A).
  create table ehr.quality_switches (
    key text primary key check (key in ('patient_link')),
    enabled boolean not null default false,
    changed_by_migration text not null check (changed_by_migration ~ '^[0-9]{4}$'),
    changed_at timestamptz not null default clock_timestamp()
  );
  comment on table ehr.quality_switches is
    '0197 (QUAL-1, Q-QUAL-3 A): patient_link, seeded off. While off, a new patient link on a report or a correction is refused as not available (clearing a link always works). Only a signed migration turns it on, after the DPO''s review.';

  -- Q4. Named quality leads (Q-QUAL-1 A).
  create table ehr.quality_leads (
    id uuid primary key default pg_catalog.gen_random_uuid(),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    named_at timestamptz not null default clock_timestamp(),
    named_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    name_idempotency_key text not null check (name_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    name_request_sha256 text not null check (name_request_sha256 ~ '^[0-9a-f]{64}$'),
    ended_at timestamptz,
    ended_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    end_reason text check (end_reason is null
      or (end_reason = btrim(end_reason, E' \t\r\n') and length(end_reason) between 8 and 500
          and translate(end_reason, E'\t\r\n', '') !~ '[[:cntrl:]]')),
    end_idempotency_key text check (end_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    end_request_sha256 text check (end_request_sha256 ~ '^[0-9a-f]{64}$'),
    constraint quality_leads_end_ck check (
      (ended_at is null) = (ended_by_membership_id is null) and (ended_at is null) = (end_reason is null)
      and (ended_at is null) = (end_idempotency_key is null) and (ended_at is null) = (end_request_sha256 is null)
      and (ended_at is null or ended_at >= named_at))
  );
  create unique index quality_leads_active_ux on ehr.quality_leads (facility_id, membership_id) where ended_at is null;
  create unique index quality_leads_name_key_ux on ehr.quality_leads (named_by_membership_id, name_idempotency_key);
  create unique index quality_leads_end_key_ux on ehr.quality_leads (ended_by_membership_id, end_idempotency_key)
    where end_idempotency_key is not null;
  comment on table ehr.quality_leads is
    '0197 (QUAL-1, Q251 A, Q-QUAL-1 A): the quality leads the facility administrator names (at most 10 active per facility). An active lead whose membership is active and not held has a manager''s rights at that facility. Ended leads are kept. Only the quality functions read and write it, as its owner, and only the session facility''s rows.';

  -- Q5. The incidents.
  create table ehr.quality_incidents (
    id uuid primary key default pg_catalog.gen_random_uuid(),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    incident_number integer not null check (incident_number > 0),
    -- The report as filed (fixed after insert by ehr.quality_incident_fixed_fields).
    title text not null check (title = btrim(title) and length(title) between 3 and 120 and title !~ '[[:cntrl:]]'),
    description text not null check (description = btrim(description, E' \t\r\n')
      and length(description) between 10 and 4000 and translate(description, E'\t\r\n', '') !~ '[[:cntrl:]]'),
    occurred_at timestamptz not null,
    occurred_day date not null,
    immediate_action text check (immediate_action is null
      or (immediate_action = btrim(immediate_action, E' \t\r\n') and length(immediate_action) between 2 and 2000
          and translate(immediate_action, E'\t\r\n', '') !~ '[[:cntrl:]]')),
    reported_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    reported_at timestamptz not null default clock_timestamp(),
    list_version text not null references ehr.quality_list_versions(list_version) on delete restrict,
    -- The classification (a manager corrects it, with a reason).
    category text not null check (category in ('medication', 'patient_fall', 'identification_documentation',
      'procedure_treatment', 'infection_control', 'equipment_device', 'blood_transfusion', 'safety_security',
      'facility_environment', 'other')),
    harm_level text not null check (harm_level in ('near_miss', 'no_harm', 'mild', 'moderate', 'severe', 'death')),
    department_code text check (department_code is null
      or department_code = any (identity.facility_department_codes())),
    location_text text check (location_text is null
      or (location_text = btrim(location_text) and length(location_text) between 2 and 120
          and location_text !~ '[[:cntrl:]]')),
    patient_or_family_told text check (patient_or_family_told is null
      or patient_or_family_told in ('yes', 'no', 'not_applicable')),
    -- The patient link (Q249 A; shown only to managers).
    patient_id uuid references identity.patients(id) on delete restrict,
    patient_linked_at timestamptz,
    patient_linked_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    -- The workflow.
    status text not null default 'reported' check (status in ('reported', 'assigned', 'investigated', 'resolved')),
    reviewer_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    assigned_at timestamptz,
    assigned_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    investigation_findings text check (investigation_findings is null
      or (investigation_findings = btrim(investigation_findings, E' \t\r\n')
          and length(investigation_findings) between 10 and 4000
          and translate(investigation_findings, E'\t\r\n', '') !~ '[[:cntrl:]]')),
    investigated_at timestamptz,
    investigated_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    resolution text check (resolution is null
      or (resolution = btrim(resolution, E' \t\r\n') and length(resolution) between 10 and 2000
          and translate(resolution, E'\t\r\n', '') !~ '[[:cntrl:]]')),
    resolved_at timestamptz,
    resolved_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    reopened_count integer not null default 0 check (reopened_count >= 0),
    updated_at timestamptz not null default clock_timestamp(),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    row_version bigint not null default 1 check (row_version > 0),
    constraint quality_incidents_number_ux unique (facility_id, incident_number),
    constraint quality_incidents_facility_ux unique (id, facility_id),
    -- The Lagos day of the time it happened (the monthly count uses it); up to a year before the report, not after.
    constraint quality_incidents_day_ck check (occurred_day = (occurred_at at time zone 'Africa/Lagos')::date),
    constraint quality_incidents_time_ck check (
      occurred_at <= reported_at and occurred_at >= reported_at - interval '365 days'),
    -- Where it happened: a department, a place in words, or both.
    constraint quality_incidents_place_ck check (department_code is not null or location_text is not null),
    -- Q252 A: "patient or family told" for moderate harm, severe harm and death.
    constraint quality_incidents_told_ck check (
      harm_level not in ('moderate', 'severe', 'death') or patient_or_family_told is not null),
    constraint quality_incidents_link_ck check (
      (patient_id is null) = (patient_linked_at is null)
      and (patient_id is null) = (patient_linked_by_membership_id is null)),
    -- A reviewer for assigned, investigated and resolved; findings for investigated and resolved; a resolution
    -- exactly when resolved; who and when exactly with each.
    constraint quality_incidents_workflow_ck check (
      (status = 'reported') = (reviewer_membership_id is null)
      and (reviewer_membership_id is null) = (assigned_at is null)
      and (reviewer_membership_id is null) = (assigned_by_membership_id is null)
      and (status not in ('investigated', 'resolved') or investigation_findings is not null)
      and (status <> 'reported' or investigation_findings is null)
      and (investigation_findings is null) = (investigated_at is null)
      and (investigation_findings is null) = (investigated_by_membership_id is null)
      and (status = 'resolved') = (resolution is not null)
      and (resolution is null) = (resolved_at is null)
      and (resolution is null) = (resolved_by_membership_id is null))
  );
  create index quality_incidents_reported_idx on ehr.quality_incidents (facility_id, reported_at desc, id desc);
  create index quality_incidents_status_idx on ehr.quality_incidents (facility_id, status);
  create index quality_incidents_reporter_idx on ehr.quality_incidents (facility_id, reported_by_membership_id);
  create index quality_incidents_reviewer_idx on ehr.quality_incidents (facility_id, reviewer_membership_id)
    where status <> 'resolved';
  create index quality_incidents_day_idx on ehr.quality_incidents (facility_id, occurred_day);
  -- For ID-8's merge, when built: a merge must move the link to the kept record.
  create index quality_incidents_patient_idx on ehr.quality_incidents (patient_id) where patient_id is not null;
  comment on table ehr.quality_incidents is
    '0197 (QUAL-1, Q248 A-Q253 A): one row per incident or near-miss report. The report as filed (title, what happened, when, immediate action, who filed it) never changes; a manager corrects the classification and the patient link with a reason. Confidential: only the quality functions read it, as its owner, and only the session facility''s rows; they show the reporter and the patient to managers only. Never deleted (Q253 A).';

  -- Q6. Corrective actions.
  create table ehr.quality_incident_actions (
    id uuid primary key default pg_catalog.gen_random_uuid(),
    incident_id uuid not null,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    description text not null check (description = btrim(description, E' \t\r\n')
      and length(description) between 5 and 500 and translate(description, E'\t\r\n', '') !~ '[[:cntrl:]]'),
    owner_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    due_date date not null,
    status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
    completed_at timestamptz,
    note text check (note is null
      or (note = btrim(note, E' \t\r\n') and length(note) between 2 and 500
          and translate(note, E'\t\r\n', '') !~ '[[:cntrl:]]')),
    created_at timestamptz not null default clock_timestamp(),
    created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    constraint quality_incident_actions_incident_fk foreign key (incident_id, facility_id)
      references ehr.quality_incidents(id, facility_id) on delete restrict,
    constraint quality_incident_actions_facility_ux unique (id, facility_id),
    constraint quality_incident_actions_done_ck check ((status = 'done') = (completed_at is not null)),
    constraint quality_incident_actions_cancel_ck check (status <> 'cancelled' or note is not null)
  );
  create index quality_incident_actions_incident_idx on ehr.quality_incident_actions (incident_id, created_at, id);
  comment on table ehr.quality_incident_actions is
    '0197 (QUAL-1, Q-QUAL-6 A): corrective actions of an incident, each with an owner from the facility''s staff and a due date; done sets the completion time; cancelling needs a note. The incident, facility, text and creator never change. Kept, never deleted. Only the quality functions read and write it, as its owner.';

  -- Q7. The history.
  create table ehr.quality_incident_events (
    id uuid primary key default pg_catalog.gen_random_uuid(),
    incident_id uuid not null,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    event_no integer not null check (event_no > 0),
    kind text not null check (kind in ('reported', 'patient_linked', 'assigned', 'reassigned',
      'investigation_recorded', 'investigation_amended', 'action_added', 'action_updated', 'resolved', 'reopened',
      'corrected', 'patient_link_changed')),
    from_status text check (from_status is null
      or from_status in ('reported', 'assigned', 'investigated', 'resolved')),
    to_status text not null check (to_status in ('reported', 'assigned', 'investigated', 'resolved')),
    by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    at timestamptz not null default clock_timestamp(),
    reason text check (reason is null
      or (reason = btrim(reason, E' \t\r\n') and length(reason) between 8 and 500
          and translate(reason, E'\t\r\n', '') !~ '[[:cntrl:]]')),
    text_value text check (text_value is null
      or (length(text_value) between 2 and 4000 and translate(text_value, E'\t\r\n', '') !~ '[[:cntrl:]]')),
    changes jsonb not null default '{}'::jsonb,
    action_id uuid,
    row_version_after bigint not null check (row_version_after > 0),
    idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 text check (request_sha256 ~ '^[0-9a-f]{64}$'),
    constraint quality_incident_events_incident_fk foreign key (incident_id, facility_id)
      references ehr.quality_incidents(id, facility_id) on delete restrict,
    constraint quality_incident_events_action_fk foreign key (action_id, facility_id)
      references ehr.quality_incident_actions(id, facility_id) on delete restrict,
    constraint quality_incident_events_number_ux unique (incident_id, event_no),
    constraint quality_incident_events_from_ck check ((kind = 'reported') = (from_status is null)),
    constraint quality_incident_events_reason_ck check (
      (kind in ('reopened', 'corrected', 'patient_link_changed')) = (reason is not null)),
    constraint quality_incident_events_text_ck check (
      (kind not in ('investigation_recorded', 'investigation_amended', 'resolved', 'action_added')
       or text_value is not null)
      and (kind in ('investigation_recorded', 'investigation_amended', 'resolved', 'action_added', 'action_updated')
           or text_value is null)),
    constraint quality_incident_events_action_ck check (
      (kind in ('action_added', 'action_updated')) = (action_id is not null)),
    -- Coded values before and after; never a patient.
    constraint quality_incident_events_changes_ck check (
      jsonb_typeof(changes) = 'object' and not (changes ?| array['patientId', 'patient', 'patient_id'])),
    constraint quality_incident_events_key_ck check ((idempotency_key is null) = (request_sha256 is null))
  );
  create unique index quality_incident_events_key_ux on ehr.quality_incident_events (by_membership_id, idempotency_key)
    where idempotency_key is not null;
  create index quality_incident_events_action_idx on ehr.quality_incident_events (action_id) where action_id is not null;
  comment on table ehr.quality_incident_events is
    '0197 (QUAL-1): the history of each incident, numbered per incident: every report, link, assignment, investigation, action, resolution, reopening and correction, with the text written at that step, the coded values before and after (never a patient), and the request''s Idempotency-Key and SHA-256. Append only. Only the quality functions read and write it, as its owner.';

  -- The DRAFT list QS-DRAFT-1 (Q250 A, Q124 A), and the patient-link switch off (Q-QUAL-3 A). Written before
  -- row-level security is forced, by this file as the tables' owner.
  insert into ehr.quality_list_versions (list_version, status, active, approval_reference, loaded_by_migration)
  values ('QS-DRAFT-1', 'draft', true, null, '0197');
  insert into ehr.quality_list_items (list_version, list_kind, code, position, label, hint, told_required) values
    ('QS-DRAFT-1', 'category', 'medication', 1, 'Medication',
     'Wrong medicine, dose, strength, route, time or patient; a dose missed or given twice; a dispensing or labelling error; a known allergy not checked.', null),
    ('QS-DRAFT-1', 'category', 'patient_fall', 2, 'Patient fall',
     'A patient fell or was found on the floor, with or without injury.', null),
    ('QS-DRAFT-1', 'category', 'identification_documentation', 3, 'Patient identification or documentation',
     'The wrong patient; a wristband missing or wrong; a record filed to the wrong patient; documentation missing or wrong.', null),
    ('QS-DRAFT-1', 'category', 'procedure_treatment', 4, 'Clinical procedure or treatment',
     'A procedure or treatment not done, done wrongly, delayed, or done on the wrong site or patient.', null),
    ('QS-DRAFT-1', 'category', 'infection_control', 5, 'Infection prevention and control',
     'Hand hygiene, sterilising, isolation or a sharps injury; a possible infection caught in the facility.', null),
    ('QS-DRAFT-1', 'category', 'equipment_device', 6, 'Equipment or medical device',
     'Equipment missing, faulty, not maintained, or used wrongly.', null),
    ('QS-DRAFT-1', 'category', 'blood_transfusion', 7, 'Blood or transfusion',
     'The wrong blood or component, a sample labelling or storage error, or a transfusion reaction.', null),
    ('QS-DRAFT-1', 'category', 'safety_security', 8, 'Staff or patient safety and security',
     'Violence or aggression, a missing patient, theft, or harm to a staff member.', null),
    ('QS-DRAFT-1', 'category', 'facility_environment', 9, 'Facility and environment',
     'A wet floor, a power or water failure, fire, or a building or cleaning problem.', null),
    ('QS-DRAFT-1', 'category', 'other', 10, 'Other',
     'Anything the list does not cover. Describe it under "What happened".', null),
    ('QS-DRAFT-1', 'harm_level', 'near_miss', 1, 'Near miss',
     'It was caught before it reached the patient or person.', false),
    ('QS-DRAFT-1', 'harm_level', 'no_harm', 2, 'No harm',
     'It reached the patient but caused no harm.', false),
    ('QS-DRAFT-1', 'harm_level', 'mild', 3, 'Mild harm',
     'Minor harm needing at most extra observation or minor treatment.', false),
    ('QS-DRAFT-1', 'harm_level', 'moderate', 4, 'Moderate harm',
     'Harm needing extra treatment or a longer stay, or short-term loss of function.', true),
    ('QS-DRAFT-1', 'harm_level', 'severe', 5, 'Severe harm',
     'Permanent or long-term harm, or harm needing life-saving treatment.', true),
    ('QS-DRAFT-1', 'harm_level', 'death', 6, 'Death',
     'The incident caused or contributed to a death.', true);
  insert into ehr.quality_switches (key, enabled, changed_by_migration) values ('patient_link', false, '0197');
  -- Post-check of the seeded rows while this file can still read them.
  if (select md5(string_agg(version_row.list_version || '|' || version_row.status || '|' || version_row.active || '|'
                            || coalesce(version_row.approval_reference, '-') || '|' || version_row.loaded_by_migration,
                            ',' order by version_row.list_version))
        from ehr.quality_list_versions version_row) is distinct from md5('QS-DRAFT-1|draft|true|-|0197')
     or (select count(*) from ehr.quality_list_items) <> 16
     or (select count(*) from ehr.quality_list_items item where item.list_kind = 'category') <> 10
     or (select string_agg(item.code || ':' || item.told_required, ',' order by item.position)
           from ehr.quality_list_items item where item.list_kind = 'harm_level')
        is distinct from 'near_miss:false,no_harm:false,mild:false,moderate:true,severe:true,death:true'
     or (select string_agg(switch_row.key || ':' || switch_row.enabled || ':' || switch_row.changed_by_migration, ',')
           from ehr.quality_switches switch_row) is distinct from 'patient_link:false:0197' then
    raise exception using errcode = '55000', message = '0197: post-check failed (the draft list or the switch)';
  end if;

  -- The guards (no delete anywhere; append-only list items and history; no truncate).
  create trigger quality_list_versions_no_delete before delete on ehr.quality_list_versions
    for each row execute function platform.reject_mutation();
  create trigger quality_list_versions_no_truncate before truncate on ehr.quality_list_versions
    for each statement execute function platform.reject_mutation();
  create trigger quality_list_items_append_only before update or delete on ehr.quality_list_items
    for each row execute function platform.reject_mutation();
  create trigger quality_list_items_no_truncate before truncate on ehr.quality_list_items
    for each statement execute function platform.reject_mutation();
  create trigger quality_switches_no_delete before delete on ehr.quality_switches
    for each row execute function platform.reject_mutation();
  create trigger quality_switches_no_truncate before truncate on ehr.quality_switches
    for each statement execute function platform.reject_mutation();
  create trigger quality_leads_no_delete before delete on ehr.quality_leads
    for each row execute function platform.reject_mutation();
  create trigger quality_leads_no_truncate before truncate on ehr.quality_leads
    for each statement execute function platform.reject_mutation();
  create trigger quality_incidents_no_delete before delete on ehr.quality_incidents
    for each row execute function platform.reject_mutation();
  create trigger quality_incidents_no_truncate before truncate on ehr.quality_incidents
    for each statement execute function platform.reject_mutation();
  create trigger quality_incident_actions_no_delete before delete on ehr.quality_incident_actions
    for each row execute function platform.reject_mutation();
  create trigger quality_incident_actions_no_truncate before truncate on ehr.quality_incident_actions
    for each statement execute function platform.reject_mutation();
  create trigger quality_incident_events_append_only before update or delete on ehr.quality_incident_events
    for each row execute function platform.reject_mutation();
  create trigger quality_incident_events_no_truncate before truncate on ehr.quality_incident_events
    for each statement execute function platform.reject_mutation();

  create function ehr.quality_incident_fixed_fields()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if new.id is distinct from old.id or new.facility_id is distinct from old.facility_id
       or new.incident_number is distinct from old.incident_number or new.title is distinct from old.title
       or new.description is distinct from old.description or new.occurred_at is distinct from old.occurred_at
       or new.occurred_day is distinct from old.occurred_day
       or new.immediate_action is distinct from old.immediate_action
       or new.reported_by_membership_id is distinct from old.reported_by_membership_id
       or new.reported_at is distinct from old.reported_at or new.list_version is distinct from old.list_version then
      raise exception using errcode = '55000', message = 'QUALITY_REPORT_AS_FILED_IS_FIXED';
    end if;
    if new.row_version is distinct from old.row_version + 1 then
      raise exception using errcode = '55000', message = 'QUALITY_ROW_VERSION_STEP';
    end if;
    return new;
  end
  $fn$;
  create trigger quality_incidents_fixed_fields before update on ehr.quality_incidents
    for each row execute function ehr.quality_incident_fixed_fields();

  create function ehr.quality_action_fixed_fields()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if new.id is distinct from old.id or new.incident_id is distinct from old.incident_id
       or new.facility_id is distinct from old.facility_id or new.description is distinct from old.description
       or new.created_at is distinct from old.created_at
       or new.created_by_membership_id is distinct from old.created_by_membership_id then
      raise exception using errcode = '55000', message = 'QUALITY_ACTION_FIXED';
    end if;
    return new;
  end
  $fn$;
  create trigger quality_incident_actions_fixed_fields before update on ehr.quality_incident_actions
    for each row execute function ehr.quality_action_fixed_fields();

  create function ehr.quality_lead_end_once()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if old.ended_at is not null or new.ended_at is null
       or new.id is distinct from old.id or new.facility_id is distinct from old.facility_id
       or new.membership_id is distinct from old.membership_id or new.named_at is distinct from old.named_at
       or new.named_by_membership_id is distinct from old.named_by_membership_id
       or new.name_idempotency_key is distinct from old.name_idempotency_key
       or new.name_request_sha256 is distinct from old.name_request_sha256 then
      raise exception using errcode = '55000', message = 'QUALITY_LEAD_ENDS_ONCE';
    end if;
    return new;
  end
  $fn$;
  create trigger quality_leads_end_once before update on ehr.quality_leads
    for each row execute function ehr.quality_lead_end_once();

  -- Q8. Helpers (no role may execute them; the functions below run them as their owner).
  -- The caller: an active membership here not held by the cutover, quality.incident.report, the purpose
  -- healthcare-operations; whether a manager (quality.incident.manage, or an active lead row here) and on what
  -- basis; whether they may name leads (quality.incident.manage itself); the facility's departments (its profile's,
  -- or every 0114 code when it has no profile).
  create function ehr.quality_caller(required_level text)
  returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
    actor_organization uuid, actor_correlation text, is_manager boolean, manager_basis text, can_name_leads boolean,
    facility_departments text[])
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    v_purpose text;
    v_profile text[];
  begin
    actor_subject := platform.current_actor_subject();
    actor_account := auth.account_id_for_subject(actor_subject);
    actor_membership := platform.current_membership_id();
    actor_facility := platform.current_facility_id();
    actor_correlation := platform.current_correlation_id();
    v_purpose := platform.current_purpose_of_use();
    if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null then
      raise exception using errcode = '42501', message = 'QUALITY_NOT_ALLOWED';
    end if;
    select membership.organization_id into actor_organization
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null;
    if not found
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
                                             'quality.incident.report') then
      raise exception using errcode = '42501', message = 'QUALITY_NOT_ALLOWED';
    end if;
    if v_purpose is distinct from 'healthcare-operations' then
      raise exception using errcode = '22023', message = 'QUALITY_PURPOSE_REQUIRED';
    end if;
    can_name_leads := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
                                                     'quality.incident.manage');
    if can_name_leads then
      is_manager := true;
      manager_basis := 'role';
    elsif exists (select 1 from ehr.quality_leads lead
                   where lead.facility_id = actor_facility and lead.membership_id = actor_membership
                     and lead.ended_at is null) then
      is_manager := true;
      manager_basis := 'quality_lead';
    else
      is_manager := false;
      manager_basis := null;
    end if;
    if required_level = 'manager' and not is_manager then
      raise exception using errcode = '42501', message = 'QUALITY_MANAGER_ONLY';
    elsif required_level = 'leads' and not can_name_leads then
      raise exception using errcode = '42501', message = 'QUALITY_LEADS_ADMIN_ONLY';
    elsif required_level is null or required_level not in ('report', 'manager', 'leads') then
      raise exception using errcode = '42501', message = 'QUALITY_NOT_ALLOWED';
    end if;
    select profile.departments into v_profile
      from identity.facility_profiles profile where profile.facility_id = actor_facility;
    select coalesce(array_agg(department.code order by department.ord), array[]::text[]) into facility_departments
      from unnest(identity.facility_department_codes()) with ordinality department(code, ord)
     where v_profile is null or department.code = any (v_profile);
    return next;
  end
  $fn$;
  comment on function ehr.quality_caller(text) is
    '0197 (QUAL-1): the caller of a quality function: an active membership at the session facility, not held by the cutover, holding quality.incident.report, for healthcare-operations (42501 QUALITY_NOT_ALLOWED, 22023 QUALITY_PURPOSE_REQUIRED); whether a manager (quality.incident.manage, or an active quality lead row here) and on what basis; whether they may name leads; the facility''s departments. required_level manager raises QUALITY_MANAGER_ONLY, leads QUALITY_LEADS_ADMIN_ONLY. Called by the quality functions as their owner; no role may execute it.';

  -- A patient of this facility (Q-QUAL-8 A): the basis, or null (refused, the same for every reason).
  create function ehr.quality_patient_of_facility(requested_patient uuid, requested_facility uuid)
  returns text
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    v_basis text;
    v_now timestamptz := clock_timestamp();
  begin
    if requested_patient is null or requested_facility is null then
      return null;
    end if;
    if not exists (select 1 from identity.patients patient
                    where patient.id = requested_patient and patient.status = 'active'
                      and identity.sealed_demo_facility(requested_facility) = identity.sealed_demo_patient(patient.id)
                      and identity.sealed_qa_facility(requested_facility) = identity.sealed_qa_patient(patient.id)) then
      return null;
    end if;
    v_basis := identity.own_facility_basis(requested_patient, requested_facility);
    if v_basis is not null then
      return v_basis;
    end if;
    if exists (select 1 from ehr.encounters encounter
                where encounter.patient_id = requested_patient and encounter.facility_id = requested_facility
                  and encounter.started_at >= v_now - interval '90 days' and encounter.started_at <= v_now
                  and encounter.status not in ('cancelled', 'entered_in_error')
                  and not encounter.imported_paper_records) then
      return 'recent_visit';
    end if;
    if exists (select 1 from ehr.visit_queue entry
                where entry.patient_id = requested_patient and entry.facility_id = requested_facility
                  and entry.checked_in_at >= v_now - interval '90 days' and entry.stage <> 'cancelled') then
      return 'recent_check_in';
    end if;
    return null;
  end
  $fn$;
  comment on function ehr.quality_patient_of_facility(uuid, uuid) is
    '0197 (QUAL-1, Q-QUAL-8 A): whether a patient may be linked to an incident at a facility, and on what basis: active, allowed by the seal (a sealed demo or QA facility links only its own sealed patients; a real facility never a sealed one), and 0145''s own-facility basis (created_here, registered_here, visit_here), or a visit here started in the last 90 days, not cancelled, entered in error or imported paper records (recent_visit), or a waiting-list check-in here in the last 90 days, not cancelled (recent_check_in); null otherwise. Reads no clinical content. Called by the quality functions as their owner; no role may execute it.';

  create function ehr.quality_audit(audit_subject text, audit_account uuid, audit_membership uuid,
    audit_organization uuid, audit_facility uuid, audit_correlation text, audit_patient uuid, audit_action text,
    audit_outcome text, audit_resource_type text, audit_resource_id text, audit_details jsonb)
  returns void
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      audit_correlation, 'staff', audit_subject, audit_account, audit_membership, audit_organization, audit_facility,
      audit_patient, audit_action, audit_outcome, audit_resource_type, audit_resource_id, 'healthcare-operations',
      'application', 'ehr-api', coalesce(audit_details, '{}'::jsonb));
  end
  $fn$;
  comment on function ehr.quality_audit(text, uuid, uuid, uuid, uuid, text, uuid, text, text, text, text, jsonb) is
    '0197 (QUAL-1): one audit.events row of a quality function, as the staff member, for healthcare-operations. Callers pass ids, codes, counts and outcomes only; never a title, text, place in words, reason, name, date of birth or Health ID. Called by the quality functions as their owner; no role may execute it.';

  -- The Idempotency-Key: 'new', 'replay' (the same key and body: the incident or lead it made or changed) or
  -- 'reused' (the same key, another body). Under an advisory lock per membership and key, so two requests with
  -- one key never both act.
  create function ehr.quality_idempotency(requested_membership uuid, requested_key text, requested_sha text)
  returns table (state text, incident_id uuid, lead_id uuid)
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    v_found_incident uuid;
    v_found_lead uuid;
    v_found_sha text;
  begin
    if requested_key is null or requested_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_sha is null or requested_sha !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'QUALITY_IDEMPOTENCY_KEY_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('quality-key:' || requested_membership::text || ':' || requested_key, 0));
    select event.incident_id, event.request_sha256 into v_found_incident, v_found_sha
      from ehr.quality_incident_events event
     where event.by_membership_id = requested_membership and event.idempotency_key = requested_key;
    if not found then
      select lead.id, case when lead.named_by_membership_id = requested_membership
                                and lead.name_idempotency_key = requested_key then lead.name_request_sha256
                           else lead.end_request_sha256 end
        into v_found_lead, v_found_sha
        from ehr.quality_leads lead
       where (lead.named_by_membership_id = requested_membership and lead.name_idempotency_key = requested_key)
          or (lead.ended_by_membership_id = requested_membership and lead.end_idempotency_key = requested_key)
       limit 1;
    end if;
    if v_found_sha is null then
      state := 'new';
    elsif v_found_sha = requested_sha then
      state := 'replay';
    else
      state := 'reused';
    end if;
    incident_id := v_found_incident;
    lead_id := v_found_lead;
    return next;
  end
  $fn$;
  comment on function ehr.quality_idempotency(uuid, text, text) is
    '0197 (QUAL-1): the state of an Idempotency-Key for a membership (new, replay with the incident or lead, or reused), under an advisory lock per membership and key; 22023 QUALITY_IDEMPOTENCY_KEY_INVALID for a malformed key or SHA-256. Called by the quality functions as their owner; no role may execute it.';

  -- The card, actions and history of one incident in the viewer's view (manager, reviewer or reporter), or no row
  -- when the viewer may not see it. The patient (name, sex, date of birth, last 4 characters of the Health ID) only
  -- in the manager's view; never a whole Health ID or NIN; history never names a patient.
  create function ehr.quality_detail(requested_incident uuid, viewer_membership uuid, viewer_is_manager boolean)
  returns table (view_name text, body jsonb, shown_patient uuid)
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    v_row ehr.quality_incidents%rowtype;
    v_view text;
    v_mine boolean;
    v_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    v_open integer;
    v_overdue integer;
    v_count integer;
    v_patient jsonb;
    v_actions jsonb;
    v_history jsonb;
    v_card jsonb;
  begin
    select incident.* into v_row from ehr.quality_incidents incident where incident.id = requested_incident;
    if not found then
      return;
    end if;
    v_mine := v_row.reported_by_membership_id = viewer_membership;
    if coalesce(viewer_is_manager, false) then
      v_view := 'manager';
    elsif v_row.reviewer_membership_id = viewer_membership and v_row.status <> 'resolved' then
      v_view := 'reviewer';
    elsif v_mine then
      v_view := 'reporter';
    else
      return;
    end if;
    select count(*) filter (where action.status = 'open'),
           count(*) filter (where action.status = 'open' and action.due_date < v_today), count(*)
      into v_open, v_overdue, v_count
      from ehr.quality_incident_actions action where action.incident_id = v_row.id;
    if v_view = 'manager' and v_row.patient_id is not null then
      select jsonb_build_object('patientId', patient.id, 'fullName', patient.full_name,
               'recordKind', case when unknown_record.patient_id is null then 'standard' else 'unknown' end,
               'unknownLabel', unknown_record.label, 'sex', patient.gender,
               'dateOfBirth', to_char(patient.dob, 'YYYY-MM-DD'), 'healthIdLast4', right(patient.hid_code, 4))
        into v_patient
        from identity.patients patient
        left join identity.unknown_patients unknown_record
          on unknown_record.patient_id = patient.id and unknown_record.status <> 'identified'
       where patient.id = v_row.patient_id;
    end if;
    if v_view = 'reporter' then
      v_actions := '[]'::jsonb;
    else
      select coalesce(jsonb_agg(jsonb_build_object('actionId', action.id, 'description', action.description,
               'ownerMembershipId', action.owner_membership_id, 'dueDate', to_char(action.due_date, 'YYYY-MM-DD'),
               'status', action.status, 'overdue', action.status = 'open' and action.due_date < v_today,
               'completedAt', to_char(action.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'note', action.note,
               'createdAt', to_char(action.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'createdByMembershipId', action.created_by_membership_id)
             order by action.created_at, action.id), '[]'::jsonb)
        into v_actions
        from ehr.quality_incident_actions action where action.incident_id = v_row.id;
    end if;
    select coalesce(jsonb_agg(case when v_view = 'reporter'
               then jsonb_build_object('kind', event.kind,
                      'at', to_char(event.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                      'byMembershipId', null, 'fromStatus', event.from_status, 'toStatus', event.to_status,
                      'reason', null, 'text', null, 'actionId', null, 'changes', null)
               else jsonb_build_object('kind', event.kind,
                      'at', to_char(event.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                      'byMembershipId', case when v_view = 'reviewer'
                                              and event.kind in ('reported', 'patient_linked', 'patient_link_changed')
                                             then null else event.by_membership_id end,
                      'fromStatus', event.from_status, 'toStatus', event.to_status, 'reason', event.reason,
                      'text', event.text_value, 'actionId', event.action_id, 'changes', event.changes) end
             order by event.event_no), '[]'::jsonb)
      into v_history
      from ehr.quality_incident_events event
     where event.incident_id = v_row.id
       and (v_view <> 'reporter'
            or event.kind in ('reported', 'assigned', 'investigation_recorded', 'resolved', 'reopened'));
    v_card := jsonb_build_object(
      'incidentId', v_row.id, 'incidentNumber', v_row.incident_number, 'view', v_view,
      'title', v_row.title, 'description', v_row.description,
      'occurredAt', to_char(v_row.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'occurredDay', to_char(v_row.occurred_day, 'YYYY-MM-DD'),
      'departmentCode', v_row.department_code, 'locationText', v_row.location_text,
      'category', v_row.category, 'harmLevel', v_row.harm_level, 'immediateAction', v_row.immediate_action,
      'patientOrFamilyTold', v_row.patient_or_family_told, 'listVersion', v_row.list_version,
      'status', v_row.status,
      'reportedAt', to_char(v_row.reported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'reportedByMe', v_mine,
      'reporterMembershipId', case when v_view = 'manager' then v_row.reported_by_membership_id end,
      'reporterHidden', v_view = 'reviewer' and not v_mine,
      'patientLinked', v_row.patient_id is not null,
      'patientHidden', v_row.patient_id is not null and v_view <> 'manager',
      'patient', v_patient,
      'reviewerMembershipId', case when v_view <> 'reporter' then v_row.reviewer_membership_id end,
      'assignedAt', to_char(v_row.assigned_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'investigation', case when v_view <> 'reporter' and v_row.investigation_findings is not null then
        jsonb_build_object('findings', v_row.investigation_findings,
          'recordedAt', to_char(v_row.investigated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'recordedByMembershipId', v_row.investigated_by_membership_id) end,
      'resolution', case when v_view <> 'reporter' and v_row.resolution is not null then
        jsonb_build_object('resolution', v_row.resolution,
          'resolvedAt', to_char(v_row.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'resolvedByMembershipId', v_row.resolved_by_membership_id) end,
      'reopenedCount', v_row.reopened_count,
      'openActions', case when v_view <> 'reporter' then v_open end,
      'overdueActions', case when v_view <> 'reporter' then v_overdue end,
      'can', jsonb_build_object(
        'assign', v_view = 'manager' and v_row.status <> 'resolved',
        'investigate', v_view <> 'reporter' and v_row.status in ('assigned', 'investigated'),
        'addAction', v_view <> 'reporter' and v_row.status in ('assigned', 'investigated') and v_count < 20,
        'resolve', v_view = 'manager' and v_row.status = 'investigated' and v_open = 0,
        'reopen', v_view = 'manager' and v_row.status = 'resolved',
        'correct', v_view = 'manager' and v_row.status <> 'resolved'),
      'updatedAt', to_char(v_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'rowVersion', v_row.row_version);
    view_name := v_view;
    body := jsonb_build_object('incident', v_card, 'actions', v_actions, 'history', v_history);
    shown_patient := case when v_view = 'manager' then v_row.patient_id end;
    return next;
  end
  $fn$;
  comment on function ehr.quality_detail(uuid, uuid, boolean) is
    '0197 (QUAL-1, Q248 A, Q-QUAL-4 A, Q-QUAL-5 A): the incident card, actions and history in the viewer''s view: manager (everything, with the reporter and the linked patient), the current reviewer of an incident that is not resolved (no reporter, no patient, no actor on the report and patient-link entries), or the reporter (the report as filed, status and dates, and the status changes only); no row for anyone else. Called by the quality functions as their owner; no role may execute it.';

  -- Route 1: what this member can do here, and the lists.
  create function ehr.quality_me()
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    v_version text;
    v_status text;
    v_categories jsonb;
    v_harm jsonb;
    v_switch boolean;
  begin
    select * into caller from ehr.quality_caller('report');
    select version_row.list_version, version_row.status into v_version, v_status
      from ehr.quality_list_versions version_row where version_row.active;
    select coalesce(jsonb_agg(jsonb_build_object('code', item.code, 'label', item.label, 'hint', item.hint)
                              order by item.position), '[]'::jsonb)
      into v_categories
      from ehr.quality_list_items item where item.list_version = v_version and item.list_kind = 'category';
    select coalesce(jsonb_agg(jsonb_build_object('code', item.code, 'label', item.label, 'hint', item.hint,
                                                 'toldRequired', item.told_required)
                              order by item.position), '[]'::jsonb)
      into v_harm
      from ehr.quality_list_items item where item.list_version = v_version and item.list_kind = 'harm_level';
    select switch_row.enabled into v_switch from ehr.quality_switches switch_row where switch_row.key = 'patient_link';
    return jsonb_build_object('canReport', true, 'isManager', caller.is_manager,
      'managerBasis', caller.manager_basis, 'canNameLeads', caller.can_name_leads,
      'patientLinkAvailable', coalesce(v_switch, false),
      'lists', jsonb_build_object('listVersion', v_version, 'listStatus', v_status, 'categories', v_categories,
        'harmLevels', v_harm, 'toldValues', jsonb_build_array('yes', 'no', 'not_applicable')),
      'departmentCodes', to_jsonb(caller.facility_departments));
  end
  $fn$;
  comment on function ehr.quality_me() is
    '0197 (QUAL-1): route 1. What this member can do here (canReport, isManager, managerBasis role or quality_lead, canNameLeads, patientLinkAvailable), the active list with its status (draft or signed) and the facility''s department codes. Needs quality.incident.report here, for healthcare-operations. Reads no incident; not audited.';

  -- Route 2: file a report.
  create function ehr.quality_incident_report(requested_title text, requested_description text,
    requested_occurred_at timestamptz, requested_department_code text, requested_location_text text,
    requested_category text, requested_harm_level text, requested_immediate_action text, requested_told text,
    requested_patient uuid, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    v_detail record;
    v_now timestamptz := clock_timestamp();
    v_title text := btrim(coalesce(requested_title, ''));
    v_description text := btrim(coalesce(requested_description, ''), E' \t\r\n');
    v_location text := nullif(btrim(coalesce(requested_location_text, '')), '');
    v_action text := nullif(btrim(coalesce(requested_immediate_action, ''), E' \t\r\n'), '');
    v_version text;
    v_told_required boolean;
    v_basis text;
    v_switch boolean;
    v_number integer;
    v_id uuid;
  begin
    select * into caller from ehr.quality_caller('report');
    if length(v_title) not between 3 and 120 or v_title ~ '[[:cntrl:]]'
       or length(v_description) not between 10 and 4000 or translate(v_description, E'\t\r\n', '') ~ '[[:cntrl:]]'
       or requested_occurred_at is null
       or (requested_location_text is not null
           and (v_location is null or length(v_location) not between 2 and 120 or v_location ~ '[[:cntrl:]]'))
       or (requested_immediate_action is not null
           and (v_action is null or length(v_action) not between 2 and 2000
                or translate(v_action, E'\t\r\n', '') ~ '[[:cntrl:]]'))
       or (requested_told is not null and requested_told not in ('yes', 'no', 'not_applicable')) then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    if requested_department_code is not null and not requested_department_code = any (caller.facility_departments) then
      raise exception using errcode = '22023', message = 'QUALITY_DEPARTMENT_INVALID';
    end if;
    if requested_department_code is null and v_location is null then
      raise exception using errcode = '22023', message = 'QUALITY_LOCATION_REQUIRED';
    end if;
    select version_row.list_version into v_version
      from ehr.quality_list_versions version_row where version_row.active;
    if not exists (select 1 from ehr.quality_list_items item
                    where item.list_version = v_version and item.list_kind = 'category'
                      and item.code = requested_category) then
      raise exception using errcode = '22023', message = 'QUALITY_CATEGORY_INVALID';
    end if;
    select item.told_required into v_told_required
      from ehr.quality_list_items item
     where item.list_version = v_version and item.list_kind = 'harm_level' and item.code = requested_harm_level;
    if v_told_required is null then
      raise exception using errcode = '22023', message = 'QUALITY_HARM_LEVEL_INVALID';
    end if;
    if v_told_required and requested_told is null then
      raise exception using errcode = '22023', message = 'QUALITY_TOLD_REQUIRED';
    end if;
    -- Up to a year ago, not in the future; up to 2 minutes ahead (a device clock's difference) is taken as now.
    if requested_occurred_at > v_now + interval '2 minutes' or requested_occurred_at < v_now - interval '365 days' then
      raise exception using errcode = '22023', message = 'QUALITY_TIME_INVALID';
    end if;

    select * into key_state from ehr.quality_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.incident_id is not null then
      select detail.* into v_detail
        from ehr.quality_detail(key_state.incident_id, caller.actor_membership, caller.is_manager) detail;
      if found then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.report',
          'success', 'quality-incident', key_state.incident_id::text, jsonb_build_object('replayed', true));
        return query select 'ok'::text, true, v_detail.body;
        return;
      end if;
    end if;
    if key_state.state <> 'new' then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.report',
        'denied', 'quality-incident', null, jsonb_build_object('refusal', 'key_reused'));
      return query select 'key_reused'::text, false, null::jsonb;
      return;
    end if;

    -- The patient link (Q249 A, Q-QUAL-3 A, Q-QUAL-8 A): the switch, then a patient of this facility. Refused the
    -- same for every reason; nothing is saved; the refusal's audit row names no patient.
    if requested_patient is not null then
      select switch_row.enabled into v_switch from ehr.quality_switches switch_row
       where switch_row.key = 'patient_link';
      if not coalesce(v_switch, false) then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
          'quality.incident.patient-link', 'denied', 'quality-incident', null,
          jsonb_build_object('step', 'report', 'refusal', 'not_available'));
        return query select 'patient_link_not_available'::text, false, null::jsonb;
        return;
      end if;
      v_basis := ehr.quality_patient_of_facility(requested_patient, caller.actor_facility);
      if v_basis is null then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
          'quality.incident.patient-link', 'denied', 'quality-incident', null,
          jsonb_build_object('step', 'report', 'refusal', 'refused'));
        return query select 'patient_link_refused'::text, false, null::jsonb;
        return;
      end if;
    end if;

    -- The facility's next incident number, under an advisory lock per facility.
    perform pg_advisory_xact_lock(hashtextextended('quality-incident-number:' || caller.actor_facility::text, 0));
    select coalesce(max(incident.incident_number), 0) + 1 into v_number
      from ehr.quality_incidents incident where incident.facility_id = caller.actor_facility;
    insert into ehr.quality_incidents (facility_id, incident_number, title, description, occurred_at, occurred_day,
      immediate_action, reported_by_membership_id, reported_at, list_version, category, harm_level, department_code,
      location_text, patient_or_family_told, patient_id, patient_linked_at, patient_linked_by_membership_id, status,
      updated_at, updated_by_membership_id, row_version)
    values (caller.actor_facility, v_number, v_title, v_description, least(requested_occurred_at, v_now),
      (least(requested_occurred_at, v_now) at time zone 'Africa/Lagos')::date, v_action, caller.actor_membership,
      v_now, v_version, requested_category, requested_harm_level, requested_department_code, v_location,
      requested_told, requested_patient, case when requested_patient is not null then v_now end,
      case when requested_patient is not null then caller.actor_membership end, 'reported', v_now,
      caller.actor_membership, 1)
    returning id into v_id;
    insert into ehr.quality_incident_events (incident_id, facility_id, event_no, kind, from_status, to_status,
      by_membership_id, at, row_version_after, idempotency_key, request_sha256)
    values (v_id, caller.actor_facility, 1, 'reported', null, 'reported', caller.actor_membership, v_now, 1,
      requested_idempotency_key, requested_request_sha256);
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.report',
      'success', 'quality-incident', v_id::text,
      jsonb_build_object('incidentNumber', v_number, 'category', requested_category,
        'harmLevel', requested_harm_level, 'departmentCode', requested_department_code,
        'patientLinked', requested_patient is not null, 'listVersion', v_version));
    if requested_patient is not null then
      insert into ehr.quality_incident_events (incident_id, facility_id, event_no, kind, from_status, to_status,
        by_membership_id, at, changes, row_version_after)
      values (v_id, caller.actor_facility, 2, 'patient_linked', 'reported', 'reported', caller.actor_membership, v_now,
        jsonb_build_object('patientLink', 'set'), 1);
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, requested_patient,
        'quality.incident.patient-link', 'success', 'quality-incident', v_id::text,
        jsonb_build_object('step', 'report', 'outcome', 'linked', 'basis', v_basis));
    end if;
    select detail.* into v_detail
      from ehr.quality_detail(v_id, caller.actor_membership, caller.is_manager) detail;
    return query select 'ok'::text, false, v_detail.body;
  end
  $fn$;
  comment on function ehr.quality_incident_report(text, text, timestamptz, text, text, text, text, text, text, uuid, text, text) is
    '0197 (QUAL-1, Q248 A-Q252 A): route 2, file an incident or near-miss report at the session facility: title, what happened, when (up to a year ago, not in the future), a department and/or a place in words, a category and harm level of the active list, the immediate action, "patient or family told" (required for moderate, severe and death), and optionally a patient of this facility (only while the patient-link switch is on; refused the same for every reason, nothing saved). Needs quality.incident.report here, for healthcare-operations. Answers the card in the caller''s view. Audited (quality.incident.report; quality.incident.patient-link).';

  -- Route 3: the list.
  create function ehr.quality_incident_list(requested_status text, requested_category text,
    requested_harm_level text, requested_department_code text, requested_occurred_from date,
    requested_occurred_to date, requested_mine text, requested_limit integer, requested_cursor_at timestamptz,
    requested_cursor_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    v_limit integer := coalesce(requested_limit, 50);
    v_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    v_found uuid[];
    v_ids uuid[];
    v_more boolean;
    v_items jsonb;
    v_next jsonb;
    v_counts jsonb;
    v_last record;
    v_filters text[];
  begin
    select * into caller from ehr.quality_caller('report');
    if (requested_status is not null
        and requested_status not in ('reported', 'assigned', 'investigated', 'resolved', 'open'))
       or (requested_category is not null and requested_category not in ('medication', 'patient_fall',
           'identification_documentation', 'procedure_treatment', 'infection_control', 'equipment_device',
           'blood_transfusion', 'safety_security', 'facility_environment', 'other'))
       or (requested_harm_level is not null
           and requested_harm_level not in ('near_miss', 'no_harm', 'mild', 'moderate', 'severe', 'death'))
       or (requested_department_code is not null
           and not requested_department_code = any (identity.facility_department_codes()))
       or (requested_mine is not null and requested_mine not in ('reported', 'assigned'))
       or v_limit not between 1 and 100
       or (requested_occurred_from is not null and requested_occurred_to is not null
           and (requested_occurred_to < requested_occurred_from
                or requested_occurred_to - requested_occurred_from > 366)) then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    if (requested_cursor_at is null) <> (requested_cursor_id is null) then
      raise exception using errcode = '22023', message = 'QUALITY_LIST_CURSOR_INVALID';
    end if;
    select array_agg(listed.id order by listed.reported_at desc, listed.id desc) into v_found
      from (select incident.id, incident.reported_at
              from ehr.quality_incidents incident
             where incident.facility_id = caller.actor_facility
               -- A manager sees every incident of the facility; anyone else the reports they filed and the
               -- incidents assigned to them now.
               and (caller.is_manager or incident.reported_by_membership_id = caller.actor_membership
                    or (incident.reviewer_membership_id = caller.actor_membership
                        and incident.status <> 'resolved'))
               and (requested_mine is null
                    or (requested_mine = 'reported' and incident.reported_by_membership_id = caller.actor_membership)
                    or (requested_mine = 'assigned' and incident.reviewer_membership_id = caller.actor_membership
                        and incident.status <> 'resolved'))
               and (requested_status is null
                    or (requested_status = 'open' and incident.status <> 'resolved')
                    or incident.status = requested_status)
               and (requested_category is null or incident.category = requested_category)
               and (requested_harm_level is null or incident.harm_level = requested_harm_level)
               and (requested_department_code is null or incident.department_code = requested_department_code)
               and (requested_occurred_from is null or incident.occurred_day >= requested_occurred_from)
               and (requested_occurred_to is null or incident.occurred_day <= requested_occurred_to)
               and (requested_cursor_at is null
                    or (incident.reported_at, incident.id) < (requested_cursor_at, requested_cursor_id))
             order by incident.reported_at desc, incident.id desc
             limit v_limit + 1) listed;
    v_more := coalesce(cardinality(v_found), 0) > v_limit;
    v_ids := coalesce(v_found[1:v_limit], array[]::uuid[]);
    select coalesce(jsonb_agg(jsonb_build_object(
             'incidentId', incident.id, 'incidentNumber', incident.incident_number, 'title', incident.title,
             'category', incident.category, 'harmLevel', incident.harm_level,
             'departmentCode', incident.department_code,
             'occurredAt', to_char(incident.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'reportedAt', to_char(incident.reported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'status', incident.status,
             'reviewerMembershipId', case when shown.reviewer_view then incident.reviewer_membership_id end,
             'patientLinked', incident.patient_id is not null,
             'reportedByMe', incident.reported_by_membership_id = caller.actor_membership,
             'assignedToMe', incident.reviewer_membership_id is not distinct from caller.actor_membership
                             and incident.status <> 'resolved',
             'openActions', case when shown.reviewer_view then
               (select count(*) from ehr.quality_incident_actions action
                 where action.incident_id = incident.id and action.status = 'open') end,
             'overdueActions', case when shown.reviewer_view then
               (select count(*) from ehr.quality_incident_actions action
                 where action.incident_id = incident.id and action.status = 'open' and action.due_date < v_today) end,
             'rowVersion', incident.row_version)
           order by ordering.ord), '[]'::jsonb)
      into v_items
      from unnest(v_ids) with ordinality ordering(id, ord)
      join ehr.quality_incidents incident on incident.id = ordering.id
      cross join lateral (select caller.is_manager
                                 or (incident.reviewer_membership_id = caller.actor_membership
                                     and incident.status <> 'resolved') as reviewer_view) shown;
    if v_more then
      select incident.id, incident.reported_at into v_last
        from ehr.quality_incidents incident where incident.id = v_ids[v_limit];
      v_next := jsonb_build_object('incidentId', v_last.id,
        'reportedAt', to_char(v_last.reported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    end if;
    if caller.is_manager then
      select jsonb_build_object(
               'reported', count(*) filter (where incident.status = 'reported'),
               'assigned', count(*) filter (where incident.status = 'assigned'),
               'investigated', count(*) filter (where incident.status = 'investigated'),
               'resolved', count(*) filter (where incident.status = 'resolved'))
        into v_counts
        from ehr.quality_incidents incident where incident.facility_id = caller.actor_facility;
    end if;
    v_filters := array_remove(array[
      case when requested_status is not null then 'status' end,
      case when requested_category is not null then 'category' end,
      case when requested_harm_level is not null then 'harmLevel' end,
      case when requested_department_code is not null then 'departmentCode' end,
      case when requested_occurred_from is not null then 'occurredFrom' end,
      case when requested_occurred_to is not null then 'occurredTo' end,
      case when requested_mine is not null then 'mine' end,
      case when requested_cursor_at is not null then 'cursor' end], null);
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.list',
      'success', 'quality-incident-list', null,
      jsonb_build_object('resultCount', cardinality(v_ids), 'incidentIds', to_jsonb(v_ids), 'hasMore', v_more,
        'filters', to_jsonb(v_filters), 'view', case when caller.is_manager then 'manager' else 'member' end));
    return jsonb_build_object('items', v_items, 'hasMore', v_more, 'next', v_next, 'limit', v_limit,
      'counts', v_counts);
  end
  $fn$;
  comment on function ehr.quality_incident_list(text, text, text, text, date, date, text, integer, timestamptz, uuid) is
    '0197 (QUAL-1): route 3, the incident list of the session facility, newest report first, with filters (status or open, category, harm level, department, Lagos days occurred from and to, mine reported or assigned), at most 100 per page, keyset after (reportedAt, incidentId). A manager sees every incident; anyone else the reports they filed and the incidents assigned to them now. Items carry no reporter, patient or text but the title; counts by status for managers only. Audited: one quality.incident.list row.';

  -- Route 4: one incident.
  create function ehr.quality_incident_read(requested_incident uuid)
  returns table (outcome text, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    v_detail record;
  begin
    select * into caller from ehr.quality_caller('report');
    if requested_incident is null then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    select detail.* into v_detail
      from ehr.quality_detail(requested_incident, caller.actor_membership, caller.is_manager) detail;
    if not found then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.read',
        'failure', 'quality-incident', requested_incident::text, jsonb_build_object('outcome', 'not_found'));
      return query select 'not_found'::text, null::jsonb;
      return;
    end if;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
      'quality.incident.read', 'success', 'quality-incident', requested_incident::text,
      jsonb_build_object('view', v_detail.view_name));
    return query select 'ok'::text, v_detail.body;
  end
  $fn$;
  comment on function ehr.quality_incident_read(uuid) is
    '0197 (QUAL-1): route 4, one incident of the session facility with its actions and history, in the caller''s view (manager, reviewer or reporter); not_found for one the caller may not see, as for one that does not exist. Audited (quality.incident.read; the patient column set when a manager was shown the patient).';

  -- Route 5: assign or reassign the reviewer (manager).
  create function ehr.quality_incident_assign(requested_incident uuid, requested_row_version bigint,
    requested_reviewer uuid, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    v_detail record;
    v_row ehr.quality_incidents%rowtype;
    v_refusal text;
    v_subject text;
    v_kind text;
    v_status text;
    v_now timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.quality_caller('manager');
    if requested_incident is null or requested_row_version is null or requested_row_version < 1
       or requested_reviewer is null then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    select * into key_state from ehr.quality_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.incident_id = requested_incident then
      select detail.* into v_detail
        from ehr.quality_detail(requested_incident, caller.actor_membership, caller.is_manager) detail;
      if found then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
          'quality.incident.assign', 'success', 'quality-incident', requested_incident::text,
          jsonb_build_object('replayed', true));
        return query select 'ok'::text, true, v_detail.body;
        return;
      end if;
    end if;
    select incident.* into v_row from ehr.quality_incidents incident where incident.id = requested_incident for update;
    if not found then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.assign',
        'failure', 'quality-incident', requested_incident::text, jsonb_build_object('outcome', 'not_found'));
      return query select 'not_found'::text, false, null::jsonb;
      return;
    end if;
    if key_state.state <> 'new' then
      v_refusal := 'key_reused';
    elsif v_row.status = 'resolved' then
      v_refusal := 'resolved';
    elsif v_row.row_version <> requested_row_version then
      v_refusal := 'changed';
    elsif v_row.reviewer_membership_id = requested_reviewer then
      v_refusal := 'nothing_to_change';
    else
      -- An active member here, not held, holding quality.incident.report.
      select account_row.subject into v_subject
        from identity.staff_facility_memberships membership
        join auth.accounts account_row on account_row.id = membership.account_id
       where membership.id = requested_reviewer and membership.facility_id = caller.actor_facility
         and membership.active and membership.migration_hold_reason is null;
      if v_subject is null
         or not auth.membership_has_permission(v_subject, requested_reviewer, caller.actor_facility,
                                               'quality.incident.report') then
        v_refusal := 'reviewer_invalid';
      end if;
    end if;
    if v_refusal is not null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.assign',
        'denied', 'quality-incident', v_row.id::text, jsonb_build_object('refusal', v_refusal));
      return query select v_refusal, false, null::jsonb;
      return;
    end if;
    v_kind := case when v_row.status = 'reported' then 'assigned' else 'reassigned' end;
    v_status := case when v_row.status = 'reported' then 'assigned' else v_row.status end;
    update ehr.quality_incidents incident
       set status = v_status, reviewer_membership_id = requested_reviewer, assigned_at = v_now,
           assigned_by_membership_id = caller.actor_membership, updated_at = v_now,
           updated_by_membership_id = caller.actor_membership, row_version = incident.row_version + 1
     where incident.id = v_row.id;
    insert into ehr.quality_incident_events (incident_id, facility_id, event_no, kind, from_status, to_status,
      by_membership_id, at, changes, row_version_after, idempotency_key, request_sha256)
    values (v_row.id, v_row.facility_id,
      (select coalesce(max(event.event_no), 0) + 1 from ehr.quality_incident_events event
        where event.incident_id = v_row.id),
      v_kind, v_row.status, v_status, caller.actor_membership, v_now,
      jsonb_build_object('reviewerMembershipId',
        jsonb_build_object('from', v_row.reviewer_membership_id, 'to', requested_reviewer)),
      v_row.row_version + 1, requested_idempotency_key, requested_request_sha256);
    select detail.* into v_detail
      from ehr.quality_detail(v_row.id, caller.actor_membership, caller.is_manager) detail;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
      'quality.incident.assign', 'success', 'quality-incident', v_row.id::text,
      jsonb_build_object('kind', v_kind, 'reviewerMembershipId', requested_reviewer,
        'previousReviewerMembershipId', v_row.reviewer_membership_id));
    return query select 'ok'::text, false, v_detail.body;
  end
  $fn$;
  comment on function ehr.quality_incident_assign(uuid, bigint, uuid, text, text) is
    '0197 (QUAL-1): route 5 (manager), choose the reviewer from the facility''s staff holding quality.incident.report: from reported, status assigned; from assigned or investigated, the reviewer changes (reassigned) and the earlier reviewer loses sight of the incident. Version-checked, idempotent, audited (quality.incident.assign).';

  -- Route 6: the investigation (the current reviewer or a manager).
  create function ehr.quality_incident_investigate(requested_incident uuid, requested_row_version bigint,
    requested_findings text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    v_detail record;
    v_row ehr.quality_incidents%rowtype;
    v_view text;
    v_refusal text;
    v_kind text;
    v_findings text := btrim(coalesce(requested_findings, ''), E' \t\r\n');
    v_now timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.quality_caller('report');
    if requested_incident is null or requested_row_version is null or requested_row_version < 1
       or length(v_findings) not between 10 and 4000 or translate(v_findings, E'\t\r\n', '') ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    select * into key_state from ehr.quality_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.incident_id = requested_incident then
      select detail.* into v_detail
        from ehr.quality_detail(requested_incident, caller.actor_membership, caller.is_manager) detail;
      if found then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
          'quality.incident.investigation', 'success', 'quality-incident', requested_incident::text,
          jsonb_build_object('replayed', true));
        return query select 'ok'::text, true, v_detail.body;
        return;
      end if;
    end if;
    select incident.* into v_row from ehr.quality_incidents incident where incident.id = requested_incident for update;
    if found then
      v_view := case when caller.is_manager then 'manager'
                     when v_row.reviewer_membership_id = caller.actor_membership and v_row.status <> 'resolved'
                       then 'reviewer'
                     when v_row.reported_by_membership_id = caller.actor_membership then 'reporter' end;
    end if;
    if v_view is null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
        'quality.incident.investigation', 'failure', 'quality-incident', requested_incident::text,
        jsonb_build_object('outcome', 'not_found'));
      return query select 'not_found'::text, false, null::jsonb;
      return;
    end if;
    if key_state.state <> 'new' then
      v_refusal := 'key_reused';
    elsif v_view = 'reporter' then
      v_refusal := 'reviewer_only';
    elsif v_row.status = 'resolved' then
      v_refusal := 'resolved';
    elsif v_row.row_version <> requested_row_version then
      v_refusal := 'changed';
    elsif v_row.status = 'reported' then
      v_refusal := 'assign_first';
    end if;
    if v_refusal is not null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
        'quality.incident.investigation', 'denied', 'quality-incident', v_row.id::text,
        jsonb_build_object('refusal', v_refusal));
      return query select v_refusal, false, null::jsonb;
      return;
    end if;
    v_kind := case when v_row.status = 'assigned' then 'investigation_recorded' else 'investigation_amended' end;
    update ehr.quality_incidents incident
       set status = 'investigated', investigation_findings = v_findings, investigated_at = v_now,
           investigated_by_membership_id = caller.actor_membership, updated_at = v_now,
           updated_by_membership_id = caller.actor_membership, row_version = incident.row_version + 1
     where incident.id = v_row.id;
    insert into ehr.quality_incident_events (incident_id, facility_id, event_no, kind, from_status, to_status,
      by_membership_id, at, text_value, row_version_after, idempotency_key, request_sha256)
    values (v_row.id, v_row.facility_id,
      (select coalesce(max(event.event_no), 0) + 1 from ehr.quality_incident_events event
        where event.incident_id = v_row.id),
      v_kind, v_row.status, 'investigated', caller.actor_membership, v_now, v_findings, v_row.row_version + 1,
      requested_idempotency_key, requested_request_sha256);
    select detail.* into v_detail
      from ehr.quality_detail(v_row.id, caller.actor_membership, caller.is_manager) detail;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
      'quality.incident.investigation', 'success', 'quality-incident', v_row.id::text,
      jsonb_build_object('kind', v_kind, 'view', v_view));
    return query select 'ok'::text, false, v_detail.body;
  end
  $fn$;
  comment on function ehr.quality_incident_investigate(uuid, bigint, text, text, text) is
    '0197 (QUAL-1): route 6 (the current reviewer or a manager), the findings: from assigned, status investigated; from investigated, the findings are replaced and the earlier text stays in the history (investigation_amended); from reported, assign_first. Version-checked, idempotent, audited (quality.incident.investigation; never the text).';

  -- Route 7: add a corrective action (the current reviewer or a manager).
  create function ehr.quality_incident_action_add(requested_incident uuid, requested_row_version bigint,
    requested_description text, requested_owner uuid, requested_due_date date, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    v_detail record;
    v_row ehr.quality_incidents%rowtype;
    v_view text;
    v_refusal text;
    v_subject text;
    v_action_id uuid;
    v_description text := btrim(coalesce(requested_description, ''), E' \t\r\n');
    v_now timestamptz := clock_timestamp();
    v_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  begin
    select * into caller from ehr.quality_caller('report');
    if requested_incident is null or requested_row_version is null or requested_row_version < 1
       or requested_owner is null or requested_due_date is null
       or length(v_description) not between 5 and 500 or translate(v_description, E'\t\r\n', '') ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    if requested_due_date < v_today or requested_due_date > v_today + 365 then
      raise exception using errcode = '22023', message = 'QUALITY_DUE_DATE_INVALID';
    end if;
    select * into key_state from ehr.quality_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.incident_id = requested_incident then
      select detail.* into v_detail
        from ehr.quality_detail(requested_incident, caller.actor_membership, caller.is_manager) detail;
      if found then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
          'quality.incident.action-add', 'success', 'quality-incident', requested_incident::text,
          jsonb_build_object('replayed', true));
        return query select 'ok'::text, true, v_detail.body;
        return;
      end if;
    end if;
    select incident.* into v_row from ehr.quality_incidents incident where incident.id = requested_incident for update;
    if found then
      v_view := case when caller.is_manager then 'manager'
                     when v_row.reviewer_membership_id = caller.actor_membership and v_row.status <> 'resolved'
                       then 'reviewer'
                     when v_row.reported_by_membership_id = caller.actor_membership then 'reporter' end;
    end if;
    if v_view is null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
        'quality.incident.action-add', 'failure', 'quality-incident', requested_incident::text,
        jsonb_build_object('outcome', 'not_found'));
      return query select 'not_found'::text, false, null::jsonb;
      return;
    end if;
    if key_state.state <> 'new' then
      v_refusal := 'key_reused';
    elsif v_view = 'reporter' then
      v_refusal := 'reviewer_only';
    elsif v_row.status = 'resolved' then
      v_refusal := 'resolved';
    elsif v_row.row_version <> requested_row_version then
      v_refusal := 'changed';
    elsif v_row.status = 'reported' then
      v_refusal := 'assign_first';
    elsif (select count(*) from ehr.quality_incident_actions action where action.incident_id = v_row.id) >= 20 then
      v_refusal := 'action_limit';
    else
      select account_row.subject into v_subject
        from identity.staff_facility_memberships membership
        join auth.accounts account_row on account_row.id = membership.account_id
       where membership.id = requested_owner and membership.facility_id = caller.actor_facility
         and membership.active and membership.migration_hold_reason is null;
      if v_subject is null
         or not auth.membership_has_permission(v_subject, requested_owner, caller.actor_facility,
                                               'quality.incident.report') then
        v_refusal := 'action_owner_invalid';
      end if;
    end if;
    if v_refusal is not null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
        'quality.incident.action-add', 'denied', 'quality-incident', v_row.id::text,
        jsonb_build_object('refusal', v_refusal));
      return query select v_refusal, false, null::jsonb;
      return;
    end if;
    insert into ehr.quality_incident_actions (incident_id, facility_id, description, owner_membership_id, due_date,
      status, created_at, created_by_membership_id, updated_at, updated_by_membership_id)
    values (v_row.id, v_row.facility_id, v_description, requested_owner, requested_due_date, 'open', v_now,
      caller.actor_membership, v_now, caller.actor_membership)
    returning id into v_action_id;
    update ehr.quality_incidents incident
       set updated_at = v_now, updated_by_membership_id = caller.actor_membership,
           row_version = incident.row_version + 1
     where incident.id = v_row.id;
    insert into ehr.quality_incident_events (incident_id, facility_id, event_no, kind, from_status, to_status,
      by_membership_id, at, text_value, changes, action_id, row_version_after, idempotency_key, request_sha256)
    values (v_row.id, v_row.facility_id,
      (select coalesce(max(event.event_no), 0) + 1 from ehr.quality_incident_events event
        where event.incident_id = v_row.id),
      'action_added', v_row.status, v_row.status, caller.actor_membership, v_now, v_description,
      jsonb_build_object('status', jsonb_build_object('from', null, 'to', 'open'),
        'ownerMembershipId', jsonb_build_object('from', null, 'to', requested_owner),
        'dueDate', jsonb_build_object('from', null, 'to', to_char(requested_due_date, 'YYYY-MM-DD'))),
      v_action_id, v_row.row_version + 1, requested_idempotency_key, requested_request_sha256);
    select detail.* into v_detail
      from ehr.quality_detail(v_row.id, caller.actor_membership, caller.is_manager) detail;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
      'quality.incident.action-add', 'success', 'quality-incident', v_row.id::text,
      jsonb_build_object('actionId', v_action_id, 'ownerMembershipId', requested_owner, 'view', v_view));
    return query select 'ok'::text, false, v_detail.body;
  end
  $fn$;
  comment on function ehr.quality_incident_action_add(uuid, bigint, text, uuid, date, text, text) is
    '0197 (QUAL-1): route 7 (the current reviewer or a manager), a corrective action while assigned or investigated: a description (5-500), an owner from the facility''s staff holding quality.incident.report, a due date from today to 365 days ahead (Lagos); at most 20 per incident. Raises the incident''s row version. Idempotent, audited (quality.incident.action-add; never the text).';

  -- Route 8: change a corrective action (the current reviewer or a manager).
  create function ehr.quality_incident_action_update(requested_incident uuid, requested_action uuid,
    requested_row_version bigint, requested_status text, requested_note text, requested_owner uuid,
    requested_due_date date, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    v_detail record;
    v_row ehr.quality_incidents%rowtype;
    v_action ehr.quality_incident_actions%rowtype;
    v_view text;
    v_refusal text;
    v_subject text;
    v_status text;
    v_note text := nullif(btrim(coalesce(requested_note, ''), E' \t\r\n'), '');
    v_owner uuid;
    v_due date;
    v_changes jsonb := '{}'::jsonb;
    v_now timestamptz := clock_timestamp();
    v_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  begin
    select * into caller from ehr.quality_caller('report');
    if requested_incident is null or requested_action is null or requested_row_version is null
       or requested_row_version < 1
       or (requested_status is not null and requested_status not in ('open', 'done', 'cancelled'))
       or (requested_note is not null
           and (v_note is null or length(v_note) not between 2 and 500
                or translate(v_note, E'\t\r\n', '') ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    if requested_status is null and requested_note is null and requested_owner is null
       and requested_due_date is null then
      raise exception using errcode = '22023', message = 'QUALITY_NOTHING_TO_CHANGE';
    end if;
    if requested_status = 'cancelled' and v_note is null then
      raise exception using errcode = '22023', message = 'QUALITY_REASON_REQUIRED';
    end if;
    if requested_due_date is not null and (requested_due_date < v_today or requested_due_date > v_today + 365) then
      raise exception using errcode = '22023', message = 'QUALITY_DUE_DATE_INVALID';
    end if;
    select * into key_state from ehr.quality_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.incident_id = requested_incident then
      select detail.* into v_detail
        from ehr.quality_detail(requested_incident, caller.actor_membership, caller.is_manager) detail;
      if found then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
          'quality.incident.action-update', 'success', 'quality-incident', requested_incident::text,
          jsonb_build_object('replayed', true, 'actionId', requested_action));
        return query select 'ok'::text, true, v_detail.body;
        return;
      end if;
    end if;
    select incident.* into v_row from ehr.quality_incidents incident where incident.id = requested_incident for update;
    if found then
      v_view := case when caller.is_manager then 'manager'
                     when v_row.reviewer_membership_id = caller.actor_membership and v_row.status <> 'resolved'
                       then 'reviewer'
                     when v_row.reported_by_membership_id = caller.actor_membership then 'reporter' end;
    end if;
    if v_view is null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
        'quality.incident.action-update', 'failure', 'quality-incident', requested_incident::text,
        jsonb_build_object('outcome', 'not_found'));
      return query select 'not_found'::text, false, null::jsonb;
      return;
    end if;
    select action.* into v_action from ehr.quality_incident_actions action
     where action.id = requested_action and action.incident_id = v_row.id
     for update;
    if key_state.state <> 'new' then
      v_refusal := 'key_reused';
    elsif v_view = 'reporter' then
      v_refusal := 'reviewer_only';
    elsif v_action.id is null then
      v_refusal := 'action_not_found';
    elsif v_row.status = 'resolved' then
      v_refusal := 'resolved';
    elsif v_row.row_version <> requested_row_version then
      v_refusal := 'changed';
    else
      v_status := coalesce(requested_status, v_action.status);
      v_owner := coalesce(requested_owner, v_action.owner_membership_id);
      v_due := coalesce(requested_due_date, v_action.due_date);
      if v_status = v_action.status and v_owner = v_action.owner_membership_id and v_due = v_action.due_date
         and (v_note is null or v_note is not distinct from v_action.note) then
        v_refusal := 'nothing_to_change';
      elsif v_owner <> v_action.owner_membership_id then
        select account_row.subject into v_subject
          from identity.staff_facility_memberships membership
          join auth.accounts account_row on account_row.id = membership.account_id
         where membership.id = v_owner and membership.facility_id = caller.actor_facility
           and membership.active and membership.migration_hold_reason is null;
        if v_subject is null
           or not auth.membership_has_permission(v_subject, v_owner, caller.actor_facility,
                                                 'quality.incident.report') then
          v_refusal := 'action_owner_invalid';
        end if;
      end if;
    end if;
    if v_refusal is not null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
        'quality.incident.action-update', 'denied', 'quality-incident', v_row.id::text,
        jsonb_build_object('refusal', v_refusal, 'actionId', requested_action));
      return query select v_refusal, false, null::jsonb;
      return;
    end if;
    if v_status <> v_action.status then
      v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', v_action.status, 'to', v_status));
    end if;
    if v_owner <> v_action.owner_membership_id then
      v_changes := v_changes || jsonb_build_object('ownerMembershipId',
        jsonb_build_object('from', v_action.owner_membership_id, 'to', v_owner));
    end if;
    if v_due <> v_action.due_date then
      v_changes := v_changes || jsonb_build_object('dueDate', jsonb_build_object(
        'from', to_char(v_action.due_date, 'YYYY-MM-DD'), 'to', to_char(v_due, 'YYYY-MM-DD')));
    end if;
    if v_note is not null and v_note is distinct from v_action.note then
      v_changes := v_changes || jsonb_build_object('note', jsonb_build_object('changed', true));
    end if;
    update ehr.quality_incident_actions action
       set status = v_status, owner_membership_id = v_owner, due_date = v_due,
           completed_at = case when v_status = 'done' and v_action.status = 'done' then action.completed_at
                               when v_status = 'done' then v_now end,
           note = coalesce(v_note, action.note), updated_at = v_now, updated_by_membership_id = caller.actor_membership
     where action.id = v_action.id;
    update ehr.quality_incidents incident
       set updated_at = v_now, updated_by_membership_id = caller.actor_membership,
           row_version = incident.row_version + 1
     where incident.id = v_row.id;
    insert into ehr.quality_incident_events (incident_id, facility_id, event_no, kind, from_status, to_status,
      by_membership_id, at, text_value, changes, action_id, row_version_after, idempotency_key, request_sha256)
    values (v_row.id, v_row.facility_id,
      (select coalesce(max(event.event_no), 0) + 1 from ehr.quality_incident_events event
        where event.incident_id = v_row.id),
      'action_updated', v_row.status, v_row.status, caller.actor_membership, v_now,
      case when v_note is not null and v_note is distinct from v_action.note then v_note end, v_changes, v_action.id,
      v_row.row_version + 1, requested_idempotency_key, requested_request_sha256);
    select detail.* into v_detail
      from ehr.quality_detail(v_row.id, caller.actor_membership, caller.is_manager) detail;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
      'quality.incident.action-update', 'success', 'quality-incident', v_row.id::text,
      jsonb_build_object('actionId', v_action.id, 'status', v_status,
        'fieldsChanged', (select coalesce(jsonb_agg(field.key order by field.key), '[]'::jsonb)
                            from jsonb_object_keys(v_changes) field(key)),
        'view', v_view));
    return query select 'ok'::text, false, v_detail.body;
  end
  $fn$;
  comment on function ehr.quality_incident_action_update(uuid, uuid, bigint, text, text, uuid, date, text, text) is
    '0197 (QUAL-1): route 8 (the current reviewer or a manager), change a corrective action of this incident: status open, done (sets the completion time) or cancelled (needs a note), a note (2-500), the owner or the due date, at least one change. Raises the incident''s row version. Idempotent, audited (quality.incident.action-update; never the text).';

  -- Route 9: resolve (manager).
  create function ehr.quality_incident_resolve(requested_incident uuid, requested_row_version bigint,
    requested_resolution text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    v_detail record;
    v_row ehr.quality_incidents%rowtype;
    v_refusal text;
    v_resolution text := btrim(coalesce(requested_resolution, ''), E' \t\r\n');
    v_now timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.quality_caller('manager');
    if requested_incident is null or requested_row_version is null or requested_row_version < 1
       or length(v_resolution) not between 10 and 2000 or translate(v_resolution, E'\t\r\n', '') ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    select * into key_state from ehr.quality_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.incident_id = requested_incident then
      select detail.* into v_detail
        from ehr.quality_detail(requested_incident, caller.actor_membership, caller.is_manager) detail;
      if found then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
          'quality.incident.resolve', 'success', 'quality-incident', requested_incident::text,
          jsonb_build_object('replayed', true));
        return query select 'ok'::text, true, v_detail.body;
        return;
      end if;
    end if;
    select incident.* into v_row from ehr.quality_incidents incident where incident.id = requested_incident for update;
    if not found then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.resolve',
        'failure', 'quality-incident', requested_incident::text, jsonb_build_object('outcome', 'not_found'));
      return query select 'not_found'::text, false, null::jsonb;
      return;
    end if;
    if key_state.state <> 'new' then
      v_refusal := 'key_reused';
    elsif v_row.status = 'resolved' then
      v_refusal := 'resolved';
    elsif v_row.row_version <> requested_row_version then
      v_refusal := 'changed';
    elsif v_row.status <> 'investigated' then
      v_refusal := 'investigate_first';
    elsif exists (select 1 from ehr.quality_incident_actions action
                   where action.incident_id = v_row.id and action.status = 'open') then
      v_refusal := 'actions_open';
    end if;
    if v_refusal is not null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.resolve',
        'denied', 'quality-incident', v_row.id::text, jsonb_build_object('refusal', v_refusal));
      return query select v_refusal, false, null::jsonb;
      return;
    end if;
    update ehr.quality_incidents incident
       set status = 'resolved', resolution = v_resolution, resolved_at = v_now,
           resolved_by_membership_id = caller.actor_membership, updated_at = v_now,
           updated_by_membership_id = caller.actor_membership, row_version = incident.row_version + 1
     where incident.id = v_row.id;
    insert into ehr.quality_incident_events (incident_id, facility_id, event_no, kind, from_status, to_status,
      by_membership_id, at, text_value, row_version_after, idempotency_key, request_sha256)
    values (v_row.id, v_row.facility_id,
      (select coalesce(max(event.event_no), 0) + 1 from ehr.quality_incident_events event
        where event.incident_id = v_row.id),
      'resolved', 'investigated', 'resolved', caller.actor_membership, v_now, v_resolution, v_row.row_version + 1,
      requested_idempotency_key, requested_request_sha256);
    select detail.* into v_detail
      from ehr.quality_detail(v_row.id, caller.actor_membership, caller.is_manager) detail;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
      'quality.incident.resolve', 'success', 'quality-incident', v_row.id::text,
      jsonb_build_object('attestsRowVersion', requested_row_version));
    return query select 'ok'::text, false, v_detail.body;
  end
  $fn$;
  comment on function ehr.quality_incident_resolve(uuid, bigint, text, text, text) is
    '0197 (QUAL-1, Q-QUAL-6 A): route 9 (manager), resolve an investigated incident whose every corrective action is done or cancelled; the resolution (10-2000) attests the investigation at the expected row version. Idempotent, audited (quality.incident.resolve; never the text).';

  -- Route 10: reopen (manager).
  create function ehr.quality_incident_reopen(requested_incident uuid, requested_row_version bigint,
    requested_reason text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    v_detail record;
    v_row ehr.quality_incidents%rowtype;
    v_refusal text;
    v_reason text := btrim(coalesce(requested_reason, ''), E' \t\r\n');
    v_now timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.quality_caller('manager');
    if requested_incident is null or requested_row_version is null or requested_row_version < 1 then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    if length(v_reason) not between 8 and 500 or translate(v_reason, E'\t\r\n', '') ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'QUALITY_REASON_REQUIRED';
    end if;
    select * into key_state from ehr.quality_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.incident_id = requested_incident then
      select detail.* into v_detail
        from ehr.quality_detail(requested_incident, caller.actor_membership, caller.is_manager) detail;
      if found then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
          'quality.incident.reopen', 'success', 'quality-incident', requested_incident::text,
          jsonb_build_object('replayed', true));
        return query select 'ok'::text, true, v_detail.body;
        return;
      end if;
    end if;
    select incident.* into v_row from ehr.quality_incidents incident where incident.id = requested_incident for update;
    if not found then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.reopen',
        'failure', 'quality-incident', requested_incident::text, jsonb_build_object('outcome', 'not_found'));
      return query select 'not_found'::text, false, null::jsonb;
      return;
    end if;
    if key_state.state <> 'new' then
      v_refusal := 'key_reused';
    elsif v_row.row_version <> requested_row_version then
      v_refusal := 'changed';
    elsif v_row.status <> 'resolved' then
      v_refusal := 'not_resolved';
    end if;
    if v_refusal is not null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.reopen',
        'denied', 'quality-incident', v_row.id::text, jsonb_build_object('refusal', v_refusal));
      return query select v_refusal, false, null::jsonb;
      return;
    end if;
    -- Back to assigned with the same reviewer; the findings and actions stay; the resolution stays in the history
    -- (the resolved entry's text).
    update ehr.quality_incidents incident
       set status = 'assigned', resolution = null, resolved_at = null, resolved_by_membership_id = null,
           reopened_count = incident.reopened_count + 1, updated_at = v_now,
           updated_by_membership_id = caller.actor_membership, row_version = incident.row_version + 1
     where incident.id = v_row.id;
    insert into ehr.quality_incident_events (incident_id, facility_id, event_no, kind, from_status, to_status,
      by_membership_id, at, reason, row_version_after, idempotency_key, request_sha256)
    values (v_row.id, v_row.facility_id,
      (select coalesce(max(event.event_no), 0) + 1 from ehr.quality_incident_events event
        where event.incident_id = v_row.id),
      'reopened', 'resolved', 'assigned', caller.actor_membership, v_now, v_reason, v_row.row_version + 1,
      requested_idempotency_key, requested_request_sha256);
    select detail.* into v_detail
      from ehr.quality_detail(v_row.id, caller.actor_membership, caller.is_manager) detail;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
      'quality.incident.reopen', 'success', 'quality-incident', v_row.id::text,
      jsonb_build_object('reopenedCount', v_row.reopened_count + 1));
    return query select 'ok'::text, false, v_detail.body;
  end
  $fn$;
  comment on function ehr.quality_incident_reopen(uuid, bigint, text, text, text) is
    '0197 (QUAL-1): route 10 (manager), reopen a resolved incident with a reason (8-500): status assigned with the same reviewer; the findings and actions stay; the resolution stays in the history; reopenedCount goes up by one. Idempotent, audited (quality.incident.reopen; never the reason).';

  -- Route 11: correct the classification or the patient link (manager).
  create function ehr.quality_incident_correct(requested_incident uuid, requested_row_version bigint,
    requested_reason text, requested_fields text[], requested_category text, requested_harm_level text,
    requested_department_code text, requested_location_text text, requested_told text, requested_patient uuid,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    v_detail record;
    v_row ehr.quality_incidents%rowtype;
    v_refusal text;
    v_reason text := btrim(coalesce(requested_reason, ''), E' \t\r\n');
    v_fields text[] := coalesce(requested_fields, array[]::text[]);
    v_location_given text := nullif(btrim(coalesce(requested_location_text, '')), '');
    v_version text;
    v_category text;
    v_harm text;
    v_department text;
    v_location text;
    v_told text;
    v_patient uuid;
    v_told_required boolean;
    v_link_change text;
    v_basis text;
    v_switch boolean;
    v_changes jsonb := '{}'::jsonb;
    v_key_used boolean := false;
    v_now timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.quality_caller('manager');
    if requested_incident is null or requested_row_version is null or requested_row_version < 1
       or not v_fields <@ array['category', 'harm_level', 'department_code', 'location_text', 'told',
                                'patient_id']::text[]
       or ('location_text' = any (v_fields) and requested_location_text is not null
           and (v_location_given is null or length(v_location_given) not between 2 and 120
                or v_location_given ~ '[[:cntrl:]]'))
       or ('told' = any (v_fields) and requested_told is not null
           and requested_told not in ('yes', 'no', 'not_applicable')) then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    if length(v_reason) not between 8 and 500 or translate(v_reason, E'\t\r\n', '') ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'QUALITY_REASON_REQUIRED';
    end if;
    if cardinality(v_fields) = 0 then
      raise exception using errcode = '22023', message = 'QUALITY_NOTHING_TO_CHANGE';
    end if;
    select version_row.list_version into v_version
      from ehr.quality_list_versions version_row where version_row.active;
    if 'category' = any (v_fields)
       and not exists (select 1 from ehr.quality_list_items item
                        where item.list_version = v_version and item.list_kind = 'category'
                          and item.code = requested_category) then
      raise exception using errcode = '22023', message = 'QUALITY_CATEGORY_INVALID';
    end if;
    if 'harm_level' = any (v_fields)
       and not exists (select 1 from ehr.quality_list_items item
                        where item.list_version = v_version and item.list_kind = 'harm_level'
                          and item.code = requested_harm_level) then
      raise exception using errcode = '22023', message = 'QUALITY_HARM_LEVEL_INVALID';
    end if;
    if 'department_code' = any (v_fields) and requested_department_code is not null
       and not requested_department_code = any (caller.facility_departments) then
      raise exception using errcode = '22023', message = 'QUALITY_DEPARTMENT_INVALID';
    end if;
    select * into key_state from ehr.quality_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.incident_id = requested_incident then
      select detail.* into v_detail
        from ehr.quality_detail(requested_incident, caller.actor_membership, caller.is_manager) detail;
      if found then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
          'quality.incident.correct', 'success', 'quality-incident', requested_incident::text,
          jsonb_build_object('replayed', true));
        return query select 'ok'::text, true, v_detail.body;
        return;
      end if;
    end if;
    select incident.* into v_row from ehr.quality_incidents incident where incident.id = requested_incident for update;
    if not found then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.correct',
        'failure', 'quality-incident', requested_incident::text, jsonb_build_object('outcome', 'not_found'));
      return query select 'not_found'::text, false, null::jsonb;
      return;
    end if;
    v_category := case when 'category' = any (v_fields) then requested_category else v_row.category end;
    v_harm := case when 'harm_level' = any (v_fields) then requested_harm_level else v_row.harm_level end;
    v_department := case when 'department_code' = any (v_fields) then requested_department_code
                         else v_row.department_code end;
    v_location := case when 'location_text' = any (v_fields) then v_location_given else v_row.location_text end;
    v_told := case when 'told' = any (v_fields) then requested_told else v_row.patient_or_family_told end;
    v_patient := case when 'patient_id' = any (v_fields) then requested_patient else v_row.patient_id end;
    v_link_change := case when v_patient is not distinct from v_row.patient_id then null
                          when v_row.patient_id is null then 'set'
                          when v_patient is null then 'cleared'
                          else 'changed' end;
    if v_category is distinct from v_row.category then
      v_changes := v_changes || jsonb_build_object('category', jsonb_build_object('from', v_row.category, 'to', v_category));
    end if;
    if v_harm is distinct from v_row.harm_level then
      v_changes := v_changes || jsonb_build_object('harmLevel', jsonb_build_object('from', v_row.harm_level, 'to', v_harm));
    end if;
    if v_department is distinct from v_row.department_code then
      v_changes := v_changes || jsonb_build_object('departmentCode',
        jsonb_build_object('from', v_row.department_code, 'to', v_department));
    end if;
    if v_location is distinct from v_row.location_text then
      v_changes := v_changes || jsonb_build_object('locationText',
        jsonb_build_object('from', v_row.location_text, 'to', v_location));
    end if;
    if v_told is distinct from v_row.patient_or_family_told then
      v_changes := v_changes || jsonb_build_object('patientOrFamilyTold',
        jsonb_build_object('from', v_row.patient_or_family_told, 'to', v_told));
    end if;
    if key_state.state <> 'new' then
      v_refusal := 'key_reused';
    elsif v_row.status = 'resolved' then
      v_refusal := 'resolved';
    elsif v_row.row_version <> requested_row_version then
      v_refusal := 'changed';
    elsif v_changes = '{}'::jsonb and v_link_change is null then
      v_refusal := 'nothing_to_change';
    end if;
    if v_refusal is not null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.incident.correct',
        'denied', 'quality-incident', v_row.id::text, jsonb_build_object('refusal', v_refusal));
      return query select v_refusal, false, null::jsonb;
      return;
    end if;
    -- The result keeps route 2's rules.
    if v_department is null and v_location is null then
      raise exception using errcode = '22023', message = 'QUALITY_LOCATION_REQUIRED';
    end if;
    select item.told_required into v_told_required
      from ehr.quality_list_items item
     where item.list_version = v_version and item.list_kind = 'harm_level' and item.code = v_harm;
    if coalesce(v_told_required, v_harm in ('moderate', 'severe', 'death')) and v_told is null then
      raise exception using errcode = '22023', message = 'QUALITY_TOLD_REQUIRED';
    end if;
    -- A new link: the switch, then a patient of this facility (clearing always works).
    if v_link_change in ('set', 'changed') then
      select switch_row.enabled into v_switch from ehr.quality_switches switch_row
       where switch_row.key = 'patient_link';
      if not coalesce(v_switch, false) then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
          'quality.incident.patient-link', 'denied', 'quality-incident', v_row.id::text,
          jsonb_build_object('step', 'correction', 'refusal', 'not_available'));
        return query select 'patient_link_not_available'::text, false, null::jsonb;
        return;
      end if;
      v_basis := ehr.quality_patient_of_facility(v_patient, caller.actor_facility);
      if v_basis is null then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
          'quality.incident.patient-link', 'denied', 'quality-incident', v_row.id::text,
          jsonb_build_object('step', 'correction', 'refusal', 'refused'));
        return query select 'patient_link_refused'::text, false, null::jsonb;
        return;
      end if;
    end if;
    update ehr.quality_incidents incident
       set category = v_category, harm_level = v_harm, department_code = v_department, location_text = v_location,
           patient_or_family_told = v_told, patient_id = v_patient,
           patient_linked_at = case when v_link_change in ('set', 'changed') then v_now
                                    when v_link_change = 'cleared' then null else incident.patient_linked_at end,
           patient_linked_by_membership_id = case when v_link_change in ('set', 'changed') then caller.actor_membership
                                                  when v_link_change = 'cleared' then null
                                                  else incident.patient_linked_by_membership_id end,
           updated_at = v_now, updated_by_membership_id = caller.actor_membership,
           row_version = incident.row_version + 1
     where incident.id = v_row.id;
    if v_changes <> '{}'::jsonb then
      insert into ehr.quality_incident_events (incident_id, facility_id, event_no, kind, from_status, to_status,
        by_membership_id, at, reason, changes, row_version_after, idempotency_key, request_sha256)
      values (v_row.id, v_row.facility_id,
        (select coalesce(max(event.event_no), 0) + 1 from ehr.quality_incident_events event
          where event.incident_id = v_row.id),
        'corrected', v_row.status, v_row.status, caller.actor_membership, v_now, v_reason, v_changes,
        v_row.row_version + 1, requested_idempotency_key, requested_request_sha256);
      v_key_used := true;
    end if;
    if v_link_change is not null then
      insert into ehr.quality_incident_events (incident_id, facility_id, event_no, kind, from_status, to_status,
        by_membership_id, at, reason, changes, row_version_after, idempotency_key, request_sha256)
      values (v_row.id, v_row.facility_id,
        (select coalesce(max(event.event_no), 0) + 1 from ehr.quality_incident_events event
          where event.incident_id = v_row.id),
        'patient_link_changed', v_row.status, v_row.status, caller.actor_membership, v_now, v_reason,
        jsonb_build_object('patientLink', v_link_change), v_row.row_version + 1,
        case when not v_key_used then requested_idempotency_key end,
        case when not v_key_used then requested_request_sha256 end);
    end if;
    select detail.* into v_detail
      from ehr.quality_detail(v_row.id, caller.actor_membership, caller.is_manager) detail;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, v_detail.shown_patient,
      'quality.incident.correct', 'success', 'quality-incident', v_row.id::text,
      jsonb_build_object('fieldsChanged',
        (select coalesce(jsonb_agg(field.key order by field.key), '[]'::jsonb)
           from jsonb_object_keys(v_changes) field(key))
        || case when v_link_change is not null then '["patientLink"]'::jsonb else '[]'::jsonb end));
    if v_link_change is not null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation,
        case when v_link_change = 'cleared' then v_row.patient_id else v_patient end,
        'quality.incident.patient-link', 'success', 'quality-incident', v_row.id::text,
        jsonb_build_object('step', 'correction',
          'outcome', case v_link_change when 'set' then 'linked' else v_link_change end, 'basis', v_basis));
    end if;
    return query select 'ok'::text, false, v_detail.body;
  end
  $fn$;
  comment on function ehr.quality_incident_correct(uuid, bigint, text, text[], text, text, text, text, text, uuid, text, text) is
    '0197 (QUAL-1): route 11 (manager), correct the category, harm level, department, place in words, "patient or family told" or the patient link, with a reason (8-500); requested_fields names the fields given (null clears department, place, told or the link). The result keeps route 2''s rules; a new link needs the switch and a patient of this facility (clearing always works). The report as filed never changes. Idempotent, audited (quality.incident.correct with the fields changed by code; quality.incident.patient-link).';

  -- Route 12: the monthly de-identified count (manager).
  create function ehr.quality_incident_counts(requested_month text, requested_format text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    v_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    v_first date;
    v_version text;
    v_status text;
    v_rows jsonb;
    v_total integer;
  begin
    select * into caller from ehr.quality_caller('manager');
    if requested_format is null or requested_format not in ('json', 'csv') then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    if requested_month is null or requested_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception using errcode = '22023', message = 'QUALITY_MONTH_INVALID';
    end if;
    v_first := to_date(requested_month || '-01', 'YYYY-MM-DD');
    if v_first > v_today or v_first < date '2000-01-01' then
      raise exception using errcode = '22023', message = 'QUALITY_MONTH_INVALID';
    end if;
    select version_row.list_version, version_row.status into v_version, v_status
      from ehr.quality_list_versions version_row where version_row.active;
    select coalesce(jsonb_agg(jsonb_build_object('category', counted.category,
               'categoryLabel', coalesce(category_item.label, counted.category),
               'harmLevel', counted.harm_level, 'harmLevelLabel', coalesce(harm_item.label, counted.harm_level),
               'departmentCode', counted.department_code, 'count', counted.incidents)
             order by category_item.position nulls last, counted.category collate "C",
                      harm_item.position nulls last, counted.harm_level collate "C",
                      counted.department_code collate "C" nulls last), '[]'::jsonb),
           coalesce(sum(counted.incidents), 0)::integer
      into v_rows, v_total
      from (select incident.category, incident.harm_level, incident.department_code, count(*)::integer as incidents
              from ehr.quality_incidents incident
             where incident.facility_id = caller.actor_facility
               and incident.occurred_day >= v_first
               and incident.occurred_day < (v_first + interval '1 month')::date
             group by incident.category, incident.harm_level, incident.department_code) counted
      left join ehr.quality_list_items category_item
        on category_item.list_version = v_version and category_item.list_kind = 'category'
       and category_item.code = counted.category
      left join ehr.quality_list_items harm_item
        on harm_item.list_version = v_version and harm_item.list_kind = 'harm_level'
       and harm_item.code = counted.harm_level;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, null,
      'quality.incident.counts-export', 'success', 'quality-incident-counts', requested_month,
      jsonb_build_object('month', requested_month, 'total', v_total, 'format', requested_format,
        'listVersion', v_version));
    return jsonb_build_object('month', requested_month, 'basis', 'occurred', 'listVersion', v_version,
      'listStatus', v_status,
      'generatedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'total', v_total, 'rows', v_rows);
  end
  $fn$;
  comment on function ehr.quality_incident_counts(text, text) is
    '0197 (QUAL-1, Q-QUAL-7 A): route 12 (manager), the session facility''s incidents whose Lagos day of occurrence falls in a month that has started, any status, counted by category, harm level and department, with the active list''s words; exact counts; no id, title, text, name, patient or staff member. Audited (quality.incident.counts-export with the month, total and format).';

  -- Route 13: the active leads (manager).
  create function ehr.quality_lead_list()
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    v_leads jsonb;
    v_count integer;
  begin
    select * into caller from ehr.quality_caller('manager');
    select coalesce(jsonb_agg(jsonb_build_object('leadId', lead.id, 'membershipId', lead.membership_id,
               'namedAt', to_char(lead.named_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'namedByMembershipId', lead.named_by_membership_id)
             order by lead.named_at, lead.id), '[]'::jsonb), count(*)
      into v_leads, v_count
      from ehr.quality_leads lead where lead.facility_id = caller.actor_facility and lead.ended_at is null;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.lead.list',
      'success', 'quality-lead-list', null, jsonb_build_object('resultCount', v_count));
    return jsonb_build_object('leads', v_leads, 'limit', 10);
  end
  $fn$;
  comment on function ehr.quality_lead_list() is
    '0197 (QUAL-1, Q-QUAL-1 A): route 13 (manager), the session facility''s active quality leads. Audited (quality.lead.list).';

  -- Route 14: name a lead (quality.incident.manage itself).
  create function ehr.quality_lead_name(requested_membership uuid, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    v_refusal text;
    v_subject text;
    v_id uuid;
    v_now timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.quality_caller('leads');
    if requested_membership is null then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    select * into key_state from ehr.quality_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.lead_id is not null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.lead.name',
        'success', 'quality-lead', key_state.lead_id::text, jsonb_build_object('replayed', true));
      return query
        select 'ok'::text, true, jsonb_build_object('lead', jsonb_build_object('leadId', lead.id,
                 'membershipId', lead.membership_id,
                 'namedAt', to_char(lead.named_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'namedByMembershipId', lead.named_by_membership_id,
                 'endedAt', to_char(lead.ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'endedByMembershipId', lead.ended_by_membership_id))
          from ehr.quality_leads lead where lead.id = key_state.lead_id;
      return;
    end if;
    -- One naming at a time per facility, so the limit holds.
    perform pg_advisory_xact_lock(hashtextextended('quality-leads:' || caller.actor_facility::text, 0));
    if key_state.state <> 'new' then
      v_refusal := 'key_reused';
    else
      select account_row.subject into v_subject
        from identity.staff_facility_memberships membership
        join auth.accounts account_row on account_row.id = membership.account_id
       where membership.id = requested_membership and membership.facility_id = caller.actor_facility
         and membership.active and membership.migration_hold_reason is null;
      if v_subject is null
         or not auth.membership_has_permission(v_subject, requested_membership, caller.actor_facility,
                                               'quality.incident.report') then
        v_refusal := 'lead_invalid';
      elsif exists (select 1 from ehr.quality_leads lead
                     where lead.facility_id = caller.actor_facility and lead.membership_id = requested_membership
                       and lead.ended_at is null) then
        v_refusal := 'lead_exists';
      elsif (select count(*) from ehr.quality_leads lead
              where lead.facility_id = caller.actor_facility and lead.ended_at is null) >= 10 then
        v_refusal := 'lead_limit';
      end if;
    end if;
    if v_refusal is not null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.lead.name',
        'denied', 'quality-lead', null,
        jsonb_build_object('refusal', v_refusal, 'membershipId', requested_membership));
      return query select v_refusal, false, null::jsonb;
      return;
    end if;
    insert into ehr.quality_leads (facility_id, membership_id, named_at, named_by_membership_id,
      name_idempotency_key, name_request_sha256)
    values (caller.actor_facility, requested_membership, v_now, caller.actor_membership, requested_idempotency_key,
      requested_request_sha256)
    returning id into v_id;
    perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.lead.name',
      'success', 'quality-lead', v_id::text, jsonb_build_object('membershipId', requested_membership));
    return query select 'ok'::text, false, jsonb_build_object('lead', jsonb_build_object('leadId', v_id,
      'membershipId', requested_membership,
      'namedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'namedByMembershipId', caller.actor_membership, 'endedAt', null, 'endedByMembershipId', null));
  end
  $fn$;
  comment on function ehr.quality_lead_name(uuid, text, text) is
    '0197 (QUAL-1, Q251 A, Q-QUAL-1 A): route 14 (holders of quality.incident.manage), name a quality lead from the facility''s active staff holding quality.incident.report; at most 10 active leads; one active row per member. The lead has a manager''s rights here from their next request. Idempotent, audited (quality.lead.name).';

  -- Route 15: end a lead (quality.incident.manage itself); the row is kept.
  create function ehr.quality_lead_end(requested_lead uuid, requested_reason text, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, body jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    v_lead ehr.quality_leads%rowtype;
    v_refusal text;
    v_reason text := btrim(coalesce(requested_reason, ''), E' \t\r\n');
    v_now timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.quality_caller('leads');
    if requested_lead is null then
      raise exception using errcode = '22023', message = 'QUALITY_INVALID';
    end if;
    if length(v_reason) not between 8 and 500 or translate(v_reason, E'\t\r\n', '') ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'QUALITY_REASON_REQUIRED';
    end if;
    select * into key_state from ehr.quality_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    select lead.* into v_lead from ehr.quality_leads lead where lead.id = requested_lead for update;
    if v_lead.id is null then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.lead.end',
        'failure', 'quality-lead', requested_lead::text, jsonb_build_object('outcome', 'not_found'));
      return query select 'lead_not_found'::text, false, null::jsonb;
      return;
    end if;
    if key_state.state = 'replay' and key_state.lead_id = requested_lead then
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.lead.end',
        'success', 'quality-lead', requested_lead::text, jsonb_build_object('replayed', true));
    else
      if key_state.state <> 'new' then
        v_refusal := 'key_reused';
      elsif v_lead.ended_at is not null then
        v_refusal := 'lead_ended';
      end if;
      if v_refusal is not null then
        perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.lead.end',
          'denied', 'quality-lead', requested_lead::text, jsonb_build_object('refusal', v_refusal));
        return query select v_refusal, false, null::jsonb;
        return;
      end if;
      update ehr.quality_leads lead
         set ended_at = v_now, ended_by_membership_id = caller.actor_membership, end_reason = v_reason,
             end_idempotency_key = requested_idempotency_key, end_request_sha256 = requested_request_sha256
       where lead.id = v_lead.id;
      perform ehr.quality_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, null, 'quality.lead.end',
        'success', 'quality-lead', v_lead.id::text, jsonb_build_object('membershipId', v_lead.membership_id));
    end if;
    return query
      select 'ok'::text, key_state.state = 'replay',
             jsonb_build_object('lead', jsonb_build_object('leadId', lead.id, 'membershipId', lead.membership_id,
               'namedAt', to_char(lead.named_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'namedByMembershipId', lead.named_by_membership_id,
               'endedAt', to_char(lead.ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'endedByMembershipId', lead.ended_by_membership_id))
        from ehr.quality_leads lead where lead.id = v_lead.id;
  end
  $fn$;
  comment on function ehr.quality_lead_end(uuid, text, text, text) is
    '0197 (QUAL-1, Q-QUAL-1 A): route 15 (holders of quality.incident.manage), end a quality lead of the session facility with a reason (8-500); the row is kept; lead_ended when already ended, lead_not_found for another facility''s lead or none. The member loses a manager''s rights from their next request. Idempotent, audited (quality.lead.end; never the reason).';

  -- Row-level security, forced, one policy per table for the owner only. The five facility tables are also bound
  -- to the session facility. No privilege for any other role.
  alter table ehr.quality_list_versions enable row level security;
  alter table ehr.quality_list_versions force row level security;
  alter table ehr.quality_list_items enable row level security;
  alter table ehr.quality_list_items force row level security;
  alter table ehr.quality_switches enable row level security;
  alter table ehr.quality_switches force row level security;
  alter table ehr.quality_leads enable row level security;
  alter table ehr.quality_leads force row level security;
  alter table ehr.quality_incidents enable row level security;
  alter table ehr.quality_incidents force row level security;
  alter table ehr.quality_incident_actions enable row level security;
  alter table ehr.quality_incident_actions force row level security;
  alter table ehr.quality_incident_events enable row level security;
  alter table ehr.quality_incident_events force row level security;
  -- (The policy text names the owner, so it is built here: the only dynamic SQL of this file, outside every
  -- function body.)
  execute format('create policy quality_list_versions_owner on ehr.quality_list_versions for all to %I '
    || 'using (current_user = %L) with check (current_user = %L)', v_owner, v_owner, v_owner);
  execute format('create policy quality_list_items_owner on ehr.quality_list_items for all to %I '
    || 'using (current_user = %L) with check (current_user = %L)', v_owner, v_owner, v_owner);
  execute format('create policy quality_switches_owner on ehr.quality_switches for all to %I '
    || 'using (current_user = %L) with check (current_user = %L)', v_owner, v_owner, v_owner);
  execute format('create policy quality_leads_owner on ehr.quality_leads for all to %I '
    || 'using (current_user = %L and facility_id = platform.current_facility_id()) '
    || 'with check (current_user = %L and facility_id = platform.current_facility_id())', v_owner, v_owner, v_owner);
  execute format('create policy quality_incidents_owner on ehr.quality_incidents for all to %I '
    || 'using (current_user = %L and facility_id = platform.current_facility_id()) '
    || 'with check (current_user = %L and facility_id = platform.current_facility_id())', v_owner, v_owner, v_owner);
  execute format('create policy quality_incident_actions_owner on ehr.quality_incident_actions for all to %I '
    || 'using (current_user = %L and facility_id = platform.current_facility_id()) '
    || 'with check (current_user = %L and facility_id = platform.current_facility_id())', v_owner, v_owner, v_owner);
  execute format('create policy quality_incident_events_owner on ehr.quality_incident_events for all to %I '
    || 'using (current_user = %L and facility_id = platform.current_facility_id()) '
    || 'with check (current_user = %L and facility_id = platform.current_facility_id())', v_owner, v_owner, v_owner);
  revoke all on ehr.quality_list_versions, ehr.quality_list_items, ehr.quality_switches, ehr.quality_leads,
    ehr.quality_incidents, ehr.quality_incident_actions, ehr.quality_incident_events from public;
  revoke all on function
    ehr.quality_caller(text), ehr.quality_patient_of_facility(uuid, uuid), ehr.quality_detail(uuid, uuid, boolean),
    ehr.quality_audit(text, uuid, uuid, uuid, uuid, text, uuid, text, text, text, text, jsonb),
    ehr.quality_idempotency(uuid, text, text), ehr.quality_incident_fixed_fields(),
    ehr.quality_action_fixed_fields(), ehr.quality_lead_end_once(),
    ehr.quality_me(),
    ehr.quality_incident_report(text, text, timestamptz, text, text, text, text, text, text, uuid, text, text),
    ehr.quality_incident_list(text, text, text, text, date, date, text, integer, timestamptz, uuid),
    ehr.quality_incident_read(uuid), ehr.quality_incident_assign(uuid, bigint, uuid, text, text),
    ehr.quality_incident_investigate(uuid, bigint, text, text, text),
    ehr.quality_incident_action_add(uuid, bigint, text, uuid, date, text, text),
    ehr.quality_incident_action_update(uuid, uuid, bigint, text, text, uuid, date, text, text),
    ehr.quality_incident_resolve(uuid, bigint, text, text, text),
    ehr.quality_incident_reopen(uuid, bigint, text, text, text),
    ehr.quality_incident_correct(uuid, bigint, text, text[], text, text, text, text, text, uuid, text, text),
    ehr.quality_incident_counts(text, text), ehr.quality_lead_list(), ehr.quality_lead_name(uuid, text, text),
    ehr.quality_lead_end(uuid, text, text, text)
    from public;

  -- Owners and EXECUTE (as 0135: the owner of identity.has_active_consent_grant).
  if v_owner <> current_user then
    execute format('alter table ehr.quality_list_versions owner to %I', v_owner);
    execute format('alter table ehr.quality_list_items owner to %I', v_owner);
    execute format('alter table ehr.quality_switches owner to %I', v_owner);
    execute format('alter table ehr.quality_leads owner to %I', v_owner);
    execute format('alter table ehr.quality_incidents owner to %I', v_owner);
    execute format('alter table ehr.quality_incident_actions owner to %I', v_owner);
    execute format('alter table ehr.quality_incident_events owner to %I', v_owner);
    execute (select string_agg(format('alter function %s owner to %I', proc.oid::regprocedure, v_owner), '; ')
               from pg_proc proc
              where proc.pronamespace = 'ehr'::regnamespace and proc.proname like 'quality\_%');
  end if;
  if v_runtime_exists then
    grant execute on function
      ehr.quality_me(),
      ehr.quality_incident_report(text, text, timestamptz, text, text, text, text, text, text, uuid, text, text),
      ehr.quality_incident_list(text, text, text, text, date, date, text, integer, timestamptz, uuid),
      ehr.quality_incident_read(uuid), ehr.quality_incident_assign(uuid, bigint, uuid, text, text),
      ehr.quality_incident_investigate(uuid, bigint, text, text, text),
      ehr.quality_incident_action_add(uuid, bigint, text, uuid, date, text, text),
      ehr.quality_incident_action_update(uuid, uuid, bigint, text, text, uuid, date, text, text),
      ehr.quality_incident_resolve(uuid, bigint, text, text, text),
      ehr.quality_incident_reopen(uuid, bigint, text, text, text),
      ehr.quality_incident_correct(uuid, bigint, text, text[], text, text, text, text, text, uuid, text, text),
      ehr.quality_incident_counts(text, text), ehr.quality_lead_list(), ehr.quality_lead_name(uuid, text, text),
      ehr.quality_lead_end(uuid, text, text, text)
      to hid_ehr_runtime;
  end if;

  -- 3. Post-checks.
  -- Tables: the owner, row-level security enabled and forced, exactly one policy (for all, to the owner, with the
  -- owner's and, on the facility tables, the session facility's expression), no privilege for any other role.
  if (select count(*) from pg_class class_row
       where class_row.oid = any (v_tables::regclass[]) and class_row.relkind = 'r'
         and class_row.relowner = v_owner_oid and class_row.relrowsecurity and class_row.relforcerowsecurity) <> 7
     or exists (select 1 from pg_class class_row,
                       lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
                 where class_row.oid = any (v_tables::regclass[]) and acl.grantee <> class_row.relowner) then
    raise exception using errcode = '55000',
      message = '0197: post-check failed (a table''s owner, row-level security or privileges)';
  end if;
  if (select count(*) from pg_policy policy_row where policy_row.polrelid = any (v_tables::regclass[])) <> 7
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = any (v_tables::regclass[])
            and policy_row.polcmd = '*' and policy_row.polpermissive
            and policy_row.polroles = array[v_owner_oid]
            and policy_row.polname = replace(policy_row.polrelid::regclass::text, 'ehr.', '') || '_owner'
            and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                = case when policy_row.polrelid::regclass::text = any (v_facility_tables)
                       then '((CURRENT_USER = ' || quote_literal(v_owner)
                            || '::name) AND (facility_id = platform.current_facility_id()))'
                       else '(CURRENT_USER = ' || quote_literal(v_owner) || '::name)' end
            and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)
                = pg_get_expr(policy_row.polqual, policy_row.polrelid)) <> 7 then
    raise exception using errcode = '55000', message = '0197: post-check failed (the policies)';
  end if;
  -- Functions: the owner; the fifteen SECURITY DEFINER, the eight helpers not; proconfig exactly the fixed
  -- search_path; EXECUTE only for hid_ehr_runtime on the fifteen (when the role exists), for nobody on the helpers.
  if (select count(*) from pg_proc proc
       where proc.pronamespace = 'ehr'::regnamespace and proc.proname like 'quality\_%') <> 23
     or (select count(*) from pg_proc proc
          where proc.oid = any (v_entry_points::regprocedure[]) and proc.prosecdef and proc.proowner = v_owner_oid
            and proc.proconfig = array['search_path=pg_catalog, pg_temp']) <> 15
     or (select count(*) from pg_proc proc
          where proc.oid = any (v_helpers::regprocedure[]) and not proc.prosecdef and proc.proowner = v_owner_oid
            and proc.proconfig = array['search_path=pg_catalog, pg_temp']) <> 8
     or exists (select 1 from pg_proc proc,
                       lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.pronamespace = 'ehr'::regnamespace and proc.proname like 'quality\_%'
                   and acl.grantee <> proc.proowner
                   and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                        or acl.privilege_type <> 'EXECUTE'
                        or not proc.oid = any (v_entry_points::regprocedure[])))
     or (v_runtime_exists
         and (select count(*) from pg_proc proc
               where proc.oid = any (v_entry_points::regprocedure[])
                 and has_function_privilege('hid_ehr_runtime', proc.oid, 'EXECUTE')) <> 15) then
    raise exception using errcode = '55000', message = '0197: post-check failed (the functions'' security or grants)';
  end if;
  -- Triggers (pg_trigger.tgtype: 1 for each row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate): 11 before
  -- delete for each row, 19 before update for each row, 27 before update or delete for each row, 34 before
  -- truncate; with no WHEN condition (tgqual), no column list (tgattr), no arguments, enabled (O), and the function.
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = any (v_tables::regclass[]) and not trigger_row.tgisinternal) <> 17
     or (select count(*) from pg_trigger trigger_row
          join (values
            ('ehr.quality_list_versions', 'quality_list_versions_no_delete', 11, 'platform.reject_mutation()'),
            ('ehr.quality_list_versions', 'quality_list_versions_no_truncate', 34, 'platform.reject_mutation()'),
            ('ehr.quality_list_items', 'quality_list_items_append_only', 27, 'platform.reject_mutation()'),
            ('ehr.quality_list_items', 'quality_list_items_no_truncate', 34, 'platform.reject_mutation()'),
            ('ehr.quality_switches', 'quality_switches_no_delete', 11, 'platform.reject_mutation()'),
            ('ehr.quality_switches', 'quality_switches_no_truncate', 34, 'platform.reject_mutation()'),
            ('ehr.quality_leads', 'quality_leads_no_delete', 11, 'platform.reject_mutation()'),
            ('ehr.quality_leads', 'quality_leads_no_truncate', 34, 'platform.reject_mutation()'),
            ('ehr.quality_leads', 'quality_leads_end_once', 19, 'ehr.quality_lead_end_once()'),
            ('ehr.quality_incidents', 'quality_incidents_no_delete', 11, 'platform.reject_mutation()'),
            ('ehr.quality_incidents', 'quality_incidents_no_truncate', 34, 'platform.reject_mutation()'),
            ('ehr.quality_incidents', 'quality_incidents_fixed_fields', 19, 'ehr.quality_incident_fixed_fields()'),
            ('ehr.quality_incident_actions', 'quality_incident_actions_no_delete', 11, 'platform.reject_mutation()'),
            ('ehr.quality_incident_actions', 'quality_incident_actions_no_truncate', 34, 'platform.reject_mutation()'),
            ('ehr.quality_incident_actions', 'quality_incident_actions_fixed_fields', 19,
             'ehr.quality_action_fixed_fields()'),
            ('ehr.quality_incident_events', 'quality_incident_events_append_only', 27, 'platform.reject_mutation()'),
            ('ehr.quality_incident_events', 'quality_incident_events_no_truncate', 34, 'platform.reject_mutation()'))
            wanted(relation, name, kind, function_name)
            on trigger_row.tgrelid = wanted.relation::regclass and trigger_row.tgname = wanted.name
       where not trigger_row.tgisinternal and trigger_row.tgtype = wanted.kind
         and trigger_row.tgfoid = wanted.function_name::regprocedure and trigger_row.tgenabled = 'O'
         and trigger_row.tgqual is null and trigger_row.tgattr = ''::int2vector and trigger_row.tgnargs = 0) <> 17 then
    raise exception using errcode = '55000', message = '0197: post-check failed (the triggers)';
  end if;
  -- The catalog fingerprint: every object exactly as this file makes it.
  select md5(coalesce(string_agg(part.line, E'\n' order by part.line collate "C"), '')) into v_fingerprint
    from (
      select 'table ' || class_row.relname || ' ' || class_row.relkind::text || ' rls=' || class_row.relrowsecurity
             || ' force=' || class_row.relforcerowsecurity || ' owner=' || (class_row.relowner = v_owner_oid)
             || ' acl=' || coalesce((select string_agg(case when acl.grantee = class_row.relowner then '<owner>'
                                                            when acl.grantee = 0 then 'public'
                                                            else pg_get_userbyid(acl.grantee) end
                                                       || ':' || acl.privilege_type, ',' order by 1)
                                       from aclexplode(coalesce(class_row.relacl,
                                                                acldefault('r', class_row.relowner))) acl), '')
        from pg_class class_row
       where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
         and class_row.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      union all
      select 'column ' || class_row.relname || ' ' || attribute_row.attnum || ' ' || attribute_row.attname || ' '
             || format_type(attribute_row.atttypid, attribute_row.atttypmod) || ' ' || attribute_row.attnotnull
             || ' ' || attribute_row.attidentity::text || attribute_row.attgenerated::text || ' '
             || coalesce(pg_get_expr(default_row.adbin, default_row.adrelid), '')
        from pg_class class_row
        join pg_attribute attribute_row on attribute_row.attrelid = class_row.oid
         and attribute_row.attnum > 0 and not attribute_row.attisdropped
        left join pg_attrdef default_row on default_row.adrelid = class_row.oid
         and default_row.adnum = attribute_row.attnum
       where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
         and class_row.relkind = 'r'
      union all
      select 'constraint ' || class_row.relname || ' ' || constraint_row.conname || ' '
             || pg_get_constraintdef(constraint_row.oid)
        from pg_constraint constraint_row
        join pg_class class_row on class_row.oid = constraint_row.conrelid
       where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
      union all
      select 'index ' || pg_get_indexdef(index_row.indexrelid)
        from pg_index index_row
        join pg_class class_row on class_row.oid = index_row.indrelid
       where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
      union all
      select 'trigger ' || class_row.relname || ' ' || trigger_row.tgname || ' ' || trigger_row.tgtype || ' '
             || trigger_row.tgfoid::regprocedure::text || ' ' || trigger_row.tgenabled::text || ' '
             || (trigger_row.tgqual is null) || ' ' || trigger_row.tgattr::text || ' ' || trigger_row.tgnargs
        from pg_trigger trigger_row
        join pg_class class_row on class_row.oid = trigger_row.tgrelid
       where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
         and not trigger_row.tgisinternal
      union all
      select 'policy ' || class_row.relname || ' ' || policy_row.polname || ' ' || policy_row.polcmd::text || ' '
             || policy_row.polpermissive || ' '
             || coalesce((select string_agg(case when role_id = v_owner_oid then '<owner>'
                                                 when role_id = 0 then 'public'
                                                 else pg_get_userbyid(role_id) end, ',' order by 1)
                            from unnest(policy_row.polroles) role_id), '') || ' '
             || replace(coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), ''),
                        quote_literal(v_owner), '<owner>') || ' '
             || replace(coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), ''),
                        quote_literal(v_owner), '<owner>')
        from pg_policy policy_row
        join pg_class class_row on class_row.oid = policy_row.polrelid
       where class_row.relnamespace = 'ehr'::regnamespace and class_row.relname like 'quality\_%'
      union all
      select 'function ' || proc.oid::regprocedure::text || ' ' || md5(proc.prosrc) || ' ' || proc.prosecdef
             || ' ' || proc.provolatile::text || ' ' || coalesce(array_to_string(proc.proconfig, ';'), '') || ' owner='
             || (proc.proowner = v_owner_oid) || ' ' || language_row.lanname || ' '
             || pg_get_function_result(proc.oid)
        from pg_proc proc
        join pg_language language_row on language_row.oid = proc.prolang
       where proc.pronamespace = 'ehr'::regnamespace and proc.proname like 'quality\_%'
    ) part(line);
  if v_fingerprint is distinct from v_fingerprint_expected then
    raise exception using errcode = '55000',
      message = '0197: post-check failed (the catalog fingerprint is ' || v_fingerprint || ', not '
        || v_fingerprint_expected || ')';
  end if;
  -- No row of an existing table written in this file (this transaction's counts of every other user table).
  select coalesce(sum(stat.n_tup_ins + stat.n_tup_upd + stat.n_tup_del), 0) into v_writes_after
    from pg_stat_xact_user_tables stat
   where not stat.relid = any (v_tables::regclass[]);
  if v_writes_after <> v_writes_before then
    raise exception using errcode = '55000', message = '0197: post-check failed (a row of an existing table was written)';
  end if;

  perform pg_catalog.set_config('search_path', v_search_path, true);
  raise notice '0197: quality and safety reporting is installed (7 tables with forced row-level security, 23 functions, the DRAFT list QS-DRAFT-1 and the patient-link switch off). Nobody can use it until 0198 gives the codes.';
end
$quality0197$;
