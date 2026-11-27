-- 0207 ID-8a: merge requests and the review list (no merge yet). The planned
-- contract's "ID-8: Merge an unknown or duplicate record into the real one,
-- with a 30-day undo", routes 1, 2, 3, 5 and 6; Rahman's design note on
-- hid-system#258 (part "ID-8a"). Written on staging at 0cfddcc9 (0001-0153
-- applied: Release E, live). The number is provisional: numbers are given at
-- integration, in release order (#258). The declaration in
-- config/production-schema-compatibility.json stays unsigned until the owner
-- signs this file.
--
-- ID-8b (the merge itself and the 30-day undo, 0208) is NOT in this file: its
-- mechanism waits for the owner's decision. Here a member asks, an approver
-- refuses, the asker cancels; nothing moves, no record changes, and no
-- clinical table is touched. identity-api answers the approve and undo routes
-- 503 MERGE_UNAVAILABLE while 0208 is absent.
--
-- Owner decision Q127 A (19 November 2026): two different staff members (one
-- asks, another decides); the source is an unknown (ID-7) or NIN Not Verified
-- record that nobody signs in to, made at this facility; the target is an
-- active, standard record on the same side of the seals.
--
-- What it adds (nothing else):
-- D1 identity.patient_merges: one row per request. The facility, the source
--    and target patients (foreign keys ON DELETE RESTRICT: both stay on the
--    "kept" side of any merge), the asker (account and membership, by the
--    membership's unique (id, facility_id, account_id) as 0129 does, so the
--    facility and account are the membership's own), the reason (8-500,
--    trimmed), the status (requested, merged, undone, refused, cancelled), the
--    version, the decision (who, when, the refusal's reason), the cancel, and
--    the Idempotency-Key and the request's SHA-256 of each command (request,
--    refuse, cancel; unique per account and key). merged_at, undo_until,
--    undone_at, undone_by_*, undo_reason and the undo key are null in 0207:
--    they are reserved for ID-8b (approve uses the decision columns), so 0208
--    needs no ALTER TABLE on this table; the status CHECK already admits
--    merged and undone with their shapes. A partial UNIQUE keeps at most one
--    request per source while it is 'requested' (MERGE_ALREADY_OPEN).
--    Row-level security is enabled (not forced) with no policy, and no
--    runtime role holds any privilege on it: only the functions below read
--    and write it, as its owner (0145 D2).
-- D2 The source rule (identity.patient_merge_source_state, STABLE, pinned by
--    the post-check): 'not_found' unless the patient is active and this
--    facility's own, made here as (a) an unknown record (ID-7, 0145) whose
--    status is open, sent_for_review or identified, or (b) a desk record (ID-2,
--    0130): a registration case of this facility with identity_evidence
--    'none', status approved_new_identity, resolving to the patient, and the
--    patient's source_system 'hid-desk-registration'. Then 'not_allowed'
--    unless NIN Not Verified (no verified, unrevoked 'nin' identifier: the
--    rule of services/identity-api/src/identity/nin-status.ts lines 15-28)
--    and signed in to by nobody: identity.patients.account_id is null and no
--    outreach Health ID claim is open (claimed_at and invalidated_at null,
--    expires_at in the future). identity.patient_enrollments (0032) and
--    identity.public_patient_enrollments (0051) are read through
--    account_id, not directly: both have row-level security forced, and the
--    owner reads patient_enrollments only at the session's facility and only
--    for an approver (patient_enrollments_governed), and
--    public_patient_enrollments only in Identity's system:auth session
--    (public_patient_enrollment_system), so a direct read would answer a desk
--    member and an approver differently and miss every other facility's
--    enrolment. account_id is the one signal both set in the same transaction
--    as their row (0032's enrolment; 0051 creates the patient with its
--    account), and no path clears it. 'allowed' otherwise. Request
--    answers PATIENT_NOT_FOUND (Q100 B) and MERGE_SOURCE_NOT_ALLOWED; every
--    answer reports sourceStillAllowed while the request is open, so the
--    approver sees a source that has since gained a NIN or a login.
-- D3 The target, by matchRef only (identity.patient_merge_target): the
--    member's own standard search (0132) at this facility, purpose
--    direct-care, in the last 10 minutes. The request itself runs under
--    healthcare-operations, and 0132's identity.resolve_patient_search_ref
--    answers only a ref whose purpose is the session's (0132 line 438), so
--    this file reads identity.patient_search_refs itself with the purpose
--    direct-care named, the account, membership and facility the session's,
--    pinning the table's shape and the resolver's md5. An invalid, expired,
--    other member's or emergency ref is MERGE_SEARCH_FIRST (one answer for
--    all). The ref's patient is then refused MERGE_SAME_RECORD when it is the
--    source, and MERGE_TARGET_NOT_ALLOWED unless it is active, standard
--    (identity.patient_record_kind, pinned), and on the source's side of both
--    seals (identity.sealed_demo_patient and identity.sealed_qa_patient
--    equal, and the facility's seals equal the target's, as 0132's resolver
--    tests them).
-- D4 The moves counts (visits, notes, vitals, diagnoses, prescriptions,
--    labRequests, documents, allergies) of the source only, read as the
--    tables' owner: ehr.encounters through 0131's encounters_owner_read, the
--    other seven through 0145's marker-gated <table>_cancel_check_read
--    policies (0145 D11), each pinned exactly. The marker
--    (ehr.unknown_patient_cancel_scans) is inserted just before the counts and
--    deleted just after them, inside the function, as 0145's cancel does, and
--    only if this call inserted it. Vitals count the recorded readings: 0142's
--    restrictive vitals_entered_in_error_hidden hides readings entered in error
--    from every reader, the owner included. Notes and vitals are counted
--    through the source's visits (ehr.encounters' (patient_id, started_at)
--    index, then each visit's notes and vitals by their (encounter_id, ...)
--    indexes): neither table has an index that starts with patient_id, and
--    each row's (encounter_id, patient_id, facility_id) references its visit's
--    (0004's foreign keys, encounter_id not null; pinned below), so the
--    visits' rows are exactly the patient's. No policy and no index is added: no clinical
--    table is locked.
-- D5 Five SECURITY DEFINER functions for the Identity runtime (search_path
--    pg_catalog, pg_temp; every name qualified; EXECUTE revoked from PUBLIC
--    and granted to hid_identity_runtime alone, as 0145 grants its commands),
--    each needing a staff session at its facility, purpose
--    healthcare-operations and an active unheld membership:
--      identity.request_patient_merge     identity.registration.write
--      identity.list_patient_merges       view mine: identity.registration.write
--                                         (this account's requests here);
--                                         view facility: .approve (all here)
--      identity.read_patient_merge        the asker (.write) or an approver
--                                         (.approve) at this facility;
--                                         anyone else MERGE_NOT_FOUND
--      identity.refuse_patient_merge      .approve, never the asker
--                                         (MERGE_SECOND_PERSON_REQUIRED, Q127 A)
--      identity.cancel_patient_merge      the asker (.write)
--    Writes replay by key: the same SHA-256 answers the stored request again
--    (replayed: true, audited), another one is 23505 IDEMPOTENCY_KEY_REUSED.
--    Refuse and cancel are refused MERGE_ALREADY_DECIDED unless the request is
--    'requested', and 40001 VERSION_CONFLICT unless the expected version is
--    the row's. Each answer is one jsonb item: the request, the source card
--    (patientId, fullName, sex, dateOfBirth, dateOfBirthEstimated,
--    healthIdLast4, ninStatus, recordKind), the target card (the search card's
--    fields, no patientId, no clinical counts), the moves counts and
--    targetPatientId, which identity-api uses for its audit rows and never
--    answers. Helpers (no role may execute them; they run inside the five,
--    as the owner): identity.patient_merge_actor,
--    identity.patient_merge_audit, identity.patient_merge_source_state,
--    identity.patient_merge_target, identity.patient_merge_items.
-- D6 Audit, in the request's transaction: request, read, refuse and cancel
--    each write their row (identity.patient-merge.request, .read, .refuse,
--    .cancel), replays included: patient_id the source, resource the merge,
--    details {mergeId, targetPatientId, moves, outcome or status}, the typed
--    reason in the row's reason column; never a name, date of birth, phone or
--    Health ID. The list writes none (identity-api writes .list and one
--    .list.shown per patient shown, both ids in details). A refusal raises,
--    so the function's rows roll back and identity-api writes the refusal's
--    row; when the caller may see the request, the error's DETAIL carries the
--    merge's and both patients' ids for that row.
--
-- Locks (measured with pg_locks before commit and compared by the migrations
-- suite), taken first, NOWAIT: SHARE ROW EXCLUSIVE on identity.patients and
-- identity.staff_facility_memberships (the foreign keys of the new, empty
-- table), and ACCESS SHARE on identity.patient_search_refs (its CHECKs are
-- read with pg_get_constraintdef, which opens the table to name its columns).
-- Nothing else, not even for a moment: every function is plpgsql, whose
-- bodies are not analysed when created, so no table they name is locked; the
-- policies D2 and D4 read through are read with pg_get_expr(expression, 0),
-- which names no relation and so opens none (pg_get_expr(expression,
-- polrelid) would take and release ACCESS SHARE on each of the eight clinical
-- tables, and wait behind any ACCESS EXCLUSIVE there); the other
-- preconditions and post-checks read only the catalog (pg_class, pg_proc,
-- pg_policy, pg_attribute, pg_constraint, pg_index, pg_roles, pg_namespace,
-- pg_locks, pg_database) and the new table. No ehr., lab. or pharmacy. table
-- is locked: the migrations suite applies the file while another session
-- holds every one of them, and identity.registration_cases and
-- identity.outreach_health_id_claims, in ACCESS EXCLUSIVE. SHARE ROW
-- EXCLUSIVE does not block reads, and ACCESS SHARE blocks only ACCESS
-- EXCLUSIVE; a write to identity.patients or the memberships in flight stops
-- the attempt. A busy table fails the attempt at once, and its subtransaction
-- releases what it took. The attempt is made 50 times, 100 ms apart (about 5
-- seconds), so the file never waits for one of its locks while holding
-- another; then 55P03 (nothing applied). When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run applies every pending file
-- in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied. Both refusals begin "0207: " and end "run the release again at a
-- quieter time", so the runner's dry run rolls back and tries again (#306).
--
-- Old images on this schema: nothing calls the new functions; identity-api's
-- routes answer 404 while PATIENT_MERGE_REQUESTS_ENABLED is false.
--
-- Role bootstrap: this file grants its own EXECUTE. A role bootstrap run
-- after it must use the integration's runtime-grants.sql (with this file's
-- block), never an older file alone, which would leave the five functions
-- without the Identity runtime's EXECUTE.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- eleven functions and the table (no other object refers to them).
--
-- The whole file is one statement (do $id8a$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0001-0153 applied (a marker of
--    0153, and of 0002, 0003, 0032, 0051, 0120, 0130, 0131, 0132 and 0145,
--    whose objects the functions read); "0207: already applied" when the
--    table and the eleven functions are there, "0207: the schema is not in
--    the reviewed state" for any part of them or any other identity function
--    named like patient_merge; "0207: an ID-8b object is already there" for
--    identity.patient_merge_moves, identity.patients.merged_into_patient_id or
--    an approve or undo function; the bodies the functions call md5-pinned;
--    the policies D4 reads through, 0130's registration_cases_owner_read and
--    0120's outreach_health_id_claims_owner exactly as those files left them
--    (read with pg_get_expr(expression, 0), which opens no table); 0132's
--    table by its columns and CHECKs; the columns read, by type; the notes'
--    and vitals' reference to their visit (0004), which D4 counts through;
--    the membership key D1 references; no hid_ role but the owner a member of
--    the clinical tables' owners (0145 D11's premise).
-- 2. D1-D6, the owner (the owner of identity.has_active_consent_grant, as
--    0145) and EXECUTE.
-- 3. Post-checks: the table (owner, kind, row-level security enabled and not
--    forced, no policy, no privilege for another role, its four foreign keys
--    with their actions, its CHECKs, its unique keys and the partial unique
--    index); the eleven functions (owner, SECURITY DEFINER on the five entry
--    points only, the fixed search_path on all, each body's md5, EXECUTE to
--    hid_identity_runtime on the five only, never with grant option, and to
--    no other role).

do $id8a$
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
  v_owner_oid oid;
  -- The eleven functions, by signature: five entry points, then six helpers.
  v_entry_points constant text[] := array[
    'identity.request_patient_merge(uuid,text,text,text,text)',
    'identity.list_patient_merges(text,text,integer,timestamp with time zone,uuid)',
    'identity.read_patient_merge(uuid)',
    'identity.refuse_patient_merge(uuid,bigint,text,text,text)',
    'identity.cancel_patient_merge(uuid,bigint,text,text)'];
  v_helpers constant text[] := array[
    'identity.patient_merge_actor()',
    'identity.patient_merge_audit(record,text,text,uuid,uuid,text,jsonb)',
    'identity.patient_merge_source_state(uuid,uuid)',
    'identity.patient_merge_target(text,uuid,uuid,uuid)',
    'identity.patient_merge_items(uuid[],uuid)',
    'identity.patient_merge_refusal(text,text,uuid,uuid,uuid)'];
  v_signature text;
  v_policy record;
  v_qual text;
  v_with_check text;
begin
  -- 0. The locks, NOWAIT.
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table identity.patients, identity.staff_facility_memberships in share row exclusive mode nowait;
  lock table identity.patient_search_refs in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0207: identity.patients or identity.staff_facility_memberships (the new table''s foreign keys), '
          || 'or identity.patient_search_refs (whose rules it reads), is busy, and this transaction already holds an '
          || 'earlier migration''s locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0207: identity.patients or identity.staff_facility_memberships (the new table''s foreign keys), '
          || 'or identity.patient_search_refs (whose rules it reads), stayed busy for 5 seconds; nothing applied; run '
          || 'the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- 0001-0153 applied: a marker of 0153 (the last file before this one), and of every earlier file whose objects
  -- the functions below read.
  if to_regclass('ehr.clinician_recent_diagnoses') is null
     or to_regclass('migration.schema_migrations') is null
     or to_regclass('identity.patients') is null or to_regclass('identity.patient_identifiers') is null
     or to_regclass('audit.events') is null
     or to_regclass('identity.patient_enrollments') is null
     or to_regclass('identity.public_patient_enrollments') is null
     or to_regclass('identity.outreach_health_id_claims') is null
     or to_regclass('identity.registration_cases') is null
     or to_regprocedure('identity.own_facility_basis(uuid,uuid)') is null
     or to_regclass('identity.patient_search_refs') is null
     or to_regclass('identity.unknown_patients') is null
     or to_regclass('ehr.unknown_patient_cancel_scans') is null then
    raise exception using errcode = '55000', message = '0207: 0001-0153 must be applied first';
  end if;

  -- Already applied (all of this file), a half state (any part of it), or ID-8b already there.
  select count(*) into v_present
    from unnest(array['identity.patient_merges'] || v_entry_points || v_helpers) with ordinality as wanted(name, position)
   where (wanted.position = 1 and to_regclass(wanted.name) is not null)
      or (wanted.position > 1 and to_regprocedure(wanted.name) is not null);
  if v_present = 12
     and (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname = 'identity' and proc.proname like '%patient\_merge%'
             and proc.proname not in ('approve_patient_merge', 'undo_patient_merge')) = 11 then
    raise exception using errcode = '55000', message = '0207: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'identity' and proc.proname like '%patient\_merge%'
                   and proc.proname not in ('approve_patient_merge', 'undo_patient_merge')) then
    raise exception using errcode = '55000',
      message = '0207: the schema is not in the reviewed state (part of 0207 is there); nothing applied';
  end if;
  if to_regclass('identity.patient_merge_moves') is not null
     or exists (select 1 from pg_attribute attribute
                 where attribute.attrelid = 'identity.patients'::regclass
                   and attribute.attname = 'merged_into_patient_id' and not attribute.attisdropped)
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'identity' and proc.proname in ('approve_patient_merge', 'undo_patient_merge')) then
    raise exception using errcode = '55000', message = '0207: an ID-8b object is already there; nothing applied';
  end if;

  -- The bodies the functions call or mirror, as 0001-0153 left them.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_mismatch
    from (values
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('identity.patient_record_kind(uuid)', '07ccb126d44545b992869cffbeac7d09'),
      ('identity.resolve_patient_search_ref(text,text)', '9a80a8997571565f0e99c96f1cba4697'),
      ('identity.staff_patient_search(text,text,text,date,text,text[],text,text)', 'cef86535b9e3fb4fb949833a66b5bd6d'),
      ('ehr.unknown_patient_cancel_scan_open()', '6d83ddb31d99b8b735ba8ff2699b034d'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)',
       '732d11892dd4e27e1ff9093ae3b7de5a')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0207: these bodies are not as 0001-0153 left them: ' || v_mismatch;
  end if;
  if to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_correlation_id()') is null
     or to_regprocedure('platform.current_purpose_of_use()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null then
    raise exception using errcode = '55000', message = '0207: a function this file calls is missing';
  end if;

  -- D4: the policies the counts read through, exactly: 0131's encounters_owner_read and 0145's seven
  -- <table>_cancel_check_read (permissive, for SELECT, to PUBLIC, the expression 0145 wrote, so the owner reads
  -- each table only while this backend's transaction holds the marker). Also the two owner reads D2 relies on:
  -- 0130's registration_cases_owner_read and 0120's outreach_health_id_claims_owner (to the owner, true). Each
  -- expression is read with pg_get_expr(expression, 0): naming no relation, it opens none (with polrelid it would
  -- take ACCESS SHARE on each clinical table to name its columns, and wait behind any ACCESS EXCLUSIVE there). None
  -- of these expressions names a column of its own table; one that does cannot be read so and counts as changed.
  v_mismatch := null;
  for v_policy in
    select expected.table_name, expected.policy_name, expected.roles, expected.expression,
           policy_row.oid is not null as present, policy_row.polpermissive, policy_row.polcmd,
           policy_row.polroles::text as polroles, relation.relowner, policy_row.polqual, policy_row.polwithcheck
      from (values
        ('ehr.encounters', 'encounters_owner_read', '{0}',
         'pg_has_role(( SELECT relowner FROM pg_class relation WHERE (oid = (''ehr.encounters''::regclass)::oid)), ''USAGE''::text)'),
        ('identity.registration_cases', 'registration_cases_owner_read', '{0}',
         'pg_has_role(( SELECT relowner FROM pg_class relation WHERE (oid = (''identity.registration_cases''::regclass)::oid)), ''USAGE''::text)'),
        ('identity.outreach_health_id_claims', 'outreach_health_id_claims_owner', 'owner', 'true'),
        ('ehr.clinical_notes', 'clinical_notes_cancel_check_read', '{0}', null),
        ('ehr.diagnoses', 'diagnoses_cancel_check_read', '{0}', null),
        ('ehr.documents', 'documents_cancel_check_read', '{0}', null),
        ('ehr.lab_requests', 'lab_requests_cancel_check_read', '{0}', null),
        ('ehr.prescriptions', 'prescriptions_cancel_check_read', '{0}', null),
        ('ehr.recorded_allergies', 'recorded_allergies_cancel_check_read', '{0}', null),
        ('ehr.vitals', 'vitals_cancel_check_read', '{0}', null)
      ) expected(table_name, policy_name, roles, expression)
      left join pg_policy policy_row on policy_row.polrelid = to_regclass(expected.table_name)
                                    and policy_row.polname = expected.policy_name
      left join pg_class relation on relation.oid = policy_row.polrelid
     order by expected.table_name
  loop
    begin
      v_qual := regexp_replace(pg_get_expr(v_policy.polqual, 0), '\s+', ' ', 'g');
      v_with_check := pg_get_expr(v_policy.polwithcheck, 0);
    exception when others then
      v_qual := null;
      v_with_check := null;
    end;
    if not coalesce(v_policy.present and v_policy.polpermissive
          and v_policy.polcmd = case when v_policy.roles = 'owner' then '*' else 'r' end
          and v_policy.polroles = case when v_policy.roles = 'owner' then '{' || v_policy.relowner::text || '}'
                                       else v_policy.roles end
          and v_qual = coalesce(v_policy.expression,
                format('( SELECT CASE WHEN pg_has_role(( SELECT relation.relowner FROM pg_class relation WHERE '
                  || '(relation.oid = (%L::regclass)::oid)), ''USAGE''::text) THEN ehr.unknown_patient_cancel_scan_open() '
                  || 'ELSE false END AS "case")', v_policy.table_name))
          and (case when v_policy.roles = 'owner' then v_with_check is not distinct from 'true'
                    else v_policy.polwithcheck is null end), false) then
      v_mismatch := concat_ws(', ', v_mismatch, v_policy.table_name || '.' || v_policy.policy_name);
    end if;
  end loop;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0207: these policies are not as 0001-0153 left them: ' || v_mismatch;
  end if;
  -- The eight clinical tables' row-level security is forced and they are one owner's (the owner the policies test),
  -- and the marker table is that owner's; no hid_ role but the owner is a member of it (0145 D11's premise, 0133's
  -- form: MEMBER, so a NOINHERIT membership counts too).
  if (select count(distinct relation.relowner) from pg_class relation
       where relation.oid in ('ehr.encounters'::regclass, 'ehr.clinical_notes'::regclass, 'ehr.diagnoses'::regclass,
                              'ehr.documents'::regclass, 'ehr.lab_requests'::regclass, 'ehr.prescriptions'::regclass,
                              'ehr.recorded_allergies'::regclass, 'ehr.vitals'::regclass,
                              'ehr.unknown_patient_cancel_scans'::regclass)) <> 1
     or exists (select 1 from pg_class relation
                 where relation.oid in ('ehr.encounters'::regclass, 'ehr.clinical_notes'::regclass,
                                        'ehr.diagnoses'::regclass, 'ehr.documents'::regclass,
                                        'ehr.lab_requests'::regclass, 'ehr.prescriptions'::regclass,
                                        'ehr.recorded_allergies'::regclass, 'ehr.vitals'::regclass)
                   and not (relation.relrowsecurity and relation.relforcerowsecurity))
     or exists (select 1 from pg_roles role_row
                 where role_row.rolname like 'hid\_%'
                   and role_row.oid <> (select relation.relowner from pg_class relation where relation.oid = 'ehr.vitals'::regclass)
                   and pg_has_role(role_row.oid, (select relation.relowner from pg_class relation
                                                   where relation.oid = 'ehr.vitals'::regclass), 'MEMBER')) then
    raise exception using errcode = '55000',
      message = '0207: the clinical tables are not as 0145 left them (one owner, row-level security forced, no hid_ '
        || 'role a member of the owner)';
  end if;

  -- 0132's table, by its columns, and its purpose and mode rules; the other columns the functions read, by type.
  select string_agg(expected.table_name || '.' || expected.column_name, ', ' order by expected.table_name, expected.column_name)
    into v_mismatch
    from (values
      ('identity.patient_search_refs', 'token_sha256', 'character(64)'),
      ('identity.patient_search_refs', 'patient_id', 'uuid'),
      ('identity.patient_search_refs', 'account_id', 'uuid'),
      ('identity.patient_search_refs', 'membership_id', 'uuid'),
      ('identity.patient_search_refs', 'facility_id', 'uuid'),
      ('identity.patient_search_refs', 'purpose_of_use', 'text'),
      ('identity.patient_search_refs', 'search_mode', 'text'),
      ('identity.patient_search_refs', 'created_at', 'timestamp with time zone'),
      ('identity.patient_search_refs', 'expires_at', 'timestamp with time zone'),
      ('identity.patients', 'id', 'uuid'), ('identity.patients', 'account_id', 'uuid'),
      ('identity.patients', 'status', 'text'), ('identity.patients', 'full_name', 'text'),
      ('identity.patients', 'gender', 'text'), ('identity.patients', 'dob', 'date'),
      ('identity.patients', 'hid_code', 'text'), ('identity.patients', 'source_system', 'text'),
      ('identity.patient_identifiers', 'patient_id', 'uuid'),
      ('identity.patient_identifiers', 'identifier_type', 'text'),
      ('identity.patient_identifiers', 'verified', 'boolean'),
      ('identity.patient_identifiers', 'revoked_at', 'timestamp with time zone'),
      ('identity.unknown_patients', 'patient_id', 'uuid'), ('identity.unknown_patients', 'facility_id', 'uuid'),
      ('identity.unknown_patients', 'status', 'text'),
      ('identity.registration_cases', 'facility_id', 'uuid'),
      ('identity.registration_cases', 'resolved_patient_id', 'uuid'),
      ('identity.registration_cases', 'identity_evidence', 'text'),
      ('identity.registration_cases', 'status', 'text'),
      ('identity.outreach_health_id_claims', 'patient_id', 'uuid'),
      ('identity.outreach_health_id_claims', 'claimed_at', 'timestamp with time zone'),
      ('identity.outreach_health_id_claims', 'invalidated_at', 'timestamp with time zone'),
      ('identity.outreach_health_id_claims', 'expires_at', 'timestamp with time zone'),
      ('identity.staff_facility_memberships', 'id', 'uuid'),
      ('identity.staff_facility_memberships', 'account_id', 'uuid'),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid'),
      ('identity.staff_facility_memberships', 'organization_id', 'uuid'),
      ('identity.staff_facility_memberships', 'active', 'boolean'),
      ('identity.staff_facility_memberships', 'migration_hold_reason', 'text'),
      ('ehr.unknown_patient_cancel_scans', 'backend_pid', 'integer'),
      ('ehr.unknown_patient_cancel_scans', 'transaction_started_at', 'timestamp with time zone'),
      ('ehr.encounters', 'id', 'uuid'), ('ehr.clinical_notes', 'encounter_id', 'uuid'),
      ('ehr.vitals', 'encounter_id', 'uuid'),
      ('ehr.encounters', 'patient_id', 'uuid'), ('ehr.clinical_notes', 'patient_id', 'uuid'),
      ('ehr.vitals', 'patient_id', 'uuid'), ('ehr.diagnoses', 'patient_id', 'uuid'),
      ('ehr.prescriptions', 'patient_id', 'uuid'), ('ehr.lab_requests', 'patient_id', 'uuid'),
      ('ehr.documents', 'patient_id', 'uuid'), ('ehr.recorded_allergies', 'patient_id', 'uuid')
    ) expected(table_name, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = to_regclass(expected.table_name)
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if v_mismatch is not null
     or (select count(*) from pg_attribute attribute
          where attribute.attrelid = 'identity.patient_search_refs'::regclass and attribute.attnum > 0
            and not attribute.attisdropped) <> 9 then
    raise exception using errcode = '55000', message = '0207: these columns are not as 0001-0153 left them: '
      || coalesce(v_mismatch, 'identity.patient_search_refs has other columns');
  end if;
  if (select string_agg(pg_get_constraintdef(constraint_row.oid), ' | ' order by constraint_row.conname)
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.patient_search_refs'::regclass
         and constraint_row.conname in ('patient_search_refs_mode_purpose_ck', 'patient_search_refs_purpose_of_use_check',
                                        'patient_search_refs_ten_minutes_ck'))
     is distinct from 'CHECK (((search_mode = ''emergency''::text) = (purpose_of_use = ''emergency''::text))) | '
       || 'CHECK ((purpose_of_use = ANY (ARRAY[''direct-care''::text, ''emergency''::text]))) | '
       || 'CHECK ((expires_at = (created_at + ''00:10:00''::interval)))' then
    raise exception using errcode = '55000',
      message = '0207: identity.patient_search_refs'' purpose, mode and 10-minute rules are not as 0132 left them';
  end if;
  -- D4 counts notes and vitals through the source's visits: each row's (encounter_id, patient_id, facility_id)
  -- references its visit's (id, patient_id, facility_id), validated, and encounter_id is not null, as 0004 left them
  -- (the catalog only: no table is opened).
  if (select count(distinct constraint_row.conrelid) from pg_constraint constraint_row
       where constraint_row.conrelid in ('ehr.clinical_notes'::regclass, 'ehr.vitals'::regclass)
         and constraint_row.contype = 'f' and constraint_row.convalidated
         and constraint_row.confrelid = 'ehr.encounters'::regclass
         and (select array_agg(attribute.attname::text order by key_column.position)
                from unnest(constraint_row.conkey) with ordinality as key_column(attnum, position)
                join pg_attribute attribute on attribute.attrelid = constraint_row.conrelid
                                           and attribute.attnum = key_column.attnum)
             = array['encounter_id', 'patient_id', 'facility_id']
         and (select array_agg(attribute.attname::text order by key_column.position)
                from unnest(constraint_row.confkey) with ordinality as key_column(attnum, position)
                join pg_attribute attribute on attribute.attrelid = constraint_row.confrelid
                                           and attribute.attnum = key_column.attnum)
             = array['id', 'patient_id', 'facility_id']) <> 2
     or exists (select 1 from pg_attribute attribute
                 where attribute.attrelid in ('ehr.clinical_notes'::regclass, 'ehr.vitals'::regclass)
                   and attribute.attname = 'encounter_id' and not attribute.attnotnull) then
    raise exception using errcode = '55000',
      message = '0207: ehr.clinical_notes'' or ehr.vitals'' reference to its visit is not as 0004 left it';
  end if;
  -- The membership key D1 references (0002), by its exact column set.
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'identity.staff_facility_memberships'::regclass
                    and constraint_row.contype in ('u', 'p')
                    and (select array_agg(attribute.attname::text order by key_column.position)
                           from unnest(constraint_row.conkey) with ordinality as key_column(attnum, position)
                           join pg_attribute attribute on attribute.attrelid = constraint_row.conrelid
                                                      and attribute.attnum = key_column.attnum)
                        = array['id', 'facility_id', 'account_id']) then
    raise exception using errcode = '55000',
      message = '0207: identity.staff_facility_memberships has no unique key on (id, facility_id, account_id)';
  end if;

  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  v_owner_oid := (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner);
  if v_owner_oid is distinct from (select relation.relowner from pg_class relation
                                    where relation.oid = 'ehr.unknown_patient_cancel_scans'::regclass) then
    raise exception using errcode = '55000',
      message = '0207: the marker table is not the owner''s of 0003''s consent functions; nothing applied';
  end if;

  -- 2. D1. The requests.
  create table identity.patient_merges (
    id uuid primary key,
    facility_id uuid not null,
    source_patient_id uuid not null references identity.patients(id) on delete restrict,
    target_patient_id uuid not null references identity.patients(id) on delete restrict,
    requested_by_account_id uuid not null,
    requested_by_membership_id uuid not null,
    reason text not null check (reason = btrim(reason) and length(reason) between 8 and 500),
    status text not null default 'requested'
      check (status in ('requested', 'merged', 'undone', 'refused', 'cancelled')),
    version bigint not null default 1 check (version > 0),
    request_idempotency_key text not null check (request_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    decided_by_account_id uuid,
    decided_by_membership_id uuid,
    decided_at timestamptz,
    decision_reason text check (decision_reason = btrim(decision_reason) and length(decision_reason) between 8 and 500),
    decision_idempotency_key text check (decision_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    decision_request_sha256 char(64) check (decision_request_sha256 ~ '^[0-9a-f]{64}$'),
    cancelled_at timestamptz,
    cancel_idempotency_key text check (cancel_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    cancel_request_sha256 char(64) check (cancel_request_sha256 ~ '^[0-9a-f]{64}$'),
    merged_at timestamptz,
    undo_until timestamptz,
    undone_at timestamptz,
    undone_by_account_id uuid,
    undone_by_membership_id uuid,
    undo_reason text check (undo_reason = btrim(undo_reason) and length(undo_reason) between 8 and 500),
    undo_idempotency_key text check (undo_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    undo_request_sha256 char(64) check (undo_request_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    constraint patient_merges_not_same_ck check (source_patient_id <> target_patient_id),
    constraint patient_merges_requested_by_fk foreign key (requested_by_membership_id, facility_id, requested_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint patient_merges_decided_by_fk foreign key (decided_by_membership_id, facility_id, decided_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint patient_merges_undone_by_fk foreign key (undone_by_membership_id, facility_id, undone_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint patient_merges_request_key_uq unique (requested_by_account_id, request_idempotency_key),
    constraint patient_merges_pairs_ck check (
      (decided_by_account_id is null) = (decided_at is null)
      and (decided_by_membership_id is null) = (decided_at is null)
      and (decision_idempotency_key is null) = (decision_request_sha256 is null)
      and (decision_idempotency_key is null) = (decided_at is null)
      and (cancel_idempotency_key is null) = (cancel_request_sha256 is null)
      and (cancel_idempotency_key is null) = (cancelled_at is null)
      and (undone_by_account_id is null) = (undone_at is null)
      and (undone_by_membership_id is null) = (undone_at is null)
      and (undo_reason is null) = (undone_at is null)
      and (undo_idempotency_key is null) = (undo_request_sha256 is null)
      and (undo_idempotency_key is null) = (undone_at is null)
      and (merged_at is null) = (undo_until is null)
      and (undo_until is null or undo_until = merged_at + interval '30 days')),
    -- Each status's shape, ID-8b's two included (approve records its approver in the decision columns).
    constraint patient_merges_status_shape_ck check (case status
      when 'requested' then decided_at is null and cancelled_at is null and merged_at is null and undone_at is null
      when 'refused' then decided_at is not null and decision_reason is not null and cancelled_at is null
        and merged_at is null and undone_at is null
      when 'cancelled' then cancelled_at is not null and decided_at is null and decision_reason is null
        and merged_at is null and undone_at is null
      when 'merged' then decided_at is not null and merged_at is not null and cancelled_at is null and undone_at is null
      when 'undone' then decided_at is not null and merged_at is not null and undone_at is not null
        and cancelled_at is null
      else false end)
  );
  create unique index patient_merges_one_open_per_source_ux on identity.patient_merges (source_patient_id)
    where status = 'requested';
  create unique index patient_merges_decision_key_ux on identity.patient_merges (decided_by_account_id, decision_idempotency_key)
    where decision_idempotency_key is not null;
  create unique index patient_merges_cancel_key_ux on identity.patient_merges (requested_by_account_id, cancel_idempotency_key)
    where cancel_idempotency_key is not null;
  create unique index patient_merges_undo_key_ux on identity.patient_merges (undone_by_account_id, undo_idempotency_key)
    where undo_idempotency_key is not null;
  create index patient_merges_facility_idx on identity.patient_merges (facility_id, created_at desc, id desc);
  create index patient_merges_requester_idx on identity.patient_merges
    (requested_by_account_id, facility_id, created_at desc, id desc);
  create index patient_merges_source_idx on identity.patient_merges (source_patient_id);
  create index patient_merges_target_idx on identity.patient_merges (target_patient_id);
  create index patient_merges_requested_by_membership_idx on identity.patient_merges (requested_by_membership_id);
  create index patient_merges_decided_by_membership_idx on identity.patient_merges (decided_by_membership_id)
    where decided_by_membership_id is not null;
  create index patient_merges_undone_by_membership_idx on identity.patient_merges (undone_by_membership_id)
    where undone_by_membership_id is not null;
  alter table identity.patient_merges enable row level security;
  revoke all on identity.patient_merges from public;
  comment on table identity.patient_merges is
    '0207 (ID-8a, owner Q127 A): one row per request to merge a record into another. ID-8a writes requested, refused and cancelled; merged and undone, and the columns merged_at, undo_until, undone_*, undo_reason and the undo key, are reserved for ID-8b (0208) and null until then. Only the patient-merge functions read and write it, as its owner; no runtime role has a privilege on it.';
  comment on column identity.patient_merges.merged_at is '0207: reserved for ID-8b (0208); null in 0207.';
  comment on column identity.patient_merges.undo_until is '0207: reserved for ID-8b (0208): merged_at + 30 days; null in 0207.';
  comment on column identity.patient_merges.undone_at is '0207: reserved for ID-8b (0208); null in 0207.';

  -- D5. Helpers (no role may execute them; the entry points run them as their owner).
  -- The caller: a staff session at its facility for healthcare operations, an active unheld membership there; which
  -- of the two codes it holds.
  create function identity.patient_merge_actor()
  returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
    actor_organization uuid, actor_correlation text, can_write boolean, can_approve boolean)
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
    select membership.organization_id into actor_organization
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null;
    if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
       or actor_organization is null
       or platform.current_purpose_of_use() is distinct from 'healthcare-operations' then
      raise exception using errcode = '42501', message = 'MERGE_DENIED';
    end if;
    can_write := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
      'identity.registration.write');
    can_approve := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
      'identity.registration.approve');
    return next;
  end
  $fn$;

  -- One audit row of these functions, as the caller: ids, the outcome and the counts only.
  create function identity.patient_merge_audit(actor record, audit_action text, audit_outcome text,
    audit_patient uuid, audit_merge uuid, audit_reason text, audit_details jsonb)
  returns void
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, reason, provenance, source_system, details
    ) values (
      actor.actor_correlation, 'staff', actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, audit_patient, audit_action, audit_outcome, 'patient-merge',
      audit_merge::text, 'healthcare-operations', audit_reason, 'application', 'identity-api',
      coalesce(audit_details, '{}'::jsonb));
  end
  $fn$;

  -- D2. The source rule.
  create function identity.patient_merge_source_state(requested_patient_id uuid, requested_facility_id uuid)
  returns text
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if requested_patient_id is null or requested_facility_id is null
       or not exists (select 1 from identity.patients patient
                       where patient.id = requested_patient_id and patient.status = 'active')
       or not (exists (select 1 from identity.unknown_patients unknown_record
                        where unknown_record.patient_id = requested_patient_id
                          and unknown_record.facility_id = requested_facility_id
                          and unknown_record.status in ('open', 'sent_for_review', 'identified'))
               or exists (select 1 from identity.registration_cases registration
                            join identity.patients patient on patient.id = registration.resolved_patient_id
                           where registration.facility_id = requested_facility_id
                             and registration.resolved_patient_id = requested_patient_id
                             and registration.identity_evidence = 'none'
                             and registration.status = 'approved_new_identity'
                             and patient.source_system = 'hid-desk-registration')) then
      return 'not_found';
    end if;
    if exists (select 1 from identity.patient_identifiers nin_identifier
                where nin_identifier.patient_id = requested_patient_id and nin_identifier.identifier_type = 'nin'
                  and nin_identifier.verified and nin_identifier.revoked_at is null)
       or exists (select 1 from identity.patients patient
                   where patient.id = requested_patient_id and patient.account_id is not null)
       or exists (select 1 from identity.outreach_health_id_claims claim
                   where claim.patient_id = requested_patient_id and claim.claimed_at is null
                     and claim.invalidated_at is null and claim.expires_at > now()) then
      return 'not_allowed';
    end if;
    return 'allowed';
  end
  $fn$;

  -- D3. The patient of the member's own standard (direct-care) search at this facility in the last 10 minutes, or
  -- null. The purpose is named here, not taken from the session (the request runs under healthcare-operations).
  create function identity.patient_merge_target(requested_match_ref text, actor_account uuid, actor_membership uuid,
    actor_facility uuid)
  returns uuid
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    found_patient uuid;
  begin
    if requested_match_ref is null or requested_match_ref !~ '^psr_[A-Za-z0-9_-]{43}$' then
      return null;
    end if;
    select ref.patient_id into found_patient
      from identity.patient_search_refs ref
     where ref.token_sha256 = encode(sha256(convert_to(requested_match_ref, 'UTF8')), 'hex')::char(64)
       and ref.account_id = actor_account
       and ref.membership_id = actor_membership
       and ref.facility_id = actor_facility
       and ref.purpose_of_use = 'direct-care'
       and ref.search_mode = 'standard'
       and ref.expires_at > clock_timestamp();
    return found_patient;
  end
  $fn$;

  -- D4 and D5. The answer for each request, in the given order: the request, the two cards, the source's moves
  -- counts (read as the owner, with the marker held only around the counts), and the target's id (for the audit
  -- rows; identity-api never answers it).
  create function identity.patient_merge_items(requested_ids uuid[], viewer_account uuid)
  returns table (ord bigint, merge_id uuid, item jsonb)
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    source_ids uuid[];
    source_id uuid;
    marked boolean;
    counts jsonb := '{}'::jsonb;
  begin
    select array_agg(distinct merge_row.source_patient_id) into source_ids
      from identity.patient_merges merge_row where merge_row.id = any (coalesce(requested_ids, array[]::uuid[]));
    if source_ids is not null then
      insert into ehr.unknown_patient_cancel_scans (backend_pid, transaction_started_at)
      values (pg_backend_pid(), transaction_timestamp()) on conflict do nothing
      returning true into marked;
      foreach source_id in array source_ids loop
        counts := counts || jsonb_build_object(source_id::text, jsonb_build_object(
          'visits', (select count(*) from ehr.encounters row_ where row_.patient_id = source_id),
          'notes', (select coalesce(sum(per_visit.total), 0)::bigint from ehr.encounters visit
                     cross join lateral (select count(*) as total from ehr.clinical_notes row_
                                          where row_.encounter_id = visit.id) per_visit
                    where visit.patient_id = source_id),
          'vitals', (select coalesce(sum(per_visit.total), 0)::bigint from ehr.encounters visit
                      cross join lateral (select count(*) as total from ehr.vitals row_
                                           where row_.encounter_id = visit.id) per_visit
                     where visit.patient_id = source_id),
          'diagnoses', (select count(*) from ehr.diagnoses row_ where row_.patient_id = source_id),
          'prescriptions', (select count(*) from ehr.prescriptions row_ where row_.patient_id = source_id),
          'labRequests', (select count(*) from ehr.lab_requests row_ where row_.patient_id = source_id),
          'documents', (select count(*) from ehr.documents row_ where row_.patient_id = source_id),
          'allergies', (select count(*) from ehr.recorded_allergies row_ where row_.patient_id = source_id)));
      end loop;
      if marked then
        delete from ehr.unknown_patient_cancel_scans scan
         where scan.backend_pid = pg_backend_pid() and scan.transaction_started_at = transaction_timestamp();
      end if;
    end if;
    return query
    select ordering.ord_position, merge_row.id, jsonb_build_object(
        'mergeId', merge_row.id, 'status', merge_row.status, 'version', merge_row.version,
        'requestedAt', merge_row.created_at, 'reason', merge_row.reason,
        'requestedByMe', merge_row.requested_by_account_id = viewer_account,
        'decidedAt', merge_row.decided_at, 'decisionReason', merge_row.decision_reason,
        'cancelledAt', merge_row.cancelled_at, 'mergedAt', merge_row.merged_at, 'undoUntil', merge_row.undo_until,
        'sourceStillAllowed', case when merge_row.status = 'requested'
          then identity.patient_merge_source_state(merge_row.source_patient_id, merge_row.facility_id) = 'allowed' end,
        'source', jsonb_build_object('patientId', source_patient.id, 'fullName', source_patient.full_name,
          'sex', source_patient.gender, 'dateOfBirth', source_patient.dob,
          'dateOfBirthEstimated', source_unknown.patient_id is not null and source_patient.dob is not null,
          'healthIdLast4', right(source_patient.hid_code, 4),
          'ninStatus', case when source_nin.verified then 'verified' else 'not_verified' end,
          'recordKind', case when source_unknown.patient_id is null then 'standard' else 'unknown' end),
        'target', jsonb_build_object('fullName', target_patient.full_name, 'sex', target_patient.gender,
          'dateOfBirth', target_patient.dob, 'healthIdLast4', right(target_patient.hid_code, 4),
          'ninStatus', case when target_nin.verified then 'verified' else 'not_verified' end,
          'recordKind', case when target_unknown.patient_id is null then 'standard' else 'unknown' end),
        'targetPatientId', merge_row.target_patient_id,
        'moves', coalesce(counts -> merge_row.source_patient_id::text, '{}'::jsonb))
      from unnest(requested_ids) with ordinality as ordering(id, ord_position)
      join identity.patient_merges merge_row on merge_row.id = ordering.id
      join identity.patients source_patient on source_patient.id = merge_row.source_patient_id
      join identity.patients target_patient on target_patient.id = merge_row.target_patient_id
      left join identity.unknown_patients source_unknown
        on source_unknown.patient_id = source_patient.id and source_unknown.status <> 'identified'
      left join identity.unknown_patients target_unknown
        on target_unknown.patient_id = target_patient.id and target_unknown.status <> 'identified'
      cross join lateral (select exists (select 1 from identity.patient_identifiers nin_identifier
                                          where nin_identifier.patient_id = source_patient.id
                                            and nin_identifier.identifier_type = 'nin'
                                            and nin_identifier.verified and nin_identifier.revoked_at is null)
                                 as verified) source_nin
      cross join lateral (select exists (select 1 from identity.patient_identifiers nin_identifier
                                          where nin_identifier.patient_id = target_patient.id
                                            and nin_identifier.identifier_type = 'nin'
                                            and nin_identifier.verified and nin_identifier.revoked_at is null)
                                 as verified) target_nin
     order by ordering.ord_position;
  end
  $fn$;

  -- A refusal: the code as the message; the ids for identity-api's audit row as the DETAIL when the caller may see
  -- the request (null otherwise).
  create function identity.patient_merge_refusal(refusal_state text, refusal_code text, refusal_merge uuid,
    refusal_source uuid, refusal_target uuid)
  returns void
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    raise exception using errcode = refusal_state, message = refusal_code,
      detail = coalesce(jsonb_strip_nulls(jsonb_build_object('mergeId', refusal_merge, 'sourcePatientId', refusal_source,
        'targetPatientId', refusal_target))::text, '{}');
  end
  $fn$;

  -- D5. Ask for a merge (identity.registration.write).
  create function identity.request_patient_merge(requested_source_patient_id uuid, requested_match_ref text,
    requested_reason text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (merge jsonb, replayed boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    reason_value text := btrim(coalesce(requested_reason, ''));
    existing identity.patient_merges%rowtype;
    source_state text;
    target_id uuid;
    open_id uuid;
    new_id uuid := gen_random_uuid();
    answer jsonb;
  begin
    select * into actor from identity.patient_merge_actor();
    if not actor.can_write then
      raise exception using errcode = '42501', message = 'MERGE_DENIED';
    end if;
    if requested_source_patient_id is null or length(reason_value) not between 8 and 500
       or coalesce(requested_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or coalesce(requested_request_sha256, '') !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'MERGE_INVALID';
    end if;

    -- The key, once per account: the same request answers again; another one is refused.
    perform pg_advisory_xact_lock(hashtextextended('patient-merge-request:' || actor.actor_account::text || ':'
      || requested_idempotency_key, 207));
    select merge_row.* into existing from identity.patient_merges merge_row
     where merge_row.requested_by_account_id = actor.actor_account
       and merge_row.request_idempotency_key = requested_idempotency_key;
    if found then
      if existing.request_sha256 <> requested_request_sha256 or existing.facility_id <> actor.actor_facility then
        raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
      end if;
      select item.item into answer from identity.patient_merge_items(array[existing.id], actor.actor_account) item;
      perform identity.patient_merge_audit(actor, 'identity.patient-merge.request', 'success',
        existing.source_patient_id, existing.id, existing.reason,
        jsonb_build_object('mergeId', existing.id, 'targetPatientId', existing.target_patient_id,
          'moves', answer -> 'moves', 'outcome', existing.status, 'replayed', true));
      return query select answer, true;
      return;
    end if;

    -- The source (D2), one request at a time per source.
    perform pg_advisory_xact_lock(hashtextextended('patient-merge-source:' || requested_source_patient_id::text, 207));
    source_state := identity.patient_merge_source_state(requested_source_patient_id, actor.actor_facility);
    if source_state = 'not_found' then
      perform identity.patient_merge_refusal('P0001', 'PATIENT_NOT_FOUND', null, null, null);
    elsif source_state <> 'allowed' then
      perform identity.patient_merge_refusal('P0001', 'MERGE_SOURCE_NOT_ALLOWED', null, requested_source_patient_id, null);
    end if;
    select merge_row.id into open_id from identity.patient_merges merge_row
     where merge_row.source_patient_id = requested_source_patient_id and merge_row.status = 'requested';
    if found then
      perform identity.patient_merge_refusal('P0001', 'MERGE_ALREADY_OPEN', open_id, requested_source_patient_id, null);
    end if;

    -- The target (D3).
    target_id := identity.patient_merge_target(requested_match_ref, actor.actor_account, actor.actor_membership,
      actor.actor_facility);
    if target_id is null then
      perform identity.patient_merge_refusal('42501', 'MERGE_SEARCH_FIRST', null, requested_source_patient_id, null);
    end if;
    if target_id = requested_source_patient_id then
      perform identity.patient_merge_refusal('P0001', 'MERGE_SAME_RECORD', null, requested_source_patient_id, null);
    end if;
    if not exists (select 1 from identity.patients patient where patient.id = target_id and patient.status = 'active')
       or identity.patient_record_kind(target_id) is distinct from 'standard'
       or identity.sealed_demo_patient(target_id) is distinct from identity.sealed_demo_patient(requested_source_patient_id)
       or identity.sealed_qa_patient(target_id) is distinct from identity.sealed_qa_patient(requested_source_patient_id)
       or identity.sealed_demo_facility(actor.actor_facility) is distinct from identity.sealed_demo_patient(target_id)
       or identity.sealed_qa_facility(actor.actor_facility) is distinct from identity.sealed_qa_patient(target_id) then
      perform identity.patient_merge_refusal('P0001', 'MERGE_TARGET_NOT_ALLOWED', null, requested_source_patient_id,
        target_id);
    end if;

    insert into identity.patient_merges (id, facility_id, source_patient_id, target_patient_id, requested_by_account_id,
      requested_by_membership_id, reason, request_idempotency_key, request_sha256)
    values (new_id, actor.actor_facility, requested_source_patient_id, target_id, actor.actor_account,
      actor.actor_membership, reason_value, requested_idempotency_key, requested_request_sha256);
    select item.item into answer from identity.patient_merge_items(array[new_id], actor.actor_account) item;
    perform identity.patient_merge_audit(actor, 'identity.patient-merge.request', 'success',
      requested_source_patient_id, new_id, reason_value,
      jsonb_build_object('mergeId', new_id, 'targetPatientId', target_id, 'moves', answer -> 'moves',
        'outcome', 'requested', 'replayed', false));
    return query select answer, false;
  end
  $fn$;

  -- D5. The list (view mine: identity.registration.write; view facility: identity.registration.approve), newest
  -- first, paged by (created_at, id). Writes no audit row (identity-api writes .list and .list.shown).
  create function identity.list_patient_merges(requested_view text, requested_status text, requested_limit integer,
    requested_after_created_at timestamptz, requested_after_id uuid)
  returns table (merge jsonb, has_more boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    found_ids uuid[];
    more boolean;
  begin
    select * into actor from identity.patient_merge_actor();
    if requested_view is null or requested_view not in ('mine', 'facility') then
      raise exception using errcode = '22023', message = 'MERGE_INVALID';
    end if;
    if (requested_view = 'mine' and not actor.can_write) or (requested_view = 'facility' and not actor.can_approve) then
      raise exception using errcode = '42501', message = 'MERGE_DENIED';
    end if;
    if (requested_status is not null
        and requested_status not in ('requested', 'merged', 'undone', 'refused', 'cancelled'))
       or requested_limit is null or requested_limit not between 1 and 100
       or (requested_after_created_at is null) <> (requested_after_id is null) then
      raise exception using errcode = '22023', message = 'MERGE_INVALID';
    end if;
    select array_agg(page.id order by page.created_at desc, page.id desc) into found_ids
      from (select merge_row.id, merge_row.created_at
              from identity.patient_merges merge_row
             where merge_row.facility_id = actor.actor_facility
               and (requested_view = 'facility' or merge_row.requested_by_account_id = actor.actor_account)
               and (requested_status is null or merge_row.status = requested_status)
               and (requested_after_created_at is null
                    or (merge_row.created_at, merge_row.id) < (requested_after_created_at, requested_after_id))
             order by merge_row.created_at desc, merge_row.id desc
             limit requested_limit + 1) page;
    found_ids := coalesce(found_ids, array[]::uuid[]);
    more := cardinality(found_ids) > requested_limit;
    if more then
      found_ids := found_ids[1:requested_limit];
    end if;
    return query select item.item, more from identity.patient_merge_items(found_ids, actor.actor_account) item
      order by item.ord;
  end
  $fn$;

  -- D5. One request: the asker (identity.registration.write) or an approver (identity.registration.approve) at this
  -- facility; anyone else MERGE_NOT_FOUND.
  create function identity.read_patient_merge(requested_merge_id uuid)
  returns table (merge jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    merge_row identity.patient_merges%rowtype;
    answer jsonb;
  begin
    select * into actor from identity.patient_merge_actor();
    if not (actor.can_write or actor.can_approve) then
      raise exception using errcode = '42501', message = 'MERGE_DENIED';
    end if;
    select found_row.* into merge_row from identity.patient_merges found_row
     where found_row.id = requested_merge_id and found_row.facility_id = actor.actor_facility
       and (actor.can_approve or found_row.requested_by_account_id = actor.actor_account);
    if not found then
      perform identity.patient_merge_refusal('P0001', 'MERGE_NOT_FOUND', null, null, null);
    end if;
    select item.item into answer from identity.patient_merge_items(array[merge_row.id], actor.actor_account) item;
    perform identity.patient_merge_audit(actor, 'identity.patient-merge.read', 'success', merge_row.source_patient_id,
      merge_row.id, null, jsonb_build_object('mergeId', merge_row.id, 'targetPatientId', merge_row.target_patient_id,
        'moves', answer -> 'moves', 'status', merge_row.status));
    return query select answer;
  end
  $fn$;

  -- D5. An approver refuses (identity.registration.approve); never the member who asked (Q127 A).
  create function identity.refuse_patient_merge(requested_merge_id uuid, requested_expected_version bigint,
    requested_reason text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (merge jsonb, replayed boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    reason_value text := btrim(coalesce(requested_reason, ''));
    merge_row identity.patient_merges%rowtype;
    answer jsonb;
  begin
    select * into actor from identity.patient_merge_actor();
    if not actor.can_approve then
      raise exception using errcode = '42501', message = 'MERGE_DENIED';
    end if;
    if requested_merge_id is null or requested_expected_version is null or requested_expected_version < 1
       or length(reason_value) not between 8 and 500
       or coalesce(requested_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or coalesce(requested_request_sha256, '') !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'MERGE_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('patient-merge-refuse:' || actor.actor_account::text || ':'
      || requested_idempotency_key, 207));
    select found_row.* into merge_row from identity.patient_merges found_row
     where found_row.id = requested_merge_id and found_row.facility_id = actor.actor_facility
     for update;
    if not found then
      perform identity.patient_merge_refusal('P0001', 'MERGE_NOT_FOUND', null, null, null);
    end if;
    if merge_row.decision_idempotency_key = requested_idempotency_key
       and merge_row.decided_by_account_id = actor.actor_account then
      if merge_row.decision_request_sha256 <> requested_request_sha256 or merge_row.status <> 'refused' then
        raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
      end if;
      select item.item into answer from identity.patient_merge_items(array[merge_row.id], actor.actor_account) item;
      perform identity.patient_merge_audit(actor, 'identity.patient-merge.refuse', 'success',
        merge_row.source_patient_id, merge_row.id, merge_row.decision_reason,
        jsonb_build_object('mergeId', merge_row.id, 'targetPatientId', merge_row.target_patient_id,
          'moves', answer -> 'moves', 'outcome', 'refused', 'replayed', true));
      return query select answer, true;
      return;
    end if;
    if exists (select 1 from identity.patient_merges other_row
                where other_row.decided_by_account_id = actor.actor_account
                  and other_row.decision_idempotency_key = requested_idempotency_key) then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if merge_row.requested_by_account_id = actor.actor_account then
      perform identity.patient_merge_refusal('42501', 'MERGE_SECOND_PERSON_REQUIRED', merge_row.id,
        merge_row.source_patient_id, merge_row.target_patient_id);
    end if;
    if merge_row.status <> 'requested' then
      perform identity.patient_merge_refusal('P0001', 'MERGE_ALREADY_DECIDED', merge_row.id,
        merge_row.source_patient_id, merge_row.target_patient_id);
    end if;
    if merge_row.version <> requested_expected_version then
      perform identity.patient_merge_refusal('40001', 'VERSION_CONFLICT', merge_row.id, merge_row.source_patient_id,
        merge_row.target_patient_id);
    end if;
    update identity.patient_merges merge_update
       set status = 'refused', decided_by_account_id = actor.actor_account,
           decided_by_membership_id = actor.actor_membership, decided_at = clock_timestamp(),
           decision_reason = reason_value, decision_idempotency_key = requested_idempotency_key,
           decision_request_sha256 = requested_request_sha256, version = merge_update.version + 1,
           updated_at = clock_timestamp()
     where merge_update.id = merge_row.id;
    select item.item into answer from identity.patient_merge_items(array[merge_row.id], actor.actor_account) item;
    perform identity.patient_merge_audit(actor, 'identity.patient-merge.refuse', 'success', merge_row.source_patient_id,
      merge_row.id, reason_value,
      jsonb_build_object('mergeId', merge_row.id, 'targetPatientId', merge_row.target_patient_id,
        'moves', answer -> 'moves', 'outcome', 'refused', 'previousStatus', merge_row.status, 'replayed', false));
    return query select answer, false;
  end
  $fn$;

  -- D5. The member who asked withdraws the request before a decision (identity.registration.write).
  create function identity.cancel_patient_merge(requested_merge_id uuid, requested_expected_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (merge jsonb, replayed boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    merge_row identity.patient_merges%rowtype;
    answer jsonb;
  begin
    select * into actor from identity.patient_merge_actor();
    if not actor.can_write then
      raise exception using errcode = '42501', message = 'MERGE_DENIED';
    end if;
    if requested_merge_id is null or requested_expected_version is null or requested_expected_version < 1
       or coalesce(requested_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or coalesce(requested_request_sha256, '') !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'MERGE_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('patient-merge-cancel:' || actor.actor_account::text || ':'
      || requested_idempotency_key, 207));
    select found_row.* into merge_row from identity.patient_merges found_row
     where found_row.id = requested_merge_id and found_row.facility_id = actor.actor_facility
       and (actor.can_approve or found_row.requested_by_account_id = actor.actor_account)
     for update;
    if not found then
      perform identity.patient_merge_refusal('P0001', 'MERGE_NOT_FOUND', null, null, null);
    end if;
    -- An approver who did not ask sees the request, but only the asker withdraws it.
    if merge_row.requested_by_account_id <> actor.actor_account then
      perform identity.patient_merge_refusal('42501', 'MERGE_DENIED', merge_row.id, merge_row.source_patient_id,
        merge_row.target_patient_id);
    end if;
    if merge_row.cancel_idempotency_key = requested_idempotency_key then
      if merge_row.cancel_request_sha256 <> requested_request_sha256 or merge_row.status <> 'cancelled' then
        raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
      end if;
      select item.item into answer from identity.patient_merge_items(array[merge_row.id], actor.actor_account) item;
      perform identity.patient_merge_audit(actor, 'identity.patient-merge.cancel', 'success',
        merge_row.source_patient_id, merge_row.id, null,
        jsonb_build_object('mergeId', merge_row.id, 'targetPatientId', merge_row.target_patient_id,
          'moves', answer -> 'moves', 'outcome', 'cancelled', 'replayed', true));
      return query select answer, true;
      return;
    end if;
    if exists (select 1 from identity.patient_merges other_row
                where other_row.requested_by_account_id = actor.actor_account
                  and other_row.cancel_idempotency_key = requested_idempotency_key) then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if merge_row.status <> 'requested' then
      perform identity.patient_merge_refusal('P0001', 'MERGE_ALREADY_DECIDED', merge_row.id,
        merge_row.source_patient_id, merge_row.target_patient_id);
    end if;
    if merge_row.version <> requested_expected_version then
      perform identity.patient_merge_refusal('40001', 'VERSION_CONFLICT', merge_row.id, merge_row.source_patient_id,
        merge_row.target_patient_id);
    end if;
    update identity.patient_merges merge_update
       set status = 'cancelled', cancelled_at = clock_timestamp(), cancel_idempotency_key = requested_idempotency_key,
           cancel_request_sha256 = requested_request_sha256, version = merge_update.version + 1,
           updated_at = clock_timestamp()
     where merge_update.id = merge_row.id;
    select item.item into answer from identity.patient_merge_items(array[merge_row.id], actor.actor_account) item;
    perform identity.patient_merge_audit(actor, 'identity.patient-merge.cancel', 'success', merge_row.source_patient_id,
      merge_row.id, null,
      jsonb_build_object('mergeId', merge_row.id, 'targetPatientId', merge_row.target_patient_id,
        'moves', answer -> 'moves', 'outcome', 'cancelled', 'replayed', false));
    return query select answer, false;
  end
  $fn$;

  comment on function identity.request_patient_merge(uuid, text, text, text, text) is
    '0207 (ID-8a, owner Q127 A): ask to merge this facility''s unknown or NIN Not Verified record that nobody signs in to into the record behind the member''s own direct-care search matchRef (identity.registration.write, healthcare operations). Nothing moves: ID-8b (0208) carries out the merge. Idempotent by the caller''s key.';
  comment on function identity.list_patient_merges(text, text, integer, timestamp with time zone, uuid) is
    '0207 (ID-8a): merge requests at this facility, newest first: mine (identity.registration.write) or facility (identity.registration.approve). Writes no audit row; identity-api writes .list and .list.shown.';
  comment on function identity.read_patient_merge(uuid) is
    '0207 (ID-8a): one merge request, for the member who asked or an approver at this facility.';
  comment on function identity.refuse_patient_merge(uuid, bigint, text, text, text) is
    '0207 (ID-8a): an approver (identity.registration.approve), never the member who asked, refuses an open request.';
  comment on function identity.cancel_patient_merge(uuid, bigint, text, text) is
    '0207 (ID-8a): the member who asked withdraws an open request.';
  comment on function identity.patient_merge_source_state(uuid, uuid) is
    '0207 (ID-8a): not_found (not active or not this facility''s own unknown or desk record), not_allowed (a verified NIN, a login or an open outreach claim) or allowed. ID-8b re-checks it under its locks.';

  -- The owner (the owner of 0003's consent functions, as 0145) and EXECUTE: the five entry points to the Identity
  -- runtime alone; the six helpers to nobody.
  if v_owner <> current_user then
    execute format('alter table identity.patient_merges owner to %I', v_owner);
    foreach v_signature in array v_entry_points || v_helpers loop
      execute format('alter function %s owner to %I', v_signature, v_owner);
    end loop;
  end if;
  foreach v_signature in array v_entry_points || v_helpers loop
    execute format('revoke all on function %s from public', v_signature);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    foreach v_signature in array v_entry_points loop
      execute format('grant execute on function %s to hid_identity_runtime', v_signature);
    end loop;
  end if;

  -- 3. Post-checks.
  -- The table: the owner's plain table, row-level security enabled and not forced, no policy, no privilege for
  -- another role.
  if (select count(*) from pg_class relation
       where relation.oid = 'identity.patient_merges'::regclass and relation.relkind = 'r'
         and relation.relrowsecurity and not relation.relforcerowsecurity and relation.relowner = v_owner_oid) <> 1
     or exists (select 1 from pg_policy policy_row where policy_row.polrelid = 'identity.patient_merges'::regclass)
     or exists (select 1 from pg_class relation,
                       lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 where relation.oid = 'identity.patient_merges'::regclass and acl.grantee <> relation.relowner) then
    raise exception using errcode = '55000',
      message = '0207: post-check failed (the table is not the owner''s, is granted to a role, or its row-level security is not enabled and unforced without a policy)';
  end if;
  -- Its foreign keys with their actions, its CHECKs, its unique keys and indexes.
  if (select string_agg(constraint_row.conname || ' ' || pg_get_constraintdef(constraint_row.oid), ' | '
                        order by constraint_row.conname collate "C")
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.patient_merges'::regclass and constraint_row.contype = 'f')
     is distinct from
       'patient_merges_decided_by_fk FOREIGN KEY (decided_by_membership_id, facility_id, decided_by_account_id) '
       || 'REFERENCES identity.staff_facility_memberships(id, facility_id, account_id) ON DELETE RESTRICT | '
       || 'patient_merges_requested_by_fk FOREIGN KEY (requested_by_membership_id, facility_id, requested_by_account_id) '
       || 'REFERENCES identity.staff_facility_memberships(id, facility_id, account_id) ON DELETE RESTRICT | '
       || 'patient_merges_source_patient_id_fkey FOREIGN KEY (source_patient_id) REFERENCES identity.patients(id) '
       || 'ON DELETE RESTRICT | '
       || 'patient_merges_target_patient_id_fkey FOREIGN KEY (target_patient_id) REFERENCES identity.patients(id) '
       || 'ON DELETE RESTRICT | '
       || 'patient_merges_undone_by_fk FOREIGN KEY (undone_by_membership_id, facility_id, undone_by_account_id) '
       || 'REFERENCES identity.staff_facility_memberships(id, facility_id, account_id) ON DELETE RESTRICT'
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.conrelid = 'identity.patient_merges'::regclass and constraint_row.contype = 'c'
            and constraint_row.convalidated) <> 16
     or not exists (select 1 from pg_constraint constraint_row
                     where constraint_row.conrelid = 'identity.patient_merges'::regclass
                       and constraint_row.conname = 'patient_merges_status_check'
                       and pg_get_constraintdef(constraint_row.oid)
                           = 'CHECK ((status = ANY (ARRAY[''requested''::text, ''merged''::text, ''undone''::text, '
                             || '''refused''::text, ''cancelled''::text])))')
     or not exists (select 1 from pg_constraint constraint_row
                     where constraint_row.conrelid = 'identity.patient_merges'::regclass
                       and constraint_row.conname = 'patient_merges_request_key_uq' and constraint_row.contype = 'u')
     or (select string_agg(index_class.relname || ' ' || pg_get_indexdef(index_row.indexrelid), ' | '
                           order by index_class.relname collate "C")
           from pg_index index_row join pg_class index_class on index_class.oid = index_row.indexrelid
          where index_row.indrelid = 'identity.patient_merges'::regclass and index_row.indisunique
            and index_row.indpred is not null)
        is distinct from
          'patient_merges_cancel_key_ux CREATE UNIQUE INDEX patient_merges_cancel_key_ux ON identity.patient_merges '
          || 'USING btree (requested_by_account_id, cancel_idempotency_key) WHERE (cancel_idempotency_key IS NOT NULL) | '
          || 'patient_merges_decision_key_ux CREATE UNIQUE INDEX patient_merges_decision_key_ux ON identity.patient_merges '
          || 'USING btree (decided_by_account_id, decision_idempotency_key) WHERE (decision_idempotency_key IS NOT NULL) | '
          || 'patient_merges_one_open_per_source_ux CREATE UNIQUE INDEX patient_merges_one_open_per_source_ux ON '
          || 'identity.patient_merges USING btree (source_patient_id) WHERE (status = ''requested''::text) | '
          || 'patient_merges_undo_key_ux CREATE UNIQUE INDEX patient_merges_undo_key_ux ON identity.patient_merges '
          || 'USING btree (undone_by_account_id, undo_idempotency_key) WHERE (undo_idempotency_key IS NOT NULL)'
     or exists (select 1 from pg_trigger trigger_row where trigger_row.tgrelid = 'identity.patient_merges'::regclass
                  and not trigger_row.tgisinternal) then
    raise exception using errcode = '55000', message = '0207: post-check failed (the table''s keys, CHECKs or indexes)';
  end if;
  -- The eleven functions: the owner's; SECURITY DEFINER exactly on the five entry points; the fixed search_path on
  -- all; each body as written here (md5).
  select string_agg(expected.signature, ', ' order by expected.signature) into v_mismatch
    from (values
      ('identity.request_patient_merge(uuid,text,text,text,text)', true, 'b20fc0d77b10ca6eb2f60b43d71508bd'),
      ('identity.list_patient_merges(text,text,integer,timestamp with time zone,uuid)', true, '13ba9cb553cc94fc0761aea5e5c0359c'),
      ('identity.read_patient_merge(uuid)', true, '980655a1e5f910641fb400a5f649a0c5'),
      ('identity.refuse_patient_merge(uuid,bigint,text,text,text)', true, 'ce82c8ba6dd572fd8526e494c7feac31'),
      ('identity.cancel_patient_merge(uuid,bigint,text,text)', true, 'b9ca2941bb000bb58684ce3007baa8fa'),
      ('identity.patient_merge_actor()', false, '5b234e69e6fbeac4991f22fc9bbf0c06'),
      ('identity.patient_merge_audit(record,text,text,uuid,uuid,text,jsonb)', false, '343f7cfd4f1434ccc27267d8070dc561'),
      ('identity.patient_merge_source_state(uuid,uuid)', false, '39d217f1c84272984b52426f64b50e50'),
      ('identity.patient_merge_target(text,uuid,uuid,uuid)', false, 'aab142474c8910b2f49e33b8077d9a0a'),
      ('identity.patient_merge_items(uuid[],uuid)', false, '7289f8ba68cbeff6429d6b386639491b'),
      ('identity.patient_merge_refusal(text,text,uuid,uuid,uuid)', false, '0c7f301a7ab6393c9a4a3da57d2a24a8')
    ) expected(signature, definer, body_md5)
   where not exists (select 1 from pg_proc proc
                      where proc.oid = to_regprocedure(expected.signature) and proc.proowner = v_owner_oid
                        and proc.prosecdef = expected.definer
                        and proc.proconfig = array['search_path=pg_catalog, pg_temp']
                        and md5(proc.prosrc) = expected.body_md5);
  if v_mismatch is not null
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'identity' and proc.proname like '%patient\_merge%') <> 11 then
    raise exception using errcode = '55000',
      message = '0207: post-check failed (a function''s owner, security, search_path or body): ' || coalesce(v_mismatch, 'count');
  end if;
  -- EXECUTE: hid_identity_runtime on each entry point (when the role exists), never with grant option; no other role
  -- (PUBLIC included) on any of the eleven.
  if exists (select 1 from pg_proc proc
               join pg_namespace namespace on namespace.oid = proc.pronamespace,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where namespace.nspname = 'identity' and proc.proname like '%patient\_merge%'
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime'
                     or acl.privilege_type <> 'EXECUTE' or acl.is_grantable or not proc.prosecdef))
     or (exists (select 1 from pg_roles role_row where role_row.rolname = 'hid_identity_runtime')
         and exists (select 1 from unnest(v_entry_points) entry(signature)
                      where not has_function_privilege('hid_identity_runtime', entry.signature, 'EXECUTE'))) then
    raise exception using errcode = '55000', message = '0207: post-check failed (the functions'' grants)';
  end if;

  raise notice '0207: merge requests installed (identity.patient_merges, five entry points for the Identity runtime); nothing moves until ID-8b.';
end
$id8a$;
