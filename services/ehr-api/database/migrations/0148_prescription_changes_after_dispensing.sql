-- 0148 Pharmacy is told when a prescription changes after dispensing (Q132 A,
-- lane D). Owner decision Q132 A, 19 November 2026, and the
-- coordinator's decision 1 on hid-system#258, 20 November 2026: a notice on
-- the dispensing pharmacy's own work item, facts only, with no
-- acknowledgement and no change on the prescriber's side. The planned
-- contract's section "Q132 A: changed after dispensing" is what this file
-- builds. Base: Release B (0001-0146 applied and signed; staging 926b1c58),
-- where 0144 (ORD-4) is live; first written on ORD-4's branch over Release A.
-- The number is provisional and given in merge order; no migration number
-- appears inside a function body, a policy or a trigger, so renumbering
-- leaves every md5. Section 0 checks for 0001-0137 (0137's markers), which
-- is all this file needs: 0138-0146 changed no body, trigger, policy or
-- column it pins or reads (0143 adds a policy on ehr.prescriptions, but no
-- query of this file reads that table). The declaration is signed separately.
--
-- THE GAP. 0133 D8 tells a pharmacy when a prescription it has received
-- changes before it is dispensed (the item reads withdrawn). After the first
-- dispensing nothing does. A prescriber may put the prescription on hold,
-- stop it, mark it entered in error or change the dose, and the pharmacy that
-- dispensed it, where the patient comes back with questions and for the next
-- supply, still sees "Dispensed" and nothing else. ehr-api audits each change
-- (ehr.prescription.update) and versions it (ehr.record_versions), and 0086
-- tells a receiving facility's route, but no pharmacy work item ever shows it.
--
-- WHAT IT DOES
-- C1 pharmacy.prescription_changes_after_dispensing: one row per prescription
--    version after a work item's first dispensing: the work item, its
--    facility, the prescription's row_version, the status before and after,
--    a SHA-256 fingerprint of the content before and after, and the time.
--    Facts only: no actor, no reason, no prescription id, no field value.
--    Key (work_item_id, prescription_version), which is the reader's index
--    and makes the recorder idempotent per version. No CHECK and no foreign
--    key, so the trigger that writes it can never fail on real data (a
--    status list copied here would make a later status fail every change)
--    and creating it locks no table its ids name. Append-only:
--    prescription_changes_after_dispensing_immutable calls 0023's
--    pharmacy.reject_immutable_evidence() before every UPDATE or DELETE.
--    Row-level security enabled, not forced, no policy and no grant: the
--    owner's only, as 0133's sends and claims.
-- C2 pharmacy.prescription_change_after_dispensing(), the function of C4
--    (plpgsql, VOLATILE, SECURITY DEFINER, search_path pg_catalog, pg_temp;
--    owner: the work items' and the dispensing validator's; executed by no
--    role). One statement: for each claim of the changed prescription whose
--    dispensed_at is set (0133's claims, one per work item, own or
--    route-backed; dispensed_at is the first dispensing and stays after a
--    reversal), insert a C1 row, on conflict nothing. It reads only the
--    claims and writes only C1, both the owner's with row-level security not
--    forced, so nothing is filtered in the prescriber's session under a
--    superuser owner or production's NOSUPERUSER NOBYPASSRLS owner alike. It
--    never reads pharmacy.work_items or pharmacy.dispensings (forced). It
--    never refuses the change it follows. The fingerprints are SHA-256 (not
--    MD5, which FIPS mode refuses) of the row as jsonb without status,
--    row_version, created_at, updated_at and null-valued keys, computed only
--    for a matching claim. They name no column, so a later DROP or RENAME
--    COLUMN cannot break prescription writes. Maintenance rule: a later
--    column that is NOT NULL or has a default changes every later
--    fingerprint, so the first resume after that migration reads 'edited'
--    (the safe side) unless that migration replaces C2 with the column added
--    to the keys left out; a later timestamptz or interval column must be
--    left out (its jsonb text follows the session's TimeZone); a later
--    nullable column changes nothing. A later ALTER COLUMN TYPE that changes
--    a column's jsonb text (numeric(12,4) to numeric(14,6) turns 1.0000 into
--    1.000000), or a RENAME or DROP of a column that holds values, also
--    changes every later fingerprint, so the first resume after it reads
--    'edited' too (the safe side). The time is clock_timestamp() taken in
--    C2, never the version's updated_at (see "after dispensing" below).
-- C3 pharmacy.work_item_changes_after_dispensing(uuid[]) (plpgsql, STABLE,
--    SECURITY DEFINER, same owner; EXECUTE to hid_pharmacy_runtime and
--    hid_schema_test_runtime only): for at most 200 requested work items the
--    session may read, the latest shown change, its time and how many shown
--    changes there were. "May read" is the session's facility,
--    pharmacy.work-item.read, and pharmacy.work_items' two read policies
--    repeated as conditions (the consent or route test, and 0133's own-work
--    half for own items), so a superuser owner, who bypasses row-level
--    security, and a NOBYPASSRLS owner answer alike. It starts from C1's
--    rows (usually none), so the policy tests run only for items with a
--    recorded row. 201 ids or a null array: 22023
--    WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID.
-- C4 prescriptions_pharmacy_change_after_dispensing: AFTER UPDATE FOR EACH
--    ROW on ehr.prescriptions, origin mode (as prescriptions_versioned and
--    0133 D8's), when (old.status in ('active', 'on_hold')), running C2.
--    Drafts (never dispensed; ehr.send_order_route's activation included)
--    and every change after completed, cancelled or entered in error are not
--    recorded (never shown, so a later edit cannot hide a stop); nor is a
--    change in replica mode, which writes no ehr.record_versions row either.
--    Its name sorts after 0086's prescriptions_order_routes_sync and 0133
--    D8's trigger, so it fires after the route sync has waited for any
--    dispensing in flight (AFTER triggers of one event fire in name order).
--
-- What is shown (the clinical owner's rule, Ola, 20 November 2026). The
-- labels are set by C3 from the recorded facts, never at write time, so a
-- later rule (a replaced C3) applies to rows already recorded and an edit
-- made during a hold can be shown at the resume. For each recorded row, the
-- first of these that holds: entered_in_error, cancelled, on_hold (a new
-- status; a stop always wins over an edit sent with it); a resume from hold
-- is 'resumed' when the content is again what was dispensed (the first
-- recorded row's prior content) and 'edited' otherwise; an active
-- prescription whose content changed is 'edited'. Anything else is neither
-- shown nor counted: completed, a change of nothing, an edit while it stays
-- on hold, a status this file does not know. change and changedAt are the
-- latest shown row's (highest prescription_version); changeCount counts the
-- item's shown rows. What matters to the pharmacist is whether what the
-- patient holds still matches the prescription.
--
-- "After dispensing" is commit order, enforced by locks, not a clock rule.
-- Own items: 0101 reads the prescription FOR SHARE until the dispensing
-- commits, and ehr-api's PATCH takes it FOR UPDATE first, so a change first
-- makes the dispensing refuse and a change after it waits; C2's statement,
-- VOLATILE under READ COMMITTED, then sees the committed claim.
-- Route-backed items: the PATCH does not wait on the prescription, but
-- prescriptions_order_routes_sync locks the routes FOR UPDATE, which the
-- dispensing holds, and C4 fires after it (its name), so C2 runs after that
-- wait. A clock rule would be wrong: the version and updated_at are stamped
-- before the wait. Limit: a prescription UPDATE in a REPEATABLE READ or
-- SERIALIZABLE transaction would see its older snapshot; no path does this
-- after a dispensing (the PATCH is READ COMMITTED; ehr.send_order_route
-- activates drafts only, which the WHEN skips). pharmacy-api's list and read
-- run READ COMMITTED; its hand-off replay runs SERIALIZABLE, but C1's rows
-- are written by READ COMMITTED transactions, and PostgreSQL tracks
-- read-write conflicts only between SERIALIZABLE ones, so C1 causes no
-- 40001.
--
-- What it does not do. No backfill: only changes made after this file runs
-- are recorded, for items dispensed at any time (0133's backfill gave every
-- work item its claim with dispensed_at). No acknowledgement, no
-- prescriber-side change, no audit or outbox row (each change is already
-- audited where it is made), no change to the progress call or to ehr-api.
-- No existing table, function, policy, CHECK or row-level security setting
-- changes. Stated limits (the planned contract and the interface contract
-- say them too): an item from another facility shows the notice only while
-- its route lets the receiving pharmacy read the item (0086: at most 14 days
-- after the dispensing and 45 after acceptance), and an entry in error
-- closes the route at once, so a receiving pharmacist without a consent
-- grant does not see it (a question for the owner through the coordinator);
-- a changed item keeps its place in the list (Q123 A); a reversed
-- dispensing keeps its notice.
--
-- ORD-12 (refills) coupling: section 0 pins
-- pharmacy.claim_prescription_dispensing(), which sets dispensed_at once and
-- refuses a second fill today. ORD-12 (0152, provisional) must replace it,
-- keeping dispensed_at as the first fill and never clearing it, so "after
-- dispensing" means "after the first fill" and 'resumed' compares with the
-- first fill's content. ORD-12 merges after this file, or re-pins it. Its
-- refills column follows C2's maintenance rule: a NOT NULL or defaulted
-- refills column must be left out of the fingerprint (by replacing C2); a
-- nullable one needs nothing. ORD-12 adds refills_allowed as a nullable
-- column, so C2 stays as it is.
--
-- 0. Preconditions (catalog reads only; 55000, or 42501 for e and f; nothing
--    applied): a. 0001-0137 applied (0144's markers); b. this file not
--    applied (no table, function of any signature or trigger of its names);
--    c. every column the new bodies and checks read, by name and type;
--    d. the bodies relied on, by md5; d2. 0133 D14's two claim triggers,
--    enabled always; e. one owner of the work items, ehr.prescriptions,
--    0133's claims, the dispensing validator and the work items' policy
--    functions C3 calls, who owns or may execute the immutability function
--    and the permission test; f. the applier is that owner, or inherits it
--    and may SET ROLE to it, and that owner may create in pharmacy and use
--    the schemas the bodies name; g. 0133 D5's premise (no hid_ role is a
--    member of the dispensing validator's owner); h. row-level security as
--    0133 left it. Every owner-run SECURITY DEFINER function's catalog row is
--    kept for section 6.
-- 1. Locks (below).
-- 1b. Under section 1's locks, what prints a CHECK, a trigger or a policy
--    (pg_get_expr and pg_get_triggerdef open the table they print for):
--    0133 D14's claims CHECK (a dispensed claim is never released); the
--    claims' two triggers exactly; 0086's route sync exactly, and no trigger
--    on ehr.prescriptions that sorts after C4's name; pharmacy.work_items'
--    read policies exactly the two C3 repeats, no restrictive one.
-- 2. Act as the owner for the rest of the transaction.
-- 3. C1, C2, C3. 4. C4. 5. Grants and comments (here and in
--    runtime-grants.sql; no role holds any privilege on C1).
-- 6. Post-checks (55000, nothing written): C2 and C3 exactly (md5 C2
--    f61173d77be391a9e9c96db494827e82, C3 f034ea13a60ffb4314b442d50a156e96),
--    their owners, attributes and EXECUTE grants; C1 exactly; C4 exactly and
--    the AFTER UPDATE triggers' order; 0133 D5 unchanged (no new body names
--    ehr.prescriptions; no other owner-run definer made, replaced or
--    dropped); probes P3 (the reader's 201-id and null refusals) and P4 (no
--    row without a session; every query of the reader planned and run with
--    a session facility), each undone; nothing recorded.
--
-- Locks. Section 1, one DO block, each attempt in its own subtransaction:
-- ACCESS SHARE NOWAIT on pharmacy.work_items, 0133's claims and the nine
-- account, membership and role tables C3's permission test and own-work half
-- plan on (auth.accounts, identity.staff_facility_memberships,
-- auth.account_roles, auth.roles, auth.role_permissions, auth.permissions,
-- identity.staff, identity.facilities, identity.organizations); then each
-- of their indexes, by planning a query on each table under a 10 ms
-- lock_timeout (the runner's restored after); then, last, SHARE ROW
-- EXCLUSIVE NOWAIT on ehr.prescriptions (what CREATE TRIGGER needs; no
-- policy is added, so not ACCESS EXCLUSIVE), so an attempt that waits never
-- holds it. A busy table or index fails the attempt at once and its
-- subtransaction releases what it took; the attempt is made again every
-- 100 ms for at most 5 seconds, then 55P03, nothing applied. When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run; its own ledger table
-- aside), one attempt and no sleep: 55P03 at once, nothing applied. That
-- list is every lock pg_locks shows before commit, identical with a
-- superuser applier and with a NOSUPERUSER NOBYPASSRLS applier.
-- From section 1 to commit every prescription INSERT and UPDATE waits
-- (ehr-api's create and PATCH, ehr.send_order_route's activation, the
-- owner-only installs). Reads, FOR UPDATE and FOR SHARE (0101's dispensing
-- check, ORD-4's validator) are not blocked, and nothing fails. An
-- autovacuum or ANALYZE of ehr.prescriptions (SHARE UPDATE EXCLUSIVE) fails
-- the NOWAIT, so a long one stops the file after 5 seconds, nothing applied.
-- In the dry run the lock lasts until the dry run ends; an earlier file's
-- strong locks make this file take one attempt.
-- Measured on throwaway PostgreSQL 16 on Release B (0001-0146 and its
-- runtime roles, staging 926b1c58) with 20,000 prescriptions, work items and
-- claims (fictional data), ten runs with a superuser applier and ten with a
-- NOSUPERUSER NOBYPASSRLS applier: the file takes 32-60 ms to commit; the
-- hold, from the SHARE ROW EXCLUSIVE to commit, is 15-31 ms in all 20 runs
-- (target under 50 ms, so the lock stays in section 1; no late-lock fallback
-- is used).
-- Measured earlier on 0001-0137 and 0144 (ORD-4's branch over Release A),
-- with the same data and both appliers (the file then took 44-78 ms and the
-- hold 20-26 ms in all 16 runs):
--   a blocker held by another session on each of section 1's eleven tables
--   and 41 indexes, and a writer and a SHARE UPDATE EXCLUSIVE holder (as
--   autovacuum) on ehr.prescriptions: each time the file stops with section
--   1's 55P03 after 4.98-5.53 seconds, nothing applied, while a third
--   session reads and updates prescriptions every 50 ms under a 200 ms
--   lock_timeout and none of its 105-117 rounds fails (slowest round 34 ms,
--   but for one of 164 ms, which three reruns of that case put at 3-4 ms);
--   ACCESS EXCLUSIVE held by another session on every other application
--   table of 0001-0137 and 0144 (197 tables): the file applies in 47 ms and
--   no lock request of its own waits;
--   a prescription UPDATE takes 0.28 ms more on average with C4 in place
--   (C2 itself: 0.11 ms when a dispensed claim matches, 0.03 ms otherwise);
--   the reader, under the NOBYPASSRLS owner, answers 200 ids in 6.7 ms
--   (median) when none has a recorded row, and in 366 ms when all 200 have
--   one (its policy tests run per recorded item; a real page has few).
--
-- Old services on this schema. Release B's ehr-api (the live one): each
-- change of an active or on-hold prescription fires C4, and C2 finds no
-- dispensed claim (one index probe) or records a row; nothing ehr-api reads
-- or answers changes (its PATCH audit, ownPharmacy.withdraw and 0133 D8 are
-- unchanged). Release B's pharmacy-api (ORD-4's included) calls nothing new,
-- and this file replaces no function it calls; changes recorded meanwhile
-- show once the new pharmacy-api serves.
--
-- New services on a schema without this file. The new pharmacy-api reads
-- 42883 (or 42P01 on a half-undone schema) from C3 and answers the work item
-- without changedAfterDispensing, with no warning. ehr-api has no Q132
-- change. Either image may go first or be rolled back alone.
--
-- Undo (by hand only; each step leaves every image working):
-- 1. set lock_timeout = '100ms'; drop trigger
--    prescriptions_pharmacy_change_after_dispensing on ehr.prescriptions;
--    repeated until it succeeds. DROP TRIGGER takes ACCESS EXCLUSIVE on
--    ehr.prescriptions, so while it waits every read of the table queues
--    behind it, 0101's FOR SHARE included; the 100 ms bound limits that. If
--    it keeps timing out: alter table ehr.prescriptions disable trigger
--    prescriptions_pharmacy_change_after_dispensing; (SHARE ROW EXCLUSIVE:
--    writes wait, reads do not), then steps 2 and 4, and drop the trigger
--    and C2 later in a quiet window.
-- 2. drop function pharmacy.work_item_changes_after_dispensing(uuid[]);
--    (pharmacy-api reads 42883: no field).
-- 3. drop function pharmacy.prescription_change_after_dispensing();
-- 4. drop table pharmacy.prescription_changes_after_dispensing; (the notices
--    go with it; export them first if the owner wants them).
-- The trigger comes first: plpgsql records no dependency on the table, so
-- with the table dropped under a live trigger every change of an active or
-- on-hold prescription would fail with 42P01 for every image. This undo is
-- independent of 0144's and comes before any step of 0133's (C3 calls 0133's
-- own-work half; C2 reads 0133's claims). The ledger row stays; precondition
-- b refuses a second apply; a later migration brings the objects back.

-- 0. Preconditions.
do $$
declare
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  owner_oid oid;
  validator_owner oid;
begin
  -- a. 0001-0137 applied: 0133's tables and readers, 0134's install, 0135's
  -- waiting list, 0137's NIN checks and its begin command, read from the
  -- catalog (0136 changes role rows only; the runner applies it before 0137).
  -- The same markers as 0144's; nothing of 0144 is needed.
  if (select count(*) from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
       where relation.relkind = 'r'
         and (namespace.nspname, relation.relname) in (('pharmacy', 'own_prescription_sends'),
               ('pharmacy', 'prescription_item_claims'), ('identity', 'own_work_patients'), ('ehr', 'visit_queue'),
               ('identity', 'qoreid_nin_checks'))) <> 5
     or (select count(distinct proc.oid) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where (namespace.nspname, proc.proname, pg_catalog.oidvectortypes(proc.proargtypes)) in (
                  ('pharmacy', 'own_work_item_states', 'uuid[]'),
                  ('identity', 'facility_work_session_membership', 'text'),
                  ('identity', 'pharmacy_work_patient_allows', 'uuid, uuid, uuid, text'),
                  ('identity', 'sealed_qa_hospital_work_staff_install', ''),
                  ('identity', 'begin_qoreid_nin_check', 'character, character, boolean, text, uuid, integer'))) <> 5 then
    raise exception using errcode = '55000', message = '0148: 0001-0137 must be applied first';
  end if;
  -- b. Not applied yet: no table, function (any signature) or trigger of
  -- this file's names.
  if exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
              where namespace.nspname = 'pharmacy' and relation.relname = 'prescription_changes_after_dispensing')
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'pharmacy'
                   and proc.proname in ('prescription_change_after_dispensing', 'work_item_changes_after_dispensing'))
     or exists (select 1 from pg_trigger trigger_row
                 where not trigger_row.tgisinternal
                   and trigger_row.tgname in ('prescriptions_pharmacy_change_after_dispensing',
                         'prescription_changes_after_dispensing_immutable')) then
    raise exception using errcode = '55000', message = '0148: already applied';
  end if;
  -- c. Every column the new bodies and checks read, by name and type: the
  -- prescription's id, status and version, and the two times C2's
  -- fingerprint leaves out (a renamed one would enter every fingerprint);
  -- the claims C2 reads; the work items C3 reads. The decision is an EXISTS
  -- over the absent columns (never null); the list only names them.
  with expected(schema_name, relation_name, column_names) as (values
         ('ehr', 'prescriptions', array['id uuid', 'status text', 'row_version bigint',
           'created_at timestamp with time zone', 'updated_at timestamp with time zone']),
         ('pharmacy', 'prescription_item_claims', array['work_item_id uuid', 'prescription_id uuid', 'facility_id uuid',
           'dispensed_at timestamp with time zone', 'released_at timestamp with time zone']),
         ('pharmacy', 'work_items', array['id uuid', 'patient_id uuid', 'facility_id uuid', 'order_route_id uuid'])),
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
      message = format('0148: a column this migration relies on is missing or of another type: %s', missing);
  end if;
  -- C2's one probe per prescription change: a valid btree index on the
  -- claims whose first key is prescription_id, over every claim (not
  -- partial: 0133's live-claim index leaves out released claims and the
  -- planner cannot prove a dispensed claim is never released).
  if not exists (select 1 from pg_index index_row
                   join pg_class index_relation on index_relation.oid = index_row.indexrelid
                   join pg_am access_method on access_method.oid = index_relation.relam
                   join pg_class relation on relation.oid = index_row.indrelid
                   join pg_namespace namespace on namespace.oid = relation.relnamespace
                   join pg_attribute attribute_row
                     on attribute_row.attrelid = relation.oid and attribute_row.attnum = index_row.indkey[0]
                  where namespace.nspname = 'pharmacy' and relation.relname = 'prescription_item_claims'
                    and access_method.amname = 'btree' and attribute_row.attname = 'prescription_id'
                    and index_row.indisvalid and index_row.indisready and index_row.indpred is null) then
    raise exception using errcode = '55000',
      message = '0148: pharmacy.prescription_item_claims has no btree index whose first key is prescription_id';
  end if;
  -- d. The bodies relied on (md5 of pg_proc.prosrc). A function missing at
  -- its signature counts as a mismatch.
  with expected(schema_name, proc_name, argument_types, digests) as (values
         -- 0133 D14: every work item claims its prescription, and the first
         -- dispensing sets dispensed_at (what "dispensed" means to C2).
         ('pharmacy', 'claim_prescription_work_item', '', array['c60a03a6aed78900827fc4c7654dd593']),
         ('pharmacy', 'claim_prescription_dispensing', '', array['2c7f20d7c0df7c582bccc0291f452fdd']),
         -- 0086: the route sync locks a route-backed item's routes FOR
         -- UPDATE, which a dispensing at the receiving pharmacy holds; C4
         -- fires after it.
         ('ehr', 'sync_order_routes_on_order_change', '', array['8ce6b42450cc06fc02fec8d1cf63af41']),
         -- 0101: a dispensing reads the prescription FOR SHARE and the route
         -- FOR UPDATE until it commits.
         ('pharmacy', 'validate_dispensing', '', array['17f7e8897bd2ab240332e4d2c9f757b7']),
         -- The version bump C2 records (0125 accepts both bodies).
         ('ehr', 'capture_record_version', '',
           array['70daa16f05bb3ec28f05292e6358a702', 'cae99883d00e70ab1d20ed6fbc97ad7b']),
         -- C3 repeats pharmacy.work_items' two read policies: 0086's consent
         -- or order-route test and 0133's own-work halves.
         ('pharmacy', 'work_item_allows', 'uuid, uuid, uuid, text', array['b710e0c6b66ce87c8c4a059ad435b774']),
         ('ehr', 'order_route_allows', 'uuid, uuid, text', array['b80c2df6c380f7c7e20d166da94e56d2']),
         ('identity', 'facility_work_session_membership', 'text', array['36de1f00307dd5602972253b23f22f9f']),
         ('identity', 'pharmacy_work_patient_allows', 'uuid, uuid, uuid, text',
           array['cfc636db0a3457b5661adde458d4d07a']),
         ('identity', 'has_active_consent_grant', 'uuid, text, uuid, uuid, text, text, timestamp with time zone',
           array['732d11892dd4e27e1ff9093ae3b7de5a']),
         -- C3's second guard, and the table's immutability.
         ('auth', 'membership_has_permission', 'text, uuid, uuid, text', array['65e3eaff93fe729fd5c5b986b80c9dd6']),
         ('pharmacy', 'reject_immutable_evidence', '', array['ff07f56046c29ad4efa9d36ad7fcc549']),
         -- The six session readers.
         ('platform', 'current_facility_id', '', array['c4a7c2989e83d9cedbf1f7b785a5aaed']),
         ('platform', 'current_account_id', '', array['b715ffe72856836d13ab16656fa6e94a']),
         ('platform', 'current_membership_id', '', array['641989704fea95f885fbc38c6feb5aa5']),
         ('platform', 'current_actor_subject', '', array['cf14c2d4a16d44a79ea9dbef9dc79c2b']),
         ('platform', 'current_purpose_of_use', '', array['74f7f2ea17dbbe825f7cfe543ad3e83f']),
         ('platform', 'current_correlation_id', '', array['48d3bf187101d33bfda51dac829aa223'])),
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
               and md5(proc.prosrc) = any(expected.digests)))
  select exists (select 1 from differing),
         (select string_agg(format('%s.%s(%s) md5 %s', differing.schema_name, differing.proc_name,
                   differing.argument_types, coalesce(differing.found, 'none (missing)')), '; ') from differing)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0148: a function this migration relies on differs from 0001-0137: %s', missing);
  end if;
  -- d2. 0133 D14's two claim triggers, enabled always (so a replica-mode
  -- work item or dispensing is claimed too), on the tables and functions
  -- 0133 gave them (catalog only; 1b compares their definitions).
  if (select count(*) from pg_trigger trigger_row
        join pg_class relation on relation.oid = trigger_row.tgrelid
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        join pg_proc proc on proc.oid = trigger_row.tgfoid
        join pg_namespace proc_namespace on proc_namespace.oid = proc.pronamespace
       where not trigger_row.tgisinternal and trigger_row.tgenabled = 'A' and namespace.nspname = 'pharmacy'
         and proc_namespace.nspname = 'pharmacy'
         and ((trigger_row.tgname = 'work_items_claim_prescription' and relation.relname = 'work_items'
               and proc.proname = 'claim_prescription_work_item')
           or (trigger_row.tgname = 'dispensings_claim_prescription' and relation.relname = 'dispensings'
               and proc.proname = 'claim_prescription_dispensing'))) <> 2 then
    raise exception using errcode = '55000',
      message = '0148: 0133''s claim triggers work_items_claim_prescription and dispensings_claim_prescription are '
        || 'missing or not enabled always';
  end if;
  -- e. One owner: pharmacy.work_items' owns ehr.prescriptions (CREATE
  -- TRIGGER needs it), 0133's claims (C2 reads them unfiltered only as their
  -- owner), pharmacy.validate_dispensing() (so both new SECURITY DEFINER
  -- functions are the role 0133 D5's ehr.prescriptions policies name, which
  -- precondition g keeps from every hid_ role), the work items' policy
  -- functions C3 calls, and owns or may execute the immutability function
  -- (the new table's trigger) and the permission test (C3's guard).
  owner_oid := (select relation.relowner from pg_class relation
                  join pg_namespace namespace on namespace.oid = relation.relnamespace
                 where namespace.nspname = 'pharmacy' and relation.relname = 'work_items' and relation.relkind = 'r');
  validator_owner := (select proc.proowner from pg_proc proc where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure);
  with expected_tables(schema_name, relation_name) as (values
         ('ehr', 'prescriptions'), ('pharmacy', 'prescription_item_claims')),
       expected_functions(schema_name, proc_name, argument_types) as (values
         ('pharmacy', 'validate_dispensing', ''), ('pharmacy', 'work_item_allows', 'uuid, uuid, uuid, text'),
         ('identity', 'facility_work_session_membership', 'text'),
         ('identity', 'pharmacy_work_patient_allows', 'uuid, uuid, uuid, text')),
       executed_functions(schema_name, proc_name, argument_types) as (values
         ('pharmacy', 'reject_immutable_evidence', ''), ('auth', 'membership_has_permission', 'text, uuid, uuid, text')),
       foreign_owned as (
         select format('%s.%s', expected_tables.schema_name, expected_tables.relation_name) as what
           from expected_tables
          where not exists (select 1 from pg_class relation
                              join pg_namespace namespace on namespace.oid = relation.relnamespace
                             where namespace.nspname = expected_tables.schema_name
                               and relation.relname = expected_tables.relation_name
                               and relation.relowner = owner_oid)
         union all
         select format('%s.%s(%s)', expected_functions.schema_name, expected_functions.proc_name,
                  expected_functions.argument_types)
           from expected_functions
          where not exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                             where namespace.nspname = expected_functions.schema_name
                               and proc.proname = expected_functions.proc_name
                               and pg_catalog.oidvectortypes(proc.proargtypes) = expected_functions.argument_types
                               and proc.proowner = owner_oid)
         union all
         select format('%s.%s(%s) (neither owned nor executable)', executed_functions.schema_name,
                  executed_functions.proc_name, executed_functions.argument_types)
           from executed_functions
          where not exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                             where namespace.nspname = executed_functions.schema_name
                               and proc.proname = executed_functions.proc_name
                               and pg_catalog.oidvectortypes(proc.proargtypes) = executed_functions.argument_types
                               and (proc.proowner = owner_oid
                                 or has_function_privilege(owner_oid, proc.oid, 'EXECUTE'))))
  select exists (select 1 from foreign_owned), (select string_agg(foreign_owned.what, ', ') from foreign_owned)
    into found_absent, missing;
  if owner_oid is null or found_absent or validator_owner is distinct from owner_oid then
    raise exception using errcode = '42501',
      message = format('0148: these are not owned by %s, the owner of pharmacy.work_items: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), coalesce(missing, 'pharmacy.validate_dispensing()'));
  end if;
  -- f. The applier is that owner, or a member that inherits it and may SET
  -- ROLE to it; that owner may create in and use pharmacy and use the other
  -- schemas the new bodies name.
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '42501',
      message = format('0148: %s must own, or inherit from and be able to SET ROLE to, %s, the owner of '
        || 'pharmacy.work_items, ehr.prescriptions and 0133''s claims', current_user, pg_get_userbyid(owner_oid));
  end if;
  with wanted(schema_name, privilege) as (values
         ('pharmacy', 'CREATE'), ('pharmacy', 'USAGE'), ('ehr', 'USAGE'), ('identity', 'USAGE'), ('auth', 'USAGE'),
         ('platform', 'USAGE')),
       lacking as (
         select wanted.* from wanted
          where not exists (select 1 from pg_namespace namespace
                             where namespace.nspname = wanted.schema_name
                               and has_schema_privilege(owner_oid, namespace.oid, wanted.privilege)))
  select exists (select 1 from lacking),
         (select string_agg(format('%s on schema %s', lacking.privilege, lacking.schema_name), ', ') from lacking)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501',
      message = format('0148: %s lacks %s', pg_get_userbyid(owner_oid), missing);
  end if;
  -- g. 0133 D5's premise: no hid_ role is a member of the dispensing
  -- validator's owner, whom D5's two ehr.prescriptions policies name, and
  -- who owns both new SECURITY DEFINER functions.
  select exists (select 1 from pg_roles role_row
                  where role_row.rolname like 'hid\_%' and role_row.oid <> validator_owner
                    and pg_has_role(role_row.oid, validator_owner, 'MEMBER')),
         (select string_agg(role_row.rolname, ', ' order by role_row.rolname) from pg_roles role_row
           where role_row.rolname like 'hid\_%' and role_row.oid <> validator_owner
             and pg_has_role(role_row.oid, validator_owner, 'MEMBER'))
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0148: these roles are members of %s, which 0133 D5''s ehr.prescriptions policies name: %s',
        pg_get_userbyid(validator_owner), missing);
  end if;
  -- h. Row-level security as 0133 left it: the claims enabled and not
  -- forced (their owner reads every claim in any session), the
  -- prescriptions and the work items enabled and forced (unchanged here).
  if (select count(*) from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
       where ((namespace.nspname, relation.relname) = ('pharmacy', 'prescription_item_claims')
              and relation.relrowsecurity and not relation.relforcerowsecurity)
          or ((namespace.nspname, relation.relname) in (('ehr', 'prescriptions'), ('pharmacy', 'work_items'))
              and relation.relrowsecurity and relation.relforcerowsecurity)) <> 3 then
    raise exception using errcode = '55000',
      message = '0148: row-level security is not as 0133 left it (0133''s claims enabled and not forced; '
        || 'ehr.prescriptions and pharmacy.work_items enabled and forced)';
  end if;
  -- Every owner-run SECURITY DEFINER function's catalog row (its oid and
  -- the row version, xmin), for section 6: 0133 D5's list of those whose
  -- text names ehr.prescriptions (0133's suite's S7 list) can change only
  -- if one of these rows changes or a new definer is made, and section 6
  -- checks that none changed and that the only new ones are C2 and C3,
  -- whose bodies name neither ehr.prescriptions nor the sends table. That
  -- proves the list unchanged without reading every function body under
  -- section 1's SHARE ROW EXCLUSIVE (a scan of every body costs about 10 ms
  -- of that hold).
  perform set_config('hid_q132.definer_rows',
    coalesce((select string_agg(proc.oid::text || ':' || proc.xmin::text, ' ' order by proc.oid)
                from pg_proc proc
               where proc.prosecdef and proc.proowner = validator_owner), 'none'), true);
  raise notice '0148: preconditions checked; applier %; owner %', current_user, pg_get_userbyid(owner_oid);
end
$$;

-- 1. Locks (see Locks), NOWAIT, at most 5 s. A failed attempt's
-- subtransaction releases what it took. The tables only read first, then
-- their indexes (each may wait 10 ms), and the SHARE ROW EXCLUSIVE on
-- ehr.prescriptions last, so an attempt that waits never holds it. When
-- this transaction already holds a lock that stops other sessions' reads or
-- writes of a table (an earlier migration in the same transaction, as in
-- the runner's dry run of every pending file; the runner's own ledger table
-- aside), one attempt only and no sleep, so no request queues behind those
-- locks while this file waits.
do $$
declare
  attempt integer := 0;
  runner_lock_timeout text := current_setting('lock_timeout');
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
      lock table pharmacy.work_items, pharmacy.prescription_item_claims, auth.accounts,
        identity.staff_facility_memberships, auth.account_roles, auth.roles, auth.role_permissions, auth.permissions,
        identity.staff, identity.facilities, identity.organizations
        in access share mode nowait;
      perform set_config('lock_timeout', '10ms', true);
      execute 'select 1 from pharmacy.work_items where false';
      execute 'select 1 from pharmacy.prescription_item_claims where false';
      execute 'select 1 from auth.accounts where false';
      execute 'select 1 from identity.staff_facility_memberships where false';
      execute 'select 1 from auth.account_roles where false';
      execute 'select 1 from auth.roles where false';
      execute 'select 1 from auth.role_permissions where false';
      execute 'select 1 from auth.permissions where false';
      execute 'select 1 from identity.staff where false';
      execute 'select 1 from identity.facilities where false';
      execute 'select 1 from identity.organizations where false';
      perform set_config('lock_timeout', runner_lock_timeout, true);
      lock table ehr.prescriptions in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0148: ehr.prescriptions or a table 0148 reads (the Pharmacy work items, 0133''s claims, the '
            || 'account, membership and role tables, or their indexes) is busy, and this transaction already holds '
            || 'an earlier migration''s locks, so it does not wait; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0148: ehr.prescriptions or a table 0148 reads (the Pharmacy work items, 0133''s claims, the '
            || 'account, membership and role tables, or their indexes) stayed busy for 5 seconds; nothing applied; '
            || 'run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;

-- 1b. Under section 1's locks, the preconditions that print a CHECK, a
-- trigger or a policy: PostgreSQL's pg_get_expr opens the table it prints
-- for (ACCESS SHARE), so in section 0 it could wait behind DDL on it, and
-- after section 1 it cannot. Each failure raises 55000 and nothing is
-- applied.
do $$
begin
  -- 1. 0133 D14's CHECK: a released claim was never dispensed, so a
  -- dispensed claim is never released and C2 needs no test of released_at.
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.prescription_item_claims'::regclass and constraint_row.contype = 'c'
         and constraint_row.convalidated
         and pg_get_constraintdef(constraint_row.oid)
             = 'CHECK (((released_at IS NULL) OR ((order_route_id IS NULL) AND (dispensed_at IS NULL))))') <> 1 then
    raise exception using errcode = '55000',
      message = '0148: pharmacy.prescription_item_claims does not have 0133''s CHECK that a dispensed claim is never '
        || 'released';
  end if;
  -- 2. The claims' two triggers exactly as 0133 made them, enabled always.
  -- Only these two rows are printed (the subquery, kept apart by OFFSET 0,
  -- picks them first): pg_get_triggerdef opens the table of a trigger that
  -- has a WHEN clause to print it, and another table's trigger (such as
  -- 0133's own-work list trigger on lab.work_items) must not make this file
  -- wait on a table section 1 does not hold.
  if (select count(*) from (select trigger_row.oid from pg_trigger trigger_row
                             where trigger_row.tgrelid in ('pharmacy.work_items'::regclass, 'pharmacy.dispensings'::regclass)
                               and trigger_row.tgname in ('work_items_claim_prescription', 'dispensings_claim_prescription')
                               and not trigger_row.tgisinternal and trigger_row.tgenabled = 'A'
                            offset 0) trigger_row
       where pg_get_triggerdef(trigger_row.oid) in (
               'CREATE TRIGGER work_items_claim_prescription AFTER INSERT ON pharmacy.work_items FOR EACH ROW EXECUTE '
                 || 'FUNCTION pharmacy.claim_prescription_work_item()',
               'CREATE TRIGGER dispensings_claim_prescription AFTER INSERT ON pharmacy.dispensings FOR EACH ROW '
                 || 'EXECUTE FUNCTION pharmacy.claim_prescription_dispensing()')) <> 2 then
    raise exception using errcode = '55000',
      message = '0148: 0133''s claim triggers are not as 0133 made them';
  end if;
  -- 3. 0086's route sync exactly (every update, origin mode), and no AFTER
  -- UPDATE trigger on ehr.prescriptions, internal ones included, whose name
  -- sorts (C collation, the order PostgreSQL fires AFTER triggers of one
  -- event in) after C4's: C4 must fire after the route sync has waited for a
  -- dispensing in flight. A BEFORE trigger's name does not decide that
  -- order (prescriptions_versioned, BEFORE INSERT OR UPDATE, sorts after
  -- C4's name and fires before every AFTER trigger).
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and not trigger_row.tgisinternal
         and trigger_row.tgname = 'prescriptions_order_routes_sync' and trigger_row.tgenabled = 'O'
         and trigger_row.tgfoid = 'ehr.sync_order_routes_on_order_change()'::regprocedure
         and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER prescriptions_order_routes_sync AFTER UPDATE ON '
           || 'ehr.prescriptions FOR EACH ROW EXECUTE FUNCTION ehr.sync_order_routes_on_order_change()') <> 1
     or exists (select 1 from pg_trigger trigger_row
                 where trigger_row.tgrelid = 'ehr.prescriptions'::regclass
                   and trigger_row.tgtype & 16 <> 0 and trigger_row.tgtype & 2 = 0 and trigger_row.tgtype & 64 = 0
                   and trigger_row.tgname::text collate "C" > 'prescriptions_pharmacy_change_after_dispensing') then
    raise exception using errcode = '55000',
      message = '0148: ehr.prescriptions does not have 0086''s route sync trigger as 0086 made it, or has an AFTER '
        || 'UPDATE trigger that would fire after prescriptions_pharmacy_change_after_dispensing';
  end if;
  -- 4. pharmacy.work_items' policies that apply to SELECT are exactly the
  -- two permissive ones C3 repeats (0086's and 0133 D2's, as
  -- order-routes-privileges pins them), for everyone, and none is
  -- restrictive: C3's answer equals what a session selects from the table.
  if (select array_agg(policy_row.polname::text || ':' || policy_row.polcmd::text || ':'
          || policy_row.polpermissive::text || ':' || pg_get_expr(policy_row.polqual, policy_row.polrelid)
          order by policy_row.polname::text collate "C")
        from pg_policy policy_row
       where policy_row.polrelid = 'pharmacy.work_items'::regclass and policy_row.polcmd in ('r', '*'))
     is distinct from array[
       'pharmacy_work_items_read:r:true:pharmacy.work_item_allows(patient_id, facility_id, order_route_id, '
         || '''read_records''::text)',
       'staff_own_work_read:r:true:(COALESCE(identity.pharmacy_work_patient_allows(( SELECT '
         || 'identity.facility_work_session_membership(''pharmacy''::text) AS facility_work_session_membership), '
         || 'patient_id, facility_id, ''read_records''::text), false) AND (order_route_id IS NULL))']
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid = 'pharmacy.work_items'::regclass and policy_row.polcmd in ('r', '*')
                   and policy_row.polroles <> array[0::oid]) then
    raise exception using errcode = '55000',
      message = '0148: pharmacy.work_items'' read policies are not the two the reader repeats';
  end if;
end
$$;

-- 2. Act as the owner for the rest of this transaction (a no-op when the
-- applier is the owner, as on every database built by one migration login),
-- so the new objects are the owner's: the owner of 0133's claims and of
-- ehr.prescriptions, and the role 0133 D5's ehr.prescriptions policies name
-- (section 0 e and g).
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

-- 3. C1. One row per prescription version after a work item's first
-- dispensing: facts only (no actor, no reason, no prescription id, no field
-- value). The key is the reader's index and makes the recorder idempotent
-- per version. No CHECK and no foreign key: the trigger that writes it must
-- never fail on real data (a status list copied here would make a later
-- status fail every prescription change), and a foreign key would lock the
-- tables its ids name. Row-level security enabled, not forced, no policy and
-- no grant: the owner's only, as 0133's sends and claims.
create table pharmacy.prescription_changes_after_dispensing (
  work_item_id uuid not null,
  facility_id uuid not null,
  prescription_version bigint not null,
  status_before text not null,
  status_after text not null,
  prior_content_sha256 bytea not null,
  content_sha256 bytea not null,
  changed_at timestamptz not null,
  constraint prescription_changes_after_dispensing_pkey primary key (work_item_id, prescription_version)
);
create trigger prescription_changes_after_dispensing_immutable
  before update or delete on pharmacy.prescription_changes_after_dispensing
  for each row execute function pharmacy.reject_immutable_evidence();
alter table pharmacy.prescription_changes_after_dispensing enable row level security;
revoke all on pharmacy.prescription_changes_after_dispensing from public;

-- C2. The recorder, the function of C4. It reads only 0133's claims (one
-- per work item, own or route-backed; dispensed_at set by the first
-- dispensing and kept after a reversal) and writes only C1; both are this
-- owner's, with row-level security enabled and not forced, so nothing is
-- filtered in the prescriber's session under a superuser owner or under
-- production's NOSUPERUSER NOBYPASSRLS owner alike. It never reads
-- pharmacy.work_items or pharmacy.dispensings (forced: they would show only
-- what the prescriber's session may read). It never refuses the change it
-- follows: no CHECK, no foreign key, the key hit on conflict do nothing,
-- every NOT NULL value from a NOT NULL source. The two fingerprints are
-- computed only when a dispensed claim matches (the select list runs per
-- matching row): SHA-256 (not MD5, which FIPS mode refuses) of the row as
-- jsonb without status, row_version, created_at and updated_at and without
-- null-valued keys. It names no column, so a later DROP or RENAME COLUMN
-- cannot break prescription writes; jsonb prints dates and numbers the same
-- whatever DateStyle or locale is, and the two timestamptz columns, whose
-- jsonb text depends on the session's TimeZone, are left out. Maintenance
-- rule: a later column that is NOT NULL or has a default changes every
-- later fingerprint, so the first resume after that migration reads
-- 'edited' (the safe side) unless that migration adds its name to the keys
-- left out by replacing this function (CREATE OR REPLACE FUNCTION takes no
-- lock on ehr.prescriptions); a later timestamptz or interval column must
-- be left out; a later nullable column, null in old rows, changes nothing.
-- A later ALTER COLUMN TYPE that changes a column's jsonb text (numeric(12,4)
-- to numeric(14,6) turns 1.0000 into 1.000000), or a RENAME or DROP of a
-- column that holds values, also changes every later fingerprint, so the
-- first resume after it reads 'edited' too (the safe side).
-- The time is clock_timestamp() taken here, after the route sync's wait
-- (C4's name), never the version's updated_at, stamped before that wait.
create function pharmacy.prescription_change_after_dispensing()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into pharmacy.prescription_changes_after_dispensing (work_item_id, facility_id, prescription_version,
    status_before, status_after, prior_content_sha256, content_sha256, changed_at)
  select claim.work_item_id, claim.facility_id, new.row_version, old.status, new.status,
         pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_strip_nulls(pg_catalog.to_jsonb(old)
           - array['status', 'row_version', 'created_at', 'updated_at']::text[])::text, 'UTF8')),
         pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_strip_nulls(pg_catalog.to_jsonb(new)
           - array['status', 'row_version', 'created_at', 'updated_at']::text[])::text, 'UTF8')),
         pg_catalog.clock_timestamp()
    from pharmacy.prescription_item_claims claim
   where claim.prescription_id = new.id
     and claim.dispensed_at is not null
  on conflict (work_item_id, prescription_version) do nothing;
  return null;
end;
$$;

-- C3. The reader: for the requested work items the session may read (the
-- session's facility, and pharmacy.work_items' two read policies repeated
-- as conditions, so a superuser owner, who bypasses row-level security, and
-- a NOBYPASSRLS owner, under whom the table's own policies apply too, answer
-- alike), the latest shown change, when it was made and how many shown
-- changes there were. The labels are set here from the recorded facts, in
-- this order, the first that holds winning: entered_in_error, cancelled,
-- on_hold (a stop always wins over an edit sent with it); a resume from
-- hold is 'resumed' when what it now says is what was dispensed (the first
-- recorded row's prior content) and 'edited' otherwise; an active
-- prescription whose content changed is 'edited'; anything else (completed,
-- a change of nothing, an edit while it stays on hold, a status this file
-- does not know) is not shown and not counted. Because the facts are kept
-- and the labels made here, a later rule (a replaced reader) applies to rows
-- already recorded, and an edit made during a hold shows at the resume.
-- The session must hold pharmacy.work-item.read (the consent branch of
-- pharmacy.work_item_allows checks no permission); a predicate, not an
-- early return, so the post-check probe plans and runs every query. It
-- starts from C1's rows (usually none), so the policy tests run only for
-- items with a recorded row; the windows run over all of an item's rows
-- before the shown ones are filtered and counted. At most 200 ids.
create function pharmacy.work_item_changes_after_dispensing(requested_work_item_ids uuid[])
returns table (work_item_id uuid, change text, changed_at timestamptz, change_count integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
  may_read boolean;
  own_work_membership uuid;
begin
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID';
  end if;
  if session_facility is null then
    return;
  end if;
  may_read := coalesce(auth.membership_has_permission(platform.current_actor_subject(),
    platform.current_membership_id(), session_facility, 'pharmacy.work-item.read'), false);
  own_work_membership := identity.facility_work_session_membership('pharmacy');
  return query
    with recorded as materialized (
      select change_row.work_item_id as item_id, change_row.prescription_version, change_row.status_before,
             change_row.status_after, change_row.prior_content_sha256, change_row.content_sha256,
             change_row.changed_at as recorded_at
        from pharmacy.prescription_changes_after_dispensing change_row
       where may_read
         and change_row.work_item_id = any(requested_work_item_ids)
         and change_row.facility_id = session_facility),
    visible as (
      select item.id
        from pharmacy.work_items item
       where item.id in (select recorded.item_id from recorded)
         and item.facility_id = session_facility
         and (pharmacy.work_item_allows(item.patient_id, item.facility_id, item.order_route_id, 'read_records')
           or (coalesce(identity.pharmacy_work_patient_allows(own_work_membership, item.patient_id,
                 item.facility_id, 'read_records'), false)
               and item.order_route_id is null))),
    labelled as (
      select recorded.item_id, recorded.prescription_version, recorded.recorded_at,
             case
               when recorded.status_after = 'entered_in_error'
                    and recorded.status_before is distinct from 'entered_in_error' then 'entered_in_error'
               when recorded.status_after = 'cancelled'
                    and recorded.status_before is distinct from 'cancelled' then 'cancelled'
               when recorded.status_after = 'on_hold'
                    and recorded.status_before is distinct from 'on_hold' then 'on_hold'
               when recorded.status_before = 'on_hold' and recorded.status_after = 'active'
                 then case when recorded.content_sha256 = first_value(recorded.prior_content_sha256)
                                  over (partition by recorded.item_id order by recorded.prescription_version)
                           then 'resumed' else 'edited' end
               when recorded.status_before = 'active' and recorded.status_after = 'active'
                    and recorded.content_sha256 <> recorded.prior_content_sha256 then 'edited'
             end as label
        from recorded
        join visible on visible.id = recorded.item_id)
    select distinct on (shown.item_id) shown.item_id, shown.label, shown.recorded_at,
           (count(*) over (partition by shown.item_id))::integer
      from labelled shown
     where shown.label is not null
     order by shown.item_id, shown.prescription_version desc;
end;
$$;

-- 4. C4. The trigger, in origin mode (the default, as prescriptions_versioned
-- and 0133 D8's): every version whose status before was active or on hold,
-- the rows the reader needs. Drafts (never dispensed; also
-- ehr.send_order_route's activation) and every change after completed,
-- cancelled or entered in error (never shown, so a later edit cannot hide a
-- stop) are not recorded; nor is a change in replica mode, which writes no
-- ehr.record_versions row either. Its name sorts after 0086's route sync and
-- 0133 D8's trigger, so it fires after the route sync has waited for a
-- dispensing in flight (AFTER triggers of one event fire in name order).
create trigger prescriptions_pharmacy_change_after_dispensing
  after update on ehr.prescriptions
  for each row
  when (old.status in ('active', 'on_hold'))
  execute function pharmacy.prescription_change_after_dispensing();

-- 5. Grants (here and in runtime-grants.sql) and comments. The table's
-- revoke from PUBLIC is in section 3, with the table: no role holds any
-- privilege on it. C2 is executed by no role (C4 runs it as its owner).
revoke all on function pharmacy.prescription_change_after_dispensing(),
  pharmacy.work_item_changes_after_dispensing(uuid[]) from public;
do $$
declare runtime_role text;
begin
  foreach runtime_role in array array['hid_pharmacy_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function pharmacy.work_item_changes_after_dispensing(uuid[]) to %I',
        runtime_role);
    end if;
  end loop;
end
$$;

comment on table pharmacy.prescription_changes_after_dispensing is
  '0148 Q132 A: one row per prescription version after a work item''s first dispensing (0133''s claim dispensed_at), written by the trigger prescriptions_pharmacy_change_after_dispensing: the work item, its facility, the version, the status before and after, a SHA-256 fingerprint of the content before and after, and the time. Facts only: no actor, reason, prescription id or field value. Append-only; the owner''s only (no policy, no grant).';
comment on function pharmacy.prescription_change_after_dispensing() is
  '0148 Q132 A: the function of the trigger prescriptions_pharmacy_change_after_dispensing on ehr.prescriptions: for each dispensed claim of the changed prescription, one row in pharmacy.prescription_changes_after_dispensing (on conflict nothing). Never refuses the change. Fingerprint: SHA-256 of the row as jsonb without status, row_version, created_at, updated_at and null-valued keys; a later NOT NULL or defaulted column must be added to those keys by replacing this function, or the first resume after it reads edited (as it does after a type change that changes a column''s jsonb text, or a rename or drop of a column that holds values). Executed by no role.';
comment on function pharmacy.work_item_changes_after_dispensing(uuid[]) is
  '0148 Q132 A: for each requested work item the session may read (its facility, and pharmacy.work_items'' two read policies repeated), the latest shown change after its dispensing (entered_in_error, cancelled, on_hold, edited or resumed, set here from the recorded facts), its time and the number of shown changes. Needs pharmacy.work-item.read. At most 200 ids, else 22023 WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID.';
comment on trigger prescriptions_pharmacy_change_after_dispensing on ehr.prescriptions is
  '0148 Q132 A: records each change of an active or on-hold prescription that has a dispensed work item (0133''s claims) in pharmacy.prescription_changes_after_dispensing. Fires after prescriptions_order_routes_sync (name order), so after any dispensing in flight has committed. Never refuses the change.';

-- 6. Post-checks.
do $$
declare
  found_absent boolean;
  mismatch text;
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  validator_owner oid := (select proc.proowner from pg_proc proc
                           where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure);
  error_state text;
  error_message text;
begin
  -- C2 and C3: bodies (md5), exactly one function of each name, owner (the
  -- work items' and the dispensing validator's), SECURITY DEFINER,
  -- volatility, language, not STRICT, search_path, return type.
  with expected(proc_name, argument_types, digest, volatility, result_type) as (values
         ('prescription_change_after_dispensing', '', 'f61173d77be391a9e9c96db494827e82', 'v', 'trigger'),
         ('work_item_changes_after_dispensing', 'uuid[]', 'f034ea13a60ffb4314b442d50a156e96', 's',
           'TABLE(work_item_id uuid, change text, changed_at timestamp with time zone, change_count integer)')),
       differing as (
         select expected.*,
                (select string_agg(format('md5=%s owner=%s definer=%s volatile=%s strict=%s config=%s',
                          md5(proc.prosrc), pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
                          proc.proisstrict, proc.proconfig), ',')
                   from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = 'pharmacy' and proc.proname = expected.proc_name) as found
           from expected
          where (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = 'pharmacy' and proc.proname = expected.proc_name) <> 1
             or not exists (
               select 1 from pg_proc proc
                 join pg_namespace namespace on namespace.oid = proc.pronamespace
                 join pg_language language_row on language_row.oid = proc.prolang
                where namespace.nspname = 'pharmacy' and proc.proname = expected.proc_name
                  and pg_catalog.oidvectortypes(proc.proargtypes) = expected.argument_types
                  and md5(proc.prosrc) = expected.digest and proc.proowner = owner_oid
                  and proc.proowner = validator_owner and proc.prosecdef
                  and proc.provolatile = expected.volatility::"char" and language_row.lanname = 'plpgsql'
                  and not proc.proisstrict and proc.proconfig = array['search_path=pg_catalog, pg_temp']
                  and pg_get_function_result(proc.oid) = expected.result_type))
  select exists (select 1 from differing),
         (select string_agg(format('pharmacy.%s(%s): %s', differing.proc_name, differing.argument_types,
                   coalesce(differing.found, 'missing')), '; ') from differing)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000', message = format('0148: functions are not as this file makes them: %s', mismatch);
  end if;
  -- Their exact EXECUTE grants: C3 to each of the two runtimes that exists
  -- (not grantable), C2 to nobody; nothing else, PUBLIC included. Decided
  -- by EXISTS, so a role that does not exist never makes a comparison null.
  with expected(proc_name, grantee_name) as (values
         ('work_item_changes_after_dispensing', 'hid_pharmacy_runtime'),
         ('work_item_changes_after_dispensing', 'hid_schema_test_runtime')),
       new_functions as (
         select proc.oid, proc.proname, proc.proowner, proc.proacl
           from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'pharmacy'
            and proc.proname in ('prescription_change_after_dispensing', 'work_item_changes_after_dispensing')),
       granted as (
         select new_functions.proname, privilege.grantee, privilege.privilege_type, privilege.is_grantable
           from new_functions
          cross join aclexplode(coalesce(new_functions.proacl, acldefault('f', new_functions.proowner))) privilege
          where privilege.grantee <> new_functions.proowner),
       wrong as (
         select format('pharmacy.%s granted %s to %s', granted.proname, granted.privilege_type,
                  case when granted.grantee = 0 then 'PUBLIC' else pg_get_userbyid(granted.grantee)::text end) as what
           from granted
          where not exists (select 1 from expected join pg_roles role_row on role_row.rolname = expected.grantee_name
                             where expected.proc_name = granted.proname and role_row.oid = granted.grantee
                               and granted.privilege_type = 'EXECUTE' and not granted.is_grantable)
         union all
         select format('pharmacy.%s lacks EXECUTE for %s', expected.proc_name, expected.grantee_name)
           from expected join pg_roles role_row on role_row.rolname = expected.grantee_name
          where not exists (select 1 from granted
                             where granted.proname = expected.proc_name and granted.grantee = role_row.oid
                               and granted.privilege_type = 'EXECUTE'))
  select exists (select 1 from wrong), (select string_agg(wrong.what, '; ') from wrong)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000', message = format('0148: the new functions'' grants are not section 5''s: %s',
      mismatch);
  end if;
  -- C1 exactly: columns, types, NOT NULLs and defaults; its key (not
  -- deferrable) and no other constraint; the key's index only; a plain
  -- table, the owner's, row-level security enabled and not forced, no
  -- policy, no privilege for anyone but the owner; the immutability trigger
  -- only (DELETE printed before UPDATE).
  if (select array_agg(attribute_row.attname::text || ':' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
          || ':' || attribute_row.attnotnull::text || ':'
          || coalesce(pg_get_expr(column_default.adbin, column_default.adrelid), '-') order by attribute_row.attnum)
        from pg_attribute attribute_row
        left join pg_attrdef column_default
          on column_default.adrelid = attribute_row.attrelid and column_default.adnum = attribute_row.attnum
       where attribute_row.attrelid = 'pharmacy.prescription_changes_after_dispensing'::regclass
         and attribute_row.attnum > 0 and not attribute_row.attisdropped)
     is distinct from array['work_item_id:uuid:true:-', 'facility_id:uuid:true:-', 'prescription_version:bigint:true:-',
       'status_before:text:true:-', 'status_after:text:true:-', 'prior_content_sha256:bytea:true:-',
       'content_sha256:bytea:true:-', 'changed_at:timestamp with time zone:true:-'] then
    raise exception using errcode = '55000',
      message = '0148: the columns of pharmacy.prescription_changes_after_dispensing are not this file''s';
  end if;
  if (select array_agg(constraint_row.conname::text || ' ' || constraint_row.contype::text || ' '
          || pg_get_constraintdef(constraint_row.oid) || ' ' || constraint_row.condeferrable::text
          || ' ' || constraint_row.convalidated::text order by constraint_row.conname::text collate "C")
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.prescription_changes_after_dispensing'::regclass)
     is distinct from array['prescription_changes_after_dispensing_pkey p PRIMARY KEY (work_item_id, '
       || 'prescription_version) false true']
     or (select array_agg(pg_get_indexdef(index_row.indexrelid) order by pg_get_indexdef(index_row.indexrelid) collate "C")
           from pg_index index_row
          where index_row.indrelid = 'pharmacy.prescription_changes_after_dispensing'::regclass)
        is distinct from array['CREATE UNIQUE INDEX prescription_changes_after_dispensing_pkey ON '
          || 'pharmacy.prescription_changes_after_dispensing USING btree (work_item_id, prescription_version)'] then
    raise exception using errcode = '55000',
      message = '0148: the key of pharmacy.prescription_changes_after_dispensing is not this file''s';
  end if;
  if (select relation.relkind = 'r' and relation.relrowsecurity and not relation.relforcerowsecurity
             and relation.relowner = owner_oid
        from pg_class relation where relation.oid = 'pharmacy.prescription_changes_after_dispensing'::regclass)
       is not true
     or exists (select 1 from pg_class relation
                 cross join aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
                 where relation.oid = 'pharmacy.prescription_changes_after_dispensing'::regclass
                   and privilege.grantee <> relation.relowner)
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid = 'pharmacy.prescription_changes_after_dispensing'::regclass) then
    raise exception using errcode = '55000',
      message = '0148: pharmacy.prescription_changes_after_dispensing must be the owner''s alone, with row-level '
        || 'security enabled and not forced, and no policy';
  end if;
  if (select array_agg(pg_get_triggerdef(trigger_row.oid) || ' ' || trigger_row.tgenabled::text
          order by trigger_row.tgname::text collate "C")
        from pg_trigger trigger_row
       where trigger_row.tgrelid = 'pharmacy.prescription_changes_after_dispensing'::regclass
         and not trigger_row.tgisinternal)
     is distinct from array['CREATE TRIGGER prescription_changes_after_dispensing_immutable BEFORE DELETE OR UPDATE ON '
       || 'pharmacy.prescription_changes_after_dispensing FOR EACH ROW EXECUTE FUNCTION '
       || 'pharmacy.reject_immutable_evidence() O'] then
    raise exception using errcode = '55000',
      message = '0148: the trigger of pharmacy.prescription_changes_after_dispensing is not this file''s';
  end if;
  -- C4: exactly one, as made here, in origin mode, running C2, which no
  -- other trigger runs; and the AFTER UPDATE row triggers on
  -- ehr.prescriptions (internal ones aside: 0086's and later foreign keys,
  -- whose RI_ names sort first) end with the route sync, 0133 D8's and C4,
  -- in the order PostgreSQL fires them.
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgname = 'prescriptions_pharmacy_change_after_dispensing') <> 1
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and not trigger_row.tgisinternal
            and trigger_row.tgname = 'prescriptions_pharmacy_change_after_dispensing' and trigger_row.tgenabled = 'O'
            and trigger_row.tgfoid = 'pharmacy.prescription_change_after_dispensing()'::regprocedure
            and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER prescriptions_pharmacy_change_after_dispensing '
              || 'AFTER UPDATE ON ehr.prescriptions FOR EACH ROW WHEN ((old.status = ANY (ARRAY[''active''::text, '
              || '''on_hold''::text]))) EXECUTE FUNCTION pharmacy.prescription_change_after_dispensing()') <> 1
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgfoid = 'pharmacy.prescription_change_after_dispensing()'::regprocedure) <> 1
     or (select array_agg(ordered.tgname::text order by ordered.position desc)
           from (select trigger_row.tgname,
                        row_number() over (order by trigger_row.tgname::text collate "C") as position
                   from pg_trigger trigger_row
                  where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and not trigger_row.tgisinternal
                    and trigger_row.tgtype & 1 <> 0 and trigger_row.tgtype & 16 <> 0
                    and trigger_row.tgtype & 2 = 0 and trigger_row.tgtype & 64 = 0) ordered
          where ordered.position > (select count(*) - 3 from pg_trigger trigger_row
                                     where trigger_row.tgrelid = 'ehr.prescriptions'::regclass
                                       and not trigger_row.tgisinternal and trigger_row.tgtype & 1 <> 0
                                       and trigger_row.tgtype & 16 <> 0 and trigger_row.tgtype & 2 = 0
                                       and trigger_row.tgtype & 64 = 0))
        is distinct from array['prescriptions_pharmacy_change_after_dispensing',
          'prescriptions_own_pharmacy_send_withdrawn', 'prescriptions_order_routes_sync'] then
    raise exception using errcode = '55000',
      message = '0148: the trigger prescriptions_pharmacy_change_after_dispensing is not as this file makes it, or not '
        || 'the last of ehr.prescriptions'' AFTER UPDATE triggers after the route sync and 0133 D8''s';
  end if;
  -- 0133 D5: no new body names ehr.prescriptions or the sends table; no
  -- other owner-run SECURITY DEFINER function was made, replaced or dropped
  -- (section 0's rows), so those whose text names ehr.prescriptions (0133's
  -- suite's S7 list) are the ones there were before; D5's two
  -- ehr.prescriptions policies are still two; D5's premise again; row-level
  -- security of the prescriptions and the claims unchanged.
  if exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'pharmacy'
                and proc.proname in ('prescription_change_after_dispensing', 'work_item_changes_after_dispensing')
                and (proc.prosrc ~* 'ehr\.prescriptions' or proc.prosrc ~* 'own_prescription_sends')) then
    raise exception using errcode = '55000',
      message = '0148: a new function body names ehr.prescriptions or the sends table';
  end if;
  if coalesce((select string_agg(proc.oid::text || ':' || proc.xmin::text, ' ' order by proc.oid)
                 from pg_proc proc
                where proc.prosecdef and proc.proowner = validator_owner
                  and proc.oid not in ('pharmacy.prescription_change_after_dispensing()'::regprocedure,
                        'pharmacy.work_item_changes_after_dispensing(uuid[])'::regprocedure)), 'none')
     is distinct from nullif(current_setting('hid_q132.definer_rows', true), '') then
    raise exception using errcode = '55000',
      message = '0148: an owner-run definer function other than this file''s two was made, replaced or dropped, so '
        || '0133 D5''s list of those that read ehr.prescriptions may have changed';
  end if;
  if (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.prescriptions'::regclass
         and policy_row.polname like 'prescriptions\_own\_pharmacy\_%') <> 2
     or exists (select 1 from pg_roles role_row
                 where role_row.rolname like 'hid\_%' and role_row.oid <> validator_owner
                   and pg_has_role(role_row.oid, validator_owner, 'MEMBER'))
     or (select count(*) from pg_class relation
          where (relation.oid = 'ehr.prescriptions'::regclass and relation.relrowsecurity
                 and relation.relforcerowsecurity)
             or (relation.oid = 'pharmacy.prescription_item_claims'::regclass and relation.relrowsecurity
                 and not relation.relforcerowsecurity)) <> 2 then
    raise exception using errcode = '55000',
      message = format('0148: 0133 D5''s ehr.prescriptions policies, its premise (no hid_ role a member of %s) or the '
        || 'row-level security of ehr.prescriptions or the claims changed', pg_get_userbyid(validator_owner));
  end if;
  -- Probes, each undone. They open only what section 1 holds, so none waits
  -- for a lock; should one still meet a busy lock (55P03), the file stops as
  -- busy, nothing applied, not with the probe's own message, and in the
  -- wording of section 1's refusals, which the runner's dry run retries
  -- (isBusyRefusal in scripts/dry-run-attempts.mjs). P3: the reader refuses
  -- 201 ids and a null array before it reads anything.
  begin
    perform pharmacy.work_item_changes_after_dispensing(array(select gen_random_uuid() from generate_series(1, 201)));
    error_state := 'no error';
  exception
    when lock_not_available then
      raise exception using errcode = '55P03',
        message = '0148: a table a post-check probe reads is busy (' || sqlerrm || '), so it does not wait; '
          || 'nothing applied; run the release again at a quieter time';
    when others then
      get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '22023' or error_message is distinct from 'WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID' then
    raise exception using errcode = '55000',
      message = format('0148: the reader must refuse 201 ids with 22023 WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID; it '
        || 'answered %s %s', error_state, coalesce(error_message, ''));
  end if;
  error_state := null;
  error_message := null;
  begin
    perform pharmacy.work_item_changes_after_dispensing(null);
    error_state := 'no error';
  exception
    when lock_not_available then
      raise exception using errcode = '55P03',
        message = '0148: a table a post-check probe reads is busy (' || sqlerrm || '), so it does not wait; '
          || 'nothing applied; run the release again at a quieter time';
    when others then
      get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '22023' or error_message is distinct from 'WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID' then
    raise exception using errcode = '55000',
      message = format('0148: the reader must refuse a null array with 22023 WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID; '
        || 'it answered %s %s', error_state, coalesce(error_message, ''));
  end if;
  -- P4: no row without a session; and with a session facility no item has
  -- (a fixed synthetic id), no row, with every query of the reader planned
  -- and run (plpgsql plans a query only when it first runs, so this proves
  -- the columns and functions it names exist): the permission test, the
  -- own-work half and the main query. The setting is cleared after.
  begin
    if exists (select 1 from pharmacy.work_item_changes_after_dispensing(array[gen_random_uuid()])) then
      raise exception using errcode = '55000', message = '0148: the reader answered a row without a session';
    end if;
    perform set_config('app.facility_id', '00000000-0000-4000-8000-000000000000', true);
    if exists (select 1 from pharmacy.work_item_changes_after_dispensing(array[gen_random_uuid()])) then
      raise exception using errcode = '55000', message = '0148: the reader answered a row for no item';
    end if;
    perform set_config('app.facility_id', '', true);
  exception
    when lock_not_available then
      raise exception using errcode = '55P03',
        message = '0148: a table a post-check probe reads is busy (' || sqlerrm || '), so it does not wait; '
          || 'nothing applied; run the release again at a quieter time';
  end;
  -- Nothing was recorded.
  if exists (select 1 from pharmacy.prescription_changes_after_dispensing) then
    raise exception using errcode = '55000', message = '0148: pharmacy.prescription_changes_after_dispensing is not empty';
  end if;
end
$$;

reset role;
