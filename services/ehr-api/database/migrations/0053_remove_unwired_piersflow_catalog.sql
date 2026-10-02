-- PiersFlow has no executable runtime adapter or supported capability.
-- Retire the inert catalog row without rewriting immutable migration 0047.
-- Preserve audit history by refusing retirement if an unexpected event exists.
do $$
begin
  if exists (select 1 from platform.integration_events where provider = 'piersflow')
     or exists (select 1 from platform.integration_provider_capabilities where provider = 'piersflow') then
    raise exception 'PiersFlow catalog has unexpected operational history';
  end if;
end
$$;

create policy integration_provider_unwired_retirement on platform.integration_providers
  for delete using (provider = 'piersflow' and not enabled and not runtime_control);
delete from platform.integration_providers
  where provider = 'piersflow' and not enabled and not runtime_control;
drop policy integration_provider_unwired_retirement on platform.integration_providers;

do $$
begin
  if exists (select 1 from platform.integration_providers where provider = 'piersflow') then
    raise exception 'PiersFlow catalog retirement was incomplete';
  end if;
end
$$;
