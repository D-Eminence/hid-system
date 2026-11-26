-- 0154 Prescription refills (ORD-12, lane D). Owner decision Q131 A, 19
-- November 2026 ("yes to refills"); the clinical owner's design note on
-- hid-system#258 (Ola, 23 November 2026, 18:15 UTC), Rahman's review of it
-- (19:42 UTC) and Ola's answers (22:15 UTC), which this file builds (the
-- answers win where they differ from the note); and the clinical owner's
-- decisions of 24 November 2026 (about 16:15 UTC): D8, the cost of the
-- refill readers (R9, the refill scan marker); D9, an expiry for refills
-- (R8, the refills' last day); D10, confirmations (R1, R7). Written on Release B
-- (staging 926b1c58: 0001-0146) with 0148 (#317, Q132 A) merged in. The
-- number is provisional (the next after 0148-0153) and given in merge order;
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
--    the CHECK prescriptions_refills_allowed_ck (null, or 0-11, and 1-11 only
--    with 0125's duration_value and duration_unit: a refill's interval comes
--    from the duration, the clinical owner's rule of 24 November 2026; 0125's
--    own CHECK gives the two together or neither). A CHECK and not a test in
--    R4, because it fits 0125's model (the details are fixed at creation, as
--    this column is) and refuses the prescription when it is written, not
--    the pharmacy at the counter; ehr-api refuses it first (400
--    REFILLS_NEED_DURATION). With refills, that duration is how long ONE
--    fill lasts (one supply), not the whole course: a refill opens 3/4 of it
--    after the latest fill, so a course length entered there (90 days for
--    three monthly supplies) would hold each refill back until day 68, weeks
--    after the supply ran out. The column's comment, its CHECK's comment,
--    ehr-api's refusal and the prescribe form ("Duration of each fill") say
--    so; confirmed by the clinical owner (D10, 24 November 2026: decision 1
--    meant exactly that), who also accepted the coupling it brings: refills
--    above 0 need 0125's duration, so PRESCRIPTION_REFILLS_ENABLED needs
--    PRESCRIPTION_DISPENSING_DETAILS_ENABLED on. The refills end on R8's day.
--    Null means none: every existing row and every
--    row an image without ORD-12 writes.
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
--    NO_REFILLS_LEFT), and a refill is refused after the refills' last day,
--    R8's (23514 REFILL_PRESCRIPTION_ENDED, DETAIL that day, YYYY-MM-DD;
--    today in Lagos is (clock_timestamp() at time zone 'Africa/Lagos')::date,
--    as 0090 and 0095 compute it; the last day counts, as ehr-api reads
--    ends_on). A first fill is not checked against ends_on or R8's day
--    (unchanged; whether it should be is a question for the owner, outside
--    ORD-12). The refill interval (the clinical owner's safety rule, 24
--    November 2026): a refill is refused before the Lagos day of the
--    item's latest fill not reversed plus ceil(0.75 x the prescription's
--    duration in days) (a day 1, a week 7, a month 30; at least 1), 23514
--    REFILL_TOO_SOON with that day as DETAIL (YYYY-MM-DD); with every fill
--    reversed there is no wait. A refill whose day would come after R8's day
--    (a late fill: the patient came back late, so the interval from the
--    latest fill runs past the refills' last day) can never be recorded: it
--    is refused REFILL_PRESCRIPTION_ENDED at once, DETAIL R8's day (today or
--    later), not REFILL_TOO_SOON with a day on which it would be refused
--    (the review of 24 November 2026; refills close after the last
--    day, the owner's D9; this reading, and the screens' words "Refills end
--    on <date>, before the next one is due", confirmed by the clinical
--    owner the same day). No override: a clinician writes a new
--    prescription. The fills and reversals are read as the owner, matched on
--    the item. The values are the prescription row 0101 already reads FOR
--    SHARE, so a refill needs it active and unchanged since the item was
--    accepted: any change after the first fill, a hold then resume
--    included, ends the remaining refills (0101's version check; owner
--    decision at 0101:48-54).
--    Two more rules for a refill (Rahman's review of 25 November 2026, R4's
--    hardenings; the clinical owner's calls on #258, 26 November 2026; no
--    production writer reaches either: pharmacy-api sends fills so far + 1
--    and never names dispensed_at, whose default is the time of the
--    INSERT), checked after NO_REFILLS_LEFT and before the rules above:
--    (i) its number is the next one, 1 + every fill the item has (a
--    reversed one included), else 23514 REFILL_NOT_NEXT_FILL with that
--    count as DETAIL, so no number is skipped (a gap, fills 1 and 3, would
--    leave pharmacy-api answering 409 PHARMACY_FILL_NUMBER_CHANGED for good)
--    and two refills recorded at once carry the same number at any
--    isolation level, which R3's key refuses; (ii) a refill dispensed in the
--    future (dispensed_at later than clock_timestamp()) is refused, 23514
--    REFILL_DISPENSED_IN_FUTURE. A backdated refill (entered later at its
--    real time, after an offline period) stays allowed, and the interval
--    rule treats it as it treats any refill: it is judged on the day it is
--    entered (today, as above), not on its dispensed_at, so it is recorded
--    whenever a refill entered now would be; and, as the latest fill not
--    reversed, its own dispensed_at times the next refill. So a refill
--    dispensed offline before its day, and entered once it has opened, is
--    recorded at its real time, and the next one is due from that time.
--    The refills' last day is judged on today too. A first fill's
--    dispensed_at is checked as 0101 checks it (not at all; fill 1 is
--    unchanged): a future first fill only puts its refills later.
-- R5 pharmacy.claim_prescription_dispensing() (0133 D14, AFTER INSERT,
--    ENABLE ALWAYS) replaced: fill 1 exactly as before (it turns the item's
--    live, undispensed claim dispensed, or is refused sent_elsewhere or
--    not_claimed); fill 2 and above need the item's claim live, dispensed
--    and its own (no order route), else the same refusal. It never changes
--    or clears dispensed_at, which stays the first fill's: "after
--    dispensing" for 0148 and every 0133 and 0144 reader that tests it means
--    after the first fill. It reads only the claims, never ehr.prescriptions.
-- R6 pharmacy.work_item_refills(uuid[]) (new; plpgsql, VOLATILE, SECURITY
--    DEFINER, the owner's, search_path pg_catalog, pg_temp, every name
--    schema-qualified; EXECUTE to hid_pharmacy_runtime and
--    hid_schema_test_runtime only, as 0148's reader). For at most 200
--    requested work items (else 22023 WORK_ITEM_REFILLS_INVALID, a null
--    array too), one row per own item (no order route) the session may
--    read: refills_allowed (null read as 0), fills_recorded (every fill
--    row, a reversed one included), refill_open, closed_reason,
--    next_fill_on and refills_end_on (R8's day: the last Lagos day a refill
--    can be collected; null without refills). "May read" is 0148's C3 rule:
--    the session's facility, pharmacy.work-item.read, and
--    pharmacy.work_items' two read policies repeated as conditions (the
--    consent test, and 0133's own-work half). It reads in three steps: the
--    items, under the work items' own row-level security (for an own item
--    either policy lets the session read); their prescriptions, by id, in
--    its one statement that reads ehr.prescriptions, under R9's marker (the
--    owner then reads every row, so the function's own conditions decide,
--    as under a superuser owner, who bypasses row-level security); and the
--    answer, from those rows and the items' fills and reversals (whose own
--    policies, the consent test and 0133's own-work half, let the owner read
--    them for an own item the session may read), each prescription, fill
--    and reversal matched on the item's patient and facility. So a
--    superuser owner and a NOSUPERUSER NOBYPASSRLS owner answer alike
--    (section 3 pins those policies). A route-backed item, an item of
--    another facility or one the session may not read gives no row; so does
--    a session without a facility. An item with no fill yet reads
--    refill_open false and closed_reason null. Otherwise a refill is open
--    while fills_recorded < 1 + refills_allowed, the prescription is active
--    at the version the item was accepted at (and for its encounter), R8's
--    day is not before today in Lagos, and the refill's day (next_fill_on,
--    R4's interval) is today or past: exactly what R4 asks of the next fill,
--    which R5 lets through for an own item already dispensed (0133's claims
--    CHECK: a dispensed claim is never released). When it is not open,
--    closed_reason is the first that holds: 'none_left' (every allowed fill
--    recorded), 'stopped' (the prescription is not active: on hold,
--    completed, cancelled or entered in error), 'changed' (active again, but
--    not at the accepted version: an edit, or a hold then resume), 'ended'
--    (R8's day is past, or the refill's day would come after it) and
--    'not_yet' (the interval is running; next_fill_on is the day it opens,
--    never after R8's day). next_fill_on is that day while a fill is left
--    and nothing else closes it (today or earlier while open; with every
--    fill reversed, the latest reversal's day, no wait), else null. A stop
--    comes before a change because every status change is a new version
--    too. A refill whose day would come after R8's day (a late fill) can
--    never be collected, so it reads 'ended' at once (next_fill_on null,
--    refills_end_on R8's day, today or later), as R4 refuses it and R7
--    leaves it out; on R8's day itself a refill still opens. The reader
--    reads the work items' two read policies with 0133's own-work half
--    first (about 0.1 ms a call; the consent test about 2 ms), so a
--    pharmacist on the own-work basis never runs the consent test. The
--    reader knows nothing of
--    PRESCRIPTION_REFILLS_ENABLED: pharmacy-api reads a refill as open only
--    while that setting is on too. Its text names ehr.prescriptions, so it
--    joins 0133 D5's list of owner-run definer functions that read
--    prescriptions (0133's suite's S7 list), and each suite that pins that
--    list names it. VOLATILE, because it writes R9's marker: the transaction
--    that calls it must be able to write (a READ ONLY one is refused,
--    25006); pharmacy-api calls it in its work list and its item read, both
--    READ COMMITTED and read-write, and nowhere else. Under READ COMMITTED
--    each of its steps reads the latest committed rows, as each statement of
--    pharmacy-api's request does. 0125's reader
--    (pharmacy.work_item_prescription_details) is not replaced.
-- R7 pharmacy.open_refill_work_items() (new; plpgsql, VOLATILE, SECURITY
--    DEFINER, the owner's, search_path pg_catalog, pg_temp, every name
--    schema-qualified; EXECUTE as R6's), with its index on ehr.prescriptions,
--    prescriptions_refills_facility_idx (facility_id, created_at, R8's day)
--    WHERE refills_allowed > 0. No ids are passed: it answers the ids of the
--    session's own items whose refill is open now, by R6's rule exactly (the
--    session's facility, pharmacy.work-item.read and the work items' two read
--    policies repeated; at least one fill and fewer than 1 + refills_allowed;
--    the prescription active at the accepted version and encounter; R8's day
--    not before today in Lagos; the refill's day come), the refill that
--    opened first first (then the item id), at most 200. pharmacy-api's work
--    list counts those items as open work, so a refill that is open stays
--    listed however many items were filled after it, and R6 is asked only
--    about the rows the list shows. Its one statement that reads
--    ehr.prescriptions runs under R9's marker and starts from the session
--    facility's active prescriptions that allow refills and have not ended:
--    it range-scans R7's index by facility and by the time written, from the
--    Lagos day 365 days ago (R8's rule (c), stated as a range on created_at),
--    and keeps those whose R8 day is today or later. PostgreSQL applies a
--    table's row-level security before any condition that is not leakproof,
--    and only a superuser can mark a function leakproof, so under a
--    NOSUPERUSER NOBYPASSRLS owner (production's kind) R8 cannot bound the
--    index scan: there the read is every prescription of the facility that
--    allows refills and was written in the last 365 days, ended or not, R8
--    checked on each (under the marker, about 10 microseconds a row): a
--    narrower bound than D9 asked ("only the facility's prescriptions whose
--    refills have not ended are read"), accepted by the clinical owner (24
--    November 2026, with no stored column: one for R8's day would make it
--    exact under this owner kind, but adding one rewrites ehr.prescriptions
--    under its lock); under an owner that bypasses row-level security the
--    index's third column, R8's day, leaves the ended ones out inside the
--    index as well. Either way its cost no longer grows with the
--    facility's history: a prescription leaves R7's set on R8's day at the
--    latest (one fill's length after its course should have finished, or a
--    year), however its refills ended (used up, changed, never collected).
--    The rows it then reads (the work items, then each item's fills and
--    reversals, found by the item) stay under their tables' own row-level
--    security. For a session on the own-work basis (a pharmacist: each
--    table's own-work policy holds before the consent test is asked) that
--    is about 0.15 ms per live refill prescription under the NOSUPERUSER
--    NOBYPASSRLS owner (1.4-1.5 s at 10,000 open at once, measured below),
--    so its 3-second limit would be reached at about 20,000 at once. The
--    work items' two read policies (the own-work half first) are asked
--    only of the due items it answers, in its order, until 200 pass: asked
--    of every due item before the sort, with the consent test (about 2 ms a
--    call) first, R7 grew about 2 ms for each refill open at once and
--    reached the 3-second limit at about 1,400-1,500 open at once, after
--    which every list load would have said refillsUnavailable (the review
--    of 24 November 2026). Those figures are for own-work sessions only. A
--    session that may read only on consent (a clinician or a nurse:
--    pharmacy.work-item.read without pharmacy.order-route.receive, so
--    identity.facility_work_session_membership is null for it, and
--    GET /pharmacy/work-items lets it in) pays the consent test (about 1.5
--    to 2 ms a call) instead: under the NOSUPERUSER NOBYPASSRLS owner the
--    work items' own policy asks it of every live refill prescription's
--    item, and the fills' asks it again of each item it may read, so R7
--    grows about 1.5-1.9 ms for each live refill prescription it may not
--    read and about 3.4-3.9 ms for each it may, and reaches the 3-second
--    limit at about 1,800 or about 800 of them (measured below; past the limit the
--    list answers without open refills and says refillsUnavailable, so the
--    answer stays correct); under an owner that bypasses row-level
--    security only R7's own check asks it, of the due items until 200
--    pass, so it grows only with the due items it may not read. The
--    clinical owner's gate measures the hospital's numbers (24 November
--    2026); a work list opened by such a session costs that much more. A
--    session without a facility or without pharmacy.work-item.read writes
--    no marker and gets no row. Its text names ehr.prescriptions, so it
--    joins 0133's S7 list too. VOLATILE, as R6, and called only by
--    pharmacy-api's work list (READ COMMITTED, read-write), under the list's
--    own 3-second limit for it (OPEN_REFILLS_TIMEOUT_MS, kept as a guard: the
--    clinical owner's D10).
-- R8 ehr.prescription_refills_end_on(written_at timestamptz,
--    refills_allowed smallint, duration_value integer, duration_unit text,
--    ends_on date) returns date (new; SQL, IMMUTABLE, PARALLEL SAFE, not
--    SECURITY DEFINER, search_path pg_catalog, pg_temp, the owner's): the
--    last Lagos day a refill can be collected (the clinical owner's decision
--    D9, 24 November 2026), the earliest of (a) the prescription's ends_on;
--    (b) the Lagos day it was written plus (refills_allowed + 2) times one
--    fill's duration in days (a day 1, a week 7, a month 30): one fill's
--    length after the course should have finished; (c) that day plus 365.
--    Null when it allows no refill (null or 0). "Written" is created_at:
--    ehr.prescriptions has no column that records when it was issued
--    (starts_on is the course's start as the prescriber enters it, optional,
--    and may lie ahead), and created_at is set at creation (its default) and
--    never named by ehr-api's update; any change bumps the version, which
--    ends the refills anyway (0101's check), and 0004's versioning trigger
--    records each. A draft activated later counts from when it was written.
--    After R8's day the refills are closed: R6 'ended', R4
--    REFILL_PRESCRIPTION_ENDED (DETAIL the day), R7 leaves the item out.
--    The day is computed in this one place: R4, R6, R7 and R7's index call
--    it. IMMUTABLE holds: it reads no table, and timezone(text, timestamptz)
--    and timestamp::date are immutable (Africa/Lagos has had one offset since
--    1919; a change of that zone's rules would need R7's index rebuilt).
--    EXECUTE: the owner, and the two runtimes that may write
--    ehr.prescriptions (hid_ehr_runtime, hid_schema_test_runtime; here and
--    in runtime-grants.sql), because PostgreSQL evaluates an index
--    expression as the role that inserts or updates the row (without it,
--    writing a prescription with refills is refused, 42501); ehr-api may
--    call it to say "Refills can be collected until <date>". Nothing to
--    PUBLIC.
--    The limit this sets (Rahman's review of 25 November 2026): a
--    prescription whose first refill could open only after R8's day can
--    never have a refill collected: one fill longer than 486 days (3/4 of
--    it, rounded up, is more than 365), or an end date (ends_on) before the
--    Lagos day written plus the refill interval. This file accepts it (the
--    late-fill rule closes it at fill 1: R6 'ended', R4
--    REFILL_PRESCRIPTION_ENDED, R7 leaves it out, so nothing unsafe is
--    recorded); ehr-api refuses it when it is written, 400
--    REFILLS_CANNOT_BE_COLLECTED, asking R8 on the row it has just inserted
--    and this file's refill interval (the clinical owner's call on #258, 26
--    November 2026); the interface contract states the limit.
-- R9 the refill scan marker (the clinical owner's decision D8, 24 November
--    2026; 0143 D1's form, and 0133's THE COST). Under the production owner
--    kind (NOSUPERUSER NOBYPASSRLS) every ehr.prescriptions row R6 and R7
--    read paid the table's OR'd read policies (0005's consent test, about
--    0.6 ms, 0133 D5's own-work source read and most of the rest): about 10
--    ms a row. Now: the table pharmacy.refill_scans (backend_pid integer,
--    transaction_started_at timestamptz, primary key both; the owner's only,
--    no grant, no row-level security); pharmacy.refill_scan_open() (SQL,
--    STABLE, SECURITY DEFINER, cost 1, search_path pg_catalog, pg_temp;
--    EXECUTE to PUBLIC, because PostgreSQL checks EXECUTE on every function
--    of a plan when it starts it, and every role that reads
--    ehr.prescriptions plans the policy below), which answers only whether
--    a marker row carries this backend's pid and this transaction's start
--    time (transaction_timestamp()); that key is 0130's, 0143's and 0145's,
--    and it does not single out one transaction (transactions begun within
--    one simple-protocol message share their start time), which is enough
--    here because R6 and R7 never commit a marker, so no other transaction
--    can see one (a later file that holds a marker longer should key it on
--    pg_current_xact_id_if_assigned()); and the policy
--    prescriptions_scan_refills on ehr.prescriptions, permissive, for
--    SELECT, to PUBLIC, using ((select case when pg_has_role(<the table's
--    owner, looked up as 0143 does>, 'USAGE') then
--    pharmacy.refill_scan_open() else false end)): one scalar subquery, so
--    one InitPlan, run once per statement; the owner's membership tested
--    first, so a runtime role's read never depends on the marker and never
--    runs the test. PostgreSQL joins a table's permissive policies with OR
--    in reverse order of their names and stops at the first that holds, so
--    its name sorts after every other read policy of the table (after
--    0143's prescriptions_scan_my_orders) and it is asked first: inside R6's
--    and R7's statement no other policy of ehr.prescriptions is asked. R6
--    and R7 write the marker just before their one statement that reads
--    ehr.prescriptions and delete it just after, keeping what they need
--    from that statement in local arrays; the statement calls only R8,
--    which reads no table, so nothing else runs while the marker is held and
--    nothing reads ehr.prescriptions under it for another purpose. Their own
--    conditions stay the access rule, as a superuser owner runs them. Every
--    other owner-run reader of ehr.prescriptions (R4, 0100's and 0144's
--    checks, 0133's sends, 0143's list, the rest of the S7 list) sees what
--    it saw before (one more InitPlan, false), and the owner without a
--    session still sees nothing. The marker is transactional: an error in
--    that statement rolls it back with the statement's transaction or
--    savepoint, so no row survives a return or an error. No hid_ role but
--    the owner is a member of the table's owner (section 0 j, and a
--    post-check in 0133's form), so no runtime can pass the policy's first
--    test, write a marker or read under one. Serializable transactions:
--    every owner-run read of ehr.prescriptions now reads
--    pharmacy.refill_scans in the policy, R4 in pharmacy-api's SERIALIZABLE
--    dispensings and 0144's acceptance among them; the marker's only
--    writers, R6 and R7, run in pharmacy-api's READ COMMITTED work list and
--    item read, and PostgreSQL's serializable checks track serializable
--    transactions only, so a marker write takes part in no serialization
--    failure (measured below).
--
-- Replica mode (session_replication_role = replica) skips R4 (origin mode),
-- so the refill count, the refills' last day (R8) and the refill interval
-- are not enforced there (the clinical owner's call: no replica-mode writer records
-- refills). The backstops that
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
-- number stays taken), to any trigger or row-level security setting, or to
-- any policy but the one R9 adds. The table grants are table-wide (the EHR
-- runtime's SELECT, INSERT and UPDATE on ehr.prescriptions; the Pharmacy
-- runtime's SELECT and INSERT on pharmacy.dispensings), so the new columns
-- need no grant; R6's, R7's, R8's and R9's EXECUTE (and R9's table, the
-- owner's only) are granted here and in runtime-grants.sql (0154's block).
-- In origin mode a refill's number must be the next one (R4 (i)); in
-- replica mode, where R4 does not fire, numbers need not be contiguous (no
-- replica-mode writer records refills), and the bound there is on how many
-- rows an item can have (R2's CHECK, R3's key).
--
-- Grants files. Only the union may run after this file: Release E's
-- runtime-grants.sql (49b378f5...) followed by 0154's block, byte for byte
-- (57e06a12...). The role bootstrap revokes every runtime grant before it
-- applies a file, so Release E's file alone, or Release C's (1c10c2e0...),
-- run after this file drops six grants: R6's and R7's EXECUTE from
-- hid_pharmacy_runtime and hid_schema_test_runtime, and R8's from
-- hid_ehr_runtime and hid_schema_test_runtime. Once a prescription with
-- refills exists, ehr-api could then neither create one nor make a non-HOT
-- update to one (R7's partial index runs R8 as the writer: 42501), the work
-- list would say refillsUnavailable, and the bootstrap would still report
-- "provisioned and verified" (its runtime-roles suite does not name 0154's
-- functions).
--
-- 0. Preconditions (catalog reads only, no table lock; 55000, or 42501 for
--    the owner and the applier; nothing applied): a. 0001-0148 applied
--    (0148's table and two functions, 0144's acceptances and their
--    validator, 0133's claims); b. already applied (the six bodies, both
--    columns, the new key, R7's index, R9's table and policy: "0154: already
--    applied", nothing changes; it checks names and bodies, not grants,
--    owners or the policy's expression, so drift after apply, such as a
--    changed ACL, still reads "already applied": out of this file's scope,
--    as for 0143 and 0148); c. no column, constraint, index, table,
--    policy or function of this file's names; d. every
--    column the new bodies read, by name and type (created_at among them,
--    for R8); e. the two replaced
--    trigger functions (md5, attributes, no EXECUTE for anyone), 0133's
--    work-item claim and 0148's C2 (C2 strips null-valued keys, which R1
--    relies on; f61173d77be391a9e9c96db494827e82); and, by md5, every
--    function R4, R6 and R7 call and every function the policies of
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
--    and no other, but for one: Billing's zz_billing_stock_and_gate
--    (commercial.hook_dispensing(), BEFORE INSERT FOR EACH ROW, origin
--    mode), exactly that, may be there as a sixth, should Billing's 0167 be
--    released first (Rahman's release-order review of 25 November 2026,
--    should-fix 3; its name sorts after the five, so it fires after the
--    validator); h. one owner (0148's e and f, for a NOSUPERUSER
--    NOBYPASSRLS owner, as production's): pharmacy.work_items' owner owns
--    pharmacy.dispensings, ehr.prescriptions and 0133's claims, the two
--    replaced functions and the policy functions R6 and R7 repeat and
--    0133 D5's source read, and owns or may execute every other function
--    above; the applier is that owner, or inherits it and may SET ROLE to
--    it; that owner may create in pharmacy and ehr (R8) and use the schemas
--    the bodies name; i. row-level security as 0133 left it; j. 0133 D5's
--    premise (no hid_ role a member of that owner; R9 rests on it too). Every
--    owner-run SECURITY DEFINER
--    function's catalog row and both altered tables' ACLs are kept for
--    section 7.
-- 1. Act as the owner for the rest of the transaction.
-- 2. Locks (below).
-- 3. Under the locks, what prints a key, a CHECK or a policy
--    (pg_get_constraintdef and pg_get_expr open the table they print for,
--    so before the locks they could wait behind DDL): 0023's key by its
--    definition; 0133 D14's claims CHECK (a dispensed claim is never
--    released: R5's and R6's premise); every policy of ehr.prescriptions,
--    pharmacy.dispensings, pharmacy.dispensing_reversals and
--    pharmacy.work_items exactly (name, command,
--    permissive, roles and both expressions, by md5 of their printed text;
--    so none is restrictive and no other is there); 0148's order of the
--    AFTER UPDATE triggers on ehr.prescriptions.
-- 4. R8 and its EXECUTE (revoked from PUBLIC; granted to the two runtimes
--    that may write ehr.prescriptions and exist); R4 and R5, replaced
--    (CREATE OR REPLACE keeps owner, ACL and triggers); their comments.
-- 5. R1 (column, CHECK NOT VALID, VALIDATE) and R7's index (one scan of
--    ehr.prescriptions, no entry: the column is new, so R8 runs on no row),
--    R2 (column, CHECK NOT VALID, VALIDATE), R3 (the new key, then 0023's
--    dropped), and the comments.
-- 6. R9 (the marker table, its test and the policy, with their grants and
--    comments), then R6 and R7, their EXECUTE (revoked from PUBLIC; granted
--    to the two runtimes that exist) and their comments.
-- 7. Post-checks (55000, nothing applied): the four plpgsql functions
--    exactly (md5, owner, attributes, VOLATILE, result, ACL); R5 and R9's
--    test name no ehr.prescriptions and R6 and R7 do (0133's S7 list gains
--    R6 and R7 and nothing else: no other owner-run definer made but R9's
--    test, none replaced or dropped); both columns (type, null, default, no
--    column ACL); both CHECKs validated, exactly; the new key exactly and
--    0023's gone, and pharmacy.dispensings' unique indexes exactly three;
--    R7's index exactly, and the only index calling R8; R8 exactly (md5,
--    owner, SQL, IMMUTABLE, PARALLEL SAFE, not definer, search_path,
--    EXECUTE for the owner and the two runtimes only); R9 exactly, as 0143's
--    post-checks (the table's columns, key, owner, no row-level security and
--    no grant; the test's md5, owner, SQL, STABLE, definer, cost 1,
--    search_path, EXECUTE for PUBLIC only; the policy's exact expression by
--    md5, permissive, SELECT, PUBLIC; no permissive read policy of
--    ehr.prescriptions sorting after it; no hid_ role but the owner a member
--    of the table's owner); the triggers and modes section 0 found (the
--    five, or the five and Billing's, g); 0148's AFTER UPDATE
--    order on ehr.prescriptions and C2's md5; owners, row-level security and
--    both tables' ACLs unchanged; a probe, undone: R6 refuses 201 ids and a
--    null array (it opens no table and writes no marker to do so); no marker
--    row.
--
-- Locks. Section 2, one DO block, each attempt in its own subtransaction:
-- ACCESS SHARE NOWAIT on pharmacy.work_items, ehr.order_routes, 0133's
-- claims and pharmacy.dispensing_reversals (section 4's compile of R4
-- resolves the first two's row types; section 3 prints the claims' CHECK
-- and the policies of the work items and of the reversals, and pg_get_expr
-- opens the table whose policy it prints: the review of 25 November 2026
-- found the reversals read there unlocked, so behind DDL on them the file
-- waited the runner's 5 s lock_timeout while it held the two ACCESS
-- EXCLUSIVE locks below, then failed with the server's message, which the
-- dry run does not retry; now, behind ACCESS EXCLUSIVE on the reversals,
-- the apply refuses with its own text after about 5 s, holding neither
-- strong lock meanwhile, and the dry run retries it:
-- services/ehr-api/scripts/prescription-refills-busy.test.mjs, against a
-- disposable server), then
-- ACCESS EXCLUSIVE NOWAIT on pharmacy.dispensings and ehr.prescriptions
-- (ALTER TABLE ADD COLUMN, ADD CONSTRAINT and DROP CONSTRAINT need it, and
-- R9's CREATE POLICY), so an attempt that fails never holds the strong
-- locks. Compiling R4 (CREATE
-- OR REPLACE FUNCTION runs plpgsql's validator) resolves its %ROWTYPE
-- declarations, which opens pharmacy.work_items, ehr.order_routes and
-- ehr.prescriptions; before the locks, a session holding ACCESS EXCLUSIVE on
-- one of them (DDL) made the file wait for the runner's 5 s lock_timeout and
-- fail with the server's message, which the dry run does not retry, so the
-- functions are replaced after the locks. A busy table fails the attempt at
-- once and its subtransaction releases what it took; the attempt is made
-- again every 100 ms for at most 5 seconds (50 attempts), then 55P03 "0154:
-- ... stayed busy for 5 seconds; nothing applied; ...". When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run of every pending file; its
-- own ledger table aside), one attempt and no sleep: 55P03 "0154: ... so it
-- does not wait; nothing applied; ..." at once (0148's rule; 0125's loop has
-- no such branch). Both texts end as the runner's busy-refusal pattern wants
-- (services/ehr-api/scripts/dry-run-attempts.mjs; its test feeds it this
-- file's texts). Sections 0 and 1 take no table lock (section 0 reads the
-- catalog only). R8 and R9's table and test are new objects (CREATE
-- FUNCTION and CREATE TABLE wait for no other session); R7's index build
-- takes SHARE on ehr.prescriptions, inside the ACCESS EXCLUSIVE held.
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
-- only DDL on the work items, the routes, the claims and the reversals;
-- their reads and writes go on. Behind an open reader or writer of either
-- altered table, an autovacuum or ANALYZE of either (SHARE UPDATE
-- EXCLUSIVE), or DDL on any of the six, the file stops after 5 seconds,
-- nothing applied, and never blocks them. In the dry run the locks last until the dry run ends.
-- pg_locks before commit, with either applier: ACCESS EXCLUSIVE on
-- pharmacy.dispensings, ehr.prescriptions, the new key's index, R7's index
-- and 0023's dropped key's index (and the weaker locks VALIDATE, the index
-- builds and the comments take on the same tables and indexes), on R9's new
-- table pharmacy.refill_scans and its key's index (made in this
-- transaction, so no other session can want them), ACCESS SHARE on
-- pharmacy.work_items, ehr.order_routes, 0133's claims and
-- pharmacy.dispensing_reversals, and no other application table (R5's, R6's and R7's statements are planned only when
-- they first run; section 7's probe opens no table, and its check that no
-- marker row is left reads R9's own table); after section 0, none.
-- Measured on throwaway PostgreSQL 16 with 0001-0146 and 0148 applied and
-- 20,000 prescriptions, own work items and dispensings (fictional data),
-- ten runs with a superuser applier and ten with a NOSUPERUSER NOBYPASSRLS
-- applier (this text, with R8 and R9):
--   the file takes 69-116 ms to commit; the hold, from the locks to commit,
--   is 48-74 ms in all 20 runs. Under the locks: section 3 3.1-4.9 ms; R8 and
--   R4 and R5 2.0-3.4 ms; R1 (the column, its CHECK and the scan of 20,000
--   prescriptions) 4.7-6.7 ms; R7's index (one more scan, no entry: R8 runs
--   on no row; it takes SHARE on ehr.prescriptions, inside the ACCESS
--   EXCLUSIVE already held, so it adds no wait) 5.4-22.1 ms; on
--   pharmacy.dispensings, the column 0.7-1.2 ms, its CHECK's scan 4.0-7.2 ms,
--   the new key's index build 9.2-16.5 ms and 0023's key dropped 0.4-0.7 ms;
--   R9 (its table, test and policy) 1.6-3.5 ms; R6, R7 and their grants
--   1.6-4.6 ms; the post-checks 12.7-32.3 ms; commit 0.8-2.2 ms. Section 0,
--   before any lock, 18-41 ms;
--   the hold grows with the two tables (Rahman's review of 25 November
--   2026, production's owner kind): under the two ACCESS EXCLUSIVE locks
--   R1's and R2's VALIDATE and R3's and R7's index builds each scan a
--   whole table, so from the locks to commit it took 73-110 ms with 20,000
--   prescriptions and 20,000 dispensings, 216-549 ms with 200,000 of each
--   and 0.9-1.1 s with 1,000,000 of each (R3's index build 407 ms of it).
--   Callers wait and do not fail (statement_timeout 15 s, no pool sets a
--   lock_timeout); the release note gives the hold for production's row
--   counts of ehr.prescriptions and pharmacy.dispensings;
--   behind another session's open read (ACCESS SHARE), write (ROW
--   EXCLUSIVE), SHARE UPDATE EXCLUSIVE (as autovacuum) or ACCESS EXCLUSIVE
--   on pharmacy.dispensings or on ehr.prescriptions, or ACCESS EXCLUSIVE on
--   pharmacy.work_items, ehr.order_routes or 0133's claims, the file stops
--   with section 2's 55P03 after 4.99-5.03 seconds (22 runs, both
--   appliers), nothing applied, while a third session reading prescriptions
--   (one FOR SHARE) and dispensings every 50 ms under a 200 ms lock_timeout
--   never fails (slowest read 29 ms; when the blocker is DDL on a table it
--   reads, its own reads wait for that, not for this file); with an earlier
--   migration's lock held in the same transaction it stops at once (31-46
--   ms) with the one-attempt text; an open reader of pharmacy.work_items, or
--   a writer of ehr.order_routes or of 0133's claims, does not stop it
--   (72-124 ms);
--   with this file's transaction held open before commit (either applier;
--   the earlier text's runs, whose section 2 this text keeps),
--   a read of a prescription, a FOR SHARE read of one, a read of a
--   dispensing and the Pharmacy runtime's own-work outbox insert (planned:
--   its policy reads pharmacy.dispensings) each wait (55P03 under a 100 ms
--   lock_timeout), while reads of the work items, the routes and the claims
--   and writes of the work items and the claims run at once;
--   the runner itself (NOSUPERUSER NOBYPASSRLS applier; the earlier
--   text's runs): its dry run, behind
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
--   R6 for the 200 own items a list shows, read by a pharmacist on the
--   own-work basis (20,000 items in the facility, each filled once; 200 to
--   10,000 of them allow 2 refills of 30 days and have a refill open), 3
--   calls in each of six runs, as the Pharmacy runtime: 0.053-0.072 s under
--   the NOSUPERUSER NOBYPASSRLS owner and 0.016-0.023 s under a superuser
--   owner. 0154 without R9 took 2.2-2.5 s under the NOSUPERUSER NOBYPASSRLS
--   owner (the row-level security of ehr.prescriptions on the 200 rows);
--   with R9 and the consent test asked first in its own conditions,
--   0.37-0.42 s (that test, about 2 ms a call, was nearly all of it; 0.32-0.44
--   s under a superuser owner);
--   R6 for a session that may read only on consent (a nurse or a
--   clinician; Rahman's review of 25 November 2026, production's owner
--   kind): about 0.8-0.9 s for 200 own items it may read, against about 40
--   ms for a pharmacist on the own-work basis, as it asks the consent test
--   about 3 times an item (the work items' own policy, R6's own check, the
--   fills' policy), so a work list or item read opened by such a session
--   costs that much more; pharmacy-api calls R6 in a savepoint under the
--   same 3-second OPEN_REFILLS_TIMEOUT_MS guard as R7, and past it answers
--   without refills (the clinical owner's call, 26 November 2026); the
--   whole request measured at the hospital's numbers before the setting
--   goes on (the interface contract's "Before the setting goes on", 2)
--   includes it;
--   R7 as the same pharmacist, the same facility, with K refills open at
--   once (K prescriptions allowing 2 refills of 30 days, written 24 to 60
--   days ago, filled once; so K live, all due), 3 calls at each K, under the
--   NOSUPERUSER NOBYPASSRLS owner: 0.057-0.109 s at 200, 0.095-0.123 s at
--   500, 0.17-0.20 s at 1,000, 0.30-0.40 s at 2,000, 0.78-0.82 s at 5,000,
--   1.44-1.51 s at 10,000 (about 0.15 ms for each live refill
--   prescription: the work items' and the fills' own row-level security,
--   which D8 leaves as it is, no marker on other tables; so its 3-second
--   limit in pharmacy-api would be reached at about 20,000); under a
--   superuser owner 0.014-0.030 s at 200, 0.031-0.051 s at 2,000,
--   0.085-0.110 s at 10,000. With the read policies asked of every due item
--   before the sort, the consent test first (this file's earlier text), the
--   same runs took 0.38-0.43 s at 200, 1.95-2.36 s at 1,000 and 3.81-4.32 s
--   at 2,000 under the NOSUPERUSER NOBYPASSRLS owner (1.81-1.85 s and
--   3.63-3.76 s under a superuser owner): about 2 ms for each refill open at
--   once, the 3-second limit at about 1,400-1,500 (auto_explain at 2,000:
--   that filter 5.3 s of 7.1 s with per-node timing on, and a nested loop
--   between the items and their fills, 4,000,000 comparisons, 0.7 s);
--   0154 without R9 took 2.3-2.5 s at 200 and 20.3-22.2 s with 2,000 live
--   refill prescriptions (about 10 ms a prescription). With 19,800 more
--   prescriptions allowing refills, written in the last 365 days and all
--   ended, and 200 live (every one of the facility's 20,000): 0.18-0.21 s
--   under the NOSUPERUSER NOBYPASSRLS owner (its prescriptions statement
--   reads all 20,000 and checks R8 on each, about 10 microseconds a row; the
--   planner reads the table, as they are all of it) and 0.016-0.029 s under
--   a superuser owner (R8 a condition on R7's index: 304 rows read);
--   R7 as a clinician of the same facility, who may read only on consent
--   (pharmacy.work-item.read without pharmacy.order-route.receive), K
--   refills open at once as above, 3 calls at each K (the review of 24
--   November 2026, fifth round): without a consent grant (it may read none
--   of the items; R7 answers none), under the NOSUPERUSER NOBYPASSRLS owner
--   0.29-0.31 s at 200, 0.75-0.78 s at 500, 1.41-1.51 s at 1,000 and
--   3.12-3.67 s at 2,000 (the consent test asked once for each live item,
--   by the work items' own policy), under a superuser owner 0.29-0.37 s,
--   0.71-0.85 s, 1.41-1.59 s and 3.23-3.47 s (asked by R7's own check of
--   every due item, none passing); with a read grant for every patient (it
--   may read them all; R7 answers 200), under the NOSUPERUSER NOBYPASSRLS
--   owner 0.89-0.94 s, 1.85-1.92 s, 3.45-3.94 s and 6.79-6.88 s (the work
--   items' consent test once for each live item, the fills' once more, R7's
--   own check 200 times), under a superuser owner 0.33-0.51 s at each K
--   (R7's own check 200 times); the pharmacist in the same runs 0.05-0.06 s,
--   0.09-0.15 s, 0.18-0.25 s and 0.30-0.35 s (NOSUPERUSER NOBYPASSRLS), the
--   consent test asked 0 times;
--   a whole work-list request with the setting on (pharmacy-api's own list
--   code, every reader on: R7, the list statement, R6 on the 200 rows shown,
--   0124's cards, 0125's details, 0133's states, 0148's changes and the
--   audit rows), 11 loads each, under the NOSUPERUSER NOBYPASSRLS owner:
--   3.7-4.3 s (median 4.0 s) with 200 refills open at once (8.2-9.8 s
--   before R9), 3.9-4.3 s (median 4.0 s) with 2,000 (with the earlier R7,
--   R7 was stopped at its 3-second limit on every load and the request took
--   7.0-7.7 s and said refillsUnavailable), 5.0-5.5 s (median 5.3 s) with
--   10,000 (R7 1.49-1.67 s); under a superuser owner 3.0-3.4 s, 2.9-3.4 s
--   and 3.0-3.3 s. No load said refillsUnavailable and no marker row was
--   left. Most of what is left is the list statement (2.8-3.4 s). The
--   fixture's pharmacist has no consent grant and the fixture no 0125
--   prescription snapshots, so 0124's cards and 0125's details answered
--   almost nothing; where they do, add the interface contract's section 46
--   figures;
--   R9 and serializable transactions (the clinical owner's D8 test), on the
--   same facility with 400 more prescriptions allowing 11 one-day refills,
--   twice each way: for 60 seconds, 8 sessions running the work list's
--   refill readers as pharmacy-api does (R7, then R6 on the 200 rows shown;
--   READ COMMITTED, read-write) and 4 sessions each recording a refill of
--   its own items and then reversing it as pharmacy-api's dispense() and
--   reverse() do (SERIALIZABLE: the item and its fills read first, then the
--   INSERT, whose validator R4 reads the prescription FOR SHARE as the
--   owner and so plans R9's policy), each 40001 or 40P01 run again as
--   DatabaseService does. Under the NOSUPERUSER NOBYPASSRLS owner: with R9,
--   452 and 488 serialization failures (40001) for 394 and 397 refills
--   recorded and reversed (1.15 and 1.23 a refill), and 90 and 95 list
--   loads; with 0154 as it was before R9, 476 and 494 for 393 and 403 (1.21
--   and 1.23), and 16 list loads each. Under a superuser owner (who asks no
--   policy): with R9 699 and 700 for 585 and 645 (1.19 and 1.09), without
--   641 and 663 for 521 and 576 (1.23 and 1.15). No 40P01 in any run, no
--   list load failed, and no marker row was left: the failures are the
--   dispensings' and reversals' own (they read and write the same tables'
--   index pages), as many with R9 as without it;
--   the same test once more on this file's R6 and R7 (the read policies
--   asked only of the items answered, the own-work half first; 200 live
--   refill prescriptions, fixture as the cost runs), 60 seconds each way:
--   under the NOSUPERUSER NOBYPASSRLS owner, 311 serialization failures for
--   126 refills recorded and reversed with R9 (2.47 a refill, 40 list loads,
--   none flagged), 338 for 136 without it (2.49 a refill; 24 list loads, all
--   flagged refillsUnavailable, R7 stopped at 3 s without R9); under a
--   superuser owner 495 for 242 with it (2.05) and 525 for 235 without
--   (2.23). No 40P01 and no marker row left in any run;
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
-- the new column is ignored, and it never calls R6 or R7. Their writes of
-- ehr.prescriptions never set refills_allowed, so R7's partial index (and
-- R8 in it) is never asked on their rows; their reads of ehr.prescriptions
-- plan R9's policy (one more InitPlan, false for every runtime). 0086's route
-- return, 0088's and 0090's wrong-patient voids (route-backed items, one
-- fill) and every 0133 and 0144 reader (they test whether a dispensing
-- exists) answer as before.
--
-- New services and rollback (Ola's answers). Release order: this file
-- (after 0147, 0148 and 0149-0153), then the event-dispatcher that accepts
-- fillNumber on MedicationDispensed, then pharmacy-api, then ehr-api and the
-- staff front ends; PRESCRIPTION_REFILLS_ENABLED (off by default, apart
-- from 0125's setting) goes on last, and only once both staff front ends
-- (health and apps/pharmacy) handle more than one fill. The first
-- refills-aware pharmacy-api reads one row per item whatever the setting
-- (the latest fill, fill numbers, R6 and R7), so it needs this file, and it
-- answers not ready (GET /health/ready, 503) on a database without
-- pharmacy.dispensings.fill_number, so a deploy before this file fails its
-- health check instead of answering 500; only recording a fill above 1
-- waits for the setting. While the setting is on, its work list asks R7
-- which own items have a refill open (under R7's own 3-second limit; a
-- failure lists no open refill and the answer says refillsUnavailable) and
-- R6 about the own rows it shows; both in a READ COMMITTED, read-write
-- transaction, as R6 and R7 write R9's marker. R6's refills_end_on is new
-- (pharmacy-api's refills.endsOn; it reads R6's named columns, so an image
-- that does not know it ignores it), and R4's REFILL_PRESCRIPTION_ENDED now
-- carries the day as DETAIL.
-- Rollback floor: once any
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
--    so no image can record a refill; recorded fills stay. R6, R7, R8 and
--    R9 stay (they still answer what was recorded; refill_open may read
--    true, and R7 may name an item, where the database now refuses, so the
--    setting stays off). Precondition b then no longer reads "already
--    applied", and c refuses to apply the file again while either column,
--    R6, R8 or R9 exists.
-- 2. Only if 0023's one-fill key must come back: in a quiet window, lock
--    pharmacy.dispensings ACCESS EXCLUSIVE NOWAIT, lift FORCE ROW LEVEL
--    SECURITY for that transaction only (as 0133 section 3c did; a count
--    under forced row-level security sees only the session's rows), refuse
--    if any row has fill_number > 1, then `add unique (work_item_id)`, drop
--    dispensings_work_item_fill_number_key and dispensings_fill_number_ck,
--    restore FORCE. Drop the column fill_number only after no running
--    pharmacy-api names it (none above the rollback floor may run then).
-- 3. Only after no running pharmacy-api calls them: drop function
--    pharmacy.work_item_refills(uuid[]) and pharmacy.open_refill_work_items();
--    then, in a quiet window (each takes ACCESS EXCLUSIVE on
--    ehr.prescriptions, NOWAIT as section 2), drop policy
--    prescriptions_scan_refills on ehr.prescriptions and drop index
--    ehr.prescriptions_refills_facility_idx; then drop function
--    pharmacy.refill_scan_open() and table pharmacy.refill_scans (the policy
--    calls the one, which reads the other), and drop function
--    ehr.prescription_refills_end_on(timestamptz, smallint, integer, text,
--    date) (the index, R4 after step 1 no longer, and nothing else calls
--    it), and remove their lines from runtime-grants.sql in the same
--    release. Every other owner-run reader of ehr.prescriptions then plans
--    one InitPlan fewer and sees what it sees now.
-- 4. ehr.prescriptions.refills_allowed and its CHECK can stay (nullable,
--    unread by old images). Drop them only after no running ehr-api names
--    the column and R6, R7, R8 and R7's index are gone; dropping it changes
--    the fingerprint of every prescription that carried a value, so the
--    first resume of such an item after that reads 'edited'.
-- The ledger row stays.

-- 0. Preconditions.
do $$
declare
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  owner_oid oid;
  validator_owner oid;
  dispensing_triggers text[];
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
    raise exception using errcode = '55000', message = '0154: 0001-0148 must be applied first';
  end if;
  -- b. Already applied: the six bodies are this file's (R4-R8 and R9's
  -- test), both columns, the new key, R7's index, R9's table and policy are
  -- there. Nothing changes.
  if (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
       where (namespace.nspname, proc.proname, md5(proc.prosrc)) in (
               ('pharmacy', 'validate_dispensing', '71cbc33c8643a6f6790ead6d24a7597e'),
               ('pharmacy', 'claim_prescription_dispensing', '1a50612f5330a36c9b64d0d831c77812'),
               ('pharmacy', 'work_item_refills', '1563ae61481d70df74c493a497260d44'),
               ('pharmacy', 'open_refill_work_items', '928d4e14fe8d7bff9ce717ef757a6974'),
               ('ehr', 'prescription_refills_end_on', '90de746d4d8377b6dfecabb5d323dc31'),
               ('pharmacy', 'refill_scan_open', 'c06a06f770a690e456409803cc51b309'))) = 6
     and (select count(*) from pg_attribute attribute_row
           where not attribute_row.attisdropped
             and ((attribute_row.attrelid = 'ehr.prescriptions'::regclass and attribute_row.attname = 'refills_allowed')
               or (attribute_row.attrelid = 'pharmacy.dispensings'::regclass and attribute_row.attname = 'fill_number'))) = 2
     and exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'pharmacy.dispensings'::regclass
                    and constraint_row.conname = 'dispensings_work_item_fill_number_key')
     and to_regclass('ehr.prescriptions_refills_facility_idx') is not null
     and to_regclass('pharmacy.refill_scans') is not null
     and exists (select 1 from pg_policy policy_row
                  where policy_row.polrelid = 'ehr.prescriptions'::regclass
                    and policy_row.polname = 'prescriptions_scan_refills') then
    raise exception using errcode = '55000', message = '0154: already applied';
  end if;
  -- c. Nothing of this file's names exists (a hand-made or half-undone
  -- schema): neither column, no constraint or index of the three names, no
  -- relation named as R7's index in ehr or as R9's table in pharmacy, no
  -- function named work_item_refills, open_refill_work_items or
  -- refill_scan_open in pharmacy or prescription_refills_end_on in ehr (any
  -- signature), no policy named prescriptions_scan_refills.
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
      or exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = 'ehr' and relation.relname = 'prescriptions_refills_facility_idx')
      or exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = 'pharmacy' and relation.relname in ('refill_scans', 'refill_scans_pkey'))
      or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where (namespace.nspname = 'pharmacy'
                         and proc.proname in ('work_item_refills', 'open_refill_work_items', 'refill_scan_open'))
                     or (namespace.nspname = 'ehr' and proc.proname = 'prescription_refills_end_on'))
      or exists (select 1 from pg_policy policy_row where policy_row.polname = 'prescriptions_scan_refills')
    into found_absent;
  if found_absent then
    raise exception using errcode = '55000',
      message = '0154: ehr.prescriptions.refills_allowed, pharmacy.dispensings.fill_number, '
        || 'pharmacy.work_item_refills, pharmacy.open_refill_work_items, ehr.prescriptions_refills_facility_idx, '
        || 'ehr.prescription_refills_end_on, pharmacy.refill_scans, pharmacy.refill_scan_open, the policy '
        || 'prescriptions_scan_refills or a constraint of this file''s names exists already, but this file is not applied '
        || 'as a whole; nothing applied';
  end if;
  -- d. Every column the new bodies read, by name and type. The decision is
  -- an EXISTS over the absent columns (never null); the list only names them.
  with expected(schema_name, relation_name, column_names) as (values
         ('ehr', 'prescriptions', array['id uuid', 'patient_id uuid', 'facility_id uuid', 'encounter_id uuid',
           'status text', 'row_version bigint', 'ends_on date', 'duration_value integer', 'duration_unit text',
           'created_at timestamp with time zone']),
         ('pharmacy', 'work_items', array['id uuid', 'patient_id uuid', 'facility_id uuid', 'order_route_id uuid',
           'source_ehr_prescription_id uuid', 'source_ehr_prescription_version bigint', 'source_encounter_id uuid']),
         ('pharmacy', 'dispensings', array['id uuid', 'work_item_id uuid', 'patient_id uuid', 'facility_id uuid',
           'dispensed_at timestamp with time zone']),
         ('pharmacy', 'dispensing_reversals', array['dispensing_id uuid', 'patient_id uuid', 'facility_id uuid',
           'reversed_at timestamp with time zone']),
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
      message = format('0154: a column this migration relies on is missing or of another type: %s', missing);
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
      message = format('0154: a function this migration relies on differs from 0001-0148: %s', missing);
  end if;
  -- e2. Every other function R4, R6 and R7 call, and every function the
  -- policies of the four tables they read call (section 3 pins the
  -- policies themselves; pharmacy.dispensing_reversals' are the same
  -- functions as pharmacy.dispensings'), by md5, as 0101 pinned what its
  -- FOR SHARE relies on. A function missing at its signature counts as a
  -- mismatch.
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
      message = format('0154: a function this migration relies on differs from 0001-0148: %s', missing);
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
      message = '0154: pharmacy.dispensings does not have exactly one key on work_item_id alone (0023''s)';
  end if;
  -- g. The five triggers on pharmacy.dispensings, by name, function, type
  -- and mode, and no other (internal ones aside; catalog only); or those
  -- five and, exactly, Billing's zz_billing_stock_and_gate (0167, should
  -- Billing be released first), which sorts last. Kept for section 7.
  dispensing_triggers := (select array_agg(trigger_row.tgname::text || ':'
          || trigger_row.tgfoid::regprocedure::text || ':' || trigger_row.tgtype::text || ':'
          || trigger_row.tgenabled::text order by trigger_row.tgname::text collate "C")
        from pg_trigger trigger_row
       where trigger_row.tgrelid = 'pharmacy.dispensings'::regclass and not trigger_row.tgisinternal);
  if dispensing_triggers is distinct from array[
       'dispensings_claim_prescription:pharmacy.claim_prescription_dispensing():5:A',
       'dispensings_order_route_return:pharmacy.return_order_route_dispensing():5:O',
       'pharmacy_dispensing_validate:pharmacy.validate_dispensing():7:O',
       'pharmacy_dispensings_immutable:pharmacy.reject_immutable_evidence():27:O',
       'prescription_claim_key_immutable:pharmacy.refuse_claim_key_change():19:A']
     and dispensing_triggers is distinct from array[
       'dispensings_claim_prescription:pharmacy.claim_prescription_dispensing():5:A',
       'dispensings_order_route_return:pharmacy.return_order_route_dispensing():5:O',
       'pharmacy_dispensing_validate:pharmacy.validate_dispensing():7:O',
       'pharmacy_dispensings_immutable:pharmacy.reject_immutable_evidence():27:O',
       'prescription_claim_key_immutable:pharmacy.refuse_claim_key_change():19:A',
       'zz_billing_stock_and_gate:commercial.hook_dispensing():7:O'] then
    raise exception using errcode = '55000',
      message = '0154: the triggers on pharmacy.dispensings are not the five 0023, 0086, 0101 and 0133 left, '
        || 'with or without Billing''s zz_billing_stock_and_gate (0167)';
  end if;
  perform set_config('refills_0154.dispensing_triggers', array_to_string(dispensing_triggers, ' '), true);
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
         ('pharmacy.dispensings'), ('ehr.prescriptions'), ('pharmacy.prescription_item_claims'),
         ('pharmacy.dispensing_reversals')),
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
      message = format('0154: these are not owned by %s, the owner of pharmacy.work_items: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), coalesce(missing, 'pharmacy.validate_dispensing()'));
  end if;
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '42501',
      message = format('0154: %s must own, or inherit from and be able to SET ROLE to, %s, the owner of '
        || 'pharmacy.dispensings, ehr.prescriptions and the two functions this file replaces', current_user,
        pg_get_userbyid(owner_oid));
  end if;
  with wanted(schema_name, privilege) as (values
         ('pharmacy', 'CREATE'), ('pharmacy', 'USAGE'), ('ehr', 'CREATE'), ('ehr', 'USAGE'), ('identity', 'USAGE'),
         ('auth', 'USAGE'), ('platform', 'USAGE')),
       lacking as (
         select wanted.* from wanted
          where not exists (select 1 from pg_namespace namespace
                             where namespace.nspname = wanted.schema_name
                               and has_schema_privilege(owner_oid, namespace.oid, wanted.privilege)))
  select exists (select 1 from lacking),
         (select string_agg(format('%s on schema %s', lacking.privilege, lacking.schema_name), ', ') from lacking)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501', message = format('0154: %s lacks %s', pg_get_userbyid(owner_oid), missing);
  end if;
  -- i. Row-level security as 0133 left it: pharmacy.dispensings,
  -- pharmacy.dispensing_reversals, ehr.prescriptions and
  -- pharmacy.work_items enabled and forced, 0133's claims enabled and not
  -- forced (R5 reads every claim in any session).
  if (select count(*) from pg_class relation
       where (relation.oid in ('pharmacy.dispensings'::regclass, 'pharmacy.dispensing_reversals'::regclass,
                'ehr.prescriptions'::regclass, 'pharmacy.work_items'::regclass)
              and relation.relrowsecurity and relation.relforcerowsecurity)
          or (relation.oid = 'pharmacy.prescription_item_claims'::regclass and relation.relrowsecurity
              and not relation.relforcerowsecurity)) <> 5 then
    raise exception using errcode = '55000',
      message = '0154: row-level security is not as 0133 left it (pharmacy.dispensings, '
        || 'pharmacy.dispensing_reversals, ehr.prescriptions and pharmacy.work_items enabled and forced; 0133''s '
        || 'claims enabled and not forced)';
  end if;
  -- j. 0133 D5's premise: no hid_ role is a member of the role whose
  -- functions D5's two ehr.prescriptions policies let read prescriptions.
  select string_agg(role_row.rolname, ', ' order by role_row.rolname) into missing from pg_roles role_row
   where role_row.rolname like 'hid\_%' and role_row.oid <> validator_owner
     and pg_has_role(role_row.oid, validator_owner, 'MEMBER');
  if missing is not null then
    raise exception using errcode = '55000',
      message = format('0154: these roles are members of %s, which 0133 D5''s ehr.prescriptions policies name: %s',
        pg_get_userbyid(validator_owner), missing);
  end if;
  -- For section 7: every owner-run SECURITY DEFINER function's catalog row
  -- (oid and row version), so only the two replaced may change and only R6
  -- and R7 may be made, and none dropped; and both altered tables' ACLs.
  perform set_config('refills_0154.definer_rows',
    coalesce((select string_agg(proc.oid::text || ':' || proc.xmin::text, ' ' order by proc.oid)
                from pg_proc proc
               where proc.prosecdef and proc.proowner = validator_owner
                 and proc.oid not in ('pharmacy.validate_dispensing()'::regprocedure,
                       'pharmacy.claim_prescription_dispensing()'::regprocedure)), 'none'), true);
  perform set_config('refills_0154.table_acls',
    (select string_agg(relation.oid::regclass::text || '=' || coalesce(relation.relacl::text, 'default'), ' '
              order by relation.oid::regclass::text)
       from pg_class relation where relation.oid in ('pharmacy.dispensings'::regclass, 'ehr.prescriptions'::regclass)),
    true);
  raise notice '0154: preconditions checked; applier %; owner %', current_user, pg_get_userbyid(owner_oid);
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

-- 2. Locks (see Locks), NOWAIT, at most 5 s: ACCESS SHARE on the four
-- tables sections 3 and 4 open (the work items, the routes, the claims and
-- the reversals), then ACCESS EXCLUSIVE on the two this file alters, so an attempt that fails never holds the strong ones. A failed
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
      lock table pharmacy.work_items, ehr.order_routes, pharmacy.prescription_item_claims,
        pharmacy.dispensing_reversals in access share mode nowait;
      lock table pharmacy.dispensings, ehr.prescriptions in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0154: pharmacy.dispensings, ehr.prescriptions or a table 0154 reads (the Pharmacy work items, '
            || 'the order routes, 0133''s claims or the dispensing reversals) is busy, and this transaction already '
            || 'holds an earlier migration''s locks, so it does not wait; nothing applied; run the release again at '
            || 'a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0154: pharmacy.dispensings, ehr.prescriptions or a table 0154 reads (the Pharmacy work items, '
            || 'the order routes, 0133''s claims or the dispensing reversals) stayed busy for 5 seconds; nothing '
            || 'applied; run the release again at a quieter time';
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
      message = '0154: pharmacy.dispensings does not have exactly one key printed UNIQUE (work_item_id)';
  end if;
  perform set_config('refills_0154.work_item_key', work_item_key, true);
  -- b. 0133 D14's CHECK: a released claim was never dispensed, so a
  -- dispensed claim is never released. R5's refill branch and R6's open
  -- refill rest on it (an own item with a fill has a live claim).
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.prescription_item_claims'::regclass and constraint_row.contype = 'c'
         and constraint_row.convalidated
         and pg_get_constraintdef(constraint_row.oid)
             = 'CHECK (((released_at IS NULL) OR ((order_route_id IS NULL) AND (dispensed_at IS NULL))))') <> 1 then
    raise exception using errcode = '55000',
      message = '0154: pharmacy.prescription_item_claims does not have 0133''s CHECK that a dispensed claim is never '
        || 'released';
  end if;
  -- c. Every policy of ehr.prescriptions (R4 reads it FOR SHARE, R6 and R7
  -- read it), pharmacy.dispensings, pharmacy.dispensing_reversals (R4, R6
  -- and R7 read both, for the refill interval) and pharmacy.work_items (R6
  -- and R7 read it), each by name and the md5 of its command, permissive
  -- flag, roles (PUBLIC, or the owner alone) and printed expressions: the
  -- policies 0005, 0023, 0086, 0133, 0143 and 0145 left, none restrictive,
  -- no other.
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
         ('pharmacy.dispensing_reversals', 'pharmacy_reversals_insert', 'f06c4b223b1c855434f14f96187288a4'),
         ('pharmacy.dispensing_reversals', 'pharmacy_reversals_read', '50a418e05b8937b1f5386730f031e7f9'),
         ('pharmacy.dispensing_reversals', 'staff_own_work_insert', 'e03765d5c970ea065e5bf21333329fd5'),
         ('pharmacy.dispensing_reversals', 'staff_own_work_read', '83e194551c580514a100c288ef7b23ca'),
         ('pharmacy.work_items', 'pharmacy_work_items_insert', 'ad22de4e47f475c209e7e79c8134eed5'),
         ('pharmacy.work_items', 'pharmacy_work_items_read', '14670758ef7af96dc84c324c2053f2e7'),
         ('pharmacy.work_items', 'staff_own_work_read', 'a97eccd35eb781a878c0f47f873f63a0')),
       present as (
         select case policy_row.polrelid when 'ehr.prescriptions'::regclass then 'ehr.prescriptions'
                  when 'pharmacy.dispensings'::regclass then 'pharmacy.dispensings'
                  when 'pharmacy.dispensing_reversals'::regclass then 'pharmacy.dispensing_reversals'
                  else 'pharmacy.work_items' end as relation_name, policy_row.polname::text as policy_name,
                md5(policy_row.polcmd::text || ':' || policy_row.polpermissive::text || ':'
                    || case when policy_row.polroles = array[0::oid] then 'public'
                            when policy_row.polroles = array[owner_oid] then 'owner'
                            else policy_row.polroles::text end || ':'
                    || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-') || ':'
                    || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '-')) as digest
           from pg_policy policy_row
          where policy_row.polrelid in ('ehr.prescriptions'::regclass, 'pharmacy.dispensings'::regclass,
                  'pharmacy.dispensing_reversals'::regclass, 'pharmacy.work_items'::regclass)),
       differing as (
         select coalesce(expected.relation_name, present.relation_name) || '.'
                || coalesce(expected.policy_name, present.policy_name) as what
           from expected full join present
             on present.relation_name = expected.relation_name and present.policy_name = expected.policy_name
          where expected.digest is distinct from present.digest)
  select string_agg(differing.what, ', ' order by differing.what) into mismatch from differing;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0154: the policies of ehr.prescriptions, pharmacy.dispensings, pharmacy.dispensing_reversals or '
        || 'pharmacy.work_items are not the ones 0001-0148 left: %s', mismatch);
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
      message = '0154: the AFTER UPDATE triggers on ehr.prescriptions do not end as 0148 left them';
  end if;
end
$$;

-- 4. R8, the refills' last day (see R8), then R4 and R5, replaced under
-- section 2's locks: CREATE OR REPLACE keeps the owner, the ACL and the
-- triggers. Compiling R4 resolves its three %ROWTYPE declarations, which
-- opens pharmacy.work_items, ehr.order_routes and ehr.prescriptions (ACCESS
-- SHARE), so it comes after the locks and never waits.
-- R8: the earliest of (a) ends_on, (b) the Lagos day written plus
-- (refills_allowed + 2) fills' durations (a day 1, a week 7, a month 30) and
-- (c) the Lagos day written plus 365; null without refills. No table read,
-- the same answer for the same values (IMMUTABLE: timezone(text,
-- timestamptz) and timestamp::date are), so R7's index can hold it.
create function ehr.prescription_refills_end_on(written_at timestamptz, refills_allowed smallint,
  duration_value integer, duration_unit text, ends_on date)
returns date
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case when refills_allowed > 0
              then least(ends_on,
                         timezone('Africa/Lagos', written_at)::date
                           + (refills_allowed + 2) * duration_value
                             * case duration_unit when 'week' then 7 when 'month' then 30 else 1 end,
                         timezone('Africa/Lagos', written_at)::date + 365)
         end
$$;
-- R8's EXECUTE: the owner (R4, R6 and R7 run as the owner), and the two
-- runtimes that may write ehr.prescriptions (the EHR runtime and the schema
-- test runtime), because PostgreSQL runs an index's expression as the role
-- that inserts or updates the row (R7's index, below). Nothing to PUBLIC.
revoke all on function ehr.prescription_refills_end_on(timestamptz, smallint, integer, text, date) from public;
do $$
declare runtime_role text;
begin
  foreach runtime_role in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function ehr.prescription_refills_end_on(timestamptz, smallint, integer, text, '
        || 'date) to %I', runtime_role);
    end if;
  end loop;
end
$$;
comment on function ehr.prescription_refills_end_on(timestamptz, smallint, integer, text, date) is
  '0154 ORD-12 (the clinical owner''s decision D9, 24 November 2026): the last Lagos day a refill of a prescription can be collected: the earliest of (a) its ends_on, (b) the Lagos day it was written (created_at) plus (refills_allowed + 2) times the duration of one fill in days (a day 1, a week 7, a month 30: one fill''s length after the course should have finished) and (c) that day plus 365. Null when it allows no refill. The one place the day is computed: pharmacy.validate_dispensing, pharmacy.work_item_refills, pharmacy.open_refill_work_items and the index ehr.prescriptions_refills_facility_idx use it.';

-- R4: 0101's text, with the refill block added before its RETURN.
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
  -- 1 + refills_allowed fills (null: none), numbered next (1 + every fill of
  -- the item, a reversed one included; the DETAIL is that count), not
  -- dispensed in the future (a backdated one is allowed), and not once the
  -- refills of the prescription read above have ended (after their last
  -- day, R8's: the earliest of its ends_on, the Lagos day written plus
  -- (refills_allowed + 2) fills' durations and that day plus 365; the
  -- DETAIL is that day), nor before the refill interval has passed: the
  -- Lagos day of the latest fill not reversed, plus 3/4 of the
  -- prescription's duration in days (a week 7, a month 30), rounded up, at
  -- least 1 (no fill standing: no wait), judged on today. The DETAIL is the
  -- day the refill opens. A refill that would open only after the last day
  -- (a late fill) can never be recorded, so it is refused as ended at once,
  -- with the last day, not told a day it would be refused on.
  if new.fill_number > 1 then
    if parent_row.order_route_id is not null
       or new.fill_number > 1 + coalesce(source_row.refills_allowed, 0) then
      raise exception using errcode = '23514', message = 'NO_REFILLS_LEFT';
    end if;
    declare
      refills_end_on date := ehr.prescription_refills_end_on(source_row.created_at, source_row.refills_allowed,
        source_row.duration_value, source_row.duration_unit, source_row.ends_on);
      fills_recorded integer;
      refill_opens_on date;
    begin
      select count(*)::integer,
             (max(dispensing.dispensed_at) filter (where reversal.id is null) at time zone 'Africa/Lagos')::date
               + greatest(1, ceil(0.75 * source_row.duration_value
                   * case source_row.duration_unit when 'week' then 7 when 'month' then 30 else 1 end))::integer
        into fills_recorded, refill_opens_on
        from pharmacy.dispensings dispensing
        left join pharmacy.dispensing_reversals reversal on reversal.dispensing_id = dispensing.id
       where dispensing.work_item_id = new.work_item_id;
      if new.fill_number <> fills_recorded + 1 then
        raise exception using errcode = '23514', message = 'REFILL_NOT_NEXT_FILL', detail = fills_recorded::text;
      end if;
      if new.dispensed_at > clock_timestamp() then
        raise exception using errcode = '23514', message = 'REFILL_DISPENSED_IN_FUTURE';
      end if;
      if refills_end_on < (clock_timestamp() at time zone 'Africa/Lagos')::date then
        raise exception using errcode = '23514', message = 'REFILL_PRESCRIPTION_ENDED',
          detail = to_char(refills_end_on, 'YYYY-MM-DD');
      end if;
      if refill_opens_on > refills_end_on then
        raise exception using errcode = '23514', message = 'REFILL_PRESCRIPTION_ENDED',
          detail = to_char(refills_end_on, 'YYYY-MM-DD');
      end if;
      if refill_opens_on > (clock_timestamp() at time zone 'Africa/Lagos')::date then
        raise exception using errcode = '23514', message = 'REFILL_TOO_SOON',
          detail = to_char(refill_opens_on, 'YYYY-MM-DD');
      end if;
    end;
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
  '0101, refills by 0154 (ORD-12): a route-backed work item is dispensable only while its route is accepted and inside its work window (0086, ORDER_ROUTE_CLOSED); the dispensing must match its work item and the session (0077); a same-facility work item is dispensable only while its ehr.prescriptions row, read FOR SHARE, is active at the version accepted, for its patient, facility and encounter (23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE). A fill_number above 1: own items only, at most 1 + refills_allowed fills (null: none), else 23514 NO_REFILLS_LEFT; numbered next, 1 + every fill of the item (a reversed one included), else 23514 REFILL_NOT_NEXT_FILL, DETAIL that count; dispensed_at no later than now, else 23514 REFILL_DISPENSED_IN_FUTURE (a backdated refill is allowed and judged on today, as any refill); not after the refills'' last day, ehr.prescription_refills_end_on (the earliest of ends_on, the Lagos day written plus (refills_allowed + 2) fills'' durations, and that day plus 365; 23514 REFILL_PRESCRIPTION_ENDED, DETAIL that day, YYYY-MM-DD); not before the Lagos day of the latest fill not reversed (by dispensed_at) plus 3/4 of the duration in days, rounded up, at least 1, judged on today (23514 REFILL_TOO_SOON, DETAIL the day it opens, YYYY-MM-DD); a refill whose day would come after the refills'' last day (a late fill) can never be recorded and is refused REFILL_PRESCRIPTION_ENDED at once, DETAIL the last day. Origin mode only.';
comment on function pharmacy.claim_prescription_dispensing() is
  '0133 D14, refills by 0154 (ORD-12): fill 1 turns the item''s live, undispensed claim dispensed (dispensed_at, kept for good); a later fill needs that claim live, dispensed and the item''s own (no order route) and changes nothing; else 23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE, DETAIL sent_elsewhere or not_claimed. Enabled always; reads only the claims. Executed by no role.';

-- 5. R1: the column and its CHECK, NOT VALID, then validated (one scan of
-- ehr.prescriptions, under the lock taken above). A refill needs a duration
-- (the refill interval is 3/4 of it): 1-11 only with 0125's duration_value
-- and duration_unit (0125's own CHECK gives them together or neither).
alter table ehr.prescriptions
  add column refills_allowed smallint,
  add constraint prescriptions_refills_allowed_ck
    check (refills_allowed is null
           or (refills_allowed between 0 and 11
               and (refills_allowed = 0 or (duration_value is not null and duration_unit is not null)))) not valid;
alter table ehr.prescriptions validate constraint prescriptions_refills_allowed_ck;
-- R7's index: the facility's prescriptions that allow refills, by the time
-- they were written and their refills' last day (R8). R7 range-scans it by
-- facility and time written (see R7). The column is new and null on every
-- row, so the build scans ehr.prescriptions once and writes no entry.
create index prescriptions_refills_facility_idx on ehr.prescriptions
  (facility_id, created_at, ehr.prescription_refills_end_on(created_at, refills_allowed, duration_value, duration_unit,
   ends_on))
  where refills_allowed > 0;

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
    current_setting('refills_0154.work_item_key'));
end
$$;

comment on column ehr.prescriptions.refills_allowed is
  'ORD-12 (0154): how many refills the prescriber allowed after the first fill, 0-11; null means none; 1-11 needs a duration. With refills, the duration (0125''s duration_value and duration_unit) is how long ONE fill lasts, not the whole course. Set at creation only (ehr-api never changes it). The hospital''s own pharmacy may record 1 + refills_allowed fills of the one work item while the prescription stays active and unchanged, until the refills'' last day (ehr.prescription_refills_end_on: the earliest of ends_on, the Lagos day written plus (refills_allowed + 2) fills'' durations, and that day plus 365), each refill from the Lagos day of the latest fill not reversed plus 3/4 of the duration in days (rounded up, at least 1).';
comment on constraint prescriptions_refills_allowed_ck on ehr.prescriptions is
  'ORD-12 (0154): refills_allowed is null or 0-11, and 1-11 only with a duration (duration_value and duration_unit, 0125), which with refills is how long one fill lasts, not the whole course: a refill opens 3/4 of it after the latest fill not reversed.';
comment on index ehr.prescriptions_refills_facility_idx is
  'ORD-12 (0154): the prescriptions that allow refills, by facility, the time they were written and their refills'' last day (ehr.prescription_refills_end_on). pharmacy.open_refill_work_items range-scans it: only the facility''s prescriptions written in the last 365 Lagos days (rule (c)), and under an owner that bypasses row-level security only those whose refills have not ended (under a NOSUPERUSER NOBYPASSRLS owner the last day, not leakproof, is checked on each row read instead), so its cost is bounded by them and not by the facility''s history.';
comment on column pharmacy.dispensings.fill_number is
  'ORD-12 (0154): 1 for the first fill of the work item, 2 and above for refills (at most 12). Rows recorded before 0154 are fill 1. A reversed fill keeps its number. In origin mode a refill must be the next number (pharmacy.validate_dispensing).';
comment on constraint dispensings_fill_number_ck on pharmacy.dispensings is
  'ORD-12 (0154): fill_number is 1-12 (one fill and at most 11 refills).';
comment on constraint dispensings_work_item_fill_number_key on pharmacy.dispensings is
  'ORD-12 (0154): one dispensing per fill number of a work item; replaces 0023''s one dispensing per work item, and stops a second fill recorded with the same number at the same time (23505).';

-- 6. R9, the refill scan marker (see R9): its table, the owner's only (one
-- row while R6 or R7 reads ehr.prescriptions, keyed by the backend's pid
-- and the transaction's start time, never committed); its test, which
-- PUBLIC may execute (PostgreSQL checks EXECUTE on every function of a plan
-- when it starts it, and every role that reads ehr.prescriptions plans the
-- policy below) and which answers only whether a marker row carries this
-- backend's pid and this transaction's start time (see R9 on that key),
-- which only R6 and R7 write; and the policy, named after every other read policy of the
-- table so it is asked first (PostgreSQL joins a table's permissive
-- policies with OR in reverse order of their names and stops at the first
-- that holds; 0133, THE COST), one scalar subquery, so asked once per
-- statement (an InitPlan), the owner's membership tested first (CASE), so a
-- runtime role's read never depends on the marker. 0143 D1's form.
create table pharmacy.refill_scans (
  backend_pid integer not null,
  transaction_started_at timestamptz not null,
  primary key (backend_pid, transaction_started_at)
);
revoke all on pharmacy.refill_scans from public;
create function pharmacy.refill_scan_open()
returns boolean
language sql
stable
security definer
cost 1
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from pharmacy.refill_scans scan
                  where scan.backend_pid = pg_backend_pid()
                    and scan.transaction_started_at = transaction_timestamp())
$$;
revoke all on function pharmacy.refill_scan_open() from public;
grant execute on function pharmacy.refill_scan_open() to public;
create policy prescriptions_scan_refills on ehr.prescriptions
  for select
  using ((select case when pg_has_role((select relation.relowner from pg_class relation
                                         where relation.oid = 'ehr.prescriptions'::regclass), 'USAGE')
                      then pharmacy.refill_scan_open() else false end));
comment on table pharmacy.refill_scans is
  '0154 ORD-12 (D8): one row while pharmacy.work_item_refills or pharmacy.open_refill_work_items reads ehr.prescriptions, keyed by that backend''s pid and its transaction''s start time; written just before that one statement and deleted just after it (an error rolls it back), so never committed. The owner''s only.';
comment on function pharmacy.refill_scan_open() is
  '0154 ORD-12 (D8): whether a refill scan marker (pharmacy.refill_scans) carries this backend''s pid and this transaction''s start time, which only the two refill readers write, and never commit. Asked by the policy prescriptions_scan_refills on ehr.prescriptions, so every role that reads that table may execute it.';
comment on policy prescriptions_scan_refills on ehr.prescriptions is
  '0154 ORD-12 (D8): the table''s owner reads every row while this transaction holds a refill scan marker (pharmacy.refill_scan_open), which only the two refill readers write around their one read; asked first (its name sorts after every other read policy) and once per statement; false for every role that is not a member of the owner.';

-- R6, the reader (see R6 above), in three steps. 1. The requested own
-- items the session may read: its facility, pharmacy.work-item.read (the
-- consent branch of pharmacy.work_item_allows checks no permission; a
-- predicate, not an early return, as 0148's C3) and the work items' two
-- read policies repeated (0133's own-work half asked first: about 0.1 ms a
-- call, where the consent test takes about 2, so a pharmacist on the
-- own-work basis never runs the consent test), at most 200 items found by
-- their key, under the work items' own row-level security. 2. Their
-- prescriptions, the one statement that reads ehr.prescriptions, by their
-- ids alone, under the marker (R9): written just before it and deleted
-- just after it, while nothing else runs; the statement calls only R8 (no
-- table read), so what it reads is kept in local arrays, the refills' last
-- day (R8) and the refill interval with it. No item, no marker. 3. The
-- answer, from those
-- arrays and the items' fills and their reversals (read under their own
-- row-level security), each prescription matched on the item's patient and
-- facility, as before. The refill interval is R4's: the Lagos day of the
-- latest fill not reversed, plus 3/4 of the duration in days (a week 7, a
-- month 30), rounded up, at least 1; with every fill reversed, the day of
-- the latest reversal (no wait, as R4). A refill whose day would come after
-- the refills' last day (a late fill) can never be collected, so it reads
-- 'ended' at once, as R4 refuses it. VOLATILE, because it writes the
-- marker; so under READ COMMITTED each step reads the latest committed
-- rows, as pharmacy-api's other statements of the same request do.
create function pharmacy.work_item_refills(requested_work_item_ids uuid[])
returns table (work_item_id uuid, refills_allowed integer, fills_recorded integer, refill_open boolean,
  closed_reason text, next_fill_on date, refills_end_on date)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
  may_read boolean;
  own_work_membership uuid;
  lagos_today date := (pg_catalog.clock_timestamp() at time zone 'Africa/Lagos')::date;
  item_ids uuid[];
  item_patient_ids uuid[];
  item_facility_ids uuid[];
  item_source_ids uuid[];
  item_source_versions bigint[];
  item_source_encounter_ids uuid[];
  source_ids uuid[];
  source_patient_ids uuid[];
  source_facility_ids uuid[];
  source_encounter_ids uuid[];
  source_statuses text[];
  source_versions bigint[];
  source_allowed integer[];
  source_interval_days integer[];
  source_end_days date[];
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
  -- 1. The items.
  select pg_catalog.array_agg(item.id), pg_catalog.array_agg(item.patient_id), pg_catalog.array_agg(item.facility_id),
         pg_catalog.array_agg(item.source_ehr_prescription_id),
         pg_catalog.array_agg(item.source_ehr_prescription_version), pg_catalog.array_agg(item.source_encounter_id)
    into item_ids, item_patient_ids, item_facility_ids, item_source_ids, item_source_versions, item_source_encounter_ids
    from pharmacy.work_items item
   where may_read
     and item.id = any(requested_work_item_ids)
     and item.facility_id = session_facility
     and item.order_route_id is null
     and ((coalesce(identity.pharmacy_work_patient_allows(own_work_membership, item.patient_id,
             item.facility_id, 'read_records'), false)
           and item.order_route_id is null)
       or pharmacy.work_item_allows(item.patient_id, item.facility_id, item.order_route_id, 'read_records'));
  if item_ids is null then
    return;
  end if;
  -- 2. Their prescriptions, under the marker.
  insert into pharmacy.refill_scans (backend_pid, transaction_started_at)
  values (pg_catalog.pg_backend_pid(), pg_catalog.transaction_timestamp());
  select pg_catalog.array_agg(prescription.id), pg_catalog.array_agg(prescription.patient_id),
         pg_catalog.array_agg(prescription.facility_id), pg_catalog.array_agg(prescription.encounter_id),
         pg_catalog.array_agg(prescription.status), pg_catalog.array_agg(prescription.row_version),
         pg_catalog.array_agg(prescription.refills_allowed::integer),
         pg_catalog.array_agg(greatest(1, pg_catalog.ceil(0.75 * prescription.duration_value
           * case prescription.duration_unit when 'week' then 7 when 'month' then 30 else 1 end))::integer),
         pg_catalog.array_agg(ehr.prescription_refills_end_on(prescription.created_at, prescription.refills_allowed,
           prescription.duration_value, prescription.duration_unit, prescription.ends_on))
    into source_ids, source_patient_ids, source_facility_ids, source_encounter_ids, source_statuses, source_versions,
         source_allowed, source_interval_days, source_end_days
    from ehr.prescriptions prescription
   where prescription.id = any(item_source_ids);
  delete from pharmacy.refill_scans scan
   where scan.backend_pid = pg_catalog.pg_backend_pid()
     and scan.transaction_started_at = pg_catalog.transaction_timestamp();
  -- 3. The answer.
  return query
    with visible as (
      select listed.item_id, listed.item_patient_id, listed.item_facility_id, listed.source_id, listed.source_version,
             listed.source_encounter_id
        from unnest(item_ids, item_patient_ids, item_facility_ids, item_source_ids, item_source_versions,
               item_source_encounter_ids)
             listed(item_id, item_patient_id, item_facility_id, source_id, source_version, source_encounter_id)),
    sources as (
      select found.source_id, found.patient_id, found.facility_id, found.encounter_id, found.status, found.row_version,
             found.allowed, found.interval_days, found.end_day
        from unnest(source_ids, source_patient_ids, source_facility_ids, source_encounter_ids, source_statuses,
               source_versions, source_allowed, source_interval_days, source_end_days)
             found(source_id, patient_id, facility_id, encounter_id, status, row_version, allowed, interval_days, end_day)),
    facts as (
      select visible.item_id,
             coalesce(source.allowed, 0) as allowed,
             fills.recorded,
             coalesce((fills.latest_standing at time zone 'Africa/Lagos')::date + coalesce(source.interval_days, 1),
                      (fills.latest_reversal at time zone 'Africa/Lagos')::date) as opens_on,
             source.status is distinct from 'active' as stopped,
             (source.row_version is distinct from visible.source_version
               or source.encounter_id is distinct from visible.source_encounter_id) as changed,
             coalesce(source.end_day < lagos_today, false) as ended,
             source.end_day
        from visible
        left join sources source
          on source.source_id = visible.source_id
         and source.patient_id = visible.item_patient_id
         and source.facility_id = visible.item_facility_id
       cross join lateral (
         select count(*)::integer as recorded,
                max(dispensing.dispensed_at) filter (where reversal.id is null) as latest_standing,
                max(reversal.reversed_at) as latest_reversal
           from pharmacy.dispensings dispensing
           left join pharmacy.dispensing_reversals reversal
             on reversal.dispensing_id = dispensing.id
            and reversal.patient_id = visible.item_patient_id
            and reversal.facility_id = visible.item_facility_id
          where dispensing.work_item_id = visible.item_id
            and dispensing.patient_id = visible.item_patient_id
            and dispensing.facility_id = visible.item_facility_id) fills),
    judged as (
      select late.item_id, late.allowed, late.recorded, late.opens_on, late.stopped, late.changed, late.ended,
             late.end_day,
             late.recorded >= 1 and late.recorded < 1 + late.allowed
               and not late.stopped and not late.changed and not late.ended as may_fill
        from (select facts.item_id, facts.allowed, facts.recorded, facts.opens_on, facts.stopped, facts.changed,
                     facts.ended or coalesce(facts.opens_on > facts.end_day, false) as ended, facts.end_day
                from facts) late)
    select judged.item_id, judged.allowed, judged.recorded,
           judged.may_fill and coalesce(judged.opens_on <= lagos_today, false),
           case
             when judged.recorded = 0 then null
             when judged.recorded >= 1 + judged.allowed then 'none_left'
             when judged.stopped then 'stopped'
             when judged.changed then 'changed'
             when judged.ended then 'ended'
             when coalesce(judged.opens_on > lagos_today, false) then 'not_yet'
           end,
           case when judged.may_fill then judged.opens_on end,
           judged.end_day
      from judged;
end;
$$;

-- R7, the open refills (see R7 above): R6's session tests, then four
-- steps. 1. Under the marker (R9), the one statement that reads
-- ehr.prescriptions: the facility's active prescriptions that allow refills,
-- written from the Lagos day 365 days ago (R8's rule (c), restated as a
-- range on created_at every condition of which is leakproof, so R7's index
-- serves it under a NOSUPERUSER NOBYPASSRLS owner too), whose refills have
-- not ended (R8's day today or later: a condition on the index under an
-- owner that bypasses row-level security, and checked on each row read
-- under a NOSUPERUSER NOBYPASSRLS owner, where R8, not leakproof, can only
-- follow the table's policies), with their refill interval, kept in local
-- arrays; the marker is written just before it and deleted just after it,
-- and the statement calls only R8 (no table read). None found, nothing
-- more. Then, each materialized so that what follows reads only what it
-- found: 2. their own work items, accepted at the version and encounter,
-- found by the list of those prescriptions (a leakproof condition, so
-- however the planner reaches pharmacy.work_items, its row-level security
-- runs only on those items); 3. for each, its fills and their reversals,
-- found by the item (an index probe, so the cost grows with the items, not
-- with their square), counted as R6 counts them, with the day the next fill
-- may be recorded (R6's rule), kept when a fill is left; 4. those whose day
-- has come, in R7's order (the refill that opened first first, then the
-- item id), then the work items' two read policies, as R6 repeats them
-- (the own-work half first), asked one item at a time in that order until
-- 200 pass: the sort is a fence (OFFSET 0), so the policies are asked of
-- the items answered (and of those refused before them), not of every due
-- item. The answer is the one a filter before the sort would give. A
-- session without a facility or without pharmacy.work-item.read writes no
-- marker and gets no row. VOLATILE, as R6.
create function pharmacy.open_refill_work_items()
returns table (work_item_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
  may_read boolean;
  own_work_membership uuid;
  lagos_today date := (pg_catalog.clock_timestamp() at time zone 'Africa/Lagos')::date;
  written_from timestamptz;
  source_ids uuid[];
  source_patient_ids uuid[];
  source_allowed integer[];
  source_versions bigint[];
  source_encounter_ids uuid[];
  source_interval_days integer[];
begin
  if session_facility is null then
    return;
  end if;
  may_read := coalesce(auth.membership_has_permission(platform.current_actor_subject(),
    platform.current_membership_id(), session_facility, 'pharmacy.work-item.read'), false);
  if not may_read then
    return;
  end if;
  own_work_membership := identity.facility_work_session_membership('pharmacy');
  -- R8's rule (c): written on or after the Lagos day 365 days before today.
  written_from := (lagos_today - 365)::timestamp at time zone 'Africa/Lagos';
  -- 1. The prescriptions, under the marker.
  insert into pharmacy.refill_scans (backend_pid, transaction_started_at)
  values (pg_catalog.pg_backend_pid(), pg_catalog.transaction_timestamp());
  select pg_catalog.array_agg(prescription.id), pg_catalog.array_agg(prescription.patient_id),
         pg_catalog.array_agg(prescription.refills_allowed::integer), pg_catalog.array_agg(prescription.row_version),
         pg_catalog.array_agg(prescription.encounter_id),
         pg_catalog.array_agg(greatest(1, pg_catalog.ceil(0.75 * prescription.duration_value
           * case prescription.duration_unit when 'week' then 7 when 'month' then 30 else 1 end))::integer)
    into source_ids, source_patient_ids, source_allowed, source_versions, source_encounter_ids, source_interval_days
    from ehr.prescriptions prescription
   where prescription.facility_id = session_facility
     and prescription.refills_allowed > 0
     and prescription.created_at >= written_from
     and ehr.prescription_refills_end_on(prescription.created_at, prescription.refills_allowed,
           prescription.duration_value, prescription.duration_unit, prescription.ends_on) >= lagos_today
     and prescription.status = 'active';
  delete from pharmacy.refill_scans scan
   where scan.backend_pid = pg_catalog.pg_backend_pid()
     and scan.transaction_started_at = pg_catalog.transaction_timestamp();
  if source_ids is null then
    return;
  end if;
  return query
    with candidates as materialized (
      select found.source_id, found.source_patient_id, found.allowed, found.source_version, found.source_encounter_id,
             found.interval_days
        from unnest(source_ids, source_patient_ids, source_allowed, source_versions, source_encounter_ids,
               source_interval_days)
             found(source_id, source_patient_id, allowed, source_version, source_encounter_id, interval_days)),
    items as materialized (
      select item.id as item_id, item.patient_id as item_patient_id, item.facility_id as item_facility_id,
             item.order_route_id as item_route_id, candidates.allowed, candidates.interval_days
        from pharmacy.work_items item
        join candidates
          on candidates.source_id = item.source_ehr_prescription_id
         and candidates.source_patient_id = item.patient_id
         and candidates.source_version = item.source_ehr_prescription_version
         and candidates.source_encounter_id = item.source_encounter_id
       where item.source_ehr_prescription_id = any (source_ids)
         and item.order_route_id is null
         and item.facility_id = session_facility),
    timed as materialized (
      select items.item_id, items.item_patient_id, items.item_facility_id, items.item_route_id,
             coalesce((fills.latest_standing at time zone 'Africa/Lagos')::date + items.interval_days,
                      (fills.latest_reversal at time zone 'Africa/Lagos')::date) as opens_on
        from items
       cross join lateral (
         select count(*)::integer as recorded,
                max(dispensing.dispensed_at) filter (where reversal.id is null) as latest_standing,
                max(reversal.reversed_at) as latest_reversal
           from pharmacy.dispensings dispensing
           left join pharmacy.dispensing_reversals reversal
             on reversal.dispensing_id = dispensing.id
            and reversal.patient_id = dispensing.patient_id
            and reversal.facility_id = dispensing.facility_id
          where dispensing.work_item_id = items.item_id
            and dispensing.patient_id = items.item_patient_id
            and dispensing.facility_id = items.item_facility_id) fills
       where fills.recorded >= 1 and fills.recorded < 1 + items.allowed)
    select due.item_id
      from (select timed.item_id, timed.item_patient_id, timed.item_facility_id, timed.item_route_id, timed.opens_on
              from timed
             where timed.opens_on <= lagos_today
             order by timed.opens_on, timed.item_id
            offset 0) due
     where coalesce(identity.pharmacy_work_patient_allows(own_work_membership, due.item_patient_id,
             due.item_facility_id, 'read_records'), false)
        or pharmacy.work_item_allows(due.item_patient_id, due.item_facility_id, due.item_route_id, 'read_records')
     order by due.opens_on, due.item_id
     limit 200;
end;
$$;

-- R6's and R7's EXECUTE (here and in runtime-grants.sql): to each of the two
-- runtimes that exists, nothing to PUBLIC.
revoke all on function pharmacy.work_item_refills(uuid[]), pharmacy.open_refill_work_items() from public;
do $$
declare runtime_role text;
begin
  foreach runtime_role in array array['hid_pharmacy_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function pharmacy.work_item_refills(uuid[]), '
        || 'pharmacy.open_refill_work_items() to %I', runtime_role);
    end if;
  end loop;
end
$$;
comment on function pharmacy.work_item_refills(uuid[]) is
  '0154 ORD-12: for each requested own work item (no order route) the session may read (its facility, pharmacy.work-item.read, and pharmacy.work_items'' two read policies repeated), refills_allowed (null as 0), fills_recorded (reversed fills included), refill_open (a fill recorded, fewer than 1 + refills_allowed, the prescription active at the accepted version, its refills'' last day not past in Lagos, and next_fill_on today or before; PRESCRIPTION_REFILLS_ENABLED is pharmacy-api''s to add), closed_reason (none_left, stopped, changed or ended (the refills'' last day has passed, or the next refill would open only after it: a late fill), or not_yet while the refill interval runs; null while open and before the first fill), next_fill_on (the Lagos day the next fill may be recorded: the latest fill not reversed plus 3/4 of the duration in days, rounded up, at least 1, or the latest reversal''s day when every fill is reversed; null before the first fill and once closed for a reason other than not_yet) and refills_end_on (the last Lagos day a refill can be collected, ehr.prescription_refills_end_on: the earliest of ends_on, the Lagos day written plus (refills_allowed + 2) fills'' durations, and that day plus 365; null without refills). At most 200 ids, else 22023 WORK_ITEM_REFILLS_INVALID. Reads ehr.prescriptions in one statement under a refill scan marker (pharmacy.refill_scans), so it is VOLATILE and needs a transaction that may write.';
comment on function pharmacy.open_refill_work_items() is
  '0154 ORD-12: the ids of the session''s own work items whose refill is open now, by pharmacy.work_item_refills'' rule (its facility, pharmacy.work-item.read and pharmacy.work_items'' two read policies; at least one fill and fewer than 1 + refills_allowed; the prescription active at the accepted version and encounter; its refills'' last day not past in Lagos; the refill interval passed), the refill that opened first first (then the id), at most 200. It reads the facility''s prescriptions that allow refills written in the last 365 Lagos days (ehr.prescriptions_refills_facility_idx), in one statement under a refill scan marker (pharmacy.refill_scans), and keeps the active ones whose refills have not ended: under an owner that bypasses row-level security the index leaves the ended ones out, under a NOSUPERUSER NOBYPASSRLS owner (production''s kind) every one written in those 365 days is read and its last day checked (about 10 microseconds a row). It then reads the work items and fills of those it keeps, one item at a time, and asks the work items'' read policies only of the due items it answers, in its order, until 200 pass; so its cost grows with the facility''s live refill prescriptions, not with its history or with how many refills are open at once. For a session on the own-work basis (a pharmacist) about 0.15 ms per live refill prescription under the NOSUPERUSER NOBYPASSRLS owner, so pharmacy-api''s 3-second limit would be reached at about 20,000. A session that may read only on consent (a clinician or a nurse: pharmacy.work-item.read without pharmacy.order-route.receive) pays the consent test instead: under the NOSUPERUSER NOBYPASSRLS owner the work items'' own policy asks it of every live refill prescription''s item and the fills'' asks it again of each item it may read, about 1.5-1.9 ms for each live refill prescription it may not read and about 3.4-3.9 ms for each it may, so the limit is reached at about 1,800 or about 800 of them; under an owner that bypasses row-level security only of the due items until 200 pass. VOLATILE, and needs a transaction that may write.';

-- 7. Post-checks (still under the locks).
do $$
declare
  found_absent boolean;
  mismatch text;
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  error_state text;
  error_message text;
  end_on_function oid := to_regprocedure('ehr.prescription_refills_end_on(timestamptz,smallint,integer,text,date)');
begin
  -- R4, R5, R6 and R7: exactly one function of each name, this file's body
  -- (md5), the owner, SECURITY DEFINER, VOLATILE (R6 and R7 write R9's
  -- marker), plpgsql, not STRICT, the result, the search_path each had; R4
  -- and R5 no EXECUTE for anyone but the owner (R6's and R7's grants below).
  with expected(proc_name, argument_types, digest, volatility, result_type, search_path) as (values
         ('validate_dispensing', '', '71cbc33c8643a6f6790ead6d24a7597e', 'v', 'trigger',
           'search_path=pharmacy, platform, pg_temp'),
         ('claim_prescription_dispensing', '', '1a50612f5330a36c9b64d0d831c77812', 'v', 'trigger',
           'search_path=pg_catalog, pg_temp'),
         ('work_item_refills', 'uuid[]', '1563ae61481d70df74c493a497260d44', 'v',
           'TABLE(work_item_id uuid, refills_allowed integer, fills_recorded integer, refill_open boolean, '
             || 'closed_reason text, next_fill_on date, refills_end_on date)', 'search_path=pg_catalog, pg_temp'),
         ('open_refill_work_items', '', '928d4e14fe8d7bff9ce717ef757a6974', 'v', 'TABLE(work_item_id uuid)',
           'search_path=pg_catalog, pg_temp')),
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
                  and (expected.proc_name in ('work_item_refills', 'open_refill_work_items')
                    or not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
                                    where privilege.grantee <> proc.proowner))))
  select exists (select 1 from differing),
         (select string_agg(format('pharmacy.%s: %s', differing.proc_name, coalesce(differing.found, 'missing')), '; ')
            from differing)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000', message = format('0154: functions are not as this file makes them: %s', mismatch);
  end if;
  -- R6's and R7's exact EXECUTE grants: to each of the two runtimes that
  -- exists (not grantable), nothing else, PUBLIC included. Decided by
  -- EXISTS, so a role that does not exist never makes a comparison null.
  with readers(reader) as (values ('pharmacy.work_item_refills(uuid[])'::regprocedure),
         ('pharmacy.open_refill_work_items()'::regprocedure)),
       expected(grantee_name) as (values ('hid_pharmacy_runtime'), ('hid_schema_test_runtime')),
       granted as (
         select readers.reader, privilege.grantee, privilege.privilege_type, privilege.is_grantable
           from readers
           join pg_proc proc on proc.oid = readers.reader
          cross join aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
          where privilege.grantee <> proc.proowner),
       wrong as (
         select format('%s granted %s to %s', granted.reader, granted.privilege_type,
                  case when granted.grantee = 0 then 'PUBLIC' else pg_get_userbyid(granted.grantee)::text end) as what
           from granted
          where not exists (select 1 from expected join pg_roles role_row on role_row.rolname = expected.grantee_name
                             where role_row.oid = granted.grantee and granted.privilege_type = 'EXECUTE'
                               and not granted.is_grantable)
         union all
         select format('%s lacks EXECUTE for %s', readers.reader, expected.grantee_name)
           from readers cross join expected join pg_roles role_row on role_row.rolname = expected.grantee_name
          where not exists (select 1 from granted
                             where granted.reader = readers.reader and granted.grantee = role_row.oid
                               and granted.privilege_type = 'EXECUTE'))
  select exists (select 1 from wrong), (select string_agg(wrong.what, '; ') from wrong)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0154: the readers'' grants are not section 6''s: %s', mismatch);
  end if;
  -- 0133 D5: R5 and R9's test name no ehr.prescriptions; R6 and R7 do, so
  -- 0133's S7 list (the owner-run definers whose text names
  -- ehr.prescriptions) gains R6 and R7 (R4 is on it already); no other
  -- owner-run SECURITY DEFINER function was made (R9's test aside),
  -- replaced or dropped, so the list is otherwise the one there was; 0148's
  -- C2 unchanged.
  if exists (select 1 from pg_proc proc where proc.oid = 'pharmacy.claim_prescription_dispensing()'::regprocedure
              and proc.prosrc ~* 'ehr\.prescriptions')
     or exists (select 1 from pg_proc proc where proc.oid = 'pharmacy.refill_scan_open()'::regprocedure
                 and proc.prosrc ~* 'ehr\.prescriptions')
     or not exists (select 1 from pg_proc proc where proc.oid = 'pharmacy.work_item_refills(uuid[])'::regprocedure
                     and proc.prosrc ~* 'ehr\.prescriptions')
     or not exists (select 1 from pg_proc proc where proc.oid = 'pharmacy.open_refill_work_items()'::regprocedure
                     and proc.prosrc ~* 'ehr\.prescriptions')
     or coalesce((select string_agg(proc.oid::text || ':' || proc.xmin::text, ' ' order by proc.oid)
                    from pg_proc proc
                   where proc.prosecdef and proc.proowner = owner_oid
                     and proc.oid not in ('pharmacy.validate_dispensing()'::regprocedure,
                           'pharmacy.claim_prescription_dispensing()'::regprocedure,
                           'pharmacy.work_item_refills(uuid[])'::regprocedure,
                           'pharmacy.open_refill_work_items()'::regprocedure,
                           'pharmacy.refill_scan_open()'::regprocedure)), 'none')
        is distinct from nullif(current_setting('refills_0154.definer_rows', true), '')
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = 'pharmacy.prescription_change_after_dispensing()'::regprocedure)
        is distinct from 'f61173d77be391a9e9c96db494827e82' then
    raise exception using errcode = '55000',
      message = '0154: the claim function or the marker test names ehr.prescriptions, a reader does not, or an '
        || 'owner-run definer function other than this file''s five was made, replaced or dropped, or 0148''s recorder '
        || 'changed';
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
    raise exception using errcode = '55000', message = '0154: the columns are not as this file makes them';
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
       'ehr.prescriptions prescriptions_refills_allowed_ck CHECK (((refills_allowed IS NULL) OR (((refills_allowed >= 0) '
         || 'AND (refills_allowed <= 11)) AND ((refills_allowed = 0) OR ((duration_value IS NOT NULL) AND (duration_unit IS '
         || 'NOT NULL)))))) true false']
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
      message = '0154: the CHECKs or the keys of pharmacy.dispensings and ehr.prescriptions are not as this file makes them';
  end if;
  -- R7's index exactly, valid and ready, and the only index of
  -- ehr.prescriptions that calls R8.
  if (select array_agg(pg_get_indexdef(index_row.indexrelid) || ' ' || (index_row.indisvalid and index_row.indisready)::text)
        from pg_index index_row
       where index_row.indexrelid = to_regclass('ehr.prescriptions_refills_facility_idx'))
     is distinct from array['CREATE INDEX prescriptions_refills_facility_idx ON ehr.prescriptions USING btree '
       || '(facility_id, created_at, ehr.prescription_refills_end_on(created_at, refills_allowed, duration_value, '
       || 'duration_unit, ends_on)) WHERE (refills_allowed > 0) true']
     or (select count(*) from pg_index index_row
          where index_row.indrelid = 'ehr.prescriptions'::regclass
            and pg_get_indexdef(index_row.indexrelid) like '%prescription_refills_end_on%') <> 1 then
    raise exception using errcode = '55000', message = '0154: R7''s index on ehr.prescriptions is not as this file makes it';
  end if;
  -- R8 exactly: its body (md5), the owner, SQL, IMMUTABLE, PARALLEL SAFE,
  -- not SECURITY DEFINER, not STRICT, the search_path, its result; EXECUTE
  -- for the owner and for each of the two runtimes that may write
  -- ehr.prescriptions and exist (not grantable), nothing else, PUBLIC
  -- included.
  if not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                  where proc.oid = end_on_function
                    and md5(proc.prosrc) = '90de746d4d8377b6dfecabb5d323dc31' and proc.proowner = owner_oid
                    and language_row.lanname = 'sql' and proc.provolatile = 'i' and proc.proparallel = 's'
                    and not proc.prosecdef and not proc.proisstrict
                    and proc.proconfig = array['search_path=pg_catalog, pg_temp']
                    and pg_get_function_result(proc.oid) = 'date')
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr' and proc.proname = 'prescription_refills_end_on') <> 1
     or exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
                 where proc.oid = end_on_function and privilege.grantee <> proc.proowner
                   and not (privilege.privilege_type = 'EXECUTE' and not privilege.is_grantable
                            and privilege.grantee in (select role_row.oid from pg_roles role_row
                                                       where role_row.rolname in ('hid_ehr_runtime',
                                                         'hid_schema_test_runtime'))))
     or exists (select 1 from pg_roles role_row
                 where role_row.rolname in ('hid_ehr_runtime', 'hid_schema_test_runtime')
                   and not exists (select 1 from pg_proc proc,
                                     aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
                                    where proc.oid = end_on_function
                                      and privilege.grantee = role_row.oid and privilege.privilege_type = 'EXECUTE')) then
    raise exception using errcode = '55000',
      message = '0154: ehr.prescription_refills_end_on (R8) or who may execute it is not as this file makes it';
  end if;
  -- R9 exactly (0143 D1's post-checks): the marker table (the owner's, its
  -- two columns and its key, no row-level security, no grant to anyone); its
  -- test (its body by md5, the owner, SQL, STABLE, SECURITY DEFINER, cost 1,
  -- the search_path; EXECUTE for the owner and PUBLIC only); the policy
  -- exactly (permissive, for SELECT, to PUBLIC, its printed expression), and
  -- no permissive policy of ehr.prescriptions for SELECT or ALL sorting
  -- after it by name (C collation, as PostgreSQL orders them), so it is
  -- asked first, and none between it and 0143's prescriptions_scan_my_orders,
  -- so 0143's policy is asked second (0143's own post-check held its order
  -- only when 0143 was applied; one sorting between the two would be asked
  -- before 0143's marker, inside its walk); no hid_ role but the owner a
  -- member of the table's owner (0133's form; MEMBER, so a NOINHERIT
  -- membership counts too).
  if not exists (select 1 from pg_class relation
                  where relation.oid = to_regclass('pharmacy.refill_scans') and relation.relkind = 'r'
                    and relation.relowner = owner_oid and not relation.relrowsecurity
                    and relation.relpersistence = 'p')
     or (select string_agg(attribute_row.attname || ' ' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
                   || ' ' || attribute_row.attnotnull::text, ', ' order by attribute_row.attnum)
           from pg_attribute attribute_row
          where attribute_row.attrelid = to_regclass('pharmacy.refill_scans') and attribute_row.attnum > 0
            and not attribute_row.attisdropped)
        is distinct from 'backend_pid integer true, transaction_started_at timestamp with time zone true'
     or (select string_agg(pg_get_constraintdef(constraint_row.oid), ', ') from pg_constraint constraint_row
          where constraint_row.conrelid = to_regclass('pharmacy.refill_scans'))
        is distinct from 'PRIMARY KEY (backend_pid, transaction_started_at)'
     or exists (select 1 from pg_class relation, aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 where relation.oid = to_regclass('pharmacy.refill_scans') and acl.grantee <> relation.relowner)
     or not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                     where proc.oid = to_regprocedure('pharmacy.refill_scan_open()')
                       and md5(proc.prosrc) = 'c06a06f770a690e456409803cc51b309' and proc.proowner = owner_oid
                       and language_row.lanname = 'sql' and proc.provolatile = 's' and proc.prosecdef
                       and proc.procost = 1 and not proc.proisstrict
                       and proc.proconfig = array['search_path=pg_catalog, pg_temp']
                       and pg_get_function_result(proc.oid) = 'boolean')
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'pharmacy' and proc.proname = 'refill_scan_open') <> 1
     or (select string_agg(case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee)::text end || ':'
                   || acl.privilege_type || ':' || acl.is_grantable::text, ' ' order by acl.grantee)
           from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
          where proc.oid = to_regprocedure('pharmacy.refill_scan_open()') and acl.grantee <> proc.proowner)
        is distinct from 'PUBLIC:EXECUTE:false'
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = 'ehr.prescriptions'::regclass and policy_row.polname = 'prescriptions_scan_refills'
            and policy_row.polcmd = 'r' and policy_row.polpermissive and policy_row.polroles = array[0::oid]
            and policy_row.polwithcheck is null
            and md5(pg_get_expr(policy_row.polqual, policy_row.polrelid)) = '98487317d1007ee3de2a0b8b5055f317') <> 1
     or exists (select 1 from pg_policy other_policy
                 where other_policy.polrelid = 'ehr.prescriptions'::regclass and other_policy.polpermissive
                   and other_policy.polcmd in ('r', '*')
                   and other_policy.polname::text collate "C" > 'prescriptions_scan_refills')
     or exists (select 1 from pg_policy other_policy
                 where other_policy.polrelid = 'ehr.prescriptions'::regclass and other_policy.polpermissive
                   and other_policy.polcmd in ('r', '*')
                   and other_policy.polname::text collate "C" > 'prescriptions_scan_my_orders'
                   and other_policy.polname <> 'prescriptions_scan_refills')
     or exists (select 1 from pg_roles role_row
                 where role_row.rolname like 'hid\_%'
                   and role_row.oid <> (select relation.relowner from pg_class relation
                                         where relation.oid = 'ehr.prescriptions'::regclass)
                   and pg_has_role(role_row.oid, (select relation.relowner from pg_class relation
                                                   where relation.oid = 'ehr.prescriptions'::regclass), 'MEMBER')) then
    raise exception using errcode = '55000',
      message = '0154: the refill scan marker (pharmacy.refill_scans, pharmacy.refill_scan_open or the policy '
        || 'prescriptions_scan_refills) is not as this file makes it, a read policy of ehr.prescriptions would be '
        || 'asked before it or between it and 0143''s prescriptions_scan_my_orders, or a hid_ role is a member of '
        || 'the owner of ehr.prescriptions';
  end if;
  -- The triggers on pharmacy.dispensings and their modes exactly as section
  -- 0 found them (the five, or the five and Billing's; g).
  if (select string_agg(trigger_row.tgname::text || ':' || trigger_row.tgfoid::regprocedure::text || ':'
          || trigger_row.tgtype::text || ':' || trigger_row.tgenabled::text, ' '
          order by trigger_row.tgname::text collate "C")
        from pg_trigger trigger_row
       where trigger_row.tgrelid = 'pharmacy.dispensings'::regclass and not trigger_row.tgisinternal)
     is distinct from nullif(current_setting('refills_0154.dispensing_triggers', true), '')
     or current_setting('refills_0154.dispensing_triggers', true) not in (
       'dispensings_claim_prescription:pharmacy.claim_prescription_dispensing():5:A '
         || 'dispensings_order_route_return:pharmacy.return_order_route_dispensing():5:O '
         || 'pharmacy_dispensing_validate:pharmacy.validate_dispensing():7:O '
         || 'pharmacy_dispensings_immutable:pharmacy.reject_immutable_evidence():27:O '
         || 'prescription_claim_key_immutable:pharmacy.refuse_claim_key_change():19:A',
       'dispensings_claim_prescription:pharmacy.claim_prescription_dispensing():5:A '
         || 'dispensings_order_route_return:pharmacy.return_order_route_dispensing():5:O '
         || 'pharmacy_dispensing_validate:pharmacy.validate_dispensing():7:O '
         || 'pharmacy_dispensings_immutable:pharmacy.reject_immutable_evidence():27:O '
         || 'prescription_claim_key_immutable:pharmacy.refuse_claim_key_change():19:A '
         || 'zz_billing_stock_and_gate:commercial.hook_dispensing():7:O') then
    raise exception using errcode = '55000', message = '0154: the triggers on pharmacy.dispensings changed';
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
        is distinct from current_setting('refills_0154.table_acls', true) then
    raise exception using errcode = '55000',
      message = '0154: the AFTER UPDATE triggers on ehr.prescriptions, or the owner, row-level security or ACL of '
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
      message = format('0154: the reader must refuse 201 ids with 22023 WORK_ITEM_REFILLS_INVALID; it answered %s %s',
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
      message = format('0154: the reader must refuse a null array with 22023 WORK_ITEM_REFILLS_INVALID; it answered '
        || '%s %s', error_state, coalesce(error_message, ''));
  end if;
  -- No marker row (the probes write none).
  if exists (select 1 from pharmacy.refill_scans) then
    raise exception using errcode = '55000', message = '0154: a refill scan marker row is left';
  end if;
end
$$;

reset role;
