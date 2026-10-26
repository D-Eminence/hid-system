-- 0088 The receiving laboratory's or pharmacy's "This isn't the order's
-- patient" (item 3, owner decisions D1-D19 of 2026-10-26), and the ordering
-- facility's Overview read of such orders (D10's alternative (a)).
--
-- A laboratory or pharmacy (B) that accepted a cross-facility order (0086
-- section 6, P4c) and then finds the person at the counter was not the
-- order's patient (P) ends the order in one transaction: its access to P and
-- the order ends at once, every lab result it recorded on the order is marked
-- entered in error (and every version that came back to the ordering facility
-- A is reported withdrawn there), a dispensing it recorded is reversed, A's
-- order shows the new ending, P gets an inbox notice and support gets a
-- report to review. No new route state and no new event type: the route ends
-- through 0086's shared closer with ended_kind 'wrong_patient'.
--
-- 0. Preconditions (catalog reads; see Locks): no object of this
--    migration exists; the bodies this migration replaces or drops, and those
--    it relies on, are byte for byte the ones measured on 0001-0087 (md5 of
--    pg_proc.prosrc); ehr.order_routes' two ended-kind CHECKs are exactly
--    0086's (compared with the same CHECKs built on a temporary table in this
--    session, so a deparse difference between PostgreSQL builds cannot stop
--    the release); the route's and the return tables' triggers are 0086's;
--    the applying role may replace and drop those functions and alter the
--    route table; the three card functions share one owner, recorded here and
--    restored in section 2; the event CHECKs still allow what the command
--    writes.
-- 1. Two replaced functions (CREATE OR REPLACE keeps only the owner and the
--    ACL, so each statement restates the language, volatility, security and
--    search path exactly as 0086 created them):
--    - ehr.order_route_item_access(text,uuid,text): a write on a route that
--      ended 'wrong_patient' answers closed whatever its stored state, so the
--      Lab and Pharmacy services refuse it 409 ORDER_ROUTE_CLOSED even for a
--      member who holds P's own consent (reads still answer none: consent
--      decides);
--    - lab.return_order_route_result(): a release on such a route is refused
--      (23514 ORDER_ROUTE_CLOSED), which closes the one path to a release past
--      an ended completed route, a release made under P's consent at B.
-- 2. The work lists' route cards gain row_version and ended_kind (the
--    services convert the version with Number(...)): the OUT columns change,
--    so ehr.receiving_order_route_cards(text,uuid[]),
--    lab.order_route_cards(uuid[]) and pharmacy.order_route_cards(uuid[]) are
--    dropped and created with 0086's bodies and attributes and two trailing
--    columns, given back to their recorded owner, checked, and granted again
--    in section 5. The previous services name their 13 card columns, so they
--    read the new cards unchanged.
-- 3. ehr.guard_order_route_wrong_patient_report(): the report table (T8)
--    keeps every column, except one review by support, which may also remove
--    the reporter's note once (replaced by fixed text).
-- 4. The commands:
--    - ehr.report_wrong_patient_order_route(...) (C25), owner-only, through
--      lab.report_wrong_patient_order_route(...) and
--      pharmacy.report_wrong_patient_order_route(...) (SECURITY DEFINER, as
--      decline's wrappers);
--    - identity.admin_list_wrong_patient_reports(text,uuid) (C26) and
--      identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,
--      boolean) (C27), support's list and its one review;
--    - ehr.list_sent_wrong_patient_order_routes() (C28), the ordering
--      facility's Overview card: the orders sent from the session's facility
--      that ended 'wrong_patient' in the last 30 days; a member sees full
--      rows (with the patient's name) only for orders they sent and whose
--      patient's record they may still read, and of every other such order
--      only a count and its reference; a member without
--      ehr.order-route.send sees nothing. Bound to the live staff session,
--      facility and direct-care purpose as C3 and C4 are; the EHR service
--      audits each read.
-- 5. Grants, here and in runtime-grants.sql: the Lab and Pharmacy commands
--    and cards to their runtimes, C26 and C27 to the Identity runtime, C28 to
--    the EHR runtime, all but support's also to the schema test runtime.
--    Every new or recreated function is revoked from PUBLIC; the helper and
--    the guard are granted to no role.
-- 6. Last: 'wrong_patient' joins ehr.order_routes' two ended-kind CHECKs (on
--    cancelled and completed routes only), and T8 is created, under one
--    ACCESS EXCLUSIVE lock on ehr.order_routes taken NOWAIT.
--
-- Locks. Before section 6, only momentary ACCESS SHARE locks, each released
-- at once: on ehr.order_routes and ehr.order_route_events, taken by
-- pg_get_constraintdef in the CHECK precondition, and on ehr.order_routes and
-- lab.result_revisions, taken by the PL/pgSQL validator when it resolves a
-- body's %rowtype (measured with pg_locks at every section boundary: no table
-- lock is held before section 6). ACCESS SHARE conflicts only with ACCESS
-- EXCLUSIVE, so no request waits for them; while another session holds ACCESS
-- EXCLUSIVE on one of those three tables, the runner's lock_timeout stops the
-- dry run or the apply with nothing applied (measured for each; with it held
-- on lab.results, lab.result_invalidations, lab.work_items,
-- pharmacy.dispensings, identity.facilities, ehr.order_route_accept_attempts or
-- lab.order_route_result_reports, 0088 applies without waiting). Dropping and
-- creating functions locks no table. Section 6 takes ACCESS EXCLUSIVE on
-- ehr.order_routes (the CHECKs; T8's key to it needs SHARE ROW EXCLUSIVE,
-- which it covers) and holds it to commit, so every Lab or Pharmacy chain
-- read, order list and acceptance waits for the rest of this file only. It
-- is taken NOWAIT, as 0086 section 6.7 takes its locks: a busy table fails
-- the attempt at once, its subtransaction releases what it took, and the
-- loop tries again 100 ms later, so the migration never waits while holding
-- it and no request queues behind a waiting lock; after 50 attempts (5
-- seconds) it stops the release with nothing applied (55P03). The release
-- takes it twice: once in the dry run, which applies every pending migration
-- in one transaction and rolls back, and once in the real apply. Each new
-- CHECK is a superset of the old one, so its validation cannot fail. T8's
-- only foreign key is to the route. 0088 never locks
-- platform.control_settings or identity.consent_grants.
--
-- Old services on this schema: the previous Lab and Pharmacy images name
-- their card columns inside a savepoint, call accept and decline unchanged,
-- and have no route to the new command; the replaced item access and release
-- trigger change only routes that ended 'wrong_patient', and none exists
-- before the new services ship. Applied migrations 0001 through 0087 are
-- immutable.

-- 0. Preconditions. The release dry-runs every pending migration in one
-- transaction before applying any, so a refusal here stops the release with
-- nothing changed. Catalog reads; only pg_get_constraintdef takes a table lock,
-- a momentary ACCESS SHARE (see Locks).
do $$
declare
  mismatch text;
  card_owners oid[];
begin
  -- a. No collision.
  if to_regclass('ehr.order_route_wrong_patient_reports') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where (namespace.nspname, proc.proname) in (
                   ('ehr', 'report_wrong_patient_order_route'), ('lab', 'report_wrong_patient_order_route'),
                   ('pharmacy', 'report_wrong_patient_order_route'), ('identity', 'admin_list_wrong_patient_reports'),
                   ('identity', 'admin_review_wrong_patient_report'), ('ehr', 'guard_order_route_wrong_patient_report'),
                   ('ehr', 'list_sent_wrong_patient_order_routes'))) then
    raise exception '0088: an object of this migration already exists; this release would collide with it';
  end if;
  -- b. The bodies this migration replaces (item access, release trigger) or
  -- drops (the three cards): md5 of pg_proc.prosrc measured on 0001-0087,
  -- equal to the md5 of the body text in 0086 (0087 replaces none).
  select string_agg(format('%s md5 %s', expected.proc, md5(proc.prosrc)), '; ') into mismatch
    from (values ('ehr.order_route_item_access(text,uuid,text)'::regprocedure, '53ca1585b8af43ee1340d980829fac79'),
                 ('lab.return_order_route_result()'::regprocedure, 'd0edd43f960cb75a87055c9f298247b0'),
                 ('ehr.receiving_order_route_cards(text,uuid[])'::regprocedure, '34bf018487660e12900df69f6ff1fb14'),
                 ('lab.order_route_cards(uuid[])'::regprocedure, '279297469487e3f0cf8b3360c30c5bce'),
                 ('pharmacy.order_route_cards(uuid[])'::regprocedure, '2a74a6f9ef676fd03d7ee337027acf8b'))
         expected(proc, digest)
    join pg_proc proc on proc.oid = expected.proc
   where md5(proc.prosrc) <> expected.digest;
  if mismatch is not null then
    raise exception '0088: a function this migration replaces or drops has another body than 0086 gave it: %', mismatch;
  end if;
  -- c. The bodies the command, the reads and the replaced functions rely on
  -- (0086 section 6, 0077's two governance validators, 0086's chain
  -- policies' context functions; and 0026's Lab outbox reference check, 0086's
  -- staff and platform actors and 0005's ehr.context_allows, which the
  -- command's step order and the new reads depend on).
  select string_agg(format('%s md5 %s', expected.proc, md5(proc.prosrc)), '; ') into mismatch
    from (values
      ('ehr.close_order_route(uuid,text,text,boolean)'::regprocedure, 'd0c8c11573bc3fd5cc764553d55b1820'),
      ('ehr.write_order_route_change(ehr.order_routes,ehr.order_routes,text,text,text)'::regprocedure,
       'b11691bfe99d65a93d60eefe0fc8c0c1'),
      ('ehr.guard_order_route_mutation()'::regprocedure, '6a01bc885cd54f87a1bee8c0ebc100a4'),
      ('ehr.lock_receiving_route(text,uuid,uuid,uuid)'::regprocedure, 'b73b01f7ca721adb0de4e834dd566e3a'),
      ('ehr.order_route_receiver(text)'::regprocedure, '61eed3f80f2502aadc338581142214a5'),
      ('ehr.order_route_allows(uuid,uuid,text)'::regprocedure, 'b80c2df6c380f7c7e20d166da94e56d2'),
      ('ehr.order_route_access_allows(text,uuid,uuid,text)'::regprocedure, '20d9847baf91a6b801ff1db2127ce2a7'),
      ('ehr.order_route_effective_state(ehr.order_routes)'::regprocedure, '934300a9e58a7f6789b1dc24520fabad'),
      ('ehr.order_route_system_audit(ehr.order_routes,text,text,boolean,jsonb)'::regprocedure,
       '6c54f543a495e35d9ebd029450d49e0a'),
      ('ehr.order_route_notify_patient(ehr.order_routes,text)'::regprocedure, '31a11a44325846699036367b7e56b46e'),
      ('ehr.patient_list_order_routes()'::regprocedure, '021da2ec202ee6dfbc6eaee88a2672c2'),
      ('ehr.sync_order_routes_on_order_change()'::regprocedure, '8ce6b42450cc06fc02fec8d1cf63af41'),
      ('lab.return_order_route_invalidation()'::regprocedure, '2176bfd64b05c6e357021c178060f1b7'),
      ('pharmacy.return_order_route_reversal()'::regprocedure, '7cf0067c59c502026be74e292a8989ab'),
      ('pharmacy.validate_dispensing()'::regprocedure, '23d9b6a9a9d09b106f685679df84f74f'),
      ('lab.validate_result_governance()'::regprocedure, '6bf52a22ce45e834d4f2a194a06babad'),
      ('pharmacy.validate_dispensing_reversal()'::regprocedure, 'a8b1147f356e669fe0d14bea3e7ab014'),
      ('lab.context_allows(uuid,uuid,text)'::regprocedure, '57e689661a6227e34d3bde9562468951'),
      ('pharmacy.context_allows(uuid,uuid,text)'::regprocedure, '958a6e5cd2a534d158c82fe399b8f381'),
      ('lab.validate_outbox_aggregate_reference()'::regprocedure, 'b86458c9a75df2fec44f6ddf7a8acbef'),
      ('ehr.order_route_staff_actor(boolean)'::regprocedure, 'b1873dca92164652cc1977a90acb6184'),
      ('identity.order_route_platform_actor(text[])'::regprocedure, '599cccfdba5e9b4c46cde4dd2814a541'),
      ('ehr.context_allows(uuid,uuid,text)'::regprocedure, '75016690184a80bd246c365b4d108082'))
         expected(proc, digest)
    join pg_proc proc on proc.oid = expected.proc
   where md5(proc.prosrc) <> expected.digest;
  if mismatch is not null then
    raise exception '0088: a function the wrong-patient report relies on has another body than 0086 gave it: %', mismatch;
  end if;
  -- d. ehr.order_routes' two ended-kind CHECKs are exactly 0086's
  -- (0086:6349-6350 and 6414-6425), compared with the same CHECKs built on a
  -- temporary table in this session.
  create temporary table order_routes_0086_checks (
    state text,
    ended_kind text,
    ended_at timestamptz,
    ended_by_account_id uuid,
    constraint order_routes_ended_kind_check check (ended_kind is null or ended_kind in ('orderer', 'patient',
      'order_changed', 'entered_in_error', 'receiving_released', 'ordering_released', 'support', 'order_in_work',
      'not_accepted')),
    constraint order_routes_end_ck check (
      (ended_at is null) = (ended_kind is null)
      and (ended_by_account_id is null or ended_at is not null)
      and coalesce(case state
        when 'withdrawn' then ended_kind in ('orderer', 'patient', 'order_changed', 'entered_in_error',
          'receiving_released', 'ordering_released', 'support', 'order_in_work')
        when 'expired' then ended_kind = 'not_accepted'
        when 'cancelled' then ended_kind in ('order_changed', 'entered_in_error', 'receiving_released',
          'ordering_released', 'support')
        when 'completed' then ended_kind is null or ended_kind in ('entered_in_error', 'receiving_released',
          'ordering_released', 'support')
        else ended_kind is null end, false))
  ) on commit drop;
  -- The events' type and reason CHECKs (0086:6464-6470), the same way.
  create temporary table order_route_events_0086_checks (
    event_type text check (event_type in ('created', 'withdrawn', 'expired', 'accept_locked', 'accepted',
      'declined', 'cancelled', 'completed', 'result_returned', 'result_marked_in_error', 'dispensing_returned',
      'dispensing_reversed', 'order_changed_after_acceptance', 'order_changed_after_completion', 'access_ended')),
    reason_code text check (reason_code is null or reason_code ~ '^[a-z][a-z_]{1,39}$')
  ) on commit drop;
  select string_agg(expected.conname, ', ') into mismatch
    from (values ('order_routes_0086_checks', 'ehr.order_routes', 'order_routes_ended_kind_check',
                  'order_routes_ended_kind_check'),
                 ('order_routes_0086_checks', 'ehr.order_routes', 'order_routes_end_ck', 'order_routes_end_ck'),
                 ('order_route_events_0086_checks', 'ehr.order_route_events',
                  'order_route_events_0086_checks_event_type_check', 'order_route_events_event_type_check'),
                 ('order_route_events_0086_checks', 'ehr.order_route_events',
                  'order_route_events_0086_checks_reason_code_check', 'order_route_events_reason_code_check'))
         expected(temporary_table, live_table, temporary_name, conname)
   where (select pg_get_constraintdef(live.oid) from pg_constraint live
           where live.conrelid = expected.live_table::regclass and live.conname = expected.conname and live.contype = 'c')
         is distinct from
         (select pg_get_constraintdef(built.oid) from pg_constraint built
           where built.conrelid = format('pg_temp.%I', expected.temporary_table)::regclass
             and built.conname = expected.temporary_name and built.contype = 'c');
  if mismatch is not null then
    raise exception '0088: a CHECK this migration extends or relies on is not 0086''s: %', mismatch;
  end if;
  -- e. The route's user triggers are exactly 0086's guard and first-event
  -- check, and the four return triggers call 0086's functions.
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.order_routes'::regclass and not trigger_row.tgisinternal) <> 2
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'ehr.order_routes'::regclass and trigger_row.tgname = 'order_routes_guard'
                       and trigger_row.tgtype = 27 and trigger_row.tgenabled = 'O'
                       and trigger_row.tgfoid = 'ehr.guard_order_route_mutation()'::regprocedure)
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'ehr.order_routes'::regclass
                       and trigger_row.tgname = 'order_routes_first_event' and trigger_row.tgtype = 5
                       and trigger_row.tgenabled = 'O'
                       and trigger_row.tgfoid = 'ehr.require_order_route_first_event()'::regprocedure) then
    raise exception '0088: ehr.order_routes must have exactly 0086''s two user triggers';
  end if;
  select string_agg(expected.tgname, ', ') into mismatch
    from (values ('lab.result_releases', 'result_releases_order_route_return', 'lab.return_order_route_result()'),
                 ('lab.result_invalidations', 'result_invalidations_order_route_return',
                  'lab.return_order_route_invalidation()'),
                 ('pharmacy.dispensings', 'dispensings_order_route_return', 'pharmacy.return_order_route_dispensing()'),
                 ('pharmacy.dispensing_reversals', 'dispensing_reversals_order_route_return',
                  'pharmacy.return_order_route_reversal()')) expected(relation, tgname, function_signature)
   where not exists (select 1 from pg_trigger trigger_row
                      where trigger_row.tgrelid = expected.relation::regclass and trigger_row.tgname = expected.tgname
                        and trigger_row.tgtype = 5 and trigger_row.tgenabled = 'O'
                        and trigger_row.tgfoid = expected.function_signature::regprocedure);
  if mismatch is not null then
    raise exception '0088: a return trigger is not 0086''s: %', mismatch;
  end if;
  -- f. Ownership (0086's PC3a): the applying role inherits the owner's
  -- privileges for every function replaced or dropped and for the route
  -- table it alters. The three cards share one owner, which may create in
  -- the three schemas; section 2 gives the new cards back to it (an ALTER
  -- OWNER to another role needs SET on it).
  select string_agg(proc.oid::regprocedure::text, ', ') into mismatch
    from pg_proc proc
   where proc.oid in ('ehr.order_route_item_access(text,uuid,text)'::regprocedure,
                      'lab.return_order_route_result()'::regprocedure,
                      'ehr.receiving_order_route_cards(text,uuid[])'::regprocedure,
                      'lab.order_route_cards(uuid[])'::regprocedure,
                      'pharmacy.order_route_cards(uuid[])'::regprocedure)
     and not pg_has_role(current_user, proc.proowner, 'USAGE');
  if mismatch is not null
     or not pg_has_role(current_user, (select relation.relowner from pg_class relation
                                        where relation.oid = 'ehr.order_routes'::regclass), 'USAGE') then
    raise exception '0088: the applying role does not inherit the owner of %',
      coalesce(mismatch, 'ehr.order_routes');
  end if;
  select array_agg(distinct proc.proowner) into card_owners
    from pg_proc proc
   where proc.oid in ('ehr.receiving_order_route_cards(text,uuid[])'::regprocedure,
                      'lab.order_route_cards(uuid[])'::regprocedure, 'pharmacy.order_route_cards(uuid[])'::regprocedure);
  if cardinality(card_owners) <> 1
     or not has_schema_privilege(card_owners[1], 'ehr', 'CREATE')
     or not has_schema_privilege(card_owners[1], 'lab', 'CREATE')
     or not has_schema_privilege(card_owners[1], 'pharmacy', 'CREATE')
     or (card_owners[1] <> (select role_row.oid from pg_roles role_row where role_row.rolname = current_user)
       and not pg_has_role(current_user, card_owners[1], 'SET')) then
    raise exception '0088: the three route card functions must share one owner that may create in ehr, lab and pharmacy and that the applying role may become';
  end if;
  create temporary table order_route_cards_0086 on commit drop as
    select proc.oid::regprocedure::text as signature, proc.proowner, proc.prosecdef, proc.provolatile, proc.proconfig
      from pg_proc proc
     where proc.oid in ('ehr.receiving_order_route_cards(text,uuid[])'::regprocedure,
                        'lab.order_route_cards(uuid[])'::regprocedure,
                        'pharmacy.order_route_cards(uuid[])'::regprocedure);
end
$$;

-- 1. The two replaced functions.

-- C11 / C17's decision for one work item (0086:8616-8646): a write on a route
-- ended 'wrong_patient' is closed whatever its stored state, even for a member
-- who holds the patient's own consent (it was fulfilled for someone else).
create or replace function ehr.order_route_item_access(requested_kind text, item_route_id uuid, requested_action text)
returns text
language plpgsql stable
set search_path = pg_catalog, ehr, platform, pg_temp
as $$
declare
  route ehr.order_routes%rowtype;
begin
  if item_route_id is null then
    return 'none';
  end if;
  select candidate.* into route from ehr.order_routes candidate
   where candidate.id = item_route_id and candidate.kind = requested_kind
     and candidate.receiving_facility_id = platform.current_facility_id();
  if route.id is null then
    return 'none';
  end if;
  if not ehr.order_route_access_open() then
    return 'paused';
  end if;
  if ehr.order_route_allows(route.id, route.receiving_facility_id, requested_action) then
    return 'allowed';
  end if;
  if requested_action = 'write_records'
     and (route.state = 'cancelled'
       or (route.state = 'accepted' and clock_timestamp() >= route.writes_end_at)
       or route.ended_kind = 'wrong_patient') then
    return 'closed';
  end if;
  return 'none';
end;
$$;

-- Results back to the ordering facility (0086:9824-9884). A release on a
-- cancelled route, on an accepted route past its work window, or on a route
-- its laboratory ended as fulfilled for someone else is refused (23514
-- ORDER_ROUTE_CLOSED) whatever consent the writer holds: a release under the
-- patient's consent at B on a route fulfilled for another person must not
-- cross. Otherwise unchanged: the first release completes the route and sets
-- both windows; later ones are reports and events; a completed route past its
-- window still files a release made under the patient's consent.
create or replace function lab.return_order_route_result()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, lab, ehr, platform, pg_temp
as $$
declare
  item_route uuid;
  item_id uuid;
  test_system text;
  test_code_value text;
  test_name_value text;
  revision lab.result_revisions%rowtype;
  route_row ehr.order_routes%rowtype;
  changed ehr.order_routes%rowtype;
  written ehr.order_routes%rowtype;
begin
  select item.order_route_id, item.id, test.code_system, test.code, test.name
    into item_route, item_id, test_system, test_code_value, test_name_value
    from lab.test_executions execution
    join lab.work_item_requested_tests test on test.id = execution.requested_test_id
    join lab.work_items item on item.id = test.work_item_id
   where execution.id = new.execution_id;
  if item_route is null then
    return null;
  end if;
  select route.* into route_row from ehr.order_routes route where route.id = item_route for update;
  if route_row.state = 'cancelled'
     or (route_row.state = 'accepted' and clock_timestamp() >= route_row.writes_end_at)
     or route_row.ended_kind = 'wrong_patient' then
    raise exception using errcode = '23514', message = 'ORDER_ROUTE_CLOSED';
  end if;
  select candidate.* into revision from lab.result_revisions candidate
   where candidate.result_id = new.result_id and candidate.version = new.result_version;
  insert into lab.order_route_result_reports (route_id, work_item_id, result_id, result_version, kind,
    test_code_system, test_code, test_name, result_type, numeric_value, text_value, unit, reference_range,
    abnormal_flag, revision_kind, correction_reason, occurred_at, performing_facility_id)
  values (route_row.id, item_id, new.result_id, new.result_version, 'released', test_system,
    test_code_value, test_name_value, revision.result_type, revision.numeric_value, revision.text_value,
    revision.unit, revision.reference_range, revision.abnormal_flag, revision.revision_kind,
    revision.correction_reason, new.released_at, new.facility_id);
  changed := route_row;
  if route_row.state = 'accepted' then
    changed.state := 'completed';
    changed.completed_at := clock_timestamp();
    changed.writes_end_at := least(changed.completed_at + interval '336 hours',
                                   route_row.accepted_at + interval '1080 hours');
    changed.access_ends_at := changed.writes_end_at;
    written := ehr.write_order_route_change(route_row, changed, 'completed', 'receiving', null);
  else
    written := ehr.write_order_route_change(route_row, changed, 'result_returned', 'receiving', null);
  end if;
  perform ehr.order_route_system_audit(written, 'ordering', 'ehr.order-route.result-returned', true,
    jsonb_build_object('resultId', new.result_id, 'version', new.result_version));
  return null;
end;
$$;

-- 2. The route cards (C12 / C18) with the route's row_version and ended_kind
-- as two trailing columns: 0086's bodies (0086:8770-8832, 8905-8919,
-- 8995-9009) and attributes otherwise. The helper first, then the two
-- wrappers.
drop function lab.order_route_cards(uuid[]), pharmacy.order_route_cards(uuid[]),
  ehr.receiving_order_route_cards(text,uuid[]);

create function ehr.receiving_order_route_cards(requested_kind text, requested_work_item_ids uuid[])
returns table (
  work_item_id uuid,
  route_id uuid,
  reference text,
  effective_state text,
  access text,
  ordering_facility_name text,
  orderer_name text,
  orderer_licence_body text,
  orderer_licence_number text,
  patient_full_name text,
  patient_sex text,
  patient_date_of_birth date,
  patient_health_id_last4 text,
  row_version bigint,
  ended_kind text
)
language plpgsql stable
set search_path = pg_catalog, ehr, identity, lab, pharmacy, platform, pg_temp
as $$
declare
  actor record;
begin
  select * into actor from ehr.order_route_staff_actor(false);
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  return query
    select item.item_id, route.id, route.reference::text, ehr.order_route_effective_state(route),
      case when ehr.order_route_allows(route.id, route.receiving_facility_id, 'write_records') then 'work'
           when ehr.order_route_allows(route.id, route.receiving_facility_id, 'read_records') then 'read'
           else 'none' end,
      (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
      route.orderer_name, route.orderer_licence_body,
      case when readable.allowed then route.orderer_licence_number end,
      case when readable.allowed then card.full_name end,
      case when readable.allowed then card.sex end,
      case when readable.allowed then card.date_of_birth end,
      case when readable.allowed then card.health_id_last4 end,
      route.row_version, route.ended_kind
      from (
        select candidate.id as item_id, candidate.order_route_id as item_route
          from lab.work_items candidate
         where requested_kind = 'lab_request' and candidate.id = any(requested_work_item_ids)
           and candidate.order_route_id is not null and candidate.facility_id = actor.actor_facility_id
           and lab.work_item_allows(candidate.patient_id, candidate.facility_id, candidate.order_route_id,
             'read_records')
        union all
        select candidate.id, candidate.order_route_id
          from pharmacy.work_items candidate
         where requested_kind = 'prescription' and candidate.id = any(requested_work_item_ids)
           and candidate.order_route_id is not null and candidate.facility_id = actor.actor_facility_id
           and pharmacy.work_item_allows(candidate.patient_id, candidate.facility_id, candidate.order_route_id,
             'read_records')
      ) item
      join ehr.order_routes route on route.id = item.item_route
      cross join lateral (select ehr.order_route_allows(route.id, route.receiving_facility_id, 'read_records')
                            as allowed) readable
      left join lateral ehr.order_route_patient_card(route.patient_id) card on readable.allowed
     order by item.item_id;
end;
$$;

create function lab.order_route_cards(requested_work_item_ids uuid[])
returns table (
  work_item_id uuid, route_id uuid, reference text, effective_state text, access text,
  ordering_facility_name text, orderer_name text, orderer_licence_body text, orderer_licence_number text,
  patient_full_name text, patient_sex text, patient_date_of_birth date, patient_health_id_last4 text,
  row_version bigint, ended_kind text
)
language sql stable security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select card.work_item_id, card.route_id, card.reference, card.effective_state, card.access,
    card.ordering_facility_name, card.orderer_name, card.orderer_licence_body, card.orderer_licence_number,
    card.patient_full_name, card.patient_sex, card.patient_date_of_birth, card.patient_health_id_last4,
    card.row_version, card.ended_kind
    from ehr.receiving_order_route_cards('lab_request', requested_work_item_ids) card
$$;

create function pharmacy.order_route_cards(requested_work_item_ids uuid[])
returns table (
  work_item_id uuid, route_id uuid, reference text, effective_state text, access text,
  ordering_facility_name text, orderer_name text, orderer_licence_body text, orderer_licence_number text,
  patient_full_name text, patient_sex text, patient_date_of_birth date, patient_health_id_last4 text,
  row_version bigint, ended_kind text
)
language sql stable security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select card.work_item_id, card.route_id, card.reference, card.effective_state, card.access,
    card.ordering_facility_name, card.orderer_name, card.orderer_licence_body, card.orderer_licence_number,
    card.patient_full_name, card.patient_sex, card.patient_date_of_birth, card.patient_health_id_last4,
    card.row_version, card.ended_kind
    from ehr.receiving_order_route_cards('prescription', requested_work_item_ids) card
$$;

-- The cards go back to the owner recorded in section 0 (a DROP and CREATE
-- makes the applying role their owner), then their owner, security,
-- volatility and search path must equal 0086's, or the release stops.
do $$
declare
  recorded record;
  mismatch text;
begin
  for recorded in select card.signature, card.proowner from pg_temp.order_route_cards_0086 card loop
    if (select proc.proowner from pg_proc proc where proc.oid = recorded.signature::regprocedure)
       <> recorded.proowner then
      execute format('alter function %s owner to %I', recorded.signature, pg_get_userbyid(recorded.proowner));
    end if;
  end loop;
  select string_agg(recorded_card.signature, ', ') into mismatch
    from pg_temp.order_route_cards_0086 recorded_card
    join pg_proc proc on proc.oid = recorded_card.signature::regprocedure
   where (proc.proowner, proc.prosecdef, proc.provolatile, proc.proconfig)
         is distinct from (recorded_card.proowner, recorded_card.prosecdef, recorded_card.provolatile,
           recorded_card.proconfig);
  if mismatch is not null or (select count(*) from pg_temp.order_route_cards_0086) <> 3 then
    raise exception '0088: a recreated route card function differs from 0086''s owner or attributes: %', mismatch;
  end if;
end
$$;
revoke all on function ehr.receiving_order_route_cards(text,uuid[]), lab.order_route_cards(uuid[]),
  pharmacy.order_route_cards(uuid[]) from public;

-- 3. The report table's guard (T8 is created in section 6). No delete. Every
-- column is fixed, except that one update, together with row_version + 1,
-- sets the four review columns from null (one or more distinct actions, or
-- exactly no_further_action) and, only in that update, may set note_removed
-- from false to true, the note becoming exactly the fixed text.
create function ehr.guard_order_route_wrong_patient_report()
returns trigger
language plpgsql
set search_path = pg_catalog, ehr, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE';
  end if;
  if (new.id, new.route_id, new.kind, new.receiving_facility_id, new.receiving_organization_id,
      new.ordering_facility_id, new.state_before, new.reason_code, new.reported_by_account_id,
      new.reported_by_membership_id, new.accepted_by_account_id, new.accepted_by_membership_id, new.accepted_at,
      new.accepted_with, new.recorded_by_membership_ids, new.reporter_recorded_work, new.specimens_collected,
      new.results_voided, new.result_reports_marked, new.dispensing_reversed, new.idempotency_key,
      new.request_sha256, new.correlation_id, new.reported_at)
     is distinct from
     (old.id, old.route_id, old.kind, old.receiving_facility_id, old.receiving_organization_id,
      old.ordering_facility_id, old.state_before, old.reason_code, old.reported_by_account_id,
      old.reported_by_membership_id, old.accepted_by_account_id, old.accepted_by_membership_id, old.accepted_at,
      old.accepted_with, old.recorded_by_membership_ids, old.reporter_recorded_work, old.specimens_collected,
      old.results_voided, old.result_reports_marked, old.dispensing_reversed, old.idempotency_key,
      old.request_sha256, old.correlation_id, old.reported_at)
     or old.reviewed_at is not null
     or new.reviewed_at is null or new.reviewed_by_account_id is null or new.review_actions is null
     or new.review_note is null
     or cardinality(new.review_actions) < 1
     or array_position(new.review_actions, null) is not null
     or (select count(distinct action) from unnest(new.review_actions) action) <> cardinality(new.review_actions)
     or not (new.review_actions = array['no_further_action']
       or new.review_actions <@ array['ordering_facility_told', 'facility_contacted', 'staff_access_changed',
            'facility_suspended', 'referred_to_dpo'])
     or new.row_version is distinct from old.row_version + 1
     or (new.note_removed is distinct from old.note_removed
       and not (not old.note_removed and new.note_removed
         and new.note = 'Removed by Health ID support at review.'))
     or (new.note_removed is not distinct from old.note_removed and new.note is distinct from old.note) then
    raise exception using errcode = '55000', message = 'ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE';
  end if;
  return new;
end;
$$;
revoke all on function ehr.guard_order_route_wrong_patient_report() from public;

-- 4. The commands.

-- C25. The receiving facility ends an order it accepted for someone who was
-- not the order's patient (SPEC-FINAL 4.2, 4.3). Owner-only; the Lab and
-- Pharmacy wrappers below call it with their kind. In this order, in the
-- service's READ COMMITTED transaction; any refusal raises, so nothing is
-- stored:
--   1. the actor: a direct-care staff session holding the kind's receive
--      permission at the session facility (42501);
--   2. the input (22023 ORDER_ROUTE_INVALID): the reason one of four, the
--      note 8 to 500 characters once trimmed, the key and digest patterns;
--   3. the route-access control (55000);
--   4. a replay by the reporter's key at this facility: the same route, kind
--      and digest answer replayed with the route as it is now, anything else
--      IDEMPOTENCY_KEY_REUSED;
--   5. the route, unlocked: addressed here and of this kind (P0002);
--   6. (Lab) every result of the work item FOR UPDATE, in id order: a
--      release's own order (results, then the route), so the two never
--      deadlock, and it holds current_version still for the governance
--      validator's current-version rule;
--   7. the route: the application lock FOR SHARE, then FOR UPDATE;
--   8. the replay again, under the lock;
--   9. the state first, then the version: sent answers NOT_ACCEPTED; a route
--      that is not accepted or completed-and-not-ended inside its work window
--      (or that H7 no longer allows writing) answers ALREADY_ENDED; then a
--      stale version answers ORDER_ROUTE_VERSION_CONFLICT. So a concurrent end
--      by anyone answers ALREADY_ENDED, and only a concurrent return 412;
--  10. the permission to withdraw what must be withdrawn
--      (lab.result.entered-in-error, pharmacy.dispensing.reverse), else
--      P0001 ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED with the permission as
--      the DETAIL;
--  11. the facts for support, read while the row-level security still allows
--      it: who recorded the work, whether the reporter did, the specimens
--      taken;
--  12. (Lab) each result's current version not yet invalidated is
--      invalidated, with its outbox row (LabResultEnteredInError); for a
--      version A holds as released, 0086's trigger reports it at A; then
--      every released version A holds without an entered-in-error report gets
--      one directly (a version a correction replaced, or the released version
--      under an unreleased current correction), with one event and one row at
--      A for the batch;
--  13. (Pharmacy) a dispensing not yet reversed is reversed, with its outbox
--      row (MedicationDispensingReversed); 0086's trigger reports it at A;
--  14. the end, through 0086's closer: accepted -> cancelled, completed ->
--      access ended, both windows now, ended_kind wrong_patient. Every read of
--      step 11 and every insert into lab.result_invalidations,
--      lab.outbox_events, pharmacy.dispensing_reversals and
--      pharmacy.outbox_events comes before it: their row-level security and
--      the Lab outbox's reference check need the window this step closes;
--  15. the report row (T8), copying how the route was accepted (its T3
--      match);
--  16. a system row at A and at B, with the patient (ids and codes; never
--      the note);
--  17. the patient's inbox notice ORDER_ROUTE_WRONG_PATIENT;
--  18. the answer, with the patient for B's own audit row (never returned
--      over HTTP).
create function ehr.report_wrong_patient_order_route(
  requested_kind text,
  requested_route_id uuid,
  expected_version bigint,
  requested_reason text,
  requested_note text,
  requested_idempotency_key text,
  requested_request_sha256 char(64)
) returns table (
  result text,
  report_id uuid,
  route_row_version bigint,
  route_state text,
  effective_state text,
  ended_kind text,
  results_voided integer,
  result_reports_marked integer,
  dispensing_reversed boolean,
  state_before text,
  patient_id uuid
)
language plpgsql volatile
set search_path = pg_catalog, ehr, identity, auth, lab, pharmacy, notification, platform, pg_temp
as $$
declare
  actor record;
  prior record;
  peeked ehr.order_routes%rowtype;
  current_route ehr.order_routes%rowtype;
  marked_route ehr.order_routes%rowtype;
  closed record;
  accepted_attempt record;
  work_item uuid;
  item_results uuid[] := array[]::uuid[];
  note_text text := btrim(requested_note);
  needs_withdrawal boolean := false;
  recorded uuid[] := array[]::uuid[];
  specimen_count integer := 0;
  voided integer := 0;
  reports_before integer := 0;
  reports_direct integer := 0;
  reports_after integer := 0;
  reversed boolean := false;
  candidate record;
  reversal uuid;
  inserted_report uuid;
begin
  -- 1. The actor.
  select * into actor from ehr.order_route_receiver(requested_kind);
  -- 2. The input.
  if requested_route_id is null or expected_version is null or expected_version < 1
     or not coalesce(requested_reason in ('wrong_order_chosen', 'someone_elses_details', 'suspected_misuse', 'other'),
       false)
     or not coalesce(char_length(note_text) between 8 and 500, false)
     or not coalesce(requested_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$', false)
     or not coalesce(requested_request_sha256 ~ '^[0-9a-f]{64}$', false) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  -- 3. The control.
  perform platform.require_control_enabled('cross_facility_route_access_enabled');
  -- 4. A replay.
  select report.id, report.route_id, report.kind, report.request_sha256, report.results_voided,
         report.result_reports_marked, report.dispensing_reversed, report.state_before
    into prior
    from ehr.order_route_wrong_patient_reports report
   where report.reported_by_account_id = actor.actor_account_id
     and report.receiving_facility_id = actor.actor_facility_id
     and report.idempotency_key = requested_idempotency_key;
  if prior.id is not null then
    if prior.route_id <> requested_route_id or prior.kind <> requested_kind
       or prior.request_sha256 is distinct from requested_request_sha256 then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    select route.* into current_route from ehr.order_routes route where route.id = prior.route_id;
    return query select 'replayed'::text, prior.id, current_route.row_version, current_route.state,
      ehr.order_route_effective_state(current_route), current_route.ended_kind, prior.results_voided,
      prior.result_reports_marked, prior.dispensing_reversed, prior.state_before, current_route.patient_id;
    return;
  end if;
  -- 5. The route, unlocked (its work item is set once, at acceptance).
  select route.* into peeked from ehr.order_routes route
   where route.id = requested_route_id and route.kind = requested_kind
     and route.receiving_facility_id = actor.actor_facility_id;
  if peeked.id is null then
    raise exception using errcode = 'P0002', message = 'ORDER_ROUTE_NOT_FOUND';
  end if;
  work_item := coalesce(peeked.lab_work_item_id, peeked.pharmacy_work_item_id);
  -- 6. The results, locked in id order (Lab only).
  if requested_kind = 'lab_request' and work_item is not null then
    select coalesce(array_agg(locked.id order by locked.id), array[]::uuid[]) into item_results
      from (select result_row.id
              from lab.results result_row
              join lab.test_executions execution on execution.id = result_row.execution_id
              join lab.work_item_requested_tests test on test.id = execution.requested_test_id
             where test.work_item_id = work_item
             order by result_row.id
               for update of result_row) locked;
  end if;
  -- 7. The route, locked.
  current_route := ehr.lock_receiving_route(requested_kind, requested_route_id, actor.actor_facility_id,
    actor.actor_organization_id);
  -- 8. The replay again, under the lock.
  select report.id, report.route_id, report.kind, report.request_sha256, report.results_voided,
         report.result_reports_marked, report.dispensing_reversed, report.state_before
    into prior
    from ehr.order_route_wrong_patient_reports report
   where report.reported_by_account_id = actor.actor_account_id
     and report.receiving_facility_id = actor.actor_facility_id
     and report.idempotency_key = requested_idempotency_key;
  if prior.id is not null then
    if prior.route_id <> requested_route_id or prior.kind <> requested_kind
       or prior.request_sha256 is distinct from requested_request_sha256 then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query select 'replayed'::text, prior.id, current_route.row_version, current_route.state,
      ehr.order_route_effective_state(current_route), current_route.ended_kind, prior.results_voided,
      prior.result_reports_marked, prior.dispensing_reversed, prior.state_before, current_route.patient_id;
    return;
  end if;
  -- 9. The state first, then the version.
  if current_route.state = 'sent' then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_NOT_ACCEPTED';
  end if;
  if not ((current_route.state = 'accepted' and clock_timestamp() < current_route.writes_end_at)
          or (current_route.state = 'completed' and current_route.ended_at is null
              and clock_timestamp() < current_route.writes_end_at))
     or not ehr.order_route_allows(current_route.id, actor.actor_facility_id, 'write_records') then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ALREADY_ENDED';
  end if;
  if current_route.row_version <> expected_version then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_VERSION_CONFLICT';
  end if;
  work_item := coalesce(current_route.lab_work_item_id, current_route.pharmacy_work_item_id);
  -- The work item's results as they are now, under the route lock: one
  -- entered between steps 6 and 7 is withdrawn too, though not locked.
  if requested_kind = 'lab_request' then
    select coalesce(array_agg(result_row.id order by result_row.id), array[]::uuid[]) into item_results
      from lab.results result_row
      join lab.test_executions execution on execution.id = result_row.execution_id
      join lab.work_item_requested_tests test on test.id = execution.requested_test_id
     where test.work_item_id = work_item;
  end if;
  -- 10. The permission to withdraw what must be withdrawn.
  if requested_kind = 'lab_request' then
    needs_withdrawal := exists (
        select 1 from lab.results result_row
         where result_row.id = any(item_results)
           and exists (select 1 from lab.result_revisions revision
                        where revision.result_id = result_row.id and revision.version = result_row.current_version)
           and not exists (select 1 from lab.result_invalidations invalidation
                            where invalidation.result_id = result_row.id
                              and invalidation.result_version = result_row.current_version))
      or exists (
        select 1 from lab.order_route_result_reports released
         where released.route_id = current_route.id and released.kind = 'released'
           and not exists (select 1 from lab.order_route_result_reports marked
                            where marked.result_id = released.result_id
                              and marked.result_version = released.result_version
                              and marked.kind = 'entered_in_error'));
    if needs_withdrawal and not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id,
         actor.actor_facility_id, 'lab.result.entered-in-error') then
      raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
        detail = 'lab.result.entered-in-error';
    end if;
  else
    needs_withdrawal := exists (
      select 1 from pharmacy.dispensings dispensing
       where dispensing.work_item_id = work_item
         and not exists (select 1 from pharmacy.dispensing_reversals existing
                          where existing.dispensing_id = dispensing.id));
    if needs_withdrawal and not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id,
         actor.actor_facility_id, 'pharmacy.dispensing.reverse') then
      raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
        detail = 'pharmacy.dispensing.reverse';
    end if;
  end if;
  -- 11. The facts for support.
  if requested_kind = 'lab_request' then
    select coalesce(array_agg(distinct worker.membership_id order by worker.membership_id), array[]::uuid[])
      into recorded
      from (select revision.entered_by_membership_id as membership_id from lab.result_revisions revision
             where revision.result_id = any(item_results)
            union all
            select verification.verified_by_membership_id from lab.result_verifications verification
             where verification.result_id = any(item_results)
            union all
            select release_row.released_by_membership_id from lab.result_releases release_row
             where release_row.result_id = any(item_results)) worker
     where worker.membership_id is not null;
    select count(*)::integer into specimen_count
      from lab.specimens specimen
      join lab.accessions accession on accession.id = specimen.accession_id
     where accession.work_item_id = work_item and specimen.collected_at is not null;
  else
    select coalesce(array_agg(distinct dispensing.dispensed_by_membership_id
                              order by dispensing.dispensed_by_membership_id), array[]::uuid[])
      into recorded
      from pharmacy.dispensings dispensing
     where dispensing.work_item_id = work_item;
  end if;
  -- 12. The Lab voids.
  if requested_kind = 'lab_request' then
    select count(*)::integer into reports_before from lab.order_route_result_reports report
     where report.route_id = current_route.id and report.kind = 'entered_in_error';
    for candidate in
      select result_row.id, result_row.execution_id, result_row.patient_id, result_row.facility_id,
             result_row.current_version
        from lab.results result_row
       where result_row.id = any(item_results)
         and exists (select 1 from lab.result_revisions revision
                      where revision.result_id = result_row.id and revision.version = result_row.current_version)
         and not exists (select 1 from lab.result_invalidations invalidation
                          where invalidation.result_id = result_row.id
                            and invalidation.result_version = result_row.current_version)
       order by result_row.id
    loop
      insert into lab.result_invalidations (result_id, execution_id, patient_id, facility_id, result_version,
        disposition, actor_id, actor_membership_id, reason, idempotency_key, request_sha256, correlation_id)
      values (candidate.id, candidate.execution_id, candidate.patient_id, candidate.facility_id,
        candidate.current_version, 'entered_in_error', actor.actor_account_id, actor.actor_membership_id,
        'Accepted for someone who is not this order''s patient: not this patient''s result',
        'wrong-patient:' || current_route.id::text || ':' || candidate.id::text, requested_request_sha256,
        platform.current_correlation_id());
      insert into lab.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, patient_id,
        correlation_id, payload)
      values ('LabResultEnteredInError', candidate.id, candidate.current_version, candidate.facility_id,
        candidate.patient_id, platform.current_correlation_id(),
        jsonb_build_object('resultId', candidate.id, 'resultVersion', candidate.current_version,
          'status', 'entered_in_error'));
      voided := voided + 1;
    end loop;
    insert into lab.order_route_result_reports (route_id, work_item_id, result_id, result_version, kind,
      test_code_system, test_code, test_name, occurred_at, performing_facility_id)
    select released.route_id, released.work_item_id, released.result_id, released.result_version,
      'entered_in_error', released.test_code_system, released.test_code, released.test_name, clock_timestamp(),
      current_route.receiving_facility_id
      from lab.order_route_result_reports released
     where released.route_id = current_route.id and released.kind = 'released'
       and not exists (select 1 from lab.order_route_result_reports marked
                        where marked.result_id = released.result_id
                          and marked.result_version = released.result_version
                          and marked.kind = 'entered_in_error')
     order by released.recorded_at, released.id;
    get diagnostics reports_direct = row_count;
    if reports_direct > 0 then
      select route.* into marked_route from ehr.order_routes route where route.id = current_route.id;
      marked_route := ehr.write_order_route_change(marked_route, marked_route, 'result_marked_in_error', 'receiving',
        'wrong_patient');
      perform ehr.order_route_system_audit(marked_route, 'ordering', 'ehr.order-route.result-marked-in-error', true,
        jsonb_build_object('reportsMarked', reports_direct, 'reason', 'wrong_patient'));
    end if;
    select count(*)::integer into reports_after from lab.order_route_result_reports report
     where report.route_id = current_route.id and report.kind = 'entered_in_error';
  end if;
  -- 13. The Pharmacy void.
  if requested_kind = 'prescription' then
    select dispensing.id, dispensing.row_version, dispensing.work_item_id, dispensing.patient_id,
           dispensing.facility_id
      into candidate
      from pharmacy.dispensings dispensing
     where dispensing.work_item_id = work_item
       and not exists (select 1 from pharmacy.dispensing_reversals existing where existing.dispensing_id = dispensing.id);
    if candidate.id is not null then
      insert into pharmacy.dispensing_reversals as inserted (dispensing_id, dispensing_version, work_item_id,
        patient_id, facility_id, reversed_by, reversed_by_membership_id, reason, idempotency_key, request_sha256,
        correlation_id)
      values (candidate.id, candidate.row_version, candidate.work_item_id, candidate.patient_id, candidate.facility_id,
        actor.actor_account_id, actor.actor_membership_id,
        'Dispensed to someone who is not this prescription''s patient (wrong-patient report)',
        'wrong-patient:' || current_route.id::text, requested_request_sha256, platform.current_correlation_id())
      returning inserted.id into reversal;
      insert into pharmacy.outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version, facility_id,
        patient_id, correlation_id, payload)
      values ('MedicationDispensingReversed', 'medication-dispensing-reversal', reversal, 1, candidate.facility_id,
        candidate.patient_id, platform.current_correlation_id(),
        jsonb_build_object('reversalId', reversal, 'dispensingId', candidate.id, 'workItemId', candidate.work_item_id,
          'status', 'reversed'));
      reversed := true;
    end if;
  end if;
  -- 14. The end (H14 re-reads the locked route, with the steps' versions).
  select * into closed from ehr.close_order_route(current_route.id, 'wrong_patient', 'receiving', true);
  if closed.outcome is distinct from (case current_route.state when 'accepted' then 'cancelled'
                                                               else 'access_ended' end) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ALREADY_ENDED';
  end if;
  -- 15. The report row.
  select attempt.identifier_kind, attempt.identifies_route into accepted_attempt
    from ehr.order_route_accept_attempts attempt
   where attempt.route_id = current_route.id and attempt.outcome = 'match'
   order by attempt.attempted_at desc, attempt.id desc
   limit 1;
  insert into ehr.order_route_wrong_patient_reports as report (id, route_id, kind, receiving_facility_id,
    receiving_organization_id, ordering_facility_id, state_before, reason_code, note, reported_by_account_id,
    reported_by_membership_id, accepted_by_account_id, accepted_by_membership_id, accepted_at, accepted_with,
    recorded_by_membership_ids, reporter_recorded_work, specimens_collected, results_voided, result_reports_marked,
    dispensing_reversed, idempotency_key, request_sha256, correlation_id)
  values (gen_random_uuid(), current_route.id, current_route.kind, current_route.receiving_facility_id,
    current_route.receiving_organization_id, current_route.ordering_facility_id, current_route.state,
    requested_reason, note_text, actor.actor_account_id, actor.actor_membership_id,
    current_route.accepted_by_account_id, current_route.accepted_by_membership_id, current_route.accepted_at,
    case when accepted_attempt.identifier_kind = 'health_id' then 'health_id'
         when accepted_attempt.identifies_route then 'date_of_birth_with_reference'
         else 'date_of_birth' end,
    recorded, actor.actor_membership_id = any(recorded), specimen_count, voided, reports_after - reports_before,
    reversed, requested_idempotency_key, requested_request_sha256, platform.current_correlation_id())
  returning report.id into inserted_report;
  -- 16. The system rows at A and at B, with the patient.
  perform ehr.order_route_system_audit(closed.closed, 'ordering', 'ehr.order-route.wrong-patient', true,
    jsonb_build_object('reason', requested_reason, 'stateBefore', current_route.state, 'resultsVoided', voided,
      'dispensingReversed', reversed));
  perform ehr.order_route_system_audit(closed.closed, 'receiving', 'ehr.order-route.wrong-patient', true,
    jsonb_build_object('reason', requested_reason, 'stateBefore', current_route.state, 'resultsVoided', voided,
      'dispensingReversed', reversed));
  -- 17. The patient's notice.
  perform ehr.order_route_notify_patient(closed.closed, 'ORDER_ROUTE_WRONG_PATIENT');
  -- 18. The answer.
  return query select 'ended'::text, inserted_report, (closed.closed).row_version, (closed.closed).state,
    ehr.order_route_effective_state(closed.closed), (closed.closed).ended_kind, voided,
    reports_after - reports_before, reversed, current_route.state, current_route.patient_id;
end;
$$;

create function lab.report_wrong_patient_order_route(requested_route_id uuid, expected_version bigint,
  requested_reason text, requested_note text, requested_idempotency_key text, requested_request_sha256 char(64))
returns table (
  result text, report_id uuid, route_row_version bigint, route_state text, effective_state text, ended_kind text,
  results_voided integer, result_reports_marked integer, dispensing_reversed boolean, state_before text,
  patient_id uuid
)
language sql volatile security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select reported.result, reported.report_id, reported.route_row_version, reported.route_state,
    reported.effective_state, reported.ended_kind, reported.results_voided, reported.result_reports_marked,
    reported.dispensing_reversed, reported.state_before, reported.patient_id
    from ehr.report_wrong_patient_order_route('lab_request', requested_route_id, expected_version, requested_reason,
      requested_note, requested_idempotency_key, requested_request_sha256) reported
$$;

create function pharmacy.report_wrong_patient_order_route(requested_route_id uuid, expected_version bigint,
  requested_reason text, requested_note text, requested_idempotency_key text, requested_request_sha256 char(64))
returns table (
  result text, report_id uuid, route_row_version bigint, route_state text, effective_state text, ended_kind text,
  results_voided integer, result_reports_marked integer, dispensing_reversed boolean, state_before text,
  patient_id uuid
)
language sql volatile security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select reported.result, reported.report_id, reported.route_row_version, reported.route_state,
    reported.effective_state, reported.ended_kind, reported.results_voided, reported.result_reports_marked,
    reported.dispensing_reversed, reported.state_before, reported.patient_id
    from ehr.report_wrong_patient_order_route('prescription', requested_route_id, expected_version, requested_reason,
      requested_note, requested_idempotency_key, requested_request_sha256) reported
$$;

-- C26. Support's "Wrong-patient reports" (platform.facility.read):
-- unreviewed (every unreviewed report, at most 200, flagged first, then
-- oldest first) or recent (the last 90 days, newest first, at most 200),
-- optionally of one receiving facility (P0002 ADMIN_FACILITY_NOT_FOUND when
-- it does not exist). The flags and the two 30-day counts are computed per
-- row. No patient and no order content; names are
-- coalesce(display name, staff name), as support's staff list has them.
create function identity.admin_list_wrong_patient_reports(requested_status text, requested_facility_id uuid)
returns table (
  report_id uuid,
  row_version bigint,
  route_id uuid,
  reference text,
  kind text,
  receiving_facility_id uuid,
  receiving_facility_name text,
  ordering_facility_id uuid,
  ordering_facility_name text,
  reported_at timestamptz,
  reported_by_account_id uuid,
  reported_by_name text,
  accepted_by_account_id uuid,
  accepted_by_name text,
  same_member boolean,
  accepted_with text,
  accepted_at timestamptz,
  reason_code text,
  note text,
  note_removed boolean,
  state_before text,
  results_voided integer,
  result_reports_marked integer,
  dispensing_reversed boolean,
  specimens_collected integer,
  recorded_by jsonb,
  reporter_recorded_work boolean,
  flags text[],
  facility_reports_last_30_days integer,
  member_reports_last_30_days integer,
  reviewed_at timestamptz,
  reviewed_by_account_id uuid,
  reviewed_by_name text,
  review_actions text[],
  review_note text
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, ehr, auth, platform, pg_temp
as $$
begin
  perform identity.order_route_platform_actor(array['platform.facility.read']);
  if not coalesce(requested_status in ('unreviewed', 'recent'), false) then
    raise exception using errcode = '22023', message = 'WRONG_PATIENT_REPORTS_QUERY_INVALID';
  end if;
  if requested_facility_id is not null
     and not exists (select 1 from identity.facilities facility where facility.id = requested_facility_id) then
    raise exception using errcode = 'P0002', message = 'ADMIN_FACILITY_NOT_FOUND';
  end if;
  return query
    with listed as (
      select report.*,
        array_remove(array[
          case when report.state_before = 'completed' then 'something_came_back' end,
          case when report.reporter_recorded_work then 'reporter_recorded_work' end,
          case when report.reason_code = 'suspected_misuse' then 'suspected_misuse' end,
          case when report.reason_code = 'other' and report.results_voided = 0
                 and report.result_reports_marked = 0 and not report.dispensing_reversed
                 and report.specimens_collected = 0 then 'other_reason_nothing_recorded' end], null) as report_flags
        from ehr.order_route_wrong_patient_reports report
       where (requested_facility_id is null or report.receiving_facility_id = requested_facility_id)
         and ((requested_status = 'unreviewed' and report.reviewed_at is null)
           or (requested_status = 'recent' and report.reported_at > clock_timestamp() - interval '2160 hours'))
    )
    select listed.id, listed.row_version, listed.route_id, route.reference::text, listed.kind,
      listed.receiving_facility_id,
      (select facility.name from identity.facilities facility where facility.id = listed.receiving_facility_id),
      listed.ordering_facility_id,
      (select facility.name from identity.facilities facility where facility.id = listed.ordering_facility_id),
      listed.reported_at, listed.reported_by_account_id,
      (select coalesce(account.display_name, staff.full_name)
         from identity.staff_facility_memberships membership
         join auth.accounts account on account.id = membership.account_id
         left join identity.staff staff on staff.id = membership.staff_id
        where membership.id = listed.reported_by_membership_id),
      listed.accepted_by_account_id,
      (select coalesce(account.display_name, staff.full_name)
         from identity.staff_facility_memberships membership
         join auth.accounts account on account.id = membership.account_id
         left join identity.staff staff on staff.id = membership.staff_id
        where membership.id = listed.accepted_by_membership_id),
      listed.reported_by_membership_id = listed.accepted_by_membership_id,
      listed.accepted_with, listed.accepted_at, listed.reason_code, listed.note, listed.note_removed,
      listed.state_before, listed.results_voided, listed.result_reports_marked, listed.dispensing_reversed,
      listed.specimens_collected,
      coalesce((select jsonb_agg(jsonb_build_object('accountId', worker.account_id, 'name', worker.name)
                   order by worker.name, worker.account_id)
                  from (select membership.account_id, coalesce(account.display_name, staff.full_name) as name
                          from identity.staff_facility_memberships membership
                          join auth.accounts account on account.id = membership.account_id
                          left join identity.staff staff on staff.id = membership.staff_id
                         where membership.id = any(listed.recorded_by_membership_ids)) worker), '[]'::jsonb),
      listed.reporter_recorded_work, listed.report_flags,
      (select count(*)::integer from ehr.order_route_wrong_patient_reports other
        where other.receiving_facility_id = listed.receiving_facility_id
          and other.reported_at > clock_timestamp() - interval '720 hours'),
      (select count(*)::integer from ehr.order_route_wrong_patient_reports other
        where other.accepted_by_membership_id = listed.accepted_by_membership_id
          and other.reported_at > clock_timestamp() - interval '720 hours'),
      listed.reviewed_at, listed.reviewed_by_account_id,
      (select coalesce(account.display_name,
                (select staff.full_name from identity.staff staff where staff.account_id = account.id
                  order by staff.id limit 1))
         from auth.accounts account where account.id = listed.reviewed_by_account_id),
      listed.review_actions, listed.review_note
      from listed
      join ehr.order_routes route on route.id = listed.route_id
     order by
       case when requested_status = 'unreviewed' then cardinality(listed.report_flags) > 0 end desc nulls last,
       case when requested_status = 'unreviewed' then listed.reported_at end asc,
       case when requested_status = 'recent' then listed.reported_at end desc,
       listed.id
     limit 200;
end;
$$;

-- C27. Support's one review of a report (platform.facility.manage): one or
-- more distinct actions of five, or exactly no_further_action; a note of 8 to
-- 500 characters; and, once, the removal of the reporter's note (replaced by
-- fixed text). Missing P0002, already reviewed 23505, a stale version 40001,
-- invalid input 22023. Writes one platform audit row whose reason is the
-- review note.
create function identity.admin_review_wrong_patient_report(target_report_id uuid, expected_version bigint,
  requested_actions text[], requested_note text, requested_remove_note boolean)
returns table (report_id uuid, row_version bigint, reviewed_at timestamptz, review_actions text[],
  note_removed boolean)
language plpgsql volatile security definer
set search_path = pg_catalog, identity, ehr, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.order_route_platform_actor(array['platform.facility.manage']);
  review_text text := btrim(coalesce(requested_note, ''));
  remove_it boolean := coalesce(requested_remove_note, false);
  current_report record;
  reviewed record;
begin
  if target_report_id is null or expected_version is null or requested_actions is null
     or cardinality(requested_actions) < 1
     or array_position(requested_actions, null) is not null
     or (select count(distinct action) from unnest(requested_actions) action) <> cardinality(requested_actions)
     or not (requested_actions = array['no_further_action']
       or requested_actions <@ array['ordering_facility_told', 'facility_contacted', 'staff_access_changed',
            'facility_suspended', 'referred_to_dpo'])
     or char_length(review_text) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'WRONG_PATIENT_REVIEW_INVALID';
  end if;
  select report.id, report.route_id, report.row_version, report.reviewed_at into current_report
    from ehr.order_route_wrong_patient_reports report
   where report.id = target_report_id
   for update;
  if current_report.id is null then
    raise exception using errcode = 'P0002', message = 'WRONG_PATIENT_REPORT_NOT_FOUND';
  end if;
  if current_report.reviewed_at is not null then
    raise exception using errcode = '23505', message = 'WRONG_PATIENT_REPORT_ALREADY_REVIEWED';
  end if;
  if current_report.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Wrong-patient report version conflict';
  end if;
  update ehr.order_route_wrong_patient_reports report
     set reviewed_at = clock_timestamp(),
         reviewed_by_account_id = actor_account,
         review_actions = requested_actions,
         review_note = review_text,
         note_removed = case when remove_it then true else report.note_removed end,
         note = case when remove_it then 'Removed by Health ID support at review.' else report.note end,
         row_version = report.row_version + 1
   where report.id = current_report.id
  returning report.id, report.row_version, report.reviewed_at, report.review_actions, report.note_removed
    into reviewed;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details)
  values (platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    'admin.wrong-patient-report.review', 'success', 'order-route-wrong-patient-report', current_report.id::text,
    'healthcare-operations', review_text, 'application', 'identity-api',
    jsonb_build_object('reportId', current_report.id, 'routeId', current_report.route_id,
      'actions', to_jsonb(requested_actions), 'noteRemoved', reviewed.note_removed, 'version', reviewed.row_version));
  return query select reviewed.id, reviewed.row_version, reviewed.reviewed_at, reviewed.review_actions,
    reviewed.note_removed;
end;
$$;

-- C28. The ordering facility's Overview card (D10's alternative (a)): the
-- orders sent from the session's facility that ended 'wrong_patient' in the
-- last 30 days, newest first. Bound to the live staff session, its facility
-- and the direct-care purpose as C3 and C4 are (42501 otherwise). Privacy:
--   - a member without ehr.order-route.send at the facility sees nothing
--     (the same empty answer as a facility with no such order);
--   - full rows (reference, kind, receiving facility, the patient's name,
--     when it ended, what was withdrawn, and the order's link) only for
--     orders the member sent and whose patient's record they may still read
--     (ehr.context_allows, C3's check), at most 50;
--   - of every other such order (a colleague's, or the member's own without
--     read access now) only the count and the references, at most 100.
-- The EHR service audits each read (SPEC-FINAL item 3 contract, C28).
create function ehr.list_sent_wrong_patient_order_routes()
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, ehr, identity, auth, platform, pg_temp
as $$
declare
  actor record;
  answer jsonb;
begin
  select * into actor from ehr.order_route_staff_actor(true);
  if not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
           'ehr.order-route.send') then
    return jsonb_build_object('windowDays', 30, 'items', '[]'::jsonb,
      'others', jsonb_build_object('count', 0, 'references', '[]'::jsonb));
  end if;
  with ended as (
    select route.id, route.reference::text as reference, route.kind, route.patient_id, route.ended_at,
      route.receiving_facility_id, route.source_encounter_id,
      coalesce(route.source_lab_request_id, route.source_prescription_id) as order_id,
      report.result_reports_marked, report.dispensing_reversed,
      (route.sent_by_account_id = actor.actor_account_id
        and ehr.context_allows(route.patient_id, actor.actor_facility_id, 'read_records')) as full_row
      from ehr.order_route_wrong_patient_reports report
      join ehr.order_routes route on route.id = report.route_id
     where report.ordering_facility_id = actor.actor_facility_id
       and report.reported_at > clock_timestamp() - interval '720 hours'
       and route.ordering_facility_id = actor.actor_facility_id
       and route.ended_kind = 'wrong_patient'
       and route.ended_at > clock_timestamp() - interval '720 hours'
  )
  select jsonb_build_object('windowDays', 30,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('routeId', own.id, 'reference', own.reference, 'kind', own.kind,
          'receivingFacility', jsonb_build_object('id', own.receiving_facility_id,
            'name', (select facility.name from identity.facilities facility where facility.id = own.receiving_facility_id)),
          'patient', jsonb_build_object('name', (select patient.full_name from identity.patients patient
                                                  where patient.id = own.patient_id)),
          'endedAt', own.ended_at,
          'resultsWithdrawn', own.result_reports_marked,
          'dispensingReversed', own.dispensing_reversed,
          'link', jsonb_build_object('patientId', own.patient_id, 'encounterId', own.source_encounter_id,
            'kind', own.kind, 'orderId', own.order_id))
          order by own.ended_at desc, own.id)
        from (select * from ended where ended.full_row order by ended.ended_at desc, ended.id limit 50) own),
      '[]'::jsonb),
    'others', jsonb_build_object(
      'count', (select count(*) from ended where not ended.full_row),
      'references', coalesce((
        select jsonb_agg(other.reference order by other.ended_at desc, other.id)
          from (select ended.reference, ended.ended_at, ended.id from ended where not ended.full_row
                 order by ended.ended_at desc, ended.id limit 100) other), '[]'::jsonb)))
    into answer;
  return answer;
end;
$$;

revoke all on function ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,char),
  lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,char),
  pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,char),
  identity.admin_list_wrong_patient_reports(text,uuid),
  identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean),
  ehr.list_sent_wrong_patient_order_routes()
  from public;

-- 5. Grants (as 0086 section 7; runtime-grants.sql carries the same). The
-- login roles (hid_lab_api_runtime, hid_pharmacy_api_runtime,
-- hid_identity_api_runtime, hid_ehr_api_runtime) inherit their group's.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_lab_runtime') then
    grant execute on function lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,char),
      lab.order_route_cards(uuid[])
      to hid_lab_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    grant execute on function pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,char),
      pharmacy.order_route_cards(uuid[])
      to hid_pharmacy_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.admin_list_wrong_patient_reports(text,uuid),
      identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)
      to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.list_sent_wrong_patient_order_routes() to hid_ehr_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,char),
      lab.order_route_cards(uuid[]),
      pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,char),
      pharmacy.order_route_cards(uuid[]),
      ehr.list_sent_wrong_patient_order_routes()
      to hid_schema_test_runtime;
  end if;
end
$$;

-- 6. Last, under one ACCESS EXCLUSIVE lock on ehr.order_routes taken NOWAIT
-- (see Locks): 'wrong_patient' joins both ended-kind CHECKs, on cancelled and
-- completed routes only, and the report table is created.
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.order_routes in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0088: ehr.order_routes stayed busy for 5 seconds; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;

alter table ehr.order_routes
  drop constraint order_routes_ended_kind_check,
  add constraint order_routes_ended_kind_check check (ended_kind is null or ended_kind in ('orderer', 'patient',
    'order_changed', 'entered_in_error', 'receiving_released', 'ordering_released', 'support', 'order_in_work',
    'not_accepted', 'wrong_patient')) not valid,
  drop constraint order_routes_end_ck,
  add constraint order_routes_end_ck check (
    (ended_at is null) = (ended_kind is null)
    and (ended_by_account_id is null or ended_at is not null)
    and coalesce(case state
      when 'withdrawn' then ended_kind in ('orderer', 'patient', 'order_changed', 'entered_in_error',
        'receiving_released', 'ordering_released', 'support', 'order_in_work')
      when 'expired' then ended_kind = 'not_accepted'
      when 'cancelled' then ended_kind in ('order_changed', 'entered_in_error', 'receiving_released',
        'ordering_released', 'support', 'wrong_patient')
      when 'completed' then ended_kind is null or ended_kind in ('entered_in_error', 'receiving_released',
        'ordering_released', 'support', 'wrong_patient')
      else ended_kind is null end, false)) not valid;
alter table ehr.order_routes validate constraint order_routes_ended_kind_check;
alter table ehr.order_routes validate constraint order_routes_end_ck;

-- T8. The wrong-patient reports: one per route, append-only except support's
-- one review (the guard, section 3). Who did the work, whether the reporter
-- did, and how many specimens were taken are read by C25 while the route
-- still allowed it; how the route was accepted comes from its T3 match. The
-- note reaches support only (C26), never A, P or an audit row. Its only key
-- is to the route (no lock on hot tables).
create table ehr.order_route_wrong_patient_reports (
  id uuid primary key,
  route_id uuid not null unique references ehr.order_routes(id) on delete restrict,
  kind text not null check (kind in ('lab_request', 'prescription')),
  receiving_facility_id uuid not null,
  receiving_organization_id uuid not null,
  ordering_facility_id uuid not null,
  state_before text not null check (state_before in ('accepted', 'completed')),
  reason_code text not null check (reason_code in ('wrong_order_chosen', 'someone_elses_details', 'suspected_misuse',
    'other')),
  note text not null check (note = btrim(note) and char_length(note) between 8 and 500),
  note_removed boolean not null default false,
  reported_by_account_id uuid not null,
  reported_by_membership_id uuid not null,
  accepted_by_account_id uuid not null,
  accepted_by_membership_id uuid not null,
  accepted_at timestamptz not null,
  accepted_with text not null check (accepted_with in ('health_id', 'date_of_birth_with_reference', 'date_of_birth')),
  recorded_by_membership_ids uuid[] not null check (array_position(recorded_by_membership_ids, null) is null),
  reporter_recorded_work boolean not null,
  specimens_collected integer not null check (specimens_collected >= 0),
  results_voided integer not null check (results_voided >= 0),
  result_reports_marked integer not null check (result_reports_marked >= 0),
  dispensing_reversed boolean not null,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  reported_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by_account_id uuid,
  review_actions text[],
  review_note text check (review_note is null or (review_note = btrim(review_note)
    and char_length(review_note) between 8 and 500)),
  row_version bigint not null default 1 check (row_version > 0),
  constraint order_route_wrong_patient_reports_idempotency_uq
    unique (reported_by_account_id, receiving_facility_id, idempotency_key),
  constraint order_route_wrong_patient_reports_review_ck check (
    (reviewed_at is null and reviewed_by_account_id is null and review_actions is null and review_note is null)
    or (reviewed_at is not null and reviewed_by_account_id is not null and review_actions is not null
      and review_note is not null)),
  constraint order_route_wrong_patient_reports_actions_ck check (review_actions is null
    or (cardinality(review_actions) >= 1 and array_position(review_actions, null) is null
      and (review_actions = array['no_further_action']
        or review_actions <@ array['ordering_facility_told', 'facility_contacted', 'staff_access_changed',
             'facility_suspended', 'referred_to_dpo']))),
  constraint order_route_wrong_patient_reports_note_removed_ck check (not note_removed
    or (reviewed_at is not null and note = 'Removed by Health ID support at review.')),
  constraint order_route_wrong_patient_reports_kind_ck check (
    (kind = 'lab_request' and not dispensing_reversed)
    or (kind = 'prescription' and results_voided = 0 and result_reports_marked = 0 and specimens_collected = 0))
);
create index order_route_wrong_patient_reports_review_idx
  on ehr.order_route_wrong_patient_reports (reviewed_at nulls first, reported_at);
create index order_route_wrong_patient_reports_receiving_idx
  on ehr.order_route_wrong_patient_reports (receiving_facility_id, reported_at);
create index order_route_wrong_patient_reports_member_idx
  on ehr.order_route_wrong_patient_reports (accepted_by_membership_id, reported_at);
create index order_route_wrong_patient_reports_ordering_idx
  on ehr.order_route_wrong_patient_reports (ordering_facility_id, reported_at);
alter table ehr.order_route_wrong_patient_reports enable row level security;
alter table ehr.order_route_wrong_patient_reports force row level security;
create policy order_route_wrong_patient_reports_command_read on ehr.order_route_wrong_patient_reports
  for select using (true);
create policy order_route_wrong_patient_reports_command_insert on ehr.order_route_wrong_patient_reports
  for insert with check (true);
create policy order_route_wrong_patient_reports_command_update on ehr.order_route_wrong_patient_reports
  for update using (true) with check (true);
create policy order_route_wrong_patient_reports_command_delete on ehr.order_route_wrong_patient_reports
  for delete using (true);
revoke all on ehr.order_route_wrong_patient_reports from public;
create trigger order_route_wrong_patient_reports_guard
  before update or delete on ehr.order_route_wrong_patient_reports
  for each row execute function ehr.guard_order_route_wrong_patient_report();
