-- 0147 Pharmacy accepts a prescription before dispensing (ORD-4 of the Akos
-- EHR plan, Release B, lane D; Akos items N-1 and the pharmacy part of N-8).
-- Owner decision Q125 B, 19 November 2026: the pharmacy "Accepted" step is
-- wanted. The planned contract's section "ORD-4: Pharmacy accepts a
-- prescription before dispensing", as the ORD-4 build spec of 20 November
-- 2026 corrects it, is what this file builds. Written on release-a (Release
-- A: 0001-0137 applied and signed, staging 70f92be9). The number is
-- provisional: Release B's other items hold 0138-0146 and numbers are given
-- in merge order at the Release B cut-off; no migration number appears inside
-- a function body or a policy, so renumbering leaves every md5. This file
-- requires 0001-0137 applied. The declaration is signed separately.
--
-- THE GAP. Since 0133 (ORD-2) a prescription the prescriber activates goes to
-- this hospital's own pharmacy by itself: 0133 D7 makes the work item with the
-- prescriber as accepted_by and the fixed reason "Sent automatically when the
-- prescription was activated". So a work item's status 'accepted' and its
-- accepted_at mean only that the pharmacy has it; no pharmacist has taken it
-- on, and nothing records it when one does. The prescriber's progress (ORD-3)
-- goes straight from "Sent to pharmacy" to "Dispensed".
--
-- WHAT IT DOES
-- A1 pharmacy.work_item_acceptances: one pharmacist's acceptance per work item
--    (work_item_id unique): the patient, the facility, the account
--    (accepted_by, as a dispensing's dispensed_by) and membership that
--    accepted, accepted_at (clock_timestamp() by default), accepted_with
--    ('accept': the new accept route; 'dispensing': written by the first
--    dispensing of an item nobody accepted, in the dispensing's own
--    transaction), and the request's idempotency key (0023's key format),
--    digest and correlation id, with unique (facility_id, accepted_by,
--    idempotency_key) as every 0023 command table. No foreign key (0133 D6's
--    pattern): creating it locks neither pharmacy.work_items nor the
--    memberships, and the insert trigger (A3) checks what the keys would. Rows
--    are never updated or deleted: pharmacy_work_item_acceptances_immutable
--    calls 0023's pharmacy.reject_immutable_evidence() before every UPDATE or
--    DELETE (55000 'Pharmacy clinical operational evidence is append-only'),
--    as on 0023's tables; no runtime role holds UPDATE or DELETE either.
--    Row-level security enabled and forced, as on pharmacy.dispensings.
--    Only items sent automatically get a row. A prescription from another
--    facility is accepted when its route's Accept makes the work item (0086),
--    and an own item a pharmacist handed in by hand when it was handed in:
--    their acceptance is the work item's own accepted_by and accepted_at, and
--    pharmacy-api reads it from there (acceptedWith 'order_route' or
--    'hand_off'). pharmacy.work_items is not changed: its status stays
--    'accepted' and its row_version 1, so dispensings keep binding to version
--    1.
-- A2 Four policies, mirroring pharmacy.dispensings':
--    pharmacy_work_item_acceptances_read and _insert ask
--    pharmacy.context_allows(patient_id, facility_id, 'read_records' or
--    'write_records') (the member's own consent, or the order route: 0086's
--    text, unchanged), and staff_own_work_read and staff_own_work_insert are
--    0133's own-work policies in their exact form for a row anchored on its
--    work item (0133 section 4, anchor 'work_item'): the pharmacy row's half
--    given the session's half (an InitPlan, once a statement), and the row's
--    own work item an own item (no route) of that patient at that facility,
--    read by the querying role. The staff_ names sort after the pharmacy_
--    ones, so for the facility's own pharmacy staff the consent test is not
--    asked first (0133, THE COST). 0133's own-work policies are now 46.
-- A3 pharmacy.validate_work_item_acceptance() (SECURITY DEFINER, VOLATILE,
--    search_path pg_catalog, pg_temp; every name in it schema-qualified), the
--    function of pharmacy_work_item_acceptance_validate, BEFORE INSERT FOR
--    EACH ROW (enabled in origin mode, as 0023's validators). It is owned by
--    the owner of pharmacy.validate_dispensing(): 0133 D5's two
--    ehr.prescriptions policies name only that role, and without them a
--    pharmacist with no consent grant would find no prescription under
--    production's forced row-level security. In this order it refuses, each
--    with 23514:
--      a. unless the session is complete and in direct care, and the row is
--         the session's: its facility the session's, accepted_by the
--         session's account, accepted_by_membership_id the session's
--         membership, and that membership is the account's at that facility
--         (what 0023's foreign key checks for a dispensing). An emergency
--         (break-glass) session never accepts, as it never dispenses (its
--         consent is read-only), and neither does any other purpose. MESSAGE
--         'Pharmacist acceptance does not match its work item and actor
--         context' (0077's and 0101's convention for the actor check);
--      b. unless the row's work item is found (read as the owner: under
--         forced row-level security only an item the session may read) with
--         the row's patient and facility; same MESSAGE;
--      c. unless the item is this facility's own (order_route_id is null),
--         else MESSAGE 'PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY', DETAIL
--         'order_route'; and was sent automatically (a
--         pharmacy.own_prescription_sends row for this work item and its
--         prescription, state 'sent'), else the same MESSAGE, DETAIL
--         'hand_off'. Neither reads ehr.prescriptions;
--      d. then, as 0101 does for a dispensing, the item's prescription is
--         read FOR SHARE (held to commit, so the prescribing team cannot
--         change it under the acceptance; a change that holds it first is
--         waited for and then seen), and the item's claim (0133 D14) and send
--         (0133 D8) are read after that lock, so they include that change.
--         MESSAGE 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE' (0101's and 0133's
--         claim function's) with, the most specific first: DETAIL
--         'not_claimed' when the claim is dispensed or missing (0133's claim
--         function's word for it); 'sent_elsewhere' when the claim was
--         released (D14: sent to an outside pharmacy); 'changed' when the
--         send was withdrawn (D8: held, cancelled, entered in error, edited
--         or resumed after the send); no DETAIL when 0101's source check
--         fails otherwise (the prescription is not found, or its patient,
--         facility or encounter is not the item's, or it is not active, or
--         not at the version the pharmacy holds: a completed prescription,
--         which D8 does not mark). The precedence is D10's
--         (pharmacy.own_work_item_states: dispensed, then sent elsewhere,
--         then changed), so pharmacy-api, which answers 23514
--         PRESCRIPTION_SOURCE_NOT_DISPENSABLE on an acceptance with a
--         dispensing's 409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE, with
--         withdrawnReason 'sent_elsewhere' or 'changed' for those DETAILs
--         and none for the others, says what D10 says.
--    A second acceptance of an item passes these checks and is refused by
--    the unique work_item_id (23505), which pharmacy-api's DatabaseService
--    retries once; the retry finds the stored acceptance and answers it
--    (200, alreadyAccepted). The claim is read, not locked: a dispensing (it
--    takes the prescription FOR SHARE, then writes the claim) or a send
--    elsewhere (the prescription, then the claim FOR UPDATE) that commits
--    after the acceptance read the claim is ordered after the acceptance,
--    which is what happened; the acceptance takes the same locks in the
--    same order as a dispensing, so the two cannot deadlock on them. Under
--    pharmacy-api's SERIALIZABLE both commit only in an order PostgreSQL can
--    serialize (two acceptances meet on work_item_id; a dispensing that also
--    writes its acceptance does too). The function is executed by no role
--    (its trigger runs it as its owner).
-- A4 pharmacy.work_item_events gains event_type 'pharmacist_accepted' with
--    event_version 2: work_item_events_event_type_check becomes
--    event_type in ('prescription_accepted', 'pharmacist_accepted') and
--    work_item_events_event_version_check event_version in (1, 2) (same
--    names; each added NOT VALID in place of 0023's and then validated).
--    unique (work_item_id, event_version) stays, so an item has at most one
--    prescription_accepted and one pharmacist_accepted event.
--    pharmacy.validate_work_item_event() is replaced: for a
--    prescription_accepted event of version 1 it runs 0077's text unchanged
--    (the same checks in the same order with the same message); a
--    pharmacist_accepted event of version 2 must come from a complete
--    session, its actor and membership must be the session's and its item's
--    acceptance's (A1: accepted_by, accepted_by_membership_id), its patient
--    and facility the acceptance's, and its reason the fixed text 'Accepted
--    by the pharmacist'; there must be an acceptance (read as the owner, so
--    under forced row-level security one the session may read), else 23514
--    'Pharmacy work-item event does not match its pharmacist acceptance';
--    any other pair of type and version is refused with 0077's message,
--    'Pharmacy work-item event does not match its accepted prescription'.
--    Its attributes stay as test/database/pharmacy-session-guards pins them
--    (SECURITY DEFINER, search_path pharmacy, platform, pg_temp, VOLATILE,
--    owner = pharmacy.context_allows' owner; CREATE OR REPLACE keeps the
--    owner and the ACL) and its trigger is unchanged. pharmacy-api writes the
--    event right after the acceptance in the same transaction, for 'accept'
--    and for 'dispensing' alike: no outbox event (ORD-11 notifies only
--    dispensings and reversals).
-- A5 pharmacy.own_work_item_steps(requested_work_item_ids uuid[]) (SECURITY
--    DEFINER, STABLE, search_path pg_catalog, pg_temp), at most 200 ids (else
--    22023 OWN_WORK_ITEM_STEPS_INVALID), returns (work_item_id, basis,
--    withdrawn, withdrawn_reason, sent_automatically, accepted_at,
--    accepted_by_membership_id, accepted_with). Its first four columns are
--    exactly 0133 D10's pharmacy.own_work_item_states' (the same text: own
--    items at the session's facility the session reads by its consent or as
--    the facility's pharmacy staff, the same basis rule and the same
--    withdrawn rule, in work item id order). sent_automatically: a
--    pharmacy.own_prescription_sends row in state 'sent' names the item.
--    The acceptance columns are the item's pharmacy.work_item_acceptances
--    row's, or null. No runtime role may read the sends table, so this is
--    how pharmacy-api tells 'received' (sent automatically, not accepted, not
--    dispensed) from 'hand_off'; one call answers what states() answers too.
--    A route-backed item has no row here (pharmacy-api reads its acceptance
--    from the work item).
-- A6 Grants, here and in runtime-grants.sql: SELECT and INSERT on the table
--    to hid_pharmacy_runtime and hid_schema_test_runtime (as
--    pharmacy.dispensings); EXECUTE on A5's reader to the same two; A3's
--    trigger function to nobody; all revoked from PUBLIC. The replaced A4
--    function keeps its ACL (its owner's alone).
-- A7 No backfill. Items sent automatically before this file and not dispensed
--    read 'received' until a pharmacist accepts or dispenses them; dispensed
--    ones have no acceptance (pharmacy-api answers an accept of one 409
--    PHARMACY_WORK_ITEM_ALREADY_DISPENSED).
--
-- What it does not do: no new role permission (the accept route asks
-- pharmacy.work-item.accept, held by the pharmacist role only); no change to
-- pharmacy.work_items, pharmacy.dispensings, their triggers, 0101's
-- validate_dispensing or 0133's claims, sends, list or readers; no "un-accept"
-- (a dispensing reversal keeps the acceptance); no outbox event; no check in
-- the send to an outside pharmacy (0133 D14 releases an own item's live claim
-- until a dispensing, accepted or not); nothing for the laboratory.
--
-- 0. Preconditions (catalog reads only, from pg_class, pg_proc,
--    pg_namespace, pg_attribute, pg_trigger and pg_roles, so a login that may
--    not use a schema reaches this file's own messages, and no table is
--    locked: the checks that print a CHECK or a policy are 1b's, because
--    PostgreSQL's pg_get_constraintdef and pg_get_expr open the table they
--    print for; each is a presence check that raises when the thing is absent, never a
--    comparison that can be null; each failure raises 55000 or 42501 and
--    nothing is applied):
--    a. 0001-0137 applied (the markers: 0133's sends, claims and own-work
--       list tables and its readers, 0134's
--       identity.sealed_qa_hospital_work_staff_install(), 0135's
--       ehr.visit_queue, 0137's identity.qoreid_nin_checks and its
--       identity.begin_qoreid_nin_check; 0136 changes rows of the role table
--       only and leaves no catalog mark, and the runner applies it before
--       0137);
--    b. 0147 not applied (no table, function or trigger of this file's names;
--       1b finds the event CHECKs as 0023 made them);
--    c. every column the new bodies, policies and checks read, by name and
--       type;
--    d. the bodies replaced and relied on are byte for byte the ones
--       0001-0137 left (md5 of pg_proc.prosrc; a missing function counts as
--       a mismatch): 0077's validate_work_item_event (replaced); 0101's
--       validate_dispensing, 0133's D1 halves, D5's helper, D8's trigger
--       function, D10's states reader (A5 repeats its text), D14's two claim
--       functions, the consent test, pharmacy.context_allows,
--       pharmacy.reject_immutable_evidence, ehr.context_allows (the
--       prescriptions' own policies) and the six session readers (relied
--       on);
--    e. one owner (pharmacy.work_items') owns the tables this file locks,
--       alters or reads in a new body, validate_dispensing (so A3's trigger
--       function, made by that owner, is the role D5's policies name),
--       validate_work_item_event and pharmacy.context_allows (else 42501);
--    f. the applier is that owner, or a member that inherits it and may SET
--       ROLE to it; that owner may create in and use pharmacy and use ehr,
--       identity, auth and platform (else 42501);
--    g. no hid_ role is a member of the validator's owner (0133 D5's
--       premise; else 55000; 1b checks D5's two policies);
--    and it records validate_work_item_event's owner and ACL for section 6.
-- 1. Locks, NOWAIT, retried every 100 ms for at most 5 seconds, else 55P03
--    with nothing applied (see Locks).
-- 1b. Under those locks, the preconditions that print a CHECK or a policy
--    (each failure raises 55000 and nothing is applied):
--    b. (its last part) the event CHECKs not widened (else '0147: already
--       applied');
--    g. 0133 D5's two ehr.prescriptions policies, naming only the
--       validator's owner;
--    h. pharmacy.work_item_events has exactly 0023's two CHECKs (by
--       definition), its unique (work_item_id, event_version) and its
--       validator trigger.
-- 2. The applier acts as that owner for the rest of this transaction, so
--    every new object is the owner's (and A3's function the role D5 names).
-- 3. A3's trigger function and A5's reader, then A1's table, its two
--    triggers and A2's four policies.
-- 4. A4: the two CHECKs widened (NOT VALID, then validated) and the event
--    validator replaced.
-- 5. Grants (A6) and comments. No backfill (A7).
-- 6. Post-checks: the two new functions' and the replaced validator's bodies
--    (md5), owner (A3's: validate_dispensing's), SECURITY DEFINER,
--    volatility, language, STRICT (none) and search_path; the replaced
--    validator's ACL as section 0 found it and its trigger; the exact EXECUTE
--    grants of the new functions (each existing expected grantee holds
--    EXECUTE, nothing else is granted, PUBLIC included); the table's columns,
--    types, NOT NULLs, defaults, CHECKs and keys (none NOT VALID or
--    deferrable), its indexes, row-level security enabled and forced, its
--    owner and its exact ACL; the four policies exactly as PostgreSQL prints
--    them, and the own-work read policy the table's last permissive read
--    policy by name; the two triggers exactly; the event table's two CHECKs
--    exactly and validated, its unique key; D5's premise again; then probes:
--    an acceptance and a pharmacist_accepted event without a session are
--    refused with their 23514 messages, a prescription_accepted event of
--    version 2 with 0077's, and the reader answers no row without a session
--    and for a session facility with no item (plpgsql plans a query only
--    when it first runs, so this proves the columns it reads exist), and
--    22023 for 201 ids; a probe that meets a busy lock stops the file with
--    55P03 (busy, nothing applied), not with its own message. Nothing is
--    written.
--
-- Locks (measured on a 0137 copy with pg_locks before commit, and with
-- blockers held by another session: pg_locks alone cannot show a lock that a
-- probe took and its subtransaction released when the probe was refused).
-- Section 0 takes no table lock. Section 1 takes, in one attempt and all
-- NOWAIT, first ACCESS SHARE on the seven tables the rest of the file opens
-- without changing them: pharmacy.work_items (the own-work policies'
-- expressions and the replaced validator's %ROWTYPE open it),
-- pharmacy.dispensings, pharmacy.own_prescription_sends and
-- pharmacy.prescription_item_claims (the reader's probe plans its query on
-- them), ehr.prescriptions (1b prints D5's two policies on it), and
-- identity.staff_facility_memberships and auth.accounts (section 6's
-- acceptance and event probes run A3 and the validator: their declarations
-- call platform.current_account_id(), which plans a query on auth.accounts
-- and its indexes even without a session, and A3's step a is parsed whole,
-- its membership test included, before the planner drops that test for a
-- probe without a session); then the indexes of the six it plans on (not
-- ehr.prescriptions'), by planning a query on each under a 10 ms
-- lock_timeout (a REINDEX holds them while it allows the table's ACCESS
-- SHARE); and last ACCESS EXCLUSIVE on pharmacy.work_item_events (ALTER
-- TABLE ... ADD CONSTRAINT and DROP CONSTRAINT need it), 8 tables in all
-- (pg_locks before commit shows these, the indexes of the six and the new
-- table, nothing else, with a superuser applier and with one that has
-- neither superuser nor BYPASSRLS, whose probes plan the tables' policies). A
-- busy table or index fails the attempt and its subtransaction releases what
-- it took; the ACCESS EXCLUSIVE comes last, so an attempt that waits (at
-- most 10 ms, for an index) does not hold it. Nothing after section 1 waits
-- for a lock: with another session holding ACCESS EXCLUSIVE on every other
-- application table of 0001-0137, or a REINDEX of every index of those
-- tables, the file applied and no lock request of its own was ever seen
-- waiting. With one of section 1's held instead (ACCESS EXCLUSIVE on
-- auth.accounts or on the memberships, or a REINDEX of auth.accounts_pkey or
-- of the memberships' key), it stopped after its 50 attempts (5 to 5.5
-- seconds: each attempt waits its 10 ms for a held index) with section 1's
-- 55P03, nothing applied, while a third session read
-- pharmacy.work_item_events every 50 ms, each read under a 200 ms
-- lock_timeout, and none failed. (Before section 1 took those two
-- tables and their indexes, the same blockers made a probe wait the runner's
-- 5 s lock_timeout while holding that ACCESS EXCLUSIVE: 20 of the third
-- session's 120 reads failed, and the file stopped with a probe's message.)
-- Should a probe still meet a busy lock, it stops with 55P03 (busy, nothing
-- applied), not with the probe's own message. ACCESS SHARE stops
-- nothing but DDL. The ACCESS EXCLUSIVE lasts to commit: because the runner
-- applies each file in one transaction, the validation that follows ADD
-- CONSTRAINT ... NOT VALID scans pharmacy.work_item_events under it too (NOT
-- VALID then VALIDATE is used as the build spec asks; its benefit, a
-- validation under SHARE UPDATE EXCLUSIVE only, needs a second transaction,
-- which the runner does not give a file). Every work item event
-- read and write therefore waits for the commit: pharmacy-api's acceptance,
-- 0133 D7's send and 0086's route acceptance insert one event each (no
-- service reads the table).
-- On a 0137 copy with 20,000 work items and as many events, the file's
-- statements took 43 to 46 ms in all (three runs, fsync off): section 0 13 to
-- 15 ms (no lock), section 1 3 to 4 ms (the ACCESS EXCLUSIVE taken at its
-- end), and from there to commit 25 to 29 ms (the hold), of which section 4's
-- two CHECKs and their validation about 6 ms and section 6's post-checks 10
-- to 12 ms. The validation grows with the events (one per item a pharmacy
-- holds, one more per pharmacist acceptance); the rest does not grow with
-- the data.
-- When 0147 is the first statement of its transaction (the runner applies
-- each file in its own transaction), the loop tries again 100 ms later, so it
-- never waits while holding the ACCESS EXCLUSIVE (only, for at most 10 ms, an
-- index while holding the ACCESS SHARE locks) and no read or write queues
-- behind it; after 50 attempts (5 seconds) it stops the release (55P03, nothing
-- applied; the same release can run again). When its transaction already
-- holds locks that stop other sessions' reads or writes (an earlier
-- migration of the same transaction: the runner's dry run runs every pending
-- file in one transaction), it makes one attempt and does not sleep: a busy
-- table stops the dry run at once with 55P03 (nothing applied), instead of
-- keeping those tables locked for up to 5 seconds. In the dry run of several
-- pending files these locks last until the dry run ends, while the later
-- files run; the release's combined declaration must state any such hold,
-- and the dry run belongs in a quiet window. The replaced function's catalog
-- row is locked too. Section 0 takes no table lock.
--
-- Old services on this schema: today's (Release A) pharmacy-api and ehr-api
-- call none of the new functions and never write pharmacy.work_item_acceptances.
-- Their statements meet nothing new: pharmacy-api's acceptance inserts a
-- prescription_accepted event of version 1, which the replaced validator
-- checks with 0077's text, and 0133 D7's send and 0086's route acceptance do
-- the same; dispensings, their triggers, the work list and its readers are
-- unchanged. So each image can be deployed, or rolled back, on its own after
-- this migration. An item accepted with a new image and then served by
-- today's pharmacy-api (a rollback of it alone) shows as today ('accepted',
-- no step), and today's dispensing of a received item writes no acceptance;
-- the new image reads 'received' or 'dispensed' for it later, never a guess.
-- New services on a schema without this file: the accept route answers 503
-- PHARMACY_ACCEPTANCE_UNAVAILABLE (42P01 or 42883), a dispensing skips the
-- acceptance (in a savepoint), the list and a read answer no pharmacyStep
-- for an own item (a route-backed item's is its work item's own acceptance,
-- which needs nothing of this file) and the progress never answers
-- 'accepted'. Applied migrations before 0147 are immutable.
--
-- Undo (by hand only; no release runs it), in one transaction, in this
-- order, so every image keeps working between the steps: first restore
-- 0077's pharmacy.validate_work_item_event() (md5 871c6bae; a
-- pharmacist_accepted event is then refused, 23514, so the new
-- pharmacy-api's accept fails until it is rolled back: roll it back first);
-- then drop pharmacy.own_work_item_steps(uuid[]) (the new pharmacy-api takes
-- a missing reader, 42883, as a schema without this file: no pharmacyStep);
-- then the trigger pharmacy_work_item_acceptance_validate and its function,
-- and only then the table (its policies and immutability trigger go with it).
-- plpgsql records no dependency on the table, so DROP TABLE succeeds while
-- the reader or the replaced validator still names it, and each then fails
-- with 42P01 (the reader's every call; the validator only for a
-- pharmacist_accepted event, never for 0077's). The widened CHECKs stay:
-- pharmacist_accepted events are append-only evidence (0023's immutability
-- trigger), so 0023's narrower CHECKs cannot come back once one exists, and
-- with 0077's validator restored no new one is written. 0147 is undone in
-- full, its table included, before any step of 0133's undo (0133's header,
-- applied and unchangeable, cannot say so): 0147's two own-work policies on
-- pharmacy.work_item_acceptances call 0133's D1 halves
-- (identity.facility_work_session_membership and
-- identity.pharmacy_work_patient_allows), so 0133's order (its 44 own-work
-- policies, then D1's halves) stops at 2BP01 while they stand; and its
-- reader and its trigger function read 0133's sends table, which plpgsql
-- records no dependency on, so with that table dropped first every call of
-- the reader, and every acceptance of a work item the trigger finds, fail
-- with 42P01 (0133's suite, case 9, undoes 0147 first). After the undo this
-- file cannot be applied again: 1b finds the widened CHECKs and refuses
-- ('0147: already applied'). So 0147's row in migration.schema_migrations
-- stays: the runner then counts the file as applied, and the file stays in
-- every later release unchanged, as each applied file must; without the row
-- the next release would stop at that refusal. To bring the step back, a
-- later migration makes again what the undo dropped, on event CHECKs that
-- are already wide.

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
    raise exception using errcode = '55000', message = '0147: 0001-0137 must be applied first';
  end if;
  -- b. Not applied yet: no table, function or trigger of this file's names
  -- (1b checks the event CHECKs, which only printing them shows).
  if exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
              where namespace.nspname = 'pharmacy' and relation.relname = 'work_item_acceptances')
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where (namespace.nspname, proc.proname) in (('pharmacy', 'validate_work_item_acceptance'),
                         ('pharmacy', 'own_work_item_steps')))
     or exists (select 1 from pg_trigger trigger_row
                 where not trigger_row.tgisinternal
                   and trigger_row.tgname in ('pharmacy_work_item_acceptance_validate',
                         'pharmacy_work_item_acceptances_immutable')) then
    raise exception using errcode = '55000', message = '0147: already applied';
  end if;
  -- c. Every column the new bodies, policies and checks read, by name and
  -- type. The decision is an EXISTS over the absent columns (never null);
  -- the list only names them.
  with expected(schema_name, relation_name, column_names) as (values
         ('pharmacy', 'work_items', array['id uuid', 'patient_id uuid', 'facility_id uuid', 'order_route_id uuid',
           'source_ehr_prescription_id uuid', 'source_ehr_prescription_version bigint', 'source_encounter_id uuid']),
         ('pharmacy', 'work_item_events', array['work_item_id uuid', 'patient_id uuid', 'facility_id uuid',
           'event_version integer', 'event_type text', 'actor_id uuid', 'actor_membership_id uuid', 'reason text',
           'correlation_id text']),
         ('pharmacy', 'dispensings', array['work_item_id uuid']),
         ('pharmacy', 'own_prescription_sends', array['prescription_id uuid', 'state text', 'work_item_id uuid',
           'withdrawn_at timestamp with time zone']),
         ('pharmacy', 'prescription_item_claims', array['work_item_id uuid', 'dispensed_at timestamp with time zone',
           'released_at timestamp with time zone']),
         ('ehr', 'prescriptions', array['id uuid', 'encounter_id uuid', 'patient_id uuid', 'facility_id uuid',
           'status text', 'row_version bigint']),
         ('identity', 'staff_facility_memberships', array['id uuid', 'account_id uuid', 'facility_id uuid'])),
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
      message = format('0147: a column this migration relies on is missing or of another type: %s', missing);
  end if;
  -- d. The bodies replaced and relied on (md5 of pg_proc.prosrc). A function
  -- missing at its signature counts as a mismatch.
  with expected(schema_name, proc_name, argument_types, digest) as (values
         -- Replaced: 0077's event validator (A4).
         ('pharmacy', 'validate_work_item_event', '', '871c6baeb5ca29f28192f95f0daf531b'),
         -- Relied on: 0101's dispensing validator (A3 makes its source check
         -- and is owned by its owner), 0133's D1 halves (A2's policies, A5),
         -- D5's helper (the ehr.prescriptions policies A3 meets), D8's
         -- trigger function (withdrawn_at), D10's states (A5 repeats its
         -- text), D14's claim functions (the claims A3 reads), the consent
         -- test (A5's basis), the policies' consent tests and the immutability
         -- function.
         ('pharmacy', 'validate_dispensing', '', '17f7e8897bd2ab240332e4d2c9f757b7'),
         ('identity', 'facility_work_session_membership', 'text', '36de1f00307dd5602972253b23f22f9f'),
         ('identity', 'pharmacy_work_patient_allows', 'uuid, uuid, uuid, text', 'cfc636db0a3457b5661adde458d4d07a'),
         ('pharmacy', 'own_work_source_prescription', 'uuid, uuid, uuid', '41a9afd4ea6f708425b98d1fb6e6eb87'),
         ('ehr', 'own_pharmacy_send_withdrawn_on_change', '', '455c027844f87eebde9dd836f75760cf'),
         ('pharmacy', 'own_work_item_states', 'uuid[]', 'dd091ced7e74b0e6e2ffb9169a80aced'),
         ('pharmacy', 'claim_prescription_work_item', '', 'c60a03a6aed78900827fc4c7654dd593'),
         ('pharmacy', 'claim_prescription_dispensing', '', '2c7f20d7c0df7c582bccc0291f452fdd'),
         ('identity', 'has_active_consent_grant', 'uuid, text, uuid, uuid, text, text, timestamp with time zone',
           '732d11892dd4e27e1ff9093ae3b7de5a'),
         ('pharmacy', 'context_allows', 'uuid, uuid, text', '958a6e5cd2a534d158c82fe399b8f381'),
         ('ehr', 'context_allows', 'uuid, uuid, text', '75016690184a80bd246c365b4d108082'),
         ('pharmacy', 'reject_immutable_evidence', '', 'ff07f56046c29ad4efa9d36ad7fcc549'),
         ('platform', 'current_facility_id', '', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
         ('platform', 'current_account_id', '', 'b715ffe72856836d13ab16656fa6e94a'),
         ('platform', 'current_membership_id', '', '641989704fea95f885fbc38c6feb5aa5'),
         ('platform', 'current_actor_subject', '', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
         ('platform', 'current_purpose_of_use', '', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
         ('platform', 'current_correlation_id', '', '48d3bf187101d33bfda51dac829aa223')),
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
      message = format('0147: a function this migration replaces or relies on differs from 0001-0137: %s', missing);
  end if;
  -- The replaced validator's attributes, as test/database/pharmacy-session-guards
  -- pins them (CREATE OR REPLACE keeps them; section 6 checks them again).
  if not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                  where proc.oid = 'pharmacy.validate_work_item_event()'::regprocedure
                    and language_row.lanname = 'plpgsql' and proc.prosecdef and proc.provolatile = 'v'
                    and not proc.proisstrict and proc.prorettype = 'trigger'::regtype
                    and proc.proconfig = array['search_path=pharmacy, platform, pg_temp']) then
    raise exception using errcode = '55000',
      message = '0147: pharmacy.validate_work_item_event() does not have the attributes 0077 gave it';
  end if;
  -- e. One owner: pharmacy.work_items' owns the tables this file locks,
  -- alters or reads in a new body, validate_dispensing (A3's function is made
  -- by that owner, the role D5's policies name), the replaced validator and
  -- pharmacy.context_allows (the session guards suite pins the validator's
  -- owner to it).
  owner_oid := (select relation.relowner from pg_class relation
                  join pg_namespace namespace on namespace.oid = relation.relnamespace
                 where namespace.nspname = 'pharmacy' and relation.relname = 'work_items' and relation.relkind = 'r');
  validator_owner := (select proc.proowner from pg_proc proc where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure);
  with expected_tables(schema_name, relation_name) as (values
         ('pharmacy', 'work_items'), ('pharmacy', 'work_item_events'), ('pharmacy', 'dispensings'),
         ('pharmacy', 'own_prescription_sends'), ('pharmacy', 'prescription_item_claims'), ('ehr', 'prescriptions'),
         ('identity', 'staff_facility_memberships')),
       expected_functions(schema_name, proc_name, argument_types) as (values
         ('pharmacy', 'validate_dispensing', ''), ('pharmacy', 'validate_work_item_event', ''),
         ('pharmacy', 'context_allows', 'uuid, uuid, text')),
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
                               and proc.proowner = owner_oid))
  select exists (select 1 from foreign_owned), (select string_agg(foreign_owned.what, ', ') from foreign_owned)
    into found_absent, missing;
  if found_absent or validator_owner is distinct from owner_oid then
    raise exception using errcode = '42501',
      message = format('0147: these are not owned by %s, the owner of pharmacy.work_items: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), coalesce(missing, 'pharmacy.validate_dispensing()'));
  end if;
  -- f. The applier is that owner, or a member that inherits it and may SET
  -- ROLE to it; that owner may create in and use pharmacy and use the other
  -- schemas.
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '42501',
      message = format('0147: %s must own, or inherit from and be able to SET ROLE to, %s, the owner of '
        || 'pharmacy.work_items, pharmacy.validate_dispensing() and the Pharmacy work tables', current_user,
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
    raise exception using errcode = '42501',
      message = format('0147: %s lacks %s', pg_get_userbyid(owner_oid), missing);
  end if;
  -- g. 0133 D5's premise: no hid_ role is a member of the validator's owner,
  -- whom D5's two ehr.prescriptions policies name (1b checks the policies,
  -- which only printing them shows).
  select exists (select 1 from pg_roles role_row
                  where role_row.rolname like 'hid\_%' and role_row.oid <> validator_owner
                    and pg_has_role(role_row.oid, validator_owner, 'MEMBER')),
         (select string_agg(role_row.rolname, ', ' order by role_row.rolname) from pg_roles role_row
           where role_row.rolname like 'hid\_%' and role_row.oid <> validator_owner
             and pg_has_role(role_row.oid, validator_owner, 'MEMBER'))
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0147: these roles are members of %s, which 0133 D5''s ehr.prescriptions policies name: %s',
        pg_get_userbyid(validator_owner), missing);
  end if;
  -- The replaced validator's owner and ACL, for section 6.
  perform set_config('hid_0147.validator_acl',
    (select pg_get_userbyid(proc.proowner) || '=' || coalesce(proc.proacl::text, 'default') from pg_proc proc
      where proc.oid = 'pharmacy.validate_work_item_event()'::regprocedure), true);
  raise notice '0147: preconditions checked; applier %; owner %', current_user, pg_get_userbyid(owner_oid);
end
$$;

-- 1. Locks (see Locks), NOWAIT, at most 5 s. A failed attempt's
-- subtransaction releases what it took. The tables only read first, then
-- their indexes (each may wait 10 ms), and the one ACCESS EXCLUSIVE last, so
-- an attempt that waits never holds it. When this transaction already holds
-- a lock that stops other sessions' reads or writes of a table (an earlier
-- migration in the same transaction, as in the runner's dry run of every
-- pending file; the runner's own ledger table aside), one attempt only and
-- no sleep, so no request queues behind those locks while this file waits.
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
      -- The tables the rest of the file opens without changing them: the
      -- Pharmacy work items, dispensings and 0133's sends and claims (the
      -- policies, the validator's %ROWTYPE, the reader's probe),
      -- ehr.prescriptions (1b prints D5's policies on it), and the
      -- memberships and auth.accounts (section 6's acceptance and event
      -- probes: A3's step a names the memberships, and both functions'
      -- declarations call platform.current_account_id(), which plans a query
      -- on auth.accounts even without a session).
      lock table pharmacy.work_items, pharmacy.dispensings, pharmacy.own_prescription_sends,
        pharmacy.prescription_item_claims, ehr.prescriptions, identity.staff_facility_memberships, auth.accounts
        in access share mode nowait;
      -- The indexes of those the file plans a query on (all but
      -- ehr.prescriptions, which it only prints for), which planning takes:
      -- a REINDEX holds them while it allows the ACCESS SHARE above. A 10 ms
      -- lock_timeout makes taking them a NOWAIT too (55P03, so this loop
      -- tries again); the runner's own is restored.
      perform set_config('lock_timeout', '10ms', true);
      execute 'select 1 from pharmacy.work_items where false';
      execute 'select 1 from pharmacy.dispensings where false';
      execute 'select 1 from pharmacy.own_prescription_sends where false';
      execute 'select 1 from pharmacy.prescription_item_claims where false';
      execute 'select 1 from identity.staff_facility_memberships where false';
      execute 'select 1 from auth.accounts where false';
      perform set_config('lock_timeout', runner_lock_timeout, true);
      -- Last, the table section 4 alters: nothing waits while it is held.
      lock table pharmacy.work_item_events in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0147: pharmacy.work_item_events or a table 0147 reads (the Pharmacy work items, the dispensings, '
            || '0133''s sends and claims, ehr.prescriptions, the memberships, auth.accounts, or their indexes) is '
            || 'busy, and this transaction already holds an earlier migration''s locks, so it does not wait; nothing '
            || 'applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0147: pharmacy.work_item_events or a table 0147 reads (the Pharmacy work items, the dispensings, '
            || '0133''s sends and claims, ehr.prescriptions, the memberships, auth.accounts, or their indexes) stayed '
            || 'busy for 5 seconds; nothing applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;

-- 1b. Under section 1's locks, the preconditions that print a CHECK or a
-- policy: PostgreSQL's pg_get_constraintdef and pg_get_expr open the table
-- they print for (ACCESS SHARE), so in section 0 they could wait behind DDL
-- on it, and after section 1 they cannot. Each failure raises 55000 and
-- nothing is applied.
do $$
declare
  validator_owner oid := (select proc.proowner from pg_proc proc
                           where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure);
begin
  -- b (its last part). Not applied yet: the event CHECKs not widened.
  if exists (select 1 from pg_constraint constraint_row
              where constraint_row.conrelid = 'pharmacy.work_item_events'::regclass and constraint_row.contype = 'c'
                and pg_get_constraintdef(constraint_row.oid) like '%pharmacist_accepted%') then
    raise exception using errcode = '55000', message = '0147: already applied';
  end if;
  -- g. 0133 D5: its two ehr.prescriptions policies, naming only the
  -- validator's owner, through which A3 reads the source prescription of an
  -- own item for a pharmacist without a consent grant (section 0 checked that
  -- no hid_ role is a member of that owner, D5's premise).
  if (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.prescriptions'::regclass
         and policy_row.polroles = array[validator_owner] and policy_row.polpermissive
         and ((policy_row.polname = 'prescriptions_own_pharmacy_source_read' and policy_row.polcmd = 'r'
               and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                 = 'pharmacy.own_work_source_prescription(id, patient_id, facility_id)')
           or (policy_row.polname = 'prescriptions_own_pharmacy_source_lock' and policy_row.polcmd = 'w'
               and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                 = 'pharmacy.own_work_source_prescription(id, patient_id, facility_id)'
               and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'false'))) <> 2 then
    raise exception using errcode = '55000',
      message = '0147: ehr.prescriptions does not have 0133 D5''s two policies for the dispensing validator''s owner';
  end if;
  -- h. pharmacy.work_item_events as 0023 made it: exactly one CHECK of each
  -- definition A4 widens, its unique key and its validator trigger.
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.work_item_events'::regclass and constraint_row.contype = 'c'
         and pg_get_constraintdef(constraint_row.oid) = 'CHECK ((event_version = 1))') <> 1
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.conrelid = 'pharmacy.work_item_events'::regclass and constraint_row.contype = 'c'
            and pg_get_constraintdef(constraint_row.oid) = 'CHECK ((event_type = ''prescription_accepted''::text))') <> 1
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.conrelid = 'pharmacy.work_item_events'::regclass and constraint_row.contype = 'c'
            and (pg_get_constraintdef(constraint_row.oid) like '%event_version%'
              or pg_get_constraintdef(constraint_row.oid) like '%event_type%')) <> 2
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.conrelid = 'pharmacy.work_item_events'::regclass and constraint_row.contype = 'u'
            and pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (work_item_id, event_version)') <> 1
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'pharmacy.work_item_events'::regclass and not trigger_row.tgisinternal
            and trigger_row.tgname = 'pharmacy_work_item_event_validate' and trigger_row.tgenabled = 'O'
            and trigger_row.tgfoid = 'pharmacy.validate_work_item_event()'::regprocedure
            and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER pharmacy_work_item_event_validate BEFORE INSERT '
              || 'ON pharmacy.work_item_events FOR EACH ROW EXECUTE FUNCTION pharmacy.validate_work_item_event()') <> 1 then
    raise exception using errcode = '55000',
      message = '0147: pharmacy.work_item_events does not have 0023''s two CHECKs, its key or its validator trigger';
  end if;
end
$$;

-- 2. Act as the owner for the rest of this transaction (a no-op when the
-- applier is the owner, as on every database built by one migration login),
-- so the new objects are the owner's: A3's trigger function the role 0133
-- D5's ehr.prescriptions policies name (section 0 e, and 1b g).
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

-- 3. A3. The acceptance's insert trigger function. Read as the owner, under
-- forced row-level security: only a work item, and only a source
-- prescription, the session may read is found (the prescription through
-- 0133 D5's policies for the facility's own pharmacy staff, or the member's
-- consent). Nothing is read before the session and the row are checked, and
-- the prescription only for an own item sent automatically.
create function pharmacy.validate_work_item_acceptance()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
  session_account uuid := platform.current_account_id();
  session_membership uuid := platform.current_membership_id();
  item_id uuid;
  item_patient uuid;
  item_facility uuid;
  item_route uuid;
  item_prescription uuid;
  item_version bigint;
  item_encounter uuid;
  source_id uuid;
  source_patient uuid;
  source_facility uuid;
  source_encounter uuid;
  source_status text;
  source_version bigint;
  claim_found boolean;
  claim_dispensed_at timestamptz;
  claim_released_at timestamptz;
  send_withdrawn_at timestamptz;
begin
  -- a. The session, complete and in direct care, and the row its own: its
  -- facility, account and membership, the membership the account's at that
  -- facility (what a dispensing's foreign key checks).
  if session_facility is null or session_account is null or session_membership is null
     or platform.current_purpose_of_use() is distinct from 'direct-care'
     or new.facility_id is distinct from session_facility
     or new.accepted_by is distinct from session_account
     or new.accepted_by_membership_id is distinct from session_membership
     or not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.id = session_membership and membership.facility_id = session_facility
                       and membership.account_id = session_account) then
    raise exception using errcode = '23514',
      message = 'Pharmacist acceptance does not match its work item and actor context';
  end if;
  -- b. The work item, with the row's patient and facility.
  select item.id, item.patient_id, item.facility_id, item.order_route_id, item.source_ehr_prescription_id,
         item.source_ehr_prescription_version, item.source_encounter_id
    into item_id, item_patient, item_facility, item_route, item_prescription, item_version, item_encounter
    from pharmacy.work_items item
   where item.id = new.work_item_id;
  if item_id is null or item_patient is distinct from new.patient_id or item_facility is distinct from new.facility_id then
    raise exception using errcode = '23514',
      message = 'Pharmacist acceptance does not match its work item and actor context';
  end if;
  -- c. This facility's own item, sent automatically. A route-backed item was
  -- accepted by the route's Accept, and an item handed in by hand when it was
  -- handed in: both are accepted from the start.
  if item_route is not null then
    raise exception using errcode = '23514', message = 'PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY',
      detail = 'order_route';
  end if;
  if not exists (select 1 from pharmacy.own_prescription_sends send
                  where send.work_item_id = item_id and send.prescription_id = item_prescription
                    and send.state = 'sent') then
    raise exception using errcode = '23514', message = 'PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY',
      detail = 'hand_off';
  end if;
  -- d. As a dispensing (0101): the prescription, FOR SHARE until commit; then
  -- the claim and the send, read after that lock. The most specific reason
  -- first, as the work list's states (0133 D10) give it.
  select prescription.id, prescription.patient_id, prescription.facility_id, prescription.encounter_id,
         prescription.status, prescription.row_version
    into source_id, source_patient, source_facility, source_encounter, source_status, source_version
    from ehr.prescriptions prescription
   where prescription.id = item_prescription
     for share;
  select true, claim.dispensed_at, claim.released_at into claim_found, claim_dispensed_at, claim_released_at
    from pharmacy.prescription_item_claims claim
   where claim.work_item_id = item_id;
  select send.withdrawn_at into send_withdrawn_at
    from pharmacy.own_prescription_sends send
   where send.work_item_id = item_id;
  if claim_found is null or claim_dispensed_at is not null then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE', detail = 'not_claimed';
  end if;
  if claim_released_at is not null then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE', detail = 'sent_elsewhere';
  end if;
  if send_withdrawn_at is not null then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE', detail = 'changed';
  end if;
  if source_id is null
     or source_patient is distinct from item_patient
     or source_facility is distinct from item_facility
     or source_encounter is distinct from item_encounter
     or source_status is distinct from 'active'
     or source_version is distinct from item_version then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE';
  end if;
  return new;
end;
$$;

-- A5. Why the session sees each own work item and where it stands, for the
-- work list, the single read, the accept answer and the progress: 0133 D10's
-- text (the first four columns, the same filter and order), plus whether it
-- was sent automatically and its pharmacist's acceptance.
create function pharmacy.own_work_item_steps(requested_work_item_ids uuid[])
returns table (work_item_id uuid, basis text, withdrawn boolean, withdrawn_reason text, sent_automatically boolean,
  accepted_at timestamptz, accepted_by_membership_id uuid, accepted_with text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
  own_work_membership uuid;
begin
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'OWN_WORK_ITEM_STEPS_INVALID';
  end if;
  if session_facility is null then
    return;
  end if;
  own_work_membership := identity.facility_work_session_membership('pharmacy');
  -- Withdrawn, and why: never after a dispensing; sent elsewhere (0133 D14)
  -- before changed (0133 D8). Sent automatically: its send row (0133 D6).
  return query
    select decided.id, decided.basis, state.reason is not null, state.reason,
           exists (select 1 from pharmacy.own_prescription_sends send
                    where send.work_item_id = decided.id and send.state = 'sent'),
           acceptance.accepted_at, acceptance.accepted_by_membership_id, acceptance.accepted_with
      from (
        select item.id,
               case
                 when identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
                        platform.current_membership_id(), item.facility_id, 'read_records',
                        platform.current_purpose_of_use()) then 'consent'
                 when own_work_membership is not null
                      and identity.pharmacy_work_patient_allows(own_work_membership, item.patient_id,
                        item.facility_id,
                        'read_records') then 'own-work'
               end as basis
          from pharmacy.work_items item
         where item.id = any(requested_work_item_ids)
           and item.order_route_id is null
           and item.facility_id = session_facility) decided
     cross join lateral (
       select case
                when exists (select 1 from pharmacy.dispensings dispensing where dispensing.work_item_id = decided.id)
                  then null
                when exists (select 1 from pharmacy.prescription_item_claims claim
                              where claim.work_item_id = decided.id and claim.released_at is not null)
                  then 'sent_elsewhere'
                when exists (select 1 from pharmacy.own_prescription_sends send
                              where send.work_item_id = decided.id and send.withdrawn_at is not null)
                  then 'changed'
              end::text as reason) state
      left join pharmacy.work_item_acceptances acceptance on acceptance.work_item_id = decided.id
     where decided.basis is not null
     order by decided.id;
end;
$$;

-- A1. The acceptances: one per work item, never updated or deleted.
create table pharmacy.work_item_acceptances (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null unique,
  patient_id uuid not null,
  facility_id uuid not null,
  accepted_by uuid not null,
  accepted_by_membership_id uuid not null,
  accepted_at timestamptz not null default clock_timestamp(),
  accepted_with text not null check (accepted_with in ('accept', 'dispensing')),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  unique (facility_id, accepted_by, idempotency_key)
);
create trigger pharmacy_work_item_acceptance_validate before insert on pharmacy.work_item_acceptances
  for each row execute function pharmacy.validate_work_item_acceptance();
create trigger pharmacy_work_item_acceptances_immutable before update or delete on pharmacy.work_item_acceptances
  for each row execute function pharmacy.reject_immutable_evidence();
alter table pharmacy.work_item_acceptances enable row level security;
alter table pharmacy.work_item_acceptances force row level security;
revoke all on pharmacy.work_item_acceptances from public;

-- A2. The four policies: pharmacy.dispensings' two consent (and order-route)
-- policies, and 0133's own-work read and insert policies for a row anchored
-- on its work item (0133 section 4's text for anchor 'work_item').
create policy pharmacy_work_item_acceptances_read on pharmacy.work_item_acceptances for select
  using (pharmacy.context_allows(patient_id, facility_id, 'read_records'));
create policy pharmacy_work_item_acceptances_insert on pharmacy.work_item_acceptances for insert
  with check (pharmacy.context_allows(patient_id, facility_id, 'write_records'));
create policy staff_own_work_read on pharmacy.work_item_acceptances for select using (
  coalesce(identity.pharmacy_work_patient_allows((select identity.facility_work_session_membership('pharmacy')),
    patient_id, facility_id, 'read_records'), false)
  and exists (select 1 from pharmacy.work_items item where item.id = work_item_acceptances.work_item_id
                 and item.order_route_id is null and item.patient_id = work_item_acceptances.patient_id
                 and item.facility_id = work_item_acceptances.facility_id));
create policy staff_own_work_insert on pharmacy.work_item_acceptances for insert with check (
  coalesce(identity.pharmacy_work_patient_allows((select identity.facility_work_session_membership('pharmacy')),
    patient_id, facility_id, 'write_records'), false)
  and exists (select 1 from pharmacy.work_items item where item.id = work_item_acceptances.work_item_id
                 and item.order_route_id is null and item.patient_id = work_item_acceptances.patient_id
                 and item.facility_id = work_item_acceptances.facility_id));

-- 4. A4. The event table's two CHECKs, widened under the same names: each
-- 0023 CHECK (found by its definition, as section 1b h checked it) is dropped
-- and the wider one added NOT VALID in the same statement, then validated.
do $$
declare
  version_check name;
  type_check name;
begin
  select constraint_row.conname into strict version_check from pg_constraint constraint_row
   where constraint_row.conrelid = 'pharmacy.work_item_events'::regclass and constraint_row.contype = 'c'
     and pg_get_constraintdef(constraint_row.oid) = 'CHECK ((event_version = 1))';
  select constraint_row.conname into strict type_check from pg_constraint constraint_row
   where constraint_row.conrelid = 'pharmacy.work_item_events'::regclass and constraint_row.contype = 'c'
     and pg_get_constraintdef(constraint_row.oid) = 'CHECK ((event_type = ''prescription_accepted''::text))';
  execute format('alter table pharmacy.work_item_events drop constraint %1$I, '
    || 'add constraint %1$I check (event_version in (1, 2)) not valid, drop constraint %2$I, '
    || 'add constraint %2$I check (event_type in (''prescription_accepted'', ''pharmacist_accepted'')) not valid',
    version_check, type_check);
  execute format('alter table pharmacy.work_item_events validate constraint %I', version_check);
  execute format('alter table pharmacy.work_item_events validate constraint %I', type_check);
end
$$;

-- The event validator: 0077's text for a prescription_accepted event of
-- version 1, unchanged and in the same order; a pharmacist_accepted event of
-- version 2 bound to the session and to its item's acceptance (A1), read as
-- the owner under forced row-level security; any other pair refused with
-- 0077's message. The attributes are 0077's (the session guards suite pins
-- them); CREATE OR REPLACE keeps the owner and the ACL.
create or replace function pharmacy.validate_work_item_event()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  parent_row pharmacy.work_items%rowtype;
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
  acceptance_patient_id uuid;
  acceptance_facility_id uuid;
  acceptance_actor_id uuid;
  acceptance_membership_id uuid;
begin
  if new.event_type is distinct from 'prescription_accepted' or new.event_version is distinct from 1 then
    if new.event_type is distinct from 'pharmacist_accepted' or new.event_version is distinct from 2 then
      raise exception using errcode = '23514',
        message = 'Pharmacy work-item event does not match its accepted prescription';
    end if;
    if session_account_id is not null and session_membership_id is not null then
      select acceptance.patient_id, acceptance.facility_id, acceptance.accepted_by, acceptance.accepted_by_membership_id
        into acceptance_patient_id, acceptance_facility_id, acceptance_actor_id, acceptance_membership_id
        from pharmacy.work_item_acceptances acceptance
       where acceptance.work_item_id = new.work_item_id;
    end if;
    if session_account_id is null
       or session_membership_id is null
       or acceptance_actor_id is null
       or acceptance_patient_id is distinct from new.patient_id
       or acceptance_facility_id is distinct from new.facility_id
       or acceptance_actor_id is distinct from new.actor_id
       or acceptance_membership_id is distinct from new.actor_membership_id
       or new.reason is distinct from 'Accepted by the pharmacist'
       or new.actor_id is distinct from session_account_id
       or new.actor_membership_id is distinct from session_membership_id then
      raise exception using errcode = '23514',
        message = 'Pharmacy work-item event does not match its pharmacist acceptance';
    end if;
    return new;
  end if;
  select * into parent_row from pharmacy.work_items where id = new.work_item_id;
  if parent_row.id is null
     or session_account_id is null
     or session_membership_id is null
     or parent_row.patient_id is distinct from new.patient_id
     or parent_row.facility_id is distinct from new.facility_id
     or parent_row.accepted_by is distinct from new.actor_id
     or parent_row.accepted_by_membership_id is distinct from new.actor_membership_id
     or parent_row.acceptance_reason is distinct from new.reason
     or new.actor_id is distinct from session_account_id
     or new.actor_membership_id is distinct from session_membership_id then
    raise exception using errcode = '23514',
      message = 'Pharmacy work-item event does not match its accepted prescription';
  end if;
  return new;
end
$$;

-- 5. Grants (A6; here and in runtime-grants.sql) and comments.
revoke all on function pharmacy.validate_work_item_acceptance(), pharmacy.own_work_item_steps(uuid[]) from public;
do $$
declare runtime_role text;
begin
  foreach runtime_role in array array['hid_pharmacy_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant select, insert on pharmacy.work_item_acceptances to %I', runtime_role);
      execute format('grant execute on function pharmacy.own_work_item_steps(uuid[]) to %I', runtime_role);
    end if;
  end loop;
end
$$;

comment on table pharmacy.work_item_acceptances is
  '0147 A1 (ORD-4): a pharmacist''s acceptance of an own work item sent automatically (0133 D7), one per work item: who accepted it (account and membership), when, and with what (accept: the accept route; dispensing: its first dispensing). Append-only. Route-backed and handed-in items have none (their acceptance is the work item''s own).';
comment on function pharmacy.validate_work_item_acceptance() is
  '0147 A3: the trigger function of pharmacy_work_item_acceptance_validate: the row must be the direct-care session''s (facility, account, membership), its work item this facility''s own and sent automatically (else 23514 PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY, detail order_route or hand_off), and still dispensable: 0101''s source check with the prescription FOR SHARE, the claim live and undispensed and the send not withdrawn (else 23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE, detail not_claimed, sent_elsewhere or changed). Owned by pharmacy.validate_dispensing()''s owner (0133 D5); executed by no role.';
comment on function pharmacy.own_work_item_steps(uuid[]) is
  '0147 A5: for each own work item here the session may read: 0133 D10''s basis, withdrawn and withdrawn_reason (exactly pharmacy.own_work_item_states''), whether it was sent automatically, and its pharmacist''s acceptance (time, membership, accept or dispensing) or null. At most 200 ids.';
comment on function pharmacy.validate_work_item_event() is
  '0077 (replaced by 0147 A4): a prescription_accepted event of version 1 must match its work item''s acceptance (accepted_by, membership, reason) and the session (0077''s text); a pharmacist_accepted event of version 2 must match its item''s pharmacist acceptance (0147 A1) and the session, with the reason ''Accepted by the pharmacist''; any other pair is refused.';

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
  error_detail text;
begin
  -- The two new bodies and the replaced one (md5), owner (A3's the
  -- dispensing validator's), SECURITY DEFINER, volatility, language, not
  -- STRICT, search_path.
  with expected(schema_name, proc_name, argument_types, digest, volatility, config) as (values
         ('pharmacy', 'validate_work_item_acceptance', '', 'edcba164be5587a3f448ab8cb8f555aa', 'v', 'search_path=pg_catalog, pg_temp'),
         ('pharmacy', 'own_work_item_steps', 'uuid[]', '624bf894d7ff773ccf71d878af474bfc', 's', 'search_path=pg_catalog, pg_temp'),
         ('pharmacy', 'validate_work_item_event', '', '8a8d6680cf2fd4dcf57047979d771f2e', 'v', 'search_path=pharmacy, platform, pg_temp')),
       differing as (
         select expected.*,
                (select string_agg(format('md5=%s owner=%s definer=%s volatile=%s strict=%s config=%s',
                          md5(proc.prosrc), pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
                          proc.proisstrict, proc.proconfig), ',')
                   from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = expected.schema_name and proc.proname = expected.proc_name) as found
           from expected
          where (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = expected.schema_name and proc.proname = expected.proc_name) <> 1
             or not exists (
               select 1 from pg_proc proc
                 join pg_namespace namespace on namespace.oid = proc.pronamespace
                 join pg_language language_row on language_row.oid = proc.prolang
                where namespace.nspname = expected.schema_name and proc.proname = expected.proc_name
                  and pg_catalog.oidvectortypes(proc.proargtypes) = expected.argument_types
                  and md5(proc.prosrc) = expected.digest and proc.proowner = owner_oid
                  and proc.proowner = validator_owner and proc.prosecdef
                  and proc.provolatile = expected.volatility::"char" and language_row.lanname = 'plpgsql'
                  and not proc.proisstrict and proc.proconfig = array[expected.config]))
  select exists (select 1 from differing),
         (select string_agg(format('%s.%s(%s): %s', differing.schema_name, differing.proc_name, differing.argument_types,
                   coalesce(differing.found, 'missing')), '; ') from differing)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000', message = format('0147: functions are not as this file makes them: %s', mismatch);
  end if;
  -- The replaced validator keeps its owner and ACL, and its trigger.
  if (select pg_get_userbyid(proc.proowner) || '=' || coalesce(proc.proacl::text, 'default') from pg_proc proc
       where proc.oid = 'pharmacy.validate_work_item_event()'::regprocedure)
     is distinct from nullif(current_setting('hid_0147.validator_acl', true), '')
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgfoid = 'pharmacy.validate_work_item_event()'::regprocedure) <> 1
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'pharmacy.work_item_events'::regclass
            and trigger_row.tgname = 'pharmacy_work_item_event_validate' and trigger_row.tgenabled = 'O'
            and trigger_row.tgfoid = 'pharmacy.validate_work_item_event()'::regprocedure) <> 1 then
    raise exception using errcode = '55000', message = '0147: the event validator''s owner, ACL or trigger changed';
  end if;
  -- The new functions' exact EXECUTE grants: each expected grantee that
  -- exists holds EXECUTE (not grantable); nothing else is granted, PUBLIC
  -- included. Decided by EXISTS, so a role that does not exist never makes a
  -- comparison null.
  with expected(proc_name, grantee_name) as (values
         ('own_work_item_steps', 'hid_pharmacy_runtime'), ('own_work_item_steps', 'hid_schema_test_runtime')),
       new_functions as (
         select proc.oid, proc.proname, proc.proowner, proc.proacl
           from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'pharmacy'
            and proc.proname in ('validate_work_item_acceptance', 'own_work_item_steps')),
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
    raise exception using errcode = '55000', message = format('0147: the new functions'' grants are not section 5''s: %s',
      mismatch);
  end if;
  -- A1's table exactly: columns, types, NOT NULLs, defaults, CHECKs and keys
  -- (none NOT VALID or deferrable), indexes; row-level security enabled and
  -- forced; the owner's; SELECT and INSERT (not grantable) to each of the
  -- two runtimes that exists, nothing else.
  if (select array_agg(attribute_row.attname::text || ':' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
          || ':' || attribute_row.attnotnull::text || ':'
          || coalesce(pg_get_expr(column_default.adbin, column_default.adrelid), '-') order by attribute_row.attnum)
        from pg_attribute attribute_row
        left join pg_attrdef column_default
          on column_default.adrelid = attribute_row.attrelid and column_default.adnum = attribute_row.attnum
       where attribute_row.attrelid = 'pharmacy.work_item_acceptances'::regclass and attribute_row.attnum > 0
         and not attribute_row.attisdropped)
     is distinct from array['id:uuid:true:gen_random_uuid()', 'work_item_id:uuid:true:-', 'patient_id:uuid:true:-',
       'facility_id:uuid:true:-', 'accepted_by:uuid:true:-', 'accepted_by_membership_id:uuid:true:-',
       'accepted_at:timestamp with time zone:true:clock_timestamp()', 'accepted_with:text:true:-',
       'idempotency_key:text:true:-', 'request_sha256:character(64):true:-', 'correlation_id:text:true:-'] then
    raise exception using errcode = '55000', message = '0147: the columns of pharmacy.work_item_acceptances are not this file''s';
  end if;
  if (select array_agg(constraint_row.contype::text || ' ' || pg_get_constraintdef(constraint_row.oid)
          order by constraint_row.contype, pg_get_constraintdef(constraint_row.oid) collate "C")
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.work_item_acceptances'::regclass)
     is distinct from array[
       'c CHECK (((length(correlation_id) >= 8) AND (length(correlation_id) <= 128)))',
       'c CHECK ((accepted_with = ANY (ARRAY[''accept''::text, ''dispensing''::text])))',
       'c CHECK ((idempotency_key ~ ''^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$''::text))',
       'c CHECK ((request_sha256 ~ ''^[0-9a-f]{64}$''::text))',
       'p PRIMARY KEY (id)',
       'u UNIQUE (facility_id, accepted_by, idempotency_key)',
       'u UNIQUE (work_item_id)']
     or exists (select 1 from pg_constraint constraint_row
                 where constraint_row.conrelid = 'pharmacy.work_item_acceptances'::regclass
                   and (not constraint_row.convalidated or constraint_row.condeferrable))
     or (select array_agg(pg_get_indexdef(index_row.indexrelid) order by pg_get_indexdef(index_row.indexrelid) collate "C")
           from pg_index index_row where index_row.indrelid = 'pharmacy.work_item_acceptances'::regclass)
        is distinct from array[
          'CREATE UNIQUE INDEX work_item_acceptances_facility_id_accepted_by_idempotency_k_key ON '
            || 'pharmacy.work_item_acceptances USING btree (facility_id, accepted_by, idempotency_key)',
          'CREATE UNIQUE INDEX work_item_acceptances_pkey ON pharmacy.work_item_acceptances USING btree (id)',
          'CREATE UNIQUE INDEX work_item_acceptances_work_item_id_key ON pharmacy.work_item_acceptances USING btree '
            || '(work_item_id)'] then
    raise exception using errcode = '55000', message = '0147: the keys of pharmacy.work_item_acceptances are not this file''s';
  end if;
  if (select relation.relrowsecurity and relation.relforcerowsecurity and relation.relkind = 'r'
             and relation.relowner = owner_oid
        from pg_class relation where relation.oid = 'pharmacy.work_item_acceptances'::regclass) is not true then
    raise exception using errcode = '55000',
      message = '0147: pharmacy.work_item_acceptances must be the owner''s, with row-level security enabled and forced';
  end if;
  with expected(grantee_name, privilege_type) as (values
         ('hid_pharmacy_runtime', 'SELECT'), ('hid_pharmacy_runtime', 'INSERT'),
         ('hid_schema_test_runtime', 'SELECT'), ('hid_schema_test_runtime', 'INSERT')),
       granted as (
         select privilege.grantee, privilege.privilege_type, privilege.is_grantable
           from pg_class relation
          cross join aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
          where relation.oid = 'pharmacy.work_item_acceptances'::regclass and privilege.grantee <> relation.relowner),
       wrong as (
         select format('%s %s', case when granted.grantee = 0 then 'PUBLIC' else pg_get_userbyid(granted.grantee)::text end,
                  granted.privilege_type) as what
           from granted
          where granted.is_grantable
             or not exists (select 1 from expected join pg_roles role_row on role_row.rolname = expected.grantee_name
                             where role_row.oid = granted.grantee and expected.privilege_type = granted.privilege_type)
         union all
         select format('%s lacks %s', expected.grantee_name, expected.privilege_type)
           from expected join pg_roles role_row on role_row.rolname = expected.grantee_name
          where not exists (select 1 from granted
                             where granted.grantee = role_row.oid and granted.privilege_type = expected.privilege_type))
  select exists (select 1 from wrong), (select string_agg(wrong.what, '; ') from wrong)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0147: the grants on pharmacy.work_item_acceptances are not section 5''s: %s', mismatch);
  end if;
  -- A2's four policies, exactly as PostgreSQL prints them (whitespace
  -- collapsed): permissive, for everyone; and the own-work read policy the
  -- table's last permissive read policy by name (C collation, as PostgreSQL
  -- orders them), so it is asked first.
  if (select array_agg(policy_row.polname::text || ':' || policy_row.polcmd::text || ':'
          || coalesce(regexp_replace(pg_get_expr(policy_row.polqual, policy_row.polrelid), '\s+', ' ', 'g'), '-') || ':'
          || coalesce(regexp_replace(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '\s+', ' ', 'g'), '-')
          order by policy_row.polname::text collate "C")
        from pg_policy policy_row
       where policy_row.polrelid = 'pharmacy.work_item_acceptances'::regclass and policy_row.polpermissive
         and policy_row.polroles = array[0::oid])
     is distinct from array[
       'pharmacy_work_item_acceptances_insert:a:-:pharmacy.context_allows(patient_id, facility_id, ''write_records''::text)',
       'pharmacy_work_item_acceptances_read:r:pharmacy.context_allows(patient_id, facility_id, ''read_records''::text):-',
       'staff_own_work_insert:a:-:(COALESCE(identity.pharmacy_work_patient_allows(( SELECT '
         || 'identity.facility_work_session_membership(''pharmacy''::text) AS facility_work_session_membership), '
         || 'patient_id, facility_id, ''write_records''::text), false) AND (EXISTS ( SELECT 1 FROM pharmacy.work_items item '
         || 'WHERE ((item.id = work_item_acceptances.work_item_id) AND (item.order_route_id IS NULL) AND '
         || '(item.patient_id = work_item_acceptances.patient_id) AND (item.facility_id = '
         || 'work_item_acceptances.facility_id)))))',
       'staff_own_work_read:r:(COALESCE(identity.pharmacy_work_patient_allows(( SELECT '
         || 'identity.facility_work_session_membership(''pharmacy''::text) AS facility_work_session_membership), '
         || 'patient_id, facility_id, ''read_records''::text), false) AND (EXISTS ( SELECT 1 FROM pharmacy.work_items item '
         || 'WHERE ((item.id = work_item_acceptances.work_item_id) AND (item.order_route_id IS NULL) AND '
         || '(item.patient_id = work_item_acceptances.patient_id) AND (item.facility_id = '
         || 'work_item_acceptances.facility_id))))):-']
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = 'pharmacy.work_item_acceptances'::regclass) <> 4 then
    raise exception using errcode = '55000', message = format('0147: the policies are not section 3''s: %s',
      (select string_agg(policy_row.polname || ' ' || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-')
         || ' ' || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '-'), '; ')
         from pg_policy policy_row where policy_row.polrelid = 'pharmacy.work_item_acceptances'::regclass));
  end if;
  if exists (select 1 from pg_policy other_policy
              where other_policy.polrelid = 'pharmacy.work_item_acceptances'::regclass and other_policy.polpermissive
                and other_policy.polcmd in ('r', '*') and other_policy.polname <> 'staff_own_work_read'
                and other_policy.polname::text collate "C" > 'staff_own_work_read') then
    raise exception using errcode = '55000', message = '0147: a policy would be asked before the own-work read policy';
  end if;
  -- The table's two triggers, exactly (enabled in origin mode, as 0023's),
  -- the only ones; A3's function used by its trigger only.
  if (select array_agg(pg_get_triggerdef(trigger_row.oid) || ' ' || trigger_row.tgenabled::text
          order by trigger_row.tgname::text collate "C")
        from pg_trigger trigger_row
       where trigger_row.tgrelid = 'pharmacy.work_item_acceptances'::regclass and not trigger_row.tgisinternal)
     is distinct from array[
       'CREATE TRIGGER pharmacy_work_item_acceptance_validate BEFORE INSERT ON pharmacy.work_item_acceptances FOR EACH '
         || 'ROW EXECUTE FUNCTION pharmacy.validate_work_item_acceptance() O',
       'CREATE TRIGGER pharmacy_work_item_acceptances_immutable BEFORE DELETE OR UPDATE ON '
         || 'pharmacy.work_item_acceptances FOR EACH ROW EXECUTE FUNCTION pharmacy.reject_immutable_evidence() O']
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgfoid = 'pharmacy.validate_work_item_acceptance()'::regprocedure) <> 1 then
    raise exception using errcode = '55000', message = '0147: the acceptances'' triggers are not this file''s';
  end if;
  -- A4: the event table's two CHECKs, exactly and validated, under 0023's
  -- names; its key on (work_item_id, event_version) kept.
  if (select array_agg(constraint_row.conname::text || ' ' || constraint_row.convalidated::text || ' '
          || pg_get_constraintdef(constraint_row.oid) order by constraint_row.conname::text collate "C")
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.work_item_events'::regclass and constraint_row.contype = 'c'
         and (pg_get_constraintdef(constraint_row.oid) like '%event_version%'
           or pg_get_constraintdef(constraint_row.oid) like '%event_type%'))
     is distinct from array[
       'work_item_events_event_type_check true CHECK ((event_type = ANY (ARRAY[''prescription_accepted''::text, '
         || '''pharmacist_accepted''::text])))',
       'work_item_events_event_version_check true CHECK ((event_version = ANY (ARRAY[1, 2])))']
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.conrelid = 'pharmacy.work_item_events'::regclass and constraint_row.contype = 'u'
            and pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (work_item_id, event_version)') <> 1 then
    raise exception using errcode = '55000', message = '0147: the work item events'' CHECKs are not A4''s';
  end if;
  -- 0133 D5's premise again: no hid_ role is a member of A3's owner.
  if exists (select 1 from pg_roles role_row
              where role_row.rolname like 'hid\_%' and role_row.oid <> validator_owner
                and pg_has_role(role_row.oid, validator_owner, 'MEMBER')) then
    raise exception using errcode = '55000',
      message = format('0147: a hid_ role is a member of %s, which 0133 D5''s ehr.prescriptions policies name',
        pg_get_userbyid(validator_owner));
  end if;
  -- Probes, each undone. They open only what section 1 holds, so none waits
  -- for a lock; should one still meet a busy lock (55P03), the file stops as
  -- busy, nothing applied, not with the probe's own message. An acceptance
  -- without a session: A3 refuses it at step a, before it reads the work
  -- items (the trigger runs before the row-level security check); its
  -- declarations and step a open auth.accounts and the memberships.
  begin
    insert into pharmacy.work_item_acceptances (work_item_id, patient_id, facility_id, accepted_by,
      accepted_by_membership_id, accepted_with, idempotency_key, request_sha256, correlation_id)
    values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'accept',
      'post-check-0147-probe', repeat('0', 64), 'post-check-0147');
    error_state := 'no error';
  exception
    when lock_not_available then
      raise exception using errcode = '55P03',
        message = '0147: a table a post-check probe reads is busy (' || sqlerrm || '); nothing applied; run the '
          || 'release again at a quieter time';
    when others then
      get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '23514'
     or error_message is distinct from 'Pharmacist acceptance does not match its work item and actor context' then
    raise exception using errcode = '55000',
      message = format('0147: an acceptance without a session must be refused with 23514; it answered %s %s',
        error_state, coalesce(error_message, ''));
  end if;
  -- A pharmacist_accepted event without a session, and a
  -- prescription_accepted event of version 2: refused before any read.
  error_state := null;
  error_message := null;
  begin
    insert into pharmacy.work_item_events (work_item_id, patient_id, facility_id, event_version, event_type, actor_id,
      actor_membership_id, reason, correlation_id)
    values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 2, 'pharmacist_accepted', gen_random_uuid(),
      gen_random_uuid(), 'Accepted by the pharmacist', 'post-check-0147');
    error_state := 'no error';
  exception
    when lock_not_available then
      raise exception using errcode = '55P03',
        message = '0147: a table a post-check probe reads is busy (' || sqlerrm || '); nothing applied; run the '
          || 'release again at a quieter time';
    when others then
      get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '23514'
     or error_message is distinct from 'Pharmacy work-item event does not match its pharmacist acceptance' then
    raise exception using errcode = '55000',
      message = format('0147: a pharmacist_accepted event without a session must be refused with 23514; it answered %s %s',
        error_state, coalesce(error_message, ''));
  end if;
  error_state := null;
  error_message := null;
  begin
    insert into pharmacy.work_item_events (work_item_id, patient_id, facility_id, event_version, event_type, actor_id,
      actor_membership_id, reason, correlation_id)
    values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 2, 'prescription_accepted', gen_random_uuid(),
      gen_random_uuid(), 'Accepted by the pharmacist', 'post-check-0147');
    error_state := 'no error';
  exception
    when lock_not_available then
      raise exception using errcode = '55P03',
        message = '0147: a table a post-check probe reads is busy (' || sqlerrm || '); nothing applied; run the '
          || 'release again at a quieter time';
    when others then
      get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '23514'
     or error_message is distinct from 'Pharmacy work-item event does not match its accepted prescription' then
    raise exception using errcode = '55000',
      message = format('0147: a prescription_accepted event of version 2 must be refused with 0077''s 23514; it '
        || 'answered %s %s', error_state, coalesce(error_message, ''));
  end if;
  -- The reader: 22023 for 201 ids; no row without a session; and for a
  -- session facility with no item (its query planned and run: the columns
  -- it reads exist), no row.
  error_state := null;
  error_message := null;
  begin
    perform pharmacy.own_work_item_steps(array(select gen_random_uuid() from generate_series(1, 201)));
    error_state := 'no error';
  exception
    when lock_not_available then
      raise exception using errcode = '55P03',
        message = '0147: a table a post-check probe reads is busy (' || sqlerrm || '); nothing applied; run the '
          || 'release again at a quieter time';
    when others then
      get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '22023' or error_message is distinct from 'OWN_WORK_ITEM_STEPS_INVALID' then
    raise exception using errcode = '55000',
      message = format('0147: the reader must refuse 201 ids with 22023 OWN_WORK_ITEM_STEPS_INVALID; it answered %s %s',
        error_state, coalesce(error_message, ''));
  end if;
  if exists (select 1 from pharmacy.own_work_item_steps(array[gen_random_uuid()])) then
    raise exception using errcode = '55000', message = '0147: the reader answered a row without a session';
  end if;
  perform set_config('app.facility_id', gen_random_uuid()::text, true);
  if exists (select 1 from pharmacy.own_work_item_steps(array[gen_random_uuid()])) then
    raise exception using errcode = '55000', message = '0147: the reader answered a row for no item';
  end if;
  perform set_config('app.facility_id', '', true);
  if exists (select 1 from pharmacy.work_item_acceptances) then
    raise exception using errcode = '55000', message = '0147: pharmacy.work_item_acceptances is not empty';
  end if;
end
$$;

reset role;
