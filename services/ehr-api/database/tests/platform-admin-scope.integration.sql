\set ON_ERROR_STOP on
-- Platform administration scope (0067) and account transition safety (0068).
-- Rollback-only; requires a synthetic database with no other reachable
-- platform Super Admin.
begin;

do $$ begin
  if exists (select 1 from auth.account_roles assignment
    where assignment.scope_type = 'platform' and assignment.revoked_at is null
      and assignment.role_code in ('platform_super_admin', 'platform_admin')) then
    raise exception 'platform-admin-scope suite requires a database with no existing platform Super Admin';
  end if;
end $$;

insert into identity.organizations (id, name, slug) values
  ('c6000000-0000-4000-8000-000000000001', 'Platform Scope Organization', 'platform-scope-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c6100000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001',
   'Platform Scope Facility', 'PLATFORM-SCOPE', 'Africa/Lagos', true, 'verified');

insert into auth.accounts (id, subject, email, status, disabled_from_status, disabled_until) values
  ('c6200000-0000-4000-8000-000000000001', 'synthetic:platform:super', 'super@platform.invalid', 'active', null, null),
  ('c6200000-0000-4000-8000-000000000002', 'synthetic:platform:legacy-admin', 'legacy@platform.invalid', 'active', null, null),
  ('c6200000-0000-4000-8000-000000000003', 'synthetic:platform:auditor', 'auditor@platform.invalid', 'active', null, null),
  ('c6200000-0000-4000-8000-000000000004', 'synthetic:platform:support', 'support@platform.invalid', 'active', null, null),
  ('c6200000-0000-4000-8000-000000000005', 'synthetic:platform:provider', 'provider@platform.invalid', 'active', null, null),
  ('c6200000-0000-4000-8000-000000000006', 'synthetic:platform:facility-review', 'review@platform.invalid', 'active', null, null),
  ('c6300000-0000-4000-8000-000000000001', 'synthetic:target:active', 'active@target.invalid', 'active', null, null),
  ('c6300000-0000-4000-8000-000000000002', 'synthetic:target:pending', 'pending@target.invalid', 'pending_reset', null, null),
  ('c6300000-0000-4000-8000-000000000003', 'synthetic:target:locked', 'locked@target.invalid', 'locked', null, null),
  ('c6300000-0000-4000-8000-000000000004', 'synthetic:target:legacy-disabled', 'legacy-disabled@target.invalid', 'disabled', null, null),
  ('c6300000-0000-4000-8000-000000000005', 'synthetic:target:timed', 'timed@target.invalid', 'disabled', 'active',
   clock_timestamp() + interval '1 day');

-- The Super Admin is reachable (verified staff at a verified facility); the
-- legacy platform_admin is not, so it never counts as a remaining Super Admin.
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('c6400000-0000-4000-8000-000000000001', 'c6200000-0000-4000-8000-000000000001',
   'Platform Super Admin', 'super@platform.invalid', 'verified', 'admin'),
  ('c6400000-0000-4000-8000-000000000005', 'c6200000-0000-4000-8000-000000000005',
   'Platform Scope Provider', 'provider@platform.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (
  id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active
) values
  ('c6500000-0000-4000-8000-000000000001', 'c6400000-0000-4000-8000-000000000001',
   'c6200000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001',
   'c6100000-0000-4000-8000-000000000001', 'admin', 'admin', true, true),
  ('c6500000-0000-4000-8000-000000000005', 'c6400000-0000-4000-8000-000000000005',
   'c6200000-0000-4000-8000-000000000005', 'c6000000-0000-4000-8000-000000000001',
   'c6100000-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true);

insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('c6600000-0000-4000-8000-000000000001', 'c6200000-0000-4000-8000-000000000001',
   'platform_super_admin', 'platform', null, null, 'Platform scope suite Super Admin'),
  ('c6600000-0000-4000-8000-000000000002', 'c6200000-0000-4000-8000-000000000002',
   'platform_admin', 'platform', null, null, 'Platform scope suite legacy administrator'),
  ('c6600000-0000-4000-8000-000000000003', 'c6200000-0000-4000-8000-000000000003',
   'security_auditor', 'platform', null, null, 'Platform scope suite auditor'),
  ('c6600000-0000-4000-8000-000000000004', 'c6200000-0000-4000-8000-000000000004',
   'support_admin', 'platform', null, null, 'Platform scope suite support administrator'),
  ('c6600000-0000-4000-8000-000000000006', 'c6200000-0000-4000-8000-000000000006',
   'facility_review_admin', 'platform', null, null, 'Platform scope suite facility reviewer'),
  ('c6600000-0000-4000-8000-000000000005', 'c6200000-0000-4000-8000-000000000005',
   'doctor', 'facility', 'c6500000-0000-4000-8000-000000000005',
   'c6100000-0000-4000-8000-000000000001', 'Platform scope suite clinical role');

insert into identity.organization_applications (
  id, product_code, organization_name, organization_type, cac_registration_number,
  administrator_name, administrator_email
) values (
  'c6700000-0000-4000-8000-000000000001', 'ehr', 'Platform Scope Applicant', 'clinic', 'RC123456',
  'Platform Scope Applicant Admin', 'applicant@platform.invalid'
);

-- Historical facility-scoped evidence that the platform audit reader returns.
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status)
values ('c6800000-0000-4000-8000-000000000001', null, 'HID-PSCPATNT', 'Scope', 'Patient', 'Scope Patient', 'active');
insert into audit.events (
  correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
  organization_id, facility_id, patient_id, action, outcome, resource_type, purpose_of_use, provenance) values (
  'platform-scope-facility-0001', 'staff', 'synthetic:platform:provider', 'c6200000-0000-4000-8000-000000000005',
  'c6500000-0000-4000-8000-000000000005', 'c6000000-0000-4000-8000-000000000001',
  'c6100000-0000-4000-8000-000000000001', 'c6800000-0000-4000-8000-000000000001',
  'ehr.patient.read', 'success', 'patient', 'direct-care', 'application');

set local role hid_identity_api_runtime;

-- ---------------------------------------------------------------------------
-- Platform-scoped audit rows
-- ---------------------------------------------------------------------------
select set_config('app.actor_subject', 'synthetic:platform:super', true),
  set_config('app.correlation_id', 'platform-scope-audit-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true),
  set_config('app.access_scope', 'platform', true);

-- A platform administrator's successful action is recorded without a facility.
insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
  action, outcome, resource_type, access_scope, provenance)
select 'platform-scope-event-000' || n, 'staff', 'synthetic:platform:super',
  'c6200000-0000-4000-8000-000000000001', 'admin.platform-scope.fixture', 'success',
  'platform-scope-fixture', 'platform', 'application'
from generate_series(1, 5) n;

do $$ begin
  -- A staff account without platform.admin.access cannot record a successful
  -- platform action.
  begin
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
      action, outcome, resource_type, access_scope, provenance)
    values ('platform-scope-denied-0001', 'staff', 'synthetic:platform:provider',
      'c6200000-0000-4000-8000-000000000005', 'admin.platform-scope.fixture', 'success',
      'platform-scope-fixture', 'platform', 'application');
    raise exception 'a provider recorded a successful platform-scoped action';
  exception when insufficient_privilege then
    if sqlerrm <> 'AUDIT_PLATFORM_SCOPE_DENIED' then raise; end if;
  end;
  -- A platform row cannot carry a facility or a membership, or name a non-staff actor.
  begin
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
      facility_id, action, outcome, resource_type, access_scope, provenance)
    values ('platform-scope-invalid-0001', 'staff', 'synthetic:platform:super',
      'c6200000-0000-4000-8000-000000000001', 'c6100000-0000-4000-8000-000000000001',
      'admin.platform-scope.fixture', 'success', 'platform-scope-fixture', 'platform', 'application');
    raise exception 'a platform-scoped row carried a facility';
  exception when check_violation then null;
  end;
  begin
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
      actor_membership_id, action, outcome, resource_type, access_scope, provenance)
    values ('platform-scope-invalid-0002', 'staff', 'synthetic:platform:super',
      'c6200000-0000-4000-8000-000000000001', 'c6500000-0000-4000-8000-000000000001',
      'admin.platform-scope.fixture', 'success', 'platform-scope-fixture', 'platform', 'application');
    raise exception 'a platform-scoped row carried a facility membership';
  exception when check_violation then null;
  end;
  begin
    insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, access_scope, provenance)
    values ('platform-scope-invalid-0003', 'system', 'admin.platform-scope.fixture', 'success',
      'platform-scope-fixture', 'platform', 'application');
    raise exception 'a system actor recorded a platform-scoped row';
  exception when check_violation then null;
  end;
end $$;

-- Denied attempts remain recordable as evidence for any staff account.
insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
  action, outcome, resource_type, access_scope, provenance)
values ('platform-scope-denied-0002', 'staff', 'synthetic:platform:provider',
  'c6200000-0000-4000-8000-000000000005', 'security.authorization', 'denied', 'http-request', 'platform', 'application');

-- In a platform-scoped transaction, a facility-less staff row is marked as
-- platform scope even when the writer does not name the scope.
insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
  action, outcome, resource_type, provenance)
values ('platform-scope-implicit-0001', 'staff', 'synthetic:platform:super',
  'c6200000-0000-4000-8000-000000000001', 'admin.platform-scope.implicit', 'success', 'platform-scope-fixture', 'application');

-- Outside platform scope the 0003 facility rule is unchanged.
select set_config('app.access_scope', 'facility', true);
do $$ begin
  begin
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
      action, outcome, resource_type, provenance)
    values ('platform-scope-facility-0002', 'staff', 'synthetic:platform:super',
      'c6200000-0000-4000-8000-000000000001', 'admin.platform-scope.fixture', 'success', 'platform-scope-fixture', 'application');
    raise exception 'a facility-scoped staff row was recorded without a facility';
  exception when check_violation then null;
  end;
  -- An unknown scope value is rejected, not treated as either scope.
  begin
    perform set_config('app.access_scope', 'everything', true);
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
      action, outcome, resource_type, provenance)
    values ('platform-scope-invalid-0004', 'staff', 'synthetic:platform:super',
      'c6200000-0000-4000-8000-000000000001', 'admin.platform-scope.fixture', 'success',
      'platform-scope-fixture', 'application');
    raise exception 'an invalid access scope was accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;

reset role;
do $$ begin
  if (select access_scope from audit.events where correlation_id = 'platform-scope-implicit-0001') <> 'platform' then
    raise exception 'facility-less staff row in platform scope was not marked platform';
  end if;
  if (select count(*) from audit.events where correlation_id like 'platform-scope-event-%'
      and access_scope = 'platform' and facility_id is null and actor_membership_id is null) <> 5 then
    raise exception 'platform-scoped administration rows were not recorded';
  end if;
  begin
    update audit.events set access_scope = null where correlation_id = 'platform-scope-implicit-0001';
    raise exception 'a platform-scoped audit row was modified';
  exception when others then
    if sqlerrm like '%was modified' then raise; end if;
  end;
end $$;
set local role hid_identity_api_runtime;

-- ---------------------------------------------------------------------------
-- audit.list_platform_events: callable, paginated, filtered, authorized
-- ---------------------------------------------------------------------------
select set_config('app.actor_subject', 'synthetic:platform:auditor', true),
  set_config('app.correlation_id', 'platform-scope-audit-read-0001', true),
  set_config('app.access_scope', 'platform', true);

do $$
declare
  first_page bigint[];
  second_page bigint[];
  third_page bigint[];
  provider_row record;
begin
  select array_agg(sequence_id order by sequence_id desc) into first_page
    from audit.list_platform_events(2, null, 'synthetic:platform:super', null, 'admin.platform-scope.fixture');
  select array_agg(sequence_id order by sequence_id desc) into second_page
    from audit.list_platform_events(2, first_page[2], 'synthetic:platform:super', null, 'admin.platform-scope.fixture');
  select array_agg(sequence_id order by sequence_id desc) into third_page
    from audit.list_platform_events(2, second_page[2], 'synthetic:platform:super', null, 'admin.platform-scope.fixture');
  if cardinality(first_page) <> 2 or cardinality(second_page) <> 2 or cardinality(third_page) <> 1
     or first_page[1] <= first_page[2] or first_page[2] <= second_page[1]
     or second_page[2] <= third_page[1] then
    raise exception 'platform audit pagination is not a strictly descending keyset: % % %',
      first_page, second_page, third_page;
  end if;
  -- The declared patient_id column is returned and filters still apply.
  select * into provider_row from audit.list_platform_events(5, null, null,
    'c6100000-0000-4000-8000-000000000001', null, 'platform-scope-facility-0001');
  if provider_row.patient_id is distinct from 'c6800000-0000-4000-8000-000000000001'::uuid
     or provider_row.facility_id is distinct from 'c6100000-0000-4000-8000-000000000001'::uuid then
    raise exception 'platform audit reader did not return the declared columns';
  end if;
  if exists (select 1 from audit.list_platform_events(200, null, null, null, null, null, 'denied')
             where outcome <> 'denied') then
    raise exception 'platform audit outcome filter was ignored';
  end if;
  begin
    perform audit.list_platform_events(0);
    raise exception 'an empty platform audit page was accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;

-- Accounts without platform.audit.read are denied: a facility provider and a
-- support administrator.
do $$
declare
  subject_name text;
begin
  foreach subject_name in array array['synthetic:platform:provider', 'synthetic:platform:support'] loop
    perform set_config('app.actor_subject', subject_name, true);
    begin
      perform audit.list_platform_events(10);
      raise exception '% read platform audit', subject_name;
    exception when insufficient_privilege then
      if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Organization onboarding administration in platform scope
-- ---------------------------------------------------------------------------
select set_config('app.actor_subject', 'synthetic:platform:super', true),
  set_config('app.correlation_id', 'platform-scope-onboarding-0001', true),
  set_config('app.access_scope', 'platform', true);
do $$ begin
  if not exists (select 1 from identity.admin_list_organization_applications(null) application
                 where application.application_id = 'c6700000-0000-4000-8000-000000000001') then
    raise exception 'platform-scoped Super Admin could not list organization applications';
  end if;
end $$;
-- A facility reviewer, who has no membership of their own, decides in platform scope.
select set_config('app.actor_subject', 'synthetic:platform:facility-review', true);
select * from identity.admin_reject_organization_application(
  'c6700000-0000-4000-8000-000000000001', 1, 'Platform scope rejection evidence');

do $$ begin
  -- A facility provider gains nothing from platform scope.
  perform set_config('app.actor_subject', 'synthetic:platform:provider', true);
  begin
    perform identity.admin_list_organization_applications(null);
    raise exception 'a provider listed organization applications in platform scope';
  exception when insufficient_privilege then null;
  end;
  -- Facility scope keeps the 0046 membership requirement.
  perform set_config('app.actor_subject', 'synthetic:platform:super', true);
  perform set_config('app.access_scope', 'facility', true);
  begin
    perform identity.admin_list_organization_applications(null);
    raise exception 'facility-scoped onboarding administration ran without a membership';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
do $$ begin
  if not exists (select 1 from audit.events
    where correlation_id = 'platform-scope-onboarding-0001'
      and action = 'identity.organization.application.reject'
      and access_scope = 'platform' and facility_id is null and actor_membership_id is null
      and actor_account_id = 'c6200000-0000-4000-8000-000000000006') then
    raise exception 'platform-scoped onboarding command did not record platform-scoped audit';
  end if;
end $$;
set local role hid_identity_api_runtime;

-- ---------------------------------------------------------------------------
-- Account status transitions (0068)
-- ---------------------------------------------------------------------------
select set_config('app.actor_subject', 'synthetic:platform:super', true),
  set_config('app.correlation_id', 'platform-scope-account-0001', true),
  set_config('app.access_scope', 'platform', true);

do $$
declare
  result record;
  replay record;
  account_row record;
begin
  -- Recovery states cannot be activated by the generic command.
  begin
    perform auth.admin_transition_account('c6300000-0000-4000-8000-000000000002', 1, 'active',
      'Bypass reset attempt', 'scope-account-0001', repeat('1', 64)::character(64));
    raise exception 'pending_reset account was activated by the admin status command';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_ACCOUNT_RECOVERY_REQUIRED' then raise; end if;
  end;
  begin
    perform auth.admin_transition_account('c6300000-0000-4000-8000-000000000003', 1, 'active',
      'Bypass lock attempt', 'scope-account-0002', repeat('2', 64)::character(64));
    raise exception 'locked account was activated by the admin status command';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_ACCOUNT_RECOVERY_REQUIRED' then raise; end if;
  end;

  -- Disabling and re-enabling a pending_reset account returns it to pending_reset.
  select * into result from auth.admin_transition_account('c6300000-0000-4000-8000-000000000002', 1,
    'disabled', 'Governed suspension of reset account', 'scope-account-0003', repeat('3', 64)::character(64));
  if result.account_status <> 'disabled' then raise exception 'pending_reset account was not disabled'; end if;
  select * into result from auth.admin_transition_account('c6300000-0000-4000-8000-000000000002', result.row_version,
    'active', 'Governed re-enable of reset account', 'scope-account-0004', repeat('4', 64)::character(64));
  if result.account_status <> 'pending_reset' then
    raise exception 'disable/enable bypassed account recovery: %', result.account_status;
  end if;

  -- A locked account stays locked through the same cycle.
  select * into result from auth.admin_transition_account('c6300000-0000-4000-8000-000000000003', 1,
    'disabled', 'Governed suspension of locked account', 'scope-account-0005', repeat('5', 64)::character(64));
  select * into result from auth.admin_transition_account('c6300000-0000-4000-8000-000000000003', result.row_version,
    'active', 'Governed re-enable of locked account', 'scope-account-0006', repeat('6', 64)::character(64));
  if result.account_status <> 'locked' then raise exception 'disable/enable unlocked an account'; end if;

  -- An active account is suspended and restored to active, with a new token version.
  select * into result from auth.admin_transition_account('c6300000-0000-4000-8000-000000000001', 1,
    'disabled', 'Governed suspension of active account', 'scope-account-0007', repeat('7', 64)::character(64));
  select * into replay from auth.admin_transition_account('c6300000-0000-4000-8000-000000000001', 1,
    'disabled', 'Governed suspension of active account', 'scope-account-0007', repeat('7', 64)::character(64));
  if not replay.replayed or replay.row_version <> result.row_version then
    raise exception 'idempotent replay changed behavior';
  end if;
  begin
    perform auth.admin_transition_account('c6300000-0000-4000-8000-000000000001', result.row_version,
      'disabled', 'Repeated suspension request', 'scope-account-0008', repeat('8', 64)::character(64));
    raise exception 'a no-op account transition was accepted';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_NO_STATE_CHANGE' then raise; end if;
  end;
  select * into result from auth.admin_transition_account('c6300000-0000-4000-8000-000000000001', result.row_version,
    'active', 'Governed restoration of active account', 'scope-account-0009', repeat('9', 64)::character(64));
  if result.account_status <> 'active' then raise exception 'suspended active account was not restored'; end if;
  begin
    perform auth.admin_transition_account('c6300000-0000-4000-8000-000000000001', result.row_version,
      'active', 'Repeated activation request', 'scope-account-0010', repeat('a', 64)::character(64));
    raise exception 'activating an active account was accepted';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_NO_STATE_CHANGE' then raise; end if;
  end;

  -- An account disabled before 0068 has no recorded status and must reset.
  select * into result from auth.admin_transition_account('c6300000-0000-4000-8000-000000000004', 1,
    'active', 'Governed re-enable of legacy suspension', 'scope-account-0011', repeat('b', 64)::character(64));
  if result.account_status <> 'pending_reset' then
    raise exception 'legacy disabled account was activated without recovery';
  end if;

  -- Activation does not lift a timed suspension.
  select * into result from auth.admin_transition_account('c6300000-0000-4000-8000-000000000005', 1,
    'active', 'Governed re-enable of timed suspension', 'scope-account-0012', repeat('c', 64)::character(64));
  if result.account_status <> 'active' then raise exception 'timed suspension fixture was not restored'; end if;

  -- An administrator cannot change their own account status or platform roles.
  begin
    perform auth.admin_transition_account('c6200000-0000-4000-8000-000000000001', 1,
      'disabled', 'Self suspension attempt', 'scope-account-0013', repeat('d', 64)::character(64));
    raise exception 'an administrator changed their own account status';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_SELF_CHANGE_DENIED' then raise; end if;
  end;
  begin
    perform auth.admin_change_platform_role('c6200000-0000-4000-8000-000000000001', 1,
      'security_auditor', 'grant', 'Self role grant attempt', 'scope-role-0001', repeat('e', 64)::character(64));
    raise exception 'an administrator granted themselves a platform role';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_SELF_CHANGE_DENIED' then raise; end if;
  end;
end $$;

-- A support administrator still cannot run the status command.
select set_config('app.actor_subject', 'synthetic:platform:support', true);
do $$ begin
  perform auth.admin_transition_account('c6300000-0000-4000-8000-000000000001',
    (select 1::bigint), 'disabled', 'Support suspension attempt', 'scope-account-0014', repeat('f', 64)::character(64));
  raise exception 'support administrator changed account status';
exception when insufficient_privilege then
  if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
end $$;

-- The last reachable Super Admin stays protected against another administrator.
select set_config('app.actor_subject', 'synthetic:platform:legacy-admin', true);
do $$ begin
  begin
    perform auth.admin_transition_account('c6200000-0000-4000-8000-000000000001', 1,
      'disabled', 'Last Super Admin suspension attempt', 'scope-account-0015', repeat('0', 64)::character(64));
    raise exception 'the last reachable Super Admin was suspended';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_LAST_SUPER_ADMIN' then raise; end if;
  end;
  begin
    perform auth.admin_change_platform_role('c6200000-0000-4000-8000-000000000001', 1,
      'platform_super_admin', 'revoke', 'Last Super Admin revocation attempt', 'scope-role-0002',
      repeat('0', 64)::character(64));
    raise exception 'the last reachable Super Admin role was revoked';
  exception when check_violation then
    if sqlerrm <> 'ADMIN_LAST_SUPER_ADMIN' then raise; end if;
  end;
  begin
    perform auth.admin_change_platform_role('c6200000-0000-4000-8000-000000000002', 1,
      'platform_super_admin', 'grant', 'Self escalation attempt', 'scope-role-0003', repeat('1', 64)::character(64));
    raise exception 'a legacy administrator escalated their own platform role';
  exception when insufficient_privilege then
    if sqlerrm <> 'ADMIN_SELF_CHANGE_DENIED' then raise; end if;
  end;
end $$;

reset role;
do $$ begin
  if exists (select 1 from auth.accounts where id = 'c6300000-0000-4000-8000-000000000005'
             and (disabled_until is null or auth.account_has_platform_permission(id, 'platform.admin.access'))) then
    raise exception 'activation cleared a timed suspension';
  end if;
  if exists (select 1 from auth.accounts where id::text like 'c63%' and disabled_from_status is not null and status <> 'disabled') then
    raise exception 'a recorded prior status outlived the suspension';
  end if;
  if (select token_version from auth.accounts where id = 'c6300000-0000-4000-8000-000000000001') <> 3 then
    raise exception 'suspension and restoration did not each invalidate tokens';
  end if;
  begin
    update auth.accounts set status = 'active', disabled_from_status = 'active'
      where id = 'c6300000-0000-4000-8000-000000000001';
    raise exception 'a recorded prior status was accepted on an undisabled account';
  exception when check_violation then null;
  end;
end $$;

rollback;
