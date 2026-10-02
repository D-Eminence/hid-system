\set ON_ERROR_STOP on
begin;

insert into auth.accounts(id, subject, email, status)
values
 ('b1000000-0000-4000-8000-000000000001', 'synthetic:demo:admin', 'demo-admin@example.invalid', 'active'),
 ('b1000000-0000-4000-8000-000000000002', 'synthetic:demo:patient', 'demo-patient@example.invalid', 'active');
insert into auth.account_roles(id, account_id, role_code, scope_type, grant_reason)
values ('b2000000-0000-4000-8000-000000000001',
 'b1000000-0000-4000-8000-000000000001', 'platform_admin', 'platform',
 'Synthetic demo administration test');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true);
insert into identity.demo_requests(id, idempotency_key_sha256, contact_name, contact_email, product_code)
values ('b3000000-0000-4000-8000-000000000001', repeat('a', 64),
 'Synthetic demo contact', 'demo-contact@example.invalid', 'api');
do $$ begin
  if exists(select 1 from identity.demo_requests
    where id = 'b3000000-0000-4000-8000-000000000001') then
    raise exception 'anonymous intake could read demo contact details';
  end if;
end $$;

select set_config('app.actor_subject', 'synthetic:demo:patient', true);
do $$ begin
  if exists(select 1 from identity.demo_requests
    where id = 'b3000000-0000-4000-8000-000000000001') then
    raise exception 'ordinary account could read demo contact details';
  end if;
end $$;

select set_config('app.actor_subject', 'synthetic:demo:admin', true);
do $$ begin
  if not exists(select 1 from identity.demo_requests
    where id = 'b3000000-0000-4000-8000-000000000001') then
    raise exception 'permitted platform admin could not read demo request';
  end if;
end $$;
update identity.demo_requests set status = 'contacted', row_version = row_version + 1
where id = 'b3000000-0000-4000-8000-000000000001';
insert into identity.demo_request_events
  (request_id, from_status, to_status, reason, actor_account_id, correlation_id)
values ('b3000000-0000-4000-8000-000000000001', 'new', 'contacted',
 'Synthetic contact attempt', 'b1000000-0000-4000-8000-000000000001', 'synthetic-demo-0001');
do $$ begin
  if not exists(select 1 from identity.demo_request_events
    where request_id = 'b3000000-0000-4000-8000-000000000001') then
    raise exception 'demo state event was not readable to platform admin';
  end if;
end $$;

rollback;
