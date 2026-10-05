\set ON_ERROR_STOP on
begin;

-- A platform role is account-scoped. This fixture deliberately has no staff
-- record or facility membership.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e6300000-0000-4000-8000-000000000001', 'staff:platform-without-facility',
   'platform-without-facility@example.invalid', 'Platform Administrator', 'active'),
  ('e6300000-0000-4000-8000-000000000002', 'staff:no-facility-membership',
   'no-facility-membership@example.invalid', 'Unassigned Staff', 'active'),
  ('e6300000-0000-4000-8000-000000000003', 'patient:notification-recipient',
   'verified-recipient@example.invalid', 'Notification Recipient', 'active');

update auth.accounts
   set email_verified_at = clock_timestamp()
 where id = 'e6300000-0000-4000-8000-000000000003';

insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
values ('e6310000-0000-4000-8000-000000000001',
  'e6300000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
  'Synthetic facility-free platform administration test');

insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name)
values ('e6320000-0000-4000-8000-000000000001',
  'e6300000-0000-4000-8000-000000000003', 'HID-ABC234',
  'Notification', 'Recipient', 'Notification Recipient');

-- The worker can execute only the narrow SECURITY DEFINER lookup. It receives
-- the account email only when it has verified-email evidence.
do $$
declare definition text;
begin
  if not has_function_privilege(
       'hid_notification_worker', 'notification.verified_patient_email(uuid)', 'EXECUTE'
     ) then
    raise exception 'Notification worker cannot execute verified recipient lookup';
  end if;
  if has_table_privilege('hid_notification_worker', 'auth.accounts', 'SELECT')
     or has_table_privilege('hid_notification_worker', 'identity.patients', 'SELECT') then
    raise exception 'Notification worker received direct Identity or account-table access';
  end if;
  select pg_get_functiondef('notification.verified_patient_email(uuid)'::regprocedure) into definition;
  if definition like '%email_ciphertext%' then
    raise exception 'Verified recipient lookup references encrypted patient email';
  end if;
end
$$;

set local role hid_notification_worker;
do $$
declare recipient text;
begin
  select notification.verified_patient_email('e6320000-0000-4000-8000-000000000001') into recipient;
  if recipient is distinct from 'verified-recipient@example.invalid' then
    raise exception 'Verified recipient lookup did not return the canonical account email';
  end if;
end
$$;
reset role;

update auth.accounts set email_verified_at = null
 where id = 'e6300000-0000-4000-8000-000000000003';
set local role hid_notification_worker;
do $$
declare recipient text;
begin
  select notification.verified_patient_email('e6320000-0000-4000-8000-000000000001') into recipient;
  if recipient is not null then
    raise exception 'Unverified account email was exposed to the notification worker';
  end if;
end
$$;
reset role;

-- A facility-free platform administrator can execute platform operations and
-- preserve account-attributed audit evidence. A non-admin staff account still
-- cannot produce a facility-free operational audit event.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:platform-without-facility', true);
select set_config('app.correlation_id', 'platform-admin-no-facility-0001', true);
select count(*) from identity.admin_platform_overview();
insert into audit.events (
  correlation_id, actor_type, actor_subject, actor_account_id, action,
  resource_type, outcome, provenance, source_system
) values (
  'platform-admin-no-facility-0001', 'staff', 'staff:platform-without-facility',
  'e6300000-0000-4000-8000-000000000001', 'admin.overview.read',
  'platform-admin', 'success', 'application', 'identity-api'
);
reset role;

do $$
begin
  begin
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, action,
      resource_type, outcome, provenance, source_system
    ) values (
      'staff-no-facility-rejected-0001', 'staff', 'staff:no-facility-membership',
      'e6300000-0000-4000-8000-000000000002', 'ehr.encounter.read',
      'clinical-record', 'success', 'application', 'identity-api'
    );
    raise exception 'Normal staff audit event was accepted without a facility membership';
  exception when check_violation then null;
  end;
end
$$;

rollback;
