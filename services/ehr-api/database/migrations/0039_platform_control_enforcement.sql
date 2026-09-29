create or replace function platform.control_enabled(requested_key text)
returns boolean
language plpgsql
stable
security definer
set search_path=platform,pg_catalog,pg_temp
as $$
declare enabled_state boolean;
begin
  if requested_key not in (
    'patient_portal_enabled','provider_portal_enabled','outreach_portal_enabled',
    'maintenance_mode','uploads_enabled','break_glass_enabled'
  ) then
    raise exception using errcode='22023', message='PLATFORM_CONTROL_INVALID';
  end if;

  select enabled into enabled_state
  from platform.control_settings
  where control_key = requested_key;

  if enabled_state is null then
    raise exception using errcode='55000', message='PLATFORM_CONTROL_UNAVAILABLE';
  end if;

  return enabled_state;
end
$$;

create or replace function platform.require_control_enabled(requested_key text)
returns void
language plpgsql
stable
security definer
set search_path=platform,pg_catalog,pg_temp
as $$
begin
  if not platform.control_enabled(requested_key) then
    raise exception using errcode='55000', message='PLATFORM_CONTROL_DISABLED:' || requested_key;
  end if;
end
$$;

revoke all on function platform.control_enabled(text) from public;
revoke all on function platform.require_control_enabled(text) from public;
