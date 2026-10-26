-- The receiving facility's wrong-patient report (0088, item 3). Rollback-only;
-- fails without 0088. The reports run as the exact Lab and Pharmacy runtimes
-- under route access; support's list and review as the Identity runtime.
--   1. properties and grants: language, security, volatility, search path
--      and owner of each new, replaced and recreated function (the replaced
--      and recreated ones as 0086 made them); EXECUTE exactly as 0088 section
--      5 grants it, for each group and login role and PUBLIC; the report
--      table's row-level security, four policies and no runtime privilege;
--      the new CHECKs refuse wrong_patient on withdrawn, expired and declined;
--   2. an accepted lab route with nothing recorded, reported by LB2 (not the
--      acceptor, no consent for P): cancelled, wrong_patient, both windows
--      end now; the event; the report row; the system rows at A and B and
--      the inbox notice; H7 and the receiving view; the item leaves LB2's
--      work list and the card returns no row for it (B1);
--   3. LB3, holding P's direct-care consent at B: the card shows access none,
--      ended_kind wrong_patient and no patient; a write answers closed (a
--      work item, a specimen, and on an ended completed route a result,
--      where 0086 answered none), a read none;
--   4. an accepted lab route with an accession, a specimen and unverified
--      results entered by the reporter, 5. on two requested tests: each
--      current version invalidated with its outbox row, no report at A,
--      specimens_collected 1, reporter_recorded_work true;
--   6. a completed lab route (v1 released): the invalidation and A's report,
--      access ended, P's record no longer shows the result, C3 gives A both
--      rows, who recorded the work;
--   7. v1 and its correction v2 released: v2 invalidated (A's report by the
--      trigger), v1 reported directly with its released fields, one batch
--      event and one batch row at A; 8. v2 entered but not released: v2
--      invalidated, v1 reported directly;
--   9. a dispensed prescription: reversed, A's report, the outbox row; one
--      already reversed: no second reversal, it still ends; 10. an accepted
--      prescription: cancelled, nothing reversed;
--  11. refusals, which write nothing: not accepted, already ended (declined,
--      withdrawn, cancelled by an order change, closed by support, past its
--      window; each also with a stale version: state first), another
--      facility's route or the wrong kind, a stale version, a receptionist,
--      the emergency purpose, a member who may not withdraw what must be
--      withdrawn (and that member where nothing must be), the control off,
--      invalid input;
--  12. idempotency: a replay, a key reused with another digest or on
--      another route (also by a report that committed after both lookups:
--      IDEMPOTENCY_KEY_REUSED, not 23505), another key after the end (with
--      the answered and the old version);
--  13. after the report: a release under P's consent at B is refused (the
--      replaced release trigger), support's close finds it closed, the order
--      change mirror still runs, C5 keeps the content and offers no Stop, the
--      order cannot be resent, the acceptance attempts are unchanged;
--  14. the report table's guard;
--  15. support's list (C26) and review (C27): permissions, flags and their
--      order, the 30-day counts, the facility filter, no patient, one review,
--      the actions, the note removal and the platform audit row.
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

-- 1. Properties and grants (B6).
select pg_temp.assert('each new, replaced and recreated function: language, security, volatility, search path',
  (select array_agg(format('%s|%s|%s|%s|%s', p.oid::regprocedure, l.lanname, p.prosecdef, p.provolatile,
       array_to_string(p.proconfig, ';')) order by p.oid::regprocedure::text)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid in ('ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,character)'::regprocedure,
      'lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)'::regprocedure,
      'pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)'::regprocedure,
      'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure,
      'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)'::regprocedure,
      'ehr.list_sent_wrong_patient_order_routes()'::regprocedure,
      'ehr.guard_order_route_wrong_patient_report()'::regprocedure,
      'ehr.order_route_item_access(text,uuid,text)'::regprocedure,
      'lab.return_order_route_result()'::regprocedure,
      'ehr.receiving_order_route_cards(text,uuid[])'::regprocedure,
      'lab.order_route_cards(uuid[])'::regprocedure,
      'pharmacy.order_route_cards(uuid[])'::regprocedure))
  = array[
    'ehr.guard_order_route_wrong_patient_report()|plpgsql|f|v|search_path=pg_catalog, ehr, pg_temp',
    'ehr.list_sent_wrong_patient_order_routes()|plpgsql|t|s|search_path=pg_catalog, ehr, identity, auth, platform, pg_temp',
    'ehr.order_route_item_access(text,uuid,text)|plpgsql|f|s|search_path=pg_catalog, ehr, platform, pg_temp',
    'ehr.receiving_order_route_cards(text,uuid[])|plpgsql|f|s|search_path=pg_catalog, ehr, identity, lab, pharmacy, platform, pg_temp',
    'ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,character)|plpgsql|f|v|search_path=pg_catalog, ehr, identity, auth, lab, pharmacy, notification, platform, pg_temp',
    'identity.admin_list_wrong_patient_reports(text,uuid)|plpgsql|t|s|search_path=pg_catalog, identity, ehr, auth, platform, pg_temp',
    'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)|plpgsql|t|v|search_path=pg_catalog, identity, ehr, auth, audit, platform, pg_temp',
    'lab.order_route_cards(uuid[])|sql|t|s|search_path=pg_catalog, lab, ehr, pg_temp',
    'lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)|sql|t|v|search_path=pg_catalog, lab, ehr, pg_temp',
    'lab.return_order_route_result()|plpgsql|t|v|search_path=pg_catalog, lab, ehr, platform, pg_temp',
    'pharmacy.order_route_cards(uuid[])|sql|t|s|search_path=pg_catalog, pharmacy, ehr, pg_temp',
    'pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)|sql|t|v|search_path=pg_catalog, pharmacy, ehr, pg_temp'],
  (select string_agg(format('%s|%s|%s|%s|%s', p.oid::regprocedure, l.lanname, p.prosecdef, p.provolatile,
       array_to_string(p.proconfig, ';')), E'\n' order by p.oid::regprocedure::text)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.proname in ('report_wrong_patient_order_route', 'order_route_cards', 'receiving_order_route_cards')));
select pg_temp.assert('every new, replaced and recreated function belongs to 0086''s owner',
  (select bool_and(p.proowner = (select owner.proowner from pg_proc owner
                                   where owner.oid = 'ehr.close_order_route(uuid,text,text,boolean)'::regprocedure))
     from pg_proc p
    where p.oid in ('ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,character)'::regprocedure,
      'lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)'::regprocedure,
      'pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)'::regprocedure,
      'identity.admin_list_wrong_patient_reports(text,uuid)'::regprocedure,
      'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)'::regprocedure,
      'ehr.list_sent_wrong_patient_order_routes()'::regprocedure,
      'ehr.guard_order_route_wrong_patient_report()'::regprocedure,
      'ehr.order_route_item_access(text,uuid,text)'::regprocedure,
      'lab.return_order_route_result()'::regprocedure,
      'ehr.receiving_order_route_cards(text,uuid[])'::regprocedure,
      'lab.order_route_cards(uuid[])'::regprocedure,
      'pharmacy.order_route_cards(uuid[])'::regprocedure))
  and (select c.relowner from pg_class c where c.oid = 'ehr.order_route_wrong_patient_reports'::regclass)
    = (select c.relowner from pg_class c where c.oid = 'ehr.order_routes'::regclass));
create temp table wp_expected_execute (signature regprocedure primary key, grantees text[]) on commit drop;
insert into wp_expected_execute
select signature::regprocedure, grantees from (values
  ('ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,character)', array[]::text[]),
  ('lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('ehr.receiving_order_route_cards(text,uuid[])', array[]::text[]),
  ('lab.order_route_cards(uuid[])', array['hid_lab_runtime', 'hid_schema_test_runtime']),
  ('pharmacy.order_route_cards(uuid[])', array['hid_pharmacy_runtime', 'hid_schema_test_runtime']),
  ('identity.admin_list_wrong_patient_reports(text,uuid)', array['hid_identity_runtime']),
  ('identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)', array['hid_identity_runtime']),
  ('ehr.list_sent_wrong_patient_order_routes()', array['hid_ehr_runtime', 'hid_schema_test_runtime']),
  ('ehr.guard_order_route_wrong_patient_report()', array[]::text[]),
  ('ehr.order_route_item_access(text,uuid,text)', array[]::text[]),
  ('lab.return_order_route_result()', array[]::text[])) v(signature, grantees);
select pg_temp.assert('EXECUTE exactly as 0088 grants it, PUBLIC none', not exists (
    select 1 from wp_expected_execute expected
     where coalesce((select array_agg(acl.grantee::regrole::text order by acl.grantee::regrole::text)
                       from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                      where p.oid = expected.signature and acl.privilege_type = 'EXECUTE' and acl.grantee <> p.proowner),
                    array[]::text[]) <> expected.grantees),
  (select string_agg(expected.signature::text || ' ' || coalesce((select array_agg(acl.grantee::regrole::text)
       from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where p.oid = expected.signature and acl.privilege_type = 'EXECUTE' and acl.grantee <> p.proowner)::text, '{}'), '; ')
     from wp_expected_execute expected));
select pg_temp.assert('the login roles reach their commands through their groups, and nothing else',
  has_function_privilege('hid_lab_api_runtime', 'lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_lab_api_runtime', 'lab.order_route_cards(uuid[])', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_pharmacy_api_runtime', 'pharmacy.order_route_cards(uuid[])', 'EXECUTE')
  and not has_function_privilege('hid_pharmacy_api_runtime', 'lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_identity_api_runtime', 'identity.admin_list_wrong_patient_reports(text,uuid)', 'EXECUTE')
  and has_function_privilege('hid_identity_api_runtime', 'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)', 'EXECUTE')
  and not has_function_privilege('hid_identity_api_runtime', 'lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', 'EXECUTE')
  and has_function_privilege('hid_ehr_api_runtime', 'ehr.list_sent_wrong_patient_order_routes()', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'lab.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'pharmacy.report_wrong_patient_order_route(uuid,bigint,text,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'identity.admin_list_wrong_patient_reports(text,uuid)', 'EXECUTE')
  and not has_function_privilege('hid_ehr_api_runtime', 'ehr.report_wrong_patient_order_route(text,uuid,bigint,text,text,text,character)', 'EXECUTE')
  and not has_function_privilege('hid_lab_api_runtime', 'ehr.list_sent_wrong_patient_order_routes()', 'EXECUTE')
  and not has_function_privilege('hid_identity_api_runtime', 'ehr.list_sent_wrong_patient_order_routes()', 'EXECUTE')
  and not has_function_privilege('hid_schema_test_runtime', 'identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)', 'EXECUTE'));
select pg_temp.assert('the report table: row-level security enabled and forced, four policies, no runtime privilege',
  (select c.relrowsecurity and c.relforcerowsecurity from pg_class c
    where c.oid = 'ehr.order_route_wrong_patient_reports'::regclass)
  and (select count(*) from pg_policy p where p.polrelid = 'ehr.order_route_wrong_patient_reports'::regclass) = 4
  and not exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where c.oid = 'ehr.order_route_wrong_patient_reports'::regclass and acl.grantee <> c.relowner)
  and not exists (select 1 from pg_roles runtime where runtime.rolname ~ '^hid_'
    and runtime.oid <> (select c.relowner from pg_class c where c.oid = 'ehr.order_route_wrong_patient_reports'::regclass)
    and (has_table_privilege(runtime.oid, 'ehr.order_route_wrong_patient_reports', 'SELECT')
      or has_table_privilege(runtime.oid, 'ehr.order_route_wrong_patient_reports', 'INSERT')
      or has_table_privilege(runtime.oid, 'ehr.order_route_wrong_patient_reports', 'UPDATE')
      or has_table_privilege(runtime.oid, 'ehr.order_route_wrong_patient_reports', 'DELETE')))
  and exists (select 1 from pg_trigger t where t.tgrelid = 'ehr.order_route_wrong_patient_reports'::regclass
    and t.tgname = 'order_route_wrong_patient_reports_guard' and t.tgtype = 27 and t.tgenabled = 'O'
    and t.tgfoid = 'ehr.guard_order_route_wrong_patient_report()'::regprocedure));

-- The orders (DA at GH, patient P): lab requests 1-20 (20 to the governed
-- laboratory GL, the others to L1) and prescriptions 1-5 (to PH1).
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(1, 20) n;
select set_config('hid.test.rx_' || n, pg_temp.prescription(1, 'active')::text, true) from generate_series(1, 5) n;
select set_config('hid.test.lroute_' || n, pg_temp.send(11, 'lab_request', current_setting('hid.test.lr_' || n)::uuid,
  case when n = 20 then 'e4c21000-0000-4000-8000-000000000002'::uuid else current_setting('hid.test.facility_1')::uuid end,
  'p4c-wp-send-lab-' || lpad(n::text, 4, '0'))::text, true) from generate_series(1, 20) n;
select set_config('hid.test.rroute_' || n, pg_temp.send(11, 'prescription', current_setting('hid.test.rx_' || n)::uuid,
  current_setting('hid.test.facility_2')::uuid, 'p4c-wp-send-rx-' || lpad(n::text, 4, '0'))::text, true)
  from generate_series(1, 5) n;
-- Route 8 is withdrawn by DA before anyone accepts it.
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select * from ehr.withdraw_order_route(current_setting('hid.test.lroute_8')::uuid, 'lab_request',
  current_setting('hid.test.lr_8')::uuid, 1, 'sent_in_error');
reset role;
-- L1 accepts lab routes 1-5, 9-15 (13 with a date of birth and the
-- reference, 15 with a date of birth alone) and declines 7; route 6 stays
-- sent. PH1 accepts prescription routes 1-4.
select set_config('hid.test.reference_13', (select route.reference::text from ehr.order_routes route
  where route.id = current_setting('hid.test.lroute_13')::uuid), true);
set local role hid_lab_api_runtime;
select set_config('hid.test.litem_' || n, pg_temp.accept_lab(current_setting('hid.test.lroute_' || n)::uuid)::text, true)
  from (values (1), (2), (3), (4), (5), (9), (10), (11), (12), (14)) v(n);
select set_config('hid.test.litem_13', pg_temp.accept_lab(current_setting('hid.test.lroute_13')::uuid,
  'date_of_birth', current_setting('hid.test.reference_13'))::text, true);
select set_config('hid.test.litem_15', pg_temp.accept_lab(current_setting('hid.test.lroute_15')::uuid,
  'date_of_birth')::text, true);
select pg_temp.as_signup_admin(1);
select * from lab.decline_order_route(current_setting('hid.test.lroute_7')::uuid, 1, 'test_not_offered');
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('hid.test.ritem_' || n, pg_temp.accept_rx(current_setting('hid.test.rroute_' || n)::uuid)::text, true)
  from generate_series(1, 4) n;
reset role;

-- The work: route 2 has two requested tests with unverified results LB2
-- entered; routes 3, 4, 5, 11 a verified result (lab_chain: LB2 entered,
-- LB1 verified); route 14 an unverified result.
select pg_temp.add_requested_test(current_setting('hid.test.litem_2')::uuid);
select pg_temp.assert('route 2 has two unverified results', pg_temp.lab_entry(current_setting('hid.test.litem_2')::uuid,
  'r2', 9.8) = 2);
select set_config('hid.test.result_' || n, pg_temp.lab_chain(current_setting('hid.test.litem_' || n)::uuid,
  'chain' || n, 10.4)::text, true) from (values (3), (4), (5), (11)) v(n);
select pg_temp.lab_entry(current_setting('hid.test.litem_14')::uuid, 'r14', 11.0);
-- Releases: route 3's v1 by LB3, routes 4, 5 and 11's v1 by LB1; route 4's
-- correction v2 (verified by LB1) released by LB2; route 5's correction v2
-- verified but not released.
set local role hid_lab_api_runtime;
select pg_temp.as_extra(34, current_setting('hid.test.facility_1')::uuid);
select pg_temp.release(current_setting('hid.test.result_3')::uuid, 1,
  current_setting('hid.test.chain3_verification_1')::uuid, 'p4c-wp-release-03-1');
select pg_temp.as_signup_admin(1);
select pg_temp.release(current_setting('hid.test.result_' || n)::uuid, 1,
  current_setting('hid.test.chain' || n || '_verification_1')::uuid, 'p4c-wp-release-' || lpad(n::text, 2, '0') || '-1')
  from (values (4), (5), (11)) v(n);
reset role;
select set_config('hid.test.chain4_verification_2', pg_temp.lab_correction(current_setting('hid.test.result_4')::uuid,
  'chain4', 11.2, current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
select set_config('hid.test.chain5_verification_2', pg_temp.lab_correction(current_setting('hid.test.result_5')::uuid,
  'chain5', 11.6, current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.release(current_setting('hid.test.result_4')::uuid, 2,
  current_setting('hid.test.chain4_verification_2')::uuid, 'p4c-wp-release-04-2');
reset role;
-- Dispensings by PB2 on prescription routes 1, 2 and 4; route 2's reversed
-- by PB2 by hand.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select set_config('hid.test.dispensing_' || n, pg_temp.dispense(current_setting('hid.test.ritem_' || n)::uuid,
  'p4c-wp-dispense-' || lpad(n::text, 4, '0'))::text, true) from (values (1), (2), (4)) v(n);
insert into pharmacy.dispensing_reversals (dispensing_id, dispensing_version, work_item_id, patient_id, facility_id,
  reversed_by, reversed_by_membership_id, reason, idempotency_key, request_sha256, correlation_id)
values (current_setting('hid.test.dispensing_2')::uuid, 1, current_setting('hid.test.ritem_2')::uuid,
  'e4c30000-0000-4000-8000-000000000001', current_setting('hid.test.facility_2')::uuid,
  'e4c10000-0000-4000-8000-000000000033', 'e4c13000-0000-4000-8000-000000000033', 'Wrong strength handed out',
  'p4c-wp-reverse-manual-02', repeat('e', 64), current_setting('app.correlation_id'));
reset role;
-- Route 9 ages past its work window; route 10's order is cancelled by DA
-- (the mirror cancels the route, order_changed); support (FR) closes route
-- 11, completed.
select pg_temp.age_route(current_setting('hid.test.lroute_9')::uuid, interval '31 days', interval '31 days');
set local role hid_ehr_api_runtime;
select pg_temp.edit_lab(current_setting('hid.test.lr_10')::uuid, 'cancelled', 'No longer needed');
reset role;
select pg_temp.snap();
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select * from identity.admin_close_order_route(current_setting('hid.test.lroute_11')::uuid,
  pg_temp.v(current_setting('hid.test.lroute_11')::uuid), 'The hospital asked support to close it');
reset role;
select pg_temp.assert('the fixture: each route''s state before any report',
  (select array_agg(n || ':' || route.state || ':' || coalesce(route.ended_kind, '-') order by n)
     from generate_series(1, 15) n join ehr.order_routes route on route.id = current_setting('hid.test.lroute_' || n)::uuid)
  = array['1:accepted:-', '2:accepted:-', '3:completed:-', '4:completed:-', '5:completed:-', '6:sent:-',
    '7:declined:-', '8:withdrawn:orderer', '9:accepted:-', '10:cancelled:order_changed', '11:completed:support',
    '12:accepted:-', '13:accepted:-', '14:accepted:-', '15:accepted:-']
  and (select array_agg(n || ':' || route.state order by n)
     from generate_series(1, 5) n join ehr.order_routes route on route.id = current_setting('hid.test.rroute_' || n)::uuid)
  = array['1:completed', '2:completed', '3:accepted', '4:completed', '5:sent']);
select set_config('hid.test.footprint_before', pg_temp.footprint(), true),
  set_config('hid.test.attempts_before', (select count(*)::text from ehr.order_route_accept_attempts), true),
  set_config('hid.test.patient_results_before', pg_temp.patient_results()::text, true);
select pg_temp.snap();

-- 11. Refusals (each in its own subtransaction; nothing is written).
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a sent route: not accepted', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 1,
  'wrong_order_chosen', 'Picked the wrong row at the counter', 'p4c-wp-refuse-0006')$s$,
  current_setting('hid.test.lroute_6')), 'P0001 ORDER_ROUTE_NOT_ACCEPTED');
select pg_temp.check('route ' || n || ': already ended', format($s$select * from pg_temp.wrong_patient('lab_request', %L, %s,
  'wrong_order_chosen', 'Picked the wrong row at the counter', %L)$s$, current_setting('hid.test.lroute_' || n),
  pg_temp.v(current_setting('hid.test.lroute_' || n)::uuid), 'p4c-wp-refuse-' || lpad(n::text, 4, '0')),
  'P0001 ORDER_ROUTE_ALREADY_ENDED') from (values (7), (8), (9), (10), (11)) v(n);
select pg_temp.check('route ' || n || ': already ended, with a stale version (the state is checked first)',
  format($s$select * from pg_temp.wrong_patient('lab_request', %L, 1, 'wrong_order_chosen',
  'Picked the wrong row at the counter', %L)$s$, current_setting('hid.test.lroute_' || n),
  'p4c-wp-refuse-stale-' || lpad(n::text, 4, '0')), 'P0001 ORDER_ROUTE_ALREADY_ENDED')
  from (values (7), (8), (9), (10), (11)) v(n);
select pg_temp.as_signup_admin(1);
select pg_temp.check('another facility''s route', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'wrong_order_chosen', 'Picked the wrong row at the counter', 'p4c-wp-refuse-0020')$s$,
  current_setting('hid.test.lroute_20')), 'P0002 ORDER_ROUTE_NOT_FOUND');
select pg_temp.check('a prescription route through the Lab', format($s$select * from pg_temp.wrong_patient('lab_request',
  %L, 2, 'wrong_order_chosen', 'Picked the wrong row at the counter', 'p4c-wp-refuse-rx01')$s$,
  current_setting('hid.test.rroute_1')), 'P0002 ORDER_ROUTE_NOT_FOUND');
select pg_temp.check('a stale version on a live route', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 1,
  'wrong_order_chosen', 'Picked the wrong row at the counter', 'p4c-wp-refuse-0012')$s$,
  current_setting('hid.test.lroute_12')), 'P0001 ORDER_ROUTE_VERSION_CONFLICT');
select pg_temp.check('a bad reason', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'cannot_do_it', 'Picked the wrong row at the counter', 'p4c-wp-refuse-0012')$s$,
  current_setting('hid.test.lroute_12')), '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('a 7-character note once trimmed', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'other', '   Not him   ', 'p4c-wp-refuse-0012')$s$, current_setting('hid.test.lroute_12')),
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('a 501-character note', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'other', %L, 'p4c-wp-refuse-0012')$s$, current_setting('hid.test.lroute_12'), repeat('x', 501)),
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('a bad key', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'other', 'Picked the wrong row at the counter', 'short-key')$s$, current_setting('hid.test.lroute_12')),
  '22023 ORDER_ROUTE_INVALID');
select pg_temp.check('a bad digest', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'other', 'Picked the wrong row at the counter', 'p4c-wp-refuse-0012', 'ABC')$s$,
  current_setting('hid.test.lroute_12')), '22023 ORDER_ROUTE_INVALID');
select pg_temp.as_signup_admin(1, 'emergency');
select pg_temp.check('the emergency purpose', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'other', 'Picked the wrong row at the counter', 'p4c-wp-refuse-0012')$s$, current_setting('hid.test.lroute_12')),
  '42501 Order route staff context is required');
select pg_temp.as_staff(32, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a receptionist', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'other', 'Picked the wrong row at the counter', 'p4c-wp-refuse-0012')$s$, current_setting('hid.test.lroute_12')),
  '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.as_extra(35, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a member who may not mark results in error, with a result recorded',
  format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2, 'other', 'Picked the wrong row at the counter',
  'p4c-wp-refuse-0014')$s$, current_setting('hid.test.lroute_14')),
  'P0001 ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_extra(36, current_setting('hid.test.facility_2')::uuid);
select pg_temp.check('a member who may not reverse a dispensing, with one recorded',
  format($s$select * from pg_temp.wrong_patient('prescription', %L, %s, 'other', 'Handed to the wrong person',
  'p4c-wp-refuse-rx04')$s$, current_setting('hid.test.rroute_4'), pg_temp.v(current_setting('hid.test.rroute_4')::uuid)),
  'P0001 ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED');
reset role;
-- The detail names the missing permission (for the service's problem).
do $$
declare detail_text text;
begin
  perform pg_temp.as_extra(35, current_setting('hid.test.facility_1')::uuid);
  begin
    perform * from ehr.report_wrong_patient_order_route('lab_request', current_setting('hid.test.lroute_14')::uuid, 2,
      'other', 'Picked the wrong row at the counter', 'p4c-wp-refuse-detail', repeat('d', 64));
  exception when others then
    get stacked diagnostics detail_text = pg_exception_detail;
  end;
  perform pg_temp.assert('the refusal''s detail names lab.result.entered-in-error',
    detail_text = 'lab.result.entered-in-error', detail_text);
end $$;
-- The route-access control off.
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c suite pauses route access');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('the route-access control off', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'other', 'Picked the wrong row at the counter', 'p4c-wp-refuse-0012')$s$, current_setting('hid.test.lroute_12')),
  '55000 PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled');
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(1);
select platform.admin_set_control('cross_facility_route_access_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_route_access_enabled'), 'P4c suite resumes route access');
reset role;
select pg_temp.assert('the refusals wrote nothing (apart from the two control changes and their audit rows)',
  (select string_agg(part, ',') from (select part from unnest(string_to_array(pg_temp.footprint(), ',')) with ordinality p(part, i)
     where i <> 10) parts)
  = (select string_agg(part, ',') from (select part from unnest(string_to_array(current_setting('hid.test.footprint_before'),
       ',')) with ordinality p(part, i) where i <> 10) parts),
  pg_temp.footprint() || ' vs ' || current_setting('hid.test.footprint_before'));
-- A member who may not withdraw anything may still end an order where
-- nothing must be withdrawn (D4): LR reports route 15 (accepted with a date
-- of birth alone, nothing recorded).
set local role hid_lab_api_runtime;
select pg_temp.as_extra(35, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('LR ends route 15, where nothing must be withdrawn', format($s$select pg_temp.keep('r15',
  'lab_request', %L, 2, 'other', 'The person was not the patient for another reason', 'p4c-wp-report-0015')$s$,
  current_setting('hid.test.lroute_15')), 'ok');
reset role;
select pg_temp.assert('route 15''s report: accepted with a date of birth alone, nothing recorded',
  (select report.accepted_with = 'date_of_birth' and report.results_voided = 0 and report.specimens_collected = 0
     and not report.reporter_recorded_work and report.recorded_by_membership_ids = array[]::uuid[]
     and report.reported_by_membership_id = 'e4c13000-0000-4000-8000-000000000035'
   from ehr.order_route_wrong_patient_reports report where report.route_id = current_setting('hid.test.lroute_15')::uuid));

-- 2. Accepted lab route 1, nothing recorded, reported by LB2 (not the
-- acceptor; no consent for P at L1).
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('before: route 1''s item is on LB2''s work list, with its card',
  exists (select 1 from lab.work_items item where item.id = current_setting('hid.test.litem_1')::uuid)
  and (select count(*) from lab.order_route_cards(array[current_setting('hid.test.litem_1')::uuid])) = 1
  and (select card.access = 'work' and card.ended_kind is null and card.row_version = 2
         and card.patient_full_name = 'Patience Okafor'
       from lab.order_route_cards(array[current_setting('hid.test.litem_1')::uuid]) card));
select pg_temp.check('LB2 reports route 1', format($s$select pg_temp.keep('r1', 'lab_request', %L, 2, 'wrong_order_chosen',
  'Picked the wrong row of several with the same date of birth', 'p4c-wp-report-0001')$s$,
  current_setting('hid.test.lroute_1')), 'ok');
select pg_temp.assert('after: route 1''s item has left LB2''s work list, and the card returns no row (B1)',
  not exists (select 1 from lab.work_items item where item.id = current_setting('hid.test.litem_1')::uuid)
  and (select count(*) from lab.order_route_cards(array[current_setting('hid.test.litem_1')::uuid])) = 0);
reset role;
select pg_temp.assert('the answer', pg_temp.answer('r1') = jsonb_build_object('result', 'ended',
    'report_id', pg_temp.answer('r1') -> 'report_id', 'route_row_version', 3, 'route_state', 'cancelled',
    'effective_state', 'cancelled', 'ended_kind', 'wrong_patient', 'results_voided', 0, 'result_reports_marked', 0,
    'dispensing_reversed', false, 'state_before', 'accepted', 'patient_id', 'e4c30000-0000-4000-8000-000000000001'),
  pg_temp.answer('r1')::text);
do $$
declare
  r ehr.order_routes%rowtype;
  e ehr.order_route_events%rowtype;
  report record;
begin
  r := pg_temp.route(current_setting('hid.test.lroute_1')::uuid);
  e := pg_temp.last_event(r.id);
  perform pg_temp.assert('route 1: cancelled, wrong_patient, ended by LB2, both windows end now',
    r.state = 'cancelled' and r.ended_kind = 'wrong_patient'
    and r.ended_by_account_id = 'e4c10000-0000-4000-8000-000000000031'
    and r.writes_end_at = r.ended_at and r.access_ends_at = r.ended_at and r.row_version = 3, row_to_json(r)::text);
  perform pg_temp.assert('the event: cancelled, receiving, wrong_patient, by LB2',
    e.event_type = 'cancelled' and e.side = 'receiving' and e.reason_code = 'wrong_patient' and e.event_version = 3
    and e.actor_account_id = 'e4c10000-0000-4000-8000-000000000031'
    and e.actor_membership_id = 'e4c13000-0000-4000-8000-000000000031' and e.state_after = 'cancelled',
    row_to_json(e)::text);
  select * into report from ehr.order_route_wrong_patient_reports candidate where candidate.route_id = r.id;
  perform pg_temp.assert('the report row', report.id::text = pg_temp.answer('r1') ->> 'report_id'
    and report.kind = 'lab_request' and report.receiving_facility_id = r.receiving_facility_id
    and report.receiving_organization_id = r.receiving_organization_id
    and report.ordering_facility_id = r.ordering_facility_id and report.state_before = 'accepted'
    and report.reason_code = 'wrong_order_chosen'
    and report.note = 'Picked the wrong row of several with the same date of birth' and not report.note_removed
    and report.reported_by_account_id = 'e4c10000-0000-4000-8000-000000000031'
    and report.reported_by_membership_id = 'e4c13000-0000-4000-8000-000000000031'
    and report.accepted_by_account_id = current_setting('hid.test.account_1')::uuid
    and report.accepted_by_membership_id = current_setting('hid.test.membership_1')::uuid
    and report.accepted_at = r.accepted_at and report.accepted_with = 'health_id'
    and report.recorded_by_membership_ids = array[]::uuid[] and not report.reporter_recorded_work
    and report.specimens_collected = 0 and report.results_voided = 0 and report.result_reports_marked = 0
    and not report.dispensing_reversed and report.idempotency_key = 'p4c-wp-report-0001'
    and report.request_sha256 = encode(sha256('p4c-wp-report-0001'::bytea), 'hex')
    and report.reviewed_at is null and report.row_version = 1, row_to_json(report)::text);
  perform pg_temp.assert('a system row at A and at B, with the patient, ids and codes only',
    (select array_agg(event.facility_id::text || ':' || (event.patient_id is not null)::text || ':' || event.actor_type
          order by event.facility_id::text)
       from audit.events event where event.action = 'ehr.order-route.wrong-patient' and event.resource_id = r.id::text)
    = (select array_agg(pair order by pair) from (values (r.ordering_facility_id::text || ':true:system'),
        (r.receiving_facility_id::text || ':true:system')) v(pair))
    and (select bool_and(event.details = jsonb_build_object('routeId', r.id, 'kind', 'lab_request', 'state', 'cancelled',
          'reason', 'wrong_order_chosen', 'stateBefore', 'accepted', 'resultsVoided', 0, 'dispensingReversed', false))
         from audit.events event where event.action = 'ehr.order-route.wrong-patient' and event.resource_id = r.id::text));
  perform pg_temp.assert('P''s inbox notice', exists (select 1 from notification.inbox_items item
    where item.patient_id = r.patient_id and item.notification_code = 'ORDER_ROUTE_WRONG_PATIENT'
      and item.resource_type = 'order-route' and item.resource_id = r.id
      and item.metadata = jsonb_build_object('routeId', r.id, 'kind', 'lab_request',
        'orderingFacilityName', 'P4c General Hospital', 'receivingFacilityName',
        (select facility.name from identity.facilities facility where facility.id = r.receiving_facility_id))));
  perform pg_temp.as_staff(31, r.receiving_facility_id);
  perform pg_temp.assert('H7 allows nothing; the receiving view is metadata',
    not ehr.order_route_allows(r.id, r.receiving_facility_id, 'read_records')
    and not ehr.order_route_allows(r.id, r.receiving_facility_id, 'write_records')
    and ehr.order_route_receiving_view(r) = 'metadata');
end $$;
-- Another member's report of the same route, and another kind's wrapper.
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('LB1 then reports route 1: already ended', format($s$select * from pg_temp.wrong_patient('lab_request',
  %L, 3, 'other', 'The person was not the patient', 'p4c-wp-report-0001b')$s$, current_setting('hid.test.lroute_1')),
  'P0001 ORDER_ROUTE_ALREADY_ENDED');
reset role;

-- 3. LB3, holding P's direct-care consent at L1 (B1, B11.6).
set local role hid_lab_api_runtime;
select pg_temp.as_extra(34, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('LB3''s card: present, access none, ended_kind wrong_patient, no patient',
  (select card.access = 'none' and card.ended_kind = 'wrong_patient' and card.row_version = 3
     and card.effective_state = 'cancelled' and card.patient_full_name is null and card.patient_sex is null
     and card.patient_date_of_birth is null and card.patient_health_id_last4 is null
     and card.orderer_licence_number is null
   from lab.order_route_cards(array[current_setting('hid.test.litem_1')::uuid]) card));
select pg_temp.assert('LB3: a write on route 1''s work item (an accession) is closed, a read none',
  (select access.outcome from lab.order_route_access_for('work_item', current_setting('hid.test.litem_1')::uuid,
     'write_records') access) = 'closed'
  and (select access.outcome from lab.order_route_access_for('work_item', current_setting('hid.test.litem_1')::uuid,
     'read_records') access) = 'none');
reset role;

-- 4 and 5. Accepted lab route 2: an accession, a collected specimen, two
-- requested tests with unverified results LB2 entered; LB2 reports.
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('LB2 reports route 2', format($s$select pg_temp.keep('r2', 'lab_request', %L, 2,
  'someone_elses_details', 'The person gave a Health ID that was not theirs', 'p4c-wp-report-0002')$s$,
  current_setting('hid.test.lroute_2')), 'ok');
reset role;
do $$
declare
  r ehr.order_routes%rowtype := pg_temp.route(current_setting('hid.test.lroute_2')::uuid);
  report record;
begin
  select * into report from ehr.order_route_wrong_patient_reports candidate where candidate.route_id = r.id;
  perform pg_temp.assert('route 2: both current versions invalidated, by LB2, with the fixed reason and keys',
    (select array_agg(invalidation.result_id::text || ':' || invalidation.result_version order by invalidation.result_id)
       from lab.result_invalidations invalidation
      where invalidation.result_id in (current_setting('hid.test.r2_result_1')::uuid, current_setting('hid.test.r2_result_2')::uuid)
        and invalidation.actor_id = 'e4c10000-0000-4000-8000-000000000031'
        and invalidation.actor_membership_id = 'e4c13000-0000-4000-8000-000000000031'
        and invalidation.reason = 'Accepted for someone who is not this order''s patient: not this patient''s result'
        and invalidation.idempotency_key = 'wrong-patient:' || r.id || ':' || invalidation.result_id
        and invalidation.request_sha256 = encode(sha256('p4c-wp-report-0002'::bytea), 'hex'))
    = (select array_agg(id::text || ':1' order by id) from (values (current_setting('hid.test.r2_result_1')::uuid),
        (current_setting('hid.test.r2_result_2')::uuid)) v(id)));
  perform pg_temp.assert('route 2: one LabResultEnteredInError outbox row per result, with P and B',
    (select count(*) from lab.outbox_events outbox
      where outbox.event_type = 'LabResultEnteredInError'
        and outbox.aggregate_id in (current_setting('hid.test.r2_result_1')::uuid, current_setting('hid.test.r2_result_2')::uuid)
        and outbox.aggregate_version = 1 and outbox.patient_id = r.patient_id
        and outbox.facility_id = r.receiving_facility_id
        and outbox.payload = jsonb_build_object('resultId', outbox.aggregate_id, 'resultVersion', 1,
          'status', 'entered_in_error')) = 2);
  perform pg_temp.assert('route 2: nothing reported at A (never released)', not exists (select 1
    from lab.order_route_result_reports report_row where report_row.route_id = r.id));
  perform pg_temp.assert('route 2''s report: two voided, one specimen, the reporter recorded the work (B11.4, C6)',
    report.results_voided = 2 and report.result_reports_marked = 0 and report.specimens_collected = 1
    and report.reporter_recorded_work and report.recorded_by_membership_ids = array['e4c13000-0000-4000-8000-000000000031'::uuid]
    and report.accepted_with = 'health_id' and report.state_before = 'accepted' and r.state = 'cancelled'
    and r.ended_kind = 'wrong_patient', row_to_json(report)::text);
  perform pg_temp.assert('route 2''s answer', pg_temp.answer('r2') ->> 'results_voided' = '2'
    and pg_temp.answer('r2') ->> 'result_reports_marked' = '0' and pg_temp.answer('r2') ->> 'route_state' = 'cancelled');
end $$;
set local role hid_lab_api_runtime;
select pg_temp.as_extra(34, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('LB3: a specimen rejection on route 2 is closed',
  (select access.outcome from lab.order_route_access_for('specimen', current_setting('hid.test.r2_specimen')::uuid,
     'write_records') access) = 'closed');
reset role;

-- 6. Completed lab route 3: v1 released (LB2 entered, LB1 verified, LB3
-- released); LB1 reports.
select pg_temp.assert('before: P''s record shows route 3''s result',
  current_setting('hid.test.result_3')::uuid = any(pg_temp.patient_results()));
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.check('LB1 reports route 3', format($s$select pg_temp.keep('r3', 'lab_request', %L, 3, 'suspected_misuse',
  'The person used a Health ID card that was not theirs', 'p4c-wp-report-0003')$s$,
  current_setting('hid.test.lroute_3')), 'ok');
reset role;
do $$
declare
  r ehr.order_routes%rowtype := pg_temp.route(current_setting('hid.test.lroute_3')::uuid);
  report record;
begin
  select * into report from ehr.order_route_wrong_patient_reports candidate where candidate.route_id = r.id;
  perform pg_temp.assert('route 3: v1 invalidated, A''s report by the trigger, access ended (completed)',
    exists (select 1 from lab.result_invalidations invalidation
             where invalidation.result_id = current_setting('hid.test.result_3')::uuid and invalidation.result_version = 1)
    and (select array_agg(report_row.kind || ':' || report_row.result_version order by report_row.recorded_at, report_row.id)
           from lab.order_route_result_reports report_row where report_row.route_id = r.id)
      = array['released:1', 'entered_in_error:1']
    and r.state = 'completed' and r.ended_kind = 'wrong_patient' and r.writes_end_at = r.ended_at
    and r.access_ends_at = r.ended_at
    and (pg_temp.last_event(r.id)).event_type = 'access_ended'
    and (pg_temp.last_event(r.id)).reason_code = 'wrong_patient', row_to_json(r)::text);
  perform pg_temp.assert('route 3''s report: who recorded the work (enterer LB2, verifier and reporter LB1, releaser LB3)',
    report.recorded_by_membership_ids = (select array_agg(id order by id) from (values
      ('e4c13000-0000-4000-8000-000000000031'::uuid), (current_setting('hid.test.membership_1')::uuid),
      ('e4c13000-0000-4000-8000-000000000034'::uuid)) v(id))
    and report.reporter_recorded_work and report.state_before = 'completed' and report.results_voided = 1
    and report.result_reports_marked = 1 and report.specimens_collected = 1, row_to_json(report)::text);
  perform pg_temp.assert('route 3''s answer: completed, access ended', pg_temp.answer('r3') ->> 'route_state' = 'completed'
    and pg_temp.answer('r3') ->> 'effective_state' = 'completed' and pg_temp.answer('r3') ->> 'state_before' = 'completed'
    and pg_temp.answer('r3') ->> 'results_voided' = '1' and pg_temp.answer('r3') ->> 'result_reports_marked' = '1');
  perform pg_temp.assert('P''s record no longer shows the result',
    not current_setting('hid.test.result_3')::uuid = any(pg_temp.patient_results()));
end $$;
set local role hid_ehr_api_runtime;
select pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
select pg_temp.assert('C3 gives A both rows and the ending', (select listed.summary ->> 'endedKind' = 'wrong_patient'
    and listed.summary ->> 'effectiveState' = 'completed'
    and (select array_agg((item ->> 'kind') || ':' || (item ->> 'resultVersion')) from jsonb_array_elements(listed.reports) item)
      = array['released:1', 'entered_in_error:1']
    and (select array_agg(event ->> 'type') from jsonb_array_elements(listed.events) event)
      = array['created', 'accepted', 'completed', 'result_marked_in_error', 'access_ended']
  from ehr.list_order_routes_for_order('lab_request', 'e4c30000-0000-4000-8000-000000000001',
    current_setting('hid.test.lr_3')::uuid) listed));
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_extra(34, current_setting('hid.test.facility_1')::uuid);
select pg_temp.assert('LB3 under consent: a write on the ended completed route 3 is closed (0086 answered none)',
  (select access.outcome from lab.order_route_access_for('work_item', current_setting('hid.test.litem_3')::uuid,
     'write_records') access) = 'closed'
  and (select access.outcome from lab.order_route_access_for('result', current_setting('hid.test.result_3')::uuid,
     'write_records') access) = 'closed'
  and (select access.outcome from lab.order_route_access_for('result', current_setting('hid.test.result_3')::uuid,
     'read_records') access) = 'none');
reset role;

-- 7. Route 4: v1 released, its correction v2 released; LB2 reports.
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('LB2 reports route 4', format($s$select pg_temp.keep('r4', 'lab_request', %L, 4, 'other',
  'The person was not the patient for another reason', 'p4c-wp-report-0004')$s$,
  current_setting('hid.test.lroute_4')), 'ok');
reset role;
do $$
declare
  r ehr.order_routes%rowtype := pg_temp.route(current_setting('hid.test.lroute_4')::uuid);
  released record;
  direct record;
begin
  select * into released from lab.order_route_result_reports report_row
   where report_row.route_id = r.id and report_row.kind = 'released' and report_row.result_version = 1;
  select * into direct from lab.order_route_result_reports report_row
   where report_row.route_id = r.id and report_row.kind = 'entered_in_error' and report_row.result_version = 1;
  perform pg_temp.assert('route 4: v2 invalidated (only the current version), v1 not',
    (select array_agg(invalidation.result_version order by invalidation.result_version) from lab.result_invalidations invalidation
      where invalidation.result_id = current_setting('hid.test.result_4')::uuid) = array[2::bigint]);
  perform pg_temp.assert('route 4: A holds both versions entered in error',
    (select array_agg(report_row.kind || ':' || report_row.result_version order by report_row.recorded_at, report_row.id)
       from lab.order_route_result_reports report_row where report_row.route_id = r.id)
    = array['released:1', 'released:2', 'entered_in_error:2', 'entered_in_error:1']);
  perform pg_temp.assert('route 4: v1''s direct report copies the released row (B7)',
    direct.work_item_id = released.work_item_id and direct.test_code_system = released.test_code_system
    and direct.test_code = released.test_code and direct.test_name = released.test_name
    and direct.result_id = released.result_id and direct.performing_facility_id = r.receiving_facility_id
    and direct.result_type is null and direct.numeric_value is null and direct.text_value is null,
    row_to_json(direct)::text);
  perform pg_temp.assert('route 4: one batch event and one batch row at A, then access ended',
    (select array_agg(event.event_type || ':' || coalesce(event.reason_code, '-') order by event.event_version)
       from ehr.order_route_events event where event.route_id = r.id and event.event_version > 4)
    = array['result_marked_in_error:-', 'result_marked_in_error:wrong_patient', 'access_ended:wrong_patient']
    and (select count(*) from audit.events event where event.resource_id = r.id::text
          and event.action = 'ehr.order-route.result-marked-in-error'
          and event.details @> jsonb_build_object('reportsMarked', 1, 'reason', 'wrong_patient')) = 1
    and r.state = 'completed' and r.ended_kind = 'wrong_patient');
  perform pg_temp.assert('route 4''s answer: one voided, two reports marked',
    pg_temp.answer('r4') ->> 'results_voided' = '1' and pg_temp.answer('r4') ->> 'result_reports_marked' = '2');
end $$;

-- 8. Route 5: v1 released, its correction v2 verified but not released;
-- LB2 reports.
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('LB2 reports route 5', format($s$select pg_temp.keep('r5', 'lab_request', %L, 3, 'other',
  'The person was not the patient for another reason', 'p4c-wp-report-0005')$s$,
  current_setting('hid.test.lroute_5')), 'ok');
reset role;
select pg_temp.assert('route 5: v2 invalidated, v1 reported entered in error directly, one voided and one marked',
  (select array_agg(invalidation.result_version) from lab.result_invalidations invalidation
    where invalidation.result_id = current_setting('hid.test.result_5')::uuid) = array[2::bigint]
  and (select array_agg(report_row.kind || ':' || report_row.result_version order by report_row.recorded_at, report_row.id)
         from lab.order_route_result_reports report_row
        where report_row.route_id = current_setting('hid.test.lroute_5')::uuid)
    = array['released:1', 'entered_in_error:1']
  and pg_temp.answer('r5') ->> 'results_voided' = '1' and pg_temp.answer('r5') ->> 'result_reports_marked' = '1');

-- 9. Prescription route 1, dispensed by PB2; PB2 reports. Route 2, whose
-- dispensing PB2 reversed by hand; PB1 reports.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.check('PB2 reports prescription route 1', format($s$select pg_temp.keep('x1', 'prescription', %L, %s,
  'someone_elses_details', 'Collected by a person using another patient''s details', 'p4c-wp-report-rx01')$s$,
  current_setting('hid.test.rroute_1'), pg_temp.v(current_setting('hid.test.rroute_1')::uuid)), 'ok');
select pg_temp.as_signup_admin(2);
select pg_temp.check('PB1 reports prescription route 2', format($s$select pg_temp.keep('x2', 'prescription', %L, %s,
  'someone_elses_details', 'Collected by a person using another patient''s details', 'p4c-wp-report-rx02')$s$,
  current_setting('hid.test.rroute_2'), pg_temp.v(current_setting('hid.test.rroute_2')::uuid)), 'ok');
reset role;
do $$
declare
  r ehr.order_routes%rowtype := pg_temp.route(current_setting('hid.test.rroute_1')::uuid);
  reversal record;
begin
  select * into reversal from pharmacy.dispensing_reversals candidate
   where candidate.dispensing_id = current_setting('hid.test.dispensing_1')::uuid;
  perform pg_temp.assert('prescription route 1: reversed by PB2, with the fixed reason and key',
    reversal.reversed_by = 'e4c10000-0000-4000-8000-000000000033'
    and reversal.reversed_by_membership_id = 'e4c13000-0000-4000-8000-000000000033'
    and reversal.reason = 'Dispensed to someone who is not this prescription''s patient (wrong-patient report)'
    and reversal.idempotency_key = 'wrong-patient:' || r.id and reversal.dispensing_version = 1, row_to_json(reversal)::text);
  perform pg_temp.assert('prescription route 1: A''s reversed report, the outbox row, access ended',
    (select array_agg(report_row.kind order by report_row.recorded_at) from pharmacy.order_route_dispensing_reports report_row
      where report_row.route_id = r.id) = array['dispensed', 'reversed']
    and exists (select 1 from pharmacy.outbox_events outbox where outbox.event_type = 'MedicationDispensingReversed'
      and outbox.aggregate_type = 'medication-dispensing-reversal' and outbox.aggregate_id = reversal.id
      and outbox.aggregate_version = 1 and outbox.patient_id = r.patient_id and outbox.facility_id = r.receiving_facility_id
      and outbox.payload = jsonb_build_object('reversalId', reversal.id, 'dispensingId', reversal.dispensing_id,
        'workItemId', reversal.work_item_id, 'status', 'reversed'))
    and r.state = 'completed' and r.ended_kind = 'wrong_patient' and r.access_ends_at = r.ended_at
    and pg_temp.answer('x1') ->> 'dispensing_reversed' = 'true' and pg_temp.answer('x1') ->> 'results_voided' = '0');
  perform pg_temp.assert('prescription route 1''s report: the dispenser recorded the work, the reporter',
    (select report.recorded_by_membership_ids = array['e4c13000-0000-4000-8000-000000000033'::uuid]
       and report.reporter_recorded_work and report.dispensing_reversed and report.specimens_collected = 0
     from ehr.order_route_wrong_patient_reports report where report.route_id = r.id));
  r := pg_temp.route(current_setting('hid.test.rroute_2')::uuid);
  perform pg_temp.assert('prescription route 2, already reversed: no second reversal, and it still ends',
    (select count(*) from pharmacy.dispensing_reversals candidate
      where candidate.dispensing_id = current_setting('hid.test.dispensing_2')::uuid) = 1
    and r.state = 'completed' and r.ended_kind = 'wrong_patient'
    and pg_temp.answer('x2') ->> 'dispensing_reversed' = 'false'
    and (select not report.reporter_recorded_work from ehr.order_route_wrong_patient_reports report
          where report.route_id = r.id));
end $$;

-- 10. Prescription route 3, accepted, nothing dispensed; PB2 reports.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.check('PB2 reports prescription route 3', format($s$select pg_temp.keep('x3', 'prescription', %L, 2,
  'other', 'The person was not the patient for another reason', 'p4c-wp-report-rx03')$s$,
  current_setting('hid.test.rroute_3')), 'ok');
reset role;
select pg_temp.assert('prescription route 3: cancelled, nothing reversed (B11.5)',
  (pg_temp.route(current_setting('hid.test.rroute_3')::uuid)).state = 'cancelled'
  and (pg_temp.route(current_setting('hid.test.rroute_3')::uuid)).ended_kind = 'wrong_patient'
  and not exists (select 1 from pharmacy.dispensing_reversals reversal
                   where reversal.work_item_id = current_setting('hid.test.ritem_3')::uuid)
  and pg_temp.answer('x3') ->> 'dispensing_reversed' = 'false' and pg_temp.answer('x3') ->> 'route_state' = 'cancelled');

-- 12. Idempotency, on route 13 (accepted with a date of birth and the
-- reference).
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('LB2 reports route 13', format($s$select pg_temp.keep('r13', 'lab_request', %L, 2,
  'wrong_order_chosen', 'Picked the wrong row at the counter', 'p4c-wp-report-0013')$s$,
  current_setting('hid.test.lroute_13')), 'ok');
reset role;
select set_config('hid.test.footprint_13', pg_temp.footprint(), true);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('the same key and digest: replayed', format($s$select pg_temp.keep('r13-replay', 'lab_request', %L, 2,
  'wrong_order_chosen', 'Picked the wrong row at the counter', 'p4c-wp-report-0013')$s$,
  current_setting('hid.test.lroute_13')), 'ok');
select pg_temp.check('the same key, another digest', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'wrong_order_chosen', 'Picked the wrong row at the counter', 'p4c-wp-report-0013', repeat('f', 64))$s$,
  current_setting('hid.test.lroute_13')), 'P0001 IDEMPOTENCY_KEY_REUSED');
select pg_temp.check('the same key on another route', format($s$select * from pg_temp.wrong_patient('lab_request', %L, 2,
  'wrong_order_chosen', 'Picked the wrong row at the counter', 'p4c-wp-report-0013')$s$,
  current_setting('hid.test.lroute_12')), 'P0001 IDEMPOTENCY_KEY_REUSED');
select pg_temp.check('another key with the answered version', format($s$select * from pg_temp.wrong_patient('lab_request',
  %L, 3, 'wrong_order_chosen', 'Picked the wrong row at the counter', 'p4c-wp-report-0013-again')$s$,
  current_setting('hid.test.lroute_13')), 'P0001 ORDER_ROUTE_ALREADY_ENDED');
select pg_temp.check('another key with the old version', format($s$select * from pg_temp.wrong_patient('lab_request',
  %L, 2, 'wrong_order_chosen', 'Picked the wrong row at the counter', 'p4c-wp-report-0013-again')$s$,
  current_setting('hid.test.lroute_13')), 'P0001 ORDER_ROUTE_ALREADY_ENDED');
reset role;
select pg_temp.assert('the replay answers the report with the route as it is, and writes nothing',
  pg_temp.answer('r13-replay') = (pg_temp.answer('r13') || jsonb_build_object('result', 'replayed'))
  and pg_temp.footprint() = current_setting('hid.test.footprint_13'),
  pg_temp.answer('r13-replay')::text || ' / ' || pg_temp.answer('r13')::text);
select pg_temp.assert('route 13''s report: accepted with a date of birth and the reference',
  (select report.accepted_with from ehr.order_route_wrong_patient_reports report
    where report.route_id = current_setting('hid.test.lroute_13')::uuid) = 'date_of_birth_with_reference');
-- The same key on another route, by a report that committed after both of
-- this report's lookups (the two routes are locked one by one, so neither
-- waits for the other there). One session plays both: a trigger on the
-- route's events plants that report's row the moment this report ends route
-- 12, after its lookups and before its own row. The key's unique index then
-- answers it as the lookups would, IDEMPOTENCY_KEY_REUSED (409), not 23505
-- (which the services answer 503), and nothing is written.
create function pg_temp.plant_same_key_report() returns trigger language plpgsql security definer as $f$
begin
  if not exists (select 1 from ehr.order_route_wrong_patient_reports report
                  where report.idempotency_key = 'p4c-wp-report-0012-race') then
    insert into ehr.order_route_wrong_patient_reports (id, route_id, kind, receiving_facility_id,
      receiving_organization_id, ordering_facility_id, state_before, reason_code, note, reported_by_account_id,
      reported_by_membership_id, accepted_by_account_id, accepted_by_membership_id, accepted_at, accepted_with,
      recorded_by_membership_ids, reporter_recorded_work, specimens_collected, results_voided, result_reports_marked,
      dispensing_reversed, idempotency_key, request_sha256, correlation_id)
    select gen_random_uuid(), current_setting('hid.test.lroute_20')::uuid, report.kind, report.receiving_facility_id,
      report.receiving_organization_id, report.ordering_facility_id, report.state_before, report.reason_code,
      report.note, report.reported_by_account_id, report.reported_by_membership_id, report.accepted_by_account_id,
      report.accepted_by_membership_id, report.accepted_at, report.accepted_with, report.recorded_by_membership_ids,
      report.reporter_recorded_work, report.specimens_collected, report.results_voided, report.result_reports_marked,
      report.dispensing_reversed, 'p4c-wp-report-0012-race', report.request_sha256, report.correlation_id
      from ehr.order_route_wrong_patient_reports report
     where report.route_id = current_setting('hid.test.lroute_13')::uuid;
  end if;
  return null;
end
$f$;
create trigger p4c_plant_same_key_report after insert on ehr.order_route_events for each row
  when (new.route_id::text = current_setting('hid.test.lroute_12', true))
  execute function pg_temp.plant_same_key_report();
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('the same key on another route, committed after both lookups', format($s$select * from
  pg_temp.wrong_patient('lab_request', %L, 2, 'wrong_order_chosen', 'Picked the wrong row at the counter',
  'p4c-wp-report-0012-race')$s$, current_setting('hid.test.lroute_12')), 'P0001 IDEMPOTENCY_KEY_REUSED');
reset role;
drop trigger p4c_plant_same_key_report on ehr.order_route_events;
select pg_temp.assert('the same key at the same moment wrote nothing, and route 12 is still accepted',
  pg_temp.footprint() = current_setting('hid.test.footprint_13')
  and (pg_temp.route(current_setting('hid.test.lroute_12')::uuid)).state = 'accepted'
  and (pg_temp.route(current_setting('hid.test.lroute_12')::uuid)).ended_kind is null
  and not exists (select 1 from ehr.order_route_wrong_patient_reports report
                   where report.idempotency_key = 'p4c-wp-report-0012-race'),
  pg_temp.footprint() || ' vs ' || current_setting('hid.test.footprint_13'));

-- 13. After the reports.
-- A release under P's consent at L1, of route 5's new correction v3
-- (verified), on a route that ended wrong_patient: the replaced release
-- trigger refuses it (B4's path: 0086 would file it).
select set_config('hid.test.chain5_verification_3', pg_temp.lab_next_version(current_setting('hid.test.result_5')::uuid,
  'chain5', 12.0, current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_extra(34, current_setting('hid.test.facility_1')::uuid);
select pg_temp.check('a release under P''s consent after the report', format($s$select pg_temp.release(%L, 3, %L,
  'p4c-wp-release-05-3')$s$, current_setting('hid.test.result_5'), current_setting('hid.test.chain5_verification_3')),
  '23514 ORDER_ROUTE_CLOSED');
reset role;
select pg_temp.assert('nothing crossed, and P''s record still hides route 5''s result',
  not exists (select 1 from lab.result_releases release_row
               where release_row.result_id = current_setting('hid.test.result_5')::uuid and release_row.result_version = 3)
  and not exists (select 1 from lab.order_route_result_reports report_row
                   where report_row.route_id = current_setting('hid.test.lroute_5')::uuid
                     and report_row.result_version = 3)
  and not current_setting('hid.test.result_5')::uuid = any(pg_temp.patient_results()));
select pg_temp.snap();
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('support''s close of reported route ' || n, format($s$select * from identity.admin_close_order_route(%L,
  %s, 'The hospital asked support to close it')$s$, current_setting('hid.test.lroute_' || n),
  pg_temp.v(current_setting('hid.test.lroute_' || n)::uuid)), '23505 ORDER_ROUTE_ALREADY_CLOSED')
  from (values (1), (3)) v(n);
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.as_patient(1);
select pg_temp.assert('C5 shows route 1 ended wrong_patient with its full content and no Stop',
  (select listed.ended_kind = 'wrong_patient' and listed.effective_state = 'cancelled' and not listed.entered_in_error
     and listed.content ->> 'testDisplay' = 'Haemoglobin' and listed.attestation_text is not null
     and coalesce(cardinality(listed.actions), 0) = 0
   from ehr.patient_list_order_routes() listed where listed.route_id = current_setting('hid.test.lroute_1')::uuid),
  (select row_to_json(listed)::text from ehr.patient_list_order_routes() listed
    where listed.route_id = current_setting('hid.test.lroute_1')::uuid));
select pg_temp.check('C1 sends route 13''s order again', format($s$select pg_temp.send(11, 'lab_request', %L, %L,
  'p4c-wp-resend-0013')$s$, current_setting('hid.test.lr_13'), current_setting('hid.test.facility_1')),
  'P0001 ORDER_ROUTE_ORDER_IN_WORK');
select pg_temp.edit_lab(current_setting('hid.test.lr_1')::uuid, 'cancelled', 'No longer needed');
select pg_temp.edit_lab(current_setting('hid.test.lr_3')::uuid, 'priority', 'Priority raised after review');
reset role;
select pg_temp.assert('the order may not be resent; the mirror ran after the report; the acceptance attempts are unchanged',
  not ehr.order_route_resend_allowed('lab_request', current_setting('hid.test.lr_13')::uuid)
  and (pg_temp.route(current_setting('hid.test.lroute_1')::uuid)).row_version = 3
  and (pg_temp.last_event(current_setting('hid.test.lroute_3')::uuid)).event_type = 'order_changed_after_completion'
  and (pg_temp.route(current_setting('hid.test.lroute_3')::uuid)).ended_kind = 'wrong_patient'
  and (select count(*)::text from ehr.order_route_accept_attempts) = current_setting('hid.test.attempts_before'));
select pg_temp.assert('no audit row carries a report''s note', not exists (select 1 from audit.events event
  where event.details::text like '%same date of birth%' or event.details::text like '%Health ID card that was not%'
     or coalesce(event.reason, '') like '%same date of birth%'));

-- 14. The report table's guard (as the cluster superuser too).
select pg_temp.check('a non-review column', format($s$update ehr.order_route_wrong_patient_reports
  set reason_code = 'other', row_version = row_version + 1 where route_id = %L$s$, current_setting('hid.test.lroute_3')),
  '55000 ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE');
select pg_temp.check('a delete', format($s$delete from ehr.order_route_wrong_patient_reports where route_id = %L$s$,
  current_setting('hid.test.lroute_3')), '55000 ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE');
select pg_temp.check('the note without a review', format($s$update ehr.order_route_wrong_patient_reports
  set note = 'Something else entirely', row_version = row_version + 1 where route_id = %L$s$,
  current_setting('hid.test.lroute_3')), '55000 ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE');
select pg_temp.check('a review that removes the note to another text', format($s$update ehr.order_route_wrong_patient_reports
  set reviewed_at = clock_timestamp(), reviewed_by_account_id = 'e4c10000-0000-4000-8000-000000000003',
    review_actions = array['facility_contacted'], review_note = 'Phoned the laboratory', note_removed = true,
    note = 'Removed by support', row_version = row_version + 1 where route_id = %L$s$,
  current_setting('hid.test.lroute_3')), '55000 ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE');
select pg_temp.check('a review that changes the note without removing it', format($s$update
  ehr.order_route_wrong_patient_reports set reviewed_at = clock_timestamp(),
    reviewed_by_account_id = 'e4c10000-0000-4000-8000-000000000003', review_actions = array['facility_contacted'],
    review_note = 'Phoned the laboratory', note = 'A different note entirely', row_version = row_version + 1
  where route_id = %L$s$, current_setting('hid.test.lroute_3')), '55000 ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE');
select pg_temp.check('a review with a duplicate action', format($s$update ehr.order_route_wrong_patient_reports
  set reviewed_at = clock_timestamp(), reviewed_by_account_id = 'e4c10000-0000-4000-8000-000000000003',
    review_actions = array['facility_contacted', 'facility_contacted'], review_note = 'Phoned the laboratory',
    row_version = row_version + 1 where route_id = %L$s$,
  current_setting('hid.test.lroute_3')), '55000 ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE');
select pg_temp.check('a review without the version', format($s$update ehr.order_route_wrong_patient_reports
  set reviewed_at = clock_timestamp(), reviewed_by_account_id = 'e4c10000-0000-4000-8000-000000000003',
    review_actions = array['facility_contacted'], review_note = 'Phoned the laboratory' where route_id = %L$s$,
  current_setting('hid.test.lroute_3')), '55000 ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE');

-- 15. Support's list (C26) and review (C27).
set local role hid_identity_api_runtime;
select pg_temp.as_platform(2);
select pg_temp.check('SU lists', $s$select * from identity.admin_list_wrong_patient_reports('unreviewed', null)$s$,
  '42501 ADMIN_PERMISSION_DENIED');
select pg_temp.check('SU reviews', format($s$select * from identity.admin_review_wrong_patient_report(%L, 1,
  array['facility_contacted'], 'Phoned the laboratory', false)$s$, pg_temp.answer('r1') ->> 'report_id'),
  '42501 ADMIN_PERMISSION_DENIED');
select pg_temp.as_platform(4);
select pg_temp.check('AU lists', $s$select * from identity.admin_list_wrong_patient_reports('unreviewed', null)$s$,
  '42501 ADMIN_PERMISSION_DENIED');
select pg_temp.check('AU reviews', format($s$select * from identity.admin_review_wrong_patient_report(%L, 1,
  array['facility_contacted'], 'Phoned the laboratory', false)$s$, pg_temp.answer('r1') ->> 'report_id'),
  '42501 ADMIN_PERMISSION_DENIED');
select pg_temp.as_platform(3);
select pg_temp.check('an invalid status', $s$select * from identity.admin_list_wrong_patient_reports('all', null)$s$,
  '22023 WRONG_PATIENT_REPORTS_QUERY_INVALID');
select pg_temp.check('an unknown facility', $s$select * from identity.admin_list_wrong_patient_reports('recent',
  gen_random_uuid())$s$, 'P0002 ADMIN_FACILITY_NOT_FOUND');
create temp table wp_listed on commit drop as
  select row_number() over () as position, listed.*
    from identity.admin_list_wrong_patient_reports('unreviewed', null) listed;
reset role;
select pg_temp.assert('every report is unreviewed, flagged first, then oldest first',
  (select array_agg(listed.route_id order by listed.position) from wp_listed listed)
  = (select array_agg(report.route_id order by cardinality(listed.flags) > 0 desc, report.reported_at)
       from ehr.order_route_wrong_patient_reports report join wp_listed listed on listed.report_id = report.id)
  and (select count(*) from wp_listed) = (select count(*) from ehr.order_route_wrong_patient_reports)
  and (select count(*) from wp_listed) = 10);
select pg_temp.assert('the flags', (select array_agg(listed.reference || ':' || array_to_string(listed.flags, '+')
      order by listed.reference)
    from wp_listed listed)
  = (select array_agg(pair order by pair) from (values
      -- 0090 (CL13) adds patient_reported_before: every report but route
      -- 15's, the first of the suite, follows another on a route of P.
      ((pg_temp.route(current_setting('hid.test.lroute_1')::uuid)).reference || ':patient_reported_before'),
      ((pg_temp.route(current_setting('hid.test.lroute_2')::uuid)).reference
        || ':reporter_recorded_work+patient_reported_before'),
      ((pg_temp.route(current_setting('hid.test.lroute_3')::uuid)).reference
        || ':something_came_back+reporter_recorded_work+suspected_misuse+patient_reported_before'),
      ((pg_temp.route(current_setting('hid.test.lroute_4')::uuid)).reference
        || ':something_came_back+reporter_recorded_work+patient_reported_before'),
      ((pg_temp.route(current_setting('hid.test.lroute_5')::uuid)).reference
        || ':something_came_back+reporter_recorded_work+patient_reported_before'),
      ((pg_temp.route(current_setting('hid.test.lroute_13')::uuid)).reference || ':patient_reported_before'),
      ((pg_temp.route(current_setting('hid.test.lroute_15')::uuid)).reference || ':other_reason_nothing_recorded'),
      ((pg_temp.route(current_setting('hid.test.rroute_1')::uuid)).reference
        || ':something_came_back+reporter_recorded_work+patient_reported_before'),
      ((pg_temp.route(current_setting('hid.test.rroute_2')::uuid)).reference
        || ':something_came_back+patient_reported_before'),
      ((pg_temp.route(current_setting('hid.test.rroute_3')::uuid)).reference
        || ':other_reason_nothing_recorded+patient_reported_before')) v(pair)),
  (select string_agg(listed.reference || ':' || array_to_string(listed.flags, '+'), ', ') from wp_listed listed));
select pg_temp.assert('the names, the members and the 30-day counts',
  (select listed.reported_by_name = 'Musa Second Lab' and listed.accepted_by_name = 'Kemi Lab Admin'
     and not listed.same_member and listed.accepted_with = 'health_id' and listed.reason_code = 'wrong_order_chosen'
     and listed.note = 'Picked the wrong row of several with the same date of birth' and not listed.note_removed
     and listed.recorded_by = '[]'::jsonb and listed.facility_reports_last_30_days = 7
     and listed.member_reports_last_30_days = 7 and listed.receiving_facility_name = 'P4c Sign-up Laboratory Ltd'
     and listed.ordering_facility_name = 'P4c General Hospital' and listed.kind = 'lab_request'
     and listed.state_before = 'accepted' and listed.reviewed_at is null and listed.review_actions is null
   from wp_listed listed where listed.route_id = current_setting('hid.test.lroute_1')::uuid)
  and (select listed.recorded_by = jsonb_build_array(jsonb_build_object('accountId',
         'e4c10000-0000-4000-8000-000000000033', 'name', 'Ola Second Pharmacist'))
         and listed.facility_reports_last_30_days = 3 and listed.same_member is false
       from wp_listed listed where listed.route_id = current_setting('hid.test.rroute_1')::uuid),
  (select row_to_json(listed)::text from wp_listed listed where listed.route_id = current_setting('hid.test.lroute_1')::uuid));
select pg_temp.assert('0090''s columns of in-window reports: not late, no late facts, no late reports by the '
    || 'reporter, the sender still active, nothing the review requires',
  (select bool_and(not listed.late and listed.ended_kind_before is null and listed.discovered_by is null
     and listed.discovered_on is null and listed.reporter_late_reports_last_30_days = 0 and listed.ordering_sender_active
     and listed.required_actions = array[]::text[])
     from wp_listed listed));
select pg_temp.assert('no patient and no order content in the list', not exists (select 1 from wp_listed listed
  where row_to_json(listed)::text ~* '(Patience|Okafor|P4CPATP|Haemoglobin|Amoxicillin|1990-04-12)'));
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
create temp table wp_recent on commit drop as
  select listed.ordinality as position, listed.route_id, listed.reported_at, listed.receiving_facility_id
    from identity.admin_list_wrong_patient_reports('recent', null) with ordinality listed;
select pg_temp.assert('the facility filter',
  (select count(*) from identity.admin_list_wrong_patient_reports('unreviewed', current_setting('hid.test.facility_1')::uuid))
    = 7
  and (select count(*) from identity.admin_list_wrong_patient_reports('recent', current_setting('hid.test.facility_2')::uuid))
    = 3);
reset role;
select pg_temp.assert('the recent tab: every report, newest first',
  (select array_agg(recent.route_id order by recent.position) from wp_recent recent)
  = (select array_agg(report.route_id order by report.reported_at desc) from ehr.order_route_wrong_patient_reports report));
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.check('an empty set of actions', format($s$select * from identity.admin_review_wrong_patient_report(%L, 1,
  array[]::text[], 'Phoned the laboratory', false)$s$, pg_temp.answer('r1') ->> 'report_id'), '22023 WRONG_PATIENT_REVIEW_INVALID');
select pg_temp.check('a duplicate action', format($s$select * from identity.admin_review_wrong_patient_report(%L, 1,
  array['facility_contacted', 'facility_contacted'], 'Phoned the laboratory', false)$s$, pg_temp.answer('r1') ->> 'report_id'),
  '22023 WRONG_PATIENT_REVIEW_INVALID');
select pg_temp.check('no further action with another', format($s$select * from identity.admin_review_wrong_patient_report(%L,
  1, array['no_further_action', 'facility_contacted'], 'Phoned the laboratory', false)$s$,
  pg_temp.answer('r1') ->> 'report_id'), '22023 WRONG_PATIENT_REVIEW_INVALID');
select pg_temp.check('an unknown action', format($s$select * from identity.admin_review_wrong_patient_report(%L, 1,
  array['called_the_police'], 'Phoned the laboratory', false)$s$, pg_temp.answer('r1') ->> 'report_id'),
  '22023 WRONG_PATIENT_REVIEW_INVALID');
select pg_temp.check('a short note', format($s$select * from identity.admin_review_wrong_patient_report(%L, 1,
  array['facility_contacted'], 'Phoned', false)$s$, pg_temp.answer('r1') ->> 'report_id'), '22023 WRONG_PATIENT_REVIEW_INVALID');
select pg_temp.check('an unknown report', $s$select * from identity.admin_review_wrong_patient_report(gen_random_uuid(), 1,
  array['facility_contacted'], 'Phoned the laboratory', false)$s$, 'P0002 WRONG_PATIENT_REPORT_NOT_FOUND');
select pg_temp.check('a stale version', format($s$select * from identity.admin_review_wrong_patient_report(%L, 7,
  array['facility_contacted'], 'Phoned the laboratory', false)$s$, pg_temp.answer('r1') ->> 'report_id'),
  '40001 Wrong-patient report version conflict');
select pg_temp.check('FR reviews route 1''s report, removing the note', format($s$select * from
  identity.admin_review_wrong_patient_report(%L, 1, array['ordering_facility_told', 'referred_to_dpo'],
  '  Phoned the hospital and referred to the DPO  ', true)$s$, pg_temp.answer('r1') ->> 'report_id'), 'ok');
select pg_temp.check('a second review', format($s$select * from identity.admin_review_wrong_patient_report(%L, 2,
  array['no_further_action'], 'Nothing more to do here', false)$s$, pg_temp.answer('r1') ->> 'report_id'),
  '23505 WRONG_PATIENT_REPORT_ALREADY_REVIEWED');
select pg_temp.check('FR reviews route 2''s report, keeping the note', format($s$select * from
  identity.admin_review_wrong_patient_report(%L, 1, array['no_further_action'], 'Checked with the laboratory', null)$s$,
  pg_temp.answer('r2') ->> 'report_id'), 'ok');
reset role;
select pg_temp.assert('route 1''s report reviewed: the note replaced once, version 2',
  (select report.reviewed_at is not null and report.reviewed_by_account_id = 'e4c10000-0000-4000-8000-000000000003'
     and report.review_actions = array['ordering_facility_told', 'referred_to_dpo']
     and report.review_note = 'Phoned the hospital and referred to the DPO' and report.note_removed
     and report.note = 'Removed by Health ID support at review.' and report.row_version = 2
   from ehr.order_route_wrong_patient_reports report where report.route_id = current_setting('hid.test.lroute_1')::uuid)
  and (select not report.note_removed and report.note = 'The person gave a Health ID that was not theirs'
         and report.review_actions = array['no_further_action'] and report.row_version = 2
       from ehr.order_route_wrong_patient_reports report where report.route_id = current_setting('hid.test.lroute_2')::uuid));
select pg_temp.assert('the platform audit row of the review', exists (select 1 from audit.events event
  where event.action = 'admin.wrong-patient-report.review' and event.actor_type = 'platform'
    and event.actor_account_id = 'e4c10000-0000-4000-8000-000000000003' and event.patient_id is null
    and event.facility_id is null and event.reason = 'Phoned the hospital and referred to the DPO'
    and event.resource_type = 'order-route-wrong-patient-report' and event.resource_id = pg_temp.answer('r1') ->> 'report_id'
    and event.details = jsonb_build_object('reportId', (pg_temp.answer('r1') ->> 'report_id')::uuid,
      'routeId', current_setting('hid.test.lroute_1')::uuid, 'actions', jsonb_build_array('ordering_facility_told',
      'referred_to_dpo'), 'noteRemoved', true, 'version', 2)));
select pg_temp.check('the guard refuses a second review even to the superuser', format($s$update
  ehr.order_route_wrong_patient_reports set review_note = 'Changed my mind later', row_version = row_version + 1
  where route_id = %L$s$, current_setting('hid.test.lroute_1')), '55000 ORDER_ROUTE_WRONG_PATIENT_REPORT_IMMUTABLE');
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select pg_temp.assert('the reviewed reports leave the unreviewed list and show their review in the recent one',
  not exists (select 1 from identity.admin_list_wrong_patient_reports('unreviewed', null) listed
               where listed.route_id in (current_setting('hid.test.lroute_1')::uuid, current_setting('hid.test.lroute_2')::uuid))
  and (select listed.reviewed_by_name = 'P4c Reviewer' and listed.note = 'Removed by Health ID support at review.'
         and listed.note_removed and listed.row_version = 2
       from identity.admin_list_wrong_patient_reports('recent', null) listed
      where listed.route_id = current_setting('hid.test.lroute_1')::uuid));
reset role;

-- 1 (CHECKs). wrong_patient only on cancelled and completed routes.
select pg_temp.check('wrong_patient on a withdrawn route', format($s$do $d$ begin set local session_replication_role = replica;
  update ehr.order_routes set ended_kind = 'wrong_patient' where id = %L; end $d$$s$, current_setting('hid.test.lroute_8')),
  '23514 new row for relation "order_routes" violates check constraint "order_routes_end_ck"');
select pg_temp.check('wrong_patient on an expired route', format($s$do $d$ begin set local session_replication_role = replica;
  update ehr.order_routes set state = 'expired', ended_kind = 'wrong_patient' where id = %L; end $d$$s$,
  current_setting('hid.test.lroute_8')), '23514 new row for relation "order_routes" violates check constraint "order_routes_end_ck"');
select pg_temp.check('wrong_patient on a declined route', format($s$do $d$ begin set local session_replication_role = replica;
  update ehr.order_routes set ended_at = clock_timestamp(), ended_kind = 'wrong_patient' where id = %L; end $d$$s$,
  current_setting('hid.test.lroute_7')), '23514 new row for relation "order_routes" violates check constraint "order_routes_end_ck"');
select pg_temp.check('an unknown ended kind (the CHECKs run in name order, the end CHECK first)',
  format($s$do $d$ begin set local session_replication_role = replica;
  update ehr.order_routes set ended_kind = 'receiving_unable' where id = %L; end $d$$s$, current_setting('hid.test.lroute_1')),
  '23514 new row for relation "order_routes" violates check constraint "order_routes_end_ck"');

select pg_temp.report();
rollback;
