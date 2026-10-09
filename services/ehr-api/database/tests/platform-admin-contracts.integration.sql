\set ON_ERROR_STOP on
-- Platform administration contract gaps (0072) through the exact Identity API
-- runtime role: the audit target filter and the facility last-Super-Admin
-- guard. Rollback-only; requires a synthetic database with no other platform
-- Super Admin.
begin;

do $$ begin
  if exists (select 1 from auth.account_roles assignment
    where assignment.scope_type = 'platform' and assignment.revoked_at is null
      and assignment.role_code in ('platform_super_admin', 'platform_admin')) then
    raise exception 'platform-admin-contracts suite requires a database with no existing platform Super Admin';
  end if;
end $$;

insert into identity.organizations (id, name, slug) values
  ('c8000000-0000-4000-8000-000000000001', 'Admin Contracts Organization', 'admin-contracts-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c8100000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001',
   'Admin Contracts Facility One', 'ADMIN-CONTRACTS-1', 'Africa/Lagos', true, 'verified'),
  ('c8100000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000001',
   'Admin Contracts Facility Two', 'ADMIN-CONTRACTS-2', 'Africa/Lagos', true, 'verified');

-- Super Admin A works at facility one and nowhere else; Super Admin B has no
-- staff record at all. Both hold a password, so both can open a platform
-- session (0069/0070).
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm) values
  ('c8200000-0000-4000-8000-000000000001', 'synthetic:contracts:super-a', 'super-a@contracts.invalid', 'active',
   '$2b$12$C5UqoLY4dzh793px/LPNXeivTi5Z1q6uMC9AZF0woY.hZ6S/kPnf6', 'bcrypt_legacy'),
  ('c8200000-0000-4000-8000-000000000002', 'synthetic:contracts:super-b', 'super-b@contracts.invalid', 'active',
   '$2b$12$C5UqoLY4dzh793px/LPNXeivTi5Z1q6uMC9AZF0woY.hZ6S/kPnf6', 'bcrypt_legacy'),
  ('c8200000-0000-4000-8000-000000000003', 'synthetic:contracts:auditor', 'auditor@contracts.invalid', 'active', null, null),
  ('c8200000-0000-4000-8000-000000000004', 'synthetic:contracts:support', 'support@contracts.invalid', 'active', null, null);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('c8400000-0000-4000-8000-000000000001', 'c8200000-0000-4000-8000-000000000001',
   'Contracts Super Admin A', 'super-a@contracts.invalid', 'verified', 'admin');
insert into identity.staff_facility_memberships (
  id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active
) values
  ('c8500000-0000-4000-8000-000000000001', 'c8400000-0000-4000-8000-000000000001',
   'c8200000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001',
   'c8100000-0000-4000-8000-000000000001', 'admin', 'admin', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c8600000-0000-4000-8000-000000000001', 'c8200000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', 'Admin contracts suite Super Admin A'),
  ('c8600000-0000-4000-8000-000000000002', 'c8200000-0000-4000-8000-000000000002',
   'platform_super_admin', 'platform', 'Admin contracts suite Super Admin B'),
  ('c8600000-0000-4000-8000-000000000003', 'c8200000-0000-4000-8000-000000000003',
   'security_auditor', 'platform', 'Admin contracts suite auditor'),
  ('c8600000-0000-4000-8000-000000000004', 'c8200000-0000-4000-8000-000000000004',
   'support_admin', 'platform', 'Admin contracts suite support administrator');

-- Platform-scoped audit fixtures, oldest first: two rows for facility one (one
-- recorded with an upper-case id), one for facility two, an account row that
-- shares facility one's UUID, and two text-keyed control rows.
insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
  action, outcome, resource_type, resource_id, access_scope, provenance)
values
  ('contracts-target-0001', 'staff', 'synthetic:contracts:super-b', 'c8200000-0000-4000-8000-000000000002',
   'admin.facility.suspended', 'success', 'facility', 'c8100000-0000-4000-8000-000000000001', 'platform', 'application'),
  ('contracts-target-0002', 'staff', 'synthetic:contracts:super-b', 'c8200000-0000-4000-8000-000000000002',
   'admin.facility.verified', 'success', 'facility', 'C8100000-0000-4000-8000-000000000001', 'platform', 'application'),
  ('contracts-target-0003', 'staff', 'synthetic:contracts:super-b', 'c8200000-0000-4000-8000-000000000002',
   'admin.facility.suspended', 'success', 'facility', 'c8100000-0000-4000-8000-000000000002', 'platform', 'application'),
  ('contracts-target-0004', 'staff', 'synthetic:contracts:super-b', 'c8200000-0000-4000-8000-000000000002',
   'admin.account.disabled', 'success', 'authentication-account', 'c8100000-0000-4000-8000-000000000001',
   'platform', 'application'),
  ('contracts-target-0005', 'staff', 'synthetic:contracts:super-b', 'c8200000-0000-4000-8000-000000000002',
   'admin.platform-control.change', 'success', 'platform-control', 'outreach_portal_enabled', 'platform', 'application'),
  ('contracts-target-0006', 'staff', 'synthetic:contracts:super-b', 'c8200000-0000-4000-8000-000000000002',
   'admin.platform-control.change', 'success', 'platform-control', 'OUTREACH_PORTAL_ENABLED', 'platform', 'application');

-- The reachability helper counts every reachable Super Admin when nobody is
-- excluded (a null excluded account once excluded everyone).
do $$ begin
  if auth.other_reachable_super_admins(null, null) <> 2 then
    raise exception 'other_reachable_super_admins(null, null) returned % instead of 2',
      auth.other_reachable_super_admins(null, null);
  end if;
  if auth.other_reachable_super_admins('c8200000-0000-4000-8000-000000000001', null) <> 1
     or auth.other_reachable_super_admins('c8200000-0000-4000-8000-000000000001', 'platform_super_admin') <> 1
     or auth.other_reachable_super_admins('c8200000-0000-4000-8000-000000000001', 'platform_admin') <> 2 then
    raise exception 'other_reachable_super_admins changed for a non-null excluded account';
  end if;
end $$;

set local role hid_identity_api_runtime;

-- ---------------------------------------------------------------------------
-- identity.admin_transition_facility: the platform-session reachable set
-- ---------------------------------------------------------------------------
select set_config('app.actor_subject', 'synthetic:contracts:super-b', true),
  set_config('app.correlation_id', 'contracts-facility-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true),
  set_config('app.access_scope', 'platform', true);

do $$
declare
  result record;
begin
  -- Super Admin A works only at facility one, and no Super Admin works at any
  -- other verified facility. Both can still open a platform session, so the
  -- suspension removes no administration path and is accepted.
  select * into result from identity.admin_transition_facility(
    'c8100000-0000-4000-8000-000000000001',
    (select row_version from identity.facilities where id = 'c8100000-0000-4000-8000-000000000001'),
    'suspended', 'Contracts suite suspends facility one', 'contracts-facility-0001', repeat('a', 64)::character(64));
  if result.lifecycle_status <> 'suspended' or result.replayed then
    raise exception 'facility suspension was not applied: %', row_to_json(result);
  end if;
  select * into result from identity.admin_transition_facility(
    'c8100000-0000-4000-8000-000000000001', result.row_version,
    'verified', 'Contracts suite restores facility one', 'contracts-facility-0002', repeat('b', 64)::character(64));
  if result.lifecycle_status <> 'verified' then
    raise exception 'facility was not restored: %', row_to_json(result);
  end if;
end $$;

-- No Super Admin can open a platform session (no password credential): the
-- suspension of a facility where a Super Admin works is still refused.
reset role;
update auth.accounts set password_hash = null, password_algorithm = null
where id in ('c8200000-0000-4000-8000-000000000001', 'c8200000-0000-4000-8000-000000000002');
set local role hid_identity_api_runtime;
do $$ begin
  perform identity.admin_transition_facility(
    'c8100000-0000-4000-8000-000000000001',
    (select row_version from identity.facilities where id = 'c8100000-0000-4000-8000-000000000001'),
    'suspended', 'Contracts suite unreachable suspension', 'contracts-facility-0003', repeat('c', 64)::character(64));
  raise exception 'a facility was suspended while no Super Admin could open a platform session';
exception when check_violation then
  if sqlerrm <> 'ADMIN_LAST_SUPER_ADMIN' then raise; end if;
end $$;
-- A facility without a Super Admin is unaffected by the guard.
do $$
declare
  result record;
begin
  select * into result from identity.admin_transition_facility(
    'c8100000-0000-4000-8000-000000000002',
    (select row_version from identity.facilities where id = 'c8100000-0000-4000-8000-000000000002'),
    'suspended', 'Contracts suite suspends facility two', 'contracts-facility-0004', repeat('d', 64)::character(64));
  if result.lifecycle_status <> 'suspended' then
    raise exception 'a facility without a Super Admin was not suspended: %', row_to_json(result);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- audit.list_platform_events: resource_type / resource_id target filter
-- ---------------------------------------------------------------------------
select set_config('app.actor_subject', 'synthetic:contracts:auditor', true),
  set_config('app.correlation_id', 'contracts-audit-0001', true);

do $$
declare
  correlations text[];
  page_one record;
  page_two record;
  remaining integer;
begin
  -- One facility's history, newest first, matched on the canonical UUID in
  -- either letter case, and never another type that shares the UUID.
  select array_agg(correlation_id order by sequence_id desc) into correlations
    from audit.list_platform_events(50, null, null, null, null, null, null, null, null,
      'facility', 'c8100000-0000-4000-8000-000000000001');
  if correlations is distinct from array['contracts-target-0002', 'contracts-target-0001'] then
    raise exception 'facility target filter returned %', correlations;
  end if;
  select array_agg(correlation_id order by sequence_id desc) into correlations
    from audit.list_platform_events(50, null, null, null, null, null, null, null, null,
      'facility', 'C8100000-0000-4000-8000-000000000001');
  if correlations is distinct from array['contracts-target-0002', 'contracts-target-0001'] then
    raise exception 'an upper-case UUID target returned %', correlations;
  end if;
  select array_agg(correlation_id order by sequence_id desc) into correlations
    from audit.list_platform_events(50, null, null, null, null, null, null, null, null,
      'authentication-account', 'c8100000-0000-4000-8000-000000000001');
  if correlations is distinct from array['contracts-target-0004'] then
    raise exception 'resource type was not part of the target filter: %', correlations;
  end if;
  -- A text id matches exactly.
  select array_agg(correlation_id order by sequence_id desc) into correlations
    from audit.list_platform_events(50, null, null, null, null, null, null, null, null,
      'platform-control', 'outreach_portal_enabled');
  if correlations is distinct from array['contracts-target-0005'] then
    raise exception 'text target filter returned %', correlations;
  end if;
  -- A type alone lists every target of that type.
  select array_agg(correlation_id order by sequence_id desc) into correlations
    from audit.list_platform_events(200, null, null, null, null, null, null, null, null, 'facility')
    where correlation_id like 'contracts-target-%';
  if correlations is distinct from array['contracts-target-0003', 'contracts-target-0002', 'contracts-target-0001'] then
    raise exception 'resource type filter returned %', correlations;
  end if;
  -- The target filter combines with the other filters and the sequence keyset.
  select array_agg(correlation_id order by sequence_id desc) into correlations
    from audit.list_platform_events(50, null, null, null, 'admin.facility.suspended', null, null, null, null,
      'facility', 'c8100000-0000-4000-8000-000000000001');
  if correlations is distinct from array['contracts-target-0001'] then
    raise exception 'target and action filters returned %', correlations;
  end if;
  select * into page_one from audit.list_platform_events(1, null, null, null, null, null, null, null, null,
    'facility', 'c8100000-0000-4000-8000-000000000001');
  select * into page_two from audit.list_platform_events(1, page_one.sequence_id, null, null, null, null, null,
    null, null, 'facility', 'c8100000-0000-4000-8000-000000000001');
  select count(*) into remaining from audit.list_platform_events(1, page_two.sequence_id, null, null, null, null,
    null, null, null, 'facility', 'c8100000-0000-4000-8000-000000000001');
  if page_one.correlation_id <> 'contracts-target-0002' or page_two.correlation_id <> 'contracts-target-0001'
     or remaining <> 0 then
    raise exception 'target keyset pages were % then % with % remaining',
      page_one.correlation_id, page_two.correlation_id, remaining;
  end if;
  -- A call with the nine earlier arguments still resolves and is unfiltered by target.
  select array_agg(correlation_id) into correlations
    from audit.list_platform_events(200, null, null, null, null, 'contracts-target-0005', null, null, null);
  if correlations is distinct from array['contracts-target-0005'] then
    raise exception 'the nine-argument call returned %', correlations;
  end if;
end $$;

-- Invalid target filters are refused before any row is read.
do $$
declare
  invalid text[];
  filter text[];
begin
  foreach invalid slice 1 in array array[
    array[null, 'c8100000-0000-4000-8000-000000000001'],
    array['Facility', 'c8100000-0000-4000-8000-000000000001'],
    array['facility account', null],
    array['-facility', null],
    array[repeat('a', 81), null],
    array['facility', ''],
    array['facility', '-c8100000'],
    array['facility', 'c8100000 0000'],
    array['facility', 'c8100000/../0000'],
    array['facility', repeat('a', 256)]
  ] loop
    filter := invalid;
    begin
      perform audit.list_platform_events(10, null, null, null, null, null, null, null, null, filter[1], filter[2]);
      raise exception 'invalid audit target filter accepted: %', filter;
    exception when invalid_parameter_value then
      if sqlerrm <> 'ADMIN_INVALID_AUDIT_FILTER' then raise; end if;
    end;
  end loop;
end $$;

-- The target filter does not change who may read platform audit.
select set_config('app.actor_subject', 'synthetic:contracts:support', true);
do $$ begin
  perform audit.list_platform_events(10, null, null, null, null, null, null, null, null,
    'facility', 'c8100000-0000-4000-8000-000000000001');
  raise exception 'a support administrator read a target audit history';
exception when insufficient_privilege then
  if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
end $$;

reset role;

-- Exactly one platform audit reader exists, and the target index is present.
do $$ begin
  if (select count(*) from pg_proc where oid::regprocedure::text like 'audit.list_platform_events(%') <> 1
     or to_regprocedure('audit.list_platform_events(integer,bigint,text,uuid,text,text,text,timestamp with time zone,'
       || 'timestamp with time zone,text,text)') is null then
    raise exception 'audit.list_platform_events is not the single eleven-argument reader';
  end if;
  if to_regclass('audit.audit_resource_uuid_sequence_idx') is null then
    raise exception 'the audit target index is missing';
  end if;
end $$;

rollback;
