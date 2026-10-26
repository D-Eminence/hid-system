-- The ordering facility's Overview read of orders ended as accepted for the
-- wrong person (0088 C28, item 3's D10 alternative (a)). Rollback-only; fails
-- without 0088. Read as the exact EHR runtime.
--   1. a sender sees full rows only for orders they sent whose patient's
--      record they may still read: reference, kind, receiving facility, the
--      patient's name, when it ended, what was withdrawn, the link; newest
--      first;
--   2. of every other such order of the facility (a colleague's, or their
--      own without read access now) only the count and the references;
--   3. a member without ehr.order-route.send (a nurse, a laboratory
--      scientist, an administrator) sees nothing, as does a member of another
--      facility;
--   4. orders that ended over 30 days ago, ended another way, or are still
--      live are not listed;
--   5. the read is bound to the live staff session, its facility and the
--      direct-care purpose (42501 otherwise), and writes nothing.
-- Shared fixture of the P4c suites (each suite carries its own copy, so it
-- runs alone). Synthetic values only; uuid prefix e4c.
--   Platform: SA (platform_super_admin), SU (support_admin), FR
--     (facility_review_admin), AU (security_auditor).
--   Governed hospital GH (an approved admin_review hospital application, the
--     ordering facility A): DA doctor (MDCN licence attested by the facility),
--     CA clinician, NA nurse, LA lab, PA pharmacist, RA receptionist, GA
--     org_admin; each but GA holds a direct-care write consent for patients P,
--     Q and N at GH.
--   Governed hospital H3 (a third facility): D3 doctor with a consent for P.
--   Governed laboratory GL (approved laboratory application, product
--     laboratory at GL, registered address): GLM lab.
--   Self-signed-up and reviewed (through P4's sign-up and P4b's review):
--     laboratory L1 (method cac_registered_contact; its administrator LB1
--     holds lab), with LB2 lab and RB receptionist added; pharmacy PH1
--     (pharmacist administrator PB1), with PB2 pharmacist added.
--   Patients P and Q with active accounts (a live patient session each), N
--     without an account. Encounters EP, EQ and EN at GH.
\set ON_ERROR_STOP on
set plpgsql.variable_conflict = error;
begin;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

insert into identity.purpose_of_use_codes (code, display, source_system)
values ('direct-care', 'Direct patient care', 'p4c-test') on conflict (code) do nothing;

-- Platform administrators (standalone, no facility membership).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e4c10000-0000-4000-8000-000000000001', 'synthetic:p4c:super', 'super@p4c.invalid', 'P4c Super Admin', 'active'),
  ('e4c10000-0000-4000-8000-000000000002', 'synthetic:p4c:support', 'support@p4c.invalid', 'P4c Support', 'active'),
  ('e4c10000-0000-4000-8000-000000000003', 'synthetic:p4c:reviewer', 'reviewer@p4c.invalid', 'P4c Reviewer', 'active'),
  ('e4c10000-0000-4000-8000-000000000004', 'synthetic:p4c:auditor', 'auditor@p4c.invalid', 'P4c Auditor', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('e4c11000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform', 'P4c suite super admin'),
  ('e4c11000-0000-4000-8000-000000000002', 'e4c10000-0000-4000-8000-000000000002', 'support_admin', 'platform', 'P4c suite support admin'),
  ('e4c11000-0000-4000-8000-000000000003', 'e4c10000-0000-4000-8000-000000000003', 'facility_review_admin', 'platform', 'P4c suite facility reviewer'),
  ('e4c11000-0000-4000-8000-000000000004', 'e4c10000-0000-4000-8000-000000000004', 'security_auditor', 'platform', 'P4c suite security auditor');

-- Governed organizations: hospital GH, hospital H3, laboratory GL.
insert into identity.organizations (id, name, slug) values
  ('e4c20000-0000-4000-8000-000000000001', 'P4c Governed Hospital Ltd', 'p4c-governed-hospital'),
  ('e4c20000-0000-4000-8000-000000000003', 'P4c Third Hospital Ltd', 'p4c-third-hospital'),
  ('e4c20000-0000-4000-8000-000000000002', 'P4c Governed Diagnostics Ltd', 'p4c-governed-diagnostics');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e4c21000-0000-4000-8000-000000000001', 'e4c20000-0000-4000-8000-000000000001', 'P4c General Hospital',
   'P4C-GH', 'Africa/Lagos', true, 'verified'),
  ('e4c21000-0000-4000-8000-000000000003', 'e4c20000-0000-4000-8000-000000000003', 'P4c Third Hospital',
   'P4C-H3', 'Africa/Lagos', true, 'verified'),
  ('e4c21000-0000-4000-8000-000000000002', 'e4c20000-0000-4000-8000-000000000002', 'P4c Governed Laboratory',
   'P4C-GL', 'Africa/Lagos', true, 'verified');
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status)
select ('e4c22000-0000-4000-8000-00000000000' || g.n)::uuid, g.product, g.legal_name, g.kind, g.cac,
  'Governed Admin ' || g.n, 'admin' || g.n || '@p4c-governed.invalid', 'approved', 'verified', '77' || g.n,
  clock_timestamp(), ('e4c20000-0000-4000-8000-00000000000' || g.n)::uuid,
  ('e4c21000-0000-4000-8000-00000000000' || g.n)::uuid, 'e4c10000-0000-4000-8000-000000000001',
  'Governed approval for the P4c suites', clock_timestamp(), g.legal_name, 'Private Company Limited by Shares',
  '2019-05-01', g.n || ' Governed Road, Ikeja, Lagos', 'active'
  from (values (1, 'ehr', 'hospital', 'RC9944001', 'P4c Governed Hospital Ltd'),
               (2, 'laboratory', 'laboratory', 'RC9944002', 'P4c Governed Diagnostics Ltd'),
               (3, 'ehr', 'hospital', 'RC9944003', 'P4c Third Hospital Ltd')) g(n, product, kind, cac, legal_name);
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
select ('e4c20000-0000-4000-8000-00000000000' || n)::uuid, product, ('e4c21000-0000-4000-8000-00000000000' || n)::uuid,
  'active', ('e4c22000-0000-4000-8000-00000000000' || n)::uuid
  from (values (1, 'ehr'), (2, 'laboratory'), (3, 'ehr')) g(n, product);
-- (The binding trigger copies from a ready_for_review application at
-- approval; the fixture writes the approved binding directly.)
set local session_replication_role = replica;
insert into identity.organization_cac_registrations (cac_registration_number, organization_id, primary_facility_id,
  source_application_id, verified_organization_name, verified_entity_type, verified_registration_date, verified_address,
  verified_registry_status, organization_name_source, entity_type_source, registration_date_source, address_source,
  registry_status_source)
values ('RC9944002', 'e4c20000-0000-4000-8000-000000000002', 'e4c21000-0000-4000-8000-000000000002',
  'e4c22000-0000-4000-8000-000000000002', 'P4c Governed Diagnostics Ltd', 'Private Company Limited by Shares',
  '2019-05-01', '2 Governed Road, Ikeja, Lagos', 'active', 'qoreid', 'qoreid', 'qoreid', 'qoreid', 'qoreid');
set local session_replication_role = origin;

-- Governed staff. n: 11 DA doctor, 12 CA clinician, 13 NA nurse, 14 LA lab,
-- 15 PA pharmacist, 16 RA receptionist, 17 GA org_admin (GH); 21 GLM lab
-- (GL); 26 D3 doctor (H3).
insert into auth.accounts (id, subject, email, display_name, status)
select ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:p4c:' || s.code,
  s.code || '@p4c-staff.invalid', s.full_name, 'active'
  from (values (11, 'da', 'Ada Doctor'), (12, 'ca', 'Bayo Clinician'), (13, 'na', 'Chika Nurse'),
               (14, 'la', 'Dele Lab'), (15, 'pa', 'Efe Pharmacist'), (16, 'ra', 'Funmi Reception'),
               (17, 'ga', 'Gbade Admin'), (21, 'glm', 'Hassan Governed Lab'), (26, 'd3', 'Ifeoma Third Doctor'))
       s(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@p4c-staff.invalid', 'verified', s.role
  from (values (11, 'da', 'Ada Doctor', 'doctor'), (12, 'ca', 'Bayo Clinician', 'clinician'),
               (13, 'na', 'Chika Nurse', 'nurse'), (14, 'la', 'Dele Lab', 'lab'), (15, 'pa', 'Efe Pharmacist', 'pharmacist'),
               (16, 'ra', 'Funmi Reception', 'receptionist'), (17, 'ga', 'Gbade Admin', 'org_admin'),
               (21, 'glm', 'Hassan Governed Lab', 'lab'), (26, 'd3', 'Ifeoma Third Doctor', 'doctor'))
       s(n, code, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c20000-0000-4000-8000-00000000000' || s.org)::uuid,
  ('e4c21000-0000-4000-8000-00000000000' || s.org)::uuid, s.role, s.role, true, true
  from (values (11, 1, 'doctor'), (12, 1, 'clinician'), (13, 1, 'nurse'), (14, 1, 'lab'), (15, 1, 'pharmacist'),
               (16, 1, 'receptionist'), (17, 1, 'org_admin'), (21, 2, 'lab'), (26, 3, 'doctor')) s(n, org, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e4c11000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c21000-0000-4000-8000-00000000000' || s.org)::uuid, 'P4c suite governed role'
  from (values (11, 1, 'doctor'), (12, 1, 'clinician'), (13, 1, 'nurse'), (14, 1, 'lab'), (15, 1, 'pharmacist'),
               (16, 1, 'receptionist'), (17, 1, 'org_admin'), (21, 2, 'lab'), (26, 3, 'doctor')) s(n, org, role);
-- DA's licence, attested by GH's administrator (P4b's attestation table).
insert into identity.staff_licence_attestations (organization_id, facility_id, account_id, staff_id, membership_id,
  role_code, role_grant_id, licence_body, licence_number, attested_person_name, verification_method,
  attested_by_account_id, attested_by_membership_id, attestation_version, attested_at, correlation_id)
values ('e4c20000-0000-4000-8000-000000000001', 'e4c21000-0000-4000-8000-000000000001',
  'e4c10000-0000-4000-8000-000000000011', 'e4c12000-0000-4000-8000-000000000011',
  'e4c13000-0000-4000-8000-000000000011', 'doctor', 'e4c11000-0000-4000-8000-000000000011', 'MDCN', 'MDCN/45678',
  'Ada Doctor', 'facility_attestation', 'e4c10000-0000-4000-8000-000000000017', 'e4c13000-0000-4000-8000-000000000017',
  'facility-staff-attestation-v1', clock_timestamp(), 'p4c-fixture-licence');

-- Patients: P and Q with active accounts and a live patient session, N
-- without an account.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e4c10000-0000-4000-8000-000000000041', 'synthetic:p4c:patient-p', 'patient-p@p4c.invalid', 'Patience Okafor', 'active'),
  ('e4c10000-0000-4000-8000-000000000042', 'synthetic:p4c:patient-q', 'patient-q@p4c.invalid', 'Quadri Bello', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e4c30000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000041', 'HID-P4CPATP',
   'Patience', 'Okafor', 'Patience Okafor', 'female', '1990-04-12', 'active'),
  ('e4c30000-0000-4000-8000-000000000002', 'e4c10000-0000-4000-8000-000000000042', 'HID-P4CPATQ',
   'Quadri', 'Bello', 'Quadri Bello', 'male', '1985-09-30', 'active'),
  ('e4c30000-0000-4000-8000-000000000003', null, 'HID-P4CPATN', 'Nkem', 'Eze', 'Nkem Eze', 'female', null, 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('e4c31000-0000-4000-8000-00000000000' || n)::uuid, ('e4c10000-0000-4000-8000-00000000004' || n)::uuid,
  ('e4c31000-0000-4000-8000-00000000000' || n)::uuid, md5('p4c-session-' || n) || md5('p4c-session-' || n),
  gen_random_uuid(), 1, 'password', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '2 hours', 'patient', ('e4c30000-0000-4000-8000-00000000000' || n)::uuid
  from generate_series(1, 2) n;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), ('e4c30000-0000-4000-8000-00000000000' || p.n)::uuid,
  ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c21000-0000-4000-8000-00000000000' || s.org)::uuid,
  'write_records', 'active', 'P4c suite direct-care consent', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '30 days', false, 'direct-care'
  from (values (11, 1), (12, 1), (13, 1), (14, 1), (15, 1), (16, 1), (26, 3)) s(n, org)
  cross join generate_series(1, 3) p(n)
 where s.n <> 26 or p.n = 1;

-- Self sign-ups through the real commands, then support's review: 1
-- laboratory L1 (lab), 2 pharmacy PH1 (pharmacist).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:p4c:super', true),
  set_config('app.correlation_id', 'p4c-fixture-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'P4c suite opens facility sign-up');
select platform.admin_set_control('cross_facility_orders_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'P4c suite opens orders between facilities');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'p4c-fixture-signup', true),
  set_config('app.purpose_of_use', '', true);
create function pg_temp.p4c_sign_up(n integer, product text, kind text, cac text, admin_name text, admin_email text,
  legal_name text)
returns void language plpgsql as $f$
declare
  application_id uuid;
  current_application record;
  activated record;
  challenge_id uuid := ('e4c40000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
  code_hmac char(64) := encode(sha256(('p4c-otp-' || n)::bytea), 'hex');
  session_hmac char(64) := encode(sha256(('p4c-session-' || n)::bytea), 'hex');
begin
  application_id := identity.submit_self_service_organization_application(product, kind, cac, admin_name,
    admin_email, encode(sha256(('p4c-network-' || n)::bytea), 'hex'));
  select * into current_application from identity.public_get_organization_application(cac, admin_email, product);
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
    'verified', '9944' || n, cac, legal_name, 'Private Company Limited by Shares', '2021-02-0' || (n % 9 + 1),
    n || ' Sign-up Street, Yaba, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment(cac, admin_email, product, challenge_id, code_hmac,
    admin_name, kind);
  if not identity.verify_organization_profile_completion_challenge(challenge_id, code_hmac, session_hmac) then
    raise exception 'P4c sign-up % was not verified', n;
  end if;
  select * into activated from identity.activate_self_service_provider_enrollment(session_hmac,
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform set_config('hid.test.app_' || n, application_id::text, true);
  perform set_config('hid.test.facility_' || n, activated.facility_id::text, true);
  perform set_config('hid.test.account_' || n, activated.account_id::text, true);
  perform set_config('hid.test.org_' || n, activated.organization_id::text, true);
end
$f$;
reset role;
grant execute on function pg_temp.p4c_sign_up(integer,text,text,text,text,text,text) to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select pg_temp.p4c_sign_up(1, 'laboratory', 'laboratory', 'RC9945001', 'Kemi Lab Admin', 'kemi@p4c-lab.invalid',
  'P4c Sign-up Laboratory Ltd');
select pg_temp.p4c_sign_up(2, 'pharmacy', 'pharmacy', 'RC9945002', 'Lanre Pharmacy Admin',
  'lanre@p4c-pharmacy.invalid', 'P4c Sign-up Pharmacy Ltd');
select set_config('app.actor_subject', 'synthetic:p4c:super', true),
  set_config('app.correlation_id', 'p4c-fixture-review', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select identity.admin_review_self_service_facility(current_setting('hid.test.app_1')::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('unreviewed') application
    where application.application_id = current_setting('hid.test.app_1')::uuid),
  'Reached the laboratory on its CAC contact number', 'lab', 'cac_registered_contact', 'MLSCN', 'MLS/10001');
select identity.admin_review_self_service_facility(current_setting('hid.test.app_2')::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('unreviewed') application
    where application.application_id = current_setting('hid.test.app_2')::uuid),
  'Reached the pharmacy on its CAC contact number', 'pharmacist', 'cac_registered_contact', 'PCN', 'PCN/20002');
reset role;
select set_config('hid.test.membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.account_' || n)::uuid), true),
  set_config('hid.test.subject_' || n,
  (select account.subject from auth.accounts account where account.id = current_setting('hid.test.account_' || n)::uuid),
  true)
  from generate_series(1, 2) n;

-- L1's second lab member LB2 (31) and receptionist RB (32); PH1's second
-- pharmacist PB2 (33). No consent grants at L1 or PH1.
insert into auth.accounts (id, subject, email, display_name, status)
select ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:p4c:' || s.code,
  s.code || '@p4c-staff.invalid', s.full_name, 'active'
  from (values (31, 'lb2', 'Musa Second Lab'), (32, 'rb', 'Ngozi Lab Reception'), (33, 'pb2', 'Ola Second Pharmacist'))
       s(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@p4c-staff.invalid', 'verified', s.role
  from (values (31, 'lb2', 'Musa Second Lab', 'lab'), (32, 'rb', 'Ngozi Lab Reception', 'receptionist'),
               (33, 'pb2', 'Ola Second Pharmacist', 'pharmacist')) s(n, code, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, current_setting('hid.test.org_' || s.site)::uuid,
  current_setting('hid.test.facility_' || s.site)::uuid, s.role, s.role, true, true
  from (values (31, 1, 'lab'), (32, 1, 'receptionist'), (33, 2, 'pharmacist')) s(n, site, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e4c11000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid,
  current_setting('hid.test.facility_' || s.site)::uuid, 'P4c suite invited role'
  from (values (31, 1, 'lab'), (32, 1, 'receptionist'), (33, 2, 'pharmacist')) s(n, site, role);

-- Encounters at GH for P, Q and N, written by DA through the EHR runtime.
set local role hid_ehr_api_runtime;
select set_config('app.actor_subject', 'synthetic:p4c:da', true),
  set_config('app.membership_id', 'e4c13000-0000-4000-8000-000000000011', true),
  set_config('app.facility_id', 'e4c21000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'p4c-fixture-ehr', true),
  set_config('app.purpose_of_use', 'direct-care', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e4c50000-0000-4000-8000-00000000000' || n)::uuid, ('e4c30000-0000-4000-8000-00000000000' || n)::uuid,
  'e4c21000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000011',
  'e4c13000-0000-4000-8000-000000000011', 'ambulatory', 'in_progress', clock_timestamp()
  from generate_series(1, 3) n;
reset role;

-- Session helpers.
create function pg_temp.as_staff(member integer, facility uuid, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:p4c:' || case member when 11 then 'da' when 12 then 'ca'
      when 13 then 'na' when 14 then 'la' when 15 then 'pa' when 16 then 'ra' when 17 then 'ga' when 21 then 'glm'
      when 26 then 'd3' when 31 then 'lb2' when 32 then 'rb' when 33 then 'pb2' when 18 then 'dr' when 19 then 'dx'
      when 22 then 'gpm' when 23 then 'gl2a' when 24 then 'gl3' when 25 then 'llm' when 27 then 'gl2b'
      else 'unknown' end, true),
    set_config('app.membership_id', 'e4c13000-0000-4000-8000-0000000000' || member, true),
    set_config('hid.test.actor_account', 'e4c10000-0000-4000-8000-0000000000' || member, true),
    set_config('app.facility_id', facility::text, true),
    set_config('app.correlation_id', 'p4c-suite-' || member || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.as_signup_admin(n integer, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', current_setting('hid.test.subject_' || n), true),
    set_config('app.membership_id', current_setting('hid.test.membership_' || n), true),
    set_config('hid.test.actor_account', current_setting('hid.test.account_' || n), true),
    set_config('app.facility_id', current_setting('hid.test.facility_' || n), true),
    set_config('app.correlation_id', 'p4c-suite-admin-' || n || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.as_platform(admin integer)
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:p4c:' || case admin when 1 then 'super' when 2 then 'support'
      when 3 then 'reviewer' when 4 then 'auditor' else 'unknown' end, true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'p4c-suite-platform-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', 'healthcare-operations', true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.as_patient(n integer)
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:p4c:patient-' || case n when 1 then 'p' else 'q' end, true),
    set_config('app.account_id', 'e4c10000-0000-4000-8000-00000000004' || n, true),
    set_config('app.session_id', 'e4c31000-0000-4000-8000-00000000000' || n, true),
    set_config('app.patient_id', 'e4c30000-0000-4000-8000-00000000000' || n, true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '5 minutes')::text, true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'p4c-suite-patient-' || n || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', 'patient-self', true);
$f$;
-- A lab request or prescription by DA for patient n (1 P, 2 Q, 3 N), in the
-- given status, through the EHR runtime; answers its id.
create function pg_temp.lab_request(n integer, request_status text, clinical text default 'Fever for three days')
returns uuid language plpgsql as $f$
declare created uuid := gen_random_uuid();
begin
  perform pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
  insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
  values (created, ('e4c50000-0000-4000-8000-00000000000' || n)::uuid, ('e4c30000-0000-4000-8000-00000000000' || n)::uuid,
    'e4c21000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000011',
    'e4c13000-0000-4000-8000-000000000011', 'http://loinc.org', '718-7', 'Haemoglobin', 'urgent', request_status,
    'whole-blood', clinical);
  return created;
end
$f$;
create function pg_temp.prescription(n integer, prescription_status text)
returns uuid language plpgsql as $f$
declare created uuid := gen_random_uuid();
begin
  perform pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
  insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, status)
  values (created, ('e4c50000-0000-4000-8000-00000000000' || n)::uuid, ('e4c30000-0000-4000-8000-00000000000' || n)::uuid,
    'e4c21000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000011',
    'e4c13000-0000-4000-8000-000000000011', 'urn:p4c:medication', 'amoxicillin-500', 'Amoxicillin 500 mg', 1,
    'capsule', 'oral', 'Every 8 hours', 'Take after food for seven days', current_date, prescription_status);
  return created;
end
$f$;
-- Send an order (kind, order, receiving facility) as member m: answers the route id.
create function pg_temp.send(m integer, kind text, order_id uuid, receiving uuid, key text,
  attestation text default null)
returns uuid language plpgsql as $f$
declare
  source_row record;
  sent record;
begin
  perform pg_temp.as_staff(m, 'e4c21000-0000-4000-8000-000000000001');
  if kind = 'lab_request' then
    select source_order.patient_id, source_order.encounter_id, source_order.row_version into source_row
      from ehr.lab_requests source_order where source_order.id = order_id;
  else
    select source_order.patient_id, source_order.encounter_id, source_order.row_version into source_row
      from ehr.prescriptions source_order where source_order.id = order_id;
  end if;
  select * into sent from ehr.send_order_route(gen_random_uuid(), kind, source_row.patient_id, order_id,
    source_row.encounter_id, source_row.row_version, receiving,
    coalesce(attestation, case kind when 'lab_request' then 'order-route-lab-attestation-v1'
                                   else 'order-route-prescription-attestation-v1' end),
    key, encode(sha256(key::bytea), 'hex'));
  return sent.route_id;
end
$f$;
-- The SQLSTATE and message of a statement, or 'ok'.
create function pg_temp.outcome(statement text)
returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;
-- Owner SQL: a received, completed execution with a verified result
-- version for a route-backed Lab work item at L1 (entered by LB2, verified by
-- LB1; triggers and keys off), as the Lab's own commands leave it. Answers
-- the result id; its execution and verification are set as hid.test.<label>_*.
create function pg_temp.lab_chain(work_item uuid, label text, numeric_value numeric)
returns uuid language plpgsql as $f$
declare
  item lab.work_items%rowtype;
  test_id uuid;
  accession_id uuid := gen_random_uuid();
  requirement_id uuid := gen_random_uuid();
  specimen_id uuid := gen_random_uuid();
  execution_id uuid := gen_random_uuid();
  result_id uuid := gen_random_uuid();
  verification_id uuid := gen_random_uuid();
begin
  select * into item from lab.work_items where id = work_item;
  select test.id into test_id from lab.work_item_requested_tests test where test.work_item_id = work_item;
  set local session_replication_role = replica;
  insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
    idempotency_key, request_sha256, correlation_id)
  values (accession_id, work_item, item.patient_id, item.facility_id, item.priority,
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', 'p4c-chain-acc-' || label || '-000',
    repeat('a', 64), 'p4c-chain');
  insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
  values (requirement_id, accession_id, item.patient_id, item.facility_id, 1, 'whole blood');
  insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
    collected_at, collected_by, collected_by_membership_id, received_at, received_by, received_by_membership_id,
    row_version)
  values (specimen_id, requirement_id, accession_id, item.patient_id, item.facility_id, 'whole blood', 'received',
    clock_timestamp(), 'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', clock_timestamp(),
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', 3);
  insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
    started_by, started_by_membership_id, started_at, completed_by, completed_by_membership_id, completed_at,
    idempotency_key, request_sha256, correlation_id, row_version)
  values (execution_id, accession_id, specimen_id, test_id, item.patient_id, item.facility_id, 'completed',
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', clock_timestamp(),
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', clock_timestamp(),
    'p4c-chain-exe-' || label || '-000', repeat('a', 64), 'p4c-chain', 2);
  insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id)
  values (result_id, execution_id, item.patient_id, item.facility_id, 'e4c10000-0000-4000-8000-000000000031',
    'e4c13000-0000-4000-8000-000000000031');
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, idempotency_key,
    request_sha256, correlation_id, revision_kind)
  values (result_id, execution_id, item.patient_id, item.facility_id, 1, 'numeric', numeric_value, 'g/dL', '12.0-15.5',
    case when numeric_value < 12 then 'low' else 'normal' end, 'e4c10000-0000-4000-8000-000000000031',
    'e4c13000-0000-4000-8000-000000000031', 'p4c-chain-rev-' || label || '-001', repeat('a', 64), 'p4c-chain',
    'original');
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, result_id, execution_id, item.patient_id, item.facility_id, 1,
    item.accepted_by, item.accepted_by_membership_id, clock_timestamp(), 'Verified by the second scientist',
    'p4c-chain-ver-' || label || '-001', repeat('a', 64), 'p4c-chain');
  set local session_replication_role = origin;
  perform set_config('hid.test.' || label || '_execution', execution_id::text, true);
  perform set_config('hid.test.' || label || '_verification_1', verification_id::text, true);
  return result_id;
end
$f$;
-- Owner SQL: a corrected version (2) of a result, verified (triggers off).
create function pg_temp.lab_correction(result_id uuid, label text, numeric_value numeric, verifier uuid,
  verifier_membership uuid)
returns uuid language plpgsql as $f$
declare
  head lab.results%rowtype;
  verification_id uuid := gen_random_uuid();
begin
  select * into head from lab.results where id = result_id;
  set local session_replication_role = replica;
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, correction_reason,
    idempotency_key, request_sha256, correlation_id, revision_kind, supersedes_version)
  values (result_id, head.execution_id, head.patient_id, head.facility_id, 2, 'numeric', numeric_value, 'g/dL',
    '12.0-15.5', 'normal', 'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031',
    'Analyser recalibrated', 'p4c-chain-rev-' || label || '-002', repeat('a', 64), 'p4c-chain', 'correction', 1);
  update lab.results set current_version = 2 where id = result_id;
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, result_id, head.execution_id, head.patient_id, head.facility_id, 2, verifier,
    verifier_membership, clock_timestamp(), 'Verified the correction', 'p4c-chain-ver-' || label || '-002',
    repeat('a', 64), 'p4c-chain');
  set local session_replication_role = origin;
  return verification_id;
end
$f$;
-- The Lab's release statement, as the session's member (route access or consent).
create function pg_temp.release(result_id uuid, result_version bigint, verification_id uuid, key text)
returns void language plpgsql as $f$
declare head record;
begin
  select result_row.execution_id, result_row.patient_id, result_row.facility_id into head
    from lab.results result_row where result_row.id = result_id;
  insert into lab.result_releases (verification_id, result_id, execution_id, patient_id, facility_id, result_version,
    released_by, released_by_membership_id, released_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, result_id, head.execution_id, head.patient_id, head.facility_id, result_version,
    current_setting('hid.test.actor_account')::uuid, current_setting('app.membership_id')::uuid, clock_timestamp(),
    'Released to the requester',
    key, repeat('b', 64), current_setting('app.correlation_id'));
end
$f$;
-- The Pharmacy's dispensing statement, as the session's member.
create function pg_temp.dispense(work_item uuid, key text)
returns uuid language plpgsql as $f$
declare item record; created uuid := gen_random_uuid();
begin
  select candidate.patient_id, candidate.facility_id, candidate.medication_code_system, candidate.medication_code,
         candidate.medication_display into item
    from pharmacy.work_items candidate where candidate.id = work_item;
  insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id, medication_code_system,
    medication_code, medication_display, quantity_dispensed, quantity_unit, dispensed_by, dispensed_by_membership_id,
    reason, idempotency_key, request_sha256, correlation_id)
  values (created, work_item, 1, item.patient_id, item.facility_id, item.medication_code_system, item.medication_code,
    item.medication_display, 21, 'capsule', current_setting('hid.test.actor_account')::uuid,
    current_setting('app.membership_id')::uuid,
    'Dispensed the full course', key, repeat('c', 64), current_setting('app.correlation_id'));
  return created;
end
$f$;

-- Recorded checks: each statement's outcome ('ok' or SQLSTATE and message)
-- against the expected one; pg_temp.report() fails the suite listing every
-- difference.
create temp table p4c_checks (n serial primary key, label text not null, expected text not null, actual text not null);
create function pg_temp.check(label text, statement text, expected text)
returns void language plpgsql as $f$
begin
  insert into p4c_checks (label, expected, actual) values (label, expected, pg_temp.outcome(statement));
end
$f$;
create function pg_temp.assert(label text, condition boolean, detail text default null)
returns void language plpgsql as $f$
begin
  insert into p4c_checks (label, expected, actual)
  values (label, 'true', coalesce(condition::text, 'null')
    || case when condition then '' else coalesce(' (' || detail || ')', '') end);
end
$f$;
create function pg_temp.report()
returns void language plpgsql as $f$
declare failures text; total integer;
begin
  select count(*) into total from p4c_checks;
  select string_agg(format('%s: expected %s, got %s', c.label, c.expected, c.actual), E'\n' order by c.n)
    into failures from p4c_checks c where c.actual <> c.expected;
  if failures is not null then
    raise exception E'P4c checks failed:\n%', failures;
  end if;
  raise notice 'P4c checks passed: %', total;
end
$f$;
grant select, insert on p4c_checks to hid_ehr_api_runtime, hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_schema_test_runtime;
grant usage on sequence p4c_checks_n_seq to hid_ehr_api_runtime, hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_schema_test_runtime;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;

-- Item 3's members: LB3 (34) lab at L1 holding P's direct-care write consent
-- there; LR (35) at L1 and PR (36) at PH1 holding only the kind's receive
-- permission (synthetic roles: they may not mark results in error or reverse
-- a dispensing).
insert into auth.roles (code, description) values
  ('p4c_lab_receiver_only', 'P4c suite: receives lab requests, cannot mark results in error'),
  ('p4c_rx_receiver_only', 'P4c suite: receives prescriptions, cannot reverse dispensings');
insert into auth.role_permissions (role_code, permission_code) values
  ('p4c_lab_receiver_only', 'lab.order-route.receive'),
  ('p4c_rx_receiver_only', 'pharmacy.order-route.receive');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:p4c:' || s.code,
  s.code || '@p4c-staff.invalid', s.full_name, 'active'
  from (values (34, 'lb3', 'Pelumi Third Lab'), (35, 'lr', 'Remi Lab Receiver'), (36, 'pr', 'Sade Rx Receiver'))
       s(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@p4c-staff.invalid', 'verified', s.role
  from (values (34, 'lb3', 'Pelumi Third Lab', 'lab'), (35, 'lr', 'Remi Lab Receiver', 'lab'),
               (36, 'pr', 'Sade Rx Receiver', 'pharmacist')) s(n, code, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, current_setting('hid.test.org_' || s.site)::uuid,
  current_setting('hid.test.facility_' || s.site)::uuid, s.role, s.role, true, true
  from (values (34, 1, 'lab'), (35, 1, 'lab'), (36, 2, 'pharmacist')) s(n, site, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e4c11000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid,
  current_setting('hid.test.facility_' || s.site)::uuid, 'P4c suite item 3 role'
  from (values (34, 1, 'lab'), (35, 1, 'p4c_lab_receiver_only'), (36, 2, 'p4c_rx_receiver_only')) s(n, site, role);
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
values (gen_random_uuid(), 'e4c30000-0000-4000-8000-000000000001', 'e4c12000-0000-4000-8000-000000000034',
  'e4c10000-0000-4000-8000-000000000034', 'e4c13000-0000-4000-8000-000000000034',
  current_setting('hid.test.facility_1')::uuid, 'write_records', 'active', 'P4c suite consent at the laboratory',
  clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', false, 'direct-care');

create function pg_temp.as_extra(member integer, facility uuid, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:p4c:' || case member when 34 then 'lb3' when 35 then 'lr'
      when 36 then 'pr' else 'unknown' end, true),
    set_config('app.membership_id', 'e4c13000-0000-4000-8000-0000000000' || member, true),
    set_config('hid.test.actor_account', 'e4c10000-0000-4000-8000-0000000000' || member, true),
    set_config('app.facility_id', facility::text, true),
    set_config('app.correlation_id', 'p4c-suite-' || member || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.route(route uuid) returns ehr.order_routes language sql stable as $f$
  select * from ehr.order_routes where id = route
$f$;
create function pg_temp.last_event(route uuid) returns ehr.order_route_events language sql stable as $f$
  select * from ehr.order_route_events event where event.route_id = route order by event.event_version desc limit 1
$f$;
-- Acceptance at L1 by LB1 (with a Health ID, a date of birth, or a date of
-- birth with the route's reference) or at PH1 by PB1; answers the work item.
create function pg_temp.accept_lab(route uuid, how text default 'health_id', reference text default null)
returns uuid language plpgsql as $f$
declare accepted record;
begin
  perform pg_temp.as_signup_admin(1);
  select * into accepted from lab.accept_order_route(route, 1, case how when 'health_id' then 'health_id'
      else 'date_of_birth' end, case how when 'health_id' then 'HID-P4CPATP' else '1990-04-12' end,
    'p4c-wp-accept-' || substr(md5(route::text), 1, 12), repeat('a', 64), reference);
  if accepted.result is distinct from 'accepted' then
    raise exception 'P4c lab acceptance of % answered %', route, accepted.result;
  end if;
  return accepted.work_item_id;
end
$f$;
create function pg_temp.accept_rx(route uuid)
returns uuid language plpgsql as $f$
declare accepted record;
begin
  perform pg_temp.as_signup_admin(2);
  select * into accepted from pharmacy.accept_order_route(route, 1, 'health_id', 'HID-P4CPATP',
    'Patient collected the prescription', 'p4c-wp-accept-' || substr(md5(route::text), 1, 12), repeat('a', 64));
  if accepted.result is distinct from 'accepted' then
    raise exception 'P4c pharmacy acceptance of % answered %', route, accepted.result;
  end if;
  return accepted.work_item_id;
end
$f$;
-- Owner SQL: moves a route's clock back (triggers off), as the lifecycle suite.
create function pg_temp.age_route(route uuid, created_by interval, completed_by interval)
returns void language plpgsql as $f$
begin
  set local session_replication_role = replica;
  update ehr.order_routes set created_at = created_at - created_by, respond_by = respond_by - created_by,
    accepted_at = accepted_at - created_by, completed_at = completed_at - completed_by,
    writes_end_at = writes_end_at - completed_by, access_ends_at = access_ends_at - completed_by
   where id = route;
  set local session_replication_role = origin;
end
$f$;
create function pg_temp.edit_lab(order_id uuid, change text, reason text)
returns void language plpgsql as $f$
begin
  perform pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
  perform set_config('app.change_reason', reason, true);
  if change = 'priority' then
    update ehr.lab_requests set priority = 'stat' where id = order_id;
  else
    update ehr.lab_requests set status = change where id = order_id;
  end if;
end
$f$;
-- The report, as the session's member, through the kind's wrapper.
create function pg_temp.wrong_patient(kind text, route uuid, version bigint, reason text, note text, key text,
  digest text default null)
returns table (result text, report_id uuid, route_row_version bigint, route_state text, effective_state text,
  ended_kind text, results_voided integer, result_reports_marked integer, dispensing_reversed boolean,
  state_before text, patient_id uuid)
language plpgsql as $f$
begin
  if kind = 'lab_request' then
    return query select * from lab.report_wrong_patient_order_route(route, version, reason, note, key,
      coalesce(digest, encode(sha256(key::bytea), 'hex')));
  else
    return query select * from pharmacy.report_wrong_patient_order_route(route, version, reason, note, key,
      coalesce(digest, encode(sha256(key::bytea), 'hex')));
  end if;
end
$f$;
-- The same, keeping the answer under a label.
create temp table p4c_answers (label text primary key, answer jsonb not null);
create function pg_temp.keep(label text, kind text, route uuid, version bigint, reason text, note text, key text,
  digest text default null)
returns text language plpgsql as $f$
declare answer record;
begin
  select * into answer from pg_temp.wrong_patient(kind, route, version, reason, note, key, digest);
  insert into p4c_answers (label, answer) values (label, to_jsonb(answer));
  return answer.result;
end
$f$;
create function pg_temp.answer(label text) returns jsonb language sql stable as $f$
  select answer.answer from p4c_answers answer where answer.label = $1
$f$;
-- The routes' versions, read as the owner before the runtime acts.
create temp table p4c_versions (route_id uuid primary key, row_version bigint not null);
create function pg_temp.snap() returns void language sql as $f$
  delete from p4c_versions;
  insert into p4c_versions select route.id, route.row_version from ehr.order_routes route;
$f$;
create function pg_temp.v(route uuid) returns bigint language sql stable as $f$
  select version.row_version from p4c_versions version where version.route_id = route
$f$;
-- Everything a report may write, counted as the owner.
create function pg_temp.footprint() returns text language sql stable as $f$
  select concat_ws(',', (select sum(route.row_version) from ehr.order_routes route),
    (select count(*) from ehr.order_route_events), (select count(*) from ehr.order_route_wrong_patient_reports),
    (select count(*) from lab.result_invalidations), (select count(*) from lab.order_route_result_reports),
    (select count(*) from pharmacy.dispensing_reversals), (select count(*) from pharmacy.order_route_dispensing_reports),
    (select count(*) from lab.outbox_events), (select count(*) from pharmacy.outbox_events),
    (select count(*) from audit.events), (select count(*) from notification.inbox_items),
    (select count(*) from ehr.order_route_accept_attempts))
$f$;
-- Owner SQL: an accession, one collected specimen, and for every requested
-- test of the work item an execution and a result whose version 1 LB2 entered
-- (unverified; triggers off). Answers how many results; sets
-- hid.test.<label>_result_<ordinal> and hid.test.<label>_specimen.
create function pg_temp.lab_entry(work_item uuid, label text, numeric_value numeric)
returns integer language plpgsql as $f$
declare
  item lab.work_items%rowtype;
  test_row record;
  accession_id uuid := gen_random_uuid();
  requirement_id uuid := gen_random_uuid();
  specimen_id uuid := gen_random_uuid();
  execution_id uuid;
  result_id uuid;
  made integer := 0;
begin
  select * into item from lab.work_items where id = work_item;
  set local session_replication_role = replica;
  insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
    idempotency_key, request_sha256, correlation_id)
  values (accession_id, work_item, item.patient_id, item.facility_id, item.priority,
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', 'p4c-wp-acc-' || label || '-000',
    repeat('a', 64), 'p4c-chain');
  insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
  values (requirement_id, accession_id, item.patient_id, item.facility_id, 1, 'whole blood');
  insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
    collected_at, collected_by, collected_by_membership_id, received_at, received_by, received_by_membership_id,
    row_version)
  values (specimen_id, requirement_id, accession_id, item.patient_id, item.facility_id, 'whole blood', 'received',
    clock_timestamp(), 'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', clock_timestamp(),
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', 3);
  for test_row in select test.id, test."ordinal" from lab.work_item_requested_tests test
                   where test.work_item_id = work_item order by test."ordinal" loop
    execution_id := gen_random_uuid();
    result_id := gen_random_uuid();
    insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
      started_by, started_by_membership_id, started_at, completed_by, completed_by_membership_id, completed_at,
      idempotency_key, request_sha256, correlation_id, row_version)
    values (execution_id, accession_id, specimen_id, test_row.id, item.patient_id, item.facility_id, 'completed',
      'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', clock_timestamp(),
      'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', clock_timestamp(),
      'p4c-wp-exe-' || label || '-00' || test_row.ordinal, repeat('a', 64), 'p4c-chain', 2);
    insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id)
    values (result_id, execution_id, item.patient_id, item.facility_id, 'e4c10000-0000-4000-8000-000000000031',
      'e4c13000-0000-4000-8000-000000000031');
    insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
      numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, idempotency_key,
      request_sha256, correlation_id, revision_kind)
    values (result_id, execution_id, item.patient_id, item.facility_id, 1, 'numeric', numeric_value, 'g/dL',
      '12.0-15.5', 'normal', 'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031',
      'p4c-wp-rev-' || label || '-00' || test_row.ordinal, repeat('a', 64), 'p4c-chain', 'original');
    perform set_config('hid.test.' || label || '_result_' || test_row.ordinal, result_id::text, true);
    made := made + 1;
  end loop;
  set local session_replication_role = origin;
  perform set_config('hid.test.' || label || '_specimen', specimen_id::text, true);
  return made;
end
$f$;
-- Owner SQL: a second requested test on a work item (triggers off).
create function pg_temp.add_requested_test(work_item uuid)
returns void language plpgsql as $f$
declare item lab.work_items%rowtype;
begin
  select * into item from lab.work_items where id = work_item;
  set local session_replication_role = replica;
  insert into lab.work_item_requested_tests (work_item_id, facility_id, patient_id, "ordinal", code_system, code, name)
  values (work_item, item.facility_id, item.patient_id, 2, 'http://loinc.org', '6690-2', 'White cell count');
  set local session_replication_role = origin;
end
$f$;
-- Owner SQL: the next version of a result, a correction LB2 entered,
-- optionally verified (triggers off). Answers the verification.
create function pg_temp.lab_next_version(result_id uuid, label text, numeric_value numeric, verifier uuid,
  verifier_membership uuid, verify boolean default true)
returns uuid language plpgsql as $f$
declare
  head lab.results%rowtype;
  next_version bigint;
  verification_id uuid := gen_random_uuid();
begin
  select * into head from lab.results where id = result_id;
  next_version := head.current_version + 1;
  set local session_replication_role = replica;
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, correction_reason,
    idempotency_key, request_sha256, correlation_id, revision_kind, supersedes_version)
  values (result_id, head.execution_id, head.patient_id, head.facility_id, next_version, 'numeric', numeric_value,
    'g/dL', '12.0-15.5', 'normal', 'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031',
    'Analyser recalibrated', 'p4c-wp-rev-' || label || '-v' || next_version, repeat('a', 64), 'p4c-chain',
    'correction', head.current_version);
  update lab.results set current_version = next_version where id = result_id;
  if verify then
    insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
      verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
    values (verification_id, result_id, head.execution_id, head.patient_id, head.facility_id, next_version, verifier,
      verifier_membership, clock_timestamp(), 'Verified the correction', 'p4c-wp-ver-' || label || '-v' || next_version,
      repeat('a', 64), 'p4c-chain');
  end if;
  set local session_replication_role = origin;
  return case when verify then verification_id end;
end
$f$;
-- P's released lab results as Lab answers them to P (0086's
-- patient-results query, read as the owner): the result ids.
create function pg_temp.patient_results() returns uuid[] language sql stable as $f$
  select coalesce(array_agg(r.id order by r.id), array[]::uuid[])
    from lab.results r join lab.result_revisions v on v.result_id = r.id and v.version = r.current_version
    join lab.result_releases rel on rel.result_id = r.id and rel.result_version = r.current_version
    join lab.result_verifications ver on ver.id = rel.verification_id and ver.result_id = r.id
      and ver.result_version = r.current_version
   where r.patient_id = 'e4c30000-0000-4000-8000-000000000001'
     and not exists (select 1 from lab.result_invalidations i where i.result_id = r.id
                      and i.result_version = r.current_version and i.patient_id = r.patient_id)
$f$;
grant select, insert on p4c_answers to hid_ehr_api_runtime, hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_schema_test_runtime;
grant select on p4c_versions to hid_ehr_api_runtime, hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_schema_test_runtime;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;

-- The orders: DA sends lab requests for P (1), for Q (2), for P again (3,
-- aged past 30 days after its report; 4, closed by support; 5, still live)
-- and a prescription for P (rx 1); CA sends a lab request for Q (6). L1
-- accepts the lab routes, PH1 the prescription, which PB2 dispenses.
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_' || v.n, pg_temp.lab_request(v.patient, 'active')::text, true)
  from (values (1, 1), (2, 2), (3, 1), (4, 1), (5, 1), (6, 2)) v(n, patient);
select set_config('hid.test.rx_1', pg_temp.prescription(1, 'active')::text, true);
select set_config('hid.test.lroute_' || v.n, pg_temp.send(v.sender, 'lab_request', current_setting('hid.test.lr_' || v.n)::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-ov-send-lab-' || lpad(v.n::text, 4, '0'))::text, true)
  from (values (1, 11), (2, 11), (3, 11), (4, 11), (5, 11), (6, 12)) v(n, sender);
select set_config('hid.test.rroute_1', pg_temp.send(11, 'prescription', current_setting('hid.test.rx_1')::uuid,
  current_setting('hid.test.facility_2')::uuid, 'p4c-ov-send-rx-0001')::text, true);
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.litem_' || n, pg_temp.accept_lab(current_setting('hid.test.lroute_' || n)::uuid)::text, true)
  from (values (1), (3), (4), (5)) v(n);
reset role;
-- Q's orders, by Q's Health ID.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select set_config('hid.test.litem_2', (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.lroute_2')::uuid, 1, 'health_id', 'HID-P4CPATQ', 'p4c-ov-accept-0002', repeat('a', 64))
  accepted), true);
select set_config('hid.test.litem_6', (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.lroute_6')::uuid, 1, 'health_id', 'HID-P4CPATQ', 'p4c-ov-accept-0006', repeat('a', 64))
  accepted), true);
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('hid.test.ritem_1', pg_temp.accept_rx(current_setting('hid.test.rroute_1')::uuid)::text, true);
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.dispense(current_setting('hid.test.ritem_1')::uuid, 'p4c-ov-dispense-0001');
reset role;
select pg_temp.snap();
-- Reports: LB2 ends lab routes 3, 6, 2, 1 (in that order) and PB2 the
-- prescription route; support (FR) closes lab route 4.
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.keep('r' || n, 'lab_request', current_setting('hid.test.lroute_' || n)::uuid, 2, 'wrong_order_chosen',
  'Picked the wrong row at the counter', 'p4c-ov-report-' || lpad(n::text, 4, '0'))
  from (values (3), (6), (2), (1)) v(n);
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.keep('x1', 'prescription', current_setting('hid.test.rroute_1')::uuid,
  pg_temp.v(current_setting('hid.test.rroute_1')::uuid), 'someone_elses_details',
  'Collected by a person using another patient''s details', 'p4c-ov-report-rx01');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select * from identity.admin_close_order_route(current_setting('hid.test.lroute_4')::uuid, 2,
  'The hospital asked support to close it');
reset role;
-- Lab route 3 ended 31 days ago (owner SQL, triggers off); DA no longer
-- holds a consent for Q at GH (CA still does).
do $$
begin
  set local session_replication_role = replica;
  update ehr.order_routes set ended_at = ended_at - interval '31 days', writes_end_at = writes_end_at - interval '31 days',
    access_ends_at = access_ends_at - interval '31 days', accepted_at = accepted_at - interval '31 days',
    created_at = created_at - interval '31 days', respond_by = respond_by - interval '31 days'
   where id = current_setting('hid.test.lroute_3')::uuid;
  update ehr.order_route_wrong_patient_reports set reported_at = reported_at - interval '31 days',
    accepted_at = accepted_at - interval '31 days'
   where route_id = current_setting('hid.test.lroute_3')::uuid;
  update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(),
    revoked_by = 'e4c10000-0000-4000-8000-000000000011', revoked_reason = 'P4c suite: consent withdrawn'
   where patient_id = 'e4c30000-0000-4000-8000-000000000002' and account_id = 'e4c10000-0000-4000-8000-000000000011';
  set local session_replication_role = origin;
end $$;
select pg_temp.assert('the fixture: the routes'' endings',
  (select array_agg(n || ':' || route.state || ':' || coalesce(route.ended_kind, '-') order by n)
     from generate_series(1, 6) n join ehr.order_routes route on route.id = current_setting('hid.test.lroute_' || n)::uuid)
  = array['1:cancelled:wrong_patient', '2:cancelled:wrong_patient', '3:cancelled:wrong_patient', '4:cancelled:support',
    '5:accepted:-', '6:cancelled:wrong_patient']
  and (pg_temp.route(current_setting('hid.test.rroute_1')::uuid)).ended_kind = 'wrong_patient');
select set_config('hid.test.footprint_before', pg_temp.footprint(), true);
select set_config('hid.test.ref_' || n, (pg_temp.route(current_setting('hid.test.lroute_' || n)::uuid)).reference, true)
  from generate_series(1, 6) n;
select set_config('hid.test.ref_rx', (pg_temp.route(current_setting('hid.test.rroute_1')::uuid)).reference, true);

-- 1 and 2. DA: P's two orders in full (newest first); CA's order for Q and
-- DA's own order for Q (no consent now) as references only.
create temp table ov_answers (reader text primary key, answer jsonb not null);
grant select, insert on ov_answers to hid_ehr_api_runtime;
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
insert into ov_answers select 'da', ehr.list_sent_wrong_patient_order_routes();
select pg_temp.as_staff(12, 'e4c21000-0000-4000-8000-000000000001');
insert into ov_answers select 'ca', ehr.list_sent_wrong_patient_order_routes();
reset role;
select pg_temp.assert('DA''s answer: two full rows, newest first, and two references',
  (select answer -> 'windowDays' = '30'::jsonb
     and (select array_agg(item ->> 'reference') from jsonb_array_elements(answer -> 'items') item)
       = array[current_setting('hid.test.ref_rx'), current_setting('hid.test.ref_1')]
     and answer -> 'others' -> 'count' = '2'::jsonb
     and (select array_agg(reference order by reference) from jsonb_array_elements_text(answer -> 'others' -> 'references')
           reference)
       = (select array_agg(reference order by reference) from (values (current_setting('hid.test.ref_6')),
           (current_setting('hid.test.ref_2'))) v(reference))
   from ov_answers where reader = 'da'),
  (select answer::text from ov_answers where reader = 'da'));
select pg_temp.assert('a full row: exactly the agreed fields',
  (select answer -> 'items' -> 1 from ov_answers where reader = 'da')
  = jsonb_build_object('routeId', current_setting('hid.test.lroute_1')::uuid, 'reference', current_setting('hid.test.ref_1'),
      'kind', 'lab_request',
      'receivingFacility', jsonb_build_object('id', current_setting('hid.test.facility_1')::uuid,
        'name', 'P4c Sign-up Laboratory Ltd'),
      'patient', jsonb_build_object('name', 'Patience Okafor'),
      'endedAt', (pg_temp.route(current_setting('hid.test.lroute_1')::uuid)).ended_at,
      'resultsWithdrawn', 0, 'dispensingReversed', false,
      'link', jsonb_build_object('patientId', 'e4c30000-0000-4000-8000-000000000001',
        'encounterId', 'e4c50000-0000-4000-8000-000000000001', 'kind', 'lab_request',
        'orderId', current_setting('hid.test.lr_1')::uuid)),
  (select (answer -> 'items' -> 1)::text from ov_answers where reader = 'da'));
select pg_temp.assert('the prescription''s row says the dispensing was reversed',
  (select answer -> 'items' -> 0 ->> 'kind' = 'prescription' and answer -> 'items' -> 0 -> 'dispensingReversed' = 'true'::jsonb
     and answer -> 'items' -> 0 -> 'link' ->> 'orderId' = current_setting('hid.test.rx_1')
     and answer -> 'items' -> 0 -> 'receivingFacility' ->> 'name' = 'P4c Sign-up Pharmacy Ltd'
   from ov_answers where reader = 'da'));
select pg_temp.assert('CA''s answer: Q''s order in full, the other three as references',
  (select (select array_agg(item ->> 'reference') from jsonb_array_elements(answer -> 'items') item)
       = array[current_setting('hid.test.ref_6')]
     and answer -> 'items' -> 0 -> 'patient' ->> 'name' = 'Quadri Bello'
     and answer -> 'others' -> 'count' = '3'::jsonb
     and (select array_agg(reference order by reference) from jsonb_array_elements_text(answer -> 'others' -> 'references')
           reference)
       = (select array_agg(reference order by reference) from (values (current_setting('hid.test.ref_1')),
           (current_setting('hid.test.ref_2')), (current_setting('hid.test.ref_rx'))) v(reference))
   from ov_answers where reader = 'ca'),
  (select answer::text from ov_answers where reader = 'ca'));
select pg_temp.assert('no reference-only part carries a name; the colleague''s patient never appears in full',
  not exists (select 1 from ov_answers where (answer -> 'others')::text ~* '(Patience|Quadri|Nkem|Okafor|Bello|Eze)')
  and not exists (select 1 from ov_answers where reader = 'da' and answer::text ~* '(Quadri|Bello)')
  and not exists (select 1 from ov_answers where reader = 'ca' and answer::text ~* '(Patience|Okafor)'));
select pg_temp.assert('4. not listed: the order that ended 31 days ago, the one support closed, the live one',
  not exists (select 1 from ov_answers where answer::text like '%' || current_setting('hid.test.ref_3') || '%'
                 or answer::text like '%' || current_setting('hid.test.ref_4') || '%'
                 or answer::text like '%' || current_setting('hid.test.ref_5') || '%'));

-- 3. Nothing for a member without ehr.order-route.send, or at another
-- facility.
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(13, 'e4c21000-0000-4000-8000-000000000001');
insert into ov_answers select 'na', ehr.list_sent_wrong_patient_order_routes();
select pg_temp.as_staff(14, 'e4c21000-0000-4000-8000-000000000001');
insert into ov_answers select 'la', ehr.list_sent_wrong_patient_order_routes();
select pg_temp.as_staff(17, 'e4c21000-0000-4000-8000-000000000001');
insert into ov_answers select 'ga', ehr.list_sent_wrong_patient_order_routes();
select pg_temp.as_staff(26, 'e4c21000-0000-4000-8000-000000000003');
insert into ov_answers select 'd3', ehr.list_sent_wrong_patient_order_routes();
reset role;
select pg_temp.assert('a nurse, a laboratory scientist, an administrator and another facility''s doctor see nothing',
  (select array_agg(reader order by reader) from ov_answers
    where answer = jsonb_build_object('windowDays', 30, 'items', '[]'::jsonb,
      'others', jsonb_build_object('count', 0, 'references', '[]'::jsonb)))
  = array['d3', 'ga', 'la', 'na']);

-- 5. The session binding.
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001', 'emergency');
select pg_temp.check('the emergency purpose', $s$select ehr.list_sent_wrong_patient_order_routes()$s$,
  '42501 Order route staff context is required');
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000003');
select pg_temp.check('DA claiming another facility', $s$select ehr.list_sent_wrong_patient_order_routes()$s$,
  '42501 Order route staff context is required');
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select set_config('app.membership_id', '', true);
select pg_temp.check('no membership', $s$select ehr.list_sent_wrong_patient_order_routes()$s$,
  '42501 Order route staff context is required');
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select set_config('app.correlation_id', '', true);
select pg_temp.check('no correlation ID', $s$select ehr.list_sent_wrong_patient_order_routes()$s$,
  '42501 Order route staff context is required');
reset role;
-- A deactivated membership no longer reads.
update identity.staff_facility_memberships set active = false where id = 'e4c13000-0000-4000-8000-000000000012';
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(12, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('CA after the membership ended', $s$select ehr.list_sent_wrong_patient_order_routes()$s$,
  '42501 Order route staff context is required');
reset role;
select pg_temp.assert('the reads wrote nothing', pg_temp.footprint() = current_setting('hid.test.footprint_before'));
select pg_temp.assert('only the EHR runtime and the schema test runtime may read it',
  has_function_privilege('hid_ehr_api_runtime', 'ehr.list_sent_wrong_patient_order_routes()', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.list_sent_wrong_patient_order_routes()', 'EXECUTE')
  and not has_function_privilege('hid_pharmacy_api_runtime', 'ehr.list_sent_wrong_patient_order_routes()', 'EXECUTE')
  and not has_function_privilege('hid_identity_api_runtime', 'ehr.list_sent_wrong_patient_order_routes()', 'EXECUTE')
  and not has_function_privilege('public', 'ehr.list_sent_wrong_patient_order_routes()', 'EXECUTE'));

select pg_temp.report();
rollback;
