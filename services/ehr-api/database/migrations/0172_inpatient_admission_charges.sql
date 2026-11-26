-- 0172 ADT-1 Inpatient admission: admission charges (Release D, the
-- department sprint the owner approved on 25 November 2026, verbatim: "I
-- approve Q147–Q290 at the recommended options"). Written on
-- claude/sprint-inpatient-backend at 64b22777 after 0170 and 0171 in the same
-- pull request. The number is provisional (given at merge). It needs 0171
-- and BILL-1's 0162-0167 (patient billing), read at
-- claude/sprint-billing-backend bd427a88: it replaces five of BILL-1's
-- bodies and widens five of its CHECKs, so its preconditions pin every
-- BILL-1 body it replaces or calls (md5) and BILL-1's CHECKs; a later BILL-1
-- change to any of them stops this file until it is re-read. If BILL-1 is not
-- in the same cut, this file waits and takes a later number; 0173 does not
-- need it. The
-- declaration in config/production-schema-compatibility.json stays unsigned
-- until the owner signs this file.
--
-- Owner decisions (25 November 2026, each at its recommended option): Q189 A
-- (bed-day and ward charges, deposits and interim bills on the bill, and
-- discharge is never held for an unpaid bill; fixed), Q173 A (one bill per
-- encounter: the stay's lab and pharmacy lines go on its admission bill),
-- Q176 A (a credit is paid back by BILL-1's manager void, reason "Refund:
-- deposit not used"). Smaller choices at their recommended option, not yet
-- answered: Q-ADT-13 A (one bed-day for each midnight, Lagos, the patient is
-- admitted, at the rate of the ward they are in at midnight; a stay with no
-- midnight counts one day; the day of discharge is not charged), Q-ADT-14 A
-- (deposits are recorded, never required).
--
-- What it changes (nothing else):
-- B1 commercial.bills          source CHECK gains 'admission'; new column
--                              admission_id (references ehr.admissions; one
--                              bill per admission while not void);
--                              bills_source_ck replaced so that an admission
--                              bill has its admission and no waiting-list
--                              row; new column credit_kobo (0 or more), kept
--                              by bill_recompute. BILL-1's bills_over_ck
--                              (money collected beyond the total: the
--                              patient's money as refund_due_kobo first,
--                              then cover_over_kobo) is replaced: it holds
--                              as BILL-1 wrote it for every other bill, which
--                              holds no credit; on an admission bill what was
--                              collected beyond the total is its credit
--                              (credit_kobo), and its refund due and cover
--                              over stay 0, so a deposit beyond what is due
--                              never shows in BILL-1's money-over lists while
--                              the patient is on the ward (Q176 A: a credit
--                              is paid back by BILL-1's manager void).
--                              The value-list CHECKs here (source, origin,
--                              kind) must hold BILL-1's values and not this
--                              file's; a value another lane added is kept.
-- B2 commercial.bill_lines     origin CHECK gains 'bed_day' and 'admission'.
-- B3 commercial.payments       new column kind (payment, the default, or
--                              deposit); a trigger refuses a deposit on a bill
--                              that is not an admission bill.
-- B4 commercial.number_counters  kind CHECK gains 'interim' (per year).
-- B5 commercial.ward_charge_items  per ward: the bed-day item and the
--                              admission-fee item (active price-list items of
--                              kind other, this facility's), a version.
-- B6 commercial.bed_day_charges  admission, Lagos census day, ward, bill line;
--                              unique (admission, census day): a bed-day is
--                              never added twice.
--    B5 and B6 are kept as BILL-1's tables: row-level security forced, one
--    policy facility_owner_rows (the owner, at the session facility), no
--    privilege for any runtime role.
-- B7 Functions (SECURITY DEFINER where a route calls them, EXECUTE for
--    hid_ehr_runtime): commercial.ward_charges_set, commercial.ward_charges_list,
--    commercial.interim_statement, commercial.accrue_bed_days_due (the
--    hourly sweep), commercial.admission_bill_ids (the card's billId, for a
--    ward member; never a bill's content); helpers no role may execute:
--    commercial.admission_bill_open, commercial.accrue_bed_days,
--    commercial.admission_fee_add, commercial.payments_deposit_guard and the
--    two hook functions.
-- B8 Replaced, md5-pinned before (BILL-1's at bd427a88) and after; each is
--    BILL-1's body with this file's change and nothing else:
--    commercial.bill_for_work (work for a patient with an open admission here
--    finds the admission bill), commercial.payment_record (kind deposit: only
--    on an admission bill while the stay is open, and may be more than what is
--    due; BILL-1's till-day lock and receipt numbers kept),
--    commercial.bill_recompute (the credit on an admission bill, BILL-1's
--    refund due and cover over on any other), commercial.bill_totals_agree
--    (the same), commercial.bill_json (creditKobo, the stay, and each
--    payment's kind, beside BILL-1's refundDueKobo and coverOverKobo). The new
--    bodies number bills and interim statements as BILL-1 numbers bills and
--    receipts (six digits at least, never cut).
-- B9 Hooks, as triggers on ehr.admissions (not edits of 0171's functions):
--    AFTER INSERT (zz_billing_admission_open) opens the admission bill (source
--    admission; deferred "inpatient" by the system when the facility's
--    allow_deferred_for lists inpatient); AFTER UPDATE OF status
--    (zz_billing_admission_status) adds the admission fee when the bed is
--    given and the bed-days at discharge. Each returns at once when the
--    facility has no payment settings row or the row is not the session
--    facility's, and **swallows any billing error** (a NOTICE), so no billing
--    state can refuse or undo an admission step.
-- **No hook, function or CHECK reads a bill to allow or refuse an admission
-- step.** The post-check scans the bodies of every ehr.admission_* function
-- for the word "commercial" and raises if it finds one.
-- Audit: BILL-1's commercial.bill.* rows (as the system for a hook), plus
-- commercial.bed-day.add, commercial.ward-charges.set and
-- commercial.interim-statement.print. Never a name or a Health ID. This file
-- itself writes no audit row.
--
-- Locks (measured with pg_locks before commit), taken first, NOWAIT: ACCESS
-- EXCLUSIVE on commercial.bills, commercial.bill_lines, commercial.payments and
-- commercial.number_counters (CHECK swaps and column adds; small tables);
-- SHARE ROW EXCLUSIVE on ehr.admissions, ehr.wards, commercial.catalogue_items,
-- identity.facilities and identity.staff_facility_memberships (foreign keys,
-- triggers); ROW EXCLUSIVE on audit.events; ACCESS SHARE on
-- commercial.payment_settings, commercial.catalogue_item_prices,
-- commercial.facility_hmos, commercial.hmo_covers, ehr.admission_movements,
-- ehr.visit_queue and identity.patients (read by the bodies; a SQL body is
-- checked when it is created). A busy table fails the attempt at once; 50 attempts, 100 ms apart;
-- then 55P03 (nothing applied); one attempt when this transaction already
-- holds an earlier migration's strong locks. Both refusals begin "0172: " and
-- end "run the release again at a quieter time" (#306).
--
-- Old images on this schema: BILL-1's image never sends kind and reads the
-- new fields as absent; an admission bill shows in its lists as any bill.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- two triggers and the new functions, put back BILL-1's five bodies, and drop
-- the new tables and columns once no admission bill exists.
--
-- The whole file is one statement (do $adt0172$):
-- 0. The locks. 1. Preconditions (0171 and BILL-1 applied; "0172: already
-- applied"; half state; the five BILL-1 bodies it replaces and the 17 BILL-1
-- bodies (and 0059's permission check) the new and replaced bodies call, as
-- BILL-1 left them at bd427a88 (md5); BILL-1's two expression CHECKs exactly,
-- and its three value-list CHECKs with every BILL-1 value and any value
-- another lane added). 2. B1-B9. 3. Post-checks (0148's, 0152's and 0168's
-- form): the scan; the five replaced bodies as written; the CHECKs (the value
-- lists found plus this file's values; the two expression CHECKs as written;
-- validated); the tables, policies and the three triggers (events, columns,
-- function, no WHEN condition or arguments); the 17 functions by body,
-- SECURITY DEFINER setting, volatility, search_path, owner and EXECUTE; no
-- row of audit.events, bills, bill lines, payments or number counters
-- written (this transaction's own row counters; no count or scan of a
-- table).

do $adt0172$
declare
  v_writes_before text;
  v_post_mismatch text;
  v_attempt integer := 0;
  v_holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  v_mismatch text;
  v_present integer;
  v_owner name;
  v_target text;
  v_check record;
  v_found text[];
  v_found_def text;
  -- The three value-list CHECKs this file widens: BILL-1's values (all must be there; another lane's extra values are
  -- kept) and the values this file adds.
  v_lists constant jsonb := jsonb_build_array(
    jsonb_build_object('relation', 'commercial.bills', 'name', 'bills_source_check', 'column', 'source',
      'required', jsonb_build_array('visit', 'pharmacy', 'lab'), 'added', jsonb_build_array('admission')),
    jsonb_build_object('relation', 'commercial.bill_lines', 'name', 'bill_lines_origin_check', 'column', 'origin',
      'required', jsonb_build_array('check_in', 'pharmacy', 'lab', 'counter', 'manual'),
      'added', jsonb_build_array('bed_day', 'admission')),
    jsonb_build_object('relation', 'commercial.number_counters', 'name', 'number_counters_kind_check', 'column', 'kind',
      'required', jsonb_build_array('bill', 'receipt'), 'added', jsonb_build_array('interim')));
  v_found_lists jsonb := '{}'::jsonb;
  -- BILL-1's two expression CHECKs on commercial.bills this file replaces, exactly as BILL-1 left them.
  v_source_ck_bill1 constant text := 'CHECK (((source = ''visit''::text) = (visit_queue_entry_id IS NOT NULL)))';
  v_over_ck_bill1 constant text := 'CHECK (((refund_due_kobo = LEAST(GREATEST(((((paid_kobo + pending_check_kobo) + '
    || 'waived_kobo) + hmo_covered_kobo) - total_kobo), (0)::bigint), (paid_kobo + pending_check_kobo))) AND '
    || '(cover_over_kobo = (GREATEST(((((paid_kobo + pending_check_kobo) + waived_kobo) + hmo_covered_kobo) - '
    || 'total_kobo), (0)::bigint) - refund_due_kobo))))';
begin
  -- Before the locks (catalog reads only): the files whose tables step 0 locks.
  if to_regclass('ehr.admissions') is null or to_regclass('ehr.admission_movements') is null then
    raise exception using errcode = '55000', message = '0172: 0171 must be applied first';
  end if;
  if to_regclass('commercial.bills') is null or to_regclass('commercial.bill_lines') is null
     or to_regclass('commercial.payments') is null or to_regclass('commercial.number_counters') is null
     or to_regclass('commercial.catalogue_items') is null or to_regclass('commercial.catalogue_item_prices') is null
     or to_regclass('commercial.payment_settings') is null or to_regclass('commercial.facility_hmos') is null
     or to_regclass('commercial.hmo_covers') is null then
    raise exception using errcode = '55000', message = '0172: BILL-1''s 0162-0167 must be applied first';
  end if;

  -- 0. The locks, NOWAIT.
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table commercial.bills, commercial.bill_lines, commercial.payments, commercial.number_counters
    in access exclusive mode nowait;
  lock table ehr.admissions, ehr.wards, commercial.catalogue_items, identity.facilities,
    identity.staff_facility_memberships in share row exclusive mode nowait;
  lock table audit.events in row exclusive mode nowait;
  lock table commercial.payment_settings, commercial.catalogue_item_prices, commercial.facility_hmos,
    commercial.hmo_covers, ehr.admission_movements, ehr.visit_queue, identity.patients
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0172: the bills, bill lines, payments, number counters, admissions, wards, price list or '
          || 'audit.events is busy, and this transaction already holds an earlier migration''s locks, so it does '
          || 'not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0172: the bills, bill lines, payments, number counters, admissions, wards, price list or '
          || 'audit.events stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regclass('ehr.admissions') is null or to_regprocedure('ehr.admission_discharge(uuid, bigint, text, timestamptz, jsonb, text, timestamptz, text, text, text)') is null then
    raise exception using errcode = '55000', message = '0172: 0171 must be applied first';
  end if;
  if to_regclass('commercial.bills') is null or to_regclass('commercial.payment_settings') is null
     or to_regclass('commercial.till_days') is null or to_regprocedure('commercial.hook_facility(uuid)') is null then
    raise exception using errcode = '55000', message = '0172: BILL-1''s 0162-0167 must be applied first';
  end if;
  select count(*) into v_present
    from (values (to_regclass('commercial.ward_charge_items')::oid), (to_regclass('commercial.bed_day_charges')::oid),
                 (to_regprocedure('commercial.interim_statement(uuid)')::oid),
                 ((select attribute_row.attrelid::oid from pg_attribute attribute_row
                    where attribute_row.attrelid = 'commercial.bills'::regclass
                      and attribute_row.attname = 'admission_id' and not attribute_row.attisdropped)),
                 ((select trigger_row.oid from pg_trigger trigger_row
                    where trigger_row.tgrelid = 'ehr.admissions'::regclass
                      and trigger_row.tgname = 'zz_billing_admission_open')))
         present(object_id)
   where present.object_id is not null;
  if v_present = 5 then
    raise exception using errcode = '55000', message = '0172: already applied';
  end if;
  if v_present <> 0 then
    raise exception using errcode = '55000',
      message = '0172: the schema is not in the reviewed state (part of 0172 is there); nothing applied';
  end if;
  -- BILL-1's bodies this file replaces (B8), as BILL-1 left them at claude/sprint-billing-backend bd427a88, and the
  -- BILL-1 (and 0059) bodies the new and replaced bodies call: a changed body there means this file was written
  -- against another BILL-1 and must be re-read first.
  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('commercial.bill_for_work(uuid,uuid,text)', 'ef364a4d5104462ccbdca575302b55a4'),
      ('commercial.payment_record(uuid,jsonb,bigint,text,text)', '6f90a43b811f4094dd5d65523d40937d'),
      ('commercial.bill_recompute(uuid)', '628ee7944cccea79e71e6ea7f8fbf978'),
      ('commercial.bill_totals_agree(uuid)', 'ec44041889c9f4c4a7fdd6096cd01624'),
      ('commercial.bill_json(uuid)', '9ae0582dc8a30c815c02aa6c0cd0aee8'),
      ('commercial.audit(text,text,text,text,uuid,jsonb,text)', 'b24a13358027789773a38c7ff2ffc278'),
      ('commercial.bill_event(uuid,uuid,text,uuid,jsonb)', '96ab26ee8e6ef1706820d0fb8d2af7ba'),
      ('commercial.bill_lock(uuid,uuid,bigint)', '10056a5864f81b6310e3acd35dfad566'),
      ('commercial.bill_new(uuid,text,uuid,uuid,text,boolean,uuid,text,text)', '1339a9c111a6fa972c9c87397750660c'),
      ('commercial.bill_sums(uuid)', 'c6fd7055dfa3c85b0dfe77c285484fcd'),
      ('commercial.caller(text)', '16752b295365f4e33ed9119f55c2175f'),
      ('commercial.command_record(text,text,text,uuid)', '84e04cc81ba491a39773741ce8e26274'),
      ('commercial.command_replay(text,text,text)', 'e7c1ff69e15ec0ca75b1c624355d163a'),
      ('commercial.counter_staff_only(uuid)', '9352cab0a5c41b0c964aa989bc7cc117'),
      ('commercial.day_scope(uuid,uuid,uuid)', '8566e0d7bac1aad56398e605c5e4371c'),
      ('commercial.holds(text)', '4ee831ae9d72455e1cdeb1d4661aac69'),
      ('commercial.hook_facility(uuid)', '4efd0ae0c3c4ad8ce694a74b223cafa5'),
      ('commercial.lagos_day(timestamp with time zone)', '08620d6c3114df8123f496d76238763f'),
      ('commercial.member_name(uuid)', '50f7c6db29a6b99ee94973b373ed57cd'),
      ('commercial.next_number(uuid,text,integer)', 'a5a509b5c4943d9ff9055568c8de6da8'),
      ('commercial.open_day_locked(uuid,text,uuid,uuid)', '5016c4e0b55e28efa2c80c1d09fc91c5'),
      ('commercial.patient_card(uuid)', 'b51e6a898739b4219696ccedca1877ec'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0172: these bodies are not as BILL-1 left them: ' || v_mismatch;
  end if;
  -- The three value-list CHECKs: each a plain list of text values (column = ANY (ARRAY[...])) holding every one of
  -- BILL-1's values and none of this file's; values another lane added are kept by the swap below.
  for v_check in select item->>'relation' as relation, item->>'name' as name, item->>'column' as column_name,
                        array(select jsonb_array_elements_text(item->'required')) as required,
                        array(select jsonb_array_elements_text(item->'added')) as added
                   from jsonb_array_elements(v_lists) item loop
    select pg_get_constraintdef(constraint_row.oid) into v_found_def from pg_constraint constraint_row
     where constraint_row.conrelid = v_check.relation::regclass and constraint_row.conname = v_check.name
       and constraint_row.contype = 'c' and constraint_row.convalidated;
    select coalesce(array_agg(found.value[1] order by found.ord), array[]::text[]) into v_found
      from regexp_matches(coalesce(v_found_def, ''), '''([a-z_]+)''::text', 'g') with ordinality found(value, ord);
    if v_found_def is null
       or v_found_def is distinct from format('CHECK ((%s = ANY (ARRAY[%s])))', v_check.column_name,
            (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
               from unnest(v_found) with ordinality listed(value, ord)))
       or not (v_found @> v_check.required) or v_found && v_check.added
       or cardinality(v_found) <> (select count(distinct value) from unnest(v_found) value) then
      raise exception using errcode = '55000', message = '0172: this CHECK is not as BILL-1 left it (with any value '
        || 'another lane added): ' || v_check.relation || '.' || v_check.name;
    end if;
    v_found_lists := v_found_lists || jsonb_build_object(v_check.name, to_jsonb(v_found));
  end loop;
  -- The two expression CHECKs, exactly BILL-1's.
  select string_agg(expected.name, ', ') into v_mismatch
    from (values ('bills_source_ck', v_source_ck_bill1), ('bills_over_ck', v_over_ck_bill1)) expected(name, definition)
   where (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
           where constraint_row.conrelid = 'commercial.bills'::regclass and constraint_row.conname = expected.name
             and constraint_row.contype = 'c' and constraint_row.convalidated)
         is distinct from expected.definition;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0172: these CHECKs are not as BILL-1 left them: ' || v_mismatch;
  end if;
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'commercial.bill_for_work(uuid,uuid,text)'::regprocedure);
  -- The rows of audit.events, commercial.bills, commercial.bill_lines, commercial.payments, commercial.number_counters
  -- this file must not write: this transaction's own row counters for each (inserted/updated/deleted), taken here and
  -- compared in the post-checks. They cost nothing; a count or a snapshot of the rows would read whole tables under
  -- this file's locks.
  select string_agg(format('%s %s/%s/%s', watched.relation, pg_stat_get_xact_tuples_inserted(watched.relation),
           pg_stat_get_xact_tuples_updated(watched.relation), pg_stat_get_xact_tuples_deleted(watched.relation)),
           ', ' order by watched.ord)
    into v_writes_before
    from unnest(array['audit.events', 'commercial.bills', 'commercial.bill_lines', 'commercial.payments',
                        'commercial.number_counters']::regclass[]) with ordinality watched(relation, ord);

  -- B1-B4.
  alter table commercial.bills
    add column admission_id uuid references ehr.admissions(id) on delete restrict,
    add column credit_kobo bigint not null default 0 check (credit_kobo >= 0),
    drop constraint bills_source_ck,
    add constraint bills_source_ck check ((source = 'visit') = (visit_queue_entry_id is not null)
      and (source = 'admission') = (admission_id is not null)),
    -- BILL-1's money over (collected beyond the total: the patient's money first, then cover) stays for every other
    -- bill; on an admission bill it is the bill's credit instead (a deposit beyond what is due), never a refund due
    -- or cover over the bill, and no other bill holds a credit.
    drop constraint bills_over_ck,
    add constraint bills_over_ck check (
      (source = 'admission' and refund_due_kobo = 0 and cover_over_kobo = 0
       and credit_kobo = greatest(paid_kobo + pending_check_kobo + waived_kobo + hmo_covered_kobo - total_kobo, 0))
      or (source <> 'admission' and credit_kobo = 0
          and refund_due_kobo = least(greatest(paid_kobo + pending_check_kobo + waived_kobo + hmo_covered_kobo
                                               - total_kobo, 0), paid_kobo + pending_check_kobo)
          and cover_over_kobo = greatest(paid_kobo + pending_check_kobo + waived_kobo + hmo_covered_kobo - total_kobo, 0)
                                - refund_due_kobo));
  create unique index bills_one_per_admission_uq on commercial.bills (admission_id)
    where admission_id is not null and status <> 'void';
  -- The three value-list CHECKs: the values found (BILL-1's and any another lane added) plus this file's.
  for v_check in select item->>'relation' as relation, item->>'name' as name, item->>'column' as column_name,
                        array(select jsonb_array_elements_text(item->'added')) as added
                   from jsonb_array_elements(v_lists) item loop
    execute format('alter table %s drop constraint %I, add constraint %I check (%I in (%s))', v_check.relation,
      v_check.name, v_check.name, v_check.column_name,
      (select string_agg(quote_literal(value), ', ' order by ord)
         from unnest(array(select jsonb_array_elements_text(v_found_lists->v_check.name)) || v_check.added)
              with ordinality listed(value, ord)));
  end loop;
  alter table commercial.payments
    add column kind text not null default 'payment' check (kind in ('payment', 'deposit'));

  -- B5, B6.
  create table commercial.ward_charge_items (
    ward_id uuid primary key references ehr.wards(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    bed_day_item_id uuid,
    admission_fee_item_id uuid,
    row_version bigint not null default 1 check (row_version > 0),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    foreign key (bed_day_item_id, facility_id) references commercial.catalogue_items (id, facility_id) on delete restrict,
    foreign key (admission_fee_item_id, facility_id) references commercial.catalogue_items (id, facility_id)
      on delete restrict
  );
  create table commercial.bed_day_charges (
    admission_id uuid not null references ehr.admissions(id) on delete restrict,
    census_day date not null,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    ward_id uuid not null references ehr.wards(id) on delete restrict,
    bill_line_id uuid not null references commercial.bill_lines(id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    primary key (admission_id, census_day)
  );
  foreach v_target in array array['commercial.ward_charge_items', 'commercial.bed_day_charges'] loop
    execute format('alter table %s enable row level security', v_target);
    execute format('alter table %s force row level security', v_target);
    execute format('create policy facility_owner_rows on %s for all using (current_user = %L and facility_id = '
      || 'platform.current_facility_id()) with check (current_user = %L and facility_id = platform.current_facility_id())',
      v_target, v_owner, v_owner);
    execute format('revoke all on %s from public', v_target);
  end loop;

  -- B8. BILL-1's five bodies, replaced.
  create or replace function commercial.bill_recompute(requested_bill uuid)
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
    credit bigint;
  begin
    select * into sums from commercial.bill_sums(requested_bill);
    select bill_row.* into bill from commercial.bills bill_row where bill_row.id = requested_bill;
    -- 0172 (ADT-1): on an admission bill a deposit may be more than what is due; what was collected beyond the total
    -- is the bill's credit, never a refund due or cover over the bill. Any other bill holds no credit.
    credit := case when bill.source = 'admission'
                   then greatest(sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo + sums.hmo_covered_kobo
                     - sums.total_kobo, 0)
                   else 0 end;
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
           refund_due_kobo = case when bill.source = 'admission' then 0 else refund end,
           cover_over_kobo = case when bill.source = 'admission' then 0 else over - refund end,
           credit_kobo = credit, status = status_value, row_version = bill_row.row_version + 1, updated_at = clock_timestamp()
     where bill_row.id = requested_bill;
  end
  $$;

  create or replace function commercial.bill_totals_agree(requested_bill uuid)
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
                        and line.dispensing_reversed_at is not null)
            -- 0172 (ADT-1): a deposit on an admission bill may be more than what is due.
            or bill.source = 'admission')
       -- 0172 (ADT-1): on an admission bill what was collected beyond the total is its credit, never a refund due or
       -- cover over the bill; any other bill holds no credit.
       and bill.refund_due_kobo = case when bill.source = 'admission' then 0
             else least(greatest(sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo
               + sums.hmo_covered_kobo - sums.total_kobo, 0), sums.paid_kobo + sums.pending_check_kobo) end
       and bill.cover_over_kobo = case when bill.source = 'admission' then 0
             else greatest(sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo
               + sums.hmo_covered_kobo - sums.total_kobo, 0) - bill.refund_due_kobo end
       and bill.credit_kobo = case when bill.source = 'admission'
             then greatest(sums.paid_kobo + sums.pending_check_kobo + sums.waived_kobo
               + sums.hmo_covered_kobo - sums.total_kobo, 0) else 0 end
      from commercial.bills bill, commercial.bill_sums(bill.id) sums
     where bill.id = requested_bill
  $$;

  create or replace function commercial.bill_json(requested_bill uuid)
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
      -- 0172 (ADT-1, Q189 A): the admission bill's credit and stay.
      'creditKobo', bill.credit_kobo,
      'admission', case when bill.admission_id is null then null
                        else (select jsonb_build_object('admissionId', admission.id,
                                'admissionNumber', admission.admission_number, 'status', admission.status,
                                'dischargedWithBalance', admission.status = 'discharged' and bill.due_kobo > 0)
                                from ehr.admissions admission where admission.id = bill.admission_id) end,
      'payments', coalesce((select jsonb_agg(jsonb_build_object('id', payment.id, 'method', payment.method,
                  'amountKobo', payment.amount_kobo, 'kind', payment.kind, 'reference', payment.reference, 'hmoId', null,
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

  create or replace function commercial.bill_for_work(requested_facility uuid, requested_patient uuid, source_value text)
  returns uuid
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    entry_value uuid;
    bill_id uuid;
  begin
    -- 0172 (ADT-1, Q173 A): work for a patient with an open admission here goes on the admission bill.
    select bill.id into bill_id
      from commercial.bills bill
      join ehr.admissions admission on admission.id = bill.admission_id
     where bill.facility_id = requested_facility and admission.facility_id = requested_facility
       and admission.patient_id = requested_patient
       and admission.status in ('requested', 'admitted', 'discharge_ready') and bill.status <> 'void'
     for update of bill;
    if bill_id is not null then
      return bill_id;
    end if;
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

  create or replace function commercial.payment_record(requested_bill uuid, requested jsonb, expected_version bigint,
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
    settings commercial.payment_settings%rowtype;
    method_value text := requested->>'method';
    amount bigint;
    reference_value text := nullif(btrim(coalesce(requested->>'reference', '')), '');
    reason_value text := nullif(btrim(coalesce(requested->>'reason', '')), '');
    paper_value text := nullif(btrim(coalesce(requested->>'paperReceiptNumber', '')), '');
    till_value uuid;
    hmo_value uuid;
    scope_row record;
    day_id uuid;
    year_value integer := extract(year from (clock_timestamp() at time zone 'Africa/Lagos'))::integer;
    receipt text;
    payment_id uuid;
    cover_id uuid;
    -- 0172 (ADT-1, Q-ADT-14 A): a deposit on an admission bill while the stay is open.
    kind_value text := coalesce(requested->>'kind', 'payment');
  begin
    select * into actor from commercial.caller('billing.payment.record');
    select * into replay from commercial.command_replay(requested_key, requested_sha256, 'payment.record');
    if replay.replayed then
      return commercial.bill_json(replay.resource_id) || jsonb_build_object('replayed', true);
    end if;
    if jsonb_typeof(requested) <> 'object' or method_value is null
       or method_value not in ('cash', 'pos', 'transfer', 'waiver', 'hmo')
       or jsonb_typeof(requested->'amountKobo') <> 'number'
       or (requested->>'amountKobo')::numeric <> trunc((requested->>'amountKobo')::numeric)
       or (requested->>'amountKobo')::numeric not between 1 and 1000000000 then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "amountKobo"}';
    end if;
    amount := (requested->>'amountKobo')::numeric::bigint;
    if kind_value not in ('payment', 'deposit') or (kind_value = 'deposit' and method_value in ('waiver', 'hmo')) then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "kind"}';
    end if;
    if requested->>'tillId' is not null then
      if requested->>'tillId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "tillId"}';
      end if;
      till_value := (requested->>'tillId')::uuid;
    end if;
    if paper_value is not null and char_length(paper_value) > 30 then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "paperReceiptNumber"}';
    end if;
    case method_value
      when 'cash' then
        if reference_value is not null or reason_value is not null then
          raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reference"}';
        end if;
      when 'pos' then
        if reference_value is null or reference_value !~ '^[A-Za-z0-9]{6,20}$' then
          raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reference"}';
        end if;
      when 'transfer' then
        if reference_value is null or char_length(reference_value) not between 4 and 60 then
          raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reference"}';
        end if;
      when 'waiver' then
        if reason_value is null or char_length(reason_value) not between 8 and 500 then
          raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reason"}';
        end if;
        if not commercial.holds('billing.payment.waive') then
          raise exception using errcode = 'HB403', message = 'BILLING_NOT_ALLOWED';
        end if;
      when 'hmo' then
        if reference_value is null or char_length(reference_value) not between 3 and 60
           or coalesce(requested->>'hmoId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "hmoId"}';
        end if;
        hmo_value := (requested->>'hmoId')::uuid;
    end case;
    select payment_settings.* into settings from commercial.payment_settings payment_settings
     where payment_settings.facility_id = actor.facility_id;
    if not (method_value = any (coalesce(settings.methods, array['cash', 'pos', 'transfer']))) then
      raise exception using errcode = 'HB409', message = 'PAYMENT_METHOD_NOT_ACCEPTED';
    end if;
    if coalesce(settings.where_paid, 'cashier') = 'cashier' and commercial.counter_staff_only(actor.membership_id) then
      raise exception using errcode = 'HB403', message = 'PAYMENT_AT_CASHIER_ONLY';
    end if;
    if hmo_value is not null and not exists (select 1 from commercial.facility_hmos hmo
                                              where hmo.id = hmo_value and hmo.facility_id = actor.facility_id and hmo.active) then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "hmoId"}';
    end if;
    bill := commercial.bill_lock(requested_bill, actor.facility_id, expected_version);
    if bill.voided_at is not null or bill.status = 'void' then
      raise exception using errcode = 'HB409', message = 'BILL_VOID';
    end if;
    if kind_value = 'deposit'
       and (bill.source <> 'admission'
            or not exists (select 1 from ehr.admissions admission
                            where admission.id = bill.admission_id
                              and admission.status in ('requested', 'admitted', 'discharge_ready'))) then
      raise exception using errcode = 'HB409', message = 'DEPOSIT_NOT_ALLOWED';
    end if;
    if amount > bill.due_kobo and kind_value <> 'deposit' then
      raise exception using errcode = 'HB409', message = 'OVERPAYMENT';
    end if;
    -- The day it is taken in: the open day of the member's scope. A waiver is
    -- listed in that day when there is one, and needs none; HMO cover none.
    if method_value <> 'hmo' then
      begin
        select * into scope_row from commercial.day_scope(actor.facility_id, actor.membership_id, till_value);
        day_id := commercial.open_day_locked(actor.facility_id, scope_row.scope, scope_row.membership_id,
          scope_row.till_id);
      exception when sqlstate 'HB400' then
        if method_value <> 'waiver' then raise; end if;
      end;
      if day_id is null and method_value <> 'waiver' then
        raise exception using errcode = 'HB409', message = 'TILL_DAY_NOT_OPEN';
      end if;
    end if;

    if method_value = 'hmo' then
      insert into commercial.hmo_covers (facility_id, bill_id, hmo_id, amount_kobo, approval_code,
        recorded_by_membership_id, idempotency_key, request_sha256)
      values (actor.facility_id, bill.id, hmo_value, amount, reference_value, actor.membership_id, requested_key,
        requested_sha256)
      returning id into cover_id;
      perform commercial.bill_recompute(bill.id);
      perform commercial.bill_event(bill.id, bill.facility_id, 'hmo-cover', actor.membership_id,
        jsonb_build_object('coverId', cover_id, 'amountKobo', amount));
      perform commercial.command_record(requested_key, requested_sha256, 'payment.record', bill.id);
      perform commercial.audit('commercial.hmo-cover.record', 'success', 'hmo-cover', cover_id::text, bill.patient_id,
        jsonb_build_object('billId', bill.id, 'hmoId', hmo_value, 'amountKobo', amount), 'ehr-api');
      return commercial.bill_json(bill.id);
    end if;

    -- Six digits at least, all of them past 999999 (never cut to six, which would repeat a number).
    receipt := 'R-' || year_value::text || '-' || (select lpad(numbered.n::text, greatest(6, length(numbered.n::text)), '0')
      from (select commercial.next_number(actor.facility_id, 'receipt', year_value) as n) numbered);
    insert into commercial.payments (facility_id, bill_id, method, kind, amount_kobo, reference, reason, status,
      receipt_number, till_day_id, paper_receipt_number, received_by_membership_id, idempotency_key, request_sha256)
    values (actor.facility_id, bill.id, method_value, kind_value, amount, reference_value,
      case when method_value = 'waiver' then reason_value end,
      case when method_value = 'transfer' then 'pending_check' else 'recorded' end, receipt, day_id, paper_value,
      actor.membership_id, requested_key, requested_sha256)
    returning id into payment_id;
    perform commercial.bill_recompute(bill.id);
    perform commercial.bill_event(bill.id, bill.facility_id, 'payment', actor.membership_id,
      jsonb_build_object('paymentId', payment_id, 'method', method_value, 'amountKobo', amount));
    perform commercial.command_record(requested_key, requested_sha256, 'payment.record', bill.id);
    perform commercial.audit('commercial.payment.record', 'success', 'payment', payment_id::text, bill.patient_id,
      jsonb_build_object('billId', bill.id, 'method', method_value, 'kind', kind_value, 'amountKobo', amount,
        'status', case when method_value = 'transfer' then 'pending_check' else 'recorded' end,
        'tillDayId', day_id, 'paperReceipt', paper_value is not null), 'ehr-api');
    return commercial.bill_json(bill.id);
  end
  $$;

  -- B3's guard: a deposit only on an admission bill.
  create function commercial.payments_deposit_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
  begin
    if new.kind = 'deposit' and not exists (select 1 from commercial.bills bill
                                             where bill.id = new.bill_id and bill.source = 'admission') then
      raise exception using errcode = 'HB409', message = 'DEPOSIT_NOT_ALLOWED';
    end if;
    return new;
  end
  $$;
  revoke all on function commercial.payments_deposit_guard() from public;
  create trigger payments_deposit_guard before insert or update of kind on commercial.payments
    for each row execute function commercial.payments_deposit_guard();

  -- B7. Helpers.
  -- Opens the admission's bill (source admission, one per admission), when the facility uses billing.
  create function commercial.admission_bill_open(requested_admission uuid)
  returns uuid
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    admission_row ehr.admissions%rowtype;
    settings commercial.payment_settings%rowtype;
    bill_value uuid;
  begin
    select admission.* into admission_row from ehr.admissions admission where admission.id = requested_admission;
    select settings_row.* into settings from commercial.payment_settings settings_row
     where settings_row.facility_id = admission_row.facility_id;
    if not found then
      return null;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('commercial-admission-bill:' || requested_admission::text, 0));
    select bill.id into bill_value from commercial.bills bill
     where bill.admission_id = requested_admission and bill.status <> 'void';
    if bill_value is not null then
      return bill_value;
    end if;
    insert into commercial.bills (facility_id, number, source, patient_id, admission_id, created_by_membership_id)
    values (admission_row.facility_id,
      -- Six digits at least, all of them past 999999 (as BILL-1's bill_new: never cut to six).
      'B-' || (select lpad(numbered.n::text, greatest(6, length(numbered.n::text)), '0')
                 from (select commercial.next_number(admission_row.facility_id, 'bill', 0) as n) numbered), 'admission',
      admission_row.patient_id, admission_row.id, null)
    returning id into bill_value;
    insert into commercial.bill_events (facility_id, bill_id, kind, membership_id, details)
    values (admission_row.facility_id, bill_value, 'create', null,
      jsonb_build_object('source', 'admission', 'admissionId', admission_row.id));
    perform commercial.audit('commercial.bill.create', 'success', 'bill', bill_value::text, admission_row.patient_id,
      jsonb_build_object('source', 'admission', 'counter', false, 'by', 'system', 'admissionId', admission_row.id),
      'hid-billing');
    if 'inpatient' = any (settings.allow_deferred_for) then
      update commercial.bills bill
         set deferred_reason = 'inpatient', deferred_by = 'system', deferred_at = clock_timestamp()
       where bill.id = bill_value;
      perform commercial.bill_recompute(bill_value);
      insert into commercial.bill_events (facility_id, bill_id, kind, membership_id, details)
      values (admission_row.facility_id, bill_value, 'defer', null, jsonb_build_object('reason', 'inpatient', 'by', 'system'));
      perform commercial.audit('commercial.bill.defer', 'success', 'bill', bill_value::text, admission_row.patient_id,
        jsonb_build_object('reason', 'inpatient', 'by', 'system'), 'hid-billing');
    end if;
    return bill_value;
  end
  $$;
  revoke all on function commercial.admission_bill_open(uuid) from public;

  -- One line on the admission bill at the item's cash price now, with its own name (BILL-15).
  create function commercial.admission_line_put(requested_bill uuid, requested_item uuid, origin_value text,
    name_value text)
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
    select bill_row.* into bill from commercial.bills bill_row where bill_row.id = requested_bill for update;
    select catalogue_item.* into item from commercial.catalogue_items catalogue_item
     where catalogue_item.id = requested_item and catalogue_item.facility_id = bill.facility_id and catalogue_item.active;
    if not found or bill.status = 'void' then
      return null;
    end if;
    select price_row.amount_kobo into price from commercial.catalogue_item_prices price_row
     where price_row.catalogue_item_id = item.id and price_row.hmo_id is null;
    insert into commercial.bill_lines (facility_id, bill_id, catalogue_item_id, name, kind, quantity, unit_kobo,
      total_kobo, origin)
    values (bill.facility_id, bill.id, item.id, left(name_value, 200), item.kind, 1, coalesce(price, 0),
      coalesce(price, 0), origin_value)
    returning id into line_id;
    perform commercial.bill_recompute(bill.id);
    insert into commercial.bill_events (facility_id, bill_id, kind, membership_id, details)
    values (bill.facility_id, bill.id, 'line-add', null,
      jsonb_build_object('lineId', line_id, 'origin', origin_value, 'quantity', 1, 'unitKobo', coalesce(price, 0)));
    perform commercial.audit('commercial.bill.line-add', 'success', 'bill', bill.id::text, bill.patient_id,
      jsonb_build_object('lineId', line_id, 'origin', origin_value, 'quantity', 1, 'unitKobo', coalesce(price, 0),
        'by', 'system'), 'hid-billing');
    return line_id;
  end
  $$;
  revoke all on function commercial.admission_line_put(uuid, uuid, text, text) from public;

  -- The admission fee, once, when the bed is given (the ward's admission-fee item).
  create function commercial.admission_fee_add(requested_admission uuid)
  returns uuid
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    admission_row ehr.admissions%rowtype;
    bill_value uuid;
    item_id uuid;
  begin
    select admission.* into admission_row from ehr.admissions admission where admission.id = requested_admission;
    select bill.id into bill_value from commercial.bills bill
     where bill.admission_id = requested_admission and bill.status <> 'void';
    select charge.admission_fee_item_id into item_id from commercial.ward_charge_items charge
     where charge.ward_id = admission_row.ward_id;
    if bill_value is null or item_id is null
       or exists (select 1 from commercial.bill_lines line where line.bill_id = bill_value and line.origin = 'admission'
                   and not line.cancelled) then
      return null;
    end if;
    return commercial.admission_line_put(bill_value, item_id, 'admission',
      'Admission fee: ' || (select ward.name from ehr.wards ward where ward.id = admission_row.ward_id));
  end
  $$;
  revoke all on function commercial.admission_fee_add(uuid) from public;

  -- Q-ADT-13 A: one bed-day per Lagos midnight the patient is admitted, at the rate of the ward they are in at that
  -- midnight (named for the day that midnight ends); a finished stay with no midnight counts one day (its admission
  -- day); the day of discharge is not charged. Never twice for one day (the key of bed_day_charges, under a lock
  -- per admission). A ward with no bed-day item adds nothing.
  create function commercial.accrue_bed_days(requested_admission uuid)
  returns integer
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    admission_row ehr.admissions%rowtype;
    bill_value uuid;
    stay_end timestamptz;
    midnight timestamptz;
    day_value date;
    ward_value uuid;
    item_id uuid;
    line_id uuid;
    added integer := 0;
  begin
    select admission.* into admission_row from ehr.admissions admission where admission.id = requested_admission;
    if admission_row.admitted_at is null or admission_row.facility_id is distinct from platform.current_facility_id() then
      return 0;
    end if;
    select bill.id into bill_value from commercial.bills bill
     where bill.admission_id = requested_admission and bill.status <> 'void';
    if bill_value is null then
      return 0;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('commercial-bed-days:' || requested_admission::text, 0));
    stay_end := coalesce(admission_row.discharged_at, clock_timestamp());
    for midnight in
      select (day_start::timestamp at time zone 'Africa/Lagos')
        from generate_series((admission_row.admitted_at at time zone 'Africa/Lagos')::date + 1,
                             (stay_end at time zone 'Africa/Lagos')::date, interval '1 day') day_start
       where (day_start::timestamp at time zone 'Africa/Lagos') > admission_row.admitted_at
         and (day_start::timestamp at time zone 'Africa/Lagos') <= stay_end
    loop
      day_value := (midnight at time zone 'Africa/Lagos')::date - 1;
      select movement.to_ward_id into ward_value from ehr.admission_movements movement
       where movement.admission_id = requested_admission and movement.kind in ('admitted', 'transferred')
         and movement.at < midnight
       order by movement.sequence_no desc limit 1;
      if ward_value is null or exists (select 1 from commercial.bed_day_charges charge
                                        where charge.admission_id = requested_admission
                                          and charge.census_day = day_value) then
        continue;
      end if;
      select charge.bed_day_item_id into item_id from commercial.ward_charge_items charge
       where charge.ward_id = ward_value;
      if item_id is null then
        continue;
      end if;
      line_id := commercial.admission_line_put(bill_value, item_id, 'bed_day',
        'Bed-day: ' || (select ward.name from ehr.wards ward where ward.id = ward_value) || ' ('
        || to_char(day_value, 'FMDD Mon YYYY') || ')');
      if line_id is not null then
        insert into commercial.bed_day_charges (admission_id, census_day, facility_id, ward_id, bill_line_id)
        values (requested_admission, day_value, admission_row.facility_id, ward_value, line_id);
        perform commercial.audit('commercial.bed-day.add', 'success', 'bill', bill_value::text, admission_row.patient_id,
          jsonb_build_object('admissionId', requested_admission, 'censusDay', day_value, 'wardId', ward_value,
            'lineId', line_id, 'by', 'system'), 'hid-billing');
        added := added + 1;
      end if;
    end loop;
    -- A finished stay with no midnight counts one day.
    if admission_row.status = 'discharged'
       and (admission_row.admitted_at at time zone 'Africa/Lagos')::date
           = (admission_row.discharged_at at time zone 'Africa/Lagos')::date
       and not exists (select 1 from commercial.bed_day_charges charge
                        where charge.admission_id = requested_admission) then
      day_value := (admission_row.admitted_at at time zone 'Africa/Lagos')::date;
      select movement.to_ward_id into ward_value from ehr.admission_movements movement
       where movement.admission_id = requested_admission and movement.kind in ('admitted', 'transferred')
       order by movement.sequence_no desc limit 1;
      select charge.bed_day_item_id into item_id from commercial.ward_charge_items charge
       where charge.ward_id = ward_value;
      if item_id is not null then
        line_id := commercial.admission_line_put(bill_value, item_id, 'bed_day',
          'Bed-day: ' || (select ward.name from ehr.wards ward where ward.id = ward_value) || ' ('
          || to_char(day_value, 'FMDD Mon YYYY') || ')');
        if line_id is not null then
          insert into commercial.bed_day_charges (admission_id, census_day, facility_id, ward_id, bill_line_id)
          values (requested_admission, day_value, admission_row.facility_id, ward_value, line_id);
          perform commercial.audit('commercial.bed-day.add', 'success', 'bill', bill_value::text,
            admission_row.patient_id, jsonb_build_object('admissionId', requested_admission, 'censusDay', day_value,
              'wardId', ward_value, 'lineId', line_id, 'by', 'system', 'noMidnight', true), 'hid-billing');
          added := added + 1;
        end if;
      end if;
    end if;
    return added;
  end
  $$;
  revoke all on function commercial.accrue_bed_days(uuid) from public;

  -- The hourly sweep: bed-days for every open admission of one facility (null: every facility with an open
  -- admission and payment settings, each under its own facility context, for the system sweep only).
  create function commercial.accrue_bed_days_due(requested_facility uuid)
  returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    facility_value uuid;
    admission_value uuid;
    added integer := 0;
  begin
    if requested_facility is null and (platform.current_membership_id() is not null
                                       or platform.current_actor_subject() is distinct from 'system:auth') then
      raise exception using errcode = 'HB403', message = 'BILLING_NOT_ALLOWED';
    end if;
    if requested_facility is not null
       and (select caller_row.facility_id from commercial.caller('billing.bill.read') caller_row)
           is distinct from requested_facility then
      raise exception using errcode = 'HB403', message = 'BILLING_NOT_ALLOWED';
    end if;
    for facility_value in
      select distinct admission.facility_id from ehr.admissions admission
       where admission.status in ('admitted', 'discharge_ready')
         and (requested_facility is null or admission.facility_id = requested_facility)
       order by 1
    loop
      if requested_facility is null then
        perform set_config('app.facility_id', facility_value::text, true);
      end if;
      if not exists (select 1 from commercial.payment_settings settings where settings.facility_id = facility_value) then
        continue;
      end if;
      for admission_value in
        select admission.id from ehr.admissions admission
         where admission.facility_id = facility_value and admission.status in ('admitted', 'discharge_ready')
         order by admission.id
      loop
        added := added + commercial.accrue_bed_days(admission_value);
      end loop;
    end loop;
    if requested_facility is null then
      perform set_config('app.facility_id', '', true);
    end if;
    return added;
  end
  $$;
  comment on function commercial.accrue_bed_days_due(uuid) is
    '0172 (ADT-1, Q-ADT-13 A): the hourly sweep: the bed-days due for every open admission (of one facility, as a billing reader there, or with null of every facility, only for ehr-api''s system sweep). A bed-day is never added twice.';
  revoke all on function commercial.accrue_bed_days_due(uuid) from public;

  -- Route: PUT /commercial/ward-charges/:wardId.
  create function commercial.ward_charges_set(requested_ward uuid, expected_version bigint, bed_day_item uuid,
    admission_fee_item uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    actor record;
    current_row commercial.ward_charge_items%rowtype;
  begin
    select * into actor from commercial.caller('billing.catalogue.manage');
    if not exists (select 1 from ehr.wards ward where ward.id = requested_ward and ward.facility_id = actor.facility_id) then
      raise exception using errcode = 'HB404', message = 'WARD_NOT_FOUND';
    end if;
    if exists (select 1 from unnest(array[bed_day_item, admission_fee_item]) item
                where item is not null and not exists (
                  select 1 from commercial.catalogue_items catalogue_item
                   where catalogue_item.id = item and catalogue_item.facility_id = actor.facility_id
                     and catalogue_item.active and catalogue_item.kind = 'other')) then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "bedDayItemId"}';
    end if;
    select charge.* into current_row from commercial.ward_charge_items charge
     where charge.ward_id = requested_ward for update;
    if (current_row.ward_id is null and coalesce(expected_version, 0) <> 0)
       or (current_row.ward_id is not null and expected_version is distinct from current_row.row_version) then
      raise exception using errcode = 'HB412', message = 'VERSION_CONFLICT';
    end if;
    insert into commercial.ward_charge_items (ward_id, facility_id, bed_day_item_id, admission_fee_item_id,
      updated_by_membership_id)
    values (requested_ward, actor.facility_id, bed_day_item, admission_fee_item, actor.membership_id)
    on conflict (ward_id) do update
      set bed_day_item_id = excluded.bed_day_item_id, admission_fee_item_id = excluded.admission_fee_item_id,
          updated_by_membership_id = excluded.updated_by_membership_id, updated_at = clock_timestamp(),
          row_version = commercial.ward_charge_items.row_version + 1;
    perform commercial.audit('commercial.ward-charges.set', 'success', 'ward', requested_ward::text, null,
      jsonb_build_object('bedDayItemId', bed_day_item, 'admissionFeeItemId', admission_fee_item), 'ehr-api');
    return (select jsonb_build_object('wardId', charge.ward_id, 'bedDayItemId', charge.bed_day_item_id,
              'admissionFeeItemId', charge.admission_fee_item_id, 'version', charge.row_version)
              from commercial.ward_charge_items charge where charge.ward_id = requested_ward);
  end
  $$;
  revoke all on function commercial.ward_charges_set(uuid, bigint, uuid, uuid) from public;

  -- Route: GET /commercial/ward-charges.
  create function commercial.ward_charges_list()
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    actor record;
  begin
    select * into actor from commercial.caller('billing.catalogue.read');
    return jsonb_build_object('items', coalesce((
      select jsonb_agg(jsonb_build_object('wardId', ward.id, 'wardName', ward.name, 'wardType', ward.ward_type,
               'bedDayItemId', charge.bed_day_item_id, 'admissionFeeItemId', charge.admission_fee_item_id,
               'version', coalesce(charge.row_version, 0)) order by lower(ward.name), ward.id)
        from ehr.wards ward
        left join commercial.ward_charge_items charge on charge.ward_id = ward.id
       where ward.facility_id = actor.facility_id and ward.active), '[]'::jsonb));
  end
  $$;
  revoke all on function commercial.ward_charges_list() from public;

  -- Route: GET /commercial/bills/:billId/interim-statement (bed-days counted up to now, a number, audited).
  create function commercial.interim_statement(requested_bill uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    actor record;
    bill commercial.bills%rowtype;
    year_value integer := extract(year from (clock_timestamp() at time zone 'Africa/Lagos'))::integer;
    number_value text;
  begin
    select * into actor from commercial.caller('billing.bill.read');
    select bill_row.* into bill from commercial.bills bill_row
     where bill_row.id = requested_bill and bill_row.facility_id = actor.facility_id and bill_row.source = 'admission';
    if not found then
      raise exception using errcode = 'HB404', message = 'BILL_NOT_FOUND';
    end if;
    perform commercial.accrue_bed_days(bill.admission_id);
    -- Six digits at least, all of them past 999999 (never cut to six, which would repeat a number).
    number_value := 'I-' || year_value::text || '-'
      || (select lpad(numbered.n::text, greatest(6, length(numbered.n::text)), '0')
            from (select commercial.next_number(actor.facility_id, 'interim', year_value) as n) numbered);
    perform commercial.audit('commercial.interim-statement.print', 'success', 'bill', bill.id::text, bill.patient_id,
      jsonb_build_object('statementNumber', number_value), 'ehr-api');
    return commercial.bill_json(bill.id) || jsonb_build_object('statementNumber', number_value,
      'depositsKobo', (select coalesce(sum(payment.amount_kobo), 0) from commercial.payments payment
                        where payment.bill_id = bill.id and payment.kind = 'deposit' and payment.voided_at is null),
      'printedAt', clock_timestamp());
  end
  $$;
  revoke all on function commercial.interim_statement(uuid) from public;

  -- The admission bill of each given admission of this facility (the card's billId), for a ward member. Never a
  -- bill's content.
  create function commercial.admission_bill_ids(requested_admissions uuid[])
  returns table (admission_id uuid, bill_id uuid)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, pg_temp
  as $$
  #variable_conflict use_column
  begin
    if platform.current_membership_id() is null or platform.current_facility_id() is null
       or not exists (select 1 from identity.staff_facility_memberships membership
                       where membership.id = platform.current_membership_id()
                         and membership.facility_id = platform.current_facility_id() and membership.active
                         and membership.migration_hold_reason is null)
       or not coalesce(auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
                                                      platform.current_facility_id(), 'ehr.ward.read'), false) then
      raise exception using errcode = 'HB403', message = 'BILLING_NOT_ALLOWED';
    end if;
    return query select bill.admission_id, bill.id from commercial.bills bill
     where bill.admission_id = any (requested_admissions) and bill.facility_id = platform.current_facility_id()
       and bill.status <> 'void';
  end
  $$;
  revoke all on function commercial.admission_bill_ids(uuid[]) from public;

  -- B9. The hooks. Each swallows any billing error: no billing state can refuse or undo an admission step (Q189 A).
  create function commercial.hook_admission_open()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $$
  begin
    if not commercial.hook_facility(new.facility_id)
       or not exists (select 1 from commercial.payment_settings settings where settings.facility_id = new.facility_id) then
      return null;
    end if;
    begin
      perform commercial.admission_bill_open(new.id);
    exception when others then
      raise notice 'commercial: the admission bill was not opened (%); the admission goes ahead', sqlstate;
    end;
    return null;
  end
  $$;
  revoke all on function commercial.hook_admission_open() from public;
  create function commercial.hook_admission_status()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $$
  begin
    if new.status is not distinct from old.status or not commercial.hook_facility(new.facility_id)
       or not exists (select 1 from commercial.payment_settings settings where settings.facility_id = new.facility_id) then
      return null;
    end if;
    begin
      if old.status = 'requested' and new.status = 'admitted' then
        perform commercial.admission_fee_add(new.id);
      elsif new.status = 'discharged' then
        perform commercial.accrue_bed_days(new.id);
      end if;
    exception when others then
      raise notice 'commercial: an admission charge was not added (%); the admission goes ahead', sqlstate;
    end;
    return null;
  end
  $$;
  revoke all on function commercial.hook_admission_status() from public;
  create trigger zz_billing_admission_open after insert on ehr.admissions
    for each row execute function commercial.hook_admission_open();
  create trigger zz_billing_admission_status after update of status on ehr.admissions
    for each row execute function commercial.hook_admission_status();

  -- Owners and EXECUTE.
  if v_owner <> current_user then
    execute format('alter table commercial.ward_charge_items owner to %I', v_owner);
    execute format('alter table commercial.bed_day_charges owner to %I', v_owner);
    execute (select string_agg(format('alter function %s owner to %I', proc.oid::regprocedure, v_owner), '; ')
               from pg_proc proc where proc.oid in (
                 'commercial.payments_deposit_guard()'::regprocedure, 'commercial.admission_bill_open(uuid)'::regprocedure,
                 'commercial.admission_line_put(uuid,uuid,text,text)'::regprocedure,
                 'commercial.admission_fee_add(uuid)'::regprocedure, 'commercial.accrue_bed_days(uuid)'::regprocedure,
                 'commercial.accrue_bed_days_due(uuid)'::regprocedure,
                 'commercial.ward_charges_set(uuid,bigint,uuid,uuid)'::regprocedure,
                 'commercial.ward_charges_list()'::regprocedure, 'commercial.interim_statement(uuid)'::regprocedure,
                 'commercial.admission_bill_ids(uuid[])'::regprocedure,
                 'commercial.hook_admission_open()'::regprocedure, 'commercial.hook_admission_status()'::regprocedure));
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function commercial.accrue_bed_days_due(uuid), commercial.ward_charges_set(uuid, bigint, uuid, uuid),
      commercial.ward_charges_list(), commercial.interim_statement(uuid), commercial.admission_bill_ids(uuid[])
      to hid_ehr_runtime;
  end if;

  -- 3. Post-checks.
  -- No admission function reads the commercial schema (Q189 A).
  select string_agg(proc.proname, ', ') into v_mismatch
    from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
   where namespace.nspname = 'ehr' and proc.proname like 'admission\_%' and proc.prosrc ~* 'commercial';
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0172: post-check failed (an admission function reads the bill: '
      || v_mismatch || ')';
  end if;
  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('commercial.bill_for_work(uuid,uuid,text)', '4d0b477b431969fe565d7e85c21151a1'),
      ('commercial.payment_record(uuid,jsonb,bigint,text,text)', 'be5c48fa4a92c2a703709a1f6e6ccff3'),
      ('commercial.bill_recompute(uuid)', 'd8ac034327231a27be7e7d86365f229e'),
      ('commercial.bill_totals_agree(uuid)', '905a6b2d1013ea2dc224de61391cb02a'),
      ('commercial.bill_json(uuid)', 'ab73b8cf00a41a1fc37424d29f95813f')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0172: post-check failed (a replaced body): ' || v_mismatch;
  end if;
  if exists (select 1 from pg_class class_row,
                    lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
              where class_row.oid in ('commercial.ward_charge_items'::regclass, 'commercial.bed_day_charges'::regclass)
                and acl.grantee <> class_row.relowner)
     or (select count(*) from pg_class where oid in ('commercial.ward_charge_items'::regclass,
           'commercial.bed_day_charges'::regclass) and relrowsecurity and relforcerowsecurity) <> 2
     or (select count(*) from pg_trigger trigger_row
          where (trigger_row.tgrelid, trigger_row.tgname) in (
                  ('ehr.admissions'::regclass, 'zz_billing_admission_open'),
                  ('ehr.admissions'::regclass, 'zz_billing_admission_status'),
                  ('commercial.payments'::regclass, 'payments_deposit_guard'))
            and trigger_row.tgenabled = 'O') <> 3
     then
    raise exception using errcode = '55000', message = '0172: post-check failed (tables or triggers)';
  end if;

  -- Post-check, CHECKs: the three value lists are the values found plus this file's, validated; BILL-1's two expression
  -- CHECKs as replaced here (the source columns; money over, or an admission bill's credit), validated.
  for v_check in select item->>'relation' as relation, item->>'name' as name, item->>'column' as column_name,
                        array(select jsonb_array_elements_text(item->'added')) as added
                   from jsonb_array_elements(v_lists) item loop
    if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
         where constraint_row.conrelid = v_check.relation::regclass and constraint_row.conname = v_check.name
           and constraint_row.contype = 'c' and constraint_row.convalidated)
       is distinct from format('CHECK ((%s = ANY (ARRAY[%s])))', v_check.column_name,
         (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
            from unnest(array(select jsonb_array_elements_text(v_found_lists->v_check.name)) || v_check.added)
                 with ordinality listed(value, ord))) then
      raise exception using errcode = '55000',
        message = '0172: post-check failed (the CHECK ' || v_check.relation || '.' || v_check.name || ')';
    end if;
  end loop;
  select string_agg(expected.name, ', ') into v_post_mismatch
    from (values
      ('bills_source_ck', 'CHECK ((((source = ''visit''::text) = (visit_queue_entry_id IS NOT NULL)) AND '
         || '((source = ''admission''::text) = (admission_id IS NOT NULL))))'),
      ('bills_over_ck', 'CHECK ((((source = ''admission''::text) AND (refund_due_kobo = 0) AND (cover_over_kobo = 0) '
         || 'AND (credit_kobo = GREATEST(((((paid_kobo + pending_check_kobo) + waived_kobo) + hmo_covered_kobo) - '
         || 'total_kobo), (0)::bigint))) OR ((source <> ''admission''::text) AND (credit_kobo = 0) AND '
         || '(refund_due_kobo = LEAST(GREATEST(((((paid_kobo + pending_check_kobo) + waived_kobo) + hmo_covered_kobo) - '
         || 'total_kobo), (0)::bigint), (paid_kobo + pending_check_kobo))) AND (cover_over_kobo = '
         || '(GREATEST(((((paid_kobo + pending_check_kobo) + waived_kobo) + hmo_covered_kobo) - total_kobo), '
         || '(0)::bigint) - refund_due_kobo)))))'),
      ('bills_credit_kobo_check', 'CHECK ((credit_kobo >= 0))')
    ) expected(name, definition)
   where (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
           where constraint_row.conrelid = 'commercial.bills'::regclass and constraint_row.conname = expected.name
             and constraint_row.contype = 'c' and constraint_row.convalidated)
         is distinct from expected.definition;
  if v_post_mismatch is not null
     or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
          where constraint_row.conrelid = 'commercial.payments'::regclass and constraint_row.conname = 'payments_kind_check'
            and constraint_row.contype = 'c' and constraint_row.convalidated)
        is distinct from 'CHECK ((kind = ANY (ARRAY[''payment''::text, ''deposit''::text])))' then
    raise exception using errcode = '55000',
      message = '0172: post-check failed (the bills'' or payments'' CHECKs: ' || coalesce(v_post_mismatch, 'payments_kind_check') || ')';
  end if;
  -- Post-check, rows: no row of audit.events, commercial.bills, commercial.bill_lines, commercial.payments,
  -- commercial.number_counters written.
  if (select string_agg(format('%s %s/%s/%s', watched.relation, pg_stat_get_xact_tuples_inserted(watched.relation),
               pg_stat_get_xact_tuples_updated(watched.relation), pg_stat_get_xact_tuples_deleted(watched.relation)),
               ', ' order by watched.ord)
        from unnest(array['audit.events', 'commercial.bills', 'commercial.bill_lines', 'commercial.payments',
                            'commercial.number_counters']::regclass[]) with ordinality watched(relation, ord))
     is distinct from v_writes_before then
    raise exception using errcode = '55000', message = '0172: post-check failed (it wrote a row of a table '
      || 'it must not write; counters before: ' || v_writes_before || ')';
  end if;
  -- Post-check, triggers (0152's form). The 3 triggers this file makes, each by its table, name, events
  -- (pg_trigger.tgtype: 1 for each row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate), UPDATE OF columns
  -- (tgattr, '' for none) and function; with no WHEN condition, no arguments, enabled in origin mode, not internal,
  -- not a constraint trigger and with no transition table (a WHEN condition or an UPDATE OF list leaves tgtype as it
  -- is, so each is held apart).
  -- No other trigger on the 2 tables this file makes (they hold 0).
  if (select count(*)
        from (values
      ('commercial.payments', 'payments_deposit_guard', 23, 'commercial.payments_deposit_guard()', 'kind'),
      ('ehr.admissions', 'zz_billing_admission_open', 5, 'commercial.hook_admission_open()', ''),
      ('ehr.admissions', 'zz_billing_admission_status', 17, 'commercial.hook_admission_status()', 'status')
        ) expected(relation, name, events, function_signature, columns)
        join pg_trigger trigger_row on trigger_row.tgrelid = expected.relation::regclass
         and trigger_row.tgname = expected.name and trigger_row.tgtype = expected.events
         and trigger_row.tgfoid = to_regprocedure(expected.function_signature)
       where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O' and trigger_row.tgnargs = 0
         and trigger_row.tgqual is null and trigger_row.tgconstraint = 0 and trigger_row.tgoldtable is null
         and trigger_row.tgnewtable is null
         and coalesce((select string_agg(attribute_row.attname, ',' order by attribute_row.attnum)
                         from pg_attribute attribute_row
                        where attribute_row.attrelid = trigger_row.tgrelid
                          and attribute_row.attnum = any (trigger_row.tgattr::int2[])), '') = expected.columns
         and cardinality(trigger_row.tgattr::int2[]) = coalesce(cardinality(string_to_array(nullif(expected.columns, ''), ',')), 0)
     ) <> 3
     or (select count(*) from pg_trigger trigger_row where not trigger_row.tgisinternal
          and trigger_row.tgrelid in ('commercial.ward_charge_items'::regclass, 'commercial.bed_day_charges'::regclass)) <> 0 then
    raise exception using errcode = '55000', message = '0172: post-check failed (the triggers, in 0152''s form)';
  end if;
  -- End of the triggers' post-check.
  -- Post-check, functions (0168's form). The 17 functions this file makes (12) or replaces (5):
  -- each a plain function with its SECURITY DEFINER setting, volatility, body (the md5 of prosrc) and fixed
  -- search_path as written here. Those it makes are the owner's (v_owner), with EXECUTE for exactly the runtimes
  -- listed (the entry points, when the role exists) and for no other role (none on the helpers); CREATE OR REPLACE
  -- keeps a replaced function's owner and grants.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_post_mismatch
    from (values
      ('commercial.bill_recompute(uuid)', true, false, 'v', 'd8ac034327231a27be7e7d86365f229e',
       'search_path=pg_catalog, pg_temp', null),
      ('commercial.bill_totals_agree(uuid)', true, false, 's', '905a6b2d1013ea2dc224de61391cb02a',
       'search_path=pg_catalog, pg_temp', null),
      ('commercial.bill_json(uuid)', true, false, 's', 'ab73b8cf00a41a1fc37424d29f95813f',
       'search_path=pg_catalog, pg_temp', null),
      ('commercial.bill_for_work(uuid,uuid,text)', true, false, 'v', '4d0b477b431969fe565d7e85c21151a1',
       'search_path=pg_catalog, pg_temp', null),
      ('commercial.payment_record(uuid,jsonb,bigint,text,text)', true, true, 'v', 'be5c48fa4a92c2a703709a1f6e6ccff3',
       'search_path=pg_catalog, pg_temp', null),
      ('commercial.payments_deposit_guard()', false, false, 'v', '11115e3c6dc6625ea8a0951f9ff6e82b',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('commercial.admission_bill_open(uuid)', false, false, 'v', 'd983e3e8446d3c5dd9dcdac956fc49fe',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('commercial.admission_line_put(uuid,uuid,text,text)', false, false, 'v', '78381952d0e3d03ededd0e600ae94945',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('commercial.admission_fee_add(uuid)', false, false, 'v', '2a1fd34fa6218843910db595657d56fb',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('commercial.accrue_bed_days(uuid)', false, false, 'v', 'e2f0bfc8dbe575a0e55ae3c56beaa48d',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('commercial.accrue_bed_days_due(uuid)', false, true, 'v', 'ad52f8d07303f06d60590783683c5336',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('commercial.ward_charges_set(uuid,bigint,uuid,uuid)', false, true, 'v', '13397b7e2653c6d8ae28d717f2591e13',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('commercial.ward_charges_list()', false, true, 'v', '06c5b4f5d733eebdc9935d84703e5b62',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('commercial.interim_statement(uuid)', false, true, 'v', '5c1672f93cd446971899ca2c39e36380',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('commercial.admission_bill_ids(uuid[])', false, true, 's', 'dc76e065acc1f772e50f56696d52960f',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('commercial.hook_admission_open()', false, true, 'v', '50487b4358f32e235b9f9ead3bf3b1f0',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('commercial.hook_admission_status()', false, true, 'v', '373871ff9b417afdbb825a77243f0e2d',
       'search_path=pg_catalog, pg_temp', array[]::text[])
    ) expected(signature, replaced, security_definer, volatility, body_md5, config, runtimes)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
   where proc.oid is null or proc.prokind <> 'f' or proc.prosecdef <> expected.security_definer
      or proc.provolatile::text <> expected.volatility or md5(proc.prosrc) <> expected.body_md5
      or proc.proconfig is distinct from array[expected.config]
      or (not expected.replaced
          and (proc.proowner <> (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner)
               or exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                           where acl.grantee <> proc.proowner
                             and (acl.grantee = 0 or acl.privilege_type <> 'EXECUTE'
                                  or not pg_get_userbyid(acl.grantee) = any (expected.runtimes)))
               or exists (select 1 from unnest(expected.runtimes) runtime_name
                            join pg_roles role_row on role_row.rolname = runtime_name
                           where not exists (select 1 from aclexplode(proc.proacl) acl
                                              where acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE'))));
  if v_post_mismatch is not null then
    raise exception using errcode = '55000',
      message = '0172: post-check failed (these functions are not as made: ' || v_post_mismatch || ')';
  end if;
  -- End of the functions' post-check.
  raise notice '0172: admission charges are installed (the admission bill, bed-days, the admission fee, deposits and interim statements; 2 tables, 2 hooks). A facility with no payment settings sees no change, and no billing state can refuse or delay an admission step.';
end
$adt0172$;
