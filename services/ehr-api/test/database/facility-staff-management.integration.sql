\set ON_ERROR_STOP on
-- The facility administrator's Staff page (0086 section 5, P4b). Rollback-
-- only. Every command runs as the exact Identity API runtime role in the
-- staff context Identity's withTransaction sets.
--
--   1. the reads (members, invitations, the page state) show only the
--      actor's facility, licence hints and never full numbers, the invitable
--      roles and the attestation text; they work while pending;
--   2. the administrator's own licence: only while pending, only by the
--      signing-up administrator, a body of the reviewable roles, replaced,
--      audited with the body only;
--   3. removing a member: roles revoked, pending requests expired, active
--      grants revoked with one identity.consent-grant.close row each; the
--      self, administrator, already-ended, version and reason refusals; not
--      before review; another facility's membership not found;
--   4. changing a member's role: the old role revoked, the new one granted
--      with an attestation, membership_role and app_role (and app_role alone
--      on a collision), the same role re-attested with another licence, the
--      same role and licence refused, a platform account refused, the roles
--      by type, the control.
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

insert into auth.accounts (id, subject, email, display_name, status) values
  ('d4000000-0000-4000-8000-000000000001', 'synthetic:manage:super', 'super@manage.invalid', 'Manage Super Admin', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d4010000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
   'Staff management suite super admin');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status)
select ('d4060000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'HID-MANG' || translate(lpad(n::text, 4, '0'), '0123456789', 'ABCDEFGHJK'), 'Manage', 'Patient', 'Manage Patient', 'active'
  from generate_series(1, 4) n;

-- Sign-ups: 1 hospital (reviewed), 2 laboratory (reviewed), 3 hospital (pending).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:manage:super', true),
  set_config('app.correlation_id', 'manage-open-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'Staff management suite opens facility sign-up');
select platform.admin_set_control('staff_invitations_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Staff management suite opens staff invitations');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'manage-signup-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  signup record;
  application_id uuid;
  current_application record;
  activated record;
begin
  for signup in select * from (values
      (1, 'ehr', 'hospital', 'RC9940004001', 'Ada Manage Admin', 'ada@manage-hospital.invalid', 'Ada Manage Hospital Ltd'),
      (2, 'laboratory', 'laboratory', 'RC9940004002', 'Bola Manage Admin', 'bola@manage-lab.invalid', 'Bola Manage Laboratory Ltd'),
      (3, 'ehr', 'hospital', 'RC9940004003', 'Chidi Manage Admin', 'chidi@manage-pending.invalid', 'Chidi Manage Hospital Ltd')
    ) as rows(n, product, kind, cac, admin_name, admin_email, legal_name) order by n loop
    application_id := identity.submit_self_service_organization_application(signup.product, signup.kind,
      signup.cac, signup.admin_name, signup.admin_email);
    select * into current_application from identity.public_get_organization_application(
      signup.cac, signup.admin_email, signup.product);
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', '9940' || signup.n, signup.cac, signup.legal_name, 'Private Company Limited by Shares',
      '2017-07-0' || signup.n, signup.n || ' Management Suite Road, Lagos', 'active');
    perform identity.begin_self_service_provider_enrollment(signup.cac, signup.admin_email, signup.product,
      ('d4900000-0000-4000-8000-00000000000' || signup.n)::uuid,
      encode(sha256(('manage-otp-' || signup.n)::bytea), 'hex'), signup.admin_name, signup.kind);
    perform identity.verify_organization_profile_completion_challenge(
      ('d4900000-0000-4000-8000-00000000000' || signup.n)::uuid, encode(sha256(('manage-otp-' || signup.n)::bytea), 'hex'),
      encode(sha256(('manage-session-' || signup.n)::bytea), 'hex'));
    select * into activated from identity.activate_self_service_provider_enrollment(
      encode(sha256(('manage-session-' || signup.n)::bytea), 'hex'),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    perform set_config('hid.test.m_app_' || signup.n, application_id::text, true);
    perform set_config('hid.test.m_facility_' || signup.n, activated.facility_id::text, true);
    perform set_config('hid.test.m_account_' || signup.n, activated.account_id::text, true);
    perform set_config('hid.test.m_org_' || signup.n, activated.organization_id::text, true);
  end loop;
end $$;
reset role;
select set_config('hid.test.m_membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.m_account_' || n)::uuid), true)
  from generate_series(1, 3) n;

create function pg_temp.as_staff(target_subject text, target_membership text, target_facility text, correlation text)
returns void language sql as $f$
  select set_config('app.actor_subject', target_subject, true), set_config('app.membership_id', target_membership, true),
    set_config('app.facility_id', target_facility, true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$f$;
create function pg_temp.as_admin(n integer, correlation text) returns void language sql as $f$
  select pg_temp.as_staff('org-onboarding:' || current_setting('hid.test.m_account_' || n),
    current_setting('hid.test.m_membership_' || n), current_setting('hid.test.m_facility_' || n), correlation);
$f$;
grant execute on function pg_temp.as_staff(text,text,text,text), pg_temp.as_admin(integer,text) to hid_identity_api_runtime;

-- 2 (first, while pending). The own licence at facility 1, then review.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'manage-licence-0001');
do $$
declare saved record; state record; attempt record;
begin
  select * into state from identity.facility_staff_management_state();
  if state.review_state <> 'pending' or state.on_probation or state.probation_ends_at is not null
     or not state.invitations_open or state.reviewable_licence_bodies <> array['MDCN', 'NMCN']
     or state.administrator_licence_body is not null or state.organization_type <> 'hospital'
     or state.invitable_roles <> array['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist']
     or state.attestation_version <> 'facility-staff-attestation-v1'
     or state.attestation_text not like 'I confirm that {name} works at {facility}%'
     or state.pending_limit <> 100 or state.invitations_per_day <> 30 or state.emails_per_day <> 60
     or state.validity_days <> 7 or state.pending_count <> 0 then
    raise exception 'The pending page state is wrong: %', row_to_json(state);
  end if;
  for attempt in select * from (values
      (1, 'MLSCN', 'ML 1', 'ADMINISTRATOR_LICENCE_INVALID'),
      (2, 'PCN', 'PCN 1', 'ADMINISTRATOR_LICENCE_INVALID'),
      (3, 'MDCN', '#1', 'ADMINISTRATOR_LICENCE_INVALID'),
      (4, null, 'MDCN/1', 'ADMINISTRATOR_LICENCE_INVALID'),
      (5, 'MDCN', null, 'ADMINISTRATOR_LICENCE_INVALID')
    ) as rows(n, body, number, expected) order by n loop
    begin
      perform identity.record_self_service_administrator_licence(attempt.body, attempt.number);
      raise exception 'Licence case % was accepted', attempt.n;
    exception when invalid_parameter_value then
      if sqlerrm <> attempt.expected then raise; end if;
    end;
  end loop;
  select * into saved from identity.record_self_service_administrator_licence('NMCN', 'rn  0001');
  select * into saved from identity.record_self_service_administrator_licence('MDCN', ' mdcn/55 4321 ');
  if saved.licence_body <> 'MDCN' or saved.number_hint <> '4321' or saved.recorded_at is null then
    raise exception 'The own licence answered %', row_to_json(saved);
  end if;
  select * into state from identity.facility_staff_management_state();
  if state.administrator_licence_body <> 'MDCN' or state.administrator_licence_hint <> '4321' then
    raise exception 'The page state does not show the replaced licence: %', row_to_json(state);
  end if;
  -- Members list before review: the administrator alone.
  if (select count(*) from identity.list_facility_staff()) <> 1
     or not (select listed.is_administrator and listed.is_self from identity.list_facility_staff() listed)
     or (select listed.roles from identity.list_facility_staff() listed) <> array['org_admin_awaiting_review'] then
    raise exception 'The pending members list is wrong';
  end if;
  -- Removing or changing anyone before review: FACILITY_REVIEW_PENDING.
  begin
    perform identity.end_facility_staff_membership(current_setting('hid.test.m_membership_1')::uuid, 1,
      'Removing before the review');
    raise exception 'A removal ran before review';
  exception when raise_exception then
    if sqlerrm <> 'FACILITY_REVIEW_PENDING' then raise; end if;
  end;
  begin
    perform identity.change_facility_staff_role(current_setting('hid.test.m_membership_1')::uuid, 1, 'nurse', 'NMCN',
      'RN 1', 'facility-staff-attestation-v1', 'Changing before the review');
    raise exception 'A role change ran before review';
  exception when raise_exception then
    if sqlerrm <> 'FACILITY_REVIEW_PENDING' then raise; end if;
  end;
end $$;
reset role;
-- A second holder of the restricted role at facility 3 (owner SQL) is not the
-- signing-up administrator.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('d4000000-0000-4000-8000-000000000031', 'synthetic:manage:co-admin', 'co.admin@manage-pending.invalid', 'Co Admin', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('d4040000-0000-4000-8000-000000000031', 'd4000000-0000-4000-8000-000000000031', 'Co Admin',
   'co.admin@manage-pending.invalid', 'verified', 'org_admin');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('d4050000-0000-4000-8000-000000000031', 'd4040000-0000-4000-8000-000000000031',
  'd4000000-0000-4000-8000-000000000031', current_setting('hid.test.m_org_3')::uuid,
  current_setting('hid.test.m_facility_3')::uuid, 'org_admin', 'org_admin', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('d4010000-0000-4000-8000-000000000031', 'd4000000-0000-4000-8000-000000000031', 'org_admin_awaiting_review',
  'facility', 'd4050000-0000-4000-8000-000000000031', current_setting('hid.test.m_facility_3')::uuid,
  'Staff management suite co-administrator');
set local role hid_identity_api_runtime;
select pg_temp.as_staff('synthetic:manage:co-admin', 'd4050000-0000-4000-8000-000000000031',
  current_setting('hid.test.m_facility_3'), 'manage-licence-co-admin');
do $$ begin
  perform identity.record_self_service_administrator_licence('MDCN', 'MDCN/31');
  raise exception 'A co-administrator recorded the signing-up administrator''s licence';
exception when raise_exception then
  if sqlerrm <> 'STAFF_MANAGEMENT_NOT_ADMINISTRATOR' then raise; end if;
end $$;
-- Review facilities 1 and 2.
select set_config('app.actor_subject', 'synthetic:manage:super', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'manage-review-0001', true);
do $$
declare n integer; listed record;
begin
  foreach n in array array[1, 2] loop
    select * into listed from identity.admin_list_self_service_facilities('unreviewed') item
     where item.application_id = current_setting('hid.test.m_app_' || n)::uuid;
    perform identity.admin_review_self_service_facility(listed.application_id, listed.row_version,
      'Checked the company and its administrator', case n when 1 then 'doctor' else 'none' end,
      'regulator_register', case n when 1 then listed.administrator_licence_body end,
      case n when 1 then listed.administrator_licence_number end);
  end loop;
end $$;
select pg_temp.as_admin(1, 'manage-licence-after');
do $$ begin
  perform identity.record_self_service_administrator_licence('MDCN', 'MDCN/1');
  raise exception 'The own licence was recorded after review';
exception when raise_exception then
  if sqlerrm <> 'FACILITY_ALREADY_REVIEWED' then raise; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from audit.events where action = 'identity.facility-administrator-licence.record'
       and actor_type = 'staff' and facility_id = current_setting('hid.test.m_facility_1')::uuid) <> 2
     or exists (select 1 from audit.events where action = 'identity.facility-administrator-licence.record'
                 and details not in ('{"licenceBody": "MDCN"}'::jsonb, '{"licenceBody": "NMCN"}'::jsonb)) then
    raise exception 'The own licence was not audited with its body only';
  end if;
end $$;

-- Members of facility 1: two accepted through invitations (a nurse and a
-- doctor), and, by owner SQL, a receptionist holding a platform role and a
-- pharmacist with an ended lab membership at the same facility (for the
-- collision). One member of facility 2 (lab).
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'manage-invite');
do $$
declare k integer; opened record; accepted record;
begin
  for k in 1..2 loop
    perform pg_temp.as_admin(1, 'manage-invite-' || k);
    perform identity.create_staff_invitation(('d4970000-0000-4000-8000-00000000000' || k)::uuid,
      ('d4960000-0000-4000-8000-00000000000' || k)::uuid, case k when 1 then 'Ngozi Nurse' else 'Dele Doctor' end,
      'member' || k || '@manage-people.invalid', case k when 1 then 'nurse' else 'doctor' end,
      case k when 1 then 'NMCN' else 'MDCN' end, case k when 1 then 'RN/1001' else 'MDCN/2002' end,
      'facility-staff-attestation-v1', 'manage-suite-key-00000' || k, encode(sha256(('manage-request-' || k)::bytea), 'hex'),
      encode(sha256(('manage-link-' || k)::bytea), 'hex'), encode(sha256(('manage-code-' || k)::bytea), 'hex'), 'v1');
    perform set_config('app.actor_subject', 'system:auth', true), set_config('app.membership_id', '', true),
      set_config('app.facility_id', '', true), set_config('app.purpose_of_use', '', true);
    select * into opened from identity.open_staff_invitation(('d4970000-0000-4000-8000-00000000000' || k)::uuid,
      encode(sha256(('manage-link-' || k)::bytea), 'hex'), null, null, encode(sha256(('manage-session-' || k)::bytea), 'hex'));
    perform identity.prepare_staff_invitation_acceptance(encode(sha256(('manage-session-' || k)::bytea), 'hex'));
    select * into accepted from identity.accept_staff_invitation_with_password(
      encode(sha256(('manage-session-' || k)::bytea), 'hex'),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('m', 22) || '$' || repeat('n', 43));
    perform set_config('hid.test.member_' || k, accepted.membership_id::text, true);
    perform set_config('hid.test.member_account_' || k, accepted.account_id::text, true);
  end loop;
end $$;
reset role;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('d4000000-0000-4000-8000-000000000003', 'synthetic:manage:platform-receptionist', 'member3@manage-people.invalid', 'Platform Receptionist', 'active'),
  ('d4000000-0000-4000-8000-000000000004', 'synthetic:manage:pharmacist', 'member4@manage-people.invalid', 'Paul Pharmacist', 'active'),
  ('d4000000-0000-4000-8000-000000000005', 'synthetic:manage:lab-member', 'member5@manage-people.invalid', 'Lara Lab', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d4010000-0000-4000-8000-000000000003', 'd4000000-0000-4000-8000-000000000003', 'support_admin', 'platform',
   'Staff management suite platform member');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('d4040000-0000-4000-8000-000000000003', 'd4000000-0000-4000-8000-000000000003', 'Platform Receptionist', 'member3@manage-people.invalid', 'verified', 'receptionist'),
  ('d4040000-0000-4000-8000-000000000004', 'd4000000-0000-4000-8000-000000000004', 'Paul Pharmacist', 'member4@manage-people.invalid', 'verified', 'pharmacist'),
  ('d4040000-0000-4000-8000-000000000005', 'd4000000-0000-4000-8000-000000000005', 'Lara Lab', 'member5@manage-people.invalid', 'verified', 'lab');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active) values
  ('d4050000-0000-4000-8000-000000000003', 'd4040000-0000-4000-8000-000000000003', 'd4000000-0000-4000-8000-000000000003',
   current_setting('hid.test.m_org_1')::uuid, current_setting('hid.test.m_facility_1')::uuid, 'receptionist', 'receptionist', true, true),
  ('d4050000-0000-4000-8000-000000000004', 'd4040000-0000-4000-8000-000000000004', 'd4000000-0000-4000-8000-000000000004',
   current_setting('hid.test.m_org_1')::uuid, current_setting('hid.test.m_facility_1')::uuid, 'pharmacist', 'pharmacist', true, true),
  ('d4050000-0000-4000-8000-000000000014', 'd4040000-0000-4000-8000-000000000004', 'd4000000-0000-4000-8000-000000000004',
   current_setting('hid.test.m_org_1')::uuid, current_setting('hid.test.m_facility_1')::uuid, 'lab', 'lab', false, false),
  ('d4050000-0000-4000-8000-000000000005', 'd4040000-0000-4000-8000-000000000005', 'd4000000-0000-4000-8000-000000000005',
   current_setting('hid.test.m_org_2')::uuid, current_setting('hid.test.m_facility_2')::uuid, 'lab', 'lab', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('d4010000-0000-4000-8000-000000000013', 'd4000000-0000-4000-8000-000000000003', 'receptionist', 'facility',
   'd4050000-0000-4000-8000-000000000003', current_setting('hid.test.m_facility_1')::uuid, 'Staff management suite member'),
  ('d4010000-0000-4000-8000-000000000014', 'd4000000-0000-4000-8000-000000000004', 'pharmacist', 'facility',
   'd4050000-0000-4000-8000-000000000004', current_setting('hid.test.m_facility_1')::uuid, 'Staff management suite member'),
  ('d4010000-0000-4000-8000-000000000015', 'd4000000-0000-4000-8000-000000000005', 'lab', 'facility',
   'd4050000-0000-4000-8000-000000000005', current_setting('hid.test.m_facility_2')::uuid, 'Staff management suite member');
-- The nurse holds two active grants and a pending access request.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, purpose_of_use)
select ('d4080000-0000-4000-8000-00000000000' || n)::uuid, ('d4060000-0000-4000-8000-00000000000' || n)::uuid,
  membership.staff_id, membership.account_id, membership.id, membership.facility_id, 'read_records', 'active',
  'Patient consented to the nurse', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day', 'direct-care'
  from generate_series(1, 2) n
  join identity.staff_facility_memberships membership on membership.id = current_setting('hid.test.member_1')::uuid;
insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, reason, status,
  requested_duration_minutes, purpose_of_use)
select 'd4070000-0000-4000-8000-000000000001', 'd4060000-0000-4000-8000-000000000003', membership.staff_id,
  membership.id, membership.facility_id, 'read_records', 'Nurse asks to read the record', 'pending', 60, 'direct-care'
  from identity.staff_facility_memberships membership where membership.id = current_setting('hid.test.member_1')::uuid;
insert into identity.staff_invitations (id, organization_id, facility_id, invited_by_account_id, invited_by_membership_id,
  invitee_name, invitee_email, role_code, licence_body, licence_number, attestation_version, attested_at,
  link_token_hmac, email_code_hmac, key_version, last_sent_at, last_send_id, expires_at, idempotency_key,
  request_sha256, correlation_id)
values ('d4970000-0000-4000-8000-000000000009', current_setting('hid.test.m_org_2')::uuid,
  current_setting('hid.test.m_facility_2')::uuid, current_setting('hid.test.m_account_2')::uuid,
  current_setting('hid.test.m_membership_2')::uuid, 'Other Facility Invitee', 'other@manage-people.invalid', 'lab', 'MLSCN',
  'ML 9999', 'facility-staff-attestation-v1', clock_timestamp(), repeat('1', 64), repeat('2', 64), 'v1', clock_timestamp(),
  gen_random_uuid(), clock_timestamp() + interval '7 days', 'manage-suite-other-facility', repeat('c', 64), 'manage-seed');

-- 1. The reads after review.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'manage-reads');
do $$
declare got record; state record;
begin
  if (select array_agg(listed.display_name order by listed.display_name) from identity.list_facility_staff() listed)
     <> array['Ada Manage Admin', 'Dele Doctor', 'Ngozi Nurse', 'Paul Pharmacist', 'Platform Receptionist'] then
    raise exception 'The members list is not facility 1''s active members';
  end if;
  select * into got from identity.list_facility_staff() listed where listed.membership_id = current_setting('hid.test.member_1')::uuid;
  if got.roles <> array['nurse'] or got.is_administrator or got.is_self or got.licence_body <> 'NMCN'
     or got.licence_number_hint <> '1001' or got.vouched_by_name <> 'Ada Manage Admin'
     or got.verification_method <> 'facility_attestation' or got.email <> 'member1@manage-people.invalid' then
    raise exception 'The nurse''s row is wrong: %', row_to_json(got);
  end if;
  select * into got from identity.list_facility_staff() listed where listed.is_self;
  if got.roles <> array['doctor', 'org_admin'] or not got.is_administrator or got.licence_body <> 'MDCN'
     or got.licence_number_hint <> '4321' or got.verification_method <> 'platform_review' then
    raise exception 'The administrator''s own row is wrong: %', row_to_json(got);
  end if;
  if exists (select 1 from identity.list_facility_staff() listed where listed.licence_number_hint ~ '/'
              or length(listed.licence_number_hint) > 4) then
    raise exception 'A members list shows more than a hint';
  end if;
  if (select count(*) from identity.list_facility_staff_invitations()) <> 2
     or exists (select 1 from identity.list_facility_staff_invitations() invitation
                 where invitation.status <> 'accepted' or invitation.licence_number_hint not in ('1001', '2002')) then
    raise exception 'The invitations list is wrong';
  end if;
  select * into state from identity.facility_staff_management_state();
  if state.review_state <> 'reviewed' or not state.on_probation or state.probation_ends_at is null
     or state.invitations_per_day <> 10 or state.emails_per_day <> 20 or state.invitations_last_day <> 2
     or state.emails_last_day <> 2 or state.delivery_paused then
    raise exception 'The reviewed page state is wrong: %', row_to_json(state);
  end if;
  perform pg_temp.as_admin(2, 'manage-reads-2');
  select * into state from identity.facility_staff_management_state();
  if state.invitable_roles <> array['lab', 'receptionist'] or state.reviewable_licence_bodies <> array['MLSCN']
     or (select count(*) from identity.list_facility_staff_invitations()) <> 1 then
    raise exception 'The laboratory''s page state is wrong: %', row_to_json(state);
  end if;
end $$;
reset role;

-- 3. Removing a member.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'manage-end-refusals');
do $$
declare attempt record;
begin
  for attempt in select * from (values
      (1, current_setting('hid.test.member_1')::uuid, 1::bigint, 'short', '22023', 'FACILITY_STAFF_REASON_INVALID'),
      (2, 'd4050000-0000-4000-8000-000000000005'::uuid, 1::bigint, 'Moved to another facility', 'P0002', 'FACILITY_STAFF_NOT_FOUND'),
      (3, current_setting('hid.test.m_membership_1')::uuid, 1::bigint, 'Removing myself from the facility', 'P0001', 'FACILITY_STAFF_SELF'),
      (4, 'd4050000-0000-4000-8000-000000000014'::uuid, 1::bigint, 'Removing an ended membership', 'P0001', 'FACILITY_STAFF_ALREADY_ENDED'),
      (5, current_setting('hid.test.member_1')::uuid, 9::bigint, 'Removing at a stale version', '40001',
        'Facility staff membership version conflict')
    ) as rows(n, target, version, reason, expected_state, expected_message) order by n loop
    begin
      perform identity.end_facility_staff_membership(attempt.target, attempt.version, attempt.reason);
      raise exception 'End refusal % was accepted', attempt.n;
    exception when others then
      if sqlstate <> attempt.expected_state or sqlerrm <> attempt.expected_message then
        raise exception 'End refusal % raised % (%) instead of % (%)', attempt.n, sqlstate, sqlerrm,
          attempt.expected_state, attempt.expected_message;
      end if;
    end;
  end loop;
end $$;
reset role;
-- An administrator membership (a second org_admin at facility 1, by owner SQL).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('d4000000-0000-4000-8000-000000000006', 'synthetic:manage:second-admin', 'second.admin@manage-people.invalid', 'Second Admin', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('d4040000-0000-4000-8000-000000000006', 'd4000000-0000-4000-8000-000000000006', 'Second Admin',
   'second.admin@manage-people.invalid', 'verified', 'org_admin');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('d4050000-0000-4000-8000-000000000006', 'd4040000-0000-4000-8000-000000000006',
  'd4000000-0000-4000-8000-000000000006', current_setting('hid.test.m_org_1')::uuid,
  current_setting('hid.test.m_facility_1')::uuid, 'org_admin', 'org_admin', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('d4010000-0000-4000-8000-000000000016', 'd4000000-0000-4000-8000-000000000006', 'org_admin', 'facility',
  'd4050000-0000-4000-8000-000000000006', current_setting('hid.test.m_facility_1')::uuid, 'Staff management suite admin');
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'manage-end-0001');
do $$
declare result record; version_of bigint;
begin
  begin
    perform identity.end_facility_staff_membership('d4050000-0000-4000-8000-000000000006', 1, 'Removing an administrator');
    raise exception 'An administrator membership was ended by the facility';
  exception when raise_exception then
    if sqlerrm <> 'FACILITY_STAFF_ADMINISTRATOR' then raise; end if;
  end;
  select listed.row_version into version_of from identity.list_facility_staff() listed
   where listed.membership_id = current_setting('hid.test.member_1')::uuid;
  select * into result from identity.end_facility_staff_membership(current_setting('hid.test.member_1')::uuid, version_of,
    ' The nurse left the hospital ');
  if result.row_version <> version_of + 1 or result.roles_revoked <> 1 or result.grants_revoked <> 2
     or result.requests_expired <> 1 or result.ended_at is null then
    raise exception 'The removal answered %', row_to_json(result);
  end if;
  begin
    perform identity.end_facility_staff_membership(current_setting('hid.test.member_1')::uuid, result.row_version,
      'The nurse left the hospital');
    raise exception 'An ended membership was ended again';
  exception when raise_exception then
    if sqlerrm <> 'FACILITY_STAFF_ALREADY_ENDED' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.staff_facility_memberships where id = current_setting('hid.test.member_1')::uuid and active)
     or exists (select 1 from auth.account_roles where membership_id = current_setting('hid.test.member_1')::uuid
                 and revoked_at is null)
     or not exists (select 1 from auth.account_roles where membership_id = current_setting('hid.test.member_1')::uuid
                     and revoked_by = current_setting('hid.test.m_account_1')::uuid
                     and revocation_reason = 'Staff member removed from the facility')
     or (select count(*) from identity.consent_grants where membership_id = current_setting('hid.test.member_1')::uuid
          and status = 'revoked' and revoked_by = current_setting('hid.test.m_account_1')::uuid
          and revoked_reason = 'Staff member removed from the facility') <> 2
     or (select status from identity.access_requests where id = 'd4070000-0000-4000-8000-000000000001') <> 'expired'
     or (select count(*) from audit.events where action = 'identity.consent-grant.close'
          and correlation_id = 'manage-end-0001' and actor_type = 'staff'
          and actor_account_id = current_setting('hid.test.m_account_1')::uuid
          and facility_id = current_setting('hid.test.m_facility_1')::uuid and patient_id is not null
          and reason = 'Staff member removed from the facility') <> 2
     or (select count(*) from audit.events where action = 'identity.facility-staff.end'
          and resource_id = current_setting('hid.test.member_1') and reason = 'The nurse left the hospital'
          and (details ->> 'grantsRevoked')::integer = 2) <> 1
     or exists (select 1 from auth.sessions where account_id = current_setting('hid.test.member_account_1')::uuid
                 and revocation_reason is not null) then
    raise exception 'The removal left the wrong state';
  end if;
end $$;

-- 4. Changing a member's role.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'manage-role-refusals');
do $$
declare attempt record; doctor_version bigint;
begin
  select listed.row_version into doctor_version from identity.list_facility_staff() listed
   where listed.membership_id = current_setting('hid.test.member_2')::uuid;
  for attempt in select * from (values
      (1, current_setting('hid.test.member_2')::uuid, doctor_version, 'admin', null, null, 'Promoting the doctor', '22023', 'STAFF_INVITATION_INVALID'),
      (2, current_setting('hid.test.member_2')::uuid, doctor_version, 'nurse', 'MDCN', 'RN 1', 'Doctor becomes a nurse', '22023', 'STAFF_INVITATION_INVALID'),
      (3, current_setting('hid.test.member_2')::uuid, doctor_version, 'nurse', 'NMCN', 'RN 1', 'short', '22023', 'FACILITY_STAFF_REASON_INVALID'),
      (4, current_setting('hid.test.member_2')::uuid, doctor_version, 'doctor', 'MDCN', ' mdcn/2002 ', 'Same licence again', 'P0001', 'FACILITY_STAFF_ROLE_UNCHANGED'),
      (5, 'd4050000-0000-4000-8000-000000000003'::uuid, 1::bigint, 'nurse', 'NMCN', 'RN 3', 'Platform member becomes a nurse', 'P0001', 'FACILITY_STAFF_PLATFORM_ACCOUNT'),
      (6, 'd4050000-0000-4000-8000-000000000006'::uuid, 1::bigint, 'nurse', 'NMCN', 'RN 6', 'Second admin becomes a nurse', 'P0001', 'FACILITY_STAFF_ADMINISTRATOR'),
      (7, current_setting('hid.test.member_2')::uuid, doctor_version - 1, 'nurse', 'NMCN', 'RN 1', 'Stale version change', '40001', 'Facility staff membership version conflict'),
      (8, 'd4050000-0000-4000-8000-000000000005'::uuid, 1::bigint, 'receptionist', null, null, 'Another facility member', 'P0002', 'FACILITY_STAFF_NOT_FOUND')
    ) as rows(n, target, version, role_code, body, number, reason, expected_state, expected_message) order by n loop
    begin
      perform identity.change_facility_staff_role(attempt.target, attempt.version, attempt.role_code, attempt.body,
        attempt.number, 'facility-staff-attestation-v1', attempt.reason);
      raise exception 'Role refusal % was accepted', attempt.n;
    exception when others then
      if sqlstate <> attempt.expected_state or sqlerrm <> attempt.expected_message then
        raise exception 'Role refusal % raised % (%) instead of % (%)', attempt.n, sqlstate, sqlerrm,
          attempt.expected_state, attempt.expected_message;
      end if;
    end;
  end loop;
  perform set_config('hid.test.doctor_version', doctor_version::text, true);
end $$;
-- The same role with another licence: a new attestation only.
do $$
declare result record; grant_before uuid;
begin
  select * into result from identity.change_facility_staff_role(current_setting('hid.test.member_2')::uuid,
    current_setting('hid.test.doctor_version')::bigint, 'doctor', 'MDCN', 'MDCN/7007', 'facility-staff-attestation-v1',
    'The doctor renewed the licence');
  if result.role_code <> 'doctor' or result.row_version <> current_setting('hid.test.doctor_version')::bigint + 1 then
    raise exception 'The re-attestation answered %', row_to_json(result);
  end if;
  -- Doctor -> pharmacist at the pharmacist's own facility... and pharmacist ->
  -- lab, which collides with the pharmacist's ended lab membership: app_role only.
  select * into result from identity.change_facility_staff_role('d4050000-0000-4000-8000-000000000004', 1, 'lab',
    'MLSCN', 'ml 4004', 'facility-staff-attestation-v1', 'The pharmacist now works in the laboratory');
  if result.role_code <> 'lab' then raise exception 'The collision change answered %', row_to_json(result); end if;
  -- Doctor -> nurse.
  select * into result from identity.change_facility_staff_role(current_setting('hid.test.member_2')::uuid,
    current_setting('hid.test.doctor_version')::bigint + 1, 'nurse', 'NMCN', 'RN/2002', 'facility-staff-attestation-v1',
    'The doctor works as a nurse here');
  -- Nurse -> receptionist (no licence, no attestation).
  select * into result from identity.change_facility_staff_role(current_setting('hid.test.member_2')::uuid,
    result.row_version, 'receptionist', null, null, 'facility-staff-attestation-v1', 'Now on the front desk');
  begin
    perform identity.change_facility_staff_role(current_setting('hid.test.member_2')::uuid, result.row_version,
      'receptionist', null, null, 'facility-staff-attestation-v1', 'Still on the front desk');
    raise exception 'An unchanged receptionist was changed';
  exception when raise_exception then
    if sqlerrm <> 'FACILITY_STAFF_ROLE_UNCHANGED' then raise; end if;
  end;
  -- At the laboratory, a doctor is not an invitable role.
  perform pg_temp.as_admin(2, 'manage-role-lab');
  begin
    perform identity.change_facility_staff_role('d4050000-0000-4000-8000-000000000005', 1, 'doctor', 'MDCN', 'MDCN/5',
      'facility-staff-attestation-v1', 'The lab member becomes a doctor');
    raise exception 'A doctor role was given at a laboratory';
  exception when invalid_parameter_value then
    if sqlerrm <> 'STAFF_INVITATION_ROLE_NOT_ALLOWED' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if (select array_agg(role_code || ':' || (revoked_at is null)::text order by granted_at, role_code)
        from auth.account_roles where membership_id = current_setting('hid.test.member_2')::uuid)
     <> array['doctor:false', 'nurse:false', 'receptionist:true']
     or (select count(*) from identity.staff_licence_attestations
          where membership_id = current_setting('hid.test.member_2')::uuid) <> 3
     or (select array_agg(licence_key order by recorded_at) from identity.staff_licence_attestations
          where membership_id = current_setting('hid.test.member_2')::uuid)
        <> array['MDCN:2002', 'MDCN:7007', 'NMCN:RN2002']
     or not exists (select 1 from identity.staff_facility_memberships where id = current_setting('hid.test.member_2')::uuid
                     and membership_role = 'receptionist' and app_role = 'receptionist')
     or not exists (select 1 from identity.staff_facility_memberships where id = 'd4050000-0000-4000-8000-000000000004'
                     and membership_role = 'pharmacist' and app_role = 'lab')
     or (select array_agg(role_code order by role_code) from auth.account_roles
          where membership_id = 'd4050000-0000-4000-8000-000000000004' and revoked_at is null) <> array['lab']
     or (select count(*) from audit.events where action = 'identity.facility-staff.role-change'
          and resource_id = current_setting('hid.test.member_2')) <> 3
     or exists (select 1 from identity.staff_licence_attestations where attested_person_name <> 'Dele Doctor'
                 and membership_id = current_setting('hid.test.member_2')::uuid)
     or exists (select 1 from audit.events where action like 'identity.facility-staff.%'
                 and details::text ~ 'manage-people|Dele|Ngozi|7007|2002|RN/') then
    raise exception 'The role changes left the wrong state';
  end if;
end $$;
-- The control closes role changes but not removals.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:manage:super', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'manage-close', true);
select platform.admin_set_control('staff_invitations_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Staff management suite closes staff invitations');
select pg_temp.as_admin(1, 'manage-closed');
do $$
declare result record;
begin
  begin
    perform identity.change_facility_staff_role('d4050000-0000-4000-8000-000000000004', 2, 'pharmacist', 'PCN', 'PCN 4',
      'facility-staff-attestation-v1', 'Back to the pharmacy');
    raise exception 'A role change ran with the control off';
  exception when object_not_in_prerequisite_state then null;
  end;
  select * into result from identity.end_facility_staff_membership('d4050000-0000-4000-8000-000000000004', 2,
    'The pharmacist left the hospital');
  if (select state.invitations_open from identity.facility_staff_management_state() state) then
    raise exception 'The page state says invitations are open with the control off';
  end if;
end $$;
reset role;

rollback;
