-- 0159 Notices to the ordering doctor (ORD-11, lane D). Owner decision Q128 A
-- (19 November 2026): an in-app list first, and critical results must be
-- marked Seen. Q162 puts ORD-11 in Phase 1. Built from the clinical owner's
-- design note on hid-system#258 (Ola, 26 November 2026, 12:34 UTC), which
-- folds in Rahman's review. Written on staging 0cfddcc9 (Release E:
-- 0001-0153) with 0154 (#331) merged in.
--
-- The number is a booking. The final number is given at integration, in
-- release order, after 0154. No migration number appears inside a function
-- body, a CHECK or a key, so renumbering changes this header, the messages
-- of the DO blocks (the busy refusals among them) and nothing else. The
-- owner signs the sha256 after renumbering.
--
-- THE GAP. A released result, a dispensing, a reversal and a withdrawn
-- result reach the ordering doctor nowhere today. LabResultReleased and
-- MedicationDispensed reach only the patient, as generic text; reversals,
-- corrections and invalidations reach nobody.
--
-- WHAT IT DOES
-- N1 ehr.order_notices: one row per notice, ids and times only. The order
--    (kind and id), the patient, the route (null for own work), the notice
--    kind, how many events it covers, the first and last event's time, the
--    last event's source ids, row_version, read_at, needs_seen, Seen (time,
--    account, membership), and the recipient: recipient_account_id and
--    ordering_facility_id, stored when the notice is written. One CHECK, on
--    kind. One foreign key, patient_id to identity.patients (on delete
--    restrict), so ID-8b finds the table; the owner put it on ID-8b's
--    "moved" list (Q127 A): on a merge the notice moves to the kept record
--    with its order, the merge manifest records it, legal holds follow it.
--    Row-level security on, not forced, no policy, no grant: the owner's
--    only. Indexes: the unread and unseen list (facility, recipient, last
--    event, id) where read_at is null or (needs_seen and seen_at is null);
--    the same columns for every row; the merge key, unique (order kind,
--    order id, kind) where read_at is null and not needs_seen; the critical
--    key, unique (result id, result version) where needs_seen.
-- N2 ehr.order_notice_gaps: one row for each notice that was not written:
--    time, source table and row id, SQLSTATE or reason, and the kind and
--    order kind when known. No patient id, no CHECK, no foreign key (as
--    0148's table). The owner's only.
-- N3 ehr.order_notice_switch: one row, on. The owner may turn it off (an
--    UPDATE, no DDL); then the triggers write no notice and no gap. Read by
--    its primary key. The owner's only, not platform.control_settings.
-- N4 Four AFTER INSERT triggers, each named zz_order_notice, on
--    lab.result_releases, lab.result_invalidations, pharmacy.dispensings and
--    pharmacy.dispensing_reversals (origin mode, as 0086's return triggers).
--    AFTER triggers of one event fire in name order, so each fires after the
--    table's *_order_route_return trigger, which writes the route report a
--    routed notice is found by. The trigger functions are plpgsql, SECURITY
--    DEFINER, the owner's, and run in the same transaction. They find the
--    order and the doctor without reading an EHR order table:
--    - routed work: the route report (lab.order_route_result_reports kind
--      'released' by result and version; pharmacy.order_route_dispensing_reports
--      kind 'dispensed' by dispensing), then ehr.order_routes: the source
--      order, orderer_account_id, ordering_facility_id and patient_id. The
--      owner reads all three tables in any session (policies using true);
--    - own work: the work item (lab: through the execution's requested
--      test, as 0090's return function; pharmacy: the row's work item):
--      requested_by or prescribed_by, ordering_facility_id and the source
--      order. 0086's and 0100's validators make that account the order's
--      creator. A work item that has a route but no report, or that the
--      session's row-level security hides from the owner, gives a gap.
--    The kinds: lab_result_critical (the released version's flag is
--    critical_candidate: lab.result_revisions on the own path, the report's
--    copy on a route), lab_result_corrected (an earlier version of the
--    result was released), lab_result_ready (any other release),
--    prescription_dispensed (fill 1 only; refills write nothing),
--    dispensing_reversed (every reversal, refills included, pending owner
--    item 2), lab_result_withdrawn (an invalidation of a version released
--    on a route; one never released writes nothing and no gap). Critical
--    notices need Seen and never merge (the critical key, on conflict
--    nothing). The rest merge per order while unread: INSERT ... ON
--    CONFLICT on the merge key, whose arbiter repeats the index predicate,
--    adds 1 to the count, moves the last event and its source ids, and adds
--    1 to row_version.
--    A trigger never reads ehr.order_notices (it only inserts, with ON
--    CONFLICT): a plain read there made two SERIALIZABLE releases on
--    different orders fail, 3 times in 3 (Rahman). Their bodies name no EHR
--    order table, so 0133's S7 list does not change for them.
--    A trigger never refuses the event. Its own block catches every error
--    but 40001, which it raises again, and 40P01, which it raises again
--    unless the transaction is READ COMMITTED (lab-api's and pharmacy-api's
--    SERIALIZABLE commands retry both; the four 0088/0090 route commands run
--    READ COMMITTED with one attempt, so there a deadlock becomes a gap).
--    57014 (cancel, statement timeout) is never caught. A caught error, or a
--    notice it cannot place, writes a gap row in its own nested block, which
--    only warns if it fails, and the WARNING "ORD-11: order notice not
--    written (SQLSTATE x, kind y)" with no ids. Each firing opens one
--    subtransaction, and a gap one more.
-- N5 The definers, for hid_ehr_runtime only, plpgsql, SECURITY DEFINER:
--    ehr.order_notice_summary(), ehr.list_order_notices(state, cursor,
--    limit), ehr.mark_order_notices_read(ids, versions) and
--    ehr.mark_order_notice_seen(id). Each uses the session's account
--    (auth.account_id_for_subject), facility and membership, needs that
--    membership active and unheld at that facility, direct care, and the
--    kind's permission (ehr.lab-request.read for lab notices,
--    ehr.prescription.read for dispensing notices), and touches only rows
--    whose recipient_account_id and ordering_facility_id match. A sibling
--    membership of the same person at the same facility sees the same
--    notices.
--    - Summary: per kind, the unread count and the critical count not Seen
--      (a critical notice read but not Seen still counts). It reads the
--      unread index only: no order read, no audit row.
--    - List: critical notices not Seen first, then newest first (last
--      event, id), 1-50 a page (20 by default), keyset by notice id. state
--      'unread' lists unread notices and critical ones not Seen; 'all' every
--      notice. For each row it reads the order by id under the order
--      table's row-level security in this session and asks
--      ehr.context_allows(patient, facility, 'read_records') itself, so a
--      superuser owner and a NOBYPASSRLS owner answer alike. A row whose
--      order the session may not read now is access_ended: no patient, no
--      card, no visit and no display. Patient and display come from the
--      order, so a merged record never shows the wrong patient. Each row
--      carries its version (row_version). Audited inside: one
--      ehr.order-notice.list row and one .list.shown row per patient shown.
--    - Mark read: 1-100 (notice id, version) pairs. Only rows at that
--      version and unread change; a changed row stays unread, is not
--      counted and raises nothing. Never needs access; never clears
--      needs_seen. Answers how many changed. One ehr.order-notice.read audit
--      row per patient of the rows changed.
--    - Seen: the session must be able to read the order now (42501
--      ORDER_NOTICE_CONSENT_REQUIRED otherwise; ehr-api answers 403
--      CONSENT_REQUIRED). Records the time, account and membership, and is
--      final. A critical notice, which never merges, is marked read too if
--      it was not. An ordinary one is not: an event may have merged in since
--      the list showed it, so only mark read, with the version, reads it.
--      One ehr.order-notice.seen audit row naming the patient. Answers the
--      notice.
--    The list and Seen read ehr.lab_requests and ehr.prescriptions by id;
--    0133's S7 list, 0148's 1g and 0154's 1d gain those two.
-- N6 ehr.sweep_order_notices(batch), for hid_ehr_runtime, as 0141's: up to
--    batch (1-1000) notices past their time, oldest first, with one
--    ehr.order-notice.expire audit row each, then up to batch gap rows
--    older than 90 days; answers how many rows went. A read notice goes 90
--    days after reading, a critical one 90 days after Seen, an unread
--    ordinary one 90 days after its last event; a critical notice never
--    Seen stays (owner item 3, proposed). A notice under an unreleased legal
--    hold on its recipient, its Seen account or its patient is kept. It
--    reads only the two tables and, through ehr.order_notice_held, the
--    holds, so it works inside withSystemTransaction.
-- N7 ehr.order_notice_held(patient, recipient, seen by): plpgsql, owned by
--    platform.legal_holds' owner (whose policy alone reads the holds), with
--    EXECUTE for this file's owner only, as 0141's.
--
-- 0. Preconditions (catalog reads only, no table lock; 55000, or 42501 for
--    the owner; nothing applied): 0154 applied (its marker:
--    pharmacy.dispensings.fill_number, smallint NOT NULL); not applied yet,
--    and none of this file's names in use; platform.legal_holds and its
--    owner policy (as 0141); every column the bodies read, by name and type
--    (identity.patients' card columns in 0143's form); every function the
--    bodies call, both work-item validators and the four return functions,
--    by md5 of their text (0154 e2's form; a function missing at its
--    signature counts as a mismatch); the four tables' triggers exactly, as
--    Release E and 0154 left them, accepting only Billing's two (below);
--    one owner (0148's e and f) over the four trigger tables, both
--    work-item tables, the lab tables the own path reads, the three route
--    tables, the order tables, identity.patients, the memberships and the
--    audit log, owning or able to run every pinned function, with CREATE on
--    ehr; no hid_ role a member of that owner.
-- 1. Act as the owner for the rest of the transaction.
-- 2. Locks (below).
-- 3. Under the locks: 0154's fill_number CHECK by its definition (printing
--    it opens pharmacy.dispensings); every policy of ehr.order_routes,
--    lab.order_route_result_reports and pharmacy.order_route_dispensing_reports
--    by name and md5 of command, permissive flag, roles and printed
--    expressions (0154's 3c form): today 0086's four command policies on
--    each, none restrictive, no other; the two permission codes exist and
--    are active.
-- 4. N1-N3, the switch row (on), then N4's functions and triggers.
-- 5. N5-N7.
-- 6. Grants and comments (here and in runtime-grants.sql).
-- 7. Post-checks (55000, nothing applied): every new function exactly (md5,
--    owner, plpgsql, SECURITY DEFINER, volatility, search_path pg_catalog,
--    pg_temp, result, EXECUTE); each new trigger as 0152 pins its own
--    (tgtype 5, tgfoid, tgenabled 'O', tgqual null, tgattr empty, tgnargs
--    0); each table's triggers exactly, zz_order_notice after its
--    *_order_route_return in name order; the three tables' columns, keys,
--    indexes and CHECK; RLS on and not forced, no policy, no grant; the
--    switch row present and on; no notice and no gap row; a probe, undone:
--    mark read refuses 101 pairs (it opens no table to do so).
--
-- Locks. Section 2, one DO block, each attempt in its own subtransaction:
-- ACCESS SHARE NOWAIT on ehr.order_routes, lab.order_route_result_reports,
-- pharmacy.order_route_dispensing_reports (section 3 prints their policies),
-- auth.permissions (section 3 reads the two codes) and platform.legal_holds
-- (the post-check prints its owner policy); then SHARE ROW
-- EXCLUSIVE NOWAIT on lab.result_releases, lab.result_invalidations,
-- pharmacy.dispensings and pharmacy.dispensing_reversals (CREATE TRIGGER;
-- it also covers the print of 0154's CHECK) and identity.patients (the new
-- foreign key), so an attempt that fails never holds the strong locks. A
-- busy table fails the attempt at once and its subtransaction releases what
-- it took; the attempt is made again every 100 ms for at most 5 seconds,
-- then 55P03 "0159: ... stayed busy for 5 seconds; nothing applied; run the
-- release again at a quieter time". When this transaction already holds an
-- earlier migration's locks (the runner's dry run of every pending file;
-- its own ledger table aside), one attempt and no sleep: 55P03 "0159: ...
-- so it does not wait; nothing applied; ..." at once. Both texts end as the
-- runner's busy-refusal pattern wants (services/ehr-api/scripts/
-- dry-run-attempts.mjs). Not ehr.lab_requests or ehr.prescriptions: no
-- trigger reads them, and the definers are plpgsql, so creating them opens
-- no table. No new function declares a %ROWTYPE or %TYPE, so compiling one
-- opens no table either.
-- What waits, from section 2 to commit: lab releases, invalidations,
-- dispensings and reversals, and every insert or update of a patient (SHARE
-- ROW EXCLUSIVE stops writes). Reads of all five go on, and so do reads and
-- writes of the route tables, the permissions and the holds (ACCESS SHARE
-- stops only DDL). Nothing fails unless its own lock_timeout or
-- statement_timeout is shorter than the hold. Behind an open writer of one
-- of the five tables, an autovacuum of one (SHARE UPDATE EXCLUSIVE), or DDL
-- on any of the ten, the file stops
-- after 5 seconds, nothing applied. In the dry run the locks last until the
-- dry run ends. 0159 ships in a release of its own, so the dry-run hold is
-- 0159's alone.
-- Measured on throwaway PostgreSQL 16, Release E with 0154 and the runtime
-- roles (fictional data), ten runs with a superuser applier and ten with a
-- NOSUPERUSER NOBYPASSRLS applier: the file takes 40-53 ms to commit; the
-- hold, from section 2 to commit, is 25-35 ms in all 20 runs. Nothing in
-- the file scans a table (the foreign key is on a new, empty table), so the
-- hold does not grow with data. Behind another session's open writer of
-- pharmacy.dispensings or identity.patients, or DDL on ehr.order_routes,
-- the file stops with section 2's 55P03 after 4.99-5.00 seconds, nothing
-- applied; with an earlier migration's lock held in the same transaction
-- it stops at once (32 ms) with the one-attempt text; an open reader of
-- pharmacy.dispensings does not stop it (55 ms).
-- Subtransactions: each firing opens one, a gap one more. The most firings
-- in one transaction come from a 0088 or 0090 correction: one invalidation
-- per result of the route's work item (one requested test per work item,
-- one result per specimen run, so usually one) and one reversal. Past 64
-- in one transaction a backend's subtransaction cache overflows (slower
-- visibility checks elsewhere until it ends; no error).
-- Index plans, 100,000 notices: the summary and the unread list read
-- order_notices_unread_idx, state 'all' reads order_notices_recipient_idx;
-- each under 1 ms for a recipient with 500 notices.
-- The database suites on both owner kinds write no gap row (no WARNING in
-- any suite's output). The count check below balances in the five route
-- suites, 0088's and 0090's corrections included (12, 12, 12, 15 and 28
-- source rows, as many events, no gap), and in the own-work suite but for
-- one routed dispensing it inserts in replica mode (9 rows, 8 events).
--
-- Other lanes. The trigger preconditions and post-checks accept exactly
-- these additions when present, and refuse anything else: Billing's
-- zz_billing_stock_and_gate (commercial.hook_dispensing(), BEFORE INSERT,
-- origin) on pharmacy.dispensings and zz_billing_reversal
-- (commercial.hook_dispensing_reversal(), BEFORE INSERT, origin) on
-- pharmacy.dispensing_reversals (#336). Billing's BEFORE triggers always
-- fire before these AFTER ones; when they refuse, nothing is inserted, so
-- no notice and no gap. Billing applied after 0159 accepts other lanes'
-- triggers and counts only its own.
--
-- Old services on this schema. Nothing they call changes. A notice is
-- written inside their own transactions: lab-api's release (SERIALIZABLE),
-- pharmacy-api's dispensing and reversal (SERIALIZABLE), and 0088's and
-- 0090's route commands (READ COMMITTED). Two releases or dispensings on the
-- same order at once may meet 40001 on the merge key, which both services
-- already retry. No lab-api or pharmacy-api change.
--
-- Release notes. Order: 0154, then this file alone at its final number,
-- then ehr-api (the routes; 42883 from a definer means this file is not
-- applied: 503 ORDER_NOTICES_UNAVAILABLE), then the website. Either service
-- may roll back; notices wait in the table. The count check runs as the
-- superuser on the rehearsal copy before switch-on and before the first
-- sweep: per (order kind, order id, kind), the source rows inserted in
-- origin mode after this file's applied_at (less fills above 1 and
-- invalidations of versions never released) equal the sum of event_count
-- over its notice rows plus its gap rows. Gaps must be zero. The triggers
-- fire in origin mode only, as 0086's return triggers: a replica-mode insert
-- writes no notice and no gap.
--
-- Undo (by hand only; owner-signed). The tables stay; old images never read
-- them.
-- 1. As the owner: update ehr.order_notice_switch set enabled = false,
--    changed_at = clock_timestamp(); (no DDL: ROW EXCLUSIVE on the switch
--    table only). The triggers then write nothing.
-- 2. If DDL is needed: alter table ... disable trigger zz_order_notice on
--    each of the four tables, NOWAIT in a loop as section 2. It takes SHARE
--    ROW EXCLUSIVE: writes wait, reads do not.
-- 3. Later, in a quiet window: set lock_timeout = '100ms'; drop trigger
--    zz_order_notice on each table, repeated until it succeeds (DROP TRIGGER
--    takes ACCESS EXCLUSIVE, so every read queues behind it while it waits;
--    0148's form). Then the definers can go once no ehr-api calls them, and
--    their lines leave runtime-grants.sql in the same release.
-- The ledger row stays; precondition b refuses a second apply.

-- 0. Preconditions.
do $$
declare
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  owner_oid oid;
  holds_owner oid;
begin
  -- a. 0154 applied: its column pharmacy.dispensings.fill_number, the only
  -- object of 0154 this file uses (catalog only).
  if not exists (select 1 from pg_attribute attribute_row
                  where attribute_row.attrelid = to_regclass('pharmacy.dispensings')
                    and attribute_row.attname = 'fill_number' and not attribute_row.attisdropped
                    and attribute_row.attnotnull
                    and format_type(attribute_row.atttypid, attribute_row.atttypmod) = 'smallint') then
    raise exception using errcode = '55000', message = '0159: 0001-0154 must be applied first';
  end if;
  -- b. Already applied: the three tables, the switch row's table and the
  -- four triggers are there. Nothing changes.
  if to_regclass('ehr.order_notices') is not null and to_regclass('ehr.order_notice_gaps') is not null
     and to_regclass('ehr.order_notice_switch') is not null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgname = 'zz_order_notice' and not trigger_row.tgisinternal
             and trigger_row.tgrelid in (to_regclass('lab.result_releases'), to_regclass('lab.result_invalidations'),
                   to_regclass('pharmacy.dispensings'), to_regclass('pharmacy.dispensing_reversals'))) = 4 then
    raise exception using errcode = '55000', message = '0159: already applied';
  end if;
  -- c. None of this file's names is in use (a hand-made or half-undone
  -- schema): no relation of its names in ehr, no function in ehr named
  -- order_notice_* or as one of its definers (any signature), no trigger
  -- named zz_order_notice.
  if exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
              where namespace.nspname = 'ehr'
                and relation.relname in ('order_notices', 'order_notice_gaps', 'order_notice_switch',
                      'order_notices_pkey', 'order_notice_gaps_pkey', 'order_notice_switch_pkey',
                      'order_notices_unread_idx', 'order_notices_recipient_idx', 'order_notices_merge_key',
                      'order_notices_critical_key'))
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'order\_notice\_%' or proc.proname in ('list_order_notices',
                         'mark_order_notices_read', 'mark_order_notice_seen', 'sweep_order_notices')))
     or exists (select 1 from pg_trigger trigger_row
                 where not trigger_row.tgisinternal and trigger_row.tgname = 'zz_order_notice') then
    raise exception using errcode = '55000',
      message = '0159: a table, function or trigger of this file''s names exists already, but this file is not '
        || 'applied as a whole; nothing applied';
  end if;
  -- d. 0096's legal holds, which only their owner may read (as 0141).
  if to_regclass('platform.legal_holds') is null
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'platform.legal_holds'::regclass
                       and policy_row.polname = 'legal_holds_owner') then
    raise exception using errcode = '55000', message = '0159: platform.legal_holds (0096) is not as this file reads it';
  end if;
  -- e. Every column the new bodies read, by name and type. The decision is
  -- an EXISTS over the absent columns (never null); the list only names them.
  with expected(schema_name, relation_name, column_names) as (values
         ('lab', 'result_releases', array['id uuid', 'result_id uuid', 'execution_id uuid', 'result_version bigint',
           'released_at timestamp with time zone']),
         ('lab', 'result_invalidations', array['id uuid', 'result_id uuid', 'result_version bigint',
           'occurred_at timestamp with time zone']),
         ('lab', 'result_revisions', array['result_id uuid', 'version bigint', 'abnormal_flag text']),
         ('lab', 'test_executions', array['id uuid', 'requested_test_id uuid']),
         ('lab', 'work_item_requested_tests', array['id uuid', 'work_item_id uuid']),
         ('lab', 'work_items', array['id uuid', 'patient_id uuid', 'ordering_facility_id uuid',
           'source_ehr_order_id uuid', 'requested_by uuid', 'order_route_id uuid']),
         ('pharmacy', 'dispensings', array['id uuid', 'work_item_id uuid', 'dispensed_at timestamp with time zone',
           'fill_number smallint']),
         ('pharmacy', 'dispensing_reversals', array['id uuid', 'dispensing_id uuid', 'work_item_id uuid',
           'reversed_at timestamp with time zone']),
         ('pharmacy', 'work_items', array['id uuid', 'patient_id uuid', 'ordering_facility_id uuid',
           'source_ehr_prescription_id uuid', 'prescribed_by uuid', 'order_route_id uuid']),
         ('ehr', 'order_routes', array['id uuid', 'kind text', 'patient_id uuid', 'ordering_facility_id uuid',
           'source_lab_request_id uuid', 'source_prescription_id uuid', 'orderer_account_id uuid']),
         ('lab', 'order_route_result_reports', array['route_id uuid', 'result_id uuid', 'result_version bigint',
           'kind text', 'abnormal_flag text']),
         ('pharmacy', 'order_route_dispensing_reports', array['route_id uuid', 'dispensing_id uuid', 'kind text']),
         ('ehr', 'lab_requests', array['id uuid', 'patient_id uuid', 'facility_id uuid', 'encounter_id uuid',
           'test_display text']),
         ('ehr', 'prescriptions', array['id uuid', 'patient_id uuid', 'facility_id uuid', 'encounter_id uuid',
           'medication_display text']),
         ('identity', 'patients', array['id uuid', 'full_name text', 'gender text', 'dob date', 'hid_code text']),
         ('identity', 'staff_facility_memberships', array['id uuid', 'account_id uuid', 'facility_id uuid',
           'organization_id uuid', 'active boolean', 'migration_hold_reason text']),
         ('platform', 'legal_holds', array['subject_type text', 'subject_id uuid',
           'released_at timestamp with time zone'])),
       absent as (
         select expected.schema_name, expected.relation_name, wanted.column_name
           from expected cross join unnest(expected.column_names) wanted(column_name)
          where not exists (
            select 1 from pg_attribute attribute_row
              join pg_class relation on relation.oid = attribute_row.attrelid
              join pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = expected.schema_name and relation.relname = expected.relation_name
               and relation.relkind = 'r' and attribute_row.attnum > 0 and not attribute_row.attisdropped
               and attribute_row.attname || ' ' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
                   = wanted.column_name))
  select exists (select 1 from absent),
         (select string_agg(format('%s.%s.%s', absent.schema_name, absent.relation_name, absent.column_name), '; ')
            from absent)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0159: a column this migration relies on is missing or of another type: %s', missing);
  end if;
  -- f. Every function the new bodies call, both work-item validators (they
  -- make the stored account the order's creator) and the four return
  -- functions (they write the reports a routed notice is found by, and fire
  -- before this file's triggers), by md5 of their text (0154 e2's form). A
  -- function missing at its signature counts as a mismatch.
  with expected(schema_name, proc_name, argument_types, digest) as (values
         ('ehr', 'context_allows', 'uuid, uuid, text', '75016690184a80bd246c365b4d108082'),
         ('identity', 'has_active_consent_grant', 'uuid, text, uuid, uuid, text, text, timestamp with time zone',
           '732d11892dd4e27e1ff9093ae3b7de5a'),
         ('auth', 'membership_has_permission', 'text, uuid, uuid, text', '65e3eaff93fe729fd5c5b986b80c9dd6'),
         ('identity', 'has_active_membership', 'text, uuid, uuid', 'bb52953ef1cd08527db61230a671859e'),
         ('auth', 'account_id_for_subject', 'text', '4678770cf6a210034740f09422fdfbaa'),
         ('platform', 'current_facility_id', '', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
         ('platform', 'current_account_id', '', 'b715ffe72856836d13ab16656fa6e94a'),
         ('platform', 'current_membership_id', '', '641989704fea95f885fbc38c6feb5aa5'),
         ('platform', 'current_actor_subject', '', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
         ('platform', 'current_purpose_of_use', '', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
         ('platform', 'current_correlation_id', '', '48d3bf187101d33bfda51dac829aa223'),
         ('lab', 'validate_work_item', '', 'efac15072e0a6e68dff199026ff6f73e'),
         ('pharmacy', 'validate_work_item', '', 'e2411539ee8c95a02dad46c03e24db05'),
         ('lab', 'return_order_route_result', '', '10f7b7726a59488cd6ae6f9e55c4c568'),
         ('lab', 'return_order_route_invalidation', '', '2176bfd64b05c6e357021c178060f1b7'),
         ('pharmacy', 'return_order_route_dispensing', '', 'da0017a88bb938cd0fcbba50fdadaa11'),
         ('pharmacy', 'return_order_route_reversal', '', '7cf0067c59c502026be74e292a8989ab')),
       differing as (
         select expected.*,
                (select string_agg(md5(proc.prosrc), ',') from pg_proc proc
                   join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = expected.schema_name and proc.proname = expected.proc_name
                    and pg_catalog.oidvectortypes(proc.proargtypes) = expected.argument_types) as found
           from expected
          where not exists (
            select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
             where namespace.nspname = expected.schema_name and proc.proname = expected.proc_name
               and pg_catalog.oidvectortypes(proc.proargtypes) = expected.argument_types
               and md5(proc.prosrc) = expected.digest))
  select exists (select 1 from differing),
         (select string_agg(format('%s.%s(%s) md5 %s', differing.schema_name, differing.proc_name,
                   differing.argument_types, coalesce(differing.found, 'none (missing)')), '; ') from differing)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0159: a function this migration relies on differs from 0001-0154: %s', missing);
  end if;
  -- g. The four tables' triggers, by name, function, type and mode (0154 g's
  -- form), exactly as Release E and 0154 left them; Billing's one trigger on
  -- each dispensing table is accepted when present, and nothing else.
  with expected(relation_name, base, extra) as (values
         ('lab.result_releases', array[
           'lab_release_validate:lab.validate_result_governance():7:O',
           'lab_releases_immutable:lab.reject_immutable_evidence():27:O',
           'result_releases_order_route_return:lab.return_order_route_result():5:O'], null::text),
         ('lab.result_invalidations', array[
           'lab_invalidation_validate:lab.validate_result_governance():7:O',
           'lab_invalidations_immutable:lab.reject_immutable_evidence():27:O',
           'result_invalidations_order_route_return:lab.return_order_route_invalidation():5:O'], null::text),
         ('pharmacy.dispensings', array[
           'dispensings_claim_prescription:pharmacy.claim_prescription_dispensing():5:A',
           'dispensings_order_route_return:pharmacy.return_order_route_dispensing():5:O',
           'pharmacy_dispensing_validate:pharmacy.validate_dispensing():7:O',
           'pharmacy_dispensings_immutable:pharmacy.reject_immutable_evidence():27:O',
           'prescription_claim_key_immutable:pharmacy.refuse_claim_key_change():19:A'],
           'zz_billing_stock_and_gate:commercial.hook_dispensing():7:O'),
         ('pharmacy.dispensing_reversals', array[
           'dispensing_reversals_order_route_return:pharmacy.return_order_route_reversal():5:O',
           'pharmacy_dispensing_reversal_validate:pharmacy.validate_dispensing_reversal():7:O',
           'pharmacy_dispensing_reversals_immutable:pharmacy.reject_immutable_evidence():27:O'],
           'zz_billing_reversal:commercial.hook_dispensing_reversal():7:O')),
       present as (
         select expected.relation_name, expected.base, expected.extra,
                (select array_agg(trigger_row.tgname::text || ':' || trigger_row.tgfoid::regprocedure::text || ':'
                          || trigger_row.tgtype::text || ':' || trigger_row.tgenabled::text
                          order by trigger_row.tgname::text collate "C")
                   from pg_trigger trigger_row
                  where trigger_row.tgrelid = to_regclass(expected.relation_name) and not trigger_row.tgisinternal)
                  as triggers
           from expected),
       differing as (
         select present.relation_name from present
          where present.triggers is distinct from present.base
            and (present.extra is null or present.triggers is distinct from present.base || present.extra))
  select string_agg(differing.relation_name, ', ') into missing from differing;
  if missing is not null then
    raise exception using errcode = '55000',
      message = format('0159: the triggers on %s are not the ones Release E and 0154 left (Billing''s two aside)',
        missing);
  end if;
  -- h. One owner (0148's e and f), never through a superuser's bypass
  -- (production's owner and applier have neither superuser nor BYPASSRLS):
  -- pharmacy.work_items' owner owns every table this file touches and both
  -- validators, and owns or may run every other pinned function; the applier
  -- is that owner, or inherits it and may SET ROLE to it; that owner may
  -- create in ehr and use the schemas the bodies name.
  owner_oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  holds_owner := (select relation.relowner from pg_class relation where relation.oid = 'platform.legal_holds'::regclass);
  with owned_tables(relation_name) as (values
         ('lab.result_releases'), ('lab.result_invalidations'), ('pharmacy.dispensings'),
         ('pharmacy.dispensing_reversals'), ('lab.work_items'), ('pharmacy.work_items'), ('lab.result_revisions'),
         ('lab.test_executions'), ('lab.work_item_requested_tests'), ('ehr.order_routes'),
         ('lab.order_route_result_reports'), ('pharmacy.order_route_dispensing_reports'), ('ehr.lab_requests'),
         ('ehr.prescriptions'), ('identity.patients'), ('identity.staff_facility_memberships'), ('audit.events')),
       owned_functions(signature) as (values
         ('lab.validate_work_item()'), ('pharmacy.validate_work_item()'), ('lab.return_order_route_result()'),
         ('lab.return_order_route_invalidation()'), ('pharmacy.return_order_route_dispensing()'),
         ('pharmacy.return_order_route_reversal()')),
       executed_functions(signature) as (values
         ('ehr.context_allows(uuid,uuid,text)'),
         ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'),
         ('auth.membership_has_permission(text,uuid,uuid,text)'), ('identity.has_active_membership(text,uuid,uuid)'),
         ('auth.account_id_for_subject(text)'), ('platform.current_facility_id()'), ('platform.current_account_id()'),
         ('platform.current_membership_id()'), ('platform.current_actor_subject()'),
         ('platform.current_purpose_of_use()'), ('platform.current_correlation_id()')),
       foreign_owned as (
         select owned_tables.relation_name as what from owned_tables
          where not exists (select 1 from pg_class relation
                             where relation.oid = to_regclass(owned_tables.relation_name)
                               and relation.relowner = owner_oid)
         union all
         select owned_functions.signature from owned_functions
          where not exists (select 1 from pg_proc proc
                             where proc.oid = to_regprocedure(owned_functions.signature) and proc.proowner = owner_oid)
         union all
         select executed_functions.signature || ' (neither owned nor executable)' from executed_functions
          where not exists (select 1 from pg_proc proc
                             where proc.oid = to_regprocedure(executed_functions.signature)
                               and (proc.proowner = owner_oid or has_function_privilege(owner_oid, proc.oid, 'EXECUTE'))))
  select exists (select 1 from foreign_owned), (select string_agg(foreign_owned.what, ', ') from foreign_owned)
    into found_absent, missing;
  if owner_oid is null or holds_owner is null or found_absent then
    raise exception using errcode = '42501',
      message = format('0159: these are not owned by %s, the owner of pharmacy.work_items: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), coalesce(missing, 'platform.legal_holds has no owner'));
  end if;
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '42501',
      message = format('0159: %s must own, or inherit from and be able to SET ROLE to, %s, the owner of the tables '
        || 'this file reads and of the four it adds triggers to', current_user, pg_get_userbyid(owner_oid));
  end if;
  with wanted(schema_name, privilege) as (values
         ('ehr', 'CREATE'), ('ehr', 'USAGE'), ('lab', 'USAGE'), ('pharmacy', 'USAGE'), ('identity', 'USAGE'),
         ('auth', 'USAGE'), ('platform', 'USAGE'), ('audit', 'USAGE')),
       lacking as (
         select wanted.* from wanted
          where not exists (select 1 from pg_namespace namespace
                             where namespace.nspname = wanted.schema_name
                               and has_schema_privilege(owner_oid, namespace.oid, wanted.privilege)))
  select exists (select 1 from lacking),
         (select string_agg(format('%s on schema %s', lacking.privilege, lacking.schema_name), ', ') from lacking)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501', message = format('0159: %s lacks %s', pg_get_userbyid(owner_oid), missing);
  end if;
  -- i. No hid_ role is a member of that owner (0133's form): the owner's
  -- functions are not reachable by a runtime role except through EXECUTE.
  select string_agg(role_row.rolname, ', ' order by role_row.rolname) into missing from pg_roles role_row
   where role_row.rolname like 'hid\_%' and role_row.oid <> owner_oid
     and pg_has_role(role_row.oid, owner_oid, 'MEMBER');
  if missing is not null then
    raise exception using errcode = '55000',
      message = format('0159: these roles are members of %s, the owner of the tables this file reads: %s',
        pg_get_userbyid(owner_oid), missing);
  end if;
  raise notice '0159: preconditions checked; applier %; owner %', current_user, pg_get_userbyid(owner_oid);
end
$$;

-- 1. Act as the owner for the rest of this transaction (a no-op when the
-- applier is the owner, as on every database built by one migration login).
do $$
declare
  owner_name text := (select pg_get_userbyid(relation.relowner) from pg_class relation
                       where relation.oid = 'pharmacy.work_items'::regclass);
begin
  if owner_name <> current_user then
    execute format('set local role %I', owner_name);
  end if;
end
$$;

-- 2. Locks (see Locks), NOWAIT, at most 5 s: ACCESS SHARE on the five
-- tables section 3 and the post-check read, then SHARE ROW EXCLUSIVE on the
-- five this file adds a trigger or a foreign key to, so an attempt that
-- fails never holds the strong ones. A failed attempt's subtransaction
-- releases what it took.
-- When this transaction already holds a lock that stops other sessions'
-- reads or writes of a table (an earlier migration in the same transaction,
-- as in the runner's dry run; the runner's own ledger table aside), one
-- attempt only and no sleep.
do $$
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
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.order_routes, lab.order_route_result_reports, pharmacy.order_route_dispensing_reports,
        auth.permissions, platform.legal_holds in access share mode nowait;
      lock table lab.result_releases, lab.result_invalidations, pharmacy.dispensings, pharmacy.dispensing_reversals,
        identity.patients in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0159: a lab result, dispensing or patient table, or a table 0159 reads (the order routes, '
            || 'their reports, the permissions or the legal holds), is busy, and this transaction already holds an earlier '
            || 'migration''s locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0159: a lab result, dispensing or patient table, or a table 0159 reads (the order routes, '
            || 'their reports, the permissions or the legal holds), stayed busy for 5 seconds; nothing applied; run the release '
            || 'again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;

-- 3. Under the locks: what prints a CHECK or a policy (pg_get_constraintdef
-- and pg_get_expr open the table they print for; every table printed here
-- is held by section 2), and the two permission codes. Each failure raises
-- 55000 and nothing is applied.
do $$
declare
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  mismatch text;
begin
  -- a. 0154's CHECK on fill_number, validated, by its definition: fill 1 is
  -- the first fill, the only one that writes a notice.
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'pharmacy.dispensings'::regclass
                    and constraint_row.conname = 'dispensings_fill_number_ck' and constraint_row.contype = 'c'
                    and constraint_row.convalidated
                    and pg_get_constraintdef(constraint_row.oid)
                        = 'CHECK (((fill_number >= 1) AND (fill_number <= 12)))') then
    raise exception using errcode = '55000',
      message = '0159: pharmacy.dispensings does not have 0154''s CHECK dispensings_fill_number_ck';
  end if;
  -- b. Every policy of the three route tables, each by name and the md5 of
  -- its command, permissive flag, roles (PUBLIC, or the owner alone) and
  -- printed expressions (0154's 3c form): 0086's four command policies on
  -- each, none restrictive, no other. So the owner reads every route and
  -- report in any session, as the triggers need.
  with expected(relation_name, policy_name, digest) as (values
         ('ehr.order_routes', 'order_routes_command_delete', '926eac05c08bd86fc93cad480d5f3554'),
         ('ehr.order_routes', 'order_routes_command_insert', '49a76c15a08b754003960e1fbe147098'),
         ('ehr.order_routes', 'order_routes_command_read', 'd2498e08e15b6dd0e628aa0903f48fc1'),
         ('ehr.order_routes', 'order_routes_command_update', '49c5d8e7b0e30d83d3fb25d19fad7649'),
         ('lab.order_route_result_reports', 'order_route_result_reports_command_delete',
           '926eac05c08bd86fc93cad480d5f3554'),
         ('lab.order_route_result_reports', 'order_route_result_reports_command_insert',
           '49a76c15a08b754003960e1fbe147098'),
         ('lab.order_route_result_reports', 'order_route_result_reports_command_read',
           'd2498e08e15b6dd0e628aa0903f48fc1'),
         ('lab.order_route_result_reports', 'order_route_result_reports_command_update',
           '49c5d8e7b0e30d83d3fb25d19fad7649'),
         ('pharmacy.order_route_dispensing_reports', 'order_route_dispensing_reports_command_delete',
           '926eac05c08bd86fc93cad480d5f3554'),
         ('pharmacy.order_route_dispensing_reports', 'order_route_dispensing_reports_command_insert',
           '49a76c15a08b754003960e1fbe147098'),
         ('pharmacy.order_route_dispensing_reports', 'order_route_dispensing_reports_command_read',
           'd2498e08e15b6dd0e628aa0903f48fc1'),
         ('pharmacy.order_route_dispensing_reports', 'order_route_dispensing_reports_command_update',
           '49c5d8e7b0e30d83d3fb25d19fad7649')),
       present as (
         select case policy_row.polrelid when 'ehr.order_routes'::regclass then 'ehr.order_routes'
                  when 'lab.order_route_result_reports'::regclass then 'lab.order_route_result_reports'
                  else 'pharmacy.order_route_dispensing_reports' end as relation_name,
                policy_row.polname::text as policy_name,
                md5(policy_row.polcmd::text || ':' || policy_row.polpermissive::text || ':'
                    || case when policy_row.polroles = array[0::oid] then 'public'
                            when policy_row.polroles = array[owner_oid] then 'owner'
                            else policy_row.polroles::text end || ':'
                    || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-') || ':'
                    || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '-')) as digest
           from pg_policy policy_row
          where policy_row.polrelid in ('ehr.order_routes'::regclass, 'lab.order_route_result_reports'::regclass,
                  'pharmacy.order_route_dispensing_reports'::regclass)),
       differing as (
         select coalesce(expected.relation_name, present.relation_name) || '.'
                || coalesce(expected.policy_name, present.policy_name) as what
           from expected full join present
             on present.relation_name = expected.relation_name and present.policy_name = expected.policy_name
          where expected.digest is distinct from present.digest)
  select string_agg(differing.what, ', ' order by differing.what) into mismatch from differing;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0159: the policies of ehr.order_routes, lab.order_route_result_reports or '
        || 'pharmacy.order_route_dispensing_reports are not 0086''s: %s', mismatch);
  end if;
  -- c. The two permission codes the definers ask for exist and are active
  -- (this file adds no role row and pins no role list).
  if (select count(*) from auth.permissions permission_row
       where permission_row.code in ('ehr.lab-request.read', 'ehr.prescription.read') and permission_row.active) <> 2 then
    raise exception using errcode = '55000',
      message = '0159: the permissions ehr.lab-request.read and ehr.prescription.read are not both active';
  end if;
end
$$;

-- 4. N1: the notices. Ids and times only. One CHECK (kind) and one foreign
-- key (the patient, so ID-8b finds the table). The owner's only.
create table ehr.order_notices (
  id uuid not null default gen_random_uuid(),
  order_kind text not null,
  order_id uuid not null,
  patient_id uuid not null,
  order_route_id uuid,
  kind text not null,
  event_count integer not null default 1,
  first_event_at timestamptz not null,
  last_event_at timestamptz not null,
  source_table text not null,
  source_row_id uuid not null,
  result_id uuid,
  result_version bigint,
  dispensing_id uuid,
  recipient_account_id uuid not null,
  ordering_facility_id uuid not null,
  needs_seen boolean not null,
  read_at timestamptz,
  seen_at timestamptz,
  seen_by_account_id uuid,
  seen_by_membership_id uuid,
  row_version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  constraint order_notices_pkey primary key (id),
  constraint order_notices_kind_ck check (kind in ('lab_result_critical', 'lab_result_corrected', 'lab_result_ready',
    'lab_result_withdrawn', 'prescription_dispensed', 'dispensing_reversed')),
  constraint order_notices_patient_fk foreign key (patient_id) references identity.patients (id) on delete restrict
);
create index order_notices_unread_idx on ehr.order_notices
  (ordering_facility_id, recipient_account_id, last_event_at, id)
  where read_at is null or (needs_seen and seen_at is null);
create index order_notices_recipient_idx on ehr.order_notices
  (ordering_facility_id, recipient_account_id, last_event_at, id);
create unique index order_notices_merge_key on ehr.order_notices (order_kind, order_id, kind)
  where read_at is null and not needs_seen;
create unique index order_notices_critical_key on ehr.order_notices (result_id, result_version)
  where needs_seen;
alter table ehr.order_notices enable row level security;
revoke all on ehr.order_notices from public;

-- N2: the gaps. No patient id, no CHECK, no foreign key. The owner's only.
create table ehr.order_notice_gaps (
  id uuid not null default gen_random_uuid(),
  recorded_at timestamptz not null default clock_timestamp(),
  source_table text not null,
  source_row_id uuid,
  failure_state text,
  failure_reason text,
  kind text,
  order_kind text,
  constraint order_notice_gaps_pkey primary key (id)
);
alter table ehr.order_notice_gaps enable row level security;
revoke all on ehr.order_notice_gaps from public;

-- N3: the switch. One row, on. The owner's only.
create table ehr.order_notice_switch (
  singleton boolean not null default true,
  enabled boolean not null,
  changed_at timestamptz not null default clock_timestamp(),
  constraint order_notice_switch_pkey primary key (singleton),
  constraint order_notice_switch_one_row_ck check (singleton)
);
alter table ehr.order_notice_switch enable row level security;
revoke all on ehr.order_notice_switch from public;
insert into ehr.order_notice_switch (singleton, enabled) values (true, true);

-- N4: a gap row and its warning. Its own block, which only warns if the
-- row cannot be written.
create function ehr.order_notice_gap(gap_source_table text, gap_source_row_id uuid, gap_state text,
  gap_reason text, gap_kind text, gap_order_kind text)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  begin
    insert into ehr.order_notice_gaps (source_table, source_row_id, failure_state, failure_reason, kind, order_kind)
    values (gap_source_table, gap_source_row_id, gap_state, gap_reason, gap_kind, gap_order_kind);
  exception when others then
    raise warning 'ORD-11: order notice gap not recorded (SQLSTATE %)', sqlstate;
  end;
  raise warning 'ORD-11: order notice not written (%, kind %)',
    case when gap_state is not null then 'SQLSTATE ' || gap_state else 'reason ' || coalesce(gap_reason, '-') end,
    coalesce(gap_kind, 'unknown');
end
$$;

-- N4: writing one notice. A critical one never merges (its key: the result
-- and version, on conflict nothing); the rest merge per order while unread
-- (the arbiter repeats the merge key's predicate).
create function ehr.order_notice_write(notice_order_kind text, notice_order_id uuid, notice_patient_id uuid,
  notice_route_id uuid, notice_kind text, notice_event_at timestamptz, notice_source_table text,
  notice_source_row_id uuid, notice_result_id uuid, notice_result_version bigint, notice_dispensing_id uuid,
  notice_recipient_account_id uuid, notice_ordering_facility_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if notice_kind = 'lab_result_critical' then
    insert into ehr.order_notices (order_kind, order_id, patient_id, order_route_id, kind, first_event_at,
      last_event_at, source_table, source_row_id, result_id, result_version, dispensing_id, recipient_account_id,
      ordering_facility_id, needs_seen)
    values (notice_order_kind, notice_order_id, notice_patient_id, notice_route_id, notice_kind, notice_event_at,
      notice_event_at, notice_source_table, notice_source_row_id, notice_result_id, notice_result_version,
      notice_dispensing_id, notice_recipient_account_id, notice_ordering_facility_id, true)
    on conflict (result_id, result_version) where needs_seen do nothing;
  else
    insert into ehr.order_notices as notice (order_kind, order_id, patient_id, order_route_id, kind,
      first_event_at, last_event_at, source_table, source_row_id, result_id, result_version, dispensing_id,
      recipient_account_id, ordering_facility_id, needs_seen)
    values (notice_order_kind, notice_order_id, notice_patient_id, notice_route_id, notice_kind, notice_event_at,
      notice_event_at, notice_source_table, notice_source_row_id, notice_result_id, notice_result_version,
      notice_dispensing_id, notice_recipient_account_id, notice_ordering_facility_id, false)
    on conflict (order_kind, order_id, kind) where read_at is null and not needs_seen
    do update set event_count = notice.event_count + 1, last_event_at = excluded.last_event_at,
      source_table = excluded.source_table, source_row_id = excluded.source_row_id,
      result_id = excluded.result_id, result_version = excluded.result_version,
      dispensing_id = excluded.dispensing_id, row_version = notice.row_version + 1;
  end if;
end
$$;

-- N4: a released result. A route report first (written just before by the
-- route return trigger), else the own work item.
create function ehr.order_notice_from_release()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  report_route_id uuid;
  report_flag text;
  route_order_id uuid;
  route_patient_id uuid;
  route_facility_id uuid;
  route_orderer_id uuid;
  item_id uuid;
  item_route_id uuid;
  item_order_id uuid;
  item_patient_id uuid;
  item_facility_id uuid;
  item_requester_id uuid;
  released_flag text;
  released_before boolean;
  chosen_kind text;
  failure_state text;
begin
  begin
    if not coalesce((select switch_row.enabled from ehr.order_notice_switch switch_row
                      where switch_row.singleton), false) then
      return null;
    end if;
    select report.route_id, report.abnormal_flag into report_route_id, report_flag
      from lab.order_route_result_reports report
     where report.result_id = new.result_id and report.result_version = new.result_version
       and report.kind = 'released';
    if report_route_id is not null then
      select route.source_lab_request_id, route.patient_id, route.ordering_facility_id, route.orderer_account_id
        into route_order_id, route_patient_id, route_facility_id, route_orderer_id
        from ehr.order_routes route
       where route.id = report_route_id;
      if report_flag is null then
        perform ehr.order_notice_gap('lab.result_releases', new.id, null, 'flag_not_found', null, 'lab_request');
        return null;
      end if;
      released_before := exists (select 1 from lab.order_route_result_reports earlier
                                  where earlier.result_id = new.result_id
                                    and earlier.result_version < new.result_version and earlier.kind = 'released');
      chosen_kind := case when report_flag = 'critical_candidate' then 'lab_result_critical'
                          when released_before then 'lab_result_corrected' else 'lab_result_ready' end;
      perform ehr.order_notice_write('lab_request', route_order_id, route_patient_id, report_route_id, chosen_kind,
        new.released_at, 'lab.result_releases', new.id, new.result_id, new.result_version, null, route_orderer_id,
        route_facility_id);
      return null;
    end if;
    select item.id, item.order_route_id, item.source_ehr_order_id, item.patient_id, item.ordering_facility_id,
           item.requested_by
      into item_id, item_route_id, item_order_id, item_patient_id, item_facility_id, item_requester_id
      from lab.test_executions execution
      join lab.work_item_requested_tests requested on requested.id = execution.requested_test_id
      join lab.work_items item on item.id = requested.work_item_id
     where execution.id = new.execution_id;
    if item_id is null or item_route_id is not null then
      perform ehr.order_notice_gap('lab.result_releases', new.id, null,
        case when item_id is null then 'work_item_not_found' else 'route_report_missing' end, null, 'lab_request');
      return null;
    end if;
    select revision.abnormal_flag into released_flag
      from lab.result_revisions revision
     where revision.result_id = new.result_id and revision.version = new.result_version;
    if released_flag is null then
      perform ehr.order_notice_gap('lab.result_releases', new.id, null, 'flag_not_found', null, 'lab_request');
      return null;
    end if;
    released_before := exists (select 1 from lab.result_releases earlier
                                where earlier.result_id = new.result_id
                                  and earlier.result_version < new.result_version);
    chosen_kind := case when released_flag = 'critical_candidate' then 'lab_result_critical'
                        when released_before then 'lab_result_corrected' else 'lab_result_ready' end;
    perform ehr.order_notice_write('lab_request', item_order_id, item_patient_id, null, chosen_kind,
      new.released_at, 'lab.result_releases', new.id, new.result_id, new.result_version, null, item_requester_id,
      item_facility_id);
  exception when others then
    get stacked diagnostics failure_state = returned_sqlstate;
    if failure_state = '40001'
       or (failure_state = '40P01' and current_setting('transaction_isolation') <> 'read committed') then
      raise;
    end if;
    perform ehr.order_notice_gap('lab.result_releases', new.id, failure_state, null, chosen_kind, 'lab_request');
  end;
  return null;
end
$$;

-- N4: an invalidated result: only a version released on a route (only 0088
-- and 0090 write invalidations); one never released writes nothing.
create function ehr.order_notice_from_invalidation()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  report_route_id uuid;
  route_order_id uuid;
  route_patient_id uuid;
  route_facility_id uuid;
  route_orderer_id uuid;
  failure_state text;
begin
  begin
    if not coalesce((select switch_row.enabled from ehr.order_notice_switch switch_row
                      where switch_row.singleton), false) then
      return null;
    end if;
    select report.route_id into report_route_id
      from lab.order_route_result_reports report
     where report.result_id = new.result_id and report.result_version = new.result_version
       and report.kind = 'released';
    if report_route_id is null then
      return null;
    end if;
    select route.source_lab_request_id, route.patient_id, route.ordering_facility_id, route.orderer_account_id
      into route_order_id, route_patient_id, route_facility_id, route_orderer_id
      from ehr.order_routes route
     where route.id = report_route_id;
    perform ehr.order_notice_write('lab_request', route_order_id, route_patient_id, report_route_id,
      'lab_result_withdrawn', new.occurred_at, 'lab.result_invalidations', new.id, new.result_id,
      new.result_version, null, route_orderer_id, route_facility_id);
  exception when others then
    get stacked diagnostics failure_state = returned_sqlstate;
    if failure_state = '40001'
       or (failure_state = '40P01' and current_setting('transaction_isolation') <> 'read committed') then
      raise;
    end if;
    perform ehr.order_notice_gap('lab.result_invalidations', new.id, failure_state, null, 'lab_result_withdrawn',
      'lab_request');
  end;
  return null;
end
$$;

-- N4: a dispensing: fill 1 only (refills write nothing). A route report
-- first, else the own work item.
create function ehr.order_notice_from_dispensing()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  report_route_id uuid;
  route_order_id uuid;
  route_patient_id uuid;
  route_facility_id uuid;
  route_orderer_id uuid;
  item_id uuid;
  item_route_id uuid;
  item_order_id uuid;
  item_patient_id uuid;
  item_facility_id uuid;
  item_prescriber_id uuid;
  failure_state text;
begin
  begin
    if not coalesce((select switch_row.enabled from ehr.order_notice_switch switch_row
                      where switch_row.singleton), false) then
      return null;
    end if;
    if new.fill_number > 1 then
      return null;
    end if;
    select report.route_id into report_route_id
      from pharmacy.order_route_dispensing_reports report
     where report.dispensing_id = new.id and report.kind = 'dispensed';
    if report_route_id is not null then
      select route.source_prescription_id, route.patient_id, route.ordering_facility_id, route.orderer_account_id
        into route_order_id, route_patient_id, route_facility_id, route_orderer_id
        from ehr.order_routes route
       where route.id = report_route_id;
      perform ehr.order_notice_write('prescription', route_order_id, route_patient_id, report_route_id,
        'prescription_dispensed', new.dispensed_at, 'pharmacy.dispensings', new.id, null, null, new.id,
        route_orderer_id, route_facility_id);
      return null;
    end if;
    select item.id, item.order_route_id, item.source_ehr_prescription_id, item.patient_id, item.ordering_facility_id,
           item.prescribed_by
      into item_id, item_route_id, item_order_id, item_patient_id, item_facility_id, item_prescriber_id
      from pharmacy.work_items item
     where item.id = new.work_item_id;
    if item_id is null or item_route_id is not null then
      perform ehr.order_notice_gap('pharmacy.dispensings', new.id, null,
        case when item_id is null then 'work_item_not_found' else 'route_report_missing' end,
        'prescription_dispensed', 'prescription');
      return null;
    end if;
    perform ehr.order_notice_write('prescription', item_order_id, item_patient_id, null, 'prescription_dispensed',
      new.dispensed_at, 'pharmacy.dispensings', new.id, null, null, new.id, item_prescriber_id, item_facility_id);
  exception when others then
    get stacked diagnostics failure_state = returned_sqlstate;
    if failure_state = '40001'
       or (failure_state = '40P01' and current_setting('transaction_isolation') <> 'read committed') then
      raise;
    end if;
    perform ehr.order_notice_gap('pharmacy.dispensings', new.id, failure_state, null, 'prescription_dispensed',
      'prescription');
  end;
  return null;
end
$$;

-- N4: a reversal, of any fill. The dispensing's route report first, else
-- the own work item.
create function ehr.order_notice_from_reversal()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  report_route_id uuid;
  route_order_id uuid;
  route_patient_id uuid;
  route_facility_id uuid;
  route_orderer_id uuid;
  item_id uuid;
  item_route_id uuid;
  item_order_id uuid;
  item_patient_id uuid;
  item_facility_id uuid;
  item_prescriber_id uuid;
  failure_state text;
begin
  begin
    if not coalesce((select switch_row.enabled from ehr.order_notice_switch switch_row
                      where switch_row.singleton), false) then
      return null;
    end if;
    select report.route_id into report_route_id
      from pharmacy.order_route_dispensing_reports report
     where report.dispensing_id = new.dispensing_id and report.kind = 'dispensed';
    if report_route_id is not null then
      select route.source_prescription_id, route.patient_id, route.ordering_facility_id, route.orderer_account_id
        into route_order_id, route_patient_id, route_facility_id, route_orderer_id
        from ehr.order_routes route
       where route.id = report_route_id;
      perform ehr.order_notice_write('prescription', route_order_id, route_patient_id, report_route_id,
        'dispensing_reversed', new.reversed_at, 'pharmacy.dispensing_reversals', new.id, null, null,
        new.dispensing_id, route_orderer_id, route_facility_id);
      return null;
    end if;
    select item.id, item.order_route_id, item.source_ehr_prescription_id, item.patient_id, item.ordering_facility_id,
           item.prescribed_by
      into item_id, item_route_id, item_order_id, item_patient_id, item_facility_id, item_prescriber_id
      from pharmacy.work_items item
     where item.id = new.work_item_id;
    if item_id is null or item_route_id is not null then
      perform ehr.order_notice_gap('pharmacy.dispensing_reversals', new.id, null,
        case when item_id is null then 'work_item_not_found' else 'route_report_missing' end,
        'dispensing_reversed', 'prescription');
      return null;
    end if;
    perform ehr.order_notice_write('prescription', item_order_id, item_patient_id, null, 'dispensing_reversed',
      new.reversed_at, 'pharmacy.dispensing_reversals', new.id, null, null, new.dispensing_id, item_prescriber_id,
      item_facility_id);
  exception when others then
    get stacked diagnostics failure_state = returned_sqlstate;
    if failure_state = '40001'
       or (failure_state = '40P01' and current_setting('transaction_isolation') <> 'read committed') then
      raise;
    end if;
    perform ehr.order_notice_gap('pharmacy.dispensing_reversals', new.id, failure_state, null, 'dispensing_reversed',
      'prescription');
  end;
  return null;
end
$$;

-- The triggers: AFTER INSERT, for each row, origin mode, named to fire
-- after each table's *_order_route_return.
create trigger zz_order_notice after insert on lab.result_releases
  for each row execute function ehr.order_notice_from_release();
create trigger zz_order_notice after insert on lab.result_invalidations
  for each row execute function ehr.order_notice_from_invalidation();
create trigger zz_order_notice after insert on pharmacy.dispensings
  for each row execute function ehr.order_notice_from_dispensing();
create trigger zz_order_notice after insert on pharmacy.dispensing_reversals
  for each row execute function ehr.order_notice_from_reversal();

-- 5. N5: the session for the four definers: an active, unheld membership of
-- this account at this facility, for direct care, with one or both kind
-- permissions.
create function ehr.order_notice_session()
returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
  actor_organization uuid, actor_correlation text, actor_purpose text, lab_allowed boolean,
  prescription_allowed boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  subject_value text := platform.current_actor_subject();
  account_value uuid;
  membership_value uuid := platform.current_membership_id();
  facility_value uuid := platform.current_facility_id();
  correlation_value text := platform.current_correlation_id();
  purpose_value text := platform.current_purpose_of_use();
  organization_value uuid;
  lab_value boolean;
  prescription_value boolean;
begin
  account_value := auth.account_id_for_subject(subject_value);
  if account_value is null or membership_value is null or facility_value is null or correlation_value is null then
    raise exception using errcode = '42501', message = 'ORDER_NOTICES_NOT_PERMITTED';
  end if;
  select membership.organization_id into organization_value
    from identity.staff_facility_memberships membership
   where membership.id = membership_value and membership.account_id = account_value
     and membership.facility_id = facility_value and membership.active
     and membership.migration_hold_reason is null;
  if not found then
    raise exception using errcode = '42501', message = 'ORDER_NOTICES_NOT_PERMITTED';
  end if;
  if purpose_value is distinct from 'direct-care' then
    raise exception using errcode = '22023', message = 'ORDER_NOTICES_DIRECT_CARE_ONLY';
  end if;
  lab_value := coalesce(auth.membership_has_permission(subject_value, membership_value, facility_value,
    'ehr.lab-request.read'), false);
  prescription_value := coalesce(auth.membership_has_permission(subject_value, membership_value, facility_value,
    'ehr.prescription.read'), false);
  if not (lab_value or prescription_value) then
    raise exception using errcode = '42501', message = 'ORDER_NOTICES_NOT_PERMITTED';
  end if;
  return query select subject_value, account_value, membership_value, facility_value, organization_value,
    correlation_value, purpose_value, lab_value, prescription_value;
end
$$;

-- N5: the summary. Per kind, unread and critical not Seen, from the unread
-- index; no order read, no audit row.
create function ehr.order_notice_summary()
returns table (kind text, unread_count integer, critical_not_seen_count integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
begin
  select * into actor from ehr.order_notice_session();
  return query
    select notice.kind, (count(*) filter (where notice.read_at is null))::integer,
           (count(*) filter (where notice.needs_seen and notice.seen_at is null))::integer
      from ehr.order_notices notice
     where notice.ordering_facility_id = actor.actor_facility
       and notice.recipient_account_id = actor.actor_account
       and (notice.read_at is null or (notice.needs_seen and notice.seen_at is null))
       and ((notice.order_kind = 'lab_request' and actor.lab_allowed)
         or (notice.order_kind = 'prescription' and actor.prescription_allowed))
     group by notice.kind
     order by notice.kind;
end
$$;

-- N5: the list. Critical not Seen first, then newest; each order read by id
-- under its table's row-level security and the session's own consent test.
create function ehr.list_order_notices(requested_state text, cursor_notice_id uuid, requested_limit integer)
returns table (notice_id uuid, kind text, order_kind text, order_id uuid, order_route_id uuid, encounter_id uuid,
  display text, event_count integer, first_event_at timestamptz, last_event_at timestamptz, read_at timestamptz,
  needs_seen boolean, seen_at timestamptz, version bigint, access_ended boolean, patient_id uuid, full_name text,
  sex text, date_of_birth date, health_id_last4 text, has_more boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  page_limit integer;
  cursor_tier integer;
  cursor_at timestamptz;
  page_ids uuid[];
  page_order_kinds text[];
  page_order_ids uuid[];
  more boolean := false;
  position_index integer;
  order_patient uuid;
  order_facility uuid;
  order_encounter uuid;
  order_display text;
  allowed boolean;
  checked jsonb := '{}'::jsonb;
  patient_key text;
  shown_patients uuid[] := array[]::uuid[];
  shown_encounters uuid[] := array[]::uuid[];
  shown_displays text[] := array[]::text[];
  first_shown uuid[];
  ended_count integer := 0;
begin
  if requested_state is null or requested_state not in ('unread', 'all') then
    raise exception using errcode = '22023', message = 'ORDER_NOTICES_LIST_INVALID';
  end if;
  select * into actor from ehr.order_notice_session();
  page_limit := least(greatest(coalesce(requested_limit, 20), 1), 50);
  if cursor_notice_id is not null then
    select case when cursor_row.needs_seen and cursor_row.seen_at is null then 1 else 0 end, cursor_row.last_event_at
      into cursor_tier, cursor_at
      from ehr.order_notices cursor_row
     where cursor_row.id = cursor_notice_id and cursor_row.ordering_facility_id = actor.actor_facility
       and cursor_row.recipient_account_id = actor.actor_account;
    if not found then
      raise exception using errcode = '22023', message = 'ORDER_NOTICES_CURSOR_INVALID';
    end if;
  end if;
  -- The page: one statement per state, so 'unread' reads the unread index.
  if requested_state = 'unread' then
    select coalesce(array_agg(page.id order by page.tier desc, page.last_event_at desc, page.id desc), array[]::uuid[]),
           coalesce(array_agg(page.order_kind order by page.tier desc, page.last_event_at desc, page.id desc),
             array[]::text[]),
           coalesce(array_agg(page.order_id order by page.tier desc, page.last_event_at desc, page.id desc),
             array[]::uuid[])
      into page_ids, page_order_kinds, page_order_ids
      from (select notice.id, notice.order_kind, notice.order_id, notice.last_event_at,
                   case when notice.needs_seen and notice.seen_at is null then 1 else 0 end as tier
              from ehr.order_notices notice
             where notice.ordering_facility_id = actor.actor_facility
               and notice.recipient_account_id = actor.actor_account
               and (notice.read_at is null or (notice.needs_seen and notice.seen_at is null))
               and ((notice.order_kind = 'lab_request' and actor.lab_allowed)
                 or (notice.order_kind = 'prescription' and actor.prescription_allowed))
               and (cursor_notice_id is null
                    or (case when notice.needs_seen and notice.seen_at is null then 1 else 0 end, notice.last_event_at,
                        notice.id) < (cursor_tier, cursor_at, cursor_notice_id))
             order by 5 desc, notice.last_event_at desc, notice.id desc
             limit page_limit + 1) page;
  else
    select coalesce(array_agg(page.id order by page.tier desc, page.last_event_at desc, page.id desc), array[]::uuid[]),
           coalesce(array_agg(page.order_kind order by page.tier desc, page.last_event_at desc, page.id desc),
             array[]::text[]),
           coalesce(array_agg(page.order_id order by page.tier desc, page.last_event_at desc, page.id desc),
             array[]::uuid[])
      into page_ids, page_order_kinds, page_order_ids
      from (select notice.id, notice.order_kind, notice.order_id, notice.last_event_at,
                   case when notice.needs_seen and notice.seen_at is null then 1 else 0 end as tier
              from ehr.order_notices notice
             where notice.ordering_facility_id = actor.actor_facility
               and notice.recipient_account_id = actor.actor_account
               and ((notice.order_kind = 'lab_request' and actor.lab_allowed)
                 or (notice.order_kind = 'prescription' and actor.prescription_allowed))
               and (cursor_notice_id is null
                    or (case when notice.needs_seen and notice.seen_at is null then 1 else 0 end, notice.last_event_at,
                        notice.id) < (cursor_tier, cursor_at, cursor_notice_id))
             order by 5 desc, notice.last_event_at desc, notice.id desc
             limit page_limit + 1) page;
  end if;
  if cardinality(page_ids) > page_limit then
    more := true;
    page_ids := page_ids[1:page_limit];
    page_order_kinds := page_order_kinds[1:page_limit];
    page_order_ids := page_order_ids[1:page_limit];
  end if;
  -- Each order, by id, as the session may read it now. Not readable: the
  -- row is access_ended, with no patient, visit or display.
  for position_index in 1 .. coalesce(cardinality(page_ids), 0) loop
    order_patient := null;
    order_facility := null;
    order_encounter := null;
    order_display := null;
    if page_order_kinds[position_index] = 'lab_request' then
      select lab_request.patient_id, lab_request.facility_id, lab_request.encounter_id, lab_request.test_display
        into order_patient, order_facility, order_encounter, order_display
        from ehr.lab_requests lab_request
       where lab_request.id = page_order_ids[position_index];
    else
      select prescription.patient_id, prescription.facility_id, prescription.encounter_id,
             prescription.medication_display
        into order_patient, order_facility, order_encounter, order_display
        from ehr.prescriptions prescription
       where prescription.id = page_order_ids[position_index];
    end if;
    allowed := false;
    if order_patient is not null and order_facility = actor.actor_facility then
      patient_key := order_patient::text;
      if not (checked ? patient_key) then
        checked := checked || jsonb_build_object(patient_key,
          coalesce(ehr.context_allows(order_patient, actor.actor_facility, 'read_records'), false));
      end if;
      allowed := (checked ->> patient_key)::boolean;
    end if;
    if allowed then
      shown_patients := shown_patients || order_patient;
      shown_encounters := shown_encounters || order_encounter;
      shown_displays := shown_displays || order_display;
    else
      ended_count := ended_count + 1;
      shown_patients := shown_patients || null::uuid;
      shown_encounters := shown_encounters || null::uuid;
      shown_displays := shown_displays || null::text;
    end if;
  end loop;
  select coalesce(array_agg(first_seen.patient_id order by first_seen.first_position), array[]::uuid[])
    into first_shown
    from (select listed.patient_id, min(listed.position) as first_position
            from unnest(shown_patients) with ordinality listed(patient_id, position)
           where listed.patient_id is not null
           group by listed.patient_id) first_seen;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor.actor_correlation, 'staff', actor.actor_subject, actor.actor_account, actor.actor_membership,
    actor.actor_organization, actor.actor_facility, null, 'ehr.order-notice.list', 'success',
    'order-notice', null, actor.actor_purpose, 'application', 'ehr-api',
    jsonb_build_object('state', requested_state, 'paged', cursor_notice_id is not null,
      'resultCount', coalesce(cardinality(page_ids), 0), 'accessEndedCount', ended_count, 'hasMore', more,
      'patientIds', to_jsonb(first_shown))
  );
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  )
  select actor.actor_correlation, 'staff', actor.actor_subject, actor.actor_account, actor.actor_membership,
         actor.actor_organization, actor.actor_facility, shown.patient_id, 'ehr.order-notice.list.shown', 'success',
         'order-notice', null, actor.actor_purpose, 'application', 'ehr-api', '{}'::jsonb
    from unnest(first_shown) with ordinality shown(patient_id, position)
   order by shown.position;
  return query
    select notice.id, notice.kind, notice.order_kind, notice.order_id, notice.order_route_id,
           listed.encounter_id, listed.display, notice.event_count, notice.first_event_at, notice.last_event_at,
           notice.read_at, notice.needs_seen, notice.seen_at, notice.row_version, listed.patient_id is null,
           listed.patient_id, patient.full_name, patient.gender, patient.dob, right(patient.hid_code, 4), more
      from unnest(page_ids, shown_patients, shown_encounters, shown_displays)
           with ordinality listed(id, patient_id, encounter_id, display, position)
      join ehr.order_notices notice on notice.id = listed.id
      left join identity.patients patient on patient.id = listed.patient_id
     order by listed.position;
end
$$;

-- N5: mark read. 1-100 (notice id, version) pairs; only rows at that
-- version and unread change. Never needs access; never clears needs_seen.
-- The pairs are checked before anything is read.
create function ehr.mark_order_notices_read(requested_notice_ids uuid[], requested_versions bigint[])
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  changed integer;
begin
  if requested_notice_ids is null or requested_versions is null
     or coalesce(cardinality(requested_notice_ids), 0) not between 1 and 100
     or cardinality(requested_versions) is distinct from cardinality(requested_notice_ids)
     or array_position(requested_notice_ids, null) is not null
     or array_position(requested_versions, null) is not null then
    raise exception using errcode = '22023', message = 'ORDER_NOTICES_READ_INVALID';
  end if;
  select * into actor from ehr.order_notice_session();
  with changed_rows as (
    update ehr.order_notices notice
       set read_at = clock_timestamp(), row_version = notice.row_version + 1
      from unnest(requested_notice_ids, requested_versions) requested(id, version)
     where notice.id = requested.id and notice.row_version = requested.version and notice.read_at is null
       and notice.ordering_facility_id = actor.actor_facility
       and notice.recipient_account_id = actor.actor_account
       and ((notice.order_kind = 'lab_request' and actor.lab_allowed)
         or (notice.order_kind = 'prescription' and actor.prescription_allowed))
    returning notice.id, notice.patient_id
  ), audited as (
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    )
    select actor.actor_correlation, 'staff', actor.actor_subject, actor.actor_account, actor.actor_membership,
           actor.actor_organization, actor.actor_facility, per_patient.patient_id, 'ehr.order-notice.read', 'success',
           'order-notice', null, actor.actor_purpose, 'application', 'ehr-api',
           jsonb_build_object('noticeIds', to_jsonb(per_patient.notice_ids))
      from (select changed_rows.patient_id, array_agg(changed_rows.id order by changed_rows.id) as notice_ids
              from changed_rows group by changed_rows.patient_id) per_patient
    returning 1
  )
  select (select count(*) from changed_rows)::integer into changed;
  return changed;
end
$$;

-- N5: Seen. The session must be able to read the order now. Final; marks a
-- critical notice read too.
create function ehr.mark_order_notice_seen(requested_notice_id uuid)
returns table (notice_id uuid, kind text, order_kind text, order_id uuid, order_route_id uuid, encounter_id uuid,
  display text, event_count integer, first_event_at timestamptz, last_event_at timestamptz, read_at timestamptz,
  needs_seen boolean, seen_at timestamptz, version bigint, access_ended boolean, patient_id uuid, full_name text,
  sex text, date_of_birth date, health_id_last4 text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  found_order_kind text;
  found_order_id uuid;
  found_seen_at timestamptz;
  order_patient uuid;
  order_facility uuid;
  order_encounter uuid;
  order_display text;
begin
  select * into actor from ehr.order_notice_session();
  select notice.order_kind, notice.order_id, notice.seen_at into found_order_kind, found_order_id, found_seen_at
    from ehr.order_notices notice
   where notice.id = requested_notice_id and notice.ordering_facility_id = actor.actor_facility
     and notice.recipient_account_id = actor.actor_account
     and ((notice.order_kind = 'lab_request' and actor.lab_allowed)
       or (notice.order_kind = 'prescription' and actor.prescription_allowed))
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ORDER_NOTICE_NOT_FOUND';
  end if;
  if found_order_kind = 'lab_request' then
    select lab_request.patient_id, lab_request.facility_id, lab_request.encounter_id, lab_request.test_display
      into order_patient, order_facility, order_encounter, order_display
      from ehr.lab_requests lab_request
     where lab_request.id = found_order_id;
  else
    select prescription.patient_id, prescription.facility_id, prescription.encounter_id,
           prescription.medication_display
      into order_patient, order_facility, order_encounter, order_display
      from ehr.prescriptions prescription
     where prescription.id = found_order_id;
  end if;
  if order_patient is null or order_facility is distinct from actor.actor_facility
     or not coalesce(ehr.context_allows(order_patient, actor.actor_facility, 'read_records'), false) then
    raise exception using errcode = '42501', message = 'ORDER_NOTICE_CONSENT_REQUIRED';
  end if;
  -- A critical notice never merges, so it is marked read too. An ordinary
  -- one may have merged an event since the list showed it, so only mark
  -- read, with the version shown, reads it.
  if found_seen_at is null then
    update ehr.order_notices notice
       set seen_at = clock_timestamp(), seen_by_account_id = actor.actor_account,
           seen_by_membership_id = actor.actor_membership,
           read_at = case when notice.needs_seen then coalesce(notice.read_at, clock_timestamp()) else notice.read_at end,
           row_version = notice.row_version + 1
     where notice.id = requested_notice_id;
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor.actor_correlation, 'staff', actor.actor_subject, actor.actor_account, actor.actor_membership,
    actor.actor_organization, actor.actor_facility, order_patient, 'ehr.order-notice.seen', 'success',
    'order-notice', requested_notice_id::text, actor.actor_purpose, 'application', 'ehr-api',
    jsonb_build_object('alreadySeen', found_seen_at is not null)
  );
  return query
    select notice.id, notice.kind, notice.order_kind, notice.order_id, notice.order_route_id, order_encounter,
           order_display, notice.event_count, notice.first_event_at, notice.last_event_at, notice.read_at,
           notice.needs_seen, notice.seen_at, notice.row_version, false, order_patient, patient.full_name,
           patient.gender, patient.dob, right(patient.hid_code, 4)
      from ehr.order_notices notice
      join identity.patients patient on patient.id = order_patient
     where notice.id = requested_notice_id;
end
$$;

-- N7: legal holds, which only their owner may read; this function becomes
-- that owner's (below), with EXECUTE for this file's owner alone.
create function ehr.order_notice_held(held_patient uuid, held_recipient uuid, held_seen_by uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return exists (select 1 from platform.legal_holds hold
                  where hold.released_at is null
                    and ((hold.subject_type = 'patient' and hold.subject_id = held_patient)
                      or (hold.subject_type = 'account' and hold.subject_id in (held_recipient, held_seen_by))));
end
$$;

-- N6: the sweep. Notices past their time, oldest first, skipping held ones
-- before the batch is cut; the rule is tested again on the row deleted.
-- Then gap rows older than 90 days.
create function ehr.sweep_order_notices(batch integer)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  swept_notices integer;
  swept_gaps integer;
  cutoff timestamptz := clock_timestamp() - interval '90 days';
begin
  if batch is null or batch not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'ORDER_NOTICE_SWEEP_BATCH_INVALID';
  end if;
  with expired as (
    select notice.id
      from ehr.order_notices notice
     where ((notice.needs_seen and notice.seen_at <= cutoff)
         or (not notice.needs_seen and coalesce(notice.read_at, notice.last_event_at) <= cutoff))
       and not ehr.order_notice_held(notice.patient_id, notice.recipient_account_id, notice.seen_by_account_id)
     order by coalesce(notice.seen_at, notice.read_at, notice.last_event_at), notice.id
     limit batch
  ), removed as (
    delete from ehr.order_notices notice
     using expired
     where notice.id = expired.id
       and ((notice.needs_seen and notice.seen_at <= cutoff)
         or (not notice.needs_seen and coalesce(notice.read_at, notice.last_event_at) <= cutoff))
    returning notice.id, notice.patient_id, notice.ordering_facility_id, notice.kind, notice.order_kind
  ), audited as (
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    )
    select coalesce(platform.current_correlation_id(), 'order-notice-sweep'), 'system', null, null, null,
           null, removed.ordering_facility_id, removed.patient_id, 'ehr.order-notice.expire', 'success',
           'order-notice', removed.id::text, null, 'system', 'ehr-api',
           jsonb_build_object('kind', removed.kind, 'orderKind', removed.order_kind)
      from removed
    returning 1
  )
  select count(*) into swept_notices from audited;
  delete from ehr.order_notice_gaps gap
   where gap.id in (select old_gap.id from ehr.order_notice_gaps old_gap
                     where old_gap.recorded_at <= cutoff
                     order by old_gap.recorded_at, old_gap.id
                     limit batch);
  get diagnostics swept_gaps = row_count;
  return swept_notices + swept_gaps;
end
$$;

-- 6. Grants (here and in runtime-grants.sql) and comments. The five
-- definers to the EHR runtime only; every other new function to no role
-- (the hold test to this file's owner, below); the three tables to no role.
revoke all on function ehr.order_notice_gap(text, uuid, text, text, text, text),
  ehr.order_notice_write(text, uuid, uuid, uuid, text, timestamptz, text, uuid, uuid, bigint, uuid, uuid, uuid),
  ehr.order_notice_from_release(), ehr.order_notice_from_invalidation(), ehr.order_notice_from_dispensing(),
  ehr.order_notice_from_reversal(), ehr.order_notice_session(), ehr.order_notice_summary(),
  ehr.list_order_notices(text, uuid, integer), ehr.mark_order_notices_read(uuid[], bigint[]),
  ehr.mark_order_notice_seen(uuid), ehr.order_notice_held(uuid, uuid, uuid), ehr.sweep_order_notices(integer)
  from public;
do $$
declare
  holds_owner name := (select pg_get_userbyid(relation.relowner) from pg_class relation
                        where relation.oid = 'platform.legal_holds'::regclass);
begin
  if holds_owner <> current_user then
    execute format('alter function ehr.order_notice_held(uuid, uuid, uuid) owner to %I', holds_owner);
    execute format('grant execute on function ehr.order_notice_held(uuid, uuid, uuid) to %I', current_user);
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.order_notice_summary(), ehr.list_order_notices(text, uuid, integer),
      ehr.mark_order_notices_read(uuid[], bigint[]), ehr.mark_order_notice_seen(uuid),
      ehr.sweep_order_notices(integer) to hid_ehr_runtime;
  end if;
end
$$;

comment on table ehr.order_notices is
  '0159 ORD-11 (Q128 A): notices to the doctor who ordered a lab request or a prescription, written by the zz_order_notice triggers: a released result (critical, corrected or ready), a withdrawn result, a first fill dispensed, a reversal. Ids and times only. The recipient (account and ordering facility) is stored when the notice is written. Critical notices need Seen and never merge; the rest merge per order while unread. The owner''s only.';
comment on table ehr.order_notice_gaps is
  '0159 ORD-11: one row for each notice a trigger could not write (time, source table and row, SQLSTATE or reason, kind and order kind when known). No patient id. Must stay empty; kept 90 days. The owner''s only.';
comment on table ehr.order_notice_switch is
  '0159 ORD-11: one row. Off (enabled false), the zz_order_notice triggers write no notice and no gap. The owner''s only.';
comment on function ehr.order_notice_summary() is
  '0159 ORD-11: per kind, the session''s unread notices and critical notices not Seen at the session facility (a critical notice read but not Seen still counts). Needs ehr.lab-request.read for lab notices and ehr.prescription.read for dispensing notices. Not audited.';
comment on function ehr.list_order_notices(text, uuid, integer) is
  '0159 ORD-11: the session''s notices at the session facility (state unread or all), critical not Seen first, then newest; 1-50 a page, keyset by notice id. The patient card, visit and display come from the order, read now under its row-level security and ehr.context_allows; when the session may not read it, access_ended and no patient. Audited: ehr.order-notice.list and one .list.shown row per patient shown.';
comment on function ehr.mark_order_notices_read(uuid[], bigint[]) is
  '0159 ORD-11: marks the session''s notices read, for 1-100 (notice id, version) pairs; only rows at that version and unread change. Never needs access; never clears needs_seen. Answers how many changed. Audited: one ehr.order-notice.read row per patient.';
comment on function ehr.mark_order_notice_seen(uuid) is
  '0159 ORD-11: marks one of the session''s notices Seen (final; a critical notice is marked read too, an ordinary one only by mark read), only while the session may read the order now (42501 ORDER_NOTICE_CONSENT_REQUIRED). P0002 ORDER_NOTICE_NOT_FOUND for a notice that is not the session''s. Audited: ehr.order-notice.seen naming the patient.';
comment on function ehr.sweep_order_notices(integer) is
  '0159 ORD-11: deletes up to batch (1-1000) notices past their time (read: 90 days after reading; critical: 90 days after Seen; unread ordinary: 90 days after the last event; critical never Seen: kept), none under a legal hold on the recipient, the Seen account or the patient, with one ehr.order-notice.expire audit row each; then up to batch gap rows older than 90 days. Answers how many rows went.';
comment on function ehr.order_notice_held(uuid, uuid, uuid) is
  '0159 ORD-11: whether an unreleased legal hold names the patient or one of the two accounts. Owned by platform.legal_holds'' owner.';

-- 7. Post-checks (still under the locks).
do $$
declare
  found_absent boolean;
  mismatch text;
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  holds_owner oid := (select relation.relowner from pg_class relation where relation.oid = 'platform.legal_holds'::regclass);
  runtime_oid oid := (select role_row.oid from pg_roles role_row where role_row.rolname = 'hid_ehr_runtime');
  error_state text;
  error_message text;
begin
  -- Every new function exactly: one of each name in ehr, its body (md5),
  -- owner, plpgsql, SECURITY DEFINER, volatility, not STRICT, search_path
  -- pg_catalog, pg_temp, result; EXECUTE for the five definers to the EHR
  -- runtime only, for the hold test to this file's owner only (when another
  -- role owns it), for the rest to nobody.
  with expected(proc_name, argument_types, digest, volatility, result_type, grantee) as (values
         ('order_notice_gap', 'text, uuid, text, text, text, text', '22733d2193027258da5503c0c563f05b', 'v', 'void',
           'none'),
         ('order_notice_write', 'text, uuid, uuid, uuid, text, timestamp with time zone, text, uuid, uuid, bigint, '
           || 'uuid, uuid, uuid', 'fc55e8900fa03a063d5428234337c9c6', 'v', 'void', 'none'),
         ('order_notice_from_release', '', '34a356dce0a8dd0e6c9e9c613cbb83c0', 'v', 'trigger', 'none'),
         ('order_notice_from_invalidation', '', 'f15b8075ace705fb025fe675d55bcb4a', 'v', 'trigger', 'none'),
         ('order_notice_from_dispensing', '', 'a526d6a82bee5c9f7164890d923ef6cb', 'v', 'trigger', 'none'),
         ('order_notice_from_reversal', '', 'f0975a6399d2c4b9105400cb421d4317', 'v', 'trigger', 'none'),
         ('order_notice_session', '', '0210fa4a467418f4b0ca3958b72a3629', 's',
           'TABLE(actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid, '
           || 'actor_organization uuid, actor_correlation text, actor_purpose text, lab_allowed boolean, '
           || 'prescription_allowed boolean)', 'none'),
         ('order_notice_summary', '', 'cd91cf17fc21fb79cc69cb8606f120b7', 's',
           'TABLE(kind text, unread_count integer, critical_not_seen_count integer)', 'runtime'),
         ('list_order_notices', 'text, uuid, integer', 'd2909ddb4f8f81d2608e86d46b83d26e', 'v',
           'TABLE(notice_id uuid, kind text, order_kind text, order_id uuid, order_route_id uuid, encounter_id uuid, '
           || 'display text, event_count integer, first_event_at timestamp with time zone, last_event_at timestamp '
           || 'with time zone, read_at timestamp with time zone, needs_seen boolean, seen_at timestamp with time '
           || 'zone, version bigint, access_ended boolean, patient_id uuid, full_name text, sex text, date_of_birth '
           || 'date, health_id_last4 text, has_more boolean)', 'runtime'),
         ('mark_order_notices_read', 'uuid[], bigint[]', 'bdb2c8ede0e823b2d562f5203485a87c', 'v', 'integer',
           'runtime'),
         ('mark_order_notice_seen', 'uuid', '5e2695adee178d8c35e4c608ac295b91', 'v',
           'TABLE(notice_id uuid, kind text, order_kind text, order_id uuid, order_route_id uuid, encounter_id uuid, '
           || 'display text, event_count integer, first_event_at timestamp with time zone, last_event_at timestamp '
           || 'with time zone, read_at timestamp with time zone, needs_seen boolean, seen_at timestamp with time '
           || 'zone, version bigint, access_ended boolean, patient_id uuid, full_name text, sex text, date_of_birth '
           || 'date, health_id_last4 text)', 'runtime'),
         ('order_notice_held', 'uuid, uuid, uuid', '9378c73e22792b4441fd77525b1cc5ae', 's', 'boolean', 'owner'),
         ('sweep_order_notices', 'integer', '7a1755c95b1a1e20e4980619322703b7', 'v', 'integer', 'runtime')),
       differing as (
         select expected.proc_name,
                (select string_agg(format('md5=%s owner=%s definer=%s volatile=%s strict=%s config=%s acl=%s',
                          md5(proc.prosrc), pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
                          proc.proisstrict, proc.proconfig, proc.proacl), ',')
                   from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = 'ehr' and proc.proname = expected.proc_name) as found
           from expected
          where (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = 'ehr' and proc.proname = expected.proc_name) <> 1
             or not exists (
               select 1 from pg_proc proc
                 join pg_namespace namespace on namespace.oid = proc.pronamespace
                 join pg_language language_row on language_row.oid = proc.prolang
                where namespace.nspname = 'ehr' and proc.proname = expected.proc_name
                  and pg_catalog.oidvectortypes(proc.proargtypes) = expected.argument_types
                  and md5(proc.prosrc) = expected.digest
                  and proc.proowner = case when expected.grantee = 'owner' then holds_owner else owner_oid end
                  and proc.prosecdef and proc.provolatile = expected.volatility::"char"
                  and language_row.lanname = 'plpgsql' and not proc.proisstrict
                  and pg_get_function_result(proc.oid) = expected.result_type
                  and proc.proconfig = array['search_path=pg_catalog, pg_temp']
                  and coalesce((select array_agg(privilege.grantee::text || ':' || privilege.privilege_type || ':'
                                        || privilege.is_grantable::text order by privilege.grantee)
                                  from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
                                 where privilege.grantee <> proc.proowner), array[]::text[])
                      = case
                          when expected.grantee = 'runtime' and runtime_oid is not null
                            then array[runtime_oid::text || ':EXECUTE:false']
                          when expected.grantee = 'owner' and holds_owner <> owner_oid
                            then array[owner_oid::text || ':EXECUTE:false']
                          else array[]::text[] end))
  select exists (select 1 from differing),
         (select string_agg(format('ehr.%s: %s', differing.proc_name, coalesce(differing.found, 'missing')), '; ')
            from differing)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000', message = format('0159: functions are not as this file makes them: %s', mismatch);
  end if;
  -- The trigger functions and their two helpers name no EHR order table
  -- (0133's S7 list gains only the list and Seen), and never read
  -- ehr.order_notices: every mention of it is an INSERT.
  if exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'ehr'
                and proc.proname in ('order_notice_gap', 'order_notice_write', 'order_notice_from_release',
                      'order_notice_from_invalidation', 'order_notice_from_dispensing', 'order_notice_from_reversal')
                and (proc.prosrc ~* 'ehr\.prescriptions' or proc.prosrc ~* 'ehr\.lab_requests'
                  or (select count(*) from regexp_matches(proc.prosrc, 'ehr\.order_notices\M', 'gi'))
                     <> (select count(*) from regexp_matches(proc.prosrc, 'insert into ehr\.order_notices\M', 'gi')))) then
    raise exception using errcode = '55000',
      message = '0159: a trigger function or its helper names an EHR order table or reads the notices';
  end if;
  -- Each new trigger as 0152 pins its own: AFTER INSERT FOR EACH ROW (tgtype
  -- 5), its function, origin mode, no WHEN, no column list, no arguments.
  if (select count(*) from pg_trigger trigger_row
       where not trigger_row.tgisinternal and trigger_row.tgname = 'zz_order_notice'
         and trigger_row.tgtype = 5 and trigger_row.tgenabled = 'O' and trigger_row.tgqual is null
         and trigger_row.tgattr = ''::int2vector and trigger_row.tgnargs = 0
         and (trigger_row.tgrelid, trigger_row.tgfoid) in (
               ('lab.result_releases'::regclass, 'ehr.order_notice_from_release()'::regprocedure),
               ('lab.result_invalidations'::regclass, 'ehr.order_notice_from_invalidation()'::regprocedure),
               ('pharmacy.dispensings'::regclass, 'ehr.order_notice_from_dispensing()'::regprocedure),
               ('pharmacy.dispensing_reversals'::regclass, 'ehr.order_notice_from_reversal()'::regprocedure))) <> 4
     or (select count(*) from pg_trigger trigger_row where trigger_row.tgname = 'zz_order_notice') <> 4 then
    raise exception using errcode = '55000', message = '0159: the four zz_order_notice triggers are not as this file makes them';
  end if;
  -- Each table's triggers exactly: section 0's set (Billing's one accepted)
  -- and zz_order_notice; and zz_order_notice fires after the table's route
  -- return (both AFTER INSERT; name order, C collation).
  with expected(relation_name, base, extra, route_return, notice_trigger) as (values
         ('lab.result_releases', array[
           'lab_release_validate:lab.validate_result_governance():7:O',
           'lab_releases_immutable:lab.reject_immutable_evidence():27:O',
           'result_releases_order_route_return:lab.return_order_route_result():5:O'], null::text,
           'result_releases_order_route_return', 'zz_order_notice:ehr.order_notice_from_release():5:O'),
         ('lab.result_invalidations', array[
           'lab_invalidation_validate:lab.validate_result_governance():7:O',
           'lab_invalidations_immutable:lab.reject_immutable_evidence():27:O',
           'result_invalidations_order_route_return:lab.return_order_route_invalidation():5:O'], null::text,
           'result_invalidations_order_route_return', 'zz_order_notice:ehr.order_notice_from_invalidation():5:O'),
         ('pharmacy.dispensings', array[
           'dispensings_claim_prescription:pharmacy.claim_prescription_dispensing():5:A',
           'dispensings_order_route_return:pharmacy.return_order_route_dispensing():5:O',
           'pharmacy_dispensing_validate:pharmacy.validate_dispensing():7:O',
           'pharmacy_dispensings_immutable:pharmacy.reject_immutable_evidence():27:O',
           'prescription_claim_key_immutable:pharmacy.refuse_claim_key_change():19:A'],
           'zz_billing_stock_and_gate:commercial.hook_dispensing():7:O', 'dispensings_order_route_return',
           'zz_order_notice:ehr.order_notice_from_dispensing():5:O'),
         ('pharmacy.dispensing_reversals', array[
           'dispensing_reversals_order_route_return:pharmacy.return_order_route_reversal():5:O',
           'pharmacy_dispensing_reversal_validate:pharmacy.validate_dispensing_reversal():7:O',
           'pharmacy_dispensing_reversals_immutable:pharmacy.reject_immutable_evidence():27:O'],
           'zz_billing_reversal:commercial.hook_dispensing_reversal():7:O', 'dispensing_reversals_order_route_return',
           'zz_order_notice:ehr.order_notice_from_reversal():5:O')),
       present as (
         select expected.*,
                (select array_agg(trigger_row.tgname::text || ':' || trigger_row.tgfoid::regprocedure::text || ':'
                          || trigger_row.tgtype::text || ':' || trigger_row.tgenabled::text
                          order by trigger_row.tgname::text collate "C")
                   from pg_trigger trigger_row
                  where trigger_row.tgrelid = to_regclass(expected.relation_name) and not trigger_row.tgisinternal)
                  as triggers,
                (select array_agg(trigger_row.tgname::text order by trigger_row.tgname::text collate "C")
                   from pg_trigger trigger_row
                  where trigger_row.tgrelid = to_regclass(expected.relation_name) and not trigger_row.tgisinternal
                    and trigger_row.tgtype & 1 <> 0 and trigger_row.tgtype & 4 <> 0
                    and trigger_row.tgtype & 2 = 0 and trigger_row.tgtype & 64 = 0) as after_insert
           from expected),
       differing as (
         select present.relation_name from present
          where (present.triggers is distinct from present.base || present.notice_trigger
                 and (present.extra is null
                      or present.triggers is distinct from present.base || present.extra || present.notice_trigger))
             or array_position(present.after_insert, present.route_return) is null
             or array_position(present.after_insert, 'zz_order_notice') is null
             or array_position(present.after_insert, present.route_return)
                >= array_position(present.after_insert, 'zz_order_notice'))
  select string_agg(differing.relation_name, ', ') into mismatch from differing;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0159: the triggers on %s are not as this file leaves them, or zz_order_notice does not fire '
        || 'after the route return', mismatch);
  end if;
  -- The three tables exactly: columns, constraints and indexes; the owner's,
  -- row-level security on and not forced, no policy, no grant; empty but for
  -- the switch row, present and on.
  if (select string_agg(attribute_row.attname || ' ' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
                || ' ' || attribute_row.attnotnull::text || ' '
                || coalesce(pg_get_expr(column_default.adbin, column_default.adrelid), '-'), ', '
                order by attribute_row.attnum)
        from pg_attribute attribute_row
        left join pg_attrdef column_default
          on column_default.adrelid = attribute_row.attrelid and column_default.adnum = attribute_row.attnum
       where attribute_row.attrelid = 'ehr.order_notices'::regclass and attribute_row.attnum > 0
         and not attribute_row.attisdropped)
     is distinct from 'id uuid true gen_random_uuid(), order_kind text true -, order_id uuid true -, patient_id uuid '
       || 'true -, order_route_id uuid false -, kind text true -, event_count integer true 1, first_event_at timestamp '
       || 'with time zone true -, last_event_at timestamp with time zone true -, source_table text true -, '
       || 'source_row_id uuid true -, result_id uuid false -, result_version bigint false -, dispensing_id uuid false -, '
       || 'recipient_account_id uuid true -, ordering_facility_id uuid true -, needs_seen boolean true -, read_at '
       || 'timestamp with time zone false -, seen_at timestamp with time zone false -, seen_by_account_id uuid false -, '
       || 'seen_by_membership_id uuid false -, row_version bigint true 1, created_at timestamp with time zone true '
       || 'clock_timestamp()'
     or (select string_agg(constraint_row.conname || ' ' || pg_get_constraintdef(constraint_row.oid) || ' '
                  || constraint_row.convalidated::text, '; ' order by constraint_row.conname::text collate "C")
           from pg_constraint constraint_row where constraint_row.conrelid = 'ehr.order_notices'::regclass)
        is distinct from 'order_notices_kind_ck CHECK ((kind = ANY (ARRAY[''lab_result_critical''::text, '
          || '''lab_result_corrected''::text, ''lab_result_ready''::text, ''lab_result_withdrawn''::text, '
          || '''prescription_dispensed''::text, ''dispensing_reversed''::text]))) true; order_notices_patient_fk FOREIGN '
          || 'KEY (patient_id) REFERENCES identity.patients(id) ON DELETE RESTRICT true; order_notices_pkey PRIMARY KEY '
          || '(id) true'
     or (select string_agg(pg_get_indexdef(index_row.indexrelid) || ' ' || (index_row.indisvalid and index_row.indisready)::text,
                  '; ' order by pg_get_indexdef(index_row.indexrelid) collate "C")
           from pg_index index_row where index_row.indrelid = 'ehr.order_notices'::regclass)
        is distinct from 'CREATE INDEX order_notices_recipient_idx ON ehr.order_notices USING btree (ordering_facility_id, '
          || 'recipient_account_id, last_event_at, id) true; CREATE INDEX order_notices_unread_idx ON ehr.order_notices '
          || 'USING btree (ordering_facility_id, recipient_account_id, last_event_at, id) WHERE ((read_at IS NULL) OR '
          || '(needs_seen AND (seen_at IS NULL))) true; CREATE UNIQUE INDEX order_notices_critical_key ON '
          || 'ehr.order_notices USING btree (result_id, result_version) WHERE needs_seen true; CREATE UNIQUE INDEX '
          || 'order_notices_merge_key ON ehr.order_notices USING btree (order_kind, order_id, kind) WHERE ((read_at IS '
          || 'NULL) AND (NOT needs_seen)) true; CREATE UNIQUE INDEX order_notices_pkey ON ehr.order_notices USING btree '
          || '(id) true' then
    raise exception using errcode = '55000', message = '0159: ehr.order_notices is not as this file makes it';
  end if;
  if (select string_agg(attribute_row.attname || ' ' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
                || ' ' || attribute_row.attnotnull::text, ', ' order by attribute_row.attnum)
        from pg_attribute attribute_row
       where attribute_row.attrelid = 'ehr.order_notice_gaps'::regclass and attribute_row.attnum > 0
         and not attribute_row.attisdropped)
     is distinct from 'id uuid true, recorded_at timestamp with time zone true, source_table text true, source_row_id '
       || 'uuid false, failure_state text false, failure_reason text false, kind text false, order_kind text false'
     or (select string_agg(pg_get_constraintdef(constraint_row.oid), '; ') from pg_constraint constraint_row
          where constraint_row.conrelid = 'ehr.order_notice_gaps'::regclass) is distinct from 'PRIMARY KEY (id)'
     or (select count(*) from pg_index index_row where index_row.indrelid = 'ehr.order_notice_gaps'::regclass) <> 1
     or (select string_agg(attribute_row.attname || ' ' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
                   || ' ' || attribute_row.attnotnull::text, ', ' order by attribute_row.attnum)
           from pg_attribute attribute_row
          where attribute_row.attrelid = 'ehr.order_notice_switch'::regclass and attribute_row.attnum > 0
            and not attribute_row.attisdropped)
        is distinct from 'singleton boolean true, enabled boolean true, changed_at timestamp with time zone true'
     or (select string_agg(pg_get_constraintdef(constraint_row.oid), '; ' order by constraint_row.conname::text collate "C")
           from pg_constraint constraint_row where constraint_row.conrelid = 'ehr.order_notice_switch'::regclass)
        is distinct from 'CHECK (singleton); PRIMARY KEY (singleton)'
     or (select count(*) from pg_index index_row where index_row.indrelid = 'ehr.order_notice_switch'::regclass) <> 1 then
    raise exception using errcode = '55000', message = '0159: the gaps or the switch table is not as this file makes it';
  end if;
  if (select count(*) from pg_class relation
       where relation.oid in ('ehr.order_notices'::regclass, 'ehr.order_notice_gaps'::regclass,
               'ehr.order_notice_switch'::regclass)
         and relation.relkind = 'r' and relation.relpersistence = 'p' and relation.relowner = owner_oid
         and relation.relrowsecurity and not relation.relforcerowsecurity) <> 3
     or exists (select 1 from pg_class relation
                 cross join aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
                 where relation.oid in ('ehr.order_notices'::regclass, 'ehr.order_notice_gaps'::regclass,
                         'ehr.order_notice_switch'::regclass)
                   and privilege.grantee <> relation.relowner)
     or exists (select 1 from pg_attribute attribute_row
                 where attribute_row.attrelid in ('ehr.order_notices'::regclass, 'ehr.order_notice_gaps'::regclass,
                         'ehr.order_notice_switch'::regclass)
                   and attribute_row.attacl is not null)
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid in ('ehr.order_notices'::regclass, 'ehr.order_notice_gaps'::regclass,
                         'ehr.order_notice_switch'::regclass)) then
    raise exception using errcode = '55000',
      message = '0159: the three tables must be the owner''s alone, with row-level security on and not forced, no '
        || 'policy and no grant';
  end if;
  if (select count(*) from ehr.order_notice_switch switch_row where switch_row.singleton and switch_row.enabled) <> 1
     or (select count(*) from ehr.order_notice_switch) <> 1
     or exists (select 1 from ehr.order_notices) or exists (select 1 from ehr.order_notice_gaps) then
    raise exception using errcode = '55000', message = '0159: the switch row is not there and on, or a notice or gap row exists';
  end if;
  -- The hold test can read the holds: its owner is the holds' owner, whose
  -- policy alone reads them (or that owner bypasses row-level security).
  -- Printing the policy opens platform.legal_holds, which section 2 holds.
  if not ((select role_row.rolsuper or role_row.rolbypassrls from pg_roles role_row where role_row.oid = holds_owner)
          or exists (select 1 from pg_policy policy_row
                      where policy_row.polrelid = 'platform.legal_holds'::regclass
                        and policy_row.polname = 'legal_holds_owner' and policy_row.polcmd = '*'
                        and policy_row.polroles = array[0::oid]
                        and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                            = format('(CURRENT_USER = %L::name)', pg_get_userbyid(holds_owner))))
     or not has_function_privilege(owner_oid, 'ehr.order_notice_held(uuid,uuid,uuid)', 'EXECUTE') then
    raise exception using errcode = '55000', message = '0159: ehr.order_notice_held cannot read platform.legal_holds';
  end if;
  -- The probe, undone (its own subtransaction): mark read refuses 101 pairs
  -- before it reads anything (it opens no table to do so).
  begin
    perform ehr.mark_order_notices_read(array(select gen_random_uuid() from generate_series(1, 101)),
      array(select 1::bigint from generate_series(1, 101)));
    error_state := 'no error';
  exception when others then
    get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '22023' or error_message is distinct from 'ORDER_NOTICES_READ_INVALID' then
    raise exception using errcode = '55000',
      message = format('0159: mark read must refuse 101 pairs with 22023 ORDER_NOTICES_READ_INVALID; it answered %s %s',
        error_state, coalesce(error_message, ''));
  end if;
end
$$;

reset role;
