-- 0164 BILL-1 (Release D): bills, bill lines, payments, HMO cover and the
-- bill's own log, with the bill commands and reads. Written on
-- claude/sprint-billing-backend (staging at 95fa1e52, 0001-0151 applied)
-- after 0162 and 0163 in the same pull request. Provisional number (Release
-- D block 0162-0167); nothing here reads 0152-0154. No migration number
-- appears inside a function body. The declaration is signed separately.
--
-- Owner decisions: the sprint approval of 25 November 2026 (BILL-1 A as
-- corrected: one bill per visit, or per counter sale; sources visit,
-- pharmacy and lab; BILL-3 A: unknown and emergency patients are served
-- first and their bill follows, always; BILL-4 A: a void only by a manager
-- who did not take the payment), and at the recommended option, not yet
-- answered: BILL-8 (an HMO's share is an HMO cover, owed by the HMO until a
-- claim is accepted, never money received), BILL-15 (every line at the cash
-- price), BILL-16 (receipt numbers per payment, gap-free per facility and
-- year).
--
-- WHAT IT DOES
-- T1 commercial.bills: one per visit (a waiting-list entry, unique while the
--    bill is not void) or per counter sale; source visit, pharmacy or lab;
--    the patient (null for an anonymous counter sale, with the name the
--    customer gave); a gap-free number per facility (B-000001); the totals
--    (total, paid, pending check, waived, HMO covered, due), kept by the
--    functions in the same transaction under FOR UPDATE on the bill; the
--    status; deferral (reason emergency, inpatient or unknown_patient, by
--    system or staff); void; hand-over of a counter sale; the outside
--    prescriber a counter sale of a prescription-only medicine was sold on
--    (0166 writes it; a counter sale only). A bill with live lines and
--    nothing left to pay is paid, even when every line is free (a sale of
--    free programme medicines is handed over like any other). An anonymous
--    bill is a pharmacy counter sale or a walk-in lab bill (the lab keeps
--    the name only; no hand-over, never put on a Health ID). What a
--    dispensing reversal left collected beyond the bill's total is kept as
--    refund due (the patient's money, given back first) and cover over the
--    bill (waiver or HMO cover still to be cancelled and recorded again);
--    such a bill has nothing due and is paid.
-- T2 commercial.bill_lines: the item, its name and kind as they were, a
--    whole quantity 1-10,000, the unit price in kobo at the time it was
--    added (a later price change never changes it), the origin (check_in,
--    pharmacy, lab, counter, manual), the work item (unique while not
--    cancelled, so a work item gets at most one automatic line), a "check
--    quantity" mark, cancellation with reason and member, the dispensing
--    the line bills (0167 records on a pharmacy line the first dispensing of
--    its work item made while the line is live; unique; no foreign key, as
--    0167 writes it in the dispensing's BEFORE INSERT trigger and pharmacy
--    dispensings are never deleted), and when that
--    dispensing was reversed (0167 then always cancels the line, so its
--    unpaid balance is never asked for, and what was collected for it is
--    left as the bill's refund due). A reversal of any other dispensing of
--    the same work item (a refill, if refills are recorded as further
--    dispensings of one work item) never touches the line.
-- T3 commercial.payments: cash, pos, transfer, waiver, online; status
--    recorded, pending_check (a transfer until a second person confirms it)
--    or confirmed; a receipt number unique per facility; the till day it was
--    taken in and the till day its void was recorded in (0165 adds their
--    foreign keys); the paper receipt number of the downtime book (BILL-6);
--    void columns. A void has a reason and a member other than the one who
--    took it; a waiver has a reason.
-- T4 commercial.hmo_covers: the HMO, the amount, the approval code, status
--    pending_claim or cancelled (Release 2 adds claimed, accepted, rejected);
--    never a payment, never in paid or a day's totals, no receipt.
-- T5 commercial.bill_events: every create, line, payment, confirm, void,
--    defer, attach and dispensing reversal, append-only.
-- Every table: facility_id on every row; row-level security forced with one
-- policy, for the owner at the session's facility only; no privilege for any
-- runtime; no DELETE or TRUNCATE (UPDATE too on T5); money bigint kobo >= 0.
-- F1 Helpers (owner only): commercial.patient_card, commercial.bill_json,
--    commercial.bill_recompute, commercial.bill_totals_agree (the post-check
--    the tests and the rehearsal use), commercial.bill_lock,
--    commercial.bill_event, commercial.bill_new, commercial.bill_line_put
--    (on a counter sale: never after its hand-over, ALREADY_HANDED_OVER;
--    a prescription-only medicine only as a counter-sale line on a sale with
--    its outside prescriber, else HB422 PRESCRIPTION_REQUIRED, so neither
--    POST /commercial/bills nor a manual line sells one with no
--    prescription),
--    commercial.bill_defer_put, commercial.bill_for_work (which bill an
--    automatic line joins: the patient's open waiting-list entry's bill at
--    this facility, else the bill of the patient's latest entry closed
--    today, else a new pharmacy or lab bill), commercial.resolve_health_id
--    (a patient lookup by Health ID, audited as identity.patient.lookup).
-- F2 For the EHR runtime and the schema test runtime (SECURITY DEFINER,
--    search_path pg_catalog, pg_temp): commercial.bill_list,
--    commercial.bill_summary, commercial.bill_get, commercial.bill_create,
--    commercial.bill_line_add, commercial.bill_line_cancel,
--    commercial.bill_void, commercial.bill_defer,
--    commercial.bill_attach_patient, commercial.hmo_cover_cancel,
--    commercial.outstanding, commercial.hmo_receivables; and for the
--    Pharmacy and Lab runtimes too, commercial.work_item_bills (the bill
--    badge of the caller's own work items). Each checks the caller's code at
--    the session facility and writes its audit rows (one per patient shown on
--    a list). Money collected beyond a bill's total after a reversal is easy
--    to find: bill_list's status money_over, bill_summary's moneyOver (the
--    facility's count and sums) and hmo_receivables' overBill marks (a cover
--    on such a bill, to cancel and record again before it is claimed). A
--    walk-in with no name reads "Walk-in" everywhere ("Counter sale" for a
--    counter sale).
-- Grants: EXECUTE on F2 to hid_ehr_runtime and hid_schema_test_runtime;
-- USAGE on schema commercial and EXECUTE on commercial.work_item_bills to
-- hid_pharmacy_runtime and hid_lab_runtime; where those roles exist (and in
-- runtime-grants.sql).
--
-- Locks: SHARE ROW EXCLUSIVE NOWAIT on identity.facilities,
-- identity.staff_facility_memberships, identity.patients, ehr.visit_queue,
-- commercial.catalogue_items and commercial.facility_hmos (the new tables'
-- foreign keys; 0163's two are checked to exist first), in one attempt made
-- up to 50 times 100 ms apart, or once when this transaction holds an
-- earlier file's locks; busy refusals begin "0164: ". Readers go on; writers
-- of those six tables wait for the commit (milliseconds).
--
-- Old services: nothing calls the new functions. New services on a schema
-- without it: 503 BILLING_UNAVAILABLE.
--
-- Undo (docs/rollback/0164_bills_payments_and_hmo_cover.md): drop F2, F1 and
-- the five tables (after 0165-0167's undo).

do $pre$
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
  made constant jsonb := '{
    "commercial.bill_attach_patient(uuid,text,text,text)": "b0db64981618b4d688068e0efe2d32d4",
    "commercial.bill_create(jsonb,text,text)": "665dc20070909425d73c65a2825e46b2",
    "commercial.bill_defer(uuid,text,text,text,text)": "94ec437e9660a4702de68ff80bd0edd7",
    "commercial.bill_defer_put(uuid,text,text,text,uuid)": "78022498b23e3b609c5518b87b72b77f",
    "commercial.bill_event(uuid,uuid,text,uuid,jsonb)": "96ab26ee8e6ef1706820d0fb8d2af7ba",
    "commercial.bill_for_work(uuid,uuid,text)": "ef364a4d5104462ccbdca575302b55a4",
    "commercial.bill_get(uuid)": "1cb53c93da1ed4f63599298cccdade93",
    "commercial.bill_json(uuid)": "9ae0582dc8a30c815c02aa6c0cd0aee8",
    "commercial.bill_line_add(uuid,jsonb,bigint,text,text)": "8187254afca47cbd8a6801d1a11a1791",
    "commercial.bill_line_cancel(uuid,uuid,text,bigint,text,text)": "4f5688921056a3896a28d28242d7ee53",
    "commercial.bill_line_put(uuid,uuid,integer,text,text,uuid,boolean,text,uuid,text,text)": "3bd0607d682ebe97f3921303ed5bd8fc",
    "commercial.bill_list(text,text,text,date,integer)": "b552b51876dad0b20a039e711aed66e7",
    "commercial.bill_lock(uuid,uuid,bigint)": "10056a5864f81b6310e3acd35dfad566",
    "commercial.bill_new(uuid,text,uuid,uuid,text,boolean,uuid,text,text)": "1339a9c111a6fa972c9c87397750660c",
    "commercial.bill_recompute(uuid)": "628ee7944cccea79e71e6ea7f8fbf978",
    "commercial.bill_summary(date)": "f165ea48bbeaaa609f015a208406bb9e",
    "commercial.bill_sums(uuid)": "c6fd7055dfa3c85b0dfe77c285484fcd",
    "commercial.bill_totals_agree(uuid)": "ec44041889c9f4c4a7fdd6096cd01624",
    "commercial.bill_void(uuid,text,bigint,text,text)": "ad03076e11f20979dacb90883c92af7d",
    "commercial.hmo_cover_cancel(uuid,uuid,text,bigint,text,text)": "d5dd9af97e8c38b3f3d54bee53792c98",
    "commercial.hmo_receivables(uuid,integer)": "46540681f4a2e54f5557ae8492d2641e",
    "commercial.outstanding(integer,integer)": "ef8cc7adf8f88bcecef4f4119885896f",
    "commercial.patient_card(uuid)": "b51e6a898739b4219696ccedca1877ec",
    "commercial.resolve_health_id(text,text)": "99e6d5e1a4c27dea25f9b2cb7799eb7e",
    "commercial.staff_source(uuid)": "df47a040ca9124981981cccb083bb8f1",
    "commercial.work_item_bills(text,uuid[])": "7ca3d58ca7674012c51818d6703febd5"}';
  present integer;
  differing text;
begin
  -- 0163's two tables are locked below (the new tables' foreign keys), so they must be there first.
  if to_regclass('commercial.catalogue_items') is null or to_regclass('commercial.facility_hmos') is null then
    raise exception using errcode = '55000', message = '0164: 0001-0151, 0162 and 0163 must be applied first';
  end if;
  loop
    attempt := attempt + 1;
    begin
      lock table identity.facilities, identity.staff_facility_memberships, identity.patients, ehr.visit_queue,
        commercial.catalogue_items, commercial.facility_hmos
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0164: identity.facilities, identity.staff_facility_memberships, identity.patients, '
            || 'ehr.visit_queue, commercial.catalogue_items or commercial.facility_hmos is busy, and this transaction '
            || 'already holds an earlier migration''s locks, so it does not wait; nothing applied; run the release '
            || 'again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0164: identity.facilities, identity.staff_facility_memberships, identity.patients, '
            || 'ehr.visit_queue, commercial.catalogue_items or commercial.facility_hmos stayed busy for 5 seconds; '
            || 'nothing applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;

  if to_regclass('commercial.catalogue_items') is null or to_regclass('commercial.commands') is null
     or to_regprocedure('commercial.caller(text)') is null or to_regclass('ehr.visit_queue') is null
     or to_regprocedure('identity.patient_record_kind(uuid)') is null then
    raise exception using errcode = '55000', message = '0164: 0001-0151, 0162 and 0163 must be applied first';
  end if;
  select count(*) into present from jsonb_object_keys(made) signature where to_regprocedure(signature) is not null;
  if present > 0 or to_regclass('commercial.bills') is not null then
    select string_agg(signature, ', ') into differing from jsonb_each_text(made) pinned(signature, digest)
     where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(pinned.signature))
           is distinct from pinned.digest;
    if differing is null and present = (select count(*) from jsonb_object_keys(made)) then
      raise exception using errcode = '55000', message = '0164: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0164: an object this file makes exists with other content: ' || coalesce(differing, 'a table');
  end if;
  -- The columns of ehr.visit_queue it reads, by name and type.
  if (select count(*) from pg_attribute attribute_row
       where attribute_row.attrelid = 'ehr.visit_queue'::regclass and attribute_row.attnum > 0
         and not attribute_row.attisdropped
         and attribute_row.attname || ' ' || format_type(attribute_row.atttypid, attribute_row.atttypmod) in (
           'id uuid', 'facility_id uuid', 'patient_id uuid', 'queue_day date', 'triage_level smallint',
           'closed_at timestamp with time zone', 'checked_in_at timestamp with time zone')) <> 7 then
    raise exception using errcode = '55000', message = '0164: ehr.visit_queue is not as 0135 made it';
  end if;
end
$pre$;

-- 1. Bills.
create table commercial.bills (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  number text not null check (number ~ '^B-[0-9]{6,9}$'),
  source text not null check (source in ('visit', 'pharmacy', 'lab')),
  patient_id uuid references identity.patients(id) on delete restrict,
  anonymous_name text check (anonymous_name is null or length(btrim(anonymous_name)) between 1 and 120),
  visit_queue_entry_id uuid references ehr.visit_queue(id) on delete restrict,
  counter boolean not null default false,
  status text not null default 'unpaid' check (status in ('unpaid', 'part_paid', 'paid', 'deferred', 'void')),
  total_kobo bigint not null default 0 check (total_kobo >= 0),
  paid_kobo bigint not null default 0 check (paid_kobo >= 0),
  pending_check_kobo bigint not null default 0 check (pending_check_kobo >= 0),
  waived_kobo bigint not null default 0 check (waived_kobo >= 0),
  hmo_covered_kobo bigint not null default 0 check (hmo_covered_kobo >= 0),
  due_kobo bigint not null default 0 check (due_kobo >= 0),
  refund_due_kobo bigint not null default 0 check (refund_due_kobo >= 0),
  cover_over_kobo bigint not null default 0 check (cover_over_kobo >= 0),
  deferred_reason text check (deferred_reason in ('emergency', 'inpatient', 'unknown_patient')),
  deferred_by text check (deferred_by in ('system', 'staff')),
  deferred_at timestamptz,
  deferred_note text check (deferred_note is null or length(deferred_note) <= 200),
  deferred_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(btrim(void_reason)) between 8 and 500),
  voided_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  handed_over_at timestamptz,
  handed_over_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  outside_prescriber_name text check (outside_prescriber_name is null
    or length(btrim(outside_prescriber_name)) between 2 and 120),
  created_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) check (request_sha256 ~ '^[0-9a-f]{64}$'),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (facility_id, number),
  unique (id, facility_id),
  constraint bills_due_ck check (due_kobo = greatest(total_kobo - paid_kobo - pending_check_kobo - waived_kobo
    - hmo_covered_kobo, 0)),
  -- Collected beyond the total (only after a dispensing reversal): the patient's money first, then cover.
  constraint bills_over_ck check (
    refund_due_kobo = least(greatest(paid_kobo + pending_check_kobo + waived_kobo + hmo_covered_kobo - total_kobo, 0),
      paid_kobo + pending_check_kobo)
    and cover_over_kobo = greatest(paid_kobo + pending_check_kobo + waived_kobo + hmo_covered_kobo - total_kobo, 0)
      - refund_due_kobo),
  constraint bills_source_ck check ((source = 'visit') = (visit_queue_entry_id is not null)),
  constraint bills_anonymous_ck check (patient_id is null or anonymous_name is null),
  constraint bills_counter_ck check (not counter or (source = 'pharmacy' and visit_queue_entry_id is null)),
  constraint bills_anonymous_counter_ck check (patient_id is not null or counter or source = 'lab'),
  constraint bills_outside_ck check (outside_prescriber_name is null or counter),
  constraint bills_deferred_ck check ((deferred_reason is null) = (deferred_by is null)
    and (deferred_reason is null) = (deferred_at is null)),
  constraint bills_void_ck check ((voided_at is null) = (void_reason is null)
    and (voided_at is null) = (voided_by_membership_id is null)),
  constraint bills_key_ck check ((idempotency_key is null) = (request_sha256 is null))
);
create unique index bills_one_per_visit_uq on commercial.bills (visit_queue_entry_id)
  where visit_queue_entry_id is not null and status <> 'void';
create index bills_list_idx on commercial.bills (facility_id, created_at desc, id);
create index bills_patient_idx on commercial.bills (facility_id, patient_id, created_at desc) where patient_id is not null;
create index bills_open_idx on commercial.bills (facility_id, created_at) where due_kobo > 0 and status <> 'void';

create table commercial.bill_lines (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  bill_id uuid not null,
  catalogue_item_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  kind text not null check (kind in ('drug', 'lab_test', 'other')),
  quantity integer not null check (quantity between 1 and 10000),
  unit_kobo bigint not null check (unit_kobo between 0 and 100000000),
  total_kobo bigint not null check (total_kobo >= 0),
  origin text not null check (origin in ('check_in', 'pharmacy', 'lab', 'counter', 'manual')),
  work_item_kind text check (work_item_kind in ('pharmacy', 'lab')),
  work_item_id uuid,
  check_quantity boolean not null default false,
  note text check (note is null or length(note) <= 200),
  cancelled boolean not null default false,
  cancel_reason text check (cancel_reason is null or length(btrim(cancel_reason)) between 8 and 500),
  cancelled_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  cancelled_at timestamptz,
  dispensing_reversed_at timestamptz,
  dispensing_id uuid,
  created_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) check (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (bill_id, facility_id) references commercial.bills (id, facility_id) on delete restrict,
  foreign key (catalogue_item_id, facility_id) references commercial.catalogue_items (id, facility_id) on delete restrict,
  constraint bill_lines_total_ck check (total_kobo = quantity * unit_kobo),
  constraint bill_lines_work_ck check ((work_item_kind is null) = (work_item_id is null)),
  constraint bill_lines_reversed_ck check (dispensing_reversed_at is null or work_item_kind = 'pharmacy'),
  constraint bill_lines_dispensing_ck check (dispensing_id is null or work_item_kind = 'pharmacy'),
  constraint bill_lines_cancel_ck check (cancelled = (cancel_reason is not null)
    and cancelled = (cancelled_at is not null) and cancelled = (cancelled_by_membership_id is not null))
);
create unique index bill_lines_one_per_work_uq on commercial.bill_lines (work_item_kind, work_item_id)
  where work_item_id is not null and not cancelled;
create index bill_lines_bill_idx on commercial.bill_lines (bill_id, created_at);
-- Every line of a work item, cancelled or not (the work list's bill badge reads reversed lines too).
create index bill_lines_work_idx on commercial.bill_lines (work_item_kind, work_item_id) where work_item_id is not null;
create unique index bill_lines_dispensing_uq on commercial.bill_lines (dispensing_id) where dispensing_id is not null;

create table commercial.payments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  bill_id uuid not null,
  method text not null check (method in ('cash', 'pos', 'transfer', 'waiver', 'online')),
  amount_kobo bigint not null check (amount_kobo between 1 and 1000000000),
  reference text check (reference is null or length(reference) between 3 and 100),
  reason text check (reason is null or length(btrim(reason)) between 8 and 500),
  status text not null check (status in ('recorded', 'pending_check', 'confirmed')),
  receipt_number text not null check (receipt_number ~ '^R-[0-9]{4}-[0-9]{6,9}$'),
  till_day_id uuid,
  void_till_day_id uuid,
  paper_receipt_number text check (paper_receipt_number is null or length(btrim(paper_receipt_number)) between 1 and 30),
  received_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  received_at timestamptz not null default clock_timestamp(),
  confirmed_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  confirmed_at timestamptz,
  voided_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(btrim(void_reason)) between 8 and 500),
  online_reference_sha256 char(64) check (online_reference_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) check (request_sha256 ~ '^[0-9a-f]{64}$'),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (facility_id, receipt_number),
  foreign key (bill_id, facility_id) references commercial.bills (id, facility_id) on delete restrict,
  constraint payments_status_ck check ((status = 'recorded' and method in ('cash', 'pos', 'waiver', 'online'))
    or (status in ('pending_check', 'confirmed') and method = 'transfer')),
  constraint payments_confirm_ck check ((status = 'confirmed') = (confirmed_at is not null)
    and (confirmed_at is null) = (confirmed_by_membership_id is null)
    and (confirmed_by_membership_id is null or confirmed_by_membership_id is distinct from received_by_membership_id)),
  constraint payments_waiver_ck check ((method = 'waiver') = (reason is not null)),
  constraint payments_reference_ck check (method not in ('pos', 'transfer') or reference is not null),
  constraint payments_online_ck check ((method = 'online') = (online_reference_sha256 is not null)
    and (method = 'online' or received_by_membership_id is not null)),
  constraint payments_till_day_ck check (method = 'waiver' or method = 'online' or till_day_id is not null),
  constraint payments_void_ck check ((voided_at is null) = (void_reason is null)
    and (voided_at is null) = (voided_by_membership_id is null)
    and (voided_by_membership_id is null or voided_by_membership_id is distinct from received_by_membership_id)),
  constraint payments_key_ck check ((idempotency_key is null) = (request_sha256 is null))
);
create unique index payments_online_reference_uq on commercial.payments (facility_id, online_reference_sha256)
  where online_reference_sha256 is not null;
create index payments_bill_idx on commercial.payments (bill_id, received_at);
create index payments_day_idx on commercial.payments (till_day_id) where till_day_id is not null;
create index payments_void_day_idx on commercial.payments (void_till_day_id) where void_till_day_id is not null;

create table commercial.hmo_covers (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  bill_id uuid not null,
  hmo_id uuid not null,
  amount_kobo bigint not null check (amount_kobo between 1 and 1000000000),
  approval_code text not null check (length(btrim(approval_code)) between 3 and 60),
  status text not null default 'pending_claim' check (status in ('pending_claim', 'cancelled')),
  recorded_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  cancelled_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(btrim(cancel_reason)) between 8 and 500),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (bill_id, facility_id) references commercial.bills (id, facility_id) on delete restrict,
  foreign key (hmo_id, facility_id) references commercial.facility_hmos (id, facility_id) on delete restrict,
  constraint hmo_covers_cancel_ck check ((status = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is null) = (cancel_reason is null) and (cancelled_at is null) = (cancelled_by_membership_id is null)
    and (cancelled_by_membership_id is null or cancelled_by_membership_id <> recorded_by_membership_id))
);
create index hmo_covers_bill_idx on commercial.hmo_covers (bill_id, recorded_at);
create index hmo_covers_pending_idx on commercial.hmo_covers (facility_id, hmo_id, recorded_at) where status = 'pending_claim';

create table commercial.bill_events (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  bill_id uuid not null,
  kind text not null check (kind in ('create', 'line-add', 'line-cancel', 'payment', 'hmo-cover', 'confirm',
    'payment-void', 'hmo-cover-cancel', 'void', 'defer', 'attach-patient', 'hand-over', 'dispensing-reversed')),
  membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (bill_id, facility_id) references commercial.bills (id, facility_id) on delete restrict
);
create index bill_events_bill_idx on commercial.bill_events (bill_id, created_at);

do $rls$
declare
  target text;
begin
  foreach target in array array['commercial.bills', 'commercial.bill_lines', 'commercial.payments',
      'commercial.hmo_covers', 'commercial.bill_events'] loop
    execute format('alter table %s enable row level security', target);
    execute format('alter table %s force row level security', target);
    execute format('create policy facility_owner_rows on %s for all using (current_user = %L and facility_id = '
      || 'platform.current_facility_id()) with check (current_user = %L and facility_id = platform.current_facility_id())',
      target, current_user, current_user);
    execute format('revoke all on %s from public', target);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function '
      || 'platform.reject_mutation()', target);
    if target = 'commercial.bill_events' then
      execute format('create trigger append_only before update or delete on %s for each row execute function '
        || 'platform.reject_mutation()', target);
    else
      execute format('create trigger no_delete before delete on %s for each row execute function '
        || 'platform.reject_mutation()', target);
    end if;
  end loop;
end
$rls$;

-- F1. Helpers.

-- The service a staff member's bill command came through: pharmacy-api sets
-- hid.billing_source for its transaction; anything else is ehr-api; a command
-- with no member is the system's (hid-billing).
create function commercial.staff_source(member_value uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select case when member_value is null then 'hid-billing'
              when current_setting('hid.billing_source', true) = 'pharmacy-api' then 'pharmacy-api'
              else 'ehr-api' end
$$;

-- A patient as a bill shows them: the display name and the last 4 characters
-- of the Health ID only.
create function commercial.patient_card(requested_patient uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object('patientId', patient.id, 'displayName', patient.full_name,
    'healthIdLast4', right(patient.hid_code, 4))
    from identity.patients patient where patient.id = requested_patient
$$;

create function commercial.bill_json(requested_bill uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'id', bill.id, 'number', bill.number, 'source', bill.source, 'status', bill.status, 'counter', bill.counter,
    'patient', case when bill.patient_id is null then null else commercial.patient_card(bill.patient_id) end,
    'displayName', case when bill.patient_id is null
                        then coalesce(bill.anonymous_name, case when bill.counter then 'Counter sale' else 'Walk-in' end)
                        else (select patient.full_name from identity.patients patient where patient.id = bill.patient_id) end,
    'visit', case when bill.visit_queue_entry_id is null then null
                  else (select jsonb_build_object('visitQueueEntryId', entry.id, 'queueDay', entry.queue_day)
                          from ehr.visit_queue entry where entry.id = bill.visit_queue_entry_id) end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', line.id, 'catalogueItemId', line.catalogue_item_id,
                'name', line.name, 'kind', line.kind, 'quantity', line.quantity, 'unitKobo', line.unit_kobo,
                'totalKobo', line.total_kobo, 'workItemId', line.work_item_id, 'origin', line.origin,
                'checkQuantity', line.check_quantity, 'note', line.note, 'cancelled', line.cancelled,
                'dispensingReversed', line.dispensing_reversed_at is not null)
                order by line.created_at, line.id)
              from commercial.bill_lines line where line.bill_id = bill.id), '[]'::jsonb),
    'totalKobo', bill.total_kobo, 'paidKobo', bill.paid_kobo, 'waivedKobo', bill.waived_kobo,
    'hmoCoveredKobo', bill.hmo_covered_kobo, 'pendingCheckKobo', bill.pending_check_kobo, 'dueKobo', bill.due_kobo,
    'refundDueKobo', bill.refund_due_kobo, 'coverOverKobo', bill.cover_over_kobo,
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', payment.id, 'method', payment.method,
                'amountKobo', payment.amount_kobo, 'reference', payment.reference, 'hmoId', null,
                'waivedBy', case when payment.method = 'waiver' then commercial.member_name(payment.received_by_membership_id) end,
                'reason', payment.reason,
                'receivedBy', case when payment.received_by_membership_id is null then 'Online payment'
                                   else commercial.member_name(payment.received_by_membership_id) end,
                'receivedAt', payment.received_at, 'voided', payment.voided_at is not null, 'status', payment.status,
                'receiptNumber', payment.receipt_number, 'tillDayId', payment.till_day_id,
                'voidedBy', case when payment.voided_by_membership_id is null then null
                                 else commercial.member_name(payment.voided_by_membership_id) end,
                'voidedAt', payment.voided_at, 'voidReason', payment.void_reason,
                'paperReceiptNumber', payment.paper_receipt_number)
                order by payment.received_at, payment.id)
              from commercial.payments payment where payment.bill_id = bill.id), '[]'::jsonb),
    'hmoCovers', coalesce((select jsonb_agg(jsonb_build_object('id', cover.id, 'hmoId', cover.hmo_id,
                'hmoName', hmo.name, 'amountKobo', cover.amount_kobo, 'approvalCode', cover.approval_code,
                'status', cover.status, 'recordedBy', commercial.member_name(cover.recorded_by_membership_id),
                'recordedAt', cover.recorded_at) order by cover.recorded_at, cover.id)
              from commercial.hmo_covers cover join commercial.facility_hmos hmo on hmo.id = cover.hmo_id
             where cover.bill_id = bill.id), '[]'::jsonb),
    'deferred', case when bill.deferred_reason is null then null
                     else jsonb_build_object('reason', bill.deferred_reason, 'by', bill.deferred_by, 'at', bill.deferred_at) end,
    'receiptNumber', (select payment.receipt_number from commercial.payments payment
                       where payment.bill_id = bill.id and payment.voided_at is null and payment.method <> 'waiver'
                       order by payment.received_at desc, payment.id desc limit 1),
    'handedOverAt', bill.handed_over_at, 'createdAt', bill.created_at, 'version', bill.row_version)
    from commercial.bills bill where bill.id = requested_bill
$$;

-- The sums a bill's row must hold, from its lines, payments and covers.
create function commercial.bill_sums(requested_bill uuid)
returns table (total_kobo bigint, paid_kobo bigint, pending_check_kobo bigint, waived_kobo bigint,
  hmo_covered_kobo bigint, live_lines bigint, all_lines bigint)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((select sum(line.total_kobo) from commercial.bill_lines line
                    where line.bill_id = requested_bill and not line.cancelled), 0)::bigint,
         coalesce((select sum(payment.amount_kobo) from commercial.payments payment
                    where payment.bill_id = requested_bill and payment.voided_at is null
                      and (payment.method in ('cash', 'pos', 'online')
                           or (payment.method = 'transfer' and payment.status = 'confirmed'))), 0)::bigint,
         coalesce((select sum(payment.amount_kobo) from commercial.payments payment
                    where payment.bill_id = requested_bill and payment.voided_at is null
                      and payment.method = 'transfer' and payment.status = 'pending_check'), 0)::bigint,
         coalesce((select sum(payment.amount_kobo) from commercial.payments payment
                    where payment.bill_id = requested_bill and payment.voided_at is null
                      and payment.method = 'waiver'), 0)::bigint,
         coalesce((select sum(cover.amount_kobo) from commercial.hmo_covers cover
                    where cover.bill_id = requested_bill and cover.status = 'pending_claim'), 0)::bigint,
         (select count(*) from commercial.bill_lines line where line.bill_id = requested_bill and not line.cancelled),
         (select count(*) from commercial.bill_lines line where line.bill_id = requested_bill)
$$;

-- Keeps a bill's totals and status (called under FOR UPDATE on the bill).
create function commercial.bill_recompute(requested_bill uuid)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  sums record;
  bill commercial.bills%rowtype;
  due bigint;
  over bigint;
  refund bigint;
  status_value text;
begin
  select * into sums from commercial.bill_sums(requested_bill);
  select bill_row.* into bill from commercial.bills bill_row where bill_row.id = requested_bill;
  due := greatest(sums.total_kobo - sums.paid_kobo - sums.pending_check_kobo - sums.waived_kobo - sums.hmo_covered_kobo, 0);
  -- Collected beyond the total (a dispensing reversal took a line off): the patient's money is given back first.
  over := greatest(sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo + sums.hmo_covered_kobo - sums.total_kobo, 0);
  refund := least(over, sums.paid_kobo + sums.pending_check_kobo);
  status_value := case
    when bill.voided_at is not null then 'void'
    when sums.all_lines > 0 and sums.live_lines = 0 and sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo
         + sums.hmo_covered_kobo = 0 then 'void'
    when bill.deferred_reason is not null and due > 0 then 'deferred'
    -- Nothing left to pay on live lines is paid, free lines too (a sale of
    -- free programme medicines has nothing to take and is handed over); so
    -- is a bill whose lines a reversal took off after money was taken.
    when due = 0 and (sums.live_lines > 0 or over > 0) then 'paid'
    when sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo + sums.hmo_covered_kobo > 0 then 'part_paid'
    else 'unpaid' end;
  update commercial.bills bill_row
     set total_kobo = sums.total_kobo, paid_kobo = sums.paid_kobo, pending_check_kobo = sums.pending_check_kobo,
         waived_kobo = sums.waived_kobo, hmo_covered_kobo = sums.hmo_covered_kobo, due_kobo = due,
         refund_due_kobo = refund, cover_over_kobo = over - refund, status = status_value, row_version = bill_row.row_version + 1, updated_at = clock_timestamp()
   where bill_row.id = requested_bill;
end
$$;

-- Whether a bill's kept totals and status agree with its lines, payments and
-- covers (the tests and the rehearsal call it after every command). More
-- collected than the total only after a dispensing reversal took a line off.
create function commercial.bill_totals_agree(requested_bill uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select (bill.total_kobo, bill.paid_kobo, bill.pending_check_kobo, bill.waived_kobo, bill.hmo_covered_kobo)
         = (sums.total_kobo, sums.paid_kobo, sums.pending_check_kobo, sums.waived_kobo, sums.hmo_covered_kobo)
     and bill.due_kobo = greatest(sums.total_kobo - sums.paid_kobo - sums.pending_check_kobo - sums.waived_kobo
                                  - sums.hmo_covered_kobo, 0)
     and (bill.paid_kobo + bill.pending_check_kobo + bill.waived_kobo + bill.hmo_covered_kobo <= bill.total_kobo
          or exists (select 1 from commercial.bill_lines line where line.bill_id = bill.id and line.cancelled
                      and line.dispensing_reversed_at is not null))
     and bill.refund_due_kobo = least(greatest(sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo
           + sums.hmo_covered_kobo - sums.total_kobo, 0), sums.paid_kobo + sums.pending_check_kobo)
     and bill.cover_over_kobo = greatest(sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo
           + sums.hmo_covered_kobo - sums.total_kobo, 0) - bill.refund_due_kobo
    from commercial.bills bill, commercial.bill_sums(bill.id) sums
   where bill.id = requested_bill
$$;

-- The bill of this facility, locked (FOR UPDATE); HB404 BILL_NOT_FOUND
-- otherwise; HB412 VERSION_CONFLICT for a stale expected version.
create function commercial.bill_lock(requested_bill uuid, requested_facility uuid, expected_version bigint)
returns commercial.bills
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  bill commercial.bills%rowtype;
begin
  select bill_row.* into bill from commercial.bills bill_row
   where bill_row.id = requested_bill and bill_row.facility_id = requested_facility for update;
  if not found then
    raise exception using errcode = 'HB404', message = 'BILL_NOT_FOUND';
  end if;
  if expected_version is not null and expected_version <> bill.row_version then
    raise exception using errcode = 'HB412', message = 'VERSION_CONFLICT';
  end if;
  return bill;
end
$$;

create function commercial.bill_event(requested_bill uuid, requested_facility uuid, event_kind text,
  event_membership uuid, event_details jsonb)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
  insert into commercial.bill_events (facility_id, bill_id, kind, membership_id, details)
  values (requested_facility, requested_bill, event_kind, event_membership, coalesce(event_details, '{}'::jsonb))
$$;

-- Defers a bill (system or staff) and audits it; a bill already deferred keeps its first reason.
create function commercial.bill_defer_put(requested_bill uuid, reason_value text, by_value text, note_value text,
  member_value uuid)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  bill commercial.bills%rowtype;
begin
  select bill_row.* into bill from commercial.bills bill_row where bill_row.id = requested_bill;
  if bill.deferred_reason is not null or bill.voided_at is not null then
    return;
  end if;
  update commercial.bills bill_row
     set deferred_reason = reason_value, deferred_by = by_value, deferred_at = clock_timestamp(),
         deferred_note = note_value, deferred_by_membership_id = member_value
   where bill_row.id = requested_bill;
  perform commercial.bill_recompute(requested_bill);
  perform commercial.bill_event(requested_bill, bill.facility_id, 'defer', member_value,
    jsonb_build_object('reason', reason_value, 'by', by_value));
  perform commercial.audit('commercial.bill.defer', 'success', 'bill', requested_bill::text, bill.patient_id,
    jsonb_build_object('reason', reason_value, 'by', by_value), commercial.staff_source(member_value));
end
$$;

-- A new bill; defers it at once for an unknown patient (ID-7) or an entry at
-- triage level 1 or 2 (BILL-3: served first, billed later, always).
create function commercial.bill_new(requested_facility uuid, source_value text, patient_value uuid, entry_value uuid,
  anonymous_value text, counter_value boolean, member_value uuid, key_value text, sha_value text)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  bill_id uuid;
  triage smallint;
begin
  insert into commercial.bills (facility_id, number, source, patient_id, anonymous_name, visit_queue_entry_id, counter,
    created_by_membership_id, idempotency_key, request_sha256)
  values (requested_facility, 'B-' || (select lpad(numbered.n::text, greatest(6, length(numbered.n::text)), '0')
                                        from (select commercial.next_number(requested_facility, 'bill', 0) as n) numbered),
    source_value, patient_value, nullif(btrim(anonymous_value), ''), entry_value, coalesce(counter_value, false),
    member_value, key_value, sha_value)
  returning id into bill_id;
  perform commercial.bill_event(bill_id, requested_facility, 'create', member_value,
    jsonb_build_object('source', source_value, 'counter', coalesce(counter_value, false)));
  perform commercial.audit('commercial.bill.create', 'success', 'bill', bill_id::text, patient_value,
    jsonb_build_object('source', source_value, 'counter', coalesce(counter_value, false),
      'by', case when member_value is null then 'system' else 'staff' end),
    commercial.staff_source(member_value));
  if patient_value is not null and identity.patient_record_kind(patient_value) = 'unknown' then
    perform commercial.bill_defer_put(bill_id, 'unknown_patient', 'system', null, null);
  elsif entry_value is not null then
    select entry.triage_level into triage from ehr.visit_queue entry where entry.id = entry_value;
    if triage in (1, 2) then
      perform commercial.bill_defer_put(bill_id, 'emergency', 'system', null, null);
    end if;
  end if;
  return bill_id;
end
$$;

-- Adds a line to a locked bill at the item's cash price now (BILL-15). A
-- counter sale takes no line once handed over (its goods have gone), and a
-- prescription-only medicine only as a counter-sale line (0166's
-- pharmacy.counter_sale_create) on a sale with its outside prescriber.
create function commercial.bill_line_put(requested_bill uuid, requested_item uuid, quantity_value integer,
  origin_value text, work_kind_value text, work_id_value uuid, check_value boolean, note_value text, member_value uuid,
  key_value text, sha_value text)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  bill commercial.bills%rowtype;
  item commercial.catalogue_items%rowtype;
  price bigint;
  line_id uuid;
begin
  select bill_row.* into bill from commercial.bills bill_row where bill_row.id = requested_bill;
  select catalogue_item.* into item from commercial.catalogue_items catalogue_item
   where catalogue_item.id = requested_item and catalogue_item.facility_id = bill.facility_id and catalogue_item.active;
  if not found then
    raise exception using errcode = 'HB404', message = 'CATALOGUE_ITEM_NOT_FOUND';
  end if;
  if bill.counter and bill.handed_over_at is not null then
    raise exception using errcode = 'HB409', message = 'ALREADY_HANDED_OVER';
  end if;
  if bill.counter and item.prescription_only
     and (origin_value is distinct from 'counter' or bill.outside_prescriber_name is null) then
    raise exception using errcode = 'HB422', message = 'PRESCRIPTION_REQUIRED';
  end if;
  if quantity_value is null or quantity_value not between 1 and 10000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "quantity"}';
  end if;
  if note_value is not null and char_length(note_value) > 200 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "note"}';
  end if;
  select price_row.amount_kobo into price from commercial.catalogue_item_prices price_row
   where price_row.catalogue_item_id = item.id and price_row.hmo_id is null;
  insert into commercial.bill_lines (facility_id, bill_id, catalogue_item_id, name, kind, quantity, unit_kobo, total_kobo,
    origin, work_item_kind, work_item_id, check_quantity, note, created_by_membership_id, idempotency_key, request_sha256)
  values (bill.facility_id, bill.id, item.id, item.name, item.kind, quantity_value, coalesce(price, 0),
    quantity_value * coalesce(price, 0), origin_value, work_kind_value, work_id_value, coalesce(check_value, false),
    note_value, member_value, key_value, sha_value)
  returning id into line_id;
  perform commercial.bill_recompute(bill.id);
  perform commercial.bill_event(bill.id, bill.facility_id, 'line-add', member_value,
    jsonb_build_object('lineId', line_id, 'origin', origin_value, 'quantity', quantity_value,
      'unitKobo', coalesce(price, 0)));
  perform commercial.audit('commercial.bill.line-add', 'success', 'bill', bill.id::text, bill.patient_id,
    jsonb_build_object('lineId', line_id, 'origin', origin_value, 'quantity', quantity_value,
      'unitKobo', coalesce(price, 0), 'by', case when member_value is null then 'system' else 'staff' end),
    commercial.staff_source(member_value));
  return line_id;
end
$$;

-- Which bill an automatic line joins: the bill of the patient's open
-- waiting-list entry at this facility; else the bill of the patient's latest
-- entry closed today (Lagos); else a new bill of the given source. The bill is
-- returned locked.
create function commercial.bill_for_work(requested_facility uuid, requested_patient uuid, source_value text)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  entry_value uuid;
  bill_id uuid;
begin
  select entry.id into entry_value from ehr.visit_queue entry
   where entry.facility_id = requested_facility and entry.patient_id = requested_patient and entry.closed_at is null;
  if entry_value is null then
    select entry.id into entry_value from ehr.visit_queue entry
     where entry.facility_id = requested_facility and entry.patient_id = requested_patient
       and entry.closed_at is not null and commercial.lagos_day(entry.closed_at) = commercial.lagos_day(clock_timestamp())
     order by entry.closed_at desc, entry.id desc limit 1;
  end if;
  if entry_value is not null then
    perform pg_advisory_xact_lock(hashtextextended('commercial-visit-bill:' || entry_value::text, 0));
    select bill.id into bill_id from commercial.bills bill
     where bill.visit_queue_entry_id = entry_value and bill.status <> 'void' for update;
    if bill_id is null then
      bill_id := commercial.bill_new(requested_facility, 'visit', requested_patient, entry_value, null, false, null,
        null, null);
    end if;
    return bill_id;
  end if;
  return commercial.bill_new(requested_facility, source_value, requested_patient, null, null, false, null, null, null);
end
$$;

-- A patient lookup by Health ID, as the pharmacy's walk-in does it: an active
-- patient whose Health ID it is, of the facility's own tenant (real, sealed
-- demo or sealed QA alike). Audited as identity.patient.lookup (found or not).
create function commercial.resolve_health_id(requested_health_id text, requested_source text)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  facility_value uuid := platform.current_facility_id();
  patient_value uuid;
begin
  if requested_health_id is null or upper(btrim(requested_health_id)) !~ '^HID-[A-Z0-9]{4,16}$' then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "healthId"}';
  end if;
  select patient.id into patient_value from identity.patients patient
   where upper(patient.hid_code) = upper(btrim(requested_health_id)) and patient.status = 'active'
     and identity.sealed_demo_facility(facility_value) = identity.sealed_demo_patient(patient.id)
     and identity.sealed_qa_facility(facility_value) = identity.sealed_qa_patient(patient.id);
  perform commercial.audit('identity.patient.lookup', case when patient_value is null then 'denied' else 'success' end,
    'patient', patient_value::text, patient_value, jsonb_build_object('by', 'health_id', 'for', 'bill'), requested_source);
  if patient_value is null then
    raise exception using errcode = 'HB404', message = 'PATIENT_NOT_FOUND';
  end if;
  return patient_value;
end
$$;

-- F2. Reads.

-- A page of this facility's bills, newest first, 25 per page. status one of
-- the five or open; source pharmacy lists bills with any pharmacy line; date a
-- Lagos day; q a bill or receipt number, or the start of a word of the
-- display name, among this facility's bills only. One audit row for the list
-- and one per patient shown.
create function commercial.bill_list(requested_status text, requested_source text, requested_q text,
  requested_date date, requested_page integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  q text;
  page_value integer := coalesce(requested_page, 1);
  ids uuid[];
  more boolean;
  answer jsonb;
begin
  select * into actor from commercial.caller('billing.bill.read');
  if (requested_status is not null
      and requested_status not in ('unpaid', 'part_paid', 'paid', 'deferred', 'void', 'open', 'money_over'))
     or (requested_source is not null and requested_source not in ('visit', 'pharmacy', 'lab'))
     or page_value not between 1 and 1000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "status"}';
  end if;
  q := commercial.search_text(requested_q);
  select array_agg(listed.id order by listed.created_at desc, listed.id desc) into ids from (
    select bill.id, bill.created_at
      from commercial.bills bill
     where bill.facility_id = actor.facility_id
       and (requested_status is null
            or (requested_status = 'open' and bill.status in ('unpaid', 'part_paid', 'deferred'))
            or (requested_status = 'money_over' and bill.status <> 'void'
                and bill.refund_due_kobo + bill.cover_over_kobo > 0)
            or bill.status = requested_status)
       and (requested_source is null
            or (requested_source = 'pharmacy' and (bill.source = 'pharmacy' or exists (
                  select 1 from commercial.bill_lines line where line.bill_id = bill.id and line.origin in ('pharmacy', 'counter'))))
            or (requested_source = 'lab' and (bill.source = 'lab' or exists (
                  select 1 from commercial.bill_lines line where line.bill_id = bill.id and line.origin = 'lab')))
            or (requested_source = 'visit' and bill.source = 'visit'))
       and (requested_date is null or commercial.lagos_day(bill.created_at) = requested_date)
       and (q is null
            or lower(bill.number) = q or lower(bill.number) = 'b-' || q
            or exists (select 1 from commercial.payments payment
                        where payment.bill_id = bill.id and lower(payment.receipt_number) = q)
            or commercial.name_matches(
                 case when bill.patient_id is null
                      then coalesce(bill.anonymous_name, case when bill.counter then 'Counter sale' else 'Walk-in' end)
                 else (select patient.full_name from identity.patients patient where patient.id = bill.patient_id) end, q))
     order by bill.created_at desc, bill.id desc
     offset (page_value - 1) * 25 limit 26) listed;
  more := coalesce(cardinality(ids), 0) > 25;
  ids := coalesce(ids[1:25], array[]::uuid[]);
  answer := jsonb_build_object('items', coalesce((select jsonb_agg(commercial.bill_json(listed.id) order by listed.ord)
                                                    from unnest(ids) with ordinality listed(id, ord)), '[]'::jsonb),
    'nextPage', case when more then page_value + 1 end, 'page', page_value);
  perform commercial.audit('commercial.bill.list', 'success', 'bill', null, null,
    jsonb_build_object('shown', cardinality(ids), 'status', requested_status, 'source', requested_source,
      'page', page_value, 'searched', q is not null), 'ehr-api');
  perform commercial.audit('commercial.bill.list.shown', 'success', 'patient', shown.patient_id::text, shown.patient_id,
      jsonb_build_object('bills', shown.bills), 'ehr-api')
     from (select bill.patient_id, count(*) as bills from commercial.bills bill
            where bill.id = any (ids) and bill.patient_id is not null group by bill.patient_id) shown;
  return answer;
end
$$;

-- The Home billing card: numbers only, no patient.
create function commercial.bill_summary(requested_date date)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  day_value date := coalesce(requested_date, commercial.lagos_day(clock_timestamp()));
  answer jsonb;
begin
  select * into actor from commercial.caller('billing.bill.read');
  select jsonb_build_object('date', day_value,
    'billedKobo', coalesce(sum(bill.total_kobo) filter (where bill.status <> 'void'), 0),
    'collectedKobo', coalesce((select sum(payment.amount_kobo) from commercial.payments payment
                                where payment.facility_id = actor.facility_id and payment.voided_at is null
                                  and commercial.lagos_day(payment.received_at) = day_value
                                  and (payment.method in ('cash', 'pos', 'online')
                                       or (payment.method = 'transfer' and payment.status = 'confirmed'))), 0),
    'waivedKobo', coalesce((select sum(payment.amount_kobo) from commercial.payments payment
                             where payment.facility_id = actor.facility_id and payment.voided_at is null
                               and payment.method = 'waiver' and commercial.lagos_day(payment.received_at) = day_value), 0),
    'hmoCoveredKobo', coalesce((select sum(cover.amount_kobo) from commercial.hmo_covers cover
                                 where cover.facility_id = actor.facility_id and cover.status = 'pending_claim'
                                   and commercial.lagos_day(cover.recorded_at) = day_value), 0),
    'outstandingKobo', coalesce((select sum(open_bill.due_kobo) from commercial.bills open_bill
                                  where open_bill.facility_id = actor.facility_id and open_bill.status <> 'void'), 0),
    'billCount', count(*) filter (where bill.status <> 'void'),
    'moneyOver', (select jsonb_build_object('billCount', count(*),
                    'refundDueKobo', coalesce(sum(over_bill.refund_due_kobo), 0),
                    'coverOverKobo', coalesce(sum(over_bill.cover_over_kobo), 0))
                    from commercial.bills over_bill
                   where over_bill.facility_id = actor.facility_id and over_bill.status <> 'void'
                     and over_bill.refund_due_kobo + over_bill.cover_over_kobo > 0))
    into answer
    from commercial.bills bill
   where bill.facility_id = actor.facility_id and commercial.lagos_day(bill.created_at) = day_value;
  perform commercial.audit('commercial.bill.summary.read', 'success', 'bill', null, null,
    jsonb_build_object('date', day_value), 'ehr-api');
  return answer;
end
$$;

create function commercial.bill_get(requested_bill uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  bill commercial.bills%rowtype;
begin
  select * into actor from commercial.caller('billing.bill.read');
  select bill_row.* into bill from commercial.bills bill_row
   where bill_row.id = requested_bill and bill_row.facility_id = actor.facility_id;
  if not found then
    raise exception using errcode = 'HB404', message = 'BILL_NOT_FOUND';
  end if;
  perform commercial.audit('commercial.bill.read', 'success', 'bill', bill.id::text, bill.patient_id, '{}'::jsonb, 'ehr-api');
  return commercial.bill_json(bill.id);
end
$$;

-- F2. Commands.

-- A manual bill: for a waiting-list entry of this facility (open, or closed
-- today), or an anonymous pharmacy or lab sale. An entry that already has a
-- bill that is not void takes the lines (merged). 1-50 lines.
create function commercial.bill_create(requested jsonb, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  source_value text := requested->>'source';
  patient_input jsonb := requested->'patient';
  entry ehr.visit_queue%rowtype;
  bill_id uuid;
  merged boolean := false;
  line jsonb;
begin
  select * into actor from commercial.caller('billing.bill.create');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'bill.create');
  if replay.replayed then
    return jsonb_build_object('bill', commercial.bill_json(replay.resource_id), 'merged', false, 'replayed', true);
  end if;
  if jsonb_typeof(requested) <> 'object' or source_value is null or source_value not in ('visit', 'pharmacy', 'lab') then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "source"}';
  end if;
  if jsonb_typeof(requested->'lines') <> 'array' or jsonb_array_length(requested->'lines') not between 1 and 50
     or exists (select 1 from jsonb_array_elements(requested->'lines') listed
                 where jsonb_typeof(listed) <> 'object'
                    or coalesce(listed->>'catalogueItemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    or jsonb_typeof(listed->'quantity') <> 'number'
                    or (listed->>'quantity')::numeric <> trunc((listed->>'quantity')::numeric)
                    or (listed->>'quantity')::numeric not between 1 and 10000
                    or (listed ? 'workItemId' and listed->'workItemId' <> 'null'::jsonb)) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "lines"}';
  end if;
  if jsonb_typeof(patient_input) <> 'object' then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "patient"}';
  end if;
  if patient_input ? 'visitQueueEntryId' then
    if coalesce(patient_input->>'visitQueueEntryId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or patient_input ? 'anonymous' then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "patient"}';
    end if;
    select queue_entry.* into entry from ehr.visit_queue queue_entry
     where queue_entry.id = (patient_input->>'visitQueueEntryId')::uuid and queue_entry.facility_id = actor.facility_id
       and (queue_entry.closed_at is null
            or commercial.lagos_day(queue_entry.closed_at) = commercial.lagos_day(clock_timestamp()));
    if not found then
      raise exception using errcode = 'HB404', message = 'PATIENT_NOT_FOUND';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('commercial-visit-bill:' || entry.id::text, 0));
    select bill.id into bill_id from commercial.bills bill
     where bill.visit_queue_entry_id = entry.id and bill.status <> 'void' for update;
    if bill_id is not null then
      merged := true;
    else
      bill_id := commercial.bill_new(actor.facility_id, 'visit', entry.patient_id, entry.id, null, false,
        actor.membership_id, requested_key, requested_sha256);
    end if;
  elsif patient_input->'anonymous' = 'true'::jsonb then
    if source_value = 'visit' or (patient_input ? 'name' and jsonb_typeof(patient_input->'name') not in ('string', 'null'))
       or char_length(coalesce(patient_input->>'name', '')) > 120 then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "patient"}';
    end if;
    -- An anonymous pharmacy bill is a counter sale; a walk-in lab bill is not (no hand-over) and keeps the name only.
    bill_id := commercial.bill_new(actor.facility_id, source_value, null, null, patient_input->>'name',
      source_value = 'pharmacy', actor.membership_id, requested_key, requested_sha256);
  else
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "patient"}';
  end if;
  for line in select value from jsonb_array_elements(requested->'lines') loop
    perform commercial.bill_line_put(bill_id, (line->>'catalogueItemId')::uuid, (line->>'quantity')::numeric::integer,
      'manual', null, null, false, null, actor.membership_id, requested_key, requested_sha256);
  end loop;
  perform commercial.command_record(requested_key, requested_sha256, 'bill.create', bill_id);
  return jsonb_build_object('bill', commercial.bill_json(bill_id), 'merged', merged);
end
$$;

create function commercial.bill_line_add(requested_bill uuid, requested jsonb, expected_version bigint,
  requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  bill commercial.bills%rowtype;
begin
  select * into actor from commercial.caller('billing.bill.create');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'bill.line-add');
  if replay.replayed then
    return commercial.bill_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  bill := commercial.bill_lock(requested_bill, actor.facility_id, expected_version);
  if bill.voided_at is not null or bill.status = 'void' then
    raise exception using errcode = 'HB409', message = 'BILL_VOID';
  end if;
  if jsonb_typeof(requested) <> 'object'
     or coalesce(requested->>'catalogueItemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(requested->'quantity') <> 'number'
     or (requested->>'quantity')::numeric <> trunc((requested->>'quantity')::numeric)
     or (requested ? 'note' and jsonb_typeof(requested->'note') not in ('string', 'null')) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "catalogueItemId"}';
  end if;
  if (requested->>'quantity')::numeric not between 1 and 10000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "quantity"}';
  end if;
  perform commercial.bill_line_put(bill.id, (requested->>'catalogueItemId')::uuid,
    (requested->>'quantity')::numeric::integer, 'manual', null, null, false, requested->>'note', actor.membership_id,
    requested_key, requested_sha256);
  perform commercial.command_record(requested_key, requested_sha256, 'bill.line-add', bill.id);
  return commercial.bill_json(bill.id);
end
$$;

create function commercial.bill_line_cancel(requested_bill uuid, requested_line uuid, reason_value text,
  expected_version bigint, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  bill commercial.bills%rowtype;
  line commercial.bill_lines%rowtype;
begin
  select * into actor from commercial.caller('billing.bill.adjust');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'bill.line-cancel');
  if replay.replayed then
    return commercial.bill_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  bill := commercial.bill_lock(requested_bill, actor.facility_id, expected_version);
  if bill.voided_at is not null or bill.status = 'void' then
    raise exception using errcode = 'HB409', message = 'BILL_VOID';
  end if;
  if reason_value is null or char_length(btrim(reason_value)) not between 8 and 500 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reason"}';
  end if;
  select bill_line.* into line from commercial.bill_lines bill_line
   where bill_line.id = requested_line and bill_line.bill_id = bill.id and not bill_line.cancelled for update;
  if not found then
    raise exception using errcode = 'HB404', message = 'BILL_NOT_FOUND';
  end if;
  if bill.total_kobo - line.total_kobo < bill.paid_kobo + bill.pending_check_kobo + bill.waived_kobo + bill.hmo_covered_kobo then
    raise exception using errcode = 'HB409', message = 'LINE_CANCEL_BELOW_PAID';
  end if;
  update commercial.bill_lines bill_line
     set cancelled = true, cancel_reason = btrim(reason_value), cancelled_by_membership_id = actor.membership_id,
         cancelled_at = clock_timestamp()
   where bill_line.id = line.id;
  perform commercial.bill_recompute(bill.id);
  perform commercial.bill_event(bill.id, bill.facility_id, 'line-cancel', actor.membership_id,
    jsonb_build_object('lineId', line.id, 'totalKobo', line.total_kobo));
  perform commercial.command_record(requested_key, requested_sha256, 'bill.line-cancel', bill.id);
  perform commercial.audit('commercial.bill.line-cancel', 'success', 'bill', bill.id::text, bill.patient_id,
    jsonb_build_object('lineId', line.id, 'totalKobo', line.total_kobo, 'origin', line.origin), 'ehr-api');
  return commercial.bill_json(bill.id);
end
$$;

create function commercial.bill_void(requested_bill uuid, reason_value text, expected_version bigint,
  requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  bill commercial.bills%rowtype;
begin
  select * into actor from commercial.caller('billing.bill.adjust');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'bill.void');
  if replay.replayed then
    return commercial.bill_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  bill := commercial.bill_lock(requested_bill, actor.facility_id, expected_version);
  if bill.voided_at is not null then
    raise exception using errcode = 'HB409', message = 'BILL_VOID';
  end if;
  if reason_value is null or char_length(btrim(reason_value)) not between 8 and 500 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reason"}';
  end if;
  if bill.paid_kobo + bill.pending_check_kobo + bill.waived_kobo + bill.hmo_covered_kobo > 0 then
    raise exception using errcode = 'HB409', message = 'BILL_HAS_PAYMENTS';
  end if;
  update commercial.bills bill_row
     set voided_at = clock_timestamp(), void_reason = btrim(reason_value), voided_by_membership_id = actor.membership_id
   where bill_row.id = bill.id;
  perform commercial.bill_recompute(bill.id);
  perform commercial.bill_event(bill.id, bill.facility_id, 'void', actor.membership_id, '{}'::jsonb);
  perform commercial.command_record(requested_key, requested_sha256, 'bill.void', bill.id);
  perform commercial.audit('commercial.bill.void', 'success', 'bill', bill.id::text, bill.patient_id,
    jsonb_build_object('totalKobo', bill.total_kobo), 'ehr-api');
  return commercial.bill_json(bill.id);
end
$$;

-- Defer: emergency (always allowed) or inpatient (not until the Inpatient
-- department ships). Clinical staff hold billing.bill.defer.
create function commercial.bill_defer(requested_bill uuid, reason_value text, note_value text, requested_key text,
  requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  bill commercial.bills%rowtype;
begin
  select * into actor from commercial.caller('billing.bill.defer');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'bill.defer');
  if replay.replayed then
    return commercial.bill_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  if reason_value is null or reason_value not in ('emergency', 'inpatient')
     or (note_value is not null and char_length(note_value) > 200) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reason"}';
  end if;
  if reason_value = 'inpatient' then
    raise exception using errcode = 'HB409', message = 'DEFERRAL_REASON_NOT_AVAILABLE';
  end if;
  bill := commercial.bill_lock(requested_bill, actor.facility_id, null);
  if bill.voided_at is not null or bill.status = 'void' then
    raise exception using errcode = 'HB409', message = 'BILL_VOID';
  end if;
  perform commercial.bill_defer_put(bill.id, reason_value, 'staff', note_value, actor.membership_id);
  perform commercial.command_record(requested_key, requested_sha256, 'bill.defer', bill.id);
  return commercial.bill_json(bill.id);
end
$$;

-- Puts an anonymous counter-sale bill on a Health ID: a patient lookup,
-- audited; only the bill moves, no clinical record is written.
create function commercial.bill_attach_patient(requested_bill uuid, requested_health_id text, requested_key text,
  requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  bill commercial.bills%rowtype;
  patient_value uuid;
begin
  select * into actor from commercial.caller('billing.bill.create');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'bill.attach-patient');
  if replay.replayed then
    return commercial.bill_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  bill := commercial.bill_lock(requested_bill, actor.facility_id, null);
  if not bill.counter or bill.patient_id is not null then
    raise exception using errcode = 'HB409', message = 'BILL_NOT_A_COUNTER_SALE';
  end if;
  if bill.voided_at is not null or bill.status = 'void' then
    raise exception using errcode = 'HB409', message = 'BILL_VOID';
  end if;
  patient_value := commercial.resolve_health_id(requested_health_id, 'ehr-api');
  update commercial.bills bill_row
     set patient_id = patient_value, anonymous_name = null, row_version = bill_row.row_version + 1,
         updated_at = clock_timestamp()
   where bill_row.id = bill.id;
  perform commercial.bill_event(bill.id, bill.facility_id, 'attach-patient', actor.membership_id, '{}'::jsonb);
  perform commercial.command_record(requested_key, requested_sha256, 'bill.attach-patient', bill.id);
  perform commercial.audit('commercial.bill.attach-patient', 'success', 'bill', bill.id::text, patient_value,
    '{}'::jsonb, 'ehr-api');
  return commercial.bill_json(bill.id);
end
$$;

-- Cancels an HMO cover: by someone other than the member who recorded it; the
-- amount goes back on what the patient owes.
create function commercial.hmo_cover_cancel(requested_bill uuid, requested_cover uuid, reason_value text,
  expected_version bigint, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  bill commercial.bills%rowtype;
  cover commercial.hmo_covers%rowtype;
begin
  select * into actor from commercial.caller('billing.payment.void');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'hmo-cover.cancel');
  if replay.replayed then
    return commercial.bill_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  bill := commercial.bill_lock(requested_bill, actor.facility_id, expected_version);
  if reason_value is null or char_length(btrim(reason_value)) not between 8 and 500 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reason"}';
  end if;
  select hmo_cover.* into cover from commercial.hmo_covers hmo_cover
   where hmo_cover.id = requested_cover and hmo_cover.bill_id = bill.id for update;
  if not found then
    raise exception using errcode = 'HB404', message = 'PAYMENT_NOT_FOUND';
  end if;
  if cover.status <> 'pending_claim' then
    raise exception using errcode = 'HB409', message = 'PAYMENT_ALREADY_VOIDED';
  end if;
  if cover.recorded_by_membership_id = actor.membership_id then
    raise exception using errcode = 'HB403', message = 'SECOND_PERSON_REQUIRED';
  end if;
  update commercial.hmo_covers hmo_cover
     set status = 'cancelled', cancelled_by_membership_id = actor.membership_id, cancelled_at = clock_timestamp(),
         cancel_reason = btrim(reason_value), row_version = hmo_cover.row_version + 1
   where hmo_cover.id = cover.id;
  perform commercial.bill_recompute(bill.id);
  perform commercial.bill_event(bill.id, bill.facility_id, 'hmo-cover-cancel', actor.membership_id,
    jsonb_build_object('coverId', cover.id, 'amountKobo', cover.amount_kobo));
  perform commercial.command_record(requested_key, requested_sha256, 'hmo-cover.cancel', bill.id);
  perform commercial.audit('commercial.hmo-cover.cancel', 'success', 'hmo-cover', cover.id::text, bill.patient_id,
    jsonb_build_object('billId', bill.id, 'amountKobo', cover.amount_kobo), 'ehr-api');
  return commercial.bill_json(bill.id);
end
$$;

-- Bills with money due, by patient, oldest bill first; anonymous sales as one
-- group with no patient. 25 groups per page. The groups are held in an array
-- in this function, never in a temporary table: a definer must not use one,
-- because the caller's session could have made a table of that name first,
-- with a trigger that would then run as this function's owner.
create function commercial.outstanding(older_than_days integer, requested_page integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  page_value integer := coalesce(requested_page, 1);
  older integer := coalesce(older_than_days, 0);
  answer jsonb;
  listed_ids uuid[];
  page_ids uuid[];
  more boolean;
begin
  select * into actor from commercial.caller('billing.report.read');
  if older not between 0 and 365 or page_value not between 1 and 1000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "olderThanDays"}';
  end if;
  -- The patient groups (null: the anonymous sales) in list order, up to one past this page.
  select array_agg(grouped.patient_id order by grouped.oldest, grouped.patient_id nulls last)
    into listed_ids
    from (select bill.patient_id, min(bill.created_at) as oldest
            from commercial.bills bill
           where bill.facility_id = actor.facility_id and bill.due_kobo > 0 and bill.status <> 'void'
             and bill.created_at <= clock_timestamp() - make_interval(days => older)
           group by bill.patient_id
           order by min(bill.created_at), bill.patient_id nulls last
           limit page_value * 25 + 1) grouped;
  more := coalesce(cardinality(listed_ids), 0) > page_value * 25;
  page_ids := coalesce(listed_ids[(page_value - 1) * 25 + 1 : page_value * 25], '{}'::uuid[]);
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'patient', case when listed.patient_id is null then null else commercial.patient_card(listed.patient_id) end,
      'bills', (select jsonb_agg(jsonb_build_object('billId', bill.id, 'number', bill.number, 'createdAt', bill.created_at,
                  'dueKobo', bill.due_kobo, 'deferred', bill.deferred_reason is not null) order by bill.created_at, bill.id)
                  from commercial.bills bill
                 where bill.facility_id = actor.facility_id and bill.patient_id is not distinct from listed.patient_id
                   and bill.due_kobo > 0 and bill.status <> 'void'
                   and bill.created_at <= clock_timestamp() - make_interval(days => older)),
      'dueKobo', (select sum(bill.due_kobo) from commercial.bills bill
                   where bill.facility_id = actor.facility_id and bill.patient_id is not distinct from listed.patient_id
                     and bill.due_kobo > 0 and bill.status <> 'void'
                     and bill.created_at <= clock_timestamp() - make_interval(days => older)),
      'oldestDays', (select commercial.lagos_day(clock_timestamp()) - commercial.lagos_day(min(bill.created_at))
                      from commercial.bills bill
                     where bill.facility_id = actor.facility_id and bill.patient_id is not distinct from listed.patient_id
                       and bill.due_kobo > 0 and bill.status <> 'void'
                       and bill.created_at <= clock_timestamp() - make_interval(days => older)))
      order by listed.ord), '[]'::jsonb),
    'totalDueKobo', (select coalesce(sum(bill.due_kobo), 0) from commercial.bills bill
                      where bill.facility_id = actor.facility_id and bill.due_kobo > 0 and bill.status <> 'void'
                        and bill.created_at <= clock_timestamp() - make_interval(days => older)),
    'nextPage', case when more then page_value + 1 end)
    into answer
    from unnest(page_ids) with ordinality as listed(patient_id, ord);
  perform commercial.audit('commercial.outstanding.read', 'success', 'bill', null, null,
    jsonb_build_object('page', page_value, 'olderThanDays', older), 'ehr-api');
  perform commercial.audit('commercial.outstanding.shown', 'success', 'patient', listed.patient_id::text,
      listed.patient_id, '{}'::jsonb, 'ehr-api')
     from unnest(page_ids) with ordinality as listed(patient_id, ord)
    where listed.patient_id is not null;
  return answer;
end
$$;

-- What each HMO owes (covers pending a claim); with an HMO, its covers.
create function commercial.hmo_receivables(requested_hmo uuid, requested_page integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  page_value integer := coalesce(requested_page, 1);
  answer jsonb;
  ids uuid[];
begin
  select * into actor from commercial.caller('billing.report.read');
  if page_value not between 1 and 1000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "page"}';
  end if;
  if requested_hmo is null then
    select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('hmoId', hmo.id, 'hmoName', hmo.name,
             'count', grouped.covers, 'amountKobo', grouped.amount,
             'oldestDays', commercial.lagos_day(clock_timestamp()) - commercial.lagos_day(grouped.oldest),
             'overBillCount', grouped.over_covers, 'overBillKobo', grouped.over_amount)
             order by lower(hmo.name), hmo.id), '[]'::jsonb))
      into answer
      from (select cover.hmo_id, count(*) as covers, sum(cover.amount_kobo) as amount, min(cover.recorded_at) as oldest,
                   count(*) filter (where bill.cover_over_kobo > 0) as over_covers,
                   coalesce(sum(cover.amount_kobo) filter (where bill.cover_over_kobo > 0), 0) as over_amount
              from commercial.hmo_covers cover
              join commercial.bills bill on bill.id = cover.bill_id
             where cover.facility_id = actor.facility_id and cover.status = 'pending_claim'
             group by cover.hmo_id) grouped
      join commercial.facility_hmos hmo on hmo.id = grouped.hmo_id;
    perform commercial.audit('commercial.hmo-receivables.read', 'success', 'hmo', null, null, '{}'::jsonb, 'ehr-api');
    return answer;
  end if;
  if not exists (select 1 from commercial.facility_hmos hmo where hmo.id = requested_hmo and hmo.facility_id = actor.facility_id) then
    raise exception using errcode = 'HB404', message = 'PAYMENT_NOT_FOUND';
  end if;
  select array_agg(listed.id order by listed.recorded_at, listed.id) into ids from (
    select cover.id, cover.recorded_at from commercial.hmo_covers cover
     where cover.facility_id = actor.facility_id and cover.hmo_id = requested_hmo and cover.status = 'pending_claim'
     order by cover.recorded_at, cover.id offset (page_value - 1) * 50 limit 51) listed;
  answer := jsonb_build_object('hmoId', requested_hmo,
    'items', coalesce((select jsonb_agg(jsonb_build_object('coverId', cover.id, 'billId', bill.id, 'billNumber', bill.number,
        'displayName', case when bill.patient_id is null
                            then coalesce(bill.anonymous_name, case when bill.counter then 'Counter sale' else 'Walk-in' end)
                            else (select patient.full_name from identity.patients patient where patient.id = bill.patient_id) end,
        'approvalCode', cover.approval_code, 'amountKobo', cover.amount_kobo, 'recordedAt', cover.recorded_at,
        'overBill', bill.cover_over_kobo > 0)
        order by listed.ord)
      from unnest(coalesce(ids[1:50], array[]::uuid[])) with ordinality listed(id, ord)
      join commercial.hmo_covers cover on cover.id = listed.id
      join commercial.bills bill on bill.id = cover.bill_id), '[]'::jsonb),
    'nextPage', case when coalesce(cardinality(ids), 0) > 50 then page_value + 1 end);
  perform commercial.audit('commercial.hmo-receivables.read', 'success', 'hmo', requested_hmo::text, null,
    jsonb_build_object('page', page_value), 'ehr-api');
  perform commercial.audit('commercial.hmo-receivables.shown', 'success', 'patient', shown.patient_id::text,
      shown.patient_id, jsonb_build_object('hmoId', requested_hmo), 'ehr-api')
     from (select distinct bill.patient_id from commercial.hmo_covers cover
             join commercial.bills bill on bill.id = cover.bill_id
            where cover.id = any (coalesce(ids[1:50], array[]::uuid[])) and bill.patient_id is not null) shown;
  return answer;
end
$$;

-- The bill badge of the caller's own work items (pharmacy or lab): the bill,
-- its status, what is due and its latest receipt, and, for a work item whose
-- dispensing was reversed (its line is taken off), the bill's refund due
-- while there is one. A work item with no live line has no badge ("Not
-- billed"), except a reversed one whose bill has a refund due ("Refund due").
create function commercial.work_item_bills(requested_kind text, requested_ids uuid[])
returns table (work_item_id uuid, bill jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  facility_value uuid := platform.current_facility_id();
begin
  if requested_kind not in ('pharmacy', 'lab') or requested_ids is null or cardinality(requested_ids) > 200 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "workItemIds"}';
  end if;
  perform commercial.caller(null);
  if not commercial.holds(case when requested_kind = 'pharmacy' then 'pharmacy.work-item.read' else 'lab.work-item.read' end) then
    raise exception using errcode = 'HB403', message = 'BILLING_NOT_ALLOWED';
  end if;
  return query
    select line.work_item_id,
           jsonb_build_object('billId', bill_row.id, 'status', bill_row.status, 'dueKobo', bill_row.due_kobo,
             'pendingCheckKobo', bill_row.pending_check_kobo,
             'dispensingReversed', line.dispensing_reversed_at is not null,
             'refundDueKobo', bill_row.refund_due_kobo,
             'deferred', case when bill_row.deferred_reason is null then null else bill_row.deferred_reason end,
             'receiptNumber', (select payment.receipt_number from commercial.payments payment
                                where payment.bill_id = bill_row.id and payment.voided_at is null
                                  and payment.method <> 'waiver'
                                order by payment.received_at desc, payment.id desc limit 1))
      from commercial.bill_lines line
      join commercial.bills bill_row on bill_row.id = line.bill_id
     where line.facility_id = facility_value and line.work_item_kind = requested_kind
       and line.work_item_id = any (requested_ids)
       and (not line.cancelled
            or (line.dispensing_reversed_at is not null and bill_row.refund_due_kobo > 0 and bill_row.voided_at is null
                and not exists (select 1 from commercial.bill_lines live where live.work_item_kind = line.work_item_kind
                                 and live.work_item_id = line.work_item_id and not live.cancelled)
                and line.id = (select latest.id from commercial.bill_lines latest
                                where latest.work_item_kind = line.work_item_kind and latest.work_item_id = line.work_item_id
                                  and latest.dispensing_reversed_at is not null
                                order by latest.created_at desc, latest.id desc limit 1)));
end
$$;

-- Grants (here and in runtime-grants.sql).
revoke all on function commercial.staff_source(uuid), commercial.patient_card(uuid), commercial.bill_json(uuid), commercial.bill_sums(uuid),
  commercial.bill_recompute(uuid), commercial.bill_totals_agree(uuid), commercial.bill_lock(uuid, uuid, bigint),
  commercial.bill_event(uuid, uuid, text, uuid, jsonb), commercial.bill_defer_put(uuid, text, text, text, uuid),
  commercial.bill_new(uuid, text, uuid, uuid, text, boolean, uuid, text, text),
  commercial.bill_line_put(uuid, uuid, integer, text, text, uuid, boolean, text, uuid, text, text),
  commercial.bill_for_work(uuid, uuid, text), commercial.resolve_health_id(text, text),
  commercial.bill_list(text, text, text, date, integer), commercial.bill_summary(date), commercial.bill_get(uuid),
  commercial.bill_create(jsonb, text, text), commercial.bill_line_add(uuid, jsonb, bigint, text, text),
  commercial.bill_line_cancel(uuid, uuid, text, bigint, text, text), commercial.bill_void(uuid, text, bigint, text, text),
  commercial.bill_defer(uuid, text, text, text, text), commercial.bill_attach_patient(uuid, text, text, text),
  commercial.hmo_cover_cancel(uuid, uuid, text, bigint, text, text), commercial.outstanding(integer, integer),
  commercial.hmo_receivables(uuid, integer), commercial.work_item_bills(text, uuid[]) from public;
do $grants$
declare
  runtime_role text;
begin
  foreach runtime_role in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function commercial.bill_list(text, text, text, date, integer), '
        || 'commercial.bill_summary(date), commercial.bill_get(uuid), commercial.bill_create(jsonb, text, text), '
        || 'commercial.bill_line_add(uuid, jsonb, bigint, text, text), '
        || 'commercial.bill_line_cancel(uuid, uuid, text, bigint, text, text), '
        || 'commercial.bill_void(uuid, text, bigint, text, text), commercial.bill_defer(uuid, text, text, text, text), '
        || 'commercial.bill_attach_patient(uuid, text, text, text), '
        || 'commercial.hmo_cover_cancel(uuid, uuid, text, bigint, text, text), '
        || 'commercial.outstanding(integer, integer), commercial.hmo_receivables(uuid, integer), '
        || 'commercial.work_item_bills(text, uuid[]) to %I', runtime_role);
    end if;
  end loop;
  foreach runtime_role in array array['hid_pharmacy_runtime', 'hid_lab_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant usage on schema commercial to %I', runtime_role);
      execute format('grant execute on function commercial.work_item_bills(text, uuid[]) to %I', runtime_role);
    end if;
  end loop;
end
$grants$;

comment on table commercial.bills is
  '0164 (BILL-1): one bill per visit (waiting-list entry) or counter sale; source visit, pharmacy or lab; totals kept by the definer functions under FOR UPDATE (commercial.bill_totals_agree checks them); deferred by the system for unknown patients and triage 1-2 (BILL-3). Never deleted.';
comment on table commercial.payments is
  '0164 (BILL-1): money received (cash, POS, transfer, online) and waivers, with a gap-free receipt number per facility and year (BILL-16). A void keeps the row and its number, by a member other than the one who took it (BILL-4). HMO cover is never here (BILL-8).';
comment on table commercial.hmo_covers is
  '0164 (BILL-8, recommended option): what an HMO is to pay: owed by the HMO until a claim is accepted (Release 2); never money received, never in a day''s totals, no receipt.';

-- Post-checks: the functions (md5, owner, search_path, SECURITY DEFINER, grants), and each new table's
-- row-level security, its one policy (permissive, for PUBLIC, its USING and WITH CHECK rule), its ACL and its
-- exact triggers (name, type, enabled, no arguments, no column list, no WHEN, function).
do $post$
declare
  made constant jsonb := '{
    "commercial.bill_attach_patient(uuid,text,text,text)": "b0db64981618b4d688068e0efe2d32d4",
    "commercial.bill_create(jsonb,text,text)": "665dc20070909425d73c65a2825e46b2",
    "commercial.bill_defer(uuid,text,text,text,text)": "94ec437e9660a4702de68ff80bd0edd7",
    "commercial.bill_defer_put(uuid,text,text,text,uuid)": "78022498b23e3b609c5518b87b72b77f",
    "commercial.bill_event(uuid,uuid,text,uuid,jsonb)": "96ab26ee8e6ef1706820d0fb8d2af7ba",
    "commercial.bill_for_work(uuid,uuid,text)": "ef364a4d5104462ccbdca575302b55a4",
    "commercial.bill_get(uuid)": "1cb53c93da1ed4f63599298cccdade93",
    "commercial.bill_json(uuid)": "9ae0582dc8a30c815c02aa6c0cd0aee8",
    "commercial.bill_line_add(uuid,jsonb,bigint,text,text)": "8187254afca47cbd8a6801d1a11a1791",
    "commercial.bill_line_cancel(uuid,uuid,text,bigint,text,text)": "4f5688921056a3896a28d28242d7ee53",
    "commercial.bill_line_put(uuid,uuid,integer,text,text,uuid,boolean,text,uuid,text,text)": "3bd0607d682ebe97f3921303ed5bd8fc",
    "commercial.bill_list(text,text,text,date,integer)": "b552b51876dad0b20a039e711aed66e7",
    "commercial.bill_lock(uuid,uuid,bigint)": "10056a5864f81b6310e3acd35dfad566",
    "commercial.bill_new(uuid,text,uuid,uuid,text,boolean,uuid,text,text)": "1339a9c111a6fa972c9c87397750660c",
    "commercial.bill_recompute(uuid)": "628ee7944cccea79e71e6ea7f8fbf978",
    "commercial.bill_summary(date)": "f165ea48bbeaaa609f015a208406bb9e",
    "commercial.bill_sums(uuid)": "c6fd7055dfa3c85b0dfe77c285484fcd",
    "commercial.bill_totals_agree(uuid)": "ec44041889c9f4c4a7fdd6096cd01624",
    "commercial.bill_void(uuid,text,bigint,text,text)": "ad03076e11f20979dacb90883c92af7d",
    "commercial.hmo_cover_cancel(uuid,uuid,text,bigint,text,text)": "d5dd9af97e8c38b3f3d54bee53792c98",
    "commercial.hmo_receivables(uuid,integer)": "46540681f4a2e54f5557ae8492d2641e",
    "commercial.outstanding(integer,integer)": "ef8cc7adf8f88bcecef4f4119885896f",
    "commercial.patient_card(uuid)": "b51e6a898739b4219696ccedca1877ec",
    "commercial.resolve_health_id(text,text)": "99e6d5e1a4c27dea25f9b2cb7799eb7e",
    "commercial.staff_source(uuid)": "df47a040ca9124981981cccb083bb8f1",
    "commercial.work_item_bills(text,uuid[])": "7ca3d58ca7674012c51818d6703febd5"}';
  own constant text[] := array['commercial.staff_source(uuid)', 'commercial.patient_card(uuid)', 'commercial.bill_json(uuid)',
    'commercial.bill_sums(uuid)', 'commercial.bill_recompute(uuid)', 'commercial.bill_totals_agree(uuid)',
    'commercial.bill_lock(uuid,uuid,bigint)', 'commercial.bill_event(uuid,uuid,text,uuid,jsonb)',
    'commercial.bill_defer_put(uuid,text,text,text,uuid)',
    'commercial.bill_new(uuid,text,uuid,uuid,text,boolean,uuid,text,text)',
    'commercial.bill_line_put(uuid,uuid,integer,text,text,uuid,boolean,text,uuid,text,text)',
    'commercial.bill_for_work(uuid,uuid,text)', 'commercial.resolve_health_id(text,text)',
    'commercial.bill_list(text,text,text,date,integer)', 'commercial.bill_summary(date)', 'commercial.bill_get(uuid)',
    'commercial.bill_create(jsonb,text,text)', 'commercial.bill_line_add(uuid,jsonb,bigint,text,text)',
    'commercial.bill_line_cancel(uuid,uuid,text,bigint,text,text)', 'commercial.bill_void(uuid,text,bigint,text,text)',
    'commercial.bill_defer(uuid,text,text,text,text)', 'commercial.bill_attach_patient(uuid,text,text,text)',
    'commercial.hmo_cover_cancel(uuid,uuid,text,bigint,text,text)', 'commercial.outstanding(integer,integer)',
    'commercial.hmo_receivables(uuid,integer)', 'commercial.work_item_bills(text,uuid[])'];
  owner_oid oid := (select nspowner from pg_namespace where nspname = 'commercial');
  -- The one policy's rule, as PostgreSQL shows it, for the owner (who made every table here).
  owner_rule constant text := format('((CURRENT_USER = %L::name) AND (facility_id = platform.current_facility_id()))',
    pg_get_userbyid(owner_oid));
  -- The tables with append_only (no UPDATE or DELETE); the others have no_delete. Every table has no_truncate.
  append_only_tables constant text[] := array['commercial.bill_events'];
  computed jsonb;
  differing text;
  granted constant text[] := array['commercial.bill_list(text,text,text,date,integer)', 'commercial.bill_summary(date)',
    'commercial.bill_get(uuid)', 'commercial.bill_create(jsonb,text,text)',
    'commercial.bill_line_add(uuid,jsonb,bigint,text,text)', 'commercial.bill_line_cancel(uuid,uuid,text,bigint,text,text)',
    'commercial.bill_void(uuid,text,bigint,text,text)', 'commercial.bill_defer(uuid,text,text,text,text)',
    'commercial.bill_attach_patient(uuid,text,text,text)', 'commercial.hmo_cover_cancel(uuid,uuid,text,bigint,text,text)',
    'commercial.outstanding(integer,integer)', 'commercial.hmo_receivables(uuid,integer)',
    'commercial.work_item_bills(text,uuid[])'];
  tables constant text[] := array['commercial.bills', 'commercial.bill_lines', 'commercial.payments',
    'commercial.hmo_covers', 'commercial.bill_events'];
begin
  select jsonb_object_agg(signature, md5(proc.prosrc)) into computed
    from unnest(own) signature join pg_proc proc on proc.oid = to_regprocedure(signature);
  if (select count(*) from jsonb_object_keys(computed)) <> cardinality(own) then
    raise exception using errcode = '55000', message = '0164: post-check failed: a function is missing';
  end if;
  if made = '{}'::jsonb then
    raise notice '0164 made: %', computed;
  elsif computed is distinct from made then
    select string_agg(key, ', ') into differing from (
      select key from jsonb_each_text(made) where computed->>key is distinct from value
      union select key from jsonb_each_text(computed) where made->>key is null) keys;
    raise exception using errcode = '55000', message = '0164: post-check failed: functions differ: ' || differing;
  end if;
  if exists (select 1 from jsonb_object_keys(computed) signature, pg_proc proc
              where proc.oid = to_regprocedure(signature)
                and (proc.proowner <> owner_oid or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
                     or proc.prosecdef <> (signature = any (granted)))) then
    raise exception using errcode = '55000', message = '0164: post-check failed: a function''s owner, search_path or SECURITY DEFINER';
  end if;
  if exists (select 1 from jsonb_object_keys(computed) signature, pg_proc proc,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = to_regprocedure(signature) and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or not (signature = any (granted))
                     or (pg_get_userbyid(acl.grantee) not in ('hid_ehr_runtime', 'hid_schema_test_runtime')
                         and not (signature = 'commercial.work_item_bills(text,uuid[])'
                                  and pg_get_userbyid(acl.grantee) in ('hid_pharmacy_runtime', 'hid_lab_runtime'))))) then
    raise exception using errcode = '55000', message = '0164: post-check failed: a function is granted to another role';
  end if;
  if (select count(*) from pg_class relation
       where relation.oid = any (select to_regclass(name) from unnest(tables) name)
         and relation.relrowsecurity and relation.relforcerowsecurity and relation.relowner = owner_oid
         and (select count(*) from pg_policy policy where policy.polrelid = relation.oid) = 1
         and exists (select 1 from pg_policy policy where policy.polrelid = relation.oid
                      and policy.polname = 'facility_owner_rows' and policy.polcmd = '*' and policy.polpermissive
                      and policy.polroles = array[0]::oid[]
                      and pg_get_expr(policy.polqual, policy.polrelid) = owner_rule
                      and pg_get_expr(policy.polwithcheck, policy.polrelid) = owner_rule)
         and not exists (select 1 from lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                          where acl.grantee <> relation.relowner)
         and (select string_agg(trigger_row.tgname || ':' || trigger_row.tgtype || ':' || trigger_row.tgenabled::text || ':'
                                  || trigger_row.tgnargs || ':' || trigger_row.tgattr::text || ':'
                                  || (trigger_row.tgqual is null) || ':' || trigger_row.tgfoid::regprocedure::text,
                                ',' order by trigger_row.tgname collate "C")
                from pg_trigger trigger_row where trigger_row.tgrelid = relation.oid and not trigger_row.tgisinternal)
             = case when relation.oid = any (select to_regclass(name) from unnest(append_only_tables) name)
                    then 'append_only:27:O:0::true:platform.reject_mutation(),'
                    else 'no_delete:11:O:0::true:platform.reject_mutation(),' end
               || 'no_truncate:34:O:0::true:platform.reject_mutation()')
     <> cardinality(tables) then
    raise exception using errcode = '55000', message = '0164: post-check failed: a table''s row-level security, policy, ACL or triggers';
  end if;
end
$post$;
