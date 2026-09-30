\set ON_ERROR_STOP on
begin;

insert into auth.accounts(id, subject, status) values
  ('d4700000-0000-4000-8000-000000000001', 'staff:integration-admin', 'active'),
  ('d4700000-0000-4000-8000-000000000002', 'staff:integration-reader', 'active');
insert into auth.account_roles(id, account_id, role_code, scope_type, grant_reason)
values ('d4710000-0000-4000-8000-000000000001',
  'd4700000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
  'Synthetic integration management test');

set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'provider-integration-test-0001', true);
select set_config('app.actor_subject', 'staff:integration-reader', true);
do $$ begin
  if has_table_privilege(current_user, 'platform.integration_providers', 'UPDATE')
    or has_table_privilege(current_user, 'platform.integration_events', 'INSERT') then
    raise exception 'Identity runtime received direct provider mutation privilege';
  end if;
  begin
    perform platform.admin_list_integration_providers();
    raise exception 'Unprivileged caller read integration catalog';
  exception when insufficient_privilege then null;
  end;
  begin
    perform platform.admin_set_integration_provider('termii', 1, false, '{}'::jsonb,
      'pause', 'Synthetic provider pause', 'integration-pause-key-0001', repeat('a',64)::char(64));
    raise exception 'Unprivileged caller paused provider';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('app.actor_subject', 'staff:integration-admin', true);
do $$
declare changed record; replay record;
begin
  if (select count(*) from platform.admin_list_integration_providers()) <> 15
    or (select count(*) from platform.admin_list_integration_routes()) <> 3 then
    raise exception 'Integration inventory or routing catalog incomplete';
  end if;
  if (select enabled from platform.integration_runtime_provider('qoreid','patient_nin'))
    or (select enabled from platform.integration_runtime_provider('qoreid','provider_cac')) then
    raise exception 'QoreID started enabled without entitlement';
  end if;
  select * into changed from platform.admin_set_integration_provider('termii', 1, false, '{}'::jsonb,
    'pause', 'Synthetic provider pause', 'integration-pause-key-0001', repeat('a',64)::char(64));
  select * into replay from platform.admin_set_integration_provider('termii', 1, false, '{}'::jsonb,
    'pause', 'Synthetic provider pause', 'integration-pause-key-0001', repeat('a',64)::char(64));
  if changed.replayed or not replay.replayed or changed.row_version <> 2 or replay.row_version <> 2
    or (select enabled from platform.integration_runtime_provider('termii','sms')) then
    raise exception 'Pause or idempotent replay failed';
  end if;
  begin
    perform platform.admin_set_integration_provider('termii', 1, false, '{}'::jsonb,
      'pause', 'Synthetic provider pause', 'integration-pause-key-0001', repeat('f',64)::char(64));
    raise exception 'Changed idempotency replay was accepted';
  exception when unique_violation then null;
  end;
  begin
    perform platform.admin_set_integration_provider('termii', 2, false,
      '{"apiKey":"secret"}'::jsonb, 'configure', 'Synthetic unsafe configuration',
      'integration-config-key-0001', repeat('b',64)::char(64));
    raise exception 'Secret-like configuration was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform platform.admin_set_integration_route('sms', 1, 'qoreid', 'brevo',
      'select', 'Synthetic incompatible selection', 'integration-route-key-0001',
      repeat('c',64)::char(64));
    raise exception 'Incompatible provider was selected for SMS';
  exception when invalid_parameter_value then null;
  end;
  select * into changed from platform.admin_set_integration_provider('termii', 2, true, '{}'::jsonb,
    'enable', 'Synthetic provider restore', 'integration-enable-key-0001', repeat('d',64)::char(64));
  if changed.row_version <> 3 or not (select enabled from platform.integration_runtime_provider('termii','sms')) then
    raise exception 'Re-enable did not restore runtime provider state';
  end if;
  select * into changed from platform.admin_set_integration_provider('termii', 3, true,
    '{"senderId":"HID"}'::jsonb, 'configure', 'Synthetic sender update',
    'integration-config-key-0002', repeat('e',64)::char(64));
  if changed.configuration->>'senderId' <> 'HID'
    or (select configuration->>'senderId' from platform.integration_runtime_provider('termii','sms')) <> 'HID' then
    raise exception 'Safe configuration did not reach runtime';
  end if;
  perform platform.admin_set_integration_route('email', 1, 'ses', null,
    'fallback', 'Synthetic fallback clear', 'integration-route-key-0002', repeat('1',64)::char(64));
  select * into changed from platform.admin_set_integration_route('email', 2, 'brevo', null,
    'select', 'Synthetic provider selection', 'integration-route-key-0003', repeat('2',64)::char(64));
  perform platform.admin_set_integration_route('email', 3, 'brevo', 'ses',
    'fallback', 'Synthetic fallback selection', 'integration-route-key-0004', repeat('3',64)::char(64));
  if changed.active_provider <> 'brevo'
    or (select active_provider from platform.integration_runtime_route('email')) <> 'brevo' then
    raise exception 'Capability routing did not reach runtime';
  end if;
  if (select count(*) from platform.admin_list_integration_events('termii',100)) < 3 then
    raise exception 'Provider history omitted mutations';
  end if;
  if platform.admin_integration_test_replay('integration-test-key-0001',
      repeat('4',64)::char(64)) is not null then
    raise exception 'Unrun test had a replay response';
  end if;
  select * into changed from platform.admin_record_integration_test('qoreid', 1, 'unknown',
    'Synthetic non-sending check', 'integration-test-key-0001', repeat('4',64)::char(64));
  if changed.replayed or changed.row_version <> 2
    or platform.admin_integration_test_replay('integration-test-key-0001',
      repeat('4',64)::char(64))->>'status' <> 'unknown' then
    raise exception 'Connection test evidence or replay failed';
  end if;
end $$;

rollback;
