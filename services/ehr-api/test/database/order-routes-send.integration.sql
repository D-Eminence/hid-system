-- Sending an order to another facility (0086 section 6, P4c; owner decisions
-- of 2026-10-25: the doctor sends, the doctor's word only). Rollback-only.
-- Every command runs as the exact runtime role (hid_ehr_api_runtime for the
-- EHR's, hid_identity_api_runtime for the directory), in the context the
-- services set; owner SQL is marked.
--   1. the attestation text (C24): permissions, kind, control;
--   2. who may send (C1): doctor and clinician yes; nurse, lab, pharmacist,
--      receptionist and a restricted (not yet reviewed) administrator no;
--      emergency purpose and a read-only grant refused; control off;
--   3. eligibility, one code for every reason: pending, released, suspended,
--      legacy, wrong type, product suspended or on another facility,
--      unlisted by default (method other), unlisted and listed by support, no
--      receiving member, the ordering facility itself; governed and reviewed
--      receivers accepted;
--   4. the send: a draft activated (its version), the snapshot equal to the
--      order, the orderer's licence (a doctor's attested licence; none for a
--      clinician or a revoked grant), the clinician's attestation stored and
--      immutable, sent at once with respond_by = created_at + 7 days, in B's
--      Incoming, the patient's ORDER_ROUTE_SENT, B's received row without the
--      patient, event 1;
--   5. refusals: the newest attestation text required (an older one
--      outdated; another kind's or an unknown one invalid), the order in
--      same-facility work, a live route, a stale sent route stored expired
--      and the order sent again, the 5-route cap, a deny directive, a
--      patient without an account, replay and a reused key, a stale version,
--      an ineligible order status;
--   6. each limit at its boundary (owner SQL seeds routes);
--   7. the directory (C19).
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
-- Owner SQL: more fixtures for eligibility. A doctor DR (18) at GH with only a
-- read grant for P (as a PIN grant gives); a doctor DX (19) whose attested
-- doctor grant was revoked and replaced. A legacy laboratory LL (no
-- application) with a lab member (25); a governed pharmacy GP (product
-- pharmacy) with a pharmacist (22); a governed laboratory organization with
-- two facilities whose product is at the first (GL2a, GL2b, members 23, 27);
-- a governed laboratory with only a receptionist (GL3, 24).
insert into auth.accounts (id, subject, email, display_name, status)
select ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:p4c:' || s.code,
  s.code || '@p4c-staff.invalid', s.full_name, 'active'
  from (values (18, 'dr', 'Ruth Read Doctor'), (19, 'dx', 'Xavier Doctor'), (22, 'gpm', 'Governed Pharmacist'),
               (23, 'gl2a', 'Lab Two A'), (24, 'gl3', 'Lab Three Reception'), (25, 'llm', 'Legacy Lab'),
               (27, 'gl2b', 'Lab Two B')) s(n, code, full_name);
insert into identity.organizations (id, name, slug) values
  ('e4c20000-0000-4000-8000-000000000004', 'P4c Governed Pharmacy Ltd', 'p4c-governed-pharmacy'),
  ('e4c20000-0000-4000-8000-000000000005', 'P4c Two Site Diagnostics Ltd', 'p4c-two-site-diagnostics'),
  ('e4c20000-0000-4000-8000-000000000006', 'P4c Reception Only Diagnostics Ltd', 'p4c-reception-only'),
  ('e4c20000-0000-4000-8000-000000000007', 'P4c Legacy Diagnostics Ltd', 'p4c-legacy-diagnostics');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e4c21000-0000-4000-8000-000000000004', 'e4c20000-0000-4000-8000-000000000004', 'P4c Governed Pharmacy', 'P4C-GP', 'Africa/Lagos', true, 'verified'),
  ('e4c21000-0000-4000-8000-000000000005', 'e4c20000-0000-4000-8000-000000000005', 'P4c Two Site Lab A', 'P4C-GL2A', 'Africa/Lagos', true, 'verified'),
  ('e4c21000-0000-4000-8000-000000000008', 'e4c20000-0000-4000-8000-000000000005', 'P4c Two Site Lab B', 'P4C-GL2B', 'Africa/Lagos', true, 'verified'),
  ('e4c21000-0000-4000-8000-000000000006', 'e4c20000-0000-4000-8000-000000000006', 'P4c Reception Only Lab', 'P4C-GL3', 'Africa/Lagos', true, 'verified'),
  ('e4c21000-0000-4000-8000-000000000007', 'e4c20000-0000-4000-8000-000000000007', 'P4c Legacy Lab', 'P4C-LL', 'Africa/Lagos', true, 'verified');
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
  from (values (4, 'pharmacy', 'pharmacy', 'RC9944004', 'P4c Governed Pharmacy Ltd'),
               (5, 'laboratory', 'laboratory', 'RC9944005', 'P4c Two Site Diagnostics Ltd'),
               (6, 'laboratory', 'laboratory', 'RC9944006', 'P4c Reception Only Diagnostics Ltd'))
       g(n, product, kind, cac, legal_name);
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
select ('e4c20000-0000-4000-8000-00000000000' || n)::uuid, product, ('e4c21000-0000-4000-8000-00000000000' || n)::uuid,
  'active', ('e4c22000-0000-4000-8000-00000000000' || n)::uuid
  from (values (4, 'pharmacy'), (5, 'laboratory'), (6, 'laboratory')) g(n, product);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@p4c-staff.invalid', 'verified', s.role
  from (values (18, 'dr', 'Ruth Read Doctor', 'doctor'), (19, 'dx', 'Xavier Doctor', 'doctor'),
               (22, 'gpm', 'Governed Pharmacist', 'pharmacist'), (23, 'gl2a', 'Lab Two A', 'lab'),
               (24, 'gl3', 'Lab Three Reception', 'receptionist'), (25, 'llm', 'Legacy Lab', 'lab'),
               (27, 'gl2b', 'Lab Two B', 'lab')) s(n, code, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c20000-0000-4000-8000-00000000000' || s.org)::uuid,
  ('e4c21000-0000-4000-8000-00000000000' || s.facility)::uuid, s.role, s.role, true, true
  from (values (18, 1, 1, 'doctor'), (19, 1, 1, 'doctor'), (22, 4, 4, 'pharmacist'), (23, 5, 5, 'lab'),
               (24, 6, 6, 'receptionist'), (25, 7, 7, 'lab'), (27, 5, 8, 'lab')) s(n, org, facility, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e4c11000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c21000-0000-4000-8000-00000000000' || s.facility)::uuid, 'P4c suite governed role'
  from (values (18, 1, 'doctor'), (22, 4, 'pharmacist'), (23, 5, 'lab'), (24, 6, 'receptionist'),
               (25, 7, 'lab'), (27, 8, 'lab')) s(n, facility, role);
-- DX's attested doctor grant, revoked, and a new one without an attestation.
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('e4c11000-0000-4000-8000-000000000119', 'e4c10000-0000-4000-8000-000000000019', 'doctor', 'facility',
  'e4c13000-0000-4000-8000-000000000019', 'e4c21000-0000-4000-8000-000000000001', 'P4c suite earlier doctor grant');
insert into identity.staff_licence_attestations (organization_id, facility_id, account_id, staff_id, membership_id,
  role_code, role_grant_id, licence_body, licence_number, attested_person_name, verification_method,
  attested_by_account_id, attested_by_membership_id, attestation_version, attested_at, correlation_id)
values ('e4c20000-0000-4000-8000-000000000001', 'e4c21000-0000-4000-8000-000000000001',
  'e4c10000-0000-4000-8000-000000000019', 'e4c12000-0000-4000-8000-000000000019',
  'e4c13000-0000-4000-8000-000000000019', 'doctor', 'e4c11000-0000-4000-8000-000000000119', 'MDCN', 'MDCN/99999',
  'Xavier Doctor', 'facility_attestation', 'e4c10000-0000-4000-8000-000000000017', 'e4c13000-0000-4000-8000-000000000017',
  'facility-staff-attestation-v1', clock_timestamp(), 'p4c-fixture-licence-dx');
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = 'e4c10000-0000-4000-8000-000000000017',
  revocation_reason = 'Replaced by a new doctor grant'
 where id = 'e4c11000-0000-4000-8000-000000000119';
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('e4c11000-0000-4000-8000-000000000019', 'e4c10000-0000-4000-8000-000000000019', 'doctor', 'facility',
  'e4c13000-0000-4000-8000-000000000019', 'e4c21000-0000-4000-8000-000000000001', 'P4c suite current doctor grant');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
values (gen_random_uuid(), 'e4c30000-0000-4000-8000-000000000001', 'e4c12000-0000-4000-8000-000000000018',
  'e4c10000-0000-4000-8000-000000000018', 'e4c13000-0000-4000-8000-000000000018', 'e4c21000-0000-4000-8000-000000000001',
  'read_records', 'active', 'P4c suite read-only grant', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '1 day', false, 'direct-care'),
  (gen_random_uuid(), 'e4c30000-0000-4000-8000-000000000001', 'e4c12000-0000-4000-8000-000000000019',
  'e4c10000-0000-4000-8000-000000000019', 'e4c13000-0000-4000-8000-000000000019', 'e4c21000-0000-4000-8000-000000000001',
  'write_records', 'active', 'P4c suite consent', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '1 day', false, 'direct-care');

-- More sign-ups: 3 laboratory LO (reviewed, method other), 4 laboratory LP
-- (pending), 5 laboratory LS (reviewed, then suspended), 6 hospital H6
-- (pending; its restricted administrator tries to send), 7 laboratory LR
-- (reviewed, then released).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'p4c-send-signup', true),
  set_config('app.purpose_of_use', '', true), set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select pg_temp.p4c_sign_up(3, 'laboratory', 'laboratory', 'RC9945003', 'Mobo Other Admin', 'mobo@p4c-other.invalid',
  'P4c Other Check Laboratory Ltd');
select pg_temp.p4c_sign_up(4, 'laboratory', 'laboratory', 'RC9945004', 'Nneka Pending Admin',
  'nneka@p4c-pending.invalid', 'P4c Pending Laboratory Ltd');
select pg_temp.p4c_sign_up(5, 'laboratory', 'laboratory', 'RC9945005', 'Obi Suspended Admin',
  'obi@p4c-suspended.invalid', 'P4c Suspended Laboratory Ltd');
select pg_temp.p4c_sign_up(6, 'ehr', 'hospital', 'RC9945006', 'Pelumi Pending Hospital',
  'pelumi@p4c-hospital.invalid', 'P4c Pending Hospital Ltd');
select pg_temp.p4c_sign_up(7, 'laboratory', 'laboratory', 'RC9945007', 'Rotimi Released Admin',
  'rotimi@p4c-released.invalid', 'P4c Released Laboratory Ltd');
select pg_temp.as_platform(1);
select identity.admin_review_self_service_facility(current_setting('hid.test.app_' || n)::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('unreviewed') application
    where application.application_id = current_setting('hid.test.app_' || n)::uuid),
  'Support reviewed this laboratory for the suite', 'lab', method, 'MLSCN', 'MLS/1000' || n)
  from (values (3, 'other'), (5, 'cac_registered_contact'), (7, 'in_person')) r(n, method);
reset role;
select set_config('hid.test.membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.account_' || n)::uuid), true),
  set_config('hid.test.subject_' || n,
  (select account.subject from auth.accounts account where account.id = current_setting('hid.test.account_' || n)::uuid),
  true)
  from generate_series(3, 7) n;
-- LS suspended and LR released through support's commands.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select identity.admin_transition_facility(current_setting('hid.test.facility_' || n)::uuid,
  (select facility.row_version from identity.facilities facility where facility.id = current_setting('hid.test.facility_' || n)::uuid),
  'suspended', 'Suspended for the P4c suite', 'p4c-suspend-' || n || '-0000000000', repeat('c', 64))
  from generate_series(5, 7, 2) n;
select auth.admin_transition_account(current_setting('hid.test.account_7')::uuid,
  (select account.row_version from auth.accounts account where account.id = current_setting('hid.test.account_7')::uuid),
  'disabled', 'Disabled for the P4c release', 'p4c-disable-7-000000000000', repeat('d', 64));
select identity.admin_release_self_service_facility(current_setting('hid.test.app_7')::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('all') application
    where application.application_id = current_setting('hid.test.app_7')::uuid),
  'Released for the P4c suite', false);
reset role;

-- Orders of DA for P (1) and N (3), and of CA (12) for P.
set local role hid_ehr_api_runtime;
select set_config('hid.test.draft', pg_temp.lab_request(1, 'draft')::text, true);
select set_config('hid.test.active_' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(1, 9) n;
select set_config('hid.test.held', pg_temp.lab_request(1, 'on_hold')::text, true);
select set_config('hid.test.no_account', pg_temp.lab_request(3, 'active')::text, true);
select set_config('hid.test.rx', pg_temp.prescription(1, 'active')::text, true);
select set_config('hid.test.rx_draft', pg_temp.prescription(1, 'draft')::text, true);
select pg_temp.as_staff(12, 'e4c21000-0000-4000-8000-000000000001');
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status)
values ('e4c60000-0000-4000-8000-000000000012', 'e4c50000-0000-4000-8000-000000000001',
  'e4c30000-0000-4000-8000-000000000001', 'e4c21000-0000-4000-8000-000000000001',
  'e4c10000-0000-4000-8000-000000000012', 'e4c13000-0000-4000-8000-000000000012', 'http://loinc.org', '2345-7',
  'Glucose', 'routine', 'active');
select pg_temp.as_staff(19, 'e4c21000-0000-4000-8000-000000000001');
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status)
values ('e4c60000-0000-4000-8000-000000000019', 'e4c50000-0000-4000-8000-000000000001',
  'e4c30000-0000-4000-8000-000000000001', 'e4c21000-0000-4000-8000-000000000001',
  'e4c10000-0000-4000-8000-000000000019', 'e4c13000-0000-4000-8000-000000000019', 'http://loinc.org', '2345-7',
  'Glucose', 'routine', 'active');
reset role;

-- 1. The attestation text (C24).
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('C24 doctor lab', $s$select * from ehr.order_route_attestation_text('lab_request')$s$, 'ok');
select pg_temp.check('C24 doctor prescription', $s$select * from ehr.order_route_attestation_text('prescription')$s$, 'ok');
select pg_temp.assert('C24 answers the lab v1 text',
  (select attestation.version = 'order-route-lab-attestation-v1' and attestation.text like 'I confirm that {patient}%'
     from ehr.order_route_attestation_text('lab_request') attestation));
select pg_temp.check('C24 unknown kind', $s$select * from ehr.order_route_attestation_text('referral')$s$,
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.as_staff(13, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('C24 nurse', $s$select * from ehr.order_route_attestation_text('lab_request')$s$,
  '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.as_staff(14, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('C24 lab at the hospital (lab-request write, no send)',
  $s$select * from ehr.order_route_attestation_text('lab_request')$s$, '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001', 'emergency');
select pg_temp.check('C24 emergency purpose', $s$select * from ehr.order_route_attestation_text('lab_request')$s$,
  '42501 Order route staff context is required');
reset role;

-- 2. Who may send.
set local role hid_ehr_api_runtime;
select pg_temp.check('send as nurse', format($s$select pg_temp.send(13, 'lab_request', %L, %L, 'p4c-send-nurse-000001')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_1')), '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.check('send as lab', format($s$select pg_temp.send(14, 'lab_request', %L, %L, 'p4c-send-lab-0000001')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_1')), '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.check('send as pharmacist', format($s$select pg_temp.send(15, 'prescription', %L, %L, 'p4c-send-pharm-000001')$s$,
  current_setting('hid.test.rx'), current_setting('hid.test.facility_2')), '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.check('send as receptionist', format($s$select pg_temp.send(16, 'lab_request', %L, %L, 'p4c-send-recep-000001')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_1')), '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.check('send with a read-only grant', format($s$select pg_temp.send(18, 'lab_request', %L, %L, 'p4c-send-read-000001')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_1')), 'P0002 ORDER_NOT_FOUND');
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001', 'emergency');
select pg_temp.check('send under emergency', format($s$select * from ehr.send_order_route(gen_random_uuid(), 'lab_request',
    'e4c30000-0000-4000-8000-000000000001', %L, 'e4c50000-0000-4000-8000-000000000001', 1, %L,
    'order-route-lab-attestation-v1', 'p4c-send-emergency-01', repeat('e', 64))$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_1')), '42501 Order route staff context is required');
reset role;
-- The restricted administrator of a pending hospital (H6).
set local role hid_ehr_api_runtime;
select pg_temp.as_signup_admin(6);
select pg_temp.check('send as a restricted administrator', $s$select * from ehr.send_order_route(gen_random_uuid(),
    'lab_request', 'e4c30000-0000-4000-8000-000000000001', gen_random_uuid(), gen_random_uuid(), 1,
    'e4c21000-0000-4000-8000-000000000002', 'order-route-lab-attestation-v1', 'p4c-send-restricted-1',
    repeat('e', 64))$s$, '42501 ORDER_ROUTE_PERMISSION_DENIED');
reset role;
-- Control off (owner SQL closes it through the admin command).
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_orders_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'P4c suite closes orders');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.check('send with the control off', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-closed-0001')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_1')),
  '55000 PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled');
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('attestation text with the control off',
  $s$select * from ehr.order_route_attestation_text('lab_request')$s$,
  '55000 PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_orders_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'P4c suite opens orders again');
reset role;

-- 3. Eligibility: one code for every reason.
set local role hid_ehr_api_runtime;
select pg_temp.check('to a pending laboratory', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-pending-001')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_4')), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
reset role;
-- Owner SQL (the review gate off): LP's administrator holds lab and LP is
-- listed, so only the pending review keeps LP out of the directory.
savepoint pending_member;
set local session_replication_role = replica;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values (gen_random_uuid(), current_setting('hid.test.account_4')::uuid, 'lab', 'facility',
  current_setting('hid.test.membership_4')::uuid, current_setting('hid.test.facility_4')::uuid, 'Owner SQL lab role');
insert into identity.order_route_destination_settings (facility_id, organization_id, listed, reason, set_by_account_id,
  correlation_id)
values (current_setting('hid.test.facility_4')::uuid, current_setting('hid.test.org_4')::uuid, true,
  'Owner SQL lists the pending laboratory', 'e4c10000-0000-4000-8000-000000000001', 'p4c-owner-listing');
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.outcome(format($s$select pg_temp.send(11, 'lab_request', %L, %L,
  'p4c-elig-pending-002')$s$, current_setting('hid.test.active_1'), current_setting('hid.test.facility_4'))) as kept_pending_member_0_1 \gset
reset role;
rollback to savepoint pending_member;
insert into p4c_checks (label, expected, actual) values ('to a pending laboratory with a receiving member', 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE', :'kept_pending_member_0_1');
set local role hid_ehr_api_runtime;
select pg_temp.check('to a suspended laboratory', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-suspend-001')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_5')), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('to a released laboratory', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-release-001')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_7')), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('to a legacy laboratory', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-legacy-0001')$s$,
  current_setting('hid.test.active_1'), 'e4c21000-0000-4000-8000-000000000007'), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('a lab request to a pharmacy', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-type-00001')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_2')), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('a prescription to a laboratory', format($s$select pg_temp.send(11, 'prescription', %L, %L, 'p4c-elig-type-00002')$s$,
  current_setting('hid.test.rx'), 'e4c21000-0000-4000-8000-000000000002'), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('to the facility without the product', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-product-001')$s$,
  current_setting('hid.test.active_1'), 'e4c21000-0000-4000-8000-000000000008'), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('to a laboratory without a receiving member', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-member-0001')$s$,
  current_setting('hid.test.active_1'), 'e4c21000-0000-4000-8000-000000000006'), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('to a laboratory reviewed with method other', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-other-00001')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_3')), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('to its own facility', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-own-000001')$s$,
  current_setting('hid.test.active_1'), 'e4c21000-0000-4000-8000-000000000001'), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('to a facility that does not exist', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-none-000001')$s$,
  current_setting('hid.test.active_1'), gen_random_uuid()), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
reset role;
-- Owner SQL: the governed laboratory's product suspended.
update identity.organization_products set status = 'suspended' where facility_id = 'e4c21000-0000-4000-8000-000000000002';
set local role hid_ehr_api_runtime;
select pg_temp.check('to a laboratory whose product is suspended', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-prodsus-001')$s$,
  current_setting('hid.test.active_1'), 'e4c21000-0000-4000-8000-000000000002'), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
reset role;
update identity.organization_products set status = 'active' where facility_id = 'e4c21000-0000-4000-8000-000000000002';
-- Support lists LO (method other) and unlists L1; then relists L1.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('support lists the other-method laboratory', format($s$select * from identity.admin_set_order_route_destination(%L, true,
  'Checked by phone after the review')$s$, current_setting('hid.test.facility_3')), 'ok');
select pg_temp.check('support unlists L1', format($s$select * from identity.admin_set_order_route_destination(%L, false,
  'Paused while support checks a complaint')$s$, current_setting('hid.test.facility_1')), 'ok');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.check('to the laboratory support unlisted', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-unlisted-01')$s$,
  current_setting('hid.test.active_1'), current_setting('hid.test.facility_1')), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('to the other-method laboratory once listed', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-listed-0001')$s$,
  current_setting('hid.test.active_9'), current_setting('hid.test.facility_3')), 'ok');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('support relists L1', format($s$select * from identity.admin_set_order_route_destination(%L, true,
  'Complaint closed, listed again')$s$, current_setting('hid.test.facility_1')), 'ok');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.check('to the governed laboratory', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-elig-governed-01')$s$,
  current_setting('hid.test.active_8'), 'e4c21000-0000-4000-8000-000000000002'), 'ok');
reset role;

-- 4. The send: a draft to L1.
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
create temp table sent_draft as
  select * from ehr.send_order_route('e4c70000-0000-4000-8000-000000000001', 'lab_request',
    'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.draft')::uuid,
    'e4c50000-0000-4000-8000-000000000001', 1, current_setting('hid.test.facility_1')::uuid,
    'order-route-lab-attestation-v1', 'p4c-send-draft-000001', repeat('1', 64));
-- The deferred first-event check fires at commit as the committing role (the
-- EHR runtime): fired here, under that role, it passes.
select pg_temp.check('the first-event check at the runtime''s commit',
  'set constraints ehr.order_routes_first_event immediate', 'ok');
set constraints all deferred;
reset role;
do $$
declare
  answer record;
  route ehr.order_routes%rowtype;
  source_order ehr.lab_requests%rowtype;
begin
  select * into answer from sent_draft;
  select * into route from ehr.order_routes where id = 'e4c70000-0000-4000-8000-000000000001';
  select * into source_order from ehr.lab_requests where id = current_setting('hid.test.draft')::uuid;
  perform pg_temp.assert('C1 answer', answer.route_id = route.id and answer.state = 'sent' and answer.row_version = 1
    and answer.reference = upper(left(replace(route.id::text, '-', ''), 8)) and not answer.replayed
    and answer.respond_by = answer.created_at + interval '7 days' and answer.order_status = 'active'
    and answer.order_row_version = 2 and answer.receiving_facility_name = 'P4c Sign-up Laboratory Ltd',
    row_to_json(answer)::text);
  perform pg_temp.assert('draft activated with its version', source_order.status = 'active' and source_order.row_version = 2);
  perform pg_temp.assert('activation recorded with its reason', exists (select 1 from ehr.record_versions version_row
    where version_row.resource_id = source_order.id::text and version_row.version_no = 2
      and version_row.change_reason = 'Activated to send to another facility'));
  perform pg_temp.assert('snapshot equals the order', route.source_order_version = 2
    and (route.test_code_system, route.test_code, route.test_display, route.priority, route.specimen_type_code,
         route.clinical_information, route.requested_at, route.orderer_account_id, route.orderer_membership_id,
         route.source_encounter_id, route.patient_id)
      = (source_order.test_code_system, source_order.test_code, source_order.test_display, source_order.priority,
         source_order.specimen_type_code, source_order.clinical_information, source_order.created_at,
         source_order.created_by, source_order.created_by_membership_id, source_order.encounter_id,
         source_order.patient_id));
  perform pg_temp.assert('attestation stored', route.patient_agreement = 'clinician_attested'
    and route.attestation_text_version = 'order-route-lab-attestation-v1' and route.attested_by_name = 'Ada Doctor'
    and route.attested_receiving_facility_name = 'P4c Sign-up Laboratory Ltd'
    and route.sent_by_account_id = 'e4c10000-0000-4000-8000-000000000011'
    and route.sent_by_membership_id = 'e4c13000-0000-4000-8000-000000000011');
  perform pg_temp.assert('orderer licence from the attestation', route.orderer_name = 'Ada Doctor'
    and route.orderer_licence_body = 'MDCN' and route.orderer_licence_number = 'MDCN/45678');
  perform pg_temp.assert('sent at once, 7 days to accept', route.state = 'sent'
    and route.respond_by = route.created_at + interval '7 days' and route.accepted_at is null
    and route.writes_end_at is null);
  perform pg_temp.assert('event 1', (select array_agg(event.event_type || ':' || event.side || ':' || event.state_after
      order by event.event_version) from ehr.order_route_events event where event.route_id = route.id)
    = array['created:ordering:sent']);
  perform pg_temp.assert('the patient told', exists (select 1 from notification.inbox_items item
    where item.patient_id = route.patient_id and item.notification_code = 'ORDER_ROUTE_SENT'
      and item.resource_type = 'order-route' and item.resource_id = route.id
      and item.metadata = jsonb_build_object('routeId', route.id, 'kind', 'lab_request',
        'orderingFacilityName', 'P4c General Hospital', 'receivingFacilityName', 'P4c Sign-up Laboratory Ltd')));
  perform pg_temp.assert('B received row without the patient', exists (select 1 from audit.events event
    where event.action = 'ehr.order-route.received' and event.actor_type = 'system'
      and event.facility_id = route.receiving_facility_id and event.patient_id is null
      and event.resource_type = 'order-route' and event.resource_id = route.id::text
      and event.details = jsonb_build_object('routeId', route.id, 'kind', 'lab_request', 'state', 'sent')));
  -- The guard refuses changing the attestation, even for the owner.
  begin
    update ehr.order_routes set attested_by_name = 'Someone Else' where id = route.id;
    perform pg_temp.assert('guard refuses an attestation change', false);
  exception when object_not_in_prerequisite_state then
    perform pg_temp.assert('guard refuses an attestation change', sqlerrm = 'ORDER_ROUTE_IMMUTABLE');
  end;
  begin
    update ehr.order_routes set patient_agreement = 'clinician_attested', row_version = row_version + 1
     where id = route.id;
    perform pg_temp.assert('guard refuses an update without its event', false);
  exception when object_not_in_prerequisite_state then
    perform pg_temp.assert('guard refuses an update without its event', sqlerrm = 'ORDER_ROUTE_IMMUTABLE');
  end;
  begin
    delete from ehr.order_routes where id = route.id;
    perform pg_temp.assert('guard refuses a delete', false);
  exception when object_not_in_prerequisite_state then
    perform pg_temp.assert('guard refuses a delete', sqlerrm = 'ORDER_ROUTE_IMMUTABLE');
  end;
end $$;
-- In B's Incoming at once, without the patient or the clinical information.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.assert('in Incoming at once', exists (select 1 from lab.list_order_routes('incoming', null) incoming
  where incoming.route_id = 'e4c70000-0000-4000-8000-000000000001' and incoming.view_level = 'preview'
    and incoming.test_name = 'Haemoglobin' and incoming.orderer_name = 'Ada Doctor'
    and incoming.orderer_licence_body = 'MDCN' and incoming.attempts_left = 5));
reset role;
-- A clinician's order: no licence on record; DX's revoked attested grant: none.
set local role hid_ehr_api_runtime;
select pg_temp.check('clinician sends', $s$select pg_temp.send(12, 'lab_request', 'e4c60000-0000-4000-8000-000000000012',
  'e4c21000-0000-4000-8000-000000000002', 'p4c-send-clinician-01')$s$, 'ok');
select pg_temp.check('a doctor whose attested grant was revoked sends', $s$select pg_temp.send(19, 'lab_request',
  'e4c60000-0000-4000-8000-000000000019', 'e4c21000-0000-4000-8000-000000000002', 'p4c-send-revoked-0001')$s$, 'ok');
reset role;
select pg_temp.assert('no licence for a clinician or a revoked grant',
  (select count(*) from ehr.order_routes route
    where route.source_lab_request_id in ('e4c60000-0000-4000-8000-000000000012', 'e4c60000-0000-4000-8000-000000000019')
      and route.orderer_licence_body is null and route.orderer_licence_number is null) = 2);
-- A prescription draft to PH1.
set local role hid_ehr_api_runtime;
select pg_temp.check('a prescription draft to the pharmacy', format($s$select pg_temp.send(11, 'prescription', %L, %L, 'p4c-send-rx-draft-01')$s$,
  current_setting('hid.test.rx_draft'), current_setting('hid.test.facility_2')), 'ok');
reset role;
select pg_temp.assert('prescription snapshot', exists (select 1 from ehr.order_routes route
  join ehr.prescriptions source_order on source_order.id = route.source_prescription_id
  where route.source_prescription_id = current_setting('hid.test.rx_draft')::uuid and route.kind = 'prescription'
    and source_order.status = 'active' and route.source_order_version = source_order.row_version
    and (route.medication_code_system, route.medication_code, route.medication_display, route.dose_quantity,
         route.dose_unit, route.route_code, route.frequency, route.instructions, route.starts_on, route.ends_on,
         route.prescribed_at)
      is not distinct from (source_order.medication_code_system, source_order.medication_code,
         source_order.medication_display, source_order.dose_quantity, source_order.dose_unit, source_order.route_code,
         source_order.frequency, source_order.instructions, source_order.starts_on, source_order.ends_on,
         source_order.created_at)
    and route.attestation_text_version = 'order-route-prescription-attestation-v1'
    and route.test_code is null));

-- 5. Refusals.
set local role hid_ehr_api_runtime;
select pg_temp.check('replay answers the stored route', $s$select replayed from ehr.send_order_route(gen_random_uuid(), 'lab_request',
    'e4c30000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000000', gen_random_uuid(), 9,
    gen_random_uuid(), 'order-route-lab-attestation-v1', 'p4c-send-draft-000001', repeat('1', 64))$s$, 'ok');
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.assert('replay is the same route', (select sent.route_id = 'e4c70000-0000-4000-8000-000000000001'
  and sent.replayed and sent.state = 'sent' from ehr.send_order_route(gen_random_uuid(), 'lab_request',
    'e4c30000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000000', gen_random_uuid(), 9,
    gen_random_uuid(), 'order-route-lab-attestation-v1', 'p4c-send-draft-000001', repeat('1', 64)) sent));
select pg_temp.check('reused key', $s$select * from ehr.send_order_route(gen_random_uuid(), 'lab_request',
    'e4c30000-0000-4000-8000-000000000001', gen_random_uuid(), gen_random_uuid(), 1,
    gen_random_uuid(), 'order-route-lab-attestation-v1', 'p4c-send-draft-000001', repeat('2', 64))$s$,
  'P0001 IDEMPOTENCY_KEY_REUSED');
select pg_temp.check('a live route', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-live-000001')$s$,
  current_setting('hid.test.draft'), 'e4c21000-0000-4000-8000-000000000002'), 'P0001 ORDER_ROUTE_ALREADY_SENT');
select pg_temp.check('another kind''s attestation', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-kind-000001',
  'order-route-prescription-attestation-v1')$s$, current_setting('hid.test.active_2'), current_setting('hid.test.facility_1')),
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('an unknown attestation', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-unknown-0001',
  'order-route-lab-attestation-v9')$s$, current_setting('hid.test.active_2'), current_setting('hid.test.facility_1')),
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('a bad key', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'short')$s$,
  current_setting('hid.test.active_2'), current_setting('hid.test.facility_1')), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('an order on hold', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-held-000001')$s$,
  current_setting('hid.test.held'), current_setting('hid.test.facility_1')), 'P0001 ORDER_ROUTE_ORDER_NOT_ELIGIBLE');
select pg_temp.check('a patient without an account', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-noacct-0001')$s$,
  current_setting('hid.test.no_account'), current_setting('hid.test.facility_1')), 'P0001 ORDER_ROUTE_PATIENT_APP_REQUIRED');
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('a stale version', format($s$select * from ehr.send_order_route(gen_random_uuid(), 'lab_request',
    'e4c30000-0000-4000-8000-000000000001', %L, 'e4c50000-0000-4000-8000-000000000001', 7, %L,
    'order-route-lab-attestation-v1', 'p4c-send-stale-000001', repeat('3', 64))$s$,
  current_setting('hid.test.active_2'), current_setting('hid.test.facility_1')), 'P0001 ORDER_ROUTE_VERSION_CONFLICT');
select pg_temp.check('another patient''s order', format($s$select * from ehr.send_order_route(gen_random_uuid(), 'lab_request',
    'e4c30000-0000-4000-8000-000000000002', %L, 'e4c50000-0000-4000-8000-000000000001', 1, %L,
    'order-route-lab-attestation-v1', 'p4c-send-other-000001', repeat('3', 64))$s$,
  current_setting('hid.test.active_2'), current_setting('hid.test.facility_1')), 'P0002 ORDER_NOT_FOUND');
reset role;
-- The newest attestation text is required (owner SQL seeds a v2 text).
insert into ehr.order_route_attestation_texts (version, kind, text, created_at)
values ('order-route-lab-attestation-v2', 'lab_request',
  'I confirm that {patient} agreed that {orderingFacility} sends this test request to {receivingFacility} (v2).',
  clock_timestamp() + interval '1 second');
set local role hid_ehr_api_runtime;
select pg_temp.check('an outdated attestation', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-outdated-01')$s$,
  current_setting('hid.test.active_2'), current_setting('hid.test.facility_1')), 'P0001 ORDER_ROUTE_ATTESTATION_OUTDATED');
select pg_temp.check('the newest attestation', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-current-01',
  'order-route-lab-attestation-v2')$s$, current_setting('hid.test.active_2'), current_setting('hid.test.facility_1')), 'ok');
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.assert('C24 now answers v2', (select attestation.version from ehr.order_route_attestation_text('lab_request')
  attestation) = 'order-route-lab-attestation-v2');
reset role;
-- The order in same-facility Lab work: LA (lab at GH, with consent) accepts
-- active_3 into GH's own Lab through the Lab runtime (which gets the order
-- from the EHR, here a copy).
create temp table order_copy as
  select * from ehr.lab_requests source_order where source_order.id = current_setting('hid.test.active_3')::uuid;
grant select on order_copy to hid_lab_api_runtime;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(14, 'e4c21000-0000-4000-8000-000000000001');
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, priority, test_code_system, test_code, test_name,
  clinical_indication, requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key,
  request_sha256, correlation_id)
select gen_random_uuid(), source_order.patient_id, source_order.facility_id, source_order.facility_id,
  source_order.id, source_order.row_version, source_order.encounter_id, source_order.priority,
  source_order.test_code_system, source_order.test_code, source_order.test_display, source_order.clinical_information,
  source_order.created_by, source_order.created_at, 'e4c10000-0000-4000-8000-000000000014',
  'e4c13000-0000-4000-8000-000000000014', 'p4c-same-facility-work-1', repeat('4', 64), 'p4c-same-facility-work'
  from order_copy source_order;
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.check('the order in Lab work', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-inwork-0001',
  'order-route-lab-attestation-v2')$s$, current_setting('hid.test.active_3'), current_setting('hid.test.facility_1')),
  'P0001 ORDER_ROUTE_ORDER_IN_WORK');
reset role;
-- A stale sent route (owner SQL moves the route 8 days back, triggers off) is
-- stored expired by the next send, which then succeeds.
set local role hid_ehr_api_runtime;
select pg_temp.check('send active_5', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-stale-route1',
  'order-route-lab-attestation-v2')$s$, current_setting('hid.test.active_5'), current_setting('hid.test.facility_1')), 'ok');
reset role;
set local session_replication_role = replica;
update ehr.order_routes set created_at = created_at - interval '8 days', respond_by = respond_by - interval '8 days'
 where source_lab_request_id = current_setting('hid.test.active_5')::uuid;
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.check('send again after the first lapsed', format($s$select pg_temp.send(11, 'lab_request', %L, %L,
  'p4c-send-stale-route2', 'order-route-lab-attestation-v2')$s$, current_setting('hid.test.active_5'),
  'e4c21000-0000-4000-8000-000000000002'), 'ok');
reset role;
select pg_temp.assert('the stale route stored expired', (select array_agg(route.state || ':' || coalesce(route.ended_kind, '')
    order by route.created_at) from ehr.order_routes route
  where route.source_lab_request_id = current_setting('hid.test.active_5')::uuid)
  = array['expired:not_accepted', 'sent:']);
-- The 5-route cap: active_6 sent and withdrawn five times.
set local role hid_ehr_api_runtime;
do $$
declare
  attempt integer;
  sent_route uuid;
begin
  for attempt in 1..5 loop
    sent_route := pg_temp.send(11, 'lab_request', current_setting('hid.test.active_6')::uuid,
      current_setting('hid.test.facility_1')::uuid, 'p4c-send-cap-' || lpad(attempt::text, 8, '0'),
      'order-route-lab-attestation-v2');
    perform ehr.withdraw_order_route(sent_route, 'lab_request', current_setting('hid.test.active_6')::uuid, 1,
      'sent_in_error');
  end loop;
end $$;
select pg_temp.check('a sixth route', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-cap-00000006',
  'order-route-lab-attestation-v2')$s$, current_setting('hid.test.active_6'), current_setting('hid.test.facility_1')),
  'P0001 ORDER_ROUTE_RESEND_LIMIT');
reset role;

-- 6. Each limit at its boundary (owner SQL seeds synthetic routes, triggers
-- and keys off, then removes them). Inside each savepoint the outcomes go to
-- psql variables, which the rollback to the savepoint keeps, and are recorded
-- after it.
create function pg_temp.seed_routes(how_many integer, sender_membership uuid, ordering uuid, receiving uuid,
  receiving_org uuid, label text)
returns void language sql as $f$
  insert into ehr.order_routes (id, kind, patient_id, ordering_organization_id, ordering_facility_id,
    source_lab_request_id, source_encounter_id, source_order_version, receiving_organization_id,
    receiving_facility_id, state, sent_by_account_id, sent_by_membership_id, created_at, respond_by,
    patient_agreement, attestation_text_version, attested_by_name, attested_receiving_facility_name,
    orderer_account_id, orderer_membership_id, orderer_name, test_code_system, test_code, test_display, priority,
    requested_at, idempotency_key, request_sha256, correlation_id)
  select gen_random_uuid(), 'lab_request', 'e4c30000-0000-4000-8000-000000000002', 'e4c20000-0000-4000-8000-000000000001',
    ordering, gen_random_uuid(), 'e4c50000-0000-4000-8000-000000000002', 1, receiving_org, receiving, 'sent',
    'e4c10000-0000-4000-8000-000000000011', sender_membership, statement_timestamp(),
    statement_timestamp() + interval '168 hours',
    'clinician_attested', 'order-route-lab-attestation-v1', 'Seeded Sender', 'Seeded Receiver',
    'e4c10000-0000-4000-8000-000000000011', 'e4c13000-0000-4000-8000-000000000011', 'Seeded Orderer', 'http://loinc.org',
    '718-7', 'Haemoglobin', 'routine', clock_timestamp(), label || '-' || n || '-' || md5(random()::text), repeat('6', 64),
    'p4c-seeded-routes'
    from generate_series(1, how_many) n
$f$;
grant execute on function pg_temp.seed_routes(integer,uuid,uuid,uuid,uuid,text) to hid_ehr_api_runtime;
savepoint limits;
set local session_replication_role = replica;
select pg_temp.seed_routes(100 - (select count(*)::integer from ehr.order_routes route
    where route.sent_by_membership_id = 'e4c13000-0000-4000-8000-000000000011'
      and route.created_at > clock_timestamp() - interval '24 hours') - 1,
  'e4c13000-0000-4000-8000-000000000011', 'e4c21000-0000-4000-8000-000000000001',
  'e4c21000-0000-4000-8000-000000000002', 'e4c20000-0000-4000-8000-000000000002', 'member');
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.outcome(format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-limit-member-0100',
  'order-route-lab-attestation-v2')$s$, current_setting('hid.test.active_7'), current_setting('hid.test.facility_1'))) as kept_limits_1_1 \gset
select pg_temp.outcome(format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-limit-member-0101',
  'order-route-lab-attestation-v2')$s$, current_setting('hid.test.active_4'), current_setting('hid.test.facility_1'))) as kept_limits_1_2 \gset
reset role;
rollback to savepoint limits;
insert into p4c_checks (label, expected, actual) values ('the 100th send of the day', 'ok', :'kept_limits_1_1');
insert into p4c_checks (label, expected, actual) values ('the 101st send of the day', 'P0001 ORDER_ROUTE_SEND_LIMIT', :'kept_limits_1_2');
savepoint limits;
set local session_replication_role = replica;
select pg_temp.seed_routes(199 - (select count(*)::integer from ehr.order_routes route
    where route.ordering_facility_id = 'e4c21000-0000-4000-8000-000000000001'
      and route.receiving_facility_id = current_setting('hid.test.facility_1')::uuid
      and route.created_at > clock_timestamp() - interval '24 hours'),
  'e4c13000-0000-4000-8000-000000000012', 'e4c21000-0000-4000-8000-000000000001',
  current_setting('hid.test.facility_1')::uuid, current_setting('hid.test.org_1')::uuid, 'pair');
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.outcome(format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-limit-pair-00200',
  'order-route-lab-attestation-v2')$s$, current_setting('hid.test.active_7'), current_setting('hid.test.facility_1'))) as kept_limits_2_1 \gset
select pg_temp.outcome(format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-limit-pair-00201',
  'order-route-lab-attestation-v2')$s$, current_setting('hid.test.active_4'), current_setting('hid.test.facility_1'))) as kept_limits_2_2 \gset
reset role;
rollback to savepoint limits;
insert into p4c_checks (label, expected, actual) values ('the 200th send of the pair', 'ok', :'kept_limits_2_1');
insert into p4c_checks (label, expected, actual) values ('the 201st send of the pair', 'P0001 ORDER_ROUTE_PAIR_LIMIT', :'kept_limits_2_2');
savepoint limits;
set local session_replication_role = replica;
select pg_temp.seed_routes(499 - (select count(*)::integer from ehr.order_routes route
    where route.receiving_facility_id = 'e4c21000-0000-4000-8000-000000000002' and route.state = 'sent'
      and route.respond_by > clock_timestamp()),
  'e4c13000-0000-4000-8000-000000000012', 'e4c21000-0000-4000-8000-000000000003',
  'e4c21000-0000-4000-8000-000000000002', 'e4c20000-0000-4000-8000-000000000002', 'busy');
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.outcome(format($s$select pg_temp.send(11, 'lab_request', %L,
  'e4c21000-0000-4000-8000-000000000002', 'p4c-limit-busy-00500', 'order-route-lab-attestation-v2')$s$,
  current_setting('hid.test.active_7'))) as kept_limits_3_1 \gset
select pg_temp.outcome(format($s$select pg_temp.send(11, 'lab_request', %L,
  'e4c21000-0000-4000-8000-000000000002', 'p4c-limit-busy-00501', 'order-route-lab-attestation-v2')$s$,
  current_setting('hid.test.active_4'))) as kept_limits_3_2 \gset
reset role;
rollback to savepoint limits;
insert into p4c_checks (label, expected, actual) values ('the 500th open route at a destination', 'ok', :'kept_limits_3_1');
insert into p4c_checks (label, expected, actual) values ('the 501st open route at a destination', 'P0001 ORDER_ROUTE_DESTINATION_BUSY', :'kept_limits_3_2');

-- A deny directive of P naming L1 (owner SQL; no runtime writes directives;
-- directives are append-only, so this comes last of the sends).
insert into identity.consent_directives (id, patient_id, current_version) values
  ('e4c80000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000001', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, starts_at, source_reference, reason, content_sha256)
values (gen_random_uuid(), 'e4c80000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000001', 1,
  'active', 'deny', 'facility', current_setting('hid.test.facility_1')::uuid, clock_timestamp() - interval '1 minute',
  'p4c-suite', 'The patient asked not to use this laboratory', repeat('5', 64));
set local role hid_ehr_api_runtime;
select pg_temp.check('a deny directive', format($s$select pg_temp.send(11, 'lab_request', %L, %L, 'p4c-send-deny-000001',
  'order-route-lab-attestation-v2')$s$, current_setting('hid.test.active_4'), current_setting('hid.test.facility_1')),
  'P0001 ORDER_ROUTE_PATIENT_DENIED');
reset role;
-- 7. The directory (C19), as the Identity runtime.
set local role hid_identity_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001', 'healthcare-operations');
select pg_temp.assert('directory finds the reviewed and governed laboratories',
  (select array_agg(found.facility_name order by found.facility_name)
     from identity.search_order_destinations('laboratory', 'P4c') found)
  = array['P4c Governed Laboratory', 'P4c Other Check Laboratory Ltd', 'P4c Sign-up Laboratory Ltd',
      'P4c Two Site Lab A'],
  (select string_agg(found.facility_name, ', ') from identity.search_order_destinations('laboratory', 'P4c') found));
select pg_temp.assert('directory answers the registered address and probation',
  (select found.registered_address = '2 Governed Road, Ikeja, Lagos' and not found.new_on_health_id
     and found.organization_name = 'P4c Governed Diagnostics Ltd'
     from identity.search_order_destinations('lab_request', 'Governed Lab') found)
  and (select found.new_on_health_id and found.registered_address = '1 Sign-up Street, Yaba, Lagos'
     from identity.search_order_destinations('laboratory', 'Sign-up Lab') found));
select pg_temp.assert('directory finds the pharmacy only for prescriptions',
  (select array_agg(found.facility_name order by found.facility_name)
     from identity.search_order_destinations('pharmacy', 'P4c') found)
    = array['P4c Governed Pharmacy', 'P4c Sign-up Pharmacy Ltd']
  and (select count(*) from identity.search_order_destinations('laboratory', 'Pharmacy')) = 0);
select pg_temp.assert('directory escapes the pattern',
  (select count(*) from identity.search_order_destinations('laboratory', '%%%')) = 0
  and (select count(*) from identity.search_order_destinations('laboratory', 'P4c_Sign')) = 0);
select pg_temp.check('directory query too short', $s$select * from identity.search_order_destinations('laboratory', 'ab')$s$,
  '22023 ORDER_DESTINATION_QUERY_INVALID');
select pg_temp.check('directory unknown kind', $s$select * from identity.search_order_destinations('radiology', 'P4c')$s$,
  '22023 ORDER_DESTINATION_QUERY_INVALID');
select pg_temp.as_staff(13, 'e4c21000-0000-4000-8000-000000000001', 'healthcare-operations');
select pg_temp.check('directory as a nurse', $s$select * from identity.search_order_destinations('laboratory', 'P4c')$s$,
  '42501 ORDER_ROUTE_PERMISSION_DENIED');
reset role;

select pg_temp.report();
rollback;
