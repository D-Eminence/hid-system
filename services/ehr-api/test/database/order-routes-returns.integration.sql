-- Results and dispensing coming back to the ordering facility (0086 section
-- 6, P4c). Rollback-only. Releases, invalidations, dispensings and reversals
-- run as the exact Lab and Pharmacy runtimes under route access (no consent
-- at the receiving facility); the reports are read through the EHR runtime.
--   1. the first release: a report (every field of the released version),
--      the route completed, both windows least(completed + 14 days,
--      accepted + 45 days), event completed, A's system row with the patient;
--   2. a correction: a second report (revision kind, correction reason), no
--      window change, event result_returned;
--   3. an invalidation of a version that came back: a report, event
--      result_marked_in_error; of one that never came back: nothing;
--   4. a dispensing: a report, completed, windows; a reversal: a report and
--      event, never refused;
--   5. C3 gives them to A under its read consent only (the summary, the
--      attestation, the events without actors, the reports); refuses the
--      emergency purpose, a member without consent, the receiving facility
--      and a third facility; C4's summaries;
--   6. the release trigger 0088 replaced: a release under the patient's
--      consent at B still crosses on a completed route support closed, and is
--      refused (23514 ORDER_ROUTE_CLOSED) on one its laboratory ended as
--      fulfilled for the wrong person;
--   7. the release trigger 0090 replaced: after the laboratory reports the
--      support-closed route late (D17), what A holds is withdrawn and a later
--      release under the patient's consent is refused too, though the route
--      keeps support's ending;
--   8. "We can't complete this order" (0091, D18): refused while a checked
--      result waits and once a release or dispensing completed the route;
--      after the ending a release under the patient's consent and a
--      dispensing are refused, and nothing reaches the ordering facility.
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
select set_config('hid.test.lr_1', pg_temp.lab_request(1, 'active')::text, true);
select set_config('hid.test.lr_2', pg_temp.lab_request(1, 'active')::text, true);
select set_config('hid.test.rx_1', pg_temp.prescription(1, 'active')::text, true);
select set_config('hid.test.route_1', pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_1')::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-returns-send-0001')::text, true);
select set_config('hid.test.route_2', pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_2')::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-returns-send-0002')::text, true);
select set_config('hid.test.rxroute_1', pg_temp.send(11, 'prescription', current_setting('hid.test.rx_1')::uuid,
  current_setting('hid.test.facility_2')::uuid, 'p4c-returns-send-rx01')::text, true);
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select set_config('hid.test.item_' || n, (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.route_' || n)::uuid, 1, 'health_id', 'HID-P4CPATP', 'p4c-returns-accept-' || n || '0',
  repeat('a', 64)) accepted), true) from generate_series(1, 2) n;
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_signup_admin(2);
select set_config('hid.test.rxitem_1', (select accepted.work_item_id::text from pharmacy.accept_order_route(
  current_setting('hid.test.rxroute_1')::uuid, 1, 'health_id', 'HID-P4CPATP', 'Patient collected the prescription',
  'p4c-returns-rx-accept', repeat('a', 64)) accepted), true);
reset role;
select set_config('hid.test.result_1', pg_temp.lab_chain(current_setting('hid.test.item_1')::uuid, 'chain1', 10.4)::text, true);
select set_config('hid.test.result_2', pg_temp.lab_chain(current_setting('hid.test.item_2')::uuid, 'chain2', 13.1)::text, true);

-- 1. The first release, by LB1 under route access.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('the first release', format($s$select pg_temp.release(%L, 1, %L, 'p4c-returns-release-01')$s$,
  current_setting('hid.test.result_1'), current_setting('hid.test.chain1_verification_1')), 'ok');
reset role;
do $$
declare
  route ehr.order_routes%rowtype;
  report lab.order_route_result_reports%rowtype;
begin
  select * into route from ehr.order_routes where id = current_setting('hid.test.route_1')::uuid;
  select * into report from lab.order_route_result_reports where route_id = route.id;
  perform pg_temp.assert('the report carries the released version', report.kind = 'released'
    and report.result_id = current_setting('hid.test.result_1')::uuid and report.result_version = 1
    and report.work_item_id = current_setting('hid.test.item_1')::uuid and report.test_name = 'Haemoglobin'
    and report.test_code = '718-7' and report.result_type = 'numeric' and report.numeric_value = 10.4
    and report.unit = 'g/dL' and report.reference_range = '12.0-15.5' and report.abnormal_flag = 'low'
    and report.revision_kind = 'original' and report.correction_reason is null
    and report.performing_facility_id = route.receiving_facility_id, row_to_json(report)::text);
  perform pg_temp.assert('the route completed, windows shortened', route.state = 'completed'
    and route.completed_at is not null
    and route.writes_end_at = least(route.completed_at + interval '14 days', route.accepted_at + interval '45 days')
    and route.access_ends_at = route.writes_end_at and route.writes_end_at < route.accepted_at + interval '30 days');
  perform pg_temp.assert('event completed', (select event.event_type from ehr.order_route_events event
    where event.route_id = route.id order by event.event_version desc limit 1) = 'completed');
  perform pg_temp.assert('A told with the patient, ids only', exists (select 1 from audit.events event
    where event.action = 'ehr.order-route.result-returned' and event.facility_id = route.ordering_facility_id
      and event.patient_id = route.patient_id and event.actor_type = 'system'
      and event.details = jsonb_build_object('routeId', route.id, 'kind', 'lab_request', 'state', 'completed',
        'resultId', current_setting('hid.test.result_1')::uuid, 'version', 1)));
  perform set_config('hid.test.window_1', route.writes_end_at::text, true);
end $$;

-- 2. A correction (version 2), released by LB2.
select set_config('hid.test.chain1_verification_2', pg_temp.lab_correction(current_setting('hid.test.result_1')::uuid,
  'chain1', 11.2, current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text,
  true);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('the correction''s release', format($s$select pg_temp.release(%L, 2, %L, 'p4c-returns-release-02')$s$,
  current_setting('hid.test.result_1'), current_setting('hid.test.chain1_verification_2')), 'ok');
reset role;
select pg_temp.assert('a second report, no window change', (select array_agg(report.revision_kind || ':'
    || coalesce(report.correction_reason, '') || ':' || report.numeric_value order by report.result_version)
  from lab.order_route_result_reports report where report.route_id = current_setting('hid.test.route_1')::uuid)
  = array['original::10.4', 'correction:Analyser recalibrated:11.2']
  and (select route.writes_end_at::text from ehr.order_routes route where route.id = current_setting('hid.test.route_1')::uuid)
    = current_setting('hid.test.window_1')
  and (select event.event_type from ehr.order_route_events event where event.route_id = current_setting('hid.test.route_1')::uuid
       order by event.event_version desc limit 1) = 'result_returned');

-- 3. Invalidations.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
insert into lab.result_invalidations (result_id, execution_id, patient_id, facility_id, result_version, disposition,
  actor_id, actor_membership_id, reason, idempotency_key, request_sha256, correlation_id)
values (current_setting('hid.test.result_1')::uuid, current_setting('hid.test.chain1_execution')::uuid,
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_1')::uuid, 2, 'entered_in_error',
  current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid,
  'The specimen belonged to another patient', 'p4c-returns-invalid-01', repeat('d', 64),
  current_setting('app.correlation_id'));
-- Route 2's result was never released: its invalidation crosses nothing.
insert into lab.result_invalidations (result_id, execution_id, patient_id, facility_id, result_version, disposition,
  actor_id, actor_membership_id, reason, idempotency_key, request_sha256, correlation_id)
values (current_setting('hid.test.result_2')::uuid, current_setting('hid.test.chain2_execution')::uuid,
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_1')::uuid, 1, 'entered_in_error',
  current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid,
  'The analyser was out of calibration', 'p4c-returns-invalid-02', repeat('d', 64),
  current_setting('app.correlation_id'));
reset role;
select pg_temp.assert('an invalidation of a version that came back is reported', exists (select 1
  from lab.order_route_result_reports report where report.route_id = current_setting('hid.test.route_1')::uuid
    and report.kind = 'entered_in_error' and report.result_version = 2 and report.numeric_value is null
    and report.text_value is null)
  and (select event.event_type from ehr.order_route_events event where event.route_id = current_setting('hid.test.route_1')::uuid
       order by event.event_version desc limit 1) = 'result_marked_in_error'
  and exists (select 1 from audit.events event where event.action = 'ehr.order-route.result-marked-in-error'
    and event.resource_id = current_setting('hid.test.route_1') and event.patient_id is not null));
select pg_temp.assert('an invalidation of a version that never came back crosses nothing',
  not exists (select 1 from lab.order_route_result_reports report where report.route_id = current_setting('hid.test.route_2')::uuid)
  and (select route.state from ehr.order_routes route where route.id = current_setting('hid.test.route_2')::uuid) = 'accepted');

-- 4. Dispensing and reversal, by PB2 under route access.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select set_config('hid.test.dispensing_1', pg_temp.dispense(current_setting('hid.test.rxitem_1')::uuid,
  'p4c-returns-dispense-01')::text, true);
insert into pharmacy.dispensing_reversals (dispensing_id, dispensing_version, work_item_id, patient_id, facility_id,
  reversed_by, reversed_by_membership_id, reason, idempotency_key, request_sha256, correlation_id)
values (current_setting('hid.test.dispensing_1')::uuid, 1, current_setting('hid.test.rxitem_1')::uuid,
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_2')::uuid,
  'e4c10000-0000-4000-8000-000000000033', 'e4c13000-0000-4000-8000-000000000033', 'Wrong strength handed out',
  'p4c-returns-reverse-01', repeat('e', 64), current_setting('app.correlation_id'));
reset role;
do $$
declare
  route ehr.order_routes%rowtype;
begin
  select * into route from ehr.order_routes where id = current_setting('hid.test.rxroute_1')::uuid;
  perform pg_temp.assert('dispensing and reversal reported', (select array_agg(report.kind || ':' || report.quantity_dispensed
      || ':' || report.quantity_unit || ':' || report.medication_display || ':' || (report.reversal_id is not null)
      order by report.recorded_at) from pharmacy.order_route_dispensing_reports report where report.route_id = route.id)
    = array['dispensed:21.0000:capsule:Amoxicillin 500 mg:false', 'reversed:21.0000:capsule:Amoxicillin 500 mg:true']);
  perform pg_temp.assert('the prescription route completed with its windows', route.state = 'completed'
    and route.writes_end_at = least(route.completed_at + interval '14 days', route.accepted_at + interval '45 days'));
  perform pg_temp.assert('events completed then dispensing_reversed', (select array_agg(event.event_type
      order by event.event_version) from ehr.order_route_events event where event.route_id = route.id)
    = array['created', 'accepted', 'completed', 'dispensing_reversed']);
  perform pg_temp.assert('A told of both', (select array_agg(event.action order by event.sequence_id) from audit.events event
      where event.resource_id = route.id::text and event.facility_id = route.ordering_facility_id
        and event.action like 'ehr.order-route.dispensing-%')
    = array['ehr.order-route.dispensing-returned', 'ehr.order-route.dispensing-reversed']);
end $$;

-- 5. What A reads (C3, C4).
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.assert('C3 gives A the results', (select listed.summary ->> 'effectiveState' = 'completed'
    and jsonb_array_length(listed.reports) = 3
    and listed.reports -> 0 ->> 'numericValue' = '10.4' and listed.reports -> 1 ->> 'correctionReason' = 'Analyser recalibrated'
    and listed.reports -> 2 ->> 'kind' = 'entered_in_error'
    and listed.attestation = jsonb_build_object('textVersion', 'order-route-lab-attestation-v1', 'attestedByName',
      'Ada Doctor', 'attestedAt', listed.attestation -> 'attestedAt', 'receivingFacilityName', 'P4c Sign-up Laboratory Ltd')
    and listed.receiving_available
    and (select array_agg(event ->> 'type') from jsonb_array_elements(listed.events) event)
      = array['created', 'accepted', 'completed', 'result_returned', 'result_marked_in_error']
    and not exists (select 1 from jsonb_array_elements(listed.events) event where event ? 'actorAccountId'
      or event ? 'actor_account_id' or event ? 'actorMembershipId')
  from ehr.list_order_routes_for_order('lab_request', 'e4c30000-0000-4000-8000-000000000001',
    current_setting('hid.test.lr_1')::uuid) listed));
select pg_temp.assert('C3 gives A the dispensing', (select jsonb_array_length(listed.reports) = 2
    and listed.reports -> 0 -> 'medication' ->> 'display' = 'Amoxicillin 500 mg'
  from ehr.list_order_routes_for_order('prescription', 'e4c30000-0000-4000-8000-000000000001',
    current_setting('hid.test.rx_1')::uuid) listed));
select set_config('hid.test.lr_draft', pg_temp.lab_request(1, 'draft')::text, true);
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.assert('C4 summaries, one per distinct order, NULL without a route',
  (select array_agg(summary.order_id::text || ':' || coalesce(summary.summary ->> 'effectiveState', 'none')
     order by summary.order_id)
     from ehr.order_route_summaries('lab_request', 'e4c30000-0000-4000-8000-000000000001',
       array[current_setting('hid.test.lr_1')::uuid, current_setting('hid.test.lr_2')::uuid,
             current_setting('hid.test.lr_draft')::uuid, current_setting('hid.test.lr_1')::uuid]) summary)
  = (select array_agg(pair order by pair) from (values
      (current_setting('hid.test.lr_1') || ':completed'), (current_setting('hid.test.lr_2') || ':accepted'),
      (current_setting('hid.test.lr_draft') || ':none')) v(pair)));
select pg_temp.check('C4 with another patient''s order', format($s$select * from ehr.order_route_summaries('lab_request',
  'e4c30000-0000-4000-8000-000000000002', array[%L::uuid])$s$, current_setting('hid.test.lr_1')), 'P0002 ORDER_NOT_FOUND');
select pg_temp.check('C4 with too many orders', $s$select * from ehr.order_route_summaries('lab_request',
  'e4c30000-0000-4000-8000-000000000001', array_fill(gen_random_uuid(), array[201]))$s$, '22023 ORDER_ROUTE_INVALID');
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001', 'emergency');
select pg_temp.check('C3 under emergency', format($s$select * from ehr.list_order_routes_for_order('lab_request',
  'e4c30000-0000-4000-8000-000000000001', %L)$s$, current_setting('hid.test.lr_1')), '42501 Order route staff context is required');
select pg_temp.check('C4 under emergency', format($s$select * from ehr.order_route_summaries('lab_request',
  'e4c30000-0000-4000-8000-000000000001', array[%L::uuid])$s$, current_setting('hid.test.lr_1')),
  '42501 Order route staff context is required');
select pg_temp.as_staff(17, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('C3 without read consent', format($s$select * from ehr.list_order_routes_for_order('lab_request',
  'e4c30000-0000-4000-8000-000000000001', %L)$s$, current_setting('hid.test.lr_1')), 'P0002 ORDER_NOT_FOUND');
select pg_temp.as_staff(26, 'e4c21000-0000-4000-8000-000000000003');
select pg_temp.check('C3 at a third facility', format($s$select * from ehr.list_order_routes_for_order('lab_request',
  'e4c30000-0000-4000-8000-000000000001', %L)$s$, current_setting('hid.test.lr_1')), 'P0002 ORDER_NOT_FOUND');
select pg_temp.as_signup_admin(1);
select pg_temp.check('C3 at the receiving facility', format($s$select * from ehr.list_order_routes_for_order('lab_request',
  'e4c30000-0000-4000-8000-000000000001', %L)$s$, current_setting('hid.test.lr_1')), 'P0002 ORDER_NOT_FOUND');
reset role;
-- B and a third facility cannot read the report tables at all.
select pg_temp.assert('no runtime reads the reports', not has_table_privilege('hid_lab_api_runtime',
    'lab.order_route_result_reports', 'SELECT')
  and not has_table_privilege('hid_ehr_api_runtime', 'lab.order_route_result_reports', 'SELECT')
  and not has_table_privilege('hid_pharmacy_api_runtime', 'pharmacy.order_route_dispensing_reports', 'SELECT'));

-- 6. The replaced release trigger (0088). Lab routes 3 and 4, accepted by
-- LB1, v1 released by LB1; support (FR) closes route 3; LB2 reports route 4
-- as accepted for the wrong person. Each result then gets a verified
-- correction v2 (owner SQL), which LB2, holding P's consent at L1, releases.
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(3, 4) n;
select set_config('hid.test.route_' || n, pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_' || n)::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-returns-send-000' || n)::text, true) from generate_series(3, 4) n;
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select set_config('hid.test.item_' || n, (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.route_' || n)::uuid, 1, 'health_id', 'HID-P4CPATP', 'p4c-returns-accept-' || n || '0',
  repeat('a', 64)) accepted), true) from generate_series(3, 4) n;
reset role;
select set_config('hid.test.result_' || n, pg_temp.lab_chain(current_setting('hid.test.item_' || n)::uuid, 'chain' || n,
  10.4)::text, true) from generate_series(3, 4) n;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.release(current_setting('hid.test.result_' || n)::uuid, 1,
  current_setting('hid.test.chain' || n || '_verification_1')::uuid, 'p4c-returns-release-' || n || '1')
  from generate_series(3, 4) n;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select reported.result from lab.report_wrong_patient_order_route(current_setting('hid.test.route_4')::uuid, 3,
  'someone_elses_details', 'The person gave another patient''s details', 'p4c-returns-wrong-0004', repeat('a', 64))
  reported;
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select closed.state from identity.admin_close_order_route(current_setting('hid.test.route_3')::uuid, 3,
  'The hospital asked support to close it') closed;
reset role;
select set_config('hid.test.chain' || n || '_verification_2', pg_temp.lab_correction(
  current_setting('hid.test.result_' || n)::uuid, 'chain' || n, 11.2, current_setting('hid.test.account_1')::uuid,
  current_setting('hid.test.membership_1')::uuid)::text, true) from generate_series(3, 4) n;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
values (gen_random_uuid(), 'e4c30000-0000-4000-8000-000000000001', 'e4c12000-0000-4000-8000-000000000031',
  'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', current_setting('hid.test.facility_1')::uuid,
  'write_records', 'active', 'P4c suite consent at the laboratory', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '30 days', false, 'direct-care');
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a consent release on the route support closed', format($s$select pg_temp.release(%L, 2, %L,
  'p4c-returns-release-32')$s$, current_setting('hid.test.result_3'), current_setting('hid.test.chain3_verification_2')),
  'ok');
select pg_temp.check('a consent release on the route ended as fulfilled for the wrong person', format($s$select
  pg_temp.release(%L, 2, %L, 'p4c-returns-release-42')$s$, current_setting('hid.test.result_4'),
  current_setting('hid.test.chain4_verification_2')), '23514 ORDER_ROUTE_CLOSED');
reset role;
select pg_temp.assert('the support-closed route still files it; the wrong-patient route files nothing more',
  (select array_agg(report.kind || ':' || report.result_version order by report.recorded_at, report.id)
     from lab.order_route_result_reports report where report.route_id = current_setting('hid.test.route_3')::uuid)
    = array['released:1', 'released:2']
  and (select array_agg(report.kind || ':' || report.result_version order by report.recorded_at, report.id)
     from lab.order_route_result_reports report where report.route_id = current_setting('hid.test.route_4')::uuid)
    = array['released:1', 'entered_in_error:1']
  and not exists (select 1 from lab.result_releases release_row
                   where release_row.result_id = current_setting('hid.test.result_4')::uuid
                     and release_row.result_version = 2));

-- 7. The replaced release trigger (0090). LB1 reports route 3 (support
-- closed, v1 and v2 back at A) late: both are withdrawn at A, the ending
-- (support) stays. A version 3 (owner SQL, verified) released under P's
-- consent by LB2 is then refused.
select set_config('hid.test.version_3', (select route.row_version::text from ehr.order_routes route
  where route.id = current_setting('hid.test.route_3')::uuid), true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('LB1 reports route 3 late', format($s$select * from lab.correct_wrong_patient_order_route(%L, %s,
  'someone_elses_details', 'patient', (clock_timestamp() at time zone 'Africa/Lagos')::date,
  'The patient says it was not them', 'p4c-returns-late-0003', repeat('a', 64))$s$, current_setting('hid.test.route_3'),
  current_setting('hid.test.version_3')), 'ok');
reset role;
do $$
declare
  head lab.results%rowtype;
  verification_id uuid := gen_random_uuid();
begin
  select * into head from lab.results where id = current_setting('hid.test.result_3')::uuid;
  set local session_replication_role = replica;
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, correction_reason,
    idempotency_key, request_sha256, correlation_id, revision_kind, supersedes_version)
  values (head.id, head.execution_id, head.patient_id, head.facility_id, 3, 'numeric', 12.1, 'g/dL', '12.0-15.5',
    'normal', 'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', 'Repeated the run',
    'p4c-returns-rev-chain3-003', repeat('a', 64), 'p4c-chain', 'correction', 2);
  update lab.results set current_version = 3 where id = head.id;
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, head.id, head.execution_id, head.patient_id, head.facility_id, 3,
    current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid, clock_timestamp(),
    'Verified the repeat', 'p4c-returns-ver-chain3-003', repeat('a', 64), 'p4c-chain');
  set local session_replication_role = origin;
  perform set_config('hid.test.chain3_verification_3', verification_id::text, true);
end $$;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a consent release on the route reported late', format($s$select pg_temp.release(%L, 3, %L,
  'p4c-returns-release-33')$s$, current_setting('hid.test.result_3'), current_setting('hid.test.chain3_verification_3')),
  '23514 ORDER_ROUTE_CLOSED');
reset role;
select pg_temp.assert('the late-reported route: both releases withdrawn at A, nothing more filed, support''s ending kept',
  (select array_agg(report.kind || ':' || report.result_version order by report.kind, report.result_version)
     from lab.order_route_result_reports report where report.route_id = current_setting('hid.test.route_3')::uuid)
    = array['entered_in_error:1', 'entered_in_error:2', 'released:1', 'released:2']
  and (select route.ended_kind = 'support' and route.state = 'completed' from ehr.order_routes route
        where route.id = current_setting('hid.test.route_3')::uuid)
  and not exists (select 1 from lab.result_releases release_row
                   where release_row.result_id = current_setting('hid.test.result_3')::uuid
                     and release_row.result_version = 3));

-- 8. "We can't complete this order" (0091, D18): nothing comes back after
-- the ending. Lab routes 5 and 6 and prescription routes 2 and 3, accepted
-- by LB1 and PB1. Route 5 carries a checked result: the ending is refused
-- until it is released, and then refused because the route completed (a
-- result went back). Route 6 is ended with nothing recorded; a verified
-- result written afterwards (owner SQL, as a write whose access check
-- passed before the ending) is refused at release under P's consent (LB2),
-- and nothing reaches A. Prescription 2 is dispensed (completed): refused;
-- prescription 3 is ended, and a dispensing afterwards is refused.
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(5, 6) n;
select set_config('hid.test.route_' || n, pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_' || n)::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-returns-send-000' || n)::text, true) from generate_series(5, 6) n;
select set_config('hid.test.rx_' || n, pg_temp.prescription(1, 'active')::text, true) from generate_series(2, 3) n;
select set_config('hid.test.rxroute_' || n, pg_temp.send(11, 'prescription', current_setting('hid.test.rx_' || n)::uuid,
  current_setting('hid.test.facility_2')::uuid, 'p4c-returns-send-rx0' || n)::text, true) from generate_series(2, 3) n;
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select set_config('hid.test.item_' || n, (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.route_' || n)::uuid, 1, 'health_id', 'HID-P4CPATP', 'p4c-returns-accept-' || n || '0',
  repeat('a', 64)) accepted), true) from generate_series(5, 6) n;
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_signup_admin(2);
select set_config('hid.test.rxitem_' || n, (select accepted.work_item_id::text from pharmacy.accept_order_route(
  current_setting('hid.test.rxroute_' || n)::uuid, 1, 'health_id', 'HID-P4CPATP', 'Patient collected the prescription',
  'p4c-returns-rx-accept-' || n, repeat('a', 64)) accepted), true) from generate_series(2, 3) n;
reset role;
select set_config('hid.test.result_5', pg_temp.lab_chain(current_setting('hid.test.item_5')::uuid, 'chain5',
  10.4)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('a checked result waits on route 5: the ending is refused', format($s$select * from
  lab.cannot_complete_order_route(%L, 2, 'supplies_unavailable', false, 'p4c-returns-unable-0005', repeat('a', 64))$s$,
  current_setting('hid.test.route_5')), 'P0001 ORDER_ROUTE_RESULT_READY');
select pg_temp.release(current_setting('hid.test.result_5')::uuid, 1,
  current_setting('hid.test.chain5_verification_1')::uuid, 'p4c-returns-release-51');
select pg_temp.check('route 5 completed by its release: the ending is refused', format($s$select * from
  lab.cannot_complete_order_route(%L, 3, 'supplies_unavailable', false, 'p4c-returns-unable-0005', repeat('a', 64))$s$,
  current_setting('hid.test.route_5')), 'P0001 ORDER_ROUTE_ALREADY_RETURNED');
select pg_temp.check('route 6 ended, nothing recorded', format($s$select result from lab.cannot_complete_order_route(
  %L, 2, 'equipment_unavailable', false, 'p4c-returns-unable-0006', repeat('a', 64))$s$,
  current_setting('hid.test.route_6')), 'ok');
reset role;
select set_config('hid.test.result_6', pg_temp.lab_chain(current_setting('hid.test.item_6')::uuid, 'chain6',
  10.4)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a release under P''s consent after the ending', format($s$select pg_temp.release(%L, 1, %L,
  'p4c-returns-release-61')$s$, current_setting('hid.test.result_6'), current_setting('hid.test.chain6_verification_1')),
  '23514 ORDER_ROUTE_CLOSED');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.dispense(current_setting('hid.test.rxitem_2')::uuid, 'p4c-returns-dispense-rx02');
select pg_temp.as_signup_admin(2);
select pg_temp.check('prescription 2 completed by its dispensing: the ending is refused', format($s$select * from
  pharmacy.cannot_complete_order_route(%L, 3, 'out_of_stock', 'p4c-returns-unable-rx02', repeat('a', 64))$s$,
  current_setting('hid.test.rxroute_2')), 'P0001 ORDER_ROUTE_ALREADY_RETURNED');
select pg_temp.check('prescription 3 ended', format($s$select result from pharmacy.cannot_complete_order_route(%L, 2,
  'out_of_stock', 'p4c-returns-unable-rx03', repeat('a', 64))$s$, current_setting('hid.test.rxroute_3')), 'ok');
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.assert('a dispensing on prescription 3 after the ending is refused (23514)', left(pg_temp.outcome(format(
  $s$select pg_temp.dispense(%L, 'p4c-returns-dispense-rx03')$s$, current_setting('hid.test.rxitem_3'))), 5) = '23514');
reset role;
select pg_temp.assert('after the endings nothing reached A: route 6 and prescription 3 file no report, route 5''s and '
    || 'prescription 2''s returns stand',
  not exists (select 1 from lab.order_route_result_reports report
               where report.route_id = current_setting('hid.test.route_6')::uuid)
  and not exists (select 1 from lab.result_releases release_row
                   where release_row.result_id = current_setting('hid.test.result_6')::uuid)
  and not exists (select 1 from pharmacy.order_route_dispensing_reports report
                   where report.route_id = current_setting('hid.test.rxroute_3')::uuid)
  and (select array_agg(report.kind || ':' || report.result_version) from lab.order_route_result_reports report
        where report.route_id = current_setting('hid.test.route_5')::uuid) = array['released:1']
  and (select array_agg(report.kind) from pharmacy.order_route_dispensing_reports report
        where report.route_id = current_setting('hid.test.rxroute_2')::uuid) = array['dispensed']
  and (select array_agg(route.state || ':' || coalesce(route.ended_kind, '-') order by route.kind, route.created_at)
         from ehr.order_routes route
        where route.id in (current_setting('hid.test.route_5')::uuid, current_setting('hid.test.route_6')::uuid,
          current_setting('hid.test.rxroute_2')::uuid, current_setting('hid.test.rxroute_3')::uuid))
    = array['completed:-', 'cancelled:receiving_unable', 'completed:-', 'cancelled:receiving_unable']);

select pg_temp.report();
rollback;
