-- 0090 The receiving laboratory's or pharmacy's late correction of an order
-- it accepted for someone who was not the order's patient (D17, owner
-- decisions D17-1 to D17-13 of 2026-10-26, every recommended default).
--
-- Item 3 (0088) lets the laboratory or pharmacy (B) end such an order while
-- it may still work on it. After that (its window lapsed, or the order ended
-- another way) nothing could withdraw the other person's result. 0090 adds a
-- second, rare command beside item 3's, which stays byte for byte as it is:
-- B finds the order by its reference and withdraws what it recorded on it,
-- in one transaction, exactly as item 3 does (every result marked entered in
-- error, every version that went back to the ordering facility A reported
-- withdrawn there, a dispensing reversed), until 180 days after B accepted
-- the order (D17-2). B's access to the patient P is never reopened: the
-- command writes a one-off capability that works only inside its own
-- transaction, for P's rows of that kind at B and for the member who acts,
-- and deletes it before it returns.
--
-- 0. Preconditions (catalog reads; see Locks): no object of this migration
--    exists; the ten bodies this migration replaces or drops and the bodies
--    it relies on are byte for byte the ones measured on 0001-0089 (md5 of
--    pg_proc.prosrc); the CHECKs of ehr.order_routes and
--    ehr.order_route_events it relies on and every CHECK, unique key and
--    column of the report table (T8) are 0086's and 0088's (compared with the
--    same objects built on temporary tables in this session); T8's guard, the
--    route's two triggers and the four return triggers are 0088's and 0086's;
--    the server has xid8. Ownership and privileges follow 0089: H6's owner o
--    will own every new object; o may create in ehr, lab and pharmacy, read
--    and write what the new command and lookup read and write (T8 included)
--    and run what they call; every role that runs a body reading T8 after
--    0090 may read it; the owners of C5 and C21 may run o's helpers; the
--    applying role may become each owner. A privilege counts only when held
--    by ownership, membership or grant, never through a superuser's bypass:
--    production's migrator has none. A NOTICE names every owner checked.
--    Every attribute but the body of each replaced or dropped function is
--    recorded.
-- 1. T8 first, under one ACCESS EXCLUSIVE lock on T8 alone, taken NOWAIT:
--    four columns (late, ended_kind_before, discovered_by, discovered_on), a
--    wider state_before (also cancelled), the late report's CHECK, the review
--    rule's CHECK (D17-6: a late report where something had come back, or a
--    "pretending" one, cannot be reviewed without referred_to_dpo, nor,
--    where something came back and A was not released, without
--    ordering_facility_told) and a partial index for the limits. Every
--    existing row is not late, so every CHECK validates and item 3's command
--    writes valid rows by the defaults. Then T8's guard keeps the four new
--    columns fixed too.
-- 2. T9, ehr.order_route_correction_capabilities: the transaction-bound
--    capability, keyed by pg_current_xact_id(); row-level security enabled
--    and forced, three policies (select, insert, delete), no grant to any
--    role, no foreign key. Always empty at commit.
-- 3. Two owner-only helpers: ehr.order_route_correctable_until(route), the
--    one place the 180-day bound is set (the summary inlines the same
--    expression; the suite checks they agree), and
--    ehr.order_route_correction_state(route), PL/pgSQL: not_accepted,
--    reported, open (exactly item 3's window), correctable or too_late.
-- 4. H6, ehr.order_route_access_allows, replaced: 0086's body word for word,
--    plus, inside its existing "no route allows it" test, a capability
--    branch: pg_current_xact_id_if_assigned() (never txid_current(), which
--    would give a read-only transaction an id) must name a T9 row for this
--    facility, patient and kind and for the session's membership. The control
--    and the receive permission are still tested after it. H7 is unchanged.
-- 5. Item access and the release trigger, replaced: a T8 row closes a route
--    to writes and refuses a release (23514 ORDER_ROUTE_CLOSED) whatever its
--    ending, as ended_kind 'wrong_patient' does.
-- 6. The late command C29 ehr.correct_wrong_patient_order_route(...), through
--    lab.correct_wrong_patient_order_route(...) and
--    pharmacy.correct_wrong_patient_order_route(...), and B's lookup C30
--    ehr.find_correctable_order_routes(text,text), through
--    lab.find_correctable_order_routes(text) and
--    pharmacy.find_correctable_order_routes(text) (SECURITY DEFINER SQL
--    wrappers, as item 3's). At most 5 late corrections per member and 20
--    per facility in any 24 hours, exact under a per-facility advisory lock
--    (D17-9).
-- 7. The readers: the order summary (both new keys inline, no helper call),
--    the ordering facility's Overview (C28, keyed on the report), the
--    patient's list (C5), support's reports list (C26), review (C27, the
--    referral rule) and find (C21). C5, C21 and C26 gain trailing columns,
--    so they are dropped and created with their bodies and attributes
--    otherwise.
-- 8. Owners and attributes: every new object goes to o; C5, C21 and C26 go
--    back to their recorded owners; every recorded attribute of the
--    replaced and recreated functions must be as before, or the release
--    stops.
-- 9. Grants, here and in runtime-grants.sql: the four Lab and Pharmacy
--    wrappers to their runtimes and the schema test runtime; C5, C21 and C26
--    again as before the DROP. Everything new is revoked from PUBLIC; T9,
--    the helpers, C29 and C30 are granted to no role. Last, C5's, C21's and
--    C26's grants, as a set of (grantee, privilege), must equal those
--    recorded before the DROP.
--
-- Locks (measured with pg_locks at every section boundary, as the migrator
-- and as a NOSUPERUSER owner, and with each table held by another session).
-- Section 0 takes momentary ACCESS SHARE locks, released at once, on
-- ehr.order_routes, ehr.order_route_events and T8 (pg_get_constraintdef).
-- Section 1 takes ACCESS EXCLUSIVE on T8 alone, NOWAIT: a busy table fails
-- the attempt at once, its subtransaction releases what it took, and the
-- loop tries again 100 ms later, so the migration never waits while holding
-- it and no request queues behind a waiting lock; after 50 attempts (5
-- seconds) it stops the release with nothing applied (55P03). It is held to
-- commit (the index build adds SHARE on T8); while it is held only item 3's
-- report (C25), support's list and review (C26, C27) and the Overview read
-- (C28) wait, because the other bodies that read T8 become visible to other
-- sessions only at commit. Section 5's PL/pgSQL validator takes a momentary
-- ACCESS SHARE on lab.result_revisions (the release trigger's %ROWTYPE).
-- Held to commit besides T8: ACCESS EXCLUSIVE on the new T9, its primary
-- key and its TOAST table, and ACCESS SHARE on identity.facilities, which
-- the summary's LANGUAGE sql body names when it is created. Nothing else is
-- locked: nothing on ehr.order_routes beyond that momentary read, nothing
-- else on any Lab or Pharmacy chain table, nothing on
-- platform.control_settings or identity.consent_grants. ACCESS SHARE
-- conflicts only with ACCESS EXCLUSIVE: with ACCESS EXCLUSIVE held on
-- ehr.order_routes, ehr.order_route_events, T8, identity.facilities or
-- lab.result_revisions, the runner's lock_timeout stops the dry run and the
-- apply after 5 seconds with nothing applied; held on any other table the
-- new bodies read, 0090 applies without waiting.
--
-- Old services on this schema: the previous Lab and Pharmacy images call
-- none of the new functions; item access and the release trigger change
-- only routes with a T8 row the late command wrote; item 3's command writes
-- T8 with the new columns' defaults, which satisfy the new CHECKs. The
-- previous EHR maps the summary's and C28's keys field by field and reads
-- C5 by name; the previous Identity names its C21 columns and reads C26 by
-- name (its review of a late report with "No further action" answers 400
-- WRONG_PATIENT_REVIEW_INVALID; late reports exist only once the new
-- services ran). Applied migrations 0001 through 0089 are immutable.

-- 0. Preconditions. The release dry-runs every pending migration in one
-- transaction before applying any, so a refusal here stops the release with
-- nothing changed. Catalog reads (see Locks).

-- Whether holder holds a privilege on an object by ownership, by membership
-- (direct or through other roles) or by grant (also to PUBLIC), ignoring a
-- superuser's bypass. Dropped at the end of this section.
create function pg_temp.order_route_0090_holds(holder oid, object_owner oid, object_acl aclitem[],
  object_type "char", wanted text)
returns boolean
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  with recursive held(role_id) as (
    select holder
    union
    select membership.roleid from pg_catalog.pg_auth_members membership join held on membership.member = held.role_id
  )
  select object_owner in (select held.role_id from held)
    or exists (select 1 from pg_catalog.aclexplode(coalesce(object_acl, pg_catalog.acldefault(object_type, object_owner))) acl
                where acl.privilege_type = wanted
                  and (acl.grantee = 0 or acl.grantee in (select held.role_id from held)))
$$;

do $$
declare
  mismatch text;
  o oid;
  owners_named text;
begin
  -- a. No collision, under any signature.
  if to_regclass('ehr.order_route_correction_capabilities') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where (namespace.nspname, proc.proname) in (
                   ('ehr', 'order_route_correctable_until'), ('ehr', 'order_route_correction_state'),
                   ('ehr', 'correct_wrong_patient_order_route'), ('lab', 'correct_wrong_patient_order_route'),
                   ('pharmacy', 'correct_wrong_patient_order_route'), ('ehr', 'find_correctable_order_routes'),
                   ('lab', 'find_correctable_order_routes'), ('pharmacy', 'find_correctable_order_routes')))
     or exists (select 1 from pg_attribute attribute
                 where attribute.attrelid = 'ehr.order_route_wrong_patient_reports'::regclass
                   and attribute.attname in ('late', 'ended_kind_before', 'discovered_by', 'discovered_on'))
     or exists (select 1 from pg_constraint constraint_row
                 where constraint_row.conrelid = 'ehr.order_route_wrong_patient_reports'::regclass
                   and constraint_row.conname in ('order_route_wrong_patient_reports_late_ck',
                     'order_route_wrong_patient_reports_late_review_ck'))
     or to_regclass('ehr.order_route_wrong_patient_reports_late_member_idx') is not null then
    raise exception '0090: an object of this migration already exists; this release would collide with it';
  end if;
  -- b. The bodies this migration replaces (H6, item access, the release
  -- trigger, T8's guard, C28, C27, the summary) or drops and creates (C26,
  -- C5, C21): md5 of pg_proc.prosrc measured on 0001-0089.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ehr.order_route_access_allows(text,uuid,uuid,text)', '20d9847baf91a6b801ff1db2127ce2a7'),
      ('ehr.order_route_item_access(text,uuid,text)', 'fc1316081592f96211c6163e72212703'),
      ('lab.return_order_route_result()', '16b4808a4813b4e4449442ef19f4540d'),
      ('ehr.guard_order_route_wrong_patient_report()', '23ac59132640a885e324f8d5f4045860'),
      ('ehr.list_sent_wrong_patient_order_routes()', '0ac5bedef23bd7b0f07eeab4f81d08b3'),
      ('identity.admin_list_wrong_patient_reports(text,uuid)', 'a50d944be8b98a11e457f8a0be51043f'),
      ('identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)',
       'f7747d150dd9cdccde1b96d82d8b2e09'),
      ('ehr.order_route_summary(ehr.order_routes,boolean)', 'b625d789c128813d947bd15110a5e74b'),
      ('ehr.patient_list_order_routes()', '021da2ec202ee6dfbc6eaee88a2672c2'),
      ('identity.admin_find_order_routes(text,text)', '7c2c98b09074e412486fc4f88a593ac9'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception '0090: a function this migration replaces or drops has another body than 0001-0089 gave it: %',
      mismatch;
  end if;
  -- c. The bodies 0090 relies on, unchanged: every function a new, replaced
  -- or recreated body calls (H7, the closer, the route writer and guard, the
  -- route lock and the application lock it takes, the receiver and staff
  -- actor, H9, the audit and notice writers and the inbox writer, the
  -- control readers, the permission check, the session readers, the
  -- platform actor, the Health ID normalizer, the destination check, the
  -- patient session, the registered address, the membership test of C26),
  -- and the bodies whose behaviour the new ones mirror or depend on (the
  -- chain policies' context functions, the return triggers, the governance
  -- validators, the Lab outbox reference check, item 3's report and its
  -- wrappers, the route cards, C3 and C4, the resource checks, 0089's
  -- order_routes_here, support's Close, the acceptance and the two
  -- endings' triggers).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ehr.order_route_allows(uuid,uuid,text)', 'b80c2df6c380f7c7e20d166da94e56d2'),
      ('ehr.close_order_route(uuid,text,text,boolean)', 'd0c8c11573bc3fd5cc764553d55b1820'),
      ('ehr.write_order_route_change(ehr.order_routes,ehr.order_routes,text,text,text)',
       'b11691bfe99d65a93d60eefe0fc8c0c1'),
      ('ehr.guard_order_route_mutation()', '6a01bc885cd54f87a1bee8c0ebc100a4'),
      ('ehr.lock_receiving_route(text,uuid,uuid,uuid)', 'b73b01f7ca721adb0de4e834dd566e3a'),
      ('identity.lock_self_service_application(uuid)', '4eeb309085494a7652c19e7d6365e131'),
      ('ehr.order_route_receiver(text)', '61eed3f80f2502aadc338581142214a5'),
      ('ehr.order_route_staff_actor(boolean)', 'b1873dca92164652cc1977a90acb6184'),
      ('ehr.order_route_effective_state(ehr.order_routes)', '934300a9e58a7f6789b1dc24520fabad'),
      ('ehr.order_route_system_audit(ehr.order_routes,text,text,boolean,jsonb)',
       '6c54f543a495e35d9ebd029450d49e0a'),
      ('ehr.order_route_notify_patient(ehr.order_routes,text)', '31a11a44325846699036367b7e56b46e'),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)',
       '0b5689f31a3ce00f9313fe1e55244fad'),
      ('platform.require_control_enabled(text)', '90887489d15eab24f8f71b145bb02320'),
      ('ehr.order_route_access_open()', 'd0b8aff4c2a656c30872b95286071457'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('ehr.order_route_receive_permission(text)', '4c9f4acbafb062ff9a2cda113ccad037'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('lab.context_allows(uuid,uuid,text)', '57e689661a6227e34d3bde9562468951'),
      ('pharmacy.context_allows(uuid,uuid,text)', '958a6e5cd2a534d158c82fe399b8f381'),
      ('lab.return_order_route_invalidation()', '2176bfd64b05c6e357021c178060f1b7'),
      ('pharmacy.return_order_route_reversal()', '7cf0067c59c502026be74e292a8989ab'),
      ('lab.validate_result_governance()', '6bf52a22ce45e834d4f2a194a06babad'),
      ('pharmacy.validate_dispensing_reversal()', 'a8b1147f356e669fe0d14bea3e7ab014'),
      ('lab.validate_outbox_aggregate_reference()', 'b86458c9a75df2fec44f6ddf7a8acbef'),
      ('ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,character)',
       'ef39eba74338f1414787ade116e3bc6b'),
      ('lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)',
       'cddfb3e83aef2e54d071578530f8c4ea'),
      ('pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)',
       '38cbfa3b8e11fecc1654dd6a36718253'),
      ('ehr.receiving_order_route_cards(text,uuid[])', 'ac3cb68817a41d49ebb186c7a4e9dd5d'),
      ('lab.order_route_cards(uuid[])', '1093a2fed7f01b61c5b1a95c32353a05'),
      ('pharmacy.order_route_cards(uuid[])', '6504851cb99e0cf975ca2f7a27402886'),
      ('ehr.list_order_routes_for_order(text,uuid,uuid)', 'cb6c138fbbffa1e1f226cde0aac1ec0b'),
      ('ehr.order_route_summaries(text,uuid,uuid[])', 'bee72d84a41b7c1bba7a0b492ca6546c'),
      ('lab.order_route_access_for(text,uuid,text)', '3c2b16b767a524da80bd2e08787137b2'),
      ('pharmacy.order_route_access_for(text,uuid,text)', 'e7ca58cd88b563f72065bbb78ea04c13'),
      ('ehr.order_routes_here(text)', '92ad7c407b47356e106f22d48238a1e2'),
      ('identity.admin_close_order_route(uuid,bigint,text)', 'e0ea834d458863ec19a94b4853e2a32c'),
      ('ehr.accept_receiving_order_route(text,uuid,bigint,text,text,text,text,character,text)',
       '1d4a77de6316fa95a539d8151c8604df'),
      ('ehr.sync_order_routes_on_order_change()', '8ce6b42450cc06fc02fec8d1cf63af41'),
      ('ehr.close_order_routes_on_release()', '2d082c1e58b250a46fe0ea4e7c05c099'),
      ('identity.order_route_platform_actor(text[])', '599cccfdba5e9b4c46cde4dd2814a541'),
      ('ehr.order_route_health_id(text)', 'f336e87adb3ac67fd83ac1de7b3efa7d'),
      ('identity.order_route_destination_eligible(uuid,text)', '6b274d9be9056cefc831a9fd92040bc6'),
      ('ehr.order_route_patient()', '675c6185c12c43e651ebf0a22770d282'),
      ('identity.order_route_registered_address(uuid)', '80a2c9e306c72dff55aa2c91af9b93d2'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception '0090: a function the late correction relies on has another body than 0001-0089 gave it: %',
      mismatch;
  end if;
  -- d. The CHECKs 0090 relies on, compared with the same CHECKs built on
  -- temporary tables in this session (as 0088 and 0089 compare theirs):
  -- ehr.order_routes' two ended-kind CHECKs as 0088 left them (with
  -- wrong_patient) and its acceptance CHECK as 0086 made it; the route
  -- events' type and reason CHECKs; and every CHECK and key of T8 with its
  -- columns (names, types, nullability, defaults) exactly as 0088 made them.
  create temporary table order_routes_0090_checks (
    kind text,
    state text,
    accepted_at timestamptz,
    accepted_by_account_id uuid,
    accepted_by_membership_id uuid,
    accept_idempotency_key text,
    accept_request_sha256 char(64),
    lab_work_item_id uuid,
    pharmacy_work_item_id uuid,
    writes_end_at timestamptz,
    access_ends_at timestamptz,
    ended_kind text,
    ended_at timestamptz,
    ended_by_account_id uuid,
    constraint order_routes_ended_kind_check check (ended_kind is null or ended_kind in ('orderer', 'patient',
      'order_changed', 'entered_in_error', 'receiving_released', 'ordering_released', 'support', 'order_in_work',
      'not_accepted', 'wrong_patient')),
    constraint order_routes_end_ck check (
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
        else ended_kind is null end, false)),
    constraint order_routes_acceptance_ck check (
      (accepted_at is null and accepted_by_account_id is null and accepted_by_membership_id is null
        and accept_idempotency_key is null and accept_request_sha256 is null
        and lab_work_item_id is null and pharmacy_work_item_id is null
        and writes_end_at is null and access_ends_at is null
        and state in ('sent', 'declined', 'withdrawn', 'expired'))
      or (accepted_at is not null and accepted_by_account_id is not null and accepted_by_membership_id is not null
        and accept_idempotency_key is not null and accept_request_sha256 is not null
        and ((kind = 'lab_request' and lab_work_item_id is not null)
          or (kind = 'prescription' and pharmacy_work_item_id is not null))
        and writes_end_at is not null and access_ends_at is not null
        and writes_end_at <= access_ends_at and access_ends_at <= accepted_at + interval '1080 hours'
        and state in ('accepted', 'completed', 'cancelled')))
  ) on commit drop;
  create temporary table order_route_events (
    event_type text check (event_type in ('created', 'withdrawn', 'expired', 'accept_locked', 'accepted',
      'declined', 'cancelled', 'completed', 'result_returned', 'result_marked_in_error', 'dispensing_returned',
      'dispensing_reversed', 'order_changed_after_acceptance', 'order_changed_after_completion', 'access_ended')),
    reason_code text check (reason_code is null or reason_code ~ '^[a-z][a-z_]{1,39}$')
  ) on commit drop;
  -- T8 as 0088 created it, under its own name in pg_temp, so that the
  -- generated constraint names are the same (its key to the route aside: a
  -- temporary table cannot reference a permanent one).
  create temporary table order_route_wrong_patient_reports (
    id uuid primary key,
    route_id uuid not null unique,
    kind text not null check (kind in ('lab_request', 'prescription')),
    receiving_facility_id uuid not null,
    receiving_organization_id uuid not null,
    ordering_facility_id uuid not null,
    state_before text not null check (state_before in ('accepted', 'completed')),
    reason_code text not null check (reason_code in ('wrong_order_chosen', 'someone_elses_details',
      'suspected_misuse', 'other')),
    note text not null check (note = btrim(note) and char_length(note) between 8 and 500),
    note_removed boolean not null default false,
    reported_by_account_id uuid not null,
    reported_by_membership_id uuid not null,
    accepted_by_account_id uuid not null,
    accepted_by_membership_id uuid not null,
    accepted_at timestamptz not null,
    accepted_with text not null check (accepted_with in ('health_id', 'date_of_birth_with_reference',
      'date_of_birth')),
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
  ) on commit drop;
  select string_agg(expected.conname, ', ') into mismatch
    from (values ('ehr.order_routes', 'pg_temp.order_routes_0090_checks', 'order_routes_ended_kind_check'),
                 ('ehr.order_routes', 'pg_temp.order_routes_0090_checks', 'order_routes_end_ck'),
                 ('ehr.order_routes', 'pg_temp.order_routes_0090_checks', 'order_routes_acceptance_ck'),
                 ('ehr.order_route_events', 'pg_temp.order_route_events', 'order_route_events_event_type_check'),
                 ('ehr.order_route_events', 'pg_temp.order_route_events', 'order_route_events_reason_code_check'))
         expected(live_table, built_table, conname)
   where (select pg_get_constraintdef(live.oid) from pg_constraint live
           where live.conrelid = expected.live_table::regclass and live.conname = expected.conname
             and live.contype = 'c' and live.convalidated)
         is distinct from
         (select pg_get_constraintdef(built.oid) from pg_constraint built
           where built.conrelid = expected.built_table::regclass and built.conname = expected.conname
             and built.contype = 'c');
  if mismatch is not null then
    raise exception '0090: a CHECK this migration relies on is not the one 0086 and 0088 made: %', mismatch;
  end if;
  if (select array_agg(format('%s %s %s', constraint_row.conname, constraint_row.contype,
            pg_get_constraintdef(constraint_row.oid)) order by constraint_row.conname)
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'ehr.order_route_wrong_patient_reports'::regclass
         and constraint_row.contype in ('c', 'u', 'p') and constraint_row.convalidated)
     is distinct from
     (select array_agg(format('%s %s %s', constraint_row.conname, constraint_row.contype,
            pg_get_constraintdef(constraint_row.oid)) order by constraint_row.conname)
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'pg_temp.order_route_wrong_patient_reports'::regclass
         and constraint_row.contype in ('c', 'u', 'p'))
     or (select array_agg(format('%s %s %s %s', attribute.attname, format_type(attribute.atttypid, attribute.atttypmod),
            attribute.attnotnull, pg_get_expr(default_row.adbin, default_row.adrelid)) order by attribute.attnum)
           from pg_attribute attribute
           left join pg_attrdef default_row
             on default_row.adrelid = attribute.attrelid and default_row.adnum = attribute.attnum
          where attribute.attrelid = 'ehr.order_route_wrong_patient_reports'::regclass
            and attribute.attnum > 0 and not attribute.attisdropped)
        is distinct from
        (select array_agg(format('%s %s %s %s', attribute.attname, format_type(attribute.atttypid, attribute.atttypmod),
            attribute.attnotnull, pg_get_expr(default_row.adbin, default_row.adrelid)) order by attribute.attnum)
           from pg_attribute attribute
           left join pg_attrdef default_row
             on default_row.adrelid = attribute.attrelid and default_row.adnum = attribute.attnum
          where attribute.attrelid = 'pg_temp.order_route_wrong_patient_reports'::regclass
            and attribute.attnum > 0 and not attribute.attisdropped)
     or not exists (select 1 from pg_constraint constraint_row
                     where constraint_row.conrelid = 'ehr.order_route_wrong_patient_reports'::regclass
                       and constraint_row.conname = 'order_route_wrong_patient_reports_route_id_fkey'
                       and constraint_row.contype = 'f'
                       and constraint_row.confrelid = 'ehr.order_routes'::regclass) then
    raise exception '0090: ehr.order_route_wrong_patient_reports is not the table 0088 created (its CHECKs, keys or columns differ)';
  end if;
  drop table pg_temp.order_routes_0090_checks, pg_temp.order_route_events, pg_temp.order_route_wrong_patient_reports;
  -- e. Triggers: T8's only user trigger is 0088's guard (before update or
  -- delete, for each row); the route's two user triggers are 0086's; the
  -- four return triggers call 0086's and 0088's functions.
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.order_route_wrong_patient_reports'::regclass
         and not trigger_row.tgisinternal) <> 1
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'ehr.order_route_wrong_patient_reports'::regclass
                       and trigger_row.tgname = 'order_route_wrong_patient_reports_guard'
                       and trigger_row.tgtype = 27 and trigger_row.tgenabled = 'O'
                       and trigger_row.tgfoid = 'ehr.guard_order_route_wrong_patient_report()'::regprocedure)
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'ehr.order_routes'::regclass and not trigger_row.tgisinternal) <> 2
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'ehr.order_routes'::regclass
                       and trigger_row.tgname = 'order_routes_guard' and trigger_row.tgtype = 27
                       and trigger_row.tgenabled = 'O'
                       and trigger_row.tgfoid = 'ehr.guard_order_route_mutation()'::regprocedure)
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'ehr.order_routes'::regclass
                       and trigger_row.tgname = 'order_routes_first_event' and trigger_row.tgtype = 5
                       and trigger_row.tgenabled = 'O'
                       and trigger_row.tgfoid = 'ehr.require_order_route_first_event()'::regprocedure) then
    raise exception '0090: the report table''s or the route''s user triggers are not 0088''s and 0086''s';
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
    raise exception '0090: a return trigger is not 0086''s: %', mismatch;
  end if;
  -- g. The server: xid8, pg_current_xact_id() and
  -- pg_current_xact_id_if_assigned() (PostgreSQL 13).
  if current_setting('server_version_num')::integer < 130000 then
    raise exception '0090: PostgreSQL 13 or later is required (xid8 and pg_current_xact_id_if_assigned)';
  end if;
  -- h. Every attribute but the body of each function this migration replaces
  -- or drops, for section 8.
  create temporary table order_route_late_0090 on commit drop as
    select proc.oid::regprocedure::text as signature, proc.proowner, proc.prolang, proc.procost, proc.prorows,
           proc.provariadic, proc.prosupport, proc.prokind, proc.prosecdef, proc.proleakproof, proc.proisstrict,
           proc.proretset, proc.provolatile, proc.proparallel, proc.pronargs, proc.pronargdefaults, proc.prorettype,
           proc.proargtypes, proc.proallargtypes, proc.proargmodes, proc.proargnames,
           proc.proargdefaults::text as proargdefaults, proc.protrftypes, proc.probin,
           proc.prosqlbody::text as prosqlbody, proc.proconfig, proc.proacl
      from pg_proc proc
     where proc.oid in ('ehr.order_route_access_allows(text,uuid,uuid,text)'::regprocedure,
                        'ehr.order_route_item_access(text,uuid,text)'::regprocedure,
                        'lab.return_order_route_result()'::regprocedure,
                        'ehr.guard_order_route_wrong_patient_report()'::regprocedure,
                        'ehr.list_sent_wrong_patient_order_routes()'::regprocedure,
                        'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure,
                        'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)'::regprocedure,
                        'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure,
                        'ehr.patient_list_order_routes()'::regprocedure,
                        'identity.admin_find_order_routes(text,text)'::regprocedure);
  if (select count(*) from pg_temp.order_route_late_0090) <> 10 then
    raise exception '0090: a function this migration replaces or drops is missing';
  end if;
  -- f. Ownership and privileges (as 0089, privilege-based). o is H6's owner;
  -- it will own T9, the helpers, C29, C30 and their wrappers, so every body
  -- that reads T9 runs as o. A privilege counts when held by ownership,
  -- membership or grant (pg_temp.order_route_0090_holds), never through a
  -- superuser's bypass, which production's migrator does not have. T8's
  -- owner is not changed: item 3's command and support's review write T8
  -- with their owner's rights.
  select recorded.proowner into o from pg_temp.order_route_late_0090 recorded
   where recorded.signature::regprocedure = 'ehr.order_route_access_allows(text,uuid,uuid,text)'::regprocedure;
  select string_agg(distinct format('%s=%s', checked.what, pg_get_userbyid(checked.role_id)), ', ') into owners_named
    from (select 'o (H6)' as what, o as role_id
          union all select 'T8', relation.relowner from pg_class relation
                     where relation.oid = 'ehr.order_route_wrong_patient_reports'::regclass
          union all select recorded.signature, recorded.proowner from pg_temp.order_route_late_0090 recorded
          union all select proc.oid::regprocedure::text, proc.proowner from pg_proc proc
                     where proc.oid in ('ehr.list_order_routes_for_order(text,uuid,uuid)'::regprocedure,
                       'ehr.order_route_summaries(text,uuid,uuid[])'::regprocedure,
                       'lab.order_route_access_for(text,uuid,text)'::regprocedure,
                       'pharmacy.order_route_access_for(text,uuid,text)'::regprocedure)) checked;
  raise notice '0090: owners checked: %', owners_named;
  -- o may create in the three schemas, and read and write what C29, C30 and
  -- the helpers read and write.
  select string_agg(format('%s %s', needed.what, needed.privilege), ', ') into mismatch
    from (
      select namespace.nspname as what, 'CREATE' as privilege, namespace.nspowner as owner_id,
             namespace.nspacl as acl, 'n'::"char" as object_type
        from pg_namespace namespace where namespace.nspname in ('ehr', 'lab', 'pharmacy')
      union all
      select relation.oid::regclass::text, wanted.privilege, relation.relowner, relation.relacl, 'r'::"char"
        from (values ('ehr.order_route_wrong_patient_reports', 'SELECT'),
                     ('ehr.order_route_wrong_patient_reports', 'INSERT'),
                     ('ehr.order_routes', 'SELECT'), ('ehr.order_routes', 'UPDATE'),
                     ('ehr.order_route_events', 'INSERT'), ('ehr.order_route_accept_attempts', 'SELECT'),
                     ('identity.facilities', 'SELECT'), ('identity.staff_facility_memberships', 'SELECT'),
                     ('identity.staff', 'SELECT'), ('auth.accounts', 'SELECT'),
                     ('lab.results', 'SELECT'), ('lab.results', 'UPDATE'), ('lab.test_executions', 'SELECT'),
                     ('lab.work_item_requested_tests', 'SELECT'), ('lab.result_revisions', 'SELECT'),
                     ('lab.result_verifications', 'SELECT'), ('lab.result_releases', 'SELECT'),
                     ('lab.specimens', 'SELECT'), ('lab.accessions', 'SELECT'),
                     ('lab.result_invalidations', 'SELECT'), ('lab.result_invalidations', 'INSERT'),
                     ('lab.outbox_events', 'INSERT'), ('lab.order_route_result_reports', 'SELECT'),
                     ('lab.order_route_result_reports', 'INSERT'), ('pharmacy.dispensings', 'SELECT'),
                     ('pharmacy.dispensing_reversals', 'SELECT'), ('pharmacy.dispensing_reversals', 'INSERT'),
                     ('pharmacy.outbox_events', 'INSERT'), ('pharmacy.order_route_dispensing_reports', 'SELECT'),
                     ('audit.events', 'INSERT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
      union all
      select proc.oid::regprocedure::text, 'EXECUTE', proc.proowner, proc.proacl, 'f'::"char"
        from pg_proc proc
       where proc.oid in ('ehr.order_route_receiver(text)'::regprocedure,
                          'ehr.order_route_staff_actor(boolean)'::regprocedure,
                          'platform.require_control_enabled(text)'::regprocedure,
                          'ehr.lock_receiving_route(text,uuid,uuid,uuid)'::regprocedure,
                          'identity.lock_self_service_application(uuid)'::regprocedure,
                          'auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure,
                          'ehr.write_order_route_change(ehr.order_routes,ehr.order_routes,text,text,text)'::regprocedure,
                          'ehr.order_route_system_audit(ehr.order_routes,text,text,boolean,jsonb)'::regprocedure,
                          'ehr.close_order_route(uuid,text,text,boolean)'::regprocedure,
                          'ehr.order_route_notify_patient(ehr.order_routes,text)'::regprocedure,
                          'notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'::regprocedure,
                          'ehr.order_route_effective_state(ehr.order_routes)'::regprocedure,
                          'platform.current_correlation_id()'::regprocedure,
                          'platform.current_membership_id()'::regprocedure,
                          'platform.current_purpose_of_use()'::regprocedure,
                          'platform.current_actor_subject()'::regprocedure,
                          'ehr.order_route_access_open()'::regprocedure,
                          'ehr.order_route_receive_permission(text)'::regprocedure)
    ) needed
   where not pg_temp.order_route_0090_holds(o, needed.owner_id, needed.acl, needed.object_type, needed.privilege);
  if mismatch is not null then
    raise exception '0090: H6''s owner %, which will own the new objects, lacks: %', pg_get_userbyid(o), mismatch;
  end if;
  -- Every role that runs a body reading T8 after 0090 may read it: the
  -- definers that call item access (the two resource checks) and the
  -- summary (C3 and C4), the release trigger, C28, C27 (which also
  -- updates it), and the recorded owners of C5, C21 and C26; and the owners
  -- of C5 and C21 may run o's owner-only helpers (they hold o).
  select string_agg(format('%s (%s) %s', needed.what, pg_get_userbyid(needed.role_id), needed.privilege), ', ')
    into mismatch
    from (
      select proc.oid::regprocedure::text as what, proc.proowner as role_id, 'SELECT' as privilege
        from pg_proc proc
       where proc.oid in ('lab.order_route_access_for(text,uuid,text)'::regprocedure,
                          'pharmacy.order_route_access_for(text,uuid,text)'::regprocedure,
                          'ehr.list_order_routes_for_order(text,uuid,uuid)'::regprocedure,
                          'ehr.order_route_summaries(text,uuid,uuid[])'::regprocedure)
      union all
      select recorded.signature, recorded.proowner, 'SELECT' from pg_temp.order_route_late_0090 recorded
       where recorded.signature::regprocedure in ('lab.return_order_route_result()'::regprocedure,
               'ehr.list_sent_wrong_patient_order_routes()'::regprocedure,
               'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)'::regprocedure,
               'ehr.patient_list_order_routes()'::regprocedure,
               'identity.admin_find_order_routes(text,text)'::regprocedure,
               'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure)
      union all
      select recorded.signature, recorded.proowner, 'UPDATE' from pg_temp.order_route_late_0090 recorded
       where recorded.signature::regprocedure
             = 'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)'::regprocedure
    ) needed
    cross join pg_class relation
   where relation.oid = 'ehr.order_route_wrong_patient_reports'::regclass
     and not pg_temp.order_route_0090_holds(needed.role_id, relation.relowner, relation.relacl, 'r',
       needed.privilege);
  if mismatch is not null then
    raise exception '0090: a role that reads the report table after this migration may not: %', mismatch;
  end if;
  select string_agg(format('%s (%s)', recorded.signature, pg_get_userbyid(recorded.proowner)), ', ') into mismatch
    from pg_temp.order_route_late_0090 recorded
   where (recorded.signature::regprocedure in ('ehr.patient_list_order_routes()'::regprocedure,
            'identity.admin_find_order_routes(text,text)'::regprocedure)
          and not pg_temp.order_route_0090_holds(recorded.proowner, o, '{}'::aclitem[], 'f', 'EXECUTE'))
      or (recorded.signature::regprocedure = 'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure
          and (not pg_temp.order_route_0090_holds(recorded.proowner,
                 (select proc.proowner from pg_proc proc
                   where proc.oid = 'identity.has_active_membership(text,uuid,uuid)'::regprocedure),
                 (select proc.proacl from pg_proc proc
                   where proc.oid = 'identity.has_active_membership(text,uuid,uuid)'::regprocedure), 'f', 'EXECUTE')
            or not pg_temp.order_route_0090_holds(recorded.proowner,
                 (select relation.relowner from pg_class relation where relation.oid = 'auth.accounts'::regclass),
                 (select relation.relacl from pg_class relation where relation.oid = 'auth.accounts'::regclass), 'r',
                 'SELECT')))
      or (recorded.signature::regprocedure in ('ehr.patient_list_order_routes()'::regprocedure,
            'identity.admin_find_order_routes(text,text)'::regprocedure,
            'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure)
          and not pg_temp.order_route_0090_holds(recorded.proowner,
            (select namespace.nspowner from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where proc.oid = recorded.signature::regprocedure),
            (select namespace.nspacl from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where proc.oid = recorded.signature::regprocedure), 'n', 'CREATE'));
  if mismatch is not null then
    raise exception '0090: C5, C21 or C26 has an owner that may not run o''s helpers, what it calls, or create the recreated function in its schema: %',
      mismatch;
  end if;
  -- The applying role inherits every owner it acts for (replacing, dropping,
  -- altering T8) and may become each one it gives an object to (ALTER OWNER
  -- needs SET on PostgreSQL 16).
  select string_agg(distinct pg_get_userbyid(needed.role_id), ', ') into mismatch
    from (select o as role_id, true as handed
          union all select recorded.proowner,
                   recorded.signature::regprocedure in ('ehr.patient_list_order_routes()'::regprocedure,
                     'identity.admin_find_order_routes(text,text)'::regprocedure,
                     'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure)
                 from pg_temp.order_route_late_0090 recorded
          union all select relation.relowner, false from pg_class relation
                     where relation.oid = 'ehr.order_route_wrong_patient_reports'::regclass) needed
   where not pg_has_role(current_user, needed.role_id, 'USAGE')
      or (needed.handed and needed.role_id <> (select role_row.oid from pg_roles role_row
                                                where role_row.rolname = current_user)
          and not pg_has_role(current_user, needed.role_id, 'SET'));
  if mismatch is not null then
    raise exception '0090: the applying role may not act as or become: %', mismatch;
  end if;
end
$$;
drop function pg_temp.order_route_0090_holds(oid,oid,aclitem[],"char",text);

-- 1. T8 first, under one ACCESS EXCLUSIVE lock on T8 alone, taken NOWAIT
-- (see Locks) and held to commit, so that every later body may name the new
-- columns.
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.order_route_wrong_patient_reports in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0090: ehr.order_route_wrong_patient_reports stayed busy for 5 seconds; run the release again';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;

-- late: true only from the late command (C29). ended_kind_before: the
-- route's ending when the late report came (null when its window had only
-- lapsed). discovered_by and discovered_on: how and on which day (Africa/
-- Lagos) B found out. A late report may come from a cancelled route (one
-- that ended another way with nothing back). Every existing row is not late,
-- with state_before accepted or completed, so both CHECKs validate, and item
-- 3's command (C25) writes valid rows by the defaults.
alter table ehr.order_route_wrong_patient_reports
  add column late boolean not null default false,
  add column ended_kind_before text,
  add column discovered_by text,
  add column discovered_on date,
  drop constraint order_route_wrong_patient_reports_state_before_check,
  add constraint order_route_wrong_patient_reports_state_before_check
    check (state_before in ('accepted', 'completed', 'cancelled')),
  add constraint order_route_wrong_patient_reports_late_ck check (
    (not late and ended_kind_before is null and discovered_by is null and discovered_on is null
      and state_before in ('accepted', 'completed'))
    or (late and coalesce(discovered_by in ('patient', 'ordering_facility', 'own_check', 'support', 'other'), false)
      and discovered_on is not null
      and (ended_kind_before is null or ended_kind_before in ('order_changed', 'entered_in_error',
        'receiving_released', 'ordering_released', 'support'))
      and (state_before <> 'cancelled' or ended_kind_before is not null))),
  -- D17-6: a late report where something had come back (state_before
  -- completed), or a "pretending" one (suspected_misuse), is reviewed only
  -- with referred_to_dpo; where something had come back and the ordering
  -- facility was not released, also with ordering_facility_told. Support's
  -- review (C27) checks the same first and answers a clear code; this is the
  -- backstop.
  add constraint order_route_wrong_patient_reports_late_review_ck check (
    not late or reviewed_at is null
    or ((not (state_before = 'completed' or reason_code = 'suspected_misuse')
          or 'referred_to_dpo' = any(review_actions))
      and (state_before <> 'completed' or ended_kind_before is not distinct from 'ordering_released'
          or 'ordering_facility_told' = any(review_actions))));
-- The member limit of C29 and support's count of a reporter's late reports.
-- (The facility limit uses order_route_wrong_patient_reports_receiving_idx.)
create index order_route_wrong_patient_reports_late_member_idx
  on ehr.order_route_wrong_patient_reports (reported_by_membership_id, reported_at) where late;

-- T8's guard (0088 section 3) with the four new columns fixed too. No
-- delete; every column is fixed, except that one update, together with
-- row_version + 1, sets the four review columns from null and may remove
-- the note once.
create or replace function ehr.guard_order_route_wrong_patient_report()
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
      new.request_sha256, new.correlation_id, new.reported_at, new.late, new.ended_kind_before,
      new.discovered_by, new.discovered_on)
     is distinct from
     (old.id, old.route_id, old.kind, old.receiving_facility_id, old.receiving_organization_id,
      old.ordering_facility_id, old.state_before, old.reason_code, old.reported_by_account_id,
      old.reported_by_membership_id, old.accepted_by_account_id, old.accepted_by_membership_id, old.accepted_at,
      old.accepted_with, old.recorded_by_membership_ids, old.reporter_recorded_work, old.specimens_collected,
      old.results_voided, old.result_reports_marked, old.dispensing_reversed, old.idempotency_key,
      old.request_sha256, old.correlation_id, old.reported_at, old.late, old.ended_kind_before,
      old.discovered_by, old.discovered_on)
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

-- 2. T9, the late correction's capability. C29 inserts one row, bound to its
-- own transaction (pg_current_xact_id(), the top-level transaction, also
-- inside an exception block; 64-bit, never reused), before its first read
-- of the patient's Lab or Pharmacy rows, and deletes it before it returns;
-- a refusal or error rolls the insert back. So the table is always empty at
-- commit. Row-level security enabled and forced; no grant to any role, so
-- only its owner o (H6 and C29 run as o) reads or writes it. No foreign key:
-- a key to the route would lock ehr.order_routes here and at each insert.
create table ehr.order_route_correction_capabilities (
  transaction_id xid8 primary key,
  route_id uuid not null,
  kind text not null check (kind in ('lab_request', 'prescription')),
  receiving_facility_id uuid not null,
  patient_id uuid not null,
  membership_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table ehr.order_route_correction_capabilities enable row level security;
alter table ehr.order_route_correction_capabilities force row level security;
create policy order_route_correction_capabilities_command_read on ehr.order_route_correction_capabilities
  for select using (true);
create policy order_route_correction_capabilities_command_insert on ehr.order_route_correction_capabilities
  for insert with check (true);
create policy order_route_correction_capabilities_command_delete on ehr.order_route_correction_capabilities
  for delete using (true);
revoke all on ehr.order_route_correction_capabilities from public;

-- 3. The two helpers (owner-only, granted to no role).

-- Until when B may correct an order late (D17-2): 180 days after it accepted
-- it. The one place this bound is set; the order summary (section 7)
-- inlines the same expression for speed, and the suite checks they agree.
create function ehr.order_route_correctable_until(route ehr.order_routes)
returns timestamptz
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  select route.accepted_at + interval '4320 hours'
$$;

-- What the late correction may do with a route, at the database clock:
--   not_accepted  never accepted;
--   reported      ended 'wrong_patient', or reported (in or after its window);
--   open          item 3's own window (0088 C25 step 9): accepted, or
--                 completed and not ended, before writes_end_at;
--   too_late      at or past ehr.order_route_correctable_until;
--   correctable   anything else accepted.
-- An open window always ends before the deadline (writes_end_at <=
-- accepted_at + 1080 hours), so "open or correctable" is exactly "accepted,
-- not reported, before the deadline". PL/pgSQL, so its plans are cached.
create function ehr.order_route_correction_state(route ehr.order_routes)
returns text
language plpgsql stable
set search_path = pg_catalog, ehr, pg_temp
as $$
declare
  checked_at timestamptz := clock_timestamp();
begin
  return case
    when route.accepted_at is null then 'not_accepted'
    when route.ended_kind = 'wrong_patient'
      or exists (select 1 from ehr.order_route_wrong_patient_reports report where report.route_id = route.id)
      then 'reported'
    when (route.state = 'accepted' and checked_at < route.writes_end_at)
      or (route.state = 'completed' and route.ended_at is null and checked_at < route.writes_end_at) then 'open'
    when checked_at >= ehr.order_route_correctable_until(route) then 'too_late'
    else 'correctable' end;
end;
$$;

-- 4. H6 (0086:6878-6907), replaced: 0086's body word for word, plus the
-- capability branch inside its "no route allows it" test, as two separate
-- statements (one condition joined with "or" costs more even when its first
-- part is true). Read-only transactions have no transaction id, so they pay
-- one function call; a request that has written something pays one lookup
-- of T9's primary key. The control and the receive permission are still
-- tested after it, so the capability never bypasses either. Same language,
-- volatility, security and search path as 0086.
create or replace function ehr.order_route_access_allows(requested_kind text, row_patient_id uuid, row_facility_id uuid,
  requested_action text)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, ehr, auth, platform, pg_temp
as $$
declare
  correcting xid8;
begin
  if platform.current_purpose_of_use() is distinct from 'direct-care'
     or not coalesce(requested_action in ('read_records', 'write_records'), false)
     or row_patient_id is null or row_facility_id is null then
    return false;
  end if;
  if not exists (
    select 1 from ehr.order_routes route
     where route.receiving_facility_id = row_facility_id
       and route.patient_id = row_patient_id
       and route.kind = requested_kind
       and route.state in ('accepted', 'completed', 'cancelled')
       and ((requested_action = 'write_records' and route.state in ('accepted', 'completed')
             and clock_timestamp() < route.writes_end_at)
         or (requested_action = 'read_records' and clock_timestamp() < route.access_ends_at))) then
    -- D17: the late correction's capability (T9), only inside the command
    -- that wrote it (C29), only for its patient's rows of its kind at its
    -- facility, and only for the member who acts.
    correcting := pg_current_xact_id_if_assigned();
    if correcting is null then
      return false;
    end if;
    if not exists (
      select 1 from ehr.order_route_correction_capabilities capability
       where capability.transaction_id = correcting
         and capability.receiving_facility_id = row_facility_id
         and capability.patient_id = row_patient_id
         and capability.kind = requested_kind
         and capability.membership_id = platform.current_membership_id()) then
      return false;
    end if;
  end if;
  if not ehr.order_route_access_open() then
    return false;
  end if;
  return auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
    row_facility_id, ehr.order_route_receive_permission(requested_kind));
end;
$$;

-- 5. Item access (0088 section 1), replaced: a write on a route with a
-- wrong-patient report is closed whatever its ending, as on a route ended
-- 'wrong_patient', even for a member who holds the patient's own consent
-- (reads still answer none: consent decides). Otherwise 0088's body and
-- attributes.
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
       or route.ended_kind = 'wrong_patient'
       or exists (select 1 from ehr.order_route_wrong_patient_reports report where report.route_id = route.id)) then
    return 'closed';
  end if;
  return 'none';
end;
$$;

-- Results back to the ordering facility (0088 section 1), replaced: a
-- release is also refused (23514 ORDER_ROUTE_CLOSED) on a route with a
-- wrong-patient report, whatever its ending: a release under the patient's
-- consent at B on a route reported as fulfilled for someone else must not
-- cross, also when the report came after the order had ended another way or
-- its window had lapsed. Otherwise 0088's body and attributes.
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
     or route_row.ended_kind = 'wrong_patient'
     or exists (select 1 from ehr.order_route_wrong_patient_reports report where report.route_id = route_row.id) then
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

-- 6. The late command and B's lookup.

-- C29. The receiving facility (B) withdraws, after the order has ended or
-- its window has lapsed, what it recorded on an order it accepted for
-- someone who was not the order's patient (D17-1: one member who may
-- receive the kind, and withdraw what must be withdrawn). Owner-only; the
-- Lab and Pharmacy wrappers below call it with their kind. In this order, in
-- the service's READ COMMITTED transaction; any refusal raises, so nothing
-- is stored (the capability included):
--   1. the actor: a direct-care staff session holding the kind's receive
--      permission at the session facility (42501);
--   2. the input (22023 ORDER_ROUTE_INVALID): the reason one of item 3's
--      four, how B found out one of five, the day it found out not after
--      today in Africa/Lagos, the note 8 to 500 characters once trimmed, the
--      key and digest patterns;
--   3. the route-access control (55000);
--   4. a replay by the reporter's key at this facility: the same route,
--      kind and digest of a late report answer replayed with the route as it
--      is now and the first report's counts; anything else with that key,
--      an in-window report's included, IDEMPOTENCY_KEY_REUSED;
--   5. the route, unlocked: addressed here and of this kind (P0002); its
--      correction state (not_accepted, reported, open and too_late refuse:
--      ORDER_ROUTE_NOT_ACCEPTED, ORDER_ROUTE_ALREADY_REPORTED,
--      ORDER_ROUTE_STILL_OPEN, ORDER_ROUTE_CORRECTION_TOO_LATE); then the
--      day B found out not before the Lagos day of the acceptance (22023);
--   6. the limits, exact (D17-9): a transaction advisory lock per receiving
--      facility, held to commit; under it the replay and the state again (so
--      a concurrent retry answers replayed, and a concurrent report of the
--      route ALREADY_REPORTED, never the limit), then at most 5 late reports
--      by this membership and 20 at this facility in the last 24 hours, else
--      P0001 ORDER_ROUTE_CORRECTION_LIMIT whose DETAIL is the ISO time (UTC,
--      milliseconds, rounded up) from which another is possible;
--   7. the capability: one T9 row for this transaction, the route's
--      facility, patient and kind, and the reporter's membership; from here
--      H6 lets this transaction's statements, as this member, reach the
--      patient's rows of this kind at B (only C29's fixed statements below
--      run while it exists);
--   8. (Lab) every result of the work item FOR UPDATE, in id order (a
--      release's own order: results, then the route);
--   9. the route: the application lock FOR SHARE, then FOR UPDATE;
--  10. the replay again, under the lock (the capability is deleted first);
--  11. the state first, then the version (P0001 ORDER_ROUTE_VERSION_CONFLICT):
--      a concurrent end or report answers by its state, and only a
--      concurrent write that keeps it correctable 412;
--  12-15. item 3's withdrawal (0088 C25 steps 10-13) statement for
--      statement, apart from the two reasons: the permission to withdraw
--      what must be withdrawn (P0001
--      ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED, DETAIL the permission),
--      the facts for support, the Lab voids (each current version
--      invalidated with its outbox row; every released version A holds
--      reported entered in error there, with one event and one row at A for
--      those reported directly) or the Pharmacy reversal;
--  16. a route not yet ended (its window lapsed) ends now through 0086's
--      closer, 'wrong_patient' (accepted -> cancelled, completed -> access
--      ended); a route already ended keeps its ending;
--  17. the report row (T8): late, the earlier ending, how and when B found
--      out; its unique keys answer IDEMPOTENCY_KEY_REUSED and
--      ORDER_ROUTE_ALREADY_REPORTED, never 23505;
--  18. a system row at A and at B, with the patient (never the note);
--  19. the patient's inbox notice: ORDER_ROUTE_WRONG_PATIENT when the route
--      has now ended, ORDER_ROUTE_WRONG_PATIENT_CORRECTED when it had
--      ended before;
--  20. the capability is deleted: exactly one row, else XX000
--      ORDER_ROUTE_CORRECTION_CAPABILITY_LOST;
--  21. the answer, with the patient for B's own audit row (never returned
--      over HTTP).
create function ehr.correct_wrong_patient_order_route(
  requested_kind text,
  requested_route_id uuid,
  expected_version bigint,
  requested_reason text,
  requested_discovered_by text,
  requested_discovered_on date,
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
  ended_kind_before text,
  results_voided integer,
  result_reports_marked integer,
  dispensing_reversed boolean,
  state_before text,
  correctable_until timestamptz,
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
  final_route ehr.order_routes%rowtype;
  marked_route ehr.order_routes%rowtype;
  closed record;
  accepted_attempt record;
  correction text;
  checked_at timestamptz;
  member_count integer;
  facility_count integer;
  member_free timestamptz;
  facility_free timestamptz;
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
  violated_constraint text;
  removed integer;
begin
  -- 1. The actor.
  select * into actor from ehr.order_route_receiver(requested_kind);
  -- 2. The input.
  if requested_route_id is null or expected_version is null or expected_version < 1
     or not coalesce(requested_reason in ('wrong_order_chosen', 'someone_elses_details', 'suspected_misuse', 'other'),
       false)
     or not coalesce(requested_discovered_by in ('patient', 'ordering_facility', 'own_check', 'support', 'other'),
       false)
     or requested_discovered_on is null
     or requested_discovered_on > (clock_timestamp() at time zone 'Africa/Lagos')::date
     or not coalesce(char_length(note_text) between 8 and 500, false)
     or not coalesce(requested_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$', false)
     or not coalesce(requested_request_sha256 ~ '^[0-9a-f]{64}$', false) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  -- 3. The control.
  perform platform.require_control_enabled('cross_facility_route_access_enabled');
  -- 4. A replay.
  select report.id, report.route_id, report.kind, report.request_sha256, report.late, report.results_voided,
         report.result_reports_marked, report.dispensing_reversed, report.state_before, report.ended_kind_before
    into prior
    from ehr.order_route_wrong_patient_reports report
   where report.reported_by_account_id = actor.actor_account_id
     and report.receiving_facility_id = actor.actor_facility_id
     and report.idempotency_key = requested_idempotency_key;
  if prior.id is not null then
    if prior.route_id <> requested_route_id or prior.kind <> requested_kind or not prior.late
       or prior.request_sha256 is distinct from requested_request_sha256 then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    select route.* into final_route from ehr.order_routes route where route.id = prior.route_id;
    return query select 'replayed'::text, prior.id, final_route.row_version, final_route.state,
      ehr.order_route_effective_state(final_route), final_route.ended_kind, prior.ended_kind_before,
      prior.results_voided, prior.result_reports_marked, prior.dispensing_reversed, prior.state_before,
      ehr.order_route_correctable_until(final_route), final_route.patient_id;
    return;
  end if;
  -- 5. The route, unlocked (its work item is set once, at acceptance), and
  -- what may be done with it now (checked again under the locks).
  select route.* into peeked from ehr.order_routes route
   where route.id = requested_route_id and route.kind = requested_kind
     and route.receiving_facility_id = actor.actor_facility_id;
  if peeked.id is null then
    raise exception using errcode = 'P0002', message = 'ORDER_ROUTE_NOT_FOUND';
  end if;
  correction := ehr.order_route_correction_state(peeked);
  if correction <> 'correctable' then
    raise exception using errcode = 'P0001', message = case correction
      when 'not_accepted' then 'ORDER_ROUTE_NOT_ACCEPTED' when 'reported' then 'ORDER_ROUTE_ALREADY_REPORTED'
      when 'open' then 'ORDER_ROUTE_STILL_OPEN' else 'ORDER_ROUTE_CORRECTION_TOO_LATE' end;
  end if;
  if requested_discovered_on < (peeked.accepted_at at time zone 'Africa/Lagos')::date then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  -- 6. The limits, exact: one late correction at a time per receiving
  -- facility, from here to commit. Only this command takes this lock, and
  -- before any row lock, so it adds no deadlock.
  perform pg_advisory_xact_lock(hashtextextended('order-route-late-correction:' || actor.actor_facility_id::text, 0));
  select report.id, report.route_id, report.kind, report.request_sha256, report.late, report.results_voided,
         report.result_reports_marked, report.dispensing_reversed, report.state_before, report.ended_kind_before
    into prior
    from ehr.order_route_wrong_patient_reports report
   where report.reported_by_account_id = actor.actor_account_id
     and report.receiving_facility_id = actor.actor_facility_id
     and report.idempotency_key = requested_idempotency_key;
  if prior.id is not null then
    if prior.route_id <> requested_route_id or prior.kind <> requested_kind or not prior.late
       or prior.request_sha256 is distinct from requested_request_sha256 then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    select route.* into final_route from ehr.order_routes route where route.id = prior.route_id;
    return query select 'replayed'::text, prior.id, final_route.row_version, final_route.state,
      ehr.order_route_effective_state(final_route), final_route.ended_kind, prior.ended_kind_before,
      prior.results_voided, prior.result_reports_marked, prior.dispensing_reversed, prior.state_before,
      ehr.order_route_correctable_until(final_route), final_route.patient_id;
    return;
  end if;
  select route.* into peeked from ehr.order_routes route where route.id = peeked.id;
  correction := ehr.order_route_correction_state(peeked);
  if correction <> 'correctable' then
    raise exception using errcode = 'P0001', message = case correction
      when 'not_accepted' then 'ORDER_ROUTE_NOT_ACCEPTED' when 'reported' then 'ORDER_ROUTE_ALREADY_REPORTED'
      when 'open' then 'ORDER_ROUTE_STILL_OPEN' else 'ORDER_ROUTE_CORRECTION_TOO_LATE' end;
  end if;
  checked_at := clock_timestamp();
  select count(*)::integer into member_count from ehr.order_route_wrong_patient_reports report
   where report.late and report.reported_by_membership_id = actor.actor_membership_id
     and report.reported_at > checked_at - interval '24 hours';
  select count(*)::integer into facility_count from ehr.order_route_wrong_patient_reports report
   where report.late and report.receiving_facility_id = actor.actor_facility_id
     and report.reported_at > checked_at - interval '24 hours';
  if member_count >= 5 then
    -- Another is possible once all but four of the counted reports are more
    -- than 24 hours old.
    select report.reported_at + interval '24 hours' into member_free from ehr.order_route_wrong_patient_reports report
     where report.late and report.reported_by_membership_id = actor.actor_membership_id
       and report.reported_at > checked_at - interval '24 hours'
     order by report.reported_at, report.id
     offset member_count - 5 limit 1;
  end if;
  if facility_count >= 20 then
    select report.reported_at + interval '24 hours' into facility_free from ehr.order_route_wrong_patient_reports report
     where report.late and report.receiving_facility_id = actor.actor_facility_id
       and report.reported_at > checked_at - interval '24 hours'
     order by report.reported_at, report.id
     offset facility_count - 20 limit 1;
  end if;
  if member_free is not null or facility_free is not null then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_CORRECTION_LIMIT',
      detail = to_char(date_trunc('milliseconds', greatest(member_free, facility_free) + interval '999 microseconds')
                         at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  end if;
  -- 7. The capability, for this transaction only, deleted in step 10 or 20.
  insert into ehr.order_route_correction_capabilities (transaction_id, route_id, kind, receiving_facility_id,
    patient_id, membership_id)
  values (pg_current_xact_id(), peeked.id, peeked.kind, peeked.receiving_facility_id, peeked.patient_id,
    actor.actor_membership_id);
  work_item := coalesce(peeked.lab_work_item_id, peeked.pharmacy_work_item_id);
  -- 8. The results, locked in id order (Lab only).
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
  -- 9. The route, locked.
  current_route := ehr.lock_receiving_route(requested_kind, requested_route_id, actor.actor_facility_id,
    actor.actor_organization_id);
  -- 10. The replay again, under the lock.
  select report.id, report.route_id, report.kind, report.request_sha256, report.late, report.results_voided,
         report.result_reports_marked, report.dispensing_reversed, report.state_before, report.ended_kind_before
    into prior
    from ehr.order_route_wrong_patient_reports report
   where report.reported_by_account_id = actor.actor_account_id
     and report.receiving_facility_id = actor.actor_facility_id
     and report.idempotency_key = requested_idempotency_key;
  if prior.id is not null then
    if prior.route_id <> requested_route_id or prior.kind <> requested_kind or not prior.late
       or prior.request_sha256 is distinct from requested_request_sha256 then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    delete from ehr.order_route_correction_capabilities capability
     where capability.transaction_id = pg_current_xact_id();
    get diagnostics removed = row_count;
    if removed <> 1 then
      raise exception using errcode = 'XX000', message = 'ORDER_ROUTE_CORRECTION_CAPABILITY_LOST';
    end if;
    return query select 'replayed'::text, prior.id, current_route.row_version, current_route.state,
      ehr.order_route_effective_state(current_route), current_route.ended_kind, prior.ended_kind_before,
      prior.results_voided, prior.result_reports_marked, prior.dispensing_reversed, prior.state_before,
      ehr.order_route_correctable_until(current_route), current_route.patient_id;
    return;
  end if;
  -- 11. The state first, then the version.
  correction := ehr.order_route_correction_state(current_route);
  if correction <> 'correctable' then
    raise exception using errcode = 'P0001', message = case correction
      when 'not_accepted' then 'ORDER_ROUTE_NOT_ACCEPTED' when 'reported' then 'ORDER_ROUTE_ALREADY_REPORTED'
      when 'open' then 'ORDER_ROUTE_STILL_OPEN' else 'ORDER_ROUTE_CORRECTION_TOO_LATE' end;
  end if;
  if current_route.row_version <> expected_version then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_VERSION_CONFLICT';
  end if;
  work_item := coalesce(current_route.lab_work_item_id, current_route.pharmacy_work_item_id);
  -- The work item's results as they are now, under the route lock: one
  -- entered between steps 8 and 9 is withdrawn too, though not locked.
  if requested_kind = 'lab_request' then
    select coalesce(array_agg(result_row.id order by result_row.id), array[]::uuid[]) into item_results
      from lab.results result_row
      join lab.test_executions execution on execution.id = result_row.execution_id
      join lab.work_item_requested_tests test on test.id = execution.requested_test_id
     where test.work_item_id = work_item;
  end if;
  -- 12. The permission to withdraw what must be withdrawn.
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
  -- 13. The facts for support.
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
  -- 14. The Lab voids.
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
        'Accepted for someone who is not this order''s patient: not this patient''s result (reported after the order ended)',
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
  -- 15. The Pharmacy void.
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
        'Dispensed to someone who is not this prescription''s patient (wrong-patient report after the order ended)',
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
  -- 16. A route not yet ended (its window lapsed) ends now (H14 re-reads the
  -- locked route, with the steps' versions); one already ended keeps its
  -- ending (D17-10).
  if current_route.ended_at is null then
    select * into closed from ehr.close_order_route(current_route.id, 'wrong_patient', 'receiving', true);
    if closed.outcome is distinct from (case current_route.state when 'accepted' then 'cancelled'
                                                                 else 'access_ended' end) then
      raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ALREADY_REPORTED';
    end if;
    final_route := closed.closed;
  else
    select route.* into final_route from ehr.order_routes route where route.id = current_route.id;
  end if;
  -- 17. The report row, late.
  select attempt.identifier_kind, attempt.identifies_route into accepted_attempt
    from ehr.order_route_accept_attempts attempt
   where attempt.route_id = current_route.id and attempt.outcome = 'match'
   order by attempt.attempted_at desc, attempt.id desc
   limit 1;
  begin
    insert into ehr.order_route_wrong_patient_reports as report (id, route_id, kind, receiving_facility_id,
      receiving_organization_id, ordering_facility_id, state_before, reason_code, note, reported_by_account_id,
      reported_by_membership_id, accepted_by_account_id, accepted_by_membership_id, accepted_at, accepted_with,
      recorded_by_membership_ids, reporter_recorded_work, specimens_collected, results_voided, result_reports_marked,
      dispensing_reversed, idempotency_key, request_sha256, correlation_id, late, ended_kind_before, discovered_by,
      discovered_on)
    values (gen_random_uuid(), current_route.id, current_route.kind, current_route.receiving_facility_id,
      current_route.receiving_organization_id, current_route.ordering_facility_id, current_route.state,
      requested_reason, note_text, actor.actor_account_id, actor.actor_membership_id,
      current_route.accepted_by_account_id, current_route.accepted_by_membership_id, current_route.accepted_at,
      case when accepted_attempt.identifier_kind = 'health_id' then 'health_id'
           when accepted_attempt.identifies_route then 'date_of_birth_with_reference'
           else 'date_of_birth' end,
      recorded, actor.actor_membership_id = any(recorded), specimen_count, voided, reports_after - reports_before,
      reversed, requested_idempotency_key, requested_request_sha256, platform.current_correlation_id(),
      true, current_route.ended_kind, requested_discovered_by, requested_discovered_on)
    returning report.id into inserted_report;
  exception when unique_violation then
    get stacked diagnostics violated_constraint = constraint_name;
    if violated_constraint = 'order_route_wrong_patient_reports_idempotency_uq' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if violated_constraint = 'order_route_wrong_patient_reports_route_id_key' then
      raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ALREADY_REPORTED';
    end if;
    raise;
  end;
  -- 18. The system rows at A and at B, with the patient.
  perform ehr.order_route_system_audit(final_route, 'ordering', 'ehr.order-route.wrong-patient', true,
    jsonb_build_object('reason', requested_reason, 'stateBefore', current_route.state, 'resultsVoided', voided,
      'dispensingReversed', reversed, 'late', true, 'endedKindBefore', current_route.ended_kind,
      'discoveredBy', requested_discovered_by, 'discoveredOn', requested_discovered_on));
  perform ehr.order_route_system_audit(final_route, 'receiving', 'ehr.order-route.wrong-patient', true,
    jsonb_build_object('reason', requested_reason, 'stateBefore', current_route.state, 'resultsVoided', voided,
      'dispensingReversed', reversed, 'late', true, 'endedKindBefore', current_route.ended_kind,
      'discoveredBy', requested_discovered_by, 'discoveredOn', requested_discovered_on));
  -- 19. The patient's notice.
  perform ehr.order_route_notify_patient(final_route, case when current_route.ended_at is null
    then 'ORDER_ROUTE_WRONG_PATIENT' else 'ORDER_ROUTE_WRONG_PATIENT_CORRECTED' end);
  -- 20. The capability ends before the command returns.
  delete from ehr.order_route_correction_capabilities capability
   where capability.transaction_id = pg_current_xact_id();
  get diagnostics removed = row_count;
  if removed <> 1 then
    raise exception using errcode = 'XX000', message = 'ORDER_ROUTE_CORRECTION_CAPABILITY_LOST';
  end if;
  -- 21. The answer.
  return query select 'corrected'::text, inserted_report, final_route.row_version, final_route.state,
    ehr.order_route_effective_state(final_route), final_route.ended_kind, current_route.ended_kind, voided,
    reports_after - reports_before, reversed, current_route.state, ehr.order_route_correctable_until(final_route),
    current_route.patient_id;
end;
$$;

create function lab.correct_wrong_patient_order_route(requested_route_id uuid, expected_version bigint,
  requested_reason text, requested_discovered_by text, requested_discovered_on date, requested_note text,
  requested_idempotency_key text, requested_request_sha256 char(64))
returns table (
  result text, report_id uuid, route_row_version bigint, route_state text, effective_state text, ended_kind text,
  ended_kind_before text, results_voided integer, result_reports_marked integer, dispensing_reversed boolean,
  state_before text, correctable_until timestamptz, patient_id uuid
)
language sql volatile security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select corrected.result, corrected.report_id, corrected.route_row_version, corrected.route_state,
    corrected.effective_state, corrected.ended_kind, corrected.ended_kind_before, corrected.results_voided,
    corrected.result_reports_marked, corrected.dispensing_reversed, corrected.state_before,
    corrected.correctable_until, corrected.patient_id
    from ehr.correct_wrong_patient_order_route('lab_request', requested_route_id, expected_version, requested_reason,
      requested_discovered_by, requested_discovered_on, requested_note, requested_idempotency_key,
      requested_request_sha256) corrected
$$;

create function pharmacy.correct_wrong_patient_order_route(requested_route_id uuid, expected_version bigint,
  requested_reason text, requested_discovered_by text, requested_discovered_on date, requested_note text,
  requested_idempotency_key text, requested_request_sha256 char(64))
returns table (
  result text, report_id uuid, route_row_version bigint, route_state text, effective_state text, ended_kind text,
  ended_kind_before text, results_voided integer, result_reports_marked integer, dispensing_reversed boolean,
  state_before text, correctable_until timestamptz, patient_id uuid
)
language sql volatile security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select corrected.result, corrected.report_id, corrected.route_row_version, corrected.route_state,
    corrected.effective_state, corrected.ended_kind, corrected.ended_kind_before, corrected.results_voided,
    corrected.result_reports_marked, corrected.dispensing_reversed, corrected.state_before,
    corrected.correctable_until, corrected.patient_id
    from ehr.correct_wrong_patient_order_route('prescription', requested_route_id, expected_version, requested_reason,
      requested_discovered_by, requested_discovered_on, requested_note, requested_idempotency_key,
      requested_request_sha256) corrected
$$;

-- C30. B finds an order it accepted by its exact reference (D17-8), at
-- most 5 (a reference is 8 hex characters of the id), newest acceptance
-- first, addressed to the session's facility, of the kind, accepted. Bound
-- to the receiver as C29 is (42501); a reference that is not 8 hex
-- characters once trimmed and upper-cased answers 22023
-- ORDER_ROUTE_INVALID; the route-access control (55000). The reference is
-- compared as char(8), so the lookup uses order_routes_reference_idx. Each
-- row: the route's metadata, B's own report if any, and its correction
-- state (the helper, once per route: OFFSET 0 keeps the lateral subquery
-- from being pulled up into each reference to it) with the deadline; only
-- while that state is open or correctable,
-- also B's own facts about it: the test or medicine, who at B accepted it
-- and how identity was checked (its T3 match), and what went back to the
-- ordering facility and when (at most 20, oldest first, with whether each
-- was withdrawn). No patient, no orderer, no work item, no value. Writes
-- nothing (the services audit each lookup with the route ids).
create function ehr.find_correctable_order_routes(requested_kind text, requested_reference text)
returns table (
  route_id uuid,
  reference text,
  kind text,
  row_version bigint,
  effective_state text,
  ordering_facility_name text,
  accepted_at timestamptz,
  completed_at timestamptz,
  ended_at timestamptz,
  ended_kind text,
  returned boolean,
  correction_state text,
  correctable_until timestamptz,
  reported_at timestamptz,
  report_late boolean,
  what_name text,
  accepted_by_name text,
  accepted_with text,
  returned_items jsonb
)
language plpgsql stable
set search_path = pg_catalog, ehr, identity, auth, lab, pharmacy, platform, pg_temp
as $$
declare
  actor record;
  wanted text := upper(btrim(requested_reference));
begin
  select * into actor from ehr.order_route_receiver(requested_kind);
  if not coalesce(wanted ~ '^[0-9A-F]{8}$', false) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  perform platform.require_control_enabled('cross_facility_route_access_enabled');
  return query
    select route.id, route.reference::text, route.kind, route.row_version, ehr.order_route_effective_state(route),
      (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
      route.accepted_at, route.completed_at, route.ended_at, route.ended_kind, route.completed_at is not null,
      state_row.correction, ehr.order_route_correctable_until(route), report.reported_at, report.late,
      case when state_row.correction in ('open', 'correctable') then
        case route.kind when 'lab_request' then route.test_display else route.medication_display end end,
      case when state_row.correction in ('open', 'correctable') then
        (select coalesce(account.display_name, staff.full_name)
           from identity.staff_facility_memberships membership
           join auth.accounts account on account.id = membership.account_id
           left join identity.staff staff on staff.id = membership.staff_id
          where membership.id = route.accepted_by_membership_id) end,
      case when state_row.correction in ('open', 'correctable') then
        (select case when attempt.identifier_kind = 'health_id' then 'health_id'
                     when attempt.identifies_route then 'date_of_birth_with_reference'
                     else 'date_of_birth' end
           from ehr.order_route_accept_attempts attempt
          where attempt.route_id = route.id and attempt.outcome = 'match'
          order by attempt.attempted_at desc, attempt.id desc
          limit 1) end,
      case when state_row.correction not in ('open', 'correctable') then null
           when route.kind = 'lab_request' then
             (select coalesce(jsonb_agg(jsonb_build_object('at', released.occurred_at,
                        'withdrawn', exists (select 1 from lab.order_route_result_reports marked
                                              where marked.result_id = released.result_id
                                                and marked.result_version = released.result_version
                                                and marked.kind = 'entered_in_error'))
                        order by released.recorded_at, released.id), '[]'::jsonb)
                from (select candidate.* from lab.order_route_result_reports candidate
                       where candidate.route_id = route.id and candidate.kind = 'released'
                       order by candidate.recorded_at, candidate.id limit 20) released)
           else
             (select coalesce(jsonb_agg(jsonb_build_object('at', dispensed.occurred_at,
                        'withdrawn', exists (select 1 from pharmacy.order_route_dispensing_reports reversed
                                              where reversed.dispensing_id = dispensed.dispensing_id
                                                and reversed.kind = 'reversed'))
                        order by dispensed.recorded_at, dispensed.id), '[]'::jsonb)
                from (select candidate.* from pharmacy.order_route_dispensing_reports candidate
                       where candidate.route_id = route.id and candidate.kind = 'dispensed'
                       order by candidate.recorded_at, candidate.id limit 20) dispensed)
      end
      from ehr.order_routes route
      cross join lateral (select ehr.order_route_correction_state(route) as correction offset 0) state_row
      left join ehr.order_route_wrong_patient_reports report on report.route_id = route.id
     where route.reference = wanted::char(8)
       and route.receiving_facility_id = actor.actor_facility_id
       and route.kind = requested_kind
       and route.accepted_at is not null
     order by route.accepted_at desc, route.id
     limit 5;
end;
$$;

create function lab.find_correctable_order_routes(requested_reference text)
returns table (
  route_id uuid, reference text, kind text, row_version bigint, effective_state text, ordering_facility_name text,
  accepted_at timestamptz, completed_at timestamptz, ended_at timestamptz, ended_kind text, returned boolean,
  correction_state text, correctable_until timestamptz, reported_at timestamptz, report_late boolean,
  what_name text, accepted_by_name text, accepted_with text, returned_items jsonb
)
language sql stable security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select found.route_id, found.reference, found.kind, found.row_version, found.effective_state,
    found.ordering_facility_name, found.accepted_at, found.completed_at, found.ended_at, found.ended_kind,
    found.returned, found.correction_state, found.correctable_until, found.reported_at, found.report_late,
    found.what_name, found.accepted_by_name, found.accepted_with, found.returned_items
    from ehr.find_correctable_order_routes('lab_request', requested_reference) found
$$;

create function pharmacy.find_correctable_order_routes(requested_reference text)
returns table (
  route_id uuid, reference text, kind text, row_version bigint, effective_state text, ordering_facility_name text,
  accepted_at timestamptz, completed_at timestamptz, ended_at timestamptz, ended_kind text, returned boolean,
  correction_state text, correctable_until timestamptz, reported_at timestamptz, report_late boolean,
  what_name text, accepted_by_name text, accepted_with text, returned_items jsonb
)
language sql stable security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select found.route_id, found.reference, found.kind, found.row_version, found.effective_state,
    found.ordering_facility_name, found.accepted_at, found.completed_at, found.ended_at, found.ended_kind,
    found.returned, found.correction_state, found.correctable_until, found.reported_at, found.report_late,
    found.what_name, found.accepted_by_name, found.accepted_with, found.returned_items
    from ehr.find_correctable_order_routes('prescription', requested_reference) found
$$;

-- 7. The readers.

-- The ordering facility's summary of one route (0086:7179-7193), replaced
-- with two keys: wrongPatient, B's report ({reportedAt, late}) or null; and
-- correctableUntil, the deadline while B may still correct the route (open
-- or correctable: accepted, not reported, before the deadline), else null.
-- Both are computed inline from one read of T8, without calling the helpers:
-- a LANGUAGE sql function with SET is never inlined and is planned on each
-- call, which would cost every order list several times the summary itself.
-- The deadline is ehr.order_route_correctable_until's expression; the suite
-- checks they agree on every route. 0086's keys and attributes otherwise.
create or replace function ehr.order_route_summary(route ehr.order_routes, resend_allowed boolean)
returns jsonb
language sql stable
set search_path = pg_catalog, ehr, identity, pg_temp
as $$
  select jsonb_build_object('id', route.id, 'reference', route.reference, 'kind', route.kind,
    'version', route.row_version, 'effectiveState', ehr.order_route_effective_state(route),
    'receivingFacility', jsonb_build_object('id', route.receiving_facility_id,
      'name', (select facility.name from identity.facilities facility where facility.id = route.receiving_facility_id),
      'available', identity.order_route_destination_eligible(route.receiving_facility_id, route.kind)),
    'createdAt', route.created_at, 'respondBy', route.respond_by, 'acceptedAt', route.accepted_at,
    'completedAt', route.completed_at, 'endedAt', route.ended_at, 'endedKind', route.ended_kind,
    'declineReason', route.decline_reason, 'acceptLocked', route.accept_locked_at is not null,
    'resendAllowed', resend_allowed,
    'wrongPatient', report.answer,
    'correctableUntil', case when route.accepted_at is not null and route.ended_kind is distinct from 'wrong_patient'
                               and report.answer is null
                               and clock_timestamp() < route.accepted_at + interval '4320 hours'
                             then route.accepted_at + interval '4320 hours' end)
    from (select (select jsonb_build_object('reportedAt', wrong_patient.reported_at, 'late', wrong_patient.late)
                    from ehr.order_route_wrong_patient_reports wrong_patient
                   where wrong_patient.route_id = route.id) as answer) report
$$;

-- C28. The ordering facility's Overview card (0088 section 4), replaced:
-- keyed on the report instead of the ending, so that a late report on an
-- order that had ended another way, or whose window had lapsed, is listed
-- too: the orders sent from the session's facility reported in the last 30
-- days, newest report first. Items gain reportedAt, late and
-- endedKindBefore. For an in-window report reported_at and ended_at are
-- taken in the same transaction, so those items answer as before. 0088's
-- privacy rules and attributes otherwise.
create or replace function ehr.list_sent_wrong_patient_order_routes()
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
  with reported as (
    select route.id, route.reference::text as reference, route.kind, route.patient_id, route.ended_at,
      route.receiving_facility_id, route.source_encounter_id,
      coalesce(route.source_lab_request_id, route.source_prescription_id) as order_id,
      report.result_reports_marked, report.dispensing_reversed, report.reported_at, report.late,
      report.ended_kind_before,
      (route.sent_by_account_id = actor.actor_account_id) as full_row
      from ehr.order_route_wrong_patient_reports report
      join ehr.order_routes route on route.id = report.route_id
     where report.ordering_facility_id = actor.actor_facility_id
       and report.reported_at > clock_timestamp() - interval '720 hours'
       and route.ordering_facility_id = actor.actor_facility_id
  )
  select jsonb_build_object('windowDays', 30,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('routeId', own.id, 'reference', own.reference, 'kind', own.kind,
          'receivingFacility', jsonb_build_object('id', own.receiving_facility_id,
            'name', (select facility.name from identity.facilities facility where facility.id = own.receiving_facility_id)),
          'patient', jsonb_build_object('name', (select patient.full_name from identity.patients patient
                                                  where patient.id = own.patient_id)),
          'endedAt', own.ended_at,
          'reportedAt', own.reported_at,
          'late', own.late,
          'endedKindBefore', own.ended_kind_before,
          'resultsWithdrawn', own.result_reports_marked,
          'dispensingReversed', own.dispensing_reversed,
          'link', jsonb_build_object('patientId', own.patient_id, 'encounterId', own.source_encounter_id,
            'kind', own.kind, 'orderId', own.order_id))
          order by own.reported_at desc, own.id)
        from (select * from reported where reported.full_row order by reported.reported_at desc, reported.id limit 50) own),
      '[]'::jsonb),
    'others', jsonb_build_object(
      'count', (select count(*) from reported where not reported.full_row),
      'references', coalesce((
        select jsonb_agg(other.reference order by other.reported_at desc, other.id)
          from (select reported.reference, reported.reported_at, reported.id from reported where not reported.full_row
                 order by reported.reported_at desc, reported.id limit 100) other), '[]'::jsonb)))
    into answer;
  return answer;
end;
$$;

-- C5. The patient's orders sent to other facilities (0086:7846-7930), with
-- three trailing columns: when B reported that it accepted the order for
-- someone else and whether that report came after the order had ended
-- (null when there is none), and the deadline while B may still correct
-- it (open or correctable), else null. The OUT columns change, so it is
-- dropped and created with 0086's body (its redaction of an order marked
-- entered in error unchanged) and attributes, given back to its recorded
-- owner and checked in section 8, and granted again in section 9.
drop function ehr.patient_list_order_routes();

create function ehr.patient_list_order_routes()
returns table (
  route_id uuid,
  reference text,
  kind text,
  row_version bigint,
  effective_state text,
  created_at timestamptz,
  respond_by timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  ended_at timestamptz,
  ended_kind text,
  decline_reason text,
  ordering_facility_name text,
  receiving_facility_id uuid,
  receiving_facility_name text,
  receiving_registered_address text,
  content jsonb,
  attestation_text_version text,
  attestation_text text,
  attested_by_name text,
  actions text[],
  entered_in_error boolean,
  wrong_patient_reported_at timestamptz,
  wrong_patient_late boolean,
  correctable_until timestamptz
)
language plpgsql stable security definer
set search_path = pg_catalog, ehr, identity, platform, pg_temp
as $$
declare
  session_patient uuid := ehr.order_route_patient();
begin
  return query
    with listed as (
      select route.id as listed_id,
             coalesce(route.ended_kind = 'entered_in_error', false)
             or (route.kind = 'lab_request'
               and not exists (select 1 from ehr.lab_requests source
                                where source.id = route.source_lab_request_id
                                  and source.status not in ('draft', 'entered_in_error')))
             or (route.kind = 'prescription'
               and not exists (select 1 from ehr.prescriptions source
                                where source.id = route.source_prescription_id
                                  and source.status not in ('draft', 'entered_in_error'))) as in_error
        from ehr.order_routes route
       where route.patient_id = session_patient
    )
    select route.id, route.reference::text, route.kind, route.row_version, ehr.order_route_effective_state(route),
      route.created_at, route.respond_by, route.accepted_at, route.completed_at, route.ended_at, route.ended_kind,
      route.decline_reason,
      (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
      route.receiving_facility_id,
      (select facility.name from identity.facilities facility where facility.id = route.receiving_facility_id),
      identity.order_route_registered_address(route.receiving_facility_id),
      case when listed.in_error then
        jsonb_build_object('reference', route.reference)
      when route.kind = 'lab_request' then
        jsonb_build_object('reference', route.reference, 'ordererName', route.orderer_name,
          'ordererLicenceBody', route.orderer_licence_body, 'ordererLicenceNumber', route.orderer_licence_number,
          'testCodeSystem', route.test_code_system, 'testCode', route.test_code, 'testDisplay', route.test_display,
          'priority', route.priority, 'specimenTypeCode', route.specimen_type_code,
          'clinicalInformation', route.clinical_information, 'requestedAt', route.requested_at)
      else
        jsonb_build_object('reference', route.reference, 'ordererName', route.orderer_name,
          'ordererLicenceBody', route.orderer_licence_body, 'ordererLicenceNumber', route.orderer_licence_number,
          'medicationCodeSystem', route.medication_code_system, 'medicationCode', route.medication_code,
          'medicationDisplay', route.medication_display, 'doseQuantity', route.dose_quantity,
          'doseUnit', route.dose_unit, 'routeCode', route.route_code, 'frequency', route.frequency,
          'instructions', route.instructions, 'startsOn', route.starts_on, 'endsOn', route.ends_on,
          'prescribedAt', route.prescribed_at)
      end,
      route.attestation_text_version,
      case when not listed.in_error then
        (select text_row.text from ehr.order_route_attestation_texts text_row
          where text_row.version = route.attestation_text_version) end,
      case when not listed.in_error then route.attested_by_name end,
      case when route.state = 'sent' and clock_timestamp() < route.respond_by and not listed.in_error
           then array['withdraw'] else array[]::text[] end,
      listed.in_error,
      report.reported_at,
      report.late,
      case when ehr.order_route_correction_state(route) in ('open', 'correctable')
           then ehr.order_route_correctable_until(route) end
      from ehr.order_routes route
      join listed on listed.listed_id = route.id
      left join ehr.order_route_wrong_patient_reports report on report.route_id = route.id
     order by route.created_at desc, route.id desc
     limit 100;
end;
$$;

-- C26. Support's "Wrong-patient reports" (0088:1017-1138), with seven
-- trailing columns: late, ended_kind_before, discovered_by, discovered_on;
-- the reporting member's late reports in the last 30 days (CL4); whether the
-- clinician who sent the order is still an active member at the ordering
-- facility (identity.has_active_membership, as for every staff session;
-- CL6); and required_actions, what support's review (C27) requires for this
-- report under D17-6 (empty when nothing). Three more flags: late_correction
-- (a late report), patient_prompted (late, found out from the patient or
-- another way, and something had come back; CL2) and patient_reported_before
-- (another report on a route of the same patient in the 90 days before this
-- one; CL13). The OUT columns change, so it is dropped and created with
-- 0088's body and attributes otherwise, given back to its recorded owner and
-- checked in section 8, and granted again in section 9.
drop function identity.admin_list_wrong_patient_reports(text,uuid);

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
  review_note text,
  late boolean,
  ended_kind_before text,
  discovered_by text,
  discovered_on date,
  reporter_late_reports_last_30_days integer,
  ordering_sender_active boolean,
  required_actions text[]
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
                 and report.specimens_collected = 0 then 'other_reason_nothing_recorded' end,
          case when report.late then 'late_correction' end,
          case when report.late and report.discovered_by in ('patient', 'other')
                 and report.state_before = 'completed' then 'patient_prompted' end,
          case when exists (
                 select 1 from ehr.order_routes reported_route
                   join ehr.order_routes other_route on other_route.patient_id = reported_route.patient_id
                   join ehr.order_route_wrong_patient_reports other on other.route_id = other_route.id
                  where reported_route.id = report.route_id and other.id <> report.id
                    and other.reported_at < report.reported_at
                    and other.reported_at >= report.reported_at - interval '2160 hours')
               then 'patient_reported_before' end], null) as report_flags,
        array_remove(array[
          case when report.late and (report.state_before = 'completed' or report.reason_code = 'suspected_misuse')
               then 'referred_to_dpo' end,
          case when report.late and report.state_before = 'completed'
                 and report.ended_kind_before is distinct from 'ordering_released'
               then 'ordering_facility_told' end], null) as report_required_actions
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
      listed.review_actions, listed.review_note,
      listed.late, listed.ended_kind_before, listed.discovered_by, listed.discovered_on,
      (select count(*)::integer from ehr.order_route_wrong_patient_reports other
        where other.late and other.reported_by_membership_id = listed.reported_by_membership_id
          and other.reported_at > clock_timestamp() - interval '720 hours'),
      coalesce(identity.has_active_membership(
        (select account.subject from auth.accounts account where account.id = route.sent_by_account_id),
        route.sent_by_membership_id, route.ordering_facility_id), false),
      listed.report_required_actions
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

-- C27. Support's one review of a report (0088:1140-1209), replaced: after
-- its input checks, the row lock and the existing refusals, a late report
-- whose required actions (D17-6, as C26 lists them and T8's
-- order_route_wrong_patient_reports_late_review_ck enforces) are not all
-- among the requested ones answers 22023 WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED,
-- DETAIL the missing actions, comma-separated (referred_to_dpo first). Every
-- in-window report is reviewed exactly as before. 0088's attributes.
create or replace function identity.admin_review_wrong_patient_report(target_report_id uuid, expected_version bigint,
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
  missing text;
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
  select report.id, report.route_id, report.row_version, report.reviewed_at, report.late, report.state_before,
         report.reason_code, report.ended_kind_before
    into current_report
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
  if current_report.late then
    select string_agg(required.action, ',' order by required.position) into missing
      from (values (1, 'referred_to_dpo',
                    current_report.state_before = 'completed' or current_report.reason_code = 'suspected_misuse'),
                   (2, 'ordering_facility_told',
                    current_report.state_before = 'completed'
                      and current_report.ended_kind_before is distinct from 'ordering_released'))
           required(position, action, needed)
     where required.needed and not required.action = any(requested_actions);
    if missing is not null then
      raise exception using errcode = '22023', message = 'WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED', detail = missing;
    end if;
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

-- C21. Support's find (0089 section 3), with four trailing columns: the
-- route's correction state (the helper), the deadline while B may still act
-- or once it has passed (open, correctable, too_late; null when never
-- accepted or already reported), and B's report (when, and whether late) if
-- any. The reference is compared as char(8), so a lookup by reference uses
-- order_routes_reference_idx. The 5 or 20 routes are chosen first, then the
-- effective state and the correction state are evaluated once for each
-- (OFFSET 0 keeps the lateral subquery from being pulled up, which would
-- evaluate each helper once per reference to it: 0089's body evaluated the
-- effective state twice per row). The OUT columns change, so it is dropped
-- and created with 0089's body and attributes otherwise, given back to its
-- recorded owner and checked in section 8, and granted again in section 9.
drop function identity.admin_find_order_routes(text,text);

create function identity.admin_find_order_routes(requested_reference text, requested_health_id text)
returns table (
  route_id uuid,
  reference text,
  kind text,
  row_version bigint,
  effective_state text,
  ordering_facility_id uuid,
  ordering_facility_name text,
  receiving_facility_id uuid,
  receiving_facility_name text,
  created_at timestamptz,
  accepted_at timestamptz,
  ended_at timestamptz,
  ended_kind text,
  access_ends_at timestamptz,
  closable boolean,
  correction text,
  correctable_until timestamptz,
  wrong_patient_reported_at timestamptz,
  wrong_patient_late boolean
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, ehr, auth, platform, pg_temp
as $$
declare
  wanted_reference text := upper(btrim(requested_reference));
  wanted_patient uuid;
begin
  perform identity.order_route_platform_actor(array['platform.principal.read']);
  if (requested_reference is null) = (requested_health_id is null)
     or (requested_reference is not null and not coalesce(wanted_reference ~ '^[0-9A-F]{8}$', false))
     or (requested_health_id is not null and ehr.order_route_health_id(requested_health_id) is null) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_LOOKUP_INVALID';
  end if;
  if requested_health_id is not null then
    select patient.id into wanted_patient from identity.patients patient
     where patient.hid_code = ehr.order_route_health_id(requested_health_id);
    if wanted_patient is null then
      return;
    end if;
  end if;
  return query
    select route.id, route.reference::text, route.kind, route.row_version, now_state.effective,
      route.ordering_facility_id,
      (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
      route.receiving_facility_id,
      (select facility.name from identity.facilities facility where facility.id = route.receiving_facility_id),
      route.created_at, route.accepted_at, route.ended_at, route.ended_kind,
      route.access_ends_at,
      not coalesce(now_state.effective not in ('sent', 'accepted', 'completed')
        or (route.state = 'completed'
          and (route.ended_at is not null or clock_timestamp() >= route.access_ends_at)), false),
      now_state.correction,
      case when now_state.correction in ('open', 'correctable', 'too_late')
           then ehr.order_route_correctable_until(route) end,
      report.reported_at, report.late
      from (select route.id from ehr.order_routes route
             where (requested_reference is not null and route.reference = wanted_reference::char(8))
                or (wanted_patient is not null and route.patient_id = wanted_patient)
             order by route.created_at desc, route.id desc
             limit case when requested_reference is not null then 5 else 20 end) listed
      join ehr.order_routes route on route.id = listed.id
      cross join lateral (select ehr.order_route_effective_state(route) as effective,
                                 ehr.order_route_correction_state(route) as correction offset 0) now_state
      left join ehr.order_route_wrong_patient_reports report on report.route_id = route.id
     order by route.created_at desc, route.id desc;
end;
$$;

-- 8. Owners and attributes. Every new object goes to o, H6's owner (a
-- CREATE makes the applying role the owner, and a SECURITY DEFINER wrapper
-- created by a superuser runner would otherwise run as the superuser); C5,
-- C21 and C26 go back to their recorded owners. Then every attribute
-- recorded in section 0 must be as before (for C5, C21 and C26 all but the
-- body and the argument and result columns; their grants are compared after
-- section 9), and every new object must belong to o, or the release stops.
do $$
declare
  o oid;
  restored record;
  signature text;
  mismatch text;
begin
  select recorded_row.proowner into o from pg_temp.order_route_late_0090 recorded_row
   where recorded_row.signature::regprocedure = 'ehr.order_route_access_allows(text,uuid,uuid,text)'::regprocedure;
  if (select relation.relowner from pg_class relation
       where relation.oid = 'ehr.order_route_correction_capabilities'::regclass) <> o then
    execute format('alter table ehr.order_route_correction_capabilities owner to %I', pg_get_userbyid(o));
  end if;
  foreach signature in array array['ehr.order_route_correctable_until(ehr.order_routes)',
      'ehr.order_route_correction_state(ehr.order_routes)',
      'ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)',
      'lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)',
      'pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)',
      'ehr.find_correctable_order_routes(text,text)', 'lab.find_correctable_order_routes(text)',
      'pharmacy.find_correctable_order_routes(text)'] loop
    if (select proc.proowner from pg_proc proc where proc.oid = signature::regprocedure) <> o then
      execute format('alter function %s owner to %I', signature, pg_get_userbyid(o));
    end if;
  end loop;
  for restored in select recorded_row.signature, recorded_row.proowner from pg_temp.order_route_late_0090 recorded_row
                   where recorded_row.signature::regprocedure in ('ehr.patient_list_order_routes()'::regprocedure,
                     'identity.admin_find_order_routes(text,text)'::regprocedure,
                     'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure) loop
    if (select proc.proowner from pg_proc proc where proc.oid = restored.signature::regprocedure)
       <> restored.proowner then
      execute format('alter function %s owner to %I', restored.signature, pg_get_userbyid(restored.proowner));
    end if;
  end loop;
  select string_agg(recorded.signature, ', ') into mismatch
    from pg_temp.order_route_late_0090 recorded
    join pg_proc proc on proc.oid = recorded.signature::regprocedure
   where (proc.proowner, proc.prolang, proc.procost, proc.prorows, proc.provariadic, proc.prosupport, proc.prokind,
          proc.prosecdef, proc.proleakproof, proc.proisstrict, proc.proretset, proc.provolatile, proc.proparallel,
          proc.pronargs, proc.pronargdefaults, proc.prorettype, proc.proargtypes, proc.proargdefaults::text,
          proc.protrftypes, proc.probin, proc.prosqlbody::text, proc.proconfig)
         is distinct from
         (recorded.proowner, recorded.prolang, recorded.procost, recorded.prorows, recorded.provariadic,
          recorded.prosupport, recorded.prokind, recorded.prosecdef, recorded.proleakproof, recorded.proisstrict,
          recorded.proretset, recorded.provolatile, recorded.proparallel, recorded.pronargs, recorded.pronargdefaults,
          recorded.prorettype, recorded.proargtypes, recorded.proargdefaults, recorded.protrftypes, recorded.probin,
          recorded.prosqlbody, recorded.proconfig)
      or (recorded.signature::regprocedure not in ('ehr.patient_list_order_routes()'::regprocedure,
            'identity.admin_find_order_routes(text,text)'::regprocedure,
            'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure)
          and (proc.proallargtypes, proc.proargmodes, proc.proargnames, proc.proacl)
              is distinct from (recorded.proallargtypes, recorded.proargmodes, recorded.proargnames, recorded.proacl));
  if mismatch is not null then
    raise exception '0090: a replaced or recreated function differs from its owner or attributes before 0090: %',
      mismatch;
  end if;
  select string_agg(owned.what, ', ') into mismatch
    from (select proc.oid::regprocedure::text as what, proc.proowner as owner_id from pg_proc proc
           where proc.oid in ('ehr.order_route_correctable_until(ehr.order_routes)'::regprocedure,
             'ehr.order_route_correction_state(ehr.order_routes)'::regprocedure,
             'ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)'::regprocedure,
             'lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)'::regprocedure,
             'pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)'::regprocedure,
             'ehr.find_correctable_order_routes(text,text)'::regprocedure,
             'lab.find_correctable_order_routes(text)'::regprocedure,
             'pharmacy.find_correctable_order_routes(text)'::regprocedure)
          union all
          select relation.oid::regclass::text, relation.relowner from pg_class relation
           where relation.oid = 'ehr.order_route_correction_capabilities'::regclass) owned
   where owned.owner_id <> o;
  if mismatch is not null then
    raise exception '0090: a new object does not belong to H6''s owner: %', mismatch;
  end if;
end
$$;

-- 9. Grants (as 0088 section 5 and 0089 section 5; runtime-grants.sql
-- carries the same). The login roles (hid_lab_api_runtime,
-- hid_pharmacy_api_runtime, hid_ehr_api_runtime, hid_identity_api_runtime)
-- inherit their group's. T9, the two helpers, C29 and C30 are granted to no
-- role; H6, item access, the release trigger, the guard, the summary, C27
-- and C28 keep their ACL (CREATE OR REPLACE).
revoke all on function ehr.order_route_correctable_until(ehr.order_routes),
  ehr.order_route_correction_state(ehr.order_routes),
  ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,char),
  lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,char),
  pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,char),
  ehr.find_correctable_order_routes(text,text),
  lab.find_correctable_order_routes(text),
  pharmacy.find_correctable_order_routes(text),
  ehr.patient_list_order_routes(),
  identity.admin_list_wrong_patient_reports(text,uuid),
  identity.admin_find_order_routes(text,text)
  from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_lab_runtime') then
    grant execute on function lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,char),
      lab.find_correctable_order_routes(text)
      to hid_lab_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    grant execute on function pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,char),
      pharmacy.find_correctable_order_routes(text)
      to hid_pharmacy_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.patient_list_order_routes() to hid_ehr_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.admin_list_wrong_patient_reports(text,uuid),
      identity.admin_find_order_routes(text,text)
      to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,char),
      lab.find_correctable_order_routes(text),
      pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,char),
      pharmacy.find_correctable_order_routes(text),
      ehr.patient_list_order_routes()
      to hid_schema_test_runtime;
  end if;
end
$$;

-- Last: C5's, C21's and C26's grants are, as a set of (grantee, privilege),
-- what they were before the DROP (the grantor may differ when a superuser
-- applies it). Another grant production holds on one of them would
-- otherwise be lost silently: restate it in this migration first.
do $$
declare
  mismatch text;
begin
  select string_agg(recorded.signature, ', ') into mismatch
    from pg_temp.order_route_late_0090 recorded
    join pg_proc proc on proc.oid = recorded.signature::regprocedure
   where recorded.signature::regprocedure in ('ehr.patient_list_order_routes()'::regprocedure,
           'identity.admin_find_order_routes(text,text)'::regprocedure,
           'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure)
     and exists (
       (select acl.grantee, acl.privilege_type
          from aclexplode(coalesce(recorded.proacl, acldefault('f', recorded.proowner))) acl
        except
        select acl.grantee, acl.privilege_type
          from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl)
       union all
       (select acl.grantee, acl.privilege_type
          from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
        except
        select acl.grantee, acl.privilege_type
          from aclexplode(coalesce(recorded.proacl, acldefault('f', recorded.proowner))) acl));
  if mismatch is not null then
    raise exception '0090: a recreated function has other grants than before; restate them in this migration first: %',
      mismatch;
  end if;
end
$$;
