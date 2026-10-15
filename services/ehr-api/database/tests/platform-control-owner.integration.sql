\set ON_ERROR_STOP on
-- Launch (P8-CONTROL): platform.control_enabled(text) answers every runtime
-- role from the platform control rows, whatever the schema owner's
-- attributes. It reads platform.control_settings, which forces row-level
-- security and whose PUBLIC read policy requires platform.control.read. Under
-- a schema owner that does not bypass row-level security (RDS, and the
-- rehearsal's non-superuser owner copy) it saw no row and raised
-- PLATFORM_CONTROL_UNAVAILABLE, and the Identity, EHR and Outreach guards
-- answered every patient and provider request with 503. The role bootstrap
-- now gives the function a technical owner that reads the control keys and
-- flags through one exact policy. Rollback-only.
begin;

do $$
declare
  owner_row record;
begin
  select owner_role.rolname, owner_role.rolsuper, owner_role.rolbypassrls, owner_role.rolcanlogin
    into owner_row
    from pg_proc proc join pg_roles owner_role on owner_role.oid = proc.proowner
   where proc.oid = 'platform.control_enabled(text)'::regprocedure;
  if owner_row.rolname <> 'hid_platform_control_reader' then
    raise exception 'platform.control_enabled is owned by % instead of hid_platform_control_reader',
      owner_row.rolname;
  end if;
  if owner_row.rolsuper or owner_row.rolbypassrls or owner_row.rolcanlogin then
    raise exception 'the owner of platform.control_enabled can log in or bypass row-level security';
  end if;
end
$$;

insert into auth.accounts (id, subject, email, status) values
  ('c7300000-0000-4000-8000-000000000001', 'synthetic:control-owner:super',
   'super@control-owner.invalid', 'active'),
  ('c7300000-0000-4000-8000-000000000002', 'synthetic:control-owner:member',
   'member@control-owner.invalid', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c7700000-0000-4000-8000-000000000001', 'c7300000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', 'Control owner suite Super Admin');

-- The expected values come from the administrator's list, which reads the
-- table through the PUBLIC policy, not from control_enabled. One control is
-- changed first, so the function must read the live row.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:control-owner:super', true),
  set_config('app.correlation_id', 'platform-control-owner-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true),
  set_config('app.access_scope', 'platform', true);
do $$
declare
  control record;
  listed integer := 0;
begin
  select * into control from platform.admin_list_controls() c where c.control_key = 'uploads_enabled';
  perform platform.admin_set_control('uploads_enabled', not control.enabled, control.row_version,
    'Control owner suite changes uploads');
  for control in select * from platform.admin_list_controls() loop
    perform set_config('hid_control_owner_test.' || control.control_key, control.enabled::text, true);
    listed := listed + 1;
  end loop;
  if listed <> 7 then
    raise exception 'admin_list_controls returned % controls instead of 7', listed;
  end if;
end
$$;
reset role;

-- Each guard's runtime role, with no account, a non-administrator account and
-- an unknown subject, sees every control as the administrator listed it.
create function pg_temp.assert_controls_visible(label text) returns void
language plpgsql as $$
declare
  control_key text;
begin
  foreach control_key in array array[
    'patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
    'maintenance_mode', 'uploads_enabled', 'break_glass_enabled', 'clinician_signup_enabled'
  ] loop
    if platform.control_enabled(control_key)
         is distinct from current_setting('hid_control_owner_test.' || control_key)::boolean then
      raise exception '% read % as % instead of %', label, control_key,
        platform.control_enabled(control_key), current_setting('hid_control_owner_test.' || control_key);
    end if;
  end loop;
  if current_setting('hid_control_owner_test.uploads_enabled')::boolean then
    perform platform.require_control_enabled('uploads_enabled');
  else
    begin
      perform platform.require_control_enabled('uploads_enabled');
      raise exception '% passed a disabled control', label;
    exception when others then
      if sqlerrm <> 'PLATFORM_CONTROL_DISABLED:uploads_enabled' then raise; end if;
    end;
  end if;
  begin
    perform platform.control_enabled('not_a_control');
    raise exception '% read an unknown control', label;
  exception when others then
    if sqlerrm <> 'PLATFORM_CONTROL_INVALID' then raise; end if;
  end;
end
$$;
grant execute on function pg_temp.assert_controls_visible(text) to public;

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', '', true), set_config('app.access_scope', '', true);
select pg_temp.assert_controls_visible('Identity runtime without an account');
select set_config('app.actor_subject', 'synthetic:control-owner:member', true);
select pg_temp.assert_controls_visible('Identity runtime for a non-administrator');
reset role;

set local role hid_ehr_api_runtime;
select set_config('app.actor_subject', 'synthetic:control-owner:member', true),
  set_config('app.facility_id', 'c7400000-0000-4000-8000-000000000001', true);
select pg_temp.assert_controls_visible('EHR runtime for a non-administrator');
select set_config('app.actor_subject', 'synthetic:control-owner:unknown', true);
select pg_temp.assert_controls_visible('EHR runtime for an unknown subject');
reset role;

set local role hid_outreach_api_runtime;
select set_config('app.actor_subject', 'synthetic:control-owner:member', true);
select pg_temp.assert_controls_visible('Outreach runtime for a non-administrator');
reset role;

rollback;
