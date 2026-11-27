-- 0158 Several tests in one lab request (ORD-6 of the Akos EHR plan, lane
-- D). The clinical owner's design note on hid-system#258 (Ola, 27 November
-- 2026, 09:27 UTC, comment 7214746190), revised after Rahman's review
-- 7167493074; the planned contract's ORD-6 section (Q124 A). The number is
-- a booking, given in release order at integration (7168672285, decision
-- 4); no migration number appears inside a function body, so renumbering
-- leaves every md5. Written on 0156 (#346, e59d6e30): this file requires
-- 0001-0153 and 0156 applied, and checks 0156 alone (its marker, below);
-- it does not need 0154, 0155, 0157 or 0159. The declaration is signed
-- separately, with this file's runtime-grants.sql block.
--
-- THE GAP. A clinician who orders several tests for one visit saves one
-- request per test, one at a time, and nothing records that they were
-- ordered together. The lab sees unrelated cards.
--
-- WHAT IT DOES
-- G1 request_group_id uuid NULL on ehr.lab_requests and on lab.work_items:
--    no default, no rewrite and no backfill (catalog only). Each test stays
--    its own lab request, linked by the group id, so every rule stays per
--    test: progress, hold, cancel, routes, results, FR-1 and Q105. ehr-api
--    makes the id (randomUUID) and never takes one from a client.
-- G2 The group cannot change: ehr.lab_request_group_fixed() and its
--    trigger lab_requests_group_fixed, BEFORE UPDATE OF request_group_id ON
--    ehr.lab_requests FOR EACH ROW, with no WHEN clause and no arguments.
--    - Why it is needed: ehr.capture_record_version refuses with 42501 only
--      without an actor context or an active membership (0112:755-757,
--      :764-765). With them it fixes only the id, patient, facility,
--      creator and creator's membership (0112:781-787), so it would let a
--      group change through. The guard is what keeps the group.
--    - How it sees a change: in the body, new.request_group_id IS DISTINCT
--      FROM old.request_group_id raises 55000 LAB_REQUEST_GROUP_FIXED; a
--      SET to the same value passes. UPDATE OF fires whenever the column is
--      named in SET. No BEFORE trigger on the table writes the column
--      (lab_requests_versioned sets only row_version and updated_at,
--      0112:792-793), so a change cannot arrive any other way. With no
--      WHEN, tgqual is null.
--    - Name order: lab_requests_group_fixed sorts before
--      lab_requests_versioned (0004:503), so it fires first. That only
--      makes a change without an actor get 55000, not 42501; with an actor
--      the guard is the only refusal.
--    - plpgsql, SECURITY INVOKER (prosecdef false), search_path
--      pg_catalog, pg_temp, owned by the table's owner, EXECUTE revoked
--      from PUBLIC (as 0149:327, :361); it reads no table. A trigger runs
--      its function without an EXECUTE check, as the updating role.
--    - ehr.capture_record_version (0112's body) is untouched. ID-8 moves a
--      patient's requests by patient_id, never the group, so groups
--      survive it. lab.work_items needs no guard: it refuses every UPDATE
--      and DELETE (lab_work_items_immutable, 0018:136-137).
-- G3 lab.validate_work_item() (0086:9352-9419) is replaced; everything
--    else byte for byte (Rahman's form of decision 4: the validator copies
--    the group from the EHR row, so lab-api sends none):
--    - same-facility branch: after the existing 23514 check
--      (0086:9390-9409), 23514 LAB_REQUEST_GROUP_MISMATCH when
--      new.request_group_id is not null and is distinct from the EHR row's;
--      then new.request_group_id := the EHR row's request_group_id;
--    - route branch: "or new.request_group_id is not null" joins the
--      existing 23514 condition (0086:9363-9385), so no group id reaches
--      another facility. That extends PRIV P4.3's answer rule (lab-api's
--      project()) to storage.
--    Why a guard may set a column (Rahman's answer 4):
--    capture_record_version already sets row_version and updated_at
--    (0112:775-776, :792-793); RLS checks run after BEFORE triggers; no
--    later trigger depends on the column. CREATE OR REPLACE keeps the oid,
--    the owner and the ACL; SECURITY DEFINER and search_path lab, ehr,
--    identity, auth, platform, pg_temp are restated
--    (lab-session-guards.integration.sql:44-57), and without a volatility
--    it stays VOLATILE, as made. Its md5 goes from
--    efac15072e0a6e68dff199026ff6f73e to 04504d00ebd8940a8178ce35343f4f8c
--    (measured at build, on both kinds of build).
--    The effect: whatever image sends the order, Lab's own work item
--    carries the EHR row's group; a routed one carries none. A test of a
--    group sent later on its own (a draft activated, or one resumed from
--    hold) keeps its group in Lab too: Lab copies it from the row each time.
-- No probe in the file (Rahman's nit; the clinical owner's choice): the
-- earlier draft's temporary-table probe ran inside the lock window and
-- needed TEMP on the database, which nothing in the repository grants or
-- checks. The lab-request-groups suite and the rehearsal run it.
--
-- PRECONDITIONS (section 0: catalog reads only, no locks; 55000 and
-- nothing applied):
-- - 0156's marker, and 0156 alone (7168672285, decision 3): its pair
--   CHECKs lab_requests_test_code_pair_ck and work_items_test_code_pair_ck
--   (0156:614, :624), each printed CHECK (((test_code_system IS NULL) =
--   (test_code IS NULL))) (0156:797, :803) and validated, else "0158:
--   0001-0153 and 0156 must be applied first". 0156 validates both under
--   its own locks (0156:615, :625) and its post-check refuses otherwise
--   (0156:813). Above 0156's size bound 0156 refuses, nothing applied
--   (0156:600-605); the pair checks would then go in NOT VALID with a
--   follow-up file (0156:217-218), and this marker would require that
--   follow-up instead. 0154, 0155, 0157 and 0159 are not required.
-- - The pins, md5 of prosrc (a function missing at its signature is a
--   mismatch): lab.validate_work_item_child() at
--   9bc011f7583332dd3de12ce2a8e45753, as 0156:489 pins it. Why: its body
--   allows ordinal 1 only, and a requested test equal to its parent
--   (0073:58-62); ORD-6's one test per work item relies on that. And the
--   readers the validator calls, as 0144:483-485 and 0148:386-388 pin
--   them: platform.current_facility_id() c4a7c2989e83d9cedbf1f7b785a5aaed,
--   current_account_id() b715ffe72856836d13ab16656fa6e94a and
--   current_membership_id() 641989704fea95f885fbc38c6feb5aa5. The old body
--   already calls them, so nothing new relies on them.
-- - One owner: the owner of ehr.lab_requests owns lab.work_items and both
--   validators (lab-session-guards' rule), and may create in ehr. The
--   applier is that owner, or inherits it and may SET ROLE to it (0148's
--   and 0154's rule); section 1 then acts as that owner, so the guard
--   function is the table owner's on every database.
-- - "0158: already applied" (0149:148) only when both columns, the guard
--   trigger and function and the new validator are exactly as section 6
--   pins them (Rahman's point 2: a trigger edited to carry WHEN (false)
--   is not "applied").
-- - A first run needs none of this file's objects (no request_group_id
--   column on either table, no trigger lab_requests_group_fixed, no
--   function ehr.lab_request_group_fixed), and lab.validate_work_item() at
--   efac15072e0a6e68dff199026ff6f73e (0086:9352) with the attributes of
--   lab-session-guards.integration.sql:44-57 and 0018's ACL (below).
-- - Any other mix: "0158: not in the reviewed state".
--
-- GRANTS. The existing table grants cover the new columns
-- (runtime-grants.sql:419-421, :488-492, :666, :676). EXECUTE on the guard
-- is revoked from PUBLIC (here and in runtime-grants.sql). The validator's
-- ACL: today it includes PUBLIC EXECUTE, and CREATE OR REPLACE keeps it.
-- 0017's revoke on the functions in lab (0017:199) ran before 0018 made
-- this one (0018:90); its per-schema default (0017:201) cannot take away
-- PostgreSQL's built-in PUBLIC EXECUTE, and no later file revokes it. The
-- post-check expects it unchanged: PUBLIC and the owner, EXECUTE. A
-- trigger runs it as its owner, so the ACL grants nothing a session uses.
--
-- SERVICE SETTINGS. One ehr-api setting, LAB_REQUEST_GROUPS_ENABLED,
-- default off. It stops new groups only: it gates the group route and
-- whether createInTransaction writes a group (option (b): while it is off,
-- an order set's tests are saved with a null group, as separate requests).
-- Stored groups are always answered. lab-api has no setting; it only reads
-- the column. Both ORD-6 images select the column, so both need this file
-- applied first; either ships after it, in either order.
--
-- OLD AND NEW TOGETHER.
-- - Old on new: Release E's images work unchanged on this file. ehr-api
--   writes no group and lab-api names none, so the validator copies null.
-- - New on old: ORD-6's images select the column, so they wait for this
--   file. If the apply stops at this file after an earlier file of the
--   same release committed (0157; or 0155 or 0156, if either ever rides
--   with it), those files stay, and the ORD-6 images are held until this
--   file applies. This file is one transaction: a refusal leaves nothing.
-- - No rollback floor (Rahman's point 1): either service can go back to its
--   image before ORD-6 at any time. An old lab-api sends no group and the
--   validator copies it; an old ehr-api neither reads nor sends one.
--   Written groups stay. 0156's own floor still stands: once a test is
--   ordered by name only, lab-api stays at or above 0156's image.
-- - Switching off, before an ehr-api image rollback or the undo:
--   LAB_REQUEST_GROUPS_ENABLED off and ORDER_SETS_ENABLED off (Rahman's
--   point 4). Written groups stay, Lab keeps the groups it copied, ehr-api
--   keeps answering stored groups, and lab-api keeps showing them, so the
--   visit list and the lab board agree.
--
-- RELEASE. This file, signed with its runtime-grants.sql block and a
-- release declaration that records the measured dry-run window (below), as
-- #330 was; after 0156's own release (0156 goes alone, 0156:10-11), never
-- in 0155's release, and only with files of 0155-0159 (Rahman's advice;
-- 0159 goes alone too: 7192223324), never with the sprint's 0160-0177 or
-- with 0178-0180. The rule is by work, not by number: these are bookings.
-- Then lab-api and ehr-api with the setting off, in either order; then the
-- setting on (CDK on staging, Terraform in production); then the website.
--
-- THE OTHER BOOKED NUMBERS (not in this tree; what moves at integration):
-- - 0156 (built, e59d6e30) keeps the validator at efac1507 (0156:488) and
--   post-checks it (0156:848); this file replaces it after 0156.
-- - 0159 ORD-11 (built, #345 at 5857690e) pins lab.validate_work_item()
--   at efac1507 (0159:428), locks neither ehr.lab_requests nor
--   lab.work_items (0159:189-197, :206-209) and reads ehr.lab_requests by
--   id, never request_group_id (0159:136). It ships first, so this file
--   takes the later number, and a fresh install meets 0159's pin before
--   this file replaces the body: nothing moves. If this file ever ships
--   before 0159, 0159's pin moves to this file's md5 (above) at
--   integration (7192223324); this file's own pin (efac1507) stays.
-- - 0179 reads both tables and takes ACCESS EXCLUSIVE on lab.work_items for
--   its whole file; it pins none of this file's objects and re-measures
--   its pins and locks after 0156 and this file; this file pins no policy
--   on lab.work_items, so 0179's new one there does not touch it. It
--   never rides with this file. 0178 changes neither table and pins
--   nothing this file changes; it never rides with this file either.
-- - 0180 (ORD-8) needs a group create inside its own transaction with its
--   own part names, and requires this file's column (its markers: 0149,
--   0155, 0156, this file and 0179).
-- - Billing's 0167 (#336, d637baa4) adds zz_billing_lab_work_item, AFTER
--   INSERT on lab.work_items (0167:597), and pins that table's triggers by
--   name and function (0167:158). This file adds no trigger there and
--   keeps the validator's name, so neither file refuses the other.
--
-- LOCKS. The precedent is 0143 (ACCESS EXCLUSIVE NOWAIT on ehr.lab_requests,
-- 0143:85-92), with 0154's lesson on %rowtype. Section 2, one DO block,
-- each attempt in its own subtransaction, in the form of 0154:1231-1233
-- (#344, 47ad66c0): ACCESS SHARE NOWAIT on ehr.order_routes, then ACCESS
-- EXCLUSIVE NOWAIT on ehr.lab_requests and lab.work_items (ALTER TABLE ADD
-- COLUMN and CREATE TRIGGER need it), so an attempt that fails never holds
-- the strong locks. Why ehr.order_routes: replacing the validator compiles
-- it, and plpgsql opens ehr.order_routes to resolve ehr.order_routes%rowtype
-- (0086:9356). Behind DDL there it would wait for the runner's 5 s
-- lock_timeout (apply-migrations.mjs:143, :166) and fail with the server's
-- lock-timeout message, which the dry run does not retry (0154:520-526;
-- dry-run-attempts.mjs:9). ehr.lab_requests%rowtype (0086:9355) is covered
-- by the ACCESS EXCLUSIVE. ACCESS SHARE on the routes blocks only DDL
-- there. The validator and the guard are replaced and made after the
-- locks; the preconditions read the catalog only and take no table lock.
-- A busy table fails the attempt at once and its subtransaction releases
-- what it took; the attempt is made again every 100 ms for at most 5
-- seconds (50 attempts), then 55P03 "0158: ehr.lab_requests, lab.work_items
-- or ehr.order_routes stayed busy for 5 seconds; nothing applied; run the
-- release again at a quieter time". When this transaction already holds an
-- earlier migration's locks that stop other sessions' reads or writes (the
-- runner's dry run of several files; its own ledger table aside), one
-- attempt and no sleep: 55P03 "0158: ... is busy, and this transaction
-- already holds an earlier migration's locks, so it does not wait; nothing
-- applied; ..." at once (0143:89-92). Both are the runner's busy refusal
-- (dry-run-attempts.mjs BUSY_REFUSAL), so a dry run rolls back and tries
-- again; the apply does not, so the release stops and is run again.
-- Autovacuum: an autovacuum or ANALYZE of ehr.lab_requests or
-- lab.work_items (SHARE UPDATE EXCLUSIVE) fails the NOWAIT; one of
-- ehr.order_routes does not.
-- What waits while the locks are held, from section 2 to commit:
-- - ehr.lab_requests, ACCESS EXCLUSIVE: every lab-request read and write in
--   ehr-api (chart summary, patient evidence, the visit's entered-in-error
--   count, MY-1); order-route sends (order_routes_source_lab_request_fk,
--   0086:10109-10110); Lab's acceptance (the validator reads the request;
--   work_items_source_order_fk, 0086:10063-10064).
-- - lab.work_items, ACCESS EXCLUSIVE: after Release E, 35 policies on 16
--   lab chain tables reach it under forced row security (re-counted at
--   build from pg_policy, through the functions the policies call: the
--   requested tests, work-item events, accessions, accession events,
--   specimens, specimen requirements, specimen events, specimen command
--   idempotency, test executions, execution events, results, result
--   revisions, result events, verifications, releases and invalidations).
--   So the lab runtime's reads of those tables wait: nearly all lab-api
--   work, result entry, verification and release included; the work list
--   and get; ORD-3 progress; released results for an order. Also every
--   insert whose foreign key points at it: requested tests (0018:58),
--   work-item events (0018:71), accessions (0019:25), accession events
--   (0019:129), route result reports (0086:10121-10122), and route updates
--   at commit (deferred, 0086:10116-10117).
-- - ehr.order_routes, ACCESS SHARE: DDL only.
-- Not waiting (Rahman): the outbox, imported evidence and observations,
-- and reads of route result reports. A chain-table read by a superuser or
-- BYPASSRLS role runs no policy, so it does not wait; the runtime roles'
-- reads do (as 0156 says). They wait; none fails unless its own
-- lock_timeout or statement_timeout is shorter than the hold. 0154-0159 add
-- no policy on a lab table.
-- The dry-run window (Rahman's point 3). The apply gives each file its own
-- transaction (apply-migrations.mjs:162-168); the dry run runs every
-- pending file in one transaction and rolls back at the end (:132-157). So
-- in the dry run these locks last until the dry run ends, through every
-- later file, and again on each retry (as 0148 and 0133 say of theirs).
-- The runtimes' statement_timeout is 15 s, with no lock_timeout (ehr-api
-- database.service.ts:293; lab-api database.service.ts:197); nginx gives
-- up at 30 s. 0155 and this file go in separate releases, so the window
-- starts at this file's own lock: with 0155 ahead it would start at 0155's
-- SHARE ROW EXCLUSIVE on role rows, facilities and memberships, and staff
-- sign-ups, desk enrolment and invitations would wait behind Lab's window.
-- The window, from the first strong lock of the release that carries this
-- file to the dry run's rollback, is measured on the rehearsal copy with
-- the real release set at production row counts, recorded in the
-- declaration and kept well under 15 s. Measured here for this file alone
-- (below).
--
-- Undo (a migration, only if the owner signs it; one transaction, after
-- the switch-off above):
-- - Locks (Rahman's nit): ACCESS SHARE on ehr.order_routes and ACCESS
--   EXCLUSIVE on ehr.lab_requests, NOWAIT, both in each attempt's
--   subtransaction, with this file's 5 s loop, its one-attempt rule and
--   both busy refusals, each starting with the undo file's own number
--   (dry-run-attempts.mjs:32-33). DROP TRIGGER needs the ACCESS EXCLUSIVE;
--   restoring the validator compiles its two %rowtypes.
-- - Then: drop the trigger lab_requests_group_fixed and the function
--   ehr.lab_request_group_fixed(), restore 0086's validator body
--   (0086:9352-9419, md5 efac15072e0a6e68dff199026ff6f73e) with SECURITY
--   DEFINER and its search_path restated (its ACL is kept), post-check
--   both, and remove this file's lines from runtime-grants.sql in the same
--   release. The columns stay (dropping one would rewrite nothing but
--   would lose the written groups); the ledger row stays.
-- - What live images see after it: Release E's, nothing changes. ORD-6's
--   ehr-api, with the setting off, writes no group and still answers the
--   stored ones; no route lets a client change a group (validation-pipe.ts
--   forbidNonWhitelisted), so losing the guard opens nothing to the
--   services. ORD-6's lab-api: a test accepted after the undo gets a null
--   group (0086's body copies nothing), so it shows on its own on the lab
--   board; earlier work items keep their group.
--
-- Measured on throwaway PostgreSQL 16 on 0001-0153 and 0156 (e59d6e30's
-- builds) with about 20,000 rows of fictional data in each of
-- ehr.lab_requests, lab.work_items and ehr.order_routes (and 0156's other
-- three tables), analysed; ten runs with a superuser applier and ten with a
-- NOSUPERUSER NOBYPASSRLS applier that owns the tables:
-- - the hold, from section 2 to the end of COMMIT: 6.6-12.8 ms (median 7.6)
--   and 6.4-10.5 ms (median 7.6), under the 50 ms target (Rahman's run of
--   the DDL: 7.9-9.2 ms); the whole file 16-23 ms and 15-22 ms;
-- - pg_locks before commit, identical with both appliers: ACCESS EXCLUSIVE
--   on ehr.lab_requests and lab.work_items (and, under it, CREATE
--   TRIGGER's SHARE ROW EXCLUSIVE and the comments' SHARE UPDATE EXCLUSIVE
--   on them), ACCESS SHARE on ehr.order_routes, and no other table: the
--   rest are ACCESS SHARE on catalogs and ROW EXCLUSIVE on pg_description;
--   pg_stat_xact_user_tables: no row inserted, updated or deleted and no
--   scan of the three tables;
-- - the dry-run window for this file alone, from section 2 to the end of the
--   rollback (the dry run's transaction, by psql): 5.8-22.1 ms (median 8.0)
--   and 5.3-9.6 ms (median 6.6); the runner's whole --dry-run command,
--   node's start and the plan included: 132-211 ms and 145-185 ms;
-- - behind an open read of ehr.lab_requests or lab.work_items, DDL held on
--   ehr.order_routes, or SHARE UPDATE EXCLUSIVE (as an autovacuum or
--   ANALYZE) on ehr.lab_requests or lab.work_items, the file stops after
--   4.99-5.00 s with section 2's 55P03, nothing applied (both appliers);
--   with an earlier migration's lock held in the same transaction it stops
--   at once (21-36 ms) with the one-attempt text; the runner's dry run
--   retries it (attempt 1 busy, attempt 2 succeeded). An open read of
--   ehr.order_routes, or SHARE UPDATE EXCLUSIVE on it, does not stop the
--   file (29-36 ms);
-- - a session that compiled plpgsql readers declared as the validators are
--   (ehr.lab_requests%rowtype and lab.work_items%rowtype, select * into)
--   before this file committed in another session reads both tables
--   unchanged after it, and the new column through the same declarations.
-- The lab-request-groups suite runs this file (a second run, each tamper,
-- the undo and a fresh apply) and the data path on both kinds of build.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 1. Act as the tables' owner.   2. The locks.
-- 3. G1, the columns.            4. G2, the guard.
-- 5. G3, the validator.          6. Post-checks (55000).
-- 7. Comments.

-- 0. Preconditions.
do $$
declare
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = to_regclass('ehr.lab_requests'));
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  mismatch text;
  columns_made boolean;
  trigger_made boolean;
  guard_made boolean;
  validator_made boolean;
begin
  -- a. 0156's marker (0156 alone): both pair CHECKs, by name and printed definition, validated.
  if owner_oid is null or to_regclass('lab.work_items') is null
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.contype = 'c' and constraint_row.convalidated
            and (constraint_row.conrelid, constraint_row.conname, pg_get_constraintdef(constraint_row.oid)) in (
                  ('ehr.lab_requests'::regclass, 'lab_requests_test_code_pair_ck',
                   'CHECK (((test_code_system IS NULL) = (test_code IS NULL)))'),
                  ('lab.work_items'::regclass, 'work_items_test_code_pair_ck',
                   'CHECK (((test_code_system IS NULL) = (test_code IS NULL)))'))) <> 2 then
    raise exception using errcode = '55000', message = '0158: 0001-0153 and 0156 must be applied first';
  end if;
  -- b. The pins: the child validator (one test per work item) and the three readers the validator calls.
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('lab.validate_work_item_child()', '9bc011f7583332dd3de12ce2a8e45753'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0158: these functions are not as 0001-0156 left them: ' || mismatch;
  end if;
  -- c. One owner: ehr.lab_requests' owns lab.work_items and both validators, and may create in ehr and use lab; the
  -- applier is that owner, or inherits it and may SET ROLE to it.
  select string_agg(owned.what, ', ') into mismatch
    from (values ('lab.work_items', (select relation.relowner from pg_class relation
                                      where relation.oid = 'lab.work_items'::regclass)),
                 ('lab.validate_work_item()', (select proc.proowner from pg_proc proc
                                                where proc.oid = to_regprocedure('lab.validate_work_item()'))),
                 ('lab.validate_work_item_child()', (select proc.proowner from pg_proc proc
                                                      where proc.oid = 'lab.validate_work_item_child()'::regprocedure)))
         owned(what, owner_id)
   where owned.owner_id is distinct from owner_oid;
  if mismatch is not null
     or not has_schema_privilege(owner_oid, 'ehr', 'CREATE') or not has_schema_privilege(owner_oid, 'ehr', 'USAGE')
     or not has_schema_privilege(owner_oid, 'lab', 'USAGE') then
    raise exception using errcode = '55000',
      message = format('0158: %s, the owner of ehr.lab_requests, must own %s and may create in schema ehr',
        pg_get_userbyid(owner_oid), coalesce(mismatch, 'lab.work_items and both Lab validators'));
  end if;
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '55000',
      message = format('0158: %s must own, or inherit from and be able to SET ROLE to, %s, the owner of '
        || 'ehr.lab_requests and lab.work_items', current_user, pg_get_userbyid(owner_oid));
  end if;
  -- d. Already applied: everything exactly as section 6 pins it.
  columns_made := (select count(*) from pg_attribute attribute_row
                    where attribute_row.attrelid in ('ehr.lab_requests'::regclass, 'lab.work_items'::regclass)
                      and attribute_row.attname = 'request_group_id' and not attribute_row.attisdropped
                      and attribute_row.atttypid = 'uuid'::regtype and not attribute_row.attnotnull
                      and not attribute_row.atthasdef and attribute_row.attidentity = ''
                      and attribute_row.attgenerated = '') = 2;
  trigger_made := (select count(*) from pg_trigger trigger_row
                    where trigger_row.tgrelid = 'ehr.lab_requests'::regclass
                      and trigger_row.tgname = 'lab_requests_group_fixed' and not trigger_row.tgisinternal
                      and trigger_row.tgenabled = 'O'
                      and trigger_row.tgfoid = to_regprocedure('ehr.lab_request_group_fixed()')
                      and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER lab_requests_group_fixed BEFORE UPDATE '
                        || 'OF request_group_id ON ehr.lab_requests FOR EACH ROW EXECUTE FUNCTION '
                        || 'ehr.lab_request_group_fixed()') = 1;
  guard_made := exists (select 1 from pg_proc proc
                         where proc.oid = to_regprocedure('ehr.lab_request_group_fixed()')
                           and md5(proc.prosrc) = '58e4b93e313cf07a38ee57f5a10fa5bb'
                           and proc.proowner = owner_oid and not proc.prosecdef
                           and proc.proconfig = array['search_path=pg_catalog, pg_temp']
                           and proc.prorettype = 'trigger'::regtype and proc.provolatile = 'v'
                           and proc.prolang = (select language_row.oid from pg_language language_row
                                                where language_row.lanname = 'plpgsql')
                           and proc.proacl is not null
                           and not exists (select 1 from aclexplode(proc.proacl) acl where acl.grantee <> proc.proowner));
  validator_made := exists (select 1 from pg_proc proc
                             where proc.oid = 'lab.validate_work_item()'::regprocedure
                               and md5(proc.prosrc) = '04504d00ebd8940a8178ce35343f4f8c'
                               and proc.proowner = owner_oid and proc.prosecdef and proc.provolatile = 'v'
                               and proc.proconfig = array['search_path=lab, ehr, identity, auth, platform, pg_temp']
                               and (select array_agg(entry.grant_text order by entry.grant_text collate "C")
                                       from (select format('%s:%s:%s', case acl.grantee when 0 then 'PUBLIC' when proc.proowner then 'owner'
                                                                       else acl.grantee::regrole::text end,
                                                            acl.privilege_type, acl.is_grantable::text) as grant_text
                                               from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl) entry)
                                    = array['PUBLIC:EXECUTE:false', 'owner:EXECUTE:false']);
  if columns_made and trigger_made and guard_made and validator_made then
    raise exception using errcode = '55000', message = '0158: already applied';
  end if;
  -- e. A first run: none of this file's objects, and 0086's validator as made, with 0018's ACL.
  if exists (select 1 from pg_attribute attribute_row
              where attribute_row.attrelid in ('ehr.lab_requests'::regclass, 'lab.work_items'::regclass)
                and attribute_row.attname = 'request_group_id' and not attribute_row.attisdropped)
     or exists (select 1 from pg_trigger trigger_row
                 where trigger_row.tgrelid = 'ehr.lab_requests'::regclass
                   and trigger_row.tgname = 'lab_requests_group_fixed')
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr' and proc.proname = 'lab_request_group_fixed')
     or not exists (select 1 from pg_proc proc
                     where proc.oid = to_regprocedure('lab.validate_work_item()')
                       and md5(proc.prosrc) = 'efac15072e0a6e68dff199026ff6f73e'
                       and proc.proowner = owner_oid and proc.prosecdef and proc.provolatile = 'v'
                       and proc.proconfig = array['search_path=lab, ehr, identity, auth, platform, pg_temp']
                       and (select array_agg(entry.grant_text order by entry.grant_text collate "C")
                               from (select format('%s:%s:%s', case acl.grantee when 0 then 'PUBLIC' when proc.proowner then 'owner'
                                                               else acl.grantee::regrole::text end,
                                                    acl.privilege_type, acl.is_grantable::text) as grant_text
                                       from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl) entry)
                            = array['PUBLIC:EXECUTE:false', 'owner:EXECUTE:false']) then
    raise exception using errcode = '55000', message = '0158: not in the reviewed state';
  end if;
end
$$;

-- 1. Act as the tables' owner for the rest of this transaction (a no-op
-- when the applier is the owner, as on every database built by one
-- migration login), so the guard function is the owner's.
do $$
declare
  owner_name text := (select pg_get_userbyid(relation.relowner) from pg_class relation
                       where relation.oid = 'ehr.lab_requests'::regclass);
begin
  if owner_name <> current_user then
    execute format('set local role %I', owner_name);
  end if;
end
$$;

-- 2. The locks (NOWAIT, at most 5 seconds; one attempt when this
-- transaction already holds an earlier migration's locks): ACCESS SHARE on
-- ehr.order_routes (section 5's compile opens it), then ACCESS EXCLUSIVE
-- on the two tables this file alters, in one subtransaction per attempt.
do $locks$
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
      lock table ehr.order_routes in access share mode nowait;
      lock table ehr.lab_requests, lab.work_items in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      -- Both endings are the runner's busy refusal (dry-run-attempts.mjs), so a dry run tries again.
      if holding then
        raise exception using errcode = '55P03',
          message = '0158: ehr.lab_requests, lab.work_items or ehr.order_routes is busy, and this transaction '
            || 'already holds an earlier migration''s locks, so it does not wait; nothing applied; run the release '
            || 'again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0158: ehr.lab_requests, lab.work_items or ehr.order_routes stayed busy for 5 seconds; nothing '
            || 'applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 3. G1: the group on both tables (catalog only: no default, rewrite or backfill).
alter table ehr.lab_requests add column request_group_id uuid null;
alter table lab.work_items add column request_group_id uuid null;

-- 4. G2: a lab request's group cannot change once written.
create function ehr.lab_request_group_fixed()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- A SET to the same value passes; any other value, null included, is refused.
  if new.request_group_id is distinct from old.request_group_id then
    raise exception using errcode = '55000', message = 'LAB_REQUEST_GROUP_FIXED';
  end if;
  return new;
end;
$$;
revoke all on function ehr.lab_request_group_fixed() from public;
create trigger lab_requests_group_fixed
  before update of request_group_id on ehr.lab_requests
  for each row execute function ehr.lab_request_group_fixed();

-- 5. G3: the validator copies the group from the EHR row (0086's body otherwise byte for byte).
create or replace function lab.validate_work_item()
returns trigger language plpgsql security definer
set search_path = lab, ehr, identity, auth, platform, pg_temp as $$
declare source_row ehr.lab_requests%rowtype;
  route_row ehr.order_routes%rowtype;
  session_facility uuid := platform.current_facility_id();
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
begin
  if new.order_route_id is not null then
    select route.* into route_row from ehr.order_routes route where route.id = new.order_route_id for update;
    if route_row.id is null or session_facility is null
       or actor_account is null or actor_membership is null
       or route_row.kind is distinct from 'lab_request'
       or route_row.state is distinct from 'accepted'
       or route_row.lab_work_item_id is distinct from new.id
       or route_row.patient_id is distinct from new.patient_id
       or route_row.receiving_facility_id is distinct from new.facility_id
       or route_row.ordering_facility_id is distinct from new.ordering_facility_id
       or route_row.source_lab_request_id is distinct from new.source_ehr_order_id
       or route_row.source_order_version is distinct from new.source_ehr_order_version
       or route_row.source_encounter_id is distinct from new.source_encounter_id
       or route_row.test_code_system is distinct from new.test_code_system
       or route_row.test_code is distinct from new.test_code
       or route_row.test_display is distinct from new.test_name
       or route_row.priority is distinct from new.priority
       or route_row.clinical_information is distinct from new.clinical_indication
       or route_row.orderer_account_id is distinct from new.requested_by
       or route_row.requested_at is distinct from new.requested_at
       or route_row.accepted_by_account_id is distinct from new.accepted_by
       or route_row.accepted_by_membership_id is distinct from new.accepted_by_membership_id
       or new.facility_id is distinct from session_facility
       or new.accepted_by is distinct from actor_account
       or new.accepted_by_membership_id is distinct from actor_membership
       or new.request_group_id is not null then
      raise exception using errcode='23514',message='Lab work item does not match its accepted order route and actor context';
    end if;
    return new;
  end if;
  select * into source_row from ehr.lab_requests where id=new.source_ehr_order_id;
  if source_row.id is null or session_facility is null
     or actor_account is null or actor_membership is null
     or source_row.patient_id is distinct from new.patient_id
     or source_row.facility_id is distinct from new.facility_id
     or source_row.encounter_id is distinct from new.source_encounter_id
     or source_row.row_version is distinct from new.source_ehr_order_version
     or source_row.status is distinct from 'active'
     or source_row.test_code_system is distinct from new.test_code_system
     or source_row.test_code is distinct from new.test_code
     or source_row.test_display is distinct from new.test_name
     or source_row.priority is distinct from new.priority
     or source_row.clinical_information is distinct from new.clinical_indication
     or source_row.created_by is distinct from new.requested_by
     or source_row.created_at is distinct from new.requested_at
     or new.facility_id is distinct from session_facility
     or new.accepted_by is distinct from actor_account
     or new.accepted_by_membership_id is distinct from actor_membership then
    raise exception using errcode='23514',message='Lab work item does not match the exact active EHR order version and actor context';
  end if;
  if new.request_group_id is not null and new.request_group_id is distinct from source_row.request_group_id then
    raise exception using errcode='23514',message='LAB_REQUEST_GROUP_MISMATCH';
  end if;
  new.request_group_id := source_row.request_group_id;
  perform 1 from ehr.order_routes route
   where route.source_lab_request_id = new.source_ehr_order_id
     and (route.state in ('accepted', 'completed') or (route.state = 'sent' and clock_timestamp() < route.respond_by))
   for share;
  if found then
    raise exception using errcode='23514',message='LAB_REQUEST_ROUTED';
  end if;
  return new;
end
$$;

-- 6. Post-checks (55000).
do $$
declare
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.lab_requests'::regclass);
  mismatch text;
begin
  -- The two columns: uuid, nullable, no default.
  if (select count(*) from pg_attribute attribute_row
       where attribute_row.attrelid in ('ehr.lab_requests'::regclass, 'lab.work_items'::regclass)
         and attribute_row.attname = 'request_group_id' and not attribute_row.attisdropped
         and attribute_row.atttypid = 'uuid'::regtype and not attribute_row.attnotnull
         and not attribute_row.atthasdef and attribute_row.attidentity = ''
         and attribute_row.attgenerated = '') <> 2 then
    raise exception using errcode = '55000', message = '0158: request_group_id is not uuid, nullable and without a default on both tables';
  end if;
  -- The guard trigger exactly, by its printed form (events, column list, WHEN and arguments; tgtype alone does not
  -- carry them, 0152:148-155), enabled, calling the guard.
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.lab_requests'::regclass
         and trigger_row.tgname = 'lab_requests_group_fixed' and not trigger_row.tgisinternal
         and trigger_row.tgenabled = 'O'
         and trigger_row.tgfoid = 'ehr.lab_request_group_fixed()'::regprocedure
         and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER lab_requests_group_fixed BEFORE UPDATE OF '
           || 'request_group_id ON ehr.lab_requests FOR EACH ROW EXECUTE FUNCTION ehr.lab_request_group_fixed()') <> 1 then
    raise exception using errcode = '55000', message = '0158: the trigger lab_requests_group_fixed is not as made';
  end if;
  -- The guard function: body, owner, invoker, search_path, and EXECUTE for the owner only (no PUBLIC).
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'ehr.lab_request_group_fixed()'::regprocedure
                    and md5(proc.prosrc) = '58e4b93e313cf07a38ee57f5a10fa5bb'
                    and proc.proowner = owner_oid and not proc.prosecdef
                    and proc.proconfig = array['search_path=pg_catalog, pg_temp']
                    and proc.prorettype = 'trigger'::regtype and proc.provolatile = 'v'
                    and proc.prolang = (select language_row.oid from pg_language language_row
                                         where language_row.lanname = 'plpgsql')
                    and proc.proacl is not null
                    and not exists (select 1 from aclexplode(proc.proacl) acl where acl.grantee <> proc.proowner)) then
    raise exception using errcode = '55000', message = '0158: ehr.lab_request_group_fixed() is not as made';
  end if;
  -- The validator: body, owner, definer, search_path, VOLATILE (lab-session-guards.integration.sql:44-57), and its
  -- ACL unchanged (PUBLIC and the owner, EXECUTE).
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'lab.validate_work_item()'::regprocedure
                    and md5(proc.prosrc) = '04504d00ebd8940a8178ce35343f4f8c'
                    and proc.proowner = owner_oid and proc.prosecdef and proc.provolatile = 'v'
                    and proc.proowner = (select child.proowner from pg_proc child
                                          where child.oid = 'lab.validate_work_item_child()'::regprocedure)
                    and proc.proconfig = array['search_path=lab, ehr, identity, auth, platform, pg_temp']
                    and (select array_agg(entry.grant_text order by entry.grant_text collate "C")
                            from (select format('%s:%s:%s', case acl.grantee when 0 then 'PUBLIC' when proc.proowner then 'owner'
                                                            else acl.grantee::regrole::text end,
                                                 acl.privilege_type, acl.is_grantable::text) as grant_text
                                    from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl) entry)
                         = array['PUBLIC:EXECUTE:false', 'owner:EXECUTE:false']) then
    raise exception using errcode = '55000', message = '0158: lab.validate_work_item() is not as made';
  end if;
  -- Section 0's pins unchanged, and 0156's two CHECKs.
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('lab.validate_work_item_child()', '9bc011f7583332dd3de12ce2a8e45753'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0158: these functions changed: ' || mismatch;
  end if;
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.contype = 'c' and constraint_row.convalidated
         and (constraint_row.conrelid, constraint_row.conname, pg_get_constraintdef(constraint_row.oid)) in (
               ('ehr.lab_requests'::regclass, 'lab_requests_test_code_pair_ck',
                'CHECK (((test_code_system IS NULL) = (test_code IS NULL)))'),
               ('lab.work_items'::regclass, 'work_items_test_code_pair_ck',
                'CHECK (((test_code_system IS NULL) = (test_code IS NULL)))'))) <> 2 then
    raise exception using errcode = '55000', message = '0158: 0156''s pair CHECKs changed';
  end if;
end
$$;

-- 7. Comments.
comment on column ehr.lab_requests.request_group_id is
  '0158 (ORD-6): the group of tests ordered together in one save; null for a test ordered on its own. Made by ehr-api, never taken from a client; fixed once written (lab_requests_group_fixed).';
comment on column lab.work_items.request_group_id is
  '0158 (ORD-6): the EHR lab request''s group, copied by lab.validate_work_item() for a same-facility work item; always null on a routed one.';
comment on function ehr.lab_request_group_fixed() is
  '0158 (ORD-6): BEFORE UPDATE OF request_group_id on ehr.lab_requests; 55000 LAB_REQUEST_GROUP_FIXED when the group changes (a SET to the same value passes).';

reset role;
