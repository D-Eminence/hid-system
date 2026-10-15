\set ON_ERROR_STOP on
begin;

-- 0094 (ADR-063): facility-assisted registration. A person proves in person
-- at a participating facility that they hold the NIN of an enrollment they
-- started on their own device. This suite checks the designation command and
-- its events, the permission and who holds it, the staff command that records
-- an in-person check (authorization in SQL, budgets, replay, audit), the
-- holder proof's in-person method, activation after an in-person proof, the
-- desk-code rules and that no runtime role reaches the new tables directly.
-- Rollback-only; every NIN, name and contact is invented, digests are fixture
-- bytes and the Argon2-shaped hash is inert.

-- Fixture helpers, used only inside this transaction.
create function pg_temp.expect_refusal(statement text, expected_state text, expected_message text, label text)
returns void language plpgsql as $$
declare
  state text;
  message text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics state = returned_sqlstate, message = message_text;
    if state <> expected_state or message <> expected_message then
      raise exception '%: refused with % % instead of % %', label, state, message, expected_state, expected_message;
    end if;
    return;
  end;
  raise exception '%: was not refused', label;
end $$;
-- A staff request context: the actor, its facility and membership, its
-- session and a correlation id, as Identity sets them.
create function pg_temp.as_staff(n text, requested_facility uuid, requested_membership uuid, requested_session uuid)
returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:far:' || n, true),
    set_config('app.facility_id', requested_facility::text, true),
    set_config('app.membership_id', requested_membership::text, true),
    set_config('app.session_id', coalesce(requested_session::text, ''), true),
    set_config('app.correlation_id', 'assisted-suite-staff-' || n, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true),
    set_config('app.access_scope', 'facility', true);
$$;
create function pg_temp.as_platform(n text) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:far:' || n, true),
    set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
    set_config('app.session_id', 'f9490000-0000-4000-8000-0000000000' || n, true),
    set_config('app.correlation_id', 'assisted-suite-platform-' || n, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true),
    set_config('app.access_scope', 'platform', true);
$$;
create function pg_temp.as_system(correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'system:auth', true),
    set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
    set_config('app.session_id', '', true), set_config('app.access_scope', '', true),
    set_config('app.correlation_id', correlation, true);
$$;
-- Records a check with fixture digests: the key and request digests come
-- from `label`, the desk code digest from `desk`.
create function pg_temp.record_check(label text, requested_enrollment uuid, requested_nin char(64), desk text,
  requested_outcome text, staff_limit integer default 20, facility_limit integer default 100,
  requested_request text default null)
returns setof record language sql as $$
  select verification_id, outcome, replayed, proof_outcome
    from identity.record_assisted_verification(requested_enrollment, requested_nin,
      encode(public.digest('desk:' || desk, 'sha256'), 'hex')::char(64), 'government_photo_id_in_person',
      'national_id_card', requested_outcome,
      case requested_outcome when 'matched' then 'match' when 'not_matched' then 'no_match' end,
      case requested_outcome when 'code_not_found' then null else 'match' end,
      case requested_outcome when 'code_not_found' then null else 'not_in_record' end,
      encode(public.digest('key:' || label, 'sha256'), 'hex')::char(64),
      encode(public.digest('request:' || coalesce(requested_request, label), 'sha256'), 'hex')::char(64),
      staff_limit, facility_limit)
$$;
-- A started enrollment at verify_holder with a desk code (digest of `desk`).
create function pg_temp.seed_enrollment(requested_id uuid, requested_nin char(64), requested_token char(64),
  reference text, desk text, nin_last4 text default '9401')
returns void language sql as $$
  insert into identity.public_patient_enrollments (id, nin_lookup_hmac, nin_last4, nin_ciphertext,
    profile_ciphertext, profile_sha256, key_version, provider_reference, request_hmac, token_hmac,
    desk_code_hmac, desk_code_expires_at, desk_code_salt, desk_code_issues)
  values (requested_id, requested_nin, nin_last4, decode(repeat('a1',32),'hex'), decode(repeat('b1',32),'hex'),
    encode(public.digest('{"nin":"1234567' || nin_last4 || '","firstName":"Ada","lastName":"Synthetic","dateOfBirth":"1990-01-02","gender":"female","providerReference":"' || reference || '"}', 'sha256'), 'hex'),
    'fixture', reference, encode(public.digest(requested_id::text, 'sha256'), 'hex'), requested_token,
    case when desk is null then null else encode(public.digest('desk:' || desk, 'sha256'), 'hex') end,
    case when desk is null then null else clock_timestamp() + interval '23 hours' end,
    case when desk is null then null else repeat('5a', 16) end,
    case when desk is null then 0 else 1 end);
$$;

-- Organizations and facilities: A and B verified and designated below, C
-- verified but never designated, D pending, E verified in an inactive
-- organization.
insert into identity.organizations (id, name, slug, active) values
  ('f9400000-0000-4000-8000-000000000001', 'Assisted Suite Organization', 'assisted-suite-org', true),
  ('f9400000-0000-4000-8000-000000000002', 'Assisted Suite Closed Organization', 'assisted-suite-closed', false);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f9410000-0000-4000-8000-00000000000a', 'f9400000-0000-4000-8000-000000000001', 'Assisted Suite Clinic A', 'AS-SUITE-A', 'Africa/Lagos', true, 'verified'),
  ('f9410000-0000-4000-8000-00000000000b', 'f9400000-0000-4000-8000-000000000001', 'Assisted Suite Clinic B', 'AS-SUITE-B', 'Africa/Lagos', true, 'verified'),
  ('f9410000-0000-4000-8000-00000000000c', 'f9400000-0000-4000-8000-000000000001', 'Assisted Suite Clinic C', 'AS-SUITE-C', 'Africa/Lagos', true, 'verified'),
  ('f9410000-0000-4000-8000-00000000000d', 'f9400000-0000-4000-8000-000000000001', 'Assisted Suite Clinic D', 'AS-SUITE-D', 'Africa/Lagos', false, 'pending'),
  ('f9410000-0000-4000-8000-00000000000e', 'f9400000-0000-4000-8000-000000000002', 'Assisted Suite Clinic E', 'AS-SUITE-E', 'Africa/Lagos', true, 'verified');

-- Accounts:
--   01 platform_super_admin (designations, attestation reviewer)
--   02 support_admin (no platform.facility.manage)
--   11 nurse at A and at B, each role on a current attestation
--   12 nurse at A promoted by the legacy path: no workforce grant
--   13 org_admin at A (onboarding shape)
--   14 receptionist at A
--   15 nurse at C (not designated), on a current attestation
--   16 nurse at A on a current attestation, whose session has no MFA assurance
--   17 doctor at A whose attestation has lapsed
--   18 clinician at A on a current attestation
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm)
select ('f9420000-0000-4000-8000-0000000000' || n)::uuid, 'synthetic:far:' || n, 'far' || n || '@example.invalid',
  'active', 'synthetic-hash', 'argon2id'
from unnest(array['01', '02', '11', '12', '13', '14', '15', '16', '17', '18']) n;
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('f9450000-0000-4000-8000-0000000000f1', 'f9420000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform', 'Synthetic assisted suite role'),
  ('f9450000-0000-4000-8000-0000000000f2', 'f9420000-0000-4000-8000-000000000002', 'support_admin', 'platform', 'Synthetic assisted suite role');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('f9430000-0000-4000-8000-0000000000' || n)::uuid, ('f9420000-0000-4000-8000-0000000000' || n)::uuid,
  'Assisted Suite ' || n, 'far' || n || '@example.invalid', 'verified', role_name
from (values ('11', 'nurse'), ('12', 'nurse'), ('13', 'org_admin'), ('14', 'receptionist'), ('15', 'nurse'),
  ('16', 'nurse'), ('17', 'doctor'), ('18', 'clinician')) staff_rows(n, role_name);
-- Memberships and facility roles: id suffix = account; 11 also has b1 at B.
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select membership_id::uuid, ('f9430000-0000-4000-8000-0000000000' || n)::uuid,
  ('f9420000-0000-4000-8000-0000000000' || n)::uuid, 'f9400000-0000-4000-8000-000000000001', facility::uuid,
  role_name, role_name, primary_membership, true
from (values
  ('f9440000-0000-4000-8000-000000000011', '11', 'f9410000-0000-4000-8000-00000000000a', 'nurse', true),
  ('f9440000-0000-4000-8000-0000000001b1', '11', 'f9410000-0000-4000-8000-00000000000b', 'nurse', false),
  ('f9440000-0000-4000-8000-000000000012', '12', 'f9410000-0000-4000-8000-00000000000a', 'nurse', true),
  ('f9440000-0000-4000-8000-000000000013', '13', 'f9410000-0000-4000-8000-00000000000a', 'org_admin', true),
  ('f9440000-0000-4000-8000-000000000014', '14', 'f9410000-0000-4000-8000-00000000000a', 'receptionist', true),
  ('f9440000-0000-4000-8000-000000000015', '15', 'f9410000-0000-4000-8000-00000000000c', 'nurse', true),
  ('f9440000-0000-4000-8000-000000000016', '16', 'f9410000-0000-4000-8000-00000000000a', 'nurse', true),
  ('f9440000-0000-4000-8000-000000000017', '17', 'f9410000-0000-4000-8000-00000000000a', 'doctor', true),
  ('f9440000-0000-4000-8000-000000000018', '18', 'f9410000-0000-4000-8000-00000000000a', 'clinician', true))
  membership_rows(membership_id, n, facility, role_name, primary_membership);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('f9450000-0000-4000-8000-' || substr(membership.id::text, 25))::uuid, membership.account_id,
  membership.membership_role, 'facility', membership.id, membership.facility_id, 'Synthetic assisted suite role'
from identity.staff_facility_memberships membership
where membership.organization_id = 'f9400000-0000-4000-8000-000000000001';
-- Credential attestations by 01 (current for 11, 15, 16, 18; lapsed for 17)
-- and the workforce grants that rest on them (none for 12, 13, 14).
insert into identity.staff_credential_attestations (id, staff_id, account_id, attested_roles, credential_reference,
  issuing_authority, verification_method, evidence_reference, valid_until, reviewer_account_id, reason,
  correlation_id, recorded_at)
select ('f9460000-0000-4000-8000-0000000000' || n)::uuid, ('f9430000-0000-4000-8000-0000000000' || n)::uuid,
  ('f9420000-0000-4000-8000-0000000000' || n)::uuid, array[role_name], 'LIC-' || n, 'Synthetic Council',
  'manual_review', 'Synthetic evidence ' || n, valid_until, 'f9420000-0000-4000-8000-000000000001',
  'Synthetic attestation for the assisted suite', 'assisted-suite-attestation', recorded_at
from (values ('11', 'nurse', now() + interval '1 year', now()), ('15', 'nurse', now() + interval '1 year', now()),
  ('16', 'nurse', now() + interval '1 year', now()), ('18', 'clinician', now() + interval '1 year', now()),
  ('17', 'doctor', now() - interval '1 day', now() - interval '2 years'))
  attestation_rows(n, role_name, valid_until, recorded_at);
insert into identity.workforce_role_grants (account_role_id, attestation_id, account_id, membership_id, facility_id,
  role_code, granted_by, correlation_id)
select assignment.id, ('f9460000-0000-4000-8000-0000000000' || right(assignment.account_id::text, 2))::uuid,
  assignment.account_id, assignment.membership_id, assignment.facility_id, assignment.role_code,
  'f9420000-0000-4000-8000-000000000001', 'assisted-suite-grant'
from auth.account_roles assignment
where assignment.scope_type = 'facility'
  and right(assignment.account_id::text, 2) in ('11', '15', '16', '17', '18')
  and assignment.account_id::text like 'f9420000-%';

-- MFA: staff factors enrolled with a staff proof for 11 to 18, a platform
-- factor for 01 and 02; staff sessions for every staff account, assurance on
-- all but 16's; platform sessions with a fresh step-up for 01 and 02.
insert into auth.mfa_login_challenges (id, account_id, purpose, token_sha256, account_token_version, created_at,
    expires_at, max_attempts, session_kind, proof_method, proof_verified_at)
select ('f9480000-0000-4000-8000-0000000000' || n)::uuid, ('f9420000-0000-4000-8000-0000000000' || n)::uuid,
  'enroll', repeat(n, 32), 1, now(), now() + interval '9 minutes', 5, 'staff', 'provider_activation', clock_timestamp()
from unnest(array['11', '12', '13', '14', '15', '16', '17', '18']) n;
insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, activated_at,
    last_used_step, enrollment_proof, enrollment_challenge_id)
select ('f9470000-0000-4000-8000-0000000000' || n)::uuid, ('f9420000-0000-4000-8000-0000000000' || n)::uuid,
  'active', gen_random_bytes(49), 'suite-v1', now(), 1,
  case when n not in ('01', '02') then 'provider_activation' end,
  case when n not in ('01', '02') then ('f9480000-0000-4000-8000-0000000000' || n)::uuid end
from unnest(array['01', '02', '11', '12', '13', '14', '15', '16', '17', '18']) n;
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
select ('f9490000-0000-4000-8000-0000000000' || n)::uuid, ('f9420000-0000-4000-8000-0000000000' || n)::uuid,
  ('f9490000-0000-4000-8000-0000000000' || n)::uuid, repeat(n, 32), gen_random_uuid(), 1, 'password', now(),
  now() + case when n in ('01', '02') then interval '15 minutes' else interval '1 hour' end, now() + interval '8 hours',
  case when n in ('01', '02') then 'platform' else 'staff' end
from unnest(array['01', '02', '11', '12', '13', '14', '15', '16', '17', '18']) n;
insert into auth.session_assurance (family_id, account_id, mfa_factor_id, mfa_method, mfa_verified_at)
select ('f9490000-0000-4000-8000-0000000000' || n)::uuid, ('f9420000-0000-4000-8000-0000000000' || n)::uuid,
  ('f9470000-0000-4000-8000-0000000000' || n)::uuid, 'totp', clock_timestamp()
from unnest(array['01', '02', '11', '12', '13', '14', '15', '17', '18']) n;
update auth.session_assurance set step_up_at = clock_timestamp(), step_up_count = step_up_count + 1,
  row_version = row_version + 1
where family_id in ('f9490000-0000-4000-8000-000000000001', 'f9490000-0000-4000-8000-000000000002');

-- 1. Catalog contract.
do $$
declare
  command regprocedure;
  internal regprocedure;
  relation regclass;
begin
  foreach command in array array[
    'identity.record_assisted_verification(uuid,char,char,text,text,text,text,text,text,char,char,integer,integer)'::regprocedure,
    'identity.list_participating_facilities()'::regprocedure,
    'identity.admin_facility_assisted_registration(uuid)'::regprocedure,
    'identity.admin_set_facility_assisted_registration(uuid,bigint,text,text,text,text,text,text,text,text,char)'::regprocedure
  ] loop
    if not (select prosecdef from pg_proc where oid = command)
       or not exists (select 1 from unnest((select proconfig from pg_proc where oid = command)) setting
         where setting like 'search_path=pg_catalog, %') then
      raise exception '% must be security definer with a fixed search path', command;
    end if;
    if not has_function_privilege('hid_identity_runtime', command, 'EXECUTE')
       or not has_function_privilege('hid_identity_api_runtime', command, 'EXECUTE')
       or has_function_privilege('public', command, 'EXECUTE')
       or has_function_privilege('hid_ehr_runtime', command, 'EXECUTE')
       or has_function_privilege('hid_ehr_api_runtime', command, 'EXECUTE') then
      raise exception '% must be executable by the Identity runtime only', command;
    end if;
  end loop;
  -- Helpers run only inside the commands.
  foreach internal in array array[
    'identity.facility_assisted_registration_participating(uuid)'::regprocedure,
    'identity.assisted_registration_actor_attested(text,uuid,uuid)'::regprocedure,
    'auth.staff_session_is_mfa()'::regprocedure
  ] loop
    if not (select prosecdef from pg_proc where oid = internal)
       or has_function_privilege('public', internal, 'EXECUTE')
       or has_function_privilege('hid_identity_api_runtime', internal, 'EXECUTE')
       or has_function_privilege('hid_ehr_api_runtime', internal, 'EXECUTE') then
      raise exception '% must be a security definer helper no runtime role calls', internal;
    end if;
  end loop;
  -- No runtime role has a privilege on the three tables, which force row level security.
  foreach relation in array array['identity.facility_assisted_registration'::regclass,
    'identity.facility_assisted_registration_events'::regclass,
    'identity.assisted_registration_verifications'::regclass] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = relation)
       or has_table_privilege('hid_identity_api_runtime', relation, 'select,insert,update,delete')
       or has_table_privilege('hid_identity_runtime', relation, 'select,insert,update,delete')
       or has_table_privilege('hid_ehr_api_runtime', relation, 'select,insert,update,delete')
       or has_table_privilege('public', relation, 'select,insert,update,delete') then
      raise exception '% must force row level security and grant no runtime role a privilege', relation;
    end if;
  end loop;
  -- The runtime keeps the desk code columns it writes and nothing more.
  if not has_column_privilege('hid_identity_api_runtime', 'identity.public_patient_enrollments', 'desk_code_salt', 'update')
     or not has_column_privilege('hid_identity_api_runtime', 'identity.public_patient_enrollments', 'desk_code_issues', 'update')
     or has_column_privilege('hid_identity_api_runtime', 'identity.public_patient_enrollments', 'holder_verification_id', 'update')
     or has_column_privilege('hid_identity_api_runtime', 'identity.public_patient_enrollments', 'desk_code_issues', 'insert') then
    raise exception 'The runtime must update the desk code salt and count, and never the holder columns';
  end if;
  -- The permission: doctor, clinician and nurse only.
  if (select array_agg(role_code order by role_code) from auth.role_permissions
      where permission_code = 'identity.patient.assisted_registration')
     is distinct from array['clinician', 'doctor', 'nurse'] then
    raise exception 'identity.patient.assisted_registration must be held by doctor, clinician and nurse only';
  end if;
end $$;

-- 2. Direct DML is refused to the runtime: the tables are reached only through the commands.
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0001');
do $$
declare
  forbidden text;
begin
  foreach forbidden in array array[
    'select count(*) from identity.assisted_registration_verifications',
    'insert into identity.assisted_registration_verifications (id, desk_code_hmac, method, document_type, outcome, staff_account_id, membership_id, facility_id, request_key_hmac, request_hmac, correlation_id) values (gen_random_uuid(), repeat(''00'',32), ''government_photo_id_in_person'', ''voters_card'', ''code_not_found'', ''f9420000-0000-4000-8000-000000000011'', ''f9440000-0000-4000-8000-000000000011'', ''f9410000-0000-4000-8000-00000000000a'', repeat(''01'',32), repeat(''02'',32), ''assisted-suite-direct'')',
    'update identity.assisted_registration_verifications set proof_outcome = ''verified'' where false',
    'select count(*) from identity.facility_assisted_registration',
    'insert into identity.facility_assisted_registration (facility_id, status, town, lga, state, reason, updated_by) values (''f9410000-0000-4000-8000-00000000000c'', ''active'', ''Ikeja'', ''Ikeja'', ''Lagos'', ''Synthetic direct designation'', ''f9420000-0000-4000-8000-000000000001'')',
    'delete from identity.facility_assisted_registration_events where false',
    'update identity.public_patient_enrollments set holder_verification_id = gen_random_uuid() where false',
    'select identity.facility_assisted_registration_participating(''f9410000-0000-4000-8000-00000000000a'')',
    'select identity.assisted_registration_actor_attested(''synthetic:far:11'', ''f9440000-0000-4000-8000-000000000011'', ''f9410000-0000-4000-8000-00000000000a'')',
    'select auth.staff_session_is_mfa()'
  ] loop
    begin
      execute forbidden;
      raise exception 'The Identity runtime ran: %', forbidden;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;

-- 3. Designations: platform.facility.manage, a fresh step-up, a reason, the
-- expected version (0 creates), an idempotency key; a facility that is not
-- verified and active in an active organization is refused.
set local role hid_identity_api_runtime;
select pg_temp.as_platform('02');
select pg_temp.expect_refusal($sql$select * from identity.admin_set_facility_assisted_registration(
  'f9410000-0000-4000-8000-00000000000a', 0, 'active', '1 Synthetic Road', 'Ikeja', 'Ikeja', 'Lagos', null,
  'Synthetic designation by support', 'assisted-suite-key-0000', repeat('0',64))$sql$,
  '42501', 'ADMIN_PERMISSION_DENIED', 'designation without platform.facility.manage');
select pg_temp.as_platform('01');
select set_config('app.session_id', 'f9490000-0000-4000-8000-000000000011', true);
select pg_temp.expect_refusal($sql$select * from identity.admin_set_facility_assisted_registration(
  'f9410000-0000-4000-8000-00000000000a', 0, 'active', '1 Synthetic Road', 'Ikeja', 'Ikeja', 'Lagos', null,
  'Synthetic designation without step-up', 'assisted-suite-key-0001', repeat('1',64))$sql$,
  '42501', 'ADMIN_STEP_UP_REQUIRED', 'designation without a platform step-up');
select pg_temp.as_platform('01');
select pg_temp.expect_refusal($sql$select * from identity.admin_set_facility_assisted_registration(
  'f9410000-0000-4000-8000-00000000000a', 1, 'active', '1 Synthetic Road', 'Ikeja', 'Ikeja', 'Lagos', null,
  'Synthetic designation at the wrong version', 'assisted-suite-key-0002', repeat('2',64))$sql$,
  '40001', 'ADMIN_VERSION_CONFLICT', 'a first designation names version 0');
select pg_temp.expect_refusal($sql$select * from identity.admin_set_facility_assisted_registration(
  'f9410000-0000-4000-8000-00000000000a', 0, 'suspended', '1 Synthetic Road', 'Ikeja', 'Ikeja', 'Lagos', null,
  'Synthetic suspended first designation', 'assisted-suite-key-0003', repeat('3',64))$sql$,
  '22023', 'ADMIN_INVALID_ASSISTED_REGISTRATION', 'a first designation is active');
select pg_temp.expect_refusal($sql$select * from identity.admin_set_facility_assisted_registration(
  'f9410000-0000-4000-8000-00000000000a', 0, 'active', '1 Synthetic Road', '', 'Ikeja', 'Lagos', null,
  'Synthetic designation without a town', 'assisted-suite-key-0004', repeat('4',64))$sql$,
  '22023', 'ADMIN_INVALID_ASSISTED_REGISTRATION', 'a designation names a town');
select pg_temp.expect_refusal($sql$select * from identity.admin_set_facility_assisted_registration(
  'f9410000-0000-4000-8000-00000000000d', 0, 'active', null, 'Ikeja', 'Ikeja', 'Lagos', null,
  'Synthetic designation of a pending facility', 'assisted-suite-key-0005', repeat('5',64))$sql$,
  '55000', 'ASSISTED_REGISTRATION_FACILITY_INACTIVE', 'a pending facility');
select pg_temp.expect_refusal($sql$select * from identity.admin_set_facility_assisted_registration(
  'f9410000-0000-4000-8000-00000000000e', 0, 'active', null, 'Ikeja', 'Ikeja', 'Lagos', null,
  'Synthetic designation in a closed organization', 'assisted-suite-key-0006', repeat('6',64))$sql$,
  '55000', 'ASSISTED_REGISTRATION_FACILITY_INACTIVE', 'a facility of an inactive organization');
select pg_temp.expect_refusal($sql$select * from identity.admin_set_facility_assisted_registration(
  'f9410000-0000-4000-8000-0000000000ff', 0, 'active', null, 'Ikeja', 'Ikeja', 'Lagos', null,
  'Synthetic designation of no facility', 'assisted-suite-key-0007', repeat('7',64))$sql$,
  'P0002', 'ADMIN_FACILITY_NOT_FOUND', 'an unknown facility');
do $$
declare
  result record;
begin
  select * into result from identity.admin_set_facility_assisted_registration('f9410000-0000-4000-8000-00000000000a',
    0, 'active', ' 1 Synthetic Road ', 'Ikeja', 'Ikeja', 'Lagos', 'Mon-Fri 08:00-16:00',
    'Synthetic designation of clinic A', 'assisted-suite-key-0010', repeat('a',64));
  if result.status <> 'active' or result.row_version <> 1 or result.replayed then
    raise exception 'Designating clinic A answered %', row_to_json(result);
  end if;
  select * into result from identity.admin_set_facility_assisted_registration('f9410000-0000-4000-8000-00000000000a',
    0, 'active', ' 1 Synthetic Road ', 'Ikeja', 'Ikeja', 'Lagos', 'Mon-Fri 08:00-16:00',
    'Synthetic designation of clinic A', 'assisted-suite-key-0010', repeat('a',64));
  if not result.replayed or result.row_version <> 1 then
    raise exception 'The same designation key did not replay';
  end if;
  select * into result from identity.admin_set_facility_assisted_registration('f9410000-0000-4000-8000-00000000000b',
    0, 'active', null, 'Yaba', 'Lagos Mainland', 'Lagos', null,
    'Synthetic designation of clinic B', 'assisted-suite-key-0011', repeat('b',64));
  if result.row_version <> 1 then raise exception 'Designating clinic B failed'; end if;
end $$;
select pg_temp.expect_refusal($sql$select * from identity.admin_set_facility_assisted_registration(
  'f9410000-0000-4000-8000-00000000000a', 0, 'active', null, 'Ikeja', 'Ikeja', 'Lagos', null,
  'Synthetic designation of clinic A', 'assisted-suite-key-0010', repeat('9',64))$sql$,
  '23505', 'ADMIN_IDEMPOTENCY_CONFLICT', 'a designation key reused for another request');
select pg_temp.expect_refusal($sql$select * from identity.admin_set_facility_assisted_registration(
  'f9410000-0000-4000-8000-00000000000a', 1, 'active', '1 Synthetic Road', 'Ikeja', 'Ikeja', 'Lagos',
  'Mon-Fri 08:00-16:00', 'Synthetic unchanged designation', 'assisted-suite-key-0012', repeat('c',64))$sql$,
  '22023', 'ADMIN_NO_STATE_CHANGE', 'a designation that changes nothing');
do $$
begin
  if (select array_agg(facility_id order by facility_id) from identity.admin_facility_assisted_registration(
      'f9410000-0000-4000-8000-00000000000a')) is distinct from array['f9410000-0000-4000-8000-00000000000a'::uuid]
     or exists (select 1 from identity.admin_facility_assisted_registration('f9410000-0000-4000-8000-00000000000c')) then
    raise exception 'The platform read must return a designation and nothing for an undesignated facility';
  end if;
end $$;
reset role;
do $$
begin
  if (select address_line from identity.facility_assisted_registration
      where facility_id = 'f9410000-0000-4000-8000-00000000000a') <> '1 Synthetic Road'
     or (select count(*) from identity.facility_assisted_registration_events
      where facility_id in ('f9410000-0000-4000-8000-00000000000a', 'f9410000-0000-4000-8000-00000000000b')) <> 2
     or (select count(*) from auth.admin_command_idempotency
      where operation = 'facility.assisted-registration') <> 2 then
    raise exception 'Designations must be trimmed, appended as events and keyed once';
  end if;
  begin
    update identity.facility_assisted_registration_events set reason = 'Synthetic changed reason'
     where facility_id = 'f9410000-0000-4000-8000-00000000000a';
    raise exception 'A designation event was changed';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;
-- The public list: A and B, with no ids; C never designated, D and E refused.
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0002');
do $$
begin
  if (select array_agg(name || '|' || coalesce(address_line, '-') || '|' || town || '|' || lga || '|' || state
        || '|' || coalesce(hours, '-') order by name) from identity.list_participating_facilities())
     is distinct from array['Assisted Suite Clinic A|1 Synthetic Road|Ikeja|Ikeja|Lagos|Mon-Fri 08:00-16:00',
       'Assisted Suite Clinic B|-|Yaba|Lagos Mainland|Lagos|-'] then
    raise exception 'The participating list is wrong: %', (select array_agg(name) from identity.list_participating_facilities());
  end if;
end $$;
select pg_temp.as_staff('11', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000011',
  'f9490000-0000-4000-8000-000000000011');
select pg_temp.expect_refusal('select * from identity.list_participating_facilities()',
  '42501', 'PATIENT_ENROLLMENT_DENIED', 'the participating list outside system context');
reset role;

-- 4. Staff session assurance in SQL.
do $$
declare
  probe text;
begin
  -- auth.staff_session_is_mfa as its owner sees it, in each request context.
  perform pg_temp.as_staff('11', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000011',
    'f9490000-0000-4000-8000-000000000011');
  if not auth.staff_session_is_mfa() then raise exception 'A live staff session with MFA was not assured'; end if;
  perform set_config('app.session_id', 'f9490000-0000-4000-8000-000000000016', true);
  if auth.staff_session_is_mfa() then raise exception 'Another account''s session was assured'; end if;
  perform pg_temp.as_staff('16', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000016',
    'f9490000-0000-4000-8000-000000000016');
  if auth.staff_session_is_mfa() then raise exception 'A staff session without MFA assurance was assured'; end if;
  perform pg_temp.as_platform('01');
  if auth.staff_session_is_mfa() then raise exception 'A platform session was assured as a staff session'; end if;
  perform pg_temp.as_staff('18', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000018',
    null);
  if auth.staff_session_is_mfa() then raise exception 'A request without a session was assured'; end if;
  update auth.accounts set token_version = token_version + 1 where id = 'f9420000-0000-4000-8000-000000000018';
  perform pg_temp.as_staff('18', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000018',
    'f9490000-0000-4000-8000-000000000018');
  if auth.staff_session_is_mfa() then raise exception 'A session of an old token version was assured'; end if;
  update auth.accounts set token_version = token_version - 1 where id = 'f9420000-0000-4000-8000-000000000018';
end $$;

-- 5. The staff command refuses every actor that is not an MFA-verified,
-- attested holder of the permission at a participating facility, and
-- records nothing for them.
set local role hid_identity_api_runtime;
select pg_temp.as_staff('16', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000016',
  'f9490000-0000-4000-8000-000000000016');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('mutant-mfa', null, null, 'none-1', 'code_not_found')
  as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '42501', 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', 'no MFA assurance row');
select pg_temp.as_staff('11', 'f9410000-0000-4000-8000-00000000000c', 'f9440000-0000-4000-8000-000000000011',
  'f9490000-0000-4000-8000-000000000011');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('mutant-wrong-facility', null, null, 'none-2', 'code_not_found')
  as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '42501', 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', 'a membership named with another facility');
select pg_temp.as_staff('15', 'f9410000-0000-4000-8000-00000000000c', 'f9440000-0000-4000-8000-000000000015',
  'f9490000-0000-4000-8000-000000000015');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('mutant-undesignated', null, null, 'none-3', 'code_not_found')
  as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '42501', 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', 'an attested nurse at an undesignated facility');
select pg_temp.as_staff('14', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000014',
  'f9490000-0000-4000-8000-000000000014');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('mutant-receptionist', null, null, 'none-4', 'code_not_found')
  as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '42501', 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', 'a role without the permission');
select pg_temp.as_staff('13', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000013',
  'f9490000-0000-4000-8000-000000000013');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('mutant-org-admin', null, null, 'none-5', 'code_not_found')
  as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '42501', 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', 'org_admin');
select pg_temp.as_staff('12', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000012',
  'f9490000-0000-4000-8000-000000000012');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('mutant-legacy', null, null, 'none-6', 'code_not_found')
  as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '42501', 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', 'a legacy-promoted nurse without an attested grant');
select pg_temp.as_staff('17', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000017',
  'f9490000-0000-4000-8000-000000000017');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('mutant-lapsed', null, null, 'none-7', 'code_not_found')
  as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '42501', 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', 'a doctor whose attestation lapsed');
select pg_temp.as_system('assisted-suite-system-0003');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('mutant-system', null, null, 'none-8', 'code_not_found')
  as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '42501', 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', 'system context');
select pg_temp.as_staff('11', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000011',
  'f9490000-0000-4000-8000-000000000011');
select pg_temp.expect_refusal($sql$select * from identity.record_assisted_verification(null, null, repeat('d1',32),
  'nin_slip', 'national_id_card', 'code_not_found', null, null, null, repeat('e1',32), repeat('f1',32), 20, 100)$sql$,
  '22023', 'ASSISTED_VERIFICATION_INVALID', 'a method that is not the approved procedure');
select pg_temp.expect_refusal($sql$select * from identity.record_assisted_verification(gen_random_uuid(), null,
  repeat('d1',32), 'government_photo_id_in_person', 'national_id_card', 'matched', 'match', 'match', 'match',
  repeat('e1',32), repeat('f1',32), 20, 100)$sql$,
  '22023', 'ASSISTED_VERIFICATION_INVALID', 'a matched check without a NIN digest');
reset role;
do $$
begin
  if (select count(*) from identity.assisted_registration_verifications where request_key_hmac in (
      select encode(public.digest('key:mutant-' || label, 'sha256'), 'hex') from unnest(array['mfa', 'wrong-facility',
        'undesignated', 'receptionist', 'org-admin', 'legacy', 'lapsed', 'system']) label)) <> 0 then
    raise exception 'A refused actor recorded a check';
  end if;
end $$;

-- 6. Checks, replay, the staff audit row and the budgets. Every outcome counts.
select pg_temp.seed_enrollment('f94a0000-0000-4000-8000-000000000001', repeat('a1',32), repeat('b1',32),
  'assisted-ref-001', 'desk-001');
set local role hid_identity_api_runtime;
select pg_temp.as_staff('11', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000011',
  'f9490000-0000-4000-8000-000000000011');
do $$
declare
  first_check record;
  again record;
begin
  select * into first_check from pg_temp.record_check('check-not-matched', 'f94a0000-0000-4000-8000-000000000001',
    repeat('c1',32), 'desk-001', 'not_matched') as (id uuid, outcome text, replayed boolean, proof text);
  if first_check.outcome <> 'not_matched' or first_check.replayed then
    raise exception 'A not-matched check was not recorded';
  end if;
  select * into again from pg_temp.record_check('check-not-matched', 'f94a0000-0000-4000-8000-000000000001',
    repeat('c1',32), 'desk-001', 'not_matched') as (id uuid, outcome text, replayed boolean, proof text);
  if again.id <> first_check.id or not again.replayed then
    raise exception 'The same key did not replay the stored check';
  end if;
  -- The replay answers what was stored, whatever this request computed.
  select * into again from identity.record_assisted_verification(null, null,
    encode(public.digest('desk:desk-001', 'sha256'), 'hex')::char(64), 'government_photo_id_in_person',
    'national_id_card', 'code_not_found', null, null, null,
    encode(public.digest('key:check-not-matched', 'sha256'), 'hex')::char(64),
    encode(public.digest('request:check-not-matched', 'sha256'), 'hex')::char(64), 20, 100);
  if again.verification_id <> first_check.id or again.outcome <> 'not_matched' or not again.replayed then
    raise exception 'A replay did not answer the stored outcome';
  end if;
end $$;
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('check-not-matched',
  'f94a0000-0000-4000-8000-000000000001', repeat('c1',32), 'desk-001', 'matched', 20, 100, 'another-request')
  as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '23505', 'ASSISTED_VERIFICATION_KEY_REUSED', 'a key reused for another request');
-- 11's key used at B is another facility's check: refused, never replayed.
select pg_temp.as_staff('11', 'f9410000-0000-4000-8000-00000000000b', 'f9440000-0000-4000-8000-0000000001b1',
  'f9490000-0000-4000-8000-000000000011');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('check-not-matched',
  'f94a0000-0000-4000-8000-000000000001', repeat('c1',32), 'desk-001', 'not_matched')
  as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '23505', 'ASSISTED_VERIFICATION_KEY_REUSED', 'another facility''s check');
reset role;
do $$
begin
  if (select count(*) from identity.assisted_registration_verifications
      where staff_account_id = 'f9420000-0000-4000-8000-000000000011') <> 1 then
    raise exception 'A replay or a refused reuse recorded a check';
  end if;
  if (select count(*) from audit.events where action = 'identity.assisted-verification.record'
      and actor_type = 'staff' and actor_account_id = 'f9420000-0000-4000-8000-000000000011'
      and actor_membership_id = 'f9440000-0000-4000-8000-000000000011'
      and facility_id = 'f9410000-0000-4000-8000-00000000000a' and outcome = 'denied'
      and details = jsonb_build_object('method', 'government_photo_id_in_person', 'documentType', 'national_id_card',
        'outcome', 'not_matched', 'ninDigest', repeat('c1',32))) <> 1
     or (select count(*) from audit.events where action = 'identity.assisted-verification.replay'
      and actor_account_id = 'f9420000-0000-4000-8000-000000000011') <> 2 then
    raise exception 'The staff audit rows are wrong';
  end if;
  if exists (select 1 from audit.events where action like 'identity.assisted-verification.%'
      and (details::text ~* '(synthetic|desk|1990|@)' or jsonb_typeof(details) <> 'object'
        or not (details ?& array['method', 'documentType', 'outcome', 'ninDigest'])
        or (select count(*) from jsonb_object_keys(details)) <> 4)) then
    raise exception 'A staff audit row carries more than the method, document type, outcome and NIN digest';
  end if;
end $$;
-- Budgets over a sliding 24 hours, per staff member (across facilities) and per facility.
set local role hid_identity_api_runtime;
select pg_temp.as_staff('11', 'f9410000-0000-4000-8000-00000000000b', 'f9440000-0000-4000-8000-0000000001b1',
  'f9490000-0000-4000-8000-000000000011');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('budget-staff', null, null, 'none-9',
  'code_not_found', 1, 100) as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '54000', 'ASSISTED_VERIFICATION_LIMITED', 'the staff budget counts the checks at another facility');
select pg_temp.as_staff('18', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000018',
  'f9490000-0000-4000-8000-000000000018');
select pg_temp.expect_refusal($sql$select * from pg_temp.record_check('budget-facility', null, null, 'none-10',
  'code_not_found', 20, 1) as (id uuid, outcome text, replayed boolean, proof text)$sql$,
  '54000', 'ASSISTED_VERIFICATION_LIMITED', 'the facility budget counts every staff member''s checks');
reset role;
-- Checks older than 24 hours no longer count.
alter table identity.assisted_registration_verifications disable trigger assisted_registration_verifications_guard;
update identity.assisted_registration_verifications set verified_at = verified_at - interval '25 hours'
  where staff_account_id = 'f9420000-0000-4000-8000-000000000011';
alter table identity.assisted_registration_verifications enable trigger assisted_registration_verifications_guard;
set local role hid_identity_api_runtime;
select pg_temp.as_staff('18', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000018',
  'f9490000-0000-4000-8000-000000000018');
do $$
begin
  if (select outcome from pg_temp.record_check('budget-aged', null, null, 'none-11', 'code_not_found', 20, 1)
      as (id uuid, outcome text, replayed boolean, proof text)) <> 'code_not_found' then
    raise exception 'Checks older than 24 hours still counted';
  end if;
end $$;
reset role;

-- 7. Checks are append-only; the proof outcome is written once.
do $$
declare
  check_id uuid := (select id from identity.assisted_registration_verifications
    where request_key_hmac = encode(public.digest('key:check-not-matched', 'sha256'), 'hex'));
begin
  begin
    update identity.assisted_registration_verifications set document_type = 'voters_card' where id = check_id;
    raise exception 'A check was changed';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'ASSISTED_VERIFICATION_IMMUTABLE' then raise; end if;
  end;
  begin
    delete from identity.assisted_registration_verifications where id = check_id;
    raise exception 'A check was deleted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'ASSISTED_VERIFICATION_IMMUTABLE' then raise; end if;
  end;
  begin
    update identity.assisted_registration_verifications set proof_outcome = 'verified',
      proof_recorded_at = clock_timestamp() where id = check_id;
    raise exception 'A proof outcome was written on a check that did not match';
  exception when check_violation then null;
  end;
end $$;

-- 8. The holder proof's in-person method (system context).
-- E2 is checked and proved; E3 is a second enrollment of E2's NIN, proved by
-- a registry-phone code, which the in-person proof displaces (contested).
select pg_temp.seed_enrollment('f94a0000-0000-4000-8000-000000000002', repeat('a2',32), repeat('b2',32),
  'assisted-ref-002', 'desk-002', '9402');
insert into identity.public_patient_enrollments (id, nin_lookup_hmac, nin_last4, nin_ciphertext, profile_ciphertext,
  profile_sha256, key_version, provider_reference, request_hmac, token_hmac, state, holder_method,
  holder_verified_at, holder_challenge_id, holder_recipient_hmac)
values ('f94a0000-0000-4000-8000-000000000003', repeat('a2',32), '9402', decode(repeat('a1',32),'hex'),
  decode(repeat('b1',32),'hex'), repeat('0e',32), 'fixture', 'assisted-ref-003', repeat('1e',32), repeat('2e',32),
  'verify_contact', 'registry_phone_otp', clock_timestamp(), gen_random_uuid(), repeat('3e',32));
-- E2 holds an open registry-phone code, which the in-person proof closes.
insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, purpose,
  verifier_hmac, verifier_key_version, expires_at, max_attempts)
values ('f94b0000-0000-4000-8000-000000000002', 'f94a0000-0000-4000-8000-000000000002', repeat('3f',32), 'phone',
  'nin_holder', repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5);
update identity.public_patient_enrollments set holder_recipient_hmac = repeat('3f',32)
 where id = 'f94a0000-0000-4000-8000-000000000002';
set local role hid_identity_api_runtime;
select pg_temp.as_staff('18', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000018',
  'f9490000-0000-4000-8000-000000000018');
select set_config('suite.check_e2', (select id::text from pg_temp.record_check('check-e2',
  'f94a0000-0000-4000-8000-000000000002', repeat('c2',32), 'desk-002', 'matched')
  as (id uuid, outcome text, replayed boolean, proof text)), true);
select set_config('suite.check_e2_not_matched', (select id::text from pg_temp.record_check('check-e2-no',
  'f94a0000-0000-4000-8000-000000000002', repeat('c2',32), 'desk-002', 'not_matched')
  as (id uuid, outcome text, replayed boolean, proof text)), true);
select set_config('suite.check_e1_for_e2', (select id::text from pg_temp.record_check('check-e1-matched',
  'f94a0000-0000-4000-8000-000000000001', repeat('c1',32), 'desk-001', 'matched')
  as (id uuid, outcome text, replayed boolean, proof text)), true);
select pg_temp.as_system('assisted-suite-system-0004');
-- Argument shapes: a challenge is never an in-person proof.
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('b2',32), 'facility_in_person', gen_random_uuid(), %L::uuid,
  repeat('c2',32), 5)$sql$, current_setting('suite.check_e2')),
  '22023', 'PATIENT_HOLDER_METHOD_UNAVAILABLE', 'an in-person proof that names a code');
select pg_temp.expect_refusal($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('b2',32), 'facility_in_person', null, gen_random_uuid(),
  repeat('c2',32), 5)$sql$,
  '23514', 'PATIENT_HOLDER_PROOF_INVALID', 'an in-person proof without a recorded check');
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('b2',32), 'facility_in_person', null, %L::uuid,
  repeat('c2',32), 5)$sql$, current_setting('suite.check_e2_not_matched')),
  '23514', 'PATIENT_HOLDER_PROOF_INVALID', 'a check that did not match');
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('b2',32), 'facility_in_person', null, %L::uuid,
  repeat('c2',32), 5)$sql$, current_setting('suite.check_e1_for_e2')),
  '23514', 'PATIENT_HOLDER_PROOF_INVALID', 'another enrollment''s check');
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('b2',32), 'facility_in_person', null, %L::uuid,
  repeat('cf',32), 5)$sql$, current_setting('suite.check_e2')),
  '23514', 'PATIENT_HOLDER_PROOF_INVALID', 'a check of another NIN digest');
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('09',32), 'facility_in_person', null, %L::uuid,
  repeat('c2',32), 5)$sql$, current_setting('suite.check_e2')),
  '42501', 'PATIENT_ENROLLMENT_DENIED', 'a wrong enrollment token');
reset role;
-- A new desk code after the check: the check no longer names the current code.
update identity.public_patient_enrollments set desk_code_hmac = encode(public.digest('desk:desk-002b', 'sha256'), 'hex')
 where id = 'f94a0000-0000-4000-8000-000000000002';
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0005');
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('b2',32), 'facility_in_person', null, %L::uuid,
  repeat('c2',32), 5)$sql$, current_setting('suite.check_e2')),
  '23514', 'PATIENT_HOLDER_PROOF_INVALID', 'a check of an earlier desk code');
reset role;
update identity.public_patient_enrollments set desk_code_hmac = encode(public.digest('desk:desk-002', 'sha256'), 'hex')
 where id = 'f94a0000-0000-4000-8000-000000000002';
-- Stale: recorded more than 10 minutes ago.
alter table identity.assisted_registration_verifications disable trigger assisted_registration_verifications_guard;
update identity.assisted_registration_verifications set verified_at = clock_timestamp() - interval '11 minutes'
 where id = current_setting('suite.check_e2')::uuid;
alter table identity.assisted_registration_verifications enable trigger assisted_registration_verifications_guard;
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0006');
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('b2',32), 'facility_in_person', null, %L::uuid,
  repeat('c2',32), 5)$sql$, current_setting('suite.check_e2')),
  '23514', 'PATIENT_HOLDER_PROOF_INVALID', 'a check older than 10 minutes');
reset role;
alter table identity.assisted_registration_verifications disable trigger assisted_registration_verifications_guard;
update identity.assisted_registration_verifications set verified_at = clock_timestamp()
 where id = current_setting('suite.check_e2')::uuid;
alter table identity.assisted_registration_verifications enable trigger assisted_registration_verifications_guard;
-- The designation suspended, or the verifying role revoked, after the check.
update identity.facility_assisted_registration set status = 'suspended'
 where facility_id = 'f9410000-0000-4000-8000-00000000000a';
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0007');
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('b2',32), 'facility_in_person', null, %L::uuid,
  repeat('c2',32), 5)$sql$, current_setting('suite.check_e2')),
  '42501', 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', 'a facility suspended after the check');
reset role;
update identity.facility_assisted_registration set status = 'active'
 where facility_id = 'f9410000-0000-4000-8000-00000000000a';
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = 'f9420000-0000-4000-8000-000000000001',
  revocation_reason = 'Synthetic revocation in the suite' where id = 'f9450000-0000-4000-8000-000000000018';
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0008');
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('b2',32), 'facility_in_person', null, %L::uuid,
  repeat('c2',32), 5)$sql$, current_setting('suite.check_e2')),
  '42501', 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', 'a verifying role revoked after the check');
reset role;
update auth.account_roles set revoked_at = null, revoked_by = null, revocation_reason = null
 where id = 'f9450000-0000-4000-8000-000000000018';
do $$
begin
  if (select state from identity.public_patient_enrollments where id = 'f94a0000-0000-4000-8000-000000000002')
       <> 'verify_holder'
     or not exists (select 1 from identity.public_patient_enrollments where id = 'f94a0000-0000-4000-8000-000000000003')
     or (select proof_outcome from identity.assisted_registration_verifications
       where id = current_setting('suite.check_e2')::uuid) is not null then
    raise exception 'A refused in-person proof changed an enrollment or a check';
  end if;
end $$;
-- The proof: E2 moves to verify_contact, its desk code and open code are
-- cleared, E3 (proved by phone) is displaced as contested, the check records
-- the outcome, a proof event and the audit row are written.
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0009');
do $$
begin
  if identity.record_public_patient_holder_proof('f94a0000-0000-4000-8000-000000000002', repeat('b2',32),
      'facility_in_person', null, current_setting('suite.check_e2')::uuid, repeat('c2',32), 5) <> 'verified' then
    raise exception 'A matched in-person check was not accepted';
  end if;
end $$;
-- The same check again, now spent.
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
  'f94a0000-0000-4000-8000-000000000002', repeat('b2',32), 'facility_in_person', null, %L::uuid,
  repeat('c2',32), 5)$sql$, current_setting('suite.check_e2')),
  '42501', 'PATIENT_ENROLLMENT_DENIED', 'a proved enrollment proved again');
reset role;
do $$
declare
  proved identity.public_patient_enrollments%rowtype;
begin
  select * into proved from identity.public_patient_enrollments where id = 'f94a0000-0000-4000-8000-000000000002';
  if proved.state <> 'verify_contact' or proved.holder_method <> 'facility_in_person'
     or proved.holder_verification_id <> current_setting('suite.check_e2')::uuid
     or proved.holder_challenge_id is not null or proved.holder_verified_at is null
     or proved.desk_code_hmac is not null or proved.desk_code_expires_at is not null
     or proved.desk_code_salt is not null then
    raise exception 'The in-person proof did not record its method and clear the desk code';
  end if;
  if (select invalidation_reason from identity.public_patient_enrollment_otps
      where id = 'f94b0000-0000-4000-8000-000000000002') is distinct from 'expired' then
    raise exception 'The open registry-phone code was left open';
  end if;
  if exists (select 1 from identity.public_patient_enrollments where id = 'f94a0000-0000-4000-8000-000000000003')
     or (select count(*) from audit.events where action = 'identity.public-patient-enrollment.contested'
       and correlation_id = 'assisted-suite-system-0009'
       and details = jsonb_build_object('count', 1, 'methods', '["registry_phone_otp"]'::jsonb,
         'ninDigest', repeat('c2',32))) <> 1 then
    raise exception 'The phone-proven enrollment of the NIN was not displaced as contested';
  end if;
  if (select proof_outcome from identity.assisted_registration_verifications
      where id = current_setting('suite.check_e2')::uuid) <> 'verified'
     or (select count(*) from identity.public_patient_holder_events where kind = 'proof'
       and method = 'facility_in_person' and nin_digest = repeat('c2',32) and phone_digest is null) <> 1
     or (select count(*) from audit.events where action = 'identity.public-patient-enrollment.holder-verified'
       and correlation_id = 'assisted-suite-system-0009'
       and details = jsonb_build_object('method', 'facility_in_person', 'ninDigest', repeat('c2',32))) <> 1 then
    raise exception 'The in-person proof was not recorded on the check, as an event and in the audit';
  end if;
end $$;
-- A registry-phone proof of the same NIN cannot displace the unexpired
-- in-person proof (0093's facility_conflict).
select pg_temp.seed_enrollment('f94a0000-0000-4000-8000-000000000004', repeat('a2',32), repeat('b4',32),
  'assisted-ref-004', null, '9402');
update identity.public_patient_enrollments set holder_recipient_hmac = repeat('3d',32)
 where id = 'f94a0000-0000-4000-8000-000000000004';
insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, purpose,
  verifier_hmac, verifier_key_version, expires_at, max_attempts, delivery_outcome)
values ('f94b0000-0000-4000-8000-000000000004', 'f94a0000-0000-4000-8000-000000000004', repeat('3d',32), 'phone',
  'nin_holder', repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5, 'accepted');
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0010');
do $$
begin
  if identity.record_public_patient_holder_proof('f94a0000-0000-4000-8000-000000000004', repeat('b4',32),
      'registry_phone_otp', 'f94b0000-0000-4000-8000-000000000004', null, repeat('c2',32), 5)
      <> 'facility_conflict' then
    raise exception 'A registry-phone proof displaced an unexpired in-person proof';
  end if;
end $$;
reset role;
-- A second in-person proof of the NIN displaces the first and the unproven
-- enrollment (superseded: no other method is displaced).
select pg_temp.seed_enrollment('f94a0000-0000-4000-8000-000000000005', repeat('a2',32), repeat('b5',32),
  'assisted-ref-005', 'desk-005', '9402');
set local role hid_identity_api_runtime;
select pg_temp.as_staff('11', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000011',
  'f9490000-0000-4000-8000-000000000011');
select set_config('suite.check_e5', (select id::text from pg_temp.record_check('check-e5',
  'f94a0000-0000-4000-8000-000000000005', repeat('c2',32), 'desk-005', 'matched')
  as (id uuid, outcome text, replayed boolean, proof text)), true);
select pg_temp.as_system('assisted-suite-system-0011');
do $$
begin
  if identity.record_public_patient_holder_proof('f94a0000-0000-4000-8000-000000000005', repeat('b5',32),
      'facility_in_person', null, current_setting('suite.check_e5')::uuid, repeat('c2',32), 5) <> 'verified' then
    raise exception 'A second in-person proof was refused';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.public_patient_enrollments where id in ('f94a0000-0000-4000-8000-000000000002',
       'f94a0000-0000-4000-8000-000000000004'))
     or (select count(*) from audit.events where action = 'identity.public-patient-enrollment.superseded'
       and correlation_id = 'assisted-suite-system-0011'
       and details->>'count' = '2' and details->'methods' @> '["facility_in_person", "unproven"]'::jsonb) <> 1 then
    raise exception 'A second in-person proof did not displace the other enrollments of the NIN';
  end if;
  -- The check stays as evidence after its enrollment is gone.
  if (select proof_outcome from identity.assisted_registration_verifications
      where id = current_setting('suite.check_e2')::uuid) <> 'verified' then
    raise exception 'A displaced enrollment''s check was lost';
  end if;
end $$;

-- 9. A NIN that already has a Health ID is answered only after the in-person
-- proof: the enrollment is deleted, the check records it, the event is audited.
insert into identity.public_patient_enrollments (id, nin_lookup_hmac, nin_last4, nin_ciphertext, profile_ciphertext,
  profile_sha256, key_version, provider_reference, request_hmac, token_hmac, state, contact_channel, contact_hmac,
  contact_lookup_hmac, contact_ciphertext, contact_verified_at, verified_challenge_id, patient_id, account_id,
  activated_at, holder_method)
values ('f94a0000-0000-4000-8000-0000000000e6', repeat('a6',32), '9406', decode(repeat('a1',32),'hex'),
  decode(repeat('b1',32),'hex'), repeat('0e',32), 'fixture', 'assisted-bound', repeat('1f',32), repeat('2f',32),
  'active', 'email', repeat('3f',32), repeat('4f',32), decode(repeat('5f',32),'hex'), clock_timestamp(),
  gen_random_uuid(), 'f94c0000-0000-4000-8000-000000000006', 'f94d0000-0000-4000-8000-000000000006',
  clock_timestamp(), 'none_before_0093');
insert into auth.accounts (id, subject, display_name, status, source_system)
values ('f94d0000-0000-4000-8000-000000000006', 'patient:f94d0000-0000-4000-8000-000000000006',
  'Bound Synthetic', 'active', 'hid-public-qoreid-enrollment');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('f94c0000-0000-4000-8000-000000000006', 'f94d0000-0000-4000-8000-000000000006', 'HID-ASSKSTBND', 'Bound',
   'Synthetic', 'Bound Synthetic', 'active');
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, verified, verified_at, verification_provider, verification_reference, public_enrollment_id)
values (gen_random_uuid(), 'f94c0000-0000-4000-8000-000000000006', 'nin', decode(repeat('e6',32),'hex'),
  repeat('a6',32), 'fixture', true, clock_timestamp(), 'qoreid', 'assisted-bound',
  'f94a0000-0000-4000-8000-0000000000e6');
select pg_temp.seed_enrollment('f94a0000-0000-4000-8000-000000000006', repeat('a6',32), repeat('b6',32),
  'assisted-ref-006', 'desk-006', '9406');
set local role hid_identity_api_runtime;
select pg_temp.as_staff('11', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000011',
  'f9490000-0000-4000-8000-000000000011');
select set_config('suite.check_e6', (select id::text from pg_temp.record_check('check-e6',
  'f94a0000-0000-4000-8000-000000000006', repeat('c6',32), 'desk-006', 'matched')
  as (id uuid, outcome text, replayed boolean, proof text)), true);
select pg_temp.as_system('assisted-suite-system-0012');
do $$
begin
  if identity.record_public_patient_holder_proof('f94a0000-0000-4000-8000-000000000006', repeat('b6',32),
      'facility_in_person', null, current_setting('suite.check_e6')::uuid, repeat('c6',32), 5)
      <> 'existing_identity' then
    raise exception 'A bound NIN was not answered after the in-person proof';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.public_patient_enrollments where id = 'f94a0000-0000-4000-8000-000000000006')
     or (select proof_outcome from identity.assisted_registration_verifications
       where id = current_setting('suite.check_e6')::uuid) <> 'existing_identity'
     or (select count(*) from audit.events where action = 'identity.public-patient-enrollment.existing-identity'
       and correlation_id = 'assisted-suite-system-0012'
       and details = jsonb_build_object('method', 'facility_in_person', 'ninDigest', repeat('c6',32),
         'existingBinding', 'none_before_0093')) <> 1 then
    raise exception 'An existing Health ID after an in-person proof was not handled';
  end if;
end $$;

-- 10. Activation after an in-person proof. F1 activates; F2 and F3 are
-- refused when the designation or the verifying membership no longer holds.
select pg_temp.seed_enrollment(('f94a0000-0000-4000-8000-00000000007' || n)::uuid, repeat('7' || n, 32),
  repeat('8' || n, 32), 'assisted-ref-07' || n, 'desk-07' || n, '947' || n)
  from generate_series(1, 3) n;
set local role hid_identity_api_runtime;
select pg_temp.as_staff('11', 'f9410000-0000-4000-8000-00000000000a', 'f9440000-0000-4000-8000-000000000011',
  'f9490000-0000-4000-8000-000000000011');
select set_config('suite.check_f' || n, (select id::text from pg_temp.record_check('check-f' || n,
  ('f94a0000-0000-4000-8000-00000000007' || n)::uuid, repeat('9' || n, 32)::char(64), 'desk-07' || n, 'matched')
  as (id uuid, outcome text, replayed boolean, proof text)), true)
  from generate_series(1, 3) n;
select pg_temp.as_system('assisted-suite-system-0013');
do $$
declare
  n integer;
begin
  for n in 1..3 loop
    if identity.record_public_patient_holder_proof(('f94a0000-0000-4000-8000-00000000007' || n)::uuid,
        repeat('8' || n, 32)::char(64), 'facility_in_person', null,
        current_setting('suite.check_f' || n)::uuid, repeat('9' || n, 32)::char(64), 5) <> 'verified' then
      raise exception 'Fixture in-person proof % failed', n;
    end if;
  end loop;
end $$;
reset role;
insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, purpose,
  verifier_hmac, verifier_key_version, created_at, expires_at, max_attempts, delivery_outcome, verified_at, consumed_at)
select ('f94b0000-0000-4000-8000-00000000007' || n)::uuid, ('f94a0000-0000-4000-8000-00000000007' || n)::uuid,
  repeat('a' || n, 32), 'email', 'contact', repeat('ab',32), 'fixture', clock_timestamp(),
  clock_timestamp() + interval '5 minutes', 5, 'accepted', clock_timestamp(), clock_timestamp()
  from generate_series(1, 3) n;
update identity.public_patient_enrollments enrollment
   set state = 'set_password', contact_channel = 'email', contact_hmac = repeat('a' || n, 32),
       contact_lookup_hmac = repeat('b' || n, 32), contact_ciphertext = decode(repeat('d' || n, 32), 'hex'),
       contact_verified_at = clock_timestamp(),
       verified_challenge_id = ('f94b0000-0000-4000-8000-00000000007' || n)::uuid
  from generate_series(1, 3) n
 where enrollment.id = ('f94a0000-0000-4000-8000-00000000007' || n)::uuid;
-- F2: the designation of A is suspended before activation; F3: the verifying
-- nurse's role at A is revoked before activation. Each is restored after.
update identity.facility_assisted_registration set status = 'suspended'
 where facility_id = 'f9410000-0000-4000-8000-00000000000a';
set constraints all deferred;
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0014');
select pg_temp.expect_refusal(format($sql$select identity.activate_public_patient_enrollment(
  'f94a0000-0000-4000-8000-000000000072', repeat('82',32)::char(64),
  '{"nin":"12345679472","firstName":"Ada","lastName":"Synthetic","dateOfBirth":"1990-01-02","gender":"female","providerReference":"assisted-ref-072"}',
  'ada2@example.invalid', 'HID-ASSTFAF2', %L, repeat('b2',32)::char(64))$sql$,
  '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret'),
  '23514', 'PATIENT_HOLDER_PROOF_INVALID', 'activation after the verifying facility stopped taking part');
reset role;
update identity.facility_assisted_registration set status = 'active'
 where facility_id = 'f9410000-0000-4000-8000-00000000000a';
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = 'f9420000-0000-4000-8000-000000000001',
  revocation_reason = 'Synthetic revocation before activation' where id = 'f9450000-0000-4000-8000-000000000011';
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0015');
select pg_temp.expect_refusal(format($sql$select identity.activate_public_patient_enrollment(
  'f94a0000-0000-4000-8000-000000000073', repeat('83',32)::char(64),
  '{"nin":"12345679473","firstName":"Ada","lastName":"Synthetic","dateOfBirth":"1990-01-02","gender":"female","providerReference":"assisted-ref-073"}',
  'ada3@example.invalid', 'HID-ASSTFAG2', %L, repeat('b3',32)::char(64))$sql$,
  '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret'),
  '23514', 'PATIENT_HOLDER_PROOF_INVALID', 'activation after the verifying role was revoked');
reset role;
update auth.account_roles set revoked_at = null, revoked_by = null, revocation_reason = null
 where id = 'f9450000-0000-4000-8000-000000000011';
set local role hid_identity_api_runtime;
select pg_temp.as_system('assisted-suite-system-0016');
do $$
declare
  activated record;
begin
  select * into activated from identity.activate_public_patient_enrollment('f94a0000-0000-4000-8000-000000000071',
    repeat('81',32)::char(64),
    '{"nin":"12345679471","firstName":"Ada","lastName":"Synthetic","dateOfBirth":"1990-01-02","gender":"female","providerReference":"assisted-ref-071"}',
    'ada1@example.invalid', 'HID-ASSTFAE2',
    '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret',
    repeat('b1',32)::char(64));
  if activated.replayed or activated.patient_id is null then
    raise exception 'An enrollment proved in person did not activate';
  end if;
end $$;
reset role;
set constraints all immediate;
do $$
begin
  if (select assurance.nin_verified_at = verification.verified_at
      from identity.patient_assurance_states assurance
      join identity.public_patient_enrollments enrollment on enrollment.patient_id = assurance.patient_id
      join identity.assisted_registration_verifications verification on verification.id = enrollment.holder_verification_id
      where enrollment.id = 'f94a0000-0000-4000-8000-000000000071') is not true then
    raise exception 'The NIN was not recorded as verified at the in-person check';
  end if;
  if (select details->>'holderMethod' from audit.events where action = 'identity.public-patient-enrollment.activated'
      and correlation_id = 'assisted-suite-system-0016') is distinct from 'facility_in_person' then
    raise exception 'The activation audit event does not name the in-person method';
  end if;
  if (select count(*) from identity.patients where hid_code like 'HID-ASSTFA%') <> 1 then
    raise exception 'A refused activation created a patient';
  end if;
end $$;

-- 11. Desk-code rules on the enrollment.
select pg_temp.seed_enrollment('f94a0000-0000-4000-8000-000000000009', repeat('a9',32), repeat('b9',32),
  'assisted-ref-009', null, '9409');
do $$
begin
  begin
    update identity.public_patient_enrollments set desk_code_hmac = repeat('d9',32),
      desk_code_expires_at = expires_at where id = 'f94a0000-0000-4000-8000-000000000009';
    raise exception 'A desk code was stored without its salt';
  exception when check_violation then null; end;
  begin
    update identity.public_patient_enrollments set desk_code_hmac = repeat('d9',32), desk_code_salt = repeat('5b',16),
      desk_code_expires_at = expires_at + interval '1 second' where id = 'f94a0000-0000-4000-8000-000000000009';
    raise exception 'A desk code outlived its enrollment';
  exception when check_violation then null; end;
  begin
    update identity.public_patient_enrollments set desk_code_issues = 6 where id = 'f94a0000-0000-4000-8000-000000000009';
    raise exception 'A sixth desk code was counted';
  exception when check_violation then null; end;
  begin
    update identity.public_patient_enrollments set desk_code_hmac = repeat('d9',32), desk_code_salt = repeat('5b',16),
      desk_code_expires_at = expires_at, state = 'verify_contact', holder_method = 'registry_phone_otp',
      holder_verified_at = clock_timestamp(), holder_challenge_id = gen_random_uuid(),
      holder_recipient_hmac = repeat('3c',32)
      where id = 'f94a0000-0000-4000-8000-000000000009';
    raise exception 'A desk code was kept after the holder step';
  exception when check_violation then null; end;
  begin
    update identity.public_patient_enrollments set desk_code_hmac = (select desk_code_hmac
      from identity.public_patient_enrollments where id = 'f94a0000-0000-4000-8000-000000000001'),
      desk_code_salt = repeat('5b',16), desk_code_expires_at = expires_at
      where id = 'f94a0000-0000-4000-8000-000000000009';
    raise exception 'Two enrollments share a desk code';
  exception when unique_violation then null; end;
end $$;

rollback;
