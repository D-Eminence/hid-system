-- The contract fields of 0089 (item 4, B1-B3, owner decisions D1-D10 of
-- 2026-10-26 with D4's alternative). Rollback-only. Every command runs as
-- the exact runtime role (hid_lab_api_runtime, hid_pharmacy_api_runtime,
-- hid_identity_api_runtime, hid_ehr_api_runtime), in the context the
-- services set; owner SQL is marked.
--   1. B3, support's summary (C20): destination {receivingTypes, review} per
--      facility (governed hospital and laboratory, reviewed laboratory and
--      pharmacy, pending, released, reviewed as Other, suspended facility,
--      suspended product, legacy facility, legacy laboratory, a hospital with
--      a rejected laboratory application, one facility with both products,
--      the site without the product); listed keeps its four keys and nothing
--      names a verification method; the panel's form rule never meets C23's
--      P0002;
--   2. B1, whether this facility receives (lab.order_route_receives_here(),
--      pharmacy.order_route_receives_here()): true, false (each of H4's
--      steps), NULL without the kind's receive permission, 42501 at a
--      suspended or released facility; the same answers with either switch
--      off and under another purpose; support lists and unlists; 42501
--      without a correlation id, without a membership, at another facility;
--      22023 for another kind (owner); equal to H4 as owner for every holder;
--      no audit row, no row lock, no lock beyond ACCESS SHARE; the runtimes
--      reach only their own wrappers;
--   3. D4's alternative, whether orders wait or are held here
--      (lab.order_routes_here(), pharmacy.order_routes_here()): waiting
--      before and after respond_by; held for accepted, completed and
--      cancelled routes within and after access_ends_at; another facility's
--      and another kind's routes never count; nothing without the receive
--      permission; the same at a governed and a self-signed-up facility, at
--      an unlisted one and at one whose product is suspended, with either
--      switch off; an order waiting at the unlisted facility, or while
--      orders between facilities are off, is refused by Accept and can still
--      be declined; a route sent 51 days ago is still held (the read's bound),
--      and the two CHECKs that bound rests on are still 0086's, validated;
--      every case equals Incoming's and route access's own predicates,
--      unbounded, evaluated as owner; booleans only;
--   4. B2, support's find (C21): for every route of the suite (sent, sent past
--      respond_by, accepted, accepted past its window, completed in and past
--      its window, completed ended by support, by a release after its access
--      had ended, and by the wrong-patient report, cancelled with a read
--      window and by the wrong-patient report, declined, withdrawn, and a
--      completed route constructed with ended_at and a future
--      access_ends_at), closable equals "support's Close (C22) acts now",
--      access_ends_at equals the stored column, and a live route that is not
--      closable is completed; the 13 columns the previous Identity names
--      still answer the same values, and select * answers 15.
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


-- Owner SQL: item 4's facilities (SPEC-FINAL 6.1). LX (51) a legacy
-- laboratory: an approved self-service application that an administrator
-- reviewed (reviewed_by_account_id is set, so the self-service state skips
-- it) and an active laboratory product; HR (52) a governed hospital with a
-- rejected laboratory application; DU (53) a governed organization with an
-- approved laboratory and an approved pharmacy application and both
-- products at one facility. Members: 51 LX lab, 52 HR lab, 53 DU lab, 54 DU
-- pharmacist (subject synthetic:p4c:m<n>).
insert into identity.organizations (id, name, slug) values
  ('e4c20000-0000-4000-8000-000000000051', 'P4c Legacy Reviewed Laboratory Ltd', 'p4c-legacy-reviewed-lab'),
  ('e4c20000-0000-4000-8000-000000000052', 'P4c Rejected Lab Hospital Ltd', 'p4c-rejected-lab-hospital'),
  ('e4c20000-0000-4000-8000-000000000053', 'P4c Lab and Pharmacy Ltd', 'p4c-lab-and-pharmacy');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e4c21000-0000-4000-8000-000000000051', 'e4c20000-0000-4000-8000-000000000051', 'P4c Legacy Reviewed Laboratory',
   'P4C-LX', 'Africa/Lagos', true, 'verified'),
  ('e4c21000-0000-4000-8000-000000000052', 'e4c20000-0000-4000-8000-000000000052', 'P4c Rejected Lab Hospital',
   'P4C-HR', 'Africa/Lagos', true, 'verified'),
  ('e4c21000-0000-4000-8000-000000000053', 'e4c20000-0000-4000-8000-000000000053', 'P4c Lab and Pharmacy',
   'P4C-DU', 'Africa/Lagos', true, 'verified');
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at, approval_mode,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status)
select ('e4c22000-0000-4000-8000-0000000000' || g.n)::uuid, g.product, g.legal_name, g.kind, g.cac,
  'Item Four Admin ' || g.n, 'admin' || g.n || '@p4c-item4.invalid', g.status, 'verified', '88' || g.n,
  clock_timestamp(), ('e4c20000-0000-4000-8000-0000000000' || g.org)::uuid,
  ('e4c21000-0000-4000-8000-0000000000' || g.org)::uuid, 'e4c10000-0000-4000-8000-000000000001',
  'Reviewed for the item 4 suite', clock_timestamp(), g.mode, g.legal_name, 'Private Company Limited by Shares',
  '2019-05-01', g.n || ' Item Four Road, Ikeja, Lagos', 'active'
  from (values (51, 51, 'laboratory', 'laboratory', 'RC9946051', 'P4c Legacy Reviewed Laboratory Ltd', 'approved',
                'self_service'),
               (52, 52, 'ehr', 'hospital', 'RC9946052', 'P4c Rejected Lab Hospital Ltd', 'approved', 'admin_review'),
               (55, 52, 'laboratory', 'laboratory', 'RC9946052', 'P4c Rejected Lab Hospital Ltd', 'rejected',
                'admin_review'),
               (53, 53, 'laboratory', 'laboratory', 'RC9946053', 'P4c Lab and Pharmacy Ltd', 'approved', 'admin_review'),
               (54, 53, 'pharmacy', 'pharmacy', 'RC9946054', 'P4c Lab and Pharmacy Ltd', 'approved', 'admin_review'))
       g(n, org, product, kind, cac, legal_name, status, mode);
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
select ('e4c20000-0000-4000-8000-0000000000' || g.org)::uuid, g.product,
  ('e4c21000-0000-4000-8000-0000000000' || g.org)::uuid, 'active', ('e4c22000-0000-4000-8000-0000000000' || g.n)::uuid
  from (values (51, 51, 'laboratory'), (52, 52, 'ehr'), (53, 53, 'laboratory'), (54, 53, 'pharmacy')) g(n, org, product);
insert into auth.accounts (id, subject, email, display_name, status)
select ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:p4c:m' || s.n,
  'm' || s.n || '@p4c-staff.invalid', s.full_name, 'active'
  from (values (51, 'Legacy Reviewed Lab'), (52, 'Hospital Lab Scientist'), (53, 'Dual Site Lab'),
               (54, 'Dual Site Pharmacist')) s(n, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, 'm' || s.n || '@p4c-staff.invalid', 'verified', s.role
  from (values (51, 'Legacy Reviewed Lab', 'lab'), (52, 'Hospital Lab Scientist', 'lab'), (53, 'Dual Site Lab', 'lab'),
               (54, 'Dual Site Pharmacist', 'pharmacist')) s(n, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c20000-0000-4000-8000-0000000000' || s.org)::uuid,
  ('e4c21000-0000-4000-8000-0000000000' || s.org)::uuid, s.role, s.role, true, true
  from (values (51, 51, 'lab'), (52, 52, 'lab'), (53, 53, 'lab'), (54, 53, 'pharmacist')) s(n, org, role);
-- Roles by owner SQL with the review gate off (as the send suite gives the
-- pending administrator a role): item 4's members; a PH1 member given lab
-- (PB1) and an L1 member given pharmacist (LB1), so that each wrapper meets
-- a holder at a facility without its product (S3).
set local session_replication_role = replica;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e4c11000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c21000-0000-4000-8000-0000000000' || s.org)::uuid, 'P4c item 4 suite role'
  from (values (51, 51, 'lab'), (52, 52, 'lab'), (53, 53, 'lab'), (54, 53, 'pharmacist')) s(n, org, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values (gen_random_uuid(), current_setting('hid.test.account_2')::uuid, 'lab', 'facility',
  current_setting('hid.test.membership_2')::uuid, current_setting('hid.test.facility_2')::uuid, 'Owner SQL lab role at PH1'),
  (gen_random_uuid(), current_setting('hid.test.account_1')::uuid, 'pharmacist', 'facility',
  current_setting('hid.test.membership_1')::uuid, current_setting('hid.test.facility_1')::uuid,
  'Owner SQL pharmacist role at L1');
set local session_replication_role = origin;

-- Sign-up 8: laboratory L8 (reviewed, lab), released in section 4 after its
-- completed route's access has ended (CC4's case).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'p4c-item4-signup', true),
  set_config('app.purpose_of_use', '', true), set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select pg_temp.p4c_sign_up(8, 'laboratory', 'laboratory', 'RC9945008', 'Wale Eighth Lab Admin',
  'wale@p4c-lab-eight.invalid', 'P4c Eighth Laboratory Ltd');
select pg_temp.as_platform(1);
select identity.admin_review_self_service_facility(current_setting('hid.test.app_8')::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('unreviewed') application
    where application.application_id = current_setting('hid.test.app_8')::uuid),
  'Support reviewed this laboratory for the suite', 'lab', 'cac_registered_contact', 'MLSCN', 'MLS/10008');
reset role;
select set_config('hid.test.membership_8',
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.account_8')::uuid), true),
  set_config('hid.test.subject_8',
  (select account.subject from auth.accounts account where account.id = current_setting('hid.test.account_8')::uuid),
  true);

-- Item 4's helpers. A session of an item 4 member (51-54) at its facility.
create function pg_temp.as_member(member integer, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:p4c:m' || member, true),
    set_config('app.membership_id', 'e4c13000-0000-4000-8000-0000000000' || member, true),
    set_config('hid.test.actor_account', 'e4c10000-0000-4000-8000-0000000000' || member, true),
    set_config('app.facility_id', 'e4c21000-0000-4000-8000-0000000000'
      || case when member = 54 then 53 else member end, true),
    set_config('app.correlation_id', 'p4c-item4-' || member || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true);
$f$;
-- A statement's single value as text ('null' for NULL), or its SQLSTATE and
-- message.
create function pg_temp.answer(statement text)
returns text language plpgsql as $f$
declare value text;
begin
  execute statement into value;
  return coalesce(value, 'null');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- Both facts of a wrapper pair ('lab' or 'pharmacy') for the session, as the
-- services read them: receives, then routesHere.
create function pg_temp.facts(wrapper text)
returns text language sql as $f$
  select pg_temp.answer(format('select %s.order_route_receives_here()::text', wrapper)) || ' '
    || pg_temp.answer(format('select %s.order_routes_here()::text', wrapper))
$f$;
create function pg_temp.expect_facts(label text, wrapper text, expected text)
returns void language sql as $f$
  insert into p4c_checks (label, expected, actual) values (label, expected, pg_temp.facts(wrapper));
$f$;
-- Accepting as the receiving runtimes do (the lifecycle suite's): L1's or
-- PH1's administrator, or sign-up n's; a governed member by its session.
create function pg_temp.accept_lab(route uuid, n integer, health_id text default 'HID-P4CPATP')
returns uuid language plpgsql as $f$
declare accepted record;
begin
  perform pg_temp.as_signup_admin(n);
  select * into accepted from lab.accept_order_route(route, 1, 'health_id', health_id,
    'p4c-item4-accept-' || substr(md5(route::text), 1, 12), repeat('a', 64));
  if accepted.result is distinct from 'accepted' then
    raise exception 'P4c lab acceptance of % answered %', route, accepted.result;
  end if;
  return accepted.work_item_id;
end
$f$;
create function pg_temp.accept_lab_here(route uuid)
returns uuid language plpgsql as $f$
declare accepted record;
begin
  select * into accepted from lab.accept_order_route(route, 1, 'health_id', 'HID-P4CPATP',
    'p4c-item4-accept-' || substr(md5(route::text), 1, 12), repeat('a', 64));
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
    'Patient collected the prescription', 'p4c-item4-accept-' || substr(md5(route::text), 1, 12), repeat('a', 64));
  if accepted.result is distinct from 'accepted' then
    raise exception 'P4c pharmacy acceptance of % answered %', route, accepted.result;
  end if;
  return accepted.work_item_id;
end
$f$;
-- Owner SQL: moves a route's clock back (triggers off): created, respond-by
-- and acceptance by created_by; completion and both windows by completed_by.
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
create function pg_temp.route(route uuid) returns ehr.order_routes language sql stable as $f$
  select * from ehr.order_routes where id = route
$f$;
create function pg_temp.edit_lab(order_id uuid, change text, reason text)
returns void language plpgsql as $f$
begin
  perform pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
  perform set_config('app.change_reason', reason, true);
  update ehr.lab_requests set status = change where id = order_id;
end
$f$;
-- A new lab request (or prescription) of DA for P, sent to a facility:
-- answers the route; its order is hid.test.order_<label>.
create function pg_temp.new_route(label text, kind text, receiving uuid)
returns uuid language plpgsql as $f$
declare order_id uuid;
begin
  order_id := case kind when 'lab_request' then pg_temp.lab_request(1, 'active')
                        else pg_temp.prescription(1, 'active') end;
  perform set_config('hid.test.order_' || label, order_id::text, true);
  return pg_temp.send(11, kind, order_id, receiving, 'p4c-item4-send-' || label || '-0000');
end
$f$;
-- Whether support's Close (C22) would act on a route now, at the version
-- support's find answered: 'acts' (the close is undone), or C22's refusal.
create function pg_temp.close_acts(route uuid, current_version bigint)
returns text language plpgsql as $f$
begin
  begin
    perform identity.admin_close_order_route(route, current_version, 'Support checks whether Close acts');
    raise exception using errcode = 'P0001', message = 'P4C_CLOSE_ACTED';
  exception when others then
    if sqlerrm = 'P4C_CLOSE_ACTED' then
      return 'acts';
    end if;
    return sqlstate || ' ' || sqlerrm;
  end;
end
$f$;
-- What support's panel would do (C23), undone: 'acts' when listing or
-- unlisting the facility acts, or C23's refusal.
create function pg_temp.listing_acts(facility uuid)
returns text language plpgsql as $f$
declare
  wanted boolean;
  refused text;
begin
  foreach wanted in array array[true, false] loop
    begin
      perform identity.admin_set_order_route_destination(facility, wanted, 'Support checks whether listing acts');
      raise exception using errcode = 'P0001', message = 'P4C_LISTING_ACTED';
    exception when others then
      if sqlerrm = 'P4C_LISTING_ACTED' then
        return 'acts';
      end if;
      refused := sqlstate || ' ' || sqlerrm;
      if refused <> '23505 ORDER_ROUTE_DESTINATION_UNCHANGED' then
        return refused;
      end if;
    end;
  end loop;
  return refused;
end
$f$;
create function pg_temp.summary(facility uuid) returns jsonb language sql as $f$
  select identity.admin_order_route_summary(facility)
$f$;
create temp table item4_cases (n integer primary key, label text not null, runtime text not null, setter text not null,
  facility uuid not null, kind text not null, receives text not null, routes text not null) on commit drop;
create temp table item4_matrix (tag text not null, n integer not null, receives text not null, routes text not null,
  primary key (tag, n)) on commit drop;
create temp table item4_facilities (label text primary key, facility uuid not null) on commit drop;
grant select on item4_cases, item4_facilities to hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_ehr_api_runtime;
-- Every case of B1 and D4, as its runtime with its session (and an optional
-- other purpose): both facts, by tag.
create function pg_temp.run_matrix(tag text, purpose text default null)
returns void language plpgsql as $f$
declare
  item record;
  got_receives text;
  got_routes text;
  wrapper text;
begin
  for item in select * from item4_cases order by n loop
    execute format('set local role %I', item.runtime);
    execute item.setter;
    if purpose is not null then
      perform set_config('app.purpose_of_use', purpose, true);
    end if;
    wrapper := case item.kind when 'lab_request' then 'lab' else 'pharmacy' end;
    got_receives := pg_temp.answer(format('select %s.order_route_receives_here()::text', wrapper));
    got_routes := pg_temp.answer(format('select %s.order_routes_here()::text', wrapper));
    execute 'reset role';
    insert into item4_matrix (tag, n, receives, routes) values (tag, item.n, got_receives, got_routes);
  end loop;
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
insert into item4_facilities (label, facility) values
  ('GH governed hospital', 'e4c21000-0000-4000-8000-000000000001'),
  ('GL governed laboratory', 'e4c21000-0000-4000-8000-000000000002'),
  ('H3 governed hospital', 'e4c21000-0000-4000-8000-000000000003'),
  ('GP governed pharmacy', 'e4c21000-0000-4000-8000-000000000004'),
  ('GL2a governed laboratory, first site', 'e4c21000-0000-4000-8000-000000000005'),
  ('GL2b governed laboratory, second site without the product', 'e4c21000-0000-4000-8000-000000000008'),
  ('GL3 governed laboratory with a receptionist only', 'e4c21000-0000-4000-8000-000000000006'),
  ('LL legacy facility without an application', 'e4c21000-0000-4000-8000-000000000007'),
  ('L1 reviewed laboratory', current_setting('hid.test.facility_1')::uuid),
  ('PH1 reviewed pharmacy', current_setting('hid.test.facility_2')::uuid),
  ('LO laboratory reviewed as Other', current_setting('hid.test.facility_3')::uuid),
  ('LP pending laboratory', current_setting('hid.test.facility_4')::uuid),
  ('LS suspended laboratory', current_setting('hid.test.facility_5')::uuid),
  ('H6 pending hospital', current_setting('hid.test.facility_6')::uuid),
  ('LR released laboratory', current_setting('hid.test.facility_7')::uuid),
  ('L8 reviewed laboratory', current_setting('hid.test.facility_8')::uuid),
  ('LX legacy laboratory', 'e4c21000-0000-4000-8000-000000000051'),
  ('HR hospital with a rejected laboratory application', 'e4c21000-0000-4000-8000-000000000052'),
  ('DU laboratory and pharmacy at one facility', 'e4c21000-0000-4000-8000-000000000053');
-- B1 and D4 cases with nothing sent yet: n, label, runtime, session, facility,
-- kind, receives, routesHere.
insert into item4_cases (n, label, runtime, setter, facility, kind, receives, routes)
select v.n, v.label, v.runtime, v.setter, v.facility, v.kind, v.receives,
  case when v.receives in ('true', 'false') then '{"held": false, "waiting": false}' else v.receives end
  from (values
  (1, 'GLM at the governed laboratory GL', 'hid_lab_api_runtime',
   'select pg_temp.as_staff(21, ''e4c21000-0000-4000-8000-000000000002'')',
   'e4c21000-0000-4000-8000-000000000002'::uuid, 'lab_request', 'true'),
  (2, 'LB1 at the reviewed laboratory L1', 'hid_lab_api_runtime', 'select pg_temp.as_signup_admin(1)',
   current_setting('hid.test.facility_1')::uuid, 'lab_request', 'true'),
  (3, 'LB2 at L1', 'hid_lab_api_runtime',
   format('select pg_temp.as_staff(31, %L)', current_setting('hid.test.facility_1')),
   current_setting('hid.test.facility_1')::uuid, 'lab_request', 'true'),
  (4, 'LA at the governed hospital GH (step 3: no laboratory product)', 'hid_lab_api_runtime',
   'select pg_temp.as_staff(14, ''e4c21000-0000-4000-8000-000000000001'')',
   'e4c21000-0000-4000-8000-000000000001'::uuid, 'lab_request', 'false'),
  (5, 'LO at the laboratory reviewed as Other (step 4: not listed by default)', 'hid_lab_api_runtime',
   'select pg_temp.as_signup_admin(3)', current_setting('hid.test.facility_3')::uuid, 'lab_request', 'false'),
  (6, 'LX at the legacy laboratory (step 2)', 'hid_lab_api_runtime', 'select pg_temp.as_member(51)',
   'e4c21000-0000-4000-8000-000000000051'::uuid, 'lab_request', 'false'),
  (7, 'PB1 given lab at the pharmacy PH1 (step 3)', 'hid_lab_api_runtime', 'select pg_temp.as_signup_admin(2)',
   current_setting('hid.test.facility_2')::uuid, 'lab_request', 'false'),
  (8, 'GL2b member at the site without the product (step 3)', 'hid_lab_api_runtime',
   'select pg_temp.as_staff(27, ''e4c21000-0000-4000-8000-000000000008'')',
   'e4c21000-0000-4000-8000-000000000008'::uuid, 'lab_request', 'false'),
  (9, 'LL member at the legacy facility without an application (step 2)', 'hid_lab_api_runtime',
   'select pg_temp.as_staff(25, ''e4c21000-0000-4000-8000-000000000007'')',
   'e4c21000-0000-4000-8000-000000000007'::uuid, 'lab_request', 'false'),
  (10, 'DUL at the facility with both products', 'hid_lab_api_runtime', 'select pg_temp.as_member(53)',
   'e4c21000-0000-4000-8000-000000000053'::uuid, 'lab_request', 'true'),
  (11, 'HR lab member at the hospital with a rejected laboratory application (step 3)', 'hid_lab_api_runtime',
   'select pg_temp.as_member(52)', 'e4c21000-0000-4000-8000-000000000052'::uuid, 'lab_request', 'false'),
  (12, 'the second laboratory L8', 'hid_lab_api_runtime', 'select pg_temp.as_signup_admin(8)',
   current_setting('hid.test.facility_8')::uuid, 'lab_request', 'true'),
  (13, 'RB receptionist at L1', 'hid_lab_api_runtime',
   format('select pg_temp.as_staff(32, %L)', current_setting('hid.test.facility_1')),
   current_setting('hid.test.facility_1')::uuid, 'lab_request', 'null'),
  (14, 'PB2 pharmacist at PH1, Lab wrapper', 'hid_lab_api_runtime',
   format('select pg_temp.as_staff(33, %L)', current_setting('hid.test.facility_2')),
   current_setting('hid.test.facility_2')::uuid, 'lab_request', 'null'),
  (15, 'GL3 receptionist', 'hid_lab_api_runtime',
   'select pg_temp.as_staff(24, ''e4c21000-0000-4000-8000-000000000006'')',
   'e4c21000-0000-4000-8000-000000000006'::uuid, 'lab_request', 'null'),
  (16, 'LP pending administrator, no lab role', 'hid_lab_api_runtime', 'select pg_temp.as_signup_admin(4)',
   current_setting('hid.test.facility_4')::uuid, 'lab_request', 'null'),
  (17, 'DUP through the Lab wrapper', 'hid_lab_api_runtime', 'select pg_temp.as_member(54)',
   'e4c21000-0000-4000-8000-000000000053'::uuid, 'lab_request', 'null'),
  (18, 'LS administrator at the suspended laboratory', 'hid_lab_api_runtime', 'select pg_temp.as_signup_admin(5)',
   current_setting('hid.test.facility_5')::uuid, 'lab_request', '42501 Order route staff context is required'),
  (19, 'LR administrator at the released laboratory', 'hid_lab_api_runtime', 'select pg_temp.as_signup_admin(7)',
   current_setting('hid.test.facility_7')::uuid, 'lab_request', '42501 Order route staff context is required'),
  (21, 'PB1 at the reviewed pharmacy PH1', 'hid_pharmacy_api_runtime', 'select pg_temp.as_signup_admin(2)',
   current_setting('hid.test.facility_2')::uuid, 'prescription', 'true'),
  (22, 'PB2 at PH1', 'hid_pharmacy_api_runtime',
   format('select pg_temp.as_staff(33, %L)', current_setting('hid.test.facility_2')),
   current_setting('hid.test.facility_2')::uuid, 'prescription', 'true'),
  (23, 'PA at the governed hospital GH (step 3)', 'hid_pharmacy_api_runtime',
   'select pg_temp.as_staff(15, ''e4c21000-0000-4000-8000-000000000001'')',
   'e4c21000-0000-4000-8000-000000000001'::uuid, 'prescription', 'false'),
  (24, 'LB1 given pharmacist at the laboratory L1 (step 3)', 'hid_pharmacy_api_runtime',
   'select pg_temp.as_signup_admin(1)', current_setting('hid.test.facility_1')::uuid, 'prescription', 'false'),
  (25, 'GP pharmacist at the governed pharmacy', 'hid_pharmacy_api_runtime',
   'select pg_temp.as_staff(22, ''e4c21000-0000-4000-8000-000000000004'')',
   'e4c21000-0000-4000-8000-000000000004'::uuid, 'prescription', 'true'),
  (26, 'DUP at the facility with both products', 'hid_pharmacy_api_runtime', 'select pg_temp.as_member(54)',
   'e4c21000-0000-4000-8000-000000000053'::uuid, 'prescription', 'true'),
  (27, 'LB2 through the Pharmacy wrapper', 'hid_pharmacy_api_runtime',
   format('select pg_temp.as_staff(31, %L)', current_setting('hid.test.facility_1')),
   current_setting('hid.test.facility_1')::uuid, 'prescription', 'null'),
  (28, 'DUL through the Pharmacy wrapper', 'hid_pharmacy_api_runtime', 'select pg_temp.as_member(53)',
   'e4c21000-0000-4000-8000-000000000053'::uuid, 'prescription', 'null')
  ) v(n, label, runtime, setter, facility, kind, receives);

-- 1. B3: support's summary (C20), destination per facility, as the Identity
-- runtime with platform.facility.read.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
create temp table item4_summaries on commit drop as
  select listed.label, listed.facility, pg_temp.summary(listed.facility) as summary from item4_facilities listed;
reset role;
select pg_temp.assert('C20 destination per facility', (select jsonb_object_agg(summary_row.label,
      summary_row.summary -> 'destination') from item4_summaries summary_row)
  = jsonb_build_object(
    'GH governed hospital', jsonb_build_object('receivingTypes', '[]'::jsonb, 'review', 'governed'),
    'GL governed laboratory', jsonb_build_object('receivingTypes', '["laboratory"]'::jsonb, 'review', 'governed'),
    'H3 governed hospital', jsonb_build_object('receivingTypes', '[]'::jsonb, 'review', 'governed'),
    'GP governed pharmacy', jsonb_build_object('receivingTypes', '["pharmacy"]'::jsonb, 'review', 'governed'),
    'GL2a governed laboratory, first site', jsonb_build_object('receivingTypes', '["laboratory"]'::jsonb,
      'review', 'governed'),
    'GL2b governed laboratory, second site without the product', jsonb_build_object('receivingTypes', '[]'::jsonb,
      'review', 'governed'),
    'GL3 governed laboratory with a receptionist only', jsonb_build_object('receivingTypes', '["laboratory"]'::jsonb,
      'review', 'governed'),
    'LL legacy facility without an application', jsonb_build_object('receivingTypes', '[]'::jsonb, 'review', 'legacy'),
    'L1 reviewed laboratory', jsonb_build_object('receivingTypes', '["laboratory"]'::jsonb, 'review', 'reviewed'),
    'PH1 reviewed pharmacy', jsonb_build_object('receivingTypes', '["pharmacy"]'::jsonb, 'review', 'reviewed'),
    'LO laboratory reviewed as Other', jsonb_build_object('receivingTypes', '["laboratory"]'::jsonb,
      'review', 'reviewed'),
    'LP pending laboratory', jsonb_build_object('receivingTypes', '["laboratory"]'::jsonb, 'review', 'pending'),
    'LS suspended laboratory', jsonb_build_object('receivingTypes', '["laboratory"]'::jsonb, 'review', 'reviewed'),
    'H6 pending hospital', jsonb_build_object('receivingTypes', '[]'::jsonb, 'review', 'pending'),
    'LR released laboratory', jsonb_build_object('receivingTypes', '[]'::jsonb, 'review', 'released'),
    'L8 reviewed laboratory', jsonb_build_object('receivingTypes', '["laboratory"]'::jsonb, 'review', 'reviewed'),
    'LX legacy laboratory', jsonb_build_object('receivingTypes', '["laboratory"]'::jsonb, 'review', 'legacy'),
    'HR hospital with a rejected laboratory application', jsonb_build_object('receivingTypes', '[]'::jsonb,
      'review', 'governed'),
    'DU laboratory and pharmacy at one facility', jsonb_build_object('receivingTypes',
      '["laboratory", "pharmacy"]'::jsonb, 'review', 'governed')),
  (select jsonb_object_agg(summary_row.label, summary_row.summary -> 'destination')::text
     from item4_summaries summary_row));
select pg_temp.assert('C20: the laboratory reviewed as Other is not listed, by default',
  (select summary_row.summary -> 'listed' from item4_summaries summary_row
    where summary_row.label = 'LO laboratory reviewed as Other')
  = jsonb_build_object('value', false, 'byDefault', true, 'reason', null, 'setAt', null));
select pg_temp.assert('C20 keeps its keys, listed its four, destination its two; no verification method anywhere',
  (select bool_and((select array_agg(key order by key) from jsonb_object_keys(summary_row.summary) key)
         = array['counterparts', 'destination', 'listed', 'receivedAcceptedLifetime', 'receivedPatientsLifetime']
       and (select array_agg(key order by key) from jsonb_object_keys(summary_row.summary -> 'listed') key)
         = array['byDefault', 'reason', 'setAt', 'value']
       and (select array_agg(key order by key) from jsonb_object_keys(summary_row.summary -> 'destination') key)
         = array['receivingTypes', 'review']
       and summary_row.summary::text !~* '(method|verification|cac_registered_contact|officer_match|regulator_register|in_person)')
     from item4_summaries summary_row));
-- Consistency with H4 (as owner) and with C23 (its refusal, undone).
create temp table item4_consistency on commit drop as
  select summary_row.label, kind.kind,
    (summary_row.summary -> 'destination' -> 'receivingTypes') ? ehr.order_route_destination_type(kind.kind)
      and summary_row.summary -> 'destination' ->> 'review' in ('reviewed', 'governed')
      and (summary_row.summary -> 'listed' ->> 'value')::boolean
      and facility.active and facility.lifecycle_status = 'verified'
      and exists (select 1 from identity.organizations organization
                   where organization.id = facility.organization_id and organization.active)
      and exists (select 1 from identity.staff_facility_memberships membership
                    join auth.accounts account on account.id = membership.account_id
                   where membership.facility_id = facility.id and membership.active
                     and auth.membership_has_permission(account.subject, membership.id, facility.id,
                       ehr.order_route_receive_permission(kind.kind))) as derived,
    identity.order_route_destination_eligible(summary_row.facility, kind.kind) as eligible,
    jsonb_array_length(summary_row.summary -> 'destination' -> 'receivingTypes') > 0
      and summary_row.summary -> 'destination' ->> 'review' in ('pending', 'reviewed', 'governed') as form
    from item4_summaries summary_row
    join identity.facilities facility on facility.id = summary_row.facility
    cross join (values ('lab_request'), ('prescription')) kind(kind);
select pg_temp.assert('C20''s destination with listed, the facility and a receiving member is exactly H4, per kind',
  not exists (select 1 from item4_consistency checked where checked.derived is distinct from checked.eligible)
  and (select count(*) filter (where checked.eligible) from item4_consistency checked) = 8,
  (select string_agg(checked.label || ' ' || checked.kind || ' derived ' || checked.derived || ' H4 '
     || checked.eligible, '; ') from item4_consistency checked where checked.derived is distinct from checked.eligible
     or checked.eligible));
grant select on item4_consistency to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.assert('the panel''s form rule never meets C23''s P0002',
  (select bool_and(pg_temp.listing_acts(listed.facility) not like 'P0002%')
     from item4_facilities listed
    where listed.label in (select checked.label from item4_consistency checked where checked.form)),
  (select string_agg(listed.label || ': ' || pg_temp.listing_acts(listed.facility), '; ')
     from item4_facilities listed
    where listed.label in (select checked.label from item4_consistency checked where checked.form)));
select pg_temp.assert('C23 still accepts the hospital with a rejected laboratory application, where the form is never offered',
  pg_temp.listing_acts('e4c21000-0000-4000-8000-000000000052') = 'acts'
  and pg_temp.listing_acts('e4c21000-0000-4000-8000-000000000001') = 'P0002 ORDER_ROUTE_DESTINATION_NOT_FOUND');
reset role;
-- Owner SQL: the governed laboratory's product suspended (the facility stays
-- active).
update identity.organization_products set status = 'suspended' where facility_id = 'e4c21000-0000-4000-8000-000000000002';
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select pg_temp.assert('C20 at the laboratory whose product is suspended: no receiving type',
  pg_temp.summary('e4c21000-0000-4000-8000-000000000002') -> 'destination'
  = jsonb_build_object('receivingTypes', '[]'::jsonb, 'review', 'governed'));
reset role;
update identity.organization_products set status = 'active' where facility_id = 'e4c21000-0000-4000-8000-000000000002';
set local role hid_ehr_api_runtime;
select pg_temp.check('C20 is not the EHR runtime''s', $s$select identity.admin_order_route_summary(
  'e4c21000-0000-4000-8000-000000000002')$s$, '42501 permission denied for function admin_order_route_summary');
reset role;

-- 2. B1 (and D4 with nothing sent): every case under direct care.
create temp table item4_locks_before on commit drop as
  select lock_row.locktype, lock_row.relation, lock_row.mode from pg_locks lock_row
   where lock_row.pid = pg_backend_pid() and lock_row.granted;
select count(*) as audit_rows_before from audit.events \gset
select pg_temp.run_matrix('direct-care');
select pg_temp.assert('B1 and D4 under direct care: every case as expected',
  not exists (select 1 from item4_cases item join item4_matrix got on got.n = item.n and got.tag = 'direct-care'
               where (got.receives, got.routes) is distinct from (item.receives, item.routes)),
  (select string_agg(item.n || ' ' || item.label || ': ' || got.receives || ' ' || got.routes, '; ' order by item.n)
     from item4_cases item join item4_matrix got on got.n = item.n and got.tag = 'direct-care'
    where (got.receives, got.routes) is distinct from (item.receives, item.routes)));
select pg_temp.assert('B1 equals H4 called as owner for every holder; NULL exactly without the receive permission',
  not exists (select 1 from item4_cases item join item4_matrix got on got.n = item.n and got.tag = 'direct-care'
               where got.receives in ('true', 'false')
                 and got.receives <> identity.order_route_destination_eligible(item.facility, item.kind)::text)
  and (select count(*) from item4_matrix got where got.tag = 'direct-care' and got.receives in ('true', 'false')) = 18
  and (select count(*) from item4_matrix got where got.tag = 'direct-care' and got.receives = 'null') = 7);
select pg_temp.assert('B1 and D4 wrote no audit row', (select count(*) from audit.events) = :audit_rows_before);
create temp table item4_locks_after on commit drop as
  select lock_row.locktype, lock_row.relation, lock_row.mode from pg_locks lock_row
   where lock_row.pid = pg_backend_pid() and lock_row.granted;
create temp view item4_new_locks as
  select after.locktype, after.relation, after.mode from item4_locks_after after
   where after.locktype in ('relation', 'tuple', 'transactionid')
     and not exists (select 1 from item4_locks_before before
                      where before.locktype = after.locktype and before.mode = after.mode
                        and before.relation is not distinct from after.relation)
     and (after.relation is null or after.relation not in (select class.oid from pg_class class
                                                            where class.relpersistence = 't'));
select pg_temp.assert('B1 and D4 took no row lock, wrote nothing, and no lock beyond ACCESS SHARE',
  not exists (select 1 from item4_new_locks new_lock
               where not (new_lock.locktype = 'relation' and new_lock.mode = 'AccessShareLock'))
  and (select count(*) from item4_locks_after after where after.locktype = 'transactionid')
    = (select count(*) from item4_locks_before before where before.locktype = 'transactionid'),
  (select string_agg(new_lock.locktype || ' ' || coalesce(new_lock.relation::regclass::text, '') || ' ' || new_lock.mode,
     '; ') from item4_new_locks new_lock where not (new_lock.locktype = 'relation' and new_lock.mode = 'AccessShareLock')));
select pg_temp.assert('no new function and not H4 takes a row lock',
  not exists (select 1 from pg_proc proc
               where proc.oid in ('ehr.order_route_receives_here(text)'::regprocedure,
                 'lab.order_route_receives_here()'::regprocedure, 'pharmacy.order_route_receives_here()'::regprocedure,
                 'ehr.order_routes_here(text)'::regprocedure, 'lab.order_routes_here()'::regprocedure,
                 'pharmacy.order_routes_here()'::regprocedure,
                 'identity.order_route_destination_eligible(uuid,text)'::regprocedure)
                 and proc.prosrc ~* 'for\s+(update|share|no\s+key\s+update|key\s+share)'));
-- Under other purposes (a work list may be read under one other than direct
-- care): the same answers.
select pg_temp.run_matrix('healthcare-operations', 'healthcare-operations');
select pg_temp.run_matrix('emergency', 'emergency');
-- With either switch off (owner SQL through the admin command): the same
-- answers, "without the switch".
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_orders_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'P4c item 4 suite closes orders');
reset role;
select pg_temp.run_matrix('orders-off');
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c item 4 suite pauses route access');
reset role;
select pg_temp.run_matrix('both-off');
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_orders_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'P4c item 4 suite opens orders again');
reset role;
select pg_temp.run_matrix('access-off');
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c item 4 suite resumes route access');
reset role;
select pg_temp.assert('B1 and D4: the same answers under other purposes and with either switch off',
  not exists (select 1 from item4_matrix base join item4_matrix other on other.n = base.n and other.tag <> base.tag
               where base.tag = 'direct-care' and (other.receives, other.routes) is distinct from (base.receives, base.routes))
  and (select count(distinct got.tag) from item4_matrix got) = 6,
  (select string_agg(other.tag || ' ' || other.n || ': ' || other.receives || ' ' || other.routes, '; ')
     from item4_matrix base join item4_matrix other on other.n = base.n and other.tag <> base.tag
    where base.tag = 'direct-care' and (other.receives, other.routes) is distinct from (base.receives, base.routes)));
-- Owner SQL: the pending administrator gets the lab role (review gate off):
-- step 2 now refuses (false), and routesHere answers.
set local session_replication_role = replica;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values (gen_random_uuid(), current_setting('hid.test.account_4')::uuid, 'lab', 'facility',
  current_setting('hid.test.membership_4')::uuid, current_setting('hid.test.facility_4')::uuid, 'Owner SQL lab role');
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(4);
select pg_temp.expect_facts('the pending administrator with the lab role (step 2)', 'lab',
  'false {"held": false, "waiting": false}');
-- The governed laboratory's product suspended (owner SQL), the facility
-- still active: step 3.
reset role;
update identity.organization_products set status = 'suspended' where facility_id = 'e4c21000-0000-4000-8000-000000000002';
set local role hid_lab_api_runtime;
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.expect_facts('GLM while GL''s product is suspended (step 3)', 'lab',
  'false {"held": false, "waiting": false}');
reset role;
update identity.organization_products set status = 'active' where facility_id = 'e4c21000-0000-4000-8000-000000000002';
-- The session binding: 42501 without a correlation id, without a
-- membership, at a facility that is not the membership's, and without any
-- staff context; 22023 for another kind (the owner-only helpers, as owner).
set local role hid_lab_api_runtime;
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select set_config('app.correlation_id', '', true);
select pg_temp.expect_facts('without a correlation id', 'lab',
  '42501 Order route staff context is required 42501 Order route staff context is required');
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select set_config('app.membership_id', '', true);
select pg_temp.expect_facts('without a membership', 'lab',
  '42501 Order route staff context is required 42501 Order route staff context is required');
select pg_temp.as_staff(21, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('GLM claiming L1', 'lab',
  '42501 Order route staff context is required 42501 Order route staff context is required');
select set_config('app.actor_subject', '', true), set_config('app.membership_id', '', true),
  set_config('app.facility_id', '', true);
select pg_temp.expect_facts('without a staff context', 'lab',
  '42501 Order route staff context is required 42501 Order route staff context is required');
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.check('the shared helper is not the Lab runtime''s',
  $s$select ehr.order_route_receives_here('lab_request')$s$,
  '42501 permission denied for function order_route_receives_here');
select pg_temp.check('the shared routes helper is not the Lab runtime''s',
  $s$select ehr.order_routes_here('lab_request')$s$, '42501 permission denied for function order_routes_here');
select pg_temp.check('the Pharmacy wrapper is not the Lab runtime''s',
  $s$select pharmacy.order_route_receives_here()$s$, '42501 permission denied for schema pharmacy');
select pg_temp.check('the Pharmacy routes wrapper is not the Lab runtime''s',
  $s$select pharmacy.order_routes_here()$s$, '42501 permission denied for schema pharmacy');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.check('the Lab wrapper is not the Pharmacy runtime''s',
  $s$select lab.order_route_receives_here()$s$, '42501 permission denied for schema lab');
reset role;
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.check('another kind (owner)', $s$select ehr.order_route_receives_here('referral')$s$,
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('another kind, routesHere (owner)', $s$select ehr.order_routes_here('referral')$s$,
  '22023 ORDER_ROUTE_INVALID');
-- Support lists the laboratory reviewed as Other (C23): it receives; support
-- unlists it again: it does not.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('support lists LO', format($s$select * from identity.admin_set_order_route_destination(%L, true,
  'Checked by phone after the review')$s$, current_setting('hid.test.facility_3')), 'ok');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(3);
select pg_temp.expect_facts('LO once support lists it', 'lab', 'true {"held": false, "waiting": false}');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('support unlists LO', format($s$select * from identity.admin_set_order_route_destination(%L, false,
  'Paused while support checks again')$s$, current_setting('hid.test.facility_3')), 'ok');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(3);
select pg_temp.expect_facts('LO once support unlists it', 'lab', 'false {"held": false, "waiting": false}');
reset role;

-- 3. D4's alternative: whether orders wait for the facility or are held by
-- it. L1 (self-signed-up, read as LB2), GL (governed, read as GLM), DU (both
-- products) and PH1. Each route is aged past its window before the next.
set local role hid_ehr_api_runtime;
select set_config('hid.test.route_w1', pg_temp.new_route('w1', 'lab_request', current_setting('hid.test.facility_1')::uuid)::text, true);
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 with a lab request waiting', 'lab', 'true {"held": false, "waiting": true}');
select pg_temp.as_staff(32, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('RB at L1: nothing without the receive permission', 'lab', 'null null');
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.expect_facts('GL: another facility''s route never counts', 'lab', 'true {"held": false, "waiting": false}');
select pg_temp.as_signup_admin(8);
select pg_temp.expect_facts('L8: another facility''s route never counts', 'lab', 'true {"held": false, "waiting": false}');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.expect_facts('LB1 as pharmacist at L1: another kind never counts', 'pharmacy',
  'false {"held": false, "waiting": false}');
reset role;
-- Support unlists L1: it no longer receives, and the order sent before still
-- waits (the website keeps it declinable).
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('support unlists L1', format($s$select * from identity.admin_set_order_route_destination(%L, false,
  'Paused while support checks a complaint')$s$, current_setting('hid.test.facility_1')), 'ok');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 unlisted with a lab request waiting', 'lab', 'false {"held": false, "waiting": true}');
-- Waiting is not acceptable here (INTERFACE_CONTRACT section 22): Accept is
-- refused while receives is false, and Decline still acts (undone here).
select pg_temp.check('L1 unlisted: the waiting lab request cannot be accepted',
  format($s$select * from lab.accept_order_route(%L, 1, 'health_id', 'HID-P4CPATP', 'p4c-item4-accept-w1-unlisted', %L)$s$,
    current_setting('hid.test.route_w1'), repeat('a', 64)), 'P0001 ORDER_ROUTE_DESTINATION_INELIGIBLE');
select pg_temp.check('L1 unlisted: the waiting lab request can still be declined',
  format($s$do $d$ begin perform * from lab.decline_order_route(%L, 1, 'test_not_offered');
    raise exception 'P4C_DECLINED'; end $d$$s$, current_setting('hid.test.route_w1')), 'P0001 P4C_DECLINED');
select pg_temp.expect_facts('L1 unlisted: the lab request still waits', 'lab', 'false {"held": false, "waiting": true}');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('support relists L1', format($s$select * from identity.admin_set_order_route_destination(%L, true,
  'Complaint closed, listed again')$s$, current_setting('hid.test.facility_1')), 'ok');
-- Nor while orders between facilities are off, though L1 receives and the
-- order still waits; Decline still acts (undone here).
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_orders_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'P4c item 4 suite closes orders');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 listed, orders off, a lab request waiting', 'lab', 'true {"held": false, "waiting": true}');
select pg_temp.check('orders off: the waiting lab request cannot be accepted',
  format($s$select * from lab.accept_order_route(%L, 1, 'health_id', 'HID-P4CPATP', 'p4c-item4-accept-w1-orders-off', %L)$s$,
    current_setting('hid.test.route_w1'), repeat('a', 64)), '55000 PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled');
select pg_temp.check('orders off: the waiting lab request can still be declined',
  format($s$do $d$ begin perform * from lab.decline_order_route(%L, 1, 'test_not_offered');
    raise exception 'P4C_DECLINED'; end $d$$s$, current_setting('hid.test.route_w1')), 'P0001 P4C_DECLINED');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_orders_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'P4c item 4 suite opens orders again');
reset role;
select pg_temp.age_route(current_setting('hid.test.route_w1')::uuid, interval '7 days', interval '0');
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 at the waiting route''s respond_by: no longer waiting', 'lab',
  'true {"held": false, "waiting": false}');
reset role;
-- Accepted: held until writes_end_at (= access_ends_at).
set local role hid_ehr_api_runtime;
select set_config('hid.test.route_a1', pg_temp.new_route('a1', 'lab_request', current_setting('hid.test.facility_1')::uuid)::text, true);
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.item_a1', pg_temp.accept_lab(current_setting('hid.test.route_a1')::uuid, 1)::text, true);
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 holding an accepted lab request', 'lab', 'true {"held": true, "waiting": false}');
reset role;
select pg_temp.age_route(current_setting('hid.test.route_a1')::uuid, interval '30 days', interval '30 days');
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 at the accepted route''s access_ends_at: not held', 'lab',
  'true {"held": false, "waiting": false}');
reset role;
-- Completed: held until access_ends_at (first return + 14 days).
set local role hid_ehr_api_runtime;
select set_config('hid.test.route_c1', pg_temp.new_route('c1', 'lab_request', current_setting('hid.test.facility_1')::uuid)::text, true);
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.item_c1', pg_temp.accept_lab(current_setting('hid.test.route_c1')::uuid, 1)::text, true);
reset role;
select set_config('hid.test.result_c1', pg_temp.lab_chain(current_setting('hid.test.item_c1')::uuid, 'item4c1', 11.5)::text,
  true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.release(current_setting('hid.test.result_c1')::uuid, 1,
  current_setting('hid.test.item4c1_verification_1')::uuid, 'p4c-item4-release-c1-01');
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 holding a completed lab request', 'lab', 'true {"held": true, "waiting": false}');
reset role;
select pg_temp.assert('the completed route', (pg_temp.route(current_setting('hid.test.route_c1')::uuid)).state = 'completed');
select pg_temp.age_route(current_setting('hid.test.route_c1')::uuid, interval '0', interval '14 days');
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 at the completed route''s access_ends_at: not held', 'lab',
  'true {"held": false, "waiting": false}');
reset role;
-- Cancelled by the mirror (the order put on hold): held for its 7-day read
-- window.
set local role hid_ehr_api_runtime;
select set_config('hid.test.route_x1', pg_temp.new_route('x1', 'lab_request', current_setting('hid.test.facility_1')::uuid)::text, true);
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.item_x1', pg_temp.accept_lab(current_setting('hid.test.route_x1')::uuid, 1)::text, true);
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.edit_lab(current_setting('hid.test.order_x1')::uuid, 'on_hold', 'Held until the scan is back');
reset role;
select pg_temp.assert('the cancelled route reads for 7 days', (select route.state = 'cancelled'
    and route.access_ends_at = route.ended_at + interval '7 days' from ehr.order_routes route
   where route.id = current_setting('hid.test.route_x1')::uuid));
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 holding a cancelled lab request in its read window', 'lab',
  'true {"held": true, "waiting": false}');
reset role;
select pg_temp.age_route(current_setting('hid.test.route_x1')::uuid, interval '0', interval '7 days');
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 at the cancelled route''s access_ends_at: not held', 'lab',
  'true {"held": false, "waiting": false}');
reset role;
-- The governed laboratory GL: a waiting and an accepted lab request; then
-- its product suspended (owner SQL) and support's unlisting: it no longer
-- receives, and both facts stay (the website shows its orders and the
-- paused notice).
set local role hid_ehr_api_runtime;
select set_config('hid.test.route_g1', pg_temp.new_route('g1', 'lab_request', 'e4c21000-0000-4000-8000-000000000002')::text, true);
select set_config('hid.test.route_g2', pg_temp.new_route('g2', 'lab_request', 'e4c21000-0000-4000-8000-000000000002')::text, true);
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select set_config('hid.test.item_g1', pg_temp.accept_lab_here(current_setting('hid.test.route_g1')::uuid)::text, true);
select pg_temp.expect_facts('GL waiting and holding', 'lab', 'true {"held": true, "waiting": true}');
reset role;
update identity.organization_products set status = 'suspended' where facility_id = 'e4c21000-0000-4000-8000-000000000002';
set local role hid_lab_api_runtime;
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.expect_facts('GL with its product suspended: waiting and holding', 'lab',
  'false {"held": true, "waiting": true}');
reset role;
update identity.organization_products set status = 'active' where facility_id = 'e4c21000-0000-4000-8000-000000000002';
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('support unlists GL', $s$select * from identity.admin_set_order_route_destination(
  'e4c21000-0000-4000-8000-000000000002', false, 'Paused while support checks a complaint')$s$, 'ok');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.expect_facts('GL unlisted: waiting and holding', 'lab', 'false {"held": true, "waiting": true}');
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 meanwhile: GL''s routes never count', 'lab', 'true {"held": false, "waiting": false}');
reset role;
-- Either switch off: the same facts (the paused notice needs held).
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c item 4 suite pauses route access');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(21, 'e4c21000-0000-4000-8000-000000000002');
select pg_temp.expect_facts('GL unlisted with route access paused: waiting and holding', 'lab',
  'false {"held": true, "waiting": true}');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c item 4 suite resumes route access');
select pg_temp.as_platform(3);
select pg_temp.check('support relists GL', $s$select * from identity.admin_set_order_route_destination(
  'e4c21000-0000-4000-8000-000000000002', true, 'Complaint closed, listed again')$s$, 'ok');
reset role;
-- DU: a prescription waits; its lab side sees nothing (another kind).
set local role hid_ehr_api_runtime;
select set_config('hid.test.route_d1', pg_temp.new_route('d1', 'prescription', 'e4c21000-0000-4000-8000-000000000053')::text, true);
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(54);
select pg_temp.expect_facts('DUP with a prescription waiting', 'pharmacy', 'true {"held": false, "waiting": true}');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_member(53);
select pg_temp.expect_facts('DUL: the prescription never counts for lab requests', 'lab',
  'true {"held": false, "waiting": false}');
reset role;
-- PH1: a prescription waits, is accepted (held) and dispensed (held).
set local role hid_ehr_api_runtime;
select set_config('hid.test.route_p1', pg_temp.new_route('p1', 'prescription', current_setting('hid.test.facility_2')::uuid)::text, true);
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.expect_facts('PH1 with a prescription waiting', 'pharmacy', 'true {"held": false, "waiting": true}');
select set_config('hid.test.item_p1', pg_temp.accept_rx(current_setting('hid.test.route_p1')::uuid)::text, true);
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.expect_facts('PH1 holding an accepted prescription', 'pharmacy', 'true {"held": true, "waiting": false}');
select pg_temp.dispense(current_setting('hid.test.item_p1')::uuid, 'p4c-item4-dispense-p1');
select pg_temp.expect_facts('PH1 holding a completed prescription', 'pharmacy', 'true {"held": true, "waiting": false}');
reset role;
-- The longest a route can be held after it was sent (section 2's bound):
-- o1 at L1, sent 51 days ago, accepted just before its respond_by, its
-- result returned 2 days ago, so access ends at acceptance + 45 days, in 23
-- hours (owner SQL, triggers off, every CHECK kept).
set local role hid_ehr_api_runtime;
select set_config('hid.test.route_o1', pg_temp.new_route('o1', 'lab_request', current_setting('hid.test.facility_1')::uuid)::text, true);
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.item_o1', pg_temp.accept_lab(current_setting('hid.test.route_o1')::uuid, 1)::text, true);
reset role;
select set_config('hid.test.result_o1', pg_temp.lab_chain(current_setting('hid.test.item_o1')::uuid, 'item4o1', 13.5)::text,
  true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.release(current_setting('hid.test.result_o1')::uuid, 1,
  current_setting('hid.test.item4o1_verification_1')::uuid, 'p4c-item4-release-o1-01');
reset role;
set local session_replication_role = replica;
update ehr.order_routes route set created_at = base.sent_at, respond_by = base.sent_at + interval '168 hours',
  accepted_at = base.sent_at + interval '167 hours', completed_at = base.sent_at + interval '49 days',
  writes_end_at = base.sent_at + interval '167 hours' + interval '1080 hours',
  access_ends_at = base.sent_at + interval '167 hours' + interval '1080 hours'
  from (select clock_timestamp() - interval '51 days' as sent_at) base
 where route.id = current_setting('hid.test.route_o1')::uuid;
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 holding a route sent 51 days ago', 'lab', 'true {"held": true, "waiting": false}');
reset role;
select pg_temp.age_route(current_setting('hid.test.route_o1')::uuid, interval '0', interval '1 day');
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.expect_facts('L1 once that route''s access has ended', 'lab', 'true {"held": false, "waiting": false}');
reset role;
-- The two CHECKs section 2's bounds rest on are still 0086's, validated
-- (0086:6376 and 6394-6406; 0089 compares them before it applies), compared
-- with the same CHECKs built here: o1 above is then as long as any route can
-- be held after it was sent.
create temp table item4_bounds_0086 (
  kind text,
  state text,
  created_at timestamptz,
  respond_by timestamptz,
  accepted_at timestamptz,
  accepted_by_account_id uuid,
  accepted_by_membership_id uuid,
  accept_idempotency_key text,
  accept_request_sha256 char(64),
  lab_work_item_id uuid,
  pharmacy_work_item_id uuid,
  writes_end_at timestamptz,
  access_ends_at timestamptz,
  constraint order_routes_respond_by_ck check (respond_by = created_at + interval '168 hours'),
  constraint order_routes_acceptance_ck check (
    (accepted_at is null and accepted_by_account_id is null and accepted_by_membership_id is null
      and accept_idempotency_key is null and accept_request_sha256 is null
      and lab_work_item_id is null and pharmacy_work_item_id is null
      and writes_end_at is null and access_ends_at is null
      and state in ('sent', 'declined', 'withdrawn', 'expired'))
    or (accepted_at is not null and accepted_by_account_id is not null and accepted_by_membership_id is not null
      and accept_idempotency_key is not null and accept_request_sha256 is not null
      and ((kind = 'lab_request' and lab_work_item_id is not null)
        or (kind = 'prescription' and pharmacy_work_item_id is not null))
      and writes_end_at is not null and access_ends_at is not null
      and writes_end_at <= access_ends_at and access_ends_at <= accepted_at + interval '1080 hours'
      and state in ('accepted', 'completed', 'cancelled')))
) on commit drop;
select pg_temp.assert('section 2''s bounds: ehr.order_routes'' respond-by and acceptance CHECKs are 0086''s, validated',
  not exists (select 1 from (values ('order_routes_respond_by_ck'), ('order_routes_acceptance_ck')) expected(conname)
               where (select pg_get_constraintdef(live.oid) from pg_constraint live
                       where live.conrelid = 'ehr.order_routes'::regclass and live.conname = expected.conname
                         and live.contype = 'c' and live.convalidated)
                     is distinct from
                     (select pg_get_constraintdef(built.oid) from pg_constraint built
                       where built.conrelid = 'pg_temp.item4_bounds_0086'::regclass
                         and built.conname = expected.conname and built.contype = 'c')));
-- Every case once more, against the unbounded predicates evaluated as owner
-- (Incoming's list and H6's read): the bounds change nothing.
select pg_temp.run_matrix('after-routes');
select pg_temp.assert('D4 equals Incoming''s and H6''s predicates, unbounded, for every holder',
  not exists (select 1 from item4_cases item join item4_matrix got on got.n = item.n and got.tag = 'after-routes'
               where got.routes like '{%' and got.routes::jsonb <> jsonb_build_object(
                 'waiting', exists (select 1 from ehr.order_routes route where route.receiving_facility_id = item.facility
                   and route.kind = item.kind and route.state = 'sent' and route.respond_by > clock_timestamp()),
                 'held', exists (select 1 from ehr.order_routes route where route.receiving_facility_id = item.facility
                   and route.kind = item.kind and route.state in ('accepted', 'completed', 'cancelled')
                   and route.access_ends_at > clock_timestamp())))
  and (select count(*) from item4_matrix got where got.tag = 'after-routes' and got.routes like '%true%') >= 3,
  (select string_agg(item.n || ' ' || got.routes, '; ') from item4_cases item
     join item4_matrix got on got.n = item.n and got.tag = 'after-routes'));
select pg_temp.assert('D4 answers booleans only', not exists (
  select 1 from item4_matrix got where got.routes like '{%'
     and ((got.routes::jsonb) - 'held' - 'waiting' <> '{}'::jsonb
       or jsonb_typeof(got.routes::jsonb -> 'held') <> 'boolean'
       or jsonb_typeof(got.routes::jsonb -> 'waiting') <> 'boolean')));

-- 4. B2: support's find (C21). More routes, one per row of SPEC-FINAL 6.1:
-- s1 sent; k1 accepted; k2 completed in its window; k3 completed and ended
-- by support; k4 completed, constructed (owner SQL, triggers off) with
-- ended_at and ended_kind 'support' while access_ends_at is still ahead
-- (MC3); x2 cancelled in its read window; wp1 accepted then reported for the
-- wrong patient (cancelled), wp2 a completed prescription reported (access
-- ended); dc1 declined; wd1 withdrawn by the orderer; r8 completed at L8,
-- aged past access_ends_at, then ended by L8's release (CC4: access_ends_at
-- before ended_at). With section 3's routes: sent past respond_by (w1),
-- accepted past its window (a1), completed past access_ends_at (c1),
-- cancelled past its read window (x1), and live ones at GL, DU and PH1.
set local role hid_ehr_api_runtime;
select set_config('hid.test.route_' || label, pg_temp.new_route(label, 'lab_request',
  current_setting('hid.test.facility_1')::uuid)::text, true)
  from unnest(array['s1', 'k1', 'k2', 'k3', 'k4', 'x2', 'wp1', 'dc1', 'wd1']) label;
select set_config('hid.test.route_wp2', pg_temp.new_route('wp2', 'prescription',
  current_setting('hid.test.facility_2')::uuid)::text, true);
select set_config('hid.test.route_r8', pg_temp.new_route('r8', 'lab_request',
  current_setting('hid.test.facility_8')::uuid)::text, true);
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.item_' || label, pg_temp.accept_lab(current_setting('hid.test.route_' || label)::uuid, 1)::text,
  true) from unnest(array['k1', 'k2', 'k3', 'k4', 'x2', 'wp1']) label;
select set_config('hid.test.item_r8', pg_temp.accept_lab(current_setting('hid.test.route_r8')::uuid, 8)::text, true);
select pg_temp.as_signup_admin(1);
select pg_temp.check('L1 declines dc1', format($s$select * from lab.decline_order_route(%L, 1, 'test_not_offered')$s$,
  current_setting('hid.test.route_dc1')), 'ok');
reset role;
select set_config('hid.test.result_' || label, pg_temp.lab_chain(current_setting('hid.test.item_' || label)::uuid,
  'item4' || label, 12.5)::text, true) from unnest(array['k2', 'k3', 'k4', 'r8']) label;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.release(current_setting('hid.test.result_' || label)::uuid, 1,
  current_setting('hid.test.item4' || label || '_verification_1')::uuid, 'p4c-item4-release-' || label || '-01')
  from unnest(array['k2', 'k3', 'k4']) label;
select pg_temp.as_signup_admin(8);
select pg_temp.release(current_setting('hid.test.result_r8')::uuid, 1,
  current_setting('hid.test.item4r8_verification_1')::uuid, 'p4c-item4-release-r8-01');
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('LB2 reports wp1 accepted for the wrong patient', format($s$select * from
  lab.report_wrong_patient_order_route(%L, 2, 'wrong_order_chosen', 'Picked the wrong row at the counter',
  'p4c-item4-wrong-wp1', repeat('a', 64))$s$, current_setting('hid.test.route_wp1')), 'ok');
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('hid.test.item_wp2', pg_temp.accept_rx(current_setting('hid.test.route_wp2')::uuid)::text, true);
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.dispense(current_setting('hid.test.item_wp2')::uuid, 'p4c-item4-dispense-wp2');
select pg_temp.check('PB2 reports wp2 dispensed to the wrong patient', format($s$select * from
  pharmacy.report_wrong_patient_order_route(%L, 3, 'someone_elses_details', 'Collected with another patient''s details',
  'p4c-item4-wrong-wp2', repeat('a', 64))$s$, current_setting('hid.test.route_wp2')), 'ok');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('DA withdraws wd1', format($s$select * from ehr.withdraw_order_route(%L, 'lab_request', %L, 1,
  'sent_in_error')$s$, current_setting('hid.test.route_wd1'), current_setting('hid.test.order_wd1')), 'ok');
select pg_temp.edit_lab(current_setting('hid.test.order_x2')::uuid, 'on_hold', 'Held until the scan is back');
reset role;
select set_config('hid.test.version_k3', (pg_temp.route(current_setting('hid.test.route_k3')::uuid)).row_version::text,
  true);
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select pg_temp.check('support closes k3 (completed: access ends)', format($s$select * from
  identity.admin_close_order_route(%L, %s, 'The patient asked support to stop it')$s$, current_setting('hid.test.route_k3'),
  current_setting('hid.test.version_k3')), 'ok');
reset role;
-- Owner SQL (triggers off): k4's end recorded without its access ending (no
-- command does this; it tells closable's ended_at test apart, MC3).
set local session_replication_role = replica;
update ehr.order_routes set ended_at = clock_timestamp(), ended_kind = 'support'
 where id = current_setting('hid.test.route_k4')::uuid;
set local session_replication_role = origin;
-- r8 ages past access_ends_at, then support suspends L8, disables its
-- administrator and releases it: the release ends the completed route with
-- ended_at after access_ends_at (CC4).
select pg_temp.age_route(current_setting('hid.test.route_r8')::uuid, interval '0', interval '15 days');
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select identity.admin_transition_facility(current_setting('hid.test.facility_8')::uuid,
  (select facility.row_version from identity.facilities facility where facility.id = current_setting('hid.test.facility_8')::uuid),
  'suspended', 'Suspended for the P4c item 4 suite', 'p4c-item4-suspend-8-000000', repeat('c', 64));
select auth.admin_transition_account(current_setting('hid.test.account_8')::uuid,
  (select account.row_version from auth.accounts account where account.id = current_setting('hid.test.account_8')::uuid),
  'disabled', 'Disabled for the P4c release', 'p4c-item4-disable-8-000000', repeat('d', 64));
select identity.admin_release_self_service_facility(current_setting('hid.test.app_8')::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('all') application
    where application.application_id = current_setting('hid.test.app_8')::uuid),
  'Released for the P4c item 4 suite', false);
reset role;
select pg_temp.assert('the rows: states and ends as constructed',
  (select array_agg(label || ':' || route.state || ':' || coalesce(route.ended_kind, '-') order by label)
     from unnest(array['s1', 'k1', 'k2', 'k3', 'k4', 'x2', 'wp1', 'wp2', 'dc1', 'wd1', 'r8', 'w1', 'a1', 'c1', 'x1']) label
     join ehr.order_routes route on route.id = current_setting('hid.test.route_' || label)::uuid)
  = array['a1:accepted:-', 'c1:completed:-', 'dc1:declined:-', 'k1:accepted:-', 'k2:completed:-',
          'k3:completed:support', 'k4:completed:support', 'r8:completed:receiving_released', 's1:sent:-', 'w1:sent:-',
          'wd1:withdrawn:orderer', 'wp1:cancelled:wrong_patient', 'wp2:completed:wrong_patient',
          'x1:cancelled:order_changed', 'x2:cancelled:order_changed'],
  (select array_agg(label || ':' || route.state || ':' || coalesce(route.ended_kind, '-') order by label)::text
     from unnest(array['s1', 'k1', 'k2', 'k3', 'k4', 'x2', 'wp1', 'wp2', 'dc1', 'wd1', 'r8', 'w1', 'a1', 'c1', 'x1']) label
     join ehr.order_routes route on route.id = current_setting('hid.test.route_' || label)::uuid));
select pg_temp.assert('r8: the release came after access had ended (CC4)', (select route.access_ends_at < route.ended_at
  and route.access_ends_at < clock_timestamp() from ehr.order_routes route
  where route.id = current_setting('hid.test.route_r8')::uuid));
select pg_temp.assert('k4: ended, with access still ahead (constructed)', (select route.ended_at is not null
  and route.access_ends_at > clock_timestamp() from ehr.order_routes route
  where route.id = current_setting('hid.test.route_k4')::uuid));

-- Every route of the suite, found by its reference as the Identity runtime,
-- and support's Close tried at the version found (undone).
create temp table item4_routes on commit drop as
  select route.id, route.reference::text as reference, route.state, route.access_ends_at, route.ended_at
    from ehr.order_routes route;
create temp table item4_found (route_id uuid primary key, effective_state text, access_ends_at timestamptz,
  closable boolean, close_outcome text, columns integer) on commit drop;
grant select on item4_routes to hid_identity_api_runtime;
grant select, insert on item4_found to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
insert into item4_found (route_id, effective_state, access_ends_at, closable, close_outcome, columns)
select found.route_id, found.effective_state, found.access_ends_at, found.closable,
  pg_temp.close_acts(found.route_id, found.row_version),
  (select count(*) from json_object_keys(row_to_json(found)))
  from item4_routes listed
  cross join lateral identity.admin_find_order_routes(listed.reference, null) found
 where found.route_id = listed.id;
reset role;
select pg_temp.assert('C21 finds every route of the suite, with 15 columns',
  (select count(*) from item4_found) = (select count(*) from item4_routes)
  and (select count(*) from item4_routes) = 20
  and not exists (select 1 from item4_found found where found.columns <> 15));
select pg_temp.assert('closable is exactly "support''s Close acts now", for every route',
  not exists (select 1 from item4_found found
               where found.closable is distinct from (found.close_outcome = 'acts')
                  or found.close_outcome not in ('acts', '23505 ORDER_ROUTE_ALREADY_CLOSED')),
  (select string_agg(found.route_id || ' ' || found.effective_state || ' ' || found.closable || ' '
     || found.close_outcome, '; ') from item4_found found
    where found.closable is distinct from (found.close_outcome = 'acts')
       or found.close_outcome not in ('acts', '23505 ORDER_ROUTE_ALREADY_CLOSED')));
select pg_temp.assert('access_ends_at is the stored column, for every route',
  not exists (select 1 from item4_found found join item4_routes listed on listed.id = found.route_id
               where found.access_ends_at is distinct from listed.access_ends_at));
select pg_temp.assert('a live route that is not closable is completed (one effective state per row)',
  not exists (select 1 from item4_found found join item4_routes listed on listed.id = found.route_id
               where not found.closable and found.effective_state in ('sent', 'accepted', 'completed')
                 and listed.state <> 'completed'));
select pg_temp.assert('C21 by row: effective state, closable, access_ends_at known',
  (select array_agg(label || ':' || found.effective_state || ':' || found.closable || ':'
       || (found.access_ends_at is not null) order by label)
     from unnest(array['s1', 'k1', 'k2', 'k3', 'k4', 'x2', 'wp1', 'wp2', 'dc1', 'wd1', 'r8', 'w1', 'a1', 'c1', 'x1',
                       'g1', 'g2', 'd1', 'p1']) label
     join item4_found found on found.route_id = current_setting('hid.test.route_' || label)::uuid)
  = array['a1:expired:false:true', 'c1:completed:false:true', 'd1:sent:true:false', 'dc1:declined:false:false',
          'g1:accepted:true:true', 'g2:sent:true:false', 'k1:accepted:true:true', 'k2:completed:true:true',
          'k3:completed:false:true', 'k4:completed:false:true', 'p1:completed:true:true', 'r8:completed:false:true',
          's1:sent:true:false', 'w1:expired:false:false', 'wd1:withdrawn:false:false', 'wp1:cancelled:false:true',
          'wp2:completed:false:true', 'x1:cancelled:false:true', 'x2:cancelled:false:true'],
  (select array_agg(label || ':' || found.effective_state || ':' || found.closable || ':'
       || (found.access_ends_at is not null) order by label)::text
     from unnest(array['s1', 'k1', 'k2', 'k3', 'k4', 'x2', 'wp1', 'wp2', 'dc1', 'wd1', 'r8', 'w1', 'a1', 'c1', 'x1',
                       'g1', 'g2', 'd1', 'p1']) label
     join item4_found found on found.route_id = current_setting('hid.test.route_' || label)::uuid));
select pg_temp.assert('C21 evaluates the effective state once per row',
  (select count(*) from regexp_matches((select proc.prosrc from pg_proc proc
     where proc.oid = 'identity.admin_find_order_routes(text,text)'::regprocedure), 'order_route_effective_state', 'g'))
  = 1);
-- The previous Identity's 13 named columns (595c044 and 22cd47f) answer the
-- same values as the first 13 of select *, by reference and by Health ID.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select pg_temp.assert('the previous Identity''s 13 columns read the new C21 unchanged',
  (select array_agg(row(named.*)::text order by named.route_id)
     from (select route_id::text as route_id, reference, kind, row_version, effective_state,
                  ordering_facility_id::text as ordering_facility_id, ordering_facility_name,
                  receiving_facility_id::text as receiving_facility_id, receiving_facility_name,
                  created_at, accepted_at, ended_at, ended_kind
             from identity.admin_find_order_routes(null, 'HID-P4CPATP')) named)
  = (select array_agg(row(found.route_id::text, found.reference, found.kind, found.row_version, found.effective_state,
                          found.ordering_facility_id::text, found.ordering_facility_name,
                          found.receiving_facility_id::text, found.receiving_facility_name, found.created_at,
                          found.accepted_at, found.ended_at, found.ended_kind)::text order by found.route_id::text)
       from identity.admin_find_order_routes(null, 'HID-P4CPATP') found)
  and (select count(*) from identity.admin_find_order_routes(null, 'HID-P4CPATP'))
    = least(20, (select count(*) from item4_routes))
  and (select bool_and(found.closable is not null) from identity.admin_find_order_routes(null, 'HID-P4CPATP') found));
select pg_temp.as_platform(2);
select pg_temp.check('C21 as support (platform.principal.read)', $s$select * from
  identity.admin_find_order_routes('ABCDEF12', null)$s$, 'ok');
select pg_temp.check('C20 as support without platform.facility.read', $s$select identity.admin_order_route_summary(
  'e4c21000-0000-4000-8000-000000000002')$s$, '42501 ADMIN_PERMISSION_DENIED');
select pg_temp.as_platform(3);
select pg_temp.check('C21 by a facility reviewer without platform.principal.read', $s$select * from
  identity.admin_find_order_routes('ABCDEF12', null)$s$, '42501 ADMIN_PERMISSION_DENIED');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('C21 is not the Lab runtime''s', $s$select * from identity.admin_find_order_routes('ABCDEF12', null)$s$,
  '42501 permission denied for function admin_find_order_routes');
reset role;
-- Closing support's Close as it answered: s1 is closable; once closed it is not.
select set_config('hid.test.reference_s1', (pg_temp.route(current_setting('hid.test.route_s1')::uuid)).reference::text,
  true);
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select pg_temp.check('support closes s1, which C21 called closable', format($s$select * from
  identity.admin_close_order_route(%L, 1, 'The patient asked support to stop it')$s$, current_setting('hid.test.route_s1')),
  'ok');
select pg_temp.assert('s1 is no longer closable', (select not found.closable and found.effective_state = 'withdrawn'
  from identity.admin_find_order_routes(current_setting('hid.test.reference_s1'), null) found));
reset role;

select pg_temp.report();
rollback;
