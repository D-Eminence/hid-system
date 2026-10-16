\set ON_ERROR_STOP on
-- Launch D14 (workforce) and N5 (0087): governed clinician provisioning and one
-- active membership per account and facility. Rollback-only. Every command
-- runs as the Identity API runtime role with an MFA-verified platform session.
begin;

-- Facilities: A and B verified, C pending, all in one organization.
insert into identity.organizations (id, name, slug) values
  ('c8800000-0000-4000-8000-000000000001', 'Workforce Suite Organization', 'workforce-suite-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c8810000-0000-4000-8000-00000000000a', 'c8800000-0000-4000-8000-000000000001', 'Workforce Suite A', 'WF-SUITE-A', 'Africa/Lagos', true, 'verified'),
  ('c8810000-0000-4000-8000-00000000000b', 'c8800000-0000-4000-8000-000000000001', 'Workforce Suite B', 'WF-SUITE-B', 'Africa/Lagos', true, 'verified'),
  ('c8810000-0000-4000-8000-00000000000c', 'c8800000-0000-4000-8000-000000000001', 'Workforce Suite C', 'WF-SUITE-C', 'Africa/Lagos', false, 'pending');

-- Accounts:
--   01 reviewer   platform_super_admin, MFA (records attestations)
--   02 granter    platform_super_admin, MFA (grants roles); a doctor at B
--   03 insider    platform_super_admin, MFA; works at A as a doctor
--   04 support    support_admin, MFA (no workforce permission)
--   05 existing   staff, doctor at B (legacy assignment)
--   06 patient    a patient's own account
--   07 orgadmin   A's org_admin (onboarding shape)
--   08 lapsed     staff at B whose doctor role rests on a lapsed attestation
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm) values
  ('c8820000-0000-4000-8000-000000000001', 'synthetic:wf:reviewer', 'reviewer@wf.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c8820000-0000-4000-8000-000000000002', 'synthetic:wf:granter', 'granter@wf.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c8820000-0000-4000-8000-000000000003', 'synthetic:wf:insider', 'insider@wf.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c8820000-0000-4000-8000-000000000004', 'synthetic:wf:support', 'support@wf.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c8820000-0000-4000-8000-000000000005', 'synthetic:wf:existing', 'existing@wf.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c8820000-0000-4000-8000-000000000006', 'synthetic:wf:patient', 'patient@wf.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c8820000-0000-4000-8000-000000000007', 'synthetic:wf:orgadmin', 'orgadmin@wf.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c8820000-0000-4000-8000-000000000008', 'synthetic:wf:lapsed', 'lapsed@wf.invalid', 'active', 'synthetic-hash', 'argon2id');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('c8890000-0000-4000-8000-000000000001', 'c8820000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform', 'Synthetic workforce suite role'),
  ('c8890000-0000-4000-8000-000000000002', 'c8820000-0000-4000-8000-000000000002', 'platform_super_admin', 'platform', 'Synthetic workforce suite role'),
  ('c8890000-0000-4000-8000-000000000003', 'c8820000-0000-4000-8000-000000000003', 'platform_super_admin', 'platform', 'Synthetic workforce suite role'),
  ('c8890000-0000-4000-8000-000000000004', 'c8820000-0000-4000-8000-000000000004', 'support_admin', 'platform', 'Synthetic workforce suite role');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name) values
  ('c8870000-0000-4000-8000-000000000006', 'c8820000-0000-4000-8000-000000000006', 'HID-WFSUTEPA', 'Suite', 'Patient', 'Suite Patient'),
  ('c8870000-0000-4000-8000-000000000001', null, 'HID-WFSUTEPB', 'Cared', 'For', 'Cared For');

-- Staff records and memberships of the existing workforce.
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('c8830000-0000-4000-8000-00000000000' || n)::uuid, ('c8820000-0000-4000-8000-00000000000' || n)::uuid,
  'Workforce Suite ' || n, 'staff' || n || '@wf.invalid', 'verified', role_name
from (values ('2', 'doctor'), ('3', 'doctor'), ('5', 'doctor'), ('6', 'doctor'), ('7', 'org_admin'), ('8', 'doctor'))
  as staff_rows(n, role_name);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('c8840000-0000-4000-8000-00000000000' || n)::uuid, ('c8830000-0000-4000-8000-00000000000' || n)::uuid,
  ('c8820000-0000-4000-8000-00000000000' || n)::uuid, 'c8800000-0000-4000-8000-000000000001',
  facility::uuid, role_name, role_name, true, true
from (values ('2', 'c8810000-0000-4000-8000-00000000000b', 'doctor'),
             ('3', 'c8810000-0000-4000-8000-00000000000a', 'doctor'),
             ('5', 'c8810000-0000-4000-8000-00000000000b', 'doctor'),
             ('6', 'c8810000-0000-4000-8000-00000000000b', 'doctor'),
             ('7', 'c8810000-0000-4000-8000-00000000000a', 'org_admin'),
             ('8', 'c8810000-0000-4000-8000-00000000000b', 'doctor'))
  as membership_rows(n, facility, role_name);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('c889f000-0000-4000-8000-00000000000' || n)::uuid, ('c8820000-0000-4000-8000-00000000000' || n)::uuid,
  role_name, 'facility', ('c8840000-0000-4000-8000-00000000000' || n)::uuid, facility::uuid, 'Synthetic workforce suite role'
from (values ('2', 'c8810000-0000-4000-8000-00000000000b', 'doctor'),
             ('3', 'c8810000-0000-4000-8000-00000000000a', 'doctor'),
             ('5', 'c8810000-0000-4000-8000-00000000000b', 'doctor'),
             ('7', 'c8810000-0000-4000-8000-00000000000a', 'org_admin'),
             ('8', 'c8810000-0000-4000-8000-00000000000b', 'doctor'))
  as role_rows(n, facility, role_name);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('c889e000-0000-4000-8000-000000000005', 'c8820000-0000-4000-8000-000000000005', 'lab', 'facility',
  'c8840000-0000-4000-8000-000000000005', 'c8810000-0000-4000-8000-00000000000b', 'Synthetic legacy lab role');

-- Platform sessions with MFA for 01 to 04, stepped up just now.
insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, activated_at, last_used_step)
select ('c8860000-0000-4000-8000-00000000000' || n)::uuid, ('c8820000-0000-4000-8000-00000000000' || n)::uuid,
  'active', gen_random_bytes(49), 'suite-v1', now(), 1
from unnest(array['1', '2', '3', '4']) as n;
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti,
    account_token_version, authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
select ('c8850000-0000-4000-8000-00000000000' || n)::uuid, ('c8820000-0000-4000-8000-00000000000' || n)::uuid,
  ('c8850000-0000-4000-8000-00000000000' || n)::uuid, repeat(n, 64), gen_random_uuid(), 1, 'password',
  now(), now() + interval '15 minutes', now() + interval '8 hours', 'platform'
from unnest(array['1', '2', '3', '4']) as n;
insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
select ('c8850000-0000-4000-8000-00000000000' || n)::uuid, ('c8820000-0000-4000-8000-00000000000' || n)::uuid,
  ('c8860000-0000-4000-8000-00000000000' || n)::uuid, 'totp', now() - interval '1 minute'
from unnest(array['1', '2', '3', '4']) as n;
update auth.session_assurance set step_up_at = clock_timestamp(), step_up_count = step_up_count + 1,
  row_version = row_version + 1
where family_id::text like 'c8850000-%';

-- Helpers: act as an administrator, and expect an exact refusal.
create function pg_temp.wf_as(n text) returns void language sql as $$
  select set_config('app.actor_subject', case n when '1' then 'synthetic:wf:reviewer' when '2' then 'synthetic:wf:granter'
      when '3' then 'synthetic:wf:insider' when '4' then 'synthetic:wf:support' end, true),
    set_config('app.session_id', 'c8850000-0000-4000-8000-00000000000' || n, true),
    set_config('app.correlation_id', 'workforce-suite-correlation-' || n, true),
    set_config('app.access_scope', 'platform', true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$$;
create function pg_temp.wf_refused(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if sqlerrm = expected then return; end if;
    raise exception 'expected %, got % (%) from %', expected, sqlerrm, sqlstate, command;
  end;
  raise exception 'expected % but the command succeeded: %', expected, command;
end $$;

-- 1. N5: one active, unheld membership per account and facility.
do $$ begin
  begin
    insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active)
    values ('c884d000-0000-4000-8000-000000000001', 'c8830000-0000-4000-8000-000000000005',
      'c8820000-0000-4000-8000-000000000005', 'c8800000-0000-4000-8000-000000000001',
      'c8810000-0000-4000-8000-00000000000b', 'nurse', 'nurse', false, true);
    raise exception 'a second active membership at one facility was accepted';
  exception when unique_violation then
    if position('staff_memberships_one_active_per_facility_uq' in sqlerrm) = 0 then raise; end if;
  end;
end $$;
-- An inactive or a held second membership is history, not a binding.
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active, migration_hold_reason) values
  ('c884d000-0000-4000-8000-000000000002', 'c8830000-0000-4000-8000-000000000005',
   'c8820000-0000-4000-8000-000000000005', 'c8800000-0000-4000-8000-000000000001',
   'c8810000-0000-4000-8000-00000000000b', 'nurse', 'nurse', false, false, null),
  ('c884d000-0000-4000-8000-000000000003', 'c8830000-0000-4000-8000-000000000005',
   'c8820000-0000-4000-8000-000000000005', 'c8800000-0000-4000-8000-000000000001',
   'c8810000-0000-4000-8000-00000000000b', 'clinician', 'clinician', false, true, 'synthetic legacy hold');
do $$ begin
  if not exists (select 1 from pg_indexes where schemaname = 'identity'
      and indexname = 'staff_memberships_one_active_per_facility_uq'
      and indexdef like '%(account_id, facility_id)%'
      and indexdef like '%WHERE (active AND (facility_id IS NOT NULL) AND (migration_hold_reason IS NULL))%') then
    raise exception 'the N5 index has an unexpected definition';
  end if;
end $$;

-- 2. Privileges: only the Identity runtime runs the commands; nobody reads the
-- evidence tables directly; the helpers stay internal.
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'identity.admin_attach_workforce_member(uuid,uuid,text,text,text,text,character)',
    'identity.admin_record_credential_attestation(uuid,bigint,text[],text,text,text,timestamptz,text,text,character)',
    'identity.admin_change_workforce_role(uuid,uuid,bigint,text,text,text,text,character)',
    'identity.admin_end_workforce_membership(uuid,uuid,bigint,text,text,character)',
    'identity.admin_workforce_profile(uuid)', 'auth.facility_role_is_effective(uuid)'] loop
    if not has_function_privilege('hid_identity_api_runtime', signature, 'EXECUTE')
       or has_function_privilege('public', signature, 'EXECUTE')
       or has_function_privilege('hid_ehr_api_runtime', signature, 'EXECUTE') then
      raise exception 'workforce command privileges are inconsistent for %', signature;
    end if;
  end loop;
  foreach signature in array array['identity.workforce_command_actor()', 'identity.workforce_require_assurance(uuid)',
    'identity.workforce_works_at(uuid,uuid)', 'identity.workforce_target_eligible(auth.accounts)'] loop
    if has_function_privilege('hid_identity_api_runtime', signature, 'EXECUTE')
       or has_function_privilege('public', signature, 'EXECUTE') then
      raise exception 'workforce helper % is executable outside its commands', signature;
    end if;
  end loop;
  if has_table_privilege('hid_identity_api_runtime', 'identity.staff_credential_attestations', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'identity.workforce_memberships', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'identity.workforce_role_grants', 'INSERT')
     or has_table_privilege('hid_identity_api_runtime', 'identity.staff_facility_memberships', 'UPDATE') then
    raise exception 'the Identity runtime can reach workforce evidence or memberships directly';
  end if;
  if not exists (select 1 from auth.role_permissions where role_code = 'platform_super_admin'
      and permission_code = 'platform.workforce.manage')
     or exists (select 1 from auth.role_permissions where permission_code = 'platform.workforce.manage'
      and role_code <> 'platform_super_admin') then
    raise exception 'platform.workforce.manage must be held by platform_super_admin only';
  end if;
end $$;

set local role hid_identity_api_runtime;

-- 3. No workforce permission, no session step-up, no MFA session: refused.
select pg_temp.wf_as('4');
select pg_temp.wf_refused($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
  null, 'new.clinician@wf.invalid', 'New Clinician', 'Synthetic workforce attach', 'wf-key-denied-01', repeat('a', 64))$c$,
  'ADMIN_PERMISSION_DENIED');
select pg_temp.wf_refused($c$select identity.admin_workforce_profile('c8820000-0000-4000-8000-000000000005')$c$,
  'ADMIN_PERMISSION_DENIED');
select pg_temp.wf_refused($c$select * from identity.admin_end_workforce_membership('c8840000-0000-4000-8000-000000000005',
  'c8810000-0000-4000-8000-00000000000b', 1, 'Synthetic workforce end', 'wf-key-denied-02', repeat('a', 64))$c$,
  'ADMIN_PERMISSION_DENIED');
select pg_temp.wf_as('1');
select set_config('app.session_id', '', true);
select pg_temp.wf_refused($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
  null, 'new.clinician@wf.invalid', 'New Clinician', 'Synthetic workforce attach', 'wf-key-stepup-01', repeat('a', 64))$c$,
  'ADMIN_STEP_UP_REQUIRED');

-- 4. Attach.
select pg_temp.wf_as('1');
select pg_temp.wf_refused($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
  'c8820000-0000-4000-8000-000000000005', 'existing@wf.invalid', null, 'Synthetic workforce attach',
  'wf-key-invalid-01', repeat('a', 64))$c$, 'WORKFORCE_INVALID_COMMAND');
select pg_temp.wf_refused($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
  'c8820000-0000-4000-8000-000000000001', null, null, 'Synthetic workforce attach', 'wf-key-self-01', repeat('a', 64))$c$,
  'WORKFORCE_SELF_CHANGE_DENIED');
select pg_temp.wf_refused($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000c',
  null, 'new.clinician@wf.invalid', 'New Clinician', 'Synthetic workforce attach', 'wf-key-pending-01', repeat('a', 64))$c$,
  'WORKFORCE_FACILITY_NOT_VERIFIED');
select pg_temp.wf_refused($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
  'c8820000-0000-4000-8000-000000000006', null, null, 'Synthetic workforce attach', 'wf-key-patient-01', repeat('a', 64))$c$,
  'WORKFORCE_ACCOUNT_INELIGIBLE');
select pg_temp.wf_refused($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
  null, 'EXISTING@wf.invalid', 'Duplicate Email', 'Synthetic workforce attach', 'wf-key-email-01', repeat('a', 64))$c$,
  'WORKFORCE_EMAIL_IN_USE');
select pg_temp.wf_refused($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
  'c8820000-0000-4000-8000-000000000003', null, null, 'Synthetic workforce attach', 'wf-key-exists-01', repeat('a', 64))$c$,
  'WORKFORCE_MEMBERSHIP_EXISTS');
select pg_temp.wf_as('3');
select pg_temp.wf_refused($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
  null, 'new.clinician@wf.invalid', 'New Clinician', 'Synthetic workforce attach', 'wf-key-insider-01', repeat('a', 64))$c$,
  'WORKFORCE_FACILITY_CONFLICT');

select pg_temp.wf_as('1');
do $$
declare
  attached record;
  replayed record;
begin
  select * into attached from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a', null,
    ' New.Clinician@WF.invalid ', 'New Clinician', 'Synthetic workforce attach', 'wf-key-attach-01', repeat('b', 64));
  if attached.replayed or not attached.account_created or attached.account_status <> 'pending_reset'
     or attached.facility_id <> 'c8810000-0000-4000-8000-00000000000a' or attached.membership_version <> 1 then
    raise exception 'attach returned %', row_to_json(attached);
  end if;
  select * into replayed from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a', null,
    ' New.Clinician@WF.invalid ', 'New Clinician', 'Synthetic workforce attach', 'wf-key-attach-01', repeat('b', 64));
  if not replayed.replayed or replayed.membership_id <> attached.membership_id then
    raise exception 'the attach replay returned %', row_to_json(replayed);
  end if;
  perform set_config('suite.new_account', attached.account_id::text, true);
  perform set_config('suite.new_membership', attached.membership_id::text, true);
  perform set_config('suite.new_staff_version', attached.staff_version::text, true);
end $$;
select pg_temp.wf_refused($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
  null, 'new.clinician@wf.invalid', 'New Clinician', 'Synthetic workforce attach', 'wf-key-attach-01', repeat('c', 64))$c$,
  'ADMIN_IDEMPOTENCY_CONFLICT');
select pg_temp.wf_refused(format($c$select * from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
  %L, null, null, 'Synthetic workforce attach', 'wf-key-attach-02', repeat('a', 64))$c$, current_setting('suite.new_account')),
  'WORKFORCE_MEMBERSHIP_EXISTS');
-- The existing staff identity at B is attached at A as well.
do $$
declare
  attached record;
begin
  select * into attached from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
    'c8820000-0000-4000-8000-000000000005', null, null, 'Synthetic workforce attach existing', 'wf-key-attach-03',
    repeat('d', 64));
  if attached.account_created or attached.account_status <> 'active' then
    raise exception 'existing attach returned %', row_to_json(attached);
  end if;
  perform set_config('suite.existing_pending', attached.membership_id::text, true);
end $$;

reset role;
do $$
declare
  new_account uuid := current_setting('suite.new_account')::uuid;
  new_membership uuid := current_setting('suite.new_membership')::uuid;
begin
  if not exists (select 1 from auth.accounts where id = new_account and status = 'pending_reset'
      and password_hash is null and email = 'new.clinician@wf.invalid' and subject = 'workforce:' || id::text) then
    raise exception 'a new staff account must be pending_reset with no password';
  end if;
  if not exists (select 1 from identity.staff where account_id = new_account and verification_status = 'pending'
      and active) then
    raise exception 'a new staff record must be pending';
  end if;
  if not exists (select 1 from identity.staff_facility_memberships where id = new_membership and not active
      and membership_role = 'pending' and facility_id = 'c8810000-0000-4000-8000-00000000000a')
     or exists (select 1 from auth.account_roles where membership_id = new_membership)
     or not exists (select 1 from identity.workforce_memberships where membership_id = new_membership
       and state = 'pending' and attached_by = 'c8820000-0000-4000-8000-000000000001') then
    raise exception 'an attached membership must be pending with no role';
  end if;
end $$;
set local role hid_identity_api_runtime;

-- 5. Credential attestation.
select pg_temp.wf_as('1');
select pg_temp.wf_refused($c$select * from identity.admin_record_credential_attestation('c8820000-0000-4000-8000-000000000001',
  1, array['doctor'], 'MDCN/R/0001', 'Medical and Dental Council of Nigeria', 'Synthetic evidence ticket WF-1',
  clock_timestamp() + interval '1 year', 'Synthetic attestation', 'wf-key-attest-self', repeat('a', 64))$c$,
  'WORKFORCE_SELF_CHANGE_DENIED');
select pg_temp.wf_refused(format($c$select * from identity.admin_record_credential_attestation(%L, 1,
  array['lab'], 'MDCN/R/0001', 'Medical and Dental Council of Nigeria', 'Synthetic evidence ticket WF-1',
  clock_timestamp() + interval '1 year', 'Synthetic attestation', 'wf-key-attest-lab', repeat('a', 64))$c$,
  current_setting('suite.new_account')), 'WORKFORCE_INVALID_COMMAND');
select pg_temp.wf_refused(format($c$select * from identity.admin_record_credential_attestation(%L, 1,
  array['doctor'], 'MDCN/R/0001', 'Medical and Dental Council of Nigeria', 'Synthetic evidence ticket WF-1',
  clock_timestamp() + interval '4 years', 'Synthetic attestation', 'wf-key-attest-long', repeat('a', 64))$c$,
  current_setting('suite.new_account')), 'WORKFORCE_INVALID_COMMAND');
select pg_temp.wf_refused(format($c$select * from identity.admin_record_credential_attestation(%L, 99,
  array['doctor'], 'MDCN/R/0001', 'Medical and Dental Council of Nigeria', 'Synthetic evidence ticket WF-1',
  clock_timestamp() + interval '1 year', 'Synthetic attestation', 'wf-key-attest-stale', repeat('a', 64))$c$,
  current_setting('suite.new_account')), 'ADMIN_VERSION_CONFLICT');
do $$
declare
  attested record;
begin
  select * into attested from identity.admin_record_credential_attestation(current_setting('suite.new_account')::uuid,
    current_setting('suite.new_staff_version')::bigint, array['doctor', 'doctor'], 'MDCN/R/0001',
    'Medical and Dental Council of Nigeria', 'Synthetic evidence ticket WF-1', clock_timestamp() + interval '1 year',
    'Synthetic attestation', 'wf-key-attest-dup', repeat('a', 64));
  raise exception 'a repeated attested role was accepted';
exception when others then
  if sqlerrm <> 'WORKFORCE_INVALID_COMMAND' then raise; end if;
end $$;
do $$
declare
  attested record;
begin
  select * into attested from identity.admin_record_credential_attestation(current_setting('suite.new_account')::uuid,
    current_setting('suite.new_staff_version')::bigint, array['doctor'], 'MDCN/R/0001',
    'Medical and Dental Council of Nigeria', 'Synthetic evidence ticket WF-1', clock_timestamp() + interval '1 year',
    'Synthetic attestation of a reviewed licence', 'wf-key-attest-01', repeat('e', 64));
  if attested.replayed or attested.attested_roles <> array['doctor'] or attested.verification_status <> 'verified'
     or attested.staff_version <> current_setting('suite.new_staff_version')::bigint + 1 then
    raise exception 'attestation returned %', row_to_json(attested);
  end if;
  perform set_config('suite.attestation', attested.attestation_id::text, true);
end $$;
-- The insider (works at A) attests the existing staff identity for doctor;
-- that attestation cannot support a grant at A.
select pg_temp.wf_as('3');
select * from identity.admin_record_credential_attestation('c8820000-0000-4000-8000-000000000005',
  (select 1::bigint), array['doctor'], 'MDCN/R/0005', 'Medical and Dental Council of Nigeria',
  'Synthetic evidence ticket WF-5', clock_timestamp() + interval '1 year', 'Synthetic attestation by an insider',
  'wf-key-attest-insider', repeat('f', 64)) \gset insider_
select pg_temp.wf_refused($c$select * from identity.staff_credential_attestations$c$,
  'permission denied for table staff_credential_attestations');
select pg_temp.wf_refused($c$update identity.staff_facility_memberships set active = true
  where id = 'c8840000-0000-4000-8000-000000000005'$c$, 'permission denied for table staff_facility_memberships');

-- 6. Role grant refusals.
select pg_temp.wf_as('1');
select pg_temp.wf_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'c8810000-0000-4000-8000-00000000000a', 1, 'doctor', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-01',
  repeat('a', 64))$c$, current_setting('suite.new_membership')), 'WORKFORCE_SECOND_PERSON_REQUIRED');
select pg_temp.wf_as('3');
select pg_temp.wf_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'c8810000-0000-4000-8000-00000000000a', 1, 'doctor', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-02',
  repeat('a', 64))$c$, current_setting('suite.new_membership')), 'WORKFORCE_FACILITY_CONFLICT');
select pg_temp.wf_as('2');
select pg_temp.wf_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'c8810000-0000-4000-8000-00000000000b', 1, 'doctor', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-03',
  repeat('a', 64))$c$, current_setting('suite.new_membership')), 'WORKFORCE_FACILITY_MISMATCH');
select pg_temp.wf_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'c8810000-0000-4000-8000-00000000000a', 7, 'doctor', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-04',
  repeat('a', 64))$c$, current_setting('suite.new_membership')), 'ADMIN_VERSION_CONFLICT');
select pg_temp.wf_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'c8810000-0000-4000-8000-00000000000a', 1, 'lab', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-05',
  repeat('a', 64))$c$, current_setting('suite.new_membership')), 'WORKFORCE_ROLE_NOT_GRANTABLE');
select pg_temp.wf_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'c8810000-0000-4000-8000-00000000000a', 1, 'nurse', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-06',
  repeat('a', 64))$c$, current_setting('suite.new_membership')), 'WORKFORCE_ATTESTATION_REQUIRED');
select pg_temp.wf_refused($c$select * from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000002',
  'c8810000-0000-4000-8000-00000000000b', 1, 'nurse', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-07',
  repeat('a', 64))$c$, 'WORKFORCE_SELF_CHANGE_DENIED');
select pg_temp.wf_refused($c$select * from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000007',
  'c8810000-0000-4000-8000-00000000000a', 1, 'doctor', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-08',
  repeat('a', 64))$c$, 'WORKFORCE_ROLE_CONFLICT');
-- The existing identity's pending membership at A: its only attestation is by
-- someone who works at A.
select pg_temp.wf_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'c8810000-0000-4000-8000-00000000000a', 1, 'doctor', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-09',
  repeat('a', 64))$c$, current_setting('suite.existing_pending')), 'WORKFORCE_ATTESTATION_REQUIRED');
select pg_temp.wf_as('4');
select pg_temp.wf_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'c8810000-0000-4000-8000-00000000000a', 1, 'doctor', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-10',
  repeat('a', 64))$c$, current_setting('suite.new_membership')), 'ADMIN_PERMISSION_DENIED');

-- 7. The grant: a second administrator, on the reviewer's current attestation.
select pg_temp.wf_as('2');
do $$
declare
  granted record;
  replayed record;
begin
  select * into granted from identity.admin_change_workforce_role(current_setting('suite.new_membership')::uuid,
    'c8810000-0000-4000-8000-00000000000a', 1, 'doctor', 'grant', 'Synthetic clinical role grant',
    'wf-key-grant-ok', repeat('1', 64));
  if granted.replayed or not granted.role_active or not granted.membership_active
     or granted.membership_state <> 'active' or granted.membership_version <> 2
     or granted.attestation_id <> current_setting('suite.attestation')::uuid then
    raise exception 'grant returned %', row_to_json(granted);
  end if;
  select * into replayed from identity.admin_change_workforce_role(current_setting('suite.new_membership')::uuid,
    'c8810000-0000-4000-8000-00000000000a', 1, 'doctor', 'grant', 'Synthetic clinical role grant',
    'wf-key-grant-ok', repeat('1', 64));
  if not replayed.replayed or replayed.membership_version <> 2 then
    raise exception 'grant replay returned %', row_to_json(replayed);
  end if;
end $$;
select pg_temp.wf_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'c8810000-0000-4000-8000-00000000000a', 2, 'doctor', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-again',
  repeat('a', 64))$c$, current_setting('suite.new_membership')), 'WORKFORCE_ROLE_ALREADY_ACTIVE');

reset role;
-- The clinician sets a password through account recovery (as
-- auth.complete_recovery_otp does); only then can the role be used.
do $$ begin
  if auth.membership_has_permission((select subject from auth.accounts
        where id = current_setting('suite.new_account')::uuid),
      current_setting('suite.new_membership')::uuid, 'c8810000-0000-4000-8000-00000000000a', 'identity.consent.write') then
    raise exception 'a pending_reset account must not be authorized before it sets a password';
  end if;
end $$;
update auth.accounts set status = 'active', password_hash = 'synthetic-hash', password_algorithm = 'argon2id',
  password_changed_at = now() where id = current_setting('suite.new_account')::uuid;
do $$
declare
  new_account uuid := current_setting('suite.new_account')::uuid;
  new_membership uuid := current_setting('suite.new_membership')::uuid;
  new_subject text := (select subject from auth.accounts where id = current_setting('suite.new_account')::uuid);
begin
  if not exists (select 1 from identity.staff_facility_memberships where id = new_membership and active
      and membership_role = 'doctor' and app_role = 'doctor')
     or not exists (select 1 from identity.workforce_memberships where membership_id = new_membership
       and state = 'active' and activated_by = 'c8820000-0000-4000-8000-000000000002')
     or not exists (select 1 from auth.account_roles assignment join identity.workforce_role_grants role_grant
       on role_grant.account_role_id = assignment.id
       where assignment.membership_id = new_membership and assignment.role_code = 'doctor'
         and assignment.granted_by = 'c8820000-0000-4000-8000-000000000002' and assignment.revoked_at is null
         and role_grant.attestation_id = current_setting('suite.attestation')::uuid) then
    raise exception 'the grant did not activate the membership with an attested doctor role';
  end if;
  -- The account still has no password, but the role now authorizes.
  if not auth.membership_has_permission(new_subject, new_membership, 'c8810000-0000-4000-8000-00000000000a',
      'identity.consent.write') then
    raise exception 'an attested grant must authorize its permissions';
  end if;
  -- The pending, now active membership is the one N5 binding at A.
  begin
    insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active)
    select gen_random_uuid(), staff_id, account_id, organization_id, facility_id, 'nurse', 'nurse', false, true
    from identity.staff_facility_memberships where id = new_membership;
    raise exception 'a second active membership was accepted beside an activated one';
  exception when unique_violation then null;
  end;
end $$;

-- 8. A lapsed attestation leaves its role ineffective; other roles are unaffected.
insert into identity.staff_credential_attestations (id, staff_id, account_id, attested_roles, credential_reference,
  issuing_authority, verification_method, evidence_reference, valid_until, reviewer_account_id, reason, correlation_id,
  recorded_at)
values ('c88a0000-0000-4000-8000-000000000008', 'c8830000-0000-4000-8000-000000000008',
  'c8820000-0000-4000-8000-000000000008', array['doctor'], 'MDCN/R/0008', 'Medical and Dental Council of Nigeria',
  'manual_review', 'Synthetic lapsed evidence', now() - interval '1 day', 'c8820000-0000-4000-8000-000000000001',
  'Synthetic lapsed attestation', 'workforce-suite-lapsed', now() - interval '2 days');
insert into identity.workforce_role_grants (account_role_id, attestation_id, account_id, membership_id, facility_id,
  role_code, granted_by, correlation_id)
values ('c889f000-0000-4000-8000-000000000008', 'c88a0000-0000-4000-8000-000000000008',
  'c8820000-0000-4000-8000-000000000008', 'c8840000-0000-4000-8000-000000000008',
  'c8810000-0000-4000-8000-00000000000b', 'doctor', 'c8820000-0000-4000-8000-000000000002', 'workforce-suite-lapsed');
do $$ begin
  if auth.facility_role_is_effective('c889f000-0000-4000-8000-000000000008')
     or not auth.facility_role_is_effective('c889f000-0000-4000-8000-000000000005')
     or auth.membership_has_permission('synthetic:wf:lapsed', 'c8840000-0000-4000-8000-000000000008',
       'c8810000-0000-4000-8000-00000000000b', 'identity.consent.write')
     or not auth.membership_has_permission('synthetic:wf:existing', 'c8840000-0000-4000-8000-000000000005',
       'c8810000-0000-4000-8000-00000000000b', 'identity.consent.write') then
    raise exception 'a lapsed attestation must remove only the role it supported';
  end if;
  begin
    update identity.staff_credential_attestations set valid_until = now() + interval '1 year'
     where id = 'c88a0000-0000-4000-8000-000000000008';
    raise exception 'an attestation was changed';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;

-- 9. Revoke one role; legacy roles can be withdrawn too.
set local role hid_identity_api_runtime;
select pg_temp.wf_as('2');
select pg_temp.wf_refused($c$select * from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000005',
  'c8810000-0000-4000-8000-00000000000b', 1, 'pharmacist', 'revoke', 'Synthetic clinical role revoke', 'wf-key-revoke-00',
  repeat('a', 64))$c$, 'WORKFORCE_ROLE_NOT_ACTIVE');
do $$
declare
  revoked record;
begin
  select * into revoked from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000005',
    'c8810000-0000-4000-8000-00000000000b', 1, 'lab', 'revoke', 'Synthetic legacy lab role withdrawal',
    'wf-key-revoke-01', repeat('2', 64));
  if revoked.role_active or not revoked.membership_active or revoked.membership_version <> 2 then
    raise exception 'revoke returned %', row_to_json(revoked);
  end if;
end $$;
select pg_temp.wf_refused($c$select * from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000005',
  'c8810000-0000-4000-8000-00000000000b', 1, 'doctor', 'revoke', 'Synthetic clinical role revoke', 'wf-key-revoke-02',
  repeat('a', 64))$c$, 'ADMIN_VERSION_CONFLICT');

-- 10. Ending a membership: its roles, grants, pending requests and the
-- account's staff sessions end with it.
reset role;
insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, reason, status,
  requested_duration_minutes, purpose_of_use)
select 'c88b0000-0000-4000-8000-000000000001', 'c8870000-0000-4000-8000-000000000001', membership.staff_id,
  membership.id, membership.facility_id, 'read_records', 'Synthetic pending request', 'pending', 60, 'direct-care'
from identity.staff_facility_memberships membership where membership.id = current_setting('suite.new_membership')::uuid;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, purpose_of_use)
select 'c88c0000-0000-4000-8000-000000000001', 'c8870000-0000-4000-8000-000000000001', membership.staff_id,
  membership.account_id, membership.id, membership.facility_id, 'read_records', 'active', 'Synthetic active grant',
  now(), now() + interval '1 hour', 'direct-care'
from identity.staff_facility_memberships membership where membership.id = current_setting('suite.new_membership')::uuid;
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti,
    account_token_version, authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
values
  ('c88d0000-0000-4000-8000-000000000001', current_setting('suite.new_account')::uuid,
   'c88d0000-0000-4000-8000-000000000001', repeat('7', 64), gen_random_uuid(), 1, 'password',
   now(), now() + interval '1 hour', now() + interval '8 hours', 'staff'),
  ('c88d0000-0000-4000-8000-000000000002', current_setting('suite.new_account')::uuid,
   'c88d0000-0000-4000-8000-000000000002', repeat('8', 64), gen_random_uuid(), 1, 'password',
   now(), now() + interval '1 hour', now() + interval '8 hours', 'staff'),
  ('c88d0000-0000-4000-8000-000000000005', 'c8820000-0000-4000-8000-000000000005',
   'c88d0000-0000-4000-8000-000000000005', repeat('9', 64), gen_random_uuid(), 1, 'password',
   now(), now() + interval '1 hour', now() + interval '8 hours', 'staff');
set local role hid_identity_api_runtime;
select pg_temp.wf_as('2');
select pg_temp.wf_refused($c$select * from identity.admin_end_workforce_membership('c8840000-0000-4000-8000-000000000002',
  'c8810000-0000-4000-8000-00000000000b', 1, 'Synthetic workforce end', 'wf-key-end-self', repeat('a', 64))$c$,
  'WORKFORCE_SELF_CHANGE_DENIED');
select pg_temp.wf_as('1');
select pg_temp.wf_refused(format($c$select * from identity.admin_end_workforce_membership(%L,
  'c8810000-0000-4000-8000-00000000000b', 2, 'Synthetic workforce end', 'wf-key-end-mismatch', repeat('a', 64))$c$,
  current_setting('suite.new_membership')), 'WORKFORCE_FACILITY_MISMATCH');
select pg_temp.wf_refused(format($c$select * from identity.admin_end_workforce_membership(%L,
  'c8810000-0000-4000-8000-00000000000a', 1, 'Synthetic workforce end', 'wf-key-end-stale', repeat('a', 64))$c$,
  current_setting('suite.new_membership')), 'ADMIN_VERSION_CONFLICT');
do $$
declare
  ended record;
  replayed record;
begin
  select * into ended from identity.admin_end_workforce_membership(current_setting('suite.new_membership')::uuid,
    'c8810000-0000-4000-8000-00000000000a', 2, 'Synthetic workforce end of employment', 'wf-key-end-ok',
    repeat('3', 64));
  if ended.replayed or ended.revoked_roles <> 1 or ended.revoked_grants <> 1 or ended.expired_requests <> 1
     or ended.revoked_sessions <> 2 or ended.membership_version <> 3
     or ended.account_id <> current_setting('suite.new_account')::uuid then
    raise exception 'end returned %', row_to_json(ended);
  end if;
  select * into replayed from identity.admin_end_workforce_membership(current_setting('suite.new_membership')::uuid,
    'c8810000-0000-4000-8000-00000000000a', 2, 'Synthetic workforce end of employment', 'wf-key-end-ok',
    repeat('3', 64));
  if not replayed.replayed or replayed.revoked_grants <> 1 then
    raise exception 'end replay returned %', row_to_json(replayed);
  end if;
end $$;
select pg_temp.wf_refused(format($c$select * from identity.admin_end_workforce_membership(%L,
  'c8810000-0000-4000-8000-00000000000a', 3, 'Synthetic workforce end', 'wf-key-end-again', repeat('a', 64))$c$,
  current_setting('suite.new_membership')), 'WORKFORCE_MEMBERSHIP_ENDED');
select pg_temp.wf_as('2');
select pg_temp.wf_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'c8810000-0000-4000-8000-00000000000a', 3, 'doctor', 'grant', 'Synthetic clinical role grant', 'wf-key-grant-ended',
  repeat('a', 64))$c$, current_setting('suite.new_membership')), 'WORKFORCE_MEMBERSHIP_ENDED');

reset role;
do $$
declare
  new_membership uuid := current_setting('suite.new_membership')::uuid;
  new_account uuid := current_setting('suite.new_account')::uuid;
begin
  if exists (select 1 from identity.staff_facility_memberships where id = new_membership and active)
     or exists (select 1 from auth.account_roles where membership_id = new_membership and revoked_at is null)
     or not exists (select 1 from auth.account_roles where membership_id = new_membership
       and revoked_by = 'c8820000-0000-4000-8000-000000000001'
       and revocation_reason = 'Synthetic workforce end of employment')
     or not exists (select 1 from identity.consent_grants where id = 'c88c0000-0000-4000-8000-000000000001'
       and status = 'revoked' and revoked_by = 'c8820000-0000-4000-8000-000000000001')
     or not exists (select 1 from identity.access_requests where id = 'c88b0000-0000-4000-8000-000000000001'
       and status = 'expired')
     or exists (select 1 from auth.sessions where account_id = new_account and session_kind = 'staff'
       and (revoked_at is null or revocation_reason <> 'workforce_membership_ended'))
     or not exists (select 1 from auth.session_events where account_id = new_account and event_type = 'revoked'
       and details->>'reason' = 'workforce_membership_ended' and (details->>'revokedCount')::integer = 2)
     or not exists (select 1 from identity.workforce_memberships where membership_id = new_membership
       and state = 'ended' and ended_by = 'c8820000-0000-4000-8000-000000000001') then
    raise exception 'ending the membership left something open';
  end if;
  -- Ended is terminal for everyone, the schema owner included.
  begin
    update identity.staff_facility_memberships set active = true where id = new_membership;
    raise exception 'an ended membership was reactivated';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'WORKFORCE_MEMBERSHIP_ENDED' then raise; end if;
  end;
  begin
    update identity.workforce_memberships set state = 'active', row_version = row_version + 1
     where membership_id = new_membership;
    raise exception 'an ended lifecycle was reopened';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;

-- 11. A clinician can be attached again after an ending, as a new membership;
-- a pending membership can be ended too.
set local role hid_identity_api_runtime;
select pg_temp.wf_as('1');
do $$
declare
  again record;
  ended record;
begin
  select * into again from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
    current_setting('suite.new_account')::uuid, null, null, 'Synthetic workforce re-attach', 'wf-key-attach-again',
    repeat('4', 64));
  if again.membership_id = current_setting('suite.new_membership')::uuid or again.account_created then
    raise exception 're-attach returned %', row_to_json(again);
  end if;
  select * into ended from identity.admin_end_workforce_membership(current_setting('suite.existing_pending')::uuid,
    'c8810000-0000-4000-8000-00000000000a', 1, 'Synthetic pending attach withdrawn', 'wf-key-end-pending',
    repeat('5', 64));
  if ended.revoked_roles <> 0 or ended.revoked_grants <> 0 or ended.expired_requests <> 0
     or ended.revoked_sessions <> 0 then
    raise exception 'ending a pending membership returned %', row_to_json(ended);
  end if;
  -- The narrowed scoped index keeps the ended 'pending' row as history.
  select * into again from identity.admin_attach_workforce_member('c8810000-0000-4000-8000-00000000000a',
    'c8820000-0000-4000-8000-000000000005', null, null, 'Synthetic workforce attach once more',
    'wf-key-attach-existing-again', repeat('6', 64));
end $$;
reset role;
do $$ begin
  if exists (select 1 from auth.sessions where id = 'c88d0000-0000-4000-8000-000000000005' and revoked_at is not null) then
    raise exception 'ending a pending membership revoked the account''s sessions elsewhere';
  end if;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.wf_as('1');

-- 12. The profile read.
do $$
declare
  profile jsonb := identity.admin_workforce_profile(current_setting('suite.new_account')::uuid);
begin
  if profile->'staff'->>'verificationStatus' <> 'verified'
     or jsonb_array_length(profile->'attestations') <> 1
     or profile->'attestations'->0->>'credentialReference' <> 'MDCN/R/0001'
     or (profile->'attestations'->0->>'current')::boolean is not true
     or jsonb_array_length(profile->'memberships') <> 2
     or not exists (select 1 from jsonb_array_elements(profile->'memberships') item
       where item->>'state' = 'ended' and jsonb_array_length(item->'roles') = 0)
     or not exists (select 1 from jsonb_array_elements(profile->'memberships') item
       where item->>'state' = 'pending') then
    raise exception 'profile returned %', profile;
  end if;
end $$;

-- 13. Lock order. Both membership commands lock the account rows FOR UPDATE
-- first (0073), then the membership FOR NO KEY UPDATE: the membership update
-- changes no key column, and a foreign-key insert that references the
-- membership (an approval's consent grant, an access request) takes KEY SHARE,
-- which FOR NO KEY UPDATE does not block, so neither side waits for the other
-- while holding what the other needs. Ending a membership expires its pending
-- requests before it revokes its grants, so an approval that commits while the
-- end waits on its request has its new grant revoked. The two-connection races
-- run in services/identity-api/scripts/verify-platform-admin-runtime.mjs.
reset role;
do $$
declare
  command regprocedure;
  definition text;
  account_lock integer;
  membership_lock integer;
begin
  -- Since 0098 the grant's body is identity.workforce_change_role (0087's body
  -- with the reservation and the pin) and identity.admin_change_workforce_role
  -- only delegates to it with no pin, so the lock order is checked there.
  definition := regexp_replace(lower(pg_get_functiondef(
    'identity.admin_change_workforce_role(uuid,uuid,bigint,text,text,text,text,character)'::regprocedure)), '\s+', ' ', 'g');
  if definition !~ 'as \$function\$ begin return query select \* from identity\.workforce_change_role\(requested_membership_id, requested_facility_id, expected_membership_version, requested_role_code, requested_action, requested_reason, requested_idempotency_key, requested_sha256, null\); end \$function\$' then
    raise exception 'identity.admin_change_workforce_role must only delegate to identity.workforce_change_role with no pin';
  end if;
  foreach command in array array[
    'identity.workforce_change_role(uuid,uuid,bigint,text,text,text,text,character,uuid)'::regprocedure,
    'identity.admin_end_workforce_membership(uuid,uuid,bigint,text,text,character)'::regprocedure
  ] loop
    definition := regexp_replace(lower(pg_get_functiondef(command)), '\s+', ' ', 'g');
    account_lock := position('order by account_row.id for update' in definition);
    membership_lock := position('where membership.id = requested_membership_id for no key update' in definition);
    if account_lock = 0 or membership_lock = 0 or account_lock > membership_lock
       or position('where membership.id = requested_membership_id for update' in definition) > 0 then
      raise exception '% must lock the accounts FOR UPDATE and then the membership FOR NO KEY UPDATE', command;
    end if;
  end loop;
  -- The staff row is referenced the same way (consent grants, access
  -- requests) and its update changes no key column either.
  foreach command in array array[
    'identity.admin_attach_workforce_member(uuid,uuid,text,text,text,text,character)'::regprocedure,
    'identity.admin_record_credential_attestation(uuid,bigint,text[],text,text,text,timestamptz,text,text,character)'::regprocedure
  ] loop
    definition := regexp_replace(lower(pg_get_functiondef(command)), '\s+', ' ', 'g');
    if position('where staff_row.account_id = target.id for no key update' in definition) = 0
       or position('where staff_row.account_id = target.id for update' in definition) > 0 then
      raise exception '% must lock the staff row FOR NO KEY UPDATE', command;
    end if;
  end loop;
  definition := regexp_replace(lower(pg_get_functiondef(
    'identity.admin_end_workforce_membership(uuid,uuid,bigint,text,text,character)'::regprocedure)), '\s+', ' ', 'g');
  if position('update identity.access_requests' in definition) = 0
     or position('update identity.consent_grants' in definition) = 0
     or position('update identity.access_requests' in definition)
        > position('update identity.consent_grants' in definition) then
    raise exception 'ending a membership must expire its pending requests before it revokes its consent grants';
  end if;
end $$;

-- 14. Renewal. A role that rests on a lapsed attestation, or on one that a
-- newer attestation outlasts, is replaced by a grant on the current
-- attestation: the old assignment is revoked with the grant's reason, a new
-- one rests on the new attestation, and the reviewer still cannot grant.
-- Account 08's doctor role at B rests on the lapsed attestation of section 8.
set local role hid_identity_api_runtime;
select pg_temp.wf_as('1');
do $$
declare
  attested record;
begin
  select * into attested from identity.admin_record_credential_attestation('c8820000-0000-4000-8000-000000000008', 1,
    array['doctor'], 'MDCN/R/0008', 'Medical and Dental Council of Nigeria', 'Synthetic renewed evidence WF-8',
    clock_timestamp() + interval '1 year', 'Synthetic review of the renewed licence', 'wf-key-attest-renew-1',
    repeat('7', 64));
  perform set_config('suite.renewal_attestation', attested.attestation_id::text, true);
end $$;
select pg_temp.wf_refused($c$select * from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000008',
  'c8810000-0000-4000-8000-00000000000b', 1, 'doctor', 'grant', 'Synthetic renewal grant', 'wf-key-renew-reviewer',
  repeat('a', 64))$c$, 'WORKFORCE_SECOND_PERSON_REQUIRED');
-- The granter (02) works at B; the insider (03) works only at A.
select pg_temp.wf_as('2');
select pg_temp.wf_refused($c$select * from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000008',
  'c8810000-0000-4000-8000-00000000000b', 1, 'doctor', 'grant', 'Synthetic renewal grant', 'wf-key-renew-insider',
  repeat('a', 64))$c$, 'WORKFORCE_FACILITY_CONFLICT');
select pg_temp.wf_as('3');
do $$
declare
  renewed record;
begin
  select * into renewed from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000008',
    'c8810000-0000-4000-8000-00000000000b', 1, 'doctor', 'grant', 'Synthetic renewal of a lapsed doctor role',
    'wf-key-renew-1', repeat('8', 64));
  if renewed.replayed or not renewed.role_active or not renewed.renewed or not renewed.membership_active
     or renewed.membership_version <> 2
     or renewed.attestation_id <> current_setting('suite.renewal_attestation')::uuid then
    raise exception 'renewal returned %', row_to_json(renewed);
  end if;
  select * into renewed from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000008',
    'c8810000-0000-4000-8000-00000000000b', 1, 'doctor', 'grant', 'Synthetic renewal of a lapsed doctor role',
    'wf-key-renew-1', repeat('8', 64));
  if not renewed.replayed or not renewed.renewed then
    raise exception 'renewal replay returned %', row_to_json(renewed);
  end if;
end $$;
-- Nothing outlasts the renewed attestation, so a further grant is refused.
select pg_temp.wf_refused($c$select * from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000008',
  'c8810000-0000-4000-8000-00000000000b', 2, 'doctor', 'grant', 'Synthetic second renewal', 'wf-key-renew-again',
  repeat('a', 64))$c$, 'WORKFORCE_ROLE_ALREADY_ACTIVE');
-- A role granted any other way never lapses, so it is never renewed.
select pg_temp.wf_refused($c$select * from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000005',
  'c8810000-0000-4000-8000-00000000000b', 2, 'doctor', 'grant', 'Synthetic legacy renewal', 'wf-key-renew-legacy',
  repeat('a', 64))$c$, 'WORKFORCE_ROLE_ALREADY_ACTIVE');

reset role;
do $$
declare
  live record;
begin
  if not exists (select 1 from auth.account_roles where id = 'c889f000-0000-4000-8000-000000000008'
      and revoked_at is not null and revoked_by = 'c8820000-0000-4000-8000-000000000003'
      and revocation_reason = 'Synthetic renewal of a lapsed doctor role') then
    raise exception 'the lapsed assignment must be revoked, not edited, by the renewal';
  end if;
  select assignment.id, role_grant.attestation_id into live
  from auth.account_roles assignment
  join identity.workforce_role_grants role_grant on role_grant.account_role_id = assignment.id
  where assignment.membership_id = 'c8840000-0000-4000-8000-000000000008' and assignment.role_code = 'doctor'
    and assignment.revoked_at is null;
  if live.id is null or live.attestation_id <> current_setting('suite.renewal_attestation')::uuid
     or not auth.facility_role_is_effective(live.id)
     or (select count(*) from auth.account_roles where membership_id = 'c8840000-0000-4000-8000-000000000008'
       and revoked_at is null) <> 1
     or not auth.membership_has_permission('synthetic:wf:lapsed', 'c8840000-0000-4000-8000-000000000008',
       'c8810000-0000-4000-8000-00000000000b', 'identity.consent.write') then
    raise exception 'the renewed role must rest on the new attestation and authorize again';
  end if;
  perform set_config('suite.renewed_role', live.id::text, true);
end $$;

-- Before a lapse: a shorter attestation renews nothing; a longer one does.
set local role hid_identity_api_runtime;
select pg_temp.wf_as('1');
select * from identity.admin_record_credential_attestation('c8820000-0000-4000-8000-000000000008', 2,
  array['doctor'], 'MDCN/R/0008', 'Medical and Dental Council of Nigeria', 'Synthetic short evidence WF-8',
  clock_timestamp() + interval '6 months', 'Synthetic shorter attestation', 'wf-key-attest-renew-2',
  repeat('9', 64)) \gset short_
select pg_temp.wf_as('3');
select pg_temp.wf_refused($c$select * from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000008',
  'c8810000-0000-4000-8000-00000000000b', 2, 'doctor', 'grant', 'Synthetic shorter renewal', 'wf-key-renew-short',
  repeat('a', 64))$c$, 'WORKFORCE_ROLE_ALREADY_ACTIVE');
select pg_temp.wf_as('1');
do $$
declare
  attested record;
begin
  select * into attested from identity.admin_record_credential_attestation('c8820000-0000-4000-8000-000000000008', 3,
    array['doctor', 'nurse'], 'MDCN/R/0008', 'Medical and Dental Council of Nigeria', 'Synthetic long evidence WF-8',
    clock_timestamp() + interval '2 years', 'Synthetic longer attestation', 'wf-key-attest-renew-3', repeat('b', 64));
  perform set_config('suite.longer_attestation', attested.attestation_id::text, true);
end $$;
select pg_temp.wf_as('3');
do $$
declare
  renewed record;
begin
  select * into renewed from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000008',
    'c8810000-0000-4000-8000-00000000000b', 2, 'doctor', 'grant', 'Synthetic renewal before the lapse',
    'wf-key-renew-2', repeat('c', 64));
  if not renewed.renewed or renewed.membership_version <> 3
     or renewed.attestation_id <> current_setting('suite.longer_attestation')::uuid then
    raise exception 'renewal before the lapse returned %', row_to_json(renewed);
  end if;
  -- A first grant of another role is not a renewal.
  select * into renewed from identity.admin_change_workforce_role('c8840000-0000-4000-8000-000000000008',
    'c8810000-0000-4000-8000-00000000000b', 3, 'nurse', 'grant', 'Synthetic nurse role grant',
    'wf-key-renew-nurse', repeat('d', 64));
  if renewed.renewed or not renewed.role_active or renewed.membership_version <> 4 then
    raise exception 'a first grant returned %', row_to_json(renewed);
  end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from auth.account_roles where id = current_setting('suite.renewed_role')::uuid
      and revoked_at is not null and revocation_reason = 'Synthetic renewal before the lapse')
     or (select count(*) from auth.account_roles where membership_id = 'c8840000-0000-4000-8000-000000000008'
       and revoked_at is null) <> 2
     or not exists (select 1 from auth.account_roles assignment
       join identity.workforce_role_grants role_grant on role_grant.account_role_id = assignment.id
       where assignment.membership_id = 'c8840000-0000-4000-8000-000000000008' and assignment.role_code = 'doctor'
         and assignment.revoked_at is null
         and role_grant.attestation_id = current_setting('suite.longer_attestation')::uuid) then
    raise exception 'the renewal before the lapse must replace the earlier assignment';
  end if;
end $$;

reset role;
rollback;
