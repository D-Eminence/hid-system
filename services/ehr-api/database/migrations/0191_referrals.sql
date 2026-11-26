-- 0191 REF-1 Referrals between facilities: the record, the frozen package, the
-- control and the referring facility's steps (Release D, the department sprint
-- the owner approved on 25 November 2026; docs/EHR_PLANNED_CONTRACT.md REF-1).
-- Written on staging-novu-ci-20261005 at 0cfddcc9 (0001-0153 applied). The
-- number is provisional: numbers are given at merge, in release order, after
-- the department files cut before it. No migration number appears inside a
-- function body, so renumbering leaves every md5. It reads nothing 0152-0190
-- create, and it keeps any control key, access code or role row another lane
-- added first. The declaration in config/production-schema-compatibility.json
-- stays unsigned until the owner signs this file. 0192 (the receiving facility,
-- arrival, completion and the patient's view) and 0193 (who gets the codes) are
-- their own files.
--
-- Owner decisions it is built on (25 November 2026, each at the recommended
-- option): Q261 A (the receiver reads only the frozen package the clinician
-- selected; no chart grant and no change to any clinical table's row-level
-- security), Q262 A (the clinician attests the patient's agreement with a
-- versioned text), Q263 A (a facility on Health ID listed for referrals, or a
-- printed letter recorded as "Printed, outside Health ID"), Q264 A (no approval
-- step), Q265 A (its own control, seeded off), Q266 A (routine and urgent only).
-- Smaller choices at their recommended option, not yet answered by the owner:
-- Q-REF-7 A (a referral to a Health ID facility needs the patient's active app
-- account), Q-REF-10 A (respond by 168 or 24 hours), Q-REF-11 A (one of the 15
-- facility department codes plus free text), Q-REF-15 A (the control stops
-- referrals to Health ID facilities, never printed letters).
--
-- What it changes (nothing else):
-- R1 ehr.referral_attestation_texts   the agreement texts, append-only, seeded
--                                     with v1 of each kind (drafts for the DPO).
-- R2 ehr.referrals                    one row per referral: who, where, the
--                                     content and agreement frozen at sending,
--                                     and each step's columns, set once. The
--                                     guard trigger ehr.referral_guard (BEFORE
--                                     UPDATE) keeps the frozen columns, moves
--                                     the state only along the contract's
--                                     table and raises row_version by one;
--                                     DELETE and TRUNCATE are refused.
-- R3 ehr.referral_events              one row per step, with the
--                                     Idempotency-Key and the request's
--                                     SHA-256 (unique per membership and key).
--                                     Append-only.
-- R4 ehr.referral_package_items       the frozen package: server-built JSON
--                                     objects of at most 4 KB. Append-only; a
--                                     BEFORE INSERT trigger refuses an item
--                                     whose position is outside the referral's
--                                     package_item_count, and (referral,
--                                     position) is unique, so nothing is added
--                                     after sending.
-- R5 ehr.referral_source_marks        one row when a package item's source is
--                                     marked entered in error after sending,
--                                     written by AFTER triggers on
--                                     ehr.diagnoses (verification_status),
--                                     ehr.vitals (status),
--                                     ehr.recorded_allergies (status) and
--                                     lab.result_invalidations (insert), only
--                                     for a source some package holds. The
--                                     receiving facility never reads those
--                                     tables (their row-level security is not
--                                     changed); the mark is how the frozen
--                                     copy says "entered in error since sent"
--                                     with no content. Append-only.
-- R6 identity.referral_destination_settings  support's listing lever, as
--                                     0086's T7: the newest row decides; with
--                                     none, 0086 H3's default (a governed
--                                     facility is listed, a self-signed-up one
--                                     only when support's review recorded a
--                                     real check). Append-only.
-- R7 platform.control_settings        the control cross_facility_referrals_enabled,
--                                     seeded OFF. The key CHECK and
--                                     platform.control_enabled keep every key
--                                     they hold now (0115's eleven and any key
--                                     another lane added, in its place) and
--                                     gain this one, in 0086's and APPT-1's
--                                     form. FORCE row-level security is lifted
--                                     only while this file reads the rows and
--                                     writes its own, and only if it was on.
-- R8 functions (SECURITY DEFINER, SET search_path = pg_catalog, pg_temp,
--    every name schema-qualified, no temporary table), owned like 0135's
--    (the owner of identity.has_active_consent_grant):
--    EXECUTE hid_ehr_runtime: ehr.referral_attestation_text, ehr.referral_send,
--      ehr.referral_sent_list, ehr.referral_withdraw, ehr.referral_letter;
--    EXECUTE hid_identity_runtime: identity.search_referral_destinations,
--      identity.admin_find_referrals, identity.admin_referral_destination,
--      identity.admin_set_referral_destination;
--    helpers no role may execute: ehr.referral_limits, ehr.referral_instant,
--      ehr.referral_caller, ehr.referral_control_on, ehr.referral_effective,
--      ehr.referral_cards, ehr.referral_package, ehr.referral_history,
--      ehr.referral_freeze_package, ehr.referral_audit,
--      ehr.referral_idempotency, ehr.referral_notify_patient, the trigger
--      functions, identity.referral_destination_listed,
--      identity.referral_destination_eligible and
--      lab.referral_result_snapshots (owned by the owner of lab.results, which
--      must be the functions' owner: the precondition refuses otherwise).
--    Each staff function checks the caller: an active membership not held by
--    the cutover at the session facility, the referral code, the purpose
--    (direct care) and the facility's seal (a sealed demo or QA facility
--    refers only its own sealed patients, only to a facility of the same seal;
--    a real facility never finds a sealed one). Without 0193 no role holds a
--    referral code, so every staff function refuses; with the control off
--    nothing crosses to another facility.
-- Audit (in the request's transaction, refusals that answer included):
-- ehr.referral.send, .withdraw, .letter-print, .sent-list (+ .shown per
-- patient), and support's admin.referral-destination.set (the platform row of
-- the command) with identity.referral-destination.set at the facility. Rows
-- hold ids, codes, counts and the outcome; never a name, date of birth, Health
-- ID, reason, letter, note, package content or typed facility name. This file
-- itself writes no audit row.
--
-- Locks (measured with pg_locks and compared by the migrations suite), taken
-- first, NOWAIT: ACCESS EXCLUSIVE on platform.control_settings (the CHECK swap
-- and the seed row); SHARE ROW EXCLUSIVE on identity.patients,
-- identity.facilities, identity.staff_facility_memberships, ehr.encounters and
-- ehr.visit_queue (the foreign keys of the new, empty tables) and on
-- ehr.diagnoses, ehr.vitals, ehr.recorded_allergies and
-- lab.result_invalidations (CREATE TRIGGER for R5; writers wait for the
-- milliseconds the file holds them, readers go on); ACCESS SHARE on
-- auth.permissions and auth.role_permissions (read by the preconditions). A
-- busy table fails the attempt at once, and its subtransaction gives back what
-- it took. The attempt is made 50 times, 100 ms apart (about 5 seconds), so the
-- file never waits for one of its locks while holding the others; then 55P03
-- (nothing applied). When this transaction already holds an earlier
-- migration's locks that stop other sessions' reads or writes (the runner's dry
-- run applies every pending file in one transaction), one attempt and no sleep.
-- Both refusals begin "0191: " and end "run the release again at a quieter
-- time", so the runner's dry run rolls back and tries again (#306). Function
-- bodies are PL/pgSQL (not checked against tables at creation) except two SQL
-- helpers that read no table, so creating them locks nothing else.
--
-- Old images on this schema: nothing calls the new functions.
-- platform.control_enabled answers exactly as before for every existing key.
-- Today's identity-api refuses kind=referral (400) and its control command does
-- not know the new key, which is seeded off anyway. The marks triggers only
-- write when a package holds the source, and no package exists until the new
-- image sends a referral.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- marks triggers, the functions and the six tables, delete the control row and
-- put back the CHECK and body found (without the new key).
--
-- The whole file is one statement (do $ref0191$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): markers of 0021, 0037, 0086,
--    0114, 0115, 0117, 0131, 0135, 0142 and 0145; "0191: already applied" when
--    every object of this file is there as made (bodies by md5, the control
--    key in the CHECK, the body and the row); "0191: the schema is not in the
--    reviewed state" for any half state; the bodies this file calls md5-pinned;
--    the control CHECK is 0115's eleven keys plus any others in APPT-1's form,
--    and platform.control_enabled is 0115's body over exactly those keys; the
--    columns this file reads; the functions' owner may read ehr.encounters
--    under its forced row-level security and owns lab.results.
-- 2. R1-R8.
-- 3. Post-checks in 0148's and 0152's form: owners; grants (no grantee but the
--    owner and the named runtime); row-level security enabled and forced with
--    four owner-only policies; each function's SECURITY DEFINER, volatility,
--    owner, exact search_path and body md5; every trigger by tgtype, tgqual,
--    tgattr, tgnargs, tgfoid and tgenabled; every CHECK of the new tables by
--    its definition; the control CHECK, body and row; no other control row
--    changed.

do $ref0191$
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
  v_runtime_ehr constant text := 'hid_ehr_runtime';
  v_runtime_identity constant text := 'hid_identity_runtime';
  v_key constant text := 'cross_facility_referrals_enabled';
  v_base_keys constant text[] := array['patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
    'maintenance_mode', 'uploads_enabled', 'break_glass_enabled', 'provider_self_service_enabled',
    'staff_invitations_enabled', 'cross_facility_orders_enabled', 'cross_facility_route_access_enabled',
    'outreach_organiser_signup_enabled'];
  v_keys text[];
  v_check_found text;
  v_check_expected text;
  v_control_signature constant text := 'platform.control_enabled(text)';
  -- platform.control_enabled(text) as 0115 left it, and the line of its key list this file extends.
  v_control_md5 constant text := '1d24fbded6edff32d934d319b0135fb2';
  v_control_old constant text := E'    ''outreach_organiser_signup_enabled''\n  ) then';
  v_control_form text;
  v_control_form_new text;
  v_control_source text;
  v_control_row_before text;
  v_control_rows_before text;
  v_was_forced boolean;
  v_already boolean;
  -- The functions this file makes and the md5 of each body as made (generated from this file).
  -- BODIES-BEGIN
  v_bodies constant jsonb := '{"ehr.referral_attestation_text": "8c729b025e53899882a39e152a011a12",
    "ehr.referral_audit": "49c67c352d47f25e4d1eafd9eacf8ff0",
    "ehr.referral_caller": "bde5f7917e5635c19c959716ff1d78d9",
    "ehr.referral_cards": "9f146a29959ee4767e45bba851a8503f",
    "ehr.referral_control_on": "9979322a339a3db6fcaab20d556d920a",
    "ehr.referral_effective": "8d0d308babe05c47567717c3901dc160",
    "ehr.referral_freeze_package": "d5050b43e37090b437f8758d01ac4988",
    "ehr.referral_guard": "2ff32368f55b3f577d27bdc91ee6cfd6",
    "ehr.referral_history": "e873b2b58ab9b37f7417c723710d6d56",
    "ehr.referral_idempotency": "dc5b0879bbeb99e44ec2301ba1e155f7",
    "ehr.referral_instant": "3ddbc573e17bb72b781a9694ace81f33",
    "ehr.referral_letter": "f6d0726f109b3f4afb26ba2767151ac9",
    "ehr.referral_limits": "18d8c67c87860bc9caadc5dd4e4906b5",
    "ehr.referral_notify_patient": "e2a6f5fb86068e5c5e668b625674e0bc",
    "ehr.referral_package": "dac2c791da631baf07aaf0a5e7b735a0",
    "ehr.referral_package_item_guard": "84c791b6a9bb45237c5d7c9fbcb6ae32",
    "ehr.referral_send": "12f6bb8904f75905477af746439a5a9a",
    "ehr.referral_sent_list": "c79501e2919597c5f2be22ea941e472c",
    "ehr.referral_source_marked": "dd354809797b2ae4b8e5e14000e4afb7",
    "ehr.referral_withdraw": "8b90d38550beff26967d4a63dca66253",
    "identity.admin_find_referrals": "80f23b22ff5ea298d43c5f3c570ff106",
    "identity.admin_referral_destination": "c12d21c582cfb033df47632634ca094f",
    "identity.admin_set_referral_destination": "b6e267e044408661cfe8c7905d2b3d5f",
    "identity.referral_destination_eligible": "0bf28d20a540d8fd0b0581c1e4db1816",
    "identity.referral_destination_listed": "a5e606329a4af130fde053442e8bba96",
    "identity.search_referral_destinations": "87e177a4801c6ba4d5622a343e3b3338",
    "lab.referral_result_snapshots": "0a2af4b4601c93bc6f0c2b23a97c03c4"}';
  -- BODIES-END
  -- The CHECK constraints of the new tables as made: md5 of "table.name:definition" joined by "|" in name order.
  v_checks_md5 constant text := '3b16de89ac8faf4e9ca2465a0ef41f10';
  v_definer constant text[] := array['ehr.referral_attestation_text', 'ehr.referral_send', 'ehr.referral_sent_list',
    'ehr.referral_withdraw', 'ehr.referral_letter', 'identity.search_referral_destinations',
    'identity.admin_find_referrals', 'identity.admin_referral_destination', 'identity.admin_set_referral_destination',
    'ehr.referral_source_marked'];
  v_ehr_routes constant text[] := array['ehr.referral_attestation_text', 'ehr.referral_send', 'ehr.referral_sent_list',
    'ehr.referral_withdraw', 'ehr.referral_letter'];
  v_identity_routes constant text[] := array['identity.search_referral_destinations', 'identity.admin_find_referrals',
    'identity.admin_referral_destination', 'identity.admin_set_referral_destination'];
  v_tables constant text[] := array['ehr.referral_attestation_texts', 'ehr.referrals', 'ehr.referral_events',
    'ehr.referral_package_items', 'ehr.referral_source_marks', 'identity.referral_destination_settings'];
  v_triggers constant text[] := array['referral_attestation_texts_append_only', 'referral_attestation_texts_no_truncate',
    'referrals_guard', 'referrals_no_delete', 'referrals_no_truncate', 'referral_events_append_only',
    'referral_events_no_truncate', 'referral_package_items_append_only', 'referral_package_items_no_truncate',
    'referral_package_items_closed', 'referral_source_marks_append_only', 'referral_source_marks_no_truncate',
    'referral_destination_settings_append_only', 'referral_destination_settings_no_truncate',
    'referral_marks_diagnosis', 'referral_marks_vital', 'referral_marks_allergy', 'referral_marks_lab_result'];
  v_name text;
begin
  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table platform.control_settings in access exclusive mode nowait;
  lock table identity.patients, identity.facilities, identity.staff_facility_memberships, ehr.encounters,
    ehr.visit_queue, ehr.diagnoses, ehr.vitals, ehr.recorded_allergies, lab.result_invalidations
    in share row exclusive mode nowait;
  lock table auth.permissions, auth.role_permissions in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0191: platform.control_settings or a table 0191 references or reads (patients, facilities, staff '
          || 'memberships, visits, the waiting list, diagnoses, vital signs, recorded allergies, lab result '
          || 'invalidations, permissions and role permissions) is busy, and this transaction already holds an earlier '
          || 'migration''s locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0191: platform.control_settings or a table 0191 references or reads (patients, facilities, staff '
          || 'memberships, visits, the waiting list, diagnoses, vital signs, recorded allergies, lab result '
          || 'invalidations, permissions and role permissions) stayed busy for 5 seconds; nothing applied; run the '
          || 'release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- platform.control_settings' policies admit only platform administrators, so while this transaction holds the
  -- table, FORCE row-level security is lifted (only if it is on) for the reads and the seed row below, and put back
  -- before the post-checks end. Whatever raises before then rolls the lift back with everything else.
  select relation.relforcerowsecurity into v_was_forced
    from pg_class relation where relation.oid = 'platform.control_settings'::regclass;
  if v_was_forced then
    execute 'alter table platform.control_settings no force row level security';
  end if;

  -- 1. Preconditions.
  -- A marker of each earlier file whose objects this file uses.
  if to_regclass('lab.result_releases') is null                                              -- 0021
     or to_regprocedure('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)') is null  -- 0037
     or to_regclass('ehr.order_routes') is null or to_regclass('lab.order_route_result_reports') is null  -- 0086
     or to_regprocedure('identity.facility_department_codes()') is null                      -- 0114
     or to_regprocedure('platform.control_enabled(text)') is null                            -- 0115
     or to_regclass('ehr.recorded_allergies') is null                                        -- 0117
     or to_regprocedure('identity.own_facility_basis(uuid,uuid)') is null                    -- 0131
     or to_regclass('ehr.visit_queue') is null                                               -- 0135
     or to_regprocedure('identity.sealed_qa_facility(uuid)') is null                         -- 0123
     or not exists (select 1 from pg_attribute attribute_row
                     where attribute_row.attrelid = 'ehr.vitals'::regclass and attribute_row.attname = 'status'
                       and not attribute_row.attisdropped)                                    -- 0142
     or to_regclass('identity.unknown_patients') is null then                                -- 0145
    raise exception using errcode = '55000',
      message = '0191: 0021, 0037, 0086, 0114, 0115, 0117, 0123, 0131, 0135, 0142 and 0145 must be applied first';
  end if;

  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);

  -- Already applied: every object as made. Any part of it otherwise: not the reviewed state.
  select pg_get_constraintdef(constraint_row.oid) into v_check_found from pg_constraint constraint_row
   where constraint_row.conrelid = 'platform.control_settings'::regclass
     and constraint_row.conname = 'control_settings_control_key_check';
  select count(*) into v_present
    from (select unnest(v_tables) as name) wanted where to_regclass(wanted.name) is not null;
  v_already := v_present = cardinality(v_tables)
    and (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where v_bodies ? (namespace.nspname || '.' || proc.proname)
            and md5(proc.prosrc) = v_bodies ->> (namespace.nspname || '.' || proc.proname))
        = (select count(*) from jsonb_object_keys(v_bodies))
    and coalesce(v_check_found like '%''' || v_key || '''::text%', false)
    and exists (select 1 from platform.control_settings where control_key = v_key)
    and (select count(*) from pg_trigger trigger_row
          where not trigger_row.tgisinternal and trigger_row.tgname = any (v_triggers)) = cardinality(v_triggers);
  if v_already then
    raise exception using errcode = '55000', message = '0191: already applied';
  end if;
  if v_present <> 0
     or coalesce(v_check_found like '%' || v_key || '%', false)
     or exists (select 1 from platform.control_settings where control_key = v_key)
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where v_bodies ? (namespace.nspname || '.' || proc.proname))
     or exists (select 1 from pg_trigger trigger_row where not trigger_row.tgisinternal
                 and trigger_row.tgname = any (v_triggers)) then
    raise exception using errcode = '55000',
      message = '0191: the schema is not in the reviewed state (part of 0191 is there); nothing applied';
  end if;

  -- The bodies this file calls, as 0001-0153 left them.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_mismatch
    from (values
      ('ehr.order_route_staff_actor(boolean)', 'b1873dca92164652cc1977a90acb6184'),
      ('identity.patient_denies_order_route(uuid,uuid)', 'ab0dae381c56b599c318b065bf77de47'),
      ('identity.order_route_registered_address(uuid)', '80a2c9e306c72dff55aa2c91af9b93d2'),
      ('identity.lock_self_service_application(uuid)', '4eeb309085494a7652c19e7d6365e131'),
      ('identity.self_service_on_probation(uuid)', 'aadd6c3062207fbceb0667401bde8b89'),
      ('identity.organization_self_service_state(uuid)', 'c67aa5224b2aa3d95e4415e26787d470'),
      ('identity.order_route_platform_actor(text[])', '599cccfdba5e9b4c46cde4dd2814a541'),
      ('ehr.order_route_health_id(text)', 'f336e87adb3ac67fd83ac1de7b3efa7d'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('platform.require_control_enabled(text)', '90887489d15eab24f8f71b145bb02320'),
      ('identity.facility_department_codes()', '6e7fe57805c6fc44fc2296caa6b061ae'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0191: these bodies are not as 0001-0153 left them: ' || v_mismatch;
  end if;

  -- The control: 0115's eleven keys first, then any another lane added (each once, never this one), in the
  -- CHECK's own form; and platform.control_enabled is 0115's body over exactly those keys (APPT-1's form).
  select array_agg(found.key_match[1] order by found.ord) into v_keys
    from regexp_matches(coalesce(v_check_found, ''), '''([a-z][a-z0-9_]*)''::text', 'g') with ordinality found(key_match, ord);
  v_check_expected := 'CHECK ((control_key = ANY (ARRAY['
    || (select string_agg(format('%L::text', listed.key), ', ' order by listed.ord)
          from unnest(v_keys) with ordinality listed(key, ord)) || '])))';
  if v_keys is null or cardinality(v_keys) < 11 or v_keys[1:11] is distinct from v_base_keys
     or (select count(distinct listed.key) from unnest(v_keys) listed(key)) <> cardinality(v_keys)
     or v_check_found is distinct from v_check_expected then
    raise exception using errcode = '55000',
      message = '0191: the control key CHECK is not 0115''s eleven keys plus others in its form; nothing applied';
  end if;
  v_control_form := E'    ''outreach_organiser_signup_enabled'''
    || coalesce((select string_agg(format(',%L', listed.key), '' order by listed.ord)
                   from unnest(v_keys[12:]) with ordinality listed(key, ord)), '') || E'\n  ) then';
  v_control_form_new := E'    ''outreach_organiser_signup_enabled'''
    || coalesce((select string_agg(format(',%L', listed.key), '' order by listed.ord)
                   from unnest(v_keys[12:]) with ordinality listed(key, ord)), '') || format(',%L', v_key) || E'\n  ) then';
  select proc.prosrc into v_control_source from pg_proc proc where proc.oid = v_control_signature::regprocedure;
  if (length(v_control_source) - length(replace(v_control_source, v_control_form, ''))) <> length(v_control_form)
     or md5(replace(v_control_source, v_control_form, v_control_old)) is distinct from v_control_md5 then
    raise exception using errcode = '55000',
      message = '0191: platform.control_enabled is not 0115''s body over the keys of the CHECK; nothing applied';
  end if;
  if (select string_agg(setting.control_key, ',' order by setting.control_key collate "C")
        from platform.control_settings setting)
     is distinct from (select string_agg(listed.key, ',' order by listed.key collate "C") from unnest(v_keys) listed(key)) then
    raise exception using errcode = '55000',
      message = '0191: platform.control_settings does not hold exactly one row per key of its CHECK; nothing applied';
  end if;
  select string_agg(row(proc.oid, proc.proowner, proc.proacl, proc.prosecdef, proc.proconfig, proc.provolatile,
                        proc.proargtypes, proc.prorettype)::text, ';')
    into v_control_row_before from pg_proc proc where proc.oid = v_control_signature::regprocedure;
  select string_agg(to_jsonb(setting)::text, ',' order by setting.control_key collate "C")
    into v_control_rows_before from platform.control_settings setting;

  if not exists (select 1 from auth.permissions permission_row
                  where permission_row.code = 'ehr.encounter.write' and permission_row.active)
     or not exists (select 1 from auth.permissions permission_row
                     where permission_row.code = 'ehr.encounter.read' and permission_row.active) then
    raise exception using errcode = '55000', message = '0191: 0135''s pair ehr.encounter.read and ehr.encounter.write is missing';
  end if;

  -- The columns this file reads, by name and type.
  select string_agg(wanted.relation || '.' || wanted.column_name, ', ' order by wanted.relation, wanted.column_name)
    into v_mismatch
    from (values
      ('identity.patients', 'id', 'uuid'), ('identity.patients', 'account_id', 'uuid'),
      ('identity.patients', 'hid_code', 'text'), ('identity.patients', 'full_name', 'text'),
      ('identity.patients', 'gender', 'text'), ('identity.patients', 'dob', 'date'),
      ('identity.patients', 'status', 'text'),
      ('identity.facilities', 'organization_id', 'uuid'), ('identity.facilities', 'name', 'text'),
      ('identity.facilities', 'active', 'boolean'), ('identity.facilities', 'lifecycle_status', 'text'),
      ('identity.facility_profiles', 'facility_id', 'uuid'), ('identity.facility_profiles', 'departments', 'text[]'),
      ('identity.facility_profiles', 'address_line', 'text'), ('identity.facility_profiles', 'city', 'text'),
      ('identity.facility_profiles', 'created_at', 'timestamp with time zone'),
      ('identity.organization_products', 'facility_id', 'uuid'), ('identity.organization_products', 'status', 'text'),
      ('identity.organization_products', 'source_application_id', 'uuid'),
      ('identity.organization_applications', 'organization_type', 'text'),
      ('identity.staff_facility_memberships', 'migration_hold_reason', 'text'),
      ('identity.staff_facility_memberships', 'staff_id', 'uuid'),
      ('identity.staff', 'full_name', 'text'), ('identity.staff_licence_attestations', 'licence_number', 'text'),
      ('identity.staff_licence_attestations', 'role_grant_id', 'uuid'),
      ('identity.unknown_patients', 'status', 'text'),
      ('ehr.encounters', 'status', 'text'), ('ehr.encounters', 'imported_paper_records', 'boolean'),
      ('ehr.clinical_notes', 'encounter_id', 'uuid'), ('ehr.clinical_notes', 'status', 'text'),
      ('ehr.diagnoses', 'clinical_status', 'text'), ('ehr.diagnoses', 'verification_status', 'text'),
      ('ehr.diagnoses', 'encounter_id', 'uuid'), ('ehr.diagnoses', 'row_version', 'bigint'),
      ('ehr.prescriptions', 'status', 'text'), ('ehr.prescriptions', 'ends_on', 'date'),
      ('ehr.prescriptions', 'dose_quantity', 'numeric(12,4)'), ('ehr.prescriptions', 'row_version', 'bigint'),
      ('ehr.recorded_allergies', 'status', 'text'), ('ehr.recorded_allergies', 'substance', 'text'),
      ('ehr.recorded_allergies', 'row_version', 'bigint'),
      ('ehr.vitals', 'status', 'text'), ('ehr.vitals', 'recorded_at', 'timestamp with time zone'),
      ('ehr.vitals', 'current_correction_no', 'integer'), ('ehr.vitals', 'row_version', 'bigint'),
      ('ehr.vital_corrections', 'replacement_values', 'jsonb'), ('ehr.vital_corrections', 'correction_no', 'integer'),
      ('lab.results', 'current_version', 'bigint'), ('lab.result_releases', 'result_version', 'bigint'),
      ('lab.result_releases', 'released_at', 'timestamp with time zone'),
      ('lab.result_revisions', 'numeric_value', 'numeric'), ('lab.result_revisions', 'text_value', 'text'),
      ('lab.result_invalidations', 'result_id', 'uuid'), ('lab.result_invalidations', 'result_version', 'bigint'),
      ('lab.work_items', 'ordering_facility_id', 'uuid'), ('lab.work_items', 'order_route_id', 'uuid'),
      ('lab.accessions', 'work_item_id', 'uuid'), ('lab.test_executions', 'requested_test_id', 'uuid'),
      ('lab.order_route_result_reports', 'kind', 'text'), ('lab.order_route_result_reports', 'result_version', 'bigint'),
      ('ehr.order_routes', 'ordering_facility_id', 'uuid')
    ) wanted(relation, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = wanted.relation::regclass
                        and attribute_row.attname = wanted.column_name and attribute_row.attnum > 0
                        and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0191: these columns are not as 0001-0153 left them: ' || v_mismatch;
  end if;
  if not pg_has_role(v_owner, (select relation.relowner from pg_class relation
                                where relation.oid = 'ehr.encounters'::regclass), 'USAGE') then
    raise exception using errcode = '55000',
      message = '0191: the owner of 0135''s functions cannot read ehr.encounters under its forced row-level security';
  end if;
  if (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'lab.results'::regclass)
     is distinct from v_owner then
    raise exception using errcode = '55000',
      message = '0191: lab.results is not owned by the owner of 0135''s functions, so the lab snapshot helper could not be owned by it';
  end if;
  if v_owner is distinct from current_user and not pg_has_role(current_user, v_owner, 'MEMBER') then
    raise exception using errcode = '55000', message = '0191: this migrator cannot give its objects to their owner';
  end if;

  -- R1. The agreement texts.
  create table ehr.referral_attestation_texts (
    version text primary key check (version ~ '^referral-(health-id|printed)-attestation-v[1-9][0-9]{0,3}$'),
    destination_kind text not null check (destination_kind in ('health_id', 'printed')),
    text text not null check (length(text) between 20 and 1500 and position('{patient}' in text) > 0
      and position('{receivingFacility}' in text) > 0),
    created_at timestamptz not null default clock_timestamp(),
    constraint referral_attestation_texts_kind_ck check (
      (destination_kind = 'health_id') = (version like 'referral-health-id-attestation-%')),
    constraint referral_attestation_texts_version_kind_uq unique (version, destination_kind)
  );
  comment on table ehr.referral_attestation_texts is
    '0191 (REF-1, Q262 A): the versioned texts a clinician confirms when sending a referral, per destination kind (health_id, printed). Append-only; the newest of a kind is current. Drafts for the DPO.';
  insert into ehr.referral_attestation_texts (version, destination_kind, text) values
    ('referral-health-id-attestation-v1', 'health_id',
     'I confirm that {patient} agreed that {referringFacility} refers them to {receivingFacility}. I told them that {receivingFacility} sees the reason, the urgency, the service asked for and their sex and age to decide whether to accept; that once it accepts, it sees their name, sex, date of birth, the last characters of their Health ID, this letter and the details I selected, until 14 days after the referral is completed; and that the Health ID app shows them where they were referred and lets them withdraw it until {receivingFacility} accepts it.'),
    ('referral-printed-attestation-v1', 'printed',
     'I confirm that {patient} agreed to take a printed referral letter to {receivingFacility}, which is not on Health ID, with the details I selected. I told them that the letter is theirs to carry and that it cannot be called back once printed.');

  -- R2. The referrals.
  create table ehr.referrals (
    id uuid primary key,
    reference char(8) generated always as (upper(left(replace(id::text, '-', ''), 8))) stored,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    referring_organization_id uuid not null,
    referring_facility_id uuid not null,
    source_encounter_id uuid not null,
    sent_by_membership_id uuid not null,
    sent_by_account_id uuid not null,
    referrer_name text not null check (referrer_name = btrim(referrer_name) and length(referrer_name) between 2 and 200),
    referrer_licence_body text check (referrer_licence_body is null or referrer_licence_body = 'MDCN'),
    referrer_licence_number text check (referrer_licence_number is null
      or (referrer_licence_number = btrim(referrer_licence_number) and length(referrer_licence_number) between 3 and 100)),
    destination_kind text not null check (destination_kind in ('health_id', 'printed')),
    receiving_organization_id uuid,
    receiving_facility_id uuid,
    printed_facility_name text check (printed_facility_name is null
      or (printed_facility_name = btrim(printed_facility_name) and length(printed_facility_name) between 2 and 120
          and printed_facility_name !~ '[[:cntrl:]]')),
    printed_facility_town text check (printed_facility_town is null
      or (printed_facility_town = btrim(printed_facility_town) and length(printed_facility_town) between 1 and 120
          and printed_facility_town !~ '[[:cntrl:]]')),
    department_code text not null check (department_code = any (identity.facility_department_codes())),
    service_wanted text check (service_wanted is null
      or (service_wanted = btrim(service_wanted) and length(service_wanted) between 2 and 120
          and service_wanted !~ '[[:cntrl:]]')),
    urgency text not null check (urgency in ('routine', 'urgent')),
    reason text not null check (reason = btrim(reason) and length(reason) between 8 and 300 and reason !~ '[[:cntrl:]]'),
    letter_text text not null check (length(letter_text) <= 8000 and length(btrim(letter_text)) >= 20
      and translate(letter_text, E'\n\r', '') !~ '[[:cntrl:]]'),
    patient_sex_at_send text check (patient_sex_at_send is null or length(patient_sex_at_send) between 1 and 40),
    patient_age_years_at_send smallint check (patient_age_years_at_send is null
      or patient_age_years_at_send between 0 and 130),
    package_item_count smallint not null check (package_item_count between 0 and 120),
    patient_agreement text not null check (patient_agreement = 'clinician_attested'),
    attestation_text_version text not null,
    attested_receiving_facility_name text not null check (
      attested_receiving_facility_name = btrim(attested_receiving_facility_name)
      and length(attested_receiving_facility_name) between 1 and 200),
    state text not null check (state in ('printed', 'sent', 'accepted', 'arrived', 'completed', 'declined', 'withdrawn')),
    sent_at timestamptz not null,
    respond_by timestamptz,
    accepted_at timestamptz,
    accepted_by_membership_id uuid,
    accepted_by_account_id uuid,
    accept_note text check (accept_note is null or (accept_note = btrim(accept_note)
      and length(accept_note) between 1 and 500 and translate(accept_note, E'\n\r', '') !~ '[[:cntrl:]]')),
    arrive_by timestamptz,
    arrived_at timestamptz,
    arrived_by_membership_id uuid,
    arrived_by_account_id uuid,
    visit_queue_entry_id uuid references ehr.visit_queue(id) on delete restrict,
    arrival_basis text check (arrival_basis is null or arrival_basis in ('search', 'own_facility')),
    completed_at timestamptz,
    completed_by_membership_id uuid,
    completed_by_account_id uuid,
    outcome_code text check (outcome_code is null or outcome_code in ('seen_care_returned', 'seen_care_continues',
      'admitted', 'referred_onward', 'did_not_attend')),
    feedback_note text check (feedback_note is null or (feedback_note = btrim(feedback_note)
      and length(feedback_note) between 8 and 2000 and translate(feedback_note, E'\n\r', '') !~ '[[:cntrl:]]')),
    declined_at timestamptz,
    declined_by_membership_id uuid,
    declined_by_account_id uuid,
    decline_reason_code text check (decline_reason_code is null or decline_reason_code in ('service_not_offered',
      'no_capacity', 'more_information_needed', 'better_elsewhere', 'other')),
    decline_note text check (decline_note is null or (decline_note = btrim(decline_note)
      and length(decline_note) between 8 and 500 and translate(decline_note, E'\n\r', '') !~ '[[:cntrl:]]')),
    withdrawn_at timestamptz,
    withdrawn_by text check (withdrawn_by is null or withdrawn_by in ('referring_facility', 'patient')),
    withdrawn_by_membership_id uuid,
    withdrawn_by_account_id uuid,
    withdraw_reason_code text check (withdraw_reason_code is null or withdraw_reason_code in ('patient_changed_mind',
      'no_longer_needed', 'sent_in_error', 'other')),
    withdraw_note text check (withdraw_note is null or (withdraw_note = btrim(withdraw_note)
      and length(withdraw_note) between 8 and 500 and translate(withdraw_note, E'\n\r', '') !~ '[[:cntrl:]]')),
    access_ends_at timestamptz,
    correlation_id text not null check (length(correlation_id) between 8 and 128),
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    constraint referrals_referring_facility_fk foreign key (referring_facility_id, referring_organization_id)
      references identity.facilities(id, organization_id) on delete restrict,
    constraint referrals_receiving_facility_fk foreign key (receiving_facility_id, receiving_organization_id)
      references identity.facilities(id, organization_id) on delete restrict,
    constraint referrals_visit_fk foreign key (source_encounter_id, patient_id, referring_facility_id)
      references ehr.encounters(id, patient_id, facility_id) on delete restrict,
    constraint referrals_sender_fk foreign key (sent_by_membership_id, referring_facility_id, sent_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint referrals_acceptor_fk foreign key (accepted_by_membership_id, receiving_facility_id, accepted_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint referrals_arriver_fk foreign key (arrived_by_membership_id, receiving_facility_id, arrived_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint referrals_completer_fk foreign key (completed_by_membership_id, receiving_facility_id,
      completed_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint referrals_decliner_fk foreign key (declined_by_membership_id, receiving_facility_id, declined_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint referrals_withdrawer_fk foreign key (withdrawn_by_membership_id, referring_facility_id,
      withdrawn_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint referrals_attestation_text_fk foreign key (attestation_text_version, destination_kind)
      references ehr.referral_attestation_texts(version, destination_kind) on delete restrict,
    constraint referrals_distinct_facilities_ck check (receiving_facility_id is null
      or receiving_facility_id <> referring_facility_id),
    constraint referrals_destination_ck check (
      (destination_kind = 'health_id' and receiving_facility_id is not null and receiving_organization_id is not null
        and printed_facility_name is null and printed_facility_town is null and state <> 'printed'
        and respond_by is not null
        and respond_by = sent_at + case urgency when 'urgent' then interval '24 hours' else interval '168 hours' end)
      or (destination_kind = 'printed' and receiving_facility_id is null and receiving_organization_id is null
        and printed_facility_name is not null and respond_by is null and state in ('printed', 'withdrawn'))),
    constraint referrals_licence_ck check ((referrer_licence_body is null) = (referrer_licence_number is null)),
    constraint referrals_acceptance_ck check (
      (accepted_at is null and accepted_by_membership_id is null and accepted_by_account_id is null
        and accept_note is null and arrive_by is null and access_ends_at is null
        and state in ('printed', 'sent', 'declined', 'withdrawn'))
      or (accepted_at is not null and accepted_by_membership_id is not null and accepted_by_account_id is not null
        and arrive_by = accepted_at + interval '90 days' and access_ends_at is not null
        and access_ends_at > accepted_at and access_ends_at <= accepted_at + interval '120 days'
        and accepted_at >= sent_at and state in ('accepted', 'arrived', 'completed'))),
    constraint referrals_arrival_ck check (
      (arrived_at is null and arrived_by_membership_id is null and arrived_by_account_id is null
        and visit_queue_entry_id is null and arrival_basis is null and state <> 'arrived')
      or (arrived_at is not null and arrived_by_membership_id is not null and arrived_by_account_id is not null
        and visit_queue_entry_id is not null and arrival_basis is not null and accepted_at is not null
        and arrived_at >= accepted_at and state in ('arrived', 'completed'))),
    constraint referrals_completion_ck check (
      (completed_at is null and completed_by_membership_id is null and completed_by_account_id is null
        and outcome_code is null and feedback_note is null and state <> 'completed')
      or (completed_at is not null and completed_by_membership_id is not null and completed_by_account_id is not null
        and outcome_code is not null and feedback_note is not null and state = 'completed'
        and completed_at >= accepted_at and (outcome_code = 'did_not_attend') = (arrived_at is null)
        and access_ends_at = least(completed_at + interval '14 days', accepted_at + interval '120 days'))),
    constraint referrals_decline_ck check (
      (declined_at is null and declined_by_membership_id is null and declined_by_account_id is null
        and decline_reason_code is null and decline_note is null and state <> 'declined')
      or (declined_at is not null and declined_by_membership_id is not null and declined_by_account_id is not null
        and decline_reason_code is not null and decline_note is not null and state = 'declined'
        and declined_at >= sent_at)),
    constraint referrals_withdrawal_ck check (
      (withdrawn_at is null and withdrawn_by is null and withdrawn_by_membership_id is null
        and withdrawn_by_account_id is null and withdraw_reason_code is null and withdraw_note is null
        and state <> 'withdrawn')
      or (state = 'withdrawn' and withdrawn_at is not null and withdrawn_at >= sent_at and (
        (withdrawn_by = 'referring_facility' and withdrawn_by_membership_id is not null
          and withdrawn_by_account_id is not null and withdraw_reason_code is not null
          and (withdraw_reason_code not in ('sent_in_error', 'other') or withdraw_note is not null))
        or (withdrawn_by = 'patient' and withdrawn_by_membership_id is null and withdrawn_by_account_id is not null
          and withdraw_reason_code is null and withdraw_note is null and destination_kind = 'health_id'))))
  );
  create index referrals_incoming_idx on ehr.referrals (receiving_facility_id, respond_by) where state = 'sent';
  create index referrals_expected_idx on ehr.referrals (receiving_facility_id, arrive_by) where state = 'accepted';
  create index referrals_received_idx on ehr.referrals (receiving_facility_id, state, accepted_at)
    where state in ('accepted', 'arrived', 'completed');
  create index referrals_receiving_sent_idx on ehr.referrals (receiving_facility_id, sent_at desc)
    where receiving_facility_id is not null;
  create index referrals_referring_idx on ehr.referrals (referring_facility_id, sent_at desc);
  create index referrals_patient_idx on ehr.referrals (patient_id, sent_at desc);
  create index referrals_visit_idx on ehr.referrals (source_encounter_id);
  create index referrals_reference_idx on ehr.referrals (reference);
  create index referrals_sender_idx on ehr.referrals (sent_by_membership_id, sent_at);
  create index referrals_visit_queue_entry_idx on ehr.referrals (visit_queue_entry_id)
    where visit_queue_entry_id is not null;
  comment on table ehr.referrals is
    '0191 (REF-1): one row per referral between facilities (Q261-Q266 A): the patient, the referring facility, visit and clinician, the destination (a facility on Health ID or a printed letter), the content and agreement frozen at sending, and each step''s columns, set once. The guard trigger keeps the frozen columns and the state order; DELETE and TRUNCATE are refused. Only the REF-1 functions read and write it, as its owner.';

  -- R3. The steps.
  create table ehr.referral_events (
    id uuid primary key default gen_random_uuid(),
    referral_id uuid not null references ehr.referrals(id) on delete restrict,
    event_version integer not null check (event_version between 1 and 20),
    kind text not null check (kind in ('sent', 'printed', 'withdrawn', 'patient_withdrew', 'accepted', 'declined',
      'arrived', 'completed')),
    side text not null check (side in ('referring', 'receiving', 'patient')),
    by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    by_account_id uuid not null,
    reason_code text check (reason_code is null or reason_code ~ '^[a-z][a-z_]{1,39}$'),
    state_after text not null check (state_after in ('printed', 'sent', 'accepted', 'arrived', 'completed', 'declined',
      'withdrawn')),
    idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) check (request_sha256 is null or request_sha256 ~ '^[0-9a-f]{64}$'),
    correlation_id text not null check (length(correlation_id) between 8 and 128),
    at timestamptz not null default clock_timestamp(),
    constraint referral_events_version_uq unique (referral_id, event_version),
    constraint referral_events_actor_ck check ((side = 'patient') = (by_membership_id is null)),
    constraint referral_events_key_ck check ((idempotency_key is null) = (request_sha256 is null)
      and (side = 'patient') = (idempotency_key is null))
  );
  create unique index referral_events_key_ux on ehr.referral_events (by_membership_id, idempotency_key)
    where idempotency_key is not null;
  create index referral_events_referral_idx on ehr.referral_events (referral_id, event_version);
  comment on table ehr.referral_events is
    '0191 (REF-1): one row per step of a referral (sent, printed, withdrawn, patient_withdrew, accepted, declined, arrived, completed), with the side, the actor, the reason code, the state after and the Idempotency-Key with the request''s SHA-256 (unique per membership and key). Never a note. Append-only.';

  -- R4. The frozen package.
  create table ehr.referral_package_items (
    id uuid primary key default gen_random_uuid(),
    referral_id uuid not null references ehr.referrals(id) on delete restrict,
    position smallint not null check (position between 0 and 119),
    item_kind text not null check (item_kind in ('diagnosis', 'medicine', 'allergy', 'vital', 'lab_result')),
    source_id uuid not null,
    source_version bigint not null check (source_version > 0),
    source_encounter_id uuid,
    content jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 4096),
    created_at timestamptz not null default clock_timestamp(),
    constraint referral_package_items_source_uq unique (referral_id, item_kind, source_id),
    constraint referral_package_items_position_uq unique (referral_id, position)
  );
  create index referral_package_items_source_idx on ehr.referral_package_items (item_kind, source_id);
  comment on table ehr.referral_package_items is
    '0191 (REF-1, Q261 A): the frozen package, built by the server from the source rows when the referral is sent (never from the request body): JSON objects of at most 4 KB. Append-only; nothing can be added after sending.';

  -- R5. Sources marked entered in error after sending.
  create table ehr.referral_source_marks (
    id uuid primary key default gen_random_uuid(),
    item_kind text not null check (item_kind in ('diagnosis', 'allergy', 'vital', 'lab_result')),
    source_id uuid not null,
    source_version bigint not null default 0 check (source_version >= 0),
    marked_at timestamptz not null default clock_timestamp(),
    constraint referral_source_marks_uq unique (item_kind, source_id, source_version),
    constraint referral_source_marks_version_ck check ((item_kind = 'lab_result') = (source_version > 0))
  );
  comment on table ehr.referral_source_marks is
    '0191 (REF-1): a package item''s source marked entered in error after sending (a diagnosis, vital-sign reading or recorded allergy, or a lab result version), written by triggers on those tables only for sources some package holds, so the frozen copy answers enteredInErrorSinceSent without the receiving facility reading any clinical table. Append-only.';

  -- R6. Support's listing lever.
  create table identity.referral_destination_settings (
    id uuid primary key default gen_random_uuid(),
    facility_id uuid not null,
    organization_id uuid not null,
    listed boolean not null,
    reason text not null check (reason = btrim(reason) and length(reason) between 8 and 500),
    set_by_account_id uuid not null,
    set_at timestamptz not null default clock_timestamp(),
    correlation_id text not null check (length(correlation_id) between 8 and 128),
    constraint referral_destination_settings_facility_fk foreign key (facility_id, organization_id)
      references identity.facilities(id, organization_id) on delete restrict
  );
  create index referral_destination_settings_facility_idx
    on identity.referral_destination_settings (facility_id, set_at desc);
  comment on table identity.referral_destination_settings is
    '0191 (REF-1): support''s listing lever for referrals (as 0086''s order-route lever): the newest row of a facility decides; without one, 0086 H3''s default. Append-only.';

  -- Row-level security on every new table: enabled and forced, four permissive policies for the owner only, so the
  -- guard and append-only triggers run for every role; no privilege for any runtime role.
  foreach v_name in array v_tables loop
    execute format('alter table %s enable row level security', v_name);
    execute format('alter table %s force row level security', v_name);
    execute format('create policy %I on %s for select to %I using (true)',
      split_part(v_name, '.', 2) || '_owner_read', v_name, v_owner);
    execute format('create policy %I on %s for insert to %I with check (true)',
      split_part(v_name, '.', 2) || '_owner_insert', v_name, v_owner);
    execute format('create policy %I on %s for update to %I using (true) with check (true)',
      split_part(v_name, '.', 2) || '_owner_update', v_name, v_owner);
    execute format('create policy %I on %s for delete to %I using (true)',
      split_part(v_name, '.', 2) || '_owner_delete', v_name, v_owner);
    execute format('revoke all on %s from public', v_name);
  end loop;

  -- R7. The control, seeded OFF (FORCE lifted only while this file writes the row, only if it is on, since the
  -- policies admit only platform administrators).
  alter table platform.control_settings drop constraint control_settings_control_key_check;
  execute format('alter table platform.control_settings add constraint control_settings_control_key_check check (control_key in (%s))',
    (select string_agg(format('%L', listed.key), ', ' order by listed.ord)
       from unnest(v_keys || v_key) with ordinality listed(key, ord)));
  insert into platform.control_settings (control_key, enabled, reason, updated_by)
  values (v_key, false,
    'Referrals between facilities on Health ID ship off (Q265 A); on only after the go-live gate (Q160 A)', null);
  execute replace(pg_get_functiondef(v_control_signature::regprocedure), v_control_form, v_control_form_new);

  -- R8. Helpers (no role may execute them; the functions below run them as their owner).

  -- The limits and windows (drafts for the clinical lead and the DPO, Q-REF-10 A).
  create function ehr.referral_limits()
  returns table (sends_per_member_per_day integer, referrals_per_visit integer, waiting_per_destination integer,
    routine_hours integer, urgent_hours integer, arrive_days integer, after_completion_days integer,
    access_cap_days integer, list_days integer, vitals_days integer, package_diagnoses integer,
    package_medicines integer, package_allergies integer, package_vitals integer, package_lab_results integer)
  language sql immutable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select 50, 5, 500, 168, 24, 90, 14, 120, 90, 30, 30, 30, 30, 10, 20
  $fn$;

  -- A time as the API answers it: UTC with milliseconds and Z.
  create function ehr.referral_instant(requested timestamptz)
  returns text
  language sql immutable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select to_char(requested at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  $fn$;

  -- The caller of a staff function: an active membership here, not held by the cutover, the purpose direct care,
  -- and the code the function needs (ehr.referral.arrive with 0135's pair; 'read-or-receive' for route 7).
  create function ehr.referral_caller(required_code text)
  returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
    actor_organization uuid, actor_staff uuid, actor_correlation text, actor_purpose text, can_read boolean,
    can_send boolean, can_receive boolean, can_arrive boolean)
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    refusal text := case when required_code = 'ehr.referral.arrive' then 'REFERRAL_ARRIVAL_NOT_ALLOWED'
                         else 'REFERRAL_NOT_ALLOWED' end;
  begin
    actor_subject := platform.current_actor_subject();
    actor_account := auth.account_id_for_subject(actor_subject);
    actor_membership := platform.current_membership_id();
    actor_facility := platform.current_facility_id();
    actor_correlation := platform.current_correlation_id();
    actor_purpose := platform.current_purpose_of_use();
    if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
       or actor_purpose is distinct from 'direct-care' then
      raise exception using errcode = '42501', message = refusal;
    end if;
    select membership.organization_id, membership.staff_id into actor_organization, actor_staff
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null;
    if not found then
      raise exception using errcode = '42501', message = refusal;
    end if;
    can_read := auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.referral.read');
    can_send := auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.referral.send');
    can_receive := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
      'ehr.referral.receive');
    can_arrive := auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.referral.arrive')
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.read')
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.write');
    if not coalesce(case required_code
         when 'ehr.referral.read' then can_read
         when 'ehr.referral.send' then can_send
         when 'ehr.referral.receive' then can_receive
         when 'ehr.referral.arrive' then can_arrive
         when 'read-or-receive' then can_read or can_receive
         else false end, false) then
      raise exception using errcode = '42501', message = refusal;
    end if;
    return next;
  end
  $fn$;

  -- The control; an unreadable control counts as off (fail closed).
  create function ehr.referral_control_on()
  returns boolean
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    return coalesce(platform.control_enabled('cross_facility_referrals_enabled'), false);
  exception when others then
    return false;
  end
  $fn$;

  -- The effective state: expired (not_answered, not_arrived) past a window, withdrawn (visit_entered_in_error)
  -- once the referral's visit was marked entered in error; never stored.
  create function ehr.referral_effective(referral ehr.referrals)
  returns table (effective_state text, ended_kind text, ended_at timestamptz, visit_in_error boolean)
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    now_value timestamptz := clock_timestamp();
  begin
    visit_in_error := exists (select 1 from ehr.encounters encounter
                               where encounter.id = referral.source_encounter_id
                                 and encounter.status = 'entered_in_error');
    if visit_in_error and referral.state not in ('declined', 'withdrawn') then
      effective_state := 'withdrawn';
      ended_kind := 'visit_entered_in_error';
      ended_at := null;
    elsif referral.state = 'sent' and now_value >= referral.respond_by then
      effective_state := 'expired';
      ended_kind := 'not_answered';
      ended_at := referral.respond_by;
    elsif referral.state = 'accepted' and now_value >= referral.arrive_by then
      effective_state := 'expired';
      ended_kind := 'not_arrived';
      ended_at := referral.arrive_by;
    else
      effective_state := referral.state;
      ended_kind := null;
      ended_at := coalesce(referral.withdrawn_at, referral.declined_at, referral.completed_at);
    end if;
    return next;
  end
  $fn$;

  -- The referral card (planned contract, "The referral card") of each given referral the viewer's facility sent or
  -- received, in the given order. The receiving side's view level decides what is shown: preview (sent, before
  -- respond_by, control on: sex and age only), full (accepted, arrived or completed, before access_ends_at, control
  -- on), metadata (anything else: no patient, reason or notes). sent_detail: the referring side also answers the
  -- reason and notes (route 3 leaves them out).
  create function ehr.referral_cards(requested_ids uuid[], viewer_facility uuid, sent_detail boolean,
    control_on boolean)
  returns table (ord bigint, referral_id uuid, side text, view_level text, effective_state text, patient_id uuid,
    card jsonb)
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    return query
    with base as (
      select ordering.ord_position, referral.id as row_id, referral.patient_id as row_patient,
             referral.reference as row_reference, referral.destination_kind as row_kind,
             referral.referring_facility_id as row_referring, referral.receiving_facility_id as row_receiving,
             referral.printed_facility_name as row_printed_name, referral.printed_facility_town as row_printed_town,
             referral.source_encounter_id as row_encounter, referral.department_code as row_department,
             referral.service_wanted as row_service, referral.urgency as row_urgency, referral.reason as row_reason,
             referral.referrer_name as row_referrer, referral.referrer_licence_body as row_licence_body,
             referral.referrer_licence_number as row_licence_number, referral.sent_by_membership_id as row_sender,
             referral.state as row_state, referral.sent_at as row_sent_at, referral.respond_by as row_respond_by,
             referral.accepted_at as row_accepted_at, referral.accept_note as row_accept_note,
             referral.arrive_by as row_arrive_by, referral.arrived_at as row_arrived_at,
             referral.visit_queue_entry_id as row_entry, referral.declined_at as row_declined_at,
             referral.decline_reason_code as row_decline_code, referral.decline_note as row_decline_note,
             referral.withdrawn_at as row_withdrawn_at, referral.withdrawn_by as row_withdrawn_by,
             referral.withdraw_reason_code as row_withdraw_code, referral.withdraw_note as row_withdraw_note,
             referral.completed_at as row_completed_at, referral.outcome_code as row_outcome,
             referral.feedback_note as row_feedback, referral.access_ends_at as row_access_ends_at,
             referral.patient_sex_at_send as row_sex_at_send, referral.patient_age_years_at_send as row_age_at_send,
             referral.row_version as row_row_version,
             case when referral.referring_facility_id = viewer_facility then 'sent' else 'received' end as row_side,
             effective.effective_state as row_effective, effective.ended_kind as row_ended_kind,
             effective.ended_at as row_ended_at, effective.visit_in_error as row_visit_in_error
        from unnest(requested_ids) with ordinality ordering(wanted_id, ord_position)
        join ehr.referrals referral on referral.id = ordering.wanted_id
         and (referral.referring_facility_id = viewer_facility or referral.receiving_facility_id = viewer_facility)
        cross join lateral ehr.referral_effective(referral) effective
    ), levelled as (
      select base.*,
             case when base.row_side = 'sent' then 'full'
                  when coalesce(control_on, false) and not base.row_visit_in_error and base.row_effective = 'sent'
                    then 'preview'
                  when coalesce(control_on, false) and not base.row_visit_in_error
                       and base.row_effective in ('accepted', 'arrived', 'completed')
                       and clock_timestamp() < base.row_access_ends_at then 'full'
                  else 'metadata' end as row_level
        from base
    ), shown as (
      select levelled.*,
             (levelled.row_side = 'sent' and coalesce(sent_detail, false))
               or (levelled.row_side = 'received' and levelled.row_level <> 'metadata') as row_content
        from levelled
    )
    select shown.ord_position, shown.row_id, shown.row_side, shown.row_level, shown.row_effective, shown.row_patient,
      jsonb_build_object(
        'referralId', shown.row_id, 'reference', shown.row_reference::text, 'side', shown.row_side,
        'viewLevel', shown.row_level,
        'patient', case
          when shown.row_side = 'sent' or shown.row_level = 'full' then jsonb_build_object(
            'patientId', patient.id, 'fullName', patient.full_name, 'sex', patient.gender,
            'dateOfBirth', to_char(patient.dob, 'YYYY-MM-DD'),
            'dateOfBirthEstimated', exists (select 1 from identity.unknown_patients unknown_record
                                             where unknown_record.patient_id = patient.id
                                               and unknown_record.status in ('open', 'sent_for_review'))
                                    and patient.dob is not null,
            'healthIdLast4', right(patient.hid_code, 4), 'sexAtSend', shown.row_sex_at_send,
            'ageYearsAtSend', shown.row_age_at_send)
          when shown.row_level = 'preview' then jsonb_build_object(
            'patientId', null, 'fullName', null, 'sex', null, 'dateOfBirth', null, 'dateOfBirthEstimated', null,
            'healthIdLast4', null, 'sexAtSend', shown.row_sex_at_send, 'ageYearsAtSend', shown.row_age_at_send)
          end,
        'destinationKind', shown.row_kind,
        'referringFacility', jsonb_build_object('facilityId', shown.row_referring, 'name', referring.name),
        'receivingFacility', case when shown.row_receiving is not null then
          jsonb_build_object('facilityId', shown.row_receiving, 'name', receiving.name) end,
        'printedFacility', case when shown.row_kind = 'printed' then
          jsonb_build_object('name', shown.row_printed_name, 'town', shown.row_printed_town) end,
        'encounterId', case when shown.row_side = 'sent' then shown.row_encounter end,
        'departmentCode', shown.row_department,
        'serviceWanted', case when shown.row_side = 'sent' or shown.row_level <> 'metadata' then shown.row_service end,
        'urgency', shown.row_urgency,
        'reason', case when shown.row_content then shown.row_reason end,
        'referrer', case when shown.row_side = 'sent' or shown.row_level <> 'metadata' then jsonb_build_object(
          'name', shown.row_referrer,
          'licence', case when shown.row_licence_body is not null then
            jsonb_build_object('body', shown.row_licence_body, 'number', shown.row_licence_number) end,
          'membershipId', case when shown.row_side = 'sent' then shown.row_sender end) end)
      || jsonb_build_object(
        'state', shown.row_state, 'effectiveState', shown.row_effective, 'endedKind', shown.row_ended_kind,
        'sentAt', ehr.referral_instant(shown.row_sent_at), 'respondBy', ehr.referral_instant(shown.row_respond_by),
        'acceptedAt', ehr.referral_instant(shown.row_accepted_at),
        'acceptNote', case when shown.row_content then shown.row_accept_note end,
        'arriveBy', ehr.referral_instant(shown.row_arrive_by), 'arrivedAt', ehr.referral_instant(shown.row_arrived_at),
        'visitQueueEntryId', case when shown.row_side = 'received' then shown.row_entry end,
        'decline', case when shown.row_declined_at is not null then jsonb_build_object(
          'reasonCode', shown.row_decline_code,
          'note', case when shown.row_content then shown.row_decline_note end,
          'declinedAt', ehr.referral_instant(shown.row_declined_at)) end,
        'withdrawal', case when shown.row_withdrawn_at is not null then jsonb_build_object(
          'by', shown.row_withdrawn_by, 'reasonCode', shown.row_withdraw_code,
          'note', case when shown.row_content and shown.row_side = 'sent' then shown.row_withdraw_note end,
          'withdrawnAt', ehr.referral_instant(shown.row_withdrawn_at)) end,
        'outcome', case when shown.row_completed_at is not null then jsonb_build_object(
          'code', shown.row_outcome,
          'feedbackNote', case when shown.row_content then shown.row_feedback end,
          'completedAt', ehr.referral_instant(shown.row_completed_at)) end,
        'completedAt', ehr.referral_instant(shown.row_completed_at),
        'endedAt', ehr.referral_instant(shown.row_ended_at),
        'accessEndsAt', ehr.referral_instant(shown.row_access_ends_at),
        'packageSummary', case when shown.row_side = 'sent' or shown.row_level = 'full' then coalesce((
          select jsonb_agg(jsonb_build_object('kind', counted.kind_name, 'count', counted.item_count)
                           order by counted.kind_order)
            from (select case item.item_kind when 'diagnosis' then 'diagnoses' when 'medicine' then 'medicines'
                           when 'allergy' then 'allergies' when 'vital' then 'vitals' else 'labResults' end as kind_name,
                         case item.item_kind when 'diagnosis' then 1 when 'medicine' then 2 when 'allergy' then 3
                           when 'vital' then 4 else 5 end as kind_order,
                         count(*) as item_count
                    from ehr.referral_package_items item
                   where item.referral_id = shown.row_id
                   group by item.item_kind) counted), '[]'::jsonb) end,
        'rowVersion', shown.row_row_version)
      from shown
      join identity.patients patient on patient.id = shown.row_patient
      join identity.facilities referring on referring.id = shown.row_referring
      left join identity.facilities receiving on receiving.id = shown.row_receiving
     order by shown.ord_position;
  end
  $fn$;

  -- The frozen package as answered: per item its id, whether its source was marked entered in error since sending
  -- (then no content), and the content as frozen.
  create function ehr.referral_package(requested_referral_id uuid)
  returns jsonb
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    found_referral ehr.referrals%rowtype;
    sections jsonb;
  begin
    select referral.* into found_referral from ehr.referrals referral where referral.id = requested_referral_id;
    if found_referral.id is null then
      return null;
    end if;
    select jsonb_build_object(
             'diagnoses', coalesce(jsonb_agg(marked.item_value order by marked.position)
                                     filter (where marked.item_kind = 'diagnosis'), '[]'::jsonb),
             'medicines', coalesce(jsonb_agg(marked.item_value order by marked.position)
                                     filter (where marked.item_kind = 'medicine'), '[]'::jsonb),
             'allergies', coalesce(jsonb_agg(marked.item_value order by marked.position)
                                     filter (where marked.item_kind = 'allergy'), '[]'::jsonb),
             'vitals', coalesce(jsonb_agg(marked.item_value order by marked.position)
                                  filter (where marked.item_kind = 'vital'), '[]'::jsonb),
             'labResults', coalesce(jsonb_agg(marked.item_value order by marked.position)
                                      filter (where marked.item_kind = 'lab_result'), '[]'::jsonb))
      into sections
      from (select item.position, item.item_kind,
                   jsonb_build_object('itemId', item.id, 'enteredInErrorSinceSent', flagged.in_error,
                     'content', case when flagged.in_error then null else item.content end) as item_value
              from ehr.referral_package_items item
              cross join lateral (
                select case item.item_kind
                  when 'lab_result' then
                    exists (select 1 from ehr.referral_source_marks mark
                             where mark.item_kind = 'lab_result' and mark.source_id = item.source_id
                               and mark.source_version = item.source_version)
                    or exists (select 1 from lab.order_route_result_reports report
                                where report.result_id = item.source_id and report.result_version = item.source_version
                                  and report.kind = 'entered_in_error')
                  when 'allergy' then
                    exists (select 1 from ehr.referral_source_marks mark
                             where mark.item_kind = 'allergy' and mark.source_id = item.source_id)
                  else
                    exists (select 1 from ehr.referral_source_marks mark
                             where mark.item_kind = item.item_kind and mark.source_id = item.source_id)
                    or exists (select 1 from ehr.encounters encounter
                                where encounter.id = item.source_encounter_id
                                  and encounter.status = 'entered_in_error')
                  end as in_error) flagged
             where item.referral_id = requested_referral_id) marked;
    return jsonb_build_object('frozenAt', ehr.referral_instant(found_referral.sent_at),
      'letterText', found_referral.letter_text, 'sections', sections);
  end
  $fn$;

  -- The steps, oldest first; a member is named only to the facility whose member it is.
  create function ehr.referral_history(requested_referral_id uuid, viewer_side text)
  returns jsonb
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    return coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', event.kind, 'at', ehr.referral_instant(event.at), 'side', event.side,
               'byMembershipId', case when (viewer_side = 'sent' and event.side = 'referring')
                                        or (viewer_side = 'received' and event.side = 'receiving')
                                      then event.by_membership_id end,
               'reasonCode', event.reason_code) order by event.event_version)
        from ehr.referral_events event where event.referral_id = requested_referral_id), '[]'::jsonb);
  end
  $fn$;

  -- The package the clinician ticked, built from the source rows under the caller's own access (the tables'
  -- row-level security), or null when any item is not eligible (the same for every reason).
  create function ehr.referral_freeze_package(requested_patient uuid, requested_facility uuid,
    diagnosis_ids uuid[], prescription_ids uuid[], allergy_ids uuid[], vital_ids uuid[], lab_result_ids uuid[])
  returns jsonb
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    limits record;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    items jsonb := '[]'::jsonb;
    part jsonb;
    found_count integer;
  begin
    select * into limits from ehr.referral_limits();
    if cardinality(coalesce(diagnosis_ids, '{}')) > limits.package_diagnoses
       or cardinality(coalesce(prescription_ids, '{}')) > limits.package_medicines
       or cardinality(coalesce(allergy_ids, '{}')) > limits.package_allergies
       or cardinality(coalesce(vital_ids, '{}')) > limits.package_vitals
       or cardinality(coalesce(lab_result_ids, '{}')) > limits.package_lab_results
       or array_position(coalesce(diagnosis_ids, '{}'), null) is not null
       or array_position(coalesce(prescription_ids, '{}'), null) is not null
       or array_position(coalesce(allergy_ids, '{}'), null) is not null
       or array_position(coalesce(vital_ids, '{}'), null) is not null
       or array_position(coalesce(lab_result_ids, '{}'), null) is not null
       or (select count(distinct listed) from unnest(coalesce(diagnosis_ids, '{}')) listed)
          <> cardinality(coalesce(diagnosis_ids, '{}'))
       or (select count(distinct listed) from unnest(coalesce(prescription_ids, '{}')) listed)
          <> cardinality(coalesce(prescription_ids, '{}'))
       or (select count(distinct listed) from unnest(coalesce(allergy_ids, '{}')) listed)
          <> cardinality(coalesce(allergy_ids, '{}'))
       or (select count(distinct listed) from unnest(coalesce(vital_ids, '{}')) listed)
          <> cardinality(coalesce(vital_ids, '{}'))
       or (select count(distinct listed) from unnest(coalesce(lab_result_ids, '{}')) listed)
          <> cardinality(coalesce(lab_result_ids, '{}')) then
      return null;
    end if;

    -- Current diagnoses at this facility (the chart summary's problems rule).
    select coalesce(jsonb_agg(jsonb_build_object('kind', 'diagnosis', 'sourceId', diagnosis.id,
             'sourceVersion', diagnosis.row_version, 'sourceEncounterId', diagnosis.encounter_id,
             'content', jsonb_build_object('codeSystem', diagnosis.code_system, 'code', diagnosis.code,
               'display', left(diagnosis.display, 500), 'clinicalStatus', diagnosis.clinical_status,
               'verificationStatus', diagnosis.verification_status,
               'onsetAt', ehr.referral_instant(diagnosis.onset_at),
               'recordedAt', ehr.referral_instant(diagnosis.created_at))) order by listed.ord), '[]'::jsonb),
           count(*)
      into part, found_count
      from unnest(coalesce(diagnosis_ids, '{}')) with ordinality listed(id, ord)
      join ehr.diagnoses diagnosis on diagnosis.id = listed.id
     where diagnosis.patient_id = requested_patient and diagnosis.facility_id = requested_facility
       and diagnosis.clinical_status in ('active', 'recurrence', 'relapse')
       and diagnosis.verification_status not in ('refuted', 'entered_in_error')
       and not exists (select 1 from ehr.encounters encounter
                        where encounter.id = diagnosis.encounter_id and encounter.status = 'entered_in_error');
    if found_count <> cardinality(coalesce(diagnosis_ids, '{}')) then
      return null;
    end if;
    items := items || part;

    -- Current medicines at this facility (the chart summary's medications rule); no dispensing progress.
    select coalesce(jsonb_agg(jsonb_build_object('kind', 'medicine', 'sourceId', prescription.id,
             'sourceVersion', prescription.row_version, 'sourceEncounterId', prescription.encounter_id,
             'content', jsonb_build_object('medicationDisplay', left(prescription.medication_display, 500),
               'medicationCodeSystem', prescription.medication_code_system,
               'medicationCode', prescription.medication_code,
               'doseQuantity', case when prescription.dose_quantity is not null
                                    then trim_scale(prescription.dose_quantity)::text end,
               'doseUnit', prescription.dose_unit, 'routeCode', prescription.route_code,
               'frequency', prescription.frequency, 'instructions', left(prescription.instructions, 1500),
               'startsOn', to_char(prescription.starts_on, 'YYYY-MM-DD'),
               'endsOn', to_char(prescription.ends_on, 'YYYY-MM-DD'), 'status', prescription.status,
               'prescribedAt', ehr.referral_instant(prescription.created_at))) order by listed.ord), '[]'::jsonb),
           count(*)
      into part, found_count
      from unnest(coalesce(prescription_ids, '{}')) with ordinality listed(id, ord)
      join ehr.prescriptions prescription on prescription.id = listed.id
     where prescription.patient_id = requested_patient and prescription.facility_id = requested_facility
       and prescription.status in ('active', 'on_hold')
       and (prescription.ends_on is null or prescription.ends_on >= today)
       and not exists (select 1 from ehr.encounters encounter
                        where encounter.id = prescription.encounter_id and encounter.status = 'entered_in_error');
    if found_count <> cardinality(coalesce(prescription_ids, '{}')) then
      return null;
    end if;
    items := items || part;

    -- Recorded allergies from any facility, as the chart shows them (0117).
    select coalesce(jsonb_agg(jsonb_build_object('kind', 'allergy', 'sourceId', allergy.id,
             'sourceVersion', allergy.row_version, 'sourceEncounterId', null,
             'content', jsonb_build_object('substance', left(allergy.substance, 500),
               'reaction', left(allergy.reaction, 1000), 'severity', allergy.severity,
               'recordedOn', to_char((allergy.created_at at time zone 'Africa/Lagos')::date, 'YYYY-MM-DD'),
               'recordedAtReferringFacility', allergy.facility_id = requested_facility)) order by listed.ord),
             '[]'::jsonb),
           count(*)
      into part, found_count
      from unnest(coalesce(allergy_ids, '{}')) with ordinality listed(id, ord)
      join ehr.recorded_allergies allergy on allergy.id = listed.id
     where allergy.patient_id = requested_patient and allergy.status = 'active';
    if found_count <> cardinality(coalesce(allergy_ids, '{}')) then
      return null;
    end if;
    items := items || part;

    -- Vital-sign readings at this facility in the last 30 days, recorded (0142), with their current correction.
    select coalesce(jsonb_agg(jsonb_build_object('kind', 'vital', 'sourceId', reading.id,
             'sourceVersion', reading.row_version, 'sourceEncounterId', reading.encounter_id,
             'content', jsonb_build_object('recordedAt', ehr.referral_instant(reading.recorded_at),
               'measures', jsonb_strip_nulls(jsonb_build_object(
                 'heightCm', measured.value -> 'height_cm', 'weightKg', measured.value -> 'weight_kg',
                 'temperatureC', measured.value -> 'temperature_c', 'pulseBpm', measured.value -> 'pulse_bpm',
                 'respiratoryRate', measured.value -> 'respiratory_rate',
                 'systolicMmhg', measured.value -> 'systolic_mmhg', 'diastolicMmhg', measured.value -> 'diastolic_mmhg',
                 'oxygenSaturationPercent', measured.value -> 'oxygen_saturation_percent')))) order by listed.ord),
             '[]'::jsonb),
           count(*)
      into part, found_count
      from unnest(coalesce(vital_ids, '{}')) with ordinality listed(id, ord)
      join ehr.vitals reading on reading.id = listed.id
      left join ehr.vital_corrections correction
        on correction.vital_id = reading.id and correction.correction_no = reading.current_correction_no
      cross join lateral (select jsonb_build_object('height_cm', reading.height_cm, 'weight_kg', reading.weight_kg,
                            'temperature_c', reading.temperature_c, 'pulse_bpm', reading.pulse_bpm,
                            'respiratory_rate', reading.respiratory_rate, 'systolic_mmhg', reading.systolic_mmhg,
                            'diastolic_mmhg', reading.diastolic_mmhg,
                            'oxygen_saturation_percent', reading.oxygen_saturation_percent)
                          || coalesce(correction.replacement_values, '{}'::jsonb) as value) measured
     where reading.patient_id = requested_patient and reading.facility_id = requested_facility
       and reading.status = 'recorded'
       and reading.recorded_at >= clock_timestamp() - make_interval(days => limits.vitals_days)
       and not exists (select 1 from ehr.encounters encounter
                        where encounter.id = reading.encounter_id and encounter.status = 'entered_in_error');
    if found_count <> cardinality(coalesce(vital_ids, '{}')) then
      return null;
    end if;
    items := items || part;

    -- Released lab results of lab requests made at this facility (the newest released version, not entered in
    -- error).
    select coalesce(jsonb_agg(jsonb_build_object('kind', 'lab_result', 'sourceId', snapshot.result_id,
             'sourceVersion', snapshot.result_version, 'sourceEncounterId', null, 'content', snapshot.content)
             order by listed.ord), '[]'::jsonb),
           count(*)
      into part, found_count
      from unnest(coalesce(lab_result_ids, '{}')) with ordinality listed(id, ord)
      join lab.referral_result_snapshots(requested_patient, requested_facility, coalesce(lab_result_ids, '{}')) snapshot
        on snapshot.result_id = listed.id;
    if found_count <> cardinality(coalesce(lab_result_ids, '{}')) then
      return null;
    end if;
    items := items || part;

    if exists (select 1 from jsonb_array_elements(items) item where octet_length((item -> 'content')::text) > 4096) then
      return null;
    end if;
    return items;
  end
  $fn$;

  -- Released lab results for a package: of lab requests made at requested_facility for requested_patient, either at
  -- this facility's own laboratory (the current version, released, not entered in error) or at another one through
  -- an order route (the newest report that came back, released). Reads the lab tables under their row-level
  -- security as their owner.
  create function lab.referral_result_snapshots(requested_patient uuid, requested_facility uuid, requested_ids uuid[])
  returns table (result_id uuid, result_version bigint, content jsonb)
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    return query
      select result_row.id, result_row.current_version,
             jsonb_build_object('testName', left(test.name, 500), 'testCodeSystem', test.code_system,
               'testCode', test.code, 'resultType', revision.result_type,
               'value', left(coalesce(trim_scale(revision.numeric_value)::text, revision.text_value), 1000),
               'unit', revision.unit, 'referenceRange', revision.reference_range,
               'abnormalFlag', revision.abnormal_flag, 'releasedAt', ehr.referral_instant(release_row.released_at))
        from (select distinct listed.id from unnest(requested_ids) listed(id)) wanted
        join lab.results result_row on result_row.id = wanted.id
         and result_row.patient_id = requested_patient and result_row.facility_id = requested_facility
        join lab.result_revisions revision on revision.result_id = result_row.id
         and revision.version = result_row.current_version and revision.patient_id = result_row.patient_id
        join lateral (select release.released_at from lab.result_releases release
                       where release.result_id = result_row.id and release.result_version = result_row.current_version
                         and release.patient_id = result_row.patient_id
                       order by release.released_at desc limit 1) release_row on true
        join lab.test_executions execution on execution.id = result_row.execution_id
         and execution.patient_id = result_row.patient_id
        join lab.work_item_requested_tests test on test.id = execution.requested_test_id
        join lab.accessions accession on accession.id = execution.accession_id
        join lab.work_items item on item.id = accession.work_item_id
         and item.ordering_facility_id = requested_facility and item.order_route_id is null
       where not exists (select 1 from lab.result_invalidations invalidation
                          where invalidation.result_id = result_row.id
                            and invalidation.result_version = result_row.current_version);
    return query
      select report_row.result_id, report_row.result_version,
             jsonb_build_object('testName', left(report_row.test_name, 500),
               'testCodeSystem', report_row.test_code_system, 'testCode', report_row.test_code,
               'resultType', report_row.result_type,
               'value', left(coalesce(trim_scale(report_row.numeric_value)::text, report_row.text_value), 1000),
               'unit', report_row.unit, 'referenceRange', report_row.reference_range,
               'abnormalFlag', report_row.abnormal_flag, 'releasedAt', ehr.referral_instant(report_row.occurred_at))
        from (select distinct listed.id from unnest(requested_ids) listed(id)) wanted
        join lateral (select report.* from lab.order_route_result_reports report
                        join ehr.order_routes route on route.id = report.route_id
                       where report.result_id = wanted.id and route.patient_id = requested_patient
                         and route.ordering_facility_id = requested_facility and route.kind = 'lab_request'
                       order by report.result_version desc, report.occurred_at desc, report.id desc
                       limit 1) report_row on true
       where report_row.kind = 'released';
  end
  $fn$;

  -- One audit row of a staff step, in the request's transaction. Ids, codes, counts and the outcome only.
  create function ehr.referral_audit(a_subject text, a_account uuid, a_membership uuid, a_organization uuid,
    a_facility uuid, a_correlation text, a_purpose text, a_patient uuid, a_action text, a_outcome text,
    a_resource_id text, a_details jsonb)
  returns void
  language plpgsql volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      a_correlation, 'staff', a_subject, a_account, a_membership, a_organization, a_facility, a_patient,
      a_action, a_outcome, 'referral', a_resource_id, a_purpose, 'application', 'ehr-api',
      coalesce(a_details, '{}'::jsonb));
  end
  $fn$;

  -- The Idempotency-Key: 'new', 'replay' (the same key and body: the referral and the step it made) or 'reused'
  -- (the same key, another body). Under an advisory lock per membership and key.
  create function ehr.referral_idempotency(a_membership uuid, a_key text, a_sha text)
  returns table (state text, referral_id uuid, kind text)
  language plpgsql volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    found_event ehr.referral_events%rowtype;
  begin
    if a_key is null or a_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' or a_sha is null or a_sha !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'REFERRAL_IDEMPOTENCY_KEY_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('referral-key:' || a_membership::text || ':' || a_key, 0));
    select event.* into found_event from ehr.referral_events event
     where event.by_membership_id = a_membership and event.idempotency_key = a_key;
    if found_event.id is null then
      state := 'new';
    elsif found_event.request_sha256 = a_sha then
      state := 'replay';
      referral_id := found_event.referral_id;
      kind := found_event.kind;
    else
      state := 'reused';
      referral_id := found_event.referral_id;
    end if;
    return next;
  end
  $fn$;

  -- The patient's inbox notice (0037): the referral's id, the facility names and whether it is a printed letter.
  -- No department, reason or urgency. A patient with no account gets nothing (0037's rule).
  create function ehr.referral_notify_patient(requested_referral_id uuid, notification_code text)
  returns void
  language plpgsql volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    found_referral ehr.referrals%rowtype;
  begin
    select referral.* into found_referral from ehr.referrals referral where referral.id = requested_referral_id;
    perform notification.enqueue_patient_inbox_item(found_referral.patient_id, notification_code, 'referral',
      found_referral.id,
      jsonb_build_object('referralId', found_referral.id,
        'referringFacilityName', (select facility.name from identity.facilities facility
                                   where facility.id = found_referral.referring_facility_id),
        'destinationName', coalesce((select facility.name from identity.facilities facility
                                      where facility.id = found_referral.receiving_facility_id),
                                    found_referral.printed_facility_name),
        'printed', found_referral.destination_kind = 'printed'));
  end
  $fn$;

  -- The guard (BEFORE UPDATE): the state moves only along the contract's table, only that step's columns change
  -- (each set once), and row_version goes up by one. Every frozen column (patient, facilities, visit, sender,
  -- destination, content, agreement, sent_at, respond_by) is outside every step's list, so it never changes.
  create function ehr.referral_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    allowed text[];
  begin
    allowed := case old.state || '>' || new.state
      when 'sent>accepted' then array['accepted_at', 'accepted_by_membership_id', 'accepted_by_account_id',
        'accept_note', 'arrive_by', 'access_ends_at']
      when 'sent>declined' then array['declined_at', 'declined_by_membership_id', 'declined_by_account_id',
        'decline_reason_code', 'decline_note']
      when 'sent>withdrawn' then array['withdrawn_at', 'withdrawn_by', 'withdrawn_by_membership_id',
        'withdrawn_by_account_id', 'withdraw_reason_code', 'withdraw_note']
      when 'printed>withdrawn' then array['withdrawn_at', 'withdrawn_by', 'withdrawn_by_membership_id',
        'withdrawn_by_account_id', 'withdraw_reason_code', 'withdraw_note']
      when 'accepted>arrived' then array['arrived_at', 'arrived_by_membership_id', 'arrived_by_account_id',
        'visit_queue_entry_id', 'arrival_basis']
      when 'accepted>completed' then array['completed_at', 'completed_by_membership_id', 'completed_by_account_id',
        'outcome_code', 'feedback_note', 'access_ends_at']
      when 'arrived>completed' then array['completed_at', 'completed_by_membership_id', 'completed_by_account_id',
        'outcome_code', 'feedback_note', 'access_ends_at']
    end;
    if allowed is null then
      raise exception using errcode = '55000', message = 'REFERRAL_STATE_ORDER';
    end if;
    allowed := allowed || array['state', 'updated_at', 'row_version', 'reference'];
    if (to_jsonb(new) - allowed) is distinct from (to_jsonb(old) - allowed) then
      raise exception using errcode = '55000', message = 'REFERRAL_FROZEN';
    end if;
    if exists (select 1 from unnest(allowed) column_name
                where column_name not in ('state', 'updated_at', 'row_version', 'reference', 'access_ends_at')
                  and to_jsonb(old) -> column_name <> 'null'::jsonb) then
      raise exception using errcode = '55000', message = 'REFERRAL_FROZEN';
    end if;
    if new.row_version is distinct from old.row_version + 1 then
      raise exception using errcode = '55000', message = 'REFERRAL_ROW_VERSION';
    end if;
    return new;
  end
  $fn$;

  -- Package items (BEFORE INSERT): only within the referral's package_item_count; with (referral, position) unique,
  -- nothing can be added after sending.
  create function ehr.referral_package_item_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if not exists (select 1 from ehr.referrals referral
                    where referral.id = new.referral_id and new.position < referral.package_item_count) then
      raise exception using errcode = '55000', message = 'REFERRAL_PACKAGE_CLOSED';
    end if;
    return new;
  end
  $fn$;

  -- A package item's source marked entered in error (AFTER triggers on the source tables). Writes a mark only when
  -- some package holds the source. Runs in the writer's transaction, as the owner of the marks table.
  create function ehr.referral_source_marked()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    marked_kind text := tg_argv[0];
    marked_source uuid;
    marked_version bigint := 0;
  begin
    if marked_kind = 'lab_result' then
      marked_source := (to_jsonb(new) ->> 'result_id')::uuid;
      marked_version := (to_jsonb(new) ->> 'result_version')::bigint;
      if exists (select 1 from ehr.referral_package_items item
                  where item.item_kind = 'lab_result' and item.source_id = marked_source
                    and item.source_version = marked_version) then
        insert into ehr.referral_source_marks (item_kind, source_id, source_version)
        values ('lab_result', marked_source, marked_version)
        on conflict on constraint referral_source_marks_uq do nothing;
      end if;
    elsif marked_kind in ('diagnosis', 'allergy', 'vital') then
      marked_source := (to_jsonb(new) ->> 'id')::uuid;
      if exists (select 1 from ehr.referral_package_items item
                  where item.item_kind = marked_kind and item.source_id = marked_source) then
        insert into ehr.referral_source_marks (item_kind, source_id, source_version)
        values (marked_kind, marked_source, 0)
        on conflict on constraint referral_source_marks_uq do nothing;
      end if;
    end if;
    return null;
  end
  $fn$;

  -- Whether support lists a facility for referrals: the newest setting, else 0086 H3's default (a governed facility
  -- is listed; a self-signed-up one only when support's review recorded a real check).
  create function identity.referral_destination_listed(target_facility_id uuid)
  returns boolean
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    return coalesce(
      (select setting.listed from identity.referral_destination_settings setting
        where setting.facility_id = target_facility_id
        order by setting.set_at desc, setting.id desc limit 1),
      (select coalesce(application.id is null
            or application.self_service_verification_method in
              ('cac_registered_contact', 'officer_match', 'regulator_register', 'in_person'), false)
         from identity.facilities facility
         left join lateral (
           select candidate.id, candidate.self_service_verification_method
             from identity.organization_applications candidate
            where candidate.organization_id = facility.organization_id
              and candidate.approval_mode = 'self_service'
              and candidate.reviewed_by_account_id is null
              and (candidate.status = 'approved' or candidate.self_service_released_at is not null)
            order by candidate.reviewed_at desc, candidate.id desc
            limit 1) application on true
        where facility.id = target_facility_id),
      false);
  end
  $fn$;

  -- Whether a facility may receive a referral now (0086 H4's rules for a hospital or clinic): active and verified,
  -- its organization active and reviewed or governed, an active hospital or clinic product, listed for referrals,
  -- and a member who holds ehr.referral.receive there.
  create function identity.referral_destination_eligible(target_facility_id uuid)
  returns boolean
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    facility_row identity.facilities%rowtype;
    found_state text;
  begin
    if target_facility_id is null then
      return false;
    end if;
    select facility.* into facility_row from identity.facilities facility where facility.id = target_facility_id;
    if facility_row.id is null or not facility_row.active or facility_row.lifecycle_status <> 'verified'
       or not exists (select 1 from identity.organizations organization
                       where organization.id = facility_row.organization_id and organization.active) then
      return false;
    end if;
    select state_row.review_state into found_state
      from identity.organization_self_service_state(facility_row.organization_id) state_row;
    if found_state is not null then
      if found_state <> 'reviewed' then
        return false;
      end if;
    elsif not exists (select 1 from identity.organization_applications governed
                       where governed.organization_id = facility_row.organization_id
                         and governed.approval_mode = 'admin_review' and governed.status = 'approved') then
      return false;
    end if;
    if not exists (select 1 from identity.organization_products product
                     join identity.organization_applications source_application
                       on source_application.id = product.source_application_id
                    where product.facility_id = target_facility_id
                      and product.organization_id = facility_row.organization_id
                      and product.status = 'active' and source_application.status = 'approved'
                      and source_application.organization_type in ('hospital', 'clinic')) then
      return false;
    end if;
    if not identity.referral_destination_listed(target_facility_id) then
      return false;
    end if;
    return exists (
      select 1
        from identity.staff_facility_memberships membership
        join auth.accounts account on account.id = membership.account_id and account.status = 'active'
       where membership.facility_id = target_facility_id and membership.active
         and membership.migration_hold_reason is null
         and auth.membership_has_permission(account.subject, membership.id, target_facility_id,
               'ehr.referral.receive'));
  end
  $fn$;

  -- Route 1: the current agreement text of a destination kind.
  create function ehr.referral_attestation_text(requested_kind text)
  returns table (version text, text text)
  language plpgsql stable security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    perform 1 from ehr.referral_caller('ehr.referral.send');
    if requested_kind is null or requested_kind not in ('health_id', 'printed') then
      raise exception using errcode = '22023', message = 'REFERRAL_INVALID';
    end if;
    return query
      select text_row.version, text_row.text from ehr.referral_attestation_texts text_row
       where text_row.destination_kind = requested_kind
       order by text_row.created_at desc, text_row.version desc limit 1;
  end
  $fn$;
  comment on function ehr.referral_attestation_text(text) is
    '0191 (REF-1 route 1): the current agreement text of a destination kind (health_id or printed). Needs ehr.referral.send here, direct care.';

  -- Route 2: send a referral to a facility on Health ID, or record a printed letter. Refusals in the contract's
  -- order are answered (outcome) and audited in the request's transaction; malformed input raises 22023.
  create function ehr.referral_send(requested_patient_id uuid, requested_encounter_id uuid,
    requested_destination_kind text, requested_receiving_facility_id uuid, requested_printed_name text,
    requested_printed_town text, requested_department_code text, requested_service_wanted text,
    requested_urgency text, requested_reason text, requested_letter_text text, requested_diagnosis_ids uuid[],
    requested_prescription_ids uuid[], requested_allergy_ids uuid[], requested_vital_ids uuid[],
    requested_lab_result_ids uuid[], requested_attestation_version text, requested_patient_agreed boolean,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, referral jsonb, package jsonb)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    limits record;
    key_state record;
    is_health_id boolean := requested_destination_kind = 'health_id';
    patient_row identity.patients%rowtype;
    visit_row ehr.encounters%rowtype;
    receiving_row identity.facilities%rowtype;
    items jsonb;
    refusal text;
    sender_name text;
    licence_body text;
    licence_number text;
    now_value timestamptz := clock_timestamp();
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    new_id uuid := pg_catalog.gen_random_uuid();
    age_years integer;
    item_count integer;
    counts jsonb;
    audit_patient uuid;
    details jsonb;
  begin
    select * into caller from ehr.referral_caller('ehr.referral.send');
    if not auth.membership_has_permission(caller.actor_subject, caller.actor_membership, caller.actor_facility,
             'ehr.encounter.write') then
      raise exception using errcode = '42501', message = 'REFERRAL_NOT_ALLOWED';
    end if;
    if requested_patient_id is null or requested_encounter_id is null or requested_destination_kind is null
       or requested_destination_kind not in ('health_id', 'printed')
       or (is_health_id and (requested_receiving_facility_id is null or requested_printed_name is not null
                             or requested_printed_town is not null))
       or (not is_health_id and (requested_receiving_facility_id is not null or requested_printed_name is null))
       or requested_department_code is null or not requested_department_code = any (identity.facility_department_codes())
       or requested_urgency is null or requested_urgency not in ('routine', 'urgent')
       or requested_reason is null or requested_letter_text is null or requested_attestation_version is null
       or requested_patient_agreed is null then
      raise exception using errcode = '22023', message = 'REFERRAL_INVALID';
    end if;
    details := jsonb_build_object('destinationKind', requested_destination_kind, 'urgency', requested_urgency,
      'departmentCode', requested_department_code);

    -- A replay answers the first answer; another body with the key is refused.
    select * into key_state
      from ehr.referral_idempotency(caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind in ('sent', 'printed') then
      return query
        select key_state.kind, true, card.card, ehr.referral_package(key_state.referral_id)
          from ehr.referral_cards(array[key_state.referral_id], caller.actor_facility, true, ehr.referral_control_on()) card;
      return;
    end if;

    begin
      if key_state.state <> 'new' then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:key_reused';
      end if;
      if requested_patient_agreed is not true then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:attestation_required';
      end if;
      if is_health_id and not ehr.referral_control_on() then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:control_off';
      end if;
      if not ehr.context_allows(requested_patient_id, caller.actor_facility, 'read_records')
         or not ehr.context_allows(requested_patient_id, caller.actor_facility, 'write_records') then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:consent_required';
      end if;
      -- The visit: this patient's, here; in progress or completed, not imported paper records, with a signed or
      -- amended note.
      select encounter.* into visit_row from ehr.encounters encounter where encounter.id = requested_encounter_id;
      if visit_row.id is null or visit_row.patient_id <> requested_patient_id
         or visit_row.facility_id <> caller.actor_facility then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:visit_invalid';
      end if;
      if visit_row.status not in ('in_progress', 'completed') or visit_row.imported_paper_records
         or not exists (select 1 from ehr.clinical_notes note
                         where note.encounter_id = visit_row.id and note.patient_id = visit_row.patient_id
                           and note.facility_id = visit_row.facility_id and note.status in ('signed', 'amended')) then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:visit_not_signed';
      end if;
      -- The patient: active, not an unknown record (ID-7), and the facility's seal allows them.
      select patient.* into patient_row from identity.patients patient where patient.id = requested_patient_id;
      if patient_row.id is null
         or identity.sealed_demo_facility(caller.actor_facility) <> identity.sealed_demo_patient(patient_row.id)
         or identity.sealed_qa_facility(caller.actor_facility) <> identity.sealed_qa_patient(patient_row.id) then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:visit_invalid';
      end if;
      if patient_row.status <> 'active'
         or exists (select 1 from identity.unknown_patients unknown_record
                     where unknown_record.patient_id = patient_row.id
                       and unknown_record.status in ('open', 'sent_for_review')) then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:patient_not_identified';
      end if;
      if requested_attestation_version is distinct from (
           select text_row.version from ehr.referral_attestation_texts text_row
            where text_row.destination_kind = requested_destination_kind
            order by text_row.created_at desc, text_row.version desc limit 1) then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:attestation_outdated';
      end if;
      select * into limits from ehr.referral_limits();
      if is_health_id then
        -- Q-REF-7 A: the patient's active account, so the patient is told and can withdraw.
        if not exists (select 1 from auth.accounts account
                        where account.id = patient_row.account_id and account.status = 'active') then
          raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:patient_app_required';
        end if;
        if identity.patient_denies_order_route(patient_row.id, requested_receiving_facility_id) then
          raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:patient_denied';
        end if;
        select facility.* into receiving_row from identity.facilities facility
         where facility.id = requested_receiving_facility_id;
        perform identity.lock_self_service_application(caller.actor_organization);
        if receiving_row.id is not null then
          perform identity.lock_self_service_application(receiving_row.organization_id);
        end if;
        if receiving_row.id is null or receiving_row.id = caller.actor_facility
           or identity.sealed_demo_facility(receiving_row.id) <> identity.sealed_demo_facility(caller.actor_facility)
           or identity.sealed_qa_facility(receiving_row.id) <> identity.sealed_qa_facility(caller.actor_facility)
           or not identity.referral_destination_eligible(receiving_row.id) then
          raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:destination_unavailable';
        end if;
        perform pg_advisory_xact_lock(hashtextextended('referral-destination:' || receiving_row.id::text, 0));
        if (select count(*) from ehr.referrals waiting
             where waiting.receiving_facility_id = receiving_row.id and waiting.state = 'sent'
               and waiting.respond_by > now_value) >= limits.waiting_per_destination then
          raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:destination_busy';
        end if;
      end if;
      -- The limits, serialized per sender and then per visit.
      perform pg_advisory_xact_lock(hashtextextended('referral-sender:' || caller.actor_membership::text, 0));
      if (select count(*) from ehr.referrals sent
           where sent.sent_by_membership_id = caller.actor_membership
             and sent.sent_at >= (today::timestamp at time zone 'Africa/Lagos')) >= limits.sends_per_member_per_day then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:send_limited';
      end if;
      perform pg_advisory_xact_lock(hashtextextended('referral-visit:' || visit_row.id::text, 0));
      if (select count(*) from ehr.referrals sent where sent.source_encounter_id = visit_row.id)
         >= limits.referrals_per_visit then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:visit_limit';
      end if;
      -- Each package item, built from the source rows under the clinician's own access.
      items := ehr.referral_freeze_package(patient_row.id, caller.actor_facility, requested_diagnosis_ids,
        requested_prescription_ids, requested_allergy_ids, requested_vital_ids, requested_lab_result_ids);
      if items is null then
        raise exception using errcode = 'P0001', message = 'REFERRAL_REFUSED:package_invalid';
      end if;
      item_count := jsonb_array_length(items);

      -- The referrer as frozen: the sender's name and the newest MDCN licence attestation of the sender's doctor
      -- role here whose grant is in force, else none ("Licence not on record").
      select left(btrim(coalesce(nullif(btrim(staff.full_name), ''), account.display_name)), 200) into sender_name
        from auth.accounts account
        left join identity.staff staff on staff.account_id = account.id
       where account.id = caller.actor_account;
      if coalesce(length(sender_name), 0) < 2 then
        raise exception using errcode = '22023', message = 'REFERRAL_INVALID';
      end if;
      select attestation.licence_body, btrim(attestation.licence_number) into licence_body, licence_number
        from identity.staff_licence_attestations attestation
        join auth.account_roles role_grant on role_grant.id = attestation.role_grant_id
         and role_grant.revoked_at is null
       where attestation.membership_id = caller.actor_membership and attestation.role_code = 'doctor'
         and attestation.licence_body = 'MDCN'
       order by attestation.recorded_at desc, attestation.id desc
       limit 1;
      age_years := case when patient_row.dob is not null and patient_row.dob <= today
                        then extract(year from age(today, patient_row.dob))::integer end;

      insert into ehr.referrals (id, patient_id, referring_organization_id, referring_facility_id,
        source_encounter_id, sent_by_membership_id, sent_by_account_id, referrer_name, referrer_licence_body,
        referrer_licence_number, destination_kind, receiving_organization_id, receiving_facility_id,
        printed_facility_name, printed_facility_town, department_code, service_wanted, urgency, reason, letter_text,
        patient_sex_at_send, patient_age_years_at_send, package_item_count, patient_agreement,
        attestation_text_version, attested_receiving_facility_name, state, sent_at, respond_by, correlation_id,
        updated_at)
      values (new_id, patient_row.id, caller.actor_organization, caller.actor_facility, visit_row.id,
        caller.actor_membership, caller.actor_account, sender_name, licence_body,
        case when licence_body is not null then licence_number end,
        requested_destination_kind, receiving_row.organization_id, receiving_row.id,
        case when not is_health_id then btrim(requested_printed_name) end,
        case when not is_health_id then nullif(btrim(coalesce(requested_printed_town, '')), '') end,
        requested_department_code, nullif(btrim(coalesce(requested_service_wanted, '')), ''), requested_urgency,
        btrim(requested_reason), requested_letter_text, left(patient_row.gender, 40),
        case when age_years between 0 and 130 then age_years end, item_count, 'clinician_attested',
        requested_attestation_version,
        left(btrim(coalesce(receiving_row.name, requested_printed_name)), 200),
        case when is_health_id then 'sent' else 'printed' end, now_value,
        case when is_health_id then now_value + make_interval(hours =>
          case requested_urgency when 'urgent' then limits.urgent_hours else limits.routine_hours end) end,
        caller.actor_correlation, now_value);
      insert into ehr.referral_events (referral_id, event_version, kind, side, by_membership_id, by_account_id,
        state_after, idempotency_key, request_sha256, correlation_id, at)
      values (new_id, 1, case when is_health_id then 'sent' else 'printed' end, 'referring', caller.actor_membership,
        caller.actor_account, case when is_health_id then 'sent' else 'printed' end, requested_idempotency_key,
        requested_request_sha256, caller.actor_correlation, now_value);
      insert into ehr.referral_package_items (referral_id, position, item_kind, source_id, source_version,
        source_encounter_id, content)
      select new_id, (listed.ord - 1)::smallint, listed.item ->> 'kind', (listed.item ->> 'sourceId')::uuid,
             (listed.item ->> 'sourceVersion')::bigint, (listed.item ->> 'sourceEncounterId')::uuid,
             listed.item -> 'content'
        from jsonb_array_elements(items) with ordinality listed(item, ord);
      if (select count(*) from ehr.referral_package_items item where item.referral_id = new_id) <> item_count then
        raise exception using errcode = '55000', message = 'REFERRAL_PACKAGE_CLOSED';
      end if;
      perform ehr.referral_notify_patient(new_id, 'REFERRAL_SENT');
    exception when raise_exception then
      if sqlerrm like 'REFERRAL\_REFUSED:%' then
        refusal := substr(sqlerrm, length('REFERRAL_REFUSED:') + 1);
      else
        raise;
      end if;
    end;

    if refusal is not null then
      select patient.id into audit_patient from identity.patients patient where patient.id = requested_patient_id;
      perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        audit_patient, 'ehr.referral.send', 'denied', null, details || jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb, null::jsonb;
      return;
    end if;

    select coalesce(jsonb_object_agg(counted.kind_name, counted.item_count), '{}'::jsonb) into counts
      from (select listed.item ->> 'kind' as kind_name, count(*) as item_count
              from jsonb_array_elements(items) listed(item) group by listed.item ->> 'kind') counted;
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      patient_row.id, 'ehr.referral.send', 'success', new_id::text,
      details || jsonb_build_object('packageCounts', counts,
        'outcome', case when is_health_id then 'sent' else 'printed' end));
    return query
      select case when is_health_id then 'sent' else 'printed' end, false, card.card, ehr.referral_package(new_id)
        from ehr.referral_cards(array[new_id], caller.actor_facility, true, ehr.referral_control_on()) card;
  end
  $fn$;
  comment on function ehr.referral_send(uuid, uuid, text, uuid, text, text, text, text, text, text, text, uuid[],
    uuid[], uuid[], uuid[], uuid[], text, boolean, text, text) is
    '0191 (REF-1 route 2): send a referral from a signed visit to a facility on Health ID listed for referrals, or record a printed letter. Needs ehr.referral.send and ehr.encounter.write here, direct care, and the patient''s read and write access. Outcomes sent, printed or a refusal (key_reused, attestation_required, control_off, consent_required, visit_invalid, visit_not_signed, patient_not_identified, attestation_outdated, patient_app_required, patient_denied, destination_unavailable, destination_busy, send_limited, visit_limit, package_invalid), each audited (ehr.referral.send).';

  -- Route 3: this facility's sent referrals, sent in the last 90 days, newest first, without reason or notes.
  create function ehr.referral_sent_list(requested_states text[], requested_limit integer, requested_cursor text)
  returns table (ord bigint, card jsonb, next_cursor text)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    limits record;
    page_size integer := coalesce(requested_limit, 50);
    cursor_at timestamptz;
    cursor_id uuid;
    found_ids uuid[];
    shown_ids uuid[];
    more boolean;
    last_cursor text;
  begin
    select * into caller from ehr.referral_caller('ehr.referral.read');
    select * into limits from ehr.referral_limits();
    if page_size not between 1 and 200
       or exists (select 1 from unnest(coalesce(requested_states, '{}')) listed(state)
                   where listed.state is null or listed.state not in ('sent', 'printed', 'accepted', 'arrived',
                     'completed', 'declined', 'withdrawn', 'expired'))
       or (requested_cursor is not null and requested_cursor !~ '^[0-9]{1,20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception using errcode = '22023', message = 'REFERRAL_INVALID';
    end if;
    if requested_cursor is not null then
      cursor_at := to_timestamp(split_part(requested_cursor, ':', 1)::numeric / 1000000);
      cursor_id := split_part(requested_cursor, ':', 2)::uuid;
    end if;
    select array_agg(listed.id order by listed.sent_at desc, listed.id desc) into found_ids
      from (select referral.id, referral.sent_at
              from ehr.referrals referral
              cross join lateral ehr.referral_effective(referral) effective
             where referral.referring_facility_id = caller.actor_facility
               and referral.sent_at >= clock_timestamp() - make_interval(days => limits.list_days)
               and (cursor_at is null or (referral.sent_at, referral.id) < (cursor_at, cursor_id))
               and (cardinality(coalesce(requested_states, '{}')) = 0
                    or effective.effective_state = any (requested_states))
             order by referral.sent_at desc, referral.id desc
             limit page_size + 1) listed;
    more := coalesce(cardinality(found_ids), 0) > page_size;
    shown_ids := coalesce(found_ids[1:page_size], '{}');
    if more then
      select (floor(extract(epoch from referral.sent_at) * 1000000))::bigint::text || ':' || referral.id::text
        into last_cursor from ehr.referrals referral where referral.id = shown_ids[page_size];
    end if;
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
      'ehr.referral.sent-list', 'success', null, jsonb_build_object('resultCount', cardinality(shown_ids),
        'states', coalesce(to_jsonb(requested_states), '[]'::jsonb)));
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      grouped.patient_id, 'ehr.referral.sent-list.shown', 'success', null,
      jsonb_build_object('referralIds', grouped.referral_ids))
      from (select referral.patient_id, jsonb_agg(referral.id order by referral.id) as referral_ids
              from ehr.referrals referral where referral.id = any (shown_ids)
             group by referral.patient_id) grouped;
    return query
      select card.ord, card.card, last_cursor
        from ehr.referral_cards(shown_ids, caller.actor_facility, false, ehr.referral_control_on()) card
       order by card.ord;
  end
  $fn$;
  comment on function ehr.referral_sent_list(text[], integer, text) is
    '0191 (REF-1 route 3): this facility''s referrals sent in the last 90 days, newest first, by effective state, at most limit (1-200) with a cursor; cards without the reason or notes. Needs ehr.referral.read here, direct care. Audited (ehr.referral.sent-list, and .shown per patient).';

  -- Route 4: the referring facility withdraws a referral before acceptance (or a printed letter).
  create function ehr.referral_withdraw(requested_referral_id uuid, requested_expected_version bigint,
    requested_reason_code text, requested_note text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, referral jsonb)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    found_referral ehr.referrals%rowtype;
    effective record;
    refusal text;
    note_value text := nullif(btrim(coalesce(requested_note, '')), '');
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.referral_caller('ehr.referral.send');
    if requested_referral_id is null or requested_expected_version is null or requested_reason_code is null
       or requested_reason_code not in ('patient_changed_mind', 'no_longer_needed', 'sent_in_error', 'other') then
      raise exception using errcode = '22023', message = 'REFERRAL_INVALID';
    end if;
    select * into key_state
      from ehr.referral_idempotency(caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'withdrawn' and key_state.referral_id = requested_referral_id then
      return query select 'withdrawn', true, card.card
        from ehr.referral_cards(array[requested_referral_id], caller.actor_facility, true, ehr.referral_control_on()) card;
      return;
    end if;
    select referral.* into found_referral from ehr.referrals referral
     where referral.id = requested_referral_id and referral.referring_facility_id = caller.actor_facility
     for update;
    if found_referral.id is null then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    else
      select * into effective from ehr.referral_effective(found_referral);
      if found_referral.row_version <> requested_expected_version then
        refusal := 'changed';
      elsif effective.visit_in_error or found_referral.state in ('declined', 'withdrawn', 'completed') then
        refusal := 'closed';
      elsif found_referral.state in ('accepted', 'arrived') then
        refusal := 'not_pending';
      elsif effective.effective_state = 'expired' then
        refusal := 'expired';
      elsif (requested_reason_code in ('sent_in_error', 'other') and note_value is null)
            or (note_value is not null and (length(note_value) not between 8 and 500
                                            or translate(note_value, E'\n\r', '') ~ '[[:cntrl:]]')) then
        refusal := 'reason_required';
      end if;
    end if;
    if refusal is not null then
      perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        found_referral.patient_id, 'ehr.referral.withdraw', 'denied', requested_referral_id::text,
        jsonb_build_object('refusal', refusal, 'reasonCode', requested_reason_code));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    insert into ehr.referral_events (referral_id, event_version, kind, side, by_membership_id, by_account_id,
      reason_code, state_after, idempotency_key, request_sha256, correlation_id, at)
    values (found_referral.id, (select coalesce(max(event.event_version), 0) + 1 from ehr.referral_events event
                                 where event.referral_id = found_referral.id),
      'withdrawn', 'referring', caller.actor_membership, caller.actor_account, requested_reason_code, 'withdrawn',
      requested_idempotency_key, requested_request_sha256, caller.actor_correlation, now_value);
    update ehr.referrals referral
       set state = 'withdrawn', withdrawn_at = now_value, withdrawn_by = 'referring_facility',
           withdrawn_by_membership_id = caller.actor_membership, withdrawn_by_account_id = caller.actor_account,
           withdraw_reason_code = requested_reason_code, withdraw_note = note_value, updated_at = now_value,
           row_version = referral.row_version + 1
     where referral.id = found_referral.id;
    perform ehr.referral_notify_patient(found_referral.id, 'REFERRAL_WITHDRAWN');
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      found_referral.patient_id, 'ehr.referral.withdraw', 'success', found_referral.id::text,
      jsonb_build_object('reasonCode', requested_reason_code, 'stateBefore', found_referral.state,
        'destinationKind', found_referral.destination_kind));
    return query select 'withdrawn', false, card.card
      from ehr.referral_cards(array[found_referral.id], caller.actor_facility, true, ehr.referral_control_on()) card;
  end
  $fn$;
  comment on function ehr.referral_withdraw(uuid, bigint, text, text, text, text) is
    '0191 (REF-1 route 4): the referring facility withdraws a referral while sent (before respond_by) or a printed letter, with a reason code (a note of 8-500 for sent_in_error and other). Needs ehr.referral.send here, direct care. Outcomes withdrawn, not_found, key_reused, changed, closed, not_pending, expired, reason_required; audited (ehr.referral.withdraw).';

  -- Route 5: the printable letter, one print per call (audited); never the Health ID.
  create function ehr.referral_letter(requested_referral_id uuid)
  returns table (outcome text, referral jsonb, package jsonb, letter jsonb)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    found_referral ehr.referrals%rowtype;
    effective record;
    refusal text;
    address text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.referral_caller('ehr.referral.send');
    select referral.* into found_referral from ehr.referrals referral
     where referral.id = requested_referral_id and referral.referring_facility_id = caller.actor_facility;
    if found_referral.id is null then
      refusal := 'not_found';
    elsif found_referral.sent_by_membership_id <> caller.actor_membership
          and not ehr.context_allows(found_referral.patient_id, caller.actor_facility, 'read_records') then
      refusal := 'consent_required';
    else
      select * into effective from ehr.referral_effective(found_referral);
      if effective.effective_state = 'withdrawn' then
        refusal := 'closed';
      end if;
    end if;
    if refusal is not null then
      perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        found_referral.patient_id, 'ehr.referral.letter-print', 'denied', requested_referral_id::text,
        jsonb_build_object('refusal', refusal));
      return query select refusal, null::jsonb, null::jsonb, null::jsonb;
      return;
    end if;
    address := coalesce(identity.order_route_registered_address(caller.actor_facility),
      (select nullif(concat_ws(', ', nullif(btrim(profile.address_line), ''), nullif(btrim(profile.city), '')), '')
         from identity.facility_profiles profile where profile.facility_id = caller.actor_facility
        order by profile.created_at desc, profile.id desc limit 1));
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      found_referral.patient_id, 'ehr.referral.letter-print', 'success', found_referral.id::text,
      jsonb_build_object('destinationKind', found_referral.destination_kind,
        'patientCopy', found_referral.destination_kind = 'health_id'));
    return query
      select 'found', card.card, ehr.referral_package(found_referral.id),
             jsonb_build_object('referringFacilityAddress', address, 'printedAt', ehr.referral_instant(now_value))
        from ehr.referral_cards(array[found_referral.id], caller.actor_facility, true, ehr.referral_control_on()) card;
  end
  $fn$;
  comment on function ehr.referral_letter(uuid) is
    '0191 (REF-1 route 5): the printable letter of a referral sent from here, any state but withdrawn, to the sender or a member with the patient''s read access; each call is one print (audited, ehr.referral.letter-print). Needs ehr.referral.send here, direct care.';

  -- Route 6: the directory of facilities on Health ID that may receive a referral now (identity-api).
  create function identity.search_referral_destinations(requested_query text)
  returns table (facility_id uuid, facility_name text, organization_name text, registered_address text,
    new_on_health_id boolean, departments text[])
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    pattern text;
    candidate record;
    found_count integer := 0;
  begin
    select * into actor from ehr.order_route_staff_actor(false);
    if not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
             'ehr.referral.send') then
      raise exception using errcode = '42501', message = 'REFERRAL_NOT_ALLOWED';
    end if;
    perform platform.require_control_enabled('cross_facility_referrals_enabled');
    if not coalesce(length(btrim(requested_query)) between 3 and 80, false) then
      raise exception using errcode = '22023', message = 'ORDER_DESTINATION_QUERY_INVALID';
    end if;
    pattern := '%' || replace(replace(replace(btrim(requested_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    for candidate in
      select facility.id, facility.name, facility.organization_id, organization.name as organization_name
        from identity.facilities facility
        join identity.organizations organization on organization.id = facility.organization_id
       where facility.id <> actor.actor_facility_id
         and facility.active and organization.active
         and identity.sealed_demo_facility(facility.id) = identity.sealed_demo_facility(actor.actor_facility_id)
         and identity.sealed_qa_facility(facility.id) = identity.sealed_qa_facility(actor.actor_facility_id)
         and (facility.name ilike pattern escape '\' or organization.name ilike pattern escape '\')
         and exists (select 1 from identity.organization_products product
                       join identity.organization_applications source_application
                         on source_application.id = product.source_application_id
                      where product.facility_id = facility.id and product.status = 'active'
                        and source_application.organization_type in ('hospital', 'clinic'))
       order by facility.name, facility.id
       limit 200
    loop
      perform identity.lock_self_service_application(candidate.organization_id);
      if identity.referral_destination_eligible(candidate.id) then
        found_count := found_count + 1;
        return query select candidate.id, candidate.name, candidate.organization_name,
          identity.order_route_registered_address(candidate.id), identity.self_service_on_probation(candidate.id),
          coalesce((select profile.departments from identity.facility_profiles profile
                     where profile.facility_id = candidate.id
                     order by profile.created_at desc, profile.id desc limit 1), '{}'::text[]);
        exit when found_count >= 10;
      end if;
    end loop;
  end
  $fn$;
  comment on function identity.search_referral_destinations(text) is
    '0191 (REF-1 route 6): at most 10 facilities on Health ID that may receive a referral now (active, verified, reviewed or governed, a hospital or clinic, listed for referrals, with a member holding ehr.referral.receive, the same seal as the session facility, not it), whose facility or organization name holds the query (3-80), with the newest profile''s department codes. Needs ehr.referral.send and the control cross_facility_referrals_enabled. 0086''s identity.search_order_destinations is not replaced.';

  -- Route 18: support finds referrals by reference (8 characters) or by a patient's Health ID (the POST body). No
  -- patient name, reason, letter, package or note.
  create function identity.admin_find_referrals(requested_reference text, requested_health_id text)
  returns table (referral_id uuid, reference text, destination_kind text, referring_facility_id uuid,
    referring_facility_name text, receiving_facility_id uuid, receiving_facility_name text, state text,
    effective_state text, urgency text, sent_at timestamptz, respond_by timestamptz, accepted_at timestamptz,
    arrived_at timestamptz, completed_at timestamptz, ended_at timestamptz, ended_kind text,
    access_ends_at timestamptz)
  language plpgsql stable security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    wanted_reference text := upper(btrim(requested_reference));
    wanted_patient uuid;
  begin
    perform identity.order_route_platform_actor(array['platform.principal.read']);
    if (requested_reference is null) = (requested_health_id is null)
       or (requested_reference is not null and not coalesce(wanted_reference ~ '^[0-9A-F]{8}$', false))
       or (requested_health_id is not null and ehr.order_route_health_id(requested_health_id) is null) then
      raise exception using errcode = '22023', message = 'REFERRAL_LOOKUP_INVALID';
    end if;
    if requested_health_id is not null then
      select patient.id into wanted_patient from identity.patients patient
       where patient.hid_code = ehr.order_route_health_id(requested_health_id);
      if wanted_patient is null then
        return;
      end if;
    end if;
    return query
      select referral.id, referral.reference::text, referral.destination_kind, referral.referring_facility_id,
             referring.name, referral.receiving_facility_id, receiving.name, referral.state, effective.effective_state,
             referral.urgency, referral.sent_at, referral.respond_by, referral.accepted_at, referral.arrived_at,
             referral.completed_at, effective.ended_at, effective.ended_kind, referral.access_ends_at
        from ehr.referrals referral
        cross join lateral ehr.referral_effective(referral) effective
        join identity.facilities referring on referring.id = referral.referring_facility_id
        left join identity.facilities receiving on receiving.id = referral.receiving_facility_id
       where (requested_reference is not null and referral.reference = wanted_reference)
          or (wanted_patient is not null and referral.patient_id = wanted_patient)
       order by referral.sent_at desc, referral.id desc
       limit 50;
  end
  $fn$;
  comment on function identity.admin_find_referrals(text, text) is
    '0191 (REF-1 route 18): support''s lookup of referrals by reference or by a patient''s Health ID, at most 50, newest first: ids, facilities, states and dates only. Needs platform.admin.access and platform.principal.read (healthcare operations).';

  -- Route 19: whether a facility is listed for referrals, and whether the directory would find it now.
  create function identity.admin_referral_destination(target_facility_id uuid)
  returns table (facility_id uuid, listed boolean, by_default boolean, reason text, set_at timestamptz,
    eligible_now boolean)
  language plpgsql stable security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    facility_row identity.facilities%rowtype;
    setting record;
  begin
    perform identity.order_route_platform_actor(array['platform.facility.read']);
    select facility.* into facility_row from identity.facilities facility where facility.id = target_facility_id;
    if facility_row.id is null
       or not exists (select 1 from identity.organization_applications application
                       where application.organization_id = facility_row.organization_id
                         and application.organization_type in ('hospital', 'clinic')) then
      raise exception using errcode = 'P0002', message = 'REFERRAL_DESTINATION_NOT_FOUND';
    end if;
    select found.listed, found.reason, found.set_at into setting
      from identity.referral_destination_settings found
     where found.facility_id = facility_row.id
     order by found.set_at desc, found.id desc limit 1;
    return query select facility_row.id, identity.referral_destination_listed(facility_row.id), setting.listed is null,
      setting.reason, setting.set_at, identity.referral_destination_eligible(facility_row.id);
  end
  $fn$;
  comment on function identity.admin_referral_destination(uuid) is
    '0191 (REF-1 route 19): a hospital''s or clinic''s listing for referrals (the newest setting, or 0086 H3''s default) and whether the directory would find it now. Needs platform.admin.access and platform.facility.read.';

  -- Route 20: support lists or unlists a hospital or clinic for referrals. Referrals already sent there can still be
  -- answered until respond_by.
  create function identity.admin_set_referral_destination(target_facility_id uuid, requested_listed boolean,
    set_reason text)
  returns table (facility_id uuid, listed boolean, by_default boolean, reason text, set_at timestamptz,
    eligible_now boolean)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor_account uuid := identity.order_route_platform_actor(array['platform.facility.manage',
      'platform.facility.unlock']);
    reason_value text := btrim(coalesce(set_reason, ''));
    facility_row identity.facilities%rowtype;
    inserted identity.referral_destination_settings%rowtype;
  begin
    if target_facility_id is null or requested_listed is null or length(reason_value) not between 8 and 500 then
      raise exception using errcode = '22023', message = 'REFERRAL_DESTINATION_INVALID';
    end if;
    select facility.* into facility_row from identity.facilities facility where facility.id = target_facility_id;
    if facility_row.id is null
       or not exists (select 1 from identity.organization_applications application
                       where application.organization_id = facility_row.organization_id
                         and application.organization_type in ('hospital', 'clinic')) then
      raise exception using errcode = 'P0002', message = 'REFERRAL_DESTINATION_NOT_FOUND';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('referral-destination-setting:' || facility_row.id::text, 0));
    if identity.referral_destination_listed(facility_row.id) = requested_listed then
      raise exception using errcode = '23505', message = 'REFERRAL_DESTINATION_UNCHANGED';
    end if;
    insert into identity.referral_destination_settings as setting (facility_id, organization_id, listed, reason,
      set_by_account_id, correlation_id)
    values (facility_row.id, facility_row.organization_id, requested_listed, reason_value, actor_account,
      platform.current_correlation_id())
    returning setting.* into inserted;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
      resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details)
    values (platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
      'admin.referral-destination.set', 'success', 'facility', facility_row.id::text, 'healthcare-operations',
      reason_value, 'application', 'identity-api',
      jsonb_build_object('facilityId', facility_row.id, 'listed', requested_listed, 'settingId', inserted.id));
    insert into audit.events (correlation_id, actor_type, organization_id, facility_id, action, outcome,
      resource_type, resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'system', facility_row.organization_id, facility_row.id,
      'identity.referral-destination.set', 'success', 'facility', facility_row.id::text, 'healthcare-operations',
      'application', 'identity-api', jsonb_build_object('listed', requested_listed, 'settingId', inserted.id));
    return query select facility_row.id, inserted.listed, false, inserted.reason, inserted.set_at,
      identity.referral_destination_eligible(facility_row.id);
  end
  $fn$;
  comment on function identity.admin_set_referral_destination(uuid, boolean, text) is
    '0191 (REF-1 route 20): support lists or unlists a hospital or clinic for referrals, with a reason (8-500); audited as the platform command (admin.referral-destination.set) and at the facility (identity.referral-destination.set). Needs platform.admin.access, platform.facility.manage and platform.facility.unlock.';

  -- Triggers.
  create trigger referral_attestation_texts_append_only before update or delete on ehr.referral_attestation_texts
    for each row execute function platform.reject_mutation();
  create trigger referral_attestation_texts_no_truncate before truncate on ehr.referral_attestation_texts
    for each statement execute function platform.reject_mutation();
  create trigger referrals_guard before update on ehr.referrals
    for each row execute function ehr.referral_guard();
  create trigger referrals_no_delete before delete on ehr.referrals
    for each row execute function platform.reject_mutation();
  create trigger referrals_no_truncate before truncate on ehr.referrals
    for each statement execute function platform.reject_mutation();
  create trigger referral_events_append_only before update or delete on ehr.referral_events
    for each row execute function platform.reject_mutation();
  create trigger referral_events_no_truncate before truncate on ehr.referral_events
    for each statement execute function platform.reject_mutation();
  create trigger referral_package_items_append_only before update or delete on ehr.referral_package_items
    for each row execute function platform.reject_mutation();
  create trigger referral_package_items_no_truncate before truncate on ehr.referral_package_items
    for each statement execute function platform.reject_mutation();
  create trigger referral_package_items_closed before insert on ehr.referral_package_items
    for each row execute function ehr.referral_package_item_guard();
  create trigger referral_source_marks_append_only before update or delete on ehr.referral_source_marks
    for each row execute function platform.reject_mutation();
  create trigger referral_source_marks_no_truncate before truncate on ehr.referral_source_marks
    for each statement execute function platform.reject_mutation();
  create trigger referral_destination_settings_append_only before update or delete
    on identity.referral_destination_settings
    for each row execute function platform.reject_mutation();
  create trigger referral_destination_settings_no_truncate before truncate on identity.referral_destination_settings
    for each statement execute function platform.reject_mutation();
  create trigger referral_marks_diagnosis after update of verification_status on ehr.diagnoses
    for each row when (new.verification_status = 'entered_in_error'
                       and old.verification_status is distinct from 'entered_in_error')
    execute function ehr.referral_source_marked('diagnosis');
  create trigger referral_marks_vital after update of status on ehr.vitals
    for each row when (new.status = 'entered_in_error' and old.status is distinct from 'entered_in_error')
    execute function ehr.referral_source_marked('vital');
  create trigger referral_marks_allergy after update of status on ehr.recorded_allergies
    for each row when (new.status = 'entered_in_error' and old.status is distinct from 'entered_in_error')
    execute function ehr.referral_source_marked('allergy');
  create trigger referral_marks_lab_result after insert on lab.result_invalidations
    for each row execute function ehr.referral_source_marked('lab_result');

  -- Owners, PUBLIC's EXECUTE taken away, and EXECUTE for the named runtimes only.
  if v_owner <> current_user then
    foreach v_name in array v_tables loop
      execute format('alter table %s owner to %I', v_name, v_owner);
    end loop;
  end if;
  for v_name in
    select proc.oid::regprocedure::text from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
     where v_bodies ? (namespace.nspname || '.' || proc.proname)
        or (namespace.nspname || '.' || proc.proname) in (
          'ehr.referral_limits', 'ehr.referral_instant', 'ehr.referral_caller', 'ehr.referral_control_on',
          'ehr.referral_effective', 'ehr.referral_cards', 'ehr.referral_package', 'ehr.referral_history',
          'ehr.referral_freeze_package', 'lab.referral_result_snapshots', 'ehr.referral_audit',
          'ehr.referral_idempotency', 'ehr.referral_notify_patient', 'ehr.referral_guard',
          'ehr.referral_package_item_guard', 'ehr.referral_source_marked', 'identity.referral_destination_listed',
          'identity.referral_destination_eligible', 'ehr.referral_attestation_text', 'ehr.referral_send',
          'ehr.referral_sent_list', 'ehr.referral_withdraw', 'ehr.referral_letter',
          'identity.search_referral_destinations', 'identity.admin_find_referrals',
          'identity.admin_referral_destination', 'identity.admin_set_referral_destination')
  loop
    execute format('revoke all on function %s from public', v_name);
    if v_owner <> current_user then
      execute format('alter function %s owner to %I', v_name, v_owner);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = v_runtime_ehr) then
    grant execute on function
      ehr.referral_attestation_text(text),
      ehr.referral_send(uuid, uuid, text, uuid, text, text, text, text, text, text, text, uuid[], uuid[], uuid[],
        uuid[], uuid[], text, boolean, text, text),
      ehr.referral_sent_list(text[], integer, text),
      ehr.referral_withdraw(uuid, bigint, text, text, text, text),
      ehr.referral_letter(uuid)
      to hid_ehr_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = v_runtime_identity) then
    grant execute on function
      identity.search_referral_destinations(text),
      identity.admin_find_referrals(text, text),
      identity.admin_referral_destination(uuid),
      identity.admin_set_referral_destination(uuid, boolean, text)
      to hid_identity_runtime;
  end if;

  -- 3. Post-checks.
  -- The tables: owner, row-level security enabled and forced, four owner-only permissive policies, no grant.
  if (select count(*) from pg_class relation
       where relation.oid = any (select to_regclass(listed.name) from unnest(v_tables) listed(name))
         and pg_get_userbyid(relation.relowner) = v_owner and relation.relrowsecurity and relation.relforcerowsecurity)
     <> cardinality(v_tables)
     or exists (select 1 from pg_class relation,
                  lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 where relation.oid = any (select to_regclass(listed.name) from unnest(v_tables) listed(name))
                   and acl.grantee <> relation.relowner)
     or (select count(*) from pg_policy policy join pg_class relation on relation.oid = policy.polrelid
          where relation.oid = any (select to_regclass(listed.name) from unnest(v_tables) listed(name))
            and policy.polpermissive and policy.polroles = array[relation.relowner]
            and pg_get_expr(policy.polqual, policy.polrelid) is not distinct from
                case when policy.polcmd = 'a' then null else 'true' end
            and pg_get_expr(policy.polwithcheck, policy.polrelid) is not distinct from
                case when policy.polcmd in ('a', 'w') then 'true' end) <> 4 * cardinality(v_tables)
     or (select count(*) from pg_policy policy
          where policy.polrelid = any (select to_regclass(listed.name) from unnest(v_tables) listed(name)))
        <> 4 * cardinality(v_tables) then
    raise exception using errcode = '55000',
      message = '0191: post-check failed (a new table''s owner, row-level security, policies or grants)';
  end if;
  -- Every CHECK of the new tables by its definition.
  if (select md5(string_agg(relation.relname || '.' || constraint_row.conname || ':'
                            || pg_get_constraintdef(constraint_row.oid), '|'
                            order by relation.relname, constraint_row.conname))
        from pg_constraint constraint_row join pg_class relation on relation.oid = constraint_row.conrelid
       where relation.oid = any (select to_regclass(listed.name) from unnest(v_tables) listed(name))
         and constraint_row.contype = 'c' and constraint_row.convalidated) is distinct from v_checks_md5 then
    raise exception using errcode = '55000', message = '0191: post-check failed (the new tables'' CHECKs: '
      || (select md5(string_agg(relation.relname || '.' || constraint_row.conname || ':'
                                || pg_get_constraintdef(constraint_row.oid), '|'
                                order by relation.relname, constraint_row.conname))
            from pg_constraint constraint_row join pg_class relation on relation.oid = constraint_row.conrelid
           where relation.oid = any (select to_regclass(listed.name) from unnest(v_tables) listed(name))
             and constraint_row.contype = 'c') || ')';
  end if;
  -- The functions: exactly those made, each body as made, owner, search_path, SECURITY DEFINER for the routes and
  -- the marks trigger only, the volatility, and EXECUTE only for the named runtime of each route.
  select string_agg(namespace.nspname || '.' || proc.proname, ', ' order by namespace.nspname, proc.proname)
    into v_mismatch
    from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
   where v_bodies ? (namespace.nspname || '.' || proc.proname)
     and (md5(proc.prosrc) is distinct from v_bodies ->> (namespace.nspname || '.' || proc.proname)
          or pg_get_userbyid(proc.proowner) <> v_owner
          or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
          or proc.prosecdef <> ((namespace.nspname || '.' || proc.proname) = any (v_definer))
          or proc.provolatile <> case
               when proc.proname in ('referral_limits', 'referral_instant') then 'i'
               when proc.proname in ('referral_send', 'referral_sent_list', 'referral_withdraw', 'referral_letter',
                 'search_referral_destinations', 'admin_set_referral_destination', 'referral_audit',
                 'referral_idempotency', 'referral_notify_patient', 'referral_guard', 'referral_package_item_guard',
                 'referral_source_marked') then 'v'
               else 's' end
          or exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                      where acl.grantee <> proc.proowner
                        and (acl.grantee = 0
                             or not ((namespace.nspname || '.' || proc.proname) = any (v_ehr_routes)
                                     and pg_get_userbyid(acl.grantee) = v_runtime_ehr)
                                and not ((namespace.nspname || '.' || proc.proname) = any (v_identity_routes)
                                         and pg_get_userbyid(acl.grantee) = v_runtime_identity))));
  if v_mismatch is not null
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where v_bodies ? (namespace.nspname || '.' || proc.proname)) <> (select count(*) from jsonb_object_keys(v_bodies))
     or (select count(*) from jsonb_object_keys(v_bodies)) <> 27 then
    raise exception using errcode = '55000', message = '0191: post-check failed (these functions are not as made: '
      || coalesce(v_mismatch, 'the count') || ')';
  end if;
  -- Every trigger: its table, timing and events (tgtype: 1 row, 2 before, 4 insert, 8 delete, 16 update,
  -- 32 truncate), WHEN condition, UPDATE OF columns, arguments, function and that it is enabled.
  select string_agg(expected.trigger_name, ', ' order by expected.trigger_name) into v_mismatch
    from (values
      ('ehr.referral_attestation_texts', 'referral_attestation_texts_append_only', 27, 'platform.reject_mutation()', null, 0),
      ('ehr.referral_attestation_texts', 'referral_attestation_texts_no_truncate', 34, 'platform.reject_mutation()', null, 0),
      ('ehr.referrals', 'referrals_guard', 19, 'ehr.referral_guard()', null, 0),
      ('ehr.referrals', 'referrals_no_delete', 11, 'platform.reject_mutation()', null, 0),
      ('ehr.referrals', 'referrals_no_truncate', 34, 'platform.reject_mutation()', null, 0),
      ('ehr.referral_events', 'referral_events_append_only', 27, 'platform.reject_mutation()', null, 0),
      ('ehr.referral_events', 'referral_events_no_truncate', 34, 'platform.reject_mutation()', null, 0),
      ('ehr.referral_package_items', 'referral_package_items_append_only', 27, 'platform.reject_mutation()', null, 0),
      ('ehr.referral_package_items', 'referral_package_items_no_truncate', 34, 'platform.reject_mutation()', null, 0),
      ('ehr.referral_package_items', 'referral_package_items_closed', 7, 'ehr.referral_package_item_guard()', null, 0),
      ('ehr.referral_source_marks', 'referral_source_marks_append_only', 27, 'platform.reject_mutation()', null, 0),
      ('ehr.referral_source_marks', 'referral_source_marks_no_truncate', 34, 'platform.reject_mutation()', null, 0),
      ('identity.referral_destination_settings', 'referral_destination_settings_append_only', 27,
       'platform.reject_mutation()', null, 0),
      ('identity.referral_destination_settings', 'referral_destination_settings_no_truncate', 34,
       'platform.reject_mutation()', null, 0),
      ('ehr.diagnoses', 'referral_marks_diagnosis', 17, 'ehr.referral_source_marked()',
       'CREATE TRIGGER referral_marks_diagnosis AFTER UPDATE OF verification_status ON ehr.diagnoses FOR EACH ROW WHEN (((new.verification_status = ''entered_in_error''::text) AND (old.verification_status IS DISTINCT FROM ''entered_in_error''::text))) EXECUTE FUNCTION ehr.referral_source_marked(''diagnosis'')', 1),
      ('ehr.vitals', 'referral_marks_vital', 17, 'ehr.referral_source_marked()',
       'CREATE TRIGGER referral_marks_vital AFTER UPDATE OF status ON ehr.vitals FOR EACH ROW WHEN (((new.status = ''entered_in_error''::text) AND (old.status IS DISTINCT FROM ''entered_in_error''::text))) EXECUTE FUNCTION ehr.referral_source_marked(''vital'')', 1),
      ('ehr.recorded_allergies', 'referral_marks_allergy', 17, 'ehr.referral_source_marked()',
       'CREATE TRIGGER referral_marks_allergy AFTER UPDATE OF status ON ehr.recorded_allergies FOR EACH ROW WHEN (((new.status = ''entered_in_error''::text) AND (old.status IS DISTINCT FROM ''entered_in_error''::text))) EXECUTE FUNCTION ehr.referral_source_marked(''allergy'')', 1),
      ('lab.result_invalidations', 'referral_marks_lab_result', 5, 'ehr.referral_source_marked()',
       'CREATE TRIGGER referral_marks_lab_result AFTER INSERT ON lab.result_invalidations FOR EACH ROW EXECUTE FUNCTION ehr.referral_source_marked(''lab_result'')', 1)
    ) expected(relation, trigger_name, trigger_type, function_signature, definition, argument_count)
   where not exists (
     select 1 from pg_trigger trigger_row
      where trigger_row.tgrelid = expected.relation::regclass and trigger_row.tgname = expected.trigger_name
        and not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
        and trigger_row.tgtype = expected.trigger_type
        and trigger_row.tgfoid = expected.function_signature::regprocedure
        and trigger_row.tgnargs = expected.argument_count
        and (case when expected.definition is null
                  then trigger_row.tgqual is null and trigger_row.tgattr = ''::int2vector
                  else pg_get_triggerdef(trigger_row.oid) = expected.definition end));
  if v_mismatch is not null
     or (select count(*) from pg_trigger trigger_row
          where not trigger_row.tgisinternal and trigger_row.tgname = any (v_triggers)) <> 18 then
    raise exception using errcode = '55000', message = '0191: post-check failed (these triggers are not as made: '
      || coalesce(v_mismatch, 'the count') || ')';
  end if;
  -- The control: the CHECK is the keys found plus this one; the body is 0115's over them; the row is off; FORCE as
  -- it was; every other control row and the function's owner, grants and settings unchanged.
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'platform.control_settings'::regclass
         and constraint_row.conname = 'control_settings_control_key_check' and constraint_row.convalidated)
     is distinct from 'CHECK ((control_key = ANY (ARRAY['
       || (select string_agg(format('%L::text', listed.key), ', ' order by listed.ord)
             from unnest(v_keys || v_key) with ordinality listed(key, ord)) || '])))'
     or (select md5(replace(proc.prosrc, v_control_form_new, v_control_old)) from pg_proc proc
          where proc.oid = v_control_signature::regprocedure) is distinct from v_control_md5
     or (select string_agg(row(proc.oid, proc.proowner, proc.proacl, proc.prosecdef, proc.proconfig, proc.provolatile,
                               proc.proargtypes, proc.prorettype)::text, ';')
           from pg_proc proc where proc.oid = v_control_signature::regprocedure) is distinct from v_control_row_before
     or not exists (select 1 from platform.control_settings setting
                     where setting.control_key = v_key and not setting.enabled)
     or platform.control_enabled(v_key)
     or (select string_agg(to_jsonb(setting)::text, ',' order by setting.control_key collate "C")
           from platform.control_settings setting where setting.control_key <> v_key)
        is distinct from v_control_rows_before then
    raise exception using errcode = '55000', message = '0191: post-check failed (the control is not as made)';
  end if;
  if v_was_forced then
    execute 'alter table platform.control_settings force row level security';
  end if;
  if (select relation.relforcerowsecurity from pg_class relation
       where relation.oid = 'platform.control_settings'::regclass) is distinct from v_was_forced then
    raise exception using errcode = '55000', message = '0191: post-check failed (FORCE on platform.control_settings)';
  end if;
  if (select count(*) from ehr.referral_attestation_texts) <> 2
     or exists (select 1 from ehr.referrals) or exists (select 1 from identity.referral_destination_settings) then
    raise exception using errcode = '55000', message = '0191: post-check failed (the seeded rows)';
  end if;

  raise notice '0191: referrals between facilities are installed (6 tables, 27 functions, 18 triggers; the control cross_facility_referrals_enabled is off). Nobody can use them until 0193 gives the codes.';
end
$ref0191$;
