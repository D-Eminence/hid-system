-- The Outreach runtime can write its own rows again.
--
-- Outreach row-level security policies and its invoker-rights event trigger
-- call platform.current_account_id() as the runtime, and that SQL function
-- calls auth.account_id_for_subject(text), which runtime-grants.sql revokes
-- from PUBLIC and grants by name only to the Identity and EHR runtimes. So
-- every Outreach runtime insert into campaigns, campaign members and events,
-- registration case events, patient mappings and command idempotency, and its
-- idempotency read, failed with 42501 "permission denied for function
-- account_id_for_subject". main fixed this in runtime-grants.sql
-- (D-Eminence/hid-system#33); this grant repairs an installation whose roles
-- are already provisioned. Applied migrations 0001 through 0073 are immutable.
--
-- runtime-grants.sql still lacks this grant: a later role bootstrap resets
-- function grants and would remove it, so the same named grant must be added
-- there before roles are bootstrapped again.
do $$
begin
  if exists (select 1 from pg_roles where rolname='hid_outreach_runtime') then
    grant execute on function auth.account_id_for_subject(text) to hid_outreach_runtime;
  end if;
end;
$$;
