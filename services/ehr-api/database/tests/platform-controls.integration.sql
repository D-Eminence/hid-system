\set ON_ERROR_STOP on
-- Platform control commands (0039, 0071) through the exact Identity API
-- runtime role. Rollback-only.
begin;

insert into auth.accounts (id, subject, email, status) values
  ('c7200000-0000-4000-8000-000000000001', 'synthetic:controls:super', 'super@controls.invalid', 'active'),
  ('c7200000-0000-4000-8000-000000000002', 'synthetic:controls:auditor', 'auditor@controls.invalid', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c7600000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', 'Platform controls suite Super Admin'),
  ('c7600000-0000-4000-8000-000000000002', 'c7200000-0000-4000-8000-000000000002',
   'security_auditor', 'platform', 'Platform controls suite auditor');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:controls:super', true),
  set_config('app.correlation_id', 'platform-controls-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true),
  set_config('app.access_scope', 'platform', true);

do $$
declare
  listed integer;
  before_version bigint;
  before_enabled boolean;
  result record;
begin
  select count(*) into listed from platform.admin_list_controls();
  if listed <> 6 then
    raise exception 'admin_list_controls returned % controls instead of 6', listed;
  end if;
  select c.row_version, c.enabled into before_version, before_enabled
    from platform.admin_list_controls() c where c.control_key = 'outreach_portal_enabled';

  -- A change applies once, at the expected version, and reports the new version.
  select * into result from platform.admin_set_control(
    'outreach_portal_enabled', not before_enabled, before_version, 'Controls suite changes outreach');
  if result.control_key <> 'outreach_portal_enabled' or result.enabled is distinct from (not before_enabled)
     or result.row_version <> before_version + 1 or result.replayed then
    raise exception 'admin_set_control did not apply the change once: %', row_to_json(result);
  end if;

  -- Repeating the current value is reported as a replay without a new version.
  select * into result from platform.admin_set_control(
    'outreach_portal_enabled', not before_enabled, before_version + 1, 'Controls suite repeats outreach');
  if not result.replayed or result.row_version <> before_version + 1 then
    raise exception 'an unchanged control was not reported as a replay: %', row_to_json(result);
  end if;

  begin
    perform platform.admin_set_control('outreach_portal_enabled', before_enabled, before_version,
      'Controls suite uses a stale version');
    raise exception 'a stale control version was accepted';
  exception when others then
    if sqlerrm <> 'ADMIN_VERSION_CONFLICT' then raise; end if;
  end;
  begin
    perform platform.admin_set_control('not_a_control', true, 1, 'Controls suite uses an unknown key');
    raise exception 'an unknown control key was accepted';
  exception when others then
    if sqlerrm <> 'ADMIN_INVALID_CONTROL' then raise; end if;
  end;
  begin
    perform platform.admin_set_control('outreach_portal_enabled', before_enabled, before_version + 1, 'short');
    raise exception 'a control change without a sufficient reason was accepted';
  exception when others then
    if sqlerrm <> 'ADMIN_INVALID_CONTROL' then raise; end if;
  end;

  -- The runtime changes controls only through the command.
  begin
    update platform.control_settings set enabled = before_enabled where control_key = 'outreach_portal_enabled';
    raise exception 'the runtime updated platform.control_settings directly';
  exception when insufficient_privilege then null;
  end;

  -- Restore the original value through the command.
  select * into result from platform.admin_set_control(
    'outreach_portal_enabled', before_enabled, before_version + 1, 'Controls suite restores outreach');
  if result.enabled is distinct from before_enabled or result.row_version <> before_version + 2 or result.replayed then
    raise exception 'admin_set_control did not restore the control: %', row_to_json(result);
  end if;
end $$;

-- A platform administrator without the control permissions can neither list nor change controls.
select set_config('app.actor_subject', 'synthetic:controls:auditor', true),
  set_config('app.correlation_id', 'platform-controls-0002', true);
do $$
begin
  begin
    perform platform.admin_list_controls();
    raise exception 'a platform auditor listed platform controls';
  exception when others then
    if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
  end;
  begin
    perform platform.admin_set_control('outreach_portal_enabled', false, 1, 'Auditor attempts a control change');
    raise exception 'a platform auditor changed a platform control';
  exception when others then
    if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
  end;
end $$;

reset role;
do $$
begin
  -- Two applied changes (the replay and refusals add none), each attributed and correlated.
  if (select count(*) from platform.control_events
      where correlation_id = 'platform-controls-0001'
        and actor_account_id = 'c7200000-0000-4000-8000-000000000001'
        and control_key = 'outreach_portal_enabled') <> 2 then
    raise exception 'platform control changes were not recorded exactly once each';
  end if;
  if exists (select 1 from platform.control_events where correlation_id = 'platform-controls-0002') then
    raise exception 'a refused control change was recorded';
  end if;
end $$;

rollback;
