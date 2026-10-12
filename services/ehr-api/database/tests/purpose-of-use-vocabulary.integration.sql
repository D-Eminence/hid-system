\set ON_ERROR_STOP on
-- The purpose-of-use vocabulary the migrations leave (0080). Every consent
-- decision needs an active identity.purpose_of_use_codes row, and 0003 created
-- the table empty. This suite inserts no purpose code: it requires the
-- migrated direct-care row, then, as the exact Identity API runtime role,
-- that a direct-care grant is honoured and a direct-care access request is
-- accepted through it, and that both are refused once the code is
-- deactivated. Rollback-only.
begin;
set constraints all deferred;

do $$
begin
  if not exists (select 1 from identity.purpose_of_use_codes
                  where code = 'direct-care' and active) then
    raise exception 'the migrated purpose-of-use vocabulary has no active direct-care code';
  end if;
end $$;

insert into auth.accounts (id, subject, email, display_name, status) values
  ('f6a10000-0000-4000-8000-000000000001', 'synthetic:purpose-vocabulary:clinician',
   'purpose-vocabulary-clinician@example.invalid', 'Purpose Vocabulary Clinician', 'active');
insert into identity.organizations (id, name, slug) values
  ('f6a20000-0000-4000-8000-000000000001', 'Purpose Vocabulary Test Organization',
   'purpose-vocabulary-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f6a20000-0000-4000-8000-000000000002', 'f6a20000-0000-4000-8000-000000000001',
   'Purpose Vocabulary Clinic', 'PURPOSE-VOCAB', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('f6a30000-0000-4000-8000-000000000001', 'f6a10000-0000-4000-8000-000000000001',
   'Purpose Vocabulary Clinician', 'purpose-vocabulary-clinician@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('f6a40000-0000-4000-8000-000000000001', 'f6a30000-0000-4000-8000-000000000001',
   'f6a10000-0000-4000-8000-000000000001', 'f6a20000-0000-4000-8000-000000000001',
   'f6a20000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('f6a40000-0000-4000-8000-000000000002', 'f6a10000-0000-4000-8000-000000000001', 'doctor', 'facility',
   'f6a40000-0000-4000-8000-000000000001', 'f6a20000-0000-4000-8000-000000000002',
   'Purpose vocabulary suite role');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('f6a50000-0000-4000-8000-000000000001', 'HID-PVRSEDC', 'Vocabulary', 'Patient',
   'Vocabulary Patient', 'active');
-- An active direct-care write grant. Its purpose_of_use foreign key (0008)
-- resolves to the migrated row; nothing here inserts the code.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at) values
  ('f6a60000-0000-4000-8000-000000000001', 'f6a50000-0000-4000-8000-000000000001',
   'f6a30000-0000-4000-8000-000000000001', 'f6a10000-0000-4000-8000-000000000001',
   'f6a40000-0000-4000-8000-000000000001', 'f6a20000-0000-4000-8000-000000000002',
   'write_records', 'direct-care', 'active', 'Synthetic purpose vocabulary consent',
   clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:purpose-vocabulary:clinician', true),
       set_config('app.membership_id', 'f6a40000-0000-4000-8000-000000000001', true),
       set_config('app.facility_id', 'f6a20000-0000-4000-8000-000000000002', true),
       set_config('app.correlation_id', 'purpose-vocabulary-suite-0001', true),
       set_config('app.purpose_of_use', 'direct-care', true);
do $$
declare
  command_row record;
begin
  -- Operators own the vocabulary; the Identity runtime only reads it.
  if not has_table_privilege(current_user, 'identity.purpose_of_use_codes', 'SELECT')
     or has_table_privilege(current_user, 'identity.purpose_of_use_codes', 'INSERT')
     or has_table_privilege(current_user, 'identity.purpose_of_use_codes', 'UPDATE')
     or has_table_privilege(current_user, 'identity.purpose_of_use_codes', 'DELETE') then
    raise exception 'the Identity runtime must read the purpose-of-use vocabulary and never change it';
  end if;
  if not identity.has_active_consent_grant(
       'f6a50000-0000-4000-8000-000000000001', 'synthetic:purpose-vocabulary:clinician',
       'f6a40000-0000-4000-8000-000000000001', 'f6a20000-0000-4000-8000-000000000002',
       'read_records', 'direct-care', clock_timestamp())
     or not identity.has_active_consent_grant(
       'f6a50000-0000-4000-8000-000000000001', 'synthetic:purpose-vocabulary:clinician',
       'f6a40000-0000-4000-8000-000000000001', 'f6a20000-0000-4000-8000-000000000002',
       'write_records', 'direct-care', clock_timestamp()) then
    raise exception 'a direct-care consent grant was refused with only the migrated purpose-of-use vocabulary';
  end if;
  begin
    select * into command_row
      from identity.create_access_request(
        'HID-PVRSEDC', 'read_records', 'Purpose vocabulary standard access request', 30);
  exception when sqlstate '22023' then
    raise exception 'a direct-care access request was refused with only the migrated purpose-of-use vocabulary: %',
      sqlerrm;
  end;
  if command_row.request_status is distinct from 'pending'
     or command_row.request_purpose is distinct from 'direct-care'
     or command_row.existing_request then
    raise exception 'a direct-care access request returned an unexpected result: %/%/%',
      command_row.request_status, command_row.request_purpose, command_row.existing_request;
  end if;
end $$;

-- Deactivating the code is the operator's switch: the same grant and a new
-- request for the same purpose are refused at once, and the row stays.
reset role;
update identity.purpose_of_use_codes set active = false where code = 'direct-care';
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'purpose-vocabulary-suite-0002', true);
do $$
begin
  if identity.has_active_consent_grant(
       'f6a50000-0000-4000-8000-000000000001', 'synthetic:purpose-vocabulary:clinician',
       'f6a40000-0000-4000-8000-000000000001', 'f6a20000-0000-4000-8000-000000000002',
       'read_records', 'direct-care', clock_timestamp())
     or identity.has_active_consent_grant(
       'f6a50000-0000-4000-8000-000000000001', 'synthetic:purpose-vocabulary:clinician',
       'f6a40000-0000-4000-8000-000000000001', 'f6a20000-0000-4000-8000-000000000002',
       'write_records', 'direct-care', clock_timestamp()) then
    raise exception 'a direct-care consent grant was honoured after its purpose-of-use code was deactivated';
  end if;
  begin
    perform identity.create_access_request(
      'HID-PVRSEDC', 'write_records', 'Purpose vocabulary request after deactivation', 30);
    raise exception 'a direct-care access request was accepted after its purpose-of-use code was deactivated';
  exception when sqlstate '22023' then
    if sqlerrm is distinct from 'Invalid purpose for a standard access request' then
      raise exception 'a direct-care access request after deactivation was refused for another reason: %', sqlerrm;
    end if;
  end;
end $$;
reset role;
rollback;
