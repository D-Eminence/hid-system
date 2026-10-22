\set ON_ERROR_STOP on
-- The admin console's Audit page reads audit.list_platform_events (0027, 0079)
-- through the exact Identity API runtime role, and every column comes back in
-- its declared position, patient_id included (main D-Eminence/hid-system#18,
-- 0067). Rollback-only.
begin;

insert into auth.accounts (id, subject, email, status) values
  ('c7300000-0000-4000-8000-000000000001', 'synthetic:audit-list:auditor', 'auditor@audit-list.invalid', 'active'),
  ('c7300000-0000-4000-8000-000000000002', 'synthetic:audit-list:nobody', 'nobody@audit-list.invalid', 'active'),
  ('c7300000-0000-4000-8000-000000000003', 'patient:audit-list', 'patient@audit-list.invalid', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c7600000-0000-4000-8000-000000000011', 'c7300000-0000-4000-8000-000000000001',
   'security_auditor', 'platform', 'Platform audit list suite auditor');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('c7500000-0000-4000-8000-000000000001', 'c7300000-0000-4000-8000-000000000003',
   'HID-AUDKST29', 'Audit', 'List', 'Audit List Patient', 'active');
insert into audit.events (correlation_id, actor_type, actor_subject, patient_id, action, outcome,
  resource_type, resource_id, purpose_of_use, reason, provenance, source_system)
values ('audit-list-0001', 'workload', 'synthetic:audit-list:workload',
  'c7500000-0000-4000-8000-000000000001', 'audit.list.synthetic', 'success',
  'patient', 'c7500000-0000-4000-8000-000000000001', 'healthcare-operations',
  'Platform audit list suite event', 'system', 'audit-list-suite');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:audit-list:auditor', true),
  set_config('app.correlation_id', 'platform-audit-list-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);

do $$
declare
  row record;
  listed integer;
begin
  select * into row from audit.list_platform_events(5, null, 'synthetic:audit-list:workload');
  if row.patient_id is distinct from 'c7500000-0000-4000-8000-000000000001'::uuid
     or row.action <> 'audit.list.synthetic' or row.outcome <> 'success'
     or row.resource_type <> 'patient' or row.purpose_of_use <> 'healthcare-operations'
     or row.reason <> 'Platform audit list suite event' or row.source_system <> 'audit-list-suite'
     or row.correlation_id <> 'audit-list-0001' or row.actor_type <> 'workload' then
    raise exception 'audit.list_platform_events returned columns out of place: %', row_to_json(row);
  end if;
  select count(*) into listed from audit.list_platform_events(200);
  if listed < 1 then
    raise exception 'audit.list_platform_events returned no events';
  end if;
  begin
    perform audit.list_platform_events(201);
    raise exception 'an oversized audit page was accepted';
  exception when others then
    if sqlerrm <> 'ADMIN_INVALID_PAGE_SIZE' then raise; end if;
  end;
end $$;

-- An account without platform.audit.read cannot list platform events.
select set_config('app.actor_subject', 'synthetic:audit-list:nobody', true);
do $$
begin
  perform audit.list_platform_events(5);
  raise exception 'an account without platform.audit.read listed platform events';
exception when others then
  if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
end $$;

rollback;
