\set ON_ERROR_STOP on
-- SX-4 (0139): adding or removing one role for a staff member. Rollback-
-- only. Every command runs as the exact Identity API runtime role in the
-- context Identity's withTransaction (staff) or withPlatformTransaction
-- (support) sets.
--
--   1. the administrator's add: the grant and its attestation, the audit row
--      without a licence number, the stored replay, a reused key, an added
--      role already held, a stale version, the licence, reason and key
--      rules, the roles by facility type, today's member refusals, before
--      review;
--   2. the administrator's remove: one role revoked, the others untouched,
--      a retry answers not held, the last role, the role columns moved to a
--      held role, a remove refused when no role left can take
--      membership_role, the open records-processing request closed with its
--      audit row while a direct-care request and a member who keeps
--      ocr.job.write keep theirs, the own-facility and break-glass grants
--      revoked with their audit rows when no role left allows them (an
--      expired one and the patient's own grant untouched), and kept when a
--      role left still allows them;
--   3. the reads: one licence per licensed active role, hints only, the
--      facility's own members only;
--   4. support: permission, a governed facility (no recorded kind is a
--      hospital), a laboratory's roles, the licence check and its method,
--      the administrator's membership (refused at a self-signed-up facility,
--      allowed at a governed one, where a remove revokes its own-facility
--      grant as the system actor), a facility under review, replay and
--      reuse, remove with replay, its read;
--   5. the staff-invitations control closes add, not remove; the helpers
--      are not the runtime's.
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
  ('e1390000-0000-4000-8000-000000000001', 'synthetic:roles:super', 'super@roles.invalid', 'Roles Super Admin', 'active'),
  ('e1390000-0000-4000-8000-000000000002', 'synthetic:roles:support', 'support@roles.invalid', 'Roles Support Admin', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('e1391000-0000-4000-8000-000000000001', 'e1390000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
   'Staff roles suite super admin'),
  ('e1391000-0000-4000-8000-000000000002', 'e1390000-0000-4000-8000-000000000002', 'support_admin', 'platform',
   'Staff roles suite support admin');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, status)
select ('e1396000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'HID-CADE' || translate(lpad(n::text, 4, '0'), '0123456789', 'ABCDEFGHJK'), 'Roles', 'Patient', 'Roles Patient',
  date '1980-01-01', 'active'
  from generate_series(1, 3) n;

-- Sign-ups: 1 hospital (reviewed), 2 laboratory (reviewed), 3 hospital (pending).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:roles:super', true),
  set_config('app.correlation_id', 'roles-open-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'Staff roles suite opens facility sign-up');
select platform.admin_set_control('staff_invitations_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Staff roles suite opens staff invitations');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'roles-signup-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  signup record;
  application_id uuid;
  current_application record;
  activated record;
begin
  for signup in select * from (values
      (1, 'ehr', 'hospital', 'RC9941390001', 'Ada Roles Admin', 'ada@roles-hospital.invalid', 'Ada Roles Hospital Ltd'),
      (2, 'laboratory', 'laboratory', 'RC9941390002', 'Bola Roles Admin', 'bola@roles-lab.invalid', 'Bola Roles Laboratory Ltd'),
      (3, 'ehr', 'hospital', 'RC9941390003', 'Chidi Roles Admin', 'chidi@roles-pending.invalid', 'Chidi Roles Hospital Ltd')
    ) as rows(n, product, kind, cac, admin_name, admin_email, legal_name) order by n loop
    application_id := identity.submit_self_service_organization_application(signup.product, signup.kind,
      signup.cac, signup.admin_name, signup.admin_email);
    select * into current_application from identity.public_get_organization_application(
      signup.cac, signup.admin_email, signup.product);
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', '9941' || signup.n, signup.cac, signup.legal_name, 'Private Company Limited by Shares',
      '2018-08-0' || signup.n, signup.n || ' Roles Suite Road, Lagos', 'active');
    perform identity.begin_self_service_provider_enrollment(signup.cac, signup.admin_email, signup.product,
      ('e1399000-0000-4000-8000-00000000000' || signup.n)::uuid,
      encode(sha256(('roles-otp-' || signup.n)::bytea), 'hex'), signup.admin_name, signup.kind);
    perform identity.verify_organization_profile_completion_challenge(
      ('e1399000-0000-4000-8000-00000000000' || signup.n)::uuid, encode(sha256(('roles-otp-' || signup.n)::bytea), 'hex'),
      encode(sha256(('roles-session-' || signup.n)::bytea), 'hex'));
    select * into activated from identity.activate_self_service_provider_enrollment(
      encode(sha256(('roles-session-' || signup.n)::bytea), 'hex'),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    perform set_config('hid.test.r_app_' || signup.n, application_id::text, true);
    perform set_config('hid.test.r_facility_' || signup.n, activated.facility_id::text, true);
    perform set_config('hid.test.r_account_' || signup.n, activated.account_id::text, true);
    perform set_config('hid.test.r_org_' || signup.n, activated.organization_id::text, true);
  end loop;
end $$;
-- Support reviews facilities 1 (the administrator keeps doctor) and 2.
select set_config('app.actor_subject', 'synthetic:roles:super', true),
  set_config('app.correlation_id', 'roles-review-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare n integer; listed record;
begin
  foreach n in array array[1, 2] loop
    select * into listed from identity.admin_list_self_service_facilities('unreviewed') item
     where item.application_id = current_setting('hid.test.r_app_' || n)::uuid;
    perform identity.admin_review_self_service_facility(listed.application_id, listed.row_version,
      'Checked the company and its administrator', case n when 1 then 'doctor' else 'none' end,
      'regulator_register', case n when 1 then 'MDCN' end, case n when 1 then 'MDCN/1390' end);
  end loop;
end $$;
reset role;
select set_config('hid.test.r_membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.r_account_' || n)::uuid), true)
  from generate_series(1, 3) n;

-- A governed hospital (no sign-up, no recorded kind).
insert into identity.organizations (id, name, slug) values
  ('e1393000-0000-4000-8000-000000000009', 'Roles Governed Hospital Group', 'roles-governed-hospital-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1393000-0000-4000-8000-000000000010', 'e1393000-0000-4000-8000-000000000009', 'Roles Governed Hospital',
   'ROLES-G', 'Africa/Lagos', true, 'verified');

-- Members (owner SQL). Facility 1: m1 nurse (a pending healthcare-operations
-- request and a pending direct-care request), m2 doctor, m3 receptionist
-- holding a platform role, m4 pharmacist with an ended lab membership at the
-- same facility (m14), m6 doctor and nurse (a pending healthcare-operations
-- request), m8 doctor and pharmacist. Facility 2: m5 lab. Governed hospital:
-- m7 doctor, m9 the administrator (org_admin and doctor).
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1390000-0000-4000-8000-00000000001' || n)::uuid, 'synthetic:roles:member-' || n,
  'member' || n || '@roles-people.invalid', 'Roles Member ' || n, 'active'
  from generate_series(1, 9) n;
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('e1391000-0000-4000-8000-000000000013', 'e1390000-0000-4000-8000-000000000013', 'support_admin', 'platform',
   'Staff roles suite platform member');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1394000-0000-4000-8000-00000000001' || n)::uuid, ('e1390000-0000-4000-8000-00000000001' || n)::uuid,
  'Roles Member ' || n, 'member' || n || '@roles-people.invalid', 'verified',
  (array['nurse', 'doctor', 'receptionist', 'pharmacist', 'lab', 'doctor', 'doctor', 'doctor', 'doctor'])[n]
  from generate_series(1, 9) n;
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
select ('e1395000-0000-4000-8000-0000000000' || lpad(member.n::text, 2, '0'))::uuid,
  ('e1394000-0000-4000-8000-00000000001' || member.staff_n)::uuid,
  ('e1390000-0000-4000-8000-00000000001' || member.staff_n)::uuid,
  case member.facility when 'f1' then current_setting('hid.test.r_org_1')::uuid
    when 'f2' then current_setting('hid.test.r_org_2')::uuid else 'e1393000-0000-4000-8000-000000000009'::uuid end,
  case member.facility when 'f1' then current_setting('hid.test.r_facility_1')::uuid
    when 'f2' then current_setting('hid.test.r_facility_2')::uuid else 'e1393000-0000-4000-8000-000000000010'::uuid end,
  member.role_code, member.role_code, member.n < 10, member.n < 10
  from (values (1, 1, 'f1', 'nurse'), (2, 2, 'f1', 'doctor'), (3, 3, 'f1', 'receptionist'),
               (4, 4, 'f1', 'pharmacist'), (14, 4, 'f1', 'lab'), (5, 5, 'f2', 'lab'),
               (6, 6, 'f1', 'doctor'), (7, 7, 'g', 'doctor'), (8, 8, 'f1', 'doctor'),
               (9, 9, 'g', 'org_admin')) as member(n, staff_n, facility, role_code);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e1392000-0000-4000-8000-0000000000' || lpad(grant_row.n::text, 2, '0'))::uuid, membership.account_id,
  grant_row.role_code, 'facility', membership.id, membership.facility_id, 'Staff roles suite member'
  from (values (1, 1, 'nurse'), (2, 2, 'doctor'), (3, 3, 'receptionist'), (4, 4, 'pharmacist'), (5, 5, 'lab'),
               (6, 6, 'doctor'), (16, 6, 'nurse'), (7, 7, 'doctor'), (8, 8, 'doctor'), (18, 8, 'pharmacist'),
               (9, 9, 'org_admin'), (19, 9, 'doctor')) as grant_row(n, member_n, role_code)
  join identity.staff_facility_memberships membership
    on membership.id = ('e1395000-0000-4000-8000-0000000000' || lpad(grant_row.member_n::text, 2, '0'))::uuid;
-- 0104's trigger admits a records-processing request only from its own
-- member holding ocr.job.write, so each is made in that member's context.
create function pg_temp.request(request_id uuid, patient_id uuid, member_n integer, purpose text) returns void
language sql as $f$
  select set_config('app.actor_subject', 'synthetic:roles:member-' || member_n, true);
  insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, reason, status,
    requested_duration_minutes, purpose_of_use)
  select request_id, patient_id, membership.staff_id, membership.id, membership.facility_id, 'read_records',
    'Staff roles suite request', 'pending', 60, purpose
    from identity.staff_facility_memberships membership
   where membership.id = ('e1395000-0000-4000-8000-0000000000' || lpad(member_n::text, 2, '0'))::uuid;
  select set_config('app.actor_subject', '', true);
$f$;
select pg_temp.request('e1397000-0000-4000-8000-000000000001', 'e1396000-0000-4000-8000-000000000001', 1,
  'healthcare-operations');
select pg_temp.request('e1397000-0000-4000-8000-000000000002', 'e1396000-0000-4000-8000-000000000002', 1,
  'direct-care');
select pg_temp.request('e1397000-0000-4000-8000-000000000003', 'e1396000-0000-4000-8000-000000000003', 6,
  'healthcare-operations');
-- Consent grants (owner SQL). m8: g1 own-facility (patient 1), g2
-- break-glass (patient 2), g3 an own-facility grant already past its expiry
-- (patient 3), g4 the patient's own approval (patient 3). m6: g5
-- own-facility (patient 1), g6 break-glass (patient 3). m9: g7 own-facility
-- (patient 1).
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use, authorization_method, granted_by_patient_id)
select ('e1398000-0000-4000-8000-00000000000' || grant_row.n)::uuid,
  ('e1396000-0000-4000-8000-00000000000' || grant_row.patient_n)::uuid, membership.staff_id, membership.account_id,
  membership.id, membership.facility_id, grant_row.scope, 'active', grant_row.reason,
  clock_timestamp() - make_interval(hours => grant_row.started_hours_ago),
  clock_timestamp() + make_interval(hours => grant_row.expires_in_hours), grant_row.scope = 'break_glass',
  grant_row.purpose, grant_row.method,
  case when grant_row.method is null and grant_row.scope <> 'break_glass'
    then ('e1396000-0000-4000-8000-00000000000' || grant_row.patient_n)::uuid end
  from (values
    (1, 8, 1, 'write_records', 'direct-care', 'own_facility', 'Opened as this facility''s patient', 1, 23),
    (2, 8, 2, 'break_glass', 'emergency', null, 'Unconscious on arrival, staff roles suite', 1, 1),
    (3, 8, 3, 'write_records', 'direct-care', 'own_facility', 'Opened as this facility''s patient', 48, -24),
    (4, 8, 3, 'read_records', 'direct-care', null, 'Approved by the patient', 1, 23),
    (5, 6, 1, 'write_records', 'direct-care', 'own_facility', 'Opened as this facility''s patient', 1, 23),
    (6, 6, 3, 'break_glass', 'emergency', null, 'Unconscious on arrival, staff roles suite', 1, 1),
    (7, 9, 1, 'write_records', 'direct-care', 'own_facility', 'Opened as this facility''s patient', 1, 23)
  ) as grant_row(n, member_n, patient_n, scope, purpose, method, reason, started_hours_ago, expires_in_hours)
  join identity.staff_facility_memberships membership
    on membership.id = ('e1395000-0000-4000-8000-0000000000' || lpad(grant_row.member_n::text, 2, '0'))::uuid;
create function pg_temp.grant_id(n integer) returns uuid language sql as $f$
  select ('e1398000-0000-4000-8000-00000000000' || n)::uuid;
$f$;
-- 0005's check, as the member's own session would make it (owner only).
create function pg_temp.allowed(patient_n integer, member_n integer, purpose text) returns boolean language sql as $f$
  select identity.has_active_consent_grant(('e1396000-0000-4000-8000-00000000000' || patient_n)::uuid,
    'synthetic:roles:member-' || member_n, membership.id, membership.facility_id, 'read_records', purpose)
    from identity.staff_facility_memberships membership
   where membership.id = ('e1395000-0000-4000-8000-0000000000' || lpad(member_n::text, 2, '0'))::uuid;
$f$;
do $$
begin
  if not (pg_temp.allowed(1, 8, 'direct-care') and pg_temp.allowed(2, 8, 'emergency')
          and pg_temp.allowed(3, 8, 'direct-care') and pg_temp.allowed(1, 6, 'direct-care')
          and pg_temp.allowed(3, 6, 'emergency') and pg_temp.allowed(1, 9, 'direct-care')) then
    raise exception '0a: a grant fixture does not admit its member';
  end if;
end $$;

create function pg_temp.as_staff(target_subject text, target_membership text, target_facility text, correlation text)
returns void language sql as $f$
  select set_config('app.actor_subject', target_subject, true), set_config('app.membership_id', target_membership, true),
    set_config('app.facility_id', target_facility, true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$f$;
create function pg_temp.as_admin(n integer, correlation text) returns void language sql as $f$
  select pg_temp.as_staff('org-onboarding:' || current_setting('hid.test.r_account_' || n),
    current_setting('hid.test.r_membership_' || n), current_setting('hid.test.r_facility_' || n), correlation);
$f$;
create function pg_temp.as_platform(target_subject text, correlation text) returns void language sql as $f$
  select pg_temp.as_staff(target_subject, '', '', correlation);
$f$;
create function pg_temp.member(n integer) returns uuid language sql as $f$
  select ('e1395000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid;
$f$;
create function pg_temp.version(n integer) returns bigint language sql as $f$
  select membership.row_version from identity.staff_facility_memberships membership where membership.id = pg_temp.member(n);
$f$;
create function pg_temp.key(label text) returns text language sql as $f$ select 'roles-suite-key-' || label; $f$;
create function pg_temp.sha(label text) returns char(64) language sql as $f$
  select encode(sha256(('roles-request-' || label)::bytea), 'hex')::char(64);
$f$;
-- Runs a command and returns its SQLSTATE and message, or 'ok'.
create function pg_temp.refusal(command text) returns text language plpgsql as $f$
begin
  execute command;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
grant execute on function pg_temp.as_staff(text,text,text,text), pg_temp.as_admin(integer,text),
  pg_temp.as_platform(text,text), pg_temp.member(integer), pg_temp.version(integer), pg_temp.key(text),
  pg_temp.sha(text), pg_temp.refusal(text), pg_temp.grant_id(integer) to hid_identity_api_runtime;

-- 1. The administrator's add.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'roles-add-0001');
do $$
declare
  before_version bigint := pg_temp.version(2);
  added record;
  replay record;
begin
  select * into added from identity.add_facility_staff_role(pg_temp.member(2), before_version, 'nurse', 'NMCN',
    ' rn/ 2002 ', 'facility-staff-attestation-v1', '  Also covers night triage  ', pg_temp.key('m2-nurse'),
    pg_temp.sha('m2-nurse'));
  if added.membership_id <> pg_temp.member(2) or added.row_version <> before_version + 1
     or added.roles <> array['doctor', 'nurse'] or added.replayed then
    raise exception '1a: the add answered %', row_to_json(added);
  end if;
  select * into replay from identity.add_facility_staff_role(pg_temp.member(2), before_version, 'nurse', 'NMCN',
    ' rn/ 2002 ', 'facility-staff-attestation-v1', '  Also covers night triage  ', pg_temp.key('m2-nurse'),
    pg_temp.sha('m2-nurse'));
  if replay.membership_id <> pg_temp.member(2) or replay.row_version <> before_version + 1
     or replay.roles <> array['doctor', 'nurse'] or not replay.replayed then
    raise exception '1b: the replay answered %', row_to_json(replay);
  end if;
end $$;
select pg_temp.as_admin(1, 'roles-add-0002');
do $$
declare
  attempt record;
  outcome text;
begin
  for attempt in select * from (values
    ('1c reused key', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      pg_temp.member(2), pg_temp.version(2), 'nurse', 'NMCN', 'RN/2002', 'facility-staff-attestation-v1',
      'Also covers night triage', pg_temp.key('m2-nurse'), pg_temp.sha('m2-nurse-other')), '23505 IDEMPOTENCY_KEY_REUSED'),
    ('1d already held', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      pg_temp.member(2), pg_temp.version(2), 'nurse', 'NMCN', 'RN/2002', 'facility-staff-attestation-v1',
      'Also covers night triage', pg_temp.key('m2-nurse-again'), pg_temp.sha('m2-nurse-again')),
      'P0001 FACILITY_STAFF_ROLE_ALREADY_HELD'),
    ('1e stale version', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      pg_temp.member(2), pg_temp.version(2) - 1, 'lab', 'MLSCN', 'ML 2002', 'facility-staff-attestation-v1',
      'Also runs the bench', pg_temp.key('m2-lab'), pg_temp.sha('m2-lab')), '40001 Facility staff membership version conflict'),
    ('1f licence of another role', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      pg_temp.member(2), pg_temp.version(2), 'lab', 'MDCN', 'ML 2002', 'facility-staff-attestation-v1',
      'Also runs the bench', pg_temp.key('m2-lab'), pg_temp.sha('m2-lab')), '22023 STAFF_INVITATION_INVALID'),
    ('1g front desk with a licence', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      pg_temp.member(2), pg_temp.version(2), 'receptionist', 'MDCN', 'MDCN/1', 'facility-staff-attestation-v1',
      'Also covers the desk', pg_temp.key('m2-desk'), pg_temp.sha('m2-desk')), '22023 STAFF_INVITATION_INVALID'),
    ('1h no licence number', format('select identity.add_facility_staff_role(%L, %s, %L, %L, null, %L, %L, %L, %L)',
      pg_temp.member(2), pg_temp.version(2), 'lab', 'MLSCN', 'facility-staff-attestation-v1',
      'Also runs the bench', pg_temp.key('m2-lab'), pg_temp.sha('m2-lab')), '22023 STAFF_INVITATION_INVALID'),
    ('1i an administrator role', format('select identity.add_facility_staff_role(%L, %s, %L, null, null, %L, %L, %L, %L)',
      pg_temp.member(2), pg_temp.version(2), 'org_admin', 'facility-staff-attestation-v1',
      'Make them an administrator', pg_temp.key('m2-admin'), pg_temp.sha('m2-admin')), '22023 STAFF_INVITATION_INVALID'),
    ('1j short reason', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      pg_temp.member(2), pg_temp.version(2), 'lab', 'MLSCN', 'ML 2002', 'facility-staff-attestation-v1',
      'bench', pg_temp.key('m2-lab'), pg_temp.sha('m2-lab')), '22023 FACILITY_STAFF_REASON_INVALID'),
    ('1k short key', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      pg_temp.member(2), pg_temp.version(2), 'lab', 'MLSCN', 'ML 2002', 'facility-staff-attestation-v1',
      'Also runs the bench', 'short-key', pg_temp.sha('m2-lab')), '22023 IDEMPOTENCY_KEY_REQUIRED'),
    ('1l own membership', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      current_setting('hid.test.r_membership_1'), 1, 'nurse', 'NMCN', 'RN 1', 'facility-staff-attestation-v1',
      'Also covers night triage', pg_temp.key('self'), pg_temp.sha('self')), 'P0001 FACILITY_STAFF_SELF'),
    ('1m platform account', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      pg_temp.member(3), pg_temp.version(3), 'nurse', 'NMCN', 'RN 3', 'facility-staff-attestation-v1',
      'Also covers night triage', pg_temp.key('m3'), pg_temp.sha('m3')), 'P0001 FACILITY_STAFF_PLATFORM_ACCOUNT'),
    ('1n ended membership', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      pg_temp.member(14), 1, 'nurse', 'NMCN', 'RN 14', 'facility-staff-attestation-v1',
      'Also covers night triage', pg_temp.key('m14'), pg_temp.sha('m14')), 'P0001 FACILITY_STAFF_ALREADY_ENDED'),
    ('1o another facility''s member', format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
      pg_temp.member(5), 1, 'nurse', 'NMCN', 'RN 5', 'facility-staff-attestation-v1',
      'Also covers night triage', pg_temp.key('m5'), pg_temp.sha('m5')), 'P0002 FACILITY_STAFF_NOT_FOUND')
  ) as cases(label, command, expected) loop
    outcome := pg_temp.refusal(attempt.command);
    if outcome <> attempt.expected then
      raise exception '%: expected %, got %', attempt.label, attempt.expected, outcome;
    end if;
  end loop;
end $$;
-- The laboratory adds only its own roles; the front desk needs no licence.
select pg_temp.as_admin(2, 'roles-add-lab');
do $$
declare outcome text; added record;
begin
  outcome := pg_temp.refusal(format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
    pg_temp.member(5), pg_temp.version(5), 'doctor', 'MDCN', 'MDCN/5', 'facility-staff-attestation-v1',
    'Also sees patients', pg_temp.key('m5-doctor'), pg_temp.sha('m5-doctor')));
  if outcome <> '22023 STAFF_INVITATION_ROLE_NOT_ALLOWED' then
    raise exception '1p: a laboratory added a doctor: %', outcome;
  end if;
  select * into added from identity.add_facility_staff_role(pg_temp.member(5), pg_temp.version(5), 'receptionist',
    null, null, 'facility-staff-attestation-v1', 'Also covers the front desk', pg_temp.key('m5-desk'),
    pg_temp.sha('m5-desk'));
  if added.roles <> array['lab', 'receptionist'] or added.replayed then
    raise exception '1q: the front desk add answered %', row_to_json(added);
  end if;
end $$;
-- Facility 3 is not reviewed.
select pg_temp.as_admin(3, 'roles-add-pending');
do $$
declare outcome text;
begin
  outcome := pg_temp.refusal(format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
    pg_temp.member(2), 1, 'nurse', 'NMCN', 'RN 2', 'facility-staff-attestation-v1',
    'Also covers night triage', pg_temp.key('pending'), pg_temp.sha('pending')));
  if outcome <> 'P0001 FACILITY_REVIEW_PENDING' then
    raise exception '1r: an add before review answered %', outcome;
  end if;
end $$;
reset role;
do $$
declare
  grant_row auth.account_roles%rowtype;
  attestation identity.staff_licence_attestations%rowtype;
begin
  select * into grant_row from auth.account_roles
   where membership_id = pg_temp.member(2) and role_code = 'nurse' and revoked_at is null;
  select * into attestation from identity.staff_licence_attestations where role_grant_id = grant_row.id;
  if grant_row.granted_by <> current_setting('hid.test.r_account_1')::uuid
     or grant_row.grant_reason <> 'Role added by the facility administrator; licence vouched by the facility administrator'
     or attestation.licence_number <> 'RN/ 2002' or attestation.licence_body <> 'NMCN'
     or attestation.verification_method <> 'facility_attestation'
     or attestation.attested_by_membership_id <> current_setting('hid.test.r_membership_1')::uuid
     or attestation.attestation_version <> 'facility-staff-attestation-v1'
     or attestation.attested_person_name <> 'Roles Member 2' or attestation.correlation_id <> 'roles-add-0001'
     or (select count(*) from auth.account_roles where membership_id = pg_temp.member(2) and revoked_at is null) <> 2
     or (select count(*) from identity.staff_licence_attestations where membership_id = pg_temp.member(2)) <> 1 then
    raise exception '1s: the grant or the attestation is wrong: % %', row_to_json(grant_row), row_to_json(attestation);
  end if;
  if (select count(*) from audit.events where action = 'identity.facility-staff.role-add') <> 2
     or not exists (select 1 from audit.events
                     where action = 'identity.facility-staff.role-add' and outcome = 'success' and actor_type = 'staff'
                       and actor_account_id = current_setting('hid.test.r_account_1')::uuid
                       and facility_id = current_setting('hid.test.r_facility_1')::uuid
                       and resource_id = pg_temp.member(2)::text and reason = 'Also covers night triage'
                       and details = jsonb_build_object('membershipId', pg_temp.member(2), 'roleCode', 'nurse',
                         'licenceBody', 'NMCN', 'previousRoles', jsonb_build_array('doctor'),
                         'roles', jsonb_build_array('doctor', 'nurse')))
     or exists (select 1 from audit.events where action like 'identity.facility-staff.role-%'
                 and (details::text like '%2002%' or details::text like '%RN/%')) then
    raise exception '1t: the add audit rows are wrong';
  end if;
  if (select response from auth.admin_command_idempotency
       where operation = 'identity.facility-staff.role-add' and idempotency_key = pg_temp.key('m2-nurse'))
     <> jsonb_build_object('membershipId', pg_temp.member(2), 'facilityId', current_setting('hid.test.r_facility_1')::uuid,
          'version', pg_temp.version(2), 'roles', jsonb_build_array('doctor', 'nurse')) then
    raise exception '1u: the stored answer is wrong';
  end if;
  if exists (select 1 from identity.staff_licence_attestations where membership_id = pg_temp.member(5)) then
    raise exception '1v: the front desk got an attestation';
  end if;
end $$;

-- 2. The administrator's remove.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'roles-remove-0001');
do $$
declare
  before_version bigint := pg_temp.version(2);
  removed record;
  outcome text;
begin
  select * into removed from identity.remove_facility_staff_role(pg_temp.member(2), before_version, 'nurse',
    'Back on days only');
  if removed.roles <> array['doctor'] or removed.row_version <> before_version + 1 or removed.requests_closed <> 0
     or removed.grants_revoked <> 0 then
    raise exception '2a: the remove answered %', row_to_json(removed);
  end if;
  outcome := pg_temp.refusal(format('select identity.remove_facility_staff_role(%L, %s, %L, %L)',
    pg_temp.member(2), before_version, 'nurse', 'Back on days only'));
  if outcome <> 'P0001 FACILITY_STAFF_ROLE_NOT_HELD' then
    raise exception '2b: a retried remove answered %', outcome;
  end if;
  outcome := pg_temp.refusal(format('select identity.remove_facility_staff_role(%L, %s, %L, %L)',
    pg_temp.member(2), pg_temp.version(2), 'doctor', 'Leaving the wards'));
  if outcome <> 'P0001 FACILITY_STAFF_LAST_ROLE' then
    raise exception '2c: removing the last role answered %', outcome;
  end if;
  outcome := pg_temp.refusal(format('select identity.remove_facility_staff_role(%L, %s, %L, %L)',
    pg_temp.member(6), pg_temp.version(6) + 1, 'nurse', 'Doctor work only'));
  if outcome <> '40001 Facility staff membership version conflict' then
    raise exception '2d: a stale remove answered %', outcome;
  end if;
  outcome := pg_temp.refusal(format('select identity.remove_facility_staff_role(%L, %s, %L, %L)',
    pg_temp.member(6), pg_temp.version(6), 'org_admin', 'Doctor work only'));
  if outcome <> '22023 STAFF_INVITATION_INVALID' then
    raise exception '2e: removing an administrator role answered %', outcome;
  end if;
end $$;
-- m1: add lab, then remove nurse: the columns move to lab and the
-- healthcare-operations request is closed (lab does not hold ocr.job.write).
-- m6: remove nurse, keeps doctor (ocr.job.write, own-facility, break-glass):
-- its request and its grants stay.
-- m4: add lab, then remove pharmacist: refused, as membership_role names
-- pharmacist and lab collides with the ended lab membership m14.
-- m8: remove doctor, keeps pharmacist: the own-facility and break-glass
-- grants are revoked, the expired one and the patient's own are not.
select pg_temp.as_admin(1, 'roles-remove-0002');
do $$
declare removed record; outcome text;
begin
  perform identity.add_facility_staff_role(pg_temp.member(1), pg_temp.version(1), 'lab', 'MLSCN', 'ML 1001',
    'facility-staff-attestation-v1', 'Also runs the bench', pg_temp.key('m1-lab'), pg_temp.sha('m1-lab'));
  select * into removed from identity.remove_facility_staff_role(pg_temp.member(1), pg_temp.version(1), 'nurse',
    'Bench work only from now');
  if removed.roles <> array['lab'] or removed.requests_closed <> 1 then
    raise exception '2f: the m1 remove answered %', row_to_json(removed);
  end if;
  select * into removed from identity.remove_facility_staff_role(pg_temp.member(6), pg_temp.version(6), 'nurse',
    'Doctor work only');
  if removed.roles <> array['doctor'] or removed.requests_closed <> 0 or removed.grants_revoked <> 0 then
    raise exception '2g: the m6 remove answered %', row_to_json(removed);
  end if;
  perform identity.add_facility_staff_role(pg_temp.member(4), pg_temp.version(4), 'lab', 'MLSCN', 'ML 4004',
    'facility-staff-attestation-v1', 'Also runs the bench', pg_temp.key('m4-lab'), pg_temp.sha('m4-lab'));
  outcome := pg_temp.refusal(format('select identity.remove_facility_staff_role(%L, %s, %L, %L)',
    pg_temp.member(4), pg_temp.version(4), 'pharmacist', 'Bench work only from now'));
  if outcome <> 'P0001 FACILITY_STAFF_ROLE_COLUMN_CONFLICT' then
    raise exception '2h: the m4 remove answered %', outcome;
  end if;
  -- Refused before the version check, as the last role is.
  outcome := pg_temp.refusal(format('select identity.remove_facility_staff_role(%L, %s, %L, %L)',
    pg_temp.member(4), pg_temp.version(4) + 1, 'pharmacist', 'Bench work only from now'));
  if outcome <> 'P0001 FACILITY_STAFF_ROLE_COLUMN_CONFLICT' then
    raise exception '2h: a stale m4 remove answered %', outcome;
  end if;
end $$;
select pg_temp.as_admin(1, 'roles-remove-0003');
do $$
declare removed record;
begin
  select * into removed from identity.remove_facility_staff_role(pg_temp.member(8), pg_temp.version(8), 'doctor',
    'Pharmacy work only from now');
  if removed.roles <> array['pharmacist'] or removed.requests_closed <> 0 or removed.grants_revoked <> 2 then
    raise exception '2n: the m8 remove answered %', row_to_json(removed);
  end if;
end $$;
reset role;
do $$
begin
  if (select array[membership_role, app_role] from identity.staff_facility_memberships where id = pg_temp.member(1))
       <> array['lab', 'lab']
     or (select array[membership_role, app_role] from identity.staff_facility_memberships where id = pg_temp.member(6))
       <> array['doctor', 'doctor']
     or (select array[membership_role, app_role] from identity.staff_facility_memberships where id = pg_temp.member(4))
       <> array['pharmacist', 'pharmacist']
     or (select array[membership_role, app_role] from identity.staff_facility_memberships where id = pg_temp.member(8))
       <> array['pharmacist', 'pharmacist']
     or (select array[membership_role, app_role] from identity.staff_facility_memberships where id = pg_temp.member(2))
       <> array['doctor', 'doctor'] then
    raise exception '2i: the role columns are wrong';
  end if;
  if (select array_agg(role_code order by role_code) from auth.account_roles
       where membership_id = pg_temp.member(4) and revoked_at is null) <> array['lab', 'pharmacist'] then
    raise exception '2i: the refused m4 remove changed its roles';
  end if;
  if not exists (select 1 from auth.account_roles
                  where membership_id = pg_temp.member(2) and role_code = 'nurse' and revoked_at is not null
                    and revoked_by = current_setting('hid.test.r_account_1')::uuid
                    and revocation_reason = 'Role removed by the facility administrator')
     or not exists (select 1 from auth.account_roles
                     where membership_id = pg_temp.member(2) and role_code = 'doctor' and revoked_at is null) then
    raise exception '2j: the revocation is wrong';
  end if;
  if (select status from identity.access_requests where id = 'e1397000-0000-4000-8000-000000000001') <> 'expired'
     or (select status from identity.access_requests where id = 'e1397000-0000-4000-8000-000000000002') <> 'pending'
     or (select status from identity.access_requests where id = 'e1397000-0000-4000-8000-000000000003') <> 'pending' then
    raise exception '2k: the wrong requests were closed';
  end if;
  if (select count(*) from audit.events where action = 'identity.access-request.close'
       and correlation_id = 'roles-remove-0002') <> 1
     or not exists (select 1 from audit.events
                     where action = 'identity.access-request.close' and actor_type = 'system' and actor_subject is null
                       and resource_id = 'e1397000-0000-4000-8000-000000000001'
                       and patient_id = 'e1396000-0000-4000-8000-000000000001'
                       and facility_id = current_setting('hid.test.r_facility_1')::uuid
                       and details = '{"cause": "role-removed", "scope": "read_records", "status": "expired"}'::jsonb) then
    raise exception '2l: the closing audit row is wrong';
  end if;
  if not exists (select 1 from audit.events
                  where action = 'identity.facility-staff.role-remove' and correlation_id = 'roles-remove-0002'
                    and resource_id = pg_temp.member(1)::text and reason = 'Bench work only from now'
                    and details = jsonb_build_object('membershipId', pg_temp.member(1), 'roleCode', 'nurse',
                      'previousRoles', jsonb_build_array('lab', 'nurse'), 'roles', jsonb_build_array('lab'),
                      'requestsClosed', 1, 'grantsRevoked', 0)) then
    raise exception '2m: the remove audit row is wrong';
  end if;
  -- m8's grants: the two the roles left no longer allow are revoked.
  if (select array_agg(id order by id) from identity.consent_grants
       where membership_id = pg_temp.member(8) and status = 'revoked'
         and revoked_by = current_setting('hid.test.r_account_1')::uuid and revoked_at is not null
         and revoked_reason = 'Role removed by the facility administrator')
       is distinct from array[pg_temp.grant_id(1), pg_temp.grant_id(2)]
     or (select array_agg(status order by id) from identity.consent_grants
          where id in (pg_temp.grant_id(3), pg_temp.grant_id(4), pg_temp.grant_id(5), pg_temp.grant_id(6)))
       <> array['active', 'active', 'active', 'active'] then
    raise exception '2o: the wrong grants were revoked';
  end if;
  if pg_temp.allowed(1, 8, 'direct-care') or pg_temp.allowed(2, 8, 'emergency')
     or not pg_temp.allowed(3, 8, 'direct-care')
     or not pg_temp.allowed(1, 6, 'direct-care') or not pg_temp.allowed(3, 6, 'emergency') then
    raise exception '2p: a revoked grant still admits, or a kept one does not';
  end if;
  if (select count(*) from audit.events where action = 'identity.consent-grant.close'
       and correlation_id = 'roles-remove-0003') <> 2
     or (select count(*) from audit.events
          where action = 'identity.consent-grant.close' and correlation_id = 'roles-remove-0003'
            and actor_type = 'staff' and actor_subject = 'org-onboarding:' || current_setting('hid.test.r_account_1')
            and actor_account_id = current_setting('hid.test.r_account_1')::uuid
            and actor_membership_id = current_setting('hid.test.r_membership_1')::uuid
            and organization_id = current_setting('hid.test.r_org_1')::uuid
            and facility_id = current_setting('hid.test.r_facility_1')::uuid
            and outcome = 'success' and resource_type = 'consent-grant'
            and reason = 'Role removed by the facility administrator'
            and ((resource_id = pg_temp.grant_id(1)::text and patient_id = 'e1396000-0000-4000-8000-000000000001'
                  and details = jsonb_build_object('existing_closure', false, 'membershipId', pg_temp.member(8),
                    'cause', 'role-removed', 'access', 'own_facility'))
              or (resource_id = pg_temp.grant_id(2)::text and patient_id = 'e1396000-0000-4000-8000-000000000002'
                  and details = jsonb_build_object('existing_closure', false, 'membershipId', pg_temp.member(8),
                    'cause', 'role-removed', 'access', 'break_glass')))) <> 2
     or exists (select 1 from audit.events where action = 'identity.consent-grant.close'
                 and correlation_id = 'roles-remove-0002') then
    raise exception '2q: the grant closing audit rows are wrong';
  end if;
  if not exists (select 1 from audit.events
                  where action = 'identity.facility-staff.role-remove' and correlation_id = 'roles-remove-0003'
                    and details = jsonb_build_object('membershipId', pg_temp.member(8), 'roleCode', 'doctor',
                      'previousRoles', jsonb_build_array('doctor', 'pharmacist'), 'roles', jsonb_build_array('pharmacist'),
                      'requestsClosed', 0, 'grantsRevoked', 2)) then
    raise exception '2r: the m8 remove audit row is wrong';
  end if;
end $$;

-- 3. The reads.
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'roles-read-0001');
do $$
declare listed jsonb; expected jsonb;
begin
  select jsonb_agg(to_jsonb(licence) - 'vouched_at' order by licence.membership_id, licence.role_code) into listed
    from identity.list_facility_staff_licences() licence;
  -- The administrator's membership id is random, so the expected rows are
  -- put in the read's order (membership, role) before comparing.
  select jsonb_agg(item order by (item->>'membership_id')::uuid, item->>'role_code') into expected
    from jsonb_array_elements(jsonb_build_array(
       jsonb_build_object('membership_id', current_setting('hid.test.r_membership_1'), 'role_code', 'doctor',
         'licence_body', 'MDCN', 'licence_number_hint', '1390', 'vouched_by_name', 'Roles Super Admin',
         'verification_method', 'platform_review'),
       jsonb_build_object('membership_id', pg_temp.member(1), 'role_code', 'lab', 'licence_body', 'MLSCN',
         'licence_number_hint', '1001', 'vouched_by_name', 'Ada Roles Admin', 'verification_method', 'facility_attestation'),
       jsonb_build_object('membership_id', pg_temp.member(2), 'role_code', 'doctor', 'licence_body', 'MDCN',
         'licence_number_hint', null, 'vouched_by_name', null, 'verification_method', null),
       jsonb_build_object('membership_id', pg_temp.member(4), 'role_code', 'lab', 'licence_body', 'MLSCN',
         'licence_number_hint', '4004', 'vouched_by_name', 'Ada Roles Admin', 'verification_method', 'facility_attestation'),
       jsonb_build_object('membership_id', pg_temp.member(4), 'role_code', 'pharmacist', 'licence_body', 'PCN',
         'licence_number_hint', null, 'vouched_by_name', null, 'verification_method', null),
       jsonb_build_object('membership_id', pg_temp.member(6), 'role_code', 'doctor', 'licence_body', 'MDCN',
         'licence_number_hint', null, 'vouched_by_name', null, 'verification_method', null),
       jsonb_build_object('membership_id', pg_temp.member(8), 'role_code', 'pharmacist', 'licence_body', 'PCN',
         'licence_number_hint', null, 'vouched_by_name', null, 'verification_method', null))) item;
  if listed is distinct from expected then
    raise exception '3a: the licences read %', listed;
  end if;
end $$;
reset role;

-- 4. Support.
set local role hid_identity_api_runtime;
select pg_temp.as_platform('synthetic:roles:support', 'roles-support-0001');
do $$
declare outcome text;
begin
  outcome := pg_temp.refusal(format(
    'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
    'e1393000-0000-4000-8000-000000000010', pg_temp.member(7), pg_temp.version(7), 'nurse', 'NMCN', 'RN 7007',
    'regulator_register', 'Covers the governed ward', pg_temp.key('g-nurse'), pg_temp.sha('g-nurse')));
  if outcome <> '42501 ADMIN_PERMISSION_DENIED' then
    raise exception '4a: support_admin without the permission answered %', outcome;
  end if;
end $$;
select pg_temp.as_platform('synthetic:roles:super', 'roles-support-0002');
do $$
declare
  before_version bigint := pg_temp.version(7);
  added record;
  replay record;
  outcome text;
  attempt record;
begin
  select * into added from identity.admin_add_facility_staff_role('e1393000-0000-4000-8000-000000000010',
    pg_temp.member(7), before_version, 'nurse', 'NMCN', 'RN 7007', 'regulator_register', 'Covers the governed ward',
    pg_temp.key('g-nurse'), pg_temp.sha('g-nurse'));
  if added.roles <> array['doctor', 'nurse'] or added.previous_roles <> array['doctor']
     or added.row_version <> before_version + 1 or added.replayed then
    raise exception '4b: the support add answered %', row_to_json(added);
  end if;
  select * into replay from identity.admin_add_facility_staff_role('e1393000-0000-4000-8000-000000000010',
    pg_temp.member(7), before_version, 'nurse', 'NMCN', 'RN 7007', 'regulator_register', 'Covers the governed ward',
    pg_temp.key('g-nurse'), pg_temp.sha('g-nurse'));
  if replay.roles <> array['doctor', 'nurse'] or replay.previous_roles <> array['doctor']
     or replay.row_version <> before_version + 1 or not replay.replayed then
    raise exception '4c: the support replay answered %', row_to_json(replay);
  end if;
  for attempt in select * from (values
    ('4d same key, another facility', format(
      'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
      current_setting('hid.test.r_facility_1'), pg_temp.member(7), before_version, 'nurse', 'NMCN', 'RN 7007',
      'regulator_register', 'Covers the governed ward', pg_temp.key('g-nurse'), pg_temp.sha('g-nurse')),
      '23505 IDEMPOTENCY_KEY_REUSED'),
    ('4e no method', format(
      'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, null, %L, %L, %L)',
      'e1393000-0000-4000-8000-000000000010', pg_temp.member(7), pg_temp.version(7), 'lab', 'MLSCN', 'ML 7007',
      'Runs the governed bench', pg_temp.key('g-lab'), pg_temp.sha('g-lab')), '22023 STAFF_INVITATION_INVALID'),
    ('4f facility attestation is not support''s method', format(
      'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
      'e1393000-0000-4000-8000-000000000010', pg_temp.member(7), pg_temp.version(7), 'lab', 'MLSCN', 'ML 7007',
      'facility_attestation', 'Runs the governed bench', pg_temp.key('g-lab'), pg_temp.sha('g-lab')),
      '22023 STAFF_INVITATION_INVALID'),
    ('4g front desk with a method', format(
      'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, null, null, %L, %L, %L, %L)',
      'e1393000-0000-4000-8000-000000000010', pg_temp.member(7), pg_temp.version(7), 'receptionist',
      'in_person', 'Covers the governed desk', pg_temp.key('g-desk'), pg_temp.sha('g-desk')),
      '22023 STAFF_INVITATION_INVALID'),
    ('4h unknown facility', format(
      'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
      'e1393000-0000-4000-8000-0000000000ff', pg_temp.member(7), pg_temp.version(7), 'lab', 'MLSCN', 'ML 7007',
      'in_person', 'Runs the governed bench', pg_temp.key('g-unknown'), pg_temp.sha('g-unknown')),
      'P0002 ADMIN_FACILITY_NOT_FOUND'),
    ('4i member of another facility', format(
      'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
      'e1393000-0000-4000-8000-000000000010', pg_temp.member(2), pg_temp.version(2), 'lab', 'MLSCN', 'ML 7007',
      'in_person', 'Runs the governed bench', pg_temp.key('g-other'), pg_temp.sha('g-other')),
      'P0002 FACILITY_STAFF_NOT_FOUND'),
    ('4j a laboratory''s roles', format(
      'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
      current_setting('hid.test.r_facility_2'), pg_temp.member(5), pg_temp.version(5), 'doctor', 'MDCN', 'MDCN/5',
      'in_person', 'Also sees patients', pg_temp.key('lab-doctor'), pg_temp.sha('lab-doctor')),
      '22023 STAFF_INVITATION_ROLE_NOT_ALLOWED'),
    ('4k the administrator of a facility under review (its only member)', format(
      'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
      current_setting('hid.test.r_facility_3'), current_setting('hid.test.r_membership_3'), 1, 'doctor', 'MDCN',
      'MDCN/3', 'in_person', 'Also sees patients', pg_temp.key('pending-doctor'), pg_temp.sha('pending-doctor')),
      'P0001 FACILITY_STAFF_ADMINISTRATOR'),
    ('4l a platform account', format(
      'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
      current_setting('hid.test.r_facility_1'), pg_temp.member(3), pg_temp.version(3), 'nurse', 'NMCN', 'RN 3',
      'in_person', 'Covers night triage', pg_temp.key('platform-member'), pg_temp.sha('platform-member')),
      'P0001 FACILITY_STAFF_PLATFORM_ACCOUNT')
  ) as cases(label, command, expected) loop
    outcome := pg_temp.refusal(attempt.command);
    if outcome <> attempt.expected then
      raise exception '%: expected %, got %', attempt.label, attempt.expected, outcome;
    end if;
  end loop;
  -- A self-signed-up facility's administrator (org_admin and doctor): 0086
  -- S12's administrator-role command, not these.
  outcome := pg_temp.refusal(format(
    'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
    current_setting('hid.test.r_facility_1'), current_setting('hid.test.r_membership_1'),
    (select row_version from identity.staff_facility_memberships
      where id = current_setting('hid.test.r_membership_1')::uuid),
    'nurse', 'NMCN', 'RN 1390', 'officer_match', 'Also covers night triage', pg_temp.key('admin-nurse'),
    pg_temp.sha('admin-nurse')));
  if outcome <> 'P0001 FACILITY_STAFF_ADMINISTRATOR' then
    raise exception '4m: support''s add to a self-signed-up administrator answered %', outcome;
  end if;
  outcome := pg_temp.refusal(format(
    'select identity.admin_remove_facility_staff_role(%L, %L, %s, %L, %L, %L, %L)',
    current_setting('hid.test.r_facility_1'), current_setting('hid.test.r_membership_1'),
    (select row_version from identity.staff_facility_memberships
      where id = current_setting('hid.test.r_membership_1')::uuid),
    'doctor', 'Administration only from now', pg_temp.key('admin-remove'), pg_temp.sha('admin-remove')));
  if outcome <> 'P0001 FACILITY_STAFF_ADMINISTRATOR' then
    raise exception '4m: support''s remove from a self-signed-up administrator answered %', outcome;
  end if;
  -- A governed facility's administrator (m9, org_admin and doctor).
  select * into added from identity.admin_add_facility_staff_role('e1393000-0000-4000-8000-000000000010',
    pg_temp.member(9), pg_temp.version(9), 'pharmacist', 'PCN', 'PCN 9009', 'in_person',
    'Also runs the governed pharmacy', pg_temp.key('g-admin-pharmacist'), pg_temp.sha('g-admin-pharmacist'));
  if added.roles <> array['doctor', 'org_admin', 'pharmacist'] or added.replayed then
    raise exception '4m: support''s add to a governed administrator answered %', row_to_json(added);
  end if;
end $$;
-- Support removes, and replays the remove.
select pg_temp.as_platform('synthetic:roles:super', 'roles-support-0003');
do $$
declare before_version bigint := pg_temp.version(7); removed record; replay record;
begin
  select * into removed from identity.admin_remove_facility_staff_role('e1393000-0000-4000-8000-000000000010',
    pg_temp.member(7), before_version, 'doctor', 'Nursing only from now', pg_temp.key('g-remove'), pg_temp.sha('g-remove'));
  if removed.roles <> array['nurse'] or removed.previous_roles <> array['doctor', 'nurse']
     or removed.row_version <> before_version + 1 or removed.requests_closed <> 0 or removed.grants_revoked <> 0
     or removed.replayed then
    raise exception '4n: the support remove answered %', row_to_json(removed);
  end if;
  select * into replay from identity.admin_remove_facility_staff_role('e1393000-0000-4000-8000-000000000010',
    pg_temp.member(7), before_version, 'doctor', 'Nursing only from now', pg_temp.key('g-remove'), pg_temp.sha('g-remove'));
  if replay.roles <> array['nurse'] or replay.row_version <> before_version + 1 or not replay.replayed
     or replay.requests_closed <> 0 or replay.grants_revoked <> 0 then
    raise exception '4o: the support remove replay answered %', row_to_json(replay);
  end if;
end $$;
-- Support removes doctor from the governed administrator: its own-facility
-- grant is revoked (the system actor's row, as a platform row names no
-- patient), and the replay answers the same count.
select pg_temp.as_platform('synthetic:roles:super', 'roles-support-0004');
do $$
declare before_version bigint := pg_temp.version(9); removed record; replay record;
begin
  select * into removed from identity.admin_remove_facility_staff_role('e1393000-0000-4000-8000-000000000010',
    pg_temp.member(9), before_version, 'doctor', 'Pharmacy and administration only', pg_temp.key('g-admin-remove'),
    pg_temp.sha('g-admin-remove'));
  if removed.roles <> array['org_admin', 'pharmacist'] or removed.grants_revoked <> 1 or removed.replayed then
    raise exception '4x: support''s remove from a governed administrator answered %', row_to_json(removed);
  end if;
  select * into replay from identity.admin_remove_facility_staff_role('e1393000-0000-4000-8000-000000000010',
    pg_temp.member(9), before_version, 'doctor', 'Pharmacy and administration only', pg_temp.key('g-admin-remove'),
    pg_temp.sha('g-admin-remove'));
  if replay.grants_revoked <> 1 or not replay.replayed then
    raise exception '4x: its replay answered %', row_to_json(replay);
  end if;
end $$;
select pg_temp.as_platform('synthetic:roles:super', 'roles-support-read');
do $$
declare listed jsonb;
begin
  select jsonb_agg(to_jsonb(licence) - 'vouched_at' order by licence.membership_id, licence.role_code) into listed
    from identity.admin_list_facility_staff_licences('e1393000-0000-4000-8000-000000000010') licence;
  if listed <> jsonb_build_array(jsonb_build_object('membership_id', pg_temp.member(7), 'role_code', 'nurse',
       'licence_body', 'NMCN', 'licence_number_hint', '7007', 'vouched_by_name', 'Roles Super Admin',
       'verification_method', 'regulator_register'),
       jsonb_build_object('membership_id', pg_temp.member(9), 'role_code', 'pharmacist',
       'licence_body', 'PCN', 'licence_number_hint', '9009', 'vouched_by_name', 'Roles Super Admin',
       'verification_method', 'in_person')) then
    raise exception '4p: support''s licences read %', listed;
  end if;
end $$;
select pg_temp.as_admin(1, 'roles-support-read-staff');
do $$
declare outcome text;
begin
  outcome := pg_temp.refusal('select * from identity.admin_list_facility_staff_licences(''e1393000-0000-4000-8000-000000000010'')');
  if outcome <> '42501 ADMIN_PERMISSION_DENIED' then
    raise exception '4q: a facility administrator read support''s licences: %', outcome;
  end if;
  outcome := pg_temp.refusal(format(
    'select identity.admin_add_facility_staff_role(%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
    'e1393000-0000-4000-8000-000000000010', pg_temp.member(7), pg_temp.version(7), 'doctor', 'MDCN', 'MDCN/7',
    'in_person', 'Back on the wards', pg_temp.key('staff-as-support'), pg_temp.sha('staff-as-support')));
  if outcome <> '42501 ADMIN_PERMISSION_DENIED' then
    raise exception '4r: a facility administrator used support''s add: %', outcome;
  end if;
end $$;
reset role;
do $$
declare attestation identity.staff_licence_attestations%rowtype;
begin
  select * into attestation from identity.staff_licence_attestations
   where membership_id = pg_temp.member(7) and role_code = 'nurse';
  if attestation.verification_method <> 'regulator_register' or attestation.attested_by_membership_id is not null
     or attestation.review_application_id is not null or attestation.invitation_id is not null
     or attestation.attestation_version <> 'platform-staff-role-v1'
     or attestation.attested_by_account_id <> 'e1390000-0000-4000-8000-000000000001' then
    raise exception '4s: support''s attestation is wrong: %', row_to_json(attestation);
  end if;
  if not exists (select 1 from auth.account_roles
                  where membership_id = pg_temp.member(7) and role_code = 'doctor'
                    and revocation_reason = 'Role removed by Health ID support'
                    and revoked_by = 'e1390000-0000-4000-8000-000000000001')
     or not exists (select 1 from auth.account_roles
                     where membership_id = pg_temp.member(7) and role_code = 'nurse' and revoked_at is null
                       and grant_reason = 'Role added by Health ID support; licence checked by Health ID support') then
    raise exception '4t: support''s grant or revocation is wrong';
  end if;
  if (select count(*) from auth.admin_command_idempotency
       where actor_account_id = 'e1390000-0000-4000-8000-000000000001'
         and operation in ('admin.facility-staff.role-add', 'admin.facility-staff.role-remove')) <> 4 then
    raise exception '4u: support''s stored answers are wrong';
  end if;
  if (select status || ' ' || revoked_by || ' ' || revoked_reason from identity.consent_grants
       where id = pg_temp.grant_id(7))
       is distinct from 'revoked e1390000-0000-4000-8000-000000000001 Role removed by Health ID support'
     or pg_temp.allowed(1, 9, 'direct-care')
     or (select count(*) from audit.events
          where action = 'identity.consent-grant.close' and correlation_id = 'roles-support-0004') <> 1
     or not exists (select 1 from audit.events
                     where action = 'identity.consent-grant.close' and correlation_id = 'roles-support-0004'
                       and actor_type = 'system' and actor_subject is null and actor_account_id is null
                       and actor_membership_id is null
                       and organization_id = 'e1393000-0000-4000-8000-000000000009'
                       and facility_id = 'e1393000-0000-4000-8000-000000000010'
                       and patient_id = 'e1396000-0000-4000-8000-000000000001'
                       and resource_id = pg_temp.grant_id(7)::text and reason = 'Role removed by Health ID support'
                       and details = jsonb_build_object('existing_closure', false, 'membershipId', pg_temp.member(9),
                         'cause', 'role-removed', 'access', 'own_facility')) then
    raise exception '4y: support''s grant revocation or its audit row is wrong';
  end if;
  -- The constraint refuses a support method with a membership, and an unknown method.
  begin
    insert into identity.staff_licence_attestations (organization_id, facility_id, account_id, staff_id, membership_id,
      role_code, role_grant_id, licence_body, licence_number, attested_person_name, verification_method,
      attested_by_account_id, attested_by_membership_id, attestation_version, attested_at, correlation_id)
    select source_row.organization_id, source_row.facility_id, source_row.account_id, source_row.staff_id,
      source_row.membership_id, source_row.role_code, source_row.role_grant_id, source_row.licence_body,
      source_row.licence_number, source_row.attested_person_name, 'in_person', source_row.attested_by_account_id,
      current_setting('hid.test.r_membership_1')::uuid, source_row.attestation_version, source_row.attested_at,
      source_row.correlation_id
      from identity.staff_licence_attestations source_row
     where source_row.membership_id = pg_temp.member(2) or source_row.membership_id = pg_temp.member(1)
     limit 1;
    raise exception '4v: a support method with a membership was stored';
  exception when check_violation then null;
  end;
  begin
    insert into identity.staff_licence_attestations (organization_id, facility_id, account_id, staff_id, membership_id,
      role_code, role_grant_id, licence_body, licence_number, attested_person_name, verification_method,
      attested_by_account_id, attestation_version, attested_at, correlation_id)
    select source_row.organization_id, source_row.facility_id, source_row.account_id, source_row.staff_id,
      source_row.membership_id, source_row.role_code, source_row.role_grant_id, source_row.licence_body,
      source_row.licence_number, source_row.attested_person_name, 'phone_call', source_row.attested_by_account_id,
      source_row.attestation_version, source_row.attested_at, source_row.correlation_id
      from identity.staff_licence_attestations source_row where source_row.membership_id = pg_temp.member(7);
    raise exception '4w: an unknown method was stored';
  exception when check_violation then null;
  end;
end $$;

-- 5. The control closes add, not remove; the helpers are not the runtime's.
set local role hid_identity_api_runtime;
select pg_temp.as_platform('synthetic:roles:super', 'roles-close-control');
select platform.admin_set_control('staff_invitations_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Staff roles suite closes staff invitations');
select pg_temp.as_admin(1, 'roles-closed-0001');
do $$
declare outcome text; removed record;
begin
  outcome := pg_temp.refusal(format('select identity.add_facility_staff_role(%L, %s, %L, %L, %L, %L, %L, %L, %L)',
    pg_temp.member(6), pg_temp.version(6), 'nurse', 'NMCN', 'RN 6006', 'facility-staff-attestation-v1',
    'Also covers night triage', pg_temp.key('closed'), pg_temp.sha('closed')));
  if outcome <> '55000 PLATFORM_CONTROL_DISABLED:staff_invitations_enabled' then
    raise exception '5a: an add with the control closed answered %', outcome;
  end if;
  -- A remove still works: m2 holds doctor only, so its last role is
  -- refused; m1 gets nurse back first through support (support's commands
  -- are not behind the control) and then loses it.
  outcome := pg_temp.refusal(format('select identity.remove_facility_staff_role(%L, %s, %L, %L)',
    pg_temp.member(2), pg_temp.version(2), 'doctor', 'Leaving the wards again'));
  if outcome <> 'P0001 FACILITY_STAFF_LAST_ROLE' then
    raise exception '5b: removing m2''s last role answered %', outcome;
  end if;
  perform pg_temp.as_platform('synthetic:roles:super', 'roles-closed-support');
  perform identity.admin_add_facility_staff_role(current_setting('hid.test.r_facility_1')::uuid, pg_temp.member(1),
    pg_temp.version(1), 'nurse', 'NMCN', 'RN 1001', 'in_person', 'Back on the ward', pg_temp.key('m1-nurse-back'),
    pg_temp.sha('m1-nurse-back'));
  perform pg_temp.as_admin(1, 'roles-closed-0002');
  select * into removed from identity.remove_facility_staff_role(pg_temp.member(1), pg_temp.version(1), 'nurse',
    'Bench work only again');
  if removed.roles <> array['lab'] then
    raise exception '5c: a remove with the control closed answered %', row_to_json(removed);
  end if;
end $$;
do $$
declare outcome text;
begin
  foreach outcome in array array[
    pg_temp.refusal(format('select identity.staff_role_change_roles(%L)', current_setting('hid.test.r_facility_1'))),
    pg_temp.refusal(format('select identity.staff_role_licences(%L)', current_setting('hid.test.r_facility_1'))),
    pg_temp.refusal(format('select identity.staff_role_change_member(%L, %L, %L, true)', pg_temp.member(2),
      current_setting('hid.test.r_facility_1'), current_setting('hid.test.r_account_1')))] loop
    if outcome not like '42501 permission denied for function%' then
      raise exception '5d: the runtime ran a helper: %', outcome;
    end if;
  end loop;
end $$;
reset role;
do $$
begin
  if has_function_privilege('hid_identity_runtime',
       'identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,text,text,text,text,text,uuid,uuid,text)',
       'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime',
       'identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)', 'EXECUTE')
     or has_function_privilege('hid_ehr_runtime',
       'identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)', 'EXECUTE') then
    raise exception '5e: the grants are wrong';
  end if;
  if (select array_agg(role_code order by role_code) from auth.role_permissions
       where permission_code = 'platform.facility-staff.manage') <> array['platform_admin', 'platform_super_admin'] then
    raise exception '5f: platform.facility-staff.manage is held by the wrong roles';
  end if;
end $$;

rollback;
