-- 0192 REF-1 Referrals between facilities: the receiving facility, the
-- time-limited read, arrival, the counter-referral and the patient's view
-- (Release D, the department sprint the owner approved on 25 November 2026;
-- docs/EHR_PLANNED_CONTRACT.md REF-1). Written on staging-novu-ci-20261005 at
-- 0cfddcc9 (0001-0153 applied) after 0191. The number is provisional, given at
-- merge in release order. The declaration in
-- config/production-schema-compatibility.json stays unsigned until the owner
-- signs this file.
--
-- Owner decisions it is built on (25 November 2026, each at the recommended
-- option): Q261 A (the receiving facility reads only the frozen package, until
-- 14 days after completion; never the chart; no policy on any clinical table
-- changes), Q262 A (the patient sees the referral in the portal and can
-- withdraw it before acceptance), Q168 A's principle for arrivals (a fresh,
-- audited search; the referral never grants access). Smaller choices at their
-- recommended option, not yet answered by the owner: Q-REF-8 A (before
-- accepting, the receiver sees the reason, department, service, urgency, the
-- referring facility and clinician, and the patient's sex and age in whole
-- years), Q-REF-9 A (arrival by a fresh direct-care search here, or a patient
-- already this facility's own, then 0135's own check-in), Q-REF-10 A (90 days
-- to arrive; the package read until completion plus 14 days, never more than
-- 120 days after acceptance), Q-REF-12 A (the portal shows destination, status
-- and dates, urgency, department and service, reason, the agreement text and
-- which kinds of details were shared, with counts; not the letter or items),
-- Q-REF-14 A (the receiving front desk sees expected arrivals: name, sex, date
-- of birth, the last 4 characters of the Health ID, the referring facility,
-- department and urgency; never the reason, letter or package), Q-REF-15 A
-- (with the control off: no acceptance, no arrival, no package read by the
-- receiver and, here, no expected-arrivals list; decline and complete still
-- work, and the patient can still withdraw).
--
-- What it changes (nothing else): functions only, SECURITY DEFINER with SET
-- search_path = pg_catalog, pg_temp, every name schema-qualified, no temporary
-- table, owned like 0191's (the owner of identity.has_active_consent_grant).
--   EXECUTE hid_ehr_runtime: ehr.referral_read (both sides, by view level),
--     ehr.referral_patient_list (route 8), ehr.referral_incoming_list,
--     ehr.referral_received_list, ehr.referral_accept, ehr.referral_decline,
--     ehr.referral_expected_list, ehr.referral_arrive, ehr.referral_complete,
--     ehr.referral_my_list and ehr.referral_my_withdraw (a patient session,
--     0086's ehr.order_route_patient()).
--   Helper no role may execute: ehr.referral_patient_audit.
-- The receiver's read: ehr.referral_read answers the package to the receiving
-- facility only at view level full: the effective state accepted, arrived or
-- completed, clock_timestamp() before access_ends_at, the control on, the
-- caller holding ehr.referral.receive there, and never once the visit was
-- entered in error. It reads the frozen copy only, never ehr.diagnoses,
-- ehr.prescriptions or any other chart table.
-- ehr.referral_arrive locks the referral FOR UPDATE, resolves the patient
-- (0132 with purpose direct-care, or 0131), compares it with the referral's
-- patient, then calls 0135's ehr.visit_queue_check_in (md5-pinned, called and
-- not replaced) under 0135's own advisory lock and one-open-row index, and
-- stores the row's id and basis. The arrival never opens the chart.
-- Every write locks the referral row FOR UPDATE, checks row_version, writes
-- the event, then the row; a replay is found by the event's idempotency key
-- first.
-- Audit (in the request's transaction, refusals that answer included):
-- ehr.referral.read (side, view level) and ehr.referral.package-read (counts
-- per kind) for each answer that holds the package, ehr.referral.patient-list,
-- ehr.referral.incoming-list, .received-list and .expected-list (each with
-- .shown per referral, naming the patient for the patient's access history),
-- ehr.referral.accept, .decline (reason code), .arrive (basis, outcome; plus
-- 0135's own ehr.visit-queue.check-in), .complete (outcome code), and the
-- patient's ehr.referral.patient-read and .patient-withdraw. Never a name,
-- date of birth, Health ID, reason, letter, note, package content or typed
-- facility name. This file itself writes no audit row.
--
-- Locks (measured with pg_locks and compared by the migrations suite), taken
-- first, NOWAIT: ACCESS SHARE on ehr.referrals, ehr.referral_events,
-- ehr.referral_package_items and ehr.visit_queue, so no DDL can change them
-- while the file applies; reads and writes go on. No other table: every body
-- is PL/pgSQL, not checked against tables at creation. The attempt is made 50
-- times, 100 ms apart (about 5 seconds), then 55P03 (nothing applied); one
-- attempt and no sleep when this transaction already holds an earlier
-- migration's locks that stop other sessions. Both refusals begin "0192: " and
-- end "run the release again at a quieter time".
--
-- Old images on this schema: nothing calls the new functions.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- twelve functions.
--
-- The whole file is one statement (do $ref0192$), so whatever raises in it
-- applies nothing:
-- 0. The locks.
-- 1. Preconditions (55000, nothing applied): 0191 applied, every one of its
--    functions with its body as made (md5); "0192: already applied" when every
--    function of this file is there as made; "0192: the schema is not in the
--    reviewed state" for any part of it; 0132's, 0131/0145's, 0135's and
--    0086's bodies this file calls, md5-pinned.
-- 2. The functions and their grants.
-- 3. Post-checks in 0148's and 0152's form: owner, SECURITY DEFINER,
--    volatility, exact search_path, body md5 and grants of each function.

do $ref0192$
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
  v_runtime_ehr constant text := 'hid_ehr_runtime';
  v_name text;
  -- 0191's functions and the md5 of each body (generated from 0191_referrals.sql).
  -- PINS-BEGIN 0191_referrals.sql
  v_pinned constant jsonb := '{"ehr.referral_attestation_text": "8c729b025e53899882a39e152a011a12",
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
  -- PINS-END
  -- The functions this file makes and the md5 of each body as made (generated from this file).
  -- BODIES-BEGIN
  v_bodies constant jsonb := '{"ehr.referral_accept": "349fac54512c2c73f1b1631ffcf64411",
    "ehr.referral_arrive": "a8f814e5af90b87dc9c3b0e1ed8bd205",
    "ehr.referral_complete": "b0cde312671fa7829646b0c683bcf7c2",
    "ehr.referral_decline": "e41d5c0093a38768e673fa1eacbca6f7",
    "ehr.referral_expected_list": "1aeba4ed921a2e204b7546ce9cb129dd",
    "ehr.referral_incoming_list": "871cd359f017df5fad7aa8fb0b449891",
    "ehr.referral_my_list": "bee3ce72e5ad7e5d4986703d9a07614f",
    "ehr.referral_my_withdraw": "49e3449b7e2c2cebb4d9e0e1b899b233",
    "ehr.referral_patient_audit": "0db6b52ae281755cfeb03119a69c832c",
    "ehr.referral_patient_list": "3ea1e83cb5ff6ebb419b9eeaaa8f3608",
    "ehr.referral_read": "e9a826c51bcc3fa84251a3d8d2463fcc",
    "ehr.referral_received_list": "b702c25e11cf3463be55ad226b8084e4"}';
  -- BODIES-END
  v_routes constant text[] := array['ehr.referral_read', 'ehr.referral_patient_list', 'ehr.referral_incoming_list',
    'ehr.referral_received_list', 'ehr.referral_accept', 'ehr.referral_decline', 'ehr.referral_expected_list',
    'ehr.referral_arrive', 'ehr.referral_complete', 'ehr.referral_my_list', 'ehr.referral_my_withdraw'];
begin
  -- 0191's tables are what this file locks first; without them there is nothing to lock (a catalog read only).
  if to_regclass('ehr.referrals') is null or to_regclass('ehr.referral_events') is null
     or to_regclass('ehr.referral_package_items') is null then
    raise exception using errcode = '55000', message = '0192: 0191 must be applied first';
  end if;
  -- 0. The locks, NOWAIT.
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table ehr.referrals, ehr.referral_events, ehr.referral_package_items, ehr.visit_queue
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0192: ehr.referrals, ehr.referral_events, ehr.referral_package_items or ehr.visit_queue is '
          || 'busy, and this transaction already holds an earlier migration''s locks, so it does not wait; nothing '
          || 'applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0192: ehr.referrals, ehr.referral_events, ehr.referral_package_items or ehr.visit_queue stayed '
          || 'busy for 5 seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  select string_agg(pinned.key, ', ' order by pinned.key) into v_mismatch
    from jsonb_each_text(v_pinned) pinned
   where (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname || '.' || proc.proname = pinned.key and md5(proc.prosrc) = pinned.value) <> 1;
  if v_mismatch is not null or (select count(*) from jsonb_object_keys(v_pinned)) <> 27 then
    raise exception using errcode = '55000',
      message = '0192: 0191 must be applied first, as made (these functions differ: ' || coalesce(v_mismatch, 'the count') || ')';
  end if;
  if (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
       where v_bodies ? (namespace.nspname || '.' || proc.proname)
         and md5(proc.prosrc) = v_bodies ->> (namespace.nspname || '.' || proc.proname))
     = (select count(*) from jsonb_object_keys(v_bodies)) then
    raise exception using errcode = '55000', message = '0192: already applied';
  end if;
  if exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where v_bodies ? (namespace.nspname || '.' || proc.proname)) then
    raise exception using errcode = '55000',
      message = '0192: the schema is not in the reviewed state (part of 0192 is there); nothing applied';
  end if;
  select string_agg(expected.signature, ', ' order by expected.signature) into v_mismatch
    from (values
      ('identity.resolve_patient_search_ref(text,text)', '9a80a8997571565f0e99c96f1cba4697'),
      ('identity.own_facility_basis(uuid,uuid)', '16ec336ac3633a295bc4a89f0e9f7542'),
      ('ehr.visit_queue_check_in(text,uuid)', '298bbe24dc23835a1969951b453ec061'),
      ('ehr.visit_queue_cards(uuid[],uuid,uuid,uuid)', '50b1288379241e45128d95ddec5419e5'),
      ('ehr.order_route_patient()', '675c6185c12c43e651ebf0a22770d282'),
      ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
      ('identity.patient_denies_order_route(uuid,uuid)', 'ab0dae381c56b599c318b065bf77de47'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0192: these bodies are not as 0001-0191 left them: ' || v_mismatch;
  end if;
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  if (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'ehr.referrals'::regclass)
     is distinct from v_owner then
    raise exception using errcode = '55000', message = '0192: ehr.referrals is not owned by the owner of 0135''s functions';
  end if;
  if v_owner is distinct from current_user and not pg_has_role(current_user, v_owner, 'MEMBER') then
    raise exception using errcode = '55000', message = '0192: this migrator cannot give its objects to their owner';
  end if;

  -- 2. The functions.

  -- One audit row of the patient's own step (a patient session): ids, codes and counts only.
  create function ehr.referral_patient_audit(a_patient uuid, a_action text, a_outcome text, a_resource_id text,
    a_details jsonb)
  returns void
  language plpgsql volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, patient_id, action, outcome, resource_type,
      resource_id, purpose_of_use, provenance, source_system, details
    ) values (
      platform.current_correlation_id(), 'patient', platform.current_actor_subject(), platform.current_account_id(),
      a_patient, a_action, a_outcome, 'referral', a_resource_id, platform.current_purpose_of_use(), 'application',
      'ehr-api', coalesce(a_details, '{}'::jsonb));
  end
  $fn$;

  -- Route 7: one referral, from either side. The referring side: the package to the sender or a member with the
  -- patient's read access (else chart_access_needed). The receiving side: the package at view level full only (else
  -- not_accepted or access_ended).
  create function ehr.referral_read(requested_referral_id uuid)
  returns table (outcome text, referral jsonb, package jsonb, package_hidden text, history jsonb)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    found_referral ehr.referrals%rowtype;
    side_value text;
    detail boolean;
    card_row record;
    package_value jsonb;
    hidden text;
  begin
    select * into caller from ehr.referral_caller('read-or-receive');
    select referral.* into found_referral from ehr.referrals referral
     where referral.id = requested_referral_id
       and ((referral.referring_facility_id = caller.actor_facility and caller.can_read)
            or (referral.receiving_facility_id = caller.actor_facility and caller.can_receive));
    if found_referral.id is null then
      perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
        'ehr.referral.read', 'denied', requested_referral_id::text, jsonb_build_object('refusal', 'not_found'));
      return query select 'not_found', null::jsonb, null::jsonb, null::text, null::jsonb;
      return;
    end if;
    side_value := case when found_referral.referring_facility_id = caller.actor_facility then 'sent' else 'received' end;
    detail := side_value = 'sent' and (found_referral.sent_by_membership_id = caller.actor_membership
      or ehr.context_allows(found_referral.patient_id, caller.actor_facility, 'read_records'));
    select * into card_row
      from ehr.referral_cards(array[found_referral.id], caller.actor_facility, detail, ehr.referral_control_on());
    if side_value = 'sent' then
      if detail then
        package_value := ehr.referral_package(found_referral.id);
      else
        hidden := 'chart_access_needed';
      end if;
    elsif card_row.view_level = 'full' then
      package_value := ehr.referral_package(found_referral.id);
    elsif found_referral.accepted_at is null then
      hidden := 'not_accepted';
    else
      hidden := 'access_ended';
    end if;
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      found_referral.patient_id, 'ehr.referral.read', 'success', found_referral.id::text,
      jsonb_build_object('side', side_value, 'viewLevel', card_row.view_level, 'packageHidden', hidden));
    if package_value is not null then
      perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        found_referral.patient_id, 'ehr.referral.package-read', 'success', found_referral.id::text,
        jsonb_build_object('side', side_value, 'counts', coalesce(card_row.card -> 'packageSummary', '[]'::jsonb)));
    end if;
    return query select 'found', card_row.card, package_value, hidden,
      ehr.referral_history(found_referral.id, side_value);
  end
  $fn$;
  comment on function ehr.referral_read(uuid) is
    '0192 (REF-1 route 7): one referral sent from or received at this facility, with the package by side and view level, the reason it is hidden, and the history. ehr.referral.read (referring side) or ehr.referral.receive (receiving side), direct care. Audited (ehr.referral.read, and ehr.referral.package-read for each answer holding the package).';

  -- Route 8: this patient's referrals sent from here, or received here once accepted; newest first, at most 100.
  create function ehr.referral_patient_list(requested_patient_id uuid, requested_encounter_id uuid)
  returns table (outcome text, ord bigint, card jsonb)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    found_ids uuid[];
  begin
    select * into caller from ehr.referral_caller('ehr.referral.read');
    if requested_patient_id is null then
      raise exception using errcode = '22023', message = 'REFERRAL_INVALID';
    end if;
    if not ehr.context_allows(requested_patient_id, caller.actor_facility, 'read_records') then
      perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select patient.id from identity.patients patient where patient.id = requested_patient_id),
        'ehr.referral.patient-list', 'denied', null, jsonb_build_object('refusal', 'consent_required'));
      return query select 'consent_required', null::bigint, null::jsonb;
      return;
    end if;
    select array_agg(listed.id order by listed.sent_at desc, listed.id desc) into found_ids
      from (select referral.id, referral.sent_at from ehr.referrals referral
             where referral.patient_id = requested_patient_id
               and ((referral.referring_facility_id = caller.actor_facility
                     and (requested_encounter_id is null or referral.source_encounter_id = requested_encounter_id))
                    or (referral.receiving_facility_id = caller.actor_facility and referral.accepted_at is not null
                        and requested_encounter_id is null))
             order by referral.sent_at desc, referral.id desc limit 100) listed;
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      requested_patient_id, 'ehr.referral.patient-list', 'success', null,
      jsonb_build_object('resultCount', coalesce(cardinality(found_ids), 0), 'encounterId', requested_encounter_id));
    return query
      select 'found', card.ord, card.card
        from ehr.referral_cards(coalesce(found_ids, '{}'), caller.actor_facility, true, ehr.referral_control_on()) card
       order by card.ord;
  end
  $fn$;
  comment on function ehr.referral_patient_list(uuid, uuid) is
    '0192 (REF-1 route 8): the visit''s or patient''s referrals at this facility (sent from here, or received here once accepted), newest first, at most 100. ehr.referral.read and the patient''s read access here, direct care. Audited (ehr.referral.patient-list).';

  -- Route 9: referrals sent here waiting for an answer (before respond_by), urgent first, then oldest first.
  create function ehr.referral_incoming_list()
  returns table (ord bigint, card jsonb, waiting_count integer, urgent_count integer, has_more boolean)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    found_ids uuid[];
    shown_ids uuid[];
    waiting integer;
    urgent integer;
  begin
    select * into caller from ehr.referral_caller('ehr.referral.receive');
    select array_agg(listed.id order by listed.urgent_first, listed.sent_at, listed.id),
           count(*), count(*) filter (where listed.urgent_first = 0)
      into found_ids, waiting, urgent
      from (select referral.id, referral.sent_at, case when referral.urgency = 'urgent' then 0 else 1 end as urgent_first
              from ehr.referrals referral
             where referral.receiving_facility_id = caller.actor_facility and referral.state = 'sent'
               and referral.respond_by > clock_timestamp()
               and not exists (select 1 from ehr.encounters encounter
                                where encounter.id = referral.source_encounter_id
                                  and encounter.status = 'entered_in_error')) listed;
    shown_ids := coalesce(found_ids[1:200], '{}');
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
      'ehr.referral.incoming-list', 'success', null,
      jsonb_build_object('resultCount', cardinality(shown_ids), 'waiting', waiting, 'urgent', urgent));
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      referral.patient_id, 'ehr.referral.incoming-list.shown', 'success', referral.id::text, '{}'::jsonb)
      from ehr.referrals referral where referral.id = any (shown_ids);
    return query
      select card.ord, card.card, waiting, urgent, coalesce(cardinality(found_ids), 0) > 200
        from ehr.referral_cards(shown_ids, caller.actor_facility, false, ehr.referral_control_on()) card
       order by card.ord;
  end
  $fn$;
  comment on function ehr.referral_incoming_list() is
    '0192 (REF-1 route 9): referrals sent to this facility waiting for an answer (before respond_by), urgent first, then oldest first, at most 200, with the counts; cards at view level preview (control on) or metadata. ehr.referral.receive here, direct care. Audited (ehr.referral.incoming-list, and .shown per referral naming the patient).';

  -- Route 10: referrals this facility was asked and that are no longer waiting, sent in the last 90 days, newest
  -- first.
  create function ehr.referral_received_list(requested_states text[], requested_limit integer, requested_cursor text)
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
    last_cursor text;
  begin
    select * into caller from ehr.referral_caller('ehr.referral.receive');
    select * into limits from ehr.referral_limits();
    if page_size not between 1 and 200
       or exists (select 1 from unnest(coalesce(requested_states, '{}')) listed(state)
                   where listed.state is null or listed.state not in ('accepted', 'arrived', 'completed', 'declined',
                     'withdrawn', 'expired'))
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
             where referral.receiving_facility_id = caller.actor_facility
               and referral.sent_at >= clock_timestamp() - make_interval(days => limits.list_days)
               and effective.effective_state <> 'sent'
               and (cursor_at is null or (referral.sent_at, referral.id) < (cursor_at, cursor_id))
               and (cardinality(coalesce(requested_states, '{}')) = 0
                    or effective.effective_state = any (requested_states))
             order by referral.sent_at desc, referral.id desc
             limit page_size + 1) listed;
    shown_ids := coalesce(found_ids[1:page_size], '{}');
    if coalesce(cardinality(found_ids), 0) > page_size then
      select (floor(extract(epoch from referral.sent_at) * 1000000))::bigint::text || ':' || referral.id::text
        into last_cursor from ehr.referrals referral where referral.id = shown_ids[page_size];
    end if;
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
      'ehr.referral.received-list', 'success', null, jsonb_build_object('resultCount', cardinality(shown_ids),
        'states', coalesce(to_jsonb(requested_states), '[]'::jsonb)));
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      referral.patient_id, 'ehr.referral.received-list.shown', 'success', referral.id::text, '{}'::jsonb)
      from ehr.referrals referral where referral.id = any (shown_ids);
    return query
      select card.ord, card.card, last_cursor
        from ehr.referral_cards(shown_ids, caller.actor_facility, false, ehr.referral_control_on()) card
       order by card.ord;
  end
  $fn$;
  comment on function ehr.referral_received_list(text[], integer, text) is
    '0192 (REF-1 route 10): referrals sent to this facility in the last 90 days that no longer wait for an answer, newest first, by effective state, at most limit (1-200) with a cursor. ehr.referral.receive here, direct care. Audited (ehr.referral.received-list, and .shown per referral).';

  -- Route 11: accept, while sent and before respond_by, with the control on; the patient's deny directives checked
  -- again; the referring facility still active and verified. arrive_by = acceptance + 90 days, access_ends_at =
  -- acceptance + 120 days.
  create function ehr.referral_accept(requested_referral_id uuid, requested_expected_version bigint,
    requested_note text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, referral jsonb, package jsonb)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    limits record;
    key_state record;
    found_referral ehr.referrals%rowtype;
    effective record;
    refusal text;
    note_value text := nullif(btrim(coalesce(requested_note, '')), '');
    now_value timestamptz := clock_timestamp();
    card_row record;
  begin
    select * into caller from ehr.referral_caller('ehr.referral.receive');
    if requested_referral_id is null or requested_expected_version is null
       or (note_value is not null and (length(note_value) > 500 or translate(note_value, E'\n\r', '') ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'REFERRAL_INVALID';
    end if;
    select * into limits from ehr.referral_limits();
    select * into key_state
      from ehr.referral_idempotency(caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'accepted' and key_state.referral_id = requested_referral_id then
      select * into card_row
        from ehr.referral_cards(array[requested_referral_id], caller.actor_facility, false, ehr.referral_control_on());
      return query select 'accepted', true, card_row.card,
        case when card_row.view_level = 'full' then ehr.referral_package(requested_referral_id) end;
      return;
    end if;
    select referral.* into found_referral from ehr.referrals referral
     where referral.id = requested_referral_id and referral.receiving_facility_id = caller.actor_facility
     for update;
    if found_referral.id is null then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif not ehr.referral_control_on() then
      refusal := 'control_off';
    elsif found_referral.row_version <> requested_expected_version then
      refusal := 'changed';
    else
      select * into effective from ehr.referral_effective(found_referral);
      if effective.visit_in_error or found_referral.state in ('declined', 'withdrawn', 'completed') then
        refusal := 'closed';
      elsif found_referral.state in ('accepted', 'arrived') then
        refusal := 'not_pending';
      elsif effective.effective_state = 'expired' then
        refusal := 'expired';
      elsif identity.patient_denies_order_route(found_referral.patient_id, caller.actor_facility) then
        refusal := 'patient_denied';
      elsif not exists (select 1 from identity.facilities facility
                         where facility.id = found_referral.referring_facility_id and facility.active
                           and facility.lifecycle_status = 'verified') then
        refusal := 'closed';
      end if;
    end if;
    if refusal is not null then
      perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        found_referral.patient_id, 'ehr.referral.accept', 'denied', requested_referral_id::text,
        jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb, null::jsonb;
      return;
    end if;
    insert into ehr.referral_events (referral_id, event_version, kind, side, by_membership_id, by_account_id,
      state_after, idempotency_key, request_sha256, correlation_id, at)
    values (found_referral.id, (select coalesce(max(event.event_version), 0) + 1 from ehr.referral_events event
                                 where event.referral_id = found_referral.id),
      'accepted', 'receiving', caller.actor_membership, caller.actor_account, 'accepted', requested_idempotency_key,
      requested_request_sha256, caller.actor_correlation, now_value);
    update ehr.referrals referral
       set state = 'accepted', accepted_at = now_value, accepted_by_membership_id = caller.actor_membership,
           accepted_by_account_id = caller.actor_account, accept_note = note_value,
           arrive_by = now_value + make_interval(days => limits.arrive_days),
           access_ends_at = now_value + make_interval(days => limits.access_cap_days), updated_at = now_value,
           row_version = referral.row_version + 1
     where referral.id = found_referral.id;
    perform ehr.referral_notify_patient(found_referral.id, 'REFERRAL_ACCEPTED');
    select * into card_row
      from ehr.referral_cards(array[found_referral.id], caller.actor_facility, false, true);
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      found_referral.patient_id, 'ehr.referral.accept', 'success', found_referral.id::text,
      jsonb_build_object('urgency', found_referral.urgency, 'withNote', note_value is not null));
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      found_referral.patient_id, 'ehr.referral.package-read', 'success', found_referral.id::text,
      jsonb_build_object('side', 'received', 'counts', coalesce(card_row.card -> 'packageSummary', '[]'::jsonb)));
    return query select 'accepted', false, card_row.card, ehr.referral_package(found_referral.id);
  end
  $fn$;
  comment on function ehr.referral_accept(uuid, bigint, text, text, text) is
    '0192 (REF-1 route 11): the receiving facility accepts a referral while sent and before respond_by, with the control on, an optional note (0-500), the patient''s deny directives checked again and the referring facility still active and verified; arrive_by = acceptance + 90 days, access_ends_at = acceptance + 120 days. ehr.referral.receive here, direct care. Outcomes accepted, not_found, key_reused, control_off, changed, closed, not_pending, expired, patient_denied; audited (ehr.referral.accept, ehr.referral.package-read).';

  -- Route 12: decline with a reason and a note, while sent (also after respond_by); the control may be off.
  create function ehr.referral_decline(requested_referral_id uuid, requested_expected_version bigint,
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
    select * into caller from ehr.referral_caller('ehr.referral.receive');
    if requested_referral_id is null or requested_expected_version is null or requested_reason_code is null
       or requested_reason_code not in ('service_not_offered', 'no_capacity', 'more_information_needed',
         'better_elsewhere', 'other') then
      raise exception using errcode = '22023', message = 'REFERRAL_INVALID';
    end if;
    select * into key_state
      from ehr.referral_idempotency(caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'declined' and key_state.referral_id = requested_referral_id then
      return query select 'declined', true, card.card
        from ehr.referral_cards(array[requested_referral_id], caller.actor_facility, false, ehr.referral_control_on()) card;
      return;
    end if;
    select referral.* into found_referral from ehr.referrals referral
     where referral.id = requested_referral_id and referral.receiving_facility_id = caller.actor_facility
     for update;
    if found_referral.id is null then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif found_referral.row_version <> requested_expected_version then
      refusal := 'changed';
    else
      select * into effective from ehr.referral_effective(found_referral);
      if effective.visit_in_error or found_referral.state in ('declined', 'withdrawn', 'completed') then
        refusal := 'closed';
      elsif found_referral.state in ('accepted', 'arrived') then
        refusal := 'not_pending';
      elsif note_value is null or length(note_value) not between 8 and 500
            or translate(note_value, E'\n\r', '') ~ '[[:cntrl:]]' then
        refusal := 'reason_required';
      end if;
    end if;
    if refusal is not null then
      perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        found_referral.patient_id, 'ehr.referral.decline', 'denied', requested_referral_id::text,
        jsonb_build_object('refusal', refusal, 'reasonCode', requested_reason_code));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    insert into ehr.referral_events (referral_id, event_version, kind, side, by_membership_id, by_account_id,
      reason_code, state_after, idempotency_key, request_sha256, correlation_id, at)
    values (found_referral.id, (select coalesce(max(event.event_version), 0) + 1 from ehr.referral_events event
                                 where event.referral_id = found_referral.id),
      'declined', 'receiving', caller.actor_membership, caller.actor_account, requested_reason_code, 'declined',
      requested_idempotency_key, requested_request_sha256, caller.actor_correlation, now_value);
    update ehr.referrals referral
       set state = 'declined', declined_at = now_value, declined_by_membership_id = caller.actor_membership,
           declined_by_account_id = caller.actor_account, decline_reason_code = requested_reason_code,
           decline_note = note_value, updated_at = now_value, row_version = referral.row_version + 1
     where referral.id = found_referral.id;
    perform ehr.referral_notify_patient(found_referral.id, 'REFERRAL_DECLINED');
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      found_referral.patient_id, 'ehr.referral.decline', 'success', found_referral.id::text,
      jsonb_build_object('reasonCode', requested_reason_code,
        'afterRespondBy', now_value >= found_referral.respond_by));
    return query select 'declined', false, card.card
      from ehr.referral_cards(array[found_referral.id], caller.actor_facility, false, ehr.referral_control_on()) card;
  end
  $fn$;
  comment on function ehr.referral_decline(uuid, bigint, text, text, text, text) is
    '0192 (REF-1 route 12): the receiving facility declines a referral while sent (also after respond_by, so a late answer still reaches the referrer), with a reason code and a note (8-500). Works with the control off. ehr.referral.receive here, direct care. Outcomes declined, not_found, key_reused, changed, closed, not_pending, reason_required; audited (ehr.referral.decline).';

  -- Route 13: the front desk's expected arrivals (accepted, not yet arrived, before arrive_by), urgent first, then by
  -- acceptance. Name, sex, date of birth and the last 4 characters of the Health ID; never the reason, letter or
  -- package (Q-REF-14 A). Empty while the control is off (Q-REF-15 A: nothing crosses to another facility).
  create function ehr.referral_expected_list()
  returns table (ord bigint, item jsonb, has_more boolean)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    found_ids uuid[];
    shown_ids uuid[];
    control boolean := ehr.referral_control_on();
  begin
    select * into caller from ehr.referral_caller('ehr.referral.arrive');
    if control then
      select array_agg(listed.id order by listed.urgent_first, listed.accepted_at, listed.id) into found_ids
        from (select referral.id, referral.accepted_at,
                     case when referral.urgency = 'urgent' then 0 else 1 end as urgent_first
                from ehr.referrals referral
               where referral.receiving_facility_id = caller.actor_facility and referral.state = 'accepted'
                 and referral.arrive_by > clock_timestamp()
                 and not exists (select 1 from ehr.encounters encounter
                                  where encounter.id = referral.source_encounter_id
                                    and encounter.status = 'entered_in_error')) listed;
    end if;
    shown_ids := coalesce(found_ids[1:200], '{}');
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
      'ehr.referral.expected-list', 'success', null,
      jsonb_build_object('resultCount', cardinality(shown_ids), 'controlOn', control));
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      referral.patient_id, 'ehr.referral.expected-list.shown', 'success', referral.id::text, '{}'::jsonb)
      from ehr.referrals referral where referral.id = any (shown_ids);
    return query
      select ordering.ord_position,
             jsonb_build_object('referralId', referral.id, 'reference', referral.reference::text,
               'patient', jsonb_build_object('patientId', patient.id, 'fullName', patient.full_name,
                 'sex', patient.gender, 'dateOfBirth', to_char(patient.dob, 'YYYY-MM-DD'),
                 'dateOfBirthEstimated', exists (select 1 from identity.unknown_patients unknown_record
                                                  where unknown_record.patient_id = patient.id
                                                    and unknown_record.status in ('open', 'sent_for_review'))
                                         and patient.dob is not null,
                 'healthIdLast4', right(patient.hid_code, 4)),
               'referringFacilityName', referring.name, 'departmentCode', referral.department_code,
               'serviceWanted', referral.service_wanted, 'urgency', referral.urgency,
               'acceptedAt', ehr.referral_instant(referral.accepted_at),
               'arriveBy', ehr.referral_instant(referral.arrive_by), 'rowVersion', referral.row_version),
             coalesce(cardinality(found_ids), 0) > 200
        from unnest(shown_ids) with ordinality ordering(wanted_id, ord_position)
        join ehr.referrals referral on referral.id = ordering.wanted_id
        join identity.patients patient on patient.id = referral.patient_id
        join identity.facilities referring on referring.id = referral.referring_facility_id
       order by ordering.ord_position;
  end
  $fn$;
  comment on function ehr.referral_expected_list() is
    '0192 (REF-1 route 13): accepted referrals to this facility not yet arrived, before arrive_by, urgent first, then by acceptance, at most 200: name, sex, date of birth, last 4 of the Health ID, referring facility, department, service and urgency; never the reason, letter or package. Empty while the control is off. ehr.referral.arrive (with 0135''s pair) here, direct care. Audited (ehr.referral.expected-list, and .shown per referral).';

  -- Route 14: the patient arrived. A fresh direct-care search here in the last 10 minutes that names the referral's
  -- patient (0132), or the referral's patient already this facility's own (0131); anything else needs_search, the
  -- same for every reason. Then 0135's own check-in; the referral keeps the waiting-list row's id and basis.
  create function ehr.referral_arrive(requested_referral_id uuid, requested_expected_version bigint,
    requested_match_ref text, requested_patient_id uuid, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, referral jsonb, entry jsonb)
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
    ref_value text := nullif(btrim(coalesce(requested_match_ref, '')), '');
    resolved uuid;
    checked record;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.referral_caller('ehr.referral.arrive');
    if requested_referral_id is null or requested_expected_version is null
       or (ref_value is null) = (requested_patient_id is null)
       or (ref_value is not null and (length(ref_value) > 200 or ref_value !~ '^[A-Za-z0-9_-]+$')) then
      raise exception using errcode = '22023', message = 'REFERRAL_ARRIVAL_NEEDS_ONE_PATIENT';
    end if;
    select * into key_state
      from ehr.referral_idempotency(caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'arrived' and key_state.referral_id = requested_referral_id then
      return query
        select 'checked_in', true, card.card,
               (select to_jsonb(queue_card) from ehr.visit_queue_cards(
                  array[(select referral.visit_queue_entry_id from ehr.referrals referral
                          where referral.id = requested_referral_id)],
                  caller.actor_facility, caller.actor_organization, caller.actor_staff) queue_card)
          from ehr.referral_cards(array[requested_referral_id], caller.actor_facility, false,
                 ehr.referral_control_on()) card;
      return;
    end if;
    select referral.* into found_referral from ehr.referrals referral
     where referral.id = requested_referral_id and referral.receiving_facility_id = caller.actor_facility
     for update;
    if found_referral.id is null then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif not ehr.referral_control_on() then
      refusal := 'control_off';
    elsif found_referral.row_version <> requested_expected_version then
      refusal := 'changed';
    else
      select * into effective from ehr.referral_effective(found_referral);
      if effective.visit_in_error or found_referral.state in ('declined', 'withdrawn', 'completed') then
        refusal := 'closed';
      elsif found_referral.state = 'sent' then
        refusal := 'not_accepted';
      elsif found_referral.state = 'arrived' then
        refusal := 'not_pending';
      elsif effective.effective_state = 'expired' then
        refusal := 'expired';
      else
        if ref_value is not null then
          resolved := identity.resolve_patient_search_ref(ref_value, 'direct-care');
        elsif exists (select 1 from identity.patients patient
                       where patient.id = requested_patient_id and patient.status = 'active'
                         and identity.sealed_demo_facility(caller.actor_facility) = identity.sealed_demo_patient(patient.id)
                         and identity.sealed_qa_facility(caller.actor_facility) = identity.sealed_qa_patient(patient.id))
              and identity.own_facility_basis(requested_patient_id, caller.actor_facility) is not null then
          resolved := requested_patient_id;
        end if;
        if resolved is null or resolved <> found_referral.patient_id then
          refusal := 'needs_search';
        end if;
      end if;
    end if;
    if refusal is null then
      select * into checked from ehr.visit_queue_check_in(ref_value,
        case when ref_value is null then requested_patient_id end) limit 1;
      if checked.outcome is null or checked.outcome not in ('checked_in', 'already_open')
         or checked.patient_id is distinct from found_referral.patient_id then
        refusal := 'needs_search';
      end if;
    end if;
    if refusal is not null then
      perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        case when refusal in ('not_found', 'needs_search') then null else found_referral.patient_id end,
        'ehr.referral.arrive', 'denied', requested_referral_id::text,
        jsonb_build_object('refusal', refusal, 'by', case when ref_value is not null then 'match_ref' else 'patient_id' end));
      return query select refusal, false, null::jsonb, null::jsonb;
      return;
    end if;
    insert into ehr.referral_events (referral_id, event_version, kind, side, by_membership_id, by_account_id,
      state_after, idempotency_key, request_sha256, correlation_id, at)
    values (found_referral.id, (select coalesce(max(event.event_version), 0) + 1 from ehr.referral_events event
                                 where event.referral_id = found_referral.id),
      'arrived', 'receiving', caller.actor_membership, caller.actor_account, 'arrived', requested_idempotency_key,
      requested_request_sha256, caller.actor_correlation, now_value);
    update ehr.referrals referral
       set state = 'arrived', arrived_at = now_value, arrived_by_membership_id = caller.actor_membership,
           arrived_by_account_id = caller.actor_account, visit_queue_entry_id = checked.entry_id,
           arrival_basis = checked.check_in_basis, updated_at = now_value, row_version = referral.row_version + 1
     where referral.id = found_referral.id;
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      found_referral.patient_id, 'ehr.referral.arrive', 'success', found_referral.id::text,
      jsonb_build_object('basis', checked.check_in_basis,
        'outcome', case when checked.outcome = 'already_open' then 'already_on_list' else 'checked_in' end,
        'visitQueueEntryId', checked.entry_id));
    return query
      select case when checked.outcome = 'already_open' then 'already_on_list' else 'checked_in' end, false, card.card,
             to_jsonb(checked) - 'outcome'
        from ehr.referral_cards(array[found_referral.id], caller.actor_facility, false, ehr.referral_control_on()) card;
  end
  $fn$;
  comment on function ehr.referral_arrive(uuid, bigint, text, uuid, text, text) is
    '0192 (REF-1 route 14): the referred patient arrived: while accepted and before arrive_by, with the control on, a matchRef of this member''s own direct-care search here naming the referral''s patient (0132) or that patient already this facility''s own (0131), then 0135''s own ehr.visit_queue_check_in. ehr.referral.arrive and 0135''s pair here, direct care. Outcomes checked_in, already_on_list, not_found, key_reused, control_off, changed, closed, not_accepted, not_pending, expired, needs_search; audited (ehr.referral.arrive, and 0135''s ehr.visit-queue.check-in). Never opens the chart.';

  -- Route 15: the counter-referral: the outcome and a feedback note. From arrived with any outcome but
  -- did_not_attend; from accepted (also past arrive_by) with did_not_attend only. Works with the control off.
  create function ehr.referral_complete(requested_referral_id uuid, requested_expected_version bigint,
    requested_outcome text, requested_feedback_note text, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, referral jsonb)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    limits record;
    key_state record;
    found_referral ehr.referrals%rowtype;
    effective record;
    refusal text;
    note_value text := btrim(coalesce(requested_feedback_note, ''));
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.referral_caller('ehr.referral.receive');
    if requested_referral_id is null or requested_expected_version is null or requested_outcome is null
       or requested_outcome not in ('seen_care_returned', 'seen_care_continues', 'admitted', 'referred_onward',
         'did_not_attend')
       or length(note_value) not between 8 and 2000 or translate(note_value, E'\n\r', '') ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'REFERRAL_INVALID';
    end if;
    select * into limits from ehr.referral_limits();
    select * into key_state
      from ehr.referral_idempotency(caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'completed' and key_state.referral_id = requested_referral_id then
      return query select 'completed', true, card.card
        from ehr.referral_cards(array[requested_referral_id], caller.actor_facility, false, ehr.referral_control_on()) card;
      return;
    end if;
    select referral.* into found_referral from ehr.referrals referral
     where referral.id = requested_referral_id and referral.receiving_facility_id = caller.actor_facility
     for update;
    if found_referral.id is null then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif found_referral.row_version <> requested_expected_version then
      refusal := 'changed';
    else
      select * into effective from ehr.referral_effective(found_referral);
      if effective.visit_in_error or found_referral.state in ('declined', 'withdrawn', 'completed') then
        refusal := 'closed';
      elsif found_referral.state = 'sent' then
        refusal := 'not_accepted';
      elsif found_referral.state = 'accepted' and requested_outcome <> 'did_not_attend' then
        refusal := 'not_arrived';
      elsif found_referral.state = 'arrived' and requested_outcome = 'did_not_attend' then
        refusal := 'outcome_invalid';
      end if;
    end if;
    if refusal is not null then
      perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        found_referral.patient_id, 'ehr.referral.complete', 'denied', requested_referral_id::text,
        jsonb_build_object('refusal', refusal, 'outcomeCode', requested_outcome));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    insert into ehr.referral_events (referral_id, event_version, kind, side, by_membership_id, by_account_id,
      reason_code, state_after, idempotency_key, request_sha256, correlation_id, at)
    values (found_referral.id, (select coalesce(max(event.event_version), 0) + 1 from ehr.referral_events event
                                 where event.referral_id = found_referral.id),
      'completed', 'receiving', caller.actor_membership, caller.actor_account, requested_outcome, 'completed',
      requested_idempotency_key, requested_request_sha256, caller.actor_correlation, now_value);
    update ehr.referrals referral
       set state = 'completed', completed_at = now_value, completed_by_membership_id = caller.actor_membership,
           completed_by_account_id = caller.actor_account, outcome_code = requested_outcome, feedback_note = note_value,
           access_ends_at = least(now_value + make_interval(days => limits.after_completion_days),
                                  referral.accepted_at + make_interval(days => limits.access_cap_days)),
           updated_at = now_value, row_version = referral.row_version + 1
     where referral.id = found_referral.id;
    perform ehr.referral_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      found_referral.patient_id, 'ehr.referral.complete', 'success', found_referral.id::text,
      jsonb_build_object('outcomeCode', requested_outcome, 'stateBefore', found_referral.state));
    return query select 'completed', false, card.card
      from ehr.referral_cards(array[found_referral.id], caller.actor_facility, false, ehr.referral_control_on()) card;
  end
  $fn$;
  comment on function ehr.referral_complete(uuid, bigint, text, text, text, text) is
    '0192 (REF-1 route 15): the counter-referral: the outcome and a feedback note (8-2000). From arrived with any outcome but did_not_attend; from accepted (also past arrive_by) with did_not_attend only. Works with the control off. access_ends_at becomes the earlier of completion + 14 days and acceptance + 120 days. ehr.referral.receive here, direct care. Outcomes completed, not_found, key_reused, changed, closed, not_accepted, not_arrived, outcome_invalid; audited (ehr.referral.complete).';

  -- Route 16: the signed-in patient's own referrals from every facility, newest first, at most 100. No staff ids, no
  -- letter, no items and no outcome note (Q-REF-12 A). A visit entered in error keeps reference, facilities, states
  -- and dates only.
  create function ehr.referral_my_list()
  returns table (ord bigint, item jsonb)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    own_patient uuid := ehr.order_route_patient();
    shown integer;
  begin
    select count(*) into shown from (select 1 from ehr.referrals referral where referral.patient_id = own_patient
                                      limit 100) counted;
    perform ehr.referral_patient_audit(own_patient, 'ehr.referral.patient-read', 'success', null,
      jsonb_build_object('resultCount', shown));
    return query
      select row_number() over (order by listed.sent_at desc, listed.id desc),
             jsonb_build_object('referralId', listed.id, 'reference', listed.reference::text,
               'referringFacilityName', referring.name, 'destinationKind', listed.destination_kind,
               'destinationName', coalesce(receiving.name, listed.printed_facility_name),
               'departmentCode', case when not effective.visit_in_error then listed.department_code end,
               'serviceWanted', case when not effective.visit_in_error then listed.service_wanted end,
               'urgency', listed.urgency,
               'reason', case when not effective.visit_in_error then listed.reason end,
               'state', listed.state, 'effectiveState', effective.effective_state, 'endedKind', effective.ended_kind,
               'sentAt', ehr.referral_instant(listed.sent_at), 'respondBy', ehr.referral_instant(listed.respond_by),
               'acceptedAt', ehr.referral_instant(listed.accepted_at),
               'arrivedAt', ehr.referral_instant(listed.arrived_at),
               'completedAt', ehr.referral_instant(listed.completed_at),
               'endedAt', ehr.referral_instant(effective.ended_at),
               'sharedSections', case when not effective.visit_in_error then coalesce((
                 select jsonb_agg(jsonb_build_object('kind', counted.kind_name, 'count', counted.item_count)
                                  order by counted.kind_order)
                   from (select case item.item_kind when 'diagnosis' then 'diagnoses' when 'medicine' then 'medicines'
                                  when 'allergy' then 'allergies' when 'vital' then 'vitals' else 'labResults' end
                                  as kind_name,
                                case item.item_kind when 'diagnosis' then 1 when 'medicine' then 2 when 'allergy' then 3
                                  when 'vital' then 4 else 5 end as kind_order,
                                count(*) as item_count
                           from ehr.referral_package_items item where item.referral_id = listed.id
                          group by item.item_kind) counted), '[]'::jsonb) end,
               'attestation', case when not effective.visit_in_error then
                 (select jsonb_build_object('version', text_row.version, 'text', text_row.text)
                    from ehr.referral_attestation_texts text_row
                   where text_row.version = listed.attestation_text_version) end,
               'canWithdraw', listed.state = 'sent' and effective.effective_state = 'sent',
               'rowVersion', listed.row_version, 'enteredInError', effective.visit_in_error)
        from (select referral.id as wanted_id from ehr.referrals referral where referral.patient_id = own_patient
               order by referral.sent_at desc, referral.id desc limit 100) wanted
        join ehr.referrals listed on listed.id = wanted.wanted_id
        cross join lateral ehr.referral_effective(listed) effective
        join identity.facilities referring on referring.id = listed.referring_facility_id
        left join identity.facilities receiving on receiving.id = listed.receiving_facility_id
       order by listed.sent_at desc, listed.id desc;
  end
  $fn$;
  comment on function ehr.referral_my_list() is
    '0192 (REF-1 route 16): the signed-in patient''s own referrals (0086''s ehr.order_route_patient()), newest first, at most 100: destination, status and dates, urgency, department and service, the reason, the agreement text and the kinds of details shared with counts; never staff ids, the letter, the items or the outcome note. Audited (ehr.referral.patient-read).';

  -- Route 17: the patient withdraws a referral while it waits for an answer (sent, before respond_by). Works with the
  -- control off. A printed letter cannot be withdrawn here (not_pending).
  create function ehr.referral_my_withdraw(requested_referral_id uuid, requested_expected_version bigint)
  returns table (outcome text, row_version bigint, state text, effective_state text)
  language plpgsql volatile security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    own_patient uuid := ehr.order_route_patient();
    own_account uuid := platform.current_account_id();
    found_referral ehr.referrals%rowtype;
    effective record;
    refusal text;
    now_value timestamptz := clock_timestamp();
  begin
    if requested_referral_id is null or requested_expected_version is null or own_account is null then
      raise exception using errcode = '22023', message = 'REFERRAL_INVALID';
    end if;
    select referral.* into found_referral from ehr.referrals referral
     where referral.id = requested_referral_id and referral.patient_id = own_patient
     for update;
    if found_referral.id is null then
      refusal := 'not_found';
    elsif found_referral.row_version <> requested_expected_version then
      refusal := 'changed';
    else
      select * into effective from ehr.referral_effective(found_referral);
      if found_referral.state <> 'sent' or effective.effective_state <> 'sent' then
        refusal := 'not_pending';
      end if;
    end if;
    if refusal is not null then
      perform ehr.referral_patient_audit(own_patient, 'ehr.referral.patient-withdraw', 'denied',
        requested_referral_id::text, jsonb_build_object('refusal', refusal));
      return query select refusal, null::bigint, null::text, null::text;
      return;
    end if;
    insert into ehr.referral_events (referral_id, event_version, kind, side, by_membership_id, by_account_id,
      state_after, correlation_id, at)
    values (found_referral.id, (select coalesce(max(event.event_version), 0) + 1 from ehr.referral_events event
                                 where event.referral_id = found_referral.id),
      'patient_withdrew', 'patient', null, own_account, 'withdrawn', platform.current_correlation_id(), now_value);
    update ehr.referrals referral
       set state = 'withdrawn', withdrawn_at = now_value, withdrawn_by = 'patient', withdrawn_by_account_id = own_account,
           updated_at = now_value, row_version = referral.row_version + 1
     where referral.id = found_referral.id;
    perform ehr.referral_patient_audit(own_patient, 'ehr.referral.patient-withdraw', 'success',
      found_referral.id::text, jsonb_build_object('referralId', found_referral.id));
    return query select 'withdrawn', found_referral.row_version + 1, 'withdrawn'::text, 'withdrawn'::text;
  end
  $fn$;
  comment on function ehr.referral_my_withdraw(uuid, bigint) is
    '0192 (REF-1 route 17): the signed-in patient withdraws their referral while it waits for an answer (sent, before respond_by); works with the control off. Outcomes withdrawn, not_found, changed, not_pending; audited (ehr.referral.patient-withdraw). The referring and receiving facilities see "Withdrawn by the patient".';

  -- Owners, PUBLIC's EXECUTE taken away, and EXECUTE for the EHR runtime on the routes only.
  for v_name in
    select proc.oid::regprocedure::text from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
     where v_bodies ? (namespace.nspname || '.' || proc.proname)
        or (namespace.nspname || '.' || proc.proname) = any (v_routes || 'ehr.referral_patient_audit'::text)
  loop
    execute format('revoke all on function %s from public', v_name);
    if v_owner <> current_user then
      execute format('alter function %s owner to %I', v_name, v_owner);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = v_runtime_ehr) then
    grant execute on function
      ehr.referral_read(uuid),
      ehr.referral_patient_list(uuid, uuid),
      ehr.referral_incoming_list(),
      ehr.referral_received_list(text[], integer, text),
      ehr.referral_accept(uuid, bigint, text, text, text),
      ehr.referral_decline(uuid, bigint, text, text, text, text),
      ehr.referral_expected_list(),
      ehr.referral_arrive(uuid, bigint, text, uuid, text, text),
      ehr.referral_complete(uuid, bigint, text, text, text, text),
      ehr.referral_my_list(),
      ehr.referral_my_withdraw(uuid, bigint)
      to hid_ehr_runtime;
  end if;

  -- 3. Post-checks: each function's body as made, owner, search_path, SECURITY DEFINER (the routes only),
  -- volatility, and EXECUTE only for the EHR runtime on the routes.
  select string_agg(namespace.nspname || '.' || proc.proname, ', ' order by proc.proname) into v_mismatch
    from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
   where v_bodies ? (namespace.nspname || '.' || proc.proname)
     and (md5(proc.prosrc) is distinct from v_bodies ->> (namespace.nspname || '.' || proc.proname)
          or pg_get_userbyid(proc.proowner) <> v_owner
          or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
          or proc.prosecdef <> ((namespace.nspname || '.' || proc.proname) = any (v_routes))
          or proc.provolatile <> 'v'
          or exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                      where acl.grantee <> proc.proowner
                        and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> v_runtime_ehr
                             or not ((namespace.nspname || '.' || proc.proname) = any (v_routes)))));
  if v_mismatch is not null
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where v_bodies ? (namespace.nspname || '.' || proc.proname)) <> 12
     or (select count(*) from jsonb_object_keys(v_bodies)) <> 12 then
    raise exception using errcode = '55000', message = '0192: post-check failed (these functions are not as made: '
      || coalesce(v_mismatch, 'the count') || ')';
  end if;

  raise notice '0192: the receiving facility''s steps, arrival, the counter-referral and the patient''s view are installed (12 functions). Nobody can use them until 0193 gives the codes.';
end
$ref0192$;
