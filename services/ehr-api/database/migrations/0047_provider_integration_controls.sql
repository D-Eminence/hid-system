-- Identity owns operational provider selection. Credentials remain in the
-- deployment secret stores; this catalog contains only allowlisted settings.
insert into auth.permissions(code, description) values
  ('platform.integration.read', 'Read provider integration state and history'),
  ('platform.integration.manage', 'Change approved provider routing and pause state'),
  ('platform.integration.test', 'Run approved non-sending provider checks')
on conflict (code) do update set description = excluded.description, active = true;

insert into auth.role_permissions(role_code, permission_code)
select role_code, permission_code from (values
  ('platform_admin', 'platform.integration.read'),
  ('platform_admin', 'platform.integration.manage'),
  ('platform_admin', 'platform.integration.test'),
  ('platform_super_admin', 'platform.integration.read'),
  ('platform_super_admin', 'platform.integration.manage'),
  ('platform_super_admin', 'platform.integration.test'),
  ('platform_operations_admin', 'platform.integration.read'),
  ('platform_operations_admin', 'platform.integration.test'),
  ('security_auditor', 'platform.integration.read')
) as grants(role_code, permission_code)
on conflict (role_code, permission_code) do nothing;

create table platform.integration_providers (
  provider text primary key check (provider ~ '^[a-z][a-z0-9-]{1,63}$'),
  display_name text not null,
  enabled boolean not null,
  runtime_control boolean not null,
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object'),
  credential_source text not null check (credential_source in ('aws-secret', 'aws-iam', 'deployment', 'none')),
  last_test_status text check (last_test_status in ('healthy', 'degraded', 'failed', 'unknown')),
  last_tested_at timestamptz,
  last_successful_test_at timestamptz,
  last_failed_test_at timestamptz,
  row_version bigint not null default 1 check (row_version > 0),
  updated_by uuid references auth.accounts(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp()
);

insert into platform.integration_providers
  (provider, display_name, enabled, runtime_control, credential_source) values
  ('ses', 'AWS SES', true, true, 'aws-iam'),
  ('termii', 'Termii', true, true, 'aws-secret'),
  ('meta-whatsapp', 'Meta / WhatsApp', true, true, 'aws-secret'),
  ('brevo', 'Brevo', true, true, 'aws-secret'),
  ('qoreid', 'QoreID', false, true, 'aws-secret'),
  ('novu', 'Novu', true, false, 'aws-secret'),
  ('turnstile', 'Cloudflare Turnstile', true, false, 'aws-secret'),
  ('google-oidc', 'Google OIDC', true, false, 'deployment'),
  ('piersflow', 'PiersFlow', false, false, 'none'),
  ('fcm', 'Firebase Cloud Messaging', false, false, 'none'),
  ('metamap', 'MetaMap', false, false, 'none'),
  ('aws-s3', 'AWS S3 / KMS', true, false, 'aws-iam'),
  ('aws-textract', 'AWS Textract', true, false, 'aws-iam'),
  ('aws-eventbridge', 'AWS EventBridge', true, false, 'aws-iam'),
  ('aws-sqs', 'AWS SQS', true, false, 'aws-iam');

create table platform.integration_provider_capabilities (
  provider text not null references platform.integration_providers(provider) on delete restrict,
  capability text not null check (capability ~ '^[a-z][a-z0-9_]{1,63}$'),
  primary key (provider, capability)
);

insert into platform.integration_provider_capabilities(provider, capability) values
  ('ses', 'email'), ('termii', 'sms'),
  ('meta-whatsapp', 'whatsapp'),
  ('brevo', 'email'), ('brevo', 'sms'), ('brevo', 'whatsapp'),
  ('qoreid', 'patient_nin'), ('qoreid', 'provider_cac'),
  ('novu', 'notifications'), ('turnstile', 'bot_protection'),
  ('google-oidc', 'login'), ('aws-s3', 'storage'),
  ('aws-textract', 'ocr'), ('aws-eventbridge', 'events'),
  ('aws-sqs', 'queue');

create table platform.integration_capability_routes (
  capability text primary key check (capability in ('email', 'sms', 'whatsapp')),
  active_provider text not null,
  fallback_provider text,
  row_version bigint not null default 1 check (row_version > 0),
  updated_by uuid references auth.accounts(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (active_provider, capability)
    references platform.integration_provider_capabilities(provider, capability),
  foreign key (fallback_provider, capability)
    references platform.integration_provider_capabilities(provider, capability),
  check (fallback_provider is null or fallback_provider <> active_provider)
);

insert into platform.integration_capability_routes(capability, active_provider, fallback_provider) values
  ('email', 'ses', 'brevo'), ('sms', 'termii', 'brevo'),
  ('whatsapp', 'meta-whatsapp', 'brevo');

create table platform.integration_events (
  sequence_id bigint generated always as identity primary key,
  provider text references platform.integration_providers(provider) on delete restrict,
  capability text,
  action text not null check (action in ('enable', 'pause', 'configure', 'select', 'fallback', 'test')),
  before_value jsonb not null check (jsonb_typeof(before_value) = 'object'),
  after_value jsonb not null check (jsonb_typeof(after_value) = 'object'),
  reason text not null check (length(btrim(reason)) between 8 and 500),
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  correlation_id text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  check ((provider is not null and capability is null) or
    (provider is null and capability in ('email', 'sms', 'whatsapp')))
);
create index integration_events_provider_idx on platform.integration_events(provider, sequence_id desc);
create index integration_events_capability_idx on platform.integration_events(capability, sequence_id desc);
create trigger integration_events_no_mutation before update or delete on platform.integration_events
  for each row execute function platform.reject_mutation();

alter table platform.integration_providers enable row level security;
alter table platform.integration_providers force row level security;
alter table platform.integration_provider_capabilities enable row level security;
alter table platform.integration_provider_capabilities force row level security;
alter table platform.integration_capability_routes enable row level security;
alter table platform.integration_capability_routes force row level security;
alter table platform.integration_events enable row level security;
alter table platform.integration_events force row level security;

-- Direct table privileges are not granted to application runtimes. These
-- policies allow the narrow security-definer read and command functions below.
create policy integration_provider_function_read on platform.integration_providers for select using (true);
create policy integration_provider_function_update on platform.integration_providers for update
  using (auth.account_has_platform_permission(platform.current_account_id(), 'platform.integration.manage') or
    auth.account_has_platform_permission(platform.current_account_id(), 'platform.integration.test'))
  with check (auth.account_has_platform_permission(platform.current_account_id(), 'platform.integration.manage') or
    auth.account_has_platform_permission(platform.current_account_id(), 'platform.integration.test'));
create policy integration_capability_function_read on platform.integration_provider_capabilities for select using (true);
create policy integration_route_function_read on platform.integration_capability_routes for select using (true);
create policy integration_route_function_update on platform.integration_capability_routes for update
  using (auth.account_has_platform_permission(platform.current_account_id(), 'platform.integration.manage'))
  with check (auth.account_has_platform_permission(platform.current_account_id(), 'platform.integration.manage'));
create policy integration_event_function_read on platform.integration_events for select using (true);
create policy integration_event_function_insert on platform.integration_events for insert
  with check (actor_account_id = platform.current_account_id() and
    (auth.account_has_platform_permission(actor_account_id, 'platform.integration.manage') or
     auth.account_has_platform_permission(actor_account_id, 'platform.integration.test')));

create function platform.integration_runtime_provider(requested_provider text, requested_capability text)
returns table(enabled boolean, configuration jsonb)
language plpgsql stable security definer
set search_path = platform, pg_catalog, pg_temp
as $$
begin
  return query select provider.enabled, provider.configuration
    from platform.integration_providers provider
    join platform.integration_provider_capabilities supported on supported.provider = provider.provider
   where provider.provider = requested_provider and supported.capability = requested_capability;
end
$$;

create function platform.integration_runtime_route(requested_capability text)
returns table(active_provider text, fallback_provider text)
language plpgsql stable security definer
set search_path = platform, pg_catalog, pg_temp
as $$
begin
  return query select route.active_provider, route.fallback_provider
    from platform.integration_capability_routes route
   where route.capability = requested_capability;
end
$$;

create function platform.admin_list_integration_providers()
returns table(provider text, display_name text, enabled boolean, runtime_control boolean,
  configuration jsonb, credential_source text, last_test_status text, last_tested_at timestamptz,
  last_successful_test_at timestamptz, last_failed_test_at timestamptz, row_version bigint,
  capabilities text[])
language plpgsql stable security definer
set search_path = platform, auth, pg_catalog, pg_temp
as $$
begin
  if not auth.account_has_platform_permission(platform.current_account_id(), 'platform.integration.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return query select p.provider, p.display_name, p.enabled, p.runtime_control,
    p.configuration, p.credential_source, p.last_test_status, p.last_tested_at,
    p.last_successful_test_at, p.last_failed_test_at, p.row_version,
    coalesce(array_agg(c.capability order by c.capability) filter (where c.capability is not null), array[]::text[])
    from platform.integration_providers p
    left join platform.integration_provider_capabilities c on c.provider = p.provider
   group by p.provider
   order by p.display_name;
end
$$;

create function platform.admin_list_integration_routes()
returns table(capability text, active_provider text, fallback_provider text, row_version bigint)
language plpgsql stable security definer
set search_path = platform, auth, pg_catalog, pg_temp
as $$
begin
  if not auth.account_has_platform_permission(platform.current_account_id(), 'platform.integration.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return query select route.capability, route.active_provider, route.fallback_provider, route.row_version
    from platform.integration_capability_routes route order by route.capability;
end
$$;

create function platform.admin_list_integration_events(requested_provider text, requested_limit integer)
returns table(sequence_id bigint, provider text, capability text, action text, before_value jsonb,
  after_value jsonb, reason text, actor_account_id uuid, correlation_id text, occurred_at timestamptz)
language plpgsql stable security definer
set search_path = platform, auth, pg_catalog, pg_temp
as $$
begin
  if not auth.account_has_platform_permission(platform.current_account_id(), 'platform.integration.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_provider is null or requested_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_INTEGRATION_HISTORY';
  end if;
  return query select event.sequence_id, event.provider, event.capability, event.action,
    event.before_value, event.after_value, event.reason, event.actor_account_id,
    event.correlation_id, event.occurred_at
    from platform.integration_events event
   where event.provider = requested_provider
      or event.before_value->>'activeProvider' = requested_provider
      or event.after_value->>'activeProvider' = requested_provider
      or event.before_value->>'fallbackProvider' = requested_provider
      or event.after_value->>'fallbackProvider' = requested_provider
    order by event.sequence_id desc limit requested_limit;
end
$$;

create function platform.admin_set_integration_provider(
  requested_provider text, expected_version bigint, requested_enabled boolean,
  requested_configuration jsonb, requested_action text, requested_reason text,
  requested_idempotency_key text, requested_sha256 char(64))
returns table(provider text, enabled boolean, configuration jsonb, row_version bigint, replayed boolean)
language plpgsql security definer
set search_path = platform, auth, pg_catalog, pg_temp
as $$
declare
  actor uuid := platform.current_account_id();
  previous_row platform.integration_providers%rowtype;
  current_row platform.integration_providers%rowtype;
  command auth.admin_command_idempotency%rowtype;
  response jsonb;
  permitted_keys text[];
begin
  if not auth.account_has_platform_permission(actor, 'platform.integration.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_action not in ('enable', 'pause', 'configure')
    or requested_configuration is null or jsonb_typeof(requested_configuration) <> 'object'
    or length(requested_configuration::text) > 1000
    or expected_version is null or expected_version < 1
    or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
    or requested_idempotency_key is null or length(requested_idempotency_key) not between 16 and 128
    or requested_sha256 is null or requested_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_INTEGRATION_COMMAND';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':integration:' || requested_idempotency_key, 0));
  select * into command from auth.admin_command_idempotency evidence
   where evidence.actor_account_id = actor and evidence.operation = 'integration.provider.update'
     and evidence.idempotency_key = requested_idempotency_key;
  if found then
    if command.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select command.response->>'provider', (command.response->>'enabled')::boolean,
      command.response->'configuration', (command.response->>'version')::bigint, true;
    return;
  end if;
  select * into previous_row from platform.integration_providers p
   where p.provider = requested_provider for update;
  if not found then raise exception using errcode = 'P0002', message = 'ADMIN_INTEGRATION_NOT_FOUND'; end if;
  if not previous_row.runtime_control then
    raise exception using errcode = '23514', message = 'ADMIN_INTEGRATION_INFRASTRUCTURE_CONTROL';
  end if;
  if previous_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  permitted_keys := case requested_provider
    when 'ses' then array['fromAddress']::text[]
    when 'termii' then array['senderId', 'channel']::text[]
    when 'meta-whatsapp' then array['phoneNumberId', 'templateName', 'templateLanguage']::text[]
    when 'brevo' then array['emailFrom', 'smsSender', 'whatsappSender']::text[]
    else array[]::text[] end;
  if exists (select 1 from jsonb_each(requested_configuration) field
    where field.key <> all(permitted_keys) or jsonb_typeof(field.value) <> 'string'
      or length(field.value #>> '{}') not between 1 and 120)
    or (requested_configuration ? 'fromAddress' and requested_configuration->>'fromAddress' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    or (requested_configuration ? 'emailFrom' and requested_configuration->>'emailFrom' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    or (requested_configuration ? 'phoneNumberId' and requested_configuration->>'phoneNumberId' !~ '^[0-9]{5,30}$')
    or (requested_configuration ? 'whatsappSender' and requested_configuration->>'whatsappSender' !~ '^\+[1-9][0-9]{7,14}$')
    or (requested_configuration ? 'senderId' and requested_configuration->>'senderId' !~ '^[A-Za-z0-9]{3,20}$')
    or (requested_configuration ? 'smsSender' and requested_configuration->>'smsSender' !~ '^[A-Za-z0-9]{3,20}$')
    or (requested_configuration ? 'channel' and requested_configuration->>'channel' not in ('generic', 'dnd'))
    or (requested_configuration ? 'templateName' and requested_configuration->>'templateName' !~ '^[A-Za-z0-9_]{2,120}$')
    or (requested_configuration ? 'templateLanguage' and requested_configuration->>'templateLanguage' !~ '^[a-z]{2}_[A-Z]{2}$') then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_INTEGRATION_CONFIGURATION';
  end if;
  if requested_action = 'enable' and (requested_enabled is distinct from true or
      requested_configuration <> previous_row.configuration)
    or requested_action = 'pause' and (requested_enabled is distinct from false or
      requested_configuration <> previous_row.configuration)
    or requested_action = 'configure' and (requested_enabled is distinct from previous_row.enabled) then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_INTEGRATION_COMMAND';
  end if;
  if previous_row.enabled = requested_enabled and previous_row.configuration = requested_configuration then
    raise exception using errcode = '23514', message = 'ADMIN_NO_STATE_CHANGE';
  end if;
  update platform.integration_providers p set enabled = requested_enabled,
    configuration = requested_configuration, row_version = p.row_version + 1,
    updated_by = actor, updated_at = clock_timestamp()
   where p.provider = requested_provider returning p.* into current_row;
  insert into platform.integration_events(provider, action, before_value, after_value,
    reason, actor_account_id, correlation_id)
  values (requested_provider, requested_action,
    jsonb_build_object('enabled', previous_row.enabled, 'configuration', previous_row.configuration),
    jsonb_build_object('enabled', current_row.enabled, 'configuration', current_row.configuration),
    btrim(requested_reason), actor, platform.current_correlation_id());
  response := jsonb_build_object('provider', current_row.provider, 'enabled', current_row.enabled,
    'configuration', current_row.configuration, 'version', current_row.row_version);
  insert into auth.admin_command_idempotency
    (actor_account_id, operation, idempotency_key, request_sha256, response)
  values (actor, 'integration.provider.update', requested_idempotency_key, requested_sha256, response);
  return query select current_row.provider, current_row.enabled, current_row.configuration,
    current_row.row_version, false;
end
$$;

create function platform.admin_set_integration_route(
  requested_capability text, expected_version bigint, requested_primary text,
  requested_fallback text, requested_action text, requested_reason text,
  requested_idempotency_key text, requested_sha256 char(64))
returns table(capability text, active_provider text, fallback_provider text, row_version bigint, replayed boolean)
language plpgsql security definer
set search_path = platform, auth, pg_catalog, pg_temp
as $$
declare
  actor uuid := platform.current_account_id();
  previous_row platform.integration_capability_routes%rowtype;
  current_row platform.integration_capability_routes%rowtype;
  command auth.admin_command_idempotency%rowtype;
  response jsonb;
begin
  if not auth.account_has_platform_permission(actor, 'platform.integration.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_capability not in ('email', 'sms', 'whatsapp')
    or requested_action not in ('select', 'fallback')
    or expected_version is null or expected_version < 1
    or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
    or requested_idempotency_key is null or length(requested_idempotency_key) not between 16 and 128
    or requested_sha256 is null or requested_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_INTEGRATION_ROUTE';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':integration-route:' || requested_idempotency_key, 0));
  select * into command from auth.admin_command_idempotency evidence
   where evidence.actor_account_id = actor and evidence.operation = 'integration.route.update'
     and evidence.idempotency_key = requested_idempotency_key;
  if found then
    if command.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select command.response->>'capability', command.response->>'activeProvider',
      command.response->>'fallbackProvider', (command.response->>'version')::bigint, true;
    return;
  end if;
  select * into previous_row from platform.integration_capability_routes route
   where route.capability = requested_capability for update;
  if not found then raise exception using errcode = 'P0002', message = 'ADMIN_CAPABILITY_NOT_FOUND'; end if;
  if previous_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if requested_primary is null or not exists (
    select 1 from platform.integration_provider_capabilities supported
    join platform.integration_providers provider on provider.provider = supported.provider
    where supported.provider = requested_primary and supported.capability = requested_capability
      and provider.runtime_control and provider.enabled) or
    (requested_fallback is not null and (requested_fallback = requested_primary or not exists (
      select 1 from platform.integration_provider_capabilities supported
      join platform.integration_providers provider on provider.provider = supported.provider
      where supported.provider = requested_fallback and supported.capability = requested_capability
        and provider.runtime_control and provider.enabled))) then
    raise exception using errcode = '22023', message = 'ADMIN_INCOMPATIBLE_PROVIDER';
  end if;
  if requested_action = 'select' and requested_fallback is distinct from previous_row.fallback_provider
    or requested_action = 'fallback' and requested_primary is distinct from previous_row.active_provider then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_INTEGRATION_ROUTE';
  end if;
  if previous_row.active_provider = requested_primary and
    previous_row.fallback_provider is not distinct from requested_fallback then
    raise exception using errcode = '23514', message = 'ADMIN_NO_STATE_CHANGE';
  end if;
  update platform.integration_capability_routes route
    set active_provider = requested_primary, fallback_provider = requested_fallback,
      row_version = route.row_version + 1, updated_by = actor, updated_at = clock_timestamp()
   where route.capability = requested_capability returning route.* into current_row;
  insert into platform.integration_events(capability, action, before_value, after_value,
    reason, actor_account_id, correlation_id)
  values (requested_capability, requested_action,
    jsonb_build_object('activeProvider', previous_row.active_provider,
      'fallbackProvider', previous_row.fallback_provider),
    jsonb_build_object('activeProvider', current_row.active_provider,
      'fallbackProvider', current_row.fallback_provider),
    btrim(requested_reason), actor, platform.current_correlation_id());
  response := jsonb_build_object('capability', current_row.capability,
    'activeProvider', current_row.active_provider,
    'fallbackProvider', current_row.fallback_provider, 'version', current_row.row_version);
  insert into auth.admin_command_idempotency
    (actor_account_id, operation, idempotency_key, request_sha256, response)
  values (actor, 'integration.route.update', requested_idempotency_key, requested_sha256, response);
  return query select current_row.capability, current_row.active_provider,
    current_row.fallback_provider, current_row.row_version, false;
end
$$;

create function platform.admin_integration_test_replay(
  requested_idempotency_key text, requested_sha256 char(64)) returns jsonb
language plpgsql stable security definer
set search_path = platform, auth, pg_catalog, pg_temp
as $$
declare
  actor uuid := platform.current_account_id();
  command auth.admin_command_idempotency%rowtype;
begin
  if not auth.account_has_platform_permission(actor, 'platform.integration.test') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_idempotency_key is null or length(requested_idempotency_key) not between 16 and 128
    or requested_sha256 is null or requested_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_INTEGRATION_TEST';
  end if;
  select * into command from auth.admin_command_idempotency evidence
   where evidence.actor_account_id = actor and evidence.operation = 'integration.provider.test'
     and evidence.idempotency_key = requested_idempotency_key;
  if not found then return null; end if;
  if command.request_sha256 <> requested_sha256 then
    raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
  end if;
  return command.response;
end
$$;

create function platform.admin_record_integration_test(
  requested_provider text, expected_version bigint, requested_status text,
  requested_reason text, requested_idempotency_key text, requested_sha256 char(64))
returns table(provider text, last_test_status text, row_version bigint, replayed boolean)
language plpgsql security definer
set search_path = platform, auth, pg_catalog, pg_temp
as $$
declare
  actor uuid := platform.current_account_id();
  current_row platform.integration_providers%rowtype;
  command auth.admin_command_idempotency%rowtype;
  response jsonb;
begin
  if not auth.account_has_platform_permission(actor, 'platform.integration.test') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_provider <> 'qoreid' or requested_status not in ('healthy', 'degraded', 'failed', 'unknown')
    or expected_version is null or expected_version < 1
    or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
    or requested_idempotency_key is null or length(requested_idempotency_key) not between 16 and 128
    or requested_sha256 is null or requested_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_INTEGRATION_TEST';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':integration-test:' || requested_idempotency_key, 0));
  select * into command from auth.admin_command_idempotency evidence
   where evidence.actor_account_id = actor and evidence.operation = 'integration.provider.test'
     and evidence.idempotency_key = requested_idempotency_key;
  if found then
    if command.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select command.response->>'provider', command.response->>'status',
      (command.response->>'version')::bigint, true;
    return;
  end if;
  select * into current_row from platform.integration_providers p
   where p.provider = requested_provider for update;
  if not found then raise exception using errcode = 'P0002', message = 'ADMIN_INTEGRATION_NOT_FOUND'; end if;
  if current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  update platform.integration_providers p
     set last_test_status = requested_status,
         last_tested_at = clock_timestamp(),
         last_successful_test_at = case when requested_status = 'healthy' then clock_timestamp()
           else p.last_successful_test_at end,
         last_failed_test_at = case when requested_status in ('failed', 'degraded') then clock_timestamp()
           else p.last_failed_test_at end,
         row_version = p.row_version + 1, updated_by = actor, updated_at = clock_timestamp()
   where p.provider = requested_provider returning p.* into current_row;
  insert into platform.integration_events(provider, action, before_value, after_value,
    reason, actor_account_id, correlation_id)
  values (requested_provider, 'test', '{}'::jsonb,
    jsonb_build_object('status', requested_status), btrim(requested_reason),
    actor, platform.current_correlation_id());
  response := jsonb_build_object('provider', current_row.provider, 'status', current_row.last_test_status,
    'version', current_row.row_version);
  insert into auth.admin_command_idempotency
    (actor_account_id, operation, idempotency_key, request_sha256, response)
  values (actor, 'integration.provider.test', requested_idempotency_key, requested_sha256, response);
  return query select current_row.provider, current_row.last_test_status, current_row.row_version, false;
end
$$;

revoke all on platform.integration_providers, platform.integration_provider_capabilities,
  platform.integration_capability_routes, platform.integration_events from public;
revoke all on function platform.integration_runtime_provider(text, text),
  platform.integration_runtime_route(text), platform.admin_list_integration_providers(),
  platform.admin_list_integration_routes(), platform.admin_list_integration_events(text, integer),
  platform.admin_set_integration_provider(text, bigint, boolean, jsonb, text, text, text, char),
  platform.admin_set_integration_route(text, bigint, text, text, text, text, text, char),
  platform.admin_integration_test_replay(text, char),
  platform.admin_record_integration_test(text, bigint, text, text, text, char)
  from public;
