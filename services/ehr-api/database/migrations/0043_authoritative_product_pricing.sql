-- Identity-owned commercial catalog. Published amounts live only in this
-- price table; the frontend catalog supplies presentation copy, not prices.
insert into auth.permissions (code, description) values
  ('platform.pricing.read', 'Read the full commercial product and price catalog'),
  ('platform.pricing.manage', 'Change governed commercial products and prices')
on conflict (code) do update set description = excluded.description, active = true;

insert into auth.role_permissions (role_code, permission_code)
select role_code, permission_code from (values
  ('platform_admin', 'platform.pricing.read'),
  ('platform_admin', 'platform.pricing.manage'),
  ('platform_super_admin', 'platform.pricing.read'),
  ('platform_super_admin', 'platform.pricing.manage'),
  ('platform_operations_admin', 'platform.pricing.read')
) as grants(role_code, permission_code)
on conflict (role_code, permission_code) do nothing;

create table platform.commercial_products (
  slug text primary key check (slug ~ '^[a-z][a-z0-9-]{1,63}$'),
  name text not null check (length(btrim(name)) between 2 and 120),
  status text not null check (status in ('active', 'coming_soon', 'draft', 'retired')),
  row_version bigint not null default 1 check (row_version > 0),
  updated_by uuid references auth.accounts(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp()
);

create table platform.commercial_prices (
  product_slug text not null references platform.commercial_products(slug) on delete restrict,
  context text not null check (context in ('core', 'addon', 'standalone', 'usage', 'setup', 'migration_project', 'enterprise')),
  visibility text not null check (visibility in ('fixed', 'starting_from', 'contact_sales', 'custom_quote', 'hidden')),
  amount_minor bigint check (amount_minor between 0 and 9007199254740991),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  billing_period text check (billing_period is null or billing_period ~ '^[a-z][a-z0-9_]{1,39}$'),
  unit text check (unit is null or length(btrim(unit)) between 1 and 80),
  active boolean not null default true,
  row_version bigint not null default 1 check (row_version > 0),
  updated_by uuid references auth.accounts(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (product_slug, context),
  constraint commercial_price_visibility_amount_ck check (
    (visibility in ('fixed', 'starting_from') and amount_minor is not null)
    or (visibility in ('contact_sales', 'custom_quote', 'hidden') and amount_minor is null)
  )
);

-- Every public product/context starts as contact sales. No monetary amount is
-- inferred from the historical site or from an infrastructure cost estimate.
insert into platform.commercial_products (slug, name, status) values
  ('identity', 'HID Identity', 'active'),
  ('ehr', 'HID EHR', 'active'),
  ('laboratory', 'HID Laboratory', 'active'),
  ('pharmacy', 'HID Pharmacy', 'active'),
  ('migrate', 'HID Migrate', 'active'),
  ('outreach', 'HID Outreach', 'active'),
  ('api', 'HID API', 'coming_soon');

insert into platform.commercial_prices
  (product_slug, context, visibility, amount_minor, currency, billing_period, unit) values
  ('identity', 'core', 'contact_sales', null, 'NGN', null, null),
  ('ehr', 'core', 'contact_sales', null, 'NGN', null, null),
  ('laboratory', 'addon', 'contact_sales', null, 'NGN', null, null),
  ('laboratory', 'standalone', 'contact_sales', null, 'NGN', null, null),
  ('pharmacy', 'addon', 'contact_sales', null, 'NGN', null, null),
  ('pharmacy', 'standalone', 'contact_sales', null, 'NGN', null, null),
  ('migrate', 'addon', 'contact_sales', null, 'NGN', null, null),
  ('migrate', 'standalone', 'contact_sales', null, 'NGN', null, null),
  ('migrate', 'usage', 'contact_sales', null, 'NGN', null, null),
  ('outreach', 'standalone', 'contact_sales', null, 'NGN', null, null),
  ('api', 'usage', 'contact_sales', null, 'NGN', null, null);

create table platform.commercial_catalog_events (
  sequence_id bigint generated always as identity primary key,
  event_id uuid not null unique default gen_random_uuid(),
  resource_kind text not null check (resource_kind in ('product', 'price')),
  product_slug text not null references platform.commercial_products(slug) on delete restrict,
  context text,
  previous_version bigint not null check (previous_version > 0),
  new_version bigint not null check (new_version = previous_version + 1),
  before_value jsonb not null check (jsonb_typeof(before_value) = 'object'),
  after_value jsonb not null check (jsonb_typeof(after_value) = 'object'),
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  occurred_at timestamptz not null default clock_timestamp(),
  check ((resource_kind = 'product' and context is null) or
         (resource_kind = 'price' and context is not null)),
  unique (resource_kind, product_slug, context, new_version)
);
create trigger commercial_catalog_events_no_mutation
  before update or delete on platform.commercial_catalog_events
  for each row execute function platform.reject_mutation();

alter table platform.commercial_products enable row level security;
alter table platform.commercial_products force row level security;
alter table platform.commercial_prices enable row level security;
alter table platform.commercial_prices force row level security;
alter table platform.commercial_catalog_events enable row level security;
alter table platform.commercial_catalog_events force row level security;

create policy commercial_products_public_read on platform.commercial_products
  for select using (status = 'active');
create policy commercial_products_admin_read on platform.commercial_products
  for select using (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.pricing.read'));
create policy commercial_products_admin_update on platform.commercial_products
  for update using (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.pricing.manage'))
  with check (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.pricing.manage'));

create policy commercial_prices_public_read on platform.commercial_prices
  for select using (active and visibility <> 'hidden' and exists (
    select 1 from platform.commercial_products product
    where product.slug = product_slug and product.status = 'active'));
create policy commercial_prices_admin_read on platform.commercial_prices
  for select using (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.pricing.read'));
create policy commercial_prices_admin_update on platform.commercial_prices
  for update using (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.pricing.manage'))
  with check (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.pricing.manage'));
create policy commercial_catalog_events_admin_insert on platform.commercial_catalog_events
  for insert with check (actor_account_id = platform.current_account_id() and
    auth.account_has_platform_permission(actor_account_id, 'platform.pricing.manage'));

create or replace function platform.public_list_commercial_prices()
returns table (product_slug text, context text, visibility text, amount_minor bigint,
  currency text, billing_period text, unit text)
language sql stable security definer
set search_path = platform, pg_temp
as $$
  select price.product_slug, price.context, price.visibility, price.amount_minor,
    price.currency, price.billing_period, price.unit
  from platform.commercial_prices price
  join platform.commercial_products product on product.slug = price.product_slug
  where product.status = 'active' and price.active and price.visibility <> 'hidden'
  order by product.slug, price.context
$$;

create or replace function platform.admin_list_commercial_products()
returns table (id text, slug text, name text, status text, row_version bigint, updated_at timestamptz)
language plpgsql stable security definer
set search_path = platform, auth, pg_temp
as $$
begin
  if not auth.account_has_platform_permission(platform.current_account_id(), 'platform.pricing.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return query select product.slug, product.slug, product.name, product.status,
    product.row_version, product.updated_at
  from platform.commercial_products product order by product.slug;
end
$$;

create or replace function platform.admin_list_commercial_prices()
returns table (product_id text, product_slug text, context text, visibility text,
  amount_minor bigint, currency text, billing_period text, unit text, active boolean,
  row_version bigint, updated_at timestamptz)
language plpgsql stable security definer
set search_path = platform, auth, pg_temp
as $$
begin
  if not auth.account_has_platform_permission(platform.current_account_id(), 'platform.pricing.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return query select price.product_slug, price.product_slug, price.context,
    price.visibility, price.amount_minor, price.currency, price.billing_period,
    price.unit, price.active, price.row_version, price.updated_at
  from platform.commercial_prices price order by price.product_slug, price.context;
end
$$;

create or replace function platform.admin_set_commercial_product(
  requested_slug text, expected_version bigint, requested_name text, requested_status text,
  requested_reason text, requested_idempotency_key text, requested_sha256 char(64))
returns table (slug text, name text, status text, row_version bigint, replayed boolean)
language plpgsql security definer
set search_path = platform, auth, pg_temp
as $$
declare
  actor uuid := platform.current_account_id();
  previous_row platform.commercial_products%rowtype;
  current_row platform.commercial_products%rowtype;
  command auth.admin_command_idempotency%rowtype;
  response jsonb;
begin
  if not auth.account_has_platform_permission(actor, 'platform.pricing.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_slug is null or requested_slug !~ '^[a-z][a-z0-9-]{1,63}$'
    or requested_name is null or length(btrim(requested_name)) not between 2 and 120
    or requested_status is null or requested_status not in ('active', 'coming_soon', 'draft', 'retired')
    or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
    or expected_version is null or expected_version < 1
    or requested_idempotency_key is null or length(requested_idempotency_key) not between 8 and 200
    or requested_sha256 is null or requested_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_PRODUCT';
  end if;
  select * into command from auth.admin_command_idempotency evidence
  where evidence.actor_account_id = actor and evidence.operation = 'commercial.product.update'
    and evidence.idempotency_key = requested_idempotency_key;
  if found then
    if command.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select command.response->>'slug', command.response->>'name',
      command.response->>'status', (command.response->>'version')::bigint, true;
    return;
  end if;
  select * into previous_row from platform.commercial_products product
  where product.slug = requested_slug for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ADMIN_PRODUCT_NOT_FOUND';
  end if;
  if previous_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if previous_row.name = btrim(requested_name) and previous_row.status = requested_status then
    raise exception using errcode = '23514', message = 'ADMIN_NO_STATE_CHANGE';
  end if;
  update platform.commercial_products product
  set name = btrim(requested_name), status = requested_status,
    row_version = product.row_version + 1, updated_by = actor, updated_at = clock_timestamp()
  where product.slug = requested_slug returning product.* into current_row;
  insert into platform.commercial_catalog_events (resource_kind, product_slug,
    previous_version, new_version, before_value, after_value, actor_account_id,
    reason, correlation_id)
  values ('product', requested_slug, previous_row.row_version, current_row.row_version,
    jsonb_build_object('name', previous_row.name, 'status', previous_row.status),
    jsonb_build_object('name', current_row.name, 'status', current_row.status),
    actor, btrim(requested_reason), platform.current_correlation_id());
  response := jsonb_build_object('slug', current_row.slug, 'name', current_row.name,
    'status', current_row.status, 'version', current_row.row_version);
  insert into auth.admin_command_idempotency
    (actor_account_id, operation, idempotency_key, request_sha256, response)
  values (actor, 'commercial.product.update', requested_idempotency_key, requested_sha256, response);
  return query select current_row.slug, current_row.name, current_row.status, current_row.row_version, false;
end
$$;

create or replace function platform.admin_set_commercial_price(
  requested_slug text, requested_context text, expected_version bigint,
  requested_visibility text, requested_amount_minor bigint, requested_currency text,
  requested_billing_period text, requested_unit text, requested_active boolean,
  requested_reason text, requested_idempotency_key text, requested_sha256 char(64))
returns table (product_slug text, context text, visibility text, amount_minor bigint,
  currency text, billing_period text, unit text, active boolean, row_version bigint, replayed boolean)
language plpgsql security definer
set search_path = platform, auth, pg_temp
as $$
declare
  actor uuid := platform.current_account_id();
  previous_row platform.commercial_prices%rowtype;
  current_row platform.commercial_prices%rowtype;
  command auth.admin_command_idempotency%rowtype;
  response jsonb;
begin
  if not auth.account_has_platform_permission(actor, 'platform.pricing.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_slug is null or requested_slug !~ '^[a-z][a-z0-9-]{1,63}$'
    or requested_context is null or requested_context not in
      ('core', 'addon', 'standalone', 'usage', 'setup', 'migration_project', 'enterprise')
    or expected_version is null or expected_version < 1
    or requested_visibility is null or requested_visibility not in
      ('fixed', 'starting_from', 'contact_sales', 'custom_quote', 'hidden')
    or (requested_visibility in ('fixed', 'starting_from') and
      (requested_amount_minor is null or requested_amount_minor < 0 or requested_amount_minor > 9007199254740991))
    or (requested_visibility in ('contact_sales', 'custom_quote', 'hidden') and requested_amount_minor is not null)
    or requested_currency is null or requested_currency !~ '^[A-Z]{3}$'
    or (requested_billing_period is not null and
      requested_billing_period !~ '^[a-z][a-z0-9_]{1,39}$')
    or (requested_unit is not null and length(btrim(requested_unit)) not between 1 and 80)
    or requested_active is null
    or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
    or requested_idempotency_key is null or length(requested_idempotency_key) not between 8 and 200
    or requested_sha256 is null or requested_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_PRICE';
  end if;
  select * into command from auth.admin_command_idempotency evidence
  where evidence.actor_account_id = actor and evidence.operation = 'commercial.price.update'
    and evidence.idempotency_key = requested_idempotency_key;
  if found then
    if command.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select command.response->>'productSlug', command.response->>'context',
      command.response->>'visibility', (command.response->>'amountMinor')::bigint,
      command.response->>'currency', command.response->>'billingPeriod',
      command.response->>'unit', (command.response->>'active')::boolean,
      (command.response->>'version')::bigint, true;
    return;
  end if;
  select * into previous_row from platform.commercial_prices price
  where price.product_slug = requested_slug and price.context = requested_context for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ADMIN_PRICE_NOT_FOUND';
  end if;
  if previous_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if previous_row.visibility = requested_visibility
    and previous_row.amount_minor is not distinct from requested_amount_minor
    and previous_row.currency = requested_currency
    and previous_row.billing_period is not distinct from requested_billing_period
    and previous_row.unit is not distinct from requested_unit
    and previous_row.active = requested_active then
    raise exception using errcode = '23514', message = 'ADMIN_NO_STATE_CHANGE';
  end if;
  update platform.commercial_prices price
  set visibility = requested_visibility, amount_minor = requested_amount_minor,
    currency = requested_currency, billing_period = requested_billing_period,
    unit = requested_unit, active = requested_active,
    row_version = price.row_version + 1, updated_by = actor, updated_at = clock_timestamp()
  where price.product_slug = requested_slug and price.context = requested_context
  returning price.* into current_row;
  insert into platform.commercial_catalog_events (resource_kind, product_slug, context,
    previous_version, new_version, before_value, after_value, actor_account_id,
    reason, correlation_id)
  values ('price', requested_slug, requested_context, previous_row.row_version, current_row.row_version,
    jsonb_build_object('visibility', previous_row.visibility, 'amountMinor', previous_row.amount_minor,
      'currency', previous_row.currency, 'billingPeriod', previous_row.billing_period,
      'unit', previous_row.unit, 'active', previous_row.active),
    jsonb_build_object('visibility', current_row.visibility, 'amountMinor', current_row.amount_minor,
      'currency', current_row.currency, 'billingPeriod', current_row.billing_period,
      'unit', current_row.unit, 'active', current_row.active),
    actor, btrim(requested_reason), platform.current_correlation_id());
  response := jsonb_build_object('productSlug', current_row.product_slug,
    'context', current_row.context, 'visibility', current_row.visibility,
    'amountMinor', current_row.amount_minor, 'currency', current_row.currency,
    'billingPeriod', current_row.billing_period, 'unit', current_row.unit,
    'active', current_row.active, 'version', current_row.row_version);
  insert into auth.admin_command_idempotency
    (actor_account_id, operation, idempotency_key, request_sha256, response)
  values (actor, 'commercial.price.update', requested_idempotency_key, requested_sha256, response);
  return query select current_row.product_slug, current_row.context, current_row.visibility,
    current_row.amount_minor, current_row.currency, current_row.billing_period,
    current_row.unit, current_row.active, current_row.row_version, false;
end
$$;

revoke all on platform.commercial_products, platform.commercial_prices,
  platform.commercial_catalog_events from public;
revoke all on all sequences in schema platform from public;
revoke all on function platform.public_list_commercial_prices(),
  platform.admin_list_commercial_products(), platform.admin_list_commercial_prices(),
  platform.admin_set_commercial_product(text, bigint, text, text, text, text, char),
  platform.admin_set_commercial_price(text, text, bigint, text, bigint, text, text, text, boolean, text, text, char)
  from public;

comment on table platform.commercial_prices is
  'Single authoritative product/context price catalog; quote states carry no invented amount.';
comment on table platform.commercial_catalog_events is
  'Immutable reasoned changes to products and prices, scoped to a platform administrator.';
