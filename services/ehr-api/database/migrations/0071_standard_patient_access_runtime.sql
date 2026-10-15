-- Standard patient access requires an explicit, active purpose registry entry.
-- Preserve any existing administrative decision; never reactivate a disabled code.
insert into identity.purpose_of_use_codes(code, display, source_system)
values ('direct-care', 'Direct patient care', 'hid')
on conflict (code) do nothing;

do $$
begin
  if not exists (select 1 from identity.purpose_of_use_codes where code='direct-care' and active) then
    raise exception 'ACTIVE_DIRECT_CARE_PURPOSE_REQUIRED';
  end if;
  -- Runtime groups are provisioned separately on a fresh installation. Repair
  -- existing installations here; runtime-grants.sql covers either install order.
  if exists (select 1 from pg_roles where rolname='hid_identity_runtime') then
    grant execute on function identity.list_my_staff_access_requests(text),
      identity.list_my_access_requests(), identity.approve_access_request(uuid),
      identity.deny_access_request(uuid,text) to hid_identity_runtime;
  end if;
end;
$$;

revoke all on function identity.list_my_staff_access_requests(text),
  identity.list_my_access_requests(), identity.approve_access_request(uuid),
  identity.deny_access_request(uuid,text) from public;
