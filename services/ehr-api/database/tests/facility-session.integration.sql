\set ON_ERROR_STOP on
begin;

insert into auth.accounts (id, subject, email, display_name, status) values
  ('f6200000-0000-4000-8000-000000000001', 'staff:facility-session',
   'facility-session@example.invalid', 'Facility Session Staff', 'active'),
  ('f6200000-0000-4000-8000-000000000002', 'staff:other-session',
   'other-session@example.invalid', 'Other Session Staff', 'active'),
  ('f6200000-0000-4000-8000-000000000003', 'patient:facility-session',
   'patient-session@example.invalid', 'Patient Session', 'active');
insert into identity.organizations (id, name, slug) values
  ('f6210000-0000-4000-8000-000000000001', 'Facility Session Organization A', 'facility-session-a'),
  ('f6210000-0000-4000-8000-000000000002', 'Facility Session Organization B', 'facility-session-b');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f6220000-0000-4000-8000-000000000001', 'f6210000-0000-4000-8000-000000000001',
   'Facility Session A', 'FAC-SESSION-A', 'Africa/Lagos', true, 'verified'),
  ('f6220000-0000-4000-8000-000000000002', 'f6210000-0000-4000-8000-000000000002',
   'Facility Session B', 'FAC-SESSION-B', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
values ('f6230000-0000-4000-8000-000000000001', 'f6200000-0000-4000-8000-000000000001',
  'Facility Session Staff', 'facility-session@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values
  ('f6240000-0000-4000-8000-000000000001', 'f6230000-0000-4000-8000-000000000001',
   'f6200000-0000-4000-8000-000000000001', 'f6210000-0000-4000-8000-000000000001',
   'f6220000-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true),
  ('f6240000-0000-4000-8000-000000000002', 'f6230000-0000-4000-8000-000000000001',
   'f6200000-0000-4000-8000-000000000001', 'f6210000-0000-4000-8000-000000000002',
   'f6220000-0000-4000-8000-000000000002', 'doctor', 'doctor', false, true);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name)
values ('f6250000-0000-4000-8000-000000000001', 'f6200000-0000-4000-8000-000000000003',
  'HID-ABCDEFG', 'Patient', 'Session', 'Patient Session');

set local role hid_identity_api_runtime;
insert into auth.sessions
  (id, account_id, family_id, refresh_token_sha256, access_jti,
   account_token_version, authentication_method, issued_at, expires_at,
   absolute_expires_at, session_kind, selected_facility_id)
values
  ('f6260000-0000-4000-8000-000000000001', 'f6200000-0000-4000-8000-000000000001',
   'f6260000-0000-4000-8000-000000000001', repeat('a', 64),
   'f6270000-0000-4000-8000-000000000001', 1, 'password',
   clock_timestamp(), clock_timestamp() + interval '1 hour',
   clock_timestamp() + interval '2 hours', 'staff', 'f6220000-0000-4000-8000-000000000001'),
  ('f6260000-0000-4000-8000-000000000002', 'f6200000-0000-4000-8000-000000000002',
   'f6260000-0000-4000-8000-000000000002', repeat('b', 64),
   'f6270000-0000-4000-8000-000000000002', 1, 'password',
   clock_timestamp(), clock_timestamp() + interval '1 hour',
   clock_timestamp() + interval '2 hours', 'staff', null);

do $$
declare changed integer;
begin
  select count(*) into changed from auth.sessions
    where id = 'f6260000-0000-4000-8000-000000000001'
      and selected_facility_id = 'f6220000-0000-4000-8000-000000000001';
  if changed <> 1 then raise exception 'Selected facility was not persisted on the staff session'; end if;

  update auth.sessions session
     set selected_facility_id = 'f6220000-0000-4000-8000-000000000002',
         row_version = row_version + 1
   where session.id = 'f6260000-0000-4000-8000-000000000001'
     and session.account_id = 'f6200000-0000-4000-8000-000000000001'
     and session.session_kind = 'staff' and session.revoked_at is null
     and session.expires_at > clock_timestamp()
     and session.absolute_expires_at > clock_timestamp()
     and exists (
       select 1 from auth.accounts account
       join identity.staff staff on staff.account_id = account.id and staff.active
       join identity.staff_facility_memberships membership
         on membership.staff_id = staff.id and membership.account_id = account.id
        and membership.facility_id = 'f6220000-0000-4000-8000-000000000002'
        and membership.id = 'f6240000-0000-4000-8000-000000000002'
        and membership.active and membership.migration_hold_reason is null
       join identity.organizations organization
         on organization.id = membership.organization_id and organization.active
       join identity.facilities facility on facility.id = membership.facility_id
        and facility.organization_id = membership.organization_id and facility.active
       where account.id = session.account_id and account.subject = 'staff:facility-session'
         and account.status = 'active'
         and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
         and account.token_version = session.account_token_version
         and lower(btrim(staff.verification_status)) = any(array['verified','approved','active']::text[])
     );
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'Authorized second facility could not be selected'; end if;

  -- Identity's system transaction still persists the human staff event with
  -- the exact account, membership, organization, facility, and session tuple.
  perform set_config('app.actor_subject', 'system:auth', true);
  insert into audit.events
    (correlation_id, actor_type, actor_subject, actor_account_id,
     actor_membership_id, organization_id, facility_id, action, resource_type,
     resource_id, outcome, provenance, source_system)
  values
    ('facility-session-audit-0001', 'staff', 'staff:facility-session',
     'f6200000-0000-4000-8000-000000000001',
     'f6240000-0000-4000-8000-000000000002',
     'f6210000-0000-4000-8000-000000000002',
     'f6220000-0000-4000-8000-000000000002',
     'auth.facility.select', 'session', 'f6260000-0000-4000-8000-000000000001',
     'success', 'application', 'identity-api');

  update auth.sessions session set selected_facility_id = 'f6220000-0000-4000-8000-000000000001'
    where session.id = 'f6260000-0000-4000-8000-000000000002'
      and session.account_id = 'f6200000-0000-4000-8000-000000000001';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'Session ownership predicate changed another account session'; end if;

  begin
    update auth.sessions set selected_facility_id = 'f6220000-0000-4000-8000-000000000099'
      where id = 'f6260000-0000-4000-8000-000000000001';
    raise exception 'Unregistered facility was persisted on a staff session';
  exception when foreign_key_violation then null;
  end;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from audit.events
      where correlation_id = 'facility-session-audit-0001'
        and actor_membership_id = 'f6240000-0000-4000-8000-000000000002'
        and facility_id = 'f6220000-0000-4000-8000-000000000002') then
    raise exception 'Facility selection audit did not persist under the Identity runtime';
  end if;
end $$;

update identity.staff_facility_memberships set active = false
  where id = 'f6240000-0000-4000-8000-000000000002';
set local role hid_identity_api_runtime;
do $$
declare changed integer;
begin
  update auth.sessions session set selected_facility_id = 'f6220000-0000-4000-8000-000000000002'
    where session.id = 'f6260000-0000-4000-8000-000000000001'
      and session.account_id = 'f6200000-0000-4000-8000-000000000001'
      and exists (select 1 from identity.staff_facility_memberships membership
        where membership.account_id = session.account_id
          and membership.id = 'f6240000-0000-4000-8000-000000000002'
          and membership.facility_id = 'f6220000-0000-4000-8000-000000000002'
          and membership.active and membership.migration_hold_reason is null);
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'Inactive membership remained selectable'; end if;

  begin
    insert into auth.sessions
      (id, account_id, family_id, refresh_token_sha256, access_jti,
       account_token_version, authentication_method, issued_at, expires_at,
       absolute_expires_at, session_kind, patient_id, selected_facility_id)
    values
      ('f6260000-0000-4000-8000-000000000003', 'f6200000-0000-4000-8000-000000000003',
       'f6260000-0000-4000-8000-000000000003', repeat('c', 64),
       'f6270000-0000-4000-8000-000000000003', 1, 'password',
       clock_timestamp(), clock_timestamp() + interval '1 hour',
       clock_timestamp() + interval '2 hours', 'patient',
       'f6250000-0000-4000-8000-000000000001', 'f6220000-0000-4000-8000-000000000001');
    raise exception 'Patient session accepted a selected workforce facility';
  exception when check_violation then null;
  end;
end $$;
reset role;

rollback;
