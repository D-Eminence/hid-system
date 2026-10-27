-- 0091 The receiving laboratory's or pharmacy's "We can't complete this
-- order" (D18, owner decisions D18-1 to D18-15 of 2026-10-27, every
-- recommended default).
--
-- A laboratory or pharmacy (B) that accepted a cross-facility order from the
-- ordering facility (A) for the patient (P), and then cannot finish it, ends
-- the order with one fixed reason. In one transaction the route ends through
-- 0086's shared closer (accepted -> cancelled, ended_kind
-- 'receiving_unable'): B's writes end at once; B's reads end at once too,
-- unless B had opened an accession on a lab request, when they last 7 more
-- days (D18-2); the reason and what B had recorded go into a new
-- append-only table (T10); a system row is written at A and at B; P gets an
-- inbox notice (D18-3). Only an order B accepted, inside its work window,
-- not ended, with nothing returned and no report (D18-1); never while a
-- checked (verified, not invalidated) result waits to be released, and with
-- a possibly critical value only once B says it has told A (D18-15). Nothing
-- is withdrawn: on an accepted order nothing has ever gone to A or P. Item
-- 3's report (0088), D17's late correction (0090) and every other body stay
-- as they are, apart from the order summary's one new key; the late
-- correction works on such an order because its CHECK on the report table
-- now admits the new ending.
--
-- 0. Preconditions (catalog reads; see Locks): no object of this migration
--    exists; the order summary, the one body replaced, and the 85 bodies the
--    new ones rely on are byte for byte the ones measured on 0001-0090 (md5
--    of pg_proc.prosrc): every function a new or replaced body calls, and
--    their callees, transitively; every trigger function of a table they
--    write; every policy function of a table they read; and the bodies whose
--    behaviour this design relies on (the other endings, the late
--    correction's void path, the return triggers, the readers). The route's
--    ended-kind, end and acceptance CHECKs, the route events' type, reason,
--    side and state CHECKs, and every CHECK, key, column and index of the
--    report table (T8) are the ones 0086, 0088 and 0090 made (compared with
--    the same objects built on temporary tables in this session); the
--    route's two user triggers, T8's guard and the four return triggers are
--    bound to their pinned functions. Ownership and privileges follow 0089
--    and 0090: the shared closer's owner o will own every new object; o may
--    create in ehr, lab, pharmacy and identity, and read and write what the
--    new bodies read and write, and run what they call; the applying role
--    inherits o, the summary's owner and the owners of ehr.order_routes and
--    T8, and may become o. A privilege counts only when held by ownership,
--    membership or grant, never through a superuser's bypass: production's
--    migrator has none. A NOTICE names every owner checked; the runner
--    forwards it to the release's log. Every attribute but the body of the
--    summary is recorded.
-- 1. T10, ehr.order_route_unable_endings: one row per route ended this way
--    (the reason, who ended it, how long after acceptance, what B had
--    recorded, the critical-value statement, the key and digest), two
--    indexes for the limits and support's counts, row-level security
--    enabled and forced with four policies, no grant to any role, and a
--    guard that refuses every UPDATE and DELETE (23514
--    ORDER_ROUTE_UNABLE_ENDING_IMMUTABLE), also for its owner. Its key to
--    ehr.order_routes is added in section 7, under that section's lock.
-- 2. The command C31, ehr.cannot_complete_order_route(...) (owner-only),
--    through lab.cannot_complete_order_route(...) and
--    pharmacy.cannot_complete_order_route(...) (SECURITY DEFINER SQL
--    wrappers, as item 3's). A possibly critical value is asked about
--    before the limits, so that a member or facility at its limit is still
--    told to phone A about it (D18-15). At most 20 endings per staff member
--    (counted by their account, at every facility it belongs to) and 50 per
--    facility in any 24 hours, exact under advisory locks per account and
--    per facility (D18-7).
-- 3. The ordering facility's summary of one route, replaced: 0090's body
--    byte for byte plus one key, notCompleted, in its outer select list.
-- 4. Support's counts C32, identity.admin_order_route_not_completed(uuid):
--    a facility's endings of the last 30 days, within an hour of acceptance
--    with nothing recorded, after 7 days, later reported as the wrong
--    patient, and by reason (D18-11). Support's facility summary (C20) is
--    unchanged; the Identity service merges the two.
-- 5. Owners, read grants and post-checks: every new object goes to o; each
--    role that runs the summary (the owners of C3 and C4, which call it, and
--    the summary's own owner) is given SELECT on T10 unless it already holds
--    it, because every call of the summary locks T10 and needs that
--    privilege, whichever route it summarizes; then every recorded attribute
--    of the summary must be as before, every new object must belong to o,
--    and every role that runs the summary must be able to read T10, or the
--    release stops.
-- 6. Grants, here and in runtime-grants.sql: the Lab wrapper to
--    hid_lab_runtime, the Pharmacy wrapper to hid_pharmacy_runtime, both to
--    hid_schema_test_runtime, C32 to hid_identity_runtime alone. T10, its
--    guard and the shared command to no role; the summary keeps its ACL.
-- 7. Last, under one ACCESS EXCLUSIVE lock on ehr.order_routes and T8
--    together, taken NOWAIT (see Locks): 'receiving_unable' joins the
--    route's ended-kind CHECK and, on cancelled routes only, its end CHECK,
--    and joins the endings T8's late CHECK admits as ended_kind_before (so
--    that D17's late correction can correct such an order); T10's key to
--    the route (on delete restrict). The three CHECKs are added validated
--    while the route table is small, and NOT VALID above that size (see
--    The CHECKs' form).
--
-- Locks (measured with pg_locks at every section boundary, in a dry run and
-- a committed apply as the migrator and in a dry run as a NOSUPERUSER owner,
-- the same set each time, and with each table held by another session).
-- Section 0 takes momentary ACCESS SHARE locks, released at once, on
-- ehr.order_routes, ehr.order_route_events and T8 (pg_get_constraintdef,
-- pg_get_indexdef). Sections 1 to 6 hold, to commit, ACCESS EXCLUSIVE on the
-- new T10, its five indexes and its TOAST table (its creation; and SHARE
-- ROW EXCLUSIVE from its trigger), and ACCESS SHARE on T10, T8,
-- identity.facilities and identity.organizations (the summary's LANGUAGE
-- sql body names them when it is created; the command's and C32's PL/pgSQL
-- bodies lock no table when they are created); nothing on
-- ehr.order_routes. Section 7 adds ACCESS EXCLUSIVE on ehr.order_routes and
-- T8, held to commit, with the key's SHARE ROW EXCLUSIVE and ROW SHARE on
-- ehr.order_routes and the ACCESS SHARE its validation takes on the route
-- table's indexes. While it is held every statement that reads
-- ehr.order_routes waits: every Lab and Pharmacy chain read at a receiving
-- facility, the ordering facility's order lists, sends, acceptances, the
-- patient's list, support's find. For how long, see The CHECKs' form; the
-- release dry-runs first, so production sees it twice. It is taken by one
-- LOCK statement naming both tables, NOWAIT, so an attempt takes both or
-- neither and never waits while holding one: readers lock ehr.order_routes
-- and then T8, and a migration holding one while waiting for the other
-- would make them wait on it. A refused attempt's subtransaction releases
-- everything (it leaves no subtransaction behind), and the loop samples
-- again 10 ms later, 500 times. It stops the release with nothing applied
-- (55P03, "run the release again later"), in the dry run or the apply, when
-- in 5 seconds there is no instant at which no transaction holds any lock on
-- either table: one transaction or pg_dump reading either table for 5
-- seconds, an autovacuum or ANALYZE of either table (a NOWAIT request never
-- queues, so the deadlock checker never cancels the vacuum), or a steady
-- stream of overlapping transactions with no gap. Measured: a session
-- holding ACCESS SHARE, ROW EXCLUSIVE or SHARE UPDATE EXCLUSIVE (vacuum's)
-- on either table stops the dry run and the apply after 5.4-5.6 s; readers
-- at about 1,050 transactions a second with no idle time (begin, read the
-- route table, 3 ms, read T8, commit; 4 clients) stop both; at about 1,110
-- a second with 10 ms of idle time between transactions (16 clients) both
-- succeed, in 0.3 and 0.5 s. Release it at a quiet hour, after checking
-- pg_stat_activity for long transactions and pg_stat_progress_vacuum for
-- either table. ACCESS SHARE conflicts only with ACCESS EXCLUSIVE: with
-- ACCESS EXCLUSIVE held by another session on ehr.order_routes,
-- ehr.order_route_events, T8, identity.facilities or identity.organizations,
-- the runner's lock_timeout stops the dry run and the apply after 5.2 s with
-- nothing applied; held on any other table, among them every Lab and
-- Pharmacy chain table, platform.control_settings, identity.consent_grants,
-- audit.events and notification.inbox_items, 0091 applies without waiting.
-- After 0091 every call of the summary takes ACCESS SHARE on T10 and needs
-- SELECT on it: a later ALTER, TRUNCATE, VACUUM FULL or CLUSTER of T10 needs
-- the same NOWAIT treatment.
--
-- The CHECKs' form (D18-14). Each of the three new CHECKs admits every row
-- the CHECK it replaces admits (one more value in one list), so every
-- existing row satisfies it by construction, and new rows are checked
-- either way. Section 7 reads, under its lock, the size of ehr.order_routes'
-- heap (pg_relation_size, no scan). At most 117,145,600 bytes (14,300 pages
-- of 8 kB, about 200,000 routes at the 14 a page measured), the three are
-- added validated: one scan of the route table under the lock, 5.5-7.9 ms
-- in all on a copy with no routes and 67-86 ms with 100,000 routes (warm),
-- 76 ms on a fresh copy and 105-115 ms after a restart with the operating
-- system's caches dropped (cold), then 3-7 ms to commit or roll back.
-- Above it they are added NOT VALID, with no VALIDATE: 5-10 ms at any size
-- (4.9-6.2 ms warm and 10.2 ms cold with 100,000 routes), and every later
-- precondition must then expect convalidated false for them. A NOTICE says
-- which form was taken and why.
--
-- Owners and size, before signing (D18-14). Production's owners and route
-- table size are read before signing with this read-only query and recorded
-- (catalog reads and a size read: at most a momentary ACCESS SHARE on
-- ehr.order_routes, which waits only behind an ACCESS EXCLUSIVE); the heap
-- bytes it prints decide the form section 7 will take:
--   select owned.what, pg_get_userbyid(owned.owner_id) as owner, owned.size
--     from (select proc.oid::regprocedure::text as what, proc.proowner as owner_id, null::text as size
--             from pg_proc proc
--            where proc.oid in (
--              'ehr.close_order_route(uuid,text,text,boolean)'::regprocedure,
--              'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure,
--              'ehr.list_order_routes_for_order(text,uuid,uuid)'::regprocedure,
--              'ehr.order_route_summaries(text,uuid,uuid[])'::regprocedure)
--           union all
--           select relation.oid::regclass::text, relation.relowner,
--                  case when relation.oid = 'ehr.order_routes'::regclass
--                       then format('reltuples %s, relpages %s, heap bytes %s', relation.reltuples::bigint,
--                                   relation.relpages, pg_relation_size(relation.oid)) end
--             from pg_class relation
--            where relation.oid in ('ehr.order_routes'::regclass,
--                                   'ehr.order_route_wrong_patient_reports'::regclass,
--                                   'identity.facilities'::regclass)) owned
--    order by owned.what;
-- It returns 7 rows. One owner on every row is expected. A second owner
-- does not stop the release by itself: section 0 then checks, by
-- ownership, membership or grant, that each role it names may do what it
-- must, and stops the release with nothing applied if one may not. Once
-- signed, scripts/apply-migrations.mjs prints this file's NOTICEs in the
-- release's log, in the dry run and in the apply ("NOTICE
-- 0091_order_route_cannot_complete.sql: 0091: owners checked: ..." and
-- "... 0091: ehr.order_routes ...: the CHECKs are added ..."). They must
-- name the owners and the form recorded before signing.
--
-- Old services on this schema: the previous Lab and Pharmacy images call
-- none of the new functions; their cards pass the ended kind as text; item
-- access, the release trigger and the dispensing validator are unchanged
-- and close a cancelled route to writes; their late correction of an order
-- ended this way works (T8's CHECK widened). The previous EHR maps the
-- summary's keys field by field and drops notCompleted; the summary's T10
-- read runs as C3's and C4's owners, which section 5 lets read T10. The
-- previous Identity never calls C32, and C20, C21, C26 and C27 are
-- unchanged. Applied migrations 0001 through 0090 are immutable.

-- 0. Preconditions. The release dry-runs every pending migration in one
-- transaction before applying any, so a refusal here stops the release with
-- nothing changed. Catalog reads (see Locks).

-- Whether holder holds a privilege on an object by ownership, by membership
-- (direct or through other roles) or by grant (also to PUBLIC), ignoring a
-- superuser's bypass (0090's helper). Dropped at the end of section 5.
create function pg_temp.order_route_0091_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  -- a. No collision, under any signature or name.
  if to_regclass('ehr.order_route_unable_endings') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where (namespace.nspname, proc.proname) in (
                   ('ehr', 'cannot_complete_order_route'), ('lab', 'cannot_complete_order_route'),
                   ('pharmacy', 'cannot_complete_order_route'), ('ehr', 'guard_order_route_unable_ending'),
                   ('identity', 'admin_order_route_not_completed')))
     or exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
                 where namespace.nspname = 'ehr' and relation.relname like 'order\_route\_unable\_endings%')
     or exists (select 1 from pg_constraint constraint_row
                 where constraint_row.conname like 'order\_route\_unable\_endings%') then
    raise exception '0091: an object of this migration already exists; this release would collide with it';
  end if;
  -- b. The body this migration replaces (the order summary, as 0090 left
  -- it): md5 of pg_proc.prosrc measured on 0001-0090.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ehr.order_route_summary(ehr.order_routes,boolean)', '324809e749bc38a89305b07f1458fc28'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception '0091: the function this migration replaces has another body than 0001-0090 gave it: %',
      mismatch;
  end if;
  -- c. The bodies 0091 relies on, unchanged. The rule: every function a new
  -- or replaced body calls, and their callees, transitively (the closer, the
  -- route writer, the route lock and the application lock it takes, the
  -- receiver and staff actor and their callees, H7, H9, the audit and
  -- notice writers and the inbox writer, the control readers, the
  -- permission checks, the session readers, the platform actor, the
  -- destination check and its callees); every trigger function of a table
  -- they write (the route's guard and first-event trigger, the audit
  -- events' authorization); every policy function of a table they read (the
  -- Lab chain's context functions, H6, the consent check); and the bodies
  -- whose behaviour this design relies on: item access and the return
  -- triggers (nothing crosses after the ending), the dispensing validator,
  -- the specimen transitions, item 3's report and D17's late correction
  -- with its void path, state, deadline, lookup and T8's guard (never a
  -- dodge), the route cards, C3, C4, A's events view, C5, C21, C20,
  -- support's Close, reports and review, C28, the order-change mirror, the
  -- release closer, the send, the resend rule, the acceptance, the decline,
  -- the membership test and 0089's order_routes_here.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ehr.close_order_route(uuid,text,text,boolean)', 'd0c8c11573bc3fd5cc764553d55b1820'),
      ('ehr.write_order_route_change(ehr.order_routes,ehr.order_routes,text,text,text)',
       'b11691bfe99d65a93d60eefe0fc8c0c1'),
      ('ehr.guard_order_route_mutation()', '6a01bc885cd54f87a1bee8c0ebc100a4'),
      ('ehr.require_order_route_first_event()', 'ae41186236e61c14f252bfa38a008e6a'),
      ('ehr.lock_receiving_route(text,uuid,uuid,uuid)', 'b73b01f7ca721adb0de4e834dd566e3a'),
      ('identity.lock_self_service_application(uuid)', '4eeb309085494a7652c19e7d6365e131'),
      ('ehr.order_route_receiver(text)', '61eed3f80f2502aadc338581142214a5'),
      ('ehr.order_route_staff_actor(boolean)', 'b1873dca92164652cc1977a90acb6184'),
      ('ehr.order_route_allows(uuid,uuid,text)', 'b80c2df6c380f7c7e20d166da94e56d2'),
      ('ehr.order_route_effective_state(ehr.order_routes)', '934300a9e58a7f6789b1dc24520fabad'),
      ('ehr.order_route_system_audit(ehr.order_routes,text,text,boolean,jsonb)',
       '6c54f543a495e35d9ebd029450d49e0a'),
      ('ehr.order_route_notify_patient(ehr.order_routes,text)', '31a11a44325846699036367b7e56b46e'),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)',
       '0b5689f31a3ce00f9313fe1e55244fad'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('platform.require_control_enabled(text)', '90887489d15eab24f8f71b145bb02320'),
      ('platform.control_enabled(text)', 'ed17b9d8097417363c0a6343e52aa47f'),
      ('ehr.order_route_access_open()', 'd0b8aff4c2a656c30872b95286071457'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('ehr.order_route_receive_permission(text)', '4c9f4acbafb062ff9a2cda113ccad037'),
      ('auth.account_has_platform_permission(uuid,text)', '2145c72b864abf1b69d23d96265e5ba7'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('identity.order_route_destination_eligible(uuid,text)', '6b274d9be9056cefc831a9fd92040bc6'),
      ('identity.order_route_platform_actor(text[])', '599cccfdba5e9b4c46cde4dd2814a541'),
      ('ehr.order_route_destination_type(text)', '9ce8c8706abc84e98ae3e1c86a24515f'),
      ('identity.order_route_destination_listed(uuid)', '2a2025d538db2686c1ca5a03e0354923'),
      ('identity.organization_self_service_state(uuid)', 'c67aa5224b2aa3d95e4415e26787d470'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('ehr.order_route_access_allows(text,uuid,uuid,text)', '175eff453979c964889283a29bb8f34f'),
      ('lab.context_allows(uuid,uuid,text)', '57e689661a6227e34d3bde9562468951'),
      ('pharmacy.context_allows(uuid,uuid,text)', '958a6e5cd2a534d158c82fe399b8f381'),
      ('lab.patient_self_context(uuid)', '39aeca12d2c59b69877800a9a3a7c50b'),
      ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
      ('identity.patient_self_session(text,uuid)', 'd4c7aeaf25317d0fae794a2764d7d72b'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)',
       '8b12ce866ee75cce411a2721795ffb92'),
      ('ehr.order_route_item_access(text,uuid,text)', 'f8a25012d7f481493aba8d941ebd94de'),
      ('lab.order_route_access_for(text,uuid,text)', '3c2b16b767a524da80bd2e08787137b2'),
      ('pharmacy.order_route_access_for(text,uuid,text)', 'e7ca58cd88b563f72065bbb78ea04c13'),
      ('lab.return_order_route_result()', '10f7b7726a59488cd6ae6f9e55c4c568'),
      ('lab.return_order_route_invalidation()', '2176bfd64b05c6e357021c178060f1b7'),
      ('pharmacy.validate_dispensing()', '23d9b6a9a9d09b106f685679df84f74f'),
      ('pharmacy.return_order_route_dispensing()', 'da0017a88bb938cd0fcbba50fdadaa11'),
      ('pharmacy.return_order_route_reversal()', '7cf0067c59c502026be74e292a8989ab'),
      ('lab.validate_result_governance()', '6bf52a22ce45e834d4f2a194a06babad'),
      ('pharmacy.validate_dispensing_reversal()', 'a8b1147f356e669fe0d14bea3e7ab014'),
      ('lab.validate_outbox_aggregate_reference()', 'b86458c9a75df2fec44f6ddf7a8acbef'),
      ('lab.validate_specimen_transition()', '04b8ddd460e833e1329bd6b777afda6b'),
      ('ehr.order_route_correction_state(ehr.order_routes)', 'f0c1398be3fc24da9d6e8f24e24704b2'),
      ('ehr.order_route_correctable_until(ehr.order_routes)', 'eee8bc70ee20f5fd6832240d9b5a44ac'),
      ('ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)',
       '6e903c30ec5c1c6c6949a4d16ea65dbe'),
      ('lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)',
       '7b557ebe0da9a62a2b747a985630d80d'),
      ('pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)',
       '8ed1179e95e90b3548724567d1eaa2c1'),
      ('ehr.find_correctable_order_routes(text,text)', 'aa35b18326fb942d83d647385b3efa83'),
      ('lab.find_correctable_order_routes(text)', 'ed3bfd6307e1203687b5112945925b04'),
      ('pharmacy.find_correctable_order_routes(text)', '14e458737c1cdc176db851178ebb71c6'),
      ('ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,character)',
       'ef39eba74338f1414787ade116e3bc6b'),
      ('lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)',
       'cddfb3e83aef2e54d071578530f8c4ea'),
      ('pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)',
       '38cbfa3b8e11fecc1654dd6a36718253'),
      ('ehr.guard_order_route_wrong_patient_report()', 'e7cb9533553b7126b773f5c548bebd08'),
      ('ehr.receiving_order_route_cards(text,uuid[])', 'ac3cb68817a41d49ebb186c7a4e9dd5d'),
      ('lab.order_route_cards(uuid[])', '1093a2fed7f01b61c5b1a95c32353a05'),
      ('pharmacy.order_route_cards(uuid[])', '6504851cb99e0cf975ca2f7a27402886'),
      ('ehr.list_order_routes_for_order(text,uuid,uuid)', 'cb6c138fbbffa1e1f226cde0aac1ec0b'),
      ('ehr.order_route_summaries(text,uuid,uuid[])', 'bee72d84a41b7c1bba7a0b492ca6546c'),
      ('ehr.order_route_events_view(uuid)', 'c62bd8052874281182632e9511bd6945'),
      ('ehr.patient_list_order_routes()', '4dee7f9f41fc9c51e7364452a2968b73'),
      ('identity.admin_find_order_routes(text,text)', '535c992a7d4490305ffe9b8162040afb'),
      ('identity.admin_order_route_summary(uuid)', '8dd0097542abe54257ba8dd1d60d9653'),
      ('identity.admin_close_order_route(uuid,bigint,text)', 'e0ea834d458863ec19a94b4853e2a32c'),
      ('identity.admin_list_wrong_patient_reports(text,uuid)', '698b83d5efc56c4ae98a7a5d8909916c'),
      ('identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)',
       '52221add3359fe79786c9d7ca837987f'),
      ('ehr.list_sent_wrong_patient_order_routes()', 'c7fef780b97a20ffb40753dfecad37a1'),
      ('ehr.sync_order_routes_on_order_change()', '8ce6b42450cc06fc02fec8d1cf63af41'),
      ('ehr.close_order_routes_on_release()', '2d082c1e58b250a46fe0ea4e7c05c099'),
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)',
       'f2578d557ca26b29e24140bbac377ca8'),
      ('ehr.order_route_resend_allowed(text,uuid)', 'cd18f1a4942694d04288ab5d54679dbd'),
      ('ehr.accept_receiving_order_route(text,uuid,bigint,text,text,text,text,character,text)',
       '1d4a77de6316fa95a539d8151c8604df'),
      ('ehr.decline_receiving_order_route(text,uuid,bigint,text)', '93feb4443441cacb38073db9fa0e1ffe'),
      ('ehr.order_routes_here(text)', '92ad7c407b47356e106f22d48238a1e2'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception '0091: a function "can''t complete" relies on has another body than 0001-0090 gave it: %',
      mismatch;
  end if;
  -- d. The CHECKs 0091 relies on or replaces, compared with the same CHECKs
  -- built on temporary tables in this session (as 0088, 0089 and 0090
  -- compare theirs): ehr.order_routes' ended-kind and end CHECKs as 0088
  -- left them and its acceptance CHECK as 0086 made it; the route events'
  -- type, reason, side and state CHECKs (the ending writes cancelled /
  -- receiving / receiving_unable); and every CHECK, key, column and index of
  -- T8 exactly as 0090 left it.
  create temporary table order_routes_0091_checks (
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
    side text check (side in ('ordering', 'receiving', 'patient', 'platform', 'system')),
    reason_code text check (reason_code is null or reason_code ~ '^[a-z][a-z_]{1,39}$'),
    state_after text check (state_after in ('sent', 'accepted', 'completed', 'declined', 'withdrawn', 'expired',
      'cancelled'))
  ) on commit drop;
  -- T8 as 0088 created it and 0090 altered it, under its own name in
  -- pg_temp, so that the generated constraint names are the same (its key
  -- to the route aside: a temporary table cannot reference a permanent one).
  create temporary table order_route_wrong_patient_reports (
    id uuid primary key,
    route_id uuid not null unique,
    kind text not null check (kind in ('lab_request', 'prescription')),
    receiving_facility_id uuid not null,
    receiving_organization_id uuid not null,
    ordering_facility_id uuid not null,
    state_before text not null check (state_before in ('accepted', 'completed', 'cancelled')),
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
    late boolean not null default false,
    ended_kind_before text,
    discovered_by text,
    discovered_on date,
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
      or (kind = 'prescription' and results_voided = 0 and result_reports_marked = 0 and specimens_collected = 0)),
    constraint order_route_wrong_patient_reports_late_ck check (
      (not late and ended_kind_before is null and discovered_by is null and discovered_on is null
        and state_before in ('accepted', 'completed'))
      or (late and coalesce(discovered_by in ('patient', 'ordering_facility', 'own_check', 'support', 'other'), false)
        and discovered_on is not null
        and (ended_kind_before is null or ended_kind_before in ('order_changed', 'entered_in_error',
          'receiving_released', 'ordering_released', 'support'))
        and (state_before <> 'cancelled' or ended_kind_before is not null))),
    constraint order_route_wrong_patient_reports_late_review_ck check (
      not late or reviewed_at is null
      or ((not (state_before = 'completed' or reason_code = 'suspected_misuse')
            or 'referred_to_dpo' = any(review_actions))
        and (state_before <> 'completed' or ended_kind_before is not distinct from 'ordering_released'
            or 'ordering_facility_told' = any(review_actions))))
  ) on commit drop;
  select string_agg(expected.conname, ', ') into mismatch
    from (values ('ehr.order_routes', 'pg_temp.order_routes_0091_checks', 'order_routes_ended_kind_check'),
                 ('ehr.order_routes', 'pg_temp.order_routes_0091_checks', 'order_routes_end_ck'),
                 ('ehr.order_routes', 'pg_temp.order_routes_0091_checks', 'order_routes_acceptance_ck'),
                 ('ehr.order_route_events', 'pg_temp.order_route_events', 'order_route_events_event_type_check'),
                 ('ehr.order_route_events', 'pg_temp.order_route_events', 'order_route_events_side_check'),
                 ('ehr.order_route_events', 'pg_temp.order_route_events', 'order_route_events_reason_code_check'),
                 ('ehr.order_route_events', 'pg_temp.order_route_events', 'order_route_events_state_after_check'))
         expected(live_table, built_table, conname)
   where (select pg_get_constraintdef(live.oid) from pg_constraint live
           where live.conrelid = expected.live_table::regclass and live.conname = expected.conname
             and live.contype = 'c' and live.convalidated)
         is distinct from
         (select pg_get_constraintdef(built.oid) from pg_constraint built
           where built.conrelid = expected.built_table::regclass and built.conname = expected.conname
             and built.contype = 'c');
  if mismatch is not null then
    raise exception '0091: a CHECK this migration relies on or replaces is not the one 0086 and 0088 made: %',
      mismatch;
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
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.conrelid = 'ehr.order_route_wrong_patient_reports'::regclass) <> 24
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
                       and constraint_row.contype = 'f' and constraint_row.convalidated
                       and constraint_row.confdeltype = 'r'
                       and constraint_row.confrelid = 'ehr.order_routes'::regclass)
     or (select array_agg(pg_get_indexdef(index_row.indexrelid) order by pg_get_indexdef(index_row.indexrelid))
           from pg_index index_row
          where index_row.indrelid = 'ehr.order_route_wrong_patient_reports'::regclass)
        is distinct from array[
          'CREATE INDEX order_route_wrong_patient_reports_late_member_idx ON ehr.order_route_wrong_patient_reports USING btree (reported_by_membership_id, reported_at) WHERE late',
          'CREATE INDEX order_route_wrong_patient_reports_member_idx ON ehr.order_route_wrong_patient_reports USING btree (accepted_by_membership_id, reported_at)',
          'CREATE INDEX order_route_wrong_patient_reports_ordering_idx ON ehr.order_route_wrong_patient_reports USING btree (ordering_facility_id, reported_at)',
          'CREATE INDEX order_route_wrong_patient_reports_receiving_idx ON ehr.order_route_wrong_patient_reports USING btree (receiving_facility_id, reported_at)',
          'CREATE INDEX order_route_wrong_patient_reports_review_idx ON ehr.order_route_wrong_patient_reports USING btree (reviewed_at NULLS FIRST, reported_at)',
          'CREATE UNIQUE INDEX order_route_wrong_patient_reports_idempotency_uq ON ehr.order_route_wrong_patient_reports USING btree (reported_by_account_id, receiving_facility_id, idempotency_key)',
          'CREATE UNIQUE INDEX order_route_wrong_patient_reports_pkey ON ehr.order_route_wrong_patient_reports USING btree (id)',
          'CREATE UNIQUE INDEX order_route_wrong_patient_reports_route_id_key ON ehr.order_route_wrong_patient_reports USING btree (route_id)'] then
    raise exception '0091: ehr.order_route_wrong_patient_reports is not the table 0088 and 0090 left (its CHECKs, keys, columns or indexes differ)';
  end if;
  drop table pg_temp.order_routes_0091_checks, pg_temp.order_route_events, pg_temp.order_route_wrong_patient_reports;
  -- e. Triggers: the route's two user triggers are 0086's; T8's only user
  -- trigger is its guard; the four return triggers call their pinned
  -- functions. Internal triggers (foreign keys) are not counted: T10's key
  -- (section 7) adds two to ehr.order_routes.
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
    raise exception '0091: the report table''s or the route''s user triggers are not 0090''s and 0086''s';
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
    raise exception '0091: a return trigger is not 0086''s and 0090''s: %', mismatch;
  end if;
  -- g. Every attribute but the body of the summary, for section 5.
  create temporary table order_route_unable_0091 on commit drop as
    select proc.oid::regprocedure::text as signature, proc.proowner, proc.prolang, proc.procost, proc.prorows,
           proc.provariadic, proc.prosupport, proc.prokind, proc.prosecdef, proc.proleakproof, proc.proisstrict,
           proc.proretset, proc.provolatile, proc.proparallel, proc.pronargs, proc.pronargdefaults, proc.prorettype,
           proc.proargtypes, proc.proallargtypes, proc.proargmodes, proc.proargnames,
           proc.proargdefaults::text as proargdefaults, proc.protrftypes, proc.probin,
           proc.prosqlbody::text as prosqlbody, proc.proconfig, proc.proacl
      from pg_proc proc
     where proc.oid = 'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure;
  -- f. Ownership and privileges (as 0089 and 0090, privilege-based). o is
  -- the shared closer's owner; it will own T10, its guard, C31, the two
  -- wrappers and C32, so the command and its wrappers run as o, and C32
  -- too. A privilege counts when held by ownership, membership or grant
  -- (pg_temp.order_route_0091_holds), never through a superuser's bypass,
  -- which production's migrator does not have.
  select proc.proowner into o from pg_proc proc
   where proc.oid = 'ehr.close_order_route(uuid,text,text,boolean)'::regprocedure;
  select string_agg(distinct format('%s=%s', checked.what, pg_get_userbyid(checked.role_id)), ', ') into owners_named
    from (select 'o (H14)' as what, o as role_id
          union all select relation.oid::regclass::text, relation.relowner from pg_class relation
                     where relation.oid in ('ehr.order_routes'::regclass,
                       'ehr.order_route_wrong_patient_reports'::regclass, 'identity.facilities'::regclass)
          union all select proc.oid::regprocedure::text, proc.proowner from pg_proc proc
                     where proc.oid in ('ehr.close_order_route(uuid,text,text,boolean)'::regprocedure,
                       'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure,
                       'ehr.list_order_routes_for_order(text,uuid,uuid)'::regprocedure,
                       'ehr.order_route_summaries(text,uuid,uuid[])'::regprocedure)) checked;
  raise notice '0091: owners checked: %', owners_named;
  -- o may create in the four schemas, read and write what C31 and C32 read
  -- and write (the Lab tables of B's facts and of the checked-result and
  -- critical-value tests through their row-level security), and run what
  -- they call.
  select string_agg(format('%s %s', needed.what, needed.privilege), ', ') into mismatch
    from (
      select namespace.nspname as what, 'CREATE' as privilege, namespace.nspowner as owner_id,
             namespace.nspacl as acl, 'n'::"char" as object_type
        from pg_namespace namespace where namespace.nspname in ('ehr', 'lab', 'pharmacy', 'identity')
      union all
      select relation.oid::regclass::text, wanted.privilege, relation.relowner, relation.relacl, 'r'::"char"
        from (values ('ehr.order_routes', 'SELECT'), ('ehr.order_routes', 'UPDATE'),
                     ('ehr.order_route_events', 'INSERT'),
                     ('ehr.order_route_wrong_patient_reports', 'SELECT'),
                     ('identity.facilities', 'SELECT'), ('identity.organizations', 'SELECT'),
                     ('identity.organization_applications', 'SELECT'),
                     ('identity.organization_applications', 'UPDATE'),
                     ('identity.staff_facility_memberships', 'SELECT'), ('identity.staff', 'SELECT'),
                     ('auth.accounts', 'SELECT'),
                     ('lab.accessions', 'SELECT'), ('lab.specimens', 'SELECT'), ('lab.results', 'SELECT'),
                     ('lab.test_executions', 'SELECT'), ('lab.work_item_requested_tests', 'SELECT'),
                     ('lab.result_revisions', 'SELECT'), ('lab.result_verifications', 'SELECT'),
                     ('lab.result_invalidations', 'SELECT'),
                     ('audit.events', 'INSERT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
      union all
      select proc.oid::regprocedure::text, 'EXECUTE', proc.proowner, proc.proacl, 'f'::"char"
        from pg_proc proc
       where proc.oid in ('ehr.order_route_receiver(text)'::regprocedure,
                          'ehr.order_route_staff_actor(boolean)'::regprocedure,
                          'auth.account_id_for_subject(text)'::regprocedure,
                          'identity.has_active_membership(text,uuid,uuid)'::regprocedure,
                          'auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure,
                          'ehr.order_route_receive_permission(text)'::regprocedure,
                          'platform.require_control_enabled(text)'::regprocedure,
                          'ehr.lock_receiving_route(text,uuid,uuid,uuid)'::regprocedure,
                          'identity.lock_self_service_application(uuid)'::regprocedure,
                          'ehr.order_route_allows(uuid,uuid,text)'::regprocedure,
                          'ehr.close_order_route(uuid,text,text,boolean)'::regprocedure,
                          'ehr.write_order_route_change(ehr.order_routes,ehr.order_routes,text,text,text)'::regprocedure,
                          'ehr.order_route_system_audit(ehr.order_routes,text,text,boolean,jsonb)'::regprocedure,
                          'ehr.order_route_notify_patient(ehr.order_routes,text)'::regprocedure,
                          'notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'::regprocedure,
                          'ehr.order_route_effective_state(ehr.order_routes)'::regprocedure,
                          'lab.context_allows(uuid,uuid,text)'::regprocedure,
                          'lab.patient_self_context(uuid)'::regprocedure,
                          'platform.current_account_id()'::regprocedure,
                          'platform.current_correlation_id()'::regprocedure,
                          'platform.current_membership_id()'::regprocedure,
                          'platform.current_purpose_of_use()'::regprocedure,
                          'platform.current_actor_subject()'::regprocedure,
                          'platform.current_facility_id()'::regprocedure,
                          'identity.order_route_platform_actor(text[])'::regprocedure)
    ) needed
   where not pg_temp.order_route_0091_holds(o, needed.owner_id, needed.acl, needed.object_type, needed.privilege);
  if mismatch is not null then
    raise exception '0091: the closer''s owner %, which will own the new objects, lacks: %', pg_get_userbyid(o),
      mismatch;
  end if;
  -- The roles that run the summary (the owners of C3 and C4, which call it
  -- as SECURITY DEFINER, and its own owner) are checked in section 5, once
  -- T10 exists and each that does not hold SELECT on it was given it.
  -- The applying role inherits every owner it acts for (o, for T10's key and
  -- the hand-over; the summary's owner, for CREATE OR REPLACE; the owners of
  -- the route table and T8, for section 7's ALTERs and T10's key) and may
  -- become o (ALTER OWNER needs SET on PostgreSQL 16).
  select string_agg(distinct pg_get_userbyid(needed.role_id), ', ') into mismatch
    from (select o as role_id, true as handed
          union all select recorded.proowner, false from pg_temp.order_route_unable_0091 recorded
          union all select relation.relowner, false from pg_class relation
                     where relation.oid in ('ehr.order_routes'::regclass,
                                            'ehr.order_route_wrong_patient_reports'::regclass)) needed
   where not pg_has_role(current_user, needed.role_id, 'USAGE')
      or (needed.handed and needed.role_id <> (select role_row.oid from pg_roles role_row
                                                where role_row.rolname = current_user)
          and not pg_has_role(current_user, needed.role_id, 'SET'));
  if mismatch is not null then
    raise exception '0091: the applying role may not act as or become: %', mismatch;
  end if;
end
$$;

-- 1. T10, ehr.order_route_unable_endings: one row per route a receiver
-- ended as "can't complete" (D18). The reason (by kind, D18-5; never free
-- text, D18-6), who ended it and whether that member had accepted it, how
-- many minutes after acceptance, what B had recorded at that moment
-- (whether an accession was opened, specimens collected and still held,
-- results recorded, current versions flagged critical_candidate) and
-- whether B said it had told A of a possibly critical value; never the
-- patient. The idempotency key and digest as T8's. It counts for the limits
-- (20 per member's account, 50 per facility in 24 hours) and support's
-- counts (C32). Its key to the route is added in section 7 (a key to
-- ehr.order_routes takes SHARE ROW EXCLUSIVE on it, which would then be held
-- from here to commit).
create table ehr.order_route_unable_endings (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null,
  kind text not null check (kind in ('lab_request', 'prescription')),
  receiving_facility_id uuid not null,
  receiving_organization_id uuid not null,
  ordering_facility_id uuid not null,
  reason_code text not null,
  ended_by_account_id uuid not null,
  ended_by_membership_id uuid not null,
  accepted_by_membership_id uuid not null,
  accepted_at timestamptz not null,
  ended_by_acceptor boolean not null,
  minutes_after_acceptance integer not null check (minutes_after_acceptance >= 0),
  accession_made boolean not null,
  specimens_collected integer not null check (specimens_collected >= 0),
  results_recorded integer not null check (results_recorded >= 0),
  critical_candidates integer not null default 0 check (critical_candidates >= 0),
  critical_value_told boolean not null default false,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint order_route_unable_endings_route_uq unique (route_id),
  constraint order_route_unable_endings_idempotency_uq
    unique (ended_by_account_id, receiving_facility_id, idempotency_key),
  -- D18-5: 9 laboratory and 8 pharmacy reasons, none about identity or
  -- money. C31 and both services' DTOs hold the same lists.
  constraint order_route_unable_endings_reason_ck check (
    (kind = 'lab_request' and reason_code in ('test_not_offered', 'supplies_unavailable', 'equipment_unavailable',
      'sample_unusable', 'sample_not_obtained', 'cannot_meet_priority', 'patient_declined', 'patient_did_not_return',
      'other'))
    or (kind = 'prescription' and reason_code in ('out_of_stock', 'medicine_unavailable', 'needs_prescriber_review',
      'controlled_requirements', 'cannot_meet_priority', 'patient_declined', 'patient_did_not_return', 'other'))),
  -- A prescription carries no Lab facts (an accepted prescription has no
  -- dispensing: one would have completed it).
  constraint order_route_unable_endings_kind_ck check (kind = 'lab_request'
    or (not accession_made and specimens_collected = 0 and results_recorded = 0 and critical_candidates = 0
        and not critical_value_told)),
  -- D18-15: never an ending over a possibly critical value B did not say it
  -- had told A about.
  constraint order_route_unable_endings_critical_ck check (critical_candidates = 0 or critical_value_told)
);
-- The member limit (by the ender's account, across facilities), and the
-- facility limit with support's counts.
create index order_route_unable_endings_account_idx
  on ehr.order_route_unable_endings (ended_by_account_id, recorded_at);
create index order_route_unable_endings_facility_idx
  on ehr.order_route_unable_endings (receiving_facility_id, recorded_at);
-- Row-level security enabled and forced; four policies, as T8's (0088), so
-- that an UPDATE or DELETE by the owner, which is bound by them, reaches
-- the guard and is refused rather than matching no row; no grant to any
-- role, so only its owner o (C31, C32 and, through C3 and C4, the summary)
-- reads or writes it.
alter table ehr.order_route_unable_endings enable row level security;
alter table ehr.order_route_unable_endings force row level security;
create policy order_route_unable_endings_command_read on ehr.order_route_unable_endings
  for select using (true);
create policy order_route_unable_endings_command_insert on ehr.order_route_unable_endings
  for insert with check (true);
create policy order_route_unable_endings_command_update on ehr.order_route_unable_endings
  for update using (true) with check (true);
create policy order_route_unable_endings_command_delete on ehr.order_route_unable_endings
  for delete using (true);
revoke all on ehr.order_route_unable_endings from public;

-- T10's guard: append-only. Every UPDATE and DELETE is refused, by anyone.
create function ehr.guard_order_route_unable_ending()
returns trigger
language plpgsql
set search_path = pg_catalog, ehr, pg_temp
as $$
begin
  raise exception using errcode = '23514', message = 'ORDER_ROUTE_UNABLE_ENDING_IMMUTABLE';
end;
$$;
create trigger order_route_unable_endings_guard
  before update or delete on ehr.order_route_unable_endings
  for each row execute function ehr.guard_order_route_unable_ending();
revoke all on function ehr.guard_order_route_unable_ending() from public;

-- 2. The command and its wrappers.

-- C31. The receiving facility (B) ends an order it accepted and cannot
-- complete (D18-1, D18-10: one member who may receive the kind). Owner-only;
-- the Lab and Pharmacy wrappers below call it with their kind. In this
-- order, in the service's READ COMMITTED transaction; any refusal raises, so
-- nothing is stored:
--   1. the caller's transaction READ COMMITTED, else 25000
--      ORDER_ROUTE_CANNOT_COMPLETE_READ_COMMITTED_REQUIRED before anything is
--      read: the limits of step 11 are exact only because each statement
--      after the account's and the facility's locks reads a new snapshot,
--      which sees what an earlier holder committed while this one waited (as
--      C29); then the
--      actor: a direct-care staff session holding the kind's receive
--      permission at the session facility (42501);
--   2. the input (22023 ORDER_ROUTE_INVALID): the route and a version of at
--      least 1, the reason one of the kind's (D18-5), the key and digest
--      patterns;
--   3. the route-access control (55000);
--   4. a replay by the ender's key at this facility: the same route, kind
--      and digest answer replayed with the route as it is now and the first
--      ending's facts; anything else with that key IDEMPOTENCY_KEY_REUSED;
--   5. the route, unlocked: addressed here and of this kind (P0002);
--   6. the limits, exact (D18-7): a transaction advisory lock per ending
--      account, then one per receiving facility, both held to commit; only
--      this command takes them, always in that order and before any row
--      lock, so they add no deadlock;
--   7. the route: the application lock FOR SHARE, then FOR UPDATE;
--   8. the replay again, under the locks;
--   9. the state first: never accepted NOT_ACCEPTED; ended any way, or with
--      a report (T8), ALREADY_ENDED; completed (a result or dispensing went
--      back) ALREADY_RETURNED; accepted but lapsed, or that H7 no longer
--      allows writing, ALREADY_ENDED. So an open accepted route may be
--      reported (C25) or ended here, and once ended only C29 can report it;
--      a concurrent end by anyone answers by its state;
--  9b. then, on a lab request, a checked result (D18-15): a result of the
--      work item whose current version has a verification and no
--      invalidation waits to be released: RESULT_READY (B releases it, or
--      corrects it or marks it entered in error first); also with a stale
--      version;
--  9c. then the version (P0001 ORDER_ROUTE_VERSION_CONFLICT): only a
--      concurrent write that keeps the route open answers 412;
--  10. B's facts, read while the route still allows it (before the
--      ending; the Lab tables' row-level security decides, as for B's own
--      reads): on a lab request whether an accession exists, how many
--      specimens were collected and are still held (collected or received;
--      a rejected one is no sample B could keep or send on, so neither A
--      nor B is told about it), how many results exist on the work item,
--      how many current, not invalidated versions are flagged
--      critical_candidate (the Lab's own flag; Health ID makes no critical
--      result claim);
--  10b. one or more possibly critical values and
--      requested_critical_value_told not true: P0001
--      ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD (D18-15), before the limits:
--      over its limit B cannot end the order itself, so it must still be
--      told to phone A about the value before anyone else ends it;
--  11. at most 20 endings by this staff member's account (at any facility:
--      one account may hold memberships at several laboratories or
--      pharmacies, and a stolen one must not end 20 at each) and 50 at this
--      facility in the last 24 hours, else P0001
--      ORDER_ROUTE_CANNOT_COMPLETE_LIMIT whose DETAIL is the ISO time (UTC,
--      milliseconds, rounded up) from which another is possible (the later
--      of the two when both are reached);
--  12. the ending, through 0086's closer: accepted -> cancelled, ended_kind
--      'receiving_unable', side receiving, writes end now; reads end now as
--      well, unless B opened an accession on a lab request, when they end 7
--      days from now (D18-2); both only ever earlier than before;
--  13. the T10 row; its unique keys answer IDEMPOTENCY_KEY_REUSED and
--      ORDER_ROUTE_ALREADY_ENDED, never 23505;
--  14. a system row ehr.order-route.not-completed at A and at B, with the
--      patient, the reason and B's facts;
--  15. the patient's inbox notice ORDER_ROUTE_NOT_COMPLETED (D18-3; a no-op
--      for a patient without an active account);
--  16. the answer, with the patient for B's own audit row (never returned
--      over HTTP).
create function ehr.cannot_complete_order_route(
  requested_kind text,
  requested_route_id uuid,
  expected_version bigint,
  requested_reason text,
  requested_critical_value_told boolean,
  requested_idempotency_key text,
  requested_request_sha256 char(64)
) returns table (
  result text,
  ending_id uuid,
  route_row_version bigint,
  route_state text,
  effective_state text,
  ended_kind text,
  reason_code text,
  access_ends_at timestamptz,
  specimens_collected integer,
  results_recorded integer,
  critical_candidates integer,
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
  closed record;
  work_item uuid;
  accession_seen boolean := false;
  specimen_count integer := 0;
  result_count integer := 0;
  critical_count integer := 0;
  member_count integer;
  facility_count integer;
  member_free timestamptz;
  facility_free timestamptz;
  checked_at timestamptz;
  inserted_ending uuid;
  violated_constraint text;
begin
  -- 1. The caller's transaction, before anything is read, then the actor.
  if current_setting('transaction_isolation') is distinct from 'read committed' then
    raise exception using errcode = '25000', message = 'ORDER_ROUTE_CANNOT_COMPLETE_READ_COMMITTED_REQUIRED';
  end if;
  select * into actor from ehr.order_route_receiver(requested_kind);
  -- 2. The input.
  if requested_route_id is null or expected_version is null or expected_version < 1
     or not coalesce(case requested_kind
          when 'lab_request' then requested_reason in ('test_not_offered', 'supplies_unavailable',
            'equipment_unavailable', 'sample_unusable', 'sample_not_obtained', 'cannot_meet_priority',
            'patient_declined', 'patient_did_not_return', 'other')
          when 'prescription' then requested_reason in ('out_of_stock', 'medicine_unavailable',
            'needs_prescriber_review', 'controlled_requirements', 'cannot_meet_priority', 'patient_declined',
            'patient_did_not_return', 'other') end, false)
     or not coalesce(requested_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$', false)
     or not coalesce(requested_request_sha256 ~ '^[0-9a-f]{64}$', false) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  -- 3. The control.
  perform platform.require_control_enabled('cross_facility_route_access_enabled');
  -- 4. A replay (the same ender, facility and key).
  select ending.id, ending.route_id, ending.kind, ending.request_sha256, ending.reason_code,
         ending.specimens_collected, ending.results_recorded, ending.critical_candidates
    into prior
    from ehr.order_route_unable_endings ending
   where ending.ended_by_account_id = actor.actor_account_id
     and ending.receiving_facility_id = actor.actor_facility_id
     and ending.idempotency_key = requested_idempotency_key;
  if prior.id is not null then
    if prior.route_id <> requested_route_id or prior.kind <> requested_kind
       or prior.request_sha256 is distinct from requested_request_sha256 then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    select route.* into final_route from ehr.order_routes route where route.id = prior.route_id;
    return query select 'replayed'::text, prior.id, final_route.row_version, final_route.state,
      ehr.order_route_effective_state(final_route), final_route.ended_kind, prior.reason_code,
      final_route.access_ends_at, prior.specimens_collected, prior.results_recorded, prior.critical_candidates,
      final_route.patient_id;
    return;
  end if;
  -- 5. The route, unlocked: addressed here and of this kind.
  select route.* into peeked from ehr.order_routes route
   where route.id = requested_route_id and route.kind = requested_kind
     and route.receiving_facility_id = actor.actor_facility_id;
  if peeked.id is null then
    raise exception using errcode = 'P0002', message = 'ORDER_ROUTE_NOT_FOUND';
  end if;
  -- 6. The limits, exact: one ending at a time per ending account, then per
  -- receiving facility, from here to commit (always in this order).
  perform pg_advisory_xact_lock(hashtextextended('order-route-cannot-complete-account:'
    || actor.actor_account_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('order-route-cannot-complete:' || actor.actor_facility_id::text, 0));
  -- 7. The route, locked (the application lock FOR SHARE, the route FOR
  -- UPDATE).
  current_route := ehr.lock_receiving_route(requested_kind, requested_route_id, actor.actor_facility_id,
    actor.actor_organization_id);
  -- 8. The replay again, under the locks.
  select ending.id, ending.route_id, ending.kind, ending.request_sha256, ending.reason_code,
         ending.specimens_collected, ending.results_recorded, ending.critical_candidates
    into prior
    from ehr.order_route_unable_endings ending
   where ending.ended_by_account_id = actor.actor_account_id
     and ending.receiving_facility_id = actor.actor_facility_id
     and ending.idempotency_key = requested_idempotency_key;
  if prior.id is not null then
    if prior.route_id <> requested_route_id or prior.kind <> requested_kind
       or prior.request_sha256 is distinct from requested_request_sha256 then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query select 'replayed'::text, prior.id, current_route.row_version, current_route.state,
      ehr.order_route_effective_state(current_route), current_route.ended_kind, prior.reason_code,
      current_route.access_ends_at, prior.specimens_collected, prior.results_recorded, prior.critical_candidates,
      current_route.patient_id;
    return;
  end if;
  -- 9. The state first.
  if current_route.accepted_at is null then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_NOT_ACCEPTED';
  end if;
  if current_route.ended_at is not null
     or exists (select 1 from ehr.order_route_wrong_patient_reports report where report.route_id = current_route.id) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ALREADY_ENDED';
  end if;
  if current_route.state = 'completed' then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ALREADY_RETURNED';
  end if;
  if not (current_route.state = 'accepted' and clock_timestamp() < current_route.writes_end_at)
     or not ehr.order_route_allows(current_route.id, actor.actor_facility_id, 'write_records') then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ALREADY_ENDED';
  end if;
  -- 9b. A checked (verified, not invalidated) result waiting to be released
  -- on a lab request.
  if requested_kind = 'lab_request' and exists (
       select 1 from lab.results result_row
         join lab.test_executions execution on execution.id = result_row.execution_id
         join lab.work_item_requested_tests test on test.id = execution.requested_test_id
        where test.work_item_id = current_route.lab_work_item_id
          and exists (select 1 from lab.result_verifications verification
                       where verification.result_id = result_row.id
                         and verification.result_version = result_row.current_version)
          and not exists (select 1 from lab.result_invalidations invalidation
                           where invalidation.result_id = result_row.id
                             and invalidation.result_version = result_row.current_version)) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_RESULT_READY';
  end if;
  -- 9c. The version.
  if current_route.row_version <> expected_version then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_VERSION_CONFLICT';
  end if;
  -- 10. B's facts, read while the route still allows it.
  work_item := coalesce(current_route.lab_work_item_id, current_route.pharmacy_work_item_id);
  if requested_kind = 'lab_request' then
    select exists (select 1 from lab.accessions accession where accession.work_item_id = work_item)
      into accession_seen;
    select count(*)::integer into specimen_count
      from lab.specimens specimen join lab.accessions accession on accession.id = specimen.accession_id
     where accession.work_item_id = work_item and specimen.status in ('collected', 'received');
    select count(*)::integer into result_count
      from lab.results result_row
      join lab.test_executions execution on execution.id = result_row.execution_id
      join lab.work_item_requested_tests test on test.id = execution.requested_test_id
     where test.work_item_id = work_item;
    select count(*)::integer into critical_count
      from lab.results result_row
      join lab.result_revisions revision on revision.result_id = result_row.id
                                        and revision.version = result_row.current_version
      join lab.test_executions execution on execution.id = result_row.execution_id
      join lab.work_item_requested_tests test on test.id = execution.requested_test_id
     where test.work_item_id = work_item and revision.abnormal_flag = 'critical_candidate'
       and not exists (select 1 from lab.result_invalidations invalidation
                        where invalidation.result_id = result_row.id
                          and invalidation.result_version = result_row.current_version);
    -- 10b. A possibly critical value B has not said it told A about, asked
    -- before the limits.
    if critical_count > 0 and requested_critical_value_told is not true then
      raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD';
    end if;
  end if;
  -- 11. The limits, counted under the account's and the facility's locks:
  -- the member's by their account, across every facility.
  checked_at := clock_timestamp();
  select count(*)::integer into member_count from ehr.order_route_unable_endings ending
   where ending.ended_by_account_id = actor.actor_account_id
     and ending.recorded_at > checked_at - interval '24 hours';
  select count(*)::integer into facility_count from ehr.order_route_unable_endings ending
   where ending.receiving_facility_id = actor.actor_facility_id
     and ending.recorded_at > checked_at - interval '24 hours';
  if member_count >= 20 then
    -- Another is possible once all but 19 of the counted endings are more
    -- than 24 hours old.
    select ending.recorded_at + interval '24 hours' into member_free from ehr.order_route_unable_endings ending
     where ending.ended_by_account_id = actor.actor_account_id
       and ending.recorded_at > checked_at - interval '24 hours'
     order by ending.recorded_at, ending.id
     offset member_count - 20 limit 1;
  end if;
  if facility_count >= 50 then
    select ending.recorded_at + interval '24 hours' into facility_free from ehr.order_route_unable_endings ending
     where ending.receiving_facility_id = actor.actor_facility_id
       and ending.recorded_at > checked_at - interval '24 hours'
     order by ending.recorded_at, ending.id
     offset facility_count - 50 limit 1;
  end if;
  if member_free is not null or facility_free is not null then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT',
      detail = to_char(date_trunc('milliseconds', greatest(member_free, facility_free) + interval '999 microseconds')
                         at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  end if;
  -- 12. The ending through 0086's closer.
  select * into closed from ehr.close_order_route(current_route.id, 'receiving_unable', 'receiving',
    requested_kind = 'prescription' or not accession_seen);
  if closed.outcome is distinct from 'cancelled' then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ALREADY_ENDED';
  end if;
  -- 13. The ending's row; its keys answer by code, never 23505.
  begin
    insert into ehr.order_route_unable_endings as ending (route_id, kind, receiving_facility_id,
      receiving_organization_id, ordering_facility_id, reason_code, ended_by_account_id, ended_by_membership_id,
      accepted_by_membership_id, accepted_at, ended_by_acceptor, minutes_after_acceptance, accession_made,
      specimens_collected, results_recorded, critical_candidates, critical_value_told, idempotency_key,
      request_sha256, correlation_id)
    values (current_route.id, current_route.kind, current_route.receiving_facility_id,
      current_route.receiving_organization_id, current_route.ordering_facility_id, requested_reason,
      actor.actor_account_id, actor.actor_membership_id, current_route.accepted_by_membership_id,
      current_route.accepted_at, current_route.accepted_by_membership_id = actor.actor_membership_id,
      greatest(0, floor(extract(epoch from (clock_timestamp() - current_route.accepted_at)) / 60))::integer,
      accession_seen, specimen_count, result_count, critical_count, critical_count > 0,
      requested_idempotency_key, requested_request_sha256, platform.current_correlation_id())
    returning ending.id into inserted_ending;
  exception when unique_violation then
    get stacked diagnostics violated_constraint = constraint_name;
    if violated_constraint = 'order_route_unable_endings_idempotency_uq' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if violated_constraint = 'order_route_unable_endings_route_uq' then
      raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ALREADY_ENDED';
    end if;
    raise;
  end;
  -- 14. The system rows at A and at B, with the patient.
  perform ehr.order_route_system_audit(closed.closed, 'ordering', 'ehr.order-route.not-completed', true,
    jsonb_build_object('reason', requested_reason, 'specimensCollected', specimen_count,
      'resultsRecorded', result_count, 'criticalCandidates', critical_count, 'criticalValueTold', critical_count > 0));
  perform ehr.order_route_system_audit(closed.closed, 'receiving', 'ehr.order-route.not-completed', true,
    jsonb_build_object('reason', requested_reason, 'specimensCollected', specimen_count,
      'resultsRecorded', result_count, 'criticalCandidates', critical_count, 'criticalValueTold', critical_count > 0));
  -- 15. The patient's notice.
  perform ehr.order_route_notify_patient(closed.closed, 'ORDER_ROUTE_NOT_COMPLETED');
  -- 16. The answer.
  return query select 'ended'::text, inserted_ending, (closed.closed).row_version, (closed.closed).state,
    ehr.order_route_effective_state(closed.closed), (closed.closed).ended_kind, requested_reason,
    (closed.closed).access_ends_at, specimen_count, result_count, critical_count, current_route.patient_id;
end;
$$;

-- The Lab's and the Pharmacy's wrappers (SECURITY DEFINER, as item 3's).
-- The Pharmacy has no critical value to tell: it passes false.
create function lab.cannot_complete_order_route(requested_route_id uuid, expected_version bigint,
  requested_reason text, requested_critical_value_told boolean, requested_idempotency_key text,
  requested_request_sha256 char(64))
returns table (result text, ending_id uuid, route_row_version bigint, route_state text, effective_state text,
  ended_kind text, reason_code text, access_ends_at timestamptz, specimens_collected integer,
  results_recorded integer, critical_candidates integer, patient_id uuid)
language sql volatile security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select ended.result, ended.ending_id, ended.route_row_version, ended.route_state, ended.effective_state,
    ended.ended_kind, ended.reason_code, ended.access_ends_at, ended.specimens_collected, ended.results_recorded,
    ended.critical_candidates, ended.patient_id
    from ehr.cannot_complete_order_route('lab_request', requested_route_id, expected_version, requested_reason,
      requested_critical_value_told, requested_idempotency_key, requested_request_sha256) ended
$$;

create function pharmacy.cannot_complete_order_route(requested_route_id uuid, expected_version bigint,
  requested_reason text, requested_idempotency_key text, requested_request_sha256 char(64))
returns table (result text, ending_id uuid, route_row_version bigint, route_state text, effective_state text,
  ended_kind text, reason_code text, access_ends_at timestamptz, specimens_collected integer,
  results_recorded integer, critical_candidates integer, patient_id uuid)
language sql volatile security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select ended.result, ended.ending_id, ended.route_row_version, ended.route_state, ended.effective_state,
    ended.ended_kind, ended.reason_code, ended.access_ends_at, ended.specimens_collected, ended.results_recorded,
    ended.critical_candidates, ended.patient_id
    from ehr.cannot_complete_order_route('prescription', requested_route_id, expected_version, requested_reason,
      false, requested_idempotency_key, requested_request_sha256) ended
$$;
revoke all on function ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,char),
  lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,char),
  pharmacy.cannot_complete_order_route(uuid,bigint,text,text,char)
  from public;

-- 3. The ordering facility's summary of one route (0090 section 7),
-- replaced: 0090's body byte for byte, plus one key in its outer select
-- list, notCompleted: for a route ended 'receiving_unable' with no
-- wrong-patient report, {reason, sampleTaken, resultRecorded} from T10
-- (sampleTaken and resultRecorded null for a prescription); null otherwise
-- (once a report exists the earlier reason is not about the patient). The
-- guard is the route's own kind and 0090's report object, already computed,
-- so no other route reads T10's rows; every call still locks T10 and needs
-- SELECT on it as the role it runs as (section 5). 0090's attributes
-- otherwise.
create or replace function ehr.order_route_summary(route ehr.order_routes, resend_allowed boolean)
returns jsonb
language sql stable
set search_path = pg_catalog, ehr, identity, pg_temp
as $$
  select jsonb_build_object('id', route.id, 'reference', route.reference, 'kind', route.kind,
    'version', route.row_version, 'effectiveState', ehr.order_route_effective_state(route),
    'receivingFacility', jsonb_build_object('id', route.receiving_facility_id,
      'name', (select facility.name from identity.facilities facility where facility.id = route.receiving_facility_id),
      'available', facts.available),
    'createdAt', route.created_at, 'respondBy', route.respond_by, 'acceptedAt', route.accepted_at,
    'completedAt', route.completed_at, 'endedAt', route.ended_at, 'endedKind', route.ended_kind,
    'declineReason', route.decline_reason, 'acceptLocked', route.accept_locked_at is not null,
    'resendAllowed', resend_allowed,
    'wrongPatient', facts.answer,
    'correctableUntil', case when route.accepted_at is not null
                               and coalesce(route.ended_kind not in ('wrong_patient', 'receiving_released'), true)
                               and facts.answer is null
                               and clock_timestamp() < route.accepted_at + interval '4320 hours'
                               and (facts.available
                                 or exists (select 1 from identity.organizations organization
                                             where organization.id = route.receiving_organization_id
                                               and organization.active))
                             then route.accepted_at + interval '4320 hours' end,
    'notCompleted', case when route.ended_kind = 'receiving_unable' and facts.answer is null then
      (select jsonb_build_object('reason', unable.reason_code,
                                 'sampleTaken', case when unable.kind = 'lab_request' then unable.specimens_collected > 0 end,
                                 'resultRecorded', case when unable.kind = 'lab_request' then unable.results_recorded > 0 end)
         from ehr.order_route_unable_endings unable where unable.route_id = route.id) end)
    from (select identity.order_route_destination_eligible(route.receiving_facility_id, route.kind) as available,
                 (select jsonb_build_object('reportedAt', wrong_patient.reported_at, 'late', wrong_patient.late)
                    from ehr.order_route_wrong_patient_reports wrong_patient
                   where route.accepted_at is not null and wrong_patient.route_id = route.id) as answer
           offset 0) facts
$$;

-- 4. C32. Support's counts of a facility's "can't complete" endings in the
-- last 30 days (D18-11): last30Days; soonAfterAcceptance, within 60 minutes
-- of acceptance with no accession; afterSevenDays, at or after 10,080
-- minutes; laterReportedWrongPatient, those whose route then got a report
-- (T8; D18-12); byReason, each reason code with its count. Counts only. As
-- support's facility summary (C20, unchanged): support's platform actor
-- with platform.facility.read, P0002 ADMIN_FACILITY_NOT_FOUND. The Identity
-- service merges the answer into C20's.
create function identity.admin_order_route_not_completed(target_facility_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, identity, ehr, auth, platform, pg_temp
as $$
declare
  counted jsonb;
begin
  perform identity.order_route_platform_actor(array['platform.facility.read']);
  if target_facility_id is null
     or not exists (select 1 from identity.facilities facility where facility.id = target_facility_id) then
    raise exception using errcode = 'P0002', message = 'ADMIN_FACILITY_NOT_FOUND';
  end if;
  select jsonb_build_object('last30Days', count(*),
      'soonAfterAcceptance', count(*) filter (where ending.minutes_after_acceptance < 60
                                                and not ending.accession_made),
      'afterSevenDays', count(*) filter (where ending.minutes_after_acceptance >= 10080),
      'laterReportedWrongPatient', count(*) filter (where exists (
        select 1 from ehr.order_route_wrong_patient_reports report where report.route_id = ending.route_id)),
      'byReason', coalesce((select jsonb_object_agg(grouped.reason_code, grouped.reason_count)
                              from (select ending_reason.reason_code, count(*) as reason_count
                                      from ehr.order_route_unable_endings ending_reason
                                     where ending_reason.receiving_facility_id = target_facility_id
                                       and ending_reason.recorded_at > clock_timestamp() - interval '720 hours'
                                     group by ending_reason.reason_code) grouped), '{}'::jsonb))
    into counted
    from ehr.order_route_unable_endings ending
   where ending.receiving_facility_id = target_facility_id
     and ending.recorded_at > clock_timestamp() - interval '720 hours';
  return counted;
end;
$$;
revoke all on function identity.admin_order_route_not_completed(uuid) from public;

-- 5. Owners, read grants and post-checks. Every new object goes to o, the
-- closer's owner (a CREATE makes the applying role the owner, and a
-- SECURITY DEFINER wrapper created by a superuser runner would otherwise
-- run as the superuser). Each role that runs the summary may read T10:
-- every call of the summary locks T10 and checks SELECT on it at executor
-- start, for every route it summarizes, so the owners of C3 and C4 (which
-- call it as SECURITY DEFINER) and the summary's own owner are given SELECT
-- unless they already hold it. Then every attribute of the summary recorded
-- in section 0 must be as before, every new object must belong to o, and
-- each of those roles must be able to read T10, or the release stops.
do $$
declare
  o oid;
  signature text;
  reader record;
  mismatch text;
begin
  select proc.proowner into o from pg_proc proc
   where proc.oid = 'ehr.close_order_route(uuid,text,text,boolean)'::regprocedure;
  if (select relation.relowner from pg_class relation
       where relation.oid = 'ehr.order_route_unable_endings'::regclass) <> o then
    execute format('alter table ehr.order_route_unable_endings owner to %I', pg_get_userbyid(o));
  end if;
  foreach signature in array array['ehr.guard_order_route_unable_ending()',
      'ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,character)',
      'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)',
      'pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character)',
      'identity.admin_order_route_not_completed(uuid)'] loop
    if (select proc.proowner from pg_proc proc where proc.oid = signature::regprocedure) <> o then
      execute format('alter function %s owner to %I', signature, pg_get_userbyid(o));
    end if;
  end loop;
  for reader in select distinct proc.proowner as role_id from pg_proc proc
                 where proc.oid in ('ehr.list_order_routes_for_order(text,uuid,uuid)'::regprocedure,
                   'ehr.order_route_summaries(text,uuid,uuid[])'::regprocedure,
                   'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure)
                   and not exists (select 1 from pg_class relation
                                    where relation.oid = 'ehr.order_route_unable_endings'::regclass
                                      and pg_temp.order_route_0091_holds(proc.proowner, relation.relowner,
                                            relation.relacl, 'r', 'SELECT')) loop
    execute format('grant select on ehr.order_route_unable_endings to %I', pg_get_userbyid(reader.role_id));
  end loop;
  select string_agg(recorded.signature, ', ') into mismatch
    from pg_temp.order_route_unable_0091 recorded
    join pg_proc proc on proc.oid = recorded.signature::regprocedure
   where (proc.proowner, proc.prolang, proc.procost, proc.prorows, proc.provariadic, proc.prosupport, proc.prokind,
          proc.prosecdef, proc.proleakproof, proc.proisstrict, proc.proretset, proc.provolatile, proc.proparallel,
          proc.pronargs, proc.pronargdefaults, proc.prorettype, proc.proargtypes, proc.proallargtypes,
          proc.proargmodes, proc.proargnames, proc.proargdefaults::text, proc.protrftypes, proc.probin,
          proc.prosqlbody::text, proc.proconfig, proc.proacl)
         is distinct from
         (recorded.proowner, recorded.prolang, recorded.procost, recorded.prorows, recorded.provariadic,
          recorded.prosupport, recorded.prokind, recorded.prosecdef, recorded.proleakproof, recorded.proisstrict,
          recorded.proretset, recorded.provolatile, recorded.proparallel, recorded.pronargs, recorded.pronargdefaults,
          recorded.prorettype, recorded.proargtypes, recorded.proallargtypes, recorded.proargmodes,
          recorded.proargnames, recorded.proargdefaults, recorded.protrftypes, recorded.probin, recorded.prosqlbody,
          recorded.proconfig, recorded.proacl);
  if (select count(*) from pg_temp.order_route_unable_0091) <> 1 or mismatch is not null then
    raise exception '0091: the order summary differs from its owner or attributes before 0091: %',
      coalesce(mismatch, 'not recorded');
  end if;
  select string_agg(owned.what, ', ') into mismatch
    from (select proc.oid::regprocedure::text as what, proc.proowner as owner_id from pg_proc proc
           where proc.oid in ('ehr.guard_order_route_unable_ending()'::regprocedure,
             'ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,character)'::regprocedure,
             'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)'::regprocedure,
             'pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character)'::regprocedure,
             'identity.admin_order_route_not_completed(uuid)'::regprocedure)
          union all
          select relation.oid::regclass::text, relation.relowner from pg_class relation
           where relation.oid = 'ehr.order_route_unable_endings'::regclass) owned
   where owned.owner_id <> o;
  if mismatch is not null then
    raise exception '0091: a new object does not belong to the closer''s owner: %', mismatch;
  end if;
  select string_agg(format('%s (%s)', caller.what, pg_get_userbyid(caller.role_id)), ', ') into mismatch
    from (select proc.oid::regprocedure::text as what, proc.proowner as role_id from pg_proc proc
           where proc.oid in ('ehr.list_order_routes_for_order(text,uuid,uuid)'::regprocedure,
                              'ehr.order_route_summaries(text,uuid,uuid[])'::regprocedure,
                              'ehr.order_route_summary(ehr.order_routes,boolean)'::regprocedure)
          union all select 'o (H14)', o) caller
    cross join pg_class relation
   where relation.oid = 'ehr.order_route_unable_endings'::regclass
     and not pg_temp.order_route_0091_holds(caller.role_id, relation.relowner, relation.relacl, 'r', 'SELECT');
  if mismatch is not null then
    raise exception '0091: a role that runs the order summary or the command may not read the endings table: %',
      mismatch;
  end if;
end
$$;
drop function pg_temp.order_route_0091_holds(oid,oid,aclitem[],"char",text);

-- 6. Grants (as 0088, 0089 and 0090; runtime-grants.sql carries the same).
-- The login roles (hid_lab_api_runtime, hid_pharmacy_api_runtime,
-- hid_identity_api_runtime) inherit their group's. T10, its guard and the
-- shared command are granted to no role; the summary keeps its ACL (CREATE
-- OR REPLACE).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_lab_runtime') then
    grant execute on function lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,char)
      to hid_lab_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    grant execute on function pharmacy.cannot_complete_order_route(uuid,bigint,text,text,char)
      to hid_pharmacy_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.admin_order_route_not_completed(uuid) to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,char),
      pharmacy.cannot_complete_order_route(uuid,bigint,text,text,char)
      to hid_schema_test_runtime;
  end if;
end
$$;

-- 7. Last, under one ACCESS EXCLUSIVE lock on ehr.order_routes and T8
-- together, taken NOWAIT and held to commit (see Locks): the three CHECKs
-- admit 'receiving_unable', and T10's key to the route. The form follows
-- the route table's size (see The CHECKs' form).
do $$
declare
  attempt integer := 0;
  heap_bytes bigint;
  form text;
begin
  loop
    attempt := attempt + 1;
    begin
      -- Both or neither: a refused attempt's subtransaction releases what it
      -- took.
      lock table ehr.order_routes, ehr.order_route_wrong_patient_reports in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0091: ehr.order_routes or the report table stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
  heap_bytes := pg_relation_size('ehr.order_routes'::regclass, 'main');
  form := case when heap_bytes <= 117145600 then '' else ' not valid' end;
  raise notice '0091: ehr.order_routes'' heap is % bytes (limit 117145600, about 200,000 routes): the CHECKs are added %',
    heap_bytes, case when form = '' then 'validated' else 'NOT VALID, without VALIDATE' end;
  execute $alter$alter table ehr.order_routes
  drop constraint order_routes_ended_kind_check,
  add constraint order_routes_ended_kind_check check (ended_kind is null or ended_kind in ('orderer', 'patient',
    'order_changed', 'entered_in_error', 'receiving_released', 'ordering_released', 'support', 'order_in_work',
    'not_accepted', 'wrong_patient', 'receiving_unable'))$alter$ || form || $alter$,
  drop constraint order_routes_end_ck,
  add constraint order_routes_end_ck check (
    (ended_at is null) = (ended_kind is null)
    and (ended_by_account_id is null or ended_at is not null)
    and coalesce(case state
      when 'withdrawn' then ended_kind in ('orderer', 'patient', 'order_changed', 'entered_in_error',
        'receiving_released', 'ordering_released', 'support', 'order_in_work')
      when 'expired' then ended_kind = 'not_accepted'
      when 'cancelled' then ended_kind in ('order_changed', 'entered_in_error', 'receiving_released',
        'ordering_released', 'support', 'wrong_patient', 'receiving_unable')
      when 'completed' then ended_kind is null or ended_kind in ('entered_in_error', 'receiving_released',
        'ordering_released', 'support', 'wrong_patient')
      else ended_kind is null end, false))$alter$ || form;
  execute $alter$alter table ehr.order_route_wrong_patient_reports
  drop constraint order_route_wrong_patient_reports_late_ck,
  add constraint order_route_wrong_patient_reports_late_ck check (
    (not late and ended_kind_before is null and discovered_by is null and discovered_on is null
      and state_before in ('accepted', 'completed'))
    or (late and coalesce(discovered_by in ('patient', 'ordering_facility', 'own_check', 'support', 'other'), false)
      and discovered_on is not null
      and (ended_kind_before is null or ended_kind_before in ('order_changed', 'entered_in_error',
        'receiving_released', 'ordering_released', 'support', 'receiving_unable'))
      and (state_before <> 'cancelled' or ended_kind_before is not null)))$alter$ || form;
  alter table ehr.order_route_unable_endings
    add constraint order_route_unable_endings_route_id_fkey foreign key (route_id) references ehr.order_routes (id)
      on delete restrict;
end
$$;
