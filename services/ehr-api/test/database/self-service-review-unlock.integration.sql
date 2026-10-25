\set ON_ERROR_STOP on
-- Full access after support's review (0086 section 5, P4b; owner decisions of
-- 2026-10-24/25). Rollback-only. Every command runs as the exact Identity API
-- runtime role, in the context Identity's transaction helpers set.
--
--   1. activation grants only the restricted role org_admin_awaiting_review,
--      after the application is approved; the review gate
--      (account_roles_review_gate, enabled 'O') refuses any other facility
--      role at a pending organization, also when the owner writes it, the
--      restricted role at a governed or reviewed organization, and any
--      facility role at a released one;
--   2. before review the restricted role resolves to six permissions and
--      reaches no patient data (registration, consent, break-glass, PIN,
--      organization CAC check), while Outreach and audit work;
--   3. the reviewable and preselected roles for 5 types x 4 products;
--   4. support's review: permissions (platform.facility.unlock; a
--      facility_review_admin + identity_review_admin pair succeeds), the
--      refusals in order, nothing written on a refusal, the grants, the
--      platform_review attestation, both audit rows and the sign-out;
--   5. support's change of the administrator's access afterwards and its
--      refusals;
--   6. the first 30 days: the sixth break-glass in 24 hours at a reviewed
--      facility is refused (P0001 EMERGENCY_PROBATION_LIMIT), a governed
--      facility and an ended or elapsed probation are not; ending it early
--      and its refusals;
--   7. a governed fixture's staff context (Identity's own SQL) is identical
--      before and after, and the state read answers no row for it and never
--      two rows for any organization;
--   8. a governed second-product approval for a self-signed-up organization
--      is refused while pending and approved after review (FEA R8);
--   9. release after review: invitations revoked, memberships ended before
--      their roles are revoked, grants revoked with one system audit row
--      each, requests expired, sessions revoked, counts in the audit.
-- See provider-self-enrollment.integration.sql for why FORCE is lifted on
-- the control table when its owner cannot bypass row-level security.
begin;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

-- Platform administrators, standalone (no facility membership). A custom role
-- holds facility.manage without facility.unlock, as every reviewer did
-- before 0086.
insert into auth.roles (code, description) values
  ('p4b_test_facility_manager', 'Suite-only facility manager without the unlock permission');
insert into auth.role_permissions (role_code, permission_code) values
  ('p4b_test_facility_manager', 'platform.admin.access'),
  ('p4b_test_facility_manager', 'platform.facility.manage'),
  ('p4b_test_facility_manager', 'platform.identity-review.read');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('d1000000-0000-4000-8000-000000000001', 'synthetic:unlock:super', 'super@unlock.invalid', 'Unlock Super Admin', 'active'),
  ('d1000000-0000-4000-8000-000000000002', 'synthetic:unlock:pair', 'pair@unlock.invalid', 'Unlock Review Pair', 'active'),
  ('d1000000-0000-4000-8000-000000000003', 'synthetic:unlock:manager', 'manager@unlock.invalid', 'Unlock Manager', 'active'),
  ('d1000000-0000-4000-8000-000000000004', 'synthetic:unlock:support', 'support@unlock.invalid', 'Unlock Support', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d1010000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform', 'Unlock suite super admin'),
  ('d1010000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'facility_review_admin', 'platform', 'Unlock suite review pair'),
  ('d1010000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000002', 'identity_review_admin', 'platform', 'Unlock suite review pair'),
  ('d1010000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000003', 'p4b_test_facility_manager', 'platform', 'Unlock suite manager'),
  ('d1010000-0000-4000-8000-000000000005', 'd1000000-0000-4000-8000-000000000004', 'support_admin', 'platform', 'Unlock suite support');

-- A governed organization: a facility, its administrator (org_admin) and a
-- doctor, as support's governed approval leaves them.
insert into identity.organizations (id, name, slug) values
  ('d1020000-0000-4000-8000-000000000001', 'Unlock Governed Org', 'unlock-governed-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('d1030000-0000-4000-8000-000000000001', 'd1020000-0000-4000-8000-000000000001',
   'Unlock Governed Facility', 'UNLOCK-GOVERNED', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('d1000000-0000-4000-8000-000000000011', 'synthetic:unlock:governed-admin', 'governed.admin@unlock.invalid', 'Governed Admin', 'active'),
  ('d1000000-0000-4000-8000-000000000012', 'synthetic:unlock:governed-doctor', 'governed.doctor@unlock.invalid', 'Governed Doctor', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('d1040000-0000-4000-8000-000000000011', 'd1000000-0000-4000-8000-000000000011', 'Governed Admin', 'governed.admin@unlock.invalid', 'verified', 'org_admin'),
  ('d1040000-0000-4000-8000-000000000012', 'd1000000-0000-4000-8000-000000000012', 'Governed Doctor', 'governed.doctor@unlock.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active) values
  ('d1050000-0000-4000-8000-000000000011', 'd1040000-0000-4000-8000-000000000011', 'd1000000-0000-4000-8000-000000000011',
   'd1020000-0000-4000-8000-000000000001', 'd1030000-0000-4000-8000-000000000001', 'org_admin', 'org_admin', true, true),
  ('d1050000-0000-4000-8000-000000000012', 'd1040000-0000-4000-8000-000000000012', 'd1000000-0000-4000-8000-000000000012',
   'd1020000-0000-4000-8000-000000000001', 'd1030000-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('d1010000-0000-4000-8000-000000000011', 'd1000000-0000-4000-8000-000000000011', 'org_admin', 'facility',
   'd1050000-0000-4000-8000-000000000011', 'd1030000-0000-4000-8000-000000000001', 'Unlock suite governed administrator'),
  ('d1010000-0000-4000-8000-000000000012', 'd1000000-0000-4000-8000-000000000012', 'doctor', 'facility',
   'd1050000-0000-4000-8000-000000000012', 'd1030000-0000-4000-8000-000000000001', 'Unlock suite governed doctor');

-- Patients for the break-glass and consent checks.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status)
select ('d1060000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'HID-UNLK' || translate(lpad(n::text, 4, '0'), '0123456789', 'ABCDEFGHJK'), 'Unlock', 'Patient', 'Unlock Patient', 'active'
  from generate_series(1, 12) n;

-- The governed staff context, with Identity's own query (current-staff-context
-- service), before any self sign-up exists.
create function pg_temp.staff_context(target_subject text) returns jsonb language sql as $f$
  select coalesce(jsonb_agg(to_jsonb(context) order by context.is_primary desc, context.facility_name,
    context.facility_id), '[]'::jsonb)
  from (
    select account.id::text as account_id, account.subject, account.email, account.display_name,
           membership.facility_id::text, membership.id::text as membership_id,
           membership.organization_id::text, facility.name as facility_name, facility.code as facility_code,
           array_remove(array[membership.membership_role, membership.app_role], null) as roles,
           coalesce(array_agg(distinct permission.code) filter (where permission.code is not null), array[]::text[]) as permissions,
           membership.is_primary
      from auth.accounts account
      join identity.staff_facility_memberships membership
        on membership.account_id = account.id and membership.active and membership.migration_hold_reason is null
      join identity.staff staff
        on staff.id = membership.staff_id and staff.account_id = account.id and staff.active
       and lower(btrim(staff.verification_status)) = any(array['verified', 'approved', 'active'])
      join identity.organizations organization on organization.id = membership.organization_id and organization.active
      join identity.facilities facility
        on facility.id = membership.facility_id and facility.organization_id = membership.organization_id and facility.active
      left join auth.account_roles account_role
        on account_role.account_id = account.id and account_role.scope_type = 'facility'
       and account_role.membership_id = membership.id and account_role.facility_id = membership.facility_id
       and account_role.revoked_at is null
      left join auth.roles role on role.code = account_role.role_code and role.active
      left join auth.role_permissions role_permission on role_permission.role_code = role.code
      left join auth.permissions permission on permission.code = role_permission.permission_code and permission.active
     where account.subject = $1 and account.status = 'active'
       and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
     group by account.id, account.subject, account.email, account.display_name,
              membership.id, membership.facility_id, membership.organization_id,
              membership.membership_role, membership.app_role, membership.is_primary,
              facility.name, facility.code
  ) context
$f$;
grant execute on function pg_temp.staff_context(text) to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select set_config('hid.test.governed_before', pg_temp.staff_context('synthetic:unlock:governed-admin')::text, true);
select set_config('hid.test.governed_doctor_before', pg_temp.staff_context('synthetic:unlock:governed-doctor')::text, true);
reset role;

-- Sign-ups through the real commands: 1 hospital/ehr, 2 laboratory, 3
-- pharmacy, 4 other/ehr, 5 clinic/migrate, 6 hospital (suspended), 7
-- hospital (account disabled), 8 hospital (membership missing), 9 hospital
-- (reviewed by the pair, then released), 10 other/laboratory.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:unlock:super', true),
  set_config('app.correlation_id', 'unlock-open-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'Unlock suite opens facility sign-up');
select platform.admin_set_control('staff_invitations_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Unlock suite opens staff invitations');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'unlock-signup-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  signup record;
  application_id uuid;
  current_application record;
  activated record;
  challenge_id uuid;
  code_hmac char(64);
  session_hmac char(64);
begin
  for signup in select * from (values
      (1, 'ehr', 'hospital', 'RC9910001001', 'Ada Unlock Admin', 'ada@unlock-hospital.invalid', 'Ada Unlock Hospital Ltd'),
      (2, 'laboratory', 'laboratory', 'RC9910001002', 'Bola Unlock Admin', 'bola@unlock-lab.invalid', 'Bola Unlock Laboratory Ltd'),
      (3, 'pharmacy', 'pharmacy', 'RC9910001003', 'Chidi Unlock Admin', 'chidi@unlock-pharmacy.invalid', 'Chidi Unlock Pharmacy Ltd'),
      (4, 'ehr', 'other', 'RC9910001004', 'Dayo Unlock Admin', 'dayo@unlock-other.invalid', 'Dayo Unlock Care Ltd'),
      (5, 'migrate', 'clinic', 'RC9910001005', 'Efe Unlock Admin', 'efe@unlock-clinic.invalid', 'Efe Unlock Clinic Ltd'),
      (6, 'ehr', 'hospital', 'RC9910001006', 'Femi Unlock Admin', 'femi@unlock-six.invalid', 'Femi Unlock Hospital Ltd'),
      (7, 'ehr', 'hospital', 'RC9910001007', 'Gbenga Unlock Admin', 'gbenga@unlock-seven.invalid', 'Gbenga Unlock Hospital Ltd'),
      (8, 'ehr', 'hospital', 'RC9910001008', 'Hauwa Unlock Admin', 'hauwa@unlock-eight.invalid', 'Hauwa Unlock Hospital Ltd'),
      (9, 'ehr', 'hospital', 'RC9910001009', 'Ike Unlock Admin', 'ike@unlock-nine.invalid', 'Ike Unlock Hospital Ltd'),
      (10, 'laboratory', 'other', 'RC9910001010', 'Jide Unlock Admin', 'jide@unlock-ten.invalid', 'Jide Unlock Diagnostics Ltd')
    ) as rows(n, product, kind, cac, admin_name, admin_email, legal_name) order by n loop
    application_id := identity.submit_self_service_organization_application(signup.product, signup.kind,
      signup.cac, signup.admin_name, signup.admin_email);
    select * into current_application from identity.public_get_organization_application(
      signup.cac, signup.admin_email, signup.product);
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', '9910' || signup.n, signup.cac, signup.legal_name, 'Private Company Limited by Shares',
      '2020-03-0' || (signup.n % 9 + 1), signup.n || ' Unlock Suite Road, Lagos', 'active');
    challenge_id := ('d1900000-0000-4000-8000-' || lpad(signup.n::text, 12, '0'))::uuid;
    code_hmac := encode(sha256(('unlock-otp-' || signup.n)::bytea), 'hex');
    session_hmac := encode(sha256(('unlock-session-' || signup.n)::bytea), 'hex');
    perform identity.begin_self_service_provider_enrollment(signup.cac, signup.admin_email,
      signup.product, challenge_id, code_hmac, signup.admin_name, signup.kind);
    if not identity.verify_organization_profile_completion_challenge(challenge_id, code_hmac, session_hmac) then
      raise exception 'Unlock sign-up % was not verified', signup.n;
    end if;
    select * into activated from identity.activate_self_service_provider_enrollment(session_hmac,
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    perform set_config('hid.test.u_app_' || signup.n, application_id::text, true);
    perform set_config('hid.test.u_facility_' || signup.n, activated.facility_id::text, true);
    perform set_config('hid.test.u_account_' || signup.n, activated.account_id::text, true);
    perform set_config('hid.test.u_org_' || signup.n, activated.organization_id::text, true);
  end loop;
end $$;
reset role;
select set_config('hid.test.u_membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.u_account_' || n)::uuid), true)
  from generate_series(1, 10) n;

-- 1. Activation and the review gate.
do $$
declare
  n integer;
  violated text;
begin
  for n in 1..10 loop
    if (select array_agg(assignment.role_code order by assignment.role_code) from auth.account_roles assignment
         where assignment.account_id = current_setting('hid.test.u_account_' || n)::uuid
           and assignment.revoked_at is null)
       is distinct from array['org_admin_awaiting_review'] then
      raise exception 'Activation % granted more than the restricted role', n;
    end if;
    if (select state.review_state from identity.organization_self_service_state(
          current_setting('hid.test.u_org_' || n)::uuid) state) is distinct from 'pending' then
      raise exception 'Activated organization % is not pending', n;
    end if;
  end loop;
  if not exists (select 1 from identity.staff_facility_memberships membership
                  where membership.id = current_setting('hid.test.u_membership_1')::uuid
                    and membership.membership_role = 'org_admin' and membership.app_role = 'org_admin') then
    raise exception 'The administrator membership lost its role name';
  end if;
  if (select tgenabled from pg_trigger where tgname = 'account_roles_review_gate'
        and tgrelid = 'auth.account_roles'::regclass) is distinct from 'O'
     or (select tgenabled from pg_trigger where tgname = 'consent_grants_self_service_probation'
        and tgrelid = 'identity.consent_grants'::regclass) is distinct from 'O' then
    raise exception 'A P4b trigger is not enabled';
  end if;
  -- The owner (this superuser session) cannot give another facility role at a
  -- pending organization either.
  foreach violated in array array['doctor', 'org_admin', 'nurse', 'receptionist'] loop
    begin
      insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
      values (gen_random_uuid(), current_setting('hid.test.u_account_1')::uuid, violated, 'facility',
        current_setting('hid.test.u_membership_1')::uuid, current_setting('hid.test.u_facility_1')::uuid,
        'Owner tries to bypass the review');
      raise exception 'The owner granted % at a pending organization', violated;
    exception when raise_exception then
      if sqlerrm <> 'FACILITY_REVIEW_PENDING' then raise; end if;
    end;
  end loop;
  -- Un-revoking a revoked row is checked too.
  begin
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
      grant_reason, revoked_at, revoked_by, revocation_reason)
    values ('d1010000-0000-4000-8000-0000000000a1', current_setting('hid.test.u_account_1')::uuid, 'doctor',
      'facility', current_setting('hid.test.u_membership_1')::uuid, current_setting('hid.test.u_facility_1')::uuid,
      'A revoked row is allowed', clock_timestamp(), 'd1000000-0000-4000-8000-000000000001', 'Revoked when written');
    update auth.account_roles set revoked_at = null, revoked_by = null, revocation_reason = null
     where id = 'd1010000-0000-4000-8000-0000000000a1';
    raise exception 'A revoked doctor row was revived at a pending organization';
  exception when raise_exception then
    if sqlerrm <> 'FACILITY_REVIEW_PENDING' then raise; end if;
  end;
  -- The restricted role at a governed organization.
  begin
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values (gen_random_uuid(), 'd1000000-0000-4000-8000-000000000012', 'org_admin_awaiting_review', 'facility',
      'd1050000-0000-4000-8000-000000000012', 'd1030000-0000-4000-8000-000000000001', 'Restricted role at a governed org');
    raise exception 'The restricted role was granted at a governed organization';
  exception when raise_exception then
    if sqlerrm <> 'FACILITY_REVIEW_ROLE_INVALID' then raise; end if;
  end;
  if (select count(*) from identity.organization_self_service_state('d1020000-0000-4000-8000-000000000001')) <> 0 then
    raise exception 'The state read answers a row for a governed organization';
  end if;
end $$;
-- The schema test runtime (which holds INSERT on auth.account_roles) is refused too.
set local role hid_schema_test_runtime;
do $$ begin
  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
  values (gen_random_uuid(), current_setting('hid.test.u_account_2')::uuid, 'lab', 'facility',
    current_setting('hid.test.u_membership_2')::uuid, current_setting('hid.test.u_facility_2')::uuid,
    'Runtime tries to bypass the review');
  raise exception 'A runtime granted lab at a pending organization';
exception when raise_exception then
  if sqlerrm <> 'FACILITY_REVIEW_PENDING' then raise; end if;
end $$;
reset role;

-- 2. Before review: the restricted role's permissions.
do $$
declare
  subject text := 'org-onboarding:' || current_setting('hid.test.u_account_1');
  membership uuid := current_setting('hid.test.u_membership_1')::uuid;
  facility uuid := current_setting('hid.test.u_facility_1')::uuid;
  permission text;
begin
  if (select array_agg(role_permission.permission_code order by role_permission.permission_code)
        from auth.role_permissions role_permission where role_permission.role_code = 'org_admin_awaiting_review')
     is distinct from array['audit.read', 'outreach.campaign.read', 'outreach.campaign.write',
       'outreach.registration.read', 'outreach.registration.write', 'workforce.manage'] then
    raise exception 'The restricted role does not hold exactly its six permissions';
  end if;
  if exists (select 1 from auth.role_permissions restricted
              where restricted.role_code = 'org_admin_awaiting_review'
                and not exists (select 1 from auth.role_permissions full_role
                                 where full_role.role_code = 'org_admin'
                                   and full_role.permission_code = restricted.permission_code)) then
    raise exception 'The restricted role holds a permission org_admin does not';
  end if;
  foreach permission in array array['identity.registration.write', 'identity.registration.approve',
      'identity.consent.write', 'identity.consent.read', 'identity.break-glass.write',
      'identity.patient-access-pin.verify', 'identity.patient.read', 'organization.manage', 'ehr.note.read',
      'lab.work-item.read', 'pharmacy.work-item.read'] loop
    if auth.membership_has_permission(subject, membership, facility, permission) then
      raise exception 'The pending administrator holds %', permission;
    end if;
  end loop;
  foreach permission in array array['workforce.manage', 'audit.read', 'outreach.registration.write',
      'outreach.campaign.write'] loop
    if not auth.membership_has_permission(subject, membership, facility, permission) then
      raise exception 'The pending administrator lacks %', permission;
    end if;
  end loop;
end $$;
-- Break-glass through its command is refused for lack of the permission.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.u_account_1'), true),
  set_config('app.membership_id', current_setting('hid.test.u_membership_1'), true),
  set_config('app.facility_id', current_setting('hid.test.u_facility_1'), true),
  set_config('app.correlation_id', 'unlock-before-review', true),
  set_config('app.purpose_of_use', 'emergency', true);
do $$ begin
  perform identity.activate_break_glass('HID-UNLKAAAB', 'Pending administrator emergency attempt', 30);
  raise exception 'A pending administrator activated break-glass';
exception when insufficient_privilege then null;
end $$;
reset role;

-- 3. The vocabulary: reviewable and preselected roles by type and product.
do $$
declare
  kind text;
  product text;
  expected_roles text[];
  expected_preselected text;
begin
  foreach kind in array array['hospital', 'clinic', 'laboratory', 'pharmacy', 'other'] loop
    foreach product in array array['ehr', 'migrate', 'laboratory', 'pharmacy'] loop
      expected_roles := case
        when kind in ('hospital', 'clinic') then array['doctor', 'nurse']
        when kind = 'laboratory' then array['lab']
        when kind = 'pharmacy' then array['pharmacist']
        when product in ('ehr', 'migrate') then array['doctor', 'nurse']
        when product = 'laboratory' then array['lab']
        else array['pharmacist'] end;
      expected_preselected := case kind when 'hospital' then 'doctor' when 'clinic' then 'doctor'
        when 'laboratory' then 'lab' when 'pharmacy' then 'pharmacist' else null end;
      if identity.self_service_reviewable_roles(kind, product) is distinct from expected_roles
         or identity.self_service_administrator_role(kind, product) is distinct from expected_preselected then
        raise exception 'Reviewable roles for % / % are %, preselected %', kind, product,
          identity.self_service_reviewable_roles(kind, product), identity.self_service_administrator_role(kind, product);
      end if;
    end loop;
  end loop;
  if identity.staff_role_licence_body('doctor') <> 'MDCN' or identity.staff_role_licence_body('nurse') <> 'NMCN'
     or identity.staff_role_licence_body('lab') <> 'MLSCN' or identity.staff_role_licence_body('pharmacist') <> 'PCN'
     or identity.staff_role_licence_body('receptionist') is not null
     or identity.staff_licence_key('MDCN', 'MDCN/12345') <> 'MDCN:12345'
     or identity.staff_licence_key('MDCN', 'mdcn 12345') <> 'MDCN:12345'
     or identity.staff_licence_key('MDCN', '12345') <> 'MDCN:12345'
     or identity.normalize_licence_number('  mdcn   12/345 ') <> 'MDCN 12/345' then
    raise exception 'The licence vocabulary is wrong';
  end if;
end $$;

-- Sessions of the hospital administrator, to see the review sign it out.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
select gen_random_uuid(), current_setting('hid.test.u_account_' || n)::uuid, gen_random_uuid(),
  encode(sha256(('unlock-refresh-' || n || '-' || k)::bytea), 'hex'), gen_random_uuid(), 1, 'password',
  clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '8 hours', 'staff'
  from generate_series(1, 10) n, generate_series(1, 2) k;

-- The administrator of facility 1 records its own licence before review
-- (support pre-fills the review with it).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.u_account_1'), true),
  set_config('app.membership_id', current_setting('hid.test.u_membership_1'), true),
  set_config('app.facility_id', current_setting('hid.test.u_facility_1'), true),
  set_config('app.correlation_id', 'unlock-own-licence', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select * from identity.record_self_service_administrator_licence('MDCN', ' mdcn/77 123 ');
reset role;

-- 4. Support's review.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:unlock:super', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare
  attempt record;
  first_version bigint := (select item.row_version from identity.admin_list_self_service_facilities('all') item
                            where item.application_id = current_setting('hid.test.u_app_1')::uuid);
begin
  perform set_config('app.correlation_id', 'unlock-review-refusals', true);
  for attempt in select * from (values
      (1, 'synthetic:unlock:manager', current_setting('hid.test.u_app_1')::uuid, first_version, 'doctor', 'regulator_register', 'MDCN', 'MDCN/77123', '42501', 'ADMIN_PERMISSION_DENIED'),
      (2, 'synthetic:unlock:support', current_setting('hid.test.u_app_1')::uuid, first_version, 'doctor', 'regulator_register', 'MDCN', 'MDCN/77123', '42501', 'ADMIN_PERMISSION_DENIED'),
      (3, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, first_version, 'doctor', 'telepathy', 'MDCN', 'MDCN/77123', '22023', 'SELF_SERVICE_REVIEW_INVALID'),
      (4, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, first_version, null, 'regulator_register', null, null, '22023', 'SELF_SERVICE_REVIEW_INVALID'),
      (5, 'synthetic:unlock:super', 'd1990000-0000-4000-8000-000000000001'::uuid, 1::bigint, 'doctor', 'regulator_register', 'MDCN', 'MDCN/77123', 'P0002', 'SELF_SERVICE_FACILITY_NOT_FOUND'),
      (6, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, first_version - 1, 'doctor', 'regulator_register', 'MDCN', 'MDCN/77123', '40001', 'Organization application version conflict'),
      (7, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, first_version, 'lab', 'regulator_register', 'MLSCN', 'ML/123', '22023', 'SELF_SERVICE_REVIEW_ROLE_INVALID'),
      (8, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, first_version, 'pharmacist', 'regulator_register', 'PCN', 'PCN/1', '22023', 'SELF_SERVICE_REVIEW_ROLE_INVALID'),
      (9, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, first_version, 'doctor', 'regulator_register', null, null, '22023', 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED'),
      (10, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, first_version, 'doctor', 'regulator_register', 'MDCN', null, '22023', 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED'),
      (11, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, first_version, 'doctor', 'regulator_register', 'NMCN', 'NMCN/1234', '22023', 'SELF_SERVICE_REVIEW_LICENCE_INVALID'),
      (12, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, first_version, 'doctor', 'regulator_register', 'MDCN', '#123', '22023', 'SELF_SERVICE_REVIEW_LICENCE_INVALID'),
      (13, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, first_version, 'none', 'officer_match', 'MDCN', 'MDCN/77123', '22023', 'SELF_SERVICE_REVIEW_LICENCE_INVALID'),
      (14, 'synthetic:unlock:super', current_setting('hid.test.u_app_2')::uuid,
        (select item.row_version from identity.admin_list_self_service_facilities('all') item
          where item.application_id = current_setting('hid.test.u_app_2')::uuid),
        'doctor', 'regulator_register', 'MDCN', 'MDCN/1', '22023', 'SELF_SERVICE_REVIEW_ROLE_INVALID')
    ) as rows(n, subject, target, version, role_code, method, body, number, expected_state, expected_message)
    order by n loop
    perform set_config('app.actor_subject', attempt.subject, true);
    begin
      perform identity.admin_review_self_service_facility(attempt.target, attempt.version,
        'Checked the company and its administrator', attempt.role_code, attempt.method, attempt.body, attempt.number);
      raise exception 'Review refusal % was accepted', attempt.n;
    exception when others then
      if sqlstate <> attempt.expected_state or sqlerrm <> attempt.expected_message then
        raise exception 'Review refusal % raised % (%) instead of % (%)', attempt.n, sqlstate, sqlerrm,
          attempt.expected_state, attempt.expected_message;
      end if;
    end;
  end loop;
end $$;
reset role;

-- 23514 with nothing written: facility 6 suspended, facility 7's account
-- disabled, facility 8's membership ended (owner SQL), and facility 1's
-- restricted role already revoked by hand.
update identity.facilities set active = false, lifecycle_status = 'suspended',
  status_reason = 'Unlock suite suspends the facility'
 where id = current_setting('hid.test.u_facility_6')::uuid;
update auth.accounts set status = 'disabled' where id = current_setting('hid.test.u_account_7')::uuid;
update identity.staff_facility_memberships set active = false
 where id = current_setting('hid.test.u_membership_8')::uuid;
select set_config('hid.test.audit_before_refusals', (select count(*)::text from audit.events), true);
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:unlock:super', true),
  set_config('app.correlation_id', 'unlock-review-inactive', true);
do $$
declare n integer;
begin
  foreach n in array array[6, 7, 8] loop
    begin
      perform identity.admin_review_self_service_facility(current_setting('hid.test.u_app_' || n)::uuid,
        (select item.row_version from identity.admin_list_self_service_facilities('all') item
          where item.application_id = current_setting('hid.test.u_app_' || n)::uuid),
        'Checked the company and its administrator', 'doctor', 'regulator_register', 'MDCN', 'MDCN/6' || n);
      raise exception 'Review of inactive case % was accepted', n;
    exception when check_violation then
      if sqlerrm <> 'SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE' then raise; end if;
    end;
  end loop;
end $$;
reset role;
do $$
declare n integer;
begin
  if (select count(*) from audit.events) <> current_setting('hid.test.audit_before_refusals')::bigint then
    raise exception 'A refused review wrote an audit row';
  end if;
  foreach n in array array[6, 7, 8] loop
    if exists (select 1 from identity.organization_applications app
                where app.id = current_setting('hid.test.u_app_' || n)::uuid
                  and (app.self_service_reviewed_at is not null or app.self_service_granted_role is not null))
       or exists (select 1 from auth.account_roles assignment
                   where assignment.account_id = current_setting('hid.test.u_account_' || n)::uuid
                     and assignment.role_code <> 'org_admin_awaiting_review')
       or not exists (select 1 from auth.sessions session_row
                       where session_row.account_id = current_setting('hid.test.u_account_' || n)::uuid
                         and session_row.revoked_at is null) then
      raise exception 'A refused review of case % changed something', n;
    end if;
  end loop;
end $$;

-- The hospital's review with the administrator's licence: doctor.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:unlock:super', true),
  set_config('app.correlation_id', 'unlock-review-0001', true);
do $$
declare
  result record;
  version_before bigint := (select item.row_version from identity.admin_list_self_service_facilities('all') item
                             where item.application_id = current_setting('hid.test.u_app_1')::uuid);
  listed record;
begin
  select * into listed from identity.admin_list_self_service_facilities('unreviewed') item
   where item.application_id = current_setting('hid.test.u_app_1')::uuid;
  if listed.review_grants_role is distinct from 'doctor' or listed.reviewable_roles is distinct from array['doctor', 'nurse']
     or listed.administrator_licence_body is distinct from 'MDCN'
     or listed.administrator_licence_number is distinct from 'MDCN/77 123'
     or listed.administrator_licence_body is distinct from 'MDCN'
     or listed.administrator_licence_recorded_at is null or listed.granted_role is not null
     or listed.member_count <> 1 or listed.pending_invitation_count <> 0 or listed.probation_ends_at is not null
     or listed.break_glass_last_7d <> 0 or listed.delivery_failures_last_day <> 0 then
    raise exception 'The unreviewed card is wrong: %', row_to_json(listed);
  end if;
  select * into result from identity.admin_review_self_service_facility(current_setting('hid.test.u_app_1')::uuid,
    version_before, ' Reached the company on its CAC contact number ', 'doctor', 'cac_registered_contact',
    'MDCN', listed.administrator_licence_number);
  if result.application_id <> current_setting('hid.test.u_app_1')::uuid or result.row_version <> version_before + 1
     or result.granted_role <> 'doctor' or result.sessions_revoked <> 2 or result.reviewed_at is null then
    raise exception 'The review answered %', row_to_json(result);
  end if;
  begin
    perform identity.admin_review_self_service_facility(current_setting('hid.test.u_app_1')::uuid,
      result.row_version, 'A second review attempt', 'none', 'other', null, null);
    raise exception 'A reviewed facility was reviewed again';
  exception when unique_violation then
    if sqlerrm <> 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED' then raise; end if;
  end;
  select * into listed from identity.admin_list_self_service_facilities('reviewed') item
   where item.application_id = current_setting('hid.test.u_app_1')::uuid;
  if listed.granted_role <> 'doctor' or listed.verification_method <> 'cac_registered_contact'
     or listed.probation_ends_at is distinct from listed.reviewed_at + interval '30 days' then
    raise exception 'The reviewed card is wrong: %', row_to_json(listed);
  end if;
end $$;
reset role;
do $$
declare
  account uuid := current_setting('hid.test.u_account_1')::uuid;
  membership uuid := current_setting('hid.test.u_membership_1')::uuid;
  facility uuid := current_setting('hid.test.u_facility_1')::uuid;
  attestation record;
  platform_row record;
  system_row record;
  permission text;
begin
  if not exists (select 1 from auth.account_roles assignment
                  where assignment.membership_id = membership and assignment.role_code = 'org_admin_awaiting_review'
                    and assignment.revoked_at is not null
                    and assignment.revoked_by = 'd1000000-0000-4000-8000-000000000001'
                    and assignment.revocation_reason = 'Facility reviewed by platform support')
     or (select array_agg(assignment.role_code || ':' || assignment.granted_by order by assignment.role_code)
           from auth.account_roles assignment where assignment.membership_id = membership and assignment.revoked_at is null)
        is distinct from array['doctor:d1000000-0000-4000-8000-000000000001', 'org_admin:d1000000-0000-4000-8000-000000000001'] then
    raise exception 'The review did not swap the restricted role for org_admin and doctor';
  end if;
  select * into attestation from identity.staff_licence_attestations row where row.membership_id = membership;
  if attestation.verification_method <> 'platform_review' or attestation.role_code <> 'doctor'
     or attestation.licence_body <> 'MDCN' or attestation.licence_number <> 'MDCN/77 123'
     or attestation.licence_key <> 'MDCN:77123' or attestation.attested_by_account_id <> 'd1000000-0000-4000-8000-000000000001'
     or attestation.attested_by_membership_id is not null or attestation.attestation_version <> 'platform-review-v1'
     or attestation.attested_person_name <> 'Ada Unlock Admin'
     or attestation.review_application_id <> current_setting('hid.test.u_app_1')::uuid
     or attestation.role_grant_id <> (select assignment.id from auth.account_roles assignment
                                       where assignment.membership_id = membership and assignment.role_code = 'doctor') then
    raise exception 'The review attestation is wrong: %', row_to_json(attestation);
  end if;
  if exists (select 1 from auth.sessions session_row where session_row.account_id = account and session_row.revoked_at is null)
     or (select count(*) from auth.sessions session_row where session_row.account_id = account
          and session_row.revocation_reason = 'facility_reviewed') <> 2 then
    raise exception 'The review did not sign the administrator out';
  end if;
  select * into platform_row from audit.events where action = 'admin.self-service-facility.review'
    and resource_id = current_setting('hid.test.u_app_1');
  select * into system_row from audit.events where action = 'identity.facility-access.unlock'
    and resource_id = current_setting('hid.test.u_app_1');
  if platform_row.actor_type <> 'platform' or platform_row.facility_id is not null
     or platform_row.details ->> 'grantedRole' <> 'doctor'
     or platform_row.details ->> 'verificationMethod' <> 'cac_registered_contact'
     or platform_row.details ->> 'licenceBody' <> 'MDCN'
     or (platform_row.details ->> 'sessionsRevoked')::integer <> 2
     or platform_row.details ->> 'membershipId' <> membership::text
     or platform_row.details::text ~ '77 ?123'
     or system_row.actor_type <> 'system' or system_row.facility_id <> facility
     or system_row.organization_id <> current_setting('hid.test.u_org_1')::uuid
     or system_row.details -> 'grantedRoles' <> '["org_admin", "doctor"]'::jsonb then
    raise exception 'The review audit rows are wrong: % / %', row_to_json(platform_row), row_to_json(system_row);
  end if;
  foreach permission in array array['identity.registration.write', 'identity.consent.write',
      'identity.break-glass.write', 'outreach.registration.write', 'organization.manage', 'workforce.manage',
      'ehr.note.read'] loop
    if not auth.membership_has_permission('org-onboarding:' || account, membership, facility, permission) then
      raise exception 'The reviewed administrator lacks %', permission;
    end if;
  end loop;
  -- The gate after review: a nurse role may be added; the restricted role not.
  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
  values ('d1010000-0000-4000-8000-0000000000b1', account, 'nurse', 'facility', membership, facility,
    'Allowed after support review');
  delete from auth.account_roles where id = 'd1010000-0000-4000-8000-0000000000b1';
  begin
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values (gen_random_uuid(), account, 'org_admin_awaiting_review', 'facility', membership, facility,
      'Restricted role after review');
    raise exception 'The restricted role was granted at a reviewed organization';
  exception when raise_exception then
    if sqlerrm <> 'FACILITY_REVIEW_ROLE_INVALID' then raise; end if;
  end;
end $$;

-- Other reviews: the laboratory as lab, the pharmacy as pharmacist, 'other'
-- EHR as none (nothing preselected), the clinic as nurse, 'other' laboratory
-- as lab, and facility 9 by the facility_review_admin + identity_review_admin pair.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:unlock:super', true),
  set_config('app.correlation_id', 'unlock-review-0002', true);
do $$
declare
  review record;
  result record;
  listed record;
begin
  for review in select * from (values
      (2, 'lab', 'MLSCN', 'ml/2020/55', 'regulator_register', 'synthetic:unlock:super'),
      (3, 'pharmacist', 'PCN', 'PCN-889', 'in_person', 'synthetic:unlock:super'),
      (4, 'none', null, null, 'officer_match', 'synthetic:unlock:super'),
      (5, 'nurse', 'NMCN', 'RN 4455', 'other', 'synthetic:unlock:super'),
      (10, 'lab', 'MLSCN', 'MLS 1010', 'regulator_register', 'synthetic:unlock:super'),
      (9, 'doctor', 'MDCN', 'MDCN/99', 'regulator_register', 'synthetic:unlock:pair')
    ) as rows(n, role_code, body, number, method, subject) loop
    perform set_config('app.actor_subject', review.subject, true);
    select * into listed from identity.admin_list_self_service_facilities('unreviewed') item
     where item.application_id = current_setting('hid.test.u_app_' || review.n)::uuid;
    if review.n = 4 and listed.review_grants_role is not null then
      raise exception 'Something is preselected for an other organization';
    end if;
    select * into result from identity.admin_review_self_service_facility(
      current_setting('hid.test.u_app_' || review.n)::uuid, listed.row_version, 'Checked the company and its administrator',
      review.role_code, review.method, review.body, review.number);
    if result.granted_role <> review.role_code or result.sessions_revoked <> 2 then
      raise exception 'Review % answered %', review.n, row_to_json(result);
    end if;
  end loop;
end $$;
reset role;
do $$
declare review record;
begin
  for review in select * from (values (2, 'lab'), (3, 'pharmacist'), (4, 'none'), (5, 'nurse'), (10, 'lab'),
      (9, 'doctor')) as rows(n, role_code) loop
    if (select array_agg(assignment.role_code order by assignment.role_code) from auth.account_roles assignment
          where assignment.membership_id = current_setting('hid.test.u_membership_' || review.n)::uuid
            and assignment.revoked_at is null)
       is distinct from (case when review.role_code = 'none' then array['org_admin']
         else (select array_agg(code order by code) from unnest(array['org_admin', review.role_code]) code) end) then
      raise exception 'Review % granted the wrong roles', review.n;
    end if;
    if (select count(*) from identity.staff_licence_attestations attestation
          where attestation.membership_id = current_setting('hid.test.u_membership_' || review.n)::uuid)
       <> (case when review.role_code = 'none' then 0 else 1 end) then
      raise exception 'Review % wrote the wrong attestations', review.n;
    end if;
  end loop;
  if not exists (select 1 from identity.staff_licence_attestations attestation
                  where attestation.membership_id = current_setting('hid.test.u_membership_2')::uuid
                    and attestation.licence_body = 'MLSCN' and attestation.licence_number = 'ML/2020/55'
                    and attestation.licence_key = 'MLSCN:ML202055')
     or not exists (select 1 from identity.staff_licence_attestations attestation
                     where attestation.membership_id = current_setting('hid.test.u_membership_9')::uuid
                       and attestation.attested_by_account_id = 'd1000000-0000-4000-8000-000000000002') then
    raise exception 'The laboratory or pair review attestation is wrong';
  end if;
end $$;

-- 5. Support changes the administrator's access afterwards.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:unlock:super', true),
  set_config('app.correlation_id', 'unlock-administrator-role', true);
do $$
declare
  version_of bigint;
  attempt record;
  result record;
begin
  select item.row_version into version_of from identity.admin_list_self_service_facilities('all') item
   where item.application_id = current_setting('hid.test.u_app_4')::uuid;
  for attempt in select * from (values
      (1, 'synthetic:unlock:manager', current_setting('hid.test.u_app_4')::uuid, version_of, 'doctor', 'MDCN', 'MDCN/44', 'regulator_register', 'Licence found on the register', '42501', 'ADMIN_PERMISSION_DENIED'),
      (2, 'synthetic:unlock:super', current_setting('hid.test.u_app_4')::uuid, version_of, 'doctor', 'MDCN', 'MDCN/44', 'regulator_register', 'short', '22023', 'SELF_SERVICE_REVIEW_INVALID'),
      (3, 'synthetic:unlock:super', current_setting('hid.test.u_app_6')::uuid, 1::bigint, 'doctor', 'MDCN', 'MDCN/44', 'regulator_register', 'Licence found on the register', 'P0002', 'SELF_SERVICE_FACILITY_NOT_FOUND'),
      (4, 'synthetic:unlock:super', current_setting('hid.test.u_app_4')::uuid, version_of - 1, 'doctor', 'MDCN', 'MDCN/44', 'regulator_register', 'Licence found on the register', '40001', 'Organization application version conflict'),
      (5, 'synthetic:unlock:super', current_setting('hid.test.u_app_4')::uuid, version_of, 'lab', 'MLSCN', 'ML/44', 'regulator_register', 'Licence found on the register', '22023', 'SELF_SERVICE_REVIEW_ROLE_INVALID'),
      (6, 'synthetic:unlock:super', current_setting('hid.test.u_app_4')::uuid, version_of, 'doctor', null, null, 'regulator_register', 'Licence found on the register', '22023', 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED'),
      (7, 'synthetic:unlock:super', current_setting('hid.test.u_app_4')::uuid, version_of, 'none', null, null, 'regulator_register', 'Licence found on the register', '23505', 'SELF_SERVICE_ADMINISTRATOR_ROLE_UNCHANGED')
    ) as rows(n, subject, target, version, role_code, body, number, method, reason, expected_state, expected_message)
    order by n loop
    perform set_config('app.actor_subject', attempt.subject, true);
    begin
      perform identity.admin_set_self_service_administrator_role(attempt.target, attempt.version, attempt.role_code,
        attempt.body, attempt.number, attempt.method, attempt.reason);
      raise exception 'Administrator-role refusal % was accepted', attempt.n;
    exception when others then
      if sqlstate <> attempt.expected_state or sqlerrm <> attempt.expected_message then
        raise exception 'Administrator-role refusal % raised % (%) instead of % (%)', attempt.n, sqlstate, sqlerrm,
          attempt.expected_state, attempt.expected_message;
      end if;
    end;
  end loop;
  perform set_config('app.actor_subject', 'synthetic:unlock:super', true);
  -- 'other' EHR, none -> doctor with a licence: the administrator is signed out.
  insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
  values (gen_random_uuid(), current_setting('hid.test.u_account_4')::uuid, gen_random_uuid(),
    encode(sha256('unlock-refresh-4-again'::bytea), 'hex'), gen_random_uuid(), 1, 'password', clock_timestamp(),
    clock_timestamp() + interval '1 hour', clock_timestamp() + interval '8 hours', 'staff');
  select * into result from identity.admin_set_self_service_administrator_role(current_setting('hid.test.u_app_4')::uuid,
    version_of, 'doctor', 'MDCN', 'MDCN/4444', 'regulator_register', 'Licence found on the register');
  if result.granted_role <> 'doctor' or result.sessions_revoked <> 1 or result.row_version <> version_of + 1 then
    raise exception 'The administrator-role change answered %', row_to_json(result);
  end if;
  -- The same role and licence key again: unchanged; another licence: a new grant.
  begin
    perform identity.admin_set_self_service_administrator_role(current_setting('hid.test.u_app_4')::uuid,
      result.row_version, 'doctor', 'MDCN', 'mdcn 4444', 'regulator_register', 'Licence found on the register');
    raise exception 'The same role and licence key was changed again';
  exception when unique_violation then
    if sqlerrm <> 'SELF_SERVICE_ADMINISTRATOR_ROLE_UNCHANGED' then raise; end if;
  end;
  select * into result from identity.admin_set_self_service_administrator_role(current_setting('hid.test.u_app_4')::uuid,
    result.row_version, 'nurse', 'NMCN', 'RN/4', 'in_person', 'Administrator is a nurse, not a doctor');
  select * into result from identity.admin_set_self_service_administrator_role(current_setting('hid.test.u_app_4')::uuid,
    result.row_version, 'none', null, null, 'other', 'Administrator gives up clinical access');
  if result.granted_role <> 'none' or result.sessions_revoked <> 0 then
    raise exception 'The change to none answered %', row_to_json(result);
  end if;
end $$;
reset role;
do $$ begin
  if (select array_agg(assignment.role_code order by assignment.role_code) from auth.account_roles assignment
        where assignment.membership_id = current_setting('hid.test.u_membership_4')::uuid and assignment.revoked_at is null)
     is distinct from array['org_admin']
     or (select count(*) from auth.account_roles assignment
          where assignment.membership_id = current_setting('hid.test.u_membership_4')::uuid
            and assignment.role_code in ('doctor', 'nurse') and assignment.revoked_at is not null
            and assignment.revocation_reason = 'Administrator access changed by platform support') <> 2
     or (select count(*) from identity.staff_licence_attestations attestation
          where attestation.membership_id = current_setting('hid.test.u_membership_4')::uuid
            and attestation.verification_method = 'platform_review') <> 2
     or (select count(*) from audit.events where action = 'admin.self-service-facility.administrator-role'
          and resource_id = current_setting('hid.test.u_app_4') and actor_type = 'platform') <> 3
     or (select count(*) from audit.events where action = 'identity.facility-access.change'
          and facility_id = current_setting('hid.test.u_facility_4')::uuid and actor_type = 'system') <> 3
     or (select self_service_granted_role from identity.organization_applications
          where id = current_setting('hid.test.u_app_4')::uuid) <> 'none' then
    raise exception 'The administrator-role changes left the wrong state';
  end if;
  -- The review's method stays (P4c's default listing reads it); each
  -- change's method is in the change's audit row only.
  if (select self_service_verification_method from identity.organization_applications
        where id = current_setting('hid.test.u_app_4')::uuid) <> 'officer_match'
     or (select array_agg(details ->> 'verificationMethod' order by details ->> 'verificationMethod') from audit.events
          where action = 'admin.self-service-facility.administrator-role'
            and resource_id = current_setting('hid.test.u_app_4'))
        is distinct from array['in_person', 'other', 'regulator_register'] then
    raise exception 'An administrator-role change replaced the review''s verification method';
  end if;
end $$;

-- 6. The first 30 days: 5 break-glass grants a day at a reviewed facility.
-- Five grants seeded by owner SQL at facility 1; the sixth, through the
-- command as its reviewed doctor administrator, is refused.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), ('d1060000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, membership.staff_id,
  membership.account_id, membership.id, membership.facility_id, 'break_glass', 'active',
  'Seeded emergency access for the probation check', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '1 hour', true, 'emergency'
  from generate_series(1, 5) n
  join identity.staff_facility_memberships membership on membership.id = current_setting('hid.test.u_membership_1')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.u_account_1'), true),
  set_config('app.membership_id', current_setting('hid.test.u_membership_1'), true),
  set_config('app.facility_id', current_setting('hid.test.u_facility_1'), true),
  set_config('app.correlation_id', 'unlock-probation-0001', true),
  set_config('app.purpose_of_use', 'emergency', true);
do $$ begin
  -- A replay of an active grant is never refused.
  perform identity.activate_break_glass('HID-UNLKAAAB', 'Replay of a seeded emergency access', 30);
  perform identity.activate_break_glass('HID-UNLKAAAG', 'Sixth emergency access on day one', 30);
  raise exception 'The sixth break-glass in 24 hours was allowed during the first 30 days';
exception when raise_exception then
  if sqlerrm <> 'EMERGENCY_PROBATION_LIMIT' then raise; end if;
end $$;
reset role;
-- A governed facility is not capped: six grants for the governed doctor.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), ('d1060000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'd1040000-0000-4000-8000-000000000012', 'd1000000-0000-4000-8000-000000000012',
  'd1050000-0000-4000-8000-000000000012', 'd1030000-0000-4000-8000-000000000001', 'break_glass', 'active',
  'Governed emergency access is not capped', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '1 hour', true, 'emergency'
  from generate_series(1, 6) n;
-- Facility 9 (reviewed 'pair', doctor): its 30 days elapsed (owner SQL moves
-- the review back), so it is not capped and its end is refused.
update identity.organization_applications set self_service_reviewed_at = clock_timestamp() - interval '31 days'
 where id = current_setting('hid.test.u_app_9')::uuid;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), ('d1060000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, membership.staff_id,
  membership.account_id, membership.id, membership.facility_id, 'break_glass', 'active',
  'Emergency access after the first 30 days', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '1 hour', true, 'emergency'
  from generate_series(1, 6) n
  join identity.staff_facility_memberships membership on membership.id = current_setting('hid.test.u_membership_9')::uuid;
-- Ending the first 30 days early.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:unlock:super', true),
  set_config('app.membership_id', '', true),
  set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'unlock-probation-end', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare
  version_of bigint := (select item.row_version from identity.admin_list_self_service_facilities('all') item
                         where item.application_id = current_setting('hid.test.u_app_1')::uuid);
  attempt record;
  result record;
begin
  for attempt in select * from (values
      (1, 'synthetic:unlock:manager', current_setting('hid.test.u_app_1')::uuid, version_of, 'Support lifts the limits', '42501'),
      (2, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, version_of, 'short', '22023'),
      (3, 'synthetic:unlock:super', current_setting('hid.test.u_app_6')::uuid, 1::bigint, 'Support lifts the limits', 'P0002'),
      (4, 'synthetic:unlock:super', current_setting('hid.test.u_app_1')::uuid, version_of - 1, 'Support lifts the limits', '40001'),
      (5, 'synthetic:unlock:super', current_setting('hid.test.u_app_9')::uuid,
        (select item.row_version from identity.admin_list_self_service_facilities('all') item
          where item.application_id = current_setting('hid.test.u_app_9')::uuid), 'Support lifts the limits', '23505')
    ) as rows(n, subject, target, version, reason, expected) order by n loop
    perform set_config('app.actor_subject', attempt.subject, true);
    begin
      perform identity.admin_end_self_service_probation(attempt.target, attempt.version, attempt.reason);
      raise exception 'End-probation refusal % was accepted', attempt.n;
    exception when others then
      if sqlstate <> attempt.expected then
        raise exception 'End-probation refusal % raised % (%) instead of %', attempt.n, sqlstate, sqlerrm, attempt.expected;
      end if;
    end;
  end loop;
  perform set_config('app.actor_subject', 'synthetic:unlock:super', true);
  select * into result from identity.admin_end_self_service_probation(current_setting('hid.test.u_app_1')::uuid,
    version_of, 'The hospital asked for its emergency limit to end');
  if result.probation_ended_at is null or result.row_version <> version_of + 1 then
    raise exception 'Ending the first 30 days answered %', row_to_json(result);
  end if;
  begin
    perform identity.admin_end_self_service_probation(current_setting('hid.test.u_app_1')::uuid,
      result.row_version, 'Asked again by the hospital');
    raise exception 'The first 30 days were ended twice';
  exception when unique_violation then
    if sqlerrm <> 'SELF_SERVICE_PROBATION_ALREADY_ENDED' then raise; end if;
  end;
  if exists (select 1 from identity.admin_list_self_service_facilities('reviewed') item
              where item.application_id = current_setting('hid.test.u_app_1')::uuid and item.probation_ends_at is not null) then
    raise exception 'The list still shows the ended first 30 days';
  end if;
end $$;
reset role;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.u_account_1'), true),
  set_config('app.membership_id', current_setting('hid.test.u_membership_1'), true),
  set_config('app.facility_id', current_setting('hid.test.u_facility_1'), true),
  set_config('app.correlation_id', 'unlock-probation-0002', true),
  set_config('app.purpose_of_use', 'emergency', true);
do $$
declare result record;
begin
  select * into result from identity.activate_break_glass('HID-UNLKAAAG', 'Sixth emergency access after the limit ended', 30);
  if result.existing_grant or result.grant_status <> 'active' then
    raise exception 'Break-glass after the first 30 days ended answered %', row_to_json(result);
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from audit.events where action = 'admin.self-service-facility.probation-end') <> 1
     or (select break_glass_last_7d from identity.organization_applications app,
           lateral (select count(*) as break_glass_last_7d from identity.consent_grants grant_row
                     where grant_row.facility_id = app.facility_id and grant_row.break_glass) counted
          where app.id = current_setting('hid.test.u_app_1')::uuid) <> 6 then
    raise exception 'The probation end was not audited, or the break-glass count is wrong';
  end if;
end $$;

-- 7. The governed staff context is byte-identical, and the state read answers
-- at most one row.
set local role hid_identity_api_runtime;
do $$ begin
  if pg_temp.staff_context('synthetic:unlock:governed-admin')::text <> current_setting('hid.test.governed_before')
     or pg_temp.staff_context('synthetic:unlock:governed-doctor')::text <> current_setting('hid.test.governed_doctor_before') then
    raise exception 'A governed staff context changed';
  end if;
  if exists (select 1 from identity.organization_self_service_state('d1020000-0000-4000-8000-000000000001')) then
    raise exception 'The Identity runtime reads a self-service state for a governed organization';
  end if;
end $$;
reset role;
-- A second activated self-service row for the same organization (another
-- product), by owner SQL: the state read still answers one row.
insert into identity.organization_applications
select (jsonb_populate_record(null::identity.organization_applications,
  to_jsonb(app) || jsonb_build_object('id', 'd1980000-0000-4000-8000-000000000001', 'product_code', 'pharmacy',
    'reviewed_at', app.reviewed_at - interval '1 day', 'self_service_reviewed_at', null,
    'self_service_reviewed_by_account_id', null, 'self_service_review_note', null,
    'self_service_granted_role', null, 'self_service_verification_method', null,
    'self_service_probation_ended_at', null, 'self_service_probation_ended_by_account_id', null,
    'self_service_probation_end_reason', null))).*
  from identity.organization_applications app where app.id = current_setting('hid.test.u_app_1')::uuid;
do $$ begin
  if (select count(*) from identity.organization_self_service_state(current_setting('hid.test.u_org_1')::uuid)) <> 1
     or (select state.review_state from identity.organization_self_service_state(current_setting('hid.test.u_org_1')::uuid) state)
        <> 'reviewed' then
    raise exception 'The state read answered more than one row, or the older one';
  end if;
end $$;
delete from identity.organization_applications where id = 'd1980000-0000-4000-8000-000000000001';

-- 8. A governed second-product application for a self-signed-up organization:
-- refused while pending (no active org_admin), approved after review. The
-- governed reviewer acts with a facility membership, as 0046 requires.
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d1010000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000011', 'platform_super_admin',
   'platform', 'Unlock suite governed reviewer');
insert into identity.organization_applications (
  id, product_code, organization_name, organization_type, cac_registration_number, administrator_name,
  administrator_email, status, verification_result, verified_at, provider_reference,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address,
  verified_registry_status, organization_name_source, entity_type_source, registration_date_source,
  address_source, registry_status_source, profile_state, provider_verified_registration_number,
  qoreid_organization_name, qoreid_entity_type, qoreid_registration_date, qoreid_address, qoreid_registry_status
) values
  ('d1980000-0000-4000-8000-000000000002', 'laboratory', 'Gbenga Unlock Hospital Ltd', 'hospital', 'RC9910001006',
   'Femi Unlock Admin', 'femi@unlock-six.invalid', 'ready_for_review', 'verified', now(), '99106',
   'Femi Unlock Hospital Ltd', 'Private Company Limited by Shares', '2020-03-07', '6 Unlock Suite Road, Lagos',
   'active', 'qoreid', 'qoreid', 'qoreid', 'qoreid', 'qoreid', 'complete', 'RC9910001006',
   'Femi Unlock Hospital Ltd', 'Private Company Limited by Shares', '2020-03-07', '6 Unlock Suite Road, Lagos', 'active'),
  ('d1980000-0000-4000-8000-000000000003', 'laboratory', 'Ada Unlock Hospital Ltd', 'hospital', 'RC9910001001',
   'Ada Unlock Admin', 'ada@unlock-hospital.invalid', 'ready_for_review', 'verified', now(), '99101',
   'Ada Unlock Hospital Ltd', 'Private Company Limited by Shares', '2020-03-02', '1 Unlock Suite Road, Lagos',
   'active', 'qoreid', 'qoreid', 'qoreid', 'qoreid', 'qoreid', 'complete', 'RC9910001001',
   'Ada Unlock Hospital Ltd', 'Private Company Limited by Shares', '2020-03-02', '1 Unlock Suite Road, Lagos', 'active');
-- Facility 6 is suspended; make it active again so only the review state differs.
update identity.facilities set active = true, lifecycle_status = 'verified', status_reason = null
 where id = current_setting('hid.test.u_facility_6')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:unlock:governed-admin', true),
  set_config('app.membership_id', 'd1050000-0000-4000-8000-000000000011', true),
  set_config('app.facility_id', 'd1030000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'unlock-governed-approval', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare result record;
begin
  begin
    perform identity.admin_approve_organization_application('d1980000-0000-4000-8000-000000000002', 1,
      current_setting('hid.test.u_org_6')::uuid, current_setting('hid.test.u_facility_6')::uuid,
      'Second product approved by the governed reviewer');
    raise exception 'A second product was approved for a pending self-signed-up organization';
  exception when check_violation then
    if sqlerrm <> 'Existing organization administrator requires manual resolution' then raise; end if;
  end;
  select * into result from identity.admin_approve_organization_application('d1980000-0000-4000-8000-000000000003', 1,
    current_setting('hid.test.u_org_1')::uuid, current_setting('hid.test.u_facility_1')::uuid,
    'Second product approved by the governed reviewer');
  if result.organization_id <> current_setting('hid.test.u_org_1')::uuid or not result.organization_reused then
    raise exception 'The reviewed organization''s second product was not approved: %', row_to_json(result);
  end if;
end $$;
reset role;

-- 9. Release after review. Facility 9 (reviewed by the pair) invites and
-- gets a member, who holds a consent grant, a pending access request and a
-- session; a second invitation stays pending. Then support suspends the
-- facility, disables the administrator and releases the sign-up.
update identity.organization_applications set self_service_reviewed_at = clock_timestamp() - interval '1 day'
 where id = current_setting('hid.test.u_app_9')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.u_account_9'), true),
  set_config('app.membership_id', current_setting('hid.test.u_membership_9'), true),
  set_config('app.facility_id', current_setting('hid.test.u_facility_9'), true),
  set_config('app.correlation_id', 'unlock-release-invite', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare created record;
begin
  select * into created from identity.create_staff_invitation('d1970000-0000-4000-8000-000000000001',
    'd1960000-0000-4000-8000-000000000001', 'Kemi Released', 'kemi@unlock-release.invalid', 'nurse', 'NMCN',
    'RN 9001', 'facility-staff-attestation-v1', 'unlock-release-invite-0001',
    encode(sha256('unlock-release-request-1'::bytea), 'hex'), encode(sha256('unlock-release-link-1'::bytea), 'hex'),
    encode(sha256('unlock-release-code-1'::bytea), 'hex'), 'v1');
  select * into created from identity.create_staff_invitation('d1970000-0000-4000-8000-000000000002',
    'd1960000-0000-4000-8000-000000000002', 'Lola Pending', 'lola@unlock-release.invalid', 'receptionist', null,
    null, 'facility-staff-attestation-v1', 'unlock-release-invite-0002',
    encode(sha256('unlock-release-request-2'::bytea), 'hex'), encode(sha256('unlock-release-link-2'::bytea), 'hex'),
    encode(sha256('unlock-release-code-2'::bytea), 'hex'), 'v1');
end $$;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.membership_id', '', true),
  set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'unlock-release-accept', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare opened record; prepared record; accepted record;
begin
  select * into opened from identity.open_staff_invitation('d1970000-0000-4000-8000-000000000001',
    encode(sha256('unlock-release-link-1'::bytea), 'hex'), null, null, encode(sha256('unlock-release-session-1'::bytea), 'hex'));
  select * into prepared from identity.prepare_staff_invitation_acceptance(encode(sha256('unlock-release-session-1'::bytea), 'hex'));
  select * into accepted from identity.accept_staff_invitation_with_password(
    encode(sha256('unlock-release-session-1'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('c', 22) || '$' || repeat('d', 43));
  if opened.result <> 'ready' or prepared.result <> 'ready' or accepted.membership_id is null then
    raise exception 'The release fixture''s acceptance failed: % / % / %', row_to_json(opened), row_to_json(prepared),
      row_to_json(accepted);
  end if;
  perform set_config('hid.test.release_member_account', accepted.account_id::text, true);
  perform set_config('hid.test.release_member_membership', accepted.membership_id::text, true);
end $$;
reset role;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, purpose_of_use)
select 'd1950000-0000-4000-8000-000000000001', 'd1060000-0000-4000-8000-000000000010', membership.staff_id,
  membership.account_id, membership.id, membership.facility_id, 'read_records', 'active',
  'Patient consented to the nurse', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day', 'direct-care'
  from identity.staff_facility_memberships membership
 where membership.id = current_setting('hid.test.release_member_membership')::uuid;
insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, reason, status,
  requested_duration_minutes, purpose_of_use)
select 'd1940000-0000-4000-8000-000000000001', 'd1060000-0000-4000-8000-000000000011', membership.staff_id,
  membership.id, membership.facility_id, 'read_records', 'Nurse asks to read the record', 'pending', 60, 'direct-care'
  from identity.staff_facility_memberships membership
 where membership.id = current_setting('hid.test.release_member_membership')::uuid;
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
select gen_random_uuid(), current_setting('hid.test.release_member_account')::uuid, gen_random_uuid(),
  encode(sha256('unlock-release-member-session'::bytea), 'hex'), gen_random_uuid(), account.token_version, 'password',
  clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '8 hours', 'staff'
  from auth.accounts account where account.id = current_setting('hid.test.release_member_account')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:unlock:super', true),
  set_config('app.correlation_id', 'unlock-release-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare result record; facility_version bigint; account_version bigint;
begin
  select facility.row_version into facility_version from identity.facilities facility
   where facility.id = current_setting('hid.test.u_facility_9')::uuid;
  select account.row_version into account_version from auth.accounts account
   where account.id = current_setting('hid.test.u_account_9')::uuid;
  perform identity.admin_transition_facility(current_setting('hid.test.u_facility_9')::uuid, facility_version,
    'suspended', 'Unlock suite suspends the facility', 'unlock-suite-suspend-0009', repeat('e', 64));
  perform auth.admin_transition_account(current_setting('hid.test.u_account_9')::uuid, account_version,
    'disabled', 'Unlock suite disables the administrator', 'unlock-suite-disable-0009', repeat('f', 64));
  select * into result from identity.admin_release_self_service_facility(current_setting('hid.test.u_app_9')::uuid,
    (select item.row_version from identity.admin_list_self_service_facilities('all') item
      where item.application_id = current_setting('hid.test.u_app_9')::uuid),
    'The sign-up did not match the company', false);
  if result.released_at is null then
    raise exception 'The release answered %', row_to_json(result);
  end if;
end $$;
reset role;
do $$
declare release_row record;
begin
  if exists (select 1 from identity.staff_invitations where id = 'd1970000-0000-4000-8000-000000000002'
              and not (status = 'revoked' and revoke_kind = 'release'
                and revoked_by_account_id = 'd1000000-0000-4000-8000-000000000001'))
     or exists (select 1 from identity.staff_facility_memberships
                 where organization_id = current_setting('hid.test.u_org_9')::uuid and active)
     or exists (select 1 from auth.account_roles assignment
                 join identity.staff_facility_memberships membership on membership.id = assignment.membership_id
                where membership.organization_id = current_setting('hid.test.u_org_9')::uuid
                  and assignment.revoked_at is null)
     or not exists (select 1 from identity.consent_grants where id = 'd1950000-0000-4000-8000-000000000001'
                     and status = 'revoked' and revoked_reason = 'Facility sign-up released by platform support')
     or not exists (select 1 from identity.access_requests where id = 'd1940000-0000-4000-8000-000000000001'
                     and status = 'expired')
     or exists (select 1 from auth.sessions where account_id = current_setting('hid.test.release_member_account')::uuid
                 and revoked_at is null)
     or not exists (select 1 from auth.sessions where account_id = current_setting('hid.test.release_member_account')::uuid
                     and revocation_reason = 'facility_sign_up_released') then
    raise exception 'The release did not end the facility''s staff access';
  end if;
  if not exists (select 1 from audit.events where action = 'identity.consent-grant.close' and actor_type = 'system'
                  and resource_id = 'd1950000-0000-4000-8000-000000000001'
                  and patient_id = 'd1060000-0000-4000-8000-000000000010'
                  and facility_id = current_setting('hid.test.u_facility_9')::uuid
                  and reason = 'Facility sign-up released by platform support') then
    raise exception 'The released grant was not audited as a system closure';
  end if;
  select * into release_row from audit.events where action = 'admin.self-service-facility.release'
    and resource_id = current_setting('hid.test.u_app_9');
  if (release_row.details ->> 'revokedInvitations')::integer <> 1
     or (release_row.details ->> 'endedMemberships')::integer <> 2
     or (release_row.details ->> 'revokedGrants')::integer <> 7
     or (select count(*) from audit.events where action = 'identity.consent-grant.close' and actor_type = 'system'
          and correlation_id = 'unlock-release-0001') <> 7
     or (release_row.details ->> 'expiredRequests')::integer <> 1
     or (release_row.details ->> 'revokedSessions')::integer < 1 then
    raise exception 'The release audit counts are wrong: %', release_row.details;
  end if;
  -- (The six emergency grants of section 6 at this facility count too.)
  -- The released organization: no facility role at all, not even the restricted one.
  begin
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values (gen_random_uuid(), current_setting('hid.test.u_account_9')::uuid, 'org_admin', 'facility',
      current_setting('hid.test.u_membership_9')::uuid, current_setting('hid.test.u_facility_9')::uuid,
      'A role at a released organization');
    raise exception 'A role was granted at a released organization';
  exception when raise_exception then
    if sqlerrm <> 'FACILITY_RELEASED' then raise; end if;
  end;
  if (select state.review_state from identity.organization_self_service_state(current_setting('hid.test.u_org_9')::uuid) state)
     <> 'released' then
    raise exception 'The released organization is not in the released state';
  end if;
end $$;

-- 10. The first 30 days end exactly 30 days after support's review (owner
-- SQL moves facility 4's review back; it never ended its first 30 days).
update identity.organization_applications set self_service_reviewed_at = clock_timestamp() - interval '29 days'
 where id = current_setting('hid.test.u_app_4')::uuid;
do $$ begin
  if not identity.self_service_on_probation(current_setting('hid.test.u_facility_4')::uuid) then
    raise exception 'The first 30 days ended before 30 days';
  end if;
end $$;
update identity.organization_applications set self_service_reviewed_at = clock_timestamp() - interval '30 days'
 where id = current_setting('hid.test.u_app_4')::uuid;
do $$ begin
  if identity.self_service_on_probation(current_setting('hid.test.u_facility_4')::uuid) then
    raise exception 'The first 30 days had not ended at 30 days';
  end if;
end $$;

rollback;
