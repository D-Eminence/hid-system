\set ON_ERROR_STOP on
begin;

insert into auth.accounts (id, subject, status) values
  ('d4300000-0000-4000-8000-000000000001', 'staff:pricing-test-admin', 'active'),
  ('d4300000-0000-4000-8000-000000000002', 'staff:pricing-test-reader', 'active');
insert into auth.account_roles
  (id, account_id, role_code, scope_type, grant_reason) values
  ('d4310000-0000-4000-8000-000000000001',
   'd4300000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
   'Synthetic pricing administration test');

set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'pricing-integration-0001', true);
select set_config('app.actor_subject', 'staff:pricing-test-reader', true);

do $$
begin
  if has_table_privilege(current_user, 'platform.commercial_prices', 'UPDATE')
    or has_table_privilege(current_user, 'platform.commercial_products', 'UPDATE')
    or has_table_privilege(current_user, 'platform.commercial_catalog_events', 'INSERT') then
    raise exception 'Pricing runtime received direct mutation privilege';
  end if;
  if not has_function_privilege(current_user,
    'platform.public_list_commercial_prices()', 'EXECUTE') then
    raise exception 'Public pricing function is unavailable to the Identity runtime';
  end if;
  if (select count(*) from platform.public_list_commercial_prices()
      where product_slug = 'ehr' and context = 'core' and
        visibility = 'contact_sales' and amount_minor is null) <> 1
    or exists (select 1 from platform.public_list_commercial_prices()
      where product_slug = 'api') then
    raise exception 'Initial public prices published a fabricated amount or unavailable product';
  end if;
  begin
    perform platform.admin_list_commercial_prices();
    raise exception 'Unprivileged caller read the admin price catalog';
  exception when insufficient_privilege then null;
  end;
  begin
    perform platform.admin_set_commercial_product('ehr', 1, 'HID EHR Plus', 'active',
      'Synthetic product update', 'pricing-product-key-0001', repeat('a',64)::char(64));
    raise exception 'Unprivileged caller changed a commercial product';
  exception when insufficient_privilege then null;
  end;
end
$$;

select set_config('app.actor_subject', 'staff:pricing-test-admin', true);
do $$
declare
  changed record;
  replay record;
begin
  if (select count(*) from platform.admin_list_commercial_products()) <> 7
    or (select count(*) from platform.admin_list_commercial_prices()) <> 11 then
    raise exception 'Admin catalog did not expose the complete seeded product/context set';
  end if;

  select * into changed from platform.admin_set_commercial_product(
    'ehr', 1, 'HID EHR Plus', 'active', 'Synthetic product update',
    'pricing-product-key-0001', repeat('a',64)::char(64));
  select * into replay from platform.admin_set_commercial_product(
    'ehr', 1, 'HID EHR Plus', 'active', 'Synthetic product update',
    'pricing-product-key-0001', repeat('a',64)::char(64));
  if changed.replayed or changed.row_version <> 2 or not replay.replayed
    or replay.row_version <> 2 then
    raise exception 'Product version or idempotent replay failed';
  end if;
  begin
    perform platform.admin_set_commercial_product(
      'ehr', 1, 'HID EHR Plus', 'active', 'Synthetic product update',
      'pricing-product-key-0001', repeat('f',64)::char(64));
    raise exception 'Changed product replay was accepted';
  exception when unique_violation then null;
  end;

  select * into changed from platform.admin_set_commercial_price(
    'ehr', 'core', 1, 'fixed', 1250000, 'NGN', 'month', null, true,
    'Synthetic approved amount', 'pricing-price-key-0001', repeat('b',64)::char(64));
  select * into replay from platform.admin_set_commercial_price(
    'ehr', 'core', 1, 'fixed', 1250000, 'NGN', 'month', null, true,
    'Synthetic approved amount', 'pricing-price-key-0001', repeat('b',64)::char(64));
  if changed.replayed or changed.row_version <> 2 or changed.amount_minor <> 1250000
    or not replay.replayed or replay.row_version <> 2 then
    raise exception 'Price change or idempotent replay failed';
  end if;
  if (select amount_minor from platform.public_list_commercial_prices()
      where product_slug = 'ehr' and context = 'core') <> 1250000 then
    raise exception 'Public pricing did not read the authoritative edited amount';
  end if;
  begin
    perform platform.admin_set_commercial_price(
      'ehr', 'core', 1, 'fixed', 1300000, 'NGN', 'month', null, true,
      'Synthetic stale update', 'pricing-price-key-0002', repeat('c',64)::char(64));
    raise exception 'Stale price version was accepted';
  exception when serialization_failure then null;
  end;
  begin
    perform platform.admin_set_commercial_price(
      'ehr', 'core', 2, 'contact_sales', 1, 'NGN', null, null, true,
      'Synthetic invalid amount', 'pricing-price-key-0003', repeat('d',64)::char(64));
    raise exception 'Quote price retained an amount';
  exception when invalid_parameter_value then null;
  end;
  select * into changed from platform.admin_set_commercial_price(
    'ehr', 'core', 2, 'hidden', null, 'NGN', null, null, true,
    'Synthetic hidden price', 'pricing-price-key-0004', repeat('e',64)::char(64));
  if changed.row_version <> 3 or exists (
    select 1 from platform.public_list_commercial_prices()
    where product_slug = 'ehr' and context = 'core') then
    raise exception 'Hidden price remained publicly visible';
  end if;
  begin
    update platform.commercial_prices set amount_minor = 1
      where product_slug = 'ehr' and context = 'core';
    raise exception 'Identity runtime directly changed a price';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

do $$
begin
  if (select count(*) from platform.commercial_catalog_events
      where product_slug = 'ehr') <> 3
    or (select count(*) from auth.admin_command_idempotency
      where operation like 'commercial.%') <> 3 then
    raise exception 'Pricing changes lacked immutable events or replay evidence';
  end if;
end
$$;

rollback;
