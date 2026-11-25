-- 0166 BILL-1 (Release D): pharmacy point-of-care stock (POINT_OF_CARE_SPEC
-- section 5) and counter sales with their hand-over (section 4, counter
-- only). Written on claude/sprint-billing-backend (staging at 95fa1e52,
-- 0001-0151 applied) after 0162-0165 in the same pull request. Provisional
-- number (Release D block 0162-0167); nothing here reads 0152-0154. No
-- migration number appears inside a function body. The declaration is
-- signed separately. Ola reviews this file and 0167 (the pharmacy and lab
-- hooks); Rahman gives the final database check.
--
-- Owner decisions: the sprint approval of 25 November 2026, the challenger's
-- correction (pharmacy point-of-care stock belongs to this department), and
-- at the recommended option, not yet answered: BILL-7 (stock is kept against
-- the one item master, commercial.catalogue_items), BILL-12 (whole units of
-- the item's base unit; expiry first; an expired batch is never given out;
-- an item that is not priced or not stock-kept is not counted), BILL-13
-- (walk-ins are counter sales only in release 1).
--
-- WHAT IT DOES
-- T1 pharmacy.stock_items: per facility and drug item, its stock unit and
--    reorder level. An item is stock-kept once it has this row (and
--    commercial.catalogue_items.stock_kept is set with it).
-- T2 pharmacy.stock_batches: batch number, expiry, on hand (whole units,
--    never below zero), unit cost; unique per facility, item and batch
--    number.
-- T3 pharmacy.stock_receipts and T4 pharmacy.stock_receipt_lines: goods
--    received (supplier, invoice number, lines by batch).
-- T5 pharmacy.stock_adjustments: a signed change with a reason (damaged,
--    expired, count, returned) and a note (required for count).
-- T6 pharmacy.stock_movements: the append-only ledger: every receipt,
--    adjustment, dispensing, dispensing reversal and counter sale, with the
--    signed change, the batch and what it refers to. A batch's on hand always
--    equals the sum of its movements (pharmacy.stock_ledger_agrees, used by
--    the tests and the rehearsal).
-- Every table: facility_id on every row, row-level security forced with one
-- policy for the owner at the session's facility, no privilege for any
-- runtime, no DELETE or TRUNCATE (UPDATE too on T3, T4, T5 and T6).
-- F1 Helpers (owner only): pharmacy.stock_line_json (the built StockLine:
--    on hand counts batches not expired, Lagos day; expiredOnHand apart;
--    every batch with stock, marked expired where it is),
--    pharmacy.take_stock_expiry_first (locks the item's batches FOR UPDATE
--    in expiry order and takes the whole quantity from the batch that
--    expires first, then the next; or, with a batch named, from that batch
--    only; an expired batch is never used; when the batches hold less, HB409
--    OUT_OF_STOCK with onHand, unit and expiredOnHand, and nothing is
--    taken), pharmacy.stock_put_back (a reversal puts the stock back into the
--    batches it came from), pharmacy.stock_item_for_code (the stock-kept
--    item of a medication code at a facility), pharmacy.stock_ledger_agrees.
-- F2 For the Pharmacy runtime and the schema test runtime (SECURITY DEFINER,
--    search_path pg_catalog, pg_temp): pharmacy.stock_list,
--    pharmacy.stock_settings_put, pharmacy.stock_receive,
--    pharmacy.stock_adjust, pharmacy.stock_movement_list,
--    pharmacy.counter_sale_create (a counter sale's bill; a prescription-only
--    item needs the outside prescriber; queueing is refused
--    WALK_IN_QUEUE_NOT_AVAILABLE; a Health ID is a patient lookup, audited,
--    and only the bill is put on that patient, no dispensing record) and
--    pharmacy.sale_hand_over (only a paid counter sale; takes every
--    stock-kept drug line expiry-first, all or nothing; once).
-- Grants: EXECUTE on F2 to hid_pharmacy_runtime and hid_schema_test_runtime,
-- where they exist (and in runtime-grants.sql).
--
-- Locks: SHARE ROW EXCLUSIVE NOWAIT on identity.facilities,
-- identity.staff_facility_memberships and commercial.catalogue_items (the
-- new foreign keys; 0163's table), in one attempt made up to 50 times 100 ms
-- apart, or once when this transaction holds an earlier file's locks; busy
-- refusals begin "0166: ". Nothing of pharmacy's existing tables is locked or
-- changed here (0167 adds the dispensing hooks).
--
-- Old services: nothing calls the new functions. New services on a schema
-- without it: 503 BILLING_UNAVAILABLE.
--
-- Undo (docs/rollback/0166_pharmacy_point_of_care_stock.md): drop F2, F1 and
-- the six tables (after 0167's undo).

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
    "pharmacy.counter_sale_create(jsonb,text,text)": "ad3363d113221c8c2ed10d4f4dfb5fd9",
    "pharmacy.sale_hand_over(uuid,bigint,text,text)": "6892fba41511093e018686dbb74517d9",
    "pharmacy.stock_adjust(jsonb,text,text)": "e4dd58dfab08d478776610cc860a4a55",
    "pharmacy.stock_for_codes(jsonb)": "43704ba1515810af6a53e1ce722f241b",
    "pharmacy.stock_item_for_code(uuid,text,text)": "08796082b6e770b346546f921690027b",
    "pharmacy.stock_ledger_agrees(uuid)": "7c969a1bdf3f2f4fcb9cd7d543628744",
    "pharmacy.stock_line_json(uuid)": "0a7e1acead9c386d4bd2d53d3a59d971",
    "pharmacy.stock_list(text,text,integer)": "0f5bec7fd52be30c18900f418462c622",
    "pharmacy.stock_movement_list(uuid,integer)": "3af24dd992eb5d8de566a38b7fd1c207",
    "pharmacy.stock_put_back(uuid,uuid,uuid,uuid)": "19078fe0215f418b02dd4ae2885c6e74",
    "pharmacy.stock_receive(jsonb,text,text)": "adfcdb3316b588a80810a5a1f06fb303",
    "pharmacy.stock_settings_put(uuid,text,integer,bigint,text,text)": "e671fcc0534789f36dfdf56d7c6bd82e",
    "pharmacy.take_stock_expiry_first(uuid,uuid,integer,uuid,text,uuid,uuid,uuid)": "45339666f7904c888dd7d675044c156f"}';
  present integer;
  differing text;
begin
  if to_regclass('commercial.till_days') is null or to_regprocedure('commercial.bill_line_put(uuid,uuid,integer,text,text,uuid,boolean,text,uuid,text,text)') is null
     or to_regclass('pharmacy.dispensings') is null then
    raise exception using errcode = '55000', message = '0166: 0001-0151 and 0162-0165 must be applied first';
  end if;
  loop
    attempt := attempt + 1;
    begin
      lock table identity.facilities, identity.staff_facility_memberships, commercial.catalogue_items
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0166: identity.facilities, identity.staff_facility_memberships or commercial.catalogue_items is '
            || 'busy, and this transaction already holds an earlier migration''s locks, so it does not wait; nothing '
            || 'applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0166: identity.facilities, identity.staff_facility_memberships or commercial.catalogue_items '
            || 'stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
  select count(*) into present from jsonb_object_keys(made) signature where to_regprocedure(signature) is not null;
  if present > 0 or to_regclass('pharmacy.stock_batches') is not null then
    select string_agg(signature, ', ') into differing from jsonb_each_text(made) pinned(signature, digest)
     where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(pinned.signature))
           is distinct from pinned.digest;
    if differing is null and present = (select count(*) from jsonb_object_keys(made)) then
      raise exception using errcode = '55000', message = '0166: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0166: an object this file makes exists with other content: ' || coalesce(differing, 'a table');
  end if;
end
$pre$;

create table pharmacy.stock_items (
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  catalogue_item_id uuid not null,
  unit text not null check (unit = btrim(unit) and length(unit) between 1 and 40),
  reorder_level integer not null check (reorder_level between 0 and 1000000),
  row_version bigint not null default 1 check (row_version > 0),
  updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (catalogue_item_id),
  unique (catalogue_item_id, facility_id),
  foreign key (catalogue_item_id, facility_id) references commercial.catalogue_items (id, facility_id) on delete restrict
);

create table pharmacy.stock_batches (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  catalogue_item_id uuid not null,
  batch_number text not null check (batch_number = btrim(batch_number) and length(batch_number) between 1 and 60),
  expires_on date not null,
  on_hand integer not null default 0 check (on_hand between 0 and 100000000),
  unit_cost_kobo bigint check (unit_cost_kobo is null or unit_cost_kobo between 0 and 100000000),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (facility_id, catalogue_item_id, batch_number),
  unique (id, facility_id),
  foreign key (catalogue_item_id, facility_id) references pharmacy.stock_items (catalogue_item_id, facility_id)
    on delete restrict
);
create index stock_batches_issue_idx on pharmacy.stock_batches (catalogue_item_id, expires_on, id) where on_hand > 0;

create table pharmacy.stock_receipts (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  supplier text check (supplier is null or length(btrim(supplier)) between 1 and 120),
  invoice_number text check (invoice_number is null or length(btrim(invoice_number)) between 1 and 60),
  received_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  received_at timestamptz not null default clock_timestamp(),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  unique (id, facility_id)
);

create table pharmacy.stock_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  receipt_id uuid not null,
  catalogue_item_id uuid not null,
  batch_id uuid not null,
  quantity integer not null check (quantity between 1 and 1000000),
  unit_cost_kobo bigint check (unit_cost_kobo is null or unit_cost_kobo between 0 and 100000000),
  foreign key (receipt_id, facility_id) references pharmacy.stock_receipts (id, facility_id) on delete restrict,
  foreign key (batch_id, facility_id) references pharmacy.stock_batches (id, facility_id) on delete restrict
);

create table pharmacy.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  catalogue_item_id uuid not null,
  batch_id uuid not null,
  change integer not null check (change <> 0 and change between -100000000 and 100000000),
  reason text not null check (reason in ('damaged', 'expired', 'count', 'returned')),
  note text check (note is null or length(note) <= 500),
  membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  foreign key (batch_id, facility_id) references pharmacy.stock_batches (id, facility_id) on delete restrict,
  constraint stock_adjustments_note_ck check (reason <> 'count' or length(btrim(coalesce(note, ''))) > 0)
);

create table pharmacy.stock_movements (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  catalogue_item_id uuid not null,
  batch_id uuid not null,
  change integer not null check (change <> 0),
  kind text not null check (kind in ('receipt', 'adjustment', 'dispensing', 'dispensing_reversal', 'counter_sale')),
  receipt_id uuid,
  adjustment_id uuid references pharmacy.stock_adjustments(id) on delete restrict,
  dispensing_id uuid,
  reversal_id uuid,
  bill_line_id uuid,
  membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (batch_id, facility_id) references pharmacy.stock_batches (id, facility_id) on delete restrict,
  foreign key (receipt_id, facility_id) references pharmacy.stock_receipts (id, facility_id) on delete restrict,
  constraint stock_movements_reference_ck check (
    (kind = 'receipt') = (receipt_id is not null) and (kind = 'adjustment') = (adjustment_id is not null)
    and (kind in ('dispensing', 'dispensing_reversal')) = (dispensing_id is not null)
    and (kind = 'dispensing_reversal') = (reversal_id is not null) and (kind = 'counter_sale') = (bill_line_id is not null)
    and (kind not in ('receipt', 'dispensing_reversal') or change > 0)
    and (kind not in ('dispensing', 'counter_sale') or change < 0))
);
create index stock_movements_item_idx on pharmacy.stock_movements (catalogue_item_id, created_at desc, id);
create index stock_movements_dispensing_idx on pharmacy.stock_movements (dispensing_id) where dispensing_id is not null;
create index stock_movements_batch_idx on pharmacy.stock_movements (batch_id);

do $rls$
declare
  target text;
begin
  foreach target in array array['pharmacy.stock_items', 'pharmacy.stock_batches', 'pharmacy.stock_receipts',
      'pharmacy.stock_receipt_lines', 'pharmacy.stock_adjustments', 'pharmacy.stock_movements'] loop
    execute format('alter table %s enable row level security', target);
    execute format('alter table %s force row level security', target);
    execute format('create policy facility_owner_rows on %s for all using (current_user = %L and facility_id = '
      || 'platform.current_facility_id()) with check (current_user = %L and facility_id = platform.current_facility_id())',
      target, current_user, current_user);
    execute format('revoke all on %s from public', target);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function '
      || 'platform.reject_mutation()', target);
    if target in ('pharmacy.stock_items', 'pharmacy.stock_batches') then
      execute format('create trigger no_delete before delete on %s for each row execute function '
        || 'platform.reject_mutation()', target);
    else
      execute format('create trigger append_only before update or delete on %s for each row execute function '
        || 'platform.reject_mutation()', target);
    end if;
  end loop;
end
$rls$;

-- F1. Helpers.

create function pharmacy.stock_line_json(requested_item uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object('catalogueItemId', item.id, 'name', item.name, 'strength', item.strength, 'form', item.form,
    'imageUrl', null,
    'onHand', coalesce((select sum(batch.on_hand) from pharmacy.stock_batches batch
                         where batch.catalogue_item_id = item.id
                           and batch.expires_on >= commercial.lagos_day(clock_timestamp())), 0),
    'expiredOnHand', coalesce((select sum(batch.on_hand) from pharmacy.stock_batches batch
                                where batch.catalogue_item_id = item.id
                                  and batch.expires_on < commercial.lagos_day(clock_timestamp())), 0),
    'unit', stock.unit, 'reorderLevel', stock.reorder_level,
    'batches', coalesce((select jsonb_agg(jsonb_build_object('batchId', batch.id, 'batchNumber', batch.batch_number,
                 'expiresOn', batch.expires_on, 'quantity', batch.on_hand,
                 'expired', batch.expires_on < commercial.lagos_day(clock_timestamp()))
                 order by batch.expires_on, batch.id)
               from pharmacy.stock_batches batch where batch.catalogue_item_id = item.id and batch.on_hand > 0), '[]'::jsonb),
    'version', stock.row_version)
    from commercial.catalogue_items item
    join pharmacy.stock_items stock on stock.catalogue_item_id = item.id
   where item.id = requested_item
$$;

-- Takes quantity whole units of an item, expiry first (or from one named
-- batch), never from an expired batch; all or nothing. Answers the batches
-- and counts taken. HB409 OUT_OF_STOCK (detail: onHand, unit, expiredOnHand).
create function pharmacy.take_stock_expiry_first(requested_facility uuid, requested_item uuid, quantity integer,
  requested_batch uuid, movement_kind text, dispensing_value uuid, bill_line_value uuid, member_value uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  today date := commercial.lagos_day(clock_timestamp());
  remaining integer := quantity;
  taken jsonb := '[]'::jsonb;
  batch record;
  step integer;
  available integer;
  expired_value integer;
  unit_value text;
begin
  if quantity is null or quantity < 1 then
    raise exception using errcode = 'HB409', message = 'STOCK_UNIT_MISMATCH';
  end if;
  select stock.unit into unit_value from pharmacy.stock_items stock
   where stock.catalogue_item_id = requested_item and stock.facility_id = requested_facility;
  -- Lock every batch of the item, in expiry order, before counting.
  perform 1 from pharmacy.stock_batches stock_batch
   where stock_batch.catalogue_item_id = requested_item and stock_batch.facility_id = requested_facility
   order by stock_batch.expires_on, stock_batch.id for update;
  select coalesce(sum(stock_batch.on_hand) filter (where stock_batch.expires_on >= today
                                                     and (requested_batch is null or stock_batch.id = requested_batch)), 0),
         coalesce(sum(stock_batch.on_hand) filter (where stock_batch.expires_on < today), 0)
    into available, expired_value
    from pharmacy.stock_batches stock_batch
   where stock_batch.catalogue_item_id = requested_item and stock_batch.facility_id = requested_facility;
  if requested_batch is not null and not exists (
       select 1 from pharmacy.stock_batches stock_batch
        where stock_batch.id = requested_batch and stock_batch.catalogue_item_id = requested_item
          and stock_batch.facility_id = requested_facility) then
    raise exception using errcode = 'HB404', message = 'CATALOGUE_ITEM_NOT_FOUND', detail = '{"field": "batchId"}';
  end if;
  if available < quantity then
    raise exception using errcode = 'HB409', message = 'OUT_OF_STOCK',
      detail = jsonb_build_object('onHand', available, 'unit', unit_value, 'expiredOnHand', expired_value)::text;
  end if;
  for batch in
    select stock_batch.id, stock_batch.on_hand from pharmacy.stock_batches stock_batch
     where stock_batch.catalogue_item_id = requested_item and stock_batch.facility_id = requested_facility
       and stock_batch.on_hand > 0 and stock_batch.expires_on >= today
       and (requested_batch is null or stock_batch.id = requested_batch)
     order by stock_batch.expires_on, stock_batch.id
  loop
    exit when remaining = 0;
    step := least(remaining, batch.on_hand);
    update pharmacy.stock_batches stock_batch
       set on_hand = stock_batch.on_hand - step, row_version = stock_batch.row_version + 1, updated_at = clock_timestamp()
     where stock_batch.id = batch.id;
    insert into pharmacy.stock_movements (facility_id, catalogue_item_id, batch_id, change, kind, dispensing_id,
      bill_line_id, membership_id)
    values (requested_facility, requested_item, batch.id, -step, movement_kind, dispensing_value, bill_line_value,
      member_value);
    taken := taken || jsonb_build_array(jsonb_build_object('batchId', batch.id, 'quantity', step));
    remaining := remaining - step;
  end loop;
  return taken;
end
$$;

-- Puts a reversed dispensing's stock back into the batches it came from.
create function pharmacy.stock_put_back(requested_facility uuid, dispensing_value uuid, reversal_value uuid,
  member_value uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  movement record;
  returned jsonb := '[]'::jsonb;
begin
  for movement in
    select taken.batch_id, taken.catalogue_item_id, -sum(taken.change)::integer as quantity
      from pharmacy.stock_movements taken
     where taken.facility_id = requested_facility and taken.dispensing_id = dispensing_value
       and taken.kind in ('dispensing', 'dispensing_reversal')
     group by taken.batch_id, taken.catalogue_item_id
    having -sum(taken.change) > 0
     order by taken.batch_id
  loop
    update pharmacy.stock_batches stock_batch
       set on_hand = stock_batch.on_hand + movement.quantity, row_version = stock_batch.row_version + 1,
           updated_at = clock_timestamp()
     where stock_batch.id = movement.batch_id;
    insert into pharmacy.stock_movements (facility_id, catalogue_item_id, batch_id, change, kind, dispensing_id,
      reversal_id, membership_id)
    values (requested_facility, movement.catalogue_item_id, movement.batch_id, movement.quantity, 'dispensing_reversal',
      dispensing_value, reversal_value, member_value);
    returned := returned || jsonb_build_array(jsonb_build_object('batchId', movement.batch_id,
      'quantity', movement.quantity));
  end loop;
  return returned;
end
$$;

-- The active, stock-kept drug item a medication code is priced as here.
create function pharmacy.stock_item_for_code(requested_facility uuid, code_system text, code text)
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select item.id from commercial.catalogue_items item
   where item.facility_id = requested_facility and item.active and item.kind = 'drug' and item.stock_kept
     and item.national_code_system = code_system and item.national_code = code
$$;

-- Whether every batch's on hand equals the sum of its movements.
create function pharmacy.stock_ledger_agrees(requested_facility uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select not exists (
    select 1 from pharmacy.stock_batches batch
     where batch.facility_id = requested_facility
       and batch.on_hand <> coalesce((select sum(movement.change) from pharmacy.stock_movements movement
                                       where movement.batch_id = batch.id), 0))
$$;

-- F2.

create function pharmacy.stock_list(requested_q text, requested_filter text, requested_page integer)
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
  answer jsonb;
begin
  select * into actor from commercial.caller('pharmacy.stock.read');
  if (requested_filter is not null and requested_filter not in ('low', 'expiring')) or page_value not between 1 and 1000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "filter"}';
  end if;
  q := commercial.search_text(requested_q);
  select array_agg(listed.id order by listed.ord) into ids from (
    select item.id, row_number() over (order by lower(item.name) collate "C", item.id) as ord
      from commercial.catalogue_items item
      join pharmacy.stock_items stock on stock.catalogue_item_id = item.id
     where item.facility_id = actor.facility_id and item.kind = 'drug'
       and commercial.name_matches(item.name, q)
       and (requested_filter is null
            or (requested_filter = 'low'
                and coalesce((select sum(batch.on_hand) from pharmacy.stock_batches batch
                               where batch.catalogue_item_id = item.id
                                 and batch.expires_on >= commercial.lagos_day(clock_timestamp())), 0) <= stock.reorder_level)
            or (requested_filter = 'expiring'
                and exists (select 1 from pharmacy.stock_batches batch
                             where batch.catalogue_item_id = item.id and batch.on_hand > 0
                               and batch.expires_on < commercial.lagos_day(clock_timestamp()) + 90)))
     order by lower(item.name) collate "C", item.id
     offset (page_value - 1) * 50 limit 51) listed;
  answer := jsonb_build_object('items', coalesce((select jsonb_agg(pharmacy.stock_line_json(listed.id) order by listed.ord)
                                                    from unnest(coalesce(ids[1:50], array[]::uuid[])) with ordinality listed(id, ord)),
                                                  '[]'::jsonb),
    'nextPage', case when coalesce(cardinality(ids), 0) > 50 then page_value + 1 end);
  perform commercial.audit('pharmacy.stock.read', 'success', 'stock', null, null,
    jsonb_build_object('filter', requested_filter, 'page', page_value), 'pharmacy-api');
  return answer;
end
$$;

-- Stock settings: the unit (cannot change while any batch holds stock) and
-- the reorder level. Makes the item stock-kept. Only drug items.
create function pharmacy.stock_settings_put(requested_item uuid, unit_value text, reorder_value integer,
  expected_version bigint, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  item commercial.catalogue_items%rowtype;
  stock pharmacy.stock_items%rowtype;
begin
  select * into actor from commercial.caller('pharmacy.stock.manage');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'stock.settings');
  if replay.replayed then
    return pharmacy.stock_line_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  if unit_value is null or unit_value <> btrim(unit_value) or char_length(unit_value) not between 1 and 40 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "unit"}';
  end if;
  if reorder_value is null or reorder_value not between 0 and 1000000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reorderLevel"}';
  end if;
  select catalogue_item.* into item from commercial.catalogue_items catalogue_item
   where catalogue_item.id = requested_item and catalogue_item.facility_id = actor.facility_id for update;
  if not found or item.kind <> 'drug' then
    raise exception using errcode = 'HB404', message = 'CATALOGUE_ITEM_NOT_FOUND';
  end if;
  select stock_item.* into stock from pharmacy.stock_items stock_item
   where stock_item.catalogue_item_id = item.id for update;
  if coalesce(stock.row_version, 0) <> coalesce(expected_version, -1) then
    raise exception using errcode = 'HB412', message = 'VERSION_CONFLICT';
  end if;
  if stock.unit is not null and stock.unit <> unit_value
     and exists (select 1 from pharmacy.stock_batches batch where batch.catalogue_item_id = item.id and batch.on_hand > 0) then
    raise exception using errcode = 'HB409', message = 'STOCK_UNIT_LOCKED';
  end if;
  insert into pharmacy.stock_items (facility_id, catalogue_item_id, unit, reorder_level, updated_by_membership_id,
    idempotency_key, request_sha256)
  values (actor.facility_id, item.id, unit_value, reorder_value, actor.membership_id, requested_key, requested_sha256)
  on conflict (catalogue_item_id) do update
    set unit = excluded.unit, reorder_level = excluded.reorder_level,
        updated_by_membership_id = excluded.updated_by_membership_id, idempotency_key = excluded.idempotency_key,
        request_sha256 = excluded.request_sha256, row_version = pharmacy.stock_items.row_version + 1,
        updated_at = clock_timestamp();
  if not item.stock_kept then
    update commercial.catalogue_items catalogue_item
       set stock_kept = true, row_version = catalogue_item.row_version + 1, updated_at = clock_timestamp(),
           updated_by_membership_id = actor.membership_id
     where catalogue_item.id = item.id;
    insert into commercial.catalogue_events (facility_id, catalogue_item_id, kind, membership_id, before_value,
      after_value, idempotency_key, request_sha256)
    values (actor.facility_id, item.id, 'stock_settings', actor.membership_id, jsonb_build_object('stockKept', false),
      jsonb_build_object('stockKept', true, 'unit', unit_value, 'reorderLevel', reorder_value), requested_key,
      requested_sha256);
  end if;
  perform commercial.command_record(requested_key, requested_sha256, 'stock.settings', item.id);
  perform commercial.audit('pharmacy.stock.settings', 'success', 'catalogue-item', item.id::text, null,
    jsonb_build_object('reorderLevel', reorder_value), 'pharmacy-api');
  return pharmacy.stock_line_json(item.id);
end
$$;

-- Goods received: 1-100 lines by batch. The same item, batch number and expiry
-- adds to the batch; the same batch number with another expiry is refused.
create function pharmacy.stock_receive(requested jsonb, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  receipt_id uuid;
  line jsonb;
  item_id uuid;
  batch_id uuid;
  batch_expiry date;
  quantity_value integer;
  expiry date;
  cost bigint;
  today date := commercial.lagos_day(clock_timestamp());
  items uuid[] := array[]::uuid[];
  total integer := 0;
begin
  select * into actor from commercial.caller('pharmacy.stock.manage');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'stock.receipt');
  if replay.replayed then
    return jsonb_build_object('items', coalesce((select jsonb_agg(pharmacy.stock_line_json(distinct_item.id))
             from (select distinct receipt_line.catalogue_item_id as id from pharmacy.stock_receipt_lines receipt_line
                    where receipt_line.receipt_id = replay.resource_id) distinct_item), '[]'::jsonb), 'replayed', true);
  end if;
  if jsonb_typeof(requested) <> 'object' or jsonb_typeof(requested->'lines') <> 'array'
     or jsonb_array_length(requested->'lines') not between 1 and 100 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "lines"}';
  end if;
  if char_length(coalesce(requested->>'supplier', '')) > 120 or char_length(coalesce(requested->>'invoiceNumber', '')) > 60 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "supplier"}';
  end if;
  insert into pharmacy.stock_receipts (facility_id, supplier, invoice_number, received_by_membership_id, idempotency_key,
    request_sha256)
  values (actor.facility_id, nullif(btrim(requested->>'supplier'), ''), nullif(btrim(requested->>'invoiceNumber'), ''),
    actor.membership_id, requested_key, requested_sha256)
  returning id into receipt_id;
  for line in select value from jsonb_array_elements(requested->'lines') loop
    if jsonb_typeof(line) <> 'object'
       or coalesce(line->>'catalogueItemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(line->>'batchNumber', '') <> btrim(coalesce(line->>'batchNumber', ''))
       or char_length(coalesce(line->>'batchNumber', '')) not between 1 and 60
       or coalesce(line->>'expiresOn', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or jsonb_typeof(line->'quantity') <> 'number'
       or (line->>'quantity')::numeric <> trunc((line->>'quantity')::numeric)
       or (line->>'quantity')::numeric not between 1 and 1000000
       or (line ? 'unitCostKobo' and jsonb_typeof(line->'unitCostKobo') not in ('number', 'null'))
       or (jsonb_typeof(line->'unitCostKobo') = 'number'
           and ((line->>'unitCostKobo')::numeric <> trunc((line->>'unitCostKobo')::numeric)
                or (line->>'unitCostKobo')::numeric not between 0 and 100000000)) then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "lines"}';
    end if;
    begin
      expiry := (line->>'expiresOn')::date;
    exception when others then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "expiresOn"}';
    end;
    if expiry <= today then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "expiresOn"}';
    end if;
    item_id := (line->>'catalogueItemId')::uuid;
    quantity_value := (line->>'quantity')::numeric::integer;
    cost := case when jsonb_typeof(line->'unitCostKobo') = 'number' then (line->>'unitCostKobo')::numeric::bigint end;
    if not exists (select 1 from commercial.catalogue_items item where item.id = item_id
                    and item.facility_id = actor.facility_id) then
      raise exception using errcode = 'HB404', message = 'CATALOGUE_ITEM_NOT_FOUND';
    end if;
    if not exists (select 1 from pharmacy.stock_items stock join commercial.catalogue_items item on item.id = stock.catalogue_item_id
                    where stock.catalogue_item_id = item_id and item.stock_kept) then
      raise exception using errcode = 'HB409', message = 'STOCK_NOT_KEPT';
    end if;
    batch_id := null;
    select batch.id, batch.expires_on into batch_id, batch_expiry from pharmacy.stock_batches batch
     where batch.facility_id = actor.facility_id and batch.catalogue_item_id = item_id
       and batch.batch_number = line->>'batchNumber' for update;
    if batch_id is not null and batch_expiry <> expiry then
      raise exception using errcode = 'HB409', message = 'BATCH_EXPIRY_MISMATCH';
    end if;
    if batch_id is null then
      insert into pharmacy.stock_batches (facility_id, catalogue_item_id, batch_number, expires_on, on_hand, unit_cost_kobo)
      values (actor.facility_id, item_id, line->>'batchNumber', expiry, quantity_value, cost)
      returning id into batch_id;
    else
      update pharmacy.stock_batches batch
         set on_hand = batch.on_hand + quantity_value, unit_cost_kobo = coalesce(cost, batch.unit_cost_kobo),
             row_version = batch.row_version + 1, updated_at = clock_timestamp()
       where batch.id = batch_id;
    end if;
    insert into pharmacy.stock_receipt_lines (facility_id, receipt_id, catalogue_item_id, batch_id, quantity, unit_cost_kobo)
    values (actor.facility_id, receipt_id, item_id, batch_id, quantity_value, cost);
    insert into pharmacy.stock_movements (facility_id, catalogue_item_id, batch_id, change, kind, receipt_id, membership_id)
    values (actor.facility_id, item_id, batch_id, quantity_value, 'receipt', receipt_id, actor.membership_id);
    items := array_append(items, item_id);
    total := total + quantity_value;
  end loop;
  perform commercial.command_record(requested_key, requested_sha256, 'stock.receipt', receipt_id);
  perform commercial.audit('pharmacy.stock.receipt', 'success', 'stock-receipt', receipt_id::text, null,
    jsonb_build_object('lines', jsonb_array_length(requested->'lines'), 'units', total), 'pharmacy-api');
  return jsonb_build_object('items', coalesce((select jsonb_agg(pharmacy.stock_line_json(distinct_item.id))
           from (select distinct unnest(items) as id) distinct_item), '[]'::jsonb));
end
$$;

create function pharmacy.stock_adjust(requested jsonb, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  batch pharmacy.stock_batches%rowtype;
  change_value integer;
  adjustment_id uuid;
begin
  select * into actor from commercial.caller('pharmacy.stock.manage');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'stock.adjustment');
  if replay.replayed then
    return pharmacy.stock_line_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  if jsonb_typeof(requested) <> 'object'
     or coalesce(requested->>'catalogueItemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(requested->>'batchId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(requested->'change') <> 'number'
     or (requested->>'change')::numeric <> trunc((requested->>'change')::numeric)
     or (requested->>'change')::numeric = 0 or abs((requested->>'change')::numeric) > 100000000
     or coalesce(requested->>'reason', '') not in ('damaged', 'expired', 'count', 'returned')
     or char_length(coalesce(requested->>'note', '')) > 500
     or (requested->>'reason' = 'count' and length(btrim(coalesce(requested->>'note', ''))) = 0) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "change"}';
  end if;
  change_value := (requested->>'change')::numeric::integer;
  select stock_batch.* into batch from pharmacy.stock_batches stock_batch
   where stock_batch.id = (requested->>'batchId')::uuid and stock_batch.facility_id = actor.facility_id
     and stock_batch.catalogue_item_id = (requested->>'catalogueItemId')::uuid for update;
  if not found then
    raise exception using errcode = 'HB404', message = 'CATALOGUE_ITEM_NOT_FOUND';
  end if;
  if batch.on_hand + change_value < 0 then
    raise exception using errcode = 'HB409', message = 'STOCK_BELOW_ZERO';
  end if;
  insert into pharmacy.stock_adjustments (facility_id, catalogue_item_id, batch_id, change, reason, note, membership_id,
    idempotency_key, request_sha256)
  values (actor.facility_id, batch.catalogue_item_id, batch.id, change_value, requested->>'reason',
    nullif(btrim(requested->>'note'), ''), actor.membership_id, requested_key, requested_sha256)
  returning id into adjustment_id;
  update pharmacy.stock_batches stock_batch
     set on_hand = stock_batch.on_hand + change_value, row_version = stock_batch.row_version + 1,
         updated_at = clock_timestamp()
   where stock_batch.id = batch.id;
  insert into pharmacy.stock_movements (facility_id, catalogue_item_id, batch_id, change, kind, adjustment_id, membership_id)
  values (actor.facility_id, batch.catalogue_item_id, batch.id, change_value, 'adjustment', adjustment_id,
    actor.membership_id);
  perform commercial.command_record(requested_key, requested_sha256, 'stock.adjustment', batch.catalogue_item_id);
  perform commercial.audit('pharmacy.stock.adjustment', 'success', 'stock-batch', batch.id::text, null,
    jsonb_build_object('change', change_value, 'reason', requested->>'reason'), 'pharmacy-api');
  return pharmacy.stock_line_json(batch.catalogue_item_id);
end
$$;

-- An item's movements, newest first, 50 per page. No patient is shown.
create function pharmacy.stock_movement_list(requested_item uuid, requested_page integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  page_value integer := coalesce(requested_page, 1);
  ids uuid[];
begin
  select * into actor from commercial.caller('pharmacy.stock.read');
  if page_value not between 1 and 1000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "page"}';
  end if;
  if not exists (select 1 from pharmacy.stock_items stock where stock.catalogue_item_id = requested_item
                  and stock.facility_id = actor.facility_id) then
    raise exception using errcode = 'HB404', message = 'CATALOGUE_ITEM_NOT_FOUND';
  end if;
  select array_agg(listed.id order by listed.ord) into ids from (
    select movement.id, row_number() over (order by movement.created_at desc, movement.id desc) as ord
      from pharmacy.stock_movements movement where movement.catalogue_item_id = requested_item
     order by movement.created_at desc, movement.id desc offset (page_value - 1) * 50 limit 51) listed;
  perform commercial.audit('pharmacy.stock.movements.read', 'success', 'catalogue-item', requested_item::text, null,
    jsonb_build_object('page', page_value), 'pharmacy-api');
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('id', movement.id, 'kind', movement.kind,
             'change', movement.change, 'batchId', movement.batch_id, 'batchNumber', batch.batch_number,
             'reason', adjustment.reason, 'at', movement.created_at,
             'by', case when movement.membership_id is null then null else commercial.member_name(movement.membership_id) end)
             order by listed.ord)
           from unnest(coalesce(ids[1:50], array[]::uuid[])) with ordinality listed(id, ord)
           join pharmacy.stock_movements movement on movement.id = listed.id
           join pharmacy.stock_batches batch on batch.id = movement.batch_id
           left join pharmacy.stock_adjustments adjustment on adjustment.id = movement.adjustment_id), '[]'::jsonb),
    'nextPage', case when coalesce(cardinality(ids), 0) > 50 then page_value + 1 end);
end
$$;

-- A counter sale (BILL-13: counter only in release 1): a new pharmacy bill,
-- anonymous (a name the customer gave, optional) or on a Health ID (a patient
-- lookup, audited; only the bill is put on the patient). A prescription-only
-- item needs the outside prescriber. The phone is checked, never stored.
create function pharmacy.counter_sale_create(requested jsonb, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  patient_input jsonb := requested->'patient';
  outside jsonb := requested->'outside';
  patient_value uuid;
  bill_id uuid;
  line jsonb;
  line_id uuid;
begin
  select * into actor from commercial.caller('pharmacy.walk-in.create');
  perform set_config('hid.billing_source', 'pharmacy-api', true);
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'sale.counter-create');
  if replay.replayed then
    return jsonb_build_object('workItemIds', '[]'::jsonb, 'bill', commercial.bill_json(replay.resource_id), 'replayed', true);
  end if;
  if jsonb_typeof(requested) <> 'object' then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED';
  end if;
  if coalesce(requested->'counter', 'false'::jsonb) <> 'true'::jsonb then
    raise exception using errcode = 'HB409', message = 'WALK_IN_QUEUE_NOT_AVAILABLE';
  end if;
  if jsonb_typeof(requested->'items') <> 'array' or jsonb_array_length(requested->'items') not between 1 and 50
     or exists (select 1 from jsonb_array_elements(requested->'items') listed
                 where jsonb_typeof(listed) <> 'object'
                    or coalesce(listed->>'catalogueItemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    or jsonb_typeof(listed->'quantity') <> 'number'
                    or (listed->>'quantity')::numeric <> trunc((listed->>'quantity')::numeric)
                    or (listed->>'quantity')::numeric not between 1 and 10000) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "items"}';
  end if;
  if outside is not null and jsonb_typeof(outside) <> 'null'
     and (jsonb_typeof(outside) <> 'object' or outside ? 'photoFileId'
          or (outside ? 'prescriberName' and char_length(btrim(coalesce(outside->>'prescriberName', ''))) not between 2 and 120)
          or char_length(coalesce(outside->>'facilityName', '')) > 120
          or (outside->>'writtenOn' is not null and outside->>'writtenOn' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "outside"}';
  end if;
  if exists (select 1 from jsonb_array_elements(requested->'items') listed
               join commercial.catalogue_items item on item.id = (listed->>'catalogueItemId')::uuid
                and item.facility_id = actor.facility_id and item.active
              where item.prescription_only)
     and char_length(btrim(coalesce(outside->>'prescriberName', ''))) not between 2 and 120 then
    raise exception using errcode = 'HB422', message = 'PRESCRIPTION_REQUIRED';
  end if;
  if jsonb_typeof(patient_input) <> 'object' then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "patient"}';
  end if;
  if patient_input->>'kind' = 'anonymous' then
    if char_length(coalesce(patient_input->>'name', '')) > 120
       or (patient_input->>'phone' is not null and patient_input->>'phone' !~ '^\+[1-9][0-9]{7,14}$') then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "patient"}';
    end if;
  elsif patient_input->>'kind' = 'health_id' then
    patient_value := commercial.resolve_health_id(patient_input->>'healthId', 'pharmacy-api');
  else
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "patient"}';
  end if;
  bill_id := commercial.bill_new(actor.facility_id, 'pharmacy', patient_value, null,
    case when patient_value is null then patient_input->>'name' end, true, actor.membership_id, requested_key,
    requested_sha256);
  for line in select value from jsonb_array_elements(requested->'items') loop
    if not exists (select 1 from commercial.catalogue_items item where item.id = (line->>'catalogueItemId')::uuid
                    and item.facility_id = actor.facility_id and item.active and item.kind <> 'lab_test') then
      raise exception using errcode = 'HB404', message = 'CATALOGUE_ITEM_NOT_FOUND';
    end if;
    line_id := commercial.bill_line_put(bill_id, (line->>'catalogueItemId')::uuid, (line->>'quantity')::numeric::integer,
      'counter', null, null, false, null, actor.membership_id, requested_key, requested_sha256);
  end loop;
  perform commercial.command_record(requested_key, requested_sha256, 'sale.counter-create', bill_id);
  perform commercial.audit('pharmacy.sale.counter-create', 'success', 'bill', bill_id::text, patient_value,
    jsonb_build_object('items', jsonb_array_length(requested->'items'), 'onHealthId', patient_value is not null,
      'outsidePrescription', outside is not null and jsonb_typeof(outside) = 'object'), 'pharmacy-api');
  return jsonb_build_object('workItemIds', '[]'::jsonb, 'bill', commercial.bill_json(bill_id));
end
$$;

-- Hands over a paid counter sale: every stock-kept drug line is taken
-- expiry-first (all or nothing); items not stock-kept are handed over
-- without a count. A counter sale is always paid first.
create function pharmacy.sale_hand_over(requested_bill uuid, expected_version bigint, requested_key text,
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
  line record;
  taken jsonb := '[]'::jsonb;
begin
  select * into actor from commercial.caller('pharmacy.dispensing.create');
  perform set_config('hid.billing_source', 'pharmacy-api', true);
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'sale.hand-over');
  if replay.replayed then
    return jsonb_build_object('handedOverAt', commercial.bill_json(replay.resource_id)->'handedOverAt',
      'bill', commercial.bill_json(replay.resource_id), 'replayed', true);
  end if;
  bill := commercial.bill_lock(requested_bill, actor.facility_id, expected_version);
  if not bill.counter then
    raise exception using errcode = 'HB409', message = 'BILL_NOT_A_COUNTER_SALE';
  end if;
  if bill.handed_over_at is not null then
    raise exception using errcode = 'HB409', message = 'ALREADY_HANDED_OVER';
  end if;
  if bill.status <> 'paid' then
    raise exception using errcode = 'HB409', message = 'PAYMENT_REQUIRED';
  end if;
  if bill.pending_check_kobo > 0 then
    raise exception using errcode = 'HB409', message = 'PAYMENT_PENDING_CHECK';
  end if;
  for line in
    select bill_line.id, bill_line.catalogue_item_id, bill_line.quantity from commercial.bill_lines bill_line
      join commercial.catalogue_items item on item.id = bill_line.catalogue_item_id
     where bill_line.bill_id = bill.id and not bill_line.cancelled and item.kind = 'drug' and item.stock_kept
     order by bill_line.created_at, bill_line.id
  loop
    taken := taken || jsonb_build_array(jsonb_build_object('lineId', line.id, 'batches',
      pharmacy.take_stock_expiry_first(actor.facility_id, line.catalogue_item_id, line.quantity, null, 'counter_sale',
        null, line.id, actor.membership_id)));
  end loop;
  update commercial.bills bill_row
     set handed_over_at = clock_timestamp(), handed_over_by_membership_id = actor.membership_id,
         row_version = bill_row.row_version + 1, updated_at = clock_timestamp()
   where bill_row.id = bill.id;
  perform commercial.bill_event(bill.id, bill.facility_id, 'hand-over', actor.membership_id,
    jsonb_build_object('stockTaken', taken));
  perform commercial.command_record(requested_key, requested_sha256, 'sale.hand-over', bill.id);
  perform commercial.audit('pharmacy.sale.hand-over', 'success', 'bill', bill.id::text, bill.patient_id,
    jsonb_build_object('stockTaken', taken), 'pharmacy-api');
  return jsonb_build_object('handedOverAt', commercial.bill_json(bill.id)->'handedOverAt',
    'bill', commercial.bill_json(bill.id));
end
$$;

-- The stock of the medication codes of the work items a pharmacist lists
-- (pharmacy-api passes the codes of the rows it already read under its own
-- row-level security): for each code a stock-kept item has here, its on hand
-- (batches not expired) and unit. No patient, no work item id.
create function pharmacy.stock_for_codes(requested jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
begin
  if jsonb_typeof(requested) <> 'array' or jsonb_array_length(requested) > 200 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "codes"}';
  end if;
  select * into actor from commercial.caller('pharmacy.work-item.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object('codeSystem', wanted.code_system, 'code', wanted.code,
             'onHand', (pharmacy.stock_line_json(item.id)->>'onHand')::integer, 'unit', stock.unit)
             order by wanted.code_system, wanted.code)
      from (select distinct entry->>'codeSystem' as code_system, entry->>'code' as code
              from jsonb_array_elements(requested) entry
             where jsonb_typeof(entry) = 'object') wanted
      join commercial.catalogue_items item
        on item.facility_id = actor.facility_id and item.active and item.kind = 'drug' and item.stock_kept
       and item.national_code_system = wanted.code_system and item.national_code = wanted.code
      join pharmacy.stock_items stock on stock.catalogue_item_id = item.id), '[]'::jsonb);
end
$$;

-- Grants (here and in runtime-grants.sql).
revoke all on function pharmacy.stock_line_json(uuid),
  pharmacy.take_stock_expiry_first(uuid, uuid, integer, uuid, text, uuid, uuid, uuid),
  pharmacy.stock_put_back(uuid, uuid, uuid, uuid), pharmacy.stock_item_for_code(uuid, text, text),
  pharmacy.stock_ledger_agrees(uuid), pharmacy.stock_list(text, text, integer),
  pharmacy.stock_settings_put(uuid, text, integer, bigint, text, text), pharmacy.stock_receive(jsonb, text, text),
  pharmacy.stock_adjust(jsonb, text, text), pharmacy.stock_movement_list(uuid, integer),
  pharmacy.counter_sale_create(jsonb, text, text), pharmacy.sale_hand_over(uuid, bigint, text, text),
  pharmacy.stock_for_codes(jsonb) from public;
do $grants$
declare
  runtime_role text;
begin
  foreach runtime_role in array array['hid_pharmacy_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function pharmacy.stock_list(text, text, integer), '
        || 'pharmacy.stock_settings_put(uuid, text, integer, bigint, text, text), pharmacy.stock_receive(jsonb, text, text), '
        || 'pharmacy.stock_adjust(jsonb, text, text), pharmacy.stock_movement_list(uuid, integer), '
        || 'pharmacy.counter_sale_create(jsonb, text, text), pharmacy.sale_hand_over(uuid, bigint, text, text), '
        || 'pharmacy.stock_for_codes(jsonb) to %I',
        runtime_role);
    end if;
  end loop;
end
$grants$;

comment on table pharmacy.stock_batches is
  '0166 (POC section 5, BILL-12): stock by batch and expiry in whole units of the item''s stock unit; issued expiry-first, never from an expired batch; on hand equals the sum of its movements (pharmacy.stock_ledger_agrees).';
comment on table pharmacy.stock_movements is
  '0166: the append-only stock ledger: receipt, adjustment, dispensing, dispensing_reversal, counter_sale. No patient.';

-- Post-checks.
do $post$
declare
  made constant jsonb := '{
    "pharmacy.counter_sale_create(jsonb,text,text)": "ad3363d113221c8c2ed10d4f4dfb5fd9",
    "pharmacy.sale_hand_over(uuid,bigint,text,text)": "6892fba41511093e018686dbb74517d9",
    "pharmacy.stock_adjust(jsonb,text,text)": "e4dd58dfab08d478776610cc860a4a55",
    "pharmacy.stock_for_codes(jsonb)": "43704ba1515810af6a53e1ce722f241b",
    "pharmacy.stock_item_for_code(uuid,text,text)": "08796082b6e770b346546f921690027b",
    "pharmacy.stock_ledger_agrees(uuid)": "7c969a1bdf3f2f4fcb9cd7d543628744",
    "pharmacy.stock_line_json(uuid)": "0a7e1acead9c386d4bd2d53d3a59d971",
    "pharmacy.stock_list(text,text,integer)": "0f5bec7fd52be30c18900f418462c622",
    "pharmacy.stock_movement_list(uuid,integer)": "3af24dd992eb5d8de566a38b7fd1c207",
    "pharmacy.stock_put_back(uuid,uuid,uuid,uuid)": "19078fe0215f418b02dd4ae2885c6e74",
    "pharmacy.stock_receive(jsonb,text,text)": "adfcdb3316b588a80810a5a1f06fb303",
    "pharmacy.stock_settings_put(uuid,text,integer,bigint,text,text)": "e671fcc0534789f36dfdf56d7c6bd82e",
    "pharmacy.take_stock_expiry_first(uuid,uuid,integer,uuid,text,uuid,uuid,uuid)": "45339666f7904c888dd7d675044c156f"}';
  own constant text[] := array['pharmacy.stock_line_json(uuid)',
    'pharmacy.take_stock_expiry_first(uuid,uuid,integer,uuid,text,uuid,uuid,uuid)',
    'pharmacy.stock_put_back(uuid,uuid,uuid,uuid)', 'pharmacy.stock_item_for_code(uuid,text,text)',
    'pharmacy.stock_ledger_agrees(uuid)', 'pharmacy.stock_list(text,text,integer)',
    'pharmacy.stock_settings_put(uuid,text,integer,bigint,text,text)', 'pharmacy.stock_receive(jsonb,text,text)',
    'pharmacy.stock_adjust(jsonb,text,text)', 'pharmacy.stock_movement_list(uuid,integer)',
    'pharmacy.counter_sale_create(jsonb,text,text)', 'pharmacy.sale_hand_over(uuid,bigint,text,text)',
    'pharmacy.stock_for_codes(jsonb)'];
  granted constant text[] := array['pharmacy.stock_list(text,text,integer)',
    'pharmacy.stock_settings_put(uuid,text,integer,bigint,text,text)', 'pharmacy.stock_receive(jsonb,text,text)',
    'pharmacy.stock_adjust(jsonb,text,text)', 'pharmacy.stock_movement_list(uuid,integer)',
    'pharmacy.counter_sale_create(jsonb,text,text)', 'pharmacy.sale_hand_over(uuid,bigint,text,text)',
    'pharmacy.stock_for_codes(jsonb)'];
  tables constant text[] := array['pharmacy.stock_items', 'pharmacy.stock_batches', 'pharmacy.stock_receipts',
    'pharmacy.stock_receipt_lines', 'pharmacy.stock_adjustments', 'pharmacy.stock_movements'];
  owner_oid oid := (select nspowner from pg_namespace where nspname = 'commercial');
  computed jsonb;
  differing text;
begin
  select jsonb_object_agg(signature, md5(proc.prosrc)) into computed
    from unnest(own) signature join pg_proc proc on proc.oid = to_regprocedure(signature);
  if (select count(*) from jsonb_object_keys(computed)) <> cardinality(own) then
    raise exception using errcode = '55000', message = '0166: post-check failed: a function is missing';
  end if;
  if made = '{}'::jsonb then
    raise notice '0166 made: %', computed;
  elsif computed is distinct from made then
    select string_agg(key, ', ') into differing from jsonb_each_text(made) where computed->>key is distinct from value;
    raise exception using errcode = '55000', message = '0166: post-check failed: functions differ: ' || differing;
  end if;
  if exists (select 1 from unnest(own) signature, pg_proc proc
              where proc.oid = to_regprocedure(signature)
                and (proc.proowner <> owner_oid or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
                     or proc.prosecdef <> (signature = any (granted)))) then
    raise exception using errcode = '55000', message = '0166: post-check failed: a function''s owner, search_path or SECURITY DEFINER';
  end if;
  if exists (select 1 from unnest(own) signature, pg_proc proc,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = to_regprocedure(signature) and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or not (signature = any (granted))
                     or pg_get_userbyid(acl.grantee) not in ('hid_pharmacy_runtime', 'hid_schema_test_runtime'))) then
    raise exception using errcode = '55000', message = '0166: post-check failed: a function is granted to another role';
  end if;
  if (select count(*) from pg_class relation
       where relation.oid = any (select to_regclass(name) from unnest(tables) name)
         and relation.relrowsecurity and relation.relforcerowsecurity and relation.relowner = owner_oid
         and (select count(*) from pg_policy policy where policy.polrelid = relation.oid) = 1
         and not exists (select 1 from lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                          where acl.grantee <> relation.relowner)
         and (select count(*) from pg_trigger trigger_row where trigger_row.tgrelid = relation.oid
               and not trigger_row.tgisinternal and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure) = 2)
     <> cardinality(tables) then
    raise exception using errcode = '55000', message = '0166: post-check failed: a table''s row-level security, policy, ACL or guards';
  end if;
end
$post$;
