-- 0152 Prescription refills (ORD-12, lane D). Owner decision Q131 A, 19
-- November 2026 ("yes to refills"); the clinical owner's design note on
-- hid-system#258 (Ola, 23 November 2026, 18:15 UTC), Rahman's review of it
-- (19:42 UTC) and Ola's answers (22:15 UTC), which this file builds (the
-- answers win where they differ from the note). Written on Release B
-- (staging 926b1c58: 0001-0146) with 0148 (#317, Q132 A) merged in. The
-- number is provisional (the next after 0148-0151) and given in merge order;
-- no migration number appears inside a function body, a CHECK or a key, so
-- renumbering leaves every md5. This file requires 0001-0148 applied: 0148
-- pins the two bodies this file replaces, so it must run first. The
-- declaration is signed separately.
--
-- THE GAP. A pharmacy work item takes one dispensing. 0023's
-- UNIQUE (work_item_id) on pharmacy.dispensings refuses a second row, and
-- 0133's claim function refuses a second dispensing of an item whose claim
-- is dispensed (23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE, DETAIL
-- not_claimed). A prescriber who means "one month, then two more months"
-- must write three prescriptions, and the pharmacy cannot record a second
-- supply against the first. pharmacy-api cannot tell how many refills a
-- prescription allows: the Pharmacy runtime has no privilege on
-- ehr.prescriptions, and 0125's reader returns no refills, status or
-- version.
--
-- WHAT IT DOES
-- R1 ehr.prescriptions.refills_allowed smallint, NULLABLE, no default, with
--    the CHECK prescriptions_refills_allowed_ck (null, or 0-11). Null means
--    none: every existing row and every row an image without ORD-12 writes.
--    ehr-api sets it at creation only and never changes it (its PATCH SET
--    list does not name it), as for 0125's columns. Nullable on purpose:
--    0148's recorder (C2) fingerprints the row as jsonb with null-valued
--    keys removed, so a null column changes no fingerprint, a resume of a
--    prescription dispensed and recorded before this file still reads
--    'resumed', and C2 is NOT replaced; a NOT NULL DEFAULT 0 column would
--    have changed every fingerprint and forced C2 to leave the column out,
--    which would have hidden an owner's repair of the value after
--    dispensing. A repair that sets it shows as a change ('edited') when it
--    is made in origin mode with an actor (a new version); a replica-mode
--    repair writes no version, so it records nothing and ends no refill.
-- R2 pharmacy.dispensings.fill_number smallint NOT NULL DEFAULT 1, with the
--    CHECK dispensings_fill_number_ck (1-12): 1 is the first fill, 2 and
--    above refills. Every existing row reads 1, which is exact: 0023's key
--    allowed one dispensing per item, and the rows cannot be updated (0023's
--    immutability trigger). An INSERT that does not name the column (every
--    image without ORD-12, 0102's demo install) records fill 1, as today.
-- R3 UNIQUE (work_item_id, fill_number), dispensings_work_item_fill_number_key,
--    replaces 0023's unnamed UNIQUE (work_item_id), dropped by the name
--    pg_get_constraintdef finds (0133 section 3b's way). It is the last
--    guard against double dispensing: two refills of one item, recorded at
--    once, both pass the validator's FOR SHARE (shared locks do not wait for
--    each other), both carry the same fill number (pharmacy-api sends fills
--    so far + 1), and the second meets this key (23505, or 40001 under
--    pharmacy-api's SERIALIZABLE). Its index serves every lookup by
--    work_item_id that 0023's did.
-- R4 pharmacy.validate_dispensing() (0101's body, BEFORE INSERT, origin mode)
--    replaced: 0101's text with one block added before its RETURN, so the
--    order-route branch, 0077's actor and work-item check and 0101's
--    prescription check (FOR SHARE, active, at the accepted version) are
--    unchanged and answer first. The block runs only for fill_number > 1:
--    a route-backed item takes one fill (23514 NO_REFILLS_LEFT); an own item
--    takes at most 1 + coalesce(refills_allowed, 0) fills (23514
--    NO_REFILLS_LEFT), and a refill is refused once the prescription's
--    ends_on is before today in Lagos (23514 REFILL_PRESCRIPTION_ENDED;
--    (clock_timestamp() at time zone 'Africa/Lagos')::date, as 0090 and
--    0095 compute the Lagos day; ends_on is the last day, inclusive, as
--    ehr-api reads it). A first fill is not checked against ends_on
--    (unchanged; whether it should be is a question for the owner, outside
--    ORD-12). The values are the prescription row 0101 already reads FOR
--    SHARE, so a refill needs it active and unchanged since the item was
--    accepted: any change after the first fill, a hold then resume
--    included, ends the remaining refills (0101's version check; owner
--    decision at 0101:48-54).
-- R5 pharmacy.claim_prescription_dispensing() (0133 D14, AFTER INSERT,
--    ENABLE ALWAYS) replaced: fill 1 exactly as before (it turns the item's
--    live, undispensed claim dispensed, or is refused sent_elsewhere or
--    not_claimed); fill 2 and above need the item's claim live, dispensed
--    and its own (no order route), else the same refusal. It never changes
--    or clears dispensed_at, which stays the first fill's: "after
--    dispensing" for 0148 and every 0133 and 0144 reader that tests it means
--    after the first fill. It reads only the claims, never ehr.prescriptions.
-- R6 pharmacy.work_item_refills(uuid[]) (new; plpgsql, STABLE, SECURITY
--    DEFINER, the owner's, search_path pg_catalog, pg_temp, every name
--    schema-qualified; EXECUTE to hid_pharmacy_runtime and
--    hid_schema_test_runtime only, as 0148's reader). For at most 200
--    requested work items (else 22023 WORK_ITEM_REFILLS_INVALID, a null
--    array too), one row per own item (no order route) the session may
--    read: refills_allowed (null read as 0), fills_recorded (every fill
--    row, a reversed one included), refill_open and closed_reason. "May
--    read" is 0148's C3 rule: the session's facility,
--    pharmacy.work-item.read, and pharmacy.work_items' two read policies
--    repeated as conditions (the consent test, and 0133's own-work half),
--    so a superuser owner, who bypasses row-level security, and a
--    NOSUPERUSER NOBYPASSRLS owner, under whom the tables' own policies
--    apply too, answer alike: for an own item either policy lets the
--    session read, the policies of ehr.prescriptions (0005's consent test,
--    0133 D5's own-work source read) and of pharmacy.dispensings (the
--    consent test, 0133's own-work half) let the owner read its
--    prescription and its fills, which the reader matches on the item's
--    patient and facility (section 3 pins those policies). A route-backed
--    item, an item of another facility or one the session may not read
--    gives no row; so does a session without a facility. An item with no
--    fill yet reads refill_open false and closed_reason null. Otherwise a
--    refill is open while fills_recorded < 1 + refills_allowed, the
--    prescription is active at the version the item was accepted at (and
--    for its encounter), and ends_on is not before today in Lagos: exactly
--    what R4 asks of the next fill, which R5 lets through for an own item
--    already dispensed (0133's claims CHECK: a dispensed claim is never
--    released). When it is not open, closed_reason is the first that holds:
--    'none_left' (every allowed fill recorded), 'stopped' (the prescription
--    is not active: on hold, completed, cancelled or entered in error),
--    'changed' (active again, but not at the accepted version: an edit, or
--    a hold then resume) and 'ended' (ends_on is past). A stop comes before
--    a change because every status change is a new version too. The reader
--    knows nothing of PRESCRIPTION_REFILLS_ENABLED: pharmacy-api reads a
--    refill as open only while that setting is on too. Its text names
--    ehr.prescriptions, so it joins 0133 D5's list of owner-run definer
--    functions that read prescriptions (0133's suite's S7 list), and each
--    suite that pins that list names it. 0125's reader
--    (pharmacy.work_item_prescription_details) is not replaced.
--
-- Replica mode (session_replication_role = replica) skips R4 (origin mode),
-- so the refill count and the end date are not enforced there (the clinical
-- owner's call: no replica-mode writer records refills). The backstops that
-- fire in every mode: R5 (ENABLE ALWAYS: no refill of an item never
-- dispensed, sent elsewhere or route-backed), R2's CHECK (at most 12 fills)
-- and R3's key (one row per fill number).
--
-- What it does not do. No backfill and no update of any row. No change to
-- 0148's C2 (its md5 is pinned unchanged here) or C3, to 0125's reader, to
-- 0144's acceptance (an item is accepted once, before its first fill;
-- refills need no new acceptance, and 0144 refuses one 'not_claimed' once
-- the claim is dispensed), to ehr.withdraw_own_pharmacy_send or 0133's and
-- 0144's states and steps (the prescriber is not told that a change ended
-- the refills: a change after the first fill is the prescriber's own; the
-- pharmacy sees 0148's notice and R6's closed_reason), to the reversal guard
-- (a reversed fill still counts: the dispensing row stays, so its fill
-- number stays taken), to any trigger, policy or row-level security
-- setting. The table grants are table-wide (the EHR runtime's SELECT,
-- INSERT and UPDATE on ehr.prescriptions; the Pharmacy runtime's SELECT and
-- INSERT on pharmacy.dispensings), so the new columns need no grant; R6's
-- EXECUTE is granted here and in runtime-grants.sql (0152's block). Fill
-- numbers need not be contiguous in the database (a gap needs a caller that
-- skips one; pharmacy-api sends fills so far + 1): the bound is on how many
-- rows an item can have.
--
-- 0. Preconditions (catalog reads only, no table lock; 55000, or 42501 for
--    the owner and the applier; nothing applied): a. 0001-0148 applied
--    (0148's table and two functions, 0144's acceptances and their
--    validator, 0133's claims); b. already applied (the three bodies, both
--    columns and the new key: "0152: already applied", nothing changes);
--    c. no column, constraint or function of this file's names; d. every
--    column the new bodies read, by name and type; e. the two replaced
--    trigger functions (md5, attributes, no EXECUTE for anyone), 0133's
--    work-item claim and 0148's C2 (C2 strips null-valued keys, which R1
--    relies on; f61173d77be391a9e9c96db494827e82); and, by md5, every
--    function R4 and R6 call and every function the policies of
--    ehr.prescriptions, pharmacy.dispensings and pharmacy.work_items call
--    (the session readers, 0005's consent test and the consent grant,
--    0133 D5's source read, 0133's own-work halves, the patient's own read,
--    0143's and 0145's scans, the work items' and the dispensings' consent
--    tests and their route tests, the permission test), as 0101 pinned what
--    its FOR SHARE relies on; f. exactly one key on pharmacy.dispensings over
--    work_item_id alone, and no other unique index led by it; g. the five
--    triggers on pharmacy.dispensings as 0023, 0086, 0101 and 0133 left
--    them, with their modes (origin for the validator, the immutability
--    guard and 0086's route return; always for 0133's claim and key guard),
--    and no other; h. one owner (0148's e and f, for a NOSUPERUSER
--    NOBYPASSRLS owner, as production's): pharmacy.work_items' owner owns
--    pharmacy.dispensings, ehr.prescriptions and 0133's claims, the two
--    replaced functions and the policy functions R6 repeats and 0133 D5's
--    source read, and owns or may execute every other function above; the
--    applier is that owner, or inherits it and may SET ROLE to it; that
--    owner may create in pharmacy and use the schemas the bodies name;
--    i. row-level security as 0133 left it; j. 0133 D5's premise (no hid_
--    role a member of that owner). Every owner-run SECURITY DEFINER
--    function's catalog row and both altered tables' ACLs are kept for
--    section 7.
-- 1. Act as the owner for the rest of the transaction.
-- 2. Locks (below).
-- 3. Under the locks, what prints a key, a CHECK or a policy
--    (pg_get_constraintdef and pg_get_expr open the table they print for,
--    so before the locks they could wait behind DDL): 0023's key by its
--    definition; 0133 D14's claims CHECK (a dispensed claim is never
--    released: R5's and R6's premise); every policy of ehr.prescriptions,
--    pharmacy.dispensings and pharmacy.work_items exactly (name, command,
--    permissive, roles and both expressions, by md5 of their printed text;
--    so none is restrictive and no other is there); 0148's order of the
--    AFTER UPDATE triggers on ehr.prescriptions.
-- 4. R4 and R5, replaced (CREATE OR REPLACE keeps owner, ACL and triggers),
--    and their comments.
-- 5. R1 (column, CHECK NOT VALID, VALIDATE), R2 (column, CHECK NOT VALID,
--    VALIDATE), R3 (the new key, then 0023's dropped), and the comments.
-- 6. R6, its EXECUTE (revoked from PUBLIC; granted to the two runtimes that
--    exist) and its comment.
-- 7. Post-checks (55000, nothing applied): the three functions exactly
--    (md5, owner, attributes, result, ACL); R5 names no ehr.prescriptions and
--    R6 does (0133's S7 list gains R6 and nothing else: no other owner-run
--    definer made, replaced or dropped); both columns (type, null, default,
--    no column ACL); both CHECKs validated, exactly; the new key exactly and
--    0023's gone, and pharmacy.dispensings' unique indexes exactly three;
--    the five triggers and modes; 0148's AFTER UPDATE order on
--    ehr.prescriptions and C2's md5; owners, row-level security and both
--    tables' ACLs unchanged; a probe, undone: R6 refuses 201 ids and a null
--    array (it opens no table to do so).
--
-- Locks. Section 2, one DO block, each attempt in its own subtransaction:
-- ACCESS SHARE NOWAIT on pharmacy.work_items, ehr.order_routes and 0133's
-- claims (section 4's compile of R4 resolves the first two's row types;
-- section 3 prints the claims' CHECK and the work items' policies), then
-- ACCESS EXCLUSIVE NOWAIT on pharmacy.dispensings and ehr.prescriptions
-- (ALTER TABLE ADD COLUMN, ADD CONSTRAINT and DROP CONSTRAINT need it), so
-- an attempt that fails never holds the strong locks. Compiling R4 (CREATE
-- OR REPLACE FUNCTION runs plpgsql's validator) resolves its %ROWTYPE
-- declarations, which opens pharmacy.work_items, ehr.order_routes and
-- ehr.prescriptions; before the locks, a session holding ACCESS EXCLUSIVE on
-- one of them (DDL) made the file wait for the runner's 5 s lock_timeout and
-- fail with the server's message, which the dry run does not retry, so the
-- functions are replaced after the locks. A busy table fails the attempt at
-- once and its subtransaction releases what it took; the attempt is made
-- again every 100 ms for at most 5 seconds (50 attempts), then 55P03 "0152:
-- ... stayed busy for 5 seconds; nothing applied; ...". When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run of every pending file; its
-- own ledger table aside), one attempt and no sleep: 55P03 "0152: ... so it
-- does not wait; nothing applied; ..." at once (0148's rule; 0125's loop has
-- no such branch). Both texts end as the runner's busy-refusal pattern wants
-- (services/ehr-api/scripts/dry-run-attempts.mjs; its test feeds it this
-- file's texts). Sections 0 and 1 take no table lock (section 0 reads the
-- catalog only).
-- What the two ACCESS EXCLUSIVE locks block while held, from section 2 to
-- commit: every reader and writer of ehr.prescriptions and
-- pharmacy.dispensings, whatever the statement (a plain SELECT takes ACCESS
-- SHARE, which conflicts with ACCESS EXCLUSIVE), so for that time: ehr-api's
-- prescription list, read, create and PATCH, the chart and the patient's
-- own reads, "Ordered by me" (0143), ehr.send_order_route and 0133 D7's own
-- send and its withdrawal, and the order-route sync on any prescription
-- change; 0100's and 0144's acceptances and 0101's dispensing check (each
-- reads the prescription FOR SHARE: ROW SHARE, which waits too); every
-- pharmacy-api read that joins dispensings (the work list, an item, the
-- progress call, 0133's and 0144's readers, 0148's recorder on a
-- prescription change) and every dispensing and reversal (the reversal
-- guard reads the dispensing); and the insert of a pharmacy outbox event
-- whose own-work policy (0133's staff_own_work_insert on
-- pharmacy.outbox_events) reads pharmacy.dispensings to find a dispensing
-- event's work item, so pharmacy-api's own-work dispensing and reversal
-- events wait as well. They wait; none fails unless its own lock_timeout or
-- statement_timeout is shorter than the hold. The ACCESS SHARE locks block
-- only DDL on the work items, the routes and the claims; their reads and
-- writes go on. Behind an open reader or writer of either altered table, an
-- autovacuum or ANALYZE of either (SHARE UPDATE EXCLUSIVE), or DDL on any of
-- the five, the file stops after 5 seconds, nothing applied, and never
-- blocks them. In the dry run the locks last until the dry run ends.
-- pg_locks before commit, with either applier: ACCESS EXCLUSIVE on
-- pharmacy.dispensings, ehr.prescriptions, the new key's index and 0023's
-- dropped key's index (and the weaker locks VALIDATE and the index build
-- take on the same two tables), ACCESS SHARE on pharmacy.work_items,
-- ehr.order_routes and 0133's claims, and no other application table (R5's
-- and R6's statements are planned only when they first run, and the probe
-- of section 7 opens no table); after section 0, none.
-- Measured on throwaway PostgreSQL 16 with 0001-0146 and 0148 applied and
-- 20,000 prescriptions, own work items and dispensings (fictional data),
-- ten runs with a superuser applier and ten with a NOSUPERUSER NOBYPASSRLS
-- applier:
--   the file takes 40-84 ms to commit; the hold, from the locks to commit,
--   is 24-40 ms in all 20 runs. Under the locks: section 3 2.2-5.6 ms; R1
--   (the column, its CHECK and the scan of 20,000 prescriptions) 3.2-6.3
--   ms; on pharmacy.dispensings, the column 0.5-2.9 ms, its CHECK's scan
--   3.4-5.8 ms, the new key's index build 6.3-13.3 ms and 0023's key
--   dropped 0.3-0.6 ms; R6 and its grants 0.6-2.4 ms; the post-checks
--   5.6-11.6 ms; commit 0.6-1.2 ms. Section 0, before any lock, 13-45 ms;
--   behind another session's open read (ACCESS SHARE), write (ROW
--   EXCLUSIVE), SHARE UPDATE EXCLUSIVE (as autovacuum) or ACCESS EXCLUSIVE
--   on pharmacy.dispensings or on ehr.prescriptions, or ACCESS EXCLUSIVE on
--   pharmacy.work_items, ehr.order_routes or 0133's claims, the file stops
--   with section 2's 55P03 after 4.98-5.02 seconds (22 runs, both
--   appliers), nothing applied, while a third session reading prescriptions
--   (one FOR SHARE) and dispensings every 50 ms under a 200 ms lock_timeout
--   never fails (slowest read 5 ms; when the blocker is DDL on a table it
--   reads, its own reads wait for that, not for this file); with an earlier
--   migration's lock held in the same transaction it stops at once (17-21
--   ms) with the one-attempt text; an open reader of pharmacy.work_items, or
--   a writer of ehr.order_routes or of 0133's claims, does not stop it
--   (41-71 ms);
--   with this file's transaction held open before commit (either applier),
--   a read of a prescription, a FOR SHARE read of one, a read of a
--   dispensing and the Pharmacy runtime's own-work outbox insert (planned:
--   its policy reads pharmacy.dispensings) each wait (55P03 under a 100 ms
--   lock_timeout), while reads of the work items, the routes and the claims
--   and writes of the work items and the claims run at once;
--   the runner itself (NOSUPERUSER NOBYPASSRLS applier): its dry run, behind
--   an open reader of ehr.prescriptions released after 7 seconds, was
--   refused with this file's own text after 5 seconds, rolled back and
--   passed on its second attempt (6.9 s in all); its apply, behind a reader
--   held 12 seconds, stopped after 5.11 seconds with the same text, nothing
--   recorded, and applied once the reader was gone; a second run of the
--   file then says "already applied";
--   two refills of one item recorded at once (fill 2 each, two sessions as
--   pharmacy-api, after its read of the item's dispensings; R3, R4 and R5
--   as here): both hold the prescription FOR SHARE together, the second
--   waits on R3's key and, when the first commits, fails 23505 under READ
--   COMMITTED and 40001 under SERIALIZABLE (pharmacy-api's isolation); one
--   fill 2 is recorded;
--   R6 for 200 own items read by a pharmacist on the own-work basis (20,000
--   items in the facility, 200 with refills, 100 with a fill 2), 21 calls:
--   1.6-2.3 s (median 1.8 s) under the NOSUPERUSER NOBYPASSRLS owner, most
--   of it the row-level security of ehr.prescriptions on the 200 rows (1.3
--   s on its own; 0133 D5's source read and 0005's consent test run per
--   row), as 0125's reader costs about as much; 0.24-0.35 s (median 0.26
--   s) under a superuser owner.
--
-- Old services on this schema. Release A and B ehr-api: every INSERT and
-- read of ehr.prescriptions names its columns, so refills_allowed is null on
-- what they write and unread; 0100, 0101 (now R4) and 0133 read the row
-- through %ROWTYPE, which PostgreSQL re-resolves after ADD COLUMN, also in a
-- pooled connection (0125 proved it). Release A and B pharmacy-api: its
-- dispensing INSERT names its columns without fill_number, so it records
-- fill 1 exactly as before; its pre-check still answers a second dispensing
-- 409 PHARMACY_WORK_ITEM_ALREADY_DISPENSED, and a racing second one meets
-- R3's key (23505, as 0023's key answered); its reads map named fields, so
-- the new column is ignored, and it never calls R6. 0086's route return,
-- 0088's and 0090's wrong-patient voids (route-backed items, one fill) and
-- every 0133 and 0144 reader (they test whether a dispensing exists) answer
-- as before.
--
-- New services and rollback (Ola's answers). Release order: this file
-- (after 0147, 0148 and 0149-0151), then the event-dispatcher that accepts
-- fillNumber on MedicationDispensed, then pharmacy-api, then ehr-api and the
-- staff front ends; PRESCRIPTION_REFILLS_ENABLED (off by default, apart
-- from 0125's setting) goes on last, and only once both staff front ends
-- (health and apps/pharmacy) handle more than one fill. The first
-- refills-aware pharmacy-api reads one row per item whatever the setting
-- (the latest fill, fill numbers and R6), so it needs this file; only
-- recording a fill above 1 waits for the setting. Rollback floor: once any
-- refill is recorded, pharmacy-api must not roll back below that image (an
-- older image joins dispensings one row per fill and shows the item twice,
-- with an arbitrary fill's ids). Turning the setting off again stops new
-- refills; recorded fills stay.
--
-- Undo (by hand only; no release runs it). Refills stop first in the
-- services: PRESCRIPTION_REFILLS_ENABLED off. To stop them in the database
-- for every image, in one transaction:
-- 1. Replace pharmacy.validate_dispensing() with 0101's text and
--    pharmacy.claim_prescription_dispensing() with 0133's (CREATE OR REPLACE
--    keeps owner, ACL and triggers; compiling the validator opens three
--    tables with ACCESS SHARE, which waits only behind DDL). 0133's claim
--    function refuses any dispensing of an item whose claim is dispensed,
--    so no image can record a refill; recorded fills stay. R6 stays (it
--    still answers what was recorded; refill_open may read true where the
--    database now refuses, so the setting stays off). Precondition b then
--    no longer reads "already applied", and c refuses to apply the file
--    again while either column or R6 exists.
-- 2. Only if 0023's one-fill key must come back: in a quiet window, lock
--    pharmacy.dispensings ACCESS EXCLUSIVE NOWAIT, lift FORCE ROW LEVEL
--    SECURITY for that transaction only (as 0133 section 3c did; a count
--    under forced row-level security sees only the session's rows), refuse
--    if any row has fill_number > 1, then `add unique (work_item_id)`, drop
--    dispensings_work_item_fill_number_key and dispensings_fill_number_ck,
--    restore FORCE. Drop the column fill_number only after no running
--    pharmacy-api names it (none above the rollback floor may run then).
-- 3. drop function pharmacy.work_item_refills(uuid[]) only after no running
--    pharmacy-api calls it.
-- 4. ehr.prescriptions.refills_allowed and its CHECK can stay (nullable,
--    unread by old images). Drop them only after no running ehr-api names
--    the column and R6 is gone; dropping it changes the fingerprint of
--    every prescription that carried a value, so the first resume of such
--    an item after that reads 'edited'.
-- The ledger row stays.

-- 0. Preconditions.
do $$
declare
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  owner_oid oid;
  validator_owner oid;
begin
  -- a. 0001-0148 applied: 0148's table and its two functions (0148 checks
  -- 0001-0137 itself), and 0133's claims, which R5 reads.
  if (select count(*) from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
       where relation.relkind = 'r'
         and (namespace.nspname, relation.relname) in (('pharmacy', 'prescription_changes_after_dispensing'),
               ('pharmacy', 'prescription_item_claims'), ('pharmacy', 'work_item_acceptances'))) <> 3
     or (select count(distinct proc.oid) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where (namespace.nspname, proc.proname, pg_catalog.oidvectortypes(proc.proargtypes)) in (
                  ('pharmacy', 'prescription_change_after_dispensing', ''),
                  ('pharmacy', 'work_item_changes_after_dispensing', 'uuid[]'),
                  ('pharmacy', 'validate_work_item_acceptance', ''))) <> 3 then
    raise exception using errcode = '55000', message = '0152: 0001-0148 must be applied first';
  end if;
  -- b. Already applied: the three bodies are this file's, both columns and
  -- the new key are there. Nothing changes.
  if (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
       where namespace.nspname = 'pharmacy'
         and (proc.proname, md5(proc.prosrc)) in (('validate_dispensing', '61a927efcf0626ac434d2f894b319b4d'),
               ('claim_prescription_dispensing', '1a50612f5330a36c9b64d0d831c77812'),
               ('work_item_refills', '19870149098020ef3a39c51b562138eb'))) = 3
     and (select count(*) from pg_attribute attribute_row
           where not attribute_row.attisdropped
             and ((attribute_row.attrelid = 'ehr.prescriptions'::regclass and attribute_row.attname = 'refills_allowed')
               or (attribute_row.attrelid = 'pharmacy.dispensings'::regclass and attribute_row.attname = 'fill_number'))) = 2
     and exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'pharmacy.dispensings'::regclass
                    and constraint_row.conname = 'dispensings_work_item_fill_number_key') then
    raise exception using errcode = '55000', message = '0152: already applied';
  end if;
  -- c. Nothing of this file's names exists (a hand-made or half-undone
  -- schema): neither column, no constraint or index of the three names, no
  -- function named work_item_refills in pharmacy (any signature).
  select exists (select 1 from pg_attribute attribute_row
                  where not attribute_row.attisdropped
                    and ((attribute_row.attrelid = 'ehr.prescriptions'::regclass
                          and attribute_row.attname = 'refills_allowed')
                      or (attribute_row.attrelid = 'pharmacy.dispensings'::regclass
                          and attribute_row.attname = 'fill_number')))
      or exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conname in ('prescriptions_refills_allowed_ck', 'dispensings_fill_number_ck',
                          'dispensings_work_item_fill_number_key'))
      or exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = 'pharmacy' and relation.relname = 'dispensings_work_item_fill_number_key')
      or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = 'pharmacy' and proc.proname = 'work_item_refills')
    into found_absent;
  if found_absent then
    raise exception using errcode = '55000',
      message = '0152: ehr.prescriptions.refills_allowed, pharmacy.dispensings.fill_number, '
        || 'pharmacy.work_item_refills or a constraint of this file''s names exists already, but this file is not '
        || 'applied as a whole; nothing applied';
  end if;
  -- d. Every column the new bodies read, by name and type. The decision is
  -- an EXISTS over the absent columns (never null); the list only names them.
  with expected(schema_name, relation_name, column_names) as (values
         ('ehr', 'prescriptions', array['id uuid', 'patient_id uuid', 'facility_id uuid', 'encounter_id uuid',
           'status text', 'row_version bigint', 'ends_on date']),
         ('pharmacy', 'work_items', array['id uuid', 'patient_id uuid', 'facility_id uuid', 'order_route_id uuid',
           'source_ehr_prescription_id uuid', 'source_ehr_prescription_version bigint', 'source_encounter_id uuid']),
         ('pharmacy', 'dispensings', array['work_item_id uuid', 'patient_id uuid', 'facility_id uuid',
           'dispensed_at timestamp with time zone']),
         ('pharmacy', 'prescription_item_claims', array['work_item_id uuid', 'order_route_id uuid',
           'dispensed_at timestamp with time zone', 'released_at timestamp with time zone'])),
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
      message = format('0152: a column this migration relies on is missing or of another type: %s', missing);
  end if;
  -- e. The trigger functions relied on (md5 of pg_proc.prosrc); a function
  -- missing at its signature counts as a mismatch. The two replaced, as
  -- 0101 and 0133 left them, with their attributes (plpgsql, SECURITY
  -- DEFINER, VOLATILE, not STRICT, a trigger, their search_path) and no
  -- EXECUTE for anyone but the owner; 0133's work-item claim (every item has
  -- a claim, which R5 reads); 0148's C2, which strips null-valued keys (R1
  -- relies on it).
  with expected(proc_name, digest, search_path) as (values
         ('validate_dispensing', '17f7e8897bd2ab240332e4d2c9f757b7', 'search_path=pharmacy, platform, pg_temp'),
         ('claim_prescription_dispensing', '2c7f20d7c0df7c582bccc0291f452fdd', 'search_path=pg_catalog, pg_temp'),
         ('claim_prescription_work_item', 'c60a03a6aed78900827fc4c7654dd593', 'search_path=pg_catalog, pg_temp'),
         ('prescription_change_after_dispensing', 'f61173d77be391a9e9c96db494827e82',
           'search_path=pg_catalog, pg_temp')),
       differing as (
         select expected.proc_name,
                (select string_agg(format('md5=%s definer=%s volatile=%s strict=%s config=%s acl=%s', md5(proc.prosrc),
                          proc.prosecdef, proc.provolatile, proc.proisstrict, proc.proconfig, proc.proacl), ',')
                   from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = 'pharmacy' and proc.proname = expected.proc_name) as found
           from expected
          where not exists (
            select 1 from pg_proc proc
              join pg_namespace namespace on namespace.oid = proc.pronamespace
              join pg_language language_row on language_row.oid = proc.prolang
             where namespace.nspname = 'pharmacy' and proc.proname = expected.proc_name
               and pg_catalog.oidvectortypes(proc.proargtypes) = '' and md5(proc.prosrc) = expected.digest
               and language_row.lanname = 'plpgsql' and proc.prosecdef and proc.provolatile = 'v'
               and not proc.proisstrict and proc.prorettype = 'trigger'::regtype
               and proc.proconfig = array[expected.search_path]
               and not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
                                where privilege.grantee <> proc.proowner)))
  select exists (select 1 from differing),
         (select string_agg(format('pharmacy.%s(): %s', differing.proc_name, coalesce(differing.found, 'missing')), '; ')
            from differing)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0152: a function this migration relies on differs from 0001-0148: %s', missing);
  end if;
  -- e2. Every other function R4 and R6 call, and every function the
  -- policies of the three tables they read call (section 3 pins the
  -- policies themselves), by md5, as 0101 pinned what its FOR SHARE relies
  -- on. A function missing at its signature counts as a mismatch.
  with expected(schema_name, proc_name, argument_types, digest) as (values
         -- The session readers (R4: facility, account, membership; R6 and
         -- the consent tests: facility, actor, membership, purpose).
         ('platform', 'current_facility_id', '', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
         ('platform', 'current_account_id', '', 'b715ffe72856836d13ab16656fa6e94a'),
         ('platform', 'current_membership_id', '', '641989704fea95f885fbc38c6feb5aa5'),
         ('platform', 'current_actor_subject', '', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
         ('platform', 'current_purpose_of_use', '', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
         -- ehr.prescriptions' policies (0005's read, update and insert,
         -- 0133 D5's source read and lock, the patient's own read, 0143's
         -- and 0145's scans) and the consent grant behind them.
         ('ehr', 'context_allows', 'uuid, uuid, text', '75016690184a80bd246c365b4d108082'),
         ('identity', 'has_active_consent_grant', 'uuid, text, uuid, uuid, text, text, timestamp with time zone',
           '732d11892dd4e27e1ff9093ae3b7de5a'),
         ('pharmacy', 'own_work_source_prescription', 'uuid, uuid, uuid', '41a9afd4ea6f708425b98d1fb6e6eb87'),
         ('identity', 'facility_work_member_allows', 'text, uuid, uuid, text', '941d81ffe593640b321875ed329f65bb'),
         ('ehr', 'patient_self_context', 'uuid', '9878cfbd3dec68263d2e4bffc7cd9975'),
         ('ehr', 'my_orders_scan_open', '', '54aa32cfabfa5355531ca28726fdea97'),
         ('ehr', 'unknown_patient_cancel_scan_open', '', '6d83ddb31d99b8b735ba8ff2699b034d'),
         -- pharmacy.work_items' two read policies, which R6 repeats, and the
         -- own-work halves (also pharmacy.dispensings').
         ('pharmacy', 'work_item_allows', 'uuid, uuid, uuid, text', 'b710e0c6b66ce87c8c4a059ad435b774'),
         ('ehr', 'order_route_allows', 'uuid, uuid, text', 'b80c2df6c380f7c7e20d166da94e56d2'),
         ('identity', 'facility_work_session_membership', 'text', '36de1f00307dd5602972253b23f22f9f'),
         ('identity', 'pharmacy_work_patient_allows', 'uuid, uuid, uuid, text', 'cfc636db0a3457b5661adde458d4d07a'),
         -- pharmacy.dispensings' consent read and its route test.
         ('pharmacy', 'context_allows', 'uuid, uuid, text', '958a6e5cd2a534d158c82fe399b8f381'),
         ('ehr', 'order_route_access_allows', 'text, uuid, uuid, text', '175eff453979c964889283a29bb8f34f'),
         -- R6's permission test (C3's).
         ('auth', 'membership_has_permission', 'text, uuid, uuid, text', '65e3eaff93fe729fd5c5b986b80c9dd6')),
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
      message = format('0152: a function this migration relies on differs from 0001-0148: %s', missing);
  end if;
  -- f. 0023's key: exactly one unique constraint on pharmacy.dispensings over
  -- work_item_id alone (unnamed in 0023, so found by its column), and no
  -- other unique index whose first key is work_item_id (catalog only;
  -- section 3 reads its definition under the locks).
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.dispensings'::regclass and constraint_row.contype = 'u'
         and constraint_row.conkey = array[(select attribute_row.attnum from pg_attribute attribute_row
                                             where attribute_row.attrelid = 'pharmacy.dispensings'::regclass
                                               and attribute_row.attname = 'work_item_id')]::smallint[]) <> 1
     or (select count(*) from pg_index index_row
          where index_row.indrelid = 'pharmacy.dispensings'::regclass and index_row.indisunique
            and index_row.indkey[0] = (select attribute_row.attnum from pg_attribute attribute_row
                                        where attribute_row.attrelid = 'pharmacy.dispensings'::regclass
                                          and attribute_row.attname = 'work_item_id')) <> 1 then
    raise exception using errcode = '55000',
      message = '0152: pharmacy.dispensings does not have exactly one key on work_item_id alone (0023''s)';
  end if;
  -- g. The five triggers on pharmacy.dispensings, by name, function, type
  -- and mode, and no other (internal ones aside; catalog only).
  if (select array_agg(trigger_row.tgname::text || ':' || trigger_row.tgfoid::regprocedure::text || ':'
          || trigger_row.tgtype::text || ':' || trigger_row.tgenabled::text order by trigger_row.tgname::text collate "C")
        from pg_trigger trigger_row
       where trigger_row.tgrelid = 'pharmacy.dispensings'::regclass and not trigger_row.tgisinternal)
     is distinct from array[
       'dispensings_claim_prescription:pharmacy.claim_prescription_dispensing():5:A',
       'dispensings_order_route_return:pharmacy.return_order_route_dispensing():5:O',
       'pharmacy_dispensing_validate:pharmacy.validate_dispensing():7:O',
       'pharmacy_dispensings_immutable:pharmacy.reject_immutable_evidence():27:O',
       'prescription_claim_key_immutable:pharmacy.refuse_claim_key_change():19:A'] then
    raise exception using errcode = '55000',
      message = '0152: the triggers on pharmacy.dispensings are not the five 0023, 0086, 0101 and 0133 left';
  end if;
  -- h. One owner (0148's e and f), never through a superuser's bypass
  -- (production's owner and applier have neither superuser nor BYPASSRLS):
  -- pharmacy.work_items' owner owns pharmacy.dispensings and
  -- ehr.prescriptions (ALTER TABLE needs it), 0133's claims (R5 reads them
  -- unfiltered only as their owner), the two replaced functions (so R4, R5
  -- and R6 are the role 0133 D5's ehr.prescriptions policies name, which j
  -- keeps from every hid_ role), the work items' policy functions R6
  -- repeats and 0133 D5's source read; and owns or may execute every other
  -- function of e2 (the policies of the tables R6 reads run them as that
  -- owner under row-level security).
  owner_oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  validator_owner := (select proc.proowner from pg_proc proc where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure);
  with owned_tables(relation_name) as (values
         ('pharmacy.dispensings'), ('ehr.prescriptions'), ('pharmacy.prescription_item_claims')),
       owned_functions(signature) as (values
         ('pharmacy.validate_dispensing()'), ('pharmacy.claim_prescription_dispensing()'),
         ('pharmacy.work_item_allows(uuid,uuid,uuid,text)'), ('identity.facility_work_session_membership(text)'),
         ('identity.pharmacy_work_patient_allows(uuid,uuid,uuid,text)'),
         ('pharmacy.own_work_source_prescription(uuid,uuid,uuid)')),
       executed_functions(signature) as (values
         ('platform.current_facility_id()'), ('platform.current_account_id()'), ('platform.current_membership_id()'),
         ('platform.current_actor_subject()'), ('platform.current_purpose_of_use()'),
         ('ehr.context_allows(uuid,uuid,text)'),
         ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'),
         ('identity.facility_work_member_allows(text,uuid,uuid,text)'), ('ehr.patient_self_context(uuid)'),
         ('ehr.my_orders_scan_open()'), ('ehr.unknown_patient_cancel_scan_open()'),
         ('ehr.order_route_allows(uuid,uuid,text)'), ('pharmacy.context_allows(uuid,uuid,text)'),
         ('ehr.order_route_access_allows(text,uuid,uuid,text)'), ('auth.membership_has_permission(text,uuid,uuid,text)')),
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
  if owner_oid is null or found_absent or validator_owner is distinct from owner_oid then
    raise exception using errcode = '42501',
      message = format('0152: these are not owned by %s, the owner of pharmacy.work_items: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), coalesce(missing, 'pharmacy.validate_dispensing()'));
  end if;
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '42501',
      message = format('0152: %s must own, or inherit from and be able to SET ROLE to, %s, the owner of '
        || 'pharmacy.dispensings, ehr.prescriptions and the two functions this file replaces', current_user,
        pg_get_userbyid(owner_oid));
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
    raise exception using errcode = '42501', message = format('0152: %s lacks %s', pg_get_userbyid(owner_oid), missing);
  end if;
  -- i. Row-level security as 0133 left it: pharmacy.dispensings,
  -- ehr.prescriptions and pharmacy.work_items enabled and forced, 0133's
  -- claims enabled and not forced (R5 reads every claim in any session).
  if (select count(*) from pg_class relation
       where (relation.oid in ('pharmacy.dispensings'::regclass, 'ehr.prescriptions'::regclass,
                'pharmacy.work_items'::regclass)
              and relation.relrowsecurity and relation.relforcerowsecurity)
          or (relation.oid = 'pharmacy.prescription_item_claims'::regclass and relation.relrowsecurity
              and not relation.relforcerowsecurity)) <> 4 then
    raise exception using errcode = '55000',
      message = '0152: row-level security is not as 0133 left it (pharmacy.dispensings, ehr.prescriptions and '
        || 'pharmacy.work_items enabled and forced; 0133''s claims enabled and not forced)';
  end if;
  -- j. 0133 D5's premise: no hid_ role is a member of the role whose
  -- functions D5's two ehr.prescriptions policies let read prescriptions.
  select string_agg(role_row.rolname, ', ' order by role_row.rolname) into missing from pg_roles role_row
   where role_row.rolname like 'hid\_%' and role_row.oid <> validator_owner
     and pg_has_role(role_row.oid, validator_owner, 'MEMBER');
  if missing is not null then
    raise exception using errcode = '55000',
      message = format('0152: these roles are members of %s, which 0133 D5''s ehr.prescriptions policies name: %s',
        pg_get_userbyid(validator_owner), missing);
  end if;
  -- For section 7: every owner-run SECURITY DEFINER function's catalog row
  -- (oid and row version), so only the two replaced may change and only R6
  -- may be made, and none dropped; and both altered tables' ACLs.
  perform set_config('refills_0152.definer_rows',
    coalesce((select string_agg(proc.oid::text || ':' || proc.xmin::text, ' ' order by proc.oid)
                from pg_proc proc
               where proc.prosecdef and proc.proowner = validator_owner
                 and proc.oid not in ('pharmacy.validate_dispensing()'::regprocedure,
                       'pharmacy.claim_prescription_dispensing()'::regprocedure)), 'none'), true);
  perform set_config('refills_0152.table_acls',
    (select string_agg(relation.oid::regclass::text || '=' || coalesce(relation.relacl::text, 'default'), ' '
              order by relation.oid::regclass::text)
       from pg_class relation where relation.oid in ('pharmacy.dispensings'::regclass, 'ehr.prescriptions'::regclass)),
    true);
  raise notice '0152: preconditions checked; applier %; owner %', current_user, pg_get_userbyid(owner_oid);
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

-- 2. Locks (see Locks), NOWAIT, at most 5 s: ACCESS SHARE on the three
-- tables sections 3 and 4 open, then ACCESS EXCLUSIVE on the two this file
-- alters, so an attempt that fails never holds the strong ones. A failed
-- attempt's subtransaction releases what it took. When this transaction
-- already holds a lock that stops other sessions' reads or writes of a table
-- (an earlier migration in the same transaction, as in the runner's dry run
-- of every pending file; the runner's own ledger table aside), one attempt
-- only and no sleep, so no request queues behind those locks while this file
-- waits.
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
      lock table pharmacy.work_items, ehr.order_routes, pharmacy.prescription_item_claims in access share mode nowait;
      lock table pharmacy.dispensings, ehr.prescriptions in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0152: pharmacy.dispensings, ehr.prescriptions or a table 0152 reads (the Pharmacy work items, '
            || 'the order routes or 0133''s claims) is busy, and this transaction already holds an earlier '
            || 'migration''s locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0152: pharmacy.dispensings, ehr.prescriptions or a table 0152 reads (the Pharmacy work items, '
            || 'the order routes or 0133''s claims) stayed busy for 5 seconds; nothing applied; run the release '
            || 'again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;

-- 3. Under the locks: what prints a key, a CHECK or a policy (pg_get_expr
-- and pg_get_constraintdef open the table they print for; every table
-- printed here is held by section 2). Each failure raises 55000 and nothing
-- is applied.
do $$
declare
  work_item_key name;
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  mismatch text;
begin
  -- a. 0023's key by its definition, kept for section 5.
  select constraint_row.conname into work_item_key from pg_constraint constraint_row
   where constraint_row.conrelid = 'pharmacy.dispensings'::regclass and constraint_row.contype = 'u'
     and pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (work_item_id)';
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.dispensings'::regclass and constraint_row.contype = 'u'
         and pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (work_item_id)') <> 1 then
    raise exception using errcode = '55000',
      message = '0152: pharmacy.dispensings does not have exactly one key printed UNIQUE (work_item_id)';
  end if;
  perform set_config('refills_0152.work_item_key', work_item_key, true);
  -- b. 0133 D14's CHECK: a released claim was never dispensed, so a
  -- dispensed claim is never released. R5's refill branch and R6's open
  -- refill rest on it (an own item with a fill has a live claim).
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.prescription_item_claims'::regclass and constraint_row.contype = 'c'
         and constraint_row.convalidated
         and pg_get_constraintdef(constraint_row.oid)
             = 'CHECK (((released_at IS NULL) OR ((order_route_id IS NULL) AND (dispensed_at IS NULL))))') <> 1 then
    raise exception using errcode = '55000',
      message = '0152: pharmacy.prescription_item_claims does not have 0133''s CHECK that a dispensed claim is never '
        || 'released';
  end if;
  -- c. Every policy of ehr.prescriptions (R4 reads it FOR SHARE, R6 reads
  -- it), pharmacy.dispensings and pharmacy.work_items (R6 reads both), each
  -- by name and the md5 of its command, permissive flag, roles (PUBLIC, or
  -- the owner alone) and printed expressions: the policies 0005, 0023,
  -- 0086, 0133, 0143 and 0145 left, none restrictive, no other.
  with expected(relation_name, policy_name, digest) as (values
         ('ehr.prescriptions', 'prescriptions_cancel_check_read', '9f3f55cb0a7f48717809b4fd3e09781f'),
         ('ehr.prescriptions', 'prescriptions_insert', '6a0815669a3c5ccca1130bef9ab321d7'),
         ('ehr.prescriptions', 'prescriptions_own_pharmacy_source_lock', '5a912466d8fd057508766527c0de33e7'),
         ('ehr.prescriptions', 'prescriptions_own_pharmacy_source_read', '284620c0a29687a51437bf2a3549316d'),
         ('ehr.prescriptions', 'prescriptions_patient_self_read', '77bc15e1c970d60476140116bde74188'),
         ('ehr.prescriptions', 'prescriptions_read', '194d26e1ca9e954026727f7cbbb92c1d'),
         ('ehr.prescriptions', 'prescriptions_scan_my_orders', '4d0110ea7ab81ec4c889c98db45e0b45'),
         ('ehr.prescriptions', 'prescriptions_update', 'fc4e2fd2f07d592aefd1a23c2895da2b'),
         ('pharmacy.dispensings', 'pharmacy_dispensings_insert', 'f06c4b223b1c855434f14f96187288a4'),
         ('pharmacy.dispensings', 'pharmacy_dispensings_read', '50a418e05b8937b1f5386730f031e7f9'),
         ('pharmacy.dispensings', 'staff_own_work_insert', '2c003ec37d0d27856f7cf993b0dac391'),
         ('pharmacy.dispensings', 'staff_own_work_read', 'cb45d26770956bd1b62e735565f334d1'),
         ('pharmacy.work_items', 'pharmacy_work_items_insert', 'ad22de4e47f475c209e7e79c8134eed5'),
         ('pharmacy.work_items', 'pharmacy_work_items_read', '14670758ef7af96dc84c324c2053f2e7'),
         ('pharmacy.work_items', 'staff_own_work_read', 'a97eccd35eb781a878c0f47f873f63a0')),
       present as (
         select case policy_row.polrelid when 'ehr.prescriptions'::regclass then 'ehr.prescriptions'
                  when 'pharmacy.dispensings'::regclass then 'pharmacy.dispensings'
                  else 'pharmacy.work_items' end as relation_name, policy_row.polname::text as policy_name,
                md5(policy_row.polcmd::text || ':' || policy_row.polpermissive::text || ':'
                    || case when policy_row.polroles = array[0::oid] then 'public'
                            when policy_row.polroles = array[owner_oid] then 'owner'
                            else policy_row.polroles::text end || ':'
                    || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-') || ':'
                    || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '-')) as digest
           from pg_policy policy_row
          where policy_row.polrelid in ('ehr.prescriptions'::regclass, 'pharmacy.dispensings'::regclass,
                  'pharmacy.work_items'::regclass)),
       differing as (
         select coalesce(expected.relation_name, present.relation_name) || '.'
                || coalesce(expected.policy_name, present.policy_name) as what
           from expected full join present
             on present.relation_name = expected.relation_name and present.policy_name = expected.policy_name
          where expected.digest is distinct from present.digest)
  select string_agg(differing.what, ', ' order by differing.what) into mismatch from differing;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0152: the policies of ehr.prescriptions, pharmacy.dispensings or pharmacy.work_items are not '
        || 'the ones 0001-0148 left: %s', mismatch);
  end if;
  -- d. The AFTER UPDATE triggers on ehr.prescriptions end with 0086's
  -- route sync, 0133 D8's and 0148's C4, in the order PostgreSQL fires them
  -- (this file adds none; 0148's post-check order).
  if (select array_agg(ordered.tgname::text order by ordered.position desc)
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
      message = '0152: the AFTER UPDATE triggers on ehr.prescriptions do not end as 0148 left them';
  end if;
end
$$;

-- 4. R4 and R5, replaced under section 2's locks: CREATE OR REPLACE keeps
-- the owner, the ACL and the triggers. Compiling R4 resolves its three
-- %ROWTYPE declarations, which opens pharmacy.work_items, ehr.order_routes
-- and ehr.prescriptions (ACCESS SHARE), so it comes after the locks and never
-- waits. R4: 0101's text, with the refill block added before its RETURN.
create or replace function pharmacy.validate_dispensing()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  parent_row pharmacy.work_items%rowtype;
  route_row ehr.order_routes%rowtype;
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
  source_row ehr.prescriptions%rowtype;
begin
  select * into parent_row from pharmacy.work_items where id = new.work_item_id;
  if parent_row.order_route_id is not null then
    select route.* into route_row from ehr.order_routes route where route.id = parent_row.order_route_id for update;
    if route_row.id is null or route_row.state is distinct from 'accepted'
       or not coalesce(clock_timestamp() < route_row.writes_end_at, false) then
      raise exception using errcode = '23514', message = 'ORDER_ROUTE_CLOSED';
    end if;
  end if;
  if parent_row.id is null
     or session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or parent_row.patient_id is distinct from new.patient_id
     or parent_row.facility_id is distinct from new.facility_id
     or parent_row.row_version is distinct from new.work_item_version
     or parent_row.medication_code_system is distinct from new.medication_code_system
     or parent_row.medication_code is distinct from new.medication_code
     or parent_row.medication_display is distinct from new.medication_display
     or new.facility_id is distinct from session_facility_id
     or new.dispensed_by is distinct from session_account_id
     or new.dispensed_by_membership_id is distinct from session_membership_id then
    raise exception using errcode = '23514',
      message = 'Dispensing does not match its eligible Pharmacy work item and actor context';
  end if;
  -- Same facility: dispensable only while the EHR prescription the work item
  -- names is still active, at the version Pharmacy accepted, for its patient,
  -- facility and encounter. Read FOR SHARE until commit, so the EHR cannot
  -- cancel or change it under the dispensing. Read as this function's owner:
  -- under production's forced row-level security only a prescription the
  -- session may read and write is found, and any other is not dispensable.
  if parent_row.order_route_id is null then
    select prescription.* into source_row
      from ehr.prescriptions prescription
     where prescription.id = parent_row.source_ehr_prescription_id
       for share;
    if source_row.id is null
       or source_row.patient_id is distinct from parent_row.patient_id
       or source_row.facility_id is distinct from parent_row.facility_id
       or source_row.encounter_id is distinct from parent_row.source_encounter_id
       or source_row.status is distinct from 'active'
       or source_row.row_version is distinct from parent_row.source_ehr_prescription_version then
      raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE';
    end if;
  end if;
  -- Refills (ORD-12): fill 1 is checked as above and nothing more. A later
  -- fill only on an own item (a route-backed item takes one fill), at most
  -- 1 + refills_allowed fills (null: none), and not once the prescription
  -- read above has ended (ends_on before today in Lagos; ends_on is the last
  -- day).
  if new.fill_number > 1 then
    if parent_row.order_route_id is not null
       or new.fill_number > 1 + coalesce(source_row.refills_allowed, 0) then
      raise exception using errcode = '23514', message = 'NO_REFILLS_LEFT';
    end if;
    if source_row.ends_on < (clock_timestamp() at time zone 'Africa/Lagos')::date then
      raise exception using errcode = '23514', message = 'REFILL_PRESCRIPTION_ENDED';
    end if;
  end if;
  return new;
end
$$;

-- R5: fill 1 as 0133 D14 made it; a refill needs the item's live, dispensed,
-- own claim, and leaves dispensed_at (the first fill's) as it is.
create or replace function pharmacy.claim_prescription_dispensing()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.fill_number = 1 then
    update pharmacy.prescription_item_claims claim
       set dispensed_at = new.dispensed_at
     where claim.work_item_id = new.work_item_id and claim.released_at is null and claim.dispensed_at is null;
  else
    perform 1 from pharmacy.prescription_item_claims claim
     where claim.work_item_id = new.work_item_id and claim.released_at is null and claim.dispensed_at is not null
       and claim.order_route_id is null;
  end if;
  if not found then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE',
      detail = case when exists (select 1 from pharmacy.prescription_item_claims claim
                                  where claim.work_item_id = new.work_item_id and claim.released_at is not null)
                    then 'sent_elsewhere' else 'not_claimed' end;
  end if;
  return null;
end;
$$;

comment on function pharmacy.validate_dispensing() is
  '0101, refills by 0152 (ORD-12): a route-backed work item is dispensable only while its route is accepted and inside its work window (0086, ORDER_ROUTE_CLOSED); the dispensing must match its work item and the session (0077); a same-facility work item is dispensable only while its ehr.prescriptions row, read FOR SHARE, is active at the version accepted, for its patient, facility and encounter (23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE). A fill_number above 1: own items only, at most 1 + refills_allowed fills (null: none), else 23514 NO_REFILLS_LEFT; not once ends_on is before today in Lagos (23514 REFILL_PRESCRIPTION_ENDED). Origin mode only.';
comment on function pharmacy.claim_prescription_dispensing() is
  '0133 D14, refills by 0152 (ORD-12): fill 1 turns the item''s live, undispensed claim dispensed (dispensed_at, kept for good); a later fill needs that claim live, dispensed and the item''s own (no order route) and changes nothing; else 23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE, DETAIL sent_elsewhere or not_claimed. Enabled always; reads only the claims. Executed by no role.';

-- 5. R1: the column and its CHECK, NOT VALID, then validated (one scan of
-- ehr.prescriptions, under the lock taken above).
alter table ehr.prescriptions
  add column refills_allowed smallint,
  add constraint prescriptions_refills_allowed_ck
    check (refills_allowed is null or refills_allowed between 0 and 11) not valid;
alter table ehr.prescriptions validate constraint prescriptions_refills_allowed_ck;

-- R2: the column (every existing row reads the default 1, no rewrite) and
-- its CHECK, NOT VALID, then validated (one scan of pharmacy.dispensings).
alter table pharmacy.dispensings
  add column fill_number smallint not null default 1,
  add constraint dispensings_fill_number_ck check (fill_number between 1 and 12) not valid;
-- R2's scan.
alter table pharmacy.dispensings validate constraint dispensings_fill_number_ck;

-- R3: the key on (work_item_id, fill_number) (its index built by one scan of
-- pharmacy.dispensings), then 0023's key on work_item_id alone dropped by the
-- name section 3 found.
alter table pharmacy.dispensings
  add constraint dispensings_work_item_fill_number_key unique (work_item_id, fill_number);
-- R3's drop.
do $$
begin
  execute format('alter table pharmacy.dispensings drop constraint %I',
    current_setting('refills_0152.work_item_key'));
end
$$;

comment on column ehr.prescriptions.refills_allowed is
  'ORD-12 (0152): how many refills the prescriber allowed after the first fill, 0-11; null means none. Set at creation only (ehr-api never changes it). The hospital''s own pharmacy may record 1 + refills_allowed fills of the one work item while the prescription stays active and unchanged and its ends_on is not past.';
comment on constraint prescriptions_refills_allowed_ck on ehr.prescriptions is
  'ORD-12 (0152): refills_allowed is null or 0-11.';
comment on column pharmacy.dispensings.fill_number is
  'ORD-12 (0152): 1 for the first fill of the work item, 2 and above for refills (at most 12). Rows recorded before 0152 are fill 1. A reversed fill keeps its number.';
comment on constraint dispensings_fill_number_ck on pharmacy.dispensings is
  'ORD-12 (0152): fill_number is 1-12 (one fill and at most 11 refills).';
comment on constraint dispensings_work_item_fill_number_key on pharmacy.dispensings is
  'ORD-12 (0152): one dispensing per fill number of a work item; replaces 0023''s one dispensing per work item, and stops a second fill recorded with the same number at the same time (23505).';

-- 6. R6, the reader (see R6 above). The session must hold
-- pharmacy.work-item.read (the consent branch of pharmacy.work_item_allows
-- checks no permission); a predicate, not an early return, as 0148's C3.
-- The work items are found first (at most 200, by their key), so the
-- policy tests and the reads of their prescriptions and fills run only for
-- the requested own items. The prescription and the fills are matched on
-- the item's patient and facility, so a row the tables' own policies would
-- hide from a NOBYPASSRLS owner is not counted by a superuser owner either.
create function pharmacy.work_item_refills(requested_work_item_ids uuid[])
returns table (work_item_id uuid, refills_allowed integer, fills_recorded integer, refill_open boolean,
  closed_reason text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
  may_read boolean;
  own_work_membership uuid;
  lagos_today date := (pg_catalog.clock_timestamp() at time zone 'Africa/Lagos')::date;
begin
  if requested_work_item_ids is null or pg_catalog.cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'WORK_ITEM_REFILLS_INVALID';
  end if;
  if session_facility is null then
    return;
  end if;
  may_read := coalesce(auth.membership_has_permission(platform.current_actor_subject(),
    platform.current_membership_id(), session_facility, 'pharmacy.work-item.read'), false);
  own_work_membership := identity.facility_work_session_membership('pharmacy');
  return query
    with visible as materialized (
      select item.id as item_id, item.patient_id as item_patient_id, item.facility_id as item_facility_id,
             item.source_ehr_prescription_id as source_id,
             item.source_ehr_prescription_version as source_version,
             item.source_encounter_id as source_encounter_id
        from pharmacy.work_items item
       where may_read
         and item.id = any(requested_work_item_ids)
         and item.facility_id = session_facility
         and item.order_route_id is null
         and (pharmacy.work_item_allows(item.patient_id, item.facility_id, item.order_route_id, 'read_records')
           or (coalesce(identity.pharmacy_work_patient_allows(own_work_membership, item.patient_id,
                 item.facility_id, 'read_records'), false)
               and item.order_route_id is null))),
    facts as (
      select visible.item_id,
             coalesce(prescription.refills_allowed, 0)::integer as allowed,
             (select count(*) from pharmacy.dispensings dispensing
               where dispensing.work_item_id = visible.item_id
                 and dispensing.patient_id = visible.item_patient_id
                 and dispensing.facility_id = visible.item_facility_id)::integer as recorded,
             prescription.status is distinct from 'active' as stopped,
             (prescription.row_version is distinct from visible.source_version
               or prescription.encounter_id is distinct from visible.source_encounter_id) as changed,
             coalesce(prescription.ends_on < lagos_today, false) as ended
        from visible
        left join ehr.prescriptions prescription
          on prescription.id = visible.source_id
         and prescription.patient_id = visible.item_patient_id
         and prescription.facility_id = visible.item_facility_id)
    select facts.item_id, facts.allowed, facts.recorded,
           facts.recorded >= 1 and facts.recorded < 1 + facts.allowed
             and not facts.stopped and not facts.changed and not facts.ended,
           case
             when facts.recorded = 0 then null
             when facts.recorded >= 1 + facts.allowed then 'none_left'
             when facts.stopped then 'stopped'
             when facts.changed then 'changed'
             when facts.ended then 'ended'
           end
      from facts;
end;
$$;

-- R6's EXECUTE (here and in runtime-grants.sql): to each of the two
-- runtimes that exists, nothing to PUBLIC.
revoke all on function pharmacy.work_item_refills(uuid[]) from public;
do $$
declare runtime_role text;
begin
  foreach runtime_role in array array['hid_pharmacy_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function pharmacy.work_item_refills(uuid[]) to %I', runtime_role);
    end if;
  end loop;
end
$$;
comment on function pharmacy.work_item_refills(uuid[]) is
  '0152 ORD-12: for each requested own work item (no order route) the session may read (its facility, pharmacy.work-item.read, and pharmacy.work_items'' two read policies repeated), refills_allowed (null as 0), fills_recorded (reversed fills included), refill_open (a fill recorded, fewer than 1 + refills_allowed, the prescription active at the accepted version and ends_on not before today in Lagos; PRESCRIPTION_REFILLS_ENABLED is pharmacy-api''s to add) and closed_reason (none_left, stopped, changed or ended; null while open and before the first fill). At most 200 ids, else 22023 WORK_ITEM_REFILLS_INVALID.';

-- 7. Post-checks (still under the locks).
do $$
declare
  found_absent boolean;
  mismatch text;
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  error_state text;
  error_message text;
begin
  -- R4, R5 and R6: exactly one function of each name, this file's body
  -- (md5), the owner, SECURITY DEFINER, the volatility, plpgsql, not
  -- STRICT, the result, the search_path each had; R4 and R5 no EXECUTE for
  -- anyone but the owner (R6's grants below).
  with expected(proc_name, argument_types, digest, volatility, result_type, search_path) as (values
         ('validate_dispensing', '', '61a927efcf0626ac434d2f894b319b4d', 'v', 'trigger',
           'search_path=pharmacy, platform, pg_temp'),
         ('claim_prescription_dispensing', '', '1a50612f5330a36c9b64d0d831c77812', 'v', 'trigger',
           'search_path=pg_catalog, pg_temp'),
         ('work_item_refills', 'uuid[]', '19870149098020ef3a39c51b562138eb', 's',
           'TABLE(work_item_id uuid, refills_allowed integer, fills_recorded integer, refill_open boolean, '
             || 'closed_reason text)', 'search_path=pg_catalog, pg_temp')),
       differing as (
         select expected.proc_name,
                (select string_agg(format('md5=%s owner=%s definer=%s volatile=%s strict=%s config=%s acl=%s',
                          md5(proc.prosrc), pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
                          proc.proisstrict, proc.proconfig, proc.proacl), ',')
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
                  and md5(proc.prosrc) = expected.digest
                  and proc.proowner = owner_oid and proc.prosecdef and proc.provolatile = expected.volatility::"char"
                  and language_row.lanname = 'plpgsql' and not proc.proisstrict
                  and pg_get_function_result(proc.oid) = expected.result_type
                  and proc.proconfig = array[expected.search_path]
                  and (expected.proc_name = 'work_item_refills'
                    or not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
                                    where privilege.grantee <> proc.proowner))))
  select exists (select 1 from differing),
         (select string_agg(format('pharmacy.%s: %s', differing.proc_name, coalesce(differing.found, 'missing')), '; ')
            from differing)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000', message = format('0152: functions are not as this file makes them: %s', mismatch);
  end if;
  -- R6's exact EXECUTE grants: to each of the two runtimes that exists (not
  -- grantable), nothing else, PUBLIC included. Decided by EXISTS, so a role
  -- that does not exist never makes a comparison null.
  with expected(grantee_name) as (values ('hid_pharmacy_runtime'), ('hid_schema_test_runtime')),
       granted as (
         select privilege.grantee, privilege.privilege_type, privilege.is_grantable
           from pg_proc proc
          cross join aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
          where proc.oid = 'pharmacy.work_item_refills(uuid[])'::regprocedure and privilege.grantee <> proc.proowner),
       wrong as (
         select format('granted %s to %s', granted.privilege_type,
                  case when granted.grantee = 0 then 'PUBLIC' else pg_get_userbyid(granted.grantee)::text end) as what
           from granted
          where not exists (select 1 from expected join pg_roles role_row on role_row.rolname = expected.grantee_name
                             where role_row.oid = granted.grantee and granted.privilege_type = 'EXECUTE'
                               and not granted.is_grantable)
         union all
         select format('lacks EXECUTE for %s', expected.grantee_name)
           from expected join pg_roles role_row on role_row.rolname = expected.grantee_name
          where not exists (select 1 from granted
                             where granted.grantee = role_row.oid and granted.privilege_type = 'EXECUTE'))
  select exists (select 1 from wrong), (select string_agg(wrong.what, '; ') from wrong)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0152: pharmacy.work_item_refills(uuid[])''s grants are not section 6''s: %s', mismatch);
  end if;
  -- 0133 D5: R5 names no ehr.prescriptions; R6 does, so 0133's S7 list (the
  -- owner-run definers whose text names ehr.prescriptions) gains R6 (R4 is
  -- on it already); no other owner-run SECURITY DEFINER function was made,
  -- replaced or dropped, so the list is otherwise the one there was; 0148's
  -- C2 unchanged.
  if exists (select 1 from pg_proc proc where proc.oid = 'pharmacy.claim_prescription_dispensing()'::regprocedure
              and proc.prosrc ~* 'ehr\.prescriptions')
     or not exists (select 1 from pg_proc proc where proc.oid = 'pharmacy.work_item_refills(uuid[])'::regprocedure
                     and proc.prosrc ~* 'ehr\.prescriptions')
     or coalesce((select string_agg(proc.oid::text || ':' || proc.xmin::text, ' ' order by proc.oid)
                    from pg_proc proc
                   where proc.prosecdef and proc.proowner = owner_oid
                     and proc.oid not in ('pharmacy.validate_dispensing()'::regprocedure,
                           'pharmacy.claim_prescription_dispensing()'::regprocedure,
                           'pharmacy.work_item_refills(uuid[])'::regprocedure)), 'none')
        is distinct from nullif(current_setting('refills_0152.definer_rows', true), '')
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = 'pharmacy.prescription_change_after_dispensing()'::regprocedure)
        is distinct from 'f61173d77be391a9e9c96db494827e82' then
    raise exception using errcode = '55000',
      message = '0152: the claim function names ehr.prescriptions, the reader does not, or an owner-run definer '
        || 'function other than this file''s three was made, replaced or dropped, or 0148''s recorder changed';
  end if;
  -- R1 and R2: the columns' types, NOT NULL, defaults, no generation or
  -- identity, and no column-level privilege.
  if (select array_agg(attribute_row.attrelid::regclass::text || '.' || attribute_row.attname::text || ':'
          || format_type(attribute_row.atttypid, attribute_row.atttypmod) || ':' || attribute_row.attnotnull::text || ':'
          || coalesce(pg_get_expr(column_default.adbin, column_default.adrelid), '-') || ':'
          || (attribute_row.attgenerated = '' and attribute_row.attidentity = '' and attribute_row.attacl is null)::text
          order by attribute_row.attrelid::regclass::text)
        from pg_attribute attribute_row
        left join pg_attrdef column_default
          on column_default.adrelid = attribute_row.attrelid and column_default.adnum = attribute_row.attnum
       where not attribute_row.attisdropped
         and ((attribute_row.attrelid = 'ehr.prescriptions'::regclass and attribute_row.attname = 'refills_allowed')
           or (attribute_row.attrelid = 'pharmacy.dispensings'::regclass and attribute_row.attname = 'fill_number')))
     is distinct from array['ehr.prescriptions.refills_allowed:smallint:false:-:true',
       'pharmacy.dispensings.fill_number:smallint:true:1:true'] then
    raise exception using errcode = '55000', message = '0152: the columns are not as this file makes them';
  end if;
  -- The two CHECKs, validated, exactly; the new key exactly (not
  -- deferrable) and 0023's gone; pharmacy.dispensings' unique indexes are
  -- its primary key, 0023's idempotency key and the new key, all valid.
  if (select array_agg(constraint_row.conrelid::regclass::text || ' ' || constraint_row.conname::text || ' '
          || pg_get_constraintdef(constraint_row.oid) || ' ' || constraint_row.convalidated::text || ' '
          || constraint_row.condeferrable::text order by constraint_row.conname::text collate "C")
        from pg_constraint constraint_row
       where constraint_row.conname in ('prescriptions_refills_allowed_ck', 'dispensings_fill_number_ck',
               'dispensings_work_item_fill_number_key'))
     is distinct from array[
       'pharmacy.dispensings dispensings_fill_number_ck CHECK (((fill_number >= 1) AND (fill_number <= 12))) true false',
       'pharmacy.dispensings dispensings_work_item_fill_number_key UNIQUE (work_item_id, fill_number) true false',
       'ehr.prescriptions prescriptions_refills_allowed_ck CHECK (((refills_allowed IS NULL) OR ((refills_allowed >= 0) '
         || 'AND (refills_allowed <= 11)))) true false']
     or exists (select 1 from pg_constraint constraint_row
                 where constraint_row.conrelid = 'pharmacy.dispensings'::regclass
                   and pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (work_item_id)')
     or (select array_agg(pg_get_indexdef(index_row.indexrelid) || ' ' || (index_row.indisvalid and index_row.indisready)::text
            order by pg_get_indexdef(index_row.indexrelid) collate "C")
           from pg_index index_row
          where index_row.indrelid = 'pharmacy.dispensings'::regclass and index_row.indisunique)
        is distinct from array[
          'CREATE UNIQUE INDEX dispensings_facility_id_dispensed_by_idempotency_key_key ON pharmacy.dispensings USING '
            || 'btree (facility_id, dispensed_by, idempotency_key) true',
          'CREATE UNIQUE INDEX dispensings_pkey ON pharmacy.dispensings USING btree (id) true',
          'CREATE UNIQUE INDEX dispensings_work_item_fill_number_key ON pharmacy.dispensings USING btree (work_item_id, '
            || 'fill_number) true'] then
    raise exception using errcode = '55000',
      message = '0152: the CHECKs or the keys of pharmacy.dispensings and ehr.prescriptions are not as this file makes them';
  end if;
  -- The five triggers on pharmacy.dispensings and their modes, as before.
  if (select array_agg(trigger_row.tgname::text || ':' || trigger_row.tgfoid::regprocedure::text || ':'
          || trigger_row.tgtype::text || ':' || trigger_row.tgenabled::text order by trigger_row.tgname::text collate "C")
        from pg_trigger trigger_row
       where trigger_row.tgrelid = 'pharmacy.dispensings'::regclass and not trigger_row.tgisinternal)
     is distinct from array[
       'dispensings_claim_prescription:pharmacy.claim_prescription_dispensing():5:A',
       'dispensings_order_route_return:pharmacy.return_order_route_dispensing():5:O',
       'pharmacy_dispensing_validate:pharmacy.validate_dispensing():7:O',
       'pharmacy_dispensings_immutable:pharmacy.reject_immutable_evidence():27:O',
       'prescription_claim_key_immutable:pharmacy.refuse_claim_key_change():19:A'] then
    raise exception using errcode = '55000', message = '0152: the triggers on pharmacy.dispensings changed';
  end if;
  -- 0148's order of the AFTER UPDATE triggers on ehr.prescriptions; the
  -- owners, row-level security and both tables' ACLs as before.
  if (select array_agg(ordered.tgname::text order by ordered.position desc)
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
       'prescriptions_own_pharmacy_send_withdrawn', 'prescriptions_order_routes_sync']
     or (select count(*) from pg_class relation
          where relation.oid in ('pharmacy.dispensings'::regclass, 'ehr.prescriptions'::regclass)
            and relation.relowner = owner_oid and relation.relrowsecurity and relation.relforcerowsecurity) <> 2
     or (select string_agg(relation.oid::regclass::text || '=' || coalesce(relation.relacl::text, 'default'), ' '
                  order by relation.oid::regclass::text)
           from pg_class relation where relation.oid in ('pharmacy.dispensings'::regclass, 'ehr.prescriptions'::regclass))
        is distinct from current_setting('refills_0152.table_acls', true) then
    raise exception using errcode = '55000',
      message = '0152: the AFTER UPDATE triggers on ehr.prescriptions, or the owner, row-level security or ACL of '
        || 'pharmacy.dispensings or ehr.prescriptions, changed';
  end if;
  -- The probe, undone (its own subtransaction): R6 refuses 201 ids and a
  -- null array before it reads anything (it opens no table to do so).
  begin
    perform pharmacy.work_item_refills(array(select gen_random_uuid() from generate_series(1, 201)));
    error_state := 'no error';
  exception when others then
    get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '22023' or error_message is distinct from 'WORK_ITEM_REFILLS_INVALID' then
    raise exception using errcode = '55000',
      message = format('0152: the reader must refuse 201 ids with 22023 WORK_ITEM_REFILLS_INVALID; it answered %s %s',
        error_state, coalesce(error_message, ''));
  end if;
  error_state := null;
  error_message := null;
  begin
    perform pharmacy.work_item_refills(null);
    error_state := 'no error';
  exception when others then
    get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '22023' or error_message is distinct from 'WORK_ITEM_REFILLS_INVALID' then
    raise exception using errcode = '55000',
      message = format('0152: the reader must refuse a null array with 22023 WORK_ITEM_REFILLS_INVALID; it answered '
        || '%s %s', error_state, coalesce(error_message, ''));
  end if;
end
$$;

reset role;
