-- 0167 BILL-1 (Release D): the billing and stock hooks on the live pharmacy,
-- lab and waiting-list tables. Written on claude/sprint-billing-backend
-- (staging at 95fa1e52, 0001-0151 applied) after 0162-0166 in the same pull
-- request. Provisional number (Release D block 0162-0167); nothing here reads
-- 0152-0154 (ORD-12's 0154 refills, when merged first, keep one automatic
-- line per work item; lines by fill come with ORD-12's own follow-up). No
-- migration number appears inside a function body. The declaration is signed
-- separately. Ola reviews this file and 0166 (the pharmacy and lab hooks);
-- Rahman gives the final database check.
--
-- Owner decisions: the sprint approval of 25 November 2026 (BILL-1 A,
-- corrected: one bill per visit, which gathers the visit's pharmacy and lab
-- lines; BILL-3 A: emergencies and unknown patients are served first and
-- billed later, always), and at the recommended option, not yet answered:
-- BILL-7 (a work item finds its price by its national code), BILL-11 (a
-- transfer waiting to be checked does not meet pay-before), BILL-12 (whole
-- units of the stock unit, expiry first, an item that is not priced or not
-- stock-kept is not counted).
--
-- WHAT IT DOES. Triggers only: no applied function, table or trigger is
-- changed. Every trigger function is SECURITY DEFINER, owned by the migration
-- owner, search_path pg_catalog, pg_temp, every name schema-qualified, and
-- returns at once when the row's facility is not the session's facility (a
-- system writer) or when the facility does not use billing (no
-- commercial.payment_settings row, and for stock no stock-kept item), so a
-- facility that never uses billing sees no change.
-- H1 ehr.visit_queue AFTER INSERT (zz_billing_check_in): when the facility's
--    settings name a check-in charge item that is still active, the visit's
--    bill is opened with that line (origin check_in). A new bill for an entry
--    at triage level 1 or 2 is deferred "emergency" by the system (0164's
--    commercial.bill_new), and for an unknown patient "unknown_patient".
-- H2 ehr.visit_queue AFTER UPDATE OF triage_level (zz_billing_triage): an
--    entry raised to triage level 1 or 2 defers its bill "emergency" (by the
--    system). Which levels count is a clinical-lead item (built as 1 and 2).
-- H3 pharmacy.work_item_acceptances AFTER INSERT (zz_billing_acceptance):
--    the accepted prescription's code (system and code) is matched to the
--    facility's active priced drug item; a line is added to the patient's
--    visit bill (0164's commercial.bill_for_work) with the prescription's
--    quantity to dispense when it is a whole number in the item's stock unit,
--    else quantity 1 and "check quantity". No match: the code is counted in
--    commercial.unpriced_code_hits (no patient, no person), and no line.
-- H4 lab.work_items AFTER INSERT (zz_billing_lab_work_item): the same for an
--    own lab work item (no order route) and a priced lab_test item, quantity 1.
-- H5 pharmacy.dispensings BEFORE INSERT (zz_billing_stock_and_gate), after
--    the existing validators (trigger names fire in order): the pay-before
--    gate (HB409 PAYMENT_REQUIRED or PAYMENT_PENDING_CHECK when the facility's
--    pay-before for pharmacy is on, the work item has a line, and its bill is
--    neither paid, deferred, void nor an unknown patient's); then, for a
--    stock-kept item, the quantity in the item's stock unit and whole (HB409
--    STOCK_UNIT_MISMATCH) taken expiry first (0166's
--    pharmacy.take_stock_expiry_first; HB409 OUT_OF_STOCK takes nothing). The
--    batch named by pharmacy-api in hid.stock_batch_id (transaction-local) is
--    used when set; what was taken is left in hid.stock_taken for the
--    dispensing's audit row.
-- H6 pharmacy.dispensing_reversals BEFORE INSERT (zz_billing_reversal): the
--    work item's automatic line (a reversed item is never dispensed again,
--    and a corrected medicine comes as a new prescription with its own line)
--    is marked reversed and cancelled by the reversing pharmacist
--    ("Dispensing reversed"), whether it was unpaid, part paid or paid: its
--    unpaid balance is never asked for, and pay-before never holds up the
--    corrected medicine for it. What was collected beyond the bill's new
--    total is left on the bill (0164's bill_recompute) as refund due (the
--    patient's money, given back first) and cover over the bill (a waiver or
--    HMO cover to cancel and record again); billing staff see the refund on
--    the bill and on the work item's badge. A later line on the same bill
--    uses what is over first. No stock moves: a reversal corrects the record,
--    and the medicine may never have come back; what does come back is
--    counted back on the Stock page.
-- H7 lab.specimens BEFORE UPDATE OF status (zz_billing_collect_gate): a
--    specimen becoming collected meets the pay-before gate for lab.
-- Pay-before is off everywhere until the clinical lead signs BILL-3
-- (COMMERCIAL_PAY_BEFORE_ENABLED); the gate never refuses a deferred bill, an
-- unknown patient, or a work item with no line ("Not billed" is never
-- blocked).
--
-- Locks: on ehr.visit_queue, pharmacy.work_item_acceptances, lab.work_items,
-- pharmacy.dispensings, pharmacy.dispensing_reversals and lab.specimens, ROW
-- EXCLUSIVE NOWAIT then SHARE ROW EXCLUSIVE NOWAIT (CREATE TRIGGER), in one
-- attempt made up to 50 times 100 ms apart, or once when this transaction
-- holds an earlier file's locks; busy refusals begin "0167: ". Readers go on;
-- check-ins, acceptances, dispensings, reversals and specimen updates wait for
-- the commit (milliseconds).
--
-- Old services: the hooks are silent at a facility with no settings row; a
-- refusal (HB409) is reached only where billing is set up. New services on a
-- schema without it: the billing routes answer 503 BILLING_UNAVAILABLE.
--
-- Undo (not in the ledger; docs/rollback/0167_billing_and_stock_hooks.md):
-- drop the seven triggers and the hook functions.
--
-- 0. Locks and preconditions (55000 and nothing applied; "0167: already
--    applied" when every function and trigger this file makes is there
--    exactly as made). Each of the six tables must still have every trigger
--    Release C gave it (name and type); triggers other release lanes add are
--    accepted (coordinator, #258, 25 November 2026: wave 1 releases in order
--    of readiness; 0168 adds two to ehr.visit_queue, which fire before this
--    file's zz_billing_* triggers of the same timing and event, as triggers
--    fire in name order). 1. Helpers. 2. Hook functions. 3. Triggers.
-- 4. Post-checks: function owners, SECURITY DEFINER, search_path, ACLs, md5,
--    and the seven triggers' tables, timing, events and functions.

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
    "commercial.hook_check_in()": "0132c9412cbb3b0f3b73d2ebbbe60e90",
    "commercial.hook_dispensing()": "f1bf808db6a26acb8bbd3a795d20b055",
    "commercial.hook_dispensing_reversal()": "e36c067703060e7185c203fdc744e3c4",
    "commercial.hook_facility(uuid)": "4efd0ae0c3c4ad8ce694a74b223cafa5",
    "commercial.hook_lab_work_item()": "903edbb2d3a10fc4a91610cec007349a",
    "commercial.hook_pharmacy_acceptance()": "2f5cabce9719e94cfc88d1e9bd7ca665",
    "commercial.hook_specimen_collected()": "2a1a70525c2c308fbc6017243a0c8529",
    "commercial.hook_triage()": "226774711ee8bb5a8496c50f9027feab",
    "commercial.pay_before_refusal(uuid,text,uuid)": "fcd1d6c70faafe7c00c2db9dabbc777c",
    "commercial.work_item_line(uuid,uuid,text,uuid,text,text,text,numeric,text)": "086363b9a7c85a1f131ae7b3026f34ff"}';
  -- The triggers Release C gives the six tables (name:tgtype); each must still be there.
  live_triggers constant jsonb := '{
    "ehr.visit_queue": "",
    "pharmacy.work_item_acceptances": "pharmacy_work_item_acceptance_validate:7,pharmacy_work_item_acceptances_immutable:27",
    "lab.work_items": "lab_work_item_validate:7,lab_work_items_immutable:27,work_items_own_work_patient_listed:21",
    "pharmacy.dispensings": "dispensings_claim_prescription:5,dispensings_order_route_return:5,pharmacy_dispensing_validate:7,pharmacy_dispensings_immutable:27,prescription_claim_key_immutable:19",
    "pharmacy.dispensing_reversals": "dispensing_reversals_order_route_return:5,pharmacy_dispensing_reversal_validate:7,pharmacy_dispensing_reversals_immutable:27",
    "lab.specimens": "lab_specimen_parent_validate:7,lab_specimen_transition:19,lab_specimens_no_delete:11"}';
  present integer;
  differing text;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.visit_queue, pharmacy.work_item_acceptances, lab.work_items, pharmacy.dispensings,
        pharmacy.dispensing_reversals, lab.specimens in row exclusive mode nowait;
      lock table ehr.visit_queue, pharmacy.work_item_acceptances, lab.work_items, pharmacy.dispensings,
        pharmacy.dispensing_reversals, lab.specimens in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0167: a table 0167 puts a trigger on (ehr.visit_queue, pharmacy.work_item_acceptances, '
            || 'lab.work_items, pharmacy.dispensings, pharmacy.dispensing_reversals or lab.specimens) is busy, and '
            || 'this transaction already holds an earlier migration''s locks, so it does not wait; nothing applied; '
            || 'run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0167: a table 0167 puts a trigger on (ehr.visit_queue, pharmacy.work_item_acceptances, '
            || 'lab.work_items, pharmacy.dispensings, pharmacy.dispensing_reversals or lab.specimens) stayed busy '
            || 'for 5 seconds; nothing applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;

  if to_regclass('pharmacy.stock_movements') is null or to_regclass('commercial.till_days') is null
     or to_regprocedure('pharmacy.take_stock_expiry_first(uuid,uuid,integer,uuid,text,uuid,uuid,uuid)') is null
     or to_regprocedure('commercial.bill_recompute(uuid)') is null
     or to_regprocedure('commercial.bill_for_work(uuid,uuid,text)') is null
     or to_regprocedure('commercial.bill_line_put(uuid,uuid,integer,text,text,uuid,boolean,text,uuid,text,text)') is null
     or to_regprocedure('commercial.bill_defer_put(uuid,text,text,text,uuid)') is null then
    raise exception using errcode = '55000', message = '0167: 0001-0151 and 0162-0166 must be applied first';
  end if;

  select count(*) into present from pg_trigger trigger_row
   where not trigger_row.tgisinternal and trigger_row.tgname like 'zz\_billing\_%'
     and trigger_row.tgrelid = any (array['ehr.visit_queue'::regclass, 'pharmacy.work_item_acceptances'::regclass,
       'lab.work_items'::regclass, 'pharmacy.dispensings'::regclass, 'pharmacy.dispensing_reversals'::regclass,
       'lab.specimens'::regclass]);
  if present > 0 or exists (select 1 from jsonb_object_keys(made) signature where to_regprocedure(signature) is not null)
     or to_regprocedure('commercial.hook_dispensing()') is not null then
    select string_agg(signature, ', ') into differing from jsonb_each_text(made) pinned(signature, digest)
     where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(pinned.signature))
           is distinct from pinned.digest;
    if differing is null and present = 7 and made <> '{}'::jsonb then
      raise exception using errcode = '55000', message = '0167: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0167: an object this file makes exists with other content: ' || coalesce(differing, 'a trigger');
  end if;

  -- The six tables still have every trigger Release C gave them (others' triggers accepted).
  select string_agg(target.key, ', ') into differing
    from jsonb_each_text(live_triggers) target
   where exists (select 1 from regexp_split_to_table(nullif(target.value, ''), ',') wanted(entry)
                  where not exists (select 1 from pg_trigger trigger_row
                                     where trigger_row.tgrelid = to_regclass(target.key) and not trigger_row.tgisinternal
                                       and trigger_row.tgname || ':' || trigger_row.tgtype = wanted.entry));
  if differing is not null then
    raise exception using errcode = '55000',
      message = '0167: these tables lack a trigger Release C gives them: ' || differing || '; nothing applied';
  end if;
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure('platform.current_facility_id()')) is null
     or to_regprocedure('identity.patient_record_kind(uuid)') is null
     or not exists (select 1 from information_schema.columns column_row
                     where column_row.table_schema = 'ehr' and column_row.table_name = 'prescriptions'
                       and column_row.column_name in ('quantity_to_dispense') )
     or not exists (select 1 from information_schema.columns column_row
                     where column_row.table_schema = 'ehr' and column_row.table_name = 'prescriptions'
                       and column_row.column_name = 'quantity_unit')
     or not exists (select 1 from information_schema.columns column_row
                     where column_row.table_schema = 'lab' and column_row.table_name = 'work_items'
                       and column_row.column_name = 'order_route_id') then
    raise exception using errcode = '55000',
      message = '0167: a column or function this file reads is missing; nothing applied';
  end if;
end
$pre$;

-- 1. Helpers (owner only).

-- Whether the session works at this facility (a hook acts only then; a system
-- writer with no facility, or another facility's session, is left alone).
create function commercial.hook_facility(row_facility uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select row_facility is not null and platform.current_facility_id() is not distinct from row_facility
$$;

-- The pay-before refusal for a work item, or null when it may go ahead.
create function commercial.pay_before_refusal(requested_facility uuid, requested_kind text, requested_work uuid)
returns text
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  settings commercial.payment_settings%rowtype;
  bill commercial.bills%rowtype;
begin
  select settings_row.* into settings from commercial.payment_settings settings_row
   where settings_row.facility_id = requested_facility;
  if not found or not (case when requested_kind = 'pharmacy' then settings.pay_before_pharmacy
                            else settings.pay_before_lab end) then
    return null;
  end if;
  select bill_row.* into bill from commercial.bill_lines line
    join commercial.bills bill_row on bill_row.id = line.bill_id
   where line.facility_id = requested_facility and line.work_item_kind = requested_kind
     and line.work_item_id = requested_work and not line.cancelled;
  if not found or bill.voided_at is not null or bill.deferred_reason is not null
     or (bill.patient_id is not null and identity.patient_record_kind(bill.patient_id) = 'unknown') then
    return null;
  end if;
  if bill.due_kobo > 0 then
    return 'PAYMENT_REQUIRED';
  end if;
  if bill.pending_check_kobo > 0 then
    return 'PAYMENT_PENDING_CHECK';
  end if;
  return null;
end
$$;

-- The automatic line of a work item: its priced item by national code, else a
-- count of the unpriced code. At most one line per work item.
create function commercial.work_item_line(requested_facility uuid, requested_patient uuid, requested_kind text,
  requested_work uuid, code_system text, code text, display text, quantity_value numeric, quantity_unit text)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  item_id uuid;
  stock_unit text;
  bill_value uuid;
  whole boolean;
begin
  if not exists (select 1 from commercial.payment_settings settings where settings.facility_id = requested_facility) then
    return null;
  end if;
  if exists (select 1 from commercial.bill_lines line
              where line.work_item_kind = requested_kind and line.work_item_id = requested_work) then
    return null;
  end if;
  if code_system is not null and code is not null then
    select item.id into item_id from commercial.catalogue_items item
     where item.facility_id = requested_facility and item.active
       and item.kind = case when requested_kind = 'pharmacy' then 'drug' else 'lab_test' end
       and item.national_code_system = btrim(code_system) and item.national_code = btrim(code)
       and exists (select 1 from commercial.catalogue_item_prices price
                    where price.catalogue_item_id = item.id and price.hmo_id is null);
  end if;
  if item_id is null then
    if code_system is not null and code is not null then
      insert into commercial.unpriced_code_hits (facility_id, work_kind, code_system, code, display)
      values (requested_facility, requested_kind, left(btrim(code_system), 255), left(btrim(code), 100),
        left(coalesce(nullif(btrim(display), ''), btrim(code)), 500));
    end if;
    return null;
  end if;
  select stock.unit into stock_unit from pharmacy.stock_items stock where stock.catalogue_item_id = item_id;
  whole := requested_kind = 'pharmacy' and quantity_value is not null and quantity_value >= 1
    and quantity_value <= 10000 and quantity_value = trunc(quantity_value)
    and stock_unit is not null and lower(btrim(coalesce(quantity_unit, ''))) = lower(stock_unit);
  bill_value := commercial.bill_for_work(requested_facility, requested_patient, requested_kind);
  return commercial.bill_line_put(bill_value, item_id, case when whole then quantity_value::integer else 1 end,
    requested_kind, requested_kind, requested_work, requested_kind = 'pharmacy' and not whole, null, null, null, null);
end
$$;

-- 2. Hook functions.

create function commercial.hook_check_in()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  charge uuid;
  bill_value uuid;
begin
  if not commercial.hook_facility(new.facility_id) then
    return null;
  end if;
  select settings.check_in_charge_item_id into charge from commercial.payment_settings settings
   where settings.facility_id = new.facility_id;
  if charge is null or not exists (select 1 from commercial.catalogue_items item
                                    where item.id = charge and item.facility_id = new.facility_id and item.active) then
    return null;
  end if;
  bill_value := commercial.bill_for_work(new.facility_id, new.patient_id, 'pharmacy');
  if not exists (select 1 from commercial.bill_lines line where line.bill_id = bill_value and line.origin = 'check_in'
                    and not line.cancelled) then
    perform commercial.bill_line_put(bill_value, charge, 1, 'check_in', null, null, false, null, null, null, null);
  end if;
  return null;
end
$$;

create function commercial.hook_triage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  bill_value uuid;
begin
  if not commercial.hook_facility(new.facility_id) or new.triage_level is null or new.triage_level not in (1, 2)
     or old.triage_level is not distinct from new.triage_level then
    return null;
  end if;
  select bill.id into bill_value from commercial.bills bill
   where bill.visit_queue_entry_id = new.id and bill.status <> 'void' for update;
  if bill_value is not null then
    perform commercial.bill_defer_put(bill_value, 'emergency', 'system', null, null);
  end if;
  return null;
end
$$;

create function commercial.hook_pharmacy_acceptance()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  work pharmacy.work_items%rowtype;
  amount numeric;
  amount_unit text;
begin
  if not commercial.hook_facility(new.facility_id) then
    return null;
  end if;
  select item.* into work from pharmacy.work_items item where item.id = new.work_item_id;
  if not found then
    return null;
  end if;
  select prescription.quantity_to_dispense, prescription.quantity_unit into amount, amount_unit
    from ehr.prescriptions prescription where prescription.id = work.source_ehr_prescription_id;
  perform commercial.work_item_line(new.facility_id, new.patient_id, 'pharmacy', new.work_item_id,
    work.medication_code_system, work.medication_code, work.medication_display, amount, amount_unit);
  return null;
end
$$;

create function commercial.hook_lab_work_item()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if not commercial.hook_facility(new.facility_id) or new.order_route_id is not null then
    return null;
  end if;
  perform commercial.work_item_line(new.facility_id, new.patient_id, 'lab', new.id, new.test_code_system,
    new.test_code, new.test_name, 1, null);
  return null;
end
$$;

create function commercial.hook_dispensing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  refusal text;
  item_id uuid;
  stock_unit text;
  batch_value uuid;
  taken jsonb;
begin
  if not commercial.hook_facility(new.facility_id) then
    return new;
  end if;
  refusal := commercial.pay_before_refusal(new.facility_id, 'pharmacy', new.work_item_id);
  if refusal is not null then
    raise exception using errcode = 'HB409', message = refusal;
  end if;
  item_id := pharmacy.stock_item_for_code(new.facility_id, btrim(new.medication_code_system), btrim(new.medication_code));
  if item_id is null then
    return new;
  end if;
  select stock.unit into stock_unit from pharmacy.stock_items stock where stock.catalogue_item_id = item_id;
  if lower(btrim(new.quantity_unit)) <> lower(stock_unit) or new.quantity_dispensed <> trunc(new.quantity_dispensed)
     or new.quantity_dispensed > 1000000 then
    raise exception using errcode = 'HB409', message = 'STOCK_UNIT_MISMATCH',
      detail = jsonb_build_object('unit', stock_unit)::text;
  end if;
  begin
    batch_value := nullif(current_setting('hid.stock_batch_id', true), '')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "batchId"}';
  end;
  taken := pharmacy.take_stock_expiry_first(new.facility_id, item_id, new.quantity_dispensed::integer, batch_value,
    'dispensing', new.id, null, new.dispensed_by_membership_id);
  perform set_config('hid.stock_taken', taken::text, true);
  return new;
end
$$;

create function commercial.hook_dispensing_reversal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  line commercial.bill_lines%rowtype;
  bill commercial.bills%rowtype;
  after_bill commercial.bills%rowtype;
begin
  if not commercial.hook_facility(new.facility_id) then
    return new;
  end if;
  select bill_line.* into line from commercial.bill_lines bill_line
   where bill_line.facility_id = new.facility_id and bill_line.work_item_kind = 'pharmacy'
     and bill_line.work_item_id = new.work_item_id and not bill_line.cancelled;
  if not found then
    return new;
  end if;
  select bill_row.* into bill from commercial.bills bill_row where bill_row.id = line.bill_id for update;
  if bill.voided_at is not null then
    return new;
  end if;
  -- Always off the bill: never-paid, part-paid and paid alike; what was collected beyond the new total stays as
  -- the bill's refund due and cover over the bill (0164's bill_recompute).
  update commercial.bill_lines bill_line
     set dispensing_reversed_at = clock_timestamp(), cancelled = true, cancel_reason = 'Dispensing reversed',
         cancelled_by_membership_id = new.reversed_by_membership_id, cancelled_at = clock_timestamp()
   where bill_line.id = line.id;
  perform commercial.bill_recompute(bill.id);
  select bill_row.* into after_bill from commercial.bills bill_row where bill_row.id = bill.id;
  perform commercial.bill_event(bill.id, bill.facility_id,
    case when after_bill.refund_due_kobo + after_bill.cover_over_kobo > 0 then 'dispensing-reversed' else 'line-cancel' end,
    new.reversed_by_membership_id,
    jsonb_build_object('lineId', line.id, 'totalKobo', line.total_kobo, 'dispensingReversed', true,
      'refundDueKobo', after_bill.refund_due_kobo, 'coverOverKobo', after_bill.cover_over_kobo));
  perform commercial.audit(
    case when after_bill.refund_due_kobo + after_bill.cover_over_kobo > 0 then 'commercial.bill.dispensing-reversed'
         else 'commercial.bill.line-cancel' end,
    'success', 'bill', bill.id::text, bill.patient_id,
    jsonb_build_object('lineId', line.id, 'totalKobo', line.total_kobo, 'origin', line.origin, 'dispensingReversed', true,
      'refundDueKobo', after_bill.refund_due_kobo, 'coverOverKobo', after_bill.cover_over_kobo, 'by', 'system'),
    commercial.staff_source(null));
  return new;
end
$$;

create function commercial.hook_specimen_collected()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  work_id uuid;
  refusal text;
begin
  if new.status is distinct from 'collected' or old.status is not distinct from 'collected'
     or not commercial.hook_facility(new.facility_id) then
    return new;
  end if;
  select accession.work_item_id into work_id from lab.accessions accession where accession.id = new.accession_id;
  if work_id is null then
    return new;
  end if;
  refusal := commercial.pay_before_refusal(new.facility_id, 'lab', work_id);
  if refusal is not null then
    raise exception using errcode = 'HB409', message = refusal;
  end if;
  return new;
end
$$;

revoke all on function commercial.hook_facility(uuid), commercial.pay_before_refusal(uuid, text, uuid),
  commercial.work_item_line(uuid, uuid, text, uuid, text, text, text, numeric, text), commercial.hook_check_in(),
  commercial.hook_triage(), commercial.hook_pharmacy_acceptance(), commercial.hook_lab_work_item(),
  commercial.hook_dispensing(), commercial.hook_dispensing_reversal(), commercial.hook_specimen_collected()
  from public;

-- 3. Triggers. The zz_ names fire after each table's existing triggers of the
-- same timing and event (PostgreSQL fires them in name order).
create trigger zz_billing_check_in after insert on ehr.visit_queue
  for each row execute function commercial.hook_check_in();
create trigger zz_billing_triage after update of triage_level on ehr.visit_queue
  for each row execute function commercial.hook_triage();
create trigger zz_billing_acceptance after insert on pharmacy.work_item_acceptances
  for each row execute function commercial.hook_pharmacy_acceptance();
create trigger zz_billing_lab_work_item after insert on lab.work_items
  for each row execute function commercial.hook_lab_work_item();
create trigger zz_billing_stock_and_gate before insert on pharmacy.dispensings
  for each row execute function commercial.hook_dispensing();
create trigger zz_billing_reversal before insert on pharmacy.dispensing_reversals
  for each row execute function commercial.hook_dispensing_reversal();
create trigger zz_billing_collect_gate before update of status on lab.specimens
  for each row execute function commercial.hook_specimen_collected();

comment on function commercial.hook_dispensing() is
  '0167 (BILL-1): pay-before gate for pharmacy (off until the clinical lead signs BILL-3) and expiry-first stock for a stock-kept item; silent where billing is not set up.';

-- 4. Post-checks.
do $post$
declare
  made constant jsonb := '{
    "commercial.hook_check_in()": "0132c9412cbb3b0f3b73d2ebbbe60e90",
    "commercial.hook_dispensing()": "f1bf808db6a26acb8bbd3a795d20b055",
    "commercial.hook_dispensing_reversal()": "e36c067703060e7185c203fdc744e3c4",
    "commercial.hook_facility(uuid)": "4efd0ae0c3c4ad8ce694a74b223cafa5",
    "commercial.hook_lab_work_item()": "903edbb2d3a10fc4a91610cec007349a",
    "commercial.hook_pharmacy_acceptance()": "2f5cabce9719e94cfc88d1e9bd7ca665",
    "commercial.hook_specimen_collected()": "2a1a70525c2c308fbc6017243a0c8529",
    "commercial.hook_triage()": "226774711ee8bb5a8496c50f9027feab",
    "commercial.pay_before_refusal(uuid,text,uuid)": "fcd1d6c70faafe7c00c2db9dabbc777c",
    "commercial.work_item_line(uuid,uuid,text,uuid,text,text,text,numeric,text)": "086363b9a7c85a1f131ae7b3026f34ff"}';
  owner_oid oid := (select nspowner from pg_namespace where nspname = 'commercial');
  computed jsonb;
  differing text;
  hooks constant text[] := array['commercial.hook_facility(uuid)', 'commercial.pay_before_refusal(uuid,text,uuid)',
    'commercial.work_item_line(uuid,uuid,text,uuid,text,text,text,numeric,text)', 'commercial.hook_check_in()',
    'commercial.hook_triage()', 'commercial.hook_pharmacy_acceptance()', 'commercial.hook_lab_work_item()',
    'commercial.hook_dispensing()', 'commercial.hook_dispensing_reversal()', 'commercial.hook_specimen_collected()'];
  definers constant text[] := array['commercial.hook_check_in()', 'commercial.hook_triage()',
    'commercial.hook_pharmacy_acceptance()', 'commercial.hook_lab_work_item()', 'commercial.hook_dispensing()',
    'commercial.hook_dispensing_reversal()', 'commercial.hook_specimen_collected()'];
  -- table, trigger, tgtype, function
  expected constant text[] := array[
    'ehr.visit_queue|zz_billing_check_in|5|commercial.hook_check_in',
    'ehr.visit_queue|zz_billing_triage|17|commercial.hook_triage',
    'pharmacy.work_item_acceptances|zz_billing_acceptance|5|commercial.hook_pharmacy_acceptance',
    'lab.work_items|zz_billing_lab_work_item|5|commercial.hook_lab_work_item',
    'pharmacy.dispensings|zz_billing_stock_and_gate|7|commercial.hook_dispensing',
    'pharmacy.dispensing_reversals|zz_billing_reversal|7|commercial.hook_dispensing_reversal',
    'lab.specimens|zz_billing_collect_gate|19|commercial.hook_specimen_collected'];
begin
  select jsonb_object_agg(signature, md5(proc.prosrc)) into computed
    from unnest(hooks) signature join pg_proc proc on proc.oid = to_regprocedure(signature);
  if made = '{}'::jsonb then
    raise notice '0167 made: %', computed;
  elsif computed is distinct from made then
    select string_agg(key, ', ') into differing from (
      select key from jsonb_each_text(made) where computed->>key is distinct from value
      union select key from jsonb_each_text(computed) where made->>key is null) keys;
    raise exception using errcode = '55000', message = '0167: post-check failed: functions differ: ' || differing;
  end if;
  if (select count(*) from unnest(hooks) signature join pg_proc proc on proc.oid = to_regprocedure(signature)
       where proc.proowner = owner_oid and proc.proconfig = array['search_path=pg_catalog, pg_temp']
         and proc.prosecdef = (signature = any (definers))
         and not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                          where acl.grantee <> proc.proowner)) <> cardinality(hooks) then
    raise exception using errcode = '55000',
      message = '0167: post-check failed: a hook function''s owner, search_path, SECURITY DEFINER or grants';
  end if;
  if (select count(*) from unnest(expected) target(value)
       join pg_trigger trigger_row
         on trigger_row.tgrelid = to_regclass(split_part(target.value, '|', 1))
        and trigger_row.tgname = split_part(target.value, '|', 2)
        and trigger_row.tgtype = split_part(target.value, '|', 3)::smallint
        and trigger_row.tgfoid = (split_part(target.value, '|', 4) || '()')::regprocedure
        and trigger_row.tgenabled = 'O' and not trigger_row.tgisinternal) <> cardinality(expected) then
    raise exception using errcode = '55000', message = '0167: post-check failed: the seven triggers';
  end if;
  if (select count(*) from pg_trigger trigger_row where not trigger_row.tgisinternal
       and trigger_row.tgname like 'zz\_billing\_%') <> 7 then
    raise exception using errcode = '55000', message = '0167: post-check failed: an unexpected billing trigger';
  end if;
end
$post$;
