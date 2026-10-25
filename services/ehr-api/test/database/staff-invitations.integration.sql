\set ON_ERROR_STOP on
-- Facility staff invitations: invite, resend, revoke and the delivery record
-- (0086 section 5, P4b). Rollback-only. Every command runs as the exact
-- Identity API runtime role in the staff context Identity's withTransaction
-- sets (subject, membership, facility, correlation, healthcare-operations).
--
--   1. who may invite: only the administrator of a reviewed self-signed-up
--      facility (42501 STAFF_MANAGEMENT_PERMISSION_DENIED without
--      workforce.manage, 42501 STAFF_MANAGEMENT_NOT_AVAILABLE at a governed
--      facility, P0001 FACILITY_REVIEW_PENDING before review), with the
--      control on (55000);
--   2. every field shape and the licence pairing (22023
--      STAFF_INVITATION_INVALID), the roles each facility type may invite
--      (22023 STAFF_INVITATION_ROLE_NOT_ALLOWED), normalization;
--   3. idempotency scoped to the inviter and the facility (S16): a replay
--      sends nothing, another request with the key is refused, the same key
--      at another facility is another invitation;
--   4. self, member and pending refusals; stale pending invitations expired;
--   5. every limit at its boundary, after the first 30 days and during them;
--      the silent cross-facility cap (dispatch false, send suppressed,
--      'unknown' in the list) and the delivery pause;
--   6. resend: new hashes, 7 more days, the typed counter reset and the link
--      counter kept, the session ended, the cooldown, the send cap, stale
--      outcomes ignored, another facility's invitation not found; revoke;
--   7. the immutable columns, no delete, and the send's outcome-only update;
--   8. the audit rows (staff, the facility, ids and codes only).
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
  ('d2000000-0000-4000-8000-000000000001', 'synthetic:invite:super', 'super@invite.invalid', 'Invite Super Admin', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d2010000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'platform_super_admin',
   'platform', 'Invitation suite super admin');
-- A governed organization and its administrator.
insert into identity.organizations (id, name, slug) values
  ('d2020000-0000-4000-8000-000000000001', 'Invite Governed Org', 'invite-governed-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('d2030000-0000-4000-8000-000000000001', 'd2020000-0000-4000-8000-000000000001', 'Invite Governed Facility',
   'INVITE-GOVERNED', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('d2000000-0000-4000-8000-000000000011', 'synthetic:invite:governed-admin', 'governed.admin@invite.invalid', 'Governed Admin', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('d2040000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000011', 'Governed Admin',
   'governed.admin@invite.invalid', 'verified', 'org_admin');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active) values
  ('d2050000-0000-4000-8000-000000000011', 'd2040000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000011',
   'd2020000-0000-4000-8000-000000000001', 'd2030000-0000-4000-8000-000000000001', 'org_admin', 'org_admin', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('d2010000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000011', 'org_admin', 'facility',
   'd2050000-0000-4000-8000-000000000011', 'd2030000-0000-4000-8000-000000000001', 'Invitation suite governed admin');

-- Sign-ups: 1 hospital, 2 laboratory, 3 pharmacy, 4 hospital left pending,
-- 5 clinic, 6 other/pharmacy. All but 4 are reviewed ('none'); 1's first 30
-- days are ended so it has the normal limits.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:invite:super', true),
  set_config('app.correlation_id', 'invite-open-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'Invitation suite opens facility sign-up');
select platform.admin_set_control('staff_invitations_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Invitation suite opens staff invitations');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'invite-signup-0001', true),
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
      (1, 'ehr', 'hospital', 'RC9920002001', 'Ada Invite Admin', 'ada@invite-hospital.invalid', 'Ada Invite Hospital Ltd'),
      (2, 'laboratory', 'laboratory', 'RC9920002002', 'Bola Invite Admin', 'bola@invite-lab.invalid', 'Bola Invite Laboratory Ltd'),
      (3, 'pharmacy', 'pharmacy', 'RC9920002003', 'Chidi Invite Admin', 'chidi@invite-pharmacy.invalid', 'Chidi Invite Pharmacy Ltd'),
      (4, 'ehr', 'hospital', 'RC9920002004', 'Dayo Invite Admin', 'dayo@invite-pending.invalid', 'Dayo Invite Hospital Ltd'),
      (5, 'migrate', 'clinic', 'RC9920002005', 'Efe Invite Admin', 'efe@invite-clinic.invalid', 'Efe Invite Clinic Ltd'),
      (6, 'pharmacy', 'other', 'RC9920002006', 'Femi Invite Admin', 'femi@invite-other.invalid', 'Femi Invite Care Ltd')
    ) as rows(n, product, kind, cac, admin_name, admin_email, legal_name) order by n loop
    application_id := identity.submit_self_service_organization_application(signup.product, signup.kind,
      signup.cac, signup.admin_name, signup.admin_email);
    select * into current_application from identity.public_get_organization_application(
      signup.cac, signup.admin_email, signup.product);
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', '9920' || signup.n, signup.cac, signup.legal_name, 'Private Company Limited by Shares',
      '2019-05-0' || signup.n, signup.n || ' Invitation Suite Road, Lagos', 'active');
    challenge_id := ('d2900000-0000-4000-8000-' || lpad(signup.n::text, 12, '0'))::uuid;
    code_hmac := encode(sha256(('invite-otp-' || signup.n)::bytea), 'hex');
    session_hmac := encode(sha256(('invite-session-' || signup.n)::bytea), 'hex');
    perform identity.begin_self_service_provider_enrollment(signup.cac, signup.admin_email,
      signup.product, challenge_id, code_hmac, signup.admin_name, signup.kind);
    perform identity.verify_organization_profile_completion_challenge(challenge_id, code_hmac, session_hmac);
    select * into activated from identity.activate_self_service_provider_enrollment(session_hmac,
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    perform set_config('hid.test.i_app_' || signup.n, application_id::text, true);
    perform set_config('hid.test.i_facility_' || signup.n, activated.facility_id::text, true);
    perform set_config('hid.test.i_account_' || signup.n, activated.account_id::text, true);
    perform set_config('hid.test.i_org_' || signup.n, activated.organization_id::text, true);
  end loop;
end $$;
select set_config('app.actor_subject', 'synthetic:invite:super', true),
  set_config('app.correlation_id', 'invite-review-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare n integer; listed record; reviewed record;
begin
  foreach n in array array[1, 2, 3, 5, 6] loop
    select * into listed from identity.admin_list_self_service_facilities('unreviewed') item
     where item.application_id = current_setting('hid.test.i_app_' || n)::uuid;
    select * into reviewed from identity.admin_review_self_service_facility(listed.application_id, listed.row_version,
      'Checked the company and its administrator', 'none', 'cac_registered_contact', null, null);
  end loop;
  select * into listed from identity.admin_list_self_service_facilities('reviewed') item
   where item.application_id = current_setting('hid.test.i_app_1')::uuid;
  perform identity.admin_end_self_service_probation(listed.application_id, listed.row_version,
    'Invitation suite needs the normal limits');
end $$;
reset role;
select set_config('hid.test.i_membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.i_account_' || n)::uuid), true)
  from generate_series(1, 6) n;
-- Facility 1's administrator also administers facility 5 (owner SQL), for the
-- idempotency scope; facility 1 has a receptionist member (no workforce.manage).
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
select 'd2050000-0000-4000-8000-000000000015', staff.id, staff.account_id,
  current_setting('hid.test.i_org_5')::uuid, current_setting('hid.test.i_facility_5')::uuid,
  'org_admin', 'org_admin', false, true
  from identity.staff staff where staff.account_id = current_setting('hid.test.i_account_1')::uuid;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('d2010000-0000-4000-8000-000000000015', current_setting('hid.test.i_account_1')::uuid, 'org_admin', 'facility',
  'd2050000-0000-4000-8000-000000000015', current_setting('hid.test.i_facility_5')::uuid,
  'Invitation suite second facility');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('d2000000-0000-4000-8000-000000000021', 'synthetic:invite:receptionist', 'member@invite.invalid', 'Existing Member', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('d2040000-0000-4000-8000-000000000021', 'd2000000-0000-4000-8000-000000000021', 'Existing Member',
   'member@invite.invalid', 'verified', 'receptionist');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('d2050000-0000-4000-8000-000000000021', 'd2040000-0000-4000-8000-000000000021',
  'd2000000-0000-4000-8000-000000000021', current_setting('hid.test.i_org_1')::uuid,
  current_setting('hid.test.i_facility_1')::uuid, 'receptionist', 'receptionist', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('d2010000-0000-4000-8000-000000000021', 'd2000000-0000-4000-8000-000000000021', 'receptionist', 'facility',
  'd2050000-0000-4000-8000-000000000021', current_setting('hid.test.i_facility_1')::uuid, 'Invitation suite member');

-- Context and invitation helpers (the suite's own; they call the real commands).
create function pg_temp.as_staff(target_subject text, target_membership text, target_facility text, correlation text)
returns void language sql as $f$
  select set_config('app.actor_subject', target_subject, true), set_config('app.membership_id', target_membership, true),
    set_config('app.facility_id', target_facility, true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$f$;
create function pg_temp.as_admin(n integer, correlation text) returns void language sql as $f$
  select pg_temp.as_staff('org-onboarding:' || current_setting('hid.test.i_account_' || n),
    current_setting('hid.test.i_membership_' || n), current_setting('hid.test.i_facility_' || n), correlation);
$f$;
create function pg_temp.invite(k integer, invitee_name text, invitee_email text, role_code text, licence_body text,
  licence_number text, key_suffix text default '') returns record language sql as $f$
  select created from identity.create_staff_invitation(
    ('d2970000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid, ('d2960000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid,
    invitee_name, invitee_email, role_code, licence_body, licence_number, 'facility-staff-attestation-v1',
    'invite-suite-key-' || lpad(k::text, 6, '0') || key_suffix,
    encode(sha256(('invite-request-' || k || key_suffix)::bytea), 'hex'),
    encode(sha256(('invite-link-' || k)::bytea), 'hex'), encode(sha256(('invite-code-' || k)::bytea), 'hex'), 'v1') created
$f$;
grant execute on function pg_temp.as_staff(text,text,text,text), pg_temp.as_admin(integer,text),
  pg_temp.invite(integer,text,text,text,text,text,text) to hid_identity_api_runtime;

-- 1. Who may invite.
set local role hid_identity_api_runtime;
do $$
declare attempt record;
begin
  for attempt in select * from (values
      (1, 'synthetic:invite:receptionist', 'd2050000-0000-4000-8000-000000000021', current_setting('hid.test.i_facility_1'),
        '42501', 'STAFF_MANAGEMENT_PERMISSION_DENIED'),
      (2, 'synthetic:invite:governed-admin', 'd2050000-0000-4000-8000-000000000011', 'd2030000-0000-4000-8000-000000000001',
        '42501', 'STAFF_MANAGEMENT_NOT_AVAILABLE'),
      (3, 'org-onboarding:' || current_setting('hid.test.i_account_4'), current_setting('hid.test.i_membership_4'),
        current_setting('hid.test.i_facility_4'), 'P0001', 'FACILITY_REVIEW_PENDING'),
      (4, 'org-onboarding:' || current_setting('hid.test.i_account_1'), current_setting('hid.test.i_membership_1'),
        current_setting('hid.test.i_facility_5'), '42501', 'STAFF_MANAGEMENT_PERMISSION_DENIED'),
      (5, 'synthetic:invite:super', '', '', '42501', 'STAFF_MANAGEMENT_PERMISSION_DENIED')
    ) as rows(n, subject, membership, facility, expected_state, expected_message) order by n loop
    perform pg_temp.as_staff(attempt.subject, attempt.membership, attempt.facility, 'invite-who-' || attempt.n);
    begin
      perform pg_temp.invite(900 + attempt.n, 'Who Test', 'who' || attempt.n || '@invite-people.invalid', 'receptionist', null, null);
      raise exception 'Invitation case % was accepted', attempt.n;
    exception when others then
      if sqlstate <> attempt.expected_state or sqlerrm <> attempt.expected_message then
        raise exception 'Invitation case % raised % (%) instead of % (%)', attempt.n, sqlstate, sqlerrm,
          attempt.expected_state, attempt.expected_message;
      end if;
    end;
  end loop;
  -- The wrong purpose of use, or no correlation ID.
  perform pg_temp.as_admin(1, 'invite-who-6');
  perform set_config('app.purpose_of_use', 'direct-care', true);
  begin
    perform pg_temp.invite(906, 'Who Test', 'who6@invite-people.invalid', 'receptionist', null, null);
    raise exception 'An invitation with the wrong purpose was accepted';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
-- The control off: 55000, before anything is written.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:invite:super', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'invite-control-off', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('staff_invitations_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Invitation suite closes staff invitations');
select pg_temp.as_admin(1, 'invite-control-off-1');
do $$ begin
  perform pg_temp.invite(907, 'Closed Gate', 'closed@invite-people.invalid', 'receptionist', null, null);
  raise exception 'An invitation was created with the control off';
exception when object_not_in_prerequisite_state then
  if sqlerrm <> 'PLATFORM_CONTROL_DISABLED:staff_invitations_enabled' then raise; end if;
end $$;
select set_config('app.actor_subject', 'synthetic:invite:super', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'invite-control-on', true);
select platform.admin_set_control('staff_invitations_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Invitation suite opens staff invitations again');
reset role;
do $$ begin
  if exists (select 1 from identity.staff_invitations) then
    raise exception 'A refused invitation was written';
  end if;
end $$;

-- 2. Field shapes, pairing and roles by type.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'invite-shapes');
do $$
declare
  attempt record;
  base_key text := 'invite-shape-key-0000';
begin
  for attempt in select * from (values
      (1, 'Ade 1', 'shape1@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', base_key || '01', 'STAFF_INVITATION_INVALID'),
      (2, 'Dr. Ade', 'shape2@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', base_key || '02', 'STAFF_INVITATION_INVALID'),
      (3, 'A', 'shape3@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', base_key || '03', 'STAFF_INVITATION_INVALID'),
      (4, 'Ada  Obi', 'shape4@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', base_key || '04', 'STAFF_INVITATION_INVALID'),
      (5, 'Ada Obi@x', 'shape5@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', base_key || '05', 'STAFF_INVITATION_INVALID'),
      (6, ' Ada Obi', 'shape6@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', base_key || '06', 'STAFF_INVITATION_INVALID'),
      (7, 'Ada Obi', 'not-an-email', 'doctor', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', base_key || '07', 'STAFF_INVITATION_INVALID'),
      (8, 'Ada Obi', 'shape8@invite-people.invalid', 'admin', null, null, 'facility-staff-attestation-v1', base_key || '08', 'STAFF_INVITATION_INVALID'),
      (9, 'Ada Obi', 'shape9@invite-people.invalid', 'clinician', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', base_key || '09', 'STAFF_INVITATION_INVALID'),
      (10, 'Ada Obi', 'shape10@invite-people.invalid', 'org_admin', null, null, 'facility-staff-attestation-v1', base_key || '10', 'STAFF_INVITATION_INVALID'),
      (11, 'Ada Obi', 'shape11@invite-people.invalid', 'doctor', null, null, 'facility-staff-attestation-v1', base_key || '11', 'STAFF_INVITATION_INVALID'),
      (12, 'Ada Obi', 'shape12@invite-people.invalid', 'doctor', 'NMCN', 'NMCN/1', 'facility-staff-attestation-v1', base_key || '12', 'STAFF_INVITATION_INVALID'),
      (13, 'Ada Obi', 'shape13@invite-people.invalid', 'receptionist', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', base_key || '13', 'STAFF_INVITATION_INVALID'),
      (14, 'Ada Obi', 'shape14@invite-people.invalid', 'doctor', 'MDCN', '#1', 'facility-staff-attestation-v1', base_key || '14', 'STAFF_INVITATION_INVALID'),
      (15, 'Ada Obi', 'shape15@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v9', base_key || '15', 'STAFF_INVITATION_INVALID'),
      (16, 'Ada Obi', 'shape16@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/1', 'platform-review-v1', base_key || '16', 'STAFF_INVITATION_INVALID'),
      (17, 'Ada Obi', 'shape17@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', 'short-key', 'STAFF_INVITATION_INVALID'),
      (18, 'Ada Obi', 'shape18@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1', 'bad key with spaces!', 'STAFF_INVITATION_INVALID'),
      (19, 'Ada Obi', 'shape19@invite-people.invalid', 'nurse', 'NMCN', null, 'facility-staff-attestation-v1', base_key || '19', 'STAFF_INVITATION_INVALID')
    ) as rows(n, invitee_name, invitee_email, role_code, body, number, version, idempotency_key, expected) order by n loop
    begin
      perform identity.create_staff_invitation(('d2970000-0000-4000-8000-1000000000' || lpad(attempt.n::text, 2, '0'))::uuid,
        ('d2960000-0000-4000-8000-1000000000' || lpad(attempt.n::text, 2, '0'))::uuid,
        attempt.invitee_name, attempt.invitee_email, attempt.role_code, attempt.body, attempt.number, attempt.version,
        attempt.idempotency_key, encode(sha256(('shape-' || attempt.n)::bytea), 'hex'),
        encode(sha256(('shape-link-' || attempt.n)::bytea), 'hex'), encode(sha256(('shape-code-' || attempt.n)::bytea), 'hex'), 'v1');
      raise exception 'Shape case % was accepted', attempt.n;
    exception when invalid_parameter_value then
      if sqlerrm <> attempt.expected then
        raise exception 'Shape case % raised % instead of %', attempt.n, sqlerrm, attempt.expected;
      end if;
    end;
  end loop;
  -- Bad hashes.
  begin
    perform identity.create_staff_invitation('d2970000-0000-4000-8000-100000000020', 'd2960000-0000-4000-8000-100000000020',
      'Ada Obi', 'shape20@invite-people.invalid', 'receptionist', null, null, 'facility-staff-attestation-v1',
      base_key || '20', repeat('Z', 64), repeat('a', 64), repeat('b', 64), 'v1');
    raise exception 'A malformed request digest was accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
-- Roles by facility type (S9).
do $$
declare attempt record; result record;
begin
  for attempt in select * from (values
      (1, 2, 'doctor', 'MDCN', 'MDCN/2', false), (2, 2, 'nurse', 'NMCN', 'RN/2', false),
      (3, 2, 'pharmacist', 'PCN', 'PCN/2', false), (4, 2, 'lab', 'MLSCN', 'ML/2', true),
      (5, 2, 'receptionist', null, null, true), (6, 3, 'doctor', 'MDCN', 'MDCN/3', false),
      (7, 3, 'lab', 'MLSCN', 'ML/3', false), (8, 3, 'pharmacist', 'PCN', 'PCN/3', true),
      (9, 6, 'nurse', 'NMCN', 'RN/6', false), (10, 6, 'pharmacist', 'PCN', 'PCN/6', true),
      (11, 1, 'lab', 'MLSCN', 'ML/1', true), (12, 1, 'pharmacist', 'PCN', 'PCN/1', true),
      (13, 1, 'receptionist', null, null, true), (14, 5, 'nurse', 'NMCN', 'RN/5', true)
    ) as rows(n, facility, role_code, body, number, allowed) order by n loop
    perform pg_temp.as_admin(attempt.facility, 'invite-roles-' || attempt.n);
    begin
      select * into result from pg_temp.invite(200 + attempt.n, 'Role Person', 'role' || attempt.n || '@invite-people.invalid',
        attempt.role_code, attempt.body, attempt.number) as created(invitation_id uuid, row_version bigint, send_id uuid,
        expires_at timestamptz, replayed boolean, dispatch boolean, facility_name text, role_code text, invitee_email text);
      if not attempt.allowed then
        raise exception 'Role case % (% at facility %) was accepted', attempt.n, attempt.role_code, attempt.facility;
      end if;
    exception when invalid_parameter_value then
      if attempt.allowed or sqlerrm <> 'STAFF_INVITATION_ROLE_NOT_ALLOWED' then raise; end if;
    end;
  end loop;
end $$;
reset role;

-- 2 (normalization) and 3. Idempotency.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'invite-idempotency');
do $$
declare first_result record; replay record;
begin
  select * into first_result from identity.create_staff_invitation('d2970000-0000-4000-8000-000000000301',
    'd2960000-0000-4000-8000-000000000301', 'Ọlá Adébáyọ̀', '  Ola.Adebayo@Invite-People.Invalid ', 'doctor', 'MDCN',
    ' mdcn   12/345 ', 'facility-staff-attestation-v1', 'invite-suite-key-idem-0001',
    encode(sha256('idem-request-1'::bytea), 'hex'), encode(sha256('idem-link-1'::bytea), 'hex'),
    encode(sha256('idem-code-1'::bytea), 'hex'), 'v1');
  if first_result.replayed or not first_result.dispatch or first_result.invitee_email <> 'ola.adebayo@invite-people.invalid'
     or first_result.role_code <> 'doctor' or first_result.facility_name <> 'Ada Invite Hospital Ltd'
     or first_result.row_version <> 1 or first_result.send_id <> 'd2960000-0000-4000-8000-000000000301'
     or first_result.expires_at < clock_timestamp() + interval '6 days 23 hours' then
    raise exception 'The first invitation answered %', row_to_json(first_result);
  end if;
  select * into replay from identity.create_staff_invitation('d2970000-0000-4000-8000-000000000399',
    'd2960000-0000-4000-8000-000000000399', 'Ọlá Adébáyọ̀', 'ola.adebayo@invite-people.invalid', 'doctor', 'MDCN',
    'MDCN 12/345', 'facility-staff-attestation-v1', 'invite-suite-key-idem-0001',
    encode(sha256('idem-request-1'::bytea), 'hex'), encode(sha256('idem-link-9'::bytea), 'hex'),
    encode(sha256('idem-code-9'::bytea), 'hex'), 'v1');
  if not replay.replayed or replay.dispatch or replay.invitation_id <> first_result.invitation_id
     or replay.send_id <> first_result.send_id or replay.row_version <> first_result.row_version then
    raise exception 'The replay answered %', row_to_json(replay);
  end if;
  begin
    perform identity.create_staff_invitation('d2970000-0000-4000-8000-000000000398', 'd2960000-0000-4000-8000-000000000398',
      'Other Person', 'other.person@invite-people.invalid', 'receptionist', null, null, 'facility-staff-attestation-v1',
      'invite-suite-key-idem-0001', encode(sha256('idem-request-2'::bytea), 'hex'),
      encode(sha256('idem-link-8'::bytea), 'hex'), encode(sha256('idem-code-8'::bytea), 'hex'), 'v1');
    raise exception 'A reused idempotency key was accepted';
  exception when raise_exception then
    if sqlerrm <> 'IDEMPOTENCY_KEY_REUSED' then raise; end if;
  end;
  -- The same administrator and key at facility 5: another invitation, not a replay.
  perform pg_temp.as_staff('org-onboarding:' || current_setting('hid.test.i_account_1'),
    'd2050000-0000-4000-8000-000000000015', current_setting('hid.test.i_facility_5'), 'invite-idempotency-5');
  select * into replay from identity.create_staff_invitation('d2970000-0000-4000-8000-000000000397',
    'd2960000-0000-4000-8000-000000000397', 'Ọlá Adébáyọ̀', 'ola.adebayo@invite-people.invalid', 'doctor', 'MDCN',
    'MDCN 12/345', 'facility-staff-attestation-v1', 'invite-suite-key-idem-0001',
    encode(sha256('idem-request-1'::bytea), 'hex'), encode(sha256('idem-link-7'::bytea), 'hex'),
    encode(sha256('idem-code-7'::bytea), 'hex'), 'v1');
  if replay.replayed or replay.invitation_id = first_result.invitation_id then
    raise exception 'The key was not scoped to the facility: %', row_to_json(replay);
  end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from identity.staff_invitations where id = 'd2970000-0000-4000-8000-000000000301'
                  and invitee_name = 'Ọlá Adébáyọ̀' and invitee_email = 'ola.adebayo@invite-people.invalid'
                  and licence_body = 'MDCN' and licence_number = 'MDCN 12/345' and status = 'pending'
                  and reference = 'D2970000' and send_count = 1 and delivery_outcome = 'pending'
                  and attestation_version = 'facility-staff-attestation-v1'
                  and invited_by_membership_id = current_setting('hid.test.i_membership_1')::uuid)
     or (select count(*) from identity.staff_invitation_sends
          where invitation_id = 'd2970000-0000-4000-8000-000000000301') <> 1
     or exists (select 1 from identity.staff_invitations where id in ('d2970000-0000-4000-8000-000000000399',
          'd2970000-0000-4000-8000-000000000398')) then
    raise exception 'The invitation or its replay was not stored as expected';
  end if;
  if exists (select 1 from identity.staff where license_number is not null
              and lower(email) like '%invite-people.invalid') then
    raise exception 'An invitation wrote identity.staff.license_number';
  end if;
end $$;

-- 4. Self, member, pending, and stale pending rows expired.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'invite-refusals');
do $$
declare attempt record;
begin
  for attempt in select * from (values
      (1, 'Ada Invite Admin', ' ADA@invite-hospital.invalid', 'STAFF_INVITATION_SELF'),
      (2, 'Existing Member', 'member@invite.invalid', 'STAFF_INVITATION_ALREADY_MEMBER'),
      (3, 'Ọlá Adébáyọ̀', 'ola.adebayo@invite-people.invalid', 'STAFF_INVITATION_ALREADY_PENDING')
    ) as rows(n, invitee_name, invitee_email, expected) order by n loop
    begin
      perform pg_temp.invite(400 + attempt.n, attempt.invitee_name, attempt.invitee_email, 'receptionist', null, null);
      raise exception 'Refusal % was accepted', attempt.n;
    exception when raise_exception then
      if sqlerrm <> attempt.expected then
        raise exception 'Refusal % raised % instead of %', attempt.n, sqlerrm, attempt.expected;
      end if;
    end;
  end loop;
end $$;
reset role;
update identity.staff_invitations set expires_at = clock_timestamp() - interval '1 minute'
 where id = 'd2970000-0000-4000-8000-000000000301';
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'invite-after-expiry');
select pg_temp.invite(404, 'Ọlá Adébáyọ̀', 'ola.adebayo@invite-people.invalid', 'doctor', 'MDCN', 'MDCN/12345');
reset role;
do $$ begin
  if not exists (select 1 from identity.staff_invitations where id = 'd2970000-0000-4000-8000-000000000301'
                  and status = 'expired' and expired_at is not null and row_version = 2) then
    raise exception 'A stale pending invitation was not expired by the next invitation';
  end if;
end $$;

-- 5. Limits. Earlier invitations and sends are seeded by owner SQL (as
-- revoked invitations, so they hold nothing pending); the command is then
-- tried at each boundary.
create function pg_temp.seed_invitations(target_facility integer, first_k integer, how_many integer, invitee_email text,
  created timestamptz, status_value text default 'revoked') returns void language sql as $f$
  insert into identity.staff_invitations (id, organization_id, facility_id, invited_by_account_id,
    invited_by_membership_id, invitee_name, invitee_email, role_code, attestation_version, attested_at, status,
    link_token_hmac, email_code_hmac, key_version, last_sent_at, last_send_id, expires_at, revoked_at,
    revoked_by_account_id, revoke_kind, idempotency_key, request_sha256, correlation_id, created_at)
  select ('d2980000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid,
    current_setting('hid.test.i_org_' || target_facility)::uuid, current_setting('hid.test.i_facility_' || target_facility)::uuid,
    current_setting('hid.test.i_account_' || target_facility)::uuid,
    current_setting('hid.test.i_membership_' || target_facility)::uuid, 'Seeded Person',
    replace(invitee_email, '#', k::text), 'receptionist', 'facility-staff-attestation-v1', created, status_value,
    encode(sha256(('seed-link-' || k)::bytea), 'hex'), encode(sha256(('seed-code-' || k)::bytea), 'hex'), 'v1',
    created, gen_random_uuid(), case when status_value = 'pending' then clock_timestamp() + interval '6 days'
      else created + interval '7 days' end,
    case when status_value = 'revoked' then created end,
    case when status_value = 'revoked' then current_setting('hid.test.i_account_' || target_facility)::uuid end,
    case when status_value = 'revoked' then 'facility' end,
    'seeded-invitation-key-' || lpad(k::text, 6, '0'), repeat('a', 64), 'invite-seed-correlation', created
    from generate_series(first_k, first_k + how_many - 1) k;
$f$;
-- Seeds one invitation (created a day before the sends) and how_many sends of it.
create function pg_temp.seed_sends(target_facility integer, first_k integer, how_many integer, invitee_email text,
  sent timestamptz, outcome_value text default 'accepted') returns void language sql as $f$
  select pg_temp.seed_invitations(target_facility, first_k, 1, invitee_email, sent - interval '1 day');
  insert into identity.staff_invitation_sends (id, invitation_id, facility_id, invitee_email, sent_by_account_id, kind,
    link_token_hmac, email_code_hmac, dispatched, outcome, sent_at, outcome_at)
  select ('d2990000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid,
    ('d2980000-0000-4000-8000-' || lpad(first_k::text, 12, '0'))::uuid,
    current_setting('hid.test.i_facility_' || target_facility)::uuid, replace(invitee_email, '#', first_k::text),
    current_setting('hid.test.i_account_' || target_facility)::uuid, 'resend',
    encode(sha256(('seed-link-' || k)::bytea), 'hex'), encode(sha256(('seed-code-' || k)::bytea), 'hex'),
    true, outcome_value, sent, case when outcome_value = 'pending' then null else sent end
    from generate_series(first_k, first_k + how_many - 1) k;
$f$;
create function pg_temp.try_invite(n integer, k integer, invitee_email text) returns text language plpgsql as $f$
declare created record;
begin
  perform pg_temp.as_admin(n, 'invite-limit-' || k);
  select * into created from pg_temp.invite(k, 'Limit Person', invitee_email, 'receptionist', null, null)
    as result(invitation_id uuid, row_version bigint, send_id uuid, expires_at timestamptz, replayed boolean,
      dispatch boolean, facility_name text, role_code text, invitee_email text);
  return case when created.dispatch then 'created' else 'created, not dispatched' end;
exception when raise_exception then
  return sqlerrm;
end $f$;
create function pg_temp.facility_count(n integer, what text) returns integer language sql as $f$
  select case what
    when 'invitations_day' then (select count(*)::integer from identity.staff_invitations invitation
      where invitation.facility_id = current_setting('hid.test.i_facility_' || n)::uuid
        and invitation.created_at > clock_timestamp() - interval '24 hours')
    when 'emails_day' then (select count(*)::integer from identity.staff_invitation_sends send
      where send.facility_id = current_setting('hid.test.i_facility_' || n)::uuid
        and send.sent_at > clock_timestamp() - interval '24 hours')
    when 'pending' then (select count(*)::integer from identity.staff_invitations invitation
      where invitation.facility_id = current_setting('hid.test.i_facility_' || n)::uuid and invitation.status = 'pending')
  end
$f$;
grant execute on function pg_temp.try_invite(integer,integer,text) to hid_identity_api_runtime;

-- a. New invitations a day during the first 30 days (facility 2): 10. One
-- seeded 25 hours ago does not count.
select pg_temp.seed_invitations(2, 1000, 1, 'old-daily-#@invite-seeds.invalid', clock_timestamp() - interval '25 hours');
select pg_temp.seed_invitations(2, 1001, 9 - pg_temp.facility_count(2, 'invitations_day'), 'daily-#@invite-seeds.invalid',
  clock_timestamp() - interval '2 hours');
set local role hid_identity_api_runtime;
do $$ begin
  if pg_temp.try_invite(2, 501, 'tenth@invite-people.invalid') <> 'created'
     or pg_temp.try_invite(2, 502, 'eleventh@invite-people.invalid') <> 'STAFF_INVITATION_DAILY_LIMIT' then
    raise exception 'The first-30-days limit of 10 invitations a day was not enforced at its boundary';
  end if;
end $$;
reset role;
-- b. Emails a day during the first 30 days (facility 3): 20.
select pg_temp.seed_sends(3, 1100, 19 - pg_temp.facility_count(3, 'emails_day'), 'mail-#@invite-seeds.invalid',
  clock_timestamp() - interval '3 hours');
set local role hid_identity_api_runtime;
do $$ begin
  if pg_temp.try_invite(3, 503, 'twentieth@invite-people.invalid') <> 'created'
     or pg_temp.try_invite(3, 504, 'twenty-first@invite-people.invalid') <> 'STAFF_INVITATION_DAILY_LIMIT' then
    raise exception 'The first-30-days limit of 20 emails a day was not enforced at its boundary';
  end if;
end $$;
reset role;
-- c. Per recipient at one facility (facility 5), 30 days: 3 invitations, 8 emails.
select pg_temp.seed_invitations(5, 1200, 2, 'repeat-a@invite-people.invalid', clock_timestamp() - interval '3 days');
select pg_temp.seed_invitations(5, 1210, 3, 'repeat-b@invite-people.invalid', clock_timestamp() - interval '3 days');
select pg_temp.seed_invitations(5, 1220, 1, 'repeat-b-old@invite-people.invalid', clock_timestamp() - interval '31 days');
select pg_temp.seed_sends(5, 1230, 7, 'repeat-c@invite-people.invalid', clock_timestamp() - interval '4 days');
select pg_temp.seed_sends(5, 1240, 8, 'repeat-d@invite-people.invalid', clock_timestamp() - interval '4 days');
set local role hid_identity_api_runtime;
do $$ begin
  if pg_temp.try_invite(5, 505, 'repeat-a@invite-people.invalid') <> 'created'
     or pg_temp.try_invite(5, 506, 'repeat-b@invite-people.invalid') <> 'STAFF_INVITATION_RECIPIENT_LIMIT'
     or pg_temp.try_invite(5, 507, 'repeat-c@invite-people.invalid') <> 'created'
     or pg_temp.try_invite(5, 508, 'repeat-d@invite-people.invalid') <> 'STAFF_INVITATION_RECIPIENT_LIMIT' then
    raise exception 'The per-recipient limits were not enforced at their boundaries';
  end if;
end $$;
reset role;
-- d. The delivery pause (facility 6): 10 definitive failures in 24 hours.
select pg_temp.seed_sends(6, 1300, 9, 'bounce-#@invite-seeds.invalid', clock_timestamp() - interval '5 hours',
  'definitive_failure');
set local role hid_identity_api_runtime;
do $$ begin
  if pg_temp.try_invite(6, 509, 'before-pause@invite-people.invalid') <> 'created' then
    raise exception 'Nine definitive failures paused invitations';
  end if;
end $$;
reset role;
select pg_temp.seed_sends(6, 1310, 1, 'bounce-#@invite-seeds.invalid', clock_timestamp() - interval '5 hours',
  'definitive_failure');
set local role hid_identity_api_runtime;
do $$ begin
  if pg_temp.try_invite(6, 510, 'after-pause@invite-people.invalid') <> 'STAFF_INVITATION_DELIVERY_PAUSED' then
    raise exception 'Ten definitive failures did not pause invitations';
  end if;
end $$;
reset role;
-- e. The silent cap across facilities: 5 emails a day to one recipient.
-- Four were sent from facility 4 (seeded); facility 1's is the fifth and is
-- dispatched; facility 5's would be the sixth and is held back.
select pg_temp.seed_sends(4, 1400, 4, 'popular@invite-people.invalid', clock_timestamp() - interval '1 hour');
set local role hid_identity_api_runtime;
do $$ begin
  if pg_temp.try_invite(1, 511, 'popular@invite-people.invalid') <> 'created'
     or pg_temp.try_invite(5, 512, 'popular@invite-people.invalid') <> 'created, not dispatched' then
    raise exception 'The cross-facility cap was not applied silently at its boundary';
  end if;
  perform pg_temp.as_admin(5, 'invite-silent-list');
  if (select listed.delivery_outcome from identity.list_facility_staff_invitations() listed
       where listed.invitation_id = 'd2970000-0000-4000-8000-000000000512') <> 'unknown' then
    raise exception 'The facility does not see a held-back email as unknown';
  end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from identity.staff_invitation_sends where id = 'd2960000-0000-4000-8000-000000000512'
                  and not dispatched and outcome = 'suppressed' and outcome_at is not null)
     or not exists (select 1 from identity.staff_invitations where id = 'd2970000-0000-4000-8000-000000000512'
                     and delivery_outcome = 'unknown')
     or exists (select 1 from audit.events where resource_id = 'd2970000-0000-4000-8000-000000000512'
                 and details::text ~* 'dispatch|suppress') then
    raise exception 'The held-back send was not recorded silently';
  end if;
end $$;
-- f. Pending invitations per facility (facility 1): 100.
select pg_temp.seed_invitations(1, 1500, 99 - pg_temp.facility_count(1, 'pending'), 'pending-#@invite-seeds.invalid',
  clock_timestamp() - interval '2 days', 'pending');
set local role hid_identity_api_runtime;
do $$ begin
  if pg_temp.try_invite(1, 513, 'hundredth@invite-people.invalid') <> 'created'
     or pg_temp.try_invite(1, 514, 'hundred-first@invite-people.invalid') <> 'STAFF_INVITATION_PENDING_LIMIT' then
    raise exception 'The pending limit of 100 was not enforced at its boundary';
  end if;
end $$;
reset role;
update identity.staff_invitations set status = 'revoked', revoked_at = clock_timestamp(),
  revoked_by_account_id = invited_by_account_id, revoke_kind = 'facility'
 where idempotency_key like 'seeded-invitation-key-%' and status = 'pending';
-- g. After the first 30 days (facility 1): 30 invitations and 60 emails a day.
select pg_temp.seed_invitations(1, 1700, 29 - pg_temp.facility_count(1, 'invitations_day'),
  'normal-daily-#@invite-seeds.invalid', clock_timestamp() - interval '3 hours');
set local role hid_identity_api_runtime;
do $$ begin
  if pg_temp.try_invite(1, 515, 'thirtieth@invite-people.invalid') <> 'created'
     or pg_temp.try_invite(1, 516, 'thirty-first@invite-people.invalid') <> 'STAFF_INVITATION_DAILY_LIMIT' then
    raise exception 'The normal limit of 30 invitations a day was not enforced at its boundary';
  end if;
end $$;
reset role;
-- Emails a day after the first 30 days (60), through resends, which the
-- daily invitation count does not limit.
select pg_temp.seed_sends(1, 1800, 59 - pg_temp.facility_count(1, 'emails_day'), 'normal-mail-#@invite-seeds.invalid',
  clock_timestamp() - interval '3 hours');
update identity.staff_invitations set last_sent_at = clock_timestamp() - interval '2 minutes'
 where id = 'd2970000-0000-4000-8000-000000000404';
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'invite-email-limit');
select * from identity.resend_staff_invitation('d2970000-0000-4000-8000-000000000404', 1,
  'd2960000-0000-4000-8000-000000000441', encode(sha256('limit-link-441'::bytea), 'hex'),
  encode(sha256('limit-code-441'::bytea), 'hex'), 'v1');
reset role;
update identity.staff_invitations set last_sent_at = clock_timestamp() - interval '2 minutes'
 where id = 'd2970000-0000-4000-8000-000000000404';
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'invite-email-limit-2');
do $$ begin
  perform identity.resend_staff_invitation('d2970000-0000-4000-8000-000000000404', 2,
    'd2960000-0000-4000-8000-000000000442', encode(sha256('limit-link-442'::bytea), 'hex'),
    encode(sha256('limit-code-442'::bytea), 'hex'), 'v1');
  raise exception 'The 61st email of the day was accepted';
exception when raise_exception then
  if sqlerrm <> 'STAFF_INVITATION_DAILY_LIMIT' then raise; end if;
end $$;
reset role;

-- 6. Resend and revoke (facility 5's first-30-days limits are full for some
-- recipients; facility 1's daily invitations are full, so these use invitations
-- created earlier).
set local role hid_identity_api_runtime;
select pg_temp.as_admin(5, 'invite-resend');
do $$
declare
  original record;
  result record;
begin
  select * into original from pg_temp.invite(601, 'Resend Person', 'resend@invite-people.invalid', 'nurse', 'NMCN', 'RN/601')
    as created(invitation_id uuid, row_version bigint, send_id uuid, expires_at timestamptz, replayed boolean,
      dispatch boolean, facility_name text, role_code text, invitee_email text);
  begin
    perform identity.resend_staff_invitation(original.invitation_id, original.row_version,
      'd2960000-0000-4000-8000-000000000611', encode(sha256('resend-link-611'::bytea), 'hex'),
      encode(sha256('resend-code-611'::bytea), 'hex'), 'v2');
    raise exception 'A resend within the cooldown was accepted';
  exception when raise_exception then
    if sqlerrm <> 'STAFF_INVITATION_RESEND_TOO_SOON' then raise; end if;
  end;
  perform set_config('hid.test.resend_version', original.row_version::text, true);
  perform set_config('hid.test.resend_expires', original.expires_at::text, true);
end $$;
reset role;
update identity.staff_invitations
   set last_sent_at = clock_timestamp() - interval '2 minutes', failed_link_attempts = 3, failed_typed_attempts = 4,
       session_hmac = encode(sha256('resend-open-session'::bytea), 'hex'), session_expires_at = clock_timestamp() + interval '1 hour',
       session_account_case = 'new', accept_attempts = 2
 where id = 'd2970000-0000-4000-8000-000000000601';
set local role hid_identity_api_runtime;
select pg_temp.as_admin(5, 'invite-resend-2');
do $$
declare result record; attempt record;
begin
  for attempt in select * from (values
      (1, 5, 'd2970000-0000-4000-8000-000000000601'::uuid, current_setting('hid.test.resend_version')::bigint - 1, '40001'),
      (2, 2, 'd2970000-0000-4000-8000-000000000601'::uuid, current_setting('hid.test.resend_version')::bigint, 'P0002'),
      (3, 5, 'd2970000-0000-4000-8000-0000000006ff'::uuid, 1::bigint, 'P0002')
    ) as rows(n, facility, target, version, expected) order by n loop
    perform pg_temp.as_admin(attempt.facility, 'invite-resend-refusal-' || attempt.n);
    begin
      perform identity.resend_staff_invitation(attempt.target, attempt.version,
        'd2960000-0000-4000-8000-000000000612', encode(sha256('resend-link-612'::bytea), 'hex'),
        encode(sha256('resend-code-612'::bytea), 'hex'), 'v2');
      raise exception 'Resend refusal % was accepted', attempt.n;
    exception when others then
      if sqlstate <> attempt.expected then
        raise exception 'Resend refusal % raised % (%) instead of %', attempt.n, sqlstate, sqlerrm, attempt.expected;
      end if;
    end;
  end loop;
  perform pg_temp.as_admin(5, 'invite-resend-3');
  select * into result from identity.resend_staff_invitation('d2970000-0000-4000-8000-000000000601',
    current_setting('hid.test.resend_version')::bigint, 'd2960000-0000-4000-8000-000000000613',
    encode(sha256('resend-link-613'::bytea), 'hex'), encode(sha256('resend-code-613'::bytea), 'hex'), 'v2');
  if result.row_version <> current_setting('hid.test.resend_version')::bigint + 1
     or result.expires_at <= current_setting('hid.test.resend_expires')::timestamptz
     or result.send_id <> 'd2960000-0000-4000-8000-000000000613' or not result.dispatch
     or result.invitee_email <> 'resend@invite-people.invalid' or result.role_code <> 'nurse' then
    raise exception 'The resend answered %', row_to_json(result);
  end if;
  -- The first send's outcome arrives late: it is recorded on the send only.
  perform identity.record_staff_invitation_delivery('d2960000-0000-4000-8000-000000000601', 'definitive_failure');
  perform identity.record_staff_invitation_delivery('d2960000-0000-4000-8000-000000000613', 'accepted');
  -- A stale outcome for a send no longer pending changes nothing.
  perform identity.record_staff_invitation_delivery('d2960000-0000-4000-8000-000000000613', 'unknown');
  begin
    perform identity.record_staff_invitation_delivery('d2960000-0000-4000-8000-000000000613', 'bounced');
    raise exception 'An unknown delivery outcome was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.record_staff_invitation_delivery('d2960000-0000-4000-8000-0000000006ff', 'accepted');
    raise exception 'An unknown send was recorded';
  exception when no_data_found then null;
  end;
  perform pg_temp.as_admin(2, 'invite-delivery-other');
  begin
    perform identity.record_staff_invitation_delivery('d2960000-0000-4000-8000-000000000613', 'accepted');
    raise exception 'Another facility''s send was recorded';
  exception when no_data_found then null;
  end;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from identity.staff_invitations where id = 'd2970000-0000-4000-8000-000000000601'
                  and link_token_hmac = encode(sha256('resend-link-613'::bytea), 'hex')
                  and email_code_hmac = encode(sha256('resend-code-613'::bytea), 'hex') and key_version = 'v2'
                  and failed_link_attempts = 3 and failed_typed_attempts = 0 and session_hmac is null
                  and session_account_case is null and accept_attempts = 0 and send_count = 2
                  and last_send_id = 'd2960000-0000-4000-8000-000000000613' and delivery_outcome = 'accepted')
     or (select outcome from identity.staff_invitation_sends where id = 'd2960000-0000-4000-8000-000000000601')
        <> 'definitive_failure'
     or (select outcome from identity.staff_invitation_sends where id = 'd2960000-0000-4000-8000-000000000613') <> 'accepted'
     or not exists (select 1 from identity.staff_invitation_sends where id = 'd2960000-0000-4000-8000-000000000613'
                     and kind = 'resend' and dispatched) then
    raise exception 'The resend or its delivery record left the wrong state';
  end if;
end $$;
-- The send cap (5 sends), an expired invitation resent, and a newer pending
-- invitation for the email.
update identity.staff_invitations set last_sent_at = clock_timestamp() - interval '2 minutes', send_count = 5
 where id = 'd2970000-0000-4000-8000-000000000601';
set local role hid_identity_api_runtime;
select pg_temp.as_admin(5, 'invite-resend-cap');
do $$ begin
  perform identity.resend_staff_invitation('d2970000-0000-4000-8000-000000000601',
    (select listed.row_version from identity.list_facility_staff_invitations() listed
      where listed.invitation_id = 'd2970000-0000-4000-8000-000000000601'),
    'd2960000-0000-4000-8000-000000000614', encode(sha256('resend-link-614'::bytea), 'hex'),
    encode(sha256('resend-code-614'::bytea), 'hex'), 'v2');
  raise exception 'A sixth send was accepted';
exception when raise_exception then
  if sqlerrm <> 'STAFF_INVITATION_SEND_LIMIT' then raise; end if;
end $$;
select pg_temp.invite(602, 'Expired Person', 'expired@invite-people.invalid', 'receptionist', null, null);
reset role;
update identity.staff_invitations set status = 'expired', expired_at = clock_timestamp(),
  last_sent_at = clock_timestamp() - interval '8 days', expires_at = clock_timestamp() - interval '1 day'
 where id = 'd2970000-0000-4000-8000-000000000602';
set local role hid_identity_api_runtime;
select pg_temp.as_admin(5, 'invite-resend-expired');
do $$
declare result record;
begin
  select * into result from identity.resend_staff_invitation('d2970000-0000-4000-8000-000000000602', 1,
    'd2960000-0000-4000-8000-000000000615', encode(sha256('resend-link-615'::bytea), 'hex'),
    encode(sha256('resend-code-615'::bytea), 'hex'), 'v1');
  if result.expires_at < clock_timestamp() + interval '6 days' then
    raise exception 'An expired invitation was not renewed: %', row_to_json(result);
  end if;
end $$;
reset role;
update identity.staff_invitations set status = 'expired', expired_at = clock_timestamp(),
  last_sent_at = clock_timestamp() - interval '8 days', expires_at = clock_timestamp() - interval '1 day'
 where id = 'd2970000-0000-4000-8000-000000000602';
set local role hid_identity_api_runtime;
select pg_temp.as_admin(5, 'invite-resend-newer');
select pg_temp.invite(603, 'Expired Person', 'expired@invite-people.invalid', 'receptionist', null, null);
do $$ begin
  perform identity.resend_staff_invitation('d2970000-0000-4000-8000-000000000602', 2,
    'd2960000-0000-4000-8000-000000000616', encode(sha256('resend-link-616'::bytea), 'hex'),
    encode(sha256('resend-code-616'::bytea), 'hex'), 'v1');
  raise exception 'An older invitation was resent beside a newer pending one';
exception when raise_exception then
  if sqlerrm <> 'STAFF_INVITATION_ALREADY_PENDING' then raise; end if;
end $$;
-- Revoke: the pending one, then again (not pending), the wrong version, and
-- another facility's.
do $$
declare result record;
begin
  begin
    perform identity.revoke_staff_invitation('d2970000-0000-4000-8000-000000000603', 7);
    raise exception 'A revoke at a stale version was accepted';
  exception when serialization_failure then null;
  end;
  perform pg_temp.as_admin(2, 'invite-revoke-other');
  begin
    perform identity.revoke_staff_invitation('d2970000-0000-4000-8000-000000000603', 1);
    raise exception 'Another facility''s invitation was revoked';
  exception when no_data_found then
    if sqlerrm <> 'STAFF_INVITATION_NOT_FOUND' then raise; end if;
  end;
  perform pg_temp.as_admin(5, 'invite-revoke');
  select * into result from identity.revoke_staff_invitation('d2970000-0000-4000-8000-000000000603', 1);
  if result.row_version <> 2 or result.revoked_at is null then
    raise exception 'The revoke answered %', row_to_json(result);
  end if;
  begin
    perform identity.revoke_staff_invitation('d2970000-0000-4000-8000-000000000603', 2);
    raise exception 'A revoked invitation was revoked again';
  exception when raise_exception then
    if sqlerrm <> 'STAFF_INVITATION_NOT_PENDING' then raise; end if;
  end;
  begin
    perform identity.resend_staff_invitation('d2970000-0000-4000-8000-000000000603', 2,
      'd2960000-0000-4000-8000-000000000617', encode(sha256('resend-link-617'::bytea), 'hex'),
      encode(sha256('resend-code-617'::bytea), 'hex'), 'v1');
    raise exception 'A revoked invitation was resent';
  exception when raise_exception then
    if sqlerrm <> 'STAFF_INVITATION_NOT_PENDING' then raise; end if;
  end;
  -- An expired invitation can be revoked.
  select * into result from identity.revoke_staff_invitation('d2970000-0000-4000-8000-000000000602', 2);
end $$;
reset role;
do $$ begin
  if not exists (select 1 from identity.staff_invitations where id = 'd2970000-0000-4000-8000-000000000603'
                  and status = 'revoked' and revoke_kind = 'facility'
                  and revoked_by_account_id = current_setting('hid.test.i_account_5')::uuid)
     or not exists (select 1 from identity.staff_invitations where id = 'd2970000-0000-4000-8000-000000000602'
                     and status = 'revoked' and expired_at is null) then
    raise exception 'The revokes left the wrong state';
  end if;
end $$;

-- 7. Immutable columns, no deletes, the send's outcome-only update, and the
-- append-only attestation texts.
do $$
declare attempt integer;
begin
  for attempt in 1..6 loop
    begin
      case attempt
        when 1 then update identity.staff_invitations set invitee_email = 'changed@invite-people.invalid'
                     where id = 'd2970000-0000-4000-8000-000000000601';
        when 2 then update identity.staff_invitations set licence_number = 'RN 999'
                     where id = 'd2970000-0000-4000-8000-000000000601';
        when 3 then update identity.staff_invitations set attested_at = clock_timestamp()
                     where id = 'd2970000-0000-4000-8000-000000000601';
        when 4 then delete from identity.staff_invitations where id = 'd2970000-0000-4000-8000-000000000601';
        when 5 then update identity.staff_invitations set role_code = 'doctor', licence_body = 'MDCN'
                     where id = 'd2970000-0000-4000-8000-000000000601';
        else update identity.staff_invitations set invited_by_account_id = 'd2000000-0000-4000-8000-000000000001'
              where id = 'd2970000-0000-4000-8000-000000000601';
      end case;
      raise exception 'Immutable case % was admitted', attempt;
    exception when object_not_in_prerequisite_state then
      if sqlerrm <> 'STAFF_INVITATION_IMMUTABLE' then raise; end if;
    end;
  end loop;
  for attempt in 1..4 loop
    begin
      case attempt
        when 1 then update identity.staff_invitation_sends set link_token_hmac = repeat('0', 64)
                     where id = 'd2960000-0000-4000-8000-000000000613';
        when 2 then update identity.staff_invitation_sends set outcome = 'unknown', outcome_at = clock_timestamp()
                     where id = 'd2960000-0000-4000-8000-000000000613';
        when 3 then delete from identity.staff_invitation_sends where id = 'd2960000-0000-4000-8000-000000000613';
        else update identity.staff_invitation_sends set outcome = 'accepted', outcome_at = null
              where id = 'd2960000-0000-4000-8000-000000000511';
      end case;
      raise exception 'Send case % was admitted', attempt;
    exception when object_not_in_prerequisite_state then
      if sqlerrm <> 'STAFF_INVITATION_SEND_IMMUTABLE' then raise; end if;
    end;
  end loop;
  begin
    update identity.staff_attestation_texts set text = text || ' Changed.' where version = 'facility-staff-attestation-v1';
    raise exception 'An attestation text changed';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;

-- 8. Audit: staff rows at the facility, ids and codes only.
do $$ begin
  if (select count(*) from audit.events where action = 'identity.staff-invitation.create'
       and resource_id = 'd2970000-0000-4000-8000-000000000301' and actor_type = 'staff'
       and facility_id = current_setting('hid.test.i_facility_1')::uuid
       and actor_membership_id = current_setting('hid.test.i_membership_1')::uuid
       and details = jsonb_build_object('invitationId', 'd2970000-0000-4000-8000-000000000301',
         'roleCode', 'doctor', 'licenceBody', 'MDCN')) <> 1
     or (select count(*) from audit.events where action = 'identity.staff-invitation.resend'
          and resource_id = 'd2970000-0000-4000-8000-000000000601') <> 1
     or (select count(*) from audit.events where action = 'identity.staff-invitation.delivery'
          and resource_id = 'd2970000-0000-4000-8000-000000000601') <> 2
     or (select count(*) from audit.events where action = 'identity.staff-invitation.revoke') <> 2
     or exists (select 1 from audit.events where action like 'identity.staff-invitation.%'
                 and (details::text ~* 'invite-people|invite-seeds|Person|12/345|RN/60|Adébáyọ̀'
                   or coalesce(reason, '') ~* 'invite-people|Person')) then
    raise exception 'The invitation audit rows are wrong';
  end if;
end $$;

rollback;
