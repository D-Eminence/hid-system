-- 0165 BILL-1 (Release D): till days (end of day), and the money commands
-- that need them: taking a payment or recording HMO cover, confirming a
-- transfer, voiding a payment, the receipt, and online payments (built,
-- switched off). Written on claude/sprint-billing-backend (staging at
-- 95fa1e52, 0001-0151 applied) after 0162-0164 in the same pull request.
-- Provisional number (Release D block 0162-0167); nothing here reads
-- 0152-0154. No migration number appears inside a function body. The
-- declaration is signed separately.
--
-- Owner decisions: the sprint approval of 25 November 2026 (BILL-4 A: a void
-- only by someone other than the member who took the payment; BILL-6 A:
-- online only, with the paper receipt book's number entered later), and at
-- the recommended option, not yet answered: BILL-8 (HMO cover is no
-- payment), BILL-10 ("till day", so that "shift" stays free for the clinical
-- rota; the routes keep /commercial/shifts), BILL-11 (a transfer waiting to
-- be checked lowers what is owed but does not meet pay-before), BILL-14
-- (online payment through the facility's own Paystack account, switched
-- off), BILL-16 (receipt numbers per payment, R-YYYY-nnnnnn, gap-free per
-- facility and year; a void keeps its number).
--
-- WHAT IT DOES
-- T1 commercial.till_days: one per scope at a time (a unique partial index):
--    the facility, one cashier (membership) or one till, as the facility's
--    dayCloseBy says; who opened it and when, the opening cash, and once
--    closed who closed it, the counted cash, the expected cash, the
--    difference and the note. A closed day never changes (a trigger).
-- T2 commercial.payments.till_day_id and void_till_day_id get their foreign
--    keys (added NOT VALID, then validated): a payment is recorded in the day
--    it was taken in; its void is a negative entry in the voider's open day,
--    so a closed day never changes.
-- F1 Helpers (owner only): commercial.day_json (the built page's Shift: totals
--    by method from payments taken in the day minus voids recorded in it;
--    waivers apart, never in the expected cash; HMO cover for information
--    only; expected cash = opening + cash taken - cash voided; overdue from
--    06:00 Lagos the next day), commercial.day_scope (the scope a member's
--    day has), commercial.open_day (the open day of a scope),
--    commercial.counter_staff_only (the member's roles here are only
--    pharmacist and lab).
-- F2 For the EHR runtime and the schema test runtime: commercial.day_current,
--    commercial.day_open, commercial.day_close, commercial.day_list,
--    commercial.payment_record (cash, POS with its RRN, transfer pending a
--    second person's check, waiver with a reason by billing.payment.waive,
--    and HMO, which becomes an HMO cover), commercial.payment_confirm,
--    commercial.payment_void, commercial.receipt, and
--    commercial.payment_record_online (the Paystack webhook's verified
--    payment, by reference sha256; duplicates answer the payment already
--    recorded). Each checks the caller's code at the session facility,
--    locks the bill FOR UPDATE first (two payments at once never overpay),
--    keeps the totals and writes its audit row; no row holds a POS RRN,
--    transfer reference, approval code or reason text in its audit row.
-- T1: facility_id on every row, row-level security forced with the owner
-- policy at the session's facility, no privilege for any runtime, no DELETE
-- or TRUNCATE.
--
-- Locks: SHARE ROW EXCLUSIVE NOWAIT on identity.facilities,
-- identity.staff_facility_memberships, commercial.tills and
-- commercial.payments (the new foreign keys), in one attempt made up to 50
-- times 100 ms apart, or once when this transaction holds an earlier file's
-- locks; busy refusals begin "0165: ".
--
-- Old services: nothing calls the new functions. New services on a schema
-- without it: 503 BILLING_UNAVAILABLE.
--
-- Undo (docs/rollback/0165_till_days_and_end_of_day.md): drop F2, F1, the
-- two foreign keys and commercial.till_days (after 0166-0167's undo).

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
    "commercial.counter_staff_only(uuid)": "9352cab0a5c41b0c964aa989bc7cc117",
    "commercial.day_close(uuid,bigint,text,bigint,text,text)": "354d601cef08c55eb26a70665b2fcb4d",
    "commercial.day_current(uuid)": "28d175fd06c967cf3933e51fe7e02f28",
    "commercial.day_json(uuid)": "c4d01a0472dbba61f795ea4d6f10db9c",
    "commercial.day_list(date,boolean)": "49816c5c8a3bca9b495895eedbc0f8f3",
    "commercial.day_open(uuid,bigint,text,text)": "6fc0ed7510afc308baec9c2357013234",
    "commercial.day_scope(uuid,uuid,uuid)": "8566e0d7bac1aad56398e605c5e4371c",
    "commercial.open_day(uuid,text,uuid,uuid)": "32cfdd2e39dbc54d2ac9b170bdcb3b7e",
    "commercial.payment_confirm(uuid,uuid,bigint,text,text)": "f3e5670564647a04af1bdaf72a396868",
    "commercial.payment_record(uuid,jsonb,bigint,text,text)": "6c8508f08ac39235ee70f765addf94ab",
    "commercial.payment_record_online(uuid,bigint,text)": "78745468a013ccd1eb8945b28dbedfc6",
    "commercial.payment_void(uuid,uuid,text,bigint,uuid,text,text)": "61db3fcf0e35490c223a46231085e1c4",
    "commercial.receipt(uuid,uuid)": "c8966d9f317b4a4771af010ae42dd76d",
    "commercial.till_day_closed_guard()": "3201a28156e7eadb975afd56adc0c9ea"}';
  present integer;
  differing text;
begin
  if to_regclass('commercial.payments') is null or to_regclass('commercial.tills') is null
     or to_regprocedure('commercial.bill_recompute(uuid)') is null then
    raise exception using errcode = '55000', message = '0165: 0001-0151 and 0162-0164 must be applied first';
  end if;
  loop
    attempt := attempt + 1;
    begin
      lock table identity.facilities, identity.staff_facility_memberships, commercial.tills, commercial.payments
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0165: identity.facilities, identity.staff_facility_memberships, commercial.tills or '
            || 'commercial.payments is busy, and this transaction already holds an earlier migration''s locks, so it '
            || 'does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0165: identity.facilities, identity.staff_facility_memberships, commercial.tills or '
            || 'commercial.payments stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
  select count(*) into present from jsonb_object_keys(made) signature where to_regprocedure(signature) is not null;
  if present > 0 or to_regclass('commercial.till_days') is not null then
    select string_agg(signature, ', ') into differing from jsonb_each_text(made) pinned(signature, digest)
     where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(pinned.signature))
           is distinct from pinned.digest;
    if differing is null and present = (select count(*) from jsonb_object_keys(made)) then
      raise exception using errcode = '55000', message = '0165: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0165: an object this file makes exists with other content: ' || coalesce(differing, 'a table');
  end if;
end
$pre$;

-- 1. Till days.
create table commercial.till_days (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  scope text not null check (scope in ('facility', 'cashier', 'till')),
  membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  till_id uuid,
  opened_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  opened_at timestamptz not null default clock_timestamp(),
  opening_cash_kobo bigint not null check (opening_cash_kobo between 0 and 100000000),
  closed_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  closed_at timestamptz,
  counted_cash_kobo bigint check (counted_cash_kobo between 0 and 100000000),
  expected_cash_kobo bigint,
  difference_kobo bigint,
  note text check (note is null or length(note) <= 500),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  close_idempotency_key text check (close_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  close_request_sha256 char(64) check (close_request_sha256 ~ '^[0-9a-f]{64}$'),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (till_id, facility_id) references commercial.tills (id, facility_id) on delete restrict,
  constraint till_days_scope_ck check ((scope = 'cashier') = (membership_id is not null)
    and (scope = 'till') = (till_id is not null)),
  constraint till_days_closed_ck check ((closed_at is null) = (closed_by_membership_id is null)
    and (closed_at is null) = (counted_cash_kobo is null) and (closed_at is null) = (expected_cash_kobo is null)
    and (closed_at is null) = (difference_kobo is null)
    and (difference_kobo is null or difference_kobo = counted_cash_kobo - expected_cash_kobo)
    and (difference_kobo is null or difference_kobo = 0 or length(btrim(coalesce(note, ''))) > 0))
);
create unique index till_days_one_open_uq on commercial.till_days
  (facility_id, scope, coalesce(membership_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(till_id, '00000000-0000-0000-0000-000000000000'::uuid)) where closed_at is null;
create index till_days_list_idx on commercial.till_days (facility_id, opened_at desc);
alter table commercial.till_days enable row level security;
alter table commercial.till_days force row level security;
do $rls$
begin
  execute format('create policy facility_owner_rows on commercial.till_days for all using (current_user = %L and '
    || 'facility_id = platform.current_facility_id()) with check (current_user = %L and facility_id = '
    || 'platform.current_facility_id())', current_user, current_user);
end
$rls$;
revoke all on commercial.till_days from public;
create trigger no_truncate before truncate on commercial.till_days
  for each statement execute function platform.reject_mutation();
create trigger no_delete before delete on commercial.till_days
  for each row execute function platform.reject_mutation();

-- A closed day never changes.
create function commercial.till_day_closed_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.closed_at is not null then
    raise exception using errcode = 'HB409', message = 'TILL_DAY_CLOSED';
  end if;
  return new;
end
$$;
create trigger closed_day_guard before update on commercial.till_days
  for each row execute function commercial.till_day_closed_guard();

-- 2. The payments' days.
alter table commercial.payments add constraint payments_till_day_fk foreign key (till_day_id)
  references commercial.till_days (id) on delete restrict not valid;
alter table commercial.payments add constraint payments_void_till_day_fk foreign key (void_till_day_id)
  references commercial.till_days (id) on delete restrict not valid;
alter table commercial.payments validate constraint payments_till_day_fk;
alter table commercial.payments validate constraint payments_void_till_day_fk;

-- F1. Helpers.

-- The scope a member's day has here, and its till: (scope, membership, till).
create function commercial.day_scope(requested_facility uuid, requested_membership uuid, requested_till uuid)
returns table (scope text, membership_id uuid, till_id uuid)
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  mode text := coalesce((select settings.day_close_by from commercial.payment_settings settings
                          where settings.facility_id = requested_facility), 'facility');
begin
  if mode = 'till' then
    if requested_till is null or not exists (select 1 from commercial.tills till
                                              where till.id = requested_till and till.facility_id = requested_facility
                                                and till.active) then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "tillId"}';
    end if;
    return query select 'till'::text, null::uuid, requested_till;
  elsif requested_till is not null then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "tillId"}';
  elsif mode = 'cashier' then
    return query select 'cashier'::text, requested_membership, null::uuid;
  else
    return query select 'facility'::text, null::uuid, null::uuid;
  end if;
end
$$;

create function commercial.open_day(requested_facility uuid, scope_value text, membership_value uuid, till_value uuid)
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select day_row.id from commercial.till_days day_row
   where day_row.facility_id = requested_facility and day_row.scope = scope_value
     and day_row.membership_id is not distinct from membership_value and day_row.till_id is not distinct from till_value
     and day_row.closed_at is null
$$;

-- The member's roles here are only pharmacy or lab roles (wherePaid cashier
-- refuses their payment record).
create function commercial.counter_staff_only(requested_membership uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from auth.account_roles assignment
                  where assignment.membership_id = requested_membership and assignment.revoked_at is null)
     and not exists (select 1 from auth.account_roles assignment
                      where assignment.membership_id = requested_membership and assignment.revoked_at is null
                        and assignment.role_code not in ('pharmacist', 'lab', 'work_list_reader', 'reading_starter'))
$$;

create function commercial.day_json(requested_day uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  with day_row as (select * from commercial.till_days where id = requested_day),
  taken as (
    select payment.method, count(*) as taken_count, sum(payment.amount_kobo) as taken_amount
      from commercial.payments payment, day_row
     where payment.till_day_id = day_row.id group by payment.method),
  voided as (
    select payment.method, count(*) as voided_count, sum(payment.amount_kobo) as voided_amount
      from commercial.payments payment, day_row
     where payment.void_till_day_id = day_row.id group by payment.method),
  methods as (select method from taken union select method from voided),
  money as (
    select methods.method, coalesce(taken.taken_count, 0) as taken_count,
           coalesce(taken.taken_amount, 0) - coalesce(voided.voided_amount, 0) as amount
      from methods left join taken using (method) left join voided using (method)),
  expected as (
    select day_row.opening_cash_kobo + coalesce((select money.amount from money where money.method = 'cash'), 0) as value
      from day_row)
  select jsonb_build_object('id', day_row.id, 'scope', day_row.scope,
    'openedBy', commercial.member_name(day_row.opened_by_membership_id), 'openedAt', day_row.opened_at,
    'closedAt', day_row.closed_at,
    'closedBy', case when day_row.closed_by_membership_id is null then null
                     else commercial.member_name(day_row.closed_by_membership_id) end,
    'openingCashKobo', day_row.opening_cash_kobo,
    'cashierName', case when day_row.membership_id is null then null else commercial.member_name(day_row.membership_id) end,
    'tillId', day_row.till_id,
    'tillName', (select till.name from commercial.tills till where till.id = day_row.till_id),
    'totals', coalesce((select jsonb_agg(jsonb_build_object('method', money.method, 'count', money.taken_count,
                 'amountKobo', money.amount) order by array_position(array['cash', 'pos', 'transfer', 'online'], money.method))
               from money where money.method <> 'waiver'), '[]'::jsonb),
    'waivers', jsonb_build_object('count', coalesce((select money.taken_count from money where money.method = 'waiver'), 0),
                 'amountKobo', coalesce((select money.amount from money where money.method = 'waiver'), 0)),
    'hmoCovered', (select jsonb_build_object('count', count(*), 'amountKobo', coalesce(sum(cover.amount_kobo), 0))
                     from commercial.hmo_covers cover
                    where cover.facility_id = day_row.facility_id and cover.status = 'pending_claim'
                      and cover.recorded_at >= day_row.opened_at
                      and (day_row.closed_at is null or cover.recorded_at < day_row.closed_at)
                      and (day_row.membership_id is null or cover.recorded_by_membership_id = day_row.membership_id)),
    'expectedCashKobo', coalesce(day_row.expected_cash_kobo, (select expected.value from expected)),
    'countedCashKobo', day_row.counted_cash_kobo, 'differenceKobo', day_row.difference_kobo, 'note', day_row.note,
    'overdue', day_row.closed_at is null
               and (commercial.lagos_day(clock_timestamp()) > commercial.lagos_day(day_row.opened_at) + 1
                    or (commercial.lagos_day(clock_timestamp()) = commercial.lagos_day(day_row.opened_at) + 1
                        and (clock_timestamp() at time zone 'Africa/Lagos')::time >= time '06:00')),
    'unpaidBills', (select jsonb_build_object('count', count(*), 'amountKobo', coalesce(sum(bill.due_kobo), 0))
                      from commercial.bills bill
                     where bill.facility_id = day_row.facility_id and bill.status in ('unpaid', 'part_paid')
                       and bill.due_kobo > 0),
    'deferredBills', (select jsonb_build_object('count', count(*), 'amountKobo', coalesce(sum(bill.due_kobo), 0))
                        from commercial.bills bill
                       where bill.facility_id = day_row.facility_id and bill.status = 'deferred'),
    'version', day_row.row_version)
    from day_row
$$;

-- F2. Days.

create function commercial.day_current(requested_till uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  scope_row record;
  day_id uuid;
begin
  select * into actor from commercial.caller('billing.shift.own');
  select * into scope_row from commercial.day_scope(actor.facility_id, actor.membership_id, requested_till);
  day_id := commercial.open_day(actor.facility_id, scope_row.scope, scope_row.membership_id, scope_row.till_id);
  perform commercial.audit('commercial.till-day.read', 'success', 'till-day', day_id::text, null,
    jsonb_build_object('scope', scope_row.scope, 'open', day_id is not null), 'ehr-api');
  return jsonb_build_object('shift', case when day_id is null then null else commercial.day_json(day_id) end,
    'scope', scope_row.scope);
end
$$;

create function commercial.day_open(requested_till uuid, opening_cash bigint, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  scope_row record;
  day_id uuid;
begin
  select * into actor from commercial.caller('billing.shift.own');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'till-day.open');
  if replay.replayed then
    return commercial.day_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  if opening_cash is null or opening_cash not between 0 and 100000000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "openingCashKobo"}';
  end if;
  select * into scope_row from commercial.day_scope(actor.facility_id, actor.membership_id, requested_till);
  perform pg_advisory_xact_lock(hashtextextended('commercial-till-day:' || actor.facility_id::text, 0));
  if commercial.open_day(actor.facility_id, scope_row.scope, scope_row.membership_id, scope_row.till_id) is not null then
    raise exception using errcode = 'HB409', message = 'SHIFT_ALREADY_OPEN';
  end if;
  insert into commercial.till_days (facility_id, scope, membership_id, till_id, opened_by_membership_id, opening_cash_kobo,
    idempotency_key, request_sha256)
  values (actor.facility_id, scope_row.scope, scope_row.membership_id, scope_row.till_id, actor.membership_id,
    opening_cash, requested_key, requested_sha256)
  returning id into day_id;
  perform commercial.command_record(requested_key, requested_sha256, 'till-day.open', day_id);
  perform commercial.audit('commercial.till-day.open', 'success', 'till-day', day_id::text, null,
    jsonb_build_object('scope', scope_row.scope, 'openingCashKobo', opening_cash), 'ehr-api');
  return commercial.day_json(day_id);
end
$$;

-- Close a day: one's own (opened it, or the cashier whose day it is) with
-- billing.shift.own; any other with billing.shift.manage. A note is needed
-- when the counted cash differs from the expected cash.
create function commercial.day_close(requested_day uuid, counted_cash bigint, note_value text, expected_version bigint,
  requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  day_row commercial.till_days%rowtype;
  expected bigint;
begin
  select * into actor from commercial.caller('billing.shift.own');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'till-day.close');
  if replay.replayed then
    return commercial.day_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  select till_day.* into day_row from commercial.till_days till_day
   where till_day.id = requested_day and till_day.facility_id = actor.facility_id for update;
  if not found then
    raise exception using errcode = 'HB404', message = 'SHIFT_NOT_FOUND';
  end if;
  if day_row.opened_by_membership_id <> actor.membership_id
     and day_row.membership_id is distinct from actor.membership_id
     and not commercial.holds('billing.shift.manage') then
    raise exception using errcode = 'HB403', message = 'BILLING_NOT_ALLOWED';
  end if;
  if day_row.closed_at is not null then
    raise exception using errcode = 'HB409', message = 'TILL_DAY_NOT_OPEN';
  end if;
  if expected_version is null or expected_version <> day_row.row_version then
    raise exception using errcode = 'HB412', message = 'VERSION_CONFLICT';
  end if;
  if counted_cash is null or counted_cash not between 0 and 100000000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "countedCashKobo"}';
  end if;
  if note_value is not null and char_length(note_value) > 500 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "note"}';
  end if;
  expected := (commercial.day_json(day_row.id)->>'expectedCashKobo')::bigint;
  if counted_cash <> expected and length(btrim(coalesce(note_value, ''))) = 0 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "note"}';
  end if;
  update commercial.till_days till_day
     set closed_at = clock_timestamp(), closed_by_membership_id = actor.membership_id, counted_cash_kobo = counted_cash,
         expected_cash_kobo = expected, difference_kobo = counted_cash - expected, note = nullif(btrim(note_value), ''),
         close_idempotency_key = requested_key, close_request_sha256 = requested_sha256,
         row_version = till_day.row_version + 1
   where till_day.id = day_row.id;
  perform commercial.command_record(requested_key, requested_sha256, 'till-day.close', day_row.id);
  perform commercial.audit('commercial.till-day.close', 'success', 'till-day', day_row.id::text, null,
    jsonb_build_object('scope', day_row.scope, 'expectedCashKobo', expected, 'countedCashKobo', counted_cash,
      'differenceKobo', counted_cash - expected), 'ehr-api');
  if abs(counted_cash - expected) > 500000 then
    perform commercial.audit('commercial.till_day.difference_high', 'success', 'till-day', day_row.id::text, null,
      jsonb_build_object('differenceKobo', counted_cash - expected), 'ehr-api');
  end if;
  return commercial.day_json(day_row.id);
end
$$;

-- Every day opened on a Lagos day, or every open day (billing.shift.manage).
create function commercial.day_list(requested_date date, open_only boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  answer jsonb;
begin
  select * into actor from commercial.caller('billing.shift.manage');
  if requested_date is null and not coalesce(open_only, false) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "date"}';
  end if;
  select jsonb_build_object('items', coalesce(jsonb_agg(commercial.day_json(day_row.id)
           order by day_row.opened_at desc, day_row.id), '[]'::jsonb))
    into answer
    from commercial.till_days day_row
   where day_row.facility_id = actor.facility_id
     and (not coalesce(open_only, false) or day_row.closed_at is null)
     and (requested_date is null or commercial.lagos_day(day_row.opened_at) = requested_date);
  perform commercial.audit('commercial.till-day.read', 'success', 'till-day', null, null,
    jsonb_build_object('date', requested_date, 'openOnly', coalesce(open_only, false)), 'ehr-api');
  return answer;
end
$$;

-- F2. Money.

-- Take a payment (cash, POS, transfer, waiver) or record HMO cover. The bill
-- is locked first; more than is due is OVERPAYMENT; a method the facility does
-- not take is PAYMENT_METHOD_NOT_ACCEPTED; a payment needs the open day of the
-- member's scope (a waiver and an HMO cover do not).
create function commercial.payment_record(requested_bill uuid, requested jsonb, expected_version bigint,
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
  if amount > bill.due_kobo then
    raise exception using errcode = 'HB409', message = 'OVERPAYMENT';
  end if;
  -- The day it is taken in: the open day of the member's scope. A waiver is
  -- listed in that day when there is one, and needs none; HMO cover none.
  if method_value <> 'hmo' then
    begin
      select * into scope_row from commercial.day_scope(actor.facility_id, actor.membership_id, till_value);
      day_id := commercial.open_day(actor.facility_id, scope_row.scope, scope_row.membership_id, scope_row.till_id);
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

  receipt := 'R-' || year_value::text || '-' || lpad(commercial.next_number(actor.facility_id, 'receipt', year_value)::text, 6, '0');
  insert into commercial.payments (facility_id, bill_id, method, amount_kobo, reference, reason, status, receipt_number,
    till_day_id, paper_receipt_number, received_by_membership_id, idempotency_key, request_sha256)
  values (actor.facility_id, bill.id, method_value, amount, reference_value,
    case when method_value = 'waiver' then reason_value end,
    case when method_value = 'transfer' then 'pending_check' else 'recorded' end, receipt, day_id, paper_value,
    actor.membership_id, requested_key, requested_sha256)
  returning id into payment_id;
  perform commercial.bill_recompute(bill.id);
  perform commercial.bill_event(bill.id, bill.facility_id, 'payment', actor.membership_id,
    jsonb_build_object('paymentId', payment_id, 'method', method_value, 'amountKobo', amount));
  perform commercial.command_record(requested_key, requested_sha256, 'payment.record', bill.id);
  perform commercial.audit('commercial.payment.record', 'success', 'payment', payment_id::text, bill.patient_id,
    jsonb_build_object('billId', bill.id, 'method', method_value, 'amountKobo', amount,
      'status', case when method_value = 'transfer' then 'pending_check' else 'recorded' end,
      'tillDayId', day_id, 'paperReceipt', paper_value is not null), 'ehr-api');
  return commercial.bill_json(bill.id);
end
$$;

-- Confirm a transfer arrived: by someone other than the member who recorded it.
create function commercial.payment_confirm(requested_bill uuid, requested_payment uuid, expected_version bigint,
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
  payment commercial.payments%rowtype;
begin
  select * into actor from commercial.caller('billing.payment.confirm');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'payment.confirm');
  if replay.replayed then
    return commercial.bill_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  bill := commercial.bill_lock(requested_bill, actor.facility_id, expected_version);
  select payment_row.* into payment from commercial.payments payment_row
   where payment_row.id = requested_payment and payment_row.bill_id = bill.id for update;
  if not found then
    raise exception using errcode = 'HB404', message = 'PAYMENT_NOT_FOUND';
  end if;
  if payment.status <> 'pending_check' or payment.voided_at is not null then
    raise exception using errcode = 'HB409', message = 'PAYMENT_NOT_PENDING';
  end if;
  if payment.received_by_membership_id = actor.membership_id then
    raise exception using errcode = 'HB403', message = 'SECOND_PERSON_REQUIRED';
  end if;
  update commercial.payments payment_row
     set status = 'confirmed', confirmed_by_membership_id = actor.membership_id, confirmed_at = clock_timestamp(),
         row_version = payment_row.row_version + 1, updated_at = clock_timestamp()
   where payment_row.id = payment.id;
  perform commercial.bill_recompute(bill.id);
  perform commercial.bill_event(bill.id, bill.facility_id, 'confirm', actor.membership_id,
    jsonb_build_object('paymentId', payment.id));
  perform commercial.command_record(requested_key, requested_sha256, 'payment.confirm', bill.id);
  perform commercial.audit('commercial.payment.confirm', 'success', 'payment', payment.id::text, bill.patient_id,
    jsonb_build_object('billId', bill.id, 'amountKobo', payment.amount_kobo), 'ehr-api');
  return commercial.bill_json(bill.id);
end
$$;

-- Void a payment (a refund is a void with "Refund: ..."): by someone other
-- than the member who took it (BILL-4). Recorded in the voider's open day as a
-- negative entry; voiding cash needs that day.
create function commercial.payment_void(requested_bill uuid, requested_payment uuid, reason_value text,
  expected_version bigint, requested_till uuid, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  bill commercial.bills%rowtype;
  payment commercial.payments%rowtype;
  scope_row record;
  day_id uuid;
begin
  select * into actor from commercial.caller('billing.payment.void');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'payment.void');
  if replay.replayed then
    return commercial.bill_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  if reason_value is null or char_length(btrim(reason_value)) not between 8 and 500 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "reason"}';
  end if;
  bill := commercial.bill_lock(requested_bill, actor.facility_id, expected_version);
  select payment_row.* into payment from commercial.payments payment_row
   where payment_row.id = requested_payment and payment_row.bill_id = bill.id for update;
  if not found then
    raise exception using errcode = 'HB404', message = 'PAYMENT_NOT_FOUND';
  end if;
  if payment.voided_at is not null then
    raise exception using errcode = 'HB409', message = 'PAYMENT_ALREADY_VOIDED';
  end if;
  if payment.received_by_membership_id = actor.membership_id then
    raise exception using errcode = 'HB403', message = 'SECOND_PERSON_REQUIRED';
  end if;
  if payment.method <> 'waiver' then
    begin
      select * into scope_row from commercial.day_scope(actor.facility_id, actor.membership_id, requested_till);
      day_id := commercial.open_day(actor.facility_id, scope_row.scope, scope_row.membership_id, scope_row.till_id);
    exception when sqlstate 'HB400' then
      if payment.method = 'cash' then raise; end if;
    end;
    if day_id is null and payment.method = 'cash' then
      raise exception using errcode = 'HB409', message = 'TILL_DAY_NOT_OPEN';
    end if;
  end if;
  update commercial.payments payment_row
     set voided_at = clock_timestamp(), voided_by_membership_id = actor.membership_id, void_reason = btrim(reason_value),
         void_till_day_id = day_id, row_version = payment_row.row_version + 1, updated_at = clock_timestamp()
   where payment_row.id = payment.id;
  perform commercial.bill_recompute(bill.id);
  perform commercial.bill_event(bill.id, bill.facility_id, 'payment-void', actor.membership_id,
    jsonb_build_object('paymentId', payment.id, 'amountKobo', payment.amount_kobo));
  perform commercial.command_record(requested_key, requested_sha256, 'payment.void', bill.id);
  perform commercial.audit('commercial.payment.void', 'success', 'payment', payment.id::text, bill.patient_id,
    jsonb_build_object('billId', bill.id, 'method', payment.method, 'amountKobo', payment.amount_kobo,
      'tillDayId', day_id), 'ehr-api');
  return commercial.bill_json(bill.id);
end
$$;

-- The receipt of one payment (or the latest): the built ReceiptData, with the
-- last 4 characters of the Health ID only; "Cancelled" when voided; the paper
-- receipt number when there is one. Printing is audited (a patient document).
create function commercial.receipt(requested_bill uuid, requested_payment uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  bill commercial.bills%rowtype;
  payment commercial.payments%rowtype;
  facility_row identity.facilities%rowtype;
begin
  select * into actor from commercial.caller('billing.bill.read');
  select bill_row.* into bill from commercial.bills bill_row
   where bill_row.id = requested_bill and bill_row.facility_id = actor.facility_id;
  if not found then
    raise exception using errcode = 'HB404', message = 'BILL_NOT_FOUND';
  end if;
  select payment_row.* into payment from commercial.payments payment_row
   where payment_row.bill_id = bill.id and (requested_payment is null or payment_row.id = requested_payment)
   order by payment_row.received_at desc, payment_row.id desc limit 1;
  if not found then
    raise exception using errcode = 'HB404', message = 'RECEIPT_NOT_FOUND';
  end if;
  select facility.* into facility_row from identity.facilities facility where facility.id = actor.facility_id;
  perform commercial.audit('commercial.receipt.print', 'success', 'payment', payment.id::text, bill.patient_id,
    jsonb_build_object('billId', bill.id), 'ehr-api');
  return jsonb_build_object('receiptNumber', payment.receipt_number,
    'facility', jsonb_build_object('name', facility_row.name, 'address', null, 'phone', null),
    'bill', commercial.bill_json(bill.id),
    'payment', (select value from jsonb_array_elements(commercial.bill_json(bill.id)->'payments') value
                 where value->>'id' = payment.id::text),
    'cancelled', payment.voided_at is not null, 'paperReceiptNumber', payment.paper_receipt_number,
    'issuedAt', clock_timestamp(), 'issuedBy', commercial.member_name(actor.membership_id),
    'footer', (select settings.receipt_footer from commercial.payment_settings settings
                where settings.facility_id = actor.facility_id));
end
$$;

-- An online payment, verified with Paystack by ehr-api (BILL-14, switched off
-- until legal, DPO and owner approval): the webhook's transaction runs at the
-- bill's facility with no member. A reference already recorded answers the
-- payment it made. More than is due is OVERPAYMENT (the webhook then logs it
-- for support; the facility refunds through Paystack).
create function commercial.payment_record_online(requested_bill uuid, amount bigint, reference_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  facility_value uuid := platform.current_facility_id();
  bill commercial.bills%rowtype;
  existing uuid;
  day_id uuid;
  year_value integer := extract(year from (clock_timestamp() at time zone 'Africa/Lagos'))::integer;
  payment_id uuid;
begin
  if facility_value is null or platform.current_correlation_id() is null
     or coalesce(reference_sha256, '') !~ '^[0-9a-f]{64}$' or amount is null or amount < 1 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED';
  end if;
  bill := commercial.bill_lock(requested_bill, facility_value, null);
  select payment.id into existing from commercial.payments payment
   where payment.facility_id = facility_value and payment.online_reference_sha256 = reference_sha256;
  if existing is not null then
    return jsonb_build_object('paymentId', existing, 'duplicate', true);
  end if;
  if bill.voided_at is not null or bill.status = 'void' then
    raise exception using errcode = 'HB409', message = 'BILL_VOID';
  end if;
  if amount > bill.due_kobo then
    raise exception using errcode = 'HB409', message = 'OVERPAYMENT';
  end if;
  day_id := commercial.open_day(facility_value, 'facility', null, null);
  insert into commercial.payments (facility_id, bill_id, method, amount_kobo, status, receipt_number, till_day_id,
    online_reference_sha256)
  values (facility_value, bill.id, 'online', amount, 'recorded',
    'R-' || year_value::text || '-' || lpad(commercial.next_number(facility_value, 'receipt', year_value)::text, 6, '0'),
    day_id, reference_sha256)
  returning id into payment_id;
  perform commercial.bill_recompute(bill.id);
  perform commercial.bill_event(bill.id, bill.facility_id, 'payment', null,
    jsonb_build_object('paymentId', payment_id, 'method', 'online', 'amountKobo', amount));
  perform commercial.audit('commercial.online-payment.webhook', 'success', 'payment', payment_id::text, bill.patient_id,
    jsonb_build_object('billId', bill.id, 'amountKobo', amount, 'referenceSha256', reference_sha256, 'by', 'system'),
    'ehr-api');
  return jsonb_build_object('paymentId', payment_id, 'duplicate', false);
end
$$;

-- Grants (here and in runtime-grants.sql).
revoke all on function commercial.till_day_closed_guard(), commercial.day_scope(uuid, uuid, uuid),
  commercial.open_day(uuid, text, uuid, uuid), commercial.counter_staff_only(uuid), commercial.day_json(uuid),
  commercial.day_current(uuid), commercial.day_open(uuid, bigint, text, text),
  commercial.day_close(uuid, bigint, text, bigint, text, text), commercial.day_list(date, boolean),
  commercial.payment_record(uuid, jsonb, bigint, text, text),
  commercial.payment_confirm(uuid, uuid, bigint, text, text),
  commercial.payment_void(uuid, uuid, text, bigint, uuid, text, text), commercial.receipt(uuid, uuid),
  commercial.payment_record_online(uuid, bigint, text) from public;
do $grants$
declare
  runtime_role text;
begin
  foreach runtime_role in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function commercial.day_current(uuid), commercial.day_open(uuid, bigint, text, text), '
        || 'commercial.day_close(uuid, bigint, text, bigint, text, text), commercial.day_list(date, boolean), '
        || 'commercial.payment_record(uuid, jsonb, bigint, text, text), '
        || 'commercial.payment_confirm(uuid, uuid, bigint, text, text), '
        || 'commercial.payment_void(uuid, uuid, text, bigint, uuid, text, text), commercial.receipt(uuid, uuid), '
        || 'commercial.payment_record_online(uuid, bigint, text) to %I', runtime_role);
    end if;
  end loop;
end
$grants$;

comment on table commercial.till_days is
  '0165 (BILL-10, recommended option: "till day", so "shift" stays free for the clinical rota): one open day per scope (facility, cashier or till); a payment is recorded in the day it was taken in and its void in the voider''s open day, so a closed day never changes.';

-- Post-checks.
do $post$
declare
  made constant jsonb := '{
    "commercial.counter_staff_only(uuid)": "9352cab0a5c41b0c964aa989bc7cc117",
    "commercial.day_close(uuid,bigint,text,bigint,text,text)": "354d601cef08c55eb26a70665b2fcb4d",
    "commercial.day_current(uuid)": "28d175fd06c967cf3933e51fe7e02f28",
    "commercial.day_json(uuid)": "c4d01a0472dbba61f795ea4d6f10db9c",
    "commercial.day_list(date,boolean)": "49816c5c8a3bca9b495895eedbc0f8f3",
    "commercial.day_open(uuid,bigint,text,text)": "6fc0ed7510afc308baec9c2357013234",
    "commercial.day_scope(uuid,uuid,uuid)": "8566e0d7bac1aad56398e605c5e4371c",
    "commercial.open_day(uuid,text,uuid,uuid)": "32cfdd2e39dbc54d2ac9b170bdcb3b7e",
    "commercial.payment_confirm(uuid,uuid,bigint,text,text)": "f3e5670564647a04af1bdaf72a396868",
    "commercial.payment_record(uuid,jsonb,bigint,text,text)": "6c8508f08ac39235ee70f765addf94ab",
    "commercial.payment_record_online(uuid,bigint,text)": "78745468a013ccd1eb8945b28dbedfc6",
    "commercial.payment_void(uuid,uuid,text,bigint,uuid,text,text)": "61db3fcf0e35490c223a46231085e1c4",
    "commercial.receipt(uuid,uuid)": "c8966d9f317b4a4771af010ae42dd76d",
    "commercial.till_day_closed_guard()": "3201a28156e7eadb975afd56adc0c9ea"}';
  own constant text[] := array['commercial.till_day_closed_guard()', 'commercial.day_scope(uuid,uuid,uuid)',
    'commercial.open_day(uuid,text,uuid,uuid)', 'commercial.counter_staff_only(uuid)', 'commercial.day_json(uuid)',
    'commercial.day_current(uuid)', 'commercial.day_open(uuid,bigint,text,text)',
    'commercial.day_close(uuid,bigint,text,bigint,text,text)', 'commercial.day_list(date,boolean)',
    'commercial.payment_record(uuid,jsonb,bigint,text,text)', 'commercial.payment_confirm(uuid,uuid,bigint,text,text)',
    'commercial.payment_void(uuid,uuid,text,bigint,uuid,text,text)', 'commercial.receipt(uuid,uuid)',
    'commercial.payment_record_online(uuid,bigint,text)'];
  granted constant text[] := array['commercial.day_current(uuid)', 'commercial.day_open(uuid,bigint,text,text)',
    'commercial.day_close(uuid,bigint,text,bigint,text,text)', 'commercial.day_list(date,boolean)',
    'commercial.payment_record(uuid,jsonb,bigint,text,text)', 'commercial.payment_confirm(uuid,uuid,bigint,text,text)',
    'commercial.payment_void(uuid,uuid,text,bigint,uuid,text,text)', 'commercial.receipt(uuid,uuid)',
    'commercial.payment_record_online(uuid,bigint,text)'];
  owner_oid oid := (select nspowner from pg_namespace where nspname = 'commercial');
  computed jsonb;
  differing text;
begin
  select jsonb_object_agg(signature, md5(proc.prosrc)) into computed
    from unnest(own) signature join pg_proc proc on proc.oid = to_regprocedure(signature);
  if (select count(*) from jsonb_object_keys(computed)) <> cardinality(own) then
    raise exception using errcode = '55000', message = '0165: post-check failed: a function is missing';
  end if;
  if made = '{}'::jsonb then
    raise notice '0165 made: %', computed;
  elsif computed is distinct from made then
    select string_agg(key, ', ') into differing from jsonb_each_text(made) where computed->>key is distinct from value;
    raise exception using errcode = '55000', message = '0165: post-check failed: functions differ: ' || differing;
  end if;
  if exists (select 1 from unnest(own) signature, pg_proc proc
              where proc.oid = to_regprocedure(signature)
                and (proc.proowner <> owner_oid or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
                     or proc.prosecdef <> (signature = any (granted)))) then
    raise exception using errcode = '55000', message = '0165: post-check failed: a function''s owner, search_path or SECURITY DEFINER';
  end if;
  if exists (select 1 from unnest(own) signature, pg_proc proc,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = to_regprocedure(signature) and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or not (signature = any (granted))
                     or pg_get_userbyid(acl.grantee) not in ('hid_ehr_runtime', 'hid_schema_test_runtime'))) then
    raise exception using errcode = '55000', message = '0165: post-check failed: a function is granted to another role';
  end if;
  if not exists (select 1 from pg_class relation
                  where relation.oid = 'commercial.till_days'::regclass and relation.relrowsecurity
                    and relation.relforcerowsecurity and relation.relowner = owner_oid
                    and (select count(*) from pg_policy policy where policy.polrelid = relation.oid) = 1
                    and not exists (select 1 from lateral aclexplode(coalesce(relation.relacl,
                                      acldefault('r', relation.relowner))) acl where acl.grantee <> relation.relowner))
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.conrelid = 'commercial.payments'::regclass and constraint_row.convalidated
            and constraint_row.conname in ('payments_till_day_fk', 'payments_void_till_day_fk')) <> 2 then
    raise exception using errcode = '55000', message = '0165: post-check failed: commercial.till_days or the payments'' day keys';
  end if;
end
$post$;
