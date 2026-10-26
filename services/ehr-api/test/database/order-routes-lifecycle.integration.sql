-- The route lifecycle after the send (0086 section 6, P4c): the mirror of
-- the order, the windows, the orderer's withdrawal, support's close, the
-- release of either side and the same-facility paths. Rollback-only. Every
-- command runs as the service runtime that calls it; owner SQL is marked.
--   1. the mirror (SPEC-FINAL 7.2) row by row: sent -> withdrawn
--      (order_changed, entered_in_error); accepted lab request: an edit while
--      active is an event, B keeps what it accepted; leaving active cancels
--      (writes end now, reads 7 days); entered_in_error ends both now;
--      accepted prescription: any change cancels and the dispensing is
--      refused; completed: events, and entered_in_error ends access now;
--   2. the windows (4.2): a dispensing on day 1 ends access on day 15; a
--      correction on day 14 moves nothing; on day 40 a correction released
--      under the receiving member's own consent is reported with no route
--      access; a release after a cancellation is refused whatever consent;
--   3. C2 by a doctor without any consent grant;
--   4. support's close (C22) of a sent, an accepted and a completed route,
--      and its refusals;
--   5. the release of a receiving laboratory and of an ordering hospital
--      (both self-service), with the counts on the admin.* platform row,
--      access ended on the completed route, rows at each counterpart and the
--      patients' notices;
--   6. the same-facility hand-off and the pharmacist's pull of a routed order
--      refused (23514);
--   8. the wrong-patient ending (0088, item 3) by state: accepted ->
--      cancelled and completed -> access ended, ended_kind wrong_patient,
--      the event on the receiving side with reason wrong_patient, both
--      windows now; refused on a sent route; support's close then finds the
--      route closed and the order change mirror leaves the cancelled one
--      alone; wrong_patient appears on no other state;
--   9. support's find (0089, item 4) for every route of the suite: closable is
--      exactly whether support's Close acts now, access_ends_at the stored
--      column; the lapsed routes of 7 are not closable.
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
-- Owner SQL: a doctor DR (18) at GH without any consent grant.
insert into auth.accounts (id, subject, email, display_name, status)
values ('e4c10000-0000-4000-8000-000000000018', 'synthetic:p4c:dr', 'dr@p4c-staff.invalid', 'Ruth Second Doctor',
  'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
values ('e4c12000-0000-4000-8000-000000000018', 'e4c10000-0000-4000-8000-000000000018', 'Ruth Second Doctor',
  'dr@p4c-staff.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
values ('e4c13000-0000-4000-8000-000000000018', 'e4c12000-0000-4000-8000-000000000018',
  'e4c10000-0000-4000-8000-000000000018', 'e4c20000-0000-4000-8000-000000000001',
  'e4c21000-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('e4c11000-0000-4000-8000-000000000018', 'e4c10000-0000-4000-8000-000000000018', 'doctor', 'facility',
  'e4c13000-0000-4000-8000-000000000018', 'e4c21000-0000-4000-8000-000000000001', 'P4c suite doctor without consent');

-- Accepting, as the receiving runtimes do: L1's or PH1's administrator, or
-- L9's (n = 9). Answers the work item.
create function pg_temp.accept_lab(route uuid, n integer, health_id text default 'HID-P4CPATP')
returns uuid language plpgsql as $f$
declare accepted record;
begin
  perform pg_temp.as_signup_admin(n);
  select * into accepted from lab.accept_order_route(route, 1, 'health_id', health_id,
    'p4c-life-accept-' || substr(md5(route::text), 1, 12), repeat('a', 64));
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
    'Patient collected the prescription', 'p4c-life-accept-' || substr(md5(route::text), 1, 12), repeat('a', 64));
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
create function pg_temp.last_event(route uuid) returns text language sql stable as $f$
  select event.event_type from ehr.order_route_events event where event.route_id = route
   order by event.event_version desc limit 1
$f$;
create function pg_temp.edit_lab(order_id uuid, change text, reason text)
returns void language plpgsql as $f$
begin
  perform pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
  perform set_config('app.change_reason', reason, true);
  if change = 'priority' then
    update ehr.lab_requests set priority = 'stat' where id = order_id;
  elsif change = 'clinical' then
    update ehr.lab_requests set clinical_information = 'Now also breathless' where id = order_id;
  else
    update ehr.lab_requests set status = change where id = order_id;
  end if;
end
$f$;
create function pg_temp.edit_rx(order_id uuid, change text, reason text)
returns void language plpgsql as $f$
begin
  perform pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
  perform set_config('app.change_reason', reason, true);
  if change = 'frequency' then
    update ehr.prescriptions set frequency = 'Every 12 hours' where id = order_id;
  else
    update ehr.prescriptions set status = change where id = order_id;
  end if;
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

-- Orders of DA for P, and their routes.
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_' || n, pg_temp.lab_request(1, 'active')::text, true)
  from (select n from generate_series(1, 16) n where n not in (14, 15)) v;
select set_config('hid.test.rx_' || n, pg_temp.prescription(1, 'active')::text, true) from generate_series(1, 6) n;
select set_config('hid.test.lroute_' || n, pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_' || n)::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-life-send-lab-' || lpad(n::text, 4, '0'))::text, true)
  from (select n from generate_series(1, 16) n where n not in (14, 15)) v;
select set_config('hid.test.rroute_' || n, pg_temp.send(11, 'prescription', current_setting('hid.test.rx_' || n)::uuid,
  current_setting('hid.test.facility_2')::uuid, 'p4c-life-send-rx-' || lpad(n::text, 4, '0'))::text, true)
  from generate_series(1, 6) n;
reset role;
-- L1 accepts lab routes 2-9 and 12-13; PH1 accepts prescription routes 2-5.
set local role hid_lab_api_runtime;
select set_config('hid.test.litem_' || n, pg_temp.accept_lab(current_setting('hid.test.lroute_' || n)::uuid, 1)::text,
  true) from (values (2), (3), (4), (5), (6), (7), (8), (9), (12), (13)) v(n);
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('hid.test.ritem_' || n, pg_temp.accept_rx(current_setting('hid.test.rroute_' || n)::uuid)::text, true)
  from generate_series(2, 5) n;
reset role;
-- Results: lab routes 5, 6, 8 and 13 complete (L1's administrator releases);
-- routes 7 and 8 first age by a day (owner SQL).
select pg_temp.age_route(current_setting('hid.test.lroute_' || n)::uuid, interval '1 day', interval '0') from (values (7), (8)) v(n);
select set_config('hid.test.result_' || n, pg_temp.lab_chain(current_setting('hid.test.litem_' || n)::uuid, 'life' || n,
  10.0 + n)::text, true) from (values (5), (6), (7), (8), (9), (13)) v(n);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.release(current_setting('hid.test.result_' || n)::uuid, 1,
  current_setting('hid.test.life' || n || '_verification_1')::uuid, 'p4c-life-release-' || n || '-01')
  from (values (5), (6), (7), (8), (13)) v(n);
reset role;
-- Prescription route 4 completes (PB2 dispenses).
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select set_config('hid.test.dispensing_4', pg_temp.dispense(current_setting('hid.test.ritem_4')::uuid,
  'p4c-life-dispense-04')::text, true);
reset role;

-- 1. The mirror.
select pg_temp.assert('the fixture: states before the changes',
  (select array_agg(route.state order by n) from (values (1), (2), (3), (4), (5), (6)) v(n)
     join ehr.order_routes route on route.id = current_setting('hid.test.lroute_' || n)::uuid)
  = array['sent', 'accepted', 'accepted', 'accepted', 'completed', 'completed']);
set local role hid_ehr_api_runtime;
select pg_temp.edit_lab(current_setting('hid.test.lr_1')::uuid, 'priority', 'Priority raised after review');
select pg_temp.edit_rx(current_setting('hid.test.rx_1')::uuid, 'frequency', 'Dose interval changed');
select pg_temp.edit_lab(current_setting('hid.test.lr_2')::uuid, 'clinical', 'More history from the patient');
select pg_temp.edit_lab(current_setting('hid.test.lr_3')::uuid, 'on_hold', 'Held until the scan is back');
select pg_temp.edit_lab(current_setting('hid.test.lr_4')::uuid, 'entered_in_error', 'Ordered for the wrong patient');
select pg_temp.edit_rx(current_setting('hid.test.rx_2')::uuid, 'frequency', 'Dose interval changed');
select pg_temp.edit_rx(current_setting('hid.test.rx_3')::uuid, 'entered_in_error', 'Prescribed for the wrong patient');
select pg_temp.edit_lab(current_setting('hid.test.lr_5')::uuid, 'clinical', 'More history from the patient');
select pg_temp.edit_lab(current_setting('hid.test.lr_6')::uuid, 'entered_in_error', 'Ordered for the wrong patient');
select pg_temp.edit_rx(current_setting('hid.test.rx_4')::uuid, 'frequency', 'Dose interval changed');
reset role;
do $$
declare
  r ehr.order_routes%rowtype;
begin
  r := pg_temp.route(current_setting('hid.test.lroute_1')::uuid);
  perform pg_temp.assert('sent lab request, any change: withdrawn (order_changed)', r.state = 'withdrawn'
    and r.ended_kind = 'order_changed' and pg_temp.last_event(r.id) = 'withdrawn');
  r := pg_temp.route(current_setting('hid.test.rroute_1')::uuid);
  perform pg_temp.assert('sent prescription, any change: withdrawn (order_changed)', r.state = 'withdrawn'
    and r.ended_kind = 'order_changed');
  r := pg_temp.route(current_setting('hid.test.lroute_2')::uuid);
  perform pg_temp.assert('accepted lab request edited while active: an event, B keeps what it accepted',
    r.state = 'accepted' and r.ended_at is null and r.clinical_information = 'Fever for three days'
    and r.writes_end_at = r.accepted_at + interval '30 days'
    and pg_temp.last_event(r.id) = 'order_changed_after_acceptance'
    and (select item.clinical_indication from lab.work_items item where item.order_route_id = r.id)
      = 'Fever for three days', row_to_json(r)::text);
  r := pg_temp.route(current_setting('hid.test.lroute_3')::uuid);
  perform pg_temp.assert('accepted lab request leaves active: cancelled, writes end now, reads 7 days',
    r.state = 'cancelled' and r.ended_kind = 'order_changed' and r.writes_end_at = r.ended_at
    and r.access_ends_at = r.ended_at + interval '7 days' and pg_temp.last_event(r.id) = 'cancelled',
    row_to_json(r)::text);
  r := pg_temp.route(current_setting('hid.test.lroute_4')::uuid);
  perform pg_temp.assert('accepted lab request entered in error: cancelled, both end now', r.state = 'cancelled'
    and r.ended_kind = 'entered_in_error' and r.writes_end_at = r.ended_at and r.access_ends_at = r.ended_at);
  r := pg_temp.route(current_setting('hid.test.rroute_2')::uuid);
  perform pg_temp.assert('accepted prescription, any change: cancelled (order_changed)', r.state = 'cancelled'
    and r.ended_kind = 'order_changed' and r.access_ends_at = r.ended_at + interval '7 days');
  r := pg_temp.route(current_setting('hid.test.rroute_3')::uuid);
  perform pg_temp.assert('accepted prescription entered in error: cancelled, both end now', r.state = 'cancelled'
    and r.ended_kind = 'entered_in_error' and r.access_ends_at = r.ended_at);
  r := pg_temp.route(current_setting('hid.test.lroute_5')::uuid);
  perform pg_temp.assert('completed lab request edited: an event, windows kept', r.state = 'completed'
    and r.ended_at is null and r.access_ends_at = least(r.completed_at + interval '14 days', r.accepted_at + interval '45 days')
    and pg_temp.last_event(r.id) = 'order_changed_after_completion');
  r := pg_temp.route(current_setting('hid.test.lroute_6')::uuid);
  perform pg_temp.assert('completed lab request entered in error: access ends now', r.state = 'completed'
    and r.ended_kind = 'entered_in_error' and r.access_ends_at = r.ended_at and r.writes_end_at = r.ended_at
    and pg_temp.last_event(r.id) = 'access_ended');
  r := pg_temp.route(current_setting('hid.test.rroute_4')::uuid);
  perform pg_temp.assert('completed prescription edited: an event', r.state = 'completed' and r.ended_at is null
    and pg_temp.last_event(r.id) = 'order_changed_after_completion');
  perform pg_temp.assert('B told of each change after acceptance, with the patient',
    (select array_agg(event.action || ':' || (event.patient_id is not null) order by event.action, event.resource_id)
       from audit.events event
      where event.resource_id in (current_setting('hid.test.lroute_2'), current_setting('hid.test.lroute_3'),
              current_setting('hid.test.lroute_4'), current_setting('hid.test.rroute_2'))
        and event.facility_id in (current_setting('hid.test.facility_1')::uuid, current_setting('hid.test.facility_2')::uuid)
        and event.action in ('ehr.order-route.cancelled', 'ehr.order-route.order-changed'))
    = array['ehr.order-route.cancelled:true', 'ehr.order-route.cancelled:true', 'ehr.order-route.cancelled:true',
            'ehr.order-route.order-changed:true']);
  perform pg_temp.assert('the patient told of the withdrawals and cancellations',
    (select array_agg(item.notification_code order by item.notification_code) from notification.inbox_items item
      where item.resource_id in (current_setting('hid.test.lroute_1')::uuid, current_setting('hid.test.rroute_1')::uuid,
              current_setting('hid.test.lroute_3')::uuid, current_setting('hid.test.lroute_4')::uuid,
              current_setting('hid.test.rroute_2')::uuid, current_setting('hid.test.rroute_3')::uuid)
        and item.notification_code not in ('ORDER_ROUTE_SENT', 'ORDER_ROUTE_ACCEPTED'))
    = array['ORDER_ROUTE_CANCELLED', 'ORDER_ROUTE_CANCELLED', 'ORDER_ROUTE_CANCELLED', 'ORDER_ROUTE_CANCELLED',
            'ORDER_ROUTE_WITHDRAWN', 'ORDER_ROUTE_WITHDRAWN']);
end $$;
-- The dispensing after the prescription changed is refused.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.check('a dispensing after the prescription changed', format($s$select pg_temp.dispense(%L,
  'p4c-life-dispense-02')$s$, current_setting('hid.test.ritem_2')), '23514 ORDER_ROUTE_CLOSED');
reset role;

-- 2. The windows. Prescription route 5 ages a day, then is dispensed.
select pg_temp.age_route(current_setting('hid.test.rroute_5')::uuid, interval '1 day', interval '0');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.dispense(current_setting('hid.test.ritem_5')::uuid, 'p4c-life-dispense-05');
reset role;
select pg_temp.assert('a dispensing on day 1 ends access on day 15', (select route.state = 'completed'
    and route.access_ends_at = route.completed_at + interval '14 days'
    and route.access_ends_at - route.accepted_at between interval '15 days' and interval '15 days 1 minute'
  from ehr.order_routes route where route.id = current_setting('hid.test.rroute_5')::uuid));
-- Lab route 7 (result on day 1) ages to day 14; a correction then moves nothing.
select pg_temp.age_route(current_setting('hid.test.lroute_7')::uuid, interval '13 days', interval '13 days');
select set_config('hid.test.window_7', (pg_temp.route(current_setting('hid.test.lroute_7')::uuid)).access_ends_at::text,
  true);
select set_config('hid.test.life7_verification_2', pg_temp.lab_correction(current_setting('hid.test.result_7')::uuid,
  'life7', 17.5, current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('day 14: route access still reads and writes until the window''s end', (select
    ehr.order_route_allows(route.id, route.receiving_facility_id, 'write_records')
    and ehr.order_route_allows(route.id, route.receiving_facility_id, 'read_records')
  from ehr.order_routes route where route.id = current_setting('hid.test.lroute_7')::uuid));
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a correction on day 14 under route access', format($s$select pg_temp.release(%L, 2, %L,
  'p4c-life-release-7-02')$s$, current_setting('hid.test.result_7'), current_setting('hid.test.life7_verification_2')), 'ok');
reset role;
select pg_temp.assert('the correction on day 14 moves nothing', (select route.access_ends_at::text = current_setting('hid.test.window_7')
    and route.writes_end_at = route.access_ends_at and route.access_ends_at - route.accepted_at
      between interval '15 days' and interval '15 days 1 minute'
    and (select count(*) from lab.order_route_result_reports report where report.route_id = route.id) = 2
  from ehr.order_routes route where route.id = current_setting('hid.test.lroute_7')::uuid));
-- Lab route 8 (result on day 1) ages to day 40; LB2 gets P's consent at L1
-- (owner SQL) and releases a correction under it. (Other routes of P are live
-- at L1, so the per-patient chain-table branch, H6, stays true: the residual
-- of SPEC-FINAL 4.3; the route itself, H7, allows nothing.)
select pg_temp.age_route(current_setting('hid.test.lroute_8')::uuid, interval '39 days', interval '39 days');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
values (gen_random_uuid(), 'e4c30000-0000-4000-8000-000000000001', 'e4c12000-0000-4000-8000-000000000031',
  'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', current_setting('hid.test.facility_1')::uuid,
  'write_records', 'active', 'P4c suite consent at the laboratory', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '30 days', false, 'direct-care');
select set_config('hid.test.life8_verification_2', pg_temp.lab_correction(current_setting('hid.test.result_8')::uuid,
  'life8', 18.5, current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a correction on day 40 under consent', format($s$select pg_temp.release(%L, 2, %L,
  'p4c-life-release-8-02')$s$, current_setting('hid.test.result_8'), current_setting('hid.test.life8_verification_2')), 'ok');
reset role;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('day 40: the report is filed, no route access', (select
    (select count(*) from lab.order_route_result_reports report where report.route_id = route.id) = 2
    and route.access_ends_at < clock_timestamp() - interval '24 days'
    and not ehr.order_route_allows(route.id, route.receiving_facility_id, 'read_records')
    and not ehr.order_route_allows(route.id, route.receiving_facility_id, 'write_records')
    and lab.context_allows(route.patient_id, route.receiving_facility_id, 'read_records')
  from ehr.order_routes route where route.id = current_setting('hid.test.lroute_8')::uuid));
-- Lab route 9: accepted, its result verified, then the order cancelled; LB2's
-- release under consent is refused.
set local role hid_ehr_api_runtime;
select pg_temp.edit_lab(current_setting('hid.test.lr_9')::uuid, 'cancelled', 'No longer needed');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a release after the cancellation, under consent', format($s$select pg_temp.release(%L, 1, %L,
  'p4c-life-release-9-01')$s$, current_setting('hid.test.result_9'), current_setting('hid.test.life9_verification_1')),
  '23514 ORDER_ROUTE_CLOSED');
reset role;
select pg_temp.assert('nothing came back on the cancelled route', not exists (select 1 from lab.order_route_result_reports
  report where report.route_id = current_setting('hid.test.lroute_9')::uuid));

-- 3. C2 by DR, who holds no consent grant for P.
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(18, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.assert('DR has no consent', not ehr.context_allows('e4c30000-0000-4000-8000-000000000001',
  'e4c21000-0000-4000-8000-000000000001', 'read_records'));
select pg_temp.assert('C2 without consent, answering the route''s patient',
  (select withdrawn.state = 'withdrawn' and withdrawn.row_version = 2
      and withdrawn.patient_id = 'e4c30000-0000-4000-8000-000000000001'
  from ehr.withdraw_order_route(current_setting('hid.test.lroute_10')::uuid, 'lab_request',
    current_setting('hid.test.lr_10')::uuid, 1, 'sent_in_error') withdrawn));
reset role;
select pg_temp.assert('withdrawn by the orderer, B told without the patient, the patient told',
  (select route.ended_kind = 'orderer' and route.ended_by_account_id = 'e4c10000-0000-4000-8000-000000000018'
     from ehr.order_routes route where route.id = current_setting('hid.test.lroute_10')::uuid)
  and exists (select 1 from audit.events event where event.action = 'ehr.order-route.withdrawn'
    and event.resource_id = current_setting('hid.test.lroute_10') and event.patient_id is null
    and event.facility_id = current_setting('hid.test.facility_1')::uuid)
  and exists (select 1 from notification.inbox_items item where item.resource_id = current_setting('hid.test.lroute_10')::uuid
    and item.notification_code = 'ORDER_ROUTE_WITHDRAWN'));

-- 4. Support's close: lab routes 11 (sent), 12 (accepted), 13 (completed).
select set_config('hid.test.version_' || n, (pg_temp.route(current_setting('hid.test.lroute_' || n)::uuid)).row_version::text,
  true) from generate_series(11, 13) n;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(2);
select pg_temp.check('C22 by support without platform.facility.manage', format($s$select * from
  identity.admin_close_order_route(%L, 1, 'The patient asked support to stop it')$s$,
  current_setting('hid.test.lroute_11')), '42501 ADMIN_PERMISSION_DENIED');
select pg_temp.as_platform(3);
select pg_temp.check('C22 with a short reason', format($s$select * from identity.admin_close_order_route(%L, 1, 'short')$s$,
  current_setting('hid.test.lroute_11')), '22023 ORDER_ROUTE_CLOSE_INVALID');
select pg_temp.check('C22 with a stale version', format($s$select * from identity.admin_close_order_route(%L, 7,
  'The patient asked support to stop it')$s$, current_setting('hid.test.lroute_11')), '40001 Order route version conflict');
select pg_temp.check('C22 of an unknown route', $s$select * from identity.admin_close_order_route(gen_random_uuid(), 1,
  'The patient asked support to stop it')$s$, 'P0002 ORDER_ROUTE_NOT_FOUND');
select pg_temp.assert('C22 closes a sent, an accepted and a completed route',
  (select array_agg(closed.state order by v.n) from (values (11), (12), (13)) v(n)
     cross join lateral identity.admin_close_order_route(current_setting('hid.test.lroute_' || v.n)::uuid,
       current_setting('hid.test.version_' || v.n)::bigint, 'The patient asked support to stop it') closed)
  = array['withdrawn', 'cancelled', 'completed']);
select pg_temp.check('C22 of a closed route', format($s$select * from identity.admin_close_order_route(%L, 2,
  'The patient asked support to stop it')$s$, current_setting('hid.test.lroute_11')), '23505 ORDER_ROUTE_ALREADY_CLOSED');
reset role;
do $$
declare
  r ehr.order_routes%rowtype;
begin
  r := pg_temp.route(current_setting('hid.test.lroute_11')::uuid);
  perform pg_temp.assert('support withdrew the sent route', r.state = 'withdrawn' and r.ended_kind = 'support');
  r := pg_temp.route(current_setting('hid.test.lroute_12')::uuid);
  perform pg_temp.assert('support cancelled the accepted route, access ends now', r.state = 'cancelled'
    and r.ended_kind = 'support' and r.access_ends_at = r.ended_at and r.writes_end_at = r.ended_at);
  r := pg_temp.route(current_setting('hid.test.lroute_13')::uuid);
  perform pg_temp.assert('support ended the completed route''s access', r.state = 'completed'
    and r.ended_kind = 'support' and r.access_ends_at = r.ended_at);
  perform pg_temp.assert('support''s platform rows, one per close',
    (select count(*) from audit.events event where event.action = 'admin.order-route.close' and event.actor_type = 'platform'
      and event.facility_id is null and event.patient_id is null
      and event.resource_id in (current_setting('hid.test.lroute_11'), current_setting('hid.test.lroute_12'),
            current_setting('hid.test.lroute_13'))) = 3);
  perform pg_temp.assert('both facilities told of each close',
    (select count(*) from audit.events event where event.action in ('ehr.order-route.closed', 'ehr.order-route.withdrawn')
      and event.actor_type = 'system'
      and event.resource_id in (current_setting('hid.test.lroute_11'), current_setting('hid.test.lroute_12'),
            current_setting('hid.test.lroute_13'))) = 6
    and not exists (select 1 from audit.events event where event.resource_id = current_setting('hid.test.lroute_11')
      and event.facility_id = current_setting('hid.test.facility_1')::uuid and event.patient_id is not null));
  perform pg_temp.assert('the patient told of each close', (select count(*) from notification.inbox_items item
    where item.notification_code = 'ORDER_ROUTE_CANCELLED'
      and item.resource_id in (current_setting('hid.test.lroute_11')::uuid, current_setting('hid.test.lroute_12')::uuid,
            current_setting('hid.test.lroute_13')::uuid)) = 3);
end $$;

-- 5. Releases. Sign-ups: 8 hospital H8 (reviewed, doctor), 9 laboratory L9
-- (reviewed, lab).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'p4c-life-signup', true),
  set_config('app.purpose_of_use', '', true), set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select pg_temp.p4c_sign_up(8, 'ehr', 'hospital', 'RC9945008', 'Tobi Hospital Admin', 'tobi@p4c-hospital.invalid',
  'P4c Sign-up Hospital Ltd');
select pg_temp.p4c_sign_up(9, 'laboratory', 'laboratory', 'RC9945009', 'Uche Lab Admin', 'uche@p4c-lab-nine.invalid',
  'P4c Ninth Laboratory Ltd');
select pg_temp.as_platform(1);
select identity.admin_review_self_service_facility(current_setting('hid.test.app_' || n)::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('unreviewed') application
    where application.application_id = current_setting('hid.test.app_' || n)::uuid),
  'Support reviewed this facility for the suite', role, 'cac_registered_contact', body, number)
  from (values (8, 'doctor', 'MDCN', 'MDCN/80008'), (9, 'lab', 'MLSCN', 'MLS/10009')) r(n, role, body, number);
reset role;
select set_config('hid.test.membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.account_' || n)::uuid), true),
  set_config('hid.test.subject_' || n,
  (select account.subject from auth.accounts account where account.id = current_setting('hid.test.account_' || n)::uuid),
  true)
  from generate_series(8, 9) n;
-- Owner SQL: P's consent for H8's doctor.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), 'e4c30000-0000-4000-8000-000000000001', staff.id, staff.account_id,
  current_setting('hid.test.membership_8')::uuid, current_setting('hid.test.facility_8')::uuid, 'write_records',
  'active', 'P4c suite consent at the hospital', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days',
  false, 'direct-care'
  from identity.staff staff where staff.account_id = current_setting('hid.test.account_8')::uuid;
-- GH sends P's orders 14 and 15 and Q's order to L9; L9 accepts 15 and Q's,
-- and releases Q's result.
set local role hid_ehr_api_runtime;
select set_config('hid.test.lq', pg_temp.lab_request(2, 'active')::text, true);
select set_config('hid.test.lr_' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(14, 15) n;
select set_config('hid.test.l9route_' || n, pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_' || n)::uuid,
  current_setting('hid.test.facility_9')::uuid, 'p4c-life-send-l9-' || n || '-00')::text, true) from (values (14), (15)) v(n);
select set_config('hid.test.l9route_q', pg_temp.send(11, 'lab_request', current_setting('hid.test.lq')::uuid,
  current_setting('hid.test.facility_9')::uuid, 'p4c-life-send-l9-q-00')::text, true);
-- H8's doctor writes an encounter and two lab requests for P and sends them to L1.
select pg_temp.as_signup_admin(8);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e4c50000-0000-4000-8000-000000000008', 'e4c30000-0000-4000-8000-000000000001',
  current_setting('hid.test.facility_8')::uuid, current_setting('hid.test.account_8')::uuid,
  current_setting('hid.test.membership_8')::uuid, 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
select ('e4c60000-0000-4000-8000-00000000008' || n)::uuid, 'e4c50000-0000-4000-8000-000000000008',
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_8')::uuid,
  current_setting('hid.test.account_8')::uuid, current_setting('hid.test.membership_8')::uuid, 'http://loinc.org',
  '718-7', 'Haemoglobin', 'routine', 'active', 'whole-blood', 'Tired for a month'
  from generate_series(1, 2) n;
select set_config('hid.test.h8route_' || n, (select sent.route_id::text from ehr.send_order_route(gen_random_uuid(),
  'lab_request', 'e4c30000-0000-4000-8000-000000000001', ('e4c60000-0000-4000-8000-00000000008' || n)::uuid,
  'e4c50000-0000-4000-8000-000000000008', 1, current_setting('hid.test.facility_1')::uuid,
  'order-route-lab-attestation-v1', 'p4c-life-send-h8-' || n || '-00', repeat('8', 64)) sent), true)
  from generate_series(1, 2) n;
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.l9item_15', pg_temp.accept_lab(current_setting('hid.test.l9route_15')::uuid, 9)::text, true);
select set_config('hid.test.l9item_q', pg_temp.accept_lab(current_setting('hid.test.l9route_q')::uuid, 9,
  'HID-P4CPATQ')::text, true);
select set_config('hid.test.h8item_2', pg_temp.accept_lab(current_setting('hid.test.h8route_2')::uuid, 1)::text, true);
reset role;
select set_config('hid.test.result_q', pg_temp.lab_chain(current_setting('hid.test.l9item_q')::uuid, 'lifeq', 9.9)::text,
  true);
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(9);
select pg_temp.release(current_setting('hid.test.result_q')::uuid, 1, current_setting('hid.test.lifeq_verification_1')::uuid,
  'p4c-life-release-q-01');
reset role;
select pg_temp.assert('the release fixture', (select array_agg(route.state order by route.created_at, route.id)
    from ehr.order_routes route where route.receiving_facility_id = current_setting('hid.test.facility_9')::uuid)
  = array['sent', 'accepted', 'completed']
  and (select array_agg(route.state order by route.created_at, route.id)
    from ehr.order_routes route where route.ordering_facility_id = current_setting('hid.test.facility_8')::uuid)
  = array['sent', 'accepted']
  and (select route.orderer_licence_number from ehr.order_routes route
        where route.id = current_setting('hid.test.h8route_1')::uuid) = 'MDCN/80008');
-- Support suspends L9 and H8, disables both administrators, and releases them.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select identity.admin_transition_facility(current_setting('hid.test.facility_' || n)::uuid,
  (select facility.row_version from identity.facilities facility where facility.id = current_setting('hid.test.facility_' || n)::uuid),
  'suspended', 'Suspended for the P4c suite', 'p4c-life-suspend-' || n || '-000000', repeat('c', 64))
  from generate_series(8, 9) n;
select auth.admin_transition_account(current_setting('hid.test.account_' || n)::uuid,
  (select account.row_version from auth.accounts account where account.id = current_setting('hid.test.account_' || n)::uuid),
  'disabled', 'Disabled for the P4c release', 'p4c-life-disable-' || n || '-000000', repeat('d', 64))
  from generate_series(8, 9) n;
select identity.admin_release_self_service_facility(current_setting('hid.test.app_' || n)::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('all') application
    where application.application_id = current_setting('hid.test.app_' || n)::uuid),
  'Released for the P4c suite', false)
  from generate_series(8, 9) n;
reset role;
do $$
declare
  r ehr.order_routes%rowtype;
begin
  perform pg_temp.assert('the receiving release closed every live route to L9',
    (select array_agg(route.state || ':' || route.ended_kind || ':' || (route.access_ends_at is null
        or route.access_ends_at = route.ended_at) order by route.created_at, route.id)
       from ehr.order_routes route where route.receiving_facility_id = current_setting('hid.test.facility_9')::uuid)
    = array['withdrawn:receiving_released:true', 'cancelled:receiving_released:true', 'completed:receiving_released:true']);
  r := pg_temp.route(current_setting('hid.test.l9route_q')::uuid);
  perform pg_temp.assert('access ended on the completed route', r.ended_at is not null and r.access_ends_at = r.ended_at
    and pg_temp.last_event(r.id) = 'access_ended');
  perform pg_temp.assert('the ordering release closed every live route from H8',
    (select array_agg(route.state || ':' || route.ended_kind order by route.created_at, route.id)
       from ehr.order_routes route where route.ordering_facility_id = current_setting('hid.test.facility_8')::uuid)
    = array['withdrawn:ordering_released', 'cancelled:ordering_released']);
  perform pg_temp.assert('the platform rows carry the counts', (select array_agg(event.details order by event.resource_id)
      from audit.events event where event.action = 'admin.self-service-facility.release-order-routes'
        and event.actor_type = 'platform' and event.patient_id is null and event.facility_id is null)
    = (select array_agg(details order by application_id) from (values
        (current_setting('hid.test.app_8'), jsonb_build_object('applicationId', current_setting('hid.test.app_8')::uuid,
          'withdrawn', 1, 'cancelled', 1, 'accessEnded', 0, 'acceptedLifetime', 0, 'patientsLifetime', 0)),
        (current_setting('hid.test.app_9'), jsonb_build_object('applicationId', current_setting('hid.test.app_9')::uuid,
          'withdrawn', 1, 'cancelled', 1, 'accessEnded', 1, 'acceptedLifetime', 2, 'patientsLifetime', 2)))
        v(application_id, details)));
  perform pg_temp.assert('GH told of each route to L9, with the patient',
    (select count(*) from audit.events event where event.action = 'ehr.order-route.closed' and event.actor_type = 'system'
      and event.facility_id = 'e4c21000-0000-4000-8000-000000000001' and event.patient_id is not null
      and event.details ->> 'closedBy' = 'receiving_released'
      and event.resource_id in (current_setting('hid.test.l9route_14'), current_setting('hid.test.l9route_15'),
            current_setting('hid.test.l9route_q'))) = 3);
  perform pg_temp.assert('L1 told of each route from H8: the sent one without the patient',
    (select array_agg(event.action || ':' || (event.patient_id is not null) order by event.resource_id)
       from audit.events event where event.actor_type = 'system'
        and event.facility_id = current_setting('hid.test.facility_1')::uuid
        and event.details ->> 'closedBy' = 'ordering_released')
    = (select array_agg(pair order by route_id) from (values
        (current_setting('hid.test.h8route_1'), 'ehr.order-route.withdrawn:false'),
        (current_setting('hid.test.h8route_2'), 'ehr.order-route.closed:true')) v(route_id, pair)));
  perform pg_temp.assert('every affected patient told, both directions', (select count(*) from notification.inbox_items item
    where item.notification_code = 'ORDER_ROUTE_CANCELLED'
      and item.resource_id in (current_setting('hid.test.l9route_14')::uuid, current_setting('hid.test.l9route_15')::uuid,
            current_setting('hid.test.l9route_q')::uuid, current_setting('hid.test.h8route_1')::uuid,
            current_setting('hid.test.h8route_2')::uuid)) = 5
    and exists (select 1 from notification.inbox_items item where item.notification_code = 'ORDER_ROUTE_CANCELLED'
      and item.resource_id = current_setting('hid.test.l9route_q')::uuid
      and item.patient_id = 'e4c30000-0000-4000-8000-000000000002'));
end $$;

-- 6. The same-facility paths while routed: lab route 16 and prescription
-- route 6 are sent. LA tries GH's own Lab work, PA pulls the prescription
-- (each service reads the order from the EHR; here a copy).
create temp table lab_order_copy as
  select * from ehr.lab_requests source_order where source_order.id = current_setting('hid.test.lr_16')::uuid;
create temp table rx_order_copy as
  select * from ehr.prescriptions source_order where source_order.id = current_setting('hid.test.rx_6')::uuid;
grant select on lab_order_copy to hid_lab_api_runtime;
grant select on rx_order_copy to hid_pharmacy_api_runtime;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(14, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('the same-facility hand-off while routed', $s$insert into lab.work_items (id, patient_id, facility_id,
  ordering_facility_id, source_ehr_order_id, source_ehr_order_version, source_encounter_id, priority, test_code_system,
  test_code, test_name, clinical_indication, requested_by, requested_at, accepted_by, accepted_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
select gen_random_uuid(), source_order.patient_id, source_order.facility_id, source_order.facility_id,
  source_order.id, source_order.row_version, source_order.encounter_id, source_order.priority,
  source_order.test_code_system, source_order.test_code, source_order.test_display, source_order.clinical_information,
  source_order.created_by, source_order.created_at, 'e4c10000-0000-4000-8000-000000000014',
  'e4c13000-0000-4000-8000-000000000014', 'p4c-life-same-facility-lab', repeat('4', 64), 'p4c-life-same-facility'
  from lab_order_copy source_order$s$, '23514 LAB_REQUEST_ROUTED');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(15, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('the pharmacist''s pull while routed', $s$insert into pharmacy.work_items (id, patient_id, facility_id,
  ordering_facility_id, source_ehr_prescription_id, source_ehr_prescription_version, source_encounter_id, source_status,
  medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
  instructions, starts_on, ends_on, prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id,
  acceptance_reason, idempotency_key, request_sha256, correlation_id)
select gen_random_uuid(), source_order.patient_id, source_order.facility_id, source_order.facility_id, source_order.id,
  source_order.row_version, source_order.encounter_id, source_order.status, source_order.medication_code_system,
  source_order.medication_code, source_order.medication_display, source_order.dose_quantity, source_order.dose_unit,
  source_order.route_code, source_order.frequency, source_order.instructions, source_order.starts_on,
  source_order.ends_on, source_order.created_by, source_order.created_at, 'e4c10000-0000-4000-8000-000000000015',
  'e4c13000-0000-4000-8000-000000000015', 'Pulled at the hospital pharmacy', 'p4c-life-same-facility-rx',
  repeat('5', 64), 'p4c-life-same-facility'
  from rx_order_copy source_order$s$, '23514 PRESCRIPTION_ROUTED');
reset role;

-- 7. Lapsed windows. Lab route 17 is sent and ages past respond_by: neither
-- the orderer's withdrawal nor B's decline may relabel it. Lab route 18 and
-- prescription route 7 are accepted and age past their work window with
-- nothing returned: they read expired everywhere, support's close finds them
-- closed, and a dispensing on route 7 is refused by the database itself.
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(17, 18) n;
select set_config('hid.test.rx_7', pg_temp.prescription(1, 'active')::text, true);
select set_config('hid.test.lroute_' || n, pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_' || n)::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-life-send-lab-' || lpad(n::text, 4, '0'))::text, true)
  from generate_series(17, 18) n;
select set_config('hid.test.rroute_7', pg_temp.send(11, 'prescription', current_setting('hid.test.rx_7')::uuid,
  current_setting('hid.test.facility_2')::uuid, 'p4c-life-send-rx-0007')::text, true);
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.litem_18', pg_temp.accept_lab(current_setting('hid.test.lroute_18')::uuid, 1)::text, true);
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('hid.test.ritem_7', pg_temp.accept_rx(current_setting('hid.test.rroute_7')::uuid)::text, true);
reset role;
select pg_temp.age_route(current_setting('hid.test.lroute_17')::uuid, interval '8 days', interval '0');
select pg_temp.age_route(route.id, interval '31 days', interval '31 days')
  from ehr.order_routes route where route.id in (current_setting('hid.test.lroute_18')::uuid,
    current_setting('hid.test.rroute_7')::uuid);
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.check('the orderer''s withdrawal past respond_by', format($s$select * from ehr.withdraw_order_route(%L,
  'lab_request', %L, 1, 'sent_in_error')$s$, current_setting('hid.test.lroute_17'), current_setting('hid.test.lr_17')),
  'P0001 ORDER_ROUTE_NOT_PENDING');
select pg_temp.assert('C3 reads the lapsed routes as expired', (select array_agg(listed.summary ->> 'effectiveState'
      order by listed.route_id)
    from (select * from ehr.list_order_routes_for_order('lab_request', 'e4c30000-0000-4000-8000-000000000001',
            current_setting('hid.test.lr_17')::uuid)
          union all
          select * from ehr.list_order_routes_for_order('lab_request', 'e4c30000-0000-4000-8000-000000000001',
            current_setting('hid.test.lr_18')::uuid)
          union all
          select * from ehr.list_order_routes_for_order('prescription', 'e4c30000-0000-4000-8000-000000000001',
            current_setting('hid.test.rx_7')::uuid)) listed)
  = array['expired', 'expired', 'expired']);
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('B''s decline past respond_by', format($s$select * from lab.decline_order_route(%L, 1,
  'test_not_offered')$s$, current_setting('hid.test.lroute_17')), 'P0001 ORDER_ROUTE_EXPIRED');
reset role;
select pg_temp.assert('the lapsed sent route is unchanged', (select route.state = 'sent' and route.row_version = 1
    and route.ended_at is null and ehr.order_route_effective_state(route) = 'expired'
  from ehr.order_routes route where route.id = current_setting('hid.test.lroute_17')::uuid));
set local role hid_ehr_api_runtime;
select pg_temp.as_patient(1);
select pg_temp.assert('C5 reads the lapsed routes as expired', (select array_agg(listed.effective_state)
    from ehr.patient_list_order_routes() listed
   where listed.route_id in (current_setting('hid.test.lroute_17')::uuid, current_setting('hid.test.lroute_18')::uuid,
     current_setting('hid.test.rroute_7')::uuid))
  = array['expired', 'expired', 'expired']);
reset role;
select set_config('hid.test.version_18', (pg_temp.route(current_setting('hid.test.lroute_18')::uuid)).row_version::text,
  true);
select set_config('hid.test.lapsed_references', (select string_agg(route.reference::text, ',' order by route.reference)
  from ehr.order_routes route where route.id in (current_setting('hid.test.lroute_17')::uuid,
    current_setting('hid.test.lroute_18')::uuid, current_setting('hid.test.rroute_7')::uuid)), true);
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select pg_temp.assert('C21 reads the lapsed routes as expired', (select array_agg(found.effective_state)
    from unnest(string_to_array(current_setting('hid.test.lapsed_references'), ',')) wanted(reference)
    cross join lateral identity.admin_find_order_routes(wanted.reference, null) found)
  = array['expired', 'expired', 'expired']);
select pg_temp.assert('C21 (0089) answers the lapsed routes not closable, with access_ends_at only once accepted',
  (select array_agg(found.closable::text || ':' || (found.access_ends_at is not null)::text
       || ':' || coalesce((found.access_ends_at < clock_timestamp())::text, '-')
       order by found.kind, found.accepted_at nulls first)
    from unnest(string_to_array(current_setting('hid.test.lapsed_references'), ',')) wanted(reference)
    cross join lateral identity.admin_find_order_routes(wanted.reference, null) found)
  = array['false:false:-', 'false:true:true', 'false:true:true']);
select pg_temp.as_platform(3);
select pg_temp.check('support''s close of an accepted route past its window', format($s$select * from
  identity.admin_close_order_route(%L, %s, 'The patient asked support to stop it')$s$, current_setting('hid.test.lroute_18'),
  current_setting('hid.test.version_18')), '23505 ORDER_ROUTE_ALREADY_CLOSED');
reset role;
-- The dispensing validator's own window check: PB2 gets P's consent at PH1
-- (owner SQL), so the route-backed item stays visible past its route's
-- window (without it the strict policy hides the item from an owner that
-- does not bypass row-level security, and the validator refuses it as
-- unknown instead), and the validator refuses it as closed.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
values (gen_random_uuid(), 'e4c30000-0000-4000-8000-000000000001', 'e4c12000-0000-4000-8000-000000000033',
  'e4c10000-0000-4000-8000-000000000033', 'e4c13000-0000-4000-8000-000000000033', current_setting('hid.test.facility_2')::uuid,
  'write_records', 'active', 'P4c suite consent at the pharmacy', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '30 days', false, 'direct-care');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.assert('the item stays visible under consent', exists (select 1 from pharmacy.work_items item
  where item.id = current_setting('hid.test.ritem_7')::uuid));
select pg_temp.check('a dispensing past the work window', format($s$select pg_temp.dispense(%L, 'p4c-life-dispense-07')$s$,
  current_setting('hid.test.ritem_7')), '23514 ORDER_ROUTE_CLOSED');
reset role;
select pg_temp.assert('nothing dispensed on route 7', not exists (select 1 from pharmacy.dispensings dispensing
  where dispensing.work_item_id = current_setting('hid.test.ritem_7')::uuid));

-- 8. The wrong-patient ending (0088) by state. Lab routes 21 (accepted by
-- LB1, reported by LB2) and 22 (sent); prescription route 8 (accepted by
-- PB1, dispensed and reported by PB2).
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(21, 22) n;
select set_config('hid.test.rx_8', pg_temp.prescription(1, 'active')::text, true);
select set_config('hid.test.lroute_' || n, pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_' || n)::uuid,
  current_setting('hid.test.facility_1')::uuid, 'p4c-life-send-lab-' || lpad(n::text, 4, '0'))::text, true)
  from generate_series(21, 22) n;
select set_config('hid.test.rroute_8', pg_temp.send(11, 'prescription', current_setting('hid.test.rx_8')::uuid,
  current_setting('hid.test.facility_2')::uuid, 'p4c-life-send-rx-0008')::text, true);
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.litem_21', pg_temp.accept_lab(current_setting('hid.test.lroute_21')::uuid, 1)::text, true);
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a wrong-patient report of a sent route', format($s$select * from
  lab.report_wrong_patient_order_route(%L, 1, 'wrong_order_chosen', 'Picked the wrong row at the counter',
  'p4c-life-wrong-0022', repeat('a', 64))$s$, current_setting('hid.test.lroute_22')), 'P0001 ORDER_ROUTE_NOT_ACCEPTED');
select pg_temp.check('the wrong-patient report of accepted lab route 21', format($s$select * from
  lab.report_wrong_patient_order_route(%L, 2, 'wrong_order_chosen', 'Picked the wrong row at the counter',
  'p4c-life-wrong-0021', repeat('a', 64))$s$, current_setting('hid.test.lroute_21')), 'ok');
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('hid.test.ritem_8', pg_temp.accept_rx(current_setting('hid.test.rroute_8')::uuid)::text, true);
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.dispense(current_setting('hid.test.ritem_8')::uuid, 'p4c-life-dispense-0008');
select pg_temp.check('the wrong-patient report of completed prescription route 8', format($s$select * from
  pharmacy.report_wrong_patient_order_route(%L, 3, 'someone_elses_details', 'Collected with another patient''s details',
  'p4c-life-wrong-rx08', repeat('a', 64))$s$, current_setting('hid.test.rroute_8')), 'ok');
reset role;
do $$
declare r ehr.order_routes%rowtype;
begin
  r := pg_temp.route(current_setting('hid.test.lroute_21')::uuid);
  perform pg_temp.assert('accepted -> cancelled, wrong_patient, both windows end now', r.state = 'cancelled'
    and r.ended_kind = 'wrong_patient' and r.writes_end_at = r.ended_at and r.access_ends_at = r.ended_at
    and pg_temp.last_event(r.id) = 'cancelled'
    and (select event.side || ':' || event.reason_code || ':' || event.state_after from ehr.order_route_events event
          where event.route_id = r.id order by event.event_version desc limit 1) = 'receiving:wrong_patient:cancelled',
    row_to_json(r)::text);
  r := pg_temp.route(current_setting('hid.test.rroute_8')::uuid);
  perform pg_temp.assert('completed -> completed, access ended, wrong_patient', r.state = 'completed'
    and r.ended_kind = 'wrong_patient' and r.completed_at is not null and r.writes_end_at = r.ended_at
    and r.access_ends_at = r.ended_at and pg_temp.last_event(r.id) = 'access_ended'
    and (select event.side || ':' || event.reason_code || ':' || event.state_after from ehr.order_route_events event
          where event.route_id = r.id order by event.event_version desc limit 1) = 'receiving:wrong_patient:completed',
    row_to_json(r)::text);
end $$;
select set_config('hid.test.version_21', (pg_temp.route(current_setting('hid.test.lroute_21')::uuid)).row_version::text,
  true), set_config('hid.test.version_rx8', (pg_temp.route(current_setting('hid.test.rroute_8')::uuid)).row_version::text,
  true);
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('support''s close of the cancelled wrong-patient route', format($s$select * from
  identity.admin_close_order_route(%L, %s, 'The patient asked support to stop it')$s$, current_setting('hid.test.lroute_21'),
  current_setting('hid.test.version_21')), '23505 ORDER_ROUTE_ALREADY_CLOSED');
select pg_temp.check('support''s close of the ended completed wrong-patient route', format($s$select * from
  identity.admin_close_order_route(%L, %s, 'The patient asked support to stop it')$s$, current_setting('hid.test.rroute_8'),
  current_setting('hid.test.version_rx8')), '23505 ORDER_ROUTE_ALREADY_CLOSED');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.edit_lab(current_setting('hid.test.lr_21')::uuid, 'cancelled', 'No longer needed');
select pg_temp.edit_rx(current_setting('hid.test.rx_8')::uuid, 'frequency', 'Dose interval changed');
reset role;
select pg_temp.assert('the mirror leaves the cancelled route alone, and only adds an event to the ended completed one',
  (pg_temp.route(current_setting('hid.test.lroute_21')::uuid)).row_version::text = current_setting('hid.test.version_21')
  and pg_temp.last_event(current_setting('hid.test.rroute_8')::uuid) = 'order_changed_after_completion'
  and (pg_temp.route(current_setting('hid.test.rroute_8')::uuid)).ended_kind = 'wrong_patient');
select pg_temp.assert('ended_kind by state: wrong_patient only on cancelled and completed routes',
  not exists (select 1 from ehr.order_routes route where route.ended_kind = 'wrong_patient'
               and route.state not in ('cancelled', 'completed'))
  and (select array_agg(route.state order by route.state) from ehr.order_routes route
        where route.ended_kind = 'wrong_patient') = array['cancelled', 'completed']);

-- 9. Support's find (C21, 0089) against support's Close (C22) for every
-- route of this suite: closable is exactly "Close acts now" (tried at the
-- version found, then undone), access_ends_at is the stored column, and a
-- live route that is not closable is completed.
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
grant execute on function pg_temp.close_acts(uuid,bigint) to hid_identity_api_runtime;
create temp table every_route on commit drop as
  select route.id, route.reference::text as reference, route.state, route.access_ends_at from ehr.order_routes route;
create temp table every_found (route_id uuid primary key, effective_state text, access_ends_at timestamptz,
  closable boolean, close_outcome text) on commit drop;
grant select on every_route to hid_identity_api_runtime;
grant select, insert on every_found to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
insert into every_found (route_id, effective_state, access_ends_at, closable, close_outcome)
select found.route_id, found.effective_state, found.access_ends_at, found.closable,
  pg_temp.close_acts(found.route_id, found.row_version)
  from every_route listed
  cross join lateral identity.admin_find_order_routes(listed.reference, null) found
 where found.route_id = listed.id;
reset role;
select pg_temp.assert('C21 against C22 for every route of the suite',
  (select count(*) from every_found) = (select count(*) from every_route)
  and (select count(*) from every_route) = 31
  and not exists (select 1 from every_found found join every_route listed on listed.id = found.route_id
                   where found.closable is distinct from (found.close_outcome = 'acts')
                      or found.close_outcome not in ('acts', '23505 ORDER_ROUTE_ALREADY_CLOSED')
                      or found.access_ends_at is distinct from listed.access_ends_at
                      or (not found.closable and found.effective_state in ('sent', 'accepted', 'completed')
                          and listed.state <> 'completed'))
  and exists (select 1 from every_found found where found.closable)
  and exists (select 1 from every_found found where not found.closable and found.effective_state = 'completed'),
  (select count(*) || ' routes; ' || coalesce(string_agg(found.route_id || ' ' || found.effective_state || ' '
     || found.closable || ' ' || found.close_outcome, '; ') filter (where found.closable is distinct from
     (found.close_outcome = 'acts')), 'no mismatch') from every_found found));

select pg_temp.report();
rollback;
