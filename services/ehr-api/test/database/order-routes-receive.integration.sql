-- Receiving an order from another facility (0086 section 6, P4c).
-- Rollback-only. The Lab's and Pharmacy's commands run as
-- hid_lab_api_runtime and hid_pharmacy_api_runtime in the context their
-- services set; owner SQL is marked.
--   1. Incoming (C7, C13) as soon as the send commits (here, in the same
--      transaction): no patient, no clinical information or instructions, no
--      licence number, no source ids; metadata only with orders off; the
--      Health ID filter; recent;
--   2. acceptance (C9, C15): a date-of-birth mismatch counts (attempts
--      left), a Health ID match accepts and creates the work item bound to
--      the route, with the patient card; five mismatches lock the route (A's
--      row with the patient, the patient's ORDER_ROUTE_ACCEPT_LOCKED); 20
--      mismatches a day stop the member; no birth date on record; a second
--      accept; after withdrawal and after expiry; the ordering facility
--      suspended; each control off; replay and a reused key; the pharmacy's
--      reason;
--   3. decline (C10, C16);
--   4. route access: a second member without consent works the route-backed
--      item; a non-route row of the same patient at B stays hidden from the
--      work list; the ordering doctor and a third facility see nothing; the
--      route-access control off hides route-backed rows; the resource check
--      (C11, C17) and the cards (C12, C18);
--   5. a pending laboratory (P6.5): a route an owner inserted reaches nothing;
--   6. the residual of SPEC 4.3, stated.
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
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(1, 8) n;
select set_config('hid.test.lq_1', pg_temp.lab_request(2, 'active')::text, true);
select set_config('hid.test.lq_2', pg_temp.lab_request(2, 'active')::text, true);
select set_config('hid.test.rx_' || n, pg_temp.prescription(1, 'active')::text, true) from generate_series(1, 2) n;
select set_config('hid.test.route_' || n, pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_' || n)::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-receive-send-' || lpad(n::text, 4, '0'))::text, true)
  from generate_series(1, 8) n;
select set_config('hid.test.route_q', pg_temp.send(11, 'lab_request', current_setting('hid.test.lq_1')::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-receive-send-q001')::text, true);
select set_config('hid.test.rxroute_' || n, pg_temp.send(11, 'prescription', current_setting('hid.test.rx_' || n)::uuid,
  current_setting('hid.test.facility_2')::uuid, 'p4c-receive-rx-' || lpad(n::text, 6, '0'))::text, true)
  from generate_series(1, 2) n;
reset role;

-- 1. Incoming.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('Incoming lists the nine sent routes, oldest first',
  (select array_agg(incoming.route_id order by incoming.sent_at) from lab.list_order_routes('incoming', null) incoming)
  = (select array_agg(current_setting('hid.test.route_' || n)::uuid order by n) from generate_series(1, 8) n)
    || current_setting('hid.test.route_q')::uuid);
select pg_temp.assert('Incoming preview has the test and orderer, never the patient or free text',
  (select bool_and(incoming.view_level = 'preview' and incoming.test_name = 'Haemoglobin'
       and incoming.priority = 'urgent' and incoming.orderer_name = 'Ada Doctor' and incoming.orderer_licence_body = 'MDCN'
       and incoming.ordering_facility_name = 'P4c General Hospital' and incoming.attempts_left = 5
       and not incoming.accept_locked and incoming.work_item_id is null)
     from lab.list_order_routes('incoming', null) incoming));
select pg_temp.assert('Incoming answers no patient, clinical information, licence number or source id column',
  not exists (select 1 from pg_proc proc, unnest(proc.proargnames) argument_name
               where proc.oid = 'lab.list_order_routes(text,text)'::regprocedure
                 and (argument_name like '%patient%' or argument_name like '%clinical%' or argument_name like '%source%'
                   or argument_name like '%licence_number%' or argument_name like '%instructions%'
                   or argument_name like '%encounter%')));
select pg_temp.assert('the Health ID filter', (select array_agg(incoming.route_id)
    from lab.list_order_routes('incoming', ' hid-p4cpatq ') incoming) = array[current_setting('hid.test.route_q')::uuid]
  and (select count(*) from lab.list_order_routes('incoming', 'HID-ZZZZZZZZ')) = 0);
select pg_temp.check('a malformed Health ID', $s$select * from lab.list_order_routes('incoming', 'HID-01')$s$,
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('an unknown view', $s$select * from lab.list_order_routes('all', null)$s$, '22023 ORDER_ROUTE_INVALID');
select pg_temp.assert('get before acceptance: preview only', (select got.view_level = 'preview'
    and got.clinical_information is null and got.orderer_licence_number is null and got.patient_full_name is null
    and got.test_name = 'Haemoglobin' and got.work_item_id is null
  from lab.get_order_route(current_setting('hid.test.route_1')::uuid) got));
select pg_temp.check('get a route of another facility', format($s$select * from lab.get_order_route(%L)$s$,
  current_setting('hid.test.rxroute_1')), 'P0002 ORDER_ROUTE_NOT_FOUND');
select pg_temp.as_staff(32, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('Incoming as a receptionist', $s$select * from lab.list_order_routes('incoming', null)$s$,
  '42501 ORDER_ROUTE_PERMISSION_DENIED');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_signup_admin(2);
select pg_temp.assert('pharmacy Incoming preview without instructions', (select bool_and(incoming.view_level = 'preview'
    and incoming.medication_display = 'Amoxicillin 500 mg' and incoming.frequency = 'Every 8 hours'
    and incoming.dose_quantity = 1 and incoming.route_code = 'oral')
    and count(*) = 2 from pharmacy.list_order_routes('incoming', null) incoming));
select pg_temp.assert('pharmacy get before acceptance has no instructions', (select got.instructions is null
    and got.medication_display = 'Amoxicillin 500 mg' from pharmacy.get_order_route(current_setting('hid.test.rxroute_1')::uuid) got));
reset role;
-- Orders off: Incoming shows metadata only.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_orders_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'P4c receive suite pauses orders');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('orders off: Incoming is metadata only', (select bool_and(incoming.view_level = 'metadata'
    and incoming.test_name is null and incoming.orderer_name is null and incoming.priority is null
    and incoming.reference is not null and incoming.ordering_facility_name is not null and incoming.sent_at is not null)
  from lab.list_order_routes('incoming', null) incoming));
select pg_temp.check('orders off: accept', format($s$select * from lab.accept_order_route(%L, 1, 'health_id', 'HID-P4CPATP',
  'p4c-receive-closed-0001', %L)$s$, current_setting('hid.test.route_1'), repeat('a', 64)),
  '55000 PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_orders_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'P4c receive suite reopens orders');
reset role;

-- 2. Acceptance.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('a date-of-birth mismatch without the reference (names no route: the route keeps its 5)',
  (select accepted.result = 'patient_mismatch' and accepted.attempts_left = 5
    and accepted.patient_full_name is null and accepted.work_item_id is null and accepted.route_row_version = 1
  from lab.accept_order_route(current_setting('hid.test.route_1')::uuid, 1, 'date_of_birth', '1990-04-13',
    'p4c-receive-acc-0001a', repeat('a', 64)) accepted));
select pg_temp.check('a malformed date', format($s$select * from lab.accept_order_route(%L, 1, 'date_of_birth', '12/04/1990',
  'p4c-receive-acc-0001b', %L)$s$, current_setting('hid.test.route_1'), repeat('a', 64)), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('an impossible date', format($s$select * from lab.accept_order_route(%L, 1, 'date_of_birth', '1990-02-30',
  'p4c-receive-acc-0001c', %L)$s$, current_setting('hid.test.route_1'), repeat('a', 64)), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('a malformed Health ID', format($s$select * from lab.accept_order_route(%L, 1, 'health_id', 'P4CPATP',
  'p4c-receive-acc-0001d', %L)$s$, current_setting('hid.test.route_1'), repeat('a', 64)), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('an unknown identifier kind', format($s$select * from lab.accept_order_route(%L, 1, 'nin', '12345678901',
  'p4c-receive-acc-0001e', %L)$s$, current_setting('hid.test.route_1'), repeat('a', 64)), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('a stale version', format($s$select * from lab.accept_order_route(%L, 2, 'health_id', 'HID-P4CPATP',
  'p4c-receive-acc-0001f', %L)$s$, current_setting('hid.test.route_1'), repeat('a', 64)), 'P0001 ORDER_ROUTE_VERSION_CONFLICT');
select pg_temp.check('another facility''s route', format($s$select * from lab.accept_order_route(%L, 1, 'health_id',
  'HID-P4CPATP', 'p4c-receive-acc-0001g', %L)$s$, current_setting('hid.test.rxroute_1'), repeat('a', 64)),
  'P0002 ORDER_ROUTE_NOT_FOUND');
create temp table accepted_1 as select * from lab.accept_order_route(current_setting('hid.test.route_1')::uuid, 1,
  'health_id', ' hid-p4cpatp ', 'p4c-receive-acc-00001', repeat('b', 64));
select pg_temp.assert('a Health ID match accepts', (select accepted.result = 'accepted' and accepted.route_row_version = 2
    and accepted.work_item_id is not null and accepted.patient_full_name = 'Patience Okafor' and accepted.patient_sex = 'female'
    and accepted.patient_date_of_birth = '1990-04-12' and accepted.patient_health_id_last4 = 'PATP'
    and accepted.clinical_information = 'Fever for three days' and accepted.orderer_licence_body = 'MDCN'
    and accepted.orderer_licence_number = 'MDCN/45678' and not accepted.replayed from accepted_1 accepted));
select pg_temp.assert('a replay re-checks access and answers the same', (select replayed.result = 'accepted'
    and replayed.replayed and replayed.work_item_id = (select accepted.work_item_id from accepted_1 accepted)
    and replayed.patient_full_name = 'Patience Okafor'
  from lab.accept_order_route(current_setting('hid.test.route_1')::uuid, 1, 'health_id', 'HID-P4CPATP',
    'p4c-receive-acc-00001', repeat('b', 64)) replayed));
select pg_temp.check('a reused key', format($s$select * from lab.accept_order_route(%L, 1, 'health_id', 'HID-P4CPATP',
  'p4c-receive-acc-00001', %L)$s$, current_setting('hid.test.route_2'), repeat('b', 64)), 'P0001 IDEMPOTENCY_KEY_REUSED');
select pg_temp.check('a second accept', format($s$select * from lab.accept_order_route(%L, 2, 'health_id', 'HID-P4CPATP',
  'p4c-receive-acc-00002', %L)$s$, current_setting('hid.test.route_1'), repeat('c', 64)), 'P0001 ORDER_ROUTE_NOT_PENDING');
select pg_temp.assert('get after acceptance: full', (select got.view_level = 'full'
    and got.clinical_information = 'Fever for three days' and got.orderer_licence_number = 'MDCN/45678'
    and got.patient_full_name = 'Patience Okafor' and got.patient_health_id_last4 = 'PATP'
    and got.work_item_id = (select accepted.work_item_id from accepted_1 accepted)
  from lab.get_order_route(current_setting('hid.test.route_1')::uuid) got));
reset role;
do $$
declare
  route ehr.order_routes%rowtype;
  item lab.work_items%rowtype;
begin
  select * into route from ehr.order_routes where id = current_setting('hid.test.route_1')::uuid;
  select * into item from lab.work_items where id = route.lab_work_item_id;
  perform pg_temp.assert('the work item is bound to the route', item.order_route_id = route.id
    and item.facility_id = route.receiving_facility_id and item.ordering_facility_id = route.ordering_facility_id
    and item.source_ehr_order_id = route.source_lab_request_id and item.source_ehr_order_version = route.source_order_version
    and item.test_name = route.test_display and item.clinical_indication = route.clinical_information
    and item.requested_by = route.orderer_account_id and item.accepted_by = route.accepted_by_account_id
    and item.idempotency_key = 'order-route:' || route.id::text);
  perform pg_temp.assert('the route accepted with its windows', route.state = 'accepted'
    and route.writes_end_at = route.accepted_at + interval '30 days' and route.access_ends_at = route.writes_end_at
    and route.accept_idempotency_key = 'p4c-receive-acc-00001');
  perform pg_temp.assert('requested test, event and outbox', exists (select 1 from lab.work_item_requested_tests test
      where test.work_item_id = item.id and test.ordinal = 1 and test.name = 'Haemoglobin')
    and exists (select 1 from lab.work_item_events event where event.work_item_id = item.id and event.event_type = 'accepted')
    and exists (select 1 from lab.outbox_events outbox where outbox.aggregate_id = item.id
      and outbox.event_type = 'LabWorkItemCreated'
      and outbox.payload = jsonb_build_object('workItemId', item.id, 'sourceEhrOrderId', route.source_lab_request_id,
        'sourceEhrOrderVersion', route.source_order_version, 'status', 'accepted')));
  perform pg_temp.assert('identification attempts recorded without the identifier',
    (select array_agg(attempt.identifier_kind || ':' || attempt.outcome || ':' || attempt.identifies_route
        order by attempt.attempted_at)
       from ehr.order_route_accept_attempts attempt where attempt.route_id = route.id)
    = array['date_of_birth:mismatch:false', 'health_id:match:true']);
  perform pg_temp.assert('A told with the patient; the patient told', exists (select 1 from audit.events event
      where event.action = 'ehr.order-route.accepted' and event.facility_id = route.ordering_facility_id
        and event.patient_id = route.patient_id and event.actor_type = 'system')
    and exists (select 1 from notification.inbox_items inbox where inbox.resource_id = route.id
      and inbox.notification_code = 'ORDER_ROUTE_ACCEPTED'));
end $$;
-- A date-of-birth match (route 2).
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('a date-of-birth match accepts', (select accepted.result = 'accepted'
  from lab.accept_order_route(current_setting('hid.test.route_2')::uuid, 1, 'date_of_birth', '1990-04-12',
    'p4c-receive-acc-00003', repeat('d', 64)) accepted));
-- Five mismatches lock route 3.
select pg_temp.assert('mismatches count down', (select array_agg(accepted.result || ':' || accepted.attempts_left order by n)
  from generate_series(1, 5) n
  cross join lateral lab.accept_order_route(current_setting('hid.test.route_3')::uuid,
    case when n < 5 then 1 else 1 end, 'health_id', 'HID-WRAGPATZ', 'p4c-receive-lock-' || lpad(n::text, 4, '0'),
    repeat('e', 64)) accepted)
  = array['patient_mismatch:4', 'patient_mismatch:3', 'patient_mismatch:2', 'patient_mismatch:1', 'accept_locked:0']);
select pg_temp.check('a locked route', format($s$select * from lab.accept_order_route(%L, 2, 'health_id', 'HID-P4CPATP',
  'p4c-receive-lock-0006', %L)$s$, current_setting('hid.test.route_3'), repeat('e', 64)), 'P0001 ORDER_ROUTE_ACCEPT_LOCKED');
select pg_temp.assert('Incoming shows the lock', (select incoming.accept_locked and incoming.attempts_left = 0
  from lab.list_order_routes('incoming', null) incoming where incoming.route_id = current_setting('hid.test.route_3')::uuid));
reset role;
select pg_temp.assert('the lock: event, A''s row with the patient, the patient told',
  exists (select 1 from ehr.order_route_events event where event.route_id = current_setting('hid.test.route_3')::uuid
    and event.event_type = 'accept_locked' and event.state_after = 'sent')
  and exists (select 1 from audit.events event where event.action = 'ehr.order-route.accept-locked'
    and event.resource_id = current_setting('hid.test.route_3') and event.patient_id is not null
    and event.facility_id = 'e4c21000-0000-4000-8000-000000000001')
  and exists (select 1 from notification.inbox_items item where item.resource_id = current_setting('hid.test.route_3')::uuid
    and item.notification_code = 'ORDER_ROUTE_ACCEPT_LOCKED'));
-- The member's budget: 20 mismatches a day (owner SQL seeds 15 more).
insert into ehr.order_route_accept_attempts (route_id, receiving_facility_id, account_id, membership_id, identifier_kind,
  outcome, identifies_route)
select current_setting('hid.test.route_3')::uuid, current_setting('hid.test.facility_1')::uuid,
  current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid, 'health_id', 'mismatch', true
  from generate_series(1, 15);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('the member''s 21st mismatch of the day', format($s$select * from lab.accept_order_route(%L, 1, 'health_id',
  'HID-P4CPATP', 'p4c-receive-budget-01', %L)$s$, current_setting('hid.test.route_4'), repeat('f', 64)),
  'P0001 ORDER_ROUTE_ACCEPT_LIMITED');
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('another member still accepts', (select accepted.result = 'accepted'
  from lab.accept_order_route(current_setting('hid.test.route_4')::uuid, 1, 'health_id', 'HID-P4CPATP',
    'p4c-receive-budget-02', repeat('f', 64)) accepted));
reset role;
-- No birth date on record (owner SQL clears Q's).
update identity.patients set dob = null where id = 'e4c30000-0000-4000-8000-000000000002';
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a date of birth that is not on record', format($s$select * from lab.accept_order_route(%L, 1,
  'date_of_birth', '1985-09-30', 'p4c-receive-nodob-001', %L)$s$, current_setting('hid.test.route_q'), repeat('0', 64)),
  'P0001 ORDER_ROUTE_HEALTH_ID_REQUIRED');
select pg_temp.assert('not counted', (select incoming.attempts_left = 5 from lab.list_order_routes('incoming', null) incoming
  where incoming.route_id = current_setting('hid.test.route_q')::uuid));
reset role;
update identity.patients set dob = '1985-09-30' where id = 'e4c30000-0000-4000-8000-000000000002';
-- After withdrawal (route 5) and after expiry (route 6, owner SQL moves it 8 days back).
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('the orderer withdraws route 5', format($s$select * from ehr.withdraw_order_route(%L, 'lab_request', %L, 1,
  'patient_request')$s$, current_setting('hid.test.route_5'), current_setting('hid.test.lr_5')), 'ok');
reset role;
set local session_replication_role = replica;
update ehr.order_routes set created_at = created_at - interval '8 days', respond_by = respond_by - interval '8 days'
 where id = current_setting('hid.test.route_6')::uuid;
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('accept after withdrawal', format($s$select * from lab.accept_order_route(%L, 2, 'health_id', 'HID-P4CPATP',
  'p4c-receive-late-0001', %L)$s$, current_setting('hid.test.route_5'), repeat('1', 64)), 'P0001 ORDER_ROUTE_NOT_PENDING');
select pg_temp.check('accept after expiry', format($s$select * from lab.accept_order_route(%L, 1, 'health_id', 'HID-P4CPATP',
  'p4c-receive-late-0002', %L)$s$, current_setting('hid.test.route_6'), repeat('1', 64)), 'P0001 ORDER_ROUTE_EXPIRED');
select pg_temp.assert('a route past respond_by reads as metadata', (select got.view_level = 'metadata'
    and got.orderer_name is null and got.test_name is null
  from lab.get_order_route(current_setting('hid.test.route_6')::uuid) got));
select pg_temp.assert('an expired route leaves Incoming', not exists (select 1 from lab.list_order_routes('incoming', null)
  incoming where incoming.route_id = current_setting('hid.test.route_6')::uuid));
select pg_temp.assert('recent shows every state as metadata', (select array_agg(recent.effective_state
      order by recent.effective_state)
    from lab.list_order_routes('recent', null) recent where recent.route_id in (current_setting('hid.test.route_1')::uuid,
      current_setting('hid.test.route_5')::uuid, current_setting('hid.test.route_6')::uuid))
  = array['accepted', 'expired', 'withdrawn']
  and (select bool_and(recent.view_level = 'metadata' and recent.orderer_name is null
         and (recent.test_name is not null) = (recent.accepted_at is not null))
       from lab.list_order_routes('recent', null) recent));
reset role;
-- The ordering facility suspended (V10), then restored.
update identity.facilities set lifecycle_status = 'suspended', active = false
 where id = 'e4c21000-0000-4000-8000-000000000001';
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('accept for a suspended ordering facility', format($s$select * from lab.accept_order_route(%L, 1, 'health_id',
  'HID-P4CPATP', 'p4c-receive-susp-0001', %L)$s$, current_setting('hid.test.route_7'), repeat('2', 64)),
  'P0001 ORDER_ROUTE_ORDERING_FACILITY_UNAVAILABLE');
reset role;
update identity.facilities set lifecycle_status = 'verified', active = true
 where id = 'e4c21000-0000-4000-8000-000000000001';
-- The receiving facility suspended: its members have no session there.
update identity.facilities set lifecycle_status = 'suspended', active = false
 where id = current_setting('hid.test.facility_1')::uuid;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('accept at a suspended receiving facility', format($s$select * from lab.accept_order_route(%L, 1, 'health_id',
  'HID-P4CPATP', 'p4c-receive-susp-0002', %L)$s$, current_setting('hid.test.route_7'), repeat('2', 64)),
  '42501 Order route staff context is required');
reset role;
update identity.facilities set lifecycle_status = 'verified', active = true
 where id = current_setting('hid.test.facility_1')::uuid;
-- The pharmacy accepts with the date of birth and a reason.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_signup_admin(2);
select pg_temp.check('pharmacy accept without a reason', format($s$select * from pharmacy.accept_order_route(%L, 1, 'date_of_birth',
  '1990-04-12', 'short', 'p4c-receive-rx-acc-001', %L)$s$, current_setting('hid.test.rxroute_1'), repeat('3', 64)),
  '22023 ORDER_ROUTE_INVALID');
create temp table accepted_rx as select * from pharmacy.accept_order_route(current_setting('hid.test.rxroute_1')::uuid, 1,
  'date_of_birth', '1990-04-12', 'Patient at the counter with the prescription', 'p4c-receive-rx-acc-002', repeat('3', 64));
select pg_temp.assert('the pharmacy accepts', (select accepted.result = 'accepted' and accepted.work_item_id is not null
    and accepted.instructions = 'Take after food for seven days' and accepted.patient_full_name = 'Patience Okafor'
  from accepted_rx accepted));
reset role;
select pg_temp.assert('the pharmacy work item is the route''s', exists (select 1 from pharmacy.work_items item
  join ehr.order_routes route on route.id = item.order_route_id
  where item.id = (select accepted.work_item_id from accepted_rx accepted) and item.facility_id = route.receiving_facility_id
    and item.ordering_facility_id = route.ordering_facility_id and item.source_ehr_prescription_id = route.source_prescription_id
    and item.acceptance_reason = 'Patient at the counter with the prescription' and item.prescribed_by = route.orderer_account_id)
  and exists (select 1 from pharmacy.work_item_events event
    where event.work_item_id = (select accepted.work_item_id from accepted_rx accepted)
      and event.event_type = 'prescription_accepted')
  and exists (select 1 from pharmacy.outbox_events outbox
    where outbox.aggregate_id = (select accepted.work_item_id from accepted_rx accepted)
      and outbox.event_type = 'PharmacyWorkItemCreated'));

-- 3. Decline.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('decline with an unknown reason', format($s$select * from lab.decline_order_route(%L, 1, 'busy')$s$,
  current_setting('hid.test.route_8')), '22023 ORDER_ROUTE_INVALID');
select pg_temp.assert('decline', (select declined.state = 'declined' and declined.row_version = 2
  from lab.decline_order_route(current_setting('hid.test.route_8')::uuid, 1, 'test_not_offered') declined));
select pg_temp.check('decline again', format($s$select * from lab.decline_order_route(%L, 2, 'other')$s$,
  current_setting('hid.test.route_8')), 'P0001 ORDER_ROUTE_NOT_PENDING');
select pg_temp.check('decline after acceptance', format($s$select * from lab.decline_order_route(%L, %s, 'other')$s$,
  current_setting('hid.test.route_1'), (select got.row_version from lab.get_order_route(current_setting('hid.test.route_1')::uuid)
  got)), 'P0001 ORDER_ROUTE_NOT_PENDING');
reset role;
select pg_temp.assert('decline told to A with the patient and to the patient',
  exists (select 1 from audit.events event where event.action = 'ehr.order-route.declined'
    and event.resource_id = current_setting('hid.test.route_8') and event.patient_id is not null
    and event.details ->> 'reason' = 'test_not_offered')
  and exists (select 1 from notification.inbox_items item where item.resource_id = current_setting('hid.test.route_8')::uuid
    and item.notification_code = 'ORDER_ROUTE_DECLINED')
  and (select route.decline_reason from ehr.order_routes route where route.id = current_setting('hid.test.route_8')::uuid)
    = 'test_not_offered');
-- Orders off: decline still works; route access off: Incoming and accept answer 423.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c receive suite pauses route work');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('route access off: Incoming', $s$select * from lab.list_order_routes('incoming', null)$s$,
  '55000 PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled');
select pg_temp.check('route access off: accept', format($s$select * from lab.accept_order_route(%L, 1, 'health_id',
  'HID-P4CPATP', 'p4c-receive-paused-01', %L)$s$, current_setting('hid.test.route_7'), repeat('4', 64)),
  '55000 PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled');
select pg_temp.assert('route access off: the route-backed item is hidden',
  not exists (select 1 from lab.work_items item where item.order_route_id is not null));
select pg_temp.assert('route access off: the resource check pauses', (select access.outcome
  from lab.order_route_access_for('work_item', (select accepted.work_item_id from accepted_1 accepted), 'write_records')
  access) = 'paused');
select pg_temp.assert('route access off: cards without identity', not exists (select 1
  from lab.order_route_cards(array[(select accepted.work_item_id from accepted_1 accepted)]) card
  where card.patient_full_name is not null));
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c receive suite resumes route work');
reset role;

-- 4. Route access. Owner SQL: a non-route work item of P at L1 (an order of
-- L1 for P, as if L1 had its own clinical record; triggers and keys off).
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, priority, test_code_system, test_code, test_name, requested_by,
  requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e4c90000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000001',
  current_setting('hid.test.facility_1')::uuid, current_setting('hid.test.facility_1')::uuid, gen_random_uuid(), 1,
  gen_random_uuid(), 'routine', 'http://loinc.org', '2345-7', 'Glucose', current_setting('hid.test.account_1')::uuid,
  clock_timestamp(), current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid,
  'p4c-nonroute-work-0001', repeat('7', 64), 'p4c-nonroute-work');
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('a non-route row of the same patient stays hidden',
  not exists (select 1 from lab.work_items item where item.id = 'e4c90000-0000-4000-8000-000000000001'));
select pg_temp.assert('route-backed items visible without consent', (select count(*) from lab.work_items item
  where item.order_route_id is not null) = 3);
select pg_temp.assert('the second member may write the route-backed item', lab.work_item_allows(
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_1')::uuid,
  current_setting('hid.test.route_1')::uuid, 'write_records'));
-- The second member accessions the item (the Lab's own insert, under route access).
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
values ('e4c91000-0000-4000-8000-000000000001', (select accepted.work_item_id from accepted_1 accepted),
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_1')::uuid, 'urgent',
  'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', 'p4c-route-accession-01',
  repeat('8', 64), current_setting('app.correlation_id'));
select pg_temp.assert('the accession reads back', exists (select 1 from lab.accessions accession
  where accession.id = 'e4c91000-0000-4000-8000-000000000001'));
select pg_temp.assert('resource check: work item, write allowed', (select access.outcome = 'allowed'
    and access.route_id = current_setting('hid.test.route_1')::uuid
  from lab.order_route_access_for('work_item', (select accepted.work_item_id from accepted_1 accepted), 'write_records')
    access));
select pg_temp.assert('resource check: accession, read allowed', (select access.outcome = 'allowed'
    and access.work_item_id = (select accepted.work_item_id from accepted_1 accepted)
  from lab.order_route_access_for('accession', 'e4c91000-0000-4000-8000-000000000001', 'read_records') access));
select pg_temp.assert('resource check: a non-route row is none', (select access.outcome = 'none' and access.route_id is null
  from lab.order_route_access_for('work_item', 'e4c90000-0000-4000-8000-000000000001', 'write_records') access));
select pg_temp.assert('resource check: an unknown resource is none', (select access.outcome = 'none'
  from lab.order_route_access_for('specimen', gen_random_uuid(), 'read_records') access));
select pg_temp.check('resource check: an unknown type', $s$select * from lab.order_route_access_for('report', gen_random_uuid(),
  'read_records')$s$, '22023 ORDER_ROUTE_INVALID');
select pg_temp.assert('cards: work access with the patient', (select card.access = 'work' and card.patient_full_name = 'Patience Okafor'
    and card.orderer_licence_number = 'MDCN/45678' and card.reference = upper(left(replace(current_setting('hid.test.route_1'),
      '-', ''), 8))
  from lab.order_route_cards(array[(select accepted.work_item_id from accepted_1 accepted),
    'e4c90000-0000-4000-8000-000000000001'::uuid]) card));
select pg_temp.assert('cards: only route-backed rows', (select count(*) from lab.order_route_cards(
  array[(select accepted.work_item_id from accepted_1 accepted), 'e4c90000-0000-4000-8000-000000000001'::uuid])) = 1);
select pg_temp.check('cards: too many ids', $s$select * from lab.order_route_cards(array_fill(gen_random_uuid(), array[201]))$s$,
  '22023 ORDER_ROUTE_INVALID');
-- Under the emergency purpose route access does not apply (P10).
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid, 'emergency');
select pg_temp.assert('no route access under emergency', not exists (select 1 from lab.work_items item));
-- The receptionist at L1 (no receive permission) sees nothing.
select pg_temp.as_staff(32, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('the receptionist sees nothing', not exists (select 1 from lab.work_items item)
  and not exists (select 1 from lab.accessions accession));
-- The ordering doctor and a third facility's doctor see nothing of B's rows.
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.assert('the ordering doctor sees nothing at B', not exists (select 1 from lab.work_items item
  where item.facility_id = current_setting('hid.test.facility_1')::uuid)
  and not exists (select 1 from lab.accessions accession));
select pg_temp.as_staff(26, 'e4c21000-0000-4000-8000-000000000003');
select pg_temp.assert('a third facility sees nothing', not exists (select 1 from lab.work_items item)
  and not exists (select 1 from lab.accessions accession));
reset role;
-- Owner SQL: a same-facility item at GH for P; LA (lab at GH, P's consent at
-- GH) sees it in GH's session and not in a session naming another facility.
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, priority, test_code_system, test_code, test_name, requested_by,
  requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e4c90000-0000-4000-8000-000000000002', 'e4c30000-0000-4000-8000-000000000001',
  'e4c21000-0000-4000-8000-000000000001', 'e4c21000-0000-4000-8000-000000000001', gen_random_uuid(), 1,
  gen_random_uuid(), 'routine', 'http://loinc.org', '2345-7', 'Glucose', 'e4c10000-0000-4000-8000-000000000011',
  clock_timestamp(), 'e4c10000-0000-4000-8000-000000000014', 'e4c13000-0000-4000-8000-000000000014',
  'p4c-gh-own-work-0001', repeat('7', 64), 'p4c-gh-own-work');
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(14, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.assert('GH''s own item in GH''s session', exists (select 1 from lab.work_items item
  where item.id = 'e4c90000-0000-4000-8000-000000000002'));
select pg_temp.as_staff(14, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('not in a session naming another facility', not exists (select 1 from lab.work_items item
  where item.id = 'e4c90000-0000-4000-8000-000000000002'));
reset role;
-- The pharmacy's resource check and cards.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.assert('pharmacy: the second pharmacist sees the item', (select count(*) from pharmacy.work_items item) = 1);
select pg_temp.assert('pharmacy resource check', (select access.outcome = 'allowed'
  from pharmacy.order_route_access_for('work_item', (select accepted.work_item_id from accepted_rx accepted), 'write_records')
    access));
select pg_temp.assert('pharmacy card', (select card.access = 'work' and card.patient_sex = 'female'
  from pharmacy.order_route_cards(array[(select accepted.work_item_id from accepted_rx accepted)]) card));
reset role;

-- 5. A pending laboratory (P6.5): a route an owner inserted (no command
-- would send it) reaches nothing there.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'p4c-receive-signup', true),
  set_config('app.purpose_of_use', '', true), set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select pg_temp.p4c_sign_up(4, 'laboratory', 'laboratory', 'RC9945004', 'Nneka Pending Admin',
  'nneka@p4c-pending.invalid', 'P4c Pending Laboratory Ltd');
reset role;
select set_config('hid.test.membership_4', (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.account_4')::uuid), true),
  set_config('hid.test.subject_4', (select account.subject from auth.accounts account
    where account.id = current_setting('hid.test.account_4')::uuid), true);
insert into ehr.order_routes (id, kind, patient_id, ordering_organization_id, ordering_facility_id,
  source_lab_request_id, source_encounter_id, source_order_version, receiving_organization_id, receiving_facility_id,
  state, sent_by_account_id, sent_by_membership_id, created_at, respond_by, patient_agreement, attestation_text_version,
  attested_by_name, attested_receiving_facility_name, orderer_account_id, orderer_membership_id, orderer_name,
  test_code_system, test_code, test_display, priority, requested_at, idempotency_key, request_sha256, correlation_id)
select 'e4c70000-0000-4000-8000-0000000000a4', 'lab_request', source_order.patient_id,
  'e4c20000-0000-4000-8000-000000000001', source_order.facility_id, source_order.id, source_order.encounter_id,
  source_order.row_version, current_setting('hid.test.org_4')::uuid, current_setting('hid.test.facility_4')::uuid,
  'sent', source_order.created_by, source_order.created_by_membership_id, statement_timestamp(),
  statement_timestamp() + interval '168 hours', 'clinician_attested', 'order-route-lab-attestation-v1', 'Ada Doctor',
  'P4c Pending Laboratory Ltd', source_order.created_by, source_order.created_by_membership_id, 'Ada Doctor',
  source_order.test_code_system, source_order.test_code, source_order.test_display, source_order.priority,
  source_order.created_at, 'p4c-owner-pending-route', repeat('9', 64), 'p4c-owner-pending'
  from ehr.lab_requests source_order where source_order.id = current_setting('hid.test.lq_2')::uuid;
insert into ehr.order_route_events (route_id, event_version, event_type, side, state_after, correlation_id)
values ('e4c70000-0000-4000-8000-0000000000a4', 1, 'created', 'ordering', 'sent', 'p4c-owner-pending');
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(4);
select pg_temp.check('the pending administrator lists nothing', $s$select * from lab.list_order_routes('incoming', null)$s$,
  '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.check('the pending administrator cannot accept', $s$select * from lab.accept_order_route(
  'e4c70000-0000-4000-8000-0000000000a4', 1, 'health_id', 'HID-P4CPATQ', 'p4c-pending-accept-01', repeat('9', 64))$s$,
  '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.assert('no route access at the pending laboratory', not lab.context_allows(
  'e4c30000-0000-4000-8000-000000000002', current_setting('hid.test.facility_4')::uuid, 'read_records')
  and not exists (select 1 from lab.work_items item));
reset role;
select pg_temp.assert('the review gate keeps a receiving role out of the pending laboratory',
  pg_temp.outcome(format($s$insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id,
    facility_id, grant_reason) values (gen_random_uuid(), %L, 'lab', 'facility', %L, %L, 'Owner tries the lab role')$s$,
    current_setting('hid.test.account_4'), current_setting('hid.test.membership_4'), current_setting('hid.test.facility_4')))
  = 'P0001 FACILITY_REVIEW_PENDING');

-- 6. The residual (SPEC 4.3, signed by the owner): while a route for P is
-- live at L1, the chain-table branch is per patient at the facility, so a
-- receiving member's session may read L1's own other Lab rows of P through
-- the chain tables; the work list stays strict and every service path is
-- resource-based.
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('residual: the chain branch is per patient', lab.context_allows(
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_1')::uuid, 'read_records')
  and not lab.work_item_allows('e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_1')::uuid,
    null, 'read_records'));
reset role;

-- 7. A date of birth names a route only with the route's reference (P2,
-- owner Q3). Without it, a wrong date may be an honest pick of another
-- patient's row of several: it counts against the member's day and the
-- route's 20 in all, never the route's 5, and tells no one until the 20th
-- locks it. With the reference it counts as a Health ID does. A reference
-- that is not the route's is refused and recorded nowhere. LB2 (31) at L1.
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(9, 11) n;
select set_config('hid.test.route_' || n, pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_' || n)::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-receive-send-' || lpad(n::text, 4, '0'))::text, true)
  from generate_series(9, 11) n;
reset role;
select set_config('hid.test.reference_' || n, (select route.reference::text from ehr.order_routes route
  where route.id = current_setting('hid.test.route_' || n)::uuid), true) from generate_series(9, 11) n;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('dates of birth without the reference keep the route''s 5', (select array_agg(accepted.result || ':'
    || accepted.attempts_left order by n)
  from generate_series(1, 4) n
  cross join lateral lab.accept_order_route(current_setting('hid.test.route_9')::uuid, 1, 'date_of_birth', '1971-01-01',
    'p4c-receive-dob-' || lpad(n::text, 6, '0'), repeat('7', 64)) accepted)
  = array['patient_mismatch:5', 'patient_mismatch:5', 'patient_mismatch:5', 'patient_mismatch:5']);
select pg_temp.check('another route''s reference', format($s$select * from lab.accept_order_route(%L, 1, 'date_of_birth',
  '1990-04-12', 'p4c-receive-dobref-01', %L, %L)$s$, current_setting('hid.test.route_9'), repeat('7', 64),
  current_setting('hid.test.reference_10')), 'P0001 ORDER_ROUTE_REFERENCE_MISMATCH');
select pg_temp.check('a malformed reference', format($s$select * from lab.accept_order_route(%L, 1, 'date_of_birth',
  '1990-04-12', 'p4c-receive-dobref-02', %L, 'REF-1')$s$, current_setting('hid.test.route_9'), repeat('7', 64)),
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.assert('a wrong date with the reference counts as a named try', (select accepted.result = 'patient_mismatch'
    and accepted.attempts_left = 4
  from lab.accept_order_route(current_setting('hid.test.route_9')::uuid, 1, 'date_of_birth', '1971-01-02',
    'p4c-receive-dobref-03', repeat('7', 64), lower(current_setting('hid.test.reference_9'))) accepted));
select pg_temp.assert('the right date with the reference accepts', (select accepted.result = 'accepted'
    and accepted.patient_full_name = 'Patience Okafor'
  from lab.accept_order_route(current_setting('hid.test.route_9')::uuid, 1, 'date_of_birth', '1990-04-12',
    'p4c-receive-dobref-04', repeat('7', 64), current_setting('hid.test.reference_9')) accepted));
reset role;
select pg_temp.assert('route 9''s tries: four unnamed, one named, a match; the refused reference recorded nowhere',
  (select array_agg(attempt.outcome || ':' || attempt.identifies_route order by attempt.attempted_at)
     from ehr.order_route_accept_attempts attempt where attempt.route_id = current_setting('hid.test.route_9')::uuid)
  = array['mismatch:false', 'mismatch:false', 'mismatch:false', 'mismatch:false', 'mismatch:true', 'match:true']);
select pg_temp.assert('the unnamed dates locked nothing and told no one', not exists (select 1
    from ehr.order_route_events event where event.route_id = current_setting('hid.test.route_9')::uuid
      and event.event_type = 'accept_locked')
  and not exists (select 1 from notification.inbox_items item
    where item.resource_id = current_setting('hid.test.route_9')::uuid and item.notification_code = 'ORDER_ROUTE_ACCEPT_LOCKED')
  and not exists (select 1 from audit.events event where event.action = 'ehr.order-route.accept-locked'
    and event.resource_id = current_setting('hid.test.route_9')));
-- The cap: 19 unnamed wrong dates on route 10 two days ago (owner SQL, so no
-- member's day counts them); the 20th locks it and tells the patient.
insert into ehr.order_route_accept_attempts (route_id, receiving_facility_id, account_id, membership_id, identifier_kind,
  outcome, identifies_route, attempted_at)
select current_setting('hid.test.route_10')::uuid, current_setting('hid.test.facility_1')::uuid,
  current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid, 'date_of_birth',
  'mismatch', false, clock_timestamp() - interval '2 days'
  from generate_series(1, 19);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('Incoming counts the cap', (select incoming.attempts_left = 1 and not incoming.accept_locked
  from lab.list_order_routes('incoming', null) incoming where incoming.route_id = current_setting('hid.test.route_10')::uuid));
select pg_temp.assert('the 20th wrong date in all locks the route', (select accepted.result || ':' || accepted.attempts_left
  from lab.accept_order_route(current_setting('hid.test.route_10')::uuid, 1, 'date_of_birth', '1971-01-03',
    'p4c-receive-cap-0001', repeat('8', 64)) accepted) = 'accept_locked:0');
reset role;
select pg_temp.assert('the cap''s lock: event, A''s row, the patient told',
  exists (select 1 from ehr.order_route_events event where event.route_id = current_setting('hid.test.route_10')::uuid
    and event.event_type = 'accept_locked')
  and exists (select 1 from audit.events event where event.action = 'ehr.order-route.accept-locked'
    and event.resource_id = current_setting('hid.test.route_10'))
  and exists (select 1 from notification.inbox_items item where item.resource_id = current_setting('hid.test.route_10')::uuid
    and item.notification_code = 'ORDER_ROUTE_ACCEPT_LOCKED'));
-- The patient's deny directive is checked again at acceptance (SPEC-FINAL
-- P15.1): a directive naming L1, written after route 11 was sent (owner SQL;
-- no runtime writes directives), refuses the acceptance and writes nothing.
insert into identity.consent_directives (id, patient_id, current_version) values
  ('e4c80000-0000-4000-8000-0000000000d1', 'e4c30000-0000-4000-8000-000000000001', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, starts_at, source_reference, reason, content_sha256)
values (gen_random_uuid(), 'e4c80000-0000-4000-8000-0000000000d1', 'e4c30000-0000-4000-8000-000000000001', 1,
  'active', 'deny', 'facility', current_setting('hid.test.facility_1')::uuid, clock_timestamp() - interval '1 minute',
  'p4c-suite', 'The patient asked not to use this laboratory', repeat('5', 64));
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a deny directive written after the send', format($s$select * from lab.accept_order_route(%L, 1,
  'health_id', 'HID-P4CPATP', 'p4c-receive-deny-0001', %L)$s$, current_setting('hid.test.route_11'), repeat('9', 64)),
  'P0001 ORDER_ROUTE_PATIENT_DENIED');
reset role;
select pg_temp.assert('the refused acceptance wrote nothing', (select route.state = 'sent' and route.row_version = 1
    and route.lab_work_item_id is null
  from ehr.order_routes route where route.id = current_setting('hid.test.route_11')::uuid)
  and not exists (select 1 from ehr.order_route_accept_attempts attempt
    where attempt.route_id = current_setting('hid.test.route_11')::uuid)
  and not exists (select 1 from lab.work_items item where item.order_route_id = current_setting('hid.test.route_11')::uuid)
  and (select count(*) from ehr.order_route_events event
    where event.route_id = current_setting('hid.test.route_11')::uuid) = 1);

select pg_temp.report();
rollback;
