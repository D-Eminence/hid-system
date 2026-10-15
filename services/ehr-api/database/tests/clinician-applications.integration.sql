\set ON_ERROR_STOP on
-- Clinician self sign-up with two-admin approval (0094, ADR-064, owner
-- decision 2 of 2026-10-14). Rollback-only; synthetic data only. Every
-- public, capability and system command runs as hid_identity_api_runtime in
-- Identity's system context, and every administration command as that role
-- with an MFA-verified platform session, so a missing runtime grant fails here.
-- Rows written "as the owner" stand in for what Identity's MfaService writes
-- (factors, 0088 challenges) or move a clock (created_at, expires_at).
--
--  1. Privileges.                       10. Admin queue and detail.
--  2. The control and the intake gate.  11. Step 1 (attest).
--  3. Email-code challenges.            12. Step 2 (approve), the pinned grant.
--  4. Quotas.                           13. Reserved attestations.
--  5. Facility search.                  14. Reject.
--  6. Submit.                           15. Withdraw and ending a capability.
--  7. Authenticator ready.              16. Expiry and pruning.
--  8. Status access.                    17. Guard and checks.
--  9. Applying to another facility.
begin;

-- Fixture. Organization O1 (active) holds facilities X, Y, W and U (verified)
-- and Z (pending); organization O2 (inactive) holds V.
insert into identity.organizations (id, name, slug) values
  ('ca100000-0000-4000-8000-000000000001', 'Clinician Suite Organization', 'clinician-suite-org'),
  ('ca100000-0000-4000-8000-000000000002', 'Clinician Suite Closed Organization', 'clinician-suite-closed');
update identity.organizations set active = false where id = 'ca100000-0000-4000-8000-000000000002';
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('ca110000-0000-4000-8000-00000000000a', 'ca100000-0000-4000-8000-000000000001', 'Clinician Suite Hospital X', 'CA-SUITE-X', 'Africa/Lagos', true, 'verified'),
  ('ca110000-0000-4000-8000-00000000000b', 'ca100000-0000-4000-8000-000000000001', 'Clinician Suite Clinic Y', 'CA-SUITE-Y', 'Africa/Lagos', true, 'verified'),
  ('ca110000-0000-4000-8000-00000000000c', 'ca100000-0000-4000-8000-000000000001', 'Clinician Suite Pending Z', 'CA-SUITE-Z', 'Africa/Lagos', false, 'pending'),
  ('ca110000-0000-4000-8000-00000000000d', 'ca100000-0000-4000-8000-000000000001', 'Clinician Suite 100% Care_W', 'CA-SUITE-W', 'Africa/Lagos', true, 'verified'),
  ('ca110000-0000-4000-8000-00000000000e', 'ca100000-0000-4000-8000-000000000002', 'Clinician Suite Closed V', 'CA-SUITE-V', 'Africa/Lagos', true, 'verified'),
  ('ca110000-0000-4000-8000-00000000000f', 'ca100000-0000-4000-8000-000000000001', 'Clinician Suite Unit U', 'CA-SUITE-U', 'Africa/Lagos', true, 'verified');

-- Accounts:
--   01 a  Super Admin A (step 1)        07 p  a patient's own account
--   02 b  Super Admin B (step 2)        08 o  X's org_admin (Ada Orgadmin)
--   03 c  Super Admin C, a doctor at X  09 h  an account whose staff record uses staff-held@ca.invalid
--   04 s  support_admin                 10 x  a deleted account (deleted@ca.invalid)
--   05 d  Super Admin D                 11 t  Super Admin T, who also applied (at Y)
--   06 n  Super Admin without an authenticator
insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm) values
  ('ca200000-0000-4000-8000-000000000001', 'synthetic:ca:a', 'super-a@ca.invalid', 'Super Admin A', 'active', 'synthetic-hash', 'argon2id'),
  ('ca200000-0000-4000-8000-000000000002', 'synthetic:ca:b', 'super-b@ca.invalid', 'Super Admin B', 'active', 'synthetic-hash', 'argon2id'),
  ('ca200000-0000-4000-8000-000000000003', 'synthetic:ca:c', 'super-c@ca.invalid', 'Super Admin C', 'active', 'synthetic-hash', 'argon2id'),
  ('ca200000-0000-4000-8000-000000000004', 'synthetic:ca:s', 'support@ca.invalid', 'Support Admin', 'active', 'synthetic-hash', 'argon2id'),
  ('ca200000-0000-4000-8000-000000000005', 'synthetic:ca:d', 'super-d@ca.invalid', 'Super Admin D', 'active', 'synthetic-hash', 'argon2id'),
  ('ca200000-0000-4000-8000-000000000006', 'synthetic:ca:n', 'super-n@ca.invalid', 'Super Admin N', 'active', 'synthetic-hash', 'argon2id'),
  ('ca200000-0000-4000-8000-000000000007', 'synthetic:ca:p', 'patient@ca.invalid', 'Suite Patient', 'active', 'synthetic-hash', 'argon2id'),
  ('ca200000-0000-4000-8000-000000000008', 'synthetic:ca:o', 'orgadmin@ca.invalid', 'Ada Orgadmin', 'active', 'synthetic-hash', 'argon2id'),
  ('ca200000-0000-4000-8000-000000000009', 'synthetic:ca:h', 'account09@ca.invalid', 'Staff Held', 'active', 'synthetic-hash', 'argon2id'),
  ('ca200000-0000-4000-8000-000000000010', 'synthetic:ca:x', 'deleted@ca.invalid', 'Deleted Account', 'deleted', null, null),
  ('ca200000-0000-4000-8000-000000000011', 'synthetic:ca:t', 'super-t@ca.invalid', 'Super Admin T', 'active', 'synthetic-hash', 'argon2id');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason)
select ('ca230000-0000-4000-8000-0000000000' || n)::uuid, ('ca200000-0000-4000-8000-0000000000' || n)::uuid,
  role_name, 'platform', 'Synthetic clinician suite role'
from (values ('01', 'platform_super_admin'), ('02', 'platform_super_admin'), ('03', 'platform_super_admin'),
  ('04', 'support_admin'), ('05', 'platform_super_admin'), ('06', 'platform_super_admin'),
  ('11', 'platform_super_admin')) as roles(n, role_name);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name) values
  ('ca260000-0000-4000-8000-000000000007', 'ca200000-0000-4000-8000-000000000007', 'HID-CASUTEPA', 'Suite', 'Patient', 'Suite Patient');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, license_number) values
  ('ca210000-0000-4000-8000-000000000003', 'ca200000-0000-4000-8000-000000000003', 'Super Admin C', 'super-c@ca.invalid', 'verified', 'doctor', '12345'),
  ('ca210000-0000-4000-8000-000000000008', 'ca200000-0000-4000-8000-000000000008', 'Ada Orgadmin', 'orgadmin@ca.invalid', 'verified', 'org_admin', null),
  ('ca210000-0000-4000-8000-000000000009', 'ca200000-0000-4000-8000-000000000009', 'Staff Held', 'staff-held@ca.invalid', 'verified', 'staff', null),
  ('ca210000-0000-4000-8000-000000000011', 'ca200000-0000-4000-8000-000000000011', 'Super Admin T', 'super-t@ca.invalid', 'pending', 'staff', 'MDCN/9911');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('ca220000-0000-4000-8000-000000000003', 'ca210000-0000-4000-8000-000000000003', 'ca200000-0000-4000-8000-000000000003',
   'ca100000-0000-4000-8000-000000000001', 'ca110000-0000-4000-8000-00000000000a', 'doctor', 'doctor', true, true),
  ('ca220000-0000-4000-8000-000000000008', 'ca210000-0000-4000-8000-000000000008', 'ca200000-0000-4000-8000-000000000008',
   'ca100000-0000-4000-8000-000000000001', 'ca110000-0000-4000-8000-00000000000a', 'org_admin', 'org_admin', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('ca230000-0000-4000-8000-000000000103', 'ca200000-0000-4000-8000-000000000003', 'doctor', 'facility',
   'ca220000-0000-4000-8000-000000000003', 'ca110000-0000-4000-8000-00000000000a', 'Synthetic clinician suite role'),
  ('ca230000-0000-4000-8000-000000000108', 'ca200000-0000-4000-8000-000000000008', 'org_admin', 'facility',
   'ca220000-0000-4000-8000-000000000008', 'ca110000-0000-4000-8000-00000000000a', 'Synthetic clinician suite role');

-- Platform sessions with MFA for the administrators (not N), stepped up now.
insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, activated_at, last_used_step)
select ('ca240000-0000-4000-8000-0000000000' || n)::uuid, ('ca200000-0000-4000-8000-0000000000' || n)::uuid,
  'active', gen_random_bytes(49), 'suite-v1', now(), 1
from unnest(array['01', '02', '03', '04', '05', '11']) as n;
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti,
    account_token_version, authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
select ('ca250000-0000-4000-8000-0000000000' || n)::uuid, ('ca200000-0000-4000-8000-0000000000' || n)::uuid,
  ('ca250000-0000-4000-8000-0000000000' || n)::uuid, md5('ca-session-' || n) || md5('ca-refresh-' || n),
  gen_random_uuid(), 1, 'password',
  now(), now() + interval '15 minutes', now() + interval '8 hours', 'platform'
from unnest(array['01', '02', '03', '04', '05', '06', '11']) as n;
insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
select ('ca250000-0000-4000-8000-0000000000' || n)::uuid, ('ca200000-0000-4000-8000-0000000000' || n)::uuid,
  ('ca240000-0000-4000-8000-0000000000' || n)::uuid, 'totp', now() - interval '1 minute'
from unnest(array['01', '02', '03', '04', '05', '11']) as n;
update auth.session_assurance set step_up_at = clock_timestamp(), step_up_count = step_up_count + 1,
  row_version = row_version + 1
where family_id::text like 'ca250000-%';

-- Helpers.
create function pg_temp.ca_h(label text) returns text language sql immutable as $$
  select encode(sha256(convert_to(label, 'UTF8')), 'hex')
$$;
-- Identity's system context (public, capability and system commands).
create function pg_temp.ca_system(tag text) returns void language sql as $$
  select set_config('app.actor_subject', 'system:auth', true),
    set_config('app.correlation_id', 'clinician-suite-' || tag, true),
    set_config('app.session_id', '', true), set_config('app.access_scope', '', true),
    set_config('app.purpose_of_use', '', true), set_config('app.facility_id', '', true),
    set_config('app.membership_id', '', true);
$$;
-- A platform administrator's context.
create function pg_temp.ca_as(n text) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:ca:' || n, true),
    set_config('app.session_id', 'ca250000-0000-4000-8000-0000000000' || case n when 'a' then '01' when 'b' then '02'
      when 'c' then '03' when 's' then '04' when 'd' then '05' when 'n' then '06' when 't' then '11' end, true),
    set_config('app.correlation_id', 'clinician-suite-admin-' || n, true),
    set_config('app.access_scope', 'platform', true),
    set_config('app.purpose_of_use', 'healthcare-operations', true),
    set_config('app.facility_id', '', true), set_config('app.membership_id', '', true);
$$;
create function pg_temp.ca_refused(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if sqlerrm = expected then return; end if;
    raise exception 'expected %, got % (%) from %', expected, sqlerrm, sqlstate, command;
  end;
  raise exception 'expected % but the command succeeded: %', expected, command;
end $$;
-- The SQLSTATE and message of a refusal.
create function pg_temp.ca_refused_with(command text, expected_state text, expected text) returns void
language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if sqlstate = expected_state and sqlerrm = expected then return; end if;
    raise exception 'expected % %, got % % from %', expected_state, expected, sqlstate, sqlerrm, command;
  end;
  raise exception 'expected % but the command succeeded: %', expected, command;
end $$;
-- A verified sign-up email: the start and the correct code (a 60-minute draft).
create function pg_temp.ca_draft(tag text, email text) returns void language plpgsql as $$
declare
  challenge uuid := gen_random_uuid();
  outcome text;
begin
  if not identity.begin_clinician_application_challenge('signup', challenge, pg_temp.ca_h('email:' || lower(email)),
      email, pg_temp.ca_h('code:' || tag)) then
    raise exception 'the sign-up start for % delivered nothing', tag;
  end if;
  outcome := identity.verify_clinician_application_signup_code(challenge, pg_temp.ca_h('email:' || lower(email)),
    email, pg_temp.ca_h('code:' || tag), pg_temp.ca_h('session:' || tag));
  if outcome <> 'verified' then
    raise exception 'the sign-up code for % answered %', tag, outcome;
  end if;
end $$;
-- A submission through a draft; the next capability is session:<tag>-account.
create function pg_temp.ca_submit(tag text, email text, full_name text, role_code text, regulator text,
  licence text, valid_until date, facility uuid, open_limit integer default 30) returns uuid language plpgsql as $$
declare
  created uuid;
begin
  select application_id into created from identity.submit_clinician_application(pg_temp.ca_h('session:' || tag),
    pg_temp.ca_h('session:' || tag || '-account'), 'clinician-suite-key-' || tag, pg_temp.ca_h('sha:' || tag), email,
    pg_temp.ca_h('email:' || lower(email)), full_name,
    '$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljaGFzaA', role_code, regulator, licence,
    valid_until, facility, open_limit);
  return created;
end $$;
create function pg_temp.ca_account(email text) returns uuid language sql as $$
  select id from auth.accounts where lower(email) = lower($1) and status <> 'deleted'
$$;
-- A fixture lookup (as the session user: the runtime cannot read the table).
create function pg_temp.ca_application(email text, facility uuid) returns identity.clinician_applications
language sql security definer as $$
  select application.* from identity.clinician_applications application
   where application.account_id = pg_temp.ca_account(email) and application.facility_id = facility
   order by application.submitted_at desc limit 1
$$;
-- As the owner: a staff-proven authenticator (a verified 0088 email-code
-- enrolment challenge, then the factor that records it), used just now.
create function pg_temp.ca_proven_factor(account uuid, factor uuid) returns void language plpgsql as $$
declare
  challenge uuid := gen_random_uuid();
begin
  insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
    expires_at, max_attempts, session_kind, proof_method, proof_verifier_hmac, proof_key_version, proof_sent_at,
    proof_verified_at)
  values (challenge, account, 'enroll', pg_temp.ca_h('challenge:' || challenge), 1, clock_timestamp(),
    clock_timestamp() + interval '9 minutes', 5, 'staff', 'email_code', repeat('e', 64), 'suite-v1',
    clock_timestamp(), clock_timestamp());
  insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, activated_at,
    last_used_step, last_used_at, enrollment_proof, enrollment_challenge_id)
  values (factor, account, 'active', gen_random_bytes(49), 'suite-v1', clock_timestamp(), 1, clock_timestamp(),
    'email_code', challenge);
  update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
   where id = challenge;
end $$;
-- As the owner: a capability for an account at a stage (a token digest of session:<tag>).
create function pg_temp.ca_capability(tag text, account uuid, stage text) returns void language sql as $$
  insert into identity.clinician_application_sessions (id, token_hmac, kind, account_id, stage, created_at, expires_at)
  select gen_random_uuid(), pg_temp.ca_h('session:' || tag), 'account', account, stage, opened.at,
    opened.at + interval '30 minutes'
    from (select clock_timestamp() as at) opened
$$;
-- As the owner: moves an application's submission back, so it is due.
create function pg_temp.ca_age(application uuid, by_interval interval) returns void language plpgsql as $$
begin
  alter table identity.clinician_applications disable trigger clinician_applications_guard;
  update identity.clinician_applications set submitted_at = submitted_at - by_interval,
    expires_at = expires_at - by_interval where id = application;
  alter table identity.clinician_applications enable trigger clinician_applications_guard;
end $$;
-- As the owner: an application in a given state, as the commands would leave it.
create function pg_temp.ca_owner_application(account uuid, facility uuid, state text, submitted timestamptz,
  role_code text default 'doctor') returns uuid language plpgsql as $$
declare
  created uuid := gen_random_uuid();
begin
  insert into identity.clinician_applications (id, account_id, staff_id, facility_id, requested_role, regulator_code,
    issuing_authority, licence_number, licence_valid_until, applicant_full_name, state, submitted_at, expires_at,
    authenticator_ready_at, withdrawn_at, correlation_id, updated_at)
  select created, account, staff_row.id, facility, role_code, case role_code when 'doctor' then 'MDCN' else 'NMCN' end,
    case role_code when 'doctor' then 'Medical and Dental Council of Nigeria'
      else 'Nursing and Midwifery Council of Nigeria' end,
    'OWNER/' || upper(substr(md5(created::text), 1, 6)), (submitted at time zone 'Africa/Lagos')::date + 400,
    staff_row.full_name, state, submitted, submitted + interval '30 days',
    case when state in ('submitted', 'under_review') then submitted end,
    case when state = 'withdrawn' then submitted + interval '1 minute' end,
    'clinician-suite-owner', submitted
  from identity.staff staff_row where staff_row.account_id = account;
  return created;
end $$;
grant execute on function pg_temp.ca_h(text), pg_temp.ca_system(text), pg_temp.ca_as(text),
  pg_temp.ca_refused(text, text), pg_temp.ca_refused_with(text, text, text), pg_temp.ca_draft(text, text),
  pg_temp.ca_submit(text, text, text, text, text, text, date, uuid, integer), pg_temp.ca_account(text),
  pg_temp.ca_application(text, uuid) to public;

create temporary table ca_dates on commit drop as
select (clock_timestamp() at time zone 'Africa/Lagos')::date + 400 as licence_400,
  (clock_timestamp() at time zone 'Africa/Lagos')::date + 1461 as licence_4y;
grant select on ca_dates to public;

-- 1. Privileges.
do $$
declare
  signature text;
  runtime text;
begin
  foreach signature in array array[
    'identity.clinician_signup_open()',
    'platform.consume_clinician_application_quota(character,text,integer,integer,integer)',
    'identity.begin_clinician_application_challenge(text,uuid,character,text,character)',
    'identity.invalidate_clinician_application_challenge(uuid)',
    'identity.verify_clinician_application_signup_code(uuid,character,text,character,character)',
    'identity.verify_clinician_application_status_code(uuid,character,character,character)',
    'identity.clinician_application_session(character)',
    'identity.clinician_application_submit_probe(character,character,text,character)',
    'identity.search_clinician_application_facilities(character,text)',
    'identity.submit_clinician_application(character,character,text,character,text,character,text,text,text,text,text,date,uuid,integer)',
    'identity.bind_clinician_application_mfa_challenge(character,uuid)',
    'identity.clinician_application_authenticator_ready(character,uuid,text)',
    'identity.current_clinician_applications(character)',
    'identity.withdraw_clinician_application(character,uuid,bigint)',
    'identity.file_clinician_application(character,text,character,text,text,text,date,uuid,integer)',
    'identity.end_clinician_application_session(character)',
    'identity.expire_clinician_applications(integer)',
    'identity.prune_clinician_application_artifacts()'] loop
    if not has_function_privilege('hid_identity_api_runtime', signature, 'EXECUTE')
       or not has_function_privilege('hid_schema_test_runtime', signature, 'EXECUTE')
       or has_function_privilege('public', signature, 'EXECUTE')
       or has_function_privilege('hid_ehr_api_runtime', signature, 'EXECUTE') then
      raise exception 'clinician application command privileges are inconsistent for %', signature;
    end if;
  end loop;
  foreach signature in array array[
    'identity.admin_list_clinician_applications(text,timestamptz,uuid,integer)',
    'identity.admin_get_clinician_application(uuid)',
    'identity.admin_clinician_application_attest_precheck(uuid,bigint)',
    'identity.admin_clinician_application_prior(text,text,character)',
    'identity.admin_attest_clinician_application(uuid,bigint,timestamptz,text,jsonb,uuid,text,text,character)',
    'identity.admin_approve_clinician_application(uuid,bigint,text,text,character)',
    'identity.admin_reject_clinician_application(uuid,bigint,text,text,text,character)'] loop
    if not has_function_privilege('hid_identity_api_runtime', signature, 'EXECUTE')
       or has_function_privilege('hid_schema_test_runtime', signature, 'EXECUTE')
       or has_function_privilege('public', signature, 'EXECUTE')
       or has_function_privilege('hid_ehr_api_runtime', signature, 'EXECUTE') then
      raise exception 'clinician application administration privileges are inconsistent for %', signature;
    end if;
  end loop;
  foreach signature in array array[
    'identity.workforce_change_role(uuid,uuid,bigint,text,text,text,text,character,uuid)',
    'identity.workforce_attestation_usable(uuid,uuid,uuid,uuid)', 'identity.clinician_licence_key(text,text)',
    'identity.guard_clinician_application_change()', 'identity.clinician_application_view(identity.clinician_applications)',
    'identity.clinician_intake_require_open()', 'identity.clinician_application_require_not_maintenance()',
    'identity.clinician_application_require_system()', 'identity.clinician_application_audit(text,text,text,text,jsonb)',
    'identity.clinician_application_account_session(character,text[],text,boolean)'] loop
    foreach runtime in array array['public', 'hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_schema_test_runtime',
        'hid_outreach_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime', 'hid_ocr_api_runtime'] loop
      if has_function_privilege(runtime, signature, 'EXECUTE') then
        raise exception '% can execute the internal %', runtime, signature;
      end if;
    end loop;
  end loop;
  if exists (
    select 1 from unnest(array['identity.clinician_applications', 'identity.clinician_application_challenges',
        'identity.clinician_application_sessions', 'identity.clinician_application_idempotency',
        'platform.clinician_application_quota_counters']) relation(name),
      unnest(array['public', 'hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_schema_test_runtime',
        'hid_outreach_api_runtime', 'hid_notification_api_runtime']) runtime(name),
      unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege(name)
    where has_table_privilege(runtime.name, relation.name, privilege.name)) then
    raise exception 'a runtime role can reach a clinician application table directly';
  end if;
  if (select count(*) from pg_class relation
       where relation.oid in ('identity.clinician_applications'::regclass, 'identity.clinician_application_challenges'::regclass,
         'identity.clinician_application_sessions'::regclass, 'identity.clinician_application_idempotency'::regclass)
         and relation.relrowsecurity) <> 4
     or not (select relrowsecurity and relforcerowsecurity from pg_class
              where oid = 'platform.clinician_application_quota_counters'::regclass) then
    raise exception 'row-level security is not enabled as 0094 requires';
  end if;
  if not exists (select 1 from auth.role_permissions where role_code = 'platform_super_admin'
      and permission_code = 'platform.workforce.manage')
     or exists (select 1 from auth.role_permissions where permission_code = 'platform.workforce.manage'
      and role_code <> 'platform_super_admin') then
    raise exception 'platform.workforce.manage must be held by platform_super_admin only';
  end if;
  if not has_function_privilege('public', 'platform.control_enabled(text)', 'EXECUTE')
     or (exists (select 1 from pg_roles where rolname = 'hid_platform_control_reader')
       and (select proowner::regrole::text from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure)
         <> 'hid_platform_control_reader') then
    raise exception 'platform.control_enabled lost its technical owner or its PUBLIC execute grant';
  end if;
  -- Every 0094 definer has a fixed search path and no other setting.
  if exists (select 1 from pg_proc proc join pg_namespace namespace_row on namespace_row.oid = proc.pronamespace
              where (proc.proname like '%clinician%' or proc.proname in ('workforce_change_role', 'workforce_attestation_usable'))
                and proc.prosecdef
                and proc.proconfig is distinct from array['search_path=pg_catalog, identity, auth, platform, audit, pg_temp']
                and proc.proname <> 'workforce_change_role') then
    raise exception 'a clinician application definer does not carry the fixed search path alone';
  end if;
end $$;

-- 2. The control and the intake gate.
do $$
declare
  control platform.control_settings%rowtype;
  keys integer;
begin
  select * into control from platform.control_settings where control_key = 'clinician_signup_enabled';
  if control.enabled is distinct from false or control.row_version <> 1 or control.updated_by is not null
     or control.reason <> 'Off until an administrator opens clinician self sign-up (0094, ADR-064)' then
    raise exception 'clinician_signup_enabled is not seeded off: %', row_to_json(control);
  end if;
  select count(*) into keys from pg_constraint
   where conrelid = 'platform.control_settings'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%control_key%';
  if keys <> 1 then
    raise exception 'platform.control_settings holds % control key checks instead of one', keys;
  end if;
  begin
    insert into platform.control_settings (control_key, enabled, reason) values ('unknown_control', false, 'Synthetic unknown control');
    raise exception 'an unknown control key was accepted';
  exception when check_violation then null;
  end;
  if not (select relforcerowsecurity from pg_class where oid = 'platform.control_settings'::regclass) then
    raise exception 'platform.control_settings no longer forces row-level security';
  end if;
end $$;

set local role hid_identity_api_runtime;
select pg_temp.ca_system('gate');
do $$
begin
  if identity.clinician_signup_open() then
    raise exception 'clinician sign-up is open before an administrator opens it';
  end if;
end $$;
select pg_temp.ca_refused($c$select identity.begin_clinician_application_challenge('signup', gen_random_uuid(),
  pg_temp.ca_h('email:closed@ca.invalid'), 'closed@ca.invalid', pg_temp.ca_h('code:closed'))$c$,
  'PLATFORM_CONTROL_DISABLED:clinician_signup_enabled');
select pg_temp.ca_refused($c$select identity.verify_clinician_application_signup_code(gen_random_uuid(),
  pg_temp.ca_h('email:closed@ca.invalid'), 'closed@ca.invalid', pg_temp.ca_h('code:closed'), pg_temp.ca_h('session:closed'))$c$,
  'PLATFORM_CONTROL_DISABLED:clinician_signup_enabled');
select pg_temp.ca_refused($c$select pg_temp.ca_submit('closed', 'closed@ca.invalid', 'Closed Applicant', 'doctor', 'MDCN',
  'MDCN/1', (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a')$c$,
  'PLATFORM_CONTROL_DISABLED:clinician_signup_enabled');
select pg_temp.ca_refused($c$select * from identity.file_clinician_application(pg_temp.ca_h('session:closed'),
  'clinician-suite-key-closed', pg_temp.ca_h('sha:closed'), 'doctor', 'MDCN', 'MDCN/1', (select licence_400 from ca_dates),
  'ca110000-0000-4000-8000-00000000000a', 30)$c$, 'PLATFORM_CONTROL_DISABLED:clinician_signup_enabled');
select pg_temp.ca_refused($c$select * from identity.search_clinician_application_facilities(pg_temp.ca_h('session:closed'),
  'suite')$c$, 'PLATFORM_CONTROL_DISABLED:clinician_signup_enabled');
-- The status start is not gated by the control: an unknown address gets a decoy.
do $$
begin
  if identity.begin_clinician_application_challenge('status', 'ca300000-0000-4000-8000-000000000001',
      pg_temp.ca_h('email:nobody@ca.invalid'), 'nobody@ca.invalid', pg_temp.ca_h('code:nobody')) then
    raise exception 'a status start for an unknown address would deliver a code';
  end if;
end $$;
-- A non-system caller is refused.
select pg_temp.ca_as('a');
select pg_temp.ca_refused($c$select identity.clinician_signup_open()$c$, 'CLINICIAN_APPLICATION_PERMISSION_DENIED');
select set_config('app.actor_subject', 'synthetic:ca:a', true), set_config('app.access_scope', '', true);
select pg_temp.ca_refused($c$select identity.begin_clinician_application_challenge('status', gen_random_uuid(),
  pg_temp.ca_h('email:x@ca.invalid'), 'x@ca.invalid', pg_temp.ca_h('code:x'))$c$, 'CLINICIAN_APPLICATION_PERMISSION_DENIED');
select pg_temp.ca_system('gate');
select set_config('app.correlation_id', '', true);
select pg_temp.ca_refused($c$select identity.clinician_signup_open()$c$, 'CLINICIAN_APPLICATION_PERMISSION_DENIED');

-- An administrator opens intake through the audited control command.
select pg_temp.ca_as('a');
do $$
declare
  result record;
begin
  select * into result from platform.admin_set_control('clinician_signup_enabled', true, 1,
    'Clinician suite opens self sign-up');
  if not result.enabled or result.row_version <> 2 or result.replayed then
    raise exception 'admin_set_control did not open clinician sign-up: %', row_to_json(result);
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from platform.control_events where control_key = 'clinician_signup_enabled'
       and actor_account_id = 'ca200000-0000-4000-8000-000000000001' and enabled) <> 1 then
    raise exception 'opening clinician sign-up wrote no control event';
  end if;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.ca_system('gate-open');
do $$ begin
  if not identity.clinician_signup_open() then raise exception 'clinician sign-up did not open'; end if;
end $$;
-- provider_portal_enabled off and maintenance_mode on close intake too.
select pg_temp.ca_as('a');
select * from platform.admin_set_control('provider_portal_enabled', false,
  (select row_version from platform.admin_list_controls() where control_key = 'provider_portal_enabled'),
  'Clinician suite closes the provider portal');
select pg_temp.ca_system('gate-portal');
select pg_temp.ca_refused($c$select identity.begin_clinician_application_challenge('signup', gen_random_uuid(),
  pg_temp.ca_h('email:portal@ca.invalid'), 'portal@ca.invalid', pg_temp.ca_h('code:portal'))$c$,
  'PLATFORM_CONTROL_DISABLED:provider_portal_enabled');
do $$ begin
  if identity.clinician_signup_open() then raise exception 'intake is open while the provider portal is off'; end if;
end $$;
select pg_temp.ca_as('a');
select * from platform.admin_set_control('provider_portal_enabled', true,
  (select row_version from platform.admin_list_controls() where control_key = 'provider_portal_enabled'),
  'Clinician suite reopens the provider portal');
select * from platform.admin_set_control('maintenance_mode', true,
  (select row_version from platform.admin_list_controls() where control_key = 'maintenance_mode'),
  'Clinician suite starts maintenance');
select pg_temp.ca_system('gate-maintenance');
select pg_temp.ca_refused($c$select identity.begin_clinician_application_challenge('signup', gen_random_uuid(),
  pg_temp.ca_h('email:maint@ca.invalid'), 'maint@ca.invalid', pg_temp.ca_h('code:maint'))$c$, 'PLATFORM_MAINTENANCE');
select pg_temp.ca_refused($c$select identity.begin_clinician_application_challenge('status', gen_random_uuid(),
  pg_temp.ca_h('email:maint@ca.invalid'), 'maint@ca.invalid', pg_temp.ca_h('code:maint'))$c$, 'PLATFORM_MAINTENANCE');
select pg_temp.ca_refused($c$select * from identity.verify_clinician_application_status_code(
  'ca300000-0000-4000-8000-000000000001', pg_temp.ca_h('email:nobody@ca.invalid'), pg_temp.ca_h('code:nobody'),
  pg_temp.ca_h('session:maint'))$c$, 'PLATFORM_MAINTENANCE');
select pg_temp.ca_refused($c$select identity.current_clinician_applications(pg_temp.ca_h('session:maint'))$c$,
  'PLATFORM_MAINTENANCE');
do $$ begin
  if identity.clinician_signup_open() then raise exception 'intake is open in maintenance'; end if;
end $$;
select pg_temp.ca_as('a');
select * from platform.admin_set_control('maintenance_mode', false,
  (select row_version from platform.admin_list_controls() where control_key = 'maintenance_mode'),
  'Clinician suite ends maintenance');

-- 3. Email-code challenges.
select pg_temp.ca_system('challenge');
do $$
declare
  delivered boolean;
  outcome text;
  attempt integer;
begin
  -- A start answers true (deliver) and records only digests.
  delivered := identity.begin_clinician_application_challenge('signup', 'ca300000-0000-4000-8000-000000000011',
    pg_temp.ca_h('email:applicant1@ca.invalid'), 'Applicant1@CA.invalid', pg_temp.ca_h('code:c11'));
  if not delivered then raise exception 'a first sign-up start delivered nothing'; end if;
  -- Within 60 seconds the same address gets nothing (and no row).
  delivered := identity.begin_clinician_application_challenge('signup', 'ca300000-0000-4000-8000-000000000012',
    pg_temp.ca_h('email:applicant1@ca.invalid'), 'applicant1@ca.invalid', pg_temp.ca_h('code:c12'));
  if delivered then raise exception 'the 60-second cooldown did not hold'; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.clinician_application_challenges where id = 'ca300000-0000-4000-8000-000000000012') then
    raise exception 'a start over the cooldown inserted a challenge';
  end if;
  if exists (select 1 from identity.clinician_application_challenges where id = 'ca300000-0000-4000-8000-000000000011'
      and (account_id is not null or email_hmac <> pg_temp.ca_h('email:applicant1@ca.invalid'))) then
    raise exception 'a sign-up challenge holds an account or another digest';
  end if;
end $$;
-- A status challenge of the same digest, and the first one moved two minutes back.
insert into identity.clinician_application_challenges (id, purpose, email_hmac, code_hmac, created_at, expires_at)
values ('ca300000-0000-4000-8000-000000000013', 'status', pg_temp.ca_h('email:applicant1@ca.invalid'),
  pg_temp.ca_h('code:c13'), now(), now() + interval '10 minutes');
update identity.clinician_application_challenges set created_at = created_at - interval '2 minutes',
  expires_at = expires_at - interval '2 minutes' where id = 'ca300000-0000-4000-8000-000000000011';
set local role hid_identity_api_runtime;
select pg_temp.ca_system('challenge-2');
do $$ begin
  if not identity.begin_clinician_application_challenge('signup', 'ca300000-0000-4000-8000-000000000014',
      pg_temp.ca_h('email:applicant1@ca.invalid'), 'applicant1@ca.invalid', pg_temp.ca_h('code:c14')) then
    raise exception 'a start after the cooldown delivered nothing';
  end if;
end $$;
reset role;
do $$ begin
  if (select invalidated_at from identity.clinician_application_challenges where id = 'ca300000-0000-4000-8000-000000000011') is null
     or (select invalidated_at from identity.clinician_application_challenges where id = 'ca300000-0000-4000-8000-000000000013') is not null then
    raise exception 'a new start must invalidate earlier challenges of its own purpose and address only';
  end if;
end $$;
-- Five starts in the hour, or fifteen in the day, and the next one gets nothing.
insert into identity.clinician_application_challenges (id, purpose, email_hmac, code_hmac, created_at, expires_at)
select gen_random_uuid(), 'signup', pg_temp.ca_h('email:hourly@ca.invalid'), pg_temp.ca_h('code:hourly'),
  now() - make_interval(mins => 2 + n * 5), now() - make_interval(mins => 2 + n * 5) + interval '10 minutes'
from generate_series(0, 4) n;
insert into identity.clinician_application_challenges (id, purpose, email_hmac, code_hmac, created_at, expires_at)
select gen_random_uuid(), 'signup', pg_temp.ca_h('email:daily@ca.invalid'), pg_temp.ca_h('code:daily'),
  now() - make_interval(hours => 2 + n), now() - make_interval(hours => 2 + n) + interval '10 minutes'
from generate_series(0, 14) n;
set local role hid_identity_api_runtime;
select pg_temp.ca_system('challenge-3');
do $$ begin
  if identity.begin_clinician_application_challenge('signup', gen_random_uuid(), pg_temp.ca_h('email:hourly@ca.invalid'),
      'hourly@ca.invalid', pg_temp.ca_h('code:hourly-6')) then
    raise exception 'a sixth start within the hour would deliver';
  end if;
  if identity.begin_clinician_application_challenge('signup', gen_random_uuid(), pg_temp.ca_h('email:daily@ca.invalid'),
      'daily@ca.invalid', pg_temp.ca_h('code:daily-16')) then
    raise exception 'a sixteenth start within the day would deliver';
  end if;
end $$;
-- Wrong codes count; the fifth ends the challenge, and the right code no longer works.
do $$
declare
  attempt integer;
begin
  for attempt in 1..4 loop
    if identity.verify_clinician_application_signup_code('ca300000-0000-4000-8000-000000000014',
        pg_temp.ca_h('email:applicant1@ca.invalid'), 'applicant1@ca.invalid', pg_temp.ca_h('code:wrong'),
        pg_temp.ca_h('session:wrong')) <> 'invalid' then
      raise exception 'a wrong code was accepted';
    end if;
  end loop;
  -- A digest mismatch (another address) counts too.
  if identity.verify_clinician_application_signup_code('ca300000-0000-4000-8000-000000000014',
      pg_temp.ca_h('email:other@ca.invalid'), 'other@ca.invalid', pg_temp.ca_h('code:c14'),
      pg_temp.ca_h('session:wrong')) <> 'invalid' then
    raise exception 'a code for another address was accepted';
  end if;
  if identity.verify_clinician_application_signup_code('ca300000-0000-4000-8000-000000000014',
      pg_temp.ca_h('email:applicant1@ca.invalid'), 'applicant1@ca.invalid', pg_temp.ca_h('code:c14'),
      pg_temp.ca_h('session:wrong')) <> 'invalid' then
    raise exception 'the right code worked after five failures';
  end if;
end $$;
reset role;
do $$ begin
  if (select failed_attempts from identity.clinician_application_challenges where id = 'ca300000-0000-4000-8000-000000000014') <> 5
     or (select invalidated_at from identity.clinician_application_challenges where id = 'ca300000-0000-4000-8000-000000000014') is null
     or exists (select 1 from identity.clinician_application_sessions where token_hmac = pg_temp.ca_h('session:wrong')) then
    raise exception 'five failures did not end the challenge, or a failure opened a draft';
  end if;
end $$;
-- Expired, consumed and invalidated challenges are refused.
insert into identity.clinician_application_challenges (id, purpose, email_hmac, code_hmac, created_at, expires_at,
  consumed_at, invalidated_at) values
  ('ca300000-0000-4000-8000-000000000015', 'signup', pg_temp.ca_h('email:expired@ca.invalid'), pg_temp.ca_h('code:c15'),
   now() - interval '11 minutes', now() - interval '1 minute', null, null),
  ('ca300000-0000-4000-8000-000000000016', 'signup', pg_temp.ca_h('email:consumed@ca.invalid'), pg_temp.ca_h('code:c16'),
   now(), now() + interval '10 minutes', now(), null),
  ('ca300000-0000-4000-8000-000000000017', 'signup', pg_temp.ca_h('email:withdrawn@ca.invalid'), pg_temp.ca_h('code:c17'),
   now(), now() + interval '10 minutes', null, null);
set local role hid_identity_api_runtime;
select pg_temp.ca_system('challenge-4');
select identity.invalidate_clinician_application_challenge('ca300000-0000-4000-8000-000000000017');
do $$ begin
  if identity.verify_clinician_application_signup_code('ca300000-0000-4000-8000-000000000015',
       pg_temp.ca_h('email:expired@ca.invalid'), 'expired@ca.invalid', pg_temp.ca_h('code:c15'), pg_temp.ca_h('session:c15')) <> 'invalid'
     or identity.verify_clinician_application_signup_code('ca300000-0000-4000-8000-000000000016',
       pg_temp.ca_h('email:consumed@ca.invalid'), 'consumed@ca.invalid', pg_temp.ca_h('code:c16'), pg_temp.ca_h('session:c16')) <> 'invalid'
     or identity.verify_clinician_application_signup_code('ca300000-0000-4000-8000-000000000017',
       pg_temp.ca_h('email:withdrawn@ca.invalid'), 'withdrawn@ca.invalid', pg_temp.ca_h('code:c17'), pg_temp.ca_h('session:c17')) <> 'invalid'
     or identity.verify_clinician_application_signup_code('ca300000-0000-4000-8000-000000000013',
       pg_temp.ca_h('email:applicant1@ca.invalid'), 'applicant1@ca.invalid', pg_temp.ca_h('code:c13'), pg_temp.ca_h('session:c13')) <> 'invalid' then
    raise exception 'an expired, consumed, withdrawn or status challenge verified a sign-up';
  end if;
end $$;
-- The correct code of an address an account or staff record already uses:
-- email_in_use, the code is used, no draft. A deleted account's address is free.
do $$
declare
  email text;
  challenge uuid;
begin
  foreach email in array array['super-b@ca.invalid', 'staff-held@ca.invalid', 'SUPER-C@ca.INVALID'] loop
    challenge := gen_random_uuid();
    perform identity.begin_clinician_application_challenge('signup', challenge, pg_temp.ca_h('email:' || lower(email)),
      email, pg_temp.ca_h('code:' || email));
    if identity.verify_clinician_application_signup_code(challenge, pg_temp.ca_h('email:' || lower(email)), email,
        pg_temp.ca_h('code:' || email), pg_temp.ca_h('session:' || email)) <> 'email_in_use' then
      raise exception '% was not reported in use after the correct code', email;
    end if;
    perform set_config('ca_suite.in_use_' || md5(email), challenge::text, true);
  end loop;
  perform pg_temp.ca_draft('deleted', 'deleted@ca.invalid');
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.clinician_application_sessions
              where token_hmac in (pg_temp.ca_h('session:super-b@ca.invalid'), pg_temp.ca_h('session:staff-held@ca.invalid'),
                pg_temp.ca_h('session:SUPER-C@ca.INVALID')))
     or exists (select 1 from identity.clinician_application_challenges
                 where email_hmac = pg_temp.ca_h('email:super-b@ca.invalid') and consumed_at is null) then
    raise exception 'an address in use opened a draft or kept its code';
  end if;
  if not exists (select 1 from identity.clinician_application_sessions
                  where token_hmac = pg_temp.ca_h('session:deleted') and kind = 'draft'
                    and expires_at = created_at + interval '60 minutes') then
    raise exception 'a deleted account''s address did not open a 60-minute draft';
  end if;
  if (select count(*) from audit.events where action = 'identity.clinician-application.email-verified'
       and details->>'outcome' = 'email_in_use' and details->>'purpose' = 'signup') <> 3
     or exists (select 1 from audit.events where action like 'identity.clinician-application.%'
                 and (details::text ilike '%@ca.invalid%' or details::text ilike '%super-b%')) then
    raise exception 'email-verified is not audited for each outcome, or an address reached the audit';
  end if;
end $$;

-- 4. Quotas.
set local role hid_identity_api_runtime;
select pg_temp.ca_system('quota');
do $$
declare
  op text;
  digest text;
begin
  foreach op in array array['email_code', 'status_code', 'facility_search', 'submit'] loop
    -- Network hour: the third call within the hour is denied and changes no counter.
    digest := pg_temp.ca_h('network-hour:' || op);
    if not platform.consume_clinician_application_quota(digest, op, 2, 10, 100000)
       or not platform.consume_clinician_application_quota(digest, op, 2, 10, 100000)
       or platform.consume_clinician_application_quota(digest, op, 2, 10, 100000) then
      raise exception 'the network hourly quota of % did not deny the third call', op;
    end if;
  end loop;
end $$;
reset role;
do $$
declare
  op text;
begin
  foreach op in array array['email_code', 'status_code', 'facility_search', 'submit'] loop
    if (select array_agg(counter.attempt_count order by counter.bucket_period)
          from platform.clinician_application_quota_counters counter
         where counter.scope = 'network' and counter.operation = op
           and counter.scope_key = pg_temp.ca_h('network-hour:' || op)) is distinct from array[2, 2] then
      raise exception 'a denied % call changed a counter', op;
    end if;
    -- The network day bucket is full; its hour bucket is not.
    insert into platform.clinician_application_quota_counters (scope, operation, scope_key, bucket_period, bucket_start,
      attempt_count)
    values ('network', op, pg_temp.ca_h('network-day:' || op), 'day', date_trunc('day', statement_timestamp()), 10);
    -- The platform has created three applications today (C8 and C13 count them).
    if op = 'submit' then
      insert into platform.clinician_application_quota_counters as counter (scope, operation, scope_key, bucket_period,
        bucket_start, attempt_count)
      values ('platform', 'submit', 'all', 'day', date_trunc('day', statement_timestamp()), 3)
      on conflict (scope, operation, scope_key, bucket_period, bucket_start) do update set attempt_count = 3;
    end if;
    -- The platform has made this many calls today; one more is allowed.
    perform set_config('ca_suite.platform_' || op, (coalesce((select counter.attempt_count
      from platform.clinician_application_quota_counters counter
      where counter.scope = 'platform' and counter.operation = op and counter.bucket_period = 'day'
        and counter.bucket_start = date_trunc('day', statement_timestamp())), 0) + 1)::text, true);
  end loop;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.ca_system('quota-2');
do $$
declare
  op text;
  platform_limit integer;
begin
  foreach op in array array['email_code', 'status_code', 'facility_search', 'submit'] loop
    if platform.consume_clinician_application_quota(pg_temp.ca_h('network-day:' || op), op, 5, 10, 100000) then
      raise exception 'the network daily quota of % did not deny', op;
    end if;
    platform_limit := current_setting('ca_suite.platform_' || op)::integer;
    if op = 'submit' then
      -- The platform's daily submit cap counts created applications, not
      -- attempts: two attempts under it leave it as it was, and one at it is denied.
      if not platform.consume_clinician_application_quota(pg_temp.ca_h('platform-a:' || op), op, 5, 10, platform_limit)
         or not platform.consume_clinician_application_quota(pg_temp.ca_h('platform-b:' || op), op, 5, 10, platform_limit)
         or platform.consume_clinician_application_quota(pg_temp.ca_h('platform-c:' || op), op, 5, 10, platform_limit - 1) then
        raise exception 'the platform daily submit cap counted an attempt, or did not deny at the cap';
      end if;
    elsif not platform.consume_clinician_application_quota(pg_temp.ca_h('platform-a:' || op), op, 5, 10, platform_limit)
       or platform.consume_clinician_application_quota(pg_temp.ca_h('platform-b:' || op), op, 5, 10, platform_limit) then
      raise exception 'the platform daily quota of % did not deny the call over it', op;
    end if;
  end loop;
end $$;
-- Bounds.
select pg_temp.ca_refused($c$select platform.consume_clinician_application_quota(pg_temp.ca_h('bounds'), 'email_code', 0, 10, 10)$c$,
  'CLINICIAN_APPLICATION_QUOTA_INVALID');
select pg_temp.ca_refused($c$select platform.consume_clinician_application_quota(pg_temp.ca_h('bounds'), 'email_code', 201, 300, 10)$c$,
  'CLINICIAN_APPLICATION_QUOTA_INVALID');
select pg_temp.ca_refused($c$select platform.consume_clinician_application_quota(pg_temp.ca_h('bounds'), 'submit', 5, 4, 10)$c$,
  'CLINICIAN_APPLICATION_QUOTA_INVALID');
select pg_temp.ca_refused($c$select platform.consume_clinician_application_quota(pg_temp.ca_h('bounds'), 'submit', 5, 2001, 10)$c$,
  'CLINICIAN_APPLICATION_QUOTA_INVALID');
select pg_temp.ca_refused($c$select platform.consume_clinician_application_quota(pg_temp.ca_h('bounds'), 'submit', 5, 10, 0)$c$,
  'CLINICIAN_APPLICATION_QUOTA_INVALID');
select pg_temp.ca_refused($c$select platform.consume_clinician_application_quota(pg_temp.ca_h('bounds'), 'facility_search', 1001, 2000, 10)$c$,
  'CLINICIAN_APPLICATION_QUOTA_INVALID');
select pg_temp.ca_refused($c$select platform.consume_clinician_application_quota(pg_temp.ca_h('bounds'), 'login', 5, 10, 10)$c$,
  'CLINICIAN_APPLICATION_QUOTA_INVALID');
select pg_temp.ca_refused($c$select platform.consume_clinician_application_quota('not-a-digest', 'submit', 5, 10, 10)$c$,
  'CLINICIAN_APPLICATION_QUOTA_INVALID');
do $$ begin
  if not platform.consume_clinician_application_quota(pg_temp.ca_h('bounds-search'), 'facility_search', 1000, 5000, 100000) then
    raise exception 'the facility search quota refused its widest bounds';
  end if;
end $$;
select pg_temp.ca_as('a');
select pg_temp.ca_refused($c$select platform.consume_clinician_application_quota(pg_temp.ca_h('bounds'), 'submit', 5, 10, 10)$c$,
  'CLINICIAN_APPLICATION_PERMISSION_DENIED');
reset role;
do $$ begin
  -- Successes and denials of the coded operations are audited; a facility
  -- search only when denied. No row names an address.
  if (select count(*) from audit.events where action = 'identity.clinician-application.quota'
       and correlation_id like 'clinician-suite-quota%' and details->>'operation' = 'email_code') <> 6
     or (select count(*) from audit.events where action = 'identity.clinician-application.quota'
       and correlation_id like 'clinician-suite-quota%' and details->>'operation' = 'facility_search') <> 3
     or (select count(*) from audit.events where action = 'identity.clinician-application.quota'
       and correlation_id like 'clinician-suite-quota%' and details->>'operation' = 'facility_search'
       and outcome = 'success') <> 0
     or (select count(*) from audit.events where action = 'identity.clinician-application.quota'
       and correlation_id like 'clinician-suite-quota%' and outcome = 'denied') <> 12
     or exists (select 1 from audit.events where action = 'identity.clinician-application.quota'
       and details->>'exhaustedLimit' is not null
       and details->>'exhaustedLimit' not in ('network_hour', 'network_day', 'platform_day')) then
    raise exception 'quota audit rows are not as specified';
  end if;
  if (select attempt_count from platform.clinician_application_quota_counters
       where scope = 'platform' and operation = 'submit' and bucket_start = date_trunc('day', statement_timestamp())) <> 3 then
    raise exception 'a submit attempt changed the platform''s count of created applications';
  end if;
end $$;
-- The count of applications the platform created today (as the owner).
create function pg_temp.ca_platform_submits() returns integer language sql as $$
  select coalesce((select attempt_count from platform.clinician_application_quota_counters
    where scope = 'platform' and operation = 'submit' and scope_key = 'all' and bucket_period = 'day'
      and bucket_start = date_trunc('day', statement_timestamp())), 0)
$$;

-- 5. Facility search (a draft; account capabilities in section 9).
set local role hid_identity_api_runtime;
select pg_temp.ca_system('search');
select pg_temp.ca_draft('p1', 'doctor1@ca.invalid');
do $$
declare
  found text[];
begin
  select array_agg(facility_name) into found
    from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p1'), '  SUITE ');
  if (select array_agg(name order by name) from unnest(found) name) is distinct from
       array(select name from unnest(array['Clinician Suite 100% Care_W', 'Clinician Suite Clinic Y',
         'Clinician Suite Hospital X', 'Clinician Suite Unit U']) name order by name)
     or found is distinct from (select array_agg(name order by name) from unnest(found) name) then
    raise exception 'facility search returned %, not the verified and active facilities by name', found;
  end if;
  -- An organization name matches its facilities; an inactive organization's never.
  select array_agg(facility_name order by facility_name) into found
    from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p1'), 'closed organization');
  if found is not null then raise exception 'an inactive organization''s facility was found: %', found; end if;
  select array_agg(facility_name order by facility_name) into found
    from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p1'), 'suite organization');
  if cardinality(found) <> 4 then raise exception 'the organization name did not match its facilities: %', found; end if;
  -- % and _ match literally.
  if exists (select 1 from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p1'), '%%%'))
     or exists (select 1 from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p1'), '___')) then
    raise exception 'a wildcard in the query matched';
  end if;
  select array_agg(facility_name) into found
    from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p1'), '00% care_');
  if found is distinct from array['Clinician Suite 100% Care_W'] then
    raise exception 'a literal %% or _ did not match: %', found;
  end if;
end $$;
select pg_temp.ca_refused($c$select * from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p1'), '  ab ')$c$,
  'CLINICIAN_APPLICATION_INVALID');
select pg_temp.ca_refused($c$select * from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p1'), repeat('a', 81))$c$,
  'CLINICIAN_APPLICATION_INVALID');
select pg_temp.ca_refused($c$select * from identity.search_clinician_application_facilities(pg_temp.ca_h('session:none'), 'suite')$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
reset role;
update identity.clinician_application_sessions set facility_searches = 30 where token_hmac = pg_temp.ca_h('session:p1');
set local role hid_identity_api_runtime;
select pg_temp.ca_refused_with($c$select * from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p1'), 'suite')$c$,
  'P4290', 'CLINICIAN_APPLICATION_SEARCH_BUDGET');
reset role;
update identity.clinician_application_sessions set facility_searches = 6 where token_hmac = pg_temp.ca_h('session:p1');

-- 6. Submit.
select set_config('ca_suite.submits_before', pg_temp.ca_platform_submits()::text, true);
set local role hid_identity_api_runtime;
select pg_temp.ca_system('submit');
-- The submit probe, before Identity charges the quota or hashes the
-- password: 'new' for a live draft of the address; no draft, another
-- address or an account capability is refused as the submission would be.
do $$ begin
  if identity.clinician_application_submit_probe(pg_temp.ca_h('session:p1'), pg_temp.ca_h('email:doctor1@ca.invalid'),
       'clinician-suite-key-p1', pg_temp.ca_h('sha:p1')) <> 'new' then
    raise exception 'the submit probe did not accept a live draft';
  end if;
end $$;
select pg_temp.ca_refused($c$select identity.clinician_application_submit_probe(pg_temp.ca_h('session:none'),
  pg_temp.ca_h('email:doctor1@ca.invalid'), 'clinician-suite-key-p1', pg_temp.ca_h('sha:p1'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
select pg_temp.ca_refused($c$select identity.clinician_application_submit_probe(pg_temp.ca_h('session:p1'),
  pg_temp.ca_h('email:other@ca.invalid'), 'clinician-suite-key-p1', pg_temp.ca_h('sha:p1'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
select pg_temp.ca_refused($c$select identity.clinician_application_submit_probe('not-a-digest',
  pg_temp.ca_h('email:doctor1@ca.invalid'), 'clinician-suite-key-p1', pg_temp.ca_h('sha:p1'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
-- Only doctor with MDCN and nurse with NMCN; an argon2id hash with the
-- Identity parameters; a licence date after today (Lagos) and within five years.
select pg_temp.ca_refused(format($c$select pg_temp.ca_submit('p1', 'doctor1@ca.invalid', 'Doctor One', %L, %L, 'MDCN/12345',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a')$c$, pair[1], pair[2]),
  'CLINICIAN_APPLICATION_INVALID')
from (values (array['doctor', 'NMCN']), (array['nurse', 'MDCN']), (array['clinician', 'MDCN']), (array['doctor', 'OTHER']),
  (array['clinician', 'OTHER'])) pairs(pair);
select pg_temp.ca_refused(format($c$select * from identity.submit_clinician_application(pg_temp.ca_h('session:p1'),
  pg_temp.ca_h('session:p1-account'), 'clinician-suite-key-p1', pg_temp.ca_h('sha:p1'), 'doctor1@ca.invalid',
  pg_temp.ca_h('email:doctor1@ca.invalid'), 'Doctor One', %L, 'doctor', 'MDCN', 'MDCN/12345',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a', 30)$c$, hash), 'CLINICIAN_APPLICATION_INVALID')
from unnest(array['Synthetic-Plaintext-Password-1', '$2b$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz012',
  '$argon2id$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA', '$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA']) hash;
select pg_temp.ca_refused(format($c$select pg_temp.ca_submit('p1', 'doctor1@ca.invalid', 'Doctor One', 'doctor', 'MDCN',
  'MDCN/12345', %L::date, 'ca110000-0000-4000-8000-00000000000a')$c$, licence_date), 'CLINICIAN_APPLICATION_INVALID')
from unnest(array[(clock_timestamp() at time zone 'Africa/Lagos')::date,
  ((clock_timestamp() at time zone 'Africa/Lagos')::date + interval '5 years' + interval '1 day')::date]) licence_date;
select pg_temp.ca_refused($c$select pg_temp.ca_submit('p1', 'doctor1@ca.invalid', 'Doctor One', 'doctor', 'MDCN', 'M',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a')$c$, 'CLINICIAN_APPLICATION_INVALID');
select pg_temp.ca_refused($c$select pg_temp.ca_submit('p1', 'doctor1@ca.invalid', 'Doctor One', 'doctor', 'MDCN', 'MDCN',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a')$c$, 'CLINICIAN_APPLICATION_INVALID');
select pg_temp.ca_refused($c$select pg_temp.ca_submit('p1', 'doctor1@ca.invalid', 'Doctor One', 'doctor', 'MDCN', 'MDCN/12345',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a', 0)$c$, 'CLINICIAN_APPLICATION_INVALID');
-- A facility that is not verified and active in an active organization.
select pg_temp.ca_refused(format($c$select pg_temp.ca_submit('p1', 'doctor1@ca.invalid', 'Doctor One', 'doctor', 'MDCN',
  'MDCN/12345', (select licence_400 from ca_dates), %L)$c$, facility), 'CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE')
from unnest(array['ca110000-0000-4000-8000-00000000000c', 'ca110000-0000-4000-8000-00000000000e',
  'ca110000-0000-4000-8000-0000000000ff']) facility;
-- Another address than the draft's.
select pg_temp.ca_refused($c$select pg_temp.ca_submit('p1', 'other@ca.invalid', 'Doctor One', 'doctor', 'MDCN', 'MDCN/12345',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a')$c$, 'CLINICIAN_APPLICATION_SESSION_INVALID');
do $$
declare
  created uuid;
begin
  created := pg_temp.ca_submit('p1', 'doctor1@ca.invalid', '  Doctor   One ', 'doctor', 'MDCN', 'mdcn/12345',
    (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a');
  perform set_config('ca_suite.p1_application', created::text, true);
end $$;
reset role;
-- The refused submissions above did not count against the platform's cap; the one created did.
do $$ begin
  if pg_temp.ca_platform_submits() <> current_setting('ca_suite.submits_before')::integer + 1 then
    raise exception 'the platform counted % created applications, not one', pg_temp.ca_platform_submits()
      - current_setting('ca_suite.submits_before')::integer;
  end if;
end $$;
do $$
declare
  account_row auth.accounts%rowtype;
  staff_row identity.staff%rowtype;
  application identity.clinician_applications%rowtype;
  audit_row audit.events%rowtype;
begin
  select * into application from identity.clinician_applications
   where id = current_setting('ca_suite.p1_application')::uuid;
  select * into account_row from auth.accounts where id = application.account_id;
  select * into staff_row from identity.staff where id = application.staff_id;
  if account_row.status <> 'active' or account_row.email <> 'doctor1@ca.invalid' or account_row.display_name <> 'Doctor One'
     or account_row.subject <> 'workforce:' || account_row.id or account_row.password_algorithm <> 'argon2id'
     or account_row.password_hash not like '$argon2id$v=19$m=65536,t=3,p=1$%' or account_row.email_verified_at is null
     or account_row.password_changed_at <> application.submitted_at then
    raise exception 'the submission did not create the expected account: %', row_to_json(account_row);
  end if;
  if staff_row.verification_status <> 'pending' or staff_row.license_number <> 'MDCN/12345' or not staff_row.active
     or staff_row.default_role <> 'staff' or staff_row.full_name <> 'Doctor One' or staff_row.email <> 'doctor1@ca.invalid' then
    raise exception 'the submission did not create a pending staff record: %', row_to_json(staff_row);
  end if;
  if application.state <> 'awaiting_authenticator' or application.expires_at - application.submitted_at <> interval '30 days'
     or application.licence_number <> 'MDCN/12345' or application.licence_key <> 'MDCN:12345'
     or application.issuing_authority <> 'Medical and Dental Council of Nigeria' or application.requested_role <> 'doctor'
     or application.applicant_full_name <> 'Doctor One' or application.row_version <> 1 then
    raise exception 'the application is not as submitted: %', row_to_json(application);
  end if;
  if exists (select 1 from identity.staff_facility_memberships where account_id = account_row.id)
     or exists (select 1 from auth.account_roles where account_id = account_row.id)
     or exists (select 1 from auth.sessions where account_id = account_row.id) then
    raise exception 'a submission granted a membership, a role or a session';
  end if;
  if not exists (select 1 from identity.clinician_application_sessions where token_hmac = pg_temp.ca_h('session:p1')
                   and consumed_at is not null and submit_idempotency_key = 'clinician-suite-key-p1')
     or not exists (select 1 from identity.clinician_application_sessions
                     where token_hmac = pg_temp.ca_h('session:p1-account') and kind = 'account'
                       and account_id = account_row.id and stage = 'enrolment_required'
                       and expires_at = created_at + interval '30 minutes') then
    raise exception 'the draft was not consumed, or no enrolment capability was opened';
  end if;
  select * into audit_row from audit.events where action = 'identity.clinician-application.submitted'
     and resource_id = application.id::text;
  if audit_row.actor_type <> 'system' or audit_row.outcome <> 'success'
     or (select array_agg(key order by key) from jsonb_object_keys(audit_row.details) key)
       <> array['accountId', 'additional', 'applicationId', 'facilityId', 'initialState', 'regulatorCode', 'requestedRole']
     or audit_row.details->>'initialState' <> 'awaiting_authenticator' or (audit_row.details->>'additional')::boolean then
    raise exception 'the submission audit is not as specified: %', row_to_json(audit_row);
  end if;
  if exists (select 1 from audit.events where action like 'identity.clinician-application.%'
              and (details::text ilike '%doctor1%' or details::text ilike '%Doctor One%' or details::text like '%MDCN/%'
                or details::text like '%MDCN:%')) then
    raise exception 'an address, name or licence reached an audit row';
  end if;
end $$;
-- The table refuses an unmatched profession and regulator on any write.
do $$ begin
  begin
    insert into identity.clinician_applications (id, account_id, staff_id, facility_id, requested_role, regulator_code,
      issuing_authority, licence_number, licence_valid_until, applicant_full_name, state, submitted_at, expires_at,
      correlation_id, updated_at)
    select gen_random_uuid(), account_id, staff_id, facility_id, 'doctor', 'NMCN', issuing_authority, licence_number,
      licence_valid_until, applicant_full_name, 'awaiting_authenticator', now(), now() + interval '30 days',
      'clinician-suite-owner', now()
    from identity.clinician_applications where id = current_setting('ca_suite.p1_application')::uuid;
    raise exception 'doctor with NMCN was stored';
  exception when check_violation then
    if position('clinician_applications_role_regulator_check' in sqlerrm) = 0 then raise; end if;
  end;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.ca_system('submit-replay');
do $$
declare
  replay record;
begin
  -- A replay with the same key and request while the draft is unexpired.
  select * into replay from identity.submit_clinician_application(pg_temp.ca_h('session:p1'),
    pg_temp.ca_h('session:p1-replay'), 'clinician-suite-key-p1', pg_temp.ca_h('sha:p1'), 'doctor1@ca.invalid',
    pg_temp.ca_h('email:doctor1@ca.invalid'), 'Doctor One',
    '$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljaGFzaA', 'doctor', 'MDCN', 'MDCN/12345',
    (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a', 30);
  if not replay.replayed or replay.application_id <> current_setting('ca_suite.p1_application')::uuid
     or replay.session_stage <> 'enrolment_required' or replay.state <> 'awaiting_authenticator' then
    raise exception 'a submission replay was not answered with the same application: %', row_to_json(replay);
  end if;
  -- The spent draft: the same key and request probe as a replay; any other is refused.
  if identity.clinician_application_submit_probe(pg_temp.ca_h('session:p1'), pg_temp.ca_h('email:doctor1@ca.invalid'),
       'clinician-suite-key-p1', pg_temp.ca_h('sha:p1')) <> 'replay' then
    raise exception 'the submit probe did not recognise a replay';
  end if;
end $$;
select pg_temp.ca_refused($c$select identity.clinician_application_submit_probe(pg_temp.ca_h('session:p1'),
  pg_temp.ca_h('email:doctor1@ca.invalid'), 'clinician-suite-key-p1-other', pg_temp.ca_h('sha:p1'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
select pg_temp.ca_refused($c$select identity.clinician_application_submit_probe(pg_temp.ca_h('session:p1'),
  pg_temp.ca_h('email:doctor1@ca.invalid'), 'clinician-suite-key-p1', pg_temp.ca_h('sha:p1-other'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
select pg_temp.ca_refused($c$select identity.clinician_application_submit_probe(pg_temp.ca_h('session:p1-account'),
  pg_temp.ca_h('email:doctor1@ca.invalid'), 'clinician-suite-key-p1', pg_temp.ca_h('sha:p1'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
select pg_temp.ca_refused($c$select * from identity.submit_clinician_application(pg_temp.ca_h('session:p1'),
  pg_temp.ca_h('session:p1-other'), 'clinician-suite-key-p1', pg_temp.ca_h('sha:p1-other'), 'doctor1@ca.invalid',
  pg_temp.ca_h('email:doctor1@ca.invalid'), 'Doctor One',
  '$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljaGFzaA', 'doctor', 'MDCN', 'MDCN/12345',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a', 30)$c$, 'CLINICIAN_APPLICATION_SESSION_INVALID');
select pg_temp.ca_refused($c$select * from identity.submit_clinician_application(pg_temp.ca_h('session:p1'),
  pg_temp.ca_h('session:p1-other'), 'clinician-suite-key-p1-other', pg_temp.ca_h('sha:p1'), 'doctor1@ca.invalid',
  pg_temp.ca_h('email:doctor1@ca.invalid'), 'Doctor One',
  '$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljaGFzaA', 'doctor', 'MDCN', 'MDCN/12345',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a', 30)$c$, 'CLINICIAN_APPLICATION_SESSION_INVALID');
reset role;
do $$ begin
  if not exists (select 1 from identity.clinician_application_sessions where token_hmac = pg_temp.ca_h('session:p1-replay')
      and kind = 'account' and stage = 'enrolment_required')
     or exists (select 1 from identity.clinician_application_sessions where token_hmac = pg_temp.ca_h('session:p1-other'))
     or (select count(*) from identity.clinician_applications where account_id = pg_temp.ca_account('doctor1@ca.invalid')) <> 1 then
    raise exception 'a replay did not open exactly one fresh capability, or created another application';
  end if;
end $$;
update identity.clinician_application_sessions set created_at = created_at - interval '61 minutes',
  expires_at = expires_at - interval '61 minutes' where token_hmac = pg_temp.ca_h('session:p1');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('submit-late');
select pg_temp.ca_refused($c$select identity.clinician_application_submit_probe(pg_temp.ca_h('session:p1'),
  pg_temp.ca_h('email:doctor1@ca.invalid'), 'clinician-suite-key-p1', pg_temp.ca_h('sha:p1'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
select pg_temp.ca_refused($c$select * from identity.submit_clinician_application(pg_temp.ca_h('session:p1'),
  pg_temp.ca_h('session:p1-late'), 'clinician-suite-key-p1', pg_temp.ca_h('sha:p1'), 'doctor1@ca.invalid',
  pg_temp.ca_h('email:doctor1@ca.invalid'), 'Doctor One',
  '$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljaGFzaA', 'doctor', 'MDCN', 'MDCN/12345',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a', 30)$c$, 'CLINICIAN_APPLICATION_SESSION_INVALID');
-- An address taken between its verification and the submission; a full facility.
select pg_temp.ca_draft('race', 'race@ca.invalid');
select pg_temp.ca_draft('busy', 'busy@ca.invalid');
reset role;
insert into auth.accounts (id, subject, email, status) values
  ('ca200000-0000-4000-8000-000000000099', 'synthetic:ca:race', 'RACE@ca.invalid', 'active');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('submit-race');
select pg_temp.ca_refused($c$select pg_temp.ca_submit('race', 'race@ca.invalid', 'Race Applicant', 'doctor', 'MDCN', 'MDCN/7001',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a')$c$, 'CLINICIAN_EMAIL_IN_USE');
select pg_temp.ca_refused($c$select pg_temp.ca_submit('busy', 'busy@ca.invalid', 'Busy Applicant', 'doctor', 'MDCN', 'MDCN/7002',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a', 1)$c$, 'CLINICIAN_APPLICATION_FACILITY_BUSY');
-- More applicants: P2 a nurse at Y; P3 a doctor at W; P4 at U; P5 'mdcn 12345' at Y.
do $$ begin
  perform pg_temp.ca_draft('p2', 'nurse2@ca.invalid');
  perform pg_temp.ca_submit('p2', 'nurse2@ca.invalid', 'Nurse Two', 'nurse', 'NMCN', 'NMCN 777',
    (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000b');
  perform pg_temp.ca_draft('p3', 'doctor3@ca.invalid');
  perform pg_temp.ca_submit('p3', 'doctor3@ca.invalid', 'Doctor Three', 'doctor', 'MDCN', 'MDCN-333',
    (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000d');
  perform pg_temp.ca_draft('p4', 'doctor4@ca.invalid');
  perform pg_temp.ca_submit('p4', 'doctor4@ca.invalid', 'Doctor Four', 'doctor', 'MDCN', 'MDCN 4004',
    (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000f');
  perform pg_temp.ca_draft('p5', 'doctor5@ca.invalid');
  perform pg_temp.ca_submit('p5', 'doctor5@ca.invalid', 'Doctor Five', 'doctor', 'MDCN', 'mdcn 12345',
    (select licence_4y from ca_dates), 'ca110000-0000-4000-8000-00000000000b');
end $$;
reset role;
do $$ begin
  if (pg_temp.ca_application('doctor5@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).licence_key <> 'MDCN:12345'
     or (pg_temp.ca_application('doctor5@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).licence_number <> 'MDCN 12345'
     or (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).licence_key <> 'NMCN:777'
     or identity.clinician_licence_key('MDCN', '12345') <> 'MDCN:12345' then
    raise exception 'the canonical licence key is not as specified';
  end if;
  -- P1 to P5 created; the replay, the late replay and the refusals did not count.
  if pg_temp.ca_platform_submits() <> current_setting('ca_suite.submits_before')::integer + 5 then
    raise exception 'the platform counted % created applications, not five', pg_temp.ca_platform_submits()
      - current_setting('ca_suite.submits_before')::integer;
  end if;
end $$;

-- 7. Authenticator ready (C9, C10).
insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
  expires_at, max_attempts, session_kind)
values
  ('ca400000-0000-4000-8000-000000000001', pg_temp.ca_account('doctor1@ca.invalid'), 'enroll', pg_temp.ca_h('mfa:p1'), 1,
   now(), now() + interval '10 minutes', 5, 'staff'),
  ('ca400000-0000-4000-8000-000000000002', pg_temp.ca_account('nurse2@ca.invalid'), 'enroll', pg_temp.ca_h('mfa:p2'), 1,
   now(), now() + interval '10 minutes', 5, 'staff');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('ready');
select pg_temp.ca_refused($c$select identity.bind_clinician_application_mfa_challenge(pg_temp.ca_h('session:p1-account'),
  'ca400000-0000-4000-8000-000000000002')$c$, 'CLINICIAN_APPLICATION_PERMISSION_DENIED');
select identity.bind_clinician_application_mfa_challenge(pg_temp.ca_h('session:p1-account'),
  'ca400000-0000-4000-8000-000000000001');
do $$
declare
  capability record;
begin
  select * into capability from identity.clinician_application_session(pg_temp.ca_h('session:p1-account'));
  if capability.kind <> 'account' or capability.stage <> 'enrolment_required'
     or capability.mfa_challenge_id <> 'ca400000-0000-4000-8000-000000000001'
     or capability.account_id <> pg_temp.ca_account('doctor1@ca.invalid') then
    raise exception 'the capability does not drive its own enrolment challenge: %', row_to_json(capability);
  end if;
end $$;
select pg_temp.ca_refused($c$select * from identity.clinician_application_session(pg_temp.ca_h('session:p1'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
reset role;
-- Factors C10 must refuse: another account's, a pending one, one platform
-- sign-in enrolled (no staff proof), and a proven one not used in this transaction.
select pg_temp.ca_proven_factor(pg_temp.ca_account('nurse2@ca.invalid'), 'ca240000-0000-4000-8000-0000000000f2');
insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, enrollment_expires_at)
values ('ca240000-0000-4000-8000-0000000000e1', pg_temp.ca_account('doctor1@ca.invalid'), 'pending', gen_random_bytes(49),
  'suite-v1', clock_timestamp() + interval '5 minutes');
insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, activated_at, last_used_step,
  last_used_at)
values ('ca240000-0000-4000-8000-0000000000e2', pg_temp.ca_account('doctor1@ca.invalid'), 'active', gen_random_bytes(49),
  'suite-v1', clock_timestamp(), 1, clock_timestamp());
set local role hid_identity_api_runtime;
select pg_temp.ca_system('ready-refused');
select pg_temp.ca_refused(format($c$select identity.clinician_application_authenticator_ready(
  pg_temp.ca_h('session:p1-account'), %L, %L)$c$, factor, method), 'CLINICIAN_APPLICATION_PERMISSION_DENIED')
from (values ('ca240000-0000-4000-8000-0000000000f2', 'enrolment'), ('ca240000-0000-4000-8000-0000000000e1', 'enrolment'),
  ('ca240000-0000-4000-8000-0000000000e2', 'enrolment'), ('ca240000-0000-4000-8000-0000000000e2', 'totp')) refused(factor, method);
select pg_temp.ca_refused($c$select identity.clinician_application_authenticator_ready(pg_temp.ca_h('session:p1-account'),
  'ca240000-0000-4000-8000-0000000000e2', 'password')$c$, 'CLINICIAN_APPLICATION_INVALID');
reset role;
update auth.mfa_factors set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = 'ca200000-0000-4000-8000-000000000001',
  revocation_reason = 'admin_reset', row_version = row_version + 1
 where id in ('ca240000-0000-4000-8000-0000000000e1', 'ca240000-0000-4000-8000-0000000000e2');
select pg_temp.ca_proven_factor(pg_temp.ca_account('doctor1@ca.invalid'), 'ca240000-0000-4000-8000-0000000000f1');
update auth.mfa_factors set last_used_at = now() - interval '1 minute', activated_at = activated_at
 where id = 'ca240000-0000-4000-8000-0000000000f1';
set local role hid_identity_api_runtime;
select pg_temp.ca_system('ready-stale');
select pg_temp.ca_refused($c$select identity.clinician_application_authenticator_ready(pg_temp.ca_h('session:p1-account'),
  'ca240000-0000-4000-8000-0000000000f1', 'totp')$c$, 'CLINICIAN_APPLICATION_PERMISSION_DENIED');
reset role;
update auth.mfa_factors set last_used_at = clock_timestamp() where id = 'ca240000-0000-4000-8000-0000000000f1';
-- P3's application is overdue before its authenticator is ready.
select pg_temp.ca_age((pg_temp.ca_application('doctor3@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id,
  interval '31 days');
select pg_temp.ca_proven_factor(pg_temp.ca_account('doctor3@ca.invalid'), 'ca240000-0000-4000-8000-0000000000f3');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('ready-ok');
do $$
declare
  view jsonb;
begin
  view := identity.clinician_application_authenticator_ready(pg_temp.ca_h('session:p1-account'),
    'ca240000-0000-4000-8000-0000000000f1', 'enrolment');
  if view->>'stage' <> 'ready' or jsonb_array_length(view->'applications') <> 1
     or view->'applications'->0->>'state' <> 'submitted' or view->'applications'->0->>'licenceNumberHint' <> '2345'
     or (view->'applications'->0->>'version')::integer <> 2 or not (view->>'canApply')::boolean
     or view->'account'->>'fullName' <> 'Doctor One' or view->'account'->>'email' <> 'doctor1@ca.invalid' then
    raise exception 'authenticator ready did not submit the application: %', view;
  end if;
  view := identity.clinician_application_authenticator_ready(pg_temp.ca_h('session:p3-account'),
    'ca240000-0000-4000-8000-0000000000f3', 'enrolment');
  if view->'applications'->0->>'state' <> 'expired' or (view->'applications'->0->>'canWithdraw')::boolean then
    raise exception 'an overdue application was submitted for review: %', view;
  end if;
end $$;
select pg_temp.ca_refused($c$select identity.clinician_application_authenticator_ready(pg_temp.ca_h('session:p1-account'),
  'ca240000-0000-4000-8000-0000000000f1', 'enrolment')$c$, 'CLINICIAN_APPLICATION_SESSION_INVALID');
-- A live capability that is already ready is not an ended one: binding a
-- challenge to it (a second tab re-opening the step it just finished) is its
-- own refusal, never the 401 marker.
select pg_temp.ca_refused($c$select identity.bind_clinician_application_mfa_challenge(pg_temp.ca_h('session:p1-account'),
  'ca400000-0000-4000-8000-000000000001')$c$, 'CLINICIAN_APPLICATION_AUTHENTICATOR_READY');
reset role;
do $$ begin
  if (pg_temp.ca_application('doctor3@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).state <> 'awaiting_authenticator'
     or (pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).authenticator_ready_at is null
     or (select count(*) from audit.events where action = 'identity.clinician-application.authenticator-ready'
          and details->>'factorId' = 'ca240000-0000-4000-8000-0000000000f1') <> 1
     or exists (select 1 from audit.events where action = 'identity.clinician-application.authenticator.verified'
          and correlation_id = 'clinician-suite-ready-ok') then
    raise exception 'authenticator ready moved the wrong applications or audited them wrongly';
  end if;
end $$;

-- 8. Status access.
select pg_temp.ca_proven_factor(pg_temp.ca_account('doctor5@ca.invalid'), 'ca240000-0000-4000-8000-0000000000f5');
update auth.accounts set disabled_until = clock_timestamp() + interval '1 day' where email = 'doctor4@ca.invalid';
set local role hid_identity_api_runtime;
select pg_temp.ca_system('status');
do $$
declare
  email text;
  outcome record;
begin
  if not identity.begin_clinician_application_challenge('status', 'ca300000-0000-4000-8000-000000000021',
      pg_temp.ca_h('email:doctor1@ca.invalid'), 'DOCTOR1@ca.invalid', pg_temp.ca_h('code:s21')) then
    raise exception 'an applicant''s status start delivered nothing';
  end if;
  if not identity.begin_clinician_application_challenge('status', 'ca300000-0000-4000-8000-000000000022',
      pg_temp.ca_h('email:nurse2@ca.invalid'), 'nurse2@ca.invalid', pg_temp.ca_h('code:s22'))
     or not identity.begin_clinician_application_challenge('status', 'ca300000-0000-4000-8000-000000000025',
      pg_temp.ca_h('email:doctor5@ca.invalid'), 'doctor5@ca.invalid', pg_temp.ca_h('code:s25')) then
    raise exception 'an applicant''s status start delivered nothing';
  end if;
  -- A patient, a Super Admin, an account without an application, a disabled
  -- applicant and an unknown address: a decoy, nothing delivered.
  foreach email in array array['patient@ca.invalid', 'super-a@ca.invalid', 'account09@ca.invalid', 'doctor4@ca.invalid',
      'unknown@ca.invalid'] loop
    if identity.begin_clinician_application_challenge('status', gen_random_uuid(), pg_temp.ca_h('email:' || email),
        email, pg_temp.ca_h('code:decoy-' || email)) then
      raise exception 'a status start for % would deliver a code', email;
    end if;
  end loop;
  -- An unknown challenge never verifies.
  select * into outcome from identity.verify_clinician_application_status_code(
    gen_random_uuid(), pg_temp.ca_h('email:x'), pg_temp.ca_h('x'),
    pg_temp.ca_h('session:x'));
  if outcome.outcome <> 'invalid' then raise exception 'a missing challenge verified'; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from identity.clinician_application_challenges where purpose = 'status' and account_id is null
       and email_hmac in (pg_temp.ca_h('email:patient@ca.invalid'), pg_temp.ca_h('email:super-a@ca.invalid'),
         pg_temp.ca_h('email:account09@ca.invalid'), pg_temp.ca_h('email:doctor4@ca.invalid'),
         pg_temp.ca_h('email:unknown@ca.invalid'))) <> 5
     or (select account_id from identity.clinician_application_challenges where id = 'ca300000-0000-4000-8000-000000000021')
       <> pg_temp.ca_account('doctor1@ca.invalid') then
    raise exception 'status challenges were not recorded as decoys and an applicant''s';
  end if;
  perform set_config('ca_suite.decoy', (select id::text from identity.clinician_application_challenges
    where purpose = 'status' and email_hmac = pg_temp.ca_h('email:patient@ca.invalid')), true);
end $$;
update auth.accounts set disabled_until = null where email = 'doctor4@ca.invalid';
insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, activated_at, last_used_step)
values ('ca240000-0000-4000-8000-0000000000e4', pg_temp.ca_account('doctor4@ca.invalid'), 'active', gen_random_bytes(49),
  'suite-v1', clock_timestamp(), 1);
insert into identity.clinician_application_challenges (id, purpose, email_hmac, account_id, code_hmac, created_at, expires_at)
values ('ca300000-0000-4000-8000-000000000024', 'status', pg_temp.ca_h('email:doctor4@ca.invalid'),
  pg_temp.ca_account('doctor4@ca.invalid'), pg_temp.ca_h('code:s24'), now(), now() + interval '10 minutes');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('status-verify');
do $$
declare
  outcome record;
begin
  select * into outcome from identity.verify_clinician_application_status_code(current_setting('ca_suite.decoy')::uuid,
    pg_temp.ca_h('email:patient@ca.invalid'), pg_temp.ca_h('code:decoy-patient@ca.invalid'), pg_temp.ca_h('session:decoy'));
  if outcome.outcome <> 'invalid' then raise exception 'a decoy verified with its own code'; end if;
  select * into outcome from identity.verify_clinician_application_status_code('ca300000-0000-4000-8000-000000000021',
    pg_temp.ca_h('email:doctor1@ca.invalid'), pg_temp.ca_h('code:wrong'), pg_temp.ca_h('session:p1-status'));
  if outcome.outcome <> 'invalid' then raise exception 'a wrong status code verified'; end if;
  select * into outcome from identity.verify_clinician_application_status_code('ca300000-0000-4000-8000-000000000021',
    pg_temp.ca_h('email:doctor1@ca.invalid'), pg_temp.ca_h('code:s21'), pg_temp.ca_h('session:p1-status'));
  if outcome.outcome <> 'verified' or outcome.stage <> 'authenticator_required'
     or outcome.account_id <> pg_temp.ca_account('doctor1@ca.invalid') then
    raise exception 'a proven factor did not open authenticator_required: %', row_to_json(outcome);
  end if;
  select * into outcome from identity.verify_clinician_application_status_code('ca300000-0000-4000-8000-000000000022',
    pg_temp.ca_h('email:nurse2@ca.invalid'), pg_temp.ca_h('code:s22'), pg_temp.ca_h('session:p2-status'));
  if outcome.outcome <> 'verified' or outcome.stage <> 'authenticator_required' then
    raise exception 'P2 holds a proven factor: %', row_to_json(outcome);
  end if;
  select * into outcome from identity.verify_clinician_application_status_code('ca300000-0000-4000-8000-000000000024',
    pg_temp.ca_h('email:doctor4@ca.invalid'), pg_temp.ca_h('code:s24'), pg_temp.ca_h('session:p4-status'));
  if outcome.outcome <> 'factor_unproven' or outcome.account_id is not null then
    raise exception 'a factor without staff proof opened a capability: %', row_to_json(outcome);
  end if;
end $$;
select pg_temp.ca_refused($c$select identity.current_clinician_applications(pg_temp.ca_h('session:p1-status'))$c$,
  'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED');
select pg_temp.ca_refused($c$select identity.current_clinician_applications(pg_temp.ca_h('session:p4-status'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
-- A recovery code used in this transaction readies a status capability.
reset role;
insert into auth.mfa_recovery_codes (id, account_id, factor_id, batch_id, code_hmac, key_version, used_at)
values ('ca270000-0000-4000-8000-000000000001', pg_temp.ca_account('nurse2@ca.invalid'), 'ca240000-0000-4000-8000-0000000000f2',
  gen_random_uuid(), repeat('7', 64), 'suite-v1', clock_timestamp());
set local role hid_identity_api_runtime;
select pg_temp.ca_system('status-recovery');
do $$
declare
  view jsonb;
begin
  view := identity.clinician_application_authenticator_ready(pg_temp.ca_h('session:p2-status'),
    'ca240000-0000-4000-8000-0000000000f2', 'recovery_code');
  if view->>'stage' <> 'ready' or view->'applications'->0->>'state' <> 'submitted' then
    raise exception 'a recovery code did not ready the status capability: %', view;
  end if;
  view := identity.current_clinician_applications(pg_temp.ca_h('session:p2-status'));
  if view->>'stage' <> 'ready' or (view->>'canApply')::boolean is not true then
    raise exception 'the ready capability cannot read its applications: %', view;
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from audit.events where action = 'identity.clinician-application.status-code-verified'
       and correlation_id = 'clinician-suite-status-verify') <> 2
     or (select count(*) from audit.events where action = 'identity.clinician-application.authenticator.verified'
       and details->>'method' = 'recovery_code') <> 1
     or (select failed_attempts from identity.clinician_application_challenges
          where id = current_setting('ca_suite.decoy')::uuid) <> 1 then
    raise exception 'status verification audit or decoy counting is not as specified';
  end if;
end $$;

-- 9. Applying to another facility (C13).
-- The org_admin of X, and the patient, each hold an application (so the status
-- page serves the org_admin), a proven factor and a ready capability.
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('ca210000-0000-4000-8000-000000000007', 'ca200000-0000-4000-8000-000000000007', 'Suite Patient', 'patient@ca.invalid',
   'pending', 'staff');
select pg_temp.ca_owner_application('ca200000-0000-4000-8000-000000000008', 'ca110000-0000-4000-8000-00000000000b',
  'submitted', clock_timestamp());
select pg_temp.ca_owner_application('ca200000-0000-4000-8000-000000000007', 'ca110000-0000-4000-8000-00000000000b',
  'submitted', clock_timestamp());
select pg_temp.ca_proven_factor('ca200000-0000-4000-8000-000000000008', 'ca240000-0000-4000-8000-0000000000f8');
select pg_temp.ca_proven_factor('ca200000-0000-4000-8000-000000000007', 'ca240000-0000-4000-8000-0000000000f7');
select pg_temp.ca_capability('orgadmin-ready', 'ca200000-0000-4000-8000-000000000008', 'ready');
select pg_temp.ca_capability('patient-ready', 'ca200000-0000-4000-8000-000000000007', 'ready');
select pg_temp.ca_capability('p4-ready', pg_temp.ca_account('doctor4@ca.invalid'), 'ready');
select pg_temp.ca_capability('p3-enrol', pg_temp.ca_account('doctor3@ca.invalid'), 'enrolment_required');
select set_config('ca_suite.files_before', pg_temp.ca_platform_submits()::text, true);
set local role hid_identity_api_runtime;
select pg_temp.ca_system('file');
create function pg_temp.ca_file(tag text, session_tag text, facility uuid, key_suffix text default '') returns jsonb
language sql as $$
  select application from identity.file_clinician_application(pg_temp.ca_h('session:' || session_tag),
    'clinician-suite-file-' || tag || key_suffix, pg_temp.ca_h('file:' || tag), 'doctor', 'MDCN', 'MDCN/12345',
    (select licence_400 from ca_dates), facility, 30)
$$;
select pg_temp.ca_refused($c$select pg_temp.ca_file('p1-x', 'p1-account', 'ca110000-0000-4000-8000-00000000000a')$c$,
  'CLINICIAN_APPLICATION_ALREADY_OPEN');
select pg_temp.ca_refused($c$select pg_temp.ca_file('p1-z', 'p1-account', 'ca110000-0000-4000-8000-00000000000c')$c$,
  'CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE');
select pg_temp.ca_refused($c$select pg_temp.ca_file('p3-enrol', 'p3-enrol', 'ca110000-0000-4000-8000-00000000000b')$c$,
  'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED');
select pg_temp.ca_refused($c$select pg_temp.ca_file('p1-status', 'p1-status', 'ca110000-0000-4000-8000-00000000000b')$c$,
  'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED');
select pg_temp.ca_refused($c$select pg_temp.ca_file('orgadmin-x', 'orgadmin-ready', 'ca110000-0000-4000-8000-00000000000a')$c$,
  'CLINICIAN_APPLICATION_ROLE_CONFLICT');
select pg_temp.ca_refused($c$select pg_temp.ca_file('patient-w', 'patient-ready', 'ca110000-0000-4000-8000-00000000000d')$c$,
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
select pg_temp.ca_refused($c$select pg_temp.ca_file('p4-w', 'p4-ready', 'ca110000-0000-4000-8000-00000000000d')$c$,
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
do $$
declare
  filed jsonb;
  replay record;
begin
  filed := pg_temp.ca_file('p1-y', 'p1-account', 'ca110000-0000-4000-8000-00000000000b');
  if filed->>'state' <> 'submitted' or filed->'facility'->>'name' <> 'Clinician Suite Clinic Y' then
    raise exception 'applying again did not submit an application: %', filed;
  end if;
  select * into replay from identity.file_clinician_application(pg_temp.ca_h('session:p1-account'),
    'clinician-suite-file-p1-y', pg_temp.ca_h('file:p1-y'), 'doctor', 'MDCN', 'MDCN/12345',
    (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000b', 30);
  if not replay.replayed or replay.application->>'applicationId' <> filed->>'applicationId' then
    raise exception 'applying again was not replayed: %', row_to_json(replay);
  end if;
  perform pg_temp.ca_file('p1-w', 'p1-account', 'ca110000-0000-4000-8000-00000000000d');
end $$;
select pg_temp.ca_refused($c$select * from identity.file_clinician_application(pg_temp.ca_h('session:p1-account'),
  'clinician-suite-file-p1-y', pg_temp.ca_h('file:other'), 'doctor', 'MDCN', 'MDCN/12345',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000b', 30)$c$,
  'CLINICIAN_APPLICATION_IDEMPOTENCY_CONFLICT');
-- Three open applications: the next one is refused.
select pg_temp.ca_refused($c$select pg_temp.ca_file('p1-u', 'p1-account', 'ca110000-0000-4000-8000-00000000000f')$c$,
  'CLINICIAN_APPLICATION_LIMIT_REACHED');
-- A pending 0087 membership at a facility blocks applying there.
select pg_temp.ca_as('b');
select * from identity.admin_attach_workforce_member('ca110000-0000-4000-8000-00000000000f',
  pg_temp.ca_account('doctor1@ca.invalid'), null, null, 'Clinician suite attaches P1 at U', 'clinician-suite-attach-p1-u',
  repeat('a', 64));
select pg_temp.ca_system('file-2');
select pg_temp.ca_refused($c$select pg_temp.ca_file('p1-u', 'p1-account', 'ca110000-0000-4000-8000-00000000000f')$c$,
  'CLINICIAN_APPLICATION_MEMBERSHIP_EXISTS');
reset role;
-- Ten applications in thirty days: P2 holds one; nine more (withdrawn) and the next is refused.
select pg_temp.ca_owner_application(pg_temp.ca_account('nurse2@ca.invalid'), 'ca110000-0000-4000-8000-00000000000d',
  'withdrawn', clock_timestamp() - make_interval(days => n), 'nurse')
from generate_series(1, 9) n;
-- The org_admin's account is ineligible once its staff record is inactive or it is disabled.
update identity.staff set active = false where id = 'ca210000-0000-4000-8000-000000000008';
set local role hid_identity_api_runtime;
select pg_temp.ca_system('file-3');
select pg_temp.ca_refused($c$select application from identity.file_clinician_application(pg_temp.ca_h('session:p2-status'),
  'clinician-suite-file-p2-x', pg_temp.ca_h('file:p2-x'), 'nurse', 'NMCN', 'NMCN 777', (select licence_400 from ca_dates),
  'ca110000-0000-4000-8000-00000000000a', 30)$c$, 'CLINICIAN_APPLICATION_LIMIT_REACHED');
select pg_temp.ca_refused($c$select pg_temp.ca_file('orgadmin-y', 'orgadmin-ready', 'ca110000-0000-4000-8000-00000000000d')$c$,
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
reset role;
update identity.staff set active = true where id = 'ca210000-0000-4000-8000-000000000008';
update auth.accounts set disabled_until = clock_timestamp() + interval '1 hour' where id = 'ca200000-0000-4000-8000-000000000008';
set local role hid_identity_api_runtime;
select pg_temp.ca_system('file-4');
select pg_temp.ca_refused($c$select pg_temp.ca_file('orgadmin-y2', 'orgadmin-ready', 'ca110000-0000-4000-8000-00000000000d')$c$,
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
reset role;
update auth.accounts set disabled_until = null where id = 'ca200000-0000-4000-8000-000000000008';
do $$ begin
  if (select count(*) from audit.events where action = 'identity.clinician-application.submitted'
       and (details->>'additional')::boolean) <> 2
     or (select count(*) from identity.clinician_applications
          where account_id = pg_temp.ca_account('doctor1@ca.invalid')) <> 3 then
    raise exception 'applying again did not create exactly two additional applications';
  end if;
  -- Only the two created count against the platform's cap: no refusal or replay does.
  if pg_temp.ca_platform_submits() <> current_setting('ca_suite.files_before')::integer + 2 then
    raise exception 'the platform counted % applications filed again, not two', pg_temp.ca_platform_submits()
      - current_setting('ca_suite.files_before')::integer;
  end if;
end $$;


-- Facility search with an account capability: a ready one searches (and the
-- search counts against its own budget); one that still needs the
-- authenticator, and a spent draft, are refused like a missing one.
set local role hid_identity_api_runtime;
select pg_temp.ca_system('search-account');
do $$ begin
  if (select count(*) from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p1-account'), 'suite')) <> 4 then
    raise exception 'a ready capability could not search';
  end if;
end $$;
select pg_temp.ca_refused($c$select * from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p3-enrol'),
  'suite')$c$, 'CLINICIAN_APPLICATION_SESSION_INVALID');
select pg_temp.ca_refused($c$select * from identity.search_clinician_application_facilities(pg_temp.ca_h('session:p2'),
  'suite')$c$, 'CLINICIAN_APPLICATION_SESSION_INVALID');
reset role;
do $$ begin
  if (select facility_searches from identity.clinician_application_sessions
       where token_hmac = pg_temp.ca_h('session:p1-account')) <> 1
     or (select consumed_at from identity.clinician_application_sessions where token_hmac = pg_temp.ca_h('session:p2')) is null
     or (select expires_at from identity.clinician_application_sessions where token_hmac = pg_temp.ca_h('session:p2'))
       <= clock_timestamp() then
    raise exception 'the account capability search was not counted, or the spent draft is not a live spent one';
  end if;
end $$;

-- 10. The queue and the detail.
-- Helpers as the runtime: an applicant whose authenticator is ready (draft,
-- submission, a proven factor, the ready step), and step 1 by an administrator.
create function pg_temp.ca_ready(tag text, email text, full_name text, facility uuid, licence date) returns uuid
language plpgsql as $$
declare
  created uuid;
begin
  perform pg_temp.ca_system('ready-' || tag);
  perform pg_temp.ca_draft(tag, email);
  created := pg_temp.ca_submit(tag, email, full_name, 'doctor', 'MDCN', 'MDCN/' || upper(tag), licence, facility);
  perform pg_temp.ca_proven_factor(pg_temp.ca_account(email), gen_random_uuid());
  perform identity.clinician_application_authenticator_ready(pg_temp.ca_h('session:' || tag || '-account'),
    (select id from auth.mfa_factors where account_id = pg_temp.ca_account(email) and status = 'active'), 'enrolment');
  return created;
end $$;
create function pg_temp.ca_checklist() returns jsonb language sql immutable as $$
  select '{"registerChecked":true,"licenceCurrentUntilRecorded":true,"identityMethod":"video_call_photo_id",
    "identityConfirmed":true,"employmentChannel":"facility_public_phone","employmentConfirmed":true}'::jsonb
$$;
create function pg_temp.ca_attest(n text, application uuid, valid_until timestamptz, key text) returns uuid
language plpgsql as $$
declare
  detail jsonb;
  attested uuid;
begin
  perform pg_temp.ca_as(n);
  detail := identity.admin_get_clinician_application(application);
  select attestation_id into attested from identity.admin_attest_clinician_application(application,
    (detail->>'version')::bigint, valid_until, 'Synthetic ticket HID-VER-' || key, pg_temp.ca_checklist(),
    (detail->'authenticator'->>'factorId')::uuid, 'Synthetic step 1 ' || key, 'clinician-suite-attest-' || key,
    pg_temp.ca_h('attest:' || key));
  return attested;
end $$;
create function pg_temp.ca_version(application uuid) returns bigint language sql as $$
  select (identity.admin_get_clinician_application(application)->>'version')::bigint
$$;
grant execute on function pg_temp.ca_ready(text, text, text, uuid, date), pg_temp.ca_checklist(),
  pg_temp.ca_attest(text, uuid, timestamptz, text), pg_temp.ca_version(uuid), pg_temp.ca_proven_factor(uuid, uuid)
  to public;
reset role;
-- C's account holds a 0087 attestation of 'mdcn 12345'; T applied at Y.
insert into identity.staff_credential_attestations (id, staff_id, account_id, attested_roles, credential_reference,
  issuing_authority, verification_method, evidence_reference, valid_until, reviewer_account_id, reason, correlation_id)
values ('ca280000-0000-4000-8000-000000000001', 'ca210000-0000-4000-8000-000000000003',
  'ca200000-0000-4000-8000-000000000003', array['doctor'], 'mdcn 12345', 'Medical and Dental Council of Nigeria',
  'manual_review', 'Synthetic owner evidence', now() + interval '1 year', 'ca200000-0000-4000-8000-000000000001',
  'Synthetic owner attestation', 'clinician-suite-owner');
select pg_temp.ca_owner_application('ca200000-0000-4000-8000-000000000011', 'ca110000-0000-4000-8000-00000000000b',
  'submitted', clock_timestamp());
set local role hid_identity_api_runtime;
-- P7 has the org_admin's name and applies at Y (the org_admin's organization).
select pg_temp.ca_ready('p7', 'ada@ca.invalid', 'ADA  ORGADMIN', 'ca110000-0000-4000-8000-00000000000b',
  (select licence_400 from ca_dates));
select pg_temp.ca_as('s');
select pg_temp.ca_refused($c$select * from identity.admin_list_clinician_applications('open', null, null, 10)$c$,
  'ADMIN_PERMISSION_DENIED');
select pg_temp.ca_refused(format($c$select identity.admin_get_clinician_application(%L)$c$,
  (pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).id), 'ADMIN_PERMISSION_DENIED');
select pg_temp.ca_as('a');
select pg_temp.ca_refused($c$select * from identity.admin_list_clinician_applications('pending', null, null, 10)$c$,
  'CLINICIAN_APPLICATION_COMMAND_INVALID');
select pg_temp.ca_refused($c$select * from identity.admin_list_clinician_applications('open', null, null, 51)$c$,
  'CLINICIAN_APPLICATION_COMMAND_INVALID');
select pg_temp.ca_refused($c$select * from identity.admin_list_clinician_applications('open', now(), null, 10)$c$,
  'CLINICIAN_APPLICATION_COMMAND_INVALID');
select pg_temp.ca_refused($c$select identity.admin_get_clinician_application('ca999999-0000-4000-8000-000000000001')$c$,
  'CLINICIAN_APPLICATION_NOT_FOUND');
do $$
declare
  open_ids uuid[];
  page_one uuid[];
  page_two uuid[];
  last record;
  overdue uuid := (pg_temp.ca_application('doctor3@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id;
begin
  select array_agg(id order by submitted_at, id) into open_ids
    from identity.admin_list_clinician_applications('open', null, null, 50);
  if overdue = any(open_ids)
     or not (overdue = any(array(select id from identity.admin_list_clinician_applications('expired', null, null, 50))))
     or exists (select 1 from identity.admin_list_clinician_applications('expired', null, null, 50) where state <> 'expired')
     or exists (select 1 from identity.admin_list_clinician_applications('open', null, null, 50)
                 where state not in ('awaiting_authenticator', 'submitted', 'under_review')) then
    raise exception 'an overdue application is in the open queue, or missing from expired';
  end if;
  -- Oldest first, and a stable cursor.
  select array_agg(id order by ordinality) into page_one
    from identity.admin_list_clinician_applications('open', null, null, 3) with ordinality;
  select * into last from identity.admin_list_clinician_applications('open', null, null, 3) offset 2 limit 1;
  select array_agg(id order by ordinality) into page_two
    from identity.admin_list_clinician_applications('open', last.submitted_at, last.id, 3) with ordinality;
  if page_one || page_two <> open_ids[1:6] then
    raise exception 'the open queue is not ordered oldest first with a stable cursor: % %', page_one, page_two;
  end if;
  if (select array_agg(id order by ordinality) from identity.admin_list_clinician_applications('submitted', null, null, 50)
        with ordinality) <> (select array_agg(id order by submitted_at desc, id desc)
                              from identity.admin_list_clinician_applications('submitted', null, null, 50)) then
    raise exception 'a named state is not listed newest first';
  end if;
end $$;
do $$
declare
  detail jsonb;
  p1x uuid := (pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).id;
begin
  detail := identity.admin_get_clinician_application(p1x);
  if detail->>'state' <> 'submitted' or detail->'applicant'->>'email' <> 'doctor1@ca.invalid'
     or detail->>'licenceNumber' <> 'MDCN/12345' or not (detail->>'authenticatorReady')::boolean
     or not (detail->'authenticator'->>'enrolled')::boolean
     or detail->'authenticator'->>'factorId' <> 'ca240000-0000-4000-8000-0000000000f1'
     or (detail->'authenticator'->>'enrolledAfterRecovery')::boolean
     or detail->'staff'->>'verificationStatus' <> 'pending'
     or (detail->'account'->>'identityRejection')::boolean or (detail->'account'->>'patientAccount')::boolean
     or detail->'facility'->>'cacHint' is not null
     or detail->'facility'->'orgAdmins' <> '[{"email": "orgadmin@ca.invalid", "displayName": "Ada Orgadmin"}]'::jsonb
     or (detail->'flags'->>'sameLicenceKeyOtherAccounts')::integer <> 2
     or (detail->'flags'->>'sameLicenceKeyOtherOpenApplications')::integer <> 1
     or not (detail->'flags'->>'sameLicenceAttestedElsewhere')::boolean
     or (detail->'flags'->>'orgAdminNameMatch')::boolean
     or not (detail->'rolePermissions' ? 'ehr.prescription.write')
     or detail->'callerHints' <> '{"attest": {"reason": null, "allowed": true}, "reject": {"reason": null, "allowed": true},
         "approve": {"reason": "STATE", "allowed": false}}'::jsonb
     or detail->'attestation' <> 'null'::jsonb or detail->'approval' <> 'null'::jsonb then
    raise exception 'the detail of P1 at X is not as expected: %', detail;
  end if;
  detail := identity.admin_get_clinician_application(
    (pg_temp.ca_application('ada@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id);
  if not (detail->'flags'->>'orgAdminNameMatch')::boolean or not (detail->'flags'->>'orgAdminEmailDomainMatch')::boolean then
    raise exception 'an applicant named as the facility''s org_admin was not flagged: %', detail->'flags';
  end if;
  detail := identity.admin_get_clinician_application(
    (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id);
  if detail->'rolePermissions' ? 'ehr.prescription.write' or not (detail->'rolePermissions' ? 'identity.patient.read') then
    raise exception 'the nurse role permissions are not as granted: %', detail->'rolePermissions';
  end if;
  -- Display hints: authenticator, account and state.
  if identity.admin_get_clinician_application((pg_temp.ca_application('super-t@ca.invalid',
       'ca110000-0000-4000-8000-00000000000b')).id)->'callerHints'->'attest'->>'reason' <> 'AUTHENTICATOR_REQUIRED'
     or identity.admin_get_clinician_application((pg_temp.ca_application('patient@ca.invalid',
       'ca110000-0000-4000-8000-00000000000b')).id)->'callerHints'->'attest'->>'reason' <> 'ACCOUNT_INELIGIBLE'
     or identity.admin_get_clinician_application((pg_temp.ca_application('doctor4@ca.invalid',
       'ca110000-0000-4000-8000-00000000000f')).id)->'callerHints'->'attest'->>'reason' <> 'STATE' then
    raise exception 'the attest display hints are not as expected';
  end if;
end $$;
select pg_temp.ca_as('c');
do $$ begin
  if identity.admin_get_clinician_application((pg_temp.ca_application('doctor1@ca.invalid',
       'ca110000-0000-4000-8000-00000000000a')).id)->'callerHints' <> '{"attest": {"reason": "WORKS_AT_FACILITY",
         "allowed": false}, "reject": {"reason": "WORKS_AT_FACILITY", "allowed": false}, "approve": {"reason":
         "WORKS_AT_FACILITY", "allowed": false}}'::jsonb then
    raise exception 'an administrator who works at the facility is not told so';
  end if;
end $$;
select pg_temp.ca_as('t');
do $$ begin
  if identity.admin_get_clinician_application((pg_temp.ca_application('super-t@ca.invalid',
       'ca110000-0000-4000-8000-00000000000b')).id)->'callerHints'->'attest'->>'reason' <> 'SELF' then
    raise exception 'an administrator''s own application is not marked SELF';
  end if;
end $$;

-- 11. Step 1 (attest).
select pg_temp.ca_as('a');
create temporary table ca_step on commit drop as
select (pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).id as p1x,
  (((select licence_400 from ca_dates) + 1)::timestamp at time zone 'Africa/Lagos') as p1_licence_end;
grant select on ca_step to public;
create function pg_temp.ca_p1_attest(admin text, version bigint, valid_until timestamptz, checklist jsonb, factor uuid,
  key text) returns void language plpgsql as $$
begin
  perform pg_temp.ca_as(admin);
  perform * from identity.admin_attest_clinician_application((select p1x from ca_step), version, valid_until,
    'Synthetic ticket HID-VER-1001', checklist, factor, 'Synthetic step 1 for P1', key, pg_temp.ca_h('p1-attest:' || key));
end $$;
grant execute on function pg_temp.ca_p1_attest(text, bigint, timestamptz, jsonb, uuid, text) to public;
select set_config('app.session_id', '', true);
select pg_temp.ca_refused($c$select * from identity.admin_attest_clinician_application((select p1x from ca_step), 2,
  (select p1_licence_end from ca_step), 'Synthetic ticket HID-VER-1001', pg_temp.ca_checklist(),
  'ca240000-0000-4000-8000-0000000000f1', 'Synthetic step 1 for P1', 'clinician-suite-p1-attest-0', repeat('a', 64))$c$,
  'ADMIN_STEP_UP_REQUIRED');
select pg_temp.ca_refused($c$select pg_temp.ca_p1_attest('n', 2, (select p1_licence_end from ca_step), pg_temp.ca_checklist(),
  'ca240000-0000-4000-8000-0000000000f1', 'clinician-suite-p1-attest-1')$c$, 'ADMIN_MFA_REQUIRED');
select pg_temp.ca_refused($c$select pg_temp.ca_p1_attest('a', 1, (select p1_licence_end from ca_step), pg_temp.ca_checklist(),
  'ca240000-0000-4000-8000-0000000000f1', 'clinician-suite-p1-attest-2')$c$, 'ADMIN_VERSION_CONFLICT');
select pg_temp.ca_refused($c$select pg_temp.ca_p1_attest('c', 2, (select p1_licence_end from ca_step), pg_temp.ca_checklist(),
  'ca240000-0000-4000-8000-0000000000f1', 'clinician-suite-p1-attest-3')$c$, 'WORKFORCE_FACILITY_CONFLICT');
select pg_temp.ca_as('t');
select pg_temp.ca_refused(format($c$select * from identity.admin_attest_clinician_application(%L, 1, now() + interval '30 days',
  'Synthetic ticket HID-VER-1002', pg_temp.ca_checklist(), 'ca240000-0000-4000-8000-000000000011', 'Synthetic own step 1',
  'clinician-suite-own-attest', repeat('a', 64))$c$, (pg_temp.ca_application('super-t@ca.invalid',
  'ca110000-0000-4000-8000-00000000000b')).id), 'WORKFORCE_SELF_CHANGE_DENIED');
-- The step-1 pre-check (before Identity checks the applicant's code): it
-- refuses whatever step 1 would refuse, so a refused call never reaches the
-- applicant's authenticator or failure budget, and otherwise names the
-- applicant's account.
select pg_temp.ca_refused(format($c$select identity.admin_clinician_application_attest_precheck(%L, 1)$c$,
  (pg_temp.ca_application('super-t@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id), 'WORKFORCE_SELF_CHANGE_DENIED');
select pg_temp.ca_as('c');
select pg_temp.ca_refused($c$select identity.admin_clinician_application_attest_precheck((select p1x from ca_step), 2)$c$,
  'WORKFORCE_FACILITY_CONFLICT');
select pg_temp.ca_as('n');
select pg_temp.ca_refused($c$select identity.admin_clinician_application_attest_precheck((select p1x from ca_step), 2)$c$,
  'ADMIN_MFA_REQUIRED');
select pg_temp.ca_as('a');
select pg_temp.ca_refused($c$select identity.admin_clinician_application_attest_precheck((select p1x from ca_step), 1)$c$,
  'ADMIN_VERSION_CONFLICT');
select pg_temp.ca_refused($c$select identity.admin_clinician_application_attest_precheck(
  'ca999999-0000-4000-8000-000000000001', 1)$c$, 'CLINICIAN_APPLICATION_NOT_FOUND');
-- P3's application is overdue (shown as expired).
select pg_temp.ca_refused(format($c$select identity.admin_clinician_application_attest_precheck(%L, %s)$c$,
  (pg_temp.ca_application('doctor3@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id,
  pg_temp.ca_version((pg_temp.ca_application('doctor3@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id)),
  'CLINICIAN_APPLICATION_STATE_INVALID');
do $$ begin
  if identity.admin_clinician_application_attest_precheck((select p1x from ca_step), 2)
       <> pg_temp.ca_account('doctor1@ca.invalid') then
    raise exception 'the step-1 pre-check did not name the applicant''s account';
  end if;
end $$;
-- The checklist exactly as specified.
select pg_temp.ca_refused(format($c$select pg_temp.ca_p1_attest('a', 2, (select p1_licence_end from ca_step), %L,
  'ca240000-0000-4000-8000-0000000000f1', 'clinician-suite-p1-attest-4')$c$, checklist), 'CLINICIAN_APPLICATION_COMMAND_INVALID')
from unnest(array[pg_temp.ca_checklist() - 'registerChecked',
  pg_temp.ca_checklist() || '{"note":"extra"}', pg_temp.ca_checklist() || '{"identityConfirmed":false}',
  pg_temp.ca_checklist() || '{"identityMethod":"phone_call"}', pg_temp.ca_checklist() || '{"employmentChannel":"org_admin"}',
  pg_temp.ca_checklist() || '{"registerChecked":"true"}', '[]'::jsonb]) checklist;
-- Validity capped at the end of the licence's expiry date (Lagos) and three years.
select pg_temp.ca_refused($c$select pg_temp.ca_p1_attest('a', 2, (select p1_licence_end from ca_step) + interval '1 second',
  pg_temp.ca_checklist(), 'ca240000-0000-4000-8000-0000000000f1', 'clinician-suite-p1-attest-5')$c$,
  'CLINICIAN_APPLICATION_COMMAND_INVALID');
select pg_temp.ca_refused($c$select pg_temp.ca_p1_attest('a', 2, clock_timestamp() + interval '3 years' + interval '1 day',
  pg_temp.ca_checklist(), 'ca240000-0000-4000-8000-0000000000f1', 'clinician-suite-p1-attest-6')$c$,
  'CLINICIAN_APPLICATION_COMMAND_INVALID');
select pg_temp.ca_refused($c$select pg_temp.ca_p1_attest('a', 2, now() - interval '1 minute',
  pg_temp.ca_checklist(), 'ca240000-0000-4000-8000-0000000000f1', 'clinician-suite-p1-attest-7')$c$,
  'CLINICIAN_APPLICATION_COMMAND_INVALID');
-- The factor must be the applicant's active staff-proven factor, used in this transaction.
select pg_temp.ca_refused(format($c$select pg_temp.ca_p1_attest('a', 2, (select p1_licence_end from ca_step),
  pg_temp.ca_checklist(), %L, 'clinician-suite-p1-attest-8')$c$, factor), 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED')
from unnest(array['ca240000-0000-4000-8000-0000000000f2', 'ca240000-0000-4000-8000-0000000000e1',
  'ca240000-0000-4000-8000-0000000000e2', 'ca240000-0000-4000-8000-000000000001']) factor;
reset role;
update auth.mfa_factors set last_used_at = now() - interval '1 minute' where id = 'ca240000-0000-4000-8000-0000000000f1';
set local role hid_identity_api_runtime;
select pg_temp.ca_refused($c$select pg_temp.ca_p1_attest('a', 2, (select p1_licence_end from ca_step),
  pg_temp.ca_checklist(), 'ca240000-0000-4000-8000-0000000000f1', 'clinician-suite-p1-attest-9')$c$,
  'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED');
reset role;
update auth.mfa_factors set last_used_at = clock_timestamp() where id = 'ca240000-0000-4000-8000-0000000000f1';
set local role hid_identity_api_runtime;
select pg_temp.ca_as('a');
do $$
declare
  result record;
  replay record;
begin
  select * into result from identity.admin_attest_clinician_application((select p1x from ca_step), 2,
    (select p1_licence_end from ca_step), '  Synthetic ticket HID-VER-1001 ', pg_temp.ca_checklist(),
    'ca240000-0000-4000-8000-0000000000f1', 'Synthetic step 1 for P1', 'clinician-suite-p1-attest-ok',
    pg_temp.ca_h('p1-attest:ok'));
  if result.state <> 'under_review' or result.application_version <> 3 or result.replayed
     or result.valid_until <> (select p1_licence_end from ca_step) or result.role_code <> 'doctor' then
    raise exception 'step 1 did not put the application under review: %', row_to_json(result);
  end if;
  perform set_config('ca_suite.p1_attestation', result.attestation_id::text, true);
  select * into replay from identity.admin_attest_clinician_application((select p1x from ca_step), 2,
    (select p1_licence_end from ca_step), '  Synthetic ticket HID-VER-1001 ', pg_temp.ca_checklist(),
    'ca240000-0000-4000-8000-0000000000f1', 'Synthetic step 1 for P1', 'clinician-suite-p1-attest-ok',
    pg_temp.ca_h('p1-attest:ok'));
  if not replay.replayed or replay.attestation_id <> result.attestation_id then
    raise exception 'a step 1 replay was not answered with the first result';
  end if;
  if identity.admin_clinician_application_prior('workforce.clinician-application.attest', 'clinician-suite-p1-attest-ok',
       pg_temp.ca_h('p1-attest:ok'))->>'attestationId' <> result.attestation_id::text
     or identity.admin_clinician_application_prior('workforce.clinician-application.attest', 'clinician-suite-unused-key',
       pg_temp.ca_h('p1-attest:ok')) is not null then
    raise exception 'the prior probe is wrong';
  end if;
end $$;
select pg_temp.ca_refused($c$select identity.admin_clinician_application_prior('workforce.clinician-application.attest',
  'clinician-suite-p1-attest-ok', repeat('b', 64))$c$, 'ADMIN_IDEMPOTENCY_CONFLICT');
select pg_temp.ca_refused($c$select identity.admin_clinician_application_prior('workforce.credential.attest',
  'clinician-suite-p1-attest-ok', repeat('b', 64))$c$, 'CLINICIAN_APPLICATION_COMMAND_INVALID');
select pg_temp.ca_refused($c$select pg_temp.ca_p1_attest('a', 3, (select p1_licence_end from ca_step),
  pg_temp.ca_checklist(), 'ca240000-0000-4000-8000-0000000000f1', 'clinician-suite-p1-attest-again')$c$,
  'CLINICIAN_APPLICATION_STATE_INVALID');
select pg_temp.ca_as('a');
select pg_temp.ca_refused($c$select identity.admin_clinician_application_attest_precheck((select p1x from ca_step), 3)$c$,
  'CLINICIAN_APPLICATION_STATE_INVALID');
-- A key already used for a generic 0087 attestation cannot carry step 1.
select * from identity.admin_record_credential_attestation('ca200000-0000-4000-8000-000000000009', 1, array['nurse'],
  'NMCN 5555', 'Nursing and Midwifery Council of Nigeria', 'Synthetic generic evidence', now() + interval '1 year',
  'Synthetic generic attestation', 'clinician-suite-inner-1', repeat('c', 64));
select pg_temp.ca_refused(format($c$select * from identity.admin_attest_clinician_application(%L, %s,
  now() + interval '200 days', 'Synthetic ticket HID-VER-1003', pg_temp.ca_checklist(), 'ca240000-0000-4000-8000-0000000000f8',
  'Synthetic step 1 for the org_admin', 'clinician-suite-inner-1', repeat('c', 64))$c$,
  (pg_temp.ca_application('orgadmin@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  pg_temp.ca_version((pg_temp.ca_application('orgadmin@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id)),
  'ADMIN_IDEMPOTENCY_CONFLICT');
reset role;
do $$
declare
  attestation identity.staff_credential_attestations%rowtype;
  application identity.clinician_applications%rowtype;
begin
  select * into application from identity.clinician_applications where id = (select p1x from ca_step);
  select * into attestation from identity.staff_credential_attestations
   where id = current_setting('ca_suite.p1_attestation')::uuid;
  if attestation.attested_roles <> array['doctor'] or attestation.credential_reference <> 'MDCN/12345'
     or attestation.issuing_authority <> 'Medical and Dental Council of Nigeria'
     or attestation.verification_method <> 'manual_review' or attestation.evidence_reference <> 'Synthetic ticket HID-VER-1001'
     or attestation.reviewer_account_id <> 'ca200000-0000-4000-8000-000000000001'
     or attestation.account_id <> application.account_id then
    raise exception 'step 1 recorded an unexpected attestation: %', row_to_json(attestation);
  end if;
  if application.attestation_id <> attestation.id or application.attested_by <> 'ca200000-0000-4000-8000-000000000001'
     or application.factor_id <> 'ca240000-0000-4000-8000-0000000000f1' or application.factor_confirmed_at is null
     or application.attestation_checklist <> pg_temp.ca_checklist()
     or (select verification_status from identity.staff where id = application.staff_id) <> 'verified' then
    raise exception 'step 1 did not record its evidence on the application: %', row_to_json(application);
  end if;
  if (select count(*) from auth.admin_command_idempotency where actor_account_id = 'ca200000-0000-4000-8000-000000000001'
       and idempotency_key = 'clinician-suite-p1-attest-ok'
       and operation in ('workforce.clinician-application.attest', 'workforce.credential.attest')) <> 2
     or exists (select 1 from auth.admin_command_idempotency where idempotency_key = 'clinician-suite-inner-1'
       and operation = 'workforce.clinician-application.attest') then
    raise exception 'step 1 idempotency rows are not as specified';
  end if;
end $$;

-- 12. Step 2 (approve) and the pinned grant.
set local role hid_identity_api_runtime;
create function pg_temp.ca_approve(admin text, application uuid, version bigint, key text) returns void
language plpgsql as $$
begin
  perform pg_temp.ca_as(admin);
  perform * from identity.admin_approve_clinician_application(application, version, 'Synthetic step 2 approval',
    'clinician-suite-approve-' || key, pg_temp.ca_h('approve:' || key));
end $$;
grant execute on function pg_temp.ca_approve(text, uuid, bigint, text) to public;
select pg_temp.ca_refused($c$select pg_temp.ca_approve('a', (select p1x from ca_step), 3, 'p1-by-a')$c$,
  'CLINICIAN_APPLICATION_SECOND_ADMIN_REQUIRED');
select pg_temp.ca_refused($c$select pg_temp.ca_approve('c', (select p1x from ca_step), 3, 'p1-by-c')$c$,
  'WORKFORCE_FACILITY_CONFLICT');
select pg_temp.ca_refused($c$select pg_temp.ca_approve('b', (select p1x from ca_step), 2, 'p1-stale')$c$,
  'ADMIN_VERSION_CONFLICT');
select pg_temp.ca_as('b');
do $$
declare
  result record;
  replay record;
begin
  select * into result from identity.admin_approve_clinician_application((select p1x from ca_step), 3,
    'Synthetic step 2 approval', 'clinician-suite-approve-p1', pg_temp.ca_h('approve:p1'));
  if result.state <> 'approved' or result.role_code <> 'doctor' or result.replayed or result.application_version <> 4
     or result.attestation_id <> current_setting('ca_suite.p1_attestation')::uuid
     or result.attested_by <> 'ca200000-0000-4000-8000-000000000001' or result.membership_id is null then
    raise exception 'step 2 did not approve: %', row_to_json(result);
  end if;
  perform set_config('ca_suite.p1_membership', result.membership_id::text, true);
  select * into replay from identity.admin_approve_clinician_application((select p1x from ca_step), 3,
    'Synthetic step 2 approval', 'clinician-suite-approve-p1', pg_temp.ca_h('approve:p1'));
  if not replay.replayed or replay.membership_id <> result.membership_id then
    raise exception 'a step 2 replay was not answered with the first result';
  end if;
end $$;
reset role;
do $$
declare
  membership identity.staff_facility_memberships%rowtype;
  assignment auth.account_roles%rowtype;
  account_row auth.accounts%rowtype;
begin
  select * into membership from identity.staff_facility_memberships where id = current_setting('ca_suite.p1_membership')::uuid;
  select * into assignment from auth.account_roles where membership_id = membership.id and revoked_at is null;
  select * into account_row from auth.accounts where id = membership.account_id;
  if not membership.active or membership.membership_role <> 'doctor' or membership.facility_id <> 'ca110000-0000-4000-8000-00000000000a'
     or (select state from identity.workforce_memberships where membership_id = membership.id) <> 'active'
     or assignment.role_code <> 'doctor' or assignment.granted_by <> 'ca200000-0000-4000-8000-000000000002'
     or (select attestation_id from identity.workforce_role_grants where account_role_id = assignment.id)
       <> current_setting('ca_suite.p1_attestation')::uuid
     or (select approved_by from identity.clinician_applications where id = (select p1x from ca_step))
       <> 'ca200000-0000-4000-8000-000000000002' then
    raise exception 'step 2 did not attach and grant on the step-1 attestation';
  end if;
  -- Staff sign-in now finds an eligible membership (CurrentStaffContextService's joins), and the role authorizes.
  if not exists (select 1 from identity.staff_facility_memberships eligible
                   join identity.staff staff on staff.id = eligible.staff_id and staff.active
                     and lower(btrim(staff.verification_status)) in ('verified', 'approved', 'active')
                   join identity.organizations organization on organization.id = eligible.organization_id and organization.active
                   join identity.facilities facility on facility.id = eligible.facility_id and facility.active
                  where eligible.account_id = account_row.id and eligible.active and eligible.migration_hold_reason is null)
     or not auth.membership_has_permission(account_row.subject, membership.id, membership.facility_id, 'identity.patient.read')
     or not auth.membership_has_permission(account_row.subject, membership.id, membership.facility_id, 'ehr.prescription.write') then
    raise exception 'the approved clinician is not eligible for staff sign-in at the facility';
  end if;
end $$;
-- The applicant's view: approved, with access active; applying again there is refused.
set local role hid_identity_api_runtime;
select pg_temp.ca_system('approved-view');
do $$
declare
  view jsonb;
  item jsonb;
begin
  view := identity.current_clinician_applications(pg_temp.ca_h('session:p1-account'));
  select application into item from jsonb_array_elements(view->'applications') application
   where application->>'applicationId' = (select p1x from ca_step)::text;
  if item->>'state' <> 'approved' or item->>'accessState' <> 'active' or item->>'decidedAt' is null
     or (item->>'canWithdraw')::boolean or item ? 'decisionReason' then
    raise exception 'the approved application is not shown as active access: %', item;
  end if;
end $$;
select pg_temp.ca_refused($c$select pg_temp.ca_file('p1-x2', 'p1-account', 'ca110000-0000-4000-8000-00000000000a')$c$,
  'CLINICIAN_APPLICATION_MEMBERSHIP_EXISTS');
-- An approved clinician whose authenticator was reset (a two-person MFA
-- reset) sets it up again only through staff sign-in, never through an
-- application capability opened by the mailbox alone: a correct status code
-- opens nothing, a challenge for the enrolment cannot be bound, and no
-- enrolment readies a capability. All rolled back.
reset role;
savepoint ca_reset;
update auth.mfa_factors set status = 'revoked', revoked_at = clock_timestamp(),
  revoked_by = 'ca200000-0000-4000-8000-000000000005', revocation_reason = 'admin_reset', row_version = row_version + 1
 where account_id = pg_temp.ca_account('doctor1@ca.invalid') and status = 'active';
insert into identity.clinician_application_challenges (id, purpose, email_hmac, account_id, code_hmac, created_at, expires_at)
values ('ca300000-0000-4000-8000-000000000031', 'status', pg_temp.ca_h('email:doctor1@ca.invalid'),
  pg_temp.ca_account('doctor1@ca.invalid'), pg_temp.ca_h('code:s31'), now(), now() + interval '10 minutes');
insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
  expires_at, max_attempts, session_kind)
values ('ca400000-0000-4000-8000-000000000031', pg_temp.ca_account('doctor1@ca.invalid'), 'enroll',
  pg_temp.ca_h('mfa:p1-reset'), 1, now(), now() + interval '10 minutes', 5, 'staff');
select pg_temp.ca_capability('p1-reset', pg_temp.ca_account('doctor1@ca.invalid'), 'authenticator_required');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('p1-reset');
do $$
declare
  outcome record;
begin
  select * into outcome from identity.verify_clinician_application_status_code('ca300000-0000-4000-8000-000000000031',
    pg_temp.ca_h('email:doctor1@ca.invalid'), pg_temp.ca_h('code:s31'), pg_temp.ca_h('session:p1-reset-status'));
  if outcome.outcome is distinct from 'staff_sign_in_required' or outcome.account_id is not null
     or outcome.stage is not null then
    raise exception 'a reset approved clinician opened an enrolment capability: %', row_to_json(outcome);
  end if;
end $$;
select pg_temp.ca_refused($c$select identity.current_clinician_applications(pg_temp.ca_h('session:p1-reset-status'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
select pg_temp.ca_refused($c$select identity.bind_clinician_application_mfa_challenge(pg_temp.ca_h('session:p1-reset'),
  'ca400000-0000-4000-8000-000000000031')$c$, 'CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED');
reset role;
select pg_temp.ca_proven_factor(pg_temp.ca_account('doctor1@ca.invalid'), 'ca240000-0000-4000-8000-0000000000d1');
update identity.clinician_application_sessions set stage = 'enrolment_required'
 where token_hmac = pg_temp.ca_h('session:p1-reset');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('p1-reset-ready');
select pg_temp.ca_refused($c$select identity.clinician_application_authenticator_ready(pg_temp.ca_h('session:p1-reset'),
  'ca240000-0000-4000-8000-0000000000d1', 'enrolment')$c$, 'CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED');
reset role;
do $$ begin
  if exists (select 1 from identity.clinician_application_sessions where token_hmac = pg_temp.ca_h('session:p1-reset-status'))
     or (select consumed_at from identity.clinician_application_challenges
          where id = 'ca300000-0000-4000-8000-000000000031') is null then
    raise exception 'the refused status code opened a capability or was not spent';
  end if;
end $$;
rollback to savepoint ca_reset;
-- The approved view's accessState follows the access itself: lapsed when the
-- role's attestation lapsed, ended when the membership ended (0087), and
-- account_unavailable when the account is disabled. Each rolled back.
create function pg_temp.ca_access_state() returns text language sql as $$
  select identity.clinician_application_view(application)->>'accessState'
    from identity.clinician_applications application where application.id = (select p1x from ca_step)
$$;
savepoint ca_access;
alter table identity.staff_credential_attestations disable trigger staff_credential_attestations_no_mutation;
update identity.staff_credential_attestations set recorded_at = clock_timestamp() - interval '2 minutes',
  valid_until = clock_timestamp() - interval '1 minute' where id = current_setting('ca_suite.p1_attestation')::uuid;
alter table identity.staff_credential_attestations enable trigger staff_credential_attestations_no_mutation;
do $$ begin
  if pg_temp.ca_access_state() is distinct from 'lapsed' then
    raise exception 'a lapsed attestation is shown as %', pg_temp.ca_access_state();
  end if;
end $$;
rollback to savepoint ca_access;
savepoint ca_access;
select pg_temp.ca_as('d');
select * from identity.admin_end_workforce_membership(current_setting('ca_suite.p1_membership')::uuid,
  'ca110000-0000-4000-8000-00000000000a', (select row_version from identity.staff_facility_memberships
    where id = current_setting('ca_suite.p1_membership')::uuid), 'Synthetic end of P1''s membership at X',
  'clinician-suite-end-p1-x', repeat('e', 64));
do $$ begin
  if pg_temp.ca_access_state() is distinct from 'ended' then
    raise exception 'an ended membership is shown as %', pg_temp.ca_access_state();
  end if;
end $$;
rollback to savepoint ca_access;
savepoint ca_access;
update auth.accounts set disabled_until = clock_timestamp() + interval '1 hour'
 where id = pg_temp.ca_account('doctor1@ca.invalid');
do $$ begin
  if pg_temp.ca_access_state() is distinct from 'account_unavailable' then
    raise exception 'a disabled account is shown as %', pg_temp.ca_access_state();
  end if;
end $$;
rollback to savepoint ca_access;
do $$ begin
  if pg_temp.ca_access_state() is distinct from 'active' then
    raise exception 'the approved access is shown as % after the rolled-back cases', pg_temp.ca_access_state();
  end if;
end $$;
-- The two-person CHECK refuses an approver who recorded step 1, on any write.
reset role;
do $$ begin
  begin
    insert into identity.clinician_applications (id, account_id, staff_id, facility_id, requested_role, regulator_code,
      issuing_authority, licence_number, licence_valid_until, applicant_full_name, state, submitted_at, expires_at,
      authenticator_ready_at, attested_by, attested_at, attestation_id, attestation_checklist, factor_id,
      factor_confirmed_at, approved_by, approved_at, membership_id, correlation_id, updated_at)
    values (gen_random_uuid(), 'ca200000-0000-4000-8000-000000000003', 'ca210000-0000-4000-8000-000000000003',
      'ca110000-0000-4000-8000-00000000000b', 'doctor', 'MDCN', 'Medical and Dental Council of Nigeria', 'MDCN/99',
      current_date + 100, 'Super Admin C', 'approved', now(), now() + interval '30 days', now(),
      'ca200000-0000-4000-8000-000000000001', now(), 'ca280000-0000-4000-8000-000000000001', '{}'::jsonb,
      gen_random_uuid(), now(), 'ca200000-0000-4000-8000-000000000001', now(), 'ca220000-0000-4000-8000-000000000003',
      'clinician-suite-owner', now());
    raise exception 'an approval by the step-1 administrator was stored';
  exception when check_violation then
    if position('clinician_applications_two_person_check' in sqlerrm) = 0 then raise; end if;
  end;
end $$;
-- A pending membership attached through the generic 0087 path while the
-- application is under review: step 2 fails whole.
set local role hid_identity_api_runtime;
select pg_temp.ca_attest('a', (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  now() + interval '300 days', 'p2');
select pg_temp.ca_as('d');
select * from identity.admin_attach_workforce_member('ca110000-0000-4000-8000-00000000000b',
  pg_temp.ca_account('nurse2@ca.invalid'), null, null, 'Synthetic generic attach of P2 at Y', 'clinician-suite-attach-p2-y',
  repeat('d', 64));
select pg_temp.ca_refused(format($c$select pg_temp.ca_approve('b', %L, %s, 'p2')$c$,
  (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  pg_temp.ca_version((pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id)),
  'WORKFORCE_MEMBERSHIP_EXISTS');
reset role;
do $$ begin
  if (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).state <> 'under_review'
     or exists (select 1 from auth.admin_command_idempotency where idempotency_key = 'clinician-suite-approve-p2')
     or (select count(*) from identity.staff_facility_memberships where account_id = pg_temp.ca_account('nurse2@ca.invalid')) <> 1 then
    raise exception 'a failed step 2 left a change behind';
  end if;
end $$;
-- The authenticator confirmed at step 1 was reset: step 2 is refused.
set local role hid_identity_api_runtime;
select pg_temp.ca_ready('p6', 'doctor6@ca.invalid', 'Doctor Six', 'ca110000-0000-4000-8000-00000000000d',
  (select licence_400 from ca_dates));
select pg_temp.ca_attest('a', (pg_temp.ca_application('doctor6@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id,
  now() + interval '300 days', 'p6');
reset role;
update auth.mfa_factors set status = 'revoked', revoked_at = clock_timestamp(),
  revoked_by = 'ca200000-0000-4000-8000-000000000005', revocation_reason = 'admin_reset', row_version = row_version + 1
 where account_id = pg_temp.ca_account('doctor6@ca.invalid') and status = 'active';
set local role hid_identity_api_runtime;
select pg_temp.ca_as('b');
select pg_temp.ca_refused(format($c$select pg_temp.ca_approve('b', %L, %s, 'p6')$c$,
  (pg_temp.ca_application('doctor6@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id,
  pg_temp.ca_version((pg_temp.ca_application('doctor6@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id)),
  'CLINICIAN_APPLICATION_AUTHENTICATOR_CHANGED');
-- Pinned: P9 applies at Y and then at W. A attests Y for (almost) three years,
-- C attests W for one year. Approving W rests on W's own attestation, though
-- Y's lasts longer; rejecting Y afterwards leaves W's role effective.
select pg_temp.ca_ready('p9', 'doctor9@ca.invalid', 'Doctor Nine', 'ca110000-0000-4000-8000-00000000000b',
  (select licence_4y from ca_dates));
select pg_temp.ca_system('p9-file');
select application from identity.file_clinician_application(pg_temp.ca_h('session:p9-account'), 'clinician-suite-file-p9-w',
  pg_temp.ca_h('file:p9-w'), 'doctor', 'MDCN', 'MDCN/P9', (select licence_4y from ca_dates),
  'ca110000-0000-4000-8000-00000000000d', 30);
select set_config('ca_suite.p9_y_attestation', pg_temp.ca_attest('a', (pg_temp.ca_application('doctor9@ca.invalid',
  'ca110000-0000-4000-8000-00000000000b')).id, now() + interval '3 years' - interval '1 hour', 'p9-y')::text, true);
select set_config('ca_suite.p9_w_attestation', pg_temp.ca_attest('c', (pg_temp.ca_application('doctor9@ca.invalid',
  'ca110000-0000-4000-8000-00000000000d')).id, now() + interval '1 year', 'p9-w')::text, true);
select pg_temp.ca_approve('b', (pg_temp.ca_application('doctor9@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id,
  pg_temp.ca_version((pg_temp.ca_application('doctor9@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id), 'p9-w');
select pg_temp.ca_as('d');
select * from identity.admin_reject_clinician_application((pg_temp.ca_application('doctor9@ca.invalid',
  'ca110000-0000-4000-8000-00000000000b')).id, pg_temp.ca_version((pg_temp.ca_application('doctor9@ca.invalid',
  'ca110000-0000-4000-8000-00000000000b')).id), 'details_mismatch', 'Synthetic rejection of P9 at Y',
  'clinician-suite-reject-p9-y', repeat('e', 64));
reset role;
do $$
declare
  assignment uuid;
begin
  select role_grant.account_role_id into assignment from identity.workforce_role_grants role_grant
   where role_grant.membership_id = (pg_temp.ca_application('doctor9@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).membership_id;
  if (select attestation_id from identity.workforce_role_grants where account_role_id = assignment)
       <> current_setting('ca_suite.p9_w_attestation')::uuid
     or not auth.facility_role_is_effective(assignment)
     or (pg_temp.ca_application('doctor9@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).state <> 'rejected' then
    raise exception 'the approval did not rest on its own application''s attestation';
  end if;
end $$;

-- 13. Reserved attestations.
-- P2's attestation is under review: a generic grant on the membership D attached cannot use it.
set local role hid_identity_api_runtime;
select pg_temp.ca_as('b');
select pg_temp.ca_refused(format($c$select * from identity.admin_change_workforce_role(%L,
  'ca110000-0000-4000-8000-00000000000b', 1, 'nurse', 'grant', 'Synthetic generic grant of P2', 'clinician-suite-grant-p2',
  repeat('f', 64))$c$, (select id from identity.staff_facility_memberships
    where account_id = pg_temp.ca_account('nurse2@ca.invalid'))), 'WORKFORCE_ATTESTATION_REQUIRED');
reset role;
-- The same through the internal command with no pin (the NULL pitfall), as the owner.
select pg_temp.ca_as('b');
select pg_temp.ca_refused(format($c$select * from identity.workforce_change_role(%L, 'ca110000-0000-4000-8000-00000000000b', 1,
  'nurse', 'grant', 'Synthetic unpinned grant of P2', 'clinician-suite-grant-p2-null', repeat('f', 64), null)$c$,
  (select id from identity.staff_facility_memberships where account_id = pg_temp.ca_account('nurse2@ca.invalid'))),
  'WORKFORCE_ATTESTATION_REQUIRED');
-- A pin naming another application's attestation never unlocks it: P9's
-- rejected Y attestation, on a membership D attaches at U.
select pg_temp.ca_as('d');
select * from identity.admin_attach_workforce_member('ca110000-0000-4000-8000-00000000000f',
  pg_temp.ca_account('doctor9@ca.invalid'), null, null, 'Synthetic generic attach of P9 at U', 'clinician-suite-attach-p9-u',
  repeat('d', 64));
select pg_temp.ca_as('b');
select pg_temp.ca_refused(format($c$select * from identity.workforce_change_role(%L, 'ca110000-0000-4000-8000-00000000000f', 1,
  'doctor', 'grant', 'Synthetic pinned grant of P9', 'clinician-suite-grant-p9-pin', repeat('f', 64), %L)$c$,
  (select id from identity.staff_facility_memberships where account_id = pg_temp.ca_account('doctor9@ca.invalid')
     and facility_id = 'ca110000-0000-4000-8000-00000000000f'), current_setting('ca_suite.p9_y_attestation')),
  'WORKFORCE_ATTESTATION_REQUIRED');
-- Nor while that application is under review and not overdue: the pin
-- unlocks the attestation only for its own application's account and
-- facility. P2's Y attestation, pinned on a membership D attaches for P2 at U
-- (rolled back afterwards: P2 keeps its one membership).
savepoint ca_pin_unbound;
select pg_temp.ca_as('d');
select * from identity.admin_attach_workforce_member('ca110000-0000-4000-8000-00000000000f',
  pg_temp.ca_account('nurse2@ca.invalid'), null, null, 'Synthetic generic attach of P2 at U', 'clinician-suite-attach-p2-u',
  repeat('d', 64));
select pg_temp.ca_as('b');
do $$ begin
  if (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).state <> 'under_review'
     or (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).expires_at <= clock_timestamp() then
    raise exception 'the pinned case needs P2''s Y application under review and not overdue';
  end if;
end $$;
select pg_temp.ca_refused(format($c$select * from identity.workforce_change_role(%L, 'ca110000-0000-4000-8000-00000000000f', 1,
  'nurse', 'grant', 'Synthetic pinned grant of P2 at U', 'clinician-suite-grant-p2-pin', repeat('f', 64), %L)$c$,
  (select id from identity.staff_facility_memberships where account_id = pg_temp.ca_account('nurse2@ca.invalid')
     and facility_id = 'ca110000-0000-4000-8000-00000000000f'),
  (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).attestation_id),
  'WORKFORCE_ATTESTATION_REQUIRED');
-- The reservation itself: the pin unlocks only its own application's account and facility.
do $$
declare
  attestation uuid := (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).attestation_id;
  account uuid := pg_temp.ca_account('nurse2@ca.invalid');
begin
  if not identity.workforce_attestation_usable(attestation, attestation, account, 'ca110000-0000-4000-8000-00000000000b')
     or identity.workforce_attestation_usable(attestation, attestation, account, 'ca110000-0000-4000-8000-00000000000f')
     or identity.workforce_attestation_usable(attestation, attestation, pg_temp.ca_account('doctor9@ca.invalid'),
       'ca110000-0000-4000-8000-00000000000b')
     or identity.workforce_attestation_usable(attestation, null, account, 'ca110000-0000-4000-8000-00000000000b') then
    raise exception 'a pin unlocked a reserved attestation outside its own application';
  end if;
end $$;
rollback to savepoint ca_pin_unbound;
-- After approval an attestation behaves as any 0087 one: the generic grant at U
-- rests on P9's approved W attestation, not the longer rejected Y one.
set local role hid_identity_api_runtime;
select pg_temp.ca_as('b');
do $$
declare
  result record;
begin
  select * into result from identity.admin_change_workforce_role((select id from identity.staff_facility_memberships
      where account_id = pg_temp.ca_account('doctor9@ca.invalid') and facility_id = 'ca110000-0000-4000-8000-00000000000f'),
    'ca110000-0000-4000-8000-00000000000f', 1, 'doctor', 'grant', 'Synthetic generic grant of P9 at U',
    'clinician-suite-grant-p9-u', repeat('f', 64));
  if result.attestation_id <> current_setting('ca_suite.p9_w_attestation')::uuid or not result.role_active then
    raise exception 'a generic grant did not rest on the approved attestation: %', row_to_json(result);
  end if;
end $$;
-- Withdrawn, expired by the sweeper, and overdue but not swept: still reserved.
select pg_temp.ca_ready('p10', 'doctor10@ca.invalid', 'Doctor Ten', 'ca110000-0000-4000-8000-00000000000b',
  (select licence_400 from ca_dates));
select pg_temp.ca_attest('a', (pg_temp.ca_application('doctor10@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  now() + interval '300 days', 'p10');
select pg_temp.ca_ready('p11', 'doctor11@ca.invalid', 'Doctor Eleven', 'ca110000-0000-4000-8000-00000000000b',
  (select licence_400 from ca_dates));
select pg_temp.ca_attest('a', (pg_temp.ca_application('doctor11@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  now() + interval '300 days', 'p11');
select pg_temp.ca_ready('p12', 'doctor12@ca.invalid', 'Doctor Twelve', 'ca110000-0000-4000-8000-00000000000b',
  (select licence_400 from ca_dates));
select pg_temp.ca_attest('a', (pg_temp.ca_application('doctor12@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  now() + interval '300 days', 'p12');
select pg_temp.ca_system('p10-withdraw');
select identity.withdraw_clinician_application(pg_temp.ca_h('session:p10-account'),
  (pg_temp.ca_application('doctor10@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id, 3);
reset role;
select pg_temp.ca_age((pg_temp.ca_application('doctor11@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  interval '31 days');
select pg_temp.ca_age((pg_temp.ca_application('doctor12@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  interval '31 days');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('sweep-p11');
do $$ begin
  if identity.expire_clinician_applications(500) < 2 then raise exception 'the sweep expired too few applications'; end if;
end $$;
reset role;
-- P12 overdue but not swept: a skipped (locked) row is not swept; re-age it after the sweep.
do $$ begin
  if (pg_temp.ca_application('doctor11@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).state <> 'expired' then
    raise exception 'the sweeper did not record P11 as expired';
  end if;
end $$;
-- A fresh P13 under review, made overdue after the sweep and not swept.
set local role hid_identity_api_runtime;
select pg_temp.ca_ready('p13', 'doctor13@ca.invalid', 'Doctor Thirteen', 'ca110000-0000-4000-8000-00000000000b',
  (select licence_400 from ca_dates));
select pg_temp.ca_attest('a', (pg_temp.ca_application('doctor13@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  now() + interval '300 days', 'p13');
reset role;
select pg_temp.ca_age((pg_temp.ca_application('doctor13@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  interval '31 days');
set local role hid_identity_api_runtime;
do $$
declare
  email text;
  membership uuid;
begin
  foreach email in array array['doctor10@ca.invalid', 'doctor11@ca.invalid', 'doctor13@ca.invalid'] loop
    perform pg_temp.ca_as('d');
    select membership_id into membership from identity.admin_attach_workforce_member('ca110000-0000-4000-8000-00000000000d',
      pg_temp.ca_account(email), null, null, 'Synthetic generic attach at W', 'clinician-suite-attach-w-' || email,
      repeat('d', 64));
    perform pg_temp.ca_as('b');
    begin
      perform * from identity.admin_change_workforce_role(membership, 'ca110000-0000-4000-8000-00000000000d', 1, 'doctor',
        'grant', 'Synthetic generic grant at W', 'clinician-suite-grant-w-' || email, repeat('f', 64));
      raise exception 'a generic grant used the reserved attestation of %', email;
    exception when others then
      if sqlerrm <> 'WORKFORCE_ATTESTATION_REQUIRED' then raise; end if;
    end;
  end loop;
end $$;
select pg_temp.ca_refused(format($c$select pg_temp.ca_approve('b', %L, 3, 'p13')$c$,
  (pg_temp.ca_application('doctor13@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id),
  'CLINICIAN_APPLICATION_STATE_INVALID');
-- The workforce profile marks reserved and usable attestations; every 0087 key is kept.
select pg_temp.ca_as('b');
do $$
declare
  profile jsonb;
  attestation jsonb;
begin
  profile := identity.admin_workforce_profile(pg_temp.ca_account('doctor9@ca.invalid'));
  for attestation in select * from jsonb_array_elements(profile->'attestations') loop
    if (select array_agg(key order by key) from jsonb_object_keys(attestation) key) <> (select array_agg(key order by key)
         from unnest(array['attestedRoles', 'clinicianApplication', 'credentialReference', 'current', 'evidenceReference', 'id',
           'issuingAuthority', 'reviewerAccountId', 'recordedAt', 'usableForGrant', 'validUntil', 'verificationMethod']) key) then
      raise exception 'the profile attestation keys changed: %', attestation;
    end if;
    if (attestation->>'id' = current_setting('ca_suite.p9_y_attestation')
         and (attestation->'clinicianApplication'->>'state' <> 'rejected' or (attestation->>'usableForGrant')::boolean))
       or (attestation->>'id' = current_setting('ca_suite.p9_w_attestation')
         and (attestation->'clinicianApplication'->>'state' <> 'approved' or not (attestation->>'usableForGrant')::boolean)) then
      raise exception 'the profile does not mark the reservation: %', attestation;
    end if;
  end loop;
  profile := identity.admin_workforce_profile(pg_temp.ca_account('nurse2@ca.invalid'));
  if profile->'attestations'->0->'clinicianApplication'->>'state' <> 'under_review'
     or (profile->'attestations'->0->>'usableForGrant')::boolean then
    raise exception 'an attestation under review is shown as usable: %', profile->'attestations';
  end if;
  profile := identity.admin_workforce_profile('ca200000-0000-4000-8000-000000000003');
  if profile->'attestations'->0->'clinicianApplication' <> 'null'::jsonb
     or not (profile->'attestations'->0->>'usableForGrant')::boolean then
    raise exception 'a 0087 attestation without an application is not usable: %', profile->'attestations';
  end if;
end $$;

-- 14. Reject.
reset role;
create temporary table ca_snapshot on commit drop as
select (select count(*) from auth.account_roles) as roles,
  (select count(*) from identity.staff_facility_memberships) as memberships,
  (select count(*) from identity.staff_credential_attestations) as attestations,
  (select count(*) from identity.workforce_role_grants) as grants,
  (select count(*) from auth.account_roles where revoked_at is not null) as revoked;
grant select on ca_snapshot to public;
set local role hid_identity_api_runtime;
select pg_temp.ca_system('p14');
select pg_temp.ca_draft('p14', 'doctor14@ca.invalid');
select pg_temp.ca_submit('p14', 'doctor14@ca.invalid', 'Doctor Fourteen', 'doctor', 'MDCN', 'MDCN/14',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000a');
create function pg_temp.ca_reject(admin text, application uuid, code text, key text) returns record
language plpgsql as $$
declare
  result record;
begin
  perform pg_temp.ca_as(admin);
  select * into result from identity.admin_reject_clinician_application(application,
    pg_temp.ca_version(application), code, 'Synthetic internal rejection reason', 'clinician-suite-reject-' || key,
    pg_temp.ca_h('reject:' || key));
  return result;
end $$;
grant execute on function pg_temp.ca_reject(text, uuid, text, text) to public;
-- An insider, a code not on the list, and a terminal application are refused.
select pg_temp.ca_refused(format($c$select pg_temp.ca_reject('c', %L, 'other', 'p14-c')$c$,
  (pg_temp.ca_application('doctor14@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).id), 'WORKFORCE_FACILITY_CONFLICT');
select pg_temp.ca_refused(format($c$select pg_temp.ca_reject('a', %L, 'fraud', 'p14-bad')$c$,
  (pg_temp.ca_application('doctor14@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).id),
  'CLINICIAN_APPLICATION_COMMAND_INVALID');
select pg_temp.ca_refused(format($c$select pg_temp.ca_reject('a', %L, 'other', 'p1x')$c$, (select p1x from ca_step)),
  'CLINICIAN_APPLICATION_STATE_INVALID');
select pg_temp.ca_refused(format($c$select pg_temp.ca_reject('t', %L, 'other', 'own')$c$,
  (pg_temp.ca_application('super-t@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id), 'WORKFORCE_SELF_CHANGE_DENIED');
do $$
declare
  result record;
begin
  -- From each open state: awaiting_authenticator (P14), submitted (P4 at U is awaiting; T at Y is submitted), under_review (P6).
  result := pg_temp.ca_reject('a', (pg_temp.ca_application('doctor14@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).id,
    'licence_not_verified', 'p14');
  if result is null then raise exception 'no result'; end if;
  perform pg_temp.ca_reject('a', (pg_temp.ca_application('super-t@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
    'employment_not_confirmed', 't');
  perform pg_temp.ca_reject('d', (pg_temp.ca_application('doctor6@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id,
    'other', 'p6');
end $$;
-- identity_not_confirmed on P1 at W: P1's other open application (Y) can no
-- longer pass step 1, the account can file nothing more, and P1's approved
-- access at X is untouched.
select * from pg_temp.ca_reject('a', (pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).id,
  'identity_not_confirmed', 'p1-w') as result(application_id uuid, state text, decision_code text, from_state text,
  account_id uuid, facility_id uuid, further_applications_blocked boolean, application_version bigint, replayed boolean);
select pg_temp.ca_refused(format($c$select pg_temp.ca_attest('b', %L, now() + interval '100 days', 'p1-y')$c$,
  (pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id),
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
select pg_temp.ca_as('b');
select pg_temp.ca_refused(format($c$select identity.admin_clinician_application_attest_precheck(%L, %s)$c$,
  (pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  pg_temp.ca_version((pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id)),
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
select pg_temp.ca_system('p1-blocked');
select pg_temp.ca_refused($c$select pg_temp.ca_file('p1-u2', 'p1-account', 'ca110000-0000-4000-8000-00000000000f')$c$,
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
do $$
declare
  view jsonb;
  rejected jsonb;
begin
  view := identity.current_clinician_applications(pg_temp.ca_h('session:p1-account'));
  select application into rejected from jsonb_array_elements(view->'applications') application
   where application->>'state' = 'rejected';
  if (view->>'canApply')::boolean or view->>'applyRefusal' <> 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE'
     or rejected->>'decisionCode' <> 'identity_not_confirmed' or view::text like '%Synthetic internal rejection%' then
    raise exception 'the applicant view after an identity refusal is wrong: %', view;
  end if;
end $$;
select pg_temp.ca_as('b');
do $$ begin
  if not (identity.admin_get_clinician_application((pg_temp.ca_application('doctor1@ca.invalid',
       'ca110000-0000-4000-8000-00000000000b')).id)->'account'->>'identityRejection')::boolean
     or identity.admin_get_clinician_application((pg_temp.ca_application('doctor1@ca.invalid',
       'ca110000-0000-4000-8000-00000000000b')).id)->'callerHints'->'attest'->>'reason' <> 'ACCOUNT_INELIGIBLE' then
    raise exception 'an identity refusal is not shown on the account''s other application';
  end if;
end $$;
reset role;
do $$ begin
  -- Rejecting revoked nothing: no role, membership, attestation or grant changed.
  if (select roles from ca_snapshot) <> (select count(*) from auth.account_roles)
     or (select revoked from ca_snapshot) <> (select count(*) from auth.account_roles where revoked_at is not null)
     or (select memberships from ca_snapshot) <> (select count(*) from identity.staff_facility_memberships)
     or (select attestations from ca_snapshot) <> (select count(*) from identity.staff_credential_attestations)
     or (select grants from ca_snapshot) <> (select count(*) from identity.workforce_role_grants)
     or not auth.membership_has_permission((select subject from auth.accounts where email = 'doctor1@ca.invalid'),
       current_setting('ca_suite.p1_membership')::uuid, 'ca110000-0000-4000-8000-00000000000a', 'identity.patient.read') then
    raise exception 'a rejection changed a role, membership, attestation or grant';
  end if;
  if (pg_temp.ca_application('doctor6@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).decision_reason
       <> 'Synthetic internal rejection reason'
     or (pg_temp.ca_application('doctor6@ca.invalid', 'ca110000-0000-4000-8000-00000000000d')).decided_by
       <> 'ca200000-0000-4000-8000-000000000005'
     or (select response->>'fromState' from auth.admin_command_idempotency where idempotency_key = 'clinician-suite-reject-p6')
       <> 'under_review'
     or (select (response->>'furtherApplicationsBlocked')::boolean from auth.admin_command_idempotency
          where idempotency_key = 'clinician-suite-reject-p1-w') is not true then
    raise exception 'a rejection did not record its decision';
  end if;
end $$;
-- An identity refusal also stops the approval of the account's application
-- that passed step 1 before it: the person behind the account could not be
-- confirmed, so no second Super Admin may grant on the earlier check. The
-- approval hint says so too.
select pg_temp.ca_ready('p14i', 'doctor14i@ca.invalid', 'Doctor Fourteen I', 'ca110000-0000-4000-8000-00000000000a',
  (select licence_400 from ca_dates));
select pg_temp.ca_system('p14i-file');
select pg_temp.ca_file('p14i-y', 'p14i-account', 'ca110000-0000-4000-8000-00000000000b');
select pg_temp.ca_attest('a', (pg_temp.ca_application('doctor14i@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).id,
  now() + interval '100 days', 'p14i-x');
select * from pg_temp.ca_reject('a', (pg_temp.ca_application('doctor14i@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
  'identity_not_confirmed', 'p14i-y') as result(application_id uuid, state text, decision_code text, from_state text,
  account_id uuid, facility_id uuid, further_applications_blocked boolean, application_version bigint, replayed boolean);
select pg_temp.ca_as('b');
select pg_temp.ca_refused(format($c$select pg_temp.ca_approve('b', %L, %s, 'p14i-x')$c$,
  (pg_temp.ca_application('doctor14i@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).id,
  pg_temp.ca_version((pg_temp.ca_application('doctor14i@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).id)),
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
do $$
declare
  hint jsonb := identity.admin_get_clinician_application(
    (pg_temp.ca_application('doctor14i@ca.invalid', 'ca110000-0000-4000-8000-00000000000a')).id)->'callerHints'->'approve';
begin
  if (hint->>'allowed')::boolean or hint->>'reason' <> 'ACCOUNT_INELIGIBLE' then
    raise exception 'the approval hint ignores an identity refusal: %', hint;
  end if;
end $$;

-- 15. Withdraw, and ending a capability.
set local role hid_identity_api_runtime;
select pg_temp.ca_system('withdraw');
select pg_temp.ca_draft('p15', 'doctor15@ca.invalid');
select pg_temp.ca_submit('p15', 'doctor15@ca.invalid', 'Doctor Fifteen', 'doctor', 'MDCN', 'MDCN/15',
  (select licence_400 from ca_dates), 'ca110000-0000-4000-8000-00000000000b');
select pg_temp.ca_refused(format($c$select identity.withdraw_clinician_application(pg_temp.ca_h('session:p15-account'), %L, 1)$c$,
  (select p1x from ca_step)), 'CLINICIAN_APPLICATION_NOT_FOUND');
select pg_temp.ca_refused($c$select identity.withdraw_clinician_application(pg_temp.ca_h('session:p15-account'),
  'ca999999-0000-4000-8000-000000000001', 1)$c$, 'CLINICIAN_APPLICATION_NOT_FOUND');
select pg_temp.ca_refused(format($c$select identity.withdraw_clinician_application(pg_temp.ca_h('session:p1-account'), %L, 4)$c$,
  (select p1x from ca_step)), 'CLINICIAN_APPLICATION_STATE_INVALID');
select pg_temp.ca_refused(format($c$select identity.withdraw_clinician_application(pg_temp.ca_h('session:p1-status'), %L, 2)$c$,
  (pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id),
  'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED');
select pg_temp.ca_refused_with(format($c$select identity.withdraw_clinician_application(pg_temp.ca_h('session:p2-status'), %L, 2)$c$,
  (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id),
  '40001', 'CLINICIAN_APPLICATION_VERSION_CONFLICT');
-- A capability's stage is checked again against its account. An
-- enrolment_required capability of an account that has since set up its
-- authenticator (P2's, opened at that stage) needs the code before it reads
-- or withdraws; a capability of an account that has been disabled (the fraud
-- runbook's lock) serves nothing more (the account cannot use it).
reset role;
select pg_temp.ca_capability('p2-stale', pg_temp.ca_account('nurse2@ca.invalid'), 'enrolment_required');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('withdraw-stale');
select pg_temp.ca_refused($c$select identity.current_clinician_applications(pg_temp.ca_h('session:p2-stale'))$c$,
  'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED');
select pg_temp.ca_refused(format($c$select identity.withdraw_clinician_application(pg_temp.ca_h('session:p2-stale'), %L, 3)$c$,
  (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id),
  'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED');
reset role;
update auth.accounts set disabled_until = clock_timestamp() + interval '1 hour'
 where id = pg_temp.ca_account('nurse2@ca.invalid');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('withdraw-locked');
select pg_temp.ca_refused($c$select identity.current_clinician_applications(pg_temp.ca_h('session:p2-status'))$c$,
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
select pg_temp.ca_refused(format($c$select identity.withdraw_clinician_application(pg_temp.ca_h('session:p2-status'), %L, 3)$c$,
  (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id),
  'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE');
reset role;
update auth.accounts set disabled_until = null where id = pg_temp.ca_account('nurse2@ca.invalid');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('withdraw');
do $$
declare
  view jsonb;
  again jsonb;
  attestation uuid := (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).attestation_id;
begin
  -- At stage enrolment_required (just submitted), and at ready from under_review.
  view := identity.withdraw_clinician_application(pg_temp.ca_h('session:p15-account'),
    (pg_temp.ca_application('doctor15@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id, 1);
  if view->>'state' <> 'withdrawn' or (view->>'canWithdraw')::boolean or (view->>'version')::integer <> 2 then
    raise exception 'withdrawing did not end the application: %', view;
  end if;
  again := identity.withdraw_clinician_application(pg_temp.ca_h('session:p15-account'),
    (pg_temp.ca_application('doctor15@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id, 1);
  if again <> view then raise exception 'withdrawing again changed the application: %', again; end if;
  view := identity.withdraw_clinician_application(pg_temp.ca_h('session:p2-status'),
    (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id, 3);
  if view->>'state' <> 'withdrawn' then raise exception 'an application under review was not withdrawn: %', view; end if;
  if (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).attestation_id <> attestation then
    raise exception 'withdrawing touched the attestation';
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from audit.events where action = 'identity.clinician-application.withdrawn'
       and resource_id = (pg_temp.ca_application('doctor15@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id::text) <> 1
     or (select details->>'fromState' from audit.events where action = 'identity.clinician-application.withdrawn'
       and resource_id = (pg_temp.ca_application('nurse2@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id::text)
       <> 'under_review'
     or (select details->>'fromState' from audit.events where action = 'identity.clinician-application.withdrawn'
       and resource_id = (pg_temp.ca_application('doctor15@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id::text)
       <> 'awaiting_authenticator'
     or (select count(*) from identity.staff_facility_memberships where account_id = pg_temp.ca_account('nurse2@ca.invalid')) <> 1
     or (select count(*) from identity.staff_credential_attestations where account_id = pg_temp.ca_account('nurse2@ca.invalid')) <> 1 then
    raise exception 'withdrawal audit or side effects are not as specified';
  end if;
end $$;
-- Ending a capability ends it and invalidates the 0088 challenge it drives.
insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
  expires_at, max_attempts, session_kind)
values ('ca400000-0000-4000-8000-000000000015', pg_temp.ca_account('doctor15@ca.invalid'), 'enroll', pg_temp.ca_h('mfa:p15'), 1,
  now(), now() + interval '10 minutes', 5, 'staff');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('end');
select identity.bind_clinician_application_mfa_challenge(pg_temp.ca_h('session:p15-account'),
  'ca400000-0000-4000-8000-000000000015');
select identity.end_clinician_application_session(pg_temp.ca_h('session:p15-account'));
select identity.end_clinician_application_session(pg_temp.ca_h('session:p15-account'));
select identity.end_clinician_application_session(pg_temp.ca_h('session:never-issued'));
select pg_temp.ca_refused($c$select identity.current_clinician_applications(pg_temp.ca_h('session:p15-account'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
select pg_temp.ca_refused($c$select * from identity.clinician_application_session(pg_temp.ca_h('session:p15-account'))$c$,
  'CLINICIAN_APPLICATION_SESSION_INVALID');
reset role;
do $$ begin
  if (select invalidation_reason from auth.mfa_login_challenges where id = 'ca400000-0000-4000-8000-000000000015')
       is distinct from 'superseded' then
    raise exception 'ending a capability left its 0088 challenge live';
  end if;
end $$;

-- 16. Expiry and pruning.
-- P7 (submitted) and P10's... P7 is moved past its expiry and not swept:
-- every read shows it expired and every command refuses it.
select pg_temp.ca_age((pg_temp.ca_application('ada@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id, interval '30 days');
set local role hid_identity_api_runtime;
select pg_temp.ca_system('expiry');
do $$
declare
  view jsonb;
begin
  view := identity.current_clinician_applications(pg_temp.ca_h('session:p7-account'));
  if view->'applications'->0->>'state' <> 'expired' or (view->'applications'->0->>'canWithdraw')::boolean
     or view->'applications'->0->>'decidedAt' is null then
    raise exception 'an overdue application is not shown as expired: %', view;
  end if;
end $$;
select pg_temp.ca_refused(format($c$select identity.withdraw_clinician_application(pg_temp.ca_h('session:p7-account'), %L, 2)$c$,
  (pg_temp.ca_application('ada@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id), 'CLINICIAN_APPLICATION_STATE_INVALID');
select pg_temp.ca_refused(format($c$select pg_temp.ca_attest('a', %L, now() + interval '100 days', 'p7')$c$,
  (pg_temp.ca_application('ada@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id), 'CLINICIAN_APPLICATION_STATE_INVALID');
select pg_temp.ca_refused(format($c$select pg_temp.ca_reject('a', %L, 'other', 'p7')$c$,
  (pg_temp.ca_application('ada@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id), 'CLINICIAN_APPLICATION_STATE_INVALID');
select pg_temp.ca_system('sweep');
select pg_temp.ca_refused($c$select identity.expire_clinician_applications(0)$c$, 'CLINICIAN_APPLICATION_INVALID');
reset role;
create temporary table ca_before_sweep on commit drop as
select (pg_temp.ca_application('ada@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).*;
set local role hid_identity_api_runtime;
select pg_temp.ca_system('sweep');
do $$ begin
  if identity.expire_clinician_applications(500) < 1 then raise exception 'the sweep expired nothing'; end if;
end $$;
reset role;
do $$
declare
  after identity.clinician_applications%rowtype := pg_temp.ca_application('ada@ca.invalid', 'ca110000-0000-4000-8000-00000000000b');
  before identity.clinician_applications%rowtype;
begin
  select * into before from ca_before_sweep;
  if after.state <> 'expired' or after.expired_at is null or after.row_version <> before.row_version + 1
     or after.attested_at is distinct from before.attested_at or after.authenticator_ready_at <> before.authenticator_ready_at
     or (select details->>'fromState' from audit.events where action = 'identity.clinician-application.expired'
          and resource_id = after.id::text) <> 'submitted'
     or exists (select 1 from identity.clinician_applications where state in ('awaiting_authenticator', 'submitted', 'under_review')
          and expires_at <= clock_timestamp()) then
    raise exception 'the sweep did not record exactly the expiry: %', row_to_json(after);
  end if;
end $$;
-- Pruning removes only stale artefacts.
insert into identity.clinician_application_challenges (id, purpose, email_hmac, code_hmac, created_at, expires_at) values
  ('ca300000-0000-4000-8000-000000000091', 'signup', pg_temp.ca_h('email:stale'), pg_temp.ca_h('code:stale'),
   now() - interval '3 days', now() - interval '3 days' + interval '10 minutes'),
  ('ca300000-0000-4000-8000-000000000092', 'signup', pg_temp.ca_h('email:recent'), pg_temp.ca_h('code:recent'),
   now() - interval '1 day', now() - interval '1 day' + interval '10 minutes');
insert into identity.clinician_application_sessions (id, token_hmac, kind, account_id, stage, created_at, expires_at) values
  ('ca410000-0000-4000-8000-000000000091', pg_temp.ca_h('session:stale'), 'account', pg_temp.ca_account('doctor1@ca.invalid'),
   'ready', now() - interval '3 days', now() - interval '3 days' + interval '30 minutes'),
  ('ca410000-0000-4000-8000-000000000092', pg_temp.ca_h('session:recent'), 'account', pg_temp.ca_account('doctor1@ca.invalid'),
   'ready', now() - interval '1 day', now() - interval '1 day' + interval '30 minutes');
insert into identity.clinician_application_idempotency (account_id, idempotency_key, request_sha256, response, created_at) values
  (pg_temp.ca_account('doctor1@ca.invalid'), 'clinician-suite-stale-key-1', repeat('a', 64), '{}', now() - interval '31 days'),
  (pg_temp.ca_account('doctor1@ca.invalid'), 'clinician-suite-fresh-key-1', repeat('a', 64), '{}', now() - interval '29 days');
insert into platform.clinician_application_quota_counters (scope, operation, scope_key, bucket_period, bucket_start, attempt_count)
values ('network', 'submit', pg_temp.ca_h('stale-network'), 'day', date_trunc('day', now() - interval '3 days'), 1);
set local role hid_identity_api_runtime;
select pg_temp.ca_system('prune');
do $$ begin
  if identity.prune_clinician_application_artifacts() < 4 then raise exception 'pruning removed too little'; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.clinician_application_challenges where id = 'ca300000-0000-4000-8000-000000000091')
     or not exists (select 1 from identity.clinician_application_challenges where id = 'ca300000-0000-4000-8000-000000000092')
     or exists (select 1 from identity.clinician_application_sessions where id = 'ca410000-0000-4000-8000-000000000091')
     or not exists (select 1 from identity.clinician_application_sessions where id = 'ca410000-0000-4000-8000-000000000092')
     or exists (select 1 from identity.clinician_application_idempotency where idempotency_key = 'clinician-suite-stale-key-1')
     or not exists (select 1 from identity.clinician_application_idempotency where idempotency_key = 'clinician-suite-fresh-key-1')
     or exists (select 1 from platform.clinician_application_quota_counters where scope_key = pg_temp.ca_h('stale-network'))
     or not exists (select 1 from identity.clinician_applications where id = (select p1x from ca_step)) then
    raise exception 'pruning removed a fresh row or kept a stale one';
  end if;
end $$;

-- 17. Guard and checks (as the owner).
do $$
declare
  probe record;
  p1x uuid := (select p1x from ca_step);
begin
  for probe in select * from (values
    ('approved to rejected', $u$update identity.clinician_applications set state = 'rejected', decided_by = 'ca200000-0000-4000-8000-000000000005',
       decided_at = now(), decision_code = 'other', decision_reason = 'Synthetic late rejection', row_version = row_version + 1
       where id = %L$u$),
    ('a licence change', $u$update identity.clinician_applications set licence_number = 'MDCN/54321', row_version = row_version + 1
       where id = %L$u$),
    ('a facility change', $u$update identity.clinician_applications set facility_id = 'ca110000-0000-4000-8000-00000000000b',
       row_version = row_version + 1 where id = %L$u$),
    ('a new expiry', $u$update identity.clinician_applications set submitted_at = submitted_at + interval '1 day',
       expires_at = expires_at + interval '1 day', row_version = row_version + 1 where id = %L$u$),
    ('another attester', $u$update identity.clinician_applications set attested_by = 'ca200000-0000-4000-8000-000000000005',
       row_version = row_version + 1 where id = %L$u$),
    ('an unversioned update', $u$update identity.clinician_applications set updated_at = now() where id = %L$u$),
    ('a delete', $u$delete from identity.clinician_applications where id = %L$u$)) probes(label, statement)
  loop
    begin
      execute format(probe.statement, p1x);
      raise exception 'the guard allowed %', probe.label;
    exception when others then
      if sqlerrm <> 'CLINICIAN_APPLICATION_IMMUTABLE' then raise; end if;
    end;
  end loop;
  -- Transitions outside the state machine.
  for probe in select * from (values
    ('awaiting to under_review', (pg_temp.ca_application('doctor4@ca.invalid', 'ca110000-0000-4000-8000-00000000000f')).id,
     $u$update identity.clinician_applications set state = 'under_review', row_version = row_version + 1 where id = %L$u$),
    ('submitted to approved', (pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
     $u$update identity.clinician_applications set state = 'approved', row_version = row_version + 1 where id = %L$u$),
    ('withdrawn to submitted', (pg_temp.ca_application('doctor15@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
     $u$update identity.clinician_applications set state = 'submitted', withdrawn_at = null, authenticator_ready_at = now(),
       row_version = row_version + 1 where id = %L$u$),
    ('submitted back to awaiting', (pg_temp.ca_application('doctor1@ca.invalid', 'ca110000-0000-4000-8000-00000000000b')).id,
     $u$update identity.clinician_applications set state = 'awaiting_authenticator', authenticator_ready_at = null,
       row_version = row_version + 1 where id = %L$u$)) probes(label, target, statement)
  loop
    begin
      execute format(probe.statement, probe.target);
      raise exception 'the guard allowed %', probe.label;
    exception when others then
      if sqlerrm <> 'CLINICIAN_APPLICATION_IMMUTABLE' then raise; end if;
    end;
  end loop;
  -- Hand-made rows each break one check.
  for probe in select * from (values
    ('clinician_applications_expiry_check', 'awaiting_authenticator', interval '29 days', false, false, false),
    ('clinician_applications_lifecycle_check', 'submitted', interval '30 days', false, false, false),
    ('clinician_applications_lifecycle_check', 'awaiting_authenticator', interval '30 days', true, false, false),
    ('clinician_applications_lifecycle_check', 'rejected', interval '30 days', false, false, true),
    ('clinician_applications_lifecycle_check', 'withdrawn', interval '30 days', false, false, false),
    ('clinician_applications_lifecycle_check', 'expired', interval '30 days', false, true, false)) probes(name, state,
      window_length, ready, withdrawn, expired)
  loop
    begin
      insert into identity.clinician_applications (id, account_id, staff_id, facility_id, requested_role, regulator_code,
        issuing_authority, licence_number, licence_valid_until, applicant_full_name, state, submitted_at, expires_at,
        authenticator_ready_at, withdrawn_at, expired_at, correlation_id, updated_at)
      values (gen_random_uuid(), 'ca200000-0000-4000-8000-000000000003', 'ca210000-0000-4000-8000-000000000003',
        'ca110000-0000-4000-8000-00000000000b', 'doctor', 'MDCN', 'Medical and Dental Council of Nigeria', 'MDCN/77',
        current_date + 100, 'Super Admin C', probe.state, now(), now() + probe.window_length,
        case when probe.ready then now() end, case when probe.withdrawn then now() end,
        case when probe.expired then now() end, 'clinician-suite-owner', now());
      raise exception 'a % row passed %', probe.state, probe.name;
    exception when check_violation then
      if position(probe.name in sqlerrm) = 0 then raise; end if;
    end;
  end loop;
end $$;

rollback;
