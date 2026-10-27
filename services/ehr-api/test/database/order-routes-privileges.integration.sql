-- Privileges, protections and audit hygiene of 0086 section 6 (P4c).
-- Rollback-only.
--   1. EXECUTE on every section 6 function exactly as section 7 grants it
--      (SPEC-FINAL 8.10): the commands to their runtime and the schema test
--      runtime, support's to Identity only, the helpers and trigger functions
--      to no role; PUBLIC on none; and 0088's (item 3: the wrong-patient
--      report's wrappers and recreated cards, support's list and review, the
--      ordering facility's Overview read) exactly as its section 5 grants them,
--      and 0089's (item 4: the Lab and Pharmacy wrappers of whether this
--      facility receives and whether orders wait or are held here; support's
--      recreated find) exactly as its section 5 grants them, and 0090's (D17:
--      the Lab and Pharmacy late correction and lookup; the patient's list,
--      support's reports list and find, recreated) exactly as its section 9
--      grants them, and 0091's (D18: the Lab and Pharmacy "can't complete";
--      support's counts) exactly as its section 6 grants them;
--   2. no runtime privilege on any new table and no sequence; row-level
--      security enabled and forced with its four policies; the work lists'
--      strict policies; every new trigger enabled 'O';
--   3. the no-mutation triggers and the route guard refuse, as the cluster
--      superuser too: an update or delete of an append-only row; a route
--      change without its event (P5); a direct insert without its first
--      event; a set-once column changed;
--   4. after a run through every command (send, mismatch and accept, release,
--      correction, invalidation, dispensing, reversal, decline, withdrawal,
--      Stop, support's close, the destination setting, 0088's wrong-patient
--      report): each route's event
--      history replays to its head; no row at the receiving facility carries
--      the patient before acceptance (P4.1); no row written for the other
--      facility carries an account or membership (P4.2); no details carry a
--      name, test or medicine text, a value, a licence number or an
--      identifier; the inbox items carry the four metadata keys only.
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
-- 1. EXECUTE.
create temp table expected_execute (signature regprocedure primary key, grantees text[]) on commit drop;
insert into expected_execute
select signature::regprocedure, grantees from (values
  ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', array['hid_ehr_runtime', 'hid_schema_test_runtime']),
  ('ehr.withdraw_order_route(uuid,text,uuid,bigint,text)', array['hid_ehr_runtime', 'hid_schema_test_runtime']),
  ('ehr.list_order_routes_for_order(text,uuid,uuid)', array['hid_ehr_runtime', 'hid_schema_test_runtime']),
  ('ehr.order_route_summaries(text,uuid,uuid[])', array['hid_ehr_runtime', 'hid_schema_test_runtime']),
  ('ehr.patient_list_order_routes()', array['hid_ehr_runtime', 'hid_schema_test_runtime']),
  ('ehr.patient_stop_order_route(uuid,bigint)', array['hid_ehr_runtime', 'hid_schema_test_runtime']),
  ('ehr.order_route_attestation_text(text)', array['hid_ehr_runtime', 'hid_schema_test_runtime']),
  ('lab.list_order_routes(text,text)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('lab.get_order_route(uuid)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('lab.accept_order_route(uuid,bigint,text,text,text,character,text)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('lab.decline_order_route(uuid,bigint,text)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('lab.order_route_access_for(text,uuid,text)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('lab.order_route_cards(uuid[])', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('lab.work_item_allows(uuid,uuid,uuid,text)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.list_order_routes(text,text)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.get_order_route(uuid)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.accept_order_route(uuid,bigint,text,text,text,text,character,text)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.decline_order_route(uuid,bigint,text)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.order_route_access_for(text,uuid,text)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.order_route_cards(uuid[])', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.work_item_allows(uuid,uuid,uuid,text)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('identity.search_order_destinations(text,text)', array['hid_identity_runtime', 'hid_schema_test_runtime']),
  ('identity.admin_order_route_summary(uuid)', array['hid_identity_runtime']),
  ('identity.admin_find_order_routes(text,text)', array['hid_identity_runtime']),
  ('identity.admin_close_order_route(uuid,bigint,text)', array['hid_identity_runtime']),
  ('identity.admin_set_order_route_destination(uuid,boolean,text)', array['hid_identity_runtime']),
  ('identity.list_my_notification_inbox(integer)', array['hid_identity_runtime']),
  ('identity.mark_my_notification_read(uuid)', array['hid_identity_runtime']),
  -- 0088 (item 3).
  ('lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('identity.admin_list_wrong_patient_reports(text,uuid)', array['hid_identity_runtime']),
  ('identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)', array['hid_identity_runtime']),
  ('ehr.list_sent_wrong_patient_order_routes()', array['hid_ehr_runtime', 'hid_schema_test_runtime']),
  -- 0089 (item 4): whether this facility receives, and whether orders wait
  -- or are held here; support's find (C21) recreated, still Identity's alone.
  ('lab.order_route_receives_here()', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('lab.order_routes_here()', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.order_route_receives_here()', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.order_routes_here()', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  -- 0090 (D17): the late correction and the lookup, Lab's and Pharmacy's.
  ('lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('lab.find_correctable_order_routes(text)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.find_correctable_order_routes(text)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  -- 0091 (D18): "We can't complete this order", Lab's and Pharmacy's;
  -- support's counts, Identity's alone.
  ('lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('identity.admin_order_route_not_completed(uuid)', array['hid_identity_runtime'])) v(signature, grantees);
-- Every other function section 6, 0088, 0089, 0090 or 0091 creates or
-- replaces: owner only (0088's shared command and its report table's guard,
-- 0089's two shared helpers, 0090's shared command, lookup and two helpers,
-- and 0091's shared command and its endings table's guard, among them).
insert into expected_execute
select p.oid::regprocedure, array[]::text[]
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('ehr', 'lab', 'pharmacy', 'identity')
   and (p.proname ~ '(order_route|order_destination)' or p.proname in ('sync_order_routes_on_order_change',
          'close_order_routes_on_release'))
   and p.oid not in (select signature from expected_execute);
create temp table actual_execute on commit drop as
select expected.signature, coalesce((select array_agg(acl.grantee::regrole::text order by acl.grantee::regrole::text)
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
   where p.oid = expected.signature and acl.privilege_type = 'EXECUTE' and acl.grantee <> p.proowner),
    array[]::text[]) as grantees
  from expected_execute expected;
select pg_temp.assert('section 6 has its 69 functions, with the two inbox functions 71, 0088 adds 7, 0089 6, 0090 8 and 0091 5: 97',
  (select count(*) from expected_execute) = 97, (select count(*) from expected_execute)::text);
select pg_temp.assert('EXECUTE exactly as section 7 grants it', not exists (select 1 from expected_execute expected
    join actual_execute actual using (signature) where actual.grantees <> expected.grantees),
  (select string_agg(expected.signature::text || ' ' || actual.grantees::text, '; ') from expected_execute expected
     join actual_execute actual using (signature) where actual.grantees <> expected.grantees));
select pg_temp.assert('PUBLIC executes none', not exists (select 1 from expected_execute expected, pg_proc p,
    aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
   where p.oid = expected.signature and acl.grantee = 0));
select pg_temp.assert('every helper, view function and trigger function is the owner''s alone',
  (select count(*) from expected_execute where cardinality(grantees) = 0) = 53
  and (select count(*) from expected_execute where cardinality(grantees) = 0
         and signature in ('ehr.order_route_receives_here(text)'::regprocedure, 'ehr.order_routes_here(text)'::regprocedure,
           'ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)'::regprocedure,
           'ehr.find_correctable_order_routes(text,text)'::regprocedure,
           'ehr.order_route_correctable_until(ehr.order_routes)'::regprocedure,
           'ehr.order_route_correction_state(ehr.order_routes)'::regprocedure,
           'ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,character)'::regprocedure,
           'ehr.guard_order_route_unable_ending()'::regprocedure))
    = 8
  and not exists (select 1 from expected_execute expected, pg_roles runtime
    where cardinality(expected.grantees) = 0 and runtime.rolname ~ '^hid_.*runtime$'
      and has_function_privilege(runtime.oid, expected.signature, 'EXECUTE')));
select pg_temp.assert('the API runtimes reach the commands through their parents',
  has_function_privilege('hid_ehr_api_runtime', 'ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_lab_api_runtime', 'lab.accept_order_route(uuid,bigint,text,text,text,character,text)', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.accept_order_route(uuid,bigint,text,text,text,text,character,text)', 'EXECUTE')
  and has_function_privilege('hid_identity_api_runtime', 'identity.admin_close_order_route(uuid,bigint,text)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'lab.accept_order_route(uuid,bigint,text,text,text,character,text)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_identity_api_runtime', 'ehr.close_order_route(uuid,text,text,boolean)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'identity.admin_close_order_route(uuid,bigint,text)', 'EXECUTE')
  and not has_function_privilege('hid_notification_worker', 'identity.list_my_notification_inbox(integer)', 'EXECUTE')
  -- 0089: each receiving runtime reaches its own wrappers only, and support's
  -- find stays Identity's.
  and has_function_privilege('hid_lab_api_runtime', 'lab.order_route_receives_here()', 'EXECUTE')
  and has_function_privilege('hid_lab_api_runtime', 'lab.order_routes_here()', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'pharmacy.order_route_receives_here()', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'pharmacy.order_routes_here()', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.order_route_receives_here(text)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.order_routes_here(text)', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.order_route_receives_here()', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.order_routes_here()', 'EXECUTE')
  and not has_function_privilege('hid_pharmacy_api_runtime', 'lab.order_route_receives_here()', 'EXECUTE')
  and not has_function_privilege('hid_pharmacy_api_runtime', 'lab.order_routes_here()', 'EXECUTE')
  and has_function_privilege('hid_identity_api_runtime', 'identity.admin_find_order_routes(text,text)', 'EXECUTE')
  and not has_function_privilege('hid_schema_test_runtime', 'identity.admin_find_order_routes(text,text)', 'EXECUTE')
  and not has_function_privilege('hid_identity_api_runtime', 'lab.order_route_receives_here()', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'lab.order_route_receives_here()', 'EXECUTE')
  -- 0090: each receiving runtime reaches its own late correction and lookup
  -- only; the shared command, lookup and helpers no runtime.
  and has_function_privilege('hid_lab_api_runtime', 'lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_lab_api_runtime', 'lab.find_correctable_order_routes(text)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.correct_wrong_patient_order_route(text,uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.find_correctable_order_routes(text)', 'EXECUTE')
  and not has_function_privilege('hid_pharmacy_api_runtime', 'lab.find_correctable_order_routes(text)', 'EXECUTE')
  and not has_function_privilege('hid_pharmacy_api_runtime', 'ehr.find_correctable_order_routes(text,text)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'lab.correct_wrong_patient_order_route(uuid,bigint,text,text,date,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_identity_api_runtime', 'pharmacy.find_correctable_order_routes(text)', 'EXECUTE')
  and not has_function_privilege('hid_identity_api_runtime', 'ehr.order_route_correction_state(ehr.order_routes)', 'EXECUTE')
  and has_function_privilege('hid_ehr_api_runtime', 'ehr.patient_list_order_routes()', 'EXECUTE')
  and has_function_privilege('hid_identity_api_runtime', 'identity.admin_list_wrong_patient_reports(text,uuid)', 'EXECUTE')
  -- 0091: each receiving runtime reaches its own "can't complete" only;
  -- support's counts Identity's; the shared command no runtime.
  and has_function_privilege('hid_lab_api_runtime', 'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.cannot_complete_order_route(text,uuid,bigint,text,boolean,text,character)', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.cannot_complete_order_route(uuid,bigint,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_pharmacy_api_runtime', 'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)', 'EXECUTE')
  and has_function_privilege('hid_identity_api_runtime', 'identity.admin_order_route_not_completed(uuid)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'identity.admin_order_route_not_completed(uuid)', 'EXECUTE')
  and not has_function_privilege('hid_schema_test_runtime', 'identity.admin_order_route_not_completed(uuid)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'lab.cannot_complete_order_route(uuid,bigint,text,boolean,text,character)', 'EXECUTE'));

-- 2. Tables, sequences, row-level security, triggers.
create temp table new_tables (relation regclass primary key) on commit drop;
insert into new_tables values ('ehr.order_routes'), ('ehr.order_route_events'), ('ehr.order_route_accept_attempts'),
  ('ehr.order_route_attestation_texts'), ('lab.order_route_result_reports'), ('pharmacy.order_route_dispensing_reports'),
  ('identity.order_route_destination_settings'), ('ehr.order_route_wrong_patient_reports'),
  ('ehr.order_route_unable_endings');
select pg_temp.assert('no role but the owner holds a privilege on a new table', not exists (select 1
    from new_tables t join pg_class c on c.oid = t.relation, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
   where acl.grantee <> c.relowner)
  and not exists (select 1 from new_tables t, pg_roles runtime where runtime.rolname ~ '^hid_'
    and runtime.rolname <> (select r.rolname from pg_class c join pg_roles r on r.oid = c.relowner where c.oid = t.relation)
    and (has_table_privilege(runtime.oid, t.relation, 'SELECT') or has_table_privilege(runtime.oid, t.relation, 'INSERT')
      or has_table_privilege(runtime.oid, t.relation, 'UPDATE') or has_table_privilege(runtime.oid, t.relation, 'DELETE')
      or has_table_privilege(runtime.oid, t.relation, 'TRUNCATE') or has_table_privilege(runtime.oid, t.relation, 'REFERENCES')
      or has_table_privilege(runtime.oid, t.relation, 'TRIGGER'))));
select pg_temp.assert('no sequence', not exists (select 1 from pg_depend d join pg_class s on s.oid = d.objid
    where s.relkind = 'S' and d.refobjid in (select relation from new_tables))
  and not exists (select 1 from new_tables t join pg_attribute a on a.attrelid = t.relation
    where a.attnum > 0 and not a.attisdropped and a.attidentity <> ''));
select pg_temp.assert('row-level security enabled and forced, four policies each',
  (select bool_and(c.relrowsecurity and c.relforcerowsecurity) from new_tables t join pg_class c on c.oid = t.relation)
  and (select bool_and((select count(*) from pg_policy p where p.polrelid = t.relation) = 4) from new_tables t));
-- 0090's capability table: no role but its owner holds a privilege; forced
-- row-level security with three policies (select, insert, delete; no
-- update); no sequence.
select pg_temp.assert('the late correction''s capability table: owner only, forced row-level security, three policies',
  not exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
               where c.oid = 'ehr.order_route_correction_capabilities'::regclass and acl.grantee <> c.relowner)
  and not exists (select 1 from pg_roles runtime where runtime.rolname ~ '^hid_'
    and runtime.oid <> (select c.relowner from pg_class c where c.oid = 'ehr.order_route_correction_capabilities'::regclass)
    and (has_table_privilege(runtime.oid, 'ehr.order_route_correction_capabilities', 'SELECT')
      or has_table_privilege(runtime.oid, 'ehr.order_route_correction_capabilities', 'INSERT')
      or has_table_privilege(runtime.oid, 'ehr.order_route_correction_capabilities', 'UPDATE')
      or has_table_privilege(runtime.oid, 'ehr.order_route_correction_capabilities', 'DELETE')))
  and (select c.relrowsecurity and c.relforcerowsecurity from pg_class c
        where c.oid = 'ehr.order_route_correction_capabilities'::regclass)
  and (select array_agg(p.polcmd::text order by p.polcmd::text) from pg_policy p
        where p.polrelid = 'ehr.order_route_correction_capabilities'::regclass) = array['a', 'd', 'r']
  and not exists (select 1 from pg_depend d join pg_class s on s.oid = d.objid
                   where s.relkind = 'S' and d.refobjid = 'ehr.order_route_correction_capabilities'::regclass));
select pg_temp.assert('the work lists'' strict policies', (select array_agg(p.polrelid::regclass::text || ':'
      || p.polname || ':' || p.polcmd::text || ':' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ':'
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') order by p.polrelid::regclass::text, p.polname)
    from pg_policy p where p.polrelid in ('lab.work_items'::regclass, 'pharmacy.work_items'::regclass))
  = array[
    'lab.work_items:lab_work_items_insert:a::lab.work_item_allows(patient_id, facility_id, order_route_id, ''write_records''::text)',
    'lab.work_items:lab_work_items_read:r:lab.work_item_allows(patient_id, facility_id, order_route_id, ''read_records''::text):',
    'pharmacy.work_items:pharmacy_work_items_insert:a::pharmacy.work_item_allows(patient_id, facility_id, order_route_id, ''write_records''::text)',
    'pharmacy.work_items:pharmacy_work_items_read:r:pharmacy.work_item_allows(patient_id, facility_id, order_route_id, ''read_records''::text):']);
select pg_temp.assert('the deferred first-event check and the triggers on other tables run as the owner',
  (select bool_and(p.prosecdef) from pg_proc p where p.oid in ('ehr.require_order_route_first_event()'::regprocedure,
    'ehr.sync_order_routes_on_order_change()'::regprocedure, 'ehr.close_order_routes_on_release()'::regprocedure,
    'lab.return_order_route_result()'::regprocedure, 'lab.return_order_route_invalidation()'::regprocedure,
    'pharmacy.return_order_route_dispensing()'::regprocedure, 'pharmacy.return_order_route_reversal()'::regprocedure)));
select pg_temp.assert('every new trigger is enabled ''O''', (select count(*) filter (where t.tgenabled = 'O')
    from pg_trigger t where not t.tgisinternal and t.tgname in ('order_routes_guard', 'order_routes_first_event',
      'order_route_attestation_texts_no_mutation', 'order_route_events_no_mutation',
      'order_route_accept_attempts_no_mutation', 'order_route_result_reports_no_mutation',
      'order_route_dispensing_reports_no_mutation', 'order_route_destination_settings_no_mutation',
      'lab_requests_order_routes_sync', 'prescriptions_order_routes_sync', 'result_releases_order_route_return',
      'result_invalidations_order_route_return', 'dispensings_order_route_return',
      'dispensing_reversals_order_route_return', 'organization_applications_order_routes_release',
      'order_route_wrong_patient_reports_guard', 'order_route_unable_endings_guard')) = 17);

-- 4 (run). Every command once.
create function pg_temp.accept(route uuid, n integer, identifier text, key text)
returns text language sql as $f$
  select accepted.result from lab.accept_order_route(route, 1, 'health_id', identifier, key, repeat('a', 64)) accepted
$f$;
grant execute on function pg_temp.accept(uuid,integer,text,text) to hid_lab_api_runtime;
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(1, 8) n;
select set_config('hid.test.rx_1', pg_temp.prescription(1, 'active')::text, true);
select set_config('hid.test.route_' || n, pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_' || n)::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-priv-send-' || lpad(n::text, 6, '0'))::text, true)
  from (values (1), (2), (3), (4), (5), (6), (8)) v(n);
select set_config('hid.test.rxroute_1', pg_temp.send(11, 'prescription', current_setting('hid.test.rx_1')::uuid,
  current_setting('hid.test.facility_2')::uuid, 'p4c-priv-send-rx0001')::text, true);
reset role;
select pg_temp.assert('no row at the receiving facility carries the patient before acceptance (sent)',
  not exists (select 1 from audit.events event join ehr.order_routes route on route.id::text = event.resource_id
    where event.facility_id = route.receiving_facility_id and event.patient_id is not null));
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.accept(current_setting('hid.test.route_1')::uuid, 1, 'HID-ZZZZZZZZ', 'p4c-priv-accept-000000');
select set_config('hid.test.item_1', (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.route_1')::uuid, 1, 'health_id', 'HID-P4CPATP', 'p4c-priv-accept-000001', repeat('a', 64))
  accepted), true);
select set_config('hid.test.item_2', (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.route_2')::uuid, 1, 'health_id', 'HID-P4CPATP', 'p4c-priv-accept-000002', repeat('a', 64))
  accepted), true);
select state from lab.decline_order_route(current_setting('hid.test.route_3')::uuid, 1, 'test_not_offered');
select set_config('hid.test.item_8', (select accepted.work_item_id::text from lab.accept_order_route(
  current_setting('hid.test.route_8')::uuid, 1, 'health_id', 'HID-P4CPATP', 'p4c-priv-accept-000008', repeat('a', 64))
  accepted), true);
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_signup_admin(2);
select set_config('hid.test.rxitem_1', (select accepted.work_item_id::text from pharmacy.accept_order_route(
  current_setting('hid.test.rxroute_1')::uuid, 1, 'date_of_birth', '1990-04-12', 'Patient collected the prescription',
  'p4c-priv-rx-accept-01', repeat('a', 64)) accepted), true);
reset role;
select set_config('hid.test.result_1', pg_temp.lab_chain(current_setting('hid.test.item_1')::uuid, 'priv1', 10.4)::text, true);
select set_config('hid.test.result_8', pg_temp.lab_chain(current_setting('hid.test.item_8')::uuid, 'priv8', 10.4)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.release(current_setting('hid.test.result_1')::uuid, 1, current_setting('hid.test.priv1_verification_1')::uuid,
  'p4c-priv-release-0001');
select pg_temp.release(current_setting('hid.test.result_8')::uuid, 1, current_setting('hid.test.priv8_verification_1')::uuid,
  'p4c-priv-release-0008');
-- 0088: LB1 reports route 8 (released) as accepted for the wrong person.
select result from lab.report_wrong_patient_order_route(current_setting('hid.test.route_8')::uuid, 3, 'suspected_misuse',
  'Counter mix-up with a twin sister', 'p4c-priv-wrong-patient-0008', repeat('f', 64));
reset role;
select set_config('hid.test.priv1_verification_2', pg_temp.lab_correction(current_setting('hid.test.result_1')::uuid,
  'priv1', 11.2, current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.release(current_setting('hid.test.result_1')::uuid, 2, current_setting('hid.test.priv1_verification_2')::uuid,
  'p4c-priv-release-0002');
insert into lab.result_invalidations (result_id, execution_id, patient_id, facility_id, result_version, disposition,
  actor_id, actor_membership_id, reason, idempotency_key, request_sha256, correlation_id)
values (current_setting('hid.test.result_1')::uuid, current_setting('hid.test.priv1_execution')::uuid,
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_1')::uuid, 2, 'entered_in_error',
  'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031',
  'The specimen belonged to another patient', 'p4c-priv-invalid-0001', repeat('d', 64), current_setting('app.correlation_id'));
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select set_config('hid.test.dispensing_1', pg_temp.dispense(current_setting('hid.test.rxitem_1')::uuid,
  'p4c-priv-dispense-001')::text, true);
insert into pharmacy.dispensing_reversals (dispensing_id, dispensing_version, work_item_id, patient_id, facility_id,
  reversed_by, reversed_by_membership_id, reason, idempotency_key, request_sha256, correlation_id)
values (current_setting('hid.test.dispensing_1')::uuid, 1, current_setting('hid.test.rxitem_1')::uuid,
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_2')::uuid,
  'e4c10000-0000-4000-8000-000000000033', 'e4c13000-0000-4000-8000-000000000033', 'Wrong strength handed out',
  'p4c-priv-reverse-001', repeat('e', 64), current_setting('app.correlation_id'));
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select state from ehr.withdraw_order_route(current_setting('hid.test.route_4')::uuid, 'lab_request',
  current_setting('hid.test.lr_4')::uuid, 1, 'patient_request');
select pg_temp.as_patient(1);
select state from ehr.patient_stop_order_route(current_setting('hid.test.route_5')::uuid, 1);
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select state from identity.admin_close_order_route(current_setting('hid.test.route_2')::uuid, 2,
  'The patient asked support to stop it');
select listed from identity.admin_set_order_route_destination(current_setting('hid.test.facility_1')::uuid, false,
  'The laboratory asked to leave the directory');
reset role;

-- 3. Refusals of the protections (as the cluster superuser).
select pg_temp.check('an update of an event', format($s$update ehr.order_route_events set reason_code = 'other'
  where route_id = %L$s$, current_setting('hid.test.route_1')), '55000 ehr.order_route_events is append-only');
select pg_temp.check('a delete of an event', format($s$delete from ehr.order_route_events where route_id = %L$s$,
  current_setting('hid.test.route_1')), '55000 ehr.order_route_events is append-only');
select pg_temp.check('an update of an attempt', $s$update ehr.order_route_accept_attempts set outcome = 'match'$s$,
  '55000 ehr.order_route_accept_attempts is append-only');
select pg_temp.check('an update of a result report', $s$update lab.order_route_result_reports set numeric_value = 1$s$,
  '55000 lab.order_route_result_reports is append-only');
select pg_temp.check('a delete of a dispensing report', $s$delete from pharmacy.order_route_dispensing_reports$s$,
  '55000 pharmacy.order_route_dispensing_reports is append-only');
select pg_temp.check('an update of an attestation text', $s$update ehr.order_route_attestation_texts set text = text || '.'$s$,
  '55000 ehr.order_route_attestation_texts is append-only');
select pg_temp.check('a delete of a destination setting', $s$delete from identity.order_route_destination_settings$s$,
  '55000 identity.order_route_destination_settings is append-only');
select pg_temp.check('a delete of a route', format($s$delete from ehr.order_routes where id = %L$s$,
  current_setting('hid.test.route_6')), '55000 ORDER_ROUTE_IMMUTABLE');
select pg_temp.check('a state change without its event (P5)', format($s$update ehr.order_routes
  set state = 'withdrawn', ended_at = clock_timestamp(), ended_kind = 'orderer', row_version = row_version + 1
  where id = %L$s$, current_setting('hid.test.route_6')), '55000 ORDER_ROUTE_IMMUTABLE');
-- The guard's own rules, each with the event the change would need (P5), so
-- that only the rule under test can refuse it; the first change is allowed.
create function pg_temp.change_with_event(route uuid, event_type text, state_after text, change text,
  writes_end_after interval default interval '0', access_end_after interval default interval '0')
returns text language plpgsql as $f$
begin
  insert into ehr.order_route_events (route_id, event_version, event_type, side, state_after, writes_end_at_after,
    access_ends_at_after, correlation_id)
  select current_route.id, current_route.row_version + 1, event_type, 'receiving', state_after,
    current_route.writes_end_at + writes_end_after, current_route.access_ends_at + access_end_after, 'p4c-priv-guard'
    from ehr.order_routes current_route where current_route.id = route;
  execute format('update ehr.order_routes set %s, row_version = row_version + 1 where id = %L', change, route);
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
select pg_temp.assert('an allowed change with its event passes the guard',
  pg_temp.change_with_event(current_setting('hid.test.route_6')::uuid, 'accept_locked', 'sent',
    'accept_locked_at = clock_timestamp()') = 'ok');
select pg_temp.assert('a snapshot field changed, with an event',
  pg_temp.change_with_event(current_setting('hid.test.route_6')::uuid, 'accept_locked', 'sent',
    'clinical_information = ''Something else''') = '55000 ORDER_ROUTE_IMMUTABLE');
select pg_temp.assert('the attestation changed, with an event',
  pg_temp.change_with_event(current_setting('hid.test.route_6')::uuid, 'accept_locked', 'sent',
    'attested_by_name = ''Someone Else''') = '55000 ORDER_ROUTE_IMMUTABLE');
select pg_temp.assert('a set-once column changed, with an event',
  pg_temp.change_with_event(current_setting('hid.test.route_6')::uuid, 'accept_locked', 'sent',
    'accept_locked_at = accept_locked_at - interval ''1 hour''') = '55000 ORDER_ROUTE_IMMUTABLE');
select pg_temp.assert('a window lengthened, with an event',
  pg_temp.change_with_event(current_setting('hid.test.route_1')::uuid, 'completed', 'completed',
    'writes_end_at = writes_end_at + interval ''30 days'', access_ends_at = access_ends_at + interval ''30 days''',
    interval '30 days', interval '30 days') = '55000 ORDER_ROUTE_IMMUTABLE');
select pg_temp.assert('a transition outside the state table, with an event',
  pg_temp.change_with_event(current_setting('hid.test.route_3')::uuid, 'accepted', 'accepted',
    'state = ''accepted''') = '55000 ORDER_ROUTE_IMMUTABLE');
select pg_temp.check('a route inserted without its first event', $s$
  insert into ehr.order_routes (id, kind, patient_id, ordering_organization_id, ordering_facility_id,
    source_lab_request_id, source_encounter_id, source_order_version, receiving_organization_id, receiving_facility_id,
    state, sent_by_account_id, sent_by_membership_id, created_at, respond_by, patient_agreement,
    attestation_text_version, attested_by_name, attested_receiving_facility_name, orderer_account_id,
    orderer_membership_id, orderer_name, test_code_system, test_code, test_display, priority, requested_at,
    idempotency_key, request_sha256, correlation_id)
  select gen_random_uuid(), 'lab_request', source_order.patient_id, 'e4c20000-0000-4000-8000-000000000001',
    source_order.facility_id, source_order.id, source_order.encounter_id, source_order.row_version,
    current_setting('hid.test.org_1')::uuid, current_setting('hid.test.facility_1')::uuid, 'sent',
    source_order.created_by, source_order.created_by_membership_id, statement_timestamp(),
    statement_timestamp() + interval '168 hours', 'clinician_attested', 'order-route-lab-attestation-v1', 'Ada Doctor',
    'P4c Sign-up Laboratory Ltd', source_order.created_by, source_order.created_by_membership_id, 'Ada Doctor',
    source_order.test_code_system, source_order.test_code, source_order.test_display, source_order.priority,
    source_order.created_at, 'p4c-priv-owner-route-01', repeat('9', 64), 'p4c-priv-owner'
    from ehr.lab_requests source_order where source_order.id = current_setting('hid.test.lr_7')::uuid;
  set constraints ehr.order_routes_first_event immediate$s$, '55000 ORDER_ROUTE_IMMUTABLE');
set constraints all deferred;

-- 4 (checks).
create temp table suite_routes on commit drop as
  select route.* from ehr.order_routes route where route.correlation_id like 'p4c-suite-%'
    and route.id in (select current_setting('hid.test.route_' || n)::uuid from (values (1), (2), (3), (4), (5), (6), (8)) v(n)
                     union all select current_setting('hid.test.rxroute_1')::uuid);
select pg_temp.assert('the run left every outcome', (select array_agg(route.state || coalesce(':' || route.ended_kind, '')
    order by route.id = current_setting('hid.test.rxroute_1')::uuid, route.created_at, route.id) from suite_routes route)
  = array['completed', 'cancelled:support', 'declined', 'withdrawn:orderer', 'withdrawn:patient', 'sent',
    'completed:wrong_patient', 'completed']);
select pg_temp.assert('each event history replays to its head', not exists (select 1 from suite_routes route
  where (select array_agg(event.event_version order by event.event_version) from ehr.order_route_events event
          where event.route_id = route.id)
        is distinct from (select array_agg(v) from generate_series(1, route.row_version) v)
     or (select row(event.state_after, event.writes_end_at_after, event.access_ends_at_after)
           from ehr.order_route_events event where event.route_id = route.id
          order by event.event_version desc limit 1)
        is distinct from row(route.state, route.writes_end_at, route.access_ends_at)
     or (select event.event_type || ':' || event.state_after from ehr.order_route_events event
          where event.route_id = route.id and event.event_version = 1) <> 'created:sent'));
select pg_temp.assert('P4.1: no row at the receiving facility carries the patient before acceptance',
  not exists (select 1 from audit.events event join ehr.order_routes route on route.id::text = event.resource_id
    where event.facility_id = route.receiving_facility_id and event.patient_id is not null
      and (route.accepted_at is null or event.occurred_at < route.accepted_at)));
select pg_temp.assert('P4.2: no row written for a facility carries an account or membership',
  not exists (select 1 from audit.events event where event.resource_type = 'order-route' and event.actor_type = 'system'
    and (event.actor_account_id is not null or event.actor_membership_id is not null or event.actor_subject is not null))
  and not exists (select 1 from audit.events event, suite_routes route
    where (event.resource_type = 'order-route' or event.action like '%order-route%')
      and exists (select 1 from unnest(array[route.sent_by_account_id, route.sent_by_membership_id,
        route.orderer_account_id, route.orderer_membership_id, route.accepted_by_account_id,
        route.accepted_by_membership_id, route.declined_by_account_id, route.declined_by_membership_id,
        route.ended_by_account_id]) participant
        where participant is not null and event.details::text like '%' || participant::text || '%')));
-- The details carry random uuids (route, result, dispensing, setting and
-- facility ids), whose hex can spell 'ada' or '718-7': they are removed
-- before the scan, so only a real word or value can fail it.
create function pg_temp.without_uuids(details jsonb) returns text language sql immutable as $f$
  select regexp_replace(details::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'gi')
$f$;
select pg_temp.assert('no details carry a name, text, value, licence or identifier', not exists (select 1
  from audit.events event, unnest(array['Ada', 'Patience', 'Okafor', 'Kemi', 'Haemoglobin', '718-7', 'Amoxicillin',
      'amoxicillin', 'whole-blood', 'Fever', 'Take after food', '10.4', '11.2', 'g/dL', 'MDCN', 'MLS/', 'PCN/', 'HID-',
      'P4CPAT', '1990-04-12', 'Sign-up', 'Hospital', 'Laboratory', 'Pharmacy', 'specimen', 'Wrong strength',
      'twin', 'Counter mix-up']) word
  where (event.resource_type = 'order-route' or event.action like '%order-route%')
    and pg_temp.without_uuids(event.details) ilike '%' || word || '%'),
  (select string_agg(distinct event.action || ' ' || event.details::text, '; ') from audit.events event
    where (event.resource_type = 'order-route' or event.action like '%order-route%')
      and pg_temp.without_uuids(event.details) ~* '(ada|patience|haemoglobin|amoxicillin|mdcn|hid-|laboratory|pharmacy)'));
select pg_temp.assert('the scan ignores a uuid that spells ada, and still finds the word',
  pg_temp.without_uuids(jsonb_build_object('routeId', '0c394cf4-fc47-409a-8ada-1eeae9ff79f4')) not ilike '%ada%'
  and pg_temp.without_uuids(jsonb_build_object('routeId', '0c394cf4-fc47-409a-8ada-1eeae9ff79f4', 'name', 'Ada'))
    ilike '%ada%');
select pg_temp.assert('the rows the run wrote', (select array_agg(distinct event.action order by event.action)
    from audit.events event where event.resource_type = 'order-route' or event.action like '%order-route%')
  @> array['admin.order-route-destination.set', 'admin.order-route.close', 'ehr.order-route.accepted', 'ehr.order-route.closed', 'ehr.order-route.declined', 'ehr.order-route.dispensing-returned',
    'ehr.order-route.dispensing-reversed', 'ehr.order-route.received', 'ehr.order-route.result-marked-in-error',
    'ehr.order-route.patient-withdrawn', 'ehr.order-route.result-returned', 'ehr.order-route.withdrawn',
    'ehr.order-route.wrong-patient', 'identity.order-route-destination.set'],
  (select array_agg(distinct event.action order by event.action)::text
    from audit.events event where event.resource_type = 'order-route' or event.action like '%order-route%'));
select pg_temp.assert('the inbox items carry the four metadata keys only', (select bool_and(item.metadata ?& array['routeId',
    'kind', 'orderingFacilityName', 'receivingFacilityName'] and (select count(*) from jsonb_object_keys(item.metadata)) = 4)
  from notification.inbox_items item where item.resource_type = 'order-route')
  and (select count(*) from notification.inbox_items item where item.resource_type = 'order-route') >= 7
  and exists (select 1 from notification.inbox_items item where item.notification_code = 'ORDER_ROUTE_WRONG_PATIENT'));

select pg_temp.report();
rollback;
