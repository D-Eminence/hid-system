\set ON_ERROR_STOP on
-- The facility self sign-up and staff invitation controls (0086, section 7).
-- Rollback-only.
--
--   1. platform.control_settings accepts exactly eight keys: the six of 0039,
--      provider_self_service_enabled and staff_invitations_enabled (P4b),
--      both seeded off with their reasons and no updater; FORCE row-level
--      security is back on after the seed;
--   2. platform.control_enabled keeps 0040's shape (SECURITY DEFINER, STABLE,
--      its search path, EXECUTE for PUBLIC) and answers the six old keys and
--      the two new ones; an unknown key still raises 22023 PLATFORM_CONTROL_INVALID;
--   3. the admin console's commands, through the exact Identity API runtime
--      role, list eight controls and open and close the new one, each change
--      recorded once in platform.control_events; the runtime cannot write the
--      table directly;
--   4. require_control_enabled('provider_self_service_enabled') raises 55000
--      PLATFORM_CONTROL_DISABLED:provider_self_service_enabled while it is
--      off. The control functions are SECURITY DEFINER and the table forces
--      row-level security, so from Identity's accountless system context the
--      control is readable only through an owner that bypasses row-level
--      security, as production's control reads are; under an owner that does
--      not (the rehearsal's synthetic NOBYPASSRLS owner) the self-service gate
--      fails closed with 55000 PLATFORM_CONTROL_UNAVAILABLE, which this suite
--      records instead.
begin;

insert into auth.accounts (id, subject, email, status) values
  ('c8600000-0000-4000-8000-000000000001', 'synthetic:p4-control:super', 'super@p4-control.invalid', 'active'),
  ('c8600000-0000-4000-8000-000000000002', 'synthetic:p4-control:operations', 'operations@p4-control.invalid', 'active'),
  ('c8600000-0000-4000-8000-000000000003', 'synthetic:p4-control:reviewer', 'reviewer@p4-control.invalid', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c8610000-0000-4000-8000-000000000001', 'c8600000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', 'P4 control suite Super Admin'),
  ('c8610000-0000-4000-8000-000000000002', 'c8600000-0000-4000-8000-000000000002',
   'platform_operations_admin', 'platform', 'P4 control suite operations admin'),
  ('c8610000-0000-4000-8000-000000000003', 'c8600000-0000-4000-8000-000000000003',
   'identity_review_admin', 'platform', 'P4 control suite identity reviewer');
select set_config('hid.test.control_owner_bypasses_rls',
  (select (role_row.rolsuper or role_row.rolbypassrls)::text from pg_proc proc
     join pg_roles role_row on role_row.oid = proc.proowner
    where proc.oid = 'platform.control_enabled(text)'::regprocedure), true);

-- 1. The table: eight keys, the seeds, forced row-level security.
do $$
declare violated text; seed record;
begin
  if (select array_agg(match[1] order by match[1])
        from pg_constraint constraint_row,
             regexp_matches(pg_get_constraintdef(constraint_row.oid), '''([a-z_]+)''', 'g') match
       where constraint_row.conrelid = 'platform.control_settings'::regclass
         and constraint_row.conname = 'control_settings_control_key_check')
     is distinct from array['break_glass_enabled', 'maintenance_mode', 'outreach_portal_enabled',
       'patient_portal_enabled', 'provider_portal_enabled', 'provider_self_service_enabled', 'staff_invitations_enabled',
       'uploads_enabled'] then
    raise exception 'control_settings_control_key_check does not list exactly the eight keys';
  end if;
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid = 'platform.control_settings'::regclass and constraint_row.contype = 'c'
         and pg_get_constraintdef(constraint_row.oid) like '%control_key%') <> 1 then
    raise exception 'platform.control_settings has more than one control_key check';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'platform.control_settings'::regclass) then
    raise exception 'platform.control_settings no longer forces row-level security after the seed';
  end if;
  select * into seed from platform.control_settings where control_key = 'provider_self_service_enabled';
  if not found or seed.enabled or seed.updated_by is not null or seed.row_version <> 1
     or seed.reason <> 'Facility self sign-up ships closed (P4); enable by audited admin command' then
    raise exception 'provider_self_service_enabled was not seeded off with its reason: %', row_to_json(seed);
  end if;
  select * into seed from platform.control_settings where control_key = 'staff_invitations_enabled';
  if not found or seed.enabled or seed.updated_by is not null or seed.row_version <> 1
     or seed.reason <> 'Facility staff invitations ship closed (P4b); enable by audited admin command' then
    raise exception 'staff_invitations_enabled was not seeded off with its reason: %', row_to_json(seed);
  end if;
  if (select count(*) from platform.control_settings) <> 8 then
    raise exception 'platform.control_settings does not hold exactly eight controls';
  end if;
  begin
    insert into platform.control_settings (control_key, enabled, reason)
    values ('not_a_control', true, 'A control that does not exist');
    raise exception 'An unknown control key was stored';
  exception when check_violation then
    get stacked diagnostics violated = constraint_name;
    if violated <> 'control_settings_control_key_check' then raise; end if;
  end;
  -- 0040's shape and grants.
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'platform.control_enabled(text)'::regprocedure
                    and proc.prosecdef and proc.provolatile = 's' and proc.prolang = (select oid from pg_language where lanname = 'plpgsql')
                    and proc.proconfig = array['search_path=platform, pg_catalog, pg_temp']
                    and proc.prorettype = 'boolean'::regtype)
     or not exists (select 1 from pg_proc proc,
                      lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                     where proc.oid = 'platform.control_enabled(text)'::regprocedure
                       and acl.grantee = 0 and acl.privilege_type = 'EXECUTE') then
    raise exception 'platform.control_enabled lost 0040''s security, volatility, search path or PUBLIC EXECUTE';
  end if;
end $$;

-- 2 and 3. Through the Identity API runtime with a platform administrator who
-- holds platform.control.read and platform.control.manage.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:p4-control:super', true),
  set_config('app.correlation_id', 'p4-control-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
do $$
declare
  listed text[];
  key text;
  state boolean;
  result record;
  message text;
begin
  select array_agg(control.control_key order by control.control_key) into listed
    from platform.admin_list_controls() control;
  if listed is distinct from array['break_glass_enabled', 'maintenance_mode', 'outreach_portal_enabled',
      'patient_portal_enabled', 'provider_portal_enabled', 'provider_self_service_enabled', 'staff_invitations_enabled',
      'uploads_enabled'] then
    raise exception 'admin_list_controls did not list the eight controls: %', listed;
  end if;
  if (select control.enabled from platform.admin_list_controls() control
       where control.control_key = 'provider_self_service_enabled')
     or (select control.enabled from platform.admin_list_controls() control
          where control.control_key = 'staff_invitations_enabled') then
    raise exception 'The admin console lists facility self sign-up or staff invitations as open';
  end if;
  -- The old keys answer exactly as their rows say.
  foreach key in array array['patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
      'maintenance_mode', 'uploads_enabled', 'break_glass_enabled', 'provider_self_service_enabled',
      'staff_invitations_enabled'] loop
    state := platform.control_enabled(key);
    if state is distinct from (select control.enabled from platform.admin_list_controls() control
                                 where control.control_key = key) then
      raise exception 'control_enabled(%) answered % against its row', key, state;
    end if;
  end loop;
  begin
    perform platform.control_enabled('not_a_control');
    raise exception 'control_enabled accepted an unknown key';
  exception when invalid_parameter_value then
    if sqlerrm <> 'PLATFORM_CONTROL_INVALID' then raise; end if;
  end;
  begin
    perform platform.require_control_enabled('provider_self_service_enabled');
    raise exception 'require_control_enabled passed a closed control';
  exception when object_not_in_prerequisite_state then
    get stacked diagnostics message = message_text;
    if message <> 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled' then raise; end if;
  end;

  -- Open, replay and close through the audited command.
  select * into result from platform.admin_set_control('provider_self_service_enabled', true, 1,
    'D14: open facility self sign-up');
  if not result.enabled or result.row_version <> 2 or result.replayed then
    raise exception 'admin_set_control did not open the control: %', row_to_json(result);
  end if;
  perform platform.require_control_enabled('provider_self_service_enabled');
  select * into result from platform.admin_set_control('provider_self_service_enabled', true, 2,
    'D14: open facility self sign-up again');
  if not result.replayed or result.row_version <> 2 then
    raise exception 'An unchanged control was not a replay: %', row_to_json(result);
  end if;
  begin
    perform platform.admin_set_control('provider_self_service_enabled', false, 1, 'A stale close of sign-up');
    raise exception 'A stale version closed the control';
  exception when others then
    if sqlerrm <> 'ADMIN_VERSION_CONFLICT' then raise; end if;
  end;
  select * into result from platform.admin_set_control('provider_self_service_enabled', false, 2,
    'Close facility self sign-up again');
  if result.enabled or result.row_version <> 3 or result.replayed then
    raise exception 'admin_set_control did not close the control: %', row_to_json(result);
  end if;
  begin
    update platform.control_settings set enabled = true where control_key = 'provider_self_service_enabled';
    raise exception 'The runtime updated platform.control_settings directly';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into platform.control_settings (control_key, enabled, reason)
    values ('provider_self_service_enabled', true, 'Runtime inserts a control row');
    raise exception 'The runtime inserted into platform.control_settings';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A platform administrator without the control permissions cannot open it.
select set_config('app.actor_subject', 'synthetic:p4-control:reviewer', true),
  set_config('app.correlation_id', 'p4-control-0002', true);
do $$
begin
  perform platform.admin_set_control('provider_self_service_enabled', true, 3, 'Reviewer opens sign-up');
  raise exception 'An identity reviewer opened facility self sign-up';
exception when others then
  if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
end $$;

-- platform_operations_admin holds platform.control.manage too (0039).
select set_config('app.actor_subject', 'synthetic:p4-control:operations', true),
  set_config('app.correlation_id', 'p4-control-0003', true);
select platform.admin_set_control('provider_self_service_enabled', true, 3, 'Operations opens sign-up for the suite');

-- 4. Identity's accountless system context, as the self-service commands see it.
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'p4-control-0004', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  bypasses boolean := current_setting('hid.test.control_owner_bypasses_rls')::boolean;
  outcome text;
begin
  begin
    outcome := case when platform.control_enabled('provider_self_service_enabled') then 'open' else 'closed' end;
  exception when object_not_in_prerequisite_state then
    outcome := sqlerrm;
  end;
  if outcome is distinct from (case when bypasses then 'open' else 'PLATFORM_CONTROL_UNAVAILABLE' end) then
    raise exception 'A system context read the open control as % (owner bypasses RLS: %)', outcome, bypasses;
  end if;
end $$;
reset role;

do $$ begin
  if (select array_agg(event.enabled order by event.sequence_id) from platform.control_events event
       where event.control_key = 'provider_self_service_enabled')
     is distinct from array[true, false, true]
     or exists (select 1 from platform.control_events event
                 where event.control_key = 'provider_self_service_enabled'
                   and event.actor_account_id not in ('c8600000-0000-4000-8000-000000000001',
                     'c8600000-0000-4000-8000-000000000002')) then
    raise exception 'The control changes were not recorded exactly once each';
  end if;
end $$;

rollback;
