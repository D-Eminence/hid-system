-- 0163 BILL-1 (Release D): payment settings, HMOs, tills and the facility's
-- one price list (the item master, BILL-7), with the helpers every billing
-- function shares. Written on claude/sprint-billing-backend (staging at
-- 95fa1e52, 0001-0151 applied) after 0162 in the same pull request. The
-- number is provisional (Release D block 0162-0167); nothing here reads
-- 0152-0154. No migration number appears inside a function body, so
-- renumbering keeps every md5. The declaration is signed separately.
--
-- Owner decisions: the sprint approval of 25 November 2026 (BILL-2 A: the
-- price list is also the Service catalogue; BILL-3 A: emergencies are never
-- held up by a bill), and at the recommended option, not yet answered: BILL-7
-- (one item master: commercial.catalogue_items; medicines and tests link to
-- ORD-7's national lists by fixed code), BILL-9 (a commercial schema served
-- by ehr-api), BILL-15 (HMO prices kept as a guide; lines at the cash price).
--
-- WHAT IT DOES
-- T1 commercial.payment_settings: one row per facility (where money is
--    taken, the methods, pay-before per department, the deferral reasons,
--    the transfer account, the receipt footer, how the day is closed, the
--    check-in charge item), with row_version, the last change's member, key
--    and request sha256. A facility with no row answers the defaults and sees
--    no automatic line or gate (0167).
-- T2 commercial.facility_hmos and T3 commercial.tills: per facility, a name
--    unique in any case, active or not; never deleted.
-- T4 commercial.catalogue_items: the facility's one list of what it charges
--    for and keeps in stock (drug, lab_test, other). The national link
--    (national_code_system, national_code) is unique among a facility's
--    active items (a partial unique index), so a prescription or lab request
--    finds its price by its code. Name unique among the active items of a
--    kind, in any case. stock_kept is set only by 0166's stock settings.
--    The link is HID-MED (MED-nnnnn) for a drug, LOINC or HID-LAB for a test,
--    or, for either, HID-FACILITY with the id of one of this facility's own
--    items (ORD-7's facility items, 0155; coordinator decision, option 2, #258,
--    25 November 2026, 23:10 UTC): 0166's stock and 0167's hooks then match a
--    facility item by its code pair exactly as a national code. A
--    HID-FACILITY code is accepted only for an active item of this facility
--    and of that kind in 0155's table (read when 0155 is applied; before it
--    there is none, NATIONAL_CODE_NOT_FOUND), so neither file needs the
--    other first.
-- T5 commercial.catalogue_item_prices: the cash price (hmo_id null) and one
--    price per HMO; a removed HMO price is kept with active false.
-- T6 commercial.catalogue_events: every create and change of an item, with
--    the item before and after (no patient), append-only.
-- T7 commercial.number_counters: (facility, kind bill or receipt, year)
--    and the next number, taken FOR UPDATE, so numbers have no gaps.
-- T8 commercial.commands: one row per command (facility, member,
--    Idempotency-Key, request sha256, command, resource), so a replay with
--    the same key and body answers the resource and a different body is
--    IDEMPOTENCY_KEY_REUSED.
-- T9 commercial.unpriced_code_hits: each national code that reached this
--    facility's pharmacy or lab with no priced item (written by 0167's
--    hooks): code system, code, display, when. No patient, no person.
-- Every table: facility_id on every row; row-level security enabled and
-- forced with one policy, for the owner at the session's facility only
-- (current_user is the owner and facility_id is app.facility_id), so a
-- definer function never sees another facility's row; no privilege for any
-- runtime; DELETE and TRUNCATE refused by platform.reject_mutation() (and
-- UPDATE too on the append-only T6, T8 and T9); money is bigint kobo >= 0.
-- F1 Shared helpers (owner only, no EXECUTE for any role): the caller
--    (commercial.caller), the permission check (commercial.require), the
--    audit writer (commercial.audit), the idempotency replay and record
--    (commercial.command_replay, commercial.command_record), the next number
--    (commercial.next_number), the Lagos day (commercial.lagos_day), the
--    search-text check (commercial.search_text), the national-code check
--    (commercial.national_code_ok, reading 0149's lists), the facility-item
--    check (commercial.facility_item_ok, reading 0155's items when 0155 is
--    applied), the staff display
--    name (commercial.member_name) and the JSON of settings and items.
-- F2 For the EHR runtime and the schema test runtime (SECURITY DEFINER,
--    search_path pg_catalog, pg_temp): commercial.billing_switched_on,
--    commercial.settings_get, commercial.settings_put,
--    commercial.catalogue_list, commercial.catalogue_create,
--    commercial.catalogue_update, commercial.catalogue_unpriced_codes,
--    commercial.audit_refusal. Each checks the caller's code at the session
--    facility with auth.membership_has_permission and writes its audit row.
--    Refusals raise SQLSTATE HB400, HB403, HB404, HB409, HB412 or HB422
--    with the contract's code as the message (and a JSON detail where the
--    contract adds fields); ehr-api answers them with the contract's words.
-- Grants: USAGE on schema commercial and EXECUTE on F2 to hid_ehr_runtime
-- and hid_schema_test_runtime, and on commercial.billing_switched_on and
-- commercial.audit_refusal to hid_pharmacy_runtime (pharmacy-api's stock and
-- counter-sale routes), where they exist (and in runtime-grants.sql).
--
-- Locks: SHARE ROW EXCLUSIVE NOWAIT on identity.facilities and
-- identity.staff_facility_memberships (the new tables' foreign keys), in one
-- attempt made up to 50 times 100 ms apart, or once when this transaction
-- holds an earlier file's locks; busy refusals begin "0163: ". Everything
-- else it makes is new. Readers of both tables go on; writers of facilities
-- and memberships wait for the commit (milliseconds).
--
-- Old services on this schema: nothing calls the new functions. New
-- services on a schema without it: the billing routes answer 503
-- BILLING_UNAVAILABLE (42883/42P01/3F000).
--
-- Undo (not in the ledger; docs/rollback/0163_billing_settings_and_price_list.md):
-- drop the F2 and F1 functions and the nine tables (after 0164-0167's undo).
--
-- 0. Locks and preconditions (55000 and nothing applied; "0163: already
--    applied" when every function this file makes is there exactly as made).
-- 1-9. As above. 10. Post-checks: tables, RLS forced, each table's one
--    policy (permissive, for PUBLIC, its USING and WITH CHECK rule), ACLs,
--    each table's exact triggers (name, type, enabled, no arguments, no
--    column list, no WHEN, function), function owners, SECURITY DEFINER,
--    search_path and md5.

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
    "commercial.audit(text,text,text,text,uuid,jsonb,text)": "b24a13358027789773a38c7ff2ffc278",
    "commercial.audit_refusal(text,text,text,uuid,text)": "f7c90746caf878a5c41e000cc514fc04",
    "commercial.billing_switched_on(boolean)": "135a2fe7750e58aff64ead86315851bc",
    "commercial.caller(text)": "16752b295365f4e33ed9119f55c2175f",
    "commercial.catalogue_check(uuid,uuid,text,text,text,text,text,jsonb,text,text,jsonb)": "550eaa024526a9dbe11caff467b19e2f",
    "commercial.catalogue_create(jsonb,text,text)": "8ee22c59496b27af1fd92c288d770494",
    "commercial.catalogue_item_json(uuid)": "48d74947f4016ebc645dc0d0cfea281b",
    "commercial.catalogue_list(text,text,boolean,integer)": "f562b9ae15cd9fdc292cb3d284207bec",
    "commercial.catalogue_unpriced_codes()": "733dc4fbdfd9f7159cc291fdc283ab6f",
    "commercial.catalogue_update(uuid,jsonb,bigint,text,text)": "496ac1e579fc45956cecca69d13ceb1d",
    "commercial.catalogue_write_prices(uuid,uuid,jsonb)": "8fa7f007675931a209e32a9c9b632afc",
    "commercial.command_record(text,text,text,uuid)": "84e04cc81ba491a39773741ce8e26274",
    "commercial.command_replay(text,text,text)": "e7c1ff69e15ec0ca75b1c624355d163a",
    "commercial.facility_item_ok(text,text)": "57eeb29c858d2d7c47549ff8a452aac1",
    "commercial.holds(text)": "4ee831ae9d72455e1cdeb1d4661aac69",
    "commercial.lagos_day(timestampwithtimezone)": "08620d6c3114df8123f496d76238763f",
    "commercial.member_name(uuid)": "50f7c6db29a6b99ee94973b373ed57cd",
    "commercial.name_matches(text,text)": "9a333b063df63fc0589542c064a12614",
    "commercial.national_code_ok(text,text)": "924d3cf8495302105a6b12a4bb57d592",
    "commercial.next_number(uuid,text,integer)": "a5a509b5c4943d9ff9055568c8de6da8",
    "commercial.search_text(text)": "eefd76f15d9395c254a4a590f44c700c",
    "commercial.settings_get()": "b06e5d02deeb9d233f605976825cfab7",
    "commercial.settings_json(uuid)": "49d373b14f8c3a4c851e06690b43cdf1",
    "commercial.settings_put(jsonb,bigint,boolean,boolean,text,text)": "37aa9d24c36b299e0adb4f9c96b35de6"}';
  present integer;
  differing text;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.facilities, identity.staff_facility_memberships in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0163: identity.facilities or identity.staff_facility_memberships is busy, and this transaction '
            || 'already holds an earlier migration''s locks, so it does not wait; nothing applied; run the release '
            || 'again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0163: identity.facilities or identity.staff_facility_memberships stayed busy for 5 seconds; '
            || 'nothing applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;

  if to_regnamespace('commercial') is null or not exists (select 1 from auth.roles where code = 'billing_officer')
     or to_regclass('ehr.catalog_versions') is null or to_regclass('ehr.catalog_medicines') is null
     or to_regclass('ehr.catalog_lab_tests') is null then
    raise exception using errcode = '55000', message = '0163: 0001-0151 and 0162 must be applied first';
  end if;
  -- The pins name each function as its signature without spaces (see the post-checks).
  select count(*) into present from jsonb_object_keys(made) signature
   where exists (select 1 from pg_proc proc where replace(proc.oid::regprocedure::text, ' ', '') = signature);
  if present > 0 or to_regclass('commercial.payment_settings') is not null
     or to_regclass('commercial.catalogue_items') is not null then
    select string_agg(signature, ', ') into differing from jsonb_each_text(made) pinned(signature, digest)
     where (select md5(proc.prosrc) from pg_proc proc where replace(proc.oid::regprocedure::text, ' ', '') = pinned.signature)
           is distinct from pinned.digest;
    if differing is null and present = (select count(*) from jsonb_object_keys(made)) then
      raise exception using errcode = '55000', message = '0163: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0163: an object this file makes exists with other content: ' || coalesce(differing, 'a table');
  end if;
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure('platform.reject_mutation()'))
     is distinct from '398738f39f6eebed2c54da5009495def'
     or to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)'))
        is distinct from '65e3eaff93fe729fd5c5b986b80c9dd6'
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_correlation_id()') is null
     or to_regprocedure('platform.current_purpose_of_use()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null
     or to_regprocedure('identity.sealed_demo_facility(uuid)') is null
     or to_regprocedure('identity.sealed_qa_facility(uuid)') is null then
    raise exception using errcode = '55000',
      message = '0163: a function this file calls is missing or not as Release C leaves it; nothing applied';
  end if;
end
$pre$;

-- 1. Payment settings, HMOs and tills.
create table commercial.payment_settings (
  facility_id uuid primary key references identity.facilities(id) on delete restrict,
  where_paid text not null default 'cashier' check (where_paid in ('cashier', 'counter', 'both')),
  methods text[] not null default array['cash', 'pos', 'transfer']
    check (cardinality(methods) between 1 and 6
           and methods <@ array['cash', 'pos', 'transfer', 'hmo', 'waiver', 'online']),
  pay_before_pharmacy boolean not null default false,
  pay_before_lab boolean not null default false,
  allow_deferred_for text[] not null default array['emergency']
    check ('emergency' = any (allow_deferred_for) and allow_deferred_for <@ array['emergency', 'inpatient']),
  transfer_bank_name text check (transfer_bank_name is null or length(btrim(transfer_bank_name)) between 1 and 100),
  transfer_account_name text check (transfer_account_name is null or length(btrim(transfer_account_name)) between 1 and 100),
  transfer_account_number text check (transfer_account_number is null or transfer_account_number ~ '^[0-9]{10}$'),
  receipt_footer text check (receipt_footer is null or length(receipt_footer) <= 300),
  day_close_by text not null default 'facility' check (day_close_by in ('facility', 'cashier', 'till')),
  check_in_charge_item_id uuid,
  row_version bigint not null default 1 check (row_version > 0),
  updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint payment_settings_transfer_ck check (
    (transfer_bank_name is null) = (transfer_account_name is null)
    and (transfer_bank_name is null) = (transfer_account_number is null))
);

create table commercial.facility_hmos (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  name text not null check (name = btrim(name) and length(name) between 2 and 120),
  active boolean not null default true,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, facility_id)
);
create unique index facility_hmos_name_uq on commercial.facility_hmos (facility_id, lower(name));

create table commercial.tills (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  name text not null check (name = btrim(name) and length(name) between 2 and 120),
  active boolean not null default true,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, facility_id)
);
create unique index tills_name_uq on commercial.tills (facility_id, lower(name));

-- 4. The price list (the one item master).
create table commercial.catalogue_items (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  kind text not null check (kind in ('drug', 'lab_test', 'other')),
  name text not null check (name = btrim(name) and length(name) between 1 and 200),
  strength text check (strength is null or length(btrim(strength)) between 1 and 80),
  form text check (form is null or form in ('tablet', 'capsule', 'liquid', 'injection', 'cream', 'inhaler', 'drops',
    'other')),
  pack_size text check (pack_size is null or length(btrim(pack_size)) between 1 and 80),
  prescription_only boolean not null default false,
  national_code_system text,
  national_code text check (national_code is null or length(national_code) between 1 and 100),
  orderable boolean not null default false,
  stock_kept boolean not null default false,
  active boolean not null default true,
  row_version bigint not null default 1 check (row_version > 0),
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, facility_id),
  constraint catalogue_items_drug_fields_ck check (
    kind = 'drug' or (strength is null and form is null and pack_size is null and not prescription_only
                      and not stock_kept)),
  constraint catalogue_items_national_ck check (
    (national_code_system is null) = (national_code is null)
    and (national_code_system is null
         or (kind = 'drug' and national_code_system = 'HID-MED' and national_code ~ '^MED-[0-9]{5}$')
         or (kind = 'lab_test' and national_code_system in ('LOINC', 'HID-LAB'))
         or (kind in ('drug', 'lab_test') and national_code_system = 'HID-FACILITY'
             and national_code ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
);
create unique index catalogue_items_name_uq on commercial.catalogue_items (facility_id, kind, lower(name)) where active;
create unique index catalogue_items_national_uq
  on commercial.catalogue_items (facility_id, national_code_system, national_code)
  where active and national_code is not null;
create index catalogue_items_list_idx on commercial.catalogue_items (facility_id, kind, active, lower(name));
alter table commercial.payment_settings
  add constraint payment_settings_check_in_item_fk foreign key (check_in_charge_item_id, facility_id)
  references commercial.catalogue_items (id, facility_id) on delete restrict;

create table commercial.catalogue_item_prices (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  catalogue_item_id uuid not null,
  hmo_id uuid,
  amount_kobo bigint not null check (amount_kobo between 0 and 100000000),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (catalogue_item_id, facility_id) references commercial.catalogue_items (id, facility_id) on delete restrict,
  foreign key (hmo_id, facility_id) references commercial.facility_hmos (id, facility_id) on delete restrict,
  constraint catalogue_item_prices_cash_active_ck check (hmo_id is not null or active)
);
create unique index catalogue_item_prices_uq on commercial.catalogue_item_prices (catalogue_item_id, hmo_id) nulls not distinct;

create table commercial.catalogue_events (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  catalogue_item_id uuid not null,
  kind text not null check (kind in ('create', 'update', 'stock_settings')),
  membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  before_value jsonb,
  after_value jsonb not null,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (catalogue_item_id, facility_id) references commercial.catalogue_items (id, facility_id) on delete restrict
);
create index catalogue_events_item_idx on commercial.catalogue_events (catalogue_item_id, created_at);

-- 7. Numbers without gaps.
create table commercial.number_counters (
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  kind text not null check (kind in ('bill', 'receipt')),
  year integer not null check (year = 0 or year between 2026 and 2999),
  next_value bigint not null default 1 check (next_value between 1 and 999999999),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (facility_id, kind, year),
  constraint number_counters_year_ck check ((kind = 'bill') = (year = 0))
);

-- 8. Commands (Idempotency-Key).
create table commercial.commands (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  command text not null check (command ~ '^[a-z][a-z.-]{2,79}$'),
  resource_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (facility_id, membership_id, idempotency_key)
);

-- 9. Codes with no price.
create table commercial.unpriced_code_hits (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  work_kind text not null check (work_kind in ('pharmacy', 'lab')),
  code_system text not null check (length(code_system) between 1 and 255),
  code text not null check (length(code) between 1 and 100),
  display text not null check (length(display) between 1 and 500),
  created_at timestamptz not null default clock_timestamp()
);
create index unpriced_code_hits_recent_idx on commercial.unpriced_code_hits (facility_id, created_at);

-- Row-level security (forced; the owner at the session's facility only), no
-- privilege for any runtime, and the mutation guards.
do $rls$
declare
  target text;
begin
  foreach target in array array['commercial.payment_settings', 'commercial.facility_hmos', 'commercial.tills',
      'commercial.catalogue_items', 'commercial.catalogue_item_prices', 'commercial.catalogue_events',
      'commercial.number_counters', 'commercial.commands', 'commercial.unpriced_code_hits'] loop
    execute format('alter table %s enable row level security', target);
    execute format('alter table %s force row level security', target);
    execute format('create policy facility_owner_rows on %s for all using (current_user = %L and facility_id = '
      || 'platform.current_facility_id()) with check (current_user = %L and facility_id = platform.current_facility_id())',
      target, current_user, current_user);
    execute format('revoke all on %s from public', target);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function '
      || 'platform.reject_mutation()', target);
    if target in ('commercial.catalogue_events', 'commercial.commands', 'commercial.unpriced_code_hits') then
      execute format('create trigger append_only before update or delete on %s for each row execute function '
        || 'platform.reject_mutation()', target);
    else
      execute format('create trigger no_delete before delete on %s for each row execute function '
        || 'platform.reject_mutation()', target);
    end if;
  end loop;
end
$rls$;

-- F1. Shared helpers (owner only).

-- The Lagos day of a time.
create function commercial.lagos_day(at_time timestamptz)
returns date
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select (at_time at time zone 'Africa/Lagos')::date
$$;

-- The caller at the session facility: an active membership of the session's
-- account there. HB403 BILLING_NOT_ALLOWED when there is none, or when a code
-- is named and the membership does not hold it.
create function commercial.caller(required_code text)
returns table (account_id uuid, membership_id uuid, facility_id uuid, organization_id uuid, subject text,
  correlation_id text, purpose text)
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_organization uuid;
begin
  if actor_account is null or actor_membership is null or actor_facility is null
     or platform.current_correlation_id() is null then
    raise exception using errcode = 'HB403', message = 'BILLING_NOT_ALLOWED';
  end if;
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if not found then
    raise exception using errcode = 'HB403', message = 'BILLING_NOT_ALLOWED';
  end if;
  if required_code is not null
     and not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, required_code) then
    raise exception using errcode = 'HB403', message = 'BILLING_NOT_ALLOWED';
  end if;
  return query select actor_account, actor_membership, actor_facility, actor_organization, actor_subject,
    platform.current_correlation_id(), platform.current_purpose_of_use();
end
$$;

-- Whether the session's member holds a code here (no refusal).
create function commercial.holds(code text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
    platform.current_facility_id(), code), false)
$$;

-- One audit row as the session's member (staff), or as the system when there
-- is no member (a trigger with no session member). Never a name, Health ID,
-- phone, reference, approval code, reason text or search text: callers pass
-- ids, amounts, methods, statuses and outcomes only.
create function commercial.audit(audit_action text, audit_outcome text, audit_resource_type text,
  audit_resource_id text, audit_patient uuid, audit_details jsonb, audit_source text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_organization uuid;
  system_actor boolean := coalesce(audit_details->>'by', '') = 'system';
begin
  if actor_membership is not null and actor_account is not null then
    select membership.organization_id into actor_organization from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account;
    if not found then actor_membership := null; end if;
  end if;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance,
    source_system, details)
  values (coalesce(platform.current_correlation_id(), 'commercial-' || gen_random_uuid()::text),
    case when system_actor or actor_membership is null then 'system' else 'staff' end,
    case when system_actor or actor_membership is null then null else actor_subject end,
    case when system_actor or actor_membership is null then null else actor_account end,
    case when system_actor then null else actor_membership end,
    actor_organization, actor_facility, audit_patient, audit_action, audit_outcome, audit_resource_type,
    audit_resource_id, coalesce(platform.current_purpose_of_use(), 'healthcare-operations'), 'application',
    audit_source, coalesce(audit_details, '{}'::jsonb));
end
$$;

-- The Idempotency-Key replay: the resource of an earlier command with the same
-- key and body (null when new); HB409 IDEMPOTENCY_KEY_REUSED for another body
-- or command; HB400 IDEMPOTENCY_KEY_REQUIRED for a missing or malformed key.
create function commercial.command_replay(requested_key text, requested_sha256 text, requested_command text)
returns table (replayed boolean, resource_id uuid)
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  prior commercial.commands%rowtype;
begin
  if requested_key is null or requested_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or requested_sha256 is null or requested_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'HB400', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('commercial-command:' || platform.current_facility_id()::text || ':'
    || platform.current_membership_id()::text || ':' || requested_key, 0));
  select command.* into prior from commercial.commands command
   where command.facility_id = platform.current_facility_id()
     and command.membership_id = platform.current_membership_id() and command.idempotency_key = requested_key;
  if not found then
    return query select false, null::uuid;
    return;
  end if;
  if prior.request_sha256 <> requested_sha256 or prior.command <> requested_command then
    raise exception using errcode = 'HB409', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  return query select true, prior.resource_id;
end
$$;

create function commercial.command_record(requested_key text, requested_sha256 text, requested_command text,
  requested_resource uuid)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
  insert into commercial.commands (facility_id, membership_id, idempotency_key, request_sha256, command, resource_id)
  values (platform.current_facility_id(), platform.current_membership_id(), requested_key, requested_sha256,
    requested_command, requested_resource)
$$;

-- The next number of a facility's counter, without gaps (FOR UPDATE).
create function commercial.next_number(requested_facility uuid, requested_kind text, requested_year integer)
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  value bigint;
begin
  insert into commercial.number_counters (facility_id, kind, year) values (requested_facility, requested_kind, requested_year)
    on conflict (facility_id, kind, year) do nothing;
  select counter.next_value into value from commercial.number_counters counter
   where counter.facility_id = requested_facility and counter.kind = requested_kind and counter.year = requested_year
   for update;
  update commercial.number_counters counter set next_value = value + 1, updated_at = clock_timestamp()
   where counter.facility_id = requested_facility and counter.kind = requested_kind and counter.year = requested_year;
  return value;
end
$$;

-- A search text: 2-60 characters; a Health ID or an 11-digit NIN (or any longer
-- run of digits) is refused before any search, as ORD-7's search is.
create function commercial.search_text(requested_q text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  trimmed text := nullif(btrim(coalesce(requested_q, '')), '');
begin
  if trimmed is null then
    return null;
  end if;
  if trimmed ~* 'HID-[A-HJ-NP-Z2-9]{2,}' or regexp_replace(trimmed, '[[:space:]-]+', '', 'g') ~ '[0-9]{11,}'
     or exists (select 1 from regexp_split_to_table(trimmed, '[^A-Za-z0-9]+') word(value)
                 where word.value ~* '^[A-HJ-NP-Z2-9]{6}$' and word.value ~ '[A-Za-z]' and word.value ~ '[0-9]') then
    raise exception using errcode = 'HB400', message = 'BILLING_SEARCH_TEXT_NOT_ALLOWED';
  end if;
  if char_length(trimmed) < 2 or char_length(trimmed) > 60 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "q"}';
  end if;
  return lower(trimmed);
end
$$;

-- Whether every word of q starts a word of a name.
create function commercial.name_matches(requested_name text, requested_q text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select requested_q is null or not exists (
    select 1 from regexp_split_to_table(lower(requested_q), '[^[:alnum:]]+') q_word(value)
     where q_word.value <> ''
       and not exists (select 1 from regexp_split_to_table(lower(coalesce(requested_name, '')), '[^[:alnum:]]+') name_word(value)
                        where left(name_word.value, length(q_word.value)) = q_word.value))
$$;

-- A national code exists in ORD-7's active list and is not withdrawn (0149).
create function commercial.national_code_ok(requested_system text, requested_code text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when requested_system = 'HID-MED' then exists (
      select 1 from ehr.catalog_medicines medicine
        join ehr.catalog_versions version_row on version_row.id = medicine.version_id
       where version_row.active and version_row.kind = 'medicine' and not medicine.withdrawn
         and medicine.list_id = requested_code)
    when requested_system in ('LOINC', 'HID-LAB') then exists (
      select 1 from ehr.catalog_lab_tests test
        join ehr.catalog_versions version_row on version_row.id = test.version_id
       where version_row.active and version_row.kind = 'lab_test' and not test.withdrawn
         and test.code_system = requested_system and test.code = requested_code)
    else false end
$$;

-- This facility's own item (ORD-7's facility items, 0155: code system
-- HID-FACILITY, the code the item's id as PostgreSQL writes it), active and of
-- the kind (a drug is 0155's medicine), at the session's facility (never an
-- argument's). Coordinator decision, option 2 (#258, 25 November 2026, 23:10
-- UTC): Billing prices facility items by their code pair, exactly as national
-- codes, and neither file waits for the other. So 0155's table is read only
-- when it exists, through one constant, schema-qualified query with bound
-- values (its name and the four columns 0155 keeps stable for Billing: id,
-- facility_id, kind and active; Ola, #258, 26 November 2026, 12:44 UTC),
-- matching facility_id because 0155's owner read policy shows every facility.
-- Without 0155 there is no facility item, so no such code is found.
create function commercial.facility_item_ok(requested_kind text, requested_code text)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  found_item boolean;
begin
  if requested_kind is null or requested_kind not in ('drug', 'lab_test') or requested_code is null
     or requested_code !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or platform.current_facility_id() is null or to_regclass('ehr.catalog_facility_items') is null then
    return false;
  end if;
  execute 'select exists (select 1 from ehr.catalog_facility_items item where item.id = $1 and item.facility_id = $2 '
    || 'and item.kind::text = $3 and item.active)'
    into found_item
    using requested_code::uuid, platform.current_facility_id(),
      case when requested_kind = 'drug' then 'medicine' else 'lab_test' end;
  return coalesce(found_item, false);
exception when undefined_table or undefined_column or undefined_function or datatype_mismatch
  or insufficient_privilege then
  return false;
end
$$;

-- A staff member's display name (SX-9's name: the staff record's full name), never an account id.
create function commercial.member_name(requested_membership uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((select staff.full_name from identity.staff_facility_memberships membership
                     join identity.staff staff on staff.id = membership.staff_id
                    where membership.id = requested_membership), 'Staff member')
$$;

create function commercial.settings_json(requested_facility uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'wherePaid', coalesce(settings.where_paid, 'cashier'),
    'methods', to_jsonb(coalesce(settings.methods, array['cash', 'pos', 'transfer'])),
    'payBefore', jsonb_build_object('pharmacy', coalesce(settings.pay_before_pharmacy, false),
                                    'lab', coalesce(settings.pay_before_lab, false)),
    'allowDeferredFor', to_jsonb(coalesce(settings.allow_deferred_for, array['emergency'])),
    'transferAccount', case when settings.transfer_bank_name is null then null
      else jsonb_build_object('bankName', settings.transfer_bank_name, 'accountName', settings.transfer_account_name,
                              'accountNumber', settings.transfer_account_number) end,
    'hmos', coalesce((select jsonb_agg(jsonb_build_object('id', hmo.id, 'name', hmo.name, 'active', hmo.active)
                                       order by lower(hmo.name), hmo.id)
                        from commercial.facility_hmos hmo where hmo.facility_id = facility.id), '[]'::jsonb),
    'receiptFooter', settings.receipt_footer,
    'dayCloseBy', coalesce(settings.day_close_by, 'facility'),
    'tills', coalesce((select jsonb_agg(jsonb_build_object('id', till.id, 'name', till.name, 'active', till.active)
                                        order by lower(till.name), till.id)
                         from commercial.tills till where till.facility_id = facility.id), '[]'::jsonb),
    'checkInChargeItemId', settings.check_in_charge_item_id,
    'version', coalesce(settings.row_version, 0))
    from (select requested_facility as id) facility
    left join commercial.payment_settings settings on settings.facility_id = facility.id
$$;

create function commercial.catalogue_item_json(requested_item uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object('id', item.id, 'kind', item.kind, 'name', item.name, 'strength', item.strength,
    'form', item.form, 'packSize', item.pack_size, 'imageUrl', null, 'prescriptionOnly', item.prescription_only,
    'nationalCodeSystem', item.national_code_system, 'nationalCode', item.national_code, 'orderable', item.orderable,
    'prices', jsonb_build_object(
      'cashKobo', (select price.amount_kobo from commercial.catalogue_item_prices price
                    where price.catalogue_item_id = item.id and price.hmo_id is null),
      'hmo', coalesce((select jsonb_agg(jsonb_build_object('hmoId', price.hmo_id, 'amountKobo', price.amount_kobo)
                                        order by price.hmo_id)
                         from commercial.catalogue_item_prices price
                        where price.catalogue_item_id = item.id and price.hmo_id is not null and price.active),
                      '[]'::jsonb)),
    'stockKept', item.stock_kept, 'active', item.active, 'version', item.row_version)
    from commercial.catalogue_items item where item.id = requested_item
$$;

-- F2. For the EHR runtime.

-- Whether billing is switched on at the session facility: the server's
-- COMMERCIAL_BILLING_ENABLED, or the facility is a sealed demo or QA facility
-- (owner sprint approval: on there before go-live).
create function commercial.billing_switched_on(server_enabled boolean)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(server_enabled, false)
      or coalesce(identity.sealed_demo_facility(platform.current_facility_id()), false)
      or coalesce(identity.sealed_qa_facility(platform.current_facility_id()), false)
$$;

-- A refusal's audit row (the service writes it after the refused command
-- rolled back): the action, the code, and the resource id when there is one.
create function commercial.audit_refusal(requested_action text, requested_code text, requested_resource_type text,
  requested_resource_id uuid, requested_source text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if requested_action !~ '^(commercial|pharmacy)\.[a-z.-]{3,80}$' or requested_code !~ '^[A-Z][A-Z_]{2,60}$'
     or requested_resource_type !~ '^[a-z][a-z-]{1,40}$' or requested_source not in ('ehr-api', 'pharmacy-api') then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED';
  end if;
  perform commercial.audit(requested_action, 'denied', requested_resource_type, requested_resource_id::text, null,
    jsonb_build_object('code', requested_code), requested_source);
end
$$;

create function commercial.settings_get()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
begin
  select * into actor from commercial.caller('billing.bill.read');
  perform commercial.audit('commercial.settings.read', 'success', 'payment-settings', actor.facility_id::text, null,
    '{}'::jsonb, 'ehr-api');
  return commercial.settings_json(actor.facility_id);
end
$$;

-- PUT the whole settings object. pay_before_available and online_available are
-- the server's COMMERCIAL_PAY_BEFORE_ENABLED and COMMERCIAL_ONLINE_PAYMENT_ENABLED.
create function commercial.settings_put(requested jsonb, expected_version bigint, pay_before_available boolean,
  online_available boolean, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  current_row commercial.payment_settings%rowtype;
  current_version bigint;
  methods_value text[];
  deferred_value text[];
  transfer jsonb := requested->'transferAccount';
  entry jsonb;
  open_days boolean := false;
  item_kind text;
  item_active boolean;
  changed_hmos integer := 0;
  changed_tills integer := 0;
begin
  select * into actor from commercial.caller('billing.settings.manage');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'settings.put');
  if replay.replayed then
    return commercial.settings_json(actor.facility_id) || jsonb_build_object('replayed', true);
  end if;
  if jsonb_typeof(requested) <> 'object' then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED';
  end if;
  select settings.* into current_row from commercial.payment_settings settings
   where settings.facility_id = actor.facility_id for update;
  current_version := coalesce(current_row.row_version, 0);
  if expected_version is null or expected_version <> current_version then
    raise exception using errcode = 'HB412', message = 'VERSION_CONFLICT';
  end if;
  if to_regclass('commercial.till_days') is not null then
    execute 'select exists (select 1 from commercial.till_days day_row where day_row.facility_id = $1 '
      || 'and day_row.closed_at is null)' into open_days using actor.facility_id;
  end if;

  -- The fields, as the contract's table says.
  if coalesce(requested->>'wherePaid', '') not in ('cashier', 'counter', 'both') then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "wherePaid"}';
  end if;
  if jsonb_typeof(requested->'methods') <> 'array' or jsonb_array_length(requested->'methods') = 0
     or exists (select 1 from jsonb_array_elements(requested->'methods') method
                 where jsonb_typeof(method) <> 'string'
                    or method #>> '{}' not in ('cash', 'pos', 'transfer', 'hmo', 'waiver', 'online')) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "methods"}';
  end if;
  select array_agg(distinct method #>> '{}' order by method #>> '{}') into methods_value
    from jsonb_array_elements(requested->'methods') method;
  if 'online' = any (methods_value) and not coalesce(online_available, false) then
    raise exception using errcode = 'HB404', message = 'ONLINE_PAYMENT_NOT_AVAILABLE';
  end if;
  if jsonb_typeof(requested->'payBefore') <> 'object'
     or jsonb_typeof(requested->'payBefore'->'pharmacy') <> 'boolean'
     or jsonb_typeof(requested->'payBefore'->'lab') <> 'boolean' then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "payBefore"}';
  end if;
  if ((requested->'payBefore'->>'pharmacy')::boolean or (requested->'payBefore'->>'lab')::boolean)
     and not coalesce(pay_before_available, false) then
    raise exception using errcode = 'HB409', message = 'PAY_BEFORE_NOT_AVAILABLE';
  end if;
  if jsonb_typeof(requested->'allowDeferredFor') <> 'array'
     or exists (select 1 from jsonb_array_elements(requested->'allowDeferredFor') reason_value
                 where jsonb_typeof(reason_value) <> 'string'
                    or reason_value #>> '{}' not in ('emergency', 'inpatient')) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "allowDeferredFor"}';
  end if;
  select array_agg(distinct reason_value #>> '{}' order by reason_value #>> '{}') into deferred_value
    from jsonb_array_elements(requested->'allowDeferredFor') reason_value;
  if deferred_value is null or not ('emergency' = any (deferred_value)) then
    raise exception using errcode = 'HB409', message = 'EMERGENCY_DEFERRAL_REQUIRED';
  end if;
  if transfer is not null and jsonb_typeof(transfer) <> 'null'
     and (jsonb_typeof(transfer) <> 'object'
          or length(btrim(coalesce(transfer->>'bankName', ''))) not between 1 and 100
          or length(btrim(coalesce(transfer->>'accountName', ''))) not between 1 and 100
          or coalesce(transfer->>'accountNumber', '') !~ '^[0-9]{10}$') then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "transferAccount"}';
  end if;
  if requested ? 'receiptFooter' and jsonb_typeof(requested->'receiptFooter') not in ('string', 'null')
     or length(coalesce(requested->>'receiptFooter', '')) > 300 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "receiptFooter"}';
  end if;
  if coalesce(requested->>'dayCloseBy', '') not in ('facility', 'cashier', 'till') then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "dayCloseBy"}';
  end if;
  if open_days and requested->>'dayCloseBy' is distinct from coalesce(current_row.day_close_by, 'facility') then
    raise exception using errcode = 'HB409', message = 'TILL_DAY_OPEN';
  end if;
  if requested->>'checkInChargeItemId' is not null then
    if requested->>'checkInChargeItemId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "checkInChargeItemId"}';
    end if;
    select item.kind, item.active into item_kind, item_active from commercial.catalogue_items item
     where item.id = (requested->>'checkInChargeItemId')::uuid and item.facility_id = actor.facility_id;
    if not found then
      raise exception using errcode = 'HB404', message = 'CATALOGUE_ITEM_NOT_FOUND';
    end if;
    if item_kind <> 'other' or not item_active then
      raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "checkInChargeItemId"}';
    end if;
  end if;
  -- HMOs and tills: a new entry has no id; an entry with an id is one of this
  -- facility's; names 2-120 and unique in any case; never deleted (one left
  -- out of the list is kept as it is).
  if jsonb_typeof(coalesce(requested->'hmos', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(requested->'hmos', '[]')) > 200
     or jsonb_typeof(coalesce(requested->'tills', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(requested->'tills', '[]')) > 50 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "hmos"}';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(requested->'hmos', '[]') || coalesce(requested->'tills', '[]')) listed
              where jsonb_typeof(listed) <> 'object'
                 or length(coalesce(listed->>'name', '')) not between 2 and 120
                 or listed->>'name' <> btrim(listed->>'name')
                 or jsonb_typeof(coalesce(listed->'active', 'true'::jsonb)) <> 'boolean'
                 or (listed->>'id' is not null
                     and listed->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "hmos"}';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(requested->'hmos', '[]')) listed
              where listed->>'id' is not null
                and not exists (select 1 from commercial.facility_hmos hmo
                                 where hmo.id = (listed->>'id')::uuid and hmo.facility_id = actor.facility_id))
     or exists (select 1 from jsonb_array_elements(coalesce(requested->'tills', '[]')) listed
                 where listed->>'id' is not null
                   and not exists (select 1 from commercial.tills till
                                    where till.id = (listed->>'id')::uuid and till.facility_id = actor.facility_id)) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "hmos"}';
  end if;
  if (select count(*) <> count(distinct lower(listed->>'name')) from jsonb_array_elements(coalesce(requested->'hmos', '[]')) listed)
     or (select count(*) <> count(distinct lower(listed->>'name')) from jsonb_array_elements(coalesce(requested->'tills', '[]')) listed) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "hmos"}';
  end if;
  if open_days and to_regclass('commercial.till_days') is not null then
    execute 'select exists (select 1 from jsonb_array_elements($1) listed join commercial.till_days day_row '
      || 'on day_row.till_id = (listed->>''id'')::uuid and day_row.closed_at is null '
      || 'where listed->>''id'' is not null and not coalesce((listed->>''active'')::boolean, true))'
      into open_days using coalesce(requested->'tills', '[]'::jsonb);
    if open_days then
      raise exception using errcode = 'HB409', message = 'TILL_DAY_OPEN';
    end if;
  end if;

  -- Write: existing HMOs and tills renamed or switched first, then the new ones
  -- (a name freed by a rename can be taken by a new entry).
  begin
    update commercial.facility_hmos hmo
       set name = listed->>'name', active = coalesce((listed->>'active')::boolean, true),
           row_version = hmo.row_version + 1, updated_at = clock_timestamp()
      from jsonb_array_elements(coalesce(requested->'hmos', '[]')) listed
     where listed->>'id' is not null and hmo.id = (listed->>'id')::uuid and hmo.facility_id = actor.facility_id
       and (hmo.name, hmo.active) is distinct from (listed->>'name', coalesce((listed->>'active')::boolean, true));
    get diagnostics changed_hmos = row_count;
    insert into commercial.facility_hmos (facility_id, name, active)
    select actor.facility_id, listed->>'name', coalesce((listed->>'active')::boolean, true)
      from jsonb_array_elements(coalesce(requested->'hmos', '[]')) listed where listed->>'id' is null;
    update commercial.tills till
       set name = listed->>'name', active = coalesce((listed->>'active')::boolean, true),
           row_version = till.row_version + 1, updated_at = clock_timestamp()
      from jsonb_array_elements(coalesce(requested->'tills', '[]')) listed
     where listed->>'id' is not null and till.id = (listed->>'id')::uuid and till.facility_id = actor.facility_id
       and (till.name, till.active) is distinct from (listed->>'name', coalesce((listed->>'active')::boolean, true));
    get diagnostics changed_tills = row_count;
    insert into commercial.tills (facility_id, name, active)
    select actor.facility_id, listed->>'name', coalesce((listed->>'active')::boolean, true)
      from jsonb_array_elements(coalesce(requested->'tills', '[]')) listed where listed->>'id' is null;
  exception when unique_violation then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "hmos"}';
  end;

  insert into commercial.payment_settings (facility_id, where_paid, methods, pay_before_pharmacy, pay_before_lab,
    allow_deferred_for, transfer_bank_name, transfer_account_name, transfer_account_number, receipt_footer,
    day_close_by, check_in_charge_item_id, updated_by_membership_id, idempotency_key, request_sha256)
  values (actor.facility_id, requested->>'wherePaid', methods_value, (requested->'payBefore'->>'pharmacy')::boolean,
    (requested->'payBefore'->>'lab')::boolean, deferred_value, btrim(transfer->>'bankName'),
    btrim(transfer->>'accountName'), transfer->>'accountNumber', requested->>'receiptFooter',
    requested->>'dayCloseBy', (requested->>'checkInChargeItemId')::uuid, actor.membership_id, requested_key,
    requested_sha256)
  on conflict (facility_id) do update
    set where_paid = excluded.where_paid, methods = excluded.methods,
        pay_before_pharmacy = excluded.pay_before_pharmacy, pay_before_lab = excluded.pay_before_lab,
        allow_deferred_for = excluded.allow_deferred_for, transfer_bank_name = excluded.transfer_bank_name,
        transfer_account_name = excluded.transfer_account_name,
        transfer_account_number = excluded.transfer_account_number, receipt_footer = excluded.receipt_footer,
        day_close_by = excluded.day_close_by, check_in_charge_item_id = excluded.check_in_charge_item_id,
        updated_by_membership_id = excluded.updated_by_membership_id, idempotency_key = excluded.idempotency_key,
        request_sha256 = excluded.request_sha256, row_version = commercial.payment_settings.row_version + 1,
        updated_at = clock_timestamp();
  perform commercial.command_record(requested_key, requested_sha256, 'settings.put', actor.facility_id);
  perform commercial.audit('commercial.settings.update', 'success', 'payment-settings', actor.facility_id::text, null,
    jsonb_build_object('version', current_version + 1, 'methods', to_jsonb(methods_value),
      'payBefore', requested->'payBefore', 'dayCloseBy', requested->>'dayCloseBy',
      'checkInCharge', requested->>'checkInChargeItemId' is not null), 'ehr-api');
  return commercial.settings_json(actor.facility_id);
end
$$;

-- The price list: 50 per page, by name; q matches the start of any word of
-- the name (every word of q), at least 2 characters.
create function commercial.catalogue_list(requested_kind text, requested_q text, requested_active boolean,
  requested_page integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  q text;
  page_value integer := coalesce(requested_page, 1);
  answer jsonb;
begin
  select * into actor from commercial.caller('billing.catalogue.read');
  if (requested_kind is not null and requested_kind not in ('drug', 'lab_test', 'other')) or page_value not between 1 and 1000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "kind"}';
  end if;
  q := commercial.search_text(requested_q);
  with matched as (
    select item.id, item.name
      from commercial.catalogue_items item
     where item.facility_id = actor.facility_id
       and (requested_kind is null or item.kind = requested_kind)
       and (requested_active is null or item.active = requested_active)
       and commercial.name_matches(item.name, q)
     order by lower(item.name) collate "C", item.id
     offset (page_value - 1) * 50 limit 51)
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(commercial.catalogue_item_json(listed.id) order by lower(listed.name) collate "C", listed.id)
                         from (select * from matched order by lower(matched.name) collate "C", matched.id limit 50) listed), '[]'::jsonb),
    'page', page_value, 'pageSize', 50, 'more', (select count(*) from matched) > 50)
    into answer;
  return answer;
end
$$;

-- Checks an item's fields (create, or the merged result of a change) and
-- writes its prices. HB400 VALIDATION_FAILED names the field.
create function commercial.catalogue_write_prices(requested_facility uuid, requested_item uuid, requested_prices jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  cash bigint;
begin
  if jsonb_typeof(requested_prices) <> 'object' or jsonb_typeof(requested_prices->'cashKobo') <> 'number'
     or (requested_prices ? 'hmo' and jsonb_typeof(requested_prices->'hmo') <> 'array') then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "prices"}';
  end if;
  cash := (requested_prices->>'cashKobo')::numeric;
  if (requested_prices->>'cashKobo')::numeric <> cash or cash not between 0 and 100000000 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "prices.cashKobo"}';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(requested_prices->'hmo', '[]')) price
              where jsonb_typeof(price) <> 'object' or jsonb_typeof(price->'amountKobo') <> 'number'
                 or (price->>'amountKobo')::numeric <> trunc((price->>'amountKobo')::numeric)
                 or (price->>'amountKobo')::numeric not between 0 and 100000000
                 or coalesce(price->>'hmoId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 or not exists (select 1 from commercial.facility_hmos hmo
                                 where hmo.id = (price->>'hmoId')::uuid and hmo.facility_id = requested_facility
                                   and hmo.active))
     or (select count(*) <> count(distinct price->>'hmoId') from jsonb_array_elements(coalesce(requested_prices->'hmo', '[]')) price) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "prices.hmo"}';
  end if;
  insert into commercial.catalogue_item_prices (facility_id, catalogue_item_id, hmo_id, amount_kobo)
  values (requested_facility, requested_item, null, cash)
  on conflict (catalogue_item_id, hmo_id) do update set amount_kobo = excluded.amount_kobo, updated_at = clock_timestamp()
   where commercial.catalogue_item_prices.amount_kobo <> excluded.amount_kobo;
  if requested_prices ? 'hmo' then
    update commercial.catalogue_item_prices price set active = false, updated_at = clock_timestamp()
     where price.catalogue_item_id = requested_item and price.hmo_id is not null and price.active
       and not exists (select 1 from jsonb_array_elements(requested_prices->'hmo') listed
                        where (listed->>'hmoId')::uuid = price.hmo_id);
    insert into commercial.catalogue_item_prices (facility_id, catalogue_item_id, hmo_id, amount_kobo)
    select requested_facility, requested_item, (listed->>'hmoId')::uuid, (listed->>'amountKobo')::numeric::bigint
      from jsonb_array_elements(requested_prices->'hmo') listed
    on conflict (catalogue_item_id, hmo_id) do update
      set amount_kobo = excluded.amount_kobo, active = true, updated_at = clock_timestamp();
  end if;
end
$$;

create function commercial.catalogue_check(requested_facility uuid, requested_item uuid, kind_value text, name_value text,
  strength_value text, form_value text, pack_value text, prescription_value jsonb, system_value text, code_value text,
  orderable_value jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if kind_value is null or kind_value not in ('drug', 'lab_test', 'other') then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "kind"}';
  end if;
  if name_value is null or name_value <> btrim(name_value) or char_length(name_value) not between 1 and 200 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "name"}';
  end if;
  if kind_value <> 'drug' and (strength_value is not null or form_value is not null or pack_value is not null) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "strength"}';
  end if;
  if (strength_value is not null and char_length(btrim(strength_value)) not between 1 and 80)
     or (pack_value is not null and char_length(btrim(pack_value)) not between 1 and 80) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "strength"}';
  end if;
  if form_value is not null and form_value not in ('tablet', 'capsule', 'liquid', 'injection', 'cream', 'inhaler',
       'drops', 'other') then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "form"}';
  end if;
  if (kind_value = 'drug' and jsonb_typeof(prescription_value) is distinct from 'boolean')
     or (kind_value <> 'drug' and prescription_value is not null and prescription_value <> 'false'::jsonb) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "prescriptionOnly"}';
  end if;
  if orderable_value is not null and jsonb_typeof(orderable_value) <> 'boolean' then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "orderable"}';
  end if;
  if (system_value is null) <> (code_value is null)
     or (system_value is not null
         and not ((kind_value = 'drug' and system_value = 'HID-MED' and code_value ~ '^MED-[0-9]{5}$')
                  or (kind_value = 'lab_test' and system_value in ('LOINC', 'HID-LAB')
                      and char_length(code_value) between 1 and 100)
                  or (kind_value in ('drug', 'lab_test') and system_value = 'HID-FACILITY'
                      and code_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "nationalCode"}';
  end if;
  if system_value is not null
     and not (case when system_value = 'HID-FACILITY' then commercial.facility_item_ok(kind_value, code_value)
                   else commercial.national_code_ok(system_value, code_value) end) then
    raise exception using errcode = 'HB409', message = 'NATIONAL_CODE_NOT_FOUND';
  end if;
  if system_value is not null and exists (
       select 1 from commercial.catalogue_items other
        where other.facility_id = requested_facility and other.active and other.national_code_system = system_value
          and other.national_code = code_value and other.id is distinct from requested_item) then
    raise exception using errcode = 'HB409', message = 'NATIONAL_CODE_ALREADY_PRICED';
  end if;
  if exists (select 1 from commercial.catalogue_items other
              where other.facility_id = requested_facility and other.active and other.kind = kind_value
                and lower(other.name) = lower(name_value) and other.id is distinct from requested_item) then
    raise exception using errcode = 'HB409', message = 'CATALOGUE_ITEM_EXISTS';
  end if;
end
$$;

create function commercial.catalogue_create(requested jsonb, requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  item_id uuid;
  kind_value text := requested->>'kind';
begin
  select * into actor from commercial.caller('billing.catalogue.manage');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'catalogue.create');
  if replay.replayed then
    return commercial.catalogue_item_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  if jsonb_typeof(requested) <> 'object' or requested ? 'imageFileId' or requested ? 'stockKept'
     or (requested ? 'active' and requested->'active' <> 'true'::jsonb) then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "imageFileId"}';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('commercial-catalogue:' || actor.facility_id::text, 0));
  perform commercial.catalogue_check(actor.facility_id, null, kind_value, requested->>'name', requested->>'strength',
    requested->>'form', requested->>'packSize', requested->'prescriptionOnly', requested->>'nationalCodeSystem',
    requested->>'nationalCode', requested->'orderable');
  if (select count(*) from commercial.catalogue_items item where item.facility_id = actor.facility_id and item.active) >= 5000 then
    raise exception using errcode = 'HB409', message = 'CATALOGUE_LIMIT';
  end if;
  insert into commercial.catalogue_items (facility_id, kind, name, strength, form, pack_size, prescription_only,
    national_code_system, national_code, orderable, created_by_membership_id, updated_by_membership_id,
    idempotency_key, request_sha256)
  values (actor.facility_id, kind_value, requested->>'name', btrim(requested->>'strength'), requested->>'form',
    btrim(requested->>'packSize'), coalesce((requested->>'prescriptionOnly')::boolean, false),
    requested->>'nationalCodeSystem', requested->>'nationalCode', coalesce((requested->>'orderable')::boolean, false),
    actor.membership_id, actor.membership_id, requested_key, requested_sha256)
  returning id into item_id;
  perform commercial.catalogue_write_prices(actor.facility_id, item_id, requested->'prices');
  insert into commercial.catalogue_events (facility_id, catalogue_item_id, kind, membership_id, after_value,
    idempotency_key, request_sha256)
  values (actor.facility_id, item_id, 'create', actor.membership_id, commercial.catalogue_item_json(item_id), requested_key,
    requested_sha256);
  perform commercial.command_record(requested_key, requested_sha256, 'catalogue.create', item_id);
  perform commercial.audit('commercial.catalogue-item.create', 'success', 'catalogue-item', item_id::text, null,
    jsonb_build_object('kind', kind_value, 'cashKobo', (requested->'prices'->>'cashKobo')::numeric,
      'nationalCodeSystem', requested->>'nationalCodeSystem'), 'ehr-api');
  return commercial.catalogue_item_json(item_id);
end
$$;

-- PATCH: only the changed fields, with expectedVersion. kind and stockKept
-- never change here; an item is withdrawn with active false, never deleted.
create function commercial.catalogue_update(requested_item uuid, requested jsonb, expected_version bigint,
  requested_key text, requested_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  replay record;
  item commercial.catalogue_items%rowtype;
  before_value jsonb;
  merged jsonb;
begin
  select * into actor from commercial.caller('billing.catalogue.manage');
  select * into replay from commercial.command_replay(requested_key, requested_sha256, 'catalogue.update');
  if replay.replayed then
    return commercial.catalogue_item_json(replay.resource_id) || jsonb_build_object('replayed', true);
  end if;
  if jsonb_typeof(requested) <> 'object' or requested ? 'imageFileId' or requested ? 'kind' or requested ? 'stockKept'
     or requested ? 'id' or (requested ? 'active' and jsonb_typeof(requested->'active') <> 'boolean') then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "imageFileId"}';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('commercial-catalogue:' || actor.facility_id::text, 0));
  select catalogue_item.* into item from commercial.catalogue_items catalogue_item
   where catalogue_item.id = requested_item and catalogue_item.facility_id = actor.facility_id for update;
  if not found then
    raise exception using errcode = 'HB404', message = 'CATALOGUE_ITEM_NOT_FOUND';
  end if;
  if expected_version is null or expected_version <> item.row_version then
    raise exception using errcode = 'HB412', message = 'VERSION_CONFLICT';
  end if;
  before_value := commercial.catalogue_item_json(item.id);
  merged := before_value || (requested - 'prices');
  if coalesce((merged->>'active')::boolean, true) then
    perform commercial.catalogue_check(actor.facility_id, item.id, item.kind, merged->>'name', merged->>'strength',
      merged->>'form', merged->>'packSize', merged->'prescriptionOnly', merged->>'nationalCodeSystem',
      merged->>'nationalCode', merged->'orderable');
    if not item.active and (select count(*) from commercial.catalogue_items other
                             where other.facility_id = actor.facility_id and other.active) >= 5000 then
      raise exception using errcode = 'HB409', message = 'CATALOGUE_LIMIT';
    end if;
  elsif merged->>'name' is null or char_length(merged->>'name') not between 1 and 200 then
    raise exception using errcode = 'HB400', message = 'VALIDATION_FAILED', detail = '{"field": "name"}';
  end if;
  update commercial.catalogue_items catalogue_item
     set name = merged->>'name', strength = btrim(merged->>'strength'), form = merged->>'form',
         pack_size = btrim(merged->>'packSize'), prescription_only = coalesce((merged->>'prescriptionOnly')::boolean, false),
         national_code_system = merged->>'nationalCodeSystem', national_code = merged->>'nationalCode',
         orderable = coalesce((merged->>'orderable')::boolean, false), active = coalesce((merged->>'active')::boolean, true),
         row_version = catalogue_item.row_version + 1, updated_by_membership_id = actor.membership_id,
         idempotency_key = requested_key, request_sha256 = requested_sha256, updated_at = clock_timestamp()
   where catalogue_item.id = item.id;
  if requested ? 'prices' then
    perform commercial.catalogue_write_prices(actor.facility_id, item.id,
      jsonb_build_object('cashKobo', coalesce(requested->'prices'->'cashKobo', before_value->'prices'->'cashKobo'))
      || case when requested->'prices' ? 'hmo' then jsonb_build_object('hmo', requested->'prices'->'hmo') else '{}'::jsonb end);
  end if;
  insert into commercial.catalogue_events (facility_id, catalogue_item_id, kind, membership_id, before_value, after_value,
    idempotency_key, request_sha256)
  values (actor.facility_id, item.id, 'update', actor.membership_id, before_value, commercial.catalogue_item_json(item.id),
    requested_key, requested_sha256);
  perform commercial.command_record(requested_key, requested_sha256, 'catalogue.update', item.id);
  perform commercial.audit('commercial.catalogue-item.update', 'success', 'catalogue-item', item.id::text, null,
    jsonb_build_object('version', item.row_version + 1, 'fields', (select jsonb_agg(key order by key) from jsonb_object_keys(requested) key)),
    'ehr-api');
  return commercial.catalogue_item_json(item.id);
end
$$;

-- The last 30 days' national codes that reached this facility's pharmacy or
-- lab with no priced item, with a count only.
create function commercial.catalogue_unpriced_codes()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  answer jsonb;
begin
  select * into actor from commercial.caller('billing.catalogue.manage');
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('codeSystem', grouped.code_system,
           'code', grouped.code, 'display', grouped.display, 'count', grouped.hits)
           order by grouped.hits desc, grouped.code_system, grouped.code), '[]'::jsonb))
    into answer
    from (select hit.code_system, hit.code, (array_agg(hit.display order by hit.created_at desc))[1] as display,
                 count(*) as hits
            from commercial.unpriced_code_hits hit
           where hit.facility_id = actor.facility_id and hit.created_at > clock_timestamp() - interval '30 days'
             and not exists (select 1 from commercial.catalogue_items item
                              where item.facility_id = actor.facility_id and item.active
                                and item.national_code_system = hit.code_system and item.national_code = hit.code)
           group by hit.code_system, hit.code) grouped;
  perform commercial.audit('commercial.catalogue.unpriced.read', 'success', 'catalogue', actor.facility_id::text, null,
    jsonb_build_object('codes', jsonb_array_length(answer->'items')), 'ehr-api');
  return answer;
end
$$;

-- 10. Grants (here and in runtime-grants.sql), comments, owners.
revoke all on function commercial.lagos_day(timestamptz), commercial.caller(text), commercial.holds(text),
  commercial.audit(text, text, text, text, uuid, jsonb, text), commercial.command_replay(text, text, text),
  commercial.command_record(text, text, text, uuid), commercial.next_number(uuid, text, integer),
  commercial.search_text(text), commercial.name_matches(text, text), commercial.national_code_ok(text, text),
  commercial.facility_item_ok(text, text), commercial.member_name(uuid), commercial.settings_json(uuid),
  commercial.catalogue_item_json(uuid),
  commercial.catalogue_write_prices(uuid, uuid, jsonb),
  commercial.catalogue_check(uuid, uuid, text, text, text, text, text, jsonb, text, text, jsonb),
  commercial.billing_switched_on(boolean), commercial.audit_refusal(text, text, text, uuid, text),
  commercial.settings_get(), commercial.settings_put(jsonb, bigint, boolean, boolean, text, text),
  commercial.catalogue_list(text, text, boolean, integer), commercial.catalogue_create(jsonb, text, text),
  commercial.catalogue_update(uuid, jsonb, bigint, text, text), commercial.catalogue_unpriced_codes() from public;
do $grants$
declare
  runtime_role text;
begin
  foreach runtime_role in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant usage on schema commercial to %I', runtime_role);
      execute format('grant execute on function commercial.billing_switched_on(boolean), '
        || 'commercial.audit_refusal(text, text, text, uuid, text), commercial.settings_get(), '
        || 'commercial.settings_put(jsonb, bigint, boolean, boolean, text, text), '
        || 'commercial.catalogue_list(text, text, boolean, integer), commercial.catalogue_create(jsonb, text, text), '
        || 'commercial.catalogue_update(uuid, jsonb, bigint, text, text), commercial.catalogue_unpriced_codes() to %I',
        runtime_role);
    end if;
  end loop;
  -- pharmacy-api's stock and counter-sale routes ask whether billing is switched on, and audit their refusals.
  if exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    grant usage on schema commercial to hid_pharmacy_runtime;
    grant execute on function commercial.billing_switched_on(boolean),
      commercial.audit_refusal(text, text, text, uuid, text) to hid_pharmacy_runtime;
  end if;
end
$grants$;

comment on table commercial.payment_settings is
  '0163 (BILL-1): one row per facility: where money is taken, the methods, pay-before per department (off until the clinical lead signs BILL-3), deferral reasons (emergency always), transfer account, receipt footer, how the day is closed, the check-in charge item. No row: defaults, and no automatic line or gate.';
comment on table commercial.catalogue_items is
  '0163 (BILL-7, recommended option): the facility''s one item master for prices, services and stock (drug, lab_test, other). A drug or test may link to ORD-7''s national list by fixed code, or to one of this facility''s own items (HID-FACILITY, its id), unique among the facility''s active items. Never deleted.';
comment on table commercial.number_counters is
  '0163 (BILL-16): gap-free numbers per facility: bills (year 0) and receipts per year, taken FOR UPDATE.';
comment on table commercial.commands is
  '0163: one row per billing command (facility, member, Idempotency-Key, request sha256, command, resource). Append-only.';
comment on table commercial.unpriced_code_hits is
  '0163 (BILL-7): national codes that reached this facility''s pharmacy or lab with no priced item. No patient, no person. Append-only.';

-- 11. Post-checks.
do $post$
declare
  made constant jsonb := '{
    "commercial.audit(text,text,text,text,uuid,jsonb,text)": "b24a13358027789773a38c7ff2ffc278",
    "commercial.audit_refusal(text,text,text,uuid,text)": "f7c90746caf878a5c41e000cc514fc04",
    "commercial.billing_switched_on(boolean)": "135a2fe7750e58aff64ead86315851bc",
    "commercial.caller(text)": "16752b295365f4e33ed9119f55c2175f",
    "commercial.catalogue_check(uuid,uuid,text,text,text,text,text,jsonb,text,text,jsonb)": "550eaa024526a9dbe11caff467b19e2f",
    "commercial.catalogue_create(jsonb,text,text)": "8ee22c59496b27af1fd92c288d770494",
    "commercial.catalogue_item_json(uuid)": "48d74947f4016ebc645dc0d0cfea281b",
    "commercial.catalogue_list(text,text,boolean,integer)": "f562b9ae15cd9fdc292cb3d284207bec",
    "commercial.catalogue_unpriced_codes()": "733dc4fbdfd9f7159cc291fdc283ab6f",
    "commercial.catalogue_update(uuid,jsonb,bigint,text,text)": "496ac1e579fc45956cecca69d13ceb1d",
    "commercial.catalogue_write_prices(uuid,uuid,jsonb)": "8fa7f007675931a209e32a9c9b632afc",
    "commercial.command_record(text,text,text,uuid)": "84e04cc81ba491a39773741ce8e26274",
    "commercial.command_replay(text,text,text)": "e7c1ff69e15ec0ca75b1c624355d163a",
    "commercial.facility_item_ok(text,text)": "57eeb29c858d2d7c47549ff8a452aac1",
    "commercial.holds(text)": "4ee831ae9d72455e1cdeb1d4661aac69",
    "commercial.lagos_day(timestampwithtimezone)": "08620d6c3114df8123f496d76238763f",
    "commercial.member_name(uuid)": "50f7c6db29a6b99ee94973b373ed57cd",
    "commercial.name_matches(text,text)": "9a333b063df63fc0589542c064a12614",
    "commercial.national_code_ok(text,text)": "924d3cf8495302105a6b12a4bb57d592",
    "commercial.next_number(uuid,text,integer)": "a5a509b5c4943d9ff9055568c8de6da8",
    "commercial.search_text(text)": "eefd76f15d9395c254a4a590f44c700c",
    "commercial.settings_get()": "b06e5d02deeb9d233f605976825cfab7",
    "commercial.settings_json(uuid)": "49d373b14f8c3a4c851e06690b43cdf1",
    "commercial.settings_put(jsonb,bigint,boolean,boolean,text,text)": "37aa9d24c36b299e0adb4f9c96b35de6"}';
  owner_oid oid := (select nspowner from pg_namespace where nspname = 'commercial');
  -- The one policy's rule, as PostgreSQL shows it, for the owner (who made every table here).
  owner_rule constant text := format('((CURRENT_USER = %L::name) AND (facility_id = platform.current_facility_id()))',
    pg_get_userbyid(owner_oid));
  -- The tables with append_only (no UPDATE or DELETE); the others have no_delete. Every table has no_truncate.
  append_only_tables constant text[] := array['commercial.catalogue_events', 'commercial.commands', 'commercial.unpriced_code_hits'];
  computed jsonb;
  differing text;
  granted constant text[] := array['commercial.billing_switched_on(boolean)',
    'commercial.audit_refusal(text,text,text,uuid,text)', 'commercial.settings_get()',
    'commercial.settings_put(jsonb,bigint,boolean,boolean,text,text)',
    'commercial.catalogue_list(text,text,boolean,integer)', 'commercial.catalogue_create(jsonb,text,text)',
    'commercial.catalogue_update(uuid,jsonb,bigint,text,text)', 'commercial.catalogue_unpriced_codes()'];
  tables constant text[] := array['commercial.payment_settings', 'commercial.facility_hmos', 'commercial.tills',
    'commercial.catalogue_items', 'commercial.catalogue_item_prices', 'commercial.catalogue_events',
    'commercial.number_counters', 'commercial.commands', 'commercial.unpriced_code_hits'];
begin
  select jsonb_object_agg(replace(proc.oid::regprocedure::text, ' ', ''), md5(proc.prosrc)) into computed
    from pg_proc proc where proc.pronamespace = 'commercial'::regnamespace;
  if made = '{}'::jsonb then
    raise notice '0163 made: %', computed;
  elsif computed is distinct from made then
    select string_agg(key, ', ') into differing from (
      select key from jsonb_each_text(made) where computed->>key is distinct from value
      union select key from jsonb_each_text(computed) where made->>key is null) keys;
    raise exception using errcode = '55000', message = '0163: post-check failed: functions differ: ' || differing;
  end if;
  if exists (select 1 from pg_proc proc where proc.pronamespace = 'commercial'::regnamespace
              and (proc.proowner <> owner_oid or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
                   or proc.prosecdef <> (replace(proc.oid::regprocedure::text, ' ', '') = any (granted)))) then
    raise exception using errcode = '55000', message = '0163: post-check failed: a function''s owner, search_path or SECURITY DEFINER';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.pronamespace = 'commercial'::regnamespace and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or (pg_get_userbyid(acl.grantee) not in ('hid_ehr_runtime', 'hid_schema_test_runtime')
                                         and not (pg_get_userbyid(acl.grantee) = 'hid_pharmacy_runtime'
                                                  and replace(proc.oid::regprocedure::text, ' ', '') in
                                                      ('commercial.billing_switched_on(boolean)',
                                                       'commercial.audit_refusal(text,text,text,uuid,text)')))
                     or not (replace(proc.oid::regprocedure::text, ' ', '') = any (granted)))) then
    raise exception using errcode = '55000', message = '0163: post-check failed: a function is granted to another role';
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
    raise exception using errcode = '55000', message = '0163: post-check failed: a table''s row-level security, policy, ACL or triggers';
  end if;
  if exists (select 1 from commercial.payment_settings) or exists (select 1 from commercial.catalogue_items) then
    raise exception using errcode = '55000', message = '0163: post-check failed: the tables must be empty';
  end if;
end
$post$;
